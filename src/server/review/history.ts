// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Thread history (docs/plans/thread-outcome.md section 10): the stored facts of one thread. The client merges them with the messages.
// No git call: pushed reads pr_commit only.
import type { Database } from "bun:sqlite";
import type { FixCommitState, PostDestination, PostState, ThreadHistoryDto } from "../../shared/dto";
import { parseFixNotes, type ReplyPayload, type SessionMark } from "../../shared/review";
import { type ItemRow, RUN_COLS, toItemDto } from "./run-rows";

const SQL = {
  // A deleted root keeps its row (tombstoned_at), so its thread still has history.
  thread: "SELECT 1 FROM comment WHERE pr = $pr AND root_id = $thread LIMIT 1",
  items: `SELECT i.*, ${RUN_COLS} FROM review_item i JOIN review_run r ON r.id = i.run
    WHERE r.pr = $pr AND i.kind = 'reply' AND i.thread = $thread ORDER BY i.id`,
  fixRuns: "SELECT id, started_at, finished_at, fix_json FROM review_run WHERE pr = $pr AND kind = 'fix' ORDER BY id",
  edits: "SELECT f.id, f.run FROM fix_edit f JOIN review_run r ON r.id = f.run WHERE r.pr = $pr AND f.thread = $thread",
  commits: `SELECT c.id, c.run, c.edits_json, c.short_hash, c.state, c.created_at, c.updated_at,
      EXISTS (SELECT 1 FROM pr_commit k WHERE k.pr = c.pr AND k.hash = c.commit_hash) AS pushed
    FROM fix_commit c WHERE c.pr = $pr ORDER BY c.id`,
  posts: `SELECT id, run, kind, state, last_error, remote_id, created_at, updated_at, resolve_root, resolve_state, resolve_error FROM post
    WHERE pr = $pr AND (resolve_root = $thread OR remote_id = $thread OR (kind = 'reply' AND
      json_extract(destination_json, '$.parentId') IN (SELECT comment_id FROM comment WHERE pr = $pr AND root_id = $thread)))
    ORDER BY id`,
};

export type HistoryRows = {
  // The reply items of the thread with RUN_COLS, oldest first.
  items: ItemRow[];
  fixRuns: { id: number; started_at: number; finished_at: number | null; fix_json: string | null }[];
  // The fix edits of the thread.
  edits: { id: number; run: number }[];
  // Every fix commit of the PR. pushed: pr_commit lists the commit.
  commits: {
    id: number;
    run: number;
    edits_json: string;
    short_hash: string | null;
    state: FixCommitState;
    created_at: number;
    updated_at: number;
    pushed: number;
  }[];
  posts: {
    id: number;
    run: number | null;
    kind: PostDestination["kind"];
    state: PostState;
    last_error: string | null;
    remote_id: number | null;
    created_at: number;
    updated_at: number;
    resolve_root: number | null;
    resolve_state: "pending" | "done" | "failed" | null;
    resolve_error: string | null;
  }[];
};

export function buildHistory(thread: number, rows: HistoryRows): ThreadHistoryDto {
  const runAt = new Map(rows.fixRuns.map((r) => [r.id, r.finished_at ?? r.started_at]));
  const notes = rows.fixRuns.flatMap((r) =>
    parseFixNotes(r.fix_json)
      .filter((n) => n.thread === thread)
      .map((note) => ({ at: runAt.get(r.id) as number, run: r.id, note })),
  );
  const ofRun = new Map<number, Set<number>>();
  for (const e of rows.edits) ofRun.set(e.run, (ofRun.get(e.run) ?? new Set()).add(e.id));
  const commits = rows.commits.flatMap((c) => {
    const mine = ofRun.get(c.run);
    const edits = mine ? (JSON.parse(c.edits_json) as number[]).filter((id) => mine.has(id)).length : 0;
    if (!edits || !mine) return [];
    return [
      {
        at: c.created_at,
        id: c.id,
        run: c.run,
        short: c.short_hash,
        state: c.state,
        edits,
        of: mine.size,
        pushed: c.pushed === 1,
        // An undo is the last change of a row: a new apply makes a new row.
        undoneAt: c.state === "undone" ? c.updated_at : null,
      },
    ];
  });
  const commitAt = new Map(rows.commits.map((c) => [c.id, c.created_at]));

  const items = rows.items.map((r) => ({ r, p: JSON.parse(r.payload_json) as ReplyPayload & { session?: SessionMark } }));
  // The explicit lists name the replacer. A later list wins, because an undo can bring a draft back for a later writer.
  const explicit = new Map<number, number>();
  for (const { r, p } of items) {
    for (const id of p.fix?.replaced ?? []) explicit.set(id, r.id);
    for (const x of p.session?.replaced ?? []) explicit.set(x.id, r.id);
  }
  for (const n of notes) {
    const d = n.note.declined;
    if (d?.draft !== undefined) for (const id of d.replaced ?? []) explicit.set(id, d.draft);
  }
  const drafts = items.map(({ r, p }) => {
    const ran = r.run_finished ?? r.run_started ?? 0;
    const at = p.fix
      ? ((p.fix.id === null ? undefined : commitAt.get(p.fix.id)) ?? ran)
      : p.declined
        ? (runAt.get(p.declined.run) ?? ran)
        : ran;
    let replacedBy: number | null = null;
    if (r.status === "discarded") {
      replacedBy = explicit.get(r.id) ?? null;
      // drafts.ts SUPERSEDE, fix-routes.ts, and consult.ts discard without discardedBy. A revision is never replaced: it waits or drops.
      if (replacedBy === null && !p.discardedBy && p.revises === undefined)
        replacedBy = items.find((x) => x.r.id > r.id && x.p.revises === undefined)?.r.id ?? null;
    }
    return { at, exact: !p.declined, item: toItemDto(r), replacedBy };
  });

  const posts = rows.posts.map((p) => ({
    at: p.created_at,
    id: p.id,
    run: p.run,
    kind: p.kind,
    state: p.state,
    error: p.last_error,
    remoteId: p.remote_id,
    updatedAt: p.updated_at,
    resolve:
      p.resolve_root !== null && p.resolve_state !== null ? { root: p.resolve_root, state: p.resolve_state, error: p.resolve_error } : null,
  }));
  return { thread, drafts, fixes: notes, commits, posts };
}

// null: the PR has no comment row in the thread.
export function threadHistory(db: Database, pr: number, thread: number): ThreadHistoryDto | null {
  const at = { pr, thread };
  if (!db.query(SQL.thread).get(at)) return null;
  return buildHistory(thread, {
    items: db.query(SQL.items).all(at) as ItemRow[],
    fixRuns: db.query(SQL.fixRuns).all({ pr }) as HistoryRows["fixRuns"],
    edits: db.query(SQL.edits).all(at) as HistoryRows["edits"],
    commits: db.query(SQL.commits).all({ pr }) as HistoryRows["commits"],
    posts: db.query(SQL.posts).all(at) as HistoryRows["posts"],
  });
}
