// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The fetch state of the task keys of a PR and the automatic read at run start (docs/plans/review-v2/jira-context.md sections 3.1, 3.2,
// 4.1, and 4.4). writeFetch() is the only writer of task_fetch rows. tasks.ts (Q.storeContext) is the only other writer of task_context.
import type { Database } from "bun:sqlite";
import { transition } from "xstate";
import { type IssueContext, JIRA_KEY, type RunKind } from "../../shared/dto";
import { log } from "../log";
import type { Settings } from "../settings";
import { type FetchState, fetchMachine } from "./fetch-machine";
import { ContextError, type ContextErrorKind, type ContextSource } from "./source";

// Section 3.2: a run reads at most 3 keys. Section 3.1: text and failures get a new read after 5 minutes.
export const MAX_KEYS = 3;
export const WINDOW_MS = 5 * 60_000;
// Section 4.4: a failure of these kinds gets no automatic read until Fetch or a Jira settings save.
export const STICKY: ReadonlySet<ContextErrorKind> = new Set(["auth", "forbidden", "not_found", "redirect"]);
// Section 4.7: "refresh" reads keys without text and text that is 5 min old or older. "missing" reads keys without text only. null: no
// automatic read (session consult and the task runs).
export const READS: Record<RunKind, "refresh" | "missing" | null> = {
  review: "refresh",
  explain: "refresh",
  ask: "missing",
  reply: "missing",
  fix: "missing",
  discuss: "missing",
  session: null,
  interview: null,
  spec: null,
  implement: null,
};

// The state of one key and the times that due() reads. kind: failed and refreshFailed only. at: ms of the task_fetch row.
export type FetchRow = { state: FetchState; kind: ContextErrorKind | null; at: number | null; fetchedAt: number | null };

// GET /prs/:id/task-fetch (section 4.8). One entry per pr_task key, in pr_task order. reason: the FAILED text of kind, else null.
export type TaskFetchDto = { key: string; state: FetchState; kind: ContextErrorKind | null; reason: string | null; at: number | null };

// gen: fetchGen() at the start of the failed read. A read that started before the last JIRA_SAVED can carry an old token.
export type FetchEvent =
  | { type: "AUTO_OK" | "MANUAL_OK"; issue: IssueContext }
  | { type: "AUTO_ERR" | "MANUAL_ERR"; kind: ContextErrorKind; gen: number }
  | { type: "CLEAR" | "JIRA_SAVED" };

// The count of JIRA_SAVED per database. Memory only: a restart ends all reads.
const gens = new WeakMap<Database, number>();
export const fetchGen = (db: Database) => gens.get(db) ?? 0;

type Stored = { fetchedAt: number | null; stored: "failed" | "skipped" | null; kind: ContextErrorKind | null; at: number | null };

const ROWS = `c.fetched_at AS fetchedAt, f.state AS stored, f.kind, f.at`;
const SQL = {
  one: `SELECT ${ROWS},
      EXISTS (SELECT 1 FROM pr_task WHERE pr = $pr AND key = $key) AS named,
      EXISTS (SELECT 1 FROM task WHERE origin_pr = $pr AND key = $key) AS owned
    FROM (SELECT $pr AS pr, $key AS key) k
    LEFT JOIN task_context c ON c.pr = k.pr AND c.key = k.key
    LEFT JOIN task_fetch f ON f.pr = k.pr AND f.key = k.key`,
  all: `SELECT t.key, ${ROWS}, EXISTS (SELECT 1 FROM task WHERE origin_pr = t.pr AND key = t.key) AS owned
    FROM pr_task t
    LEFT JOIN task_context c ON c.pr = t.pr AND c.key = t.key
    LEFT JOIN task_fetch f ON f.pr = t.pr AND f.key = t.key
    WHERE t.pr = $pr ORDER BY t.ord`,
  // The update keeps the task_attachment rows. A replace deletes them by the foreign key cascade.
  upsertText: `INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', $json, $at)
    ON CONFLICT (pr, key) DO UPDATE SET source = excluded.source, json = excluded.json, fetched_at = excluded.fetched_at`,
  dropText: "DELETE FROM task_context WHERE pr = $pr AND key = $key",
  upsertRow: `INSERT INTO task_fetch (pr, key, state, kind, at) VALUES ($pr, $key, $state, $kind, $at)
    ON CONFLICT (pr, key) DO UPDATE SET state = excluded.state, kind = excluded.kind, at = excluded.at`,
  dropRow: "DELETE FROM task_fetch WHERE pr = $pr AND key = $key",
  dropFailed: "DELETE FROM task_fetch WHERE pr = $pr AND key = $key AND state = 'failed'",
  failed: "SELECT pr, key FROM task_fetch WHERE state = 'failed' ORDER BY pr, key",
};

// The persisted state of section 4.4. tasks.ts writes task_context directly, so text with a skipped row can exist: the skip wins.
function stateOf(r: Stored): FetchState {
  if (r.stored === "skipped") return "skipped";
  if (r.stored === "failed") return r.fetchedAt === null ? "failed" : "refreshFailed";
  return r.fetchedAt === null ? "none" : "fetched";
}
const rowOf = (r: Stored): FetchRow => ({ state: stateOf(r), kind: r.kind, at: r.at, fetchedAt: r.fetchedAt });
const sticky = (r: FetchRow) => (r.state === "failed" || r.state === "refreshFailed") && r.kind !== null && STICKY.has(r.kind);

// Applies one event to (pr, key) in one transaction. Returns the new state, or null when the machine ignores the event or a guard
// fails: then nothing is written. CLEAR deletes the attachment rows by the cascade. The caller deletes their files.
export function writeFetch(db: Database, pr: number, key: string, event: FetchEvent, now = Date.now()): FetchState | null {
  return db.transaction((): FetchState | null => {
    const r = db.query(SQL.one).get({ pr, key }) as Stored & { named: number; owned: number };
    const current = !("gen" in event) || event.gen === fetchGen(db);
    const snapshot = fetchMachine.resolveState({ value: stateOf(r), context: { named: r.named === 1, owned: r.owned === 1, current } });
    if (!snapshot.can({ type: event.type })) return null;
    const [next] = transition(fetchMachine, snapshot, { type: event.type });
    switch (event.type) {
      case "AUTO_OK":
      case "MANUAL_OK":
        db.query(SQL.upsertText).run({ pr, key, json: JSON.stringify(event.issue), at: now });
        db.query(SQL.dropRow).run({ pr, key });
        break;
      case "AUTO_ERR":
      case "MANUAL_ERR":
        db.query(SQL.upsertRow).run({ pr, key, state: "failed", kind: event.kind, at: now });
        break;
      case "CLEAR":
        db.query(SQL.dropText).run({ pr, key });
        db.query(SQL.upsertRow).run({ pr, key, state: "skipped", kind: null, at: now });
        break;
      case "JIRA_SAVED":
        db.query(SQL.dropFailed).run({ pr, key });
    }
    return next.value as FetchState;
  })();
}

// A successful PUT /settings/jira: a new generation, then JIRA_SAVED to every key with a failed row. Returns the PR row IDs that changed.
export function jiraSaved(db: Database): number[] {
  gens.set(db, fetchGen(db) + 1);
  return db.transaction(() => {
    const rows = db.query(SQL.failed).all() as { pr: number; key: string }[];
    for (const r of rows) writeFetch(db, r.pr, r.key, { type: "JIRA_SAVED" });
    return [...new Set(rows.map((r) => r.pr))];
  })();
}

// The states of the pr_task keys of a PR, in pr_task order.
export function fetchStates(db: Database, pr: number): ({ key: string } & Omit<FetchRow, "fetchedAt">)[] {
  return (db.query(SQL.all).all({ pr }) as (Stored & { key: string })[]).map((r) => ({
    key: r.key,
    state: stateOf(r),
    kind: r.kind,
    at: r.at,
  }));
}

// The start table of section 4.4: does an automatic read of this key start now?
export function due(r: FetchRow, kind: RunKind, now: number): boolean {
  const reads = READS[kind];
  const old = (t: number | null) => t !== null && now - t >= WINDOW_MS;
  switch (r.state) {
    case "none":
      return reads !== null;
    case "fetched":
      return reads === "refresh" && old(r.fetchedAt);
    case "failed":
      return reads !== null && !sticky(r) && old(r.at);
    case "refreshFailed":
      return reads === "refresh" && !sticky(r) && old(r.at);
    case "skipped":
      return false;
  }
}

// Section 3.2. Eligible: a valid key that is not skipped, has no sticky failure, and is not the key of a task with this PR as origin.
// due: the keys among the first MAX_KEYS eligible keys that due() starts. capped: the later eligible keys without text.
export function plan(db: Database, pr: number, kind: RunKind, now: number): { due: string[]; capped: string[] } {
  if (READS[kind] === null) return { due: [], capped: [] };
  const eligible = (db.query(SQL.all).all({ pr }) as (Stored & { key: string; owned: number })[])
    .map((r) => ({ key: r.key, owned: r.owned === 1, row: rowOf(r) }))
    .filter((r) => JIRA_KEY.test(r.key) && !r.owned && r.row.state !== "skipped" && !sticky(r.row));
  return {
    due: eligible
      .slice(0, MAX_KEYS)
      .filter((r) => due(r.row, kind, now))
      .map((r) => r.key),
    capped: eligible
      .slice(MAX_KEYS)
      .filter((r) => r.row.fetchedAt === null)
      .map((r) => r.key),
  };
}

// Section 4.2: the issue, then one read of its parent, else of its epic. A failed parent read stores parentIssue null. The eval
// refetch (scripts/eval/refetch-tasks.ts) reads with it too.
export async function readIssue(source: ContextSource, key: string): Promise<IssueContext> {
  const issue = await source.fetchIssue(key);
  const up = issue.parent ?? issue.epic;
  if (!up) return issue;
  try {
    return { ...issue, parentIssue: await source.fetchParent(up) };
  } catch (e) {
    log(`Jira parent read of ${key} failed: ${e instanceof ContextError ? e.message : (e as Error).name}`);
    return { ...issue, parentIssue: null };
  }
}

// Section 4.1 step 3: one read per database, generation, and key at a time. Runs and POST /prs/:id/task-context/:key share it. Each
// caller writes its own event for its own (pr, key). gen: fetchGen() before the caller got source, so a read after a save never joins a
// read with the old token.
const inflight = new WeakMap<Database, Map<string, Promise<IssueContext>>>();
export function readShared(db: Database, source: ContextSource, key: string, gen: number): Promise<IssueContext> {
  const reads = inflight.get(db) ?? new Map<string, Promise<IssueContext>>();
  inflight.set(db, reads);
  const id = `${gen} ${key}`;
  const running = reads.get(id);
  if (running) return running;
  const read = readIssue(source, key).finally(() => reads.delete(id));
  reads.set(id, read);
  return read;
}

// One automatic read. done never rejects. It gives the state after the write and the kind of a failed read, or null when the write
// dropped: the database changed, or the machine ignored the event.
export type AutoRead = { key: string; done: Promise<{ state: FetchState; kind: ContextErrorKind | null } | null> };
// ca: settings.jira() threw, so no read started. capped: the eligible keys after the first MAX_KEYS that have no text. Both stay empty
// without Jira settings.
export type AutoFetch = { ca: boolean; capped: string[]; reads: AutoRead[] };

// Section 4.1 steps 2 to 4. It resolves when the reads have started and never rejects. The caller waits for done with its own deadline.
export async function autoFetch(db: Database, pr: number, kind: RunKind, settings: Pick<Settings, "db" | "jira">): Promise<AutoFetch> {
  const none: AutoFetch = { ca: false, capped: [], reads: [] };
  let keys: { due: string[]; capped: string[] };
  try {
    keys = plan(db, pr, kind, Date.now());
  } catch (e) {
    log(`Jira task read of PR row ${pr}: cannot read the rows: ${(e as Error).name}`);
    return none;
  }
  if (!keys.due.length && !keys.capped.length) return none;
  const gen = fetchGen(db);
  let source: ContextSource | null;
  try {
    source = await settings.jira();
  } catch {
    log("Jira task read: cannot read the Jira CA file.");
    return { ...none, ca: true };
  }
  if (!source) return none;
  // The write goes to the database of the read start. A settings swap closes that database, so the result drops.
  const write = (key: string, event: FetchEvent) => {
    try {
      if (settings.db() !== db) return null;
      return writeFetch(db, pr, key, event);
    } catch (e) {
      log(`Jira task read of ${key}: the write failed: ${(e as Error).name}`);
      return null;
    }
  };
  const jira = source;
  const reads = keys.due.map(
    (key): AutoRead => ({
      key,
      done: readShared(db, jira, key, gen).then(
        (issue) => {
          const state = write(key, { type: "AUTO_OK", issue });
          return state && { state, kind: null };
        },
        (e: unknown) => {
          // Section 4.4: an error that is not a ContextError counts as kind server. The log gets its name only.
          const kind = e instanceof ContextError ? e.kind : "server";
          log(`Jira task read of ${key} failed: ${e instanceof ContextError ? kind : (e as Error)?.name}`);
          const state = write(key, { type: "AUTO_ERR", kind, gen });
          return state && { state, kind };
        },
      ),
    }),
  );
  return { ca: false, capped: keys.capped, reads };
}
