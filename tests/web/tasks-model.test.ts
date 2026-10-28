// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.12 and 7.1 (WP-B5, AC-UX1, AC-UX3, AC-UX9): one test per state row of the Task view table for
// small tasks, the status line of a Tasks row, and the plain-word helpers. WP-MR3 adds the rows of several repositories (section 6.16).
import { describe, expect, test } from "bun:test";
import { noMergeText } from "../../src/server/tasks/pointer";
import type {
  AttachmentDto,
  AttachmentMeta,
  BranchCheckDto,
  TaskDto,
  TaskPartDto,
  TaskPrDto,
  TaskQuestionDto,
  TaskRepoDto,
  TaskRowDto,
  TaskStepDto,
} from "../../src/shared/dto";
import { stepDetail, taskProfileId } from "../../src/shared/task";
import {
  ACCESS_TEXT,
  basePicks,
  branchApproval,
  branchesError,
  branchNote,
  elapsed,
  type FileChoice,
  fileChoiceState,
  fileChoices,
  fileMeta,
  firstPick,
  firstPicks,
  goneBase,
  inTask,
  listText,
  logRows,
  NO_MERGE,
  partRows,
  pickedPrefix,
  plannedBranch,
  planSentence,
  pointerRow,
  prefixProblem,
  proposals,
  prRowLook,
  REPOS_SHOWN,
  repoChoices,
  repoMatches,
  repoName,
  roleText,
  rowSize,
  rowStatus,
  type SendGroup,
  STEP_TEXT,
  sendResult,
  showRepos,
  stepLook,
  stoppedAt,
  stoppedSend,
  type TaskView,
  taskView,
  tellBox,
} from "../../src/web/tasks/model";

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
    version: 3,
    updatedAt: NOW,
    closedAt: null,
    progress: { planReady: false, part: 0, parts: 0, ready: false, merged: false },
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
};
const ESTIMATE: NonNullable<TaskDto["estimate"]> = { parts: 1, lines: 80, files: 1, modules: [], db: false, api: false, unknowns: [] };

const view = (t: TaskDto) => taskView(t, { runner: R, forge: "Bitbucket", now: NOW });
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

  test("implementing, running: the step sentence names Claude and the step, with Pause after this step", () => {
    const v = view(building({ steps: [step({ id: 9, kind: "tests", part: 7, item: "P1", state: "running", endedAt: null })] }));
    expect(shape(v)).toEqual({
      status: "Claude is writing the tests.",
      primary: null,
      more: ["Pause after this step", "Stop"],
      screen: "build",
    });
  });

  test("implementing, checks: Running the tests, Stop only", () => {
    const v = view(building({ steps: [step({ id: 9, kind: "check", part: 7, item: "T1.1", state: "running", endedAt: null })] }));
    expect(shape(v)).toEqual({ status: "Running the tests.", primary: null, more: ["Stop"], screen: "build" });
  });

  test("implementing, own review: Claude checks its own change", () => {
    const v = view(building({ steps: [step({ id: 9, kind: "review", part: 7, state: "running", endedAt: null })] }));
    expect(v.status).toBe("Claude checks its own change.");
  });

  test("implementing, ready: Your change is ready, Open the PR, and the small points in More", () => {
    const v = view(
      building({
        parts: [part({ state: "self_reviewed" })],
        points: [{ id: 3, severity: "minor", path: "src/a.ts", line: 2, text: "Name the lock." }],
      }),
    );
    expect(shape(v)).toEqual({
      status: "Your change is ready and checked by Claude.",
      primary: "Open the PR",
      more: ["Show the diff", "Fix the small points too"],
      screen: "ready",
    });
  });

  test("implementing, ready while the loop works between steps: no Open the PR", () => {
    const v = view(building({ parts: [part({ state: "self_reviewed" })], working: true }));
    expect(v.primary).toBeNull();
    expect(v.status).toBe("The app prepares the next step.");
  });

  test("blocked red: the server sentence, See why, Resume and Stop", () => {
    const text = "Needs you: the tests of part 1 stay red after 3 tries.";
    const v = view(building({ blocked: { kind: "red", step: 4, text } }));
    expect(shape(v)).toEqual({ status: text, primary: "See why", more: ["Resume", "Stop"], screen: "build" });
  });

  test("blocked blocker: See why", () => {
    const v = view(building({ blocked: { kind: "blocker", step: 4, text: "Needs you: Claude's review of part 1 still finds 1 point." } }));
    expect(v.primary?.label).toBe("See why");
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

  test("blocked size: Keep one PR, then Change the limit in More", () => {
    const text = "Needs you: this PR would have 520 changed lines, over your 400 limit.";
    const v = view(building({ blocked: { kind: "size", step: 6, text } }));
    expect(shape(v)).toEqual({ status: text, primary: "Keep one PR", more: ["Change the limit", "Stop"], screen: "build" });
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

  test("blocked budget: Continue with 60 more minutes", () => {
    const v = view(
      building({ blocked: { kind: "budget", step: null, text: "Needs you: part 1 used its 120 min. Continue with 60 more min?" } }),
    );
    expect(v.primary?.label).toBe("Continue with 60 more minutes");
  });

  test("blocked denied_path: the sentence with the paths, Resume", () => {
    const text = "Needs you: the step changed .claude/settings.json, which the app does not commit.";
    const v = view(building({ blocked: { kind: "denied_path", step: 6, text } }));
    expect(shape(v)).toEqual({ status: text, primary: "Resume", more: ["Stop"], screen: "build" });
  });

  test("blocked error: one sentence with the cause, Resume", () => {
    const v = view(
      building({ blocked: { kind: "error", step: null, text: "Needs you: set user.name and user.email in your git config." } }),
    );
    expect(v.primary?.label).toBe("Resume");
  });

  test("blocked slot: the wait, no primary, Stop", () => {
    const text = "Waiting for your review of PR 12 to finish.";
    const v = view(
      building({ blocked: { kind: "slot", step: 6, text }, steps: [step({ id: 6, kind: "tests", state: "waiting", endedAt: null })] }),
    );
    expect(shape(v)).toEqual({ status: text, primary: null, more: ["Stop"], screen: "build" });
    expect(v.needsYou).toBe(false);
  });

  test("stopped: Stopped at with the part step, Resume, Close the task", () => {
    const v = view(
      building({
        state: "stopped",
        stoppedFrom: "implementing",
        blocked: { kind: "error", step: null, text: "The run was cancelled." },
        steps: [step({ id: 9, kind: "check", part: 7, item: "T1.1", state: "failed" })],
      }),
    );
    expect(shape(v)).toEqual({
      status: "Stopped at: task T1.1, running the tests.",
      primary: "Resume",
      more: ["Close the task"],
      screen: "build",
    });
    expect(v.detail).toBe("The run was cancelled.");
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
      more: ["Open the PR as is", "Show the diff"],
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
      more: ["Open the PR as is", "Show the diff"],
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

  test("update red: See why, then Undo the update and Stop", () => {
    expect(shape(view(rows.updateRed))).toEqual({
      status: "Needs you: the tests fail after the update from release/2.1.",
      primary: "See why",
      more: ["Undo the update", "Stop"],
      screen: "build",
    });
  });

  test("update stopped: the reason with 'The branch is as it was.', Try again, Go to the PR in More", () => {
    expect(shape(view(rows.updateStopped))).toEqual({
      status: "The update from release/2.1 stopped: conflict markers remain in src/a.ts. The branch is as it was.",
      primary: "Try again",
      more: ["Go to the PR"],
      screen: "pr",
    });
  });

  test("instruct running: Claude works on your instructions, with the part when the task has more; Stop only", () => {
    expect(shape(view(rows.instructRunning))).toEqual({
      status: "Claude works on your instructions.",
      primary: null,
      more: ["Stop"],
      screen: "build",
    });
    const two = { ...rows.instructRunning, parts: [part({ ...PR_PART, id: 6 }), part({ ...PR_PART, id: 7, ord: 2 })] };
    expect(view(two).status).toBe("Claude works on your instructions for part 2.");
    // The checks of a send also end by themselves: no Pause.
    const checks = step({ id: 31, kind: "check", part: 7, item: "I1", state: "running", endedAt: null });
    expect(view({ ...rows.ready, canInstruct: false, steps: [checks, instruct({})] }).more.map((a) => a.label)).toEqual(["Stop"]);
  });

  test("implementing, not pushed: the sentence only, because 'Push to <branch>' has no route yet", () => {
    expect(shape(view(rows.notPushed))).toEqual({
      status: "Your change has new commits that are not on the server yet.",
      primary: null,
      more: ["Show the diff", "Go to the PR", "Close the task"],
      screen: "pr",
    });
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

  test("a reason after the PR opened: no Resume, Continue, or line limit, because the server takes them while building only", () => {
    const red = view({ ...rows.open, blocked: { kind: "red", step: 4, text: "Needs you: the tests of part 1 stay red after 3 tries." } });
    expect(shape(red)).toMatchObject({ primary: "See why", more: ["Stop"] });
    const denied = view({ ...rows.open, blocked: { kind: "denied_path", step: 4, text: "Needs you: the step changed .env." } });
    expect(shape(denied)).toMatchObject({ primary: null, more: ["Stop"] });
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
      "implementing, running (the first build)": building({
        steps: [step({ id: 9, kind: "tests", part: 7, item: "P1", state: "running", endedAt: null })],
      }),
      "implementing, checks (the first build)": building({
        steps: [step({ id: 9, kind: "check", part: 7, item: "T1.1", state: "running", endedAt: null })],
      }),
      "implementing, no part yet": building({ parts: [] }),
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
  const progress = (o: Partial<TaskRowDto["progress"]>) => ({ planReady: false, part: 0, parts: 0, ready: false, merged: false, ...o });

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
    expect(rowStatus(row({ state: "implementing", progress: progress({ part: 1, parts: 1, ready: true }) })).text).toBe(
      "Needs you: open the PR",
    );
    expect(rowStatus(row({ state: "implementing", blocked: { kind: "red", step: 1, text: "x" } })).text).toBe("Needs you: tests stay red");
    expect(rowStatus(row({ state: "implementing", blocked: { kind: "slot", step: 1, text: "x" } }))).toEqual({
      text: "Waiting for the run slot",
      needsYou: false,
    });
    expect(rowStatus(row({ state: "ready" })).text).toBe("Waiting for review");
    expect(rowStatus(row({ state: "stopped" })).text).toBe("Stopped");
    expect(rowStatus(row({ state: "done", closedAt: NOW })).text).toBe("Closed");
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
      status: "Your change in 2 repositories is ready and checked by Claude.",
      primary: "Open 2 PRs",
      more: ["Show the diff"],
      screen: "ready",
    });
    const moved2 = view(
      multi([LIB, MAIN], { bases: [{ taskRepo: 2, branch: "develop", newCommits: 3, conflicted: false, changed: false }] }),
    );
    expect(shape(moved2)).toMatchObject({
      status: "develop has 3 new commits since the branch point.",
      primary: "Update from develop",
      more: ["Open the PR as is", "Show the diff"],
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
