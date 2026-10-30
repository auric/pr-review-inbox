// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The state writes of a task (docs/plans/review-v2/spec.md section 6.2). No other code writes task.state or task_part.state.
// Each write runs in a transaction, and a caller transaction makes it a savepoint: the caller writes its step row in the same commit.
// The caller runs every effect (a run start, a push, a notification) after the commit, from the new state.
import type { Database } from "bun:sqlite";
import { initialTransition, transition } from "xstate";
import type { z } from "zod";
import { oneLine } from "../../shared/consult";
import {
  type AttachmentMeta,
  type BranchCheckDto,
  fileOnly,
  type IssueContext,
  type IssueSubtask,
  listedOnly,
  type RepoTaskSettingsDto,
  type RepoTaskSettingsInput,
  type RunConflict,
  type RunUsage,
  type TaskAnswersInput,
  type TaskCreateInput,
  type TaskDto,
  type TaskInterviewDto,
  type TaskIssueDto,
  type TaskPartDto,
  type TaskPlanAgainInput,
  type TaskPlanDto,
  type TaskPlanInput,
  type TaskPointDto,
  type TaskQuestionDto,
  type TaskRowDto,
  type TaskStepDto,
  type taskDocInput,
  type taskSizeInput,
} from "../../shared/dto";
import type { FindingPayload } from "../../shared/review";
import {
  branchName,
  INTERVIEW_QUESTIONS,
  INTERVIEW_TURNS,
  type InterviewResult,
  interviewJsonSchema,
  interviewResult,
  JIRA_STATUS_AGE_MS,
  JIRA_VIEW_AGE_MS,
  MAX_OPEN_CAP,
  MAX_OPEN_DEFAULT,
  MERGE_CONFLICTED,
  MORE_TIME_MIN,
  PART_STATE_TEXT,
  PART_TIME_MIN,
  type PartState,
  type SizeSource,
  SPEC_TURNS,
  type SpecResult,
  type StartMode,
  type StepDetail,
  SUBTASKS_READ,
  specJsonSchema,
  specResult,
  stepDetail,
  stepStrip,
  subtasksFirst,
  TASK_DEFAULTS,
  TASK_DOCS,
  TASK_STATE_TEXT,
  type TaskBlocked,
  type TaskCommand,
  type TaskSettings,
  type TaskSize,
  type TaskState,
  taskBlocked,
  taskProfileId,
  taskSettings,
} from "../../shared/task";
import { NoCloneLink } from "../bitbucket/errors";
import type { ForgeProvider } from "../bitbucket/provider";
import { JiraRefusedError } from "../context/jira";
import { FAILED as JIRA_FAILED } from "../context/routes";
import { ContextError, type ContextSource, type JiraTransition } from "../context/source";
import { type TaskFileOptions, taskFileContext, taskIssue } from "../context/task-file";
import { buildOf } from "../inbox/builds";
import { followKey } from "../inbox/queries";
import type { Live } from "../live";
import { log } from "../log";
import { interviewAgent, type Profile, profileOf, specAgent } from "../review/catalog";
import { gitEnv } from "../review/git";
import type { ReviewJobs, TaskRunStart } from "../review/jobs";
import { type Ending, judgeTask } from "../review/judge";
import { buildInterviewPrompt, buildSpecPrompt } from "../review/prompt";
import { repoPath } from "../review/validate";
import { type ContextFile, noUrl, remoteHead, type SnapshotRepo } from "../review/workspace";
import { branchPrefixesOf, type Settings } from "../settings";
import {
  dropFetched,
  type Fetched,
  fetchFiles,
  pickProblem,
  saveFetched,
  setInclude,
  TaskFileError,
  taskFileDto,
  taskFileDtos,
  usedBytes,
} from "./files";
import { approvalsOf, partGate } from "./gates";
import {
  type Answer,
  afterAnswers,
  afterInterview,
  answerProblem,
  answersFile,
  checkQuestions,
  type QuestionRow,
  recommendedAnswer,
} from "./interview";
import { type PartEvent, partMachine, type TaskEvent, taskMachine } from "./machine";
import {
  atLeast,
  checkMap,
  checkProposals,
  convertDocs,
  type Docs,
  docNames,
  type ListedRepo,
  largeRepoProblem,
  NEW_COMMAND,
  type Plan,
  parsePlan,
  parseTasks,
  renderDocs,
  repoListFile,
  sizeFloor,
  toPlan,
} from "./plan";
import { prRows, type RepoDeps, repoDtos, resolveTaskRepos, saveMainRepo, taskRepos, updateRepos } from "./repos";
import { nextPart, type Schedule } from "./schedule";
import {
  approveSubtasks,
  checkSubtaskPlan,
  findWork,
  type PlannedPart,
  prHistoryFile,
  type SubtaskPlan,
  saveSubtasks,
  subtaskDtos,
  subtaskRows,
} from "./subtasks";
import { firstFree, remoteBranches } from "./worktree";

type TaskSizeInput = z.infer<typeof taskSizeInput>;

export type Advanced<S> =
  | { status: 200; state: S; version: number }
  | { status: 404; error: string }
  | { status: 409; error: string; state: S; version: number };

// version: task.version as the caller saw it. A part change raises the version of its task too.
export type TaskRef = { task: number; version: number };
// gate: the PR of the event passed its review rules (spec.md section 6.10). The machine reads it only for the gate events.
export type Facts = { gate?: boolean };

export const TASK_CHANGED = "The task changed on another page. Check it again.";

const SQL = {
  task: "SELECT state, stopped_from, size, version FROM task WHERE id = $id",
  part: "SELECT p.state, t.version FROM task_part p JOIN task t ON t.id = p.task WHERE p.id = $part AND p.task = $task",
  setTask: `UPDATE task SET state = $state, stopped_from = $stopped, version = version + 1, updated_at = $now
    WHERE id = $id AND version = $version`,
  setPart: "UPDATE task_part SET state = $state, updated_at = $now WHERE id = $id",
  bump: "UPDATE task SET version = version + 1, updated_at = $now WHERE id = $id AND version = $version",
  // The tasks that worked at the last stop: a running Claude step, a step that ran or waited for the run slot (checks and commits have
  // no run), or a part that the loop built while no reason blocked it.
  running: `SELECT t.id, t.version FROM task t WHERE EXISTS (SELECT 1 FROM review_run r WHERE r.task = t.id AND r.status = 'running')
      OR EXISTS (SELECT 1 FROM task_step s WHERE s.task = t.id AND s.state IN ('waiting', 'running'))
      OR (t.state = 'implementing' AND t.blocked_json IS NULL AND EXISTS (SELECT 1 FROM task_part p WHERE p.task = t.id AND p.state = 'implementing'))
    ORDER BY t.id`,
  failSteps: "UPDATE task_step SET state = 'failed', ended_at = $now WHERE state IN ('waiting', 'running')",
  // spec.md section 6.18.4, Restart: an update that ran at the last stop. The loop aborts its rebase or merge and resets every repository
  // to the heads before it (loop.ts recoverUpdates).
  restartUpdates: `UPDATE task_step SET detail_json = json_insert(json_set(detail_json, '$.update.result', 'restart'), '$.notes[#]',
      'The app stopped during the update.')
    WHERE kind = 'update' AND state IN ('waiting', 'running') AND json_type(detail_json, '$.update') = 'object'`,
};

type StateRow = { state: TaskState; stopped_from: TaskState | null; size: TaskSize | null; version: number };

function write(db: Database, sql: string, params: Record<string, string | number | null>) {
  // The version check of the same statement. The read in the same transaction already saw this version.
  if (db.query(sql).run(params).changes !== 1) throw new Error(TASK_CHANGED);
}

export function advance(db: Database, ref: TaskRef, event: TaskEvent, facts: Facts = {}, now = Date.now()): Advanced<TaskState> {
  return db.transaction((): Advanced<TaskState> => {
    const row = db.query(SQL.task).get({ id: ref.task }) as StateRow | null;
    if (!row) return { status: 404, error: "Task not found." };
    if (row.version !== ref.version) return { status: 409, error: TASK_CHANGED, state: row.state, version: row.version };
    const snapshot = taskMachine.resolveState({
      value: row.state,
      context: { size: row.size, gate: facts.gate === true, stoppedFrom: row.stopped_from },
    });
    if (!snapshot.can(event)) return { status: 409, error: TASK_STATE_TEXT[row.state], state: row.state, version: row.version };
    const [next] = transition(taskMachine, snapshot, event);
    const state = next.value as TaskState;
    write(db, SQL.setTask, { id: ref.task, version: ref.version, state, stopped: state === "stopped" ? row.state : null, now });
    return { status: 200, state, version: ref.version + 1 };
  })();
}

export function advancePart(
  db: Database,
  ref: TaskRef & { part: number },
  event: PartEvent,
  facts: Facts = {},
  now = Date.now(),
): Advanced<PartState> {
  return db.transaction((): Advanced<PartState> => {
    const row = db.query(SQL.part).get({ part: ref.part, task: ref.task }) as { state: PartState; version: number } | null;
    if (!row) return { status: 404, error: "Part not found." };
    if (row.version !== ref.version) return { status: 409, error: TASK_CHANGED, state: row.state, version: row.version };
    const snapshot = partMachine.resolveState({ value: row.state, context: { gate: facts.gate === true } });
    if (!snapshot.can(event))
      return { status: 409, error: `This part is ${PART_STATE_TEXT[row.state].toLowerCase()}.`, state: row.state, version: row.version };
    const [next] = transition(partMachine, snapshot, event);
    const state = next.value as PartState;
    write(db, SQL.bump, { id: ref.task, version: ref.version, now });
    db.query(SQL.setPart).run({ id: ref.part, state, now });
    return { status: 200, state, version: ref.version + 1 };
  })();
}

// spec.md section 6.14: a Claude step that ran at the last stop has no process now. Its step ends failed, and its task stops, so
// Resume continues. Call it before the run recovery (run-rows.ts SQL.recover), which ends the runs themselves with kind restart.
export function recoverTasks(db: Database, now = Date.now()) {
  db.transaction(() => {
    const tasks = db.query(SQL.running).all() as { id: number; version: number }[];
    db.query(SQL.restartUpdates).run();
    db.query(SQL.failSteps).run({ now });
    // A done or failed task refuses STOP and keeps its state.
    for (const t of tasks) advance(db, { task: t.id, version: t.version }, { type: "STOP" }, {}, now);
  })();
}

// ---------- The task service (spec.md sections 6.1 to 6.5 and 6.11) ----------

export type TaskRow = {
  id: number;
  project: string;
  repo: string;
  key: string;
  title: string;
  origin_pr: number | null;
  state: TaskState;
  stopped_from: TaskState | null;
  size: TaskSize | null;
  size_by: SizeSource | null;
  target_branch: string;
  base_commit: string | null;
  spec_dir: string;
  spec_branch: string | null;
  issue_json: string | null;
  docs_json: string | null;
  estimate_json: string | null;
  settings_json: string;
  blocked_json: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  profile: string | null;
  // spec.md section 6.20.8: 1 builds the Jira sub-tasks of key, one PR per part.
  subtasks: number;
};

const Q = {
  row: "SELECT * FROM task WHERE id = $id",
  open: "SELECT * FROM task WHERE project = $project AND repo = $repo AND key = $key AND state NOT IN ('done', 'failed')",
  list: "SELECT * FROM task WHERE $all OR state NOT IN ('done', 'failed') ORDER BY updated_at DESC, id DESC LIMIT 200",
  insert: `INSERT INTO task (project, repo, key, title, origin_pr, state, target_branch, spec_dir, issue_json, profile, subtasks, created_at,
      updated_at)
    VALUES ($project, $repo, $key, $title, $origin, $state, $target, $spec_dir, $issue, $profile, $subtasks, $now, $now) RETURNING id`,
  // spec.md section 6.20.5: the part rows of an approved sub-task plan. ord: the plan part number; a tracked PR comes after the parts.
  insertPart: `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, pr, remote_pr, state, keys_json, start_mode, spec_dir, adopted,
      created_at, updated_at)
    VALUES ($task, $ord, 'single', $title, $branch, $base, $pr, $remote, $state, $keys, $start, $spec_dir, $adopted, $now, $now) RETURNING id`,
  afterPart: "UPDATE task_part SET after_part = $after WHERE id = $id",
  addedSubtasks: "SELECT 1 FROM task_subtask WHERE task = $task AND added_at IS NOT NULL AND removed_at IS NULL",
  // spec.md section 6.20.11: the tasks that the status read of the sync covers.
  subtaskTasks: "SELECT id FROM task WHERE subtasks = 1 AND state NOT IN ('done', 'failed') ORDER BY id",
  subtaskStatus: "UPDATE task_subtask SET status = $status, category = $category, status_at = $at WHERE task = $task AND key = $key",
  // "Read Jira again" (spec.md section 6.20.12). A done sub-task keeps its last text and links.
  subtaskRead: `UPDATE task_subtask SET summary = $summary, status = $status, category = $category, issue_json = COALESCE($issue, issue_json),
      links_json = COALESCE($links, links_json), read_at = $at, status_at = $at
    WHERE task = $task AND key = $key`,
  setIssue: "UPDATE task SET issue_json = $issue WHERE id = $id",
  // "Ask Claude again" (spec.md section 6.20.4): the text of the user as an answered question of its own round.
  lastRound: "SELECT COALESCE(MAX(round), 0) AS round FROM task_question WHERE task = $task",
  againQuestion: `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, recommended, answer_json, step, asked_at,
      answered_at)
    VALUES ($task, 'interview', $round, 0, 'What should the new plan change?', 'You asked Claude to write the plan again.', 'text', '[]',
      NULL, $answer, NULL, $now, $now)`,
  lastProfile: "SELECT profile FROM task WHERE project = $project AND repo = $repo AND profile IS NOT NULL ORDER BY id DESC LIMIT 1",
  pr: "SELECT id, project, repo, target_branch FROM pull_request WHERE id = $id",
  prTask: "SELECT 1 FROM pr_task WHERE pr = $pr AND key = $key",
  context: "SELECT json FROM task_context WHERE pr = $pr AND key = $key",
  storeContext: `INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', $json, $at)
    ON CONFLICT (pr, key) DO UPDATE SET source = excluded.source, json = excluded.json, fetched_at = excluded.fetched_at`,
  parts: "SELECT * FROM task_part WHERE task = $id ORDER BY ord",
  partPr: "SELECT state, reviewers_json FROM pull_request WHERE id = $id",
  lowerPr: "SELECT state, source_head FROM pull_request WHERE id = $id",
  codeParts: `SELECT p.ord, p.state, pr.state AS pr_state FROM task_part p LEFT JOIN pull_request pr ON pr.id = p.pr
    WHERE p.task = $id AND p.kind <> 'spec' ORDER BY p.ord`,
  questions: "SELECT * FROM task_question WHERE task = $id ORDER BY round, ord, id",
  steps: "SELECT * FROM task_step WHERE task = $id ORDER BY id DESC LIMIT 50",
  busy: "SELECT 1 FROM task_step WHERE task = $id AND state IN ('waiting', 'running')",
  stepInsert: `INSERT INTO task_step (task, kind, run, state, ord, started_at)
    VALUES ($task, $kind, $run, 'running', (SELECT COALESCE(MAX(ord), 0) + 1 FROM task_step WHERE task = $task), $now) RETURNING id`,
  stepEnd: "UPDATE task_step SET state = $state, ended_at = $now WHERE run = $run AND state = 'running' RETURNING id",
  question: `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, recommended, step, asked_at)
    VALUES ($task, 'interview', $round, $ord, $text, $why, $kind, $options, $recommended, $step, $now)`,
  answer: "UPDATE task_question SET answer_json = $answer, answered_at = $now WHERE id = $id AND answer_json IS NULL",
  // The newest interview result: the answer column of its run (judgeTask).
  interview: `SELECT r.answer FROM task_step s JOIN review_run r ON r.id = s.run
    WHERE s.task = $id AND s.kind = 'interview' AND r.answer IS NOT NULL ORDER BY s.id DESC LIMIT 1`,
  settings: "SELECT * FROM repo_task_settings WHERE project = $project AND repo = $repo",
  // last_base: the base branch of the approved plan, the first pick of the next task (spec.md section 6.16.3).
  approve: `INSERT INTO repo_task_settings (project, repo, commands_json, warned_at, last_base, updated_at)
    VALUES ($project, $repo, $commands, $warned, $base, $now)
    ON CONFLICT (project, repo) DO UPDATE SET commands_json = excluded.commands_json,
      warned_at = COALESCE(repo_task_settings.warned_at, excluded.warned_at), last_base = excluded.last_base, updated_at = excluded.updated_at`,
  lastBase: "SELECT last_base FROM repo_task_settings WHERE project = $project AND repo = $repo",
  // spec.md section 6.16.5, Proposals: a proposed repository has access none until Add.
  dropProposals: "DELETE FROM task_repo WHERE task = $task AND role = 'added' AND proposal = 'proposed'",
  propose: `INSERT OR IGNORE INTO task_repo (task, role, project, repo, depth, access, proposal, proposal_reason, created_at)
    VALUES ($task, 'added', $project, $repo, 0, 'none', 'proposed', $reason, $now)`,
  proposal: "SELECT role, project, repo, proposal FROM task_repo WHERE id = $id AND task = $task",
  choose: "UPDATE task_repo SET proposal = $proposal, access = $access, base_branch = $base WHERE id = $id",
  // spec.md section 6.16.3: the base pick of a repository other than the main one, and its last pick at the plan approval.
  repoBase: "UPDATE task_repo SET base_branch = $base WHERE id = $id",
  lastBasePick: `INSERT INTO repo_task_settings (project, repo, last_base, updated_at) VALUES ($project, $repo, $base, $now)
    ON CONFLICT (project, repo) DO UPDATE SET last_base = excluded.last_base, updated_at = excluded.updated_at`,
  openPr: `SELECT id FROM pull_request WHERE project = $project AND repo = $repo AND source_branch = $branch AND target_branch = $base
    AND state = 'OPEN' ORDER BY id DESC LIMIT 1`,
  // branch_prefix stays in the table. No code reads or writes it (spec.md section 6.16.1).
  saveSettings: `INSERT INTO repo_task_settings (project, repo, spec_dir, line_budget, max_open, approvals, commands_json,
      test_globs_json, exclude_globs_json, isolate_home, updated_at)
    VALUES ($project, $repo, $spec_dir, $budget, $max_open, $approvals, $commands, $tests, $excludes, $isolate, $now)
    ON CONFLICT (project, repo) DO UPDATE SET spec_dir = excluded.spec_dir,
      line_budget = excluded.line_budget, max_open = excluded.max_open, approvals = excluded.approvals, commands_json = excluded.commands_json,
      test_globs_json = excluded.test_globs_json, exclude_globs_json = excluded.exclude_globs_json, isolate_home = excluded.isolate_home,
      updated_at = excluded.updated_at`,
};

type SettingsRow = {
  spec_dir: string;
  line_budget: number;
  max_open: number;
  approvals: number;
  commands_json: string;
  test_globs_json: string | null;
  exclude_globs_json: string | null;
  isolate_home: number;
  warned_at: number | null;
};

export const taskRow = (db: Database, id: number) => db.query(Q.row).get({ id }) as TaskRow | null;

// spec.md section 6.2: each step reads the profile of its task at the step start, as a review run reads its profile at its start.
export const taskProfile = (list: Profile[], t: Pick<TaskRow, "profile">): Profile => profileOf(list, taskProfileId(list, t.profile));

// The profile that the Build form preselects: the profile of the newest task of the repository, else the default profile.
export function preselectProfile(db: Database, list: Profile[], project: string, repo: string): string {
  const last = db.query(Q.lastProfile).get({ project, repo }) as { profile: string } | null;
  return taskProfileId(list, last?.profile ?? null);
}

// The settings of a repository, with the defaults of spec.md section 6.3 when no row exists (AC-UX4: no setup first).
export function repoSettings(db: Database, project: string, repo: string): RepoTaskSettingsDto {
  const r = db.query(Q.settings).get({ project, repo }) as SettingsRow | null;
  const json = <T>(s: string | null, fallback: T): T => (s === null ? fallback : (JSON.parse(s) as T));
  return {
    project,
    repo,
    specDir: r?.spec_dir ?? TASK_DEFAULTS.specDir,
    lineBudget: r?.line_budget ?? TASK_DEFAULTS.lineBudget,
    maxOpen: r?.max_open ?? TASK_DEFAULTS.maxOpen,
    approvals: r?.approvals ?? TASK_DEFAULTS.approvals,
    commands: json<TaskCommand[]>(r?.commands_json ?? null, []),
    testGlobs: json<string[] | null>(r?.test_globs_json ?? null, null),
    excludeGlobs: json<string[] | null>(r?.exclude_globs_json ?? null, null),
    isolateHome: (r?.isolate_home ?? 1) === 1,
    warnedAt: r?.warned_at ?? null,
  };
}

export function saveRepoSettings(db: Database, project: string, repo: string, s: RepoTaskSettingsInput, now = Date.now()) {
  db.query(Q.saveSettings).run({
    project,
    repo,
    spec_dir: s.specDir,
    budget: s.lineBudget,
    max_open: s.maxOpen,
    approvals: s.approvals,
    commands: JSON.stringify(s.commands),
    tests: s.testGlobs === null ? null : JSON.stringify(s.testGlobs),
    excludes: s.excludeGlobs === null ? null : JSON.stringify(s.excludeGlobs),
    isolate: s.isolateHome ? 1 : 0,
    now,
  });
}

const settingsOf = (t: TaskRow): TaskSettings => {
  const r = taskSettings.safeParse(JSON.parse(t.settings_json));
  return r.success ? r.data : {};
};
export const budgetOf = (db: Database, t: TaskRow) => settingsOf(t).lineBudget ?? repoSettings(db, t.project, t.repo).lineBudget;
export const docsOf = (t: TaskRow): Docs | null => (t.docs_json === null ? null : (JSON.parse(t.docs_json) as Docs));

type Patch = Partial<
  Record<
    "blocked_json" | "docs_json" | "estimate_json" | "size" | "size_by" | "base_commit" | "settings_json" | "target_branch",
    string | null
  >
>;

// A version-checked write of task fields that are no state. Returns the new version.
function patch(db: Database, id: number, version: number, p: Patch, now: number): number {
  const keys = Object.keys(p) as (keyof Patch)[];
  const set = keys.map((k) => `${k} = $${k}`).join(", ");
  write(db, `UPDATE task SET ${set}${set ? ", " : ""}version = version + 1, updated_at = $now WHERE id = $id AND version = $version`, {
    ...p,
    id,
    version,
    now,
  });
  return version + 1;
}

const blocked = (b: TaskBlocked | null) => (b === null ? null : JSON.stringify(b));

// Sets task.blocked_json (spec.md section 6.2) with the version check. Returns the new version.
export const setBlocked = (db: Database, ref: TaskRef, b: TaskBlocked | null, now = Date.now()) =>
  patch(db, ref.task, ref.version, { blocked_json: blocked(b) }, now);

// spec.md section 6.7, Budgets: "Continue with 60 more min?". Each part of the task gets 60 more minutes, and the reason goes.
export function moreTime(db: Database, ref: TaskRef, now = Date.now()): number {
  const s = settingsOf(taskRow(db, ref.task) as TaskRow);
  const settings = JSON.stringify({ ...s, partTimeMin: (s.partTimeMin ?? PART_TIME_MIN) + MORE_TIME_MIN });
  return patch(db, ref.task, ref.version, { settings_json: settings, blocked_json: null }, now);
}

// spec.md section 6.1, "Keep one PR" and "Change the limit": new task settings, and the size reason goes. Returns the new version.
export function setSettings(db: Database, ref: TaskRef, s: TaskSettings, now = Date.now()): number {
  return patch(db, ref.task, ref.version, { settings_json: JSON.stringify(s), blocked_json: null }, now);
}
export const taskSettingsOf = settingsOf;

// spec.md section 6.7: the loop fixes the confirmed blocker and major points of its own review. The other points stay listed.
export const mustFixPoint = (p: Pick<FindingPayload, "verify" | "severity">) =>
  p.verify?.verdict === "confirmed" && (p.severity === "blocker" || p.severity === "major");

const POINTS = {
  review: `SELECT s.id, s.run FROM task_step s JOIN task_part p ON p.id = s.part
    WHERE s.task = $id AND s.kind = 'review' AND s.state = 'ok' AND p.state = 'self_reviewed' ORDER BY s.id DESC LIMIT 1`,
  fixed: "SELECT 1 FROM task_step WHERE task = $id AND kind = 'commit' AND item = 'points' AND state = 'ok' AND id > $after",
  items: "SELECT id, payload_json FROM review_item WHERE run = $run AND kind = 'finding' ORDER BY id",
};

// The points that "Fix these too" fixes: the newest own review of a part that waits for its PR, without the points that the
// verify phase discarded. Empty after the commit of their fix.
export function openPoints(db: Database, id: number): (TaskPointDto & { payload: FindingPayload })[] {
  const r = db.query(POINTS.review).get({ id }) as { id: number; run: number | null } | null;
  if (!r?.run || db.query(POINTS.fixed).get({ id, after: r.id })) return [];
  return (db.query(POINTS.items).all({ run: r.run }) as { id: number; payload_json: string }[]).flatMap((x) => {
    const p = JSON.parse(x.payload_json) as FindingPayload;
    if (p.discardedBy === "verify" || mustFixPoint(p)) return [];
    return [{ id: x.id, severity: p.severity, path: p.path, line: p.line ?? null, text: p.body, payload: p }];
  });
}

// spec.md section 6.9, Reviewers: the reviewers of the task settings, else the reviewers of your newest PR in this repository. Several
// repositories (section 6.16.8): project and repo name the repository of a row.
function defaultReviewers(db: Database, t: TaskRow, project = t.project, repo = t.repo): string[] {
  const own = settingsOf(t).reviewers;
  if (own) return own;
  const r = db
    .query(
      `SELECT reviewers_json FROM pull_request WHERE project = $project AND repo = $repo AND my_role = 'AUTHOR'
        AND reviewers_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get({ project, repo }) as { reviewers_json: string } | null;
  const list = r ? (JSON.parse(r.reviewers_json) as { slug: string; login?: string | null }[]) : [];
  return [...new Set(list.map((x) => x.login ?? x.slug))];
}

// A failed or cancelled run stops the task with its reason. Resume runs the step again. The usage limit stops it too, with the CLI
// text. A done or failed task keeps its state.
export function stopForRun(db: Database, ref: TaskRef, step: number | null, e: Pick<Ending, "status" | "text">, now = Date.now()) {
  const r = advance(db, ref, { type: "STOP" }, {}, now);
  if (r.status !== 200) return;
  const text = e.status === "cancelled" ? "The run was cancelled." : (e.text ?? "The run failed.");
  patch(db, ref.task, r.version, { blocked_json: blocked({ kind: "error", step, text }) }, now);
}

// Throws out of a transaction so that it rolls back. The caller maps it to 409.
class Refused extends Error {
  constructor(
    message: string,
    readonly running?: RunConflict,
  ) {
    super(message);
  }
}

function interviewOf(db: Database, id: number): TaskInterviewDto | null {
  const r = db.query(Q.interview).get({ id }) as { answer: string } | null;
  return r ? (JSON.parse(r.answer) as TaskInterviewDto) : null;
}

const interviewRows = (db: Database, id: number) =>
  (db.query(Q.questions).all({ id }) as (QuestionRow & { source: string })[]).filter((q) => q.source === "interview");

const openQuestions = (db: Database, id: number) => {
  const rows = interviewRows(db, id).filter((q) => q.answer_json === null);
  const round = Math.max(0, ...rows.map((q) => q.round));
  return rows.filter((q) => q.round === round);
};

export type PartRow = {
  id: number;
  ord: number;
  kind: TaskPartDto["kind"];
  title: string;
  branch: string;
  base_branch: string;
  pr: number | null;
  remote_pr: number | null;
  state: PartState;
  head: string | null;
  pushed: string | null;
  lines: number | null;
  files: number | null;
  usage_json: string | null;
  keys_json: string | null;
  start_mode: StartMode | null;
  after_part: number | null;
  base_commit: string | null;
  spec_dir: string | null;
  adopted: number;
  override: number;
};
type StepRow = {
  id: number;
  part: number | null;
  ord: number;
  kind: TaskStepDto["kind"];
  run: number | null;
  state: TaskStepDto["state"];
  attempt: number;
  item: string | null;
  detail_json: string;
  started_at: number;
  ended_at: number | null;
};
type FullQuestionRow = QuestionRow & {
  source: TaskQuestionDto["source"];
  step: number | null;
  asked_at: number;
  answered_at: number | null;
};

const rowDto = (db: Database, t: TaskRow): TaskRowDto => {
  const b = t.blocked_json === null ? null : taskBlocked.safeParse(JSON.parse(t.blocked_json));
  const code = db.query(Q.codeParts).all({ id: t.id }) as { ord: number; state: PartState; pr_state: string | null }[];
  const merged = (p: (typeof code)[number]) => p.state === "merged" || p.pr_state === "MERGED";
  const open = code.find((p) => !merged(p) && p.state !== "abandoned");
  const docs = docsOf(t);
  return {
    progress: {
      planReady: t.state === "spec_draft" && docs !== null && !docs.approved,
      part: open?.ord ?? 0,
      parts: code.length,
      ready: open?.state === "self_reviewed",
      merged: code.length > 0 && code.every((p) => merged(p) || p.state === "abandoned"),
    },
    id: t.id,
    project: t.project,
    repo: t.repo,
    key: t.key,
    title: t.title,
    state: t.state,
    size: t.size,
    blocked: b?.success ? b.data : null,
    version: t.version,
    updatedAt: t.updated_at,
    closedAt: t.closed_at,
  };
};

// The commands of the plan screen: the proposed ones, then the saved ones of the repository. A proposal with the argv of a saved
// command is the same command, so it shows once.
function commandsOf(p: Plan, saved: TaskCommand[]): (TaskCommand & { saved: boolean })[] {
  const same = (a: TaskCommand, b: TaskCommand) => JSON.stringify(a.argv) === JSON.stringify(b.argv);
  return [
    ...p.testing.commands.filter((c) => !saved.some((s) => same(s, c))).map((c) => ({ ...c, saved: false })),
    ...saved.map((c) => ({ ...c, saved: true })),
  ];
}

// docs_json.subtasks: the checked sub-task plan of the spec run (spec.md section 6.20.4). null for a task without sub-tasks.
type SubDocs = Docs & { subtasks?: SubtaskPlan };
const subPlanOf = (docs: Docs): SubtaskPlan | null => (docs as SubDocs).subtasks ?? null;

function planDto(db: Database, t: TaskRow, docs: Docs): TaskPlanDto {
  const repo = repoSettings(db, t.project, t.repo);
  const budget = settingsOf(t).lineBudget ?? repo.lineBudget;
  const floor = sizeFloor(docs.parsed.estimate, budget);
  const sub = subPlanOf(docs);
  return {
    maxOpen: sub?.maxOpen ?? null,
    starts: (sub?.starts ?? []).map((x) => {
      const part = docs.parsed.parts.find((p) => p.n === x.n);
      return { ...x, title: part?.title ?? "", lines: part?.lines ?? null };
    }),
    notes: sub?.notes ?? [],
    proposed: docs.parsed.proposed,
    minimum: floor.minimum,
    rules: floor.rules,
    budget,
    missing: docs.parsed.map.filter((e) => e.missing).length,
    base: docs.parsed.base,
    commands: commandsOf(docs.parsed, repo.commands),
    warning: repo.warnedAt === null,
    approved: docs.approved,
  };
}

// ---------- Tell Claude and Update from the base branch (spec.md section 6.18) ----------

export const WORKING = "Claude or the checks are working.";
// spec.md section 6.18.1: the reasons that keep the Tell Claude box. A part that the loop builds has a worktree; a built part waits.
const BOX_REASONS = new Set<TaskBlocked["kind"]>(["red", "size", "blocker", "denied_path", "update"]);
const HAS_WORKTREE = new Set<PartState>(["implementing", "self_reviewed", "pr_open", "changes_requested", "approved"]);
const BUILT = new Set<PartState>(["self_reviewed", "pr_open", "changes_requested", "approved"]);
const blockedOf = (t: TaskRow): TaskBlocked | null => {
  const r = t.blocked_json === null ? null : taskBlocked.safeParse(JSON.parse(t.blocked_json));
  return r?.success ? r.data : null;
};

// spec.md section 6.18.5: the newest base check of each task, by database. The loop writes it, and the Task view reads it. part: the
// task_part of the check (spec.md section 6.20.10, the base check of each part).
export type BaseMoves = { part: number; taskRepo: number; newCommits: number }[];
const baseChecks = new WeakMap<Database, Map<number, { at: number; moves: BaseMoves }>>();
export function setBaseMoves(db: Database, task: number, moves: BaseMoves, at: number) {
  const m = baseChecks.get(db) ?? new Map();
  m.set(task, { at, moves });
  baseChecks.set(db, m);
}
export const baseCheckOf = (db: Database, task: number) => baseChecks.get(db)?.get(task) ?? null;

// spec.md section 6.18.2: the part of a send: the part in the body, else the part of the reason, else the part that the loop builds,
// else the last part that is not merged. A task with sub-tasks takes the default focus of spec.md section 6.20.13 after the part of the
// reason.
export function currentPart(db: Database, t: TaskRow, partId?: number): PartRow | null {
  const all = db.query(Q.parts).all({ id: t.id }) as PartRow[];
  if (partId !== undefined) return all.find((p) => p.id === partId) ?? null;
  const b = blockedOf(t);
  const own = b?.step
    ? (db.query("SELECT part FROM task_step WHERE id = $id").get({ id: b.step }) as { part: number | null } | null)
    : null;
  const ownId = b?.part ?? own?.part;
  return (
    all.find((p) => p.id === ownId) ??
    (t.subtasks === 1 ? focusOf(db, t, all) : undefined) ??
    all.find((p) => p.state === "implementing") ??
    all.findLast((p) => p.adopted === 0 && HAS_WORKTREE.has(p.state)) ??
    null
  );
}

// spec.md section 6.20.13, the default focus after the part of the reason: a part ready for its PR click; a part whose lower part merged
// while its PR still targets the lower branch; a part with a moved base, conflicts, or commits not on the server; the part that Claude
// builds; the first part that waits for review.
function focusOf(db: Database, t: TaskRow, all: PartRow[]): PartRow | undefined {
  const mine = all.filter((p) => p.adopted === 0);
  const lowerMerged = (p: PartRow) => BUILT.has(p.state) && lowerOf(db, t, p, all) !== null;
  const behind = (p: PartRow) =>
    BUILT.has(p.state) &&
    ((p.pushed !== null && p.head !== p.pushed) || partBases(db, t, p).some((x) => x.newCommits > 0 || x.conflicted || x.changed));
  return (
    mine.find((p) => p.state === "self_reviewed") ??
    mine.find(lowerMerged) ??
    mine.find(behind) ??
    mine.find((p) => p.state === "implementing") ??
    mine.find((p) => HAS_PR.has(p.state))
  );
}

// ---------- The parts of a task with sub-tasks (spec.md section 6.20.6) ----------

const HAS_PR = new Set<PartState>(["pr_open", "changes_requested", "approved"]);

export const keysOf = (p: { keys_json: string | null }): string[] => (p.keys_json === null ? [] : (JSON.parse(p.keys_json) as string[]));

export type PartName = { key: string; text: string; commit: string };

// The names of each part. key: the first sub-task key, else the task key. text: the name in a sentence, "ABC-13 (2 of 2)" for part k of
// a sub-task in n parts. commit: the name in commit messages and the PR title, "ABC-13 (part 2 of 2)" for a split part. Combined
// sub-tasks give "ABC-15, ABC-16" in both.
export function partNames(taskKey: string, rows: readonly { id: number; ord: number; keys_json: string | null }[]): Map<number, PartName> {
  const out = new Map<number, PartName>();
  for (const p of rows) {
    const keys = keysOf(p);
    const key = keys[0] ?? taskKey;
    const twins = rows.filter((x) => (keysOf(x)[0] ?? taskKey) === key).sort((a, b) => a.ord - b.ord);
    const k = twins.findIndex((x) => x.id === p.id) + 1;
    const split = twins.length > 1;
    if (keys.length > 1) out.set(p.id, { key, text: keys.join(", "), commit: keys.join(", ") });
    else
      out.set(p.id, {
        key,
        text: split ? `${key} (${k} of ${twins.length})` : key,
        commit: split ? `${key} (part ${k} of ${twins.length})` : key,
      });
  }
  return out;
}

// spec.md section 6.20.10: the lower part of a started part after it merged, while the PR of the part still targets the lower branch.
// aFinal: the last head of the lower part, its pushed head for an app part, the synced source head for a tracked PR. The sync marks the
// merge in the part state (WP-ST5) or in the synced PR state. null: no merged lower part, or the part moved.
export type LowerPart = { id: number; name: string; branch: string; aFinal: string | null; remotePr: number | null };
type LowerRow = Pick<PartRow, "id" | "ord" | "keys_json" | "branch" | "state" | "pushed" | "adopted" | "pr" | "remote_pr">;
export function lowerOf(
  db: Database,
  t: Pick<TaskRow, "id" | "key" | "subtasks" | "target_branch">,
  part: Pick<PartRow, "after_part" | "base_branch" | "base_commit" | "adopted">,
  rows: readonly LowerRow[] = db.query(Q.parts).all({ id: t.id }) as PartRow[],
): LowerPart | null {
  if (t.subtasks !== 1 || part.after_part === null || part.base_commit === null || part.adopted === 1) return null;
  const lower = rows.find((p) => p.id === part.after_part);
  if (!lower || lower.branch !== part.base_branch || part.base_branch === t.target_branch) return null;
  const pr =
    lower.pr === null ? null : (db.query(Q.lowerPr).get({ id: lower.pr }) as { state: string | null; source_head: string | null } | null);
  if (lower.state !== "merged" && pr?.state !== "MERGED") return null;
  return {
    id: lower.id,
    name: partNames(t.key, rows).get(lower.id)?.text ?? t.key,
    branch: lower.branch,
    aFinal: lower.adopted === 1 ? (pr?.source_head ?? null) : lower.pushed,
    remotePr: lower.remote_pr,
  };
}

// spec.md section 6.20.10: a part whose lower part merged updates from the task base, and its base check reads the task base.
export const updateBase = <P extends Parameters<typeof lowerOf>[2] & { base_branch: string }>(
  db: Database,
  t: Parameters<typeof lowerOf>[1],
  part: P,
  rows?: readonly LowerRow[],
): P => (lowerOf(db, t, part, rows) ? { ...part, base_branch: t.target_branch } : part);

// How the lower part of each part merged (TaskPartDto.lower), from the newest base check or update of the part. By database and part ID.
type LowerHow = NonNullable<TaskPartDto["lower"]>["how"];
const lowerHows = new WeakMap<Database, Map<number, LowerHow>>();
export function setLowerHow(db: Database, part: number, how: LowerHow) {
  const m = lowerHows.get(db) ?? new Map<number, LowerHow>();
  m.set(part, how);
  lowerHows.set(db, m);
}
export const lowerHowOf = (db: Database, part: number): LowerHow | null => lowerHows.get(db)?.get(part) ?? null;

// spec.md section 6.20.6, Plan file: the docs of one part of a task with sub-tasks. The plan holds only this part (task_part.ord is its
// plan part number) and the map entries of its files, under the first key and the summary of its sub-task. A task without sub-tasks
// keeps its docs. null: no plan, or no plan part with this number.
export function partDocsOf(db: Database, t: TaskRow, part: { ord: number; keys_json: string | null; title: string }): Docs | null {
  const docs = docsOf(t);
  if (!docs || t.subtasks !== 1) return docs;
  const pp = docs.parsed.parts.find((x) => x.n === part.ord);
  if (!pp) return null;
  const files = new Set(pp.tasks.flatMap((x) => x.files).map((f) => repoPath(f) ?? f));
  const e = docs.parsed.estimate;
  const plan: Plan = {
    ...docs.parsed,
    estimate: { ...e, parts: 1, lines: pp.lines ?? e.lines },
    map: docs.parsed.map.filter((m) => files.has(repoPath(m.path) ?? m.path)),
    parts: [pp],
    partCount: docs.parsed.parts.length,
  };
  const key = keysOf(part)[0] ?? t.key;
  const summary = subtaskRows(db, t.id).find((r) => r.key === key)?.summary ?? part.title;
  return { ...renderDocs(key, summary, "small", plan), version: docs.version, parsed: plan, approved: docs.approved };
}

type ScheduleRow = {
  id: number;
  ord: number;
  state: PartState;
  keys_json: string | null;
  start_mode: StartMode | null;
  after_part: number | null;
  override: number;
};

// spec.md section 6.20.6: the scheduler over the part rows of a task with sub-tasks. null for a task without sub-tasks. The sync sends
// GATE_PASSED when the part gate passes (section 6.20.7), so the state approved holds the gate result.
export function scheduleOf(db: Database, t: TaskRow, rows: readonly ScheduleRow[]): Schedule | null {
  if (t.subtasks !== 1) return null;
  const done = new Set(
    subtaskRows(db, t.id)
      .filter((r) => r.category === "done")
      .map((r) => r.key),
  );
  const names = partNames(t.key, rows);
  const parts = rows.map((p) => {
    const keys = keysOf(p);
    return {
      id: p.id,
      ord: p.ord,
      label: names.get(p.id)?.text ?? t.key,
      state: p.state,
      start: p.start_mode,
      after: p.after_part,
      gate: p.state === "approved",
      override: p.override === 1,
      done: keys.length > 0 && keys.every((k) => done.has(k)),
    };
  });
  return nextPart(parts, Math.min(settingsOf(t).maxOpen ?? MAX_OPEN_DEFAULT, MAX_OPEN_CAP));
}

// spec.md section 6.20.2: the app never pushes to the branch of a PR that it did not create, and never changes it.
export const ADOPTED = "This PR is in review outside the app. The app does not change it.";

// The part of a Tell Claude send (spec.md section 6.18.1), or the sentence of the 409 in a state without the box.
export function instructTarget(db: Database, t: TaskRow, partId?: number): { part: PartRow } | { error: string } {
  if (t.state !== "implementing" && t.state !== "ready") return { error: TASK_STATE_TEXT[t.state] };
  if (partId !== undefined && currentPart(db, t, partId)?.adopted) return { error: ADOPTED };
  const b = blockedOf(t);
  if (b && !BOX_REASONS.has(b.kind)) return { error: b.text };
  if (db.query(Q.busy).get({ id: t.id })) return { error: WORKING };
  const part = currentPart(db, t, partId);
  if (!part || !HAS_WORKTREE.has(part.state))
    return { error: partId === undefined ? TASK_STATE_TEXT[t.state] : "This part has no worktree." };
  // No reason and a part in the build: the loop works on it.
  if (!b && !BUILT.has(part.state)) return { error: WORKING };
  return { part };
}

// The part of "Update from <base>" (spec.md section 6.18.3): a built part with no step that runs. "Try again" after a stopped update.
export function updateTarget(db: Database, t: TaskRow, partId: number): { part: PartRow } | { error: string } {
  if (t.state !== "implementing" && t.state !== "ready") return { error: TASK_STATE_TEXT[t.state] };
  if (currentPart(db, t, partId)?.adopted) return { error: ADOPTED };
  const b = blockedOf(t);
  if (b && b.kind !== "update") return { error: b.text };
  if (db.query(Q.busy).get({ id: t.id })) return { error: WORKING };
  const part = currentPart(db, t, partId);
  if (!part || !BUILT.has(part.state)) return { error: "This part is not built yet." };
  return { part };
}

// "Undo the update" (spec.md section 6.18.3, Checks): the newest update of the part ended with its checks, and no push and no commit
// came after it.
export function undoTarget(
  db: Database,
  t: TaskRow,
  partId: number,
): { part: PartRow; step: number; detail: NonNullable<StepDetail["update"]> } | { error: string } {
  const none = { error: "No update of this part waits for Undo." };
  if (t.state !== "implementing" && t.state !== "ready") return { error: TASK_STATE_TEXT[t.state] };
  const b = blockedOf(t);
  if (b && b.kind !== "red") return { error: b.text };
  const part = currentPart(db, t, partId);
  if (!part) return none;
  const u = db
    .query("SELECT id, state, detail_json FROM task_step WHERE part = $part AND kind = 'update' ORDER BY id DESC LIMIT 1")
    .get({ part: part.id }) as { id: number; state: string; detail_json: string } | null;
  const d = u ? stepDetail.parse(JSON.parse(u.detail_json)).update : null;
  if (u?.state !== "ok" || !d || d.undone || (d.result !== "green" && d.result !== "red")) return none;
  if (
    db.query("SELECT 1 FROM task_step WHERE part = $part AND kind = 'push' AND state = 'ok' AND id > $id").get({ part: part.id, id: u.id })
  )
    return { error: "The update is on the server now. Undo works only before the next push." };
  if (db.query(Q.busy).get({ id: t.id })) return { error: WORKING };
  const rows = repoDtos(db, t);
  for (const h of d.postHeads) {
    const role = rows.find((r) => r.id === h.taskRepo)?.role;
    const now =
      role === "main"
        ? part.head
        : role === "submodule"
          ? ((
              db.query("SELECT head FROM task_pr WHERE part = $part AND task_repo = $repo").get({ part: part.id, repo: h.taskRepo }) as {
                head: string | null;
              } | null
            )?.head ?? h.head)
          : h.head;
    if (now !== h.head) return { error: "The branch changed after the update." };
  }
  return { part, step: u.id, detail: d };
}

// spec.md section 6.18.6, TaskDto bases: each repository that the update can change, with the count of the newest base check and the
// merge result of its synced PR. outcome CONFLICTED with current true marks the PR conflicted (Gate G18 has not verified the value).
function basesOf(db: Database, t: TaskRow): TaskDto["bases"] {
  const part = t.state === "implementing" || t.state === "ready" ? currentPart(db, t) : null;
  return part ? partBases(db, t, part) : [];
}

// The bases of one built part that the app created (spec.md section 6.20.10, the base check of each part).
export function partBases(db: Database, t: TaskRow, part: PartRow): TaskDto["bases"] {
  if (!BUILT.has(part.state) || part.adopted === 1) return [];
  const check = baseCheckOf(db, t.id);
  const conflicted = (pr: number | null) => {
    const r =
      pr === null
        ? null
        : (db.query("SELECT merge_result FROM pr_merge_result WHERE pr = $id").get({ id: pr }) as { merge_result: string | null } | null);
    if (!r?.merge_result) return false;
    const m = JSON.parse(r.merge_result) as { outcome?: unknown; current?: unknown };
    return m.outcome === MERGE_CONFLICTED && m.current === true;
  };
  return updateRepos(db, t, updateBase(db, t, part)).map((r) => ({
    taskRepo: r.row.id,
    branch: r.base,
    newCommits: check?.moves.find((m) => m.part === part.id && m.taskRepo === r.row.id)?.newCommits ?? 0,
    changed: r.row.base_changed === 1,
    conflicted: conflicted(
      r.row.role === "main"
        ? part.pr
        : ((
            db.query("SELECT pr FROM task_pr WHERE part = $part AND task_repo = $repo").get({ part: part.id, repo: r.row.id }) as {
              pr: number | null;
            } | null
          )?.pr ?? null),
    ),
  }));
}

// spec.md section 6.20.13, the step strip of a task with sub-tasks: a sub-task is done when Jira says so, or when each of its parts
// merged or was dropped. null for a task without sub-tasks.
function subtaskCount(db: Database, t: TaskRow, rows: PartRow[]): { done: number; total: number } | null {
  if (t.subtasks !== 1) return null;
  const subs = subtaskRows(db, t.id);
  const closed = (key: string) => {
    const own = rows.filter((p) => keysOf(p).includes(key));
    return own.length > 0 && own.every((p) => p.state === "merged" || p.state === "abandoned");
  };
  return { done: subs.filter((s) => s.category === "done" || closed(s.key)).length, total: subs.length };
}

// spec.md section 6.18.2: the newest Claude step that asked for the newest base, when no update ran after it. steps: newest first.
function needsBaseOf(steps: { kind: string; state: string; detail: StepDetail }[]): TaskDto["needsBase"] {
  for (const s of steps) {
    if (s.kind === "update" && s.state === "ok" && !s.detail.update?.undone) return null;
    if (s.detail.needsBase) return s.detail.needsBase;
  }
  return null;
}

export function taskDto(db: Database, t: TaskRow): TaskDto {
  const partRows = db.query(Q.parts).all({ id: t.id }) as PartRow[];
  const schedule = scheduleOf(db, t, partRows);
  const approvals = approvalsOf(db, t);
  const parts = partRows.map((p): TaskPartDto => {
    const lower = lowerOf(db, t, p, partRows);
    const how = lower && lowerHowOf(db, p.id);
    const synced =
      p.pr === null ? null : (db.query(Q.partPr).get({ id: p.pr }) as { state: string | null; reviewers_json: string | null } | null);
    const reviewers = synced?.reviewers_json ? (JSON.parse(synced.reviewers_json) as { name: string; status: string }[]) : [];
    return {
      id: p.id,
      ord: p.ord,
      kind: p.kind,
      title: p.title,
      branch: p.branch,
      baseBranch: p.base_branch,
      pr: p.pr,
      remotePr: p.remote_pr,
      state: p.state,
      head: p.head,
      pushed: p.pushed,
      lines: p.lines,
      usage: p.usage_json === null ? null : (JSON.parse(p.usage_json) as RunUsage),
      prState: synced?.state ?? null,
      waiting: reviewers.filter((r) => r.status !== "APPROVED").map((r) => r.name),
      build: buildOf(db, p.pr),
      keys: p.keys_json === null ? [] : (JSON.parse(p.keys_json) as string[]),
      start: p.start_mode,
      after: p.after_part,
      adopted: p.adopted === 1,
      specDir: p.spec_dir,
      bases: partBases(db, t, p),
      lower: lower && how ? { key: lower.name, how } : null,
      gate: partGate(db, p, approvals),
      wait: schedule?.waits.get(p.id) ?? null,
    };
  });
  const docs = docsOf(t);
  const steps = (db.query(Q.steps).all({ id: t.id }) as StepRow[]).map((s) => ({
    id: s.id,
    part: s.part,
    ord: s.ord,
    kind: s.kind,
    run: s.run,
    state: s.state,
    attempt: s.attempt,
    item: s.item,
    detail: stepDetail.parse(JSON.parse(s.detail_json)),
    startedAt: s.started_at,
    endedAt: s.ended_at,
  }));
  const current = currentPart(db, t);
  return {
    ...rowDto(db, t),
    originPr: t.origin_pr,
    profile: t.profile,
    stoppedFrom: t.stopped_from,
    sizeBy: t.size_by,
    targetBranch: t.target_branch,
    baseCommit: t.base_commit,
    specDir: t.spec_dir,
    specBranch: t.spec_branch,
    estimate: t.estimate_json === null ? null : (JSON.parse(t.estimate_json) as TaskDto["estimate"]),
    settings: settingsOf(t),
    docs: docs
      ? { ...Object.fromEntries(TASK_DOCS.flatMap((d) => (docs[d] === undefined ? [] : [[d, docs[d]]]))), version: docs.version }
      : null,
    parts,
    repos: repoDtos(db, t),
    prs: partRows
      .filter((p) => p.head !== null)
      .flatMap((p) =>
        prRows(db, t, p).map(({ parent: _, depth: __, access: ___, ...r }) => ({
          ...r,
          reviewers: defaultReviewers(db, t, r.project, r.repo),
          build: buildOf(db, r.pr),
        })),
      ),
    questions: (db.query(Q.questions).all({ id: t.id }) as FullQuestionRow[]).map((q) => ({
      id: q.id,
      source: q.source,
      round: q.round,
      ord: q.ord,
      text: q.text,
      why: q.why,
      kind: q.kind,
      options: JSON.parse(q.options_json) as TaskQuestionDto["options"],
      recommended: q.recommended,
      answer: q.answer_json === null ? null : (JSON.parse(q.answer_json) as Answer),
      step: q.step,
      askedAt: q.asked_at,
      answeredAt: q.answered_at,
    })),
    steps,
    createdAt: t.created_at,
    interview: interviewOf(db, t.id),
    plan: docs ? planDto(db, t, docs) : null,
    strip: stepStrip({ size: t.size, state: t.state, stoppedFrom: t.stopped_from, parts, subtasks: subtaskCount(db, t, partRows) }),
    reviewers: defaultReviewers(db, t),
    points: openPoints(db, t.id).map(({ payload: _, ...p }) => p),
    // The routes set it from the loop.
    working: false,
    attachments: taskIssue(db, t)?.issue.attachments ?? [],
    files: taskFileDtos(db, t.id),
    bases: basesOf(db, t),
    needsBase: needsBaseOf(steps),
    // The routes also clear it while the loop works.
    canInstruct: !("error" in instructTarget(db, t)),
    canUndoUpdate: current !== null && !("error" in undoTarget(db, t, current.id)),
    subtasks: t.subtasks === 1 ? subtaskDtos(db, t.id, partRows) : null,
    issueStatus: taskIssue(db, t)?.issue.status ?? null,
  };
}

export type TaskResult =
  | { status: 200 | 201 | 202; task: TaskDto }
  | { status: 400 | 404 | 413 | 502; error: string }
  | { status: 422; error: string; line: number }
  | { status: 409; error: string; task?: TaskDto; running?: RunConflict["running"] };

// task.md of a task and its included files (spec.md section 6.17): the issue of its origin PR or of its create, with the task files.
// A task with sub-tasks adds subtasks.md (spec.md section 6.20.3). o.keys: the sub-task keys of a part run.
export const taskFilesOf = (db: Database, dataDir: string, t: TaskRow, o: TaskFileOptions = {}) => taskFileContext(db, dataDir, t, o);

// context/answers.md of a build step: the interview answers and the answered questions of the loop.
export function stepAnswers(db: Database, id: number): ContextFile | null {
  const rows = (db.query(Q.questions).all({ id }) as (QuestionRow & { source: string })[]).filter(
    (q) => q.source === "interview" || q.answer_json !== null,
  );
  return answersFile(rows, interviewOf(db, id));
}

// spec.md section 6.16.3, base preselection: the last pick when the branch search still finds exactly that name, else the default
// branch of Bitbucket (Gate G13), else the remote HEAD of `git ls-remote --symref`. A failed read goes on to the next source.
export async function preselectBase(d: {
  last: string | null;
  provider: Pick<ForgeProvider, "listBranches" | "defaultBranch"> | null;
  project: string;
  repo: string;
  remoteHead: () => Promise<string>;
}): Promise<string> {
  const { provider, project, repo, last } = d;
  if (provider && last)
    try {
      if ((await provider.listBranches(project, repo, last)).branches.some((b) => b.name === last)) return last;
    } catch (e) {
      log(`Cannot search the branches of ${project}/${repo}: ${noUrl((e as Error).message)}`);
    }
  if (provider)
    try {
      return await provider.defaultBranch(project, repo);
    } catch (e) {
      log(`Cannot read the default branch of ${project}/${repo} from Bitbucket: ${noUrl((e as Error).message)}`);
    }
  return d.remoteHead();
}

// spec.md sections 6.20.5 and 6.20.7: the part rows of an approved sub-task plan, in the transaction of the approval. A tracked PR gets
// ADOPT_OPEN or ADOPT_MERGED, and the task follows it, so the sync reads it. A plan with tracked PRs only goes to ready. t.version: the
// version after APPROVE. Nothing goes to Bitbucket or Jira.
function approveParts(db: Database, t: TaskRow, parts: PlannedPart[], at: number) {
  const state = String(initialTransition(partMachine)[0].value);
  const top = Math.max(0, ...parts.map((p) => p.n ?? 0));
  const rows: { p: PlannedPart; id: number }[] = [];
  for (const p of parts) {
    const followed = p.pr ? followKey(db, { project: t.project, repo: t.repo, pr_id: p.pr.pr }) : null;
    const row = db.query(Q.insertPart).get({
      task: t.id,
      ord: p.n ?? top + rows.filter((x) => x.p.n === null).length + 1,
      title: p.title,
      branch: p.branch,
      base: p.base,
      pr: followed?.id ?? null,
      remote: p.pr?.pr ?? null,
      state,
      keys: JSON.stringify(p.keys),
      start: p.start,
      spec_dir: p.specDir,
      adopted: p.pr ? 1 : 0,
      now: at,
    }) as { id: number };
    rows.push({ p, id: row.id });
  }
  for (const { p, id } of rows) {
    const after = p.after;
    if (after === null) continue;
    const lower = /^\d+$/.test(after) ? rows.find((x) => x.p.n === Number(after)) : rows.find((x) => x.p.pr && x.p.keys[0] === after);
    if (lower) db.query(Q.afterPart).run({ id, after: lower.id });
  }
  let version = t.version;
  for (const { p, id } of rows) {
    if (!p.pr) continue;
    const r = advancePart(db, { task: t.id, version, part: id }, { type: p.pr.state === "MERGED" ? "ADOPT_MERGED" : "ADOPT_OPEN" }, {}, at);
    if (r.status !== 200) throw new Refused(r.error);
    version = r.version;
  }
  if (rows.every((x) => x.p.pr)) {
    const r = advance(db, { task: t.id, version }, { type: "LAST_PR_OPEN" }, {}, at);
    if (r.status !== 200) throw new Refused(r.error);
  }
}

export type TaskServiceOptions = {
  review: ReviewJobs;
  settings: Settings;
  live: Live;
  now?: () => number;
};

export function createTaskService(opts: TaskServiceOptions) {
  const { review, settings, live } = opts;
  const now = opts.now ?? Date.now;
  const changed = (id: number, pr?: number) => live.broadcast("changed", { ...(pr !== undefined && { prs: [pr] }), tasks: [id] });
  const conflict = (db: Database, t: TaskRow, error: string): TaskResult => ({
    status: 409,
    error,
    task: taskDto(db, (taskRow(db, t.id) ?? t) as TaskRow),
  });
  const busyResult = (c: RunConflict): TaskResult => ({ status: 409, error: c.error, running: c.running });
  const profile = (t: TaskRow) => taskProfile(settings.profiles(), t);
  const taskFiles = (db: Database, t: TaskRow, o: TaskFileOptions = {}) => taskFilesOf(db, review.dataDir, t, o);
  const repoDeps: RepoDeps = {
    dataDir: review.dataDir,
    provider: () => settings.provider(),
    remote: (project, repo) => review.taskRemote(project, repo),
    now,
  };
  // spec.md section 6.16.5: the interview and the spec run read every repository with access edit or read.
  const repos = (t: TaskRow) => (d: Database, head: string) => resolveTaskRepos(d, repoDeps, taskRow(d, t.id) ?? t, head);

  function insertStep(db: Database, task: number, kind: "interview" | "spec", run: number) {
    db.query(Q.stepInsert).get({ task, kind, run, now: now() });
  }

  function endStep(db: Database, run: number, e: Ending): number | null {
    const state = e.status === "cancelled" ? "cancelled" : e.status === "failed" ? "failed" : "ok";
    return (db.query(Q.stepEnd).get({ run, state, now: now() }) as { id: number } | null)?.id ?? null;
  }

  const stopTask = (db: Database, t: TaskRow, step: number | null, e: Ending) =>
    stopForRun(db, { task: t.id, version: t.version }, step, e, now());

  // The effect after a run end: the next run of the task. A refused start stops the task with the reason. state: the task state that
  // the next run belongs to. A Stop between the run end and this effect leaves another state, and no run starts.
  function startNext(db: Database, id: number, state: TaskRow["state"], next: (t: TaskRow) => TaskRunStart) {
    return () => {
      const t = taskRow(db, id);
      if (t?.state !== state || t.blocked_json !== null) return;
      const r = review.taskRun(db, next(t));
      if (r.status !== 202)
        db.transaction(() => {
          const cur = taskRow(db, id);
          if (cur) stopTask(db, cur, null, { status: "failed", kind: null, text: `${r.conflict.error} Resume when it ends.`, raw: "" });
        })();
      changed(id);
    };
  }

  function interviewRun(db: Database, t: TaskRow, round: number): TaskRunStart {
    const p = profile(t);
    const { files, attachments } = taskFiles(db, t);
    const answers = round > 1 ? answersFile(interviewRows(db, t.id), interviewOf(db, t.id)) : null;
    const max = INTERVIEW_QUESTIONS[Math.min(round, INTERVIEW_QUESTIONS.length) - 1] ?? 0;
    return {
      task: t.id,
      kind: "interview",
      key: `task:${t.id}:interview:${round}`,
      repos: repos(t),
      project: t.project,
      repo: t.repo,
      branch: t.target_branch,
      profile: p,
      files,
      attachments,
      own: answers ? [answers] : [],
      maxTurns: INTERVIEW_TURNS,
      schema: interviewJsonSchema(),
      agent: interviewAgent(p, round, t.subtasks === 1),
      prompt: (head, instructions) =>
        buildInterviewPrompt({
          key: t.key,
          project: t.project,
          repo: t.repo,
          branch: t.target_branch,
          head,
          taskFile: files.length > 0,
          attachments: attachments.length > 0,
          answers: answers !== null,
          instructions,
          round,
          max,
        }),
      judge: (o, _ws, servers, gaps) =>
        judgeTask(o, interviewResult, "interview", servers, gaps, async (r) => {
          const c = checkQuestions(r.questions, round);
          const answer: TaskInterviewDto = { round, summary: r.summary, unknowns: r.unknowns, done: r.done };
          return { result: { ...r, questions: c.questions }, skipped: c.skipped, answer: JSON.stringify(answer) };
        }),
      started: (d, run) => insertStep(d, t.id, "interview", run),
      finish: (d, run, e) => {
        const step = endStep(d, run.id, e);
        const cur = taskRow(d, t.id);
        if (cur?.state !== "interview") return undefined;
        const r = e.result?.task as InterviewResult | undefined;
        if (!r) {
          stopTask(d, cur, step, e);
          return undefined;
        }
        const q = d.query(Q.question);
        for (const [ord, x] of r.questions.entries())
          q.run({
            task: t.id,
            round,
            ord,
            text: x.text,
            why: x.why,
            kind: x.kind,
            options: JSON.stringify(x.options),
            recommended: x.recommended,
            step,
            now: now(),
          });
        if (afterInterview(round, r.questions.length) === "ask") {
          const a = advance(d, { task: t.id, version: cur.version }, { type: "ASKED" }, {}, now());
          if (a.status !== 200) return undefined;
          const n = r.questions.length;
          const text = `Claude has ${n} ${n === 1 ? "question" : "questions"} before it writes the plan.`;
          patch(d, t.id, a.version, { blocked_json: blocked({ kind: "question", step, text }) }, now());
          return undefined;
        }
        const a = advance(d, { task: t.id, version: cur.version }, { type: "ANSWERED" }, {}, now());
        if (a.status !== 200) return undefined;
        patch(d, t.id, a.version, { blocked_json: null }, now());
        return startNext(d, t.id, "spec_draft", (x) => specRun(d, x));
      },
    };
  }

  // spec.md section 6.16.5, Proposals: the repositories with REPO_WRITE (Gate G16), at most REPO_LIST_MAX.
  async function writableList(): Promise<{ repos: ListedRepo[]; complete: boolean } | { error: string }> {
    try {
      const p = await settings.provider();
      if (!p) return { error: "Configure the Bitbucket URL and token first." };
      const r = await p.writableRepos();
      return { repos: r.repos.map((x) => ({ project: x.project, slug: x.slug, name: x.name })), complete: r.complete };
    } catch (e) {
      return { error: noUrl((e as Error).message) };
    }
  }

  function specRun(db: Database, t: TaskRow): TaskRunStart {
    const p = profile(t);
    const budget = budgetOf(db, t);
    const { files, attachments } = taskFiles(db, t);
    const answers = answersFile(interviewRows(db, t.id), interviewOf(db, t.id));
    let plan: Plan | null = null;
    let sub: SubtaskPlan | null = null;
    let listed: ListedRepo[] = [];
    let proposals: SpecResult["repos"] = [];
    let nested: SnapshotRepo[] = [];
    const subtasks = t.subtasks === 1;
    // The untrusted files of the snapshot: the task files, then context/repo-list.md, then context/pr-history.md of a sub-task task.
    const untrusted = [...files];
    return {
      task: t.id,
      kind: "spec",
      key: `task:${t.id}:spec`,
      repos: async (d, head) => {
        const out = await repos(t)(d, head);
        nested = out;
        const l = await writableList();
        listed = "error" in l ? [] : l.repos;
        const skipped = repoDtos(d, t).filter((r) => r.proposal === "skipped");
        // prepareTaskWorkspace writes the files after this hook resolves, so the list joins them here.
        untrusted.push(
          repoListFile(
            "error" in l ? null : l,
            skipped.map((r) => `${r.project}/${r.repo}`),
            "error" in l ? l.error : "",
          ),
        );
        if (subtasks) {
          // spec.md section 6.20.2: the found work, then subtasks.md again with its result.
          const p = await settings.provider().catch(() => null);
          const notes = await findWork(
            d,
            { provider: p, dataDir: review.dataDir, remote: () => review.taskRemote(t.project, t.repo) },
            t,
            head,
          );
          for (const f of taskFiles(d, t, { searched: true, notes }).files) {
            const i = untrusted.findIndex((x) => x.name === f.name);
            if (i >= 0) untrusted[i] = f;
          }
          untrusted.push(await prHistoryFile(d, p, settings.config()?.userSlug ?? null, t.project, t.repo));
        }
        return out;
      },
      project: t.project,
      repo: t.repo,
      branch: t.target_branch,
      profile: p,
      files: untrusted,
      attachments,
      own: answers ? [answers] : [],
      maxTurns: SPEC_TURNS,
      schema: specJsonSchema(),
      agent: specAgent(p, budget, process.platform, subtasks),
      prompt: (head, instructions) =>
        buildSpecPrompt({
          key: t.key,
          project: t.project,
          repo: t.repo,
          branch: t.target_branch,
          head,
          taskFile: files.length > 0,
          attachments: attachments.length > 0,
          answers: answers !== null,
          instructions,
          budget,
        }),
      judge: (o, ws, servers, gaps) =>
        judgeTask(o, specResult, "spec", servers, gaps, async (r) => {
          const base = ws.sourceHead;
          const missing = await checkMap(r.map, base, ws.cache, gitEnv("/dev/null"), nested);
          const skipped = r.map.flatMap((e, i) =>
            missing[i]
              ? [`Map line ${i + 1}: ${oneLine(e.path)}${e.line === null ? "" : `:${e.line}`} is not found at ${base.slice(0, 12)}.`]
              : [],
          );
          const rows = repoDtos(db, t);
          const inTask = rows.filter((x) => x.proposal === null || x.proposal === "added");
          proposals = checkProposals(
            r.repos,
            listed,
            inTask,
            rows.filter((x) => x.proposal === "skipped"),
            skipped,
          );
          if (subtasks) {
            sub = checkSubtaskPlan(r, subtaskRows(db, t.id), t.target_branch);
            skipped.push(...sub.notes);
          }
          plan = toPlan(r, base, missing, skipped);
          return { result: { ...r, repos: proposals }, skipped };
        }),
      started: (d, run) => insertStep(d, t.id, "spec", run),
      finish: (d, run, e) => {
        const step = endStep(d, run.id, e);
        const cur = taskRow(d, t.id);
        if (cur?.state !== "spec_draft") return undefined;
        if (!plan || !e.result) {
          stopTask(d, cur, step, e);
          return undefined;
        }
        // spec.md section 6.20.4: each part of a sub-task task is one small PR. The size rules of section 6.1 do not apply.
        const size = subtasks ? "small" : atLeast(plan.proposed, sizeFloor(plan.estimate, budgetOf(d, cur)).minimum);
        const docs: SubDocs = {
          ...renderDocs(cur.key, cur.title, size, plan),
          version: (docsOf(cur)?.version ?? 0) + 1,
          parsed: plan,
          approved: false,
          ...(sub && { subtasks: sub }),
        };
        patch(
          d,
          t.id,
          cur.version,
          {
            docs_json: JSON.stringify(docs),
            estimate_json: JSON.stringify(plan.estimate),
            size,
            size_by: size === plan.proposed && !subtasks ? "claude" : "rule",
            base_commit: run.head,
            blocked_json: null,
          },
          now(),
        );
        // spec.md section 6.16.5: the proposals of this run replace the ones that wait for Add or Skip.
        d.query(Q.dropProposals).run({ task: t.id });
        for (const x of proposals) d.query(Q.propose).run({ task: t.id, project: x.project, repo: x.repo, reason: x.reason, now: now() });
        return undefined;
      },
      keep: "base",
    };
  }

  // POST /api/tasks (spec.md section 6.11): the open task of the key, or a new task with its interview run.
  async function create(input: TaskCreateInput): Promise<TaskResult> {
    const db = review.open();
    if (!db) return { status: 409, error: "Configure the Bitbucket URL and token first." };
    const open = () => db.query(Q.open).get({ project: input.project, repo: input.repo, key: input.key }) as TaskRow | null;
    const found = open();
    if (found) return { status: 200, task: taskDto(db, found) };
    type Pr = { id: number; project: string; repo: string; target_branch: string | null };
    let pr: Pr | null = null;
    if (input.originPr !== undefined) {
      pr = db.query(Q.pr).get({ id: input.originPr }) as Pr | null;
      if (!pr) return { status: 404, error: "Pull request not found." };
      if (pr.project !== input.project || pr.repo !== input.repo)
        return { status: 400, error: "The pull request is in another repository." };
      if (!db.query(Q.prTask).get({ pr: pr.id, key: input.key }))
        return { status: 404, error: "This pull request does not name that task." };
    }
    const list = settings.profiles();
    if (input.profile !== undefined && taskProfileId(list, input.profile) !== input.profile)
      return { status: 400, error: "Pick a review profile from the list. An Explain profile cannot build a task." };
    const busy = review.busy();
    if (busy) return busyResult(busy);
    // The task text: the fetched text of the origin PR, else one Jira fetch on this click (BRIEF 3.6, decision Q4).
    const stored = pr ? (db.query(Q.context).get({ pr: pr.id, key: input.key }) as { json: string } | null) : null;
    let issue: IssueContext;
    if (stored) issue = JSON.parse(stored.json) as IssueContext;
    else {
      const got = await fetchIssue(input.key);
      if ("status" in got) return got;
      issue = got.issue;
    }
    // spec.md section 6.17: the files that Claude gets. Without a pick, the setting askAttachments decides: off gives every file that
    // can go to runs, on gives none until the user ticks one.
    const askOff = settings.config()?.askAttachments === false;
    const listing = issue.attachments ?? [];
    const ids = input.files ?? (askOff ? listing.filter((a) => !listedOnly(a)).map((a) => a.id) : []);
    const picked = [...new Set(ids)].map((x) => listing.find((a) => a.id === x));
    if (picked.some((a) => !a)) return { status: 400, error: "The task lists no such attachment. Read the task again." };
    const files: (AttachmentMeta & { issue?: string })[] = picked as AttachmentMeta[];
    // spec.md section 6.20.1: sub-task mode when the parent has sub-tasks and the user picked it, else when one is not done.
    const listed = issue.subtasks ?? [];
    const withSubtasks = listed.length > 0 && (input.subtasks ?? subtasksFirst(listed));
    if (input.subtaskFiles && !withSubtasks) return { status: 400, error: `${input.key} has no sub-tasks to build.` };
    let subs: { sub: IssueSubtask; issue: IssueContext | null }[] = [];
    if (withSubtasks) {
      const got = await readSubtasks(input.key, listed);
      if ("status" in got) return got;
      subs = got.subs;
      for (const f of input.subtaskFiles ?? [])
        if (!subs.some((s) => s.issue && s.sub.key === f.key))
          return { status: 400, error: `${f.key} is no open sub-task of ${input.key}.` };
      // spec.md section 6.20.3: the ticked files of each open sub-task, with the rule of files when the form sent no pick.
      for (const { sub, issue: i } of subs) {
        const list = i?.attachments ?? [];
        const want =
          input.subtaskFiles?.find((f) => f.key === sub.key)?.files ?? (askOff ? list.filter((a) => !listedOnly(a)).map((a) => a.id) : []);
        for (const id of new Set(want)) {
          const a = list.find((x) => x.id === id);
          if (!a) return { status: 400, error: "The task lists no such attachment. Read the task again." };
          // A Jira attachment ID is unique on its server. The first issue that lists it keeps it.
          if (!files.some((x) => x.id === id)) files.push({ ...a, issue: sub.key });
        }
      }
    }
    // The caps of section 6.17 count the files of the parent and of its sub-tasks together.
    const problem = pickProblem(files, 0);
    if (problem) return problem;
    // spec.md section 6.16.3: the origin PR target no longer sets the base.
    let branch: string;
    try {
      branch = await preselectBase({
        last:
          (db.query(Q.lastBase).get({ project: input.project, repo: input.repo }) as { last_base: string | null } | null)?.last_base ??
          null,
        provider: await settings.provider().catch(() => null),
        project: input.project,
        repo: input.repo,
        remoteHead: async () => remoteHead(review.dataDir, await review.taskRemote(input.project, input.repo)),
      });
    } catch (e) {
      if (e instanceof NoCloneLink) return { status: 409, error: e.message };
      return { status: 502, error: `Cannot read the default branch of ${input.project}/${input.repo}. ${noUrl((e as Error).message)}` };
    }
    // The downloads come before the task row, so the interview of the same transaction reads the files.
    let fetched: Fetched[] = [];
    if (files.length) {
      const got = await download(db, files);
      if ("status" in got) return got;
      fetched = got.fetched;
    }
    const fetchedAt = now();
    let id: number;
    let status: 200 | 201 = 201;
    try {
      id = db.transaction(() => {
        const again = open();
        if (again) {
          status = 200;
          dropFetched(review.dataDir, fetched);
          return again.id;
        }
        if (pr && !stored) db.query(Q.storeContext).run({ pr: pr.id, key: input.key, json: JSON.stringify(issue), at: fetchedAt });
        const repo = repoSettings(db, input.project, input.repo);
        const row = db.query(Q.insert).get({
          project: input.project,
          repo: input.repo,
          key: input.key,
          title: oneLine(issue.summary).slice(0, 200) || input.key,
          origin: pr?.id ?? null,
          state: String(initialTransition(taskMachine)[0].value),
          target: branch,
          spec_dir: repo.specDir.replaceAll("{key}", input.key),
          issue: pr ? null : JSON.stringify(issue),
          profile: input.profile ?? preselectProfile(db, list, input.project, input.repo),
          subtasks: withSubtasks ? 1 : 0,
          now: fetchedAt,
        }) as { id: number };
        saveMainRepo(db, { id: row.id, project: input.project, repo: input.repo }, branch, null, fetchedAt);
        saveSubtasks(db, row.id, subs, fetchedAt);
        saveFetched(db, row.id, fetched);
        const r = review.taskRun(db, interviewRun(db, taskRow(db, row.id) as TaskRow, 1));
        if (r.status !== 202) throw new Refused(r.conflict.error, r.conflict);
        return row.id;
      })();
    } catch (e) {
      dropFetched(review.dataDir, fetched);
      if (e instanceof Refused && e.running) return busyResult(e.running);
      throw e;
    }
    changed(id, pr && !stored ? pr.id : undefined);
    return { status, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // One Jira read of a key. A failure gives the fixed sentence of its kind.
  async function fetchIssue(key: string): Promise<{ issue: IssueContext } | TaskResult> {
    const source = await jira();
    if ("status" in source) return source;
    try {
      return { issue: await source.fetchIssue(key) };
    } catch (e) {
      if (!(e instanceof ContextError)) throw e;
      log(`Jira fetch for a task failed: ${e.message}`);
      return { status: 502, error: JIRA_FAILED[e.kind] };
    }
  }

  // spec.md section 6.20.1: one read of each sub-task that is not done, at most SUBTASKS_READ in Jira order, one after the other. A done
  // sub-task keeps the key, summary, and status of the parent read. A sub-task of another parent is dropped.
  async function readSubtasks(
    parent: string,
    listed: IssueSubtask[],
  ): Promise<{ subs: { sub: IssueSubtask; issue: IssueContext | null }[] } | TaskResult> {
    const source = await jira();
    if ("status" in source) return source;
    const siblings = listed.map((s) => s.key);
    const subs: { sub: IssueSubtask; issue: IssueContext | null }[] = [];
    try {
      for (const sub of listed.slice(0, SUBTASKS_READ)) {
        if (sub.category === "done") subs.push({ sub, issue: null });
        else {
          const issue = await source.fetchSubtask(parent, siblings, sub.key);
          if (issue) subs.push({ sub, issue });
        }
      }
    } catch (e) {
      if (!(e instanceof ContextError)) throw e;
      log(`Jira fetch for a sub-task failed: ${e.message}`);
      return { status: 502, error: JIRA_FAILED[e.kind] };
    }
    return { subs };
  }

  async function jira(): Promise<ContextSource | TaskResult> {
    let source: ContextSource | null;
    try {
      source = await settings.jira();
    } catch {
      return { status: 502, error: "Cannot read the Jira CA file." };
    }
    return source ?? { status: 409, error: "Set up Jira in Settings first." };
  }

  async function download(db: Database, files: (AttachmentMeta & { issue?: string })[]): Promise<{ fetched: Fetched[] } | TaskResult> {
    const source = await jira();
    if ("status" in source) return source;
    try {
      return { fetched: await fetchFiles(db, review.dataDir, source, files) };
    } catch (e) {
      if (e instanceof TaskFileError) return { status: 502, error: e.message };
      throw e;
    }
  }

  // POST /api/tasks/issue (spec.md section 6.17): the summary and the attachments of a key before its task exists.
  async function issue(key: string): Promise<TaskIssueDto | TaskResult> {
    if (!review.open()) return { status: 409, error: "Configure the Bitbucket URL and token first." };
    const got = await fetchIssue(key);
    if ("status" in got) return got;
    const i = got.issue;
    return { key, summary: i.summary, status: i.status, attachments: i.attachments ?? [], subtasks: i.subtasks ?? [] };
  }

  // PUT /api/tasks/:id/files/:att (spec.md section 6.17): a tick downloads a listed file once and includes it. An untick keeps the
  // file and leaves it out. The next Claude step of the task reads the change. No task version: the task state does not change.
  async function file(db: Database, id: number, att: string, include: boolean): Promise<TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    const have = taskFileDto(db, id, att);
    if (have || !include) {
      if (have && include) {
        const why = fileOnly(have);
        if (why) return { status: 400, error: `${have.filename}: ${why}` };
      }
      if (have && have.include !== include) {
        setInclude(db, id, att, include);
        changed(id);
      }
      return { status: 200, task: taskDto(db, t) };
    }
    // spec.md section 6.20.3: a file of a sub-task goes to the folder of its key. The task cap counts the files of every issue.
    let meta: (AttachmentMeta & { issue?: string }) | undefined = taskIssue(db, t)?.issue.attachments?.find((a) => a.id === att);
    for (const r of t.subtasks === 1 && !meta ? subtaskRows(db, id) : []) {
      const a = r.issue_json === null ? undefined : (JSON.parse(r.issue_json) as IssueContext).attachments?.find((x) => x.id === att);
      if (a) {
        meta = { ...a, issue: r.key };
        break;
      }
    }
    if (!meta) return { status: 404, error: "The task lists no such attachment." };
    const problem = pickProblem([meta], usedBytes(db, id));
    if (problem) return problem;
    const got = await download(db, [meta]);
    if ("status" in got) return got;
    // The task can go away during the download.
    const saved = db.transaction(() => {
      if (!taskRow(db, id)) return false;
      saveFetched(db, id, got.fetched);
      return true;
    })();
    if (!saved) {
      dropFetched(review.dataDir, got.fetched);
      return { status: 404, error: "Task not found." };
    }
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // The checks of every mutation: the task, its version, its state, and no running step.
  function load(db: Database, id: number, version: number, state: TaskState): TaskRow | TaskResult {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== version) return conflict(db, t, TASK_CHANGED);
    if (t.state !== state) return conflict(db, t, TASK_STATE_TEXT[t.state]);
    if (db.query(Q.busy).get({ id })) return conflict(db, t, "Claude is still working on this task. Wait for the step to end.");
    return t;
  }

  // POST /api/tasks/:id/answers: stores the answers, then starts round 2 or the spec run (spec.md section 6.2).
  function answers(db: Database, id: number, input: TaskAnswersInput): TaskResult {
    const t = load(db, id, input.version, "interview");
    if ("status" in t) return t;
    const open = openQuestions(db, id);
    if (!open.length) return conflict(db, t, "No question waits for an answer.");
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
    const busy = review.busy();
    if (busy) return busyResult(busy);
    const round = (open[0] as QuestionRow).round;
    const last = interviewOf(db, id);
    const next = afterAnswers(round, last?.round === round ? last.done : true);
    try {
      db.transaction(() => {
        const at = now();
        for (const q of open) {
          const a = given.get(q.id);
          const answer: Answer = a ? { choice: a.choice ?? null, text: a.text?.trim() ?? "" } : recommendedAnswer(q);
          db.query(Q.answer).run({ id: q.id, answer: JSON.stringify(answer), now: at });
        }
        const v = patch(db, id, t.version, { blocked_json: null }, at);
        if (next === "spec") {
          const r = advance(db, { task: id, version: v }, { type: "ANSWERED" }, {}, at);
          if (r.status !== 200) throw new Refused(r.error);
        }
        const cur = taskRow(db, id) as TaskRow;
        const r = review.taskRun(db, next === "spec" ? specRun(db, cur) : interviewRun(db, cur, round + 1));
        if (r.status !== 202) throw new Refused(r.conflict.error, r.conflict);
      })();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return e.running ? busyResult(e.running) : conflict(db, t, e.message);
    }
    changed(id);
    return { status: 202, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // The plan screen actions need the plan of the spec run.
  function loadPlan(db: Database, id: number, version: number): { t: TaskRow; docs: Docs } | TaskResult {
    const t = load(db, id, version, "spec_draft");
    if ("status" in t) return t;
    const docs = docsOf(t);
    return docs ? { t, docs } : conflict(db, t, "The plan is not ready yet.");
  }

  // A size under the minimum of the app rules is refused with the rule lines (spec.md section 6.1, AC-B4).
  function sizeProblem(db: Database, t: TaskRow, docs: Docs, size: TaskSize): string | null {
    const floor = sizeFloor(docs.parsed.estimate, budgetOf(db, t));
    return atLeast(size, floor.minimum) === size ? null : floor.rules.join(" ");
  }

  // The fields of a size change: the files of the plan move to the files of the new size.
  function resized(t: TaskRow, docs: Docs, size: TaskSize, approved: boolean): Patch {
    const from = t.size ?? docs.parsed.proposed;
    if (from === size) return { docs_json: JSON.stringify({ ...docs, approved }), size, size_by: t.size_by };
    const next: Docs = { ...convertDocs(t.key, t.title, from, size, docs), version: docs.version + 1, parsed: docs.parsed, approved };
    return { docs_json: JSON.stringify(next), size, size_by: "user" };
  }

  // POST /api/tasks/:id/size.
  function size(db: Database, id: number, input: TaskSizeInput): TaskResult {
    const l = loadPlan(db, id, input.version);
    if ("status" in l) return l;
    const problem = sizeProblem(db, l.t, l.docs, input.size);
    if (problem) return conflict(db, l.t, problem);
    if (l.t.size === input.size) return { status: 200, task: taskDto(db, l.t) };
    patch(db, id, l.t.version, resized(l.t, l.docs, input.size, false), now());
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // PUT /api/tasks/:id/docs: stores an edit of one plan file. The tasks grammar parses back into the stored parts. A parse error keeps
  // the old text (spec.md section 6.14).
  function docs(db: Database, id: number, input: z.infer<typeof taskDocInput>): TaskResult {
    const l = loadPlan(db, id, input.version);
    if ("status" in l) return l;
    const size = l.t.size ?? l.docs.parsed.proposed;
    if (!docNames(size).includes(input.doc)) return conflict(db, l.t, `A ${size} plan has no ${input.doc}.md.`);
    const text = input.text.replaceAll("\r\n", "\n");
    const parsed =
      input.doc === "tasks" ? parseTasks(text, l.docs.parsed.parts) : input.doc === "plan" ? parsePlan(text, l.docs.parsed.parts) : null;
    if (parsed && "error" in parsed) return { status: 422, error: parsed.error, line: parsed.line };
    const next: Docs = {
      ...l.docs,
      [input.doc]: text,
      version: l.docs.version + 1,
      parsed: parsed ? { ...l.docs.parsed, parts: parsed.parts } : l.docs.parsed,
    };
    patch(db, id, l.t.version, { docs_json: JSON.stringify(next) }, now());
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // POST /api/tasks/:id/plan: the plan approval with the size and the picked commands. The first plan of a repository needs the warning.
  function plan(db: Database, id: number, input: TaskPlanInput): TaskResult {
    const l = loadPlan(db, id, input.version);
    if ("status" in l) return l;
    const { t, docs } = l;
    // spec.md section 6.20.4: a sub-task task is small. The size rules of section 6.1 do not apply to it.
    const subtasks = t.subtasks === 1;
    if (input.subtasks && !subtasks) return { status: 400, error: `${t.key} builds no sub-tasks.` };
    const size = subtasks ? "small" : input.size;
    const problem = subtasks ? null : (sizeProblem(db, t, docs, size) ?? largeRepoProblem(size, docs.parsed.parts, repoDtos(db, t)));
    if (problem) return conflict(db, t, problem);
    // spec.md section 6.16.3: each pick names a repository of the task with access edit and the base that the plan was written on. A
    // different base goes through PUT /api/tasks/:id/base, which writes the plan again.
    const rows = taskRepos(db, t);
    const picks = input.bases ?? [];
    if (new Set(picks.map((b) => b.taskRepo)).size !== picks.length)
      return { status: 400, error: "Each repository takes one base branch." };
    for (const b of picks) {
      const r = rows.find((x) => x.id === b.taskRepo);
      if (r?.access !== "edit" || !r.project || !r.repo)
        return { status: 400, error: `Repository ${b.taskRepo} is not a repository that the task changes.` };
      const stored = r.role === "main" ? t.target_branch : r.base_branch;
      if (b.branch !== stored)
        return conflict(db, t, `The plan was written on ${stored}. Change the base branch of ${r.project}/${r.repo} first.`);
    }
    const repo = repoSettings(db, t.project, t.repo);
    const offered = commandsOf(docs.parsed, repo.commands);
    const ids = input.commands.map((c) => (typeof c === "string" ? c : c.id));
    if (new Set(ids).size !== ids.length) return { status: 400, error: "Each command is picked once." };
    const picked: TaskCommand[] = [];
    for (const x of input.commands) {
      // spec.md section 6.3: an edited or added command is the user's own argv list.
      if (typeof x !== "string") {
        if (!x.id.startsWith(NEW_COMMAND) && !offered.some((o) => o.id === x.id))
          return { status: 400, error: `Command ${x.id} is not in the plan.` };
        picked.push(x);
        continue;
      }
      const c = offered.find((o) => o.id === x);
      if (!c) return { status: 400, error: `Command ${x} is not in the plan.` };
      const { saved: _, ...cmd } = c;
      picked.push(cmd);
    }
    if (repo.warnedAt === null && !input.warning) return { status: 409, error: "Accept the warning first", task: taskDto(db, t) };
    const prefix = input.prefix ?? (branchPrefixesOf(settings.config())[0] as string);
    let sub: { parts: PlannedPart[]; maxOpen: number } | null = null;
    if (subtasks) {
      const a = approveSubtasks({
        t,
        plan: docs.parsed.parts,
        sub: subPlanOf(docs),
        rows: subtaskRows(db, id),
        input: input.subtasks,
        prefix,
        specDir: repo.specDir,
      });
      if (typeof a === "string") return conflict(db, t, a);
      if ("bad" in a) return { status: 400, error: a.bad };
      sub = a;
    }
    // A picked proposal gets the first free ID cmd<n>, so the IDs of the repository stay unique.
    const used = new Set(picked.filter((c) => !c.id.startsWith(NEW_COMMAND)).map((c) => c.id));
    let n = 1;
    const stored = picked.map((c) => {
      if (!c.id.startsWith(NEW_COMMAND)) return c;
      while (used.has(`cmd${n}`)) n++;
      used.add(`cmd${n}`);
      return { ...c, id: `cmd${n}` };
    });
    try {
      db.transaction(() => {
        const at = now();
        db.query(Q.approve).run({
          project: t.project,
          repo: t.repo,
          commands: JSON.stringify(stored),
          warned: at,
          base: t.target_branch,
          now: at,
        });
        for (const b of picks) {
          const r = rows.find((x) => x.id === b.taskRepo) as (typeof rows)[number];
          if (r.role !== "main") db.query(Q.lastBasePick).run({ project: r.project, repo: r.repo, base: b.branch, now: at });
        }
        // spec.md section 6.16: the branch prefix and the existing-branch pick go with the approval. Section 6.20.8: maxOpen too.
        const s: TaskSettings = {
          ...settingsOf(t),
          branchPrefix: prefix,
          existing: input.existing ?? "continue",
          ...(sub && { maxOpen: sub.maxOpen }),
        };
        const v = patch(db, id, t.version, { ...resized(t, docs, size, true), settings_json: JSON.stringify(s) }, at);
        const r = advance(db, { task: id, version: v }, { type: "APPROVE" }, {}, at);
        if (r.status !== 200) throw new Refused(r.error);
        if (sub) approveParts(db, { ...t, version: r.version }, sub.parts, at);
      })();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return conflict(db, t, e.message);
    }
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // POST /api/tasks/:id/plan-again (spec.md sections 6.12 and 6.20.4): the spec run writes the plan again. The text goes to
  // context/answers.md as one more answered question. The earlier answers stay.
  function planAgain(db: Database, id: number, input: TaskPlanAgainInput): TaskResult {
    if (input.add) {
      const t = taskRow(db, id);
      if (!t) return { status: 404, error: "Task not found." };
      // spec.md section 6.20.14: WP-ST7 adds the short plan run of the new keys. No code marks a key as new before it.
      return conflict(
        db,
        t,
        db.query(Q.addedSubtasks).get({ task: id }) ? "Claude cannot plan new sub-tasks yet." : "No sub-task is new in Jira.",
      );
    }
    const l = loadPlan(db, id, input.version);
    if ("status" in l) return l;
    const busy = review.busy();
    if (busy) return busyResult(busy);
    try {
      db.transaction(() => {
        const at = now();
        const round = (db.query(Q.lastRound).get({ task: id }) as { round: number }).round + 1;
        db.query(Q.againQuestion).run({ task: id, round, answer: JSON.stringify({ choice: null, text: input.text }), now: at });
        const fields: Patch = { docs_json: null, estimate_json: null, size: null, size_by: null, base_commit: null, blocked_json: null };
        patch(db, id, l.t.version, fields, at);
        const r = review.taskRun(db, specRun(db, taskRow(db, id) as TaskRow));
        if (r.status !== 202) throw new Refused(r.conflict.error, r.conflict);
      })();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return e.running ? busyResult(e.running) : conflict(db, l.t, e.message);
    }
    changed(id);
    return { status: 202, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // GET /api/tasks/:id/branch (spec.md section 6.16.4): the planned name, where it exists on the server, the open PR from it to the
  // base, and the first free suffix. A small task names its one branch. A larger one names its spec branch.
  async function branch(db: Database, id: number, input: { prefix?: string; base?: string }): Promise<BranchCheckDto | TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    const prefix = input.prefix ?? settingsOf(t).branchPrefix ?? (branchPrefixesOf(settings.config())[0] as string);
    const small = (t.size ?? docsOf(t)?.parsed.proposed ?? "small") === "small";
    const name = branchName(prefix, t.key, small ? { kind: "small", title: t.title } : { kind: "spec" });
    // The query comes before the remote read: a shutdown can close db while the read runs.
    const pr = db.query(Q.openPr).get({ project: t.project, repo: t.repo, branch: name, base: input.base ?? t.target_branch }) as {
      id: number;
    } | null;
    let heads: Map<string, string>;
    try {
      heads = await remoteBranches(review.dataDir, await review.taskRemote(t.project, t.repo), name);
    } catch (e) {
      if (e instanceof NoCloneLink) return { status: 409, error: e.message };
      return { status: 502, error: `Cannot read the branches of ${t.project}/${t.repo}. ${noUrl((e as Error).message)}` };
    }
    const head = heads.get(name);
    return {
      name,
      exists: head ? [{ taskRepo: null, project: t.project, repo: t.repo, head }] : [],
      openPr: pr?.id ?? null,
      nextFree: firstFree(name, new Set(heads.keys()), 2),
    };
  }

  // PUT /api/tasks/:id/base (spec.md section 6.16.3). Before the plan: the base changes. With a plan: the plan goes, and the spec run
  // writes it again on the new base head. The answers stay. taskRepo: a repository of the task with access edit other than the main
  // one; its pick goes to task_repo.base_branch.
  async function base(db: Database, id: number, input: { version: number; taskRepo?: number; branch: string }): Promise<TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== input.version) return conflict(db, t, TASK_CHANGED);
    if (t.state !== "interview" && t.state !== "spec_draft") return conflict(db, t, "The base branch changes only before the build.");
    if (db.query(Q.busy).get({ id })) return conflict(db, t, "Claude is still working on this task. Wait for the step to end.");
    const rows = taskRepos(db, t);
    const own = input.taskRepo === undefined || rows.find((r) => r.id === input.taskRepo)?.role === "main";
    const row = own ? null : rows.find((r) => r.id === input.taskRepo);
    if (row === undefined) return { status: 404, error: "Repository not found." };
    if (row && (row.access !== "edit" || !row.project || !row.repo))
      return conflict(db, t, `The task cannot change ${row.project && row.repo ? `${row.project}/${row.repo}` : row.path}.`);
    const project = row?.project ?? t.project;
    const repo = row?.repo ?? t.repo;
    if (input.branch === (row ? row.base_branch : t.target_branch)) return { status: 200, task: taskDto(db, t) };
    let found: boolean;
    try {
      found = (await remoteBranches(review.dataDir, await review.taskRemote(project, repo), input.branch)).has(input.branch);
    } catch (e) {
      if (e instanceof NoCloneLink) return { status: 409, error: e.message };
      return { status: 502, error: `Cannot read the branches of ${project}/${repo}. ${noUrl((e as Error).message)}` };
    }
    if (!found) return conflict(db, t, `${input.branch} does not exist in ${project}/${repo}.`);
    const rerun = t.state === "spec_draft";
    const busy = rerun ? review.busy() : null;
    if (busy) return busyResult(busy);
    try {
      db.transaction(() => {
        const cur = taskRow(db, id);
        if (!cur || cur.version !== input.version) throw new Refused(TASK_CHANGED);
        if (row) db.query(Q.repoBase).run({ id: row.id, base: input.branch });
        else saveMainRepo(db, cur, input.branch, null, now());
        if (!rerun) return patch(db, id, cur.version, row ? {} : { target_branch: input.branch }, now());
        const fields: Patch = {
          ...(!row && { target_branch: input.branch }),
          docs_json: null,
          estimate_json: null,
          size: null,
          size_by: null,
        };
        patch(db, id, cur.version, { ...fields, base_commit: null, blocked_json: null }, now());
        const r = review.taskRun(db, specRun(db, taskRow(db, id) as TaskRow));
        if (r.status !== 202) throw new Refused(r.conflict.error, r.conflict);
      })();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return e.running ? busyResult(e.running) : conflict(db, t, e.message);
    }
    changed(id);
    return { status: rerun ? 202 : 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // POST /api/tasks/:id/repos/:taskRepo (spec.md section 6.16.5, Proposals). Add takes the proposed repository into the task with its
  // preselected base branch, and the spec run writes the plan again with it. Skip keeps it out, and the next spec run lists it as
  // skipped.
  async function repoChoice(db: Database, id: number, taskRepo: number, input: { version: number; add: boolean }): Promise<TaskResult> {
    const l = loadPlan(db, id, input.version);
    if ("status" in l) return l;
    const row = db.query(Q.proposal).get({ id: taskRepo, task: id }) as {
      role: string;
      project: string | null;
      repo: string | null;
      proposal: string | null;
    } | null;
    if (!row) return { status: 404, error: "Repository not found." };
    if (row.role !== "added" || row.proposal !== "proposed" || !row.project || !row.repo)
      return conflict(db, l.t, "No proposal waits for this repository.");
    const { project, repo } = row;
    if (!input.add) {
      db.transaction(() => {
        db.query(Q.choose).run({ id: taskRepo, proposal: "skipped", access: "none", base: null });
        patch(db, id, l.t.version, {}, now());
      })();
      changed(id);
      return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
    }
    let base: string;
    try {
      const last = (db.query(Q.lastBase).get({ project, repo }) as { last_base: string | null } | null)?.last_base ?? null;
      base = await preselectBase({
        last,
        provider: await settings.provider(),
        project,
        repo,
        remoteHead: async () => remoteHead(review.dataDir, await review.taskRemote(project, repo)),
      });
    } catch (e) {
      if (e instanceof NoCloneLink) return { status: 409, error: e.message };
      return { status: 502, error: `Cannot read the branches of ${project}/${repo}. ${noUrl((e as Error).message)}` };
    }
    const busy = review.busy();
    if (busy) return busyResult(busy);
    try {
      db.transaction(() => {
        const cur = taskRow(db, id);
        if (!cur || cur.version !== input.version || cur.state !== "spec_draft") throw new Refused(TASK_CHANGED);
        db.query(Q.choose).run({ id: taskRepo, proposal: "added", access: "edit", base });
        const fields: Patch = { docs_json: null, estimate_json: null, size: null, size_by: null, base_commit: null, blocked_json: null };
        patch(db, id, cur.version, fields, now());
        const r = review.taskRun(db, specRun(db, taskRow(db, id) as TaskRow));
        if (r.status !== 202) throw new Refused(r.conflict.error, r.conflict);
      })();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return e.running ? busyResult(e.running) : conflict(db, l.t, e.message);
    }
    changed(id);
    return { status: 202, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // POST /api/tasks/:id/resume of a task that stopped before its build (spec.md section 6.2): the state before the stop, then the run
  // that the stop ended. An interview with open questions waits for the answers again. loop.ts resumes a build.
  function resume(db: Database, id: number, input: { version: number }): TaskResult {
    const t = load(db, id, input.version, "stopped");
    if ("status" in t) return t;
    const from = t.stopped_from;
    const open = from === "interview" ? openQuestions(db, id) : [];
    const rerun = (from === "interview" && !open.length) || (from === "spec_draft" && docsOf(t) === null);
    const busy = rerun ? review.busy() : null;
    if (busy) return busyResult(busy);
    try {
      db.transaction(() => {
        const at = now();
        const r = advance(db, { task: id, version: t.version }, { type: "RESUME" }, {}, at);
        if (r.status !== 200) throw new Refused(r.error);
        const n = open.length;
        const step = (open[0] as (QuestionRow & { step: number | null }) | undefined)?.step ?? null;
        const text = `Claude has ${n} ${n === 1 ? "question" : "questions"} before it writes the plan.`;
        patch(db, id, r.version, { blocked_json: n ? blocked({ kind: "question", step, text }) : null }, at);
        if (!rerun) return;
        const cur = taskRow(db, id) as TaskRow;
        const s = review.taskRun(
          db,
          r.state === "interview" ? interviewRun(db, cur, (interviewOf(db, id)?.round ?? 0) + 1) : specRun(db, cur),
        );
        if (s.status !== 202) throw new Refused(s.conflict.error, s.conflict);
      })();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return e.running ? busyResult(e.running) : conflict(db, t, e.message);
    }
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // POST /api/tasks/:id/close (spec.md section 6.12): a stopped, ready, or done task ends. Its branches and PRs stay as they are.
  function close(db: Database, id: number, input: { version: number }): TaskResult {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== input.version) return conflict(db, t, TASK_CHANGED);
    if (db.query(Q.busy).get({ id })) return conflict(db, t, "Claude is still working on this task. Stop it first.");
    const error = db.transaction((): string | null => {
      const at = now();
      const r = advance(db, { task: id, version: t.version }, { type: "CLOSE" }, {}, at);
      if (r.status !== 200) return "state" in r && r.state === "implementing" ? "Stop the build first, then close the task." : r.error;
      patch(db, id, r.version, { blocked_json: null }, at);
      db.query("UPDATE task SET closed_at = COALESCE(closed_at, $now) WHERE id = $id").run({ id, now: at });
      return null;
    })();
    if (error) return conflict(db, t, error);
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // spec.md section 6.20.9: the time of the last status read of each task, a failed one too. The sync and the Task view share it.
  const statusReads = new WeakMap<Database, Map<number, number>>();

  // One GET of the parent gives the status of every sub-task. A failed read keeps the stored statuses. maxAge: the minimum time since the
  // last read. Returns true when a status changed. Keys that are new or gone in Jira are left to "Add to plan" (section 6.20.14).
  async function readStatuses(db: Database, id: number, maxAge: number): Promise<boolean> {
    const t = taskRow(db, id);
    if (t?.subtasks !== 1 || t.state === "done" || t.state === "failed") return false;
    const reads = statusReads.get(db) ?? new Map<number, number>();
    statusReads.set(db, reads);
    const last = reads.get(id);
    if (last !== undefined && now() - last < maxAge) return false;
    reads.set(id, now());
    const source = await jira();
    if ("status" in source) return false;
    let list: IssueSubtask[];
    try {
      list = await source.subtaskStatuses(t.key);
    } catch (e) {
      if (!(e instanceof ContextError)) throw e;
      log(`Jira status read for task ${id} failed: ${e.message}`);
      return false;
    }
    const at = now();
    return db.transaction(() => {
      const rows = new Map(subtaskRows(db, id).map((r) => [r.key, r]));
      let moved = false;
      for (const s of list) {
        const r = rows.get(s.key);
        if (!r) continue;
        moved ||= r.status !== s.status || r.category !== s.category;
        db.query(Q.subtaskStatus).run({ task: id, key: s.key, status: s.status, category: s.category, at });
      }
      return moved;
    })();
  }

  // spec.md section 6.20.11: the status read of the sync, at most every JIRA_STATUS_AGE_MS per open task with sub-tasks. It never
  // writes to Jira. Returns the IDs of the tasks with a changed status.
  async function syncStatuses(db: Database): Promise<number[]> {
    const moved: number[] = [];
    for (const { id } of db.query(Q.subtaskTasks).all() as { id: number }[])
      if (await readStatuses(db, id, JIRA_STATUS_AGE_MS)) {
        moved.push(id);
        changed(id);
      }
    return moved;
  }

  // POST /api/tasks/:id/jira-check (spec.md section 6.20.12): the status read of the Task view, at most once per JIRA_VIEW_AGE_MS.
  async function jiraCheck(db: Database, id: number): Promise<TaskResult> {
    if (!taskRow(db, id)) return { status: 404, error: "Task not found." };
    if (await readStatuses(db, id, JIRA_VIEW_AGE_MS)) changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // The stored issue of the task: the task_context row of its origin PR, else task.issue_json (taskIssue reads the same place).
  function saveIssue(db: Database, t: TaskRow, issue: IssueContext, at: number) {
    if (t.origin_pr !== null) db.query(Q.storeContext).run({ pr: t.origin_pr, key: t.key, json: JSON.stringify(issue), at });
    else db.query(Q.setIssue).run({ id: t.id, issue: JSON.stringify(issue) });
  }

  // POST /api/tasks/:id/jira-read (spec.md section 6.20.12), "Read Jira again": the texts, links, and statuses of the parent and of its
  // sub-tasks. Only reads go to Jira.
  async function jiraRead(db: Database, id: number, input: { version: number }): Promise<TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== input.version) return conflict(db, t, TASK_CHANGED);
    const got = await fetchIssue(t.key);
    if ("status" in got) return got;
    let subs: { sub: IssueSubtask; issue: IssueContext | null }[] = [];
    if (t.subtasks === 1) {
      const r = await readSubtasks(t.key, got.issue.subtasks ?? []);
      if ("status" in r) return r;
      subs = r.subs;
    }
    const at = now();
    db.transaction(() => {
      const cur = taskRow(db, id);
      if (!cur) return;
      saveIssue(db, cur, got.issue, at);
      for (const { sub, issue } of subs)
        db.query(Q.subtaskRead).run({
          task: id,
          key: sub.key,
          summary: issue?.summary ?? sub.summary,
          status: issue?.status ?? sub.status,
          category: sub.category,
          issue: issue ? JSON.stringify(issue) : null,
          links: issue ? JSON.stringify(issue.links ?? []) : null,
          at,
        });
    })();
    if (t.subtasks === 1) statusReads.get(db)?.set(id, at);
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // The key of a Jira route must be the parent or a sub-task of the task.
  function jiraKeyOf(db: Database, id: number, key: string): TaskRow | TaskResult {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (key !== t.key && !subtaskRows(db, id).some((r) => r.key === key))
      return { status: 404, error: `${key} is not ${t.key} or a sub-task of it.` };
    return t;
  }

  async function listTransitions(source: ContextSource, key: string): Promise<{ transitions: JiraTransition[] } | TaskResult> {
    try {
      return { transitions: await source.transitions(key) };
    } catch (e) {
      if (!(e instanceof ContextError)) throw e;
      log(`Jira transitions read failed: ${e.message}`);
      return { status: 502, error: JIRA_FAILED[e.kind] };
    }
  }

  // GET /api/tasks/:id/jira/:key/transitions (spec.md section 6.20.12): the "Move in Jira" click. A read only.
  async function jiraTransitions(db: Database, id: number, key: string): Promise<{ transitions: JiraTransition[] } | TaskResult> {
    const t = jiraKeyOf(db, id, key);
    if ("status" in t) return t;
    const source = await jira();
    return "status" in source ? source : listTransitions(source, key);
  }

  // POST /api/tasks/:id/jira/:key/transitions (spec.md section 6.20.9): the only Jira write, one POST after the user confirmed the dialog.
  // The list read before it gives the new status and refuses a move that Jira no longer offers. No retry: a second POST can move twice.
  async function jiraMove(
    db: Database,
    id: number,
    key: string,
    transition: string,
  ): Promise<{ to: string | null; task: TaskDto } | TaskResult> {
    const t = jiraKeyOf(db, id, key);
    if ("status" in t) return t;
    const source = await jira();
    if ("status" in source) return source;
    const list = await listTransitions(source, key);
    if ("status" in list) return list;
    const move = list.transitions.find((x) => x.id === transition);
    if (!move) return { status: 409, error: `Jira does not offer this move for ${key} now. Open the list again.` };
    try {
      await source.transition(key, transition);
    } catch (e) {
      if (e instanceof JiraRefusedError) return { status: 502, error: e.message };
      if (!(e instanceof ContextError)) throw e;
      log(`Jira move failed: ${e.message}`);
      return { status: 502, error: `${JIRA_FAILED[e.kind]} Check ${key} in Jira.` };
    }
    if (key === t.key) {
      const stored = taskIssue(db, t)?.issue;
      if (stored) saveIssue(db, t, { ...stored, status: move.to ?? stored.status }, now());
    } else await readStatuses(db, id, 0);
    changed(id);
    return { to: move.to, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  return {
    syncStatuses,
    jiraCheck,
    jiraRead,
    jiraTransitions,
    jiraMove,
    create,
    issue,
    file,
    answers,
    size,
    docs,
    plan,
    planAgain,
    branch,
    base,
    repoChoice,
    resume,
    close,
    writableList,
    get(db: Database, id: number): TaskDto | null {
      const t = taskRow(db, id);
      return t && taskDto(db, t);
    },
    list(db: Database, state: "open" | "all"): TaskRowDto[] {
      return (db.query(Q.list).all({ all: state === "all" ? 1 : 0 }) as TaskRow[]).map((t) => rowDto(db, t));
    },
  };
}
