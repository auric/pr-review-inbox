// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Re-scores an eval result file with the bugs, traps, and extras of the current case fixtures, offline (docs/plans/review-v2/spec.md section 4.3).
// --tolerance N scores with another near-line tolerance (docs/plans/review-v3.md WP-V1). A local case keeps its stored truth, so a
// local result needs the build of the set that it ran (localRefusal).
// Usage: bun run eval:rescore <result.json> [--tolerance N] [--out <file>]. Exit codes: 0 done, 2 a usage error, an unreadable file, or a local result of another build of the set.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRepo, type EvalBug, type EvalExtra, type EvalTrap, findCase, rereviewDir, setDir, setFingerprint } from "./cases";
import { readResult, suiteDelta, summaryText } from "./compare";
import { type EvalResult, score } from "./score";

export type CaseTruth = { head: string; bugs: EvalBug[]; traps: EvalTrap[]; extras: EvalExtra[] };

// current: the truth of the current fixtures by case ID. A case with no fixture keeps its stored bugs and traps.
// tolerance: the new tolerance of the result, or undefined to keep it.
export function rescore(
  r: EvalResult,
  current: Map<string, CaseTruth>,
  at: string,
  tolerance?: number,
): { result: EvalResult; notes: string[] } {
  const notes: string[] = [];
  const changed: string[] = [];
  const cases = r.cases.map((c) => {
    const now = current.get(c.id);
    if (!now) {
      // The local set has no fixtures by design.
      if (r.set !== "local") notes.push(`Case ${c.id} has no fixture now. It keeps its stored bugs and traps.`);
      return c;
    }
    if (now.head !== c.head)
      notes.push(
        `Case ${c.id}: the fixture head is ${now.head.slice(0, 12)}, the runs reviewed ${c.head.slice(0, 12)}. Its numbers can be wrong.`,
      );
    if (JSON.stringify([c.bugs, c.traps, c.extras ?? []]) !== JSON.stringify([now.bugs, now.traps, now.extras])) changed.push(c.id);
    return { ...c, bugs: now.bugs, traps: now.traps, extras: now.extras };
  });
  notes.push(changed.length ? `Cases with new bugs, traps, or extras: ${changed.join(", ")}.` : "No case has new bugs, traps, or extras.");
  if (tolerance !== undefined && tolerance !== (r.tolerance ?? 0))
    notes.push(`The tolerance goes from ${r.tolerance ?? 0} to ${tolerance} lines.`);
  return { result: { ...r, cases, rescoredAt: at, ...(tolerance !== undefined && { tolerance }) }, notes };
}

// null, or why a local result does not fit the cases in dir. dir: the cases folder of the set. run.ts hashes all selected cases, so a
// stopped run also fails here.
export function localRefusal(r: EvalResult, dir: string): string | null {
  if (r.set !== "local") return null;
  const short = (f: string) => f.slice(0, 12);
  if (!r.fingerprint) return "The local result has no set fingerprint. Run the eval again on the current build of the set.";
  const ids = [...new Set(r.runs.map((x) => x.case))];
  const missing = ids.filter((id) => !existsSync(join(dir, id, "case.json")));
  if (missing.length)
    return `The local set has no case ${missing.join(", ")} now. The result ran set ${short(r.fingerprint)}. Run the eval again on the current build.`;
  const now = setFingerprint(
    ids.map((id) => ({
      id,
      hash: createHash("sha256")
        .update(readFileSync(join(dir, id, "case.json"), "utf8"))
        .digest("hex"),
    })),
  );
  return now === r.fingerprint
    ? null
    : `The result ran local set ${short(r.fingerprint)}, but its cases now have fingerprint ${short(now)}. A new build changed the cases, or the run stopped before its last case. Rescore keeps the stored truth, so it would mix two sets. Run the eval again on the current build.`;
}

// The head commit of each fixture comes from the same deterministic build as an eval run.
async function currentTruth(r: EvalResult): Promise<Map<string, CaseTruth>> {
  const tmp = mkdtempSync(join(tmpdir(), "rl-eval-rescore-"));
  try {
    const out = new Map<string, CaseTruth>();
    for (const c of r.cases) {
      const fx = findCase(c.id);
      if (!fx) continue;
      const repo = await buildRepo(fx, mkdtempSync(join(tmp, `${c.id}-`)));
      out.set(c.id, { head: repo.head, bugs: fx.bugs, traps: fx.traps, extras: fx.extras ?? [] });
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function main(argv: string[]): Promise<number> {
  let file: string;
  let out: string | undefined;
  let tolerance: number | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: { out: { type: "string" }, tolerance: { type: "string" } },
    });
    if (positionals.length !== 1) throw new Error("Give one result file.");
    file = positionals[0] as string;
    out = values.out;
    tolerance = values.tolerance === undefined ? undefined : Number(values.tolerance);
    if (tolerance !== undefined && !(Number.isInteger(tolerance) && tolerance >= 0))
      throw new Error("--tolerance must be a whole number of lines, 0 or more.");
  } catch (e) {
    console.error(`${(e as Error).message}\nUsage: bun run eval:rescore <result.json> [--tolerance N] [--out <file>]`);
    return 2;
  }
  let before: EvalResult;
  try {
    before = readResult(file);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const refused = localRefusal(before, before.rereview ? rereviewDir() : setDir("local"));
  if (refused) {
    console.error(refused);
    return 2;
  }
  const { result, notes } = rescore(before, await currentTruth(before), new Date().toISOString(), tolerance);
  console.log([`Re-scored ${file} with the current case fixtures.`, ...notes, ""].join("\n"));
  console.log(`${suiteDelta(score(before), score(result), ["stored", "current"])}\n\n${summaryText(result)}`);
  if (out) {
    writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Wrote ${resolve(out)}.`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
