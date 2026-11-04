// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.20.6 (user decision of 2026-11-02): the parts of a task with Jira sub-tasks that do not wait for
// each other build at the same time, at most buildsAtOnce. Their Claude steps run beside the review run slot. A temp bare remote, the
// fake Bitbucket, and the fake CLI. No test starts the real CLI or reaches a forge or Jira.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { git } from "../../src/server/review/git";
import { createReviewJobs, type ReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createLoop, type TaskLoop } from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import { type TaskRow, taskDto, taskRow } from "../../src/server/tasks/tasks";
import { openWorktree, patchFile } from "../../src/server/tasks/worktree";
import { branchName, specResult } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["tasks/loop", "tasks/schedule", "tasks/tasks", "review/jobs"])
  console.log(`concurrent.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 240_000;
const PARENT = "ABC-10";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const CLEAN = { summary: "Fine.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] };
const NAMES = ["one", "two", "three"];
const SUBS = [
  { key: "ABC-11", summary: "Add the event generator" },
  { key: "ABC-12", summary: "Flush the cache" },
  { key: "ABC-13", summary: "Batch the writes" },
];

// The approved test command: green when each tests/<name>.test.ts has a src/<name>.ts that holds "works".
const CHECK = `import { existsSync, readdirSync, readFileSync } from "node:fs";
const tests = existsSync("tests") ? readdirSync("tests").filter((f) => f.endsWith(".test.ts")) : [];
const bad = tests.filter((f) => {
  const src = "src/" + f.slice(0, -".test.ts".length) + ".ts";
  return !existsSync(src) || !readFileSync(src, "utf8").includes("works");
});
console.log(bad.length ? "FAIL " + bad.join(", ") : tests.length + " pass");
process.exit(bad.length ? 1 : 0);
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

const file = (path: string, text: string) => ({ writes: [{ path: `repo/${path}`, text }] });
// Each part gets its own writes by the text of its plan file, because the steps of two parts run in no fixed order.
const BUILD = {
  match: NAMES.map((n) => ({
    when: `src/${n}.ts`,
    seq: {
      "implement:tests": [file(`tests/${n}.test.ts`, `test("${n}", () => {});\n`)],
      "implement:implement": [file(`src/${n}.ts`, `export const ${n} = "todo";\n`)],
      "implement:fix": [file(`src/${n}.ts`, `export const ${n} = "works";\n`)],
    },
  })),
  taskReview: CLEAN,
};
// Every Claude step of a part waits until a Cancel kills it.
const HANG = { bySchema: { implement: { hang: true } } };

type Call = { argv: string[]; cwd: string; stdin: string };
type Scenario = typeof BUILD | typeof HANG;

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// Bounded wait for a condition of the database or the record file.
async function until(f: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("The condition did not hold in time.");
    await Bun.sleep(25);
  }
}

// A task ABC-10 in implementing with the sub-tasks ABC-11 to ABC-13 as part 1 to 3, as the plan approval leaves them. Parts 1 and 2 start
// from the base. third: the start of part 3, from the base or on top of part 1.
async function setup(o: { atOnce: number; third: "base" | "stack"; scenario: Scenario }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-par-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  const fixture = claudeStream(root, "par", "claude/b6-hostile-repo.jsonl");
  runner.write({ fixture, ...o.scenario });
  const fake = startFakeBitbucket();
  repoWrites(fake, "PROJ", "repo");
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir: dataDir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const app = (): { jobs: ReviewJobs; loop: TaskLoop } => {
    const jobs = createReviewJobs({
      settings,
      live,
      dataDir,
      runnerCommand: runner.command,
      repoRemote: async () => ({ url: r.remote, config: [] }),
      listTools: stubListTools,
      claudeConfigDir: join(root, "no-claude-config"),
    });
    const loop = createLoop({ review: jobs, settings, live });
    jobs.onStop(() => loop.shutdown());
    return { jobs, loop };
  };
  const first = app();
  const db = first.jobs.open() as Database;
  const apps = [first];
  cleanup.unshift(async () => {
    for (const a of apps) await a.jobs.stop();
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
  const issue = (key: string, summary: string) => ({
    key,
    summary,
    status: "To Do",
    description: `Do ${key}.`,
    comments: [],
    commentsTotal: 0,
    truncated: false,
    attachments: [],
  });
  const plan = toPlan(SPEC, base, [false, false, false], []);
  const docs = { ...renderDocs(PARENT, "Speed up the cache", "small", plan), version: 1, parsed: plan, approved: true };
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
          settings_json, issue_json, subtasks, created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, 'Speed up the cache', 'implementing', 'small', 'rule', 'main', $base, $dir, $docs, $estimate,
          $settings, $issue, 1, 1, 1)
        RETURNING id`,
      )
      .get({
        key: PARENT,
        base,
        dir: `specs/${PARENT}/`,
        docs: JSON.stringify(docs),
        estimate: JSON.stringify(plan.estimate),
        settings: JSON.stringify({ branchPrefix: "feature/", existing: "continue", maxOpen: 5, buildsAtOnce: o.atOnce }),
        issue: JSON.stringify(issue(PARENT, "Speed up the cache")),
      }) as { id: number }
  ).id;
  for (const [i, s] of SUBS.entries())
    db.query(
      `INSERT INTO task_subtask (task, key, ord, summary, status, category, issue_json, links_json, found_json, read_at, status_at)
      VALUES ($task, $key, $ord, $summary, 'To Do', 'new', $issue, '[]', '[]', 1, 1)`,
    ).run({ task, key: s.key, ord: i + 1, summary: s.summary, issue: JSON.stringify(issue(s.key, s.summary)) });
  const branch = (i: number) => branchName("feature/", SUBS[i]?.key as string, { kind: "small", title: SUBS[i]?.summary as string });
  const insert = (ord: number, baseBranch: string, start: string) =>
    (
      db
        .query(
          `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, keys_json, start_mode, spec_dir, created_at, updated_at)
          VALUES ($task, $ord, 'single', $title, $branch, $base, 'planned', $keys, $start, $dir, 1, 1) RETURNING id`,
        )
        .get({
          task,
          ord,
          title: `Part ${NAMES[ord - 1]}`,
          branch: branch(ord - 1),
          base: baseBranch,
          keys: JSON.stringify([SUBS[ord - 1]?.key]),
          start,
          dir: `specs/${SUBS[ord - 1]?.key}/`,
        }) as { id: number }
    ).id;
  const p1 = insert(1, "main", "base");
  const p2 = insert(2, "main", "base");
  const p3 = insert(3, o.third === "stack" ? branch(0) : "main", o.third);
  if (o.third === "stack") db.query("UPDATE task_part SET after_part = $after WHERE id = $id").run({ id: p3, after: p1 });

  const t = () => taskRow(db, task) as TaskRow;
  const part = (id: number) =>
    db.query("SELECT id, ord, branch, base_commit, state FROM task_part WHERE id = $id").get({ id }) as {
      id: number;
      ord: number;
      branch: string;
      base_commit: string | null;
      state: string;
    };
  const wt = (id: number) => {
    const p = part(id);
    return openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task, ord: p.ord, branch: p.branch, base: p.base_commit ?? base });
  };
  // The Claude steps of the parts: implement runs only, by the folder of their part.
  const implementRuns = () =>
    readRecords<Call>(join(root, "calls.jsonl"))
      .filter((c) => Array.isArray(c.argv) && c.argv.includes("-p") && c.stdin.includes("- Mode: "))
      .map((c) => basename(c.cwd));
  return { root, runner, fixture, db, settings, base, task, p1, p2, p3, t, part, wt, implementRuns, app, apps };
}

describe("parts at the same time (spec.md section 6.20.6)", () => {
  test(
    "two independent parts build at once beside the review slot; a part on top of another waits; Stop ends both runs",
    async () => {
      const s = await setup({ atOnce: 3, third: "stack", scenario: HANG });
      const { jobs, loop } = s.apps[0] as { jobs: ReviewJobs; loop: TaskLoop };
      loop.build(s.db, s.task);
      // Parts 1 and 2 each wait in their tests step. Part 3 builds on part 1, so it never builds with it.
      await until(() => s.implementRuns().length === 2);
      expect(s.implementRuns().sort()).toEqual(["part-1", "part-2"]);
      const dto = taskDto(s.db, s.t());
      expect(dto.parts.map((p) => [p.ord, p.state, p.wait])).toEqual([
        [1, "implementing", null],
        [2, "implementing", null],
        [3, "planned", "Waits for a review of ABC-11."],
      ]);
      expect(dto.settings.buildsAtOnce).toBe(3);
      // The review run slot stays free: a review of a PR gets it while both parts run.
      expect(jobs.busy()).toBeNull();
      const pr = (
        s.db
          .query(
            `INSERT INTO pull_request (project, repo, pr_id, source_head, target_head) VALUES ('PROJ', 'repo', 7, $head, $head)
            RETURNING id`,
          )
          .get({ head: s.base }) as { id: number }
      ).id;
      const review = jobs.review(s.db, pr);
      expect(review.status).toBe(202);
      if ("run" in review) jobs.cancel(s.db, review.run.id);
      await Bun.sleep(100);
      expect(s.implementRuns().length).toBe(2);

      // Stop ends the runs of both parts and the task stops.
      expect(loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await loop.idle(s.task);
      await Promise.race([jobs.wait(), Bun.sleep(30_000).then(() => Promise.reject(new Error("The runs did not end.")))]);
      expect(s.t().state).toBe("stopped");
      const steps = s.db
        .query("SELECT part, state FROM task_step WHERE task = $task AND kind = 'tests' ORDER BY part")
        .all({ task: s.task }) as { part: number; state: string }[];
      expect(steps).toEqual([
        { part: s.p1, state: "cancelled" },
        { part: s.p2, state: "cancelled" },
      ]);
    },
    SLOW,
  );

  test(
    "after a crash with two parts in their build, Resume resets both worktrees and builds both again",
    async () => {
      const s = await setup({ atOnce: 2, third: "base", scenario: HANG });
      const first = s.apps[0] as { jobs: ReviewJobs; loop: TaskLoop };
      first.loop.build(s.db, s.task);
      await until(() => s.implementRuns().length === 2);
      // Part 3 waits for a place.
      expect(taskDto(s.db, s.t()).parts.find((p) => p.id === s.p3)?.wait).toBe("Waits for the build of ABC-11.");
      // Each part has changes that no commit holds.
      for (const id of [s.p1, s.p2]) writeFileSync(join((await s.wt(id)).repo, "half-done.txt"), "half\n");
      await first.jobs.stop();
      // The state that a crash leaves: the task builds, and the steps and runs still run.
      s.db.query("UPDATE task SET state = 'implementing', stopped_from = NULL, blocked_json = NULL WHERE id = $id").run({ id: s.task });
      s.db.query("UPDATE task_step SET state = 'running', ended_at = NULL WHERE task = $task AND kind = 'tests'").run({ task: s.task });
      s.db.query("UPDATE review_run SET status = 'running' WHERE task = $task").run({ task: s.task });
      const steps = s.db.query("SELECT id, part FROM task_step WHERE task = $task AND kind = 'tests'").all({ task: s.task }) as {
        id: number;
        part: number;
      }[];

      // The next start of the app: restart recovery stops the task.
      const next = s.app();
      s.apps.push(next);
      next.jobs.open();
      expect([s.t().state, s.t().stopped_from]).toEqual(["stopped", "implementing"]);
      expect([s.part(s.p1).state, s.part(s.p2).state, s.part(s.p3).state]).toEqual(["implementing", "implementing", "planned"]);

      expect(next.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await until(() => s.implementRuns().length === 4);
      expect(s.implementRuns().slice(2).sort()).toEqual(["part-1", "part-2"]);
      for (const id of [s.p1, s.p2]) {
        expect(existsSync(join((await s.wt(id)).repo, "half-done.txt"))).toBe(false);
        const step = steps.find((x) => x.part === id)?.id as number;
        const patch = patchFile(join(s.root, "data"), s.db, s.task, step);
        expect(readdirSync(dirname(patch)).some((f) => f.startsWith(`${step}`))).toBe(true);
      }
      expect(next.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await next.loop.idle(s.task);
    },
    SLOW,
  );

  test(
    "three independent parts with a limit of 2: never more than two build, and the third starts when one ends",
    async () => {
      const s = await setup({ atOnce: 2, third: "base", scenario: BUILD });
      const { loop } = s.apps[0] as { jobs: ReviewJobs; loop: TaskLoop };
      loop.build(s.db, s.task);
      await loop.idle(s.task);
      expect(s.t().blocked_json).toBeNull();
      expect(taskDto(s.db, s.t()).parts.map((p) => [p.ord, p.state])).toEqual([
        [1, "self_reviewed"],
        [2, "self_reviewed"],
        [3, "self_reviewed"],
      ]);
      // Each part built its own plan part on its own branch.
      for (const [i, id] of [s.p1, s.p2, s.p3].entries()) {
        const w = await s.wt(id);
        const log = (await git([`--git-dir=${w.admin}`, "log", "--reverse", "--format=%s", `${s.base}..HEAD`], { env: w.env }))
          .trim()
          .split("\n");
        const key = SUBS[i]?.key;
        expect(log).toEqual([
          `${key}: Add the plan`,
          `${key} P${i + 1}: Add the failing tests of part ${i + 1}`,
          `${key} T${i + 1}.1: Write ${NAMES[i]}`,
          `${key}: Fix the checks of part ${i + 1}`,
        ]);
      }
      // The time of each part from its first step to its last one. At no time do more than two parts build.
      const spans = (
        s.db
          .query("SELECT part, MIN(started_at) AS a, MAX(ended_at) AS b FROM task_step WHERE task = $task GROUP BY part ORDER BY part")
          .all({ task: s.task }) as { part: number; a: number; b: number }[]
      ).map((x) => [x.a, x.b] as const);
      for (const [a] of spans) expect(spans.filter(([x, y]) => x <= a && a < y).length).toBeLessThanOrEqual(2);
      // Part 3 starts only after part 1 or part 2 ended.
      const [one, two, three] = spans as [readonly [number, number], readonly [number, number], readonly [number, number]];
      expect(three[0]).toBeGreaterThanOrEqual(Math.min(one[1], two[1]));
    },
    SLOW,
  );

  test(
    "a green Run setup again after a red setup lets every building part go on, and the third part starts",
    async () => {
      const s = await setup({ atOnce: 2, third: "base", scenario: BUILD });
      const { loop } = s.apps[0] as { jobs: ReviewJobs; loop: TaskLoop };
      // A setup command that exits with 1 while setup-mode.txt holds "fail".
      writeFileSync(
        join(s.root, "setup.ts"),
        `import { existsSync, readFileSync } from "node:fs";\nconst m = ${JSON.stringify(join(s.root, "setup-mode.txt"))};\nprocess.exit(existsSync(m) && readFileSync(m, "utf8").trim() === "fail" ? 1 : 0);\n`,
      );
      const commands = [
        { id: "s", name: "venv", kind: "setup", argv: [process.execPath, join(s.root, "setup.ts")], timeoutSec: 60 },
        { id: "t", name: "test", kind: "test", argv: [process.execPath, join(s.root, "check.ts")], timeoutSec: 60 },
      ];
      s.db.query("UPDATE repo_task_settings SET commands_json = $c").run({ c: JSON.stringify(commands) });
      writeFileSync(join(s.root, "setup-mode.txt"), "fail");
      loop.build(s.db, s.task);
      await loop.idle(s.task);
      const b = JSON.parse(s.t().blocked_json ?? "null") as { kind: string; step: number; text: string } | null;
      expect(b?.text).toMatch(/^Needs you: the setup commands of part [12] failed\. See why\.$/);
      const parts = () => taskDto(s.db, s.t()).parts.map((p) => [p.ord, p.state]);
      expect(parts()).toEqual([
        [1, "implementing"],
        [2, "implementing"],
        [3, "planned"],
      ]);
      const red = (s.db.query("SELECT part FROM task_step WHERE id = $id").get({ id: b?.step ?? 0 }) as { part: number }).part;
      writeFileSync(join(s.root, "setup-mode.txt"), "ok");
      expect(loop.setupAgain(s.db, s.task, red, { version: s.t().version }).status).toBe(202);
      await until(() => !loop.running(s.task) && s.part(s.p3).state !== "planned", 180_000);
      await loop.idle(s.task);
      expect(s.t().blocked_json).toBeNull();
      expect(parts()).toEqual([
        [1, "self_reviewed"],
        [2, "self_reviewed"],
        [3, "self_reviewed"],
      ]);
    },
    SLOW,
  );
});
