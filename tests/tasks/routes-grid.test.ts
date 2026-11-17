// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/part-session.md section 9.7, route grid (ps5-plan.md section 5, PS5-S2, AC-B382): each mutating task route over
// seeded task states answers 2xx, 400, 404, or 409 with a sentence, never 500. A 409 moves no version, writes no step row, and starts
// no driver. Every fake CLI run hangs, so a driver that a 2xx starts does nothing until the Stop of its cell. The forge URL is a closed
// local port, and Jira has no settings. No test starts the real CLI, reaches a forge, or touches the user's clone or data folder.
import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "../../src/server/app";
import { insertStep, patchStep } from "../../src/server/tasks/implement";
import { TASK_CHANGED } from "../../src/server/tasks/tasks";
import type { TaskDto } from "../../src/shared/dto";
import type { TaskBlocked } from "../../src/shared/task";
import { cleanupAll, setup } from "./loop-fixture";

for (const m of ["tasks/routes", "tasks/loop", "tasks/tasks"])
  console.log(`routes-grid.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);

const SESSION = "s".repeat(64);
const ORIGIN = "http://127.0.0.1:7317";
const HEADERS = { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const SENTENCE = /^[A-Z][^\n]*[.?!]$/;
const GRID_MS = 600_000;

const STATES = [
  "interview",
  "spec_draft",
  "building",
  "running",
  "red",
  "held",
  "question",
  "allow",
  "usage",
  "usage_armed",
  "ready",
  "ready_red",
  "stopped_impl",
  "stopped_ready",
  "done",
] as const;
type State = (typeof STATES)[number];

// pattern: the path under /api/tasks/:id/. body: the valid input. The grid adds the current version unless versioned is false. ":part"
// stands for the part ID, ":step" for the step of the seeded reason, ":question" for its open question, and ":plan" for the stored plan.
type Route = { name: string; method: "POST" | "PUT"; pattern: string; body?: Record<string, unknown>; versioned?: false };
const ROUTES: Route[] = [
  { name: "answers", method: "POST", pattern: "answers", body: { answers: [] } },
  { name: "answer", method: "POST", pattern: "answers", body: { answers: [{ question: ":question", text: "Use fast." }] } },
  { name: "allow", method: "POST", pattern: "allow", body: { step: ":step", decisions: [{ pattern: "make build", choice: "once" }] } },
  { name: "docs", method: "PUT", pattern: "docs", body: { doc: "plan", text: ":plan" } },
  { name: "plan", method: "POST", pattern: "plan", body: { size: "small", commands: [] } },
  { name: "plan-again", method: "POST", pattern: "plan-again", body: { text: "Ask again." } },
  { name: "stop", method: "POST", pattern: "stop", body: {} },
  { name: "resume", method: "POST", pattern: "resume", body: {} },
  { name: "resume leave", method: "POST", pattern: "resume", body: { option: "leave" } },
  { name: "resume disarm", method: "POST", pattern: "resume", body: { option: "disarm" } },
  { name: "resume without", method: "POST", pattern: "resume", body: { option: "without" } },
  { name: "resume setup", method: "POST", pattern: "resume", body: { option: "setup", part: ":part" } },
  { name: "resume part", method: "POST", pattern: "resume", body: { part: ":part" } },
  { name: "close", method: "POST", pattern: "close", body: {} },
  { name: "limit", method: "POST", pattern: "limit", body: { lineBudget: 50 } },
  { name: "spec-change", method: "POST", pattern: "spec-change/:step", body: { accept: true } },
  { name: "size", method: "POST", pattern: "size", body: { size: "small" } },
  { name: "pr", method: "POST", pattern: "parts/:part/pr", body: { reviewers: [] } },
  { name: "prs", method: "POST", pattern: "parts/:part/prs", body: { rows: [{ taskRepo: 1, reviewers: [] }] } },
  { name: "push", method: "POST", pattern: "parts/:part/push", body: {} },
  { name: "move", method: "POST", pattern: "parts/:part/move", body: {} },
  { name: "start", method: "POST", pattern: "parts/:part/start", body: { override: true } },
  { name: "wait-merge", method: "POST", pattern: "parts/:part/wait-merge", body: {} },
  { name: "drop", method: "POST", pattern: "parts/:part/drop", body: {} },
  { name: "hold", method: "POST", pattern: "parts/:part/hold", body: {} },
  { name: "skip", method: "POST", pattern: "parts/:part/skip", body: {} },
  { name: "restart", method: "POST", pattern: "parts/:part/restart", body: {} },
  { name: "jira-check", method: "POST", pattern: "jira-check", versioned: false },
  { name: "jira-read", method: "POST", pattern: "jira-read", body: {} },
  { name: "jira-move", method: "POST", pattern: "jira/:key/transitions", body: { id: "1" }, versioned: false },
  { name: "pointer", method: "POST", pattern: "prs/:taskPr/pointer", body: {} },
  { name: "repo", method: "POST", pattern: "repos/:taskRepo", body: { add: false } },
  { name: "base-check", method: "POST", pattern: "base-check", versioned: false },
  { name: "instructions", method: "POST", pattern: "instructions", body: { text: "Name the flag." } },
  { name: "update", method: "POST", pattern: "parts/:part/update", body: {} },
  { name: "undo", method: "POST", pattern: "parts/:part/update/undo", body: {} },
  { name: "fix", method: "POST", pattern: "parts/:part/fix", body: {} },
  // ps6-ps7-plan.md section 3: no seeded part has a PR of the app, so each state answers 409.
  { name: "comments", method: "POST", pattern: "parts/:part/comments", body: { threads: [101] } },
  { name: "base", method: "PUT", pattern: "base", body: { branch: "main" } },
  { name: "file", method: "PUT", pattern: "files/:att", body: { include: true }, versioned: false },
];

// The cells that do not answer 409. Every other cell answers 409. jira-check and base-check read only, and the fixture lists no
// attachment.
const READS = { "jira-check": 200, "base-check": 200, file: 404 };
const NOT_409: Record<State, Record<string, number>> = {
  interview: { ...READS, stop: 200, base: 200 },
  spec_draft: { ...READS, docs: 200, plan: 200, "plan-again": 202, stop: 200, base: 200 },
  building: { ...READS, stop: 200, resume: 200, "resume setup": 202, limit: 200, restart: 200, pointer: 404 },
  // A driver works: Hold and Stop act on it, and a message goes to its session run (ps4-plan.md WP-7).
  running: { ...READS, stop: 200, hold: 200, instructions: 202 },
  red: { ...READS, stop: 200, resume: 200, limit: 200, restart: 200, instructions: 202 },
  // part-session.md section 9.4: a held part goes on by Continue with part only, so a plain Continue builds nothing and answers 409.
  held: { ...READS, stop: 200, "resume part": 200, limit: 200, restart: 200, pointer: 404 },
  // The form of the reason answers. An empty answer list is a 400 of the loop. Continue gets 409 with the form sentence.
  question: { ...READS, answers: 400, answer: 202, stop: 200, limit: 200, restart: 200 },
  allow: { ...READS, allow: 202, stop: 200, limit: 200, restart: 200 },
  // Continue before resumeAt arms the reason and starts nothing. disarm needs an armed reason.
  usage: { ...READS, stop: 200, resume: 200, limit: 200, restart: 200 },
  usage_armed: { ...READS, stop: 200, resume: 200, "resume disarm": 200, limit: 200, restart: 200 },
  ready: { ...READS, stop: 200, "resume setup": 202, close: 200, limit: 200, instructions: 202, pointer: 404 },
  // part-session.md section 9.4 rule 9: Continue and Leave it work in ready.
  ready_red: { ...READS, stop: 200, resume: 200, "resume leave": 200, close: 200, limit: 200, instructions: 202 },
  stopped_impl: { ...READS, resume: 200, close: 200, restart: 200 },
  stopped_ready: { ...READS, resume: 200, close: 200 },
  done: { ...READS, close: 200 },
};

type S = Awaited<ReturnType<typeof setup>>;
type Answer = { status: number; body: TaskDto & { error?: string; task?: TaskDto } };

async function grid() {
  const s = await setup();
  // Every Claude run hangs. A setup command lets option setup pass its checks.
  s.scenario({ hang: true });
  const commands = JSON.parse(
    (s.db.query("SELECT commands_json FROM repo_task_settings").get() as { commands_json: string }).commands_json,
  ) as unknown[];
  const venv = { id: "s", name: "venv", kind: "setup", argv: [process.execPath, "-e", "0"], timeoutSec: 60 };
  s.db.query("UPDATE repo_task_settings SET commands_json = $c").run({ c: JSON.stringify([venv, ...commands]) });
  const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
  const send = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: HEADERS,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = res.headers.get("content-type")?.includes("json");
    return { status: res.status, body: (json ? await res.json() : {}) as Answer["body"] };
  };
  // TaskDto.working: a driver of the app's own loop works on the task.
  const working = async () => (await send("GET", `/api/tasks/${s.task}`)).body.working;
  const runs = () =>
    (s.db.query("SELECT COUNT(*) AS n FROM review_run WHERE task = $t AND status = 'running'").get({ t: s.task }) as { n: number }).n;
  const busy = async () => (await working()) || runs() > 0;
  // A 2xx can start a driver or a run. Stop ends it, and the next seed puts the state back. Each wait has a bound.
  const quiet = async () => {
    for (let end = Date.now() + 2_000; (await busy()) && Date.now() < end; ) await Bun.sleep(50);
    // A driver can move the version between the read and the Stop, so each try reads it again.
    for (let end = Date.now() + 60_000; await busy(); await Bun.sleep(250)) {
      if (Date.now() > end) throw new Error("The driver of the cell did not end.");
      await send("POST", `/api/tasks/${s.task}/stop`, { version: s.t().version });
    }
  };
  // The seed of a state. running: Continue starts the build driver, and the cell begins when its build run hangs in the fake CLI.
  const enter = async (st: State) => {
    const ids = seed(s, st);
    if (st !== "running") return ids;
    const builds = () => s.runCalls().filter((c) => s.modeOf(c) === "build").length;
    const n = builds();
    expect((await send("POST", `/api/tasks/${s.task}/resume`, { version: s.t().version })).status).toBe(200);
    for (let end = Date.now() + 60_000; builds() === n; await Bun.sleep(50))
      if (Date.now() > end) throw new Error("The build run did not start.");
    return ids;
  };
  return { s, app, send, working, quiet, enter };
}

type Ids = { part: number; step: number; question: number };

// The seeded state of the task and its one part. Each cell seeds again, so no cell sees what an earlier cell did.
function seed(s: S, st: State): Ids {
  const t = s.task;
  s.db.query("DELETE FROM task_question WHERE task = $t").run({ t });
  s.db.query("DELETE FROM task_part WHERE task = $t").run({ t });
  s.db.query("DELETE FROM task_step WHERE task = $t").run({ t });
  const partState: Record<State, string> = {
    interview: "planned",
    spec_draft: "planned",
    building: "implementing",
    running: "implementing",
    red: "implementing",
    held: "implementing",
    question: "implementing",
    allow: "implementing",
    usage: "implementing",
    usage_armed: "implementing",
    ready: "pr_open",
    ready_red: "pr_open",
    stopped_impl: "implementing",
    stopped_ready: "pr_open",
    done: "merged",
  };
  const built = ["pr_open", "merged"].includes(partState[st]);
  const part = (
    s.db
      .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, pushed, created_at, updated_at)
        VALUES ($t, 1, 'single', 'Add the feature', 'feature/K-1-add-the-feature', 'main', $state, $pushed, 1, 1) RETURNING id`)
      .get({ t, state: partState[st], pushed: built ? "abc" : null }) as { id: number }
  ).id;
  // The step row of the reason. The state running gets its driver from enter().
  const row = (kind: "check" | "implement", state: "ok" | "failed") =>
    insertStep(s.db, { task: t, part, kind, item: kind === "check" ? "checks" : "build", state });
  const red = st === "red" || st === "ready_red";
  const step = red
    ? row("check", "failed")
    : st === "usage" || st === "usage_armed"
      ? row("implement", "failed")
      : st === "question" || st === "allow"
        ? row("implement", "ok")
        : 1;
  let question = 1;
  if (st === "question")
    question = (
      s.db
        .query(`INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, step, asked_at)
          VALUES ($t, 'loop', 1, 0, 'Which flag name?', 'Callers use it.', 'text', '[]', $step, 1) RETURNING id`)
        .get({ t, step }) as { id: number }
    ).id;
  if (st === "allow")
    patchStep(s.db, step, {
      allowAsk: { requests: [{ pattern: "make build", command: "make build", reason: "The step runs make build." }], decisions: [] },
    });
  const usage = (armed: boolean): TaskBlocked => ({
    kind: "usage",
    step,
    text: "Needs you: your usage limit is reached.",
    resumeAt: Date.now() + 3_600_000,
    armed,
  });
  const reason: TaskBlocked | null = red
    ? { kind: "red", cause: "checks", step, text: "Needs you: the checks of part 1 stay red after 3 tries." }
    : st === "question"
      ? { kind: "question", cause: "claude", step, text: "Needs you: Claude asks: Which flag name?" }
      : st === "allow"
        ? { kind: "allow", step, text: "Needs you: Claude asks to allow a command." }
        : st === "usage" || st === "usage_armed"
          ? usage(st === "usage_armed")
          : null;
  if (st === "held") {
    const held: TaskBlocked = { kind: "held", step: null, part, text: "Part 1 is on hold. Its work is kept." };
    s.db.query("UPDATE task_part SET blocked_json = $b WHERE id = $id").run({ id: part, b: JSON.stringify(held) });
  }
  const state: Record<State, string> = {
    interview: "interview",
    spec_draft: "spec_draft",
    building: "implementing",
    running: "implementing",
    red: "implementing",
    held: "implementing",
    question: "implementing",
    allow: "implementing",
    usage: "implementing",
    usage_armed: "implementing",
    ready: "ready",
    ready_red: "ready",
    stopped_impl: "stopped",
    stopped_ready: "stopped",
    done: "done",
  };
  const from = st === "stopped_impl" ? "implementing" : st === "stopped_ready" ? "ready" : null;
  s.db
    .query(
      `UPDATE task SET state = $state, stopped_from = $from, blocked_json = $b, closed_at = NULL, settings_json = '{}',
        version = version + 1 WHERE id = $t`,
    )
    .run({ t, state: state[st], from, b: reason && JSON.stringify(reason) });
  return { part, step, question };
}

const fill = (pattern: string, ids: Ids) =>
  pattern
    .replace(":part", String(ids.part))
    .replace(":step", String(ids.step))
    .replace(":taskRepo", "1")
    .replace(":taskPr", "1")
    .replace(":key", "K-1")
    .replace(":att", "1");

function bodyOf(s: S, r: Route, ids: Ids, version: number) {
  if (!r.body) return undefined;
  const plan = (JSON.parse(s.t().docs_json ?? "{}") as { plan?: string }).plan ?? "";
  const body = JSON.parse(
    JSON.stringify(r.body)
      .replaceAll('":part"', String(ids.part))
      .replaceAll('":step"', String(ids.step))
      .replaceAll('":question"', String(ids.question))
      .replaceAll('":plan"', JSON.stringify(plan)),
  ) as Record<string, unknown>;
  return r.versioned === false ? body : { ...body, version };
}

describe("route grid (part-session.md section 9.7)", () => {
  test("the grid lists every mutating task route of the app, and the removed routes answer 404", async () => {
    const { s, app, send } = await grid();
    const mutating = new Set(
      app.routes
        .filter((r) => (r.method === "POST" || r.method === "PUT") && r.path.startsWith("/api/tasks/:id/"))
        .map((r) => `${r.method} ${r.path.slice("/api/tasks/:id/".length)}`),
    );
    expect([...mutating].sort()).toEqual([...new Set(ROUTES.map((r) => `${r.method} ${r.pattern}`))].sort());
    // ps5-plan.md section 5, PS5-S2 (AC-B382): Hold replaced Pause, the option leave replaced Dismiss, and the option setup replaced
    // the setup route.
    const ids = seed(s, "building");
    for (const path of ["pause", "dismiss", `parts/${ids.part}/setup`])
      expect([path, (await send("POST", `/api/tasks/${s.task}/${path}`, { version: s.t().version })).status]).toEqual([path, 404]);
  }, 120_000);

  test("validators: a bad body gives 400, an unknown task 404, and a stale version 409 with the task; none writes or starts a driver", async () => {
    const { s, send, working } = await grid();
    const problems: string[] = [];
    for (const r of ROUTES) {
      const ids = seed(s, "building");
      const at = { version: s.t().version, steps: s.steps().length };
      const path = (task: number) => `/api/tasks/${task}/${fill(r.pattern, ids)}`;
      const body = bodyOf(s, r, ids, at.version);
      if (r.body) {
        const bad = await send(r.method, path(s.task), r.versioned === false ? {} : { ...body, version: "one" });
        if (bad.status !== 400 || !SENTENCE.test(bad.body.error ?? "")) problems.push(`${r.name}: bad body ${bad.status}`);
      }
      const unknown = await send(r.method, path(s.task + 999), body);
      if (unknown.status !== 404 || !SENTENCE.test(unknown.body.error ?? "")) problems.push(`${r.name}: unknown task ${unknown.status}`);
      if (r.versioned !== false) {
        const stale = await send(r.method, path(s.task), { ...body, version: at.version - 1 });
        if (stale.status !== 409 || stale.body.error !== TASK_CHANGED || stale.body.task?.id !== s.task)
          problems.push(`${r.name}: stale version ${stale.status} ${stale.body.error}`);
      }
      if (s.t().version !== at.version || s.steps().length !== at.steps || (await working())) problems.push(`${r.name}: wrote or started`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  for (const st of STATES)
    test(
      `state ${st}: each mutating route answers its status with a sentence; a 409 writes nothing and starts no driver`,
      async () => {
        const { s, send, working, quiet, enter } = await grid();
        const problems: string[] = [];
        let ids: Ids | null = null;
        for (const r of ROUTES) {
          ids ??= await enter(st);
          const before = { version: s.t().version, steps: s.steps().length, calls: s.runCalls().length };
          const a = await send(r.method, `/api/tasks/${s.task}/${fill(r.pattern, ids)}`, bodyOf(s, r, ids, before.version));
          const want = NOT_409[st][r.name] ?? 409;
          if (a.status !== want) problems.push(`${r.name}: ${a.status} ${a.body.error ?? ""}, want ${want}`);
          if (a.status >= 400 && !SENTENCE.test(a.body.error ?? "")) problems.push(`${r.name}: no sentence`);
          if (a.status === 409) {
            const after = { version: s.t().version, steps: s.steps().length, calls: s.runCalls().length };
            if (JSON.stringify(after) !== JSON.stringify(before)) problems.push(`${r.name}: 409 wrote ${JSON.stringify(after)}`);
            // In running, the driver of the state works before the cell and goes on after it.
            if (st !== "running" && (await working())) problems.push(`${r.name}: 409 started a driver`);
          }
          // A refusal left the state as it was, so the driver of running goes on into the next cell.
          if (st !== "running" || a.status < 400) {
            await quiet();
            ids = null;
          }
        }
        await quiet();
        expect(problems).toEqual([]);
      },
      GRID_MS,
    );
});

// part-session.md section 9.3.1: RESUME with stoppedFrom ready goes back to ready. The Task view offers Continue on the stopped row
// (model.ts taskView). loop.resume takes it, so the gap 18 check runs too.
describe("Continue of a task that stopped in ready", () => {
  const partRow = (s: S, id: number) =>
    s.db.query("SELECT state, blocked_json, pushed, head FROM task_part WHERE id = $id").get({ id }) as Record<string, unknown>;

  test("the task goes back to ready with its part as it was, and no driver or run starts", async () => {
    const { s, send, working } = await grid();
    const ids = seed(s, "stopped_ready");
    const before = { part: partRow(s, ids.part), steps: s.steps().length, calls: s.runCalls().length };
    const r = await send("POST", `/api/tasks/${s.task}/resume`, { version: s.t().version });
    expect([r.status, r.body.state, r.body.stoppedFrom, r.body.blocked, r.body.working]).toEqual([200, "ready", null, null, false]);
    expect([partRow(s, ids.part), s.steps().length, s.runCalls().length, await working()]).toEqual([
      before.part,
      before.steps,
      before.calls,
      false,
    ]);
  }, 120_000);

  test("gap 18: a part that merged while the task stopped makes Continue end in done", async () => {
    const { s, send } = await grid();
    const ids = seed(s, "stopped_ready");
    s.db.query("UPDATE task_part SET state = 'merged' WHERE id = $id").run({ id: ids.part });
    const r = await send("POST", `/api/tasks/${s.task}/resume`, { version: s.t().version });
    expect([r.status, r.body.state]).toEqual([200, "done"]);
  }, 120_000);
});
