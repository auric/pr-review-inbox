// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Layer A of the sync (docs/plans/ci-builds.md): the build-status reads, the pr_build row, the build events, and the DTOs. Fake Bitbucket
// only.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { buildOf } from "../../src/server/inbox/builds";
import { listPrs, prDetail } from "../../src/server/inbox/queries";
import { createLive } from "../../src/server/live";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { buildChanged, buildEvents, keptBuilds } from "../../src/server/sync/builds";
import { createSyncEngine } from "../../src/server/sync/engine";
import type { BuildCounts } from "../../src/shared/build";
import type { BuildDto } from "../../src/shared/dto";
import {
  buildStatuses,
  FAKE_TOKEN,
  FAKE_USER,
  type FakeBitbucket,
  type FakeBuild,
  key,
  type Reply,
  startFakeBitbucket,
} from "../support/fake-bitbucket";
import {
  ACTIVITIES_PATH,
  activities,
  DASHBOARD_PATH,
  onePage,
  ownPr,
  PR_PATH,
  type RawPr,
  REVIEW_PR_PATH,
  reviewPr,
} from "../support/scenarios";

process.env.REVIEW_LOOP_SECRETS = "memory";
const root = mkdtempSync(join(tmpdir(), "rl-builds-"));
process.env.REVIEW_LOOP_DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The own PR (pr_id 2, the token owner is the author) and the review PR (pr_id 1001, the token owner is a reviewer).
const OWN = ownPr().fromRef.latestCommit;
const REVIEW = reviewPr().fromRef.latestCommit;
const NEXT = "c".repeat(40);
const STATS = "/rest/build-status/1.0/commits/stats/";
const LIST = "/rest/build-status/latest/commits/";
const URL_A = "https://ci.example.invalid/view/x/job/a/3/";
const a = (state: string): FakeBuild => ({ key: "a", name: "sample-ci #3", state, url: URL_A });
const b = (state: string): FakeBuild => ({ key: "b", name: "lint", state });
const counts = (o: Partial<BuildCounts>): BuildCounts => ({ successful: 0, inProgress: 0, failed: 0, cancelled: 0, unknown: 0, ...o });

let fake: FakeBitbucket;
let statuses: Map<string, FakeBuild[]>;
let world: { author: RawPr[]; reviewer: RawPr[] };
const page = (values: unknown[]): Reply => ({ status: 200, body: onePage(values) });

beforeEach(() => {
  world = { author: [ownPr()], reviewer: [reviewPr()] };
  const empty = activities("activities-opened-only.json");
  fake = startFakeBitbucket({
    routes: {
      [key("GET", DASHBOARD_PATH)]: (req) => page(new URL(req.url).searchParams.get("role") === "AUTHOR" ? world.author : world.reviewer),
      [key("GET", ACTIVITIES_PATH)]: () => page(empty),
      [key("GET", `${REVIEW_PR_PATH}/activities`)]: () => page(empty),
    },
  });
  statuses = buildStatuses(fake);
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  fake.stop();
});

let n = 0;
async function setup() {
  const dir = join(root, `case-${n++}`);
  writeConfig(dir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const clock = { t: 1_000_000 };
  const engine = createSyncEngine({ settings, live: createLive(), now: () => clock.t });
  cleanup.push(() => {
    engine.stop();
    settings.close();
  });
  const db = () => settings.db() as Database;
  const id = (prId: number) => (db().query("SELECT id FROM pull_request WHERE pr_id = $prId").get({ prId }) as { id: number }).id;
  let mark = 0;
  return {
    db,
    engine,
    clock,
    id,
    async cycle() {
      clock.t += 60_000;
      mark = fake.requests.length;
      await engine.syncNow();
    },
    // The build-status GETs of the last cycle, in request order. Each PR reads its stats before its list.
    reads: (head?: string) =>
      fake.requests.slice(mark).filter((r) => r.includes("/rest/build-status/") && (head === undefined || r.includes(head))),
    events: () => db().query("SELECT pr, kind, ref FROM event WHERE kind LIKE 'build_%' ORDER BY id").all(),
    row: (prId: number) =>
      db()
        .query("SELECT head, stats_json, builds_json, read_at FROM pr_build WHERE pr = $pr")
        .get({ pr: id(prId) }) as {
        head: string;
        stats_json: string;
        builds_json: string | null;
        read_at: number;
      } | null,
    exec: (sql: string) => db().run(sql),
    dto: (prId: number) => listPrs(db(), FAKE_USER).find((p) => p.prId === prId)?.build,
  };
}

const own = () => world.author[0] as RawPr;

describe("build reads", () => {
  test("only open, followed, and not archived PRs are read", async () => {
    const h = await setup();
    await h.cycle();
    expect(h.reads()).toEqual([
      `GET ${STATS}${REVIEW}`,
      `GET ${LIST}${REVIEW}?limit=25`,
      `GET ${STATS}${OWN}`,
      `GET ${LIST}${OWN}?limit=25`,
    ]);

    // The own PR leaves the dashboard declined. The review PR is archived, then unfollowed.
    world.author = [];
    fake.routes[key("GET", PR_PATH)] = { status: 200, body: { ...ownPr(), state: "DECLINED" } };
    h.exec("UPDATE pull_request SET archived_at = 1 WHERE pr_id = 1001");
    await h.cycle();
    expect(h.reads()).toEqual([]);
    h.exec("UPDATE pull_request SET archived_at = NULL, followed = 0 WHERE pr_id = 1001");
    await h.cycle();
    expect(h.reads()).toEqual([]);
    expect(h.engine.status().state).toBe("ok");
  });

  test("the list is read again only after a change of the counts or the head", async () => {
    statuses.set(OWN, [a("INPROGRESS")]);
    const h = await setup();
    await h.cycle();
    expect(h.reads(OWN)).toEqual([`GET ${STATS}${OWN}`, `GET ${LIST}${OWN}?limit=25`]);
    await h.cycle();
    expect(h.reads(OWN)).toEqual([`GET ${STATS}${OWN}`]);

    statuses.set(OWN, [a("FAILED")]);
    await h.cycle();
    expect(h.reads(OWN)).toEqual([`GET ${STATS}${OWN}`, `GET ${LIST}${OWN}?limit=25`]);
    expect(h.row(2)).toEqual({
      head: OWN,
      stats_json: JSON.stringify(counts({ failed: 1 })),
      builds_json: JSON.stringify([{ name: "sample-ci #3", state: "FAILED", url: URL_A }]),
      read_at: h.clock.t,
    });

    // A new head with the same counts reads the list of the new head.
    own().fromRef.latestCommit = NEXT;
    statuses.set(NEXT, [a("FAILED")]);
    await h.cycle();
    expect(h.reads()).toEqual([`GET ${STATS}${REVIEW}`, `GET ${STATS}${NEXT}`, `GET ${LIST}${NEXT}?limit=25`]);
    expect(h.row(2)).toMatchObject({ head: NEXT });
  });

  test("a failed list read keeps the counts, and the details are not available until the next change", async () => {
    statuses.set(OWN, [a("FAILED"), b("SUCCESSFUL")]);
    fake.routes[key("GET", `${LIST}${OWN}`)] = { status: 500, body: { errors: [{ message: "Internal error." }] } };
    const h = await setup();
    await h.cycle();
    expect(h.engine.status().state).toBe("ok");
    expect(h.row(2)).toMatchObject({ head: OWN, stats_json: JSON.stringify(counts({ failed: 1, successful: 1 })), builds_json: null });
    expect(h.dto(2)).toEqual({ head: OWN, state: "failed", counts: counts({ failed: 1, successful: 1 }), builds: null, readAt: h.clock.t });
    await h.cycle();
    expect(h.reads(OWN)).toEqual([`GET ${STATS}${OWN}`]);

    delete fake.routes[key("GET", `${LIST}${OWN}`)];
    statuses.set(OWN, [a("FAILED"), b("FAILED")]);
    await h.cycle();
    expect(h.dto(2)?.builds).toEqual([
      { name: "sample-ci #3", state: "FAILED", url: URL_A },
      { name: "lint", state: "FAILED", url: null },
    ]);
  });

  test("a 401 on the stats ends the cycle, and a 429 on the list ends it before the row is written", async () => {
    const h = await setup();
    fake.routes[key("GET", `${STATS}${REVIEW}`)] = { status: 401, body: { errors: [{ message: "Authentication failed." }] } };
    fake.routes[key("GET", `${STATS}${OWN}`)] = { status: 401, body: { errors: [{ message: "Authentication failed." }] } };
    await h.cycle();
    expect(h.engine.status()).toMatchObject({ state: "auth", error: "Bitbucket rejected the token." });
    expect(fake.requests.filter((r) => r.includes("/activities"))).toEqual([]);

    delete fake.routes[key("GET", `${STATS}${REVIEW}`)];
    delete fake.routes[key("GET", `${STATS}${OWN}`)];
    fake.routes[key("GET", `${LIST}${OWN}`)] = { status: 429, headers: { "Retry-After": "30" }, body: {} };
    fake.routes[key("GET", `${LIST}${REVIEW}`)] = { status: 429, headers: { "Retry-After": "30" }, body: {} };
    await h.cycle();
    expect(h.engine.status()).toMatchObject({ state: "error", error: "Bitbucket asks to slow down." });
    expect(h.db().query("SELECT COUNT(*) AS n FROM pr_build").get()).toEqual({ n: 0 });

    delete fake.routes[key("GET", `${LIST}${OWN}`)];
    delete fake.routes[key("GET", `${LIST}${REVIEW}`)];
    await h.cycle();
    expect(h.engine.status().state).toBe("ok");
    expect(h.row(2)).toMatchObject({ head: OWN, builds_json: "[]" });
  });
});

describe("build events", () => {
  test("one event of each kind per head, only for the own PR, and none while a build runs", async () => {
    const both = (list: FakeBuild[]) => {
      statuses.set(OWN, list);
      statuses.set(REVIEW, list);
    };
    both([a("INPROGRESS")]);
    const h = await setup();
    await h.cycle();
    both([a("FAILED"), b("INPROGRESS")]);
    await h.cycle();
    expect(h.events()).toEqual([]);

    both([a("FAILED"), b("SUCCESSFUL")]);
    await h.cycle();
    const failed = { pr: h.id(2), kind: "build_failed", ref: OWN };
    expect(h.events()).toEqual([failed]);
    await h.cycle();
    expect(h.events()).toEqual([failed]);

    both([a("SUCCESSFUL"), b("SUCCESSFUL")]);
    await h.cycle();
    const passed = { pr: h.id(2), kind: "build_passed", ref: OWN };
    expect(h.events()).toEqual([failed, passed]);
    both([a("FAILED"), b("SUCCESSFUL")]);
    await h.cycle();
    expect(h.events()).toEqual([failed, passed]);

    // A cancelled or unknown build is no pass.
    own().fromRef.latestCommit = NEXT;
    statuses.set(NEXT, [a("SUCCESSFUL"), b("CANCELLED")]);
    await h.cycle();
    expect(h.events()).toEqual([failed, passed]);
  });

  test("the first sync of a PR gives no event", async () => {
    statuses.set(OWN, [a("FAILED")]);
    const h = await setup();
    await h.cycle();
    expect(h.row(2)).toMatchObject({ head: OWN });
    expect(h.events()).toEqual([]);
  });

  test("the first sync after a follow again gives no event; the next change does", async () => {
    statuses.set(OWN, [a("INPROGRESS")]);
    const h = await setup();
    await h.cycle();
    h.exec("UPDATE pull_request SET followed = 0 WHERE pr_id = 2");
    await h.cycle();
    statuses.set(OWN, [a("FAILED")]);
    h.exec("UPDATE pull_request SET followed = 1 WHERE pr_id = 2");
    await h.cycle();
    expect(h.row(2)).toMatchObject({ stats_json: JSON.stringify(counts({ failed: 1 })) });
    expect(h.events()).toEqual([]);

    statuses.set(OWN, [a("FAILED"), b("SUCCESSFUL")]);
    await h.cycle();
    expect(h.events()).toEqual([{ pr: h.id(2), kind: "build_failed", ref: OWN }]);
  });

  test("the first build read of an initialized PR gives no event", async () => {
    // Before this version: no stats route, so the PR syncs without a build row.
    delete fake.routes[key("GET", `${STATS}*`)];
    const h = await setup();
    await h.cycle();
    expect(h.engine.status().state).toBe("ok");
    expect(h.row(2)).toBeNull();

    buildStatuses(fake).set(OWN, [a("FAILED")]);
    await h.cycle();
    expect(h.row(2)).toMatchObject({ head: OWN });
    expect(h.events()).toEqual([]);
  });
});

describe("build DTOs", () => {
  test("the PR row, the detail, and buildOf carry the read of the synced head; an older head gives null", async () => {
    statuses.set(OWN, [b("SUCCESSFUL"), a("FAILED")]);
    const h = await setup();
    await h.cycle();
    const want: BuildDto = {
      head: OWN,
      state: "failed",
      counts: counts({ failed: 1, successful: 1 }),
      builds: [
        { name: "sample-ci #3", state: "FAILED", url: URL_A },
        { name: "lint", state: "SUCCESSFUL", url: null },
      ],
      readAt: h.clock.t,
    };
    expect(h.dto(2)).toEqual(want);
    expect(prDetail(h.db(), FAKE_USER, h.id(2))?.pr.build).toEqual(want);
    expect(buildOf(h.db(), h.id(2))).toEqual(want);
    expect(buildOf(h.db(), null)).toBeNull();

    // The head moves and its stats read fails: the stored read is of the old head.
    own().fromRef.latestCommit = NEXT;
    fake.routes[key("GET", `${STATS}${NEXT}`)] = { status: 500, body: { errors: [{ message: "Internal error." }] } };
    await h.cycle();
    expect(h.row(2)).toMatchObject({ head: OWN });
    expect(h.dto(2)).toBeNull();
    expect(buildOf(h.db(), h.id(2))).toBeNull();
  });
});

describe("build rules", () => {
  test("buildChanged compares the head and each count", () => {
    const prev = { head: OWN, stats_json: JSON.stringify(counts({ failed: 1 })) };
    expect(buildChanged(null, OWN, counts({}))).toBe(true);
    expect(buildChanged(prev, NEXT, counts({ failed: 1 }))).toBe(true);
    expect(buildChanged(prev, OWN, counts({ failed: 1 }))).toBe(false);
    for (const k of ["successful", "inProgress", "cancelled", "unknown"] as const)
      expect(buildChanged(prev, OWN, counts({ failed: 1, [k]: 1 }))).toBe(true);
  });

  test("keptBuilds puts failed first, then in progress, keeps the server order otherwise, and keeps 10", () => {
    const s = (name: string, state: string) => ({ name, state, url: null });
    const list = [
      s("ok1", "SUCCESSFUL"),
      s("run1", "INPROGRESS"),
      s("bad1", "FAILED"),
      s("x1", "CANCELLED"),
      s("bad2", "FAILED"),
      s("x2", "UNKNOWN"),
      s("ok2", "SUCCESSFUL"),
      s("run2", "INPROGRESS"),
      s("ok3", "SUCCESSFUL"),
      s("ok4", "SUCCESSFUL"),
      s("ok5", "SUCCESSFUL"),
      s("ok6", "SUCCESSFUL"),
    ];
    expect(keptBuilds(list).map((x) => x.name)).toEqual(["bad1", "bad2", "run1", "run2", "ok1", "x1", "x2", "ok2", "ok3", "ok4"]);
  });

  test("buildEvents fires only for the own PR after the first sync, with no build in progress", () => {
    const yes = { mine: true, first: false };
    expect(buildEvents(counts({ failed: 1 }), OWN, yes)).toEqual([{ kind: "build_failed", ref: OWN }]);
    expect(buildEvents(counts({ successful: 2 }), OWN, yes)).toEqual([{ kind: "build_passed", ref: OWN }]);
    expect(buildEvents(counts({ failed: 1, inProgress: 1 }), OWN, yes)).toEqual([]);
    expect(buildEvents(counts({ successful: 1, unknown: 1 }), OWN, yes)).toEqual([]);
    expect(buildEvents(counts({}), OWN, yes)).toEqual([]);
    expect(buildEvents(counts({ failed: 1 }), OWN, { mine: false, first: false })).toEqual([]);
    expect(buildEvents(counts({ failed: 1 }), OWN, { mine: true, first: true })).toEqual([]);
  });
});
