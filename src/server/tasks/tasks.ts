// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The state writes of a task (docs/plans/review-v2/spec.md section 6.2). No other code writes task.state or task_part.state.
// Each write runs in a transaction, and a caller transaction makes it a savepoint: the caller writes its step row in the same commit.
// The caller runs every effect (a run start, a push, a notification) after the commit, from the new state.
import type { Database } from "bun:sqlite";
import { initialTransition, transition } from "xstate";
import type { z } from "zod";
import { oneLine } from "../../shared/consult";
import type {
  BranchCheckDto,
  IssueContext,
  RepoTaskSettingsDto,
  RepoTaskSettingsInput,
  RunConflict,
  RunUsage,
  TaskAnswersInput,
  TaskCreateInput,
  TaskDto,
  TaskInterviewDto,
  TaskPartDto,
  TaskPlanDto,
  TaskPlanInput,
  TaskPointDto,
  TaskQuestionDto,
  TaskRowDto,
  TaskStepDto,
  taskDocInput,
  taskSizeInput,
} from "../../shared/dto";
import type { FindingPayload } from "../../shared/review";
import {
  branchName,
  INTERVIEW_QUESTIONS,
  INTERVIEW_TURNS,
  type InterviewResult,
  interviewJsonSchema,
  interviewResult,
  MORE_TIME_MIN,
  PART_STATE_TEXT,
  PART_TIME_MIN,
  type PartState,
  type SizeSource,
  SPEC_TURNS,
  specJsonSchema,
  specResult,
  stepDetail,
  stepStrip,
  TASK_DEFAULTS,
  TASK_DOCS,
  TASK_STATE_TEXT,
  type TaskBlocked,
  type TaskCommand,
  type TaskSettings,
  type TaskSize,
  type TaskState,
  taskBlocked,
  taskSettings,
} from "../../shared/task";
import { NoCloneLink } from "../bitbucket/errors";
import type { ForgeProvider } from "../bitbucket/provider";
import { FAILED as JIRA_FAILED } from "../context/routes";
import { ContextError, type ContextSource } from "../context/source";
import { issueFile, taskContext } from "../context/task-file";
import type { Live } from "../live";
import { log } from "../log";
import { DEFAULT_PROFILE, interviewAgent, profileOf, specAgent } from "../review/catalog";
import { gitEnv } from "../review/git";
import type { ReviewJobs, TaskRunStart } from "../review/jobs";
import { type Ending, judgeTask } from "../review/judge";
import { buildInterviewPrompt, buildSpecPrompt } from "../review/prompt";
import { type ContextFile, noUrl, remoteHead } from "../review/workspace";
import { branchPrefixesOf, type Settings } from "../settings";
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
  convertDocs,
  type Docs,
  docNames,
  largeRepoProblem,
  NEW_COMMAND,
  type Plan,
  parsePlan,
  parseTasks,
  renderDocs,
  sizeFloor,
  toPlan,
} from "./plan";
import { type RepoDeps, repoDtos, resolveTaskRepos, saveMainRepo } from "./repos";
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
};

const Q = {
  row: "SELECT * FROM task WHERE id = $id",
  open: "SELECT * FROM task WHERE project = $project AND repo = $repo AND key = $key AND state NOT IN ('done', 'failed')",
  list: "SELECT * FROM task WHERE $all OR state NOT IN ('done', 'failed') ORDER BY updated_at DESC, id DESC LIMIT 200",
  insert: `INSERT INTO task (project, repo, key, title, origin_pr, state, target_branch, spec_dir, issue_json, created_at, updated_at)
    VALUES ($project, $repo, $key, $title, $origin, $state, $target, $spec_dir, $issue, $now, $now) RETURNING id`,
  pr: "SELECT id, project, repo, target_branch FROM pull_request WHERE id = $id",
  prTask: "SELECT 1 FROM pr_task WHERE pr = $pr AND key = $key",
  context: "SELECT json FROM task_context WHERE pr = $pr AND key = $key",
  storeContext: `INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', $json, $at)
    ON CONFLICT (pr, key) DO UPDATE SET source = excluded.source, json = excluded.json, fetched_at = excluded.fetched_at`,
  parts: "SELECT * FROM task_part WHERE task = $id ORDER BY ord",
  partPr: "SELECT state, reviewers_json FROM pull_request WHERE id = $id",
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

// spec.md section 6.9, Reviewers: the reviewers of the task settings, else the reviewers of your newest PR in this repository.
function defaultReviewers(db: Database, t: TaskRow): string[] {
  const own = settingsOf(t).reviewers;
  if (own) return own;
  const r = db
    .query(
      `SELECT reviewers_json FROM pull_request WHERE project = $project AND repo = $repo AND my_role = 'AUTHOR'
        AND reviewers_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
    )
    .get({ project: t.project, repo: t.repo }) as { reviewers_json: string } | null;
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

type PartRow = {
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
  usage_json: string | null;
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

function planDto(db: Database, t: TaskRow, docs: Docs): TaskPlanDto {
  const repo = repoSettings(db, t.project, t.repo);
  const budget = settingsOf(t).lineBudget ?? repo.lineBudget;
  const floor = sizeFloor(docs.parsed.estimate, budget);
  return {
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

export function taskDto(db: Database, t: TaskRow): TaskDto {
  const parts = (db.query(Q.parts).all({ id: t.id }) as PartRow[]).map((p): TaskPartDto => {
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
    };
  });
  const docs = docsOf(t);
  return {
    ...rowDto(db, t),
    originPr: t.origin_pr,
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
    steps: (db.query(Q.steps).all({ id: t.id }) as StepRow[]).map((s) => ({
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
    })),
    createdAt: t.created_at,
    interview: interviewOf(db, t.id),
    plan: docs ? planDto(db, t, docs) : null,
    strip: stepStrip({ size: t.size, state: t.state, stoppedFrom: t.stopped_from, parts }),
    reviewers: defaultReviewers(db, t),
    points: openPoints(db, t.id).map(({ payload: _, ...p }) => p),
    // The routes set it from the loop.
    working: false,
  };
}

export type TaskResult =
  | { status: 200 | 201 | 202; task: TaskDto }
  | { status: 400 | 404 | 502; error: string }
  | { status: 422; error: string; line: number }
  | { status: 409; error: string; task?: TaskDto; running?: RunConflict["running"] };

// task.md of a task: the one task of its origin PR with its attachments, else the fetched issue with its attachments listed.
export function taskFilesOf(db: Database, dataDir: string, t: TaskRow) {
  if (t.origin_pr !== null) return taskContext(db, t.origin_pr, dataDir, t.key);
  if (t.issue_json === null) return { files: [], attachments: [] };
  return { files: [issueFile(t.key, JSON.parse(t.issue_json) as IssueContext, t.created_at)], attachments: [] };
}

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
  const profile = () => profileOf(settings.profiles(), DEFAULT_PROFILE);
  const taskFiles = (db: Database, t: TaskRow) => taskFilesOf(db, review.dataDir, t);
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

  // The effect after a run end: the next run of the task. A refused start stops the task with the reason.
  function startNext(db: Database, id: number, next: (t: TaskRow) => TaskRunStart) {
    return () => {
      const t = taskRow(db, id);
      if (!t) return;
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
    const p = profile();
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
      agent: interviewAgent(p, round),
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
        return startNext(d, t.id, (x) => specRun(d, x));
      },
    };
  }

  function specRun(db: Database, t: TaskRow): TaskRunStart {
    const p = profile();
    const budget = budgetOf(db, t);
    const { files, attachments } = taskFiles(db, t);
    const answers = answersFile(interviewRows(db, t.id), interviewOf(db, t.id));
    let plan: Plan | null = null;
    return {
      task: t.id,
      kind: "spec",
      key: `task:${t.id}:spec`,
      repos: repos(t),
      project: t.project,
      repo: t.repo,
      branch: t.target_branch,
      profile: p,
      files,
      attachments,
      own: answers ? [answers] : [],
      maxTurns: SPEC_TURNS,
      schema: specJsonSchema(),
      agent: specAgent(p, budget),
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
          const missing = await checkMap(r.map, base, ws.cache, gitEnv("/dev/null"));
          const skipped = r.map.flatMap((e, i) =>
            missing[i]
              ? [`Map line ${i + 1}: ${oneLine(e.path)}${e.line === null ? "" : `:${e.line}`} is not found at ${base.slice(0, 12)}.`]
              : [],
          );
          plan = toPlan(r, base, missing, skipped);
          return { result: r, skipped };
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
        const size = atLeast(plan.proposed, sizeFloor(plan.estimate, budgetOf(d, cur)).minimum);
        const docs: Docs = {
          ...renderDocs(cur.key, cur.title, size, plan),
          version: (docsOf(cur)?.version ?? 0) + 1,
          parsed: plan,
          approved: false,
        };
        patch(
          d,
          t.id,
          cur.version,
          {
            docs_json: JSON.stringify(docs),
            estimate_json: JSON.stringify(plan.estimate),
            size,
            size_by: size === plan.proposed ? "claude" : "rule",
            base_commit: run.head,
            blocked_json: null,
          },
          now(),
        );
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
    const busy = review.busy();
    if (busy) return busyResult(busy);
    // The task text: the fetched text of the origin PR, else one Jira fetch on this click (BRIEF 3.6, decision Q4).
    const stored = pr ? (db.query(Q.context).get({ pr: pr.id, key: input.key }) as { json: string } | null) : null;
    let issue: IssueContext;
    if (stored) issue = JSON.parse(stored.json) as IssueContext;
    else {
      let source: ContextSource | null;
      try {
        source = await settings.jira();
      } catch {
        return { status: 502, error: "Cannot read the Jira CA file." };
      }
      if (!source) return { status: 409, error: "Set up Jira in Settings first." };
      try {
        issue = await source.fetchIssue(input.key);
      } catch (e) {
        if (!(e instanceof ContextError)) throw e;
        log(`Jira fetch for a task failed: ${e.message}`);
        return { status: 502, error: JIRA_FAILED[e.kind] };
      }
    }
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
    const fetchedAt = now();
    let id: number;
    let status: 200 | 201 = 201;
    try {
      id = db.transaction(() => {
        const again = open();
        if (again) {
          status = 200;
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
          now: fetchedAt,
        }) as { id: number };
        saveMainRepo(db, { id: row.id, project: input.project, repo: input.repo }, branch, null, fetchedAt);
        const r = review.taskRun(db, interviewRun(db, taskRow(db, row.id) as TaskRow, 1));
        if (r.status !== 202) throw new Refused(r.conflict.error, r.conflict);
        return row.id;
      })();
    } catch (e) {
      if (e instanceof Refused && e.running) return busyResult(e.running);
      throw e;
    }
    changed(id, pr && !stored ? pr.id : undefined);
    return { status, task: taskDto(db, taskRow(db, id) as TaskRow) };
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
    const problem = sizeProblem(db, t, docs, input.size) ?? largeRepoProblem(input.size, docs.parsed.parts, repoDtos(db, t));
    if (problem) return conflict(db, t, problem);
    const repo = repoSettings(db, t.project, t.repo);
    const offered = commandsOf(docs.parsed, repo.commands);
    if (new Set(input.commands).size !== input.commands.length) return { status: 400, error: "Each command is picked once." };
    const picked: TaskCommand[] = [];
    for (const cid of input.commands) {
      const c = offered.find((x) => x.id === cid);
      if (!c) return { status: 400, error: `Command ${cid} is not in the plan.` };
      const { saved: _, ...cmd } = c;
      picked.push(cmd);
    }
    if (repo.warnedAt === null && !input.warning) return { status: 409, error: "Accept the warning first", task: taskDto(db, t) };
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
        // spec.md section 6.16: the branch prefix and the existing-branch pick go with the approval.
        const s: TaskSettings = {
          ...settingsOf(t),
          branchPrefix: input.prefix ?? (branchPrefixesOf(settings.config())[0] as string),
          existing: input.existing ?? "continue",
        };
        const v = patch(db, id, t.version, { ...resized(t, docs, input.size, true), settings_json: JSON.stringify(s) }, at);
        const r = advance(db, { task: id, version: v }, { type: "APPROVE" }, {}, at);
        if (r.status !== 200) throw new Refused(r.error);
      })();
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return conflict(db, t, e.message);
    }
    changed(id);
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // GET /api/tasks/:id/branch (spec.md section 6.16.4): the planned name, where it exists on the server, the open PR from it to the
  // base, and the first free suffix. A small task names its one branch. A larger one names its spec branch.
  async function branch(db: Database, id: number, input: { prefix?: string; base?: string }): Promise<BranchCheckDto | TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    const prefix = input.prefix ?? settingsOf(t).branchPrefix ?? (branchPrefixesOf(settings.config())[0] as string);
    const small = (t.size ?? docsOf(t)?.parsed.proposed ?? "small") === "small";
    const name = branchName(prefix, t.key, small ? { kind: "small", title: t.title } : { kind: "spec" });
    let heads: Map<string, string>;
    try {
      heads = await remoteBranches(review.dataDir, await review.taskRemote(t.project, t.repo), name);
    } catch (e) {
      if (e instanceof NoCloneLink) return { status: 409, error: e.message };
      return { status: 502, error: `Cannot read the branches of ${t.project}/${t.repo}. ${noUrl((e as Error).message)}` };
    }
    const head = heads.get(name);
    const pr = db.query(Q.openPr).get({ project: t.project, repo: t.repo, branch: name, base: input.base ?? t.target_branch }) as {
      id: number;
    } | null;
    return {
      name,
      exists: head ? [{ taskRepo: null, project: t.project, repo: t.repo, head }] : [],
      openPr: pr?.id ?? null,
      nextFree: firstFree(name, new Set(heads.keys()), 2),
    };
  }

  // PUT /api/tasks/:id/base (spec.md section 6.16.3). Before the plan: the base changes. With a plan: the plan goes, and the spec run
  // writes it again on the new base head. The answers stay.
  async function base(db: Database, id: number, input: { version: number; branch: string }): Promise<TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== input.version) return conflict(db, t, TASK_CHANGED);
    if (t.state !== "interview" && t.state !== "spec_draft") return conflict(db, t, "The base branch changes only before the build.");
    if (db.query(Q.busy).get({ id })) return conflict(db, t, "Claude is still working on this task. Wait for the step to end.");
    if (input.branch === t.target_branch) return { status: 200, task: taskDto(db, t) };
    let found: boolean;
    try {
      found = (await remoteBranches(review.dataDir, await review.taskRemote(t.project, t.repo), input.branch)).has(input.branch);
    } catch (e) {
      if (e instanceof NoCloneLink) return { status: 409, error: e.message };
      return { status: 502, error: `Cannot read the branches of ${t.project}/${t.repo}. ${noUrl((e as Error).message)}` };
    }
    if (!found) return conflict(db, t, `${input.branch} does not exist in ${t.project}/${t.repo}.`);
    const rerun = t.state === "spec_draft";
    const busy = rerun ? review.busy() : null;
    if (busy) return busyResult(busy);
    try {
      db.transaction(() => {
        const cur = taskRow(db, id);
        if (!cur || cur.version !== input.version) throw new Refused(TASK_CHANGED);
        saveMainRepo(db, cur, input.branch, null, now());
        if (!rerun) return patch(db, id, cur.version, { target_branch: input.branch }, now());
        const fields: Patch = { target_branch: input.branch, docs_json: null, estimate_json: null, size: null, size_by: null };
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

  return {
    create,
    answers,
    size,
    docs,
    plan,
    branch,
    base,
    resume,
    close,
    get(db: Database, id: number): TaskDto | null {
      const t = taskRow(db, id);
      return t && taskDto(db, t);
    },
    list(db: Database, state: "open" | "all"): TaskRowDto[] {
      return (db.query(Q.list).all({ all: state === "all" ? 1 : 0 }) as TaskRow[]).map((t) => rowDto(db, t));
    },
  };
}
