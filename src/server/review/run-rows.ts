// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The stored form of review runs and items (jobs.ts): the rows, the SQL, and the DTOs that the routes send.
import type { Database } from "bun:sqlite";
import type { ConsultGroup, SessionMode } from "../../shared/consult";
import type { DiffRowDto, FixEditDto, ReviewItemDto, RunDto, RunKind, RunSummary, RunUsage } from "../../shared/dto";
import type { AnchoredFinding, Question, ReplyPayload } from "../../shared/review";
import type { RunErrorKind, RunStatus } from "../../shared/run-log";
import type { Comment, ExcerptLine, PullRequest } from "../../shared/types";
import { FORMER_NAMES } from "./catalog";
import { runEffort } from "./defaults";

export type PrRow = {
  id: number;
  project: string;
  repo: string;
  pr_id: number;
  title: string | null;
  description: string | null;
  author_slug: string | null;
  author_name: string | null;
  my_role: string | null;
  state: string | null;
  pr_version: number | null;
  source_head: string | null;
  target_head: string | null;
  source_branch: string | null;
  target_branch: string | null;
  web_url: string | null;
  updated_date: number | null;
};

export type Heads = PrRow & { source_head: string; target_head: string };

export type RunRow = {
  id: number;
  pr: number;
  kind: RunDto["kind"];
  profile: string;
  // null for runs made before M4.
  profile_name: string | null;
  explain: number | null;
  note: string;
  source_head: string;
  target_head: string;
  merge_base: string | null;
  fetch_via: RunDto["via"];
  status: RunStatus;
  error_kind: RunErrorKind | null;
  error_text: string | null;
  session_id: string | null;
  cli_version: string | null;
  model: string | null;
  effort: string | null;
  effort_default: string | null;
  usage_json: string | null;
  summary_json: string | null;
  has_raw: number;
  started_at: number;
  finished_at: number | null;
  pr_source: string | null;
  pr_target: string | null;
  since_head: string | null;
  range_base: string | null;
  question: string | null;
  answer: string | null;
  // A fix run only: the thread notes.
  fix_json: string | null;
  // null for runs made before Release 3.
  tasks_json: string | null;
  // null for runs made before project instructions.
  instructions_json: string | null;
  // null for runs made before the run skills were stored.
  skills_json: string | null;
  // A session run only: SessionRecord.
  consult_json: string | null;
  // An ask run only: the ask run that it follows (docs/plans/review-v2/spec.md section 2.15).
  parent_run: number | null;
  findings: number;
};

// docs/plans/session-consult.md part C. path: the transcript; it stays on the server and out of the database. prompt: the text of
// part A with SESSION_RULES. snapshot: the item keys of the text at the start, for the change check of the preview.
// Part D: mode fix also proposes edits. asked: the IDs of the items in the text that need a verdict. tag: the tag suffix of prompt.
export type SessionStart = {
  path: string;
  id: string;
  title: string | null;
  bytes: number;
  prompt: string;
  tag: string;
  snapshot: Record<string, string>;
  groups: ConsultGroup[];
  items: number;
  textBytes: number;
  mode: SessionMode;
  asked: string[];
};
// consult_json of a session run. No transcript text. mode: absent before part D. A fix run that an import made from the proposal of a
// session run (consult.ts) holds a copy with run: the session run, and paste: the consult run of the import.
export type SessionRecord = Omit<SessionStart, "path" | "prompt" | "tag" | "id" | "asked" | "mode"> & {
  session: string;
  tokens: number;
  mode?: SessionMode;
  run?: number;
  paste?: number;
};

export type ItemRow = {
  id: number;
  run: number;
  kind: ReviewItemDto["kind"];
  payload_json: string;
  body: string;
  path: string | null;
  side: "new" | "old" | null;
  line: number | null;
  line_end: number | null;
  anchor_state: AnchoredFinding["anchor"]["state"] | null;
  excerpt_json: string | null;
  status: ReviewItemDto["status"];
  revision: number;
  edited: number;
  // Reply items only: the root comment ID.
  thread: number | null;
  // RUN_COLS. A reply DTO gets drafted only from a row that selects them.
  run_kind?: RunKind;
  run_started?: number;
  run_finished?: number | null;
  run_head?: string;
};
export type NewItem = Omit<ItemRow, "id" | "run" | "revision" | "run_kind" | "run_started" | "run_finished" | "run_head">;
// The run of an item row, joined as r. Every SQL that builds a reply DTO selects them, because the client replaces its cached
// item with the DTO of an item action.
export const RUN_COLS = "r.kind AS run_kind, r.started_at AS run_started, r.finished_at AS run_finished, r.source_head AS run_head";

// A finding of a fix run (SQL.fixFinding).
export type FindingRow = ItemRow & { run_pr: number; run_head: string; run_base: string | null; copy: number | null };

export const NO_ANCHOR = { path: null, side: null, line: null, line_end: null, anchor_state: null, excerpt_json: null } as const;

// docs/plans/review-v2/spec.md section 2.2: a revision of a finding (payload revises) is no finding of its own. The item is joined as i.
export const NOT_REVISION = "json_extract(i.payload_json, '$.revises') IS NULL";
// The open findings of review_run r. RunDto.findings and the run notifications count them.
export const OPEN_FINDINGS = `(SELECT COUNT(*) FROM review_item i WHERE i.run = r.id AND i.kind = 'finding'
        AND COALESCE(json_extract(i.payload_json, '$.carried.verdict'), 'open') = 'open'
        AND COALESCE(json_extract(i.payload_json, '$.discardedBy'), '') <> 'verify' AND ${NOT_REVISION})`;

export const SQL = {
  pr: `SELECT id, project, repo, pr_id, title, description, author_slug, author_name, my_role, state, pr_version, source_head, target_head, source_branch,
      target_branch, web_url, updated_date FROM pull_request WHERE id = $id`,
  comments: `SELECT comment_id, version, parent_id, root_id, author_slug, author_name, author_login, text, anchor_json, thread_resolved, created_at,
      updated_at, excerpt_json, severity, task_state FROM comment WHERE pr = $pr AND tombstoned_at IS NULL`,
  tasks: "SELECT key, source, url FROM pr_task WHERE pr = $pr ORDER BY ord",
  brief: "SELECT note, profile, updated_at FROM pr_brief WHERE pr = $pr",
  saveBrief: `INSERT INTO pr_brief (pr, note, profile, updated_at) VALUES ($pr, $note, $profile, $now)
    ON CONFLICT (pr) DO UPDATE SET note = excluded.note, profile = excluded.profile, updated_at = excluded.updated_at`,
  // model: the --model value until the init event gives the model that ran.
  // item: the finding of a discuss run (docs/plans/review-v2/spec.md section 2.2).
  insert: `INSERT INTO review_run (pr, kind, profile, profile_name, profile_revision, explain, note, idem_key, source_head, target_head, status, started_at,
      since_head, question, tasks_json, model, effort, effort_default, prompt_version, parent_run, item)
    VALUES ($pr, $kind, $profile, $profile_name, $profile_revision, $explain, $note, $key, $source, $target, 'running', $now, $since, $question, $tasks,
      $model, $effort, $effort_default, $prompt_version, $parent, $item)
    RETURNING id`,
  // Plan r3 Feature C: the fetched tasks at the start of a run, in the order of task.md.
  fetched: "SELECT key, fetched_at AS fetchedAt FROM task_context WHERE pr = $pr ORDER BY key",
  run: `SELECT r.id, r.pr, r.kind, r.profile, r.profile_name, r.explain, r.note, r.source_head, r.target_head, r.merge_base, r.fetch_via, r.status, r.error_kind, r.error_text,
      r.session_id, r.cli_version, r.model, r.effort, r.effort_default, r.usage_json, r.summary_json, r.raw_output IS NOT NULL AS has_raw, r.started_at, r.finished_at,
      p.source_head AS pr_source, p.target_head AS pr_target, r.since_head, r.range_base, r.question, r.answer, r.fix_json, r.tasks_json, r.instructions_json, r.skills_json,
      r.consult_json, r.parent_run,
      ${OPEN_FINDINGS} AS findings
    FROM review_run r JOIN pull_request p ON p.id = r.pr`,
  workspace: "UPDATE review_run SET merge_base = $base, range_base = $range, fetch_via = $via WHERE id = $id",
  instructions: "UPDATE review_run SET instructions_json = $json WHERE id = $id",
  skills: "UPDATE review_run SET skills_json = $json WHERE id = $id",
  end: `UPDATE review_run SET status = $status, error_kind = $kind, error_text = $text, session_id = $session, cli_version = $cli, model = COALESCE($model, model),
      effort_default = CASE WHEN $init_effort THEN $effort_default ELSE effort_default END, usage_json = $usage, summary_json = $summary, answer = $answer, fix_json = $fix,
      explain_json = $explain, raw_output = $raw, finished_at = $now
    WHERE id = $id AND status = 'running'`,
  fixEdit: `INSERT INTO fix_edit (run, ord, thread, item, path, old, new, start, rows_json)
    VALUES ($run, $ord, $thread, $item, $path, $old, $new, $start, $rows)`,
  fixEdits: "SELECT id, thread, item, path, rows_json FROM fix_edit WHERE run = $run ORDER BY ord",
  // A finding of a fix run with the heads of its run. copy: the newest re-review copy of the finding.
  fixFinding: `SELECT i.*, r.pr AS run_pr, r.source_head AS run_head, r.merge_base AS run_base,
      (SELECT MAX(c.id) FROM review_item c WHERE c.kind = 'finding' AND json_extract(c.payload_json, '$.carried.from') = i.id) AS copy
    FROM review_item i JOIN review_run r ON r.id = i.run WHERE i.id = $id`,
  fixCommits: "SELECT c.*, p.pr_id FROM fix_commit c JOIN pull_request p ON p.id = c.pr WHERE c.run = $run ORDER BY c.id",
  fixes: "WHERE r.pr = $pr AND r.kind = 'fix' ORDER BY r.id DESC LIMIT 10",
  // A run that was running at the last stop has no process now.
  recover: `UPDATE review_run SET status = 'failed', error_kind = 'restart', error_text = $text, raw_output = COALESCE(raw_output, $text),
      finished_at = $now WHERE status = 'running'`,
  event: `INSERT INTO run_event (run, id, seq, parent, tool, target, status, note, agent, model, tokens, builtin, started_at, ended_at)
    VALUES ($run, $id, $seq, $parent, $tool, $target, $status, $note, $agent, $model, $tokens, $builtin, $started, $ended)
    ON CONFLICT (run, id) DO UPDATE SET status = excluded.status, note = excluded.note, agent = excluded.agent, model = excluded.model,
      tokens = excluded.tokens, ended_at = excluded.ended_at`,
  events: `SELECT id, seq, parent, tool, target, status, note, agent, model, tokens, builtin, started_at AS startedAt, ended_at AS endedAt
    FROM run_event WHERE run = $run ORDER BY seq`,
  item: `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, anchor_state, excerpt_json, status, thread, edited)
    VALUES ($run, $kind, $payload_json, $body, $path, $side, $line, $line_end, $anchor_state, $excerpt_json, $status, $thread, $edited)`,
  // docs/plans/review-v2/spec.md section 1.8: the item that a duplicate verdict names.
  duplicateOf: "UPDATE review_item SET payload_json = json_set(payload_json, '$.verify.duplicateOf', $target) WHERE id = $id",
  items: `SELECT i.*, ${RUN_COLS} FROM review_item i JOIN review_run r ON r.id = i.run WHERE i.run = $run ORDER BY i.id`,
  itemById: "SELECT * FROM review_item WHERE id = $id",
  // Plan r2 S-RR. An Explain run has no findings. A run from before M4 has no explain value.
  baseRun: `WHERE r.pr = $pr AND r.kind = 'review' AND r.status IN ('completed', 'incomplete') AND COALESCE(r.explain, r.profile = 'explain') = 0
    ORDER BY r.id DESC LIMIT 1`,
  carry: "SELECT * FROM review_item WHERE run = $run AND kind IN ('finding', 'question') AND status IN ('new', 'accepted') ORDER BY id",
  // An inline post holds one finding. Its confirmed comment starts the thread. The newest findings come first.
  posted: `SELECT i.*, p.remote_id AS root, r.source_head AS run_head, r.merge_base AS run_base FROM review_item i
    JOIN review_run r ON r.id = i.run
    JOIN post p ON p.pr = r.pr AND p.kind = 'inline' AND p.state = 'confirmed' AND p.remote_id IS NOT NULL
      AND json_extract(p.items_json, '$[0].id') = i.id
    JOIN comment c ON c.pr = r.pr AND c.comment_id = p.remote_id AND c.parent_id IS NULL AND c.tombstoned_at IS NULL AND c.thread_resolved = 0
    WHERE r.pr = $pr AND i.kind = 'finding' AND i.status = 'posted' ORDER BY i.id DESC LIMIT $limit`,
  // The copy in the re-review replaces the source.
  carried: "UPDATE review_item SET status = 'discarded', revision = revision + 1 WHERE id = $id",
  // Deleted messages too: the turn rule reads them.
  turns: `SELECT comment_id AS id, root_id AS rootId, author_slug AS authorSlug, author_login AS authorLogin, created_at AS createdAt,
      tombstoned_at IS NOT NULL AS deleted, thread_resolved AS threadResolved FROM comment WHERE pr = $pr`,
  // SQL.run joins the PR, so the routes of PR runs give 404 for a task run. raw follows them.
  raw: "SELECT raw_output FROM review_run WHERE id = $id AND pr IS NOT NULL",
  asks: "WHERE r.pr = $pr AND r.kind = 'ask' ORDER BY r.id DESC LIMIT 20",
  // docs/plans/review-v2/spec.md section 3.2: the newest explain run, and the newest one with a result. $key: any key, or one run key.
  explainNewest: "WHERE r.pr = $pr AND r.kind = 'explain' ORDER BY r.id DESC LIMIT 1",
  explainDone: `WHERE r.pr = $pr AND r.kind = 'explain' AND r.status IN ('completed', 'incomplete') AND r.explain_json IS NOT NULL
    AND ($key IS NULL OR r.idem_key = $key) ORDER BY r.id DESC LIMIT 1`,
  explainJson: "SELECT explain_json FROM review_run WHERE id = $id",
  historyAsks:
    "WHERE r.pr = $pr AND r.kind = 'ask' AND r.status IN ('completed', 'incomplete') AND r.answer IS NOT NULL ORDER BY r.id DESC",
  historyItems: `SELECT * FROM review_item i WHERE run = $run AND kind = 'finding' AND ${NOT_REVISION} ORDER BY id`,
  // docs/plans/review-v2/spec.md section 2.15: the parent of a follow-up, and the follow-up that a run already has.
  askParent: "SELECT id, pr, kind, profile FROM review_run WHERE id = $id",
  followUp: "SELECT id FROM review_run WHERE parent_run = $id",
  // The earlier turns of an ask run, newest first. UNION drops a repeated ID, so a parent loop ends the walk.
  chain: `WITH RECURSIVE up(id) AS (
      SELECT parent_run FROM review_run WHERE id = $run AND parent_run IS NOT NULL
      UNION SELECT r.parent_run FROM review_run r JOIN up ON r.id = up.id WHERE r.parent_run IS NOT NULL)
    SELECT r.id, r.status, r.source_head, r.question, r.answer FROM up JOIN review_run r ON r.id = up.id ORDER BY r.id DESC`,
  // docs/plans/review-v2/spec.md section 6.3: a task run has pr NULL. Its heads are known only after the fetch (taskHeads).
  taskInsert: `INSERT INTO review_run (task, kind, profile, profile_name, profile_revision, explain, note, idem_key, source_head, target_head,
      status, started_at, model, effort, effort_default)
    VALUES ($task, $kind, $profile, $profile_name, $profile_revision, 0, '', $key, '', '', 'running', $now, $model, $effort, $effort_default)
    RETURNING id`,
  taskHeads: `UPDATE review_run SET source_head = $head, target_head = $head, merge_base = $head, range_base = $head, fetch_via = 'branch'
    WHERE id = $id`,
  // The own review of a task part: head is the part commit, base the commit that the part starts from.
  taskReviewHeads: `UPDATE review_run SET source_head = $head, target_head = $base, merge_base = $base, range_base = $base,
      fetch_via = 'branch' WHERE id = $id`,
  // A session run uses no profile and no --model or --effort flag.
  sessionInsert: `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, effort, consult_json)
    VALUES ($pr, 'session', '', '', $key, $source, $target, 'running', $now, 'default', $consult) RETURNING id`,
  sessionAnswer: "SELECT answer, consult_json FROM review_run WHERE id = $run AND pr = $pr AND kind = 'session' AND answer IS NOT NULL",
};

export function toPullRequest(r: PrRow & { source_head: string; target_head: string }): PullRequest {
  const author = r.author_slug ?? "";
  return {
    ref: { project: r.project, repo: r.repo, id: r.pr_id },
    version: r.pr_version ?? 0,
    title: r.title ?? "",
    description: r.description ?? undefined,
    state: r.state ?? "",
    author: { slug: author, name: r.author_name ?? author, login: author },
    reviewers: [],
    sourceHead: r.source_head,
    targetHead: r.target_head,
    sourceBranch: r.source_branch ?? "",
    targetBranch: r.target_branch ?? "",
    webUrl: r.web_url ?? undefined,
    updatedDate: r.updated_date ?? 0,
  };
}

export function commentsOf(db: Database, pr: number): Comment[] {
  type Row = {
    comment_id: number;
    version: number;
    parent_id: number | null;
    root_id: number;
    author_slug: string;
    author_name: string | null;
    author_login: string | null;
    text: string;
    anchor_json: string | null;
    thread_resolved: number;
    created_at: number;
    updated_at: number;
    excerpt_json: string | null;
    severity: string | null;
    task_state: string | null;
  };
  return (db.query(SQL.comments).all({ pr }) as Row[]).map((c) => {
    let anchor: unknown;
    let excerpt: ExcerptLine[] | undefined;
    try {
      anchor = c.anchor_json ? JSON.parse(c.anchor_json) : undefined;
      excerpt = c.excerpt_json ? JSON.parse(c.excerpt_json) : undefined;
    } catch {}
    return {
      id: c.comment_id,
      version: c.version,
      parentId: c.parent_id,
      rootId: c.root_id,
      author: { slug: c.author_slug, name: c.author_name ?? c.author_slug, login: c.author_login ?? c.author_slug },
      text: c.text,
      anchor,
      threadResolved: c.thread_resolved === 1,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      ...(excerpt && { excerpt }),
      ...(c.severity !== null && { severity: c.severity }),
      ...(c.task_state !== null && { state: c.task_state }),
    };
  });
}

export type FixEditRow = { id: number; thread: number | null; item: number | null; path: string; rows_json: string };

export function toFixEditDto(r: FixEditRow): FixEditDto {
  const rows = JSON.parse(r.rows_json) as DiffRowDto[];
  const count = (kind: DiffRowDto["kind"]) => rows.filter((x) => x.kind === kind).length;
  return {
    id: r.id,
    ...(r.thread !== null && { thread: r.thread }),
    ...(r.item !== null && { finding: r.item }),
    path: r.path,
    added: count("add"),
    removed: count("del"),
    rows,
  };
}

// The effort that the current user settings give a run without --effort. It reads the settings file once per model.
export function effortsNow() {
  const seen = new Map<string, string | null>();
  return (model: string | null) => {
    const k = model ?? "";
    if (!seen.has(k)) seen.set(k, runEffort(model));
    return seen.get(k) ?? null;
  };
}

// A run without --effort and without a stored default (for example, from before migration 019) gets the effort of the current settings.
// A run from before migration 018 has effort null and ran without --effort.
export function toRunDto(r: RunRow, resolve = effortsNow()): RunDto {
  const noFlag = r.effort === null || r.effort === "default";
  const resolved = noFlag && r.effort_default === null ? resolve(r.model) : null;
  const source = r.pr_source !== null && r.pr_source !== r.source_head;
  const target = r.pr_target !== null && r.pr_target !== r.target_head;
  return {
    id: r.id,
    pr: r.pr,
    kind: r.kind,
    profile: r.profile,
    profileName: r.profile_name ?? FORMER_NAMES[r.profile] ?? r.profile,
    explain: r.explain === null ? null : r.explain === 1,
    note: r.note,
    status: r.status,
    errorKind: r.error_kind,
    errorText: r.error_text,
    sourceHead: r.source_head,
    targetHead: r.target_head,
    mergeBase: r.merge_base,
    via: r.fetch_via,
    sessionId: r.session_id,
    cliVersion: r.cli_version,
    model: r.model,
    effort: r.effort,
    effortDefault: noFlag ? (r.effort_default ?? resolved) : null,
    effortNow: resolved !== null,
    usage: r.usage_json ? (JSON.parse(r.usage_json) as RunUsage) : null,
    summary: r.summary_json ? (JSON.parse(r.summary_json) as RunSummary) : null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    stale: source || target ? { source, target } : null,
    hasRaw: r.has_raw === 1,
    since: r.since_head === null ? null : { head: r.since_head, incremental: r.range_base !== null && r.range_base !== r.merge_base },
    question: r.question,
    ...(r.tasks_json !== null && { tasks: JSON.parse(r.tasks_json) as NonNullable<RunDto["tasks"]> }),
    ...(r.instructions_json !== null && { instructions: JSON.parse(r.instructions_json) as NonNullable<RunDto["instructions"]> }),
    ...(r.skills_json !== null && { skills: JSON.parse(r.skills_json) as NonNullable<RunDto["skills"]> }),
    findings: r.findings,
    ...(r.consult_json !== null && { consult: sessionOf(JSON.parse(r.consult_json) as SessionRecord) }),
  };
}

// The item keys of the snapshot stay on the server: only the answer route sends them.
const sessionOf = (s: SessionRecord): NonNullable<RunDto["consult"]> => ({
  session: s.session,
  title: s.title,
  bytes: s.bytes,
  tokens: s.tokens,
  items: s.items,
  textBytes: s.textBytes,
  ...(s.mode && { mode: s.mode }),
  ...(s.run !== undefined && { run: s.run }),
});

export function toItemDto(r: ItemRow): ReviewItemDto {
  const stored = JSON.parse(r.payload_json) as AnchoredFinding | Question | ReplyPayload;
  // A reply draft stored before Release 3 has no judgement.
  const payload = r.kind === "reply" ? { ...stored, judgement: (stored as ReplyPayload).judgement ?? null } : stored;
  const anchor =
    r.kind === "finding" && r.path !== null && r.side !== null && r.line !== null && r.line_end !== null && r.anchor_state !== null
      ? {
          state: r.anchor_state,
          path: r.path,
          oldPath: (payload as AnchoredFinding).anchor.oldPath,
          line: r.line,
          lineEnd: r.line_end,
          excerpt: JSON.parse(r.excerpt_json ?? "[]"),
          side: r.side,
        }
      : null;
  return {
    id: r.id,
    run: r.run,
    kind: r.kind,
    body: r.body,
    payload,
    anchor,
    status: r.status,
    revision: r.revision,
    edited: r.edited === 1,
    ...(r.kind === "reply" &&
      r.run_kind !== undefined && {
        drafted: { kind: r.run_kind, startedAt: r.run_started as number, finishedAt: r.run_finished ?? null, head: r.run_head as string },
      }),
  };
}
