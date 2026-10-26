// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Forge-neutral types. The Bitbucket adapter maps its payloads to these.
import type { Side } from "./review";

export type PrRef = { project: string; repo: string; id: number };

export type Role = "REVIEWER" | "AUTHOR";

// name: the display name. login: the username.
export type User = { slug: string; name: string; login: string };

// `status` and `state` stay open strings: servers send values beyond the known ones.
export type Reviewer = User & { status: string; lastReviewedCommit?: string };

export type PullRequest = {
  ref: PrRef;
  version: number;
  title: string;
  description?: string;
  state: string;
  author: User;
  reviewers: Reviewer[];
  sourceHead: string;
  targetHead: string;
  sourceBranch: string;
  targetBranch: string;
  // Present only when the server link has the configured origin.
  webUrl?: string;
  // The repository browse link of the target repository. Present only when it has the configured origin.
  repoUrl?: string;
  // The branch pages. The source branch of a PR from a fork is in the fork. Present only when the repository link has the configured origin.
  sourceBranchUrl?: string;
  targetBranchUrl?: string;
  // The user page of the author. Present only when it has the configured origin.
  authorUrl?: string;
  updatedDate: number;
  // properties.mergeResult (docs/plans/review-v2/spec.md section 6.18.5). current false: Bitbucket has not checked the newest heads.
  mergeResult?: { outcome: string; current: boolean };
};

// A line of the diff around an inline comment. n: the new line number of an added or context line, the old one of a removed line.
// A context line of an old-side comment keeps its old number. hit: a commented line. A range comment marks each line of its range.
export type ExcerptLine = { n: number; kind: "add" | "del" | "ctx"; text: string; hit: boolean };

// Gate A U2: the new-side lines of a range anchor (multilineSpan). Its line, lineType, and fileType name the end line.
// undefined: no range, a REMOVED end line, or a span without new-side lines. The end line alone then places the comment.
export function anchorSpan(anchor: unknown): { line: number; lineEnd: number } | undefined {
  const a = anchor as { lineType?: unknown; multilineSpan?: { dstSpanStart?: unknown; dstSpanEnd?: unknown } } | null | undefined;
  const s = a?.multilineSpan;
  if (!s || a?.lineType === "REMOVED") return undefined;
  const { dstSpanStart: from, dstSpanEnd: to } = s;
  return typeof from === "number" && typeof to === "number" && from > 0 && to >= from ? { line: from, lineEnd: to } : undefined;
}

// The lines of an inline root comment, numbered as its excerpt numbers them. undefined: no line, or a new-side CONTEXT anchor without an excerpt.
// Gate v3 U4: the forge line of a CONTEXT anchor is the old-side line, whatever fileType says.
export function commentLines(c: { anchor?: unknown; excerpt?: ExcerptLine[] }): { line: number; lineEnd: number } | undefined {
  const span = anchorSpan(c.anchor);
  if (span) return span;
  const hit = c.excerpt?.find((l) => l.hit);
  if (hit) return { line: hit.n, lineEnd: hit.n };
  const a = c.anchor as { line?: unknown; lineType?: unknown; fileType?: unknown } | null | undefined;
  return typeof a?.line === "number" && (a.lineType !== "CONTEXT" || a.fileType === "FROM") ? { line: a.line, lineEnd: a.line } : undefined;
}

// The place of a thread or a draft. line null: a comment on the whole file.
export type Spot = { path: string; side: Side; line: number | null; lineEnd: number };

// A thread's line comes from its range span (anchorSpan), else from its excerpt hit, else from its anchor.
// The excerpt numbers a ctx line on the fileType side (provider.ts excerptOf).
// Gate v3 U4: a CONTEXT anchor numbers its line on the old side, whatever fileType says. A REMOVED line exists only there.
export function threadSpot(c: { anchor?: unknown; excerpt?: ExcerptLine[] }): (Spot & { orphaned: boolean }) | null {
  const a = c.anchor as { path?: unknown; line?: unknown; lineType?: unknown; fileType?: unknown; orphaned?: unknown } | null | undefined;
  if (!a || typeof a.path !== "string") return null;
  const from = a.fileType === "FROM";
  const orphaned = a.orphaned === true;
  const span = anchorSpan(a);
  if (span) return { path: a.path, side: "new", ...span, orphaned };
  const hit = c.excerpt?.find((l) => l.hit);
  if (hit) {
    const side = hit.kind === "del" || (hit.kind === "ctx" && from) ? "old" : "new";
    return { path: a.path, side, line: hit.n, lineEnd: hit.n, orphaned };
  }
  if (typeof a.line !== "number") return { path: a.path, side: "new", line: null, lineEnd: 0, orphaned };
  const old = a.lineType === "REMOVED" || a.lineType === "CONTEXT" || (a.lineType === undefined && from);
  return { path: a.path, side: old ? "old" : "new", line: a.line, lineEnd: a.line, orphaned };
}

export type Comment = {
  id: number;
  version: number;
  // null for a root comment.
  parentId: number | null;
  // Equals `id` for a root comment.
  rootId: number;
  author: User;
  text: string;
  // Root comments only. A reply carries a copy of its root anchor on the forge (Gate v3 U16). The adapter drops it.
  anchor?: unknown;
  threadResolved: boolean;
  // Root comments of resolved threads only. Absent when the forge sends no such field (integration-check.md U56).
  threadResolver?: User;
  threadResolvedAt?: number;
  createdAt: number;
  updatedAt: number;
  // Open forge values. A task is severity BLOCKER. Done is state RESOLVED (Gate v3 U14).
  severity?: string;
  state?: string;
  // Inline root comments with a diff only.
  excerpt?: ExcerptLine[];
};

// at: the author time in ms. committedAt: the commit time in ms. authorSlug: null for an author with no forge account.
export type Commit = {
  hash: string;
  parents: string[];
  message: string;
  authorSlug: string | null;
  authorName: string;
  at: number;
  committedAt: number;
};

// srcPath: the old path of a moved or copied file. type: the forge change type, for example ADD, MODIFY, DELETE, MOVE.
export type Change = { path: string; srcPath: string | null; type: string };

export type ForgeErrorKind = "network" | "timeout" | "auth" | "forbidden" | "not_found" | "rate" | "server" | "shape";

export type ForgeErrorInfo = {
  kind: ForgeErrorKind;
  status?: number;
  // Raw Retry-After header value, only for kind `rate`.
  retryAfter?: string;
  endpoint: string;
  message: string;
};

export type IncompleteReason = ForgeErrorKind | "cursor" | "page_limit";

export type ListResult<T> =
  | { items: T[]; complete: true }
  | { items: T[]; complete: false; reason: IncompleteReason; error?: ForgeErrorInfo };

export type CommentStatus = "present" | "deleted";
