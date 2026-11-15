// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.12 and 7.1 (WP-B5, AC-UX1, AC-UX3, AC-UX9): one test per state row of the Task view table for
// small tasks, the status line of a Tasks row, and the plain-word helpers. WP-MR3 adds the rows of several repositories (section 6.16).
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { noMergeText } from "../../src/server/tasks/pointer";
import type {
  AttachmentDto,
  AttachmentMeta,
  BranchCheckDto,
  BuildDto,
  SubtaskDto,
  TaskDto,
  TaskPartDto,
  TaskPrDto,
  TaskQuestionDto,
  TaskRepoDto,
  TaskRowDto,
  TaskStepDto,
} from "../../src/shared/dto";
import { PATCH_LOST, REASON_EXITS, type StepDetail, stepDetail, type TaskBlocked, taskProfileId } from "../../src/shared/task";
import { phaseRow, type RowPhase, rowPhase } from "../../src/shared/task-status";
import { LogTab } from "../../src/web/tasks/LogTab";
import {
  ACCESS_TEXT,
  type ActionKind,
  addPlanSentence,
  basePicks,
  branchApproval,
  branchesError,
  branchNote,
  defaultFocus,
  elapsed,
  type FileChoice,
  fileChoiceState,
  fileChoices,
  fileGroups,
  fileMeta,
  firstPick,
  firstPicks,
  goneBase,
  inTask,
  listText,
  logRows,
  NO_MERGE,
  openQuestions,
  overLimit,
  parentHint,
  partLabel,
  partRows,
  patchText,
  pickedPrefix,
  plannedBranch,
  plannedTasks,
  planSentence,
  pointerRow,
  prBuild,
  prefixProblem,
  proposals,
  prRowLook,
  prTitle,
  questionPart,
  questionSource,
  REPOS_SHOWN,
  readyNotes,
  repoChoices,
  repoMatches,
  repoName,
  resetText,
  roleText,
  rowSize,
  rowStatus,
  type SendGroup,
  STEP_TEXT,
  sendOf,
  sendResult,
  sessionNote,
  sessionRows,
  sessionRuns,
  sessionTitle,
  showRepos,
  stageBadge,
  startCycle,
  stepLook,
  stoppedAt,
  stoppedSend,
  subPlanSentence,
  subtaskCount,
  subtaskRows,
  subtaskView,
  type TaskView,
  taskView,
  tellBox,
  ticks,
  timedOutSetup,
  withSetup,
} from "../../src/web/tasks/model";
import { answersOf, QuestionsForm } from "../../src/web/tasks/Questions";
import { TellClaude } from "../../src/web/tasks/TellClaude";

console.log(`tasks-model.test.ts imported from ${Bun.resolveSync("../../src/web/tasks/model", import.meta.dir)}`);

const NOW = 1_800_000_000_000;
const R = "Claude";
const MIN = 60_000;

const step = (o: Partial<TaskStepDto> & Pick<TaskStepDto, "id" | "kind">): TaskStepDto => ({
  part: null,
  ord: o.id,
  run: null,
  state: "ok",
  attempt: 1,
  item: null,
  detail: stepDetail.parse({}),
  startedAt: NOW - 5 * MIN,
  endedAt: NOW - 4 * MIN,
  ...o,
});

const part = (o: Partial<TaskPartDto> = {}): TaskPartDto => ({
  id: 7,
  ord: 1,
  kind: "single",
  title: "Trim spaces in user names",
  branch: "feature/ABC-12-trim-spaces-in-user-names",
  baseBranch: "main",
  pr: null,
  remotePr: null,
  state: "implementing",
  head: "a".repeat(40),
  pushed: null,
  lines: 80,
  usage: null,
  prState: null,
  waiting: [],
  build: null,
  keys: [],
  start: null,
  after: null,
  adopted: false,
  specDir: null,
  bases: [],
  lower: null,
  gate: null,
  wait: null,
  blocked: null,
  instructRun: null,
  ...o,
});

const question = (o: Partial<TaskQuestionDto> = {}): TaskQuestionDto => ({
  id: 1,
  source: "interview",
  round: 1,
  ord: 0,
  text: "Keep the old behavior?",
  why: "It changes the tests.",
  kind: "choice",
  options: [
    { label: "Keep it", detail: "" },
    { label: "Drop it", detail: "" },
  ],
  recommended: 0,
  answer: null,
  step: 1,
  point: null,
  askedAt: NOW,
  answeredAt: null,
  ...o,
});

function task(o: Partial<TaskDto> = {}): TaskDto {
  return {
    id: 1,
    project: "PROJ",
    repo: "repo",
    key: "ABC-12",
    title: "Trim spaces in user names",
    state: "interview",
    size: null,
    blocked: null,
    queued: 0,
    version: 3,
    updatedAt: NOW,
    closedAt: null,
    progress: { planReady: false, part: 0, parts: 0, ready: false, merged: false, building: [], held: 0 },
    interview: null,
    plan: null,
    strip: { steps: ["Questions", "Plan", "Build", "Done"], current: 0 },
    originPr: 5,
    profile: "general",
    stoppedFrom: null,
    sizeBy: null,
    targetBranch: "main",
    baseCommit: null,
    specDir: "specs/ABC-12/",
    specBranch: null,
    estimate: null,
    settings: {},
    docs: null,
    parts: [],
    repos: [],
    prs: [],
    questions: [],
    steps: [],
    createdAt: NOW - 30 * MIN,
    reviewers: [],
    points: [],
    working: false,
    attachments: [],
    files: [],
    bases: [],
    needsBase: null,
    canInstruct: false,
    canUndoUpdate: false,
    canSetup: false,
    subtasks: null,
    issueStatus: null,
    shell: { mode: "allowlist", allow: [], bashTimeoutSec: 600, warned: false, checks: 0 },
    allowAsk: null,
    ...o,
  };
}

const PLAN: NonNullable<TaskDto["plan"]> = {
  proposed: "small",
  minimum: "small",
  rules: [],
  budget: 400,
  missing: 0,
  base: "b".repeat(40),
  commands: [{ id: "new-1", name: "test", kind: "test", argv: ["bun", "test"], timeoutSec: 600, saved: false }],
  warning: true,
  approved: false,
  maxOpen: null,
  starts: [],
  notes: [],
  adding: false,
  contracts: [],
  risks: [],
  checks: [],
  allow: [],
  shellWarning: true,
};
const ESTIMATE: NonNullable<TaskDto["estimate"]> = { parts: 1, lines: 80, files: 1, modules: [], db: false, api: false, unknowns: [] };

const view = (t: TaskDto) => taskView(t, { runner: R, forge: "Bitbucket", now: NOW });
const HELD = { kind: "held" as const, step: 9, part: 7, text: "Part 1 is on hold. Its work is kept." };
const shape = (v: TaskView) => ({
  status: v.status,
  primary: v.primary?.label ?? null,
  more: v.more.map((a) => a.label),
  screen: v.screen,
});
const building = (o: Partial<TaskDto> = {}) =>
  task({ state: "implementing", size: "small", plan: { ...PLAN, approved: true }, estimate: ESTIMATE, parts: [part()], ...o });

describe("the Task view table (spec.md section 6.12, small rows)", () => {
  test("interview, running: Claude reads, no primary, Stop", () => {
    const v = view(task({ steps: [step({ id: 1, kind: "interview", state: "running", startedAt: NOW - 2 * MIN, endedAt: null })] }));
    expect(shape(v)).toEqual({ status: "Claude is reading the task and the code.", primary: null, more: ["Stop"], screen: "questions" });
    expect(v.detail).toBe("Running for 2 minutes.");
    expect(v.running).toBe(true);
  });

  test("interview, questions: the count, Answer N questions, and the recommended answers in More", () => {
    const v = view(
      task({
        blocked: { kind: "question", step: 1, text: "Claude has 2 questions before it writes the plan." },
        questions: [question(), question({ id: 2, ord: 1, kind: "text", options: [], recommended: null })],
        steps: [step({ id: 1, kind: "interview" })],
      }),
    );
    expect(shape(v)).toEqual({
      status: "Claude has 2 questions before it writes the plan.",
      primary: "Answer 2 questions",
      more: ["Use the recommended answers", "Stop"],
      screen: "questions",
    });
    expect(v.needsYou).toBe(true);
  });

  test("spec_draft, running: Claude writes the plan", () => {
    const v = view(task({ state: "spec_draft", steps: [step({ id: 2, kind: "spec", state: "running", endedAt: null })] }));
    expect(shape(v)).toEqual({ status: "Claude is writing the plan.", primary: null, more: ["Stop"], screen: "plan" });
  });

  test("spec_draft, ready: the size, the PR count, the lines, and Approve the plan", () => {
    const v = view(task({ state: "spec_draft", size: "small", plan: PLAN, estimate: ESTIMATE, docs: { plan: "# Plan", version: 1 } }));
    expect(shape(v)).toEqual({
      status: "The plan is ready: small, 1 PR, about 80 changed lines.",
      primary: "Approve the plan",
      more: ["Edit", "Change size", "Stop"],
      screen: "plan",
    });
  });

  test("spec_draft, approved medium: the plan waits, and the view says that this version cannot open the spec PR", () => {
    const v = view(task({ state: "spec_draft", size: "medium", plan: { ...PLAN, approved: true }, estimate: ESTIMATE }));
    expect(v.primary).toBeNull();
    expect(v.status).toContain("cannot open that PR yet");
  });

  test("implementing, running: the step sentence names Claude and your change, with Hold", () => {
    const v = view(building({ steps: [step({ id: 9, kind: "tests", part: 7, item: "P1", state: "running", endedAt: null })] }));
    expect(shape(v)).toEqual({
      status: "Claude builds your change.",
      primary: null,
      more: ["Hold", "Stop"],
      screen: "build",
    });
  });

  test("implementing, checks: the app runs the checks, Stop only", () => {
    const v = view(building({ steps: [step({ id: 9, kind: "check", part: 7, item: "T1.1", state: "running", endedAt: null })] }));
    expect(shape(v)).toEqual({ status: "The app runs the checks of your change.", primary: null, more: ["Stop"], screen: "build" });
  });

  test("implementing, own review: a second Claude run reviews your change", () => {
    const v = view(building({ steps: [step({ id: 9, kind: "review", part: 7, state: "running", endedAt: null })] }));
    expect(v.status).toBe("A second Claude run reviews your change.");
  });

  test("implementing, ready: Your change is ready with its facts, Open the PR, Fix these too, and Start this part again", () => {
    const v = view(
      building({
        parts: [part({ state: "self_reviewed" })],
        points: [{ id: 3, severity: "minor", path: "src/a.ts", line: 2, text: "Name the lock." }],
      }),
    );
    expect(shape(v)).toEqual({
      status: "Your change is ready: 80 lines.",
      primary: "Open the PR",
      more: ["Show the diff", "Fix these too", "Start this part again"],
      screen: "ready",
    });
  });

  test("spec.md section 6.7: Run setup again stands before Stop for a part with a worktree, and never while a step runs", () => {
    // loop.ts setupAgainOf: a reason of the task refuses it, except a red setup of this part.
    const red = building({
      blocked: { kind: "red", cause: "setup", step: 4, text: "Needs you: the setup of part 1 failed." },
      steps: [step({ id: 4, kind: "check", part: 7, item: "setup", state: "failed" })],
      canSetup: true,
    });
    const at = (t: TaskDto) => withSetup(t, t.parts[0] ?? null, view(t)).more.map((a) => a.label);
    expect(at(red)).toEqual(["See why", "Run setup again", "Stop"]);
    const checks = { ...red, blocked: { kind: "red" as const, cause: "checks" as const, step: 5, text: "Needs you: red." } };
    expect(at({ ...checks, steps: [step({ id: 5, kind: "check", part: 7, item: "checks", state: "failed" })] })).not.toContain(
      "Run setup again",
    );
    expect(at({ ...red, steps: [step({ id: 4, kind: "check", part: 8, item: "setup", state: "failed" })] })).not.toContain(
      "Run setup again",
    );
    const ready = building({ parts: [part({ state: "self_reviewed" })], canSetup: true });
    expect(at(ready)).toEqual(["Show the diff", "Start this part again", "Run setup again"]);
    expect(at({ ...ready, canSetup: false })).toEqual(["Show the diff", "Start this part again"]);
    expect(at({ ...ready, parts: [part({ state: "planned" })] })).not.toContain("Run setup again");
    const running = building({ steps: [step({ id: 9, kind: "tests", part: 7, state: "running", endedAt: null })], canSetup: true });
    expect(at(running)).toEqual(["Hold", "Stop"]);
  });

  test("implementing, ready while the loop works between steps: no Open the PR", () => {
    const v = view(building({ parts: [part({ state: "self_reviewed" })], working: true }));
    expect(v.primary).toBeNull();
    expect(v.status).toBe("The app prepares the next step.");
  });

  test("spec.md section 6.7: a red setup with a command at its time limit offers Change the time limit first", () => {
    const text = 'Needs you: the setup command "venv" of part 1 reached its time limit of 10 min.';
    const late = { name: "venv", argv: ["python"], exit: null, ms: 600_000, tail: "", timedOut: true, timeoutSec: 600 };
    const setupStep = (timedOut: boolean) =>
      step({
        id: 4,
        kind: "check",
        part: 7,
        item: "setup",
        state: "failed",
        detail: stepDetail.parse({ commands: [{ ...late, timedOut }] }),
      });
    const t = building({ blocked: { kind: "red", cause: "setup_time", step: 4, text }, steps: [setupStep(true)], canSetup: true });
    expect(shape(view(t))).toEqual({
      status: text,
      primary: "Change the time limit",
      more: ["See why", "Continue", "Stop"],
      screen: "build",
    });
    expect(timedOutSetup(t)).toMatchObject({ name: "venv", timeoutSec: 600 });
    expect(withSetup(t, t.parts[0] ?? null, view(t)).more.map((a) => a.label)).toEqual(["See why", "Continue", "Run setup again", "Stop"]);
    // A failed setup without a time limit, and a check that is no setup, take Continue.
    expect(view({ ...t, steps: [setupStep(false)] }).primary?.label).toBe("Continue");
    expect(view({ ...t, steps: [{ ...setupStep(true), item: "T1.1" }] }).primary?.label).toBe("Continue");
  });

  test("blocked red: the server sentence, Continue, then See why and Stop", () => {
    const text = "Needs you: the tests of part 1 stay red after 3 tries.";
    const v = view(building({ blocked: { kind: "red", step: 4, text } }));
    expect(shape(v)).toEqual({ status: text, primary: "Continue", more: ["See why", "Stop"], screen: "build" });
    expect(v.primary?.kind).toBe("resume");
  });

  test("spec.md section 6.21.4: blocked allow: the server sentence, Continue, and Stop; no Resume and no Tell box", () => {
    const text = "Needs you: Claude asks to allow a command.";
    const allowAsk = { step: 4, requests: [{ pattern: "make build", command: "make build", reason: "It builds." }], warning: false };
    const t = building({ blocked: { kind: "allow", step: 4, text }, allowAsk });
    expect(shape(view(t))).toEqual({ status: text, primary: "Continue", more: ["Stop"], screen: "build" });
    expect(view(t).primary?.kind).toBe("allow");
    expect(tellBox(t)).toBe("none");
    // Without the request the page cannot send a choice, so no primary button shows.
    expect(view({ ...t, allowAsk: null }).primary).toBeNull();
  });

  test("AC-B375: blocked blocker: Continue, then Go on without these fixes, See why, and Stop", () => {
    const v = view(building({ blocked: { kind: "blocker", step: 4, text: "Needs you: Claude's review of part 1 still finds 1 point." } }));
    expect(shape(v)).toMatchObject({ primary: "Continue", more: ["Go on without these fixes", "See why", "Stop"] });
    expect([v.primary?.kind, v.more[0]?.kind]).toEqual(["resume", "without"]);
  });

  test("blocked question with a question row: Answer the question on the questions screen", () => {
    const v = view(
      building({
        blocked: { kind: "question", step: 5, text: "Needs you: Claude asks: how to handle empty input?" },
        questions: [question({ id: 9, source: "loop", round: 2, step: 5 })],
      }),
    );
    expect(shape(v)).toEqual({
      status: "Needs you: Claude asks: how to handle empty input?",
      primary: "Answer the question",
      more: ["Stop"],
      screen: "questions",
    });
  });

  test("blocked question without a question row (pause): Continue", () => {
    const v = view(building({ blocked: { kind: "question", step: null, text: "Building is paused after the step. Continue?" } }));
    expect(shape(v)).toMatchObject({ primary: "Continue", more: ["Stop"] });
  });

  test("check-fix.md: a question of the app that names a step, such as a fix step that changed no file, adds See why", () => {
    const text = "Needs you: the fix step of part 1 changed no file. See why.";
    const v = view(building({ blocked: { kind: "question", step: 7, text } }));
    expect(shape(v)).toEqual({ status: text, primary: "Continue", more: ["See why", "Stop"], screen: "build" });
  });

  test("ps5-plan.md section 4.6: a legacy size reason takes the plain Continue row; size/large_repos has Stop only", () => {
    const text = "Needs you: this PR would have 520 changed lines, over your 400 limit.";
    const v = view(building({ blocked: { kind: "size", step: 6, text } }));
    expect(shape(v)).toEqual({ status: text, primary: "Continue", more: ["See why", "Stop"], screen: "build" });
    const large = view(building({ blocked: { kind: "size", cause: "large_repos", step: null, text: "Needs you: x." } }));
    expect([large.primary?.kind, large.more]).toEqual(["stop", []]);
  });

  test("blocked spec_change: Review the change, Reject in More", () => {
    const v = view(building({ blocked: { kind: "spec_change", step: 6, text: "Needs you: Claude proposes a change to the spec." } }));
    expect(shape(v)).toEqual({
      status: "Needs you: Claude proposes a change to the spec.",
      primary: "Review the change",
      more: ["Reject", "Stop"],
      screen: "change",
    });
  });

  test("blocked budget, a legacy kind: Continue and Stop", () => {
    const v = view(
      building({ blocked: { kind: "budget", step: null, text: "Needs you: part 1 used its 120 min. Continue with 60 more min?" } }),
    );
    expect(shape(v)).toMatchObject({ primary: "Continue", more: ["Stop"] });
  });

  test("blocked denied_path: the sentence with the paths, Continue, See why, and Stop", () => {
    const text = "Needs you: the step changed .claude/settings.json, which the app does not commit.";
    const v = view(building({ blocked: { kind: "denied_path", step: 6, text } }));
    expect(shape(v)).toEqual({ status: text, primary: "Continue", more: ["See why", "Stop"], screen: "build" });
  });

  test("blocked error: one sentence with the cause, Continue", () => {
    const v = view(
      building({ blocked: { kind: "error", step: null, text: "Needs you: set user.name and user.email in your git config." } }),
    );
    expect(shape(v)).toMatchObject({ primary: "Continue", more: ["Stop"] });
  });

  test("blocked slot: the wait, no primary, Stop", () => {
    const text = "Waiting for your review of PR 12 to finish.";
    const v = view(
      building({ blocked: { kind: "slot", step: 6, text }, steps: [step({ id: 6, kind: "tests", state: "waiting", endedAt: null })] }),
    );
    expect(shape(v)).toEqual({ status: text, primary: null, more: ["Stop"], screen: "build" });
    expect(v.needsYou).toBe(false);
  });

  test("stopped in the build: the work is kept, Continue, Start this part again while unpushed, and Close the task", () => {
    const v = view(
      building({
        state: "stopped",
        stoppedFrom: "implementing",
        blocked: { kind: "error", step: null, text: "The run was cancelled." },
        steps: [step({ id: 9, kind: "check", part: 7, item: "T1.1", state: "failed" })],
      }),
    );
    expect(shape(v)).toEqual({
      status: "Stopped. The work is kept.",
      primary: "Continue",
      more: ["Start this part again", "Close the task"],
      screen: "build",
    });
    expect([v.primary?.kind, v.more[0]?.part, v.detail]).toEqual(["resume", 7, "The run was cancelled."]);
  });

  test("ready: waiting for the named reviewers, Go to the PR, Close the task", () => {
    const v = view(
      building({ state: "ready", parts: [part({ state: "pr_open", remotePr: 101, prState: "OPEN", waiting: ["Anna Lee"] })] }),
    );
    expect(shape(v)).toEqual({
      status: "Waiting for Anna Lee's review. Nothing to do.",
      primary: "Go to the PR",
      more: ["Close the task"],
      screen: "pr",
    });
  });

  // docs/plans/ci-builds.md, Layer A: the build rows come after the "not pushed" row.
  test("ready with a build: failed needs you, running and passed wait; Go to the PR stays", () => {
    const b = (state: BuildDto["state"], builds: BuildDto["builds"]): BuildDto => ({
      head: "a".repeat(40),
      state,
      counts: { successful: 1, inProgress: state === "running" ? 1 : 0, failed: state === "failed" ? 1 : 0, cancelled: 0, unknown: 0 },
      builds,
      readAt: NOW,
    });
    const at = (build: BuildDto | null) =>
      view(building({ state: "ready", parts: [part({ state: "pr_open", remotePr: 101, prState: "OPEN", waiting: ["Anna Lee"], build })] }));
    const failed = at(b("failed", [{ name: "unit tests", state: "FAILED", url: null }]));
    expect(shape(failed)).toEqual({
      status: "The build of your PR failed: unit tests.",
      primary: "Go to the PR",
      more: ["Close the task"],
      screen: "pr",
    });
    expect(failed.needsYou).toBe(true);
    expect(at(b("failed", null)).status).toBe("The build of your PR failed.");
    const running = at(b("running", []));
    expect(running.status).toBe("Waiting for Anna Lee's review. The build runs.");
    expect(running.needsYou).toBe(false);
    expect(at(b("passed", [])).status).toBe("Waiting for Anna Lee's review. The build passed.");
    expect(at(b("other", [])).status).toBe("Waiting for Anna Lee's review. Nothing to do.");
    // A part without a PR has no build row.
    const unopened = building({ state: "ready", parts: [part({ state: "pr_open", build: b("failed", []) })] });
    expect(prBuild(unopened)).toBeNull();
  });

  test("ready with a merged PR: Done, Close the task", () => {
    const v = view(building({ state: "ready", parts: [part({ state: "pr_open", remotePr: 101, prState: "MERGED" })] }));
    expect(shape(v)).toMatchObject({ status: "Done. The PR merged.", primary: "Close the task" });
  });

  test("done: Close the task, then Closed with no primary", () => {
    expect(shape(view(building({ state: "done" })))).toMatchObject({ status: "Done. The PR merged.", primary: "Close the task" });
    expect(shape(view(building({ state: "done", closedAt: NOW })))).toMatchObject({ primary: null, screen: "end" });
  });

  test("failed: the reason and no action", () => {
    const v = view(building({ state: "failed", blocked: { kind: "error", step: null, text: "The repository is gone." } }));
    expect(shape(v)).toMatchObject({ status: "The task failed: The repository is gone.", primary: null, more: [] });
  });
});

describe("rules over every row (spec.md section 7.1)", () => {
  const all = (): TaskDto[] => [
    task(),
    task({ blocked: { kind: "question", step: 1, text: "x" }, questions: [question()] }),
    task({ state: "spec_draft", size: "small", plan: PLAN, estimate: ESTIMATE }),
    ...(["red", "blocker", "question", "budget", "size", "spec_change", "denied_path", "push", "slot", "error"] as const).map((kind) =>
      building({ blocked: { kind, step: null, text: `Needs you: ${kind}.` } }),
    ),
    building({ parts: [part({ state: "self_reviewed" })] }),
    building({ state: "stopped", stoppedFrom: "implementing" }),
    building({ state: "ready", parts: [part({ state: "pr_open", remotePr: 1 })] }),
    building({ state: "done" }),
    // spec.md section 6.18.5.
    ...Object.values(tellRows()),
    // ps5-plan.md sections 3, 4.2, and 4.3.
    building({ parts: [part({ blocked: HELD })] }),
    building({ state: "stopped", stoppedFrom: "implementing", parts: [part({ blocked: HELD })] }),
    building({ blocked: { kind: "usage", step: 4, text: "x", resumeAt: NOW + 30 * MIN, armed: false } }),
    building({ blocked: { kind: "usage", step: 4, text: "x", resumeAt: NOW + 30 * MIN, armed: true } }),
    building({ blocked: { kind: "usage", step: 4, text: "x" } }),
    ...(
      [
        ["red", "checks"],
        ["question", "no_change"],
        ["error", "run"],
        ["stuck", "stall"],
      ] as const
    ).map(([kind, cause]) => building({ blocked: { kind, cause, step: 4, text: `Needs you: ${kind}.` } })),
    // ps5-plan.md section 3: the rows in ready with Leave it, the push row, a build stop, and the large size reason.
    ...(["red", "blocker", "denied_path", "question", "update", "preflight", "error"] as const).map((kind) =>
      building({
        state: "ready",
        parts: [part({ ...PR_PART })],
        canUndoUpdate: kind === "red",
        blocked: { kind, step: 4, text: `Needs you: ${kind}.` },
      }),
    ),
    building({ state: "ready", parts: [part({ ...PR_PART, head: "d".repeat(40) })] }),
    building({ state: "stopped", stoppedFrom: "implementing", parts: [part({ id: 6, state: "self_reviewed" }), part({ ord: 2 })] }),
    building({ blocked: { kind: "size", cause: "large_repos", step: null, text: "Needs you: size." } }),
  ];

  test("AC-UX1: at most one primary action, and no primary action also in More", () => {
    for (const t of all()) {
      const v = view(t);
      expect(v.more.some((a) => a.kind === v.primary?.kind)).toBe(false);
    }
  });

  test("AC-UX3: every state has one status sentence that ends with a full stop or a question mark", () => {
    for (const t of all()) expect(view(t).status).toMatch(/^\S.*[.?]$/);
  });
});

// ---------- Tell Claude and Update from the base branch (spec.md section 6.18, WP-TU2) ----------

const REL = "release/2.1";
const PR_PART = { state: "pr_open" as const, remotePr: 101, prState: "OPEN", pushed: "a".repeat(40), waiting: ["Anna Lee"] };
const moved = (n = 5, o: Partial<TaskDto["bases"][number]> = {}) => [
  { taskRepo: 1, branch: REL, newCommits: n, conflicted: false, changed: false, ...o },
];
const instruct = (o: Partial<TaskStepDto> & { result?: "done" | "no_change" | "stopped" | "failed" | null; notes?: string[] }) =>
  step({
    id: 30,
    kind: "instruct",
    part: 7,
    item: "I1",
    // A send that ran has its run. A message that waits for its run has none (ps4-plan.md WP-7).
    run: 300,
    ...o,
    detail: stepDetail.parse({
      instruct: { text: "Rename the flag to useNewParser.", part: 7, blockedBefore: null, result: o.result ?? null },
      notes: o.notes ?? [],
      summary: "Echo: the flag is named well.",
    }),
  });
const updateStep = (o: Partial<TaskStepDto> = {}) =>
  step({
    id: 40,
    kind: "update",
    part: 7,
    item: "U1",
    state: "running",
    endedAt: null,
    detail: stepDetail.parse({
      update: { repos: [{ taskRepo: 1, base: REL, mode: "merge", newBaseHead: "c".repeat(40) }], preHeads: [] },
    }),
    ...o,
  });

// One task per row of the spec.md section 6.18.5 table, and the waits with the box.
function tellRows() {
  const ready = building({ parts: [part({ state: "self_reviewed" })], targetBranch: REL, canInstruct: true });
  const open = building({ state: "ready", parts: [part(PR_PART)], targetBranch: REL, canInstruct: true });
  return {
    ready,
    open,
    baseMoved: { ...ready, bases: moved() },
    conflicts: { ...open, bases: moved(0, { conflicted: true }) },
    openMoved: { ...open, bases: moved() },
    asks: { ...ready, bases: moved(), needsBase: { reason: "the new parser API is only on release/2.1" } },
    updating: { ...open, canInstruct: false, steps: [updateStep()] },
    resolving: {
      ...open,
      canInstruct: false,
      steps: [
        step({
          id: 41,
          kind: "resolve",
          part: 7,
          item: "U1",
          state: "running",
          endedAt: null,
          detail: stepDetail.parse({ resolve: { taskRepo: 1, paths: ["src/a.ts"] } }),
        }),
        updateStep(),
      ],
    },
    updateRed: {
      ...open,
      canUndoUpdate: true,
      blocked: { kind: "red" as const, step: 42, text: `Needs you: the tests fail after the update from ${REL}.` },
    },
    updateStopped: {
      ...open,
      blocked: {
        kind: "update" as const,
        step: 40,
        text: `The update from ${REL} stopped: conflict markers remain in src/a.ts. The branch is as it was.`,
      },
    },
    instructRunning: { ...open, canInstruct: false, steps: [instruct({ state: "running", endedAt: null })] },
    notPushed: { ...open, parts: [part({ ...PR_PART, head: "d".repeat(40) })] },
  };
}

describe("the rows of Update from the base branch and Tell Claude (spec.md section 6.18.5)", () => {
  const rows = tellRows();

  test("implementing, base moved (before the PR): the count, Update from <base>, and Open the PR as is in More", () => {
    expect(shape(view(rows.baseMoved))).toEqual({
      status: "release/2.1 has 5 new commits since the branch point.",
      primary: "Update from release/2.1",
      more: ["Open the PR as is", "Show the diff", "Start this part again"],
      screen: "ready",
    });
  });

  test("waiting, PR conflicts: the forge reports conflicts, Update from <base>, Go to the PR in More", () => {
    expect(shape(view(rows.conflicts))).toEqual({
      status: "Bitbucket reports conflicts between your PR and release/2.1.",
      primary: "Update from release/2.1",
      more: ["Go to the PR", "Close the task"],
      screen: "pr",
    });
  });

  test("waiting, base moved (PR open): the review wait first, Update from <base> in More", () => {
    expect(shape(view(rows.openMoved))).toEqual({
      status: "Waiting for Anna Lee's review. release/2.1 has 5 new commits.",
      primary: "Go to the PR",
      more: ["Update from release/2.1", "Close the task"],
      screen: "pr",
    });
  });

  test("Claude asks for the base: the reason, Update from <base>, and the More items of the state before", () => {
    expect(shape(view(rows.asks))).toEqual({
      status: "Claude says the branch needs the newest release/2.1: the new parser API is only on release/2.1.",
      primary: "Update from release/2.1",
      more: ["Open the PR as is", "Show the diff", "Start this part again"],
      screen: "ready",
    });
  });

  test("AC-B55: Claude asks, but the base did not move: the line under the status and no Update button", () => {
    const v = view({ ...rows.asks, bases: moved(0) });
    expect(v.detail).toBe("Claude asked for the newest release/2.1. The branch already has it.");
    expect(v.primary?.label).toBe("Open the PR");
    expect([v.primary, ...v.more].some((a) => a?.kind === "update")).toBe(false);
  });

  test("updating: the mode of the update, then the files of a resolve step; Stop only", () => {
    expect(shape(view(rows.updating))).toEqual({
      status: "Updating your change from release/2.1: merging.",
      primary: null,
      more: ["Stop"],
      screen: "build",
    });
    expect(shape(view(rows.resolving))).toMatchObject({ status: "Claude resolves the conflicts in src/a.ts.", more: ["Stop"] });
    // Before the update step writes its repositories, the bases of the task name the label.
    const early = updateStep({ detail: stepDetail.parse({}) });
    expect(view({ ...rows.updating, bases: moved(), steps: [early] }).status).toBe("Updating your change from release/2.1.");
  });

  test("ps5-plan.md D8: update red: Continue, then Undo the update, See why, Stop, and Leave it in ready", () => {
    expect(shape(view(rows.updateRed))).toEqual({
      status: "Needs you: the tests fail after the update from release/2.1.",
      primary: "Continue",
      more: ["Undo the update", "See why", "Stop", "Leave it"],
      screen: "build",
    });
  });

  // part-session.md section 9.4 rule 9: "Leave it" replaces Dismiss. loop.ts leaveReason refuses only in implementing and for a reason
  // with its own form: a plan change, an allow request, and an open question.
  test("ps5-plan.md section 3: a reason in ready takes Continue, and Leave it stands last in More", () => {
    const of = (kind: NonNullable<TaskDto["blocked"]>["kind"], step: number | null, o: Partial<TaskDto> = {}) =>
      shape(view({ ...rows.open, blocked: { kind, step, text: `Needs you: ${kind}.` }, ...o }));
    expect(of("red", 42)).toMatchObject({ primary: "Continue", more: ["See why", "Stop", "Leave it"] });
    expect(of("blocker", 43)).toMatchObject({ primary: "Continue", more: ["Go on without these fixes", "See why", "Stop", "Leave it"] });
    expect(of("denied_path", null)).toMatchObject({ primary: "Continue", more: ["Stop", "Leave it"] });
    expect(of("size", 44)).toMatchObject({ primary: "Continue", more: ["See why", "Stop", "Leave it"] });
    expect(of("question", 45)).toMatchObject({ primary: "Continue", more: ["See why", "Stop", "Leave it"] });
    expect(of("preflight", null)).toMatchObject({ primary: "Try again", more: ["Stop", "Leave it"] });
    const asked = { questions: [question({ source: "loop", step: 45 })] };
    expect(of("question", 45, asked)).toMatchObject({ primary: "Answer the question", more: ["Stop"] });
    expect(of("spec_change", 46).more).not.toContain("Leave it");
    const allowAsk = { step: 47, requests: [{ pattern: "make", command: "make", reason: "It builds." }], warning: false };
    expect(of("allow", 47, { allowAsk }).more).toEqual(["Stop"]);
    const leave = view({ ...rows.open, blocked: { kind: "red", step: 42, text: "Needs you: red." } }).more.at(-1);
    expect(leave).toEqual({ kind: "leave", label: "Leave it" });
    // The same reason during the build has no Leave it: the server takes it in ready only.
    expect(shape(view(building({ blocked: { kind: "denied_path", step: null, text: "Needs you: x." } })))).toMatchObject({
      primary: "Continue",
      more: ["Stop"],
    });
  });

  test("update stopped: the reason with 'The branch is as it was.', Try again, Go to the PR in More", () => {
    expect(shape(view(rows.updateStopped))).toEqual({
      status: "The update from release/2.1 stopped: conflict markers remain in src/a.ts. The branch is as it was.",
      primary: "Try again",
      more: ["Go to the PR", "Leave it"],
      screen: "pr",
    });
  });

  test("instruct running: Claude works on your instructions, with the part when the task has more; Stop only", () => {
    expect(shape(view(rows.instructRunning))).toEqual({
      status: "Claude works on your instructions for your change.",
      primary: null,
      more: ["Stop"],
      screen: "build",
    });
    const two = { ...rows.instructRunning, parts: [part({ ...PR_PART, id: 6 }), part({ ...PR_PART, id: 7, ord: 2 })] };
    expect(view(two).status).toBe("Claude works on your instructions for part 2.");
    // The checks of a send also end by themselves: no Hold.
    const checks = step({ id: 31, kind: "check", part: 7, item: "I1", state: "running", endedAt: null });
    expect(view({ ...rows.ready, canInstruct: false, steps: [checks, instruct({})] }).more.map((a) => a.label)).toEqual(["Stop"]);
  });

  test("ps5-plan.md section 3: not pushed: Push to <branch> sends POST /parts/:part/push, and Show the diff stays in More", () => {
    const v = view(rows.notPushed);
    expect(shape(v)).toEqual({
      status: "Your change has new commits that are not on the server yet.",
      primary: "Push to feature/ABC-12-trim-spaces-in-user-names",
      more: ["Show the diff", "Go to the PR", "Close the task"],
      screen: "pr",
    });
    expect([v.primary?.kind, v.needsYou, sendOf("push", 7)]).toEqual(["push", true, { kind: "push", part: 7 }]);
  });

  test("several repositories: one label for two bases, and one line per repository, deepest first", () => {
    const repos: TaskDto["repos"] = [
      {
        id: 1,
        role: "main",
        project: "PROJ",
        repo: "app",
        path: null,
        depth: 0,
        access: "edit",
        reason: null,
        baseBranch: REL,
        proposal: null,
        proposalReason: null,
      },
      {
        id: 2,
        role: "submodule",
        project: "PROJ",
        repo: "lib",
        path: "lib",
        depth: 1,
        access: "edit",
        reason: null,
        baseBranch: "develop",
        proposal: null,
        proposalReason: null,
      },
    ];
    const bases = [...moved(5), { taskRepo: 2, branch: "develop", newCommits: 1, conflicted: false, changed: false }];
    const v = view({ ...rows.baseMoved, repos, bases });
    expect(v.primary?.label).toBe("Update from 2 base branches");
    expect(v.status).toBe("The base branches have new commits since the branch point.");
    expect(v.lines).toEqual(["PROJ/lib from develop · 1 new commit", "PROJ/app from release/2.1 · 5 new commits"]);
    // The same base in both repositories names it once.
    const same = view({ ...rows.baseMoved, repos, bases: bases.map((b) => ({ ...b, branch: REL })) });
    expect(same.primary?.label).toBe("Update from release/2.1");
    expect(same.status).toBe("release/2.1 has new commits in 2 repositories since the branch point.");
  });

  test("AC-B344: a reason after the PR opened takes Continue, because the server takes it in ready too; Leave it is the way back", () => {
    const red = view({ ...rows.open, blocked: { kind: "red", step: 4, text: "Needs you: the tests of part 1 stay red after 3 tries." } });
    expect(shape(red)).toMatchObject({ primary: "Continue", more: ["See why", "Stop", "Leave it"] });
    const denied = view({ ...rows.open, blocked: { kind: "denied_path", step: 4, text: "Needs you: the step changed .env." } });
    expect(shape(denied)).toMatchObject({ primary: "Continue", more: ["See why", "Stop", "Leave it"] });
    expect(denied.needsYou).toBe(true);
  });

  test("AC-B56: a stopped send gives its text back, and the status line says so; a later send replaces it", () => {
    const note = "Stopped. Your instructions changed nothing. The text is back in the box.";
    const stopped = { ...rows.ready, steps: [instruct({ state: "cancelled", result: "stopped", notes: [note] })] };
    expect(stoppedSend(stopped)).toEqual({ id: 30, text: "Rename the flag to useNewParser." });
    expect(view(stopped).detail).toBe(note);
    expect(view(stopped).primary?.label).toBe("Open the PR");
    const later = { ...stopped, steps: [instruct({ id: 32, item: "I2", result: "done" }), ...stopped.steps] };
    expect(stoppedSend(later)).toBeNull();
    expect(view(later).detail).toBeNull();
  });
});

describe("AC-B52: the Tell Claude box shows in the states of spec.md section 6.18.1 and in no other state", () => {
  const rows = tellRows();
  const blockedAs = (kind: NonNullable<TaskDto["blocked"]>["kind"], o: Partial<TaskDto> = {}) =>
    building({
      parts: [part({ state: "self_reviewed" })],
      canInstruct: true,
      blocked: { kind, step: 4, text: `Needs you: ${kind}.` },
      ...o,
    });

  test("the waits after the build started and the reasons red, size, blocker, denied_path, and update: the box can send", () => {
    const withBox: Record<string, TaskDto> = {
      "implementing, ready": rows.ready,
      "implementing, waiting (an earlier part in review)": building({ parts: [part(PR_PART)], canInstruct: true }),
      "implementing, lower merged": building({
        parts: [part({ id: 6, state: "merged" }), part({ ...PR_PART, id: 7, ord: 2 })],
        canInstruct: true,
      }),
      "implementing, base moved": rows.baseMoved,
      "implementing, not pushed": rows.notPushed,
      ready: rows.open,
      "waiting, PR conflicts": rows.conflicts,
      "Claude asks for the base": rows.asks,
      "update red": rows.updateRed,
      "update stopped": rows.updateStopped,
      "blocked red": blockedAs("red"),
      "blocked size": blockedAs("size"),
      "blocked blocker": blockedAs("blocker"),
      "blocked denied_path": blockedAs("denied_path"),
      // A reason of the build itself: the part has a worktree, but is not built yet.
      "blocked red in the build": blockedAs("red", { parts: [part()] }),
    };
    for (const [name, t] of Object.entries(withBox)) expect([name, tellBox(t)]).toEqual([name, "open"]);
  });

  test("while a send, an update, or a check of them runs, the box stays and waits", () => {
    for (const t of [rows.instructRunning, rows.updating, rows.resolving]) expect(tellBox(t)).toBe("busy");
    // A send from a reason of the build: the part is not built, and the send runs.
    const fromBuild = building({ parts: [part()], steps: [instruct({ state: "running", endedAt: null })] });
    expect(tellBox(fromBuild)).toBe("busy");
    // ps5-plan.md section 4.10: the first build has the box too. The checks keep it busy.
    const checks = building({ steps: [step({ id: 9, kind: "check", part: 7, item: "T1.1", state: "running", endedAt: null })] });
    expect(tellBox(checks)).toBe("busy");
  });

  test("no box before a worktree exists, for the other reasons, in a stopped, failed, or done task, and in the first build", () => {
    const without: Record<string, TaskDto> = {
      interview: task({ canInstruct: false }),
      spec_draft: task({ state: "spec_draft", plan: PLAN }),
      spec_pr_open: task({ state: "spec_pr_open" }),
      spec_approved: task({ state: "spec_approved" }),
      "blocked question": blockedAs("question"),
      "blocked spec_change": blockedAs("spec_change"),
      "blocked budget": blockedAs("budget"),
      "blocked slot": blockedAs("slot"),
      "blocked preflight": blockedAs("preflight"),
      "blocked push": blockedAs("push"),
      "blocked error": blockedAs("error"),
      stopped: building({ state: "stopped", stoppedFrom: "implementing", parts: [part({ state: "self_reviewed" })] }),
      failed: building({ state: "failed", parts: [part({ state: "self_reviewed" })] }),
      done: building({ state: "done", parts: [part({ ...PR_PART, state: "merged" })] }),
      "ready, every PR merged": building({ state: "ready", parts: [part({ ...PR_PART, state: "merged", prState: "MERGED" })] }),
      "implementing, no part yet": building({ parts: [] }),
      // A held part goes on by Continue only, and the server refuses a send there.
      "implementing, on hold": building({ parts: [part({ blocked: HELD })], canInstruct: true }),
    };
    for (const [name, t] of Object.entries(without)) expect([name, tellBox(t)]).toEqual([name, "none"]);
  });
});

describe("AC-B57: the 'Your instructions' group of the Log tab (spec.md section 6.18.1, Step history)", () => {
  const commit = step({
    id: 33,
    kind: "commit",
    part: 7,
    item: "I1",
    detail: stepDetail.parse({ diffStat: { files: 3, added: 9, removed: 2, lines: 11 } }),
  });
  const steps = [
    step({ id: 35, kind: "push", part: 7, item: null }),
    step({ id: 34, kind: "review", part: 7, item: "review" }),
    commit,
    step({ id: 32, kind: "fix", part: 7, item: "I1" }),
    step({ id: 31, kind: "check", part: 7, item: "I1" }),
    instruct({ result: "done" }),
    step({ id: 29, kind: "review", part: 7, item: "review" }),
    step({ id: 28, kind: "implement", part: 7, item: "T1" }),
  ];
  const group = (rows: ReturnType<typeof logRows>) => rows.find((r): r is SendGroup => "send" in r) as SendGroup;

  test("the send holds its checks, fixes, commit, and own review; the steps before and after it stay rows", () => {
    const rows = logRows(steps);
    expect(rows.map((r) => ("send" in r ? `group ${r.send.id}` : `step ${r.step.id}`))).toEqual([
      "step 35",
      "group 30",
      "step 29",
      "step 28",
    ]);
    expect(group(rows).steps.map((s) => s.id)).toEqual([34, 33, 32, 31]);
  });

  test("the result line of each end of a send", () => {
    expect(sendResult(group(logRows(steps)), R)).toBe("Done: 3 files changed. Checks green. Checked by Claude.");
    const one = (o: Parameters<typeof instruct>[0]) => ({ send: instruct(o), steps: [] });
    expect(sendResult(one({ result: "no_change" }), R)).toBe("Claude changed no file: Echo: the flag is named well.");
    expect(sendResult(one({ result: "stopped" }), R)).toBe("Stopped");
    expect(sendResult(one({ result: "failed", notes: ["Failed: the usage limit is reached."] }), R)).toBe(
      "Failed: the usage limit is reached.",
    );
    expect(sendResult(one({ state: "running", endedAt: null }), R)).toBe("Running");
  });
});

describe("plain-word helpers", () => {
  test("elapsed says the time so far, never a time left", () => {
    expect(elapsed(20_000)).toBe("Started less than a minute ago.");
    expect(elapsed(MIN)).toBe("Running for 1 minute.");
    expect(elapsed(9 * MIN)).toBe("Running for 9 minutes.");
  });

  test("stoppedAt names the part only when the task has more parts", () => {
    const two = building({
      parts: [part(), part({ id: 8, ord: 2, title: "Second" })],
      steps: [step({ id: 3, kind: "implement", part: 8, item: "T2.3", state: "failed" })],
    });
    expect(stoppedAt(two)).toBe("Stopped at: part 2, task T2.3, writing the code.");
    expect(stoppedAt(task())).toBe("Stopped.");
  });

  test("planSentence counts PRs by size", () => {
    expect(planSentence(task({ size: "medium", estimate: { ...ESTIMATE, lines: 300 } }))).toBe(
      "The plan is ready: medium, 1 code PR, about 300 changed lines.",
    );
    expect(planSentence(task({ size: "large", estimate: { ...ESTIMATE, parts: 4, lines: 1300 } }))).toBe(
      "The plan is ready: large, 4 parts, about 1,300 changed lines.",
    );
  });
});

describe("the Log tab state of a step (spec.md section 6.7, AC-B10)", () => {
  const look = (o: Partial<TaskStepDto>) => STEP_TEXT[stepLook(step({ id: 4, kind: "check", item: "P1", ...o }))];

  test("the red checks of the tests step read as expected", () => {
    expect(look({ state: "failed", detail: stepDetail.parse({ expectRed: true }) })).toBe("Red as expected");
  });

  test("a red check that no step expects stays a failure, and an old row without the flag too", () => {
    expect(look({ state: "failed", item: "T1.1", detail: stepDetail.parse({ expectRed: false }) })).toBe("Failed");
    expect(look({ state: "failed", detail: stepDetail.parse({}) })).toBe("Failed");
    expect(look({ state: "ok", detail: stepDetail.parse({ expectRed: true }) })).toBe("Done");
    expect(look({ state: "cancelled", detail: stepDetail.parse({ expectRed: true }) })).toBe("Cancelled");
  });

  test("the red checks on the part base read as red before this task; green ones are done", () => {
    expect(look({ state: "failed", item: "base", detail: stepDetail.parse({ baseline: true }) })).toBe("Red before this task");
    expect(look({ state: "ok", item: "base", detail: stepDetail.parse({ baseline: true }) })).toBe("Done");
    expect(stepLook(step({ id: 4, kind: "check", item: "base", state: "failed", detail: stepDetail.parse({ baseline: true }) }))).toBe(
      "before",
    );
  });
});

describe("the branch line of the plan (spec.md section 6.8)", () => {
  test("a small task names its branch; a larger one names the start of its branches", () => {
    expect(plannedBranch("feature/", task(), "small")).toBe("feature/ABC-12-trim-spaces-in-user-names");
    expect(plannedBranch("", task(), "small")).toBe("ABC-12-trim-spaces-in-user-names");
    expect(plannedBranch("task/", task({ title: "Додати прапор" }), "small")).toBe("task/ABC-12-task");
    expect(plannedBranch("feature/", task(), "medium")).toBe("feature/ABC-12-");
  });

  test("the prefix rule of the task settings route, with its sentence", () => {
    for (const ok of ["feature/", "task/", "users/ada/", "fix-"]) expect(prefixProblem(ok)).toBeNull();
    // spec.md section 6.16.1: a prefix has 1 to 40 characters.
    for (const bad of ["", "x".repeat(41), "bad..", "a b", "/task/", "-x", "x~", "a/.b", "a.lock/"])
      expect(prefixProblem(bad)).toBe("Invalid branch prefix.");
  });
});

describe("the branch picks of the plan screen (spec.md sections 6.16.1 to 6.16.4, AC-B25, AC-B27)", () => {
  const LIST = ["feature/", "bugfix/", "hotfix/"];
  const check = (o: Partial<BranchCheckDto> = {}): BranchCheckDto => ({
    name: "task/ABC-12-trim-spaces-in-user-names",
    exists: [{ taskRepo: null, project: "PROJ", repo: "repo", head: "c".repeat(40) }],
    openPr: null,
    nextFree: "task/ABC-12-trim-spaces-in-user-names-2",
    ...o,
  });

  test("the first chip starts selected; a stored prefix comes back, under Other when the list lost it", () => {
    expect(firstPick(undefined, LIST)).toEqual({ chip: "feature/", other: "", existing: "continue" });
    expect(firstPick("bugfix/", LIST)).toEqual({ chip: "bugfix/", other: "", existing: "continue" });
    expect(firstPick("task/", LIST)).toEqual({ chip: null, other: "task/", existing: "continue" });
    expect(pickedPrefix({ chip: "hotfix/", other: "task/", existing: "continue" })).toBe("hotfix/");
    expect(pickedPrefix({ chip: null, other: "task/", existing: "continue" })).toBe("task/");
  });

  test("the approval sends the picked prefix, and the existing-branch choice only for a found name of that prefix", () => {
    const other = { chip: null, other: "task/", existing: "new" } as const;
    expect(branchApproval(other, { checked: "task/", data: check() })).toEqual({ prefix: "task/", existing: "new" });
    expect(branchApproval({ ...other, existing: "continue" }, { checked: "task/", data: check() })).toEqual({
      prefix: "task/",
      existing: "continue",
    });
    // A free name, a check of an earlier prefix, and a check without an answer send no choice.
    expect(branchApproval(other, { checked: "task/", data: check({ exists: [] }) })).toEqual({ prefix: "task/" });
    expect(branchApproval(other, { checked: "feature/", data: check() })).toEqual({ prefix: "task/" });
    expect(branchApproval(other, { checked: "task/", data: undefined })).toEqual({ prefix: "task/" });
    expect(branchApproval({ chip: "feature/", other: "bad..", existing: "continue" }, { checked: null, data: undefined })).toEqual({
      prefix: "feature/",
    });
  });

  test("an invalid Other prefix holds the approval back with the prefix sentence", () => {
    for (const other of ["", "bad..", "x".repeat(41)])
      expect(branchApproval({ chip: null, other, existing: "continue" }, { checked: null, data: undefined })).toEqual({
        problem: "Invalid branch prefix.",
      });
  });

  test("the line under the branch list: more branches, no match, and an empty repository", () => {
    const b = (name: string, isDefault = false) => ({ name, isDefault });
    expect(branchNote({ branches: [b("develop", true), b("main")], more: false }, "")).toBeNull();
    expect(branchNote({ branches: [b("develop", true)], more: true }, "")).toBe("Type to see more branches.");
    expect(branchNote({ branches: [], more: false }, "zzz")).toBe("No branch matches “zzz”.");
    expect(branchNote({ branches: [], more: false }, "")).toBe("The repository has no branches.");
  });

  test("a failed branch read names the repository once", () => {
    expect(branchesError("Cannot read the branches of PROJ/repo. HTTP 500", "PROJ", "repo")).toBe(
      "Cannot read the branches of PROJ/repo. HTTP 500",
    );
    expect(branchesError("Failed to fetch", "PROJ", "repo")).toBe("Cannot read the branches of PROJ/repo. Failed to fetch");
  });
});

describe("the Tasks row status (spec.md section 6.12, Inbox; AC-UX9)", () => {
  const row = (o: Partial<TaskRowDto>): TaskRowDto => {
    const { interview: _i, plan: _p, ...r } = task();
    return { ...r, ...o } as TaskRowDto;
  };
  const progress = (o: Partial<TaskRowDto["progress"]>) => ({
    planReady: false,
    part: 0,
    parts: 0,
    ready: false,
    merged: false,
    building: [],
    held: 0,
    ...o,
  });

  test("one meta line per state", () => {
    expect(rowStatus(row({ state: "interview" }))).toEqual({ text: "Reading the task", needsYou: false });
    expect(rowStatus(row({ state: "interview", blocked: { kind: "question", step: 1, text: "x" } })).text).toBe(
      "Needs you: answer the questions",
    );
    expect(rowStatus(row({ state: "spec_draft", progress: progress({ planReady: true }) }))).toEqual({
      text: "Needs you: approve the plan",
      needsYou: true,
    });
    expect(rowStatus(row({ state: "implementing", progress: progress({ part: 1, parts: 1 }) })).text).toBe("Building part 1 of 1");
    expect(rowStatus(row({ state: "implementing", progress: progress({ part: 1, parts: 4, building: [1] }) })).text).toBe(
      "Building part 1 of 4",
    );
    expect(rowStatus(row({ state: "implementing" })).text).toBe("Building");
    expect(rowStatus(row({ state: "implementing", progress: progress({ part: 1, parts: 1, ready: true }) })).text).toBe(
      "Needs you: open the PR",
    );
    expect(rowStatus(row({ state: "implementing", blocked: { kind: "red", step: 1, text: "x" } })).text).toBe("Needs you: tests stay red");
    expect(rowStatus(row({ state: "implementing", blocked: { kind: "slot", step: 1, text: "x" } }))).toEqual({
      text: "Waiting for a free run slot",
      needsYou: false,
    });
    expect(rowStatus(row({ state: "ready" })).text).toBe("Waiting for review");
    expect(rowStatus(row({ state: "stopped" })).text).toBe("Stopped");
    expect(rowStatus(row({ state: "done", closedAt: NOW })).text).toBe("Closed");
  });

  test("AC-B241: the row names every part in its build, not only the first open part", () => {
    const building = (part: number, ns: number[]) =>
      rowStatus(row({ state: "implementing", progress: progress({ part, parts: 4, building: ns }) }));
    expect(building(2, [2, 3])).toEqual({ text: "Building parts 2 and 3 of 4", needsYou: false });
    expect(building(2, [2, 3, 4]).text).toBe("Building parts 2, 3, and 4 of 4");
    // Part 2 is in review and part 3 builds.
    expect(building(2, [3]).text).toBe("Building part 3 of 4");
  });

  // ps5-plan.md D6 (AC-B381): held lives in the part rows, and an armed usage reason goes on by itself.
  test("On hold for a task whose only reason is held; Resumes after the usage limit for an armed usage reason", () => {
    const usage = { kind: "usage" as const, step: 1, text: "x", resumeAt: NOW + MIN };
    expect(rowStatus(row({ state: "implementing", progress: progress({ part: 1, parts: 2, held: 1 }) }))).toEqual({
      text: "On hold",
      needsYou: false,
    });
    // A first reason of another part comes first.
    expect(rowStatus(row({ state: "implementing", blocked: usage, progress: progress({ held: 1 }) }))).toEqual({
      text: "Needs you: the usage limit",
      needsYou: true,
    });
    expect(rowStatus(row({ state: "implementing", blocked: { ...usage, armed: true } }))).toEqual({
      text: "Resumes after the usage limit",
      needsYou: false,
    });
    expect(rowStatus(row({ state: "ready", blocked: { ...usage, armed: true }, queued: 1 }))).toEqual({
      text: "Resumes after the usage limit, and 1 more",
      needsYou: false,
    });
    expect(rowStatus(row({ state: "ready", blocked: { ...usage, armed: false } })).needsYou).toBe(true);
    expect(rowStatus(row({ state: "stopped", progress: progress({ held: 1 }) })).text).toBe("Stopped");
  });

  // part-session.md section 9.4: error/restart has its own status. Another cause of error keeps the status of its kind.
  test("error/restart says the app restarted; error/run says an error", () => {
    const error = (cause: "restart" | "run") => ({ kind: "error" as const, cause, step: 1, text: "x" });
    expect(rowStatus(row({ state: "implementing", blocked: error("restart"), queued: 1 }))).toEqual({
      text: "Needs you: the app restarted, and 1 more",
      needsYou: true,
    });
    expect(rowStatus(row({ state: "implementing", blocked: error("run") })).text).toBe("Needs you: an error");
  });
});

describe("the attachments of a task (spec.md section 6.17)", () => {
  const MB = 1024 * 1024;
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const meta = (id: string, filename: string, mimeType: string | null, size = 2048): AttachmentMeta => ({
    id,
    filename,
    mimeType,
    size,
    created: null,
  });
  const file = (id: string, o: Partial<AttachmentDto> = {}): AttachmentDto => ({
    id,
    filename: `f${id}`,
    size: 2048,
    sha256: "0".repeat(64),
    image: false,
    text: false,
    pdf: false,
    include: false,
    downloadedAt: 1,
    ...o,
  });
  const LISTING = [
    meta("1", "screen.png", "image/png"),
    meta("2", "run.log", "text/plain; charset=UTF-8", 512),
    meta("3", "spec.pdf", "application/pdf"),
    meta("4", "plan.docx", DOCX),
    meta("5", "logs.zip", "application/zip"),
    meta("6", "huge.png", "image/png", 5 * MB + 1),
    meta("7", "data.json", "application/json"),
    meta("8", "unknown.bin", null),
  ];

  test("before the download, the listed type and size give the box; office files and archives stay listed only", () => {
    const rows = fileChoices(LISTING, []);
    expect(rows.map((r) => [r.id, r.kind, r.why])).toEqual([
      ["1", "image", null],
      ["2", "text", null],
      ["3", "pdf", null],
      ["4", "file", "Listed only: only images, PDFs, and text files go to runs."],
      ["5", "file", "Listed only: only images, PDFs, and text files go to runs."],
      ["6", "image", "Listed only: runs get images up to 5 MB."],
      ["7", "text", null],
      ["8", "file", "Listed only: only images, PDFs, and text files go to runs."],
    ]);
    expect(fileMeta(rows[0] as FileChoice)).toBe("2 KB, image/png");
    expect(fileMeta({ ...(rows[7] as FileChoice), size: 10 })).toBe("10 B, file");
  });

  test("with the setting off every box starts ticked; asking starts with none", () => {
    const rows = fileChoices(LISTING, []);
    expect(firstPicks(rows, false)).toEqual(["1", "2", "3", "7"]);
    expect(firstPicks(rows, true)).toEqual([]);
    expect(firstPicks([], false)).toEqual([]);
  });

  test("after the download the bytes decide, and the state line says what the runner gets", () => {
    const rows = fileChoices(LISTING, [
      file("1", { image: true, include: true }),
      // A listed PNG that is an HTML login page: no box.
      file("6", { size: 100 }),
      file("2", { text: true, size: 300 * 1024, include: true }),
      file("3", { pdf: true }),
      file("9", { filename: "old.txt", text: true }),
    ]);
    const by = (id: string) => rows.find((r) => r.id === id) as FileChoice;
    expect(by("6")).toMatchObject({ kind: "file", why: "Listed only: only images, PDFs, and text files go to runs." });
    expect(by("3")).toMatchObject({ kind: "pdf", why: null });
    // A downloaded file that the listing no longer names keeps its box.
    expect(by("9")).toMatchObject({ kind: "text", why: null });
    expect(fileChoiceState(by("1"), R)).toBe("Claude gets it in each step.");
    expect(fileChoiceState(by("2"), R)).toBe("Claude gets it, cut at 256 KB.");
    expect(fileChoiceState(by("3"), R)).toBe("Downloaded. Claude does not get it.");
    expect(fileChoiceState(by("7"), R)).toBe("Not downloaded. A tick downloads it.");
    expect(fileChoiceState(by("4"), R)).toBe("Listed only: only images, PDFs, and text files go to runs.");
  });

  test("spec.md section 6.20.3: the tab groups the files by issue, the parent first and the sub-tasks in plan order", () => {
    const groups = (t: TaskDto) => fileGroups(t)?.map((g) => [g.key, g.summary, g.rows.map((r) => r.id)]);
    expect(fileGroups(task({ attachments: [meta("1", "a.png", "image/png")], files: [file("1")] }))).toBeNull();
    const t = subTask(
      // The plan builds ABC-14 before ABC-13.
      [part({ id: 1, ord: 1, keys: ["ABC-14"] }), part({ id: 2, ord: 2, keys: ["ABC-13"] })],
      {
        attachments: [meta("1", "parent.png", "image/png")],
        files: [file("1"), file("2", { issue: "ABC-13" }), file("9", { issue: "ABC-99" })],
      },
    );
    t.subtasks = (t.subtasks ?? []).map((s) =>
      s.key === "ABC-13"
        ? { ...s, attachments: [meta("2", "a.log", "text/plain"), meta("3", "b.png", "image/png")] }
        : s.key === "ABC-14"
          ? { ...s, attachments: [meta("5", "d.png", "image/png")] }
          : s,
    );
    t.subtasks.push(sub("ABC-15", { attachments: [meta("4", "c.pdf", "application/pdf")] }));
    // ABC-11 and ABC-12 have no files, so they get no group. A stored key that the task no longer lists keeps its files.
    expect(groups(t)).toEqual([
      ["ABC-10", "Split the cache work", ["1"]],
      ["ABC-14", "Summary of ABC-14", ["5"]],
      ["ABC-13", "Summary of ABC-13", ["2", "3"]],
      ["ABC-15", "Summary of ABC-15", ["4"]],
      ["ABC-99", "", ["9"]],
    ]);
    // Without a plan, the sub-tasks follow the tracker order; a parent without files gets no group.
    expect(groups({ ...t, parts: [], attachments: [], files: [] })).toEqual([
      ["ABC-13", "Summary of ABC-13", ["2", "3"]],
      ["ABC-14", "Summary of ABC-14", ["5"]],
      ["ABC-15", "Summary of ABC-15", ["4"]],
    ]);
  });
});

describe("taskProfileId (spec.md section 6.2)", () => {
  const p = (id: string, explain = false) => ({ id, explain });
  test("the stored review profile, else general, else the first review profile; never an Explain profile", () => {
    expect(taskProfileId([p("general"), p("strict")], "strict")).toBe("strict");
    expect(taskProfileId([p("general"), p("explain", true)], "explain")).toBe("general");
    expect(taskProfileId([p("general"), p("strict")], "gone")).toBe("general");
    expect(taskProfileId([p("general")], null)).toBe("general");
    expect(taskProfileId([p("explain", true), p("strict")], null)).toBe("strict");
  });
});

// ---------- Several repositories (spec.md sections 6.12, 6.16.5, and 6.16.8; WP-MR3) ----------

const repoRow = (o: Partial<TaskRepoDto> & Pick<TaskRepoDto, "id" | "role">): TaskRepoDto => ({
  project: "PROJ",
  repo: "repo",
  path: null,
  depth: 0,
  access: "edit",
  reason: null,
  baseBranch: "main",
  proposal: null,
  proposalReason: null,
  ...o,
});
// PROJ/repo holds lib (an editable submodule) and vendor (another server). The spec run proposed PROJ/client, and the user skipped
// PROJ/old.
const REPOS: TaskRepoDto[] = [
  repoRow({ id: 1, role: "main" }),
  repoRow({ id: 2, role: "submodule", repo: "lib", path: "lib", depth: 1, baseBranch: "develop" }),
  repoRow({
    id: 3,
    role: "submodule",
    project: null,
    repo: null,
    path: "vendor",
    depth: 1,
    access: "none",
    reason: "It comes from another server.",
    baseBranch: null,
  }),
  repoRow({
    id: 4,
    role: "added",
    repo: "client",
    access: "none",
    baseBranch: null,
    proposal: "proposed",
    proposalReason: "The client calls the changed API.",
  }),
  repoRow({ id: 5, role: "added", repo: "old", access: "none", baseBranch: null, proposal: "skipped" }),
];
const prRow = (o: Partial<TaskPrDto> & Pick<TaskPrDto, "taskRepo" | "repo">): TaskPrDto => ({
  id: o.taskRepo === 1 ? null : 50 + o.taskRepo,
  part: 7,
  role: o.taskRepo === 1 ? "main" : "submodule",
  project: "PROJ",
  path: o.taskRepo === 1 ? null : o.repo,
  branch: "feature/ABC-12-trim-spaces-in-user-names",
  baseBranch: "main",
  head: "a".repeat(40),
  pushed: null,
  files: 2,
  lines: 30,
  pr: null,
  remotePr: null,
  state: "changed",
  error: null,
  running: null,
  pointer: null,
  reviewers: ["anna"],
  build: null,
  ...o,
});
const LIB = prRow({ taskRepo: 2, repo: "lib" });
const MAIN = prRow({ taskRepo: 1, repo: "repo" });
const opened = (r: TaskPrDto, remotePr: number): TaskPrDto => ({
  ...r,
  pushed: r.head,
  remotePr,
  pr: remotePr + 1000,
  state: "pr_open",
  pointer: r.role === "submodule" ? "task_branch" : null,
});
const multi = (prs: TaskPrDto[], o: Partial<TaskDto> = {}) =>
  building({ parts: [part({ state: "self_reviewed" })], repos: REPOS, prs, ...o });
const READY_OPEN = { state: "ready" as const, parts: [part(PR_PART)] };

describe("the rows of several repositories (spec.md sections 6.12 and 6.16.8)", () => {
  test("implementing, ready: the repository count, and Open 2 PRs; the moved base keeps Open the PR as is", () => {
    expect(shape(view(multi([LIB, MAIN])))).toEqual({
      status: "Your change in 2 repositories is ready: 80 lines.",
      primary: "Open 2 PRs",
      more: ["Show the diff", "Start this part again"],
      screen: "ready",
    });
    const moved2 = view(
      multi([LIB, MAIN], { bases: [{ taskRepo: 2, branch: "develop", newCommits: 3, conflicted: false, changed: false }] }),
    );
    expect(shape(moved2)).toMatchObject({
      status: "develop has 3 new commits since the branch point.",
      primary: "Update from develop",
      more: ["Open the PR as is", "Show the diff", "Start this part again"],
    });
    // One changed repository keeps the one-PR words.
    expect(view(multi([MAIN])).primary?.label).toBe("Open the PR");
  });

  test("AC-B39: PRs partly open: the count, the failed repository, Try again for it, and the reason under the status", () => {
    const why = "The token cannot create pull requests in PROJ/lib. Give it Repository write in Bitbucket, then try again.";
    const other = prRow({ taskRepo: 6, repo: "other" });
    const v = view(multi([{ ...LIB, state: "failed", error: why }, opened(other, 41), opened(MAIN, 101)], READY_OPEN));
    expect(shape(v)).toEqual({
      status: "2 of 3 PRs are open. The PR for PROJ/lib failed.",
      primary: "Try again for PROJ/lib",
      more: ["Go to the PR"],
      screen: "pr",
    });
    expect(v.detail).toBe(why);
    expect(v.needsYou).toBe(true);
    // A failed push of the child stops the parent: both rows fail, and nothing is open yet.
    const both = view(
      multi([
        { ...LIB, state: "failed", error: "The push of feature/x failed: refused." },
        { ...MAIN, state: "failed", error: "PROJ/repo waits, because PROJ/lib is not on the server yet." },
      ]),
    );
    expect(shape(both)).toEqual({
      status: "0 of 2 PRs are open. The PRs for PROJ/lib and PROJ/repo failed.",
      primary: "Try again for 2 PRs",
      more: ["Show the diff"],
      screen: "pr",
    });
  });

  test("AC-B41: ready, submodule merged: the pointer sentence and Point <parent> at the merged commit; after the 409, the newest base", () => {
    const merged = { ...opened(LIB, 41), state: "merged" as const };
    const v = view(multi([merged, opened(MAIN, 101)], READY_OPEN));
    expect(shape(v)).toEqual({
      status: "The PROJ/lib PR merged. PROJ/repo still points at the task branch commit.",
      primary: "Point PROJ/repo at the merged commit",
      more: ["Go to the PR"],
      screen: "pr",
    });
    const newest = taskView(multi([merged, opened(MAIN, 101)], READY_OPEN), { runner: R, forge: "Bitbucket", now: NOW, newest: 52 });
    expect(newest.primary).toEqual({ kind: "pointer", label: "Point PROJ/repo at the newest main commit" });
    // A failed move keeps the row and shows its sentence.
    const failed = view(multi([{ ...merged, error: "PROJ/repo has changes that are not committed." }, opened(MAIN, 101)], READY_OPEN));
    expect(failed.detail).toBe("PROJ/repo has changes that are not committed.");
    // After the move, the task waits for the review again.
    const pointed = view(multi([{ ...merged, pointer: "merged_commit" }, opened(MAIN, 101)], READY_OPEN));
    expect(shape(pointed)).toMatchObject({ status: "Waiting for Anna Lee's review. Nothing to do.", primary: "Go to the PR" });
  });

  test("ready, all PRs open: the count, then the review wait", () => {
    expect(shape(view(multi([opened(LIB, 41), opened(MAIN, 101)], READY_OPEN)))).toEqual({
      status: "All 2 PRs are open. Waiting for Anna Lee's review. Nothing to do.",
      primary: "Go to the PR",
      more: ["Close the task"],
      screen: "pr",
    });
  });

  test("the running steps of the rows name the repository; the one-PR route keeps the branch words", () => {
    const run = (kind: "push" | "pr", item: string) => step({ id: 60, kind, part: 7, item, state: "running", endedAt: null });
    expect(view(multi([LIB, MAIN], { steps: [run("push", "PROJ/lib")] })).status).toBe("Pushing the branch to PROJ/lib.");
    expect(view(multi([LIB, MAIN], { steps: [run("pr", "PROJ/repo")] })).status).toBe("Opening the PR in PROJ/repo.");
    expect(view(building({ steps: [run("push", "feature/ABC-12-x")] })).status).toBe("Pushing the branch.");
    const pointer = step({ id: 61, kind: "commit", part: 7, item: "pointer", state: "running", endedAt: null });
    expect(view(multi([LIB, MAIN], { ...READY_OPEN, steps: [pointer] })).status).toBe("Pointing PROJ/repo at the merged commit.");
  });

  test("blocked pre-flight: the sentence of what to fix, Try again, and Stop", () => {
    const text = "Needs you: the token cannot push to PROJ/lib. Give it Repository write in Bitbucket, then try again.";
    expect(shape(view(building({ blocked: { kind: "preflight", step: null, text } })))).toEqual({
      status: text,
      primary: "Try again",
      more: ["Stop"],
      screen: "build",
    });
  });

  test("spec.md section 6.16.7: a gone base gets Pick a base branch with its picker; a picked base waits for the update", () => {
    const text = "Needs you: develop no longer exists in PROJ/lib. Pick another base branch.";
    const gone = building({ blocked: { kind: "preflight", step: null, text, base: { taskRepo: 2, branch: "develop" } } });
    expect(shape(view(gone))).toEqual({ status: text, primary: "Pick a base branch", more: ["Try again", "Stop"], screen: "build" });
    expect(goneBase({ ...gone, repos: [{ ...REPOS[0], id: 2, project: "PROJ", repo: "lib" } as TaskRepoDto] })).toEqual({
      taskRepo: 2,
      branch: "develop",
      project: "PROJ",
      repo: "lib",
      name: "PROJ/lib",
    });
    expect(goneBase(building({ blocked: { kind: "preflight", step: null, text: "Needs you: x." } }))).toBeNull();
    const picked = view({ ...tellRows().ready, bases: moved(0, { changed: true }) });
    expect(picked.status).toBe(`The base branch is now ${REL}. Update the branch before the PR.`);
    expect(picked.primary?.label).toBe(`Update from ${REL}`);
    expect(picked.more.map((a) => a.label)).not.toContain("Open the PR as is");
  });

  test("AC-UX1 and AC-UX3 over the new rows: one primary at most, and one sentence with a full stop", () => {
    const merged = { ...opened(LIB, 41), state: "merged" as const };
    for (const t of [
      multi([LIB, MAIN]),
      multi([{ ...LIB, state: "failed", error: "x." }, opened(MAIN, 101)], READY_OPEN),
      multi([merged, opened(MAIN, 101)], READY_OPEN),
      multi([opened(LIB, 41), opened(MAIN, 101)], READY_OPEN),
      building({ blocked: { kind: "preflight", step: null, text: "Needs you: x." } }),
    ]) {
      const v = view(t);
      expect(v.more.some((a) => a.kind === v.primary?.kind)).toBe(false);
      expect(v.status).toMatch(/^\S.*[.?]$/);
    }
  });
});

describe("the row states of Push and open PRs (spec.md section 6.16.8)", () => {
  const push = (id: number, state: TaskStepDto["state"], item = "PROJ/lib") => step({ id, kind: "push", part: 7, item, state });
  test("each state in words: Waiting, Pushing, Opening the PR, PR #n open, merged, and Failed with the sentence", () => {
    expect(prRowLook(LIB, [], null)).toEqual({ state: "waiting", text: "Waiting" });
    expect(prRowLook({ ...LIB, running: "push" }, [], 5)).toEqual({ state: "running", text: "Pushing" });
    expect(prRowLook({ ...LIB, running: "pr" }, [], 5)).toEqual({ state: "running", text: "Opening the PR" });
    expect(prRowLook(opened(LIB, 41), [], null)).toEqual({ state: "open", text: "PR #41 open" });
    expect(prRowLook({ ...opened(LIB, 41), state: "merged" }, [], null)).toEqual({ state: "open", text: "PR #41 merged" });
    expect(prRowLook({ ...LIB, state: "failed", error: "Refused." }, [], null)).toEqual({ state: "failed", text: "Failed: Refused." });
  });

  test("a sent row waits until a step of its repository ends after the send, so an old failure does not show again", () => {
    const old = { ...LIB, state: "failed" as const, error: "Refused." };
    // The send came after step 9. Only the old failed push of step 8 exists, and a step of another repository does not count.
    expect(prRowLook(old, [push(8, "failed"), push(10, "ok", "PROJ/repo")], 9)).toEqual({ state: "waiting", text: "Waiting" });
    expect(prRowLook(old, [push(10, "running")], 9)).toEqual({ state: "waiting", text: "Waiting" });
    // The new push failed again.
    expect(prRowLook(old, [push(10, "failed")], 9)).toEqual({ state: "failed", text: "Failed: Refused." });
    // The push passed, and the create waits.
    expect(prRowLook({ ...LIB, state: "pushed" }, [push(10, "ok")], 9)).toEqual({ state: "waiting", text: "Waiting" });
  });

  test("the size of a row, the list words, the rows of a part, and the merged submodule row", () => {
    expect(rowSize(LIB)).toBe("2 files, 30 lines");
    expect(rowSize({ files: 1, lines: null })).toBe("1 file");
    expect(rowSize({ files: null, lines: null })).toBeNull();
    expect(listText(["A"])).toBe("A");
    expect(listText(["A", "B"])).toBe("A and B");
    expect(listText(["A", "B", "C"])).toBe("A, B, and C");
    expect(partRows({ prs: [LIB, { ...MAIN, part: 8 }] }, { id: 7 })).toEqual([LIB]);
    expect(partRows({ prs: [LIB] }, null)).toEqual([]);
    expect(pointerRow([{ ...opened(LIB, 41), state: "merged" }, opened(MAIN, 101)])?.taskRepo).toBe(2);
    expect(pointerRow([{ ...opened(LIB, 41), state: "merged", pointer: "merged_commit" }])).toBeNull();
  });

  test("NO_MERGE is a part of the 409 sentence of the pointer route, and of no other sentence of that route", () => {
    expect(noMergeText("PROJ/repo", "main", "PROJ/lib")).toContain(NO_MERGE);
    expect("The PROJ/lib PR is not merged yet.").not.toContain(NO_MERGE);
  });
});

describe("the repositories of the plan screen (spec.md sections 6.16.3 and 6.16.5, AC-B33, AC-B44)", () => {
  test("the task repositories with their access and role; a proposal shows apart; a skipped row is no repository of the task", () => {
    const t = task({ repos: REPOS });
    expect(inTask(t).map((r) => [repoName(r), roleText(r), ACCESS_TEXT[r.access], r.reason])).toEqual([
      ["PROJ/repo", "Main repository", "Can change", null],
      ["PROJ/lib", "Submodule at lib", "Can change", null],
      ["vendor", "Submodule at vendor", "Not available", "It comes from another server."],
    ]);
    expect(proposals(t).map((r) => [repoName(r), r.proposalReason])).toEqual([["PROJ/client", "The client calls the changed API."]]);
    expect(showRepos(t)).toBe(true);
    // One repository and no proposal keep the one base picker of the branch section.
    expect(showRepos(task({ repos: [REPOS[0] as TaskRepoDto] }))).toBe(false);
    expect(showRepos(task({ repos: [REPOS[0] as TaskRepoDto, REPOS[3] as TaskRepoDto] }))).toBe(true);
    // An added repository after Add is in the task.
    const added = repoRow({ id: 4, role: "added", repo: "client", proposal: "added", baseBranch: "main" });
    expect(roleText(added)).toBe("Added repository");
    expect(inTask(task({ repos: [REPOS[0] as TaskRepoDto, added] }))).toHaveLength(2);
  });

  test("the approval sends the base of each repository that the task changes; the main base is the task target", () => {
    expect(basePicks(task({ repos: REPOS, targetBranch: "release/2.1" }))).toEqual([
      { taskRepo: 1, branch: "release/2.1" },
      { taskRepo: 2, branch: "develop" },
    ]);
    // A task made before its rows has the main row 0, which the route does not take.
    expect(basePicks(task({ repos: [repoRow({ id: 0, role: "main" })] }))).toEqual([]);
  });

  test("the plan sentence says that each changed repository gets its own PR", () => {
    expect(planSentence(task({ state: "spec_draft", plan: PLAN, estimate: ESTIMATE, repos: REPOS }))).toBe(
      "The plan is ready: small, 1 PR per changed repository, about 80 changed lines.",
    );
    expect(planSentence(task({ state: "spec_draft", plan: PLAN, estimate: ESTIMATE, repos: [REPOS[0] as TaskRepoDto] }))).toBe(
      "The plan is ready: small, 1 PR, about 80 changed lines.",
    );
  });
});

describe("the repository of the Build form (spec.md section 6.12)", () => {
  test("known repositories come first and sorted, then the listed ones, each key once; the search ignores case and caps the list", () => {
    const all = repoChoices(
      [
        { project: "PROJ", repo: "zeta" },
        { project: "PROJ", repo: "alpha" },
        { project: "PROJ", repo: "zeta" },
      ],
      [
        { project: "PROJ", repo: "alpha" },
        { project: "OTHER", repo: "beta" },
      ],
    );
    expect(all.map((r) => r.key)).toEqual(["PROJ/alpha", "PROJ/zeta", "OTHER/beta"]);
    expect(repoMatches(all, " other/B ").items.map((r) => r.key)).toEqual(["OTHER/beta"]);
    expect(repoMatches(all, "")).toEqual({ items: all, more: 0 });
    const many = repoChoices(
      [],
      Array.from({ length: REPOS_SHOWN + 3 }, (_, i) => ({ project: "P", repo: `r${i}` })),
    );
    const m = repoMatches(many, "p/r");
    expect([m.items.length, m.more]).toEqual([REPOS_SHOWN, 3]);
  });
});

// ---------- Sub-tasks (spec.md section 6.20, WP-ST6) ----------

const SUB_OPTS = { runner: R, forge: "Forge", tracker: "Tracker", now: NOW };
const sub = (key: string, o: Partial<SubtaskDto> = {}): SubtaskDto => ({
  key,
  summary: `Summary of ${key}`,
  status: "To Do",
  category: "new",
  statusAt: NOW,
  links: [],
  found: [],
  parts: [],
  attachments: [],
  added: null,
  removed: null,
  ...o,
});
// The parent ABC-10 with ABC-11 done in the tracker, ABC-12 as a tracked PR, and ABC-13 and ABC-14 built by the app.
function subTask(parts: TaskPartDto[], o: Partial<TaskDto> = {}): TaskDto {
  return task({
    key: "ABC-10",
    title: "Split the cache work",
    state: "implementing",
    size: "small",
    parts,
    subtasks: [
      sub("ABC-11", { status: "Done", category: "done" }),
      sub("ABC-12", { status: "In Review", category: "indeterminate" }),
      sub("ABC-13"),
      sub("ABC-14"),
    ],
    ...o,
  });
}
const p12 = (o: Partial<TaskPartDto> = {}) =>
  part({ id: 12, ord: 1, keys: ["ABC-12"], state: "pr_open", adopted: true, remotePr: 41, waiting: ["Anna"], ...o });
const p13 = (o: Partial<TaskPartDto> = {}) =>
  part({ id: 13, ord: 2, keys: ["ABC-13"], branch: "feature/ABC-13-flush", start: "base", ...o });
const p14 = (o: Partial<TaskPartDto> = {}) =>
  part({ id: 14, ord: 3, keys: ["ABC-14"], branch: "feature/ABC-14-measure", state: "planned", start: "base", head: null, ...o });

describe("sub-task rows: one sentence and one actor (spec.md section 6.20.13)", () => {
  test("the rows follow the tracker order, name the part k of n, and give the actor and the row action", () => {
    const t = subTask([p12(), p13({ state: "implementing" }), p14({ start: "stack", after: 12, wait: "Waits for a review of ABC-12." })]);
    const rows = subtaskRows(t, SUB_OPTS);
    expect(rows.map((r) => [r.label, r.text, r.actor, r.action?.kind ?? null])).toEqual([
      ["ABC-11", "Done in Tracker.", "No one", null],
      ["ABC-12 (1 of 3)", "In review outside the app: PR #41.", "Anna", "go-pr"],
      ["ABC-13 (2 of 3)", "Claude builds it.", "Claude", null],
      ["ABC-14 (3 of 3)", "Waits for a review of ABC-12.", "Anna", "start-now"],
    ]);
    expect(partLabel(t, p13())).toBe("ABC-13 (2 of 3)");
  });

  test("each part state has one sentence and one actor", () => {
    const cases: [Partial<TaskPartDto>, string, string][] = [
      [{ state: "self_reviewed" }, "Ready. Open its PR.", "You"],
      [{ state: "pr_open", remotePr: 52, waiting: ["Anna"] }, "In review by Anna.", "Anna"],
      [{ state: "changes_requested", remotePr: 52, waiting: ["Anna"] }, "Anna asks for changes.", "You"],
      [{ state: "approved", remotePr: 52 }, "Approved. Waits for the merge.", "The merger"],
      [{ state: "merged", remotePr: 52 }, "Merged.", "No one"],
      [{ state: "declined", remotePr: 52 }, "Declined.", "You"],
      [{ state: "abandoned" }, "Dropped.", "No one"],
      [
        { state: "planned", head: null, wait: "Waits: 3 PRs of this task are open, your limit." },
        "Waits: 3 PRs of this task are open, your limit.",
        "Reviewers",
      ],
      [
        { state: "pr_open", remotePr: 52, pushed: "c".repeat(40), lower: { key: "ABC-12", how: "merge" } },
        "ABC-12 merged. Move ABC-13 to main.",
        "You",
      ],
    ];
    for (const [o, text, actor] of cases) {
      const row = subtaskRows(subTask([p12(), p13(o)]), SUB_OPTS).find((r) => r.part?.id === 13);
      expect([row?.text, row?.actor]).toEqual([text, actor]);
    }
  });

  test("a planned part that waits for a merge names the reviewers of the lower part; done and removed sub-tasks offer Drop", () => {
    const merge = subtaskRows(subTask([p12(), p14({ start: "merge", after: 12, wait: "Waits for ABC-12 to merge." })]), SUB_OPTS);
    expect(merge.find((r) => r.part?.id === 14)).toMatchObject({ text: "Waits for ABC-12 to merge.", actor: "Anna", action: null });
    const t = subTask([p14()]);
    const done = { ...t, subtasks: (t.subtasks ?? []).map((s) => (s.key === "ABC-14" ? { ...s, category: "done" as const } : s)) };
    expect(subtaskRows(done, SUB_OPTS).find((r) => r.part?.id === 14)).toMatchObject({
      text: "Done in Tracker.",
      action: { kind: "drop" },
    });
  });

  test("a sub-task without a part says why; a new key and a planned-no-PR key get their own sentence", () => {
    const t = subTask([p13({ state: "implementing" })], {
      subtasks: [sub("ABC-13"), sub("ABC-14"), sub("ABC-17", { added: NOW })],
    });
    expect(subtaskRows(t, SUB_OPTS).map((r) => r.text)).toEqual([
      "Claude builds it.",
      "Claude planned no PR for ABC-14.",
      "ABC-17 is new in Tracker.",
    ]);
  });

  test("spec.md section 6.20.14: a new key offers Add to plan, a removed planned key offers Drop, and a changed plan waits for its approval", () => {
    const t = subTask([p13({ state: "implementing" }), p14()], {
      subtasks: [sub("ABC-13"), sub("ABC-14", { removed: NOW }), sub("ABC-17", { added: NOW })],
    });
    const rows = subtaskRows(t, SUB_OPTS);
    expect(rows.map((r) => [r.key, r.text, r.actor, r.action?.kind ?? null, r.action?.label ?? null])).toEqual([
      ["ABC-13", "Claude builds it.", "Claude", null, null],
      ["ABC-14", "Removed in Tracker.", "You", "drop", "Drop"],
      ["ABC-17", "ABC-17 is new in Tracker.", "You", "add-plan", "Add to plan"],
    ]);
    const start = {
      n: 4,
      keys: ["ABC-17"],
      start: "base" as const,
      after: null,
      reason: "",
      skip: false,
      title: "Add the probe",
      lines: 120,
    };
    const adding = { ...t, plan: { ...PLAN, approved: true, adding: true, starts: [start] } };
    expect(subtaskRows(adding, SUB_OPTS).find((r) => r.key === "ABC-17")).toMatchObject({
      text: "Claude planned ABC-17. Approve the changed plan.",
      action: null,
    });
    const v = subtaskView(adding, null, SUB_OPTS);
    expect([v.status, v.primary?.label, v.screen]).toEqual([
      "The changed plan is ready: 1 new sub-task, about 120 changed lines.",
      "Approve the changed plan",
      "plan",
    ]);
    expect(addPlanSentence({ ...adding, plan: { ...adding.plan, starts: [] } })).toBe(
      "The changed plan adds no sub-task. Approve it to close it.",
    );
  });

  test("the row hints say what does not fit and the parent hint comes when every part merged", () => {
    const t = subTask([p12({ adopted: false }), p13({ state: "merged", remotePr: 52 })]);
    const open = {
      ...t,
      subtasks: (t.subtasks ?? []).map((s) => (s.key === "ABC-12" ? { ...s, status: "To Do", category: "new" as const } : s)),
    };
    const rows = subtaskRows(open, SUB_OPTS);
    expect(rows.find((r) => r.part?.id === 12)?.hint).toBe("Tracker says To Do, but the PR is open.");
    expect(rows.find((r) => r.part?.id === 13)?.hint).toBe("The PR merged. Tracker says To Do.");
    expect(parentHint(t, "Tracker")).toBeNull();
    const all = subTask([p12({ state: "merged" }), p13({ state: "merged" }), p14({ state: "abandoned" })], { issueStatus: "In Progress" });
    expect(parentHint(all, "Tracker")).toBe("All sub-tasks merged. Tracker says In Progress for ABC-10.");
  });
});

describe("the focused sub-task and its one primary button (spec.md sections 6.20.10 and 6.20.13, AC-UX1)", () => {
  test("the default focus takes the first match of the spec order", () => {
    const building = p13({ state: "implementing" });
    const ready = p14({ state: "self_reviewed", head: "d".repeat(40) });
    expect(defaultFocus(subTask([p12(), building, ready]))?.id).toBe(14);
    expect(defaultFocus(subTask([p12(), building, p14()]))?.id).toBe(13);
    expect(defaultFocus(subTask([p12(), p13({ state: "pr_open", remotePr: 52 }), p14()]))?.id).toBe(12);
    const blocked = { kind: "red" as const, step: null, text: "Tests stay red.", part: 13 };
    expect(defaultFocus(subTask([p12(), building, ready], { blocked }))?.id).toBe(13);
    const moved = p13({
      state: "pr_open",
      remotePr: 52,
      bases: [{ taskRepo: 1, branch: "main", newCommits: 2, conflicted: false, changed: false }],
    });
    expect(defaultFocus(subTask([p12(), moved, p14({ state: "implementing" })]))?.id).toBe(13);
    const lower = p13({ state: "pr_open", remotePr: 52, lower: { key: "ABC-12", how: "merge" } });
    expect(defaultFocus(subTask([p12({ state: "merged" }), lower, p14({ state: "implementing" })]))?.id).toBe(13);
  });

  test("the lower part merged: a merge commit moves at once, a squash updates first, a pushed update pushes and moves", () => {
    const moved = [{ taskRepo: 1, branch: "main", newCommits: 2, conflicted: false, changed: false }];
    const base = { state: "pr_open" as const, remotePr: 52, pushed: "a".repeat(40) };
    const at = (o: Partial<TaskPartDto>) => {
      const p = p13({ ...base, ...o });
      return subtaskView(subTask([p12({ state: "merged" }), p]), p, SUB_OPTS);
    };
    const merge = at({ lower: { key: "ABC-12", how: "merge" }, bases: moved });
    expect([merge.status, merge.primary]).toEqual([
      "ABC-12 merged. ABC-13 must point to main now.",
      { kind: "move", label: "Move ABC-13 to main" },
    ]);
    expect(merge.detail).toBe("ABC-12 merged with a merge commit, so ABC-13 needs no git work.");
    const squash = at({ lower: { key: "ABC-12", how: "squash" }, bases: moved });
    expect([squash.status, squash.primary?.kind]).toEqual(["ABC-12 merged. Update ABC-13 from main first.", "update"]);
    const other = at({ lower: { key: "ABC-12", how: "other" }, bases: moved });
    expect(other.detail).toBe("Forge merged ABC-12 in a way that the app cannot match. The update merges main, and conflicts can come up.");
    const updated = at({ lower: { key: "ABC-12", how: "squash" }, head: "e".repeat(40) });
    expect([updated.status, updated.primary]).toEqual([
      "ABC-13 is up to date with main. Push it and move its PR to main.",
      { kind: "push-move", label: "Push and move to main" },
    ]);
    // A part without a PR moves in the app only, then opens its PR.
    const unpushed = at({ state: "self_reviewed", remotePr: null, pushed: null, lower: { key: "ABC-12", how: "squash" } });
    expect(unpushed.primary?.kind).toBe("move");
  });

  test("new commits after the push get Push to <branch>; a tracked PR gets Go to the PR; a planned part has no primary", () => {
    const pushed = p13({ state: "pr_open", remotePr: 52, pushed: "c".repeat(40) });
    const v = subtaskView(subTask([p12(), pushed]), pushed, SUB_OPTS);
    expect([v.status, v.primary]).toEqual([
      "ABC-13 (2 of 2) has new commits that are not on the server yet.",
      { kind: "push", label: "Push to feature/ABC-13-flush" },
    ]);
    const tracked = subtaskView(subTask([p12(), pushed]), p12(), SUB_OPTS);
    expect([tracked.status, tracked.primary?.kind]).toEqual(["ABC-12 (1 of 2): In review outside the app: PR #41.", "go-pr"]);
    const waits = p14({ start: "stack", after: 12, wait: "Waits for a review of ABC-12." });
    const planned = subtaskView(subTask([p12(), waits]), waits, SUB_OPTS);
    expect([planned.status, planned.primary, planned.more.map((a) => a.kind)]).toEqual([
      "ABC-14 (2 of 2): Waits for a review of ABC-12.",
      null,
      ["start-now", "drop", "tracker-move", "tracker-read"],
    ]);
  });

  test("a ready part opens its PR under its own name; the More menu keeps the tracker actions and no task Close", () => {
    const ready = p13({ state: "self_reviewed" });
    const v = subtaskView(subTask([p12(), ready]), ready, SUB_OPTS);
    expect([v.status, v.primary]).toEqual(["ABC-13 (2 of 2) is ready: 80 lines.", { kind: "open-pr", label: "Open the PR" }]);
    expect(v.more.map((a) => a.label)).toEqual(["Show the diff", "Start this part again", "Move in Tracker…", "Read Tracker again"]);
    expect(v.more[1]).toEqual({ kind: "restart", label: "Start this part again", part: 13 });
  });

  test("a part in review while another part builds: its own sentence and Go to the PR, not the build of the other part", () => {
    const review = p13({ state: "pr_open", remotePr: 52, pushed: "a".repeat(40), waiting: ["Anna"] });
    const t = subTask([p12(), review, p14({ state: "implementing", head: "f".repeat(40) })], { working: true });
    const v = subtaskView(t, review, SUB_OPTS);
    expect([v.status, v.primary?.kind, v.running]).toEqual(["ABC-13 (2 of 3): In review by Anna.", "go-pr", false]);
    expect(subtaskView(t, null, SUB_OPTS).status).toBe("Claude builds ABC-14 (3 of 3).");
  });

  test("a part on a part that changes another repository waits: Wait for the merge", () => {
    const text = "Needs you: ABC-14 builds on ABC-13, which also changes PROJ/lib. Let ABC-14 wait for the merge of ABC-13.";
    const waits = p14({ start: "stack", after: 13 });
    const t = subTask([p13({ state: "pr_open", remotePr: 52 }), waits], { blocked: { kind: "error", step: null, text, part: 14 } });
    const v = subtaskView(t, null, SUB_OPTS);
    expect([v.status, v.primary]).toEqual([text, { kind: "wait-merge", label: "Wait for the merge" }]);
  });

  test("AC-UX1: every part state has at most one primary action", () => {
    const states: Partial<TaskPartDto>[] = [
      { state: "planned", head: null },
      { state: "implementing" },
      { state: "self_reviewed" },
      { state: "pr_open", remotePr: 52 },
      { state: "changes_requested", remotePr: 52 },
      { state: "approved", remotePr: 52 },
      { state: "merged", remotePr: 52 },
      { state: "declined", remotePr: 52 },
      { state: "abandoned" },
    ];
    for (const o of states) {
      const p = p13(o);
      const v = subtaskView(subTask([p12(), p]), p, SUB_OPTS);
      expect(v.more.some((a) => a.kind === v.primary?.kind)).toBe(false);
      expect(typeof v.status).toBe("string");
    }
  });
});

// docs/plans/review-v2/spec.md section 6.25.6 (AC-B156): parts 13 and 14 build at the same time. Part 13 holds the first reason, and the
// question of part 14 waits in its row.
describe("reasons of parts that build at the same time (spec.md section 6.25.6, AC-B156)", () => {
  const ask13 = step({ id: 5, kind: "implement", part: 13 });
  const ask14 = step({ id: 6, kind: "implement", part: 14 });
  const first = { kind: "question" as const, step: 5, text: "Needs you: Claude asks: Keep the old name?" };
  const waiting = { kind: "question" as const, step: 6, text: "Needs you: Claude asks: Which flag name?" };
  const questions = [
    question({ id: 1, source: "loop", round: 1, step: 5, text: "Keep the old name?" }),
    question({ id: 2, source: "loop", round: 2, step: 6, text: "Which flag name?" }),
  ];
  const both = (o: Partial<TaskDto> = {}) =>
    subTask([p13({ state: "implementing" }), p14({ state: "implementing", head: "d".repeat(40), blocked: waiting })], {
      blocked: first,
      queued: 1,
      steps: [ask14, ask13],
      questions,
      canSetup: true,
      canInstruct: false,
      ...o,
    });

  test("the sub-task list shows each reason with the actor You, in part order", () => {
    const rows = subtaskRows(both(), SUB_OPTS).filter((r) => r.part);
    expect(rows.map((r) => [r.label, r.text, r.actor])).toEqual([
      ["ABC-13 (1 of 2)", first.text, "You"],
      ["ABC-14 (2 of 2)", waiting.text, "You"],
    ]);
    // A wait for the run slot names no actor of the user.
    const slot = both({ blocked: { kind: "slot", step: 5, text: "Waiting for the other run to finish." }, queued: 0 });
    const noWait = { ...slot, parts: slot.parts.map((p) => ({ ...p, blocked: null })) };
    expect(subtaskRows(noWait, SUB_OPTS).find((r) => r.part?.id === 13)).toMatchObject({ text: "Claude builds it.", actor: R });
  });

  test("the part with the first reason answers all questions; the waiting part says whom to act on first and has no primary button", () => {
    const t = both();
    const v13 = withSetup(t, t.parts[0] ?? null, subtaskView(t, t.parts[0] ?? null, SUB_OPTS));
    expect([v13.status, v13.primary?.kind, v13.screen]).toEqual([first.text, "answer", "questions"]);
    expect(openQuestions(t, "loop").map((q) => q.id)).toEqual([1, 2]);
    expect(questions.map((q) => questionPart(t, q))).toEqual(["ABC-13 (1 of 2)", "ABC-14 (2 of 2)"]);
    expect(questionPart(task({ questions }), questions[0] as TaskQuestionDto)).toBeNull();
    const p = t.parts[1] ?? null;
    const v14 = withSetup(t, p, subtaskView(t, p, SUB_OPTS));
    expect(v14).toMatchObject({
      status: waiting.text,
      detail: "Act on ABC-13 (1 of 2) first.",
      primary: null,
      needsYou: true,
      screen: "build",
    });
    // More holds See why for its own step and Stop. "Run setup again" is hidden.
    expect(v14.more.map((a) => a.kind)).toEqual(["see-why", "stop"]);
    // The Tell box shows nothing while a part waits.
    expect(tellBox({ ...t, blocked: { kind: "red", step: 5, text: "Needs you: red." }, canInstruct: true })).toBe("none");
    expect(tellBox({ ...t, blocked: { kind: "red", step: 5, text: "Needs you: red." }, canInstruct: true, queued: 0 })).toBe("open");
  });

  test("a held part with no reason waits until you act on the part of the first reason", () => {
    const t = both();
    const held = { ...t, parts: t.parts.map((p) => ({ ...p, blocked: null })), queued: 0 };
    const v = subtaskView(held, held.parts[1] ?? null, SUB_OPTS);
    expect([v.status, v.primary, v.running, v.more.map((a) => a.kind)]).toEqual([
      "ABC-14 (2 of 2) waits until you act on ABC-13 (1 of 2).",
      null,
      false,
      ["stop"],
    ]);
    const free = subtaskView({ ...held, blocked: null }, held.parts[1] ?? null, SUB_OPTS);
    expect(free.status).toBe("Claude builds ABC-14 (2 of 2).");
  });

  test("the Tasks row names the waiting reasons", () => {
    const { interview: _i, plan: _p, ...r } = both();
    expect(rowStatus(r as TaskRowDto)).toEqual({ text: "Needs you: a question, and 1 more", needsYou: true });
  });
});

describe("the plan of a task with sub-tasks (spec.md sections 6.20.1 and 6.20.5)", () => {
  test("the plan sentence counts the sub-tasks and the parts to build; the Build form counts by status category", () => {
    const starts = [
      { n: 1, keys: ["ABC-13"], start: "base" as const, after: null, reason: "", skip: false, title: "Flush", lines: 200 },
      { n: 2, keys: ["ABC-14"], start: "base" as const, after: null, reason: "", skip: false, title: "Measure", lines: 400 },
    ];
    const t = subTask([], { state: "spec_draft", plan: { ...PLAN, starts }, estimate: { ...ESTIMATE, lines: 600 } });
    expect(subPlanSentence(t)).toBe("The plan is ready: 4 sub-tasks, 2 to build, about 600 changed lines.");
    expect(subtaskView(t, null, SUB_OPTS).more.map((a) => a.kind)).toEqual(["edit-plan", "ask-again", "tracker-read", "stop"]);
    expect(subtaskCount("ABC-10", t.subtasks ?? [])).toBe("ABC-10 has 4 sub-tasks: 2 open, 1 in progress, 1 done.");
  });

  test("a cycle of picked starts gives the sentence of the server", () => {
    const live = [
      { n: 1, keys: ["ABC-13"] },
      { n: 2, keys: ["ABC-14"] },
    ];
    expect(
      startCycle(
        [
          { n: 1, start: "stack", after: "2" },
          { n: 2, start: "merge", after: "1" },
        ],
        live,
      ),
    ).toBe("ABC-13 cannot build on ABC-14, because ABC-14 builds on ABC-13.");
    expect(
      startCycle(
        [
          { n: 1, start: "base", after: null },
          { n: 2, start: "stack", after: "1" },
        ],
        live,
      ),
    ).toBeNull();
  });

  test("the PR title names the part key, a split part, or two sub-tasks", () => {
    const a = p13({ id: 20, title: "Flush first" });
    const b = p13({ id: 21, ord: 3, title: "Flush second" });
    const c = p14({ id: 22, keys: ["ABC-14", "ABC-15"], title: "Measure" });
    const t = subTask([a, b, c]);
    expect([prTitle(t, a), prTitle(t, b), prTitle(t, c)]).toEqual([
      "ABC-13 (part 1 of 2): Flush first",
      "ABC-13 (part 2 of 2): Flush second",
      "ABC-14, ABC-15: Measure",
    ]);
    expect(prTitle(task(), part())).toBe("ABC-12: Trim spaces in user names");
  });
});

// ---------- docs/plans/review-v2/ps5-plan.md, PS5-C1: the working rows, point questions, and the Log session groups ----------

describe("ps5-plan.md D4: the stage of a step row", () => {
  test("rowPhase maps each step kind and item", () => {
    const cases: [TaskStepDto["kind"], string | null, RowPhase | null][] = [
      ["implement", "build", "building"],
      ["tests", "P1", "building"],
      ["fix", "points", "following"],
      ["fix", "pushback", "following"],
      ["fix", "review", "judging"],
      ["fix", "critic", "judging"],
      ["fix", "checks", "fixing"],
      ["fix", "I1", "fixing"],
      ["instruct", "I1", "following"],
      ["check", "setup", "setup"],
      ["check", "base", "baseline"],
      ["check", "checks", "checking"],
      ["check", "I1", "checking"],
      ["commit", "build", "checking"],
      ["review", "critic", "critic"],
      ["review", "review", "reviewing"],
      ["update", "U1", "updating"],
      ["resolve", "U1", "resolving"],
      ["interview", null, null],
      ["spec", null, null],
      ["replan", null, null],
      ["push", null, null],
      ["pr", null, null],
      ["question", null, null],
    ];
    expect(cases.map(([kind, item]) => [kind, item, rowPhase({ kind, item })])).toEqual(cases);
  });

  // part-session.md section 9.7 invariant 8, ps4-plan.md WP-5 and WP-7: the open row that gives the stage of a part. Steps come newest
  // first, so a message that waits for the next GO comes before the run row of its part.
  test("phaseRow takes the run row of the part, not a waiting message beside it, and the resolve or check row of an update", () => {
    const at = (id: number, kind: TaskStepDto["kind"], state: TaskStepDto["state"], item: string | null, p = 7) =>
      step({ id, kind, state, item, part: p, endedAt: null });
    const message = at(9, "instruct", "waiting", "I1");
    const build = at(8, "implement", "running", "build");
    const cases: [TaskStepDto[], number | undefined, number | null][] = [
      [[message, build], 7, 8],
      // The run row waits for the run slot beside the message.
      [[message, at(8, "fix", "waiting", "checks")], 7, 8],
      // A message alone is the follow-up that GO runs next, or that waits for the run slot.
      [[message], 7, 9],
      [[at(9, "instruct", "running", "I1")], 7, 9],
      [[at(11, "resolve", "running", "U1"), at(10, "update", "running", "U1")], 7, 11],
      [[at(12, "check", "running", "U1"), at(10, "update", "running", "U1")], 7, 12],
      [[at(10, "update", "running", "U1")], 7, 10],
      [[message, at(10, "update", "running", "U1")], 7, 10],
      // Ended rows and rows of other parts give no stage.
      [[at(13, "implement", "running", "build", 8), at(8, "implement", "ok", "build")], 7, null],
      [[message, at(13, "implement", "running", "build", 8)], undefined, 13],
      [[], 7, null],
    ];
    expect(cases.map(([steps, p, want]) => [p, want, phaseRow(steps, p)?.id ?? null])).toEqual(cases.map(([, p, want]) => [p, want, want]));
    expect(rowPhase(phaseRow([message, build], 7) as TaskStepDto)).toBe("building");
  });
});

// ps5-plan.md section 3 (AC-B368, AC-B380): the status of a working row follows the stage of the open row of its part. The count of
// done tasks and the try and round counts need stored facts (PS5-S1), so the sentences have no count yet.
describe("ps5-plan.md section 3: the working rows", () => {
  const open = (kind: TaskStepDto["kind"], item: string | null, part = 7, id = 9) =>
    step({ id, kind, part, item, state: "running", endedAt: null });
  const HOLD = ["Hold", "Stop"];

  test("one part: each stage has its sentence for your change; Hold only on building, fixing, and judging", () => {
    const rows: [TaskStepDto["kind"], string, string, string[]][] = [
      ["implement", "build", "Claude builds your change.", HOLD],
      ["check", "checks", "The app runs the checks of your change.", ["Stop"]],
      ["commit", "build", "The app runs the checks of your change.", ["Stop"]],
      ["fix", "checks", "Claude fixes the checks of your change.", HOLD],
      ["review", "review", "A second Claude run reviews your change.", ["Stop"]],
      ["review", "critic", "A second Claude run reviews your change.", ["Stop"]],
      ["fix", "review", "Claude works on the review points of your change.", HOLD],
      ["fix", "points", "Claude fixes the listed points of your change.", ["Stop"]],
      ["fix", "pushback", "Claude fixes the review points that you chose to fix for your change.", ["Stop"]],
      ["check", "setup", "The app runs the setup commands of your change.", ["Stop"]],
      ["check", "base", "The app runs the checks on the base of your change.", ["Stop"]],
    ];
    expect(
      rows.map(([kind, item]) => {
        const v = view(building({ steps: [open(kind, item)] }));
        return [kind, item, v.status, v.more.map((a) => a.label)];
      }),
    ).toEqual(rows);
  });

  // ps4-plan.md WP-7: a message that waits for the next GO sits beside the run row of its part, and it is newer.
  test("one part: a waiting message beside the build run row keeps the building sentence and Hold", () => {
    const message = step({ id: 10, kind: "instruct", part: 7, item: "I1", state: "waiting", endedAt: null });
    const v = view(building({ steps: [message, open("implement", "build")] }));
    expect([v.status, v.more.map((a) => a.label)]).toEqual(["Claude builds your change.", HOLD]);
  });

  test("one part: other steps keep their sentence, and the pointer commit is no check", () => {
    const at = (s: TaskStepDto) => view(building({ steps: [s] })).status;
    expect(at(open("commit", "pointer"))).toBe("Pointing PROJ/repo at the merged commit.");
    expect(at(open("push", null))).toBe("Pushing the branch.");
    expect(at(open("pr", null))).toBe("Opening the PR.");
  });

  test("several parts: the sentence names part k", () => {
    const two = (kind: TaskStepDto["kind"], item: string) =>
      view(building({ parts: [part({ id: 6, state: "self_reviewed" }), part({ id: 7, ord: 2 })], steps: [open(kind, item)] })).status;
    expect(two("implement", "build")).toBe("Claude builds part 2.");
    expect(two("check", "checks")).toBe("The app runs the checks of part 2.");
    expect(two("fix", "checks")).toBe("Claude fixes the checks of part 2.");
    expect(two("fix", "review")).toBe("Claude works on the review points of part 2.");
    expect(two("review", "review")).toBe("A second Claude run reviews part 2.");
    expect(two("check", "setup")).toBe("The app runs the setup commands of part 2.");
  });

  test("sub-tasks: the view names the part label, and each row gives the short text and who acts", () => {
    const at = (kind: TaskStepDto["kind"], item: string) =>
      subTask([p12(), p13({ state: "implementing" })], { steps: [open(kind, item, 13)] });
    expect(subtaskView(at("fix", "review"), null, SUB_OPTS).status).toBe("Claude works on the review points of ABC-13 (2 of 2).");
    expect(subtaskView(at("implement", "build"), null, SUB_OPTS).status).toBe("Claude builds ABC-13 (2 of 2).");
    const rows: [TaskStepDto["kind"], string, string, string][] = [
      ["implement", "build", "Claude builds it.", R],
      ["check", "checks", "The app runs the checks.", "The app"],
      ["fix", "checks", "Claude fixes the checks.", R],
      ["review", "review", "A second Claude run reviews it.", R],
      ["fix", "review", "Claude works on the review points.", R],
      ["instruct", "I1", "Claude works on your instructions.", R],
      ["check", "setup", "The app runs the setup commands.", "The app"],
    ];
    expect(
      rows.map(([kind, item]) => {
        const row = subtaskRows(at(kind, item), SUB_OPTS).find((r) => r.part?.id === 13);
        return [kind, item, row?.text, row?.actor];
      }),
    ).toEqual(rows);
  });

  test("sub-tasks: two parts build at once, and each part shows the stage of its own row", () => {
    const t = subTask([p13({ state: "implementing" }), p14({ state: "implementing", head: "d".repeat(40) })], {
      steps: [open("check", "checks", 14, 9), open("fix", "checks", 13, 8)],
    });
    expect(subtaskView(t, t.parts[0] ?? null, SUB_OPTS).status).toBe("Claude fixes the checks of ABC-13 (1 of 2).");
    expect(subtaskView(t, t.parts[1] ?? null, SUB_OPTS).status).toBe("The app runs the checks of ABC-14 (2 of 2).");
    expect(subtaskRows(t, SUB_OPTS).flatMap((r) => (r.part ? [r.text] : []))).toEqual([
      "Claude fixes the checks.",
      "The app runs the checks.",
    ]);
  });

  test("sub-tasks: a part in review or ready never takes the open row of another part as its own", () => {
    const review = p13({ state: "pr_open", remotePr: 52, pushed: "a".repeat(40), waiting: ["Anna"] });
    const other = p14({ state: "implementing", head: "f".repeat(40) });
    const t = subTask([p12(), review, other], { steps: [open("implement", "build", 14)], working: true });
    const v = subtaskView(t, review, SUB_OPTS);
    expect([v.status, v.primary?.kind, v.running]).toEqual(["ABC-13 (2 of 3): In review by Anna.", "go-pr", false]);
    const ready = p13({ state: "self_reviewed" });
    const r = subtaskView({ ...t, parts: [p12(), ready, other] }, ready, SUB_OPTS);
    expect([r.status, r.primary?.kind]).toEqual(["ABC-13 (2 of 3) is ready: 80 lines.", "open-pr"]);
  });

  test("sub-tasks: a held part row says that its work is kept", () => {
    const held = p13({ state: "implementing", blocked: { kind: "held", step: null, text: "Part 2 is held." } });
    expect(subtaskRows(subTask([p12(), held]), SUB_OPTS).find((r) => r.part?.id === 13)).toMatchObject({
      text: "On hold. Its work is kept.",
      actor: "You",
    });
  });

  test("the Plan tab badge of a working part names its stage, and never repeats the state", () => {
    const at = (p: TaskPartDto, steps: TaskStepDto[]) => stageBadge(building({ parts: [p], steps }), p);
    expect(at(part(), [open("implement", "build")])).toBeNull();
    expect(at(part(), [open("check", "checks")])).toBe("The checks run");
    expect(at(part(), [open("fix", "review")])).toBe("Review points");
    expect(at(part(), [open("review", "critic")])).toBe("Quick review");
    expect(at(part(PR_PART), [updateStep()])).toBe("Update");
    expect(at(part(), [])).toBeNull();
    expect(at(part(), [step({ id: 9, kind: "check", part: 7, item: "checks" })])).toBeNull();
  });
});

// ps5-plan.md section 4.4 (AC-B373, AC-B374): a push-back question has no recommended answer and needs an option. It can wait in
// ready, so the questions screen reads the loop questions there too.
describe("ps5-plan.md section 4.4: push-back questions", () => {
  const card = { id: 31, check: "The loop reads past the end.", reason: "The guard at line 4 stops it.", cite: "src/a.ts:4" };
  const pushback = question({ id: 5, source: "loop", point: { ...card, citeFound: true }, recommended: 0 });
  const form = (questions: TaskQuestionDto[]) =>
    renderToStaticMarkup(createElement(QuestionsForm, { questions, busy: false, onSend: () => {}, onRecommended: () => {} }));

  test("the loop questions in implementing and ready, the interview questions before the build", () => {
    expect(questionSource(building())).toBe("loop");
    expect(questionSource(building({ state: "ready" }))).toBe("loop");
    expect(questionSource(task())).toBe("interview");
    expect(questionSource(task({ state: "spec_draft" }))).toBe("interview");
  });

  test("a push-back question shows no recommended answer, no preselected option, and no Use the recommended answers", () => {
    const html = form([pushback, question({ id: 6, source: "loop" })]);
    expect(html).not.toContain("Use the recommended answers");
    expect(html.match(/Recommended/g)?.length).toBe(1);
    expect(html).not.toMatch(/id="tq-5-\d"[^>]*checked/);
    expect(html).toMatch(/id="tq-6-0"[^>]*checked/);
    const plain = form([question({ id: 6, source: "loop" })]);
    expect(plain).toContain("Use the recommended answers");
  });

  test("a push-back card shows the check, the reason, and the proof; the warning only when the app did not find the proof", () => {
    const html = form([pushback]);
    expect(html).toContain("Check: The loop reads past the end.");
    expect(html).toContain("Reason: The guard at line 4 stops it.");
    expect(html).toMatch(/Proof: <code translate="no"[^>]*>src\/a\.ts:4<\/code>/);
    expect(html).not.toContain("Why it matters");
    expect(html).toMatch(/id="tq-5-0"[^>]*aria-describedby="tq-5-why"/);
    expect(html).toMatch(/<div id="tq-5-why"/);
    expect(html).not.toContain("The app did not find this place");
    const lost = form([question({ id: 5, source: "loop", point: { ...card, check: null, citeFound: false } })]);
    expect(lost).toContain("The app did not find this place in the code or the plan.");
    expect(lost).not.toContain("Check:");
  });

  test("a push-back answer needs an option, also with a note; another question takes a note alone", () => {
    expect(answersOf([pushback], { 5: { choice: null, text: "It is fine." } })).toEqual({ missing: 5 });
    expect(answersOf([pushback], { 5: { choice: 1, text: "" } })).toEqual([{ question: 5, choice: 1 }]);
    const plain = question({ id: 6 });
    expect(answersOf([plain], { 6: { choice: null, text: "Keep it short." } })).toEqual([{ question: 6, text: "Keep it short." }]);
  });
});

// ps5-plan.md section 4.10: the hint under the Tell box.
describe("ps5-plan.md section 4.10: the Tell box hint", () => {
  const html = (box: "open" | "live" | "queued" | "busy", pending = false) =>
    renderToStaticMarkup(
      createElement(TellClaude, { runner: R, box, pending, restore: { id: 1, text: "Use works." }, onSend: async () => {} }),
    );
  const sendable = (h: string) => !/<button type="submit"[^>]* disabled=""/.test(h);

  test("open: the message goes into a run of this part; busy: the send waits for the end of the run", () => {
    expect(html("open")).toContain(
      "Claude gets your message in a run of this part. The app then runs the checks and its own review. Pushes and other git actions stay buttons.",
    );
    expect(html("busy")).toContain("Claude or the checks are working. You can send when this run ends.");
    expect([sendable(html("open")), sendable(html("busy")), sendable(html("open", true))]).toEqual([true, false, false]);
  });

  // part-session.md section 2.9 and ps4-plan.md WP-7: a send during a session run of the part goes to it now, or waits for its end.
  test("live: Claude reads this now; queued: Claude reads this when the current run ends; both can send", () => {
    expect(html("live")).toContain("Claude reads this now.");
    expect(html("queued")).toContain("Claude reads this when the current run ends.");
    expect([sendable(html("live")), sendable(html("queued"))]).toEqual([true, true]);
  });

  test("tellBox takes live or queued from the part, and the first build has the box", () => {
    const run = step({ id: 9, kind: "implement", part: 7, item: "build", state: "running", run: 4, endedAt: null });
    const at = (instructRun: TaskPartDto["instructRun"], canInstruct: boolean) =>
      tellBox(building({ parts: [part({ instructRun })], steps: [run], working: true, canInstruct }));
    expect([at("live", true), at("queued", true), at(null, false)]).toEqual(["live", "queued", "busy"]);
    // A built part with no run of its own: a send starts a run.
    expect(tellBox(building({ parts: [part({ state: "self_reviewed" })], canInstruct: true }))).toBe("open");
    // A reason that the server refuses for a send keeps the box away, also with a live run.
    const usage = { kind: "usage" as const, step: 9, text: "x" };
    expect(tellBox(building({ parts: [part({ instructRun: "live" })], blocked: usage, canInstruct: true }))).toBe("none");
  });
});

// ps5-plan.md section 4.8 (AC-B379): a run that starts a new session opens a group for its part. Later rows of that part join it.
describe("ps5-plan.md section 4.8: the session groups of the Log tab", () => {
  const ses = (resumed: boolean, id: string, why: string | null = resumed ? null : "No transcript is kept.") =>
    stepDetail.parse({ session: { id, resumed, why, purpose: "build" } });
  const run = (id: number, part: number, kind: TaskStepDto["kind"], detail = stepDetail.parse({})) => step({ id, part, kind, detail });
  const shapeOf = (rows: ReturnType<typeof sessionRows>) =>
    rows.map((r) =>
      "rows" in r
        ? `session ${r.part}: ${r.rows.map((x) => ("send" in x ? `send ${x.send.id}` : x.step.id)).join(" ")}`
        : "send" in r
          ? `send ${r.send.id}`
          : `${r.step.id}`,
    );

  test("two parts that build at once give two groups; each group sits at its newest row", () => {
    const steps = [
      run(6, 7, "commit"),
      run(5, 8, "check"),
      run(4, 7, "fix", ses(true, "s7b")),
      run(3, 8, "implement", ses(false, "s8")),
      run(2, 7, "implement", ses(false, "s7")),
      run(1, 7, "check"),
    ];
    expect(shapeOf(sessionRows(logRows(steps)))).toEqual(["session 7: 6 4 2", "session 8: 5 3", "1"]);
  });

  test("a run with a new session starts a new group; a resumed run with a new ID stays in the group", () => {
    const steps = [
      run(5, 7, "check"),
      run(4, 7, "fix", ses(false, "s7c", "The branch moved after the last run.")),
      run(3, 7, "fix", ses(true, "s7b")),
      run(2, 7, "implement", ses(false, "s7a")),
    ];
    const rows = sessionRows(logRows(steps));
    expect(shapeOf(rows)).toEqual(["session 7: 5 4", "session 7: 3 2"]);
    const t = building({ steps });
    expect(rows.map((r) => ("rows" in r ? `${sessionTitle(t, r, R)}, ${sessionRuns(r)}` : ""))).toEqual([
      "Claude session, 1",
      "Claude session, 2",
    ]);
    expect(steps.map(sessionNote)).toEqual([
      null,
      "New session: The branch moved after the last run.",
      "Resumed",
      "New session: No transcript is kept.",
    ]);
  });

  test("the title names part k when the task has more parts", () => {
    const steps = [run(2, 8, "implement", ses(false, "s8"))];
    const t = building({ parts: [part(), part({ id: 8, ord: 2 })], steps });
    const g = sessionRows(logRows(steps))[0];
    expect(g && "rows" in g ? sessionTitle(t, g, R) : null).toBe("Claude session of part 2");
  });

  test("rows before the first session run and the rows of an old task stay top level", () => {
    const old = [run(3, 7, "commit"), run(2, 7, "implement"), run(1, 7, "check")];
    expect(shapeOf(sessionRows(logRows(old)))).toEqual(["3", "2", "1"]);
    const interview = step({ id: 1, kind: "interview" });
    expect(shapeOf(sessionRows(logRows([run(3, 7, "check"), run(2, 7, "implement", ses(false, "s")), interview])))).toEqual([
      "session 7: 3 2",
      "1",
    ]);
  });

  test("a send nests in the session group of its part, and the Tell box still finds the running send", () => {
    const steps = [
      step({ id: 5, kind: "check", part: 7, item: "I1", state: "running", endedAt: null }),
      instruct({ id: 4 }),
      run(3, 7, "fix", ses(true, "s7b")),
      run(2, 7, "implement", ses(false, "s7")),
    ];
    expect(shapeOf(sessionRows(logRows(steps)))).toEqual(["session 7: send 4 3 2"]);
    const t = building({ parts: [part({ state: "self_reviewed" })], steps, canInstruct: false });
    expect(tellBox(t)).toBe("busy");
    expect(view(t).more.map((a) => a.label)).toEqual(["Stop"]);
  });

  test("the Log tab shows a group with its title, its run count, and the session line of each run; each run stays a task item", () => {
    const steps = [run(4, 7, "check"), run(3, 7, "fix", ses(true, "s7b")), run(2, 7, "implement", ses(false, "s7")), run(1, 7, "check")];
    const html = renderToStaticMarkup(createElement(LogTab, { t: building({ steps }), runner: R, onRunLog: () => {} }));
    expect(html).toContain('<li data-session="7"');
    expect(html).toContain("Claude session</span>");
    expect(html).toContain("2 runs");
    expect(html).toContain('aria-label="Runs of this session, newest first"');
    expect(html).toContain("New session: No transcript is kept.");
    expect(html).toContain("Resumed");
    expect(html.match(/<li id="task-step-\d+" data-task-item/g)?.length).toBe(4);
  });
});

// ---------- Hold, Start again, and the usage limit (ps5-plan.md sections 3, 4.2, and 4.3) ----------

describe("ps5-plan.md section 4.2: Hold, On hold, Skip, and Start again", () => {
  const open = (kind: TaskStepDto["kind"], item: string | null, p = 7, id = 9) =>
    step({ id, kind, part: p, item, state: "running", endedAt: null });
  const acts = (v: TaskView): (string | number | null)[][] => v.more.map((a) => [a.kind, a.part ?? null]);
  const held = (p: number) => ({ kind: "held" as const, step: 9, part: p, text: `Part ${p} is on hold. Its work is kept.` });

  test("AC-B369: Hold shows only while the part builds, fixes, or judges, and acts on the part of the open row", () => {
    const hold = [
      ["hold", 7],
      ["stop", null],
    ];
    const stop = [["stop", null]];
    const rows: [TaskStepDto["kind"], string, (string | number | null)[][]][] = [
      ["implement", "build", hold],
      ["fix", "checks", hold],
      ["fix", "review", hold],
      ["fix", "critic", hold],
      ["check", "checks", stop],
      ["commit", "build", stop],
      ["review", "review", stop],
      ["review", "critic", stop],
      ["fix", "points", stop],
      ["fix", "pushback", stop],
      ["check", "setup", stop],
      ["check", "base", stop],
    ];
    expect(rows.map(([kind, item]) => [kind, item, acts(view(building({ steps: [open(kind, item)] })))])).toEqual(rows);
    // Several parts: Hold names the part of the open row.
    const two = building({
      parts: [part({ id: 6, state: "self_reviewed" }), part({ id: 7, ord: 2 })],
      steps: [open("implement", "build")],
    });
    expect(view(two).more[0]).toEqual({ kind: "hold", label: "Hold", part: 7 });
    // A send ends by itself, ready has no build, and no open row has nothing to hold.
    expect(acts(view(building({ steps: [open("fix", "I1"), instruct({ id: 4 })] })))).toEqual(stop);
    expect(acts(view(building({ state: "ready", parts: [part({ state: "self_reviewed" })], steps: [open("fix", "checks")] })))).toEqual(
      stop,
    );
    expect(view(building({ working: true })).more.map((a) => a.kind)).toEqual(["stop"]);
  });

  test("AC-B369: sub-tasks: Hold acts on the focused part, also when another part holds the first open row", () => {
    const t = subTask([p13({ state: "implementing" }), p14({ state: "implementing", head: "d".repeat(40) })], {
      steps: [open("check", "checks", 14, 9), open("fix", "checks", 13, 8)],
    });
    expect(acts(subtaskView(t, t.parts[0] ?? null, SUB_OPTS))).toEqual([
      ["hold", 13],
      ["stop", null],
    ]);
    expect(acts(subtaskView(t, t.parts[1] ?? null, SUB_OPTS)).filter(([k]) => k === "hold")).toEqual([]);
    const first = subTask([p12(), p13({ state: "implementing" })], { steps: [open("implement", "build", 13)] });
    expect(subtaskView(first, null, SUB_OPTS).more[0]).toEqual({ kind: "hold", label: "Hold", part: 13 });
  });

  test("AC-B369: On hold in a one-part task: Continue with the part, Start this part again while unpushed, and Stop", () => {
    const t = building({ parts: [part({ blocked: HELD })], steps: [open("implement", "build")] });
    const v = view(t);
    expect(shape(v)).toEqual({
      status: "Your change is on hold. Its work is kept.",
      primary: "Continue",
      more: ["Start this part again", "Stop"],
      screen: "build",
    });
    expect([v.primary, v.running, v.needsYou]).toEqual([{ kind: "continue-part", label: "Continue", part: 7 }, false, false]);
    expect(acts(v)).toEqual([
      ["restart", 7],
      ["stop", null],
    ]);
    // A push of the part or of a PR row of it: the server refuses Start again.
    const pushed = building({ parts: [part({ blocked: HELD, pushed: "a".repeat(40) })] });
    expect(view(pushed).more.map((a) => a.label)).toEqual(["Stop"]);
    const row = { ...prRow({ taskRepo: 2, repo: "lib" }), pushed: "b".repeat(40) };
    expect(view(building({ parts: [part({ blocked: HELD })], prs: [row] })).more.map((a) => a.label)).toEqual(["Stop"]);
    // ps4-plan.md section 2.6: held comes before a slot wait in t.blocked.
    const slot = building({
      parts: [part({ blocked: HELD })],
      blocked: { kind: "slot", step: 9, text: "Waiting for the other run to finish." },
    });
    expect(view(slot).status).toBe("Your change is on hold. Its work is kept.");
  });

  test("AC-B369: On hold in a task with several parts names part k", () => {
    const t = building({ parts: [part({ id: 6, state: "self_reviewed" }), part({ id: 7, ord: 2, blocked: held(7) })] });
    expect(view(t).status).toBe("Part 2 is on hold. Its work is kept.");
    expect(view(t).primary).toEqual({ kind: "continue-part", label: "Continue", part: 7 });
    expect(view(t).more.map((a) => a.kind)).toEqual(["restart", "stop"]);
  });

  test("AC-B369: On hold with sub-tasks: the part label, Skip this part, Start again while unpushed, Stop, and the tracker actions", () => {
    const p = p13({ state: "implementing", blocked: held(13) });
    const t = subTask([p12(), p], { steps: [open("implement", "build", 13)] });
    const v = subtaskView(t, p, SUB_OPTS);
    expect(shape(v)).toEqual({
      status: "ABC-13 (2 of 2) is on hold. Its work is kept.",
      primary: "Continue",
      more: ["Skip this part", "Start this part again", "Stop", "Move in Tracker…", "Read Tracker again"],
      screen: "build",
    });
    expect(acts(v).slice(0, 2)).toEqual([
      ["skip", 13],
      ["restart", 13],
    ]);
    expect(v.primary?.part).toBe(13);
    // The first reason of another part does not hide the hold.
    const other = subTask([p12(), p, p14({ state: "implementing" })], {
      blocked: { kind: "red", cause: "checks", step: 3, part: 14, text: "x." },
    });
    expect(subtaskView(other, p, SUB_OPTS).status).toBe("ABC-13 (2 of 3) is on hold. Its work is kept.");
  });

  test("AC-B369: On hold in a stopped task: Continue resumes the part and the task, and Close the task, because Stop is refused there", () => {
    const t = building({ state: "stopped", stoppedFrom: "implementing", parts: [part({ blocked: HELD })] });
    expect(shape(view(t))).toEqual({
      status: "Your change is on hold. Its work is kept.",
      primary: "Continue",
      more: ["Start this part again", "Close the task"],
      screen: "build",
    });
    expect(view(t).needsYou).toBe(true);
    const p = p13({ state: "implementing", blocked: held(13) });
    const s = subTask([p12(), p], { state: "stopped", stoppedFrom: "implementing" });
    expect(shape(subtaskView(s, p, SUB_OPTS))).toEqual({
      status: "ABC-13 (2 of 2) is on hold. Its work is kept.",
      primary: "Continue",
      more: ["Skip this part", "Start this part again", "Close the task"],
      screen: "build",
    });
    // A focus on a part that is not held keeps the stopped row, because a plain Continue leaves the hold in place.
    const free = p14({ state: "implementing", head: "d".repeat(40) });
    const both = subTask([p, free], { state: "stopped", stoppedFrom: "implementing" });
    expect(subtaskView(both, free, SUB_OPTS).primary).toEqual({ kind: "resume", label: "Continue" });
    expect(subtaskView(both, p, SUB_OPTS).primary).toEqual({ kind: "continue-part", label: "Continue", part: 13 });
  });

  test("Start this part again on the Needs-you rows of REASON_EXITS RUN_ENDS and KEPT, only while unpushed and implementing", () => {
    const at = (b: Partial<NonNullable<TaskDto["blocked"]>>, o: Partial<TaskDto> = {}) =>
      view(
        building({
          blocked: { kind: "error", step: 4, text: "Needs you: x.", ...b },
          steps: [step({ id: 4, kind: "implement", part: 7 })],
          ...o,
        }),
      );
    const keys = [
      ["red", "checks"],
      ["question", "no_change"],
      ["error", "run"],
      ["error", "restart"],
      ["stuck", "stall"],
      ["stuck", "loop"],
      ["stuck", "turns"],
      ["stuck", "time"],
    ] as const;
    for (const [kind, cause] of keys) {
      const more = at({ kind, cause }).more;
      const i = more.findIndex((a) => a.kind === "restart");
      expect([kind, cause, more[i]]).toEqual([kind, cause, { kind: "restart", label: "Start this part again", part: 7 }]);
      expect(more.slice(i + 1).every((a) => a.kind === "see-why" || a.kind === "stop")).toBe(true);
      expect(at({ kind, cause }, { parts: [part({ pushed: "a".repeat(40) })] }).more.some((a) => a.kind === "restart")).toBe(false);
    }
    // ps5-plan.md section 3: See why shows when the reason names a step.
    expect(at({ kind: "unfinished" }).more.map((a) => a.kind)).toEqual(["restart", "see-why", "stop"]);
    expect(at({ kind: "unfinished", step: null }).more.map((a) => a.kind)).toEqual(["restart", "stop"]);
    expect(at({ kind: "question", cause: "no_change" }).more.map((a) => a.kind)).toEqual(["restart", "see-why", "stop"]);
    // Other reasons and an old reason with no cause get no Start again, and neither does ready.
    const others = [
      { kind: "red" },
      { kind: "red", cause: "setup" },
      { kind: "denied_path", cause: "path" },
      { kind: "question", cause: "red_before" },
      { kind: "blocker" },
    ] as const;
    for (const b of others) expect([b, at(b).more.some((a) => a.kind === "restart")]).toEqual([b, false]);
    const ready = at({ kind: "red", cause: "checks" }, { state: "ready", parts: [part({ state: "self_reviewed" })] });
    expect(ready.more.some((a) => a.kind === "restart")).toBe(false);
    // Several parts: the part of the reason.
    const two = at({ kind: "error", cause: "run" }, { parts: [part({ id: 6, state: "self_reviewed" }), part({ id: 7, ord: 2 })] });
    expect(two.more.find((a) => a.kind === "restart")?.part).toBe(7);
  });
});

describe("ps5-plan.md section 4.3: the usage limit rows", () => {
  // Local times, so no time zone moves the reset to another day.
  const T0 = new Date(2026, 10, 14, 10, 0).getTime();
  const AT = new Date(2026, 10, 14, 14, 30).getTime();
  const NEXT = new Date(2026, 10, 15, 0, 30).getTime();
  const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const usage = (o: Partial<NonNullable<TaskDto["blocked"]>> = {}, t: Partial<TaskDto> = {}) =>
    building({ blocked: { kind: "usage", step: 4, text: "Needs you: the server text.", ...o }, ...t });
  const at = (t: TaskDto, now: number) => taskView(t, { runner: R, forge: "Bitbucket", now });

  test("resetText: the time on the same day, else the date and the time", () => {
    expect(resetText(AT, T0)).toBe(hm(AT));
    expect(resetText(NEXT, T0)).toBe(day(NEXT));
    expect(resetText(NEXT, T0)).not.toBe(hm(NEXT));
  });

  test("AC-B371: armed false before the reset: the time in the status and on the button, and Stop in More", () => {
    const v = at(usage({ resumeAt: AT, armed: false }), T0);
    expect(shape(v)).toEqual({
      status: `Your Claude usage limit is reached. It resets at ${hm(AT)}.`,
      primary: `Resume at ${hm(AT)}`,
      more: ["Stop"],
      screen: "build",
    });
    expect([v.primary?.kind, v.needsYou, v.running]).toEqual(["resume", true, false]);
    expect(at(usage({ resumeAt: NEXT }), T0).primary?.label).toBe(`Resume at ${day(NEXT)}`);
  });

  test("AC-B371: the label changes to Resume at the reset time with no reload, because the clock ticks while the reason waits", () => {
    const t = usage({ resumeAt: AT });
    expect(at(t, AT - 1).primary?.label).toBe(`Resume at ${hm(AT)}`);
    expect(at(t, AT).primary?.label).toBe("Resume");
    expect(at(t, AT + MIN).status).toBe(`Your Claude usage limit is reached. It resets at ${hm(AT)}.`);
    expect(ticks(t)).toBe(true);
    expect(ticks(building({ parts: [part({ blocked: { kind: "usage", step: 4, text: "x", resumeAt: AT, armed: true } })] }))).toBe(true);
    expect(ticks(building())).toBe(false);
    expect(ticks(building({ steps: [step({ id: 9, kind: "implement", part: 7, state: "running", endedAt: null })] }))).toBe(true);
  });

  test("no reset time: the first sentence only, and Resume", () => {
    expect(shape(at(usage(), T0))).toEqual({
      status: "Your Claude usage limit is reached.",
      primary: "Resume",
      more: ["Stop"],
      screen: "build",
    });
  });

  test("AC-B371: armed true: no primary, Cancel the resume and Stop; a past or absent time says now", () => {
    const v = at(usage({ resumeAt: AT, armed: true }), T0);
    expect(shape(v)).toEqual({
      status: `Claude resumes at ${hm(AT)}.`,
      primary: null,
      more: ["Cancel the resume", "Stop"],
      screen: "build",
    });
    expect([v.more[0]?.kind, v.needsYou]).toEqual(["cancel-resume", false]);
    expect(at(usage({ resumeAt: AT, armed: true }), AT).status).toBe("Claude resumes now.");
    expect(at(usage({ armed: true }), T0).status).toBe("Claude resumes now.");
  });

  test("ps5-plan.md D9: no row shows the server text of a usage reason, in ready and in the rows of a task with sub-tasks", () => {
    const ready = at(usage({ resumeAt: AT }, { state: "ready", parts: [part({ state: "self_reviewed" })] }), T0);
    expect(shape(ready)).toEqual({
      status: `Your Claude usage limit is reached. It resets at ${hm(AT)}.`,
      primary: `Resume at ${hm(AT)}`,
      more: ["Stop"],
      screen: "build",
    });
    const waits = { kind: "usage" as const, step: 6, text: "Needs you: the server text.", resumeAt: AT, armed: true };
    const t = subTask([p13({ state: "implementing" }), p14({ state: "implementing", head: "d".repeat(40), blocked: waits })], {
      blocked: { kind: "usage", step: 5, part: 13, text: "Needs you: the server text.", resumeAt: AT },
      queued: 1,
    });
    const o = { ...SUB_OPTS, now: T0 };
    expect(subtaskView(t, t.parts[0] ?? null, o).primary?.label).toBe(`Resume at ${hm(AT)}`);
    expect(subtaskView(t, t.parts[1] ?? null, o).status).toBe(`Claude resumes at ${hm(AT)}.`);
    expect(subtaskRows(t, o).flatMap((r) => (r.part ? [[r.text, r.actor]] : []))).toEqual([
      [`Your Claude usage limit is reached. It resets at ${hm(AT)}.`, "You"],
      [`Claude resumes at ${hm(AT)}.`, "The app"],
    ]);
  });
});

describe("Start again leftovers of ps4-plan.md WP-4", () => {
  const commit = (id: number, part: number, item: string) => step({ id, kind: "commit", part, item });
  const docs = { version: 1, plan: "### [ ] T1.1 Trim\n### [ ] T1.2 Test\n### [ ] T2.1 Flush\n" };

  test("the Plan tab counts no commit of a part before its newest restart mark", () => {
    const steps = [commit(9, 7, "T1.2"), commit(8, 7, "restart"), commit(7, 8, "T2.1"), commit(6, 7, "T1.1"), commit(5, 7, "restart")];
    expect(plannedTasks({ docs, steps, subtasks: null }).map((x) => [x.id, x.done])).toEqual([
      ["T1.1", false],
      ["T1.2", true],
      ["T2.1", true],
    ]);
    expect(plannedTasks({ docs, steps: steps.filter((s) => s.item !== "restart"), subtasks: null }).every((x) => x.done)).toBe(true);
  });

  test("a restart mark is a row of its own in the Log tab, with no Show the diff", () => {
    const send = instruct({ id: 5 });
    const steps = [commit(7, 7, "restart"), step({ id: 6, kind: "commit", part: 7, item: send.item }), send];
    expect(logRows(steps).map((r) => ("send" in r ? `send ${r.steps.length}` : r.step.item))).toEqual(["restart", "send 1"]);
    const html = renderToStaticMarkup(createElement(LogTab, { t: building({ steps }), runner: R, onRunLog: () => {}, onDiff: () => {} }));
    expect(html.match(/Show the diff/g)?.length).toBe(1);
  });
});

// ---------- PS5-C2b: the rest of the Task view (ps5-plan.md sections 3 and 4) ----------

describe("ps5-plan.md section 3 and AC-B367: the primary of each REASON_EXITS key", () => {
  // The web action of each exit route. The reason update keeps "Try again" on the update route, which Continue also runs (part-session.md
  // section 9.4, "Continue does").
  const KINDS: Record<string, (ActionKind | null)[]> = {
    "POST /tasks/:id/resume": ["resume", "continue-part"],
    "POST /tasks/:id/answers": ["answer"],
    "PUT /repos/:project/:repo/task-settings": ["time-limit"],
    "POST /tasks/:id/spec-change/:step": ["review-change"],
    "POST /tasks/:id/allow": ["allow"],
    "POST /tasks/:id/parts/:part/wait-merge": ["wait-merge"],
    "POST /tasks/:id/stop": ["stop"],
  };
  const late = { name: "venv", argv: ["python"], exit: null, ms: 1, tail: "", timedOut: true, timeoutSec: 600 };
  const seeded = (key: string): TaskView => {
    const [kind, cause] = key.split("/") as [TaskBlocked["kind"], string | undefined];
    const s4 = step({ id: 4, kind: "implement", part: 7 });
    if (kind === "held") return view(building({ parts: [part({ blocked: HELD })] }));
    if (kind === "usage")
      return view(building({ blocked: { kind, step: 4, text: "x", resumeAt: NOW + MIN, armed: cause === "armed" }, steps: [s4] }));
    const b = { kind, ...(cause && { cause }), step: 4, text: `Needs you: ${key}.` } as TaskBlocked;
    if (key === "error/lower_repo") {
      const p = p13({ state: "planned", head: null });
      return subtaskView(subTask([p12(), p], { blocked: { ...b, step: null, part: 13 } }), p, SUB_OPTS);
    }
    const o: Partial<TaskDto> = { blocked: b, steps: [s4] };
    if (key === "question/claude") o.questions = [question({ source: "loop", step: 4 })];
    if (key === "red/setup_time")
      o.steps = [step({ id: 4, kind: "check", part: 7, item: "setup", state: "failed", detail: stepDetail.parse({ commands: [late] }) })];
    if (kind === "allow") o.allowAsk = { step: 4, requests: [{ pattern: "make", command: "make", reason: "It builds." }], warning: false };
    if (kind === "slot") o.steps = [{ ...s4, state: "waiting", endedAt: null }];
    return view(building(o));
  };

  test("each key gives a primary that maps to its exit route, or no primary for an app exit", () => {
    const got = Object.entries(REASON_EXITS).map(([key, e]) => {
      const want: (ActionKind | null)[] = "app" in e.primary ? [null] : key === "update" ? ["update"] : (KINDS[e.primary.route] ?? []);
      return [key, want.includes(seeded(key).primary?.kind ?? null)];
    });
    expect(got).toEqual(Object.keys(REASON_EXITS).map((key) => [key, true]));
  });

  test("AC-B366: each seeded row has at most one primary, no primary also in More, and Stop except for update", () => {
    for (const key of Object.keys(REASON_EXITS)) {
      const v = seeded(key);
      expect([key, v.more.some((a) => a.kind === v.primary?.kind)]).toEqual([key, false]);
      // ps5-plan.md D8: Stop stays for every reason but update.
      const stop = v.primary?.kind === "stop" || v.more.some((a) => a.kind === "stop");
      expect([key, stop]).toEqual([key, key !== "update"]);
    }
  });

  test("the Needs-you row: Continue, then Start this part again while unpushed, See why when the reason names a step, and Stop", () => {
    const at = (key: string) => seeded(key).more.map((a) => a.kind);
    expect(at("red/checks")).toEqual(["restart", "see-why", "stop"]);
    expect(at("stuck/stall")).toEqual(["restart", "see-why", "stop"]);
    expect(at("denied_path/path")).toEqual(["see-why", "stop"]);
    expect(at("blocker")).toEqual(["without", "see-why", "stop"]);
    expect(at("budget/time")).toEqual(["see-why", "stop"]);
    expect(seeded("unfinished").primary).toEqual({ kind: "resume", label: "Continue" });
  });
});

describe("ps5-plan.md section 4.2: the request of each action", () => {
  test("the actions that send at once map to their route and option; the confirms and forms send nothing", () => {
    expect(sendOf("resume", 7)).toEqual({ kind: "resume" });
    // AC-B375 and section 3: "Go on without these fixes" and "Leave it" are resume options.
    expect(sendOf("without", 7)).toEqual({ kind: "resume", option: "without" });
    expect(sendOf("leave", 7)).toEqual({ kind: "resume", option: "leave" });
    expect(sendOf("cancel-resume", 7)).toEqual({ kind: "resume", option: "disarm" });
    expect(sendOf("continue-part", 7)).toEqual({ kind: "resume", part: 7 });
    // AC-B376: "Run setup again" is the resume option setup with the part, not the old /parts/:part/setup route.
    expect(sendOf("setup", 7)).toEqual({ kind: "resume", option: "setup", part: 7 });
    expect(sendOf("hold", 7)).toEqual({ kind: "hold", part: 7 });
    expect(sendOf("push", 7)).toEqual({ kind: "push", part: 7 });
    expect(sendOf("stop", 7)).toEqual({ kind: "stop" });
    expect(sendOf("close", null)).toEqual({ kind: "close" });
    for (const k of ["skip", "restart", "open-pr", "change-limit", "see-why"] as const) expect([k, sendOf(k, 7)]).toEqual([k, null]);
    for (const k of ["setup", "hold", "push", "continue-part"] as const) expect([k, sendOf(k, null)]).toEqual([k, null]);
  });
});

describe("ps5-plan.md section 3 (AC-B368, AC-B380): ticks and tries", () => {
  const docs = { version: 1, plan: "### [ ] T1.1 Trim\n### [ ] T1.2 Test\n### [ ] T2.1 Flush\n" };
  const open = (kind: TaskStepDto["kind"], item: string, o: Partial<TaskStepDto> = {}) =>
    step({ id: 20, kind, part: 7, item, state: "running", endedAt: null, run: 5, ...o });
  const ticked = (id: number, p: number, kind: TaskStepDto["kind"], ids: string[], state: TaskStepDto["state"] = "ok") =>
    step({ id, kind, part: p, item: "build", state, detail: stepDetail.parse({ ticked: ids }) });

  test("the build row counts the done tasks of its part; no count when the plan lists no task", () => {
    const steps = [open("implement", "build"), ticked(8, 7, "commit", ["T1.1"]), ticked(7, 7, "implement", ["T1.2"], "cancelled")];
    expect(view(building({ docs, steps })).status).toBe("Claude builds your change: 1 of 3 tasks done.");
    expect(view(building({ steps })).status).toBe("Claude builds your change.");
    const two = building({ docs, parts: [part({ id: 6, state: "self_reviewed" }), part({ ord: 2 })], steps });
    expect(view(two).status).toBe("Claude builds part 2: 1 of 3 tasks done.");
  });

  test("fixing shows try n of N, and judging round n of N; no brackets without the stored count", () => {
    const tries = (n: number, of: number) => stepDetail.parse({ tries: { n, of } });
    expect(view(building({ steps: [open("fix", "checks", { detail: tries(1, 3) })] })).status).toBe(
      "Claude fixes the checks of your change (try 1 of 3).",
    );
    expect(view(building({ steps: [open("fix", "review", { detail: tries(2, 2) })] })).status).toBe(
      "Claude works on the review points of your change (round 2 of 2).",
    );
    expect(view(building({ steps: [open("fix", "checks")] })).status).toBe("Claude fixes the checks of your change.");
    expect(view(building({ steps: [open("fix", "critic", { detail: tries(1, 2) })] })).status).toBe(
      "Claude works on the review points of your change (round 1 of 2).",
    );
  });

  test("sub-tasks: the row text counts the tasks T<n>. of its plan part, and gives no try count", () => {
    const steps = [open("implement", "build", { part: 13 }), ticked(8, 13, "implement", ["T2.1"])];
    const t = subTask([p12(), p13({ state: "implementing" })], { docs, steps });
    expect(subtaskRows(t, SUB_OPTS).find((r) => r.part?.id === 13)?.text).toBe("Claude builds it: 1 of 1 tasks done.");
    expect(subtaskView(t, null, SUB_OPTS).status).toBe("Claude builds ABC-13 (2 of 2): 1 of 1 tasks done.");
    const fix = subTask([p12(), p13({ state: "implementing" })], {
      steps: [open("fix", "checks", { part: 13, detail: stepDetail.parse({ tries: { n: 1, of: 3 } }) })],
    });
    expect(subtaskRows(fix, SUB_OPTS).find((r) => r.part?.id === 13)?.text).toBe("Claude fixes the checks.");
    expect(subtaskView(fix, null, SUB_OPTS).status).toBe("Claude fixes the checks of ABC-13 (2 of 2) (try 1 of 3).");
  });

  test("plannedTasks: a tick of an ok commit row or run row of the part, the plan file tick, and the per-part filter", () => {
    const t = { docs: { ...docs, plan: `${docs.plan}### [x] T2.2 Done in the file\n` }, subtasks: null };
    const steps = [ticked(9, 7, "fix", ["T1.2"]), ticked(8, 7, "commit", ["T1.1"]), ticked(7, 8, "implement", ["T2.1"])];
    const done = (x: ReturnType<typeof plannedTasks>) => x.filter((k) => k.done).map((k) => k.id);
    expect(done(plannedTasks({ ...t, steps }))).toEqual(["T1.1", "T1.2", "T2.1", "T2.2"]);
    // One part: the rows of another part do not tick its tasks. A task without sub-tasks lists every task of the plan.
    expect(done(plannedTasks({ ...t, steps }, { id: 7, ord: 1 }))).toEqual(["T1.1", "T1.2", "T2.2"]);
    // With sub-tasks, task_part.ord is the plan part number (tasks.ts partDocsOf).
    const sub = plannedTasks({ ...t, steps, subtasks: [] }, { id: 8, ord: 2 });
    expect(sub.map((k) => [k.id, k.done])).toEqual([
      ["T2.1", true],
      ["T2.2", true],
    ]);
    // A failed row ticks nothing.
    expect(done(plannedTasks({ ...t, steps: [ticked(9, 7, "fix", ["T1.2"], "failed")] }))).toEqual(["T2.2"]);
  });
});

describe("part-session.md section 2.17: the ready row", () => {
  const docs = { version: 1, plan: "### [ ] T1.1 Trim\n### [ ] T1.2 Test\n" };
  const check = (state: TaskStepDto["state"]) => step({ id: 9, kind: "check", part: 7, item: "checks", state });
  const ready = (o: Partial<TaskPartDto> = {}, t: Partial<TaskDto> = {}) =>
    view(building({ docs, parts: [part({ state: "self_reviewed", lines: 340, ...o })], steps: [check("ok")], ...t }));

  test("the facts of the part: its tasks, its lines, and green checks; a fact that is not known stays out", () => {
    expect(ready().status).toBe("Your change is ready: 2 tasks, 340 lines, checks green.");
    expect(ready({ lines: null }, { docs: null, steps: [] }).status).toBe("Your change is ready.");
    expect(ready({}, { steps: [check("failed")] }).status).toBe("Your change is ready: 2 tasks, 340 lines.");
    // The checks on the part base are no checks of the change.
    expect(ready({}, { steps: [step({ id: 9, kind: "check", part: 7, item: "base", state: "ok" })] }).status).toBe(
      "Your change is ready: 2 tasks, 340 lines.",
    );
    const two = building({ docs, parts: [part({ id: 6, state: "merged" }), part({ ord: 2, state: "self_reviewed" })] });
    expect(view(two).status).toBe("Part 2 is ready: 2 tasks, 80 lines.");
    expect(view(two).primary?.label).toBe("Open PR for part 2 of 2");
  });

  test("More: Show the diff, Fix these too with points, and Start this part again before the first push", () => {
    const points = [{ id: 3, severity: "minor" as const, path: "src/a.ts", line: 2, text: "Name the lock." }];
    expect(ready({}, { points }).more.map((a) => [a.kind, a.label])).toEqual([
      ["show-diff", "Show the diff"],
      ["fix-points", "Fix these too"],
      ["restart", "Start this part again"],
    ]);
    expect(ready({ pushed: "b".repeat(40) }).more.map((a) => a.kind)).toEqual(["show-diff"]);
  });
});

describe("ps5-plan.md section 3: the stopped row of a build", () => {
  const stopped = (o: Partial<TaskDto>) => view(building({ state: "stopped", stoppedFrom: "implementing", ...o }));

  test("several parts: Stopped at part k with the part of the newest row; sub-tasks: the part label", () => {
    const parts = [part({ id: 6, state: "self_reviewed" }), part({ ord: 2 })];
    const v = stopped({ parts, steps: [step({ id: 9, kind: "fix", part: 7, state: "cancelled" }), step({ id: 8, kind: "push" })] });
    expect(shape(v)).toEqual({
      status: "Stopped at part 2. The work is kept.",
      primary: "Continue",
      more: ["Start this part again", "Close the task"],
      screen: "build",
    });
    const t = subTask([p12(), p13({ state: "implementing" })], {
      state: "stopped",
      stoppedFrom: "implementing",
      steps: [step({ id: 9, kind: "implement", part: 13, state: "cancelled" })],
    });
    expect(shape(subtaskView(t, null, SUB_OPTS))).toMatchObject({
      status: "Stopped at ABC-13 (2 of 2). The work is kept.",
      primary: "Continue",
    });
  });

  test("a pushed part has no Start again; a stop before the build keeps its text with Continue", () => {
    expect(stopped({ parts: [part({ pushed: "a".repeat(40) })] }).more.map((a) => a.kind)).toEqual(["close"]);
    const v = view(task({ state: "stopped", stoppedFrom: "interview", steps: [step({ id: 1, kind: "interview", state: "cancelled" })] }));
    expect(shape(v)).toEqual({ status: "Stopped at: reading the task.", primary: "Continue", more: ["Close the task"], screen: "build" });
  });
});

describe("ps5-plan.md section 3: push-back questions in the status row", () => {
  const card = { id: 31, check: null, reason: "The guard stops it.", cite: "src/a.ts:4", citeFound: true };
  const asked = (questions: TaskQuestionDto[]) =>
    view(building({ blocked: { kind: "question", cause: "claude", step: 4, text: "Needs you: x." }, questions }));

  test("Judge the push-back, Judge N push-backs, or Answer the question when one question has no point", () => {
    const pb = (id: number) => question({ id, source: "loop", step: 4, point: { ...card, id }, recommended: null });
    expect(asked([pb(1)]).primary).toEqual({ kind: "answer", label: "Judge the push-back" });
    expect(asked([pb(1), pb(2)]).primary?.label).toBe("Judge 2 push-backs");
    expect(asked([pb(1), question({ id: 2, source: "loop", step: 4 })]).primary?.label).toBe("Answer the question");
  });
});

describe("ps5-plan.md section 4.6 (AC-B377): the size note", () => {
  const commit = (id: number, p: number, notes: string[], o: Partial<TaskStepDto> = {}) =>
    step({ id, kind: "commit", part: p, item: "build", detail: stepDetail.parse({ notes }), ...o });
  const NOTE = "This PR has 520 changed lines, over your 400 limit.";

  test("the Build box shows the notes of the newest ok commit of the part; a restart mark and another part do not count", () => {
    const steps = [
      commit(12, 8, ["Other part."]),
      commit(11, 7, ["Started again."], { item: "restart" }),
      commit(10, 7, ["Failed."], { state: "failed" }),
      commit(9, 7, [NOTE, "The commit added or changed no test file."]),
      commit(8, 7, ["Old."]),
    ];
    expect(readyNotes({ steps }, { id: 7 })).toEqual([NOTE, "The commit added or changed no test file."]);
    expect(readyNotes({ steps }, null)).toEqual([]);
  });

  test("Change the limit shows only over the limit, and not after Keep one PR", () => {
    const t = building({ plan: { ...PLAN, budget: 400 } });
    expect(overLimit(t, { lines: 520 })).toBe(true);
    expect(overLimit(t, { lines: 400 })).toBe(false);
    expect(overLimit(t, { lines: null })).toBe(false);
    expect(overLimit({ ...t, settings: { lineBudget: 600 } }, { lines: 520 })).toBe(false);
    expect(overLimit({ ...t, settings: { keepOnePr: true } }, { lines: 520 })).toBe(false);
    expect(overLimit({ ...t, plan: null }, { lines: 520 })).toBe(false);
  });
});

describe("ps5-plan.md section 4.7 (AC-B378): a patch that the app could not save", () => {
  const log = (patch: string) =>
    renderToStaticMarkup(
      createElement(LogTab, {
        t: building({ steps: [step({ id: 4, kind: "implement", part: 7, detail: stepDetail.parse({ patch }) })] }),
        runner: R,
        onRunLog: () => {},
      }),
    );

  test("the Log and the denied path row say that no patch was saved, and never 'saved in no file'", () => {
    expect(patchText(PATCH_LOST, false)).toEqual({
      lead: "The app could not save the changes of this step as a patch.",
      file: null,
      tail: "",
    });
    expect(patchText(PATCH_LOST, true)).toEqual({
      lead: "The worktree went back to the last commit. The app could not save the changes as a patch. Continue starts a new run.",
      file: null,
      tail: "",
    });
    expect(patchText("p/4.patch", true)).toEqual({
      lead: "The worktree went back to the last commit. The changes are saved in ",
      file: "p/4.patch",
      tail: ". Continue starts a new run.",
    });
    expect(log(PATCH_LOST)).toContain("The app could not save the changes of this step as a patch.");
    expect(log(PATCH_LOST)).not.toContain("saved in");
    expect(log("p/4.patch")).toMatch(/The changes of this step are saved in <code translate="no"[^>]*>p\/4\.patch<\/code>\./);
  });
});

describe("ps4-plan.md WP-7: a message that waits for the next run of its part", () => {
  const queued = (o: Parameters<typeof instruct>[0] = {}) => instruct({ id: 10, state: "waiting", run: null, endedAt: null, ...o });
  const review = step({ id: 11, kind: "review", part: 7, item: "review", state: "running", run: 6, endedAt: null });
  const build = step({ id: 9, kind: "implement", part: 7, item: "build", run: 5 });

  test("the Log shows it as a waiting send that owns no row of the run beside it", () => {
    const rows = logRows([review, queued(), build]);
    expect(rows.map((r) => ("send" in r ? `send ${r.send.id}: ${r.steps.length}` : `${r.step.id}`))).toEqual(["11", "send 10: 0", "9"]);
    expect(sendResult(rows[1] as SendGroup, R)).toBe("Waiting");
    const t = building({ steps: [review, queued(), build] });
    const html = renderToStaticMarkup(createElement(LogTab, { t, runner: R, onRunLog: () => {} }));
    expect(html).toMatch(/data-send="10"[\s\S]*?Waiting/);
    // A message that a Stop ended before its run owns no later row either.
    const stopped = queued({ state: "cancelled", result: "stopped" });
    expect(logRows([review, stopped, build]).map((r) => ("send" in r ? r.steps.length : -1))).toEqual([-1, 0, -1]);
  });

  test("the status keeps the run beside it, and the box text comes back for each part on its own", () => {
    expect(view(building({ steps: [review, queued(), build] })).status).toBe("A second Claude run reviews your change.");
    const a = instruct({ id: 21, part: 6, state: "cancelled", run: null, result: "stopped" });
    const b = instruct({ id: 22, part: 7, state: "cancelled", run: null, result: "stopped" });
    const second = {
      ...b,
      detail: { ...b.detail, instruct: { ...(b.detail.instruct as NonNullable<StepDetail["instruct"]>), text: "Part 2." } },
    };
    const t = { steps: [second, a] };
    expect([stoppedSend(t, 6)?.text, stoppedSend(t, 7)?.text, stoppedSend(t)?.text]).toEqual([
      "Rename the flag to useNewParser.",
      "Part 2.",
      "Part 2.",
    ]);
    expect(stoppedSend(t, 8)).toBeNull();
  });
});

describe("ps5-plan.md section 4.4 (AC-B379): the quick review row of the Log", () => {
  test("a review row with item critic says Quick review", () => {
    const steps = [step({ id: 5, kind: "review", part: 7, item: "critic" }), step({ id: 4, kind: "review", part: 7, item: "review" })];
    const html = renderToStaticMarkup(createElement(LogTab, { t: building({ steps }), runner: R, onRunLog: () => {} }));
    expect(html.match(/Quick review/g)?.length).toBe(1);
    expect(html.match(/Own review/g)?.length).toBe(1);
  });
});
