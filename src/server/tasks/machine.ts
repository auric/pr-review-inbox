// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task and part states (docs/plans/review-v2/spec.md section 6.2) and the phase of a part (part-session.md section 9.3.3). XState v5 serves as a pure transition function only: the
// machines have no actions and no invoke, no code starts an actor, and no snapshot goes into SQLite. advance() (tasks.ts) is the
// only writer of task.state and task_part.state. A later change adds events and guards only, together with tests/tasks/machine.test.ts.
import { type AnyStateMachine, setup } from "xstate";
import type { TaskSize, TaskState } from "../../shared/task";

// The facts that the guards read. The app passes them; the machine stores nothing. gate: the spec or part PR passed its review rules.
// selfReview: task.settings_json.planReview is "self" (self-approved-plans.md section 4.1). openChecklist: a task_external row is open
// (task-builder-v2.md section 11.1, the FINISHED guard). Absent counts as false.
export type TaskContext = {
  size: TaskSize | null;
  gate: boolean;
  stoppedFrom: TaskState | null;
  selfReview: boolean;
  openChecklist?: boolean;
};
// unpushed: task_part.pushed is NULL. A continued branch holds the remote head there, so RESTART never needs a force push. Absent
// counts as false.
export type PartContext = { gate: boolean; unpushed?: boolean };

export const TASK_EVENTS = [
  "BUILD",
  "ASKED",
  "ANSWERED",
  "APPROVE",
  "OPEN_SPEC_PR",
  "SPEC_GATE_PASSED",
  "OVERRIDE",
  "START_BUILDING",
  "PART_READY",
  "LAST_PR_OPEN",
  "ALL_MERGED",
  "STOP",
  "RESUME",
  "FAIL",
  "CLOSE",
] as const;
export type TaskEvent = { type: (typeof TASK_EVENTS)[number] };

export const PART_EVENTS = [
  "START",
  "REVIEWED",
  "PR_OPENED",
  "CHANGES_REQUESTED",
  "GATE_PASSED",
  // spec.md section 6.20.7: a later sync finds that the part gate of an approved part fails.
  "GATE_FAILED",
  "MERGED",
  "DECLINED",
  "REOPENED",
  "ABANDON",
  // spec.md section 6.20.7: the plan approval follows an open or merged PR that the app did not create.
  "ADOPT_OPEN",
  "ADOPT_MERGED",
  // part-session.md section 9.3.2: "Start this part again" of a part that has no push.
  "RESTART",
] as const;
export type PartEvent = { type: (typeof PART_EVENTS)[number] };

// The user's Stop, or an error that no reason covers, stops a task in any of these states. Resume goes back to the state in stopped_from.
const RESUMABLE = ["interview", "spec_draft", "spec_pr_open", "spec_approved", "implementing", "ready"] as const satisfies TaskState[];
const halt = { STOP: "stopped", FAIL: "failed" } as const;

// BUILD creates the task in the initial state (initialTransition). No state takes it: a second click opens the same task.
export const taskMachine = setup({
  types: { context: {} as TaskContext, events: {} as TaskEvent },
  guards: {
    noSpecPr: ({ context }) => context.size === "small" || context.size === "medium" || (context.size === "large" && context.selfReview),
    specPr: ({ context }) => context.size === "large" && !context.selfReview,
    gate: ({ context }) => context.gate,
    stoppedFrom: ({ context }, params: { state: TaskState }) => context.stoppedFrom === params.state,
    checklistDone: ({ context }) => context.openChecklist !== true,
  },
}).createMachine({
  id: "task",
  initial: "interview",
  context: { size: null, gate: false, stoppedFrom: null, selfReview: false },
  states: {
    interview: { on: { ASKED: "interview", ANSWERED: "spec_draft", ...halt } },
    spec_draft: {
      on: {
        APPROVE: [
          { guard: "noSpecPr", target: "implementing" },
          { guard: "specPr", target: "spec_draft" },
        ],
        OPEN_SPEC_PR: { guard: "specPr", target: "spec_pr_open" },
        ...halt,
      },
    },
    spec_pr_open: {
      on: { SPEC_GATE_PASSED: { guard: "gate", target: "spec_approved" }, OVERRIDE: "spec_approved", CLOSE: "done", ...halt },
    },
    spec_approved: { on: { START_BUILDING: "implementing", ...halt } },
    implementing: { on: { PART_READY: "implementing", LAST_PR_OPEN: "ready", ...halt } },
    // spec.md section 6.20.14: the approval of a changed plan adds a part to build.
    ready: {
      on: { ALL_MERGED: { guard: "checklistDone", target: "done" }, CLOSE: "done", START_BUILDING: "implementing", ...halt },
    },
    stopped: {
      on: {
        RESUME: RESUMABLE.map((state) => ({ guard: { type: "stoppedFrom" as const, params: { state } }, target: state })),
        CLOSE: "done",
        FAIL: "failed",
      },
    },
    // Close sets closed_at only.
    done: { on: { CLOSE: "done" } },
    failed: { type: "final" },
  },
});

const restart = { RESTART: { guard: "unpushed", target: "implementing" } } as const;

export const partMachine = setup({
  types: { context: {} as PartContext, events: {} as PartEvent },
  guards: { gate: ({ context }) => context.gate, unpushed: ({ context }) => context.unpushed === true },
}).createMachine({
  id: "part",
  initial: "planned",
  context: { gate: false },
  states: {
    planned: { on: { START: "implementing", ABANDON: "abandoned", ADOPT_OPEN: "pr_open", ADOPT_MERGED: "merged" } },
    implementing: { on: { REVIEWED: "self_reviewed", ...restart, ABANDON: "abandoned" } },
    self_reviewed: { on: { PR_OPENED: "pr_open", ...restart, ABANDON: "abandoned" } },
    // Bitbucket merges or declines a PR whatever the app's review rules say.
    pr_open: {
      on: {
        CHANGES_REQUESTED: "changes_requested",
        GATE_PASSED: { guard: "gate", target: "approved" },
        MERGED: "merged",
        DECLINED: "declined",
      },
    },
    // A withdrawn "Needs work" with a failing gate goes back to pr_open (part-session.md G3).
    changes_requested: {
      on: { GATE_PASSED: { guard: "gate", target: "approved" }, GATE_FAILED: "pr_open", MERGED: "merged", DECLINED: "declined" },
    },
    approved: { on: { CHANGES_REQUESTED: "changes_requested", GATE_FAILED: "pr_open", MERGED: "merged", DECLINED: "declined" } },
    merged: { type: "final" },
    declined: { on: { REOPENED: "pr_open", ABANDON: "abandoned" } },
    abandoned: { type: "final" },
  },
});

export const EXTERNAL_EVENTS = ["DONE", "WAIVE", "REOPEN"] as const;
export type ExternalEvent = { type: (typeof EXTERNAL_EVENTS)[number] };

// task-builder-v2.md section 11.4: one checklist row (task_external.state). ADD is the insert in the initial state (initialTransition).
// No state is final, because the FINISHED guard of the task reads the states.
export const externalMachine = setup({ types: { events: {} as ExternalEvent } }).createMachine({
  id: "external",
  initial: "open",
  states: {
    open: { on: { DONE: "done", WAIVE: "waived" } },
    done: { on: { REOPEN: "open" } },
    waived: { on: { REOPEN: "open" } },
  },
});

export const PLAN_CHECK_EVENTS = ["CLEAN", "SHOWN", "REPAIR", "REPAIRED", "FAILED", "STOPPED"] as const;
export type PlanCheckEvent = { type: (typeof PLAN_CHECK_EVENTS)[number] };

// spec.md sections 6.22.5 and 6.22.6: task.docs_json.check of one plan version. The spec run finish writes the initial state. A repair
// that fails keeps the first plan, so FAILED in repairing gives shown. A new spec run replaces the docs and so ends the machine.
export const planCheckMachine = setup({ types: { events: {} as PlanCheckEvent } }).createMachine({
  id: "planCheck",
  initial: "pending",
  states: {
    pending: { on: { CLEAN: "clean", SHOWN: "shown", REPAIR: "repairing", FAILED: "failed", STOPPED: "stopped" } },
    repairing: { on: { REPAIRED: "repaired", FAILED: "shown", STOPPED: "stopped" } },
    clean: { type: "final" },
    shown: { type: "final" },
    repaired: { type: "final" },
    failed: { type: "final" },
    stopped: { type: "final" },
  },
});

export const PHASES = [
  "idle",
  "setup",
  "baseline",
  "building",
  "checking",
  "fixing",
  "critic",
  "judging",
  "reviewing",
  "following",
  "updating",
  "resolving",
] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_EVENTS = [
  "GO",
  "UPDATE",
  "CLEAN",
  "WAIT",
  "STOPPED",
  "RUN_DONE",
  "RUN_CUT",
  "CHECKS_GREEN",
  "CHECKS_RED",
  "POINTS",
  "CONFLICT",
] as const;
export type PhaseEvent = { type: (typeof PHASE_EVENTS)[number] };

// part-session.md section 9.3.3, Context: the loop computes each fact from SQLite rows and the worktree before each send.
export const PHASE_GUARDS = [
  "setup",
  "baseline",
  "follow",
  "run",
  "checks",
  "critic",
  "review",
  "firstCut",
  "afterUpdate",
  "redBefore",
  "triesLeft",
  "unchanged",
  "roundsLeft",
] as const;
export type PhaseContext = Record<(typeof PHASE_GUARDS)[number], boolean>;

const ended = { WAIT: "idle", STOPPED: "idle" } as const;
const cut = (state: Phase) => ({ RUN_CUT: [{ guard: "firstCut", target: state }, { target: "idle" }] }) as const;
const runDone = [{ guard: "unchanged", target: "idle" }, { target: "checking" }] as const;

// The phase of one part (part-session.md section 9.3.3). Flat, so machineMermaid prints it. GO takes the first guard that holds. A GO
// with no guard that holds is refused: the part has no work.
export const phaseMachine = setup({
  types: { context: {} as PhaseContext, events: {} as PhaseEvent },
  guards: Object.fromEntries(PHASE_GUARDS.map((k) => [k, ({ context }: { context: PhaseContext }) => context[k]])) as Record<
    (typeof PHASE_GUARDS)[number],
    (a: { context: PhaseContext }) => boolean
  >,
}).createMachine({
  id: "phase",
  initial: "idle",
  context: Object.fromEntries(PHASE_GUARDS.map((k) => [k, false])) as PhaseContext,
  states: {
    idle: {
      on: {
        GO: [
          { guard: "setup", target: "setup" },
          { guard: "baseline", target: "baseline" },
          { guard: "follow", target: "following" },
          { guard: "run", target: "building" },
          { guard: "checks", target: "checking" },
          { guard: "critic", target: "critic" },
          { guard: "review", target: "reviewing" },
        ],
        UPDATE: "updating",
      },
    },
    setup: { on: { CLEAN: "idle", ...ended } },
    // A check that the app refuses (checks.ts runChecks, such as an unaccepted warning) waits with error/app in the baseline too.
    baseline: { on: { CLEAN: "idle", ...ended } },
    building: { on: { RUN_DONE: "checking", ...cut("building"), ...ended } },
    checking: {
      on: {
        CHECKS_GREEN: "idle",
        CHECKS_RED: [
          { guard: "afterUpdate", target: "idle" },
          { guard: "redBefore", target: "idle" },
          { guard: "triesLeft", target: "fixing" },
          { target: "idle" },
        ],
        ...ended,
      },
    },
    fixing: { on: { RUN_DONE: runDone, ...cut("fixing"), ...ended } },
    critic: { on: { POINTS: "judging", CLEAN: "idle", STOPPED: "idle" } },
    judging: { on: { RUN_DONE: "checking", ...cut("judging"), ...ended } },
    reviewing: { on: { POINTS: [{ guard: "roundsLeft", target: "judging" }, { target: "idle" }], CLEAN: "idle", ...ended } },
    following: { on: { RUN_DONE: runDone, ...cut("following"), ...ended } },
    updating: { on: { CLEAN: "checking", CONFLICT: "resolving", ...ended } },
    resolving: { on: { RUN_DONE: "updating", ...ended } },
  },
});

// part-session.md section 9.7, invariant 7: the events that no code sends yet, and the package that adds the sender.
export const RESERVED: Partial<Record<TaskEvent["type"] | PartEvent["type"] | PhaseEvent["type"], string>> = {
  OPEN_SPEC_PR: "WP-B8",
  SPEC_GATE_PASSED: "WP-B8",
  OVERRIDE: "WP-B8",
  FAIL: "none: part-session.md section 9.3.1 names no package",
};

type GuardConfig = string | { type: string; params?: Record<string, unknown> };
type TransitionConfig = string | { target: string; guard?: GuardConfig };
type NodeConfig = { type?: string; on?: Record<string, TransitionConfig | TransitionConfig[]> };

const guardText = (g: GuardConfig) => (typeof g === "string" ? g : [g.type, ...Object.values(g.params ?? {}).map(String)].join(" "));

// A Mermaid stateDiagram-v2 of a machine, from its config only. Each transition line names the event and its guard.
export function machineMermaid(machine: AnyStateMachine): string {
  const config = machine.config as { initial?: string; states?: Record<string, NodeConfig> };
  const lines = ["stateDiagram-v2", `  [*] --> ${config.initial}`];
  for (const [from, node] of Object.entries(config.states ?? {})) {
    for (const [event, t] of Object.entries(node.on ?? {}))
      for (const one of [t].flat()) {
        const { target, guard } = typeof one === "string" ? { target: one, guard: undefined } : one;
        lines.push(`  ${from} --> ${target}: ${event}${guard === undefined ? "" : ` if ${guardText(guard)}`}`);
      }
    if (node.type === "final") lines.push(`  ${from} --> [*]`);
  }
  return lines.join("\n");
}
