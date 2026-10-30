// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The part gate and the part events of the sync (docs/plans/review-v2/spec.md sections 6.10, 6.20.7, and 6.20.11). Nothing here
// pushes, posts, or reads a server: the sync wrote every fact to SQLite before.
import type { Database } from "bun:sqlite";
import type { PartState } from "../../shared/task";
import { buildOf } from "../inbox/builds";
import type { PartEvent } from "./machine";
import {
  advance,
  advancePart,
  lowerHowOf,
  lowerOf,
  type PartRow,
  repoSettings,
  scheduleOf,
  type TaskRow,
  taskRow,
  taskSettingsOf,
} from "./tasks";

export type PartGate = { pass: boolean; why: string };

const SQL = {
  pr: "SELECT state, reviewers_json FROM pull_request WHERE id = $id",
  // The parts of open tasks that follow one of the changed PRs.
  linked: `SELECT p.id, p.task, p.pr, r.state AS pr_state FROM task_part p JOIN task t ON t.id = p.task JOIN pull_request r ON r.id = p.pr
    WHERE p.pr IN (SELECT value FROM json_each($prs)) AND t.state NOT IN ('done', 'failed') ORDER BY p.task, p.ord`,
  parts: "SELECT * FROM task_part WHERE task = $id ORDER BY ord",
  states: "SELECT state FROM task_part WHERE task = $id",
};

const WAITS_PR = new Set<PartState>(["planned", "implementing", "self_reviewed"]);

type Reviewer = { name: string; status: string };

const reviewersOf = (json: string | null): Reviewer[] => (json === null ? [] : (JSON.parse(json) as Reviewer[]));
const asksOf = (list: Reviewer[]) => list.filter((r) => r.status === "NEEDS_WORK").map((r) => r.name);

export const approvalsOf = (db: Database, t: TaskRow) => taskSettingsOf(t).approvals ?? repoSettings(db, t.project, t.repo).approvals;

// null: the part has no open PR. A pr_build row of an older head counts as not read (spec.md section 6.10). The sync stores no
// properties.openTaskCount, so no task rule applies (section 6.20.11).
export function partGate(db: Database, part: { pr: number | null }, approvals: number): PartGate | null {
  if (part.pr === null) return null;
  const pr = db.query(SQL.pr).get({ id: part.pr }) as { state: string | null; reviewers_json: string | null } | null;
  if (pr?.state !== "OPEN") return null;
  const reviewers = reviewersOf(pr.reviewers_json);
  const asks = asksOf(reviewers);
  if (asks.length) return { pass: false, why: `${asks.join(", ")} ${asks.length === 1 ? "asks" : "ask"} for changes.` };
  const approved = reviewers.filter((r) => r.status === "APPROVED").length;
  if (approved < approvals) return { pass: false, why: `Waits for approvals: ${approved} of ${approvals}.` };
  const build = buildOf(db, part.pr);
  if (!build) return { pass: false, why: "The app has not read the builds of the newest commit yet." };
  if (build.counts.failed > 0) return { pass: false, why: "A build failed." };
  if (build.counts.inProgress > 0) return { pass: false, why: "A build runs." };
  return { pass: true, why: build.state === "none" ? "Approved. No builds reported." : "Approved. The builds passed." };
}

// The event of one part for the synced PR. The part machine refuses an event that its state does not take.
function eventOf(db: Database, part: { pr: number; pr_state: string | null }, approvals: number): PartEvent["type"] | null {
  if (part.pr_state === "MERGED") return "MERGED";
  if (part.pr_state === "DECLINED") return "DECLINED";
  const pr = db.query(SQL.pr).get({ id: part.pr }) as { reviewers_json: string | null } | null;
  if (asksOf(reviewersOf(pr?.reviewers_json ?? null)).length) return "CHANGES_REQUESTED";
  const gate = partGate(db, part, approvals);
  return gate === null ? null : gate.pass ? "GATE_PASSED" : "GATE_FAILED";
}

// spec.md section 6.20.11: after a sync cycle, the part events of the parts that follow the changed PRs, then LAST_PR_OPEN or
// ALL_MERGED of their tasks. Returns the IDs of the changed tasks.
export function syncParts(db: Database, prIds: readonly number[], now = Date.now()): number[] {
  if (!prIds.length) return [];
  const rows = db.query(SQL.linked).all({ prs: JSON.stringify(prIds) }) as {
    id: number;
    task: number;
    pr: number;
    pr_state: string | null;
  }[];
  const changed = new Set<number>();
  for (const r of rows)
    db.transaction(() => {
      const t = taskRow(db, r.task);
      const event = t && eventOf(db, r, approvalsOf(db, t));
      if (!t || !event) return;
      const a = advancePart(db, { task: t.id, version: t.version, part: r.id }, { type: event }, { gate: event === "GATE_PASSED" }, now);
      if (a.status === 200) changed.add(t.id);
    })();
  for (const id of changed)
    db.transaction(() => {
      const t = taskRow(db, id);
      if (!t) return;
      const states = (db.query(SQL.states).all({ id }) as { state: PartState }[]).map((p) => p.state);
      let version = t.version;
      if (t.state === "implementing" && !states.some((s) => WAITS_PR.has(s))) {
        const a = advance(db, { task: id, version }, { type: "LAST_PR_OPEN" }, {}, now);
        if (a.status === 200) version = a.version;
      }
      if (states.every((s) => s === "merged" || s === "abandoned")) advance(db, { task: id, version }, { type: "ALL_MERGED" }, {}, now);
    })();
  return [...changed];
}

// spec.md section 6.20.11: the loop starts only for a task in implementing, with no reason, and with a part that the scheduler starts.
export function startable(db: Database, id: number): boolean {
  const t = taskRow(db, id);
  if (t?.state !== "implementing" || t.blocked_json !== null) return false;
  return scheduleOf(db, t, db.query(SQL.parts).all({ id }) as PartRow[])?.start != null;
}

// spec.md section 6.20.10: a part whose lower part merged, while no base check told how it merged yet.
export function lowerUnread(db: Database, id: number): boolean {
  const t = taskRow(db, id);
  if (!t) return false;
  const rows = db.query(SQL.parts).all({ id }) as PartRow[];
  return rows.some((p) => lowerOf(db, t, p, rows) !== null && lowerHowOf(db, p.id) === null);
}
