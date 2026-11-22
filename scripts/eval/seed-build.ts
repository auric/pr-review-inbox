// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The mechanical seed checks, the history rewrite, and the frozen seeded set (docs/plans/review-v2/seeded-truth.md sections 5.2, 5.3,
// 6.1, and 9 WP-SG1; architecture-bugs.md section 3.4). The seed CLI (WP-SG2) calls these functions. Nothing here runs claude.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { REVIEWER_MIN_FILES, REVIEWER_MIN_LINES } from "../../src/server/review/catalog";
import { type DiffFile, parseDiff } from "../../src/server/review/diffmap";
import { gitEnv } from "../../src/server/review/git";
import { diffArgs } from "../../src/server/review/workspace";
import {
  type EvalBug,
  type EvalExtra,
  type EvalThreadComment,
  type EvalTrap,
  type LocalCaseFile,
  localCaseFile,
  type MODULE_IDS,
  mapSpot,
  SEED_KINDS,
  setFingerprint,
} from "./cases";
import { caseId, type Manifest, noThreads, seededSet } from "./local";
import { LOCAL_TOLERANCE, overlaps } from "./score";
import { fire, kindOf, loadStore, rootRefusal, type SeedFields, type SeedRecord, saveStore, twinKey } from "./seed-store";

export type SeedKind = (typeof SEED_KINDS)[number];
type Side = "new" | "old";
type Spot = { path: string; side: Side; lines: [number, number] };
type Place = { path: string; line: number };

// Checks 3 and 7, and the seeder prompt: a seed line lies within 3 lines of a line that the change adds.
const NEAR = 3;
// Check 6: the line match widens gold by T on both ends (score.ts matches), so one finding line can match two places 2T apart.
const GAP = 2 * LOCAL_TOLERANCE + 1;
// Section 4.2 and 4.1: at most 3 seeds per host, and a floor of 4 seeds per kind.
export const HOST_CAP = 3;
export const KIND_FLOOR = 4;
// Check 4: the code types and their comment-line prefixes. A bare "*" stays out: it starts a C dereference.
const C_LIKE = ["//", "/*", "*/"];
const CODE_TYPES: Record<string, string[]> = {
  ".ts": C_LIKE,
  ".tsx": C_LIKE,
  ".js": C_LIKE,
  ".jsx": C_LIKE,
  ".mjs": C_LIKE,
  ".cjs": C_LIKE,
  ".c": C_LIKE,
  ".cc": C_LIKE,
  ".cpp": C_LIKE,
  ".cxx": C_LIKE,
  ".h": C_LIKE,
  ".hpp": C_LIKE,
  ".cs": C_LIKE,
  ".py": ["#"],
};
export const CODE_EXTS = Object.keys(CODE_TYPES);
// Check 5.
const MARKER = /\b(seed|seeded|inject|injected|planted|todo|fixme|xxx|hack|intentional|deliberate|bug)\b/i;
// Check 10: one identifier, as git grep -w sees a word.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Section 6.1.
const MODULE: Partial<Record<SeedKind, (typeof MODULE_IDS)[number]>> = {
  concurrency: "concurrency",
  contract: "api",
  omission: "api",
  security: "security",
};
const CATEGORY: Partial<Record<SeedKind, string>> = {
  lifetime: "ownership",
  leak: "resource",
  concurrency: "concurrency",
  contract: "behavior",
  omission: "behavior",
  security: "security",
};
// The builder writes only these names into <seeds>/set. eval:label keeps labels/ there.
const SET_NAMES = ["cases", "bundles", "MANIFEST.json"] as const;
const KEPT_NAMES = new Set(["labels"]);
const TIMEOUT_MS = 120_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ENC = new TextEncoder();
const ascii = (b: Uint8Array) => new TextDecoder().decode(b);

// ---------- Git ----------

// A bare temp repository with the objects of one host bundle. index: the temp index file for tree edits.
export type Repo = { dir: string; env: Record<string, string>; index: string };

// git on bytes: commit objects can hold another encoding, and a blob must keep its bytes. ok: the exit codes that do not throw.
async function gitRaw(env: Record<string, string>, args: string[], stdin?: Uint8Array, ok = [0]) {
  const p = Bun.spawn(["git", ...args], {
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin as Uint8Array<ArrayBuffer>]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (!ok.includes(code)) {
    const sub = args[0] === "--git-dir" ? args[2] : args[0];
    throw new Error(`git ${sub} failed (exit ${code}): ${err.trim().slice(-400)}`);
  }
  return { out: new Uint8Array(out), code };
}
const g = (r: Repo, args: string[], stdin?: Uint8Array, ok?: number[]) => gitRaw(r.env, ["--git-dir", r.dir, ...args], stdin, ok);
const gText = async (r: Repo, args: string[], stdin?: string) =>
  ascii((await g(r, args, stdin === undefined ? undefined : ENC.encode(stdin))).out).trim();

// A new bare repository in tmp with every ref of the bundle. Section 5.3: an isolated config, so no user filter or hook runs.
export async function bundleClone(bundle: string, tmp: string, name: string): Promise<Repo> {
  const empty = join(tmp, "empty.gitconfig");
  if (!existsSync(empty)) writeFileSync(empty, "");
  // A seed path is untrusted seeder output, so no pathspec magic applies to it.
  const env = { ...gitEnv(empty), GIT_LITERAL_PATHSPECS: "1" };
  const dir = join(tmp, `${name}.git`);
  await gitRaw(env, ["init", "-q", "--bare", "--template=", dir]);
  await gitRaw(env, ["--git-dir", dir, "fetch", "-q", "--no-tags", "--end-of-options", bundle, "+refs/*:refs/*"]);
  return { dir, env, index: join(tmp, `${name}.index`) };
}

// The mode and blob of path at rev, or null when rev has no file there.
async function entryAt(r: Repo, rev: string, path: string): Promise<{ mode: string; sha: string } | null> {
  const out = ascii((await g(r, ["ls-tree", "-z", "--full-tree", rev, "--", path])).out);
  const m = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(out);
  return m && out.slice(out.indexOf("\t") + 1).replace(/\0$/, "") === path ? { mode: m[1] as string, sha: m[2] as string } : null;
}

const readBlob = async (r: Repo, sha: string) => (await g(r, ["cat-file", "blob", sha])).out;
const writeBlob = async (r: Repo, bytes: Uint8Array) =>
  ascii((await g(r, ["hash-object", "-w", "--no-filters", "--stdin"], bytes)).out).trim();

// The text of path at rev. null: no such file, or the file is not UTF-8.
async function textAt(r: Repo, rev: string, path: string): Promise<string | null> {
  const e = await entryAt(r, rev, path);
  if (!e) return null;
  try {
    return UTF8.decode(await readBlob(r, e.sha));
  } catch {
    return null;
  }
}

// The tree of rev with each listed path set to its blob. Keeps the other entries and the file mode.
async function treeWith(r: Repo, rev: string, blobs: { path: string; mode: string; sha: string }[]): Promise<string> {
  const env = { ...r.env, GIT_INDEX_FILE: r.index };
  const run = (args: string[], stdin?: string) =>
    gitRaw(env, ["--git-dir", r.dir, ...args], stdin === undefined ? undefined : ENC.encode(stdin));
  await run(["read-tree", rev]);
  await run(["update-index", "-z", "--index-info"], blobs.map((b) => `${b.mode} ${b.sha}\t${b.path}\0`).join(""));
  return ascii((await run(["write-tree"])).out).trim();
}

const diffOf = async (r: Repo, from: string, to: string): Promise<DiffFile[]> =>
  parseDiff(new TextDecoder().decode((await g(r, ["diff", ...diffArgs, from, to])).out));

// The new-side lines that a diff adds in path.
const addedIn = (files: DiffFile[], path: string) =>
  (files.find((f) => f.path === path)?.rows ?? []).filter((x) => x.kind === "add").map((x) => x.new);
const nearAny = (lines: number[], l: number) => lines.some((a) => Math.abs(a - l) <= NEAR);

// Checks 3 and 4 need a file of a known code type that the change adds lines to. A host without one cannot take a seed.
export const hasCodeChange = async (h: Pick<Host, "repo" | "base" | "head">) =>
  (await diffOf(h.repo, h.base, h.head)).some(
    (f) => f.path !== null && CODE_TYPES[extname(f.path).toLowerCase()] && f.rows.some((x) => x.kind === "add"),
  );

// ---------- History rewrite (section 5.3) ----------

// The commits of base..head, oldest first, with their parents. merge: a commit in the range has more than one parent.
export async function rangeOf(r: Repo, base: string, head: string): Promise<{ commits: string[]; merge: boolean }> {
  const out = await gText(r, ["rev-list", "--parents", "--topo-order", "--reverse", `${base}..${head}`]);
  const rows = out ? out.split("\n").map((l) => l.split(" ")) : [];
  return { commits: rows.map((x) => x[0] as string), merge: rows.some((x) => x.length > 2) };
}

// The raw commit with a new tree line and mapped parent lines. gpgsig and gpgsig-sha256 go with their continuation lines. Every other
// byte stays: author, committer, both dates, encoding, and the message.
export function editCommit(raw: Uint8Array, tree: string, parents: Map<string, string>): Uint8Array {
  const buf = Buffer.from(raw);
  const cut = buf.indexOf("\n\n");
  const head = cut < 0 ? buf : buf.subarray(0, cut);
  const out: Buffer[] = [];
  let signature = false;
  let start = 0;
  while (start <= head.length) {
    const nl = head.indexOf(0x0a, start);
    const line = head.subarray(start, nl < 0 ? head.length : nl);
    start = nl < 0 ? head.length + 1 : nl + 1;
    if (signature && line[0] === 0x20) continue;
    const sp = line.indexOf(0x20);
    const key = line.subarray(0, sp < 0 ? line.length : sp).toString("latin1");
    signature = key === "gpgsig" || key === "gpgsig-sha256";
    if (signature) continue;
    if (key === "tree") out.push(Buffer.from(`tree ${tree}`));
    else if (key === "parent") {
      const p = line.subarray(sp + 1).toString("latin1");
      out.push(Buffer.from(`parent ${parents.get(p) ?? p}`));
    } else out.push(line);
  }
  return Buffer.concat([
    Buffer.from(out.map((l) => l.toString("latin1")).join("\n"), "latin1"),
    cut < 0 ? Buffer.alloc(0) : buf.subarray(cut),
  ]);
}

// Section 5.3: the fold rules in the order that the rewrite tries them.
export const FOLD_RULES = ["lines", "near", "file"] as const;
export type FoldRule = (typeof FOLD_RULES)[number];
// One seed for the rewrite: the edit, and the file mode, seeded blob, and find lines at the head from checkSeed.
export type Fold = Pick<SeedFields, "path" | "find" | "replace"> & Pick<Checked, "mode" | "seeded" | "region">;

// The index in commits of the last commit that changed the find lines, and of the last that changed a line within NEAR of them (check
// 3). -1: no commit of the range. Plain blame without -M or -C, so a moved line counts for the commit whose patch moves it.
async function lastTouch(r: Repo, base: string, head: string, s: Fold, commits: string[]): Promise<{ lines: number; near: number }> {
  const text = (await textAt(r, head, s.path)) ?? "";
  const n = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const range = `${Math.max(1, s.region[0] - NEAR)},${Math.min(n, s.region[1] + NEAR)}`;
  const out = await gText(r, ["blame", "--line-porcelain", "-L", range, `${base}..${head}`, "--", s.path]);
  let lines = -1;
  let near = -1;
  for (const m of out.matchAll(/^([0-9a-f]{40,64}) \d+ (\d+)/gm)) {
    const k = commits.indexOf(m[1] as string);
    const l = Number(m[2]);
    near = Math.max(near, k);
    if (l >= s.region[0] && l <= s.region[1]) lines = Math.max(lines, k);
  }
  return { lines, near };
}

// Folds each seed into one commit of base..head and gives the commits after it new trees (section 5.3). Each commit from the fold on gets
// the seed applied to its own text of the path, so every other commit keeps its patch. rules, folds: the fold rule and the original fold
// commit of each seed, in input order. null: the range has a merge commit, so the host takes no seed.
export async function rewriteHistory(
  r: Repo,
  base: string,
  head: string,
  seeds: Fold[],
): Promise<{ head: string; rules: FoldRule[]; folds: string[] } | null> {
  const { commits, merge } = await rangeOf(r, base, head);
  if (merge) return null;
  const plans: { at: number; rule: FoldRule; blobs: Map<number, { mode: string; sha: string }> }[] = [];
  for (const s of seeds) {
    const file = commits.indexOf(await gText(r, ["rev-list", "-1", `${base}..${head}`, "--", s.path]));
    if (file < 0) throw new Error(`No commit of the range changes a seeded path, so the seed has no commit to go into.`);
    // From the last commit on the path, the path equals its head text, so the seeded head blob applies.
    const blobs = new Map<number, { mode: string; sha: string }>();
    for (let k = file; k < commits.length; k++) blobs.set(k, { mode: s.mode, sha: s.seeded });
    const t = await lastTouch(r, base, head, s, commits);
    // Before that commit, the seed must apply to each text of the path. The first text without one find match stops the walk.
    const low = Math.min(...[t.lines, t.near].filter((x) => x >= 0), file);
    let from = file;
    for (let k = file - 1; k >= low; k--) {
      const e = await entryAt(r, commits[k] as string, s.path);
      const text = await textAt(r, commits[k] as string, s.path);
      const applied = text === null ? null : applySeed(text, s);
      if (!e || !applied || "reason" in applied) break;
      blobs.set(k, { mode: e.mode, sha: await writeBlob(r, ENC.encode(applied.text)) });
      from = k;
    }
    const [at, rule]: [number, FoldRule] = t.lines >= from ? [t.lines, "lines"] : t.near >= from ? [t.near, "near"] : [file, "file"];
    plans.push({ at, rule, blobs });
  }
  const from = Math.min(...plans.map((p) => p.at));
  const map = new Map<string, string>();
  for (let k = from; k < commits.length; k++) {
    const c = commits[k] as string;
    const tree = await treeWith(
      r,
      c,
      seeds.flatMap((s, i) => {
        const p = plans[i] as (typeof plans)[number];
        return p.at <= k ? [{ path: s.path, ...(p.blobs.get(k) as { mode: string; sha: string }) }] : [];
      }),
    );
    const raw = (await g(r, ["cat-file", "commit", c])).out;
    const sha = ascii((await g(r, ["hash-object", "-t", "commit", "-w", "--no-filters", "--stdin"], editCommit(raw, tree, map))).out);
    map.set(c, sha.trim());
  }
  return { head: map.get(head) ?? head, rules: plans.map((p) => p.rule), folds: plans.map((p) => commits[p.at] as string) };
}

// ---------- One seed: apply and check (section 5.2) ----------

// The text after the seed, and the lines of find at the head (1-based, inclusive). find and replace are whole lines. The seeder's line
// endings become the line ending of the file (check 8).
export function applySeed(
  text: string,
  s: Pick<SeedFields, "find" | "replace">,
): { text: string; start: number; end: number } | { reason: string } {
  const lines = text.split(/(?<=\n)/);
  const bare = lines.map((l) => l.replace(/\r?\n$/, ""));
  const split = (t: string) => t.replaceAll("\r", "").replace(/\n$/, "").split("\n");
  const find = split(s.find);
  const repl = s.replace === "" ? [] : split(s.replace);
  if (find.length === repl.length && find.every((l, k) => l === repl[k])) return { reason: "replace equals find." };
  const at: number[] = [];
  for (let i = 0; i + find.length <= bare.length; i++) if (find.every((l, k) => bare[i + k] === l)) at.push(i);
  if (at.length !== 1) return { reason: `find occurs ${at.length} times as whole lines. It must occur once.` };
  const i = at[0] as number;
  const n = find.length;
  const eol = /\r\n$/.test(lines[i] ?? "") ? "\r\n" : /\n$/.test(lines[i] ?? "") ? "\n" : text.includes("\r\n") ? "\r\n" : "\n";
  const lastEol = /\n$/.test(lines[i + n - 1] ?? "");
  let before = lines.slice(0, i).join("");
  if (!repl.length && !lastEol) before = before.replace(/\r?\n$/, "");
  const middle = repl.map((l, k) => l + (k < repl.length - 1 || lastEol ? eol : "")).join("");
  return { text: before + middle + lines.slice(i + n).join(""), start: i + 1, end: i + n };
}

// The one line of text whose trimmed text equals needle, or the count of such lines.
function lineOf(text: string | null, needle: string): number | { count: number } {
  const want = needle.trim();
  if (text === null || !want || needle.includes("\n")) return { count: 0 };
  const hits = text
    .split("\n")
    .map((l, k) => (l.trim() === want ? k + 1 : 0))
    .filter(Boolean);
  return hits.length === 1 ? (hits[0] as number) : { count: hits.length };
}

const gap = (a: [number, number], b: [number, number]) => Math.max(b[0] - a[1], a[0] - b[1]);

// The places of the natural items of a host: bugs, traps, extras, your own comments, and their alt places.
export const naturalSpots = (c: LocalCaseFile): Spot[] =>
  [...c.bugs, ...c.traps, ...c.extras, ...c.human]
    .flatMap((x) => [x, ...("alt" in x && x.alt ? x.alt : [])])
    .map(({ path, side, lines }) => ({ path, side, lines }));

// A host: one review case of the natural set and the temp repository of its bundle.
export type Host = { id: string; text: string; file: LocalCaseFile; base: string; head: string; pr: number; repo: Repo };

// Opens the hosts of a natural set. One temp repository per bundle file. null: the case is missing or no valid host.
export function hostsOf(local: string, tmp: string) {
  const repos = new Map<string, Repo>();
  const hosts = new Map<string, Host | null>();
  const open = async (id: string): Promise<Host | null> => {
    const dir = join(local, "cases", id);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || !existsSync(join(dir, "case.json"))) return null;
    const text = readFileSync(join(dir, "case.json"), "utf8");
    const parsed = localCaseFile.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const file = parsed.data;
    const pr = Number(/^pr(\d+)-/.exec(file.id)?.[1] ?? Number.NaN);
    const { base, head } = file.bundle;
    // A re-review case and a case whose ID does not follow its head are no hosts (section 6.1 recomputes the ID).
    if (file.id !== id || file.rereview || caseId({ pr, head, base }) !== id) return null;
    const bundle = resolve(dir, "../../bundles", file.bundle.file);
    if (!existsSync(bundle)) return null;
    let repo = repos.get(bundle);
    if (!repo) {
      repo = await bundleClone(bundle, tmp, `host-${repos.size}`);
      repos.set(bundle, repo);
    }
    return { id, text, file, base, head, pr, repo };
  };
  return async (id: string) => {
    if (!hosts.has(id)) hosts.set(id, await open(id));
    return hosts.get(id) ?? null;
  };
}

// The binding of a new seed at its host (section 8), or null when the host has no such file.
export async function bindingOf(h: Host, path: string): Promise<SeedRecord["host"] | null> {
  const e = await entryAt(h.repo, h.head, path);
  return e && { id: h.id, base: h.base, head: h.head, blob: e.sha };
}

// Section 8: the binding of s matches its host again. false fires host- on a bound seed, true fires host+ on a stale seed.
export const bindingHolds = async (h: Host | null, s: SeedRecord) =>
  h !== null &&
  h.base === s.host.base &&
  h.head === s.host.head &&
  (await entryAt(h.repo, h.head, s.path).catch(() => null))?.sha === s.host.blob;

export type Rejection = { check: number; reason: string };
// A seed that passed the checks. mode, blob: the file at the head. seeded: the blob after the seed. region: the find lines at the head.
// anchor, alt: the lines at the seeded head.
export type Checked = {
  mode: string;
  blob: string;
  seeded: string;
  text: string;
  region: [number, number];
  anchor: Place;
  alt: Place[];
};

// Checks 1 to 8 and 10 for one seed alone at its host. Check 9 runs at the build (pickSeeds).
export async function checkSeed(h: Host, s: SeedFields): Promise<Checked | Rejection> {
  const no = (check: number, reason: string): Rejection => ({ check, reason });
  const r = h.repo;
  // 1
  const entry = await entryAt(r, h.head, s.path);
  if (!entry) return no(1, "The path does not exist at the head.");
  const text = await textAt(r, h.head, s.path);
  if (text === null) return no(1, "The file at the head is not UTF-8 text.");
  const applied = applySeed(text, s);
  if ("reason" in applied) return no(1, applied.reason);
  const seeded = await writeBlob(r, ENC.encode(applied.text));
  const tree = await treeWith(r, h.head, [{ path: s.path, mode: entry.mode, sha: seeded }]);
  const seedFiles = await diffOf(r, h.head, tree);
  const rows = (seedFiles.find((f) => f.path === s.path)?.rows ?? []).filter((x) => x.kind !== "ctx");
  const added = rows.filter((x) => x.kind === "add").map((x) => x.text);
  // 2
  const max = s.kind === "omission" ? 12 : 8;
  if (rows.length < 1 || rows.length > max) return no(2, `The seed changes ${rows.length} lines. The limit is 1 to ${max}.`);
  // 3
  const prAdds = addedIn(await diffOf(r, h.base, h.head), s.path);
  for (let l = applied.start; l <= applied.end; l++)
    if (!nearAny(prAdds, l)) return no(3, `Line ${l} of find is not within ${NEAR} lines of a line that the change adds.`);
  // 4
  const prefixes = CODE_TYPES[extname(s.path).toLowerCase()];
  if (!prefixes) return no(4, "The file is not of a known code type.");
  if (added.some((l) => prefixes.some((p) => l.trimStart().startsWith(p)))) return no(4, "The seed adds a comment line.");
  const notes = commentLines(applied.text, s.path);
  if (rows.some((x) => x.kind === "add" && notes.has(x.new))) return no(4, "The seed adds a line inside a comment or a docstring.");
  // 5
  const marker = added.map((l) => MARKER.exec(l)?.[1]).find(Boolean);
  if (marker) return no(5, `An added line holds the marker word "${marker.toLowerCase()}".`);
  // 7: the anchor and the alt places at the seeded head. Check 6 needs them.
  const textOf = async (path: string) => (path === s.path ? applied.text : await textAt(r, h.head, path));
  const resolveAt = async (p: { path: string; text: string }, what: string): Promise<Place | Rejection> => {
    const l = lineOf(await textOf(p.path), p.text);
    return typeof l === "number" ? { path: p.path, line: l } : no(7, `The ${what} text matches ${l.count} lines at the seeded head.`);
  };
  const anchor = await resolveAt(s.anchor, "anchor");
  if ("check" in anchor) return anchor;
  const alt: Place[] = [];
  for (const a of s.alt) {
    const p = await resolveAt(a, "alt");
    if ("check" in p) return p;
    alt.push(p);
  }
  if (!nearAny(addedIn(await diffOf(r, h.base, tree), anchor.path), anchor.line))
    return no(7, `The anchor line is not within ${NEAR} lines of a changed line of the seeded change.`);
  // 6: the natural new-side places. Old-side places count lines of the merge base.
  const natural = naturalSpots(h.file).filter((x) => x.side === "new");
  if (natural.some((x) => x.path === s.path && gap(x.lines, [applied.start, applied.end]) < GAP))
    return no(6, `The seed lines lie within ${GAP - 1} lines of a natural item.`);
  for (const x of natural) {
    const m = mapSpot(seedFiles, x);
    if (!m) return no(6, "The seed changes the lines of a natural item.");
    if ([anchor, ...alt].some((p) => p.path === m.path && gap(m.lines, [p.line, p.line]) < GAP))
      return no(6, `The anchor or an alt place lies within ${GAP - 1} lines of a natural item.`);
  }
  // 8: applySeed gives the added lines the line ending of the file. find lines without indent set no indent character.
  const findLines = s.find.replaceAll("\r", "").split("\n");
  const indent = new Set(findLines.flatMap((l) => [...(/^[ \t]*/.exec(l)?.[0] ?? "")]));
  if (indent.size && added.some((l) => [...(/^[ \t]*/.exec(l)?.[0] ?? "")].some((c) => !indent.has(c))))
    return no(8, "An added line uses another indent character than the find lines.");
  // 10
  if (s.kind !== "architecture") {
    if (s.route !== "") return no(10, "Only a seed of kind architecture has a route.");
  } else {
    if (!IDENT.test(s.route)) return no(10, "The route is not one identifier.");
    const word = new RegExp(`\\b${s.route}\\b`);
    if (!word.test(s.find)) return no(10, "find does not hold the route as a whole word.");
    if (word.test(s.replace)) return no(10, "replace still holds the route.");
    const out = ascii((await g(r, ["grep", "-w", "-F", "-l", "-e", s.route, h.base], undefined, [0, 1])).out);
    const files = out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(h.base.length + 1))
      .filter((p) => p !== s.path);
    if (files.length < 3)
      return no(10, `The route occurs in ${files.length} files besides the seed path at the merge base. The minimum is 3.`);
  }
  return {
    mode: entry.mode,
    blob: entry.sha,
    seeded,
    text: applied.text,
    region: [applied.start, applied.end],
    anchor,
    alt,
  };
}

// Per character of text: 1 in a comment or docstring, 2 in a string literal, 0 in code. C-like: line comments and block comments, /** */
// too. Python: line comments and triple-quoted strings. A string literal opens no comment. The holes of an interpolated string stay code:
// ${...} in a JS template, {...} in a Python f-string or a C# $-string, where {{ is a literal brace.
// shortcut: a Python f-string with triple quotes counts as a docstring, so its holes are masked; parse it if a check 11 miss shows up.
function scanNotes(text: string, path: string): Uint8Array {
  const py = extname(path).toLowerCase() === ".py";
  const cs = extname(path).toLowerCase() === ".cs";
  const note = new Uint8Array(text.length);
  const upTo = (from: number, end: string) => {
    const e = text.indexOf(end, from);
    return e < 0 ? text.length : end === "\n" ? e : e + end.length;
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i] as string;
    const three = text.slice(i, i + 3);
    const end = py
      ? c === "#"
        ? upTo(i, "\n")
        : three === '"""' || three === "'''"
          ? upTo(i + 3, three)
          : -1
      : text.startsWith("//", i)
        ? upTo(i, "\n")
        : text.startsWith("/*", i)
          ? upTo(i + 2, "*/")
          : -1;
    if (end >= 0) {
      note.fill(1, i, end);
      i = end;
    } else if (c === '"' || c === "'" || (c === "`" && !py)) {
      const prefix = text.slice(Math.max(0, i - 3), i);
      const interpolated = py ? /(^|\W)([fF][rR]?|[rR][fF])$/.test(prefix) : cs && /(^|[^\w$@])(\$@?|@\$)$/.test(prefix);
      const open = c === "`" ? "${" : interpolated ? "{" : null;
      const holes: [number, number][] = [];
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n")) {
        if (open === "{" && text.startsWith("{{", j)) j += 2;
        else if (open !== null && text.startsWith(open, j)) {
          let k = j + open.length - 1;
          for (let depth = 0; k < text.length && (c === "`" || text[k] !== "\n"); k++) {
            if (text[k] === "{") depth++;
            else if (text[k] === "}" && --depth === 0) break;
          }
          holes.push([j + open.length, k]);
          j = text[k] === "}" ? k + 1 : k;
        } else j += text[j] === "\\" ? 2 : 1;
      }
      note.fill(2, i, Math.min(j + 1, text.length));
      for (const [a, b] of holes) note.fill(0, a, b);
      i = j + 1;
    } else i++;
  }
  return note;
}

// Check 4: the 1-based lines of text whose code is all comment or docstring. A line with a string literal is code.
export function commentLines(text: string, path: string): Set<number> {
  const note = scanNotes(text, path);
  const out = new Set<number>();
  let at = 0;
  for (const [k, line] of text.split("\n").entries()) {
    let code = false;
    for (let j = 0; j < line.length && !code; j++) code = note[at + j] !== 1 && !/\s/.test(line[j] as string);
    if (line.trim() && !code) out.add(k + 1);
    at += line.length + 1;
  }
  return out;
}

// ---------- Checks 11 and 12: unused names and giveaway tokens (section 5.2) ----------

const WORD = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const STRING = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;

// The words of code lines without string literals and comments.
function wordsOf(text: string, prefixes: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(STRING, '""');
    const cut = Math.min(line.length, ...prefixes.map((p) => line.indexOf(p)).filter((i) => i >= 0));
    for (const m of line.slice(0, cut).matchAll(WORD)) out.add(m[0]);
  }
  return out;
}

// Line k is in an import statement: it starts one, or it is a name list line under an import line that opens a list.
function inImport(lines: string[], k: number): boolean {
  for (let i = k; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (/^(import|from|using)\b/.test(t)) return i === k || /[{(]$/.test(t);
    if (!/^[\w$\s,*]+$/.test(t)) return false;
  }
  return false;
}

// Check 11: the names that the edit leaves at one place of the file, where that place is no member access (".", "->", "::"), and the place
// is in an import statement or no other file at the head has the name. A removed name at one place lost its use. An added name at one place
// has no use or no declaration. A name at 0 places left the file with its uses, so it does not count. A word in a string or a comment
// is no place.
export async function unusedNames(
  h: Pick<Host, "repo" | "head">,
  s: Pick<SeedFields, "path" | "find" | "replace">,
  c: Pick<Checked, "text">,
): Promise<string[]> {
  const prefixes = CODE_TYPES[extname(s.path).toLowerCase()] ?? [];
  const before = wordsOf(s.find, prefixes);
  const after = wordsOf(s.replace, prefixes);
  const lines = c.text.split("\n");
  const note = scanNotes(c.text, s.path);
  const out: string[] = [];
  for (const n of [...new Set([...before, ...after])].sort()) {
    if (before.has(n) && after.has(n)) continue;
    const hits = [...c.text.matchAll(new RegExp(`\\b${n}\\b`, "g"))].filter((m) => !note[m.index]);
    if (hits.length !== 1) continue;
    const at = (hits[0] as RegExpExecArray).index;
    const lead = c.text.slice(Math.max(0, at - 2), at);
    if (lead.endsWith(".") || lead === "->" || lead === "::") continue;
    if (!inImport(lines, c.text.slice(0, at).split("\n").length - 1)) {
      const files = ascii((await g(h.repo, ["grep", "-w", "-F", "-l", "-e", n, h.head], undefined, [0, 1])).out)
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(h.head.length + 1));
      if (files.some((p) => p !== s.path)) continue;
    }
    out.push(n);
  }
  return out;
}

// Check 12 tokens of a text: string bodies of 3 or more characters, numbers of 2 or more characters, and code-like words (an upper-case
// letter after the first, a digit, or an underscore). A plain word also matches English text, so it does not count.
function tokensOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    if (body.trim().length >= 3) out.add(body);
  }
  const code = text.replace(STRING, '""');
  for (const m of code.matchAll(/\b\d[\w.]*\b/g)) if (m[0].length >= 2) out.add(m[0]);
  for (const m of code.matchAll(WORD)) if (/[A-Z0-9_]/.test(m[0].slice(1))) out.add(m[0]);
  return out;
}

// Check 12, a report only: where a token that the edit removes stands as written. "description": the PR description of the host case.
// A commit subject or a design doc is no giveaway (the middle rule, seeded-truth.md section 14 row 24).
export function giveaways(h: Pick<Host, "file">, s: Pick<SeedFields, "find" | "replace">): string[] {
  const kept = tokensOf(s.replace);
  const removed = [...tokensOf(s.find)].filter((t) => !kept.has(t));
  const holds = (text: string) => removed.some((t) => new RegExp(`(?<!\\w)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`).test(text));
  return holds(h.file.pr.description) ? ["description"] : [];
}

// ---------- The seeded case (section 6.1) ----------

export type PlacedSeed = { seed: SeedRecord; anchor: Place; alt: Place[] };

// The case.json of a seeded host. diff: diff(H, H'). Every new-side place of the host moves with mapSpot. A natural item that maps to null
// stops the build. A thread whose place maps to null, or lies on a seed place, goes.
export function seededCase(
  host: LocalCaseFile,
  o: {
    head: string;
    pr: number;
    bundle: string;
    diff: DiffFile[];
    changedLines: number;
    large: boolean;
    seeds: PlacedSeed[];
  },
): { file: LocalCaseFile; dropped: number } {
  const move = <T extends Spot>(s: T): T => {
    if (s.side === "old") return s;
    const m = mapSpot(o.diff, s);
    if (!m) throw new Error(`Case ${host.id}: a natural item lies on the lines of a seed.`);
    return { ...s, path: m.path, lines: m.lines };
  };
  const one = (p: Place): Spot => ({ path: p.path, side: "new", lines: [p.line, p.line] });
  const bugs: EvalBug[] = o.seeds.map(({ seed, anchor, alt }, k) => {
    const kind = kindOf(seed);
    return {
      id: `S${k + 1}`,
      ...one(anchor),
      ...(alt.length > 0 && { alt: alt.map(one) }),
      severityMin: "major",
      module: MODULE[kind] ?? "core",
      note: `Seeded ${kind} defect.`,
      text: seed.comment,
      ...(CATEGORY[kind] && { category: CATEGORY[kind] }),
      source: "seeded",
      seedKind: kind,
    };
  });
  const extra = (x: { note: string; text?: string; category?: string; source?: EvalExtra["source"] }, s: Spot): EvalExtra => ({
    ...move(s),
    note: x.note,
    ...(x.text !== undefined && { text: x.text }),
    ...(x.category !== undefined && { category: x.category }),
    ...(x.source !== undefined && { source: x.source }),
  });
  const extras: EvalExtra[] = [
    ...host.extras.map((x) => extra(x, x)),
    ...host.bugs.flatMap((b) => [b, ...(b.alt ?? [])].map((p) => extra(b, p))),
    ...host.human.map((x) => extra(x, x)),
  ];
  const traps: EvalTrap[] = host.traps.map((t) => ({ ...t, ...move(t), ...(t.alt && { alt: t.alt.map(move) }) }));
  const marks = o.seeds.flatMap((x) => [x.anchor, ...x.alt].map(one));
  const onSeed = (s: Spot) => marks.some((m) => m.path === s.path && m.side === s.side && overlaps(m.lines, s.lines));
  const gone = new Set<number>();
  const placed = new Map<number, Partial<EvalThreadComment>>();
  for (const c of host.threads ?? []) {
    if (c.id !== c.root) continue;
    const at: Partial<EvalThreadComment> = {};
    if (c.path && c.side === "new" && c.lines) {
      const m = mapSpot(o.diff, { path: c.path, lines: c.lines });
      if (!m || onSeed({ path: m.path, side: "new", lines: m.lines })) gone.add(c.id);
      else Object.assign(at, { path: m.path, lines: m.lines });
    }
    if (c.newPlace) {
      const m = mapSpot(o.diff, c.newPlace);
      if (!m || onSeed({ ...m, side: "new" })) gone.add(c.id);
      else at.newPlace = m;
    }
    placed.set(c.id, at);
  }
  const threads = (host.threads ?? []).filter((c) => !gone.has(c.root)).map((c) => ({ ...c, ...placed.get(c.id) }));
  const { clean: _, threads: __, ...rest } = host;
  const file = localCaseFile.parse({
    ...rest,
    id: caseId({ pr: o.pr, head: o.head, base: host.bundle.base }),
    bugs,
    traps,
    extras,
    human: [],
    bundle: { file: o.bundle, base: host.bundle.base, head: o.head },
    changedLines: o.changedLines,
    large: o.large,
    ...(threads.length > 0 && { threads }),
  });
  return { file, dropped: gone.size };
}

// ---------- The build ----------

// Section 4.2: hosts in ID order. Per host, the kind with the lowest count so far first, then the seeder order. At most HOST_CAP seeds per
// host and one per file (check 9). The rest are spares. The kind is the build kind (kindOf).
export function pickSeeds(byHost: Map<string, SeedRecord[]>): { picked: Map<string, SeedRecord[]>; spares: number } {
  const count = new Map<SeedKind, number>();
  const picked = new Map<string, SeedRecord[]>();
  let spares = 0;
  for (const id of [...byHost.keys()].sort()) {
    const all = byHost.get(id) ?? [];
    const got: SeedRecord[] = [];
    while (got.length < HOST_CAP) {
      const open = all.filter((s) => !got.includes(s) && !got.some((x) => x.path === s.path));
      if (!open.length) break;
      const low = Math.min(...open.map((s) => count.get(kindOf(s)) ?? 0));
      const s = open.find((x) => (count.get(kindOf(x)) ?? 0) === low) as SeedRecord;
      got.push(s);
      count.set(kindOf(s), (count.get(kindOf(s)) ?? 0) + 1);
    }
    spares += all.length - got.length;
    if (got.length) picked.set(id, got);
  }
  return { picked, spares };
}

export type SeededInfo = {
  seeds: number;
  byKind: Record<SeedKind, number>;
  hosts: number;
  spares: number;
  mergeHosts: number;
  hostFingerprint: string;
  seedsHash: string;
  // The fold rule of each seed by seed ID (section 5.3).
  folds: Record<string, FoldRule>;
};
export type SeededManifest = Manifest & { seeded: SeededInfo };
// stale, restored: the seeds that the binding pass made stale or brought back. issues: the natural must-finds plus the seeds per case,
// in case ID order. pilot: the two cases for the pilot run. kept: the kept seeds per kind, spares included (the floor of section 4.1).
export type SeedBuild = {
  manifest: SeededManifest;
  stale: number;
  restored: number;
  issues: number[];
  pilot: string[];
  kept: Record<SeedKind, number>;
};

const BOUND = new Set(["applied", "confirmed", "sampled", "kept"]);

// graceful-fs (polyfills.js) does the same: on Windows, antivirus software can lock a folder with new files, so a rename fails with
// EACCES or EPERM for a while. It retries for up to 60 s.
async function renameRetry(from: string, to: string) {
  const end = Date.now() + 60_000;
  for (let wait = 0; ; wait = Math.min(wait + 10, 100)) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!(code === "EPERM" || code === "EACCES" || code === "EBUSY") || Date.now() > end) throw e;
      await Bun.sleep(wait);
    }
  }
}

// Builds <seeds>/set from the kept seeds and the natural set in local (sections 5.3, 6.1, 8). The binding pass saves the store first:
// host- for a bound seed whose host changed, host+ for a stale seed whose host is back. Then the build reads kept seeds and writes no
// state. The new set replaces cases/, bundles/, and MANIFEST.json only when every host succeeded. labels/ stays.
export async function buildSeededSet(o: { seeds: string; local: string }): Promise<SeedBuild | { refused: string }> {
  const root = resolve(o.seeds);
  const refused = await rootRefusal(root);
  if (refused) return { refused };
  if (!existsSync(join(o.local, "cases"))) return { refused: "No natural set. Build it with eval:local first." };
  if (seededSet(o.local)) return { refused: "The natural set folder holds a seeded set. Point REVIEW_LOOP_EVAL_LOCAL at the natural set." };
  const set = join(root, "set");
  if (existsSync(set) && readdirSync(set).some((f) => !(SET_NAMES as readonly string[]).includes(f) && !KEPT_NAMES.has(f)))
    return { refused: "Refused: the set folder holds other files. Remove them first." };

  const tmp = mkdtempSync(join(tmpdir(), "rl-seed-build-"));
  const work = join(root, `.build-${process.pid}`);
  try {
    const hostOf = hostsOf(o.local, tmp);
    // The binding pass (section 8): validate and build fire host-, build fires host+.
    const store = loadStore(root);
    let stale = 0;
    let restored = 0;
    const seeds: SeedRecord[] = [];
    for (const s of store.seeds) {
      const bound = s.state === "stale" || BOUND.has(s.state) ? await bindingHolds(await hostOf(s.host.id), s) : null;
      const next = bound === false && s.state !== "stale" ? fire(s, "host-") : bound === true && s.state === "stale" ? fire(s, "host+") : s;
      if ("refused" in next) throw new Error(next.refused);
      if (next !== s) next.state === "stale" ? stale++ : restored++;
      seeds.push(next);
    }
    if (stale || restored) saveStore(root, { ...store, seeds });

    const keptAll = seeds.filter((s) => s.state === "kept");
    const keptByKind = Object.fromEntries(SEED_KINDS.map((k) => [k, keptAll.filter((s) => kindOf(s) === k).length])) as Record<
      SeedKind,
      number
    >;
    // Twin hosts give one case, on the twin with the lowest case ID. A seed of another twin must pass the checks there. Check 6 reads
    // the case of the host, so a seed can fail there. It is then a spare.
    const kept = new Map<string, SeedRecord[]>();
    let twinSpares = 0;
    for (const list of Map.groupBy(keptAll, twinKey).values()) {
      const id = list.map((s) => s.host.id).sort()[0] as string;
      const h = (await hostOf(id)) as Host;
      const fit: SeedRecord[] = [];
      for (const s of list)
        if (s.host.id !== id && "check" in (await checkSeed(h, s))) twinSpares++;
        else fit.push(s);
      kept.set(id, fit);
    }
    let mergeHosts = 0;
    let mergeSeeds = 0;
    for (const [id, list] of [...kept]) {
      const h = (await hostOf(id)) as Host;
      if ((await rangeOf(h.repo, h.base, h.head)).merge) {
        mergeHosts++;
        mergeSeeds += list.length;
        kept.delete(id);
      }
    }
    const { picked, spares } = pickSeeds(kept);

    mkdirSync(join(work, "cases"), { recursive: true });
    mkdirSync(join(work, "bundles"), { recursive: true });
    const written: { id: string; hash: string }[] = [];
    const hostsUsed: { id: string; hash: string }[] = [];
    const used: SeedRecord[] = [];
    const issues: { id: string; n: number; lines: number }[] = [];
    const folds: Record<string, FoldRule> = {};
    const tally = noThreads();
    let traps = 0;
    let extras = 0;
    for (const [id, list] of picked) {
      const h = (await hostOf(id)) as Host;
      const checked: Checked[] = [];
      for (const s of list) {
        const c = await checkSeed(h, s);
        if ("check" in c) throw new Error(`Seed ${s.id} fails check ${c.check}: ${c.reason} Drop or retire it, then build again.`);
        checked.push(c);
      }
      const rewrite = await rewriteHistory(
        h.repo,
        h.base,
        h.head,
        list.map((s, k) => ({ ...s, ...(checked[k] as Checked) })),
      );
      if (rewrite === null) throw new Error(`Host ${id} has a merge commit in its range.`);
      const { head } = rewrite;
      for (const [k, s] of list.entries()) folds[s.id] = rewrite.rules[k] as FoldRule;
      // The places at H' with every seed of the host.
      const texts = new Map(list.map((s, k) => [s.path, (checked[k] as Checked).text]));
      const at = async (p: { path: string; text: string }, seed: string): Promise<Place> => {
        const l = lineOf(texts.get(p.path) ?? (await textAt(h.repo, h.head, p.path)), p.text);
        if (typeof l !== "number") throw new Error(`Seed ${seed}: a place text matches ${l.count} lines at the seeded head.`);
        return { path: p.path, line: l };
      };
      const placed: PlacedSeed[] = [];
      for (const s of list) {
        const alt: Place[] = [];
        for (const a of s.alt) alt.push(await at(a, s.id));
        placed.push({ seed: s, anchor: await at(s.anchor, s.id), alt });
      }
      const files = await diffOf(h.repo, h.base, head);
      const changedLines = files.reduce((n, f) => n + f.rows.filter((x) => x.kind !== "ctx").length, 0);
      const bundle = `${createHash("sha256").update(`seeded ${head}`).digest("hex").slice(0, 16)}.bundle`;
      const { file, dropped } = seededCase(h.file, {
        head,
        pr: h.pr,
        bundle,
        diff: await diffOf(h.repo, h.head, head),
        changedLines,
        large: changedLines >= REVIEWER_MIN_LINES || files.length >= REVIEWER_MIN_FILES,
        seeds: placed,
      });
      // Section 5.3: the bundle holds only the merge base and H', so the original head never reaches a run.
      for (const c of [h.base, head]) await g(h.repo, ["update-ref", `refs/eval/${c}`, c]);
      await g(h.repo, ["bundle", "create", "-q", join(work, "bundles", bundle), `refs/eval/${h.base}`, `refs/eval/${head}`]);
      const text = `${JSON.stringify(file, null, 2)}\n`;
      mkdirSync(join(work, "cases", file.id));
      writeFileSync(join(work, "cases", file.id, "case.json"), text);
      written.push({ id: file.id, hash: createHash("sha256").update(text).digest("hex") });
      hostsUsed.push({ id, hash: createHash("sha256").update(h.text).digest("hex") });
      used.push(...list);
      issues.push({ id: file.id, n: h.file.bugs.length + h.file.human.length + list.length, lines: changedLines });
      traps += file.traps.length;
      extras += file.extras.length;
      const t = file.threads ?? [];
      if (t.length) tally.cases++;
      tally.threads += t.filter((c) => c.id === c.root).length;
      tally.comments += t.length;
      tally.overlap += dropped;
    }

    const byKind = Object.fromEntries(SEED_KINDS.map((k) => [k, used.filter((s) => kindOf(s) === k).length])) as Record<SeedKind, number>;
    const sorted = [...used].sort((a, b) => (a.id < b.id ? -1 : 1));
    const manifest: SeededManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      fingerprint: setFingerprint(written),
      counts: { cases: written.length, runs: 0, repositories: written.length, bugs: used.length, traps, extras, human: 0 },
      skipped: {
        refuted: 0,
        notYours: 0,
        undecided: 0,
        noAnchor: 0,
        conflicts: 0,
        noMergeBase: 0,
        missingCommits: 0,
        emptyCases: 0,
        commentNoLine: 0,
        commentOtherHead: 0,
        otherOpen: 0,
        otherNoLine: 0,
        otherOtherHead: 0,
        otherAuthor: 0,
        otherOverlap: 0,
      },
      sources: { posted: 0, fixed: 0, session: 0, withdrawn: 0, other: 0 },
      categories: { byClass: {}, byCategory: {}, byModule: {} },
      carried: { carried: 0, changed: 0, gone: 0, overlap: 0 },
      threads: tally,
      clean: { asked: 0, candidates: 0, cases: 0 },
      rereview: {
        fingerprint: setFingerprint([]),
        counts: { cases: 0, bugs: 0, traps: 0, extras: 0, earlier: 0 },
        skipped: { noEarlier: 0, noFindings: 0, badPayload: 0, missingCommits: 0, emptyCases: 0 },
      },
      invalid: { cases: 0, first: null },
      seeded: {
        seeds: used.length,
        byKind,
        hosts: written.length,
        spares: spares + mergeSeeds + twinSpares,
        mergeHosts,
        hostFingerprint: setFingerprint(hostsUsed),
        seedsHash: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"),
        folds: Object.fromEntries(sorted.map((s) => [s.id, folds[s.id] as FoldRule])),
      },
    };
    writeFileSync(join(work, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    // The swap. MANIFEST.json goes out first and comes in last, so a cut swap leaves no folder that eval:ab --seeded takes. The old
    // entries move into work/old, which the finally block removes: a rename frees the name at once, and a delete on Windows can be pending.
    mkdirSync(set, { recursive: true });
    mkdirSync(join(work, "old"));
    for (const f of [...SET_NAMES].reverse()) if (existsSync(join(set, f))) await renameRetry(join(set, f), join(work, "old", f));
    for (const f of SET_NAMES) await renameRetry(join(work, f), join(set, f));
    issues.sort((a, b) => (a.id < b.id ? -1 : 1));
    // The pilot (section 9 SG-P): the two cases with the fewest changed lines, the cheapest runs. Ties go by case ID.
    const pilot = [...issues]
      .sort((a, b) => a.lines - b.lines || (a.id < b.id ? -1 : 1))
      .slice(0, 2)
      .map((x) => x.id);
    return { manifest, stale, restored, issues: issues.map((x) => x.n), pilot, kept: keptByKind };
  } finally {
    // A cleanup error must not fail a build whose swap is done. A left work folder holds only copies.
    for (const d of [work, tmp])
      try {
        rmSync(d, { recursive: true, force: true, maxRetries: 10 });
      } catch {}
  }
}

// Counts only: no path, name, or code (section 9). Case IDs are opaque.
export function buildText(b: SeedBuild): string {
  const s = b.manifest.seeded;
  const lines = [
    `Seeded set: ${b.manifest.counts.cases} cases with ${s.seeds} seeds. Spare kept seeds: ${s.spares}. Hosts with a merge commit, left out: ${s.mergeHosts}.`,
    `Seeds by kind: ${SEED_KINDS.map((k) => `${k} ${s.byKind[k]}`).join(", ")}.`,
    `Issues per case (natural must-finds plus seeds): ${b.issues.join(", ") || "none"}.`,
    `Bindings: ${b.stale} seeds went stale, and ${b.restored} came back.`,
    `Folds: ${FOLD_RULES.map((r) => `${r} ${Object.values(s.folds).filter((x) => x === r).length}`).join(", ")}.`,
  ];
  lines.push(`Kept seeds by kind: ${SEED_KINDS.map((k) => `${k} ${b.kept[k]}`).join(", ")}.`);
  const low = SEED_KINDS.filter((k) => k !== "architecture" && b.kept[k] < KIND_FLOOR);
  if (low.length) lines.push(`Kinds under the floor of ${KIND_FLOOR} kept seeds: ${low.join(", ")}.`);
  // architecture-bugs.md section 3.2: this kind alone may stay under the floor.
  if (b.kept.architecture < KIND_FLOOR) lines.push("kind architecture: under floor");
  lines.push(`Fingerprint: ${b.manifest.fingerprint.slice(0, 12)}. MANIFEST.json holds these counts.`);
  lines.push(`Pilot cases: ${b.pilot.join(", ") || "none"}.`);
  return lines.join("\n");
}
