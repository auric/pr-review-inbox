// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/design.md Q24 and tasks.md WP-B0: a review_run row with task set and pr NULL never shows in a PR view, a run
// list, Ready to post, the stats, or a PR action. Each read runs once before the task rows exist and once after: the result stays the
// same. The task rows copy the kinds and the item shapes of the PR rows, so each kind filter meets a task row too.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { openDrafts, staleKeys } from "../../src/server/inbox/stale";
import { createLive } from "../../src/server/live";
import { buildPlan } from "../../src/server/publish/plan";
import { planInput } from "../../src/server/publish/routes";
import { consultData, undoImport } from "../../src/server/review/consult";
import { askConversation, fixStateFile, historyFile } from "../../src/server/review/context-files";
import { discussTurns, findingItem } from "../../src/server/review/discuss";
import { currentDrafts, placeReplies, revisions } from "../../src/server/review/drafts";
import { prFixes } from "../../src/server/review/fix-routes";
import { threadHistory } from "../../src/server/review/history";
import { triage } from "../../src/server/review/items";
import { createReviewJobs, type ReviewJobs } from "../../src/server/review/jobs";
import { type ItemRow, SQL as RUN_SQL } from "../../src/server/review/run-rows";
import { reviewStats } from "../../src/server/review/stats";
import { createSecrets } from "../../src/server/secrets";
import { createSettings, type Settings } from "../../src/server/settings";
import type { ConsultData } from "../../src/shared/consult";
import { FAKE_TOKEN, FAKE_USER } from "../support/fake-bitbucket";

process.env.REVIEW_LOOP_SECRETS = "memory";
for (const m of ["review/jobs", "review/run-rows", "review/stats", "inbox/stale", "review/items", "review/discuss", "publish/routes"])
  console.log(`task-rows.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const S = "a".repeat(40);
const T = "b".repeat(40);
const NOW = Date.now();
const AT = NOW - 60_000;
const ROLLBACK = new Error("rollback");
const SUMMARY = JSON.stringify({
  summary: "s",
  risks: [],
  coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
  dropped: [],
});

let dir = "";
let db: Database;
let settings: Settings;
let review: ReviewJobs;
let app: ReturnType<typeof createApp>;
let pr = 0;
// The PR rows.
const P: Record<"review" | "ask" | "explain" | "fix" | "f1" | "f2" | "q1" | "d1" | "d3", number> = {} as never;
// The task rows.
const K: Record<"task" | "interview" | "spec" | "implement" | "review" | "ask" | "explain" | "fix" | "tf" | "tq" | "td" | "td2", number> =
  {} as never;
let before: Awaited<ReturnType<typeof reads>>;

const id = (sql: string, params: Record<string, string | number | null>) => (db.query(sql).get(params) as { id: number }).id;

function run(o: { pr: number | null; task?: number | null; kind: string; status?: string; key: string } & Record<string, unknown>) {
  return id(
    `INSERT INTO review_run (pr, task, kind, profile, profile_name, explain, note, idem_key, source_head, target_head, merge_base, status,
      started_at, finished_at, summary_json, question, answer, fix_json, explain_json)
    VALUES ($pr, $task, $kind, 'general', 'General', 0, '', $key, $s, $t, 'm', $status, $at, $at, $summary, $question, $answer, $fix, $explain)
    RETURNING id`,
    {
      pr: o.pr,
      task: o.task ?? null,
      kind: o.kind,
      key: o.key,
      s: S,
      t: T,
      status: o.status ?? "completed",
      at: AT,
      summary: (o.summary as string | undefined) ?? null,
      question: (o.question as string | undefined) ?? null,
      answer: (o.answer as string | undefined) ?? null,
      fix: (o.fix as string | undefined) ?? null,
      explain: (o.explain as string | undefined) ?? null,
    },
  );
}

function finding(runId: number, status: string, line: number) {
  const payload = {
    path: "src/app.ts",
    side: "new",
    line,
    lineEnd: null,
    anchorText: "x",
    severity: "major",
    category: "Correctness",
    body: `Finding at ${line}.`,
    evidence: "",
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
    anchor: { state: "exact", path: "src/app.ts", oldPath: null, line, lineEnd: line, excerpt: [] },
  };
  return id(
    `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, anchor_state, excerpt_json, status)
    VALUES ($run, 'finding', $payload, $body, 'src/app.ts', 'new', $line, $line, 'exact', '[]', $status) RETURNING id`,
    { run: runId, payload: JSON.stringify(payload), body: payload.body, line, status },
  );
}

function question(runId: number) {
  return id(
    `INSERT INTO review_item (run, kind, payload_json, body, status) VALUES ($run, 'question', '{"text":"Why?","why":"W."}', 'Why?', 'accepted')
    RETURNING id`,
    { run: runId },
  );
}

function reply(runId: number, thread: number, status: string, extra: Record<string, unknown> = {}) {
  const payload = {
    thread,
    action: "reply",
    body: "Reply.",
    reason: "R.",
    evidenceStatus: "code",
    judgement: "valid",
    replyTo: thread,
    resolve: false,
    resolveEvidence: "",
    threadOpen: true,
    ...extra,
  };
  return id(
    `INSERT INTO review_item (run, kind, payload_json, body, status, thread, edited) VALUES ($run, 'reply', $payload, 'Reply.', $status, $thread, 0)
    RETURNING id`,
    { run: runId, payload: JSON.stringify(payload), status, thread },
  );
}

const rollback = <R>(f: () => R): R => {
  let out: R | undefined;
  try {
    db.transaction(() => {
      out = f();
      throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out as R;
};

// The same for a route call. The handler awaits, so a db.transaction() callback ends before it writes. A route transaction nests.
async function undone<R>(f: () => Promise<R>): Promise<R> {
  db.exec("SAVEPOINT task_rows");
  try {
    return await f();
  } finally {
    db.exec("ROLLBACK TO task_rows");
    db.exec("RELEASE task_rows");
  }
}

const call = (method: string, path: string, body?: unknown) =>
  app.request(`${ORIGIN}/api${path}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });

const prRow = () =>
  db.query("SELECT id, project, repo, pr_id FROM pull_request WHERE id = $pr").get({ pr }) as {
    id: number;
    project: string;
    repo: string;
    pr_id: number;
  };

// Every PR read of the audit, keyed by the file that holds its SQL.
async function reads() {
  const plan = planInput(review, settings, pr);
  return {
    jobs: {
      runsPr: review.runs(db, pr, 20),
      runsAll: review.runs(db, null, 50),
      run: review.run(db, P.review),
      asks: review.asks(db, pr),
      explanation: review.explanation(db, pr),
      fixes: review.fixes(db, pr),
      replyDrafts: review.replyDrafts(db, pr),
    },
    runRows: Object.fromEntries(
      (["baseRun", "fixes", "asks", "explainNewest", "historyAsks"] as const).map((k) => [
        k,
        db.query(`${RUN_SQL.run} ${RUN_SQL[k]}`).all({ pr }),
      ]),
    ),
    runRowsMore: {
      explainDone: db.query(`${RUN_SQL.run} ${RUN_SQL.explainDone}`).all({ pr, key: null }),
      items: db.query(RUN_SQL.items).all({ run: P.review }),
      posted: db.query(RUN_SQL.posted).all({ pr, limit: 50 }),
      chain: db.query(RUN_SQL.chain).all({ run: P.ask }),
      sessionAnswer: db.query(RUN_SQL.sessionAnswer).all({ run: P.ask, pr }),
    },
    stale: { all: [...openDrafts(db, null)], one: [...openDrafts(db, pr)], keys: [...staleKeys(db, pr, FAKE_USER)] },
    routes: plan,
    outbox: plan && buildPlan(plan).map((p) => ({ run: p.run, items: p.items })),
    consult: await consultData({ db, me: FAKE_USER, review }, pr, false),
    contextFiles: {
      history: historyFile(db, pr, S),
      historyReview: historyFile(db, pr, S, true),
      fixState: fixStateFile(db, pr, [100, 200]),
      ask: askConversation(db, P.ask, S, new Set()),
    },
    drafts: { current: [...currentDrafts(db, pr)], revisions: [...revisions(db, pr)] },
    fixRoutes: prFixes(db, dir, prRow()),
    history: [threadHistory(db, pr, 100), threadHistory(db, pr, 200)],
    stats: reviewStats(db, 30, NOW),
    discuss: discussTurns(db, P.f1),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rl-task-rows-"));
  writeConfig(dir, { baseUrl: "http://127.0.0.1:9", userSlug: FAKE_USER, notifications: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  settings = createSettings({ dir, secrets });
  db = settings.db() as Database;
  const live = createLive();
  // A runner command that never runs: every start in this file is refused before the launch.
  review = createReviewJobs({ settings, live, dataDir: dir, runnerCommand: [process.execPath, "--version"] });
  app = createApp({ port: PORT, token: SESSION, live, settings, review });

  pr = id(
    `INSERT INTO pull_request (project, repo, pr_id, title, author_slug, author_name, my_role, state, source_head, target_head, source_branch,
      target_branch, updated_date) VALUES ('PROJ', 'repo', 2, 'Title', $me, 'Me', 'AUTHOR', 'OPEN', $s, $t, 'feature', 'main', 1000) RETURNING id`,
    { me: FAKE_USER, s: S, t: T },
  );
  for (const thread of [100, 200])
    db.query(
      `INSERT INTO comment (pr, comment_id, version, root_id, author_slug, author_name, text, thread_resolved, created_at, updated_at)
      VALUES ($pr, $thread, 0, $thread, 'asmith', 'Alex Smith', 'Please change it.', 0, $thread, $thread)`,
    ).run({ pr, thread });

  P.review = run({ pr, kind: "review", key: "p-review", summary: SUMMARY });
  P.f1 = finding(P.review, "accepted", 3);
  P.f2 = finding(P.review, "new", 5);
  P.q1 = question(P.review);
  P.d1 = reply(P.review, 100, "new");
  P.d3 = reply(P.review, 200, "discarded");
  P.ask = run({ pr, kind: "ask", key: "p-ask", question: "Q?", answer: "A." });
  P.explain = run({ pr, kind: "explain", key: "p-explain", explain: "{}" });
  P.fix = run({
    pr,
    kind: "fix",
    key: "p-fix",
    summary: SUMMARY,
    fix: JSON.stringify([{ thread: 100, fixed: false, reason: "No.", why: "decision" }]),
  });

  before = await reads();

  // The task rows: newer IDs than every PR row.
  K.task = id(
    `INSERT INTO task (project, repo, key, title, state, size, target_branch, spec_dir, version, created_at, updated_at)
    VALUES ('PROJ', 'repo', 'ABC-1', 'Task', 'implementing', 'small', 'main', 'specs/ABC-1/', 4, 1, 1) RETURNING id`,
    {},
  );
  const task = K.task;
  K.interview = run({ pr: null, task, kind: "interview", key: "t-interview" });
  K.spec = run({ pr: null, task, kind: "spec", key: "t-spec" });
  K.implement = run({ pr: null, task, kind: "implement", key: "t-implement" });
  K.review = run({ pr: null, task, kind: "review", key: "t-review", summary: SUMMARY });
  K.tf = finding(K.review, "accepted", 3);
  K.tq = question(K.review);
  K.td = reply(K.review, 100, "accepted");
  K.td2 = reply(K.review, 200, "new");
  reply(K.review, 100, "discarded", { revises: P.d1 });
  K.ask = run({ pr: null, task, kind: "ask", key: "t-ask", question: "Q?", answer: "Task answer." });
  K.explain = run({ pr: null, task, kind: "explain", key: "t-explain", explain: "{}" });
  K.fix = run({
    pr: null,
    task,
    kind: "fix",
    key: "t-fix",
    summary: SUMMARY,
    fix: JSON.stringify([{ thread: 100, fixed: false, reason: "No.", why: "decision" }]),
  });
});

afterAll(async () => {
  await review.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe("a task run row is in no PR read", () => {
  test("the fixture holds task runs of every kind with items", () => {
    expect(db.query("SELECT kind FROM review_run WHERE pr IS NULL ORDER BY id").all()).toEqual(
      ["interview", "spec", "implement", "review", "ask", "explain", "fix"].map((kind) => ({ kind })),
    );
    expect(
      (db.query("SELECT COUNT(*) AS n FROM review_item i JOIN review_run r ON r.id = i.run WHERE r.pr IS NULL").get() as { n: number }).n,
    ).toBe(5);
  });

  test("review/run-rows.ts: SQL.run with each PR filter, items, posted, chain, and sessionAnswer", async () => {
    const after = await reads();
    expect(after.runRows).toEqual(before.runRows);
    expect(after.runRowsMore).toEqual(before.runRowsMore);
    // By ID: raw follows the run routes, and askParent and fixFinding give pr NULL, which every caller refuses (review/jobs.ts test).
    expect(db.query(RUN_SQL.raw).get({ id: K.implement })).toBeNull();
    expect(db.query(RUN_SQL.askParent).get({ id: K.ask })).toMatchObject({ pr: null });
    expect(db.query(RUN_SQL.fixFinding).get({ id: K.tf })).toMatchObject({ run_pr: null });
    expect(db.query(RUN_SQL.followUp).get({ id: K.ask })).toBeNull();
  });

  test("review/jobs.ts: the run lists count only PR runs, and every PR action refuses a task run or its items", async () => {
    const after = await reads();
    expect(after.jobs).toEqual(before.jobs);
    // The limit counts listed runs only: four newer task runs must not push the PR runs out.
    expect(review.runs(db, null, 4).map((r) => r.id)).toEqual([P.fix, P.explain, P.ask, P.review]);
    expect(review.runs(db, pr, 4).map((r) => r.id)).toEqual([P.fix, P.explain, P.ask, P.review]);
    expect(review.run(db, K.review)).toBeNull();
    expect(review.raw(db, K.implement)).toBeNull();
    expect(review.cancel(db, K.implement)).toBeNull();
    expect((await call("GET", `/runs/${K.review}`)).status).toBe(404);
    expect(review.ask(db, pr, "More?", undefined, K.ask)).toEqual({ status: 400, error: "This answer belongs to another conversation." });
    expect(review.discuss(db, K.tf, "Why?", 0)).toEqual({ status: 404, error: "Item not found." });
    expect(review.turns(db, K.tf)).toBeNull();
    expect(review.fix(db, pr, { findings: [K.tf] })).toEqual({
      status: 400,
      error: `Finding ${K.tf} is not a finding of this pull request.`,
    });
  });

  // part-session.md section 9.5: a restart keeps a task in implementing, and the open step gets the reason error/restart.
  test("review/jobs.ts: the restart recovery ends a running task run with kind restart, and its task keeps implementing with error/restart", () => {
    const got = rollback(() => {
      const running = run({ pr: null, task: K.task, kind: "implement", status: "running", key: "t-running" });
      const prRun = run({ pr, kind: "review", status: "running", key: "p-running" });
      const step = id(
        "INSERT INTO task_step (task, ord, kind, run, state, started_at) VALUES ($task, 1, 'implement', $run, 'running', 1) RETURNING id",
        { task: K.task, run: running },
      );
      const fresh = createReviewJobs({ settings, live: createLive(), dataDir: dir, runnerCommand: [process.execPath, "--version"] });
      fresh.open();
      const status = (r: number) => db.query("SELECT status, error_kind FROM review_run WHERE id = $r").get({ r });
      const t = db.query("SELECT state, stopped_from, version, blocked_json FROM task WHERE id = $id").get({ id: K.task }) as {
        state: string;
        stopped_from: string | null;
        version: number;
        blocked_json: string | null;
      };
      return {
        task: { ...t, blocked_json: t.blocked_json === null ? null : JSON.parse(t.blocked_json) },
        stepId: step,
        step: db.query("SELECT state FROM task_step WHERE run = $run").get({ run: running }),
        taskRun: status(running),
        prRun: status(prRun),
      };
    });
    expect(got).toEqual({
      task: {
        state: "implementing",
        stopped_from: null,
        version: 5,
        blocked_json: {
          kind: "error",
          cause: "restart",
          step: got.stepId,
          text: "Needs you: the app stopped during the work on the task. Continue goes on from there.",
        },
      },
      stepId: got.stepId,
      step: { state: "failed" },
      taskRun: { status: "failed", error_kind: "restart" },
      prRun: { status: "failed", error_kind: "restart" },
    });
  });

  test("review/stats.ts: the self-review of a task counts in no stats row", async () => {
    const after = await reads();
    expect(after.stats).toEqual(before.stats);
    expect(after.stats.map((s) => s.runs)).toEqual([1]);
  });

  test("inbox/stale.ts: open drafts and stale keys of one PR and of every PR", async () => {
    const after = await reads();
    expect(after.stale).toEqual(before.stale);
    expect(after.stale.all.map(([k]) => k)).toEqual([pr]);
  });

  test("publish/routes.ts: Ready to post holds PR runs and PR items only", async () => {
    const after = await reads();
    expect(after.routes).toEqual(before.routes);
    expect(after.routes?.runs.map((r) => r.id)).toEqual([P.review]);
  });

  test("publish/outbox.ts: the planned posts that enqueue stores and headCheck reads name PR runs only", async () => {
    const after = await reads();
    expect(after.outbox).toEqual(before.outbox);
    expect(new Set(after.outbox?.map((p) => p.run))).toEqual(new Set([P.review]));
  });

  test("review/consult.ts: the consult text, an import, and its undo leave the task items alone", async () => {
    const after = await reads();
    expect(after.consult).toEqual(before.consult);
    const data = after.consult as ConsultData;
    const key = (it: string) => data.items.find((x) => x.id === it)?.key as string;
    const entries = [
      { id: "T100", verdict: "accept", reason: "Right.", reply: "Done." },
      { id: `F${P.f1}`, verdict: "reject", reason: "No." },
      { id: `F${P.f2}`, verdict: "question", reason: "Maybe." },
    ];
    const snapshot = Object.fromEntries(entries.map((e) => [e.id, key(e.id)]));
    const taskItems = () =>
      db
        .query("SELECT id, status, payload_json FROM review_item WHERE id IN ($tf, $tq, $td) ORDER BY id")
        .all({ tf: K.tf, tq: K.tq, td: K.td });
    const status = (i: number) => (db.query("SELECT status FROM review_item WHERE id = $i").get({ i }) as { status: string }).status;
    const untouched = taskItems();
    await undone(async () => {
      const session = run({ pr, kind: "session", key: "p-session", answer: JSON.stringify(entries) });
      db.query("UPDATE review_run SET consult_json = $c WHERE id = $id").run({
        id: session,
        c: JSON.stringify({ session: "s1", title: null, bytes: 1, tokens: 1, snapshot, groups: [], items: 0, textBytes: 0 }),
      });
      const res = await call("POST", `/prs/${pr}/consult/import`, { session });
      expect(res.status).toBe(200);
      expect([status(P.d1), status(P.f1)]).toEqual(["discarded", "discarded"]);
      expect(taskItems()).toEqual(untouched);
      const consultRun = (db.query("SELECT MAX(id) AS id FROM review_run WHERE kind = 'consult'").get() as { id: number }).id;
      expect(undoImport(db, pr, K.review)).toEqual({ status: 404, error: "Import not found." });
      expect(undoImport(db, pr, consultRun).status).toBe(200);
      expect([status(P.d1), status(P.f1), status(P.f2)]).toEqual(["new", "accepted", "new"]);
      expect(taskItems()).toEqual(untouched);
    });
  });

  test("review/context-files.ts: history.md, fix-state.md, and the ask conversation", async () => {
    expect((await reads()).contextFiles).toEqual(before.contextFiles);
  });

  test("review/drafts.ts: current drafts, revisions, and the supersede of a new draft", async () => {
    expect((await reads()).drafts).toEqual(before.drafts);
    const statuses = rollback(() => {
      placeReplies(db, pr, [{ ...(db.query("SELECT * FROM review_item WHERE id = $id").get({ id: P.d1 }) as ItemRow), status: "new" }], {
        kept: new Set(),
        revised: new Map(),
      });
      return db
        .query("SELECT id, status, json_extract(payload_json, '$.dropped') AS dropped FROM review_item WHERE thread = 100 ORDER BY id")
        .all();
    });
    // The PR draft goes. The task reply and the task revision stay as they were.
    expect(statuses).toEqual([
      { id: P.d1, status: "discarded", dropped: null },
      { id: K.td, status: "accepted", dropped: null },
      { id: K.td + 2, status: "discarded", dropped: null },
    ]);
  });

  test("review/fix-routes.ts: the fix list, and a decline of a task fix run or a task finding", async () => {
    expect((await reads()).fixRoutes).toEqual(before.fixRoutes);
    expect((await call("POST", "/fix-declines", { run: K.fix, thread: 100, reason: "No." })).status).toBe(404);
    // A PR fix run that names a task finding: the finding is not of this PR.
    await undone(async () => {
      db.query("UPDATE review_run SET fix_json = $f WHERE id = $id").run({
        id: P.fix,
        f: JSON.stringify([{ finding: K.tf, fixed: false, reason: "No.", why: "decision" }]),
      });
      const res = await call("POST", "/fix-declines", { run: P.fix, finding: K.tf, reason: "No." });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Finding not found." });
    });
    // The decline of a PR thread discards the open PR draft of the thread, never the task reply.
    await undone(async () => {
      expect((await call("POST", "/fix-declines", { run: P.fix, thread: 100, reason: "No." })).status).toBe(204);
      const status = (i: number) => db.query("SELECT status FROM review_item WHERE id = $i").get({ i });
      expect([status(P.d1), status(K.td)]).toEqual([{ status: "discarded" }, { status: "accepted" }]);
    });
  });

  test("review/history.ts: the thread history", async () => {
    expect((await reads()).history).toEqual(before.history);
  });

  test("review/items.ts: an item action refuses a task item, and a task draft never blocks a PR draft", async () => {
    expect(triage(db, K.tf, { action: "accept", revision: 0 })).toEqual({ status: 404 });
    expect((await call("POST", `/items/${K.td}`, { action: "discard", revision: 0 })).status).toBe(404);
    // The PR draft of thread 200 opens again: the open task reply of the same thread is no other open draft of this PR.
    const r = rollback(() => triage(db, P.d3, { action: "restore", revision: 0 }));
    expect(r.status).toBe(200);
  });

  test("review/discuss.ts: the talk of a PR finding, and none for a task finding", async () => {
    expect((await reads()).discuss).toEqual(before.discuss);
    expect(findingItem(db, K.tf)).toBeNull();
    expect(findingItem(db, P.f1)).toMatchObject({ id: P.f1, pr });
  });
});
