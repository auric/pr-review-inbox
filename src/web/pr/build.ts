// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The words of a forge build status (docs/plans/ci-builds.md, Layer A, UI). Pure: tests/web/build.test.ts.
import type { BuildState, BuildStatus } from "../../shared/build";
import type { BuildDto } from "../../shared/dto";

// "none": no build reported a status, so the UI shows nothing.
export const BUILD_WORD: Record<BuildState, string | null> = {
  failed: "Build failed",
  running: "Build running",
  passed: "Build passed",
  other: "Build result unknown",
  none: null,
};

// "1 failed, 2 running, 3 passed". Only the counts above 0.
export function countsText(b: BuildDto): string {
  const c = b.counts;
  const parts: [number, string][] = [
    [c.failed, "failed"],
    [c.inProgress, "running"],
    [c.successful, "passed"],
    [c.cancelled, "cancelled"],
    [c.unknown, "unknown"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}`)
    .join(", ");
}

// The status that the build line names: the first failed one, else the first running one. Other states name the only status, so one
// name never stands for several builds.
export function namedBuild(b: BuildDto): BuildStatus | null {
  const list = b.builds ?? [];
  const want = b.state === "failed" ? "FAILED" : b.state === "running" ? "INPROGRESS" : null;
  return (want ? list.find((s) => s.state === want) : list.length === 1 ? list[0] : undefined) ?? null;
}

// "Build failed: unit tests. 1 failed, 2 passed." A hint of a list row.
export function buildHint(b: BuildDto): string {
  const s = namedBuild(b);
  return `${BUILD_WORD[b.state] ?? "No build"}${s ? `: ${s.name}` : ""}. ${countsText(b)}.`;
}
