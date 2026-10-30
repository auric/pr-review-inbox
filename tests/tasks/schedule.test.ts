// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.20.6 (WP-ST3, AC-B78): the truth table of the pure scheduler nextPart. No I/O.
import { describe, expect, test } from "bun:test";
import { nextPart, type SchedulePart } from "../../src/server/tasks/schedule";

console.log(`schedule.test.ts imported from ${Bun.resolveSync("../../src/server/tasks/schedule", import.meta.dir)}`);

// Part id n has ord n and the label ABC-1n.
const p = (id: number, o: Partial<SchedulePart> = {}): SchedulePart => ({
  id,
  ord: id,
  label: `ABC-1${id}`,
  state: "planned",
  start: "base",
  after: null,
  gate: false,
  override: false,
  done: false,
  ...o,
});
const waits = (parts: SchedulePart[], max = 3) => Object.fromEntries(nextPart(parts, max).waits);
const start = (parts: SchedulePart[], max = 3) => nextPart(parts, max).start;

describe("nextPart (spec.md section 6.20.6, AC-B78)", () => {
  test("base: the first planned part by ord starts; the others wait for its build", () => {
    const parts = [p(3, { ord: 1 }), p(1, { ord: 2 }), p(2, { ord: 3 })];
    expect(start(parts)).toEqual({ id: 3, on: null });
    expect(waits(parts)).toEqual({ 1: "Waits for the build of ABC-13.", 2: "Waits for the build of ABC-13." });
  });

  test("one build at a time: no start while a part is implementing", () => {
    const parts = [p(1, { state: "implementing" }), p(2)];
    expect(start(parts)).toBeNull();
    expect(waits(parts)).toEqual({ 2: "Waits for the build of ABC-11." });
  });

  test("the limit counts self_reviewed, pr_open, changes_requested, approved, and tracked PRs", () => {
    const open = [
      p(1, { state: "self_reviewed" }),
      p(2, { state: "pr_open" }),
      p(3, { state: "changes_requested" }),
      p(4, { state: "approved" }),
    ];
    expect(start([...open, p(5)], 4)).toBeNull();
    expect(waits([...open, p(5)], 4)).toEqual({ 5: "Waits: 4 PRs of this task are open, your limit." });
    expect(start([...open, p(5)], 5)).toEqual({ id: 5, on: null });
    // A tracked PR is an open part too. Merged, declined, and dropped parts are not open.
    const closed = [p(1, { state: "merged" }), p(2, { state: "declined" }), p(3, { state: "abandoned" }), p(4, { state: "pr_open" })];
    expect(waits([...closed, p(5)], 1)).toEqual({ 5: "Waits: 1 PR of this task is open, your limit." });
    expect(start([...closed, p(5)], 2)).toEqual({ id: 5, on: null });
  });

  test("stack: the part waits for the gate of its lower part, and starts on it when the gate passed", () => {
    const upper = p(2, { start: "stack", after: 1 });
    for (const state of ["planned", "implementing", "self_reviewed", "pr_open", "changes_requested"] as const)
      expect(waits([p(1, { state }), upper], 5)[2]).toBe("Waits for a review of ABC-11.");
    expect(start([p(1, { state: "pr_open" }), upper])).toBeNull();
    expect(start([p(1, { state: "approved", gate: true }), upper])).toEqual({ id: 2, on: 1 });
  });

  test("override: a part on an unapproved PR starts on it; it still needs the lower PR", () => {
    expect(start([p(1, { state: "pr_open" }), p(2, { start: "stack", after: 1, override: true })])).toEqual({ id: 2, on: 1 });
    expect(start([p(1, { state: "changes_requested" }), p(2, { start: "stack", after: 1, override: true })])).toEqual({ id: 2, on: 1 });
    expect(waits([p(1, { state: "self_reviewed" }), p(2, { start: "stack", after: 1, override: true })])).toEqual({
      2: "Waits for a review of ABC-11.",
    });
  });

  test("merge: the part waits for the merge of its lower part, then starts from the base", () => {
    const upper = p(2, { start: "merge", after: 1 });
    expect(waits([p(1, { state: "approved", gate: true }), upper])).toEqual({ 2: "Waits for ABC-11 to merge." });
    expect(start([p(1, { state: "merged" }), upper])).toEqual({ id: 2, on: null });
  });

  test("a lower part that merged before the start gives a base start; a dropped or done one too; a declined one waits", () => {
    expect(start([p(1, { state: "merged" }), p(2, { start: "stack", after: 1 })])).toEqual({ id: 2, on: null });
    expect(start([p(1, { state: "abandoned" }), p(2, { start: "stack", after: 1 })])).toEqual({ id: 2, on: null });
    expect(start([p(1, { state: "pr_open", done: true }), p(2, { start: "merge", after: 1 })])).toEqual({ id: 2, on: null });
    expect(waits([p(1, { state: "declined" }), p(2, { start: "stack", after: 1 })])).toEqual({ 2: "Waits for ABC-11, which is declined." });
    // A lower part that the plan no longer has.
    expect(start([p(2, { start: "stack", after: 9 })])).toEqual({ id: 2, on: null });
  });

  test("the reason of the order comes before the limit and the build; a met part waits for the limit", () => {
    const parts = [p(1, { state: "pr_open" }), p(2, { start: "merge", after: 1 }), p(3)];
    expect(waits(parts, 1)).toEqual({ 2: "Waits for ABC-11 to merge.", 3: "Waits: 1 PR of this task is open, your limit." });
    expect(start(parts, 2)).toEqual({ id: 3, on: null });
  });
});
