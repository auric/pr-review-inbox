// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.20.10 (WP-ST4, AC-B15, AC-B79 to AC-B82): the push of a part, the update of a part on top of
// another part, and the move after the lower part merged with a merge commit, a squash, or another way. Part A (ABC-11) is open into main,
// part B (ABC-12) builds on A and is open into A's branch, part C (ABC-13) waits for B. A temp bare remote, the fake Bitbucket, and the fake
// CLI. No test starts the real CLI or reaches a forge or Jira. Each push and PR write runs only on the call of a route method, which stands
// for the user's click.
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
import { createLoop } from "../../src/server/tasks/loop";
import { partStepFile, renderDocs, toPlan } from "../../src/server/tasks/plan";
import { createPrOpener } from "../../src/server/tasks/pr";
import { pushRefusal } from "../../src/server/tasks/push";
import { approveSubtasks } from "../../src/server/tasks/subtasks";
import { ADOPTED, advancePart, partDocsOf, type TaskRow, taskDto, taskRow } from "../../src/server/tasks/tasks";
import { commitStep, openWorktree } from "../../src/server/tasks/worktree";
import type { ApiError, TaskDiffDto } from "../../src/shared/dto";
import { specResult, stepDetail, type TaskBlocked } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, forgeMerge, type Reply, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";
import { remoteCommit, WHO, write } from "./update-fixture";

for (const m of ["tasks/pr", "tasks/loop", "tasks/update", "tasks/push", "tasks/tasks", "tasks/subtasks", "tasks/plan"])
  console.log(`stack.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 240_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const PARENT = "ABC-10";
const A = "feature/ABC-11-a";
const B = "feature/ABC-12-b";
const C = "feature/ABC-13-c";
const NAMES = ["one", "two", "three"];
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const CLEAN = { summary: "Fine.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] };
// A adds src/a.txt with line 3 "a3". B changes line 3 to "b3".
const lines = (third: string) => `${[1, 2, third, 4, 5, 6].map((x) => (typeof x === "number" ? `line ${x}` : x)).join("\n")}\n`;
const RESOLVED = { path: "repo/src/a.txt", text: lines("b3") };
const NOT_MATCHED = "Bitbucket merged ABC-11 in a way that the app cannot match. The update merges main, and conflicts can come up.";
const NO_TEST = "Needs you: approve a test command for this repository first. The build needs it to see red and green tests.";

// The test command: green while no file under src/ holds a conflict marker.
const CHECK = `import { existsSync, readdirSync, readFileSync } from "node:fs";
const bad = existsSync("src") && readdirSync("src").some((f) => readFileSync("src/" + f, "utf8").includes("<<<<<<<"));
console.log(bad ? "FAIL conflict marker" : "1 pass");
process.exit(bad ? 1 : 0);
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
  title: "Build the sub-tasks",
  map: NAMES.map((name) => ({ path: `src/${name}.ts`, line: null, symbol: "", kind: "change", what: `The ${name}.` })),
  parts: NAMES.map((name, i) => planPart(i + 1, name)),
});

type Part = {
  id: number;
  branch: string;
  base_branch: string;
  base_commit: string | null;
  state: string;
  head: string | null;
  pushed: string | null;
  pr: number | null;
  remote_pr: number | null;
  override: number;
};

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

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

// AC-B82: no push argv has a force flag or a "+" refspec, and each push after the first push of a branch leases the commit of the push
// before it. pushTaskBranch checks the fast-forward before each push with a lease.
function noForce(pushes: string[][], before: Map<string, string> = new Map()) {
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

// A task ABC-10 with built parts A (ord 1, open into main) and B (ord 2, on top of A). openB: B has its PR into A's branch. C (ord 3)
// waits for B.
async function setup(o: { openB?: boolean; seq?: Record<string, unknown[]> } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-st4-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  runner.write({
    fixture: claudeStream(root, "st4", "claude/b6-hostile-repo.jsonl"),
    seq: { review: [{ review: CLEAN }], ...o.seq },
  });
  const fake = startFakeBitbucket();
  const w = repoWrites(fake, "PROJ", "repo");
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
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
  const docs = { ...renderDocs(PARENT, "Speed up the cache", "small", plan), version: 1, parsed: plan, approved: true };
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
          settings_json, subtasks, created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, 'Speed up the cache', 'implementing', 'small', 'rule', 'main', $base, $dir, $docs, $estimate,
          $settings, 1, 1, 1)
        RETURNING id`,
      )
      .get({
        key: PARENT,
        base,
        dir: `specs/${PARENT}/`,
        docs: JSON.stringify(docs),
        estimate: JSON.stringify(plan.estimate),
        settings: JSON.stringify({ branchPrefix: "feature/", existing: "continue", maxOpen: 3 }),
      }) as { id: number }
  ).id;
  for (const [i, k] of ["ABC-11", "ABC-12", "ABC-13"].entries())
    db.query(
      `INSERT INTO task_subtask (task, key, ord, summary, status, category, issue_json, links_json, found_json, read_at, status_at)
      VALUES ($task, $key, $ord, $summary, 'To Do', 'new', NULL, '[]', '[]', 1, 1)`,
    ).run({ task, key: k, ord: i + 1, summary: `Do ${k}` });
  const insert = (ord: number, branch: string, baseBranch: string, start: string, after: number | null) =>
    (
      db
        .query(
          `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, keys_json, start_mode, after_part, spec_dir, created_at,
            updated_at)
          VALUES ($task, $ord, 'single', $title, $branch, $base, 'planned', $keys, $start, $after, $dir, 1, 1) RETURNING id`,
        )
        .get({
          task,
          ord,
          title: `Part ${NAMES[ord - 1]}`,
          branch,
          base: baseBranch,
          keys: JSON.stringify([`ABC-1${ord}`]),
          start,
          after,
          dir: `specs/ABC-1${ord}/`,
        }) as { id: number }
    ).id;
  const pA = insert(1, A, "main", "base", null);
  const pB = insert(2, B, A, "stack", pA);
  const pC = insert(3, C, B, "stack", pB);

  const t = () => taskRow(db, task) as TaskRow;
  const part = (id: number) => db.query("SELECT * FROM task_part WHERE id = $id").get({ id }) as Part;
  const wt = (ord: number, branch: string, from: string) =>
    openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task, ord, branch, base: from });
  const docOf = (ord: number) => partDocsOf(db, t(), { ord, keys_json: JSON.stringify([`ABC-1${ord}`]), title: "" })?.plan;
  const built = (id: number, head: string, commit: string) =>
    db.query("UPDATE task_part SET head = $head, base_commit = $commit, state = 'self_reviewed' WHERE id = $id").run({ id, head, commit });
  const open = async (id: number) => {
    const res = await prs.open(db, task, id, { version: t().version, reviewers: [] });
    if (res.status !== 200) throw new Error(`The PR of part ${id} did not open: ${JSON.stringify(res)}`);
  };

  // Part A adds src/a.txt and src/only-a.txt.
  const wa = await wt(1, A, base);
  await write(wa, { "specs/ABC-11/plan.md": docOf(1) as string, "src/a.txt": lines("a3"), "src/only-a.txt": "a\n" });
  const aHead = (await commitStep(wa, "ABC-11: Add a", WHO)) as string;
  built(pA, aHead, base);
  await open(pA);
  // Part B starts from the pushed head of A, changes line 3 of src/a.txt, and adds src/b.txt.
  const wb = await wt(2, B, aHead);
  await write(wb, { "specs/ABC-12/plan.md": docOf(2) as string, "src/a.txt": lines("b3"), "src/b.txt": "b\n" });
  const bHead = (await commitStep(wb, "ABC-12: Add b", WHO)) as string;
  built(pB, bHead, aHead);
  if (o.openB !== false) await open(pB);

  const cache = cachePath(longPath(dataDir), { project: "PROJ", repo: "repo", id: task });
  const cacheGit = async (args: string[]) => (await git([`--git-dir=${cache}`, ...args], { env: gitSetup(longPath(dataDir)).env })).trim();
  const steps = () =>
    (
      db.query("SELECT kind, item, state, detail_json FROM task_step WHERE task = $id ORDER BY id").all({ id: task }) as {
        kind: string;
        item: string | null;
        state: string;
        detail_json: string;
      }[]
    ).map((s) => ({ ...s, detail: stepDetail.parse(JSON.parse(s.detail_json)) }));
  const flow = () =>
    steps()
      .filter((s) => !["push", "pr", "retarget"].includes(s.kind))
      .map((s) => `${s.kind}:${s.item ?? "-"}:${s.state}`);
  const blocked = () => {
    const b = t().blocked_json;
    return b === null ? null : (JSON.parse(b) as TaskBlocked);
  };
  const update = async (id: number) => {
    const res = await loop.update(db, task, id, { version: t().version });
    await loop.idle(task);
    return res;
  };
  const lowerOfPart = (id: number) => taskDto(db, t()).parts.find((p) => p.id === id)?.lower ?? null;
  const prOf = (id: number) => w.prs.get(part(id).remote_pr as number);
  const remoteHead = (branch: string) => r.g(["rev-parse", `refs/heads/${branch}`]);
  // The sync marks the merge of A (WP-ST5): the part state, else the synced PR state.
  const merged = (how: "part" | "pr") => {
    if (how === "pr") db.query("UPDATE pull_request SET state = 'MERGED' WHERE id = $id").run({ id: part(pA).pr });
    else {
      const res = advancePart(db, { task, version: t().version, part: pA }, { type: "MERGED" });
      if (res.status !== 200) throw new Error(res.error);
    }
  };
  // Bitbucket merges the PR of A into main.
  const mergeA = async (m: { squash: boolean; edit?: Record<string, string> }) => {
    const res = await forgeMerge(r, { target: "main", source: A, ...m });
    w.merge(part(pA).remote_pr as number, { activity: res.commit, parents: res.parents });
    return res;
  };
  return {
    root,
    r,
    db,
    fake,
    w,
    jobs,
    settings,
    live,
    dataDir,
    loop,
    prs,
    base,
    task,
    pA,
    pB,
    pC,
    aHead,
    bHead,
    t,
    part,
    wt,
    cacheGit,
    steps,
    flow,
    blocked,
    update,
    lowerOfPart,
    prOf,
    remoteHead,
    merged,
    mergeA,
  };
}

type S = Awaited<ReturnType<typeof setup>>;
const version = (s: S) => ({ version: s.t().version });
// One more commit of a part, as Tell Claude leaves it: the head moves, and nothing is on the server yet.
async function newCommit(s: S, id: number, ord: number, branch: string, files: Record<string, string>) {
  const w = await s.wt(ord, branch, s.part(id).base_commit as string);
  await write(w, files);
  const head = (await commitStep(w, "more work", WHO)) as string;
  s.db.query("UPDATE task_part SET head = $head WHERE id = $id").run({ id, head });
  return head;
}

describe("changes in a lower part before its merge (spec.md section 6.20.10)", () => {
  test(
    "AC-B79: Push to A is a fast-forward with the lease; B's base check shows A's new commits; the update merges them; Push to B needs no force",
    async () => {
      const s = await setup();
      const spy = spyGit();
      const a2 = await newCommit(s, s.pA, 1, A, { "src/only-a.txt": "a2\n" });
      const pushed = await s.prs.pushNow(s.db, s.task, s.pA, version(s));
      expect(pushed.status).toBe(202);
      expect([s.part(s.pA).pushed, await s.remoteHead(A)]).toEqual([a2, a2]);
      expect((await s.prs.pushNow(s.db, s.task, s.pA, version(s))) as ApiError).toMatchObject({ error: `${A} has no new commits.` });

      await s.loop.checkBases(s.db, s.task);
      expect(
        taskDto(s.db, s.t())
          .parts.find((p) => p.id === s.pB)
          ?.bases.map((b) => [b.branch, b.newCommits]),
      ).toEqual([[A, 1]]);
      expect((await s.update(s.pB)).status).toBe(202);
      expect(s.flow()).toEqual(["update:U1:ok", "check:U1:ok"]);
      expect(s.steps().find((x) => x.kind === "update")?.detail.update?.repos).toEqual([
        { taskRepo: expect.any(Number), base: A, mode: "merge", newBaseHead: a2 },
      ]);
      // The update writes the base commit of the part, never the base commit of the task.
      expect([s.part(s.pB).base_commit, s.t().base_commit]).toEqual([a2, s.base]);
      expect((await s.prs.pushNow(s.db, s.task, s.pB, version(s))).status).toBe(202);
      expect(await s.remoteHead(B)).toBe(s.part(s.pB).head as string);
      // Each push after the first push of a branch is a fast-forward with the lease and no "+".
      const pushes = spy.pushes();
      expect(pushes).toHaveLength(2);
      noForce(
        pushes,
        new Map([
          [A, s.aHead],
          [B, s.bHead],
        ]),
      );
      await s.r.g(["merge-base", "--is-ancestor", s.bHead, s.part(s.pB).head as string]);
    },
    SLOW,
  );
});

describe("the move after the lower part merged (spec.md section 6.20.10)", () => {
  test(
    "AC-B80: A merged with a merge commit gives one PUT to main and no git merge; the base commit of B becomes the merge base",
    async () => {
      const s = await setup();
      const m = await s.mergeA({ squash: false });
      s.merged("pr");
      expect(s.lowerOfPart(s.pB)).toBeNull();
      await s.loop.checkBases(s.db, s.task);
      expect(s.lowerOfPart(s.pB)).toEqual({ key: "ABC-11", how: "merge" });
      const writes = s.w.writes.length;
      const spy = spyGit();
      const r = await s.prs.move(s.db, s.task, s.pB, version(s));
      expect(r.status).toBe(202);
      const puts = s.w.writes.slice(writes);
      expect(puts.map((x) => [x.method, x.body.toRef?.id])).toEqual([["PUT", "refs/heads/main"]]);
      expect(spy.calls.filter((a) => a.includes("merge") || a.includes("push") || a.includes("rebase"))).toEqual([]);
      expect(s.prOf(s.pB)?.toRef.id).toBe("refs/heads/main");
      const b = s.part(s.pB);
      expect([b.base_branch, b.base_commit]).toEqual(["main", await s.cacheGit(["merge-base", s.bHead, m.commit])]);
      expect(b.base_commit).toBe(s.aHead);
      expect(s.lowerOfPart(s.pB)).toBeNull();
      expect(s.steps().find((x) => x.kind === "retarget")?.detail.notes).toEqual([`Moved PR #${b.remote_pr} from ${A} to main.`]);
      expect((await s.prs.move(s.db, s.task, s.pB, version(s))) as ApiError).toMatchObject({
        status: 409,
        error: "The part below this one did not merge.",
      });
    },
    SLOW,
  );

  test(
    "AC-B81, AC-B82: a squash gives the three merges, the PR diff lists only B's files; Push and move keeps the push after a failed PUT, and Try again moves",
    async () => {
      const s = await setup();
      const d1 = await remoteCommit(s.r, "main", { "dev1.txt": "d1\n" }, "Develop one");
      const sq = await s.mergeA({ squash: true });
      expect(sq.parents).toEqual([d1]);
      const m1 = await remoteCommit(s.r, "main", { "dev2.txt": "d2\n" }, "Develop two");
      s.merged("part");
      await s.loop.checkBases(s.db, s.task);
      expect(s.lowerOfPart(s.pB)).toEqual({ key: "ABC-11", how: "squash" });
      expect(
        taskDto(s.db, s.t())
          .parts.find((p) => p.id === s.pB)
          ?.bases.map((b) => [b.branch, b.newCommits]),
      ).toEqual([["main", 3]]);
      // The PR of B opens no second time, and a plain push waits for the move.
      expect(((await s.prs.pushNow(s.db, s.task, s.pB, version(s))) as ApiError).error).toBe(
        "ABC-11 merged. Move this part to main first.",
      );

      const spy = spyGit();
      expect((await s.update(s.pB)).status).toBe(202);
      expect(s.flow()).toEqual(["update:U1:ok", "check:U1:ok"]);
      // B holds A_final, so step a is skipped. Then the base before S, S with -s ours, and the rest of the base.
      expect(spy.merges().map((a) => [a.includes("ours"), a.at(-1)])).toEqual([
        [false, d1],
        [true, sq.commit],
        [false, m1],
      ]);
      const b = s.part(s.pB);
      expect([b.base_commit, b.base_branch, s.t().base_commit]).toEqual([m1, A, s.base]);
      expect(await s.cacheGit(["log", "-3", "--format=%s", b.head as string])).toBe(
        [`ABC-12: merge main into ${B}`, `ABC-12: record the squash merge of ${A}`, `ABC-12: merge main into ${B}`].join("\n"),
      );
      // After the merges, main is in B: the PR diff against main holds only the files of B.
      expect((await s.cacheGit(["diff", "--name-only", `${m1}...${b.head}`])).split("\n")).toEqual([
        "specs/ABC-12/plan.md",
        "src/a.txt",
        "src/b.txt",
      ]);
      expect((await s.cacheGit(["show", `${b.head}:src/a.txt`])).split("\n")[2]).toBe("b3");

      // Push and move: the push passes, the PUT fails, and the PR still points at A's branch.
      const route = `PUT ${s.w.path}/pull-requests/${b.remote_pr}`;
      const put = s.fake.routes[route] as (req: Request) => Reply | Promise<Reply>;
      let fail = true;
      s.fake.routes[route] = (req) => {
        if (!fail) return put(req);
        fail = false;
        return { status: 500, body: { errors: [{ message: "Down." }] } };
      };
      const first = await s.prs.move(s.db, s.task, s.pB, { ...version(s), push: true });
      expect(first).toEqual({ status: 502, error: `The PR still points at ${A}.` });
      expect([s.part(s.pB).pushed, await s.remoteHead(B)]).toEqual([b.head, b.head]);
      expect(s.part(s.pB).base_branch).toBe(A);
      // Try again: the PUT only.
      const pushes = spy.pushes().length;
      const again = await s.prs.move(s.db, s.task, s.pB, version(s));
      expect(again.status).toBe(202);
      expect(spy.pushes()).toHaveLength(pushes);
      expect(s.prOf(s.pB)?.toRef.id).toBe("refs/heads/main");
      expect([s.part(s.pB).base_branch, s.part(s.pB).base_commit]).toEqual(["main", m1]);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "retarget")
          .map((x) => [x.state, x.detail.notes[0]]),
      ).toEqual([
        ["failed", `The PR still points at ${A}.`],
        ["ok", `Moved PR #${b.remote_pr} from ${A} to main.`],
      ]);
      await s.loop.checkBases(s.db, s.task);
      const after = taskDto(s.db, s.t()).parts.find((p) => p.id === s.pB);
      expect([after?.lower, after?.bases.map((x) => [x.branch, x.newCommits])]).toEqual([null, [["main", 0]]]);
      // No push needed force, and the remote head of B moved as a fast-forward.
      noForce(spy.pushes(), new Map([[B, s.bHead]]));
      await s.r.g(["merge-base", "--is-ancestor", s.bHead, b.head as string]);
    },
    SLOW,
  );

  test(
    "AC-B81: an edited squash fails the tree check and takes the plain merge with a resolve step",
    async () => {
      const s = await setup({ seq: { "implement:resolve": [{ writes: [RESOLVED] }] } });
      const sq = await s.mergeA({ squash: true, edit: { "squash-note.txt": "the merger added this\n" } });
      s.merged("part");
      const spy = spyGit();
      expect((await s.update(s.pB)).status).toBe(202);
      expect(s.blocked()).toBeNull();
      expect(s.flow()).toEqual(["update:U1:ok", "resolve:U1:ok", "check:U1:ok", "review:review:ok"]);
      expect(spy.merges().map((a) => [a.includes("ours"), a.at(-1)])).toEqual([[false, sq.commit]]);
      const u = s.steps().find((x) => x.kind === "update");
      expect(u?.detail.notes).toContain(NOT_MATCHED);
      expect(u?.detail.update).toMatchObject({ result: "green", resolved: true });
      expect(s.steps().find((x) => x.kind === "resolve")?.detail.resolve?.paths).toEqual(["src/a.txt"]);
      expect(s.lowerOfPart(s.pB)).toEqual({ key: "ABC-11", how: "other" });
      expect(s.part(s.pB).base_commit).toBe(sq.commit);
    },
    SLOW,
  );

  test(
    "AC-B81: B not pushed takes rebase --onto; its PR waits for the move, and the move needs no PUT",
    async () => {
      const s = await setup({ openB: false });
      const sq = await s.mergeA({ squash: true });
      s.merged("part");
      expect(((await s.prs.open(s.db, s.task, s.pB, { ...version(s), reviewers: [] })) as ApiError).error).toBe(
        "ABC-11 merged. Move this part to main first.",
      );
      const spy = spyGit();
      expect((await s.update(s.pB)).status).toBe(202);
      expect(s.flow()).toEqual(["update:U1:ok", "check:U1:ok"]);
      expect(spy.calls.some((a) => a.includes("rebase") && a.includes("--onto") && a.includes(sq.commit) && a.includes(s.aHead))).toBe(
        true,
      );
      expect(spy.merges()).toEqual([]);
      expect([s.part(s.pB).base_commit, s.part(s.pB).pushed]).toEqual([sq.commit, null]);
      const writes = s.w.writes.length;
      expect((await s.prs.move(s.db, s.task, s.pB, { ...version(s), push: true })).status).toBe(202);
      expect(s.w.writes.length).toBe(writes);
      expect(spy.pushes()).toEqual([]);
      expect([s.part(s.pB).base_branch, s.part(s.pB).base_commit]).toEqual(["main", sq.commit]);
      expect((await s.prs.open(s.db, s.task, s.pB, { ...version(s), reviewers: [] })).status).toBe(200);
      expect(s.prOf(s.pB)?.toRef.id).toBe("refs/heads/main");
      noForce(spy.pushes());
    },
    SLOW,
  );

  test(
    "A's branch deleted at the merge declined the PR of B: Push and move pushes, opens the PR again, and moves it",
    async () => {
      const s = await setup();
      await s.mergeA({ squash: false });
      s.merged("pr");
      await s.r.g(["update-ref", "-d", `refs/heads/${A}`]);
      const pr = s.prOf(s.pB) as NonNullable<ReturnType<S["prOf"]>>;
      pr.state = "DECLINED";
      s.db.query("UPDATE task_part SET state = 'declined' WHERE id = $id").run({ id: s.pB });
      const head = await newCommit(s, s.pB, 2, B, { "src/b.txt": "b2\n" });
      const writes = s.w.writes.length;
      const spy = spyGit();
      const r = await s.prs.move(s.db, s.task, s.pB, { ...version(s), push: true });
      expect(r.status).toBe(202);
      expect(await s.remoteHead(B)).toBe(head);
      expect(s.w.writes.slice(writes).map((x) => `${x.method} ${x.path.replace(s.w.path, "")}`)).toEqual([
        `POST /pull-requests/${pr.id}/reopen`,
        `PUT /pull-requests/${pr.id}`,
      ]);
      expect([pr.state, pr.toRef.id]).toEqual(["OPEN", "refs/heads/main"]);
      expect([s.part(s.pB).state, s.part(s.pB).base_branch]).toEqual(["pr_open", "main"]);
      noForce(spy.pushes(), new Map([[B, s.bHead]]));
    },
    SLOW,
  );
});

describe("the push guard (spec.md sections 6.20.2 and 6.20.12)", () => {
  test(
    "AC-B76: a push and a move of a tracked PR are refused before git runs",
    async () => {
      const s = await setup();
      const tracked = (
        s.db
          .query(
            `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, head, keys_json, start_mode, adopted, created_at, updated_at)
          VALUES ($task, 4, 'single', 'Tracked', 'feature/ABC-14-x', 'main', 'pr_open', $head, '["ABC-14"]', 'base', 1, 1, 1) RETURNING id`,
          )
          .get({ task: s.task, head: s.bHead }) as { id: number }
      ).id;
      const spy = spyGit();
      expect((await s.prs.pushNow(s.db, s.task, tracked, version(s))) as ApiError).toMatchObject({ status: 409, error: ADOPTED });
      expect((await s.prs.move(s.db, s.task, tracked, { ...version(s), push: true })) as ApiError).toMatchObject({
        status: 409,
        error: ADOPTED,
      });
      expect(spy.calls).toEqual([]);
    },
    SLOW,
  );

  test("a found branch passes only for Continue on it, with the part key; every other rule stays", () => {
    const found = "feature/ABC-12-Old_Work";
    const task = { key: "ABC-12", prefix: "feature/", branches: [found], target: "main" };
    const commit = "a".repeat(40);
    expect(pushRefusal({ branch: found, commit, lease: null, task: { ...task, found: [found] } })).toBeNull();
    expect(pushRefusal({ branch: found, commit, lease: null, task })).toBe(`${found} is not a task branch name.`);
    const other = "feature/ABC-13-Old_Work";
    expect(pushRefusal({ branch: other, commit, lease: null, task: { ...task, branches: [other], found: [other] } })).toBe(
      `${other} is not a task branch name.`,
    );
    expect(pushRefusal({ branch: found, commit, lease: null, task: { ...task, branches: [], found: [found] } })).toBe(
      `${found} is not a branch of task ABC-12.`,
    );
    expect(
      pushRefusal({
        branch: "feature/ABC-12-",
        commit,
        lease: null,
        task: { ...task, branches: ["feature/ABC-12-"], found: ["feature/ABC-12-"] },
      }),
    ).toBe("feature/ABC-12- is not a task branch name.");
    const bad = "feature/ABC-12-x:refs/heads/main";
    expect(pushRefusal({ branch: bad, commit, lease: null, task: { ...task, branches: [bad], found: [bad] } })).toBe(
      `${bad} is not a task branch name.`,
    );
    expect(pushRefusal({ branch: "main", commit, lease: null, task: { ...task, target: "main", found: ["main"] } })).toBe(
      "The app never pushes to the target branch main.",
    );
  });

  test("Start a new branch never stores the name of a found branch, so the part start cannot continue on it", () => {
    const planned = "feature/ABC-3-do-abc-3";
    const row = {
      key: "ABC-3",
      ord: 1,
      summary: "Do ABC-3",
      status: "To Do",
      category: "new" as const,
      issue_json: "{}",
      links_json: "[]",
      found_json: JSON.stringify([{ kind: "branch", name: planned }]),
      read_at: 1,
      status_at: 1,
      added_at: null,
      removed_at: null,
    };
    const sub = {
      starts: [{ n: 1, keys: ["ABC-3"], start: "base" as const, after: null, reason: "", skip: false }],
      maxOpen: { value: 1, reason: "" },
      notes: [],
    };
    const approve = (existing: "continue" | "new") => {
      const r = approveSubtasks({
        t: { key: "ABC-1", title: "Parent", target_branch: "main" },
        plan: [{ n: 1, title: "One" }],
        sub,
        rows: [row],
        input: { parts: [{ n: 1, start: "base", after: null, existing }], track: [], maxOpen: 1 },
        prefix: "feature/",
        specDir: "specs/{key}/",
      });
      if (typeof r === "string" || "bad" in r) throw new Error(JSON.stringify(r));
      return r.parts[0]?.branch;
    };
    expect(approve("new")).toBe(`${planned}-2`);
    expect(approve("continue")).toBe(planned);
  });
});

describe("start now, drop, and the routes (spec.md sections 6.20.6, 6.20.7, and 6.20.12)", () => {
  test(
    "Start now overrides the review of the lower part and keeps the limit; Drop refuses while a started part builds on the part",
    async () => {
      const s = await setup();
      // A declined A cannot go while B builds on it. A built part is no drop.
      s.db.query("UPDATE task_part SET state = 'declined' WHERE id = $id").run({ id: s.pA });
      expect((s.loop.drop(s.db, s.task, s.pA, version(s)) as ApiError).error).toBe("ABC-12 builds on ABC-11. Move or drop ABC-12 first.");
      s.db.query("UPDATE task_part SET state = 'pr_open' WHERE id = $id").run({ id: s.pA });
      expect((s.loop.drop(s.db, s.task, s.pB, version(s)) as ApiError).error).toBe(
        "Only a part that waits for its build or a declined PR can be dropped.",
      );
      // A planned part with nothing on top of it goes.
      const d = (
        s.db
          .query(
            `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, keys_json, start_mode, created_at, updated_at)
            VALUES ($task, 4, 'single', 'Part four', 'feature/ABC-14-d', 'main', 'planned', '["ABC-14"]', 'base', 1, 1) RETURNING id`,
          )
          .get({ task: s.task }) as { id: number }
      ).id;
      s.db.query("UPDATE task SET settings_json = json_set(settings_json, '$.maxOpen', 2) WHERE id = $id").run({ id: s.task });
      expect(s.loop.drop(s.db, s.task, d, version(s)).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part(d).state).toBe("abandoned");
      expect(s.t().state).toBe("implementing");

      // At the limit of 2 open PRs, C cannot start. B itself does not wait for a review.
      expect((s.loop.startNow(s.db, s.task, s.pC, version(s)) as ApiError).error).toBe("Waits: 2 PRs of this task are open, your limit.");
      expect((s.loop.startNow(s.db, s.task, s.pB, version(s)) as ApiError).error).toBe("This part does not wait for a review.");
      expect(s.part(s.pC).override).toBe(0);
      // With room, C starts on the pushed head of B. No test command stops its build before any Claude step.
      s.db.query("UPDATE task SET settings_json = json_set(settings_json, '$.maxOpen', 3) WHERE id = $id").run({ id: s.task });
      s.db.query("UPDATE repo_task_settings SET commands_json = '[]'").run();
      expect(s.loop.startNow(s.db, s.task, s.pC, version(s)).status).toBe(202);
      await s.loop.idle(s.task);
      const c = s.part(s.pC);
      expect([c.state, c.override, c.base_branch, c.base_commit]).toEqual(["implementing", 1, B, s.bHead]);
      expect(s.blocked()?.text).toBe(NO_TEST);
    },
    SLOW,
  );

  test(
    "the routes: zod inputs, the 409 sentences, and the Diff tab from the base commit of the part",
    async () => {
      const s = await setup();
      const app = createApp({ port: PORT, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const post = async (path: string, body: unknown) => {
        const res = await app.request(`${ORIGIN}/api/tasks/${s.task}${path}`, {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify(body),
        });
        return { status: res.status, error: ((await res.json()) as ApiError).error };
      };
      const v = () => s.t().version;
      expect(await post(`/parts/${s.pC}/start`, { version: v() })).toEqual({
        status: 400,
        error: "Give the task version and override true.",
      });
      expect(await post(`/parts/${s.pB}/start`, { version: v(), override: true })).toEqual({
        status: 409,
        error: "This part does not wait for a review.",
      });
      expect(await post(`/parts/${s.pB}/move`, { version: v(), push: false })).toMatchObject({ status: 400 });
      expect(await post(`/parts/${s.pB}/move`, { version: v(), push: true })).toEqual({
        status: 409,
        error: "The part below this one did not merge.",
      });
      expect(await post(`/parts/${s.pB}/push`, { version: v() })).toEqual({ status: 409, error: `${B} has no new commits.` });
      expect(await post(`/parts/${s.pB}/drop`, { version: v() })).toEqual({
        status: 409,
        error: "Only a part that waits for its build or a declined PR can be dropped.",
      });
      expect(await post(`/parts/${s.pC}/wait-merge`, { version: v() })).toEqual({ status: 409, error: "This part does not wait for you." });
      expect(await post(`/parts/${s.pB}/push`, { version: v() - 1 })).toMatchObject({
        status: 409,
        error: "The task changed on another page. Check it again.",
      });

      // The Diff tab of B diffs from the pushed head of A, so the files of A stay out.
      const res = await app.request(`${ORIGIN}/api/tasks/${s.task}/parts/${s.pB}/diff`, { headers: HEADERS });
      const diff = (await res.json()) as TaskDiffDto;
      expect([res.status, diff.base]).toEqual([200, s.aHead]);
      expect(diff.files.map((f) => f.path)).toEqual(["specs/ABC-12/plan.md", "src/a.txt", "src/b.txt"]);

      // The step file of a part plan names the part count of the whole plan.
      const docs = partDocsOf(s.db, s.t(), { ord: 2, keys_json: '["ABC-12"]', title: "" });
      const parsed = docs?.parsed as NonNullable<typeof docs>["parsed"];
      expect(parsed.parts.map((p) => p.n)).toEqual([2]);
      expect(partStepFile(parsed, parsed.parts, "tests", 1).text).toContain("- Part 2 of 3: Part two");
    },
    SLOW,
  );
});
