// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The reply drafts of review threads (docs/plans/thread-outcome.md): the current draft, writer priority, revisions, and supersede.
import type { Database } from "bun:sqlite";
import type { ReviewItemDto } from "../../shared/dto";
import { isMe } from "../../shared/me";
import type { ReplyOrigin, ReplyPayload } from "../../shared/review";
import { newestLive, type TurnMsg } from "../../shared/turn";
import { type ItemRow, type NewItem, RUN_COLS, toItemDto } from "./run-rows";

// The current reply draft of each thread: the newest open draft, else the newest draft. A draft of an undone fix commit never
// counts: it cannot post (outbox.ts fixCheck). A revision that waits for the user (payload revises) never counts.
// An open draft sorts last, so it wins.
export const UNDONE = "EXISTS (SELECT 1 FROM fix_commit f WHERE f.id = json_extract(i.payload_json, '$.fix.id') AND f.state = 'undone')";
const CURRENT_DRAFTS = `SELECT i.*, ${RUN_COLS} FROM review_item i JOIN review_run r ON r.id = i.run
  WHERE r.pr = $pr AND i.kind = 'reply' AND i.thread IS NOT NULL AND NOT ${UNDONE} AND json_extract(i.payload_json, '$.revises') IS NULL
  ORDER BY i.status IN ('new', 'accepted'), i.id`;
// docs/plans/review-v2/spec.md section 2.2: a finding takes revisions too. Item IDs are unique, so one map holds both kinds.
const REVISIONS = `SELECT i.*, ${RUN_COLS} FROM review_item i JOIN review_run r ON r.id = i.run
  WHERE r.pr = $pr AND i.kind IN ('reply', 'finding') AND i.status = 'discarded' AND json_extract(i.payload_json, '$.revises') IS NOT NULL
    AND json_extract(i.payload_json, '$.dropped') IS NULL AND NOT ${UNDONE} ORDER BY i.id`;
// A newer draft or revision of a thread drops its waiting revisions. shared/review.ts says why the rows stay.
export const DROP_REVISIONS = `UPDATE review_item SET payload_json = json_set(payload_json, '$.dropped', json('true')), revision = revision + 1
  WHERE kind = 'reply' AND thread = $thread AND status = 'discarded' AND json_extract(payload_json, '$.revises') IS NOT NULL
    AND json_extract(payload_json, '$.dropped') IS NULL AND run IN (SELECT id FROM review_run WHERE pr = $pr)`;
// A new reply draft replaces the open drafts of its thread that the user did not touch. Posted drafts stay.
const SUPERSEDE = `UPDATE review_item SET status = 'discarded', revision = revision + 1
    WHERE kind = 'reply' AND thread = $thread AND status = 'new' AND edited = 0 AND run IN (SELECT id FROM review_run WHERE pr = $pr)`;
const THREAD_RESOLVED = "SELECT thread_resolved FROM comment WHERE pr = $pr AND comment_id = $thread";

export function currentDrafts(db: Database, pr: number): Map<number, ItemRow> {
  const out = new Map<number, ItemRow>();
  for (const r of db.query(CURRENT_DRAFTS).all({ pr }) as ItemRow[]) out.set(r.thread as number, r);
  return out;
}

// The newest waiting revision of each draft or finding, by the ID of the item that it revises.
export function revisions(db: Database, pr: number): Map<number, ItemRow> {
  const out = new Map<number, ItemRow>();
  for (const r of db.query(REVISIONS).all({ pr }) as ItemRow[]) out.set((JSON.parse(r.payload_json) as ReplyPayload).revises as number, r);
  return out;
}

// The DTO of a reply draft or a finding with its waiting revision. Only an open item can take a revision.
export function withRevision(r: ItemRow, revs: Map<number, ItemRow>): ReviewItemDto {
  const rev = r.status === "new" || r.status === "accepted" ? revs.get(r.id) : undefined;
  return rev ? { ...toItemDto(r), revised: toItemDto(rev) } : toItemDto(r);
}

// An open draft that the user edited or accepted. A writer that would replace it stores a revision instead (docs/plans/thread-outcome.md).
export const touched = (r: ItemRow | undefined) => !!r && (r.status === "accepted" || (r.status === "new" && r.edited === 1));

// A draft that no writer replaces: the user edited or accepted it, declined it (the current draft is discarded), or declined the fix
// with it ("Won't fix"). declined false: the user asked for a new draft of this thread, so a discarded draft does not block it.
// A draft that a reply run discarded (discardedBy ai) is no decline.
export const userDraft = (r: ItemRow | undefined, declined: boolean) =>
  touched(r) ||
  (!!r &&
    ((r.status === "new" && !!(JSON.parse(r.payload_json) as ReplyPayload).declined) ||
      (declined && r.status === "discarded" && (JSON.parse(r.payload_json) as ReplyPayload).discardedBy !== "ai")));

export const keptText = (thread: number) => `Thread ${thread}: kept your draft. The new draft was not stored.`;
export const revisedText = (thread: number) =>
  `Thread ${thread}: kept your draft. The new text waits under it as a revision. Use it, or keep your draft.`;
export const sameText = (thread: number) => `Thread ${thread}: kept your draft. The revision has the same text.`;

// docs/plans/thread-outcome.md writer priority, after the user (userDraft): "Fixed in", then nofix, then the other writers, then a
// resolve-only proposal. A lower rank wins. A draft stored before origin existed ranks by its fix field only. A discuss draft has the
// rank of a reply run (docs/plans/review-v2/spec.md section 2.5).
const writerRank = (p: ReplyPayload) => (p.fix ? 2 : p.origin === "nofix" ? 3 : p.origin === "resolve" ? 5 : 4);
// The current draft is open, untouched, and from a higher writer than the new draft.
const higherDraft = (r: ItemRow | undefined, payload: string) =>
  r?.status === "new" && writerRank(JSON.parse(r.payload_json) as ReplyPayload) < writerRank(JSON.parse(payload) as ReplyPayload);

// One open draft per thread. A new reply draft never replaces a draft that the user edited, accepted, or declined. A run for
// threads that the user named (picked) is the user's choice, so only the other runs keep an untouched draft of a higher writer.
// A thread that the run revises (revise) gets a revision of the user's draft, unless the draft changed since the start.
// kept: the threads whose new draft is not stored. revised: the ID of the revised draft by thread. notes: the coverage lines.
export function replyOutcome(db: Database, pr: number, items: NewItem[], threads: { thread: number; revise?: number }[], picked: boolean) {
  const drafts = currentDrafts(db, pr);
  const kept = new Set<number>();
  const revised = new Map<number, number>();
  const notes: string[] = [];
  for (const it of items) {
    if (it.kind !== "reply" || it.thread === null) continue;
    const cur = drafts.get(it.thread);
    const revise = threads.find((t) => t.thread === it.thread)?.revise;
    if (cur && touched(cur) && cur.id === revise) {
      if (it.body.trim() === cur.body.trim()) {
        kept.add(it.thread);
        notes.push(sameText(it.thread));
      } else {
        revised.set(it.thread, cur.id);
        notes.push(revisedText(it.thread));
      }
    } else if (userDraft(cur, !picked) || (!picked && higherDraft(cur, it.payload_json))) {
      kept.add(it.thread);
      notes.push(keptText(it.thread));
    }
  }
  return { kept, revised, notes };
}

// The items to store after replyOutcome. A revision goes in as a discarded item with revises. A new draft or a new revision of a
// thread replaces its older revisions that wait for the user, and a new draft supersedes the untouched open drafts.
export function placeReplies(
  db: Database,
  pr: number,
  items: NewItem[],
  { kept, revised }: { kept: Set<number>; revised: Map<number, number> },
): NewItem[] {
  const resolved = db.query(THREAD_RESOLVED);
  const out = items.flatMap((it): NewItem[] => {
    if (it.kind !== "reply" || it.thread === null) return [it];
    if (kept.has(it.thread)) return [];
    const shut = (resolved.get({ pr, thread: it.thread }) as { thread_resolved: number } | null)?.thread_resolved === 1;
    const of = revised.get(it.thread);
    const payload: ReplyPayload = { ...(JSON.parse(it.payload_json) as ReplyPayload), threadOpen: !shut };
    if (of === undefined) return [{ ...it, payload_json: JSON.stringify(payload) }];
    return [{ ...it, status: "discarded", payload_json: JSON.stringify({ ...payload, revises: of }) }];
  });
  const supersede = db.query(SUPERSEDE);
  const dropRevisions = db.query(DROP_REVISIONS);
  for (const thread of new Set(out.map((it) => it.thread))) {
    if (thread === null) continue;
    dropRevisions.run({ thread, pr });
    if (!revised.has(thread)) supersede.run({ thread, pr });
  }
  return out;
}

const WRITE = {
  thread: `SELECT comment_id AS id, root_id AS rootId, author_slug AS authorSlug, author_login AS authorLogin, created_at AS createdAt,
      tombstoned_at IS NOT NULL AS deleted, thread_resolved AS threadResolved FROM comment WHERE pr = $pr AND root_id = $root`,
  // SUPERSEDE by ID, so the new draft can name the drafts that it replaced (payload fix.replaced). Posted drafts stay.
  replaceable: `SELECT i.id FROM review_item i JOIN review_run r ON r.id = i.run
    WHERE r.pr = $pr AND i.kind = 'reply' AND i.thread = $thread AND i.status = 'new' AND i.edited = 0 ORDER BY i.id`,
  supersede: "UPDATE review_item SET status = 'discarded', revision = revision + 1 WHERE id = $id AND status = 'new'",
  item: `INSERT INTO review_item (run, kind, payload_json, body, status, thread, edited)
    VALUES ($run, 'reply', $payload, $body, 'new', $thread, 0)`,
  revision: `INSERT INTO review_item (run, kind, payload_json, body, status, thread, edited)
    VALUES ($run, 'reply', $payload, $body, 'discarded', $thread, 0)`,
  // The run records each thread where it kept the user's draft. A second write adds no second line.
  kept: `UPDATE review_run SET summary_json = json_insert(summary_json, '$.coverage.skipped[#]', $text)
    WHERE id = $run AND json_valid(summary_json) AND NOT EXISTS (SELECT 1 FROM json_each(summary_json, '$.coverage.skipped') WHERE value = $text)`,
};

// One writer draft of one thread, such as "Fixed in X: <what>". run: the run that owns the draft. line: the text after the kept answer.
// fix.id: the fix_commit row, null for a task commit. resolveEvidence: the proof of a resolve proposal, null for no proposal.
export type ThreadDraft = {
  pr: number;
  run: number;
  thread: number;
  line: string;
  reason: string;
  origin: ReplyOrigin;
  fix?: { id: number | null; commit: string };
  resolveEvidence: string | null;
};

// docs/plans/thread-outcome.md. The caller holds the transaction. The user asked for this write, so a discarded draft does not block it.
// A draft that the user declined the fix with stays, and the run records it. A draft that the user edited or accepted stays too, and
// the new text waits as its revision. Else the new draft keeps an untouched answer of a reply run above the line and supersedes the
// untouched open drafts. Only a thread that the user started gets the resolve tick by default. drafts: currentDrafts at the start.
export function writeThreadDraft(db: Database, drafts: Map<number, ItemRow>, me: string | null, d: ThreadDraft): void {
  const { pr, run, thread } = d;
  const msgs = db.query(WRITE.thread).all({ pr, root: thread }) as TurnMsg[];
  const last = newestLive(msgs);
  if (!last) return;
  const cur = drafts.get(thread);
  const mine = cur && touched(cur) ? cur : null;
  if (!mine && userDraft(cur, false)) {
    db.query(WRITE.kept).run({ run, text: keptText(thread) });
    return;
  }
  const was = cur?.status === "new" ? (JSON.parse(cur.payload_json) as ReplyPayload) : null;
  const answer = mine
    ? mine.body.trim()
    : was && !was.fix && was.origin !== "nofix" && was.origin !== "resolve"
      ? (cur?.body.trim() ?? "")
      : "";
  const replaced = mine ? [] : (db.query(WRITE.replaceable).all({ thread, pr }) as { id: number }[]).map((r) => r.id);
  for (const r of replaced) db.query(WRITE.supersede).run({ id: r });
  const root = msgs.find((m) => m.id === thread);
  const body = answer ? `${answer}\n\n${d.line}` : d.line;
  const resolve = d.resolveEvidence !== null;
  const payload: ReplyPayload = {
    thread,
    action: "reply",
    body,
    reason: d.reason,
    evidenceStatus: "code",
    judgement: null,
    replyTo: last.id,
    ...(d.fix && { fix: { ...d.fix, ...(replaced.length > 0 && { replaced }) } }),
    resolve,
    resolveEvidence: d.resolveEvidence ?? "",
    resolveTick: resolve && !!root && isMe({ slug: root.authorSlug, login: root.authorLogin }, me),
    threadOpen: !msgs.some((m) => m.threadResolved),
    origin: d.origin,
    ...(mine && { revises: mine.id }),
  };
  const at = { run, payload: JSON.stringify(payload), body, thread };
  db.query(DROP_REVISIONS).run({ thread, pr });
  if (!mine) db.query(WRITE.item).run(at);
  else {
    db.query(WRITE.revision).run(at);
    db.query(WRITE.kept).run({ run, text: revisedText(thread) });
  }
}
