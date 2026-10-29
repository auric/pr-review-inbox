// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure sync rules (plan G4). No I/O, so tests run without a server or a database.
import { isMe } from "../../shared/me";
import type { Comment, PullRequest, Role } from "../../shared/types";

const MAX_BACKOFF_MS = 15 * 60_000;

export type EventKind = "comment_new" | "commits_pushed" | "reviewer_added" | "draft_stale" | "build_failed" | "build_passed";
export type NewEvent = { kind: EventKind; ref: string };

export function roleOf(pr: PullRequest, me: string): Role | null {
  if (isMe(pr.author, me)) return "AUTHOR";
  return pr.reviewers.some((r) => isMe(r, me)) ? "REVIEWER" : null;
}

// Every stored row of the PR, tombstoned ones included.
// author: the slug. login: null for rows stored before the column existed.
export type StoredComment = { id: number; rootId: number; author: string; login: string | null; live: boolean };

export type CommentRow = Comment & { ackVersion: number | null };

// `fetched` must come from a complete activities fetch.
export function reconcile(input: { stored: StoredComment[]; fetched: Comment[]; me: string; initialized: boolean; role: string | null }) {
  const { stored, fetched, me, initialized, role } = input;
  const ids = new Set(fetched.map((c) => c.id));
  const known = new Set(stored.map((s) => s.id));
  const myThreads = new Set([
    ...stored.filter((s) => isMe({ slug: s.author, login: s.login }, me)).map((s) => s.rootId),
    ...fetched.filter((c) => isMe(c.author, me)).map((c) => c.rootId),
  ]);
  return {
    // The first sync and own comments are read at once.
    rows: fetched.map((c): CommentRow => ({ ...c, ackVersion: !initialized || isMe(c.author, me) ? c.version : null })),
    // A candidate is deleted only after its GET returns 404.
    candidates: stored.filter((s) => s.live && !ids.has(s.id)).map((s) => s.id),
    // US3: a reply in a thread that I started or joined, or any comment on my PR.
    newCommentIds: initialized
      ? fetched.filter((c) => !known.has(c.id) && !isMe(c.author, me) && (role === "AUTHOR" || myThreads.has(c.rootId))).map((c) => c.id)
      : [],
  };
}

// Stored PR state before this sync writes the row. A new row starts followed and not archived.
export type PrBefore = { role: string | null; sourceHead: string | null; initialized: boolean; watched: boolean };

// dashboardSeen: a complete dashboard was stored before this one. Only the dashboard step passes true.
export function prEvents(before: PrBefore | null, pr: PullRequest, me: string, dashboardSeen: boolean): NewEvent[] {
  if (before && !before.watched) return [];
  const role = roleOf(pr, me);
  const out: NewEvent[] = [];
  if (dashboardSeen && role === "REVIEWER" && before?.role !== "REVIEWER") out.push({ kind: "reviewer_added", ref: String(pr.version) });
  // G5 reason new_commits: last_reviewed_commit set and different from the source head.
  const reviewed = pr.reviewers.find((r) => isMe(r, me))?.lastReviewedCommit;
  if (
    before?.initialized &&
    before.sourceHead &&
    before.sourceHead !== pr.sourceHead &&
    role === "REVIEWER" &&
    reviewed &&
    reviewed !== pr.sourceHead
  ) {
    out.push({ kind: "commits_pushed", ref: pr.sourceHead });
  }
  return out;
}

// failures: consecutive cycles in which no request reached the server. intervalMs: the configured check interval.
export function nextDelay(failures: number, random: () => number, intervalMs: number): number {
  if (failures === 0) return intervalMs * (0.9 + 0.2 * random());
  return random() * Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures);
}

// The HTTP-date form would need a server time against the local clock, so only delta seconds count.
export function parseRetryAfter(value: string | undefined): number | undefined {
  return value && /^\d+$/.test(value) ? Number(value) * 1000 : undefined;
}
