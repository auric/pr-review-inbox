// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { Database } from "bun:sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { dbPath, writeConfig } from "../../src/server/config";
import { listPrs } from "../../src/server/inbox/queries";
import { createLive } from "../../src/server/live";
import { createSecrets } from "../../src/server/secrets";
import { createSettings, type Settings } from "../../src/server/settings";
import { createSyncEngine, type SyncEngine } from "../../src/server/sync/engine";
import type { SettingsDto, TaskPreviewDto, TaskPreviewError } from "../../src/shared/dto";
import { FAKE_TOKEN, FAKE_USER, type FakeBitbucket, key, startFakeBitbucket } from "../support/fake-bitbucket";
import { ACTIVITIES_PATH, activities, DASHBOARD_PATH, onePage, ownPr } from "../support/scenarios";

process.env.REVIEW_LOOP_SECRETS = "memory";
const root = mkdtempSync(join(tmpdir(), "rl-tasks-"));
process.env.REVIEW_LOOP_DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PORT = 7317;
const SESSION = "s".repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ID = String.raw`[A-Z][A-Z0-9]+-\d+`;
const LINK = "https://tracker.example.test/browse/{key}";

let fake: FakeBitbucket;
let pr: ReturnType<typeof ownPr>;
let n = 0;
beforeEach(() => {
  pr = { ...ownPr(), title: "[ABC-10145] Fix of foobar", description: "Also XYZ-7." };
  (pr.fromRef as unknown as { displayId: string }).displayId = "feature/ABC-10613-monitor-api-integration";
  fake = startFakeBitbucket({
    routes: {
      [key("GET", DASHBOARD_PATH)]: (req) => ({
        status: 200,
        body: onePage(new URL(req.url).searchParams.get("role") === "AUTHOR" ? [pr] : []),
      }),
      [key("GET", ACTIVITIES_PATH)]: { status: 200, body: onePage(activities("activities-opened-only.json")) },
    },
  });
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  fake.stop();
});

// JavaScriptCore stops runaway backtracking after about 950 ms. The ReDoS tests pass budgets well below that.
const FAST = { budgetMs: 50, retryBudgetMs: 100 };
// Budgets well above the defaults, so a normal pattern does not time out on a busy machine.
const SLOW = { budgetMs: 5_000, retryBudgetMs: 5_000 };

async function setup(taskBudget = SLOW) {
  const dir = join(root, `case-${n++}`);
  writeConfig(dir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings: Settings = createSettings({ dir, secrets, taskBudget });
  const live = createLive();
  const sync: SyncEngine = createSyncEngine({ settings, live });
  const app = createApp({ port: PORT, token: SESSION, live, settings, sync });
  cleanup.push(() => {
    sync.stop();
    settings.close();
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`${ORIGIN}${path}`, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const rows = () => listPrs(settings.db() as Database, FAKE_USER);
  return {
    dir,
    settings,
    sync,
    call,
    rows,
    put: (body: Record<string, unknown>) => call("PUT", "/api/settings", { baseUrl: fake.url, ...body }),
    preview: (body: unknown) => call("POST", "/api/settings/task-rules/preview", body),
    config: () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")),
  };
}

// Waits for the background pass that a settings save starts.
async function until(check: () => boolean) {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("task IDs in sync", () => {
  test("sync writes the default-rule IDs, with sources, into the row", async () => {
    const s = await setup();
    await s.sync.syncNow();
    expect(s.rows()[0]?.tasks).toEqual([
      { key: "ABC-10613", source: "branch", url: null },
      { key: "ABC-10145", source: "title", url: null },
      { key: "XYZ-7", source: "description", url: null },
    ]);
  });

  test("an unchanged input hash skips the extraction", async () => {
    const s = await setup();
    await s.sync.syncNow();
    const db = s.settings.db() as Database;
    db.query("UPDATE pr_task SET url = 'marker'").run();
    await s.sync.syncNow();
    expect(s.rows()[0]?.tasks.every((t) => t.url === "marker")).toBe(true);
    pr.title = "[ABC-2] Other";
    await s.sync.syncNow();
    expect(s.rows()[0]?.tasks.map((t) => t.key)).toEqual(["ABC-10613", "ABC-2", "XYZ-7"]);
  });

  test("a rule change recomputes every PR in the background, and taskLink builds the URLs", async () => {
    const s = await setup();
    await s.sync.syncNow();
    const res = await s.put({ taskRules: [{ source: "title", pattern: ID, keys: ["ABC"] }], taskLink: LINK });
    expect(res.status).toBe(200);
    await until(() => s.rows()[0]?.tasks.length === 1);
    expect(s.rows()[0]?.tasks).toEqual([{ key: "ABC-10145", source: "title", url: "https://tracker.example.test/browse/ABC-10145" }]);
  });

  test("close during the background pass stops it without an error log or a write", async () => {
    const s = await setup();
    await s.sync.syncNow();
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      expect((await s.put({ taskRules: [{ source: "title", pattern: ID, keys: ["ABC"] }] })).status).toBe(200);
      s.settings.close();
      // The pass needs one worker reply per PR. This wait covers it with a wide margin.
      await Bun.sleep(1_000);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([]);
    const db = new Sqlite(dbPath(s.dir, fake.url), { readonly: true });
    try {
      expect(db.query("SELECT key FROM pr_task ORDER BY ord").all()).toEqual([
        { key: "ABC-10613" },
        { key: "ABC-10145" },
        { key: "XYZ-7" },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("task-rule settings", () => {
  test("rules and taskLink persist in config.json and come back in GET", async () => {
    const s = await setup();
    const before = (await (await s.call("GET", "/api/settings")).json()) as SettingsDto;
    expect(before.taskRules.map((r) => r.source)).toEqual(["branch", "title", "description"]);
    expect(before.taskRules.every((r) => r.pattern === ID && r.keys === undefined && !r.timedOut)).toBe(true);
    expect(before.taskLink).toBeNull();

    const rules = [{ source: "branch", pattern: String.raw`(ABC-\d+)`, keys: ["ABC"] }];
    expect((await s.put({ taskRules: rules, taskLink: LINK })).status).toBe(200);
    expect(s.config()).toMatchObject({ taskRules: rules, taskLink: LINK });
    const after = (await (await s.call("GET", "/api/settings")).json()) as SettingsDto;
    expect(after).toMatchObject({ taskRules: [{ ...rules[0], timedOut: false }], taskLink: LINK });

    // Absent fields keep the stored values. An empty taskLink clears it.
    expect((await s.put({ notifications: true })).status).toBe(200);
    expect(s.config()).toMatchObject({ taskRules: rules, taskLink: LINK, notifications: true });
    expect((await s.put({ taskLink: "" })).status).toBe(200);
    expect(s.config().taskLink).toBeUndefined();
  });

  test("PUT rejects a syntax error and an unsafe taskLink", async () => {
    const s = await setup();
    expect((await s.put({ taskRules: [{ source: "title", pattern: "([A-Z]+" }] })).status).toBe(400);
    expect((await s.put({ taskLink: "http://tracker.example.test/{key}" })).status).toBe(400);
    expect((await s.put({ taskRules: [{ source: "title", pattern: "x".repeat(201) }] })).status).toBe(400);
    expect(s.config().taskRules).toBeUndefined();
  });

  test("a sync timeout marks the rule timed_out until the user edits it", async () => {
    const s = await setup(FAST);
    pr.description = `${"a".repeat(19_999)}!`;
    const redos = { source: "description", pattern: "(a+)+$" };
    expect((await s.put({ taskRules: [{ source: "branch", pattern: ID }, redos] })).status).toBe(200);
    await s.sync.syncNow();
    expect(s.rows()[0]?.tasks.map((t) => t.key)).toEqual(["ABC-10613"]);
    expect(s.config().taskRules[1]).toEqual({ ...redos, timedOut: true });
    // Saved unchanged, the rule stays timed out. Edited, it runs again.
    expect((await s.put({ taskRules: [{ source: "branch", pattern: ID }, redos] })).status).toBe(200);
    expect(s.config().taskRules[1].timedOut).toBe(true);
    expect(
      (
        await s.put({
          taskRules: [
            { source: "branch", pattern: ID },
            { ...redos, pattern: "(b+)+$" },
          ],
        })
      ).status,
    ).toBe(200);
    expect(s.config().taskRules[1].timedOut).toBeUndefined();
  });
});

describe("POST /api/settings/task-rules/preview", () => {
  test("a syntax error gives 400 with the error per rule", async () => {
    const s = await setup();
    const res = await s.preview({
      rules: [
        { source: "title", pattern: ID },
        { source: "title", pattern: "([A-Z]+" },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as TaskPreviewError;
    expect(body.rules[0]).toEqual({ error: null, timedOut: false });
    expect(body.rules[1]?.error).toEqual(expect.any(String));
  });

  test("runs draft rules on the sample and the listed PRs", async () => {
    const s = await setup();
    await s.sync.syncNow();
    const res = await s.preview({
      rules: [{ source: "branch", pattern: ID }],
      sample: { branch: "bugfix/ABC-10145-name-of-ticket" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskPreviewDto;
    expect(body.rules).toEqual([{ error: null, timedOut: false }]);
    expect(body.sample).toEqual([{ key: "ABC-10145", source: "branch" }]);
    expect(body.prs).toEqual([
      {
        id: expect.any(Number),
        project: "~JDOE",
        repo: "sample-repo-1",
        prId: 2,
        title: "[ABC-10145] Fix of foobar",
        tasks: [{ key: "ABC-10613", source: "branch" }],
      },
    ]);
  });

  test("a draft ReDoS rule reports timedOut and the other rules still run", async () => {
    const s = await setup(FAST);
    const res = await s.preview({
      rules: [
        { source: "description", pattern: "(a+)+$" },
        { source: "title", pattern: ID },
      ],
      sample: { title: "[ABC-10145] Fix of foobar", description: `${"a".repeat(19_999)}!` },
      prs: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskPreviewDto;
    expect(body.rules).toEqual([
      { error: null, timedOut: true },
      { error: null, timedOut: false },
    ]);
    expect(body.sample).toEqual([{ key: "ABC-10145", source: "title" }]);
  });

  test("an invalid body gives 400", async () => {
    const s = await setup();
    expect((await s.preview({ rules: [{ source: "commit", pattern: ID }] })).status).toBe(400);
    expect((await s.preview({ rules: [], prs: Array.from({ length: 21 }, (_, i) => i + 1) })).status).toBe(400);
  });
});
