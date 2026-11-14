// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build loop fixture of loop.test.ts and session.test.ts (docs/plans/review-v2/spec.md sections 6.2, 6.7, and 6.14;
// part-session.md section 9.7). The fake CLI writes real files in the task worktree, a bun script stands in for the approved test
// command, and a temp bare remote holds the repository. No test starts the real CLI, reaches a forge, or touches the user's clone or
// data folder.
import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import type { SESSION_GATES } from "../../src/server/review/claude";
import { git } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createLoop, type PhaseStep } from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import { taskRow } from "../../src/server/tasks/tasks";
import { openWorktree } from "../../src/server/tasks/worktree";
import type { ProfileInput } from "../../src/shared/dto";
import { type RunLimits, specResult, type TaskBlocked } from "../../src/shared/task";
import { echoSpec, type FakeScenario, readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { commitOnMain, openTwice, taskCache, taskRemote } from "./fixture";

process.env.REVIEW_LOOP_SECRETS = "memory";
export const SLOW = 180_000;
export const KEY = "K-1";
export const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };

// The approved test command: a bun script in the test folder. check-mode.txt picks the result: red always fails, late-red fails once the
// test file exists, and sleep-late sleeps once it exists. The part base has no test file, so its checks pass in the other modes. Each run
// writes an ignored file, as a build does, and the next Claude step must still pass the path check.
const CHECK = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const mode = readFileSync(join(dir, "check-mode.txt"), "utf8").trim();
mkdirSync("ignored", { recursive: true });
writeFileSync(join("ignored", "check.log"), String(Date.now()));
appendFileSync(join(dir, "checks.log"), mode + "\\n");
if (mode === "green") { console.log("all tests pass"); process.exit(0); }
if (mode === "red") { console.log("FAIL tests/feature.test.ts"); process.exit(1); }
if (mode === "late-red") { console.log(existsSync("tests/feature.test.ts") ? "FAIL tests/feature.test.ts" : "0 tests"); process.exit(existsSync("tests/feature.test.ts") ? 1 : 0); }
if (mode === "sleep" || (mode === "sleep-late" && existsSync("tests/feature.test.ts"))) {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(dir, "check-child.pid"), String(child.pid));
  await Bun.sleep(120000);
  process.exit(0);
}
// The part base has no test file yet, so its checks pass (spec.md section 6.7, Baseline).
const ok = !existsSync("tests/feature.test.ts") || (existsSync("src/feature.ts") && readFileSync("src/feature.ts", "utf8").includes("works"));
console.log(ok ? "1 pass" : "FAIL: src/feature.ts does not work yet");
process.exit(ok ? 0 : 1);
`;

export const SPEC = specResult.parse({
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

export const TEST_FILE = { path: "repo/tests/feature.test.ts", text: "test('feature works', () => {});\n" };
export const TODO = { path: "repo/src/feature.ts", text: "export const feature = 'todo';\n" };
export const WORKS = { path: "repo/src/feature.ts", text: "export const feature = 'works';\n" };
// part-session.md section 2.3: the build run ticks the open tasks in the plan file of the task (fake-claude.ts ticks).
export const TICK = { path: "*", ids: ["*"] };
export const MAX_TURNS = resolve(import.meta.dir, "../../fixtures/claude-synthetic/session-max-turns.jsonl");
// The fix after a review point keeps line 1, so the point still anchors there.
export const FIXED = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const checked = true;\n" };
// An implement result that asks a question with two options.
export const QUESTION = {
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
  coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
};

export const review = (findings: unknown[]) => ({
  summary: "The feature is small.",
  risks: [],
  questions: [],
  coverage: { read: ["src/feature.ts"], skipped: [], unavailable: [], notChecked: [] },
  findings,
});
export const point = (severity: string) => ({
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
export const CLEAN = review([]);

export type Call = {
  argv: string[];
  cwd: string;
  stdin: string;
  context: Record<string, string>;
  attachments: string[];
  skills?: string[];
  agents?: Record<string, { prompt: string }> | null;
  env: Record<string, string>;
};
export type Step = {
  id: number;
  kind: string;
  state: string;
  item: string | null;
  attempt: number;
  run: number | null;
  detail_json: string;
};

export const dirs: string[] = [];
export const cleanup: (() => Promise<void> | void)[] = [];
// Each test file runs it after each test.
export async function cleanupAll() {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}

export type Setup = {
  seq?: FakeScenario["seq"];
  mode?: string;
  budget?: number;
  testGlobs?: string[] | null;
  settings?: Record<string, unknown>;
  spec?: typeof SPEC;
  // The Claude config folder of the runs and the profiles of the settings. profile: the profile of the task row.
  config?: string;
  profiles?: ProfileInput[];
  profile?: string;
  // Files on main of the remote, so the task base holds them.
  main?: Record<string, string>;
  // The approved test command. Default: the bun script CHECK.
  argv?: string[];
  // Runs before each remote lookup, so a test can hold one.
  remote?: () => Promise<void>;
  // Settings > Tasks run limits in config.json.
  runLimits?: Partial<RunLimits>;
  // Settings > Tasks "Resume by itself after a usage limit" in config.json.
  usageResume?: boolean;
  // part-session.md section 2.2: the gates of Gate B37 for the runner and the loop. Absent: SESSION_GATES.
  sessionGates?: typeof SESSION_GATES;
};

export async function setup(o: Setup = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-wpb4-")));
  dirs.push(root);
  const r = await taskRemote(root);
  if (o.main) await commitOnMain(r.remote, root, o.main);
  const runner = fakeRunner(root);
  const stream = claudeStream(root, "loop", "claude-synthetic/session-usage.jsonl");
  const scenario = (s: Omit<FakeScenario, "record" | "auth" | "fixture"> = {}) => runner.write({ fixture: stream, ...s });
  scenario({
    seq: {
      "implement:build": [{ writes: [TEST_FILE, TODO], ticks: TICK }],
      "implement:fix": [{ writes: [WORKS] }],
      review: [{ review: CLEAN }],
      ...o.seq,
    },
  });
  const dataDir = join(root, "data");
  writeConfig(dataDir, {
    baseUrl: "http://127.0.0.1:9",
    userSlug: "u",
    notifications: false,
    ...(o.profiles && { profiles: o.profiles }),
    ...(o.runLimits && { runLimits: o.runLimits }),
    ...(o.usageResume && { usageResume: true }),
  });
  const settings = createSettings({ dir: dataDir, secrets: createSecrets(null), jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const events: { event: string; data: unknown }[] = [];
  // Each change notice checks that no part holds two open step rows. The cleanup fails the test on a hit.
  const twice: ReturnType<typeof openTwice> = [];
  let watched: Database | null = null;
  const broadcast = live.broadcast;
  live.broadcast = (event, data) => {
    events.push({ event, data });
    if (watched) twice.push(...openTwice(watched));
    broadcast(event, data);
  };
  const jobs = createReviewJobs({
    settings,
    live,
    dataDir,
    runnerCommand: runner.command,
    repoRemote: async () => {
      await o.remote?.();
      return { url: r.remote, config: [] };
    },
    listTools: stubListTools,
    claudeConfigDir: o.config ?? join(root, "no-claude-config"),
    ...(o.sessionGates && { sessionGates: o.sessionGates }),
  });
  // The first open runs the restart recovery, so it comes before the task rows.
  const db = jobs.open() as Database;
  watched = db;
  const phases: PhaseStep[] = [];
  const loop = createLoop({ review: jobs, settings, live, onPhase: (p) => phases.push(p) });
  jobs.onStop(() => loop.shutdown());
  cleanup.unshift(async () => {
    await jobs.stop();
    watched = null;
    db.close();
    expect(twice).toEqual([]);
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
            settings_json, profile, created_at, updated_at)
          VALUES ('PROJ', 'repo', $key, $title, 'implementing', 'small', 'claude', 'main', $base, $dir, $docs, $estimate, $settings, $profile,
            $now, $now)
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
          profile: o.profile ?? null,
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
    phases,
  };
}

// The test file of a build whose approved command is `bun test`. check-mode.txt "sleep" makes the test sleep once src/feature.ts exists,
// so a Stop comes during the gate after the build run.
export const sleepyTest = (root: string) => ({
  path: "repo/tests/feature.test.ts",
  text: `import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
test("feature works", async () => {
  if (readFileSync(${JSON.stringify(join(root, "check-mode.txt"))}, "utf8").trim() === "sleep" && existsSync("src/feature.ts")) {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
    writeFileSync(${JSON.stringify(join(root, "check-child.pid"))}, String(child.pid));
    await Bun.sleep(120000);
  }
  expect(existsSync("src/feature.ts") && readFileSync("src/feature.ts", "utf8").includes("works")).toBe(true);
}, 200000);
`,
});
// A build with sleepyTest that stops in the gate after the build run, with the changes of the build run not committed. The base has a
// passing test, so bun test passes on the part base.
export const stopInGate = async () => {
  const base = { "tests/base.test.ts": "import { test } from 'bun:test';\ntest('base', () => {});\n" };
  const s = await setup({ argv: [process.execPath, "test"], mode: "sleep", main: base });
  s.scenario({
    seq: {
      "implement:build": [{ writes: [sleepyTest(s.root), TODO], ticks: TICK }],
      "implement:fix": [{ writes: [WORKS] }],
      review: [{ review: CLEAN }],
    },
  });
  s.loop.build(s.db, s.task);
  const pidFile = join(s.root, "check-child.pid");
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 120_000);
  const child = Number(readFileSync(pidFile, "utf8"));
  const t0 = Date.now();
  expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
  await s.loop.idle(s.task);
  expect(Date.now() - t0).toBeLessThan(30_000);
  return { s, child };
};

export const until = async (f: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(25);
  }
};
