// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/ci-builds.md, Layer A, UI: the words of a build status.
import { describe, expect, test } from "bun:test";
import type { BuildDto } from "../../src/shared/dto";
import { buildHint, countsText, namedBuild } from "../../src/web/pr/build";

console.log(`build.test.ts imported from ${Bun.resolveSync("../../src/web/pr/build", import.meta.dir)}`);

const dto = (o: Partial<BuildDto> = {}): BuildDto => ({
  head: "a".repeat(40),
  state: "failed",
  counts: { successful: 2, inProgress: 1, failed: 1, cancelled: 0, unknown: 0 },
  builds: [
    { name: "lint", state: "SUCCESSFUL", url: null },
    { name: "deploy", state: "INPROGRESS", url: null },
    { name: "unit tests", state: "FAILED", url: "https://ci.example.test/1" },
  ],
  readAt: 1,
  ...o,
});

describe("build words", () => {
  test("countsText names only the counts above 0", () => {
    expect(countsText(dto())).toBe("1 failed, 1 running, 2 passed");
    expect(countsText(dto({ counts: { successful: 0, inProgress: 0, failed: 0, cancelled: 3, unknown: 1 } }))).toBe(
      "3 cancelled, 1 unknown",
    );
  });

  test("namedBuild: the first failed, else the first running, else the only one", () => {
    expect(namedBuild(dto())?.name).toBe("unit tests");
    expect(namedBuild(dto({ state: "running" }))?.name).toBe("deploy");
    expect(namedBuild(dto({ state: "passed" }))).toBeNull();
    expect(namedBuild(dto({ state: "passed", builds: [{ name: "lint", state: "SUCCESSFUL", url: null }] }))?.name).toBe("lint");
    expect(namedBuild(dto({ builds: null }))).toBeNull();
  });

  test("buildHint: the state, the name, and the counts", () => {
    expect(buildHint(dto())).toBe("Build failed: unit tests. 1 failed, 1 running, 2 passed.");
    expect(buildHint(dto({ builds: null }))).toBe("Build failed. 1 failed, 1 running, 2 passed.");
  });
});
