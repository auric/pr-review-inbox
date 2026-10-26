// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { listPrs, prDetail } from "../../src/server/inbox/queries";
import { createLive, type LiveEvent } from "../../src/server/live";
import { createSecrets } from "../../src/server/secrets";
import { createSettings, type Settings } from "../../src/server/settings";
import { createSyncEngine, type Timers } from "../../src/server/sync/engine";
import { MERGE_CONFLICTED } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, type FakeBitbucket, fixture, key, type Reply, startFakeBitbucket } from "../support/fake-bitbucket";
import {
  ACTIVITIES_PATH,
  type Activity,
  activities,
  addReply,
  asUsername,
  byUser,
  clone,
  DASHBOARD_PATH,
  findComment,
  onePage,
  ownPr,
  PR_PATH,
  pageRoutes,
  pages,
  REVIEW_PR_PATH,
  resolveThread,
  reviewPr,
  secondUser,
  versionZero,
} from "../support/scenarios";

process.env.REVIEW_LOOP_SECRETS = "memory";
const root = mkdtempSync(join(tmpdir(), "rl-sync-"));
process.env.REVIEW_LOOP_DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const OTHER = secondUser();
const REVIEW_ACTIVITIES = `${REVIEW_PR_PATH}/activities`;
const inline = () => activities("activities-inline-anchored.json");
const ME = findComment(inline(), 1000003).author;

// The server state that the fake replays. Tests change it between cycles.
let world: { reviewer: unknown[]; author: unknown[]; own: Activity[]; review: Activity[] };
let fake: FakeBitbucket;
const page = (values: unknown[]): Reply => ({ status: 200, body: onePage(values) });
const role = (req: Request) => new URL(req.url).searchParams.get("role");
const dashboard = (req: Request) => page(role(req) === "AUTHOR" ? world.author : world.reviewer);

beforeEach(() => {
  const empty = activities("activities-opened-only.json");
  world = { reviewer: [], author: [ownPr()], own: empty, review: clone(empty) };
  fake = startFakeBitbucket({
    routes: {
      [key("GET", DASHBOARD_PATH)]: dashboard,
      [key("GET", ACTIVITIES_PATH)]: () => page(world.own),
      [key("GET", REVIEW_ACTIVITIES)]: () => page(world.review),
    },
  });
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  fake.stop();
});

function fakeTimers() {
  const pending = new Map<number, { fn: () => unknown; ms: number }>();
  const delays: number[] = [];
  let last = 0;
  const timers: Timers = {
    set(fn, ms) {
      pending.set(++last, { fn, ms });
      delays.push(ms);
      return last;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    ...timers,
    pending,
    delays,
    // Runs the single pending timer and waits for its cycle.
    async fire() {
      const [entry, ...rest] = [...pending];
      if (!entry || rest.length) throw new Error(`expected one pending timer, got ${pending.size}`);
      pending.delete(entry[0]);
      await entry[1].fn();
    },
  };
}

async function until(check: () => boolean) {
  for (const end = Date.now() + 2000; !check(); await Bun.sleep(5)) if (Date.now() > end) throw new Error("timed out");
}

type CommentRow = {
  comment_id: number;
  version: number;
  parent_id: number | null;
  root_id: number;
  text: string;
  ack_version: number | null;
  anchor_json: string | null;
  thread_resolved: number;
  thread_resolver_json: string | null;
  thread_resolved_at: number | null;
  orphaned_at: number | null;
};
type Checkpoint = { last_complete_at: number | null; incomplete_reason: string | null; last_error: string | null };

let n = 0;
// token: false is a memory-mode restart: config.json exists, but the token is gone.
async function setup(
  dir = join(root, `case-${n++}`),
  opts: { token?: boolean; caFile?: string; user?: string; checkSeconds?: number } = {},
) {
  writeConfig(dir, {
    baseUrl: fake.url,
    userSlug: opts.user ?? FAKE_USER,
    notifications: false,
    caFile: opts.caFile,
    checkSeconds: opts.checkSeconds,
  });
  const secrets = createSecrets(null);
  if (opts.token !== false) await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const sent: [LiveEvent, unknown][] = [];
  const live = { ...createLive(), broadcast: (e: LiveEvent, d: unknown) => void sent.push([e, d]) };
  const timers = fakeTimers();
  const clock = { t: 1_000_000 };
  const random = { value: 0.5 };
  const engine = createSyncEngine({ settings, live, now: () => clock.t, random: () => random.value, timers });
  cleanup.push(() => {
    engine.stop();
    settings.close();
  });
  const db = () => settings.db() as Database;
  const one = <T>(sql: string, params: Record<string, string | number> = {}) => db().query(sql).get(params) as T;
  return {
    dir,
    settings,
    engine,
    db,
    sent,
    timers,
    clock,
    random,
    // One cycle, one interval after the previous one.
    async cycle() {
      clock.t += 60_000;
      await engine.syncNow();
    },
    unread: () =>
      one<{ n: number }>("SELECT COUNT(*) AS n FROM comment WHERE tombstoned_at IS NULL AND (ack_version IS NULL OR ack_version < version)")
        .n,
    events: () => db().query("SELECT kind, ref, digest FROM event ORDER BY id").all(),
    comment: (id: number) => one<CommentRow & { tombstoned_at: number | null }>("SELECT * FROM comment WHERE comment_id = $id", { id }),
    comments: () => db().query("SELECT comment_id, version FROM comment ORDER BY comment_id").all(),
    pr: (prId: number) => one<Record<string, unknown>>("SELECT * FROM pull_request WHERE pr_id = $prId", { prId }),
    checkpoint: (prId: number) =>
      one<Checkpoint>(
        "SELECT c.last_complete_at, c.incomplete_reason, c.last_error FROM sync_checkpoint c JOIN pull_request p ON c.scope = 'pr:' || p.id WHERE p.pr_id = $prId",
        { prId },
      ),
    dashboardCheckpoint: () =>
      one<Checkpoint>("SELECT last_complete_at, incomplete_reason, last_error FROM sync_checkpoint WHERE scope = 'dashboard'"),
  };
}

const requests = (from: number, part: string) => fake.requests.slice(from).filter((r) => r.includes(part));
const put = (settings: Settings, body: unknown) =>
  settings.routes.request("/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("first sync and restart (A1)", () => {
  test("the first sync of another user's comments gives 0 unread and 0 events", async () => {
    world.own = byUser(byUser(inline(), 1000003, OTHER), 1000001, OTHER);
    const h = await setup();
    await h.cycle();
    expect(h.comments()).toHaveLength(3);
    expect(h.unread()).toBe(0);
    expect(h.events()).toEqual([]);
    expect(h.pr(2)).toMatchObject({ my_role: "AUTHOR", on_dashboard: 1, followed: 1 });
    expect(h.pr(2).initialized_at).not.toBeNull();
    expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: null, last_error: null });
  });

  test("a new reply by that user gives 1 unread and 1 event, and a new engine keeps that state", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    world.own = addReply(base, 1000003, 1000010, OTHER);
    h.sent.length = 0;
    await h.cycle();
    expect(h.unread()).toBe(1);
    expect(h.comment(1000010)).toMatchObject({ parent_id: 1000003, root_id: 1000003, ack_version: null });
    expect(h.events()).toEqual([{ kind: "comment_new", ref: "1000010", digest: 0 }]);
    const id = h.pr(2).id;
    expect(h.sent).toEqual([
      ["changed", { prs: [id] }],
      ["events", { count: 1 }],
    ]);

    h.engine.stop();
    const restarted = await setup(h.dir);
    await restarted.cycle();
    expect(restarted.unread()).toBe(1);
    expect(restarted.events()).toHaveLength(1);
  });
});

describe("duplicates, order, and edits (A3, A4)", () => {
  test("duplicate and reordered activities give one row per comment and one event", async () => {
    const after = byUser(inline(), 1000002, OTHER);
    world.own = [...after, ...versionZero(after, 1000003)].reverse();
    const h = await setup();
    await h.cycle();
    expect(h.comments()).toEqual([
      { comment_id: 1000001, version: 0 },
      { comment_id: 1000002, version: 0 },
      { comment_id: 1000003, version: 1 },
    ]);
    const next = addReply(after, 1000002, 1000011, OTHER);
    world.own = [...next, ...clone(next)].reverse();
    await h.cycle();
    await h.cycle();
    expect(h.comments()).toHaveLength(4);
    expect(h.events()).toEqual([{ kind: "comment_new", ref: "1000011", digest: 0 }]);
  });

  test("an older version after a newer one changes nothing", async () => {
    const after = byUser(activities("activities-after-edit.json"), 1000003, OTHER);
    world.own = after;
    const h = await setup();
    await h.cycle();
    world.own = versionZero(after, 1000003);
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ version: 1, text: findComment(after, 1000003).text });
    expect(h.unread()).toBe(0);
  });

  test("an edit from version 0 to 1 updates the text and makes the message unread, with no event", async () => {
    const after = byUser(activities("activities-after-edit.json"), 1000003, OTHER);
    world.own = versionZero(after, 1000003);
    const h = await setup();
    await h.cycle();
    expect(h.unread()).toBe(0);
    world.own = after;
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ version: 1, text: findComment(after, 1000003).text, ack_version: 0 });
    expect(h.unread()).toBe(1);
    expect(h.events()).toEqual([]);
  });

  test("own comments and own edits give no unread and no event", async () => {
    world.own = inline();
    const h = await setup();
    await h.cycle();
    const next = addReply(inline(), 1000003, 1000012, ME);
    findComment(next, 1000002).version = 1;
    world.own = next;
    await h.cycle();
    expect(h.comment(1000012)).toMatchObject({ ack_version: 0 });
    expect(h.comment(1000002)).toMatchObject({ version: 1, ack_version: 1 });
    expect(h.unread()).toBe(0);
    expect(h.events()).toEqual([]);
  });
});

describe("metadata outside the version guard", () => {
  const anchor = (c: CommentRow) => JSON.parse(c.anchor_json ?? "null") as { orphaned?: boolean };

  test("same version with orphaned false to true updates anchor_json and leaves the message read", async () => {
    const base = byUser(inline(), 1000002, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    expect(anchor(h.comment(1000002))).toMatchObject({ orphaned: false });
    const next = clone(base);
    (findComment(next, 1000002).anchor as { orphaned: boolean }).orphaned = true;
    world.own = next;
    await h.cycle();
    expect(h.comment(1000002)).toMatchObject({ version: 0, ack_version: 0 });
    expect(anchor(h.comment(1000002))).toMatchObject({ orphaned: true, path: "sample1.md" });
    expect(h.unread()).toBe(0);
    expect(h.events()).toEqual([]);
  });

  // Gate A U2 to U12: the real captures before and after a push that orphans a range comment.
  test("real U2 to U12: the range comment keeps its version and span, turns orphaned, and stays read", async () => {
    const u2 = byUser(activities("activities-u2-range.json"), 1000001, OTHER);
    const u12 = byUser(activities("activities-u12-orphaned-range.json"), 1000001, OTHER);
    expect(findComment(u12, 1000001).version).toBe(findComment(u2, 1000001).version);
    world.own = u2;
    const h = await setup();
    await h.cycle();
    const span = { dstSpanStart: 3, dstSpanEnd: 12 };
    expect(anchor(h.comment(1000001))).toMatchObject({ orphaned: false, multilineSpan: span });
    world.own = u12;
    await h.cycle();
    expect(h.comment(1000001)).toMatchObject({ version: 0 });
    expect(anchor(h.comment(1000001))).toMatchObject({ orphaned: true, multilineSpan: span, multilineMarker: { startLine: 3 } });
    expect(h.unread()).toBe(0);
    expect(h.events()).toEqual([]);
  });

  test("same version with thread_resolved false to true updates it with no unread and no event", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ thread_resolved: 0 });
    const next = clone(base);
    findComment(next, 1000003).threadResolved = true;
    world.own = next;
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ version: 1, ack_version: 1, thread_resolved: 1 });
    expect(h.unread()).toBe(0);
    expect(h.events()).toEqual([]);
  });

  test("synthetic U56: the resolver and the date follow threadResolved at the same version, and a reopen clears them", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ thread_resolved: 0, thread_resolver_json: null, thread_resolved_at: null });
    const resolved = resolveThread(base, 1000003, OTHER, 1_500_000);
    world.own = resolved;
    await h.cycle();
    const row = h.comment(1000003);
    expect(row).toMatchObject({ version: 1, thread_resolved: 1, thread_resolved_at: 1_500_000 });
    expect(JSON.parse(row.thread_resolver_json ?? "null")).toEqual({ slug: "asmith", name: "Alex Smith", login: "asmith" });
    expect(h.comment(1000001)).toMatchObject({ thread_resolver_json: null, thread_resolved_at: null });
    expect(h.unread()).toBe(0);
    expect(h.events()).toEqual([]);
    const dto = (id: number) => prDetail(h.db(), FAKE_USER, h.pr(2).id as number)?.comments.find((c) => c.id === id);
    expect(dto(1000003)).toMatchObject({ threadResolved: true, resolvedAt: 1_500_000, resolver: { slug: "asmith", name: "Alex Smith" } });
    expect(dto(1000001)?.resolver).toBeUndefined();
    const reopened = clone(resolved);
    findComment(reopened, 1000003).threadResolved = false;
    world.own = reopened;
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ version: 1, thread_resolved: 0, thread_resolver_json: null, thread_resolved_at: null });
    expect(dto(1000003)).toMatchObject({ threadResolved: false });
    expect(dto(1000003)?.resolver).toBeUndefined();
    expect(dto(1000003)?.resolvedAt).toBeUndefined();
  });

  test("orphaned_at: a flip to orphaned sets the sync time, a later sync keeps it, and a flip back clears it", async () => {
    const base = byUser(inline(), 1000002, OTHER);
    world.own = base;
    const h = await setup();
    const dto = () => prDetail(h.db(), FAKE_USER, h.pr(2).id as number)?.comments.find((c) => c.id === 1000002);
    await h.cycle();
    expect(h.comment(1000002).orphaned_at).toBeNull();
    const next = clone(base);
    (findComment(next, 1000002).anchor as { orphaned: boolean }).orphaned = true;
    world.own = next;
    await h.cycle();
    const at = h.clock.t;
    expect(h.comment(1000002).orphaned_at).toBe(at);
    await h.cycle();
    expect(h.comment(1000002).orphaned_at).toBe(at);
    expect(dto()?.orphanedAt).toBe(at);
    world.own = base;
    await h.cycle();
    expect(h.comment(1000002).orphaned_at).toBeNull();
    expect(dto()?.orphanedAt).toBeUndefined();
    expect(h.events()).toEqual([]);
  });

  test("orphaned_at: an anchor that is orphaned at first sight keeps NULL", async () => {
    const base = byUser(inline(), 1000002, OTHER);
    (findComment(base, 1000002).anchor as { orphaned: boolean }).orphaned = true;
    world.own = base;
    const h = await setup();
    await h.cycle();
    await h.cycle();
    expect(anchor(h.comment(1000002))).toMatchObject({ orphaned: true });
    expect(h.comment(1000002).orphaned_at).toBeNull();
  });

  test("an older version never rolls metadata back", async () => {
    const newer = byUser(inline(), 1000002, OTHER);
    const c = findComment(newer, 1000002);
    c.version = 2;
    c.threadResolved = true;
    (c.anchor as { orphaned: boolean }).orphaned = true;
    world.own = newer;
    const h = await setup();
    await h.cycle();
    world.own = byUser(inline(), 1000002, OTHER);
    await h.cycle();
    expect(h.comment(1000002)).toMatchObject({ version: 2, thread_resolved: 1 });
    expect(anchor(h.comment(1000002))).toMatchObject({ orphaned: true });
  });
});

describe("deletes (A4)", () => {
  const IDS = [1000001, 1000002, 1000003];
  // Imports three comments, then serves the recorded state after all deletes with `reply` for each comment GET.
  async function afterDelete(reply: Reply) {
    world.own = inline();
    const h = await setup();
    await h.cycle();
    world.own = activities("activities-after-delete.json");
    for (const id of IDS) fake.routes[key("GET", `${PR_PATH}/comments/${id}`)] = reply;
    await h.cycle();
    return h;
  }

  test("absent plus 404 tombstones", async () => {
    const h = await afterDelete(fixture("comment-get-after-delete-404.json"));
    for (const id of IDS) expect(h.comment(id).tombstoned_at).not.toBeNull();
    expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: null, last_error: null });
  });

  test("absent plus 200 keeps the comment and records a gap", async () => {
    const h = await afterDelete(fixture("comment-with-nested-reply.json"));
    for (const id of IDS) expect(h.comment(id).tombstoned_at).toBeNull();
    expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: "gap", last_error: expect.stringContaining("1000002") });
  });

  test("absent plus a network error keeps the comment for the next cycle", async () => {
    const h = await afterDelete({ drop: true });
    for (const id of IDS) expect(h.comment(id).tombstoned_at).toBeNull();
    expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: "network" });
    for (const id of IDS) fake.routes[key("GET", `${PR_PATH}/comments/${id}`)] = fixture("comment-get-after-delete-404.json");
    await h.cycle();
    for (const id of IDS) expect(h.comment(id).tombstoned_at).not.toBeNull();
  });

  test("absent plus 403 or 500 keeps the comment", async () => {
    for (const status of [403, 500]) {
      const h = await afterDelete({ status, body: {} });
      for (const id of IDS) expect(h.comment(id).tombstoned_at).toBeNull();
    }
  });

  test("a settings change during the delete checks sends no further check with the old token", async () => {
    world.own = inline();
    const h = await setup();
    await h.cycle();
    world.own = activities("activities-after-delete.json");
    let checks = 0;
    const check = (): Reply => (checks++ ? fixture("comment-get-after-delete-404.json") : { hang: true });
    for (const id of IDS) fake.routes[key("GET", `${PR_PATH}/comments/${id}`)] = check;
    const other = startFakeBitbucket({ routes: { [key("GET", DASHBOARD_PATH)]: page([]) } });
    const from = fake.requests.length;
    try {
      const running = h.engine.syncNow();
      await until(() => requests(from, "/comments/").length === 1);
      expect((await put(h.settings, { baseUrl: other.url, token: FAKE_TOKEN })).status).toBe(200);
      fake.release();
      await running;
    } finally {
      other.stop();
    }
    expect(requests(from, "/comments/")).toHaveLength(1);
  });

  test("a comment that is still present gets no delete check", async () => {
    world.own = inline();
    const h = await setup();
    await h.cycle();
    const from = fake.requests.length;
    await h.cycle();
    expect(requests(from, "/comments/")).toEqual([]);
  });
});

describe("partial data (A5, A6)", () => {
  test("a failure on page 2 changes no data and tombstones nothing; the next cycle completes", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    const done = h.checkpoint(2).last_complete_at;
    const edited = clone(base);
    findComment(edited, 1000003).version = 2;
    // Page 1 holds the edit. Comment 1000002 is on the failing page 2.
    const order = [edited[1], edited[2], edited[0]] as Activity[];
    Object.assign(fake.routes, pageRoutes(ACTIVITIES_PATH, pages(order, [2, 1], "absent")));
    fake.routes[key("GET", ACTIVITIES_PATH, 2)] = { status: 500, body: {} };
    const from = fake.requests.length;
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ version: 1 });
    expect(h.comment(1000002).tombstoned_at).toBeNull();
    expect(requests(from, "/comments/")).toEqual([]);
    expect(h.checkpoint(2)).toMatchObject({
      last_complete_at: done,
      incomplete_reason: "server",
      last_error: expect.stringContaining("500"),
    });

    Object.assign(fake.routes, pageRoutes(ACTIVITIES_PATH, pages(order, [2, 1], "absent")));
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ version: 2 });
    expect(h.unread()).toBe(1);
    expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: null, last_error: null });
    expect(h.checkpoint(2).last_complete_at).toBeGreaterThan(done ?? 0);
  });

  for (const last of ["absent", "null"] as const) {
    test(`multi-page threads keep every message (last page ${last})`, async () => {
      Object.assign(fake.routes, pageRoutes(ACTIVITIES_PATH, pages(inline(), [1, 1, 1], last)));
      const h = await setup();
      await h.cycle();
      expect(h.comments().map((c) => (c as CommentRow).comment_id)).toEqual([1000001, 1000002, 1000003]);
      expect(h.comment(1000001)).toMatchObject({ parent_id: 1000003, root_id: 1000003 });
      expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: null });
    });
  }

  test("an incomplete dashboard keeps roles, states, and dashboard flags", async () => {
    world.reviewer = [reviewPr()];
    const h = await setup();
    await h.cycle();
    expect(h.pr(1001)).toMatchObject({ my_role: "REVIEWER", my_status: "UNAPPROVED", on_dashboard: 1 });
    world.reviewer = [];
    fake.routes[key("GET", DASHBOARD_PATH)] = (req) => (role(req) === "AUTHOR" ? { status: 500, body: {} } : dashboard(req));
    const from = fake.requests.length;
    await h.cycle();
    expect(h.pr(1001)).toMatchObject({ my_role: "REVIEWER", on_dashboard: 1 });
    expect(h.pr(2)).toMatchObject({ on_dashboard: 1 });
    expect(h.dashboardCheckpoint()).toMatchObject({ incomplete_reason: "server" });
    expect(fake.requests.slice(from).filter((r) => r === `GET ${REVIEW_PR_PATH}`)).toEqual([]);
    expect(requests(from, "/activities")).toHaveLength(2);
  });
});

describe("follow state (A15)", () => {
  test("a PR that leaves the dashboard as MERGED stays followed and keeps its unread messages", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    world.own = addReply(base, 1000003, 1000010, OTHER);
    await h.cycle();
    expect(h.unread()).toBe(1);
    world.author = [];
    const merged = ownPr();
    merged.state = "MERGED";
    fake.routes[key("GET", PR_PATH)] = { status: 200, body: merged };
    const from = fake.requests.length;
    await h.cycle();
    expect(h.pr(2)).toMatchObject({ state: "MERGED", followed: 1, on_dashboard: 0, my_role: "AUTHOR" });
    expect(h.unread()).toBe(1);
    expect(requests(from, "/activities")).toHaveLength(1);
  });

  test("a followed MERGED PR gets no single-PR GET after it is stored, but new comments still arrive", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    world.author = [];
    const merged = ownPr();
    merged.state = "MERGED";
    fake.routes[key("GET", PR_PATH)] = { status: 200, body: merged };
    await h.cycle();
    expect(h.pr(2)).toMatchObject({ state: "MERGED", on_dashboard: 0 });
    const from = fake.requests.length;
    world.own = addReply(base, 1000003, 1000010, OTHER);
    h.clock.t += 3_600_000;
    await h.cycle();
    expect(fake.requests.slice(from).filter((r) => r === key("GET", PR_PATH))).toEqual([]);
    expect(h.unread()).toBe(1);
  });

  test("a merged or declined PR gets at most one activities poll per hour", async () => {
    world.reviewer = [reviewPr()];
    const h = await setup();
    await h.cycle();
    world.reviewer = [];
    world.author = [];
    const declined = reviewPr();
    declined.state = "DECLINED";
    const merged = ownPr();
    merged.state = "MERGED";
    fake.routes[key("GET", REVIEW_PR_PATH)] = { status: 200, body: declined };
    fake.routes[key("GET", PR_PATH)] = { status: 200, body: merged };
    await h.cycle();
    expect(h.pr(1001)).toMatchObject({ state: "DECLINED", followed: 1 });
    expect(h.pr(2)).toMatchObject({ state: "MERGED", followed: 1 });
    let from = fake.requests.length;
    await h.cycle();
    expect(requests(from, "/activities")).toEqual([]);
    expect(requests(from, `GET ${REVIEW_PR_PATH}`)).toEqual([]);
    h.clock.t += 3_600_000;
    from = fake.requests.length;
    await h.cycle();
    expect(requests(from, "/activities")).toHaveLength(2);
    expect(fake.requests.slice(from).filter((r) => r === `GET ${REVIEW_PR_PATH}`)).toHaveLength(1);
  });

  test("a 404 on the single-PR GET moves that PR to the archive with its data", async () => {
    world.reviewer = [reviewPr()];
    world.own = byUser(inline(), 1000003, OTHER);
    const h = await setup();
    await h.cycle();
    world.author = [];
    await h.cycle();
    expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: "not_found" });
    expect(h.pr(2)).toMatchObject({ state: "OPEN", followed: 0, on_dashboard: 0 });
    expect(h.comment(1000003)).toBeTruthy();
    expect(h.checkpoint(1001)).toMatchObject({ incomplete_reason: null });
    expect(h.engine.status().state).toBe("ok");
    const from = fake.requests.length;
    await h.cycle();
    expect(fake.requests.slice(from).filter((r) => r === key("GET", PR_PATH) || r.startsWith(`GET ${ACTIVITIES_PATH}`))).toEqual([]);
  });

  test("unfollow clears initialized_at and stops polling; a later follow imports silently", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    h.db().query("UPDATE pull_request SET followed = 0 WHERE pr_id = 2").run();
    world.own = addReply(base, 1000003, 1000010, OTHER);
    const from = fake.requests.length;
    await h.cycle();
    expect(requests(from, "/activities")).toEqual([]);
    expect(h.pr(2).initialized_at).toBeNull();
    h.db().query("UPDATE pull_request SET followed = 1 WHERE pr_id = 2").run();
    await h.cycle();
    expect(h.comment(1000010)).toMatchObject({ ack_version: 0 });
    expect(h.unread()).toBe(0);
    expect(h.events()).toEqual([]);
  });

  test("archive stops activity polling", async () => {
    const h = await setup();
    await h.cycle();
    h.db().query("UPDATE pull_request SET archived_at = 1 WHERE pr_id = 2").run();
    const from = fake.requests.length;
    await h.cycle();
    expect(requests(from, "/activities")).toEqual([]);
    expect(h.pr(2).initialized_at).toBeNull();
  });
});

describe("reviewers", () => {
  const reviewers = (h: Awaited<ReturnType<typeof setup>>) => JSON.parse(String(h.pr(1001).reviewers_json));

  test("the first sync stores every reviewer", async () => {
    world.reviewer = [reviewPr()];
    const h = await setup();
    await h.cycle();
    expect(reviewers(h)).toEqual([
      {
        slug: "jdoe",
        name: "Jane Doe",
        login: "jdoe",
        status: "UNAPPROVED",
        lastReviewedCommit: "c5bf8bfcb823b4949bc9bfe280c5ffc3ffd0a151",
      },
    ]);
  });

  test("a status change updates the reviewers and gives no unread and no event", async () => {
    world.reviewer = [reviewPr()];
    const h = await setup();
    await h.cycle();
    const changed = reviewPr() as ReturnType<typeof reviewPr> & { reviewers: Record<string, unknown>[] };
    changed.reviewers = [
      { ...changed.reviewers[0], status: "NEEDS_WORK" },
      { user: OTHER, role: "REVIEWER", approved: true, status: "APPROVED" },
    ];
    world.reviewer = [changed];
    await h.cycle();
    expect(reviewers(h).map((r: { slug: string; status: string }) => [r.slug, r.status])).toEqual([
      ["jdoe", "NEEDS_WORK"],
      [OTHER.slug, "APPROVED"],
    ]);
    expect(h.events()).toEqual([]);
    expect(h.unread()).toBe(0);
  });
});

describe("events", () => {
  test("reviewer_added appears after the first complete dashboard only", async () => {
    world.reviewer = [reviewPr()];
    const first = await setup();
    await first.cycle();
    expect(first.events()).toEqual([]);

    world.reviewer = [];
    const h = await setup();
    await h.cycle();
    world.reviewer = [reviewPr()];
    await h.cycle();
    await h.cycle();
    expect(h.events()).toEqual([{ kind: "reviewer_added", ref: "4", digest: 0 }]);
  });

  test("commits_pushed appears when the source head of a reviewed PR changes", async () => {
    world.reviewer = [reviewPr()];
    const h = await setup();
    await h.cycle();
    const pushed = reviewPr();
    pushed.fromRef.latestCommit = "f".repeat(40);
    world.reviewer = [pushed];
    await h.cycle();
    expect(h.events()).toEqual([{ kind: "commits_pushed", ref: "f".repeat(40), digest: 0 }]);
    expect(h.pr(1001)).toMatchObject({ source_head: "f".repeat(40) });
  });

  test("on a reviewed PR a new comment notifies only in a thread that holds my comment", async () => {
    world.reviewer = [reviewPr()];
    const base = byUser(inline(), 1000003, OTHER);
    world.review = base;
    const h = await setup();
    await h.cycle();
    const root = { ...clone(findComment(base, 1000003)), id: 1000021, comments: [] };
    world.review = [
      ...addReply(base, 1000003, 1000020, OTHER),
      { id: 10000050, action: "COMMENTED", commentAction: "ADDED", comment: root },
    ];
    await h.cycle();
    expect(h.events()).toEqual([{ kind: "comment_new", ref: "1000020", digest: 0 }]);
    expect(h.unread()).toBe(2);
  });
});

describe("draft_stale events (thread-outcome.md section 11)", () => {
  type H = Awaited<ReturnType<typeof setup>>;
  type Event = { kind: string; ref: string; digest: number };
  // Thread 1000003: my root, then the reply 1000001 by the other user.
  const base = () => byUser(inline(), 1000001, OTHER);
  let runs = 0;
  // A reply draft in thread 1000003 of PR 2. Accepted, so the user touched it.
  const draft = (h: H, o: { replyTo: number; status?: string; edited?: number }) => {
    const db = h.db();
    const { id: run } = db
      .query(`INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
        VALUES ($pr, 'reply', 'general', '', $key, 'a', 'b', 'completed', 1) RETURNING id`)
      .get({ pr: h.pr(2).id as number, key: `stale-${runs++}` }) as { id: number };
    const payload = JSON.stringify({ thread: 1000003, replyTo: o.replyTo, threadOpen: true });
    return (
      db
        .query(`INSERT INTO review_item (run, kind, payload_json, body, status, edited, thread)
          VALUES ($run, 'reply', $payload, 'Thanks.', $status, $edited, 1000003) RETURNING id`)
        .get({ run, payload, status: o.status ?? "accepted", edited: o.edited ?? 0 }) as { id: number }
    ).id;
  };
  const stale = (h: H) => (h.events() as Event[]).filter((e) => e.kind === "draft_stale").map((e) => e.ref);
  const badge = (h: H) => listPrs(h.db(), FAKE_USER).find((r) => r.prId === 2)?.staleDrafts;
  async function start() {
    world.own = base();
    const h = await setup();
    await h.cycle();
    return h;
  }

  test("an accepted draft notifies once when a new message makes it out of date", async () => {
    const h = await start();
    const item = draft(h, { replyTo: 1000001 });
    await h.cycle();
    expect(h.events()).toEqual([]);
    expect(badge(h)).toBe(0);
    world.own = addReply(base(), 1000001, 1000010, OTHER);
    await h.cycle();
    await h.cycle();
    expect(h.events()).toEqual([
      { kind: "comment_new", ref: "1000010", digest: 0 },
      { kind: "draft_stale", ref: `${item}:out-of-date:1000010`, digest: 0 },
    ]);
    expect(badge(h)).toBe(1);
  });

  test("an edited draft notifies; a draft that the user did not touch counts in the badge only", async () => {
    const edited = await start();
    const item = draft(edited, { replyTo: 1000001, status: "new", edited: 1 });
    world.own = addReply(base(), 1000001, 1000010, OTHER);
    await edited.cycle();
    expect(stale(edited)).toEqual([`${item}:out-of-date:1000010`]);

    const untouched = await start();
    draft(untouched, { replyTo: 1000001, status: "new" });
    world.own = addReply(base(), 1000001, 1000010, OTHER);
    await untouched.cycle();
    expect(stale(untouched)).toEqual([]);
    expect(badge(untouched)).toBe(1);
  });

  test("my own newest message and my own resolve give no event; a resolve by the other user notifies with its time", async () => {
    const reply = await start();
    draft(reply, { replyTo: 1000001 });
    world.own = addReply(base(), 1000001, 1000010, ME);
    await reply.cycle();
    expect(stale(reply)).toEqual([]);
    expect(badge(reply)).toBe(1);

    const mine = await start();
    draft(mine, { replyTo: 1000001 });
    world.own = resolveThread(base(), 1000003, ME, 1_500_000);
    await mine.cycle();
    expect(stale(mine)).toEqual([]);

    const other = await start();
    const item = draft(other, { replyTo: 1000001 });
    world.own = resolveThread(base(), 1000003, OTHER, 1_500_000);
    await other.cycle();
    expect(stale(other)).toEqual([`${item}:resolved-since:1500000`]);
  });

  test("a merged PR keeps the badge and gets no event; the first sync after a follow gives no event", async () => {
    const merged = await start();
    draft(merged, { replyTo: 1000001 });
    world.author = [];
    const pr = ownPr();
    pr.state = "MERGED";
    fake.routes[key("GET", PR_PATH)] = { status: 200, body: pr };
    world.own = addReply(base(), 1000001, 1000010, OTHER);
    await merged.cycle();
    expect(merged.pr(2)).toMatchObject({ state: "MERGED" });
    expect(stale(merged)).toEqual([]);
    expect(badge(merged)).toBe(1);

    world.author = [ownPr()];
    const first = await start();
    draft(first, { replyTo: 1000001 });
    // SQL.forget clears initialized_at of an unfollowed PR, so its next sync is a first sync.
    first.db().run("UPDATE pull_request SET initialized_at = NULL");
    world.own = addReply(base(), 1000001, 1000010, OTHER);
    await first.cycle();
    expect(first.events()).toEqual([]);
    expect(badge(first)).toBe(1);
  });

  test("a draft that is already stale gives no event; a draft moved to the newest message notifies again with a new ref", async () => {
    const h = await start();
    const item = draft(h, { replyTo: 1000001 });
    const one = addReply(base(), 1000001, 1000010, OTHER);
    world.own = one;
    await h.cycle();
    const two = addReply(one, 1000010, 1000011, OTHER);
    world.own = two;
    await h.cycle();
    expect(stale(h)).toEqual([`${item}:out-of-date:1000010`]);
    h.db().run(`UPDATE review_item SET payload_json = json_set(payload_json, '$.replyTo', 1000011) WHERE id = ${item}`);
    await h.cycle();
    expect(badge(h)).toBe(0);
    world.own = addReply(two, 1000011, 1000012, OTHER);
    await h.cycle();
    expect(stale(h)).toEqual([`${item}:out-of-date:1000010`, `${item}:out-of-date:1000012`]);
  });

  test("a draft created or accepted while it is stale never notifies", async () => {
    const h = await start();
    const one = addReply(base(), 1000001, 1000010, OTHER);
    world.own = one;
    await h.cycle();
    draft(h, { replyTo: 1000001 });
    world.own = addReply(one, 1000010, 1000011, OTHER);
    await h.cycle();
    expect(stale(h)).toEqual([]);
    expect(badge(h)).toBe(1);
  });
});

describe("current user by username (synthetic)", () => {
  // X-AUSERNAME carries the username JDoe. The user objects carry name JDoe and slug jdoe.
  const NAME = "JDoe";
  const mine = <T>(v: T) => asUsername(v, FAKE_USER, NAME);

  test("role, own comments, events, and the turn match the username and the slug", async () => {
    fake.user = NAME;
    world.author = [mine(ownPr())];
    world.reviewer = [mine(reviewPr())];
    const base = mine(inline());
    world.own = base;
    const h = await setup(undefined, { user: NAME });
    await h.cycle();
    expect(h.pr(2)).toMatchObject({ my_role: "AUTHOR" });
    expect(h.pr(1001)).toMatchObject({ my_role: "REVIEWER", my_status: "UNAPPROVED" });

    world.own = addReply(addReply(base, 1000003, 1000010, findComment(base, 1000003).author), 1000003, 1000011, OTHER);
    await h.cycle();
    expect(h.comment(1000010).ack_version).toBe(0);
    expect(h.unread()).toBe(1);
    expect(h.events()).toEqual([{ kind: "comment_new", ref: "1000011", digest: 0 }]);
    const row = listPrs(h.db(), NAME).find((r) => r.id === h.pr(2).id);
    // The newest live message is my reply 1000001. Only a match by username makes the thread "wait" and not "your".
    expect(row).toMatchObject({ yourTurn: 0, waitSince: expect.any(Number) });
  });
});

describe("transaction", () => {
  test("a RAISE(ABORT) on the event insert rolls back the PR transaction", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    const comments = h.db().query("SELECT * FROM comment ORDER BY comment_id").all();
    const checkpoint = h.checkpoint(2);
    h.db().exec("CREATE TRIGGER fail_event BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'event insert failed'); END");
    const next = addReply(base, 1000003, 1000010, OTHER);
    findComment(next, 1000003).version = 3;
    world.own = next;
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    try {
      await h.cycle();
    } finally {
      quiet.mockRestore();
    }
    expect(h.db().query("SELECT * FROM comment ORDER BY comment_id").all()).toEqual(comments);
    expect(h.checkpoint(2)).toEqual(checkpoint);
    expect(h.events()).toEqual([]);
    expect(h.engine.status()).toMatchObject({ state: "error", error: expect.stringContaining("event insert failed") });

    h.db().exec("DROP TRIGGER fail_event");
    await h.cycle();
    expect(h.comment(1000003)).toMatchObject({ version: 3 });
    expect(h.events()).toMatchObject([{ kind: "comment_new", ref: "1000010" }]);
  });
});

describe("scheduling", () => {
  test("requests in flight never exceed 2", async () => {
    const ids = [3, 4, 5, 6];
    world.author = [ownPr(), ...ids.map((id) => ({ ...ownPr(), id }))];
    for (const id of ids) {
      fake.routes[key("GET", `${PR_PATH.replace(/\d+$/, String(id))}/activities`)] = { ...page([]), delayMs: 10 } as Reply;
    }
    fake.routes[key("GET", DASHBOARD_PATH)] = (req) => ({ ...dashboard(req), delayMs: 10 }) as Reply;
    const h = await setup();
    await Promise.all([h.engine.syncNow(), h.engine.syncNow(), h.engine.syncNow()]);
    expect(fake.maxInFlight).toBeLessThanOrEqual(2);
    const done = h.db().query("SELECT COUNT(*) AS n FROM sync_checkpoint WHERE last_complete_at IS NOT NULL").get() as { n: number };
    expect(done.n).toBe(6);
  });

  test("syncNow during a cycle runs one more cycle after it", async () => {
    fake.routes[key("GET", DASHBOARD_PATH)] = (req) => ({ ...dashboard(req), delayMs: 20 }) as Reply;
    const h = await setup();
    const first = h.engine.syncNow();
    expect(h.engine.status().running).toBe(true);
    await Promise.all([first, h.engine.syncNow(), h.engine.syncNow()]);
    expect(requests(0, `GET ${DASHBOARD_PATH}`)).toHaveLength(4);
    expect(h.engine.status().running).toBe(false);
  });

  test("the next cycle waits 60 s times a factor from 0.9 to 1.1", async () => {
    const h = await setup();
    h.random.value = 0;
    h.engine.start();
    expect(h.timers.delays).toEqual([0]);
    await h.timers.fire();
    expect(h.timers.delays[1]).toBeCloseTo(54_000);
    h.random.value = 1;
    await h.timers.fire();
    expect(h.timers.delays[2]).toBeCloseTo(66_000);
    expect(h.engine.status()).toMatchObject({ state: "ok", running: false, lastCompleteAt: h.clock.t });
    expect(h.engine.status().nextAt).toBeCloseTo(h.clock.t + 66_000);
  });

  test("offline backoff doubles with full jitter up to 15 min and skips PR calls; success resets it", async () => {
    const h = await setup();
    h.random.value = 1;
    h.engine.start();
    await h.timers.fire();
    fake.routes[key("GET", DASHBOARD_PATH)] = { drop: true };
    const from = fake.requests.length;
    for (let i = 0; i < 5; i++) await h.timers.fire();
    expect(h.timers.delays.slice(2)).toEqual([120_000, 240_000, 480_000, 900_000, 900_000]);
    expect(h.engine.status()).toMatchObject({ state: "offline", error: expect.stringContaining("network") });
    expect(requests(from, "/activities")).toEqual([]);
    h.random.value = 0.25;
    await h.timers.fire();
    expect(h.timers.delays.at(-1)).toBe(0.25 * 900_000);

    fake.routes[key("GET", DASHBOARD_PATH)] = dashboard;
    h.random.value = 1;
    await h.timers.fire();
    expect(h.engine.status().state).toBe("ok");
    expect(h.timers.delays.at(-1)).toBeCloseTo(66_000);
  });

  test("Retry-After wins over the computed delay", async () => {
    fake.routes[key("GET", DASHBOARD_PATH)] = { status: 429, body: {}, headers: { "Retry-After": "300" } };
    const h = await setup();
    h.engine.start();
    await h.timers.fire();
    expect(h.timers.delays.at(-1)).toBe(300_000);
  });

  test("a dashboard 429 ends the cycle before the PR calls and keeps the last complete time", async () => {
    const h = await setup();
    h.engine.start();
    await h.timers.fire();
    const done = h.engine.status().lastCompleteAt;
    expect(done).not.toBeNull();
    fake.routes[key("GET", DASHBOARD_PATH)] = { status: 429, body: {}, headers: { "Retry-After": "300" } };
    const from = fake.requests.length;
    h.clock.t += 60_000;
    await h.timers.fire();
    expect(requests(from, "/activities")).toEqual([]);
    expect(h.engine.status()).toMatchObject({ state: "error", error: "Bitbucket asks to slow down.", lastCompleteAt: done });
    expect(h.timers.delays.at(-1)).toBe(300_000);
  });

  test("a short Retry-After never shortens the check interval", async () => {
    fake.routes[key("GET", DASHBOARD_PATH)] = { status: 429, body: {}, headers: { "Retry-After": "1" } };
    const h = await setup();
    h.random.value = 0;
    h.engine.start();
    await h.timers.fire();
    expect(h.timers.delays.at(-1)).toBeGreaterThanOrEqual(0.9 * 60_000);
  });

  test("the first cycle after start and a gap over 120 s set the digest flag", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup();
    await h.cycle();
    world.own = addReply(base, 1000003, 1000010, OTHER);
    await h.cycle();
    world.own = addReply(world.own, 1000003, 1000011, OTHER);
    h.clock.t += 200_000;
    await h.cycle();
    expect(h.events()).toEqual([
      { kind: "comment_new", ref: "1000010", digest: 0 },
      { kind: "comment_new", ref: "1000011", digest: 1 },
    ]);

    h.engine.stop();
    world.own = addReply(world.own, 1000003, 1000012, OTHER);
    const restarted = await setup(h.dir);
    await restarted.cycle();
    expect(restarted.events().at(-1)).toEqual({ kind: "comment_new", ref: "1000012", digest: 1 });
  });

  test("the digest gap is two check intervals", async () => {
    const base = byUser(inline(), 1000003, OTHER);
    world.own = base;
    const h = await setup(undefined, { checkSeconds: 300 });
    await h.cycle();
    world.own = addReply(base, 1000003, 1000010, OTHER);
    h.clock.t += 4 * 60_000;
    await h.engine.syncNow();
    world.own = addReply(world.own, 1000003, 1000011, OTHER);
    h.clock.t += 11 * 60_000;
    await h.engine.syncNow();
    expect(h.events()).toEqual([
      { kind: "comment_new", ref: "1000010", digest: 0 },
      { kind: "comment_new", ref: "1000011", digest: 1 },
    ]);
  });

  test("the next cycle follows the check interval", async () => {
    const h = await setup(undefined, { checkSeconds: 300 });
    h.engine.start();
    await h.timers.fire();
    expect(h.engine.status().state).toBe("ok");
    expect(h.timers.delays.at(-1)).toBeCloseTo(300_000);
  });

  test("a 401 pauses polling until the settings change", async () => {
    const h = await setup();
    h.engine.start();
    await h.timers.fire();
    fake.token = "rotated-token";
    await h.timers.fire();
    expect(h.engine.status()).toMatchObject({ state: "auth", nextAt: null });
    expect(h.timers.pending.size).toBe(0);

    const res = await put(h.settings, { baseUrl: fake.url, token: "rotated-token" });
    expect(res.status).toBe(200);
    expect(h.timers.pending.size).toBe(1);
    await h.timers.fire();
    expect(h.engine.status().state).toBe("ok");
  });

  test("a settings change mid-cycle stops the old cycle before its database closes", async () => {
    world.own = inline();
    const h = await setup();
    fake.routes[key("GET", ACTIVITIES_PATH)] = { hang: true };
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const other = startFakeBitbucket({ routes: { [key("GET", DASHBOARD_PATH)]: page([]) } });
    try {
      const running = h.engine.syncNow();
      await until(() => fake.inFlight === 1);
      const res = await put(h.settings, { baseUrl: other.url, token: FAKE_TOKEN });
      expect(res.status).toBe(200);
      fake.release();
      await running;
      await h.engine.syncNow();
    } finally {
      spy.mockRestore();
      other.stop();
    }
    expect(logs.filter((l) => l.startsWith("Sync error"))).toEqual([]);
    expect(h.engine.status().state).toBe("ok");
    expect(h.dashboardCheckpoint()).toMatchObject({ incomplete_reason: null });
  });

  // Runs a cycle, holds the first request to `held`, and changes the settings to another origin meanwhile.
  async function switchDuring(h: Awaited<ReturnType<typeof setup>>, held: string) {
    let first = true;
    fake.routes[key("GET", held)] = (): Reply => {
      if (!first) return { status: 503 };
      first = false;
      return { hang: true };
    };
    const other = startFakeBitbucket({ routes: { [key("GET", DASHBOARD_PATH)]: page([]) } });
    const from = fake.requests.length;
    try {
      const running = h.engine.syncNow();
      await until(() => !first);
      expect((await put(h.settings, { baseUrl: other.url, token: FAKE_TOKEN })).status).toBe(200);
      fake.release();
      await running;
    } finally {
      other.stop();
    }
    return fake.requests.slice(from);
  }

  test("a settings change during a comment fetch sends no request for the next PR to the old origin", async () => {
    world.reviewer = [reviewPr()];
    const h = await setup();
    await h.cycle();
    const sent = await switchDuring(h, REVIEW_ACTIVITIES);
    expect(sent.filter((r) => !r.startsWith(`GET ${DASHBOARD_PATH}`))).toEqual([`GET ${REVIEW_ACTIVITIES}?limit=50&start=0`]);
  });

  test("a settings change during the off-dashboard step sends no further PR request to the old origin", async () => {
    world.reviewer = [reviewPr()];
    const h = await setup();
    await h.cycle();
    world.reviewer = [];
    world.author = [];
    const sent = await switchDuring(h, REVIEW_PR_PATH);
    expect(sent.filter((r) => !r.startsWith(`GET ${DASHBOARD_PATH}`))).toEqual([`GET ${REVIEW_PR_PATH}`]);
  });

  test("POST /api/sync starts a cycle and returns the status", async () => {
    const h = await setup();
    const session = "s".repeat(64);
    const app = createApp({ port: 7317, token: session, live: createLive(), settings: h.settings, sync: h.engine });
    const res = await app.request("http://127.0.0.1:7317/api/sync", {
      method: "POST",
      headers: { host: "127.0.0.1:7317", origin: "http://127.0.0.1:7317", "x-rl-session": session },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ running: true });
    await until(() => !h.engine.status().running);
    expect(requests(0, `GET ${DASHBOARD_PATH}`)).toHaveLength(2);
  });

  test("an unreadable CA file gives state error and pauses until the settings change", async () => {
    const h = await setup(undefined, { caFile: join(root, "missing-ca.pem") });
    const quiet = spyOn(console, "log").mockImplementation(() => {});
    try {
      h.engine.start();
      await h.timers.fire();
    } finally {
      quiet.mockRestore();
    }
    expect(h.engine.status()).toMatchObject({ state: "error", nextAt: null, error: expect.stringContaining("CA file") });
    expect(h.timers.pending.size).toBe(0);
    expect(fake.requests).toEqual([]);
    expect((await put(h.settings, { baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    await h.timers.fire();
    expect(h.engine.status()).toMatchObject({ state: "ok", error: null });
  });

  test("a memory-mode restart without a token gives unconfigured, and a token PUT resumes polling", async () => {
    const h = await setup(undefined, { token: false });
    h.engine.start();
    await h.timers.fire();
    expect(h.engine.status()).toMatchObject({ state: "unconfigured", nextAt: null });
    expect(h.timers.pending.size).toBe(0);
    expect(fake.requests).toEqual([]);
    expect((await put(h.settings, { baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    expect(h.timers.pending.size).toBe(1);
    await h.timers.fire();
    expect(h.engine.status().state).toBe("ok");
    expect(requests(0, "role=REVIEWER")).toHaveLength(1);
    expect(h.timers.pending.size).toBe(1);
  });

  test("without settings the engine sends no request and pauses", async () => {
    const settings = createSettings({ dir: join(root, `empty-${n++}`), secrets: createSecrets(null) });
    const timers = fakeTimers();
    const engine = createSyncEngine({ settings, live: createLive(), timers });
    engine.start();
    await timers.fire();
    expect(engine.status()).toMatchObject({ state: "unconfigured", nextAt: null });
    expect(timers.pending.size).toBe(0);
    expect(fake.requests).toEqual([]);
  });
});

describe("merge result (docs/plans/review-v2/spec.md section 6.18.5)", () => {
  test("the sync stores properties.mergeResult of a PR as JSON; a PR without it stores NULL", async () => {
    // The properties of the sanitized dashboard fixture with the outcome of a PR with conflicts. Gate G18 has not verified CONFLICTED.
    const page = fixture<{ values: { properties?: Record<string, unknown> }[] }>("dashboard-pull-requests-page.json").body;
    const recorded = page.values.find((v) => v.properties?.mergeResult)?.properties;
    expect(recorded?.mergeResult).toEqual({ outcome: "CLEAN", current: true });
    const pr = ownPr();
    pr.properties = { ...recorded, mergeResult: { outcome: MERGE_CONFLICTED, current: true } };
    world.author = [pr];
    const h = await setup();
    await h.cycle();
    const stored = () =>
      (
        h.db().query("SELECT m.merge_result FROM pr_merge_result m JOIN pull_request p ON p.id = m.pr WHERE p.pr_id = 2").get() as {
          merge_result: string | null;
        }
      ).merge_result;
    expect(JSON.parse(stored() as string)).toEqual({ outcome: "CONFLICTED", current: true });
    world.author = [ownPr()];
    await h.cycle();
    expect(stored()).toBeNull();
  });
});

// Plan v3 WP4 on the Gate v3 fixtures.
describe("forge data", () => {
  const COMMITS = `${PR_PATH}/commits`;
  const CHANGES = `${PR_PATH}/changes`;
  const HEAD = ownPr().fromRef.latestCommit;
  const TARGET = (ownPr().toRef as { latestCommit: string }).latestCommit;
  const NEXT = "f".repeat(40);
  const v3 = () => activities("activities-v3-after-write.json");
  const serveMeta = () => {
    fake.routes[key("GET", COMMITS)] = fixture("pull-request-commits-page.json");
    fake.routes[key("GET", CHANGES)] = fixture("pull-request-changes.json");
  };
  const pushed = () => {
    const pr = ownPr();
    pr.fromRef.latestCommit = NEXT;
    world.author = [pr];
  };
  const detail = (h: Awaited<ReturnType<typeof setup>>) => prDetail(h.db(), FAKE_USER, h.pr(2).id as number);

  test("commits and changes load once per head change", async () => {
    serveMeta();
    const h = await setup();
    await h.cycle();
    expect(detail(h)?.commits).toEqual([{ hash: HEAD, message: "Sample commit 14.", author: "Jane Doe", at: 1791569802000 }]);
    expect(detail(h)?.files).toEqual([{ path: "sample1.md", srcPath: null, type: "MODIFY" }]);
    expect(h.pr(2).meta_head).toBe(`${HEAD}:${TARGET}`);
    const from = fake.requests.length;
    await h.cycle();
    expect(requests(from, "/commits")).toEqual([]);
    expect(requests(from, "/changes")).toEqual([]);
    pushed();
    await h.cycle();
    expect(requests(from, "/commits")).toHaveLength(1);
    expect(requests(from, "/changes")).toHaveLength(1);
    expect(h.pr(2).meta_head).toBe(`${NEXT}:${TARGET}`);
  });

  test("a partial commits fetch changes nothing, and the comments still sync", async () => {
    serveMeta();
    const h = await setup();
    await h.cycle();
    const [commit] = fixture<{ values: unknown[] }>("pull-request-commits-page.json").body.values;
    fake.routes[key("GET", COMMITS, 0)] = { status: 200, body: { isLastPage: false, nextPageStart: 1, start: 0, values: [commit] } };
    fake.routes[key("GET", COMMITS, 1)] = { status: 500, body: { errors: [{ message: "Internal error." }] } };
    pushed();
    world.own = addReply(v3(), 1000005, 1000010, OTHER);
    const before = detail(h);
    await h.cycle();
    expect(h.pr(2).meta_head).toBe(`${HEAD}:${TARGET}`);
    expect(detail(h)?.commits).toEqual(before?.commits);
    expect(detail(h)?.files).toEqual(before?.files);
    expect(h.comment(1000010)).toMatchObject({ parent_id: 1000005, root_id: 1000005 });
    expect(h.checkpoint(2)).toMatchObject({ incomplete_reason: null });
  });

  test("U14: a resolve raises the version with no new activity, and the task turns done", async () => {
    const resolved = byUser(v3(), 1000008, OTHER);
    const open = clone(resolved);
    const task = findComment(open, 1000008);
    Object.assign(task, { version: 0, state: "OPEN", resolvedDate: undefined, resolver: undefined });
    world.own = open;
    const h = await setup();
    await h.cycle();
    const at = () => detail(h)?.comments.find((c) => c.id === 1000008);
    expect(at()).toMatchObject({ task: "open", version: 0, unread: false });
    world.own = resolved;
    await h.cycle();
    expect(at()).toMatchObject({ task: "done", version: 1, unread: true });
    expect(h.events()).toEqual([]);
  });

  test("the detail holds the excerpt of an inline root, and no reply holds an anchor (U16)", async () => {
    world.own = v3();
    const h = await setup();
    await h.cycle();
    const c = (id: number) => detail(h)?.comments.find((x) => x.id === id);
    // Gate v3 U4: the CONTEXT anchor `line 7` names the row source 7 / destination 9.
    expect(c(1000005)?.excerpt?.find((l) => l.hit)).toEqual({ n: 9, kind: "ctx", text: "sample line 36", hit: true });
    expect(c(1000004)?.task).toBeUndefined();
    for (const id of [1000006, 1000007]) {
      expect(c(id)?.anchor).toBeNull();
      expect(c(id)?.excerpt).toBeUndefined();
    }
  });

  test("rows stored before 006_forge.sql get the task and the excerpt at the same version", async () => {
    world.own = v3();
    const h = await setup();
    await h.cycle();
    h.db().run("UPDATE comment SET severity = NULL, task_state = NULL, excerpt_json = NULL");
    await h.cycle();
    expect(h.comment(1000008)).toMatchObject({ severity: "BLOCKER", task_state: "RESOLVED" });
    expect(h.comment(1000004)).toMatchObject({ excerpt_json: expect.stringContaining('"hit":true') });
    expect(h.unread()).toBe(0);
  });
});

describe("branch links", () => {
  type Ref = { repository: { links: unknown } };
  const self = (href: string) => ({ self: [{ href }] });

  test("each cycle stores the branch pages from the repository link of each ref; a link of another host stores null", async () => {
    const own = ownPr() as ReturnType<typeof ownPr> & { fromRef: Ref; toRef: Ref };
    // A PR from a fork: the source repository is another one.
    own.fromRef.repository.links = self(`${fake.url}/users/asmith/repos/sample-repo-1/browse`);
    own.toRef.repository.links = self(`${fake.url}/users/jdoe/repos/sample-repo-1/browse`);
    world.author = [own];
    const h = await setup();
    const link = () =>
      h.db().query("SELECT l.source_url, l.target_url FROM pr_branch_link l JOIN pull_request p ON p.id = l.pr WHERE p.pr_id = 2").get();
    await h.cycle();
    expect(link()).toEqual({
      source_url: `${fake.url}/users/asmith/repos/sample-repo-1/browse?at=refs%2Fheads%2Ftopic%2Fsample-1`,
      target_url: `${fake.url}/users/jdoe/repos/sample-repo-1/browse?at=refs%2Fheads%2Ftopic%2Fsample-2`,
    });
    own.toRef.repository.links = self("https://elsewhere.example.test/users/jdoe/repos/sample-repo-1/browse");
    await h.cycle();
    expect(link()).toMatchObject({ target_url: null });
  });
});
