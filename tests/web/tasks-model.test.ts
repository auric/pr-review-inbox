// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.12 and 7.1 (WP-B5, AC-UX1, AC-UX3, AC-UX9): one test per state row of the Task view table for
// small tasks, the status line of a Tasks row, and the plain-word helpers.
import { describe, expect, test } from "bun:test";
import type {
  AttachmentDto,
  AttachmentMeta,
  BranchCheckDto,
  TaskDto,
  TaskPartDto,
  TaskQuestionDto,
  TaskRowDto,
  TaskStepDto,
} from "../../src/shared/dto";
import { stepDetail } from "../../src/shared/task";
import {
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
  pickedPrefix,
  plannedBranch,
  planSentence,
  prefixProblem,
  rowStatus,
  STEP_TEXT,
  stepLook,
  stoppedAt,
  type TaskView,
  taskView,
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

const view = (t: TaskDto) => taskView(t, { runner: R, now: NOW });
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
