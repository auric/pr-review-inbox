// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A synthetic natural set for the seed tests (docs/plans/review-v2/seeded-truth.md WP-SG1): one repository with a linear PR (a signed
// commit and a commit with an encoding header in its range), a PR with a merge commit, their two host cases, and one bundle.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LocalCaseFile, localCaseFile } from "../../scripts/eval/cases";
import { caseId } from "../../scripts/eval/local";
import type { SeedFields, SeedRecord } from "../../scripts/eval/seed-store";
import { gitEnv } from "../../src/server/review/git";

const TIMEOUT_MS = 60_000;

// git with its bytes. dir null: no repository, as for init.
export async function gitIn(env: Record<string, string>, dir: string | null, args: string[], stdin?: string | Uint8Array) {
  const p = Bun.spawn(["git", ...(dir === null ? [] : ["--git-dir", dir]), ...args], {
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin as string | Uint8Array<ArrayBuffer>]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`git ${args[0]} failed (exit ${code}): ${err}`);
  return Buffer.from(out);
}

export const PATHS = { feature: "src/feature.ts", other: "src/other.ts", route: "src/route.ts" } as const;
export const PR_TITLE = "Add apply to the store";
const lines = (n: number, f: (k: number) => string, eol = "\n") => Array.from({ length: n }, (_, k) => f(k + 1) + eol).join("");

const FEATURE_BLOCK: Record<number, string> = {
  20: "export function apply(store: Map<string, number>, key: string, value: number) {",
  21: "  const k = key;",
  22: "  saveRecord(store, k, value);",
  23: "  return rareHelper(store.size);",
  24: "}",
  25: "export const f25 = 25 + 1;",
  26: "export const f26 = 26 + 1;",
};
const feature = (changed: number[]) =>
  lines(60, (k) => (changed.includes(k) ? (FEATURE_BLOCK[k] ?? `export const f${k} = ${k} + 1;`) : `export const f${k} = ${k};`));
const other = (changed: number[]) => lines(40, (k) => `export const o${k} = ${k}${changed.includes(k) ? " + 1" : ""};`);
const use = (n: number) =>
  `import { saveRecord } from "./route";\nexport const u${n} = (m: Map<string, number>) => saveRecord(m, " u${n} ", ${n});\n`;

const BASE_FILES: Record<string, string> = {
  [PATHS.route]:
    'export function saveRecord(store: Map<string, number>, key: string, value: number) {\n  if (value < 0) throw new Error("negative value");\n  store.set(key.trim(), value);\n}\n',
  "src/use1.ts": use(1),
  "src/use2.ts": use(2),
  "src/use3.ts": use(3),
  "src/rare.ts": "export function rareHelper(n: number) {\n  return n;\n}\n",
  "src/rare1.ts": 'import { rareHelper } from "./rare";\nexport const r1 = rareHelper(1);\n',
  [PATHS.feature]: feature([]),
  [PATHS.other]: other([]),
  "src/crlf.ts": lines(30, (k) => `export const c${k} = ${k};`, "\r\n"),
  "src/block.ts": "export function run(list: number[]) {\n  let total = 0;\n  return total;\n}\n",
  "src/util.ts": "export const u = 1;\n",
  "docs/notes.md": "# Notes\n\nThe store keeps values.\n",
};

const PERSON = "Eval Author <eval@example.invalid>";
// A signed commit and a commit in ISO-8859-1. The rewrite must keep their bytes except tree, parent, and gpgsig.
const signedCommit = (tree: string, parent: string) =>
  Buffer.from(
    `tree ${tree}\nparent ${parent}\nauthor ${PERSON} 1767225600 +0000\ncommitter ${PERSON} 1767225660 +0200\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n wsBcBAABCAAQBQJnAAAAAAkQAAAAAAAAAAA=\n =AbCd\n -----END PGP SIGNATURE-----\n\nRaise f45\n\nThe value grows by one.\n`,
    "latin1",
  );
const latin1Commit = (tree: string, parent: string) =>
  Buffer.from(
    `tree ${tree}\nparent ${parent}\nauthor René Café <rene@example.invalid> 1767229200 +0100\ncommitter ${PERSON} 1767229260 -0500\nencoding ISO-8859-1\n\nRaise o30 and o31 for the café\n`,
    "latin1",
  );

// dir: the natural set. repo: the bare source repository beside it. env: an isolated git env with a fixed identity.
export type NaturalSet = {
  dir: string;
  repo: string;
  env: Record<string, string>;
  base: string;
  commits: string[];
  head: string;
  mergeHead: string;
  host: string;
  mergeHost: string;
  bundle: string;
};

// The natural set in root/natural: cases/<id>/case.json, bundles/<16 hex>.bundle, and MANIFEST.json. root must be empty.
export async function makeNaturalSet(root: string): Promise<NaturalSet> {
  const dir = join(root, "natural");
  mkdirSync(dir, { recursive: true });
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "Eval Author",
    GIT_AUTHOR_EMAIL: "eval@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Eval Author",
    GIT_COMMITTER_EMAIL: "eval@example.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const repo = join(root, "src.git");
  await gitIn(env, null, ["init", "-q", "--bare", "--template=", repo]);
  const ix = { ...env, GIT_INDEX_FILE: join(root, "src.index") };
  const run = async (args: string[], stdin?: string | Uint8Array, e = env) => (await gitIn(e, repo, args, stdin)).toString("utf8").trim();
  // A commit of parent plus files. raw: a hand-written commit object.
  const commit = async (
    parents: string[],
    files: Record<string, string>,
    msg: string,
    raw?: (tree: string, parent: string) => Uint8Array,
  ) => {
    if (parents[0]) await run(["read-tree", parents[0]], undefined, ix);
    else await run(["read-tree", "--empty"], undefined, ix);
    for (const [path, text] of Object.entries(files)) {
      const sha = await run(["hash-object", "-w", "--no-filters", "--stdin"], text);
      await run(["update-index", "--add", "--cacheinfo", `100644,${sha},${path}`], undefined, ix);
    }
    const tree = await run(["write-tree"], undefined, ix);
    if (raw) return run(["hash-object", "-t", "commit", "-w", "--stdin"], raw(tree, parents[0] as string));
    return run(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", msg]);
  };
  const base = await commit([], BASE_FILES, "base");
  const c1 = await commit(
    [base],
    {
      [PATHS.feature]: feature([20, 21, 22, 23, 24, 25, 26]),
      [PATHS.other]: other([10, 11, 12]),
      "src/crlf.ts": lines(30, (k) => `export const c${k} = ${k}${k >= 10 && k <= 12 ? " + 1" : ""};`, "\r\n"),
      "src/block.ts": "export function run(list: number[]) {\n  let total = 0;\n  for (const x of list) total += x;\n  return total;\n}\n",
      "docs/notes.md": "# Notes\n\nThe store keeps values and sizes.\n",
    },
    "Add apply",
  );
  const c2 = await commit([c1], { [PATHS.feature]: feature([20, 21, 22, 23, 24, 25, 26, 45]) }, "", signedCommit);
  const c3 = await commit([c2], { [PATHS.other]: other([10, 11, 12, 30, 31]) }, "", latin1Commit);
  const c4 = await commit(
    [c3],
    { "src/util.ts": "export function a() {\n  return 0;\n}\nexport function b() {\n  return 0;\n}\n" },
    "Add a and b",
  );
  // The merge PR: a side commit and a main commit, then their merge.
  const m1 = await commit([base], { "src/util.ts": "export const u = 2;\n" }, "Raise u");
  const s1 = await commit([base], { [PATHS.other]: other([5]) }, "Raise o5");
  const merge = await commit([m1, s1], { "src/util.ts": "export const u = 2;\n", [PATHS.other]: other([5]) }, "Merge the side branch");

  for (const c of [base, c4, merge]) await run(["update-ref", `refs/eval/${c}`, c]);
  const bundle = `${createHash("sha256").update("PROJ/repo").digest("hex").slice(0, 16)}.bundle`;
  mkdirSync(join(dir, "bundles"), { recursive: true });
  await run(["bundle", "create", "-q", join(dir, "bundles", bundle), "--all"]);

  const host = caseId({ pr: 7, head: c4, base });
  const mergeHost = caseId({ pr: 8, head: merge, base });
  const spot = (path: string, a: number, side: "new" | "old" = "new") => ({ path, side, lines: [a, a] as [number, number] });
  const write = (c: Record<string, unknown>) => {
    const parsed: LocalCaseFile = localCaseFile.parse(c);
    mkdirSync(join(dir, "cases", parsed.id), { recursive: true });
    writeFileSync(join(dir, "cases", parsed.id, "case.json"), `${JSON.stringify(parsed, null, 2)}\n`);
  };
  const common = (id: string, head: string, group: string) => ({
    id,
    title: PR_TITLE,
    language: "unknown",
    pr: { title: PR_TITLE, description: "The change adds apply and raises some values." },
    tasks: [],
    human: [],
    bundle: { file: bundle, base, head },
    changedLines: 20,
    rules: 5,
    group,
    hasTask: false,
    large: false,
  });
  write({
    ...common(host, c4, "pr7"),
    bugs: [
      {
        id: "item-1",
        ...spot(PATHS.feature, 45),
        alt: [spot(PATHS.other, 11)],
        severityMin: "major",
        module: "core",
        note: "A natural finding.",
        text: "f45 grows twice.",
        category: "logic",
        source: "posted",
      },
    ],
    traps: [{ id: "item-2", ...spot(PATHS.feature, 52), why: "Not a defect.", text: "f52 is fine.", source: "own" }],
    extras: [{ ...spot(PATHS.other, 12), note: "A neutral note.", text: "o12 note.", source: "other" }],
    human: [{ id: "comment-9", ...spot(PATHS.other, 38), note: "Your comment.", text: "o38 looks odd.", source: "own" }],
    threads: [
      { id: 1, root: 1, author: "reviewer-1", at: 10, text: "Check the order here.", ...spot(PATHS.feature, 40) },
      { id: 2, root: 1, author: "eval-author", at: 11, text: "Fine." },
      { id: 3, root: 3, author: "reviewer-1", at: 12, text: "Why not the shared writer?", ...spot(PATHS.feature, 22) },
      { id: 4, root: 3, author: "eval-author", at: 13, text: "It is the same." },
      { id: 5, root: 5, author: "reviewer-2", at: 14, text: "A file note.", path: PATHS.other },
      { id: 6, root: 6, author: "reviewer-2", at: 15, text: "An old line.", ...spot(PATHS.feature, 3, "old") },
      {
        id: 7,
        root: 7,
        author: "reviewer-1",
        at: 16,
        text: "An unchanged line.",
        ...spot(PATHS.feature, 55, "old"),
        lineType: "CONTEXT",
        newPlace: { path: PATHS.feature, lines: [55, 55] },
      },
      { id: 8, root: 8, author: "reviewer-1", at: 17, text: "The shared writer trims.", ...spot(PATHS.route, 3) },
    ],
  });
  write({ ...common(mergeHost, merge, "pr8"), bugs: [], traps: [], extras: [] });
  writeFileSync(join(dir, "MANIFEST.json"), `${JSON.stringify({ format: 1, fingerprint: "natural" }, null, 2)}\n`);
  return { dir, repo, env, base, commits: [c1, c2, c3, c4], head: c4, mergeHead: merge, host, mergeHost, bundle };
}

// A twin host case: a case of PR group pr<pr> with the base and head of case src, and no natural items or threads. Returns its ID.
export function addTwin(set: Pick<NaturalSet, "dir">, src: string, pr: number): string {
  const file = localCaseFile.parse(JSON.parse(readFileSync(join(set.dir, "cases", src, "case.json"), "utf8")));
  const id = caseId({ pr, head: file.bundle.head, base: file.bundle.base });
  const { threads: _, ...rest } = file;
  const twin = localCaseFile.parse({ ...rest, id, group: `pr${pr}`, bugs: [], traps: [], extras: [], human: [] });
  mkdirSync(join(set.dir, "cases", id), { recursive: true });
  writeFileSync(join(set.dir, "cases", id, "case.json"), `${JSON.stringify(twin, null, 2)}\n`);
  return id;
}

// Seeds that pass every check at the host of makeNaturalSet.
const fields = (f: Partial<SeedFields> & Pick<SeedFields, "kind" | "path" | "find" | "replace" | "anchor">): SeedFields => ({
  alt: [],
  trigger: "A concrete input.",
  why: "The failure path.",
  comment: "A review comment.",
  severity: "high",
  route: "",
  ...f,
});
export const ARCH = fields({
  kind: "architecture",
  path: PATHS.feature,
  find: "  saveRecord(store, k, value);",
  replace: "  const v = value;\n  store.set(k, v);",
  anchor: { path: PATHS.feature, text: "store.set(k, v);" },
  alt: [{ path: PATHS.route, text: "store.set(key.trim(), value);" }],
  comment: "Zebra quartz one: apply writes the key without the trim of the shared writer.",
  route: "saveRecord",
});
export const OMIT = fields({
  kind: "omission",
  path: PATHS.other,
  find: "export const o31 = 31 + 1;",
  replace: "export const o31 = 31;",
  anchor: { path: PATHS.other, text: "export const o30 = 30 + 1;" },
  comment: "Zebra quartz two: o31 misses the raise that o30 got.",
});
// A second seed on the file of ARCH, so check 9 makes it a spare.
export const SPARE = fields({
  kind: "lifetime",
  path: PATHS.feature,
  find: "export const f26 = 26 + 1;",
  replace: "export const f26 = 26 + 2;",
  anchor: { path: PATHS.feature, text: "export const f26 = 26 + 2;" },
});
export { fields as seedFields };

// A kept seed record of fields at a host, with its binding.
export const keptSeed = (id: string, f: SeedFields, host: SeedRecord["host"]): SeedRecord => ({ ...f, id, state: "kept", host });
