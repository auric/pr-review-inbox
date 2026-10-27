// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The app-owned worktree of one task part (docs/plans/review-v2/spec.md section 6.8, design.md section 5.5 "Git and Bitbucket").
// <dataDir>/tasks/<db stem>/<task ID>/part-<n>/ is the cwd of a Claude step: repo/ is the worktree, context/ holds the step files.
// The task folder also holds patches/. The worktree comes from the bare cache of the repository, never from the user's clone.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { BRANCH_SUFFIX_MAX } from "../../shared/task";
import { dbStem } from "../context/attachments";
import { GitError, git, gitEnv } from "../review/git";
import { type BranchRemote, cachePath, gitSetup, locked, longPath, noUrl, WorkspaceError } from "../review/workspace";
import { ADDED_ROOT, fullPath, sourceOf, type TaskRepoRow } from "./repos";

// spec.md section 6.8: the sparse patterns of a task worktree, in this order. The matching paths are absent on disk, and a commit keeps
// them unchanged.
export const SPARSE = [
  "/*",
  "!/.claude/",
  "!**/.claude/",
  "!/.mcp.json",
  "!**/.mcp.json",
  "!/.codegraph/",
  "!**/CLAUDE.md",
  "!**/CLAUDE.local.md",
  "!**/AGENTS.md",
  "!/.gitmodules",
  "!/.githooks/",
  "!/.husky/",
];
// A name that exists gets -2, -3, and so on (spec.md section 6.16.4). The search stops here.
const MAX_SUFFIX = BRANCH_SUFFIX_MAX;
const RM_TREE = { recursive: true, force: true, maxRetries: 3 } as const;
const HEAD = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LS_REMOTE_MS = 60_000;

export type Worktree = {
  // The cwd of a Claude step. It holds repo/ and context/.
  dir: string;
  repo: string;
  context: string;
  // <cache>/worktrees/<name>: the git folder of the worktree. git gets it in --git-dir, so repo/.git is never read.
  admin: string;
  cache: string;
  branch: string;
  // The env of every git call in the worktree: the isolated config and the empty hooks folder.
  env: Record<string, string>;
};

const norm = (p: string) => {
  const r = resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? r.toLowerCase() : r;
};

// true: p is root or a path under root.
export function inside(root: string, p: string) {
  const r = relative(root, p);
  return !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r);
}

export const tasksRoot = (dataDir: string) => join(longPath(dataDir), "tasks");
export const taskDir = (dataDir: string, db: Database, task: number) => join(tasksRoot(dataDir), dbStem(db), String(task));
export const partDir = (dataDir: string, db: Database, task: number, ord: number) => join(taskDir(dataDir, db, task), `part-${ord}`);
export const patchFile = (dataDir: string, db: Database, task: number, step: number) =>
  join(taskDir(dataDir, db, task), "patches", `${step}.patch`);

// The Task view shows the same name before the build (PlanTab.tsx).
export { branchName, slug } from "../../shared/task";

const lsError = (e: unknown, remote: BranchRemote) => {
  let m = noUrl((e as Error).message);
  for (const [, v] of remote.config) if (v) m = m.replaceAll(v, "[redacted]");
  return new WorkspaceError(m, e instanceof GitError && e.stopped);
};

// The remote branches name and name-* with their heads (`git ls-remote --heads`).
export async function remoteBranches(dataDir: string, remote: BranchRemote, name: string): Promise<Map<string, string>> {
  const { empty, env } = gitSetup(longPath(dataDir));
  await git(["check-ref-format", "--branch", name], { env }).catch(() => {
    throw new WorkspaceError(`${name} is not a valid branch name.`);
  });
  let out: string;
  try {
    out = await git(["ls-remote", "--heads", "--end-of-options", remote.url, `refs/heads/${name}`, `refs/heads/${name}-*`], {
      env: gitEnv(empty, remote.config),
      timeoutMs: LS_REMOTE_MS,
    });
  } catch (e) {
    throw lsError(e, remote);
  }
  const heads = new Map<string, string>();
  for (const l of out.split("\n")) {
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\trefs\/heads\/(.+)$/.exec(l.trimEnd());
    if (m) heads.set(m[2] as string, m[1] as string);
  }
  return heads;
}

// The first of name-<from>, ..., name-99 (name itself for from 1) that taken does not hold.
export function firstFree(name: string, taken: ReadonlySet<string>, from = 1): string {
  for (let i = from; i <= MAX_SUFFIX; i++) {
    const n = i === 1 ? name : `${name}-${i}`;
    if (!taken.has(n)) return n;
  }
  throw new WorkspaceError(`The branch names ${name} to ${name}-${MAX_SUFFIX} are all taken.`);
}

// spec.md section 6.16.4, Continue: the remote branch goes into the cache as refs/heads/<name>. Returns the fetched head, the lease of
// the first push. A cache branch with commits that the fetched head does not hold stays, and the call throws: the app never drops
// commits.
export async function takeRemoteBranch(dataDir: string, cache: string, remote: BranchRemote, task: number, name: string): Promise<string> {
  const { empty, env } = gitSetup(longPath(dataDir));
  const c = (args: string[]) => git([`--git-dir=${cache}`, ...args], { env });
  return locked(cache, async () => {
    try {
      // A task ref, so the fetch never moves a branch of the cache.
      await git(
        [`--git-dir=${cache}`, "fetch", "--no-tags", "--end-of-options", remote.url, `+refs/heads/${name}:refs/rl/task/${task}/remote`],
        {
          env: gitEnv(empty, remote.config),
          timeoutMs: LS_REMOTE_MS,
        },
      );
    } catch (e) {
      throw lsError(e, remote);
    }
    const head = (await c(["rev-parse", "--verify", "--quiet", `refs/rl/task/${task}/remote^{commit}`]).catch(() => "")).trim();
    if (!HEAD.test(head)) throw new WorkspaceError(`The server has no branch ${name}.`);
    const local = (await c(["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]).catch(() => "")).trim();
    if (
      local &&
      local !== head &&
      !(await c(["merge-base", "--is-ancestor", local, head]).then(
        () => true,
        () => false,
      ))
    )
      throw new WorkspaceError(`The app copy of ${name} has commits that the server does not have. Start a new branch.`);
    await c(["update-ref", `refs/heads/${name}`, head]);
    return head;
  });
}

// git merge-base of two commits in the cache, or null when they share no history.
export async function mergeBase(dataDir: string, cache: string, a: string, b: string): Promise<string | null> {
  const { env } = gitSetup(longPath(dataDir));
  const out = await git([`--git-dir=${cache}`, "merge-base", a, b], { env }).catch(() => "");
  return HEAD.test(out.trim()) ? out.trim() : null;
}

// The first of name, name-2, name-3, ... that neither the remote (`git ls-remote --heads`) nor the cache has as a branch.
export async function freeBranch(dataDir: string, cache: string, remote: BranchRemote, name: string): Promise<string> {
  return firstFree(name, await takenBranches(dataDir, cache, remote, name));
}

// The branches name and name-* of the remote and of the cache.
export async function takenBranches(dataDir: string, cache: string, remote: BranchRemote, name: string): Promise<Set<string>> {
  const { env } = gitSetup(longPath(dataDir));
  const taken = new Set((await remoteBranches(dataDir, remote, name)).keys());
  const local = existsSync(join(cache, "HEAD"))
    ? (
        await git([`--git-dir=${cache}`, "for-each-ref", "--format=%(refname:lstrip=2)", `refs/heads/${name}`, `refs/heads/${name}-*`], {
          env,
        })
      )
        .split("\n")
        .filter(Boolean)
    : [];
  for (const b of local) taken.add(b);
  return taken;
}

// git in the worktree. --git-dir and --work-tree name both folders, so a changed repo/.git file cannot point git at another repository.
export function wtGit(wt: Worktree, args: string[], o: { stdin?: string; extra?: Record<string, string>; signal?: AbortSignal } = {}) {
  return git([`--git-dir=${wt.admin}`, `--work-tree=${wt.repo}`, "--literal-pathspecs", ...args], {
    env: { ...wt.env, ...o.extra },
    cwd: wt.repo,
    ...(o.stdin !== undefined && { stdin: o.stdin }),
    ...(o.signal && { signal: o.signal }),
  });
}

// The git folder of the worktree at repo: the entry of <cache>/worktrees whose gitdir file names repo/.git. The app wrote both files.
function adminOf(cache: string, repo: string): string | null {
  const root = join(cache, "worktrees");
  if (!existsSync(root)) return null;
  const want = norm(join(longPath(repo), ".git"));
  for (const n of readdirSync(root)) {
    try {
      if (norm(readFileSync(join(root, n, "gitdir"), "utf8").trim()) === want) return join(root, n);
    } catch {}
  }
  return null;
}

// true: repo/.git names the git folder of the worktree.
export function gitLinkOk(wt: Pick<Worktree, "repo" | "admin">) {
  try {
    const text = readFileSync(join(wt.repo, ".git"), "utf8");
    return lstatSync(join(wt.repo, ".git")).isFile() && /^gitdir: (.+)\r?\n?$/.test(text) && norm(text.slice(8).trim()) === norm(wt.admin);
  } catch {
    return false;
  }
}

// Writes repo/.git again. A link or a folder in its place goes first.
export async function restoreGitLink(wt: Pick<Worktree, "repo" | "admin">) {
  const p = join(wt.repo, ".git");
  const st = lstatSync(p, { throwIfNoEntry: false });
  // A link goes without a walk, so its target stays.
  if (st?.isDirectory() && !st.isSymbolicLink()) await rm(p, RM_TREE);
  else if (st) await rm(p, { force: true });
  // A step can delete the folder of a submodule worktree.
  mkdirSync(wt.repo, { recursive: true });
  writeFileSync(p, `gitdir: ${wt.admin.replaceAll("\\", "/")}\n`);
}

export type WorktreeInput = {
  dataDir: string;
  db: Database;
  project: string;
  repo: string;
  task: number;
  // task_part.ord: the folder part-<ord>.
  ord: number;
  // The local branch of the cache, named like the remote branch. A missing branch starts at base.
  branch: string;
  base: string;
  // A submodule worktree (spec.md section 6.16.5, Worktrees): its folder inside the parent worktree, or part-<ord>/repos/<project>/<slug>
  // for an added repository. Absent: part-<ord>/repo.
  at?: string;
  // Access read: a detached worktree at base. branch is not used.
  detach?: boolean;
};

// The worktree of a part: the existing one, or a new one from the branch in the cache (spec.md section 6.14: "The worktree folder is
// gone: Resume makes it again from the branch"). One call per cache runs at a time, because sparse-checkout writes the cache config.
export async function openWorktree(i: WorktreeInput): Promise<Worktree> {
  mkdirSync(i.dataDir, { recursive: true });
  const dataDir = longPath(i.dataDir);
  const cache = cachePath(dataDir, { project: i.project, repo: i.repo, id: i.task });
  if (!existsSync(join(cache, "HEAD"))) throw new WorkspaceError(`The app has no copy of ${i.project}/${i.repo} yet.`);
  if (!HEAD.test(i.base)) throw new WorkspaceError(`Invalid commit hash: ${i.base}`);
  const { dir: gitDir, empty, env: plain } = gitSetup(dataDir);
  const branch = i.detach ? "" : i.branch;
  if (!i.detach)
    await git(["check-ref-format", "--branch", branch], { env: plain }).catch(() => {
      throw new WorkspaceError(`${branch} is not a valid branch name.`);
    });
  const hooks = join(gitDir, "no-hooks");
  mkdirSync(hooks, { recursive: true });
  // core.hooksPath: commits and checkouts of the app run no hook (spec.md section 6.7).
  const env = gitEnv(empty, [["core.hooksPath", hooks]]);
  const dir = partDir(dataDir, i.db, i.task, i.ord);
  const repo = i.at ?? join(dir, "repo");
  if (!inside(join(dir, "repo"), repo) && !(repo !== join(dir, ADDED_ROOT) && inside(join(dir, ADDED_ROOT), repo)))
    throw new WorkspaceError(`A submodule path is outside the worktree: ${repo}`);
  const context = join(dir, "context");
  mkdirSync(context, { recursive: true });
  const c = (args: string[]) => git([`--git-dir=${cache}`, ...args], { env });
  return locked(cache, async () => {
    const found = existsSync(repo) ? adminOf(cache, repo) : null;
    if (found) {
      const wt: Worktree = { dir, repo, context, admin: found, cache, branch, env };
      if (!gitLinkOk(wt)) await restoreGitLink(wt);
      const head = await wtGit(wt, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
      if (i.detach ? !head.trim() : head.trim() === `refs/heads/${branch}`) return wt;
    }
    await rm(repo, RM_TREE);
    await c(["worktree", "prune"]);
    const has = i.detach ? "" : await c(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).catch(() => "");
    if (!has.trim()) {
      const base = await c(["rev-parse", "--verify", "--quiet", `${i.base}^{commit}`]).catch(() => "");
      if (base.trim() !== i.base)
        throw new WorkspaceError(`The base commit ${i.base.slice(0, 12)} is not in the app copy of the repository.`);
      if (!i.detach) await c(["branch", "--no-track", "--end-of-options", branch, i.base]);
    }
    await c(["worktree", "add", "--no-checkout", ...(i.detach ? ["--detach", repo, i.base] : [repo, branch])]);
    const admin = adminOf(cache, repo);
    if (!admin) throw new WorkspaceError("git made no worktree entry for the task folder.");
    const wt: Worktree = { dir, repo, context, admin, cache, branch, env };
    // sparse-checkout enables extensions.worktreeConfig, so the --worktree values stay in the git folder of this worktree.
    await wtGit(wt, ["sparse-checkout", "set", "--no-cone", ...SPARSE]);
    for (const [k, v] of [
      ["core.symlinks", "false"],
      ["core.autocrlf", "false"],
      ["core.hooksPath", hooks],
    ] as const)
      await wtGit(wt, ["config", "--worktree", k, v]);
    await wtGit(wt, ["checkout", "-q"]);
    return wt;
  });
}

// The worktree HEAD.
export const headOf = async (wt: Worktree) => (await wtGit(wt, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();

// One entry of `git status --porcelain=v1 -z`. A path that ends with "/" is a folder that git does not enter: a nested repository or a
// link to a folder.
export type StatusEntry = { xy: string; path: string };

export async function status(wt: Worktree): Promise<StatusEntry[]> {
  // spec.md section 6.16.6: --ignore-submodules=none lists a gitlink path when its worktree has changes or a new HEAD.
  const parts = (await wtGit(wt, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"])).split("\0");
  const out: StatusEntry[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k] as string;
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    out.push({ xy, path: p.slice(3) });
    // git-status(1), porcelain v1 with -z: a rename or copy has the source path in the next field.
    if (xy[0] === "R" || xy[0] === "C") out.push({ xy, path: parts[++k] ?? "" });
  }
  return out.filter((e) => e.path);
}

// A step never needs to write a file that git ignores: `git add -A` leaves it out of the commit, so no review sees it, but a check
// command can still load it. The cap bounds the memory of the two listings around one step.
export const MAX_IGNORED = 200_000;
// The ignored files under repo/ by path, with their kind, size, and mtime.
export type IgnoredSnapshot = Map<string, string>;

// git-ls-files(1): --others --ignored --exclude-standard lists each ignored file, also inside an ignored folder.
export async function ignoredSnapshot(wt: Worktree): Promise<IgnoredSnapshot> {
  const list = (await wtGit(wt, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"])).split("\0").filter(Boolean);
  if (list.length > MAX_IGNORED)
    throw new WorkspaceError(`The worktree has more than ${MAX_IGNORED} files that git ignores, so the app cannot check them.`);
  const out: IgnoredSnapshot = new Map();
  for (const p of list) {
    const st = lstatSync(join(wt.repo, p), { throwIfNoEntry: false });
    if (st) out.set(p, `${st.isSymbolicLink() ? "link" : "file"} ${st.size} ${st.mtimeMs}`);
  }
  return out;
}

// The ignored paths that are new, changed, or gone in after.
export function ignoredChanges(before: IgnoredSnapshot, after: IgnoredSnapshot): string[] {
  const out = [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
  for (const p of before.keys()) if (!after.has(p)) out.push(p);
  return out.sort();
}

// The setup commands ran in this worktree. The mark lives in the git folder of the worktree, so a new worktree has none.
export const setupMark = (wt: Worktree) => join(wt.admin, "rl-setup-done");

// The paths of p and its parent folders inside repo that are links (symbolic links, and junctions on Windows).
export function linksOn(repo: string, p: string): string[] {
  const parts = p.replace(/\/+$/, "").split("/");
  const out: string[] = [];
  for (let k = 1; k <= parts.length; k++) {
    const rel = parts.slice(0, k).join("/");
    try {
      if (lstatSync(join(repo, rel)).isSymbolicLink()) out.push(rel);
    } catch {}
  }
  return out;
}

// Saves the changes of paths as a binary patch against HEAD, for the user and for Resume (spec.md section 6.7). A copy of the index
// keeps the skip-worktree bits, so the files that sparse checkout hides do not show as deleted. Links are left out. only: the patch
// holds these paths only; a paused merge or rebase has other staged paths (spec.md section 6.18.4).
export async function savePatch(wt: Worktree, file: string, paths: string[], only = false): Promise<string | null> {
  const list = paths.filter((p) => p && !p.endsWith("/") && linksOn(wt.repo, p).length === 0);
  if (!list.length) return null;
  const tmp = mkdtempSync(join(tmpdir(), "rl-patch-"));
  try {
    const index = join(tmp, "index");
    copyFileSync(join(wt.admin, "index"), index);
    const extra = { GIT_INDEX_FILE: index };
    await wtGit(wt, ["add", "-A", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"], { stdin: `${list.join("\0")}\0`, extra });
    const diff = await wtGit(
      wt,
      ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", ...(only ? ["--", ...list] : [])],
      { extra },
    );
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, diff);
    return file;
  } finally {
    await rm(tmp, RM_TREE);
  }
}

// Returns the worktree to commit last (spec.md section 6.8): links go first, so no later step follows them out of repo/. Then
// `git reset --hard` and `git clean -ffd`. git-clean(1): the second -f also removes nested repositories. Ignored files stay.
// git status clears the skip-worktree bit of a hidden file that is present (git 2.37, sparse.expectFilesOutsideOfPatterns), so
// `sparse-checkout reapply` hides those paths again.
export async function resetWorktree(wt: Worktree, last: string, links: string[] = []) {
  if (!HEAD.test(last)) throw new WorkspaceError(`Invalid commit hash: ${last}`);
  for (const l of links) {
    const p = join(wt.repo, l);
    if (inside(wt.repo, p) && lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) await rm(p, { force: true });
  }
  if (!gitLinkOk(wt)) await restoreGitLink(wt);
  await wtGit(wt, ["reset", "-q", "--hard", last]);
  await wtGit(wt, ["clean", "-ffdq"]);
  await wtGit(wt, ["sparse-checkout", "reapply"]);
}

// Deletes the part folder and its worktree entry. The branch stays in the cache.
export async function removeWorktree(wt: Worktree) {
  await rm(wt.dir, RM_TREE);
  await locked(wt.cache, () => git([`--git-dir=${wt.cache}`, "worktree", "prune"], { env: wt.env }));
}

// ---------- Several repositories (spec.md sections 6.16.5 and 6.16.6) ----------

// One repository of a part folder. full: the path from the main repository root, "" for main. wt null: access none, an empty folder
// at full that the app keeps empty, or a submodule under such a folder.
export type RepoTree = { row: TaskRepoRow; full: string; wt: Worktree | null };

// The worktrees of the submodules inside the main worktree, parents first: `git worktree add` from the cache of each repository at its
// pinned commit, on the task branch for access edit, detached for access read. The gitlink folder that the parent checkout made takes
// the worktree. An added repository gets its worktree at repos/<project>/<slug> of the part folder, on the task branch from its base
// commit.
export async function openRepoTrees(i: {
  dataDir: string;
  db: Database;
  task: number;
  ord: number;
  branch: string;
  main: Worktree;
  rows: readonly TaskRepoRow[];
}): Promise<RepoTree[]> {
  const out: RepoTree[] = [];
  for (const row of i.rows) {
    if (row.role === "main") {
      out.push({ row, full: "", wt: i.main });
      continue;
    }
    if (row.role === "added") {
      const full = fullPath(i.rows, row);
      if (row.access !== "edit" || !row.project || !row.repo || !row.base_commit) {
        out.push({ row, full, wt: null });
        continue;
      }
      const at = join(i.main.dir, ADDED_ROOT, row.project, row.repo);
      const wt = await openWorktree({
        dataDir: i.dataDir,
        db: i.db,
        project: row.project,
        repo: row.repo,
        task: i.task,
        ord: i.ord,
        branch: i.branch,
        base: row.base_commit,
        at,
      });
      out.push({ row, full, wt });
      continue;
    }
    if (row.role !== "submodule") continue;
    const full = fullPath(i.rows, row);
    const parent = out.find((x) => x.row.id === row.parent);
    const src = sourceOf(i.rows, row);
    if (row.access === "none" || !parent?.wt || !row.pinned || !src.project || !src.repo) {
      out.push({ row, full, wt: null });
      continue;
    }
    const at = join(i.main.repo, ...full.split("/"));
    const wt = await openWorktree({
      dataDir: i.dataDir,
      db: i.db,
      project: src.project,
      repo: src.repo,
      task: i.task,
      ord: i.ord,
      branch: i.branch,
      base: row.pinned,
      at,
      detach: row.access !== "edit",
    });
    out.push({ row, full, wt });
  }
  return out;
}

export const deepestFirst = (trees: readonly RepoTree[]) => [...trees].sort((a, b) => b.row.depth - a.row.depth);

// The worktree folders of the added repositories, relative to the part folder (repos/<project>/<slug>). The check of the files outside
// repo/ leaves them to their own path check.
export const addedFolders = (trees: readonly RepoTree[]) =>
  trees.filter((t) => t.row.role === "added" && t.wt).map((t) => t.full.replace(/^\.\.\//, ""));

const folderOf = (trees: readonly RepoTree[], t: RepoTree) => {
  const main = trees.find((x) => x.row.role === "main")?.wt as Worktree;
  return join(main.repo, ...t.full.split("/"));
};

// The paths in the folder of a repository with access none: it must stay an empty folder. A missing folder counts as a change of it.
export function noneChanges(trees: readonly RepoTree[], t: RepoTree): string[] {
  const p = folderOf(trees, t);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st?.isDirectory() || st.isSymbolicLink()) return [t.full];
  return readdirSync(p).map((n) => `${t.full}/${n}`);
}

// Empties the folder of a repository with access none. A link or a file in its place goes, and the folder comes back.
export async function clearNone(trees: readonly RepoTree[], t: RepoTree) {
  const p = folderOf(trees, t);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (st && (!st.isDirectory() || st.isSymbolicLink())) await rm(p, { force: true });
  else if (st) for (const n of readdirSync(p)) await rm(join(p, n), lstatSync(join(p, n)).isSymbolicLink() ? { force: true } : RM_TREE);
  mkdirSync(p, { recursive: true });
}

// spec.md section 6.16.6, Reset: each repository returns to its last commit, deepest first. A submodule with access read returns to its
// pinned commit. The main worktree goes last. links: the links of each worktree, as in resetWorktree. `git clean -ffd` in a parent
// keeps the gitlink folders, because they are tracked entries.
export async function resetTrees(trees: readonly RepoTree[], mainLast: string, links: ReadonlyMap<RepoTree, string[]> = new Map()) {
  for (const t of deepestFirst(trees)) {
    if (t.row.role === "main") continue;
    if (!t.wt) {
      if (t.row.access === "none" && trees.find((x) => x.row.id === t.row.parent)?.wt) await clearNone(trees, t);
      continue;
    }
    await resetWorktree(t.wt, t.row.access === "edit" ? await headOf(t.wt) : (t.row.pinned as string), links.get(t));
  }
  const main = trees.find((x) => x.row.role === "main");
  if (main?.wt) await resetWorktree(main.wt, mainLast, links.get(main));
}

// spec.md section 6.7: `git add -A`, then `git commit -F -` with the isolated git config, the empty core.hooksPath, and the user's name
// and email. --no-verify also skips the hooks that core.hooksPath would name. null: nothing to commit.
export async function commitStep(wt: Worktree, message: string, who: { name: string; email: string }): Promise<string | null> {
  if (!message.trim()) throw new WorkspaceError("A commit needs a message.");
  await wtGit(wt, ["add", "-A"]);
  if (!(await wtGit(wt, ["diff", "--cached", "--name-only", "-z"])).length) return null;
  const ids = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
  await wtGit(wt, ["commit", "-q", "--no-verify", "-F", "-"], { stdin: message, extra: ids });
  return headOf(wt);
}
