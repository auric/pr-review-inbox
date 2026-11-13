// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/git-deny.md fix F (spec.md section 6.8): the git state of a part around one Claude step. A Bash command can run
// git through `bash -c` (Gate B34), so the app saves the state before the step and puts it back after the step. The files go back before
// any other git call of the app reads them.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import { CACHE_FILES, cacheState, exclusive, gitRaw, otherWatches, record, watchCache, worktreeNames } from "../review/git";
import { gitSync, headOf, SEQUENCER, type Worktree, wtGit, wtGitSync } from "./worktree";

// The files of the git folder of a worktree that git reads, besides the index and SEQUENCER.
const ADMIN_FILES = ["HEAD", "commondir", "gitdir", "config.worktree", "info/sparse-checkout"];

// quiet: the file goes back, but a change of it is no item. git status of a step rewrites the index, and a restore removes what a step
// staged past the commit of the app. tree: a file or a folder (SEQUENCER), with bytes from readTree.
type FileSnap = { path: string; label: string; bytes: Buffer | null; quiet?: boolean; tree?: boolean };
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

// A file or a folder as one value: the path under it, the kind, and the bytes of each entry, in name order. A link is an entry of kind
// "other", and the read does not follow it. null: nothing at path.
function readTree(path: string): Buffer | null {
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  const out: [string, string, string][] = [];
  const walk = (sub: string) => {
    const p = sub ? join(path, ...sub.split("/")) : path;
    const st = lstatSync(p);
    if (st.isDirectory()) {
      out.push([sub, "dir", ""]);
      for (const n of readdirSync(p).sort()) walk(sub ? `${sub}/${n}` : n);
    } else out.push([sub, st.isFile() ? "file" : "other", st.isFile() ? readFileSync(p).toString("base64") : ""]);
  };
  walk("");
  return Buffer.from(JSON.stringify(out));
}

function putTree(path: string, bytes: Buffer | null) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  if (bytes === null) return;
  for (const [sub, kind, b64] of JSON.parse(bytes.toString()) as [string, string, string][]) {
    const p = sub ? join(path, ...sub.split("/")) : path;
    if (kind === "dir") mkdirSync(p, { recursive: true });
    else if (kind === "file") put(p, Buffer.from(b64, "base64"));
  }
}

const readOf = (f: Omit<FileSnap, "bytes">) => (f.tree ? readTree(f.path) : read(f.path));
const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));
const rel = (wt: Worktree, p: string) => relative(wt.dir, p).replaceAll("\\", "/");

// The entries of <cache>/worktrees that differ from the "worktree <name>" keys of want.
function entryChanges(cache: string, want: Iterable<string>) {
  const was = new Set([...want].filter((k) => k.startsWith("worktree ")).map((k) => k.slice("worktree ".length)));
  const now = new Set(worktreeNames(cache));
  return { now, added: [...now].filter((n) => !was.has(n)), gone: [...was].filter((n) => !now.has(n)) };
}
const entryLabel = (cache: string, n: string, added: boolean) => `${basename(cache)}/worktrees/${n} (${added ? "new" : "deleted"})`;

export const stopGit = (s: Pick<GitSnap, "caches">) => {
  for (const c of s.caches) c.watch.stop();
};

// The files of the snapshot: the empty global config of the app, then the git link and the git folder files of each worktree.
function gitFiles(wts: readonly Worktree[]): Omit<FileSnap, "bytes">[] {
  const out: Omit<FileSnap, "bytes">[] = [];
  const global = wts[0]?.env.GIT_CONFIG_GLOBAL;
  if (global) out.push({ path: global, label: `git/${basename(global)}` });
  for (const wt of wts) {
    const link = join(wt.repo, ".git");
    out.push({ path: link, label: rel(wt, link) });
    const admin = `${basename(wt.cache)}/worktrees/${basename(wt.admin)}`;
    for (const f of ADMIN_FILES) out.push({ path: join(wt.admin, f), label: `${admin}/${f}` });
    for (const f of SEQUENCER) out.push({ path: join(wt.admin, f), label: `${admin}/${f}`, tree: true });
    out.push({ path: join(wt.admin, "index"), label: "index", quiet: true });
  }
  return out;
}

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
    const files: FileSnap[] = gitFiles(wts).map((f) => ({ ...f, bytes: readOf(f) }));
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
      if (same(readOf(f), f.bytes)) continue;
      if (!f.quiet) moved.push(f.label);
      (f.tree ? putTree : put)(f.path, f.bytes);
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
        // A new entry goes. The files of a gone entry are lost, so it fails the restore.
        const failed: string[] = [];
        const e = entryChanges(c.cache, want.keys());
        for (const n of e.now) before.set(`worktree ${n}`, "1");
        for (const n of e.added) {
          moved.push(entryLabel(c.cache, n, true));
          rmSync(join(c.cache, "worktrees", n), { recursive: true, force: true, maxRetries: 3 });
        }
        for (const n of e.gone) {
          moved.push(entryLabel(c.cache, n, false));
          failed.push(`The worktree entry ${n} is gone.`);
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
        if (failed.length) throw new Error(`The app could not restore the git state of ${basename(c.cache)}: ${failed.join(" ")}`);
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

// ---------- The snapshot of a run (docs/plans/review-v2/part-session.md sections 2.5 and 9.5) ----------

// The git state at the start of a run, for the check after an app restart. The check only compares: the app git calls during the run
// left no record, so a restore could undo them. It holds hashes, the refs, the worktree entries, and the HEAD commits, in the order of
// gitFiles and of the worktrees. It holds no bytes, no env, and no path. index: the index entries with their flags
// (`git ls-files -s -v`), without the stat data that a git status rewrites.
export const diskSnap = z.object({
  files: z.array(z.string().nullable()),
  caches: z.array(z.record(z.string(), z.string())),
  heads: z.array(z.string()),
  index: z.array(z.string()),
});
export type DiskSnap = z.infer<typeof diskSnap>;

const INDEX = ["ls-files", "-z", "-s", "-v"];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fileHash = (b: Buffer | null) => (b === null ? null : sha(b));
// cacheState holds the bytes of CACHE_FILES in base64.
const hashFiles = (state: ReadonlyMap<string, string>) =>
  Object.fromEntries([...state].map(([k, v]) => [k, k.startsWith("file ") ? sha(v) : v]));
const cachesOf = (wts: readonly Worktree[]) => wts.filter((wt, k) => wts.findIndex((x) => x.cache === wt.cache) === k);

export async function diskSnapOf(s: GitSnap): Promise<DiskSnap> {
  const index: string[] = [];
  for (const h of s.heads) index.push(sha(await wtGit(h.wt, INDEX)));
  return {
    files: s.files.filter((f) => !f.quiet).map((f) => fileHash(f.bytes)),
    caches: s.caches.map((c) => hashFiles(c.state)),
    heads: s.heads.map((h) => h.head),
    index,
  };
}

// What differs from d now, as labels. It blocks, for the restart recovery. The files come first with no git call, so git reads no
// planted config. Throws when git fails.
export function diskDiff(d: DiskSnap, wts: readonly Worktree[]): string[] {
  const files = gitFiles(wts).filter((f) => !f.quiet);
  const caches = cachesOf(wts);
  if (
    files.length !== d.files.length ||
    caches.length !== d.caches.length ||
    d.heads.length !== wts.length ||
    d.index.length !== wts.length
  )
    return ["the snapshot"];
  const out = files.flatMap((f, k) => (fileHash(readOf(f)) === d.files[k] ? [] : [f.label]));
  for (const [k, wt] of caches.entries()) {
    for (const f of CACHE_FILES) {
      const b = read(join(wt.cache, f));
      if ((b === null ? undefined : sha(b.toString("base64"))) !== d.caches[k]?.[`file ${f}`]) out.push(`${basename(wt.cache)}/${f}`);
    }
    const e = entryChanges(wt.cache, Object.keys(d.caches[k] ?? {}));
    out.push(...e.added.map((n) => entryLabel(wt.cache, n, true)), ...e.gone.map((n) => entryLabel(wt.cache, n, false)));
  }
  if (out.length) return out;
  for (const [k, wt] of caches.entries()) {
    const want = new Map(Object.entries(d.caches[k] ?? {}).filter(([key]) => key.startsWith("ref ")));
    const now = new Map<string, string>();
    for (const l of gitSync([`--git-dir=${wt.cache}`, "for-each-ref", "--format=%(objectname) %(refname)"], wt.env).split("\n")) {
      const at = l.indexOf(" ");
      if (at > 0) now.set(`ref ${l.slice(at + 1)}`, l.slice(0, at));
    }
    for (const key of new Set([...want.keys(), ...now.keys()])) {
      const ref = key.slice("ref ".length);
      if (want.get(key) !== now.get(key)) out.push(!want.has(key) ? `${ref} (new)` : !now.has(key) ? `${ref} (deleted)` : ref);
    }
  }
  for (const [k, wt] of wts.entries()) {
    if (wtGitSync(wt, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== d.heads[k]) out.push(`HEAD of ${rel(wt, wt.repo)}`);
    if (sha(wtGitSync(wt, INDEX)) !== d.index[k]) out.push(`the index of ${rel(wt, wt.repo)}`);
  }
  return out;
}
