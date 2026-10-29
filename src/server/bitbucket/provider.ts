// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// ForgeProvider for Bitbucket Server. It returns forge-neutral types from src/shared/types.ts.
import { z } from "zod";
import type { BuildCounts, BuildStatus } from "../../shared/build";
import { BRANCH_PAGE, REPO_LIST_MAX, REPO_PAGE } from "../../shared/task";
import {
  anchorSpan,
  type Change,
  type Comment,
  type CommentStatus,
  type Commit,
  type ExcerptLine,
  type ListResult,
  type PrRef,
  type PullRequest,
  type Role,
  type User,
} from "../../shared/types";
import { type ClientOptions, createClient, ForgeError } from "./client";
import { NoCloneLink } from "./errors";
import {
  activity,
  branch,
  buildStats,
  buildStatuses,
  change,
  comment,
  commit,
  defaultBranch,
  page,
  postedComment,
  pullRequest,
  type RawComment,
  type RawDiff,
  repository,
  restriction,
  type user,
} from "./schemas";

const API = "/rest/api/1.0";
const DASHBOARD = `${API}/dashboard/pull-requests`;
// spec.md section 2.8 (S20) and Gate G9: one page of open PRs.
const OPEN_PR_LIMIT = 50;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const HEADS = "refs/heads/";
// docs/plans/ci-builds.md, Layer A: one page of build statuses.
const STATUS_LIMIT = 25;

const repoPath = (project: string, repo: string) => `${API}/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}`;
const prPath = (ref: PrRef) => `${repoPath(ref.project, ref.repo)}/pull-requests/${ref.id}`;
// The ref object of a create or a retarget (spec.md section 6.9, Gates G2 and G4).
const branchRef = (project: string, repo: string, branch: string) => ({
  id: `refs/heads/${branch}`,
  repository: { slug: repo, project: { key: project } },
});
const reviewerList = (names: string[]) => names.map((name) => ({ user: { name } }));
const toUser = (u: z.infer<typeof user>): User => ({ slug: u.slug, name: u.displayName, login: u.name });

const cloneRepo = z.object({
  links: z.object({ clone: z.array(z.object({ href: z.string(), name: z.string() })).optional() }).optional(),
});
const remoteRef = z.object({ id: z.string(), repository: cloneRepo });
const remoteRefs = z.object({ fromRef: remoteRef, toRef: remoteRef });

// plan v3 WP4: the anchor line (a range: its lines) plus 3 lines on each side, each line cut at 500 chars.
const EXCERPT_SIDE = 3;
const EXCERPT_TEXT = 500;
const KIND: Record<string, ExcerptLine["kind"]> = { ADDED: "add", REMOVED: "del", CONTEXT: "ctx" };

// The excerpt of an inline comment from its activity diff. No match gives undefined.
// The row that lists the comment ID in commentIds wins. Else the anchor line names the row. fileType FROM numbers it on the old side.
// Gate v3 U4: a CONTEXT anchor numbers its row on the old side, whatever fileType says. The excerpt still numbers ctx lines on the fileType side.
// Gate A U2: that row is the end of a range. commentIds mark only the end row. The excerpt numbers a range on the new side and marks each row from the span start to the end row.
export function excerptOf(
  diff: RawDiff,
  anchor: { line?: number; lineType?: string; fileType?: string; multilineSpan?: unknown },
  id?: number,
): ExcerptLine[] | undefined {
  if (anchor.line === undefined) return undefined;
  const old = anchor.fileType === "FROM";
  const span = anchorSpan(anchor);
  const want = anchor.lineType === undefined ? undefined : KIND[anchor.lineType];
  const n = (kind: ExcerptLine["kind"], l: { source: number; destination: number }, oldSide: boolean) =>
    kind === "del" || (kind === "ctx" && oldSide) ? l.source : l.destination;
  const hunks = diff.hunks.map((h) =>
    h.segments.flatMap((s) => {
      const kind = KIND[s.type];
      return kind
        ? s.lines.map((l) => ({
            kind,
            n: n(kind, l, old),
            out: n(kind, l, old && !span),
            source: l.source,
            dest: l.destination,
            text: l.line,
            ids: l.commentIds,
          }))
        : [];
    }),
  );
  type Row = (typeof hunks)[number][number];
  const marked = (l: Row) => id !== undefined && !!l.ids?.includes(id);
  const named = (l: Row) =>
    (want === "ctx" ? l.source : l.n) === anchor.line && (want ? l.kind === want : l.kind !== (old ? "add" : "del"));
  for (const match of [marked, named])
    for (const lines of hunks) {
      const at = lines.findIndex(match);
      if (at < 0) continue;
      const start = span ? lines.findIndex((l, i) => i <= at && l.kind !== "del" && l.dest === span.line) : -1;
      const from = start < 0 ? at : start;
      const lo = Math.max(0, from - EXCERPT_SIDE);
      return lines
        .slice(lo, at + EXCERPT_SIDE + 1)
        .map((l, i) => ({ n: l.out, kind: l.kind, text: l.text.slice(0, EXCERPT_TEXT), hit: lo + i >= from && lo + i <= at }));
    }
  return undefined;
}

// Newest first: each commit comes before its parents. Ties go to the newer commit time, then to the hash.
// Gate v3 U15: the server order is not recorded, so it is not used.
export function newestFirst(list: Commit[]): Commit[] {
  const byHash = new Map(list.map((c) => [c.hash, c]));
  const kids = new Map<string, number>();
  for (const c of byHash.values()) for (const p of c.parents) if (byHash.has(p)) kids.set(p, (kids.get(p) ?? 0) + 1);
  const ready = [...byHash.values()].filter((c) => !kids.get(c.hash));
  const out: Commit[] = [];
  while (ready.length) {
    ready.sort((a, b) => b.committedAt - a.committedAt || (a.hash < b.hash ? -1 : 1));
    const c = ready.shift() as Commit;
    out.push(c);
    for (const p of c.parents) {
      const left = (kids.get(p) ?? 0) - 1;
      kids.set(p, left);
      const parent = byHash.get(p);
      if (left === 0 && parent) ready.push(parent);
    }
  }
  return out;
}

// The branch page: the repository browse link with the full ref name, as the file links use `?at=` (Gate v3 U5).
// ponytail: "?at=<ref>" is not verified on a real server, as the file link suffix. Verify it in the browser.
export const branchUrl = (repoUrl: string | undefined, ref: string | undefined): string | undefined =>
  repoUrl && ref ? `${repoUrl.replace(/\/+$/, "")}?at=${encodeURIComponent(ref)}` : undefined;

// A link of another server, such as a CI build page. Only http(s) stays, so the browser never gets a javascript: or file: link.
const httpUrl = (href: string | undefined): string | null => {
  try {
    const u = new URL(href ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};

// A new-side line of the diff between two fixed commits. fromHash: the target head. toHash: the reviewed source head (I8).
// line: the new-side line of an added line, the old-side line of a context line (Gate v3 U4).
export type NewAnchor = { path: string; srcPath: string | null; line: number; lineType: "add" | "ctx"; fromHash: string; toHash: string };
export type NewComment = { text: string; parentId?: number; anchor?: NewAnchor };

// The thread state after a resolve or a reopen, read back from the root comment.
export type ThreadState = { version: number; threadResolved: boolean; threadResolver?: User; threadResolvedAt?: number };
// done: the root comment has the wanted state. from: the version of the first read. put: the app sent a PUT.
// changed: the version moved between the read and the PUT (HTTP 409).
// forbidden: HTTP 401 or 403. gone: no such comment (HTTP 404). ignored: Bitbucket took the PUT, but the state stayed.
export type ResolveResult =
  | { status: "done"; state: ThreadState; from: number; put: boolean }
  | { status: "changed" | "forbidden" | "gone" | "ignored" };

// from, to: branch names without refs/heads/. reviewers: usernames (User.login). The PR author is never a reviewer (U74).
export type NewPullRequest = { title: string; description: string; from: string; to: string; reviewers: string[] };
// dropped: requested usernames that the created PR does not list. Bitbucket drops the PR author without an error (Gate G2, U74).
// exists: an open PR from the same branch to the same target, found after a 409 or after a write with an unknown outcome.
export type CreateResult = { status: "created"; pr: PullRequest; dropped: string[] } | { status: "exists"; pr: PullRequest };
// version: the PR version that the caller read. toBranch: the new target branch (retarget).
export type PrUpdate = { version: number; title?: string; description?: string; reviewers?: string[]; toBranch?: string };
// All zeros: no build reported a status for the commit (spec.md section 6.10).
export type BuildStats = BuildCounts;
// more: the search has more branches than one page.
export type BranchPage = { branches: { name: string; isDefault: boolean }[]; more: boolean };
// config: for git fetch and push only, in the GIT_CONFIG env. It holds the token as an http.extraHeader value.
export type RepoRemote = { url: string; config: [string, string][] };
// A repository with its clone links as Bitbucket gives them (spec.md section 6.16.5, Mapping).
export type RepoInfo = { project: string; slug: string; name: string; clone: { href: string; name: string }[] };
// complete false: the list stopped at REPO_LIST_MAX or at a bad page cursor.
export type RepoList = { repos: RepoInfo[]; complete: boolean };
// A branch restriction (Data Center 9.6 REST): type such as read-only, matcher type such as BRANCH, matcher id such as refs/heads/main.
export type Restriction = { type: string; matcherType: string; matcherId: string };

export function createBitbucketProvider(opts: ClientOptions) {
  const client = createClient(opts);
  const origin = new URL(opts.baseUrl).origin;
  // A GET without threadResolved reads as open.
  const threadState = async (path: string): Promise<ThreadState> => {
    const c = (await client.get(path, comment)).data;
    return {
      version: c.version,
      threadResolved: c.threadResolved ?? false,
      ...(c.threadResolved && c.threadResolver && { threadResolver: toUser(c.threadResolver) }),
      ...(c.threadResolved && typeof c.threadResolvedDate === "number" && { threadResolvedAt: c.threadResolvedDate }),
    };
  };

  // A server link stays only when it has the configured origin.
  const own = (href: string | undefined): string | undefined => {
    try {
      return href && new URL(href).origin === origin ? href : undefined;
    } catch {
      return undefined;
    }
  };

  function toPr(p: z.infer<typeof pullRequest>): PullRequest {
    const repoUrl = own(p.toRef.repository.links?.self?.[0]?.href);
    return {
      ref: { project: p.toRef.repository.project.key, repo: p.toRef.repository.slug, id: p.id },
      version: p.version,
      title: p.title,
      description: p.description,
      state: p.state,
      author: toUser(p.author.user),
      reviewers: p.reviewers.map((r) => ({ ...toUser(r.user), status: r.status, lastReviewedCommit: r.lastReviewedCommit })),
      sourceHead: p.fromRef.latestCommit,
      targetHead: p.toRef.latestCommit,
      sourceBranch: p.fromRef.displayId,
      targetBranch: p.toRef.displayId,
      webUrl: own(p.links?.self?.[0]?.href),
      repoUrl,
      sourceBranchUrl: branchUrl(own(p.fromRef.repository.links?.self?.[0]?.href), p.fromRef.id),
      targetBranchUrl: branchUrl(repoUrl, p.toRef.id),
      authorUrl: own(p.author.user.links?.self?.[0]?.href),
      updatedDate: p.updatedDate,
      mergeResult: p.properties?.mergeResult,
    };
  }

  // The http clone link without user info. Only a link with the configured origin gets the token.
  function httpClone(repo: z.infer<typeof cloneRepo>): string | undefined {
    try {
      const u = new URL(repo.links?.clone?.find((l) => l.name === "http")?.href ?? "");
      u.username = "";
      u.password = "";
      return u.origin === origin ? u.href : undefined;
    } catch {
      return undefined;
    }
  }

  // Gate 0 ls-remote: git takes the token as an http.extraHeader value.
  const gitConfig = (): [string, string][] => [
    ["http.extraHeader", `Authorization: Bearer ${opts.token}`],
    ...(opts.caFile ? [["http.sslCAInfo", opts.caFile] as [string, string]] : []),
  ];

  const toRepo = (r: z.infer<typeof repository>): RepoInfo => ({
    project: r.project.key,
    slug: r.slug,
    name: r.name,
    clone: r.links?.clone ?? [],
  });

  // spec.md section 6.16.5, Gate G16: pages of REPO_PAGE with isLastPage and nextPageStart, at most REPO_LIST_MAX items. A bad cursor
  // stops the list. A failed page throws a ForgeError.
  async function pages<T extends z.ZodType>(path: string, item: T): Promise<{ items: z.infer<T>[]; complete: boolean }> {
    const items: z.infer<T>[] = [];
    let start = 0;
    while (items.length < REPO_LIST_MAX) {
      const p = (await client.get(`${path}${path.includes("?") ? "&" : "?"}start=${start}&limit=${REPO_PAGE}`, page(item))).data;
      items.push(...p.values);
      if (p.isLastPage) return { items: items.slice(0, REPO_LIST_MAX), complete: items.length <= REPO_LIST_MAX };
      if (typeof p.nextPageStart !== "number" || p.nextPageStart <= start) return { items, complete: false };
      start = p.nextPageStart;
    }
    return { items: items.slice(0, REPO_LIST_MAX), complete: false };
  }

  // One page of OPEN PRs of a repository. branch: only the PRs from this branch.
  // Pending Gate G9: the open-PR list of a repository is checked only by the gate fake (spec.md section 2.8).
  async function listOpenPullRequests(project: string, repo: string, branch?: string): Promise<ListResult<PullRequest>> {
    const at = branch === undefined ? "" : `&at=${encodeURIComponent(`refs/heads/${branch}`)}&direction=OUTGOING`;
    const path = `${repoPath(project, repo)}/pull-requests?state=OPEN${at}&limit=${OPEN_PR_LIMIT}`;
    const { data } = await client.get(path, page(pullRequest));
    const items = data.values.map(toPr);
    return data.isLastPage ? { items, complete: true } : { items, complete: false, reason: "page_limit" };
  }

  return {
    // The username of the token owner, from the X-AUSERNAME header. It can differ from the slug.
    async currentUser(): Promise<string> {
      const { headers } = await client.get(`${DASHBOARD}?limit=1`, z.unknown());
      const slug = headers.get("x-ausername");
      if (!slug) throw new ForgeError("auth", DASHBOARD);
      return slug;
    },

    async listDashboard(role: Role): Promise<ListResult<PullRequest>> {
      const r = await client.list(`${DASHBOARD}?state=OPEN&role=${role}`, pullRequest);
      return { ...r, items: r.items.map(toPr) };
    },

    async getPullRequest(ref: PrRef): Promise<PullRequest> {
      return toPr((await client.get(prPath(ref), pullRequest)).data);
    },

    // The git remote for the review workspace (src/server/review/workspace.ts). The PR refs live in the target repository.
    // Only git fetch gets fetchConfig. It holds the token as an http.extraHeader value (Gate 0 ls-remote).
    async gitRemote(ref: PrRef) {
      const { data } = await client.get(prPath(ref), remoteRefs);
      const url = httpClone(data.toRef.repository);
      const sourceUrl = httpClone(data.fromRef.repository);
      if (!url || !sourceUrl) throw new Error("The pull request has no http clone link on the configured server.");
      return { url, sourceUrl, sourceRef: data.fromRef.id, targetRef: data.toRef.id, fetchConfig: gitConfig() };
    },

    // The git remote of a task without a PR (spec.md section 6.9, Gate G1: the http link has the origin of the base URL).
    async repoRemote(project: string, repo: string): Promise<RepoRemote> {
      const url = httpClone((await client.get(repoPath(project, repo), cloneRepo)).data);
      if (!url) throw new NoCloneLink(project, repo);
      return { url, config: gitConfig() };
    },

    listOpenPullRequests,

    // The origin of the configured Bitbucket URL.
    origin,

    // spec.md section 6.16.5, Mapping: a repository by project key and slug, with its clone links. 404 throws a ForgeError.
    async repository(project: string, repo: string): Promise<RepoInfo> {
      return toRepo((await client.get(repoPath(project, repo), repository)).data);
    },

    // spec.md section 6.16.7 step 1, Gates G15 and G16: the repositories that the token can push to. filter: the project key (projectkey
    // since 8.0) and the repository name.
    async writableRepos(filter?: { project: string; name?: string }): Promise<RepoList> {
      const q = filter
        ? `&projectkey=${encodeURIComponent(filter.project)}${filter.name === undefined ? "" : `&name=${encodeURIComponent(filter.name)}`}`
        : "";
      const r = await pages(`${API}/repos?permission=REPO_WRITE${q}`, repository);
      return { repos: r.items.map(toRepo), complete: r.complete };
    },

    // Gate G16: the repositories that the token can read, with their clone links. The mapping of a submodule URL searches them when
    // the candidate key of the URL names no repository with that clone link.
    async readableRepos(): Promise<RepoList> {
      const r = await pages(`${API}/repos?permission=REPO_READ`, repository);
      return { repos: r.items.map(toRepo), complete: r.complete };
    },

    // spec.md section 6.16.7 step 3: the branch restrictions. The search needs REPO_ADMIN; Gate G15 got HTTP 401 for a plain token, which
    // throws a ForgeError of kind auth.
    async restrictions(project: string, repo: string): Promise<Restriction[]> {
      const path = `/rest/branch-permissions/latest/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/restrictions`;
      const r = await pages(path, restriction);
      return r.items.map((x) => ({ type: x.type, matcherType: x.matcher.type.id, matcherId: x.matcher.id }));
    },

    // spec.md section 6.16.10, Gate G13: the default branch name without refs/heads/. A repository without one gives 404 (ForgeError).
    async defaultBranch(project: string, repo: string): Promise<string> {
      const { data } = await client.get(`${repoPath(project, repo)}/default-branch`, defaultBranch);
      return data.id.startsWith(HEADS) ? data.id.slice(HEADS.length) : data.displayId;
    },

    // spec.md section 6.16.3, Gate G14: one page of the branch search, newest change first. An empty filter lists the newest branches.
    async listBranches(project: string, repo: string, filter: string): Promise<BranchPage> {
      const q = filter ? `filterText=${encodeURIComponent(filter)}&boostMatches=true&` : "";
      const path = `${repoPath(project, repo)}/branches?${q}orderBy=MODIFICATION&limit=${BRANCH_PAGE}`;
      const { data } = await client.get(path, page(branch));
      return {
        branches: data.values.map((b) => ({
          name: b.id.startsWith(HEADS) ? b.id.slice(HEADS.length) : b.displayId,
          isDefault: (b.isDefault ?? b.default) === true,
        })),
        more: !data.isLastPage,
      };
    },

    // One POST, never repeated (spec.md section 6.9, Gate G2: HTTP 201 with the PR).
    // A 409 or an unknown outcome reads the open PRs of the branch first. Other errors throw a ForgeError.
    async createPullRequest(project: string, repo: string, input: NewPullRequest): Promise<CreateResult> {
      const body = {
        title: input.title,
        description: input.description,
        fromRef: branchRef(project, repo, input.from),
        toRef: branchRef(project, repo, input.to),
        reviewers: reviewerList(input.reviewers),
      };
      try {
        const pr = toPr(await client.post(`${repoPath(project, repo)}/pull-requests`, body, pullRequest));
        const kept = new Set(pr.reviewers.map((r) => r.login));
        return { status: "created", pr, dropped: input.reviewers.filter((name) => !kept.has(name)) };
      } catch (e) {
        if (!(e instanceof ForgeError)) throw e;
        // client.ts: a timeout, a network error, a 5xx, or a 2xx with a bad body can follow an accepted write.
        const unknown = e.kind === "timeout" || e.kind === "network" || e.kind === "shape" || (e.status ?? 0) >= 500;
        if (e.status !== 409 && !unknown) throw e;
        const open = await listOpenPullRequests(project, repo, input.from).catch(() => null);
        const pr = open?.items.find((p) => p.sourceBranch === input.from && p.targetBranch === input.to);
        if (pr) return { status: "exists", pr };
        throw e;
      }
    },

    // One PUT with the caller's version, never repeated (spec.md section 6.9, Gate G4: HTTP 200, version + 1).
    // A stale version throws a ForgeError with status 409.
    // Gate G4 checked only that a PUT without a title keeps it. A field that the caller leaves out gets its value from a fresh read.
    async updatePullRequest(ref: PrRef, u: PrUpdate): Promise<PullRequest> {
      const read = u.title === undefined || u.description === undefined || u.reviewers === undefined;
      const now = read ? (await client.get(prPath(ref), pullRequest)).data : undefined;
      const title = u.title ?? now?.title;
      const description = u.description ?? now?.description;
      const body = {
        version: u.version,
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        reviewers: reviewerList(u.reviewers ?? now?.reviewers.map((r) => r.user.name) ?? []),
        ...(u.toBranch !== undefined && { toRef: branchRef(ref.project, ref.repo, u.toBranch) }),
      };
      return toPr(await client.put(prPath(ref), body, pullRequest));
    },

    // spec.md section 6.16.10, Gate G17: the merge commit of a merged PR. The commit of the MERGED activity comes first;
    // properties.mergeCommit only when no MERGED activity names a commit. null: Bitbucket names none. A failed read throws.
    async mergeCommit(ref: PrRef): Promise<string | null> {
      const r = await client.list(`${prPath(ref)}/activities`, activity);
      const id = r.items.find((a) => a.action === "MERGED" && a.commit && HASH.test(a.commit.id))?.commit?.id;
      if (id) return id;
      // The MERGED activity can be on a page that the list did not read.
      if (!r.complete) throw r.error instanceof ForgeError ? r.error : new ForgeError("shape", `${prPath(ref)}/activities`);
      const p = (await client.get(prPath(ref), pullRequest)).data.properties?.mergeCommit?.id;
      return p && HASH.test(p) ? p : null;
    },

    // spec.md section 6.8 "Open the PR again". Bitbucket REST docs: POST .../reopen?version=<n>, as decline in the gate cleanup.
    // Not checked on Data Center 9.x. A stale version or a refused reopen throws a ForgeError.
    async reopenPullRequest(ref: PrRef, version: number): Promise<PullRequest> {
      return toPr(await client.post(`${prPath(ref)}/reopen?version=${version}`, {}, pullRequest));
    },

    // spec.md section 6.9, Gate G3: the stats read also counts the statuses of the repository-scoped build POST.
    async buildStats(commitId: string): Promise<BuildStats> {
      if (!HASH.test(commitId)) throw new Error(`Invalid commit hash: ${commitId}`);
      const s = (await client.get(`/rest/build-status/1.0/commits/stats/${commitId}`, buildStats)).data;
      return { successful: s.successful, inProgress: s.inProgress, failed: s.failed, cancelled: s.cancelled ?? 0, unknown: s.unknown ?? 0 };
    },

    // docs/plans/ci-builds.md, Layer A: the first page of statuses of the commit. CI probe CI3: the url path of a Jenkins status does not
    // start with /job/, so the app parses no job path from it and keeps it only as a browser link.
    async buildStatuses(commitId: string): Promise<BuildStatus[]> {
      if (!HASH.test(commitId)) throw new Error(`Invalid commit hash: ${commitId}`);
      const { data } = await client.get(`/rest/build-status/latest/commits/${commitId}?limit=${STATUS_LIMIT}`, buildStatuses);
      return data.values.map((s) => ({ name: s.name || s.key, state: s.state, url: httpUrl(s.url) }));
    },

    // Replies have no activity of their own. They are nested in comment.comments[] of the root comment.
    // Gate v3 U16: a reply carries a copy of the root anchor. The thread comes only from the nesting, so a reply keeps no anchor.
    async listComments(ref: PrRef): Promise<ListResult<Comment>> {
      const r = await client.list(`${prPath(ref)}/activities`, activity);
      const byId = new Map<number, Comment>();
      const visit = (c: RawComment, parentId: number | null, rootId: number, diff: RawDiff | undefined) => {
        const prev = byId.get(c.id);
        if (!prev || c.version > prev.version) {
          const root = parentId === null;
          const excerpt = root && c.anchor && diff ? excerptOf(diff, c.anchor, c.id) : undefined;
          byId.set(c.id, {
            id: c.id,
            version: c.version,
            parentId,
            rootId,
            author: toUser(c.author),
            text: c.text,
            anchor: root ? c.anchor : undefined,
            threadResolved: c.threadResolved ?? false,
            // A reopened thread has threadResolved false, so it drops both.
            ...(root && c.threadResolved && c.threadResolver && { threadResolver: toUser(c.threadResolver) }),
            ...(root && c.threadResolved && typeof c.threadResolvedDate === "number" && { threadResolvedAt: c.threadResolvedDate }),
            createdAt: c.createdDate,
            updatedAt: c.updatedDate,
            severity: c.severity,
            state: c.state,
            ...(excerpt && { excerpt }),
          });
        }
        for (const child of c.comments ?? []) visit(child, c.id, rootId, undefined);
      };
      for (const a of r.items) if (a.comment) visit(a.comment, null, a.comment.id, a.diff);
      return { ...r, items: [...byId.values()] };
    },

    // Read only when the PR heads change (plan v3 WP4).
    async listCommits(ref: PrRef): Promise<ListResult<Commit>> {
      const r = await client.list(`${prPath(ref)}/commits`, commit);
      const items = r.items.map(
        (c): Commit => ({
          hash: c.id,
          parents: c.parents.map((p) => p.id),
          message: c.message,
          authorSlug: c.author.slug ?? null,
          authorName: c.author.displayName ?? c.author.name,
          at: c.authorTimestamp,
          committedAt: c.committerTimestamp,
        }),
      );
      return { ...r, items: newestFirst(items) };
    },

    // Pending Gate G12 for a PR where the token user is neither author nor reviewer (spec.md section 2.8).
    async listChanges(ref: PrRef): Promise<ListResult<Change>> {
      const r = await client.list(`${prPath(ref)}/changes`, change);
      return { ...r, items: r.items.map((c) => ({ path: c.path.toString, srcPath: c.srcPath?.toString ?? null, type: c.type })) };
    },

    // One POST, never repeated. parent makes a reply (Gate 0). The anchor uses diffType COMMIT (Gate 0, integration-check.md:50).
    async createComment(ref: PrRef, c: NewComment): Promise<{ id: number; version: number }> {
      const a = c.anchor;
      const body = {
        text: c.text,
        ...(c.parentId === undefined ? {} : { parent: { id: c.parentId } }),
        ...(a && {
          anchor: {
            path: a.path,
            ...(a.srcPath === null ? {} : { srcPath: a.srcPath }),
            line: a.line,
            lineType: a.lineType === "add" ? "ADDED" : "CONTEXT",
            fileType: "TO",
            diffType: "COMMIT",
            fromHash: a.fromHash,
            toHash: a.toHash,
          },
        }),
      };
      return client.post(`${prPath(ref)}/comments`, body, postedComment);
    },

    // Resolves or reopens the thread of a root comment: GET for a fresh version, PUT {version, threadResolved}, then GET again.
    // Docs (7.21, 9.0): the PUT needs the current version. Only the comment author, the PR author, or a repo admin may change it.
    // Data Center 9.x gate (integration-check.md U62 to U64): the PUT works and keeps the version. A 409 on a stale version is not observed.
    // The second GET decides, so a PUT that Bitbucket takes without a state change gives "ignored", never "done".
    // Other errors throw a ForgeError. Nothing repeats the PUT.
    async setThreadResolved(ref: PrRef, rootId: number, resolved: boolean): Promise<ResolveResult> {
      const path = `${prPath(ref)}/comments/${rootId}`;
      const read = () => threadState(path);
      try {
        const before = await read();
        const from = before.version;
        if (before.threadResolved === resolved) return { status: "done", state: before, from, put: false };
        await client.put(path, { version: before.version, threadResolved: resolved }, z.unknown());
        const after = await read();
        return after.threadResolved === resolved ? { status: "done", state: after, from, put: true } : { status: "ignored" };
      } catch (e) {
        if (!(e instanceof ForgeError)) throw e;
        if (e.status === 409) return { status: "changed" };
        if (e.kind === "auth" || e.kind === "forbidden") return { status: "forbidden" };
        if (e.kind === "not_found") return { status: "gone" };
        throw e;
      }
    },

    // The thread state of a root comment. Errors throw a ForgeError.
    threadState: (ref: PrRef, rootId: number) => threadState(`${prPath(ref)}/comments/${rootId}`),

    // A deleted comment has no tombstone. Only a 404 proves the delete.
    async commentStatus(ref: PrRef, id: number): Promise<CommentStatus> {
      try {
        await client.get(`${prPath(ref)}/comments/${id}`, z.unknown());
        return "present";
      } catch (e) {
        if (e instanceof ForgeError && e.kind === "not_found") return "deleted";
        throw e;
      }
    },
  };
}

export type ForgeProvider = ReturnType<typeof createBitbucketProvider>;
