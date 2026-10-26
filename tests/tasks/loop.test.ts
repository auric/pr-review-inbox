// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.2, 6.7, and 6.14 (WP-B4, AC-B10 to AC-B13, AC-B18 to AC-B20): the build loop of a small task
// part. The fake CLI writes real files in the task worktree, a bun script stands in for the approved test command, and a temp bare
// remote holds the repository. No test starts the real CLI, reaches a forge, or touches the user's clone or data folder.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { DEFAULT_PROFILE, profileOf } from "../../src/server/review/catalog";
import { git } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { cachePath, gitSetup, longPath } from "../../src/server/review/workspace";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { type StepOutcome, startStep } from "../../src/server/tasks/implement";
import {
  changedLines,
  createLoop,
  globMatch,
  LOCK_GLOBS,
  PAUSED,
  REVIEW_FIX_TRIES,
  TEST_FIX_TRIES,
  tickTask,
} from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import { pushTaskBranch, staleText } from "../../src/server/tasks/push";
import { recoverTasks, taskRow } from "../../src/server/tasks/tasks";
import { openWorktree, status } from "../../src/server/tasks/worktree";
import type { RunConflict, TaskDto } from "../../src/shared/dto";
import { specResult, type TaskBlocked } from "../../src/shared/task";
import { echoSpec, type FakeScenario, readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["tasks/loop", "tasks/implement", "tasks/tasks", "tasks/push", "tasks/worktree", "review/jobs", "review/workspace"])
  console.log(`loop.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 180_000;
const KEY = "K-1";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };

// The approved test command: a bun script in the test folder. check-mode.txt picks the result. Each run writes an ignored file, as a
// build does, and the next Claude step must still pass the path check.
const CHECK = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const mode = readFileSync(join(dir, "check-mode.txt"), "utf8").trim();
mkdirSync("ignored", { recursive: true });
writeFileSync(join("ignored", "check.log"), String(Date.now()));
appendFileSync(join(dir, "checks.log"), mode + "\\n");
if (mode === "green") { console.log("all tests pass"); process.exit(0); }
if (mode === "red") { console.log("FAIL tests/feature.test.ts"); process.exit(1); }
if (mode === "sleep") {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(dir, "check-child.pid"), String(child.pid));
  await Bun.sleep(120000);
  process.exit(0);
}
const ok = existsSync("src/feature.ts") && readFileSync("src/feature.ts", "utf8").includes("works");
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
// The fix after a review point keeps line 1, so the point still anchors there.
const FIXED = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const checked = true;\n" };

const review = (findings: unknown[]) => ({
  summary: "The feature is small.",
  risks: [],
  questions: [],
  coverage: { read: ["src/feature.ts"], skipped: [], unavailable: [], notChecked: [] },
  findings,
});
const point = (severity: string) => ({
  path: "src/feature.ts",
  side: "new",
  line: 1,
  lineEnd: null,
  anchorText: "export const feature = 'works';",
  severity,
  category: "Correctness",
  body: `A ${severity} point in the feature.`,
  evidence: "`feature` is a fixed string.",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  trigger: "A caller reads `feature` and gets a fixed string where it needs a computed value.",
});
const CLEAN = review([]);

type Call = { argv: string[]; cwd: string; stdin: string; context: Record<string, string> };
type Step = { id: number; kind: string; state: string; item: string | null; attempt: number; run: number | null; detail_json: string };

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Setup = {
  seq?: FakeScenario["seq"];
  mode?: string;
  budget?: number;
  testGlobs?: string[] | null;
  settings?: Record<string, unknown>;
  spec?: typeof SPEC;
  // The approved test command. Default: the bun script CHECK.
  argv?: string[];
};

async function setup(o: Setup = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-wpb4-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  const stream = claudeStream(root, "loop", "claude/b6-hostile-repo.jsonl");
  const scenario = (s: Omit<FakeScenario, "record" | "auth" | "fixture"> = {}) => runner.write({ fixture: stream, ...s });
  scenario({
    seq: {
      "implement:tests": [{ writes: [TEST_FILE] }],
      "implement:implement": [{ writes: [TODO] }],
      "implement:fix": [{ writes: [WORKS] }],
      review: [{ review: CLEAN }],
      ...o.seq,
    },
  });
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: "http://127.0.0.1:9", userSlug: "u", notifications: false });
  const settings = createSettings({ dir: dataDir, secrets: createSecrets(null), jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const events: { event: string; data: unknown }[] = [];
  const broadcast = live.broadcast;
  live.broadcast = (event, data) => {
    events.push({ event, data });
    broadcast(event, data);
  };
  const jobs = createReviewJobs({
    settings,
    live,
    dataDir,
    runnerCommand: runner.command,
    repoRemote: async () => ({ url: r.remote, config: [] }),
    listTools: stubListTools,
  });
  // The first open runs the restart recovery, so it comes before the task rows.
  const db = jobs.open() as Database;
  const loop = createLoop({ review: jobs, settings, live });
  jobs.onStop(() => loop.shutdown());
  cleanup.unshift(async () => {
    await jobs.stop();
    db.close();
  });
  const { base } = await taskCache(dataDir, r.remote);
  // The commit identity comes from the user's clone config. This clone is a temp repository with its own identity.
  const clone = join(root, "clone");
  await git(["init", "-q", clone], { env: r.env });
  await git(["-C", clone, "config", "user.name", "Ada Example"], { env: r.env });
  await git(["-C", clone, "config", "user.email", "ada@example.invalid"], { env: r.env });
  db.query("INSERT INTO repo_clone (project, repo, path, updated_at) VALUES ('PROJ', 'repo', $path, 0)").run({ path: clone });
  writeFileSync(join(root, "check.ts"), CHECK);
  const mode = (m: string) => writeFileSync(join(root, "check-mode.txt"), m);
  mode(o.mode ?? "feature");
  const commands = [{ id: "t", name: "test", kind: "test", argv: o.argv ?? [process.execPath, join(root, "check.ts")], timeoutSec: 60 }];
  db.query(
    `INSERT INTO repo_task_settings (project, repo, commands_json, line_budget, test_globs_json, warned_at, updated_at)
    VALUES ('PROJ', 'repo', $commands, $budget, $globs, 1, 1)`,
  ).run({
    commands: JSON.stringify(commands),
    budget: o.budget ?? 400,
    globs: o.testGlobs === undefined || o.testGlobs === null ? null : JSON.stringify(o.testGlobs),
  });
  const addTask = (key: string, title: string) => {
    const plan = toPlan(o.spec ?? SPEC, base, [false], []);
    const docs = { ...renderDocs(key, title, "small", plan), version: 1, parsed: plan, approved: true };
    const now = Date.now();
    return (
      db
        .query(
          `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
            settings_json, created_at, updated_at)
          VALUES ('PROJ', 'repo', $key, $title, 'implementing', 'small', 'claude', 'main', $base, $dir, $docs, $estimate, $settings, $now, $now)
          RETURNING id`,
        )
        .get({
          key,
          title,
          base,
          dir: `specs/${key}/`,
          docs: JSON.stringify(docs),
          estimate: JSON.stringify(plan.estimate),
          settings: JSON.stringify(o.settings ?? {}),
          now,
        }) as { id: number }
    ).id;
  };
  const task = addTask(KEY, "Add the feature");
  const record = join(root, "calls.jsonl");
  const runCalls = () => readRecords<Call>(record).filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  const modeOf = (c: Call) => /^- Mode: (\w+)$/m.exec(c.stdin)?.[1] ?? (c.argv.join(" ").includes('"verdicts"') ? "verify" : "review");
  const steps = (id = task) =>
    db.query("SELECT id, kind, state, item, attempt, run, detail_json FROM task_step WHERE task = $id ORDER BY id").all({ id }) as Step[];
  const flow = (id = task) => steps(id).map((s) => `${s.kind}:${s.item ?? "-"}:${s.state}`);
  const part = (id = task) =>
    db.query("SELECT id, ord, branch, state, head, lines FROM task_part WHERE task = $id").get({ id }) as {
      id: number;
      ord: number;
      branch: string;
      state: string;
      head: string | null;
      lines: number | null;
    };
  const t = (id = task) => taskRow(db, id) as NonNullable<ReturnType<typeof taskRow>>;
  const blocked = (id = task) => {
    const b = t(id).blocked_json;
    return b === null ? null : (JSON.parse(b) as TaskBlocked);
  };
  const build = async (id = task) => {
    loop.build(db, id);
    await loop.idle(id);
  };
  const wt = async (id = task) => {
    const p = part(id);
    return openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task: id, ord: p.ord, branch: p.branch, base });
  };
  // The commits of the part branch, oldest first: author and subject.
  const log = async (id = task) => {
    const w = await wt(id);
    const out = await git([`--git-dir=${w.admin}`, "log", "--reverse", "--format=%an <%ae>|%s", `${base}..HEAD`], { env: w.env });
    return out.trim().split("\n").filter(Boolean);
  };
  return {
    root,
    r,
    db,
    dataDir,
    settings,
    jobs,
    loop,
    live,
    events,
    base,
    task,
    addTask,
    scenario,
    mode,
    runCalls,
    modeOf,
    steps,
    flow,
    part,
    t,
    blocked,
    build,
    wt,
    log,
    clone,
  };
}

const until = async (f: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(25);
  }
};

describe("the loop of one part (spec.md section 6.7)", () => {
  test(
    "red then green: the plan commit, the failing tests, the implement step, the tick, the full checks with one fix, the own review, and a ready part",
    async () => {
      const s = await setup();
      await s.build();
      expect(s.blocked()).toBeNull();
      expect(s.t().state).toBe("implementing");
      expect(s.part().state).toBe("self_reviewed");
      // The bun script is no runner that the app can narrow, so the scoped check of T1.1 skips, and the full checks gate the part.
      expect(s.flow()).toEqual([
        "commit:plan:ok",
        "tests:P1:ok",
        "check:P1:failed",
        "commit:P1:ok",
        "implement:T1.1:ok",
        "check:T1.1:skipped",
        "commit:T1.1:ok",
        "check:checks:failed",
        "fix:checks:ok",
        "check:checks:ok",
        "commit:checks:ok",
        "review:review:ok",
      ]);
      const skipped = s.steps().find((x) => x.kind === "check" && x.item === "T1.1") as Step;
      expect(JSON.parse(skipped.detail_json)).toMatchObject({ commands: [], notes: [expect.stringContaining('"bun test"')] });
      expect(s.runCalls().map(s.modeOf)).toEqual(["tests", "implement", "fix", "review"]);
      // One commit per step, with the user's name and email, and the tick in the commit that finishes the task.
      expect(await s.log()).toEqual([
        `Ada Example <ada@example.invalid>|${KEY}: Add the plan`,
        `Ada Example <ada@example.invalid>|${KEY} P1: Add the failing tests of part 1`,
        `Ada Example <ada@example.invalid>|${KEY} T1.1: Write the feature`,
        `Ada Example <ada@example.invalid>|${KEY}: Fix the checks of part 1`,
      ]);
      const w = await s.wt();
      expect(readFileSync(join(w.repo, "specs", KEY, "plan.md"), "utf8")).toContain("### [x] T1.1 Write the feature");
      expect(readFileSync(join(w.repo, "src", "feature.ts"), "utf8")).toContain("works");
      expect(await status(w)).toEqual([]);
      // The check output of the red run is in the step row (the Log tab) and in failure.md of the fix step.
      const red = s.steps().find((x) => x.kind === "check" && x.item === "checks" && x.state === "failed") as Step;
      const cmd = (JSON.parse(red.detail_json) as { commands: { exit: number; tail: string; argv: string[] }[] }).commands[0];
      expect(cmd?.exit).toBe(1);
      expect(cmd?.tail).toContain("FAIL: src/feature.ts does not work yet");
      const fix = s.runCalls()[2] as Call;
      expect(fix.context["step.md"] ?? "").toContain("- Task: fix the failed checks of the whole part in ./context/failure.md.");
      // The own review: kind review, task set, pr NULL, base..head of the part, the finder and the verify phase.
      const run = s.db
        .query("SELECT kind, pr, task, status, source_head, merge_base FROM review_run WHERE kind = 'review'")
        .get() as Record<string, unknown>;
      expect(run).toEqual({ kind: "review", pr: null, task: s.task, status: "completed", source_head: s.part().head, merge_base: s.base });
      const reviewCall = s.runCalls()[3] as Call;
      expect(reviewCall.stdin).toContain(`Review the change ${s.base}..${s.part().head} in ./repo.`);
      expect(reviewCall.stdin).toContain(`- Pull request: none yet. The app builds this change for task ${KEY}`);
      expect(reviewCall.argv).toContain("--restricted");
      expect(reviewCall.argv[reviewCall.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      expect(reviewCall.context["task.md"] ?? "").toContain("# The plan of the task");
      expect(reviewCall.context["pr.md"] ?? "").toContain(`# ${KEY}: Add the feature`);
      // The part lines: plan.md, the test, and the feature, against the budget.
      expect(s.part().lines).toBeGreaterThan(0);
      expect(s.part().lines).toBe((await changedLines(w, s.base, s.part().head as string, LOCK_GLOBS)).lines);
      // Live events for the UI.
      expect(s.events.some((e) => e.event === "changed" && JSON.stringify(e.data).includes(`"tasks":[${s.task}]`))).toBe(true);
    },
    SLOW,
  );

  test(
    "scoped checks: task 1 passes its Run line while the test of task 2 is still red; the full approved command runs at the part end",
    async () => {
      const unit = (n: string) => ({
        path: `repo/tests/${n}.test.ts`,
        text: `import { expect, test } from "bun:test";\nimport { ${n} } from "../src/${n}";\ntest("${n} works", () => expect(${n}).toBe("${n}"));\n`,
      });
      const code = (n: string) => ({ path: `repo/src/${n}.ts`, text: `export const ${n} = "${n}";\n` });
      const task = (n: string) => ({ id: n, title: `Write ${n}`, files: [`src/${n}.ts`], run: [`tests/${n}.test.ts`], done: "It passes." });
      const spec = specResult.parse({
        ...SPEC,
        parts: [
          {
            ...SPEC.parts[0],
            tests: [
              { test: "tests/one.test.ts", proves: ["A1"] },
              { test: "tests/two.test.ts", proves: ["A1"] },
            ],
            tasks: [task("one"), task("two")],
          },
        ],
      });
      const s = await setup({
        spec,
        argv: [process.execPath, "test"],
        seq: {
          "implement:tests": [{ writes: [unit("one"), unit("two")] }],
          "implement:implement": [{ writes: [code("one")] }, { writes: [code("two")] }],
        },
      });
      await s.build();
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      expect(s.flow()).toEqual([
        "commit:plan:ok",
        "tests:P1:ok",
        "check:P1:failed",
        "commit:P1:ok",
        "implement:T1.1:ok",
        "check:T1.1:ok",
        "commit:T1.1:ok",
        "implement:T1.2:ok",
        "check:T1.2:ok",
        "commit:T1.2:ok",
        "check:checks:ok",
        "review:review:ok",
      ]);
      // No fix step: the red test of T1.2 never gated T1.1.
      expect(s.runCalls().map(s.modeOf)).toEqual(["tests", "implement", "implement", "review"]);
      const argv = (item: string) =>
        s
          .steps()
          .filter((x) => x.kind === "check" && x.item === item)
          .map((x) => (JSON.parse(x.detail_json) as { commands: { argv: string[] }[] }).commands.map((c) => c.argv));
      expect(argv("T1.1")).toEqual([[[process.execPath, "test", "./tests/one.test.ts"]]]);
      expect(argv("T1.2")).toEqual([[[process.execPath, "test", "./tests/two.test.ts"]]]);
      expect(argv("checks")).toEqual([[[process.execPath, "test"]]]);
      // The red-first check of the tests step ran the full command, and both new tests failed there.
      const red = s.steps().find((x) => x.kind === "check" && x.item === "P1") as Step;
      expect(JSON.parse(red.detail_json).commands[0].argv).toEqual([process.execPath, "test"]);
      // Only that check expects red. The Log tab says "Red as expected" for it.
      const expectRed = s
        .steps()
        .filter((x) => x.kind === "check")
        .map((x) => [x.item, JSON.parse(x.detail_json).expectRed]);
      expect(expectRed).toEqual([
        ["P1", true],
        ["T1.1", false],
        ["T1.2", false],
        ["checks", false],
      ]);
    },
    SLOW,
  );

  test(
    "AC-B11: red three times, then blocked red; every command keeps its exit code and output tail",
    async () => {
      const s = await setup({ mode: "red" });
      await s.build();
      const fixes = s.steps().filter((x) => x.kind === "fix");
      expect(fixes.length).toBe(TEST_FIX_TRIES);
      expect(fixes.map((x) => x.attempt)).toEqual([1, 2, 3]);
      expect(TEST_FIX_TRIES).toBe(3);
      const b = s.blocked();
      expect(b?.kind).toBe("red");
      expect(b?.text).toBe("Needs you: the tests of part 1 stay red after 3 tries.");
      const checks = s.steps().filter((x) => x.kind === "check" && x.item === "checks");
      expect(checks.length).toBe(4);
      for (const c of checks) {
        const cmd = (JSON.parse(c.detail_json) as { commands: { exit: number; tail: string }[] }).commands[0];
        expect([cmd?.exit, cmd?.tail.includes("FAIL tests/feature.test.ts")]).toEqual([1, true]);
      }
      expect(b?.step).toBe((checks.at(-1) as Step).id);
      expect(s.t().state).toBe("implementing");
      expect(s.part().state).toBe("implementing");
      expect(s.steps().some((x) => x.kind === "review")).toBe(false);
    },
    SLOW,
  );

  test(
    'AC-B10: a green check after the tests step blocks with "Tests pass before the change. See why."',
    async () => {
      const s = await setup({ mode: "green" });
      await s.build();
      expect(s.blocked()).toMatchObject({ kind: "red", text: "Tests pass before the change. See why." });
      expect(s.flow()).toEqual(["commit:plan:ok", "tests:P1:ok", "check:P1:ok"]);
      expect(s.runCalls().map(s.modeOf)).toEqual(["tests"]);
    },
    SLOW,
  );

  test(
    "the tests step may change only test files: a change outside the test paths retries once with the reason, then blocks",
    async () => {
      const s = await setup({ seq: { "implement:tests": [{ writes: [TEST_FILE, WORKS] }] } });
      await s.build();
      expect(s.flow()).toEqual(["commit:plan:ok", "tests:P1:ok", "tests:P1:ok"]);
      expect(s.blocked()).toMatchObject({
        kind: "red",
        text: "Needs you: the tests step of part 1 failed twice. The step changed files that are not tests: src/feature.ts.",
      });
      const second = s.runCalls()[1] as Call;
      const failure = second.context["failure.md"] ?? "";
      expect(failure).toStartWith("# UNTRUSTED DATA");
      expect(failure).toContain("The test paths are the tests of the plan: tests/feature.test.ts");
      // The first try left a patch, and the retry started from the last commit.
      const first = s.steps()[1] as Step;
      const patches = readFileSync(join(second.cwd, "..", "patches", `${first.id}.patch`), "utf8");
      expect(patches).toContain("diff --git a/src/feature.ts b/src/feature.ts");
      // A test glob of the repository allows a fixture file next to the test.
      const g = await setup({
        testGlobs: ["tests/"],
        seq: { "implement:tests": [{ writes: [TEST_FILE, { path: "repo/tests/data/input.json", text: "{}\n" }] }] },
        mode: "red",
      });
      await g.build();
      expect(g.flow().slice(0, 4)).toEqual(["commit:plan:ok", "tests:P1:ok", "check:P1:failed", "commit:P1:ok"]);
    },
    SLOW * 2,
  );

  test(
    "AC-B12: a confirmed major point starts one fix step, the checks, and a new review; then the part is ready",
    async () => {
      const s = await setup({
        seq: {
          "implement:implement": [{ writes: [WORKS] }],
          "implement:fix": [{ writes: [FIXED] }],
          review: [{ review: review([point("major")]) }, { review: CLEAN }],
        },
      });
      await s.build();
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      expect(s.flow().slice(-7)).toEqual([
        "commit:T1.1:ok",
        "check:checks:ok",
        "review:review:ok",
        "fix:review:ok",
        "check:review:ok",
        "commit:review:ok",
        "review:review:ok",
      ]);
      expect(s.runCalls().map(s.modeOf)).toEqual(["tests", "implement", "review", "verify", "fix", "review"]);
      // The fix step gets the confirmed point with path:line in failure.md.
      const fix = s.runCalls()[4] as Call;
      const failure = fix.context["failure.md"] ?? "";
      expect(failure).toContain(": major at src/feature.ts:1");
      expect(fix.context["step.md"] ?? "").toContain("- Task: fix the points of the review in ./context/failure.md.");
      const firstReview = s.steps().find((x) => x.kind === "review") as Step;
      const detail = JSON.parse(firstReview.detail_json) as { findings: number[] };
      expect(detail.findings.length).toBe(1);
      const item = s.db.query("SELECT payload_json FROM review_item WHERE id = $id").get({ id: detail.findings[0] ?? 0 }) as {
        payload_json: string;
      };
      expect(JSON.parse(item.payload_json).verify.verdict).toBe("confirmed");
      expect((await s.log()).at(-1)).toBe(`Ada Example <ada@example.invalid>|${KEY}: Fix the review points of part 1`);
    },
    SLOW,
  );

  test(
    "AC-B12: a blocker that stays after two fixes blocks with blocker",
    async () => {
      const s = await setup({
        seq: {
          "implement:implement": [{ writes: [WORKS] }],
          "implement:fix": [{ writes: [FIXED] }],
          review: [{ review: review([point("blocker")]) }],
        },
      });
      await s.build();
      expect(s.steps().filter((x) => x.kind === "review").length).toBe(REVIEW_FIX_TRIES + 1);
      expect(s.steps().filter((x) => x.kind === "fix" && x.item === "review").length).toBe(REVIEW_FIX_TRIES);
      expect(s.blocked()).toMatchObject({
        kind: "blocker",
        text: "Needs you: Claude's review of part 1 still finds 1 point to fix after 2 fixes.",
      });
      expect(s.part().state).toBe("implementing");
    },
    SLOW,
  );

  test(
    "AC-B13: a part over the line budget blocks before its PR with the line count",
    async () => {
      const big = { path: "repo/src/feature.ts", text: `export const feature = 'works';\n${"// line\n".repeat(450)}` };
      const s = await setup({ seq: { "implement:implement": [{ writes: [big] }] } });
      await s.build();
      const b = s.blocked();
      expect(b?.kind).toBe("size");
      const lines = s.part().lines as number;
      expect(lines).toBeGreaterThan(400);
      expect(b?.text).toBe(`Needs you: this PR would have ${lines} changed lines, over your 400 limit.`);
      const size = s.steps().find((x) => x.kind === "size") as Step;
      expect(b?.step).toBe(size.id);
      expect(JSON.parse(size.detail_json).diffStat.lines).toBe(lines);
      expect(s.steps().some((x) => x.kind === "review")).toBe(false);
      // Resume with the same limit blocks again before any step: the part never grows silently.
      const before = s.steps().length;
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.blocked()?.kind).toBe("size");
      expect(s.steps().length).toBe(before + 1);
    },
    SLOW,
  );

  test(
    "AC-B18: a review start during a task step gets 409 with the pause line; a step that finds the slot busy waits and then continues",
    async () => {
      const s = await setup({
        seq: { "implement:implement": [{ delayMs: 400, writes: [] }, { writes: [WORKS] }] },
      });
      // Task K-2 holds the run slot with a slow step.
      const other = s.addTask("K-2", "Other");
      const now = Date.now();
      const p2 = (
        s.db
          .query(
            `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
            VALUES ($task, 1, 'single', 'Other', 'feature/K-2-other', 'main', 'implementing', $now, $now) RETURNING id`,
          )
          .get({ task: other, now }) as { id: number }
      ).id;
      const w2 = await openWorktree({
        dataDir: s.dataDir,
        db: s.db,
        project: "PROJ",
        repo: "repo",
        task: other,
        ord: 1,
        branch: "feature/K-2-other",
        base: s.base,
      });
      let ended: StepOutcome | null = null;
      const held = await startStep({
        db: s.db,
        review: s.jobs,
        task: other,
        part: { id: p2, ord: 1 },
        wt: w2,
        mode: "implement",
        item: "T1.1",
        attempt: 1,
        profile: profileOf(s.settings.profiles(), DEFAULT_PROFILE),
        untrusted: [],
        own: [{ name: "step.md", text: "# Step\n" }],
        allow: [],
        specDir: "specs/K-2/",
        onEnd: (x) => {
          ended = x;
        },
      });
      expect(held.status).toBe(202);
      // A user review start while the task step runs.
      const { id: pr } = s.db
        .query(
          `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
            source_branch, target_branch, updated_date, on_dashboard, followed)
          VALUES ('PROJ', 'repo', 12, 'PR', '', 'a', 'A', 'REVIEWER', 'OPEN', $h, $h, 'f', 'main', 1, 1, 1) RETURNING id`,
        )
        .get({ h: s.base }) as { id: number };
      const start = s.jobs.review(s.db, pr) as { status: number; conflict?: RunConflict };
      expect(start.status).toBe(409);
      expect(start.conflict?.error).toBe("Claude is building K-2. Pause building after this step to start your run.");
      expect(start.conflict?.running).toMatchObject({ pr: null, kind: "implement", task: other });
      // The loop of K-1 finds the slot busy: its step waits, and the reason names the holder.
      s.loop.build(s.db, s.task);
      await until(() => s.blocked()?.kind === "slot");
      expect(s.blocked()?.text).toBe("Waiting for the build of K-2 to free the run slot.");
      const waiting = s.steps().find((x) => x.state === "waiting") as Step;
      expect([waiting.kind, waiting.item, waiting.run]).toEqual(["tests", "P1", null]);
      await s.loop.idle(s.task);
      expect(ended).not.toBeNull();
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      // The waiting row became the running step of the run.
      const row = s.steps().find((x) => x.id === waiting.id) as Step;
      expect([row.state, row.run !== null]).toEqual(["ok", true]);
    },
    SLOW,
  );

  test(
    "AC-B19: Stop during a check kills the process tree; Resume starts the stopped step again from the last commit with the patch saved",
    async () => {
      const s = await setup({ mode: "sleep" });
      s.loop.build(s.db, s.task);
      const pidFile = join(s.root, "check-child.pid");
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
      const child = Number(readFileSync(pidFile, "utf8"));
      const t0 = Date.now();
      const stopped = s.loop.stop(s.db, s.task, { version: s.t().version });
      expect(stopped.status).toBe(200);
      await s.loop.idle(s.task);
      expect(Date.now() - t0).toBeLessThan(30_000);
      const alive = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      const end = Date.now() + 10_000;
      while (alive() && Date.now() < end) await Bun.sleep(50);
      expect(alive()).toBe(false);
      expect([s.t().state, s.t().stopped_from, s.blocked()]).toEqual(["stopped", "implementing", null]);
      const check = s.steps().at(-1) as Step;
      expect([check.kind, check.state]).toEqual(["check", "cancelled"]);
      const cmd = (JSON.parse(check.detail_json) as { commands: { exit: number | null; tail: string }[] }).commands[0];
      expect(cmd?.exit).toBeNull();
      expect(cmd?.tail).toContain("[The app stopped the command.]");
      // The tests of the stopped step are not committed yet.
      expect((await status(await s.wt())).map((e) => e.path)).toEqual(["tests/feature.test.ts"]);
      s.mode("feature");
      const resumed = s.loop.resume(s.db, s.task, { version: s.t().version });
      expect([resumed.status, (resumed as { task: TaskDto }).task.state]).toEqual([200, "implementing"]);
      await s.loop.idle(s.task);
      const patch = join((await s.wt()).dir, "..", "patches", `${check.id}.patch`);
      expect(readFileSync(patch, "utf8")).toContain("diff --git a/tests/feature.test.ts b/tests/feature.test.ts");
      const tests = s.steps().filter((x) => x.kind === "tests");
      expect(tests.map((x) => x.attempt)).toEqual([1, 2]);
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );

  test(
    "AC-B20: a change of a plan file blocks with spec_change; Reject resets the step, and the step runs again",
    async () => {
      const plan = { path: `repo/specs/${KEY}/plan.md`, text: "# Plan: changed\n" };
      const s = await setup({
        seq: {
          "implement:implement": [
            {
              writes: [WORKS, plan],
              implement: {
                summary: "s",
                done: false,
                tests: [],
                question: null,
                specChange: "The plan names the wrong file.",
                notes: [],
                coverage: NO_COVERAGE,
              },
            },
            { writes: [WORKS] },
          ],
        },
      });
      await s.build();
      const b = s.blocked();
      expect(b).toMatchObject({ kind: "spec_change", text: "Needs you: Claude proposes a change to the spec." });
      const row = s.steps().find((x) => x.id === b?.step) as Step;
      expect(row.kind).toBe("spec_change");
      expect(JSON.parse(row.detail_json)).toMatchObject({
        specChange: { paths: [`specs/${KEY}/plan.md`] },
        notes: ["The plan names the wrong file."],
      });
      // The proposal stays in the worktree for "Review the change".
      expect((await status(await s.wt())).map((e) => e.path).sort()).toEqual(["specs/K-1/plan.md", "src/feature.ts"]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(409);
      const wrong = await s.loop.specChange(s.db, s.task, (b?.step as number) + 1, { version: s.t().version, accept: false });
      expect(wrong.status).toBe(409);
      const r = await s.loop.specChange(s.db, s.task, b?.step as number, { version: s.t().version, accept: false });
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      expect(JSON.parse((s.steps().find((x) => x.id === b?.step) as Step).detail_json).notes).toContain("The user rejected the change.");
      expect(s.part().state).toBe("self_reviewed");
      const w = await s.wt();
      expect(readFileSync(join(w.repo, "specs", KEY, "plan.md"), "utf8")).toContain("### [x] T1.1");
      expect(
        s
          .steps()
          .filter((x) => x.kind === "implement")
          .map((x) => x.attempt),
      ).toEqual([1, 2]);
    },
    SLOW,
  );

  test(
    "a plan change that the user accepts is committed, and the build goes on from it",
    async () => {
      const s = await setup({
        mode: "green",
        seq: {
          "implement:tests": [{ writes: [TEST_FILE, { path: `repo/specs/${KEY}/notes.md`, text: "A note.\n" }] }],
        },
      });
      await s.build();
      const b = s.blocked();
      expect(b?.kind).toBe("spec_change");
      const r = await s.loop.specChange(s.db, s.task, b?.step as number, { version: s.t().version, accept: true });
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      expect((await s.log()).at(1)).toBe(`Ada Example <ada@example.invalid>|${KEY} P1: Change the plan`);
      const w = await s.wt();
      const files = await git([`--git-dir=${w.admin}`, "show", "--name-only", "--format=", "HEAD~0"], { env: w.env });
      // The commit holds the plan files only. The tests step starts again under the new plan, and the green check blocks it.
      expect(files.trim().split("\n")).toEqual([`specs/${KEY}/notes.md`]);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "tests")
          .map((x) => x.attempt),
      ).toEqual([1, 2]);
      expect(s.blocked()?.text).toBe("Tests pass before the change. See why.");
    },
    SLOW,
  );

  test(
    "a question of Claude blocks with the question; the answer starts the step again from the last commit with answers.md",
    async () => {
      const ask = {
        summary: "s",
        done: false,
        tests: [],
        question: {
          text: "Keep the old name?",
          why: "Callers use it.",
          options: [
            { label: "Keep", detail: "No change for callers." },
            { label: "Rename", detail: "Clearer." },
          ],
          recommended: 0,
        },
        specChange: "",
        notes: [],
        coverage: NO_COVERAGE,
      };
      const s = await setup({ seq: { "implement:implement": [{ writes: [TODO], implement: ask }, { writes: [WORKS] }] } });
      await s.build();
      const b = s.blocked();
      expect(b).toMatchObject({ kind: "question", text: "Needs you: Claude asks: Keep the old name?" });
      const q = s.db.query("SELECT id, source, kind, recommended, step FROM task_question WHERE task = $t").get({ t: s.task }) as Record<
        string,
        unknown
      >;
      expect(q).toMatchObject({ source: "loop", kind: "choice", recommended: 0, step: b?.step });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(409);
      const a = s.loop.answer(s.db, s.task, { version: s.t().version, answers: [{ question: q.id as number, choice: 1 }] });
      expect(a.status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const again = s.runCalls().filter((c) => s.modeOf(c) === "implement")[1] as Call;
      const answers = again.context["answers.md"] ?? "";
      expect(answers).toContain("Keep the old name?");
      expect(answers).toContain("- Answer: Rename. Clearer.");
      expect(again.context["step.md"] ?? "").toContain("- Attempt: 2");
    },
    SLOW,
  );

  test(
    "Pause after this step: the loop holds before it takes the run slot again and keeps the step's work; Resume goes on",
    async () => {
      const s = await setup({
        seq: { "implement:tests": [{ delayMs: 60, writes: [TEST_FILE] }], "implement:implement": [{ writes: [WORKS] }] },
      });
      s.loop.build(s.db, s.task);
      await until(() => s.steps().some((x) => x.kind === "tests" && x.state === "running"));
      expect(s.loop.pause(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await until(() => s.blocked()?.text === PAUSED);
      expect(s.blocked()).toEqual({ kind: "question", step: null, text: PAUSED });
      // The slot is free for the user's run. The tests step committed its work before the pause.
      expect(s.jobs.busy()).toBeNull();
      expect(s.flow()).toEqual(["commit:plan:ok", "tests:P1:ok", "check:P1:failed", "commit:P1:ok"]);
      expect(s.loop.running(s.task)).toBe(true);
      const r = s.loop.resume(s.db, s.task, { version: s.t().version });
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      // A pause with no build gets 409.
      expect(s.loop.pause(s.db, s.task, { version: s.t().version }).status).toBe(409);
    },
    SLOW,
  );

  test(
    "pauseAfterTask: the loop asks to continue after each task commit; Resume goes on with no reset",
    async () => {
      const s = await setup({ settings: { pauseAfterTask: true }, seq: { "implement:implement": [{ writes: [WORKS] }] } });
      await s.build();
      expect(s.blocked()).toEqual({ kind: "question", step: null, text: "Task T1.1 is done. Continue?" });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );

  test(
    "a used-up part time blocks with budget; Resume continues with 60 more minutes",
    async () => {
      const s = await setup({ seq: { "implement:implement": [{ writes: [WORKS] }] } });
      // The part exists and used 121 minutes of Claude time in earlier steps.
      const now = Date.now();
      const p = (
        s.db
          .query(
            `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
            VALUES ($t, 1, 'single', 'Add the feature', 'feature/K-1-add-the-feature', 'main', 'implementing', $now, $now) RETURNING id`,
          )
          .get({ t: s.task, now }) as { id: number }
      ).id;
      s.db
        .query("INSERT INTO task_step (task, part, kind, state, ord, started_at, ended_at) VALUES ($t, $p, 'implement', 'ok', 99, $a, $b)")
        .run({ t: s.task, p, a: now - 121 * 60_000, b: now });
      await s.build();
      expect(s.blocked()).toEqual({ kind: "budget", step: null, text: "Needs you: part 1 used its 120 min. Continue with 60 more min?" });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      expect(JSON.parse(s.t().settings_json)).toEqual({ partTimeMin: 180 });
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );

  test(
    "a denied path of a step blocks with denied_path; Resume starts the step again from the last commit",
    async () => {
      const s = await setup({
        seq: { "implement:implement": [{ writes: [WORKS, { path: "repo/CLAUDE.md", text: "planted\n" }] }, { writes: [WORKS] }] },
      });
      await s.build();
      expect(s.blocked()?.kind).toBe("denied_path");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );
});

describe("an existing branch on the server (spec.md section 6.16.4)", () => {
  // push.ts takes a Jira key with two or more letters before the hyphen.
  const PUSH_KEY = "AB-1";
  const NAME = `feature/${PUSH_KEY}-add-the-feature`;
  // A colleague commit on the remote branch NAME, on top of base.
  const colleague = async (s: Awaited<ReturnType<typeof setup>>, parent: string, msg: string) => {
    const c = await s.r.g(["commit-tree", `${parent}^{tree}`, "-p", parent, "-m", msg]);
    await s.r.g(["update-ref", `refs/heads/${NAME}`, c]);
    return c;
  };

  test(
    "AC-B31: Continue builds on the fetched remote head and leases the first push on it; a push after a colleague push fails the lease",
    async () => {
      const s = await setup();
      const id = s.addTask(PUSH_KEY, "Add the feature");
      const remoteHead = await colleague(s, s.base, "colleague");
      await s.build(id);
      expect(s.part(id).state).toBe("self_reviewed");
      expect(s.part(id).branch).toBe(NAME);
      const row = s.db.query("SELECT pushed FROM task_part WHERE id = $id").get({ id: s.part(id).id }) as { pushed: string | null };
      expect(row.pushed).toBe(remoteHead);
      // base_commit: the merge base of the base head and the remote head, so the budget counts the whole PR diff.
      expect(s.t(id).base_commit).toBe(s.base);
      const dataDir = longPath(s.dataDir);
      const cache = cachePath(dataDir, { project: "PROJ", repo: "repo", id });
      const head = s.part(id).head as string;
      const { env, empty } = gitSetup(dataDir);
      await git([`--git-dir=${cache}`, "merge-base", "--is-ancestor", remoteHead, head], { env });

      const argv: string[][] = [];
      const spy: typeof git = (args, o) => {
        argv.push(args);
        return git(args, o);
      };
      const push = () =>
        pushTaskBranch({
          cache,
          emptyGlobal: empty,
          url: s.r.remote,
          config: [],
          commit: head,
          branch: NAME,
          lease: row.pushed,
          task: { key: PUSH_KEY, prefix: "feature/", branches: [NAME], target: "main" },
          git: spy,
        });
      // A colleague pushed after the fetch: the lease fails, and the remote keeps the colleague commit.
      const moved = await colleague(s, remoteHead, "colleague again");
      expect(await push()).toEqual({ status: "stale", sentence: staleText(NAME) });
      expect(await s.r.g(["rev-parse", `refs/heads/${NAME}`])).toBe(moved);
      // Back at the fetched head, the push goes through with the fetched head as its lease. Never a "+" refspec.
      await s.r.g(["update-ref", `refs/heads/${NAME}`, remoteHead]);
      argv.length = 0;
      expect(await push()).toEqual({ status: "pushed" });
      const sent = argv.find((a) => a.includes("push")) as string[];
      expect(sent).toContain(`--force-with-lease=refs/heads/${NAME}:${remoteHead}`);
      expect(sent.some((a) => a.startsWith("+"))).toBe(false);
      expect(await s.r.g(["rev-parse", `refs/heads/${NAME}`])).toBe(head);
    },
    SLOW,
  );

  test(
    "AC-B32: Start a new branch takes the first free suffix and an empty lease",
    async () => {
      const s = await setup({ settings: { existing: "new" } });
      const id = s.addTask(PUSH_KEY, "Add the feature");
      await colleague(s, s.base, "colleague");
      await s.r.g(["update-ref", `refs/heads/${NAME}-2`, s.base]);
      await s.build(id);
      expect(s.part(id).branch).toBe(`${NAME}-3`);
      expect(s.db.query("SELECT pushed FROM task_part WHERE id = $id").get({ id: s.part(id).id })).toEqual({ pushed: null });
      expect(s.t(id).base_commit).toBe(s.base);
    },
    SLOW,
  );
});

describe("restart recovery and the helpers", () => {
  test("a restart stops the tasks that worked: a running check, a step that waited for the slot, a part that the loop built", async () => {
    const s = await setup();
    const now = Date.now();
    const add = (key: string) => s.addTask(key, key);
    const a = add("R-1");
    const b = add("R-2");
    const c = add("R-3");
    const d = add("R-4");
    const part = (task: number) =>
      s.db
        .query(
          `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($task, 1, 'single', 't', $b, 'main', 'implementing', $now, $now)`,
        )
        .run({ task, b: `feature/x-${task}`, now });
    for (const x of [a, b, c, d]) part(x);
    s.db.query("INSERT INTO task_step (task, kind, state, ord, started_at) VALUES ($t, 'check', 'running', 1, $now)").run({ t: a, now });
    s.db.query("INSERT INTO task_step (task, kind, state, ord, started_at) VALUES ($t, 'tests', 'waiting', 1, $now)").run({ t: b, now });
    // b waits for the run slot, so its reason says so. d waits for the user: its reason keeps it.
    const reason = (id: number, kind: string) =>
      s.db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ id, b: JSON.stringify({ kind, step: null, text: "x" }) });
    reason(b, "slot");
    reason(d, "red");
    recoverTasks(s.db, now);
    for (const x of [a, b, c]) expect([s.t(x).state, s.t(x).stopped_from]).toEqual(["stopped", "implementing"]);
    expect(s.t(d).state).toBe("implementing");
    expect(s.db.query("SELECT state FROM task_step WHERE task IN ($a, $b)").all({ a, b })).toEqual([
      { state: "failed" },
      { state: "failed" },
    ]);
  });

  test("globs follow the gitignore rules; the line count skips lock files; a tick marks one open task", async () => {
    expect(globMatch("*.lock", "a/b/c.lock")).toBe(true);
    expect(globMatch("bun.lock", "pkg/bun.lock")).toBe(true);
    expect(globMatch("/bun.lock", "pkg/bun.lock")).toBe(false);
    expect(globMatch("tests/", "a/tests/x.ts")).toBe(true);
    expect(globMatch("src/tests/", "a/src/tests/x.ts")).toBe(false);
    expect(globMatch("tests/**/*.ts", "tests/a/b.ts")).toBe(true);
    expect(globMatch("*.test.ts", "src/x.test.ts")).toBe(true);
    expect(globMatch("*.test.ts", "src/x.ts")).toBe(false);
    const text = "### [ ] T1.1 A\nFiles: a\n### [ ] T1.10 B\n";
    expect(tickTask(text, "T1.1")).toBe("### [x] T1.1 A\nFiles: a\n### [ ] T1.10 B\n");
    expect(tickTask("### [x] T1.1 A\n", "T1.1")).toBeNull();
    expect(tickTask(text, "T1")).toBeNull();
    const s = await setup();
    const w = await openWorktree({
      dataDir: s.dataDir,
      db: s.db,
      project: "PROJ",
      repo: "repo",
      task: s.task,
      ord: 1,
      branch: "feature/K-1-count",
      base: s.base,
    });
    writeFileSync(join(w.repo, "bun.lock"), "x\n".repeat(50));
    writeFileSync(join(w.repo, "README.md"), "one\ntwo\n");
    await git([`--git-dir=${w.admin}`, `--work-tree=${w.repo}`, "add", "-A"], { env: w.env });
    await git(
      [`--git-dir=${w.admin}`, `--work-tree=${w.repo}`, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-qm", "x"],
      {
        env: w.env,
      },
    );
    const head = (await git([`--git-dir=${w.admin}`, "rev-parse", "HEAD"], { env: w.env })).trim();
    // README.md: 2 added, 1 removed. bun.lock: left out.
    expect(await changedLines(w, s.base, head, LOCK_GLOBS)).toEqual({ files: 1, added: 2, removed: 1, lines: 3 });
    expect((await changedLines(w, s.base, head, [])).lines).toBe(53);
  });
});

describe("routes (spec.md section 6.11)", () => {
  test(
    "pause, stop, resume, and answers go to the loop; a version mismatch gives 409 with the task",
    async () => {
      const s = await setup({ mode: "green" });
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const call = async (path: string, body: unknown) => {
        const res = await app.request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as TaskDto & { error?: string; task?: TaskDto } };
      };
      expect((await call(`/api/tasks/${s.task}/pause`, { version: s.t().version })).status).toBe(409);
      expect((await call(`/api/tasks/${s.task}/stop`, { version: s.t().version + 5 })).body.error).toBe(
        "The task changed on another page. Check it again.",
      );
      const stop = await call(`/api/tasks/${s.task}/stop`, { version: s.t().version });
      expect([stop.status, stop.body.state, stop.body.stoppedFrom]).toEqual([200, "stopped", "implementing"]);
      const resume = await call(`/api/tasks/${s.task}/resume`, { version: s.t().version });
      expect([resume.status, resume.body.state]).toEqual([200, "implementing"]);
      await until(() => s.blocked() !== null);
      expect(s.blocked()?.text).toBe("Tests pass before the change. See why.");
      expect((await call(`/api/tasks/${s.task}/answers`, { version: s.t().version, answers: [] })).body.error).toBe(
        "No question waits for an answer.",
      );
      expect((await call(`/api/tasks/${s.task}/spec-change/x`, { version: s.t().version, accept: true })).status).toBe(400);
    },
    SLOW,
  );
});

test(
  "pre-flight: a base branch that is gone blocks before any Claude step (spec.md section 6.16.7, AC-B42)",
  async () => {
    const s = await setup();
    s.db.query("UPDATE task SET target_branch = 'gone' WHERE id = $id").run({ id: s.task });
    await s.build();
    expect(s.blocked()).toEqual({
      kind: "preflight",
      step: null,
      text: "Needs you: gone no longer exists in PROJ/repo. Pick another base branch.",
    });
    expect(s.runCalls()).toEqual([]);
    expect(s.steps()).toEqual([]);
  },
  SLOW,
);
