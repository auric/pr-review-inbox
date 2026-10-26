// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Task view model (docs/plans/review-v2/spec.md sections 6.12 and 7): one status sentence that names who acts or what the app
// waits for, at most one primary action, and the More actions, per state. Pure: tests/web/tasks-model.test.ts has one test per row.
// runner: the short name of the CLI from meta, because UI code names no product (tests/ui/names.test.ts).
import {
  type BranchCheckDto,
  type BranchSearchDto,
  branchPrefix,
  type TaskDto,
  type TaskPartDto,
  type TaskQuestionDto,
  type TaskRowDto,
  type TaskStepDto,
} from "../../shared/dto";
import { branchName, type TaskSize } from "../../shared/task";

export type ActionKind =
  | "answer"
  | "recommended"
  | "approve"
  | "edit-plan"
  | "change-size"
  | "stop"
  | "pause"
  | "resume"
  | "continue"
  | "see-why"
  | "keep-size"
  | "change-limit"
  | "review-change"
  | "reject-change"
  | "open-pr"
  | "show-diff"
  | "fix-points"
  | "go-pr"
  | "close";
export type Action = { kind: ActionKind; label: string };

// screen: the content under the header. questions: the Questions form. plan: the plan approval. change: the spec change review.
// build: the progress of the build. ready: the part that waits for its PR. pr: the open PR. end: done, failed, or closed.
export type Screen = "questions" | "plan" | "change" | "build" | "ready" | "pr" | "end";

export type TaskView = {
  status: string;
  // A second line: the elapsed time of a running step, or the reason of a stop.
  detail: string | null;
  primary: Action | null;
  more: Action[];
  screen: Screen;
  // The user must act. The Tasks row and the page title say so.
  needsYou: boolean;
  // A step runs now.
  running: boolean;
};

// spec.md section 6.1: the one-line meaning of each size.
export const SIZE_LINE: Record<TaskSize, string> = {
  small: "Small: one PR with a short plan and the code.",
  medium: "Medium: colleagues review the plan first, then one PR with the code.",
  large: "Large: colleagues review the plan first, then the code comes in small PRs, one after another.",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STOP: Action = { kind: "stop", label: "Stop" };
const CLOSE: Action = { kind: "close", label: "Close the task" };

// The elapsed time of a step in plain words. The app has no estimate of the time left, so it says the time so far.
export function elapsed(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "Started less than a minute ago.";
  return `Running for ${plural(min, "minute")}.`;
}

export const codeParts = (t: Pick<TaskDto, "parts">) => t.parts.filter((p) => p.kind !== "spec");
export const openQuestions = (t: Pick<TaskDto, "questions">, source: TaskQuestionDto["source"]): TaskQuestionDto[] => {
  const open = t.questions.filter((q) => q.source === source && q.answer === null);
  const round = Math.max(0, ...open.map((q) => q.round));
  return open.filter((q) => q.round === round);
};
// The step that runs or waits for the run slot. The steps come newest first.
export const runningStep = (t: Pick<TaskDto, "steps">): TaskStepDto | null =>
  t.steps.find((s) => s.state === "running" || s.state === "waiting") ?? null;

// The part that the build works on or that waits for its PR: the first code part that did not merge or drop out.
export function currentPart(t: Pick<TaskDto, "parts">): TaskPartDto | null {
  return codeParts(t).find((p) => p.state !== "merged" && p.state !== "abandoned" && p.state !== "declined") ?? null;
}

// " for part 2" when the task has more than one code part. A small task speaks of "your change".
function partWords(t: TaskDto, part: number | null) {
  return part !== null && codeParts(t).length > 1 ? ` for part ${part}` : "";
}

// One sentence for a running step: who works, and on what.
export function stepSentence(t: TaskDto, s: TaskStepDto, runner: string): string {
  const ord = t.parts.find((p) => p.id === s.part)?.ord ?? null;
  const of = partWords(t, ord);
  switch (s.kind) {
    case "interview":
      return `${runner} is reading the task and the code.`;
    case "spec":
    case "replan":
      return `${runner} is writing the plan.`;
    case "tests":
      return `${runner} is writing the tests${of}.`;
    case "implement":
      return s.item ? `${runner} is writing the code of task ${s.item}${of}.` : `${runner} is writing the code${of}.`;
    case "fix":
      if (s.item === "review") return `${runner} is fixing the points of its own review${of}.`;
      if (s.item === "points") return `${runner} is fixing the small points${of}.`;
      return `${runner} is fixing the failing checks${of}.`;
    case "check":
      return s.item === "setup" ? `Running the setup commands${of}.` : `Running the tests${of}.`;
    case "review":
      return `${runner} checks its own change${of}.`;
    case "commit":
      return `Saving the change as a commit${of}.`;
    case "push":
      return "Pushing the branch.";
    case "pr":
      return "Opening the PR.";
    default:
      return `The app works on the task${of}.`;
  }
}

// spec.md section 6.12, stopped: "Stopped at: part 2, task T2.3, running the tests."
const DOING: Partial<Record<TaskStepDto["kind"], string>> = {
  interview: "reading the task",
  spec: "writing the plan",
  replan: "writing the plan",
  tests: "writing the tests",
  implement: "writing the code",
  fix: "fixing the checks",
  check: "running the tests",
  review: "checking its own change",
  commit: "saving a commit",
  push: "pushing the branch",
  pr: "opening the PR",
  size: "the line limit",
  spec_change: "a change to the plan",
  question: "a question",
};
export function stoppedAt(t: TaskDto): string {
  const s = t.steps[0];
  if (!s) return "Stopped.";
  const ord = t.parts.find((p) => p.id === s.part)?.ord ?? null;
  const where = [
    ...(ord !== null && codeParts(t).length > 1 ? [`part ${ord}`] : []),
    ...(s.item && /^T\d/.test(s.item) ? [`task ${s.item}`] : []),
    ...(DOING[s.kind] ? [DOING[s.kind] as string] : []),
  ];
  return where.length ? `Stopped at: ${where.join(", ")}.` : "Stopped.";
}

// spec.md section 6.12, spec_draft ready: "The plan is ready: medium, 1 code PR, about 300 changed lines."
export function planSentence(t: TaskDto): string {
  const size = t.size ?? t.plan?.proposed ?? "small";
  const prs = size === "small" ? "1 PR" : size === "medium" ? "1 code PR" : plural(t.estimate?.parts ?? 2, "part");
  const lines = t.estimate ? `, about ${t.estimate.lines.toLocaleString("en-US")} changed lines` : "";
  return `The plan is ready: ${size}, ${prs}${lines}.`;
}

// "Anna Lee's review" or "the reviews of Anna Lee and Bo Chen".
function waitingFor(names: string[]): string {
  if (!names.length) return "the review of your PR";
  if (names.length === 1) return `${names[0]}'s review`;
  return `the reviews of ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const stepFor = (t: TaskDto, id: number | null) => (id === null ? null : (t.steps.find((s) => s.id === id) ?? null));

export function taskView(t: TaskDto, o: { runner: string; now: number }): TaskView {
  const R = o.runner;
  const run = runningStep(t);
  const base = { detail: null, more: [], needsYou: false, running: false } satisfies Partial<TaskView>;
  const working = (status: string, more: Action[], screen: Screen = "build"): TaskView => ({
    ...base,
    status,
    detail: run ? elapsed(o.now - run.startedAt) : null,
    primary: null,
    more,
    screen,
    running: true,
  });
  const b = t.blocked;

  if (t.state === "failed") return { ...base, status: b ? `The task failed: ${b.text}` : "The task failed.", primary: null, screen: "end" };
  if (t.state === "done") {
    if (t.closedAt !== null) return { ...base, status: "Closed. The branches and PRs stay as they are.", primary: null, screen: "end" };
    const n = codeParts(t).length;
    return {
      ...base,
      status: n > 1 ? `Done. All ${n} PRs merged.` : "Done. The PR merged.",
      primary: CLOSE,
      screen: "end",
    };
  }
  if (t.state === "stopped")
    return {
      ...base,
      status: stoppedAt(t),
      detail: b?.text ?? null,
      primary: { kind: "resume", label: "Resume" },
      more: [CLOSE],
      screen: "build",
      needsYou: true,
    };

  if (t.state === "interview") {
    const open = openQuestions(t, "interview");
    if (open.length && !run)
      return {
        ...base,
        status: `${R} has ${plural(open.length, "question")} before it writes the plan.`,
        primary: { kind: "answer", label: `Answer ${plural(open.length, "question")}` },
        more: [{ kind: "recommended", label: "Use the recommended answers" }, STOP],
        screen: "questions",
        needsYou: true,
      };
    return working(`${R} is reading the task and the code.`, [STOP], "questions");
  }

  if (t.state === "spec_draft") {
    if (run || !t.plan) return working(`${R} is writing the plan.`, [STOP], "plan");
    if (t.plan.approved)
      return {
        ...base,
        status: "The plan is approved. Colleagues review a medium or large plan as a PR. This version cannot open that PR yet.",
        primary: null,
        more: [STOP],
        screen: "plan",
      };
    return {
      ...base,
      status: planSentence(t),
      primary: { kind: "approve", label: "Approve the plan" },
      more: [{ kind: "edit-plan", label: "Edit" }, { kind: "change-size", label: "Change size" }, STOP],
      screen: "plan",
      needsYou: true,
    };
  }

  if (t.state === "spec_pr_open" || t.state === "spec_approved")
    return {
      ...base,
      status: "Colleagues review the plan as a PR. This version cannot follow that PR yet.",
      primary: null,
      more: [STOP],
      screen: "plan",
    };

  const part = currentPart(t);
  if (t.state === "ready") {
    const prs = codeParts(t);
    if (prs.length && prs.every((p) => p.prState === "MERGED" || p.state === "merged" || p.state === "abandoned"))
      return {
        ...base,
        status: prs.length > 1 ? `Done. All ${prs.length} PRs merged.` : "Done. The PR merged.",
        primary: CLOSE,
        screen: "end",
      };
    const last = prs.at(-1);
    if (last?.prState === "DECLINED")
      return { ...base, status: "The PR was declined on the server.", primary: CLOSE, screen: "pr", needsYou: true };
    const of = prs.length > 1 && last ? ` of part ${last.ord}` : "";
    return {
      ...base,
      status: `Waiting for ${waitingFor(last?.waiting ?? [])}${of}. Nothing to do.`,
      primary: { kind: "go-pr", label: "Go to the PR" },
      more: [CLOSE],
      screen: "pr",
    };
  }

  // implementing
  if (b) {
    const step = stepFor(t, b.step);
    const blocked = (primary: Action | null, more: Action[], screen: Screen = "build"): TaskView => ({
      ...base,
      status: b.text,
      primary,
      more,
      screen,
      needsYou: primary !== null,
    });
    switch (b.kind) {
      case "red":
      case "blocker":
        return blocked({ kind: "see-why", label: "See why" }, [{ kind: "resume", label: "Resume" }, STOP]);
      case "question":
        return openQuestions(t, "loop").length
          ? blocked({ kind: "answer", label: "Answer the question" }, [STOP], "questions")
          : blocked({ kind: "continue", label: "Continue" }, [STOP]);
      case "size":
        // "Split into parts" needs the large flow (WP-B8), so "Keep one PR" leads here.
        return blocked({ kind: "keep-size", label: "Keep one PR" }, [{ kind: "change-limit", label: "Change the limit" }, STOP]);
      case "spec_change":
        return blocked({ kind: "review-change", label: "Review the change" }, [{ kind: "reject-change", label: "Reject" }, STOP], "change");
      case "budget":
        return blocked({ kind: "continue", label: "Continue with 60 more minutes" }, [STOP]);
      case "slot":
        return { ...working(b.text, [STOP]), detail: step ? elapsed(o.now - step.startedAt) : null };
      default:
        // denied_path, push, and error: one sentence with the cause, and Resume starts the step again from the last commit.
        return blocked({ kind: "resume", label: "Resume" }, [STOP]);
    }
  }
  if (run) {
    const checks = run.kind === "check";
    return working(stepSentence(t, run, R), checks ? [STOP] : [{ kind: "pause", label: "Pause after this step" }, STOP]);
  }
  if (part?.state === "self_reviewed" && !t.working) {
    const n = codeParts(t).length;
    const label = n > 1 ? `Open PR for part ${part.ord} of ${n}` : "Open the PR";
    const status = n > 1 ? `Part ${part.ord} of ${n} is ready and checked by ${R}.` : `Your change is ready and checked by ${R}.`;
    return {
      ...base,
      status,
      primary: { kind: "open-pr", label },
      more: [
        { kind: "show-diff", label: "Show the diff" },
        ...(t.points.length ? [{ kind: "fix-points" as const, label: "Fix the small points too" }] : []),
      ],
      screen: "ready",
      needsYou: true,
    };
  }
  return working(t.working ? "The app prepares the next step." : `${R} is building your change.`, [
    { kind: "pause", label: "Pause after this step" },
    STOP,
  ]);
}

// spec.md section 6.12, Inbox: the status in the meta line of a Tasks row.
const NEEDS: Record<NonNullable<TaskRowDto["blocked"]>["kind"], string> = {
  question: "Needs you: a question",
  red: "Needs you: tests stay red",
  blocker: "Needs you: review points left",
  budget: "Needs you: the time limit",
  size: "Needs you: over the line limit",
  spec_change: "Needs you: a change to the plan",
  denied_path: "Needs you: a file the app does not commit",
  push: "Needs you: the push",
  slot: "Waiting for the run slot",
  preflight: "Needs you: a check before the build",
  error: "Needs you: an error",
};
export function rowStatus(r: TaskRowDto): { text: string; needsYou: boolean } {
  const p = r.progress;
  if (r.state === "done") return { text: r.closedAt === null ? "Done" : "Closed", needsYou: false };
  if (r.state === "failed") return { text: "Failed", needsYou: false };
  if (r.state === "stopped") return { text: "Stopped", needsYou: true };
  if (r.blocked) {
    if (r.state === "interview") return { text: "Needs you: answer the questions", needsYou: true };
    return { text: NEEDS[r.blocked.kind], needsYou: r.blocked.kind !== "slot" };
  }
  if (r.state === "interview") return { text: "Reading the task", needsYou: false };
  if (r.state === "spec_draft")
    return p.planReady ? { text: "Needs you: approve the plan", needsYou: true } : { text: "Writing the plan", needsYou: false };
  if (r.state === "implementing") {
    if (p.ready) return { text: "Needs you: open the PR", needsYou: true };
    return { text: p.part ? `Building part ${p.part} of ${p.parts}` : "Building", needsYou: false };
  }
  if (r.state === "ready") return { text: p.merged ? "Merged" : "Waiting for review", needsYou: false };
  return { text: "Waiting for colleagues", needsYou: false };
}

// The state of a step in the Log tab. The checks of the tests step must fail (StepDetail.expectRed), so their red run is no failure.
export type StepLook = TaskStepDto["state"] | "expected";
export const stepLook = (s: Pick<TaskStepDto, "state" | "detail">): StepLook =>
  s.state === "failed" && s.detail.expectRed ? "expected" : s.state;
export const STEP_TEXT: Record<StepLook, string> = {
  ok: "Done",
  failed: "Failed",
  expected: "Red as expected",
  running: "Running",
  waiting: "Waiting",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

// spec.md section 6.8: the branch of a small task. A larger task gets more branches, and each one starts with <prefix><KEY>-.
export const plannedBranch = (prefix: string, t: Pick<TaskDto, "key" | "title">, size: TaskSize) =>
  size === "small" ? branchName(prefix, t.key, { kind: "small", title: t.title }) : `${prefix}${t.key}-`;

// The branch prefix rule of the plan approval (branchPrefix in dto.ts, spec.md section 6.16.1), with its sentence.
export function prefixProblem(prefix: string): string | null {
  const r = branchPrefix.safeParse(prefix);
  return r.success ? null : (r.error.issues[0]?.message ?? "Invalid branch prefix.");
}

// spec.md sections 6.16.1 and 6.16.4: the branch picks of the plan screen. chip: a prefix of Settings > Tasks, or null for "Other…"
// with the free prefix other. existing: the choice for a planned name that exists on the server.
export type BranchPick = { chip: string | null; other: string; existing: "continue" | "new" };

// The first chip starts selected. A stored prefix of the task comes back, under "Other…" when the list no longer has it.
export function firstPick(stored: string | undefined, prefixes: string[]): BranchPick {
  if (stored && !prefixes.includes(stored)) return { chip: null, other: stored, existing: "continue" };
  return { chip: stored ?? prefixes[0] ?? null, other: "", existing: "continue" };
}

export const pickedPrefix = (p: BranchPick) => p.chip ?? p.other;

// The branch part of the plan approval. existing goes only with a check of the picked prefix that found the name on the server.
// checked: the prefix of that check.
export function branchApproval(
  p: BranchPick,
  check: { checked: string | null; data: BranchCheckDto | undefined },
): { prefix: string; existing?: BranchPick["existing"] } | { problem: string } {
  const prefix = pickedPrefix(p);
  const problem = prefixProblem(prefix);
  if (problem) return { problem };
  const found = check.checked === prefix && !!check.data?.exists.length;
  return found ? { prefix, existing: p.existing } : { prefix };
}

// spec.md section 6.16.3: the line under the branch list. text: the filter of that page.
export function branchNote(d: Pick<BranchSearchDto, "branches" | "more">, text: string): string | null {
  if (!d.branches.length) return text ? `No branch matches “${text}”.` : "The repository has no branches.";
  return d.more ? "Type to see more branches." : null;
}

// spec.md section 6.16.3: "Cannot read the branches of PROJ/repo. <reason>". The route sends that sentence; other errors get its start.
export const branchesError = (message: string, project: string, repo: string) =>
  message.startsWith("Cannot read the branches") ? message : `Cannot read the branches of ${project}/${repo}. ${message}`;

// The step strip of the server (stepStrip), with the current step: its index, or -1 for a failed or stopped task.
export const stripSteps = (t: Pick<TaskDto, "strip">) =>
  t.strip.steps.map((label, i) => ({ label, current: i === t.strip.current, done: i < t.strip.current }));
