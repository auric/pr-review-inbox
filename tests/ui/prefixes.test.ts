// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.16.1 (AC-B24, WP-BR2): the model of Settings > Tasks "Branch prefixes": order, the row and list
// sentences, the list that a save sends, and the focus after a change.
import { describe, expect, test } from "bun:test";
import { DEFAULT_BRANCH_PREFIXES, PREFIXES_MAX } from "../../src/shared/task";
import {
  changePrefixes,
  listProblem,
  PREFIX_ADD_ID,
  type PrefixDraft,
  prefixesToSave,
  prefixFocus,
  prefixId,
  prefixProblems,
  toPrefixDrafts,
} from "../../src/web/settings/prefixes";

console.log(`prefixes.test.ts imported from ${Bun.resolveSync("../../src/web/settings/prefixes", import.meta.dir)}`);

const texts = (l: PrefixDraft[]) => l.map((r) => r.text);
const start = () => toPrefixDrafts([...DEFAULT_BRANCH_PREFIXES]);

describe("Settings > Tasks branch prefixes", () => {
  test("Move up and Move down change the order, and the ends stay put", () => {
    const l = start();
    expect(texts(changePrefixes(l, { act: "move", i: 0, d: 1 }))).toEqual(["bugfix/", "feature/", "hotfix/"]);
    expect(texts(changePrefixes(l, { act: "move", i: 2, d: -1 }))).toEqual(["feature/", "hotfix/", "bugfix/"]);
    expect(changePrefixes(l, { act: "move", i: 0, d: -1 })).toBe(l);
    expect(changePrefixes(l, { act: "move", i: 2, d: 1 })).toBe(l);
    // A moved row keeps its id, so React keeps its field.
    expect(changePrefixes(l, { act: "move", i: 0, d: 1 })[1]?.id).toBe(l[0]?.id as number);
  });

  test("an added row starts empty with no sentence until the user leaves it, and holds the save back", () => {
    const l = changePrefixes(start(), { act: "add" });
    expect(texts(l)).toEqual(["feature/", "bugfix/", "hotfix/", ""]);
    expect(prefixProblems(l)).toEqual([null, null, null, null]);
    expect(prefixesToSave(l)).toBeNull();
    const left = changePrefixes(l, { act: "leave", i: 3 });
    expect(prefixProblems(left)[3]).toBe("Invalid branch prefix.");
    expect(prefixesToSave(changePrefixes(left, { act: "edit", i: 3, text: " task/ " }))).toEqual([
      "feature/",
      "bugfix/",
      "hotfix/",
      "task/",
    ]);
  });

  test("an invalid prefix and a repeat show their sentences and save nothing", () => {
    const bad = changePrefixes(start(), { act: "edit", i: 1, text: "bad.." });
    expect(prefixProblems(bad)).toEqual([null, "Invalid branch prefix.", null]);
    expect(prefixesToSave(bad)).toBeNull();
    const twice = changePrefixes(start(), { act: "edit", i: 2, text: "feature/" });
    expect(prefixProblems(twice)).toEqual([null, null, "This prefix is already in the list."]);
    expect(prefixesToSave(twice)).toBeNull();
    expect(prefixProblems(changePrefixes(start(), { act: "edit", i: 0, text: "x".repeat(41) }))[0]).toBe("Invalid branch prefix.");
  });

  test("the list keeps at least one prefix and at most 50", () => {
    let l = start();
    for (let i = 0; i < 3; i++) l = changePrefixes(l, { act: "remove", i: 0 });
    expect(l).toEqual([]);
    expect(listProblem(l)).toBe("Keep at least one prefix.");
    expect(prefixesToSave(l)).toBeNull();
    let full = start();
    for (let i = 0; i < 60; i++) full = changePrefixes(full, { act: "add" });
    expect(full).toHaveLength(PREFIXES_MAX);
    expect(PREFIXES_MAX).toBe(50);
    expect(listProblem(full)).toBeNull();
  });

  test("the focus after a change keeps the place in the list", () => {
    expect(prefixFocus({ act: "add" }, 4)).toBe(prefixId(3, "text"));
    expect(prefixFocus({ act: "remove", i: 2 }, 2)).toBe(prefixId(1, "remove"));
    expect(prefixFocus({ act: "remove", i: 0 }, 0)).toBe(PREFIX_ADD_ID);
    expect(prefixFocus({ act: "move", i: 0, d: 1 }, 3)).toBe(prefixId(1, "down"));
    // At the end of the list the button in the same direction is disabled, so the focus goes to the other one.
    expect(prefixFocus({ act: "move", i: 1, d: 1 }, 3)).toBe(prefixId(2, "up"));
    expect(prefixFocus({ act: "move", i: 1, d: -1 }, 3)).toBe(prefixId(0, "down"));
    expect(prefixFocus({ act: "edit", i: 0, text: "x/" }, 3)).toBeNull();
  });
});
