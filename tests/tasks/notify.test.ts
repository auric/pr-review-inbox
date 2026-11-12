// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task notifications: one needs_you event per new wait, part_ready, spec_approved, and the restart stop, each claimed once
// (docs/plans/review-v2/spec.md sections 6.11 and 6.13).
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/storage/db";
import { claimTaskEvents, noteTaskWaits, RESTART_TEXT, SPEC_APPROVED_TEXT } from "../../src/server/tasks/notify";
import { recoverTasks } from "../../src/server/tasks/tasks";
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
  const count = (kind = "needs_you") =>
    (db.query("SELECT COUNT(*) AS n FROM task_event WHERE kind = $kind").get({ kind }) as { n: number }).n;
  const part = (ord: number, state = "implementing", head: string | null = null) =>
    (
      db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, head, created_at, updated_at)
          VALUES ($task, $ord, 'single', 'Part', $branch, 'main', $state, $head, 1, 1) RETURNING id`)
        .get({ task: id, ord, branch: `feature/ABC-${ord}`, state, head }) as { id: number }
    ).id;
  return { db, path, id, set, count, part };
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
    const [p1, p2, p3] = [h.part(1), h.part(2), h.part(3)];
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

  test("AC-B242: each part that waits for its PR adds one part_ready event per head, and no needs_you event", () => {
    const h = setup();
    const p1 = h.part(1, "self_reviewed", "aaa");
    h.part(2);
    expect(noteTaskWaits(h.db, [h.id], 10)).toBe(true);
    expect(noteTaskWaits(h.db, [h.id], 11)).toBe(false);
    expect([h.count("part_ready"), h.count()]).toEqual([1, 0]);
    // "Fix these too" runs a step of the part: no event until it ends. The new head adds one.
    const step = h.db
      .query("INSERT INTO task_step (task, part, ord, kind, state, started_at) VALUES ($task, $part, 1, 'fix', 'running', 12) RETURNING id")
      .get({ task: h.id, part: p1 }) as { id: number };
    h.db.query("UPDATE task_part SET head = 'bbb' WHERE id = $id").run({ id: p1 });
    expect(noteTaskWaits(h.db, [h.id], 13)).toBe(false);
    h.db.query("UPDATE task_step SET state = 'ok' WHERE id = $id").run({ id: step.id });
    expect(noteTaskWaits(h.db, [h.id], 14)).toBe(true);
    expect(h.count("part_ready")).toBe(2);
    // Part 2 builds at the same time and gets ready later. It adds its own event.
    h.db.query("UPDATE task_part SET state = 'self_reviewed', head = 'ccc' WHERE task = $task AND ord = 2").run({ task: h.id });
    expect(noteTaskWaits(h.db, [h.id], 15)).toBe(true);
    expect(h.count("part_ready")).toBe(3);
    expect(h.count()).toBe(0);
  });

  test("AC-B243: a task in spec_approved adds one spec_approved event", () => {
    const h = setup();
    h.set("spec_approved", null);
    expect(noteTaskWaits(h.db, [h.id], 10)).toBe(true);
    expect(noteTaskWaits(h.db, [h.id], 11)).toBe(false);
    expect(claimTaskEvents(h.db, 12).map((e) => [e.kind, e.text])).toEqual([["spec_approved", SPEC_APPROVED_TEXT]]);
  });
});

describe("the restart recovery (AC-B244)", () => {
  test("a task that the recovery stops gets one needs_you event; the wait check adds no second one", () => {
    const h = setup();
    h.db
      .query("INSERT INTO task_step (task, ord, kind, state, started_at) VALUES ($task, 1, 'implement', 'running', 1)")
      .run({ task: h.id });
    recoverTasks(h.db, 50);
    recoverTasks(h.db, 51);
    expect(h.count()).toBe(1);
    const again = openDb(h.path);
    dbs.push(again);
    expect(noteTaskWaits(again, [h.id], 52)).toBe(false);
    expect(claimTaskEvents(again, 53)).toEqual([
      { id: expect.any(Number), task: h.id, kind: "needs_you", createdAt: 50, key: "ABC-1", title: "Add a flag", text: RESTART_TEXT },
    ]);
  });

  test("a task that the user resumed before the claim gives no notification", () => {
    const h = setup();
    h.db
      .query("INSERT INTO task_step (task, ord, kind, state, started_at) VALUES ($task, 1, 'implement', 'running', 1)")
      .run({ task: h.id });
    recoverTasks(h.db, 50);
    h.set("implementing", null);
    expect(claimTaskEvents(h.db, 51)).toEqual([]);
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

  test("AC-B242: a part_ready event gives its part and the part count; a part that opened its PR gives none", () => {
    const h = setup();
    const p1 = h.part(1, "self_reviewed", "aaa");
    h.part(2);
    noteTaskWaits(h.db, [h.id], 10);
    expect(claimTaskEvents(h.db, 11)).toEqual([
      {
        id: expect.any(Number),
        task: h.id,
        kind: "part_ready",
        createdAt: 10,
        key: "ABC-1",
        title: "Add a flag",
        text: "Part 1 of 2 is ready for its PR.",
      },
    ]);
    h.db.query("UPDATE task_part SET head = 'bbb' WHERE id = $id").run({ id: p1 });
    noteTaskWaits(h.db, [h.id], 12);
    h.db.query("UPDATE task_part SET state = 'pr_open' WHERE id = $id").run({ id: p1 });
    expect(claimTaskEvents(h.db, 13)).toEqual([]);
  });
});
