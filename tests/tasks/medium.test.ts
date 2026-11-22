// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/self-approved-plans.md section 6 (SA-1, AC-SA2, AC-SA3): a medium plan has no spec PR. Its approval goes to
// implementing, and it builds one part on one branch, as a small plan does. The part commits design.md, spec.md, and tasks.md, and its
// PR text names tasks.md. An approved medium plan that waits in spec_draft builds after a second approval. The fake CLI writes the files;
// a bun script stands in for the approved test command. No test starts the real CLI or reaches a real forge.
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
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import type { BranchCheckDto, TaskDto } from "../../src/shared/dto";
import { specResult } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["tasks/machine", "tasks/tasks", "tasks/loop", "tasks/pr"])
  console.log(`medium.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 180_000;
// push.ts takes a Jira key with at least two letters before the dash.
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
        { id: "T1", title: "Write the feature", files: ["src/feature.ts"], run: ["tests/feature.test.ts"], done: "The test passes." },
      ],
    },
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

// A medium plan in spec_draft. approved: the plan of an earlier version that waits for a spec PR.
async function setup(approved: boolean) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-sa1-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  runner.write({
    fixture: claudeStream(root, "medium", "claude-synthetic/review-flat.jsonl"),
    seq: {
      "implement:build": [{ writes: [TEST_FILE, TODO], ticks: { path: "*", ids: ["*"] } }],
      "implement:fix": [{ writes: [WORKS] }],
      review: [{ review: CLEAN }],
    },
  });
  const fake = startFakeBitbucket();
  const writes = repoWrites(fake, "PROJ", "repo");
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
  const docs = { ...renderDocs(KEY, "Add the feature", "medium", plan), version: 1, parsed: plan, approved };
  const now = Date.now();
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
          created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, 'Add the feature', 'spec_draft', 'medium', 'claude', 'main', $base, $dir, $docs, $estimate, $now,
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
  const approve = async () => json<TaskDto>(`/api/tasks/${task}/plan`, { version: (await get()).version, size: "medium", commands: ["t"] });
  const settle = async () => {
    await until(async () => {
      const t = await get();
      return !t.working && !t.steps.some((s) => s.state === "running" || s.state === "waiting");
    });
    return get();
  };
  const files = async (branch: string) =>
    (await git(["--git-dir", r.remote, "ls-tree", "-r", "--name-only", `refs/heads/${branch}`], { env: r.env })).trim().split("\n");
  const show = async (branch: string, path: string) => git(["--git-dir", r.remote, "show", `refs/heads/${branch}:${path}`], { env: r.env });
  return { task, json, get, approve, settle, files, show, writes };
}

describe("a medium plan builds one PR (self-approved-plans.md section 6)", () => {
  test(
    "AC-SA2: GET /branch names the one branch; the approval builds one part that commits the three plan files; the PR text names tasks.md",
    async () => {
      const s = await setup(false);
      const branch = await s.json<BranchCheckDto>(`/api/tasks/${s.task}/branch?prefix=feature%2F`);
      expect([branch.status, branch.body.name]).toEqual([200, `feature/${KEY}-add-the-feature`]);

      const ok = await s.approve();
      expect([ok.status, ok.body.state, ok.body.plan?.approved]).toEqual([200, "implementing", true]);
      const built = await s.settle();
      expect(built.parts.map((p) => [p.branch, p.state])).toEqual([[`feature/${KEY}-add-the-feature`, "self_reviewed"]]);
      const part = built.parts[0] as TaskDto["parts"][number];
      expect(s.writes.writes).toEqual([]);

      const r = await s.json<TaskDto>(`/api/tasks/${s.task}/parts/${part.id}/pr`, { version: built.version, reviewers: [] });
      expect([r.status, r.body.state]).toEqual([200, "ready"]);
      const plan = (await s.files(part.branch)).filter((f) => f.startsWith(`specs/${KEY}/`));
      expect(plan.sort()).toEqual([`specs/${KEY}/design.md`, `specs/${KEY}/spec.md`, `specs/${KEY}/tasks.md`]);
      expect(await s.show(part.branch, `specs/${KEY}/tasks.md`)).toContain("### [x] T1.1 ");
      expect(s.writes.writes).toHaveLength(1);
      expect(s.writes.writes[0]?.body?.description).toContain(`The plan: specs/${KEY}/tasks.md`);
    },
    SLOW,
  );

  test(
    "AC-SA3: an approved medium plan that waits in spec_draft builds after a second approval",
    async () => {
      const s = await setup(true);
      const before = await s.get();
      expect([before.state, before.plan?.approved]).toEqual(["spec_draft", true]);
      const ok = await s.approve();
      expect([ok.status, ok.body.state]).toEqual([200, "implementing"]);
      const built = await s.settle();
      expect(built.parts).toHaveLength(1);
    },
    SLOW,
  );
});
