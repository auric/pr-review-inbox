// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fetch machine of docs/plans/review-v2/jira-context.md section 4.4: every (state, event) cell, the guards, reachability, dead
// ends, the senders, the writers, the purity rules, and the rows that writeFetch() leaves after each cell.
import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initialTransition, transition } from "xstate";
import {
  FETCH_EVENTS,
  FETCH_STATES,
  type FetchContext,
  type FetchEventType,
  type FetchState,
  fetchMachine,
} from "../../src/server/context/fetch-machine";
import { type FetchEvent, fetchStates, writeFetch } from "../../src/server/context/task-fetch";
import { openDb } from "../../src/server/storage/db";
import type { IssueContext } from "../../src/shared/dto";

for (const m of ["context/fetch-machine", "context/task-fetch"])
  console.log(`fetch-machine.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

// Section 4.4, Transitions, cell by cell. A pair that the table leaves out is blank: the event is ignored, and nothing is written.
const TABLE: Record<FetchState, Partial<Record<FetchEventType, FetchState>>> = {
  none: { AUTO_OK: "fetched", AUTO_ERR: "failed", MANUAL_OK: "fetched", MANUAL_ERR: "failed", JIRA_SAVED: "none" },
  fetched: {
    AUTO_OK: "fetched",
    AUTO_ERR: "refreshFailed",
    MANUAL_OK: "fetched",
    MANUAL_ERR: "refreshFailed",
    CLEAR: "skipped",
    JIRA_SAVED: "fetched",
  },
  failed: { AUTO_OK: "fetched", AUTO_ERR: "failed", MANUAL_OK: "fetched", MANUAL_ERR: "failed", JIRA_SAVED: "none" },
  refreshFailed: {
    AUTO_OK: "fetched",
    AUTO_ERR: "refreshFailed",
    MANUAL_OK: "fetched",
    MANUAL_ERR: "refreshFailed",
    CLEAR: "skipped",
    JIRA_SAVED: "fetched",
  },
  skipped: { MANUAL_OK: "fetched", MANUAL_ERR: "failed", JIRA_SAVED: "skipped" },
};
// Section 4.4: AUTO_* also need pr_task to name the key and no task with (origin_pr, key) = (pr, key). MANUAL_* need pr_task.
const allowed = (type: FetchEventType, c: FetchContext) =>
  type.startsWith("AUTO_") ? c.named && !c.owned : type.startsWith("MANUAL_") ? c.named : true;
const CONTEXTS: FetchContext[] = [false, true].flatMap((named) => [false, true].map((owned) => ({ named, owned })));
const PASS: FetchContext = { named: true, owned: false };

function step(state: FetchState, type: FetchEventType, context: FetchContext = PASS) {
  const snapshot = fetchMachine.resolveState({ value: state, context });
  const can = snapshot.can({ type });
  const [next, actions] = transition(fetchMachine, snapshot, { type });
  expect(actions).toEqual([]);
  return { can, to: next.value as FetchState };
}

describe("fetch machine", () => {
  test("its states and events are those of section 4.4; the initial state is none", () => {
    expect(Object.keys(fetchMachine.config.states ?? {})).toEqual([...FETCH_STATES]);
    expect(Object.keys(TABLE)).toEqual([...FETCH_STATES]);
    expect([...new Set(Object.values(TABLE).flatMap((row) => Object.keys(row)))].sort()).toEqual([...FETCH_EVENTS].sort());
    const [first, actions] = initialTransition(fetchMachine);
    expect(first.value).toBe("none");
    expect(actions).toEqual([]);
  });

  test("the table has 25 filled cells and the 5 blank cells of section 4.4", () => {
    const blank = FETCH_STATES.flatMap((s) => FETCH_EVENTS.filter((e) => TABLE[s][e] === undefined).map((e) => `${s}/${e}`));
    expect(blank).toEqual(["none/CLEAR", "failed/CLEAR", "skipped/AUTO_OK", "skipped/AUTO_ERR", "skipped/CLEAR"]);
  });

  for (const state of FETCH_STATES)
    test(`${state}: every event of the table, allowed and ignored`, () => {
      for (const type of FETCH_EVENTS) {
        const cell = TABLE[state][type] ?? null;
        expect({ state, type, ...step(state, type) }).toEqual({ state, type, can: cell !== null, to: cell ?? state });
      }
    });

  test("guard grid: each cell under each named and owned value", () => {
    for (const state of FETCH_STATES)
      for (const type of FETCH_EVENTS)
        for (const context of CONTEXTS) {
          const cell = TABLE[state][type];
          const go = cell !== undefined && allowed(type, context);
          expect({ state, type, context, ...step(state, type, context) }).toEqual({
            state,
            type,
            context,
            can: go,
            to: go ? (cell as FetchState) : state,
          });
        }
  });
});

describe("reachability and dead ends", () => {
  test("every state is reachable from none, and every state has an edge to another state", () => {
    const seen = new Set<string>(["none"]);
    const out = new Map<string, Set<string>>();
    for (const queue: string[] = ["none"]; queue.length; ) {
      const state = queue.shift() as FetchState;
      const edges = new Set<string>();
      for (const context of CONTEXTS)
        for (const type of FETCH_EVENTS) {
          const s = step(state, type, context);
          if (!s.can) continue;
          if (s.to !== state) edges.add(s.to);
          if (!seen.has(s.to)) {
            seen.add(s.to);
            queue.push(s.to);
          }
        }
      out.set(state, edges);
    }
    expect([...seen].sort()).toEqual([...FETCH_STATES].sort());
    expect([...out].filter(([, e]) => e.size === 0).map(([s]) => s)).toEqual([]);
  });
});

describe("senders and writers", () => {
  const root = join(import.meta.dir, "../../src/server");
  const files = (readdirSync(root, { recursive: true }) as string[])
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".ts") && f !== "context/fetch-machine.ts");
  const text = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
  // A sender builds the event object `{ type: "E", ...}` or `{ type: "E" }`. The FetchEvent type has `{ type: "E" | ...` and is no sender.
  const senders = (e: string) => files.filter((f) => new RegExp(`\\{ type: "${e}"(?:,| \\})`).test(text.get(f) ?? ""));

  test("each event has a sender in the module of section 4.4", () => {
    expect(Object.fromEntries(FETCH_EVENTS.map((e) => [e, senders(e)]))).toEqual({
      AUTO_OK: ["context/task-fetch.ts"],
      AUTO_ERR: ["context/task-fetch.ts"],
      // tasks.ts storeContext sends it for the Build-task read of the origin PR text.
      MANUAL_OK: ["context/routes.ts", "tasks/tasks.ts"],
      MANUAL_ERR: ["context/routes.ts"],
      CLEAR: ["context/routes.ts"],
      // jiraSaved() sends it. PUT /settings/jira calls jiraSaved() after a successful save.
      JIRA_SAVED: ["context/task-fetch.ts"],
    });
    expect(text.get("context/routes.ts")).toMatch(/jiraSaved\(db\)/);
  });

  test("only task-fetch.ts writes task_fetch; task_context has one other writer, tasks.ts Q.storeContext", () => {
    const writes = (table: string) =>
      files.filter((f) => new RegExp(`(?:INSERT INTO|DELETE FROM|UPDATE|REPLACE INTO) ${table}\\b`).test(text.get(f) ?? ""));
    expect(writes("task_fetch")).toEqual(["context/task-fetch.ts"]);
    // jira-context.md section 4.4 names writeFetch() the only writer. tasks.ts storeContext writes directly only for a key that the
    // origin PR no longer names and for the status after a move. Both rows belong to a Build task.
    expect(writes("task_context")).toEqual(["context/task-fetch.ts", "tasks/tasks.ts"]);
  });
});

describe("purity", () => {
  const EFFECTS = ["entry", "exit", "invoke", "actions", "after", "always", "onDone", "onError"];
  const effectKeys = (v: unknown, path: string): string[] =>
    v === null || typeof v !== "object"
      ? []
      : Object.entries(v).flatMap(([k, x]) => [...(EFFECTS.includes(k) ? [`${path}.${k}`] : []), ...effectKeys(x, `${path}.${k}`)]);

  test("the machine has no actions, no invoke, and no delays; fetch-machine.ts imports only xstate", () => {
    expect(effectKeys(fetchMachine.config, "fetch")).toEqual([]);
    expect(Object.keys(fetchMachine.implementations.actions)).toEqual([]);
    expect(Object.keys(fetchMachine.implementations.actors)).toEqual([]);
    expect(Object.keys(fetchMachine.implementations.delays)).toEqual([]);
    const source = readFileSync(join(import.meta.dir, "../../src/server/context/fetch-machine.ts"), "utf8");
    const imports = source.match(/^import[^;]*;/gm) ?? [];
    expect(imports).toEqual(['import { setup } from "xstate";']);
  });
});

// Section 4.4, Write effects: each cell through writeFetch() and the rows it leaves.
describe("writeFetch: every cell through the rows", () => {
  const KEY = "ABC-1";
  const OLD = 1_000;
  const NOW = 50_000;
  const ISSUE: IssueContext = {
    key: KEY,
    summary: "New text",
    status: null,
    description: null,
    comments: [],
    commentsTotal: 0,
    truncated: false,
  };
  const EVENTS: Record<FetchEventType, FetchEvent> = {
    AUTO_OK: { type: "AUTO_OK", issue: ISSUE },
    AUTO_ERR: { type: "AUTO_ERR", kind: "timeout" },
    MANUAL_OK: { type: "MANUAL_OK", issue: ISSUE },
    MANUAL_ERR: { type: "MANUAL_ERR", kind: "not_found" },
    CLEAR: { type: "CLEAR" },
    JIRA_SAVED: { type: "JIRA_SAVED" },
  };

  // A database with one PR that names KEY, in the given state. A state with text has one downloaded attachment.
  function seeded(state: FetchState): { db: Database; pr: number } {
    const db = openDb(":memory:");
    const { id: pr } = db.query("INSERT INTO pull_request (project, repo, pr_id) VALUES ('P', 'r', 1) RETURNING id").get() as {
      id: number;
    };
    db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, $key, 'title', NULL, 0)").run({ pr, key: KEY });
    if (state === "fetched" || state === "refreshFailed") {
      db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', '{\"old\":1}', $at)").run({
        pr,
        key: KEY,
        at: OLD,
      });
      db.query(
        `INSERT INTO task_attachment (pr, key, att_id, filename, mime, size, file, sha256, image, text, include, downloaded_at)
          VALUES ($pr, $key, '1', 'a.log', NULL, 1, 'x/a.log', '', 0, 1, 0, 1)`,
      ).run({ pr, key: KEY });
    }
    if (state === "failed" || state === "refreshFailed")
      db.query("INSERT INTO task_fetch (pr, key, state, kind, at) VALUES ($pr, $key, 'failed', 'rate', $at)").run({
        pr,
        key: KEY,
        at: OLD,
      });
    if (state === "skipped")
      db.query("INSERT INTO task_fetch (pr, key, state, kind, at) VALUES ($pr, $key, 'skipped', NULL, $at)").run({ pr, key: KEY, at: OLD });
    expect(fetchStates(db, pr)).toMatchObject([{ key: KEY, state }]);
    return { db, pr };
  }
  const rows = (db: Database) => ({
    text: db.query("SELECT key, json, fetched_at FROM task_context").all(),
    fetch: db.query("SELECT key, state, kind, at FROM task_fetch").all(),
    files: db.query("SELECT key, att_id FROM task_attachment").all(),
  });

  for (const from of FETCH_STATES)
    test(`${from}: each event gives the state of the table and the rows of its effect`, () => {
      for (const type of FETCH_EVENTS) {
        const { db, pr } = seeded(from);
        const before = rows(db);
        const to = TABLE[from][type] ?? null;
        expect({ from, type, to: writeFetch(db, pr, KEY, EVENTS[type], NOW) }).toEqual({ from, type, to });
        expect({ from, type, state: fetchStates(db, pr)[0]?.state }).toEqual({ from, type, state: to ?? from });
        const after = rows(db);
        if (to === null) expect(after).toEqual(before);
        else if (type === "AUTO_OK" || type === "MANUAL_OK")
          expect(after).toEqual({ text: [{ key: KEY, json: JSON.stringify(ISSUE), fetched_at: NOW }], fetch: [], files: before.files });
        else if (type === "AUTO_ERR" || type === "MANUAL_ERR")
          expect(after).toEqual({
            ...before,
            fetch: [{ key: KEY, state: "failed", kind: (EVENTS[type] as { kind: string }).kind, at: NOW }],
          });
        else if (type === "CLEAR")
          expect(after).toEqual({ text: [], fetch: [{ key: KEY, state: "skipped", kind: null, at: NOW }], files: [] });
        else expect(after).toEqual({ ...before, fetch: before.fetch.filter((r) => (r as { state: string }).state !== "failed") });
        db.close();
      }
    });

  test("the guard facts come from pr_task and the task rows; a refused event writes nothing", () => {
    const { db, pr } = seeded("none");
    db.run(`INSERT INTO task (id, project, repo, key, title, origin_pr, state, target_branch, spec_dir, created_at, updated_at)
      VALUES (1, 'P', 'r', '${KEY}', 'T', ${pr}, 'implementing', 'main', 'specs/${KEY}/', 1, 1)`);
    expect(writeFetch(db, pr, KEY, EVENTS.AUTO_OK, NOW)).toBeNull();
    expect(writeFetch(db, pr, KEY, EVENTS.AUTO_ERR, NOW)).toBeNull();
    expect(rows(db)).toEqual({ text: [], fetch: [], files: [] });
    expect(writeFetch(db, pr, KEY, EVENTS.MANUAL_ERR, NOW)).toBe("failed");
    db.run("DELETE FROM pr_task");
    expect(writeFetch(db, pr, KEY, EVENTS.MANUAL_OK, NOW)).toBeNull();
    expect(writeFetch(db, pr, KEY, EVENTS.JIRA_SAVED, NOW)).toBe("none");
    expect(rows(db)).toEqual({ text: [], fetch: [], files: [] });
    db.close();
  });

  test("text with a skipped row, as a tasks.ts write after Clear leaves it, counts as skipped; Fetch ends it", () => {
    const { db, pr } = seeded("skipped");
    db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', '{}', $at)").run({
      pr,
      key: KEY,
      at: OLD,
    });
    expect(fetchStates(db, pr)[0]?.state).toBe("skipped");
    expect(writeFetch(db, pr, KEY, EVENTS.AUTO_OK, NOW)).toBeNull();
    expect(writeFetch(db, pr, KEY, EVENTS.MANUAL_OK, NOW)).toBe("fetched");
    expect(rows(db)).toEqual({ text: [{ key: KEY, json: JSON.stringify(ISSUE), fetched_at: NOW }], fetch: [], files: [] });
    db.close();
  });
});
