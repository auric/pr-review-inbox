// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Project instructions: source detection, @path imports, caps, and the combined text. Temp folders and a temp bare repository only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git, gitEnv } from "../../src/server/review/git";
import {
  buildInstructions,
  changedFolders,
  cloneReader,
  codeRanges,
  configReader,
  FILE_CAP,
  INSTRUCTIONS_TRUST,
  projectInstructions,
  saveInstructionSettings,
  scan,
  TOTAL_CAP,
  treeReader,
} from "../../src/server/review/instructions";
import { openDb } from "../../src/server/storage/db";

const root = mkdtempSync(join(tmpdir(), "rl-instr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

function clone(files: Record<string, string | Uint8Array>) {
  const dir = join(root, `clone-${n++}`);
  for (const [p, v] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), v);
  }
  return dir;
}

const local = (dir: string, files: string[], extra = "") =>
  buildInstructions({ target: null, clone: cloneReader(dir), local: files, extra });

describe("scan", () => {
  test("finds imports outside code and puts every import token into a code span", () => {
    const text = [
      "See @README and @docs/a.md.",
      "Mail me at a@example.test.",
      "Skip `@inline` here.",
      "```",
      "@fenced",
      "```",
      "@Design\\ Docs/x.md",
    ].join("\n");
    const s = scan(text);
    expect(s.imports).toEqual(["docs/a.md.", "Design Docs/x.md"]);
    expect(s.text).toContain("See `@README` and `@docs/a.md.`\n");
    expect(s.text).toContain("a@example.test");
    expect(s.text).toContain("Skip `@inline` here.");
    expect(s.text).toContain("```\n@fenced\n```");
    expect(s.text).toContain("`@Design\\ Docs/x.md`");
    // Nothing outside code is left that Claude Code reads as an import.
    expect(scan(s.text).imports).toEqual([]);
  });

  test("an unclosed fence runs to the end; an unmatched backtick is literal; a span stops at a blank line", () => {
    expect(scan("```\n@a").imports).toEqual([]);
    expect(scan("a ` @b.md").imports).toEqual(["b.md"]);
    expect(scan("x ` y\n\n@c.md ` z").imports).toEqual(["c.md"]);
  });

  test("only a token that looks like a path is an import; other tokens stay text in a code span", () => {
    const s = scan("Ask @someone and @team. See @README, @v2, @docs/x, @a\\b, @./c, @../d, @~/e, and @notes.md");
    expect(s.imports).toEqual(["docs/x,", "a\\b,", "./c,", "../d,", "~/e,", "notes.md"]);
    expect(s.text).toContain("Ask `@someone` and `@team.` See `@README,` `@v2,`");
    expect(codeRanges("a `b` c")).toEqual([[2, 5]]);
  });
});

describe("clone files", () => {
  test("detects the ticked files, resolves imports relative to the importing file, and adds headers in order", async () => {
    const dir = clone({
      "CLAUDE.md": "Root rules. Read @docs/a.md\n",
      "docs/a.md": "A rules. See @b.md\n",
      "docs/b.md": "B rules.\n",
      "CLAUDE.local.md": "Local rules.\n",
      ".claude/CLAUDE.md": "Not ticked.\n",
    });
    const b = await local(dir, ["CLAUDE.md", "CLAUDE.local.md"], "Extra text.");
    expect(b.notLoaded).toEqual([]);
    expect(b.files.map((f) => [f.source, f.path])).toEqual([
      ["clone", "CLAUDE.md"],
      ["clone", "docs/a.md"],
      ["clone", "docs/b.md"],
      ["clone", "CLAUDE.local.md"],
      ["settings", ""],
    ]);
    const heads = [
      "## From your clone: CLAUDE.md",
      "## From your clone: docs/a.md (imported by CLAUDE.md)",
      "## From your clone: docs/b.md (imported by docs/a.md)",
      "## From your clone: CLAUDE.local.md",
      "## From PR Review Inbox settings",
    ];
    const at = heads.map((h) => b.text.indexOf(h));
    expect(at.every((i, k) => i > (at[k - 1] ?? -1))).toBe(true);
    expect(b.text).toContain("Read `@docs/a.md`");
    expect(b.text).not.toContain("Not ticked.");
    expect(b.bytes).toBe(b.files.reduce((s, f) => s + f.bytes, 0));
  });

  test("a missing, escaping, binary, oversized, or cyclic import is a gap and stays out", async () => {
    const dir = clone({
      "CLAUDE.md": "@nope.md @../outside.md @~/home.md @bin.dat @big.md @c1.md\n",
      "bin.dat": new Uint8Array([0x61, 0, 0x62]),
      "big.md": "x".repeat(FILE_CAP + 1),
      "c1.md": "@c2.md\n",
      "c2.md": "@c1.md\n",
    });
    writeFileSync(join(dirname(dir), "outside.md"), "OUTSIDE-CANARY");
    const b = await local(dir, ["CLAUDE.md"]);
    expect(b.files.map((f) => f.path)).toEqual(["CLAUDE.md", "c1.md", "c2.md"]);
    expect(b.text).not.toContain("OUTSIDE-CANARY");
    const g = b.notLoaded.join("\n");
    expect(g).toContain("@nope.md, imported by CLAUDE.md from your clone (the file does not exist)");
    expect(g).toContain("@../outside.md, imported by CLAUDE.md from your clone (the path is outside the clone)");
    expect(g).toContain("@~/home.md");
    expect(g).toContain("@bin.dat, imported by CLAUDE.md from your clone (the file is not UTF-8 text)");
    expect(g).toContain("@big.md, imported by CLAUDE.md from your clone (the file is over 64 KB)");
    expect(g).toContain("@c1.md, imported by c2.md from your clone (an import cycle)");
  });

  test("imports nest at most four hops", async () => {
    const dir = clone({
      "CLAUDE.md": "@l1.md",
      "l1.md": "@l2.md",
      "l2.md": "@l3.md",
      "l3.md": "@l4.md",
      "l4.md": "@l5.md",
      "l5.md": "five",
    });
    const b = await local(dir, ["CLAUDE.md"]);
    expect(b.files.map((f) => f.path)).toEqual(["CLAUDE.md", "l1.md", "l2.md", "l3.md", "l4.md"]);
    expect(b.notLoaded).toEqual(["@l5.md, imported by l4.md from your clone (more than 4 import levels)"]);
  });

  test("the total stops at the prompt cap of 120,000 bytes", async () => {
    expect(TOTAL_CAP).toBe(120_000);
    const big = "y".repeat(FILE_CAP - 10);
    const files: Record<string, string> = { "CLAUDE.md": "@p1.md @p2.md @p3.md", "p3.md": "small" };
    for (let i = 1; i <= 2; i++) files[`p${i}.md`] = big;
    const b = await local(clone(files), ["CLAUDE.md"]);
    expect(b.bytes).toBeLessThanOrEqual(TOTAL_CAP);
    expect(b.files.map((f) => f.path)).toEqual(["CLAUDE.md", "p1.md", "p3.md"]);
    expect(b.notLoaded).toEqual(["@p2.md, imported by CLAUDE.md from your clone (the instructions are over 120,000 bytes)"]);
    expect(b.text).toContain("small");
  });

  test("a link out of the clone does not load", async () => {
    const dir = clone({ "CLAUDE.md": "@link.md" });
    writeFileSync(join(root, "secret.md"), "SECRET-CANARY");
    try {
      symlinkSync(join(root, "secret.md"), join(dir, "link.md"), "file");
    } catch {
      // Windows without the link privilege. The path check covers the rest.
      return;
    }
    const b = await local(dir, ["CLAUDE.md"]);
    expect(b.text).not.toContain("SECRET-CANARY");
    expect(b.notLoaded.join("\n")).toContain("a link points outside the clone");
  });

  test("a ticked file that is gone, and ticked files without a clone, are not loaded", async () => {
    const b = await local(clone({ "CLAUDE.md": "x" }), ["CLAUDE.local.md"]);
    expect(b.notLoaded).toEqual(["CLAUDE.local.md from your clone (the file does not exist)"]);
    expect(b.text).toBe("");
    const none = await buildInstructions({ target: null, clone: null, local: ["CLAUDE.md"], extra: "" });
    expect(none.notLoaded).toEqual(["CLAUDE.md (no clone folder is set)"]);
  });
});

describe("target branch", () => {
  test("reads CLAUDE.md and its imports from the commit; a tree link and a missing import are not loaded", async () => {
    const dir = join(root, "tree");
    mkdirSync(dir);
    const empty = join(dir, "empty.gitconfig");
    writeFileSync(empty, "");
    const bare = join(dir, "repo.git");
    const env = {
      ...gitEnv(empty),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_INDEX_FILE: join(dir, "index"),
    };
    const g = async (args: string[], stdin?: string) => (await git(["--git-dir", bare, ...args], { env, stdin })).trim();
    await git(["init", "-q", "--bare", "--template=", bare], { env });
    const blob = (text: string) => g(["hash-object", "-w", "--stdin"], text);
    const entries = [
      `100644 ${await blob("Target rules. @docs/rules.md @link.md @gone.md\n")}\tCLAUDE.md`,
      `100644 ${await blob("Rules file.\n")}\tdocs/rules.md`,
      `120000 ${await blob("docs/rules.md")}\tlink.md`,
    ];
    await g(["update-index", "--add", "--index-info"], `${entries.join("\n")}\n`);
    const commit = await g(["commit-tree", await g(["write-tree"]), "-m", "target"]);
    const b = await buildInstructions({ target: treeReader(bare, env, commit), clone: null, local: [], extra: "" });
    expect(b.files.map((f) => [f.source, f.path])).toEqual([
      ["target", "CLAUDE.md"],
      ["target", "docs/rules.md"],
    ]);
    expect(b.text).toContain("## From the target branch: CLAUDE.md");
    expect(b.text).toContain("Rules file.");
    expect(b.notLoaded).toEqual([
      "@link.md, imported by CLAUDE.md from the target branch (the path is a link)",
      "@gone.md, imported by CLAUDE.md from the target branch (the file does not exist)",
    ]);
    // A missing root file on the target branch is no gap.
    const bad = await buildInstructions({ target: treeReader(bare, env, "0".repeat(40)), clone: null, local: [], extra: "" });
    expect(bad.files).toEqual([]);
    expect(bad.notLoaded[0]).toContain("the app cannot read the target branch commit");
  });

  // docs/plans/review-v3.md section 5, the "rules2" variant: REVIEW.md at the repository root, with the CLAUDE.md caps and trust line.
  test("review reads REVIEW.md at the root after the root CLAUDE.md files, with the same caps; off reads none", async () => {
    const dir = join(root, "review-md");
    mkdirSync(dir);
    const empty = join(dir, "empty.gitconfig");
    writeFileSync(empty, "");
    const bare = join(dir, "repo.git");
    const env = {
      ...gitEnv(empty),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_INDEX_FILE: join(dir, "index"),
    };
    const g = async (args: string[], stdin?: string) => (await git(["--git-dir", bare, ...args], { env, stdin })).trim();
    await git(["init", "-q", "--bare", "--template=", bare], { env });
    const commitOf = async (files: Record<string, string>) => {
      const entries: string[] = [];
      for (const [p, text] of Object.entries(files)) entries.push(`100644 ${await g(["hash-object", "-w", "--stdin"], text)}\t${p}`);
      await g(["read-tree", "--empty"]);
      await g(["update-index", "--add", "--index-info"], `${entries.join("\n")}\n`);
      return g(["commit-tree", await g(["write-tree"]), "-m", "target"]);
    };
    const commit = await commitOf({
      "CLAUDE.md": "Root rules.\n",
      "REVIEW.md": "Review rules. @docs/review-extra.md\n",
      "docs/review-extra.md": "Extra review rules.\n",
      "sub/REVIEW.md": "Nested review rules.\n",
      "sub/CLAUDE.md": "Sub rules.\n",
    });
    const read = (review: boolean) =>
      buildInstructions({ target: treeReader(bare, env, commit), scoped: ["sub"], review, clone: null, local: [], extra: "" });
    const off = await read(false);
    expect(off.files.map((f) => f.path)).toEqual(["CLAUDE.md", "sub/CLAUDE.md"]);
    expect(off.text).not.toContain("Review rules.");
    const on = await read(true);
    expect(on.files.map((f) => f.path)).toEqual(["CLAUDE.md", "REVIEW.md", "docs/review-extra.md", "sub/CLAUDE.md"]);
    expect(on.text.startsWith(`# Project instructions\n\n${INSTRUCTIONS_TRUST}\n\n`)).toBe(true);
    expect(on.text.split(INSTRUCTIONS_TRUST).length).toBe(2);
    expect(on.text).toContain("## From the target branch: REVIEW.md (applies to all files)\n\nReview rules. `@docs/review-extra.md`\n");
    expect(on.text).not.toContain("Nested review rules.");
    expect(on.sources.map((s) => s.text)).toContain("Review rules. `@docs/review-extra.md`\n");
    expect(on.bytes).toBe(
      off.bytes + Buffer.byteLength("Review rules. @docs/review-extra.md\n") + Buffer.byteLength("Extra review rules.\n"),
    );
    // A REVIEW.md without CLAUDE.md loads alone. A missing REVIEW.md is no gap.
    const only = await commitOf({ "REVIEW.md": "Only review rules.\n" });
    const alone = await buildInstructions({ target: treeReader(bare, env, only), review: true, clone: null, local: [], extra: "" });
    expect(alone.files.map((f) => f.path)).toEqual(["REVIEW.md"]);
    const none = await commitOf({ "CLAUDE.md": "Root rules.\n" });
    const missing = await buildInstructions({ target: treeReader(bare, env, none), review: true, clone: null, local: [], extra: "" });
    expect(missing.notLoaded).toEqual([]);
    // FILE_CAP and TOTAL_CAP apply as for CLAUDE.md.
    const big = await commitOf({ "CLAUDE.md": "Root rules.\n", "REVIEW.md": "x".repeat(FILE_CAP + 1) });
    const over = await buildInstructions({ target: treeReader(bare, env, big), review: true, clone: null, local: [], extra: "" });
    expect(over.files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
    expect(over.notLoaded).toEqual([`REVIEW.md from the target branch (the file is over ${FILE_CAP / 1024} KB)`]);
    const first = FILE_CAP - 10;
    const full = await commitOf({ "CLAUDE.md": "c".repeat(first), "REVIEW.md": "r".repeat(TOTAL_CAP - first + 1) });
    const capped = await buildInstructions({ target: treeReader(bare, env, full), review: true, clone: null, local: [], extra: "" });
    expect(capped.files.map((f) => f.path)).toEqual(["CLAUDE.md"]);
    expect(capped.notLoaded).toEqual([
      `REVIEW.md from the target branch (the instructions are over ${TOTAL_CAP.toLocaleString("en-US")} bytes)`,
    ]);
  }, 60_000);
});

// docs/plans/review-v2/spec.md section 1.3: the CLAUDE.md files of the changed folders, with a scope header.
describe("changed folders", () => {
  // A bare repository with one commit. A { link } entry is a symbolic link.
  async function tree(name: string, files: Record<string, string | { link: string }>) {
    const dir = join(root, name);
    mkdirSync(dir);
    const empty = join(dir, "empty.gitconfig");
    writeFileSync(empty, "");
    const bare = join(dir, "repo.git");
    const env = {
      ...gitEnv(empty),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_INDEX_FILE: join(dir, "index"),
    };
    const g = async (args: string[], stdin?: string) => (await git(["--git-dir", bare, ...args], { env, stdin })).trim();
    await git(["init", "-q", "--bare", "--template=", bare], { env });
    const entries: string[] = [];
    for (const [path, v] of Object.entries(files)) {
      const sha = await g(["hash-object", "-w", "--stdin"], typeof v === "string" ? v : v.link);
      entries.push(`${typeof v === "string" ? "100644" : "120000"} ${sha}\t${path}`);
    }
    await g(["update-index", "--add", "--index-info"], `${entries.join("\n")}\n`);
    return { bare, env, commit: await g(["commit-tree", await g(["write-tree"]), "-m", "target"]) };
  }

  test("a change in src/server/ loads src/server/CLAUDE.md of the target head and not web/CLAUDE.md, root first, with scopes", async () => {
    const t = await tree("scoped", {
      "CLAUDE.md": "ROOT-RULES\n",
      "src/CLAUDE.md": "SRC-RULES. @../docs/locks.md\n",
      "src/server/CLAUDE.md": "SERVER-RULES\n",
      "src/server/review/jobs.ts": "x\n",
      "src/other/CLAUDE.md": "OTHER-RULES\n",
      "web/CLAUDE.md": "WEB-RULES\n",
      "docs/locks.md": "LOCK-RULES\n",
      "srcx/CLAUDE.md": "PREFIX-RULES\n",
    });
    const scoped = await changedFolders(t.bare, t.env, t.commit, ["src/server/review/jobs.ts", "src/server/gone.ts", "README.md"]);
    expect(scoped).toEqual(["src", "src/server"]);
    const db = openDb(":memory:");
    const k = { project: "P", repo: "r" };
    const b = await projectInstructions(db, k, { cache: t.bare, env: t.env, commit: t.commit, paths: ["src/server/review/jobs.ts"] });
    expect(b.files).toEqual([
      { source: "target", path: "CLAUDE.md", bytes: 11 },
      { source: "target", path: "src/CLAUDE.md", bytes: 29, scope: "src" },
      { source: "target", path: "docs/locks.md", bytes: 11, scope: "src" },
      { source: "target", path: "src/server/CLAUDE.md", bytes: 13, scope: "src/server" },
    ]);
    const heads = b.text.split("\n").filter((l) => l.startsWith("## "));
    expect(heads).toEqual([
      "## From the target branch: CLAUDE.md (applies to all files)",
      "## From the target branch: src/CLAUDE.md (applies to src/**)",
      "## From the target branch: docs/locks.md (imported by src/CLAUDE.md) (applies to src/**)",
      "## From the target branch: src/server/CLAUDE.md (applies to src/server/**)",
    ]);
    for (const gone of ["WEB-RULES", "OTHER-RULES", "PREFIX-RULES"]) expect(b.text).not.toContain(gone);
    expect(b.notLoaded).toEqual([]);
    // No changed path, the target switch off, or a preview without paths: no scoped file.
    expect((await projectInstructions(db, k, { cache: t.bare, env: t.env, commit: t.commit })).files.map((f) => f.path)).toEqual([
      "CLAUDE.md",
    ]);
    saveInstructionSettings(db, k, { target: false, local: [], extra: "" });
    expect((await projectInstructions(db, k, { cache: t.bare, env: t.env, commit: t.commit, paths: ["src/server/a.ts"] })).files).toEqual(
      [],
    );
    db.close();
  });

  test("a linked or oversized folder file is a gap; the caps and the shared imports hold; a bad commit gives no folder", async () => {
    const t = await tree("scoped-gaps", {
      "a/CLAUDE.md": { link: "../CLAUDE.md" },
      "b/CLAUDE.md": "x".repeat(FILE_CAP + 1),
      "c/CLAUDE.md": "C-RULES. @../shared.md\n",
      "d/CLAUDE.md": "D-RULES. @../shared.md\n",
      "shared.md": "SHARED\n",
    });
    const scoped = await changedFolders(t.bare, t.env, t.commit, ["a/1.ts", "b/1.ts", "c/1.ts", "d/1.ts"]);
    expect(scoped).toEqual(["a", "b", "c", "d"]);
    const b = await buildInstructions({ target: treeReader(t.bare, t.env, t.commit), scoped, clone: null, local: [], extra: "" });
    expect(b.notLoaded).toEqual([
      "a/CLAUDE.md from the target branch (the path is a link)",
      "b/CLAUDE.md from the target branch (the file is over 64 KB)",
    ]);
    // shortcut in source(): the shared import keeps the scope of the first folder.
    expect(b.files.map((f) => [f.path, f.scope])).toEqual([
      ["c/CLAUDE.md", "c"],
      ["shared.md", "c"],
      ["d/CLAUDE.md", "d"],
    ]);
    expect(await changedFolders(t.bare, t.env, "0".repeat(40), ["c/1.ts"])).toEqual([]);
    expect(await changedFolders(t.bare, t.env, t.commit, [])).toEqual([]);
  });
});

describe("global file", () => {
  const config = (files: Record<string, string>) => clone(files);

  test("comes first with its own header; imports resolve inside the config folder; an escape and a missing file are not loaded", async () => {
    const dir = config({
      "CLAUDE.md": "GLOBAL-CANARY. @rules/a.md @../out.md @~/home-out.md @nope.md\n",
      "rules/a.md": "RULE-A. @b.md\n",
      "rules/b.md": "RULE-B\n",
    });
    writeFileSync(join(dirname(dir), "out.md"), "OUT-CANARY");
    const proj = clone({ "CLAUDE.md": "PROJECT\n" });
    const b = await buildInstructions({
      global: configReader(dir),
      target: null,
      clone: cloneReader(proj),
      local: ["CLAUDE.md"],
      extra: "X",
    });
    expect(b.files.map((f) => [f.source, f.path])).toEqual([
      ["global", "CLAUDE.md"],
      ["global", "rules/a.md"],
      ["global", "rules/b.md"],
      ["clone", "CLAUDE.md"],
      ["settings", ""],
    ]);
    expect(
      b.text.startsWith(
        `# Project instructions\n\n${INSTRUCTIONS_TRUST}\n\n## From your global Claude Code settings: CLAUDE.md (applies to all files)\n`,
      ),
    ).toBe(true);
    expect(b.text).toContain("## From your global Claude Code settings: rules/b.md (imported by rules/a.md)");
    expect(b.text.indexOf("RULE-B")).toBeLessThan(b.text.indexOf("## From your clone: CLAUDE.md"));
    expect(b.text).not.toContain("OUT-CANARY");
    const g = b.notLoaded.join("\n");
    expect(g).toContain("@../out.md, imported by CLAUDE.md from your global Claude Code settings (the path is outside the config folder)");
    expect(g).toContain(
      "@~/home-out.md, imported by CLAUDE.md from your global Claude Code settings (the path is outside the config folder)",
    );
    expect(g).toContain("@nope.md, imported by CLAUDE.md from your global Claude Code settings (the file does not exist)");
  });

  test("a missing global file is a warning; a missing config folder too", async () => {
    const b = await buildInstructions({
      global: configReader(config({ "other.md": "x" })),
      target: null,
      clone: null,
      local: [],
      extra: "",
    });
    expect(b.notLoaded).toEqual(["CLAUDE.md from your global Claude Code settings (the file does not exist)"]);
    expect(b.text).toBe("");
    const gone = await buildInstructions({
      global: configReader(join(root, "no-such-config")),
      target: null,
      clone: null,
      local: [],
      extra: "",
    });
    expect(gone.notLoaded).toEqual(["CLAUDE.md from your global Claude Code settings (the config folder does not exist)"]);
  });

  test("a link out of the config folder does not load", async () => {
    const dir = config({ "CLAUDE.md": "@link.md" });
    writeFileSync(join(root, "global-secret.md"), "GLOBAL-SECRET-CANARY");
    try {
      symlinkSync(join(root, "global-secret.md"), join(dir, "link.md"), "file");
    } catch {
      // Windows without the link privilege. The path check covers the rest.
      return;
    }
    const b = await buildInstructions({ global: configReader(dir), target: null, clone: null, local: [], extra: "" });
    expect(b.text).not.toContain("GLOBAL-SECRET-CANARY");
    expect(b.notLoaded.join("\n")).toContain("a link points outside the config folder");
  });
});
