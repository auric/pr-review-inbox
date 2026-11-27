// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fix it (plan r3 S-APPLY): the patch from the app cache, and git in the user's clone. Git in the clone runs no network command.
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CloneDto, CloneProblem, FixCommitDto, FixCommitState, FixMode } from "../../shared/dto";
import { applyEdits, deniedPath, fold, type Located, locate, prepareFile } from "./edits";
import { GitError, git, userGitEnv } from "./git";
import { inside } from "./paths";
import { repoPath } from "./validate";
import { cachePath, diffArgs, gitSetup, locked, longPath } from "./workspace";

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Plan r3: hooks and signing run in the commit. Every git call in the clone stops after this time.
const CLONE_MS = 120_000;
// package.json keys that configure commit hooks (husky 4, lint-staged, simple-git-hooks, commitlint, pre-commit, yorkie).
const HOOK_KEYS = ["husky", "lint-staged", "simple-git-hooks", "commitlint", "pre-commit", "gitHooks"];
// The state files of a merge, cherry-pick, revert, rebase, or bisect in progress (git wt-status.c).
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"];

export const CLONE_TEXT: Record<CloneProblem, string> = {
  not_set: "Set the folder of your clone of this repository.",
  missing: "The clone folder does not exist.",
  not_repo: "The folder is not the top folder of a git clone.",
  detached: "HEAD is detached. Check out the source branch of the pull request.",
  branch: "The clone is on another branch. Check out the source branch of the pull request.",
  no_base: "The clone branch does not contain the commit that the fix run read. Pull, or run the fix again.",
  behind: "The clone does not have the newest commit of the pull request. Pull first.",
  diverged: "The clone branch and the pull request branch diverged. Merge or rebase in your clone first.",
  dirty: "The clone has changes to tracked files. Commit or stash them first.",
  busy: "A merge, rebase, cherry-pick, revert, or bisect is in progress in the clone. Finish it first.",
  identity: "Set user.name and user.email in your git config.",
  patch: "The edits do not apply to the clone. Pull, or commit to an app branch.",
};
export const cloneProblem = (kind: CloneProblem) => ({ kind, text: CLONE_TEXT[kind] });

// The user's env: the user's own config, identity, signing, and hooks.
const inClone = (path: string, args: string[], stdin?: string) => git(args, { cwd: path, env: userGitEnv(), stdin, timeoutMs: CLONE_MS });
const succeeds = (p: Promise<unknown>) =>
  p.then(
    () => true,
    () => false,
  );

function realPath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

// PUT /clone: the long real path of the top folder of a clone with a working tree, or an error text.
export async function clonePath(raw: string, dataDir: string): Promise<{ path: string } | { error: string }> {
  if (!isAbsolute(raw)) return { error: "Enter an absolute path." };
  const path = realPath(raw);
  if (path === null || !statSync(path).isDirectory()) return { error: "The folder does not exist." };
  if (inside(realPath(dataDir) ?? resolve(dataDir), path, { withRoot: true }))
    return { error: "The clone cannot be in the app data folder." };
  const bare = await inClone(path, ["rev-parse", "--is-bare-repository"]).catch(() => null);
  if (bare === null) return { error: "The folder is not in a git clone." };
  if (bare.trim() === "true") return { error: "The folder is a bare repository. Choose a clone with a working tree." };
  const top = (await inClone(path, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!top || realPath(top) !== path) return { error: "Choose the top folder of the clone." };
  return { path };
}

// branch: the PR source branch. base: the source head S of the fix run. live: the PR source head L.
export type CloneWant = { branch: string; base?: string; live?: string };

// The plan r3 checks before Apply. Each problem has a fixed text.
export async function checkClone(path: string | null, want: CloneWant): Promise<CloneDto> {
  const out: CloneDto = { path, problems: [], branch: null, head: null };
  const add = (kind: CloneProblem) => out.problems.push(cloneProblem(kind));
  if (path === null) add("not_set");
  else if (!existsSync(path)) add("missing");
  if (path === null || out.problems.length) return out;
  const top = (await inClone(path, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!top || realPath(top) !== path) {
    add("not_repo");
    return out;
  }
  Object.assign(out, await cloneHead(path));
  if (out.branch === null) add("detached");
  else if (out.branch !== want.branch) add("branch");
  const head = out.head;
  const reaches = async (c: string) =>
    head !== null && HASH.test(c) && (await succeeds(inClone(path, ["merge-base", "--is-ancestor", c, head])));
  if (want.base !== undefined && !(await reaches(want.base))) add("no_base");
  if (want.live !== undefined && !(await reaches(want.live))) {
    const known = HASH.test(want.live) && (await succeeds(inClone(path, ["cat-file", "-e", `${want.live}^{commit}`])));
    add(known ? "diverged" : "behind");
  }
  // --untracked-files=no: untracked files are allowed. A collision fails `apply --check`.
  if ((await inClone(path, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=no"])) !== "") add("dirty");
  const marks = (await inClone(path, ["rev-parse", ...IN_PROGRESS.flatMap((n) => ["--git-path", n])])).split("\n").filter(Boolean);
  if (marks.some((m) => existsSync(resolve(path, m)))) add("busy");
  for (const k of ["user.name", "user.email"])
    if (!(await inClone(path, ["config", "--get", k]).catch(() => "")).trim()) {
      add("identity");
      break;
    }
  return out;
}

const parts = (p: string) =>
  p
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .map(fold);
const under = (path: string, folder: string) => {
  const a = parts(path);
  return parts(folder).every((s, i) => a[i] === s);
};

// The core.hooksPath folder of the clone as a repository path ("" is the top folder). null: not set, or outside the clone.
// githooks(5): a relative core.hooksPath is relative to the top folder of the working tree.
export async function hooksFolder(path: string): Promise<string | null> {
  const v = (await inClone(path, ["config", "--type=path", "--get", "core.hooksPath"]).catch(() => "")).trim();
  if (!v) return null;
  const r = relative(path, resolve(path, v));
  return inside(path, resolve(path, v), { withRoot: true }) ? r.split(sep).join("/") : null;
}

// The hook keys of a package.json text. null: the text is not JSON.
function hookConfig(text: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  const o = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return JSON.stringify(HOOK_KEYS.map((k) => (Object.hasOwn(o, k) ? o[k] : null)));
}

// git() decodes stdout as text. That drops a BOM and hides invalid UTF-8, so the callers read the blob bytes here.
export async function blobBytes(cache: string, env: Record<string, string>, sha: string): Promise<Uint8Array> {
  const p = Bun.spawn(["git", `--git-dir=${cache}`, "cat-file", "blob", sha], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLONE_MS,
    killSignal: "SIGKILL",
  });
  const [bytes, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new GitError(`git cat-file failed (exit ${code ?? p.signalCode}): ${err.trim().slice(-2000)}`);
  return bytes;
}

export type PatchEdit = { id: number; path: string; old: string; new: string };
// tree: T. paths: the changed paths.
export type Patch = { tree: string; patch: string; paths: string[] };

// Plan r3 "Patch": the new blobs, tree T from a temp index, and `git diff S T`, all in the cache with its env.
// hooks: the core.hooksPath folder of the clone. Returns an error text for a refused edit.
export async function buildPatch(
  cache: string,
  env: Record<string, string>,
  base: string,
  edits: PatchEdit[],
  hooks: string | null = null,
): Promise<Patch | { error: string }> {
  const g = (args: string[], o: { stdin?: string; index?: string } = {}) =>
    git(["--literal-pathspecs", `--git-dir=${cache}`, ...args], {
      env: o.index ? { ...env, GIT_INDEX_FILE: o.index } : env,
      stdin: o.stdin,
    });
  if (!HASH.test(base) || !(await succeeds(g(["cat-file", "-e", `${base}^{commit}`]))))
    return { error: "The app cache does not hold the commit that the fix run read. Run the fix again." };
  const byPath = new Map<string, PatchEdit[]>();
  for (const e of edits) {
    const p = repoPath(e.path);
    // Hooks run on the commit. No edit may change a hook source (plan r3, user decision).
    if (p === null || deniedPath(p) || (hooks !== null && under(p, hooks)))
      return { error: `Edit ${e.id} changes ${e.path}. The app does not change hook sources or Claude Code files.` };
    byPath.set(p, [...(byPath.get(p) ?? []), e]);
  }
  const entries: string[] = [];
  for (const [path, list] of byPath) {
    const refuse = (why: string) => ({ error: `Edit ${list[0]?.id} on ${path}: ${why}` });
    const row = (await g(["ls-tree", "-z", "--full-tree", base, "--", path])).split("\0")[0] ?? "";
    let mode = "100644";
    let text: string | null = null;
    if (row) {
      const [info = "", name] = row.split("\t");
      const [m = "", type, sha = ""] = info.split(" ");
      if (name !== path || type !== "blob") return refuse("the path is not a file.");
      const file = prepareFile(await blobBytes(cache, env, sha), m);
      if ("problem" in file) return refuse(`the file is refused (${file.problem}).`);
      mode = m;
      text = file.text;
    }
    const located: Located[] = [];
    for (const e of list) {
      const l = locate(text, e.old, e.new);
      if ("problem" in l) return refuse(`the old text does not match (${l.problem}).`);
      located.push(l);
    }
    let next: string;
    try {
      next = applyEdits(text ?? "", located);
    } catch (e) {
      return refuse((e as Error).message);
    }
    if (fold(path.split("/").at(-1) ?? "") === "package.json") {
      const before = text === null ? hookConfig("{}") : hookConfig(text);
      const after = hookConfig(next);
      if (before === null || after === null || before !== after)
        return refuse("the edit changes hook config, or package.json is not valid JSON.");
    }
    const sha = (await g(["hash-object", "-w", "--no-filters", "--stdin"], { stdin: next })).trim();
    entries.push(`${mode} ${sha}\t${path}\0`);
  }
  const dir = mkdtempSync(join(tmpdir(), "rl-fix-"));
  try {
    const index = join(dir, "index");
    await g(["read-tree", base], { index });
    await g(["update-index", "-z", "--index-info"], { index, stdin: entries.join("") });
    const tree = (await g(["write-tree"], { index })).trim();
    const paths = (await g(["diff", "--name-only", "-z", "--no-renames", base, tree])).split("\0").filter(Boolean);
    if (!paths.length) return { error: "The edits change nothing." };
    return { tree, patch: await g(["diff", ...diffArgs, base, tree]), paths };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `apply --index` and `reset --keep` trust the stat data in the index file. `status --no-optional-locks` does not write it, and
// a git with another core.autocrlf can smudge a racily clean entry. The refresh records the stat data of unchanged files.
const refreshIndex = (path: string) => inClone(path, ["update-index", "-q", "--refresh"]);

// git-apply(1): all or nothing. --index needs the index to equal the worktree for each touched path.
// The check runs alone first, so the caller can record the apply. Untracked files that collide fail the check.
export async function applyCheck(path: string, patch: string, reverse = false) {
  await refreshIndex(path);
  return succeeds(inClone(path, ["apply", "--index", "--whitespace=nowarn", "--check", ...(reverse ? ["-R"] : [])], patch));
}
export const applyIndex = (path: string, patch: string, reverse = false) =>
  inClone(path, ["apply", "--index", "--whitespace=nowarn", ...(reverse ? ["-R"] : [])], patch);

// `git commit -F -` with the user's hooks and signing. Returns HEAD. A hook or signing failure throws a GitError with the stderr tail.
export async function commitIndex(path: string, message: string): Promise<{ commit: string; short: string }> {
  await inClone(path, ["commit", "-q", "-F", "-"], message);
  return {
    commit: (await inClone(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim(),
    short: (await inClone(path, ["rev-parse", "--short", "HEAD"])).trim(),
  };
}

// The identity of a cache commit: the clone config when the clone is set, else the global config. Both with the user's env.
export async function identity(clone: string | null): Promise<{ name: string; email: string } | null> {
  const read = async (k: string) =>
    (clone && existsSync(clone)
      ? await inClone(clone, ["config", "--get", k]).catch(() => "")
      : await git(["config", "--global", "--get", k], { env: userGitEnv(), timeoutMs: CLONE_MS }).catch(() => "")
    ).trim();
  const [name, email] = [await read("user.name"), await read("user.email")];
  return name && email ? { name, email } : null;
}

// Plan r3 "Commit to an app branch": commit T with parent S in the cache. The message gets the whitespace cleanup of `git commit`.
export async function cacheCommit(
  cache: string,
  env: Record<string, string>,
  patch: { base: string; tree: string },
  message: string,
  who: { name: string; email: string },
): Promise<{ commit: string; short: string }> {
  const ids = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
  const msg = await git(["stripspace"], { env, stdin: message });
  const commit = (
    await git([`--git-dir=${cache}`, "commit-tree", patch.tree, "-p", patch.base], { env: { ...env, ...ids }, stdin: msg })
  ).trim();
  return { commit, short: (await git([`--git-dir=${cache}`, "rev-parse", "--short", commit], { env })).trim() };
}

// The ref of a cache commit. The fix run keeps its head at refs/rl/<pr>/fix/<run>, so the commits use another folder.
export const fixRef = (prId: number, id: number) => `refs/rl/${prId}/fix-commit/${id}`;

// A staged or committed fix commit can still need the cache commits under refs/rl/<PR ID>/ for its undo or its fetch.
const CLOSED_PRS = `SELECT p.project, p.repo, p.pr_id FROM pull_request p WHERE p.state IN ('MERGED', 'DECLINED')
  AND NOT EXISTS (SELECT 1 FROM fix_commit c WHERE c.pr = p.id AND c.state <> 'undone') ORDER BY p.id`;

// Deletes refs/rl/<PR ID>/* of each merged or declined PR without an open fix commit, so gc can drop the PR objects.
// A reopened declined PR fetches its heads again at its next run.
// One for-each-ref per cache. run: the git runner, replaced in tests.
export async function pruneRefs(db: Database, dataDir: string, run: typeof git = git) {
  const dir = longPath(dataDir);
  const { env } = gitSetup(dir);
  const closed = new Map<string, Set<string>>();
  for (const p of db.query(CLOSED_PRS).all() as { project: string; repo: string; pr_id: number }[]) {
    let cache: string;
    try {
      cache = cachePath(dir, { project: p.project, repo: p.repo, id: p.pr_id });
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(p.pr_id) || !existsSync(join(cache, "HEAD"))) continue;
    closed.set(cache, (closed.get(cache) ?? new Set()).add(String(p.pr_id)));
  }
  for (const [cache, ids] of closed)
    await locked(cache, async () => {
      // refs/rl/task/<id>/ and refs/rl/sub/ share the prefix. Only refs/rl/<PR ID>/ belongs to a PR.
      const refs = (await run([`--git-dir=${cache}`, "for-each-ref", "--format=%(refname)", "refs/rl/"], { env }))
        .split("\n")
        .filter((r) => ids.has(/^refs\/rl\/(\d+)\//.exec(r)?.[1] ?? ""));
      if (refs.length)
        await run([`--git-dir=${cache}`, "update-ref", "--stdin"], { env, stdin: refs.map((r) => `delete ${r}\n`).join("") });
    });
}

// "<mode> <sha>" of each index entry of the clone, per path.
export async function indexEntries(path: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of (await inClone(path, ["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...paths])).split("\0").filter(Boolean)) {
    const [info = "", name = ""] = r.split("\t");
    const [mode, sha, stage] = info.split(" ");
    out.set(name, stage === "0" ? `${mode} ${sha}` : "conflict");
  }
  return out;
}

export async function treeEntries(cache: string, env: Record<string, string>, tree: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rows = await git(["--literal-pathspecs", `--git-dir=${cache}`, "ls-tree", "-z", "--full-tree", tree, "--", ...paths], { env });
  for (const r of rows.split("\0").filter(Boolean)) {
    const [info = "", name = ""] = r.split("\t");
    const [mode, , sha] = info.split(" ");
    out.set(name, `${mode} ${sha}`);
  }
  return out;
}

// The staged paths of the clone against HEAD.
export async function stagedPaths(path: string): Promise<string[]> {
  return (await inClone(path, ["diff-index", "--cached", "--name-only", "-z", "--no-renames", "HEAD"])).split("\0").filter(Boolean);
}

export async function cloneHead(path: string): Promise<{ head: string | null; branch: string | null }> {
  const ref = (await inClone(path, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim();
  const head = (await inClone(path, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).catch(() => "")).trim();
  return { head: head || null, branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null };
}

export async function resetKeep(path: string, to: string) {
  await refreshIndex(path);
  await inClone(path, ["reset", "-q", "--keep", to]);
}

export type FixCommitRow = {
  id: number;
  pr: number;
  run: number;
  edits_json: string;
  mode: FixMode;
  clone_path: string | null;
  branch: string | null;
  before_head: string;
  commit_hash: string | null;
  short_hash: string | null;
  state: FixCommitState;
  created_at: number;
  // pull_request.pr_id: the Bitbucket PR ID of the ref.
  pr_id: number;
};

// cache: the cache path of the repository. fetch is set only for a cache commit that is not undone.
export function toFixCommitDto(r: FixCommitRow, cache: string): FixCommitDto {
  return {
    id: r.id,
    run: r.run,
    mode: r.mode,
    edits: JSON.parse(r.edits_json) as number[],
    branch: r.branch,
    before: r.before_head,
    commit: r.commit_hash,
    short: r.short_hash,
    state: r.state,
    fetch: r.mode === "cache" && r.state === "committed" ? { cache: cache.replaceAll("\\", "/"), ref: fixRef(r.pr_id, r.id) } : null,
    createdAt: r.created_at,
  };
}
