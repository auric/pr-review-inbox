// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task notifications: one needs_you event per new wait, claimed once (docs/plans/review-v2/spec.md section 6.11).
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/storage/db";
import { claimTaskEvents, noteTaskWaits } from "../../src/server/tasks/notify";
import { RUN_CANCELLED } from "../../src/shared/task";

console.log(`notify.test.ts imported from ${Bun.resolveSync("../../src/server/tasks/notify", import.meta.dir)}`);

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rl-task-notify-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const db = openDb(path);
  dbs.push(db);
  const { id } = db
    .query(`INSERT INTO task (project, repo, key, title, state, target_branch, spec_dir, created_at, updated_at)
      VALUES ('PROJ1', 'repo', 'ABC-1', 'Add a flag', 'implementing', 'main', 'specs/ABC-1/', 1, 1) RETURNING id`)
    .get() as { id: number };
  const set = (state: string, blocked: object | null) =>
    db
      .query("UPDATE task SET state = $state, blocked_json = $b WHERE id = $id")
      .run({ id, state, b: blocked === null ? null : JSON.stringify(blocked) });
  const count = () => (db.query("SELECT COUNT(*) AS n FROM task_event WHERE kind = 'needs_you'").get() as { n: number }).n;
  return { db, path, id, set, count };
}

describe("noteTaskWaits", () => {
  test("a new wait adds one event; the same wait adds none; the wait after the task moved on adds one", () => {
    const h = setup();
    expect(noteTaskWaits(h.db, [h.id], 10)).toBe(false);
    h.set("implementing", { kind: "red", step: 4, text: "The tests stay red." });
    expect(noteTaskWaits(h.db, [h.id], 11)).toBe(true);
    expect(noteTaskWaits(h.db, [h.id], 12)).toBe(false);
    expect(h.count()).toBe(1);
    h.set("implementing", null);
    expect(noteTaskWaits(h.db, [h.id], 13)).toBe(false);
    h.set("implementing", { kind: "red", step: 4, text: "The tests stay red." });
    expect(noteTaskWaits(h.db, [h.id], 14)).toBe(true);
    expect(h.count()).toBe(2);
  });

  test("a Stop of the user, a cancelled run, and the run slot give no event; a failed run does", () => {
    const h = setup();
    h.set("stopped", null);
    expect(noteTaskWaits(h.db, [h.id], 10)).toBe(false);
    h.set("stopped", { kind: "error", step: 3, text: RUN_CANCELLED });
    expect(noteTaskWaits(h.db, [h.id], 11)).toBe(false);
    h.set("implementing", { kind: "slot", step: null, text: "Waiting for the run slot." });
    expect(noteTaskWaits(h.db, [h.id], 12)).toBe(false);
    h.set("stopped", { kind: "error", step: 3, text: "The usage limit is reached." });
    expect(noteTaskWaits(h.db, [h.id], 13)).toBe(true);
  });

  test("after a restart, a wait that goes on adds no event", () => {
    const h = setup();
    h.set("implementing", { kind: "question", step: 7, text: "Which flag name?" });
    expect(noteTaskWaits(h.db, [h.id], 10)).toBe(true);
    const again = openDb(h.path);
    dbs.push(again);
    expect(noteTaskWaits(again, [h.id], 11)).toBe(false);
    expect(h.count()).toBe(1);
  });

  test("each new reason, first or waiting in a part row, adds one event; a reason that moves up adds none (spec.md section 6.25.7)", () => {
    const h = setup();
    const part = (ord: number) =>
      (
        h.db
          .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
            VALUES ($task, $ord, 'single', 'Part', $branch, 'main', 'implementing', 1, 1) RETURNING id`)
          .get({ task: h.id, ord, branch: `feature/ABC-${ord}` }) as { id: number }
      ).id;
    const [p1, p2, p3] = [part(1), part(2), part(3)];
    const wait = (id: number, b: object | null) =>
      h.db.query("UPDATE task_part SET blocked_json = $b WHERE id = $id").run({ id, b: b === null ? null : JSON.stringify(b) });
    const q1 = { kind: "question", step: 4, text: "Needs you: Claude asks: one?" };
    const q2 = { kind: "question", step: 5, text: "Needs you: Claude asks: two?" };
    const c3 = { kind: "spec_change", step: 6, text: "Needs you: Claude proposes a change to the spec." };
    h.set("implementing", q1);
    expect(noteTaskWaits(h.db, [h.id], 10)).toBe(true);
    wait(p2, q2);
    expect(noteTaskWaits(h.db, [h.id], 11)).toBe(true);
    wait(p3, c3);
    expect(noteTaskWaits(h.db, [h.id], 12)).toBe(true);
    expect(noteTaskWaits(h.db, [h.id], 13)).toBe(false);
    expect(h.count()).toBe(3);
    // One answer ends q1 and q2. The plan change of part 3 moves up: no event, also after a restart.
    wait(p2, null);
    wait(p3, null);
    h.set("implementing", c3);
    expect(noteTaskWaits(h.db, [h.id], 14)).toBe(false);
    const again = openDb(h.path);
    dbs.push(again);
    expect(noteTaskWaits(again, [h.id], 15)).toBe(false);
    expect(h.count()).toBe(3);
    // A new reason of part 1 behind it adds one event.
    wait(p1, { kind: "red", step: 7, text: "Needs you: the tests of part 1 stay red." });
    expect(noteTaskWaits(again, [h.id], 16)).toBe(true);
    expect(claimTaskEvents(again, 17).at(-1)?.text).toBe("Needs you: a change to the plan, and 1 more");
  });
});

describe("claimTaskEvents", () => {
  test("each event is claimed once, with the task list status; a task that no longer waits gives none", () => {
    const h = setup();
    h.set("implementing", { kind: "red", step: 4, text: "The tests stay red." });
    noteTaskWaits(h.db, [h.id], 10);
    expect(claimTaskEvents(h.db, 20)).toEqual([
      {
        id: expect.any(Number),
        task: h.id,
        kind: "needs_you",
        createdAt: 10,
        key: "ABC-1",
        title: "Add a flag",
        text: "Needs you: tests stay red",
      },
    ]);
    expect(claimTaskEvents(h.db, 21)).toEqual([]);
    h.set("implementing", { kind: "push", step: 5, text: "The push failed." });
    noteTaskWaits(h.db, [h.id], 22);
    h.set("implementing", null);
    expect(claimTaskEvents(h.db, 23)).toEqual([]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM task_event WHERE claimed_at IS NULL").get()).toEqual({ n: 0 });
  });
});
