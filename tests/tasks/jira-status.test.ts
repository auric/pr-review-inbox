// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.20.9, 6.20.11, and 6.20.12 (WP-ST5, AC-B85, AC-B86): the Jira status read of the sync and of
// the Task view, "Read Jira again", and "Move in Jira". The fake Bitbucket and the fake Jira (Server and Cloud). No test reaches a real
// server or starts the CLI. Each move runs only on the call of the POST route, which stands for the confirm click.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createSyncEngine } from "../../src/server/sync/engine";
import { createTaskService } from "../../src/server/tasks/tasks";
import type { ApiError, TaskDto, TaskJiraMoveDto, TaskTransitionsDto } from "../../src/shared/dto";
import { JIRA_STATUS_AGE_MS, JIRA_VIEW_AGE_MS } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, startFakeBitbucket } from "../support/fake-bitbucket";
import { JIRA_EMAIL, JIRA_TOKEN, SUBTASK_PARENT, startFakeJira } from "../support/fake-jira";
import { fakeRunner, stubListTools } from "../support/review-fixture";

for (const m of ["tasks/tasks", "tasks/routes", "tasks/gates", "sync/engine"])
  console.log(`jira-status.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const PARENT_PATH = `/rest/api/2/issue/${SUBTASK_PARENT}`;
const REFUSED = "Jira refused the move (HTTP 400). Move ABC-12 in Jira.";

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// The app with a sync engine that does not run by itself, and a task ABC-10 with the sub-tasks of the fake set, as the create click
// stored them. The task is ready, so no kick starts the loop.
async function setup(o: { cloud?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-st5-")));
  dirs.push(root);
  const runner = fakeRunner(root);
  const fake = startFakeBitbucket();
  const jira = startFakeJira({ cloud: o.cloud });
  jira.addSubtaskSet();
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir: dataDir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const review = createReviewJobs({
    settings,
    live,
    dataDir,
    runnerCommand: runner.command,
    repoRemote: async () => ({ url: join(root, "none.git"), config: [] }),
    listTools: stubListTools,
    claudeConfigDir: join(root, "no-claude-config"),
  });
  const db = review.open() as Database;
  const sync = createSyncEngine({ settings, live });
  const app = createApp({ port: PORT, token: SESSION, live, settings, review, sync });
  cleanup.unshift(async () => {
    sync.stop();
    await review.stop();
    fake.stop();
    jira.stop();
    db.close();
  });
  const json = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const jiraBody = { baseUrl: jira.url, token: JIRA_TOKEN, ...(o.cloud && { email: JIRA_EMAIL }) };
  expect((await json("/api/settings/jira", { method: "PUT", body: jiraBody })).status).toBe(200);
  const id = (
    db
      .query(`INSERT INTO task (project, repo, key, title, state, size, target_branch, spec_dir, issue_json, subtasks, created_at, updated_at)
        VALUES ('PROJ', 'repo', $key, 'Split the cache work', 'ready', 'small', 'main', 'specs/ABC-10/', $issue, 1, 1, 1) RETURNING id`)
      .get({ key: SUBTASK_PARENT, issue: JSON.stringify({ key: SUBTASK_PARENT, summary: "Old text", status: "To Do" }) }) as { id: number }
  ).id;
  const stored = [
    ["ABC-11", "Done", "done"],
    ["ABC-12", "In Progress", "indeterminate"],
    ["ABC-13", "To Do", "new"],
    ["ABC-14", "To Do", "new"],
  ] as const;
  for (const [i, [key, status, category]] of stored.entries())
    db.query(`INSERT INTO task_subtask (task, key, ord, summary, status, category, issue_json, read_at, status_at)
        VALUES ($id, $key, $ord, $key, $status, $category, '{}', 1, 1)`).run({ id, key, ord: i + 1, status, category });
  const statusOf = (key: string) =>
    db.query("SELECT status, category FROM task_subtask WHERE task = $id AND key = $key").get({ id, key }) as {
      status: string | null;
      category: string | null;
    };
  // The status reads: one GET of the parent each. The writes: every request but GET.
  const reads = () => jira.count("GET", PARENT_PATH);
  const posts = () => jira.requests.filter((r) => !r.startsWith("GET "));
  return { root, db, fake, jira, settings, review, live, sync, json, id, statusOf, reads, posts };
}

describe("the status read of the sync (spec.md section 6.20.11, AC-B85)", () => {
  test("a sync cycle reads the statuses with one GET of the parent and sends no Jira POST; the next cycle within 5 minutes reads none", async () => {
    const h = await setup();
    h.jira.setStatus("ABC-12", "done");
    await h.sync.syncNow();
    expect(h.reads()).toBe(1);
    expect(h.jira.requests.filter((r) => r.startsWith(`GET ${PARENT_PATH}`))).toEqual([`GET ${PARENT_PATH}?fields=subtasks`]);
    expect(h.statusOf("ABC-12")).toEqual({ status: "Done", category: "done" });
    await h.sync.syncNow();
    await h.sync.syncNow();
    expect(h.reads()).toBe(1);
    expect(h.posts()).toEqual([]);
    const dto = (await h.json<TaskDto>(`/api/tasks/${h.id}`)).body;
    expect(dto.subtasks?.find((s) => s.key === "ABC-12")?.status).toBe("Done");
  });

  test("a done or failed task gets no read", async () => {
    const h = await setup();
    for (const state of ["done", "failed"]) {
      h.db.query("UPDATE task SET state = $state WHERE id = $id").run({ id: h.id, state });
      await h.sync.syncNow();
    }
    expect(h.reads()).toBe(0);
    expect(h.posts()).toEqual([]);
  });

  test("once per JIRA_STATUS_AGE_MS per task on a fake clock; a failed read keeps the stored status", async () => {
    const h = await setup();
    const clock = { t: 1_000_000 };
    const tasks = createTaskService({ review: h.review, settings: h.settings, live: h.live, now: () => clock.t });
    const route = PARENT_PATH.replace(/^/, "GET ");
    const served = h.jira.routes[route];
    h.jira.routes[route] = { status: 500, body: null };
    h.jira.setStatus("ABC-13", "indeterminate");
    expect(await tasks.syncStatuses(h.db)).toEqual([]);
    expect(h.reads()).toBe(1);
    expect(h.statusOf("ABC-13")).toEqual({ status: "To Do", category: "new" });

    h.jira.routes[route] = served as NonNullable<typeof served>;
    clock.t += JIRA_STATUS_AGE_MS - 1;
    expect(await tasks.syncStatuses(h.db)).toEqual([]);
    expect(h.reads()).toBe(1);
    clock.t += 1;
    expect(await tasks.syncStatuses(h.db)).toEqual([h.id]);
    expect(h.reads()).toBe(2);
    expect(h.statusOf("ABC-13")).toEqual({ status: "In Progress", category: "indeterminate" });
    // No change in Jira: a read, and no changed task.
    clock.t += JIRA_STATUS_AGE_MS;
    expect(await tasks.syncStatuses(h.db)).toEqual([]);
    expect(h.reads()).toBe(3);
    expect(h.posts()).toEqual([]);
  });
});

describe("the status read after the app opens a PR (spec.md section 6.20.9)", () => {
  test("statusDue makes the next sync cycle read within JIRA_STATUS_AGE_MS; a later cycle waits again", async () => {
    const h = await setup();
    const clock = { t: 1_000_000 };
    const tasks = createTaskService({ review: h.review, settings: h.settings, live: h.live, now: () => clock.t });
    await tasks.syncStatuses(h.db);
    expect(h.reads()).toBe(1);
    h.jira.setStatus("ABC-13", "indeterminate");
    clock.t += 1_000;
    tasks.statusDue(h.db, h.id);
    expect(await tasks.syncStatuses(h.db)).toEqual([h.id]);
    expect(h.reads()).toBe(2);
    expect(h.statusOf("ABC-13")).toEqual({ status: "In Progress", category: "indeterminate" });
    clock.t += 1_000;
    expect(await tasks.syncStatuses(h.db)).toEqual([]);
    expect(h.reads()).toBe(2);
    expect(h.posts()).toEqual([]);
  });
});

describe("the status read of the Task view (spec.md section 6.20.12, AC-B85)", () => {
  test("POST jira-check reads at most once per JIRA_VIEW_AGE_MS", async () => {
    const h = await setup();
    h.jira.setStatus("ABC-14", "indeterminate");
    const first = await h.json<TaskDto>(`/api/tasks/${h.id}/jira-check`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(first.body.subtasks?.find((s) => s.key === "ABC-14")?.status).toBe("In Progress");
    expect((await h.json<TaskDto>(`/api/tasks/${h.id}/jira-check`, { method: "POST" })).status).toBe(200);
    expect(h.reads()).toBe(1);

    const clock = { t: 5_000_000 };
    const tasks = createTaskService({ review: h.review, settings: h.settings, live: h.live, now: () => clock.t });
    await tasks.jiraCheck(h.db, h.id);
    clock.t += JIRA_VIEW_AGE_MS - 1;
    await tasks.jiraCheck(h.db, h.id);
    expect(h.reads()).toBe(2);
    clock.t += 1;
    await tasks.jiraCheck(h.db, h.id);
    expect(h.reads()).toBe(3);
    expect((await h.json<ApiError>("/api/tasks/999/jira-check", { method: "POST" })).status).toBe(404);
    expect(h.posts()).toEqual([]);
  });

  test("Read Jira again: the texts, links, and statuses, with the version check and no write", async () => {
    const h = await setup();
    expect((await h.json<ApiError>(`/api/tasks/${h.id}/jira-read`, { body: { version: 7 } })).status).toBe(409);
    h.jira.setStatus("ABC-11", "indeterminate");
    const r = await h.json<TaskDto>(`/api/tasks/${h.id}/jira-read`, { body: { version: 0 } });
    expect(r.status).toBe(200);
    const subs = r.body.subtasks ?? [];
    expect(subs.find((s) => s.key === "ABC-11")).toMatchObject({ summary: "Batch the cache writes", status: "In Progress" });
    expect(subs.find((s) => s.key === "ABC-13")?.links).toEqual([{ text: "is blocked by", key: "ABC-12" }]);
    const issue = JSON.parse(
      (h.db.query("SELECT issue_json FROM task WHERE id = $id").get({ id: h.id }) as { issue_json: string }).issue_json,
    ) as { summary: string };
    expect(issue.summary).toBe("Split the cache work into sub-tasks");
    expect(h.posts()).toEqual([]);
  });
});

describe("Move in Jira (spec.md sections 6.20.9 and 6.20.12, AC-B86)", () => {
  for (const cloud of [false, true])
    test(`${cloud ? "Cloud" : "Server"}: the list is a read; only the confirm sends one POST; a 400 gives the sentence`, async () => {
      const h = await setup({ cloud });
      const list = await h.json<TaskTransitionsDto>(`/api/tasks/${h.id}/jira/ABC-12/transitions`);
      expect(list.status).toBe(200);
      expect(list.body.transitions).toEqual([
        { id: "11", name: "To Do", to: "To Do" },
        { id: "21", name: "In Progress", to: "In Progress" },
        { id: "31", name: "Done", to: "Done" },
      ]);
      expect(h.posts()).toEqual([]);

      // The fake refuses a POST without X-Atlassian-Token: no-check and JSON, so the 200 proves both.
      const moved = await h.json<TaskJiraMoveDto>(`/api/tasks/${h.id}/jira/ABC-12/transitions`, { body: { id: "31" } });
      expect(moved.status).toBe(200);
      expect(moved.body.status).toBe("Done");
      expect(moved.body.task.subtasks?.find((s) => s.key === "ABC-12")).toMatchObject({ status: "Done", category: "done" });
      expect(h.posts()).toEqual(["POST /rest/api/2/issue/ABC-12/transitions"]);
      expect(h.jira.transitions.get("ABC-12")).toEqual(["31"]);

      // The parent moves too, and its stored status follows.
      const parent = await h.json<TaskJiraMoveDto>(`/api/tasks/${h.id}/jira/${SUBTASK_PARENT}/transitions`, { body: { id: "31" } });
      expect(parent.status).toBe(200);
      const issue = JSON.parse(
        (h.db.query("SELECT issue_json FROM task WHERE id = $id").get({ id: h.id }) as { issue_json: string }).issue_json,
      ) as { status: string };
      expect(issue.status).toBe("Done");

      // Jira refuses a move that needs fields: 400, the fixed sentence, and no retry.
      h.jira.routes["POST /rest/api/2/issue/ABC-12/transitions"] = { status: 400, body: { errorMessages: ["Field required."] } };
      const refused = await h.json<ApiError>(`/api/tasks/${h.id}/jira/ABC-12/transitions`, { body: { id: "21" } });
      expect(refused).toEqual({ status: 502, body: { error: REFUSED } });
      expect(h.posts().length).toBe(3);
    });

  test("a move that Jira does not offer, a key outside the task, and bad input send no POST", async () => {
    const h = await setup();
    const stale = await h.json<ApiError>(`/api/tasks/${h.id}/jira/ABC-12/transitions`, { body: { id: "99" } });
    expect(stale.status).toBe(409);
    expect((await h.json<ApiError>(`/api/tasks/${h.id}/jira/ABC-99/transitions`, { body: { id: "31" } })).status).toBe(404);
    expect((await h.json<ApiError>(`/api/tasks/${h.id}/jira/ABC-99/transitions`)).status).toBe(404);
    expect((await h.json<ApiError>(`/api/tasks/${h.id}/jira/abc-12/transitions`, { body: { id: "31" } })).status).toBe(400);
    expect((await h.json<ApiError>(`/api/tasks/${h.id}/jira/ABC-12/transitions`, { body: { id: "3a" } })).status).toBe(400);
    expect(h.posts()).toEqual([]);
  });
});
