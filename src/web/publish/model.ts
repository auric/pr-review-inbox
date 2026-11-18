// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure publish UI rules (plan v3 WP14a, docs/plans/replies.md step 4). No DOM access, so bun test runs them directly.
import type { BlockedDraft, BlockedReason, CommentDto, PlannedPost, PostDestination, PostDto } from "../../shared/dto";
import { commentLines } from "../../shared/types";
import { lineText, plural } from "../review/model";

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// prototype/v3 destText: "2 inline comments and 1 general comment". A reply post without a body only resolves its thread.
// A reply in a resolved thread reopens the thread first.
export function destText(posts: { destination: PostDestination; body: string; reopen?: PlannedPost["reopen"] }[]): string {
  const n = (k: PostDestination["kind"]) => posts.filter((p) => p.destination.kind === k && p.body).length;
  const resolves = posts.filter((p) => !p.body).length;
  const reopens = posts.filter((p) => p.body && p.reopen).length;
  return [
    n("inline") ? plural(n("inline"), "inline comment") : "",
    n("general") ? plural(n("general"), "general comment") : "",
    n("reply") ? plural(n("reply"), "reply", "replies") : "",
    reopens ? plural(reopens, "thread reopen") : "",
    resolves ? plural(resolves, "thread resolve") : "",
  ]
    .filter(Boolean)
    .join(" and ")
    .replace(/ and (?=.* and )/, ", ");
}

// Every item of the plan with the revision on screen. Confirm sends exactly these (WP13a).
export const planItems = (posts: PlannedPost[]) => posts.flatMap((p) => p.items);

export type Who = { name: string; place: string };

// The author and the place of the comment that a reply answers. null: the comment is not in the stored detail.
export function parentOf(parentId: number, comments: CommentDto[]): Who | null {
  const c = comments.find((x) => x.id === parentId);
  if (!c) return null;
  const root = comments.find((x) => x.id === c.rootId) ?? c;
  return { name: c.authorName ?? c.authorSlug, place: placeOf(root) };
}

// The place of a thread, from its root comment.
export function placeOf(root: Pick<CommentDto, "anchor" | "excerpt">): string {
  const a = root.anchor as { path?: unknown } | null;
  if (!a || typeof a.path !== "string") return "the general comment";
  const lines = commentLines(root);
  return lines === undefined ? a.path : `${a.path}:${lineText(lines)}`;
}

// replies.md step 4: "Reply to <name> in <place>".
export const replyText = (who: Who) => `Reply to ${who.name} in ${who.place}`;

// The destination words of a post without a body: it only resolves the thread of the reply parent.
export function resolveLabel(d: PostDestination, comments: CommentDto[]): string {
  const who = d.kind === "reply" ? parentOf(d.parentId, comments) : null;
  return who ? `Resolve the thread in ${who.place}` : "Resolve the thread";
}

// The resolve line of a planned post. null: the post resolves nothing.
export const resolveNote = (p: { body: string; resolve?: number }) =>
  p.resolve === undefined ? null : p.body ? "Then resolves the thread." : "Resolves the thread. No reply is posted.";

// The reopen line of a planned post. The forge takes no reply in a resolved thread. null: the thread is open.
export const reopenNote = (p: { body: string; reopen?: PlannedPost["reopen"] }) =>
  !p.body || !p.reopen ? null : "The thread is resolved. Reopen thread, post reply.";

// docs/plans/thread-outcome.md: the thread of a draft that the post leaves out, from its root comment.
export function threadText(thread: number, comments: CommentDto[]): string {
  const root = comments.find((c) => c.id === thread);
  return root ? `Thread of ${root.authorName ?? root.authorSlug} in ${placeOf(root)}` : `Thread ${thread}`;
}

// Why the post leaves a draft out, and what the user can do. action: the button of each draft, null: none. The key order is the group order.
export const BLOCKED: Record<BlockedReason, { title: string; text: string; action: string | null }> = {
  "out-of-date": {
    title: "Out of date",
    text: "New messages since the draft. Reply to the newest as is, or revise it in the thread.",
    action: "Reply to the newest as is",
  },
  "resolved-since": { title: "Resolved since the draft", text: "Reopen the thread to post.", action: "Reopen thread" },
  unpushed: { title: "Fix commit not pushed", text: "Push the fix commit first.", action: null },
  "commit-gone": {
    title: "Commit not on the branch",
    text: "The commit is not on the branch. Post as plain reply.",
    action: "Post as plain reply",
  },
  "older-commit": {
    title: "On an older commit",
    text: "The review ran on an older commit. Review changes (c) carries these drafts, or Discard.",
    action: "Discard",
  },
};

// docs/plans/review-v2/stale-drafts.md F1: the place of a blocked draft. A reply names its thread, a finding its line.
export const blockedText = (b: BlockedDraft, comments: CommentDto[]) =>
  b.thread !== undefined ? threadText(b.thread, comments) : b.path ? `${b.path}:${b.line}` : "Question";

// The blocked drafts grouped by reason, in the order of BLOCKED. Empty groups are left out.
export const blockedGroups = (blocked: BlockedDraft[]): { reason: BlockedReason; items: BlockedDraft[] }[] =>
  (Object.keys(BLOCKED) as BlockedReason[])
    .map((reason) => ({ reason, items: blocked.filter((b) => b.reason === reason) }))
    .filter((g) => g.items.length > 0);

// The blocked count of the post bar, with the out-of-date drafts called out. "" when nothing is blocked.
// The older-commit drafts have their own line (olderNote).
export function blockedNote(list: Pick<BlockedDraft, "reason">[]): string {
  const blocked = list.filter((b) => b.reason !== "older-commit");
  const stale = blocked.filter((b) => b.reason === "out-of-date").length;
  const all = plural(blocked.length, "draft");
  if (!blocked.length) return "";
  if (stale === blocked.length) return `${all} out of date`;
  return stale ? `${all} cannot post now, ${stale} out of date` : `${all} cannot post now`;
}

// docs/plans/review-v2/stale-drafts.md F1: the post bar line of the older-commit drafts. "" when there are none.
export function olderNote(blocked: Pick<BlockedDraft, "reason">[]): string {
  const n = blocked.filter((b) => b.reason === "older-commit").length;
  if (!n) return "";
  return `${n === 1 ? "1 draft is" : `${n} drafts are`} on an older commit. Review changes (c) carries ${n === 1 ? "it" : "them"}, or Discard.`;
}

// The line of a PR in the Ready to post view. null: the PR has nothing to post and nothing blocked.
export type ReadyLine = { posts: string | null; blocked: string | null };
export function readyLine(plan: { posts: PlannedPost[]; blocked?: BlockedDraft[] }): ReadyLine | null {
  const n = plan.blocked?.length ?? 0;
  if (!plan.posts.length && !n) return null;
  return { posts: plan.posts.length ? destText(plan.posts) : null, blocked: n ? `${n} cannot post` : null };
}

// A key that changes when the posts or the blocked drafts of a plan change.
export const planSig = (plan: { posts: PlannedPost[]; blocked?: BlockedDraft[] }) =>
  JSON.stringify([
    plan.posts.map((p) => [p.run, p.body, p.items]),
    (plan.blocked ?? []).map((b) => [b.item, b.revision, b.reason, b.commit]),
  ]);

// The destination words of a planned post or an outbox row.
export function destLabel(d: PostDestination, comments: CommentDto[]): { code: string | null; text: string } {
  switch (d.kind) {
    case "inline":
      return { code: `${base(d.path)}:${d.lineEnd > d.line ? `${d.line}–${d.lineEnd}` : d.line}`, text: "Inline comment" };
    case "general":
      return { code: null, text: "General comment" };
    default: {
      const who = parentOf(d.parentId, comments);
      return { code: null, text: who ? replyText(who) : "Reply" };
    }
  }
}

export type PostView = {
  // posting: pending or sent, or a resolve step that runs. checking: unknown while the app reads the remote comments.
  // resolved: the resolve step after the comment step is done.
  kind: "posting" | "checking" | "unknown" | "failed" | "posted" | "resolved";
  text: string;
  reason: string | null;
  // again: retry. general: drop a failed inline post into the next general comment. resolve: run a failed resolve step again.
  actions: ("again" | "drop" | "general" | "resolve")[];
};

// Plan v3 section 7 and replies.md step 4: Posting, "Outcome unknown. Checking.", Failed with the reason, and Posted.
export function postView(p: PostDto): PostView {
  switch (p.state) {
    case "pending":
    case "sent":
      return { kind: "posting", text: "Posting…", reason: null, actions: [] };
    case "unknown":
      return p.checking
        ? { kind: "checking", text: "Outcome unknown. Checking.", reason: null, actions: ["again", "drop"] }
        : { kind: "unknown", text: "Outcome unknown.", reason: p.lastError, actions: ["again", "drop"] };
    case "failed":
      return {
        kind: "failed",
        text: "Failed.",
        reason: p.lastError ?? "No reason was recorded.",
        actions: p.destination.kind === "inline" ? ["again", "general", "drop"] : ["again", "drop"],
      };
    default:
      return resolveView(p);
  }
}

// A confirmed row: the resolve step after the comment step. A row without a body posted no comment.
function resolveView(p: PostDto): PostView {
  const posted = p.body ? "Posted. " : "";
  switch (p.resolve?.state) {
    case "pending":
      return { kind: "posting", text: `${posted}Resolving the thread…`, reason: null, actions: [] };
    case "failed":
      return {
        kind: "failed",
        text: `${posted}Resolve failed.`,
        reason: p.resolve.error ?? "No reason was recorded.",
        actions: ["resolve"],
      };
    case "done":
      return { kind: "resolved", text: p.body ? "Posted and resolved." : "Resolved.", reason: null, actions: [] };
    default:
      return { kind: "posted", text: "Posted.", reason: null, actions: [] };
  }
}

// A confirmed row shows until the synced comment with its remote ID arrives. Then the thread shows the comment.
// A resolve step that waits or failed keeps the row until the thread shows as resolved. A row without a body then hides.
export function shownPosts(posts: PostDto[], comments: CommentDto[]): PostDto[] {
  const ids = new Set(comments.map((c) => c.id));
  const resolved = new Set(comments.filter((c) => c.threadResolved).map((c) => c.rootId));
  const resolving = (p: PostDto) => !!p.resolve && p.resolve.state !== "done" && !resolved.has(p.resolve.root);
  return posts.filter((p) => p.state !== "confirmed" || resolving(p) || (p.body !== "" && (p.remoteId === null || !ids.has(p.remoteId))));
}

// Reply rows go to the thread of their parent. Other rows, and replies to a comment that is not stored, go to the outbox group.
export function splitPosts(posts: PostDto[], comments: CommentDto[]): { threads: Map<number, PostDto[]>; rest: PostDto[] } {
  const root = new Map(comments.map((c) => [c.id, c.rootId]));
  const threads = new Map<number, PostDto[]>();
  const rest: PostDto[] = [];
  for (const p of posts) {
    const tid = p.destination.kind === "reply" ? root.get(p.destination.parentId) : undefined;
    if (tid === undefined) rest.push(p);
    else threads.set(tid, [...(threads.get(tid) ?? []), p]);
  }
  return { threads, rest };
}

// The rows of one confirm or reply in the cache. A new row of the same ID replaces the old one.
export const mergePosts = (old: PostDto[] | undefined, rows: PostDto[]): PostDto[] =>
  [...(old ?? []).filter((p) => !rows.some((r) => r.id === p.id)), ...rows].sort((a, b) => a.id - b.id);

// ---------- Reply composer ----------

// key: the idempotency key of the next send. used: a request went out with this key, so a text change needs a new key.
export type ReplyDraft = { text: string; key: string; used: boolean };

// replies.md step 4: unsent text stays in localStorage under rl:reply:<pr>:<thread>.
export const draftKey = (pr: number, thread: number) => `rl:reply:${pr}:${thread}`;

export function parseDraft(raw: string | null): ReplyDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<ReplyDraft>;
    return typeof d.text === "string" && typeof d.key === "string" && typeof d.used === "boolean"
      ? { text: d.text, key: d.key, used: d.used }
      : null;
  } catch {
    return null;
  }
}

// A text change after a send gets a new key. The old key keeps its text on the server (WP13a: 409 for another text).
export const editDraft = (d: ReplyDraft, text: string, newKey: () => string): ReplyDraft =>
  d.used && text !== d.text ? { text, key: newKey(), used: false } : { ...d, text };
