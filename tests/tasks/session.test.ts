// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/part-session.md sections 2.2 to 2.6 and 9.7 (package PS3, AC-B293 to AC-B305): one Claude session per part. The
// loop order through the phase send helper, the tick check, the guard of a resume, a failed resume, the cut runs, the reasons of a run
// end, the transcript at the end of a part, and an old task. The fake CLI keeps transcripts in a temp projects folder. No test starts
// the real CLI or reaches a forge.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sweepCwdFolders } from "../../src/server/review/claude";
import { git } from "../../src/server/review/git";
import { openDb } from "../../src/server/storage/db";
import { insertStep, patchStep } from "../../src/server/tasks/implement";
import { REVIEW_FIX_TRIES, resumeProblem, tickDiff, tickTask } from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import {
  advance,
  advancePart,
  dropSessions,
  partSession,
  RESTART_TEXT,
  recoverTasks,
  saveSession,
  sha256File,
  taskRow,
  WORKING,
} from "../../src/server/tasks/tasks";
import { specResult, type TaskBlocked } from "../../src/shared/task";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";
import {
  type Call,
  CLEAN,
  cleanupAll,
  FIXED,
  KEY,
  MAX_TURNS,
  point,
  QUESTION,
  review,
  SLOW,
  SPEC,
  type Step,
  setup,
  TEST_FILE,
  TICK,
  TODO,
  until,
  WORKS,
} from "./loop-fixture";
import { remoteCommit } from "./update-fixture";

for (const m of ["tasks/loop", "tasks/implement", "tasks/tasks", "review/jobs", "review/claude"])
  console.log(`session.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);

const GATES_ON = { resume: true, live: true, resolve: false };
const detailOf = (s: { steps: () => Step[] }, id: number) => JSON.parse((s.steps().find((x) => x.id === id) as Step).detail_json);
// A fixture with no line: the CLI sends no init and no tool event, as a resume that finds no conversation.
const emptyFixture = (root: string) => {
  const f = join(root, "empty.jsonl");
  writeFileSync(f, "");
  return f;
};

describe("the phase machine in the build (part-session.md section 9.3.3)", () => {
  test(
    "AC-B299, AC-B359, AC-B360: the phase send helper takes GO setup, CLEAN, GO baseline, CLEAN, GO run, RUN_DONE, CHECKS_GREEN, GO critic, CLEAN, GO review, CLEAN; then REVIEWED",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }] } });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      expect(s.phases.map((p) => `${p.event}>${p.to}`)).toEqual([
        "GO>setup",
        "CLEAN>idle",
        "GO>baseline",
        "CLEAN>idle",
        "GO>building",
        "RUN_DONE>checking",
        "CHECKS_GREEN>idle",
        "GO>critic",
        "CLEAN>idle",
        "GO>reviewing",
        "CLEAN>idle",
      ]);
      // AC-B333: the critic is a review run with model haiku, 30 turns, no rl-reviewer, and no verify phase.
      const critic = s.runCalls().find((c) => c.argv.includes("haiku")) as Call;
      expect(critic.argv.slice(critic.argv.indexOf("--max-turns"), critic.argv.indexOf("--max-turns") + 2)).toEqual(["--max-turns", "30"]);
      expect(Object.keys(critic.agents ?? {})).toEqual(["rl-main"]);
      expect(s.flow().filter((f) => f.startsWith("review:"))).toEqual(["review:critic:ok", "review:review:ok"]);
      expect(new Set(s.phases.map((p) => p.part))).toEqual(new Set([s.part().id]));
    },
    SLOW,
  );

  test(
    "AC-B299: red checks take CHECKS_RED to fixing and back; a run that ends with a reason sends WAIT, a Stop sends STOPPED",
    async () => {
      const s = await setup();
      await s.build();
      expect(s.phases.map((p) => `${p.event}>${p.to}`).slice(4, 9)).toEqual([
        "GO>building",
        "RUN_DONE>checking",
        "CHECKS_RED>fixing",
        "RUN_DONE>checking",
        "CHECKS_GREEN>idle",
      ]);
      // A question of the build run: WAIT from building.
      const q = await setup({ seq: { "implement:build": [{ writes: [TODO], implement: { ...QUESTION_RESULT } }] } });
      await q.build();
      expect(q.blocked()?.kind).toBe("question");
      expect(q.phases.at(-1)).toMatchObject({ from: "building", event: "WAIT", to: "idle" });
      // A Stop during the build run: STOPPED from building.
      const t = await setup({ seq: { "implement:build": [{ delayMs: 3000, writes: [TODO] }] } });
      t.loop.build(t.db, t.task);
      const running = () => t.db.query("SELECT 1 FROM review_run WHERE task = $t AND status = 'running'").get({ t: t.task }) !== null;
      for (let k = 0; k < 600 && !running(); k++) await Bun.sleep(25);
      expect(t.loop.stop(t.db, t.task, { version: t.t().version }).status).toBe(200);
      await t.loop.idle(t.task);
      expect(t.phases.at(-1)).toMatchObject({ from: "building", event: "STOPPED", to: "idle" });
    },
    SLOW * 2,
  );
});

// part-session.md section 2.7 and ps4-plan.md WP-6: the critic once after the first build commit.
describe("the critic (part-session.md section 2.7)", () => {
  const onTest = {
    ...point("minor"),
    path: "tests/feature.test.ts",
    anchorText: "test('feature works', () => {});",
    body: "A test point.",
  };
  const MORE = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const checked = true;\n// More.\n" };

  test(
    "AC-B359: kept critic points start one judging run, the gate, and the commit; a push-back gives a Log line only; the critic runs once",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          critic: [{ critic: review([point("major"), onTest]) }],
          "implement:fix": [
            {
              writes: [FIXED],
              pointVerdicts: [
                { verdict: "fixed" },
                { verdict: "pushback", why: "invalid", reason: "The test is fine.", cite: "tests/feature.test.ts:1" },
              ],
            },
            { writes: [MORE] },
          ],
          review: [{ review: review([point("blocker")]) }, { review: CLEAN }],
        },
      });
      await s.build();
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
      expect(s.phases.map((p) => `${p.event}>${p.to}`).slice(7, 15)).toEqual([
        "GO>critic",
        "POINTS>judging",
        "RUN_DONE>checking",
        "CHECKS_GREEN>idle",
        "GO>reviewing",
        "POINTS>judging",
        "RUN_DONE>checking",
        "CHECKS_GREEN>idle",
      ]);
      // The critic runs once: the review round after its commit runs no second critic.
      expect(s.runCalls().filter((c) => c.argv.includes("haiku"))).toHaveLength(1);
      expect(s.flow().filter((f) => f.startsWith("review:"))).toEqual(["review:critic:ok", "review:review:ok", "review:review:ok"]);
      const judging = s.runCalls().find((c) => c.stdin.includes("- Mode: fix")) as Call;
      expect(judging.context["failure.md"]).toContain("A quick second Claude run reviewed the added lines of this part.");
      expect(judging.context["failure.md"]).not.toContain("- Check:");
      expect(judging.stdin).toContain("Judge each point before you change code.");
      const fix = s.steps().find((x) => x.kind === "fix" && x.item === "critic") as Step;
      expect(detailOf(s, fix.id).notes.at(-1)).toMatch(
        /^Claude pushes back on critic point \d+: The test is fine\. Proof: tests\/feature\.test\.ts:1\.$/,
      );
      expect(s.db.query("SELECT COUNT(*) AS n FROM task_question WHERE task = $t").get({ t: s.task })).toEqual({ n: 0 });
      expect(await s.log()).toContain(`Ada Example <ada@example.invalid>|${KEY}: Fix the critic points of part 1`);
    },
    SLOW,
  );

  test(
    "AC-B359: a failed critic writes a note and CLEAN, and the own review still runs",
    async () => {
      const s = await setup();
      s.scenario({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          critic: [{ fixture: emptyFixture(s.root), exitCode: 1 }],
          review: [{ review: CLEAN }],
        },
      });
      await s.build();
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
      expect(s.phases.map((p) => `${p.event}>${p.to}`).slice(7)).toEqual(["GO>critic", "CLEAN>idle", "GO>reviewing", "CLEAN>idle"]);
      const critic = s.steps().find((x) => x.kind === "review" && x.item === "critic") as Step;
      expect(critic.state).toBe("failed");
      expect(detailOf(s, critic.id).notes.at(-1)).toBe("The quick review failed. The own review still runs.");
    },
    SLOW,
  );
});

const QUESTION_RESULT = {
  summary: "s",
  done: false,
  tests: [],
  question: { text: "Which name?", why: "Two fit.", options: [], recommended: null },
  specChange: "",
  notes: [],
  coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
};

describe("the build run (part-session.md sections 2.3, 2.4, and 2.6)", () => {
  test(
    "AC-B294: the build run gets the session prompt, the open tasks with their Done-when lines, baseline.md, and an empty ./scratch",
    async () => {
      const s = await setup({
        seq: { "implement:build": [{ writes: [TEST_FILE, WORKS, { path: "scratch/out.txt", text: "long output\n" }], ticks: TICK }] },
      });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const call = s.runCalls()[0] as Call;
      // claude.ts SESSION_GATES: live input on. The first run of a part has no transcript to resume.
      expect(call.argv).toContain("--input-format");
      expect(call.argv).not.toContain("--resume");
      expect(call.stdin).toStartWith(
        "You build part 1 of an approved plan in ./repo. You can change files only in ./repo. You post nothing. Git is denied. The app commits after its checks, and the user pushes. You cannot run commands.",
      );
      for (const line of [
        `./context/spec/ holds a read-only copy of the plan. Tick tasks only in ./repo/specs/${KEY}/plan.md.`,
        "Do the open tasks of ./context/step.md in plan order, one at a time.",
        "For each task, write or change its tests first. Then change the code.",
        "Never skip, delete, or loosen a test to make it pass.",
        "Change a test only when the test is wrong. Say so in notes.",
        "./context/baseline.md lists the checks that fail on the part base. Do not fix them. Name such a failure in notes.",
        "End the run when every open task is ticked and its tests pass, or when you need the user. Set done to true only then. List the IDs that you ticked in ticked.",
        "- Mode: build",
      ])
        expect(call.stdin).toContain(line);
      expect(call.context["step.md"]).toContain("## Open tasks\n\n### T1.1 Write the feature\n\nFiles: src/feature.ts");
      expect(call.context["step.md"]).toContain("Done when: The test passes.");
      expect(call.context["baseline.md"]).toContain("No check failed on the part base.");
      // The first run of a part has no earlier work.
      expect(call.context["continue.md"]).toBeUndefined();
      // part-session.md section 2.3 item 4: the path check skips ./scratch, and the next run finds it empty.
      const build = s.steps().find((x) => x.kind === "implement") as Step;
      expect(detailOf(s, build.id)).toMatchObject({ checked: true, deniedPaths: [], session: { purpose: "build", resumed: false } });
      expect(readdirSync(join((await s.wt()).dir, "scratch"))).toEqual(["out.txt"]);
    },
    SLOW,
  );

  test(
    "AC-B296: a plan change that is no tick blocks with spec_change, also a tick of an ID that the plan does not hold open",
    async () => {
      const ghost = { path: `repo/specs/${KEY}/plan.md`, text: "# Plan\n\n### [x] T9.9 Ghost\n" };
      const s = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS, ghost] }] } });
      await s.build();
      expect(s.blocked()).toMatchObject({ kind: "spec_change" });
      const row = s.steps().find((x) => x.kind === "spec_change") as Step;
      expect(JSON.parse(row.detail_json).specChange).toEqual({ paths: [`specs/${KEY}/plan.md`] });
      // The tick grammar: only `### [ ] <id> ` to `### [x] <id> ` of a heading that HEAD holds open.
      const head = "# Plan\r\n\r\n### [ ] T1.1 A\r\nFiles: a\r\n### [ ] T1.2 B\r\n### [x] T1.3 C\r\n";
      expect(tickDiff(head, head.replace("### [ ] T1.1", "### [x] T1.1"))).toEqual(["T1.1"]);
      expect(tickDiff(head, head.replaceAll("\r\n", "\n").replace("### [ ] T1.2", "### [x] T1.2"))).toEqual(["T1.2"]);
      expect(tickDiff(head, head)).toEqual([]);
      expect(tickDiff(head, head.replace("Files: a", "Files: b"))).toBeNull();
      expect(tickDiff(head, `${head}### [x] T9.9 Ghost\r\n`)).toBeNull();
      expect(tickDiff(head, head.replace("### [x] T1.3", "### [ ] T1.3"))).toBeNull();
      expect(tickTask(head, "T1.3")).toBeNull();
    },
    SLOW,
  );

  test(
    "AC-B293: done true with an open task left gives the reason unfinished; Continue builds the open task, and result.ticked feeds a Log note",
    async () => {
      const s = await setup({
        seq: { "implement:build": [{ writes: [TEST_FILE, TODO] }, { writes: [WORKS], ticks: TICK }] },
      });
      await s.build();
      const b = s.blocked();
      expect(b).toMatchObject({ kind: "unfinished" });
      expect(b?.text).toBe(
        "Needs you: Claude ended the run before part 1 was done: Echo: the step is done. Continue goes on with the open tasks.",
      );
      expect(s.t().state).toBe("implementing");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const builds = s.steps().filter((x) => x.kind === "implement");
      expect(builds).toHaveLength(2);
      // The echo result lists no tick, so the second run gets the note.
      expect(detailOf(s, (builds[1] as Step).id).notes).toContain(
        "Claude listed the ticks none, and the plan file holds the new ticks T1.1.",
      );
    },
    SLOW,
  );

  test(
    "AC-B302: a part that changed no test file gets the note on its last commit row",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ writes: [WORKS], ticks: TICK }] } });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const commit = s.steps().find((x) => x.kind === "commit" && x.item === "build") as Step;
      expect(detailOf(s, commit.id).notes).toContain("Claude added or changed no test file.");
      const t = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }] } });
      await t.build();
      const c2 = t.steps().find((x) => x.kind === "commit" && x.item === "build") as Step;
      expect(detailOf(t, c2.id).notes).not.toContain("Claude added or changed no test file.");
    },
    SLOW * 2,
  );

  test(
    "AC-B305: an old task whose earlier loop ticked a task builds only the open tasks",
    async () => {
      const two = (n: number) => ({
        id: `T${n}`,
        title: `Write part ${n}`,
        files: ["src/feature.ts"],
        run: ["tests/feature.test.ts"],
        done: `Part ${n} works.`,
      });
      const spec = specResult.parse({ ...SPEC, parts: [{ ...SPEC.parts[0], tasks: [two(1), two(2)] }] });
      const s = await setup({ spec, seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }] } });
      // The plan of the task as the old loop left it: T1.1 ticked.
      const docs = JSON.parse(s.t().docs_json as string) as { plan: string };
      s.db
        .query("UPDATE task SET docs_json = $d WHERE id = $id")
        .run({ id: s.task, d: JSON.stringify({ ...docs, plan: tickTask(docs.plan, "T1.1") }) });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const step = (s.runCalls()[0] as Call).context["step.md"] ?? "";
      const open = step.slice(step.indexOf("## Open tasks"), step.indexOf("## Tasks"));
      expect(open).toContain("### T1.2 Write part 2");
      expect(open).not.toContain("T1.1");
    },
    SLOW,
  );
});

describe("the session guard (part-session.md section 2.2)", () => {
  test("AC-B300: resumeProblem holds all five rules, each one in turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-guard-"));
    try {
      const file = join(dir, "a.jsonl");
      writeFileSync(file, "{}\n");
      const heads = [{ taskRepo: 1, head: "abc" }];
      const s = { file, sha256: sha256File(file), heads, context: 1000 };
      expect(resumeProblem(s, heads, 100_000, GATES_ON)).toBeNull();
      expect(resumeProblem(s, heads, 100_000, { resume: false })).toBe("This app version starts a new session for each run.");
      expect(resumeProblem(null, heads, 100_000, GATES_ON)).toBe("No session of an earlier run is saved.");
      expect(resumeProblem({ ...s, file: join(dir, "gone.jsonl") }, heads, 100_000, GATES_ON)).toBe(
        "No session of an earlier run is saved.",
      );
      expect(resumeProblem({ ...s, sha256: "0".repeat(64) }, heads, 100_000, GATES_ON)).toBe("The saved session changed on disk.");
      expect(resumeProblem(s, [{ taskRepo: 1, head: "def" }], 100_000, GATES_ON)).toBe("The branch moved after the last run.");
      expect(resumeProblem(s, [...heads, { taskRepo: 2, head: "x" }], 100_000, GATES_ON)).toBe("The branch moved after the last run.");
      expect(resumeProblem({ ...s, context: null }, heads, 100_000, GATES_ON)).toBe("The size of the last session is not known.");
      expect(resumeProblem({ ...s, context: 100_001 }, heads, 100_000, GATES_ON)).toBe(
        "The last session is larger than your limit of 100000 tokens.",
      );
      // Bash can write outside the cwd: a changed transcript fails the hash.
      writeFileSync(file, "{}\n{}\n");
      expect(resumeProblem(s, heads, 100_000, GATES_ON)).toBe("The saved session changed on disk.");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test(
    "AC-B300: with the gates on, the fix run forks the kept transcript of the build run with the rules digest; a part keeps one transcript",
    async () => {
      const s = await setup({ sessionGates: GATES_ON });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const [build, fix] = s.runCalls() as [Call, Call];
      expect(build.argv).not.toContain("--resume");
      expect(build.argv).not.toContain("--no-session-persistence");
      const at = fix.argv.indexOf("--resume");
      expect(at).toBeGreaterThan(-1);
      expect(fix.argv[at + 2]).toBe("--fork-session");
      expect(fix.stdin).toContain("# Run 2: Fix the red checks");
      expect(fix.stdin).not.toContain("The approved plan is in ./context/spec/.");
      expect(fix.stdin).toContain("- Mode: fix");
      const fixRow = s.steps().find((x) => x.kind === "fix") as Step;
      expect(detailOf(s, fixRow.id).session).toMatchObject({ purpose: "checks", resumed: true, why: null });
      // The kept file of the build run went; the fork of the fix run is the one transcript of the part.
      const session = partSession(s.db, s.part().id);
      expect(session?.runs).toBe(2);
      expect(session?.file && existsSync(session.file)).toBe(true);
      expect(fix.argv[at + 1]).not.toBe(session?.file);
      expect(existsSync(fix.argv[at + 1] as string)).toBe(false);
      expect(readdirSync(dirname(session?.file as string))).toEqual([`${session?.sessionId}.jsonl`]);
      expect(sha256File(session?.file as string)).toBe(session?.sha256 as string);
    },
    SLOW,
  );

  test(
    "AC-B300: after a denied path the next run starts a new session, and a moved head starts one too",
    async () => {
      const s = await setup({
        sessionGates: GATES_ON,
        seq: {
          "implement:build": [
            { writes: [TODO, { path: "repo/CLAUDE.md", text: "planted\n" }] },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      await s.build();
      expect(s.blocked()?.kind).toBe("denied_path");
      expect(partSession(s.db, s.part().id)).toBeNull();
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const second = s.steps().filter((x) => x.kind === "implement")[1] as Step;
      expect(detailOf(s, second.id).session).toMatchObject({ resumed: false, why: "No session of an earlier run is saved." });
      // The commit after the gate moved the session heads, so the stored heads equal the branch.
      const session = partSession(s.db, s.part().id);
      expect(session?.heads).toEqual([{ taskRepo: expect.any(Number), head: s.part().head as string }]);
    },
    SLOW,
  );

  test(
    "AC-B300: a resume that fails before any tool call starts one new session at once, with the Log note",
    async () => {
      const s = await setup({ sessionGates: GATES_ON });
      s.scenario({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, TODO], ticks: TICK }],
          "implement:fix": [{ fixture: emptyFixture(s.root), exitCode: 1 }, { writes: [WORKS] }],
          review: [{ review: CLEAN }],
        },
      });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const [failed, fresh] = s.steps().filter((x) => x.kind === "fix") as [Step, Step];
      expect(failed.state).toBe("failed");
      expect(detailOf(s, failed.id).session).toMatchObject({ resumed: true });
      const note = "The app could not resume the session. It started a new one with the earlier work.";
      expect(detailOf(s, failed.id).notes).toContain(note);
      expect(detailOf(s, fresh.id).session).toMatchObject({ resumed: false, why: note });
      const calls = s.runCalls().filter((c) => s.modeOf(c) === "fix");
      expect(calls[1]?.argv).not.toContain("--resume");
      expect(calls[1]?.context["continue.md"]).toContain("# The earlier work on this part");
    },
    SLOW,
  );

  test(
    "AC-B294: with the resume gate off, a fix run starts a new session with continue.md, the kept diff, and the step.md line",
    async () => {
      const s = await setup({ sessionGates: { resume: false, live: true, resolve: false } });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const fix = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      expect(fix.argv).not.toContain("--resume");
      expect(fix.context["continue.md"]).toContain("## Ticked tasks\n\n- T1.1 Write the feature");
      expect(fix.context["continue-diff.md"]).toContain("+export const feature = 'todo';");
      expect(fix.context["step.md"]).toContain("This run starts a new session. ./context/continue.md lists the earlier work on this part.");
      const row = s.steps().find((x) => x.kind === "fix") as Step;
      expect(detailOf(s, row.id).session).toMatchObject({ resumed: false, why: "This app version starts a new session for each run." });
    },
    SLOW,
  );
});

describe("run ends (part-session.md sections 2.2 and 9.3.4)", () => {
  test(
    "AC-B298: a second cut gives stuck/turns; Continue gives one more run, and the part goes on",
    async () => {
      const s = await setup({
        seq: { "implement:build": [{ fixture: MAX_TURNS }, { fixture: MAX_TURNS }, { writes: [TEST_FILE, WORKS], ticks: TICK }] },
      });
      await s.build();
      expect(s.blocked()).toMatchObject({
        kind: "stuck",
        cause: "turns",
        text: "Needs you: the runs of part 1 reached their turn cap twice. Continue gives one more run.",
      });
      expect(s.t().state).toBe("implementing");
      expect(s.phases.filter((p) => p.event === "RUN_CUT").map((p) => p.to)).toEqual(["building", "idle"]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      expect(
        s
          .steps()
          .filter((x) => x.kind === "implement")
          .map((x) => x.state),
      ).toEqual(["failed", "failed", "ok"]);
      // part-session.md section 2.2, Cut runs (Gate B37 U101): the part keeps the transcript of a cut run, and the next run forks it.
      // That transcript holds the cut run, so the next run gets no continue.md.
      const builds = s.steps().filter((x) => x.kind === "implement");
      expect(builds.map((x) => detailOf(s, x.id).session.resumed)).toEqual([false, true, true]);
      expect(s.runCalls().filter((c) => s.modeOf(c) === "build")[2]?.context["continue.md"]).toBeUndefined();
    },
    SLOW,
  );

  test(
    "AC-B295: a failed run gives error/run on the part, and the task does not stop; Continue runs it again",
    async () => {
      const s = await setup();
      s.scenario({
        seq: {
          "implement:build": [
            { fixture: emptyFixture(s.root), exitCode: 1 },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
          review: [{ review: CLEAN }],
        },
      });
      await s.build();
      const b = s.blocked();
      expect(b).toMatchObject({ kind: "error", cause: "run" });
      expect(b?.text).toStartWith("Needs you: the run of part 1 failed.");
      expect([s.t().state, s.t().stopped_from]).toEqual(["implementing", null]);
      expect(s.phases.at(-1)).toMatchObject({ from: "building", event: "WAIT" });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );
});

describe("follow-ups in the phase loop (ps4-plan.md WP-3)", () => {
  const order = (s: { phases: { event: string; to: string }[] }, from: number) => s.phases.slice(from).map((p) => `${p.event}>${p.to}`);
  const FOLLOW = ["GO>following", "RUN_DONE>checking", "CHECKS_GREEN>idle", "GO>reviewing", "CLEAN>idle"];
  const NAMED = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const checked = true;\n// Named.\n" };

  test(
    "AC-B341: on a built part, a send, Fix these too, and Continue of a failed send take GO follow, RUN_DONE, CHECKS_GREEN, GO review, CLEAN",
    async () => {
      const minor = review([point("minor")]);
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          "implement:instruct": [{ writes: [FIXED] }, { writes: [WORKS] }],
          "implement:fix": [{ writes: [NAMED] }],
          review: [{ review: minor }, { review: minor }, { review: CLEAN }, { review: CLEAN }],
        },
      });
      await s.build();
      expect([s.part().state, s.t().state]).toEqual(["self_reviewed", "implementing"]);
      let at = s.phases.length;
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag checked." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(order(s, at)).toEqual(FOLLOW);
      expect(s.flow().slice(-4)).toEqual(["instruct:I1:ok", "check:I1:ok", "commit:I1:ok", "review:review:ok"]);
      at = s.phases.length;
      expect(s.loop.fixPoints(s.db, s.task, s.part().id, { version: s.t().version }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(order(s, at)).toEqual(FOLLOW);
      expect(s.flow().slice(-4)).toEqual(["fix:points:ok", "check:checks:ok", "commit:points:ok", "review:review:ok"]);
      // ps4-plan.md section 1 gaps 14 and 15: Continue in implementing on the reason of a built part puts the failed send in the queue
      // again and runs that part.
      const sent = insertStep(s.db, { task: s.task, part: s.part().id, kind: "instruct", item: "I9", state: "failed" });
      patchStep(s.db, sent, { instruct: { text: "Use works.", part: s.part().id, blockedBefore: null, result: null, committed: false } });
      s.db
        .query("UPDATE task SET blocked_json = $b, version = version + 1 WHERE id = $id")
        .run({ id: s.task, b: JSON.stringify({ kind: "error", cause: "run", step: sent, text: "Needs you: the run of part 1 failed." }) });
      at = s.phases.length;
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(order(s, at)).toEqual(FOLLOW);
      expect(s.flow().slice(-5)).toEqual(["instruct:I9:failed", "instruct:I9:ok", "check:I9:ok", "commit:I9:ok", "review:review:ok"]);
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
    },
    SLOW,
  );

  test(
    "AC-B343: a send cut twice waits with stuck/turns, and each run of it holds the text; Continue runs it again; a usage limit waits with usage",
    async () => {
      const usage = resolve(import.meta.dir, "../../fixtures/claude-synthetic/usage-limit.jsonl");
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          "implement:instruct": [{ fixture: MAX_TURNS }, { fixture: MAX_TURNS }, { writes: [FIXED] }, { fixture: usage, exitCode: 1 }],
        },
      });
      await s.build();
      const sends = () => s.steps().filter((x) => x.kind === "instruct");
      let at = s.phases.length;
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag checked." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(order(s, at)).toEqual(["GO>following", "RUN_CUT>following", "RUN_CUT>idle"]);
      expect(sends().map((x) => [x.item, x.attempt, x.state, detailOf(s, x.id).instruct.text])).toEqual([
        ["I1", 1, "failed", "Add the flag checked."],
        ["I1", 2, "failed", "Add the flag checked."],
      ]);
      expect([s.t().state, s.blocked()]).toEqual([
        "implementing",
        expect.objectContaining({ kind: "stuck", cause: "turns", step: (sends()[1] as Step).id }),
      ]);
      // Continue puts the send in the queue again.
      at = s.phases.length;
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(order(s, at)).toEqual(FOLLOW);
      expect(sends().map((x) => [x.attempt, x.state])).toEqual([
        [1, "failed"],
        [2, "failed"],
        [3, "ok"],
      ]);
      expect(s.blocked()).toBeNull();
      // A usage limit before any tool call is no failed resume: the send waits with usage, and no new session starts.
      at = s.phases.length;
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Use works." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(order(s, at)).toEqual(["GO>following", "WAIT>idle"]);
      const limited = sends().at(-1) as Step;
      expect([detailOf(s, limited.id).instruct.text, limited.state, detailOf(s, limited.id).session.resumed]).toEqual([
        "Use works.",
        "failed",
        true,
      ]);
      // AC-B352: resumeAt is resetsAt times 1000. The setting is off, so the reason is not armed.
      expect([s.t().state, s.blocked()]).toEqual([
        "implementing",
        expect.objectContaining({ kind: "usage", step: limited.id, resumeAt: 1_791_678_600_000, armed: false }),
      ]);
    },
    SLOW,
  );

  test(
    "AC-B352, AC-B353: with the setting on, a usage limit arms the resume; the timer runs the step again once, and a second limit waits unarmed",
    async () => {
      const usage = resolve(import.meta.dir, "../../fixtures/claude-synthetic/usage-limit.jsonl");
      const s = await setup({ usageResume: true, seq: { "implement:build": [{ fixture: usage, exitCode: 1 }] } });
      await s.build();
      // The fixture reset time is in the past, so the timer fires at once and a second driver runs the build again.
      const builds = () => s.runCalls().filter((c) => s.modeOf(c) === "build").length;
      await until(() => builds() === 2, 120_000);
      await until(() => s.steps().filter((x) => x.kind === "implement" && x.state === "failed").length === 2, 120_000);
      await s.loop.idle(s.task);
      expect(order(s, 0).filter((p) => p.startsWith("GO>building") || p.startsWith("WAIT"))).toEqual([
        "GO>building",
        "WAIT>idle",
        "GO>building",
        "WAIT>idle",
      ]);
      const second = s
        .steps()
        .filter((x) => x.kind === "implement")
        .at(-1) as Step;
      // The previous Claude run of the part ended with the usage limit, so the second reason needs a click.
      expect([s.t().state, s.blocked()]).toEqual([
        "implementing",
        expect.objectContaining({ kind: "usage", step: second.id, resumeAt: 1_791_678_600_000, armed: false }),
      ]);
      await Bun.sleep(300);
      expect([builds(), s.loop.running(s.task)]).toEqual([2, false]);
    },
    SLOW,
  );

  test(
    "ps4-plan.md section 1 item 20: an own review that hits the usage limit gives usage, not error/run",
    async () => {
      const s = await setup();
      // A review run checks the init tools, so the stream gets the init of a review run.
      const usage = claudeStream(s.root, "limit", "claude-synthetic/usage-limit.jsonl");
      s.scenario({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }], review: [{ fixture: usage, exitCode: 1 }] } });
      await s.build();
      const own = s
        .steps()
        .filter((x) => x.kind === "review")
        .at(-1) as Step;
      expect([own.state, s.t().state, s.blocked()]).toEqual([
        "failed",
        "implementing",
        expect.objectContaining({ kind: "usage", step: own.id, resumeAt: 1_791_678_600_000, armed: false }),
      ]);
      expect(order(s, 0).slice(-2)).toEqual(["GO>reviewing", "WAIT>idle"]);
    },
    SLOW,
  );

  test(
    "AC-B342: a send is a session run: with the resume gate off a new session with continue.md, with it on a fork; its commit moves the heads",
    async () => {
      for (const resume of [false, true]) {
        const s = await setup({
          sessionGates: { resume, live: true, resolve: false },
          seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }], "implement:instruct": [{ writes: [FIXED] }] },
        });
        await s.build();
        expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag checked." }).status).toBe(202);
        await s.loop.idle(s.task);
        const call = s.runCalls().find((c) => s.modeOf(c) === "instruct") as Call;
        const row = s.steps().find((x) => x.kind === "instruct") as Step;
        expect(call.stdin.endsWith("# Your instructions\n\nAdd the flag checked.")).toBe(true);
        expect(call.argv.includes("--resume")).toBe(resume);
        if (resume) {
          expect(call.argv[call.argv.indexOf("--resume") + 2]).toBe("--fork-session");
          expect(call.context["continue.md"]).toBeUndefined();
        } else {
          expect(call.context["continue.md"]).toContain("# The earlier work on this part");
          expect(call.context["continue-diff.md"]).toStartWith("# UNTRUSTED DATA");
          expect(call.context["step.md"]).toContain("This run starts a new session.");
        }
        expect(detailOf(s, row.id).session).toMatchObject({ purpose: "message", resumed: resume });
        // The send kept its transcript, and its commit moved the heads.
        expect(partSession(s.db, s.part().id)?.heads).toEqual([{ taskRepo: expect.any(Number), head: s.part().head as string }]);
        expect(partSession(s.db, s.part().id)?.sessionId).toBe(detailOf(s, row.id).session.id);
      }
    },
    SLOW * 2,
  );

  test(
    "AC-B347: a judging run that changes no file runs no check: the gate is green at the same HEAD",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          "implement:fix": [{ writes: [] }, { writes: [] }],
          review: [{ review: review([point("major")]) }],
        },
      });
      await s.build();
      expect(s.blocked()).toMatchObject({ kind: "blocker" });
      expect(s.steps().filter((x) => x.kind === "fix" && x.item === "review")).toHaveLength(REVIEW_FIX_TRIES);
      expect(s.flow().filter((x) => x.startsWith("check:checks:"))).toEqual(["check:checks:ok"]);
      expect(s.phases.filter((p) => p.event === "CHECKS_GREEN")).toHaveLength(REVIEW_FIX_TRIES + 1);
    },
    SLOW,
  );

  test(
    "ps4-plan.md section 2.5: a fix run in the gate of Fix these too maps to fixing; the answer to its question runs the checks again",
    async () => {
      const s = await setup({
        seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }], review: [{ review: review([point("minor")]) }] },
      });
      await s.build();
      s.scenario({
        seq: {
          "implement:fix": [{ writes: [TODO] }, { implement: { ...QUESTION_RESULT } }, { writes: [WORKS] }],
          review: [{ review: CLEAN }],
        },
      });
      expect(s.loop.fixPoints(s.db, s.task, s.part().id, { version: s.t().version }).status).toBe(202);
      await s.loop.idle(s.task);
      // The points made the checks red, and the fix run of the gate asks.
      const asked = s
        .steps()
        .filter((x) => x.kind === "fix")
        .at(-1) as Step;
      expect([asked.item, s.blocked()?.kind, s.blocked()?.step]).toEqual(["checks", "question", asked.id]);
      const q = s.db.query("SELECT id FROM task_question WHERE task = $t AND answer_json IS NULL").get({ t: s.task }) as { id: number };
      const at = s.phases.length;
      expect(s.loop.answer(s.db, s.task, { version: s.t().version, answers: [{ question: q.id, text: "Use works." }] }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(order(s, at)[0]).toBe("GO>checking");
      expect(s.steps().filter((x) => x.kind === "fix" && x.item === "points")).toHaveLength(1);
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
    },
    SLOW,
  );

  test(
    "ps4-plan.md WP-3: a Stop of the follow-up driver that Continue started gives back the reason and keeps the work",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }] } });
      await s.build();
      const part = s.part().id;
      s.db.query("UPDATE task_part SET state = 'pr_open' WHERE id = $id").run({ id: part });
      // The kept work of a red gate after a follow-up.
      const w = await s.wt();
      writeFileSync(join(w.repo, "src", "feature.ts"), "export const feature = 'works';\n// kept\n");
      const gate = insertStep(s.db, { task: s.task, part, kind: "check", item: "checks", state: "failed" });
      const red: TaskBlocked = {
        kind: "red",
        cause: "checks",
        step: gate,
        text: "Needs you: the checks of part 1 stay red after 3 tries.",
      };
      s.db
        .query("UPDATE task SET state = 'ready', blocked_json = $b, version = version + 1 WHERE id = $id")
        .run({ id: s.task, b: JSON.stringify(red) });
      s.mode("sleep");
      const pidFile = join(s.root, "check-child.pid");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 120_000);
      expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      const child = Number(readFileSync(pidFile, "utf8"));
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
      expect(s.phases.at(-1)).toMatchObject({ from: "checking", event: "STOPPED", to: "idle" });
      expect([s.t().state, s.blocked()]).toEqual(["ready", red]);
      expect(readFileSync(join(w.repo, "src", "feature.ts"), "utf8")).toContain("// kept");
    },
    SLOW,
  );
});

describe("live messages (ps4-plan.md WP-7, part-session.md section 2.9)", () => {
  const SEND = "Add the flag checked.";
  // The message goes out after the CLI reads its first message and before its result.
  const SLOW_BUILD = { writes: [TEST_FILE, WORKS], ticks: TICK, delayMs: 250 };
  const OFF = { resume: true, live: false, resolve: false };
  type S = Awaited<ReturnType<typeof setup>>;
  const inputs = (s: S) => readRecords<{ input?: string }>(join(s.root, "calls.jsonl")).flatMap((c) => (c.input ? [c.input] : []));
  const building = (s: S) =>
    s.steps().some((x) => x.kind === "implement" && x.state === "running" && x.run !== null) &&
    s.runCalls().some((c) => s.modeOf(c) === "build");
  const order = (s: S) => s.phases.map((p) => `${p.event}>${p.to}`);
  const BUILD = ["GO>setup", "CLEAN>idle", "GO>baseline", "CLEAN>idle", "GO>building", "RUN_DONE>checking", "CHECKS_GREEN>idle"];
  const END = ["GO>critic", "CLEAN>idle", "GO>reviewing", "CLEAN>idle"];
  const sent = (s: S) => s.runCalls().filter((c) => s.modeOf(c) === "instruct");

  test(
    "AC-B364: with the live gate on, a message during the build run reaches its stdin, the step gets the note, and no follow-up runs",
    async () => {
      const s = await setup({ seq: { "implement:build": [SLOW_BUILD] } });
      s.loop.build(s.db, s.task);
      await until(() => building(s));
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: SEND }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(inputs(s)).toEqual([SEND]);
      const build = s.steps().find((x) => x.kind === "implement") as Step;
      expect(detailOf(s, build.id).notes).toContain(`Your message: ${SEND}`);
      expect([s.steps().filter((x) => x.kind === "instruct"), sent(s)]).toEqual([[], []]);
      expect(order(s)).toEqual([...BUILD, ...END]);
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
    },
    SLOW,
  );

  test(
    "AC-B364: with the live gate off, a message during the build run waits as a follow-up row, and GO runs it after the gate of the build",
    async () => {
      const s = await setup({ sessionGates: OFF, seq: { "implement:build": [SLOW_BUILD], "implement:instruct": [{ writes: [FIXED] }] } });
      s.loop.build(s.db, s.task);
      await until(() => building(s));
      const v = s.t().version;
      expect(s.loop.instruct(s.db, s.task, { version: v, text: SEND }).status).toBe(202);
      const queued = s.steps().at(-1) as Step;
      expect([queued.kind, queued.item, queued.state, s.t().version]).toEqual(["instruct", "I1", "waiting", v + 1]);
      expect(detailOf(s, queued.id).instruct).toEqual({
        text: SEND,
        part: s.part().id,
        blockedBefore: null,
        result: null,
        committed: false,
      });
      // One waiting message per part.
      const second = s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Use works." });
      expect([second.status, (second as { error: string }).error]).toEqual([409, WORKING]);
      await s.loop.idle(s.task);
      expect(inputs(s)).toEqual([]);
      expect(order(s)).toEqual([...BUILD, "GO>following", "RUN_DONE>checking", "CHECKS_GREEN>idle", ...END]);
      expect([sent(s).length, sent(s)[0]?.stdin.endsWith(`# Your instructions\n\n${SEND}`)]).toEqual([1, true]);
      expect(s.flow().filter((x) => x.includes(":I1:"))).toEqual(["instruct:I1:ok", "check:I1:ok", "commit:I1:ok"]);
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
    },
    SLOW,
  );

  test(
    "WP-7: a waiting message that changes no file keeps a reason that came during its run",
    async () => {
      const s = await setup({
        sessionGates: OFF,
        seq: { "implement:build": [SLOW_BUILD], "implement:instruct": [{ writes: [], delayMs: 250 }] },
      });
      s.loop.build(s.db, s.task);
      await until(() => building(s));
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: SEND }).status).toBe(202);
      await until(() => s.steps().some((x) => x.kind === "instruct" && x.state === "running"));
      // The reason of another part (spec.md section 6.25.1).
      const other: TaskBlocked = { kind: "red", step: null, text: "Needs you: the tests of part 2 stay red after 3 tries." };
      s.db.query("UPDATE task SET blocked_json = $b, version = version + 1 WHERE id = $id").run({ id: s.task, b: JSON.stringify(other) });
      await s.loop.idle(s.task);
      const row = s.steps().find((x) => x.kind === "instruct") as Step;
      expect([row.state, detailOf(s, row.id).instruct.result]).toEqual(["ok", "no_change"]);
      expect(s.blocked()).toEqual(other);
    },
    SLOW,
  );

  // A message waits beside the build run, and a Stop ends the driver. The rows stay as at that moment.
  const stoppedWithMessage = async () => {
    const s = await setup({ sessionGates: OFF, seq: { "implement:build": [SLOW_BUILD], "implement:instruct": [{ writes: [FIXED] }] } });
    s.loop.build(s.db, s.task);
    await until(() => building(s));
    expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: SEND }).status).toBe(202);
    const queued = (s.steps().at(-1) as Step).id;
    const build = (s.steps().find((x) => x.kind === "implement") as Step).id;
    expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
    await s.loop.idle(s.task);
    expect(s.flow().at(-1)).toBe("instruct:I1:waiting");
    return { s, queued, build };
  };
  // The app stopped during the build run: the build row and the task go back to their state at that moment.
  const crashed = (s: S, build: number) => {
    s.db.query("UPDATE task_step SET state = 'running', ended_at = NULL WHERE id = $id").run({ id: build });
    s.db.query("UPDATE task SET state = 'implementing', stopped_from = NULL WHERE id = $id").run({ id: s.task });
  };
  const ranOnce = (s: S, flow: string[]) => {
    expect([sent(s).length, sent(s)[0]?.stdin.endsWith(`# Your instructions\n\n${SEND}`)]).toEqual([1, true]);
    expect(s.flow().filter((x) => x.startsWith("instruct:"))).toEqual(flow);
    expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
  };

  test(
    "AC-B364: a restart during the build run: the message stays waiting, the build row takes the reason, and Continue runs the message",
    async () => {
      const { s, queued, build } = await stoppedWithMessage();
      crashed(s, build);
      recoverTasks(s.db, Date.now(), s.dataDir);
      expect([s.t().state, s.blocked()]).toEqual(["implementing", { kind: "error", cause: "restart", step: build, text: RESTART_TEXT(1) }]);
      expect(s.steps().find((x) => x.id === queued)?.state).toBe("waiting");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      ranOnce(s, ["instruct:I1:ok"]);
    },
    SLOW,
  );

  test(
    "AC-B364: a restart while the part waits with its own reason: the message stays waiting, and Continue on that reason runs it",
    async () => {
      // The first build run ticks nothing, so the part waits with unfinished. The second one finishes the part.
      const s = await setup({
        sessionGates: OFF,
        seq: {
          "implement:build": [
            { writes: [TEST_FILE, WORKS], delayMs: 250 },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
          "implement:instruct": [{ writes: [FIXED] }],
        },
      });
      s.loop.build(s.db, s.task);
      await until(() => building(s));
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: SEND }).status).toBe(202);
      const queued = (s.steps().at(-1) as Step).id;
      await s.loop.idle(s.task);
      const unfinished = s.blocked();
      expect([unfinished?.kind, s.steps().find((x) => x.id === queued)?.state]).toEqual(["unfinished", "waiting"]);
      recoverTasks(s.db, Date.now(), s.dataDir);
      expect([s.blocked(), s.steps().find((x) => x.id === queued)?.state]).toEqual([unfinished, "waiting"]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      ranOnce(s, ["instruct:I1:ok"]);
    },
    SLOW,
  );

  test(
    "AC-B364: a Stop keeps the message, a restart in stopped keeps it too, and Resume runs it",
    async () => {
      const { s, queued } = await stoppedWithMessage();
      recoverTasks(s.db, Date.now(), s.dataDir);
      expect([s.t().state, s.steps().find((x) => x.id === queued)?.state]).toEqual(["stopped", "waiting"]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      ranOnce(s, ["instruct:I1:ok"]);
    },
    SLOW,
  );

  test(
    "AC-B364: in a follow-up driver, a message during the follow-up run and its fix run reaches stdin with the live gate on; else 409",
    async () => {
      for (const live of [true, false]) {
        const s = await setup({
          sessionGates: { resume: true, live, resolve: false },
          seq: {
            "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
            "implement:instruct": [{ writes: [TODO], delayMs: 250 }],
            "implement:fix": [{ writes: [WORKS], delayMs: 250 }],
          },
        });
        await s.build();
        expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: SEND }).status).toBe(202);
        const runs = (kind: string) => s.steps().filter((x) => x.kind === kind && x.state === "running" && x.run !== null).length;
        const tell = (text: string) => {
          const r = s.loop.instruct(s.db, s.task, { version: s.t().version, text });
          expect([text, r.status as number, (r as { error?: string }).error]).toEqual([
            text,
            ...(live ? [202, undefined] : [409, WORKING]),
          ]);
        };
        await until(() => runs("instruct") === 1 && sent(s).length === 1);
        tell("Use works.");
        // The follow-up made the checks red. The fix run of its gate is no follow-up row.
        await until(() => runs("fix") === 1 && s.runCalls().some((c) => s.modeOf(c) === "fix"));
        tell("Keep the old name.");
        await s.loop.idle(s.task);
        const sendRow = s.steps().find((x) => x.kind === "instruct") as Step;
        const fix = s.steps().find((x) => x.kind === "fix") as Step;
        expect(s.steps().filter((x) => x.kind === "instruct")).toHaveLength(1);
        expect(inputs(s)).toEqual(live ? ["Use works.", "Keep the old name."] : []);
        expect([
          detailOf(s, sendRow.id).notes.includes("Your message: Use works."),
          detailOf(s, fix.id).notes.includes("Your message: Keep the old name."),
        ]).toEqual([live, live]);
        expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
      }
    },
    SLOW * 2,
  );

  test("WP-7: Hold takes the run row of the part, also with a waiting message below it", async () => {
    const s = await setup();
    const part = (
      s.db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($t, 1, 'single', 'Add the feature', 'feature/K-1-add-the-feature', 'main', 'implementing', 1, 1) RETURNING id`)
        .get({ t: s.task }) as { id: number }
    ).id;
    insertStep(s.db, { task: s.task, part, kind: "instruct", item: "I1", state: "waiting" });
    const fix = insertStep(s.db, { task: s.task, part, kind: "fix", item: "checks", state: "running" });
    expect(s.loop.hold(s.db, s.task, part, { version: s.t().version }).status).toBe(200);
    const row = s.db.query("SELECT blocked_json FROM task_part WHERE id = $id").get({ id: part }) as { blocked_json: string };
    expect(JSON.parse(row.blocked_json)).toMatchObject({ kind: "held", step: fix });
  });
});

describe("the transcript at the end of a part (part-session.md section 2.2, End and deletion)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-session-end-"));
  const db: Database = openDb(join(dir, "tasks.sqlite"));
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  let n = 0;
  // A task in state, with one part in part state, and a kept transcript of that part.
  const seed = (state: string, partState: string, pushed: string | null = null) => {
    n++;
    const task = (
      db
        .query(`INSERT INTO task (project, repo, key, title, state, size, target_branch, spec_dir, created_at, updated_at)
          VALUES ('P', 'r', $key, 'T', $state, 'small', 'main', 'specs/K/', 1, 1) RETURNING id`)
        .get({ key: `S-${n}`, state }) as { id: number }
    ).id;
    const part = (
      db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, pushed, created_at, updated_at)
          VALUES ($task, 1, 'single', 'T', $b, 'main', $s, $pushed, 1, 1) RETURNING id`)
        .get({ task, b: `feature/S-${n}`, s: partState, pushed }) as { id: number }
    ).id;
    const file = join(dir, "sessions", `part-${n}`, `${n}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
    saveSession(db, part, { id: `${n}`, file, heads: [], context: 10 });
    return { task, part, file, version: () => (taskRow(db, task) as { version: number }).version };
  };
  const gone = (x: { part: number; file: string }) => {
    expect(partSession(db, x.part)).toBeNull();
    expect(existsSync(x.file)).toBe(false);
    expect(existsSync(dirname(x.file))).toBe(false);
  };

  test("AC-B304: MERGED, DECLINED, ABANDON (skip), RESTART (start again), ALL_MERGED, and CLOSE delete the transcript", () => {
    for (const event of ["MERGED", "DECLINED"] as const) {
      const x = seed("ready", "pr_open");
      expect(advancePart(db, { task: x.task, version: x.version(), part: x.part }, { type: event }).status).toBe(200);
      gone(x);
    }
    const skip = seed("implementing", "implementing");
    expect(advancePart(db, { task: skip.task, version: skip.version(), part: skip.part }, { type: "ABANDON" }).status).toBe(200);
    gone(skip);
    // The machine refuses RESTART after the first push.
    const again = seed("implementing", "self_reviewed");
    expect(
      advancePart(db, { task: again.task, version: again.version(), part: again.part }, { type: "RESTART" }, { unpushed: true }).status,
    ).toBe(200);
    gone(again);
    const close = seed("ready", "pr_open");
    expect(advance(db, { task: close.task, version: close.version() }, { type: "CLOSE" }).status).toBe(200);
    gone(close);
    // A part event that keeps the PR open keeps the transcript, so PR comments can resume it.
    const kept = seed("ready", "pr_open");
    expect(advancePart(db, { task: kept.task, version: kept.version(), part: kept.part }, { type: "CHANGES_REQUESTED" }).status).toBe(200);
    expect(partSession(db, kept.part)?.file).toBe(kept.file);
    dropSessions(db, { task: kept.task });
    gone(kept);
  });

  test("AC-B304: a new kept transcript replaces the older file of the part", () => {
    const x = seed("implementing", "implementing");
    const next = join(dirname(x.file), "next.jsonl");
    writeFileSync(next, "{}\n{}\n");
    saveSession(db, x.part, { id: "next", file: next, heads: [{ taskRepo: 1, head: "h" }], context: 20 });
    expect(existsSync(x.file)).toBe(false);
    expect(partSession(db, x.part)).toMatchObject({ file: next, sessionId: "next", runs: 2, context: 20, sha256: sha256File(next) });
  });

  test(
    "AC-B304: the merge of the part PR in the app deletes the kept transcript of a built part",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }] } });
      await s.build();
      const session = partSession(s.db, s.part().id);
      expect(session?.file && existsSync(session.file)).toBe(true);
      const v = () => (s.t() as { version: number }).version;
      expect(advancePart(s.db, { task: s.task, version: v(), part: s.part().id }, { type: "PR_OPENED" }).status).toBe(200);
      expect(advancePart(s.db, { task: s.task, version: v(), part: s.part().id }, { type: "MERGED" }).status).toBe(200);
      expect(partSession(s.db, s.part().id)).toBeNull();
      expect(existsSync(session?.file as string)).toBe(false);
      // The commit of the build holds the ticked task in its body.
      const w = await s.wt();
      expect((await git([`--git-dir=${w.admin}`, "log", "-1", "--format=%B"], { env: w.env })).trim()).toBe(
        `${KEY}: Add the feature\n\nTasks done: T1.1`,
      );
      expect(readFileSync(join(w.repo, "specs", KEY, "plan.md"), "utf8")).toContain("### [x] T1.1");
      // The plan helpers of the fixture render the same plan that the loop committed.
      expect(renderDocs(KEY, "Add the feature", "small", toPlan(SPEC, s.base, [false], [])).plan).toContain("### [ ] T1.1");
    },
    SLOW,
  );
});

// ps4-plan.md WP-5 (AC-B358, part-session.md section 2.13): the resolve run of an update with one conflict stop on a built part whose
// build run had Bash and the Agent tool.
describe("resolve runs in the part session (ps4-plan.md WP-5)", () => {
  const RESOLVED = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const base = 'base';\n" };
  const ON = { resume: true, live: true, resolve: true };
  const tools = (c: Call) => (c.argv[c.argv.indexOf("--tools") + 1] ?? "").split(",");
  const updated = async (gates: typeof ON, resolve: (root: string) => object[]) => {
    const s = await setup({ sessionGates: gates });
    s.scenario({
      seq: {
        "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
        "implement:resolve": resolve(s.root),
        review: [{ review: CLEAN }],
      },
    });
    s.db.run("UPDATE repo_task_settings SET shell_mode = 'any'");
    await s.build();
    expect(s.part().state).toBe("self_reviewed");
    const kept = partSession(s.db, s.part().id);
    await remoteCommit(s.r, "main", { "src/feature.ts": "export const feature = 'base';\n" });
    expect((await s.loop.update(s.db, s.task, s.part().id, { version: s.t().version })).status).toBe(202);
    await s.loop.idle(s.task);
    expect(JSON.parse(s.steps().find((x) => x.kind === "update")?.detail_json ?? "{}").update).toMatchObject({
      result: "green",
      resolved: true,
    });
    const build = s.runCalls().find((c) => s.modeOf(c) === "build") as Call;
    expect(tools(build)).toEqual(expect.arrayContaining(["Bash", "Agent"]));
    return { s, kept, resolves: s.runCalls().filter((c) => s.modeOf(c) === "resolve") };
  };

  test(
    "AC-B358: with the resume and resolve gates on, the resolve run forks the session without Bash and Agent, and the heads move to the update",
    async () => {
      const { s, kept, resolves } = await updated(ON, () => [{ writes: [RESOLVED] }]);
      const [call] = resolves as [Call];
      const at = call.argv.indexOf("--resume");
      expect([call.argv[at + 1], call.argv[at + 2]]).toEqual([kept?.file as string, "--fork-session"]);
      expect(tools(call)).toEqual(["Read", "Grep", "Glob", "Edit", "Write"]);
      expect(call.argv).not.toContain("--agents");
      expect(call.argv).not.toContain("--no-session-persistence");
      const row = s.steps().find((x) => x.kind === "resolve") as Step;
      expect(detailOf(s, row.id).session).toMatchObject({ purpose: "resolve", resumed: true, why: null });
      // The fork is the one transcript of the part now, and its heads are the heads after the update.
      const session = partSession(s.db, s.part().id);
      expect(session?.file === kept?.file).toBe(false);
      expect(session?.heads).toEqual([{ taskRepo: expect.any(Number), head: s.part().head as string }]);
      expect(resumeProblem(session, session?.heads ?? [], 100_000, ON)).toBeNull();
    },
    SLOW,
  );

  test(
    "AC-B358: with the resolve gate off, the resolve run is new, keeps no transcript, and moves no session head",
    async () => {
      const { s, kept, resolves } = await updated({ ...ON, resolve: false }, () => [{ writes: [RESOLVED] }]);
      const [call] = resolves as [Call];
      expect(call.argv).not.toContain("--resume");
      expect(call.argv).toContain("--no-session-persistence");
      const row = s.steps().find((x) => x.kind === "resolve") as Step;
      expect(detailOf(s, row.id).session).toBeNull();
      const session = partSession(s.db, s.part().id);
      expect([session?.file, session?.heads]).toEqual([kept?.file, kept?.heads]);
      const heads = [{ taskRepo: kept?.heads[0]?.taskRepo as number, head: s.part().head as string }];
      expect(resumeProblem(session, heads, 100_000, ON)).toBe("The branch moved after the last run.");
    },
    SLOW,
  );

  test(
    "AC-B358: a merge stop keeps HEAD, so an update that aborts after a resolve fork drops the kept transcript",
    async () => {
      const s = await setup({ sessionGates: ON });
      s.scenario({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          "implement:resolve": [{ implement: QUESTION }],
          review: [{ review: CLEAN }],
        },
      });
      await s.build();
      // A pushed part takes a merge (spec.md section 6.18.3).
      s.db.query("UPDATE task_part SET pushed = head WHERE id = $id").run({ id: s.part().id });
      const head = s.part().head;
      await remoteCommit(s.r, "main", { "src/feature.ts": "export const feature = 'base';\n" });
      expect((await s.loop.update(s.db, s.task, s.part().id, { version: s.t().version })).status).toBe(202);
      await s.loop.idle(s.task);
      const call = s.runCalls().find((c) => s.modeOf(c) === "resolve") as Call;
      expect(call.argv).toContain("--resume");
      expect(JSON.parse(s.steps().find((x) => x.kind === "update")?.detail_json ?? "{}").update).toMatchObject({
        result: "aborted",
        repos: [expect.objectContaining({ mode: "merge" })],
      });
      expect([s.part().head, s.blocked()?.kind]).toEqual([head, "update"]);
      expect(partSession(s.db, s.part().id)).toBeNull();
    },
    SLOW,
  );

  test(
    "part-session.md section 2.2: a resolve fork that fails before any tool call runs once more with no session; the heads stay",
    async () => {
      const { s, kept, resolves } = await updated(ON, (root) => [{ fixture: emptyFixture(root), exitCode: 1 }, { writes: [RESOLVED] }]);
      expect(resolves.map((c) => c.argv.includes("--resume"))).toEqual([true, false]);
      const [failed, fresh] = s.steps().filter((x) => x.kind === "resolve") as [Step, Step];
      expect([failed.state, fresh.state]).toEqual(["failed", "ok"]);
      expect(detailOf(s, failed.id).notes).toContain("The app could not resume the session. It started a new one with the earlier work.");
      expect(detailOf(s, fresh.id).session).toBeNull();
      expect(partSession(s.db, s.part().id)?.heads).toEqual(kept?.heads);
    },
    SLOW,
  );
});

describe("the sweep (part-session.md section 2.2, End and deletion)", () => {
  test("AC-B304: the sweep deletes the per-cwd folders of task runs only: the encoded task root and then a hyphen", () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-sweep-"));
    try {
      const projects = join(dir, "projects");
      const root = join(dir, "data", "tasks");
      const name = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
      const mine = join(projects, name(join(root, "x", "1", "part-1")));
      const other = join(projects, name(join(dir, "data", "tasks2", "x")));
      const user = join(projects, "C--work-app");
      for (const d of [mine, other, user]) mkdirSync(d, { recursive: true });
      sweepCwdFolders(projects, root);
      expect([existsSync(mine), existsSync(other), existsSync(user)]).toEqual([false, true, true]);
      // A missing projects folder is no error.
      sweepCwdFolders(join(dir, "none"), root);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
