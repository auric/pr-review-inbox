// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build status rules of the sync (docs/plans/ci-builds.md, Layer A).
import { type BuildCounts, type BuildStatus, buildState } from "../../shared/build";
import type { NewEvent } from "./reconcile";

// The statuses that pr_build keeps of one page.
const MAX_BUILDS = 10;
const RANK: Record<string, number> = { FAILED: 0, INPROGRESS: 1 };

export type StoredBuild = { head: string; stats_json: string };

const KEYS = ["successful", "inProgress", "failed", "cancelled", "unknown"] as const;

// The status list is read again only when the head or a count changed.
export function buildChanged(prev: StoredBuild | null, head: string, stats: BuildCounts): boolean {
  if (!prev || prev.head !== head) return true;
  const old = JSON.parse(prev.stats_json) as Partial<BuildCounts>;
  return KEYS.some((k) => old[k] !== stats[k]);
}

// Failed first, then in progress, then the others in server order.
export function keptBuilds(list: BuildStatus[]): BuildStatus[] {
  return list
    .map((b, i) => ({ b, i, r: RANK[b.state] ?? 2 }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .slice(0, MAX_BUILDS)
    .map((x) => x.b);
}

// mine: the user is the PR author. first: the first build read of the PR, or the first sync after a follow. One event of each kind per head
// (the event key), and none while a build runs.
export function buildEvents(stats: BuildCounts, head: string, o: { mine: boolean; first: boolean }): NewEvent[] {
  if (o.first || !o.mine || stats.inProgress > 0) return [];
  const state = buildState(stats);
  if (state === "failed") return [{ kind: "build_failed", ref: head }];
  return state === "passed" ? [{ kind: "build_passed", ref: head }] : [];
}
