// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Task view model (docs/plans/review-v2/spec.md sections 6.12 and 7): one status sentence that names who acts or what the app
// waits for, at most one primary action, and the More actions, per state. Pure: tests/web/tasks-model.test.ts has one test per row.
// runner: the short name of the CLI from meta, because UI code names no product (tests/ui/names.test.ts).
import { indentBlock, oneLine } from "../../shared/consult";
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
  type TaskStepDto,
} from "../../shared/dto";
import {
  branchName,
  type FoundItem,
  PART_STATE_TEXT,
  PATCH_LOST,
  type PlanProblem,
  type PlanSeverity,
  REASON_EXITS,
  type RepoAccess,
  START_MODES,
  type StartMode,
  type TaskBlocked,
  type TaskSize,
} from "../../shared/task";
import { phaseRow, type RowPhase, rowPhase } from "../../shared/task-status";
import { namedBuild } from "../pr/build";
import { attachmentRows, sizeText } from "../review/tasks";
import type { TaskAction } from "./data";

export type ActionKind =
  | "answer"
  | "recommended"
  | "approve"
  | "edit-plan"
  | "change-size"
  | "stop"
  | "resume"
  | "see-why"
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
  // spec.md section 6.7: "Run setup again" on the part that the view shows. ps5-plan.md D2: the resume option setup with the part.
  | "setup"
  // spec.md section 6.7: "Change the time limit" of a setup command that reached its time limit.
  | "time-limit"
  // spec.md section 6.21.4: "Continue" sends the choice for each command that the step asks to allow.
  | "allow"
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
  | "add-plan"
  // ps5-plan.md section 4.2: Hold, Continue with part, Skip, and Start again act on the part of the action.
  | "hold"
  | "continue-part"
  | "skip"
  | "restart"
  // ps5-plan.md section 4.3: resume option disarm.
  | "cancel-resume"
  // ps5-plan.md sections 3 and 4.5: the resume options without ("Go on without these fixes") and leave ("Leave it", ready only).
  | "without"
  | "leave"
  // ps6-ps7-plan.md section 4, PS6-C: the PR comments of a task PR. sort-comments starts the reply run of the PR, send-comments sends the
  // Fix groups to the part session, push-post pushes and then posts the accepted replies, and post-replies posts them.
  | "sort-comments"
  | "send-comments"
  | "push-post"
  | "post-replies";
// part: the task_part ID of an action that acts on one part. Absent: the part that the view shows.
export type Action = { kind: ActionKind; label: string; part?: number };

// The request of an action that sends at once. part: the part of the action. null: the action opens a form, a dialog, or a tab first,
// or it needs a part (TaskView.tsx run).
export function sendOf(kind: ActionKind, part: number | null): TaskAction | null {
  switch (kind) {
    case "stop":
    case "close":
    case "resume":
      return { kind };
    case "without":
    case "leave":
      return { kind: "resume", option: kind };
    case "cancel-resume":
      return { kind: "resume", option: "disarm" };
    case "continue-part":
      return part === null ? null : { kind: "resume", part };
    case "setup":
      return part === null ? null : { kind: "resume", option: "setup", part };
    case "hold":
    case "push":
      return part === null ? null : { kind, part };
    default:
      return null;
  }
}

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
  medium: "Medium: one PR with the plan and the code.",
  large: "Large: the code comes in small PRs, one after another.",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STOP: Action = { kind: "stop", label: "Stop" };
const CLOSE: Action = { kind: "close", label: "Close the task" };
// The part states with a worktree (server tasks.ts HAS_WORKTREE).
const HAS_WORKTREE = new Set<TaskPartDto["state"]>(["implementing", "self_reviewed", "pr_open", "changes_requested", "approved"]);

// spec.md section 6.7: "Run setup again" for a part with a worktree while nothing runs. It stands before Stop and Close the task.
// spec.md section 6.25.5: a part with a waiting reason gets no "Run setup again". loop.ts setupAgainOf refuses a reason of the task,
// except a red setup of this part.
export function withSetup(t: Pick<TaskDto, "canSetup" | "blocked" | "steps">, part: TaskPartDto | null, v: TaskView): TaskView {
  if (!t.canSetup || v.running || !part || part.adopted || part.blocked || !HAS_WORKTREE.has(part.state)) return v;
  const b = t.blocked;
  if (b && !(b.kind === "red" && blockedPart(t) === part.id && t.steps.find((s) => s.id === b.step)?.item === "setup")) return v;
  const at = v.more.findIndex((a) => a.kind === "stop" || a.kind === "close");
  const more = [...v.more];
  more.splice(at < 0 ? more.length : at, 0, { kind: "setup", label: "Run setup again" });
  return { ...v, more };
}

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
// Each loop question has its own round, and one answer submit takes every open loop question (spec.md section 6.25.4).
export const openQuestions = (t: Pick<TaskDto, "questions">, source: TaskQuestionDto["source"]): TaskQuestionDto[] => {
  const open = t.questions.filter((q) => q.source === source && q.answer === null);
  if (source === "loop") return open;
  const round = Math.max(0, ...open.map((q) => q.round));
  return open.filter((q) => q.round === round);
};
// The step that runs or waits for the run slot. A message that waits beside a run row is not it (shared/task-status.ts phaseRow).
export const runningStep = (t: Pick<TaskDto, "steps">): TaskStepDto | null => phaseRow(t.steps);
// The open step row of one part. Parts of a task with sub-tasks can build at the same time.
const partStep = (t: Pick<TaskDto, "steps">, part: number): TaskStepDto | null => phaseRow(t.steps, part);
// ps5-plan.md section 4.4: a push-back question can wait in ready too, so both states read the loop questions.
export const questionSource = (t: Pick<TaskDto, "state">): TaskQuestionDto["source"] =>
  t.state === "implementing" || t.state === "ready" ? "loop" : "interview";

// ps5-plan.md section 4.4: a push-back question (point set) has no recommended option, and its answer needs an option.
export const recommendedOf = (q: TaskQuestionDto) => (q.kind === "choice" && q.point === null ? q.recommended : null);

// The open questions as Markdown for another AI session (Copy as Markdown, Save .md). The AI wrote the question text, so each
// field stays on one line; the summary is an indented block. It marks the recommended option as the form does.
export function questionsMarkdown(
  t: Pick<TaskDto, "key" | "title">,
  questions: TaskQuestionDto[],
  o: { summary?: string | null; label?: (q: TaskQuestionDto) => string | null } = {},
): string {
  const out = [
    `# Open questions: ${oneLine(t.key)} ${oneLine(t.title)}`,
    "",
    "Answer each question below. For a question with options, pick one option by its number, or write your own answer. Give the reason for each answer. Name the files, lines, or facts that support it. If you cannot answer a question, say so and say what is missing.",
    "",
  ];
  if (o.summary?.trim()) out.push("## Summary of the task", "", indentBlock(o.summary.trim()), "");
  questions.forEach((q, i) => {
    const part = o.label?.(q);
    out.push(`## Question ${i + 1}: ${oneLine(q.text)}`, "");
    if (part) out.push(`Part: ${oneLine(part)}`, "");
    if (q.point) {
      if (q.point.check) out.push(`- Check: ${oneLine(q.point.check)}`);
      out.push(
        `- Reason: ${oneLine(q.point.reason)}`,
        `- Proof: ${q.point.cite ? `\`${oneLine(q.point.cite).replaceAll("`", "'")}\`` : "none"}`,
      );
      if (!q.point.citeFound) out.push("- The app did not find this place in the code or the plan.");
    } else out.push(`Why it matters: ${oneLine(q.why)}`);
    out.push("");
    if (q.kind === "choice") {
      const rec = recommendedOf(q);
      q.options.forEach((x, k) => {
        const detail = x.detail.trim() ? ` — ${oneLine(x.detail)}` : "";
        out.push(`${k + 1}. ${oneLine(x.label)}${detail}${rec === k ? " (recommended)" : ""}`);
      });
    } else out.push("This question needs a written answer.");
    out.push("");
  });
  return out.join("\n");
}

// The part that the build works on or that waits for its PR: the first code part that did not merge or drop out.
export function currentPart(t: Pick<TaskDto, "parts">): TaskPartDto | null {
  return codeParts(t).find((p) => p.state !== "merged" && p.state !== "abandoned" && p.state !== "declined") ?? null;
}

// " for part 2" when the task has more than one code part. A small task speaks of "your change".
function partWords(t: TaskDto, part: number | null) {
  return part !== null && codeParts(t).length > 1 ? ` for part ${part}` : "";
}

// ---------- Hold, Start again, and the usage limit (ps5-plan.md sections 3, 4.2, and 4.3) ----------

// self-approved-plans.md section 5.1: the task builds its plan as several PRs on the part engine (server tasks.ts partsPlan).
export const partsPlan = (t: Pick<TaskDto, "subtasks" | "size" | "settings">) =>
  t.subtasks !== null || (t.size === "large" && t.settings.planReview === "self");

// self-approved-plans.md section 3.1: the "Plan review" choice shows for a large plan of a task without sub-tasks.
export const reviewChoice = (t: Pick<TaskDto, "subtasks">, size: TaskSize) => size === "large" && t.subtasks === null;

// The header count of a parts plan (self-approved-plans.md section 5.1). null: one PR, so the header shows the size.
export function partsHeader(t: Pick<TaskDto, "subtasks" | "size" | "settings" | "parts">): string | null {
  if (t.subtasks !== null) return `Sub-tasks: ${t.subtasks.length}, one PR each`;
  return partsPlan(t) ? `Parts: ${codeParts(t).length}, one PR each` : null;
}

// spec.md section 6.20.6: a part of a parts plan targets its own base, the branch of its lower part or the task base.
export const prTarget = (t: Pick<TaskDto, "subtasks" | "size" | "settings" | "targetBranch">, p: Pick<TaskPartDto, "baseBranch">) =>
  partsPlan(t) ? p.baseBranch : t.targetBranch;

// <ref> of a part: the part label in a parts plan, "part k" with several parts, else "your change".
export function partRef(
  t: Pick<TaskDto, "key" | "parts" | "subtasks" | "size" | "settings">,
  p: Pick<TaskPartDto, "id" | "ord" | "keys">,
): string {
  if (partsPlan(t)) return partLabel(t, p);
  return codeParts(t).length > 1 ? `part ${p.ord}` : "your change";
}
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The server restarts only an unpushed part in these part states, in a task that implements or stopped (loop.ts restart).
const RESTARTS = new Set<TaskPartDto["state"]>(["implementing", "self_reviewed"]);
export const unpushed = (t: Pick<TaskDto, "prs">, p: Pick<TaskPartDto, "id" | "pushed">) =>
  p.pushed === null && !t.prs.some((r) => r.part === p.id && r.pushed !== null);
const restartable = (t: TaskDto, p: TaskPartDto) =>
  (t.state === "implementing" || t.state === "stopped") && RESTARTS.has(p.state) && unpushed(t, p);
// The REASON_EXITS keys whose More holds "Start this part again". A reason with no cause has no key there.
const AGAIN_ROUTE = "POST /tasks/:id/parts/:part/restart";
const AGAIN_KEYS = new Set(
  Object.entries(REASON_EXITS)
    .filter(([, e]) => e.other.some((x) => "route" in x && x.route === AGAIN_ROUTE))
    .map(([key]) => key),
);
const reasonKey = (b: Pick<TaskBlocked, "kind" | "cause">) => (b.cause ? `${b.kind}/${b.cause}` : b.kind);
const holdOf = (part: number | null): Action[] => (part === null ? [] : [{ kind: "hold", label: "Hold", part }]);
const againOf = (t: TaskDto, p: TaskPartDto): Action[] =>
  restartable(t, p) ? [{ kind: "restart", label: "Start this part again", part: p.id }] : [];

// The On hold row. A stopped task offers Close the task, because the server refuses Stop there.
function heldView(t: TaskDto, p: TaskPartDto): TaskView {
  return {
    status: `${upper(partRef(t, p))} is on hold. Its work is kept.`,
    detail: null,
    lines: [],
    primary: { kind: "continue-part", label: "Continue", part: p.id },
    more: [
      ...(partsPlan(t) ? [{ kind: "skip" as const, label: "Skip this part", part: p.id }] : []),
      ...againOf(t, p),
      t.state === "stopped" ? CLOSE : STOP,
    ],
    screen: "build",
    needsYou: t.state === "stopped",
    running: false,
  };
}

// The reset time of a usage limit: the time only on the same day, else the date and the time.
export function resetText(ms: number, now: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// The status of a usage reason, from resumeAt and armed only (ps5-plan.md D9).
export function usageStatus(b: Pick<TaskBlocked, "resumeAt" | "armed">, runner: string, now: number): string {
  const at = b.resumeAt;
  if (b.armed) return at !== undefined && now < at ? `${runner} resumes at ${resetText(at, now)}.` : `${runner} resumes now.`;
  return `Your ${runner} usage limit is reached.${at === undefined ? "" : ` It resets at ${resetText(at, now)}.`}`;
}

function usageView(b: TaskBlocked, runner: string, now: number): TaskView {
  const at = b.resumeAt;
  const primary: Action = { kind: "resume", label: at !== undefined && now < at ? `Resume at ${resetText(at, now)}` : "Resume" };
  return {
    status: usageStatus(b, runner, now),
    detail: null,
    lines: [],
    primary: b.armed ? null : primary,
    more: b.armed ? [{ kind: "cancel-resume", label: "Cancel the resume" }, STOP] : [STOP],
    screen: "build",
    needsYou: !b.armed,
    running: false,
  };
}

// The clock of the Task view runs while a step runs, and while a usage reason waits, so the label changes at the reset time.
export const ticks = (t: Pick<TaskDto, "steps" | "blocked" | "parts">) =>
  runningStep(t) !== null || [t.blocked, ...t.parts.map((p) => p.blocked)].some((b) => b?.kind === "usage");

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

// ps4-plan.md WP-7: a send that has not run yet. A message that waits beside a run row of its part, or a send that waits for the run slot.
export const unstarted = (s: Pick<TaskStepDto, "state" | "run">) => s.state === "waiting" && s.run === null;

// The rows of the Log tab, newest first: each send with its steps in one group (spec.md section 6.18.1, Step history). The steps of a send
// come from its run, so a send with no run owns no row: the rows after a waiting message belong to the run beside it.
export function logRows(steps: TaskStepDto[]): LogRow[] {
  const out: LogRow[] = [];
  let g: SendGroup | null = null;
  for (const s of steps.toReversed()) {
    if (s.kind === "instruct") {
      g = { send: s, steps: [] };
      out.push(g);
    } else if (g && g.send.run !== null && s.part === g.send.part && (s.item === g.send.item || s.item === "review")) g.steps.unshift(s);
    else {
      g = null;
      out.push({ step: s });
    }
  }
  return out.reverse();
}

// ps5-plan.md section 4.8: the runs of one session of a part, with the rows of that part between them. part: the task_part ID.
export type SessionGroup = { part: number; rows: LogRow[] };
export type SessionRow = LogRow | SessionGroup;
const rowSteps = (r: LogRow) => ("send" in r ? [r.send, ...r.steps] : [r.step]);

// A second pass over logRows for the Log tab only. activeSend and sendNote read the send groups of logRows. A run with a new session
// starts a group of its part. The session ID cannot group the runs, because each resume forks a new ID. A group sits at the place of
// its newest row.
export function sessionRows(rows: LogRow[]): SessionRow[] {
  const out: SessionRow[] = [];
  const open = new Map<number, SessionGroup>();
  for (const r of rows.toReversed()) {
    const part = rowSteps(r)[0]?.part ?? null;
    let g = part === null ? undefined : open.get(part);
    if (part !== null && rowSteps(r).some((s) => s.detail.session?.resumed === false)) {
      g = { part, rows: [] };
      open.set(part, g);
    }
    if (!g) {
      out.push(r);
      continue;
    }
    g.rows.unshift(r);
    const at = out.indexOf(g);
    if (at >= 0) out.splice(at, 1);
    out.push(g);
  }
  return out.reverse();
}

// "<runner> session of part 2", or "<runner> session" in a task with one part.
export function sessionTitle(t: Pick<TaskDto, "parts">, g: SessionGroup, runner: string): string {
  const ord = t.parts.find((p) => p.id === g.part)?.ord;
  return ord !== undefined && codeParts(t).length > 1 ? `${runner} session of part ${ord}` : `${runner} session`;
}
export const sessionRuns = (g: SessionGroup) => g.rows.flatMap(rowSteps).filter((s) => s.detail.session !== null).length;
// The session line of a run in the Log tab, or null for a step without a session.
export function sessionNote(s: Pick<TaskStepDto, "detail">): string | null {
  const x = s.detail.session;
  if (!x) return null;
  if (x.resumed) return "Resumed";
  return x.why ? `New session: ${x.why}` : "New session";
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

// spec.md section 6.18.1: a stopped or failed send gives its text back to the box. A later send of the part replaces it. part: the part of
// the box. A Stop ends the waiting message of each part (ps4-plan.md WP-7), so each box gets the text of its own part back.
// Only a message gives its text back: the text of a comment run is the app's own line (ps6-ps7-plan.md section 1 item 1).
export function stoppedSend(t: Pick<TaskDto, "steps">, part: number | null = null): { id: number; text: string } | null {
  const s = t.steps.find((x) => x.kind === "instruct" && (part === null || x.part === part));
  const i = s?.detail.instruct;
  return s && i && i.purpose === "message" && (i.result === "stopped" || i.result === "failed") ? { id: s.id, text: i.text } : null;
}

// The send is a comment run of a task PR (ps6-ps7-plan.md section 1 item 1).
export const isComments = (s: Pick<TaskStepDto, "detail">) => s.detail.instruct?.purpose === "comments";

// "1 fixed, 1 pushed back" of a comment run, or null before its verdicts.
export function verdictText(s: Pick<TaskStepDto, "detail">): string | null {
  const v = s.detail.instruct?.comments?.verdicts;
  if (!v?.length) return null;
  const fixed = v.filter((x) => x.verdict === "fixed").length;
  return [...(fixed ? [`${fixed} fixed`] : []), ...(v.length - fixed ? [`${v.length - fixed} pushed back`] : [])].join(", ");
}

// spec.md section 6.18.1: the sentence of a stop or a failure of the newest send of the part ("Stopped. Your instructions changed nothing.
// The text is back in the box."), while nothing newer ran.
function sendNote(t: TaskDto, part: number | null, runner: string): string | null {
  const first = logRows(t.steps.filter((s) => part === null || s.part === part))[0];
  if (!first || !("send" in first)) return null;
  const r = first.send.detail.instruct?.result;
  if (r !== "stopped" && r !== "failed") return null;
  // tasks.ts SEND_STOPPED says that the text is back in the box, which holds only for a message.
  if (r === "stopped" && isComments(first.send) && first.send.run === null) return `Stopped. The PR comments did not go to ${runner}.`;
  return first.send.detail.notes.at(-1) ?? null;
}

// The Log tab result of a send (spec.md section 6.18.1, Step history).
export function sendResult(g: SendGroup, runner: string): string {
  const v = verdictText(g.send);
  const text = sendEnd(g, runner);
  return v ? `${text} Comments: ${v}.` : text;
}
function sendEnd(g: SendGroup, runner: string): string {
  const i = g.send.detail.instruct;
  switch (i?.result) {
    case "done": {
      const files = g.steps.find((s) => s.kind === "commit")?.detail.diffStat?.files ?? g.send.detail.diffStat?.files ?? 0;
      const checked = g.steps.some((s) => s.kind === "review" && s.state === "ok") ? ` Checked by ${runner}.` : "";
      return `Done: ${plural(files, "file")} changed. Checks green.${checked}`;
    }
    case "no_change":
      return g.send.detail.summary ? `${runner} changed no file: ${g.send.detail.summary}` : `${runner} changed no file.`;
    case "stopped":
      return "Stopped";
    case "failed":
      return g.send.detail.notes.findLast((n) => n.startsWith("Failed: ")) ?? "Failed";
    default: {
      if (unstarted(g.send)) return STEP_TEXT.waiting;
      const open = [g.send, ...g.steps].some((s) => s.state === "running" || s.state === "waiting");
      return open ? STEP_TEXT.running : STEP_TEXT[stepLook(g.send)];
    }
  }
}

// spec.md section 6.18.1 and part-session.md section 2.9: the Tell box of a part with a worktree, also in its first build. none: no box.
// open: a send starts a run of the part. live: a send goes into the session run of the part now. queued: a send waits for the next run
// of the part. busy: the checks or another run work; the box keeps its text and waits. tasks.ts instructTarget and loop.ts instructRun
// have the same rules on the server.
export type TellBox = "none" | "open" | "live" | "queued" | "busy";
const BOX_REASONS = new Set<NonNullable<TaskDto["blocked"]>["kind"]>(["red", "size", "blocker", "denied_path", "update"]);
export function tellBox(t: TaskDto): TellBox {
  // spec.md section 6.25.5: no box while the reason of a part waits behind the first one.
  if ((t.state !== "implementing" && t.state !== "ready") || t.queued > 0) return "none";
  const b = t.blocked;
  if (b && !BOX_REASONS.has(b.kind)) return "none";
  const part = currentPart(t);
  // A held part goes on by Continue only. The app never changes the branch of a tracked PR.
  if (!part || !HAS_WORKTREE.has(part.state) || part.blocked || part.adopted) return "none";
  if (part.instructRun) return part.instructRun;
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

// ps5-plan.md section 3: what a working part does, by the stage of its open row. ref: "your change", "part 2", or the part label of a
// sub-task. Without ref, the short text of a sub-task row, with no try count. null: the stage has no text of its own. AC-B368: the done
// tasks of the part, and the try or round of a fix row (StepDetail.tries).
function workText(
  t: Pick<TaskDto, "docs" | "steps" | "parts" | "subtasks" | "size" | "settings">,
  s: TaskStepDto,
  runner: string,
  ref?: string,
): string | null {
  const of = ref ? ` of ${ref}` : "";
  const forRef = ref ? ` for ${ref}` : "";
  const tries = ref ? s.detail.tries : null;
  switch (rowPhase(s)) {
    case "building": {
      const tasks = plannedTasks(t, t.parts.find((p) => p.id === s.part) ?? null);
      const done = tasks.length ? `: ${tasks.filter((k) => k.done).length} of ${tasks.length} tasks done` : "";
      return `${runner} builds ${ref ?? "it"}${done}.`;
    }
    case "checking":
      return `The app runs the checks${of}.`;
    case "fixing":
      return `${runner} fixes the checks${of}${tries ? ` (try ${tries.n} of ${tries.of})` : ""}.`;
    case "critic":
    case "reviewing":
      return `A second ${runner} run reviews ${ref ?? "it"}.`;
    case "judging":
      return `${runner} works on the review points${of}${tries ? ` (round ${tries.n} of ${tries.of})` : ""}.`;
    case "following":
      if (s.kind === "instruct")
        return isComments(s) ? `${runner} works on the PR comments${forRef}.` : `${runner} works on your instructions${forRef}.`;
      return s.item === "points"
        ? `${runner} fixes the listed points${of}.`
        : `${runner} fixes the review points that you chose to fix${forRef}.`;
    case "setup":
      return `The app runs the setup commands${of}.`;
    case "baseline":
      return `The app runs the checks on the base${of}.`;
    default:
      return null;
  }
}
// ps5-plan.md section 3: the stages whose working row offers Hold. The server holds only an open implement or fix row.
const HOLD_AT = new Set<RowPhase | null>(["building", "fixing", "judging"]);
// The stages where the app works and the runner waits.
const APP_AT = new Set<RowPhase | null>(["checking", "setup", "baseline"]);

// ps5-plan.md section 4.1: the badge of a working part in the Plan tab.
export const STAGE_TEXT: Record<RowPhase, string> = {
  building: "Building",
  checking: "The checks run",
  fixing: "Fixing the checks",
  critic: "Quick review",
  reviewing: "Own review",
  judging: "Review points",
  following: "Your instructions",
  setup: "Setup",
  baseline: "Checks on the base",
  updating: "Update",
  resolving: "Conflicts",
};
// The stage badge of a part, or null when no row of the part is open or the badge would repeat the part state.
export function stageBadge(t: Pick<TaskDto, "steps">, p: Pick<TaskPartDto, "id" | "state">): string | null {
  const s = partStep(t, p.id);
  const stage = s && rowPhase(s);
  const text = stage ? STAGE_TEXT[stage] : null;
  return text === PART_STATE_TEXT[p.state] ? null : text;
}

// "### [ ] T1.1 Title" lines of the tasks grammar (spec.md section 6.4) in the plan files of the task.
const TASK_LINE = /^### \[( |x)\] (T\d+\.\d+) (.+)$/gm;

// The tasks of the Plan tab. part: the tasks of one part. A task is done when the plan file ticks it, when an ok row lists it in
// detail.ticked (ps5-plan.md D5), or when an ok commit row of an old task has it as its item. A restart mark (commit item "restart")
// resets its part, so the rows of that part before its newest mark do not count. With sub-tasks, task_part.ord is the plan part number
// (tasks.ts partDocsOf), so a part lists only the tasks T<ord>. of its plan part. Without sub-tasks, the part builds the whole plan.
export function plannedTasks(
  t: Pick<TaskDto, "docs" | "steps" | "subtasks" | "size" | "settings"> & Partial<Pick<TaskDto, "external">>,
  part: Pick<TaskPartDto, "id" | "ord"> | null = null,
) {
  // docs/plans/task-builder-v2.md section 5.4: a task that the app moved to the checklist is no task of the runner.
  const moved = new Set((t.external ?? []).flatMap((x) => (x.planTask ? [x.planTask] : [])));
  const text = [t.docs?.plan, t.docs?.tasks].filter(Boolean).join("\n");
  const mark = new Map<number | null, number>();
  for (const s of t.steps) if (s.kind === "commit" && s.item === "restart") mark.set(s.part, Math.max(mark.get(s.part) ?? 0, s.id));
  const done = new Set(
    t.steps
      .filter((s) => s.state === "ok" && s.item !== "restart" && s.id > (mark.get(s.part) ?? 0) && (!part || s.part === part.id))
      .flatMap((s) => [...s.detail.ticked, ...(s.kind === "commit" && s.item ? [s.item] : [])]),
  );
  const prefix = part && partsPlan(t) ? `T${part.ord}.` : "";
  return [...text.matchAll(TASK_LINE)]
    .filter((m) => (m[2] as string).startsWith(prefix) && !moved.has(m[2] as string))
    .map((m) => ({ id: m[2] as string, title: (m[3] as string).trim(), done: m[1] === "x" || done.has(m[2] as string) }));
}

// part-session.md section 2.17: "Part 2 is ready: 5 tasks, 340 lines, checks green." A fact that the task does not know stays out. The
// checks gate leaves the newest check row of a ready part green; a repository without checks has no check row.
function readyText(t: TaskDto, p: TaskPartDto, who: string): string {
  const n = plannedTasks(t, p).length;
  const check = t.steps.find((s) => s.part === p.id && s.kind === "check" && s.item !== "setup" && s.item !== "base");
  const facts = [
    ...(n ? [plural(n, "task")] : []),
    ...(p.lines === null ? [] : [plural(p.lines, "line")]),
    ...(check?.state === "ok" ? ["checks green"] : []),
  ];
  return `${who} is ready${facts.length ? `: ${facts.join(", ")}` : ""}.`;
}

// ps5-plan.md section 4.6: the Build box shows the notes of the newest commit of the part, such as the size note. The restart mark is no
// commit.
export const readyNotes = (t: Pick<TaskDto, "steps">, part: Pick<TaskPartDto, "id"> | null): string[] =>
  (part && t.steps.find((s) => s.part === part.id && s.kind === "commit" && s.state === "ok" && s.item !== "restart")?.detail.notes) || [];

// ps5-plan.md D1: "Change the limit" shows while the part is over the line limit of the task (loop.ts budgetOf), and not after "Keep one
// PR" of an old size reason, because the size note then stays away (loop.ts sizeNote).
export function overLimit(t: Pick<TaskDto, "settings" | "plan">, part: Pick<TaskPartDto, "lines"> | null): boolean {
  const budget = t.settings.lineBudget ?? t.plan?.budget ?? null;
  return !t.settings.keepOnePr && budget !== null && part?.lines != null && part.lines > budget;
}

// ps5-plan.md section 4.7 (AC-B378): the line of a saved patch. PATCH_LOST marks a reset that saved no file, so no text names it as one.
// reason: the line under a denied_path reason, else the line of the Log tab. file: the patch path, shown as code between lead and tail.
export function patchText(patch: string, reason: boolean): { lead: string; file: string | null; tail: string } {
  const back = "The worktree went back to the last commit.";
  if (patch === PATCH_LOST)
    return reason
      ? { lead: `${back} The app could not save the changes as a patch. Continue starts a new run.`, file: null, tail: "" }
      : { lead: "The app could not save the changes of this step as a patch.", file: null, tail: "" };
  return reason
    ? { lead: `${back} The changes are saved in `, file: patch, tail: ". Continue starts a new run." }
    : { lead: "The changes of this step are saved in ", file: patch, tail: "." };
}

// One sentence for a running step: who works, and on what. name: the part label of a sub-task.
export function stepSentence(t: TaskDto, s: TaskStepDto, runner: string, name?: string): string {
  const ord = t.parts.find((p) => p.id === s.part)?.ord ?? null;
  const of = partWords(t, ord);
  // ps5-plan.md D4 maps each commit to the checks, but the pointer commit runs outside the build.
  if (s.kind === "commit" && s.item === "pointer") return `Pointing ${t.project}/${t.repo} at the merged commit.`;
  const work = workText(t, s, runner, name ?? (of ? `part ${ord}` : "your change"));
  if (work) return work;
  switch (s.kind) {
    case "update":
    case "resolve":
      return updateSentence(t, s, runner);
    case "interview":
      return `${runner} is reading the task and the code.`;
    case "spec":
      // spec.md section 6.22.9: the plan check run and its repair are spec steps with an item.
      if (s.item === "check") return checkingText(runner);
      if (s.item === "repair") return repairingText(t, runner);
      return `${runner} is writing the plan.`;
    case "replan":
      return `${runner} is writing the plan.`;
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
// spec.md section 6.22.9: the plan check and its repair are spec steps with an item.
const SPEC_ITEMS: Record<string, string> = { check: "checking the plan", repair: "writing the plan again" };
const doingOf = (s: TaskStepDto): string[] => {
  const d = (s.kind === "spec" && s.item ? SPEC_ITEMS[s.item] : undefined) ?? DOING[s.kind];
  return d ? [d] : [];
};

export function stoppedAt(t: TaskDto): string {
  const s = t.steps[0];
  if (!s) return "Stopped.";
  const ord = t.parts.find((p) => p.id === s.part)?.ord ?? null;
  const where = [
    ...(ord !== null && codeParts(t).length > 1 ? [`part ${ord}`] : []),
    ...(s.item && /^T\d/.test(s.item) ? [`task ${s.item}`] : []),
    ...(isComments(s) ? ["the PR comments"] : doingOf(s)),
  ];
  return where.length ? `Stopped at: ${where.join(", ")}.` : "Stopped.";
}

// ---------- The plan check (spec.md section 6.22.9) ----------

const checkingText = (runner: string) => `${runner} is checking the plan against the code.`;
const repairingText = (t: TaskDto, runner: string) =>
  `${runner} is writing the plan again to fix ${plural(t.plan?.check?.sent.length ?? 0, "problem")} of the check.`;

// The status while the check or its repair waits or runs, else null.
export function checkWaitText(t: TaskDto, runner: string): string | null {
  const c = t.plan?.check;
  return c?.state === "pending" ? checkingText(runner) : c?.state === "repairing" ? repairingText(t, runner) : null;
}

export const SEVERITY_WORD: Record<PlanSeverity, string> = { blocker: "Blocker", major: "Major", minor: "Minor", info: "Note" };

// "1 major, 2 minor": the counts by severity, the most severe first.
export function severityCounts(list: readonly Pick<PlanProblem, "severity">[]): string {
  return (["blocker", "major", "minor"] as const)
    .map((v) => [v, list.filter((p) => p.severity === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v}`)
    .join(", ");
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const STILL = "You can still approve the plan.";

// The check line of the plan screen. tab: false drops the pointer to the Plan tab (the Plan tab itself).
export function checkLine(t: TaskDto, runner: string, tab = true): string | null {
  const c = t.plan?.check;
  if (!c) return null;
  const more = (s: string) => (tab ? ` ${s}` : "");
  switch (c.state) {
    case "clean":
      return `${runner} checked the plan against the code and found no problem.`;
    case "shown": {
      const n = c.problems.length;
      const found = n
        ? `The plan check found ${plural(n, "problem")}: ${severityCounts(c.problems)}.${more("The Plan tab lists them.")}`
        : "";
      // spec.md section 6.22.6: a failed repair keeps the first plan, with its reason.
      const why = c.text ? `${sentence(c.text)} ${STILL}` : "";
      return [found, why].filter(Boolean).join(" ") || `${runner} checked the plan against the code and found no problem.`;
    }
    case "repaired":
      return `${runner} wrote the plan again to fix ${plural(c.sent.length, "problem")} of the check.${more("The Plan tab shows the result.")}`;
    case "failed":
      return `The plan check failed: ${sentence(c.text || "The run failed.")} ${STILL}`;
    case "stopped":
      return `You stopped the plan check. ${STILL}`;
    default:
      return null;
  }
}

// spec.md section 6.22.9: the app checks other than the missing map lines, without info. Each missing map line has one major check.
export function otherChecksLine(t: TaskDto, tab = true): string | null {
  const p = t.plan;
  if (!p) return null;
  const n = Math.max(0, p.checks.filter((c) => c.severity !== "info").length - p.missing);
  if (!n) return null;
  return `The app found ${plural(n, "other problem")} in the plan.${tab ? (n === 1 ? " The Plan tab lists it." : " The Plan tab lists them.") : ""}`;
}

// The label of a plan part in a problem: the first sub-task key in sub-task mode, else "Part n".
export function problemPart(t: TaskDto, part: number | null): string | null {
  if (part === null) return null;
  const key = t.subtasks ? t.plan?.starts.find((x) => x.n === part)?.keys[0] : undefined;
  return key ?? `Part ${part}`;
}

// The answer of the repair run to one sent problem.
export function repairAnswer(t: TaskDto, id: string, runner: string): string {
  const r = t.plan?.check?.repairs.find((x) => x.id === id);
  if (!r) return `${runner} gave no answer for this problem.`;
  return `${runner}: ${r.fixed ? "fixed." : "not changed."}${r.note ? ` ${r.note}` : ""}`;
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
// The setup command of a red reason that reached its time limit (spec.md section 6.7), or null.
export const timedOutSetup = (t: TaskDto) => {
  const s = t.blocked?.kind === "red" ? stepFor(t, t.blocked.step) : null;
  return (s?.item === "setup" && s.detail.commands.find((c) => c.timedOut)) || null;
};

// ---------- PR comments of a task PR (ps6-ps7-plan.md section 4, part-session.md section 2.14) ----------

// fix: the group goes to the part session. pushback and reply: the draft of the sort stays the answer, and nothing goes to the session.
export type CommentChoice = "fix" | "pushback" | "reply";
export type CommentPicks = Readonly<Record<number, CommentChoice>>;
type SortedGroup = NonNullable<NonNullable<TaskPartDto["comments"]>["sorted"]>["groups"][number];
// part-session.md section 2.14 step 3: Fix for valid and partly, Push back for invalid, Reply only for a question. A group with mixed
// judgements takes the first match in that order, so one thread that asks for a change makes the group Fix.
export function groupChoice(g: SortedGroup): CommentChoice {
  const j = new Set(g.threads.map((x) => x.judgement));
  return j.has("valid") || j.has("partly") ? "fix" : j.has("invalid") ? "pushback" : "reply";
}
export const choiceOf = (g: SortedGroup, picks: CommentPicks = {}) => picks[g.n] ?? groupChoice(g);
// The threads of the Fix groups, for POST /tasks/:id/parts/:part/comments.
export const fixThreads = (groups: readonly SortedGroup[], picks: CommentPicks = {}) =>
  groups.filter((g) => choiceOf(g, picks) === "fix").flatMap((g) => g.threads.map((x) => x.thread));

// forge: the short name of the code host from meta, for the conflict row (spec.md section 6.18.5). newest: the task_pr ID whose merge
// commit the forge did not name, after the user saw that 409; the pointer button then points at the newest base commit.
// name: the focused part of a task with sub-tasks, such as "ABC-12 (2 of 4)" (spec.md section 6.20.13). The ready sentences use it.
// picks: the choices of the user in the sorted comment groups (CommentGroups.tsx). Absent: the defaults of groupChoice.
export function taskView(
  t: TaskDto,
  o: { runner: string; forge: string; now: number; newest?: number | null; name?: string; picks?: CommentPicks },
): TaskView {
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
  // ps4-plan.md section 2.6: held stays in the part row, never in t.blocked, and comes before a slot wait or an open row. With sub-tasks,
  // subtaskView shows the hold of the focused part only.
  const held = !partsPlan(t) ? codeParts(t).find((p) => p.blocked?.kind === "held") : undefined;
  if (held && (t.state === "implementing" || t.state === "stopped")) return heldView(t, held);
  if (t.state === "stopped") {
    // ps5-plan.md section 3: a stop of the build names the part of its newest row and keeps the work. A stop before the build keeps the
    // stoppedAt text.
    const build = t.stoppedFrom === "implementing" || t.stoppedFrom === "ready";
    const at = build ? (codeParts(t).find((p) => p.id === t.steps.find((s) => s.part !== null)?.part) ?? currentPart(t)) : null;
    const many = partsPlan(t) || codeParts(t).length > 1;
    return {
      ...base,
      status: !at ? stoppedAt(t) : many ? `Stopped at ${partRef(t, at)}. The work is kept.` : "Stopped. The work is kept.",
      detail: b?.text ?? null,
      primary: { kind: "resume", label: "Continue" },
      more: [...(at ? againOf(t, at) : []), CLOSE],
      screen: "build",
      needsYou: true,
    };
  }

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
    // spec.md section 6.22.9: while the check or its repair waits or runs, the plan has no primary.
    const checking = checkWaitText(t, R);
    if (checking) return working(checking, [STOP], "plan");
    if (run) return working(stepSentence(t, run, R), [STOP], "plan");
    if (!t.plan) return working(`${R} is writing the plan.`, [STOP], "plan");
    return {
      ...base,
      // self-approved-plans.md section 6: a second approval of a plan that waits for a spec PR builds it.
      status: t.plan.approved
        ? "The plan waits for a spec PR, which this version cannot open. Approve it again to build it now."
        : planSentence(t),
      primary: { kind: "approve", label: "Approve the plan" },
      // spec.md section 6.1: a minimum of large leaves one size, and a task with sub-tasks shows no size.
      more: [
        { kind: "edit-plan", label: "Edit" },
        ...(t.plan.minimum !== "large" && t.subtasks === null && !t.plan.adding
          ? [{ kind: "change-size" as const, label: "Change size" }]
          : []),
        STOP,
      ],
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
    const open = t.external.filter((x) => x.state === "open").length;
    const merged = prs.length > 0 && prs.every((p) => p.prState === "MERGED" || p.state === "merged" || p.state === "abandoned");
    // docs/plans/task-builder-v2.md section 11.1: a merged task waits for its checklist. Each row has its own Done and Waive.
    if (merged && open)
      return {
        ...base,
        status: `${prs.length > 1 ? `All ${prs.length} PRs merged` : "The PR merged"}. Finish your checklist: ${open === 1 ? "1 step is" : `${open} steps are`} open.`,
        primary: null,
        more: [CLOSE],
        screen: "end",
        needsYou: true,
      };
    if (merged)
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
    if (b.kind === "usage") return usageView(b, R, o.now);
    const step = stepFor(t, b.step);
    // ps5-plan.md section 3, D8, and D9: the row follows the kind and the cause. Continue works in implementing and in ready (AC-B344).
    // REASON_EXITS RUN_ENDS and KEPT: "Start this part again" stands before See why and Stop.
    const owner = t.parts.find((x) => x.id === blockedPart(t)) ?? part;
    const again = owner && AGAIN_KEYS.has(reasonKey(b)) ? againOf(t, owner) : [];
    const why: Action[] = b.step === null ? [] : [{ kind: "see-why", label: "See why" }];
    // part-session.md section 9.4 rule 9: "Leave it" replaces Dismiss in ready. loop.ts leaveReason refuses only the reasons with their
    // own form (a plan change, an allow request, an open question), and resume refuses the slot wait.
    const leave: Action[] = t.state === "ready" ? [{ kind: "leave", label: "Leave it" }] : [];
    const go: Action = { kind: "resume", label: "Continue" };
    const blocked = (primary: Action | null, more: Action[], screen: Screen = "build"): TaskView => ({
      ...base,
      status: b.text,
      primary,
      more,
      screen,
      needsYou: true,
    });
    switch (b.kind) {
      case "red":
        if (timedOutSetup(t)) return blocked({ kind: "time-limit", label: "Change the time limit" }, [...why, go, STOP]);
        // task-builder-v2.md section 6.3: Continue runs the checks again and starts no fix run.
        if (b.cause === "check_env") return blocked({ kind: "resume", label: "Run the checks again" }, [...why, STOP, ...leave]);
        // spec.md section 6.18.3, Checks: red checks after an update offer "Undo the update".
        return blocked(go, [
          ...(t.canUndoUpdate ? [{ kind: "undo-update", label: "Undo the update" } as const] : []),
          ...again,
          ...why,
          STOP,
          ...leave,
        ]);
      case "blocker":
        return blocked(go, [{ kind: "without", label: "Go on without these fixes" }, ...why, STOP, ...leave]);
      case "question": {
        // check-fix.md: a question of the app, such as a fix step that changed no file, names its step. pushback.md: each push-back
        // question has its point.
        const open = openQuestions(t, "loop");
        if (!open.length) return blocked(go, [...again, ...why, STOP, ...leave]);
        const judge = open.every((q) => q.point !== null);
        const label = !judge ? "Answer the question" : open.length === 1 ? "Judge the push-back" : `Judge ${open.length} push-backs`;
        return blocked({ kind: "answer", label }, [STOP], "questions");
      }
      case "size":
        // loop.ts commit() sets size/large_repos for a large task only, and no large task builds yet (G13, WP-B8). So Stop is its only
        // exit. A legacy size reason takes the plain Continue row.
        return b.cause === "large_repos" ? blocked(STOP, []) : blocked(go, [...why, STOP, ...leave]);
      case "spec_change":
        return blocked({ kind: "review-change", label: "Review the change" }, [{ kind: "reject-change", label: "Reject" }, STOP], "change");
      case "slot":
        return { ...working(b.text, [STOP]), detail: step ? elapsed(o.now - step.startedAt) : null };
      case "preflight":
        // spec.md section 6.16.7: a base that is gone gets "Pick a base branch". Every other reason says what to fix on the forge, and
        // "Try again" runs the checks again.
        return b.base
          ? blocked({ kind: "pick-base", label: "Pick a base branch" }, [{ kind: "resume", label: "Try again" }, STOP, ...leave])
          : blocked({ kind: "resume", label: "Try again" }, [STOP, ...leave]);
      case "allow":
        // spec.md section 6.21.4: Continue of the reason gives 409 until each command has a choice, so "Continue" sends the choices.
        return blocked(t.allowAsk ? { kind: "allow", label: "Continue" } : null, [STOP]);
      case "update":
        // spec.md section 6.18.4: "The update from <base> stopped: <reason>. The branch is as it was." REASON_EXITS: no Stop.
        return blocked(
          { kind: "update", label: "Try again" },
          [...(hasPr ? [goPr] : [{ kind: "show-diff", label: "Show the diff" } as const]), ...leave],
          hasPr ? "pr" : "build",
        );
      default:
        // The other Needs-you reasons, and the legacy kinds budget and push: the sentence of the server and Continue.
        return blocked(go, [...again, ...why, STOP, ...leave]);
    }
  }
  const send = activeSend(t);
  // A send or an update ends by itself, and Hold applies to the build only. Hold needs an open row of the part.
  const stopOnly = !!send || t.state === "ready";
  if (run) return working(stepSentence(t, run, R, o.name), stopOnly || !HOLD_AT.has(rowPhase(run)) ? [STOP] : [...holdOf(run.part), STOP]);
  if (t.working || (t.state === "implementing" && part?.state !== "self_reviewed"))
    return working(t.working ? "The app prepares the next step." : `${R} is building your change.`, [STOP]);

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
  const detail =
    sendNote(t, part?.id ?? null, R) ??
    (asked && !moved ? `${R} asked for the newest ${label(t.bases)}. The branch already has it.` : null);
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
      ...(t.points.length ? [{ kind: "fix-points" as const, label: "Fix these too" }] : []),
      ...againOf(t, part),
    ];
    const asIs: Action = { kind: "open-pr", label: "Open the PR as is" };
    if (update && pickedStatus) return wait(pickedStatus, update, more, "ready", true);
    if (update && moved && askedStatus) return wait(askedStatus, update, [asIs, ...more], "ready", true);
    if (update && moved) return wait(`${baseNews(t)} since the branch point.`, update, [asIs, ...more], "ready", true);
    if (rows.length > 1)
      return wait(
        readyText(t, part, `Your change in ${rows.length} repositories`),
        { kind: "open-pr", label: `Open ${plural(rows.filter((r) => r.remotePr === null).length, "PR")}` },
        more,
        "ready",
        true,
      );
    if (o.name) return wait(readyText(t, part, o.name), { kind: "open-pr", label: "Open the PR" }, more, "ready", true);
    return wait(
      readyText(t, part, n > 1 ? `Part ${part.ord}` : "Your change"),
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
  // spec.md section 6.18.2, step 7: a commit after the push goes to the server only on the click of "Push to <branch>"
  // (POST /parts/:part/push, pr.ts pushNow).
  // ps6-ps7-plan.md section 2.1: the PR comments of a task PR. accepted: the reply drafts that the user accepted in the PR view.
  const c = part?.comments ?? null;
  const replies = (n: number) => plural(n, "reply", "replies");
  const waits = (n: number) => `${replies(n)} ${n === 1 ? "waits" : "wait"}.`;
  if (part?.pushed && part.head && part.head !== part.pushed) {
    const who = prs.length > 1 ? `Part ${part.ord}` : "Your change";
    const posts = c?.accepted ?? 0;
    return wait(
      `${who} has new commits that are not on the server yet.${posts ? ` ${waits(posts)}` : ""}`,
      posts ? { kind: "push-post", label: `Push and post ${replies(posts)}` } : { kind: "push", label: `Push to ${part.branch}` },
      [{ kind: "show-diff", label: "Show the diff" }, goPr, ...(update ? [update] : []), CLOSE],
      "pr",
      true,
    );
  }
  if (c?.accepted)
    return wait(waits(c.accepted), { kind: "post-replies", label: `Post ${replies(c.accepted)}` }, [goPr, CLOSE], "pr", true);
  // A sorted run whose drafts all posted or went has no group left, so the row falls through.
  if (c?.sorted?.groups.length) {
    const by = (k: CommentChoice) => c.sorted?.groups.filter((g) => choiceOf(g, o.picks) === k).length ?? 0;
    const [fix, back, reply] = [by("fix"), by("pushback"), by("reply")];
    const words = [
      ...(fix ? [`${plural(fix, "group")} to fix`] : []),
      ...(back ? [`${fix ? back : plural(back, "group")} to push back`] : []),
      ...(reply ? [`${fix || back ? reply : plural(reply, "group")} to answer`] : []),
    ];
    // part-session.md section 2.17 and ps6-ps7-plan.md section 10 item 4: the drafts of the sort post from the PR view.
    return wait(
      `${words.join(", ")}.`.replace(/^./, (x) => x.toUpperCase()),
      fix ? { kind: "send-comments", label: `Send ${plural(fix, "group")} to ${R}` } : goPr,
      fix ? [goPr, CLOSE] : [CLOSE],
      "pr",
      true,
    );
  }
  if (c?.turn) {
    const on = prs.length > 1 ? ` of part ${part?.ord}` : "";
    return wait(
      `${plural(c.turn, "comment")} on the PR${on} wait for you.`,
      { kind: "sort-comments", label: "Sort the comments" },
      [goPr, CLOSE],
      "pr",
      true,
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

export { rowStatus } from "../../shared/task-status";

// The state of a step in the Log tab. The checks of the tests step must fail (StepDetail.expectRed), so their red run is no failure. The
// red checks on the part base (StepDetail.baseline) are no failure of the task either.
export type StepLook = TaskStepDto["state"] | "expected" | "before";
export const stepLook = (s: Pick<TaskStepDto, "state" | "detail">): StepLook =>
  s.state === "failed" && s.detail.expectRed ? "expected" : s.state === "failed" && s.detail.baseline ? "before" : s.state;
export const STEP_TEXT: Record<StepLook, string> = {
  ok: "Done",
  failed: "Failed",
  expected: "Red as expected",
  before: "Red before this task",
  running: "Running",
  waiting: "Waiting",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

// spec.md section 6.8: the branch of a small task. A larger task gets more branches, and each one starts with <prefix><KEY>-.
export const plannedBranch = (prefix: string, t: Pick<TaskDto, "key" | "title">, size: TaskSize) =>
  size !== "large" ? branchName(prefix, t.key, { kind: "small", title: t.title }) : `${prefix}${t.key}-`;

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

// spec.md section 6.20.3: the files of one issue in the Attachments tab. summary: "" for a key that the task no longer lists.
export type FileGroup = { key: string; summary: string; rows: FileChoice[] };

// The groups of the Attachments tab: the parent first, then the sub-tasks in plan order, then the rest in tracker order. A group without
// files is left out. null: the task builds no sub-tasks, so the tab shows one list.
export function fileGroups(t: Pick<TaskDto, "key" | "title" | "attachments" | "files" | "subtasks" | "parts">): FileGroup[] | null {
  const subs = t.subtasks;
  if (!subs) return null;
  const planned = [...t.parts].sort((a, b) => a.ord - b.ord).flatMap((p) => p.keys);
  const stored = t.files.flatMap((f) => (f.issue ? [f.issue] : []));
  const keys = [...new Set([...planned, ...subs.map((s) => s.key), ...stored])].filter((k) => k !== t.key);
  const of = (key: string) => t.files.filter((f) => (f.issue ?? t.key) === key);
  const groups = [
    { key: t.key, summary: t.title, rows: fileChoices(t.attachments, of(t.key)) },
    ...keys.map((key) => {
      const s = subs.find((x) => x.key === key);
      return { key, summary: s?.summary ?? "", rows: fileChoices(s?.attachments ?? [], of(key)) };
    }),
  ];
  return groups.filter((g) => g.rows.length > 0);
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
export type SubOpts = { runner: string; forge: string; tracker: string; now: number; newest?: number | null; picks?: CommentPicks };

const FINAL = new Set<TaskPartDto["state"]>(["merged", "abandoned"]);
const WITH_PR = new Set<TaskPartDto["state"]>(["pr_open", "changes_requested", "approved"]);

// "ABC-12", or "ABC-15, ABC-16" for a part that builds two sub-tasks. A part without keys takes its label "ABC-10 (2 of 3)", as the
// server names it (tasks.ts partNames).
export const partName = (t: Pick<TaskDto, "key" | "parts">, p: Pick<TaskPartDto, "id" | "keys">) =>
  p.keys.length ? p.keys.join(", ") : partLabel(t, p);

// The PR title of a part, as the server writes it (pr.ts subtaskPrText): "ABC-12: <title>", "ABC-13 (part 2 of 2): <title>" for a
// split sub-task, "ABC-15, ABC-16: <title>" for two sub-tasks. A task without sub-tasks: "<KEY>: <task title>".
export function prTitle(
  t: Pick<TaskDto, "key" | "title" | "parts" | "subtasks" | "size" | "settings">,
  p: Pick<TaskPartDto, "id" | "keys" | "title">,
) {
  if (!partsPlan(t)) return `${t.key}: ${t.title}`;
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
  return `${p.keys.length ? p.keys.join(", ") : t.key} (${parts.findIndex((x) => x.id === p.id) + 1} of ${parts.length})`;
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

// spec.md section 6.25.6: the reason of a part, first or waiting in its row. A wait for the run slot holds no part.
const reasonOf = (t: TaskDto, p: TaskPartDto) =>
  p.blocked ?? (t.blocked && t.blocked.kind !== "slot" && blockedPart(t) === p.id ? t.blocked : null);

// The label of the part that holds the first reason, else the task key.
const firstLabel = (t: TaskDto) => {
  const p = codeParts(t).find((x) => x.id === blockedPart(t));
  return p ? partLabel(t, p) : t.key;
};

// spec.md section 6.25.6: the part label of a loop question in a task with sub-tasks, by the part of its step.
export function questionPart(
  t: Pick<TaskDto, "key" | "parts" | "steps" | "subtasks" | "size" | "settings">,
  q: TaskQuestionDto,
): string | null {
  if (!partsPlan(t) || q.source !== "loop") return null;
  const id = t.steps.find((s) => s.id === q.step)?.part;
  const p = t.parts.find((x) => x.id === id);
  return p ? partLabel(t, p) : null;
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

// self-approved-plans.md section 5.1: a part of a plan without sub-tasks is no sub-task.
const dropOf = (t: Pick<TaskDto, "subtasks">): Action => ({ kind: "drop", label: t.subtasks ? "Drop this sub-task" : "Drop this part" });
const trackerMove = (tracker: string): Action => ({ kind: "tracker-move", label: `Move in ${tracker}…` });

// The sentence, the actor, and the row action of a part (spec.md section 6.20.13 table).
function partRow(t: TaskDto, p: TaskPartDto, o: SubOpts): Pick<SubRow, "text" | "actor" | "action"> {
  const R = o.runner;
  const name = partName(t, p);
  const who = p.waiting.length ? listText(p.waiting) : null;
  const goPr: Action = { kind: "go-pr", label: "Go to the PR" };
  const drop = dropOf(t);
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
    case "implementing": {
      const reason = reasonOf(t, p);
      if (reason?.kind === "held") return { text: "On hold. Its work is kept.", actor: "You", action: null };
      if (reason?.kind === "usage") return { text: usageStatus(reason, R, o.now), actor: reason.armed ? "The app" : "You", action: null };
      if (reason) return { text: reason.text, actor: "You", action: null };
      const s = partStep(t, p.id);
      const work = s && workText(t, s, R);
      return { text: work || `${R} builds it.`, actor: s && work && APP_AT.has(rowPhase(s)) ? "The app" : R, action: null };
    }
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
  // ps4-plan.md section 2.6: a held part keeps its On hold row in a stopped task too.
  const shown = focus ?? defaultFocus(t);
  if (t.state === "stopped" && shown?.blocked?.kind === "held") return heldView(t, shown);
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
  const p = shown;
  if (!p) return taskView(t, o);
  const name = partLabel(t, p);
  // A stack plan has no tracker items (self-approved-plans.md section 5.1).
  const extra = t.subtasks ? [trackerMove(o.tracker), read] : [];
  const withExtra = (v: TaskView): TaskView => ({ ...v, more: [...v.more.filter((a) => a.kind !== "close"), ...extra] });
  // The task stays in implementing while another part builds or waits. The view of a part with a PR reads like a task in ready, and
  // the loop work on another part is not the work of this part.
  const run = runningStep(t);
  const narrow: TaskDto = {
    ...t,
    working: t.working && (run ? run.part === p.id : p.state === "implementing"),
    // The open row of another part is no work of this part, and the working rows name this part.
    steps: t.steps.filter((s) => s.part === p.id || (s.state !== "running" && s.state !== "waiting")),
    parts: [p],
    bases: p.bases,
    prs: t.prs.filter((r) => r.part === p.id),
  };
  const base = { detail: null, lines: [], needsYou: false, running: false } satisfies Partial<TaskView>;
  const goPr: Action = { kind: "go-pr", label: "Go to the PR" };
  const drop = dropOf(t);
  const b = t.blocked;
  const bp = blockedPart(t);
  if (p.blocked?.kind === "held") return withExtra(heldView(t, p));
  // spec.md section 6.25.6: the reason that waits in the part row. The user acts on the first reason first.
  if (p.blocked)
    return {
      ...base,
      status: p.blocked.kind === "usage" ? usageStatus(p.blocked, o.runner, o.now) : p.blocked.text,
      detail: `Act on ${firstLabel(t)} first.`,
      primary: null,
      more: [...(p.blocked.step !== null ? [{ kind: "see-why", label: "See why" } as const] : []), STOP],
      screen: "build",
      needsYou: true,
    };
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
    case "implementing": {
      // spec.md section 6.25.6: the reason of another part holds this part too.
      if (b && b.kind !== "slot")
        return { ...base, status: `${name} waits until you act on ${firstLabel(t)}.`, primary: null, more: [STOP], screen: "build" };
      // Another part can hold the first open row of the task, so this part reads its own row. Hold needs an open row.
      const own = partStep(t, p.id);
      const more: Action[] = own && HOLD_AT.has(rowPhase(own)) ? [...holdOf(p.id), STOP] : [STOP];
      return {
        ...base,
        status: own ? stepSentence(narrow, own, o.runner, name) : `${o.runner} builds ${name}.`,
        primary: null,
        more,
        screen: "build",
        running: true,
      };
    }
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
