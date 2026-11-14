// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Thread history (docs/plans/thread-outcome.md section 10): the stored facts of GET /api/prs/:id/threads/:thread/history and the
// thread messages as one time-ordered list. No DOM access, so bun test runs it directly.
import type { ReviewItemDto, RunKind, ThreadHistoryDto } from "../../shared/dto";
import type { ReplyOrigin, ReplyPayload } from "../../shared/review";
import { WHY } from "../fix/model";
import { plural, shortHash } from "../review/model";
import { type Person, snippet, type ThreadModel } from "./threads";

// at: ms, the sort key. exact false: PR Review Inbox keeps no time for the fact, so the line shows none. at then only places the line
// after the fact that it follows. null: no time at all, so the line goes last.
// actor: bold, before the text. null for a fact without an actor. tags: short states after the text, never a time.
// detail: one muted line under the head. run: an AI line, with a link to its run log. diff: your edit of a draft, for Show changes.
export type HistoryLine = {
  key: string;
  at: number | null;
  exact: boolean;
  actor: string | null;
  text: string;
  tags: string[];
  detail?: string;
  error?: boolean;
  run?: number;
  diff?: { before: string; after: string };
};

// ai: the runner name of the AI writers. forge: the code host name.
export type HistoryNames = { ai: string; forge: string };

export type HistoryThread = Pick<ThreadModel, "msgs" | "turn" | "resolver" | "resolvedAt">;

type Draft = ThreadHistoryDto["drafts"][number];

export const HISTORY_NOTE = (forge: string) =>
  `${forge} keeps no record of reopens or earlier text. PR Review Inbox keeps only the time of your last change to a draft.`;

const APP = "PR Review Inbox";
const SNIP = 140;
const payloadOf = (it: ReviewItemDto) => it.payload as ReplyPayload;
const who = (p: Person) => (p.me ? "You" : p.name);

// "a", "a and b", "a, b, and c".
const list = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);

// thread-outcome.md section 4: a draft stored before origin existed is "Fixed in" with fix, else the kind of its run.
const KIND_ORIGIN: Partial<Record<RunKind, ReplyOrigin>> = { review: "review", reply: "reply", fix: "nofix", session: "session" };
const originOf = (it: ReviewItemDto): ReplyOrigin | null => {
  const p = payloadOf(it);
  return p.origin ?? (p.fix ? "fix" : ((it.drafted && KIND_ORIGIN[it.drafted.kind]) ?? null));
};

// The app writes "Fixed in" and "Won't fix" drafts from your own click. Every other writer is an AI run.
function writerOf(it: ReviewItemDto, ai: string): { actor: string; ai: boolean } {
  const o = originOf(it);
  if (o === "session") return { actor: "Your session", ai: true };
  if (o === "fix" || o === "user" || (o === "nofix" && payloadOf(it).declined)) return { actor: APP, ai: false };
  return { actor: ai, ai: true };
}

// The words after "Replaced by".
function replacer(it: ReviewItemDto): string {
  const p = payloadOf(it);
  if (p.revisionOf !== undefined) return "the revision";
  switch (originOf(it)) {
    case "fix":
      return "the draft of your fix commit";
    case "nofix":
      return p.declined ? "the “Won't fix” draft" : "the answer of the fix run";
    case "session":
      return "the draft of your session";
    case "review":
      return "a draft of the review";
    case "resolve":
      return "the resolve proposal";
    default:
      return "a newer reply draft";
  }
}

function madeText(it: ReviewItemDto): string {
  const p = payloadOf(it);
  const o = originOf(it);
  const said = (p.body ?? it.body).trim();
  const commit = p.fix ? ` ${shortHash(p.fix.commit)}` : "";
  if (p.revises !== undefined || p.revisionOf !== undefined) {
    if (o === "fix") return `revised your draft for the fix commit${commit}`;
    return said || p.resolve ? "revised your draft" : "found that no reply is needed now";
  }
  if (o === "fix" || o === "user") return `drafted the reply for the fix commit${commit}`;
  if (o === "nofix" && p.declined) return "drafted “Won't fix” from your decline";
  if (!said) return p.resolve ? "proposed to resolve the thread" : "found that no reply is needed";
  if (o === "nofix") return "drafted the answer of the fix run";
  if (o === "review") return "drafted an answer in the review";
  return "drafted a reply";
}

// docs/plans/thread-outcome.md section 9: the answer judgements.
const JUDGED: Partial<Record<NonNullable<ReplyPayload["judgement"]>, string>> = {
  settled: "Settled",
  unsettled: "Follow-up asked",
  followup: "Follow-up asked",
};

export function historyLines(dto: ThreadHistoryDto, t: HistoryThread, names: HistoryNames): HistoryLine[] {
  const out: HistoryLine[] = [];
  const add = (l: Omit<HistoryLine, "tags"> & { tags?: string[] }) => out.push({ ...l, tags: l.tags ?? [] });
  const msgAt = new Map(t.msgs.map((m) => [m.id, m.createdAt]));
  const posted = new Map(dto.posts.flatMap((p) => (p.state === "confirmed" && p.remoteId !== null ? [[p.remoteId, p] as const] : [])));

  // Messages. A confirmed post of the app names its source on the message line.
  for (const m of t.msgs) {
    const post = posted.get(m.id);
    const how = !post
      ? ""
      : post.run === null
        ? " from PR Review Inbox"
        : post.kind === "reply"
          ? " from a PR Review Inbox draft"
          : " from a review run";
    add({
      key: `m${m.id}`,
      at: m.createdAt,
      exact: true,
      actor: who(m.who),
      text: `${m.id === m.rootId ? "started the thread" : "replied"}${how}`,
      ...(m.deleted ? { tags: [`Deleted on ${names.forge}`] } : m.text ? { detail: snippet(m.text, SNIP) } : {}),
      ...(post?.run != null && { run: post.run }),
    });
    // The fixtures comment-blocker-*.json: a task resolve keeps updatedDate. A text edit changes it (integration-check.md).
    if (!m.deleted && m.updatedAt > m.createdAt)
      add({ key: `e${m.id}`, at: m.updatedAt, exact: true, actor: who(m.who), text: "edited the message" });
  }

  for (const f of dto.fixes) {
    const n = f.note;
    add({
      key: `f${f.run}`,
      at: f.at,
      exact: true,
      actor: names.ai,
      text: n.why === "dropped" ? "proposed edits that could not be applied" : n.fixed && !n.why ? "proposed a fix" : "proposed no fix",
      tags: n.why && n.why !== "dropped" ? [WHY[n.why]] : [],
      detail: snippet(n.why === "dropped" && n.drops?.length ? n.drops.join("; ") : n.reason, SNIP) || undefined,
      run: f.run,
    });
    // fix-routes.ts decline stores no time.
    if (n.declined)
      add({ key: `d${f.run}`, at: f.at, exact: false, actor: "You", text: "declined the fix", detail: snippet(n.declined.reason, SNIP) });
  }

  const commitOf = new Map(dto.commits.map((c) => [c.id, c]));
  for (const c of dto.commits) {
    const part = `${c.edits} of ${plural(c.of, "edit")} of this thread`;
    add({
      key: `c${c.id}`,
      at: c.at,
      exact: true,
      actor: "You",
      text: c.short ? `committed ${c.short}: ${part}` : `staged ${part}`,
      // No git call: an unpushed commit and a rebased one both miss from the PR commits.
      tags: c.state === "staged" ? ["Commit not finished"] : c.state === "committed" && !c.pushed ? ["Not on the pull request"] : [],
    });
    if (c.undoneAt !== null)
      add({
        key: `u${c.id}`,
        at: c.undoneAt,
        exact: true,
        actor: "You",
        text: c.short ? `undid the fix commit ${c.short}` : "undid the staged edits",
      });
  }

  const byItem = new Map(dto.drafts.map((d) => [d.item.id, d]));
  // A used revision names the draft that it revised (items.ts takeRevision).
  const usedBy = new Map<number, Draft>();
  for (const d of dto.drafts) {
    const of = payloadOf(d.item).revisionOf;
    if (of !== undefined) usedBy.set(of, d);
  }
  const declined = new Set(dto.fixes.flatMap((f) => (f.note.declined?.draft === undefined ? [] : [f.note.declined.draft])));
  for (const d of dto.drafts) {
    const it = d.item;
    const p = payloadOf(it);
    const o = originOf(it);
    const w = writerOf(it, names.ai);
    const said = (p.body ?? it.body).trim();
    const fixed = p.fix && p.fix.id !== null ? commitOf.get(p.fix.id) : undefined;
    const tags: string[] = [];
    const judged = p.judgement ? JUDGED[p.judgement] : undefined;
    if (judged) tags.push(judged);
    if (fixed?.state === "undone") tags.push("Fix commit undone");
    else if (p.revises !== undefined) {
      // DROP_REVISIONS drops a revision when a newer draft of the thread comes. Without a newer draft, only Keep mine drops it.
      const newer = dto.drafts.some((x) => x.item.id > it.id);
      tags.push(!p.dropped ? "Revision waiting" : newer ? "Not used" : "You kept your draft");
    } else if (it.status === "posted") tags.push("Posted");
    else if (it.status === "discarded") {
      const used = usedBy.get(it.id);
      const by = d.replacedBy === null ? undefined : byItem.get(d.replacedBy);
      if (used) tags.push(`Replaced by ${replacer(used.item)}`);
      else if (by) tags.push(`Replaced by ${replacer(by.item)}`);
      else if (p.discardedBy === "user") tags.push("Discarded by you");
      else if (p.declined && !declined.has(it.id)) tags.push("Decline undone");
      else if (p.discardedBy !== "ai") tags.push("Discarded");
    }
    add({
      key: `i${it.id}`,
      at: d.at,
      exact: d.exact,
      actor: w.actor,
      text: madeText(it),
      tags,
      detail: snippet(said || p.reason, SNIP) || undefined,
      ...(w.ai && { run: it.run }),
    });

    // PR Review Inbox keeps one time for your actions on a draft: the newest (touchedAt).
    const replyAt = msgAt.get(p.replyTo);
    const moved =
      p.touchedAt !== undefined &&
      (o === "reply" || o === "review" || o === "session" || o === "resolve") &&
      !!it.drafted &&
      replyAt !== undefined &&
      replyAt > it.drafted.startedAt;
    const did = [
      p.revisionOf !== undefined && "used the revision",
      o === "user" && "made it a plain reply",
      it.edited && "edited the text",
      (it.status === "accepted" || it.status === "posted") && "accepted the draft",
      moved && "moved it to the newest message",
    ].filter((x): x is string => !!x);
    if (!did.length && p.touchedAt !== undefined) did.push("changed the draft");
    if (!did.length) continue;
    const before = said;
    const after = it.body.trim();
    add({
      key: `t${it.id}`,
      at: p.touchedAt ?? d.at,
      exact: p.touchedAt !== undefined,
      actor: "You",
      text: list(did),
      ...(it.edited && p.body !== undefined && before !== after && { diff: { before, after } }),
    });
  }

  for (const p of dto.posts) {
    const what = p.kind === "reply" ? "a reply" : "the comment";
    if (p.state === "pending" || p.state === "sent")
      add({ key: `p${p.id}`, at: p.at, exact: true, actor: "You", text: `posted ${what}`, tags: ["Not confirmed yet"] });
    else if (p.state === "failed")
      add({
        key: `p${p.id}`,
        at: p.at,
        exact: true,
        actor: "You",
        text: `posted ${what}`,
        tags: ["Failed"],
        error: true,
        ...(p.error && { detail: p.error }),
      });
    else if (p.state === "unknown")
      add({
        key: `p${p.id}`,
        at: p.at,
        exact: true,
        actor: "You",
        text: `posted ${what}`,
        tags: ["State unknown"],
        detail: `${names.forge} gave no clear answer. PR Review Inbox looks for the comment before any new send.`,
      });
    else if (p.remoteId === null || !msgAt.has(p.remoteId))
      add({ key: `p${p.id}`, at: p.at, exact: true, actor: "You", text: `posted ${what}` });
    if (p.resolve?.state === "failed")
      add({
        key: `r${p.id}`,
        at: p.updatedAt,
        exact: true,
        actor: APP,
        text: "could not resolve the thread after the post",
        error: true,
        ...(p.resolve.error && { detail: p.resolve.error }),
      });
  }

  // Only the current resolve: a reopen clears the resolver and the time (integration-check.md U56, U62).
  if (t.turn === "resolved")
    add({
      key: "resolved",
      at: t.resolvedAt,
      exact: t.resolvedAt !== null,
      actor: t.resolver ? who(t.resolver) : null,
      text: t.resolver ? "resolved the thread" : "The thread is resolved",
    });

  return out
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (a.l.at ?? Number.POSITIVE_INFINITY) - (b.l.at ?? Number.POSITIVE_INFINITY) || a.i - b.i)
    .map((x) => x.l);
}
