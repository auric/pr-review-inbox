// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/git-deny.md fix F (spec.md section 6.8): the git state of a part around one Claude step. A Bash command can run
// git through `bash -c` (Gate B34), so the app saves the state before the step and puts it back after the step. The files go back before
// any other git call of the app reads them.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { CACHE_FILES, cacheState, exclusive, gitRaw, otherWatches, record, watchCache } from "../review/git";
import { headOf, type Worktree } from "./worktree";

// The files of the git folder of a worktree that git reads, besides the index.
const ADMIN_FILES = ["HEAD", "commondir", "gitdir", "config.worktree", "info/sparse-checkout"];

// quiet: the file goes back, but a change of it is no item. git status of a step rewrites the index, and a restore removes what a step
// staged past the commit of the app.
type FileSnap = { path: string; label: string; bytes: Buffer | null; quiet?: boolean };
type CacheSnap = {
  cache: string;
  env: Record<string, string>;
  state: Map<string, string>;
  watch: ReturnType<typeof watchCache>;
};
// heads: the HEAD commit of each worktree at the step start.
export type GitSnap = { files: FileSnap[]; caches: CacheSnap[]; heads: { wt: Worktree; head: string }[] };

function read(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

// A folder or a link in place of a file goes first. rmSync removes a link, not its target.
function put(path: string, bytes: Buffer | null) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  if (bytes === null) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));
const rel = (wt: Worktree, p: string) => relative(wt.dir, p).replaceAll("\\", "/");

export const stopGit = (s: Pick<GitSnap, "caches">) => {
  for (const c of s.caches) c.watch.stop();
};

// The state before a step: the refs and CACHE_FILES of each cache, the git link and the git folder files of each worktree, the empty
// global config of the app, and each HEAD commit. Each cache watch starts before its snapshot, so no app git call falls between them.
export async function snapGit(wts: readonly Worktree[]): Promise<GitSnap> {
  const caches: CacheSnap[] = [];
  try {
    for (const wt of wts) {
      if (caches.some((c) => c.cache === wt.cache)) continue;
      caches.push(
        await exclusive(wt.cache, async () => {
          const watch = watchCache(wt.cache, wt.env);
          try {
            return { cache: wt.cache, env: wt.env, watch, state: await cacheState(wt.cache, wt.env) };
          } catch (e) {
            watch.stop();
            throw e;
          }
        }),
      );
    }
    const files: FileSnap[] = [];
    const global = wts[0]?.env.GIT_CONFIG_GLOBAL;
    if (global) files.push({ path: global, label: `git/${basename(global)}`, bytes: read(global) });
    for (const wt of wts) {
      const link = join(wt.repo, ".git");
      files.push({ path: link, label: rel(wt, link), bytes: read(link) });
      for (const f of ADMIN_FILES) {
        const p = join(wt.admin, f);
        files.push({ path: p, label: `${basename(wt.cache)}/worktrees/${basename(wt.admin)}/${f}`, bytes: read(p) });
      }
      files.push({ path: join(wt.admin, "index"), label: "index", bytes: read(join(wt.admin, "index")), quiet: true });
    }
    const heads: GitSnap["heads"] = [];
    for (const wt of wts) heads.push({ wt, head: await headOf(wt) });
    return { files, caches, heads };
  } catch (e) {
    stopGit({ caches });
    throw e;
  }
}

// Puts the state of snap back and returns what the step changed, as short labels: file paths, and refs with "(new)" or "(deleted)". The
// expected value of a key is the last one that an app git call gave it during the step, else the one of the snapshot. Throws when the
// state does not come back, for example when the step deleted an object that a ref needs.
export async function checkGit(s: GitSnap): Promise<string[]> {
  const moved: string[] = [];
  const wants = new Map<string, Map<string, string>>();
  try {
    for (const f of s.files) {
      if (same(read(f.path), f.bytes)) continue;
      if (!f.quiet) moved.push(f.label);
      put(f.path, f.bytes);
    }
    for (const c of s.caches)
      await exclusive(c.cache, async () => {
        const want = new Map(c.state);
        for (const [k, v] of c.watch.app)
          if (v === null) want.delete(k);
          else want.set(k, v);
        wants.set(c.cache, want);
        const before = new Map<string, string>();
        for (const f of CACHE_FILES) {
          const now = read(join(c.cache, f));
          if (now !== null) before.set(`file ${f}`, now.toString("base64"));
          const b = want.get(`file ${f}`);
          if (now?.toString("base64") === b || (now === null && b === undefined)) continue;
          moved.push(`${basename(c.cache)}/${f}`);
          put(join(c.cache, f), b === undefined ? null : Buffer.from(b, "base64"));
        }
        // git reads the files above, so the refs come only now.
        const refs = await cacheState(c.cache, c.env, false);
        for (const [k, v] of refs) before.set(k, v);
        const lines: string[] = [];
        for (const k of new Set([...refs.keys(), ...want.keys()])) {
          const now = refs.get(k);
          const was = want.get(k);
          if (!k.startsWith("ref ") || now === was) continue;
          const ref = k.slice("ref ".length);
          moved.push(was === undefined ? `${ref} (new)` : now === undefined ? `${ref} (deleted)` : ref);
          lines.push(
            was === undefined ? `delete ${ref} ${now}` : now === undefined ? `create ${ref} ${was}` : `update ${ref} ${was} ${now}`,
          );
        }
        // One ref per call, so a ref that cannot come back does not stop the others. --no-deref: a symbolic ref that the step made goes
        // itself, not its target.
        const failed: string[] = [];
        for (const l of lines)
          await gitRaw([`--git-dir=${c.cache}`, "update-ref", "--no-deref", "--stdin"], { env: c.env, stdin: `${l}\n` }).catch((e) =>
            failed.push((e as Error).message),
          );
        // The steps beside this one count the restore as a change of the app.
        const others = otherWatches(c.cache, c.watch.app);
        if (others.length) {
          const after = await cacheState(c.cache, c.env);
          for (const o of others) record(before, after, o);
        }
        if (failed.length) throw new Error(`The app could not restore the refs of ${basename(c.cache)}: ${failed.join(" ")}`);
      });
  } finally {
    stopGit(s);
  }
  // HEAD is at the step start, or where an app git call moved the branch that HEAD names.
  for (const h of s.heads) {
    const ref = /^ref: (\S+)/.exec(read(join(h.wt.admin, "HEAD"))?.toString() ?? "")?.[1];
    const want = (ref && wants.get(h.wt.cache)?.get(`ref ${ref}`)) || h.head;
    const now = await headOf(h.wt);
    if (now !== want)
      throw new Error(`HEAD of ${rel(h.wt, h.wt.repo)} is at ${now.slice(0, 12)}, not at ${want.slice(0, 12)} as the app left it.`);
  }
  return moved;
}

// spec.md section 6.8: what a step changed in the git state, as a clause with at most three items. The update of a resolve step puts it
// into its own sentence.
export function movedReason(moved: readonly string[]) {
  const more = moved.length > 3 ? ` and ${moved.length - 3} more` : "";
  return `Claude changed git state during the step: ${moved.slice(0, 3).join(", ")}${more}. The app restored it`;
}

// spec.md section 6.8: the reason of a task whose step changed the git state.
export const movedText = (moved: readonly string[]) => `Needs you: ${movedReason(moved)}.`;
