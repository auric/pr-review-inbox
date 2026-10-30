// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Task view model (docs/plans/review-v2/spec.md sections 6.12 and 7): one status sentence that names who acts or what the app
// waits for, at most one primary action, and the More actions, per state. Pure: tests/web/tasks-model.test.ts has one test per row.
// runner: the short name of the CLI from meta, because UI code names no product (tests/ui/names.test.ts).
import {
  type AttachmentDto,
  type AttachmentMeta,
  type BranchCheckDto,
  type BranchSearchDto,
  type BuildDto,
  branchPrefix,
  fileOnly,
  listedKind,
  listedOnly,
  RUN_TEXT_BYTES,
  type SubtaskDto,
  type TaskDto,
  type TaskPartDto,
  type TaskPrDto,
  type TaskQuestionDto,
  type TaskRepoDto,
  type TaskRowDto,
  type TaskStepDto,
} from "../../shared/dto";
import { branchName, type FoundItem, type RepoAccess, START_MODES, type StartMode, type TaskSize } from "../../shared/task";
import { namedBuild } from "../pr/build";
import { attachmentRows, sizeText } from "../review/tasks";

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
  | "update"
  | "undo-update"
  | "retry-prs"
  | "pointer"
  | "pick-base"
  | "close"
  // spec.md section 6.20: the actions of a task with sub-tasks. Each one acts on the focused part.
  | "ask-again"
  | "start-now"
  | "wait-merge"
  | "drop"
  | "push"
  | "move"
  | "push-move"
  | "tell"
  | "tracker-move"
  | "tracker-read"
  // spec.md section 6.20.14: plan a sub-task that is new in the tracker.
  | "add-plan";
export type Action = { kind: ActionKind; label: string };

// screen: the content under the header. questions: the Questions form. plan: the plan approval. change: the spec change review.
// build: the progress of the build. ready: the part that waits for its PR. pr: the open PR. end: done, failed, or closed.
export type Screen = "questions" | "plan" | "change" | "build" | "ready" | "pr" | "end";

export type TaskView = {
  status: string;
  // A second line: the elapsed time of a running step, or the reason of a stop.
  detail: string | null;
  // One line per repository whose base moved or whose PR has conflicts, when the update changes several (spec.md section 6.18.5).
  lines: string[];
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
// The build of the newest code part with an open PR. The task view status and its build line use it.
export const prBuild = (t: Pick<TaskDto, "parts">): BuildDto | null => {
  const p = codeParts(t).at(-1);
  return p?.remotePr != null ? p.build : null;
};
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

// ---------- The Tell box and Update from the base branch (spec.md section 6.18) ----------

// spec.md section 6.18.3 (Q60): one base names itself; several give "2 base branches".
export function baseLabel(branches: string[]): string {
  const u = [...new Set(branches)];
  return u.length === 1 ? (u[0] as string) : `${u.length} base branches`;
}

// The repositories that the update would change: a base with new commits, a PR that the server reports with conflicts, or a base that
// "Pick a base branch" changed (spec.md section 6.16.7).
export const movedBases = (t: Pick<TaskDto, "bases">) => t.bases.filter((b) => b.newCommits > 0 || b.conflicted || b.changed);

// "release/2.1 has 5 new commits": the news of the bases with new commits.
function baseNews(t: TaskDto): string {
  const moved = t.bases.filter((b) => b.newCommits > 0);
  const label = baseLabel(moved.map((b) => b.branch));
  if (moved.length === 1) return `${label} has ${plural(moved[0]?.newCommits ?? 0, "new commit")}`;
  return new Set(moved.map((b) => b.branch)).size === 1
    ? `${label} has new commits in ${moved.length} repositories`
    : "The base branches have new commits";
}

// spec.md section 6.18.5, Several repositories: "PROJ/lib from develop · 3 new commits", deepest first. One repository needs no line.
export function baseLines(t: Pick<TaskDto, "bases" | "repos">): string[] {
  const moved = movedBases(t);
  if (moved.length < 2) return [];
  const repo = (id: number) => t.repos.find((r) => r.id === id);
  return moved
    .toSorted((a, b) => (repo(b.taskRepo)?.depth ?? 0) - (repo(a.taskRepo)?.depth ?? 0))
    .map((b) => {
      const r = repo(b.taskRepo);
      const name = r?.project && r.repo ? `${r.project}/${r.repo}` : (r?.path ?? "the main repository");
      const news = [
        ...(b.changed ? ["new base"] : []),
        ...(b.newCommits > 0 ? [plural(b.newCommits, "new commit")] : []),
        ...(b.conflicted ? ["the PR has conflicts"] : []),
      ];
      return `${name} from ${b.branch} · ${news.join(", ")}`;
    });
}

// A send of the Tell box (an instruct step) with the steps that it ran. The loop gives the checks, fixes, and commit of a send the item of
// its instruct step (I1, I2), and its own review the item "review" (loop.ts driveInstruct).
export type SendGroup = { send: TaskStepDto; steps: TaskStepDto[] };
export type LogRow = { step: TaskStepDto } | SendGroup;

// The rows of the Log tab, newest first: each send with its steps in one group (spec.md section 6.18.1, Step history).
export function logRows(steps: TaskStepDto[]): LogRow[] {
  const out: LogRow[] = [];
  let g: SendGroup | null = null;
  for (const s of steps.toReversed()) {
    if (s.kind === "instruct") {
      g = { send: s, steps: [] };
      out.push(g);
    } else if (g && s.part === g.send.part && (s.item === g.send.item || s.item === "review")) g.steps.unshift(s);
    else {
      g = null;
      out.push({ step: s });
    }
  }
  return out.reverse();
}

// The send or the update that the loop works on now, else null.
export function activeSend(t: Pick<TaskDto, "steps" | "working">): TaskStepDto | null {
  const open = runningStep(t);
  if (!open && !t.working) return null;
  if (open?.kind === "update" || open?.kind === "resolve") return open;
  const update = t.steps.find((s) => s.kind === "update" && (s.state === "running" || s.state === "waiting"));
  if (update) return update;
  const first = logRows(t.steps)[0];
  if (!first || !("send" in first)) return null;
  return !open || first.send === open || first.steps.includes(open) ? first.send : null;
}

// spec.md section 6.18.1: a stopped or failed send gives its text back to the box. A later send replaces it.
export function stoppedSend(t: Pick<TaskDto, "steps">): { id: number; text: string } | null {
  const s = t.steps.find((x) => x.kind === "instruct");
  const i = s?.detail.instruct;
  return s && i && (i.result === "stopped" || i.result === "failed") ? { id: s.id, text: i.text } : null;
}

// spec.md section 6.18.1: the sentence of a stop or a failure of the newest send ("Stopped. Your instructions changed nothing. The
// text is back in the box."), while nothing newer ran.
function sendNote(t: TaskDto): string | null {
  const first = logRows(t.steps)[0];
  if (!first || !("send" in first)) return null;
  const r = first.send.detail.instruct?.result;
  return r === "stopped" || r === "failed" ? (first.send.detail.notes.at(-1) ?? null) : null;
}

// The Log tab result of a send (spec.md section 6.18.1, Step history).
export function sendResult(g: SendGroup, runner: string): string {
  const i = g.send.detail.instruct;
  switch (i?.result) {
    case "done": {
      const files = g.steps.find((s) => s.kind === "commit")?.detail.diffStat?.files ?? g.send.detail.diffStat?.files ?? 0;
      const checked = g.steps.some((s) => s.kind === "review" && s.state === "ok") ? ` Checked by ${runner}.` : "";
      return `Done: ${plural(files, "file")} changed. Checks green.${checked}`;
    }
    case "no_change":
      return `${runner} changed no file: ${g.send.detail.summary ?? ""}`.trimEnd();
    case "stopped":
      return "Stopped";
    case "failed":
      return g.send.detail.notes.findLast((n) => n.startsWith("Failed: ")) ?? "Failed";
    default: {
      const open = [g.send, ...g.steps].some((s) => s.state === "running" || s.state === "waiting");
      return open ? STEP_TEXT.running : STEP_TEXT[stepLook(g.send)];
    }
  }
}

// spec.md section 6.18.1: the Tell box. none: no box. open: it can send. busy: a step, a check, or an update runs; the box keeps
// its text and waits. tasks.ts instructTarget has the same rules on the server.
export type TellBox = "none" | "open" | "busy";
const BOX_REASONS = new Set<NonNullable<TaskDto["blocked"]>["kind"]>(["red", "size", "blocker", "denied_path", "update"]);
const WORKTREE = new Set<TaskPartDto["state"]>(["implementing", "self_reviewed", "pr_open", "changes_requested", "approved"]);
const BUILT = new Set<TaskPartDto["state"]>(["self_reviewed", "pr_open", "changes_requested", "approved"]);
export function tellBox(t: TaskDto): TellBox {
  if (t.state !== "implementing" && t.state !== "ready") return "none";
  const b = t.blocked;
  if (b && !BOX_REASONS.has(b.kind)) return "none";
  const part = currentPart(t);
  if (!part || !WORKTREE.has(part.state)) return "none";
  // The first build of the part runs. A send from a reason of that build keeps the box while it runs.
  if (!b && !BUILT.has(part.state) && !activeSend(t)) return "none";
  return t.canInstruct ? "open" : "busy";
}

// The update, the resolve step, or the base of a running update step.
function updateSentence(t: TaskDto, s: TaskStepDto, runner: string): string {
  if (s.kind === "resolve") {
    const p = s.detail.resolve?.paths ?? [];
    const what = p.length > 1 ? `${p[0]} and ${plural(p.length - 1, "more file")}` : (p[0] ?? "the files");
    return `${runner} resolves the conflicts in ${what}.`;
  }
  const repos = s.detail.update?.repos ?? [];
  const bases = repos.length ? repos.map((r) => r.base) : movedBases(t).map((b) => b.branch);
  const label = bases.length ? baseLabel(bases) : t.targetBranch;
  const ord = t.parts.find((p) => p.id === s.part)?.ord ?? null;
  const what = ord !== null && codeParts(t).length > 1 ? `part ${ord}` : "your change";
  const modes = new Set(repos.map((r) => r.mode));
  const how = modes.size === 2 ? ": rebasing and merging" : modes.has("merge") ? ": merging" : modes.has("rebase") ? ": rebasing" : "";
  return `Updating ${what} from ${label}${how}.`;
}

// One sentence for a running step: who works, and on what.
export function stepSentence(t: TaskDto, s: TaskStepDto, runner: string): string {
  const ord = t.parts.find((p) => p.id === s.part)?.ord ?? null;
  const of = partWords(t, ord);
  switch (s.kind) {
    case "instruct":
      return `${runner} works on your instructions${of}.`;
    case "update":
    case "resolve":
      return updateSentence(t, s, runner);
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
      return s.item === "pointer" ? `Pointing ${t.project}/${t.repo} at the merged commit.` : `Saving the change as a commit${of}.`;
    // A step of the PR rows names its repository (pr.ts runRows). The one-PR route names the part branch.
    case "push":
      return s.item && t.prs.some((r) => prName(r) === s.item) ? `Pushing the branch to ${s.item}.` : "Pushing the branch.";
    case "pr":
      return s.item && t.prs.some((r) => prName(r) === s.item) ? `Opening the PR in ${s.item}.` : "Opening the PR.";
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
  instruct: "your instructions",
  update: "the update from the base",
  resolve: "the conflicts of the update",
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
  // spec.md section 6.16.8: each changed repository gets its own PR, and the build shows which ones change.
  const each = inTask(t).filter((r) => r.access === "edit").length > 1 ? " per changed repository" : "";
  const prs = size === "small" ? `1 PR${each}` : size === "medium" ? `1 code PR${each}` : plural(t.estimate?.parts ?? 2, "part");
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

// forge: the short name of the code host from meta, for the conflict row (spec.md section 6.18.5). newest: the task_pr ID whose merge
// commit the forge did not name, after the user saw that 409; the pointer button then points at the newest base commit.
// name: the focused part of a task with sub-tasks, such as "ABC-12 (2 of 4)" (spec.md section 6.20.13). The ready sentences use it.
export function taskView(t: TaskDto, o: { runner: string; forge: string; now: number; newest?: number | null; name?: string }): TaskView {
  const R = o.runner;
  const run = runningStep(t);
  const base = { detail: null, lines: [], more: [], needsYou: false, running: false } satisfies Partial<TaskView>;
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
  const prs = codeParts(t);
  const last = prs.at(-1);
  if (t.state === "ready") {
    if (prs.length && prs.every((p) => p.prState === "MERGED" || p.state === "merged" || p.state === "abandoned"))
      return {
        ...base,
        status: prs.length > 1 ? `Done. All ${prs.length} PRs merged.` : "Done. The PR merged.",
        primary: CLOSE,
        screen: "end",
      };
    if (last?.prState === "DECLINED")
      return { ...base, status: "The PR was declined on the server.", primary: CLOSE, screen: "pr", needsYou: true };
  }

  // implementing, and ready with a send, an update, or a reason of them (spec.md section 6.18).
  const goPr: Action = { kind: "go-pr", label: "Go to the PR" };
  const hasPr = part?.remotePr != null;
  if (b) {
    const step = stepFor(t, b.step);
    // The server takes Resume, Continue, and the line limit in state implementing only.
    const loopOnly = new Set<ActionKind>(["resume", "continue", "keep-size", "change-limit"]);
    const keep = (a: Action | null) => (a && (t.state === "implementing" || !loopOnly.has(a.kind)) ? a : null);
    const blocked = (primary: Action | null, more: Action[], screen: Screen = "build"): TaskView => ({
      ...base,
      status: b.text,
      primary: keep(primary),
      more: more.filter((a) => keep(a) !== null),
      screen,
      needsYou: true,
    });
    switch (b.kind) {
      case "red":
        // spec.md section 6.18.3, Checks: red checks after an update keep it until "Undo the update".
        return blocked(
          { kind: "see-why", label: "See why" },
          t.canUndoUpdate ? [{ kind: "undo-update", label: "Undo the update" }, STOP] : [{ kind: "resume", label: "Resume" }, STOP],
        );
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
      case "preflight":
        // spec.md section 6.16.7: a base that is gone gets "Pick a base branch". Every other reason says what to fix on the forge, and
        // "Try again" runs the checks again.
        return b.base
          ? blocked({ kind: "pick-base", label: "Pick a base branch" }, [{ kind: "resume", label: "Try again" }, STOP])
          : blocked({ kind: "resume", label: "Try again" }, [STOP]);
      case "update":
        // spec.md section 6.18.4: "The update from <base> stopped: <reason>. The branch is as it was."
        return blocked(
          { kind: "update", label: "Try again" },
          hasPr ? [goPr] : [{ kind: "show-diff", label: "Show the diff" }],
          hasPr ? "pr" : "build",
        );
      default:
        // denied_path, push, and error: one sentence with the cause, and Resume starts the step again from the last commit.
        return blocked({ kind: "resume", label: "Resume" }, [STOP]);
    }
  }
  const send = activeSend(t);
  const pause: Action = { kind: "pause", label: "Pause after this step" };
  // A send or an update ends by itself, and Pause applies to the build only.
  const stopOnly = !!send || t.state === "ready";
  if (run) return working(stepSentence(t, run, R), stopOnly || run.kind === "check" ? [STOP] : [pause, STOP]);
  if (t.working || (t.state === "implementing" && part?.state !== "self_reviewed"))
    return working(t.working ? "The app prepares the next step." : `${R} is building your change.`, stopOnly ? [STOP] : [pause, STOP]);

  // spec.md section 6.16.8: the PR rows of a part that changes several repositories. A failed row comes first, then the pointer of a
  // merged submodule.
  const rows = partRows(t, part);
  if (rows.length > 1) {
    const failed = rows.filter((r) => r.state === "failed" && r.remotePr === null);
    const opened = rows.filter((r) => r.remotePr !== null).length;
    const first = failed[0];
    if (first) {
      const one = failed.length === 1;
      return {
        ...base,
        status: `${opened} of ${rows.length} PRs are open. The ${one ? "PR" : "PRs"} for ${listText(failed.map(prName))} failed.`,
        detail: first.error,
        primary: { kind: "retry-prs", label: one ? `Try again for ${prName(first)}` : `Try again for ${failed.length} PRs` },
        more: opened ? [goPr] : [{ kind: "show-diff", label: "Show the diff" }],
        screen: "pr",
        needsYou: true,
      };
    }
    const sub = pointerRow(rows);
    if (sub) {
      const parent = `${t.project}/${t.repo}`;
      return {
        ...base,
        status: `The ${prName(sub)} PR merged. ${parent} still points at the task branch commit.`,
        detail: sub.error,
        primary: {
          kind: "pointer",
          label: o.newest === sub.id ? `Point ${parent} at the newest ${sub.baseBranch} commit` : `Point ${parent} at the merged commit`,
        },
        more: [goPr],
        screen: "pr",
        needsYou: true,
      };
    }
  }

  // The waits of a built part (spec.md sections 6.12 and 6.18.5).
  const moved = t.bases.some((x) => x.newCommits > 0);
  const conflicted = t.bases.filter((x) => x.conflicted);
  const picked = t.bases.filter((x) => x.changed);
  // spec.md section 6.16.7: the commits stand on the old base, so the PR waits for the update.
  const pickedStatus = picked.length
    ? `The base branch is now ${baseLabel(picked.map((x) => x.branch))}. Update the branch before the PR.`
    : null;
  const bases = movedBases(t);
  const update: Action | null = bases.length ? { kind: "update", label: `Update from ${baseLabel(bases.map((x) => x.branch))}` } : null;
  const asked = t.needsBase;
  const label = (list: TaskDto["bases"]) => (list.length ? baseLabel(list.map((x) => x.branch)) : t.targetBranch);
  const detail = sendNote(t) ?? (asked && !moved ? `${R} asked for the newest ${label(t.bases)}. The branch already has it.` : null);
  const why = asked?.reason.trim().replace(/[^.?!]$/, "$&.");
  const askedStatus = asked && `${R} says the branch needs the newest ${label(bases)}${why ? `: ${why}` : "."}`;
  const wait = (status: string, primary: Action | null, more: Action[], screen: Screen, needsYou: boolean): TaskView => ({
    ...base,
    status,
    detail,
    lines: baseLines(t),
    primary,
    more,
    screen,
    needsYou,
  });

  if (t.state === "implementing" && part) {
    const n = prs.length;
    const more: Action[] = [
      { kind: "show-diff", label: "Show the diff" },
      ...(t.points.length ? [{ kind: "fix-points" as const, label: "Fix the small points too" }] : []),
    ];
    const asIs: Action = { kind: "open-pr", label: "Open the PR as is" };
    if (update && pickedStatus) return wait(pickedStatus, update, more, "ready", true);
    if (update && moved && askedStatus) return wait(askedStatus, update, [asIs, ...more], "ready", true);
    if (update && moved) return wait(`${baseNews(t)} since the branch point.`, update, [asIs, ...more], "ready", true);
    if (rows.length > 1)
      return wait(
        `Your change in ${rows.length} repositories is ready and checked by ${R}.`,
        { kind: "open-pr", label: `Open ${plural(rows.filter((r) => r.remotePr === null).length, "PR")}` },
        more,
        "ready",
        true,
      );
    if (o.name) return wait(`${o.name} is ready and checked by ${R}.`, { kind: "open-pr", label: "Open the PR" }, more, "ready", true);
    return wait(
      n > 1 ? `Part ${part.ord} of ${n} is ready and checked by ${R}.` : `Your change is ready and checked by ${R}.`,
      { kind: "open-pr", label: n > 1 ? `Open PR for part ${part.ord} of ${n}` : "Open the PR" },
      more,
      "ready",
      true,
    );
  }

  const of = prs.length > 1 && last ? ` of part ${last.ord}` : "";
  if (update && pickedStatus) return wait(pickedStatus, update, [goPr, CLOSE], "pr", true);
  if (update && conflicted.length) {
    const pr = prs.length > 1 && last ? `the PR for part ${last.ord}` : "your PR";
    return wait(
      `${o.forge} reports conflicts between ${pr} and ${baseLabel(conflicted.map((x) => x.branch))}.`,
      update,
      [goPr, CLOSE],
      "pr",
      true,
    );
  }
  if (update && askedStatus) return wait(askedStatus, update, [goPr, CLOSE], "pr", true);
  // spec.md section 6.18.2, step 7: a commit after the push. "Push to <branch>" has no route yet, so the row has no primary action.
  if (part?.pushed && part.head && part.head !== part.pushed) {
    const who = prs.length > 1 ? `Part ${part.ord}` : "Your change";
    return wait(
      `${who} has new commits that are not on the server yet.`,
      null,
      [{ kind: "show-diff", label: "Show the diff" }, goPr, ...(update ? [update] : []), CLOSE],
      "pr",
      false,
    );
  }
  // docs/plans/ci-builds.md, Layer A: the build of the newest PR.
  const build = prBuild(t);
  if (build?.state === "failed") {
    const name = namedBuild(build)?.name;
    return wait(`The build of your PR failed${name ? `: ${name}` : ""}.`, goPr, [...(update ? [update] : []), CLOSE], "pr", true);
  }
  const allOpen = rows.length > 1 && rows.every((r) => r.state === "pr_open");
  const waiting = `${allOpen ? `All ${rows.length} PRs are open. ` : ""}Waiting for ${waitingFor(last?.waiting ?? [])}${of}.`;
  const ci = build?.state === "running" ? " The build runs." : build?.state === "passed" ? " The build passed." : "";
  if (update && moved) return wait(`${waiting}${ci} ${baseNews(t)}.`, goPr, [update, CLOSE], "pr", false);
  return wait(`${waiting}${ci || " Nothing to do."}`, goPr, [CLOSE], "pr", false);
}

// ---------- Several repositories (spec.md sections 6.16.5 and 6.16.8) ----------

export const prName = (r: Pick<TaskPrDto, "project" | "repo">) => `${r.project}/${r.repo}`;

// "A", "A and B", "A, B, and C".
export function listText(names: string[]): string {
  if (names.length < 3) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

// The PR rows of a part: the submodules deepest first, the main repository last (TaskDto.prs).
export const partRows = (t: Pick<TaskDto, "prs">, part: Pick<TaskPartDto, "id"> | null): TaskPrDto[] =>
  part ? t.prs.filter((r) => r.part === part.id) : [];

// The merged submodule PR whose parent still points at the task branch commit, first in the row order.
export const pointerRow = (rows: TaskPrDto[]): TaskPrDto | null =>
  rows.find((r) => r.id !== null && r.role === "submodule" && r.state === "merged" && r.pointer === "task_branch") ?? null;

// A part of the 409 sentence of the pointer route when the forge names no merge commit (pointer.ts noMergeText). The same button then
// sends newest. UI code names no product, so the forge name stays out.
export const NO_MERGE = " did not name the merge commit.";

// The state of one row in "Push and open PRs". sentAt: the newest step ID when the user sent this row in the open dialog, else null. A
// sent row waits until a push or PR step of its repository ends after that step, so an old failure does not show again.
export type RowLook = { state: "waiting" | "running" | "open" | "failed"; text: string };
export function prRowLook(r: TaskPrDto, steps: readonly TaskStepDto[], sentAt: number | null): RowLook {
  if (r.running === "push") return { state: "running", text: "Pushing" };
  if (r.running === "pr") return { state: "running", text: "Opening the PR" };
  if (r.remotePr !== null) {
    const word = r.state === "merged" ? "merged" : r.state === "declined" ? "declined" : "open";
    return { state: "open", text: `PR #${r.remotePr} ${word}` };
  }
  const name = prName(r);
  const ended = (s: TaskStepDto) =>
    sentAt !== null &&
    s.id > sentAt &&
    s.item === name &&
    (s.kind === "push" || s.kind === "pr") &&
    s.state !== "running" &&
    s.state !== "waiting";
  if (sentAt !== null && !steps.some(ended)) return { state: "waiting", text: "Waiting" };
  if (r.state === "failed") return { state: "failed", text: r.error ? `Failed: ${r.error}` : "Failed" };
  return { state: "waiting", text: "Waiting" };
}

// "3 files, 42 lines" of a row, or null before the first line count.
export function rowSize(r: Pick<TaskPrDto, "files" | "lines">): string | null {
  const parts = [...(r.files === null ? [] : [plural(r.files, "file")]), ...(r.lines === null ? [] : [plural(r.lines, "line")])];
  return parts.length ? parts.join(", ") : null;
}

// "PROJ/lib", or the folder of a submodule that maps to no repository of the forge.
export const repoName = (r: Pick<TaskRepoDto, "project" | "repo" | "path">) =>
  r.project && r.repo ? `${r.project}/${r.repo}` : (r.path ?? "the main repository");

// The repositories of the task, the main one first. A proposed or skipped row is no repository of the task.
export const inTask = (t: Pick<TaskDto, "repos">) => t.repos.filter((r) => r.role !== "added" || (r.proposal ?? "added") === "added");
export const proposals = (t: Pick<TaskDto, "repos">) => t.repos.filter((r) => r.role === "added" && r.proposal === "proposed");
// The plan screen lists the repositories with a base picker each when the task has more than one, or a proposal.
export const showRepos = (t: Pick<TaskDto, "repos">) => inTask(t).length > 1 || proposals(t).length > 0;

export const ACCESS_TEXT: Record<RepoAccess, string> = { edit: "Can change", read: "Read only", none: "Not available" };

export function roleText(r: Pick<TaskRepoDto, "role" | "path">): string {
  if (r.role === "main") return "Main repository";
  if (r.role === "added") return "Added repository";
  return r.path ? `Submodule at ${r.path}` : "Submodule";
}

// The base of each repository that the task changes (spec.md section 6.16.3). The plan approval sends them, and the server refuses a base
// that the plan was not written on. A task made before its rows has the main row 0, which the route does not take.
export function basePicks(t: Pick<TaskDto, "repos" | "targetBranch">): { taskRepo: number; branch: string }[] {
  return inTask(t).flatMap((r) => {
    const branch = r.role === "main" ? t.targetBranch : r.baseBranch;
    return r.id > 0 && r.access === "edit" && r.project && r.repo && branch ? [{ taskRepo: r.id, branch }] : [];
  });
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
  update: "Needs you: the update stopped",
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

// ---------- Attachments of a task (spec.md section 6.17) ----------

// One attachment of the form or of the Attachments tab. kind: from the file bytes after the download, else from the listed type.
// why: the reason that it stays listed only, null when it has a box.
export type FileChoice = {
  id: string;
  filename: string;
  size: number;
  type: string | null;
  kind: "image" | "pdf" | "text" | "file";
  why: string | null;
  file: AttachmentDto | null;
};

export function fileChoices(attachments: AttachmentMeta[], files: AttachmentDto[]): FileChoice[] {
  return attachmentRows({ attachments, files }).map((r) => {
    const f = r.file;
    const kind = f ? (f.image ? "image" : f.pdf ? "pdf" : f.text ? "text" : "file") : (listedKind(r.type) ?? "file");
    // A row that the listing no longer names is a downloaded file, so its bytes decide too.
    const why = f ? fileOnly(f) : listedOnly({ mimeType: r.type, size: r.size });
    return { id: r.id, filename: r.filename, size: r.size, type: r.type, kind, why, file: f };
  });
}

// The boxes that start ticked in the form: every box when the setting askAttachments is off, else none.
export const firstPicks = (rows: FileChoice[], ask: boolean): string[] => (ask ? [] : rows.filter((r) => r.why === null).map((r) => r.id));

// The state line of a file in the Attachments tab.
export function fileChoiceState(r: FileChoice, runner: string): string {
  if (r.why) return r.why;
  if (!r.file) return "Not downloaded. A tick downloads it.";
  if (!r.file.include) return `Downloaded. ${runner} does not get it.`;
  return r.kind === "text" && r.file.size > RUN_TEXT_BYTES
    ? `${runner} gets it, cut at ${RUN_TEXT_BYTES / 1024} KB.`
    : `${runner} gets it in each step.`;
}

const KIND_TEXT = { image: "image", pdf: "PDF", text: "text", file: "file" } as const;
// "2 KB, image/png": the size and the type of a file.
export const fileMeta = (r: FileChoice) => `${sizeText(r.size)}, ${r.type ?? KIND_TEXT[r.kind]}`;

// ---------- The repository of the Build form (spec.md section 6.12) ----------

export type RepoChoice = { project: string; repo: string; key: string };
export const REPOS_SHOWN = 50;

// The known repositories (of the stored PRs and of the tasks) first, then the listed ones of the forge, each key once.
export function repoChoices(known: { project: string; repo: string }[], listed: { project: string; repo: string }[]): RepoChoice[] {
  const out = new Map<string, RepoChoice>();
  for (const r of [...known].sort((a, b) => `${a.project}/${a.repo}`.localeCompare(`${b.project}/${b.repo}`)).concat(listed)) {
    const key = `${r.project}/${r.repo}`;
    if (!out.has(key)) out.set(key, { project: r.project, repo: r.repo, key });
  }
  return [...out.values()];
}

// The choices whose key holds the text, case-insensitive, at most REPOS_SHOWN. more: the matches that the list leaves out.
export function repoMatches(choices: RepoChoice[], text: string): { items: RepoChoice[]; more: number } {
  const q = text.trim().toLowerCase();
  const all = q ? choices.filter((c) => c.key.toLowerCase().includes(q)) : choices;
  return { items: all.slice(0, REPOS_SHOWN), more: Math.max(0, all.length - REPOS_SHOWN) };
}

// ---------- Pick a base branch (spec.md section 6.16.7) ----------

// The repository whose base the pre-flight did not find, for the base picker under the status. null: no such reason.
export function goneBase(t: Pick<TaskDto, "blocked" | "repos" | "project" | "repo">) {
  const b = t.blocked?.kind === "preflight" ? t.blocked.base : undefined;
  if (!b) return null;
  const r = t.repos.find((x) => x.id === b.taskRepo);
  const project = r?.project ?? t.project;
  const repo = r?.repo ?? t.repo;
  return { taskRepo: b.taskRepo, branch: b.branch, project, repo, name: `${project}/${repo}` };
}

// ---------- Sub-tasks: one PR per sub-task (spec.md section 6.20) ----------

// tracker: the tracker name from meta. forge: the code host name from meta. UI code names no product.
export type SubOpts = { runner: string; forge: string; tracker: string; now: number; newest?: number | null };

const FINAL = new Set<TaskPartDto["state"]>(["merged", "abandoned"]);
const WITH_PR = new Set<TaskPartDto["state"]>(["pr_open", "changes_requested", "approved"]);

// "ABC-12", or "ABC-15, ABC-16" for a part that builds two sub-tasks.
export const partName = (t: Pick<TaskDto, "key">, p: Pick<TaskPartDto, "keys">) => (p.keys.length ? p.keys.join(", ") : t.key);

// The PR title of a part, as the server writes it (pr.ts subtaskPrText): "ABC-12: <title>", "ABC-13 (part 2 of 2): <title>" for a
// split sub-task, "ABC-15, ABC-16: <title>" for two sub-tasks. A task without sub-tasks: "<KEY>: <task title>".
export function prTitle(t: Pick<TaskDto, "key" | "title" | "parts" | "subtasks">, p: Pick<TaskPartDto, "id" | "keys" | "title">) {
  if (!t.subtasks) return `${t.key}: ${t.title}`;
  const key = p.keys[0] ?? t.key;
  const twins = codeParts(t).filter((x) => (x.keys[0] ?? t.key) === key);
  const name =
    p.keys.length > 1
      ? p.keys.join(", ")
      : twins.length > 1
        ? `${key} (part ${twins.findIndex((x) => x.id === p.id) + 1} of ${twins.length})`
        : key;
  return `${name}: ${p.title}`;
}

// "ABC-12 (2 of 4)": the part k of n of the task (spec.md section 6.20.13).
export function partLabel(t: Pick<TaskDto, "key" | "parts">, p: Pick<TaskPartDto, "id" | "keys">): string {
  const parts = codeParts(t);
  return `${partName(t, p)} (${parts.findIndex((x) => x.id === p.id) + 1} of ${parts.length})`;
}

const subOf = (t: Pick<TaskDto, "subtasks">, key: string | undefined) => t.subtasks?.find((s) => s.key === key) ?? null;
const lowerPart = (t: Pick<TaskDto, "parts">, p: Pick<TaskPartDto, "after">) =>
  p.after === null ? null : (t.parts.find((x) => x.id === p.after) ?? null);
// Each sub-task of the part is done in the tracker.
const doneInTracker = (t: Pick<TaskDto, "subtasks">, p: Pick<TaskPartDto, "keys">) =>
  p.keys.length > 0 && p.keys.every((k) => subOf(t, k)?.category === "done");
const newCommits = (p: Pick<TaskPartDto, "pushed" | "head" | "adopted">) => !p.adopted && !!p.pushed && !!p.head && p.head !== p.pushed;

// The part of a reason: the part that the reason names, else the part of its step.
export function blockedPart(t: Pick<TaskDto, "blocked" | "steps">): number | null {
  const b = t.blocked;
  if (!b) return null;
  return b.part ?? (b.step === null ? null : (t.steps.find((s) => s.id === b.step)?.part ?? null));
}

// spec.md section 6.20.13, the default focus, first match: the part of the reason; a part ready for its PR click; a part whose lower part
// merged; a part with a moved base, conflicts, or commits not on the server; the part that the runner builds; the first part that waits
// for a review. Then the first part that is not merged or dropped, then the first part.
export function defaultFocus(t: TaskDto): TaskPartDto | null {
  const parts = codeParts(t);
  const b = blockedPart(t);
  const tests: ((p: TaskPartDto) => boolean)[] = [
    (p) => p.id === b,
    (p) => p.state === "self_reviewed" && p.lower === null,
    (p) => p.lower !== null && !FINAL.has(p.state),
    (p) => movedBases(p).length > 0 || newCommits(p),
    (p) => p.state === "implementing",
    (p) => p.state === "pr_open" || p.state === "changes_requested",
    (p) => !FINAL.has(p.state),
  ];
  for (const f of tests) {
    const hit = parts.find(f);
    if (hit) return hit;
  }
  return parts[0] ?? null;
}

// One row of the sub-task list: one sentence and one actor (spec.md section 6.20.13). part: null for a sub-task without a part.
// action: the secondary action of the row. status: the tracker status of the first sub-task. hint: a tracker status that does not fit
// the PR, never a move.
export type SubRow = {
  id: string;
  part: TaskPartDto | null;
  key: string;
  summary: string;
  label: string;
  text: string;
  actor: string;
  action: Action | null;
  status: string | null;
  hint: string | null;
};

const trackerMove = (tracker: string): Action => ({ kind: "tracker-move", label: `Move in ${tracker}…` });

// The sentence, the actor, and the row action of a part (spec.md section 6.20.13 table).
function partRow(t: TaskDto, p: TaskPartDto, o: SubOpts): Pick<SubRow, "text" | "actor" | "action"> {
  const R = o.runner;
  const name = partName(t, p);
  const who = p.waiting.length ? listText(p.waiting) : null;
  const goPr: Action = { kind: "go-pr", label: "Go to the PR" };
  const drop: Action = { kind: "drop", label: "Drop this sub-task" };
  if (p.lower !== null && !FINAL.has(p.state) && p.state !== "planned")
    return {
      text: `${p.lower.key} merged. Move ${name} to ${t.targetBranch}.`,
      actor: "You",
      action: lowerAction(t, p)?.action ?? null,
    };
  switch (p.state) {
    case "planned": {
      if (doneInTracker(t, p)) return { text: `Done in ${o.tracker}.`, actor: "No one", action: drop };
      if (p.keys.some((k) => subOf(t, k)?.removed != null))
        return { text: `Removed in ${o.tracker}.`, actor: "You", action: { kind: "drop", label: "Drop" } };
      const lower = lowerPart(t, p);
      const text = p.wait ?? `${R} builds it next.`;
      if (lower?.state === "declined") return { text, actor: "You", action: drop };
      const lowerWho = lower?.waiting.length ? listText(lower.waiting) : "Reviewers";
      if (lower && p.start === "merge" && !FINAL.has(lower.state)) return { text, actor: lowerWho, action: null };
      if (lower && p.start === ON_TOP && WITH_PR.has(lower.state) && !lower.gate?.pass)
        return { text, actor: lowerWho, action: { kind: "start-now", label: "Start now" } };
      if (codeParts(t).some((x) => x.state === "implementing")) return { text, actor: R, action: null };
      return { text, actor: p.wait ? "Reviewers" : R, action: null };
    }
    case "implementing":
      return { text: `${R} builds it.`, actor: R, action: null };
    case "self_reviewed":
      return { text: "Ready. Open its PR.", actor: "You", action: { kind: "open-pr", label: "Open the PR" } };
    case "pr_open":
      if (p.adopted) return { text: `In review outside the app: PR #${p.remotePr}.`, actor: who ?? "Reviewers", action: goPr };
      return { text: who ? `In review by ${who}.` : "In review.", actor: who ?? "Reviewers", action: goPr };
    case "changes_requested":
      if (p.adopted) return { text: `${who ?? "A reviewer"} asks for changes.`, actor: "The PR author", action: goPr };
      return { text: `${who ?? "A reviewer"} asks for changes.`, actor: "You", action: { kind: "tell", label: `Tell ${R}` } };
    case "approved":
      return { text: "Approved. Waits for the merge.", actor: "The merger", action: goPr };
    case "merged":
      return { text: "Merged.", actor: "No one", action: null };
    case "declined":
      return { text: p.adopted ? "Declined outside the app." : "Declined.", actor: "You", action: drop };
    case "abandoned":
      return { text: "Dropped.", actor: "No one", action: null };
  }
}

// spec.md section 6.20.9: the row hints. They say what does not fit and never move anything.
function rowHint(p: TaskPartDto, sub: SubtaskDto | null, tracker: string): string | null {
  if (!sub?.status) return null;
  if (sub.category === "new" && WITH_PR.has(p.state)) return `${tracker} says ${sub.status}, but the PR is open.`;
  if (p.state === "merged" && sub.category !== "done") return `The PR merged. ${tracker} says ${sub.status}.`;
  return null;
}

// The rows in tracker order: each part at its first sub-task, then each sub-task that no part builds. A part that names no listed
// sub-task comes last.
export function subtaskRows(t: TaskDto, o: SubOpts): SubRow[] {
  const parts = codeParts(t);
  const out: SubRow[] = [];
  const seen = new Set<number>();
  const add = (p: TaskPartDto) => {
    seen.add(p.id);
    const sub = subOf(t, p.keys[0]);
    out.push({
      id: `part-${p.id}`,
      part: p,
      key: partName(t, p),
      summary: sub?.summary ?? p.title,
      label: partLabel(t, p),
      ...partRow(t, p, o),
      status: sub?.status ?? null,
      hint: rowHint(p, sub, o.tracker),
    });
  };
  for (const s of t.subtasks ?? []) {
    const own = parts.filter((p) => !seen.has(p.id) && p.keys[0] === s.key);
    for (const p of own) add(p);
    if (own.length || parts.some((p) => p.keys.includes(s.key))) continue;
    const row = { id: `sub-${s.key}`, part: null, key: s.key, summary: s.summary, label: s.key, status: s.status, hint: null };
    if (s.category === "done") out.push({ ...row, text: `Done in ${o.tracker}.`, actor: "No one", action: null });
    else if (s.removed !== null) out.push({ ...row, text: `Removed in ${o.tracker}.`, actor: "No one", action: null });
    else if (s.added !== null && t.plan?.adding && livePlan(t).some((x) => x.keys.includes(s.key)))
      out.push({ ...row, text: `${o.runner} planned ${s.key}. Approve the changed plan.`, actor: "You", action: null });
    else if (s.added !== null)
      out.push({ ...row, text: `${s.key} is new in ${o.tracker}.`, actor: "You", action: { kind: "add-plan", label: "Add to plan" } });
    else out.push({ ...row, text: `${o.runner} planned no PR for ${s.key}.`, actor: "No one", action: null });
  }
  for (const p of parts) if (!seen.has(p.id)) add(p);
  return out;
}

// spec.md section 6.20.9: the parent row hint, when every part merged or was dropped.
export function parentHint(t: TaskDto, tracker: string): string | null {
  const parts = codeParts(t);
  if (!parts.length || !parts.every((p) => FINAL.has(p.state)) || !parts.some((p) => p.state === "merged")) return null;
  return `All sub-tasks merged. ${tracker} says ${t.issueStatus ?? "an unknown status"} for ${t.key}.`;
}

// spec.md section 6.20.10: what a part whose lower part merged needs next. A squash or another merge needs the update first. A pushed
// update goes to the server with the move.
export function lowerAction(t: TaskDto, p: TaskPartDto): { status: string; action: Action } | null {
  const lower = p.lower;
  if (!lower) return null;
  const name = partName(t, p);
  const base = t.targetBranch;
  if (lower.how !== "merge" && p.bases.some((b) => b.newCommits > 0))
    return { status: `${lower.key} merged. Update ${name} from ${base} first.`, action: { kind: "update", label: `Update from ${base}` } };
  if (p.remotePr !== null && newCommits(p))
    return {
      status: `${name} is up to date with ${base}. Push it and move its PR to ${base}.`,
      action: { kind: "push-move", label: `Push and move to ${base}` },
    };
  return { status: `${lower.key} merged. ${name} must point to ${base} now.`, action: { kind: "move", label: `Move ${name} to ${base}` } };
}

// The line of how the lower part merged (spec.md section 6.20.10).
export function lowerHow(t: TaskDto, p: TaskPartDto, forge: string): string | null {
  const lower = p.lower;
  if (!lower) return null;
  const name = partName(t, p);
  if (lower.how === "merge") return `${lower.key} merged with a merge commit, so ${name} needs no git work.`;
  if (lower.how === "squash")
    return `${forge} squashed ${lower.key} into one commit. The update records the squash, so the PR shows only the changes of ${name}.`;
  return `${forge} merged ${lower.key} in a way that the app cannot match. The update merges ${t.targetBranch}, and conflicts can come up.`;
}

// spec.md section 6.20.1: "ABC-10 has 4 sub-tasks: 2 open, 1 in progress, 1 done." The words follow the status category of the tracker.
const CATEGORY_TEXT = { new: "open", indeterminate: "in progress", done: "done" } as const;
export function subtaskCount(key: string, list: { category: SubtaskDto["category"] }[]): string {
  const parts = (["new", "indeterminate", "done"] as const).flatMap((c) => {
    const n = list.filter((s) => s.category === c).length;
    return n ? [`${n} ${CATEGORY_TEXT[c]}`] : [];
  });
  const other = list.filter((s) => s.category === null).length;
  if (other) parts.push(`${other} with an unknown status`);
  return `${key} has ${plural(list.length, "sub-task")}: ${parts.join(", ")}.`;
}

// spec.md section 6.20.5: "The plan is ready: 4 sub-tasks, 2 to build, about 600 changed lines."
export function subPlanSentence(t: TaskDto): string {
  const n = t.subtasks?.length ?? 0;
  const build = livePlan(t).length;
  const lines = t.estimate ? `, about ${t.estimate.lines.toLocaleString("en-US")} changed lines` : "";
  return `The plan is ready: ${plural(n, "sub-task")}, ${build} to build${lines}.`;
}

// spec.md section 6.20.14: "The changed plan is ready: 1 new sub-task, about 120 changed lines."
export function addPlanSentence(t: TaskDto): string {
  const live = livePlan(t);
  const keys = new Set(live.flatMap((s) => s.keys));
  const lines = live.reduce((n, s) => n + (s.lines ?? 0), 0);
  const tail = lines ? `, about ${lines.toLocaleString("en-US")} changed lines` : "";
  return keys.size
    ? `The changed plan is ready: ${plural(keys.size, "new sub-task")}${tail}.`
    : "The changed plan adds no sub-task. Approve it to close it.";
}

// The Task view of a task with sub-tasks: the status and the one primary button of the focused part (spec.md section 6.20.13).
// focus: the part that the user picked, else the default focus.
export function subtaskView(t: TaskDto, focus: TaskPartDto | null, o: SubOpts): TaskView {
  const read: Action = { kind: "tracker-read", label: `Read ${o.tracker} again` };
  if (t.state === "spec_draft") {
    const v = taskView(t, o);
    if (v.primary?.kind !== "approve") return v;
    return {
      ...v,
      status: subPlanSentence(t),
      more: [{ kind: "edit-plan", label: "Edit" }, { kind: "ask-again", label: `Ask ${o.runner} again` }, read, STOP],
    };
  }
  if (t.state !== "implementing" && t.state !== "ready") return taskView(t, o);
  // spec.md section 6.20.14: the changed plan of "Add to plan" waits for the approval before a new part starts.
  if (t.plan?.adding)
    return {
      status: addPlanSentence(t),
      detail: null,
      lines: [],
      needsYou: true,
      running: false,
      primary: { kind: "approve", label: "Approve the changed plan" },
      more: [read],
      screen: "plan",
    };
  const p = focus ?? defaultFocus(t);
  if (!p) return taskView(t, o);
  const name = partLabel(t, p);
  const extra = [trackerMove(o.tracker), read];
  const withExtra = (v: TaskView): TaskView => ({ ...v, more: [...v.more.filter((a) => a.kind !== "close"), ...extra] });
  // The task stays in implementing while another part builds or waits. The view of a part with a PR reads like a task in ready, and
  // the loop work on another part is not the work of this part.
  const run = runningStep(t);
  const narrow: TaskDto = {
    ...t,
    working: t.working && (run ? run.part === p.id : p.state === "implementing"),
    parts: [p],
    bases: p.bases,
    prs: t.prs.filter((r) => r.part === p.id),
  };
  const base = { detail: null, lines: [], needsYou: false, running: false } satisfies Partial<TaskView>;
  const goPr: Action = { kind: "go-pr", label: "Go to the PR" };
  const drop: Action = { kind: "drop", label: "Drop this sub-task" };
  const b = t.blocked;
  const bp = blockedPart(t);
  if (b && (bp === p.id || bp === null)) {
    // design.md Q67: a part on a part that changes another repository waits before its build.
    if (p.state === "planned" && b.kind === "error" && b.step === null)
      return {
        ...base,
        status: b.text,
        primary: { kind: "wait-merge", label: "Wait for the merge" },
        more: [STOP],
        screen: "build",
        needsYou: true,
      };
    return withExtra(taskView(narrow, { ...o, name }));
  }
  if (run && run.part === p.id) return withExtra(taskView(narrow, { ...o, name }));
  switch (p.state) {
    case "planned": {
      const row = partRow(t, p, o);
      const acts = [...(row.action && row.action.kind !== "drop" ? [row.action] : []), drop];
      return { ...base, status: `${name}: ${row.text}`, primary: null, more: [...acts, ...extra], screen: "build" };
    }
    case "implementing":
      return {
        ...base,
        status: `${o.runner} builds ${name}.`,
        primary: null,
        more: [{ kind: "pause", label: "Pause after this step" }, STOP],
        screen: "build",
        running: true,
      };
    case "merged":
    case "abandoned":
      return { ...base, status: `${name}: ${p.state === "merged" ? "merged" : "dropped"}.`, primary: null, more: extra, screen: "pr" };
    case "declined":
      return {
        ...base,
        status: `${name}: the PR was declined${p.adopted ? " outside the app" : ""}.`,
        primary: null,
        more: [drop, ...extra],
        screen: "pr",
        needsYou: true,
      };
  }
  const lower = lowerAction(t, p);
  if (lower)
    return {
      ...base,
      status: lower.status,
      detail: lowerHow(t, p, o.forge),
      primary: lower.action,
      more: [{ kind: "show-diff", label: "Show the diff" }, ...(p.remotePr !== null ? [goPr] : []), ...extra],
      screen: p.remotePr !== null ? "pr" : "ready",
      needsYou: true,
    };
  if (p.adopted) return { ...base, status: `${name}: ${partRow(t, p, o).text}`, primary: goPr, more: extra, screen: "pr" };
  // spec.md section 6.20.10: commits after the push go to the server only on this click.
  if (newCommits(p))
    return {
      ...base,
      status: `${name} has new commits that are not on the server yet.`,
      primary: { kind: "push", label: `Push to ${p.branch}` },
      more: [{ kind: "show-diff", label: "Show the diff" }, goPr, ...extra],
      screen: "pr",
      needsYou: true,
    };
  if (p.state === "changes_requested")
    return {
      ...base,
      status: `${name}: ${partRow(t, p, o).text} Tell ${o.runner} what to change.`,
      primary: { kind: "tell", label: `Tell ${o.runner}` },
      more: [goPr, ...extra],
      screen: "pr",
      needsYou: true,
    };
  const v = withExtra(taskView({ ...narrow, state: WITH_PR.has(p.state) ? "ready" : t.state }, { ...o, name }));
  // A part that waits for colleagues says so in the words of its row.
  return v.screen === "pr" && !v.needsYou && v.lines.length === 0 ? { ...v, status: `${name}: ${partRow(t, p, o).text}` } : v;
}

// ---------- The plan of a task with sub-tasks (spec.md section 6.20.5) ----------

// START_MODES[1]: the part starts on top of the branch of another part. The UI words for it are "on top of" and "builds on".
export const ON_TOP: StartMode = START_MODES[1];

type Start = NonNullable<TaskDto["plan"]>["starts"][number];
// The start of a plan part on the plan screen. after: a part number such as "2", or the key of a tracked sub-task.
export type StartPick = { n: number; start: StartMode; after: string | null; existing?: "continue" | "new" };

export const livePlan = (t: Pick<TaskDto, "plan">) => (t.plan?.starts ?? []).filter((s) => !s.skip);

// "ABC-12", or "ABC-13 (2 of 2)" for part k of a split sub-task, as the server names a plan part.
export function startLabel(s: Pick<Start, "n" | "keys">, live: Pick<Start, "n" | "keys">[]): string {
  const key = s.keys[0];
  if (key === undefined) return `Part ${s.n}`;
  const twins = live.filter((x) => x.keys[0] === key);
  const name = s.keys.join(", ");
  return twins.length > 1 ? `${name} (${twins.findIndex((x) => x.n === s.n) + 1} of ${twins.length})` : name;
}

type FoundPr = Extract<FoundItem, { kind: "pr" }>;
type FoundBranch = Extract<FoundItem, { kind: "branch" }>;
// The PRs and branches that name a sub-task (spec.md section 6.20.2).
export const openPrs = (s: Pick<SubtaskDto, "found">) => s.found.filter((f): f is FoundPr => f.kind === "pr" && f.state === "OPEN");
export const mergedPr = (s: Pick<SubtaskDto, "found">) =>
  s.found.find((f): f is FoundPr => f.kind === "pr" && f.state === "MERGED") ?? null;
export const foundBranch = (s: Pick<SubtaskDto, "found">) => s.found.find((f): f is FoundBranch => f.kind === "branch") ?? null;

// The sub-tasks with a tracked open PR. A plan part can build on them or start after them.
export const trackedKeys = (t: Pick<TaskDto, "subtasks">) =>
  (t.subtasks ?? []).filter((s) => s.category !== "done" && openPrs(s).length > 0).map((s) => s.key);

// The starts of the plan as the runner proposed them.
export function firstStarts(t: Pick<TaskDto, "plan">): StartPick[] {
  return livePlan(t).map((s) => ({ n: s.n, start: s.start, after: s.start === "base" ? null : s.after }));
}

// The first cycle of the picked starts, as the sentence of the server: "ABC-13 cannot build on ABC-14, because ABC-14 builds on ABC-13."
export function startCycle(picks: StartPick[], live: Pick<Start, "n" | "keys">[]): string | null {
  const lower = (p: StartPick) =>
    p.start !== "base" && p.after !== null && /^\d+$/.test(p.after) ? picks.find((x) => x.n === Number(p.after)) : undefined;
  const label = (p: StartPick) => startLabel(live.find((s) => s.n === p.n) ?? { n: p.n, keys: [] }, live);
  for (const p of picks) {
    const seen = new Set<number>([p.n]);
    for (let x = lower(p); x; x = lower(x)) {
      if (x.n === p.n) {
        const b = lower(p) as StartPick;
        return `${label(p)} cannot build on ${label(b)}, because ${label(b)} builds on ${label(p)}.`;
      }
      if (seen.has(x.n)) break;
      seen.add(x.n);
    }
  }
  return null;
}

// spec.md section 6.20.6: the planned branch of a plan part. Part k of a split sub-task gets the part form of the name.
export function startBranch(prefix: string, s: Pick<Start, "n" | "keys" | "title">, live: Pick<Start, "n" | "keys">[], summary: string) {
  const key = s.keys[0] ?? "";
  const twins = live.filter((x) => x.keys[0] === key);
  const title = summary || s.title;
  return twins.length > 1
    ? branchName(prefix, key, { kind: "part", n: twins.findIndex((x) => x.n === s.n) + 1, title })
    : branchName(prefix, key, { kind: "small", title });
}

// spec.md section 6.20.2: "Continue on <branch>" needs the key of the part and the push name rule (<prefix><KEY>-).
export const continuable = (prefix: string, key: string, branch: string) => branch.startsWith(`${prefix}${key}-`);
