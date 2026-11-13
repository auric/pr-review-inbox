// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// bun test --shard cuts the path-sorted files into contiguous runs (Timings.rs partition in Bun 1.4). The slow files of tests/tasks sit
// side by side, so no contiguous cut balances the Windows shards. This split puts each file, slowest first, on the least loaded shard.

// The files of shard index (1-based) of count, sorted by path. A file without a timing costs the median, as in Bun.
export function shardFiles(files: string[], times: Record<string, number>, index: number, count: number): string[] {
  const known = Object.values(times).sort((a, b) => a - b);
  const median = known.length ? (known[Math.floor(known.length / 2)] as number) : 1;
  const cost = (f: string) => Math.max(times[f] ?? median, 1);
  const order = [...new Set(files)].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = new Array<number>(count).fill(0);
  const bins: string[][] = Array.from({ length: count }, () => []);
  for (const f of order) {
    const i = load.indexOf(Math.min(...load));
    load[i] = (load[i] as number) + cost(f);
    bins[i]?.push(f);
  }
  return (bins[index - 1] ?? []).sort();
}

// "--shard=2/3" gives { index: 2, count: 3 }. null: not a shard flag.
export function parseShard(arg: string): { index: number; count: number } | null {
  const m = /^--shard=(\d+)\/(\d+)$/.exec(arg);
  if (!m) return null;
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1 || index < 1 || index > count) throw new Error(`Invalid ${arg}. Use --shard=<i>/<n> with 1 <= i <= n.`);
  return { index, count };
}
