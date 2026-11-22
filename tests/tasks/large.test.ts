// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/self-approved-plans.md sections 3.2 and 5 (SA-2, AC-SA5 to AC-SA12): a large plan that the user approves alone
// builds as stacked part PRs on the part engine. Part 1 starts from the target, part k builds on part k-1 and targets its branch, and each
// part commits only the plan.md of its slice. Temp bare remotes, the fake Bitbucket, and the fake CLI. No test starts the real CLI or
// reaches a forge or Jira. Each push and PR write runs only on a route call, which stands for the user's click.
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
import { cachePath, gitSetup, longPath } from "../../src/server/review/workspace";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createSyncEngine } from "../../src/server/sync/engine";
import { createLoop } from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import { createPrOpener } from "../../src/server/tasks/pr";
import { stackParts } from "../../src/server/tasks/subtasks";
import { liveTaskPart } from "../../src/server/tasks/task-pr";
import { advancePart, partDocsOf, type TaskRow, taskDto, taskRow } from "../../src/server/tasks/tasks";
import { commitStep, openWorktree } from "../../src/server/tasks/worktree";
import type { ApiError, TaskDto } from "../../src/shared/dto";
import { branchName, LARGE_REPOS_TEXT, specResult, type TaskBlocked } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, forgeMerge, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";
import { cleanup as fixtureCleanup, multiTask, remoteCommit, WHO, write } from "./update-fixture";

for (const m of ["tasks/tasks", "tasks/loop", "tasks/pr", "tasks/subtasks", "tasks/task-pr", "tasks/schedule"])
  console.log(`large.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 240_000;
const KEY = "ABC-10";
const TITLE = "Speed up the cache";
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const NAMES = ["one", "two", "three"];
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const CLEAN = { summary: "Fine.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] };
const NO_TEST = "Needs you: approve a test command for this repository first. The build needs it to see red and green tests.";
// The repository max_open: neither TASK_DEFAULTS.maxOpen (2) nor MAX_OPEN_DEFAULT (3).
const REPO_MAX_OPEN = 4;
const BRANCHES = NAMES.map((name, i) => branchName("feature/", KEY, { kind: "part", n: i + 1, title: `Part ${name}` }));
const [B1, B2, B3] = BRANCHES as [string, string, string];

// The approved test command of the build: green when each tests/<name>.test.ts has a src/<name>.ts that holds "works", and no file under
// src/ holds a conflict marker.
const CHECK = `import { existsSync, readdirSync, readFileSync } from "node:fs";
const tests = existsSync("tests") ? readdirSync("tests").filter((f) => f.endsWith(".test.ts")) : [];
const bad = tests.filter((f) => {
  const src = "src/" + f.slice(0, -".test.ts".length) + ".ts";
  return !existsSync(src) || !readFileSync(src, "utf8").includes("works");
});
const marked = existsSync("src") && readdirSync("src").some((f) => readFileSync("src/" + f, "utf8").includes("<<<<<<<"));
console.log(bad.length || marked ? "FAIL " + bad.join(", ") : tests.length + " pass");
process.exit(bad.length || marked ? 1 : 0);
`;

const planPart = (n: number, name: string) => ({
  n,
  kind: "part",
  title: `Part ${name}`,
  goal: `The ${name} works.`,
  lines: 20,
  acceptance: [{ id: "A1", text: `The ${name} works.` }],
  tests: [{ test: `tests/${name}.test.ts`, proves: ["A1"] }],
  tasks: [{ id: "T1", title: `Write ${name}`, files: [`src/${name}.ts`], run: [`tests/${name}.test.ts`], done: "The test passes." }],
});
const SPEC = specResult.parse({
  ...echoSpec(),
  title: TITLE,
  map: NAMES.map((name) => ({ path: `src/${name}.ts`, line: null, symbol: "", kind: "change", what: `The ${name}.` })),
  parts: NAMES.map((name, i) => planPart(i + 1, name)),
});

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  await fixtureCleanup();
});

const until = async (f: () => Promise<boolean>, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(50);
  }
};

// The git argv of the app while a test runs. Each push of the app is one argv.
function spyGit() {
  const spawn = Bun.spawn;
  const calls: string[][] = [];
  (Bun as { spawn: unknown }).spawn = ((cmd: unknown, o: unknown) => {
    if (Array.isArray(cmd) && cmd[0] === "git") calls.push(cmd.map(String));
    return (spawn as (a: unknown, b: unknown) => unknown)(cmd, o);
  }) as unknown;
  cleanup.unshift(() => {
    (Bun as { spawn: unknown }).spawn = spawn;
  });
  return {
    calls,
    pushes: () => calls.filter((a) => a[1]?.startsWith("--git-dir=") && a[2] === "push"),
    merges: () => calls.filter((a) => a.includes("merge") && a.includes("--no-ff")),
  };
}

// AC-SA10: no push argv has a force flag or a "+" refspec, and each push after the first push of a branch leases the commit of the push
// before it.
function noForce(pushes: string[][], before: Map<string, string>) {
  const last = new Map(before);
  for (const a of pushes) {
    expect(a.filter((x) => x === "--force" || x === "-f" || x.startsWith("--force-if-includes") || x === "--mirror")).toEqual([]);
    const refspec = a.at(-1) as string;
    expect(refspec.startsWith("+")).toBe(false);
    const [commit, ref] = refspec.split(":") as [string, string];
    const branch = ref.replace(/^refs\/heads\//, "");
    expect(a).toContain(`--force-with-lease=refs/heads/${branch}:${last.get(branch) ?? ""}`);
    last.set(branch, commit);
  }
}

// ---------- The plan screen and the build through the app routes ----------

// A task ABC-10 with a large plan of three parts in spec_draft. subtasks: a task that builds its Jira sub-tasks (size small).
async function planned(o: { subtasks?: boolean; approved?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-sa2-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  const file = (path: string, text: string) => ({ path: `repo/${path}`, text });
  runner.write({
    fixture: claudeStream(root, "sa2", "claude-synthetic/review-flat.jsonl"),
    seq: {
      "implement:build": NAMES.map((n) => ({
        writes: [file(`tests/${n}.test.ts`, `test("${n}", () => {});\n`), file(`src/${n}.ts`, `export const ${n} = "todo";\n`)],
        ticks: { path: "*", ids: ["*"] },
      })),
      "implement:fix": NAMES.map((n) => ({ writes: [file(`src/${n}.ts`, `export const ${n} = "works";\n`)] })),
      review: [{ review: CLEAN }],
    },
  });
  const fake = startFakeBitbucket();
  const w = repoWrites(fake, "PROJ", "repo");
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
    claudeConfigDir: join(root, "no-claude-config"),
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
  await git(["-C", clone, "config", "user.name", WHO.name], { env: r.env });
  await git(["-C", clone, "config", "user.email", WHO.email], { env: r.env });
  db.query("INSERT INTO repo_clone (project, repo, path, updated_at) VALUES ('PROJ', 'repo', $path, 0)").run({ path: clone });
  writeFileSync(join(root, "check.ts"), CHECK);
  const commands = [{ id: "t", name: "test", kind: "test", argv: [process.execPath, join(root, "check.ts")], timeoutSec: 60 }];
  db.query(
    `INSERT INTO repo_task_settings (project, repo, commands_json, line_budget, max_open, warned_at, updated_at)
    VALUES ('PROJ', 'repo', $commands, 400, $max, 1, 1)`,
  ).run({ commands: JSON.stringify(commands), max: REPO_MAX_OPEN });
  const plan = toPlan(SPEC, base, [false, false, false], []);
  const size = o.subtasks ? "small" : "large";
  const docs = { ...renderDocs(KEY, TITLE, size, plan), version: 1, parsed: plan, approved: o.approved ?? false };
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
          subtasks, created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, $title, 'spec_draft', $size, 'claude', 'main', $base, $dir, $docs, $estimate, $subtasks, 1, 1)
        RETURNING id`,
      )
      .get({
        key: KEY,
        title: TITLE,
        size,
        base,
        dir: `specs/${KEY}/`,
        docs: JSON.stringify(docs),
        estimate: JSON.stringify(plan.estimate),
        subtasks: o.subtasks ? 1 : 0,
      }) as { id: number }
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
  const approve = async (body: Record<string, unknown>) =>
    json<TaskDto & ApiError>(`/api/tasks/${task}/plan`, { version: (await get()).version, commands: ["t"], prefix: "feature/", ...body });
  const settle = async () => {
    await until(async () => {
      const t = await get();
      return !t.working && !t.steps.some((s) => s.state === "running" || s.state === "waiting");
    });
    return get();
  };
  const remote = async (args: string[]) => (await git(["--git-dir", r.remote, ...args], { env: r.env })).trim();
  // The paths and subjects of a part branch on the server since from.
  const changed = async (from: string, branch: string) => (await remote(["diff", "--name-only", from, `refs/heads/${branch}`])).split("\n");
  const subjects = async (from: string, branch: string) =>
    (await remote(["log", "--reverse", "--format=%s", `${from}..refs/heads/${branch}`])).split("\n");
  return { root, r, db, w, base, task, json, get, approve, settle, remote, changed, subjects };
}

const partOf = (t: TaskDto, ord: number) => t.parts.find((p) => p.ord === ord) as TaskDto["parts"][number];

describe("the plan review choice (self-approved-plans.md section 3.2)", () => {
  test(
    "AC-SA7: review with a small or medium plan gives 400; review on a task with sub-tasks gives 400, also while it builds",
    async () => {
      const s = await planned();
      for (const size of ["small", "medium"])
        expect(await s.approve({ size, review: "self" })).toMatchObject({
          status: 400,
          body: { error: "Only a large plan takes a plan review choice." },
        });
      const t = await s.get();
      expect([t.state, t.plan?.approved, t.settings.planReview]).toEqual(["spec_draft", false, undefined]);

      const sub = await planned({ subtasks: true });
      const SUB = "A task with sub-tasks builds one PR per sub-task. It takes no plan review.";
      expect(await sub.approve({ size: "small", review: "self" })).toMatchObject({ status: 400, body: { error: SUB } });
      sub.db.query("UPDATE task SET state = 'implementing' WHERE id = $id").run({ id: sub.task });
      expect(await sub.approve({ size: "small", review: "spec-pr" })).toMatchObject({ status: 400, body: { error: SUB } });
      expect(sub.w.writes).toEqual([]);
    },
    SLOW,
  );

  test(
    "AC-SA6: large with review spec-pr or with no review stays in spec_draft, approved; a second approval with self builds the stack",
    async () => {
      const s = await planned();
      const pr = await s.approve({ size: "large", review: "spec-pr" });
      expect([pr.status, pr.body.state, pr.body.plan?.approved, pr.body.settings.planReview, pr.body.parts]).toEqual([
        200,
        "spec_draft",
        true,
        "spec-pr",
        [],
      ]);
      const none = await s.approve({ size: "large" });
      expect([none.status, none.body.state, none.body.settings.planReview, none.body.parts]).toEqual([200, "spec_draft", "spec-pr", []]);
      const self = await s.approve({ size: "large", review: "self" });
      expect([self.status, self.body.state, self.body.settings.planReview, self.body.parts.length]).toEqual([
        200,
        "implementing",
        "self",
        3,
      ]);
      const built = await s.settle();
      expect(built.parts.map((p) => p.state)).toEqual(["self_reviewed", "planned", "planned"]);
      expect(s.w.writes).toEqual([]);
    },
    SLOW,
  );
});

describe("the stack build (self-approved-plans.md sections 5.2 to 5.6)", () => {
  test(
    "part 2 starts on top of part 1",
    async () => {
      const s = await planned();
      // AC-SA5: the approval writes one row per plan part, keys [], and the stack links. Nothing goes to Bitbucket.
      const ok = await s.approve({ size: "large", review: "self" });
      expect([ok.status, ok.body.state, ok.body.size, ok.body.plan?.approved]).toEqual([200, "implementing", "large", true]);
      expect([ok.body.settings.planReview, ok.body.settings.maxOpen]).toEqual(["self", REPO_MAX_OPEN]);
      const [id1, id2] = ok.body.parts.map((p) => p.id) as [number, number, number];
      expect(ok.body.parts.map((p) => [p.ord, p.keys, p.branch, p.baseBranch, p.start, p.after, p.specDir, p.state])).toEqual([
        [1, [], B1, "main", "base", null, `specs/${KEY}/part-1/`, "planned"],
        [2, [], B2, B1, "stack", id1, `specs/${KEY}/part-2/`, "planned"],
        [3, [], B3, B2, "stack", id2, `specs/${KEY}/part-3/`, "planned"],
      ]);
      expect(s.w.writes).toEqual([]);

      // AC-SA8: part 1 builds from the fetched head of the target. Part 2 waits for a review of part 1, part 3 for part 2.
      const built = await s.settle();
      expect(built.parts.map((p) => [p.ord, p.state, p.wait])).toEqual([
        [1, "self_reviewed", null],
        [2, "planned", `Waits for a review of ${KEY} (1 of 3).`],
        [3, "planned", `Waits for a review of ${KEY} (2 of 3).`],
      ]);
      expect([partOf(built, 1).baseBranch, s.db.query("SELECT base_commit FROM task_part WHERE id = $id").get({ id: id1 })]).toEqual([
        "main",
        { base_commit: s.base },
      ]);
      expect(s.w.writes).toEqual([]);

      // The user opens the PR of part 1. It targets the target branch.
      const one = await s.json<TaskDto>(`/api/tasks/${s.task}/parts/${id1}/pr`, { version: built.version, reviewers: [] });
      expect([one.status, one.body.state]).toEqual([200, "implementing"]);
      const p1 = partOf(one.body, 1);
      const pushed1 = p1.pushed as string;
      const pr1 = s.w.prs.get(p1.remotePr as number);
      expect(pr1?.toRef.id).toBe("refs/heads/main");
      expect(pr1?.fromRef.id).toBe(`refs/heads/${B1}`);
      // AC-SA9: part 1 commits only its own plan slice, and each commit and the PR title name the part.
      expect((await s.changed(s.base, B1)).filter((f) => f.startsWith("specs/"))).toEqual([`specs/${KEY}/part-1/plan.md`]);
      expect(await s.subjects(s.base, B1)).toEqual([`${KEY} (part 1 of 3): Add the plan`, `${KEY} (part 1 of 3): Part one`]);
      expect(pr1?.title).toBe(`${KEY} (part 1 of 3): Part one`);
      expect(pr1?.description).toContain(`The plan: specs/${KEY}/part-1/plan.md`);
      expect(pr1?.description).toContain(`${KEY} (1 of 3): this PR · ${KEY} (2 of 3): next, builds on this PR · ${KEY} (3 of 3): next`);
      expect(pr1?.description).toContain(`Please keep this branch until ${KEY} (2 of 3) moves to the new target.`);
      expect(pr1?.description).not.toContain("Parent:");
      expect(liveTaskPart(s.db, p1.pr as number)?.plan).toEqual([`specs/${KEY}/part-1/plan.md`]);
      expect(s.w.writes).toHaveLength(1);

      // AC-SA8: part 2 still waits for the review of part 1. "Start now" overrides the wait.
      expect(partOf(one.body, 2).wait).toBe(`Waits for a review of ${KEY} (1 of 3).`);
      const start = await s.json<TaskDto>(`/api/tasks/${s.task}/parts/${id2}/start`, { version: one.body.version, override: true });
      expect(start.status).toBe(202);
      const two = await s.settle();
      expect(two.parts.map((p) => [p.ord, p.state])).toEqual([
        [1, "pr_open"],
        [2, "self_reviewed"],
        [3, "planned"],
      ]);
      // Part 2 branches from the pushed head of part 1, and its base branch is the branch of part 1.
      const p2 = partOf(two, 2);
      const base2 = s.db.query("SELECT base_commit FROM task_part WHERE id = $id").get({ id: p2.id }) as { base_commit: string };
      expect([p2.baseBranch, base2.base_commit]).toEqual([B1, pushed1]);

      // Its PR targets the branch of part 1, and its text lists the parts with the keep-branch sentence.
      const opened = await s.json<TaskDto>(`/api/tasks/${s.task}/parts/${p2.id}/pr`, { version: two.version, reviewers: [] });
      expect([opened.status, opened.body.state]).toEqual([200, "implementing"]);
      const pr2 = s.w.prs.get(partOf(opened.body, 2).remotePr as number);
      expect(pr2?.toRef.id).toBe(`refs/heads/${B1}`);
      expect(await s.remote(["merge-base", `refs/heads/${B2}`, pushed1])).toBe(pushed1);
      expect((await s.changed(pushed1, B2)).filter((f) => f.startsWith("specs/"))).toEqual([`specs/${KEY}/part-2/plan.md`]);
      expect(await s.subjects(pushed1, B2)).toEqual([`${KEY} (part 2 of 3): Add the plan`, `${KEY} (part 2 of 3): Part two`]);
      expect(pr2?.title).toBe(`${KEY} (part 2 of 3): Part two`);
      expect(pr2?.description).toContain(
        `${KEY} (1 of 3): #${p1.remotePr} (in review) · ${KEY} (2 of 3): this PR · ${KEY} (3 of 3): next, builds on this PR`,
      );
      expect(pr2?.description).toContain(`Please keep this branch until ${KEY} (3 of 3) moves to the new target.`);
      expect(pr2?.description).not.toContain("Parent:");
      expect(s.w.writes).toHaveLength(2);
    },
    SLOW,
  );
});

// ---------- Updates, merges, Skip, and Drop on stored part rows ----------

// A task ABC-10 as the approval and the build leave it: part 1 built and open into main, part 2 on top of part 1, part 3 planned on top of
// part 2. b: part 2 open into part 1's branch, built with no PR, or planned. subtasks: a task with the sub-tasks ABC-11 to ABC-13 instead.
async function stacked(o: { b: "open" | "built" | "planned"; subtasks?: boolean }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-sa2s-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  runner.write({ fixture: claudeStream(root, "sa2s", "claude-synthetic/review-flat.jsonl"), seq: { review: [{ review: CLEAN }] } });
  const fake = startFakeBitbucket();
  const w = repoWrites(fake, "PROJ", "repo");
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false, taskPlanCheck: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir: dataDir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const jobs = createReviewJobs({
    settings,
    live,
    dataDir,
    runnerCommand: runner.command,
    repoRemote: async () => ({ url: r.remote, config: [] }),
    listTools: stubListTools,
    claudeConfigDir: join(root, "no-claude-config"),
  });
  const db = jobs.open() as Database;
  const loop = createLoop({ review: jobs, settings, live });
  jobs.onStop(() => loop.shutdown());
  const prs = createPrOpener({ review: jobs, settings, live, working: loop.running, syncNow: () => {} });
  cleanup.push(async () => {
    await prs.shutdown();
    await jobs.stop();
    fake.stop();
    db.close();
  });
  const { base } = await taskCache(dataDir, r.remote);
  const clone = join(root, "clone");
  await git(["init", "-q", clone], { env: r.env });
  await git(["-C", clone, "config", "user.name", WHO.name], { env: r.env });
  await git(["-C", clone, "config", "user.email", WHO.email], { env: r.env });
  db.query("INSERT INTO repo_clone (project, repo, path, updated_at) VALUES ('PROJ', 'repo', $path, 0)").run({ path: clone });
  writeFileSync(join(root, "check.ts"), CHECK);
  const commands = [{ id: "t", name: "test", kind: "test", argv: [process.execPath, join(root, "check.ts")], timeoutSec: 60 }];
  db.query(
    `INSERT INTO repo_task_settings (project, repo, commands_json, line_budget, warned_at, updated_at)
    VALUES ('PROJ', 'repo', $commands, 400, 1, 1)`,
  ).run({ commands: JSON.stringify(commands) });
  const plan = toPlan(SPEC, base, [false, false, false], []);
  const size = o.subtasks ? "small" : "large";
  const docs = { ...renderDocs(KEY, TITLE, size, plan), version: 1, parsed: plan, approved: true };
  const taskSettings = { branchPrefix: "feature/", existing: "continue", maxOpen: 3, ...(!o.subtasks && { planReview: "self" }) };
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
          settings_json, subtasks, created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, $title, 'implementing', $size, 'claude', 'main', $base, $dir, $docs, $estimate, $settings, $subtasks,
          1, 1)
        RETURNING id`,
      )
      .get({
        key: KEY,
        title: TITLE,
        size,
        base,
        dir: `specs/${KEY}/`,
        docs: JSON.stringify(docs),
        estimate: JSON.stringify(plan.estimate),
        settings: JSON.stringify(taskSettings),
        subtasks: o.subtasks ? 1 : 0,
      }) as { id: number }
  ).id;
  // The stack rows of the approval, or the rows of three sub-tasks that build on each other.
  const rows = o.subtasks
    ? NAMES.map((name, i) => {
        const key = `ABC-1${i + 1}`;
        const branch = branchName("feature/", key, { kind: "small", title: `Part ${name}` });
        return { keys: [key], branch, specDir: `specs/${key}/` };
      })
    : stackParts({ key: KEY, target_branch: "main", spec_dir: `specs/${KEY}/` }, SPEC.parts, "feature/");
  const ids: number[] = [];
  for (const [i, p] of rows.entries())
    ids.push(
      (
        db
          .query(
            `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, keys_json, start_mode, after_part, spec_dir,
              created_at, updated_at)
            VALUES ($task, $ord, 'single', $title, $branch, $base, 'planned', $keys, $start, $after, $dir, 1, 1) RETURNING id`,
          )
          .get({
            task,
            ord: i + 1,
            title: `Part ${NAMES[i]}`,
            branch: p.branch,
            base: rows[i - 1]?.branch ?? "main",
            keys: JSON.stringify(p.keys),
            start: i ? "stack" : "base",
            after: ids[i - 1] ?? null,
            dir: p.specDir,
          }) as { id: number }
      ).id,
    );
  const [pA, pB, pC] = ids as [number, number, number];
  const [A, B] = rows.map((p) => p.branch) as [string, string];
  const t = () => taskRow(db, task) as TaskRow;
  const part = (id: number) =>
    db.query("SELECT * FROM task_part WHERE id = $id").get({ id }) as {
      id: number;
      state: string;
      branch: string;
      base_branch: string;
      base_commit: string | null;
      after_part: number | null;
      head: string | null;
      pushed: string | null;
      pr: number | null;
      remote_pr: number | null;
    };
  const wt = (ord: number, branch: string, from: string) =>
    openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task, ord, branch, base: from });
  const slice = (ord: number) =>
    partDocsOf(db, t(), { ord, keys_json: JSON.stringify(rows[ord - 1]?.keys), title: `Part ${NAMES[ord - 1]}` })?.plan as string;
  const built = (id: number, head: string, commit: string) =>
    db.query("UPDATE task_part SET head = $head, base_commit = $commit, state = 'self_reviewed' WHERE id = $id").run({ id, head, commit });
  const open = async (id: number) => {
    const res = await prs.open(db, task, id, { version: t().version, reviewers: [] });
    if (res.status !== 200) throw new Error(`The PR of part ${id} did not open: ${JSON.stringify(res)}`);
  };
  // Part 1 adds src/a.txt with line 3 "a3". Part 2 changes line 3 to "b3" and adds src/b.txt.
  const lines = (third: string) => `${["line 1", "line 2", third, "line 4"].join("\n")}\n`;
  const plan1 = `${rows[0]?.specDir}plan.md`;
  const wa = await wt(1, A, base);
  await write(wa, { [plan1]: slice(1), "src/a.txt": lines("a3") });
  const aHead = (await commitStep(wa, `${KEY}: Add a`, WHO, [plan1, "src/a.txt"])) as string;
  built(pA, aHead, base);
  await open(pA);
  let bHead: string | null = null;
  if (o.b !== "planned") {
    const plan2 = `${rows[1]?.specDir}plan.md`;
    const wb = await wt(2, B, aHead);
    await write(wb, { [plan2]: slice(2), "src/a.txt": lines("b3"), "src/b.txt": "b\n" });
    bHead = (await commitStep(wb, `${KEY}: Add b`, WHO, [plan2, "src/a.txt", "src/b.txt"])) as string;
    built(pB, bHead, aHead);
    if (o.b === "open") await open(pB);
  }
  const cache = cachePath(longPath(dataDir), { project: "PROJ", repo: "repo", id: task });
  const cacheGit = async (args: string[]) => (await git([`--git-dir=${cache}`, ...args], { env: gitSetup(longPath(dataDir)).env })).trim();
  const dto = () => taskDto(db, t());
  const blocked = () => {
    const b = t().blocked_json;
    return b === null ? null : (JSON.parse(b) as TaskBlocked);
  };
  const flow = () =>
    (
      db.query("SELECT kind, item, state FROM task_step WHERE task = $id ORDER BY id").all({ id: task }) as {
        kind: string;
        item: string;
        state: string;
      }[]
    )
      .filter((s) => !["push", "pr", "retarget"].includes(s.kind))
      .map((s) => `${s.kind}:${s.item ?? "-"}:${s.state}`);
  const v = () => ({ version: t().version });
  const prOf = (id: number) => w.prs.get(part(id).remote_pr as number);
  const lowerOfPart = (id: number) => dto().parts.find((p) => p.id === id)?.lower ?? null;
  // The sync marks the merge of part 1: the part state, else the synced PR state.
  const merged = (how: "part" | "pr") => {
    if (how === "pr") db.query("UPDATE pull_request SET state = 'MERGED' WHERE id = $id").run({ id: part(pA).pr });
    else {
      const res = advancePart(db, { task, version: t().version, part: pA }, { type: "MERGED" });
      if (res.status !== 200) throw new Error(res.error);
    }
  };
  // Bitbucket merges the PR of part 1 into main.
  const mergeA = async (m: { squash: boolean }) => {
    const res = await forgeMerge(r, { target: "main", source: A, ...m });
    w.merge(part(pA).remote_pr as number, { activity: res.commit, parents: res.parents });
    return res;
  };
  return {
    r,
    db,
    w,
    loop,
    prs,
    base,
    task,
    pA,
    pB,
    pC,
    A,
    B,
    aHead,
    bHead,
    t,
    part,
    dto,
    blocked,
    flow,
    v,
    prOf,
    lowerOfPart,
    merged,
    mergeA,
    cacheGit,
  };
}

describe("updates and merges in a stack plan (self-approved-plans.md section 5.7)", () => {
  test(
    "AC-SA10: part 1 merged with a merge commit gives one PUT to main and no git merge",
    async () => {
      const s = await stacked({ b: "open" });
      await s.mergeA({ squash: false });
      s.merged("pr");
      await s.loop.checkBases(s.db, s.task);
      expect(s.lowerOfPart(s.pB)).toEqual({ key: `${KEY} (1 of 3)`, how: "merge" });
      const writes = s.w.writes.length;
      const spy = spyGit();
      expect((await s.prs.move(s.db, s.task, s.pB, s.v())).status).toBe(202);
      expect(s.w.writes.slice(writes).map((x) => [x.method, x.body.toRef?.id])).toEqual([["PUT", "refs/heads/main"]]);
      expect(spy.calls.filter((a) => a.includes("merge") || a.includes("push") || a.includes("rebase"))).toEqual([]);
      expect(s.prOf(s.pB)?.toRef.id).toBe("refs/heads/main");
      expect([s.part(s.pB).base_branch, s.part(s.pB).base_commit]).toEqual(["main", s.aHead]);
    },
    SLOW,
  );

  test(
    "AC-SA10: part 1 merged with a squash gives the three merges; no push after the first push has a force flag or a + refspec",
    async () => {
      const s = await stacked({ b: "open" });
      const d1 = await remoteCommit(s.r, "main", { "dev1.txt": "d1\n" }, "Develop one");
      const sq = await s.mergeA({ squash: true });
      const m1 = await remoteCommit(s.r, "main", { "dev2.txt": "d2\n" }, "Develop two");
      s.merged("part");
      await s.loop.checkBases(s.db, s.task);
      expect(s.lowerOfPart(s.pB)).toEqual({ key: `${KEY} (1 of 3)`, how: "squash" });
      const spy = spyGit();
      expect((await s.loop.update(s.db, s.task, s.pB, s.v())).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.flow()).toEqual(["update:U1:ok", "check:U1:ok"]);
      // Part 2 holds the last head of part 1, so step a is skipped. Then the base before S, S with -s ours, and the rest of the base.
      expect(spy.merges().map((a) => [a.includes("ours"), a.at(-1)])).toEqual([
        [false, d1],
        [true, sq.commit],
        [false, m1],
      ]);
      const head = s.part(s.pB).head as string;
      expect((await s.cacheGit(["diff", "--name-only", `${m1}...${head}`])).split("\n")).toEqual([
        `specs/${KEY}/part-2/plan.md`,
        "src/a.txt",
        "src/b.txt",
      ]);
      expect((await s.prs.move(s.db, s.task, s.pB, { ...s.v(), push: true })).status).toBe(202);
      expect(s.prOf(s.pB)?.toRef.id).toBe("refs/heads/main");
      expect([s.part(s.pB).base_branch, s.part(s.pB).pushed]).toEqual(["main", head]);
      noForce(spy.pushes(), new Map([[s.B, s.bHead as string]]));
    },
    SLOW,
  );
});

describe("Skip and Drop in a stack plan (self-approved-plans.md section 5.8)", () => {
  test(
    "AC-SA11: a Drop of planned part 2 makes part 3 build on part 1",
    async () => {
      const s = await stacked({ b: "planned" });
      expect(s.loop.drop(s.db, s.task, s.pB, s.v()).status).toBe(200);
      expect([s.part(s.pB).state, s.part(s.pC).after_part, s.part(s.pC).base_branch]).toEqual(["abandoned", s.pA, s.A]);
      await s.loop.idle(s.task);
      expect(s.dto().parts.find((p) => p.id === s.pC)?.wait).toBe(`Waits for a review of ${KEY} (1 of 3).`);
      // Start now: part 3 branches from the pushed head of part 1. No test command stops its build before any Claude step.
      s.db.query("UPDATE repo_task_settings SET commands_json = '[]'").run();
      expect(s.loop.startNow(s.db, s.task, s.pC, s.v()).status).toBe(202);
      await s.loop.idle(s.task);
      const c = s.part(s.pC);
      expect([c.state, c.base_branch, c.base_commit]).toEqual(["implementing", s.A, s.aHead]);
      expect(s.blocked()?.text).toBe(NO_TEST);
    },
    SLOW,
  );

  test(
    "AC-SA11: a Skip of built part 2 makes part 3 build on part 1",
    async () => {
      const s = await stacked({ b: "built" });
      expect((await s.loop.skip(s.db, s.task, s.pB, s.v())).status).toBe(200);
      await s.loop.idle(s.task);
      expect([s.part(s.pB).state, s.part(s.pC).after_part, s.part(s.pC).base_branch]).toEqual(["abandoned", s.pA, s.A]);
      expect(s.dto().parts.find((p) => p.id === s.pC)?.wait).toBe(`Waits for a review of ${KEY} (1 of 3).`);
    },
    SLOW,
  );

  test(
    "AC-SA11: a task with sub-tasks keeps the base start of a planned part on top of a dropped part",
    async () => {
      const s = await stacked({ b: "planned", subtasks: true });
      s.db.query("UPDATE repo_task_settings SET commands_json = '[]'").run();
      expect(s.loop.drop(s.db, s.task, s.pB, s.v()).status).toBe(200);
      expect(s.part(s.pC).after_part).toBe(s.pB);
      await s.loop.idle(s.task);
      const c = s.part(s.pC);
      expect([c.state, c.base_branch, c.base_commit]).toEqual(["implementing", "main", s.base]);
      expect(s.blocked()?.text).toBe(NO_TEST);
    },
    SLOW,
  );
});

describe("the size rule in a stack plan (spec.md section 6.16.5)", () => {
  test(
    "AC-SA12: a submodule change in a part of a stack plan blocks with LARGE_REPOS_TEXT",
    async () => {
      const s = await multiTask({ seq: { "implement:instruct": [{ writes: [{ path: "repo/lib/lib.c", text: "int lib = 3;\n" }] }] } });
      s.db
        .query("UPDATE task SET size = 'large', settings_json = json_set(settings_json, '$.planReview', 'self') WHERE id = $id")
        .run({ id: s.task });
      s.db.query("UPDATE task_part SET keys_json = '[]', start_mode = 'base' WHERE task = $id").run({ id: s.task });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Change lib." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.blocked()).toEqual({ kind: "size", cause: "large_repos", step: null, text: LARGE_REPOS_TEXT });
    },
    SLOW,
  );
});
