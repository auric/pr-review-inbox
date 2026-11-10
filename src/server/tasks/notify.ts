// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task notifications (docs/plans/review-v2/spec.md section 6.11): kind needs_you only. One tab claims each event, as src/web/notify.ts.
import type { Database } from "bun:sqlite";
import type { ClaimedTaskEvent } from "../../shared/dto";
import { RUN_CANCELLED } from "../../shared/task";
import { rowStatus } from "../../shared/task-status";
import { rowDto, taskRow } from "./tasks";

const SQL = {
  last: "SELECT ref FROM task_event WHERE task = $task AND kind = 'needs_you' ORDER BY id DESC LIMIT 1",
  insert: "INSERT INTO task_event (task, kind, ref, created_at) VALUES ($task, 'needs_you', $ref, $now) ON CONFLICT DO NOTHING",
  // One statement, so two concurrent claims never return the same event.
  claim: "UPDATE task_event SET claimed_at = $now WHERE claimed_at IS NULL AND kind = 'needs_you' RETURNING id, task, created_at",
  waits: "SELECT json_extract(blocked_json, '$.step') AS step FROM task_part WHERE task = $task AND blocked_json IS NOT NULL ORDER BY ord",
};

// The wait of each task at its last check, per database. null: the task did not wait.
const seen = new WeakMap<Database, Map<number, string | null>>();

// The wait of the task, or null. A Stop of the user or a cancelled run is no wait to notify.
function waitOf(db: Database, id: number): { wait: string; text: string } | null {
  const t = taskRow(db, id);
  if (!t) return null;
  const row = rowDto(db, t);
  const s = rowStatus(row);
  if (!s.needsYou || row.closedAt !== null) return null;
  if (row.state === "stopped" && (row.blocked === null || row.blocked.text === RUN_CANCELLED)) return null;
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

// Adds a needs_you event for each task of ids that starts a new wait. true: an event went in, so the caller broadcasts "events".
// ref: the wait, "@", and the time. An equal wait after the task moved on gets a new row.
export function noteTaskWaits(db: Database, ids: Iterable<number>, now: number): boolean {
  const m = seen.get(db) ?? new Map<number, string | null>();
  seen.set(db, m);
  let added = false;
  for (const id of ids) {
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
    if (w !== null && db.query(SQL.insert).run({ task: id, ref: `${w}@${now}`, now }).changes) added = true;
  }
  return added;
}

// A task that no longer waits at claim time, or a removed task, stays claimed and gives no notification.
export function claimTaskEvents(db: Database, now: number): ClaimedTaskEvent[] {
  const rows = db.query(SQL.claim).all({ now }) as { id: number; task: number; created_at: number }[];
  const out: ClaimedTaskEvent[] = [];
  for (const r of rows.sort((a, b) => a.id - b.id)) {
    const t = taskRow(db, r.task);
    const w = t && waitOf(db, r.task);
    if (t && w) out.push({ id: r.id, task: r.task, kind: "needs_you", createdAt: r.created_at, key: t.key, title: t.title, text: w.text });
  }
  return out;
}
