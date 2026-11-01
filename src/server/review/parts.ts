// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v3.md WP-V14: the variant "parts" splits a delegated change into parts. R8 gives each part to one agent alone.
import type { RunEvent } from "../../shared/run-log";
import { delegation, type Profile, REVIEWER, REVIEWER_MIN_FILES, REVIEWER_MIN_LINES } from "./catalog";
import type { DiffFile } from "./diffmap";

export type Part = { files: DiffFile[]; lines: number };

// The part file from the run folder, as stream.ts gives a Read target.
export const partFile = (n: number) => `context/parts/part-${n}.md`;

type Sized = { file: DiffFile; key: string; segs: string[]; lines: number };

// A deleted file has only its old path.
const keyOf = (f: DiffFile) => f.path ?? f.oldPath ?? "";
const fits = (lines: number, files: number) => lines < REVIEWER_MIN_LINES && files < REVIEWER_MIN_FILES;
const total = (xs: Sized[]) => xs.reduce((n, x) => n + x.lines, 0);
// The folder of x at depth, or null when x is a file at that depth.
const folderAt = (x: Sized, depth: number) => (x.segs.length > depth + 1 ? x.segs[depth] : null);

// xs: in key order, with the same first depth path segments. Key order keeps the files of one folder adjacent.
function split(xs: Sized[], depth: number): Sized[][] {
  if (fits(total(xs), xs.length)) return [xs];
  const children: Sized[][] = [];
  for (const x of xs) {
    const last = children.at(-1);
    const folder = folderAt(x, depth);
    if (folder !== null && last && folderAt(last[0] as Sized, depth) === folder) last.push(x);
    else children.push([x]);
  }
  const out: Sized[][] = [];
  let cur: Sized[] = [];
  for (const c of children) {
    if (fits(total(c), c.length)) {
      if (cur.length && !fits(total(cur) + total(c), cur.length + c.length)) {
        out.push(cur);
        cur = [];
      }
      cur.push(...c);
      continue;
    }
    if (cur.length) out.push(cur);
    cur = [];
    // A file at or above the line limit is a part alone.
    out.push(...(c.length === 1 ? [c] : split(c, depth + 1)));
  }
  if (cur.length) out.push(cur);
  return out;
}

// Each file counts its changed rows, as delegation() does. Each part stays under both R8 limits, unless it is one file. Each file is in
// exactly one part, and the parts in order list the files in path order.
export function splitParts(files: DiffFile[]): Part[] {
  const xs = files
    .map((file) => {
      const key = keyOf(file);
      return { file, key, segs: key.split("/"), lines: file.rows.filter((r) => r.kind !== "ctx").length };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return xs.length ? split(xs, 0).map((p) => ({ files: p.map((x) => x.file), lines: total(p) })) : [];
}

// The parts of a review run: only the variant "parts" with delegation auto. The caller checks the run kind.
export const partsOf = (p: Profile, files: DiffFile[]): Part[] =>
  p.variants.includes("parts") && delegation(p, files) === "auto" ? splitParts(files) : [];

// The text of part n of m. jobs.ts writes the UNTRUSTED banner before it, because paths are PR data.
export function partText(p: Part, n: number, m: number): string {
  const rows = p.files.map((f) => {
    const count = (kind: "add" | "del") => f.rows.filter((r) => r.kind === kind).length;
    const renamed = f.path !== null && f.oldPath !== null && f.oldPath !== f.path ? ` (renamed from ${f.oldPath})` : "";
    const deleted = f.path === null ? " (deleted)" : "";
    return `- ${keyOf(f)}${renamed}${deleted}: +${count("add")} -${count("del")}${f.binary ? ", binary" : ""}`;
  });
  return [`# Part ${n} of ${m}`, "", ...rows, ""].join("\n");
}

// The numbers of the parts whose file no rl-reviewer call read. rl-main calls have no parent. The target rule is that of judge.ts
// unreadAlways.
export function unreadParts(events: RunEvent[], count: number): number[] {
  const calls = new Set(events.filter((e) => e.tool === "Agent" && e.agent === REVIEWER).map((e) => e.id));
  const read = new Set(
    events
      .filter((e) => e.tool === "Read" && e.status === "ok" && e.parent !== null && calls.has(e.parent))
      .map((e) => e.target.replace(/^(\.\/)+/, "")),
  );
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => !read.has(partFile(n)));
}

// One coverage line for each part that no rl-reviewer call read.
export const partNotes = (events: RunEvent[], parts: Part[]): string[] =>
  unreadParts(events, parts.length).map((n) => {
    const k = parts[n - 1]?.files.length ?? 0;
    return `Part ${n} of ${parts.length} (${k} file${k === 1 ? "" : "s"}) got no ${REVIEWER} call.`;
  });
