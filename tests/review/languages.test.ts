// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { RETIRED_PROFILES, rubric } from "../../src/server/review/catalog";
import { parseDiff } from "../../src/server/review/diffmap";
import {
  CHECKLISTS,
  LANGUAGE_INTRO,
  LANGUAGES,
  languageLines,
  languagesOf,
  SKIP_COMMON,
  withLanguages,
} from "../../src/server/review/languages";
import { DEFAULT_VERIFIER, VOLUMES } from "../../src/shared/dto";

const file = (path: string | null, oldPath: string | null = path, binary = false) => ({
  path,
  oldPath,
  binary,
  rows: [],
  newLines: new Map(),
  oldLines: new Map(),
});
const langs = (...paths: string[]) => languagesOf(paths.map((p) => file(p)));

// ASD-STE100: at most 20 words in a sentence.
const longSentences = (text: string) => text.split(/(?<=[.?!])\s+/).filter((s) => s.split(/\s+/).filter(Boolean).length > 20);

describe("language map", () => {
  test("C++, C, and Python suffixes map to their lists, in any case", () => {
    for (const ext of [".cpp", ".cc", ".cxx", ".c++", ".hh", ".hpp", ".hxx", ".h++", ".tcc", ".ipp", ".inl", ".tpp", ".ixx", ".cppm"])
      expect(langs(`src/a${ext}`)).toEqual(["cpp"]);
    expect(langs("src/A.CPP", "include/B.Hpp")).toEqual(["cpp"]);
    expect(langs("lib/a.c")).toEqual(["c"]);
    for (const ext of [".py", ".pyi", ".PYW"]) expect(langs(`tools/a${ext}`)).toEqual(["python"]);
    expect(langs("src/app.ts", "README.md", "Makefile", "dir.cpp/notes", ".py", "a.cs", "a.m")).toEqual([]);
  });

  test("a .h file gets the C++ list; a change with .c files also gets the C list", () => {
    expect(langs("include/a.h")).toEqual(["cpp"]);
    expect(langs("include/a.h", "src/a.c")).toEqual(["cpp", "c"]);
    expect(langs("src/a.c", "src/b.c")).toEqual(["c"]);
  });

  test("the result follows LANGUAGES order and holds each language once", () => {
    expect(LANGUAGES).toEqual(["cpp", "c", "python"]);
    expect(langs("x.py", "y.c", "z.cpp", "w.py", "v.hpp")).toEqual(["cpp", "c", "python"]);
  });

  test("a deleted file counts by its old path; a rename by its new path; a binary file not at all", () => {
    expect(languagesOf([file(null, "old/a.py")])).toEqual(["python"]);
    expect(languagesOf([file("a.txt", "a.py")])).toEqual([]);
    expect(languagesOf([file("a.cpp", "a.cpp", true)])).toEqual([]);
  });

  test("parsed git diff output gives the same result", () => {
    const diff = [
      "diff --git a/src/k.cpp b/src/k.cpp",
      "index 1111111..2222222 100644",
      "--- a/src/k.cpp",
      "+++ b/src/k.cpp",
      "@@ -1 +1 @@",
      "-int a;",
      "+int b;",
      "diff --git a/tools/gone.py b/tools/gone.py",
      "deleted file mode 100644",
      "index 3333333..0000000",
      "--- a/tools/gone.py",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-print(1)",
      "diff --git a/lib/blob.c b/lib/blob.c",
      "index 4444444..5555555 100644",
      "Binary files a/lib/blob.c and b/lib/blob.c differ",
      "",
    ].join("\n");
    expect(languagesOf(parseDiff(diff))).toEqual(["cpp", "python"]);
  });
});

describe("checklist text", () => {
  const items = Object.values(CHECKLISTS).flatMap((l) => l.items as readonly string[]);

  test("each item has the form <category>: <sentences> [<level>], with no nit", () => {
    expect(items.length).toBeGreaterThan(40);
    for (const item of items) {
      expect(item).toMatch(/^[a-z-]+: .+ \[(blocker|major|minor)\]$/);
      expect(item).not.toMatch(/\bnit\b/);
    }
    for (const l of Object.values(CHECKLISTS)) {
      const names = l.items.map((i) => i.slice(0, i.indexOf(":")));
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("each sentence of the items, the intro, the rubric, and the Over-engineering task has at most 20 words", () => {
    // The Over-engineering task stays in RETIRED_PROFILES for the simplify module (docs/plans/review-v2/spec.md section 1.3).
    const over = RETIRED_PROFILES.over?.prompt ?? "";
    expect(over).toContain("Set category to delete, reuse, stdlib, native, yagni, or shrink.");
    // The category before the colon and the level in brackets are tags, not words of the sentence.
    const prose = items.map((i) => i.replace(/^[a-z-]+: /, "").replace(/ \[\w+\]$/, ""));
    const rubrics = VOLUMES.flatMap((volume) => rubric({ volume, verifier: DEFAULT_VERIFIER }));
    const skips = Object.values(CHECKLISTS).flatMap((l) => l.skip as readonly string[]);
    const texts = [...prose, ...skips, SKIP_COMMON, ...LANGUAGE_INTRO, ...rubrics, ...over.split("\n")];
    expect(texts.flatMap(longSentences)).toEqual([]);
  });
});

describe("agent prompt", () => {
  const agent = { description: "D", prompt: "P" };

  test("no language gives no lines and the same agent", () => {
    expect(languageLines([])).toEqual([]);
    expect(withLanguages(agent, [])).toBe(agent);
  });

  test("each language has a skip list of one to three items", () => {
    for (const l of Object.values(CHECKLISTS)) {
      expect(l.skip.length).toBeGreaterThanOrEqual(1);
      expect(l.skip.length).toBeLessThanOrEqual(3);
    }
  });

  test("the lines are the intro, one titled list and its skip list per language, then the common skip line", () => {
    const lines = languageLines(["c", "python"]);
    expect(lines.slice(0, LANGUAGE_INTRO.length)).toEqual(LANGUAGE_INTRO);
    expect(lines).toContain("C list:");
    expect(lines).toContain("Python list:");
    expect(lines).toContain("Do not report in C:");
    expect(lines).not.toContain("C++ list:");
    expect(lines.at(-1)).toBe(SKIP_COMMON);
    const n = (l: { items: readonly string[]; skip: readonly string[] }) => l.items.length + l.skip.length;
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(n(CHECKLISTS.c) + n(CHECKLISTS.python));
    expect(withLanguages(agent, ["c", "python"])).toEqual({ description: "D", prompt: ["P", ...lines].join("\n") });
  });
});
