// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build status of a PR for the DTOs (docs/plans/ci-builds.md, Layer A).
import type { Database } from "bun:sqlite";
import { type BuildCounts, type BuildStatus, buildState } from "../../shared/build";
import type { BuildDto } from "../../shared/dto";

// The pr_build columns, NULL without a row.
export type RawBuild = { build_head: string | null; stats_json: string | null; builds_json: string | null; build_read_at: number | null };

export const BUILD_COLUMNS = "pb.head AS build_head, pb.stats_json, pb.builds_json, pb.read_at AS build_read_at";

// sourceHead: pull_request.source_head. A read of an older head says nothing about the current one.
export function toBuild(r: RawBuild, sourceHead: string | null): BuildDto | null {
  if (r.build_head === null || r.build_head !== sourceHead || r.stats_json === null || r.build_read_at === null) return null;
  const counts = JSON.parse(r.stats_json) as BuildCounts;
  return {
    head: r.build_head,
    state: buildState(counts),
    counts,
    builds: r.builds_json === null ? null : (JSON.parse(r.builds_json) as BuildStatus[]),
    readAt: r.build_read_at,
  };
}

const ONE = `SELECT ${BUILD_COLUMNS}, p.source_head FROM pull_request p JOIN pr_build pb ON pb.pr = p.id WHERE p.id = $pr`;

// pr: pull_request.id, null before the PR exists.
export function buildOf(db: Database, pr: number | null): BuildDto | null {
  if (pr === null) return null;
  const r = db.query(ONE).get({ pr }) as (RawBuild & { source_head: string | null }) | null;
  return r && toBuild(r, r.source_head);
}
