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
  branchPrefix,
  fileOnly,
  listedKind,
  listedOnly,
  RUN_TEXT_BYTES,
  type TaskDto,
  type TaskPartDto,
  type TaskPrDto,
  type TaskQuestionDto,
  type TaskRepoDto,
  type TaskRowDto,
  type TaskStepDto,
} from "../../shared/dto";
import { branchName, type RepoAccess, type TaskSize } from "../../shared/task";
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
  | "close";
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

// The repositories that the update would change: a base with new commits, or a PR that the server reports with conflicts.
export const movedBases = (t: Pick<TaskDto, "bases">) => t.bases.filter((b) => b.newCommits > 0 || b.conflicted);

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
      const news = [...(b.newCommits > 0 ? [plural(b.newCommits, "new commit")] : []), ...(b.conflicted ? ["the PR has conflicts"] : [])];
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
export function taskView(t: TaskDto, o: { runner: string; forge: string; now: number; newest?: number | null }): TaskView {
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
        // spec.md section 6.16.7: the sentence says what to fix on the forge. The base and the prefix change only before the build
        // (tasks.ts base), so every pre-flight reason gets "Try again", which runs the checks again.
        return blocked({ kind: "resume", label: "Try again" }, [STOP]);
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
    return wait(
      n > 1 ? `Part ${part.ord} of ${n} is ready and checked by ${R}.` : `Your change is ready and checked by ${R}.`,
      { kind: "open-pr", label: n > 1 ? `Open PR for part ${part.ord} of ${n}` : "Open the PR" },
      more,
      "ready",
      true,
    );
  }

  const of = prs.length > 1 && last ? ` of part ${last.ord}` : "";
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
  const allOpen = rows.length > 1 && rows.every((r) => r.state === "pr_open");
  const waiting = `${allOpen ? `All ${rows.length} PRs are open. ` : ""}Waiting for ${waitingFor(last?.waiting ?? [])}${of}.`;
  if (update && moved) return wait(`${waiting} ${baseNews(t)}.`, goPr, [update, CLOSE], "pr", false);
  return wait(`${waiting} Nothing to do.`, goPr, [CLOSE], "pr", false);
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
