// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Windows CI shards: each file runs in exactly one shard, and the slowest shard stays near the even share.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseShard, shardFiles } from "../../scripts/ci-shard";

console.log(`ci-shard.test.ts imported from ${Bun.resolveSync("../../scripts/ci-shard", import.meta.dir)}`);

const all = (files: string[], times: Record<string, number>, n: number) =>
  Array.from({ length: n }, (_, i) => shardFiles(files, times, i + 1, n));

describe("shardFiles", () => {
  test("each file lands in exactly one shard, sorted by path; a duplicate runs once", () => {
    const files = ["c", "a", "b", "d", "e", "a"];
    const shards = all(files, { a: 5, b: 1, c: 1, d: 1, e: 1 }, 3);
    expect(shards.flat().sort()).toEqual(["a", "b", "c", "d", "e"]);
    for (const s of shards) expect(s).toEqual([...s].sort());
  });

  test("two slow neighbors go to different shards, which a contiguous cut cannot do", () => {
    const shards = all(["a", "b", "c", "d"], { a: 1, b: 10, c: 10, d: 1 }, 2);
    expect(shards.map((s) => s.includes("b") !== s.includes("c"))).toEqual([true, true]);
  });

  test("a file without a timing costs the median of the known ones", () => {
    const shards = all(["a", "b", "c", "new"], { a: 1, b: 4, c: 100 }, 2);
    expect(shards).toEqual([["c"], ["a", "b", "new"]]);
  });

  test("more shards than files leaves a shard empty", () => {
    expect(all(["a"], {}, 3)).toEqual([["a"], [], []]);
  });

  test("the checked-in timings keep the slowest Windows shard within 10 % of the even share", () => {
    const times = (
      JSON.parse(readFileSync(join(import.meta.dir, "../../scripts/ci-windows-timings.json"), "utf8")) as {
        files: Record<string, number>;
      }
    ).files;
    const files = Object.keys(times);
    const shards = all(files, times, 3);
    const sum = (s: string[]) => s.reduce((n, f) => n + (times[f] ?? 0), 0);
    const total = sum(files);
    expect(Math.max(...shards.map(sum))).toBeLessThanOrEqual((total / 3) * 1.1);
  });
});

describe("parseShard", () => {
  test("reads i/n and refuses an index outside 1..n", () => {
    expect(parseShard("--shard=2/3")).toEqual({ index: 2, count: 3 });
    expect(parseShard("--timeout=5")).toBeNull();
    expect(() => parseShard("--shard=4/3")).toThrow();
    expect(() => parseShard("--shard=0/3")).toThrow();
  });
});
