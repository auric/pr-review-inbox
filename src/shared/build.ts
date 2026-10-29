// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Bitbucket build status of a commit (docs/plans/ci-builds.md, Layer A), shared by the server and the web.

// The counts of GET /rest/build-status/1.0/commits/stats/{commit} (Gate G3). All zeros: no build reported a status.
export type BuildCounts = { successful: number; inProgress: number; failed: number; cancelled: number; unknown: number };

// One status of the commit. state: as Bitbucket sends it (CANCELLED, FAILED, INPROGRESS, SUCCESSFUL, UNKNOWN). url: http(s) only, else null.
export type BuildStatus = { name: string; state: string; url: string | null };

export type BuildState = "failed" | "running" | "passed" | "none" | "other";

export function buildState(c: BuildCounts): BuildState {
  if (c.failed > 0) return "failed";
  if (c.inProgress > 0) return "running";
  if (c.successful + c.cancelled + c.unknown === 0) return "none";
  return c.successful > 0 && c.cancelled === 0 && c.unknown === 0 ? "passed" : "other";
}
