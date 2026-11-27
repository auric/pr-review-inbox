// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Audit N2: the diff memo drops the oldest entries until the entry count and the text size fit.
import { expect, test } from "bun:test";
import { type MemoEntry, remember } from "../../src/server/review/diff";

const e = (chars: number): MemoEntry => ({ files: [], chars });

test("the memo evicts the oldest entries over the character cap, and a hit moves its entry to the newest place", () => {
  const m = new Map<string, MemoEntry>();
  remember(m, "a", e(40), 4, 100);
  remember(m, "b", e(40), 4, 100);
  remember(m, "a", e(40), 4, 100);
  remember(m, "c", e(40), 4, 100);
  expect([...m.keys()]).toEqual(["a", "c"]);
  remember(m, "d", e(100), 4, 100);
  expect([...m.keys()]).toEqual(["d"]);
});

test("the memo keeps at most the entry count, also for diffs without text", () => {
  const m = new Map<string, MemoEntry>();
  for (const k of ["a", "b", "c", "d", "e"]) remember(m, k, { files: null, chars: 0 }, 4, 100);
  expect([...m.keys()]).toEqual(["b", "c", "d", "e"]);
});
