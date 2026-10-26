// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task write calls of the provider (spec.md section 6.9) against the fake Bitbucket. No network.
import { afterEach, describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/server/bitbucket/client";
import { NoCloneLink, type WriteProblem, writeProblem } from "../../src/server/bitbucket/errors";
import { createBitbucketProvider } from "../../src/server/bitbucket/provider";
import { MERGE_CONFLICTED } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, type FakeBitbucket, key, repoWrites, startFakeBitbucket, TEST_CA_FILE } from "../support/fake-bitbucket";

process.env.REVIEW_LOOP_SECRETS = "memory";

const HEAD = "a".repeat(40);
let fake: FakeBitbucket;
afterEach(() => fake?.stop());

function setup(opts: { caFile?: string; timeoutMs?: number } = {}) {
  fake = startFakeBitbucket();
  const repo = repoWrites(fake);
  const provider = createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN, ...opts });
  return { provider, repo };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

const input = (reviewers: string[] = ["asmith"]) => ({
  title: "ABC-1: Add the cache",
  description: "Part goal.",
  from: "feature/ABC-1-add-cache",
  to: "main",
  reviewers,
});

describe("repoRemote", () => {
  test("gives the http clone link of the configured origin and the token only in the git config", async () => {
    const { provider, repo } = setup({ caFile: TEST_CA_FILE });
    const r = await provider.repoRemote("PROJ", "repo");
    expect(r.url).toBe(repo.repository.links.clone[0]?.href as string);
    expect(r.url).not.toContain(FAKE_TOKEN);
    expect(r.config).toEqual([
      ["http.extraHeader", `Authorization: Bearer ${FAKE_TOKEN}`],
      ["http.sslCAInfo", TEST_CA_FILE],
    ]);
  });

  test("strips user info from the link", async () => {
    const { provider, repo } = setup();
    repo.repository.links.clone[0] = { name: "http", href: `${fake.url.replace("://", "://jdoe:secret@")}/scm/proj/repo.git` };
    const r = await provider.repoRemote("PROJ", "repo");
    expect(r.url).toBe(`${fake.url}/scm/proj/repo.git`);
  });

  test("a link of another origin or no http link gives the spec sentence", async () => {
    const { provider, repo } = setup();
    repo.repository.links.clone[0] = { name: "http", href: "https://elsewhere.example.invalid/scm/proj/repo.git" };
    const e = await caught(provider.repoRemote("PROJ", "repo"));
    expect(e).toBeInstanceOf(NoCloneLink);
    expect((e as Error).message).toBe("Bitbucket gives no https clone link for PROJ/repo.");
    expect(writeProblem(e, "create", { project: "PROJ", repo: "repo" })).toEqual({
      sentence: "Bitbucket gives no https clone link for PROJ/repo.",
      button: "Open settings",
    });
    repo.repository.links.clone.splice(0, 1);
    expect(await caught(provider.repoRemote("PROJ", "repo"))).toBeInstanceOf(NoCloneLink);
  });
});

describe("createPullRequest", () => {
  test("sends the body of spec.md 6.9 and reads the PR back", async () => {
    const { provider, repo } = setup();
    const r = await provider.createPullRequest("PROJ", "repo", input());
    expect(repo.writes).toEqual([
      {
        method: "POST",
        path: `${repo.path}/pull-requests`,
        body: {
          title: "ABC-1: Add the cache",
          description: "Part goal.",
          fromRef: { id: "refs/heads/feature/ABC-1-add-cache", repository: { slug: "repo", project: { key: "PROJ" } } },
          toRef: { id: "refs/heads/main", repository: { slug: "repo", project: { key: "PROJ" } } },
          reviewers: [{ user: { name: "asmith" } }],
        },
      },
    ]);
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    expect(r.dropped).toEqual([]);
    expect(r.pr).toMatchObject({
      ref: { project: "PROJ", repo: "repo", id: 101 },
      version: 0,
      state: "OPEN",
      sourceBranch: "feature/ABC-1-add-cache",
      targetBranch: "main",
      author: { login: FAKE_USER },
    });
    expect(r.pr.reviewers.map((x) => x.login)).toEqual(["asmith"]);
  });

  test("reads properties.mergeResult: CLEAN after the create, CONFLICTED when the server reports it (spec.md section 6.18.5)", async () => {
    const { provider, repo } = setup();
    const r = await provider.createPullRequest("PROJ", "repo", input());
    if (r.status !== "created") throw new Error("not created");
    expect(r.pr.mergeResult).toEqual({ outcome: "CLEAN", current: true });
    const pr = repo.prs.get(r.pr.ref.id);
    if (pr) pr.properties.mergeResult = { outcome: MERGE_CONFLICTED, current: false };
    expect((await provider.getPullRequest(r.pr.ref)).mergeResult).toEqual({ outcome: "CONFLICTED", current: false });
    // Another shape is no error: the PR then has no merge result.
    if (pr) (pr.properties as unknown as Record<string, unknown>).mergeResult = { outcome: 1 };
    expect((await provider.getPullRequest(r.pr.ref)).mergeResult).toBeUndefined();
  });

  test("reports the PR author as a dropped reviewer (U74)", async () => {
    const { provider } = setup();
    const r = await provider.createPullRequest("PROJ", "repo", input([FAKE_USER, "asmith"]));
    expect(r).toMatchObject({ status: "created", dropped: [FAKE_USER] });
  });

  test("a 409 for an open PR of the same branches links that PR and posts once", async () => {
    const { provider, repo } = setup();
    await provider.createPullRequest("PROJ", "repo", input());
    const r = await provider.createPullRequest("PROJ", "repo", input());
    expect(r.status).toBe("exists");
    expect(r.pr.ref.id).toBe(101);
    expect(repo.writes).toHaveLength(2);
    expect(fake.requests.at(-1)).toBe(
      `GET ${repo.path}/pull-requests?state=OPEN&at=${encodeURIComponent("refs/heads/feature/ABC-1-add-cache")}&direction=OUTGOING&limit=50`,
    );
  });

  test("a 409 without a matching open PR throws", async () => {
    const { provider, repo } = setup();
    fake.routes[key("POST", `${repo.path}/pull-requests`)] = { status: 409, body: { errors: [{ message: "Conflict." }] } };
    const e = await caught(provider.createPullRequest("PROJ", "repo", input()));
    expect(e).toBeInstanceOf(ForgeError);
    expect((e as ForgeError).status).toBe(409);
  });

  test("a timeout reads the open PRs of the branch and never posts again", async () => {
    const { provider, repo } = setup({ timeoutMs: 300 });
    const create = fake.routes[key("POST", `${repo.path}/pull-requests`)];
    if (typeof create !== "function") throw new Error("no create route");
    fake.routes[key("POST", `${repo.path}/pull-requests`)] = async (req) => {
      await create(req);
      return { status: 201, body: {}, delayMs: 1_000 };
    };
    const r = await provider.createPullRequest("PROJ", "repo", input());
    expect(r).toMatchObject({ status: "exists", pr: { ref: { id: 101 } } });
    expect(fake.requests.filter((q) => q.startsWith("POST "))).toHaveLength(1);
  });

  test("an error without an open PR keeps the error", async () => {
    const { provider, repo } = setup();
    fake.routes[key("POST", `${repo.path}/pull-requests`)] = { status: 500 };
    expect(await caught(provider.createPullRequest("PROJ", "repo", input()))).toMatchObject({ kind: "server", status: 500 });
  });
});

describe("updatePullRequest", () => {
  test("retarget sends one PUT with the version, the new toRef, and the fields of a fresh read", async () => {
    const { provider, repo } = setup();
    const created = await provider.createPullRequest("PROJ", "repo", { ...input(), to: "feature/ABC-1-1-lower" });
    const pr = await provider.updatePullRequest(created.pr.ref, { version: 0, toBranch: "main" });
    expect(pr).toMatchObject({ version: 1, targetBranch: "main", title: "ABC-1: Add the cache" });
    expect(repo.writes.at(-1)).toEqual({
      method: "PUT",
      path: `${repo.path}/pull-requests/101`,
      body: {
        version: 0,
        title: "ABC-1: Add the cache",
        description: "Part goal.",
        reviewers: [{ user: { name: "asmith" } }],
        toRef: { id: "refs/heads/main", repository: { slug: "repo", project: { key: "PROJ" } } },
      },
    });
    expect(fake.requests.filter((q) => q.startsWith("PUT "))).toHaveLength(1);
  });

  test("a stale version gives 409 and changes nothing", async () => {
    const { provider, repo } = setup();
    const created = await provider.createPullRequest("PROJ", "repo", input());
    await provider.updatePullRequest(created.pr.ref, { version: 0, title: "ABC-1: New title" });
    const e = await caught(provider.updatePullRequest(created.pr.ref, { version: 0, toBranch: "develop" }));
    expect(e).toBeInstanceOf(ForgeError);
    expect((e as ForgeError).status).toBe(409);
    expect(repo.prs.get(101)?.toRef.id).toBe("refs/heads/main");
    expect(writeProblem(e, "update", { project: "PROJ", repo: "repo", id: 101 }).sentence).toBe(
      "Someone changed pull request #101 in Bitbucket after the app read it. Try again.",
    );
  });

  test("an update with every field skips the read", async () => {
    const { provider, repo } = setup();
    const created = await provider.createPullRequest("PROJ", "repo", input());
    const before = fake.requests.length;
    const pr = await provider.updatePullRequest(created.pr.ref, { version: 0, title: "T", description: "D", reviewers: [] });
    expect(pr).toMatchObject({ title: "T", description: "D", reviewers: [] });
    expect(fake.requests.slice(before)).toEqual([`PUT ${repo.path}/pull-requests/101`]);
  });
});

describe("reopenPullRequest", () => {
  test("reopens a declined PR with its version", async () => {
    const { provider, repo } = setup();
    const created = await provider.createPullRequest("PROJ", "repo", input());
    const raw = repo.prs.get(101);
    if (raw) raw.state = "DECLINED";
    expect(await caught(provider.reopenPullRequest(created.pr.ref, 7))).toMatchObject({ status: 409 });
    expect(await provider.reopenPullRequest(created.pr.ref, 0)).toMatchObject({ state: "OPEN", version: 1 });
    expect(fake.requests.at(-1)).toBe(`POST ${repo.path}/pull-requests/101/reopen?version=0`);
  });
});

describe("buildStats", () => {
  test("a commit without builds gives zeros", async () => {
    const { provider } = setup();
    expect(await provider.buildStats(HEAD)).toEqual({ successful: 0, inProgress: 0, failed: 0, cancelled: 0, unknown: 0 });
    expect(fake.requests).toEqual([`GET /rest/build-status/1.0/commits/stats/${HEAD}`]);
  });

  test("a commit with builds gives the five counts", async () => {
    const { provider, repo } = setup();
    repo.builds.set(HEAD, { successful: 2, inProgress: 1, failed: 1, cancelled: 1, unknown: 3 });
    expect(await provider.buildStats(HEAD)).toEqual({ successful: 2, inProgress: 1, failed: 1, cancelled: 1, unknown: 3 });
  });

  test("cancelled and unknown are optional", async () => {
    const { provider } = setup();
    fake.routes[key("GET", `/rest/build-status/1.0/commits/stats/${HEAD}`)] = {
      status: 200,
      body: { successful: 1, inProgress: 0, failed: 0 },
    };
    expect(await provider.buildStats(HEAD)).toEqual({ successful: 1, inProgress: 0, failed: 0, cancelled: 0, unknown: 0 });
  });

  test("a missing count is a shape error, and a bad hash sends no request", async () => {
    const { provider } = setup();
    fake.routes[key("GET", `/rest/build-status/1.0/commits/stats/${HEAD}`)] = { status: 200, body: { successful: 1 } };
    expect(await caught(provider.buildStats(HEAD))).toMatchObject({ kind: "shape" });
    const before = fake.requests.length;
    expect(await caught(provider.buildStats("../../api/1.0/users"))).toBeInstanceOf(Error);
    expect(fake.requests.length).toBe(before);
  });
});

describe("listOpenPullRequests", () => {
  test("reads one page of open PRs, with or without a branch", async () => {
    const { provider, repo } = setup();
    await provider.createPullRequest("PROJ", "repo", input());
    await provider.createPullRequest("PROJ", "repo", { ...input(), from: "feature/ABC-2-other" });
    expect((await provider.listOpenPullRequests("PROJ", "repo")).items.map((p) => p.ref.id)).toEqual([101, 102]);
    expect(fake.requests.at(-1)).toBe(`GET ${repo.path}/pull-requests?state=OPEN&limit=50`);
    const one = await provider.listOpenPullRequests("PROJ", "repo", "feature/ABC-2-other");
    expect(one).toMatchObject({ complete: true, items: [{ ref: { id: 102 } }] });
  });

  test("a page that is not the last one is incomplete", async () => {
    const { provider, repo } = setup();
    fake.routes[key("GET", `${repo.path}/pull-requests`)] = {
      status: 200,
      body: { start: 0, isLastPage: false, nextPageStart: 50, values: [] },
    };
    expect(await provider.listOpenPullRequests("PROJ", "repo")).toEqual({ items: [], complete: false, reason: "page_limit" });
  });
});

describe("error mapping (AC-B23)", () => {
  const at = { project: "PROJ", repo: "repo", id: 101 };
  const cases: [number, ForgeError["kind"], WriteProblem["button"]][] = [
    [401, "auth", "Open settings"],
    [403, "forbidden", "Try again"],
    [404, "not_found", "Try again"],
    [409, "server", "Try again"],
    [429, "rate", "Try again"],
  ];

  for (const [status, kind, button] of cases)
    test(`HTTP ${status} of create and update gives the kind ${kind}, one sentence, and one button`, async () => {
      const { provider, repo } = setup();
      fake.routes[key("POST", `${repo.path}/pull-requests`)] = { status, body: { errors: [{ message: "No." }] } };
      fake.routes[key("PUT", `${repo.path}/pull-requests/101`)] = { status, body: { errors: [{ message: "No." }] } };
      const create = await caught(provider.createPullRequest("PROJ", "repo", input()));
      const update = await caught(provider.updatePullRequest(at, { version: 0, title: "T", description: "D", reviewers: [] }));
      for (const [e, action] of [
        [create, "create"],
        [update, "update"],
      ] as const) {
        expect(e).toMatchObject({ kind, status });
        const p = writeProblem(e, action, at);
        expect(p.button).toBe(button);
        expect(p.sentence).toMatch(/^[A-Z].*\.$/);
        expect(p.sentence).not.toContain(FAKE_TOKEN);
      }
    });

  test("the sentences of spec.md 6.9 and the token sentence", () => {
    const e = (status: number, kind: ForgeError["kind"]) => new ForgeError(kind, "/x", status);
    expect(writeProblem(e(403, "forbidden"), "create", at).sentence).toBe(
      "The token cannot create pull requests in PROJ/repo. Give it Repository write in Bitbucket, then try again.",
    );
    expect(writeProblem(e(401, "auth"), "update", at)).toEqual({
      sentence: "Bitbucket rejected the token. Enter a new token in Settings.",
      button: "Open settings",
    });
    const kinds = [
      [403, "forbidden"],
      [404, "not_found"],
      [409, "server"],
    ] as const;
    const all = kinds.flatMap(([s, k]) => (["create", "update"] as const).map((a) => writeProblem(e(s, k), a, at).sentence));
    expect(new Set(all).size).toBe(6);
  });
});
