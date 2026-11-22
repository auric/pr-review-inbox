// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/seeded-truth.md WP-SG1: the mechanical checks 1 to 10, the history rewrite, the seeded case, and the frozen set
// build. Every repository is a synthetic temp repository (tests/support/seed-fixture.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCases, localCaseFile, SEED_KINDS, setFingerprint } from "../../scripts/eval/cases";
import { caseId } from "../../scripts/eval/local";
import {
  applySeed,
  bindingOf,
  buildSeededSet,
  buildText,
  type Checked,
  checkSeed,
  commentLines,
  editCommit,
  giveaways,
  type Host,
  hostsOf,
  pickSeeds,
  rangeOf,
  rewriteHistory,
  type SeedBuild,
  type SeededInfo,
  type SeededManifest,
  unusedNames,
} from "../../scripts/eval/seed-build";
import { loadStore, type SeedFields, type SeedRecord, saveStore } from "../../scripts/eval/seed-store";
import { parseDiff } from "../../src/server/review/diffmap";
import { diffArgs } from "../../src/server/review/workspace";
import { ARCH, addTwin, gitIn, keptSeed, makeNaturalSet, type NaturalSet, OMIT, PATHS, SPARE, seedFields } from "../support/seed-fixture";

console.log(`seed-build.test.ts imported from ${Bun.resolveSync("../../scripts/eval/seed-build", import.meta.dir)}`);

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const TMP = mkdtempSync(join(tmpdir(), "rl-seed-build-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

let nat: NaturalSet;
let host: Host;
let mergeHost: Host;
beforeAll(async () => {
  nat = await makeNaturalSet(join(TMP, "fx"));
  mkdirSync(join(TMP, "hosts"));
  const open = hostsOf(nat.dir, join(TMP, "hosts"));
  host = (await open(nat.host)) as Host;
  mergeHost = (await open(nat.mergeHost)) as Host;
}, SLOW);

const git = async (args: string[], dir = nat.repo) => (await gitIn(nat.env, dir, args)).toString("utf8").trim();
const check = (f: Partial<SeedFields> & Pick<SeedFields, "kind" | "path" | "find" | "replace" | "anchor">) =>
  checkSeed(host, seedFields(f));
const F = PATHS.feature;

describe("applySeed", () => {
  test("whole lines, the line ending of the file, and the last line", () => {
    expect(applySeed("a\r\nb\r\nc\r\n", { find: "b\n", replace: "x\ny" })).toEqual({ text: "a\r\nx\r\ny\r\nc\r\n", start: 2, end: 2 });
    expect(applySeed("a\nb", { find: "b", replace: "c" })).toEqual({ text: "a\nc", start: 2, end: 2 });
    expect(applySeed("a\nb\nc\n", { find: "b", replace: "" })).toEqual({ text: "a\nc\n", start: 2, end: 2 });
    expect(applySeed("a\nab\n", { find: "b", replace: "c" })).toEqual({
      reason: "find occurs 0 times as whole lines. It must occur once.",
    });
    expect(applySeed("b\nb\n", { find: "b", replace: "c" })).toEqual({ reason: "find occurs 2 times as whole lines. It must occur once." });
    expect(applySeed("a\nb\n", { find: "b\r\n", replace: "b" })).toEqual({ reason: "replace equals find." });
  });
});

describe("mechanical checks (section 5.2)", () => {
  test(
    "the fixture seeds pass, and a CRLF file keeps CRLF",
    async () => {
      for (const s of [ARCH, OMIT, SPARE]) expect(await checkSeed(host, s)).not.toHaveProperty("check");
      const a = (await checkSeed(host, ARCH)) as Checked;
      expect(a).toMatchObject({ region: [22, 22], anchor: { path: F, line: 23 }, alt: [{ path: PATHS.route, line: 3 }] });
      const crlf = await check({
        kind: "local",
        path: "src/crlf.ts",
        find: "export const c11 = 11 + 1;",
        replace: "export const c11 = 11 - 1;",
        anchor: { path: "src/crlf.ts", text: "export const c11 = 11 - 1;" },
      });
      expect(crlf).not.toHaveProperty("check");
      const bytes = await gitIn(nat.env, host.repo.dir, ["cat-file", "blob", (crlf as Checked).seeded]);
      expect(bytes.toString("utf8")).toContain(
        "export const c10 = 10 + 1;\r\nexport const c11 = 11 - 1;\r\nexport const c12 = 12 + 1;\r\n",
      );
    },
    SLOW,
  );

  test(
    "check 1: the path, a find that occurs once, and a replace that differs",
    async () => {
      expect(await check({ kind: "local", path: "src/missing.ts", find: "a", replace: "b", anchor: { path: F, text: "a" } })).toEqual({
        check: 1,
        reason: "The path does not exist at the head.",
      });
      expect(
        await check({ kind: "local", path: "src/util.ts", find: "  return 0;", replace: "  return 1;", anchor: { path: F, text: "a" } }),
      ).toEqual({
        check: 1,
        reason: "find occurs 2 times as whole lines. It must occur once.",
      });
      const same = "export const f25 = 25 + 1;";
      expect(await check({ kind: "local", path: F, find: same, replace: same, anchor: { path: F, text: same } })).toEqual({
        check: 1,
        reason: "replace equals find.",
      });
    },
    SLOW,
  );

  test(
    "check 2: 1 to 8 changed lines, 12 for an omission",
    async () => {
      const find = "export const f25 = 25 + 1;";
      const replace = Array.from({ length: 10 }, (_, k) => `export const g${k} = ${k};`).join("\n");
      const anchor = { path: F, text: "export const g0 = 0;" };
      expect(await check({ kind: "local", path: F, find, replace, anchor })).toEqual({
        check: 2,
        reason: "The seed changes 11 lines. The limit is 1 to 8.",
      });
      expect(await check({ kind: "omission", path: F, find, replace, anchor })).not.toHaveProperty("check");
    },
    SLOW,
  );

  test(
    "check 3: every find line lies within 3 lines of a line that the change adds",
    async () => {
      expect(
        await check({
          kind: "local",
          path: F,
          find: "export const f5 = 5;",
          replace: "export const f5 = 6;",
          anchor: { path: F, text: "export const f5 = 6;" },
        }),
      ).toEqual({ check: 3, reason: "Line 5 of find is not within 3 lines of a line that the change adds." });
    },
    SLOW,
  );

  test(
    "check 4: a known code type, and no added comment line",
    async () => {
      expect(
        await check({
          kind: "local",
          path: "docs/notes.md",
          find: "The store keeps values and sizes.",
          replace: "The store keeps values.",
          anchor: { path: "docs/notes.md", text: "The store keeps values." },
        }),
      ).toEqual({ check: 4, reason: "The file is not of a known code type." });
      expect(
        await check({
          kind: "local",
          path: F,
          find: "export const f25 = 25 + 1;",
          replace: "// keeps the old value\nexport const f25 = 25 + 2;",
          anchor: { path: F, text: "export const f25 = 25 + 2;" },
        }),
      ).toEqual({ check: 4, reason: "The seed adds a comment line." });
      // The second added line starts with no comment prefix, but it is inside a block comment.
      expect(
        await check({
          kind: "local",
          path: F,
          find: "  saveRecord(store, k, value);",
          replace: "  saveRecord(store, k, value); /*\n  the value stays as given */",
          anchor: { path: F, text: "saveRecord(store, k, value); /*" },
        }),
      ).toEqual({ check: 4, reason: "The seed adds a line inside a comment or a docstring." });
    },
    SLOW,
  );

  test("check 4: commentLines finds doc comments and docstrings, and a string opens no comment", () => {
    const ts = [
      "/**",
      " * Returns the size.",
      " */",
      "export const s = '/* no comment */';",
      "const t = 1; /* trailing */",
      "/// A triple-slash line.",
      "const u = `a",
      "/* still a string */`;",
    ].join("\n");
    expect([...commentLines(ts, "src/a.ts")]).toEqual([1, 2, 3, 6]);
    const py = ["def f():", '    """Return the size.', "", '    Twice."""', "    x = '#no'  # yes", '    y = """data', '    """'].join(
      "\n",
    );
    expect([...commentLines(py, "src/a.py")]).toEqual([2, 4, 7]);
  });

  test(
    "check 5: no marker word in an added line",
    async () => {
      expect(
        await check({
          kind: "local",
          path: F,
          find: "export const f25 = 25 + 1;",
          replace: "export const f25 = 25 + Todo;",
          anchor: { path: F, text: "export const f25 = 25 + Todo;" },
        }),
      ).toEqual({ check: 5, reason: 'An added line holds the marker word "todo".' });
    },
    SLOW,
  );

  test(
    "check 6: the seed lines and the anchor lie 7 lines or more from every natural item",
    async () => {
      expect(
        await check({
          kind: "local",
          path: F,
          find: "export const f45 = 45 + 1;",
          replace: "export const f45 = 45 - 1;",
          anchor: { path: F, text: "export const f45 = 45 - 1;" },
        }),
      ).toEqual({ check: 6, reason: "The seed lines lie within 6 lines of a natural item." });
      expect(
        await check({
          kind: "local",
          path: F,
          find: "export const f26 = 26 + 1;",
          replace: "export const f26 = 26 + 2;",
          anchor: { path: F, text: "export const f44 = 44;" },
        }),
      ).toEqual({ check: 6, reason: "The anchor or an alt place lies within 6 lines of a natural item." });
    },
    SLOW,
  );

  test(
    "check 7: the anchor and each alt place resolve to one line, and the anchor lies near a changed line",
    async () => {
      const base = { kind: "local" as const, path: F, find: "export const f26 = 26 + 1;", replace: "export const f26 = 26 + 2;" };
      expect(await check({ ...base, anchor: { path: F, text: "export const f99 = 99;" } })).toEqual({
        check: 7,
        reason: "The anchor text matches 0 lines at the seeded head.",
      });
      expect(
        await check({
          ...base,
          anchor: { path: F, text: "export const f26 = 26 + 2;" },
          alt: [{ path: "src/util.ts", text: "return 0;" }],
        }),
      ).toEqual({
        check: 7,
        reason: "The alt text matches 2 lines at the seeded head.",
      });
      expect(await check({ ...base, anchor: { path: F, text: "export const f2 = 2;" } })).toEqual({
        check: 7,
        reason: "The anchor line is not within 3 lines of a changed line of the seeded change.",
      });
    },
    SLOW,
  );

  test(
    "check 8: the added lines use the indent character of the find lines",
    async () => {
      expect(
        await check({
          kind: "local",
          path: "src/block.ts",
          find: "  return total;",
          replace: "\treturn total + 1;",
          anchor: { path: "src/block.ts", text: "return total + 1;" },
        }),
      ).toEqual({ check: 8, reason: "An added line uses another indent character than the find lines." });
    },
    SLOW,
  );

  test(
    "check 10: one rejecting test per condition",
    async () => {
      expect(await checkSeed(host, { ...ARCH, route: "store::saveRecord" })).toEqual({
        check: 10,
        reason: "The route is not one identifier.",
      });
      expect(await checkSeed(host, { ...ARCH, route: "saveRec" })).toEqual({
        check: 10,
        reason: "find does not hold the route as a whole word.",
      });
      expect(
        await checkSeed(host, {
          ...ARCH,
          replace: "  saveRecord(store, k, value);\n  store.set(k, value);",
          anchor: { path: F, text: "store.set(k, value);" },
        }),
      ).toEqual({
        check: 10,
        reason: "replace still holds the route.",
      });
      // rareHelper: defined in one file and used in one other file at the merge base.
      expect(
        await check({
          kind: "architecture",
          path: F,
          find: "  return rareHelper(store.size);",
          replace: "  return store.size;",
          anchor: { path: F, text: "return store.size;" },
          route: "rareHelper",
        }),
      ).toEqual({ check: 10, reason: "The route occurs in 2 files besides the seed path at the merge base. The minimum is 3." });
      expect(await checkSeed(host, { ...OMIT, route: "saveRecord" })).toEqual({
        check: 10,
        reason: "Only a seed of kind architecture has a route.",
      });
    },
    SLOW,
  );

  test("check 9: one seed per file and at most 3 per host, the lowest kind count first, then the seeder order", () => {
    const s = (id: string, hostId: string, kind: SeedRecord["kind"], path: string) =>
      keptSeed(id, { ...SPARE, kind, path }, { id: hostId, base: nat.base, head: nat.head, blob: nat.base });
    const a = [s("sd000000000a", "a", "lifetime", "1"), s("sd000000000b", "a", "lifetime", "1"), s("sd000000000c", "a", "leak", "2")];
    const b = [
      s("sd000000000d", "b", "lifetime", "1"),
      s("sd000000000e", "b", "leak", "2"),
      s("sd000000000f", "b", "error", "3"),
      s("sd0000000010", "b", "local", "4"),
    ];
    const { picked, spares } = pickSeeds(
      new Map([
        ["b", b],
        ["a", a],
      ]),
    );
    expect([...picked.keys()]).toEqual(["a", "b"]);
    expect(picked.get("a")?.map((x) => x.id)).toEqual(["sd000000000a", "sd000000000c"]);
    // After host a: lifetime 1, leak 1. error and local have 0, so they come first, then lifetime by the seeder order.
    expect(picked.get("b")?.map((x) => x.id)).toEqual(["sd000000000f", "sd0000000010", "sd000000000d"]);
    expect(spares).toBe(2);
  });
});

describe("check 11: unused and dangling names (section 5.2)", () => {
  const names = async (f: Partial<SeedFields> & Pick<SeedFields, "kind" | "path" | "find" | "replace" | "anchor">) => {
    const c = await check(f);
    if ("check" in c) throw new Error(c.reason);
    return unusedNames(host, f, c);
  };
  // A file that is not in the repository: the text after the edit is given, and git grep reads the host head for the other files.
  const at = (path: string, find: string, replace: string, text: string) => unusedNames(host, { path, find, replace }, { text });

  test(
    "a removed use that leaves its declaration alone, and an added name with no other place, are flagged",
    async () => {
      const base = { kind: "contract" as const, path: F, anchor: { path: F, text: "saveRecord(store, key, value);" } };
      expect(await names({ ...base, find: "  saveRecord(store, k, value);", replace: "  saveRecord(store, key, value);" })).toEqual(["k"]);
      // k loses its declaration and keeps one use. kk is new and has no use.
      expect(
        await names({ ...base, find: "  const k = key;", replace: "  const kk = key;", anchor: { path: F, text: "const kk = key;" } }),
      ).toEqual(["k", "kk"]);
    },
    SLOW,
  );

  test(
    "the fixture seeds and the local seed are not flagged: a name at 0 places, a member access, and an unchanged word set",
    async () => {
      for (const s of [ARCH, OMIT, SPARE]) expect(await names(s)).toEqual([]);
      expect(
        await names({
          kind: "local",
          path: "src/block.ts",
          find: "  for (const x of list) total += x;",
          replace: "  for (const x of list) total -= x;",
          anchor: { path: "src/block.ts", text: "for (const x of list) total -= x;" },
        }),
      ).toEqual([]);
    },
    SLOW,
  );

  test(
    "an import keeps its last name: flagged, also when other files have the name",
    async () => {
      const ts =
        'import {\n  rareHelper,\n  saveRecord,\n} from "./route";\nexport const run = (m: Map<string, number>) => rareHelper(m.size);\n';
      expect(
        await at(
          "src/x.ts",
          'export const run = (m: Map<string, number>) => saveRecord(m, "a", rareHelper(m.size));',
          "export const run = (m: Map<string, number>) => rareHelper(m.size);",
          ts,
        ),
      ).toEqual(["saveRecord"]);
      const py = "from lib import helper_one, helper_two\n\ndef run():\n    return helper_two()\n";
      expect(await at("src/x.py", "    return helper_one() + helper_two()", "    return helper_two()", py)).toEqual(["helper_one"]);
    },
    SLOW,
  );

  test(
    "not flagged: a name that other files have, a member access, a word in a string or a comment, and a name at two places",
    async () => {
      // return goes from 2 places to 1, and other files of the head have it.
      const ret = "export function f(n: number) {\n  return n;\n}\n";
      expect(await at("src/x.ts", "  if (n < 0) return 0;", "", ret)).toEqual([]);
      expect(
        await at(
          "src/x.ts",
          "  m.clear();",
          "  m.flushAllZebra();",
          "export const g = (m: Map<string, number>) => {\n  m.flushAllZebra();\n};\n",
        ),
      ).toEqual([]);
      expect(
        await at(
          "src/x.ts",
          '  log("a");',
          '  log("zebraword"); // zebranote',
          'const log = (s: string) => s;\n  log("zebraword"); // zebranote\n',
        ),
      ).toEqual([]);
      expect(
        await at("src/x.py", "    total = 1", "    zebra_total = 1", "def f():\n    zebra_total = 1\n    return zebra_total\n"),
      ).toEqual([]);
    },
    SLOW,
  );
});

describe("check 12: giveaway tokens (section 5.2, report only)", () => {
  const described = (description: string) => ({ repo: host.repo, file: { ...host.file, pr: { ...host.file.pr, description } } });

  test(
    "a removed code-like word, number, or string body in the PR description or the fold commit subject",
    async () => {
      const c1 = nat.commits[0] as string;
      expect(await giveaways(described("Apply writes through saveRecord."), ARCH, c1)).toEqual(["description"]);
      expect(await giveaways(host, ARCH, c1)).toEqual([]);
      // c3 has the subject "Raise o30 and o31 for the café".
      const o30 = { find: "export const o30 = 30 + 1;", replace: "export const o29 = 30 + 1;" };
      expect(await giveaways(host, o30, nat.commits[2] as string)).toEqual(["commit subject"]);
      const busy = { find: '  retry(25, "busy state");', replace: "  retry(5);" };
      expect(await giveaways(described("Retry 25 times."), busy, c1)).toEqual(["description"]);
      expect(await giveaways(described("It waits on a 'busy state' flag."), busy, c1)).toEqual(["description"]);
      // Plain lower-case words match English text, so they do not count. A token that replace keeps does not count.
      expect(await giveaways(described("The store is cleared."), { find: "  store.clear();", replace: "" }, c1)).toEqual([]);
      expect(await giveaways(described("Retry 25 times."), { find: "  retry(25);", replace: "  retry(25, 1);" }, c1)).toEqual([]);
    },
    SLOW,
  );
});

describe("history rewrite (section 5.3)", () => {
  // The lines of a commit object without tree, parent, and gpgsig.
  const rest = (raw: Buffer) => {
    const cut = raw.indexOf("\n\n");
    const head = raw
      .subarray(0, cut)
      .toString("latin1")
      .split("\n")
      // The fixture headers have no continuation lines but those of gpgsig.
      .filter((l) => !/^(tree|parent|gpgsig|gpgsig-sha256) /.test(l) && !l.startsWith(" "));
    return Buffer.concat([Buffer.from(head.join("\n"), "latin1"), raw.subarray(cut)]);
  };

  test("editCommit changes only tree and parent, and drops both signature headers", () => {
    const raw = Buffer.from(
      "tree a\nparent b\nparent c\nauthor x\ncommitter y\ngpgsig-sha256 s\n s2\n s3\nencoding ISO\ngpgsig q\n r\n\nmsg\n\n body\n",
    );
    expect(Buffer.from(editCommit(raw, "T", new Map([["b", "B"]]))).toString()).toBe(
      "tree T\nparent B\nparent c\nauthor x\ncommitter y\nencoding ISO\n\nmsg\n\n body\n",
    );
  });

  // The changed rows of each commit of a range against its parent, without line numbers: the patch that a reviewer reads.
  const patches = async (r: string, base: string, commits: string[]) => {
    const out: string[][] = [];
    for (const [k, c] of commits.entries()) {
      const files = parseDiff(await git(["diff", ...diffArgs, k ? (commits[k - 1] as string) : base, c], r));
      out.push(files.flatMap((f) => f.rows.filter((x) => x.kind !== "ctx").map((x) => `${f.path} ${x.kind} ${x.text}`)));
    }
    return out;
  };

  test(
    "the seed lands in the last commit that changed its lines, the raw text stays, every other commit keeps its patch, and diff(base, H') is diff(base, H) plus the seed",
    async () => {
      const r = host.repo;
      const a = (await checkSeed(host, ARCH)) as Checked;
      const o = (await checkSeed(host, OMIT)) as Checked;
      const folds = [
        { ...ARCH, ...a },
        { ...OMIT, ...o },
      ];
      const got = await rewriteHistory(r, nat.base, nat.head, folds);
      if (!got) throw new Error("no rewrite");
      const { head } = got;
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      // ARCH edits line 22, which c1 adds. c2 changes only line 45 of that file. OMIT edits line 31, which c3 changes last.
      expect(got.rules).toEqual(["lines", "lines"]);
      const { commits, merge } = await rangeOf(r, nat.base, head);
      expect(merge).toBe(false);
      expect(commits).toHaveLength(4);
      for (let k = 0; k < 4; k++) {
        expect(commits[k]).not.toBe(nat.commits[k] as string);
        const before = await gitIn(nat.env, r.dir, ["cat-file", "commit", nat.commits[k] as string]);
        const after = await gitIn(nat.env, r.dir, ["cat-file", "commit", commits[k] as string]);
        expect(rest(after).equals(rest(before))).toBe(true);
        expect(after.toString("latin1")).not.toContain("gpgsig");
        expect(after.toString("latin1")).toContain(`parent ${k ? commits[k - 1] : nat.base}\n`);
      }
      const signed = await gitIn(nat.env, r.dir, ["cat-file", "commit", nat.commits[1] as string]);
      expect(signed.toString("latin1")).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
      const latin = await gitIn(nat.env, r.dir, ["cat-file", "commit", commits[2] as string]);
      expect(latin.includes(Buffer.from("encoding ISO-8859-1\n"))).toBe(true);
      expect(latin.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true);
      // The seed is in the patch of c1 ("Add apply"), not in the patch of c2 ("Raise f45").
      const landed = await git(["diff", ...diffArgs, nat.base, commits[0] as string, "--", F], r.dir);
      expect(landed).toContain("\n+  store.set(k, v);\n");
      expect(landed).not.toContain("saveRecord(store, k, value)");
      const now = await patches(r.dir, nat.base, commits);
      const was = await patches(r.dir, nat.base, nat.commits);
      expect(now[1]).toEqual(was[1] as string[]);
      expect(now[1]).toEqual([`${F} del export const f45 = 45;`, `${F} add export const f45 = 45 + 1;`]);
      expect(now[3]).toEqual(was[3] as string[]);
      expect(now[2]).toEqual([`${PATHS.other} del export const o30 = 30;`, `${PATHS.other} add export const o30 = 30 + 1;`]);
      // The tree of H' is the tree of H with the two seeded blobs, so diff(base, H') is diff(base, H) plus the seed.
      const seeds = parseDiff(await git(["diff", ...diffArgs, nat.head, head], r.dir));
      expect(seeds.map((f) => [f.path, f.rows.filter((x) => x.kind !== "ctx").map((x) => `${x.kind} ${x.text}`)])).toEqual([
        [F, ["del   saveRecord(store, k, value);", "add   const v = value;", "add   store.set(k, v);"]],
        [PATHS.other, ["del export const o31 = 31 + 1;", "add export const o31 = 31;"]],
      ]);
      const others = [":(exclude)src/feature.ts", ":(exclude)src/other.ts"];
      expect(await git(["diff", ...diffArgs, nat.base, head, "--", ".", ...others], r.dir)).toBe(
        await git(["diff", ...diffArgs, nat.base, nat.head, "--", ".", ...others], r.dir),
      );
      // The rewrite is deterministic.
      expect(await rewriteHistory(r, nat.base, nat.head, folds)).toEqual(got);
    },
    SLOW,
  );

  test(
    "fallback near: a seed on lines from the merge base lands in the last commit that changed a line within 3 lines of it",
    async () => {
      const r = host.repo;
      // Line 19 is a base line. c1 adds lines 20 to 26, and c2 is the last commit on the file.
      const near = seedFields({
        kind: "local",
        path: F,
        find: "export const f19 = 19;",
        replace: "export const f19 = 20;",
        anchor: { path: F, text: "export const f19 = 20;" },
      });
      const c = (await checkSeed(host, near)) as Checked;
      expect(c).not.toHaveProperty("check");
      const got = await rewriteHistory(r, nat.base, nat.head, [{ ...near, ...c }]);
      if (!got) throw new Error("no rewrite");
      expect(got.rules).toEqual(["near"]);
      const { commits } = await rangeOf(r, nat.base, got.head);
      expect(await git(["log", "--format=%H", "-G", "f19 = 20", got.head], r.dir)).toBe(commits[0] as string);
      const now = await patches(r.dir, nat.base, commits);
      const was = await patches(r.dir, nat.base, nat.commits);
      for (const k of [1, 2, 3]) expect(now[k]).toEqual(was[k] as string[]);
    },
    SLOW,
  );

  test(
    "fallback file: when the find text is not unique in the commit that changed its lines, the seed lands in the last commit on the file",
    async () => {
      // A small repository: c1 adds "  run();" twice, and c2 removes the second copy. Blame gives c1, but find is not unique there.
      const dir = join(TMP, "dup.git");
      const env = nat.env;
      await gitIn(env, null, ["init", "-q", "--bare", "--template=", dir]);
      const ix = { ...env, GIT_INDEX_FILE: join(TMP, "dup.index") };
      const text = (lines: string[]) => `${lines.join("\n")}\n`;
      const body = Array.from({ length: 40 }, (_, k) => `const v${k + 1} = ${k + 1};`);
      const commit = async (parent: string | null, file: string, msg: string) => {
        const sha = (await gitIn(env, dir, ["hash-object", "-w", "--stdin"], file)).toString().trim();
        await gitIn(ix, dir, ["read-tree", "--empty"]);
        await gitIn(ix, dir, ["update-index", "--add", "--cacheinfo", `100644,${sha},src/dup.ts`]);
        const tree = (await gitIn(ix, dir, ["write-tree"])).toString().trim();
        return (await gitIn(env, dir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg])).toString().trim();
      };
      const base = await commit(null, text(body), "base");
      const withRun = (lines: string[], at: number[]) => lines.flatMap((l, k) => (at.includes(k + 1) ? [l, "  run();"] : [l]));
      const c1 = await commit(base, text(withRun(body, [5, 30])), "Add run");
      const c2 = await commit(c1, text(withRun(body, [5])), "Remove the second run");
      const headText = text(withRun(body, [5]));
      const s = { path: "src/dup.ts", find: "  run();", replace: "  stop();" };
      const applied = applySeed(headText, s) as { text: string; start: number; end: number };
      const seeded = (await gitIn(env, dir, ["hash-object", "-w", "--stdin"], applied.text)).toString().trim();
      const repo = { dir, env, index: join(TMP, "dup-rewrite.index") };
      const fold = { ...s, mode: "100644", seeded, region: [applied.start, applied.end] as [number, number] };
      const got = await rewriteHistory(repo, base, c2, [fold]);
      if (!got) throw new Error("no rewrite");
      expect(got.rules).toEqual(["file"]);
      const { commits } = await rangeOf(repo, base, got.head);
      expect(commits[0]).toBe(c1);
      expect(await git(["log", "--format=%H", "-G", "stop", got.head], dir)).toBe(commits[1] as string);
    },
    SLOW,
  );

  test(
    "a range with a merge commit takes no seed",
    async () => {
      expect((await rangeOf(mergeHost.repo, nat.base, nat.mergeHead)).merge).toBe(true);
      const blob = await git(["rev-parse", `${nat.mergeHead}:${PATHS.other}`]);
      const fold = { ...OMIT, find: "export const o5 = 5 + 1;", mode: "100644", seeded: blob, region: [5, 5] as [number, number] };
      expect(await rewriteHistory(mergeHost.repo, nat.base, nat.mergeHead, [fold])).toBeNull();
    },
    SLOW,
  );
});

describe("seeded set build (sections 6.1 and 8)", () => {
  const seeds = () => join(TMP, "seeds");
  const set = () => join(seeds(), "set");
  let first: SeedBuild;
  let headP: string;
  const files = (dir: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => statSync(join(dir, f)).isFile())
        .sort()
        .map((f) => [
          f.replaceAll("\\", "/"),
          createHash("sha256")
            .update(readFileSync(join(dir, f)))
            .digest("hex"),
        ]),
    );

  beforeAll(async () => {
    const bind = async (h: Host, path: string) => (await bindingOf(h, path)) as SeedRecord["host"];
    const d = {
      ...OMIT,
      find: "export const o5 = 5 + 1;",
      replace: "export const o5 = 5;",
      anchor: { path: PATHS.other, text: "export const o4 = 4;" },
    };
    saveStore(seeds(), {
      format: 1,
      seeds: [
        keptSeed("sd00000000a1", ARCH, await bind(host, F)),
        keptSeed("sd00000000a2", OMIT, await bind(host, PATHS.other)),
        keptSeed("sd00000000a3", SPARE, await bind(host, F)),
        keptSeed("sd00000000a4", d, await bind(mergeHost, PATHS.other)),
        { ...keptSeed("sd00000000a5", SPARE, await bind(host, F)), state: "confirmed" },
      ],
    });
    first = (await buildSeededSet({ seeds: seeds(), local: nat.dir })) as SeedBuild;
    headP = (loadCases("all", join(set(), "cases"))[0]?.local?.head ?? "") as string;
  }, SLOW);

  test("MANIFEST.json has the Manifest shape and the seeded key, and stdout is counts only", () => {
    expect(first).not.toHaveProperty("refused");
    const m = JSON.parse(readFileSync(join(set(), "MANIFEST.json"), "utf8")) as SeededManifest;
    expect(m).toEqual(first.manifest);
    const hostText = readFileSync(join(nat.dir, "cases", nat.host, "case.json"), "utf8");
    expect(m.seeded).toEqual({
      seeds: 2,
      byKind: Object.fromEntries(SEED_KINDS.map((k) => [k, k === "architecture" || k === "omission" ? 1 : 0])) as SeededInfo["byKind"],
      hosts: 1,
      // The second seed on src/feature.ts, and the seed of the merge host.
      spares: 2,
      mergeHosts: 1,
      hostFingerprint: setFingerprint([{ id: nat.host, hash: createHash("sha256").update(hostText).digest("hex") }]),
      seedsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      folds: { sd00000000a1: "lines", sd00000000a2: "lines" },
    });
    expect(m.counts).toEqual({ cases: 1, runs: 0, repositories: 1, bugs: 2, traps: 1, extras: 4, human: 0 });
    expect(m.rereview.counts.cases).toBe(0);
    expect(m.threads).toMatchObject({ cases: 1, threads: 4, comments: 5, overlap: 2 });
    const text = buildText(first);
    expect(text).toContain("Seeded set: 1 cases with 2 seeds. Spare kept seeds: 2. Hosts with a merge commit, left out: 1.");
    expect(text).toContain("Folds: lines 2, near 0, file 0.");
    // The floor counts kept seeds, spares included: omission has 2 (one on the merge host), but 1 in the set.
    expect(first.kept).toEqual(
      Object.fromEntries(
        SEED_KINDS.map((k) => [k, k === "omission" ? 2 : k === "architecture" || k === "lifetime" ? 1 : 0]),
      ) as SeededInfo["byKind"],
    );
    expect(text).toContain(
      "Kept seeds by kind: lifetime 1, contract 0, omission 2, entry 0, concurrency 0, leak 0, error 0, architecture 1, local 0.",
    );
    expect(text).toContain("Kinds under the floor of 4 kept seeds: lifetime, contract, omission, entry, concurrency, leak, error, local.");
    expect(text.split("\n")).toContain("kind architecture: under floor");
    expect(text).toContain(`Pilot cases: ${caseId({ pr: 7, head: headP, base: nat.base })}.`);
    for (const secret of ["src/", "saveRecord", "Zebra", "sd00000000"]) expect(text).not.toContain(secret);
  });

  test("the case ID follows H', and the case passes localCaseFile with seeded bugs", () => {
    const [c] = loadCases("all", join(set(), "cases"));
    const id = caseId({ pr: 7, head: headP, base: nat.base });
    expect(c?.id).toBe(id);
    expect(id).not.toBe(nat.host);
    expect(headP).not.toBe(nat.head);
    const text = readFileSync(join(set(), "cases", id, "case.json"), "utf8");
    expect(`${JSON.stringify(localCaseFile.parse(JSON.parse(text)), null, 2)}\n`).toBe(text);
    expect(c?.bugs).toEqual([
      {
        id: "S1",
        path: F,
        side: "new",
        lines: [23, 23],
        alt: [{ path: PATHS.route, side: "new", lines: [3, 3] }],
        severityMin: "major",
        module: "core",
        note: "Seeded architecture defect.",
        text: ARCH.comment,
        source: "seeded",
        seedKind: "architecture",
      },
      {
        id: "S2",
        path: PATHS.other,
        side: "new",
        lines: [30, 30],
        severityMin: "major",
        module: "api",
        note: "Seeded omission defect.",
        text: OMIT.comment,
        category: "behavior",
        source: "seeded",
        seedKind: "omission",
      },
    ]);
    expect(c?.human).toEqual([]);
    expect(c?.clean).toBeUndefined();
    expect(c?.local).toMatchObject({ base: nat.base, head: headP });
    expect(c?.pr.title).toBe("Add apply to the store");
    expect(c?.group).toBe("pr7");
    // Section 7, case fields: the fields that reach the run equal those of the host.
    const host = JSON.parse(readFileSync(join(nat.dir, "cases", nat.host, "case.json"), "utf8")) as Record<string, unknown>;
    const seeded = JSON.parse(text) as Record<string, unknown>;
    for (const k of ["title", "language", "pr", "task", "instructions", "tasks", "group", "hasTask", "rules"])
      expect(seeded[k]).toEqual(host[k]);
  });

  test("natural items and alt places remap, and threads remap or drop", () => {
    const [c] = loadCases("all", join(set(), "cases"));
    const spot = (x: { path: string; side: string; lines: number[] }) => `${x.path} ${x.side} ${x.lines.join("-")}`;
    // ARCH turns one line of src/feature.ts into two, so the natural new-side lines after it move by one.
    expect(c?.extras?.map((x) => [spot(x), x.source])).toEqual([
      ["src/other.ts new 12-12", "other"],
      ["src/feature.ts new 46-46", "posted"],
      ["src/other.ts new 11-11", "posted"],
      ["src/other.ts new 38-38", "own"],
    ]);
    expect(c?.traps.map(spot)).toEqual(["src/feature.ts new 53-53"]);
    const t = c?.threads ?? [];
    expect(t.map((x) => x.id)).toEqual([1, 2, 5, 6, 7]);
    expect(t.find((x) => x.id === 1)?.lines).toEqual([41, 41]);
    expect(t.find((x) => x.id === 6)).toMatchObject({ side: "old", lines: [3, 3] });
    expect(t.find((x) => x.id === 7)).toMatchObject({ side: "old", lines: [55, 55], newPlace: { path: F, lines: [56, 56] } });
    expect(t.find((x) => x.id === 5)).toMatchObject({ path: PATHS.other });
  });

  test(
    "the bundle holds only the merge base and H', and no object of the original head",
    async () => {
      const [bundle] = readdirSync(join(set(), "bundles"));
      const file = join(set(), "bundles", bundle as string);
      const heads = (await gitIn(nat.env, null, ["bundle", "list-heads", file])).toString("utf8").trim().split("\n").sort();
      expect(heads).toEqual([`${nat.base} refs/eval/${nat.base}`, `${headP} refs/eval/${headP}`].sort());
      const fresh = join(TMP, "fresh.git");
      await gitIn(nat.env, null, ["init", "-q", "--bare", "--template=", fresh]);
      await gitIn(nat.env, fresh, ["fetch", "-q", "--no-tags", file, "+refs/*:refs/*"]);
      const all = (await gitIn(nat.env, fresh, ["rev-list", "--all"])).toString("utf8");
      expect(all).toContain(headP);
      for (const c of nat.commits.slice(1)) expect(all).not.toContain(c);
      await expect(gitIn(nat.env, fresh, ["cat-file", "-e", nat.head])).rejects.toThrow();
      expect(bundle).toBe(`${createHash("sha256").update(`seeded ${headP}`).digest("hex").slice(0, 16)}.bundle`);
    },
    SLOW,
  );

  test(
    "two builds give one fingerprint, and the build keeps labels/",
    async () => {
      const id = caseId({ pr: 7, head: headP, base: nat.base });
      const text = readFileSync(join(set(), "cases", id, "case.json"), "utf8");
      mkdirSync(join(set(), "labels"));
      writeFileSync(join(set(), "labels", "x.json"), "{}");
      const again = (await buildSeededSet({ seeds: seeds(), local: nat.dir })) as SeedBuild;
      expect(again.manifest.fingerprint).toBe(first.manifest.fingerprint);
      expect(again.manifest.seeded).toEqual(first.manifest.seeded);
      expect(readFileSync(join(set(), "cases", id, "case.json"), "utf8")).toBe(text);
      expect(readFileSync(join(set(), "labels", "x.json"), "utf8")).toBe("{}");
      expect(readdirSync(seeds()).sort()).toEqual(["seeds.json", "set"]);
    },
    SLOW,
  );

  test(
    "a host that changes makes its bound seeds stale, and the same host brings them back",
    async () => {
      const away = join(TMP, "away");
      renameSync(join(nat.dir, "cases", nat.host), away);
      const gone = (await buildSeededSet({ seeds: seeds(), local: nat.dir })) as SeedBuild;
      expect(gone).toMatchObject({ stale: 4, restored: 0 });
      expect(gone.manifest.counts.cases).toBe(0);
      const states = loadStore(seeds()).seeds.map((s) => [s.state, s.was]);
      expect(states).toEqual([
        ["stale", "kept"],
        ["stale", "kept"],
        ["stale", "kept"],
        ["kept", undefined],
        ["stale", "confirmed"],
      ]);
      renameSync(away, join(nat.dir, "cases", nat.host));
      const back = (await buildSeededSet({ seeds: seeds(), local: nat.dir })) as SeedBuild;
      expect(back).toMatchObject({ stale: 0, restored: 4 });
      expect(back.manifest.fingerprint).toBe(first.manifest.fingerprint);
      expect(loadStore(seeds()).seeds.map((s) => s.state)).toEqual(["kept", "kept", "kept", "kept", "confirmed"]);
    },
    SLOW,
  );

  test(
    "a kept seed that fails a check stops the build, and the set stays as it was",
    async () => {
      const before = files(set());
      const store = loadStore(seeds());
      saveStore(seeds(), { ...store, seeds: store.seeds.map((s, k) => (k === 0 ? { ...s, find: "  nothing here;" } : s)) });
      await expect(buildSeededSet({ seeds: seeds(), local: nat.dir })).rejects.toThrow(
        "Seed sd00000000a1 fails check 1: find occurs 0 times as whole lines. It must occur once.",
      );
      expect(files(set())).toEqual(before);
      expect(readdirSync(seeds()).sort()).toEqual(["seeds.json", "set"]);
      saveStore(seeds(), store);
    },
    SLOW,
  );

  test("the build refuses a root that git does not ignore, a set folder with other files, and a seeded natural set", async () => {
    // No natural set: a build past a broken guard stops at the next refusal and writes nothing into the repository.
    expect(await buildSeededSet({ seeds: join(ROOT, "scripts", "seeds-not-ignored"), local: join(TMP, "no-natural") })).toEqual({
      refused: "Refused: the seeds folder is inside this repository, and git does not ignore it. Use eval-seeds/ or a folder outside it.",
    });
    expect(existsSync(join(ROOT, "scripts", "seeds-not-ignored"))).toBe(false);
    const other = join(TMP, "other-seeds");
    mkdirSync(join(other, "set"), { recursive: true });
    writeFileSync(join(other, "set", "notes.txt"), "x");
    expect(await buildSeededSet({ seeds: other, local: nat.dir })).toEqual({
      refused: "Refused: the set folder holds other files. Remove them first.",
    });
    expect(await buildSeededSet({ seeds: other, local: set() })).toEqual({
      refused: "The natural set folder holds a seeded set. Point REVIEW_LOOP_EVAL_LOCAL at the natural set.",
    });
  });
});

describe("twin hosts and the build kind (sections 4.2 and 8)", () => {
  test(
    "twins give one case on the lower case ID: the same edit on both is one seed and one spare, a twin seed that fails check 6 there is a spare, and the label is the build kind",
    async () => {
      const fx = await makeNaturalSet(join(TMP, "fx-twin"));
      const twin = addTwin(fx, fx.host, 9);
      mkdirSync(join(TMP, "hosts-twin"));
      const open = hostsOf(fx.dir, join(TMP, "hosts-twin"));
      const a = (await open(fx.host)) as Host;
      const b = (await open(twin)) as Host;
      expect([a.base, a.head]).toEqual([b.base, b.head]);
      // The twin case has no natural items. The comment of the host at line 38 lies within 6 lines of o33.
      const near = seedFields({
        kind: "local",
        path: PATHS.other,
        find: "export const o33 = 33;",
        replace: "export const o33 = 34;",
        anchor: { path: PATHS.other, text: "export const o33 = 34;" },
      });
      expect(await checkSeed(b, near)).not.toHaveProperty("check");
      expect(await checkSeed(a, near)).toMatchObject({ check: 6 });
      const bind = async (h: Host, path: string) => (await bindingOf(h, path)) as SeedRecord["host"];
      const root = join(TMP, "seeds-twin");
      saveStore(root, {
        format: 1,
        seeds: [
          { ...keptSeed("sd00000000c1", ARCH, await bind(a, F)), label: "contract" },
          keptSeed("sd00000000c2", ARCH, await bind(b, F)),
          keptSeed("sd00000000c3", near, await bind(b, PATHS.other)),
        ],
      });
      const got = (await buildSeededSet({ seeds: root, local: fx.dir })) as SeedBuild;
      expect(got).not.toHaveProperty("refused");
      expect(got.manifest.seeded).toMatchObject({ seeds: 1, hosts: 1, spares: 2, mergeHosts: 0 });
      expect(got.manifest.seeded.byKind).toMatchObject({ contract: 1, architecture: 0, local: 0 });
      expect(got.kept).toMatchObject({ contract: 1, architecture: 1, local: 1 });
      const [id] = readdirSync(join(root, "set", "cases"));
      const file = localCaseFile.parse(JSON.parse(readFileSync(join(root, "set", "cases", id as string, "case.json"), "utf8")));
      expect(file.group).toBe("pr7");
      expect(file.bugs).toHaveLength(1);
      expect(file.bugs[0]).toMatchObject({ seedKind: "contract", module: "api", note: "Seeded contract defect." });
    },
    SLOW,
  );
});
