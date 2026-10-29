// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The derived build state (docs/plans/ci-builds.md, Layer A).
import { expect, test } from "bun:test";
import { type BuildCounts, type BuildState, buildState } from "../../src/shared/build";

const c = (o: Partial<BuildCounts>): BuildCounts => ({ successful: 0, inProgress: 0, failed: 0, cancelled: 0, unknown: 0, ...o });

test.each([
  [{}, "none"],
  [{ failed: 1 }, "failed"],
  [{ failed: 1, inProgress: 2, successful: 3, cancelled: 1, unknown: 1 }, "failed"],
  [{ inProgress: 1 }, "running"],
  [{ inProgress: 1, successful: 2, cancelled: 1 }, "running"],
  [{ successful: 1 }, "passed"],
  [{ successful: 4 }, "passed"],
  [{ successful: 1, cancelled: 1 }, "other"],
  [{ successful: 1, unknown: 1 }, "other"],
  [{ cancelled: 1 }, "other"],
  [{ unknown: 2 }, "other"],
] as [Partial<BuildCounts>, BuildState][])("%o gives %s", (counts, state) => {
  expect(buildState(c(counts))).toBe(state);
});
