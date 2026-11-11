// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The profile option of the run inputs: a profile for one run only. The route checks that the settings list the ID.
import { describe, expect, test } from "bun:test";
import { askInput, fixRunInput, replyRunInput, reviewRunInput } from "../../src/shared/dto";

const inputs = [
  ["review", reviewRunInput, {}],
  ["reply", replyRunInput, { threads: [101] }],
  ["fix", fixRunInput, { threads: [101] }],
  ["ask", askInput, { question: "Why?" }],
] as const;

describe.each(inputs)("%s run input", (_, schema, base) => {
  test("the profile is optional, and a valid ID passes as given", () => {
    expect(schema.safeParse(base).data as unknown).toEqual(base);
    expect(schema.safeParse({ ...base, profile: "security" }).data as unknown).toEqual({ ...base, profile: "security" });
  });

  test("a profile ID outside the profile ID form fails on the profile field", () => {
    for (const profile of ["", "Security", "a b", "x".repeat(41), 7, null]) {
      const r = schema.safeParse({ ...base, profile });
      expect(r.success).toBe(false);
      expect(r.error?.issues.map((i) => i.path[0])).toEqual(["profile"]);
    }
  });
});

// docs/plans/fix-ux.md WP3: a fix run takes threads, findings, or both, at most 100 in total.
test("the fix run input takes findings and caps threads and findings together at 100", () => {
  const ids = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i);
  expect(fixRunInput.safeParse({ findings: [7] }).data).toEqual({ findings: [7] });
  expect(fixRunInput.safeParse({ threads: ids(95, 1), findings: ids(5, 1000) }).success).toBe(true);
  const over = fixRunInput.safeParse({ threads: ids(95, 1), findings: ids(6, 1000) });
  expect(over.error?.issues.map((i) => i.message)).toEqual(["Pick at most 100 threads and findings for one run."]);
  for (const findings of [[], [0], [1.5], ids(101, 1)]) expect(fixRunInput.safeParse({ findings }).success).toBe(false);
});
