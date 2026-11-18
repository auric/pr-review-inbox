// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Re-reviews (plan r2 S-RR): the carried items of the base run, their copies at the run end, and the resolve proposals.
import type { Database } from "bun:sqlite";
import { isMe } from "../../shared/me";
import type { Carried, ReplyPayload } from "../../shared/review";
import { newestLive, type TurnMsg } from "../../shared/turn";
import { currentDrafts } from "./drafts";
import { type ItemRow, type NewItem, NO_ANCHOR, SQL } from "./run-rows";
import type { CheckedEarlier } from "./validate";

// A re-review (plan r2 S-RR). since: the source head of the base run. sinceBase: its merge base.
// items: the findings and questions of the base run with status new or accepted at the start, and the accepted ones of the earlier
// review runs (docs/plans/review-v2/stale-drafts.md F2).
// posted: the posted inline findings of the PR with an open thread. root: the thread. run_head, run_base: the heads of their run.
export type PostedFinding = ItemRow & { root: number; run_head: string; run_base: string | null };
export type Carry = {
  base: number;
  since: string;
  sinceBase: string | null;
  incomplete: boolean;
  items: ItemRow[];
  posted: PostedFinding[];
};

export const current = (db: Database, rows: ItemRow[]) =>
  rows.flatMap((r) => (db.query(SQL.itemById).get({ id: r.id }) as ItemRow | null) ?? []);

// Plan r2 S-RR: the copies of the carried items, inside the run-end transaction. Each source becomes discarded.
// A source whose status changed during the run stays as it is.
export function carryOver(db: Database, carry: Carry, checked: CheckedEarlier[]) {
  const byId = new Map(checked.map((c) => [c.id, c]));
  const out = { open: [] as NewItem[], questions: [] as NewItem[], closed: [] as NewItem[] };
  for (const was of carry.items) {
    const r = db.query(SQL.itemById).get({ id: was.id }) as ItemRow | null;
    if (!r || r.status !== was.status) continue;
    const c = byId.get(r.id);
    const payload = JSON.parse(r.payload_json) as object;
    const keep = { body: r.body, edited: r.edited, thread: null };
    if (r.kind === "question") {
      const carried: Carried = { from: r.id, verdict: "open", reason: "", since: carry.since };
      out.questions.push({
        kind: "question",
        payload_json: JSON.stringify({ ...payload, carried }),
        ...NO_ANCHOR,
        status: r.status,
        ...keep,
      });
    } else if (c) {
      const carried: Carried = { from: r.id, verdict: c.verdict, reason: c.reason, since: carry.since };
      const a = c.anchor;
      const at = a
        ? {
            payload_json: JSON.stringify({ ...c.finding, anchor: a, carried }),
            path: a.path,
            side: c.finding.side,
            line: a.line,
            line_end: a.lineEnd,
            anchor_state: a.state,
            excerpt_json: JSON.stringify(a.excerpt),
          }
        : { payload_json: JSON.stringify({ ...payload, carried }), ...NO_ANCHOR };
      const open = c.verdict === "open";
      (open ? out.open : out.closed).push({ kind: "finding", ...at, status: open ? r.status : "discarded", ...keep });
    } else continue;
    db.query(SQL.carried).run({ id: r.id });
  }
  return out;
}

// A fixed verdict on a posted finding proposes to resolve its thread: a ticked draft without a reply.
// A thread with an open or a declined reply draft keeps that draft, so no proposal replaces the user's text or choice.
// threads: the messages by root ID.
export function resolveProposals(
  db: Database,
  pr: number,
  carry: Carry,
  checked: CheckedEarlier[],
  me: string | null,
  threads: Map<number, TurnMsg[]>,
): NewItem[] {
  const roots = new Map(carry.posted.map((r) => [r.id, r.root]));
  const drafts = currentDrafts(db, pr);
  const out: NewItem[] = [];
  for (const c of checked) {
    const thread = roots.get(c.id);
    const draft = thread === undefined ? undefined : drafts.get(thread);
    if (thread === undefined || c.verdict !== "fixed" || (draft && draft.status !== "posted")) continue;
    const msgs = threads.get(thread) ?? [];
    const root = msgs.find((m) => m.id === thread);
    const last = newestLive(msgs);
    if (!root || !last || msgs.some((m) => m.threadResolved) || !isMe({ slug: root.authorSlug, login: root.authorLogin }, me)) continue;
    const payload: ReplyPayload = {
      thread,
      action: "none",
      body: "",
      reason: c.reason,
      evidenceStatus: "code",
      judgement: null,
      replyTo: last.id,
      resolve: true,
      resolveEvidence: c.reason,
      resolveTick: true,
      threadOpen: true,
      origin: "resolve",
    };
    out.push({ kind: "reply", payload_json: JSON.stringify(payload), body: "", ...NO_ANCHOR, status: "new", thread, edited: 0 });
  }
  return out;
}
