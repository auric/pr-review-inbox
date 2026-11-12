// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/limits.md decision 2: each raised cap takes its new maximum and refuses one more.
import { describe, expect, test } from "bun:test";
import { DISCUSS_FULL, fixRunInput, taskPlanInput } from "../../src/shared/dto";
import { fixResult, MAX_DISCUSS_MESSAGES, MAX_FIX_ITEMS, MAX_REPLY_THREADS } from "../../src/shared/review";
import {
  MAX_OPEN_CAP,
  minutesMs,
  NO_LIMIT,
  PREFIXES_MAX,
  RUN_LIMIT_KEYS,
  RUN_LIMITS,
  RUN_TIME_MAX_MS,
  replanResult,
  runLimitsOf,
  runLimitValue,
  STEP_TIME_MS,
  SUBTASK_PARTS_MAX,
  specResult,
  typedLimit,
} from "../../src/shared/task";
import { echoSpec } from "../support/fake-claude";

const part = (n: number) => ({ ...echoSpec().parts[0], n });
const parts = (count: number) => Array.from({ length: count }, (_, i) => part(i + 1));
const ids = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

describe("limits decision 2", () => {
  test("the values", () => {
    expect([MAX_DISCUSS_MESSAGES, MAX_FIX_ITEMS, PREFIXES_MAX, MAX_OPEN_CAP, SUBTASK_PARTS_MAX]).toEqual([100, 100, 50, 20, 30]);
    // Reply draft runs keep their own cap.
    expect(MAX_REPLY_THREADS).toBe(25);
    expect(DISCUSS_FULL).toBe("This talk has reached 100 messages. Start a new review for a fresh look.");
  });

  test("a plan takes 30 parts with an estimate of 30, and refuses 31", () => {
    const at = (n: number) =>
      specResult.safeParse({ ...echoSpec(), estimate: { ...echoSpec().estimate, parts: n }, parts: parts(n) }).success;
    expect(at(30)).toBe(true);
    expect(at(31)).toBe(false);
    expect(specResult.safeParse({ ...echoSpec(), estimate: { ...echoSpec().estimate, parts: 31 }, parts: parts(1) }).success).toBe(false);
  });

  test("a changed plan takes 30 remaining parts, and refuses 31", () => {
    const at = (n: number) => replanResult.safeParse({ changed: true, reason: "", parts: parts(n), coverage: echoSpec().coverage }).success;
    expect(at(30)).toBe(true);
    expect(at(31)).toBe(false);
  });

  test("the sub-task plan approval takes 30 parts and 20 open PRs, and refuses 31 parts and 21 open PRs", () => {
    const plan = (count: number, maxOpen: number) =>
      taskPlanInput.safeParse({
        version: 1,
        size: "small",
        commands: [],
        subtasks: { parts: ids(count).map((n) => ({ n, start: "base", after: null })), track: [], maxOpen },
      }).success;
    expect(plan(30, 20)).toBe(true);
    expect(plan(31, 20)).toBe(false);
    expect(plan(30, 21)).toBe(false);
  });

  test("a fix result takes 100 notes, and refuses 101", () => {
    const coverage = { read: [], skipped: [], unavailable: [], notChecked: [] };
    const note = (thread: number) => ({ thread, fixed: false, reason: "R." });
    const at = (n: number) => fixResult.safeParse({ summary: "S.", threads: ids(n).map(note), edits: [], coverage }).success;
    expect(at(100)).toBe(true);
    expect(at(101)).toBe(false);
    expect(fixRunInput.safeParse({ threads: ids(100) }).success).toBe(true);
    expect(fixRunInput.safeParse({ threads: ids(101) }).success).toBe(false);
  });
});

describe("limits decision 3", () => {
  test("the defaults and bounds; a field takes a whole number inside the bounds only", () => {
    // AC-B204: the step time and the part time have no limit by default (user decision of 2026-11-11). A stored number keeps its limit.
    expect(runLimitsOf(undefined)).toEqual({
      stepMinutes: NO_LIMIT,
      partMinutes: NO_LIMIT,
      reviewMinutes: 60,
      interviewRounds: 2,
      testFixTries: 3,
      planTurns: 80,
      runsAtOnce: 3,
    });
    expect(runLimitsOf({ planTurns: 33 }).planTurns).toBe(33);
    expect(runLimitsOf({ stepMinutes: 20, partMinutes: 120 })).toMatchObject({ stepMinutes: 20, partMinutes: 120 });
    expect([STEP_TIME_MS, minutesMs(NO_LIMIT), minutesMs(20)]).toEqual([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 20 * 60_000]);
    for (const k of RUN_LIMIT_KEYS) {
      const { min, max } = RUN_LIMITS[k];
      expect([runLimitValue(k, String(min)), runLimitValue(k, ` ${max} `)]).toEqual([min, max]);
      for (const bad of [String(max + 1), "", "2.5", "x", "-1"]) expect(runLimitValue(k, bad)).toBeNull();
      // Only the two times can be off. min - 1 is 0 for some keys.
      expect(runLimitValue(k, String(NO_LIMIT))).toBe(k === "stepMinutes" || k === "partMinutes" ? NO_LIMIT : null);
      if (min - 1 !== NO_LIMIT) expect(runLimitValue(k, String(min - 1))).toBeNull();
      // AC-B218: a typed 0 is no valid number in the field. Only the "No limit" box gives NO_LIMIT.
      for (const zero of ["0", " 0", "00", "-0"]) expect(typedLimit(k, zero)).toBeNull();
      expect([typedLimit(k, String(min)), typedLimit(k, String(max))]).toEqual([min, max]);
    }
    // A step and a review run stay inside the hard limit of one Claude process.
    expect(RUN_TIME_MAX_MS).toBe(240 * 60_000);
    expect(RUN_LIMITS.stepMinutes.max * 60_000).toBeLessThanOrEqual(RUN_TIME_MAX_MS);
  });
});
