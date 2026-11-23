// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/stacked-prs.md WP-SK1: the stack detection of loadPrContext (section 5.1) against the fake Bitbucket, and the
// section that prContextFile builds from it. No runner and no live server.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createBitbucketProvider } from "../../src/server/bitbucket/provider";
import { PR_CONTEXT_BYTES, prContextFile } from "../../src/server/review/context-files";
import { clearPeerCache, loadPrContext } from "../../src/server/review/pr-context";
import type { Heads } from "../../src/server/review/run-rows";
import { UNTRUSTED } from "../../src/server/review/workspace";
import { openDb } from "../../src/server/storage/db";
import { FAKE_TOKEN, key, type Reply, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";

const HEAD = "a1b2c3d".padEnd(40, "0");
const BASE = "9f8e7d6".padEnd(40, "0");
const T0 = Date.UTC(2026, 10, 20);
const fakes: { stop: () => void }[] = [];

test("the code under test comes from this checkout", () => {
  console.log(`pr-context.ts from ${Bun.resolveSync("../../src/server/review/pr-context", import.meta.dir)}`);
});

afterEach(() => {
  clearPeerCache();
  for (const f of fakes.splice(0)) f.stop();
});

type PrBody = Record<string, unknown> & { id: number; state: string; fromRef: Record<string, unknown>; toRef: Record<string, unknown> };

function world() {
  const fake = startFakeBitbucket();
  fakes.push(fake);
  const w = repoWrites(fake);
  const db: Database = openDb(":memory:");
  const provider = createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN });
  // Creates the PR on the fake. store: also a pull_request row with these branches.
  const create = async (from: string, to: string, o: { store?: boolean; title?: string; description?: string } = {}) => {
    const res = await fetch(`${fake.url}${w.path}/pull-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: o.title ?? `PR ${from}`,
        description: o.description,
        fromRef: { id: `refs/heads/${from}` },
        toRef: { id: `refs/heads/${to}` },
      }),
    });
    const id = ((await res.json()) as { id: number }).id;
    if (o.store !== false) row(id, from, to, { title: o.title, description: o.description });
    return id;
  };
  const row = (id: number, from: string, to: string, o: { state?: string; title?: string; description?: string; updated?: number } = {}) =>
    (
      db
        .query(
          `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
            source_branch, target_branch, updated_date) VALUES ('PROJ', 'repo', $id, $title, $description, 'anna', 'Anna Kim', 'REVIEWER',
            $state, $head, $base, $from, $to, $updated) RETURNING *`,
        )
        .get({
          id,
          title: o.title ?? `PR ${from}`,
          description: o.description ?? null,
          state: o.state ?? "OPEN",
          head: HEAD,
          base: BASE,
          from,
          to,
          updated: o.updated ?? T0 + id,
        }) as Heads
    ).id;
  const changes = (prId: number, paths: string[]) => {
    const id = (db.query("SELECT id FROM pull_request WHERE pr_id = $id").get({ id: prId }) as { id: number }).id;
    for (const path of paths) db.query("INSERT INTO pr_change (pr, path, type) VALUES ($pr, $path, 'MODIFY')").run({ pr: id, path });
  };
  const heads = (prId: number) => db.query("SELECT * FROM pull_request WHERE pr_id = $id").get({ id: prId }) as Heads;
  const load = (prId: number, o: { stackReads?: boolean; signal?: AbortSignal; stack?: boolean } = {}) =>
    loadPrContext(db, provider, heads(prId), { threads: [] }, o.signal ?? new AbortController().signal, {
      me: "jdoe",
      dataDir: "/tmp/rl-none",
      now: T0,
      stack: o.stack ?? true,
      stackReads: o.stackReads,
    });
  const body = (id: number) => w.prs.get(id) as unknown as PrBody;
  const gets = () => fake.requests.filter((r) => r.startsWith("GET "));
  const searches = () => gets().filter((r) => /\/pull-requests\?/.test(r));
  const changeReads = () =>
    gets()
      .filter((r) => r.includes("/changes"))
      .map((r) => r.replace(/\?.*$/, ""));
  return { fake, w, db, provider, create, row, changes, load, body, gets, searches, changeReads };
}

describe("loadStack before the stack gates (stored rows only)", () => {
  test("AC-SK3: a child with an open stored parent gets the section with the parent first; the confirm read; no search and no change list read", async () => {
    const x = world();
    const a = await x.create("feat/a", "main", { title: "Add the quota parser", description: "Parses the quota." });
    const b = await x.create("feat/b", "feat/a");
    const c = await x.create("feat/c", "feat/b", { title: "Add the Retry-After header", description: "Fills the header." });
    x.changes(a, ["src/quota.ts", "src/quota.test.ts"]);
    x.changes(c, ["src/api/server.ts"]);
    x.fake.requests.length = 0;
    const r = await x.load(b);
    expect(r.stack).toBe(`parent #${a}, 1 children`);
    expect(r.input.stack?.parents.map((p) => [p.prId, p.paths, p.targetRef])).toEqual([
      [a, ["src/quota.test.ts", "src/quota.ts"].sort(), "refs/heads/main"],
    ]);
    expect(r.input.stack?.children.map((p) => [p.prId, p.paths])).toEqual([[c, ["src/api/server.ts"]]]);
    expect(r.input.stack?.notes).toEqual([]);
    // Step 2: this PR and the default branch. Step 8: one read of the stored parent. A stored child needs none.
    expect(x.gets().sort()).toEqual(
      [
        `GET ${x.w.path}/pull-requests/${b}`,
        `GET ${x.w.path}/default-branch`,
        `GET ${x.w.path}/pull-requests/${a}`,
        `GET /rest/build-status/1.0/commits/stats/${HEAD}`,
      ].sort(),
    );
    expect(x.searches()).toEqual([]);
    expect(x.changeReads()).toEqual([]);
    const text = prContextFile(r.input).text;
    expect(text.indexOf("## Pull request")).toBeLessThan(text.indexOf("## Stacked pull requests"));
    expect(text.indexOf("## Stacked pull requests")).toBeLessThan(text.indexOf("## Linked tasks"));
    expect(text).toContain(
      [
        "## Stacked pull requests",
        "",
        `### Parent #${a} "Add the quota parser" by User jdoe (the user), open, updated 2026-09-21`,
        "- Source: feat/a at 0000000. Target: main.",
        "- Changed paths (2): src/quota.test.ts, src/quota.ts.",
        "- Description:",
        "",
        "    Parses the quota.",
        "",
        `### Child #${c} "Add the Retry-After header" by Anna Kim, open, updated 2026-11-20`,
        "- Source: feat/c. Target: feat/b, the source branch of this pull request.",
        "- Changed paths (1): src/api/server.ts.",
        "- Description:",
        "",
        "    Fills the header.",
        "",
        "## Linked tasks",
      ].join("\n"),
    );
  });

  test("AC-SK2 and K3: no stack gives no section and the same bytes as a run without the variant; the default branch stops the walk", async () => {
    const x = world();
    const b = await x.create("feat/b", "main");
    // A merged PR into feat/b and an open PR from main are never part of the stack.
    x.row(900, "feat/x", "feat/b", { state: "MERGED" });
    x.row(901, "main", "release");
    const off = await x.load(b, { stack: false });
    x.fake.requests.length = 0;
    const on = await x.load(b);
    expect(on.stack).toBe("none");
    expect(off.stack).toBeNull();
    expect(on.input.stack).toBeUndefined();
    expect("stack" in on.input).toBe(false);
    expect(prContextFile(on.input).text).toBe(prContextFile(off.input).text);
    // T is the default branch: no candidate read.
    expect(x.gets().filter((g) => g.includes("/pull-requests/9"))).toEqual([]);
  });

  test("AC-SK4: the default branch as source gets no children; a declined or deleted stored candidate gives no parent", async () => {
    const x = world();
    const m = await x.create("main", "release");
    await x.create("feat/x", "main");
    expect((await x.load(m)).stack).toBe("none");

    const y = world();
    const a = await y.create("feat/a", "main");
    const b = await y.create("feat/b", "feat/a");
    y.body(a).state = "DECLINED";
    // A stored row of a PR that the server no longer has.
    y.row(950, "feat/a", "main");
    const r = await y.load(b);
    expect(r.stack).toBe("none");
    expect(y.gets()).toContain(`GET ${y.w.path}/pull-requests/950`);
  });

  test("AC-SK4 and K8: a fork source gets no children search; a parent from a fork is no parent", async () => {
    const x = world();
    const a = await x.create("feat/a", "main");
    const b = await x.create("feat/b", "feat/a");
    await x.create("feat/c", "feat/b");
    const fork = (id: number) => {
      const from = x.body(id).fromRef as { repository: Record<string, unknown> };
      x.body(id).fromRef = { ...from, repository: { ...from.repository, slug: "repo-fork", project: { key: "~ANNA" } } };
    };
    fork(b);
    const r = await x.load(b);
    expect(r.input.stack?.parents.map((p) => p.prId)).toEqual([a]);
    expect(r.input.stack?.children).toEqual([]);
    fork(a);
    expect((await x.load(b)).stack).toBe("none");
  });

  test("K10: several first-level candidates give no parent part; children still count; with no child there is no section", async () => {
    const x = world();
    await x.create("feat/a", "main");
    x.row(960, "feat/a", "develop");
    x.fake.routes[key("GET", `${x.w.path}/pull-requests/960`)] = { status: 200, body: { ...x.body(101), id: 960 } };
    const b = await x.create("feat/b", "feat/a");
    expect((await x.load(b)).stack).toBe("none (2 parent candidates)");
    const c = await x.create("feat/c", "feat/b");
    const r = await x.load(b);
    expect(r.stack).toBe("no parent (2 candidates), 1 children");
    expect(r.input.stack?.parents).toEqual([]);
    expect(r.input.stack?.children.map((p) => p.prId)).toEqual([c]);
    expect(prContextFile(r.input).text).not.toContain("### Parent");
  });

  test("stop rules: several candidates above the parent, a loop, and the cap of 3 PRs up", async () => {
    const x = world();
    const p = await x.create("feat/a", "feat/x");
    const px = await x.create("feat/x", "main");
    x.row(970, "feat/x", "develop");
    x.fake.routes[key("GET", `${x.w.path}/pull-requests/970`)] = { status: 200, body: { ...x.body(px), id: 970 } };
    const b = await x.create("feat/b", "feat/a");
    const r = await x.load(b);
    expect(r.input.stack?.parents.map((q) => q.prId)).toEqual([p]);
    expect(r.input.stack?.notes).toEqual(["Not followed: 2 open pull requests use feat/x as their source branch."]);

    const y = world();
    const yb = await y.create("feat/b", "feat/a");
    const ya = await y.create("feat/a", "feat/b");
    const loop = await y.load(yb);
    expect(loop.input.stack?.parents.map((q) => q.prId)).toEqual([ya]);
    // The parent targets this source branch. It stays out of the children.
    expect(loop.input.stack?.children).toEqual([]);
    expect(loop.input.stack?.notes).toEqual([`Not followed: the chain returns to #${yb}.`]);

    const z = world();
    const zb = await z.create("feat/0", "feat/1");
    const up = [await z.create("feat/1", "feat/2"), await z.create("feat/2", "feat/3"), await z.create("feat/3", "feat/4")];
    const fourth = await z.create("feat/4", "main");
    z.fake.requests.length = 0;
    const capped = await z.load(zb);
    expect(capped.input.stack?.parents.map((q) => q.prId)).toEqual(up);
    expect(capped.input.stack?.notes).toEqual(["The app follows at most 3 pull requests down the stack."]);
    expect(z.gets()).not.toContain(`GET ${z.w.path}/pull-requests/${fourth}`);
    const text = prContextFile(capped.input).text;
    expect(text).toContain(`### Parent of #${up[0]}: #${up[1]} "PR feat/2"`);
    expect(text).toContain(`### Parent of #${up[1]}: #${up[2]} "PR feat/3"`);
    expect(text).toContain("- Source: feat/3. Target: feat/4.");
  });

  test("caps: at most 3 children, newest first, and a count line for the rest", async () => {
    const x = world();
    const b = await x.create("feat/b", "main");
    const kids = [
      await x.create("c1", "feat/b"),
      await x.create("c2", "feat/b"),
      await x.create("c3", "feat/b"),
      await x.create("c4", "feat/b"),
    ];
    const r = await x.load(b);
    expect(r.stack).toBe("no parent, 4 children");
    expect(r.input.stack?.children.map((p) => p.prId)).toEqual(kids.slice(1).reverse());
    expect(r.input.stack?.childrenLeft).toBe(1);
    expect(prContextFile(r.input).text).toContain("1 more child pull requests left out.");
  });

  test("AC-SK5: a failed first read gives no section; a failed read inside a known stack gives a Not read line; Cancel", async () => {
    const x = world();
    const a = await x.create("feat/a", "main");
    const b = await x.create("feat/b", "feat/a");
    const c = await x.create("feat/c", "feat/b");
    const main = key("GET", `${x.w.path}/default-branch`);
    const route = x.fake.routes[main];
    x.fake.routes[main] = { status: 500, body: {} };
    const first = await x.load(b);
    expect(first.stack).toBe("not read (Bitbucket error server 500)");
    expect(first.input.stack).toBeUndefined();

    x.fake.routes[main] = route as NonNullable<typeof route>;
    x.fake.routes[key("GET", `${x.w.path}/pull-requests/${a}`)] = { status: 500, body: {} };
    const inside = await x.load(b);
    expect(inside.stack).toBe("no parent, 1 children");
    expect(inside.input.stack?.children.map((p) => p.prId)).toEqual([c]);
    expect(inside.input.stack?.notes).toEqual([`Not read: the parent of #${b} (Bitbucket error server 500).`]);
    expect(prContextFile(inside.input).text).toContain(`Not read: the parent of #${b} (Bitbucket error server 500).`);

    // Only a failure and no kept PR: no section, the reason in the log part.
    const y = world();
    const ya = await y.create("feat/a", "main");
    const yb = await y.create("feat/b", "feat/a");
    y.fake.routes[key("GET", `${y.w.path}/pull-requests/${ya}`)] = { status: 500, body: {} };
    const lone = await y.load(yb);
    expect(lone.stack).toBe("not read (Bitbucket error server 500)");
    expect(lone.input.stack).toBeUndefined();

    const stop = new AbortController();
    y.fake.routes[key("GET", `${y.w.path}/pull-requests/${yb}`)] = { hang: true };
    const hung = y.load(yb, { signal: stop.signal });
    stop.abort();
    const cancelled = await hung;
    expect(cancelled.stack).toBe("not read (the run was cancelled)");
    expect(cancelled.input.stack).toBeUndefined();
  });
});

describe("loadStack after the stack gates (stackReads)", () => {
  test("AC-SK8: the branch searches join the stored rows by PR number; a listed PR needs no confirm read; the change lists are cached", async () => {
    const x = world();
    const a = await x.create("feat/a", "main", { store: false });
    const b = await x.create("feat/b", "feat/a");
    const c = await x.create("feat/c", "feat/b");
    const d = await x.create("feat/d", "feat/b", { store: false });
    x.changes(c, ["src/c.ts"]);
    const listed = (id: number, path: string) => {
      x.fake.routes[key("GET", `${x.w.path}/pull-requests/${id}/changes`)] = {
        status: 200,
        body: { size: 1, limit: 50, start: 0, isLastPage: true, values: [{ path: { toString: path }, type: "MODIFY" }] },
      };
    };
    listed(a, "src/a.ts");
    listed(d, "src/d.ts");
    x.fake.requests.length = 0;
    const r = await x.load(b, { stackReads: true });
    expect(r.input.stack?.parents.map((p) => [p.prId, p.paths])).toEqual([[a, ["src/a.ts"]]]);
    expect(r.input.stack?.children.map((p) => [p.prId, p.paths]).sort()).toEqual(
      [
        [c, ["src/c.ts"]],
        [d, ["src/d.ts"]],
      ].sort(),
    );
    // The walk stops at main, the default branch, with no search for it.
    expect(x.searches().sort()).toEqual(
      [
        `GET ${x.w.path}/pull-requests?state=OPEN&at=refs%2Fheads%2Ffeat%2Fa&direction=OUTGOING&limit=50`,
        `GET ${x.w.path}/pull-requests?state=OPEN&at=refs%2Fheads%2Ffeat%2Fb&direction=INCOMING&limit=50`,
      ].sort(),
    );
    // No confirm read of a listed PR. The stored child c needs no change list read.
    expect(x.gets()).not.toContain(`GET ${x.w.path}/pull-requests/${a}`);
    expect(x.changeReads().sort()).toEqual(
      [`GET ${x.w.path}/pull-requests/${a}/changes`, `GET ${x.w.path}/pull-requests/${d}/changes`].sort(),
    );
    x.fake.requests.length = 0;
    await x.load(b, { stackReads: true });
    expect(x.changeReads()).toEqual([]);
    // A failed change list read gives a Not read line, and the stack stays.
    clearPeerCache();
    x.fake.routes[key("GET", `${x.w.path}/pull-requests/${a}/changes`)] = { status: 500, body: {} };
    const failed = await x.load(b, { stackReads: true });
    expect(failed.input.stack?.parents[0]?.paths).toBeNull();
    expect(failed.input.stack?.notes).toEqual([`Not read: the changed paths of #${a} (Bitbucket error server 500).`]);
  });

  test("AC-SK5: a failed children search inside a known stack gives its Not read line", async () => {
    const x = world();
    const a = await x.create("feat/a", "main");
    const b = await x.create("feat/b", "feat/a");
    x.changes(a, ["src/a.ts"]);
    const list = key("GET", `${x.w.path}/pull-requests`);
    const route = x.fake.routes[list] as (req: Request) => Reply;
    x.fake.routes[list] = (req) => (new URL(req.url).searchParams.get("direction") === "INCOMING" ? { status: 500, body: {} } : route(req));
    const r = await x.load(b, { stackReads: true });
    expect(r.input.stack?.parents.map((p) => p.prId)).toEqual([a]);
    expect(r.input.stack?.notes).toEqual(["Not read: the child pull requests (Bitbucket error server 500)."]);
  });

  test("AC-SK6: with a stack, the whole file stays within PR_CONTEXT_BYTES", async () => {
    const x = world();
    const a = await x.create("feat/a", "main", { description: "D".repeat(4000) });
    const b = await x.create("feat/b", "feat/a", { description: "E".repeat(9000) });
    x.changes(
      a,
      Array.from({ length: 40 }, (_, k) => `src/${k}/`.padEnd(300, "x")),
    );
    for (let k = 0; k < 300; k++)
      x.db
        .query(
          "INSERT INTO comment (pr, comment_id, version, root_id, author_slug, author_name, text, thread_resolved, created_at, updated_at) VALUES ((SELECT id FROM pull_request WHERE pr_id = $b), $id, 0, $id, 'anna', 'Anna Kim', $text, 0, $id, $id)",
        )
        .run({ b, id: 1000 + k, text: "T".repeat(400) });
    const r = await x.load(b);
    const f = prContextFile(r.input);
    expect(f.text).toContain("## Stacked pull requests");
    expect(f.left).toBeGreaterThan(0);
    expect(Buffer.byteLength(UNTRUSTED + f.text)).toBeLessThanOrEqual(PR_CONTEXT_BYTES);
  });

  test("K8: a listed child from a fork is listed; a listed parent from a fork is not", async () => {
    const x = world();
    const a = await x.create("feat/a", "main", { store: false });
    const b = await x.create("feat/b", "feat/a");
    const c = await x.create("feat/c", "feat/b", { store: false });
    for (const id of [a, c]) {
      const from = x.body(id).fromRef as { repository: Record<string, unknown> };
      x.body(id).fromRef = { ...from, repository: { ...from.repository, slug: "repo-fork", project: { key: "~ANNA" } } };
    }
    const r = await x.load(b, { stackReads: true });
    expect(r.input.stack?.parents).toEqual([]);
    expect(r.input.stack?.children.map((p) => p.prId)).toEqual([c]);
  });
});

describe("prContextFile with a stack", () => {
  test("AC-SK9: a PR of the stack section is not in the peer section", async () => {
    const x = world();
    const a = await x.create("feat/a", "main");
    const b = await x.create("feat/b", "feat/a");
    x.changes(a, ["src/quota.ts"]);
    x.changes(b, ["src/quota.ts"]);
    const r = await x.load(b);
    expect(r.input.peers.map((p) => p.prId)).toEqual([a]);
    const text = prContextFile(r.input).text;
    expect(text).toContain(`### Parent #${a}`);
    expect(text).toContain("## Other open pull requests that change the same files\n\nNone found.");
  });
});
