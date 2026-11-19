// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The checklist of the steps outside Claude (docs/plans/task-builder-v2.md sections 5.2, 5.4, and 11.4): the rows of the approved plan,
// the plan tasks that a build run moved here, and the state changes. advanceExternal is the only writer of task_external.state.
import type { Database } from "bun:sqlite";
import { initialTransition, transition } from "xstate";
import type { TaskExternalDto } from "../../shared/dto";
import { type ExternalKind, type ExternalState, externalOwner } from "../../shared/task";
import { type ExternalEvent, externalMachine } from "./machine";
import type { PlanExternal } from "./plan";
import { type Advanced, TASK_CHANGED, type TaskRef } from "./tasks";

const SQL = {
  rows: "SELECT * FROM task_external WHERE task = $task ORDER BY ord",
  // One row per moved plan task: "Start this part again" resets the plan file, and the next run can move the task again.
  add: `INSERT INTO task_external (task, part, ord, kind, title, why, host, plan_task, state, created_at)
    SELECT $task, $part, (SELECT COALESCE(MAX(ord), 0) + 1 FROM task_external WHERE task = $task), $kind, $title, $why, $host, $planTask,
      $state, $now
    WHERE $planTask IS NULL OR NOT EXISTS (SELECT 1 FROM task_external WHERE task = $task AND plan_task = $planTask)`,
  dropPlanned: "DELETE FROM task_external WHERE task = $task AND plan_task IS NULL",
  moved: "SELECT plan_task FROM task_external WHERE task = $task AND plan_task IS NOT NULL",
  open: "SELECT 1 FROM task_external WHERE task = $task AND state = 'open' LIMIT 1",
  row: "SELECT x.state, t.version FROM task_external x JOIN task t ON t.id = x.task WHERE x.id = $item AND x.task = $task",
  set: "UPDATE task_external SET state = $state, by = $by, at = $now WHERE id = $item",
  bump: "UPDATE task SET version = version + 1, updated_at = $now WHERE id = $id AND version = $version",
};

type ExternalRow = {
  id: number;
  part: number | null;
  kind: ExternalKind;
  title: string;
  why: string;
  host: string;
  plan_task: string | null;
  state: ExternalState;
  by: "user" | "app" | null;
  at: number | null;
};

// part: the plan part number. planTask: the moved plan task, null for a step of the approved plan.
export type NewExternal = { part: number | null; kind: ExternalKind; title: string; why: string; host: string; planTask: string | null };

// The insert of each row in state open (ADD). A moved plan task that has a row already gets none. Returns the count of new rows.
export function addExternal(db: Database, task: number, rows: readonly NewExternal[], now: number): number {
  const state = String(initialTransition(externalMachine)[0].value);
  let n = 0;
  for (const r of rows) n += db.query(SQL.add).run({ task, ...r, state, now }).changes;
  return n;
}

// The approval (section 5.2): the rows of the plan replace the rows of an earlier approval. The moved plan tasks stay. Call it in the
// transaction of APPROVE.
export function approveExternal(db: Database, task: number, external: readonly PlanExternal[], now: number) {
  db.query(SQL.dropPlanned).run({ task });
  addExternal(
    db,
    task,
    external.map((e) => ({ part: e.after, kind: e.kind, title: e.title, why: e.why, host: e.host, planTask: null })),
    now,
  );
}

// The plan tasks that the app moved to the checklist. Only these may carry `[-]` in the plan file (loop.ts tickDiff).
export const movedTasks = (db: Database, task: number): Set<string> =>
  new Set((db.query(SQL.moved).all({ task }) as { plan_task: string }[]).map((r) => r.plan_task));

export const openChecklist = (db: Database, task: number) => db.query(SQL.open).get({ task }) !== null;

export const externalDtos = (db: Database, task: number): TaskExternalDto[] =>
  (db.query(SQL.rows).all({ task }) as ExternalRow[]).map((r) => ({
    id: r.id,
    part: r.part,
    kind: r.kind,
    owner: externalOwner(r.kind),
    title: r.title,
    why: r.why,
    host: r.host,
    planTask: r.plan_task,
    state: r.state,
    by: r.by,
    at: r.at,
  }));

// Section 11.4: one event of a checklist row. A refused event writes nothing. The change raises the task version.
export function advanceExternal(
  db: Database,
  ref: TaskRef & { item: number },
  event: ExternalEvent,
  by: "user" | "app",
  now = Date.now(),
): Advanced<ExternalState> {
  return db.transaction((): Advanced<ExternalState> => {
    const row = db.query(SQL.row).get({ item: ref.item, task: ref.task }) as { state: ExternalState; version: number } | null;
    if (!row) return { status: 404, error: "The checklist has no such step." };
    if (row.version !== ref.version) return { status: 409, error: TASK_CHANGED, state: row.state, version: row.version };
    const snapshot = externalMachine.resolveState({ value: row.state, context: {} });
    if (!snapshot.can(event)) return { status: 409, error: STATE_TEXT[row.state], state: row.state, version: row.version };
    const state = transition(externalMachine, snapshot, event)[0].value as ExternalState;
    if (db.query(SQL.bump).run({ id: ref.task, version: ref.version, now }).changes !== 1) throw new Error(TASK_CHANGED);
    db.query(SQL.set).run({ item: ref.item, state, by, now });
    return { status: 200, state, version: ref.version + 1 };
  })();
}

const STATE_TEXT: Record<ExternalState, string> = {
  open: "This step is open.",
  done: "This step is done.",
  waived: "This step is waived.",
};
