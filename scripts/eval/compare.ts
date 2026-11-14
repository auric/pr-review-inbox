// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Prints the scores of eval result files (docs/plans/review-v2/spec.md section 4.3).
// Usage: bun run eval:compare <a.json> <b.json>. Exit codes: 0 done, 2 a usage error, an unreadable file, or a refusal().
import { readFileSync } from "node:fs";
import {
  BOOTSTRAP,
  EVIDENCE_LABELS,
  type EvalResult,
  type EvidenceLabel,
  type EvidenceRow,
  type Grounding,
  METRICS,
  type Metric,
  pairedDelta,
  type Score,
  type Stat,
  score,
} from "./score";

const LABEL: Record<Metric, string> = {
  groundedRecall: "grounded recall: counted must-finds that a shown finding matches, by the matcher",
  groundedPrecision: "grounded precision: shown findings that claim a must-find, over those that claim a must-find or a trap",
  groundedNoise: "grounded noise: shown findings that claim no gold item, per case",
  recall: "recall: seeded bugs with a shown finding",
  humanRecall: "human recall: your own inline comments with a shown finding (local set)",
  precision: "precision: shown findings that match a bug or one of your own comments",
  trapRate: "trap rate: shown findings on a trap, per trap",
  noise: "noise: shown findings on no bug and no trap, per case",
  falsePositives: "false positives: shown findings on no bug, trap hits included, per case",
  extras: "extras matched: shown findings on a known real issue that is no seeded bug, per case",
  severityOk: "severity ok: found bugs at or above their minimum severity",
  candidateRecall: "candidate recall: bugs that any finding matched, hidden ones included",
  bugOpened: "bug opened: seeded bugs whose file the finder read or diffed by path",
  agentCalls: "rl-reviewer calls per case",
  parts: "part files per case (variant parts)",
  partsRead: "parts read: part files that an rl-reviewer call read, per case",
  reRaises: "re-raises: shown new findings on an earlier finding that you posted or discarded, per case (--rereview)",
  verdictOk: "verdict ok: posted earlier findings whose fixed verdict matches your later resolve (--rereview)",
  minutes: "minutes per case",
  costUsd: "cost per case in USD, as the CLI reports it",
  notCompleted: "runs that did not complete, per repeat",
  groundedRaised: "grounded raised: counted must-finds that any finding matches, hidden ones included",
  lossMain: "verifier loss, main: counted must-finds whose best finding is in main and not refuted",
  lossDemoted: "verifier loss, demoted: counted must-finds whose best finding is refuted but stays in the list",
  lossFolded: "verifier loss, folded: counted must-finds whose best finding is folded and not refuted",
  lossDuplicate: "verifier loss, duplicate: counted must-finds whose best finding is a hidden duplicate",
  lossRefuted: "verifier loss, refuted: counted must-finds whose best finding is hidden as refuted",
  refutedShown: "refuted shown: refuted findings that stay in main, per case",
  augmentedPrecision: "augmented precision (diagnostic): shown findings that claim a must-find or that the judge gives tp",
  augmentedRecall: "augmented recall (diagnostic): found must-finds and new judge tp, over must-finds and new judge tp",
  newTp: "new tp (diagnostic): unmatched shown findings that the judge gives tp, per case",
  severityAbove: "severity above: unmatched judge tp whose app severity is above the judge severity",
};
const RATE = new Set<Metric>([
  "recall",
  "humanRecall",
  "precision",
  "trapRate",
  "severityOk",
  "candidateRecall",
  "bugOpened",
  "verdictOk",
  "groundedRecall",
  "groundedPrecision",
  "groundedRaised",
  "lossMain",
  "lossDemoted",
  "lossFolded",
  "lossDuplicate",
  "lossRefuted",
  "augmentedPrecision",
  "augmentedRecall",
  "severityAbove",
]);
const DIGITS: Record<Metric, number> = {
  groundedRecall: 1,
  groundedPrecision: 1,
  groundedNoise: 2,
  groundedRaised: 1,
  lossMain: 1,
  lossDemoted: 1,
  lossFolded: 1,
  lossDuplicate: 1,
  lossRefuted: 1,
  refutedShown: 2,
  augmentedPrecision: 1,
  augmentedRecall: 1,
  newTp: 2,
  severityAbove: 1,
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
  bugOpened: 1,
  agentCalls: 1,
  parts: 1,
  partsRead: 1,
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

// The rl-reviewer effort of the stored profile. Files made before the reviewer field existed: not recorded.
const reviewerEffortOf = (r: EvalResult) => {
  const x = r.profile.reviewer as { effort?: string | null } | undefined;
  return x === undefined ? "not recorded" : (x.effort ?? "default");
};

// The verify mode that ran: the recorded flag result, else the mode of the stored profile. Prompt version 1 has no verify phase.
const verifierOf = (r: EvalResult) =>
  r.requested?.verifier ?? (r.profile.verifier as { mode?: string } | undefined)?.mode ?? "not recorded";

const header = (r: EvalResult) => {
  // A file made before "requested" existed does not record the flags. The models and efforts that ran still show.
  const q = r.requested ?? { model: "not recorded", effort: "not recorded" };
  const runs = `${r.cases.length} case${r.cases.length === 1 ? "" : "s"} x ${r.repeat}`;
  const rescored = `${r.rescoredAt ? `, re-scored ${r.rescoredAt}` : ""}${r.refutedFolded ? ", refuted findings folded" : ""}`;
  const set = `set ${r.set ?? "v1"}${r.fingerprint ? ` (fingerprint ${r.fingerprint.slice(0, 12)})` : ""}, tolerance ${r.tolerance ?? 0} lines`;
  // review-quality-2026.md E2. A file made before these fields existed does not record them.
  const e2 = r.requested;
  const replay = e2?.replayOf ? `, finder replayed from ${e2.replayOf}` : "";
  return `commit ${r.commit}${r.dirty ? " (uncommitted changes)" : ""}, ${set}${rescored}, prompt version ${r.promptVersion}, profile ${r.profile.id}${r.profileVersion === undefined ? "" : ` of profile version ${r.profileVersion}`} (revision ${r.profile.revision.slice(0, 8)}), volume ${r.volume ?? "none"}, CLI ${r.cliVersion}, model ${q.model} (ran ${list(usedModels(r))}), effort ${q.effort} (ran ${list(usedEfforts(r))}), reviewer effort ${reviewerEffortOf(r)}, reviewer mode ${e2?.reviewerMode ?? "not recorded"}, verifier ${verifierOf(r)}, verifier effort ${e2?.verifierEffort ?? "not recorded"}${replay}, ${r.runner} CLI, ${runs}`;
};

const pct = (a: number, b: number) => (b === 0 ? "-" : `${((a / b) * 100).toFixed(1)}%`);
const per = (x: number | null) => (x === null ? "-" : x.toFixed(2));

// The tables of review-quality-2026.md E5 that are no metric row: the verifier confusion matrix, the slices, union recall, and the
// finder question sums. Empty parts stay out.
export function detailText(s: Score): string {
  const out = [
    s.grounded
      ? "Labels: grounded metrics come from eval:label. Ship decisions use grounded metrics only."
      : "Labels: none. The grounded metrics show -. Run bun run eval:label (docs/eval/local.md).",
  ];
  if (s.confusion) {
    const verdicts = Object.keys(s.confusion).sort();
    out.push(
      "",
      "Verifier confusion: the label of each finding (gold item, else judge) by its verdict, all runs",
      table([["verdict", "tp", "fp"], ...verdicts.map((v) => [v, String(s.confusion?.[v]?.tp ?? 0), String(s.confusion?.[v]?.fp ?? 0)])]),
    );
  }
  if (s.slices.length)
    out.push(
      "",
      `Slices (${s.grounded ? "matcher" : "line match"}): must-finds over all runs, noise and judge fp per case run`,
      table([
        ["slice", "found", "recall", "case runs", "noise", "judge fp"],
        ...s.slices.map((x) => [
          x.name,
          `${x.found}/${x.mustFinds}`,
          pct(x.found, x.mustFinds),
          x.runs === null ? "-" : String(x.runs),
          per(x.noise),
          per(x.judgeFp),
        ]),
      ]),
    );
  const sec = s.security;
  if (sec)
    out.push(
      "",
      "Shown security findings (review-quality-2026.md item 10): shown findings with category security, per case run",
      table([
        ["case runs", "shown", "gold match", "judge tp", "judge fp", "no label"],
        [String(sec.runs), ...[sec.shown, sec.gold, sec.tp, sec.fp, sec.unlabeled].map((x) => per(sec.runs ? x / sec.runs : null))],
      ]),
    );
  if (s.union.length)
    out.push(
      "",
      `Union recall: counted must-finds that any of k repeats shows or raises, mean over the k-subsets: ${s.union
        .map((u) => `k=${u.k} shown ${(u.shown * 100).toFixed(1)}%, raised ${(u.raised * 100).toFixed(1)}%`)
        .join("; ")}.`,
    );
  if (s.recallBugs.length) {
    const found = s.recallBugs.map((x) => x.found);
    out.push(
      "",
      `Recall in bugs per repeat (${s.grounded ? "matcher" : "line match"}): ${s.recallBugs.map((x) => `${x.repeat}: ${x.found}/${x.mustFinds}`).join(", ")}. Spread: ${Math.max(...found) - Math.min(...found)} bugs.`,
    );
  }
  const q = s.finderQuestions;
  if (q) out.push("", `Finder questions, all runs: ${q.asked} asked, ${q.answered} answered, ${q.findings} findings, ${q.kept} kept.`);
  return out.join("\n");
}

// review-quality-2026.md item 8 gate: the evidence references by label (score.ts evidenceCheck). Counts only, no path and no text.
export function evidenceText(rows: Record<EvidenceLabel, EvidenceRow>): string {
  return [
    "Evidence references (review-quality-2026.md item 8 gate): the findings of all runs by label. Missing file: a reference names a file that is not in the head tree, also when the parse cut its path. Line out of file: a reference names line 0 or a line past the end of a head file. Shares are over the findings with path:line.",
    table([
      [
        "label",
        "findings",
        "no evidence field",
        "no path:line",
        "with path:line",
        "references",
        "missing file",
        "share",
        "line out of file",
        "share",
      ],
      ...EVIDENCE_LABELS.map((l) => {
        const x = rows[l];
        return [
          l,
          String(x.findings),
          String(x.unrecorded),
          String(x.noRef),
          String(x.withRef),
          String(x.refs),
          String(x.noFile),
          pct(x.noFile, x.withRef),
          String(x.pastEnd),
          pct(x.pastEnd, x.withRef),
        ];
      }),
    ]),
  ].join("\n");
}

// name: the label of a case in the rows. eval:ab passes ordinals, so its output holds no case ID.
export function summaryText(r: EvalResult, s: Score = score(r), name = (id: string) => id): string {
  const rows = [
    ["metric", "all cases", "mean per case"],
    ...METRICS.map((m) => [LABEL[m], cell(m, s.suite[m]), s.macro[m] === null ? "-" : num(m, s.macro[m])]),
  ];
  const ids = Object.keys(s.cases);
  const perCase = [
    ["case", "recall", "precision", "false positives", "noise", "bug opened", "rl-reviewer calls", "parts", "parts read", "minutes"],
    ...ids.map((id) => {
      const c = s.cases[id] as Score["cases"][string];
      return [
        name(id),
        cell("recall", c.recall),
        cell("precision", c.precision),
        cell("falsePositives", c.falsePositives),
        cell("noise", c.noise),
        cell("bugOpened", c.bugOpened),
        cell("agentCalls", c.agentCalls),
        cell("parts", c.parts),
        cell("partsRead", c.partsRead),
        cell("minutes", c.minutes),
      ];
    }),
  ];
  const { count, severities } = s.leftOut;
  const left = `Must-find items this volume cannot show: ${count}${severities.length ? ` (${severities.join(", ")})` : ""}.`;
  return [header(r), left, "", table(rows), "", table(perCase), "", detailText(s)].join("\n");
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

// revB: the profile revision of B to compare with A. eval:ab passes the candidate revision without its added variants and modules.
// g: the eval:label labels of A and B, when they exist.
export function compareText(
  a: EvalResult,
  b: EvalResult,
  name = (id: string) => id,
  revB = b.profile.revision,
  g: [Grounding | undefined, Grounding | undefined] = [undefined, undefined],
): string {
  const sa = score(a, g[0]);
  const sb = score(b, g[1]);
  const ta = truth(a);
  const tb = truth(b);
  const out = [
    `A: ${header(a)}`,
    `B: ${header(b)}`,
    `Must-find items this volume cannot show: A ${sa.leftOut.count}, B ${sb.leftOut.count}. Recall leaves them out.`,
  ];
  const only = [...new Set([...ta.keys(), ...tb.keys()])].filter((id) => !(ta.has(id) && tb.has(id)));
  if (only.length) out.push(`Cases in one file only: ${only.map(name).join(", ")}. The "all cases" rows do not compare.`);
  const changed = [...ta.keys()].filter((id) => tb.has(id) && ta.get(id) !== tb.get(id));
  if (changed.length)
    out.push(`Cases whose fixture changed between A and B: ${changed.map(name).join(", ")}. Their numbers do not compare.`);
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
  if (a.profile.revision !== revB)
    out.push(
      `A and B used different profiles: revision ${a.profile.revision.slice(0, 8)} of profile version ${a.profileVersion ?? "not recorded"}, revision ${revB.slice(0, 8)} of profile version ${b.profileVersion ?? "not recorded"}. The numbers do not compare.`,
    );
  const pd = pairedDelta(a, b, g[0], g[1]);
  if (pd) {
    const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
    // The blank line keeps the line out of the eval:ab head (ab.ts modeText).
    out.push(
      "",
      `Paired delta (information only): B - A hit rate per counted must-find, ${pd.grounded ? "matcher" : "line match"}: ${pts(pd.delta)} pts, 90% interval ${pts(pd.low)} to ${pts(pd.high)} pts (bootstrap over ${pd.groups} PR groups, ${pd.mustFinds} must-finds, seed ${BOOTSTRAP.seed}).`,
    );
  }
  const ids = [...ta.keys()].filter((id) => tb.has(id)).sort();
  for (const m of METRICS) {
    const rows = [
      ["case", "A", "B", "delta"],
      ["all cases", cell(m, sa.suite[m]), cell(m, sb.suite[m]), delta(m, sa.suite[m], sb.suite[m])],
      ...ids.map((id) => {
        const x = sa.cases[id]?.[m] ?? null;
        const y = sb.cases[id]?.[m] ?? null;
        return [name(id), cell(m, x), cell(m, y), delta(m, x, y)];
      }),
    ];
    out.push("", LABEL[m], table(rows));
  }
  out.push("", `A: ${detailText(sa)}`, "", `B: ${detailText(sb)}`);
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
    // label.ts imports this module, so it loads here.
    const { loadGrounding } = await import("./label");
    console.log(compareText(a, b, undefined, undefined, [loadGrounding(a), loadGrounding(b)]));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
