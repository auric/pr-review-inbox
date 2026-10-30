// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.20.6 (WP-ST3, AC-B79 build part, AC-B83): the build of several parts of a task with Jira sub-tasks.
// The scheduler starts each part with its own branch, base, plan file, and files. A part on top of another part branches from its pushed
// head, and its PR targets the lower branch. A temp bare remote, the fake Bitbucket, and the fake CLI. No test starts the real CLI or
// reaches a forge or Jira. The PR opens only on the call of the route method, which stands for the user's click.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { store, taskFileDir } from "../../src/server/context/attachments";
import { createLive } from "../../src/server/live";
import { git } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createLoop } from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import { createPrOpener, subtaskPrText } from "../../src/server/tasks/pr";
import { advancePart, type TaskRow, taskDto, taskRow } from "../../src/server/tasks/tasks";
import { openWorktree } from "../../src/server/tasks/worktree";
import type { TaskDto } from "../../src/shared/dto";
import { branchName, specResult, stepStrip, type TaskBlocked } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";
import { remoteCommit } from "./update-fixture";

for (const m of ["tasks/loop", "tasks/schedule", "tasks/tasks", "tasks/pr", "tasks/repos", "tasks/implement"])
  console.log(`subparts.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 240_000;
const PARENT = "ABC-10";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const CLEAN = { summary: "Fine.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] };
const NAMES = ["one", "two", "three"];
const SUBS = [
  { key: "ABC-11", summary: "Add the event generator", file: "9011" },
  { key: "ABC-12", summary: "Flush the cache", file: "9012" },
  { key: "ABC-13", summary: "Batch the writes", file: "9013" },
];
const OLD = "feature/ABC-12-old";

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

// Plan part n builds src/<name>.ts with tests/<name>.test.ts.
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

type Call = { argv: string[]; stdin: string; context: Record<string, string>; attachments: string[] };
type Part = {
  id: number;
  ord: number;
  branch: string;
  base_branch: string;
  base_commit: string | null;
  state: string;
  head: string | null;
  pushed: string | null;
  start_mode: string | null;
  remote_pr: number | null;
};

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// A task ABC-10 with the sub-tasks ABC-11 to ABC-13, as the plan approval leaves it: part 1 (ABC-11) and part 2 (ABC-12, Continue on a
// found branch) from the base, part 3 (ABC-13) on top of part 1. The planned name of part 1 is taken on the server, and it is no found
// branch, so part 1 takes the first free suffix.
async function setup(o: { maxOpen: number }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-st3-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  const file = (path: string, text: string) => ({ writes: [{ path: `repo/${path}`, text }] });
  runner.write({
    fixture: claudeStream(root, "st3", "claude/b6-hostile-repo.jsonl"),
    seq: {
      "implement:tests": NAMES.map((n) => file(`tests/${n}.test.ts`, `test("${n}", () => {});\n`)),
      "implement:implement": NAMES.map((n) => file(`src/${n}.ts`, `export const ${n} = "todo";\n`)),
      "implement:fix": NAMES.map((n) => file(`src/${n}.ts`, `export const ${n} = "works";\n`)),
      review: [{ review: CLEAN }],
    },
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
  cleanup.unshift(async () => {
    await jobs.stop();
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

  // The parent and each sub-task list one text file.
  const meta = (id: string) => ({ id, filename: `notes-${id}.txt`, mimeType: "text/plain", size: 5, created: null });
  const issue = (key: string, summary: string, id: string) => ({
    key,
    summary,
    status: "To Do",
    description: `Do ${key}.`,
    comments: [],
    commentsTotal: 0,
    truncated: false,
    attachments: [meta(id)],
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
        settings: JSON.stringify({ branchPrefix: "feature/", existing: "continue", maxOpen: o.maxOpen }),
        issue: JSON.stringify(issue(PARENT, "Speed up the cache", "9001")),
      }) as { id: number }
  ).id;
  const found = [{ kind: "branch", name: OLD, ref: null, head: null, subjects: ["Old work"], stat: "", error: null }];
  for (const [i, s] of SUBS.entries())
    db.query(
      `INSERT INTO task_subtask (task, key, ord, summary, status, category, issue_json, links_json, found_json, read_at, status_at)
      VALUES ($task, $key, $ord, $summary, 'To Do', 'new', $issue, '[]', $found, 1, 1)`,
    ).run({
      task,
      key: s.key,
      ord: i + 1,
      summary: s.summary,
      issue: JSON.stringify(issue(s.key, s.summary, s.file)),
      found: JSON.stringify(s.key === "ABC-12" ? found : []),
    });
  for (const [id, issueKey] of [["9001", null], ...SUBS.map((s) => [s.file, s.key])] as [string, string | null][]) {
    const rel = `${taskFileDir(db, "t")}/${id}-notes.txt`;
    const made = await store(dataDir, rel, (write) => write(Buffer.from(`${id}\n`)));
    db.query(
      `INSERT INTO task_file (task, att_id, filename, mime, size, file, sha256, image, text, pdf, include, downloaded_at, issue)
      VALUES ($task, $id, $name, 'text/plain', 5, $rel, $sha, 0, 1, 0, 1, 0, $issue)`,
    ).run({ task, id, name: `notes-${id}.txt`, rel, sha: made.sha256, issue: issueKey });
  }
  const planned = (key: string, summary: string) => branchName("feature/", key, { kind: "small", title: summary });
  const insert = (ord: number, branch: string, baseBranch: string, start: string) =>
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
          branch,
          base: baseBranch,
          keys: JSON.stringify([SUBS[ord - 1]?.key]),
          start,
          dir: `specs/${SUBS[ord - 1]?.key}/`,
        }) as { id: number }
    ).id;
  const p1Name = planned("ABC-11", SUBS[0]?.summary as string);
  const p1 = insert(1, p1Name, "main", "base");
  const p2 = insert(2, OLD, "main", "base");
  const p3 = insert(3, planned("ABC-13", SUBS[2]?.summary as string), p1Name, "stack");
  db.query("UPDATE task_part SET after_part = $after WHERE id = $id").run({ id: p3, after: p1 });
  // The planned name of part 1 exists on the server. The found branch of ABC-12 has one commit.
  await r.g(["update-ref", `refs/heads/${p1Name}`, base]);
  await r.g(["update-ref", `refs/heads/${OLD}`, base]);
  const old = await remoteCommit(r, OLD, { "notes/old.md": "old work\n" }, "Old work");

  const t = () => taskRow(db, task) as TaskRow;
  const dto = (): TaskDto => taskDto(db, t());
  const part = (id: number) =>
    db
      .query("SELECT id, ord, branch, base_branch, base_commit, state, head, pushed, start_mode, remote_pr FROM task_part WHERE id = $id")
      .get({ id }) as Part;
  const build = async () => {
    loop.build(db, task);
    await loop.idle(task);
  };
  const wt = (id: number) => {
    const p = part(id);
    return openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task, ord: p.ord, branch: p.branch, base: p.base_commit ?? base });
  };
  // The subjects of a part branch since the base of the task.
  const log = async (id: number) => {
    const x = await wt(id);
    return (await git([`--git-dir=${x.admin}`, "log", "--reverse", "--format=%s", `${base}..HEAD`], { env: x.env }))
      .trim()
      .split("\n")
      .filter(Boolean);
  };
  const calls = () => readRecords<Call>(join(root, "calls.jsonl")).filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  const blocked = () => {
    const b = t().blocked_json;
    return b === null ? null : (JSON.parse(b) as TaskBlocked);
  };
  return {
    root,
    r,
    db,
    fake,
    w,
    dataDir,
    settings,
    live,
    jobs,
    loop,
    base,
    task,
    p1,
    p2,
    p3,
    p1Name,
    old,
    t,
    dto,
    part,
    build,
    wt,
    log,
    calls,
    blocked,
  };
}

describe("several parts with the scheduler (spec.md section 6.20.6)", () => {
  test(
    "AC-B79: each part gets its own branch, base, plan file, key, and files; a part on top of an approved part branches from its pushed head, and its PR targets the lower branch",
    async () => {
      const s = await setup({ maxOpen: 3 });
      expect(s.dto().strip.steps).toEqual(["Questions", "Plan", "Build sub-tasks (0 of 3)", "Done"]);
      await s.build();
      expect(s.blocked()).toBeNull();
      const after = s.dto();
      // Parts 1 and 2 built one after the other. Part 3 waits for a review of part 1, as the DTO says.
      expect(after.parts.map((p) => [p.ord, p.state, p.wait])).toEqual([
        [1, "self_reviewed", null],
        [2, "self_reviewed", null],
        [3, "planned", "Waits for a review of ABC-11."],
      ]);
      expect(after.state).toBe("implementing");

      // Part 1: the first free suffix of its planned name, from the fetched head of the base.
      const one = s.part(s.p1);
      expect([one.branch, one.base_branch, one.base_commit, one.pushed]).toEqual([`${s.p1Name}-2`, "main", s.base, null]);
      expect(await s.log(s.p1)).toEqual([
        "ABC-11: Add the plan",
        "ABC-11 P1: Add the failing tests of part 1",
        "ABC-11 T1.1: Write one",
        "ABC-11: Fix the checks of part 1",
      ]);
      // Part 2: Continue on the found branch, with its remote head as the lease.
      const two = s.part(s.p2);
      expect([two.branch, two.base_commit, two.pushed]).toEqual([OLD, s.base, s.old]);
      expect((await s.log(s.p2))[0]).toBe("Old work");
      expect((await s.log(s.p2)).slice(1)).toEqual([
        "ABC-12: Add the plan",
        "ABC-12 P2: Add the failing tests of part 2",
        "ABC-12 T2.1: Write two",
        "ABC-12: Fix the checks of part 2",
      ]);
      // Each part holds only its own plan part and map entries, in its own folder.
      const w1 = await s.wt(s.p1);
      const plan1 = readFileSync(join(w1.repo, "specs", "ABC-11", "plan.md"), "utf8");
      expect(plan1.startsWith("# Plan: ABC-11 Add the event generator\n")).toBe(true);
      expect(plan1).toContain("### [x] T1.1 Write one");
      expect(plan1).toContain("src/one.ts");
      expect(plan1).not.toContain("## Part 2");
      expect(plan1).not.toContain("src/two.ts");
      expect(existsSync(join(w1.repo, "specs", PARENT))).toBe(false);
      const plan2 = readFileSync(join((await s.wt(s.p2)).repo, "specs", "ABC-12", "plan.md"), "utf8");
      expect(plan2).toContain("## Part 2: Part two");
      expect(plan2).not.toContain("## Part 1");

      // AC-B77 in the loop: a part run gets the task files and only the files of its own sub-task.
      const byPart = (title: string) => s.calls().filter((c) => (c.context["step.md"] ?? c.context["pr.md"] ?? "").includes(title));
      for (const [title, key, own, other] of [
        ["Part one", "ABC-11", "9011", "9012"],
        ["Part two", "ABC-12", "9012", "9011"],
      ] as const) {
        const runs = byPart(title);
        expect(runs.length).toBe(4);
        for (const c of runs) {
          expect(c.attachments).toEqual(["9001.txt", key]);
          // The own review gets the sub-tasks in its task.md.
          const text = c.context["subtasks.md"] ?? c.context["task.md"] ?? "";
          expect(text).toContain(`notes-${own}.txt: 5 bytes, text/plain. Included as ./attachments/${key}/${own}.txt.`);
          expect(text).toContain(`notes-${other}.txt: 5 bytes, text/plain. Not included.`);
        }
      }
      const review = byPart("Part one").find((c) => c.context["pr.md"] !== undefined);
      expect(review?.context["pr.md"]).toContain("# ABC-11: Part one");

      // The user opens the PR of part 1, and colleagues approve it (GATE_PASSED of the sync).
      // spec.md section 6.20.9: each PR open asks for the Jira status read of the next sync cycle.
      const due: number[] = [];
      const op = createPrOpener({
        review: s.jobs,
        settings: s.settings,
        live: s.live,
        working: s.loop.running,
        syncNow: () => {},
        opened: (db, id) => {
          expect(db).toBe(s.db);
          due.push(id);
        },
      });
      const opened = await op.open(s.db, s.task, s.p1, { version: s.dto().version, reviewers: [] });
      expect(opened.status).toBe(200);
      expect(due).toEqual([s.task]);
      const pr1 = s.part(s.p1);
      expect(s.w.prs.get(pr1.remote_pr as number)?.toRef.id).toBe("refs/heads/main");
      const gate = advancePart(s.db, { task: s.task, version: s.t().version, part: s.p1 }, { type: "GATE_PASSED" }, { gate: true });
      expect(gate.status).toBe(200);
      await s.build();
      expect(s.blocked()).toBeNull();
      expect(s.dto().parts.map((p) => [p.ord, p.state, p.wait])).toEqual([
        [1, "approved", null],
        [2, "self_reviewed", null],
        [3, "self_reviewed", null],
      ]);
      // Part 3 branches from the pushed head of part 1, and its base branch is the branch of part 1.
      const three = s.part(s.p3);
      expect([three.base_branch, three.base_commit]).toEqual([pr1.branch, pr1.pushed]);
      const w3 = await s.wt(s.p3);
      const mb = (await git([`--git-dir=${w3.admin}`, "merge-base", "HEAD", pr1.pushed as string], { env: w3.env })).trim();
      expect(mb).toBe(pr1.pushed as string);
      expect((await s.log(s.p3)).slice(-4)).toEqual([
        "ABC-13: Add the plan",
        "ABC-13 P3: Add the failing tests of part 3",
        "ABC-13 T3.1: Write three",
        "ABC-13: Fix the checks of part 3",
      ]);

      // The PR of part 3 targets the branch of part 1. Its text names the parent and the PR of each part.
      const opened3 = await op.open(s.db, s.task, s.p3, { version: s.dto().version, reviewers: [] });
      expect(opened3.status).toBe(200);
      const pr3 = s.w.prs.get(s.part(s.p3).remote_pr as number);
      expect(pr3?.toRef.id).toBe(`refs/heads/${pr1.branch}`);
      expect(pr3?.fromRef.id).toBe(`refs/heads/${three.branch}`);
      expect(pr3?.title).toBe("ABC-13: Part three");
      expect(pr3?.description).toContain("The plan: specs/ABC-13/plan.md");
      expect(pr3?.description).toContain(`Parent: ${PARENT}\nABC-11: #${pr1.remote_pr} (in review) · ABC-12: next · ABC-13: this PR`);
      // The lower part asks to keep its branch until the part on top of it moves.
      const text1 = subtaskPrText(s.db, s.t(), s.p1, false);
      expect(text1?.description).toContain("Please keep this branch until ABC-13 moves to the new target.");
      expect(text1?.description).toContain(`ABC-13: #${s.part(s.p3).remote_pr} (in review)`);
      expect(subtaskPrText(s.db, s.t(), s.p2, false)?.description).not.toContain("Please keep this branch");

      // The base check of part 3 sees new commits on the branch of part 1.
      await remoteCommit(s.r, pr1.branch, { "src/extra.ts": "export const extra = 1;\n" }, "More work on part 1");
      await s.loop.checkBases(s.db, s.task);
      const bases = s.dto().parts.find((p) => p.id === s.p3)?.bases;
      expect(bases?.map((b) => [b.branch, b.newCommits])).toEqual([[pr1.branch, 1]]);
      expect(
        s
          .dto()
          .parts.find((p) => p.id === s.p2)
          ?.bases.map((b) => [b.branch, b.newCommits]),
      ).toEqual([["main", 0]]);
    },
    SLOW,
  );

  test(
    "AC-B83: a part on top of a part that changed another repository blocks before its build; Wait for the merge makes it wait",
    async () => {
      const s = await setup({ maxOpen: 3 });
      // Part 1 is approved and also changed PROJ/lib. Part 2 is dropped.
      s.db
        .query("UPDATE task_part SET state = 'approved', head = $base, pushed = $base, base_commit = $base WHERE id = $id")
        .run({ id: s.p1, base: s.base });
      s.db.query("UPDATE task_part SET state = 'abandoned' WHERE id = $id").run({ id: s.p2 });
      const lib = (
        s.db
          .query(
            `INSERT INTO task_repo (task, role, project, repo, depth, access, base_branch, proposal, created_at)
            VALUES ($task, 'added', 'PROJ', 'lib', 0, 'edit', 'main', 'added', 1) RETURNING id`,
          )
          .get({ task: s.task }) as { id: number }
      ).id;
      s.db
        .query(
          `INSERT INTO task_pr (part, task_repo, branch, base_branch, base_commit, head, pushed, state)
          VALUES ($part, $repo, $branch, 'main', $base, $base, $base, 'pr_open')`,
        )
        .run({ part: s.p1, repo: lib, branch: s.p1Name, base: s.base });
      await s.build();
      expect(s.blocked()).toEqual({
        kind: "error",
        step: null,
        part: s.p3,
        text: "Needs you: ABC-13 builds on ABC-11, which also changes PROJ/lib. Let ABC-13 wait for the merge of ABC-11.",
      });
      expect(s.part(s.p3).state).toBe("planned");
      expect(s.calls()).toEqual([]);

      const other = s.loop.waitMerge(s.db, s.task, s.p1, { version: s.t().version });
      expect(other.status).toBe(409);
      const r = s.loop.waitMerge(s.db, s.task, s.p3, { version: s.t().version });
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.blocked()).toBeNull();
      expect(s.part(s.p3).start_mode).toBe("merge");
      expect(s.dto().parts.find((p) => p.id === s.p3)?.wait).toBe("Waits for ABC-11 to merge.");
      expect(s.loop.waitMerge(s.db, s.task, s.p3, { version: s.t().version }).status).toBe(409);

      // The step strip counts the sub-tasks that are done in Jira or whose parts merged or were dropped.
      expect(s.dto().strip.steps[2]).toBe("Build sub-tasks (1 of 3)");
      s.db.query("UPDATE task_subtask SET category = 'done' WHERE task = $task AND key = 'ABC-13'").run({ task: s.task });
      s.db.query("UPDATE task_part SET state = 'merged' WHERE id = $id").run({ id: s.p1 });
      expect(s.dto().strip.steps[2]).toBe("Build sub-tasks (3 of 3)");
      // A task without sub-tasks keeps its strip.
      expect(stepStrip({ size: "small", state: "implementing", stoppedFrom: null, parts: [], subtasks: null }).steps).toEqual([
        "Questions",
        "Plan",
        "Build",
        "Done",
      ]);
    },
    SLOW,
  );
});
