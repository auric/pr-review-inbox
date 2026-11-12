// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The cheap check of docs/plans/review-v2/review-ideas.md idea 2: are missed must-finds near a PR thread more often than found ones?
// It reads only the result file and the case files of the local set. The output holds counts only: no case ID, path, or text.
// Usage: bun run eval:threads <result.json>. Exit codes: 0 done, 2 a usage error, an unreadable file, or a result of another build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type EvalThreadComment, localCaseFile, rereviewDir, setDir } from "./cases";
import { readResult } from "./compare";
import { localRefusal } from "./rescore";
import { type EvalResult, matches, mustFind, overlaps } from "./score";

export const USAGE = "Usage: bun run eval:threads <result.json>";
// review-ideas.md idea 2: a thread within 10 lines of the must-find.
export const NEAR_LINES = 10;

export type ThreadCheck = {
  runs: number;
  cases: number;
  withThreads: number;
  missed: number;
  missedNear: number;
  found: number;
  foundNear: number;
};

// threads: the thread comments of each case by case ID. Only a root has a place, and its replies share it. The must-finds and the
// match rule are those of recall (score.ts): the volume of the result, the main group, and the tolerance of the result.
export function threadCheck(r: EvalResult, threads: Map<string, EvalThreadComment[]>): ThreadCheck {
  const byId = new Map(r.cases.map((c) => [c.id, c]));
  const n: ThreadCheck = { runs: 0, cases: byId.size, withThreads: 0, missed: 0, missedNear: 0, found: 0, foundNear: 0 };
  for (const id of byId.keys()) if (threads.get(id)?.length) n.withThreads++;
  for (const run of r.runs) {
    const c = byId.get(run.case);
    if (!c) continue;
    n.runs++;
    const shown = run.items.filter((i) => i.group === "main");
    const spots = (threads.get(c.id) ?? []).flatMap((t) =>
      t.path !== undefined && t.side !== undefined && t.lines ? [{ path: t.path, side: t.side, lines: t.lines }] : [],
    );
    for (const b of mustFind(c, r.volume ?? null)) {
      const near = spots.some((p) =>
        [b, ...(b.alt ?? [])].some(
          (s) => s.path === p.path && s.side === p.side && overlaps(p.lines, [s.lines[0] - NEAR_LINES, s.lines[1] + NEAR_LINES]),
        ),
      );
      const hit = shown.some((i) => matches(i, b, r.tolerance ?? 0));
      n[hit ? "found" : "missed"]++;
      if (near) n[hit ? "foundNear" : "missedNear"]++;
    }
  }
  return n;
}

export const checkText = (n: ThreadCheck) =>
  [
    `Idea 2 check: ${n.runs} runs of ${n.cases} cases. ${n.withThreads} cases have PR threads.`,
    `Missed must-finds: ${n.missed}. With a thread comment within ${NEAR_LINES} lines in the same file: ${n.missedNear}.`,
    `Found must-finds: ${n.found}. With a thread comment within ${NEAR_LINES} lines in the same file: ${n.foundNear}.`,
  ].join("\n");

export function main(argv: string[]): number {
  if (argv.length !== 1) {
    console.error(USAGE);
    return 2;
  }
  let r: EvalResult;
  try {
    r = readResult(argv[0] as string);
  } catch {
    console.error(`The result file does not load.\n${USAGE}`);
    return 2;
  }
  if (r.set !== "local") {
    console.error("Give a result of the local set. Only its cases hold PR threads.");
    return 2;
  }
  const dir = r.rereview ? rereviewDir() : setDir("local");
  const refused = localRefusal(r, dir);
  if (refused) {
    console.error(refused);
    return 2;
  }
  const threads = new Map<string, EvalThreadComment[]>();
  try {
    for (const c of r.cases)
      threads.set(c.id, localCaseFile.parse(JSON.parse(readFileSync(join(dir, c.id, "case.json"), "utf8"))).threads ?? []);
  } catch {
    console.error("A case file does not load. Build the set again with bun run eval:local.");
    return 2;
  }
  console.log(checkText(threadCheck(r, threads)));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
