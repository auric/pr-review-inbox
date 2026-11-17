// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build loop of a task part (docs/plans/review-v2/spec.md sections 6.2, 6.7, and 6.14; part-session.md sections 2 and 9.3.3): the
// part rows, the plan commit, the setup commands, the baseline, one Claude session per part with its runs, the tick check, the final
// checks gate with its fix runs, one commit per green gate, the size note, the own review, the blocked reasons, hold, resume, stop,
// and the waits for the run slot. advance() and advancePart() make every state change. The phase send helper orders the work of a part.
// A restart or a resume starts again from the last commit of the part branch: the commit rows and the ticks of the plan file tell what
// is done.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { initialTransition, transition } from "xstate";
import { indentBlock, oneLine } from "../../shared/consult";
import type { TaskAllowInput, TaskAnswersInput, TaskCommentsInput, TaskResumeInput } from "../../shared/dto";
import { shortHash } from "../../shared/outcome";
import type { FindingPayload } from "../../shared/review";
import type { RunCut } from "../../shared/run-log";
import {
  ALLOW_BLOCKS_MAX,
  ASK_TEXT,
  allowProblem,
  BASE_CHECK_AGE_MS,
  type CommandKind,
  DEFAULT_TEST_GLOBS,
  FAILURE_TAIL,
  type ImplementResult,
  type InstructComments,
  type InstructDetail,
  LARGE_REPOS_TEXT,
  limitText,
  PART_STATE_TEXT,
  type PartState,
  RESOLVE_STOPS,
  RUN_LIMITS,
  refusedLine,
  runLimitsOf,
  type SessionPurpose,
  SHELL_WARNING_FIRST,
  type StartMode,
  type StepDetail,
  type StepMode,
  stepDetail,
  TASK_STATE_TEXT,
  type TaskBlocked,
  type TaskSize,
  TOO_MANY_ASKS,
  taskBlocked,
  type UpdateDetail,
  updateDetail,
} from "../../shared/task";
import { foundOf } from "../context/task-file";
import type { Live } from "../live";
import { log } from "../log";
import { DEFAULT_PROFILE, type Profile, SHIPPED_PROFILES } from "../review/catalog";
import { identity } from "../review/clone";
import { commentsFile, continueDiffFile, continueFile, pushbackHistory } from "../review/context-files";
import { currentDrafts, writeThreadDraft } from "../review/drafts";
import { fold } from "../review/edits";
import { git } from "../review/git";
import type { ReviewJobs, TaskReviewStart } from "../review/jobs";
import type { Ending } from "../review/judge";
import { contextThreads } from "../review/pr-context";
import { TIME_LIMIT_TEXT } from "../review/stream";
import { repoPath } from "../review/validate";
import { type BranchRemote, type ContextFile, cachePath, locked, longPath, noUrl } from "../review/workspace";
import { branchPrefixesOf, type Settings } from "../settings";
import { CHECK_KINDS, type ChecksResult, checkStep } from "./checks";
import { movedReason } from "./gitstate";
import {
  bashLine,
  commitTask,
  endStep,
  insertStep,
  PATCH_LOST,
  type PathProblem,
  patchStep,
  runningStep,
  type StepInput,
  type StepOutcome,
  startStep,
  stepAfterCommit,
  stepDetailOf,
} from "./implement";
import { type Answer, answerProblem, type QuestionRow } from "./interview";
import { PHASE_GUARDS, type Phase, type PhaseContext, type PhaseEvent, partMachine, phaseMachine } from "./machine";
import { noteTaskWaits } from "./notify";
import { type Docs, docNames, type Plan, parsePlan, parseTasks, partStepFile } from "./plan";
import { type PreflightDeps, preflight } from "./preflight";
import { saveMainRepo, sourceOf, type TaskRepoRow, taskRepos, type UpdateRepo, updateRepos } from "./repos";
import { allowAsks, checkRules, hostsOf, mergeAllow, originsOf, type StepShell } from "./shell";
import { groupsOf, liveTaskPart, NO_TASK_PR, sortedRun } from "./task-pr";
import {
  advance,
  advancePart,
  baseCheckOf,
  budgetOf,
  buildsAtOnceOf,
  currentPart,
  dropSessions,
  holdBlocked,
  instructTarget,
  keysOf,
  type LowerPart,
  lowerHowOf,
  lowerOf,
  moveHeads,
  mustFixPoint,
  openPoints,
  PAUSED,
  type PartSession,
  partDocsOf,
  partNames,
  partOf,
  partSession,
  repoSettings,
  type SessionHeads,
  saveAllow,
  scheduleOf,
  sessionRunning,
  setBaseMoves,
  setBlocked,
  setLowerHow,
  setSettings,
  setUsageArmed,
  sha256File,
  softReason,
  stepAnswers,
  stopForRun,
  stopSends,
  TASK_CHANGED,
  type TaskResult,
  type TaskRow,
  taskDto,
  taskFilesOf,
  taskProfile,
  taskRow,
  taskSettingsOf,
  undoTarget,
  updateBase,
  updateTarget,
  WAITING,
  WORKING,
  waitingPart,
} from "./tasks";
import {
  type BaseMove,
  baseIn,
  checkBase,
  commitPointer,
  conflictsFile,
  continueUpdate,
  fetchBase,
  followGitlinks,
  headsOf,
  holds,
  lowerMerge,
  markerLeft,
  mergeInto,
  pointerFor,
  resetToPre,
  resolveProblems,
  resolveSnapshot,
  startUpdate,
  UpdateAbort,
} from "./update";
import {
  adminOf,
  branchName,
  deepestFirst,
  firstFree,
  freeBranch,
  headOf,
  matchEol,
  mergeBase,
  noneChanges,
  openRepoTrees,
  openWorktree,
  partDir,
  patchFile,
  type RepoTree,
  readSetupMark,
  remoteBranches,
  removeWorktree,
  resetTrees,
  resetWorktree,
  savePatch,
  setupHash,
  setupMark,
  status,
  takenBranches,
  takeRemoteBranch,
  taskDir,
  type Worktree,
  writeSetupMark,
  wtGit,
} from "./worktree";

// spec.md section 0. The default of Settings > Tasks "Test-fix tries".
export const TEST_FIX_TRIES = RUN_LIMITS.testFixTries.def;
export const REVIEW_FIX_TRIES = 2;
// spec.md section 6.1, Counting: the excluded globs when the repository sets none.
export const LOCK_GLOBS = ["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "*.lock"];

// The part states with a worktree (tasks.ts HAS_WORKTREE).
const WORKTREE = new Set<PartState>(["implementing", "self_reviewed", "pr_open", "changes_requested", "approved"]);
// spec.md sections 6.20.6 and 6.20.7: a PR that colleagues review, a started part, and a part that keeps the task in implementing.
const HAS_PR = new Set<PartState>(["pr_open", "changes_requested", "approved"]);
const BUILT = new Set<PartState>(["self_reviewed", ...HAS_PR]);
const STARTED = new Set<PartState>([...WORKTREE, "declined"]);
const WAITS_PR = new Set<PartState>(["planned", "implementing", "self_reviewed"]);
const NO_TEST = "Needs you: approve a test command for this repository first. The build needs it to see red and green tests.";
const BUSY = "The build still ends its step. Try again when it ends.";
// spec.md section 6.7, Spec change: the notes that Reject adds to the spec_change row. The other notes hold the reason of Claude.
const REJECTED = "The user rejected the change.";
const AGAIN = "Runs again without the plan change.";
// part-session.md section 2.2: the Log note of a resume that failed before any tool call, the line of a run after an app restart, and
// the line of the run that continues a cut run. Section 2.6 item 10: the note of a part with no changed test file.
const RESUME_FAILED = "The app could not resume the session. It started a new one with the earlier work.";
const RESTART_LINE = "The last run stopped when the app stopped. Its changes are in the worktree. context/continue.md lists them.";
const cutLine = (cut: RunCut) => `The last run reached its ${cut === "turns" ? "turn cap" : "time limit"}. Continue where you stopped.`;
const NO_TEST_FILE = "Claude added or changed no test file.";
// spec.md section 6.25.5: the 409 of "Run setup again" on a part whose row holds a reason.
const SETUP_WAITS = "This part waits for you. Act on the first reason first.";
// The note of "Fix these too" with no open point.
const NO_POINTS = "No point waits for a fix.";
// ps4-plan.md section 4: the texts of Hold, Skip, Start again, and the usage arm.
const HOLD_WHEN = (ord: number) => `Hold works while Claude builds or fixes part ${ord}.`;
const HOLD_FIRST = (ord: number) => `Hold part ${ord} first.`;
const HELD_TEXT = (ord: number) => `Part ${ord} is on hold. Its work is kept.`;
// part-session.md section 9.4: a held part goes on by "Continue with part" only.
const HELD_GO = (ord: number) => `Part ${ord} is on hold. Continue it from its row.`;
const NO_ARM = "No resume is armed.";
// setTimeout takes at most 2^31 - 1 ms.
const TIMER_MAX_MS = 2 ** 31 - 1;
// part-session.md section 2.7: the note of a failed or cut critic, and the critic run (AC-B333).
const CRITIC_FAILED = "The quick review failed. The own review still runs.";
// ps4-plan.md section 8 item 2: the prompt and the modules of the shipped default profile, so the user's profile edits do not reach it.
const SHIPPED = SHIPPED_PROFILES.find((p) => p.id === DEFAULT_PROFILE) as Profile;
// User decision of 2026-11-14: Opus at low effort, not Haiku.
const CRITIC_PROFILE: Profile = {
  ...SHIPPED,
  model: "opus",
  maxTurns: 30,
  effort: "low",
  advisor: null,
  languageChecks: false,
  reviewer: { ...SHIPPED.reviewer, mode: "off" },
  verifier: { ...SHIPPED.verifier, mode: "off" },
};
// pushback.md sections 6.23.4 and 6.23.5: the options of a push-back question, the 400 of an answer without a choice, and the discard
// reason of an accepted push-back by its why.
const PUSHBACK_OPTIONS = [
  { label: "Accept the push-back", detail: "The point closes. Later reviews of this part skip it." },
  { label: "Fix it anyway", detail: "Claude fixes the point in the next step." },
];
const PUSHBACK_FIRST = "Judge each push-back of Claude first.";
const DISCARD_OF = { already: "bug", invalid: "bug", scope: "place", plan: "intended" } as const;

// The loop stops here: a reason now blocks the task, or the task stopped. The reason is already stored.
class Halt extends Error {}
// The run of an instruct or resolve step failed or was cancelled: its driver restores the earlier reason or aborts the update (spec.md
// section 6.18.7). text: the sentence of the CLI.
class StepFailed extends Halt {
  constructor(readonly text: string) {
    super(text);
  }
}

// gitignore(5) pattern rules: a pattern without "/" matches a name at any depth, a "/" at the start or in the middle anchors it to the
// top folder, and a "/" at the end matches a folder and every path below it.
export function globMatch(pattern: string, path: string): boolean {
  const folder = pattern.endsWith("/");
  const core = folder ? pattern.slice(0, -1) : pattern;
  const body = core.startsWith("/") ? core.slice(1) : core;
  const glob = new Bun.Glob(folder ? `${body}/**` : body);
  if (core.includes("/")) return glob.match(path);
  const parts = path.split("/");
  for (let k = 0; k < parts.length; k++) if (glob.match(parts.slice(k).join("/"))) return true;
  return false;
}

export type LineCount = { files: number; added: number; removed: number; lines: number };

// spec.md section 6.1, Counting: the added and removed lines of `git diff --numstat <base>..<head>` without the paths of the excluded
// globs. A binary file counts 0. git-diff(1), --numstat with -z: a rename has an empty path, then the old and the new path. eol: also
// count a change of line ends only, for the repair check (spec.md section 6.7, Line endings).
export async function changedLines(wt: Worktree, base: string, head: string, exclude: readonly string[], eol = false): Promise<LineCount> {
  // spec.md section 6.16.6: gitlink entries do not count.
  const cr = eol ? [] : ["--ignore-cr-at-eol"];
  const out = (await wtGit(wt, ["diff", "--numstat", "-z", "-M", ...cr, "--ignore-submodules=all", base, head])).split("\0");
  let files = 0;
  let added = 0;
  let removed = 0;
  for (let k = 0; k < out.length; k++) {
    const rec = out[k];
    if (!rec) continue;
    const [a, r, named] = rec.split("\t");
    let path = named ?? "";
    if (!path) {
      k += 2;
      path = out[k] ?? "";
    }
    if (exclude.some((g) => globMatch(g, path))) continue;
    files++;
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { files, added, removed, lines: added + removed };
}

// "<spec_dir>/<name>.md" as a repository path.
const specPath = (specDir: string, name: string) => `${specDir.replace(/\/+$/, "")}/${name}.md`;
// spec.md section 6.20.8: task_part.base_commit is the branch point of a part. NULL takes task.base_commit.
const baseOf = (t: { base_commit: string | null }, p: { base_commit: string | null }) => p.base_commit ?? t.base_commit;
const onDisk = (wt: Worktree, path: string) => join(wt.repo, ...path.split("/"));
const under = (path: string, dir: string) => {
  const a = path.split("/").map(fold);
  const b = dir.split("/").filter(Boolean).map(fold);
  return a.length > b.length && b.every((x, i) => a[i] === x);
};
const same = (a: string, b: string) =>
  (repoPath(a) ?? a).split("/").map(fold).join("/") === (repoPath(b) ?? b).split("/").map(fold).join("/");

// The tick of a task in the tasks grammar (spec.md section 6.4). null: the plan has no open task with this ID.
export function tickTask(text: string, id: string): string | null {
  const re = new RegExp(`^### \\[ \\] ${id.replaceAll(".", "\\.")} `, "m");
  return re.test(text) ? text.replace(re, `### [x] ${id} `) : null;
}

// part-session.md section 2.4: the IDs that disk ticks against head, when disk equals head with only these ticks (`### [ ] <id> ` to
// `### [x] <id> `). null: disk holds another change, such as a tick of a heading that head does not hold open. Line ends do not count.
export function tickDiff(head: string, disk: string): string[] | null {
  const h = head.replaceAll("\r\n", "\n");
  const d = disk.replaceAll("\r\n", "\n");
  const ids = [...d.matchAll(/^### \[x\] (\S+) /gm)].map((m) => m[1] as string).filter((id) => tickTask(h, id) !== null);
  let text = h;
  for (const id of ids) text = tickTask(text, id) as string;
  return text === d ? ids : null;
}

// One command of the checks on the part base (StepDetail.baseline). red: it did not exit with 0.
export type BaseRun = { name: string; argv: string[]; red: boolean };

// A command of a later check against the run on the part base. same: the base ran the same argv. null: the base run has no such
// command.
export function onBase(c: { name: string; argv: readonly string[] }, base: readonly BaseRun[] | null) {
  const b = base?.find((x) => x.name === c.name);
  if (!b) return null;
  return { red: b.red, same: b.argv.length === c.argv.length && b.argv.every((a, i) => a === c.argv[i]), argv: b.argv };
}

function beforeLine(c: { name: string; argv: readonly string[] }, base: readonly BaseRun[] | null): string[] {
  const b = onBase(c, base);
  if (!b) return [];
  if (b.red && b.same) return ["- On the part base: Also red on the part base."];
  if (b.red) return [`- On the part base: the command \`${oneLine(b.argv.join(" "))}\` also failed on the part base.`];
  return [
    b.same ? "- On the part base: New. It passed on the part base." : "- On the part base: New. The command passed on the part base.",
  ];
}

// part-session.md section 2.2, Guard: the reason why a run starts a new session, or null when it can resume the kept transcript. gates:
// the facts of Gate B37 (claude.ts SESSION_GATES). heads: the HEAD of each worktree now. cap: Settings > Tasks "Session context cap".
// Rule 4 (a denied path or a git state change) drops the kept transcript at the run end (implement.ts), so rule 1 covers it. The task
// Log shows the reason as "New session: <reason>", so each reason is a sentence for the user.
export function resumeProblem(
  s: Pick<PartSession, "file" | "sha256" | "heads" | "context"> | null,
  heads: SessionHeads,
  cap: number,
  gates: { resume: boolean },
): string | null {
  if (!gates.resume) return "This app version starts a new session for each run.";
  if (!s?.file || !existsSync(s.file)) return "No session of an earlier run is saved.";
  if (sha256File(s.file) !== s.sha256) return "The saved session changed on disk.";
  const at = new Map(s.heads.map((h) => [h.taskRepo, h.head]));
  if (heads.length !== at.size || heads.some((h) => at.get(h.taskRepo) !== h.head)) return "The branch moved after the last run.";
  if (s.context === null) return "The size of the last session is not known.";
  if (s.context > cap) return `The last session is larger than your limit of ${cap} tokens.`;
  return null;
}

// The content of each changed path of every worktree. A fix step often edits a file that the implement step changed: its path stays in
// git status, so only the content shows the change.
async function snapshot(trees: readonly RepoTree[]): Promise<string> {
  const out: string[] = [];
  for (const t of trees) {
    if (!t.wt) continue;
    for (const e of await status(t.wt)) {
      const p = join(t.wt.repo, ...e.path.split("/"));
      let h = "gone";
      try {
        h = lstatSync(p).isFile() ? Bun.hash(readFileSync(p)).toString(36) : "other";
      } catch {}
      out.push(`${t.full}/${e.path}\0${e.xy}\0${h}`);
    }
  }
  return out.sort().join("\n");
}

// context/failure.md of a fix step after red checks: the failed commands with the end of their output, each marked against the checks on
// the part base. All tails together stay within FAILURE_TAIL (spec.md section 0, OUTPUT_TAIL: 32 KB sent to Claude).
export function checkFailure(r: Extract<ChecksResult, { status: "ran" }>, base: readonly BaseRun[] | null = null): ContextFile {
  const failed = r.commands.filter((c) => c.exit !== 0);
  const each = Math.floor(FAILURE_TAIL / Math.max(1, failed.length));
  const out = [
    "# Check output",
    "",
    "The app ran the approved commands after your run. These commands failed. Each shows the end of its output.",
    "",
  ];
  for (const c of failed) {
    const tail = Buffer.from(c.tail);
    const text = tail.length > each ? tail.subarray(tail.length - each).toString() : c.tail;
    out.push(`## ${oneLine(c.name)}: ${c.exit === null ? "no exit code" : `exit ${c.exit}`} after ${c.ms} ms`, "");
    out.push(`- Command: ${oneLine(c.argv.join(" "))}`, ...beforeLine(c, base), "", indentBlock(text.trimEnd() || "(no output)"), "");
  }
  return { name: "failure.md", text: out.join("\n") };
}

type Point = { id: number; payload: FindingPayload };
type FindingPushback = NonNullable<FindingPayload["pushback"]>;

// The points of the own review that the loop fixes: confirmed blocker and major findings (spec.md section 6.7).
export const mustFix = (points: Point[]) => points.filter((p) => mustFixPoint(p.payload));

// pushback.md section 6.23.3: the header of failure.md after the own review. The critic has no check step (part-session.md section 2.7).
export const REVIEW_HEAD =
  "A second Claude run reviewed this part. Its check step confirmed these points. Judge each one against the code and the plan.";
export const CRITIC_HEAD =
  "A quick second Claude run reviewed the added lines of this part. Judge each point against the code and the plan.";

// context/failure.md of a judging run: the points with path:line, and the check reason and evidence of each checked point.
export function reviewFailure(points: Point[], head = REVIEW_HEAD): ContextFile {
  const out = ["# Review points", "", head, ""];
  for (const { id, payload: f } of points) {
    out.push(`## Point ${id}: ${f.severity} at ${oneLine(f.path)}:${f.line}`, "", indentBlock(f.body.trim() || "(no text)"), "");
    const lines = [
      ...(f.trigger?.trim() ? [`- Trigger: ${oneLine(f.trigger)}`] : []),
      ...(f.verify?.reason ? [`- Check: ${oneLine(f.verify.reason)}`] : []),
      ...(f.verify?.evidence ? [`- Evidence: ${oneLine(f.verify.evidence)}`] : []),
    ];
    if (lines.length) out.push(...lines, "");
  }
  return { name: "failure.md", text: out.join("\n") };
}

// spec.md section 6.21.5: context/failure.md of the step after a shell step whose Bash commands wrote new files. files: the new files
// that are still on disk. A failure.md or comments.md of the step keeps its name and text, and this section follows it.
export function bashFailure(failure: ContextFile | undefined, files: readonly string[]): ContextFile | undefined {
  if (!files.length) return failure;
  const out = [
    "# New files that are not committed",
    "",
    "A Bash command of the last step wrote these new files. The app commits a new file only when the Write tool wrote it. Leave out a file that the step does not need.",
    "",
    ...files.map((p) => `- ${bashLine(p)}`),
    "",
  ].join("\n");
  return { name: failure?.name ?? "failure.md", text: failure ? `${failure.text.trimEnd()}\n\n${out}` : out };
}

type PartRow = {
  id: number;
  ord: number;
  kind: string;
  title: string;
  branch: string;
  base_branch: string;
  state: PartState;
  head: string | null;
  pushed: string | null;
  keys_json: string | null;
  start_mode: StartMode | null;
  after_part: number | null;
  base_commit: string | null;
  spec_dir: string | null;
  adopted: number;
  override: number;
  blocked_json: string | null;
};

type Ctx = {
  db: Database;
  id: number;
  t: TaskRow;
  part: PartRow;
  wt: Worktree;
  base: string;
  // spec.md section 6.20.6: the Jira key, the name in commit messages, the title, and the plan folder of the part. The task key, the task
  // title, and task.spec_dir for a task without sub-tasks.
  key: string;
  label: string;
  title: string;
  specDir: string;
  size: TaskSize;
  docs: Docs;
  plan: Plan;
  budget: number;
  // "Keep one PR": the line budget stops the part no more.
  keep: boolean;
  exclude: string[];
  testGlobs: string[] | null;
  who: { name: string; email: string } | null;
  profile: Profile;
  // Every repository of the part folder, main first (spec.md section 6.16.5). One entry for a task with one repository.
  trees: RepoTree[];
  // build: the build of the part, in state implementing. instruct and update (spec.md section 6.18): one step on a built part, also in
  // state ready.
  mode: DriverMode;
  // part-session.md section 9.3.3: the phase of the part. The build, follow-up, and update drivers track it.
  // rounds: the review rounds of this driver. waited: a run or a step of this part set its own reason.
  phase: Phase | null;
  rounds: number;
  waited: boolean;
  // The first follow-up row that this driver ran, or null. Each later run of that follow-up has a higher row ID.
  follow: number | null;
};

type DriverMode = "build" | "instruct" | "update";
// ps4-plan.md section 2.5: the rows of a follow-up run, which map to the phase following.
const FOLLOW = "(kind = 'instruct' OR (kind = 'fix' AND item IN ('points', 'pushback')))";
// ps4-plan.md section 1 item 5: the restart mark of a part. The guards of GO read only the rows after it. The baseline is exempt.
const MARK = "COALESCE((SELECT MAX(id) FROM task_step WHERE part = $part AND kind = 'commit' AND item = 'restart'), 0)";
const isFollow = (r: { kind: string; item: string | null }) =>
  r.kind === "instruct" || (r.kind === "fix" && (r.item === "points" || r.item === "pushback"));
// ps6-ps7-plan.md AC-B392: the note of a comment run whose fixes a reset removed before their commit.
const RESET_COMMENTS = "The app reset the work before its commit, so it writes no Fixed-in draft for this run.";
// What a driver does first with the uncommitted work of each part that builds (build-redesign.md section 2.2). false: nothing. true:
// the Continue rule.
type Reset = boolean;

const Q = {
  parts: `SELECT id, ord, kind, title, branch, base_branch, state, head, pushed, keys_json, start_mode, after_part, base_commit, spec_dir,
    adopted, override, blocked_json FROM task_part WHERE task = $task ORDER BY ord`,
  // spec.md section 6.20.6, Start of a part: its branch, its base branch and commit, and the lease of Continue.
  partStart: `UPDATE task_part SET branch = $branch, base_branch = $base, base_commit = $commit, pushed = $pushed, updated_at = $now
    WHERE id = $id AND state = 'planned'`,
  // The first other repository that a part changed (spec.md section 6.16.9, task_pr).
  otherRepo: `SELECT r.project, r.repo FROM task_pr p JOIN task_repo r ON r.id = p.task_repo WHERE p.part = $part AND r.project IS NOT NULL
    ORDER BY p.id LIMIT 1`,
  waitMerge: "UPDATE task_part SET start_mode = 'merge', updated_at = $now WHERE id = $id AND state = 'planned'",
  found: "SELECT found_json FROM task_subtask WHERE task = $task AND key = $key",
  // pushed: the lease of the first push, the fetched remote head for Continue (spec.md section 6.16.4).
  insertPart: `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, pushed, state, created_at, updated_at)
    VALUES ($task, $ord, $kind, $title, $branch, $base, $pushed, $state, $now, $now) RETURNING id`,
  setBase: "UPDATE task SET base_commit = $base WHERE id = $id",
  attempt: "SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM task_step WHERE part = $part AND kind = $kind AND item = $item",
  committed: "SELECT 1 FROM task_step WHERE part = $part AND kind = 'commit' AND item = $item AND state = 'ok'",
  // ps6-ps7-plan.md AC-B392: the comment runs of a part that judged their threads and wait for the commit of their fixes.
  undrafted: `SELECT id FROM task_step WHERE part = $part AND kind = 'instruct'
    AND json_extract(detail_json, '$.instruct.comments.verdicts') IS NOT NULL AND json_extract(detail_json, '$.instruct.comments.drafted') = 0
    ORDER BY id`,
  prHeads: "SELECT id, project, repo, pr_id, my_role, source_head FROM pull_request WHERE id = $id",
  partPr: "SELECT pr FROM task_part WHERE id = $id",
  stepPart: "SELECT part FROM task_step WHERE id = $id",
  lastStep: "SELECT MAX(id) AS id FROM task_step WHERE part = $part",
  lines: "UPDATE task_part SET lines = $lines, files = $files, updated_at = $now WHERE id = $id",
  clone: "SELECT path FROM repo_clone WHERE project = $project AND repo = $repo",
  points: "SELECT id, payload_json FROM review_item WHERE run = $run AND kind = 'finding' ORDER BY id",
  question: `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, recommended, step, asked_at)
    VALUES ($task, 'loop', (SELECT COALESCE(MAX(round), 0) + 1 FROM task_question WHERE task = $task), 0, $text, $why, $kind, $options,
      $recommended, $step, $now)`,
  openLoop: "SELECT * FROM task_question WHERE task = $task AND source = 'loop' AND answer_json IS NULL ORDER BY id",
  answer: "UPDATE task_question SET answer_json = $answer, answered_at = $now WHERE id = $id AND answer_json IS NULL",
  // spec.md section 6.25.4: the waiting reasons that an answer ends.
  clearAsked: `UPDATE task_part SET blocked_json = NULL WHERE task = $task AND json_extract(blocked_json, '$.kind') = 'question'
    AND json_extract(blocked_json, '$.step') = $step`,
  step: "SELECT id, part, kind, item, state, detail_json FROM task_step WHERE id = $id AND task = $task",
  rowAttempt: "SELECT attempt FROM task_step WHERE id = $id",
  stepState: "SELECT state FROM task_step WHERE id = $id",
  // spec.md section 6.18.2: "I<n>" names the rows of the n-th Tell Claude send; "U<n>" the rows of the n-th update.
  sends: "SELECT COUNT(*) AS n FROM task_step WHERE task = $task AND kind = $kind",
  restarts: `SELECT id, part, detail_json FROM task_step WHERE task = $task AND kind = 'update'
    AND json_extract(detail_json, '$.update.result') = 'restart' AND COALESCE(json_extract(detail_json, '$.update.recovered'), 0) = 0`,
  restartTasks: `SELECT DISTINCT task FROM task_step WHERE kind = 'update' AND json_extract(detail_json, '$.update.result') = 'restart'
    AND COALESCE(json_extract(detail_json, '$.update.recovered'), 0) = 0`,
  baseCommit: "UPDATE task SET base_commit = $base WHERE id = $id",
  // spec.md section 6.20.8: the base commit of a part with its own base.
  partBase: "UPDATE task_part SET base_commit = $base, updated_at = $now WHERE id = $id",
  override: "UPDATE task_part SET override = 1, updated_at = $now WHERE id = $id AND state = 'planned'",
  repoBase: "UPDATE task_repo SET base_commit = $base WHERE id = $id",
  repoPin: "UPDATE task_repo SET pinned = $pinned, base_commit = $base WHERE id = $id",
  prBase: "UPDATE task_pr SET base_commit = $base, head = $head WHERE part = $part AND task_repo = $repo",
  prHead: "UPDATE task_pr SET head = $head WHERE part = $part AND task_repo = $repo",
  partHead: "UPDATE task_part SET head = $head, updated_at = $now WHERE id = $id",
  subLines: "UPDATE task_pr SET lines = $lines, files = $files WHERE part = $part AND task_repo = $repo",
  subBase: "UPDATE task_repo SET base_commit = $base WHERE id = $id",
  subLease: `INSERT INTO task_pr (part, task_repo, branch, base_branch, base_commit, head, pushed, state)
    VALUES ($part, $repo, $branch, $base, $commit, $lease, $lease, 'changed') ON CONFLICT (part, task_repo) DO NOTHING`,
  // spec.md section 6.16.7, "Pick a base branch": a push, a Continue lease, or a PR of the repository refuses it.
  mainSent: "SELECT 1 FROM task_part WHERE task = $task AND (pushed IS NOT NULL OR remote_pr IS NOT NULL OR pr IS NOT NULL)",
  repoSent: "SELECT 1 FROM task_pr WHERE task_repo = $repo AND (pushed IS NOT NULL OR remote_pr IS NOT NULL OR pr IS NOT NULL)",
  target: "UPDATE task SET target_branch = $branch, base_commit = $base WHERE id = $id",
  partBranch: "UPDATE task_part SET base_branch = $branch WHERE task = $task",
  repoBranch: "UPDATE task_repo SET base_branch = $branch, base_commit = $base WHERE id = $id",
  prBranch: "UPDATE task_pr SET base_branch = $branch WHERE task_repo = $repo",
  baseChanged: "UPDATE task_repo SET base_changed = $changed WHERE task = $task AND (id = $id OR ($main = 1 AND role = 'main'))",
  // spec.md section 6.21: the last run of one step, the allow blocks of a part, and the steps of a task that asked to allow commands.
  lastRun: `SELECT detail_json FROM task_step WHERE part = $part AND kind = $kind AND item = $item AND run IS NOT NULL
    ORDER BY id DESC LIMIT 1`,
  // spec.md section 6.21.5: the last Claude step of a part that ended.
  lastClaude: `SELECT detail_json FROM task_step WHERE part = $part AND kind IN ('tests', 'implement', 'fix', 'instruct', 'resolve')
    AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
  // build-redesign.md section 2.2: the rows of a part after its last commit, with the run end of each Claude step.
  work: `SELECT s.id, s.kind, s.item, s.state, s.attempt, s.run, json_extract(s.detail_json, '$.patch') AS patch,
      CASE WHEN s.kind IN ('tests', 'implement', 'fix', 'instruct', 'resolve') THEN s.detail_json END AS detail_json,
      r.status AS run_status, r.error_kind, r.error_text
    FROM task_step s LEFT JOIN review_run r ON r.id = s.run
    WHERE s.part = $part AND s.id > COALESCE((SELECT MAX(id) FROM task_step WHERE part = $part AND kind = 'commit'), 0) ORDER BY s.id`,
  allowBlocks: "SELECT COUNT(*) AS n FROM task_step WHERE part = $part AND json_extract(detail_json, '$.allowAsk') IS NOT NULL",
  allowAsks: "SELECT detail_json FROM task_step WHERE task = $task AND json_extract(detail_json, '$.allowAsk') IS NOT NULL",
  // spec.md section 6.7, Baseline: the checks on the part base, and whether the part ran them or a Claude step already.
  baseline: `SELECT detail_json FROM task_step WHERE part = $part AND kind = 'check' AND item = 'base' AND state IN ('ok', 'failed')
    ORDER BY id DESC LIMIT 1`,
  started: `SELECT 1 FROM task_step WHERE part = $part AND (kind IN ('tests', 'implement', 'fix', 'instruct', 'resolve')
    OR (kind = 'check' AND item = 'base' AND state IN ('ok', 'failed'))) LIMIT 1`,
  // part-session.md section 2.6: the last gate checks of a part (every check but setup and the baseline), and a Claude step after them.
  lastGate: `SELECT id, state, detail_json FROM task_step WHERE part = $part AND kind = 'check' AND item NOT IN ('setup', 'base')
    ORDER BY id DESC LIMIT 1`,
  claudeAfter: `SELECT 1 FROM task_step WHERE part = $part AND id > $id AND kind IN ('tests', 'implement', 'fix', 'instruct', 'resolve')
    LIMIT 1`,
  claudeRan: `SELECT 1 FROM task_step WHERE part = $part AND run IS NOT NULL
    AND kind IN ('tests', 'implement', 'fix', 'instruct', 'resolve') AND id > ${MARK} LIMIT 1`,
  // part-session.md section 9.3.3, guard review: the newest commit of Claude's work (no plan commit, line-end repair, plan change, or
  // restart mark), and the own reviews after it. The last own review of one repository at one head that ended ok (spec.md section 6.7).
  buildCommit: `SELECT 1 FROM task_step WHERE part = $part AND kind = 'commit' AND item = 'build' AND state = 'ok' AND id > ${MARK}
    LIMIT 1`,
  workCommit: `SELECT MAX(id) AS id FROM task_step WHERE part = $part AND kind = 'commit' AND state = 'ok'
    AND item NOT IN ('plan', 'eol', 'spec', 'restart') AND id > ${MARK}`,
  // Q57: a green update whose resolve run wrote code counts as a commit of Claude's work. An undone update left no code.
  resolvedUpdate: `SELECT MAX(id) AS id FROM task_step WHERE part = $part AND kind = 'update' AND state = 'ok' AND id > ${MARK}
    AND json_extract(detail_json, '$.update.result') = 'green' AND json_extract(detail_json, '$.update.resolved') = 1
    AND COALESCE(json_extract(detail_json, '$.update.undone'), 0) = 0`,
  // ps4-plan.md section 1 item 4: a critic row is a review row with item critic. It is no own review.
  reviewsAfter: `SELECT run FROM task_step WHERE part = $part AND kind = 'review' AND item = 'review' AND state = 'ok' AND run IS NOT NULL
    AND id > $after`,
  // ps4-plan.md section 2.2, guard critic: a critic row that ended ok or failed after the restart mark. A cancelled critic runs again,
  // and so does a critic that an app restart cut (tasks.ts SQL.failSteps).
  criticRan: `SELECT 1 FROM task_step WHERE part = $part AND kind = 'review' AND item = 'critic' AND state IN ('ok', 'failed')
    AND id > ${MARK} LIMIT 1`,
  // The points of a review run that the user did not discard (an accepted push-back, pushback.md section 6.23.5).
  livePoints: "SELECT id, payload_json FROM review_item WHERE run = $run AND kind = 'finding' AND status <> 'discarded' ORDER BY id",
  item: "SELECT id, payload_json FROM review_item WHERE id = $id AND kind = 'finding' AND status <> 'discarded'",
  setPayload: "UPDATE review_item SET payload_json = $payload, revision = revision + 1 WHERE id = $id",
  skipFix:
    "UPDATE review_item SET payload_json = json_set(payload_json, '$.skipFix', json('true')), revision = revision + 1 WHERE id = $id",
  discard: "UPDATE review_item SET status = 'discarded', payload_json = $payload, revision = revision + 1 WHERE id = $id",
  // pushback.md section 6.23.4 item 3: the push-back questions of one judging run share one round.
  round: "SELECT COALESCE(MAX(round), 0) + 1 AS n FROM task_question WHERE task = $task",
  pushback: `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, recommended, step, point, asked_at)
    VALUES ($task, 'loop', $round, $ord, $text, $why, 'choice', $options, NULL, $step, $point, $now)`,
  // pushback.md section 6.23.6: the accepted push-backs of a part for context/history.md of its next own review.
  // User decision of 2026-11-14: Start again drops them, so only the reviews after the restart mark count.
  accepted: `SELECT i.id, i.payload_json FROM review_item i JOIN task_step s ON s.run = i.run WHERE s.part = $part AND s.kind = 'review'
    AND s.item = 'review' AND i.kind = 'finding' AND i.status = 'discarded' AND json_extract(i.payload_json, '$.pushback') IS NOT NULL
    AND s.id > ${MARK} ORDER BY i.id`,
  reviewAt: `SELECT s.id, s.run FROM task_step s JOIN review_run r ON r.id = s.run WHERE s.part = $part AND s.kind = 'review'
    AND s.state = 'ok' AND r.idem_key LIKE $key ORDER BY s.id DESC LIMIT 1`,
  redBeforeSeen: `SELECT 1 FROM task_step WHERE part = $part AND kind = 'check' AND item = $item
    AND json_extract(detail_json, '$.redBefore') = 1 AND id > ${MARK} LIMIT 1`,
  ensureSettings: `INSERT INTO repo_task_settings (project, repo, updated_at) VALUES ($project, $repo, $now)
    ON CONFLICT (project, repo) DO NOTHING`,
  // spec.md section 6.7, Spec change: the newest proposal of one step. cancelled: the user rejected it.
  lastSpecChange: `SELECT state, detail_json FROM task_step WHERE part = $part AND kind = 'spec_change' AND item = $item
    ORDER BY id DESC LIMIT 1`,
  // spec.md section 6.18.2: the newest send or update of a task. ps4-plan.md section 2.2, guard follow: the oldest waiting follow-up row
  // of a part, the newest follow-up row of a part, and the newest follow-up row of one item.
  lastBuilt: "SELECT id, kind FROM task_step WHERE task = $task AND kind IN ('instruct', 'update') ORDER BY id DESC LIMIT 1",
  follow: `SELECT id, kind, item FROM task_step WHERE part = $part AND state = 'waiting' AND ${FOLLOW} ORDER BY id LIMIT 1`,
  newestFollow: `SELECT id, item FROM task_step WHERE part = $part AND ${FOLLOW} ORDER BY id DESC LIMIT 1`,
  lastFollow: `SELECT id FROM task_step WHERE part = $part AND item = $item AND ${FOLLOW} ORDER BY id DESC LIMIT 1`,
  openFollow: `SELECT 1 FROM task_step WHERE part = $part AND state IN ('waiting', 'running') AND ${FOLLOW}`,
  // ps4-plan.md WP-7: a waiting row that never ran takes the next ID when newer rows of its part exist. The guards read rows by ID order.
  renew: `UPDATE task_step SET id = (SELECT MAX(id) + 1 FROM task_step), ord = (SELECT MAX(ord) + 1 FROM task_step WHERE task = $task),
      started_at = $now
    WHERE id = $id AND state = 'waiting' AND run IS NULL AND EXISTS (SELECT 1 FROM task_step WHERE part = $part AND id > $id)
    RETURNING id`,
  // part-session.md section 9.4 rule 6 and ps4-plan.md section 2.6: held lives in the row of its part only.
  held: "SELECT 1 FROM task_part WHERE id = $id AND json_extract(blocked_json, '$.kind') = 'held'",
  hold: "UPDATE task_part SET blocked_json = $b, updated_at = $now WHERE id = $id AND task = $task AND blocked_json IS NULL",
  unhold: `UPDATE task_part SET blocked_json = NULL, updated_at = $now WHERE id = $id AND task = $task
    AND json_extract(blocked_json, '$.kind') = 'held'`,
  bump: "UPDATE task SET version = version + 1, updated_at = $now WHERE id = $id AND version = $version",
  open: "SELECT id, kind, state FROM task_step WHERE part = $part AND state IN ('waiting', 'running') ORDER BY id",
  // ps4-plan.md section 2.3: unpushed is task_part.pushed NULL with no pushed task_pr row of the part.
  pushedPr: "SELECT 1 FROM task_pr WHERE part = $part AND pushed IS NOT NULL LIMIT 1",
  // Skip and Start again: the reasons and the open loop questions of the part go. Start again also drops the old heads.
  clearPart: "UPDATE task_part SET blocked_json = NULL, updated_at = $now WHERE id = $id",
  dropAsks: `DELETE FROM task_question WHERE task = $task AND source = 'loop' AND answer_json IS NULL
    AND step IN (SELECT id FROM task_step WHERE part = $part)`,
  restartPart: "UPDATE task_part SET head = NULL, lines = NULL, files = NULL, updated_at = $now WHERE id = $id",
  dropPrs: "DELETE FROM task_pr WHERE part = $part AND pushed IS NULL AND pr IS NULL AND remote_pr IS NULL",
  // ps4-plan.md section 1 item 8: the previous Claude run of a part, for the arm of a new usage reason.
  prevRun: `SELECT r.error_kind FROM task_step s JOIN review_run r ON r.id = s.run WHERE s.part = $part AND s.id < $step
    ORDER BY s.id DESC LIMIT 1`,
  // The tasks whose first reason is an armed usage reason, for the timers after an app restart.
  armed: `SELECT id FROM task WHERE state IN ('implementing', 'ready') AND json_extract(blocked_json, '$.kind') = 'usage'
    AND json_extract(blocked_json, '$.armed') = 1`,
};

// spec.md section 6.21: the steps that can get the Bash tool. The resolve step never does.
const SHELL_STEPS: ReadonlySet<StepMode> = new Set(["implement", "fix", "instruct"]);
// part-session.md section 2.1: the runs of a part session. Resolve runs join it with the resolve gate (WP-5).
const SESSION_MODES: ReadonlySet<StepMode> = new Set(["implement", "fix", "instruct"]);
const NO_FACTS = Object.fromEntries(PHASE_GUARDS.map((k) => [k, false])) as PhaseContext;
// part-session.md section 2.6 item 5: the subject of the commit of each kind of gate.
type Round = "build" | "checks" | "critic" | "review";
// The item of the check and fix rows, the item and subject of the commit, and the step.md of the fix runs of one gate.
type Gate = { check: string; commit: string; subject: string; step: (attempt: number) => ContextFile };

// The patterns that the user refused for this task (D3). They never show again.
const refusedOf = (db: Database, task: number) =>
  new Set(
    (db.query(Q.allowAsks).all({ task }) as { detail_json: string }[]).flatMap((r) =>
      (stepDetail.parse(JSON.parse(r.detail_json)).allowAsk?.decisions ?? []).filter((d) => d.choice === "refuse").map((d) => d.pattern),
    ),
  );

// part-session.md section 9.3.3, guard review: the own review runs of a part after the newest commit of Claude's work. null: the part
// has no such commit.
function reviewsAfterWork(db: Database, part: number): number[] | null {
  const after = Math.max(...[Q.workCommit, Q.resolvedUpdate].map((q) => (db.query(q).get({ part }) as { id: number | null }).id ?? 0));
  return after ? (db.query(Q.reviewsAfter).all({ part, after }) as { run: number }[]).map((r) => r.run) : null;
}

// The changed paths of every worktree, from the main repository root.
async function dirty(trees: readonly RepoTree[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of trees) if (t.wt) for (const e of await status(t.wt)) out.push(t.full ? `${t.full}/${e.path}` : e.path);
  return out;
}

// The patch file of one repository: file for main, <name>-<task_repo id>.patch for the others (spec.md section 6.16.6).
const treePatch = (file: string, t: RepoTree) => (t.row.role === "main" ? file : file.replace(/\.patch$/, `-${t.row.id}.patch`));

// The repositories of a part that the task changes.
const editTrees = (trees: readonly RepoTree[]) =>
  trees.filter((t): t is RepoTree & { wt: Worktree } => !!t.wt && (t.row.role === "main" || t.row.access === "edit"));

// ps4-plan.md section 1 item 7 (part-session.md section 2.12): Start again writes refs/rl/task/<task>/backup/part-<ord>-<n> at the head
// of each edit repository, with the first n that no cache of the part holds. The app git helper records the writes for the check of a
// step of another part on the same cache (gap 17). Returns the ref.
export async function backupPart(trees: readonly RepoTree[], task: number, ord: number): Promise<string> {
  const ns = `refs/rl/task/${task}/backup`;
  const edits = editTrees(trees).filter((t, k, all) => all.findIndex((x) => x.wt.cache === t.wt.cache) === k);
  let n = 1;
  for (const t of edits)
    for (const ref of (await git([`--git-dir=${t.wt.cache}`, "for-each-ref", "--format=%(refname)", ns], { env: t.wt.env })).split("\n")) {
      const m = /^refs\/rl\/task\/\d+\/backup\/part-(\d+)-(\d+)$/.exec(ref.trim());
      if (m && Number(m[1]) === ord) n = Math.max(n, Number(m[2]) + 1);
    }
  const ref = `${ns}/part-${ord}-${n}`;
  for (const t of edits) {
    const head = await headOf(t.wt);
    // git-update-ref(1): an empty old value refuses a ref that exists.
    await locked(t.wt.cache, () => git([`--git-dir=${t.wt.cache}`, "update-ref", ref, head, ""], { env: t.wt.env }));
  }
  return ref;
}

// ps4-plan.md section 1 item 6: Start again resets each edit repository to its start, as openRepoTrees made its worktree: the part base
// for main, the base commit for an added repository, and the pinned commit for a submodule. runPart then writes the plan commit again.
export async function resetToStart(trees: readonly RepoTree[], base: string) {
  const heads = editTrees(trees).map((t) => {
    const head = t.row.role === "main" ? base : t.row.role === "added" ? t.row.base_commit : t.row.pinned;
    if (!head) throw new Error(`The repository ${t.full || "main"} has no start commit.`);
    return { taskRepo: t.row.id, head, baseCommit: null, pinned: null, baseChanged: false };
  });
  await resetToPre(trees, heads);
}

type StepRow = { id: number; part: number | null; kind: string; item: string | null; state: string; detail_json: string };

// A Claude step of a part that ran a process, with the end of its run.
type Work = {
  id: number;
  kind: StepMode;
  item: string | null;
  state: string;
  attempt: number;
  run_status: string | null;
  error_kind: string | null;
  error_text: string | null;
  detail: StepDetail;
};

// build-redesign.md section 2.2: the work of a part after its last commit. marks: the rows with a saved patch, oldest first; each one
// is a reset of the worktree. reset: the newest mark. all: the Claude steps, oldest first. kept: the steps after reset, whose changes
// the worktree still holds.
function workOf(db: Database, part: number) {
  const rows = db.query(Q.work).all({ part }) as (Omit<Work, "detail"> & {
    run: number | null;
    patch: string | null;
    detail_json: string | null;
  })[];
  const marks = rows.filter((r): r is (typeof rows)[number] & { patch: string } => r.patch !== null);
  const reset = marks.at(-1) ?? null;
  const all: Work[] = rows.flatMap((r) =>
    r.detail_json !== null && r.run !== null ? [{ ...r, detail: stepDetail.parse(JSON.parse(r.detail_json)) }] : [],
  );
  return { marks, reset, all, kept: all.filter((w) => !reset || w.id > reset.id) };
}

// true: the folder of a repository with access none holds something.
const noneDirty = (trees: readonly RepoTree[], t: RepoTree) =>
  t.row.access === "none" && !!trees.find((x) => x.row.id === t.row.parent)?.wt && noneChanges(trees, t).length > 0;

// A changed submodule or added repository with access edit: its task branch head differs from its base and the diff is not empty
// (spec.md section 6.16.6, Changed repositories).
type ChangedSub = { tree: RepoTree; base: string; head: string };

// onPhase: each phase event of a build driver (part-session.md section 9.7, loop order). The tests read it.
export type PhaseStep = { task: number; part: number; from: Phase; event: PhaseEvent["type"]; to: Phase };
export type LoopOptions = { review: ReviewJobs; settings: Settings; live: Live; now?: () => number; onPhase?: (s: PhaseStep) => void };

export function createLoop(opts: LoopOptions) {
  const { review, settings, live } = opts;
  const now = opts.now ?? Date.now;
  const dataDir = review.dataDir;
  // One driver per task. It awaits each step and ends at the first blocked reason. spec.md section 6.20.6: the driver of a task with
  // sub-tasks builds up to buildsAtOnce parts at the same time, so the aborts of one task are a set.
  const drivers = new Map<number, Promise<void>>();
  const slotWaits = new Map<number, () => void>();
  const aborts = new Map<number, Set<AbortController>>();
  // A kick while the driver builds: the driver asks the scheduler again. part: a part that halted in this driver builds again.
  const pokes = new Map<number, (part?: number) => void>();
  // ps4-plan.md WP-4: the parts that a driver or a Skip or Start again works on now, per task. A part is idle when it is in no set and
  // has no open step row.
  const active = new Map<number, Set<number>>();
  // part-session.md section 9.4, usage rules: the timer of the armed usage reason of a task, with its resumeAt.
  const usageTimers = new Map<number, { at: number; timer: ReturnType<typeof setTimeout> }>();
  const enter = <T>(m: Map<number, Set<T>>, id: number, v: T) => m.set(id, (m.get(id) ?? new Set<T>()).add(v));
  const leave = <T>(m: Map<number, Set<T>>, id: number, v: T) => {
    const s = m.get(id);
    s?.delete(v);
    if (s?.size === 0) m.delete(id);
  };
  const abortChecks = (id: number) => {
    for (const a of aborts.get(id) ?? []) a.abort();
  };
  // spec.md section 6.18: the driver of an instruct step or an update, and its Stop. A Stop of them keeps the task state.
  const modes = new Map<number, Exclude<DriverMode, "build">>();
  const stopping = new Set<number>();
  // The base checks that run in the background, so shutdown() awaits them.
  const checking = new Map<number, Promise<unknown>>();
  // The drivers whose work ended and that run only the base check at their end (spec.md section 6.18.5).
  const ending = new Set<number>();
  let closing = false;

  const changed = (id: number) => {
    live.broadcast("changed", { tasks: [id] });
    const db = settings.db();
    if (db && noteTaskWaits(db, [id], now())) live.broadcast("events", { count: 1 });
    if (db) rearm(db, id);
  };
  const dto = (db: Database, id: number) => taskDto(db, taskRow(db, id) as TaskRow);
  const conflict = (db: Database, id: number, error: string): TaskResult => {
    const t = taskRow(db, id);
    return t ? { status: 409, error, task: taskDto(db, t) } : { status: 404, error: "Task not found." };
  };
  const blockedOf = (t: TaskRow): TaskBlocked | null => {
    if (t.blocked_json === null) return null;
    const r = taskBlocked.safeParse(JSON.parse(t.blocked_json));
    return r.success ? r.data : null;
  };
  const parts = (db: Database, id: number) => db.query(Q.parts).all({ task: id }) as PartRow[];
  const buildingAll = (db: Database, id: number) => parts(db, id).filter((p) => p.state === "implementing");
  const building = (db: Database, id: number) => buildingAll(db, id)[0] ?? null;
  // spec.md section 6.20.6: a reason holds every part of the task. The legacy pause and a wait for the run slot hold no other part.
  const blocks = (t: TaskRow) => t.blocked_json !== null && !softReason(blockedOf(t));

  // Sets the reason while the task builds, or while an instruct step or an update runs on a built part (spec.md section 6.18). block()
  // also ends the driver. A reason never replaces the reason of another part (tasks.ts holdBlocked).
  function reason(db: Database, id: number, b: TaskBlocked | null) {
    db.transaction(() => {
      const cur = taskRow(db, id);
      if (cur?.state !== "implementing" && cur?.state !== "ready") return;
      if (b === null) setBlocked(db, { task: id, version: cur.version }, null, now());
      else holdBlocked(db, cur, b, now());
    })();
    changed(id);
  }
  function block(c: Ctx, b: TaskBlocked): never {
    // part-session.md section 9.4, queued reasons: a held part gets no reason. Its step ends as after a Stop.
    if (onHold(c.db, c.part.id)) throw new Halt();
    c.waited = true;
    reason(c.db, c.id, b);
    throw new Halt();
  }

  // part-session.md section 9.3.3: the phase send helper. A refused event is a bug of the loop, so failed() stops the task. A driver with
  // no phase (null) sends nothing.
  function send(c: Ctx, event: PhaseEvent, facts: Partial<PhaseContext> = {}): void {
    if (c.phase === null) return;
    const from = c.phase;
    const snap = phaseMachine.resolveState({ value: from, context: { ...NO_FACTS, ...facts } });
    if (!snap.can(event)) throw new Error(`The phase ${from} of part ${c.part.ord} refuses ${event.type}.`);
    c.phase = transition(phaseMachine, snap, event)[0].value as Phase;
    opts.onPhase?.({ task: c.id, part: c.part.id, from, event: event.type, to: c.phase });
  }
  // The loop goes on only while the task builds with no reason. An instruct step or an update also runs in state ready.
  const isLive = (c: Pick<Ctx, "db" | "id" | "mode">) => {
    const t = taskRow(c.db, c.id);
    const state = t?.state === "implementing" || (c.mode !== "build" && t?.state === "ready");
    return !closing && !stopping.has(c.id) && state && !!t && !blocks(t);
  };
  const held = (c: Pick<Ctx, "db" | "id">) => {
    const t = taskRow(c.db, c.id);
    return !t || blocks(t);
  };
  // spec.md section 6.25.4: the row of the part of step can keep a reason while the task holds the reason of another part.
  const keeps = (c: Pick<Ctx, "db" | "id">, step: number) => {
    const t = taskRow(c.db, c.id);
    return !!t && waitingPart(c.db, t, { kind: "question", step, text: "" }) !== null;
  };
  // Only the reason of another part halts the build now, so a red result of this part can still wait in its row (spec.md section 6.25.1).
  const heldByOther = (c: Pick<Ctx, "db" | "id">) => {
    const t = taskRow(c.db, c.id);
    return !closing && !stopping.has(c.id) && t?.state === "implementing" && blocks(t);
  };
  // spec.md section 6.25.4: after an action clears its reason, the loop starts only when no other reason moved up.
  const free = (db: Database, id: number) => taskRow(db, id)?.blocked_json === null;
  // spec.md section 6.20.6: a task that builds two or more parts at the same time runs its Claude steps beside the run slot.
  const beside = (c: Pick<Ctx, "db" | "id" | "t">) => buildsAtOnceOf(taskRow(c.db, c.id) ?? c.t) > 1;
  // ps4-plan.md section 2.6: a held part halts alone, at its next step.
  const onHold = (db: Database, part: number) => db.query(Q.held).get({ id: part }) !== null;
  const goes = (c: Ctx) => isLive(c) && !onHold(c.db, c.part.id);
  function guard(c: Ctx) {
    if (!goes(c)) throw new Halt();
  }
  // The claim of a part by a driver or a route. false: another one works on it.
  const claim = (id: number, part: number) => {
    if (active.get(id)?.has(part)) return false;
    enter(active, id, part);
    return true;
  };
  // A waiting message (WP-7) does not keep the part busy: Skip and Start again end it (stopSends).
  const partIdle = (db: Database, id: number, part: number) =>
    !active.get(id)?.has(part) &&
    (db.query(Q.open).all({ part }) as { kind: string; state: string }[]).every((o) => o.kind === "instruct" && o.state === "waiting");
  // The version move of a change of a part row only.
  const bump = (db: Database, id: number, version: number) => {
    if (db.query(Q.bump).run({ id, version, now: now() }).changes !== 1) throw new Error(TASK_CHANGED);
  };

  const preflightDeps: PreflightDeps = {
    dataDir,
    provider: () => settings.provider().catch(() => null),
    remote: (project, repo) => review.taskRemote(project, repo),
    now,
  };

  // The branch of the building part, or the name that ensureParts starts from.
  const plannedBranch = (db: Database, t: TaskRow) =>
    building(db, t.id)?.branch ??
    branchName(taskSettingsOf(t).branchPrefix ?? (branchPrefixesOf(settings.config())[0] as string), t.key, {
      kind: "small",
      title: t.title,
    });

  async function changedSubs(c: Ctx): Promise<ChangedSub[]> {
    const out: ChangedSub[] = [];
    for (const tree of c.trees) {
      if (tree.row.role === "main" || tree.row.access !== "edit" || !tree.wt) continue;
      const base = tree.row.base_commit ?? tree.row.pinned;
      const head = await headOf(tree.wt);
      if (!base || head === base) continue;
      if ((await wtGit(tree.wt, ["diff", "--numstat", base, head])).trim()) out.push({ tree, base, head });
    }
    return out;
  }

  const nextAttempt = (c: Ctx, kind: string, item: string) =>
    (c.db.query(Q.attempt).get({ part: c.part.id, kind, item }) as { n: number }).n;
  // spec.md section 6.20.3: a part of a task with sub-tasks gets the files of its own sub-task keys only.
  const filesFor = (c: Ctx) => (c.t.subtasks === 1 ? { keys: keysOf(c.part) } : {});

  // ---------- Context of a Claude step (spec.md section 6.7) ----------

  // The plan files of the branch: context/spec/<name>.md.
  function planFiles(c: Ctx): ContextFile[] {
    return docNames(c.size).flatMap((n) => {
      const p = onDisk(c.wt, specPath(c.specDir, n));
      return existsSync(p) ? [{ name: `spec/${n}.md`, text: readFileSync(p, "utf8") }] : [];
    });
  }

  // The plan as the branch holds it, with the ticks of the done tasks.
  function readPlan(c: Pick<Ctx, "wt" | "specDir" | "size" | "docs">): Plan | { error: string } {
    const name = c.size === "small" ? "plan" : "tasks";
    const p = onDisk(c.wt, specPath(c.specDir, name));
    if (!existsSync(p)) return { error: `The branch has no ${specPath(c.specDir, name)}.` };
    const text = readFileSync(p, "utf8").replaceAll("\r\n", "\n");
    const r = name === "plan" ? parsePlan(text, c.docs.parsed.parts) : parseTasks(text, c.docs.parsed.parts);
    return "error" in r ? { error: r.error } : { ...c.docs.parsed, parts: r.parts };
  }

  function refreshPlan(c: Ctx) {
    const p = readPlan(c);
    if ("error" in p) block(c, { kind: "error", step: null, text: `Needs you: ${p.error}` });
    c.plan = p;
  }

  // ---------- Steps ----------

  // Waits for a slot of the run pool (design.md B12, spec.md section 6.26). The step row waits too. With the limit 1, the reason says whose
  // run holds the slot. full: the limit of the full pool.
  async function waitSlot(
    c: Ctx,
    s: { kind: StepMode | "review"; item: string; attempt: number },
    { running: holder, full }: { running: { pr: number | null; kind: string; task?: number }; full?: number },
    waiting: number | null,
  ): Promise<number> {
    const step = waiting ?? insertStep(c.db, { task: c.id, part: c.part.id, ...s, state: "waiting" }, now());
    const pr =
      holder.pr === null
        ? null
        : (c.db.query("SELECT pr_id FROM pull_request WHERE id = $id").get({ id: holder.pr }) as { pr_id: number } | null);
    const other = holder.task === undefined ? null : taskRow(c.db, holder.task);
    const NOUN: Record<string, string> = {
      review: "review",
      ask: "question",
      explain: "explanation",
      reply: "reply drafts",
      fix: "fix",
      discuss: "talk",
    };
    const text =
      full !== undefined && full > 1
        ? `Waiting for a free run slot. Claude runs ${full} runs at once, your limit.`
        : pr
          ? `Waiting for your ${NOUN[holder.kind] ?? "run"} of PR ${pr.pr_id} to finish.`
          : other
            ? `Waiting for the build of ${other.key} to free the run slot.`
            : "Waiting for the other run to finish.";
    reason(c.db, c.id, { kind: "slot", step, text });
    await new Promise<void>((resolve) => {
      const off = review.onFree(resolve);
      slotWaits.set(c.id, () => {
        off();
        resolve();
      });
    });
    slotWaits.delete(c.id);
    c.db.transaction(() => {
      const cur = taskRow(c.db, c.id);
      if ((cur?.state === "implementing" || cur?.state === "ready") && blockedOf(cur)?.kind === "slot")
        setBlocked(c.db, { task: c.id, version: cur.version }, null, now());
    })();
    if (!goes(c)) {
      endStep(c.db, step, "cancelled", { notes: ["The build stopped while the step waited for the run slot."] }, now());
      changed(c.id);
      throw new Halt();
    }
    return step;
  }

  // spec.md section 6.7, Spec change: after a Reject, step.md tells Claude that the user rejected the change. step.md is the trusted file
  // of the app; the prompt calls every other context file untrusted data.
  function rejectedLines(c: Ctx, item: string): string[] {
    const r = c.db.query(Q.lastSpecChange).get({ part: c.part.id, item }) as { state: string; detail_json: string } | null;
    if (r?.state !== "cancelled") return [];
    const d = stepDetail.parse(JSON.parse(r.detail_json));
    const why = oneLine(d.notes.filter((n) => n !== REJECTED && n !== AGAIN).join(" "));
    return [
      `The user rejected your change to ${(d.specChange?.paths ?? []).join(", ")}.${why ? ` Your reason was: ${/[.!?]$/.test(why) ? why : `${why}.`}` : ""} Do not change files under ${c.specDir}. Do the task under the current plan. If you cannot, ask in question.`,
    ];
  }

  // The files of the last green setup stay out of StepDetail.dirtyBefore: the setup mark holds them, and they can be many.
  const setupFiles = (c: Ctx) => new Set(readSetupMark(c.wt)?.files ?? []);

  // The plan file that Claude ticks (spec.md section 6.4), as a path in the main repository.
  const tasksPath = (c: Pick<Ctx, "specDir" | "size">) => specPath(c.specDir, c.size === "small" ? "plan" : "tasks");
  const openTasks = (c: Ctx) => c.plan.parts.flatMap((p) => p.tasks.filter((t) => !t.ticked));
  const allFiles = (c: Ctx) => c.plan.parts.flatMap((x) => x.tasks.flatMap((t) => t.files));
  async function headsNow(c: Ctx): Promise<SessionHeads> {
    const out: SessionHeads = [];
    for (const t of c.trees) if (t.wt) out.push({ taskRepo: t.row.id, head: await headOf(t.wt) });
    return out;
  }

  // part-session.md section 2.2: the session of the next run of a part. again: a resume that failed before any tool call, so this run
  // starts a new session at once.
  async function sessionOf(c: Ctx, purpose: SessionPurpose, again: boolean): Promise<NonNullable<StepInput["session"]>> {
    const s = partSession(c.db, c.part.id);
    const heads = await headsNow(c);
    const limits = runLimitsOf(settings.config()?.runLimits);
    const why = again ? RESUME_FAILED : resumeProblem(s, heads, limits.sessionContextCap, review.sessionGates);
    return {
      keep: join(taskDir(dataDir, c.db, c.id), "sessions", `part-${c.part.ord}`),
      resume: why === null ? (s?.file ?? null) : null,
      why,
      purpose,
      heads,
      tasksFile: `./repo/${tasksPath(c)}`,
      run: (s?.runs ?? 0) + 1,
      turns: limits.sessionTurns,
    };
  }

  // part-session.md section 2.2, Fresh session: context/continue.md and context/continue-diff.md for a new session of a part with
  // earlier runs, and the line of step.md. The diff is the uncommitted work in the worktree, else the patch of the first reset at or after
  // the last Claude run: a later reset saved only what came after it (build-redesign.md section 2.2). null: no earlier run. resumed: the
  // run forks the kept transcript. It gets the files only when that transcript lacks the newest run after the last commit (an app restart
  // cut it, or the app did not keep it), or when a reset came after that run (build-redesign.md section 2.2: the next attempt gets the
  // patch).
  async function freshFiles(c: Ctx, resumed = false): Promise<{ files: ContextFile[]; line: string } | null> {
    if (!c.db.query(Q.claudeRan).get({ part: c.part.id })) return null;
    const { marks, reset: newest, all } = workOf(c.db, c.part.id);
    const prev = all.at(-1);
    const reset = prev ? (marks.find((r) => r.id >= prev.id) ?? null) : newest;
    if (resumed && !reset && (!prev || prev.detail.session?.id === partSession(c.db, c.part.id)?.sessionId)) return null;
    const own = setupFiles(c);
    const paths = (await dirty(c.trees)).filter((p) => !own.has(p));
    const parts: string[] = [];
    if (paths.length) {
      // savePatch takes the new files too, which `git diff HEAD` leaves out.
      const tmp = mkdtempSync(join(tmpdir(), "rl-continue-"));
      try {
        for (const t of c.trees) {
          const ps = t.wt ? (await status(t.wt)).map((e) => e.path).filter((p) => !own.has(t.full ? `${t.full}/${p}` : p)) : [];
          const f = t.wt && ps.length ? await savePatch(t.wt, join(tmp, `${t.row.id}.patch`), ps).catch(() => null) : null;
          if (f) parts.push(t.full ? `(repository ${t.full})\n${readFileSync(f, "utf8")}` : readFileSync(f, "utf8"));
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
      }
    } else if (reset) {
      const file = join(dirname(patchFile(dataDir, c.db, c.id, reset.id)), basename(reset.patch).replace(/-\d+\.patch$/, ".patch"));
      for (const t of c.trees) {
        const f = treePatch(file, t);
        if (existsSync(f)) parts.push(t.full ? `(repository ${t.full})\n${readFileSync(f, "utf8")}` : readFileSync(f, "utf8"));
      }
    }
    const last = c.db.query(Q.lastClaude).get({ part: c.part.id }) as { detail_json: string } | null;
    const d = last ? stepDetail.parse(JSON.parse(last.detail_json)) : null;
    const log = await wtGit(c.wt, ["log", "--format=%s", `${c.base}..HEAD`]).catch(() => "");
    const stat = await wtGit(c.wt, ["diff", "--shortstat", "--ignore-submodules=all", c.base, "HEAD"]).catch(() => "");
    const tasks = c.plan.parts.flatMap((p) => p.tasks);
    const files = [
      continueFile({
        commits: log.split("\n").filter(Boolean),
        stat: stat.trim(),
        ticked: tasks.filter((t) => t.ticked).map((t) => `${t.id} ${t.title}`),
        open: tasks.filter((t) => !t.ticked).map((t) => `${t.id} ${t.title}`),
        summary: d?.summary ?? null,
        notes: d?.notes ?? [],
        paths,
      }),
      continueDiffFile(parts.join("\n"), paths.length > 0),
    ];
    // part-session.md section 2.2, End and deletion: the run that an app restart cut.
    const restart = all.at(-1)?.error_kind === "restart" && paths.length ? [RESTART_LINE] : [];
    const work = paths.length
      ? "The work that is not committed is in the worktree. ./context/continue-diff.md holds its diff. Check it and go on. Do not start again."
      : parts.length
        ? "The app reset the work of the last run. ./context/continue-diff.md holds it as a patch. Reuse what is right."
        : reset
          ? "The app reset the work of the last run to the last commit."
          : "";
    const start = resumed
      ? work
      : `This run starts a new session. ./context/continue.md lists the earlier work on this part. ${work}`.trim();
    const line = [...restart, start].filter(Boolean).join(" ");
    return line ? { files, line } : null;
  }

  // part-session.md section 2.3 item 5: context/baseline.md, the checks that failed on the part base.
  function baselineFile(c: Ctx): ContextFile {
    const base = baselineOf(c);
    const red = (base ?? []).filter((b) => b.red);
    const lines = !base
      ? ["The app did not run the checks on the part base."]
      : red.length
        ? red.map((b) => `- ${oneLine(b.name)}: \`${oneLine(b.argv.join(" "))}\``)
        : ["No check failed on the part base."];
    return { name: "baseline.md", text: ["# Checks that fail on the part base", "", ...lines, ""].join("\n") };
  }

  // One Claude run in the run slot (implement.ts), with its outcome. row: the step row that the route wrote (an instruct or a resolve
  // step). A run that did not start (a stop, a reason such as the cost limit) halts. A run of a part session (implement or fix) picks
  // its session by the guard of part-session.md section 2.2. A new session with earlier runs gets context/continue.md. extra: more lines
  // of step.md. again: a new session at once. session: the session that the caller picked (a resolve run), or null for none.
  async function runStep(
    c: Ctx,
    mode: StepMode,
    item: string,
    o: {
      allow: string[];
      step: (attempt: number) => ContextFile;
      failure?: ContextFile;
      row?: number;
      instructions?: string;
      resolveCheck?: StepInput["resolveCheck"];
      purpose?: SessionPurpose;
      extra?: string[];
      again?: boolean;
      session?: StepInput["session"] | null;
      points?: boolean;
      tries?: StepInput["tries"];
    },
  ): Promise<{ r: StepOutcome | null; shell: StepShell | null; unchanged: boolean }> {
    let waiting: number | null = o.row ?? null;
    for (;;) {
      guard(c);
      const attempt =
        o.row === undefined ? nextAttempt(c, mode, item) : (c.db.query(Q.rowAttempt).get({ id: o.row }) as { attempt: number }).attempt;
      const own = setupFiles(c);
      const before = (await dirty(c.trees)).filter((p) => !own.has(p));
      const session =
        o.session !== undefined ? o.session : SESSION_MODES.has(mode) ? await sessionOf(c, o.purpose ?? "build", o.again === true) : null;
      // part-session.md section 2.13: a resolve fork gets no continue files. The dirty paths of a conflict stop are the unmerged files.
      const joined = !!session && mode !== "resolve";
      const cont = joined ? await freshFiles(c, session.resume !== null) : null;
      // check-fix.md item 1: a fix run that changes no file stops the fixes. spec.md section 6.18.2: a send that changes no file commits
      // nothing. A run that continues a cut run finishes kept changes, so it may change none.
      const snap = (mode === "fix" || mode === "instruct") && !o.extra?.length ? await snapshot(c.trees) : null;
      const answers = stepAnswers(c.db, c.id);
      // spec.md section 6.17: the task text and the included files as they are at this step. Section 6.20.3: a part gets the files of the
      // task and of its own sub-tasks only.
      const task = taskFilesOf(c.db, dataDir, c.t, filesFor(c));
      const shell = shellOf(c, mode, item);
      const refused = SHELL_STEPS.has(mode) ? [...refusedOf(c.db, c.id)].map(refusedLine) : [];
      const extra = [...refused, ...rejectedLines(c, item), ...(cont ? [cont.line] : []), ...(o.extra ?? [])];
      const stepMd = o.step(attempt);
      // spec.md section 6.21.5: a resolve step may make no new file.
      const failure = mode === "resolve" ? o.failure : bashFailure(o.failure, bashLeft(c));
      let out: StepOutcome | null = null;
      const s = await startStep({
        db: c.db,
        review,
        task: c.id,
        part: { id: c.part.id, ord: c.part.ord },
        wt: c.wt,
        mode,
        item,
        attempt,
        profile: c.profile,
        untrusted: [...task.files, ...(failure ? [failure] : []), ...(cont?.files ?? []), ...(joined ? [baselineFile(c)] : [])],
        attachments: task.attachments,
        own: [
          ...(answers ? [answers] : []),
          extra.length ? { ...stepMd, text: `${stepMd.text.trimEnd()}\n\n${extra.join("\n")}\n` } : stepMd,
          ...planFiles(c),
        ],
        allow: o.allow,
        specDir: c.specDir,
        base: c.base,
        onEnd: (x) => {
          out = x;
        },
        step: waiting,
        trees: c.trees,
        instructions: o.instructions,
        resolveCheck: o.resolveCheck,
        live: () => goes(c),
        extra: beside(c),
        ...(shell && { shell }),
        ...(session && { session }),
        ...(o.points && { points: true }),
        ...(o.tries && { tries: o.tries }),
        dirtyBefore: before,
        now,
      });
      if (s.status === 409 && "conflict" in s) {
        waiting = await waitSlot(c, { kind: mode, item, attempt }, s.conflict, waiting);
        continue;
      }
      changed(c.id);
      if (s.status !== 202) {
        if ("blocked" in s) c.waited = true;
        throw new Halt();
      }
      await s.done;
      changed(c.id);
      const unchanged = snap !== null && snap === (await snapshot(c.trees));
      return { r: out as StepOutcome | null, shell, unchanged };
    }
  }

  // spec.md section 6.21.5: the new files that the Bash commands of the last Claude step of the part wrote, while they are on disk. A
  // reset to the last commit removes them.
  function bashLeft(c: Ctx): string[] {
    const r = c.db.query(Q.lastClaude).get({ part: c.part.id }) as { detail_json: string } | null;
    return r ? stepDetail.parse(JSON.parse(r.detail_json)).bashFiles.filter((p) => existsSync(join(c.wt.dir, p))) : [];
  }

  // spec.md section 6.21: the Bash tool of an implement, fix, or instruct step. Bash is on in Most commands and Unrestricted mode, or
  // when the allowlist of the repository or an "Allow once" of the last run of this step holds a pattern, or when "Claude may run the
  // approved checks" gives a check (checkRules). The rules hold the saved patterns in each mode, so a saved pattern can lift the deny rule
  // of a network program (shell.ts). Most commands and Unrestricted list the checks for the prompt only and give no notes.
  function shellOf(c: Ctx, mode: StepMode, item: string): StepShell | null {
    if (!SHELL_STEPS.has(mode)) return null;
    const repo = repoSettings(c.db, c.t.project, c.t.repo);
    const last = c.db.query(Q.lastRun).get({ part: c.part.id, kind: mode, item }) as { detail_json: string } | null;
    const ask = last ? stepDetail.parse(JSON.parse(last.detail_json)).allowAsk : null;
    const once = (ask?.decisions ?? []).filter((d) => d.choice === "once").map((d) => d.pattern);
    const rules = [...new Set([...repo.allow.map((e) => e.pattern), ...once])];
    const any = repo.shellMode !== "allowlist";
    const run =
      any || repo.runChecks
        ? checkRules(repo.commands, { mode: repo.shellMode, rules, hosts: hostsOf(originsOf(settings.config())) })
        : { checks: [], notes: [] };
    if (!any && !rules.length && !run.checks.length) return null;
    return { mode: repo.shellMode, rules, checks: run.checks, bashTimeoutSec: repo.bashTimeoutSec, notes: any ? [] : run.notes };
  }

  // A step that halts before its question, plan change, or allow request is written is no result that the loop took. The next Continue
  // resets its changes with the patch (build-redesign.md section 2.2).
  function halt(c: Ctx, step: number): never {
    patchStep(c.db, step, { checked: false });
    throw new Halt();
  }

  // D3: the requests of a step that ends with allowRequest, or that the runner ended over the refusal cap. The worktree keeps the changes
  // of the step (build-redesign.md section 2.2), and the task waits with kind allow. A request that the app refuses goes to the notes of
  // the step. A run that the runner ended with no request left gives the reason error/run (part-session.md section 9.3.4, Q-SM1).
  async function askAllow(c: Ctx, r: StepOutcome, shell: StepShell | null) {
    const { asks, notes } = allowAsks({
      mode: shell?.mode ?? null,
      requests: r.result?.allowRequest ?? [],
      refused: r.refused,
      killed: r.ask,
      rules: [...(shell?.rules ?? []), ...(shell?.checks ?? []).flatMap((x) => [`${x} *`, x])],
      refusedBefore: refusedOf(c.db, c.id),
      hosts: hostsOf(originsOf(settings.config())),
    });
    if (notes.length) patchStep(c.db, r.step, { notes: [...stepDetailOf(c.db, r.step).notes, ...notes] });
    if (!asks.length) {
      if (r.ask) block(c, runReason(c, r));
      return;
    }
    if (held(c) && !keeps(c, r.step)) halt(c, r.step);
    const n = (c.db.query(Q.allowBlocks).get({ part: c.part.id }) as { n: number }).n;
    if (n >= ALLOW_BLOCKS_MAX) block(c, { kind: "error", step: r.step, text: TOO_MANY_ASKS });
    patchStep(c.db, r.step, { allowAsk: { requests: asks, decisions: [] } });
    block(c, { kind: "allow", step: r.step, text: ASK_TEXT });
  }

  // part-session.md section 9.4: the reason of a run that ended with no result, no denied path, and no stop (Q-SM1).
  function runReason(c: Ctx, r: StepOutcome): TaskBlocked {
    const text = oneLine(r.text ?? "The run failed.");
    if (r.cut === "stall" || r.cut === "loop")
      return { kind: "stuck", cause: r.cut, step: r.step, text: `Needs you: ${text} Continue goes on with the kept work.` };
    if (r.kind === "usage_limit") return usageReason(c, r.step, r.resetsAt);
    return { kind: "error", cause: "run", step: r.step, text: `Needs you: the run of part ${c.part.ord} failed. ${text}` };
  }

  // part-session.md sections 2.11 and 9.4, ps4-plan.md section 1 items 8 and 9: the reason of a run that hit the usage limit. resetsAt is in
  // seconds (Gate B37 U106). The reason starts armed when the setting is on and the previous Claude run of the part did not
  // end with the usage limit, so the app resumes once per limit.
  function usageReason(c: Ctx, step: number, resetsAt: number | null): TaskBlocked {
    const prev = c.db.query(Q.prevRun).get({ part: c.part.id, step }) as { error_kind: string | null } | null;
    const resumeAt = resetsAt !== null && Number.isSafeInteger(resetsAt * 1000) ? resetsAt * 1000 : undefined;
    return {
      kind: "usage",
      step,
      text: `Needs you: your Claude usage limit is reached. ${resumeAt === undefined ? "Continue runs the step again." : "Continue resumes the step after the limit resets."}`,
      ...(resumeAt !== undefined && { resumeAt }),
      armed: settings.usageResume() && prev?.error_kind !== "usage_limit",
    };
  }

  // part-session.md section 9.3.3, guard firstCut: no earlier run of this kind and item after the last commit reached its turn cap or its
  // process cap.
  const firstCut = (c: Ctx, mode: StepMode, item: string, step: number) =>
    !workOf(c.db, c.part.id).all.some(
      (w) => w.id < step && w.kind === mode && w.item === item && (w.error_kind === "max_turns" || w.error_text === TIME_LIMIT_TEXT),
    );

  // part-session.md section 2.4, the tick check: the ticks of the tasks file on disk against HEAD, or null for any other change.
  async function ticksOf(c: Ctx): Promise<string[] | null> {
    const file = tasksPath(c);
    const p = onDisk(c.wt, file);
    if (!existsSync(p)) return null;
    const head = await wtGit(c.wt, ["show", `HEAD:${file}`]).catch(() => null);
    return head === null ? null : tickDiff(head, readFileSync(p, "utf8"));
  }

  // Each changed plan file must equal its HEAD text, except the ticks of the tasks file. spec: the plan files with another change.
  async function planChanges(c: Ctx, changed: string[]): Promise<{ spec: string[]; ticks: string[] }> {
    const file = tasksPath(c);
    const spec = changed.filter((p) => under(p, c.specDir) && !same(p, file));
    if (!changed.some((p) => same(p, file))) return { spec, ticks: [] };
    const ticks = await ticksOf(c);
    return ticks === null ? { spec: [...spec, file], ticks: [] } : { spec, ticks };
  }

  // One Claude run that returns only with a result: a denied path, a failed or cut run, a question, and a plan change set their reason
  // and halt (part-session.md section 9.3.3, ps4-plan.md section 1 gap 13: a follow-up too). Sections 2.2 and 9.3.3: the turn cap and
  // the process cap continue once by themselves (RUN_CUT), and a resume that failed before any tool call starts one new session. Each
  // more run of a follow-up gets a new row with the same follow-up detail.
  async function claude(
    c: Ctx,
    mode: StepMode,
    item: string,
    o: {
      allow: string[];
      step: (attempt: number) => ContextFile;
      failure?: ContextFile;
      row?: number;
      instructions?: string;
      purpose?: SessionPurpose;
      // failure.md holds review points (pushback.md section 6.23.8).
      points?: boolean;
      tries?: StepInput["tries"];
    },
  ): Promise<StepOutcome & { result: ImplementResult; unchanged: boolean; ticks: string[] }> {
    let extra: string[] = [];
    let again = false;
    let row = o.row;
    for (;;) {
      const before = (await ticksOf(c)) ?? [];
      const purpose = mode === "implement" && extra.length ? "continue" : o.purpose;
      const { r, shell, unchanged } = await runStep(c, mode, item, { ...o, row, purpose, extra, again });
      if (r && (r.ask || r.result?.allowRequest.length)) await askAllow(c, r, shell);
      // No outcome: restart recovery ended the run first.
      if (!r) throw new Halt();
      if (!r.result) {
        // implement.ts set the denied path, or it stopped the task for a worktree that it could not check.
        if (r.problems.length || r.moved.length) {
          c.waited = true;
          throw new Halt();
        }
        if (r.broken) throw new Halt();
        if (r.status === "cancelled") throw new Halt();
        // part-session.md section 2.2: no init, "No conversation found", or a process error. A usage limit also ends a run before any
        // tool call, and a new session hits it too.
        if (r.resumed && r.events === 0 && !again && r.kind !== "usage_limit") {
          patchStep(c.db, r.step, { notes: [...stepDetailOf(c.db, r.step).notes, RESUME_FAILED] });
          again = true;
          if (row !== undefined) row = requeue(c.db, c.id, r.step);
          continue;
        }
        if (r.cut === "turns" || r.cut === "time") {
          const first = firstCut(c, mode, item, r.step);
          send(c, { type: "RUN_CUT" }, { firstCut: first });
          if (first) {
            extra = [cutLine(r.cut)];
            again = false;
            if (row !== undefined) row = requeue(c.db, c.id, r.step);
            continue;
          }
          block(c, {
            kind: "stuck",
            cause: r.cut,
            step: r.step,
            text: `Needs you: the runs of part ${c.part.ord} reached their ${r.cut === "turns" ? "turn cap" : "time limit"} twice. Continue gives one more run.`,
          });
        }
        block(c, runReason(c, r));
      }
      const plan = await planChanges(c, r.changed);
      // ps5-plan.md D5: the row gets every tick of the tasks file against HEAD. A cut or stopped run keeps its ticks with its work, and
      // the next run row lists them. A run can leave the tasks file out of changed, so the file is read again.
      const all = plan.ticks.length ? plan.ticks : ((await ticksOf(c)) ?? []);
      if (all.length) patchStep(c.db, r.step, { ticked: all });
      const ticked = plan.ticks.filter((id) => !before.includes(id));
      // spec.md sections 6.20.6 and 6.25.4: the reason of another part stays. This part writes its question or plan change row and its
      // reason to its part row, or it halts without them when that row cannot keep the reason.
      if ((plan.spec.length || r.result.question) && held(c) && !keeps(c, r.step)) halt(c, r.step);
      if (plan.spec.length) {
        const attempt = (c.db.query(Q.rowAttempt).get({ id: r.step }) as { attempt: number }).attempt;
        const step = insertStep(c.db, { task: c.id, part: c.part.id, kind: "spec_change", item, attempt, state: "ok" }, now());
        endStep(c.db, step, "ok", { specChange: { paths: plan.spec }, notes: r.result.specChange ? [r.result.specChange] : [] }, now());
        block(c, { kind: "spec_change", step, text: "Needs you: Claude proposes a change to the spec." });
      }
      // part-session.md section 2.4: result.ticked should name the new ticks. A difference gives a Log note only.
      const listed = [...new Set(r.result.ticked)];
      if (mode === "implement" && (listed.length !== ticked.length || listed.some((id) => !ticked.includes(id))))
        patchStep(c.db, r.step, {
          notes: [
            ...stepDetailOf(c.db, r.step).notes,
            `Claude listed the ticks ${listed.join(", ") || "none"}, and the plan file holds the new ticks ${ticked.join(", ") || "none"}.`,
          ],
        });
      const q = r.result.question;
      if (q) {
        c.db.transaction(() => {
          c.db.query(Q.question).run({
            task: c.id,
            text: q.text,
            why: q.why,
            kind: q.options.length >= 2 ? "choice" : "text",
            options: JSON.stringify(q.options.length >= 2 ? q.options : []),
            recommended: q.options.length >= 2 && q.recommended !== null && q.recommended < q.options.length ? q.recommended : null,
            step: r.step,
            now: now(),
          });
        })();
        block(c, { kind: "question", step: r.step, text: `Needs you: Claude asks: ${oneLine(q.text)}` });
      }
      // spec.md section 6.18.2: needsBase runs the base check at once.
      if (r.result.needsBase) await refreshBases(c.db, c.id);
      return { ...r, result: r.result, unchanged, ticks: plan.ticks };
    }
  }

  // The approved checks with their step row. A stop kills the commands (AC-B19). baseline: the checks on the part base.
  async function checks(c: Ctx, item: string, kinds = CHECK_KINDS, baseline = false) {
    guard(c);
    const ac = new AbortController();
    enter(aborts, c.id, ac);
    try {
      changed(c.id);
      const head = (await clean(c)) ? await headOf(c.wt) : null;
      const r = await checkStep({
        db: c.db,
        dataDir,
        project: c.t.project,
        repo: c.t.repo,
        wt: c.wt,
        kinds,
        signal: ac.signal,
        task: c.id,
        part: c.part.id,
        item,
        attempt: nextAttempt(c, "check", item),
        baseline,
        now,
        onChange: () => changed(c.id),
      });
      if (r.status === "ran") patchStep(c.db, r.step, { head, commandsHash: checksHash(c, kinds) });
      changed(c.id);
      if (r.status === "refused") block(c, { kind: "error", cause: "app", step: r.step, text: `Needs you: ${r.reason}` });
      if (r.commands.some((x) => x.stopped)) throw new Halt();
      if (r.green || !heldByOther(c)) guard(c);
      return r;
    } finally {
      leave(aborts, c.id, ac);
    }
  }

  // The worktree has no change but the files of the last green setup.
  async function clean(c: Ctx) {
    const own = new Set(readSetupMark(c.wt)?.files ?? []);
    return (await status(c.wt)).every((e) => e.xy === "??" && own.has(e.path));
  }

  const checksHash = (c: Ctx, kinds: readonly CommandKind[]) =>
    setupHash(repoSettings(c.db, c.t.project, c.t.repo).commands.filter((x) => kinds.includes(x.kind)));

  // part-session.md section 9.3.3, guard checks (spec.md section 6.7, Final checks): the newest gate checks ended green at this head with
  // this command list, and the worktree holds no work of a Claude run after them. Files that a run left after its commit, such as new
  // files of Bash, count only with a later run, so the guard ends.
  async function gateDone(c: Ctx) {
    const r = c.db.query(Q.lastGate).get({ part: c.part.id }) as { id: number; state: string; detail_json: string } | null;
    if (r?.state !== "ok") return false;
    const d = stepDetail.parse(JSON.parse(r.detail_json));
    if (d.head !== (await headOf(c.wt)) || d.commandsHash !== checksHash(c, CHECK_KINDS)) return false;
    if (!c.db.query(Q.claudeAfter).get({ part: c.part.id, id: r.id })) return true;
    const own = setupFiles(c);
    return !(await dirty(c.trees)).some((p) => !own.has(p));
  }

  // part-session.md section 9.3.3, guard review: a commit of Claude's work has no own review yet, or an own review after it holds a
  // confirmed blocker or major point.
  function reviewDue(c: Ctx) {
    const runs = reviewsAfterWork(c.db, c.part.id);
    return runs !== null && (!runs.length || runs.some((run) => mustFix(pointsOf(c, run)).length > 0));
  }

  // spec.md section 6.7, Line endings, Repair (AC-B171): a part with line-ending-only changes from before the line end rule gets one
  // forward commit. Each file that changed since the part base takes the line ends of its base blob. The check runs once per set of
  // heads, and a repair that changes nothing commits nothing, so it never loops. A part with work that waits for its commit and an
  // adopted part get none.
  const baseMatched = new Set<string>();
  async function matchBase(c: Ctx) {
    if (c.part.adopted || !c.who || stepAfterCommit(c.db, c.part.id)) return;
    const trees = [
      { wt: c.wt, base: c.base, head: await headOf(c.wt) },
      ...(await changedSubs(c)).map((s) => ({ wt: s.tree.wt as Worktree, base: s.base, head: s.head })),
    ];
    const key = `${c.part.id}:${trees.map((x) => x.head).join(",")}`;
    if (baseMatched.has(key)) return;
    const off: typeof trees = [];
    for (const x of trees)
      if ((await changedLines(x.wt, x.base, x.head, [], true)).lines !== (await changedLines(x.wt, x.base, x.head, [])).lines) off.push(x);
    // The repair commit takes every tracked change, so each worktree must equal its HEAD first. A later check at these heads tries again.
    for (const t of off.length ? c.trees : [])
      if (t.wt && (t.row.role === "main" || t.row.access === "edit")) {
        if ((await wtGit(t.wt, ["diff", "--name-only", "--ignore-submodules=all", "HEAD"])).trim()) return;
      }
    baseMatched.add(key);
    if (!off.length) return;
    for (const x of off) await matchEol(x.wt, [], undefined, x.base);
    const message = `${c.label}: Match the line endings of the base`;
    await commitTask({
      db: c.db,
      task: c.id,
      part: c.part.id,
      wt: c.wt,
      item: "eol",
      message,
      who: c.who,
      allow: [],
      trees: c.trees,
      asIs: true,
      now,
    });
    changed(c.id);
  }

  // part-session.md section 2.6 item 7 (build-redesign.md Q1): the line-end repair, then the changed lines of the part against the line
  // budget. Over it, the commit row gets a note. The part never stops for it. step: the commit row; null counts only.
  async function sizeNote(c: Ctx, step: number | null) {
    await matchBase(c);
    const n = await countLines(c);
    if (n.lines <= c.budget || c.keep || step === null) return;
    const note = `This PR has ${n.lines} changed lines, over your ${c.budget} limit.`;
    patchStep(c.db, step, { notes: [...stepDetailOf(c.db, step).notes, note] });
  }

  // The changed lines and files of the part and of each changed repository, stored in task_part and task_pr (spec.md section 6.16.8:
  // the dialog row names both).
  async function countLines(c: Ctx): Promise<LineCount> {
    const n = await changedLines(c.wt, c.base, await headOf(c.wt), c.exclude);
    c.db.query(Q.lines).run({ id: c.part.id, lines: n.lines, files: n.files, now: now() });
    // spec.md section 6.16.6, Line budget: the sum over the changed repositories.
    for (const s of await changedSubs(c)) {
      const m = await changedLines(s.tree.wt as Worktree, s.base, s.head, c.exclude);
      c.db.query(Q.subLines).run({ part: c.part.id, repo: s.tree.row.id, lines: m.lines, files: m.files });
      n.files += m.files;
      n.added += m.added;
      n.removed += m.removed;
      n.lines += m.lines;
    }
    return n;
  }

  const deniedText = (p: PathProblem[]) =>
    `Needs you: the checks left ${p
      .slice(0, 3)
      .map((x) => x.path)
      .join(", ")}${p.length > 3 ? ` and ${p.length - 3} more` : ""}, which the app does not commit.`;

  // spec.md section 6.7, Commit, and part-session.md section 2.6 item 5: one commit per green gate with the user's name and email. The
  // body names the tasks that the commit ticks. Then the size note, and the session heads move (section 2.2). own: the files that the
  // app wrote for this commit, by absolute path. Returns the commit row, or null when nothing was to commit.
  async function commit(c: Ctx, item: string, message: string, allow: string[], own: string[] = []): Promise<number | null> {
    guard(c);
    if (!c.who) block(c, { kind: "error", cause: "app", step: null, text: "Needs you: set user.name and user.email in your git config." });
    // spec.md section 6.16.5, Size: a large build that changes a submodule stops.
    if (c.size === "large")
      for (const s of c.trees)
        if (s.row.role === "submodule" && s.wt && (await status(s.wt)).length)
          block(c, { kind: "size", cause: "large_repos", step: null, text: LARGE_REPOS_TEXT });
    const ticks = await ticksOf(c);
    const r = await commitTask({
      db: c.db,
      task: c.id,
      part: c.part.id,
      wt: c.wt,
      item,
      message: ticks?.length ? `${message}\n\nTasks done: ${ticks.join(", ")}` : message,
      who: c.who,
      allow,
      own,
      trees: c.trees,
      now,
    });
    if (r.status === "refused") block(c, { kind: "denied_path", cause: "commit", step: null, text: deniedText(r.problems) });
    if (r.status === "committed") draftFixes(c, r.commit);
    changed(c.id);
    const step = r.status === "committed" ? r.step : null;
    // ps5-plan.md D5: the ticks of the commit body.
    if (step !== null && ticks?.length) patchStep(c.db, step, { ticked: ticks });
    await sizeNote(c, step);
    if (step !== null) moveHeads(c.db, c.part.id, await headsNow(c), now());
    return step;
  }

  // ---------- PR comments of a task part (docs/plans/review-v2/ps6-ps7-plan.md section 4, PS6-B) ----------

  // AC-B392: the first commit after a comment run writes "Fixed in <short>: <reason>" for each thread that Claude fixed. After red checks
  // that is the commit after Continue. The reply run that sorted the comments owns the drafts. fix.commit is the full hash, because the
  // outbox matches pr_commit.hash.
  function draftFixes(c: Ctx, commit: string) {
    const rows = c.db.query(Q.undrafted).all({ part: c.part.id }) as { id: number }[];
    if (!rows.length) return;
    const me = settings.config()?.userSlug ?? null;
    c.db.transaction(() => {
      for (const { id } of rows) {
        const info = stepDetailOf(c.db, id).instruct;
        const k = info?.comments;
        if (!info || !k?.verdicts || k.drafted) continue;
        const drafts = currentDrafts(c.db, k.pr);
        for (const v of k.verdicts)
          if (v.verdict === "fixed")
            writeThreadDraft(c.db, drafts, me, {
              pr: k.pr,
              run: k.run,
              thread: v.thread,
              line: `Fixed in ${shortHash(commit)}: ${v.reason}`,
              reason: "The task committed the fix.",
              origin: "fix",
              fix: { id: null, commit },
              resolveEvidence: null,
            });
        patchStep(c.db, id, { instruct: { ...info, comments: { ...k, drafted: true } } });
      }
    })();
  }

  // AC-B392: a reset of the uncommitted work removed the fixes of each comment run of the part that waits for its commit, so no later
  // commit may claim them. step: a step row of the part.
  function closeComments(db: Database, step: number) {
    const part = (db.query(Q.stepPart).get({ id: step }) as { part: number | null } | null)?.part ?? null;
    if (part === null) return;
    db.transaction(() => {
      for (const { id } of db.query(Q.undrafted).all({ part }) as { id: number }[]) {
        const d = stepDetailOf(db, id);
        const info = d.instruct as InstructDetail;
        if (!info.comments) continue;
        patchStep(db, id, { instruct: { ...info, comments: { ...info.comments, drafted: true } }, notes: [...d.notes, RESET_COMMENTS] });
      }
    })();
  }

  // context/comments.md of a comment run: the sent threads as they are now, by group. A thread with no live message is left out.
  function commentsOf(c: Ctx, k: InstructComments): ContextFile {
    const pr = c.db.query(Q.prHeads).get({ id: k.pr }) as Parameters<typeof contextThreads>[1] | null;
    const now = new Map((pr ? contextThreads(c.db, pr, settings.config()?.userSlug ?? null, dataDir) : []).map((t) => [t.id, t]));
    const groups = groupsOf(k.threads).map((g) => ({ n: g.n, threads: g.threads.flatMap((t) => now.get(t.thread) ?? []) }));
    return commentsFile(groups.filter((g) => g.threads.length > 0));
  }

  // AC-B390 and AC-B391: one verdict per sent thread, kept in the run row. A push-back writes Claude's reason as the draft at once.
  function judgeComments(c: Ctx, r: { step: number; result: ImplementResult }, k: InstructComments) {
    const sent = new Set(k.threads.map((t) => t.thread));
    const verdicts: NonNullable<InstructComments["verdicts"]> = [];
    const notes: string[] = [];
    for (const p of r.result.points)
      if (!sent.has(p.id)) notes.push(`Claude gave a verdict for thread ${p.id}, which the run did not send. The app dropped it.`);
      else if (verdicts.some((v) => v.thread === p.id)) notes.push(`Claude gave thread ${p.id} a second verdict. The app kept the first.`);
      else verdicts.push({ thread: p.id, verdict: p.verdict, reason: p.reason.trim() });
    for (const t of k.threads) if (!verdicts.some((v) => v.thread === t.thread)) notes.push(`No verdict for thread ${t.thread}.`);
    const me = settings.config()?.userSlug ?? null;
    c.db.transaction(() => {
      const d = stepDetailOf(c.db, r.step);
      const info = d.instruct as InstructDetail;
      patchStep(c.db, r.step, { instruct: { ...info, comments: { ...k, verdicts } }, notes: [...d.notes, ...notes] });
      const drafts = currentDrafts(c.db, k.pr);
      for (const v of verdicts)
        if (v.verdict === "pushback")
          writeThreadDraft(c.db, drafts, me, {
            pr: k.pr,
            run: k.run,
            thread: v.thread,
            line: v.reason,
            reason: "Claude pushed back on the comment.",
            origin: "nofix",
            resolveEvidence: null,
          });
    })();
  }

  // The checks on the part base (spec.md section 6.7, Baseline), or null before they ran.
  function baselineOf(c: Ctx): BaseRun[] | null {
    const r = c.db.query(Q.baseline).get({ part: c.part.id }) as { detail_json: string } | null;
    if (!r) return null;
    return stepDetail.parse(JSON.parse(r.detail_json)).commands.map((x) => ({ name: x.name, argv: x.argv, red: x.exit !== 0 }));
  }

  // part-session.md section 2.6 items 3 and 4: the gate. Red checks start at most "Test-fix tries" fix runs (AC-B11). The value is read
  // when the checks first go red. check-fix.md items 1 and 3: red checks that all failed on the part base too stop once per item, and a
  // fix run that changes no file stops too. The base run tells only that the same argv failed, not why: a base with no test fails too.
  // So Continue lets the fixes run. The phase is checking at the start and at the end. Returns the green check row.
  async function greenOrFix(
    c: Ctx,
    item: string,
    allow: string[],
    step: (attempt: number) => ContextFile,
    purpose: SessionPurpose = "checks",
  ) {
    const base = baselineOf(c);
    let k = await checks(c, item);
    const fixTries = runLimitsOf(settings.config()?.runLimits).testFixTries;
    for (let tries = 0; !k.green; tries++) {
      const failed = k.commands.filter((x) => x.exit !== 0);
      const old = failed.filter((x) => {
        const b = onBase(x, base);
        return b?.red === true && b.same;
      });
      if (failed.length && old.length === failed.length && !c.db.query(Q.redBeforeSeen).get({ part: c.part.id, item })) {
        const names = old.map((x) => `"${oneLine(x.name)}"`);
        const list = names.length === 1 ? `the check ${names[0]}` : `the checks ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        patchStep(c.db, k.step, { redBefore: true });
        send(c, { type: "CHECKS_RED" }, { redBefore: true });
        block(c, {
          kind: "question",
          cause: "red_before",
          step: k.step,
          text: `Needs you: ${list} of part ${c.part.ord} also failed on the part base. See why. Continue lets Claude try to fix it.`,
        });
      }
      if (tries >= fixTries) {
        send(c, { type: "CHECKS_RED" });
        block(c, {
          kind: "red",
          cause: "checks",
          step: k.step,
          text: `Needs you: the checks of part ${c.part.ord} stay red after ${fixTries} ${fixTries === 1 ? "try" : "tries"}.`,
        });
      }
      send(c, { type: "CHECKS_RED" }, { triesLeft: true });
      const r = await claude(c, "fix", item, {
        allow,
        step,
        failure: checkFailure(k, base),
        purpose,
        tries: { n: tries + 1, of: fixTries },
      });
      if (r.unchanged) {
        send(c, { type: "RUN_DONE" }, { unchanged: true });
        block(c, {
          kind: "question",
          cause: "no_change",
          step: r.step,
          text: `Needs you: the fix run of part ${c.part.ord} changed no file. See why.`,
        });
      }
      send(c, { type: "RUN_DONE" });
      k = await checks(c, item);
    }
    return k;
  }

  const roundGate = (c: Ctx, round: Round): Gate => ({
    check: "checks",
    commit: round,
    subject: {
      build: `${c.label}: ${oneLine(c.title)}`,
      checks: `${c.label}: Fix the checks of part ${c.part.ord}`,
      critic: `${c.label}: Fix the critic points of part ${c.part.ord}`,
      review: `${c.label}: Fix the review points of part ${c.part.ord}`,
    }[round],
    step: (a) => partStepFile(c.plan, c.plan.parts, "checks", a),
  });

  // part-session.md section 2.6 items 5 and 6: the gate, then one commit. The gate stays green at the new HEAD, so GO goes on to the
  // review. ps4-plan.md section 1 gap 16 (AC-B347): a green gate at an unchanged HEAD runs no command. The phase is checking at the start
  // and idle at the end. Returns the commit row, or null when nothing committed.
  async function checkGate(c: Ctx, g: Gate): Promise<number | null> {
    if (await gateDone(c)) {
      send(c, { type: "CHECKS_GREEN" });
      return null;
    }
    const allow = allFiles(c);
    const k = await greenOrFix(c, g.check, allow, g.step);
    const step = await commit(c, g.commit, g.subject, allow);
    patchStep(c.db, k.step, { head: await headOf(c.wt) });
    send(c, { type: "CHECKS_GREEN" });
    return step;
  }

  // Saves the uncommitted changes as a patch, then returns the worktree to its last commit (spec.md section 6.7, Continue). Several
  // repositories: a patch per changed worktree, then the reset deepest first (section 6.16.6). The row of step names the first saved
  // patch, or PATCH_LOST: it marks the reset for the Continue rule (workOf). A second reset with the same step never replaces a patch, and
  // it keeps a mark that names a saved patch, because continue.md reads the work of the step from it.
  async function undo(trees: RepoTree[], db: Database, id: number, step: number): Promise<string | null> {
    const main = trees[0]?.wt as Worktree;
    if (!(await dirty(trees)).length && trees.every((t) => t.wt || !noneDirty(trees, t))) return null;
    const first = patchFile(dataDir, db, id, step);
    let file = first;
    for (let n = 1; trees.some((t) => existsSync(treePatch(file, t))); n++) file = first.replace(/\.patch$/, `.${n}.patch`);
    let saved: string | null = null;
    for (const t of trees) {
      if (!t.wt) continue;
      const paths = (await status(t.wt)).map((e) => e.path);
      if (!paths.length) continue;
      const s = await savePatch(t.wt, treePatch(file, t), paths).catch((e) => {
        log(`Task ${id}: could not save the patch of step ${step}: ${noUrl((e as Error).message)}`);
        return null;
      });
      saved ??= s;
    }
    if (!saved) log(`Task ${id}: the reset of step ${step} saved no patch.`);
    if (trees.length === 1) await resetWorktree(main, await headOf(main));
    else await resetTrees(trees, await headOf(main));
    const had = stepDetailOf(db, step).patch;
    if (had === null || had === PATCH_LOST) patchStep(db, step, { patch: saved ? basename(saved) : PATCH_LOST });
    closeComments(db, step);
    return saved && basename(saved);
  }

  // The own review run (kind review, task set, pr NULL) on a snapshot of the part head. sub: a changed submodule instead of the main
  // repository; its run reads that repository's base..head (spec.md section 6.16.5, Snapshots). critic: the critic run of
  // part-session.md section 2.7. A failed or cut critic gives a note and no point.
  async function reviewRun(c: Ctx, sub?: ChangedSub, critic = false): Promise<{ step: number; points: Point[] }> {
    const item = critic ? "critic" : "review";
    let waiting: number | null = null;
    for (;;) {
      guard(c);
      // spec.md section 6.17: the task text and the included files as they are at this step.
      const task = taskFilesOf(c.db, dataDir, c.t, filesFor(c));
      const issue = task.files.map((f) => f.text).join("\n\n");
      const head = sub ? sub.head : await headOf(c.wt);
      const prefix = `task:${c.id}:part:${c.part.id}:${item}:${sub ? `${sub.tree.row.id}:` : ""}${head}:`;
      // spec.md section 6.7, own review: a review of this repository at this head that ended ok gives its points again.
      const done = critic
        ? null
        : (c.db.query(Q.reviewAt).get({ part: c.part.id, key: `${prefix}%` }) as { id: number; run: number } | null);
      if (done) return { step: done.id, points: pointsOf(c, done.run) };
      const attempt = nextAttempt(c, "review", item);
      // pushback.md section 6.23.6 (AC-B111): the accepted push-backs of the part, so the own review does not raise them again.
      const history = critic
        ? null
        : pushbackHistory(
            (c.db.query(Q.accepted).all({ part: c.part.id }) as { id: number; payload_json: string }[]).map((x) => ({
              id: x.id,
              payload: JSON.parse(x.payload_json) as FindingPayload,
            })),
          );
      const src = sub
        ? sourceOf(
            c.trees.map((x) => x.row),
            sub.tree.row,
          )
        : null;
      const plans = planFiles(c).map((f) => `## ${f.name.slice("spec/".length)}\n\n${f.text}`);
      const goals = c.plan.parts.map((x) => `- Part ${x.n}: ${oneLine(x.title)}. ${oneLine(x.goal)}`);
      type Ended = {
        step: number;
        run: number;
        ok: boolean;
        cancelled: boolean;
        text: string | null;
        usage: boolean;
        resetsAt: number | null;
      };
      let ended: Ended | null = null;
      let step = 0;
      const start: TaskReviewStart = {
        task: c.id,
        kind: "review",
        key: `${prefix}${attempt}`,
        profile: critic ? CRITIC_PROFILE : c.profile,
        ...(critic && { critic: true as const }),
        project: src?.project ?? c.t.project,
        repo: src?.repo ?? c.t.repo,
        base: sub ? sub.base : c.base,
        head,
        taskKey: c.key,
        files: [
          { name: "task.md", text: `${issue || "(no task text)"}\n\n# The plan of the task\n\n${plans.join("\n\n")}\n` },
          {
            name: "pr.md",
            text: `# ${c.label}: ${oneLine(c.title)}\n\nThis change has no pull request yet. The app builds it for task ${c.key} on the branch ${c.part.branch}.${sub ? ` This review covers the ${sub.tree.row.role === "added" ? "repository" : "submodule"} at ${oneLine(sub.tree.full)} only.` : ""}\n\n## Goal\n\n${goals.join("\n")}\n`,
          },
          ...(history ? [history] : []),
        ],
        attachments: task.attachments,
        started: (d, run) => {
          step = runningStep(d, { task: c.id, part: c.part.id, kind: "review", run, item, attempt }, waiting, now());
        },
        finish: (d, run, e: Ending) => {
          const ok = e.status === "completed" || e.status === "incomplete";
          const ids = (d.query(Q.points).all({ run: run.id }) as { id: number }[]).map((x) => x.id);
          endStep(
            d,
            step,
            ok ? "ok" : e.status === "cancelled" ? "cancelled" : "failed",
            { findings: ids, notes: ok ? [] : [e.text ?? "The review failed."] },
            now(),
          );
          ended = {
            step,
            run: run.id,
            ok,
            cancelled: e.status === "cancelled",
            text: e.text ?? null,
            usage: e.kind === "usage_limit",
            resetsAt: e.outcome?.resetsAt ?? null,
          };
          return undefined;
        },
      };
      // headOf() awaited: a Stop can come before the run starts.
      guard(c);
      const s = review.taskRun(c.db, start, beside(c));
      if (s.status === 409) {
        waiting = await waitSlot(c, { kind: "review", item, attempt }, s.conflict, waiting);
        continue;
      }
      changed(c.id);
      await s.done;
      changed(c.id);
      const r = ended as Ended | null;
      // part-session.md section 9.3.4 (Q-SM1): a failed review of the build, of a follow-up, or of an update gives the reason error/run.
      // ps4-plan.md section 1 item 20: a review that hit the usage limit gives usage. The phase critic has no WAIT edge.
      if (!r || r.cancelled) throw new Halt();
      if (!r.ok && critic) {
        patchStep(c.db, r.step, { notes: [...stepDetailOf(c.db, r.step).notes, CRITIC_FAILED] });
        return { step: r.step, points: [] };
      }
      if (!r.ok && r.usage) block(c, usageReason(c, r.step, r.resetsAt));
      if (!r.ok)
        block(c, {
          kind: "error",
          cause: "run",
          step: r.step,
          text: `Needs you: the own review of part ${c.part.ord} failed. ${oneLine(r.text ?? "The review failed.")}`,
        });
      return { step: r.step, points: pointsOf(c, r.run) };
    }
  }

  const pointsOf = (c: Ctx, run: number): Point[] =>
    (c.db.query(Q.livePoints).all({ run }) as { id: number; payload_json: string }[]).map((x) => ({
      id: x.id,
      payload: JSON.parse(x.payload_json) as FindingPayload,
    }));

  // part-session.md sections 2.8 and 9.3.3: one round of the own review. Confirmed blocker and major points start a judging run, the
  // gate, and a commit, at most REVIEW_FIX_TRIES rounds (AC-B12). The other points stay listed in the review run. The phase is reviewing
  // at the start and idle at the end. Returns true after a judging round.
  async function reviewRound(c: Ctx): Promise<boolean> {
    const rv = await reviewRun(c);
    const must = mustFix(rv.points);
    // spec.md section 6.16.5: the own review runs once per changed repository. A submodule point names its path from the main root.
    for (const s of await changedSubs(c)) {
      const sr = await reviewRun(c, s);
      for (const x of mustFix(sr.points)) must.push({ ...x, payload: { ...x.payload, path: `${s.tree.full}/${x.payload.path}` } });
    }
    if (!must.length) {
      send(c, { type: "CLEAN" });
      return false;
    }
    const left = c.rounds < REVIEW_FIX_TRIES;
    send(c, { type: "POINTS" }, { roundsLeft: left });
    if (!left) {
      const n = must.length;
      block(c, {
        kind: "blocker",
        step: rv.step,
        text: `Needs you: Claude's review of part ${c.part.ord} still finds ${n} ${n === 1 ? "point" : "points"} to fix after ${REVIEW_FIX_TRIES} fixes.`,
      });
    }
    c.rounds++;
    const step = (a: number) => partStepFile(c.plan, c.plan.parts, "review", a);
    const r = await claude(c, "fix", "review", {
      allow: allFiles(c),
      step,
      failure: reviewFailure(must),
      purpose: "review",
      points: true,
      tries: { n: c.rounds, of: REVIEW_FIX_TRIES },
    });
    const back = judgePoints(c, r, must);
    send(c, { type: "RUN_DONE" });
    await checkGate(c, roundGate(c, "review"));
    askPushbacks(c, r.step, back, must);
    return true;
  }

  // part-session.md section 2.7 (AC-B359, AC-B360): the critic once after the first build commit. A failed or cut critic gave a note
  // and no point. Kept points start one judging run, then the gate and one commit. A push-back gives a Log line only. The phase is critic
  // at the start and idle at the end.
  async function criticRun(c: Ctx) {
    const { points } = await reviewRun(c, undefined, true);
    if (!points.length) {
      send(c, { type: "CLEAN" });
      return;
    }
    send(c, { type: "POINTS" });
    const step = (a: number) => partStepFile(c.plan, c.plan.parts, "review", a);
    const failure = reviewFailure(points, CRITIC_HEAD);
    const r = await claude(c, "fix", "critic", { allow: allFiles(c), step, failure, purpose: "critic", points: true });
    const back = judgePoints(c, r, points);
    if (back.length)
      patchStep(c.db, r.step, {
        notes: [
          ...stepDetailOf(c.db, r.step).notes,
          ...back.map((b) => `Claude pushes back on critic point ${b.id}: ${oneLine(b.reason)} Proof: ${oneLine(b.cite) || "none"}.`),
        ],
      });
    send(c, { type: "RUN_DONE" });
    await checkGate(c, roundGate(c, "critic"));
  }

  // pushback.md section 6.23.4 item 4: the path before ":" or "#" of a cite is a file of the part worktree, a plan file, or answers.md.
  // A cite is model output, so a path outside the worktree never counts. The run works in the part folder, so a cite can start with
  // repo/ (implement.ts). A repository can also hold its own repo/ folder, so the path as written counts too.
  function citeFound(c: Ctx, cite: string): boolean {
    const path = (cite.trim().split(/[:#]/)[0] ?? "").replace(/^\.\//, "");
    if (path === "answers.md" || docNames(c.size).some((n) => path === `spec/${n}.md`)) return true;
    return [path, path.replace(/^repo[\\/]/, "")].some(
      (p) => p !== "" && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && existsSync(onDisk(c.wt, p)),
    );
  }

  type Pushback = { id: number; why: FindingPushback["why"]; reason: string; cite: string; citeFound: boolean };
  // pushback.md section 6.23.4 items 1 and 4 (AC-B361): the verdicts of a judging run on the points of its failure.md. An unknown ID
  // drops with a note. A missing entry gives "No verdict for point N" and counts as fixed. forced: the user chose "Fix it anyway" for
  // each point, so a push-back drops with a note (section 6.23.6). Each other push-back gets payload.pushback. Returns them.
  function judgePoints(c: Ctx, r: { step: number; result: ImplementResult }, points: Point[], forced = false): Pushback[] {
    const ids = new Set(points.map((p) => p.id));
    const seen = new Set<number>();
    const notes: string[] = [];
    const back: Pushback[] = [];
    for (const v of r.result.points) {
      if (!ids.has(v.id)) {
        notes.push(`Claude gave a verdict on point ${v.id}, which failure.md does not hold. The app dropped it.`);
        continue;
      }
      if (seen.has(v.id)) {
        notes.push(`Claude gave more than one verdict on point ${v.id}. The app used the first one.`);
        continue;
      }
      seen.add(v.id);
      if (v.verdict !== "pushback") continue;
      if (forced) {
        notes.push(`The user decided to fix point ${v.id}.`);
        continue;
      }
      back.push({ id: v.id, why: v.why, reason: v.reason, cite: v.cite, citeFound: citeFound(c, v.cite) });
    }
    for (const id of ids) if (!seen.has(id)) notes.push(`No verdict for point ${id}.`);
    const kept: Pushback[] = [];
    c.db.transaction(() => {
      if (notes.length) patchStep(c.db, r.step, { notes: [...stepDetailOf(c.db, r.step).notes, ...notes] });
      for (const { id, ...b } of back) {
        const row = c.db.query(Q.item).get({ id }) as { payload_json: string } | null;
        if (!row) continue;
        const payload: FindingPayload = { ...JSON.parse(row.payload_json), pushback: { step: r.step, ...b, fixedBy: null } };
        c.db.query(Q.setPayload).run({ id, payload: JSON.stringify(payload) });
        kept.push({ id, ...b });
      }
    })();
    return kept;
  }

  // pushback.md section 6.23.4 item 3 (AC-B361): after the gate, one question per push-back with point set and no recommended answer,
  // then the reason question/claude at idle. step: the judging row. Its part halts as claude() does when its row cannot keep the reason.
  function askPushbacks(c: Ctx, step: number, back: Pushback[], points: Point[]) {
    if (!back.length) return;
    if (onHold(c.db, c.part.id)) throw new Halt();
    if (held(c) && !keeps(c, step)) halt(c, step);
    c.db.transaction(() => {
      const round = (c.db.query(Q.round).get({ task: c.id }) as { n: number }).n;
      for (const [ord, b] of back.entries()) {
        const f = (points.find((x) => x.id === b.id) as Point).payload;
        c.db.query(Q.pushback).run({
          task: c.id,
          round,
          ord,
          text: `Review point ${b.id} (${f.severity}, ${oneLine(f.path)}:${f.line}): ${oneLine(f.title || f.body).slice(0, 200)}`,
          why: `Claude: ${oneLine(b.reason)} Proof: ${oneLine(b.cite) || "none"}`,
          options: JSON.stringify(PUSHBACK_OPTIONS),
          step,
          point: b.id,
          now: now(),
        });
      }
    })();
    const n = back.length;
    block(c, {
      kind: "question",
      cause: "claude",
      step,
      text: `Needs you: Claude disagrees with ${n === 1 ? "1 review point" : `${n} review points`} of part ${c.part.ord}. Judge ${n === 1 ? "it" : "them"}.`,
    });
  }

  // The own review after an update with a resolve run (part-session.md section 9.3.3, Q57): GO with the guard review, round by round,
  // while the review is due. GO picks no other phase here, so the update adds no setup or baseline step.
  async function ownReview(c: Ctx) {
    while (reviewDue(c)) {
      send(c, { type: "GO" }, { review: true });
      // A stored review at an unchanged head writes no row, so CLEAN ends the rounds.
      if (!(await reviewRound(c))) return;
    }
  }

  // ---------- The driver ----------

  // The branch of a part from its planned name (spec.md section 6.16.4). A name that exists on the server: Continue builds on its remote
  // head and leases the first push on it. New takes the first free suffix. from: the start commit in the main repository. label: its
  // branch, for the error text.
  async function branchOf(db: Database, t: TaskRow, name: string, existing: "continue" | "new" | undefined, from: string, label: string) {
    const id = t.id;
    const remote = await review.taskRemote(t.project, t.repo);
    const cache = cachePath(longPath(dataDir), { project: t.project, repo: t.repo, id });
    let branch = name;
    let lease: string | null = null;
    let base = from;
    // spec.md section 6.16.4 with several repositories: Continue takes the remote branch where it exists; New takes the first suffix that
    // is free in every repository with access edit. A submodule starts at its pinned commit, an added repository at its base commit.
    const startOf = (r: TaskRepoRow) => r.pinned ?? r.base_commit;
    const subs = taskRepos(db, t).filter((r) => r.role !== "main" && r.access === "edit" && r.project && r.repo && startOf(r));
    const subRemotes = await Promise.all(subs.map((r) => review.taskRemote(r.project as string, r.repo as string)));
    const subHeads = await Promise.all(subRemotes.map((r) => remoteBranches(dataDir, r, name)));
    const subLeases: { row: TaskRepoRow; lease: string; base: string }[] = [];
    const mainHeads = await remoteBranches(dataDir, remote, name);
    if ((mainHeads.has(name) || subHeads.some((h) => h.has(name))) && existing !== "new") {
      if (mainHeads.has(name)) {
        lease = await takeRemoteBranch(dataDir, cache, remote, id, name);
        const mb = await mergeBase(dataDir, cache, from, lease);
        if (!mb) throw new Error(`${name} on the server shares no commit with ${label}. Start a new branch.`);
        base = mb;
      }
      for (const [k, row] of subs.entries()) {
        if (!subHeads[k]?.has(name)) continue;
        const subCache = cachePath(longPath(dataDir), { project: row.project as string, repo: row.repo as string, id });
        const l = await takeRemoteBranch(dataDir, subCache, subRemotes[k] as BranchRemote, id, name);
        const mb = await mergeBase(dataDir, subCache, startOf(row) as string, l);
        if (!mb) throw new Error(`${name} in ${row.project}/${row.repo} shares no commit with its start commit. Start a new branch.`);
        subLeases.push({ row, lease: l, base: mb });
      }
    } else if (!subs.length) branch = await freeBranch(dataDir, cache, remote, name);
    else {
      const taken = await takenBranches(dataDir, cache, remote, name);
      for (const [k, row] of subs.entries()) {
        const subCache = cachePath(longPath(dataDir), { project: row.project as string, repo: row.repo as string, id });
        for (const b of await takenBranches(dataDir, subCache, subRemotes[k] as BranchRemote, name)) taken.add(b);
      }
      branch = firstFree(name, taken);
    }
    return { branch, lease, base, subLeases };
  }

  // A submodule that continues a remote branch: its base and its lease (spec.md section 6.16.4). In the transaction of the part start.
  function saveSubLeases(db: Database, part: number, b: Awaited<ReturnType<typeof branchOf>>) {
    for (const x of b.subLeases) {
      db.query(Q.subBase).run({ id: x.row.id, base: x.base });
      db.query(Q.subLease).run({ part, repo: x.row.id, branch: b.branch, base: x.row.base_branch ?? "", commit: x.base, lease: x.lease });
    }
  }

  // A small task gets one part (spec.md section 6.16.4).
  async function ensureParts(db: Database, id: number) {
    const t = taskRow(db, id);
    if (t?.state !== "implementing" || parts(db, id).length) return;
    if (t.size !== "small") throw new Error(`The app builds a ${t.size ?? "task without a size"} task only after its spec PR.`);
    if (!t.base_commit) throw new Error("The task has no approved plan.");
    const s = taskSettingsOf(t);
    const prefix = s.branchPrefix ?? (branchPrefixesOf(settings.config())[0] as string);
    const name = branchName(prefix, t.key, { kind: "small", title: t.title });
    const b = await branchOf(db, t, name, s.existing, t.base_commit, t.target_branch);
    db.transaction(() => {
      const cur = taskRow(db, id);
      if (cur?.state !== "implementing" || parts(db, id).length) return;
      const at = now();
      // The line budget and the own review count the whole PR diff from here (spec.md section 6.16.4).
      db.query(Q.setBase).run({ id, base: b.base });
      const row = db.query(Q.insertPart).get({
        task: id,
        ord: 1,
        kind: "single",
        title: cur.title,
        branch: b.branch,
        base: cur.target_branch,
        pushed: b.lease,
        state: String(initialTransition(partMachine)[0].value),
        now: at,
      }) as { id: number };
      saveSubLeases(db, row.id, b);
      const r = advancePart(db, { task: id, version: cur.version, part: row.id }, { type: "START" }, {}, at);
      if (r.status !== 200) throw new Error(r.error);
    })();
    changed(id);
  }

  // spec.md section 6.20.6, Start of a part: the part that the scheduler picks. A part on top of another part branches from the pushed
  // head of the lower part, or from the fetched head of a tracked lower branch. Else it branches from the fetched head of the task base.
  // Its branch continues the found branch of its key that the plan approval took (Continue), else it takes the first free suffix.
  // Returns the part in state implementing, or null when no part starts.
  async function startPart(db: Database, id: number): Promise<PartRow | null> {
    const t = taskRow(db, id);
    if (t?.state !== "implementing" || t.blocked_json !== null) return null;
    const all = parts(db, id);
    const pick = scheduleOf(db, t, all)?.starts[0];
    const part = pick ? all.find((p) => p.id === pick.id) : undefined;
    if (!pick || !part) return null;
    const lower = pick.on === null ? null : (all.find((p) => p.id === pick.on) ?? null);
    const names = partNames(t.key, all);
    const name = (p: PartRow) => names.get(p.id)?.text ?? t.key;
    if (lower) {
      // design.md Q67: a part on top of a part that also changed another repository waits for its merge.
      const other = db.query(Q.otherRepo).get({ part: lower.id }) as { project: string; repo: string } | null;
      if (other) {
        const text = `Needs you: ${name(part)} builds on ${name(lower)}, which also changes ${other.project}/${other.repo}. Let ${name(part)} wait for the merge of ${name(lower)}.`;
        reason(db, id, { kind: "error", step: null, part: part.id, text });
        return null;
      }
    }
    const baseBranch = lower ? lower.branch : t.target_branch;
    const main = taskRepos(db, t).find((r) => r.role === "main") as TaskRepoRow;
    const from =
      lower?.adopted === 0 && lower.pushed
        ? lower.pushed
        : await fetchBase(
            dataDir,
            id,
            { row: main, project: t.project, repo: t.repo, base: baseBranch } as UpdateRepo,
            await review.taskRemote(t.project, t.repo),
          );
    const found = db.query(Q.found).get({ task: id, key: keysOf(part)[0] ?? t.key }) as { found_json: string } | null;
    const picked = !!found && foundOf(found.found_json).some((f) => f.kind === "branch" && f.error === null && f.name === part.branch);
    const b = await branchOf(db, t, part.branch, picked ? "continue" : "new", from, baseBranch);
    // spec.md section 6.16.7: the pre-flight passes before any Claude step of the part.
    const pf = await preflight(db, preflightDeps, t, b.branch, null);
    if (pf) {
      reason(db, id, pf);
      return null;
    }
    const started = db.transaction((): boolean => {
      const cur = taskRow(db, id);
      if (cur?.state !== "implementing" || cur.blocked_json !== null) return false;
      // The awaits above let other parts move: the part starts only when the scheduler still starts it.
      if (!scheduleOf(db, cur, parts(db, id))?.starts.some((s) => s.id === part.id)) return false;
      const at = now();
      const row = { id: part.id, branch: b.branch, base: baseBranch, commit: b.base, pushed: b.lease, now: at };
      if (db.query(Q.partStart).run(row).changes !== 1) return false;
      saveSubLeases(db, part.id, b);
      const r = advancePart(db, { task: id, version: cur.version, part: part.id }, { type: "START" }, {}, at);
      if (r.status !== 200) throw new Error(r.error);
      return true;
    })();
    changed(id);
    return started ? (buildingAll(db, id).find((p) => p.id === part.id) ?? null) : null;
  }

  // The worktrees of every repository of a part (spec.md section 6.16.5). One repository: the main worktree only.
  async function trees(db: Database, t: TaskRow, part: PartRow, wt: Worktree): Promise<RepoTree[]> {
    const rows = taskRepos(db, t);
    if (rows.length === 1) return [{ row: rows[0] as TaskRepoRow, full: "", wt }];
    return openRepoTrees({ dataDir, db, task: t.id, ord: part.ord, branch: part.branch, main: wt, rows });
  }

  async function context(db: Database, t: TaskRow, part: PartRow, mode: DriverMode = "build"): Promise<Ctx> {
    // spec.md section 6.20.6: a part of a task with sub-tasks has its own plan, base commit, and plan folder.
    const docs = partDocsOf(db, t, part);
    const base = baseOf(t, part);
    if (!docs || !base || !t.size) throw new Error("The task has no approved plan.");
    const repo = repoSettings(db, t.project, t.repo);
    const wt = await openWorktree({
      dataDir,
      db,
      project: t.project,
      repo: t.repo,
      task: t.id,
      ord: part.ord,
      branch: part.branch,
      base,
    });
    const clone = db.query(Q.clone).get({ project: t.project, repo: t.repo }) as { path: string } | null;
    const p = taskProfile(settings.profiles(), t);
    const name = t.subtasks === 1 ? partNames(t.key, parts(db, t.id)).get(part.id) : undefined;
    return {
      db,
      id: t.id,
      t,
      part,
      wt,
      trees: await trees(db, t, part, wt),
      base,
      key: name?.key ?? t.key,
      label: name?.commit ?? t.key,
      title: name ? part.title : t.title,
      specDir: part.spec_dir ?? t.spec_dir,
      size: t.size,
      docs,
      plan: docs.parsed,
      budget: budgetOf(db, t),
      keep: taskSettingsOf(t).keepOnePr === true,
      exclude: repo.excludeGlobs ?? LOCK_GLOBS,
      testGlobs: repo.testGlobs,
      who: await identity(clone?.path ?? null),
      // AC-B12: the own review runs the finder and the verify phase.
      profile: { ...p, verifier: { ...p.verifier, mode: "on" } },
      mode,
      phase: null,
      rounds: 0,
      waited: false,
      follow: null,
    };
  }

  // spec.md section 6.7: the setup commands run before the first step in a worktree, and again when the mark of the worktree does not
  // hold the hash of the current list. A reset that removed a file of the green setup deletes the mark (resetWorktree), and so does
  // "Run setup again". A failed run leaves no mark, so the next build runs setup again.
  async function setup(c: Ctx) {
    const list = repoSettings(c.db, c.t.project, c.t.repo).commands.filter((x) => x.kind === "setup");
    const hash = setupHash(list);
    if (readSetupMark(c.wt)?.hash === hash) return;
    rmSync(setupMark(c.wt), { force: true });
    const untracked = async () => (await status(c.wt)).filter((e) => e.xy === "??").map((e) => e.path);
    const before = new Set(await untracked());
    if (list.length) {
      const r = await checks(c, "setup", ["setup"]);
      // The Task view offers "Change the time limit" for a red setup step with a command that reached its time limit.
      const late = r.status === "ran" ? r.commands.find((x) => x.timedOut) : undefined;
      if (late)
        block(c, {
          kind: "red",
          cause: "setup_time",
          step: r.step,
          text: `Needs you: the setup command "${oneLine(late.name)}" of part ${c.part.ord} reached its time limit of ${limitText(late.timeoutSec ?? 0)}.`,
        });
      if (!r.green)
        block(c, {
          kind: "red",
          cause: "setup",
          step: r.step,
          text: `Needs you: the setup commands of part ${c.part.ord} failed. See why.`,
        });
    }
    writeSetupMark(c.wt, { hash, files: (await untracked()).filter((p) => !before.has(p)) });
  }

  // part-session.md sections 2.3 and 2.6: the build run of the open tasks. Done true with every open task ticked goes to the gate. Else
  // the part waits with the reason unfinished. The phase is building at the start and idle at the end.
  async function buildRun(c: Ctx) {
    const step = (a: number) => partStepFile(c.plan, c.plan.parts, "build", a);
    const r = await claude(c, "implement", "build", { allow: allFiles(c), step, purpose: "build" });
    refreshPlan(c);
    if (!r.result.done || openTasks(c).length)
      block(c, {
        kind: "unfinished",
        step: r.step,
        text: `Needs you: Claude ended the run before part ${c.part.ord} was done: ${oneLine(r.result.summary)} Continue goes on with the open tasks.`,
      });
    send(c, { type: "RUN_DONE" });
    await checkGate(c, roundGate(c, "build"));
  }

  // part-session.md section 2.6 item 10: a part that changed no path of the test globs gets a note on its last commit row.
  async function testNote(c: Ctx) {
    const last = (c.db.query(Q.workCommit).get({ part: c.part.id }) as { id: number | null }).id;
    if (last === null) return;
    const globs = c.testGlobs ?? DEFAULT_TEST_GLOBS;
    const paths = (await wtGit(c.wt, ["diff", "--name-only", "-z", "--ignore-submodules=all", c.base, "HEAD"])).split("\0");
    if (paths.some((p) => p && globs.some((g) => globMatch(g, p)))) return;
    patchStep(c.db, last, { notes: [...stepDetailOf(c.db, last).notes, NO_TEST_FILE] });
  }

  // part-session.md section 9.3.3, Context: the facts of GO from the rows and the worktree. ps4-plan.md section 2.2: follow is a waiting
  // follow-up row. run needs an implementing part.
  async function factsOf(c: Ctx): Promise<PhaseContext> {
    const setups = repoSettings(c.db, c.t.project, c.t.repo).commands.filter((x) => x.kind === "setup");
    return {
      ...NO_FACTS,
      setup: readSetupMark(c.wt)?.hash !== setupHash(setups),
      baseline: !c.db.query(Q.started).get({ part: c.part.id }),
      follow: c.db.query(Q.follow).get({ part: c.part.id }) !== null,
      run: c.part.state === "implementing" && openTasks(c).length > 0,
      checks: !(await gateDone(c)),
      // ps4-plan.md section 2.2, guard critic: once per build, after the restart mark.
      critic:
        c.part.state === "implementing" &&
        c.db.query(Q.buildCommit).get({ part: c.part.id }) !== null &&
        c.db.query(Q.criticRan).get({ part: c.part.id }) === null,
      review: reviewDue(c),
    };
  }

  // part-session.md section 9.3.3: the GO loop of one part. GO picks the next phase from the facts until no guard holds. once: the loop
  // ends after the first follow-up, so buildParts builds the part on. A follow-up driver also ends after a follow-up that changed no file
  // (spec.md section 6.18.2, step 2). The phase is idle at the start and at the end.
  async function phases(c: Ctx, once = false) {
    try {
      for (;;) {
        guard(c);
        refreshPlan(c);
        const facts = await factsOf(c);
        if (!phaseMachine.resolveState({ value: "idle", context: facts }).can({ type: "GO" })) return;
        send(c, { type: "GO" }, facts);
        const at = c.phase as Phase;
        if (at === "setup") {
          await setup(c);
          send(c, { type: "CLEAN" });
        } else if (at === "baseline") {
          await checks(c, "base", CHECK_KINDS, true);
          send(c, { type: "CLEAN" });
        } else if (at === "following") {
          if (!(await followRun(c)) && c.mode !== "build") return;
          if (once) return;
        } else if (at === "building") await buildRun(c);
        else if (at === "checking")
          await checkGate(c, roundGate(c, c.db.query(Q.buildCommit).get({ part: c.part.id }) ? "checks" : "build"));
        else if (at === "critic") await criticRun(c);
        else if (at === "reviewing") await reviewRound(c);
        else throw new Error(`GO picked the phase ${at}, which the loop does not run.`);
      }
    } catch (e) {
      // WAIT: the step ended with a reason of this part. STOPPED: a Stop, the app stop, or the reason of another part ended it.
      if (e instanceof Halt && c.phase !== "idle") send(c, { type: c.waited ? "WAIT" : "STOPPED" });
      throw e;
    }
  }

  // ps4-plan.md WP-3, phase following: one follow-up run of the part session on the oldest waiting follow-up row. An instruct row runs
  // "Your instructions" (spec.md section 6.18.2). A fix row with item points runs "Fix these too" with the open points. A fix row with
  // item pushback runs "Fix it anyway" with the points in its findings (pushback.md section 6.23.6). A run that changes no file gives
  // back the reason before the follow-up and returns false. Else the gate and one commit follow. The push-backs of a fix row get their
  // questions at the end (AC-B363). An instruct row with purpose comments runs the sent PR threads in context/comments.md (ps6-ps7-plan.md
  // section 4, PS6-B). The phase is following at the start and idle at the end.
  async function followRun(c: Ctx): Promise<boolean> {
    const q = c.db.query(Q.follow).get({ part: c.part.id }) as { id: number; kind: StepMode; item: string };
    const moved = c.db.query(Q.renew).get({ id: q.id, part: c.part.id, task: c.id, now: now() }) as { id: number } | null;
    const f = moved ? { ...q, id: moved.id } : q;
    c.follow ??= f.id;
    const info = stepDetailOf(c.db, f.id).instruct;
    const k = info?.purpose === "comments" ? info.comments : null;
    const allow = allFiles(c);
    const step = (a: number) => partStepFile(c.plan, c.plan.parts, k ? "comments" : info ? "instruct" : "review", a);
    const forced = f.item === "pushback";
    const points: Point[] = info
      ? []
      : forced
        ? stepDetailOf(c.db, f.id).findings.flatMap((id) => {
            const row = c.db.query(Q.item).get({ id }) as { payload_json: string } | null;
            return row ? [{ id, payload: JSON.parse(row.payload_json) as FindingPayload }] : [];
          })
        : openPoints(c.db, c.id);
    if (!info && !points.length) {
      endStep(c.db, f.id, "cancelled", { notes: [NO_POINTS] }, now());
      send(c, { type: "RUN_DONE" }, { unchanged: true });
      return false;
    }
    const r = await claude(
      c,
      f.kind,
      f.item,
      k
        ? { allow, step, row: f.id, failure: commentsOf(c, k), purpose: "comments" }
        : info
          ? { allow, step, row: f.id, instructions: info.text, purpose: "message" }
          : { allow, step, row: f.id, failure: reviewFailure(points), purpose: forced ? "review" : "points", points: true },
    );
    const back = info ? [] : judgePoints(c, r, points, forced);
    if (k) judgeComments(c, r, k);
    // The run row holds the verdicts now, so each patch reads it again.
    const ran = () => stepDetailOf(c.db, r.step).instruct ?? (info as InstructDetail);
    if (!r.changed.length || r.unchanged) {
      // spec.md section 6.18.2, step 2: no check, commit, or review runs, and the task waits as before the follow-up.
      send(c, { type: "RUN_DONE" }, { unchanged: true });
      if (info) {
        // A run with no change has no commit, so its "fixed" verdicts get no draft.
        const x = ran();
        patchStep(c.db, r.step, { instruct: { ...x, result: "no_change", comments: x.comments && { ...x.comments, drafted: true } } });
        // A message of the build driver (WP-7) has no reason before it. A null here would clear the reason of another part.
        if (info.blockedBefore) reason(c.db, c.id, info.blockedBefore);
      }
      askPushbacks(c, r.step, back, points);
      return false;
    }
    send(c, { type: "RUN_DONE" });
    const subject = k
      ? `Address the PR comments of part ${c.part.ord}`
      : info
        ? firstLine(info.text)
        : forced
          ? `Fix the chosen review points of part ${c.part.ord}`
          : `Fix the small review points of part ${c.part.ord}`;
    // ps4-plan.md section 2.5: a fix row of the gate maps to fixing, so its item is no follow-up item.
    const done = await checkGate(c, { check: info ? f.item : "checks", commit: f.item, subject: `${c.label}: ${subject}`, step });
    if (info) patchStep(c.db, r.step, { instruct: { ...ran(), result: "done", committed: true } });
    // pushback.md section 6.23.6: the commit of "Fix it anyway" sets fixedBy.
    if (forced && done !== null)
      c.db.transaction(() => {
        for (const p of points) {
          const row = c.db.query(Q.item).get({ id: p.id }) as { payload_json: string } | null;
          const payload = row ? (JSON.parse(row.payload_json) as FindingPayload) : null;
          if (payload?.pushback)
            c.db
              .query(Q.setPayload)
              .run({ id: p.id, payload: JSON.stringify({ ...payload, pushback: { ...payload.pushback, fixedBy: done } }) });
        }
      })();
    askPushbacks(c, r.step, back, points);
    return true;
  }

  // part-session.md section 9.3.3: the build of one part. When no guard of GO holds, the part has no work: REVIEWED and PART_READY.
  async function runPart(db: Database, t: TaskRow, part: PartRow) {
    const repo = repoSettings(db, t.project, t.repo);
    if (!repo.commands.some((x) => x.kind === "test")) {
      reason(db, t.id, { kind: "error", cause: "app", step: null, text: NO_TEST });
      throw new Halt();
    }
    const c = await context(db, t, part);
    c.phase = "idle";
    guard(c);
    // spec.md section 6.4: the plan files go into the part branch first.
    const missing = docNames(c.size).filter((n) => !existsSync(onDisk(c.wt, specPath(c.specDir, n))) && c.docs[n] !== undefined);
    for (const n of missing) {
      const p = onDisk(c.wt, specPath(c.specDir, n));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c.docs[n] as string);
    }
    const plan = missing.map((n) => onDisk(c.wt, specPath(c.specDir, n)));
    if (missing.length) await commit(c, "plan", `${c.label}: Add the plan`, [], plan);
    await sizeNote(c, null);
    await phases(c);
    await testNote(c);
    db.transaction(() => {
      const cur = taskRow(db, t.id);
      if (cur?.state !== "implementing" || blocks(cur)) return;
      const p = advancePart(db, { task: t.id, version: cur.version, part: part.id }, { type: "REVIEWED" }, {}, now());
      if (p.status === 200) advance(db, { task: t.id, version: p.version }, { type: "PART_READY" }, {}, now());
    })();
    changed(t.id);
  }

  // build-redesign.md section 2.2, the Continue rule: a part keeps its uncommitted work when the newest Claude step after its last commit
  // has checked. Else the work goes to the patch of that step, and the worktree goes back to the last commit (spec.md section 6.7,
  // Continue). A reset after that step already saved its work. given: the trees of a driver that opened them.
  async function settle(db: Database, t: TaskRow, part: PartRow, given?: RepoTree[]) {
    const { reset, all } = workOf(db, part.id);
    const w = all.at(-1);
    if (!w || w.detail.checked || (reset && reset.id >= w.id)) return;
    if (given) return undo(given, db, t.id, w.id);
    const base = baseOf(t, part);
    if (!base) return;
    const wt = await openWorktree({ dataDir, db, project: t.project, repo: t.repo, task: t.id, ord: part.ord, branch: part.branch, base });
    await undo(await trees(db, t, part, wt), db, t.id, w.id);
  }

  // The parts that wait for their build. A task with sub-tasks builds at most buildsAtOnce parts at the same time, each in its own
  // worktree (spec.md section 6.20.6). It asks the scheduler again after each start, each end of a part, and each kick, and it ends when
  // no part builds. The first reason holds every part: each one halts at its next step, and the driver ends. A part halts at most once per
  // driver. A part that another driver left in its build gets the Continue rule first (settle). keep: Continue of the legacy reason
  // question/paused (part-session.md section 9.4) builds with no reset, so each part keeps its changes.
  async function buildParts(db: Database, id: number, keep = false) {
    const running = new Map<number, Promise<void>>();
    const ended = new Set<number>();
    let again = false;
    let wake: (() => void) | null = null;
    // A part that a poke names while its run still ends builds again after that end.
    const rerun = new Set<number>();
    pokes.set(id, (part) => {
      if (part !== undefined) {
        ended.delete(part);
        rerun.add(part);
      }
      again = true;
      wake?.();
    });
    // The part stays claimed until its run end and path check are done, so Skip and Start again wait for it (ps4-plan.md WP-4).
    const go = (part: PartRow, resumed: boolean) => {
      rerun.delete(part.id);
      const p = (async () => {
        const t = taskRow(db, id) as TaskRow;
        if (resumed && t.subtasks === 1) await settle(db, t, part);
        await runPart(db, taskRow(db, id) as TaskRow, part);
      })()
        .catch((e) => failed(db, id, e))
        .finally(() => {
          leave(active, id, part.id);
          running.delete(part.id);
          if (!rerun.delete(part.id)) ended.add(part.id);
        });
      running.set(part.id, p);
    };
    try {
      for (;;) {
        again = false;
        const t = taskRow(db, id);
        if (closing || stopping.has(id) || t?.state !== "implementing" || blocks(t)) {
          // The parts that wait for the run slot see the reason or the stop and halt.
          slotWaits.get(id)?.();
        } else {
          // ps4-plan.md section 2.6: a held part does not build.
          for (const p of buildingAll(db, id))
            if (!running.has(p.id) && !ended.has(p.id) && !onHold(db, p.id) && claim(id, p.id)) go(p, !keep);
          if (t.subtasks === 1)
            for (let p = await startPart(db, id); p; p = await startPart(db, id)) {
              if (claim(id, p.id)) go(p, false);
              if (closing) break;
            }
        }
        // A poke during the await of startPart sets again with no part running.
        if (!running.size && !again) return;
        if (!again)
          await new Promise<void>((resolve) => {
            wake = resolve;
            void Promise.race(running.values()).then(() => resolve());
          });
        wake = null;
      }
    } finally {
      pokes.delete(id);
    }
  }

  // reset: the Continue rule for each part that builds.
  async function drive(db: Database, id: number, reset: Reset, keep = false) {
    try {
      await recoverUpdates(db, id);
      const t = taskRow(db, id);
      // A held part keeps its work until Continue with its part. A part that a route works on is not this driver's.
      if (reset && t)
        for (const part of buildingAll(db, id))
          if (!onHold(db, part.id) && claim(id, part.id))
            try {
              await settle(db, t, part);
            } finally {
              leave(active, id, part.id);
            }
      // spec.md section 6.16.7: the pre-flight passes before any Claude step of the build. A part of a task with sub-tasks runs it at its
      // start (startPart), and again for each part that builds when a driver starts.
      const t0 = taskRow(db, id);
      if (t0?.state === "implementing" && t0.blocked_json === null) {
        const branches = t0.subtasks === 1 ? buildingAll(db, id).map((p) => p.branch) : [plannedBranch(db, t0)];
        for (const branch of branches) {
          const b = await preflight(db, preflightDeps, t0, branch, null);
          if (b) {
            reason(db, id, b);
            return;
          }
        }
      }
      await ensureParts(db, id);
      await buildParts(db, id, keep);
    } catch (e) {
      failed(db, id, e);
    }
  }

  // An error that no reason covers stops the task. Resume starts the step again.
  function failed(db: Database, id: number, e: unknown) {
    if (e instanceof Halt) return;
    const text = `The build stopped: ${noUrl((e as Error).message)}`;
    log(`Task ${id}: ${text}`);
    try {
      db.transaction(() => {
        const cur = taskRow(db, id);
        if (cur) stopForRun(db, { task: id, version: cur.version }, null, { status: "failed", text }, now());
      })();
      changed(id);
    } catch (e2) {
      log(`Task ${id}: could not stop the build: ${(e2 as Error).message}`);
    }
  }

  // One driver per task. mode: an instruct step or an update, whose Stop keeps the task state. spec.md section 6.18.5: a driver ends at a
  // waiting state, so the base check runs before the driver leaves. The change notice comes after it, so a page reads working false.
  function start(db: Database, id: number, f: () => Promise<void>, mode?: Exclude<DriverMode, "build">) {
    if (drivers.has(id) || closing) {
      // spec.md section 6.20.6: a driver that builds parts asks the scheduler again, so a part that can start now starts beside them.
      if (!mode) pokes.get(id)?.();
      return false;
    }
    if (mode) modes.set(id, mode);
    const p = f()
      .then(async () => {
        if (closing || stopping.has(id)) return;
        ending.add(id);
        await refreshBases(db, id);
      })
      .catch((e) => log(`Task ${id}: the driver end failed: ${noUrl((e as Error).message)}`))
      .finally(() => {
        ending.delete(id);
        if (drivers.get(id) !== p) return;
        drivers.delete(id);
        modes.delete(id);
        stopping.delete(id);
        changed(id);
      });
    drivers.set(id, p);
    return true;
  }

  function kick(db: Database, id: number, reset: Reset = false) {
    start(db, id, () => drive(db, id, reset));
  }
  // ps4-plan.md WP-3: the follow-up driver of one part. Its Stop keeps the task state (spec.md section 6.18.1). before: the reason that
  // Continue cleared, which a Stop gives back when no follow-up row ran.
  const goPart = (db: Database, id: number, partId: number, before: TaskBlocked | null = null) =>
    start(db, id, () => driveFollow(db, id, partId, before), "instruct");
  // ps4-plan.md section 1 gap 15: after Continue or the form exit of a reason, a part with a waiting follow-up row or a built part runs on
  // in its follow-up driver. Else the build goes on with reset.
  function goOn(db: Database, id: number, partId: number | null, reset: Reset, before: TaskBlocked | null = null) {
    const part = partId === null ? undefined : parts(db, id).find((p) => p.id === partId);
    const queued = !!part && db.query(Q.follow).get({ part: part.id }) !== null;
    if (part && (queued || (BUILT.has(part.state) && !part.adopted))) goPart(db, id, part.id, before);
    else if (taskRow(db, id)?.state === "implementing") kick(db, id, reset);
  }

  // ---------- Tell Claude and Update from the base branch (spec.md section 6.18) ----------

  const itemOf = (db: Database, row: number) =>
    (db.query("SELECT item FROM task_step WHERE id = $id").get({ id: row }) as { item: string }).item;
  // spec.md section 6.18.2 and ps4-plan.md section 1 gap 14: a follow-up runs again as a new waiting row of the same kind and item, with
  // the same text and the same earlier reason. The caller starts the driver of its part.
  const requeue = (db: Database, id: number, row: number, at = now()) => {
    const r = db.query(Q.step).get({ id: row, task: id }) as { part: number; kind: StepMode; item: string };
    const attempt = (db.query(Q.attempt).get({ part: r.part, kind: r.kind, item: r.item }) as { n: number }).n;
    const next = insertStep(db, { task: id, part: r.part, kind: r.kind, item: r.item, attempt, state: "waiting" }, at);
    const { instruct: info, findings } = stepDetailOf(db, row);
    if (info)
      patchStep(db, next, {
        instruct: {
          ...info,
          result: null,
          committed: false,
          comments: info.comments && { ...info.comments, verdicts: null, drafted: false },
        },
      });
    // pushback.md section 6.23.6: the points of "Fix it anyway".
    if (r.item === "pushback") patchStep(db, next, { findings });
    return next;
  };
  const lastBefore = (db: Database, part: number, row: number) =>
    (db.query("SELECT MAX(id) AS id FROM task_step WHERE part = $part AND id < $row").get({ part, row }) as { id: number | null }).id ??
    row;
  const isOpen = (db: Database, row: number) => {
    const s = (db.query(Q.stepState).get({ id: row }) as { state: string } | null)?.state;
    return s === "waiting" || s === "running";
  };
  const firstLine = (text: string) => (text.trim().split(/\r?\n/)[0] ?? "").slice(0, 72).trimEnd();
  // spec.md section 6.18.3 (Q60): one base names itself; several give "N base branches".
  const baseLabel = (bases: string[]) => {
    const u = [...new Set(bases)];
    return u.length === 1 ? (u[0] as string) : `${u.length} base branches`;
  };
  const repoName = (r: { project: string | null; repo: string | null }) => `${r.project}/${r.repo}`;
  const setReason = (db: Database, id: number, b: TaskBlocked | null) => {
    const cur = taskRow(db, id);
    if (cur && (cur.state === "implementing" || cur.state === "ready")) setBlocked(db, { task: id, version: cur.version }, b, now());
  };

  // The merge commit S of a merged lower part (provider.mergeCommit, Gate G17). null: no PR, no provider, or Bitbucket names none.
  const mergeCommitOf = (t: TaskRow, lower: LowerPart) => async () => {
    const p = lower.remotePr === null ? null : await settings.provider();
    return p ? p.mergeCommit({ project: t.project, repo: t.repo, id: lower.remotePr as number }) : null;
  };

  // spec.md section 6.18.5, Base check of the current part. A task with sub-tasks checks each built part on its own base (section
  // 6.20.10). A part whose lower part merged checks the task base, and the first check finds how the lower part merged. It stores the
  // counts for the Task view. A failed read keeps the last result. The caller sends the change notice after the check, also after a failure.
  async function refreshBases(db: Database, id: number): Promise<(BaseMove & { part: number })[]> {
    const t = taskRow(db, id);
    if (!t || (t.state !== "implementing" && t.state !== "ready")) return [];
    const one = t.subtasks === 1 ? null : currentPart(db, t);
    const list = one ? [one] : t.subtasks === 1 ? parts(db, id).filter((p) => p.adopted === 0 && WORKTREE.has(p.state)) : [];
    const out: (BaseMove & { part: number })[] = [];
    const cache = cachePath(longPath(dataDir), { project: t.project, repo: t.repo, id });
    try {
      for (const part of list) {
        const lower = lowerOf(db, t, part);
        for (const r of updateRepos(db, t, updateBase(db, t, part))) {
          const m = await checkBase(dataDir, id, r, await review.taskRemote(r.project, r.repo));
          out.push({ part: part.id, ...m });
          if (!lower || r.row.role !== "main" || !m.fetched || lowerHowOf(db, part.id)) continue;
          const merged = await lowerMerge(dataDir, cache, lower.aFinal, m.fetched, mergeCommitOf(t, lower)).catch((e) => {
            log(`Task ${id}: cannot read the merge of ${lower.name}: ${noUrl((e as Error).message)}`);
            return null;
          });
          if (merged) setLowerHow(db, part.id, merged.how);
        }
      }
    } catch (e) {
      log(`Task ${id}: the base check failed: ${noUrl((e as Error).message)}`);
      return out;
    }
    setBaseMoves(
      db,
      id,
      out.map((m) => ({ part: m.part, taskRepo: m.taskRepo, newCommits: m.newCommits })),
      now(),
    );
    return out;
  }
  // A base check outside a driver. Each end sends one change notice.
  const check = (db: Database, id: number) => {
    const p = refreshBases(db, id)
      .catch((e) => log(`Task ${id}: the base check failed: ${noUrl((e as Error).message)}`))
      .finally(() => {
        checking.delete(id);
        changed(id);
      });
    checking.set(id, p);
    return p;
  };

  // spec.md section 6.18.4, Restart: an update that ran at the last stop (recoverTasks marked it). In each repository its rebase or merge
  // is aborted, and the repository goes back to its head before the update.
  async function recoverUpdates(db: Database, id: number) {
    const t = taskRow(db, id);
    for (const s of db.query(Q.restarts).all({ task: id }) as { id: number; part: number | null; detail_json: string }[]) {
      const d = stepDetail.parse(JSON.parse(s.detail_json)).update;
      const part = parts(db, id).find((p) => p.id === s.part);
      const base = t && part ? baseOf(t, part) : null;
      if (d && t && part && base) {
        const wt = await openWorktree({
          dataDir,
          db,
          project: t.project,
          repo: t.repo,
          task: id,
          ord: part.ord,
          branch: part.branch,
          base,
        });
        await resetToPre(await trees(db, t, part, wt), d.preHeads);
        log(`Task ${id}: the update of step ${s.id} stopped at a restart. The repositories are back at their heads before it.`);
      }
      if (d) patchStep(db, s.id, { update: { ...d, recovered: true } });
    }
  }

  // ps4-plan.md WP-3 (spec.md sections 6.18.1 and 6.18.2): the follow-up driver of one part. The route wrote the waiting follow-up row,
  // or the part of a reason runs on. The phase loop runs the follow-up with its gate and commit, and on a built part the own review too.
  // The app never reads the text of a send: it goes to Claude as "Your instructions" only. On an implementing part the loop ends after
  // the follow-up. In implementing, the build of the parts goes on after it (AC-B345).
  async function driveFollow(db: Database, id: number, partId: number, before: TaskBlocked | null) {
    // A Skip or Start again of the part runs now: the follow-up row waits for the next GO.
    if (!claim(id, partId)) {
      if (before && free(db, id)) setReason(db, id, before);
      changed(id);
      return;
    }
    let c: Ctx | null = null;
    let mine = true;
    try {
      await recoverUpdates(db, id);
      const t = taskRow(db, id) as TaskRow;
      const part = parts(db, id).find((p) => p.id === partId) as PartRow;
      c = await context(db, t, part, "instruct");
      c.phase = "idle";
      // Changes that an earlier stop or the red checks of the build left get the Continue rule first.
      await settle(db, t, part, c.trees);
      try {
        await phases(c, part.state === "implementing");
      } catch (e) {
        // ps4-plan.md section 2.6: a Hold ends the follow-up of its part only. The build of the other parts goes on.
        if (!(e instanceof Halt) || !onHold(db, partId) || stopping.has(id)) throw e;
      }
      leave(active, id, partId);
      mine = false;
      if (taskRow(db, id)?.state === "implementing" && free(db, id) && !stopping.has(id)) {
        // The driver becomes a build driver, so Stop sends STOP as for a build.
        modes.delete(id);
        await buildParts(db, id);
      }
      changed(id);
    } catch (e) {
      await endFollow(db, id, c, e, before);
    } finally {
      if (mine) leave(active, id, partId);
    }
  }

  // The end of a follow-up driver that did not finish (ps4-plan.md section 1 gap 13). A reason of the run stays: the run end sent WAIT.
  // A Stop (spec.md section 6.18.1) resets every repository to its last commit with the patch saved and restores the reason that the
  // task had before the follow-up. The patch holds kept work of the build too: the next run of the part reads it in
  // context/continue-diff.md. A Stop of a driver that ran no follow-up row gives back before and keeps the work. At the app stop an open
  // row stays for the restart recovery.
  async function endFollow(db: Database, id: number, c: Ctx | null, e: unknown, before: TaskBlocked | null) {
    // The follow-up of this driver: a row that waits or runs, or a row of the follow-up that this driver ran.
    const newest = c ? (db.query(Q.newestFollow).get({ part: c.part.id }) as { id: number; item: string } | null) : null;
    const f = newest && (isOpen(db, newest.id) || (c?.follow != null && newest.id >= c.follow)) ? newest : null;
    if (!stopping.has(id)) {
      if (f && !closing && isOpen(db, f.id)) endStep(db, f.id, "cancelled", { notes: ["The step did not start."] }, now());
      failed(db, id, e);
      changed(id);
      return;
    }
    try {
      if (c && f) await undo(c.trees, db, id, f.id);
    } catch (err) {
      failed(db, id, err);
      return;
    }
    if (!c || !f) {
      if (before) setReason(db, id, before);
      changed(id);
      return;
    }
    const info = stepDetailOf(db, f.id).instruct;
    const committed = db.query(Q.committed).get({ part: c.part.id, item: f.item }) !== null;
    const text = committed
      ? "Stopped after the commit. The own review did not run."
      : info?.comments
        ? "Stopped. The app undid the work on the PR comments, so it wrote no Fixed-in draft."
        : info
          ? "Stopped. Your instructions changed nothing. The text is back in the box."
          : "Stopped. The fix changed nothing.";
    db.transaction(() => {
      if (isOpen(db, f.id)) endStep(db, f.id, "cancelled", {}, now());
      const d = stepDetailOf(db, f.id);
      // AC-B392: the undo removed the fixes, so no later commit may claim them.
      const k = info?.comments && !committed ? { ...info.comments, drafted: true } : info?.comments;
      patchStep(db, f.id, {
        ...(info && { instruct: { ...info, result: "stopped", committed, comments: k ?? null } }),
        notes: [...d.notes, text],
      });
      // A message of the build driver (WP-7) has no reason before it: before is the reason that Continue cleared.
      setReason(db, id, info?.blockedBefore ?? before ?? null);
    })();
    changed(id);
  }

  // spec.md sections 6.18.3 and 6.18.4: one update of a built part. row: its update step, which the route wrote. Each repository takes
  // its own picked base, deepest first: a rebase before the first push, else a merge. A conflict goes to a resolve step. Any failure
  // before the checks aborts the update in every repository. The phase goes idle, updating, (resolving, updating)*, checking, idle
  // (part-session.md section 9.3.3). In implementing, the driver then builds the other parts, as driveFollow does.
  async function driveUpdate(db: Database, id: number, partId: number, row: number) {
    let c: Ctx | null = null;
    let pre: UpdateDetail["preHeads"] | null = null;
    let phase: "git" | "checks" | "review" = "git";
    let label = taskRow(db, id)?.target_branch ?? "";
    let forked = false;
    try {
      // A base check of the Task view fetches into the same refs.
      await checking.get(id);
      await recoverUpdates(db, id);
      const t = taskRow(db, id) as TaskRow;
      let part = parts(db, id).find((p) => p.id === partId) as PartRow;
      c = await context(db, t, part, "update");
      c.phase = "idle";
      send(c, { type: "UPDATE" });
      const ctx = c;
      await undo(c.trees, db, id, lastBefore(db, part.id, row));
      refreshPlan(c);
      if (!c.who) throw new UpdateAbort("set user.name and user.email in your git config");
      const who = c.who;
      // spec.md section 6.20.10: a part whose lower part merged updates from the task base.
      const lower = lowerOf(db, t, part);
      const repos = updateRepos(db, t, updateBase(db, t, part));
      const changedIds = new Set(repos.filter((r) => r.row.role !== "main").map((r) => r.row.id));
      label = baseLabel(repos.map((r) => r.base));
      // Step 1: the heads of every repository before any git command that changes one.
      pre = await headsOf(c.trees, baseOf(t, part));
      patchStep(db, row, { update: updateDetail.parse({ repos: [], preHeads: pre }) });
      // part-session.md section 2.13: the resolve runs fork the part session only when its guard holds now. A conflict stop moves HEAD.
      let joined = review.sessionGates.resolve && (await sessionOf(c, "resolve", false)).why === null;
      // Step 2: the fetched head of each base. A PR that Bitbucket reports with conflicts takes the update too.
      const conflicted = new Set(
        (taskDto(db, t).parts.find((x) => x.id === part.id)?.bases ?? []).filter((b) => b.conflicted).map((b) => b.taskRepo),
      );
      const plan = new Map<number, { newBaseHead: string; mode: "rebase" | "merge" }>();
      for (const r of repos) {
        guard(ctx);
        const head = await fetchBase(dataDir, id, r, await review.taskRemote(r.project, r.repo));
        // spec.md section 6.16.7: a picked base can be behind the old one, so its head is in the branch. The rebase still drops the
        // commits of the old base.
        if ((head !== r.baseCommit && !(await baseIn(dataDir, r, head))) || conflicted.has(r.row.id) || r.row.base_changed === 1)
          plan.set(r.row.id, { newBaseHead: head, mode: r.published ? "merge" : "rebase" });
      }
      if (!plan.size) throw new UpdateAbort(`${label} has no new commits`);
      label = baseLabel(repos.filter((r) => plan.has(r.row.id)).map((r) => r.base));
      patchStep(db, row, {
        update: updateDetail.parse({
          repos: repos.flatMap((r) => {
            const p = plan.get(r.row.id);
            return p ? [{ taskRepo: r.row.id, base: r.base, ...p }] : [];
          }),
          preHeads: pre,
        }),
      });
      let stops = 0;
      let resolved = false;
      for (const r of repos) {
        const tree = ctx.trees.find((x) => x.row.id === r.row.id);
        if (!tree?.wt) throw new UpdateAbort(`${repoName(r)} has no worktree`);
        const wt = tree.wt;
        const p = plan.get(r.row.id);
        if (p) {
          guard(ctx);
          const o = { ...p, baseCommit: r.baseCommit, key: ctx.label, base: r.base, full: tree.full };
          const merges = lower && r.row.role === "main" && p.mode === "merge" ? await lowerMerges(ctx, r, lower, p.newBaseHead, row) : null;
          let n = 0;
          for (const m of merges ?? [null]) {
            // A merge whose commit the branch holds is skipped (spec.md section 6.20.10 step 3c).
            if (m && (await holds(wt, m.head))) continue;
            const at = m ? { newBaseHead: m.head, mode: "merge" as const } : p;
            let stop = m ? await mergeInto(wt, { ...m, full: tree.full }, who) : await startUpdate(wt, o, who);
            while (stop) {
              guard(ctx);
              if (++n > RESOLVE_STOPS) throw new UpdateAbort(`more than ${RESOLVE_STOPS} conflict stops in ${repoName(r)}`);
              const links = new Map<string, string>();
              for (const g of stop.gitlinks) {
                const kid = ctx.trees.find((x) => x.row.parent === tree.row.id && x.row.path === g);
                if (!kid?.wt)
                  throw new UpdateAbort(`The update changes ${tree.full ? `${tree.full}/${g}` : g}, which the task cannot edit`);
                const parent = { wt, name: repoName(r), base: r.base, newBaseHead: at.newBaseHead };
                links.set(
                  g,
                  await pointerFor(dataDir, parent, { path: g, name: repoName(kid.row), cache: kid.wt.cache, head: await headOf(kid.wt) }),
                );
              }
              if (stop.files.length) {
                send(ctx, { type: "CONFLICT" });
                forked ||= joined;
                joined = await resolveConflicts(ctx, tree, r, at, stop.files, row, joined);
                send(ctx, { type: "RUN_DONE" });
                resolved = true;
              }
              stop = await continueUpdate(wt, at.mode, tree.full, stop.files, links, who);
            }
          }
          stops += n;
          patchStep(db, row, { update: { ...(stepDetailOf(db, row).update as UpdateDetail), stops, resolved } });
        }
        // spec.md section 6.18.3, Pointer: the gitlink of each changed submodule moves to its updated head.
        for (const kid of ctx.trees.filter((x) => x.row.parent === tree.row.id && changedIds.has(x.row.id) && x.wt && x.row.path))
          await commitPointer(
            wt,
            kid.row.path as string,
            await headOf(kid.wt as Worktree),
            `${ctx.label}: point ${kid.row.path} at the updated task branch`,
            who,
          );
      }
      const followed = await followGitlinks(dataDir, id, ctx.trees, changedIds, (project, repo) => review.taskRemote(project, repo));
      const post = (await headsOf(ctx.trees, null)).map(({ taskRepo, head }) => ({ taskRepo, head }));
      // Step 5: base_commit moves to the new base head, and the heads move to the new commits.
      db.transaction(() => {
        for (const r of repos) {
          const p = plan.get(r.row.id);
          const head = post.find((h) => h.taskRepo === r.row.id)?.head as string;
          if (p) db.query(Q.baseChanged).run({ task: id, id: r.row.id, main: r.row.role === "main" ? 1 : 0, changed: 0 });
          if (r.row.role === "main") {
            if (p && part.base_commit !== null) db.query(Q.partBase).run({ id: part.id, base: p.newBaseHead, now: now() });
            else if (p) {
              db.query(Q.baseCommit).run({ id, base: p.newBaseHead });
              if (r.row.id) db.query(Q.repoBase).run({ id: r.row.id, base: p.newBaseHead });
            }
            db.query(Q.partHead).run({ id: part.id, head, now: now() });
          } else {
            if (p) db.query(Q.repoBase).run({ id: r.row.id, base: p.newBaseHead });
            db.query(Q.prBase).run({ part: part.id, repo: r.row.id, base: p?.newBaseHead ?? r.baseCommit, head });
          }
        }
        for (const f of followed) db.query(Q.repoPin).run({ id: f.row.id, pinned: f.commit, base: f.commit });
        patchStep(db, row, { update: { ...(stepDetailOf(db, row).update as UpdateDetail), postHeads: post, stops, resolved } });
        // part-session.md section 2.13: the transcript of a session resolve knows the new heads. A clean update moves no session head.
        if (resolved && joined) moveHeads(db, part.id, post, now());
      })();
      send(ctx, { type: "CLEAN" });
      phase = "checks";
      part = parts(db, id).find((x) => x.id === partId) as PartRow;
      c = await context(db, taskRow(db, id) as TaskRow, part, "update");
      c.phase = ctx.phase;
      await countLines(c);
      // spec.md section 6.18.3, Checks (Q56): red keeps the update and waits for the user. No fix step runs before Continue (Q-SM6).
      const k = await checks(c, itemOf(db, row));
      send(c, k.green ? { type: "CHECKS_GREEN" } : { type: "CHECKS_RED" }, { afterUpdate: true });
      db.transaction(() => {
        endStep(db, row, "ok", { notes: stepDetailOf(db, row).notes }, now());
        patchStep(db, row, { update: { ...(stepDetailOf(db, row).update as UpdateDetail), result: k.green ? "green" : "red" } });
        if (!k.green)
          setReason(db, id, {
            kind: "red",
            cause: "update",
            step: k.step,
            text: `Needs you: the tests fail after the update from ${label}.`,
          });
      })();
      changed(id);
      // Q57: Claude wrote code in a resolve step, so the own review runs.
      phase = "review";
      if (k.green && resolved) await ownReview(c);
      if (taskRow(db, id)?.state === "implementing" && free(db, id) && !stopping.has(id)) {
        modes.delete(id);
        await buildParts(db, id);
      }
    } catch (e) {
      await endUpdate(db, id, row, c, pre, label, phase, e, forked);
    }
  }

  // One resolve step (spec.md section 6.18.4): context/conflicts.md, the path check against the unmerged paths of this stop, and the
  // marker check. Its changes go to patches/<step>.patch. A question, a changed path without a conflict, a remaining marker, or a failed
  // run aborts the update. fork: the session guard held at the update start (part-session.md section 2.13), so the run forks the newest
  // kept transcript; an earlier resolve run of the update replaced it. Returns true when the run forked the session.
  async function resolveConflicts(
    c: Ctx,
    tree: RepoTree,
    r: UpdateRepo,
    p: { newBaseHead: string; mode: "rebase" | "merge" },
    paths: string[],
    row: number,
    fork: boolean,
  ): Promise<boolean> {
    const wt = tree.wt as Worktree;
    const item = itemOf(c.db, row);
    const at = (x: string) => (tree.full ? `${tree.full}/${x}` : x);
    const file = conflictsFile({ name: repoName(r), full: tree.full, base: r.base, newBaseHead: p.newBaseHead, mode: p.mode, paths });
    const before = await resolveSnapshot(c.trees, tree);
    const run = async (kept: string | null) => {
      const rrow = insertStep(
        c.db,
        { task: c.id, part: c.part.id, kind: "resolve", item, attempt: nextAttempt(c, "resolve", item), state: "waiting" },
        now(),
      );
      patchStep(c.db, rrow, { resolve: { taskRepo: tree.row.id, paths } });
      const session = kept ? { ...(await sessionOf(c, "resolve", false)), resume: kept, why: null } : null;
      const { r: o } = await runStep(c, "resolve", item, {
        allow: [],
        step: (a) => partStepFile(c.plan, c.plan.parts, "resolve", a),
        failure: file,
        row: rrow,
        resolveCheck: (context, ignored) => resolveProblems(c.trees, tree, paths, before, context, ignored),
        session,
      });
      return o;
    };
    let kept = (fork && partSession(c.db, c.part.id)?.file) || null;
    let out = await run(kept);
    // part-session.md section 2.2: a fork that failed before any tool call runs once more with no session.
    if (out && kept && !out.result && out.resumed && out.events === 0 && out.kind !== "usage_limit") {
      patchStep(c.db, out.step, { notes: [...stepDetailOf(c.db, out.step).notes, RESUME_FAILED] });
      kept = null;
      out = await run(null);
    }
    if (out) {
      const saved = await savePatch(wt, patchFile(dataDir, c.db, c.id, out.step), paths, true).catch(() => null);
      if (saved) patchStep(c.db, out.step, { patch: basename(saved) });
    }
    if (!out) throw new Halt();
    if (!out.result) {
      // git-deny.md fix F: the app restored the git state. The abort resets every repository.
      if (out.moved.length) throw new UpdateAbort(movedReason(out.moved));
      const bad = out.problems[0];
      if (bad) throw new UpdateAbort(`Claude changed ${bad.path}, which has no conflict`);
      throw new StepFailed(out.text ?? "The resolve step failed.");
    }
    const q = out.result.question;
    if (q) throw new UpdateAbort(`Claude could not resolve ${at(paths[0] as string)}: ${oneLine(q.text).replace(/\.$/, "")}`);
    const left = await markerLeft(wt, paths);
    if (left) throw new UpdateAbort(`conflict markers remain in ${at(left)}`);
    return kept !== null;
  }

  // spec.md section 6.20.10 step 3: the merges of a pushed part whose lower part merged, into the main repository. A merge commit or a
  // fast-forward takes the plain merge. A squash that passes the squash check takes A_final (step a), then the base before S, S with
  // `-s ours`, and the rest of the base (step c). Any other merge takes the plain merge (step d), and the update step says why.
  async function lowerMerges(c: Ctx, r: UpdateRepo, lower: LowerPart, m1: string, row: number) {
    const into = `${c.label}: merge ${r.base} into ${c.part.branch}`;
    const plain = [{ head: m1, message: into }];
    let merged: Awaited<ReturnType<typeof lowerMerge>>;
    try {
      merged = await lowerMerge(dataDir, c.wt.cache, lower.aFinal, m1, mergeCommitOf(c.t, lower));
    } catch (e) {
      throw new UpdateAbort(`the app cannot read the merge of ${lower.name}: ${noUrl((e as Error).message)}`);
    }
    setLowerHow(c.db, c.part.id, merged.how);
    if (merged.how === "merge") return plain;
    if (merged.s && merged.parent && lower.aFinal)
      return [
        { head: lower.aFinal, message: `${c.label}: merge ${lower.branch} into ${c.part.branch}` },
        { head: merged.parent, message: into },
        { head: merged.s, message: `${c.label}: record the squash merge of ${lower.branch}`, ours: true },
        { head: m1, message: into },
      ];
    const why = `Bitbucket merged ${lower.name} in a way that the app cannot match. The update merges ${r.base}, and conflicts can come up.`;
    patchStep(c.db, row, { notes: [...stepDetailOf(c.db, row).notes, why] });
    return plain;
  }

  // Resets every repository to its head before the update and restores the base, head, and pinned commits of the rows.
  async function restoreUpdate(db: Database, c: Ctx, pre: UpdateDetail["preHeads"]) {
    await resetToPre(c.trees, pre);
    db.transaction(() => {
      for (const h of pre) {
        const tree = c.trees.find((x) => x.row.id === h.taskRepo);
        if (!tree) continue;
        if (h.baseChanged) db.query(Q.baseChanged).run({ task: c.id, id: h.taskRepo, main: tree.row.role === "main" ? 1 : 0, changed: 1 });
        if (tree.row.role === "main") {
          if (h.baseCommit && c.part.base_commit !== null) db.query(Q.partBase).run({ id: c.part.id, base: h.baseCommit, now: now() });
          else if (h.baseCommit) {
            db.query(Q.baseCommit).run({ id: c.id, base: h.baseCommit });
            if (h.taskRepo) db.query(Q.repoBase).run({ id: h.taskRepo, base: h.baseCommit });
          }
          db.query(Q.partHead).run({ id: c.part.id, head: h.head, now: now() });
        } else {
          db.query(Q.repoPin).run({ id: h.taskRepo, pinned: h.pinned, base: h.baseCommit });
          db.query(Q.prHead).run({ part: c.part.id, repo: h.taskRepo, head: h.head });
          if (h.baseCommit) db.query(Q.prBase).run({ part: c.part.id, repo: h.taskRepo, base: h.baseCommit, head: h.head });
        }
      }
    })();
  }

  // The end of an update that did not finish (spec.md section 6.18.4, Abort). Before the checks, and on a Stop during the checks, every
  // repository goes back to its head before the update, and the reason "update" says why. A reason of the own review after a resolve
  // step stays (part-session.md section 9.3.4, Q-SM1). The phase ends before the reason write: WAIT, or STOPPED for a Stop. forked: a
  // resolve run forked the session, so the kept transcript holds a resolve that the abort undoes. A merge stop leaves HEAD as it was, so
  // the guard cannot see it. The transcript goes, as after a git state change (part-session.md section 2.2, guard rule 4).
  async function endUpdate(
    db: Database,
    id: number,
    row: number,
    c: Ctx | null,
    pre: UpdateDetail["preHeads"] | null,
    label: string,
    phase: "git" | "checks" | "review",
    e: unknown,
    forked: boolean,
  ) {
    const stopped = stopping.has(id);
    if (c?.phase && c.phase !== "idle" && (phase !== "review" || e instanceof Halt))
      send(c, { type: (phase === "review" ? !c.waited : stopped) ? "STOPPED" : "WAIT" });
    if (phase === "review") {
      failed(db, id, e);
      changed(id);
      return;
    }
    const why = (
      e instanceof UpdateAbort
        ? e.message
        : stopped
          ? "you stopped it"
          : e instanceof StepFailed
            ? e.text
            : e instanceof Halt
              ? (blockedOf(taskRow(db, id) as TaskRow)?.text ?? "the update could not go on")
              : `the app could not update: ${noUrl((e as Error).message)}`
    ).replace(/\.$/, "");
    try {
      if (c && pre) {
        if (phase === "checks") await restoreUpdate(db, c, pre);
        else await resetToPre(c.trees, pre);
      }
    } catch (err) {
      if (isOpen(db, row)) endStep(db, row, "failed", { notes: [why] }, now());
      failed(db, id, err);
      return;
    }
    db.transaction(() => {
      if (isOpen(db, row)) endStep(db, row, "failed", { notes: [why] }, now());
      if (forked && c) dropSessions(db, { part: c.part.id });
      const d = stepDetailOf(db, row).update;
      if (d) patchStep(db, row, { update: { ...d, result: "aborted", reason: why } });
      const end = /[?!]$/.test(why) ? "" : ".";
      setReason(db, id, { kind: "update", step: row, text: `The update from ${label} stopped: ${why}${end} The branch is as it was.` });
    })();
    const t = taskRow(db, id);
    const part = c && parts(db, id).find((p) => p.id === c.part.id);
    if (phase === "checks" && t && part) await countLines(await context(db, t, part, "update")).catch(() => undefined);
    changed(id);
  }

  // part-session.md section 9.4: the 409 of Continue on a reason whose own form comes first.
  const formOf = (db: Database, id: number, b: TaskBlocked | null) =>
    b?.kind === "spec_change"
      ? "Accept or reject the change to the spec first."
      : b?.kind === "allow"
        ? "Pick a choice for each command first."
        : b?.kind === "question" && (db.query(Q.openLoop).all({ task: id }) as unknown[]).length
          ? "Answer the question first."
          : null;

  // spec.md section 6.18.2: a reason that the newest send left gives back the reason of the task before the send, once. Else the reason
  // clears. The next driver applies the Continue rule to the changes of the step first (settle). first: a write in the same transaction.
  function restore(db: Database, t: TaskRow, b: TaskBlocked, first?: () => void): TaskResult {
    const last = db.query(Q.lastBuilt).get({ task: t.id }) as { id: number; kind: string } | null;
    const info = last?.kind === "instruct" ? stepDetailOf(db, last.id).instruct : null;
    const before = info?.result === null && JSON.stringify(info.blockedBefore) !== JSON.stringify(b) ? info.blockedBefore : null;
    db.transaction(() => {
      first?.();
      setBlocked(db, { task: t.id, version: t.version }, before, now());
      if (last && info && before) patchStep(db, last.id, { instruct: { ...info, blockedBefore: null } });
    })();
    changed(t.id);
    return { status: 200, task: dto(db, t.id) };
  }

  // ps4-plan.md section 4, option leave (part-session.md section 9.4 rule 9): it replaces Dismiss in ready, also for the reason update.
  function leaveReason(db: Database, t: TaskRow, b: TaskBlocked | null): TaskResult {
    if (t.state !== "ready") return conflict(db, t.id, "Leave works only in ready.");
    const form = formOf(db, t.id, b);
    if (form) return conflict(db, t.id, form);
    return b ? restore(db, t, b) : conflict(db, t.id, TASK_STATE_TEXT.ready);
  }

  // ps5-plan.md D3: option without is "Go on without these fixes" of the reason blocker. The guard review reads the own reviews after the
  // newest work commit. Each must-fix point of them gets skipFix, in the transaction of the reason clear. So GO starts no review round,
  // and "Fix these too" lists the points. In implementing, the part goes on as after Continue. In ready, the reason before the follow-up
  // comes back, as leave does.
  function withoutFixes(db: Database, t: TaskRow, b: TaskBlocked | null): TaskResult {
    if (t.state !== "implementing" && t.state !== "ready") return conflict(db, t.id, TASK_STATE_TEXT[t.state]);
    const part = b?.kind === "blocker" ? partOf(db, b) : null;
    if (!b || part === null) return conflict(db, t.id, NO_POINTS);
    const skip = () => {
      for (const run of reviewsAfterWork(db, part) ?? [])
        for (const x of db.query(Q.livePoints).all({ run }) as { id: number; payload_json: string }[])
          if (mustFixPoint(JSON.parse(x.payload_json) as FindingPayload)) db.query(Q.skipFix).run({ id: x.id });
    };
    if (t.state === "ready") return restore(db, t, b, skip);
    goOnReason(db, t, b, true, skip);
    return { status: 200, task: dto(db, t.id) };
  }

  // ps5-plan.md D2 and section 5: option setup is "Run setup again" of a part (build-redesign.md Q6). The setup mark of the part goes,
  // so the next GO of the part runs setup first. A red setup of the part left no mark, so its reason takes Continue. Any other reason
  // comes first. The refusals are those of the old route /parts/:part/setup.
  function setupAgainOf(db: Database, t: TaskRow, partId: number): TaskResult {
    const id = t.id;
    if (t.state !== "implementing" && t.state !== "ready") return conflict(db, id, TASK_STATE_TEXT[t.state]);
    if (drivers.has(id) || closing) return conflict(db, id, WORKING);
    const part = parts(db, id).find((p) => p.id === partId);
    if (!part) return { status: 404, error: "Part not found." };
    if (!WORKTREE.has(part.state) || part.adopted) return conflict(db, id, "This part has no worktree.");
    if (!repoSettings(db, t.project, t.repo).commands.some((x) => x.kind === "setup"))
      return conflict(db, id, "This repository has no setup command.");
    // spec.md section 6.25.5: a part with a waiting reason or on hold acts on that reason first.
    if (part.blocked_json !== null) return conflict(db, id, SETUP_WAITS);
    const b = blockedOf(t);
    const of = partOf(db, b);
    const item = b?.step == null ? null : (db.query(Q.step).get({ id: b.step, task: id }) as StepRow | null)?.item;
    if (b && !(b.kind === "red" && item === "setup" && of === partId))
      return conflict(db, id, of !== null && of !== partId ? WAITING : SETUP_WAITS);
    // The mark lives in the git folder of the worktree (worktree.ts setupMark). No worktree: a new one has no mark.
    const admin = adminOf(
      cachePath(longPath(dataDir), { project: t.project, repo: t.repo, id }),
      join(partDir(dataDir, db, id, part.ord), "repo"),
    );
    if (admin) rmSync(setupMark({ admin } as Worktree), { force: true });
    if (b) goOnReason(db, t, b, true);
    else {
      bump(db, id, t.version);
      goOn(db, id, partId, false);
      changed(id);
    }
    return { status: 202, task: dto(db, id) };
  }

  // The checks of a mutation: the task and its version.
  function load(db: Database, id: number, version: number): TaskRow | TaskResult {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== version) return { status: 409, error: TASK_CHANGED, task: taskDto(db, t) };
    return t;
  }

  // part-session.md section 9.4 column "Continue does": the reason clears, a follow-up row that did not finish goes in the queue again
  // (ps4-plan.md section 1 gap 14), and the part of the reason runs on (gap 15). The usage timer takes the same path. first: a write in
  // the transaction of the clear.
  function goOnReason(db: Database, t: TaskRow, b: TaskBlocked | null, reset: Reset, first?: () => void) {
    const id = t.id;
    const step = b?.step == null ? null : (db.query(Q.step).get({ id: b.step, task: id }) as StepRow | null);
    // part-session.md section 5.4: Continue clears a reason of a kind that the app sets no more (budget/time, size/budget, push).
    const go = db.transaction(() => {
      first?.();
      if (b) setBlocked(db, { task: id, version: t.version }, null, now());
      if (!free(db, id)) return false;
      if (step && isFollow(step) && step.state !== "ok") requeue(db, id, step.id);
      return true;
    })();
    if (go) goOn(db, id, partOf(db, b), reset, b);
    changed(id);
  }

  // spec.md section 6.18.3: the update row "U<n>" of a part, the clear of the reason update, and the update driver. The route and Continue
  // on the reason update (part-session.md section 9.4) start it.
  function beginUpdate(db: Database, id: number, partId: number, version: number) {
    const row = db.transaction(() => {
      const n = (db.query(Q.sends).get({ task: id, kind: "update" }) as { n: number }).n + 1;
      const r = insertStep(db, { task: id, part: partId, kind: "update", item: `U${n}`, state: "running" }, now());
      setBlocked(db, { task: id, version }, null, now());
      return r;
    })();
    start(db, id, () => driveUpdate(db, id, partId, row), "update");
    changed(id);
  }

  // part-session.md section 9.4, usage rules: one timer per task for its first reason when that reason is usage with armed true. A past
  // resumeAt, or none, fires at once. changed() and recover() call it, so a reason that moves up gets its timer.
  function rearm(db: Database, id: number) {
    const t = taskRow(db, id);
    const b = t && (t.state === "implementing" || t.state === "ready") ? blockedOf(t) : null;
    const at = !closing && b?.kind === "usage" && b.armed ? (b.resumeAt ?? 0) : null;
    const cur = usageTimers.get(id);
    if (cur?.at === at) return;
    if (cur) clearTimeout(cur.timer);
    usageTimers.delete(id);
    if (at === null) return;
    const timer = setTimeout(
      () => {
        usageTimers.delete(id);
        due(id);
      },
      Math.min(Math.max(0, at - now()), TIMER_MAX_MS),
    );
    usageTimers.set(id, { at, timer });
  }

  // ps4-plan.md section 2.7, RESUME_DUE: the first reason is usage with armed true, its time came, no driver works, and the app does not
  // stop. A driver that still ends calls changed() at its end, which arms the timer again. A capped delay arms it again too.
  function due(id: number) {
    const db = settings.db();
    const t = db && !closing ? taskRow(db, id) : null;
    if (!db || !t || (t.state !== "implementing" && t.state !== "ready")) return;
    const b = blockedOf(t);
    if (b?.kind !== "usage" || !b.armed) return;
    if (b.resumeAt !== undefined && now() < b.resumeAt) return rearm(db, id);
    if (drivers.has(id)) return;
    goOnReason(db, t, b, true);
  }

  // part-session.md section 9.3.2 (ps4-plan.md section 2.3): after an ABANDON, LAST_PR_OPEN when no part waits for its PR, then
  // ALL_MERGED when each part merged or was dropped. In stopped neither event fires, so RESUME runs this check again (gap 18). Call it in
  // the transaction of the event. Returns the new version.
  function partsDone(db: Database, id: number, version: number): number {
    const rest = parts(db, id);
    if (!rest.length) return version;
    if (taskRow(db, id)?.state === "implementing" && !rest.some((p) => WAITS_PR.has(p.state))) {
      const a = advance(db, { task: id, version }, { type: "LAST_PR_OPEN" }, {}, now());
      if (a.status === 200) version = a.version;
    }
    if (taskRow(db, id)?.state === "ready" && rest.every((p) => p.state === "merged" || p.state === "abandoned")) {
      const a = advance(db, { task: id, version }, { type: "ALL_MERGED" }, {}, now());
      if (a.status === 200) version = a.version;
    }
    return version;
  }

  // A started part on top of part, which drop and Skip refuse (spec.md section 6.20.7).
  function upperOf(db: Database, t: TaskRow, part: PartRow): string | null {
    const all = parts(db, t.id);
    const names = partNames(t.key, all);
    const name = (p: PartRow) => names.get(p.id)?.text ?? t.key;
    const upper = all.find(
      (p) => p.after_part === part.id && p.base_commit !== null && p.base_branch === part.branch && STARTED.has(p.state),
    );
    return upper ? `${name(upper)} builds on ${name(part)}. Move or drop ${name(upper)} first.` : null;
  }

  // Skip and Start again (part-session.md section 9.3.2): the reasons of the part go, from its row and from the task when the first reason
  // is the part's, and its open loop questions go. In the transaction of the part event. Returns the new version.
  function dropReasons(db: Database, id: number, partId: number, version: number): number {
    const first = partOf(db, blockedOf(taskRow(db, id) as TaskRow));
    db.query(Q.clearPart).run({ id: partId, now: now() });
    db.query(Q.dropAsks).run({ task: id, part: partId });
    return first === partId ? setBlocked(db, { task: id, version }, null, now()) : version;
  }

  // Skip and Start again: the part is claimed for the git work. A task with no driver gets a placeholder driver, so the routes that start a
  // driver answer 409 until the work ends (as undoUpdate). A driver that builds other parts goes on (ps4-plan.md section 1 gap 17).
  async function partWork<T>(id: number, partId: number, f: () => Promise<T>): Promise<T> {
    enter(active, id, partId);
    const own = !drivers.has(id);
    const work = f();
    const placeholder = work.then(
      () => undefined,
      () => undefined,
    );
    if (own) drivers.set(id, placeholder);
    try {
      return await work;
    } finally {
      leave(active, id, partId);
      if (own && drivers.get(id) === placeholder) drivers.delete(id);
    }
  }

  // ps4-plan.md section 2.6, held CONTINUE with part: the hold goes. A build driver takes the part again at once, else a new driver starts
  // with the Continue rule. In stopped, the task also takes RESUME (section 8 item 5) and the check of gap 18.
  function resumePart(db: Database, t: TaskRow, partId: number): TaskResult {
    const id = t.id;
    const part = parts(db, id).find((p) => p.id === partId);
    if (!part) return { status: 404, error: "Part not found." };
    if (!onHold(db, partId)) return conflict(db, id, `Part ${part.ord} is not on hold.`);
    if (t.state === "stopped" ? t.stopped_from !== "implementing" : t.state !== "implementing")
      return conflict(db, id, TASK_STATE_TEXT[t.state]);
    // Only a build driver in its part loop takes the part. A driver of a follow-up, a setup, or an update, a driver that ends, and a driver
    // of a stopped task do not.
    if (drivers.has(id) && (t.state === "stopped" || modes.has(id) || !pokes.has(id))) return conflict(db, id, BUSY);
    const error = db.transaction((): string | null => {
      if (t.state === "stopped") {
        const r = advance(db, { task: id, version: t.version }, { type: "RESUME" }, {}, now());
        if (r.status !== 200) return r.error;
        partsDone(db, id, setBlocked(db, { task: id, version: r.version }, null, now()));
      } else bump(db, id, t.version);
      db.query(Q.unhold).run({ id: partId, task: id, now: now() });
      return null;
    })();
    if (error) return conflict(db, id, error);
    const poke = pokes.get(id);
    if (poke) poke(partId);
    else if (!drivers.has(id) && taskRow(db, id)?.state === "implementing" && free(db, id)) kick(db, id, true);
    changed(id);
    return { status: 200, task: dto(db, id) };
  }

  return {
    // spec.md section 6.2: a small plan approval starts part 1.
    build(db: Database, id: number) {
      kick(db, id);
    },

    // "Wait for the merge" (spec.md section 6.20.6, design.md Q67): the part that waits before its build, because its lower part also
    // changed another repository, starts after that merge. The reason goes, and the build goes on with the other parts.
    waitMerge(db: Database, id: number, partId: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const b = blockedOf(t);
      if (t.state !== "implementing" || b?.kind !== "error" || b.part !== partId)
        return conflict(db, id, "This part does not wait for you.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      const error = db.transaction((): string | null => {
        if (db.query(Q.waitMerge).run({ id: partId, now: now() }).changes !== 1) return "This part started already.";
        setBlocked(db, { task: id, version: t.version }, null, now());
        return null;
      })();
      if (error) return conflict(db, id, error);
      if (free(db, id)) kick(db, id);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/start (spec.md section 6.20.6, design.md B11): "Start <key> now" of a part that waits for a review
    // of its lower part. The part starts when the build slot is free. 409 when it waits for another reason, for example the limit.
    startNow(db: Database, id: number, partId: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const b = blockedOf(t);
      if (t.state !== "implementing" || b) return conflict(db, id, b?.text ?? TASK_STATE_TEXT[t.state]);
      const all = parts(db, id);
      const part = all.find((p) => p.id === partId);
      if (!part) return { status: 404, error: "Part not found." };
      const lower = all.find((p) => p.id === part.after_part);
      if (part.state !== "planned" || part.start_mode !== "stack" || !lower || !HAS_PR.has(lower.state) || lower.state === "approved")
        return conflict(db, id, "This part does not wait for a review.");
      // The schedule of this part alone with the override: no build and no earlier part holds it, so only the limit stays.
      const probe = all
        .filter((p) => p.id === partId || (p.state !== "planned" && p.state !== "implementing"))
        .map((p) => (p.id === partId ? { ...p, override: 1 } : p));
      const s = scheduleOf(db, t, probe);
      if (!s?.starts.some((x) => x.id === partId)) return conflict(db, id, s?.waits.get(partId) ?? "This part cannot start.");
      const error = db.transaction((): string | null => {
        if (db.query(Q.override).run({ id: partId, now: now() }).changes !== 1) return "This part started already.";
        setBlocked(db, { task: id, version: t.version }, null, now());
        return null;
      })();
      if (error) return conflict(db, id, error);
      kick(db, id);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/drop (spec.md section 6.20.7): "Drop this sub-task" sends ABANDON for a planned or declined part. 409
    // while a started part builds on it. A planned part on top of it starts from the base (schedule.ts). The task is ready when no part
    // waits for its PR, and done when every part merged or was dropped.
    drop(db: Database, id: number, partId: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" && t.state !== "ready") return conflict(db, id, TASK_STATE_TEXT[t.state]);
      const all = parts(db, id);
      const part = all.find((p) => p.id === partId);
      if (!part) return { status: 404, error: "Part not found." };
      if (part.state !== "planned" && part.state !== "declined")
        return conflict(db, id, "Only a part that waits for its build or a declined PR can be dropped.");
      const upper = upperOf(db, t, part);
      if (upper) return conflict(db, id, upper);
      const error = db.transaction((): string | null => {
        const r = advancePart(db, { task: id, version: t.version, part: partId }, { type: "ABANDON" }, {}, now());
        if (r.status !== 200) return r.error;
        partsDone(db, id, r.version);
        return null;
      })();
      if (error) return conflict(db, id, error);
      kick(db, id);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/hold (ps4-plan.md sections 2.6 and 4): held goes into the row of the part, then only the runs of
    // that part end cancelled. Its phase takes STOPPED, and its work stays. The other parts go on.
    hold(db: Database, id: number, partId: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const part = parts(db, id).find((p) => p.id === partId);
      if (!part) return { status: 404, error: "Part not found." };
      if (onHold(db, partId)) return conflict(db, id, `Part ${part.ord} is on hold already.`);
      // A waiting message (WP-7) can sit below the run row.
      const open = (db.query(Q.open).all({ part: partId }) as { id: number; kind: string }[]).find(
        (o) => o.kind === "implement" || o.kind === "fix",
      );
      if (t.state !== "implementing" || part.state !== "implementing" || part.blocked_json !== null || !open)
        return conflict(db, id, HOLD_WHEN(part.ord));
      const b: TaskBlocked = { kind: "held", step: open.id, part: partId, text: HELD_TEXT(part.ord) };
      db.transaction(() => {
        db.query(Q.hold).run({ id: partId, task: id, b: JSON.stringify(b), now: now() });
        bump(db, id, t.version);
      })();
      review.cancelPart(db, id, partId);
      // A step that waits for the run slot sees the hold when it wakes.
      slotWaits.get(id)?.();
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/skip (part-session.md sections 2.12 and 9.3.2): "Skip this part" of a task with sub-tasks, before
    // the PR of the part. The patch of the work is saved, the part takes ABANDON, its reasons and its transcript go, and then its
    // worktree. A Skip while another part runs a step keeps the task live (ps4-plan.md section 1 gap 17). In stopped, RESUME runs the
    // check of the task state (gap 18).
    async skip(db: Database, id: number, partId: number, input: { version: number }): Promise<TaskResult> {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" && t.state !== "stopped") return conflict(db, id, TASK_STATE_TEXT[t.state]);
      if (t.subtasks !== 1) return conflict(db, id, "Only a part of a task with sub-tasks can be skipped.");
      const part = parts(db, id).find((p) => p.id === partId);
      if (!part) return { status: 404, error: "Part not found." };
      if (HAS_PR.has(part.state) || part.state === "declined" || part.state === "merged") return conflict(db, id, "This part has a PR.");
      if (!partMachine.resolveState({ value: part.state, context: { gate: false } }).can({ type: "ABANDON" }))
        return conflict(db, id, `This part is ${PART_STATE_TEXT[part.state].toLowerCase()}.`);
      if (!partIdle(db, id, partId)) return conflict(db, id, HOLD_FIRST(part.ord));
      const upper = upperOf(db, t, part);
      if (upper) return conflict(db, id, upper);
      let error: string | null;
      try {
        error = await partWork(id, partId, async () => {
          const c = WORKTREE.has(part.state) ? await context(db, t, part) : null;
          const last = (db.query(Q.lastStep).get({ part: partId }) as { id: number | null }).id ?? 0;
          if (c) await undo(c.trees, db, id, last);
          const refused = db.transaction((): string | null => {
            const cur = taskRow(db, id) as TaskRow;
            if (cur.state !== "implementing" && cur.state !== "stopped") return TASK_STATE_TEXT[cur.state];
            const r = advancePart(db, { task: id, version: cur.version, part: partId }, { type: "ABANDON" }, {}, now());
            if (r.status !== 200) return r.error;
            stopSends(db, id, partId, now());
            partsDone(db, id, dropReasons(db, id, partId, r.version));
            return null;
          })();
          if (refused || !c) return refused;
          // The part is abandoned, so a folder that does not go only stays on disk.
          for (const x of deepestFirst(c.trees))
            if (x.wt)
              await removeWorktree(x.wt).catch((e) =>
                log(`Task ${id}: could not remove the worktree of part ${part.ord}: ${noUrl((e as Error).message)}`),
              );
          return null;
        });
      } catch (e) {
        return conflict(db, id, `The app could not save the work of part ${part.ord}: ${noUrl((e as Error).message)}`);
      }
      if (error) return conflict(db, id, error);
      if (taskRow(db, id)?.state === "implementing") kick(db, id);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/restart (part-session.md sections 2.12 and 9.3.2): "Start this part again" before the first push.
    // The patch of the work is saved, refs/rl/task/<id>/backup/part-<ord>-<n> keeps the old head, and each edit repository goes back to its
    // start. Then the restart mark, RESTART, and the reasons of the part go. The baseline and the setup mark stay. The next run is a new
    // session (ps4-plan.md section 1 items 5 to 7).
    async restart(db: Database, id: number, partId: number, input: { version: number }): Promise<TaskResult> {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" && t.state !== "stopped") return conflict(db, id, TASK_STATE_TEXT[t.state]);
      const part = parts(db, id).find((p) => p.id === partId);
      if (!part) return { status: 404, error: "Part not found." };
      if (part.pushed !== null || db.query(Q.pushedPr).get({ part: partId }))
        return conflict(db, id, `Part ${part.ord} is on the server. It cannot start again.`);
      if (!partMachine.resolveState({ value: part.state, context: { gate: false, unpushed: true } }).can({ type: "RESTART" }))
        return conflict(db, id, `This part is ${PART_STATE_TEXT[part.state].toLowerCase()}.`);
      if (!partIdle(db, id, partId)) return conflict(db, id, HOLD_FIRST(part.ord));
      let error: string | null;
      try {
        error = await partWork(id, partId, async () => {
          const c = await context(db, t, part);
          const last = (db.query(Q.lastStep).get({ part: partId }) as { id: number | null }).id ?? 0;
          const patch = await undo(c.trees, db, id, last);
          const ref = await backupPart(c.trees, id, part.ord);
          await resetToStart(c.trees, c.base);
          return db.transaction((): string | null => {
            const cur = taskRow(db, id) as TaskRow;
            if (cur.state !== "implementing" && cur.state !== "stopped") return TASK_STATE_TEXT[cur.state];
            const unpushed = parts(db, id).find((p) => p.id === partId)?.pushed === null && !db.query(Q.pushedPr).get({ part: partId });
            const r = advancePart(db, { task: id, version: cur.version, part: partId }, { type: "RESTART" }, { unpushed }, now());
            if (r.status !== 200) return r.error;
            stopSends(db, id, partId, now());
            const mark = insertStep(db, { task: id, part: partId, kind: "commit", item: "restart", state: "ok" }, now());
            const notes = [`Started again from the part base. The old head is at ${ref}.`];
            if (patch) notes.push(`The work that was not committed is in the patch ${patch}.`);
            endStep(db, mark, "ok", { notes }, now());
            db.query(Q.restartPart).run({ id: partId, now: now() });
            db.query(Q.dropPrs).run({ part: partId });
            dropReasons(db, id, partId, r.version);
            return null;
          })();
        });
      } catch (e) {
        return conflict(db, id, `The app could not start part ${part.ord} again: ${noUrl((e as Error).message)}`);
      }
      if (error) return conflict(db, id, error);
      if (taskRow(db, id)?.state === "implementing" && free(db, id)) {
        const poke = pokes.get(id);
        if (poke) poke(partId);
        else kick(db, id);
      }
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/stop: the task stops in any working state. The running run ends cancelled, and the checks are killed.
    stop(db: Database, id: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      // spec.md section 6.18.1 (Q61) and section 6.18.4: a Stop of an instruct step or an update keeps the task state. Its driver resets
      // the repositories and restores the reason.
      if (modes.has(id)) {
        stopping.add(id);
        review.cancelTask(db, id);
        abortChecks(id);
        slotWaits.get(id)?.();
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      const error = db.transaction((): string | null => {
        const r = advance(db, { task: id, version: t.version }, { type: "STOP" }, {}, now());
        if (r.status !== 200) return r.error;
        setBlocked(db, { task: id, version: r.version }, null, now());
        return null;
      })();
      if (error) return conflict(db, id, error);
      // spec.md section 6.20.6: Stop ends the runs and the checks of every part that builds.
      review.cancelTask(db, id);
      abortChecks(id);
      slotWaits.get(id)?.();
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/resume: the Continue rule keeps or resets the work, and GO picks the phase from the rows (build-redesign.md
    // section 2.2, part-session.md section 9.5). ps4-plan.md section 1 gaps 14 and 15: a follow-up row that did not finish goes in the
    // queue again, and the reason of a built part runs that part, in implementing and in ready. leave gives back the reason before the
    // follow-up in ready. part ends the hold of that part (ps4-plan.md section 2.6). disarm and Continue before the reset time act on the
    // usage arm (section 2.7). ps5-plan.md D2: setup runs setup again on the part. D3: without goes on past the points of the reason
    // blocker. A task that stopped in ready goes back to ready and starts nothing (part-session.md section 9.3.1).
    resume(db: Database, id: number, input: TaskResumeInput): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (input.option === "setup") return setupAgainOf(db, t, input.part ?? 0);
      if (input.part !== undefined) return resumePart(db, t, input.part);
      const b = blockedOf(t);
      const usage = (t.state === "implementing" || t.state === "ready") && b?.kind === "usage" ? b : null;
      if (input.option === "disarm") {
        if (!usage?.armed) return conflict(db, id, NO_ARM);
        setUsageArmed(db, { task: id, version: t.version }, false, now());
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      // Continue before the reset time arms every usage reason with one version move. An armed reason stays as it is. The arm starts no
      // driver, so a driver of other parts does not refuse it.
      if (usage && !input.option && usage.resumeAt !== undefined && now() < usage.resumeAt) {
        if (!usage.armed) setUsageArmed(db, { task: id, version: t.version }, true, now());
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      if ((t.state === "implementing" || t.state === "ready") && b?.kind === "slot")
        return conflict(db, id, "The build waits for the run slot. It goes on by itself.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      if (input.option === "leave") return leaveReason(db, t, b);
      if (input.option === "without") return withoutFixes(db, t, b);
      if (t.state === "stopped") {
        if (t.stopped_from !== "implementing" && t.stopped_from !== "ready") return conflict(db, id, TASK_STATE_TEXT.stopped);
        const error = db.transaction((): string | null => {
          const r = advance(db, { task: id, version: t.version }, { type: "RESUME" }, {}, now());
          if (r.status !== 200) return r.error;
          partsDone(db, id, setBlocked(db, { task: id, version: r.version }, null, now()));
          return null;
        })();
        if (error) return conflict(db, id, error);
        if (taskRow(db, id)?.state === "implementing") kick(db, id, true);
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      if (t.state !== "implementing" && t.state !== "ready") return conflict(db, id, TASK_STATE_TEXT[t.state]);
      // part-session.md section 9.4: Continue of the legacy reason question/paused builds with no reset, so each part keeps the changes of
      // its done step.
      if (t.state === "implementing" && b?.kind === "question" && b.step === null && b.text === PAUSED) {
        setBlocked(db, { task: id, version: t.version }, null, now());
        start(db, id, () => drive(db, id, false, true));
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      const form = formOf(db, id, b);
      if (form) return conflict(db, id, form);
      // part-session.md section 9.4: Continue on the reason update runs the update of its part again, as "Try again" does.
      if (b?.kind === "update") {
        const part = partOf(db, b);
        const target = part === null ? { error: b.text } : updateTarget(db, t, part);
        if ("error" in target) return conflict(db, id, target.error);
        beginUpdate(db, id, target.part.id, t.version);
        return { status: 200, task: dto(db, id) };
      }
      if (t.state === "ready" && !b) return conflict(db, id, TASK_STATE_TEXT.ready);
      if (t.state === "implementing" && !b && (drivers.has(id) || !buildingAll(db, id).length))
        return conflict(db, id, TASK_STATE_TEXT.implementing);
      // A plain Continue builds nothing when each part in its build is held. A planned part of a task with sub-tasks can still start.
      if (t.state === "implementing" && !b) {
        const all = parts(db, id);
        const held = all.find((p) => p.state === "implementing" && onHold(db, p.id));
        const other = all.some((p) => (p.state === "implementing" && !onHold(db, p.id)) || (t.subtasks === 1 && p.state === "planned"));
        if (held && !other) return conflict(db, id, HELD_GO(held.ord));
      }
      goOnReason(db, t, b, true);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/answers while the build waits for a question of Claude. The step starts again from the last commit with the
    // answer in context/answers.md.
    answer(db: Database, id: number, input: TaskAnswersInput): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const first = blockedOf(t);
      if (first?.kind !== "question") return conflict(db, id, "No question waits for an answer.");
      const open = db.query(Q.openLoop).all({ task: id }) as (QuestionRow & { step: number | null; point: number | null })[];
      if (!open.length) return conflict(db, id, "No question waits for an answer.");
      const given = new Map(input.answers.map((a) => [a.question, a]));
      if (given.size !== input.answers.length) return { status: 400, error: "Each question takes one answer." };
      for (const q of given.keys())
        if (!open.some((x) => x.id === q)) return { status: 400, error: `Question ${q} does not wait for an answer.` };
      for (const q of open) {
        const a = given.get(q.id);
        // pushback.md section 6.23.5 (AC-B362): a push-back has no recommended answer, so it needs the user's choice.
        if (q.point !== null && (a?.choice ?? null) === null) return { status: 400, error: PUSHBACK_FIRST };
        if (!a && !input.recommended) return { status: 400, error: "Answer each question, or use the recommended answers." };
        const problem = a && answerProblem(q, a);
        if (problem) return { status: 400, error: problem };
      }
      if (drivers.has(id)) return conflict(db, id, BUSY);
      // The question of a follow-up: it runs again with the answer in context/answers.md (spec.md section 6.18.2).
      const asked = open[0]?.step ? (db.query(Q.step).get({ id: open[0].step, task: id }) as StepRow | null) : null;
      const go = db.transaction((): boolean => {
        const at = now();
        for (const q of open) {
          const a = given.get(q.id);
          const answer: Answer = a
            ? { choice: a.choice ?? null, text: a.text?.trim() ?? "" }
            : { choice: q.kind === "choice" ? q.recommended : null, text: "" };
          db.query(Q.answer).run({ id: q.id, answer: JSON.stringify(answer), now: at });
          // spec.md section 6.25.4: one submit answers the waiting questions of other parts too.
          if (q.step !== null) db.query(Q.clearAsked).run({ task: id, step: q.step });
        }
        // pushback.md sections 6.23.5 and 6.23.6 (AC-B362): Accept discards the point with the reason of its why. "Fix it anyway" keeps
        // it, and one waiting fix row with item pushback per part takes those points.
        const forced = new Map<number, number[]>();
        for (const q of open) {
          if (q.point === null || q.step === null) continue;
          const row = db.query(Q.item).get({ id: q.point }) as { payload_json: string } | null;
          if (!row) continue;
          if (given.get(q.id)?.choice === 0) {
            const { discardReason: _, ...p } = JSON.parse(row.payload_json) as FindingPayload & { discardReason?: unknown };
            const why = p.pushback?.why;
            db.query(Q.discard).run({ id: q.point, payload: JSON.stringify(why ? { ...p, discardReason: { code: DISCARD_OF[why] } } : p) });
            continue;
          }
          const part = (db.query(Q.step).get({ id: q.step, task: id }) as StepRow).part as number;
          forced.set(part, [...(forced.get(part) ?? []), q.point]);
        }
        for (const [part, findings] of forced) {
          const attempt = (db.query(Q.attempt).get({ part, kind: "fix", item: "pushback" }) as { n: number }).n;
          const row = insertStep(db, { task: id, part, kind: "fix", item: "pushback", attempt, state: "waiting" }, at);
          patchStep(db, row, { findings });
        }
        // The first reason clears only when its step owns an answered question. Else it stays, and the version moves.
        const own = first.step !== null && open.some((q) => q.step === first.step);
        setBlocked(db, { task: id, version: t.version }, own ? null : first, at);
        if (!free(db, id)) return false;
        // A push-back question asks about a judging run that already committed, so that run does not run again.
        if (asked && isFollow(asked) && !open.some((q) => q.step === asked.id && q.point !== null)) requeue(db, id, asked.id, at);
        return true;
      })();
      if (go) goOn(db, id, asked?.part ?? null, true);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/allow (spec.md section 6.21, D3): one choice for each requested pattern. Allow once: only the next run of that
    // step gets the pattern. Allow for this repository: the pattern joins the list; the first one needs the shell warning. Refuse: the
    // next steps read "The user refused <pattern>." in step.md, and the pattern never shows again. The step runs again from the last
    // commit, as after an answer.
    allow(db: Database, id: number, input: TaskAllowInput): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const b = blockedOf(t);
      const ask = b?.kind === "allow" && b.step === input.step ? stepDetailOf(db, input.step).allowAsk : null;
      if (!ask) return conflict(db, id, "No command waits for your choice.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      const given = new Map(input.decisions.map((d) => [d.pattern, d.choice]));
      if (given.size !== input.decisions.length) return { status: 400, error: "Each pattern takes one choice." };
      for (const p of given.keys())
        if (!ask.requests.some((r) => r.pattern === p)) return { status: 400, error: `Claude did not ask to allow ${p}.` };
      if (given.size !== ask.requests.length) return { status: 400, error: "Pick a choice for each command." };
      const hosts = hostsOf(originsOf(settings.config()));
      for (const [p, choice] of given) {
        const problem = choice === "refuse" ? null : allowProblem(p, hosts);
        if (problem) return { status: 400, error: `${p}: ${problem}` };
      }
      const repo = repoSettings(db, t.project, t.repo);
      const keep = ask.requests.filter((r) => given.get(r.pattern) === "repo");
      const at = now();
      const merged = keep.length ? mergeAllow(repo.allow, keep, "request", hosts, at) : null;
      if (merged && "error" in merged) return { status: 400, error: merged.error };
      if (merged && repo.shellWarnedAt === null && !input.shellWarning) return { status: 400, error: SHELL_WARNING_FIRST };
      const asked = db.query(Q.step).get({ id: input.step, task: id }) as StepRow | null;
      const go = db.transaction((): boolean => {
        if (merged) {
          db.query(Q.ensureSettings).run({ project: t.project, repo: t.repo, now: at });
          saveAllow(db, t.project, t.repo, merged, input.shellWarning ? at : null);
        }
        patchStep(db, input.step, {
          allowAsk: { ...ask, decisions: ask.requests.map((r) => ({ pattern: r.pattern, choice: given.get(r.pattern) ?? "refuse" })) },
        });
        setBlocked(db, { task: id, version: t.version }, null, at);
        // A follow-up runs again as a new row, as after an answer (spec.md section 6.18.2).
        if (!free(db, id)) return false;
        if (asked && isFollow(asked)) requeue(db, id, asked.id, at);
        return true;
      })();
      if (go) goOn(db, id, asked?.part ?? null, true);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/limit. ps5-plan.md D1: "Change the limit" sets the line limit of the task while no driver runs. It needs no
    // reason, keeps every reason, and starts nothing.
    limit(db: Database, id: number, input: { version: number; lineBudget: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" && t.state !== "ready") return conflict(db, id, TASK_STATE_TEXT[t.state]);
      if (drivers.has(id)) return conflict(db, id, WORKING);
      setSettings(db, { task: id, version: t.version }, { ...taskSettingsOf(t), lineBudget: input.lineBudget }, now(), false);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/fix: "Fix these too" for the listed points of a part that waits for its PR. ps4-plan.md section
    // 2.2: a waiting fix row with item points is the follow-up of the part.
    fixPoints(db: Database, id: number, partId: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" || t.blocked_json !== null) return conflict(db, id, TASK_STATE_TEXT[t.state]);
      if (drivers.has(id)) return conflict(db, id, BUSY);
      if (parts(db, id).find((p) => p.id === partId)?.state !== "self_reviewed")
        return conflict(db, id, "This part does not wait for its PR.");
      if (!openPoints(db, id).length) return conflict(db, id, NO_POINTS);
      const attempt = (db.query(Q.attempt).get({ part: partId, kind: "fix", item: "points" }) as { n: number }).n;
      insertStep(db, { task: id, part: partId, kind: "fix", item: "points", attempt, state: "waiting" }, now());
      goPart(db, id, partId);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/spec-change/:step (AC-B20): accept commits the changed plan files, and the step starts again under the new
    // plan. Reject resets the step, and the step starts again with the rejection in step.md. Both save the other changes of the step as
    // its patch. The change of a send starts the send again as a new instruct row (spec.md section 6.18.2).
    async specChange(db: Database, id: number, stepId: number, input: { version: number; accept: boolean }): Promise<TaskResult> {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const b = blockedOf(t);
      // An instruct step on a part with an open PR waits in state ready (spec.md section 6.18.2).
      if ((t.state !== "implementing" && t.state !== "ready") || b?.kind !== "spec_change" || b.step !== stepId)
        return conflict(db, id, "No change to the spec waits for this step.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      const row = db.query(Q.step).get({ id: stepId, task: id }) as { part: number; item: string | null; detail_json: string } | null;
      const part = parts(db, id).find((p) => p.id === row?.part);
      if (!row || !part) return conflict(db, id, "No change to the spec waits for this step.");
      const detail = JSON.parse(row.detail_json) as { specChange?: { paths: string[] } | null; notes?: string[] };
      const note = (...s: string[]) => ({ specChange: detail.specChange ?? null, notes: [...(detail.notes ?? []), ...s] });
      const sent = row.item === null ? null : (db.query(Q.lastFollow).get({ part: part.id, item: row.item }) as { id: number } | null);
      const again = (go: boolean) => {
        if (go) goOn(db, id, part.id, !input.accept);
        changed(id);
        return { status: 200 as const, task: dto(db, id) };
      };
      // A follow-up runs again as a new row (spec.md section 6.18.2).
      const queue = () => {
        if (!free(db, id)) return false;
        if (sent) requeue(db, id, sent.id);
        return true;
      };
      if (!input.accept) {
        // build-redesign.md section 2.2: a rejected plan change is one of the four resets. The Continue rule of the next driver would
        // keep the change, so the part goes back to its last commit here.
        try {
          const c = await context(db, t, part, "instruct");
          await undo(c.trees, db, id, stepId);
        } catch (e) {
          return conflict(db, id, `The app could not reset the step: ${noUrl((e as Error).message)}`);
        }
        const go = db.transaction(() => {
          endStep(db, stepId, "cancelled", note(REJECTED, AGAIN), now());
          setBlocked(db, { task: id, version: t.version }, null, now());
          return queue();
        })();
        return again(go);
      }
      try {
        const c = await context(db, t, part);
        if (!c.who) return conflict(db, id, "Set user.name and user.email in your git config.");
        // The proposal of the step: its changed plan files. A file that the step deleted stays deleted.
        const proposal = (detail.specChange?.paths ?? []).map((p) => {
          const f = onDisk(c.wt, p);
          return { f, text: existsSync(f) ? readFileSync(f) : null };
        });
        await undo(c.trees, db, id, stepId);
        for (const { f, text } of proposal) {
          if (text === null) rmSync(f, { force: true });
          else {
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, text);
          }
        }
        const message = `${c.label}: Change the plan`;
        const r = await commitTask({
          db,
          task: id,
          part: part.id,
          wt: c.wt,
          item: "spec",
          message,
          who: c.who,
          allow: [],
          own: proposal.flatMap((x) => (x.text === null ? [] : [x.f])),
          trees: c.trees,
          now,
        });
        if (r.status === "refused") return conflict(db, id, deniedText(r.problems));
        // part-session.md section 2.2: the accept of a plan change that the session wrote moves the session heads.
        if (r.status === "committed") moveHeads(db, part.id, await headsNow(c), now());
      } catch (e) {
        return conflict(db, id, `The app could not commit the change: ${noUrl((e as Error).message)}`);
      }
      const go = db.transaction(() => {
        endStep(db, stepId, "ok", note("The user accepted the change."), now());
        const cur = taskRow(db, id) as TaskRow;
        setBlocked(db, { task: id, version: cur.version }, null, now());
        return queue();
      })();
      return again(go);
    },

    // POST /api/tasks/:id/instructions (spec.md section 6.18.2): one send starts exactly one instruct step. The text goes to Claude only.
    // ps4-plan.md WP-7 (part-session.md section 2.9): while a session run of the part runs, the text goes to the stdin of that run. Else
    // the build driver gets it as a waiting follow-up row, which the next GO picks. A mode driver takes no waiting row: endFollow reads
    // the newest follow-up row of the part as its own.
    instruct(db: Database, id: number, input: { version: number; part?: number; text: string }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const target = instructTarget(db, t, input.part);
      const running = drivers.has(id);
      if ("held" in target) return conflict(db, id, target.error);
      if (running && !("part" in target && sessionRunning(db, target.part.id))) return conflict(db, id, WORKING);
      if ("error" in target) return conflict(db, id, target.error);
      const part = target.part;
      if (running && review.sendPart(db, id, part.id, input.text, `Your message: ${input.text}`)) {
        // spec.md section 6.18.7: a second tab with the same version gets 409.
        bump(db, id, t.version);
        changed(id);
        return { status: 202, task: dto(db, id) };
      }
      // One waiting message per part, and none beside an open follow-up: invariant 8 allows one waiting message beside the open row,
      // and a cut follow-up goes in the queue again as a new waiting row.
      if (running && (modes.has(id) || db.query(Q.openFollow).get({ part: part.id }))) return conflict(db, id, WORKING);
      db.transaction(() => {
        const n = (db.query(Q.sends).get({ task: id, kind: "instruct" }) as { n: number }).n + 1;
        const r = insertStep(db, { task: id, part: part.id, kind: "instruct", item: `I${n}`, state: "waiting" }, now());
        const before = running ? null : blockedOf(t);
        patchStep(db, r, { instruct: { text: input.text, part: part.id, blockedBefore: before, result: null, committed: false } });
        // The version moves, so a second tab gets 409 with the current task (spec.md section 6.18.7). A waiting message keeps the reason.
        if (running) bump(db, id, t.version);
        else setBlocked(db, { task: id, version: t.version }, null, now());
      })();
      if (!running) goPart(db, id, part.id);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/comments (ps6-ps7-plan.md section 3, AC-B388): the picked threads of the newest sorted run go to
    // the part session as one waiting instruct row with purpose comments, as a send of "Tell Claude" does. The comment text never goes
    // to the stdin of a running run, so a working driver refuses.
    comments(db: Database, id: number, partId: number, input: TaskCommentsInput): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const pr = (db.query(Q.partPr).get({ id: partId }) as { pr: number | null } | null)?.pr ?? null;
      const live = pr === null ? null : liveTaskPart(db, pr);
      if (pr === null || !live?.main || live.part !== partId) return conflict(db, id, NO_TASK_PR);
      const target = instructTarget(db, t, partId);
      if ("error" in target) return conflict(db, id, target.error);
      if (drivers.has(id)) return conflict(db, id, WORKING);
      const sorted = sortedRun(db, partId, pr);
      if (!sorted) return conflict(db, id, "Sort the comments first.");
      const by = new Map(sorted.threads.map((x) => [x.thread, x]));
      const missing = input.threads.find((x) => !by.has(x));
      if (missing !== undefined) return { status: 400, error: `Thread ${missing} is not in the newest sorted run.` };
      const threads = input.threads.map((thread) => {
        const p = (by.get(thread) as NonNullable<ReturnType<typeof by.get>>).payload;
        return { thread, replyTo: p.replyTo, group: p.group ?? null };
      });
      db.transaction(() => {
        const n = (db.query(Q.sends).get({ task: id, kind: "instruct" }) as { n: number }).n + 1;
        const r = insertStep(db, { task: id, part: partId, kind: "instruct", item: `C${n}`, state: "waiting" }, now());
        patchStep(db, r, {
          instruct: {
            text: `Address the PR comments of part ${target.part.ord}`,
            part: partId,
            blockedBefore: blockedOf(t),
            result: null,
            committed: false,
            purpose: "comments",
            comments: { pr, run: sorted.run, threads, verdicts: null, drafted: false },
          },
        });
        setBlocked(db, { task: id, version: t.version }, null, now());
      })();
      goPart(db, id, partId);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // PUT /api/tasks/:id/base after the build started (spec.md section 6.16.7, "Pick a base branch"): only the repository whose base the
    // pre-flight did not find, and only before its first push and PR. Before any part, the new head becomes the base commit. Else
    // base_changed makes the next update rebase the commits from the old base commit onto the new base.
    async base(db: Database, id: number, input: { version: number; taskRepo?: number; branch: string }): Promise<TaskResult> {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const b = blockedOf(t);
      const rows = taskRepos(db, t);
      const row = rows.find((r) => (input.taskRepo === undefined ? r.role === "main" : r.id === input.taskRepo));
      if (b?.kind !== "preflight" || !b.base || !row || row.id !== b.base.taskRepo)
        return conflict(db, id, "The base branch changes only before the build.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      const main = row.role === "main";
      const project = row.project ?? t.project;
      const repo = row.repo ?? t.repo;
      const name = `${project}/${repo}`;
      if (db.query(main ? Q.mainSent : Q.repoSent).get(main ? { task: id } : { repo: row.id }))
        return conflict(db, id, `The base branch of ${name} changes only before its first push and PR.`);
      if (input.branch === b.base.branch) return conflict(db, id, b.text);
      let head: string | null = null;
      try {
        const remote = await review.taskRemote(project, repo);
        if ((await remoteBranches(dataDir, remote, input.branch)).has(input.branch))
          head = await fetchBase(dataDir, id, { row, project, repo, base: input.branch } as UpdateRepo, remote);
      } catch (e) {
        return conflict(db, id, `Cannot read the branches of ${name}. ${noUrl((e as Error).message)}`);
      }
      if (!head) return conflict(db, id, `${input.branch} does not exist in ${name}.`);
      const newHead = head;
      const error = db.transaction((): string | null => {
        const cur = taskRow(db, id);
        if (!cur || cur.version !== input.version) return TASK_CHANGED;
        if (drivers.has(id)) return BUSY;
        // A submodule starts at the gitlink of its parent, not at its base head, so it always takes the update.
        const fresh = parts(db, id).length === 0 && row.role !== "submodule";
        if (main) {
          const base = fresh ? newHead : cur.base_commit;
          db.query(Q.target).run({ id, branch: input.branch, base });
          saveMainRepo(db, cur, input.branch, base, now());
          db.query(Q.partBranch).run({ task: id, branch: input.branch });
        } else {
          db.query(Q.repoBranch).run({ id: row.id, branch: input.branch, base: fresh ? newHead : row.base_commit });
          db.query(Q.prBranch).run({ repo: row.id, branch: input.branch });
        }
        if (!fresh) db.query(Q.baseChanged).run({ task: id, id: row.id, main: main ? 1 : 0, changed: 1 });
        setBlocked(db, { task: id, version: cur.version }, null, now());
        return null;
      })();
      if (error) return conflict(db, id, error);
      log(`Task ${id}: the base branch of ${name} is now ${input.branch}.`);
      if (free(db, id)) kick(db, id, true);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/update (spec.md section 6.18.6): 409 when no base moved and no PR reports conflicts.
    async update(db: Database, id: number, partId: number, input: { version: number }): Promise<TaskResult> {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (drivers.has(id)) return conflict(db, id, WORKING);
      // A base check of the Task view fetches into the same refs: the update waits for it.
      await checking.get(id);
      const target = updateTarget(db, t, partId);
      if ("error" in target) return conflict(db, id, target.error);
      const moves = (await refreshBases(db, id)).filter((m) => m.part === partId);
      const cur = taskRow(db, id) as TaskRow;
      const bases = taskDto(db, cur).parts.find((x) => x.id === partId)?.bases ?? [];
      if (!moves.some((m) => m.newCommits > 0) && !bases.some((b) => b.conflicted || b.changed)) {
        const names = [...new Set(bases.map((b) => b.branch))];
        return conflict(db, id, names.length === 1 ? `${names[0]} has no new commits.` : "The base branches have no new commits.");
      }
      const again = load(db, id, cur.version);
      if ("status" in again) return again;
      if (drivers.has(id)) return conflict(db, id, WORKING);
      const ready = updateTarget(db, again, partId);
      if ("error" in ready) return conflict(db, id, ready.error);
      beginUpdate(db, id, partId, again.version);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/update/undo (spec.md section 6.18.3, Checks): every repository goes back to its head before the
    // update, and base_commit comes back. 409 after the next push.
    async undoUpdate(db: Database, id: number, partId: number, input: { version: number }): Promise<TaskResult> {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (drivers.has(id)) return conflict(db, id, WORKING);
      const u = undoTarget(db, t, partId);
      if ("error" in u) return conflict(db, id, u.error);
      // The undo writes no step row, so Skip and Start again see the part busy only through the claim.
      enter(active, id, u.part.id);
      const work = (async (): Promise<string | null> => {
        const part = parts(db, id).find((p) => p.id === u.part.id) as PartRow;
        const c = await context(db, t, part, "update");
        for (const h of u.detail.postHeads) {
          const tree = c.trees.find((x) => x.row.id === h.taskRepo);
          if (tree?.wt && (await headOf(tree.wt)) !== h.head) return "The branch changed after the update.";
        }
        await restoreUpdate(db, c, u.detail.preHeads);
        db.transaction(() => {
          patchStep(db, u.step, { update: { ...u.detail, undone: true } });
          const cur = taskRow(db, id) as TaskRow;
          setBlocked(db, { task: id, version: cur.version }, null, now());
        })();
        await countLines(await context(db, taskRow(db, id) as TaskRow, part, "update"));
        return null;
      })();
      const held = work.then(
        () => undefined,
        () => undefined,
      );
      drivers.set(id, held);
      try {
        const error = await work;
        if (error) return conflict(db, id, error);
      } catch (e) {
        return conflict(db, id, `The app could not undo the update: ${noUrl((e as Error).message)}`);
      } finally {
        leave(active, id, u.part.id);
        if (drivers.get(id) === held) drivers.delete(id);
        changed(id);
      }
      return { status: 200, task: dto(db, id) };
    },

    // GET /api/tasks/:id (spec.md section 6.18.5): a base check in the background, at most once per BASE_CHECK_AGE per task.
    baseCheck(db: Database, id: number) {
      const last = baseCheckOf(db, id);
      const t = taskRow(db, id);
      if (closing || checking.has(id) || drivers.has(id) || (last && now() - last.at < BASE_CHECK_AGE_MS)) return;
      if (!t || (t.state !== "implementing" && t.state !== "ready")) return;
      setBaseMoves(db, id, last?.moves ?? [], now());
      check(db, id);
    },

    // POST /api/tasks/:id/base-check (spec.md section 6.18.5): the base check before the PR dialog, without the BASE_CHECK_AGE limit. A
    // running check gives its result. A working driver runs its own check at its end.
    async checkBases(db: Database, id: number): Promise<TaskResult> {
      if (!taskRow(db, id)) return { status: 404, error: "Task not found." };
      if (!closing && !drivers.has(id)) await (checking.get(id) ?? check(db, id));
      return { status: 200, task: dto(db, id) };
    },

    // The first open of the database: the updates that a restart stopped (spec.md section 6.18.4, Restart), and the timers of the armed
    // usage reasons (part-session.md section 9.5). A past resumeAt fires at once.
    recover(db: Database) {
      for (const { task } of db.query(Q.restartTasks).all() as { task: number }[])
        start(db, task, async () => {
          try {
            await recoverUpdates(db, task);
          } catch (e) {
            log(`Task ${task}: could not reset the update that a restart stopped: ${noUrl((e as Error).message)}`);
          }
        });
      for (const { id } of db.query(Q.armed).all() as { id: number }[]) rearm(db, id);
    },

    // Resolves when the build of the task waits or ends.
    idle(id: number): Promise<void> {
      return drivers.get(id) ?? Promise.resolve();
    },
    // true while a driver works on the task.
    running: (id: number) => drivers.has(id),
    // ps4-plan.md WP-7: TaskPartDto.instructRun, by the rules of instruct() before its write. live: the live gate is on, so the send goes
    // to the stdin of the session run of the part; a failed write still falls back as instruct() does. queued: the send waits as the
    // message of the part. null: no driver works, or the send gets 409.
    instructRun(db: Database, id: number, partId: number): "live" | "queued" | null {
      const t = taskRow(db, id);
      if (!t || !drivers.has(id)) return null;
      const target = instructTarget(db, t, partId);
      if ("error" in target || !sessionRunning(db, partId)) return null;
      if (review.sessionGates.live) return "live";
      return modes.has(id) || db.query(Q.openFollow).get({ part: partId }) ? null : "queued";
    },

    // spec.md section 6.7, Line endings, Repair: pr.ts runs it before each push and PR create of a part.
    async matchBase(db: Database, id: number, partId: number) {
      const t = taskRow(db, id);
      const part = t ? parts(db, id).find((p) => p.id === partId) : undefined;
      if (t && part && !part.adopted) await matchBase(await context(db, t, part));
    },
    // The user action routes call it first. The waiting state shows before the driver ends its base check, so the route waits for that
    // check. A driver that still runs a step is not awaited, and the route refuses as before.
    async settle(id: number) {
      if (ending.has(id)) await drivers.get(id);
    },

    // At app stop (review.stop()): no new step, the checks are killed, and the drivers end.
    async shutdown() {
      closing = true;
      for (const u of usageTimers.values()) clearTimeout(u.timer);
      usageTimers.clear();
      for (const id of [...aborts.keys()]) abortChecks(id);
      for (const w of slotWaits.values()) w();
      await Promise.all([...drivers.values(), ...checking.values()]);
    },
  };
}

export type TaskLoop = ReturnType<typeof createLoop>;
