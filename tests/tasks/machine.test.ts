// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task and part machines (docs/plans/review-v2/spec.md section 6.2) and advance(): every (state, event) pair, the guards, the
// purity rules, the Mermaid diagram, and the writes with the version check.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialTransition, transition } from "xstate";
import { openDb } from "../../src/server/storage/db";
import {
  machineMermaid,
  PART_EVENTS,
  type PartContext,
  partMachine,
  TASK_EVENTS,
  type TaskContext,
  taskMachine,
} from "../../src/server/tasks/machine";
import { advance, advancePart, recoverTasks, TASK_CHANGED } from "../../src/server/tasks/tasks";
import { PART_STATES, type PartState, TASK_STATE_TEXT, TASK_STATES, type TaskState } from "../../src/shared/task";

for (const m of ["tasks/machine", "tasks/tasks"])
  console.log(`machine.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

type TaskEventType = (typeof TASK_EVENTS)[number];
type PartEventType = (typeof PART_EVENTS)[number];

// The context of the table: every guard that the table rows need passes. The guard cases below vary one fact at a time.
const BASE: TaskContext = { size: "medium", gate: true, stoppedFrom: "implementing" };

// spec.md section 6.2, main transitions. A pair that the table leaves out is refused.
const TASK_TABLE: Record<TaskState, Partial<Record<TaskEventType, TaskState>>> = {
  interview: { ASKED: "interview", ANSWERED: "spec_draft", STOP: "stopped", FAIL: "failed" },
  spec_draft: { APPROVE: "spec_draft", OPEN_SPEC_PR: "spec_pr_open", STOP: "stopped", FAIL: "failed" },
  spec_pr_open: { SPEC_GATE_PASSED: "spec_approved", OVERRIDE: "spec_approved", CLOSE: "done", STOP: "stopped", FAIL: "failed" },
  spec_approved: { START_BUILDING: "implementing", STOP: "stopped", FAIL: "failed" },
  implementing: { PART_READY: "implementing", LAST_PR_OPEN: "ready", STOP: "stopped", FAIL: "failed" },
  ready: { ALL_MERGED: "done", CLOSE: "done", START_BUILDING: "implementing", STOP: "stopped", FAIL: "failed" },
  done: { CLOSE: "done" },
  failed: {},
  stopped: { RESUME: "implementing", CLOSE: "done", FAIL: "failed" },
};

// Part states (spec.md section 6.2): planned → implementing → self_reviewed → pr_open → changes_requested → approved → merged, with
// the side states declined and abandoned. spec.md section 6.20.7: the plan approval follows a PR that the app did not create.
const PART_TABLE: Record<PartState, Partial<Record<PartEventType, PartState>>> = {
  planned: { START: "implementing", ABANDON: "abandoned", ADOPT_OPEN: "pr_open", ADOPT_MERGED: "merged" },
  implementing: { REVIEWED: "self_reviewed", ABANDON: "abandoned" },
  self_reviewed: { PR_OPENED: "pr_open", ABANDON: "abandoned" },
  pr_open: { CHANGES_REQUESTED: "changes_requested", GATE_PASSED: "approved", MERGED: "merged", DECLINED: "declined" },
  changes_requested: { GATE_PASSED: "approved", MERGED: "merged", DECLINED: "declined" },
  approved: { CHANGES_REQUESTED: "changes_requested", GATE_FAILED: "pr_open", MERGED: "merged", DECLINED: "declined" },
  merged: {},
  declined: { REOPENED: "pr_open", ABANDON: "abandoned" },
  abandoned: {},
};

// can() and transition() of one pair. null: refused.
function taskStep(state: TaskState, type: TaskEventType, context: TaskContext = BASE) {
  const snapshot = taskMachine.resolveState({ value: state, context });
  const can = snapshot.can({ type });
  const [next, actions] = transition(taskMachine, snapshot, { type });
  expect(actions).toEqual([]);
  expect(snapshot.value).toBe(state);
  return { can, to: next.value as TaskState };
}

function partStep(state: PartState, type: PartEventType, context: PartContext = { gate: true }) {
  const snapshot = partMachine.resolveState({ value: state, context });
  const can = snapshot.can({ type });
  const [next, actions] = transition(partMachine, snapshot, { type });
  expect(actions).toEqual([]);
  return { can, to: next.value as PartState };
}

const expectTask = (state: TaskState, type: TaskEventType, to: TaskState | null, context: TaskContext = BASE) =>
  expect({ state, type, ...taskStep(state, type, context) }).toEqual({ state, type, can: to !== null, to: to ?? state });

describe("task machine", () => {
  test("its states and events are the stored values of spec.md section 6.2", () => {
    expect(Object.keys(taskMachine.config.states ?? {}).sort()).toEqual([...TASK_STATES].sort());
    const used = new Set(Object.values(TASK_TABLE).flatMap((row) => Object.keys(row)));
    // BUILD creates the task. No state takes it.
    expect([...used, "BUILD"].sort()).toEqual([...TASK_EVENTS].sort());
    const [first, actions] = initialTransition(taskMachine);
    expect(first.value).toBe("interview");
    expect(actions).toEqual([]);
  });

  for (const state of TASK_STATES)
    test(`${state}: every event of the table, allowed and refused`, () => {
      for (const type of TASK_EVENTS) expectTask(state, type, TASK_TABLE[state][type] ?? null);
    });

  test("APPROVE goes to implementing for small and stays in spec_draft for medium and large; no size is refused", () => {
    expectTask("spec_draft", "APPROVE", "implementing", { ...BASE, size: "small" });
    expectTask("spec_draft", "APPROVE", "spec_draft", { ...BASE, size: "medium" });
    expectTask("spec_draft", "APPROVE", "spec_draft", { ...BASE, size: "large" });
    expectTask("spec_draft", "APPROVE", null, { ...BASE, size: null });
  });

  test("a small task never opens a spec PR", () => {
    expectTask("spec_draft", "OPEN_SPEC_PR", null, { ...BASE, size: "small" });
    expectTask("spec_draft", "OPEN_SPEC_PR", "spec_pr_open", { ...BASE, size: "large" });
    expectTask("spec_draft", "OPEN_SPEC_PR", null, { ...BASE, size: null });
  });

  test("the spec gate result decides SPEC_GATE_PASSED; OVERRIDE needs no gate", () => {
    expectTask("spec_pr_open", "SPEC_GATE_PASSED", "spec_approved", { ...BASE, gate: true });
    expectTask("spec_pr_open", "SPEC_GATE_PASSED", null, { ...BASE, gate: false });
    expectTask("spec_pr_open", "OVERRIDE", "spec_approved", { ...BASE, gate: false });
  });

  test("RESUME goes back to the state in stopped_from and refuses any other value", () => {
    for (const from of ["interview", "spec_draft", "spec_pr_open", "spec_approved", "implementing", "ready"] as const)
      expectTask("stopped", "RESUME", from, { ...BASE, stoppedFrom: from });
    for (const from of [null, "done", "failed", "stopped"] as const) expectTask("stopped", "RESUME", null, { ...BASE, stoppedFrom: from });
  });
});

describe("part machine", () => {
  test("its states and events are the stored values of spec.md section 6.2", () => {
    expect(Object.keys(partMachine.config.states ?? {}).sort()).toEqual([...PART_STATES].sort());
    expect([...new Set(Object.values(PART_TABLE).flatMap((row) => Object.keys(row)))].sort()).toEqual([...PART_EVENTS].sort());
    expect(initialTransition(partMachine)[0].value).toBe("planned");
  });

  for (const state of PART_STATES)
    test(`${state}: every event of the table, allowed and refused`, () => {
      for (const type of PART_EVENTS) {
        const to = PART_TABLE[state][type] ?? null;
        expect({ state, type, ...partStep(state, type) }).toEqual({ state, type, can: to !== null, to: to ?? state });
      }
    });

  test("the PR gate result decides GATE_PASSED", () => {
    for (const state of ["pr_open", "changes_requested"] as const) {
      expect(partStep(state, "GATE_PASSED", { gate: false })).toEqual({ can: false, to: state });
      expect(partStep(state, "GATE_PASSED", { gate: true })).toEqual({ can: true, to: "approved" });
    }
  });
});

describe("purity", () => {
  // Keys that run code or start an actor in XState v5.
  const EFFECTS = ["entry", "exit", "invoke", "actions", "after", "always", "onDone", "onError"];
  const effectKeys = (v: unknown, path: string): string[] =>
    v === null || typeof v !== "object"
      ? []
      : Object.entries(v).flatMap(([k, x]) => [...(EFFECTS.includes(k) ? [`${path}.${k}`] : []), ...effectKeys(x, `${path}.${k}`)]);

  test("the machine configs have no entry, exit, or transition actions and no invoke", () => {
    for (const m of [taskMachine, partMachine]) {
      expect(effectKeys(m.config, m.id)).toEqual([]);
      expect(Object.keys(m.implementations.actions)).toEqual([]);
      expect(Object.keys(m.implementations.actors)).toEqual([]);
      expect(Object.keys(m.implementations.delays)).toEqual([]);
    }
  });

  test("no source file under src/ uses createActor", () => {
    const root = join(import.meta.dir, "../../src");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => readFileSync(join(root, f), "utf8").includes("createActor"))).toEqual([]);
  });
});

describe("machineMermaid", () => {
  test("the task machine diagram", () => {
    expect(machineMermaid(taskMachine)).toBe(`stateDiagram-v2
  [*] --> interview
  interview --> interview: ASKED
  interview --> spec_draft: ANSWERED
  interview --> stopped: STOP
  interview --> failed: FAIL
  spec_draft --> implementing: APPROVE if small
  spec_draft --> spec_draft: APPROVE if planReview
  spec_draft --> spec_pr_open: OPEN_SPEC_PR if planReview
  spec_draft --> stopped: STOP
  spec_draft --> failed: FAIL
  spec_pr_open --> spec_approved: SPEC_GATE_PASSED if gate
  spec_pr_open --> spec_approved: OVERRIDE
  spec_pr_open --> done: CLOSE
  spec_pr_open --> stopped: STOP
  spec_pr_open --> failed: FAIL
  spec_approved --> implementing: START_BUILDING
  spec_approved --> stopped: STOP
  spec_approved --> failed: FAIL
  implementing --> implementing: PART_READY
  implementing --> ready: LAST_PR_OPEN
  implementing --> stopped: STOP
  implementing --> failed: FAIL
  ready --> done: ALL_MERGED
  ready --> done: CLOSE
  ready --> implementing: START_BUILDING
  ready --> stopped: STOP
  ready --> failed: FAIL
  stopped --> interview: RESUME if stoppedFrom interview
  stopped --> spec_draft: RESUME if stoppedFrom spec_draft
  stopped --> spec_pr_open: RESUME if stoppedFrom spec_pr_open
  stopped --> spec_approved: RESUME if stoppedFrom spec_approved
  stopped --> implementing: RESUME if stoppedFrom implementing
  stopped --> ready: RESUME if stoppedFrom ready
  stopped --> done: CLOSE
  stopped --> failed: FAIL
  done --> done: CLOSE
  failed --> [*]`);
  });

  test("the part machine diagram", () => {
    expect(machineMermaid(partMachine)).toBe(`stateDiagram-v2
  [*] --> planned
  planned --> implementing: START
  planned --> abandoned: ABANDON
  planned --> pr_open: ADOPT_OPEN
  planned --> merged: ADOPT_MERGED
  implementing --> self_reviewed: REVIEWED
  implementing --> abandoned: ABANDON
  self_reviewed --> pr_open: PR_OPENED
  self_reviewed --> abandoned: ABANDON
  pr_open --> changes_requested: CHANGES_REQUESTED
  pr_open --> approved: GATE_PASSED if gate
  pr_open --> merged: MERGED
  pr_open --> declined: DECLINED
  changes_requested --> approved: GATE_PASSED if gate
  changes_requested --> merged: MERGED
  changes_requested --> declined: DECLINED
  approved --> changes_requested: CHANGES_REQUESTED
  approved --> pr_open: GATE_FAILED
  approved --> merged: MERGED
  approved --> declined: DECLINED
  merged --> [*]
  declined --> pr_open: REOPENED
  declined --> abandoned: ABANDON
  abandoned --> [*]`);
  });
});

// ---------- advance(): the state from SQLite, can(), transition(), and the write with the version check ----------

describe("advance", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-machine-"));
  const db: Database = openDb(join(dir, "tasks.sqlite"));
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const newTask = (state: TaskState = "interview", size: string | null = null) =>
    (
      db
        .query(`INSERT INTO task (project, repo, key, title, state, size, target_branch, spec_dir, created_at, updated_at)
          VALUES ('P', 'r', $key, 'T', $state, $size, 'main', 'specs/K/', 1, 1) RETURNING id`)
        .get({ key: `K-${Math.floor(Math.random() * 1e9)}`, state, size }) as { id: number }
    ).id;
  const row = (id: number) =>
    db.query("SELECT state, stopped_from, version, updated_at FROM task WHERE id = $id").get({ id }) as {
      state: TaskState;
      stopped_from: TaskState | null;
      version: number;
      updated_at: number;
    };

  test("a small task walks to implementing; each write raises the version", () => {
    const id = newTask();
    expect(advance(db, { task: id, version: 0 }, { type: "ASKED" }, {}, 5)).toEqual({ status: 200, state: "interview", version: 1 });
    expect(advance(db, { task: id, version: 1 }, { type: "ANSWERED" }, {}, 6)).toEqual({ status: 200, state: "spec_draft", version: 2 });
    db.query("UPDATE task SET size = 'small' WHERE id = $id").run({ id });
    expect(advance(db, { task: id, version: 2 }, { type: "APPROVE" }, {}, 7)).toEqual({ status: 200, state: "implementing", version: 3 });
    expect(row(id)).toEqual({ state: "implementing", stopped_from: null, version: 3, updated_at: 7 });
  });

  test("a refused event returns 409 with the sentence of the state and writes nothing", () => {
    const id = newTask("interview");
    expect(advance(db, { task: id, version: 0 }, { type: "APPROVE" })).toEqual({
      status: 409,
      error: TASK_STATE_TEXT.interview,
      state: "interview",
      version: 0,
    });
    expect(row(id)).toEqual({ state: "interview", stopped_from: null, version: 0, updated_at: 1 });
  });

  test("an old version returns 409 and writes nothing; an unknown task returns 404", () => {
    const id = newTask("interview");
    expect(advance(db, { task: id, version: 3 }, { type: "ASKED" })).toEqual({
      status: 409,
      error: TASK_CHANGED,
      state: "interview",
      version: 0,
    });
    expect(row(id).version).toBe(0);
    expect(advance(db, { task: 999_999, version: 0 }, { type: "ASKED" })).toEqual({ status: 404, error: "Task not found." });
  });

  test("STOP stores stopped_from, and RESUME goes back and clears it", () => {
    const id = newTask("spec_approved", "large");
    expect(advance(db, { task: id, version: 0 }, { type: "STOP" }).status).toBe(200);
    expect(row(id)).toMatchObject({ state: "stopped", stopped_from: "spec_approved", version: 1 });
    expect(advance(db, { task: id, version: 1 }, { type: "STOP" }).status).toBe(409);
    expect(advance(db, { task: id, version: 1 }, { type: "RESUME" })).toEqual({ status: 200, state: "spec_approved", version: 2 });
    expect(row(id)).toMatchObject({ state: "spec_approved", stopped_from: null });
  });

  test("the gate fact of the caller decides SPEC_GATE_PASSED", () => {
    const id = newTask("spec_pr_open", "medium");
    expect(advance(db, { task: id, version: 0 }, { type: "SPEC_GATE_PASSED" }).status).toBe(409);
    expect(advance(db, { task: id, version: 0 }, { type: "SPEC_GATE_PASSED" }, { gate: false }).status).toBe(409);
    expect(advance(db, { task: id, version: 0 }, { type: "SPEC_GATE_PASSED" }, { gate: true }).status).toBe(200);
    expect(row(id).state).toBe("spec_approved");
  });

  test("inside a caller transaction, a later failure undoes the state write and the step row", () => {
    const id = newTask("interview");
    expect(() =>
      db.transaction(() => {
        expect(advance(db, { task: id, version: 0 }, { type: "ANSWERED" }).status).toBe(200);
        db.query("INSERT INTO task_step (task, ord, kind, state, started_at) VALUES ($id, 1, 'spec', 'running', 1)").run({ id });
        throw new Error("run start failed");
      })(),
    ).toThrow("run start failed");
    expect(row(id)).toMatchObject({ state: "interview", version: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM task_step WHERE task = $id").get({ id })).toEqual({ n: 0 });
  });

  test("advancePart writes the part state and raises the task version", () => {
    const id = newTask("implementing", "large");
    const part = (
      db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($id, 1, 'part', 'One', 'feature/K-1-one', 'main', 'planned', 1, 1) RETURNING id`)
        .get({ id }) as { id: number }
    ).id;
    expect(advancePart(db, { task: id, version: 0, part }, { type: "START" }, {}, 9)).toEqual({
      status: 200,
      state: "implementing",
      version: 1,
    });
    expect(db.query("SELECT state, updated_at FROM task_part WHERE id = $part").get({ part })).toEqual({
      state: "implementing",
      updated_at: 9,
    });
    expect(row(id).version).toBe(1);
    expect(advancePart(db, { task: id, version: 0, part }, { type: "REVIEWED" })).toMatchObject({ status: 409, error: TASK_CHANGED });
    expect(advancePart(db, { task: id, version: 1, part }, { type: "MERGED" })).toMatchObject({
      status: 409,
      error: "This part is building.",
      state: "implementing",
    });
    expect(advancePart(db, { task: id + 1, version: 1, part }, { type: "REVIEWED" })).toEqual({ status: 404, error: "Part not found." });
    expect(row(id).version).toBe(1);
  });

  test("recoverTasks fails the running step of a running task run and stops its task", () => {
    const id = newTask("implementing", "small");
    const done = newTask("done", "small");
    const run = (task: number) =>
      (
        db
          .query(`INSERT INTO review_run (pr, task, kind, profile, note, idem_key, source_head, target_head, status, started_at)
            VALUES (NULL, $task, 'implement', 'general', '', $key, 'a', 'b', 'running', 1) RETURNING id`)
          .get({ task, key: `t${task}` }) as { id: number }
      ).id;
    const r1 = run(id);
    run(done);
    db.query("INSERT INTO task_step (task, ord, kind, run, state, started_at) VALUES ($id, 1, 'implement', $run, 'running', 1)").run({
      id,
      run: r1,
    });
    db.query("INSERT INTO task_step (task, ord, kind, state, started_at) VALUES ($id, 2, 'check', 'ok', 1)").run({ id });
    recoverTasks(db, 50);
    expect(row(id)).toMatchObject({ state: "stopped", stopped_from: "implementing", version: 1 });
    expect(row(done)).toMatchObject({ state: "done", version: 0 });
    expect(db.query("SELECT ord, state, ended_at FROM task_step WHERE task = $id ORDER BY ord").all({ id })).toEqual([
      { ord: 1, state: "failed", ended_at: 50 },
      { ord: 2, state: "ok", ended_at: null },
    ]);
  });
});
