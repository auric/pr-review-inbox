// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.26: several Claude runs at once, with the fake CLI, a temp git remote, and a fake Bitbucket.
// No test starts the real CLI or reaches a forge.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { RunConflict, RunDetail, RunDto, RunSlotsDto } from "../../src/shared/dto";
import type { RunLimits } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, key, startFakeBitbucket } from "../support/fake-bitbucket";
import { readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, reviewRemote, stubListTools } from "../support/review-fixture";
import { DASHBOARD_PATH } from "../support/scenarios";

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const ON_PR = "A run is working on this pull request. Start yours when it ends.";

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Call = { argv?: string[]; pid?: number; childPid?: number };
type Start = RunDto & RunConflict;

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await pred()) && Date.now() < end) await Bun.sleep(25);
  return pred();
}

// Four PRs of one repository. Each run of the fake CLI hangs until a cancel.
async function setup(runLimits?: Partial<RunLimits>) {
  const root = mkdtempSync(join(tmpdir(), "rl-slots-"));
  dirs.push(root);
  const remote = await reviewRemote(root, { 2: "source", 3: "source", 4: "source", 5: "source" });
  const runner = fakeRunner(root);
  runner.write({ fixture: claudeStream(root, "b6", "claude-synthetic/review-flat.jsonl"), hang: true });
  // The settings check reads the token owner from the dashboard.
  const fake = startFakeBitbucket({ routes: { [key("GET", DASHBOARD_PATH)]: { status: 200, body: { values: [], isLastPage: true } } } });
  cleanup.push(() => fake.stop());

  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false, ...(runLimits && { runLimits }) });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const live = createLive();
  const review = createReviewJobs({
    settings,
    live,
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: remote.gitRemote,
    listTools: stubListTools,
  });
  const app = createApp({ port: PORT, token: SESSION, live, settings, review });
  cleanup.unshift(async () => {
    await review.stop();
    db.close();
  });
  const prs = [2, 3, 4, 5].map(
    (n) =>
      (
        db
          .query(
            `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head,
              target_head, source_branch, target_branch, updated_date, on_dashboard, followed)
            VALUES ('PROJ', 'repo', $n, 'Lock', '', 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target, 'feature', 'main', 1000,
              1, 1) RETURNING id`,
          )
          .get({ n, source: remote.source, target: remote.target }) as { id: number }
      ).id,
  );

  const json = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const start = (pr: number) => json<Start>(`/api/prs/${pr}/review`, { method: "POST" });
  const status = async (run: number) => (await json<RunDetail>(`/api/runs/${run}`)).body.run.status;
  const slots = async () => (await json<RunSlotsDto>("/api/runs/slots")).body;
  const limit = (runsAtOnce: number) => json("/api/settings", { method: "PUT", body: { baseUrl: fake.url, runLimits: { runsAtOnce } } });
  const calls = () => readRecords<Call>(join(root, "calls.jsonl"));
  // The CLI processes of the runs, by the run calls that reached their hang.
  const processes = () => calls().filter((c) => c.childPid !== undefined).length;
  const runCalls = () => calls().filter((c) => c.argv?.includes("-p"));
  // Starts a run on each PR, one after another, and waits until each CLI process hangs.
  const fill = async (list: number[]) => {
    const runs: number[] = [];
    for (const pr of list) {
      const r = await start(pr);
      expect(r.status).toBe(202);
      runs.push(r.body.id);
    }
    expect(await waitFor(() => processes() === list.length)).toBe(true);
    return runs;
  };
  return { db, prs, review, fake, json, start, status, slots, limit, calls, runCalls, processes, fill };
}

describe("several runs at once (spec.md section 6.26)", () => {
  test(
    "AC-B188, AC-B195: three runs on three PRs run at once, each as its own process; a fourth PR gets 409 with full until one ends",
    async () => {
      const h = await setup();
      const [a, b, c, d] = h.prs as [number, number, number, number];
      const runs = await h.fill([a, b, c]);
      const [ra, rb, rc] = runs as [number, number, number];
      for (const r of runs) expect(await h.status(r)).toBe("running");
      expect(new Set(h.runCalls().map((x) => x.pid)).size).toBe(3);
      // AC-B195: the pool runs, oldest first. The run detail route still works.
      expect(await h.slots()).toEqual({
        limit: 3,
        running: [
          { run: ra, pr: a, kind: "review" },
          { run: rb, pr: b, kind: "review" },
          { run: rc, pr: c, kind: "review" },
        ],
      });
      expect((await h.json(`/api/runs/${ra}`)).status).toBe(200);

      const full = await h.start(d);
      expect(full.status).toBe(409);
      expect(full.body).toEqual({
        error: "Claude runs 3 runs at once, your limit. Start yours when one ends.",
        running: { run: ra, pr: a, kind: "review" },
        full: 3,
      } as never);
      expect(h.review.busy()).toEqual(full.body as RunConflict);

      expect((await h.json(`/api/runs/${rb}/cancel`, { method: "POST" })).status).toBe(202);
      expect(await waitFor(async () => (await h.status(rb)) === "cancelled")).toBe(true);
      const again = await h.start(d);
      expect(again.status).toBe(202);
      expect((await h.slots()).running.map((r) => r.run)).toEqual([ra, rc, again.body.id]);
    },
    SLOW,
  );

  test(
    "AC-B189: another key on a PR with a running run gets 409 without full, also with free slots; the same key gets the running run",
    async () => {
      const h = await setup();
      const [a] = h.prs as [number];
      const [ra] = (await h.fill([a])) as [number];
      const ask = await h.json<Start>(`/api/prs/${a}/ask`, { body: { question: "Why does the lock move?" } });
      expect(ask.status).toBe(409);
      expect(ask.body).toEqual({ error: ON_PR, running: { run: ra, pr: a, kind: "review" } } as never);
      expect(h.review.busy()).toBeNull();
      const same = await h.start(a);
      expect([same.status, same.body.id]).toEqual([200, ra]);
      expect(h.db.query("SELECT COUNT(*) AS n FROM review_run").get()).toEqual({ n: 1 });
    },
    SLOW,
  );

  test(
    "AC-B190: a cancel ends only its run; a connection change and the app stop end every run",
    async () => {
      const h = await setup();
      const [a, b, c] = h.prs as [number, number, number];
      const [ra, rb, rc] = (await h.fill([a, b, c])) as [number, number, number];
      expect((await h.json(`/api/runs/${rb}/cancel`, { method: "POST" })).status).toBe(202);
      expect(await waitFor(async () => (await h.status(rb)) === "cancelled")).toBe(true);
      expect([await h.status(ra), await h.status(rc)]).toEqual(["running", "running"]);

      // A save with a token is a connection change.
      expect((await h.json("/api/settings", { method: "PUT", body: { baseUrl: h.fake.url, token: FAKE_TOKEN } })).status).toBe(200);
      await h.review.wait();
      expect([await h.status(ra), await h.status(rc)]).toEqual(["cancelled", "cancelled"]);
      expect(h.review.idle()).toBe(true);

      const [rd, re] = (await Promise.all([h.start(a), h.start(b)])).map((r) => r.body.id) as [number, number];
      expect(await waitFor(async () => (await h.status(rd)) === "running" && (await h.status(re)) === "running")).toBe(true);
      await h.review.stop();
      expect([await h.status(rd), await h.status(re)]).toEqual(["cancelled", "cancelled"]);
    },
    SLOW,
  );

  test(
    "AC-B191: a lower limit applies at the next start and cancels no run; a higher limit lets the next start go at once",
    async () => {
      const h = await setup();
      const [a, b, c, d] = h.prs as [number, number, number, number];
      const runs = await h.fill([a, b, c]);
      expect((await h.limit(2)).status).toBe(200);
      for (const r of runs) expect(await h.status(r)).toBe("running");
      const low = await h.start(d);
      expect([low.status, low.body.full]).toEqual([409, 2]);
      expect((await h.slots()).limit).toBe(2);
      expect((await h.limit(4)).status).toBe(200);
      expect((await h.start(d)).status).toBe(202);
      expect((await h.slots()).running).toHaveLength(4);
    },
    SLOW,
  );

  test(
    "AC-B197: with the limit 1, a start on another PR gets 409 with full 1 and the running run",
    async () => {
      const h = await setup({ runsAtOnce: 1 });
      const [a, b] = h.prs as [number, number];
      const [ra] = (await h.fill([a])) as [number];
      const other = await h.start(b);
      expect(other.status).toBe(409);
      expect(other.body).toEqual({
        error: "Claude runs 1 run at once, your limit. Start yours when one ends.",
        running: { run: ra, pr: a, kind: "review" },
        full: 1,
      } as never);
      expect(await h.slots()).toEqual({ limit: 1, running: [{ run: ra, pr: a, kind: "review" }] });
    },
    SLOW,
  );
});
