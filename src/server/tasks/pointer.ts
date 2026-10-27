// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// "Point <parent> at the merged commit" (docs/plans/review-v2/spec.md section 6.16.8, Pointer after a submodule merge): the check that
// the fetched base branch of the submodule holds the merge commit, and the gitlink commit in the parent worktree. pr.ts reads the merge
// commit before and pushes the parent after. All of it runs only on the user's click.
import type { Database } from "bun:sqlite";
import { git } from "../review/git";
import { type BranchRemote, fetchInto, gitSetup, longPath } from "../review/workspace";
import { fullPath, type TaskRepoRow, taskRepos } from "./repos";
import { commitPointer } from "./update";
import { headOf, openRepoTrees, openWorktree, resetWorktree, status } from "./worktree";

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const noMergeText = (parent: string, base: string, sub: string) =>
  `Bitbucket did not name the merge commit. Point ${parent} at the newest ${base} commit of ${sub}?`;

// Fetches the base branch of the submodule into its cache and returns its head. commit: the merge commit, which the base must hold
// (`git merge-base --is-ancestor`). null: the newest base commit, which the user confirmed.
export async function pointerTarget(
  dataDir: string,
  task: number,
  sub: { id: number; project: string; repo: string; base: string },
  remote: BranchRemote,
  commit: string | null,
): Promise<{ commit: string } | { error: string }> {
  const ref = `refs/rl/task/${task}/pointer/${sub.id}`;
  const cache = await fetchInto(dataDir, sub.project, sub.repo, remote, [`+refs/heads/${sub.base}:${ref}`]);
  const { env } = gitSetup(longPath(dataDir));
  const head = (await git([`--git-dir=${cache}`, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { env }).catch(() => "")).trim();
  const name = `${sub.project}/${sub.repo}`;
  if (!HASH.test(head)) return { error: `${sub.base} no longer exists in ${name}.` };
  if (commit === null) return { commit: head };
  if (!HASH.test(commit)) return { error: `Bitbucket named an invalid merge commit: ${commit}` };
  const holds = await git([`--git-dir=${cache}`, "merge-base", "--is-ancestor", commit, head], { env }).then(
    () => true,
    () => false,
  );
  return holds ? { commit } : { error: `The merge commit ${commit.slice(0, 12)} is not on ${sub.base} of ${name}.` };
}

type TaskRef = Parameters<typeof taskRepos>[1] & { key: string; base_commit: string | null };

// Commits the gitlink of the submodule at commit in the parent worktree with "<KEY>: point <path> at the merged commit", unless the
// parent already points there, and moves the submodule worktree to commit. Returns the parent head.
export async function commitGitlink(i: {
  dataDir: string;
  db: Database;
  t: TaskRef;
  part: { ord: number; branch: string };
  sub: TaskRepoRow;
  commit: string;
  who: { name: string; email: string };
}): Promise<{ head: string } | { error: string }> {
  const { t, part } = i;
  if (!t.base_commit) return { error: "The task has no approved plan." };
  const main = await openWorktree({
    dataDir: i.dataDir,
    db: i.db,
    project: t.project,
    repo: t.repo,
    task: t.id,
    ord: part.ord,
    branch: part.branch,
    base: t.base_commit,
  });
  const rows = taskRepos(i.db, t);
  const trees = await openRepoTrees({ dataDir: i.dataDir, db: i.db, task: t.id, ord: part.ord, branch: part.branch, main, rows });
  const tree = trees.find((x) => x.row.id === i.sub.id);
  const path = fullPath(rows, i.sub);
  if (!tree?.wt || i.sub.parent !== rows.find((r) => r.role === "main")?.id)
    return { error: `${path} is not an editable submodule of ${t.project}/${t.repo}.` };
  for (const w of [main, tree.wt])
    if ((await status(w)).some((e) => w !== main || e.path.replace(/\/+$/, "") !== path))
      return { error: `${w === main ? `${t.project}/${t.repo}` : path} has changes that are not committed.` };
  await commitPointer(main, path, i.commit, `${t.key}: point ${path} at the merged commit`, i.who);
  if ((await headOf(tree.wt)) !== i.commit) await resetWorktree(tree.wt, i.commit);
  return { head: await headOf(main) };
}
