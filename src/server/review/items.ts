// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Triage of review items (plan v3 WP12): accept, discard, restore, edit, move, and the resolve tick of a reply draft.
// docs/plans/review-v2/spec.md section 4.1: the discard reason of a finding.
// docs/plans/thread-outcome.md: Use revision and Keep mine for a revision of the user's draft, and Reply to the newest as is.
// docs/plans/review-v2/spec.md sections 2.2 and 2.5: Use the new text and Keep mine for a revision of a finding, and the restore of a
// withdrawn finding.
import type { Database } from "bun:sqlite";
import type { ItemActionInput, ItemConflict, ReviewItemDto } from "../../shared/dto";
import {
  type AnchoredFinding,
  type AnchorState,
  diffLine,
  type ExcerptLine,
  type FindingPayload,
  type FixedMark,
  moveChoices,
  type ReplyPayload,
  type SessionMark,
  type WithdrawnMark,
} from "../../shared/review";
import { newestLive, type TurnMsg } from "../../shared/turn";
import { replyCurrent } from "../publish/outbox";
import { type ItemRow, revisions, toItemDto, withRevision } from "./jobs";
import { RUN_COLS } from "./run-rows";

// runs: other runs whose items changed, so their run details reload.
export type TriageResult =
  | { status: 200; item: ReviewItemDto; pr: number; runs?: number[] }
  | { status: 404 }
  | { status: 400; error: string }
  | { status: 409; conflict: ItemConflict };

const SQL = {
  // An item of a task run (pr NULL) takes no PR action.
  item: `SELECT i.*, r.pr, ${RUN_COLS} FROM review_item i JOIN review_run r ON r.id = i.run WHERE i.id = $id AND r.pr IS NOT NULL`,
  // The revision check and the write are one statement, so two pages cannot both win.
  update: `UPDATE review_item SET status = $status, body = $body, edited = $edited, line = $line, line_end = $line_end,
      anchor_state = $anchor_state, payload_json = $payload_json, revision = revision + 1
    WHERE id = $id AND revision = $revision AND status != 'posted'`,
  undone: "SELECT 1 FROM fix_commit WHERE id = $id AND state = 'undone'",
  pushed: "SELECT 1 FROM pr_commit WHERE pr = $pr AND hash = $hash",
  // also: a second draft that the action leaves out of the check, because the same action discards it.
  otherOpen: `SELECT 1 FROM review_item i JOIN review_run r ON r.id = i.run
    WHERE r.pr = $pr AND i.kind = 'reply' AND i.thread = $thread AND i.id <> $id AND i.id <> $also AND i.status IN ('new', 'accepted')`,
  // Keep mine. shared/review.ts says why the row stays.
  dropRevision: `UPDATE review_item SET payload_json = json_set(payload_json, '$.dropped', json('true')), revision = revision + 1
    WHERE id = $id AND revision = $revision AND status = 'discarded' AND json_extract(payload_json, '$.revises') IS NOT NULL
      AND json_extract(payload_json, '$.dropped') IS NULL`,
  discardMine: `UPDATE review_item SET status = 'discarded', payload_json = json_set(payload_json, '$.discardedBy', 'user'),
      revision = revision + 1 WHERE id = $id AND revision = $revision AND status IN ('new', 'accepted')`,
  thread: `SELECT comment_id AS id, root_id AS rootId, author_slug AS authorSlug, author_login AS authorLogin, created_at AS createdAt,
      tombstoned_at IS NOT NULL AS deleted, thread_resolved AS threadResolved FROM comment WHERE pr = $pr AND root_id = $root`,
};

type Row = ItemRow & { pr: number };

const CHANGED = "The item changed on another page. Check it again.";
// Thrown inside a transaction, it undoes the writes before it.
const ROLLBACK = new Error("rollback");

// at: the time (ms) that touchedAt records.
export function triage(db: Database, id: number, input: ItemActionInput, at = Date.now()): TriageResult {
  const row = db.query(SQL.item).get({ id }) as Row | null;
  if (!row) return { status: 404 };
  const dto = (r: Row) => (r.kind === "reply" || r.kind === "finding" ? withRevision(r, revisions(db, r.pr)) : toItemDto(r));
  const conflict = (error: string): TriageResult => ({ status: 409, conflict: { error, item: dto(row) } });
  if (row.status === "posted") return conflict("The item is posted.");
  if (row.revision !== input.revision) return conflict(CHANGED);

  const revisionAction = input.action === "use-revision" || input.action === "keep-mine";
  // Plan r2 S-RR: a carried finding whose code is gone has no anchor. The post plan cannot place it. A revision of such a finding
  // copies its place, so Use the new text and Keep mine still work.
  if (
    row.kind === "finding" &&
    input.action !== "discard" &&
    input.action !== "reason" &&
    !revisionAction &&
    (row.path === null || row.side === null || row.line === null)
  )
    return { status: 400, error: "The finding has no place in the code." };
  const next = { ...row };
  const reply = row.kind === "reply" ? (JSON.parse(row.payload_json) as ReplyPayload) : null;
  const finding = row.kind === "finding" ? (JSON.parse(row.payload_json) as FindingPayload) : null;
  const ticked = reply?.resolveTick === true;
  // A "Fixed in" draft of an undone commit can never post (outbox.ts fixCheck), so it stays discarded.
  if (reply?.fix && input.action !== "discard" && input.action !== "keep-mine" && db.query(SQL.undone).get({ id: reply.fix.id }))
    return conflict("The fix commit was undone, so this draft cannot post. Draft the reply again.");
  // A waiting revision takes only Use revision and Keep mine. Its own triage would break the one-open-draft rule. A revision of a
  // finding is no finding of its own (docs/plans/review-v2/spec.md section 2.2).
  if (reply?.revises !== undefined && !revisionAction) return { status: 400, error: "Use the revision or keep your draft first." };
  if (finding?.revises !== undefined && !revisionAction) return { status: 400, error: "Use the new text or keep yours first." };
  if (reply?.dropped || finding?.dropped) return conflict("A newer revision or Keep mine dropped this revision.");
  // docs/plans/thread-outcome.md P9: an out-of-date draft cannot post (outbox.ts blockedDrafts), so no action approves its text.
  const approves = input.action === "accept" || input.action === "edit" || input.action === "plain";
  // docs/plans/review-v3.md D1: the app never posts a pre-existing finding (publish/plan.ts skips it too).
  if (finding?.preexisting === true && approves) return { status: 400, error: "A pre-existing finding is never posted." };
  if (reply && approves && !replyCurrent(db, row.pr, reply.replyTo))
    return conflict("New messages arrived after this draft. Draft it again, or reply to the newest as is.");
  // One open draft per thread.
  const opens =
    row.status === "discarded" &&
    (input.action === "accept" || input.action === "restore" || input.action === "edit" || input.action === "plain");
  if (reply && opens && db.query(SQL.otherOpen).get({ pr: row.pr, thread: row.thread, id, also: id }))
    return conflict("Another reply draft of this thread is open. Discard it first.");
  switch (input.action) {
    case "accept":
      // A reply draft with action none has no body. A ticked draft without a body only resolves the thread.
      if (row.kind === "reply" && !row.body.trim() && !ticked)
        return { status: 400, error: "Write the reply first, or tick Resolve after posting." };
      next.status = "accepted";
      if (reply) next.payload_json = JSON.stringify({ ...reply, touchedAt: at } satisfies ReplyPayload);
      break;
    case "discard":
      next.status = "discarded";
      if (reply) next.payload_json = JSON.stringify({ ...reply, discardedBy: "user" } satisfies ReplyPayload);
      // A new discard asks for a new reason.
      else if (row.kind === "finding") {
        const { discardReason: _, ...rest } = JSON.parse(row.payload_json) as FindingPayload & { discardReason?: unknown };
        next.payload_json = JSON.stringify(rest);
      }
      break;
    case "reason": {
      const p = JSON.parse(row.payload_json) as FindingPayload;
      if (row.kind !== "finding" || row.status !== "discarded" || p.discardedBy === "verify")
        return { status: 400, error: "Only a finding that you discarded takes a reason." };
      next.payload_json = JSON.stringify({ ...p, discardReason: { code: input.code } });
      break;
    }
    case "restore": {
      // docs/plans/fix-ux.md decision 3: a restore of a finding that a fix commit discarded returns its earlier status. The mark stays.
      // session-consult.md part C: a session reject discards only open findings, so its mark is newer than a fixed mark. The restore
      // returns its status and removes it.
      // A "Don't fix" decline (fix-routes.ts) is newer than a fixed mark: a declined proposal has no commit.
      // docs/plans/review-v2/spec.md section 1.8: a restore of a refuted or duplicate finding removes discardedBy and keeps verify.
      // spec.md section 2.2: a restore of a withdrawn finding returns its earlier status and keeps the mark as restored. A discuss run
      // withdraws only open findings, so an unrestored mark is the newest discard.
      const p = JSON.parse(row.payload_json) as {
        fixed?: FixedMark;
        session?: SessionMark;
        declined?: { was: ReviewItemDto["status"] };
        discardedBy?: string;
        withdrawn?: WithdrawnMark;
      };
      const rejected = row.status === "discarded" && p.session?.verdict === "reject" ? p.session : null;
      const withdrawn = row.status === "discarded" && p.withdrawn && !p.withdrawn.restored ? p.withdrawn : null;
      next.status = row.status === "discarded" ? (rejected?.was ?? p.declined?.was ?? withdrawn?.was ?? p.fixed?.was ?? "new") : "new";
      if (rejected) {
        const { session: _, ...rest } = p;
        next.payload_json = JSON.stringify(rest);
      } else if (row.kind === "finding" && p.discardedBy === "verify") {
        const { discardedBy: _, ...rest } = p as typeof p & Pick<FindingPayload, "verify" | "ownVerify">;
        // thorough-review.md D2: a restored copy of a Thorough review gets back the verdict of its own run.
        if (rest.verify?.by === "app" && rest.ownVerify) {
          const { ownVerify, ...kept } = rest;
          next.payload_json = JSON.stringify({ ...kept, verify: ownVerify });
        } else next.payload_json = JSON.stringify(rest);
      } else if (withdrawn) next.payload_json = JSON.stringify({ ...p, withdrawn: { ...withdrawn, restored: true } });
      break;
    }
    case "edit":
      next.status = "accepted";
      next.body = input.body;
      next.edited = 1;
      if (reply) next.payload_json = JSON.stringify({ ...reply, touchedAt: at } satisfies ReplyPayload);
      break;
    case "move": {
      if (row.kind !== "finding" || row.side === null || row.excerpt_json === null)
        return { status: 400, error: "Only a finding can move." };
      const excerpt = JSON.parse(row.excerpt_json) as ExcerptLine[];
      if (!moveChoices(excerpt, row.side).includes(input.line)) return { status: 400, error: "The line is not in the code excerpt." };
      const found = (JSON.parse(row.payload_json) as AnchoredFinding).anchor;
      // Back on the validator's line, the validator's state applies again.
      const state: AnchorState =
        input.line === found.line && input.line === found.lineEnd
          ? found.state
          : diffLine(excerpt, row.side, input.line)
            ? "exact"
            : "outside";
      next.line = input.line;
      next.line_end = input.line;
      next.anchor_state = state;
      break;
    }
    case "resolve": {
      if (row.kind !== "reply") return { status: 400, error: "Only a reply draft can resolve its thread." };
      next.payload_json = JSON.stringify({ ...(JSON.parse(row.payload_json) as ReplyPayload), resolveTick: input.resolve });
      // An accepted draft without a body has nothing to post once the tick is off.
      if (!input.resolve && !row.body.trim() && row.status === "accepted") next.status = "new";
      break;
    }
    case "plain": {
      // docs/plans/thread-outcome.md: a rebased or squashed fix commit never reaches the PR. Without the link, the draft posts as a reply.
      if (!reply?.fix) return { status: 400, error: "Only a Fixed in draft can become a plain reply." };
      if (db.query(SQL.pushed).get({ pr: row.pr, hash: reply.fix.commit }))
        return { status: 400, error: "The commit is on the pull request. The draft posts as it is." };
      const { fix: _, ...rest } = reply;
      next.payload_json = JSON.stringify({ ...rest, origin: "user", touchedAt: at } satisfies ReplyPayload);
      next.status = "accepted";
      break;
    }
    case "use-revision":
      return finding ? takeFindingRevision(db, row, finding, input.draft) : takeRevision(db, row, reply, input.draft, at);
    case "keep-mine": {
      const of = reply?.revises ?? finding?.revises;
      if (of === undefined) return { status: 400, error: "Only a revision of your draft can go." };
      if (!db.query(SQL.dropRevision).run({ id, revision: input.revision }).changes) return conflict(CHANGED);
      const mine = db.query(SQL.item).get({ id: of }) as Row | null;
      return { status: 200, item: mine ? dto(mine) : toItemDto(row), pr: row.pr, runs: [row.run] };
    }
    case "reply-to-newest": {
      if (!reply || row.thread === null || (row.status !== "new" && row.status !== "accepted"))
        return { status: 400, error: "Only an open reply draft can answer the newest message." };
      if (!row.body.trim()) return { status: 400, error: "The draft has no text. Write the reply first." };
      const msgs = db.query(SQL.thread).all({ pr: row.pr, root: row.thread }) as TurnMsg[];
      const last = newestLive(msgs);
      if (!last) return conflict("The thread has no live message.");
      if (last.id === reply.replyTo) return conflict("The draft answers the newest message already.");
      // A draft written while the thread was resolved keeps reopen-first (threadOpen false). A thread resolved after the draft
      // keeps the draft out of the post until the user reopens it (outbox.ts blockedDrafts).
      if (reply.threadOpen === true && msgs.some((m) => m.threadResolved))
        return conflict("The thread was resolved after the draft. Reopen the thread first.");
      next.payload_json = JSON.stringify({ ...reply, replyTo: last.id, touchedAt: at } satisfies ReplyPayload);
      break;
    }
  }
  const done = db.query(SQL.update).run({
    id,
    revision: input.revision,
    status: next.status,
    body: next.body,
    edited: next.edited,
    line: next.line,
    line_end: next.line_end,
    anchor_state: next.anchor_state,
    payload_json: next.payload_json,
  });
  const now = db.query(SQL.item).get({ id }) as Row;
  if (!done.changes) return { status: 409, conflict: { error: CHANGED, item: dto(now) } };
  return { status: 200, item: dto(now), pr: row.pr };
}

// docs/plans/thread-outcome.md: the revision becomes the draft, not accepted. The user's draft is discarded in the same transaction.
// The user's resolve tick stays. A revision of a "Fixed in" draft names the user's draft in fix.replaced, so Undo of the commit brings
// it back. A revision without text and without a resolve means no reply, so it stays discarded as the user's choice.
function takeRevision(db: Database, row: Row, reply: ReplyPayload | null, draft: number, at: number): TriageResult {
  const conflict = (error: string): TriageResult => ({ status: 409, conflict: { error, item: toItemDto(row) } });
  if (reply?.revises === undefined) return { status: 400, error: "Only a revision of your draft can replace it." };
  const mine = db.query(SQL.item).get({ id: reply.revises }) as Row | null;
  if (!mine || (mine.status !== "new" && mine.status !== "accepted"))
    return conflict("Your draft is not open now. Keep mine drops the revision.");
  if (mine.revision !== draft) return conflict("Your draft changed on another page. Check it again.");
  if (db.query(SQL.otherOpen).get({ pr: row.pr, thread: row.thread, id: row.id, also: mine.id }))
    return conflict("Another reply draft of this thread is open. Discard it first.");
  const was = JSON.parse(mine.payload_json) as ReplyPayload;
  const { revises: _, discardedBy: __, ...rest } = reply;
  const open = row.body.trim() !== "" || !!reply.resolve;
  const payload: ReplyPayload = {
    ...rest,
    revisionOf: mine.id,
    touchedAt: at,
    ...(was.resolveTick !== undefined && { resolveTick: was.resolveTick }),
    ...(rest.fix && { fix: { ...rest.fix, replaced: [...(rest.fix.replaced ?? []), mine.id] } }),
    ...(!open && { discardedBy: "user" as const }),
  };
  const swap = db.transaction(() => {
    if (!db.query(SQL.discardMine).run({ id: mine.id, revision: draft }).changes) return false;
    const r = db.query(SQL.update).run({
      id: row.id,
      revision: row.revision,
      status: open ? "new" : "discarded",
      body: row.body,
      edited: 0,
      line: null,
      line_end: null,
      anchor_state: null,
      payload_json: JSON.stringify(payload),
    });
    if (r.changes) return true;
    throw ROLLBACK;
  });
  let done = false;
  try {
    done = swap();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  if (!done) return conflict(CHANGED);
  const now = db.query(SQL.item).get({ id: row.id }) as Row;
  return { status: 200, item: withRevision(now, revisions(db, now.pr)), pr: row.pr, runs: [mine.run] };
}

// docs/plans/review-v2/spec.md section 2.5: Use the new text of a finding. The finding takes the severity, title, and body of the
// revision in place, so its ID, place, posts, and talk stay. It becomes new, not accepted, and not edited. The revision stops waiting.
// draft: the finding revision on screen.
function takeFindingRevision(db: Database, row: Row, rev: FindingPayload, draft: number): TriageResult {
  const conflict = (error: string): TriageResult => ({ status: 409, conflict: { error, item: toItemDto(row) } });
  if (rev.revises === undefined) return { status: 400, error: "Only a new text of a finding can replace it." };
  const mine = db.query(SQL.item).get({ id: rev.revises }) as Row | null;
  if (!mine || (mine.status !== "new" && mine.status !== "accepted"))
    return conflict("The finding is not open now. Keep mine drops the new text.");
  if (mine.revision !== draft) return conflict("The finding changed on another page. Check it again.");
  const was = JSON.parse(mine.payload_json) as FindingPayload;
  const payload: FindingPayload = { ...was, severity: rev.severity, title: rev.title, body: rev.body, revisedBy: row.id };
  const swap = db.transaction(() => {
    if (!db.query(SQL.dropRevision).run({ id: row.id, revision: row.revision }).changes) return false;
    const r = db.query(SQL.update).run({
      id: mine.id,
      revision: draft,
      status: "new",
      body: row.body,
      edited: 0,
      line: mine.line,
      line_end: mine.line_end,
      anchor_state: mine.anchor_state,
      payload_json: JSON.stringify(payload),
    });
    if (r.changes) return true;
    throw ROLLBACK;
  });
  let done = false;
  try {
    done = swap();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  if (!done) return conflict(CHANGED);
  const now = db.query(SQL.item).get({ id: mine.id }) as Row;
  return { status: 200, item: withRevision(now, revisions(db, now.pr)), pr: row.pr, runs: [mine.run] };
}
