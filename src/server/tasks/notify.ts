// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task notifications (docs/plans/review-v2/spec.md section 6.13): needs_you for a new wait or a stop by the restart recovery, part_ready
// for each part head that waits for its PR, and spec_approved. One tab claims each event, as src/web/notify.ts.
import type { Database } from "bun:sqlite";
import type { ClaimedTaskEvent } from "../../shared/dto";
import { RUN_CANCELLED, type TaskEventKind } from "../../shared/task";
import { rowStatus } from "../../shared/task-status";
import { RESTART_REF, rowDto, type TaskRow, taskRow } from "./tasks";

const SQL = {
  last: "SELECT ref FROM task_event WHERE task = $task AND kind = 'needs_you' ORDER BY id DESC LIMIT 1",
  insert: "INSERT INTO task_event (task, kind, ref, created_at) VALUES ($task, $kind, $ref, $now) ON CONFLICT DO NOTHING",
  // One statement, so two concurrent claims never return the same event.
  claim: "UPDATE task_event SET claimed_at = $now WHERE claimed_at IS NULL RETURNING id, task, kind, ref, created_at",
  waits: "SELECT json_extract(blocked_json, '$.step') AS step FROM task_part WHERE task = $task AND blocked_json IS NOT NULL ORDER BY ord",
  // A part waits for its PR only while no step of it waits or runs, such as "Fix these too" or an update.
  ready: `SELECT p.id, p.ord, p.head FROM task_part p WHERE p.task = $task AND p.kind <> 'spec' AND p.state = 'self_reviewed'
    AND NOT EXISTS (SELECT 1 FROM task_step s WHERE s.part = p.id AND s.state IN ('waiting', 'running')) ORDER BY p.ord`,
  spec: "SELECT head FROM task_part WHERE task = $task AND kind = 'spec' ORDER BY ord LIMIT 1",
};

export const RESTART_TEXT = "The app restarted and stopped this task. Resume continues it.";
export const SPEC_APPROVED_TEXT = "The spec is approved. You can start building.";
const readyText = (ord: number, parts: number) => `Part ${ord} of ${parts} is ready for its PR.`;

type Ready = { id: number; ord: number; head: string | null };
// spec.md section 6.13: the ref of part_ready is the part ID and its head, so a new head after a fix notifies again.
const readyRef = (p: Ready) => `${p.id}@${p.head ?? ""}`;
// The ref of spec_approved: the head of the spec PR.
const specRef = (db: Database, id: number) => (db.query(SQL.spec).get({ task: id }) as { head: string | null } | null)?.head ?? "";

// The wait of each task at its last check, per database. null: the task did not wait.
const seen = new WeakMap<Database, Map<number, string | null>>();

// The wait of the task, or null. A Stop of the user or a cancelled run is no wait to notify. A part that waits for its PR gives
// part_ready instead.
function waitOf(db: Database, id: number): { wait: string; text: string } | null {
  const t = taskRow(db, id);
  if (!t) return null;
  const row = rowDto(db, t);
  const s = rowStatus(row);
  if (!s.needsYou || row.closedAt !== null) return null;
  if (row.state === "stopped" && (row.blocked === null || row.blocked.text === RUN_CANCELLED)) return null;
  if (row.state === "implementing" && row.blocked === null && row.progress.ready) return null;
  // spec.md section 6.25.7: the steps of the reasons that wait in part rows. A wait without them keeps the old form.
  const queued = (db.query(SQL.waits).all({ task: id }) as { step: number | null }[]).map((r) => r.step ?? "");
  const wait = `${row.state}|${s.text}|${row.blocked?.step ?? ""}|${row.progress.part}${queued.length ? `|${queued.join(",")}` : ""}`;
  return { wait, text: s.text };
}

// The reasons of a wait by step: the first reason, then each waiting one.
const reasonsOf = (w: string) => {
  const f = w.split("|");
  return { state: f[0], steps: [f[2] ?? "", ...(f[4] ? f[4].split(",") : [])] };
};

// spec.md section 6.25.7: a reason that moved up after the user acted on the first one is no new wait. Its reasons are fewer than the
// last ones, and the last wait held each of them.
function movedUp(w: string, last: string): boolean {
  const a = reasonsOf(w);
  const b = reasonsOf(last);
  return a.state === b.state && a.steps.length < b.steps.length && a.steps.every((x) => b.steps.includes(x));
}

const insert = (db: Database, task: number, kind: TaskEventKind, ref: string, now: number) =>
  db.query(SQL.insert).run({ task, kind, ref, now }).changes > 0;

// Adds a needs_you event for each task of ids that starts a new wait, a part_ready event for each new head of a part that waits for its
// PR, and one spec_approved event for each head of the spec PR. true: an event went in, so the caller broadcasts "events".
// The ref of needs_you: the wait, "@", and the time. An equal wait after the task moved on gets a new row.
export function noteTaskWaits(db: Database, ids: Iterable<number>, now: number): boolean {
  const m = seen.get(db) ?? new Map<number, string | null>();
  seen.set(db, m);
  let added = false;
  for (const id of ids) {
    const t = taskRow(db, id);
    if (t && t.closed_at === null) {
      for (const p of db.query(SQL.ready).all({ task: id }) as Ready[]) if (insert(db, id, "part_ready", readyRef(p), now)) added = true;
      if (t.state === "spec_approved" && insert(db, id, "spec_approved", specRef(db, id), now)) added = true;
    }
    if (!m.has(id)) {
      // After a restart, the newest event gives the last wait, so a wait that goes on does not notify again.
      const last = db.query(SQL.last).get({ task: id }) as { ref: string } | null;
      m.set(id, last ? last.ref.slice(0, last.ref.lastIndexOf("@")) : null);
    }
    const w = waitOf(db, id)?.wait ?? null;
    const last = m.get(id) ?? null;
    if (w === last) continue;
    m.set(id, w);
    if (w !== null && last !== null && movedUp(w, last)) continue;
    if (w !== null && insert(db, id, "needs_you", `${w}@${now}`, now)) added = true;
  }
  return added;
}

type EventRow = { id: number; task: number; kind: TaskEventKind; ref: string; created_at: number };

// The text of an event that still holds at claim time, or null.
function eventText(db: Database, t: TaskRow, r: EventRow): string | null {
  if (t.closed_at !== null) return null;
  if (r.kind === "spec_approved") return t.state === "spec_approved" ? SPEC_APPROVED_TEXT : null;
  if (r.kind === "part_ready") {
    const p = (db.query(SQL.ready).all({ task: t.id }) as Ready[]).find((x) => readyRef(x) === r.ref);
    return p ? readyText(p.ord, rowDto(db, t).progress.parts) : null;
  }
  if (r.ref.startsWith(`${RESTART_REF}@`)) return t.state === "stopped" ? RESTART_TEXT : null;
  return waitOf(db, t.id)?.text ?? null;
}

// An event whose fact no longer holds at claim time, or of a removed task, stays claimed and gives no notification.
export function claimTaskEvents(db: Database, now: number): ClaimedTaskEvent[] {
  const rows = db.query(SQL.claim).all({ now }) as EventRow[];
  const out: ClaimedTaskEvent[] = [];
  for (const r of rows.sort((a, b) => a.id - b.id)) {
    const t = taskRow(db, r.task);
    const text = t && eventText(db, t, r);
    if (t && text) out.push({ id: r.id, task: r.task, kind: r.kind, createdAt: r.created_at, key: t.key, title: t.title, text });
  }
  return out;
}
