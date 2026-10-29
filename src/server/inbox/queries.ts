// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Inbox reads and writes (plan G5). Unread: followed, not tombstoned (D8), and ack_version IS NULL OR ack_version < version.
import type { Database } from "bun:sqlite";
import type {
  Cause,
  ChangedFile,
  CheckpointDto,
  CheckpointReason,
  ClaimedEvent,
  CommentDto,
  CommitDto,
  ExcerptLine,
  FollowState,
  Group,
  PrDetail,
  PrRow,
  PrTask,
} from "../../shared/dto";
import { byThread, newestLive, type TurnMsg, threadTurn } from "../../shared/turn";
import type { Reviewer, Role, User } from "../../shared/types";
import { byArchive, byInbox } from "../../shared/views";
import { BUILD_COLUMNS, type RawBuild, toBuild } from "./builds";
import { openDrafts, staleCount } from "./stale";

const CLAIMED_TTL_MS = 30 * 86_400_000;
const UNREAD = "c.pr = p.id AND p.followed = 1 AND c.tombstoned_at IS NULL AND (c.ack_version IS NULL OR c.ack_version < c.version)";
const LISTED = "p.archived_at IS NULL AND (p.followed = 1 OR p.on_dashboard = 1)";
// The complement of LISTED, so each PR shows in one list (views.ts archived).
const ARCHIVED = "p.archived_at IS NOT NULL OR (p.followed = 0 AND p.on_dashboard = 0)";
// prototype/v3 snippet(): the default length.
const SNIPPET = 110;

// The rows, their comments, and their tasks in one scope. $id limits each query to one PR.
function scoped(scope: string) {
  const where = `(${scope}) AND ($id IS NULL OR p.id = $id)`;
  return {
    rows: `SELECT p.id, p.project, p.repo, p.pr_id, p.title, p.author_slug, p.author_name, p.my_role, p.state, p.my_status, p.last_reviewed_commit,
      p.source_head, p.target_head, p.source_branch, p.target_branch, p.web_url, b.source_url AS source_branch_url, b.target_url AS target_branch_url, b.author_url,
      p.on_dashboard, p.followed, p.archived_at, p.reviewers_json, p.seen_at,
      (SELECT COUNT(*) FROM comment c WHERE ${UNREAD}) AS unread,
      MAX(COALESCE(p.updated_date, 0), COALESCE((SELECT MAX(c.updated_at) FROM comment c WHERE c.pr = p.id), 0)) AS last_activity,
      k.scope IS NOT NULL AS has_checkpoint, k.last_complete_at, k.incomplete_reason, k.last_error, ${BUILD_COLUMNS}
    FROM pull_request p LEFT JOIN sync_checkpoint k ON k.scope = 'pr:' || p.id LEFT JOIN pr_branch_link b ON b.pr = p.id
      LEFT JOIN pr_build pb ON pb.pr = p.id
    WHERE ${where}`,
    // One query for the comments of all PRs in the scope.
    turns: `SELECT c.pr, c.comment_id, c.root_id, c.author_slug, c.author_name, c.author_login, c.text, c.thread_resolved, c.created_at,
      c.tombstoned_at IS NOT NULL AS deleted, p.followed = 1 AND c.tombstoned_at IS NULL AND (c.ack_version IS NULL OR c.ack_version < c.version) AS unread
    FROM comment c JOIN pull_request p ON p.id = c.pr WHERE ${where}`,
    tasks: `SELECT t.pr, t.key, t.source, t.url FROM pr_task t JOIN pull_request p ON p.id = t.pr WHERE ${where} ORDER BY t.pr, t.ord`,
  };
}

type Scope = ReturnType<typeof scoped>;
// "any": the detail opens a PR of either list.
const SCOPE = { listed: scoped(LISTED), archived: scoped(ARCHIVED), any: scoped("1") };

const SQL = {
  comments: `SELECT comment_id, version, parent_id, root_id, author_slug, author_name, author_login, text, anchor_json, thread_resolved, created_at, updated_at,
      ack_version, tombstoned_at, severity, task_state, excerpt_json, thread_resolver_json, thread_resolved_at, orphaned_at
    FROM comment WHERE pr = $pr ORDER BY created_at, comment_id`,
  commits: "SELECT hash, message, author_name AS author, ts AS at FROM pr_commit WHERE pr = $pr ORDER BY ord",
  files: "SELECT path, src_path AS srcPath, type FROM pr_change WHERE pr = $pr ORDER BY path",
  // A2: the ack never rises above the stored version, and never falls.
  read: `UPDATE comment SET ack_version = MIN(version, $version)
    WHERE pr = $pr AND comment_id = $id AND (ack_version IS NULL OR ack_version < MIN(version, $version))`,
  follow: "UPDATE pull_request SET followed = $followed, archived_at = IIF($followed = 1, NULL, archived_at) WHERE id = $id",
  archive: "UPDATE pull_request SET archived_at = IIF($archived = 1, COALESCE(archived_at, $now), NULL) WHERE id = $id",
  followState: "SELECT id, followed, archived_at FROM pull_request WHERE id = $id",
  seen: "UPDATE pull_request SET seen_at = $now WHERE id = $id",
  followKey: `INSERT INTO pull_request (project, repo, pr_id, followed, archived_at, initialized_at) VALUES ($project, $repo, $pr_id, 1, NULL, NULL)
    ON CONFLICT (project, repo, pr_id) DO UPDATE SET followed = 1, archived_at = NULL RETURNING id`,
  // One statement, so two concurrent claims never return the same event.
  claim: `UPDATE event SET claimed_at = $now WHERE claimed_at IS NULL
    RETURNING id, pr, kind, ref, created_at, digest,
      (SELECT project FROM pull_request WHERE id = event.pr) AS project, (SELECT repo FROM pull_request WHERE id = event.pr) AS repo,
      (SELECT pr_id FROM pull_request WHERE id = event.pr) AS pr_id, (SELECT title FROM pull_request WHERE id = event.pr) AS title,
      (SELECT followed = 1 AND archived_at IS NULL FROM pull_request WHERE id = event.pr) AS shown`,
  cleanup: "DELETE FROM event WHERE claimed_at IS NOT NULL AND claimed_at < $cutoff",
  description: "SELECT description, source_head FROM pull_request WHERE id = $id",
  // Plan v3 WP13: confirmed outbox rows link a remote comment to its source.
  posted: "SELECT remote_id, run IS NOT NULL AS run, kind FROM post WHERE pr = $pr AND state = 'confirmed' AND remote_id IS NOT NULL",
  checkpoint: "SELECT last_complete_at, incomplete_reason, last_error FROM sync_checkpoint WHERE scope = $scope",
};

type RawRow = RawBuild & {
  id: number;
  project: string;
  repo: string;
  pr_id: number;
  title: string | null;
  author_slug: string | null;
  author_name: string | null;
  my_role: Role | null;
  state: string | null;
  my_status: string | null;
  last_reviewed_commit: string | null;
  source_head: string | null;
  target_head: string | null;
  source_branch: string | null;
  target_branch: string | null;
  web_url: string | null;
  source_branch_url: string | null;
  target_branch_url: string | null;
  author_url: string | null;
  reviewers_json: string | null;
  seen_at: number | null;
  on_dashboard: number;
  followed: number;
  archived_at: number | null;
  unread: number;
  last_activity: number;
  has_checkpoint: number;
  last_complete_at: number | null;
  incomplete_reason: string | null;
  last_error: string | null;
};

type TurnRow = {
  pr: number;
  comment_id: number;
  root_id: number;
  author_slug: string;
  author_name: string | null;
  author_login: string | null;
  text: string;
  thread_resolved: number;
  created_at: number;
  deleted: number;
  unread: number;
};
type Msg = TurnMsg & { authorName: string | null; text: string; unread: boolean };
type Turns = { yourTurn: number; cause: Cause | null; waitSince: number | null };

const snippet = (s: string) => {
  const t = s.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET - 1)}…` : t;
};

// prototype/v3 derive(): the cause is the newest unread your-turn thread, else the newest your-turn thread, else the newest unread thread.
function turnsOf(msgs: Msg[], me: string, prAuthor: boolean): Turns {
  type T = { root: number; msgs: Msg[]; last: Msg; unread: Msg | undefined };
  const your: T[] = [];
  const unread: T[] = [];
  let waitSince: number | null = null;
  for (const [root, t] of byThread(msgs)) {
    const last = newestLive(t);
    if (!last) continue;
    const first = t.filter((m) => m.unread).sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)[0];
    const th = { root, msgs: t, last, unread: first };
    const turn = threadTurn(t, me, prAuthor);
    if (turn === "your") your.push(th);
    if (turn === "wait" && (waitSince === null || last.createdAt < waitSince)) waitSince = last.createdAt;
    if (first) unread.push(th);
  }
  const newest = (a: T, b: T) => b.last.createdAt - a.last.createdAt || b.last.id - a.last.id;
  const c = [...your.filter((t) => t.unread).sort(newest), ...your.sort(newest), ...unread.sort(newest)][0];
  return {
    yourTurn: your.length,
    cause: c
      ? { thread: c.root, msg: (c.unread ?? c.last).id, author: c.last.authorName ?? c.last.authorSlug, snippet: snippet(c.last.text) }
      : null,
    waitSince,
  };
}

// prototype/v3 derive() p.group. D1: a closed PR keeps a your-turn or unread reason. "triage" needs review drafts (M2).
function groupOf(r: RawRow, t: Turns): Group {
  const closed = r.state === "MERGED" || r.state === "DECLINED";
  const reviewer = r.state === "OPEN" && r.my_role === "REVIEWER";
  if (t.yourTurn) return "your";
  if (closed) return r.unread ? "comments" : "closed";
  if (reviewer && r.my_status === "UNAPPROVED" && !r.last_reviewed_commit) return "review";
  if (reviewer && r.last_reviewed_commit && r.last_reviewed_commit !== r.source_head) return "commits";
  if (r.unread) return "comments";
  return t.waitSince !== null ? "waiting" : "quiet";
}

type RawCheckpoint = { last_complete_at: number | null; incomplete_reason: string | null; last_error: string | null };

const toCheckpoint = (k: RawCheckpoint): CheckpointDto => ({
  lastCompleteAt: k.last_complete_at,
  reason: k.incomplete_reason as CheckpointReason | null,
  error: k.last_error,
});

const toRow = (r: RawRow, t: Turns, tasks: PrTask[], staleDrafts: number): PrRow => ({
  id: r.id,
  project: r.project,
  repo: r.repo,
  prId: r.pr_id,
  title: r.title,
  authorSlug: r.author_slug,
  authorName: r.author_name,
  role: r.my_role,
  state: r.state,
  status: r.my_status,
  sourceBranch: r.source_branch,
  targetBranch: r.target_branch,
  webUrl: r.web_url,
  sourceBranchUrl: r.source_branch_url,
  targetBranchUrl: r.target_branch_url,
  authorUrl: r.author_url,
  synced: r.source_head !== null && r.target_head !== null,
  reviewers:
    r.reviewers_json === null
      ? []
      : (JSON.parse(r.reviewers_json) as (Omit<Reviewer, "login"> & { login?: string })[]).map((x) => ({ ...x, login: x.login ?? null })),
  onDashboard: r.on_dashboard === 1,
  followed: r.followed === 1,
  archivedAt: r.archived_at,
  unread: r.unread,
  group: groupOf(r, t),
  yourTurn: t.yourTurn,
  staleDrafts,
  cause: t.cause,
  waitSince: t.waitSince,
  seenAt: r.seen_at,
  tasks,
  lastActivity: r.last_activity,
  checkpoint: r.has_checkpoint ? toCheckpoint(r) : null,
  build: toBuild(r, r.source_head),
});

function selectRows(db: Database, me: string, sql: Scope, id: number | null): PrRow[] {
  const msgs = new Map<number, Msg[]>();
  for (const c of db.query(sql.turns).all({ id }) as TurnRow[]) {
    const m: Msg = {
      id: c.comment_id,
      rootId: c.root_id,
      authorSlug: c.author_slug,
      authorName: c.author_name,
      authorLogin: c.author_login,
      createdAt: c.created_at,
      deleted: c.deleted === 1,
      threadResolved: c.thread_resolved === 1,
      text: c.text,
      unread: c.unread === 1,
    };
    const list = msgs.get(c.pr);
    if (list) list.push(m);
    else msgs.set(c.pr, [m]);
  }
  const tasks = Map.groupBy(db.query(sql.tasks).all({ id }) as (PrTask & { pr: number })[], (t) => t.pr);
  const drafts = openDrafts(db, id);
  return (db.query(sql.rows).all({ id }) as RawRow[]).map((r) =>
    toRow(
      r,
      turnsOf(msgs.get(r.id) ?? [], me, r.my_role === "AUTHOR"),
      (tasks.get(r.id) ?? []).map(({ key, source, url }) => ({ key, source, url })),
      staleCount(drafts.get(r.id) ?? [], msgs.get(r.id) ?? []),
    ),
  );
}

export function listPrs(db: Database, me: string): PrRow[] {
  return selectRows(db, me, SCOPE.listed, null).sort(byInbox);
}

export function listArchived(db: Database, me: string): PrRow[] {
  return selectRows(db, me, SCOPE.archived, null).sort(byArchive);
}

// null for an unknown PR. An archived PR opens from the Archive view.
export function prDetail(db: Database, me: string, id: number): PrDetail | null {
  const pr = selectRows(db, me, SCOPE.any, id)[0];
  if (!pr) return null;
  type Raw = {
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
    ack_version: number | null;
    tombstoned_at: number | null;
    severity: string | null;
    task_state: string | null;
    excerpt_json: string | null;
    thread_resolver_json: string | null;
    thread_resolved_at: number | null;
    orphaned_at: number | null;
  };
  const posted = new Map(
    (db.query(SQL.posted).all({ pr: id }) as { remote_id: number; run: number; kind: string }[]).map(
      (p) => [p.remote_id, !p.run ? "reply" : p.kind === "reply" ? "draft" : "run"] as const,
    ),
  );
  const comments = (db.query(SQL.comments).all({ pr: id }) as Raw[]).map((c): CommentDto => {
    const deleted = c.tombstoned_at !== null;
    const by = posted.get(c.comment_id);
    return {
      id: c.comment_id,
      version: c.version,
      parentId: c.parent_id,
      rootId: c.root_id,
      authorSlug: c.author_slug,
      authorName: c.author_name,
      authorLogin: c.author_login,
      text: deleted ? null : c.text,
      anchor: c.anchor_json === null ? null : JSON.parse(c.anchor_json),
      threadResolved: c.thread_resolved === 1,
      ...(c.thread_resolved === 1 && c.thread_resolver_json !== null && { resolver: JSON.parse(c.thread_resolver_json) as User }),
      ...(c.thread_resolved === 1 && c.thread_resolved_at !== null && { resolvedAt: c.thread_resolved_at }),
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      unread: pr.followed && !deleted && (c.ack_version === null || c.ack_version < c.version),
      deleted,
      ...(c.excerpt_json !== null && { excerpt: JSON.parse(c.excerpt_json) as ExcerptLine[] }),
      ...(c.orphaned_at !== null && { orphanedAt: c.orphaned_at }),
      // Gate v3 U14: a task is a BLOCKER comment. RESOLVED marks it done.
      ...(c.severity === "BLOCKER" && { task: c.task_state === "RESOLVED" ? "done" : "open" }),
      ...(by && { posted: by }),
    };
  });
  const { description, source_head } = db.query(SQL.description).get({ id }) as { description: string | null; source_head: string | null };
  const commits = db.query(SQL.commits).all({ pr: id }) as CommitDto[];
  const files = db.query(SQL.files).all({ pr: id }) as ChangedFile[];
  return { pr, description, sourceHead: source_head, comments, files, commits };
}

// null for an unknown PR.
export function markSeen(db: Database, id: number, now: number): { id: number; seenAt: number } | null {
  return db.query(SQL.seen).run({ id, now }).changes ? { id, seenAt: now } : null;
}

export function markRead(db: Database, pr: number, items: { id: number; version: number }[]): number {
  return db.transaction(() => {
    let changed = 0;
    const q = db.query(SQL.read);
    for (const it of items) changed += q.run({ pr, id: it.id, version: it.version }).changes;
    return changed;
  })();
}

function followState(db: Database, id: number): FollowState | null {
  const r = db.query(SQL.followState).get({ id }) as { id: number; followed: number; archived_at: number | null } | null;
  return r && { id: r.id, followed: r.followed === 1, archivedAt: r.archived_at };
}

// Follow also clears archived_at. The sync engine clears initialized_at of unwatched PRs itself.
export function setFollowed(db: Database, id: number, followed: boolean): FollowState | null {
  db.query(SQL.follow).run({ id, followed: followed ? 1 : 0 });
  return followState(db, id);
}

export function setArchived(db: Database, id: number, archived: boolean, now: number): FollowState | null {
  db.query(SQL.archive).run({ id, archived: archived ? 1 : 0, now });
  return followState(db, id);
}

export function followKey(db: Database, key: { project: string; repo: string; pr_id: number }): FollowState {
  const { id } = db.query(SQL.followKey).get(key) as { id: number };
  return followState(db, id) as FollowState;
}

export function claimEvents(db: Database, now: number): ClaimedEvent[] {
  type Raw = Omit<ClaimedEvent, "createdAt" | "digest" | "prId"> & { created_at: number; digest: number; pr_id: number; shown: number };
  // Events of archived or unfollowed PRs stay claimed, so they never notify later.
  return (db.query(SQL.claim).all({ now }) as Raw[])
    .filter((e) => e.shown === 1)
    .map(({ created_at, digest, pr_id, shown: _, ...e }) => ({ ...e, createdAt: created_at, digest: digest === 1, prId: pr_id }))
    .sort((a, b) => a.id - b.id);
}

export function cleanupEvents(db: Database, now: number) {
  db.query(SQL.cleanup).run({ cutoff: now - CLAIMED_TTL_MS });
}

export function dashboardCheckpoint(db: Database): CheckpointDto | null {
  const k = db.query(SQL.checkpoint).get({ scope: "dashboard" }) as RawCheckpoint | null;
  return k && toCheckpoint(k);
}
