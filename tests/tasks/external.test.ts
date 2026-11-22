// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/task-builder-v2.md sections 5.2, 5.4, and 11.4 (TB-2, AC-TB5 to AC-TB7): the approval writes one checklist row per step
// outside Claude, a build run that names an open task in outside moves it to the checklist with the [-] mark, the part reaches
// self_reviewed, and a merged task ends only when every row is done or waived. The fake CLI writes the files, and a bun script stands in
// for the approved test command. No test starts the real CLI or reaches a real forge.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { git } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createSyncEngine } from "../../src/server/sync/engine";
import { syncParts } from "../../src/server/tasks/gates";
import { moveTask, tickDiff } from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import type { TaskDto } from "../../src/shared/dto";
import { specResult } from "../../src/shared/task";
import { rowStatus } from "../../src/shared/task-status";
import { FAKE_TOKEN, FAKE_USER, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoImplement, echoSpec } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["tasks/external", "tasks/tasks", "tasks/loop", "tasks/plan"])
  console.log(`external.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 180_000;
const KEY = "ABC-1";
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };

const CHECK = `import { existsSync, readFileSync } from "node:fs";
const ok = !existsSync("tests/feature.test.ts") || (existsSync("src/feature.ts") && readFileSync("src/feature.ts", "utf8").includes("works"));
console.log(ok ? "1 pass" : "FAIL: src/feature.ts does not work yet");
process.exit(ok ? 0 : 1);
`;

const SIGN = "Add the signing key to the CI job";
const SPEC = specResult.parse({
  ...echoSpec(),
  title: "Add the feature",
  map: [{ path: "src/app.ts", line: 1, symbol: "", kind: "change", what: "The app." }],
  parts: [
    {
      n: 1,
      kind: "part",
      title: "Feature",
      goal: "The feature works.",
      lines: 20,
      acceptance: [{ id: "A1", text: "The feature works." }],
      tests: [{ test: "tests/feature.test.ts", proves: ["A1"] }],
      tasks: [
        {
          id: "T1",
          title: "Write the feature",
          files: ["src/feature.ts"],
          run: ["tests/feature.test.ts"],
          done: "The test passes.",
          proof: { command: "", test: "tests/feature.test.ts" },
        },
        {
          id: "T2",
          title: SIGN,
          files: [],
          run: ["tests/feature.test.ts"],
          done: "The CI job signs.",
          proof: { command: "test", test: "" },
        },
      ],
    },
  ],
  external: [
    { id: "E1", kind: "merge", title: "Merge the PR", after: 1, host: "", why: "A person merges PRs." },
    { id: "E2", kind: "jira_move", title: "Move ABC-1 to review", after: null, host: "", why: "" },
  ],
});

const TEST_FILE = { path: "repo/tests/feature.test.ts", text: "test('feature works', () => {});\n" };
const TODO = { path: "repo/src/feature.ts", text: "export const feature = 'todo';\n" };
const WORKS = { path: "repo/src/feature.ts", text: "export const feature = 'works';\n" };
const CLEAN = {
  summary: "The feature is small.",
  risks: [],
  questions: [],
  coverage: { read: ["src/feature.ts"], skipped: [], unavailable: [], notChecked: [] },
  findings: [],
};
const outside = (blocking: boolean) => [{ task: "T1.2", kind: "secret", why: "The signing key is the user's.", blocking }];

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const until = async (f: () => Promise<boolean>, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(50);
  }
};

// A small plan in spec_draft. build: the files and the result of the build run.
async function setup(build: { writes: { path: string; text: string }[]; blocking: boolean }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-tb2-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  runner.write({
    fixture: claudeStream(root, "external", "claude-synthetic/review-flat.jsonl"),
    seq: {
      "implement:build": [
        {
          writes: build.writes,
          ticks: { path: "*", ids: ["T1.1"] },
          implement: { ...echoImplement(), done: false, outside: outside(build.blocking) },
        },
      ],
      "implement:fix": [{ writes: [WORKS] }],
      review: [{ review: CLEAN }],
    },
  });
  const fake = startFakeBitbucket();
  // The pre-flight reads the repository from the fake server.
  repoWrites(fake, "PROJ", "repo");
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false, taskPlanCheck: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir: dataDir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const review = createReviewJobs({
    settings,
    live,
    dataDir,
    runnerCommand: runner.command,
    repoRemote: async () => ({ url: r.remote, config: [] }),
    listTools: stubListTools,
  });
  const db = review.open() as Database;
  const sync = createSyncEngine({ settings, live });
  sync.syncNow = async () => {};
  const app = createApp({ port: PORT, token: SESSION, live, settings, review, sync });
  cleanup.unshift(async () => {
    await review.stop();
    fake.stop();
    db.close();
  });
  const { base } = await taskCache(dataDir, r.remote);
  const clone = join(root, "clone");
  await git(["init", "-q", clone], { env: r.env });
  await git(["-C", clone, "config", "user.name", "Ada Example"], { env: r.env });
  await git(["-C", clone, "config", "user.email", "ada@example.invalid"], { env: r.env });
  db.query("INSERT INTO repo_clone (project, repo, path, updated_at) VALUES ('PROJ', 'repo', $path, 0)").run({ path: clone });
  writeFileSync(join(root, "check.ts"), CHECK);
  const commands = [{ id: "t", name: "test", kind: "test", argv: [process.execPath, join(root, "check.ts")], timeoutSec: 60 }];
  db.query(
    `INSERT INTO repo_task_settings (project, repo, commands_json, line_budget, warned_at, updated_at)
    VALUES ('PROJ', 'repo', $commands, 400, 1, 1)`,
  ).run({ commands: JSON.stringify(commands) });
  const plan = toPlan(SPEC, base, [false], []);
  const docs = { ...renderDocs(KEY, "Add the feature", "small", plan), version: 1, parsed: plan, approved: false };
  const now = Date.now();
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
          created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, 'Add the feature', 'spec_draft', 'small', 'claude', 'main', $base, $dir, $docs, $estimate, $now,
          $now) RETURNING id`,
      )
      .get({ key: KEY, base, dir: `specs/${KEY}/`, docs: JSON.stringify(docs), estimate: JSON.stringify(plan.estimate), now }) as {
      id: number;
    }
  ).id;
  const json = async <T>(path: string, body?: unknown) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const get = async () => (await json<TaskDto>(`/api/tasks/${task}`)).body;
  const approve = async () => json<TaskDto>(`/api/tasks/${task}/plan`, { version: (await get()).version, size: "small", commands: ["t"] });
  const settle = async () => {
    await until(async () => {
      const t = await get();
      return !t.working && !t.steps.some((s) => s.state === "running" || s.state === "waiting");
    });
    return get();
  };
  const act = async (item: number, action: "done" | "waive" | "reopen", version?: number) =>
    json<TaskDto & { error?: string }>(`/api/tasks/${task}/external/${item}`, { version: version ?? (await get()).version, action });
  const show = async (branch: string, path: string) => git(["--git-dir", r.remote, "show", `refs/heads/${branch}:${path}`], { env: r.env });
  return { db, task, json, get, approve, settle, act, show };
}

const rowsOf = (t: TaskDto) => t.external.map((x) => [x.kind, x.owner, x.part, x.planTask, x.state]);

describe("tickDiff and the [-] mark (task-builder-v2.md section 5.4)", () => {
  const head = "# Tasks: K\n\n### [ ] T1.1 One\nFiles: a\n\n### [ ] T1.2 Two\nFiles: none\n";
  test("only a task that the app moved may carry [-]; a tick still counts", () => {
    const disk = head.replace("### [ ] T1.1", "### [x] T1.1").replace("### [ ] T1.2", "### [-] T1.2");
    expect(tickDiff(head, disk)).toBeNull();
    expect(tickDiff(head, disk, new Set(["T1.2"]))).toEqual(["T1.1"]);
    // A heading with regex characters is an other change, not a crash.
    expect(tickDiff(head, `${head}### [x] T1.(2 Bad\n`)).toBeNull();
    expect(moveTask(head, "T1.(2")).toBeNull();
    expect(moveTask(head, "T1.2")).toBe(head.replace("### [ ] T1.2", "### [-] T1.2"));
    expect(tickDiff(head, head, new Set(["T1.2"]))).toEqual([]);
    expect(tickDiff(head, head.replace("### [ ] T1.1", "### [-] T1.1"), new Set(["T1.2"]))).toBeNull();
  });
});

describe("the checklist of steps outside Claude (task-builder-v2.md sections 5.2, 5.4, and 11.4)", () => {
  test(
    "AC-TB5, AC-TB6, AC-TB7: approval rows, an outside task moves through red checks and a fix run, the part reaches self_reviewed, and the task ends after the checklist",
    async () => {
      const s = await setup({ writes: [TEST_FILE, TODO], blocking: false });
      const ok = await s.approve();
      expect([ok.status, ok.body.state]).toEqual([200, "implementing"]);
      // AC-TB5: one row per external entry, with the owner from the kind.
      expect(rowsOf(ok.body)).toEqual([
        ["merge", "user", 1, null, "open"],
        ["jira_move", "app", null, null, "open"],
      ]);

      const built = await s.settle();
      // AC-TB6: the part passed the gate with T1.2 outside, through red checks and one fix run, and no plan change stopped it.
      expect(built.blocked).toBeNull();
      expect(built.parts.map((p) => p.state)).toEqual(["self_reviewed"]);
      expect(built.steps.some((x) => x.kind === "spec_change")).toBe(false);
      expect(built.steps.filter((x) => x.kind === "check" || x.kind === "fix").map((x) => [x.kind, x.state])).toEqual([
        ["check", "ok"],
        ["fix", "ok"],
        ["check", "failed"],
        ["check", "ok"],
      ]);
      expect(rowsOf(built)).toEqual([
        ["merge", "user", 1, null, "open"],
        ["jira_move", "app", null, null, "open"],
        ["secret", "user", 1, "T1.2", "open"],
      ]);
      expect(built.external[2]?.title).toBe(SIGN);
      expect(built.external[2]?.why).toBe("The signing key is the user's.");

      const part = built.parts[0] as TaskDto["parts"][number];
      const pr = await s.json<TaskDto>(`/api/tasks/${s.task}/parts/${part.id}/pr`, { version: built.version, reviewers: [] });
      expect([pr.status, pr.body.state]).toEqual([200, "ready"]);
      const plan = await s.show(part.branch, `specs/${KEY}/plan.md`);
      expect(plan).toContain("### [x] T1.1 ");
      expect(plan).toContain("### [-] T1.2 ");
      expect(plan).toContain(
        "## Outside Claude\n\n- E1 [you] Merge the PR (merge, after part 1)\nWhy: A person merges PRs.\n- E2 [app] Move ABC-1 to review (jira_move)",
      );

      // AC-TB7: the PR merges, and the task waits for its checklist.
      const prId = (s.db.query("SELECT pr FROM task_part WHERE id = $id").get({ id: part.id }) as { pr: number }).pr;
      s.db.query("UPDATE pull_request SET state = 'MERGED' WHERE id = $id").run({ id: prId });
      syncParts(s.db, [prId]);
      const merged = await s.get();
      expect([merged.state, merged.parts[0]?.state]).toEqual(["ready", "merged"]);
      expect(rowStatus(merged)).toEqual({ text: "Needs you: finish your checklist", needsYou: true });

      const [merge, move, sign] = merged.external.map((x) => x.id) as [number, number, number];
      expect((await s.act(merge, "done", merged.version - 1)).status).toBe(409);
      expect((await s.act(9999, "done")).status).toBe(404);
      expect((await s.act(merge, "reopen")).status).toBe(409);
      const a = await s.act(merge, "done");
      expect([a.status, a.body.state, a.body.external[0]?.state, a.body.external[0]?.by]).toEqual([200, "ready", "done", "user"]);
      // The user ticks a step of the app too (TB-2 has no link from a row to its app action).
      const b = await s.act(move, "waive");
      expect([b.status, b.body.state, b.body.external[1]?.state]).toEqual([200, "ready", "waived"]);
      const c = await s.act(sign, "done");
      expect([c.status, c.body.state, c.body.progress.checklist]).toEqual([200, "done", 0]);
      expect((await s.act(sign, "reopen")).status).toBe(409);
    },
    SLOW,
  );

  test(
    "a blocking outside entry moves the task and waits for Continue; then the part reaches self_reviewed",
    async () => {
      const s = await setup({ writes: [TEST_FILE, WORKS], blocking: true });
      expect((await s.approve()).status).toBe(200);
      const waiting = await s.settle();
      expect(waiting.blocked?.kind).toBe("unfinished");
      expect(waiting.blocked?.text).toBe(
        "Needs you: Claude cannot do T1.2 in its sandbox. The app moved it to your checklist. Do it, then click Continue.",
      );
      expect(rowsOf(waiting).at(-1)).toEqual(["secret", "user", 1, "T1.2", "open"]);
      const go = await s.json<TaskDto>(`/api/tasks/${s.task}/resume`, { version: waiting.version });
      expect(go.status).toBe(200);
      const built = await s.settle();
      expect([built.blocked, built.parts.map((p) => p.state)]).toEqual([null, ["self_reviewed"]]);
      // The row of the moved task stays one row.
      expect(built.external.filter((x) => x.planTask === "T1.2")).toHaveLength(1);
    },
    SLOW,
  );
});
