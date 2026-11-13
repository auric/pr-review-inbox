// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.1, 6.7, 6.9, 6.11, and 6.12 (WP-B5): the routes that the Task view adds. "Open the PR" pushes
// the part branch to a temp bare remote and creates one PR at the fake Bitbucket, only on its click. Close, "Keep one PR", "Change the
// limit", "Fix the small points too", the part diff, and the log of a task run. The fake CLI writes the files; a bun script stands in for
// the approved test command. No test starts the real CLI, reaches a forge, or touches the user's clone or data folder.
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
import type { ApiError, RunDetail, TaskConflict, TaskDiffDto, TaskDto } from "../../src/shared/dto";
import { specResult } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, key, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, type FakeScenario } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["tasks/routes", "tasks/pr", "tasks/loop", "tasks/tasks", "review/jobs"])
  console.log(`ui-routes.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 180_000;
// push.ts takes a Jira key with at least two letters before the dash.
const KEY = "ABC-1";
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };

// The approved test command: src/feature.ts must hold "works" once the test file exists. The part base has no test file, so its checks
// pass (spec.md section 6.7, Baseline).
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
const POINTS_FIXED = { path: "repo/src/feature.ts", text: "export const feature = 'works';\n// Named.\n" };
const reviewOf = (findings: unknown[]) => ({
  summary: "The feature is small.",
  risks: [],
  questions: [],
  coverage: { read: ["src/feature.ts"], skipped: [], unavailable: [], notChecked: [] },
  findings,
});
const MINOR = {
  path: "src/feature.ts",
  side: "new",
  line: 1,
  lineEnd: null,
  anchorText: "export const feature = 'works';",
  severity: "minor",
  category: "Maintainability",
  body: "Name the value after what it holds.",
  evidence: "`feature` holds a fixed string.",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  trigger: "A reader of `feature` cannot tell what it holds.",
};

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const until = async (f: () => boolean | Promise<boolean>, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(50);
  }
};

async function setup(o: { seq?: FakeScenario["seq"]; budget?: number } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-wpb5-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  const stream = claudeStream(root, "ui", "claude-synthetic/review-flat.jsonl");
  runner.write({
    fixture: stream,
    seq: {
      "implement:tests": [{ writes: [TEST_FILE] }],
      "implement:implement": [{ writes: [TODO] }],
      "implement:fix": [{ writes: [WORKS] }],
      review: [{ review: reviewOf([]) }],
      ...o.seq,
    },
  });
  const fake = startFakeBitbucket();
  const writes = repoWrites(fake, "PROJ", "repo");
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
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
  // The sync after "Open the PR" only counts here. tests/sync covers the sync itself.
  const sync = createSyncEngine({ settings, live });
  let syncs = 0;
  sync.syncNow = async () => {
    syncs++;
  };
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
    VALUES ('PROJ', 'repo', $commands, $budget, 1, 1)`,
  ).run({ commands: JSON.stringify(commands), budget: o.budget ?? 400 });
  // My newest PR in the repository names the default reviewers of the open-PR confirm.
  db.query(
    `INSERT INTO pull_request (project, repo, pr_id, title, author_slug, author_name, my_role, state, updated_date, on_dashboard, followed,
      reviewers_json) VALUES ('PROJ', 'repo', 9, 'Older', $me, 'Me', 'AUTHOR', 'OPEN', 1, 1, 1, $reviewers)`,
  ).run({ me: FAKE_USER, reviewers: JSON.stringify([{ slug: "asmith", name: "Anna Smith", login: "asmith", status: "UNAPPROVED" }]) });
  // A stopped task of an approved small plan. Resume starts its build through the routes, as after a restart.
  const plan = toPlan(SPEC, base, [false], []);
  const docs = { ...renderDocs(KEY, "Add the feature", "small", plan), version: 1, parsed: plan, approved: true };
  const now = Date.now();
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, stopped_from, size, size_by, target_branch, base_commit, spec_dir, docs_json,
          estimate_json, created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, 'Add the feature', 'stopped', 'implementing', 'small', 'claude', 'main', $base, $dir, $docs, $estimate,
          $now, $now) RETURNING id`,
      )
      .get({ key: KEY, base, dir: `specs/${KEY}/`, docs: JSON.stringify(docs), estimate: JSON.stringify(plan.estimate), now }) as {
      id: number;
    }
  ).id;
  const json = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const get = async () => (await json<TaskDto>(`/api/tasks/${task}`)).body;
  const post = async <T = TaskDto>(path: string, body: Record<string, unknown> = {}) =>
    json<T>(`/api/tasks/${task}${path}`, { body: { version: (await get()).version, ...body } });
  // Waits until the build loop rests: no driver and no running step.
  const settle = async () => {
    await until(async () => {
      const t = await get();
      return !t.working && !t.steps.some((s) => s.state === "running" || s.state === "waiting");
    });
    return get();
  };
  const flow = (t: TaskDto) => [...t.steps].reverse().map((s) => `${s.kind}:${s.item ?? "-"}:${s.state}`);
  const remoteHead = (branch: string) =>
    git(["--git-dir", r.remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { env: r.env }).then(
      (x) => x.trim(),
      () => null,
    );
  const build = async () => {
    expect((await post("/resume")).status).toBe(200);
    return settle();
  };
  return { db, task, json, get, post, settle, flow, build, writes, remoteHead, syncs: () => syncs, fake };
}

describe("Open the PR (spec.md sections 6.8, 6.9, and 6.12)", () => {
  test(
    "AC-B5: nothing pushes before the click; the click pushes the part branch once and creates one PR; a second click gets the same PR",
    async () => {
      const s = await setup();
      const ready = await s.build();
      const part = ready.parts[0] as TaskDto["parts"][number];
      expect([ready.state, part.state, ready.blocked]).toEqual(["implementing", "self_reviewed", null]);
      expect(ready.reviewers).toEqual(["asmith"]);
      // Nothing reached the remote or the server before the click.
      expect(await s.remoteHead(part.branch)).toBeNull();
      expect(s.writes.writes).toEqual([]);

      const r = await s.post(`/parts/${part.id}/pr`, { reviewers: ["asmith", FAKE_USER] });
      expect(r.status).toBe(200);
      expect(r.body.state).toBe("ready");
      const after = r.body.parts[0] as TaskDto["parts"][number];
      expect(after).toMatchObject({ state: "pr_open", remotePr: 101, pushed: part.head });
      expect(await s.remoteHead(part.branch)).toBe(part.head as string);
      expect(await s.remoteHead("main")).not.toBe(part.head as string);
      expect(s.writes.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["POST /rest/api/1.0/projects/PROJ/repos/repo/pull-requests"]);
      const body = s.writes.writes[0]?.body;
      expect(body).toMatchObject({
        title: `${KEY}: Add the feature`,
        fromRef: { id: `refs/heads/${part.branch}` },
        toRef: { id: "refs/heads/main" },
        reviewers: [{ user: { name: "asmith" } }, { user: { name: FAKE_USER } }],
      });
      expect(body?.description).toStartWith("🤖 The feature works.");
      expect(body?.description).toContain("- A1.1 The feature works.");
      expect(body?.description).toContain(`The plan: specs/${KEY}/plan.md`);
      // The task follows its PR, so the sync reads it; the dropped reviewer is in the step notes.
      const row = s.db.query("SELECT id, followed FROM pull_request WHERE pr_id = 101").get() as { id: number; followed: number };
      expect([after.pr, row.followed]).toEqual([row.id, 1]);
      expect(s.syncs()).toBe(1);
      const prStep = r.body.steps.find((x) => x.kind === "pr");
      expect(prStep?.detail.notes).toEqual(["Opened PR #101 into main.", `Bitbucket did not add these reviewers: ${FAKE_USER}.`]);
      expect(s.flow(r.body).slice(-2)).toEqual([`push:${part.branch}:ok`, `pr:${part.branch}:ok`]);

      // spec.md section 6.14: a second click gets the same part with its PR. No second push, no second create.
      const again = await s.json<TaskDto>(`/api/tasks/${s.task}/parts/${part.id}/pr`, { body: { version: 0, reviewers: [] } });
      expect([again.status, again.body.parts[0]?.remotePr]).toEqual([200, 101]);
      expect(s.writes.writes).toHaveLength(1);
      expect(again.body.steps.filter((x) => x.kind === "push")).toHaveLength(1);

      // Close ends a ready task. The branch and the PR stay.
      const closed = await s.post("/close");
      expect([closed.status, closed.body.state, typeof closed.body.closedAt]).toEqual([200, "done", "number"]);
      expect(await s.remoteHead(part.branch)).toBe(part.head as string);
    },
    SLOW,
  );

  test(
    "a create that Bitbucket refuses ends its step with one sentence; the retry pushes with the lease and creates the PR",
    async () => {
      const s = await setup();
      const ready = await s.build();
      const part = ready.parts[0] as TaskDto["parts"][number];
      const create = key("POST", "/rest/api/1.0/projects/PROJ/repos/repo/pull-requests");
      const real = s.fake.routes[create];
      s.fake.routes[create] = { status: 403, body: { errors: [{ message: "Forbidden" }] } };
      const r = await s.post<ApiError>(`/parts/${part.id}/pr`, { reviewers: [] });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe(
        "The token cannot create pull requests in PROJ/repo. Give it Repository write in Bitbucket, then try again.",
      );
      const t = await s.get();
      expect([t.state, t.parts[0]?.state, t.parts[0]?.pushed]).toEqual(["implementing", "self_reviewed", part.head]);
      expect(t.steps.some((x) => x.state === "running")).toBe(false);
      s.fake.routes[create] = real as NonNullable<typeof real>;
      const retry = await s.post(`/parts/${part.id}/pr`, { reviewers: [] });
      expect([retry.status, retry.body.state]).toEqual([200, "ready"]);
    },
    SLOW,
  );

  test("a version that the page did not see gets 409 with the current task", async () => {
    const s = await setup();
    const r = await s.json<TaskConflict>(`/api/tasks/${s.task}/close`, { body: { version: 999 } });
    expect([r.status, r.body.task.id]).toEqual([409, s.task]);
  });
});

describe("close (spec.md section 6.12)", () => {
  test("a stopped task closes; a building task needs Stop first", async () => {
    const s = await setup();
    const closed = await s.post("/close");
    expect([closed.status, closed.body.state, closed.body.closedAt !== null]).toEqual([200, "done", true]);
    expect((await s.post("/close")).status).toBe(200);
  });

  test(
    "a building task refuses Close with the reason",
    async () => {
      const s = await setup({ budget: 5 });
      await s.build();
      const r = await s.post<TaskConflict>("/close");
      expect([r.status, r.body.error]).toEqual([409, "Stop the build first, then close the task."]);
    },
    SLOW,
  );
});

describe("the line limit (spec.md section 6.1)", () => {
  test(
    "Keep one PR: the build goes on past the limit and the part gets ready",
    async () => {
      const s = await setup({ budget: 5 });
      const blocked = await s.build();
      expect(blocked.blocked?.kind).toBe("size");
      expect(blocked.blocked?.text).toMatch(/^Needs you: this PR would have \d+ changed lines, over your 5 limit\.$/);
      const r = await s.post("/limit", { keep: true });
      expect(r.status).toBe(200);
      expect(r.body.settings.keepOnePr).toBe(true);
      const done = await s.settle();
      expect([done.blocked, done.parts[0]?.state]).toEqual([null, "self_reviewed"]);
    },
    SLOW,
  );

  test(
    "Change the limit: a new limit under the changed lines stops again; a higher one lets the build go on",
    async () => {
      const s = await setup({ budget: 5 });
      await s.build();
      expect((await s.post("/limit", { lineBudget: 6 })).body.settings.lineBudget).toBe(6);
      const again = await s.settle();
      expect(again.blocked?.text).toMatch(/over your 6 limit\.$/);
      await s.post("/limit", { lineBudget: 100_000 });
      const done = await s.settle();
      expect([done.blocked, done.parts[0]?.state]).toEqual([null, "self_reviewed"]);
      // A limit without a size stop is refused.
      expect((await s.post<TaskConflict>("/limit", { keep: true })).body.error).toBe("No part waits for the line limit.");
    },
    SLOW,
  );
});

describe("the small points, the diff, and the run log", () => {
  test(
    "Fix the small points too: one fix step with the listed points, the checks, and one commit; the part stays ready",
    async () => {
      const s = await setup({
        seq: {
          "implement:fix": [{ writes: [WORKS] }, { writes: [POINTS_FIXED] }],
          review: [{ review: reviewOf([MINOR]) }],
        },
      });
      const ready = await s.build();
      const part = ready.parts[0] as TaskDto["parts"][number];
      expect(ready.points.map((p) => [p.severity, p.path, p.line, p.text])).toEqual([
        ["minor", "src/feature.ts", 1, "Name the value after what it holds."],
      ]);
      const r = await s.post(`/parts/${part.id}/fix`);
      expect(r.status).toBe(202);
      const done = await s.settle();
      expect(s.flow(done).filter((x) => x.includes(":points:"))).toEqual(["fix:points:ok", "check:points:ok", "commit:points:ok"]);
      expect([done.parts[0]?.state, done.points, done.blocked]).toEqual(["self_reviewed", [], null]);
      expect(done.parts[0]?.head).not.toBe(part.head);
      // The part diff of the Diff tab shows the fix.
      const diff = await s.json<TaskDiffDto>(`/api/tasks/${s.task}/parts/${part.id}/diff`);
      expect(diff.status).toBe(200);
      const file = diff.body.files.find((f) => f.path === "src/feature.ts");
      expect(file?.rows.map((x) => x.text)).toContain("// Named.");
      expect(diff.body.files.map((f) => f.path)).toContain(`specs/${KEY}/plan.md`);
      // A second fix of the same points is refused: no point waits.
      expect((await s.post<TaskConflict>(`/parts/${part.id}/fix`)).body.error).toBe("No point waits for a fix.");
      // The run log of the own review: the task route serves it, the PR route does not.
      const run = done.steps.find((x) => x.kind === "review")?.run as number;
      const log = await s.json<RunDetail>(`/api/tasks/${s.task}/runs/${run}`);
      expect(log.status).toBe(200);
      expect(log.body.run).toMatchObject({ kind: "review", pr: null });
      expect((await s.json<ApiError>(`/api/runs/${run}`)).status).toBe(404);
      expect((await s.json<ApiError>(`/api/tasks/${s.task + 1}/runs/${run}`)).status).toBe(404);
    },
    SLOW,
  );
});
