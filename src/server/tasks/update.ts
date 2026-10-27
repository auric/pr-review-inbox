// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// "Update from <base>" of a task part (docs/plans/review-v2/spec.md sections 6.18.3 to 6.18.5, design.md B24 to B27): the base check,
// the rebase or the merge in one repository, the unmerged paths, the marker check, the continue, the pointer of a parent, the reset to the
// heads before the update, and the context file of a resolve step. Every git call runs in the worktree env or the cache env: the isolated
// config and the empty core.hooksPath. The update pushes nothing.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { UpdateDetail } from "../../shared/task";
import { deniedPath } from "../review/edits";
import { git } from "../review/git";
import { type BranchRemote, type ContextFile, cachePath, fetchInto, gitSetup, longPath } from "../review/workspace";
import { outsideRepo, type PathProblem, sparseHidden } from "./implement";
import { sourceOf, type TaskRepoRow, type UpdateRepo } from "./repos";
import {
  addedFolders,
  deepestFirst,
  gitLinkOk,
  headOf,
  type IgnoredSnapshot,
  ignoredChanges,
  ignoredSnapshot,
  linksOn,
  noneChanges,
  type RepoTree,
  remoteBranches,
  resetWorktree,
  status,
  type Worktree,
  wtGit,
} from "./worktree";

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// git-merge(1), "How conflicts are presented": the default conflict-marker-size.
const MARKER_SIZE = 7;

export class UpdateAbort extends Error {}

// A moved base (spec.md section 6.18.5, Base check). newHead: the fetched base head; null when the base did not move.
export type BaseMove = { taskRepo: number; branch: string; newCommits: number; newHead: string | null };

const cacheGit = (dataDir: string, cache: string, args: string[]) =>
  git([`--git-dir=${cache}`, ...args], { env: gitSetup(longPath(dataDir)).env });

const isAncestor = (dataDir: string, cache: string, a: string, b: string) =>
  cacheGit(dataDir, cache, ["merge-base", "--is-ancestor", a, b]).then(
    () => true,
    () => false,
  );

const repoCache = (dataDir: string, r: Pick<UpdateRepo, "project" | "repo">) =>
  cachePath(longPath(dataDir), { project: r.project, repo: r.repo, id: 0 });

// spec.md section 6.18.5, Base check: `git ls-remote --heads` of the picked base. A head that differs from base_commit is fetched into
// refs/rl/task/<task>/update/<task_repo>. The base moved when that head is no ancestor of the task head. A base that is gone gives no
// move: the pre-flight blocks it (spec.md section 6.18.7).
export async function checkBase(
  dataDir: string,
  task: number,
  r: UpdateRepo,
  remote: BranchRemote,
): Promise<BaseMove & { fetched: string | null }> {
  const none = { taskRepo: r.row.id, branch: r.base, newCommits: 0, newHead: null };
  const head = (await remoteBranches(dataDir, remote, r.base)).get(r.base);
  if (!head || head === r.baseCommit) return { ...none, fetched: head ?? null };
  const fetched = await fetchBase(dataDir, task, r, remote);
  if (await baseIn(dataDir, r, fetched)) return { ...none, fetched };
  const n = Number((await cacheGit(dataDir, repoCache(dataDir, r), ["rev-list", "--count", `${r.baseCommit}..${fetched}`])).trim()) || 0;
  return { taskRepo: r.row.id, branch: r.base, newCommits: n, newHead: fetched, fetched };
}

// true: the task head holds the base head, so the base did not move (`git merge-base --is-ancestor`).
export const baseIn = (dataDir: string, r: UpdateRepo, head: string) => isAncestor(dataDir, repoCache(dataDir, r), head, r.head);

// Fetches the picked base branch of a repository into its cache (spec.md section 6.18.3 step 2). Returns the fetched head.
export async function fetchBase(dataDir: string, task: number, r: UpdateRepo, remote: BranchRemote): Promise<string> {
  const ref = `refs/rl/task/${task}/update/${r.row.id}`;
  const cache = await fetchInto(dataDir, r.project, r.repo, remote, [`+refs/heads/${r.base}:${ref}`]);
  const head = (await cacheGit(dataDir, cache, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  if (!HASH.test(head)) throw new UpdateAbort(`The server has no branch ${r.base}.`);
  return head;
}

// ---------- One repository ----------

const gitPath = async (wt: Worktree, name: string) => {
  const p = (await wtGit(wt, ["rev-parse", "--git-path", name])).trim();
  return isAbsolute(p) ? p : join(wt.repo, p);
};
export const inRebase = async (wt: Worktree) =>
  existsSync(await gitPath(wt, "rebase-merge")) || existsSync(await gitPath(wt, "rebase-apply"));
export const inMerge = async (wt: Worktree) => existsSync(await gitPath(wt, "MERGE_HEAD"));

// The user's name and email, and GIT_EDITOR=true, so a continue never opens an editor (spec.md section 6.18.3 step 3).
const ids = (who: { name: string; email: string }) => ({
  GIT_AUTHOR_NAME: who.name,
  GIT_AUTHOR_EMAIL: who.email,
  GIT_COMMITTER_NAME: who.name,
  GIT_COMMITTER_EMAIL: who.email,
  GIT_EDITOR: "true",
});

// spec.md section 6.18.4: `git diff --name-only -z --diff-filter=U`.
export async function unmergedPaths(wt: Worktree): Promise<string[]> {
  return (await wtGit(wt, ["diff", "--name-only", "-z", "--diff-filter=U"])).split("\0").filter(Boolean);
}

// The modes of the unmerged index entries by path (git-ls-files(1), --unmerged: "<mode> <object> <stage>\t<path>").
async function unmergedModes(wt: Worktree): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const rec of (await wtGit(wt, ["ls-files", "-u", "-z"])).split("\0")) {
    const m = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const set = out.get(m[2] as string) ?? new Set<string>();
    set.add(m[1] as string);
    out.set(m[2] as string, set);
  }
  return out;
}

// A stop of a rebase or a merge: the unmerged paths, split into gitlinks (the pointer rule) and files (a resolve step). null: the
// operation did not stop for a conflict.
export type Stop = { gitlinks: string[]; files: string[] };

async function stopOf(wt: Worktree, mode: "rebase" | "merge", full: string): Promise<Stop | null> {
  if (!(mode === "rebase" ? await inRebase(wt) : await inMerge(wt))) return null;
  const paths = await unmergedPaths(wt);
  if (!paths.length) return null;
  const modes = await unmergedModes(wt);
  const out: Stop = { gitlinks: [], files: [] };
  for (const p of paths) {
    const m = modes.get(p) ?? new Set<string>();
    if (m.has("160000")) out.gitlinks.push(p);
    // spec.md section 6.18.4: a path outside the sparse patterns, a link, or a denied path never goes to Claude.
    else if (m.has("120000") || deniedPath(p) || sparseHidden(p) || linksOn(wt.repo, p).length)
      throw new UpdateAbort(`The update changes ${full ? `${full}/${p}` : p}, which the task cannot edit.`);
    else out.files.push(p);
  }
  return out;
}

// spec.md section 6.18.3 step 3: `git rebase --onto <new base head> <base_commit> <branch>` before the first push, else
// `git merge --no-ff -m "<KEY>: merge <base> into <branch>" <new base head>`. Returns the first stop, or null when it ended clean.
export async function startUpdate(
  wt: Worktree,
  o: { mode: "rebase" | "merge"; newBaseHead: string; baseCommit: string; key: string; base: string; full: string },
  who: { name: string; email: string },
): Promise<Stop | null> {
  for (const h of [o.newBaseHead, o.baseCommit]) if (!HASH.test(h)) throw new UpdateAbort(`Invalid commit hash: ${h}`);
  const args =
    o.mode === "rebase"
      ? ["rebase", "--no-verify", "--onto", o.newBaseHead, o.baseCommit, wt.branch]
      : ["merge", "--no-ff", "--no-verify", "-m", `${o.key}: merge ${o.base} into ${wt.branch}`, o.newBaseHead];
  return run(wt, o.mode, o.full, args, who);
}

async function run(wt: Worktree, mode: "rebase" | "merge", full: string, args: string[], who: { name: string; email: string }) {
  try {
    await wtGit(wt, args, { extra: ids(who) });
    return null;
  } catch (e) {
    const stop = await stopOf(wt, mode, full);
    if (stop) return stop;
    throw new UpdateAbort(`git ${args[0]} failed in ${full || "the main repository"}: ${(e as Error).message}`);
  }
}

// spec.md section 6.18.4, Continue: `git add -- <path>` or `git rm -- <path>` for a deleted path, the gitlinks at their commits
// (`git update-index --cacheinfo`), then `git rebase --continue` or `git commit --no-edit`. Returns the next stop of a rebase, or null.
export async function continueUpdate(
  wt: Worktree,
  mode: "rebase" | "merge",
  full: string,
  files: string[],
  gitlinks: Map<string, string>,
  who: { name: string; email: string },
): Promise<Stop | null> {
  for (const p of files) {
    if (lstatSync(join(wt.repo, ...p.split("/")), { throwIfNoEntry: false })) await wtGit(wt, ["add", "--", p]);
    else await wtGit(wt, ["rm", "-q", "--", p]);
  }
  for (const [p, commit] of gitlinks) await setGitlink(wt, p, commit);
  return run(wt, mode, full, mode === "rebase" ? ["rebase", "--continue"] : ["commit", "--no-edit", "--no-verify", "-q"], who);
}

export async function setGitlink(wt: Worktree, path: string, commit: string) {
  if (!HASH.test(commit)) throw new UpdateAbort(`Invalid commit hash: ${commit}`);
  await wtGit(wt, ["update-index", "--cacheinfo", `160000,${commit},${path}`]);
}

// The gitlink of path in a commit of the worktree, or null.
export async function gitlinkAt(wt: Worktree, commit: string, path: string): Promise<string | null> {
  const out = await wtGit(wt, ["ls-tree", "-z", commit, "--", path]);
  return /^160000 commit ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t/.exec(out)?.[1] ?? null;
}

// spec.md section 6.18.3, Pointer: a gitlink conflict resolves to the new submodule head when the gitlink of the parent's new base head
// is an ancestor of it (`git merge-base --is-ancestor` in the submodule cache). Else the update aborts with the pointer sentence.
export async function pointerFor(
  dataDir: string,
  parent: { wt: Worktree; name: string; base: string; newBaseHead: string },
  sub: { path: string; name: string; cache: string; head: string },
): Promise<string> {
  const at = await gitlinkAt(parent.wt, parent.newBaseHead, sub.path);
  if (at && (await isAncestor(dataDir, sub.cache, at, sub.head))) return sub.head;
  throw new UpdateAbort(
    `The new ${parent.base} of ${parent.name} points ${sub.path} at a commit that the ${sub.name} task branch does not contain.`,
  );
}

// Commits the gitlink of path at commit in the parent worktree, unless it is already there (spec.md section 6.18.3, Pointer).
export async function commitPointer(wt: Worktree, path: string, commit: string, message: string, who: { name: string; email: string }) {
  if ((await gitlinkAt(wt, "HEAD", path)) === commit) return false;
  await setGitlink(wt, path, commit);
  await wtGit(wt, ["commit", "-q", "--no-verify", "-F", "-"], { stdin: message, extra: ids(who) });
  return true;
}

// spec.md section 6.18.4, Marker check: in each unmerged path that still exists, no line starts with <<<<<<<, |||||||, or >>>>>>> at the
// marker size, followed by a space or the line end. The size comes from `git check-attr conflict-marker-size`, else 7. A lone =======
// line is valid text. Returns the first path with a marker, or null.
export async function markerLeft(wt: Worktree, paths: string[]): Promise<string | null> {
  const files = paths.filter((p) => lstatSync(join(wt.repo, ...p.split("/")), { throwIfNoEntry: false })?.isFile());
  if (!files.length) return null;
  // git-check-attr(1) with -z: "<path> NUL <attribute> NUL <info> NUL".
  const out = (await wtGit(wt, ["check-attr", "-z", "conflict-marker-size", "--", ...files])).split("\0");
  const size = new Map<string, number>();
  for (let k = 0; k + 2 < out.length; k += 3) {
    const n = Number(out[k + 2]);
    size.set(out[k] as string, Number.isSafeInteger(n) && n > 0 ? n : MARKER_SIZE);
  }
  for (const p of files) {
    const n = size.get(p) ?? MARKER_SIZE;
    const re = new RegExp(`^(?:<{${n}}|\\|{${n}}|>{${n}})(?: |\\r?$)`, "m");
    if (re.test(readFileSync(join(wt.repo, ...p.split("/")), "latin1"))) return p;
  }
  return null;
}

// spec.md section 6.18.4: context/conflicts.md, untrusted data. It names the sides "base side" and "task side", because a rebase and a
// merge swap ours and theirs.
export function conflictsFile(o: {
  name: string;
  full: string;
  base: string;
  newBaseHead: string;
  mode: "rebase" | "merge";
  paths: string[];
}): ContextFile {
  const sides =
    o.mode === "rebase"
      ? 'The app replays the task commits on the newest base. In each conflict, the lines between "<<<<<<<" and "=======" are the base side, and the lines between "=======" and ">>>>>>>" are the task side.'
      : 'The app merges the newest base into the task branch. In each conflict, the lines between "<<<<<<<" and "=======" are the task side, and the lines between "=======" and ">>>>>>>" are the base side.';
  const at = (p: string) => (o.full ? `${o.full}/${p}` : p);
  return {
    name: "conflicts.md",
    text: [
      "# Conflicts",
      "",
      `- Repository: ${o.name} at ./repo${o.full ? `/${o.full}` : ""}`,
      `- Base: ${o.base} at ${o.newBaseHead}`,
      `- Mode: ${o.mode}`,
      "",
      sides,
      "",
      "## Files with conflicts (paths from ./repo)",
      "",
      ...o.paths.map((p) => `- ${at(p)}`),
      "",
    ].join("\n"),
  };
}

// ---------- Several repositories ----------

const childPaths = (trees: readonly RepoTree[], t: RepoTree) =>
  new Set(trees.filter((x) => x.row.parent === t.row.id && x.row.role === "submodule").map((x) => x.row.path ?? ""));
const under = (full: string, p: string) => (full ? `${full}/${p}` : p);

// The paths that differ from the index in the stopped repository and its untracked files, each with a hash of its bytes. git can
// leave untracked files at a stop, for example <path>~HEAD after a rename conflict, so the check compares the state around the step.
async function looseFiles(wt: Worktree): Promise<Map<string, string>> {
  const diff = (await wtGit(wt, ["diff", "--name-only", "-z", "--ignore-submodules=all"])).split("\0");
  const added = (await wtGit(wt, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0");
  const out = new Map<string, string>();
  for (const p of new Set([...diff, ...added])) {
    if (!p) continue;
    const f = join(wt.repo, ...p.split("/"));
    const st = lstatSync(f, { throwIfNoEntry: false });
    out.set(p, !st ? "gone" : st.isFile() ? String(Bun.hash(readFileSync(f))) : st.isSymbolicLink() ? "link" : "other");
  }
  return out;
}

// The state that a resolve step may not change, right before the step: the loose files of the stopped repository and the status of
// every other repository.
export type ResolveSnapshot = { files: Map<string, string>; status: Map<RepoTree, Set<string>> };
export async function resolveSnapshot(trees: readonly RepoTree[], conflict: RepoTree): Promise<ResolveSnapshot> {
  const out: ResolveSnapshot = { files: await looseFiles(conflict.wt as Worktree), status: new Map() };
  for (const t of trees) if (t.wt && t !== conflict) out.status.set(t, new Set((await status(t.wt)).map((e) => e.path)));
  return out;
}

// spec.md section 6.18.4, Path check of a resolve step: each changed path is an unmerged path of this stop. Every other repository
// stays as it was, apart from the gitlinks of its submodules. No file outside repo/, no link, no ignored file, and no changed git link.
export async function resolveProblems(
  trees: readonly RepoTree[],
  conflict: RepoTree,
  paths: readonly string[],
  before: ResolveSnapshot,
  context: ReadonlyMap<string, string | Uint8Array>,
  ignored: IgnoredSnapshot,
): Promise<PathProblem[]> {
  const problems: PathProblem[] = [];
  const allowed = new Set(paths);
  const main = trees.find((x) => x.row.role === "main")?.wt as Worktree;
  for (const t of deepestFirst(trees)) {
    if (!t.wt) {
      if (t.row.access === "none" && trees.find((x) => x.row.id === t.row.parent)?.wt)
        for (const p of noneChanges(trees, t)) problems.push({ path: p, reason: "The step changed a repository without access." });
      continue;
    }
    if (!gitLinkOk(t.wt)) problems.push({ path: under(t.full, ".git"), reason: "The step changed the git link of the worktree." });
    const kids = childPaths(trees, t);
    let changed: string[];
    if (t === conflict) {
      const after = await looseFiles(t.wt);
      changed = [...new Set([...after.keys(), ...before.files.keys()])].filter(
        (p) => !allowed.has(p) && after.get(p) !== before.files.get(p),
      );
      for (const p of paths)
        for (const l of linksOn(t.wt.repo, p)) problems.push({ path: under(t.full, l), reason: "A step may not make links." });
    } else {
      const was = before.status.get(t) ?? new Set<string>();
      changed = (await status(t.wt)).map((e) => e.path).filter((p) => !was.has(p) && !kids.has(p.replace(/\/+$/, "")));
    }
    for (const p of changed) problems.push({ path: under(t.full, p), reason: "The path has no conflict." });
  }
  for (const p of outsideRepo(main, context, addedFolders(trees)))
    problems.push({ path: `../${p}`, reason: "A step may change files only in repo/." });
  for (const p of ignoredChanges(ignored, await ignoredSnapshot(main)))
    problems.push({ path: p, reason: "A step may not write a file that git ignores." });
  return problems;
}

// spec.md section 6.18.4, Abort, and the restart recovery: in each repository, `git rebase --abort` when a rebase runs, else
// `git merge --abort` when MERGE_HEAD exists, then `git reset --hard <preHead>` and `git clean -ffd`, deepest first. A worktree of
// the task branch gets HEAD back on its branch first.
export async function resetToPre(trees: readonly RepoTree[], pre: UpdateDetail["preHeads"]) {
  for (const t of deepestFirst(trees)) {
    const p = pre.find((x) => x.taskRepo === t.row.id);
    if (!t.wt || !p) continue;
    if (await inRebase(t.wt)) await wtGit(t.wt, ["rebase", "--abort"]);
    else if (await inMerge(t.wt)) await wtGit(t.wt, ["merge", "--abort"]);
    if (t.wt.branch) await wtGit(t.wt, ["symbolic-ref", "HEAD", `refs/heads/${t.wt.branch}`]);
    await resetWorktree(t.wt, p.head);
  }
}

// The heads of every repository of the part with a worktree, with the base and pinned commits of its row (spec.md section 6.18.3
// step 1). The main repository takes task.base_commit.
export async function headsOf(trees: readonly RepoTree[], mainBase: string | null): Promise<UpdateDetail["preHeads"]> {
  const out: UpdateDetail["preHeads"] = [];
  for (const t of trees)
    if (t.wt)
      out.push({
        taskRepo: t.row.id,
        head: await headOf(t.wt),
        baseCommit: t.row.role === "main" ? mainBase : t.row.base_commit,
        pinned: t.row.pinned,
      });
  return out;
}

// A submodule without commits of the task follows the gitlink of its parent after the update (its parent first). A missing commit is
// fetched from the base branch, then from every branch (spec.md section 6.16.5, Fetch). Returns the moved rows with their new commit.
export async function followGitlinks(
  dataDir: string,
  task: number,
  trees: readonly RepoTree[],
  changed: ReadonlySet<number>,
  remote: (project: string, repo: string) => Promise<BranchRemote>,
): Promise<{ row: TaskRepoRow; commit: string }[]> {
  const moved: { row: TaskRepoRow; commit: string }[] = [];
  for (const t of [...trees].sort((a, b) => a.row.depth - b.row.depth)) {
    if (t.row.role !== "submodule" || !t.wt || changed.has(t.row.id) || !t.row.path) continue;
    const parent = trees.find((x) => x.row.id === t.row.parent);
    if (!parent?.wt) continue;
    const want = await gitlinkAt(parent.wt, "HEAD", t.row.path);
    if (!want || want === (await headOf(t.wt))) continue;
    const has = async () =>
      (
        await git([`--git-dir=${t.wt?.cache}`, "rev-parse", "--verify", "--quiet", `${want}^{commit}`], { env: t.wt?.env ?? {} }).catch(
          () => "",
        )
      ).trim() === want;
    const src = sourceOf(
      trees.map((x) => x.row),
      t.row,
    );
    if (!(await has()) && src.project && src.repo && src.base_branch) {
      const r = await remote(src.project, src.repo);
      const ns = `refs/rl/task/${task}/sub`;
      await fetchInto(dataDir, src.project, src.repo, r, [`+refs/heads/${src.base_branch}:${ns}/base`]);
      if (!(await has())) await fetchInto(dataDir, src.project, src.repo, r, [`+refs/heads/*:${ns}/heads/*`]);
    }
    if (!(await has()))
      throw new UpdateAbort(`The new base of the repository points ${t.full} at a commit that is on no branch of its server.`);
    await resetWorktree(t.wt, want);
    moved.push({ row: t.row, commit: want });
  }
  return moved;
}
