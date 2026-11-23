// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/submodule-prs.md section 5.6 and stacked-prs.md K19 (WP-RP0): the related context lines of a run in the run log
// footer and the warn parts of the run line.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunDto } from "../../src/shared/dto";
import { relatedText, relatedWarnings } from "../../src/web/review/model";
import { RelatedLines } from "../../src/web/review/RelatedLines";

console.log(`run-related.test.tsx imported from ${Bun.resolveSync("../../src/web/review/model", import.meta.dir)}`);

const related: NonNullable<RunDto["related"]> = [
  { label: "Submodule context", text: "lib/a at 1a2b3c4 read", warn: false },
  { label: "Stacked PR context", text: "parent PR #7 read", warn: false },
  { label: "Submodule context", text: "lib/b not read", warn: true },
];

describe("relatedText", () => {
  test("a run without related context gives no line", () => {
    expect(relatedText({})).toEqual([]);
    expect(relatedText({ related: [] })).toEqual([]);
    expect(relatedWarnings({})).toEqual([]);
  });

  test("one line per label in stored order, the warn flag on each part", () => {
    expect(relatedText({ related })).toEqual([
      {
        label: "Submodule context",
        parts: [
          { text: "lib/a at 1a2b3c4 read", warn: false },
          { text: "lib/b not read", warn: true },
        ],
      },
      { label: "Stacked PR context", parts: [{ text: "parent PR #7 read", warn: false }] },
    ]);
  });

  test("the run line gets only the warn parts", () => {
    expect(relatedWarnings({ related })).toEqual(["Submodule context: lib/b not read"]);
    expect(relatedWarnings({ related: related.slice(0, 2) })).toEqual([]);
  });
});

describe("RelatedLines", () => {
  test("the footer shows '<label>: <text>; <text>' with the warn part in the destructive color", () => {
    const html = renderToStaticMarkup(<RelatedLines run={{ related }} />);
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).toBe("Submodule context: lib/a at 1a2b3c4 read; lib/b not readStacked PR context: parent PR #7 read");
    expect(html.match(/data-run-related/g)?.length).toBe(2);
    expect(html).toContain('<span data-warn="true" class="text-destructive">lib/b not read</span>');
    expect(html).toContain("<span>lib/a at 1a2b3c4 read</span>");
  });

  test("an old run renders nothing", () => {
    expect(renderToStaticMarkup(<RelatedLines run={{}} />)).toBe("");
  });
});
