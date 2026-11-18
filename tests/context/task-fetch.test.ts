// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The automatic task read of docs/plans/review-v2/jira-context.md sections 3.1, 3.2, 4.1, and 4.4 against the fake Jira: the key
// choice, the start table, the late writes, the shared read, the stored parent, JIRA_SAVED, the CA file, and no Jira. No test calls a
// real server.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import type { FetchState } from "../../src/server/context/fetch-machine";
import { createJiraSource } from "../../src/server/context/jira";
import {
  autoFetch,
  due,
  type FetchRow,
  fetchStates,
  MAX_KEYS,
  plan,
  STICKY,
  type TaskFetchDto,
  WINDOW_MS,
  writeFetch,
} from "../../src/server/context/task-fetch";
import { createLive } from "../../src/server/live";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings, type Settings } from "../../src/server/settings";
import { openDb } from "../../src/server/storage/db";
import type { IssueContext, RunKind } from "../../src/shared/dto";
import { key as route } from "../support/fake-bitbucket";
import { type FakeJira, ISSUE_KEY, JIRA_TOKEN, startFakeJira } from "../support/fake-jira";

for (const m of ["context/task-fetch", "context/routes"])
  console.log(`task-fetch.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const root = mkdtempSync(join(tmpdir(), "rl-task-fetch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let jira: FakeJira;
let n = 0;
const opened: Settings[] = [];
beforeEach(() => {
  jira = startFakeJira();
});
afterEach(() => {
  jira.stop();
  for (const s of opened.splice(0)) s.close();
});

const ISSUE_PATH = `/rest/api/2/issue/${ISSUE_KEY}`;
const KINDS: RunKind[] = ["review", "explain", "ask", "reply", "fix", "discuss", "session", "interview", "spec", "implement"];
const REFRESH: RunKind[] = ["review", "explain"];
const MISSING: RunKind[] = ["ask", "reply", "fix", "discuss"];

// A database with one PR that names these keys in this order.
function dbWith(keys: string[] = [ISSUE_KEY]): { db: Database; pr: number } {
  const db = openDb(":memory:");
  const { id: pr } = db.query("INSERT INTO pull_request (project, repo, pr_id) VALUES ('P', 'r', 1) RETURNING id").get() as { id: number };
  for (const [ord, key] of keys.entries())
    db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, $key, 'title', NULL, $ord)").run({ pr, key, ord });
  return { db, pr };
}
const source = () => createJiraSource({ baseUrl: jira.url, token: JIRA_TOKEN });
const deps = (db: Database) => ({ db: () => db, jira: async () => source() });
const text = (db: Database, key: string) =>
  db.query("SELECT json, fetched_at FROM task_context WHERE key = $key").get({ key }) as { json: string; fetched_at: number } | null;
const ISSUE = (key: string): IssueContext => ({
  key,
  summary: "Stored",
  status: null,
  description: null,
  comments: [],
  commentsTotal: 0,
  truncated: false,
});

// Holds each GET of path until release. started resolves when the first one arrives. A test that never releases ends at its timeout.
function hold(path: string) {
  const k = route("GET", path);
  const inner = jira.routes[k];
  let release = () => {};
  let arrived = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    arrived = r;
  });
  jira.routes[k] = async (req) => {
    arrived();
    await gate;
    return typeof inner === "function" ? inner(req) : (inner ?? { status: 404, body: null });
  };
  return { release, started };
}
const within = <T>(p: Promise<T>, ms = 5_000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no result in ${ms} ms`)), ms))]);

describe("due(): the start table of section 4.4", () => {
  const NOW = 10 * WINDOW_MS;
  const row = (state: FetchState, age: number | null, kind: FetchRow["kind"] = null): FetchRow => ({
    state,
    kind,
    at: state === "failed" || state === "refreshFailed" || state === "skipped" ? NOW - (age ?? 0) : null,
    fetchedAt: state === "fetched" || state === "refreshFailed" ? NOW - (age ?? 0) : null,
  });
  // [row, review/re-review/Explain, Ask/reply/Fix/discuss]. Ages: exactly 5 min, and 1 ms less.
  const OTHER = ["rate", "server", "shape", "timeout", "network"] as const;
  const cases: [string, FetchRow, boolean, boolean][] = [
    ["none", row("none", null), true, true],
    ["fetched 5 min ago", row("fetched", WINDOW_MS), true, false],
    ["fetched 5 min - 1 ms ago", row("fetched", WINDOW_MS - 1), false, false],
    ...[...STICKY].map((k): [string, FetchRow, boolean, boolean] => [
      `failed ${k} long ago`,
      row("failed", 9 * WINDOW_MS, k),
      false,
      false,
    ]),
    ...OTHER.map((k): [string, FetchRow, boolean, boolean] => [`failed ${k} 5 min ago`, row("failed", WINDOW_MS, k), true, true]),
    ["failed timeout 5 min - 1 ms ago", row("failed", WINDOW_MS - 1, "timeout"), false, false],
    ...[...STICKY].map((k): [string, FetchRow, boolean, boolean] => [
      `refreshFailed ${k} long ago`,
      row("refreshFailed", 9 * WINDOW_MS, k),
      false,
      false,
    ]),
    ...OTHER.map((k): [string, FetchRow, boolean, boolean] => [
      `refreshFailed ${k} 5 min ago`,
      row("refreshFailed", WINDOW_MS, k),
      true,
      false,
    ]),
    ["refreshFailed rate 5 min - 1 ms ago", row("refreshFailed", WINDOW_MS - 1, "rate"), false, false],
    ["skipped long ago", row("skipped", 9 * WINDOW_MS), false, false],
  ];

  test("the sticky kinds are auth, forbidden, not_found, and redirect", () => {
    expect([...STICKY].sort()).toEqual(["auth", "forbidden", "not_found", "redirect"]);
  });

  for (const [name, r, refresh, missing] of cases)
    test(`${name}: review, re-review, and Explain ${refresh ? "start" : "do not start"}; Ask, reply, Fix, and discuss ${missing ? "start" : "do not start"}`, () => {
      for (const k of REFRESH) expect({ k, start: due(r, k, NOW) }).toEqual({ k, start: refresh });
      for (const k of MISSING) expect({ k, start: due(r, k, NOW) }).toEqual({ k, start: missing });
      // Section 4.7: session consult and the task runs never read.
      for (const k of KINDS.filter((x) => !REFRESH.includes(x) && !MISSING.includes(x)))
        expect({ k, start: due(r, k, NOW) }).toEqual({ k, start: false });
    });
});

describe("plan(): the key choice of section 3.2 (AC-JC4)", () => {
  const NOW = 100 * WINDOW_MS;
  // In pr_task order: skipped, sticky failure, task-owned, an invalid key, fresh text, no text, an old timeout, no text, old text.
  function mixed() {
    const keys = ["ABC-1", "ABC-2", "ABC-3", "abc-4", "ABC-5", "ABC-6", "ABC-7", "ABC-8", "ABC-9"];
    const { db, pr } = dbWith(keys);
    const fetchRow = (key: string, state: string, kind: string | null, at: number) =>
      db
        .query("INSERT INTO task_fetch (pr, key, state, kind, at) VALUES ($pr, $key, $state, $kind, $at)")
        .run({ pr, key, state, kind, at });
    const textRow = (key: string, at: number) =>
      db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', '{}', $at)").run({ pr, key, at });
    fetchRow("ABC-1", "skipped", null, 1);
    fetchRow("ABC-2", "failed", "not_found", 1);
    db.run(`INSERT INTO task (id, project, repo, key, title, origin_pr, state, target_branch, spec_dir, created_at, updated_at)
      VALUES (1, 'P', 'r', 'ABC-3', 'T', ${pr}, 'implementing', 'main', 'specs/ABC-3/', 1, 1)`);
    textRow("ABC-5", NOW - 1);
    fetchRow("ABC-7", "failed", "timeout", NOW - WINDOW_MS);
    textRow("ABC-9", 1);
    return { db, pr };
  }

  test("the first 3 eligible keys in pr_task order; skipped, sticky, task-owned, and invalid keys do not count; fresh text uses a slot", () => {
    const { db, pr } = mixed();
    expect(MAX_KEYS).toBe(3);
    for (const k of REFRESH) expect(plan(db, pr, k, NOW)).toEqual({ due: ["ABC-6", "ABC-7"], capped: ["ABC-8"] });
    for (const k of MISSING) expect(plan(db, pr, k, NOW)).toEqual({ due: ["ABC-6", "ABC-7"], capped: ["ABC-8"] });
    for (const k of ["session", "interview", "spec", "implement"] as const) expect(plan(db, pr, k, NOW)).toEqual({ due: [], capped: [] });
    db.close();
  });

  test("Clear, then Fetch: the key leaves the eligible list and comes back", () => {
    const { db, pr } = dbWith(["ABC-1", "ABC-2", "ABC-3", "ABC-4"]);
    expect(plan(db, pr, "review", NOW)).toEqual({ due: ["ABC-1", "ABC-2", "ABC-3"], capped: ["ABC-4"] });
    expect(writeFetch(db, pr, "ABC-1", { type: "MANUAL_OK", issue: ISSUE("ABC-1") }, NOW)).toBe("fetched");
    expect(writeFetch(db, pr, "ABC-1", { type: "CLEAR" }, NOW)).toBe("skipped");
    expect(plan(db, pr, "review", NOW)).toEqual({ due: ["ABC-2", "ABC-3", "ABC-4"], capped: [] });
    expect(writeFetch(db, pr, "ABC-1", { type: "MANUAL_OK", issue: ISSUE("ABC-1") }, NOW)).toBe("fetched");
    expect(plan(db, pr, "review", NOW + WINDOW_MS)).toEqual({ due: ["ABC-1", "ABC-2", "ABC-3"], capped: ["ABC-4"] });
    db.close();
  });
});

describe("autoFetch()", () => {
  test("AC-JC1, section 4.2: a due key gets one issue read and one epic read; the row stores the parent text", async () => {
    jira.addFullIssue("ABC-17");
    const { db, pr } = dbWith(["ABC-17"]);
    const a = await autoFetch(db, pr, "review", deps(db));
    expect({ ca: a.ca, capped: a.capped, keys: a.reads.map((r) => r.key) }).toEqual({ ca: false, capped: [], keys: ["ABC-17"] });
    expect(await within(a.reads[0]?.done as Promise<unknown>)).toEqual({ state: "fetched", kind: null });
    const stored = JSON.parse(text(db, "ABC-17")?.json ?? "{}") as IssueContext;
    expect(stored.parentIssue).toMatchObject({ key: "ABC-30", summary: "Rework the cache layer" });
    expect([jira.count("GET", "/rest/api/2/issue/ABC-17"), jira.count("GET", "/rest/api/2/issue/ABC-30")]).toEqual([1, 1]);
    // AC-JC2 and AC-JC3: a younger text gets no request from any run kind.
    const before = jira.requests.length;
    for (const k of [...REFRESH, ...MISSING]) expect((await autoFetch(db, pr, k, deps(db))).reads).toEqual([]);
    expect(jira.requests.length).toBe(before);
    db.close();
  });

  test("a failed read stores failed with its kind and logs the key and the kind only; a non-ContextError counts as server", async () => {
    jira.routes[route("GET", ISSUE_PATH)] = { status: 404, body: { errorMessages: ["BODY-CANARY jdoe@example.com"] } };
    const { db, pr } = dbWith();
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...l: unknown[]) => void lines.push(l.map(String).join(" ")));
    try {
      const a = await autoFetch(db, pr, "review", deps(db));
      expect(await within(a.reads[0]?.done as Promise<unknown>)).toEqual({ state: "failed", kind: "not_found" });
      expect(fetchStates(db, pr)).toEqual([{ key: ISSUE_KEY, state: "failed", kind: "not_found", at: expect.any(Number) }]);
      // not_found is sticky: no later run reads it.
      expect((await autoFetch(db, pr, "review", deps(db))).reads).toEqual([]);

      const other = dbWith();
      const broken = {
        db: () => other.db,
        jira: async () => ({
          ...source(),
          fetchIssue: async () => {
            throw new TypeError(`token ${JIRA_TOKEN}`);
          },
        }),
      };
      const b = await autoFetch(other.db, other.pr, "ask", broken);
      expect(await within(b.reads[0]?.done as Promise<unknown>)).toEqual({ state: "failed", kind: "server" });
      other.db.close();
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([`Jira task read of ${ISSUE_KEY} failed: not_found`, `Jira task read of ${ISSUE_KEY} failed: TypeError`]);
    for (const l of lines) for (const bad of ["BODY-CANARY", "jdoe@", JIRA_TOKEN]) expect(l).not.toContain(bad);
    expect(JSON.stringify(db.query("SELECT * FROM task_fetch").all())).not.toContain("CANARY");
    db.close();
  });

  test("AC-JC7: without Jira settings no request starts; with no due key, jira() is not called", async () => {
    const { db, pr } = dbWith(["ABC-1", "ABC-2", "ABC-3", "ABC-4"]);
    expect(await autoFetch(db, pr, "review", { db: () => db, jira: async () => null })).toEqual({ ca: false, capped: [], reads: [] });
    for (const k of ["ABC-1", "ABC-2", "ABC-3", "ABC-4"]) writeFetch(db, pr, k, { type: "MANUAL_OK", issue: ISSUE(k) });
    let calls = 0;
    const counted = {
      db: () => db,
      jira: async () => {
        calls++;
        return source();
      },
    };
    expect(await autoFetch(db, pr, "review", counted)).toEqual({ ca: false, capped: [], reads: [] });
    expect(await autoFetch(db, pr, "session", counted)).toEqual({ ca: false, capped: [], reads: [] });
    expect(calls).toBe(0);
    expect(jira.requests).toEqual([]);
    db.close();
  });

  test("section 4.6: an unreadable CA file gives ca and no read; the capped keys come back with Jira", async () => {
    const { db, pr } = dbWith(["ABC-1", "ABC-2", "ABC-3", "ABC-4", "ABC-5"]);
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...l: unknown[]) => void lines.push(l.map(String).join(" ")));
    try {
      const ca = {
        db: () => db,
        jira: async (): Promise<null> => {
          throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
        },
      };
      expect(await autoFetch(db, pr, "review", ca)).toEqual({ ca: true, capped: [], reads: [] });
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual(["Jira task read: cannot read the Jira CA file."]);
    expect(jira.requests).toEqual([]);
    expect(fetchStates(db, pr).map((r) => r.state)).toEqual(["none", "none", "none", "none", "none"]);
    const a = await autoFetch(db, pr, "review", deps(db));
    expect({ capped: a.capped, keys: a.reads.map((r) => r.key) }).toEqual({
      capped: ["ABC-4", "ABC-5"],
      keys: ["ABC-1", "ABC-2", "ABC-3"],
    });
    await within(Promise.all(a.reads.map((r) => r.done)));
    db.close();
  });

  test("AC-JC12: the key of a task with this PR as origin gets no automatic read", async () => {
    const { db, pr } = dbWith();
    db.run(`INSERT INTO task (id, project, repo, key, title, origin_pr, state, target_branch, spec_dir, created_at, updated_at)
      VALUES (1, 'P', 'r', '${ISSUE_KEY}', 'T', ${pr}, 'implementing', 'main', 'specs/${ISSUE_KEY}/', 1, 1)`);
    expect(await autoFetch(db, pr, "review", deps(db))).toEqual({ ca: false, capped: [], reads: [] });
    expect(jira.requests).toEqual([]);
    db.close();
  });

  test("AC-JC5: a result after the caller stopped waiting is stored for the next run", async () => {
    const held = hold(ISSUE_PATH);
    const { db, pr } = dbWith();
    const a = await autoFetch(db, pr, "review", deps(db));
    const done = a.reads[0]?.done as Promise<unknown>;
    expect(await Promise.race([done, Bun.sleep(20).then(() => "deadline")])).toBe("deadline");
    expect(text(db, ISSUE_KEY)).toBeNull();
    held.release();
    expect(await within(done)).toEqual({ state: "fetched", kind: null });
    expect(fetchStates(db, pr)[0]?.state).toBe("fetched");
    db.close();
  });

  test("AC-JC8: a late result after Clear is ignored; the key stays skipped", async () => {
    const { db, pr } = dbWith();
    writeFetch(db, pr, ISSUE_KEY, { type: "MANUAL_OK", issue: ISSUE(ISSUE_KEY) }, 1);
    const held = hold(ISSUE_PATH);
    const a = await autoFetch(db, pr, "review", deps(db));
    await within(held.started);
    expect(writeFetch(db, pr, ISSUE_KEY, { type: "CLEAR" })).toBe("skipped");
    held.release();
    expect(await within(a.reads[0]?.done as Promise<unknown>)).toBeNull();
    expect(fetchStates(db, pr)[0]?.state).toBe("skipped");
    expect(text(db, ISSUE_KEY)).toBeNull();
    expect((await autoFetch(db, pr, "review", deps(db))).reads).toEqual([]);
    db.close();
  });

  test("section 4.1 step 4: a late result after a database change drops; neither database gets a row", async () => {
    const { db, pr } = dbWith();
    const next = dbWith();
    let current = db;
    const held = hold(ISSUE_PATH);
    const a = await autoFetch(db, pr, "review", { db: () => current, jira: async () => source() });
    await within(held.started);
    current = next.db;
    held.release();
    expect(await within(a.reads[0]?.done as Promise<unknown>)).toBeNull();
    for (const d of [db, next.db]) {
      expect(d.query("SELECT COUNT(*) AS n FROM task_context").get()).toEqual({ n: 0 });
      expect(d.query("SELECT COUNT(*) AS n FROM task_fetch").get()).toEqual({ n: 0 });
    }
    // A closed database also drops the result, and done still resolves.
    const held2 = hold(ISSUE_PATH);
    const b = await autoFetch(next.db, next.pr, "review", { db: () => next.db, jira: async () => source() });
    await within(held2.started);
    next.db.close();
    held2.release();
    expect(await within(b.reads[0]?.done as Promise<unknown>)).toBeNull();
    // A database accessor that throws drops the result too, and done still resolves.
    const third = dbWith();
    const held3 = hold(ISSUE_PATH);
    let broken = false;
    const c = await autoFetch(third.db, third.pr, "review", {
      db: () => {
        if (broken) throw new Error("settings gone");
        return third.db;
      },
      jira: async () => source(),
    });
    await within(held3.started);
    broken = true;
    held3.release();
    expect(await within(c.reads[0]?.done as Promise<unknown>)).toBeNull();
    expect(third.db.query("SELECT COUNT(*) AS n FROM task_context").get()).toEqual({ n: 0 });
    third.db.close();
    db.close();
  });
});

describe("with the routes", () => {
  const PORT = 7317;
  const SESSION = "s".repeat(64);
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };

  function setup(keys: string[]) {
    const dir = join(root, `case-${n++}`);
    writeConfig(dir, { baseUrl: "https://bitbucket.example.test", userSlug: "jdoe", notifications: false });
    const settings = createSettings({ dir, secrets: createSecrets(null), jiraSecrets: createSecrets(null, "jira-token") });
    opened.push(settings);
    const db = settings.db();
    if (!db) throw new Error("no db");
    const prs = [1, 2].map((id) => {
      const pr = (
        db.query("INSERT INTO pull_request (project, repo, pr_id) VALUES ('P', 'r', $id) RETURNING id").get({ id }) as { id: number }
      ).id;
      for (const [ord, key] of keys.entries())
        db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, $key, 'title', NULL, $ord)").run({ pr, key, ord });
      return pr;
    });
    const live = createLive();
    const events: unknown[] = [];
    live.broadcast = (event, data) => void events.push({ event, data });
    const review = createReviewJobs({ settings, live, dataDir: dir });
    const app = createApp({ port: PORT, token: SESSION, live, settings, review });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(`${ORIGIN}/api${path}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
    const connect = () => call("PUT", "/settings/jira", { baseUrl: jira.url, token: JIRA_TOKEN });
    return { settings, db, prs, events, call, connect };
  }

  test("AC-JC10: two runs and a Fetch of the same key send one issue read; each writes its own row", async () => {
    const s = setup([ISSUE_KEY]);
    expect((await s.connect()).status).toBe(200);
    const before = jira.requests.length;
    const held = hold(ISSUE_PATH);
    const [p1, p2] = s.prs as [number, number];
    const a = await autoFetch(s.db, p1, "review", s.settings);
    const b = await autoFetch(s.db, p2, "explain", s.settings);
    await within(held.started);
    const post = Promise.resolve(s.call("POST", `/prs/${p1}/task-context/${ISSUE_KEY}`));
    held.release();
    expect((await within(post)).status).toBe(200);
    expect(await within(Promise.all([...a.reads, ...b.reads].map((r) => r.done)))).toEqual([
      { state: "fetched", kind: null },
      { state: "fetched", kind: null },
    ]);
    expect(jira.count("GET", ISSUE_PATH)).toBe(1);
    expect(jira.requests.length - before).toBe(3);
    for (const pr of s.prs) expect(fetchStates(s.db, pr)).toEqual([{ key: ISSUE_KEY, state: "fetched", kind: null, at: null }]);
    // The next read is a new one.
    expect((await s.call("POST", `/prs/${p2}/task-context/${ISSUE_KEY}`)).status).toBe(200);
    expect(jira.count("GET", ISSUE_PATH)).toBe(2);
  });

  test("AC-JC9: a Jira settings save ends every failed state; fetched text stays, skipped stays, and the PRs get changed", async () => {
    const s = setup(["ABC-1", "ABC-2", "ABC-3"]);
    expect((await s.connect()).status).toBe(200);
    const [p1, p2] = s.prs as [number, number];
    writeFetch(s.db, p1, "ABC-1", { type: "AUTO_ERR", kind: "auth" });
    writeFetch(s.db, p1, "ABC-2", { type: "MANUAL_OK", issue: ISSUE("ABC-2") }, 7);
    writeFetch(s.db, p1, "ABC-2", { type: "AUTO_ERR", kind: "timeout" });
    writeFetch(s.db, p1, "ABC-3", { type: "MANUAL_OK", issue: ISSUE("ABC-3") }, 7);
    writeFetch(s.db, p1, "ABC-3", { type: "CLEAR" });
    writeFetch(s.db, p2, "ABC-1", { type: "MANUAL_ERR", kind: "forbidden" });
    const get = async (pr: number) => (await (await s.call("GET", `/prs/${pr}/task-fetch`)).json()) as TaskFetchDto[];
    expect((await get(p1)).map((r) => [r.key, r.state, r.kind])).toEqual([
      ["ABC-1", "failed", "auth"],
      ["ABC-2", "refreshFailed", "timeout"],
      ["ABC-3", "skipped", null],
    ]);
    s.events.length = 0;
    expect((await s.connect()).status).toBe(200);
    expect(s.events).toEqual([{ event: "changed", data: { prs: [p1, p2] } }]);
    expect((await get(p1)).map((r) => [r.key, r.state])).toEqual([
      ["ABC-1", "none"],
      ["ABC-2", "fetched"],
      ["ABC-3", "skipped"],
    ]);
    expect(text(s.db, "ABC-2")?.fetched_at).toBe(7);
    expect((await get(p2)).map((r) => r.state)).toEqual(["none", "none", "none"]);
    // A save with no failed row broadcasts nothing.
    s.events.length = 0;
    expect((await s.connect()).status).toBe(200);
    expect(s.events).toEqual([]);
  });
});
