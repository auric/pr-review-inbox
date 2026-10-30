// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task and part states (docs/plans/review-v2/spec.md section 6.2). XState v5 serves as a pure transition function only: the
// machines have no actions and no invoke, no code starts an actor, and no snapshot goes into SQLite. advance() (tasks.ts) is the
// only writer of task.state and task_part.state. A later change adds events and guards only, together with tests/tasks/machine.test.ts.
import { type AnyStateMachine, setup } from "xstate";
import type { TaskSize, TaskState } from "../../shared/task";

// The facts that the guards read. The app passes them; the machine stores nothing. gate: the spec or part PR passed its review rules.
export type TaskContext = { size: TaskSize | null; gate: boolean; stoppedFrom: TaskState | null };
export type PartContext = { gate: boolean };

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
  "MERGED",
  "DECLINED",
  "REOPENED",
  "ABANDON",
  // spec.md section 6.20.7: the plan approval follows an open or merged PR that the app did not create.
  "ADOPT_OPEN",
  "ADOPT_MERGED",
] as const;
export type PartEvent = { type: (typeof PART_EVENTS)[number] };

// Stop, a restart, or a usage limit stops a task in any of these states. Resume goes back to the state in stopped_from.
const RESUMABLE = ["interview", "spec_draft", "spec_pr_open", "spec_approved", "implementing", "ready"] as const satisfies TaskState[];
const halt = { STOP: "stopped", FAIL: "failed" } as const;

// BUILD creates the task in the initial state (initialTransition). No state takes it: a second click opens the same task.
export const taskMachine = setup({
  types: { context: {} as TaskContext, events: {} as TaskEvent },
  guards: {
    small: ({ context }) => context.size === "small",
    planReview: ({ context }) => context.size === "medium" || context.size === "large",
    gate: ({ context }) => context.gate,
    stoppedFrom: ({ context }, params: { state: TaskState }) => context.stoppedFrom === params.state,
  },
}).createMachine({
  id: "task",
  initial: "interview",
  context: { size: null, gate: false, stoppedFrom: null },
  states: {
    interview: { on: { ASKED: "interview", ANSWERED: "spec_draft", ...halt } },
    spec_draft: {
      on: {
        APPROVE: [
          { guard: "small", target: "implementing" },
          { guard: "planReview", target: "spec_draft" },
        ],
        OPEN_SPEC_PR: { guard: "planReview", target: "spec_pr_open" },
        ...halt,
      },
    },
    spec_pr_open: {
      on: { SPEC_GATE_PASSED: { guard: "gate", target: "spec_approved" }, OVERRIDE: "spec_approved", CLOSE: "done", ...halt },
    },
    spec_approved: { on: { START_BUILDING: "implementing", ...halt } },
    implementing: { on: { PART_READY: "implementing", LAST_PR_OPEN: "ready", ...halt } },
    ready: { on: { ALL_MERGED: "done", CLOSE: "done", ...halt } },
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

export const partMachine = setup({
  types: { context: {} as PartContext, events: {} as PartEvent },
  guards: { gate: ({ context }) => context.gate },
}).createMachine({
  id: "part",
  initial: "planned",
  context: { gate: false },
  states: {
    planned: { on: { START: "implementing", ABANDON: "abandoned", ADOPT_OPEN: "pr_open", ADOPT_MERGED: "merged" } },
    implementing: { on: { REVIEWED: "self_reviewed", ABANDON: "abandoned" } },
    self_reviewed: { on: { PR_OPENED: "pr_open", ABANDON: "abandoned" } },
    // Bitbucket merges or declines a PR whatever the app's review rules say.
    pr_open: {
      on: {
        CHANGES_REQUESTED: "changes_requested",
        GATE_PASSED: { guard: "gate", target: "approved" },
        MERGED: "merged",
        DECLINED: "declined",
      },
    },
    changes_requested: { on: { GATE_PASSED: { guard: "gate", target: "approved" }, MERGED: "merged", DECLINED: "declined" } },
    approved: { on: { CHANGES_REQUESTED: "changes_requested", MERGED: "merged", DECLINED: "declined" } },
    merged: { type: "final" },
    declined: { on: { REOPENED: "pr_open", ABANDON: "abandoned" } },
    abandoned: { type: "final" },
  },
});

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
