// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/server/bitbucket/client";
import { branchUrl, createBitbucketProvider, excerptOf } from "../../src/server/bitbucket/provider";
import { commentLines } from "../../src/shared/types";
import { FAKE_TOKEN, type FakeBitbucket, fixture, key, type Route, startFakeBitbucket } from "../support/fake-bitbucket";
import {
  ACTIVITIES_PATH,
  activities,
  byUser,
  clone,
  commentPosts,
  DASHBOARD_PATH,
  findComment,
  PR_PATH,
  PR_REF,
  pageRoutes,
  pages,
  resolveThread,
  secondUser,
  versionZero,
} from "../support/scenarios";

process.env.REVIEW_LOOP_SECRETS = "memory";

let fake: FakeBitbucket;
afterEach(() => fake?.stop());

function setup(routes: Record<string, Route> = {}, timeoutMs?: number) {
  fake = startFakeBitbucket({ routes });
  return createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN, timeoutMs });
}

async function caught(p: Promise<unknown>): Promise<ForgeError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ForgeError) return e;
    throw e;
  }
  throw new Error("expected a ForgeError");
}

const inline = () => activities("activities-inline-anchored.json");

describe("paging", () => {
  test("last page with absent nextPageStart completes", async () => {
    const p = setup(pageRoutes(ACTIVITIES_PATH, pages(inline(), [2, 1], "absent")));
    const r = await p.listComments(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items.map((c) => c.id).sort()).toEqual([1000001, 1000002, 1000003]);
  });

  test("last page with null nextPageStart completes", async () => {
    const p = setup(pageRoutes(ACTIVITIES_PATH, pages(inline(), [1, 1, 1], "null")));
    const r = await p.listComments(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items).toHaveLength(3);
  });

  test("isLastPage false without a cursor is incomplete", async () => {
    const list = pages(inline(), [2, 1], "absent");
    delete list[0]?.nextPageStart;
    const p = setup(pageRoutes(ACTIVITIES_PATH, list));
    const r = await p.listComments(PR_REF);
    expect(r).toMatchObject({ complete: false, reason: "cursor" });
  });

  test("a cursor that does not advance is incomplete", async () => {
    const list = pages(inline(), [2, 1], "absent");
    if (list[0]) list[0].nextPageStart = 0;
    const p = setup(pageRoutes(ACTIVITIES_PATH, list));
    expect(await p.listComments(PR_REF)).toMatchObject({ complete: false, reason: "cursor" });
  });

  test("pages assemble in order and request each start once", async () => {
    const dash = fixture<{ values: unknown[] }>("dashboard-reviewer-page.json").body.values[0];
    const own = fixture<{ values: unknown[] }>("dashboard-pull-requests-page.json").body.values[0];
    const p = setup(pageRoutes(DASHBOARD_PATH, pages([dash, own], [1, 1], "absent")));
    const r = await p.listDashboard("REVIEWER");
    expect(r.complete).toBe(true);
    expect(r.items.map((x) => x.ref.id)).toEqual([1001, 2]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]).toContain("role=REVIEWER");
    expect(fake.requests[1]).toContain("start=1");
  });

  test("an error on page 2 gives incomplete with the error kind", async () => {
    const list = pages(inline(), [2, 1], "absent");
    const routes = pageRoutes(ACTIVITIES_PATH, list);
    routes[key("GET", ACTIVITIES_PATH, 2)] = { status: 500, body: {} };
    const r = await setup(routes).listComments(PR_REF);
    expect(r).toMatchObject({ complete: false, reason: "server", error: { kind: "server", status: 500 } });
  });

  test("a parse failure is incomplete and names the endpoint", async () => {
    const list = pages(inline(), [3], "absent");
    const bad = clone(list[0]) as unknown as { values: { comment?: { version: unknown } }[] };
    if (bad.values[0]?.comment) bad.values[0].comment.version = "x";
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body: bad } }).listComments(PR_REF);
    expect(r).toMatchObject({ complete: false, reason: "shape" });
    if (!r.complete) expect(r.error?.endpoint).toBe(ACTIVITIES_PATH);
  });

  test("more than 200 pages is incomplete", async () => {
    const p = setup({
      [key("GET", ACTIVITIES_PATH)]: (req) => {
        const start = Number(new URL(req.url).searchParams.get("start"));
        return { status: 200, body: { size: 0, limit: 1, start, isLastPage: false, nextPageStart: start + 1, values: [] } };
      },
    });
    expect(await p.listComments(PR_REF)).toMatchObject({ complete: false, reason: "page_limit" });
    expect(fake.requests).toHaveLength(200);
  });
});

describe("comments", () => {
  test("nested reply flattens with parent and root", async () => {
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: fixture("activities-nested-reply.json") }).listComments(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items).toHaveLength(2);
    const root = r.items.find((c) => c.id === 1000003);
    const reply = r.items.find((c) => c.id === 1000001);
    expect(root).toMatchObject({ parentId: null, rootId: 1000003 });
    expect(reply).toMatchObject({ parentId: 1000003, rootId: 1000003, author: { slug: "jdoe", name: "Jane Doe" } });
  });

  test("a reply to a reply keeps its direct parent and the top root", async () => {
    const list = activities("activities-nested-reply.json");
    const reply = findComment(list, 1000001);
    reply.comments = [{ ...clone(reply), id: 1000009, comments: [] }];
    const body = { size: 2, limit: 50, start: 0, isLastPage: true, values: list };
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body } }).listComments(PR_REF);
    expect(r.items.find((c) => c.id === 1000009)).toMatchObject({ parentId: 1000001, rootId: 1000003 });
  });

  test("the recorded edit gives version 1", async () => {
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: fixture("activities-after-edit.json") }).listComments(PR_REF);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 1000003, version: 1 });
  });

  test("a duplicate ID keeps the higher version in any order", async () => {
    const after = activities("activities-after-edit.json");
    const before = versionZero(after, 1000003);
    for (const values of [[...before, ...after], [...after, ...before].reverse()]) {
      const body = { size: values.length, limit: 50, start: 0, isLastPage: true, values };
      const r = await setup({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body } }).listComments(PR_REF);
      fake.stop();
      expect(r.items).toHaveLength(1);
      expect(r.items[0]?.version).toBe(1);
    }
  });

  test("a comment by a second user maps that user", async () => {
    const values = byUser(activities("activities-after-edit.json"), 1000003, secondUser());
    const body = { size: 2, limit: 50, start: 0, isLastPage: true, values };
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body } }).listComments(PR_REF);
    expect(r.items[0]?.author).toEqual({ slug: "asmith", name: "Alex Smith", login: "asmith" });
  });

  // Synthetic (integration-check.md U56): the recorded files have no resolved thread.
  const resolvedList = async (values: ReturnType<typeof activities>) => {
    const body = { size: values.length, limit: 50, start: 0, isLastPage: true, values };
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body } }).listComments(PR_REF);
    fake.stop();
    expect(r.complete).toBe(true);
    return { root: r.items.find((c) => c.id === 1000003), reply: r.items.find((c) => c.id === 1000001) };
  };

  test("synthetic: a resolved root maps its resolver without the email and its date; the reply carries neither", async () => {
    const r = await resolvedList(resolveThread(activities("activities-nested-reply.json"), 1000003, secondUser(), 1791571400000));
    expect(r.root).toMatchObject({ threadResolved: true, threadResolvedAt: 1791571400000 });
    expect(r.root?.threadResolver).toEqual({ slug: "asmith", name: "Alex Smith", login: "asmith" });
    expect(JSON.stringify(r.root)).not.toContain("@");
    expect(r.reply?.threadResolver).toBeUndefined();
    expect(r.reply?.threadResolvedAt).toBeUndefined();
  });

  test("synthetic: a resolved root without the two fields, or with bad values, still parses", async () => {
    const plain = await resolvedList(resolveThread(activities("activities-nested-reply.json"), 1000003));
    expect(plain.root).toMatchObject({ threadResolved: true });
    expect(plain.root && "threadResolver" in plain.root).toBe(false);
    expect(plain.root && "threadResolvedAt" in plain.root).toBe(false);
    for (const [who, at] of [
      [null, null],
      [{ displayName: "No slug" }, "yesterday"],
    ] as const) {
      const bad = await resolvedList(resolveThread(activities("activities-nested-reply.json"), 1000003, who, at as unknown as number));
      expect(bad.root).toMatchObject({ threadResolved: true });
      expect(bad.root?.threadResolver).toBeUndefined();
      expect(bad.root?.threadResolvedAt).toBeUndefined();
    }
  });

  test("synthetic: a reopened thread drops a resolver and a date that the server still sends", async () => {
    const values = resolveThread(activities("activities-nested-reply.json"), 1000003, secondUser(), 1791571400000);
    findComment(values, 1000003).threadResolved = false;
    const r = await resolvedList(values);
    expect(r.root).toMatchObject({ threadResolved: false });
    expect(r.root?.threadResolver).toBeUndefined();
    expect(r.root?.threadResolvedAt).toBeUndefined();
  });

  test("the inline anchor maps path and line", async () => {
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: fixture("activities-inline-anchored.json") }).listComments(PR_REF);
    expect(r.items.find((c) => c.id === 1000002)?.anchor).toMatchObject({ path: "sample1.md", line: 3, orphaned: false });
  });

  test("unknown action and state values parse", async () => {
    const values = activities("activities-inline-anchored.json");
    values.push({ ...clone(values[2] ?? { id: 0, action: "" }), id: 10000099, action: "RESCOPED" });
    values.push({ ...clone(values[2] ?? { id: 0, action: "" }), id: 10000098, action: "SOMETHING_NEW" });
    const first = values[0];
    if (first) first.commentAction = "UNKNOWN_ACTION";
    const body = { size: values.length, limit: 50, start: 0, isLastPage: true, values };
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body } }).listComments(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items).toHaveLength(3);

    const pr = clone(fixture<Record<string, unknown>>("pull-request.json"));
    pr.body.state = "SOME_NEW_STATE";
    const got = await setup({ [key("GET", PR_PATH)]: pr }).getPullRequest(PR_REF);
    expect(got.state).toBe("SOME_NEW_STATE");
  });

  test("commentStatus: 200 is present, 404 is deleted, other errors throw", async () => {
    const path = `${PR_PATH}/comments/1000003`;
    const p = setup({
      [key("GET", path)]: fixture("comment-with-nested-reply.json"),
      [key("GET", `${PR_PATH}/comments/1000004`)]: fixture("comment-get-after-delete-404.json"),
      [key("GET", `${PR_PATH}/comments/1000005`)]: { status: 500, body: {} },
    });
    expect(await p.commentStatus(PR_REF, 1000003)).toBe("present");
    expect(await p.commentStatus(PR_REF, 1000004)).toBe("deleted");
    expect((await caught(p.commentStatus(PR_REF, 1000005))).kind).toBe("server");
  });
});

describe("thread resolve", () => {
  // The fake PUT handler checks the version, keeps it, and fills the resolver (tests/support/scenarios.ts commentPosts).
  const ROOT = 1000003;
  const V0 = findComment(activities("activities-nested-reply.json"), ROOT).version;
  function world() {
    const me = findComment(activities("activities-nested-reply.json"), ROOT).author;
    const posts = commentPosts(PR_PATH, () => activities("activities-nested-reply.json"), me, 4_000_001);
    return {
      posts,
      p: setup({ [key("GET", ACTIVITIES_PATH)]: () => ({ status: 200, body: { values: posts.activities() } }), ...posts.routes }),
    };
  }
  const writes = () => fake.requests.filter((r) => !r.startsWith("GET "));

  test("resolve: GET, PUT {version, threadResolved}, GET; reopen clears the resolver; a second resolve sends no PUT", async () => {
    const { posts, p } = world();
    const r = await p.setThreadResolved(PR_REF, ROOT, true);
    expect(r).toMatchObject({
      status: "done",
      state: { version: V0, threadResolved: true, threadResolver: { slug: "jdoe" } },
      from: V0,
      put: true,
    });
    expect(r.status === "done" && typeof r.state.threadResolvedAt).toBe("number");
    expect(posts.puts).toEqual([{ id: ROOT, version: V0, threadResolved: true }]);
    expect(fake.requests.filter((x) => x.includes(`/comments/${ROOT}`))).toEqual([
      `GET ${PR_PATH}/comments/${ROOT}`,
      `PUT ${PR_PATH}/comments/${ROOT}`,
      `GET ${PR_PATH}/comments/${ROOT}`,
    ]);
    // The state is already resolved, so nothing is written.
    expect(await p.setThreadResolved(PR_REF, ROOT, true)).toMatchObject({
      status: "done",
      state: { version: V0 },
      from: V0,
      put: false,
    });
    expect(writes()).toHaveLength(1);
    const back = await p.setThreadResolved(PR_REF, ROOT, false);
    expect(back).toEqual({ status: "done", state: { version: V0, threadResolved: false }, from: V0, put: true });
    expect(posts.puts.at(-1)).toEqual({ id: ROOT, version: V0, threadResolved: false });
    expect(await p.threadState(PR_REF, ROOT)).toEqual({ version: V0, threadResolved: false });
    // A reply in a resolved thread: the short exception name of the error body becomes the error code.
    await p.setThreadResolved(PR_REF, ROOT, true);
    const e = await caught(p.createComment(PR_REF, { text: "x", parentId: ROOT }));
    expect([e.status, e.code]).toEqual([400, "ArgumentValidationException"]);
    expect(posts.posted).toEqual([]);
  });

  test("409 gives changed, 401 and 403 give forbidden, 404 gives gone, a PUT without effect gives ignored; nothing repeats", async () => {
    const { posts, p } = world();
    posts.conflict.add(ROOT);
    expect(await p.setThreadResolved(PR_REF, ROOT, true)).toEqual({ status: "changed" });
    posts.forbid.add(ROOT);
    expect(await p.setThreadResolved(PR_REF, ROOT, true)).toEqual({ status: "forbidden" });
    posts.forbid.clear();
    posts.ignore.add(ROOT);
    expect(await p.setThreadResolved(PR_REF, ROOT, true)).toEqual({ status: "ignored" });
    expect(await p.setThreadResolved(PR_REF, 999, true)).toEqual({ status: "gone" });
    expect(writes()).toHaveLength(3);
    fake.routes[key("PUT", `${PR_PATH}/comments/*`)] = { status: 401, body: { errors: [] } };
    posts.ignore.clear();
    expect(await p.setThreadResolved(PR_REF, ROOT, true)).toEqual({ status: "forbidden" });
    fake.routes[key("PUT", `${PR_PATH}/comments/*`)] = { status: 500, body: { errors: [] } };
    expect((await caught(p.setThreadResolved(PR_REF, ROOT, true))).status).toBe(500);
    expect(writes()).toHaveLength(5);
  });
});

describe("pull requests", () => {
  test("getPullRequest maps the recorded PR", async () => {
    const pr = await setup({ [key("GET", PR_PATH)]: fixture("pull-request.json") }).getPullRequest(PR_REF);
    expect(pr).toMatchObject({
      ref: PR_REF,
      version: 0,
      state: "OPEN",
      author: { slug: "jdoe", name: "Jane Doe" },
      reviewers: [],
      sourceHead: "ba939ffe19df61d874683e85bb168c1769985d23",
      sourceBranch: "topic/sample-1",
      targetBranch: "topic/sample-2",
    });
    expect(pr.description).toBeUndefined();
    expect(pr.webUrl).toBeUndefined();
  });

  test("the web link stays only when its origin equals the base origin", async () => {
    const body = clone(fixture<{ links: { self: { href: string }[] } }>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    const link = body.body.links.self[0];
    if (link) link.href = `${fake.url}/users/jdoe/repos/sample-repo-1/pull-requests/2`;
    expect((await p.getPullRequest(PR_REF)).webUrl).toBe(`${fake.url}/users/jdoe/repos/sample-repo-1/pull-requests/2`);
  });

  type CloneRepo = { links: { clone: { href: string; name: string }[] } };
  const httpLink = (r: CloneRepo) => r.links.clone.find((l) => l.name === "http") as { href: string };

  test("gitRemote takes the http clone links of the base origin, without user info", async () => {
    const body = clone(fixture<{ fromRef: { repository: CloneRepo }; toRef: { repository: CloneRepo } }>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    httpLink(body.body.toRef.repository).href = `${fake.url.replace("//", "//jdoe:pw@")}/scm/~jdoe/sample-repo-1.git`;
    httpLink(body.body.fromRef.repository).href = `${fake.url}/scm/~jdoe/fork-1.git`;
    expect(await p.gitRemote(PR_REF)).toEqual({
      url: `${fake.url}/scm/~jdoe/sample-repo-1.git`,
      sourceUrl: `${fake.url}/scm/~jdoe/fork-1.git`,
      sourceRef: "refs/heads/topic/sample-1",
      targetRef: "refs/heads/topic/sample-2",
      // git-deny.md fix E: the header goes only to the configured origin.
      fetchConfig: [[`http.${new URL(fake.url).origin}/.extraHeader`, `Authorization: Bearer ${FAKE_TOKEN}`]],
    });
  });

  test("gitRemote refuses a clone link of another origin", async () => {
    const body = clone(fixture<{ fromRef: { repository: CloneRepo } }>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    await expect(p.gitRemote(PR_REF)).rejects.toThrow(/clone link/);
    // Only the target link is foreign now.
    httpLink(body.body.fromRef.repository).href = `${fake.url}/scm/~jdoe/sample-repo-1.git`;
    await expect(p.gitRemote(PR_REF)).rejects.toThrow(/clone link/);
  });

  test("dashboard maps reviewers with lastReviewedCommit", async () => {
    const r = await setup({ [key("GET", DASHBOARD_PATH)]: fixture("dashboard-reviewer-page.json") }).listDashboard("REVIEWER");
    expect(r.complete).toBe(true);
    expect(r.items[0]).toMatchObject({
      ref: { project: "PROJ1", repo: "sample-repo-2", id: 1001 },
      author: { slug: "asmith" },
      reviewers: [{ slug: "jdoe", status: "UNAPPROVED", lastReviewedCommit: "c5bf8bfcb823b4949bc9bfe280c5ffc3ffd0a151" }],
    });
  });
});

describe("errors", () => {
  test("currentUser returns X-AUSERNAME", async () => {
    const p = setup({ [key("GET", DASHBOARD_PATH)]: fixture("dashboard-pull-requests-page.json") });
    expect(await p.currentUser()).toBe("jdoe");
    expect(fake.requests[0]).toContain("limit=1");
  });

  test("currentUser without X-AUSERNAME is auth", async () => {
    const p = setup({ [key("GET", DASHBOARD_PATH)]: fixture("dashboard-pull-requests-page.json") });
    fake.user = null;
    expect((await caught(p.currentUser())).kind).toBe("auth");
  });

  test("401 gives auth", async () => {
    const p = setup({ [key("GET", DASHBOARD_PATH)]: fixture("dashboard-pull-requests-page.json") });
    fake.token = "another-token";
    expect((await caught(p.currentUser())).kind).toBe("auth");
    expect((await caught(p.getPullRequest(PR_REF))).kind).toBe("auth");
  });

  test("status codes map to kinds and keep Retry-After", async () => {
    const at = (s: number, headers?: Record<string, string>) => ({ [key("GET", PR_PATH)]: { status: s, body: {}, headers } });
    expect((await caught(setup(at(403)).getPullRequest(PR_REF))).kind).toBe("forbidden");
    fake.stop();
    expect((await caught(setup(at(404)).getPullRequest(PR_REF))).kind).toBe("not_found");
    fake.stop();
    const rate = await caught(setup(at(429, { "Retry-After": "17" })).getPullRequest(PR_REF));
    expect(rate).toMatchObject({ kind: "rate", status: 429, retryAfter: "17" });
    fake.stop();
    expect((await caught(setup(at(503)).getPullRequest(PR_REF))).kind).toBe("rate");
  });

  test("a 3xx is an error and the client sends no second request", async () => {
    const p = setup({
      [key("GET", PR_PATH)]: { status: 302, headers: { Location: "/elsewhere" } },
      [key("GET", "/elsewhere")]: fixture("pull-request.json"),
    });
    const e = await caught(p.getPullRequest(PR_REF));
    expect(e).toMatchObject({ kind: "server", status: 302 });
    expect(fake.requests).toHaveLength(1);
  });

  test("a hung request times out", async () => {
    const p = setup({ [key("GET", PR_PATH)]: { hang: true } }, 100);
    expect((await caught(p.getPullRequest(PR_REF))).kind).toBe("timeout");
  });

  test("a dropped connection is a network error", async () => {
    const p = setup({ [key("GET", PR_PATH)]: { drop: true } });
    expect((await caught(p.getPullRequest(PR_REF))).kind).toBe("network");
  });

  test("a closed port is a network error", async () => {
    const p = setup();
    fake.stop();
    expect((await caught(p.getPullRequest(PR_REF))).kind).toBe("network");
  });

  test("no error holds the token", async () => {
    const errors: ForgeError[] = [];
    const routes = {
      [key("GET", PR_PATH)]: { status: 302, headers: { Location: `/x?t=${FAKE_TOKEN}` } },
      [key("GET", `${PR_PATH}/comments/1`)]: { status: 500, body: { errors: [{ message: FAKE_TOKEN }] } },
      [key("GET", `${PR_PATH}/comments/2`)]: { drop: true as const },
      [key("GET", `${PR_PATH}/comments/4`)]: { hang: true as const },
    };
    const p = setup(routes, 100);
    errors.push(await caught(p.getPullRequest(PR_REF)));
    for (const id of [1, 2, 4]) errors.push(await caught(p.commentStatus(PR_REF, id)));
    fake.token = "x";
    errors.push(await caught(p.currentUser()));
    const r = await setup({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body: { values: FAKE_TOKEN } } }).listComments(PR_REF);
    if (!r.complete && r.error instanceof ForgeError) errors.push(r.error);
    expect(errors.map((e) => e.kind)).toEqual(["server", "server", "network", "timeout", "auth", "shape"]);
    for (const e of errors) {
      for (const s of [e.message, String(e), JSON.stringify(e), e.stack ?? ""]) expect(s).not.toContain(FAKE_TOKEN);
    }
  });

  test("requests in flight never exceed 2", async () => {
    const routes: Record<string, { status: number; body: unknown; delayMs: number }> = {};
    for (let id = 1; id <= 8; id++) routes[key("GET", `${PR_PATH}/comments/${id}`)] = { status: 200, body: {}, delayMs: 30 };
    routes[key("GET", PR_PATH)] = { ...fixture("pull-request.json"), delayMs: 30 };
    const p = setup(routes);
    await Promise.all([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((id) => p.commentStatus(PR_REF, id)),
      p.getPullRequest(PR_REF),
      p.getPullRequest(PR_REF),
    ]);
    expect(fake.requests).toHaveLength(10);
    expect(fake.maxInFlight).toBe(2);
  });

  test("plain http to a non-loopback host is refused", () => {
    expect(() => createBitbucketProvider({ baseUrl: "http://bitbucket.example.test", token: FAKE_TOKEN })).toThrow();
    expect(() => createBitbucketProvider({ baseUrl: "ftp://127.0.0.1", token: FAKE_TOKEN })).toThrow();
  });
});

// Plan v3 WP4 on the Gate v3 fixtures. Removed lines stay synthetic (Gate v3 NOT TRIED: REMOVED). Gate A U2 and U12 use real captures.
describe("forge data", () => {
  const v3 = () => activities("activities-v3-after-write.json");
  const serve = (values: unknown[]) => ({ [key("GET", ACTIVITIES_PATH)]: { status: 200, body: { isLastPage: true, start: 0, values } } });
  const lines = (c: { excerpt?: { n: number; kind: string; hit: boolean }[] } | undefined) =>
    c?.excerpt?.map((l) => `${l.hit ? ">" : ""}${l.kind}${l.n}`);
  type Line = { source: number; destination: number; line: string; commentIds?: number[] };
  type Diff = { hunks: { segments: { type: string; lines: Line[] }[] }[] };
  const diffOf = (list: unknown[], id: number) => (list.find((a) => (a as { id: number }).id === id) as { diff: Diff }).diff;
  // Removes the commentIds marks of a diff, so only the anchor line names the row.
  const unmark = (d: Diff) => {
    for (const h of d.hunks) for (const s of h.segments) for (const l of s.lines) delete l.commentIds;
  };

  test("an ADDED and a CONTEXT comment get the anchor line plus 3 lines on each side", async () => {
    const r = await setup(serve(v3())).listComments(PR_REF);
    expect(r.complete).toBe(true);
    const at = (id: number) => r.items.find((c) => c.id === id);
    expect(lines(at(1000004))).toEqual(["ctx1", "ctx2", ">add3", "add4", "ctx5", "ctx6"]);
    // U4: the CONTEXT anchor `line 7, fileType TO` names the row source 7 / destination 9. The server marks that row with commentIds.
    // The excerpt numbers its ctx lines on the new side.
    expect(lines(at(1000005))).toEqual(["ctx6", "ctx7", "ctx8", ">ctx9", "ctx10", "ctx11", "ctx12"]);
    expect(at(1000005)?.excerpt?.[3]?.text).toBe("sample line 36");
  });

  test("U4: without the commentIds mark, a CONTEXT anchor matches the row by its old line, whatever fileType says", async () => {
    const list = v3();
    unmark(diffOf(list, 10000006));
    const r = await setup(serve(list)).listComments(PR_REF);
    const c = r.items.find((x) => x.id === 1000005);
    expect(c?.excerpt?.find((l) => l.hit)).toMatchObject({ n: 9, kind: "ctx", text: "sample line 36" });
    // fileType FROM names the same row, and numbers the excerpt on the old side.
    const from = { ...(findComment(v3(), 1000005).anchor as object), fileType: "FROM" };
    expect(excerptOf(diffOf(list, 10000006), from)?.find((l) => l.hit)).toMatchObject({ n: 7, text: "sample line 36" });
  });

  test("the commentIds mark wins over the anchor line", () => {
    const diff = diffOf(v3(), 10000006);
    const anchor = { line: 3, lineType: "CONTEXT", fileType: "TO" };
    expect(excerptOf(diff, anchor, 1000005)?.find((l) => l.hit)?.text).toBe("sample line 36");
    expect(excerptOf(diff, anchor, 42)?.find((l) => l.hit)?.text).toBe("sample line 32");
  });

  test("U16: a reply keeps no anchor and no excerpt, and stays in its thread", async () => {
    const r = await setup(serve(v3())).listComments(PR_REF);
    const reply = r.items.find((c) => c.id === 1000006);
    const nested = r.items.find((c) => c.id === 1000007);
    expect(reply).toMatchObject({ parentId: 1000005, rootId: 1000005 });
    expect(nested).toMatchObject({ parentId: 1000006, rootId: 1000005 });
    for (const c of [reply, nested]) {
      expect(c?.anchor).toBeUndefined();
      expect(c?.excerpt).toBeUndefined();
    }
  });

  test("U14: a BLOCKER task keeps severity and state; a general comment has no excerpt", async () => {
    const r = await setup(serve(v3())).listComments(PR_REF);
    expect(r.items.find((c) => c.id === 1000008)).toMatchObject({ severity: "BLOCKER", state: "RESOLVED", version: 1 });
    expect(r.items.find((c) => c.id === 1000008)?.excerpt).toBeUndefined();
    expect(r.items.find((c) => c.id === 1000004)).toMatchObject({ severity: "NORMAL", state: "OPEN" });
  });

  test("synthetic: a REMOVED line numbers on the old side, and an orphaned anchor keeps its diff excerpt", async () => {
    const list = v3();
    const removed = findComment(list, 1000004);
    removed.anchor = { ...(removed.anchor as object), line: 3, lineType: "REMOVED", fileType: "FROM" };
    unmark(diffOf(list, 10000005));
    const segments = diffOf(list, 10000005).hunks[0]?.segments ?? [];
    segments.splice(1, 0, { type: "REMOVED", lines: [{ source: 3, destination: 3, line: "old line" }] });
    const orphan = findComment(list, 1000005);
    orphan.anchor = { ...(orphan.anchor as object), orphaned: true };
    const r = await setup(serve(list)).listComments(PR_REF);
    // An old-side comment numbers its context lines on the old side too.
    expect(lines(r.items.find((c) => c.id === 1000004))).toEqual(["ctx1", "ctx2", ">del3", "add3", "add4", "ctx3"]);
    expect(r.items.find((c) => c.id === 1000005)?.excerpt?.find((l) => l.hit)?.n).toBe(9);
  });

  test("a line outside the diff gives no excerpt; a diff of another shape keeps the page complete", async () => {
    const list = v3();
    const far = findComment(list, 1000004);
    far.anchor = { ...(far.anchor as object), line: 99 };
    unmark(diffOf(list, 10000005));
    const odd = list.find((a) => a.id === 10000006);
    if (odd) odd.diff = { hunks: "not a list" };
    const r = await setup(serve(list)).listComments(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items.find((c) => c.id === 1000004)?.excerpt).toBeUndefined();
    expect(r.items.find((c) => c.id === 1000005)?.excerpt).toBeUndefined();
    expect(r.items.find((c) => c.id === 1000005)?.anchor).toMatchObject({ line: 7 });
  });

  // Gate A U2: a real two-segment range comment, ADDED dst 3 to the CONTEXT end row src 10 / dst 12.
  test("U2: a range comment marks each row from the span start to the end row, numbered on the new side", async () => {
    const r = await setup(serve(activities("activities-u2-range.json"))).listComments(PR_REF);
    expect(r.complete).toBe(true);
    const c = r.items.find((x) => x.id === 1000001);
    expect(c?.anchor).toMatchObject({
      line: 10,
      lineType: "CONTEXT",
      fileType: "FROM",
      orphaned: false,
      multilineMarker: { startLine: 3, startLineType: "ADDED" },
      multilineSpan: { srcSpanStart: 3, srcSpanEnd: 10, dstSpanStart: 3, dstSpanEnd: 12 },
    });
    // The activity diff holds the span only, so no context row surrounds it.
    expect(lines(c)).toEqual([">add3", ">add4", ">ctx5", ">ctx6", ">ctx7", ">ctx8", ">ctx9", ">ctx10", ">ctx11", ">ctx12"]);
    expect(commentLines(c ?? {})).toEqual({ line: 3, lineEnd: 12 });
  });

  test("U2: a range excerpt keeps 3 rows of context and falls back to the end row without a span start", () => {
    const anchor = findComment(activities("activities-u2-range.json"), 1000001).anchor as Parameters<typeof excerptOf>[1];
    const ctx = (n: number): Line => ({ source: n - 2, destination: n, line: `l${n}` });
    const diff = {
      hunks: [
        {
          segments: [
            { type: "CONTEXT", lines: [1, 2].map(ctx) },
            ...(diffOf(activities("activities-u2-range.json"), 10000002).hunks[0]?.segments ?? []),
            { type: "CONTEXT", lines: [13, 14, 15, 16].map(ctx) },
          ],
        },
      ],
    };
    expect(lines({ excerpt: excerptOf(diff, anchor, 1000001) })).toEqual([
      "ctx1",
      "ctx2",
      ">add3",
      ">add4",
      ">ctx5",
      ">ctx6",
      ">ctx7",
      ">ctx8",
      ">ctx9",
      ">ctx10",
      ">ctx11",
      ">ctx12",
      "ctx13",
      "ctx14",
      "ctx15",
    ]);
    const late = { ...anchor, multilineSpan: { srcSpanStart: 3, srcSpanEnd: 10, dstSpanStart: 99, dstSpanEnd: 99 } };
    expect(
      excerptOf(diff, late, 1000001)
        ?.filter((l) => l.hit)
        .map((l) => l.n),
    ).toEqual([12]);
  });

  test("U12: a real orphaned range keeps its excerpt; RESCOPED activities add no comment; the page is complete", async () => {
    const r = await setup(serve(activities("activities-u12-orphaned-range.json"))).listComments(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items.map((c) => c.id)).toEqual([1000001]);
    const c = r.items[0];
    expect(c?.anchor).toMatchObject({ orphaned: true, multilineSpan: { dstSpanStart: 3, dstSpanEnd: 12 } });
    expect(c?.excerpt?.filter((l) => l.hit)).toHaveLength(10);
  });

  test("U12: the real commits after the push list the new head first", async () => {
    const page = fixture<{ values: { id: string }[] }>("pull-request-commits-u12.json");
    const r = await setup({ [key("GET", `${PR_PATH}/commits`)]: page }).listCommits(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items.map((c) => c.hash)).toEqual(page.body.values.map((c) => c.id));
    expect(r.items[0]?.parents).toEqual([r.items[1]?.hash ?? ""]);
  });

  test("an excerpt line stops at 500 chars", () => {
    const diff = { hunks: [{ segments: [{ type: "ADDED", lines: [{ source: 1, destination: 1, line: "x".repeat(600) }] }] }] };
    expect(excerptOf(diff, { line: 1, lineType: "ADDED", fileType: "TO" })?.[0]?.text).toHaveLength(500);
    expect(excerptOf(diff, { lineType: "ADDED", fileType: "TO" })).toBeUndefined();
  });

  test("U5: repoUrl is the target repository browse link of the configured origin only", async () => {
    const body = clone(fixture<{ toRef: { repository: { links: { self: { href: string }[] } } } }>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    // The recorded link has another host.
    expect((await p.getPullRequest(PR_REF)).repoUrl).toBeUndefined();
    const link = body.body.toRef.repository.links.self[0];
    if (link) link.href = `${fake.url}/users/jdoe/repos/sample-repo-1/browse`;
    expect((await p.getPullRequest(PR_REF)).repoUrl).toBe(`${fake.url}/users/jdoe/repos/sample-repo-1/browse`);
  });

  test("branchUrl adds the full ref name to the repository browse link", () => {
    expect(branchUrl("https://h.test/projects/P/repos/r/browse", "refs/heads/fix/a b")).toBe(
      "https://h.test/projects/P/repos/r/browse?at=refs%2Fheads%2Ffix%2Fa%20b",
    );
    expect(branchUrl("https://h.test/users/jdoe/repos/r/browse/", "refs/heads/main")).toBe(
      "https://h.test/users/jdoe/repos/r/browse?at=refs%2Fheads%2Fmain",
    );
    expect(branchUrl(undefined, "refs/heads/main")).toBeUndefined();
    expect(branchUrl("https://h.test/projects/P/repos/r/browse", undefined)).toBeUndefined();
  });

  type BrowseRepo = { project: { key: string }; slug: string; links: { self: { href: string }[] } };
  type Refs = { fromRef: { id: string; repository: BrowseRepo }; toRef: { id: string; repository: BrowseRepo } };
  const setSelf = (r: BrowseRepo, href: string) => {
    r.links.self = [{ href }];
  };

  test("the branch links come from the repository links of each ref, from the configured origin only", async () => {
    const body = clone(fixture<Refs>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    // The recorded links have another host.
    expect(await p.getPullRequest(PR_REF)).toMatchObject({ sourceBranchUrl: undefined, targetBranchUrl: undefined });
    setSelf(body.body.fromRef.repository, `${fake.url}/users/jdoe/repos/sample-repo-1/browse`);
    setSelf(body.body.toRef.repository, `${fake.url}/users/jdoe/repos/sample-repo-1/browse`);
    expect(await p.getPullRequest(PR_REF)).toMatchObject({
      sourceBranchUrl: `${fake.url}/users/jdoe/repos/sample-repo-1/browse?at=refs%2Fheads%2Ftopic%2Fsample-1`,
      targetBranchUrl: `${fake.url}/users/jdoe/repos/sample-repo-1/browse?at=refs%2Fheads%2Ftopic%2Fsample-2`,
    });
  });

  test("the author page comes from author.user.links.self, from the configured origin only (plan pr-view-v4 N2)", async () => {
    const body = clone(fixture<{ author: { user: { links: { self: { href: string }[] } } } }>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    // The recorded link has another host.
    expect((await p.getPullRequest(PR_REF)).authorUrl).toBeUndefined();
    body.body.author.user.links.self = [{ href: `${fake.url}/users/jdoe` }];
    expect((await p.getPullRequest(PR_REF)).authorUrl).toBe(`${fake.url}/users/jdoe`);
  });

  test("a PR from a fork links its source branch in the fork and its target branch in the PR repository", async () => {
    const body = clone(fixture<Refs>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    const from = body.body.fromRef;
    from.id = "refs/heads/feature/x";
    Object.assign(from.repository, { slug: "sample-repo-1", project: { key: "~ASMITH" } });
    setSelf(from.repository, `${fake.url}/users/asmith/repos/sample-repo-1/browse`);
    setSelf(body.body.toRef.repository, `${fake.url}/projects/PROJ1/repos/sample-repo-1/browse`);
    const pr = await p.getPullRequest(PR_REF);
    expect(pr.sourceBranchUrl).toBe(`${fake.url}/users/asmith/repos/sample-repo-1/browse?at=refs%2Fheads%2Ffeature%2Fx`);
    expect(pr.targetBranchUrl).toBe(`${fake.url}/projects/PROJ1/repos/sample-repo-1/browse?at=refs%2Fheads%2Ftopic%2Fsample-2`);
    expect(pr.repoUrl).toBe(`${fake.url}/projects/PROJ1/repos/sample-repo-1/browse`);
  });

  test("a ref without its full name gets no branch link", async () => {
    const body = clone(fixture<Refs>("pull-request.json"));
    const p = setup({ [key("GET", PR_PATH)]: body });
    setSelf(body.body.fromRef.repository, `${fake.url}/users/jdoe/repos/sample-repo-1/browse`);
    delete (body.body.fromRef as { id?: string }).id;
    const pr = await p.getPullRequest(PR_REF);
    expect(pr.sourceBranch).toBe("topic/sample-1");
    expect(pr.sourceBranchUrl).toBeUndefined();
  });

  test("U15: the recorded commits page maps the confirmed fields", async () => {
    const r = await setup({ [key("GET", `${PR_PATH}/commits`)]: fixture("pull-request-commits-page.json") }).listCommits(PR_REF);
    expect(r).toEqual({
      complete: true,
      items: [
        {
          hash: "ba939ffe19df61d874683e85bb168c1769985d23",
          parents: ["e1f9c8949eb8129073e3b528a54a1dc79fb95e3a"],
          message: "Sample commit 14.",
          authorSlug: "jdoe",
          authorName: "Jane Doe",
          at: 1791569802000,
          committedAt: 1791569802000,
        },
      ],
    });
  });

  test("synthetic: commits come newest first by parents, whatever the server order and paging", async () => {
    const [rec] = fixture<{ values: Record<string, unknown>[] }>("pull-request-commits-page.json").body.values;
    // a <- b <- d and a <- c <- d (a merge). c has the newest commit time, so it comes right after d. e is outside the PR.
    const mk = (id: string, parents: string[], t: number, author = rec?.author) => ({
      ...clone(rec),
      id,
      parents: parents.map((p) => ({ id: p })),
      committerTimestamp: t,
      authorTimestamp: t,
      author,
    });
    const values = [
      mk("b".repeat(40), ["a".repeat(40)], 20),
      mk("a".repeat(40), ["e".repeat(40)], 10),
      mk("d".repeat(40), ["b".repeat(40), "c".repeat(40)], 15),
      mk("c".repeat(40), ["a".repeat(40)], 30, { name: "Outside Author", emailAddress: "x@example.test" }),
    ];
    const r = await setup(pageRoutes(`${PR_PATH}/commits`, pages(values, [3, 1], "null"))).listCommits(PR_REF);
    expect(r.complete).toBe(true);
    expect(r.items.map((c) => c.hash[0])).toEqual(["d", "c", "b", "a"]);
    expect(r.items[1]).toMatchObject({ authorSlug: null, authorName: "Outside Author" });
  });

  test("changes map path, srcPath, and type", async () => {
    const recorded = await setup({ [key("GET", `${PR_PATH}/changes`)]: fixture("pull-request-changes.json") }).listChanges(PR_REF);
    expect(recorded).toEqual({ complete: true, items: [{ path: "sample1.md", srcPath: null, type: "MODIFY" }] });
    const body = clone(fixture<{ values: Record<string, unknown>[] }>("pull-request-changes.json"));
    const [v] = body.body.values;
    body.body.values.push({ ...clone(v), type: "MOVE", path: { toString: "b/new.md" }, srcPath: { toString: "a/old.md" } });
    const r = await setup({ [key("GET", `${PR_PATH}/changes`)]: body }).listChanges(PR_REF);
    expect(r.items[1]).toEqual({ path: "b/new.md", srcPath: "a/old.md", type: "MOVE" });
  });
});
