// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The repositories of a task (docs/plans/review-v2/spec.md section 6.16.5, design.md B20): the gitlinks of a commit, the submodule
// URLs of .gitmodules in that commit, the mapping to Bitbucket repositories without guesses, the access of each repository, the fetch
// per repository, and the task_repo rows. The app never runs `git submodule` and never reads .gitmodules from disk.
import type { Database } from "bun:sqlite";
import type { TaskPrDto, TaskRepoDto } from "../../shared/dto";
import { REPO_REASON, type RepoAccess, type RepoRole } from "../../shared/task";
import { ForgeError } from "../bitbucket/client";
import type { ForgeProvider, RepoInfo } from "../bitbucket/provider";
import { git } from "../review/git";
import {
  type BranchRemote,
  cachePath,
  fetchInto,
  gitSetup,
  type LongGit,
  locked,
  longPath,
  remoteHead,
  type SnapshotRepo,
  WorkspaceError,
} from "../review/workspace";

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// workspace.ts NAME: project keys and slugs become folder names of the cache.
const NAME = /^[A-Za-z0-9~_][A-Za-z0-9._~-]*$/;
// spec.md section 6.16.7 step 1: the app keeps a write check for 10 minutes.
export const WRITE_TTL_MS = 10 * 60_000;

export type RepoProvider = Pick<ForgeProvider, "origin" | "repository" | "writableRepos" | "readableRepos" | "defaultBranch">;

// ---------- URLs (git-submodule(1), git-clone(1) "GIT URLS") ----------

// A gitlink of a commit: path, pinned commit, and the URL that .gitmodules of the same commit gives for the path.
export type Gitlink = { path: string; pinned: string; url: string | null };

// The gitlinks (mode 160000) of commit with `git ls-tree -r -z`, and their URLs with `git config --blob <commit>:.gitmodules --null
// --list`. A missing or broken .gitmodules gives URL null.
export async function readGitlinks(cache: string, env: Record<string, string>, commit: string): Promise<Gitlink[]> {
  if (!HASH.test(commit)) throw new WorkspaceError(`Invalid commit hash: ${commit}`);
  const tree = await git([`--git-dir=${cache}`, "ls-tree", "-r", "-z", "--full-tree", commit], { env });
  const links: { path: string; pinned: string }[] = [];
  for (const rec of tree.split("\0")) {
    const m = /^160000 commit ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([\s\S]+)$/.exec(rec);
    if (m) links.push({ path: m[2] as string, pinned: m[1] as string });
  }
  if (!links.length) return [];
  // git-config(1): --blob reads the file of a commit, and --no-includes leaves out include.path. With --null, an entry is
  // "<key>\n<value>\0".
  const text = await git([`--git-dir=${cache}`, "config", "--no-includes", `--blob=${commit}:.gitmodules`, "--null", "--list"], {
    env,
  }).catch(() => "");
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const e of text.split("\0")) {
    const nl = e.indexOf("\n");
    const m = /^submodule\.([\s\S]+)\.(path|url)$/.exec(nl < 0 ? "" : e.slice(0, nl));
    if (!m) continue;
    const entry = byName.get(m[1] as string) ?? {};
    entry[m[2] as "path" | "url"] = e.slice(nl + 1);
    byName.set(m[1] as string, entry);
  }
  const urls = new Map<string, string>();
  for (const e of byName.values()) if (e.path && e.url) urls.set(e.path.replace(/\/+$/, ""), e.url);
  return links.map((l) => ({ ...l, url: urls.get(l.path) ?? null }));
}

export const isRelativeUrl = (url: string) => url.startsWith("./") || url.startsWith("../");

// git-submodule(1), relative URL: "./" and "../" resolve against the URL of the superproject. Each "../" drops the last path part of
// that URL. null: the URL climbs above the host.
export function relativeUrl(parent: string, url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/.*)?$/i.exec(parent.replace(/\/+$/, ""));
  if (!m) return null;
  const parts = (m[2] ?? "").split("/").filter(Boolean);
  let rest = url;
  for (;;) {
    if (rest.startsWith("../")) {
      if (!parts.length) return null;
      parts.pop();
      rest = rest.slice(3);
    } else if (rest.startsWith("./")) rest = rest.slice(2);
    else break;
  }
  return [m[1], ...parts, rest].join("/");
}

// spec.md section 6.16.5: a URL without user info, with the scheme and the host in lowercase. null: no "<scheme>://" URL, such as the
// scp-like form git@host:path.
export function normalizeUrl(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]*@)?([^/]*)(\/[\s\S]*)?$/i.exec(url.trim());
  return m ? `${(m[1] as string).toLowerCase()}://${(m[2] as string).toLowerCase()}${m[3] ?? ""}` : null;
}

// The URL without user info, for task_repo.url. The scp-like form loses its "user@" part.
export const withoutUser = (url: string) => normalizeUrl(url) ?? url.trim().replace(/^[^@/:]+@/, "");

// The host name without port of a URL, also of the scp-like form [user@]host:path. null: no host.
export function hostOf(url: string): string | null {
  const n = normalizeUrl(url);
  const host = n ? (/^[^:]+:\/\/([^/]*)/.exec(n)?.[1] ?? "") : (/^(?:[^@/]+@)?([^:/]+):/.exec(url.trim())?.[1] ?? "");
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d*$/, "");
  return name ? name.toLowerCase() : null;
}

// spec.md section 6.16.5: the last two path parts of the URL as the candidate project key and slug. A Bitbucket clone link ends with
// "<slug>.git", so the slug loses that ending.
export function candidate(url: string): { project: string; repo: string } | null {
  const parts = (/^[^:]+:\/\/[^/]*(\/.*)?$/.exec(url)?.[1] ?? "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const project = parts[parts.length - 2] as string;
  const repo = (parts[parts.length - 1] as string).replace(/\.git$/i, "");
  return NAME.test(project) && NAME.test(repo) ? { project, repo } : null;
}

// spec.md section 6.16.5: the repository maps only when one of its clone links equals the URL after normalizeUrl, both without one
// trailing "/" and then one trailing ".git".
const repoKey = (url: string | null) => url?.replace(/\/$/, "").replace(/\.git$/, "") ?? null;
export const cloneMatch = (info: RepoInfo, url: string) => info.clone.some((c) => repoKey(normalizeUrl(c.href)) === repoKey(url));

// ---------- Write permission (spec.md section 6.16.7 step 1, Gate G15) ----------

const writes = new Map<string, { at: number; ok: boolean }>();

// true: GET /rest/api/1.0/repos?permission=REPO_WRITE with the project key lists the repository by its slug. name: the repository name
// narrows the list when the caller knows it; without it, the slug match stays exact. The result stays WRITE_TTL_MS. A failed read throws.
export async function canWrite(
  p: Pick<RepoProvider, "origin" | "writableRepos">,
  r: Pick<RepoInfo, "project" | "slug"> & { name?: string },
  now = Date.now(),
): Promise<boolean> {
  const k = `${p.origin} ${r.project}/${r.slug}`;
  const hit = writes.get(k);
  if (hit && now - hit.at < WRITE_TTL_MS) return hit.ok;
  const list = await p.writableRepos({ project: r.project, ...(r.name !== undefined && { name: r.name }) });
  const ok = list.repos.some((x) => x.project === r.project && x.slug === r.slug);
  writes.set(k, { at: now, ok });
  return ok;
}

// ---------- Rows ----------

export type TaskRepoRow = {
  id: number;
  task: number;
  role: RepoRole;
  project: string | null;
  repo: string | null;
  url: string | null;
  parent: number | null;
  path: string | null;
  depth: number;
  access: RepoAccess;
  reason: string | null;
  base_branch: string | null;
  base_commit: string | null;
  pinned: string | null;
  source: number | null;
  proposal: "proposed" | "added" | "skipped" | null;
  proposal_reason: string | null;
  // 1: "Pick a base branch" changed base_branch after commits on the old base (spec.md section 6.16.7).
  base_changed: number;
};

const Q = {
  // A proposed or skipped repository is no repository of the task (spec.md section 6.16.5, Proposals). The main row comes first: an
  // added row has depth 0 too.
  rows: `SELECT * FROM task_repo WHERE task = $task AND (proposal IS NULL OR proposal = 'added')
    ORDER BY depth, role <> 'main', id`,
  all: "SELECT * FROM task_repo WHERE task = $task ORDER BY depth, role <> 'main', id",
  main: "SELECT id FROM task_repo WHERE task = $task AND role = 'main'",
  mainInsert: `INSERT INTO task_repo (task, role, project, repo, depth, access, base_branch, base_commit, created_at)
    VALUES ($task, 'main', $project, $repo, 0, 'edit', $base, $commit, $now)`,
  mainUpdate: "UPDATE task_repo SET base_branch = $base, base_commit = $commit WHERE id = $id",
  dropSubs: "DELETE FROM task_repo WHERE task = $task AND role = 'submodule'",
  // The base pick of each mapped submodule stays for the next resolve (spec.md section 6.16.3, Picker).
  subBases: "SELECT project, repo, base_branch FROM task_repo WHERE task = $task AND role = 'submodule' AND project IS NOT NULL",
  added: "SELECT * FROM task_repo WHERE task = $task AND role = 'added' AND proposal = 'added' ORDER BY id",
  addedBase: "UPDATE task_repo SET base_commit = $commit WHERE id = $id",
  insert: `INSERT INTO task_repo (task, role, project, repo, url, parent, path, depth, access, reason, base_branch, base_commit, pinned,
    source, created_at)
    VALUES ($task, 'submodule', $project, $repo, $url, $parent, $path, $depth, $access, $reason, $base, $commit, $pinned, $source, $now)
    RETURNING id`,
  access: "UPDATE task_repo SET access = $access, reason = $reason WHERE id = $id",
};

type TaskRef = { id: number; project: string; repo: string; target_branch: string; base_commit: string | null; created_at: number };

// The rows of a task, the main one first. A task without rows (made before migration 035 ran on it) gets its main row from the task.
export function taskRepos(db: Database, t: TaskRef): TaskRepoRow[] {
  const rows = db.query(Q.rows).all({ task: t.id }) as TaskRepoRow[];
  if (rows.some((r) => r.role === "main")) return rows;
  const main: TaskRepoRow = {
    id: 0,
    task: t.id,
    role: "main",
    project: t.project,
    repo: t.repo,
    url: null,
    parent: null,
    path: null,
    depth: 0,
    access: "edit",
    reason: null,
    base_branch: t.target_branch,
    base_commit: t.base_commit,
    pinned: null,
    source: null,
    proposal: null,
    proposal_reason: null,
    base_changed: 0,
  };
  return [main, ...rows];
}

// spec.md section 6.16.5, Worktrees and Snapshots: an added repository sits at repos/<project>/<slug> of the part folder, beside repo/.
export const ADDED_ROOT = "repos";

// The path of a row from the main repository root: the paths of its parents and its own. "" for main. An added repository gives
// ../repos/<project>/<slug>.
export function fullPath(rows: readonly TaskRepoRow[], r: TaskRepoRow): string {
  if (r.role === "added") return `../${ADDED_ROOT}/${r.project}/${r.repo}`;
  const out: string[] = [];
  for (let x: TaskRepoRow | undefined = r; x && x.role !== "main"; x = rows.find((y) => y.id === x?.parent)) out.unshift(x.path ?? "");
  return out.join("/");
}

// The repository whose cache holds a row: the earlier row of the same repository for a duplicate.
export function sourceOf(rows: readonly TaskRepoRow[], r: TaskRepoRow): TaskRepoRow {
  return (r.source !== null && rows.find((x) => x.id === r.source)) || r;
}

export function setAccess(db: Database, id: number, access: RepoAccess, reason: string | null) {
  db.query(Q.access).run({ id, access, reason });
}

// Every row of the task, the proposals too, for the plan screen.
export function repoDtos(db: Database, t: TaskRef): TaskRepoDto[] {
  const own = taskRepos(db, t);
  const rows = [...own, ...(db.query(Q.all).all({ task: t.id }) as TaskRepoRow[]).filter((r) => !own.some((x) => x.id === r.id))];
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    project: r.project,
    repo: r.repo,
    path: r.role === "main" || (r.role === "added" && r.proposal !== "added") ? null : fullPath(rows, r),
    depth: r.depth,
    access: r.access,
    reason: r.reason,
    baseBranch: r.base_branch,
    proposal: r.proposal,
    proposalReason: r.proposal_reason,
  }));
}

// ---------- The code PRs of a part (spec.md section 6.16.8) ----------

type PartRef = {
  id: number;
  branch: string;
  base_branch?: string;
  state: string;
  head: string | null;
  pushed: string | null;
  lines: number | null;
  files: number | null;
  pr: number | null;
  remote_pr: number | null;
};
type TaskPrRow = {
  id: number;
  task_repo: number;
  branch: string;
  base_branch: string;
  base_commit: string;
  head: string | null;
  pushed: string | null;
  lines: number | null;
  files: number | null;
  pr: number | null;
  remote_pr: number | null;
  state: TaskPrDto["state"];
  error: string | null;
  pointer_state: TaskPrDto["pointer"];
};
const PART_PR: Record<string, TaskPrDto["state"]> = { merged: "merged", declined: "declined", abandoned: "declined" };

// A row of the PR dialog with its place in the repository tree.
export type PrRow = Omit<TaskPrDto, "reviewers"> & { parent: number | null; depth: number; access: RepoAccess };

// The changed repositories of a part: each task_pr row, the submodules deepest first, then the main repository. The main row takes its
// state from the part, and its failure from its newest push or pr step (item "<project>/<repo>", or the part branch of the one-PR route).
export function prRows(db: Database, t: TaskRef, part: PartRef): PrRow[] {
  const rows = taskRepos(db, t);
  const main = rows.find((r) => r.role === "main") as TaskRepoRow;
  const steps = db
    .query("SELECT kind, state, item, detail_json FROM task_step WHERE part = $part AND kind IN ('push', 'pr') ORDER BY id DESC")
    .all({ part: part.id }) as { kind: "push" | "pr"; state: string; item: string | null; detail_json: string }[];
  const newest = (items: string[]) => steps.find((s) => s.item !== null && items.includes(s.item));
  const running = (items: string[]) => {
    const s = newest(items);
    return s?.state === "running" ? s.kind : null;
  };
  const prs = db.query("SELECT * FROM task_pr WHERE part = $part").all({ part: part.id }) as TaskPrRow[];
  const out: PrRow[] = [];
  for (const p of prs) {
    const r = rows.find((x) => x.id === p.task_repo);
    if (!r?.project || !r.repo) continue;
    out.push({
      id: p.id,
      part: part.id,
      taskRepo: r.id,
      role: r.role,
      project: r.project,
      repo: r.repo,
      path: fullPath(rows, r),
      branch: p.branch,
      baseBranch: p.base_branch,
      head: p.head,
      pushed: p.pushed,
      files: p.files,
      lines: p.lines,
      pr: p.pr,
      remotePr: p.remote_pr,
      state: p.state,
      error: p.error,
      running: running([`${r.project}/${r.repo}`]),
      pointer: p.pointer_state,
      parent: r.parent,
      depth: r.depth,
      access: r.access,
    });
  }
  out.sort((a, b) => b.depth - a.depth || a.taskRepo - b.taskRepo);
  const items = [`${t.project}/${t.repo}`, part.branch];
  const last = newest(items);
  const failed = last?.state === "failed" && part.remote_pr === null;
  const state: TaskPrDto["state"] =
    part.remote_pr !== null
      ? (PART_PR[part.state] ?? "pr_open")
      : failed
        ? "failed"
        : part.pushed !== null && part.pushed === part.head
          ? "pushed"
          : "changed";
  const notes = failed ? ((JSON.parse(last.detail_json) as { notes?: string[] }).notes ?? []) : [];
  out.push({
    id: null,
    part: part.id,
    taskRepo: main.id,
    role: "main",
    project: t.project,
    repo: t.repo,
    path: null,
    branch: part.branch,
    baseBranch: t.target_branch,
    head: part.head,
    pushed: part.pushed,
    files: part.files,
    lines: part.lines,
    pr: part.pr,
    remotePr: part.remote_pr,
    state,
    error: notes[0] ?? null,
    running: running(items),
    pointer: null,
    parent: null,
    depth: 0,
    access: main.access,
  });
  return out;
}

// One repository that "Update from <base>" can change (spec.md section 6.18.3, Repositories): the main repository, or a submodule or an
// added repository with access edit and commits of the task. baseCommit: task.base_commit or task_repo.base_commit. head: the task
// branch head. published: the task branch exists on the server (task_part.pushed or task_pr.pushed; Continue sets it at the start,
// spec.md section 6.16.4).
export type UpdateRepo = {
  row: TaskRepoRow;
  project: string;
  repo: string;
  base: string;
  baseCommit: string;
  head: string;
  published: boolean;
};

// The repositories of a part that the update can change, deepest first and the main repository last.
export function updateRepos(
  db: Database,
  t: TaskRef & { target_branch: string },
  part: { id: number; head: string | null; pushed: string | null },
): UpdateRepo[] {
  const rows = taskRepos(db, t);
  const out: UpdateRepo[] = [];
  for (const row of [...rows].sort((a, b) => b.depth - a.depth)) {
    if (row.role === "main" || row.access !== "edit" || !row.project || !row.repo || !row.base_branch) continue;
    const pr = db
      .query("SELECT head, pushed FROM task_pr WHERE part = $part AND task_repo = $repo")
      .get({ part: part.id, repo: row.id }) as {
      head: string | null;
      pushed: string | null;
    } | null;
    const baseCommit = row.base_commit ?? row.pinned;
    if (!pr?.head || !baseCommit || pr.head === baseCommit) continue;
    out.push({
      row,
      project: row.project,
      repo: row.repo,
      base: row.base_branch,
      baseCommit,
      head: pr.head,
      published: pr.pushed !== null,
    });
  }
  const main = rows.find((r) => r.role === "main") as TaskRepoRow;
  if (t.base_commit && part.head)
    out.push({
      row: main,
      project: t.project,
      repo: t.repo,
      base: t.target_branch,
      baseCommit: t.base_commit,
      head: part.head,
      published: part.pushed !== null,
    });
  return out;
}

// The main row for a new task, or its new base.
export function saveMainRepo(
  db: Database,
  t: Pick<TaskRef, "id" | "project" | "repo">,
  base: string,
  commit: string | null,
  now = Date.now(),
) {
  const main = db.query(Q.main).get({ task: t.id }) as { id: number } | null;
  if (main) db.query(Q.mainUpdate).run({ id: main.id, base, commit });
  else db.query(Q.mainInsert).run({ task: t.id, project: t.project, repo: t.repo, base, commit, now });
}

// ---------- Resolve (spec.md section 6.16.5) ----------

export type RepoDeps = {
  dataDir: string;
  // null: no Bitbucket URL or token. The app asks only when the commit has gitlinks.
  provider: () => Promise<RepoProvider | null>;
  remote: (project: string, repo: string) => Promise<BranchRemote>;
  long?: LongGit;
  now?: () => number;
};

type Found = {
  project: string | null;
  repo: string | null;
  url: string | null;
  parent: number;
  path: string;
  full: string;
  depth: number;
  access: RepoAccess;
  reason: string | null;
  base: string | null;
  pinned: string;
  source: number | null;
};

// The base branch of a submodule: the default branch of Bitbucket, else the remote HEAD (spec.md section 6.16.3).
async function baseOf(p: RepoProvider, deps: RepoDeps, project: string, repo: string, remote: BranchRemote): Promise<string> {
  try {
    return await p.defaultBranch(project, repo);
  } catch {
    return remoteHead(deps.dataDir, remote, deps.long);
  }
}

// Fetches the branches that hold pinned: the base branch first, then all heads (spec.md section 6.16.5, Fetch). A fetch by commit ID
// is not used. Returns the cache, or null when no branch holds pinned.
async function fetchPinned(deps: RepoDeps, task: number, project: string, repo: string, base: string, pinned: string) {
  const remote = await deps.remote(project, repo);
  const ns = `refs/rl/task/${task}/sub`;
  const cache = await fetchInto(deps.dataDir, project, repo, remote, [`+refs/heads/${base}:${ns}/base`], deps.long);
  const { env } = gitSetup(longPath(deps.dataDir));
  const has = async () =>
    (await git([`--git-dir=${cache}`, "rev-parse", "--verify", "--quiet", `${pinned}^{commit}`], { env }).catch(() => "")).trim() ===
    pinned;
  if (!(await has())) await fetchInto(deps.dataDir, project, repo, remote, [`+refs/heads/*:${ns}/heads/*`], deps.long);
  if (!(await has())) return null;
  // The ref keeps the pinned commit from gc while the task lives.
  await locked(cache, () => git([`--git-dir=${cache}`, "update-ref", `refs/rl/task/${task}/pin/${pinned}`, pinned], { env }));
  return cache;
}

// Reads the gitlinks of the main repository at head, maps and fetches each submodule, writes the task_repo rows, and returns the
// folders of the task snapshot. The main cache already holds head. Nothing goes to a URL of another server.
export async function resolveTaskRepos(db: Database, deps: RepoDeps, t: TaskRef, head: string): Promise<SnapshotRepo[]> {
  const now = deps.now ?? Date.now;
  const dataDir = longPath(deps.dataDir);
  const { env } = gitSetup(dataDir);
  const mainCache = cachePath(dataDir, { project: t.project, repo: t.repo, id: t.id });
  const top = await readGitlinks(mainCache, env, head);
  const found: Found[] = [];
  const caches = new Map<number, string>();
  const kept = new Map(
    (db.query(Q.subBases).all({ task: t.id }) as { project: string; repo: string; base_branch: string | null }[]).map((r) => [
      `${r.project}/${r.repo}`,
      r.base_branch,
    ]),
  );
  if (top.length) {
    const p = await deps.provider();
    if (!p) throw new WorkspaceError("Configure the Bitbucket URL and token first.");
    const main = await p.repository(t.project, t.repo);
    const hosts = new Set<string>();
    for (const u of [p.origin, ...main.clone.map((c) => c.href)]) {
      const h = hostOf(u);
      if (h) hosts.add(h);
    }
    // -1: the main repository.
    const seen = new Map<string, number>([[`${main.project}/${main.slug}`, -1]]);
    const http = (r: RepoInfo) => r.clone.find((c) => c.name === "http")?.href ?? "";
    let readable: RepoInfo[] | null = null;
    const walk = async (parent: number, parentUrl: string, depth: number, prefix: string, links: Gitlink[]) => {
      for (const l of [...links].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const full = prefix ? `${prefix}/${l.path}` : l.path;
        const row: Found = {
          project: null,
          repo: null,
          url: l.url === null ? null : withoutUser(l.url),
          parent,
          path: l.path,
          full,
          depth,
          access: "none",
          reason: REPO_REASON.noMatch,
          base: null,
          pinned: l.pinned,
          source: null,
        };
        found.push(row);
        const at = found.length - 1;
        if (l.url === null) continue;
        const resolved = isRelativeUrl(l.url) ? relativeUrl(parentUrl, l.url) : l.url;
        const host = resolved && hostOf(resolved);
        if (host && !hosts.has(host)) {
          row.reason = REPO_REASON.otherServer;
          continue;
        }
        const url = resolved && normalizeUrl(resolved);
        const cand = url && candidate(url);
        if (!url || !cand) continue;
        row.url = url;
        let info: RepoInfo | null = null;
        try {
          info = await p.repository(cand.project, cand.repo);
        } catch (e) {
          if (!(e instanceof ForgeError && e.kind === "not_found")) throw e;
        }
        // The candidate key is the URL part as given. Without a match there, the REPO_READ list (Gate G16) gives the repository whose clone
        // link equals the URL. Both ways accept only that equality.
        if (!info || !cloneMatch(info, url)) {
          readable ??= (await p.readableRepos()).repos;
          info = readable.find((r) => cloneMatch(r, url)) ?? null;
        }
        if (!info) continue;
        const k = `${info.project}/${info.slug}`;
        const first = seen.get(k);
        if (first !== undefined) {
          row.access = "read";
          row.reason = REPO_REASON.twice(first < 0 ? "." : (found[first] as Found).full);
          row.source = first;
        } else {
          seen.set(k, at);
          row.project = info.project;
          row.repo = info.slug;
          const write = depth === 1 && (await canWrite(p, info, now()));
          row.access = write ? "edit" : "read";
          row.reason = write ? null : depth === 1 ? REPO_REASON.noWrite : REPO_REASON.nested;
        }
        const own = first === undefined ? info : null;
        const src =
          first === undefined
            ? { project: info.project, repo: info.slug }
            : first < 0
              ? { project: t.project, repo: t.repo }
              : found[first];
        const project = src?.project as string;
        const repo = src?.repo as string;
        const picked = own ? kept.get(k) : null;
        let cache: string | null | undefined;
        if (picked) {
          row.base = picked;
          // A kept base that is gone on the server falls back to the default branch.
          cache = await fetchPinned(deps, t.id, project, repo, picked, l.pinned).catch(() => undefined);
        }
        if (cache === undefined) {
          row.base = await baseOf(p, deps, project, repo, await deps.remote(project, repo));
          cache = await fetchPinned(deps, t.id, project, repo, row.base, l.pinned);
        }
        if (!cache) {
          Object.assign(row, { access: "none", reason: REPO_REASON.noBranch, project: null, repo: null, source: null });
          if (own) seen.delete(k);
          continue;
        }
        caches.set(at, cache);
        // A repository that is in the task a second time does not repeat its submodules, so a cycle ends.
        if (own) await walk(at, http(own), depth + 1, full, await readGitlinks(cache, env, l.pinned));
      }
    };
    await walk(-1, http(main), 1, "", top);
  }
  // spec.md section 6.16.5, Fetch: an added repository fetches its base branch into its own cache. Its base head is the start of the
  // task branch there.
  const added: { id: number; full: string; cache: string; head: string }[] = [];
  for (const r of db.query(Q.added).all({ task: t.id }) as TaskRepoRow[]) {
    if (!r.project || !r.repo || !r.base_branch) continue;
    const ref = `refs/rl/task/${t.id}/added/${r.id}`;
    const remote = await deps.remote(r.project, r.repo);
    const cache = await fetchInto(deps.dataDir, r.project, r.repo, remote, [`+refs/heads/${r.base_branch}:${ref}`], deps.long);
    const at = (await git([`--git-dir=${cache}`, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { env }).catch(() => "")).trim();
    if (!HASH.test(at)) throw new WorkspaceError(`${r.base_branch} has no commit in ${r.project}/${r.repo}.`);
    added.push({ id: r.id, full: fullPath([], r), cache, head: at });
  }
  db.transaction(() => {
    saveMainRepo(db, t, t.target_branch, head, now());
    for (const a of added) db.query(Q.addedBase).run({ id: a.id, commit: a.head });
    db.query(Q.dropSubs).run({ task: t.id });
    const mainId = (db.query(Q.main).get({ task: t.id }) as { id: number }).id;
    const ids: number[] = [];
    for (const f of found) {
      const id = (
        db.query(Q.insert).get({
          task: t.id,
          project: f.project,
          repo: f.repo,
          url: f.url,
          parent: f.parent < 0 ? mainId : (ids[f.parent] as number),
          path: f.path,
          depth: f.depth,
          access: f.access,
          reason: f.reason,
          base: f.base,
          commit: f.access === "none" ? null : f.pinned,
          pinned: f.pinned,
          source: f.source === null ? null : f.source < 0 ? mainId : (ids[f.source] as number),
          now: now(),
        }) as { id: number }
      ).id;
      ids.push(id);
    }
  })();
  return [
    ...found.flatMap((f, i) => {
      const cache = caches.get(i);
      return cache && f.access !== "none" ? [{ path: f.full, cache, commit: f.pinned }] : [];
    }),
    ...added.map((a) => ({ path: a.full, cache: a.cache, commit: a.head })),
  ];
}

// context/repos.md (spec.md section 6.16.5): each repository with its path, access, base branch, and reason. Untrusted data: the paths
// and names come from the repositories.
export function reposFile(rows: readonly TaskRepoRow[]): { name: string; text: string } {
  const out = ["# Repositories of the task", "", "Only a repository with access edit may change. The path starts at ./repo.", ""];
  for (const r of rows) {
    const name = r.project && r.repo ? `${r.project}/${r.repo}` : (r.url ?? "unknown");
    const path = r.role === "main" ? "." : fullPath(rows, r);
    out.push(`- ${path}: ${name} · access ${r.access} · base ${r.base_branch ?? "none"}${r.reason ? ` · ${r.reason}` : ""}`);
  }
  return { name: "repos.md", text: `${out.join("\n")}\n` };
}
