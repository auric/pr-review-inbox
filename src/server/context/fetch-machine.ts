// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fetch state of one task key of a PR (docs/plans/review-v2/jira-context.md section 4.4). XState v5 serves as a pure transition
// function only, as in src/server/tasks/machine.ts. writeFetch() (task-fetch.ts) applies it and is the only writer of task_fetch rows.
// A later change adds events and guards only, together with tests/context/fetch-machine.test.ts.
import { setup } from "xstate";

// The persisted states. The rows of task_context and task_fetch give the state (task-fetch.ts stateOf). Nothing persists "fetching".
export const FETCH_STATES = ["none", "fetched", "failed", "refreshFailed", "skipped"] as const;
export type FetchState = (typeof FETCH_STATES)[number];

export const FETCH_EVENTS = ["AUTO_OK", "AUTO_ERR", "MANUAL_OK", "MANUAL_ERR", "CLEAR", "JIRA_SAVED"] as const;
export type FetchEventType = (typeof FETCH_EVENTS)[number];

// The facts that the guards read. named: pr_task names the key. owned: a task row has (origin_pr, key) = (pr, key).
export type FetchContext = { named: boolean; owned: boolean };

// AUTO_* need named and not owned. MANUAL_* need named. CLEAR and JIRA_SAVED have no guard.
const auto = (target: FetchState) => ({ guard: "auto", target }) as const;
const manual = (target: FetchState) => ({ guard: "named", target }) as const;

// A state without an event ignores it, and nothing is written.
export const fetchMachine = setup({
  types: { context: {} as FetchContext, events: {} as { type: FetchEventType } },
  guards: {
    auto: ({ context }) => context.named && !context.owned,
    named: ({ context }) => context.named,
  },
}).createMachine({
  id: "fetch",
  initial: "none",
  context: { named: false, owned: false },
  states: {
    none: {
      on: {
        AUTO_OK: auto("fetched"),
        AUTO_ERR: auto("failed"),
        MANUAL_OK: manual("fetched"),
        MANUAL_ERR: manual("failed"),
        JIRA_SAVED: "none",
      },
    },
    fetched: {
      on: {
        AUTO_OK: auto("fetched"),
        AUTO_ERR: auto("refreshFailed"),
        MANUAL_OK: manual("fetched"),
        MANUAL_ERR: manual("refreshFailed"),
        CLEAR: "skipped",
        JIRA_SAVED: "fetched",
      },
    },
    failed: {
      on: {
        AUTO_OK: auto("fetched"),
        AUTO_ERR: auto("failed"),
        MANUAL_OK: manual("fetched"),
        MANUAL_ERR: manual("failed"),
        JIRA_SAVED: "none",
      },
    },
    refreshFailed: {
      on: {
        AUTO_OK: auto("fetched"),
        AUTO_ERR: auto("refreshFailed"),
        MANUAL_OK: manual("fetched"),
        MANUAL_ERR: manual("refreshFailed"),
        CLEAR: "skipped",
        JIRA_SAVED: "fetched",
      },
    },
    skipped: { on: { MANUAL_OK: manual("fetched"), MANUAL_ERR: manual("failed"), JIRA_SAVED: "skipped" } },
  },
});
