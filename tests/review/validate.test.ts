// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DiffFile, parseDiff } from "../../src/server/review/diffmap";
import {
  type AskedThread,
  anchorer,
  MAX_FILE_CHARS,
  overlapGroups,
  repoPath,
  type ValidateInput,
  validate,
  validateAnswered,
} from "../../src/server/review/validate";
import {
  type AnsweredQuestion,
  type Finding,
  MAX_ANSWERED,
  MAX_FINDINGS,
  moveChoices,
  type ReviewResult,
  rereviewJsonSchema,
  rereviewResult,
  reviewJsonSchema,
  reviewResult,
} from "../../src/shared/review";

console.log(`validate.test.ts imported from ${Bun.resolveSync("../../src/server/review/validate", import.meta.dir)}`);

const range = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i + 1));
const text = (lines: string[], eol = "\n") => lines.map((l) => l + eol).join("");

const A = range(30, (i) => `const a${i} = ${i};`);
const R = range(20, (i) => `const r${i} = ${i};`);
const TIE = ["a();", "dup();", "b();", "c();", "d();", "dup();", "e();"];

// Base and head trees. Each scenario of the tests sits in its own file.
const BASE: Record<string, string> = {
  "src/a.ts": text(A),
  "src/same.ts": text(["one();", "two();", "three();", "four();"]),
  "src/old-name.ts": text(R),
  "src/crlf.ts": text(["first", "second", "third"], "\r\n"),
  "src/gone.ts": text(["bye();"]),
  "db/schema.sql": text(["-- old note", "select 1;"]),
  "src/naïve file.ts": text(["x = 1"]),
  "src/nonl.ts": "a\nb",
};
const HEAD: Record<string, string> = {
  "src/a.ts": text([...A.slice(0, 9), "const a10 = 100;", "const a10b = 101;", ...A.slice(10)]),
  "src/same.ts": BASE["src/same.ts"] as string,
  "src/new-name.ts": text(R.map((l, i) => (i === 4 ? "const r5 = 50;" : l))),
  "src/crlf.ts": text(["first", "second changed", "third"], "\r\n"),
  "db/schema.sql": text(["++ new", "select 1;"]),
  "src/naïve file.ts": text(["x = 2"]),
  "src/nonl.ts": "a\nc",
  "src/tie.ts": text(TIE),
};

let dir = "";
let diff = "";
let files: DiffFile[] = [];

// The diff comes from real git, the oracle for the format.
function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    env,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function writeTree(root: string, tree: Record<string, string>) {
  for (const [p, c] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rl-wp9-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const globalCfg = join(dir, "gitconfig");
  writeFileSync(globalCfg, "");
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalCfg, GIT_TERMINAL_PROMPT: "0" };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] ??= v;
  git(repo, env, "init", "-q");
  writeTree(repo, BASE);
  writeFileSync(join(repo, "img.bin"), new Uint8Array([0, 1, 2, 0]));
  git(repo, env, "add", "-A");
  git(repo, env, "commit", "-q", "-m", "base");
  for (const p of Object.keys(BASE)) rmSync(join(repo, p));
  writeTree(repo, HEAD);
  writeFileSync(join(repo, "img.bin"), new Uint8Array([0, 1, 3, 0]));
  git(repo, env, "add", "-A");
  git(repo, env, "commit", "-q", "-m", "head");
  diff = git(repo, env, "diff", "-M", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD");
  files = parseDiff(diff);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = (path: string) => files.find((f) => f.path === path || (f.path === null && f.oldPath === path)) as DiffFile;

describe("diffmap", () => {
  test("lists each changed file with its paths", () => {
    const pairs = files.map((f) => [f.oldPath, f.path, f.binary]);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ["src/a.ts", "src/a.ts", false],
        ["src/old-name.ts", "src/new-name.ts", false],
        ["src/gone.ts", null, false],
        [null, "src/tie.ts", false],
        ["src/naïve file.ts", "src/naïve file.ts", false],
        ["img.bin", "img.bin", true],
      ]),
    );
    expect(files.length).toBe(9);
    // git quotes the non-ASCII name and appends a tab, because the name holds a space.
    expect(diff).toContain('--- "a/src/na\\303\\257ve file.ts"\t\n');
    expect(files.some((f) => f.path === "src/same.ts")).toBe(false);
  });

  test("gives the diff lines of each side with their kinds", () => {
    const a = file("src/a.ts");
    expect([...a.newLines]).toEqual([
      [7, "ctx"],
      [8, "ctx"],
      [9, "ctx"],
      [10, "add"],
      [11, "add"],
      [12, "ctx"],
      [13, "ctx"],
      [14, "ctx"],
    ]);
    expect([...a.oldLines]).toEqual([
      [7, "ctx"],
      [8, "ctx"],
      [9, "ctx"],
      [10, "del"],
      [11, "ctx"],
      [12, "ctx"],
      [13, "ctx"],
    ]);
  });

  test("reads hunk lines by count, so a removed '-- ' line is no header", () => {
    expect(file("db/schema.sql").rows).toEqual([
      { kind: "del", old: 1, new: 1, text: "-- old note" },
      { kind: "add", old: 2, new: 1, text: "++ new" },
      { kind: "ctx", old: 2, new: 2, text: "select 1;" },
    ]);
  });

  test("skips the no-newline marker and strips CR from CRLF lines", () => {
    expect(file("src/nonl.ts").rows.map((r) => [r.kind, r.text])).toEqual([
      ["ctx", "a"],
      ["del", "b"],
      ["add", "c"],
    ]);
    expect(file("src/crlf.ts").rows.map((r) => r.text)).toEqual(["first", "second", "second changed", "third"]);
  });

  test("an added file has only new-side lines", () => {
    const t = file("src/tie.ts");
    expect([...t.newLines.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(t.oldLines.size).toBe(0);
  });
});

const F = (o: Partial<Finding>): Finding => ({
  path: "src/a.ts",
  side: "new",
  line: 1,
  lineEnd: null,
  anchorText: "",
  severity: "major",
  category: "Correctness",
  body: "Body.",
  evidence: "Evidence.",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  title: "",
  trigger: "",
  cause: null,
  rule: "",
  module: "core",
  ...o,
});

const result = (findings: Finding[]): ReviewResult => ({
  summary: "One line.",
  risks: ["A risk."],
  questions: [{ text: "Why?", why: "Because." }],
  coverage: { read: ["src/a.ts"], skipped: [], unavailable: [], notChecked: [] },
  findings,
  answered: [],
});

const run = (findings: Finding[], extra: Partial<ValidateInput> = {}) =>
  validate({
    result: result(findings),
    diff,
    newFiles: new Map(Object.entries(HEAD)),
    oldFiles: new Map(Object.entries(BASE)),
    agents: [],
    ...extra,
  });
// The anchor alone, without the changed-line and rule checks of validate().
const one = (f: Partial<Finding>, extra?: Partial<ValidateInput>) =>
  anchorer({ diff, newFiles: new Map(Object.entries(HEAD)), oldFiles: new Map(Object.entries(BASE)), ...extra }).anchor(F(f));
const at = (f: Partial<Finding>) => {
  const a = one(f);
  return typeof a === "object" ? [a.state, a.line, a.lineEnd] : a;
};

describe("anchor", () => {
  test("exact: the reported line holds the quote", () => {
    const a = one({ line: 10, anchorText: "const a10 = 100;" });
    expect(a).toEqual({
      state: "exact",
      path: "src/a.ts",
      oldPath: null,
      line: 10,
      lineEnd: 10,
      excerpt: [
        { n: 7, kind: "ctx", text: "const a7 = 7;", hunk: true, old: 7 },
        { n: 8, kind: "ctx", text: "const a8 = 8;", hunk: true, old: 8 },
        { n: 9, kind: "ctx", text: "const a9 = 9;", hunk: true, old: 9 },
        { n: 10, kind: "del", text: "const a10 = 10;" },
        { n: 10, kind: "add", text: "const a10 = 100;" },
        { n: 11, kind: "add", text: "const a10b = 101;" },
        // Gate v3 U4: a hunk ctx line keeps its old-side number. One line was added above these two.
        { n: 12, kind: "ctx", text: "const a11 = 11;", hunk: true, old: 11 },
        { n: 13, kind: "ctx", text: "const a12 = 12;", hunk: true, old: 12 },
      ],
    });
    if (typeof a === "object") expect(moveChoices(a.excerpt, "new")).toEqual([7, 8, 9, 10, 11, 12, 13]);
  });

  test("exact ignores whitespace differences in the quote", () => {
    expect(at({ line: 10, anchorText: "  const\ta10   =\n100; " })).toEqual(["exact", 10, 10]);
  });

  test("moved up and moved down to the quoted line", () => {
    expect(at({ line: 13, anchorText: "const a10 = 100;" })).toEqual(["moved", 10, 10]);
    expect(at({ line: 7, anchorText: "const a10b = 101;" })).toEqual(["moved", 11, 11]);
  });

  test("moved: the nearest match wins, and a tie goes to the lower line (D4)", () => {
    expect(at({ path: "src/tie.ts", line: 4, anchorText: "dup();" })).toEqual(["moved", 2, 2]);
    expect(at({ path: "src/tie.ts", line: 5, anchorText: "dup();" })).toEqual(["moved", 6, 6]);
  });

  test("outside: context beyond -U3 in a changed file", () => {
    expect(at({ line: 14, anchorText: "const a13 = 13;" })).toEqual(["exact", 14, 14]);
    expect(at({ line: 15, anchorText: "const a14 = 14;" })).toEqual(["outside", 15, 15]);
    expect(at({ line: 20, anchorText: "const a24 = 24;" })).toEqual(["outside", 25, 25]);
  });

  test("outside: an unchanged file, with the excerpt clipped at the file start", () => {
    const a = one({ path: "src/same.ts", line: 2, anchorText: "two();" });
    expect(a).toMatchObject({ state: "outside", line: 2, oldPath: null });
    if (typeof a === "object") expect(a.excerpt.map((l) => [l.n, l.kind])).toEqual([1, 2, 3, 4].map((n) => [n, "ctx"]));
    // The diff does not show these lines.
    if (typeof a === "object") expect(a.excerpt.some((l) => l.hunk)).toBe(false);
    expect(at({ path: "src/same.ts", side: "old", line: 3, anchorText: "three();" })).toEqual(["outside", 3, 3]);
  });

  test("dropped: a missing file, a bad path, or no match", () => {
    expect(one({ path: "src/nope.ts", anchorText: "x" })).toBe("file");
    expect(one({ path: "src/gone.ts", anchorText: "bye();" })).toBe("file");
    expect(one({ path: "src/tie.ts", side: "old", anchorText: "a();" })).toBe("file");
    for (const path of [
      "../secret.txt",
      "src/../../secret.txt",
      "/etc/passwd",
      "C:\\secret.txt",
      "\\\\host\\share\\x",
      ".git/config",
      "",
      "./",
    ])
      expect([path, one({ path, anchorText: "x" })]).toEqual([path, "path"]);
    expect(one({ line: 10, anchorText: "const a10 = 1000;" })).toBe("match");
    expect(one({ line: 10, anchorText: " \n\t" })).toBe("match");
    const r = run([F({ path: "../x", anchorText: "x" })]);
    expect(r.findings).toEqual([]);
    expect(r.dropped).toEqual([{ ...F({ path: "../x", anchorText: "x" }), reason: "path" }]);
  });

  test("a wrong file: one exact match on a changed line of another changed file moves the finding there", () => {
    const wrong = F({ path: "src/a.ts", line: 3, anchorText: "const r5 = 50;" });
    const r = run([wrong, F({ path: "src/nope.ts", line: 2, lineEnd: 4, anchorText: "const a10b = 101;" })]);
    expect(r.dropped).toEqual([]);
    expect(r.findings.map((f) => [f.path, f.side, f.line, f.lineEnd, f.anchor.state, f.anchor.line, f.movedFrom])).toEqual([
      ["src/new-name.ts", "new", 5, null, "exact", 5, { path: "src/a.ts", line: 3 }],
      ["src/a.ts", "new", 11, null, "exact", 11, { path: "src/nope.ts", line: 2 }],
    ]);
    // A finding that its own file anchors gets no mark.
    expect(run([F({ line: 10, anchorText: "const a10 = 100;" })]).findings[0]?.movedFrom).toBeUndefined();
  });

  test("a wrong file: two matches, a match on an unchanged line, or a match only in an unchanged file keep the first drop", () => {
    const drops = run([
      F({ path: "src/a.ts", line: 3, anchorText: "dup();" }),
      F({ path: "src/a.ts", line: 3, anchorText: "const r1 = 1;" }),
      F({ path: "src/nope.ts", line: 3, anchorText: "two();" }),
    ]);
    expect(drops.findings).toEqual([]);
    expect(drops.dropped.map((d) => [d.path, d.reason])).toEqual([
      ["src/a.ts", "match"],
      ["src/a.ts", "match"],
      ["src/nope.ts", "file"],
    ]);
  });

  test("repoPath normalizes separators and dot parts", () => {
    expect(repoPath("src\\a.ts")).toBe("src/a.ts");
    expect(repoPath("./src//a.ts")).toBe("src/a.ts");
    expect(repoPath("src/.GIT/x")).toBeNull();
  });

  test("lineEnd: a range holds a quote of two lines", () => {
    expect(at({ line: 10, lineEnd: 11, anchorText: "const a10 = 100;\nconst a10b = 101;" })).toEqual(["exact", 10, 11]);
    // A moved range keeps its height.
    expect(at({ line: 2, lineEnd: 3, anchorText: "const a10b = 101;" })).toEqual(["moved", 10, 11]);
    // A range that is too short grows to the quote.
    expect(at({ line: 10, anchorText: "const a10 = 100;\nconst a10b = 101;" })).toEqual(["moved", 10, 11]);
    // A range with lineEnd before line counts as one line.
    expect(at({ line: 10, lineEnd: 4, anchorText: "const a10 = 100;" })).toEqual(["moved", 10, 10]);
  });

  test("old side: a removed line, with the added lines between the excerpt lines", () => {
    const a = one({ side: "old", line: 10, anchorText: "const a10 = 10;" });
    expect(a).toMatchObject({ state: "exact", line: 10 });
    if (typeof a !== "object") throw new Error("not anchored");
    expect(a.excerpt.map((l) => [l.n, l.kind])).toEqual([
      [7, "ctx"],
      [8, "ctx"],
      [9, "ctx"],
      [10, "del"],
      [10, "add"],
      [11, "add"],
      [11, "ctx"],
      [12, "ctx"],
      [13, "ctx"],
    ]);
    expect(moveChoices(a.excerpt, "old")).toEqual([7, 8, 9, 10, 11, 12, 13]);
    // Only a new-side excerpt carries the old-side number of its ctx lines.
    expect(a.excerpt.some((l) => l.old !== undefined)).toBe(false);
    expect(one({ path: "src/gone.ts", side: "old", line: 1, anchorText: "bye();" })).toEqual({
      state: "exact",
      path: "src/gone.ts",
      oldPath: null,
      line: 1,
      lineEnd: 1,
      excerpt: [{ n: 1, kind: "del", text: "bye();" }],
    });
  });

  test("rename: the new path, the old path, and the base side", () => {
    const names = { path: "src/new-name.ts", oldPath: "src/old-name.ts" };
    expect(one({ path: "src/new-name.ts", line: 5, anchorText: "const r5 = 50;" })).toMatchObject({ state: "exact", line: 5, ...names });
    expect(one({ path: "src/old-name.ts", side: "old", line: 5, anchorText: "const r5 = 5;" })).toMatchObject({
      state: "exact",
      line: 5,
      ...names,
    });
    expect(one({ path: "src/new-name.ts", line: 15, anchorText: "const r15 = 15;" })).toMatchObject({ state: "outside", ...names });
  });

  test("a CRLF file matches, and its excerpt has no CR", () => {
    const a = one({ path: "src/crlf.ts", line: 2, anchorText: "second changed" });
    expect(a).toMatchObject({
      state: "exact",
      excerpt: [
        { n: 1, kind: "ctx", text: "first" },
        { n: 2, kind: "del", text: "second" },
        { n: 2, kind: "add", text: "second changed" },
        { n: 3, kind: "ctx", text: "third" },
      ],
    });
  });

  test("the excerpt stops at the file start and the file end", () => {
    const lines = (line: number, anchorText: string) => {
      const a = one({ path: "src/tie.ts", line, anchorText });
      return typeof a === "object" ? a.excerpt.map((l) => l.n) : a;
    };
    expect(lines(1, "a();")).toEqual([1, 2, 3, 4]);
    expect(lines(7, "e();")).toEqual([4, 5, 6, 7]);
  });

  test("a huge file: the scan stays bounded", () => {
    const big = "x\n".repeat(MAX_FILE_CHARS / 2);
    const newFiles = new Map([
      ["over.txt", `${big}y`],
      ["big.txt", big],
      ["tall.txt", text(range(120, (i) => `t${i}`))],
    ]);
    const n = MAX_FILE_CHARS / 2;
    const t0 = performance.now();
    // Every line matches "x". One anchorer prepares the file once for all its findings.
    const { anchor } = anchorer({ diff, newFiles, oldFiles: new Map() });
    const got = [
      F({ path: "over.txt", line: 1, anchorText: "x" }),
      F({ path: "big.txt", line: 1_000_000, anchorText: "x" }),
      F({ path: "big.txt", line: 1_000_000, anchorText: "x x" }),
      F({ path: "big.txt", line: 3_000_000, anchorText: "x" }),
      F({ path: "big.txt", line: 1, anchorText: "x x y" }),
    ].map(anchor);
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(got.map((a) => (typeof a === "string" ? a : [a.state, a.line, a.lineEnd]))).toEqual([
      "size",
      ["outside", 1_000_000, 1_000_000],
      ["outside", 1_000_000, 1_000_001],
      ["outside", n, n],
      "match",
    ]);
    // A quote of more than 100 lines is above the range limit. A range of 100 lines is not.
    const tall = (lineEnd: number, anchorText: string) => one({ path: "tall.txt", line: 1, lineEnd, anchorText }, { newFiles });
    expect(tall(101, range(101, (i) => `t${i}`).join("\n"))).toBe("size");
    expect(tall(100, "t50")).toMatchObject({ line: 1, lineEnd: 100 });
  });

  test("agent must name an Agent event of the run", () => {
    const r = run(
      [
        F({ line: 10, anchorText: "const a10 = 100;", agent: "correctness" }),
        F({ line: 10, anchorText: "const a10 = 100;", agent: "ghost" }),
        F({ path: "../x", agent: "correctness" }),
        F({ path: "../x", agent: "rl-main" }),
      ],
      { agents: ["correctness", "docs-check"] },
    );
    expect(r.findings.map((f) => f.agent)).toEqual(["correctness", null]);
    expect(r.dropped.map((f) => f.agent)).toEqual(["correctness", null]);
  });

  test("an Explain run keeps only its questions", () => {
    const r = run([F({ line: 10, anchorText: "const a10 = 100;" }), F({ path: "../x" })], { explain: true });
    expect(r).toEqual({ ...result([]), findings: [], dropped: [], kept: [null, null] });
  });

  test("kept maps each finding of the result to its index in findings, or null when dropped", () => {
    const r = run([
      F({ path: "../x" }),
      F({ line: 10, anchorText: "const a10 = 100;" }),
      F({ path: "src/none.ts" }),
      F({ line: 11, anchorText: "const a10b = 101;" }),
    ]);
    expect(r.kept).toEqual([null, 0, null, 1]);
    expect(r.findings).toHaveLength(2);
  });
});

// docs/plans/review-v2/spec.md section 1.7 (WP-R3).
describe("changed lines, causes, and rules", () => {
  const ctx = { line: 14, anchorText: "const a13 = 13;" };
  const added = { path: "src/a.ts", side: "new" as const, line: 10, lineEnd: null, anchorText: "const a10 = 100;" };
  const drops = (r: ReturnType<typeof run>) => r.dropped.map((d) => d.reason);

  test("AC-R7: an anchor on a context line without a cause drops as unchanged; a cause on an added line keeps it with its anchor", () => {
    expect(drops(run([F(ctx)]))).toEqual(["unchanged"]);
    const r = run([F({ ...ctx, cause: added })]);
    expect(drops(r)).toEqual([]);
    expect(r.findings[0]?.anchor).toMatchObject({ state: "exact", line: 14 });
    expect(r.findings[0]?.cause).toEqual({ ...added, anchor: expect.objectContaining({ state: "exact", line: 10, lineEnd: 10 }) });
  });

  test("a cause on a context line, a cause without a match, and an unchanged file with no cause drop as unchanged", () => {
    const r = run([
      F({ ...ctx, cause: { ...added, line: 12, anchorText: "const a11 = 11;" } }),
      F({ ...ctx, cause: { ...added, anchorText: "nowhere();" } }),
      F({ path: "src/same.ts", line: 2, anchorText: "two();" }),
    ]);
    expect(drops(r)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(r.kept).toEqual([null, null, null]);
  });

  test("a removed line counts on side old; a cause in another changed file keeps a finding on an unchanged file", () => {
    expect(drops(run([F({ side: "old", line: 10, anchorText: "const a10 = 10;" })]))).toEqual([]);
    expect(drops(run([F({ side: "old", line: 11, anchorText: "const a11 = 11;" })]))).toEqual(["unchanged"]);
    const r = run([
      F({
        path: "src/same.ts",
        line: 2,
        anchorText: "two();",
        cause: { ...added, path: "src/new-name.ts", line: 5, anchorText: "const r5 = 50;" },
      }),
    ]);
    expect(r.findings[0]?.cause?.anchor).toMatchObject({ path: "src/new-name.ts", oldPath: "src/old-name.ts", line: 5 });
    // A finding on a changed line keeps its cause as the finder gave it.
    const own = run([F({ ...added, cause: { ...added, line: 14, anchorText: "const a13 = 13;" } })]);
    expect(own.findings[0]?.cause).toEqual({ ...added, line: 14, anchorText: "const a13 = 13;" });
  });

  test("AC-R8: a rule quote must be in the instructions; a quote from another scope keeps the finding as core; whitespace collapses", () => {
    const rules = [
      { scope: null, text: "## Root\n\nLog   no\ntokens." },
      { scope: "src", text: "Name each lock after the data it guards." },
      { scope: "db", text: "Every query has a limit." },
    ];
    const rule = (o: Partial<Finding>) => F({ ...added, module: "rules", ...o });
    const r = run(
      [
        rule({ rule: "Log no tokens." }),
        rule({ rule: "  Name each lock\nafter the data it guards. " }),
        rule({ rule: "Every query has a limit." }),
        rule({ rule: "Never use tabs." }),
        rule({ path: "db/schema.sql", line: 1, anchorText: "++ new", rule: "Every query has a limit." }),
        // Only module rules is checked, and only with a rule text.
        F({ ...added, module: "core", rule: "Never use tabs." }),
        rule({ rule: "  " }),
      ],
      { rules },
    );
    expect(r.dropped.map((d) => [d.rule, d.reason])).toEqual([["Never use tabs.", "rule"]]);
    expect(r.kept).toEqual([0, 1, 2, null, 3, 4, 5]);
    // The db rule quoted for src/a.ts is out of its scope: the finding stays with no module and no rule.
    expect(r.findings.map((f) => [f.module, f.rule])).toEqual([
      ["rules", "Log no tokens."],
      ["rules", "  Name each lock\nafter the data it guards. "],
      ["core", ""],
      ["rules", "Every query has a limit."],
      ["core", "Never use tabs."],
      ["rules", "  "],
    ]);
    // No instructions: every rule finding drops.
    expect(drops(run([rule({ rule: "Log no tokens." })]))).toEqual(["rule"]);
  });

  test("a scope covers only the paths below its folder, also for a removed line of a renamed file", () => {
    const rules = [{ scope: "src/old-name.ts", text: "Keep r5." }];
    const r = run(
      [
        F({ path: "src/old-name.ts", side: "old", line: 5, anchorText: "const r5 = 5;", module: "rules", rule: "Keep r5." }),
        F({ path: "src/new-name.ts", line: 5, anchorText: "const r5 = 50;", module: "rules", rule: "Keep r5." }),
      ],
      { rules: [{ scope: "src/old", text: "Keep r5." }, ...rules] },
    );
    expect(drops(r)).toEqual([]);
    expect(r.findings.map((f) => [f.module, f.rule])).toEqual([
      ["core", ""],
      ["core", ""],
    ]);
    const base = run(
      [F({ path: "src/old-name.ts", side: "old", line: 5, anchorText: "const r5 = 5;", module: "rules", rule: "Keep r5." })],
      {
        rules: [{ scope: "src", text: "Keep r5." }],
      },
    );
    expect(drops(base)).toEqual([]);
    expect(base.findings[0]).toMatchObject({ module: "rules", rule: "Keep r5." });
  });

  test("dedupe: overlapping ranges on one path and side form groups by transitivity, numbered by their first finding", () => {
    const at = (path: string, line: number, lineEnd: number, side: "new" | "old" = "new") => ({ side, anchor: { path, line, lineEnd } });
    expect(
      overlapGroups([
        at("b.ts", 1, 1),
        at("a.ts", 1, 3),
        at("a.ts", 5, 7),
        at("a.ts", 3, 5),
        at("a.ts", 4, 4, "old"),
        at("c.ts", 8, 9),
        at("b.ts", 1, 2),
        at("a.ts", 8, 8),
      ]),
    ).toEqual([1, 2, 2, 2, null, null, 1, null]);
    expect(overlapGroups([])).toEqual([]);
  });
});

describe("result schema", () => {
  test("parses a result and caps the findings", () => {
    const ok = result([F({ line: 3, lineEnd: 4, anchorText: "x", agent: "correctness" })]);
    expect(reviewResult.parse(ok)).toEqual(ok);
    expect(reviewResult.safeParse(result(range(MAX_FINDINGS + 1, () => F({})))).success).toBe(false);
    expect(reviewResult.safeParse(result([F({ line: 0 })])).success).toBe(false);
    expect(reviewResult.safeParse(result([F({ severity: "info" as Finding["severity"] })])).success).toBe(false);
  });

  test("the JSON schema is draft-07 with an object root and no optional field", () => {
    const s = reviewJsonSchema() as {
      $schema: string;
      type: string;
      required: string[];
      properties: { findings: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(s.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(s.type).toBe("object");
    expect(s.required.sort()).toEqual(["answered", "coverage", "findings", "questions", "risks", "summary"]);
    expect(s.properties.findings.items.required.sort()).toEqual(Object.keys(F({})).sort());
    expect(s.properties.findings.items.additionalProperties).toBe(false);
  });

  test("thread outcome section 9: answered lists every key as required; an Explain schema has no answered key", () => {
    type Items = { required: string[]; additionalProperties: boolean; properties: Record<string, { type?: unknown; anyOf?: unknown }> };
    const s = reviewJsonSchema() as { properties: { answered: { type: string; items: Items } } };
    expect(s.properties.answered.type).toBe("array");
    expect(s.properties.answered.items.required.sort()).toEqual(["evidence", "finding", "outcome", "question", "reply", "thread"]);
    expect(s.properties.answered.items.additionalProperties).toBe(false);
    const explain = reviewJsonSchema(true) as { $schema: string; required: string[]; properties: Record<string, unknown> };
    expect(explain.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(explain.required.sort()).toEqual(["coverage", "findings", "questions", "risks", "summary"]);
    expect(explain.properties.answered).toBeUndefined();
    const rereview = rereviewJsonSchema() as { required: string[] };
    expect(rereview.required).toEqual(expect.arrayContaining(["answered", "earlier"]));
  });

  test("thread outcome section 9: an old result without answered parses with an empty list; entries default question and finding", () => {
    const { answered: _answered, ...old } = result([]);
    expect(reviewResult.parse(old).answered).toEqual([]);
    expect(rereviewResult.parse({ ...old, earlier: [] }).answered).toEqual([]);
    const parsed = reviewResult.parse({ ...old, answered: [{ thread: 7, outcome: "settled", evidence: "Message 9.", reply: "" }] });
    expect(parsed.answered).toEqual([{ thread: 7, question: null, outcome: "settled", evidence: "Message 9.", reply: "", finding: null }]);
    for (const bad of [{ outcome: "done" }, { thread: 0 }, { question: 0 }, { finding: -1 }])
      expect(
        reviewResult.safeParse({ ...old, answered: [{ thread: 7, outcome: "settled", evidence: "", reply: "", ...bad }] }).success,
      ).toBe(false);
    const many = range(MAX_ANSWERED + 1, (i) => ({ thread: i, outcome: "settled", evidence: "", reply: "" }));
    expect(reviewResult.safeParse({ ...old, answered: many }).success).toBe(false);
  });
});

describe("answered questions (thread outcome section 9)", () => {
  const A = (o: Partial<AnsweredQuestion>): AnsweredQuestion => ({
    thread: 1,
    question: null,
    outcome: "settled",
    evidence: "Message 5: it is intended.",
    reply: "",
    finding: null,
    ...o,
  });
  const T = (thread: number, questions: number, o: Partial<AskedThread> = {}): AskedThread => ({
    thread,
    replyTo: thread + 100,
    mine: true,
    questions,
    ...o,
  });

  test("settled: an unaccepted draft with the resolve proposal, ticked only in a thread that the user started", () => {
    const r = validateAnswered([A({ reply: "Thanks, clear." }), A({ thread: 2 })], [T(1, 1), T(2, 1, { mine: false })], []);
    expect(r.skipped).toEqual([]);
    expect(r.replies).toEqual([
      {
        status: "new",
        payload: {
          thread: 1,
          action: "reply",
          body: "Thanks, clear.",
          reason: "Message 5: it is intended.",
          evidenceStatus: "unverified",
          judgement: "settled",
          replyTo: 101,
          resolve: true,
          resolveEvidence: "Message 5: it is intended.",
          resolveTick: true,
          origin: "review",
        },
      },
      {
        status: "new",
        payload: expect.objectContaining({ thread: 2, action: "none", body: "", resolve: true, resolveTick: false, replyTo: 102 }),
      },
    ]);
  });

  test("followup and issue: a draft with the reply and no resolve; an issue needs a finding that the validator kept", () => {
    const r = validateAnswered(
      [
        A({ thread: 1, outcome: "followup", reply: "Which caller holds the lock?" }),
        A({ thread: 2, outcome: "issue", reply: "Thanks. This shows a gap: no lock. I added it as a review point.", finding: 1 }),
        A({ thread: 3, outcome: "issue", reply: "Gap.", finding: 0 }),
        A({ thread: 4, outcome: "issue", reply: "Gap.", finding: 5 }),
        A({ thread: 5, outcome: "issue", reply: "Gap." }),
        A({ thread: 6, outcome: "followup", reply: "  " }),
      ],
      [T(1, 1), T(2, 1), T(3, 1), T(4, 1), T(5, 1), T(6, 1)],
      [null, 0],
    );
    expect(r.replies.map((x) => [x.payload.thread, x.payload.judgement, x.payload.resolve, x.payload.resolveTick, x.payload.body])).toEqual(
      [
        [1, "followup", false, false, "Which caller holds the lock?"],
        [2, "unsettled", false, false, "Thanks. This shows a gap: no lock. I added it as a review point."],
      ],
    );
    expect(r.replies[1]?.payload.resolveEvidence).toBe("");
    expect(r.skipped).toEqual([
      "Answer for thread 3 dropped: the validator dropped finding 0.",
      "Answer for thread 4 dropped: the result has no finding 5.",
      "Answer for thread 5 dropped: an issue needs its finding.",
      "Reply for thread 6 dropped: the body is empty, and a question stays open.",
    ]);
  });

  test("unanswered questions give no draft; an unknown thread, a missing or wrong question number, and a second entry are dropped", () => {
    const r = validateAnswered(
      [
        A({ thread: 9 }),
        A({ thread: 2 }),
        A({ thread: 2, question: 4 }),
        A({ thread: 1, question: 1, reply: "First." }),
        A({ thread: 1, question: 1, reply: "Again." }),
      ],
      [T(1, 1), T(2, 3), T(3, 2)],
      [],
    );
    expect(r.replies.map((x) => [x.payload.thread, x.payload.body])).toEqual([[1, "First."]]);
    expect(r.skipped).toEqual([
      "Answer for thread 9 dropped: the thread holds no question of the user.",
      "Answer for thread 2 dropped: the thread holds several questions, and the entry names none.",
      "Answer for thread 2, question 4 dropped: the thread has no question 4.",
      "Answer for thread 1, question 1 dropped: a second entry for question 1.",
    ]);
    expect(validateAnswered([], [T(1, 1)], [])).toEqual({ replies: [], skipped: [] });
  });

  test("several questions: one draft per thread; resolve only when each question is settled; the reply names the open ones", () => {
    const all = validateAnswered(
      [
        A({ question: 2, evidence: "Message 8: yes.", reply: "" }),
        A({ question: 1, evidence: "Message 7: no.", reply: "Thanks, both clear." }),
      ],
      [T(1, 2)],
      [],
    );
    expect(all.replies).toHaveLength(1);
    expect(all.replies[0]?.payload).toMatchObject({
      body: "Thanks, both clear.",
      judgement: "settled",
      resolve: true,
      resolveTick: true,
      resolveEvidence: "Message 7: no. Message 8: yes.",
    });
    // Question 3 has no answer: no resolve, and the reply names it.
    const open = validateAnswered(
      [A({ question: 1, reply: "Thanks for 1. Question 3 is still open." }), A({ question: 2, reply: "" })],
      [T(1, 3)],
      [],
    );
    expect(open.replies[0]?.payload).toMatchObject({
      body: "Thanks for 1. Question 3 is still open.",
      judgement: "unsettled",
      resolve: false,
      resolveTick: false,
    });
    // A follow-up wins over unsettled. Two replies of one thread join in question order.
    const mixed = validateAnswered(
      [
        A({ question: 2, outcome: "followup", reply: "Which version?" }),
        A({ question: 1, outcome: "issue", reply: "Gap added.", finding: 0 }),
      ],
      [T(1, 2)],
      [0],
    );
    expect(mixed.replies[0]?.payload).toMatchObject({ body: "Gap added.\n\nWhich version?", judgement: "followup", resolve: false });
    // All settled but no text and a question open: nothing to post.
    expect(validateAnswered([A({ question: 1 })], [T(1, 2)], []).skipped).toEqual([
      "Reply for thread 1 dropped: the body is empty, and a question stays open.",
    ]);
  });
});
