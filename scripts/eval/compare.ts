// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Prints the scores of eval result files (docs/plans/review-v2/spec.md section 4.3).
// Usage: bun run eval:compare <a.json> <b.json>. Exit codes: 0 done, 2 a usage error, an unreadable file, or a refusal().
import { readFileSync } from "node:fs";
import { type EvalResult, METRICS, type Metric, type Score, type Stat, score } from "./score";

const LABEL: Record<Metric, string> = {
  recall: "recall: seeded bugs with a shown finding",
  humanRecall: "human recall: your own inline comments with a shown finding (local set)",
  precision: "precision: shown findings that match a bug or one of your own comments",
  trapRate: "trap rate: shown findings on a trap, per trap",
  noise: "noise: shown findings on no bug and no trap, per case",
  falsePositives: "false positives: shown findings on no bug, trap hits included, per case",
  extras: "extras matched: shown findings on a known real issue that is no seeded bug, per case",
  severityOk: "severity ok: found bugs at or above their minimum severity",
  candidateRecall: "candidate recall: bugs that any finding matched, hidden ones included",
  reRaises: "re-raises: shown new findings on an earlier finding that you posted or discarded, per case (--rereview)",
  verdictOk: "verdict ok: posted earlier findings whose fixed verdict matches your later resolve (--rereview)",
  minutes: "minutes per case",
  costUsd: "cost per case in USD, as the CLI reports it",
  notCompleted: "runs that did not complete, per repeat",
};
const RATE = new Set<Metric>(["recall", "humanRecall", "precision", "trapRate", "severityOk", "candidateRecall", "verdictOk"]);
const DIGITS: Record<Metric, number> = {
  reRaises: 2,
  verdictOk: 1,
  recall: 1,
  humanRecall: 1,
  precision: 1,
  trapRate: 1,
  noise: 2,
  falsePositives: 2,
  extras: 2,
  severityOk: 1,
  candidateRecall: 1,
  minutes: 1,
  costUsd: 3,
  notCompleted: 1,
};

const num = (m: Metric, x: number) => (RATE.has(m) ? `${(x * 100).toFixed(DIGITS[m])}%` : x.toFixed(DIGITS[m]));
const cell = (m: Metric, s: Stat) =>
  s === null ? "-" : s.min === s.max ? num(m, s.mean) : `${num(m, s.mean)} (${num(m, s.min)} to ${num(m, s.max)})`;
const delta = (m: Metric, a: Stat, b: Stat) => {
  if (a === null || b === null) return "-";
  const d = RATE.has(m) ? (b.mean - a.mean) * 100 : b.mean - a.mean;
  return `${d >= 0 ? "+" : ""}${d.toFixed(DIGITS[m])}${RATE.has(m) ? " pts" : ""}`;
};

function table(rows: string[][]) {
  const w = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(w[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const list = (s: Set<string>) => (s.size ? [...s].sort().join(", ") : "unknown");
// The models that ran: the init model and the subagent models of each run.
const usedModels = (r: EvalResult) => new Set(r.runs.flatMap((x) => x.models ?? (x.model ? [x.model] : [])));
const initModels = (r: EvalResult) => new Set(r.runs.flatMap((x) => (x.model ? [x.model] : [])));
// The effort that ran: the --effort value, else the default effort that the user settings gave.
const usedEfforts = (r: EvalResult) =>
  new Set(r.runs.flatMap((x) => (x.effort === null ? [] : [x.effort === "default" ? (x.effortDefault ?? "default") : x.effort])));

// The verify mode that ran: the recorded flag result, else the mode of the stored profile. Prompt version 1 has no verify phase.
const verifierOf = (r: EvalResult) =>
  r.requested?.verifier ?? (r.profile.verifier as { mode?: string } | undefined)?.mode ?? "not recorded";

const header = (r: EvalResult) => {
  // A file made before "requested" existed does not record the flags. The models and efforts that ran still show.
  const q = r.requested ?? { model: "not recorded", effort: "not recorded" };
  const runs = `${r.cases.length} case${r.cases.length === 1 ? "" : "s"} x ${r.repeat}`;
  const rescored = r.rescoredAt ? `, re-scored ${r.rescoredAt}` : "";
  const set = `set ${r.set ?? "v1"}${r.fingerprint ? ` (fingerprint ${r.fingerprint.slice(0, 12)})` : ""}, tolerance ${r.tolerance ?? 0} lines`;
  return `commit ${r.commit}${r.dirty ? " (uncommitted changes)" : ""}, ${set}${rescored}, prompt version ${r.promptVersion}, profile ${r.profile.id}${r.profileVersion === undefined ? "" : ` of profile version ${r.profileVersion}`} (revision ${r.profile.revision.slice(0, 8)}), volume ${r.volume ?? "none"}, CLI ${r.cliVersion}, model ${q.model} (ran ${list(usedModels(r))}), effort ${q.effort} (ran ${list(usedEfforts(r))}), verifier ${verifierOf(r)}, ${r.runner} CLI, ${runs}`;
};

export function summaryText(r: EvalResult, s: Score = score(r)): string {
  const rows = [["metric", "all cases"], ...METRICS.map((m) => [LABEL[m], cell(m, s.suite[m])])];
  const ids = Object.keys(s.cases);
  const perCase = [
    ["case", "recall", "precision", "false positives", "noise", "minutes"],
    ...ids.map((id) => {
      const c = s.cases[id] as Score["cases"][string];
      return [
        id,
        cell("recall", c.recall),
        cell("precision", c.precision),
        cell("falsePositives", c.falsePositives),
        cell("noise", c.noise),
        cell("minutes", c.minutes),
      ];
    }),
  ];
  return [header(r), "", table(rows), "", table(perCase)].join("\n");
}

// One row per metric: the "all cases" numbers of two scores and the delta.
export function suiteDelta(a: Score, b: Score, names: [string, string]): string {
  return table([
    ["metric", ...names, "delta"],
    ...METRICS.map((m) => [LABEL[m], cell(m, a.suite[m]), cell(m, b.suite[m]), delta(m, a.suite[m], b.suite[m])]),
  ]);
}

// Case truth that differs between two files: the numbers of that case do not compare.
const truth = (r: EvalResult) =>
  new Map(r.cases.map((c) => [c.id, JSON.stringify([c.head, c.bugs, c.traps, c.extras ?? [], c.human ?? [], c.earlier ?? []])]));

// docs/plans/review-v3.md WP-V1: two results compare only on the same case set and the same tolerance. Else the reason, for exit 2.
export function refusal(a: EvalResult, b: EvalResult): string | null {
  if (!!a.rereview !== !!b.rereview)
    return "A and B ran different modes: one ran --rereview, the other did not. Compare two --rereview results.";
  if ((a.fingerprint ?? null) !== (b.fingerprint ?? null))
    return `A and B ran different case sets: fingerprint ${a.fingerprint?.slice(0, 12) ?? "none"} and ${b.fingerprint?.slice(0, 12) ?? "none"}. Run both on one build of the local set and with the same --cases.`;
  if ((a.tolerance ?? 0) !== (b.tolerance ?? 0))
    return `A and B use different tolerances: ${a.tolerance ?? 0} and ${b.tolerance ?? 0} lines. Re-score one with bun run eval:rescore --tolerance.`;
  return null;
}

export function compareText(a: EvalResult, b: EvalResult): string {
  const sa = score(a);
  const sb = score(b);
  const ta = truth(a);
  const tb = truth(b);
  const out = [`A: ${header(a)}`, `B: ${header(b)}`];
  const only = [...new Set([...ta.keys(), ...tb.keys()])].filter((id) => !(ta.has(id) && tb.has(id)));
  if (only.length) out.push(`Cases in one file only: ${only.join(", ")}. The "all cases" rows do not compare.`);
  const changed = [...ta.keys()].filter((id) => tb.has(id) && ta.get(id) !== tb.get(id));
  if (changed.length) out.push(`Cases whose fixture changed between A and B: ${changed.join(", ")}. Their numbers do not compare.`);
  // The flags compare only when both files record them. A file made before "models" existed records only the init model of each run.
  const qa = a.requested;
  const qb = b.requested;
  const same = (x: Set<string>, y: Set<string>) => list(x) === list(y);
  const all = (r: EvalResult) => r.runs.every((x) => x.models !== undefined);
  const ran = all(a) && all(b) ? usedModels : initModels;
  if ((qa && qb && qa.model !== qb.model) || !same(ran(a), ran(b))) out.push("A and B used different models. The numbers do not compare.");
  if ((qa && qb && qa.effort !== qb.effort) || !same(usedEfforts(a), usedEfforts(b)))
    out.push("A and B used different efforts. The numbers do not compare.");
  const known = verifierOf(a) !== "not recorded" && verifierOf(b) !== "not recorded";
  if (known && verifierOf(a) !== verifierOf(b))
    out.push(`A and B used different verify modes: ${verifierOf(a)} and ${verifierOf(b)}. The numbers do not compare.`);
  // The revision hashes each profile field that changes the run, so equal revisions mean equal profiles whatever the versions say.
  if (a.profile.revision !== b.profile.revision)
    out.push(
      `A and B used different profiles: revision ${a.profile.revision.slice(0, 8)} of profile version ${a.profileVersion ?? "not recorded"}, revision ${b.profile.revision.slice(0, 8)} of profile version ${b.profileVersion ?? "not recorded"}. The numbers do not compare.`,
    );
  const ids = [...ta.keys()].filter((id) => tb.has(id)).sort();
  for (const m of METRICS) {
    const rows = [
      ["case", "A", "B", "delta"],
      ["all cases", cell(m, sa.suite[m]), cell(m, sb.suite[m]), delta(m, sa.suite[m], sb.suite[m])],
      ...ids.map((id) => {
        const x = sa.cases[id]?.[m] ?? null;
        const y = sb.cases[id]?.[m] ?? null;
        return [id, cell(m, x), cell(m, y), delta(m, x, y)];
      }),
    ];
    out.push("", LABEL[m], table(rows));
  }
  return out.join("\n");
}

export function readResult(path: string): EvalResult {
  const r = JSON.parse(readFileSync(path, "utf8")) as EvalResult;
  if (r.format !== 1 || !Array.isArray(r.cases) || !Array.isArray(r.runs)) throw new Error(`${path} is not an eval result file.`);
  return r;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length !== 2) {
    console.error("Usage: bun run eval:compare <a.json> <b.json>");
    process.exit(2);
  }
  try {
    const [a, b] = [readResult(files[0] as string), readResult(files[1] as string)];
    const refused = refusal(a, b);
    if (refused) throw new Error(refused);
    console.log(compareText(a, b));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
