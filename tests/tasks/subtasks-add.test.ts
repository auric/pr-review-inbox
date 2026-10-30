// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.20.14 (WP-ST7, AC-B87): plan changes from Jira. The status read marks a key that is new in Jira
// and a key that Jira no longer lists. "Add to plan" reads the new sub-task, downloads its files, and runs a short plan run for the new
// key only. A part comes only with the approval of the changed plan, and no part of the approved plan changes. A removed key gets Drop.
// The fake CLI, the fake Bitbucket, the fake Jira, and a temp git remote. No test starts the real CLI or reaches a forge or Jira.
import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createTaskService } from "../../src/server/tasks/tasks";
import type { ApiError, TaskDto } from "../../src/shared/dto";
import { JIRA_STATUS_AGE_MS } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, readRecords } from "../support/fake-claude";
import { JIRA_TOKEN, logOf, SUBTASK_PARENT, startFakeJira } from "../support/fake-jira";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskRemote } from "./fixture";

for (const m of ["tasks/tasks", "tasks/subtasks"])
  console.log(`subtasks-add.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const NO_QUESTIONS = { done: true, summary: "Echo: build the sub-tasks.", questions: [], unknowns: [], coverage: NO_COVERAGE };
// The fake set of ABC-10 (fake-jira.ts addSubtaskSet), plus the sub-task that a colleague adds after the approval.
const SET = [
  { key: "ABC-11", summary: "Batch the cache writes", category: "done" as const },
  { key: "ABC-12", summary: "Add the event generator", category: "indeterminate" as const },
  { key: "ABC-13", summary: "Flush before the write lock", category: "new" as const },
  { key: "ABC-14", summary: "Measure the lock wait", category: "new" as const },
];
const NEW = { key: "ABC-17", summary: "Add the lock probe", category: "new" as const };

type Call = { argv: string[]; stdin: string; context: Record<string, string>; attachments: string[] };

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const part = (n: number, o: Record<string, unknown>) => ({ ...echoSpec().parts[0], n, title: `Part ${n}`, ...o });

// A task ABC-10 whose open sub-tasks ABC-12 to ABC-14 each have an open PR outside the app. The approval tracks the three PRs, so the
// task is ready and no part builds. askAttachments off: a new sub-task gets every file that can go to runs.
async function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-st7-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  const fixture = claudeStream(root, "st7", "claude/b6-hostile-repo.jsonl");
  runner.write({ fixture, interview: NO_QUESTIONS, spec: echoSpec() });
  const fake = startFakeBitbucket();
  const w = repoWrites(fake, "PROJ", "repo");
  const jira = startFakeJira();
  jira.addSubtaskSet();
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false, askAttachments: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir: dataDir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const review = createReviewJobs({
    settings,
    live,
    dataDir,
    runnerCommand: runner.command,
    repoRemote: async () => ({ url: r.remote, config: [] }),
    listTools: stubListTools,
    claudeConfigDir: join(root, "no-claude-config"),
  });
  const db = review.open() as Database;
  const app = createApp({ port: PORT, token: SESSION, live, settings, review });
  cleanup.unshift(async () => {
    await review.stop();
    fake.stop();
    jira.stop();
    db.close();
  });
  const json = async <T>(path: string, init: { body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.body === undefined ? "GET" : "POST",
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const put = await app.request(`${ORIGIN}/api/settings/jira`, {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ baseUrl: jira.url, token: JIRA_TOKEN }),
  });
  expect(put.status).toBe(200);
  const get = async (id: number) => (await json<TaskDto>(`/api/tasks/${id}`)).body;
  const settle = async (id: number) => {
    for (;;) {
      await review.wait();
      if (!review.busy()) return get(id);
    }
  };
  for (const k of ["ABC-12", "ABC-13", "ABC-14"]) {
    const res = await fetch(`${fake.url}${w.path}/pull-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title: `${k}: done outside`, fromRef: { id: `refs/heads/feature/${k}-x` }, toRef: { id: "refs/heads/main" } }),
    });
    expect(res.status).toBe(201);
  }
  const c = await json<TaskDto>("/api/tasks", { body: { project: "PROJ", repo: "repo", key: SUBTASK_PARENT } });
  const t = await settle(c.body.id);
  const ok = await json<TaskDto>(`/api/tasks/${t.id}/plan`, { body: { version: t.version, size: "small", commands: [], warning: true } });
  expect([ok.status, ok.body.state]).toEqual([200, "ready"]);
  // The status read of the sync on a fake clock, so each read runs.
  const clock = { t: 1_000_000 };
  const tasks = createTaskService({ review, settings, live, now: () => clock.t });
  const sync = async () => {
    clock.t += JIRA_STATUS_AGE_MS;
    return tasks.syncStatuses(db);
  };
  const calls = () => readRecords<Call>(join(root, "calls.jsonl")).filter((x) => Array.isArray(x.argv) && x.argv.includes("-p"));
  // The requests that change a fake server: every method but GET.
  const writes = () => [...fake.requests, ...jira.requests].filter((x) => !x.startsWith("GET ")).length;
  const fixed = () => db.query("SELECT * FROM task_part WHERE task = $id ORDER BY id").all({ id: t.id });
  return { db, jira, runner, fixture, json, get, settle, sync, calls, writes, fixed, id: t.id };
}

test(
  "AC-B87: a new key adds a part only after the approval of the changed plan; no fixed part changes; the sync never writes to Jira",
  async () => {
    const h = await setup();
    const before = h.fixed();
    expect(before).toHaveLength(3);
    const writes = h.writes();

    // A colleague adds ABC-17 with a log file. The status read of the sync marks it new and writes nothing.
    h.jira.addSubtasks(SUBTASK_PARENT, [...SET, NEW], [["ABC-13", "ABC-12"]]);
    h.jira.attach("ABC-17", { id: "9017", filename: "probe.log", mimeType: "text/plain", body: logOf(64) });
    expect(await h.sync()).toEqual([h.id]);
    expect(h.writes()).toBe(writes);
    let t = await h.get(h.id);
    expect(t.subtasks?.find((s) => s.key === "ABC-17")).toMatchObject({ summary: NEW.summary, added: expect.any(Number), removed: null });
    expect(t.parts).toHaveLength(3);
    // A second read changes nothing.
    expect(await h.sync()).toEqual([]);

    // "Add to plan": the run plans ABC-17 on top of the tracked PR of ABC-13, and it also names ABC-14, which has a part already.
    const spec = {
      ...echoSpec(),
      parts: [
        part(1, {
          keys: ["ABC-17"],
          start: "stack",
          after: "ABC-13",
          startReason: "It reads the flush of ABC-13.",
          title: "Add the probe",
        }),
        part(2, { keys: ["ABC-14"], title: "Measure again" }),
      ],
    };
    h.runner.write({ fixture: h.fixture, interview: NO_QUESTIONS, spec });
    const again = (body: Record<string, unknown>) => h.json<TaskDto & ApiError>(`/api/tasks/${h.id}/plan-again`, { body });
    expect((await again({ version: t.version - 1, text: "Add ABC-17 to the plan.", add: true })).status).toBe(409);
    const runs = h.calls().length;
    const r = await again({ version: t.version, text: "Add ABC-17 to the plan.", add: true });
    expect(r.status).toBe(202);
    t = await h.settle(h.id);
    expect(h.calls().length).toBe(runs + 1);
    const call = h.calls().at(-1);
    expect(call?.stdin).toContain("These sub-tasks are new in Jira: ABC-17.");
    expect(call?.attachments).toContain("ABC-17");
    expect(call?.context["subtasks.md"]).toContain("probe.log: 64 bytes, text/plain. Included as ./attachments/ABC-17/9017.txt.");
    expect(t.files.find((f) => f.id === "9017")?.issue).toBe("ABC-17");
    expect(t.state).toBe("ready");
    expect(t.plan?.adding).toBe(true);
    expect(t.plan?.starts.map((s) => [s.n, s.keys, s.start, s.after, s.skip])).toEqual([
      [4, ["ABC-17"], "stack", "ABC-13", false],
      [5, [], "base", null, true],
    ]);
    // No part before the approval, and the parts of the approved plan stay as they are.
    expect(h.fixed()).toEqual(before);
    expect(h.writes()).toBe(writes);

    // The approval refuses a start for a part of the approved plan with 409, and nothing changes.
    const approve = (parts: unknown[]) =>
      h.json<TaskDto & ApiError>(`/api/tasks/${h.id}/plan`, {
        body: { version: t.version, size: "small", commands: [], subtasks: { parts, track: [], maxOpen: 3 } },
      });
    const refused = await approve([{ n: 2, start: "stack", after: "4" }]);
    expect([refused.status, refused.body.error]).toEqual([409, "ABC-13 stays as it is. The changed plan only adds new sub-tasks."]);
    expect(h.fixed()).toEqual(before);
    expect((await h.get(h.id)).plan?.adding).toBe(true);

    const ok = await approve([]);
    expect(ok.status).toBe(200);
    expect(h.writes()).toBe(writes);
    const done = ok.body;
    expect(done.state).toBe("implementing");
    expect(done.plan?.adding).toBe(false);
    expect(h.fixed().slice(0, 3)).toEqual(before);
    const added = done.parts.find((p) => p.keys[0] === "ABC-17");
    const lower = done.parts.find((p) => p.keys[0] === "ABC-13");
    expect([added?.ord, added?.state, added?.start, added?.after, added?.baseBranch, added?.adopted, added?.specDir]).toEqual([
      4,
      "planned",
      "stack",
      lower?.id,
      lower?.branch,
      false,
      "specs/ABC-17/",
    ]);
    expect(done.parts).toHaveLength(4);
    expect(done.subtasks?.find((s) => s.key === "ABC-17")?.parts).toEqual([added?.id ?? -1]);
    // A second approval finds no changed plan.
    const twice = await h.json<ApiError>(`/api/tasks/${h.id}/plan`, {
      body: { version: done.version, size: "small", commands: [], subtasks: { parts: [], track: [], maxOpen: 3 } },
    });
    expect([twice.status, twice.body.error]).toEqual([409, "No changed plan waits for the approval."]);
  },
  SLOW,
);

test(
  "a key that Jira no longer lists gets removed_at; Drop abandons its planned part; a listed key again clears it",
  async () => {
    const h = await setup();
    h.jira.addSubtasks(SUBTASK_PARENT, [...SET, NEW], [["ABC-13", "ABC-12"]]);
    await h.sync();
    let t = await h.get(h.id);
    h.runner.write({ fixture: h.fixture, interview: NO_QUESTIONS, spec: { ...echoSpec(), parts: [part(1, { keys: ["ABC-17"] })] } });
    expect((await h.json(`/api/tasks/${h.id}/plan-again`, { body: { version: t.version, text: "Add.", add: true } })).status).toBe(202);
    t = await h.settle(h.id);
    const approved = await h.json<TaskDto>(`/api/tasks/${h.id}/plan`, {
      body: { version: t.version, size: "small", commands: [], subtasks: { parts: [], track: [], maxOpen: 3 } },
    });
    expect(approved.status).toBe(200);

    // The colleague removes ABC-17 and ABC-14 in Jira.
    h.jira.addSubtasks(SUBTASK_PARENT, SET.slice(0, 3), [["ABC-13", "ABC-12"]]);
    const writes = h.writes();
    expect(await h.sync()).toEqual([h.id]);
    expect(h.writes()).toBe(writes);
    t = await h.get(h.id);
    expect(t.subtasks?.filter((s) => s.removed !== null).map((s) => s.key)).toEqual(["ABC-14", "ABC-17"]);
    // An open PR stays open: its part cannot be dropped.
    const open = t.parts.find((p) => p.keys[0] === "ABC-14");
    const busy = await h.json<ApiError>(`/api/tasks/${h.id}/parts/${open?.id}/drop`, { body: { version: t.version } });
    expect(busy.status).toBe(409);
    const planned = t.parts.find((p) => p.keys[0] === "ABC-17");
    expect(planned?.state).toBe("planned");
    const drop = await h.json<TaskDto>(`/api/tasks/${h.id}/parts/${planned?.id}/drop`, { body: { version: t.version } });
    expect(drop.status).toBe(200);
    expect(drop.body.parts.find((p) => p.id === planned?.id)?.state).toBe("abandoned");
    expect(h.writes()).toBe(writes);

    // ABC-14 comes back in Jira.
    h.jira.addSubtasks(SUBTASK_PARENT, SET, [["ABC-13", "ABC-12"]]);
    await h.sync();
    expect((await h.get(h.id)).subtasks?.filter((s) => s.removed !== null).map((s) => s.key)).toEqual(["ABC-17"]);
  },
  SLOW,
);
