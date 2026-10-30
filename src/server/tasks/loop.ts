// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build loop of a task part (docs/plans/review-v2/spec.md sections 6.2, 6.7, and 6.14; design.md section 5.5 "Loop of one part"):
// the part rows, the plan commit, the setup commands, the tests step, the implement and fix steps, the checks, the commits with ticks,
// the size check, the own review, the blocked reasons, pause, resume, stop, and the waits for the run slot. advance() and
// advancePart() make every state change. A restart or a resume starts again from the last commit of the part branch: the commit rows
// and the ticks of the plan file tell what is done.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { initialTransition } from "xstate";
import { indentBlock, oneLine } from "../../shared/consult";
import type { TaskAnswersInput } from "../../shared/dto";
import type { FindingPayload } from "../../shared/review";
import {
  BASE_CHECK_AGE_MS,
  FAILURE_TAIL,
  type ImplementResult,
  type InstructDetail,
  LARGE_REPOS_TEXT,
  type PartState,
  RESOLVE_STOPS,
  type StartMode,
  type StepMode,
  stepDetail,
  TASK_STATE_TEXT,
  type TaskBlocked,
  type TaskSize,
  taskBlocked,
  taskSettings,
  type UpdateDetail,
  updateDetail,
} from "../../shared/task";
import { foundOf } from "../context/task-file";
import type { Live } from "../live";
import { log } from "../log";
import type { Profile } from "../review/catalog";
import { identity } from "../review/clone";
import { fold } from "../review/edits";
import type { ReviewJobs, TaskReviewStart } from "../review/jobs";
import type { Ending } from "../review/judge";
import { repoPath } from "../review/validate";
import { type BranchRemote, type ContextFile, cachePath, longPath, noUrl } from "../review/workspace";
import { branchPrefixesOf, type Settings } from "../settings";
import { CHECK_KINDS, type ChecksResult, checkStep, type Scope } from "./checks";
import {
  commitTask,
  endStep,
  insertStep,
  type PathProblem,
  partBudget,
  patchStep,
  runningStep,
  type StepInput,
  type StepOutcome,
  startStep,
  stepDetailOf,
} from "./implement";
import { type Answer, answerProblem, type QuestionRow } from "./interview";
import { partMachine } from "./machine";
import { type Docs, docNames, type Plan, type PlanPart, type PlanTask, parsePlan, parseTasks, partStepFile, stepFile } from "./plan";
import { type PreflightDeps, preflight } from "./preflight";
import { saveMainRepo, sourceOf, type TaskRepoRow, taskRepos, type UpdateRepo, updateRepos } from "./repos";
import {
  advance,
  advancePart,
  baseCheckOf,
  budgetOf,
  currentPart,
  instructTarget,
  keysOf,
  type LowerPart,
  lowerHowOf,
  lowerOf,
  moreTime,
  mustFixPoint,
  openPoints,
  partDocsOf,
  partNames,
  repoSettings,
  scheduleOf,
  setBaseMoves,
  setBlocked,
  setLowerHow,
  setSettings,
  stepAnswers,
  stopForRun,
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
  WORKING,
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
  branchName,
  firstFree,
  freeBranch,
  headOf,
  mergeBase,
  noneChanges,
  openRepoTrees,
  openWorktree,
  patchFile,
  type RepoTree,
  remoteBranches,
  resetTrees,
  resetWorktree,
  savePatch,
  setupMark,
  status,
  takenBranches,
  takeRemoteBranch,
  type Worktree,
  wtGit,
} from "./worktree";

// spec.md section 0.
export const TEST_FIX_TRIES = 3;
export const REVIEW_FIX_TRIES = 2;
// spec.md section 6.1, Counting: the excluded globs when the repository sets none.
export const LOCK_GLOBS = ["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "*.lock"];
export const PAUSED = "Building is paused after the step. Continue?";
// The part states with a worktree (tasks.ts HAS_WORKTREE).
const WORKTREE = new Set<PartState>(["implementing", "self_reviewed", "pr_open", "changes_requested", "approved"]);
// spec.md sections 6.20.6 and 6.20.7: a PR that colleagues review, a started part, and a part that keeps the task in implementing.
const HAS_PR = new Set<PartState>(["pr_open", "changes_requested", "approved"]);
const STARTED = new Set<PartState>([...WORKTREE, "declined"]);
const WAITS_PR = new Set<PartState>(["planned", "implementing", "self_reviewed"]);
const NO_TEST = "Needs you: approve a test command for this repository first. The build needs it to see red and green tests.";
const BUSY = "The build still ends its step. Try again when it ends.";

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
// globs. A binary file counts 0. git-diff(1), --numstat with -z: a rename has an empty path, then the old and the new path.
export async function changedLines(wt: Worktree, base: string, head: string, exclude: readonly string[]): Promise<LineCount> {
  // spec.md section 6.16.6: gitlink entries do not count.
  const out = (await wtGit(wt, ["diff", "--numstat", "-z", "-M", "--ignore-submodules=all", base, head])).split("\0");
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

// context/failure.md of a fix step after red checks: the failed commands with the end of their output. All tails together stay
// within FAILURE_TAIL (spec.md section 0, OUTPUT_TAIL: 32 KB sent to Claude).
export function checkFailure(r: Extract<ChecksResult, { status: "ran" }>): ContextFile {
  const failed = r.commands.filter((c) => c.exit !== 0);
  const each = Math.floor(FAILURE_TAIL / Math.max(1, failed.length));
  const out = [
    "# Check output",
    "",
    "The app ran the approved commands after your step. After a task, the test command runs only the tests of the task. These commands failed. Each shows the end of its output.",
    "",
  ];
  for (const c of failed) {
    const tail = Buffer.from(c.tail);
    const text = tail.length > each ? tail.subarray(tail.length - each).toString() : c.tail;
    out.push(`## ${oneLine(c.name)}: ${c.exit === null ? "no exit code" : `exit ${c.exit}`} after ${c.ms} ms`, "");
    out.push(`- Command: ${oneLine(c.argv.join(" "))}`, "", indentBlock(text.trimEnd() || "(no output)"), "");
  }
  return { name: "failure.md", text: out.join("\n") };
}

type Point = { id: number; payload: FindingPayload };

// The points of the own review that the loop fixes: confirmed blocker and major findings (spec.md section 6.7).
export const mustFix = (points: Point[]) => points.filter((p) => mustFixPoint(p.payload));

// context/failure.md of a fix step after the own review: the confirmed points with path:line.
export function reviewFailure(points: Point[]): ContextFile {
  const out = ["# Review points", "", "Claude's own review of this part confirmed these points. Fix the cause of each one.", ""];
  for (const { id, payload: f } of points) {
    out.push(`## Point ${id}: ${f.severity} at ${oneLine(f.path)}:${f.line}`, "", indentBlock(f.body.trim() || "(no text)"), "");
    if (f.trigger?.trim()) out.push(`- Trigger: ${oneLine(f.trigger)}`, "");
  }
  return { name: "failure.md", text: out.join("\n") };
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
};

type DriverMode = "build" | "instruct" | "update";

const Q = {
  parts: `SELECT id, ord, kind, title, branch, base_branch, state, head, pushed, keys_json, start_mode, after_part, base_commit, spec_dir,
    adopted, override FROM task_part WHERE task = $task ORDER BY ord`,
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
  lastStep: "SELECT MAX(id) AS id FROM task_step WHERE part = $part",
  lines: "UPDATE task_part SET lines = $lines, files = $files, updated_at = $now WHERE id = $id",
  clone: "SELECT path FROM repo_clone WHERE project = $project AND repo = $repo",
  points: "SELECT id, payload_json FROM review_item WHERE run = $run AND kind = 'finding' ORDER BY id",
  question: `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, recommended, step, asked_at)
    VALUES ($task, 'loop', (SELECT COALESCE(MAX(round), 0) + 1 FROM task_question WHERE task = $task), 0, $text, $why, $kind, $options,
      $recommended, $step, $now)`,
  openLoop: "SELECT * FROM task_question WHERE task = $task AND source = 'loop' AND answer_json IS NULL ORDER BY id",
  answer: "UPDATE task_question SET answer_json = $answer, answered_at = $now WHERE id = $id AND answer_json IS NULL",
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
};

// The changed paths of every worktree, from the main repository root.
async function dirty(trees: readonly RepoTree[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of trees) if (t.wt) for (const e of await status(t.wt)) out.push(t.full ? `${t.full}/${e.path}` : e.path);
  return out;
}

// true: the folder of a repository with access none holds something.
const noneDirty = (trees: readonly RepoTree[], t: RepoTree) =>
  t.row.access === "none" && !!trees.find((x) => x.row.id === t.row.parent)?.wt && noneChanges(trees, t).length > 0;

// A changed submodule or added repository with access edit: its task branch head differs from its base and the diff is not empty
// (spec.md section 6.16.6, Changed repositories).
type ChangedSub = { tree: RepoTree; base: string; head: string };

export type LoopOptions = { review: ReviewJobs; settings: Settings; live: Live; now?: () => number };

export function createLoop(opts: LoopOptions) {
  const { review, settings, live } = opts;
  const now = opts.now ?? Date.now;
  const dataDir = review.dataDir;
  // One driver per task. It awaits each step and ends at the first blocked reason.
  const drivers = new Map<number, Promise<void>>();
  // Pause after this step: the next Claude step waits at the gate until Resume.
  const pauseAsked = new Set<number>();
  const gates = new Map<number, () => void>();
  const slotWaits = new Map<number, () => void>();
  const aborts = new Map<number, AbortController>();
  // spec.md section 6.18: the driver of an instruct step or an update, and its Stop. A Stop of them keeps the task state.
  const modes = new Map<number, Exclude<DriverMode, "build">>();
  const stopping = new Set<number>();
  // The base checks that run in the background, so shutdown() awaits them.
  const checking = new Map<number, Promise<unknown>>();
  // The drivers whose work ended and that run only the base check at their end (spec.md section 6.18.5).
  const ending = new Set<number>();
  let closing = false;

  const changed = (id: number) => live.broadcast("changed", { tasks: [id] });
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
  const building = (db: Database, id: number) => parts(db, id).find((p) => p.state === "implementing") ?? null;

  // Sets the reason while the task builds, or while an instruct step or an update runs on a built part (spec.md section 6.18). block()
  // also ends the driver.
  function reason(db: Database, id: number, b: TaskBlocked | null) {
    db.transaction(() => {
      const cur = taskRow(db, id);
      if (cur?.state === "implementing" || cur?.state === "ready") setBlocked(db, { task: id, version: cur.version }, b, now());
    })();
    changed(id);
  }
  function block(c: Ctx, b: TaskBlocked): never {
    reason(c.db, c.id, b);
    throw new Halt();
  }
  // The loop goes on only while the task builds with no reason. An instruct step or an update also runs in state ready.
  const isLive = (c: Pick<Ctx, "db" | "id" | "mode">) => {
    const t = taskRow(c.db, c.id);
    const state = t?.state === "implementing" || (c.mode !== "build" && t?.state === "ready");
    return !closing && !stopping.has(c.id) && state && t?.blocked_json === null;
  };
  function guard(c: Ctx) {
    if (!isLive(c)) throw new Halt();
  }

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

  // Waits for the run slot (design.md B12). The step row waits too, and the reason says whose run holds the slot.
  async function waitSlot(
    c: Ctx,
    s: { kind: StepMode | "review"; item: string; attempt: number },
    holder: { pr: number | null; kind: string; task?: number },
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
    const text = pr
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
    if (!isLive(c)) {
      endStep(c.db, step, "cancelled", { notes: ["The build stopped while the step waited for the run slot."] }, now());
      changed(c.id);
      throw new Halt();
    }
    return step;
  }

  // Pause after this step: the loop holds before it takes the run slot again, with every change of the done step kept.
  async function gate(c: Ctx) {
    if (!pauseAsked.delete(c.id)) return;
    reason(c.db, c.id, { kind: "question", step: null, text: PAUSED });
    await new Promise<void>((resolve) => gates.set(c.id, resolve));
    gates.delete(c.id);
    guard(c);
  }

  // One Claude step in the run slot (implement.ts), with its outcome. row: the step row that the route wrote (an instruct or a resolve
  // step). A run that did not start (a stop, a reason such as the time budget) halts.
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
    },
  ): Promise<{ r: StepOutcome | null; before: Set<string> }> {
    let waiting: number | null = o.row ?? null;
    for (;;) {
      await gate(c);
      guard(c);
      const attempt =
        o.row === undefined ? nextAttempt(c, mode, item) : (c.db.query(Q.rowAttempt).get({ id: o.row }) as { attempt: number }).attempt;
      const before = new Set(await dirty(c.trees));
      const answers = stepAnswers(c.db, c.id);
      // spec.md section 6.17: the task text and the included files as they are at this step. Section 6.20.3: a part gets the files of the
      // task and of its own sub-tasks only.
      const task = taskFilesOf(c.db, dataDir, c.t, filesFor(c));
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
        untrusted: [...task.files, ...(o.failure ? [o.failure] : [])],
        attachments: task.attachments,
        own: [...(answers ? [answers] : []), o.step(attempt), ...planFiles(c)],
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
        live: () => isLive(c),
        now,
      });
      if (s.status === 409 && "conflict" in s) {
        waiting = await waitSlot(c, { kind: mode, item, attempt }, s.conflict.running, waiting);
        continue;
      }
      changed(c.id);
      if (s.status !== 202) throw new Halt();
      await s.done;
      changed(c.id);
      return { r: out as StepOutcome | null, before };
    }
  }

  // One Claude step that returns only with a result: a denied path, a failed run, a question, and a plan change set their reason and
  // halt. A failed instruct step throws StepFailed: its driver restores the earlier reason (spec.md section 6.18.7).
  async function claude(
    c: Ctx,
    mode: StepMode,
    item: string,
    o: { allow: string[]; step: (attempt: number) => ContextFile; failure?: ContextFile; row?: number; instructions?: string },
  ): Promise<StepOutcome & { result: ImplementResult; fresh: string[] }> {
    const { r, before } = await runStep(c, mode, item, o);
    // No result: implement.ts stopped the task, or it set the denied path. No outcome: restart recovery ended the run first.
    if (!r?.result) throw r && !r.problems.length && mode === "instruct" ? new StepFailed(r.text ?? "The run failed.") : new Halt();
    const fresh = r.changed.filter((p) => !before.has(p));
    const spec = fresh.filter((p) => under(p, c.specDir));
    if (spec.length) {
      const attempt = (c.db.query(Q.rowAttempt).get({ id: r.step }) as { attempt: number }).attempt;
      const step = insertStep(c.db, { task: c.id, part: c.part.id, kind: "spec_change", item, attempt, state: "ok" }, now());
      endStep(c.db, step, "ok", { specChange: { paths: spec }, notes: r.result.specChange ? [r.result.specChange] : [] }, now());
      block(c, { kind: "spec_change", step, text: "Needs you: Claude proposes a change to the spec." });
    }
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
    return { ...r, result: r.result, fresh };
  }

  // The approved checks with their step row. A stop kills the commands (AC-B19).
  async function checks(c: Ctx, item: string, kinds = CHECK_KINDS, scope?: Scope, expectRed = false) {
    guard(c);
    const ac = new AbortController();
    aborts.set(c.id, ac);
    try {
      changed(c.id);
      const r = await checkStep({
        db: c.db,
        dataDir,
        project: c.t.project,
        repo: c.t.repo,
        wt: c.wt,
        kinds,
        scope,
        signal: ac.signal,
        task: c.id,
        part: c.part.id,
        item,
        attempt: nextAttempt(c, "check", item),
        expectRed,
        now,
      });
      changed(c.id);
      if (r.status === "refused") block(c, { kind: "error", step: r.step, text: `Needs you: ${r.reason}` });
      if (r.commands.some((x) => x.stopped)) throw new Halt();
      guard(c);
      return r;
    } finally {
      aborts.delete(c.id);
    }
  }

  // spec.md section 6.1: the changed lines of the part against the line budget. Over it, the part waits for the user's choice.
  async function sizeCheck(c: Ctx) {
    const n = await countLines(c);
    if (n.lines <= c.budget || c.keep) return;
    const text = `Needs you: this PR would have ${n.lines} changed lines, over your ${c.budget} limit.`;
    const step = insertStep(c.db, { task: c.id, part: c.part.id, kind: "size", item: null, state: "failed" }, now());
    endStep(c.db, step, "failed", { diffStat: n, notes: [text] }, now());
    block(c, { kind: "size", step, text });
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

  // spec.md section 6.7, Commit: one commit per step with the user's name and email, then the size check.
  async function commit(c: Ctx, item: string, message: string, allow: string[]) {
    guard(c);
    if (!c.who) block(c, { kind: "error", step: null, text: "Needs you: set user.name and user.email in your git config." });
    // spec.md section 6.16.5, Size: a large build that changes a submodule stops.
    if (c.size === "large")
      for (const s of c.trees)
        if (s.row.role === "submodule" && s.wt && (await status(s.wt)).length)
          block(c, { kind: "size", step: null, text: LARGE_REPOS_TEXT });
    const r = await commitTask({ db: c.db, task: c.id, part: c.part.id, wt: c.wt, item, message, who: c.who, allow, trees: c.trees, now });
    if (r.status === "refused") block(c, { kind: "denied_path", step: null, text: deniedText(r.problems) });
    changed(c.id);
    await sizeCheck(c);
  }

  // Red checks start at most TEST_FIX_TRIES fix steps (AC-B11). scope: the scoped check of one task instead of all approved checks.
  async function greenOrFix(c: Ctx, item: string, allow: string[], step: (attempt: number) => ContextFile, scope?: Scope) {
    const run = () => checks(c, item, scope ? ["test"] : CHECK_KINDS, scope);
    let k = await run();
    for (let tries = 0; !k.green; tries++) {
      if (tries >= TEST_FIX_TRIES)
        block(c, {
          kind: "red",
          step: k.step,
          text: `Needs you: the tests of part ${c.part.ord} stay red after ${TEST_FIX_TRIES} tries.`,
        });
      await claude(c, "fix", item, { allow, step, failure: checkFailure(k) });
      k = await run();
    }
  }

  // Saves the uncommitted changes as a patch, then returns the worktree to its last commit (spec.md section 6.7, Resume). Several
  // repositories: a patch per changed worktree, then the reset deepest first (section 6.16.6).
  async function undo(trees: RepoTree[], db: Database, id: number, step: number) {
    const main = trees[0]?.wt as Worktree;
    if (!(await dirty(trees)).length && trees.every((t) => t.wt || !noneDirty(trees, t))) return;
    const file = patchFile(dataDir, db, id, step);
    for (const t of trees) {
      if (!t.wt) continue;
      const paths = (await status(t.wt)).map((e) => e.path);
      if (!paths.length) continue;
      await savePatch(t.wt, t.row.role === "main" ? file : file.replace(/\.patch$/, `-${t.row.id}.patch`), paths).catch((e) =>
        log(`Task ${id}: could not save the patch of step ${step}: ${noUrl((e as Error).message)}`),
      );
    }
    if (trees.length === 1) await resetWorktree(main, await headOf(main));
    else await resetTrees(trees, await headOf(main));
  }

  const testPaths = (pp: PlanPart) => [...pp.tests.map((x) => x.test), ...pp.tasks.flatMap((t) => t.run)];
  // The tests step may change only test files: the test globs of the repository, else the tests that the plan names.
  const isTest = (c: Ctx, pp: PlanPart, path: string) =>
    c.testGlobs ? c.testGlobs.some((g) => globMatch(g, path)) : testPaths(pp).some((x) => same(x, path));

  // spec.md section 6.7: the tests step. Its changes stay in the test paths, and the new tests fail (AC-B10).
  async function testsStep(c: Ctx, pp: PlanPart) {
    const item = `P${pp.n}`;
    const allow = pp.tasks.flatMap((t) => t.files);
    const where = c.testGlobs ? `the test globs ${c.testGlobs.join(", ")}` : `the tests of the plan: ${testPaths(pp).join(", ")}`;
    let failure: ContextFile | undefined;
    for (let round = 0; ; round++) {
      const r = await claude(c, "tests", item, { allow, step: (a) => partStepFile(c.plan, [pp], "tests", a), failure });
      const outside = r.fresh.filter((p) => !isTest(c, pp, p));
      if (!r.fresh.length || outside.length) {
        const why = r.fresh.length ? `The step changed files that are not tests: ${outside.join(", ")}.` : "The step wrote no test.";
        if (round >= 1)
          block(c, { kind: "red", step: r.step, text: `Needs you: the tests step of part ${c.part.ord} failed twice. ${why}` });
        await undo(c.trees, c.db, c.id, r.step);
        failure = { name: "failure.md", text: `# Tests step\n\n${why} Change only test files. The test paths are ${where}.\n` };
        continue;
      }
      const k = await checks(c, item, CHECK_KINDS, undefined, true);
      if (k.green) block(c, { kind: "red", step: k.step, text: "Tests pass before the change. See why." });
      await commit(c, item, `${c.label} ${item}: Add the failing tests of part ${pp.n}`, allow);
      return;
    }
  }

  // One task: the implement step, the scoped check of its Run line with the fixes, the tick, and the commit. The tests of the later
  // tasks of the part stay red until their own task, so they never gate this one.
  async function taskStep(c: Ctx, pp: PlanPart, task: PlanTask) {
    const step = (a: number) => stepFile(c.plan, task.id, a) as ContextFile;
    const later = pp.tasks.slice(pp.tasks.findIndex((t) => t.id === task.id) + 1).flatMap((t) => t.run);
    await claude(c, "implement", task.id, { allow: task.files, step });
    await greenOrFix(c, task.id, task.files, step, { run: task.run, later });
    const name = c.size === "small" ? "plan" : "tasks";
    const p = onDisk(c.wt, specPath(c.specDir, name));
    const ticked = existsSync(p) ? tickTask(readFileSync(p, "utf8"), task.id) : null;
    if (ticked === null) block(c, { kind: "error", step: null, text: `Needs you: ${name}.md has no open task ${task.id}.` });
    writeFileSync(p, ticked);
    await commit(c, task.id, `${c.label} ${task.id}: ${oneLine(task.title)}`, task.files);
    refreshPlan(c);
    const s = taskSettings.safeParse(JSON.parse(taskRow(c.db, c.id)?.settings_json ?? "{}"));
    if (s.success && s.data.pauseAfterTask) block(c, { kind: "question", step: null, text: `Task ${task.id} is done. Continue?` });
  }

  // The own review run (kind review, task set, pr NULL) on a snapshot of the part head. sub: a changed submodule instead of the main
  // repository; its run reads that repository's base..head (spec.md section 6.16.5, Snapshots).
  async function reviewRun(c: Ctx, sub?: ChangedSub): Promise<{ step: number; points: Point[] }> {
    let waiting: number | null = null;
    for (;;) {
      await gate(c);
      guard(c);
      // spec.md section 6.17: the task text and the included files as they are at this step.
      const task = taskFilesOf(c.db, dataDir, c.t, filesFor(c));
      const issue = task.files.map((f) => f.text).join("\n\n");
      const head = sub ? sub.head : await headOf(c.wt);
      const attempt = nextAttempt(c, "review", "review");
      const src = sub
        ? sourceOf(
            c.trees.map((x) => x.row),
            sub.tree.row,
          )
        : null;
      const plans = planFiles(c).map((f) => `## ${f.name.slice("spec/".length)}\n\n${f.text}`);
      const goals = c.plan.parts.map((x) => `- Part ${x.n}: ${oneLine(x.title)}. ${oneLine(x.goal)}`);
      let ended: { step: number; run: number; ok: boolean; text: string | null } | null = null;
      let step = 0;
      const start: TaskReviewStart = {
        task: c.id,
        kind: "review",
        key: `task:${c.id}:part:${c.part.id}:review:${sub ? `${sub.tree.row.id}:` : ""}${head}:${attempt}`,
        profile: c.profile,
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
        ],
        attachments: task.attachments,
        started: (d, run) => {
          step = runningStep(d, { task: c.id, part: c.part.id, kind: "review", run, item: "review", attempt }, waiting, now());
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
          const cur = taskRow(d, c.id);
          // An instruct step or an update restores its own reason (spec.md section 6.18).
          if (!ok && cur && c.mode === "build") stopForRun(d, { task: c.id, version: cur.version }, step, e, now());
          ended = { step, run: run.id, ok, text: e.text ?? null };
          return undefined;
        },
      };
      // headOf() awaited: a Stop can come before the run starts.
      guard(c);
      const s = review.taskRun(c.db, start);
      if (s.status === 409) {
        waiting = await waitSlot(c, { kind: "review", item: "review", attempt }, s.conflict.running, waiting);
        continue;
      }
      changed(c.id);
      await s.done;
      changed(c.id);
      const r = ended as { step: number; run: number; ok: boolean; text: string | null } | null;
      if (r && !r.ok && c.mode !== "build") throw new StepFailed(r.text ?? "The review failed.");
      if (!r?.ok) throw new Halt();
      const points = (c.db.query(Q.points).all({ run: r.run }) as { id: number; payload_json: string }[]).map((x) => ({
        id: x.id,
        payload: JSON.parse(x.payload_json) as FindingPayload,
      }));
      return { step: r.step, points };
    }
  }

  // spec.md section 6.7, own review: confirmed blocker and major points start a fix step, the checks, and a new review, at most
  // REVIEW_FIX_TRIES times (AC-B12). The other points stay listed in the review run.
  async function ownReview(c: Ctx) {
    const allow = c.plan.parts.flatMap((x) => x.tasks.flatMap((t) => t.files));
    const step = (a: number) => partStepFile(c.plan, c.plan.parts, "review", a);
    for (let tries = 0; ; tries++) {
      const rv = await reviewRun(c);
      const must = mustFix(rv.points);
      // spec.md section 6.16.5: the own review runs once per changed repository. A submodule point names its path from the main root.
      for (const s of await changedSubs(c)) {
        const sr = await reviewRun(c, s);
        for (const x of mustFix(sr.points)) must.push({ ...x, payload: { ...x.payload, path: `${s.tree.full}/${x.payload.path}` } });
      }
      if (!must.length) return;
      if (tries >= REVIEW_FIX_TRIES) {
        const n = must.length;
        block(c, {
          kind: "blocker",
          step: rv.step,
          text: `Needs you: Claude's review of part ${c.part.ord} still finds ${n} ${n === 1 ? "point" : "points"} to fix after ${REVIEW_FIX_TRIES} fixes.`,
        });
      }
      await claude(c, "fix", "review", { allow, step, failure: reviewFailure(must) });
      await greenOrFix(c, "review", allow, step);
      await commit(c, "review", `${c.label}: Fix the review points of part ${c.part.ord}`, allow);
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
    const pick = scheduleOf(db, t, all)?.start;
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
      if (cur?.state !== "implementing" || cur.blocked_json !== null || building(db, id)) return false;
      const at = now();
      const row = { id: part.id, branch: b.branch, base: baseBranch, commit: b.base, pushed: b.lease, now: at };
      if (db.query(Q.partStart).run(row).changes !== 1) return false;
      saveSubLeases(db, part.id, b);
      const r = advancePart(db, { task: id, version: cur.version, part: part.id }, { type: "START" }, {}, at);
      if (r.status !== 200) throw new Error(r.error);
      return true;
    })();
    changed(id);
    return started ? (building(db, id) ?? null) : null;
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
    };
  }

  async function runPart(db: Database, t: TaskRow, part: PartRow) {
    const repo = repoSettings(db, t.project, t.repo);
    if (!repo.commands.some((x) => x.kind === "test")) {
      reason(db, t.id, { kind: "error", step: null, text: NO_TEST });
      throw new Halt();
    }
    const c = await context(db, t, part);
    guard(c);
    // spec.md section 6.4: the plan files go into the part branch first.
    const missing = docNames(c.size).filter((n) => !existsSync(onDisk(c.wt, specPath(c.specDir, n))) && c.docs[n] !== undefined);
    for (const n of missing) {
      const p = onDisk(c.wt, specPath(c.specDir, n));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c.docs[n] as string);
    }
    if (missing.length) await commit(c, "plan", `${c.label}: Add the plan`, []);
    // spec.md section 6.7: the setup commands once per worktree.
    if (!existsSync(setupMark(c.wt))) {
      if (repo.commands.some((x) => x.kind === "setup")) {
        const r = await checks(c, "setup", ["setup"]);
        if (!r.green) block(c, { kind: "red", step: r.step, text: `Needs you: the setup commands of part ${part.ord} failed. See why.` });
      }
      writeFileSync(setupMark(c.wt), "");
    }
    await sizeCheck(c);
    refreshPlan(c);
    for (const pp of c.plan.parts) {
      const open = pp.tasks.filter((x) => !x.ticked);
      if (!open.length) continue;
      const done = open.length < pp.tasks.length || c.db.query(Q.committed).get({ part: part.id, item: `P${pp.n}` }) !== null;
      if (!done) await testsStep(c, pp);
      for (const task of open) await taskStep(c, pp, task);
    }
    // All approved checks once before the own review: the scoped checks of the tasks did not run build, lint, or the other tests.
    const allow = c.plan.parts.flatMap((x) => x.tasks.flatMap((t) => t.files));
    await greenOrFix(c, "checks", allow, (a) => partStepFile(c.plan, c.plan.parts, "checks", a));
    await commit(c, "checks", `${c.label}: Fix the checks of part ${part.ord}`, allow);
    await ownReview(c);
    db.transaction(() => {
      const cur = taskRow(db, t.id);
      if (cur?.state !== "implementing" || cur.blocked_json !== null) return;
      const p = advancePart(db, { task: t.id, version: cur.version, part: part.id }, { type: "REVIEWED" }, {}, now());
      if (p.status === 200) advance(db, { task: t.id, version: p.version }, { type: "PART_READY" }, {}, now());
    })();
    changed(t.id);
  }

  // The parts that wait for their build, one after another. A task with sub-tasks asks the scheduler for the next part after each part
  // (spec.md section 6.20.6) and stops when no part can start.
  async function buildParts(db: Database, id: number) {
    for (;;) {
      const t = taskRow(db, id);
      if (closing || !t || t.state !== "implementing" || t.blocked_json !== null) return;
      const part = building(db, id) ?? (t.subtasks === 1 ? await startPart(db, id) : null);
      if (!part) return;
      await runPart(db, taskRow(db, id) as TaskRow, part);
    }
  }

  async function drive(db: Database, id: number, reset: boolean) {
    try {
      await recoverUpdates(db, id);
      if (reset) {
        const t = taskRow(db, id);
        const part = building(db, id);
        const base = t && part ? baseOf(t, part) : null;
        if (t && part && base) {
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
          const last = (db.query(Q.lastStep).get({ part: part.id }) as { id: number | null }).id ?? 0;
          await undo(await trees(db, t, part, wt), db, id, last);
        }
      }
      // spec.md section 6.16.7: the pre-flight passes before any Claude step of the build. A part of a task with sub-tasks runs it at its
      // start (startPart).
      const t0 = taskRow(db, id);
      if (t0?.state === "implementing" && t0.blocked_json === null && (t0.subtasks !== 1 || building(db, id))) {
        const b = await preflight(db, preflightDeps, t0, plannedBranch(db, t0), null);
        if (b) {
          reason(db, id, b);
          return;
        }
      }
      await ensureParts(db, id);
      await buildParts(db, id);
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

  // spec.md section 6.7, own review: "Fix these too" starts one fix step with the listed points of a part that waits for its PR, then
  // the checks with their fixes and one commit. The part keeps its state. Changes that an earlier stop left go to a patch first.
  async function drivePoints(db: Database, id: number, partId: number) {
    try {
      const t = taskRow(db, id);
      const part = parts(db, id).find((p) => p.id === partId);
      if (!t || part?.state !== "self_reviewed") return;
      const c = await context(db, t, part);
      guard(c);
      await undo(c.trees, db, id, (db.query(Q.lastStep).get({ part: part.id }) as { id: number | null }).id ?? 0);
      refreshPlan(c);
      const points = openPoints(db, id);
      if (!points.length) return;
      const allow = c.plan.parts.flatMap((x) => x.tasks.flatMap((k) => k.files));
      const step = (a: number) => partStepFile(c.plan, c.plan.parts, "review", a);
      await claude(c, "fix", "points", { allow, step, failure: reviewFailure(points) });
      await greenOrFix(c, "points", allow, step);
      await commit(c, "points", `${c.label}: Fix the small review points of part ${part.ord}`, allow);
    } catch (e) {
      failed(db, id, e);
    }
  }

  // One driver per task. mode: an instruct step or an update, whose Stop keeps the task state. spec.md section 6.18.5: a driver ends at a
  // waiting state, so the base check runs before the driver leaves. The change notice comes after it, so a page reads working false.
  function start(db: Database, id: number, f: () => Promise<void>, mode?: Exclude<DriverMode, "build">) {
    if (drivers.has(id) || closing) return false;
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

  // points: the part whose listed points the driver fixes. Absent: the build of the next part.
  function kick(db: Database, id: number, reset = false, points?: number) {
    start(db, id, () => (points === undefined ? drive(db, id, reset) : drivePoints(db, id, points)));
  }

  // ---------- Tell Claude and Update from the base branch (spec.md section 6.18) ----------

  const itemOf = (db: Database, row: number) =>
    (db.query("SELECT item FROM task_step WHERE id = $id").get({ id: row }) as { item: string }).item;
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

  // spec.md sections 6.18.1 and 6.18.2: one Tell Claude send. row: its instruct step, which the route wrote. The step gets the path
  // check, the checks with their fixes, one commit, the size check, and the own review, as any implement step. The app never reads the
  // text: it goes to Claude as "Your instructions" only.
  async function driveInstruct(db: Database, id: number, row: number) {
    const info = stepDetailOf(db, row).instruct as InstructDetail;
    let c: Ctx | null = null;
    try {
      await recoverUpdates(db, id);
      const t = taskRow(db, id) as TaskRow;
      const part = parts(db, id).find((p) => p.id === info.part) as PartRow;
      c = await context(db, t, part, "instruct");
      const ctx = c;
      // Changes that an earlier stop or the red checks of the build left go to a patch first.
      await undo(c.trees, db, id, lastBefore(db, part.id, row));
      refreshPlan(c);
      const item = itemOf(db, row);
      const allow = c.plan.parts.flatMap((x) => x.tasks.flatMap((k) => k.files));
      const step = (a: number) => partStepFile(ctx.plan, ctx.plan.parts, "instruct", a);
      const r = await claude(c, "instruct", item, { allow, step, row, instructions: info.text });
      if (!r.changed.length) {
        // Step 2: Claude changed no file. No check, commit, or review runs, and the task waits as before the send.
        patchStep(db, row, { instruct: { ...info, result: "no_change" } });
        reason(db, id, info.blockedBefore);
        return;
      }
      await greenOrFix(c, item, allow, step);
      await commit(c, item, `${c.label}: ${firstLine(info.text)}`, allow);
      if (part.state === "implementing") {
        // The part of a build that waited: the build goes on from the new commit and ends with the checks and the own review.
        patchStep(db, row, { instruct: { ...info, result: "done", committed: true } });
        await buildParts(db, id);
        return;
      }
      await ownReview(c);
      patchStep(db, row, { instruct: { ...info, result: "done", committed: true } });
      changed(id);
    } catch (e) {
      await endInstruct(db, id, row, info, c, e);
    }
  }

  // The end of a send that did not finish. A Stop or a failed run (spec.md sections 6.18.1 and 6.18.7) resets every repository to its
  // last commit with the patch saved, and restores the reason that the task had before the send. A new reason of the step (a question,
  // red checks, a plan change, the line limit, a review blocker, a denied path) stays.
  async function endInstruct(db: Database, id: number, row: number, info: InstructDetail, c: Ctx | null, e: unknown) {
    const stopped = stopping.has(id);
    if (!stopped && !(e instanceof StepFailed)) {
      if (isOpen(db, row)) endStep(db, row, "cancelled", { notes: ["The step did not start."] }, now());
      failed(db, id, e);
      changed(id);
      return;
    }
    try {
      if (c) await undo(c.trees, db, id, row);
    } catch (err) {
      failed(db, id, err);
      return;
    }
    const committed = db.query(Q.committed).get({ part: info.part, item: itemOf(db, row) }) !== null;
    const text = stopped
      ? committed
        ? "Stopped after the commit. The own review did not run."
        : "Stopped. Your instructions changed nothing. The text is back in the box."
      : `Failed: ${(e as StepFailed).text}`;
    db.transaction(() => {
      if (isOpen(db, row)) endStep(db, row, "cancelled", {}, now());
      const d = stepDetailOf(db, row);
      patchStep(db, row, { instruct: { ...info, result: stopped ? "stopped" : "failed", committed }, notes: [...d.notes, text] });
      setReason(db, id, info.blockedBefore);
    })();
    changed(id);
  }

  // spec.md sections 6.18.3 and 6.18.4: one update of a built part. row: its update step, which the route wrote. Each repository takes
  // its own picked base, deepest first: a rebase before the first push, else a merge. A conflict goes to a resolve step. Any failure
  // before the checks aborts the update in every repository.
  async function driveUpdate(db: Database, id: number, partId: number, row: number) {
    let c: Ctx | null = null;
    let pre: UpdateDetail["preHeads"] | null = null;
    let phase: "git" | "checks" | "review" = "git";
    let label = taskRow(db, id)?.target_branch ?? "";
    try {
      await recoverUpdates(db, id);
      const t = taskRow(db, id) as TaskRow;
      let part = parts(db, id).find((p) => p.id === partId) as PartRow;
      c = await context(db, t, part, "update");
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
                await resolveConflicts(ctx, tree, r, at, stop.files, row);
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
      })();
      phase = "checks";
      part = parts(db, id).find((x) => x.id === partId) as PartRow;
      c = await context(db, taskRow(db, id) as TaskRow, part, "update");
      await countLines(c);
      // spec.md section 6.18.3, Checks (Q56): red keeps the update and waits for the user. No fix step runs.
      const k = await checks(c, itemOf(db, row));
      db.transaction(() => {
        endStep(db, row, "ok", { notes: stepDetailOf(db, row).notes }, now());
        patchStep(db, row, { update: { ...(stepDetailOf(db, row).update as UpdateDetail), result: k.green ? "green" : "red" } });
        if (!k.green) setReason(db, id, { kind: "red", step: k.step, text: `Needs you: the tests fail after the update from ${label}.` });
      })();
      changed(id);
      // Q57: Claude wrote code in a resolve step, so the own review runs.
      phase = "review";
      if (k.green && resolved) await ownReview(c);
    } catch (e) {
      await endUpdate(db, id, row, c, pre, label, phase, e);
    }
  }

  // One resolve step (spec.md section 6.18.4): context/conflicts.md, the path check against the unmerged paths of this stop, and the
  // marker check. Its changes go to patches/<step>.patch. A question, a changed path without a conflict, a remaining marker, or a failed
  // run aborts the update.
  async function resolveConflicts(
    c: Ctx,
    tree: RepoTree,
    r: UpdateRepo,
    p: { newBaseHead: string; mode: "rebase" | "merge" },
    paths: string[],
    row: number,
  ) {
    const wt = tree.wt as Worktree;
    const item = itemOf(c.db, row);
    const at = (x: string) => (tree.full ? `${tree.full}/${x}` : x);
    const rrow = insertStep(
      c.db,
      { task: c.id, part: c.part.id, kind: "resolve", item, attempt: nextAttempt(c, "resolve", item), state: "waiting" },
      now(),
    );
    patchStep(c.db, rrow, { resolve: { taskRepo: tree.row.id, paths } });
    const file = conflictsFile({ name: repoName(r), full: tree.full, base: r.base, newBaseHead: p.newBaseHead, mode: p.mode, paths });
    const before = await resolveSnapshot(c.trees, tree);
    const { r: out } = await runStep(c, "resolve", item, {
      allow: [],
      step: (a) => partStepFile(c.plan, c.plan.parts, "resolve", a),
      failure: file,
      row: rrow,
      resolveCheck: (context, ignored) => resolveProblems(c.trees, tree, paths, before, context, ignored),
    });
    if (out) {
      const saved = await savePatch(wt, patchFile(dataDir, c.db, c.id, rrow), paths, true).catch(() => null);
      if (saved) patchStep(c.db, rrow, { patch: basename(saved) });
    }
    if (!out) throw new Halt();
    if (!out.result) {
      const bad = out.problems[0];
      if (bad) throw new UpdateAbort(`Claude changed ${bad.path}, which has no conflict`);
      throw new StepFailed(out.text ?? "The resolve step failed.");
    }
    const q = out.result.question;
    if (q) throw new UpdateAbort(`Claude could not resolve ${at(paths[0] as string)}: ${oneLine(q.text).replace(/\.$/, "")}`);
    const left = await markerLeft(wt, paths);
    if (left) throw new UpdateAbort(`conflict markers remain in ${at(left)}`);
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
  // step stays.
  async function endUpdate(
    db: Database,
    id: number,
    row: number,
    c: Ctx | null,
    pre: UpdateDetail["preHeads"] | null,
    label: string,
    phase: "git" | "checks" | "review",
    e: unknown,
  ) {
    const stopped = stopping.has(id);
    if (phase === "review") {
      if (!(e instanceof Halt) || (!stopped && !(e instanceof StepFailed))) failed(db, id, e);
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

  // The checks of a mutation: the task and its version.
  function load(db: Database, id: number, version: number): TaskRow | TaskResult {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== version) return { status: 409, error: TASK_CHANGED, task: taskDto(db, t) };
    return t;
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
      kick(db, id);
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
      if (s?.start?.id !== partId) return conflict(db, id, s?.waits.get(partId) ?? "This part cannot start.");
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
      const names = partNames(t.key, all);
      const name = (p: PartRow) => names.get(p.id)?.text ?? t.key;
      const upper = all.find(
        (p) => p.after_part === partId && p.base_commit !== null && p.base_branch === part.branch && STARTED.has(p.state),
      );
      if (upper) return conflict(db, id, `${name(upper)} builds on ${name(part)}. Move or drop ${name(upper)} first.`);
      const error = db.transaction((): string | null => {
        const r = advancePart(db, { task: id, version: t.version, part: partId }, { type: "ABANDON" }, {}, now());
        if (r.status !== 200) return r.error;
        let version = r.version;
        const rest = parts(db, id);
        if (t.state === "implementing" && !rest.some((p) => WAITS_PR.has(p.state))) {
          const a = advance(db, { task: id, version }, { type: "LAST_PR_OPEN" }, {}, now());
          if (a.status === 200) version = a.version;
        }
        if (rest.every((p) => p.state === "merged" || p.state === "abandoned"))
          advance(db, { task: id, version }, { type: "ALL_MERGED" }, {}, now());
        return null;
      })();
      if (error) return conflict(db, id, error);
      kick(db, id);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/pause: the next Claude step of the build waits until Resume (AC-B18).
    pause(db: Database, id: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" || !drivers.has(id)) return conflict(db, id, "The build does not run now.");
      pauseAsked.add(id);
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
        aborts.get(id)?.abort();
        gates.get(id)?.();
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
      pauseAsked.delete(id);
      review.cancelTask(db, id);
      aborts.get(id)?.abort();
      gates.get(id)?.();
      slotWaits.get(id)?.();
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/resume of a build: a paused build goes on with its changes. Else the worktree returns to the last commit, the
    // discarded changes go to patches/<step>.patch, and the stopped step starts again (spec.md section 6.7, Resume).
    resume(db: Database, id: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state === "implementing" && blockedOf(t)?.kind === "slot")
        return conflict(db, id, "The build waits for the run slot. It goes on by itself.");
      if (drivers.has(id) && !gates.has(id)) return conflict(db, id, BUSY);
      if (t.state === "stopped") {
        if (t.stopped_from !== "implementing") return conflict(db, id, TASK_STATE_TEXT.stopped);
        const error = db.transaction((): string | null => {
          const r = advance(db, { task: id, version: t.version }, { type: "RESUME" }, {}, now());
          if (r.status !== 200) return r.error;
          setBlocked(db, { task: id, version: r.version }, null, now());
          return null;
        })();
        if (error) return conflict(db, id, error);
        kick(db, id, true);
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      if (t.state !== "implementing") return conflict(db, id, TASK_STATE_TEXT[t.state]);
      const b = blockedOf(t);
      const g = gates.get(id);
      if (b?.kind === "question" && b.step === null && g) {
        setBlocked(db, { task: id, version: t.version }, null, now());
        g();
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      if (b?.kind === "spec_change") return conflict(db, id, "Accept or reject the change to the spec first.");
      if (b?.kind === "question" && (db.query(Q.openLoop).all({ task: id }) as unknown[]).length)
        return conflict(db, id, "Answer the question first.");
      const part = building(db, id);
      if (!b && (drivers.has(id) || !part)) return conflict(db, id, TASK_STATE_TEXT.implementing);
      // A used-up time budget gets 60 more minutes. A cost limit stays: the user changes it in the settings.
      const used = b?.kind === "budget" && part ? partBudget(db, id, part, now()) : null;
      if (used && used.usedMs >= used.limitMs) moreTime(db, { task: id, version: t.version }, now());
      else if (b) setBlocked(db, { task: id, version: t.version }, null, now());
      kick(db, id, true);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/answers while the build waits for a question of Claude. The step starts again from the last commit with the
    // answer in context/answers.md.
    answer(db: Database, id: number, input: TaskAnswersInput): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (blockedOf(t)?.kind !== "question") return conflict(db, id, "No question waits for an answer.");
      const open = db.query(Q.openLoop).all({ task: id }) as (QuestionRow & { step: number | null })[];
      if (!open.length) return conflict(db, id, "No question waits for an answer.");
      const given = new Map(input.answers.map((a) => [a.question, a]));
      if (given.size !== input.answers.length) return { status: 400, error: "Each question takes one answer." };
      for (const q of given.keys())
        if (!open.some((x) => x.id === q)) return { status: 400, error: `Question ${q} does not wait for an answer.` };
      for (const q of open) {
        const a = given.get(q.id);
        if (!a && !input.recommended) return { status: 400, error: "Answer each question, or use the recommended answers." };
        const problem = a && answerProblem(q, a);
        if (problem) return { status: 400, error: problem };
      }
      if (drivers.has(id)) return conflict(db, id, BUSY);
      // The question of an instruct step: the send runs again from the last commit with the answer in context/answers.md (spec.md
      // section 6.18.2).
      const asked = open[0]?.step
        ? (db.query(Q.step).get({ id: open[0].step, task: id }) as { kind: string; item: string | null } | null)
        : null;
      const again = db.transaction((): number | null => {
        const at = now();
        for (const q of open) {
          const a = given.get(q.id);
          const answer: Answer = a
            ? { choice: a.choice ?? null, text: a.text?.trim() ?? "" }
            : { choice: q.kind === "choice" ? q.recommended : null, text: "" };
          db.query(Q.answer).run({ id: q.id, answer: JSON.stringify(answer), now: at });
        }
        setBlocked(db, { task: id, version: t.version }, null, at);
        const info = asked?.kind === "instruct" && open[0]?.step ? stepDetailOf(db, open[0].step).instruct : null;
        if (!info || !asked?.item) return null;
        const attempt = (db.query(Q.attempt).get({ part: info.part, kind: "instruct", item: asked.item }) as { n: number }).n;
        const row = insertStep(db, { task: id, part: info.part, kind: "instruct", item: asked.item, attempt, state: "waiting" }, at);
        patchStep(db, row, { instruct: { ...info, result: null, committed: false } });
        return row;
      })();
      if (again === null) kick(db, id, true);
      else start(db, id, () => driveInstruct(db, id, again), "instruct");
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/limit (spec.md section 6.1): "Keep one PR" or "Change the limit" of a part over the line limit. The build goes
    // on from the last commit. A new limit under the changed lines stops it again.
    limit(db: Database, id: number, input: { version: number; keep?: true; lineBudget?: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" || blockedOf(t)?.kind !== "size") return conflict(db, id, "No part waits for the line limit.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      const s = taskSettingsOf(t);
      setSettings(
        db,
        { task: id, version: t.version },
        input.keep ? { ...s, keepOnePr: true } : { ...s, lineBudget: input.lineBudget },
        now(),
      );
      kick(db, id, true);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/fix: "Fix these too" for the listed points of a part that waits for its PR.
    fixPoints(db: Database, id: number, partId: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" || t.blocked_json !== null) return conflict(db, id, TASK_STATE_TEXT[t.state]);
      if (drivers.has(id)) return conflict(db, id, BUSY);
      if (parts(db, id).find((p) => p.id === partId)?.state !== "self_reviewed")
        return conflict(db, id, "This part does not wait for its PR.");
      if (!openPoints(db, id).length) return conflict(db, id, "No point waits for a fix.");
      kick(db, id, false, partId);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/spec-change/:step (AC-B20): accept commits the changed plan files, and the step starts again under the new
    // plan. Reject resets the step. Both save the other changes of the step as its patch.
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
      const note = (s: string) => ({ specChange: detail.specChange ?? null, notes: [...(detail.notes ?? []), s] });
      if (!input.accept) {
        // The build resets a part that it builds. A built part goes back to its last commit here.
        if (part.state !== "implementing")
          try {
            const c = await context(db, t, part, "instruct");
            await undo(c.trees, db, id, stepId);
          } catch (e) {
            return conflict(db, id, `The app could not reset the step: ${noUrl((e as Error).message)}`);
          }
        db.transaction(() => {
          endStep(db, stepId, "cancelled", note("The user rejected the change."), now());
          setBlocked(db, { task: id, version: t.version }, null, now());
        })();
        kick(db, id, true);
        changed(id);
        return { status: 200, task: dto(db, id) };
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
        const message = row.item ? `${c.label} ${row.item}: Change the plan` : `${c.label}: Change the plan`;
        const r = await commitTask({
          db,
          task: id,
          part: part.id,
          wt: c.wt,
          item: "spec",
          message,
          who: c.who,
          allow: [],
          trees: c.trees,
          now,
        });
        if (r.status === "refused") return conflict(db, id, deniedText(r.problems));
      } catch (e) {
        return conflict(db, id, `The app could not commit the change: ${noUrl((e as Error).message)}`);
      }
      db.transaction(() => {
        endStep(db, stepId, "ok", note("The user accepted the change."), now());
        const cur = taskRow(db, id) as TaskRow;
        setBlocked(db, { task: id, version: cur.version }, null, now());
      })();
      kick(db, id);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/instructions (spec.md section 6.18.2): one send starts exactly one instruct step. The text goes to Claude only.
    instruct(db: Database, id: number, input: { version: number; part?: number; text: string }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (drivers.has(id)) return conflict(db, id, WORKING);
      const target = instructTarget(db, t, input.part);
      if ("error" in target) return conflict(db, id, target.error);
      const part = target.part;
      const row = db.transaction(() => {
        const n = (db.query(Q.sends).get({ task: id, kind: "instruct" }) as { n: number }).n + 1;
        const r = insertStep(db, { task: id, part: part.id, kind: "instruct", item: `I${n}`, state: "waiting" }, now());
        patchStep(db, r, { instruct: { text: input.text, part: part.id, blockedBefore: blockedOf(t), result: null, committed: false } });
        // The version moves, so a second tab gets 409 with the current task (spec.md section 6.18.7).
        setBlocked(db, { task: id, version: t.version }, null, now());
        return r;
      })();
      start(db, id, () => driveInstruct(db, id, row), "instruct");
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
      kick(db, id, true);
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
      const row = db.transaction(() => {
        const n = (db.query(Q.sends).get({ task: id, kind: "update" }) as { n: number }).n + 1;
        const r = insertStep(db, { task: id, part: partId, kind: "update", item: `U${n}`, state: "running" }, now());
        setBlocked(db, { task: id, version: again.version }, null, now());
        return r;
      })();
      start(db, id, () => driveUpdate(db, id, partId, row), "update");
      changed(id);
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

    // The first open of the database: the updates that a restart stopped (spec.md section 6.18.4, Restart).
    recover(db: Database) {
      for (const { task } of db.query(Q.restartTasks).all() as { task: number }[])
        start(db, task, async () => {
          try {
            await recoverUpdates(db, task);
          } catch (e) {
            log(`Task ${task}: could not reset the update that a restart stopped: ${noUrl((e as Error).message)}`);
          }
        });
    },

    // Resolves when the build of the task waits or ends.
    idle(id: number): Promise<void> {
      return drivers.get(id) ?? Promise.resolve();
    },
    // true while a driver works on the task.
    running: (id: number) => drivers.has(id),
    // The user action routes call it first. The waiting state shows before the driver ends its base check, so the route waits for that
    // check. A driver that still runs a step is not awaited, and the route refuses as before.
    async settle(id: number) {
      if (ending.has(id)) await drivers.get(id);
    },

    // At app stop (review.stop()): no new step, the checks are killed, and the drivers end.
    async shutdown() {
      closing = true;
      for (const a of aborts.values()) a.abort();
      for (const g of gates.values()) g();
      for (const w of slotWaits.values()) w();
      await Promise.all([...drivers.values(), ...checking.values()]);
    },
  };
}

export type TaskLoop = ReturnType<typeof createLoop>;
