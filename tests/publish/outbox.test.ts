// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan v3 WP13a: the outbox, reply posts, and confirm. The app runs in-process against the fake Bitbucket on 127.0.0.1.
// No test reaches a real host.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { ForgeError } from "../../src/server/bitbucket/client";
import { createBitbucketProvider } from "../../src/server/bitbucket/provider";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { createOutbox, type Outbox } from "../../src/server/publish/outbox";
import { AI_MARK } from "../../src/server/publish/plan";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { createSyncEngine } from "../../src/server/sync/engine";
import type {
  ConfirmDto,
  ItemConflict,
  PostDto,
  PostPlanDto,
  PrDetail,
  ReplyConflict,
  ReviewItemDto,
  ThreadResolveError,
} from "../../src/shared/dto";
import type { ExcerptLine } from "../../src/shared/review";
import { FAKE_TOKEN, FAKE_USER, key, type Reply, type Route, startFakeBitbucket } from "../support/fake-bitbucket";
import {
  ACTIVITIES_PATH,
  type Activity,
  activities,
  addReply,
  byUser,
  commentPosts,
  DASHBOARD_PATH,
  findComment,
  onePage,
  ownPr,
  PR_PATH,
  PR_REF,
  secondUser,
} from "../support/scenarios";

process.env.REVIEW_LOOP_SECRETS = "memory";
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS: Record<string, string> = {
  host: `127.0.0.1:${PORT}`,
  origin: ORIGIN,
  "x-rl-session": SESSION,
  "content-type": "application/json",
};
const ROOT = 1000003;
// The newest message of the thread: a reply by another user under the token owner's comment.
const THEIRS = 1000020;
const FIRST_ID = 4_000_001;
const OTHER = secondUser();
const ME = findComment(activities("activities-nested-reply.json"), ROOT).author;
const KEY = "0b7c3a52-9d4e-4f61-8a2b-3c5d7e9f1a20";
const TEXT = "Fixed in the next commit.";
const COMMENTS = `POST ${PR_PATH}/comments`;
const SOURCE = ownPr().fromRef.latestCommit;
const TARGET = (ownPr() as unknown as { toRef: { latestCommit: string } }).toRef.latestCommit;
const ok = (body: unknown): Reply => ({ status: 200, body });
const refuse = (status: number): Reply => ({ status, body: { errors: [{ message: "Refused." }] } });

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function thread(): Activity[] {
  const list = addReply(activities("activities-nested-reply.json"), ROOT, THEIRS, OTHER, "Can you check the flush order?");
  Object.assign(findComment(list, THEIRS), { createdDate: 1791571358000, updatedDate: 1791571358000 });
  return list;
}

async function setup(mark = false) {
  const world = { pr: ownPr(), list: thread };
  const posts = commentPosts(PR_PATH, () => world.list(), ME, FIRST_ID);
  const fake = startFakeBitbucket({
    routes: {
      [key("GET", DASHBOARD_PATH)]: (req) => ok(onePage(new URL(req.url).searchParams.get("role") === "AUTHOR" ? [world.pr] : [])),
      [key("GET", PR_PATH)]: () => ok(world.pr),
      [key("GET", ACTIVITIES_PATH)]: () => ok(onePage(posts.activities())),
      ...posts.routes,
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "rl-wp13-"));
  writeConfig(dir, {
    baseUrl: fake.url,
    userSlug: FAKE_USER,
    notifications: false,
    markSeverity: false,
    ...(mark ? {} : { markAi: false }),
  });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const live = createLive();
  const sync = createSyncEngine({ settings, live });
  // A runner command that never runs: no test starts a review.
  const review = createReviewJobs({ settings, live, dataDir: dir, runnerCommand: [process.execPath, "--version"] });
  const make = () => {
    const outbox = createOutbox({ settings, live });
    return { outbox, app: createApp({ port: PORT, token: SESSION, live, settings, sync, review, outbox }) };
  };
  let cur: { outbox: Outbox; app: ReturnType<typeof createApp> } = make();
  cleanup.push(async () => {
    await cur.outbox.stop();
    sync.stop();
    settings.close();
    fake.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await sync.syncNow();
  const db = settings.db() as Database;
  const { id: pr } = db.query("SELECT id FROM pull_request WHERE pr_id = $id").get({ id: PR_REF.id }) as { id: number };

  const call = async <T>(path: string, body?: unknown, headers = HEADERS) => {
    const res = await cur.app.request(`${ORIGIN}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json as T };
  };
  const reply = (o: Record<string, unknown> = {}) =>
    call<PostDto & ReplyConflict>(`/api/prs/${pr}/replies`, { parentId: THEIRS, body: TEXT, seen: THEIRS, key: KEY, ...o });
  const plan = async () => (await call<PostPlanDto>(`/api/prs/${pr}/post-plan`)).body.posts;
  const markAi = async (on: boolean) => {
    const res = await cur.app.request(`${ORIGIN}/api/settings`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ baseUrl: fake.url, markAi: on }),
    });
    expect(res.status).toBe(200);
  };
  return {
    world,
    posts,
    fake,
    sync,
    db,
    pr,
    call,
    reply,
    plan,
    markAi,
    list: async () => (await call<PostDto[]>(`/api/prs/${pr}/posts`)).body,
    sent: () => fake.requests.filter((r) => r === COMMENTS).length,
    settle: () => cur.outbox.wait(),
    // A new process on the same data folder.
    async restart() {
      await cur.outbox.stop();
      cur = make();
      cur.outbox.start();
    },
  };
}
type S = Awaited<ReturnType<typeof setup>>;

// New side: 1 is outside the diff, 2 is hunk context (old line 2), 3 is added.
const EXCERPT: ExcerptLine[] = [
  { n: 1, kind: "ctx", text: "a" },
  { n: 2, kind: "ctx", text: "b", hunk: true, old: 2 },
  { n: 3, kind: "add", text: "c2" },
];
// New lines 5 and 6 are added, so hunk context new 7 is old 5 and new 8 is old 6.
const CTX_EXCERPT: ExcerptLine[] = [
  { n: 5, kind: "add", text: "e" },
  { n: 6, kind: "add", text: "f" },
  { n: 7, kind: "ctx", text: "g", hunk: true, old: 5 },
  { n: 8, kind: "ctx", text: "h", hunk: true, old: 6 },
];

// A completed review run on the given heads. item() adds a finding at a line, or a question for a null line.
function seedRun(s: S, heads = { source: SOURCE, target: TARGET }) {
  const { id: run } = s.db
    .query(
      `INSERT INTO review_run (pr, profile, note, idem_key, source_head, target_head, merge_base, status, started_at, finished_at)
      VALUES ($pr, 'general', '', 'k', $s, $t, $t, 'completed', 1, 2) RETURNING id`,
    )
    .get({ pr: s.pr, s: heads.source, t: heads.target }) as { id: number };
  const item = (body: string, line: number | null, state: "exact" | "outside" = "exact", excerpt = EXCERPT) => {
    const finding = line !== null;
    const payload = finding
      ? {
          path: "src/app.ts",
          side: "new",
          line,
          lineEnd: null,
          anchorText: "x",
          severity: "minor",
          category: "naming",
          body,
          evidence: "",
          evidenceStatus: "code",
          confidence: "high",
          agent: null,
          anchor: { state, path: "src/app.ts", oldPath: null, line, lineEnd: line, excerpt },
        }
      : { text: body, why: "Why." };
    return (
      s.db
        .query(
          `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, anchor_state, excerpt_json)
          VALUES ($run, $kind, $payload, $body, $path, $side, $line, $line, $state, $excerpt) RETURNING id`,
        )
        .get({
          run,
          kind: finding ? "finding" : "question",
          payload: JSON.stringify(payload),
          body,
          path: finding ? "src/app.ts" : null,
          side: finding ? "new" : null,
          line,
          state: finding ? state : null,
          excerpt: finding ? JSON.stringify(excerpt) : null,
        }) as { id: number }
    ).id;
  };
  return { run, item };
}

// A completed reply run with one reply draft to the given message. body "": a draft without reply text. extra: more payload fields.
function seedReply(s: S, replyTo: number, body = "Reply text.", extra: Record<string, unknown> = {}) {
  const { id: run } = s.db
    .query(
      `INSERT INTO review_run (pr, profile, note, idem_key, source_head, target_head, merge_base, status, started_at, finished_at, kind)
      VALUES ($pr, 'general', '', $k, $s, $t, $t, 'completed', 1, 2, 'reply') RETURNING id`,
    )
    .get({ pr: s.pr, k: `r${replyTo}`, s: SOURCE, t: TARGET }) as { id: number };
  const payload = { thread: ROOT, action: body ? "reply" : "none", body, reason: "R.", evidenceStatus: "code", replyTo, ...extra };
  return (
    s.db
      .query(
        `INSERT INTO review_item (run, kind, payload_json, body, thread) VALUES ($run, 'reply', $payload, $body, $thread) RETURNING id`,
      )
      .get({ run, payload: JSON.stringify(payload), body, thread: ROOT }) as { id: number }
  ).id;
}

// Ticks "Resolve after posting" on a new draft, then accepts it. The item ends at revision 2.
async function tick(s: S, id: number) {
  expect((await s.call<ReviewItemDto>(`/api/items/${id}`, { action: "resolve", revision: 0, resolve: true })).status).toBe(200);
  expect((await s.call<ReviewItemDto>(`/api/items/${id}`, { action: "accept", revision: 1 })).status).toBe(200);
}

async function accept(s: S, ...ids: number[]) {
  for (const id of ids) expect((await s.call<ReviewItemDto>(`/api/items/${id}`, { action: "accept", revision: 0 })).status).toBe(200);
}
// An accept from before a newer message arrived. items.ts refuses an accept of an out-of-date draft.
const acceptedBefore = (s: S, ...ids: number[]) => {
  for (const id of ids) s.db.query("UPDATE review_item SET status = 'accepted', revision = revision + 1 WHERE id = $id").run({ id });
};
const OUT_OF_DATE = "New messages arrived after this draft. Draft it again, or reply to the newest as is.";
const itemsOf = (posts: PostPlanDto["posts"]) => posts.flatMap((p) => p.items);
const itemRow = (s: S, id: number) =>
  s.db.query("SELECT status, revision, anchor_state FROM review_item WHERE id = $id").get({ id }) as {
    status: string;
    revision: number;
    anchor_state: string | null;
  };

describe("reply posts", () => {
  test("a reply sends one POST with text and parent; the same key twice sends one POST", async () => {
    const s = await setup();
    const first = await s.reply();
    expect(first.status).toBe(202);
    expect([first.body.state, first.body.run, first.body.destination]).toEqual(["pending", null, { kind: "reply", parentId: THEIRS }]);
    const again = await s.reply();
    expect([again.status, again.body.id]).toEqual([200, first.body.id]);
    await s.settle();
    expect(s.posts.bodies).toEqual([{ text: TEXT, parent: { id: THEIRS } }]);
    expect(s.sent()).toBe(1);
    const [post] = await s.list();
    expect(post).toMatchObject({
      id: first.body.id,
      state: "confirmed",
      remoteId: FIRST_ID,
      remoteVersion: 0,
      attempts: 1,
      lastError: null,
    });
    // The key is spent: another text under it never posts.
    expect((await s.reply({ body: "Other text." })).status).toBe(409);
    expect((await s.reply()).status).toBe(200);
    await s.settle();
    expect(s.sent()).toBe(1);
  });

  test("a stale seen gives 409 with the newest message and no POST", async () => {
    const s = await setup();
    const r = await s.reply({ seen: 1000001 });
    expect(r.status).toBe(409);
    expect(r.body.newest).toBe(THEIRS);
    // A reply to an older message of the thread checks the newest message of the whole thread.
    expect((await s.reply({ parentId: ROOT, seen: 1000001 })).status).toBe(409);
    expect((await s.reply({ parentId: 999 })).status).toBe(404);
    expect((await s.reply({ key: "not-a-uuid" })).status).toBe(400);
    expect((await s.reply({ body: "   " })).status).toBe(400);
    s.db.query("UPDATE comment SET tombstoned_at = 1 WHERE comment_id = $id").run({ id: THEIRS });
    expect((await s.reply({ parentId: THEIRS, seen: 1000001 })).status).toBe(409);
    await s.settle();
    expect(s.sent()).toBe(0);
    expect(await s.list()).toEqual([]);
  });

  test("a parent deleted on the server fails the reply with no POST", async () => {
    const s = await setup();
    s.fake.routes[key("GET", `${PR_PATH}/comments/${THEIRS}`)] = refuse(404);
    expect((await s.reply()).status).toBe(202);
    await s.settle();
    const [post] = await s.list();
    expect(post?.state).toBe("failed");
    expect(post?.lastError).toContain("deleted");
    expect(post?.attempts).toBe(0);
    expect(s.fake.requests).toContain(`GET ${PR_PATH}/comments/${THEIRS}`);
    expect(s.sent()).toBe(0);
  });

  test("a 4xx fails with no retry; post again and drop are user actions", async () => {
    const s = await setup();
    s.fake.routes[key("POST", `${PR_PATH}/comments`)] = refuse(400);
    const { body } = await s.reply();
    await s.settle();
    const [post] = await s.list();
    expect([post?.state, post?.lastError, post?.attempts]).toEqual(["failed", "Bitbucket refused the comment (HTTP 400).", 1]);
    expect(s.sent()).toBe(1);
    expect((await s.call(`/api/posts/${body.id}/drop`, {})).status).toBe(200);
    expect(await s.list()).toEqual([]);
    expect((await s.call(`/api/posts/${body.id}/retry`, {})).status).toBe(404);
  });

  test("A9: accept-then-drop gives unknown; the check matches author, exact text, and parent; no second POST", async () => {
    const s = await setup();
    s.posts.drop = true;
    // The first check cannot read the comments, so the row stays unknown.
    s.fake.routes[key("GET", ACTIVITIES_PATH)] = refuse(503);
    const { body } = await s.reply();
    await s.settle();
    const [unknown] = await s.list();
    expect([unknown?.state, unknown?.checking, unknown?.attempts]).toEqual(["unknown", false, 1]);
    expect(unknown?.lastError).toContain("Could not read all comments");
    expect(s.sent()).toBe(1);

    s.fake.routes[key("GET", ACTIVITIES_PATH)] = () => ok(onePage(s.posts.activities()));
    const r = await s.call<PostDto>(`/api/posts/${body.id}/retry`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, attempts: 1 });
    await s.settle();
    expect(s.sent()).toBe(1);
  });

  test("A9: the sender checks an unknown post at once and confirms it", async () => {
    const s = await setup();
    s.posts.drop = true;
    await s.reply();
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, attempts: 1, lastError: null, checking: false });
    expect(s.sent()).toBe(1);
  });

  test("no match leaves unknown; post again sends once more; other authors, texts, and parents never match", async () => {
    const s = await setup();
    // Decoys: the same text by another user under the parent, and my text under another parent.
    s.world.list = () => addReply(addReply(thread(), THEIRS, 1000030, OTHER, TEXT), ROOT, 1000031, ME, TEXT);
    // Once: the connection drops before the server stores the comment.
    const postKey = key("POST", `${PR_PATH}/comments`);
    const store = s.fake.routes[postKey] as Route;
    s.fake.routes[postKey] = () => {
      s.fake.routes[postKey] = store;
      return { drop: true };
    };
    const { body } = await s.reply();
    await s.settle();
    let [post] = await s.list();
    expect([post?.state, post?.lastError]).toEqual(["unknown", "No matching comment on Bitbucket. Post again or drop."]);
    const r = await s.call<PostDto>(`/api/posts/${body.id}/retry`, {});
    expect([r.status, r.body.state]).toEqual([202, "pending"]);
    await s.settle();
    [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, attempts: 2 });
    expect(s.sent()).toBe(2);
    expect((await s.call(`/api/posts/${body.id}/retry`, {})).status).toBe(409);
    expect((await s.call(`/api/posts/${body.id}/drop`, {})).status).toBe(409);
  });

  test("at start a sent post becomes unknown, and the check confirms it with no second POST", async () => {
    const s = await setup();
    await s.reply();
    await s.settle();
    // The app stopped after the request went out and before the answer was stored.
    s.db.run("UPDATE post SET state = 'sent', remote_id = NULL, remote_version = NULL");
    await s.restart();
    expect((s.db.query("SELECT state FROM post").get() as { state: string }).state).toBe("unknown");
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, attempts: 1 });
    expect(s.sent()).toBe(1);
  });

  test("my reply syncs back as read, with no notification and the posted mark", async () => {
    const s = await setup();
    await s.reply();
    await s.settle();
    await s.sync.syncNow();
    const row = s.db.query("SELECT version, ack_version, parent_id FROM comment WHERE comment_id = $id").get({ id: FIRST_ID }) as {
      version: number;
      ack_version: number;
      parent_id: number;
    };
    expect(row).toEqual({ version: 0, ack_version: 0, parent_id: THEIRS });
    expect(s.db.query("SELECT COUNT(*) AS n FROM event").get()).toEqual({ n: 0 });
    const detail = (await s.call<PrDetail>(`/api/prs/${s.pr}`)).body;
    expect(detail.comments.find((c) => c.id === FIRST_ID)).toMatchObject({ unread: false, posted: "reply", text: TEXT });
    expect(detail.comments.find((c) => c.id === THEIRS)?.posted).toBeUndefined();
  });

  test("the guard refuses every outbox mutation without the session header", async () => {
    const s = await setup();
    const { "x-rl-session": _, ...noSession } = HEADERS;
    for (const [path, body] of [
      [`/api/prs/${s.pr}/replies`, { parentId: THEIRS, body: TEXT, seen: THEIRS, key: KEY }],
      [`/api/prs/${s.pr}/confirm`, { items: [{ id: 1, revision: 0 }] }],
      ["/api/posts/1/retry", {}],
      ["/api/posts/1/drop", {}],
      [`/api/prs/${s.pr}/resolve`, { thread: ROOT, resolved: true, seen: THEIRS }],
      ["/api/posts/1/resolve", {}],
    ] as const)
      expect((await s.call(path, body, noSession)).status).toBe(403);
    await s.settle();
    expect(s.sent()).toBe(0);
    expect(s.posts.puts).toEqual([]);
    expect(await s.list()).toEqual([]);
  });

  test("no token in rows, logs, or URLs", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    cleanup.push(() => spy.mockRestore());
    const s = await setup();
    s.posts.drop = true;
    s.fake.routes[key("GET", ACTIVITIES_PATH)] = refuse(500);
    await s.reply();
    await s.reply({ key: "4f2d8c1e-6a3b-4e5f-9b7a-1c2d3e4f5a6b", body: "Second." });
    await s.settle();
    const rows = JSON.stringify(s.db.query("SELECT * FROM post").all());
    expect(rows).toContain("unknown");
    for (const text of [rows, lines.join("\n"), s.fake.requests.join("\n")]) expect(text).not.toContain(FAKE_TOKEN);
  });

  test("createComment never repeats a POST; a timeout is a ForgeError", async () => {
    const fake = startFakeBitbucket({ routes: { [key("POST", `${PR_PATH}/comments`)]: { hang: true } } });
    cleanup.push(() => fake.stop());
    const p = createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN, timeoutMs: 200 });
    const e = await p.createComment(PR_REF, { text: TEXT }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ForgeError);
    expect((e as ForgeError).kind).toBe("timeout");
    expect(fake.requests).toEqual([COMMENTS]);
  });
});

describe("confirm", () => {
  test("posts the plan once: the inline anchor body, the general text, and A14 two confirms give one POST each", async () => {
    const s = await setup();
    const { item } = seedRun(s);
    const ids = [item("Inline text.", 3), item("Outside text.", 1, "outside"), item("Q?", null)];
    await accept(s, ...ids);
    const plan = await s.plan();
    expect(plan.map((p) => p.destination.kind)).toEqual(["inline", "general"]);
    const items = itemsOf(plan);
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items });
    expect(r.status).toBe(202);
    expect(r.body.warning).toBeNull();
    expect(r.body.posts.map((p) => [p.state, p.body])).toEqual([
      ["pending", "Inline text."],
      ["pending", "src/app.ts:1: Outside text.\n\nQ? Why."],
    ]);
    await s.settle();
    expect(s.posts.bodies).toEqual([
      {
        text: "Inline text.",
        anchor: { path: "src/app.ts", line: 3, lineType: "ADDED", fileType: "TO", diffType: "COMMIT", fromHash: TARGET, toHash: SOURCE },
      },
      { text: "src/app.ts:1: Outside text.\n\nQ? Why." },
    ]);
    expect((await s.list()).map((p) => [p.state, p.remoteId])).toEqual([
      ["confirmed", FIRST_ID],
      ["confirmed", FIRST_ID + 1],
    ]);
    expect(ids.map((id) => itemRow(s, id).status)).toEqual(["posted", "posted", "posted"]);
    expect(await s.plan()).toEqual([]);

    const again = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items });
    expect(again.status).toBe(200);
    expect(again.body.posts.map((p) => p.id)).toEqual(r.body.posts.map((p) => p.id));
    await s.settle();
    expect(s.sent()).toBe(2);

    await s.sync.syncNow();
    const detail = (await s.call<PrDetail>(`/api/prs/${s.pr}`)).body;
    expect(detail.comments.filter((c) => c.posted === "run").map((c) => c.id)).toEqual([FIRST_ID, FIRST_ID + 1]);
  });

  test("a new source head blocks the post; a moved target head warns (D2)", async () => {
    const s = await setup();
    const { item } = seedRun(s);
    const id = item("Inline text.", 3);
    await accept(s, id);
    const items = itemsOf(await s.plan());
    s.world.pr.fromRef.latestCommit = "f".repeat(40);
    const blocked = await s.call<{ error: string }>(`/api/prs/${s.pr}/confirm`, { items });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("new commits");
    expect(await s.list()).toEqual([]);
    expect(itemRow(s, id).status).toBe("accepted");

    s.world.pr.fromRef.latestCommit = SOURCE;
    (s.world.pr as unknown as { toRef: { latestCommit: string } }).toRef.latestCommit = "e".repeat(40);
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items });
    expect(r.status).toBe(202);
    expect(r.body.warning).toContain("target branch moved");
    await s.settle();
    // The anchor stays on the reviewed commits.
    expect(s.posts.bodies[0]?.anchor).toMatchObject({ fromHash: TARGET, toHash: SOURCE });
    expect(s.sent()).toBe(1);
  });

  test("D14: a reply item ignores a new source head; an inline item in the same confirm still gets the head error", async () => {
    const s = await setup();
    const { item } = seedRun(s);
    const inline = item("Inline text.", 3);
    const reply = seedReply(s, THEIRS);
    await accept(s, inline, reply);
    s.world.pr.fromRef.latestCommit = "f".repeat(40);
    const both = await s.call<{ error: string }>(`/api/prs/${s.pr}/confirm`, {
      items: [
        { id: inline, revision: 1 },
        { id: reply, revision: 1 },
      ],
    });
    expect(both.status).toBe(409);
    expect(both.body.error).toContain("new commits");
    expect([itemRow(s, inline).status, itemRow(s, reply).status]).toEqual(["accepted", "accepted"]);

    const items = [{ id: reply, revision: 1 }];
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items });
    expect(r.status).toBe(202);
    expect(r.body.posts.map((p) => p.destination)).toEqual([{ kind: "reply", parentId: THEIRS }]);
    expect((await s.call(`/api/prs/${s.pr}/confirm`, { items })).status).toBe(200);
    await s.settle();
    expect(s.sent()).toBe(1);
    expect(s.posts.bodies[0]).toMatchObject({ text: "Reply text.", parent: { id: THEIRS } });

    await s.sync.syncNow();
    const detail = (await s.call<PrDetail>(`/api/prs/${s.pr}`)).body;
    expect(detail.comments.find((c) => c.text === "Reply text.")?.posted).toBe("draft");
  });

  test("D14: a reply item to an older message or a deleted parent is out of date: the plan leaves it out, and a confirm of it gives 409", async () => {
    const s = await setup();
    const older = seedReply(s, ROOT);
    const gone = seedReply(s, 999);
    acceptedBefore(s, older, gone);
    const plan = (await s.call<PostPlanDto>(`/api/prs/${s.pr}/post-plan`)).body;
    expect(plan.posts).toEqual([]);
    expect(plan.blocked).toEqual([
      { item: older, revision: 1, thread: ROOT, reason: "out-of-date" },
      { item: gone, revision: 1, thread: ROOT, reason: "out-of-date" },
    ]);
    for (const id of [older, gone]) {
      const r = await s.call<{ error: string }>(`/api/prs/${s.pr}/confirm`, { items: [{ id, revision: 1 }] });
      expect([r.status, r.body.error]).toEqual([409, "A draft in the list cannot post now. The new list shows why."]);
    }
    expect(await s.list()).toEqual([]);
    expect(s.sent()).toBe(0);
    expect([itemRow(s, older).status, itemRow(s, gone).status]).toEqual(["accepted", "accepted"]);
  });

  test("P9: accept, edit, and plain refuse an out-of-date draft; the tick, discard, restore, and Undo accept work", async () => {
    const s = await setup();
    const act = (id: number, body: Record<string, unknown>) => s.call<ItemConflict>(`/api/items/${id}`, body);
    const older = seedReply(s, ROOT);
    const gone = seedReply(s, 999);
    const fixed = seedReply(s, ROOT, "Fixed in aaaaaaa.", { fix: { id: 1, commit: "a".repeat(40) } });
    for (const [id, body] of [
      [older, { action: "accept", revision: 0 }],
      [older, { action: "edit", revision: 0, body: "New text." }],
      [gone, { action: "accept", revision: 0 }],
      [fixed, { action: "plain", revision: 0 }],
    ] as const) {
      const r = await act(id, body);
      expect([r.status, r.body.error, r.body.item.status, r.body.item.revision]).toEqual([409, OUT_OF_DATE, "new", 0]);
    }
    expect(itemRow(s, older)).toMatchObject({ status: "new", revision: 0 });
    expect(s.db.query("SELECT body, edited FROM review_item WHERE id = $id").get({ id: older })).toEqual({
      body: "Reply text.",
      edited: 0,
    });

    // The actions that approve nothing stay open. A draft accepted before the newer message keeps Undo accept.
    expect((await act(older, { action: "resolve", revision: 0, resolve: true })).status).toBe(200);
    acceptedBefore(s, gone);
    expect((await act(gone, { action: "restore", revision: 1 })).status).toBe(200);
    expect(itemRow(s, gone).status).toBe("new");
    // One open draft per thread: Restore of older needs the other two discarded.
    for (const [id, revision] of [
      [gone, 2],
      [fixed, 0],
      [older, 1],
    ] as const)
      expect((await act(id, { action: "discard", revision })).status).toBe(200);
    expect((await act(older, { action: "restore", revision: 2 })).status).toBe(200);
    expect(itemRow(s, older)).toMatchObject({ status: "new", revision: 3 });
    // A draft to the newest message accepts.
    await accept(s, seedReply(s, THEIRS));
  });

  test("thread outcome: confirm posts the shown drafts and leaves a blocked one out; the same set again posts nothing twice", async () => {
    const s = await setup();
    const { item } = seedRun(s);
    const inline = item("Inline text.", 3);
    const fresh = seedReply(s, THEIRS);
    const stale = seedReply(s, ROOT, "Old reply.");
    await accept(s, inline, fresh);
    acceptedBefore(s, stale);
    const plan = (await s.call<PostPlanDto>(`/api/prs/${s.pr}/post-plan`)).body;
    expect(plan.posts.map((p) => [p.destination.kind, p.body])).toEqual([
      ["inline", "Inline text."],
      ["reply", "Reply text."],
    ]);
    expect(plan.blocked).toEqual([{ item: stale, revision: 1, thread: ROOT, reason: "out-of-date" }]);

    // The client sends the postable set it showed. The blocked draft never reaches Bitbucket.
    const shown = itemsOf(plan.posts);
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items: shown });
    expect(r.status).toBe(202);
    await s.settle();
    expect(s.posts.bodies.map((b) => b.text)).toEqual(["Inline text.", "Reply text."]);
    expect([itemRow(s, inline).status, itemRow(s, fresh).status, itemRow(s, stale).status]).toEqual(["posted", "posted", "accepted"]);

    // A14: a second confirm of the same set returns the rows of the first one.
    const again = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items: shown });
    expect(again.status).toBe(200);
    expect(again.body.posts.map((p) => p.id)).toEqual(r.body.posts.map((p) => p.id));
    // The blocked draft with the shown set is not the plan on screen.
    const mixed = await s.call<{ error: string }>(`/api/prs/${s.pr}/confirm`, { items: [{ id: stale, revision: 1 }] });
    expect([mixed.status, mixed.body.error]).toEqual([409, "A draft in the list cannot post now. The new list shows why."]);
    await s.settle();
    expect(s.sent()).toBe(2);
  });

  test("thread outcome: with nothing blocked the plan has no blocked list", async () => {
    const s = await setup();
    await accept(s, seedReply(s, THEIRS));
    const plan = (await s.call<PostPlanDto>(`/api/prs/${s.pr}/post-plan`)).body;
    expect(plan.posts).toHaveLength(1);
    expect("blocked" in plan).toBe(false);
  });

  test("stale-drafts F1: accepted drafts of a run on an older head are blocked and leave the posts; the others post; Discard clears them", async () => {
    const s = await setup();
    const old = seedRun(s, { source: "a".repeat(40), target: TARGET });
    const finding = old.item("Old text.", 3);
    const question = old.item("Old question.", null);
    const { item } = seedRun(s);
    const inline = item("Inline text.", 3);
    const reply = seedReply(s, THEIRS);
    await accept(s, finding, question, inline, reply);
    const plan = (await s.call<PostPlanDto>(`/api/prs/${s.pr}/post-plan`)).body;
    expect(plan.posts.map((p) => [p.destination.kind, p.body])).toEqual([
      ["inline", "Inline text."],
      ["reply", "Reply text."],
    ]);
    expect(plan.blocked).toEqual([
      { item: finding, revision: 1, reason: "older-commit", commit: "aaaaaaa", path: "src/app.ts", line: 3 },
      { item: question, revision: 1, reason: "older-commit", commit: "aaaaaaa" },
    ]);

    // A confirm that names a blocked draft is not the plan on screen.
    const named = await s.call<{ error: string }>(`/api/prs/${s.pr}/confirm`, {
      items: [...itemsOf(plan.posts), { id: finding, revision: 1 }],
    });
    expect([named.status, named.body.error]).toEqual([409, "A draft in the list cannot post now. The new list shows why."]);
    // The other drafts post. The live head check covers only the runs of the posts.
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items: itemsOf(plan.posts) });
    expect(r.status).toBe(202);
    await s.settle();
    expect(s.posts.bodies.map((b) => b.text)).toEqual(["Inline text.", "Reply text."]);
    expect([itemRow(s, finding).status, itemRow(s, question).status]).toEqual(["accepted", "accepted"]);

    // Discard of each blocked draft leaves nothing to post.
    for (const id of [finding, question])
      expect((await s.call<ReviewItemDto>(`/api/items/${id}`, { action: "discard", revision: 1 })).body.status).toBe("discarded");
    const after = (await s.call<PostPlanDto>(`/api/prs/${s.pr}/post-plan`)).body;
    expect([after.posts, "blocked" in after]).toEqual([[], false]);
    expect(s.sent()).toBe(2);
  });

  test("a confirm that differs from the plan gives 409 and sends nothing", async () => {
    const s = await setup();
    const { item } = seedRun(s);
    const inline = item("Inline text.", 3);
    const outside = item("Outside text.", 1, "outside");
    const question = item("Q?", null);
    await accept(s, inline, outside, question);
    const conflict = async (items: unknown, status = 409) =>
      expect((await s.call(`/api/prs/${s.pr}/confirm`, { items })).status).toBe(status);
    await conflict([{ id: inline, revision: 0 }]);
    // Half of the general comment.
    await conflict([{ id: outside, revision: 1 }]);
    await conflict([
      { id: inline, revision: 1 },
      { id: 999, revision: 0 },
    ]);
    await conflict(
      [
        { id: inline, revision: 1 },
        { id: inline, revision: 1 },
      ],
      400,
    );
    await conflict([], 400);
    // Only the inline post: the general comment stays in the plan.
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items: [{ id: inline, revision: 1 }] });
    expect(r.status).toBe(202);
    await s.settle();
    expect(s.sent()).toBe(1);
    expect((await s.plan()).map((p) => p.destination.kind)).toEqual(["general"]);
  });

  test("a 400 on a context line fails the inline post; drop with general moves the finding to the general comment", async () => {
    const s = await setup();
    const { item } = seedRun(s);
    const id = item("Context text.", 2);
    await accept(s, id);
    const plan = await s.plan();
    expect(plan[0]?.destination).toMatchObject({ kind: "inline", line: 2, lineType: "ctx", srcLine: 2 });
    s.fake.routes[key("POST", `${PR_PATH}/comments`)] = refuse(400);
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items: itemsOf(plan) });
    await s.settle();
    const [post] = await s.list();
    expect(post?.state).toBe("failed");
    expect(post?.lastError).toContain("context line");
    expect(s.sent()).toBe(1);
    const postId = r.body.posts[0]?.id as number;
    expect((await s.call(`/api/posts/${postId}/drop`, { general: "yes" })).status).toBe(400);
    expect((await s.call(`/api/posts/${postId}/drop`, { general: true })).status).toBe(200);
    expect(itemRow(s, id)).toEqual({ status: "accepted", revision: 2, anchor_state: "outside" });
    expect((await s.plan()).map((p) => [p.destination.kind, p.body])).toEqual([["general", "src/app.ts:2: Context text."]]);
    expect(await s.list()).toEqual([]);
  });

  test("U4: a context line posts its old-side line; a move by the user posts the old line of the new place", async () => {
    const s = await setup();
    const { item } = seedRun(s);
    const ctx = item("Context text.", 7, "exact", CTX_EXCERPT);
    const moved = item("Moved text.", 5, "exact", CTX_EXCERPT);
    expect((await s.call<ReviewItemDto>(`/api/items/${moved}`, { action: "move", revision: 0, line: 8 })).status).toBe(200);
    expect((await s.call(`/api/items/${moved}`, { action: "accept", revision: 1 })).status).toBe(200);
    await accept(s, ctx);
    const plan = await s.plan();
    expect(plan.map((p) => p.destination)).toEqual([
      { kind: "inline", path: "src/app.ts", srcPath: null, line: 7, lineEnd: 7, lineType: "ctx", srcLine: 5 },
      { kind: "inline", path: "src/app.ts", srcPath: null, line: 8, lineEnd: 8, lineType: "ctx", srcLine: 6 },
    ]);
    expect((await s.call(`/api/prs/${s.pr}/confirm`, { items: itemsOf(plan) })).status).toBe(202);
    await s.settle();
    expect(s.posts.bodies.map((b) => [b.text, b.anchor?.line, b.anchor?.lineType])).toEqual([
      ["Context text.", 5, "CONTEXT"],
      ["Moved text.", 6, "CONTEXT"],
    ]);
  });

  test("U4: after a dropped connection, the check matches the CONTEXT anchor on its old line, with no second POST", async () => {
    const s = await setup();
    s.posts.drop = true;
    const { item } = seedRun(s);
    const id = item("Context text.", 7, "exact", CTX_EXCERPT);
    await accept(s, id);
    expect((await s.call(`/api/prs/${s.pr}/confirm`, { items: [{ id, revision: 1 }] })).status).toBe(202);
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, attempts: 1, lastError: null });
    expect(s.posts.bodies.map((b) => b.anchor?.line)).toEqual([5]);
    expect(s.sent()).toBe(1);
  });

  test("a context-line post stored without srcLine fails with no POST", async () => {
    const s = await setup();
    const { run } = seedRun(s);
    const destination = { kind: "inline", path: "src/app.ts", srcPath: null, line: 2, lineEnd: 2, lineType: "ctx" };
    const { id } = s.db
      .query(
        `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
        VALUES ($pr, $run, 'inline', 'legacy', 'Old text.', $destination, '[]', 'failed', 1, 1) RETURNING id`,
      )
      .get({ pr: s.pr, run, destination: JSON.stringify(destination) }) as { id: number };
    expect((await s.call(`/api/posts/${id}/retry`, {})).status).toBe(202);
    await s.settle();
    const [post] = await s.list();
    expect([post?.state, post?.lastError]).toEqual([
      "failed",
      "The context line has no old line number. Move the finding to the general comment.",
    ]);
    expect(s.sent()).toBe(0);
  });
});

describe("AI mark", () => {
  test("AI posts reach Bitbucket with one mark, and an edited draft keeps it", async () => {
    const s = await setup(true);
    const { item } = seedRun(s);
    const ids = [item("Inline text.", 3), item("Outside text.", 1, "outside"), item("Q?", null)];
    await accept(s, ...ids);
    const draft = seedReply(s, THEIRS);
    expect((await s.call(`/api/items/${draft}`, { action: "edit", revision: 0, body: "Edited reply." })).status).toBe(200);
    const items = itemsOf(await s.plan());
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items });
    expect(r.status).toBe(202);
    const marked = [`${AI_MARK}Inline text.`, `${AI_MARK}src/app.ts:1: Outside text.\n\nQ? Why.`, `${AI_MARK}Edited reply.`];
    expect(r.body.posts.map((p) => p.body).sort()).toEqual([...marked].sort());
    // The outbox keeps the bytes of the confirm. A later setting change never alters them.
    await s.markAi(false);
    await s.settle();
    expect(s.posts.bodies.map((b) => b.text).sort()).toEqual([...marked].sort());
    expect((await s.list()).map((p) => [p.state, p.body]).sort()).toEqual(marked.map((b) => ["confirmed", b]).sort());
  });

  test("a manual reply never gets the mark", async () => {
    const s = await setup(true);
    const { status, body } = await s.reply();
    expect([status, body.body]).toEqual([202, TEXT]);
    await s.settle();
    expect(s.posts.bodies.map((b) => b.text)).toEqual([TEXT]);
  });

  test("a resolve-only post gets no mark and posts no comment", async () => {
    const s = await setup(true);
    const draft = seedReply(s, THEIRS, "");
    await tick(s, draft);
    expect((await s.plan()).map((p) => [p.body, p.resolve])).toEqual([["", ROOT]]);
  });

  test("A9: the check matches a marked post after a dropped connection, with no second POST", async () => {
    const s = await setup(true);
    s.posts.drop = true;
    const draft = seedReply(s, THEIRS);
    await accept(s, draft);
    const r = await s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 1 }] });
    expect(r.status).toBe(202);
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, attempts: 1, lastError: null, body: `${AI_MARK}Reply text.` });
    expect(s.posts.bodies.map((b) => b.text)).toEqual([`${AI_MARK}Reply text.`]);
    expect(s.sent()).toBe(1);
  });
});

describe("resolve after posting", () => {
  const PUT = `PUT ${PR_PATH}/comments/${ROOT}`;
  const V0 = findComment(activities("activities-nested-reply.json"), ROOT).version;
  const root = (s: S) =>
    s.db
      .query("SELECT thread_resolved, version, ack_version, thread_resolver_json FROM comment WHERE comment_id = $id")
      .get({ id: ROOT }) as {
      thread_resolved: number;
      version: number;
      ack_version: number | null;
      thread_resolver_json: string | null;
    };
  const writes = (s: S) => s.fake.requests.filter((r) => !r.startsWith("GET "));
  const confirm = (s: S, id: number) => s.call<ConfirmDto>(`/api/prs/${s.pr}/confirm`, { items: [{ id, revision: 2 }] });

  test("the reply posts first, then the thread resolves; the thread shows resolved before and after the sync", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS);
    await tick(s, draft);
    const [planned] = await s.plan();
    expect(planned).toMatchObject({ destination: { kind: "reply", parentId: THEIRS }, body: "Reply text.", resolve: ROOT });
    const read = root(s).ack_version;
    expect((await confirm(s, draft)).status).toBe(202);
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, resolve: { root: ROOT, state: "done", error: null } });
    expect(writes(s)).toEqual([COMMENTS, PUT]);
    expect(s.posts.puts).toEqual([{ id: ROOT, version: V0, threadResolved: true }]);
    // Data Center 9.x keeps the version on a resolve (integration-check.md U64), so the read mark stays.
    expect(root(s)).toMatchObject({ thread_resolved: 1, version: V0, ack_version: read });
    expect(JSON.parse(root(s).thread_resolver_json ?? "{}")).toMatchObject({ slug: FAKE_USER });
    await s.sync.syncNow();
    const detail = (await s.call<PrDetail>(`/api/prs/${s.pr}`)).body;
    expect(detail.comments.find((c) => c.id === ROOT)).toMatchObject({ threadResolved: true, resolver: { slug: FAKE_USER } });
    expect(writes(s)).toEqual([COMMENTS, PUT]);
  });

  test("a resolve-only draft posts no comment and resolves the thread", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS, "");
    expect((await s.call<ReviewItemDto>(`/api/items/${draft}`, { action: "accept", revision: 0 })).status).toBe(400);
    await tick(s, draft);
    expect((await confirm(s, draft)).status).toBe(202);
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ body: "", state: "confirmed", remoteId: null, attempts: 0, resolve: { state: "done" } });
    expect(s.sent()).toBe(0);
    expect(writes(s)).toEqual([PUT]);
    expect(root(s).thread_resolved).toBe(1);
  });

  test("a refused resolve after the reply keeps the reply; Resolve again resolves and never posts the reply twice", async () => {
    const s = await setup();
    s.posts.forbid.add(ROOT);
    const draft = seedReply(s, THEIRS);
    await tick(s, draft);
    await confirm(s, draft);
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, resolve: { root: ROOT, state: "failed" } });
    expect(post?.resolve?.error).toContain("Bitbucket refused to resolve the thread.");
    expect(root(s).thread_resolved).toBe(0);
    // Post again is for the comment step only. The resolve has its own retry.
    expect((await s.call(`/api/posts/${post?.id}/retry`, {})).status).toBe(409);
    s.posts.forbid.clear();
    const again = await s.call<PostDto>(`/api/posts/${post?.id}/resolve`, {});
    expect([again.status, again.body.resolve?.state]).toEqual([202, "pending"]);
    await s.settle();
    expect((await s.list())[0]?.resolve).toEqual({ root: ROOT, state: "done", error: null });
    expect(s.sent()).toBe(1);
    expect(writes(s)).toEqual([COMMENTS, PUT, PUT]);
    expect((await s.call(`/api/posts/${post?.id}/resolve`, {})).status).toBe(409);
    expect((await s.call("/api/posts/999/resolve", {})).status).toBe(404);
  });

  test("a failed reply never resolves; a stale version or an unclear answer fails the resolve with its reason", async () => {
    const s = await setup();
    s.fake.routes[key("POST", `${PR_PATH}/comments`)] = refuse(400);
    const draft = seedReply(s, THEIRS);
    await tick(s, draft);
    await confirm(s, draft);
    await s.settle();
    expect((await s.list())[0]).toMatchObject({ state: "failed", resolve: { state: "pending" } });
    expect(s.posts.puts).toEqual([]);

    const t = await setup();
    t.posts.conflict.add(ROOT);
    const d2 = seedReply(t, THEIRS);
    await tick(t, d2);
    await confirm(t, d2);
    await t.settle();
    expect((await t.list())[0]?.resolve?.error).toBe("The thread changed on Bitbucket. Read it, then resolve it again.");
    t.fake.routes[key("PUT", `${PR_PATH}/comments/*`)] = refuse(500);
    const [row] = await t.list();
    await t.call(`/api/posts/${row?.id}/resolve`, {});
    await t.settle();
    expect((await t.list())[0]?.resolve).toMatchObject({
      state: "failed",
      error: expect.stringContaining("No clear answer from Bitbucket (HTTP 500)."),
    });
  });

  test("a pending resolve resumes at the next start; a thread that is resolved already gets no second PUT", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS);
    await tick(s, draft);
    const route = key("PUT", `${PR_PATH}/comments/*`);
    s.fake.routes[route] = refuse(500);
    await confirm(s, draft);
    await s.settle();
    expect((await s.list())[0]?.resolve?.state).toBe("failed");
    // The app stopped after Bitbucket took the PUT and before the row changed: the thread is resolved, and the row still waits.
    s.fake.routes[route] = s.posts.routes[route] as Route;
    s.posts.threads.set(ROOT, { version: V0 + 1, resolved: true, at: 1 });
    s.db.query("UPDATE post SET resolve_state = 'pending', resolve_error = NULL").run();
    const before = writes(s).length;
    await s.restart();
    await s.settle();
    expect((await s.list())[0]?.resolve).toEqual({ root: ROOT, state: "done", error: null });
    expect(writes(s)).toHaveLength(before);
    expect(s.sent()).toBe(1);
  });

  test("manual resolve and reopen go out at once; stale screens, refusals, and unknown threads give their reasons", async () => {
    const s = await setup();
    const set = (body: Record<string, unknown>) =>
      s.call<{ thread?: number; resolved?: boolean } & Partial<ThreadResolveError>>(`/api/prs/${s.pr}/resolve`, {
        thread: ROOT,
        resolved: true,
        seen: THEIRS,
        ...body,
      });
    expect((await set({ seen: 1000001 })).body).toMatchObject({ reason: "messages" });
    expect((await set({ thread: THEIRS })).status).toBe(404);
    expect((await set({ thread: 999 })).status).toBe(404);
    expect((await set({ resolved: "yes" })).status).toBe(400);
    expect(s.posts.puts).toEqual([]);

    s.posts.forbid.add(ROOT);
    const no = await set({});
    expect([no.status, no.body.reason]).toEqual([403, "forbidden"]);
    s.posts.forbid.clear();
    s.posts.conflict.add(ROOT);
    expect((await set({})).body).toMatchObject({
      reason: "changed",
      error: "The thread changed on Bitbucket. Read it, then resolve it again.",
    });
    s.posts.ignore.add(ROOT);
    expect((await set({})).body).toMatchObject({ reason: "ignored" });
    s.posts.ignore.clear();

    // The replies follow the root, because the turn rule reads every message of the thread.
    const reply = () =>
      (s.db.query("SELECT thread_resolved FROM comment WHERE comment_id = $id").get({ id: THEIRS }) as { thread_resolved: number })
        .thread_resolved;
    expect((await set({})).body).toEqual({ thread: ROOT, resolved: true });
    expect([root(s).thread_resolved, reply()]).toEqual([1, 1]);
    const back = await set({ resolved: false });
    expect([back.status, back.body]).toEqual([200, { thread: ROOT, resolved: false }]);
    expect(root(s)).toMatchObject({ thread_resolved: 0, thread_resolver_json: null });
    expect(reply()).toBe(0);
    expect(s.posts.puts.map((p) => p.threadResolved)).toEqual([true, true, true, true, false]);
    // Nothing went to the outbox: a manual change is no post.
    expect(await s.list()).toEqual([]);
    expect(s.sent()).toBe(0);
  });

  // Data Center 9.x gate (integration-check.md U62 to U65): a resolve and a reopen keep the version and the text.
  test("version unchanged after resolve and reopen; text and read state unchanged", async () => {
    const s = await setup();
    const row = () =>
      s.db.query("SELECT version, ack_version, text FROM comment WHERE comment_id = $id").get({ id: ROOT }) as {
        version: number;
        ack_version: number | null;
        text: string;
      };
    const before = row();
    const unread = async () => (await s.call<PrDetail>(`/api/prs/${s.pr}`)).body.comments.find((c) => c.id === ROOT)?.unread;
    const was = await unread();
    for (const resolved of [true, false]) {
      expect((await s.call(`/api/prs/${s.pr}/resolve`, { thread: ROOT, resolved, seen: THEIRS })).status).toBe(200);
      expect(row()).toEqual(before);
      expect(await unread()).toBe(was);
      await s.sync.syncNow();
      expect(row()).toEqual(before);
      expect(await unread()).toBe(was);
    }
    expect(s.posts.puts).toEqual([
      { id: ROOT, version: V0, threadResolved: true },
      { id: ROOT, version: V0, threadResolved: false },
    ]);
  });

  test("a resolve keeps an edit of the root that the app has not synced: the next sync brings the text, unread", async () => {
    const s = await setup();
    // The root is by another person, and I read it. A sync marks my own edits read, so the edit must be theirs.
    s.db
      .query("UPDATE comment SET ack_version = version, author_slug = $slug, author_login = $login WHERE comment_id = $id")
      .run({ id: ROOT, slug: OTHER.slug, login: OTHER.name as string });
    // The other person edits the root on Bitbucket before the sync: version V0 + 1.
    s.world.list = () => {
      const list = byUser(thread(), ROOT, OTHER);
      Object.assign(findComment(list, ROOT), { text: "Edited root text.", version: V0 + 1 });
      return list;
    };
    const set = await s.call(`/api/prs/${s.pr}/resolve`, { thread: ROOT, resolved: true, seen: THEIRS });
    expect(set.status).toBe(200);
    expect(s.posts.puts).toEqual([{ id: ROOT, version: V0 + 1, threadResolved: true }]);
    // The read-back version is V0 + 1, but the stored text is of V0. Only the flags change.
    expect(root(s)).toMatchObject({ thread_resolved: 1, version: V0, ack_version: V0 });
    await s.sync.syncNow();
    const detail = (await s.call<PrDetail>(`/api/prs/${s.pr}`)).body;
    expect(detail.comments.find((c) => c.id === ROOT)).toMatchObject({ text: "Edited root text.", unread: true, threadResolved: true });
  });
});

describe("a reply in a resolved thread", () => {
  const V0 = findComment(activities("activities-nested-reply.json"), ROOT).version;
  const PUT = `PUT ${PR_PATH}/comments/${ROOT}`;
  const writes = (s: S) => s.fake.requests.filter((r) => !r.startsWith("GET "));
  // Another person resolves the thread on Bitbucket. The sync stores it.
  const resolveOnForge = async (s: S) => {
    s.posts.threads.set(ROOT, { version: V0, resolved: true, at: 1 });
    await s.sync.syncNow();
  };

  test("the fake refuses a reply in a resolved thread", async () => {
    const s = await setup();
    await resolveOnForge(s);
    const res = await fetch(`${s.fake.url}${PR_PATH}/comments`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ text: TEXT, parent: { id: THEIRS } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      errors: [{ exceptionName: "com.atlassian.bitbucket.validation.ArgumentValidationException" }],
    });
  });

  test("a resolve between the reopen and the post: the refusal says to reopen first", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS);
    await accept(s, draft);
    await resolveOnForge(s);
    const route = key("POST", `${PR_PATH}/comments`);
    const post = s.posts.routes[route] as (req: Request) => Promise<Reply>;
    s.fake.routes[route] = (req: Request) => {
      s.posts.threads.set(ROOT, { version: V0, resolved: true, at: 2 });
      return post(req);
    };
    await s.call(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 1 }] });
    await s.settle();
    expect((await s.list())[0]).toMatchObject({ state: "failed", lastError: "This thread is resolved. Reopen it first." });
    expect(writes(s)).toEqual([PUT, COMMENTS]);
  });

  test("thread outcome: a thread resolved after the draft blocks it until the user reopens the thread; then it posts and resolves again", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS, "Reply text.", { threadOpen: true });
    await tick(s, draft);
    expect((await s.plan())[0]?.reopen).toBeUndefined();
    await resolveOnForge(s);
    const plan = (await s.call<PostPlanDto>(`/api/prs/${s.pr}/post-plan`)).body;
    expect(plan).toEqual({ pr: s.pr, posts: [], blocked: [{ item: draft, revision: 2, thread: ROOT, reason: "resolved-since" }] });
    const no = await s.call<{ error: string }>(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 2 }] });
    expect(no.status).toBe(409);
    expect(writes(s)).toEqual([]);

    // The user reopens the thread. The draft then posts with no reopen step, and the tick resolves the thread again.
    expect((await s.call(`/api/prs/${s.pr}/resolve`, { thread: ROOT, resolved: false, seen: THEIRS })).status).toBe(200);
    expect((await s.plan())[0]).toMatchObject({ body: "Reply text.", resolve: ROOT });
    expect((await s.plan())[0]?.reopen).toBeUndefined();
    expect((await s.call(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 2 }] })).status).toBe(202);
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, resolve: { state: "done" } });
    expect(writes(s)).toEqual([PUT, COMMENTS, PUT]);
    expect(s.posts.puts.map((p) => [p.version, p.threadResolved])).toEqual([
      [V0, false],
      [V0, true],
    ]);
  });

  test("a draft written while the thread was resolved keeps reopen-first: the post reopens, replies, then resolves again", async () => {
    const s = await setup();
    await resolveOnForge(s);
    const draft = seedReply(s, THEIRS, "Reply text.", { threadOpen: false });
    await tick(s, draft);
    const plan = (await s.call<PostPlanDto>(`/api/prs/${s.pr}/post-plan`)).body;
    expect("blocked" in plan).toBe(false);
    expect(plan.posts[0]).toMatchObject({ body: "Reply text.", resolve: ROOT, reopen: "resolved" });
    expect((await s.call(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 2 }] })).status).toBe(202);
    await s.settle();
    expect((await s.list())[0]).toMatchObject({ state: "confirmed", remoteId: FIRST_ID, resolve: { state: "done" } });
    expect(writes(s)).toEqual([PUT, COMMENTS, PUT]);
  });

  test("a draft from before the field shows a plain reopen; a resolve-only draft needs no reopen", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS);
    await accept(s, draft);
    await resolveOnForge(s);
    expect((await s.plan())[0]?.reopen).toBe("resolved");
    const t = await setup();
    const only = seedReply(t, THEIRS, "");
    await tick(t, only);
    await resolveOnForge(t);
    expect((await t.plan())[0]).toMatchObject({ body: "", resolve: ROOT });
    expect((await t.plan())[0]?.reopen).toBeUndefined();
  });

  test("a refused post after the reopen says so; Post again never reopens twice", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS);
    await accept(s, draft);
    await resolveOnForge(s);
    const route = key("POST", `${PR_PATH}/comments`);
    s.fake.routes[route] = refuse(400);
    await s.call(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 1 }] });
    await s.settle();
    const [post] = await s.list();
    expect(post).toMatchObject({
      state: "failed",
      lastError: "Bitbucket refused the comment (HTTP 400). The app reopened the thread before the post.",
    });
    // The thread shows open at once.
    const detail = (await s.call<PrDetail>(`/api/prs/${s.pr}`)).body;
    expect(detail.comments.find((c) => c.id === ROOT)?.threadResolved).toBe(false);
    s.fake.routes[route] = s.posts.routes[route] as Route;
    expect((await s.call(`/api/posts/${post?.id}/retry`, {})).status).toBe(202);
    await s.settle();
    expect((await s.list())[0]).toMatchObject({ state: "confirmed", remoteId: FIRST_ID });
    expect(writes(s)).toEqual([PUT, COMMENTS, COMMENTS]);
  });

  test("a refused reopen posts no reply; a manual reply reopens too", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS);
    await accept(s, draft);
    await resolveOnForge(s);
    s.posts.forbid.add(ROOT);
    await s.call(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 1 }] });
    await s.settle();
    const [post] = await s.list();
    expect(post?.state).toBe("failed");
    expect(post?.lastError).toStartWith("Bitbucket refused to reopen the thread.");
    expect(post?.lastError).toEndWith("The reply was not sent.");
    expect(s.sent()).toBe(0);

    const t = await setup();
    await resolveOnForge(t);
    expect((await t.reply()).status).toBe(202);
    await t.settle();
    expect((await t.list())[0]).toMatchObject({ state: "confirmed", remoteId: FIRST_ID });
    expect(writes(t)).toEqual([PUT, COMMENTS]);
  });

  test("Post again of a reply run post checks no heads", async () => {
    const s = await setup();
    const draft = seedReply(s, THEIRS);
    await accept(s, draft);
    const route = key("POST", `${PR_PATH}/comments`);
    s.fake.routes[route] = refuse(500);
    await s.call(`/api/prs/${s.pr}/confirm`, { items: [{ id: draft, revision: 1 }] });
    await s.settle();
    const [post] = await s.list();
    expect(post?.state).toBe("unknown");
    s.world.pr.fromRef.latestCommit = "f".repeat(40);
    s.fake.routes[route] = s.posts.routes[route] as Route;
    expect((await s.call(`/api/posts/${post?.id}/retry`, {})).status).toBe(202);
    await s.settle();
    expect((await s.list())[0]?.state).toBe("confirmed");
  });
});

// Audit: a pass that throws does not end the sender. A kick during the pass runs the next pass. A new database starts with no checks.
describe("sender passes", () => {
  test("a drain that throws once still runs the pass that a kick queued, on the new database without old checks", async () => {
    const NEXT = "WHERE state = 'pending'";
    const BY_ID = "SELECT * FROM post WHERE id = $id";
    let outbox: Outbox | null = null;
    let cur: unknown = null;
    // next: the first pending row. onRun: each write.
    const fakeDb = (unknown: { id: number }[], next: () => unknown, onRun: () => void) => {
      const log: string[] = [];
      const query = (sql: string) => ({
        run: () => {
          onRun();
          return { changes: 0 };
        },
        all: () => (sql.includes("state = 'unknown'") ? unknown : []),
        get: () => {
          log.push(sql);
          return sql.includes(NEXT) ? next() : null;
        },
      });
      return { log, query };
    };
    const second = fakeDb(
      [],
      () => null,
      () => {},
    );
    let armed = false;
    let thrown = false;
    // The pending row fails after the await of the provider. Its write throws, as on a closed database.
    const row = { id: 1, pr: 1, body: "x", destination_json: JSON.stringify({ kind: "general" }) };
    const first = fakeDb(
      [{ id: 7 }],
      () => {
        if (thrown) return null;
        armed = true;
        return row;
      },
      () => {
        if (!armed) return;
        armed = false;
        thrown = true;
        // A settings change: the next open gets another database and kicks during this pass.
        cur = second;
        outbox?.start();
        throw new Error("The database is closed.");
      },
    );
    cur = first;
    const settings = {
      db: () => cur,
      provider: async () => null,
      config: () => null,
      onSettingsChanged: () => {},
    } as unknown as Parameters<typeof createOutbox>[0]["settings"];
    outbox = createOutbox({ settings, live: createLive() });
    outbox.start();
    await outbox.wait();
    expect(thrown).toBe(true);
    expect(second.log.some((s) => s.includes(NEXT))).toBe(true);
    // Row 7 of the first database is not checked on the second one.
    expect(second.log).not.toContain(BY_ID);
    await outbox.stop();
  });
});
