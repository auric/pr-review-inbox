// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task and part machines (docs/plans/review-v2/spec.md section 6.2), the phase machine (part-session.md section 9.3.3), and
// advance(): every (state, event) pair, the guards, reachability, the senders, the purity rules, the Mermaid diagrams, and the writes
// with the version check (AC-B250 to AC-B252).
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyStateMachine, initialTransition, transition } from "xstate";
import { openDb } from "../../src/server/storage/db";
import { insertStep } from "../../src/server/tasks/implement";
import {
  machineMermaid,
  PART_EVENTS,
  type PartContext,
  PHASE_EVENTS,
  PHASE_GUARDS,
  PHASES,
  type Phase,
  type PhaseContext,
  partMachine,
  phaseMachine,
  RESERVED,
  TASK_EVENTS,
  type TaskContext,
  taskMachine,
} from "../../src/server/tasks/machine";
import { advance, advancePart, recoverTasks, TASK_CHANGED } from "../../src/server/tasks/tasks";
import { PART_STATES, type PartState, TASK_STATE_TEXT, TASK_STATES, type TaskState } from "../../src/shared/task";
import { openTwice } from "./fixture";

for (const m of ["tasks/machine", "tasks/tasks"])
  console.log(`machine.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

type TaskEventType = (typeof TASK_EVENTS)[number];
type PartEventType = (typeof PART_EVENTS)[number];
type PhaseEventType = (typeof PHASE_EVENTS)[number];
type PhaseGuard = (typeof PHASE_GUARDS)[number];

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
  implementing: { REVIEWED: "self_reviewed", RESTART: "implementing", ABANDON: "abandoned" },
  self_reviewed: { PR_OPENED: "pr_open", RESTART: "implementing", ABANDON: "abandoned" },
  pr_open: { CHANGES_REQUESTED: "changes_requested", GATE_PASSED: "approved", MERGED: "merged", DECLINED: "declined" },
  // part-session.md G3: a withdrawn "Needs work" with a failing gate.
  changes_requested: { GATE_PASSED: "approved", GATE_FAILED: "pr_open", MERGED: "merged", DECLINED: "declined" },
  approved: { CHANGES_REQUESTED: "changes_requested", GATE_FAILED: "pr_open", MERGED: "merged", DECLINED: "declined" },
  merged: {},
  declined: { REOPENED: "pr_open", ABANDON: "abandoned" },
  abandoned: {},
};

// The one guard of each guarded part event (part-session.md section 9.3.2). The other part events have no guard.
const PART_GUARDS: Partial<Record<PartEventType, "gate" | "unpushed">> = { GATE_PASSED: "gate", RESTART: "unpushed" };

// part-session.md section 9.3.3, Transitions: the rows of each (phase, event) in their order. The first row whose guard holds wins; a
// null guard always holds. A pair that the table leaves out, or a pair with no row that holds, is refused.
type Row = [PhaseGuard | null, Phase];
const RUN_CUT = (state: Phase): Row[] => [
  ["firstCut", state],
  [null, "idle"],
];
const RUN_DONE: Row[] = [
  ["unchanged", "idle"],
  [null, "checking"],
];
const ENDED: Partial<Record<PhaseEventType, Row[]>> = { WAIT: [[null, "idle"]], STOPPED: [[null, "idle"]] };
const PHASE_TABLE: Record<Phase, Partial<Record<PhaseEventType, Row[]>>> = {
  idle: {
    GO: [
      ["setup", "setup"],
      ["baseline", "baseline"],
      ["follow", "following"],
      ["run", "building"],
      ["checks", "checking"],
      ["critic", "critic"],
      ["review", "reviewing"],
    ],
    UPDATE: [[null, "updating"]],
  },
  setup: { CLEAN: [[null, "idle"]], ...ENDED },
  baseline: { CLEAN: [[null, "idle"]], ...ENDED },
  building: { RUN_DONE: [[null, "checking"]], RUN_CUT: RUN_CUT("building"), ...ENDED },
  checking: {
    CHECKS_GREEN: [[null, "idle"]],
    CHECKS_RED: [
      ["afterUpdate", "idle"],
      ["redBefore", "idle"],
      ["triesLeft", "fixing"],
      [null, "idle"],
    ],
    ...ENDED,
  },
  fixing: { RUN_DONE, RUN_CUT: RUN_CUT("fixing"), ...ENDED },
  critic: { POINTS: [[null, "judging"]], CLEAN: [[null, "idle"]], STOPPED: [[null, "idle"]] },
  judging: { RUN_DONE: [[null, "checking"]], RUN_CUT: RUN_CUT("judging"), ...ENDED },
  reviewing: {
    POINTS: [
      ["roundsLeft", "judging"],
      [null, "idle"],
    ],
    CLEAN: [[null, "idle"]],
    ...ENDED,
  },
  following: { RUN_DONE, RUN_CUT: RUN_CUT("following"), ...ENDED },
  updating: { CLEAN: [[null, "checking"]], CONFLICT: [[null, "resolving"]], ...ENDED },
  resolving: { RUN_DONE: [[null, "updating"]], ...ENDED },
};
const NO_FACTS = Object.fromEntries(PHASE_GUARDS.map((g) => [g, false])) as PhaseContext;
const expectedPhase = (state: Phase, type: PhaseEventType, context: PhaseContext): Phase | null =>
  (PHASE_TABLE[state][type] ?? []).find(([g]) => g === null || context[g])?.[1] ?? null;
// Every true/false combination of the given facts, with the other facts false.
function combos<K extends string>(keys: readonly K[], base: Record<K, boolean>): Record<K, boolean>[] {
  return Array.from({ length: 2 ** keys.length }, (_, n) => ({
    ...base,
    ...Object.fromEntries(keys.map((k, i) => [k, ((n >> i) & 1) === 1])),
  }));
}
const phaseGuardsOf = (state: Phase) => [
  ...new Set(
    Object.values(PHASE_TABLE[state])
      .flat()
      .flatMap(([g]) => (g ? [g] : [])),
  ),
];

// can() and transition() of one pair. null: refused.
function taskStep(state: TaskState, type: TaskEventType, context: TaskContext = BASE) {
  const snapshot = taskMachine.resolveState({ value: state, context });
  const can = snapshot.can({ type });
  const [next, actions] = transition(taskMachine, snapshot, { type });
  expect(actions).toEqual([]);
  expect(snapshot.value).toBe(state);
  return { can, to: next.value as TaskState };
}

function partStep(state: PartState, type: PartEventType, context: PartContext = { gate: true, unpushed: true }) {
  const snapshot = partMachine.resolveState({ value: state, context });
  const can = snapshot.can({ type });
  const [next, actions] = transition(partMachine, snapshot, { type });
  expect(actions).toEqual([]);
  return { can, to: next.value as PartState };
}

function phaseStep(state: Phase, type: PhaseEventType, context: PhaseContext = NO_FACTS) {
  const snapshot = phaseMachine.resolveState({ value: state, context });
  const can = snapshot.can({ type });
  const [next, actions] = transition(phaseMachine, snapshot, { type });
  expect(actions).toEqual([]);
  return { can, to: next.value as Phase };
}

// A BFS with transition() from the initial state. contexts: the contexts to try in a state. Returns the reached states and the edges to
// another state.
function explore(machine: AnyStateMachine, events: readonly string[], contexts: (state: string) => object[]) {
  const start = String(initialTransition(machine)[0].value);
  const seen = new Set([start]);
  const leaves = new Map<string, Set<string>>();
  for (const queue = [start]; queue.length; ) {
    const state = queue.shift() as string;
    const out = new Set<string>();
    for (const context of contexts(state))
      for (const type of events) {
        const snapshot = machine.resolveState({ value: state, context });
        if (!snapshot.can({ type })) continue;
        const to = String(transition(machine, snapshot, { type })[0].value);
        if (to !== state) out.add(to);
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    leaves.set(state, out);
  }
  return { seen, leaves };
}

const TASK_CONTEXTS: TaskContext[] = [null, "small", "medium", "large"].flatMap((size) =>
  [false, true].flatMap((gate) => [null, ...TASK_STATES].map((stoppedFrom) => ({ size, gate, stoppedFrom }) as TaskContext)),
);
const PART_CONTEXTS = combos(["gate", "unpushed"] as const, { gate: false, unpushed: false });

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

  test("guard grid: each state and event under each gate and unpushed value; RESTART needs unpushed", () => {
    for (const context of PART_CONTEXTS)
      for (const state of PART_STATES)
        for (const type of PART_EVENTS) {
          const guard = PART_GUARDS[type];
          const to = PART_TABLE[state][type] && (!guard || context[guard]) ? (PART_TABLE[state][type] as PartState) : null;
          expect({ state, type, context, ...partStep(state, type, context) }).toEqual({
            state,
            type,
            context,
            can: to !== null,
            to: to ?? state,
          });
        }
    // An absent unpushed counts as false.
    expect(partStep("implementing", "RESTART", { gate: true })).toEqual({ can: false, to: "implementing" });
  });
});

describe("phase machine (part-session.md section 9.3.3)", () => {
  test("its states, events, and guards", () => {
    expect(Object.keys(phaseMachine.config.states ?? {})).toEqual([...PHASES]);
    expect([...new Set(Object.values(PHASE_TABLE).flatMap((row) => Object.keys(row)))].sort()).toEqual([...PHASE_EVENTS].sort());
    expect(Object.keys(phaseMachine.implementations.guards).sort()).toEqual([...PHASE_GUARDS].sort());
    const [first, actions] = initialTransition(phaseMachine);
    expect(first.value).toBe("idle");
    expect(actions).toEqual([]);
  });

  for (const state of PHASES)
    test(`${state}: every event with no fact true, allowed and refused`, () => {
      for (const type of PHASE_EVENTS) {
        const to = expectedPhase(state, type, NO_FACTS);
        expect({ state, type, ...phaseStep(state, type) }).toEqual({ state, type, can: to !== null, to: to ?? state });
      }
    });

  test("guard grid: each state and event under every combination of the guards that its rows read", () => {
    let pairs = 0;
    for (const state of PHASES)
      for (const type of PHASE_EVENTS) {
        const guards = [...new Set((PHASE_TABLE[state][type] ?? []).flatMap(([g]) => (g ? [g] : [])))];
        for (const context of combos(guards, NO_FACTS)) {
          const to = expectedPhase(state, type, context);
          expect({ state, type, context, ...phaseStep(state, type, context) }).toEqual({
            state,
            type,
            context,
            can: to !== null,
            to: to ?? state,
          });
          pairs++;
        }
      }
    // idle GO alone has 2^7 combinations.
    expect(pairs).toBeGreaterThan(128);
  });

  test("GO with every fact true picks setup; with no fact true it is refused", () => {
    const all = Object.fromEntries(PHASE_GUARDS.map((g) => [g, true])) as PhaseContext;
    expect(phaseStep("idle", "GO", all)).toEqual({ can: true, to: "setup" });
    expect(phaseStep("idle", "GO")).toEqual({ can: false, to: "idle" });
  });
});

describe("reachability and dead ends (part-session.md section 9.7, invariants 1 and 2)", () => {
  const cases = [
    {
      name: "task",
      machine: taskMachine,
      states: TASK_STATES,
      events: TASK_EVENTS,
      contexts: () => TASK_CONTEXTS,
      terminals: ["done", "failed"],
    },
    {
      name: "part",
      machine: partMachine,
      states: PART_STATES,
      events: PART_EVENTS,
      contexts: () => PART_CONTEXTS,
      terminals: ["merged", "abandoned"],
    },
    {
      name: "phase",
      machine: phaseMachine,
      states: PHASES,
      events: PHASE_EVENTS,
      contexts: (s: string) => combos(phaseGuardsOf(s as Phase), NO_FACTS),
      terminals: [],
    },
  ];
  for (const c of cases)
    test(`${c.name}: every state is reachable, and only the terminals have no edge to another state`, () => {
      const { seen, leaves } = explore(c.machine, c.events, c.contexts);
      expect([...seen].sort()).toEqual([...c.states].sort());
      expect(
        [...leaves]
          .filter(([, out]) => out.size === 0)
          .map(([s]) => s)
          .sort(),
      ).toEqual([...c.terminals].sort());
    });
});

// ps4-plan.md sections 2.1 and 2.3: the edges that Hold, Skip, Start again, and Continue with part send in their order.
describe("Hold, Skip, and Start again (ps4-plan.md WP-4)", () => {
  test("Hold: building, fixing, judging, and following take STOPPED to idle; idle refuses STOPPED", () => {
    for (const from of ["building", "fixing", "judging", "following"] as const)
      expect([from, phaseStep(from, "STOPPED")]).toEqual([from, { can: true, to: "idle" }]);
    expect(phaseStep("idle", "STOPPED").can).toBe(false);
  });

  test("Skip and Start again: implementing and self_reviewed take ABANDON and RESTART; RESTART needs unpushed; a part with a PR takes neither", () => {
    for (const from of ["implementing", "self_reviewed"] as const) {
      expect([from, partStep(from, "ABANDON")]).toEqual([from, { can: true, to: "abandoned" }]);
      expect([from, partStep(from, "RESTART")]).toEqual([from, { can: true, to: "implementing" }]);
      expect([from, partStep(from, "RESTART", { gate: true, unpushed: false }).can]).toEqual([from, false]);
    }
    for (const from of ["pr_open", "changes_requested", "approved", "merged", "abandoned"] as const)
      expect([from, partStep(from, "ABANDON").can, partStep(from, "RESTART").can]).toEqual([from, false, false]);
  });

  test("gap 18: a Skip in stopped, then RESUME to implementing, LAST_PR_OPEN to ready, and ALL_MERGED to done", () => {
    expect(taskStep("stopped", "RESUME")).toEqual({ can: true, to: "implementing" });
    expect(taskStep("stopped", "LAST_PR_OPEN").can).toBe(false);
    expect(taskStep("stopped", "ALL_MERGED").can).toBe(false);
    expect(taskStep("implementing", "LAST_PR_OPEN")).toEqual({ can: true, to: "ready" });
    expect(taskStep("ready", "ALL_MERGED")).toEqual({ can: true, to: "done" });
  });
});

// ps4-plan.md section 2.1, row Update (AC-B355 to AC-B357): the orders that driveUpdate and endUpdate send, from idle back to idle.
describe("Update and resolve (ps4-plan.md WP-5)", () => {
  const walk = (steps: [PhaseEventType, Partial<PhaseContext>?][]) => {
    let at: Phase = "idle";
    const out: string[] = [];
    for (const [type, facts] of steps) {
      const r = phaseStep(at, type, { ...NO_FACTS, ...facts });
      expect([at, type, r.can]).toEqual([at, type, true]);
      at = r.to;
      out.push(`${type}>${at}`);
    }
    return out;
  };

  test("a clean update, a conflict, red checks, and the own review after a resolve", () => {
    expect(walk([["UPDATE"], ["CLEAN"], ["CHECKS_GREEN"]])).toEqual(["UPDATE>updating", "CLEAN>checking", "CHECKS_GREEN>idle"]);
    expect(walk([["UPDATE"], ["CONFLICT"], ["RUN_DONE"], ["CONFLICT"], ["RUN_DONE"], ["CLEAN"]]).at(-1)).toBe("CLEAN>checking");
    // afterUpdate wins over triesLeft: red checks after an update run no fix.
    expect(walk([["UPDATE"], ["CLEAN"], ["CHECKS_RED", { afterUpdate: true, triesLeft: true }]]).at(-1)).toBe("CHECKS_RED>idle");
    expect(phaseStep("checking", "CHECKS_RED", { ...NO_FACTS, triesLeft: true }).to).toBe("fixing");
    expect(
      walk([["UPDATE"], ["CONFLICT"], ["RUN_DONE"], ["CLEAN"], ["CHECKS_GREEN"], ["GO", { review: true, checks: false }], ["CLEAN"]]),
    ).toEqual([
      "UPDATE>updating",
      "CONFLICT>resolving",
      "RUN_DONE>updating",
      "CLEAN>checking",
      "CHECKS_GREEN>idle",
      "GO>reviewing",
      "CLEAN>idle",
    ]);
  });

  test("an abort sends WAIT and a Stop sends STOPPED from updating, resolving, and checking; idle refuses both", () => {
    for (const from of ["updating", "resolving", "checking"] as const)
      for (const type of ["WAIT", "STOPPED"] as const)
        expect([from, type, phaseStep(from, type)]).toEqual([from, type, { can: true, to: "idle" }]);
    for (const type of ["WAIT", "STOPPED"] as const) expect(phaseStep("idle", type).can).toBe(false);
  });

  test("UPDATE leaves only idle; CONFLICT leaves only updating; resolving takes no CLEAN and no CONFLICT", () => {
    for (const from of PHASES) {
      expect([from, phaseStep(from, "UPDATE").can]).toEqual([from, from === "idle"]);
      expect([from, phaseStep(from, "CONFLICT").can]).toEqual([from, from === "updating"]);
    }
    expect([phaseStep("resolving", "CLEAN").can, phaseStep("resolving", "RUN_DONE").to]).toEqual([false, "updating"]);
  });
});

// ps4-plan.md section 2.1, rows Critic and Review judging with push-back (AC-B359 to AC-B363): the orders that criticRun, reviewRound,
// and followRun send.
describe("critic, judging, and push-back (ps4-plan.md WP-6)", () => {
  const walk = (steps: [PhaseEventType, Partial<PhaseContext>?][], from: Phase = "idle") => {
    let at = from;
    return steps.map(([type, facts]) => {
      const r = phaseStep(at, type, { ...NO_FACTS, ...facts });
      expect([at, type, r.can]).toEqual([at, type, true]);
      at = r.to;
      return `${type}>${at}`;
    });
  };

  test("GO picks the critic after the gate and before the own review; a waiting follow-up comes first", () => {
    expect(phaseStep("idle", "GO", { ...NO_FACTS, critic: true, review: true }).to).toBe("critic");
    expect(phaseStep("idle", "GO", { ...NO_FACTS, checks: true, critic: true }).to).toBe("checking");
    expect(phaseStep("idle", "GO", { ...NO_FACTS, follow: true, critic: true }).to).toBe("following");
    expect(phaseStep("idle", "GO", { ...NO_FACTS, review: true }).to).toBe("reviewing");
  });

  test("a clean or failed critic, a critic with kept points, and a cancelled critic", () => {
    expect(walk([["GO", { critic: true }], ["CLEAN"]])).toEqual(["GO>critic", "CLEAN>idle"]);
    expect(walk([["GO", { critic: true }], ["POINTS"], ["RUN_DONE"], ["CHECKS_GREEN"]])).toEqual([
      "GO>critic",
      "POINTS>judging",
      "RUN_DONE>checking",
      "CHECKS_GREEN>idle",
    ]);
    expect(walk([["GO", { critic: true }], ["STOPPED"]])).toEqual(["GO>critic", "STOPPED>idle"]);
    // A failed critic sends CLEAN: the phase critic has no WAIT edge.
    expect(phaseStep("critic", "WAIT").can).toBe(false);
  });

  test("review judging with push-back ends at idle, so the questions come at idle; a judging run with no change still takes RUN_DONE to checking", () => {
    expect(walk([["GO", { review: true }], ["POINTS", { roundsLeft: true }], ["RUN_DONE"], ["CHECKS_GREEN"]])).toEqual([
      "GO>reviewing",
      "POINTS>judging",
      "RUN_DONE>checking",
      "CHECKS_GREEN>idle",
    ]);
    expect(phaseStep("judging", "RUN_DONE", { ...NO_FACTS, unchanged: true }).to).toBe("checking");
    for (const type of ["WAIT", "STOPPED"] as const) expect(phaseStep("judging", type).to).toBe("idle");
  });

  test("Fix these too and Fix it anyway: following with a change goes to checking; with no change back to idle", () => {
    expect(walk([["GO", { follow: true }], ["RUN_DONE"], ["CHECKS_GREEN"], ["GO", { review: true }], ["CLEAN"]])).toEqual([
      "GO>following",
      "RUN_DONE>checking",
      "CHECKS_GREEN>idle",
      "GO>reviewing",
      "CLEAN>idle",
    ]);
    expect(
      walk([
        ["GO", { follow: true }],
        ["RUN_DONE", { unchanged: true }],
      ]),
    ).toEqual(["GO>following", "RUN_DONE>idle"]);
  });
});

describe("senders (part-session.md section 9.7, invariant 7)", () => {
  // A sender passes the event to advance(), advancePart(), or the phase send helper as `type: "E"`, or returns it from an event helper
  // (gates.ts eventOf: `return "E"`; tasks.ts adoption: `? "E" : "F"`). BUILD has no sender: the create route uses initialTransition.
  const root = join(import.meta.dir, "../../src/server");
  const sources = (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => /\.ts$/.test(f) && !f.replaceAll("\\", "/").endsWith("tasks/machine.ts"))
    .map((f) => readFileSync(join(root, f), "utf8"))
    .join("\n");
  const sent = (e: string) => new RegExp(`(?:type: |return |\\? |" : )"${e}"`).test(sources);
  const events = [...new Set([...TASK_EVENTS, ...PART_EVENTS, ...PHASE_EVENTS])].filter((e) => e !== "BUILD");

  test("each event has a sender or is in RESERVED with its owner package", () => {
    expect(events.filter((e) => !sent(e) && !RESERVED[e])).toEqual([]);
    for (const owner of Object.values(RESERVED)) expect(owner?.length).toBeGreaterThan(0);
  });

  test("no RESERVED event has a sender", () => {
    expect(Object.keys(RESERVED).filter(sent)).toEqual([]);
    expect(Object.keys(RESERVED).filter((e) => !(events as string[]).includes(e))).toEqual([]);
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
    for (const m of [taskMachine, partMachine, phaseMachine]) {
      expect(effectKeys(m.config, m.id)).toEqual([]);
      expect(Object.keys(m.implementations.actions)).toEqual([]);
      expect(Object.keys(m.implementations.actors)).toEqual([]);
      expect(Object.keys(m.implementations.delays)).toEqual([]);
    }
  });

  test("machine.ts imports only xstate and types", () => {
    const text = readFileSync(join(import.meta.dir, "../../src/server/tasks/machine.ts"), "utf8");
    const imports = text.match(/^import[^;]*;/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => !i.startsWith("import type ") && !/ from "xstate";$/.test(i))).toEqual([]);
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
  implementing --> implementing: RESTART if unpushed
  implementing --> abandoned: ABANDON
  self_reviewed --> pr_open: PR_OPENED
  self_reviewed --> implementing: RESTART if unpushed
  self_reviewed --> abandoned: ABANDON
  pr_open --> changes_requested: CHANGES_REQUESTED
  pr_open --> approved: GATE_PASSED if gate
  pr_open --> merged: MERGED
  pr_open --> declined: DECLINED
  changes_requested --> approved: GATE_PASSED if gate
  changes_requested --> pr_open: GATE_FAILED
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

  test("the phase machine diagram (part-session.md section 9.3.7)", () => {
    expect(machineMermaid(phaseMachine)).toBe(`stateDiagram-v2
  [*] --> idle
  idle --> setup: GO if setup
  idle --> baseline: GO if baseline
  idle --> following: GO if follow
  idle --> building: GO if run
  idle --> checking: GO if checks
  idle --> critic: GO if critic
  idle --> reviewing: GO if review
  idle --> updating: UPDATE
  setup --> idle: CLEAN
  setup --> idle: WAIT
  setup --> idle: STOPPED
  baseline --> idle: CLEAN
  baseline --> idle: WAIT
  baseline --> idle: STOPPED
  building --> checking: RUN_DONE
  building --> building: RUN_CUT if firstCut
  building --> idle: RUN_CUT
  building --> idle: WAIT
  building --> idle: STOPPED
  checking --> idle: CHECKS_GREEN
  checking --> idle: CHECKS_RED if afterUpdate
  checking --> idle: CHECKS_RED if redBefore
  checking --> fixing: CHECKS_RED if triesLeft
  checking --> idle: CHECKS_RED
  checking --> idle: WAIT
  checking --> idle: STOPPED
  fixing --> idle: RUN_DONE if unchanged
  fixing --> checking: RUN_DONE
  fixing --> fixing: RUN_CUT if firstCut
  fixing --> idle: RUN_CUT
  fixing --> idle: WAIT
  fixing --> idle: STOPPED
  critic --> judging: POINTS
  critic --> idle: CLEAN
  critic --> idle: STOPPED
  judging --> checking: RUN_DONE
  judging --> judging: RUN_CUT if firstCut
  judging --> idle: RUN_CUT
  judging --> idle: WAIT
  judging --> idle: STOPPED
  reviewing --> judging: POINTS if roundsLeft
  reviewing --> idle: POINTS
  reviewing --> idle: CLEAN
  reviewing --> idle: WAIT
  reviewing --> idle: STOPPED
  following --> idle: RUN_DONE if unchanged
  following --> checking: RUN_DONE
  following --> following: RUN_CUT if firstCut
  following --> idle: RUN_CUT
  following --> idle: WAIT
  following --> idle: STOPPED
  updating --> checking: CLEAN
  updating --> resolving: CONFLICT
  updating --> idle: WAIT
  updating --> idle: STOPPED
  resolving --> updating: RUN_DONE
  resolving --> idle: WAIT
  resolving --> idle: STOPPED`);
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

  test("AC-B297: recoverTasks fails the running step of a running task run; the task keeps its state with the reason error/restart", () => {
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
    expect(row(id)).toMatchObject({ state: "implementing", stopped_from: null, version: 1 });
    const b = db.query("SELECT blocked_json FROM task WHERE id = $id").get({ id }) as { blocked_json: string };
    expect(JSON.parse(b.blocked_json)).toMatchObject({ kind: "error", cause: "restart", step: 1 });
    expect(row(done)).toMatchObject({ state: "done", version: 0 });
    expect(db.query("SELECT ord, state, ended_at FROM task_step WHERE task = $id ORDER BY ord").all({ id })).toEqual([
      { ord: 1, state: "failed", ended_at: 50 },
      { ord: 2, state: "ok", ended_at: null },
    ]);
  });

  // part-session.md section 9.7, invariant 8, as the fixtures check it. The update driver keeps its row open beside one resolve or check
  // row of the same update.
  test("invariant 8: an open update row with one open resolve or check row of the same update is no hit; every other pair is", () => {
    const hits = (rows: [Parameters<typeof insertStep>[1]["kind"], string, "waiting" | "running"][]) => {
      const task = newTask("ready", "small");
      const part = (
        db
          .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
            VALUES ($task, 1, 'single', 'T', 'b', 'main', 'self_reviewed', 1, 1) RETURNING id`)
          .get({ task }) as { id: number }
      ).id;
      for (const [kind, item, state] of rows) insertStep(db, { task, part, kind, item, state });
      return openTwice(db)
        .filter((x) => x.part === part)
        .map((x) => x.rows);
    };
    expect(
      hits([
        ["update", "U1", "running"],
        ["resolve", "U1", "running"],
      ]),
    ).toEqual([]);
    expect(
      hits([
        ["update", "U2", "running"],
        ["check", "U2", "running"],
      ]),
    ).toEqual([]);
    expect(
      hits([
        ["update", "U1", "running"],
        ["check", "U2", "running"],
      ]),
    ).toEqual(["update:U1 check:U2"]);
    expect(
      hits([
        ["update", "U1", "running"],
        ["implement", "build", "waiting"],
      ]),
    ).toEqual(["update:U1 implement:build"]);
    expect(
      hits([
        ["update", "U1", "running"],
        ["resolve", "U1", "running"],
        ["check", "U1", "running"],
      ]),
    ).toEqual(["update:U1 resolve:U1 check:U1"]);
    expect(
      hits([
        ["fix", "checks", "waiting"],
        ["check", "checks", "running"],
      ]),
    ).toEqual(["fix:checks check:checks"]);
  });
});
