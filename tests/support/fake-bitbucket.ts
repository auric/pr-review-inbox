// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fake Bitbucket Server for tests. It listens on 127.0.0.1 only and replays fixture payloads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/server/review/git";

const TLS_DIR = join(import.meta.dir, "../../fixtures/tls");
export const TEST_CA_FILE = join(TLS_DIR, "ca.pem");
export const FAKE_TOKEN = "fake-token-0123456789abcdef";
export const FAKE_USER = "jdoe";

// body: a Uint8Array goes out as these bytes. Other values go out as JSON.
export type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number }
  // Holds the request until release() or stop().
  | { hang: true }
  // Sends the status line, then resets the connection mid-body.
  | { drop: true };

export type Route = Reply | ((req: Request) => Reply | Promise<Reply>);

// port: absent picks a free port.
export type FakeOptions = { routes?: Record<string, Route>; https?: boolean; port?: number };

// A route key is "METHOD /path" or "METHOD /path start=N". The start form wins.
// "METHOD /dir/*" matches any last path segment when no exact key matches.
export const key = (method: string, path: string, start?: number) => `${method} ${path}${start === undefined ? "" : ` start=${start}`}`;

export function startFakeBitbucket(opts: FakeOptions = {}) {
  const routes: Record<string, Route> = { ...opts.routes };
  const requests: string[] = [];
  let release: () => void = () => {};
  let released = new Promise<void>((r) => {
    release = r;
  });
  const state = {
    routes,
    requests,
    token: FAKE_TOKEN,
    // null omits the X-AUSERNAME header.
    user: FAKE_USER as string | null,
    // null accepts only "Bearer <token>".
    authorized: null as ((req: Request) => boolean) | null,
    inFlight: 0,
    maxInFlight: 0,
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    tls: opts.https
      ? { cert: readFileSync(join(TLS_DIR, "server.pem"), "utf8"), key: readFileSync(join(TLS_DIR, "server.key"), "utf8") }
      : undefined,
    async fetch(req) {
      const url = new URL(req.url);
      const start = url.searchParams.get("start");
      const base = key(req.method, url.pathname);
      requests.push(`${base}${url.search}`);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.authorized ? !state.authorized(req) : req.headers.get("authorization") !== `Bearer ${state.token}`) {
          return Response.json({ errors: [{ message: "Authentication failed." }] }, { status: 401 });
        }
        const route =
          (start !== null ? routes[`${base} start=${start}`] : undefined) ??
          routes[base] ??
          routes[key(req.method, url.pathname.replace(/\/[^/]*$/, "/*"))];
        const reply: Reply =
          typeof route === "function" ? await route(req) : (route ?? { status: 404, body: { errors: [{ message: "Not found." }] } });
        if ("hang" in reply) {
          await released;
          return new Response(null, { status: 503 });
        }
        const headers = new Headers(state.user === null ? {} : { "X-AUSERNAME": state.user });
        if ("drop" in reply) {
          const body = new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("{"));
              // Bun.serve logs an Error value. An undefined reason resets the connection silently.
              c.error(undefined);
            },
          });
          return new Response(body, { status: 200, headers });
        }
        if (reply.delayMs) await Bun.sleep(reply.delayMs);
        for (const [k, v] of Object.entries(reply.headers ?? {})) headers.set(k, v);
        if (reply.body === undefined) return new Response(null, { status: reply.status, headers });
        if (reply.body instanceof Uint8Array) return new Response(reply.body as Uint8Array<ArrayBuffer>, { status: reply.status, headers });
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers });
      } finally {
        state.inFlight--;
      }
    },
  });

  return Object.assign(state, {
    url: `${opts.https ? "https" : "http"}://127.0.0.1:${server.port}`,
    release() {
      release();
      released = new Promise<void>((r) => {
        release = r;
      });
    },
    stop() {
      release();
      server.stop(true);
    },
  });
}

export type FakeBitbucket = ReturnType<typeof startFakeBitbucket>;

type WriteBody = Record<string, unknown> & {
  title?: string;
  description?: string;
  version?: number;
  fromRef?: Record<string, unknown> & { id: string };
  toRef?: Record<string, unknown> & { id: string };
  reviewers?: { user: { name: string } }[];
};

// The write endpoints of one repository (spec.md section 6.9), shaped as Gates G1 to G6 recorded them (integration-check.md "Review v2").
// Create: HTTP 201, version 0, state OPEN. The PR author leaves the reviewers without an error (U74). A second open PR of the same refs: 409.
// PUT and reopen: version + 1, or 409 on a stale version. Build stats: the five keys of Data Center 9.x. writes: each write body.
// o.defaultBranch: absent gives main, null gives none. o.branches: more branch names. o.writable: false hides it from REPO_WRITE.
// o.restrictions: the branch restriction values; absent gives HTTP 401 AuthorisationException, as Gate G15 recorded for a plain token.
// o.clone: other clone links in place of the http and ssh links of the fake.
export function repoWrites(
  fake: FakeBitbucket,
  project = "PROJ",
  repo = "repo",
  o: {
    defaultBranch?: string | null;
    branches?: string[];
    writable?: boolean;
    restrictions?: unknown[];
    clone?: { href: string; name: string }[];
  } = {},
) {
  const path = `/rest/api/1.0/projects/${project}/repos/${repo}`;
  const user = (name: string) => ({
    name,
    slug: name.toLowerCase(),
    displayName: `User ${name}`,
    links: { self: [{ href: `${fake.url}/users/${name}` }] },
  });
  const repository = {
    slug: repo,
    project: { key: project },
    links: {
      clone: o.clone ?? [
        { href: `${fake.url}/scm/${project.toLowerCase()}/${repo}.git`, name: "http" },
        { href: `ssh://git@127.0.0.1:7999/${project.toLowerCase()}/${repo}.git`, name: "ssh" },
      ],
      self: [{ href: `${fake.url}/projects/${project}/repos/${repo}/browse` }],
    },
  };
  const ref = (id: string) => ({
    id,
    displayId: id.replace(/^refs\/heads\//, ""),
    latestCommit: "0".repeat(40),
    type: "BRANCH",
    repository,
  });
  const reviewersOf = (body: WriteBody) =>
    (body.reviewers ?? [])
      .map((r) => r.user.name)
      .filter((n) => n !== FAKE_USER)
      .map((n) => ({ user: user(n), role: "REVIEWER", approved: false, status: "UNAPPROVED" }));
  const newPr = (id: number, body: WriteBody) => ({
    id,
    version: 0,
    title: body.title ?? "",
    description: body.description,
    state: "OPEN",
    open: true,
    closed: false,
    draft: false,
    locked: false,
    createdDate: 1_790_000_000_000,
    updatedDate: 1_790_000_000_000,
    fromRef: ref(body.fromRef?.id ?? ""),
    toRef: ref(body.toRef?.id ?? ""),
    author: { user: user(FAKE_USER), role: "AUTHOR", approved: false, status: "UNAPPROVED" },
    reviewers: reviewersOf(body),
    participants: [],
    // As fixtures/bitbucket/dashboard-pull-requests-page.json records them. A test sets mergeResult.outcome to MERGE_CONFLICTED
    // (docs/plans/review-v2/spec.md section 6.18.5; Gate G18 has not verified that value).
    properties: { mergeResult: { outcome: "CLEAN" as string, current: true }, resolvedTaskCount: 0, commentCount: 0, openTaskCount: 0 },
    links: { self: [{ href: `${fake.url}/projects/${project}/repos/${repo}/pull-requests/${id}` }] },
  });
  const prs = new Map<number, ReturnType<typeof newPr>>();
  const builds = new Map<string, Partial<Record<"successful" | "inProgress" | "failed" | "cancelled" | "unknown", number>>>();
  const writes: { method: string; path: string; body: WriteBody }[] = [];
  let nextId = 101;
  const stale = { status: 409, body: { errors: [{ message: "The pull request version is out of date." }] } };
  const read = async (req: Request) => {
    const body = (await req.json()) as WriteBody;
    writes.push({ method: req.method, path: new URL(req.url).pathname, body });
    return body;
  };
  const bump = (pr: ReturnType<typeof newPr>) => {
    pr.version++;
    pr.updatedDate++;
  };

  function register(pr: ReturnType<typeof newPr>) {
    const p = `${path}/pull-requests/${pr.id}`;
    fake.routes[key("GET", p)] = () => ({ status: 200, body: pr });
    fake.routes[key("PUT", p)] = async (req) => {
      const body = await read(req);
      if (body.version !== pr.version) return stale;
      if (body.title !== undefined) pr.title = body.title;
      if (body.description !== undefined) pr.description = body.description;
      if (body.reviewers !== undefined) pr.reviewers = reviewersOf(body);
      if (body.toRef) pr.toRef = ref(body.toRef.id);
      bump(pr);
      return { status: 200, body: pr };
    };
    fake.routes[key("POST", `${p}/reopen`)] = async (req) => {
      await read(req);
      if (Number(new URL(req.url).searchParams.get("version")) !== pr.version) return stale;
      if (pr.state !== "DECLINED") return { status: 409, body: { errors: [{ message: "The pull request is not declined." }] } };
      pr.state = "OPEN";
      bump(pr);
      return { status: 200, body: pr };
    };
  }

  // spec.md section 6.16.10, shaped as Gate G17 recorded it: a merged PR has no properties.mergeCommit, and its MERGED activity carries
  // commit {id, parents, message}. o.activity: the commit of the MERGED activity, null for an activity without one. o.parents: its parent
  // IDs, as forgeMerge returns them. o.property: properties.mergeCommit.id, which the gate did not see.
  function merge(id: number, o: { activity?: string | null; parents?: string[]; property?: string } = {}) {
    const pr = prs.get(id);
    if (!pr) throw new Error(`The fake has no PR ${id}.`);
    pr.state = "MERGED";
    pr.open = false;
    pr.closed = true;
    bump(pr);
    if (o.property) (pr.properties as Record<string, unknown>).mergeCommit = { id: o.property };
    const parents = (o.parents ?? ["0".repeat(40)]).map((p) => ({ id: p }));
    const commit = o.activity ? { commit: { id: o.activity, parents, message: "Merge pull request" } } : {};
    const values = [
      { id: 2, action: "MERGED", createdDate: pr.updatedDate, user: user(FAKE_USER), ...commit },
      { id: 1, action: "OPENED", createdDate: pr.createdDate, user: user(FAKE_USER) },
    ];
    fake.routes[key("GET", `${path}/pull-requests/${id}/activities`)] = {
      status: 200,
      body: { size: values.length, limit: 25, start: 0, isLastPage: true, values },
    };
  }

  fake.routes[key("GET", path)] = { status: 200, body: { ...repository, id: 1, name: repo, scmId: "git", state: "AVAILABLE" } };
  fake.routes[key("POST", `${path}/pull-requests`)] = async (req) => {
    const body = await read(req);
    const twin = [...prs.values()].find((p) => p.state === "OPEN" && p.fromRef.id === body.fromRef?.id && p.toRef.id === body.toRef?.id);
    if (twin)
      return { status: 409, body: { errors: [{ message: "Only one pull request may be open for a given source and target branch." }] } };
    const pr = newPr(nextId++, body);
    prs.set(pr.id, pr);
    register(pr);
    return { status: 201, body: pr };
  };
  fake.routes[key("GET", `${path}/pull-requests`)] = (req) => {
    const q = new URL(req.url).searchParams;
    const at = q.get("at");
    const values = [...prs.values()].filter(
      (p) => p.state === (q.get("state") ?? "OPEN") && (!at || (q.get("direction") === "OUTGOING" ? p.fromRef.id : p.toRef.id) === at),
    );
    return { status: 200, body: { size: values.length, limit: Number(q.get("limit") ?? 25), start: 0, isLastPage: true, values } };
  };
  fake.routes[key("GET", "/rest/build-status/1.0/commits/stats/*")] = (req) => {
    const counts = builds.get(new URL(req.url).pathname.split("/").pop() ?? "");
    return { status: 200, body: { successful: 0, inProgress: 0, failed: 0, cancelled: 0, unknown: 0, ...counts } };
  };

  // spec.md section 6.16.10, shaped as Gates G13 and G14 recorded them: the default branch keys displayId, id, type; branch values
  // with isDefault (not the 9.6 schema's default); filterText matches a part of the name; boostMatches puts the exact match first.
  // defaultBranch null: the repository names none (HTTP 404).
  const branches = { defaultBranch: o.defaultBranch === undefined ? "main" : o.defaultBranch, names: [...(o.branches ?? [])] };
  if (branches.defaultBranch && !branches.names.includes(branches.defaultBranch)) branches.names.unshift(branches.defaultBranch);
  fake.routes[key("GET", `${path}/default-branch`)] = () =>
    branches.defaultBranch
      ? { status: 200, body: { id: `refs/heads/${branches.defaultBranch}`, displayId: branches.defaultBranch, type: "BRANCH" } }
      : { status: 404, body: { errors: [{ message: "The repository has no default branch." }] } };
  fake.routes[key("GET", `${path}/branches`)] = (req) => {
    const q = new URL(req.url).searchParams;
    const filter = q.get("filterText") ?? "";
    const limit = Number(q.get("limit") ?? 25);
    let names = branches.names.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));
    if (filter && q.get("boostMatches") === "true") names = [...names.filter((n) => n === filter), ...names.filter((n) => n !== filter)];
    const values = names.slice(0, limit).map((n) => ({
      id: `refs/heads/${n}`,
      displayId: n,
      type: "BRANCH",
      latestCommit: "0".repeat(40),
      latestChangeset: "0".repeat(40),
      isDefault: n === branches.defaultBranch,
    }));
    return { status: 200, body: { size: values.length, limit, start: 0, isLastPage: names.length <= limit, values } };
  };
  // Gate G15: REPO_READ and REPO_WRITE list a writable repository for a plain token, REPO_ADMIN does not.
  const listed = reposOf(fake);
  listed.push({ ...repository, id: listed.length + 1, name: repo, scmId: "git", state: "AVAILABLE", writable: o.writable ?? true });
  fake.routes[key("GET", "/rest/api/1.0/repos")] = (req) => {
    const q = new URL(req.url).searchParams;
    const permission = q.get("permission");
    const values = listed
      .filter((r) => permission === "REPO_READ" || (permission === "REPO_WRITE" && r.writable))
      .filter((r) => (!q.get("projectkey") || r.project.key === q.get("projectkey")) && (!q.get("name") || r.name === q.get("name")))
      .map(({ writable: _, ...r }) => r);
    return { status: 200, body: { size: values.length, limit: Number(q.get("limit") ?? 25), start: 0, isLastPage: true, values } };
  };

  fake.routes[key("GET", `/rest/branch-permissions/latest/projects/${project}/repos/${repo}/restrictions`)] = () =>
    o.restrictions
      ? { status: 200, body: { size: o.restrictions.length, limit: 100, start: 0, isLastPage: true, values: o.restrictions } }
      : {
          status: 401,
          body: {
            errors: [
              { message: "You are not permitted to access this resource", exceptionName: "com.atlassian.bitbucket.AuthorisationException" },
            ],
          },
        };

  return { path, prs, builds, writes, repository, branches, merge };
}

// The merge of a PR in a bare remote, as Bitbucket writes it (docs/plans/review-v2/spec.md section 6.20.10; Gate G19 confirms the squash
// shape). squash: one commit with one parent, the target head, and the tree of the 3-way merge of target and source. Else a merge commit
// with the target and the source heads as parents. edit: more files in the commit, as a merger who edits the squash. The target branch
// moves to the commit. Pass the result to merge() of repoWrites for the MERGED activity.
export async function forgeMerge(
  r: { remote: string; env: Record<string, string> },
  o: { target: string; source: string; squash: boolean; edit?: Record<string, string> },
): Promise<{ commit: string; parents: string[] }> {
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", r.remote, ...args], { env: r.env, stdin })).trim();
  const target = await g(["rev-parse", `refs/heads/${o.target}`]);
  const source = await g(["rev-parse", `refs/heads/${o.source}`]);
  let tree = (await g(["merge-tree", "--write-tree", target, source])).split("\n")[0] as string;
  if (o.edit) {
    await g(["read-tree", tree]);
    for (const [p, text] of Object.entries(o.edit))
      await g(["update-index", "--add", "--cacheinfo", `100644,${await g(["hash-object", "-w", "--stdin"], text)},${p}`]);
    tree = await g(["write-tree"]);
  }
  const parents = o.squash ? [target] : [target, source];
  const message = o.squash ? `Squash merge of ${o.source}` : `Merge ${o.source}`;
  const commit = await g(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message]);
  await g(["update-ref", `refs/heads/${o.target}`, commit]);
  return { commit, parents };
}

export type FakeBuild = { key: string; state: string; name?: string; url?: string };
const STAT: Record<string, "successful" | "inProgress" | "failed" | "cancelled"> = {
  SUCCESSFUL: "successful",
  INPROGRESS: "inProgress",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

// The build-status reads (docs/plans/ci-builds.md, Layer A), shaped as Gate G3 and the CI probe CI3 recorded them: the five stats keys of
// Data Center 9.x, and list values with dateAdded, description, key, name, state, url. The stats count the statuses of the commit.
// Returns the statuses by commit. repoWrites replaces the stats route, so call this after it.
export function buildStatuses(fake: FakeBitbucket) {
  const statuses = new Map<string, FakeBuild[]>();
  const of = (req: Request) => statuses.get(new URL(req.url).pathname.split("/").pop() ?? "") ?? [];
  fake.routes[key("GET", "/rest/build-status/1.0/commits/stats/*")] = (req) => {
    const counts = { successful: 0, inProgress: 0, failed: 0, cancelled: 0, unknown: 0 };
    for (const s of of(req)) counts[STAT[s.state] ?? "unknown"]++;
    return { status: 200, body: counts };
  };
  fake.routes[key("GET", "/rest/build-status/latest/commits/*")] = (req) => {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 25);
    const all = of(req);
    const values = all.slice(0, limit).map((s, i) => ({ dateAdded: 1_790_000_000_000 + i, description: `Build ${s.key}`, ...s }));
    return { status: 200, body: { size: values.length, limit, start: 0, isLastPage: all.length <= limit, values } };
  };
  return statuses;
}

type ListedRepo = { slug: string; name: string; project: { key: string }; writable: boolean } & Record<string, unknown>;
const listedRepos = new WeakMap<FakeBitbucket, ListedRepo[]>();
const reposOf = (fake: FakeBitbucket) => {
  const l = listedRepos.get(fake) ?? [];
  listedRepos.set(fake, l);
  return l;
};

// Reads a recorded fixture: { status, body }.
export function fixture<T = unknown>(name: string): { status: number; body: T } {
  return JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures/bitbucket", name), "utf8"));
}
