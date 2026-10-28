// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Scoring of an eval result file (docs/plans/review-v2/spec.md section 4.3). Pure: no file, no process, no clock.
import type { RunPhase, RunUsage, VerifySummary, Volume } from "../../src/shared/dto";
import type { AnchorState, Check, Coverage, DisplayGroup, Severity, Side } from "../../src/shared/review";
import type { RunStatus } from "../../src/shared/run-log";
import type { EvalBug, EvalExtra, EvalHuman, EvalSet, EvalTrap } from "./cases";

export type { Check, Severity, Volume };
// run.ts sets it with displayGroup of src/shared/review.ts. Scoring reads the stored group, so older result files keep their groups:
// prompt version 1 shows every finding, and version 2.0 has no verdicts, so its items are unchecked.
export type Group = DisplayGroup;

const RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 };

// One finding item of a run. path, side, line, lineEnd: the anchor that the app stored.
export type EvalItem = {
  path: string;
  side: Side;
  line: number;
  lineEnd: number;
  anchorState: AnchorState;
  severity: Severity;
  finderSeverity: Severity;
  verdict: string | null;
  // null: a run without a verify phase (prompt version 1).
  check: Check | null;
  group: Group;
  status: string;
  title: string;
  body: string;
  category: string;
  module: string | null;
  trigger: string | null;
  confidence: string;
  evidenceStatus: string;
  agent: string | null;
};

export type EvalDropped = { path: string; side: Side; line: number; lineEnd: number | null; severity: Severity; reason: string };

// status error: the harness failed before or around the run, see error.
export type CaseRun = {
  case: string;
  repeat: number;
  run: number | null;
  status: RunStatus | "error";
  errorKind: string | null;
  error: string | null;
  model: string | null;
  effort: string | null;
  effortDefault: string | null;
  // The init model and the subagent models of the run. Absent in files made before this field existed.
  models?: string[];
  startedAt: number | null;
  finishedAt: number | null;
  minutes: number | null;
  usage: RunUsage | null;
  // The coverage of the run summary. Skipped or unavailable entries make a run incomplete. Absent in files made before this field existed.
  coverage?: Coverage | null;
  // The verdict counts and the find and check phases of the run summary. usage is the sum of both phases. Absent in files made before
  // prompt version 2.1.
  verify?: VerifySummary | null;
  phases?: RunPhase[];
  items: EvalItem[];
  dropped: EvalDropped[];
  questions: number;
};

export type EvalCaseInfo = {
  id: string;
  title: string;
  language: string;
  changedLines: number;
  base: string;
  head: string;
  bugs: EvalBug[];
  traps: EvalTrap[];
  // Absent in files made before this field existed: none.
  extras?: EvalExtra[];
  // Local set only: your own inline comments.
  human?: EvalHuman[];
};

export type EvalResult = {
  format: 1;
  createdAt: string;
  commit: string;
  dirty: boolean;
  promptVersion: string;
  // The PROFILES_VERSION of the shipped profile values that ran (--profile-version). Absent in files made before this field existed.
  profileVersion?: number;
  cliVersion: string;
  runner: "real" | "fake";
  profile: Record<string, unknown> & { id: string; name: string; revision: string };
  volume: Volume | null;
  // The --model and --effort values of the run, or "default" for no flag. Absent in files made before this field existed.
  // verifier: the verify mode that ran, after --verifier. Absent in files made before the flag existed.
  requested?: { model: string; effort: string; verifier?: string };
  // The case set. Absent in files made before this field existed: v1.
  set?: EvalSet;
  // Set by eval:rescore, which replaces the bugs and traps of each case with the current fixture.
  rescoredAt?: string;
  // T: an item matches a bug, a human comment, or an extra within T lines of its range. Traps always use T = 0. Absent: 0.
  tolerance?: number;
  // Local set only: setFingerprint of the cases that ran.
  fingerprint?: string;
  repeat: number;
  cases: EvalCaseInfo[];
  runs: CaseRun[];
};

// The tolerance of a run on the local set (docs/plans/review-v3.md Q2). Fixture sets run with 0.
export const LOCAL_TOLERANCE = 3;

// Both ends inclusive (spec.md section 4.3).
export const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
type Spot = { path: string; side: Side; lines: [number, number] };
// An item on the main place or on any alt place of a bug or trap matches it. t widens each place by t lines on both ends.
const matches = (i: EvalItem, r: Spot & { alt?: Spot[] }, t = 0) =>
  [r, ...(r.alt ?? [])].some(
    (p) => i.path === p.path && i.side === p.side && overlaps([i.line, i.lineEnd], [p.lines[0] - t, p.lines[1] + t]),
  );

export const METRICS = [
  "recall",
  "humanRecall",
  "precision",
  "trapRate",
  "noise",
  "falsePositives",
  "extras",
  "severityOk",
  "candidateRecall",
  "minutes",
  "costUsd",
  "notCompleted",
] as const;
export type Metric = (typeof METRICS)[number];
export type Stat = { mean: number; min: number; max: number } | null;
export type Score = { suite: Record<Metric, Stat>; cases: Record<string, Record<Metric, Stat>> };

// The counts of one run of one case.
type Tally = {
  bugs: number;
  found: number;
  human: number;
  humanFound: number;
  shown: number;
  shownMatched: number;
  traps: number;
  trapHits: number;
  noise: number;
  extraHits: number;
  severityOk: number;
  candidates: number;
  minutes: number | null;
  costUsd: number | null;
  notCompleted: number;
};

// t: the tolerance of the result. Traps use t = 0 (docs/plans/review-v3.md WP-V1).
function tally(c: EvalCaseInfo, r: CaseRun, t: number): Tally {
  const shown = r.items.filter((i) => i.group === "main");
  const human = c.human ?? [];
  const found = c.bugs.filter((b) => shown.some((i) => matches(i, b, t)));
  let severityOk = 0;
  for (const b of found) {
    const best = Math.max(...shown.filter((i) => matches(i, b, t)).map((i) => RANK[i.severity]));
    if (best >= RANK[b.severityMin]) severityOk++;
  }
  // An item on your own comment is a true finding too. Only recall keeps the comments apart (humanRecall).
  const bugHit = (i: EvalItem) => c.bugs.some((b) => matches(i, b, t)) || human.some((h) => matches(i, h, t));
  // An item on an extra counts as neither a bug hit, nor noise, nor a false positive. It leaves the shown count.
  const extraHit = (i: EvalItem) => !bugHit(i) && (c.extras ?? []).some((x) => matches(i, x, t));
  const trapHit = (i: EvalItem) => !extraHit(i) && c.traps.some((x) => matches(i, x));
  const extraHits = shown.filter(extraHit).length;
  return {
    bugs: c.bugs.length,
    found: found.length,
    human: human.length,
    humanFound: human.filter((h) => shown.some((i) => matches(i, h, t))).length,
    shown: shown.length - extraHits,
    shownMatched: shown.filter(bugHit).length,
    traps: c.traps.length,
    trapHits: shown.filter((i) => !bugHit(i) && trapHit(i)).length,
    noise: shown.filter((i) => !bugHit(i) && !extraHit(i) && !trapHit(i)).length,
    extraHits,
    severityOk,
    candidates: c.bugs.filter((b) => r.items.some((i) => matches(i, b, t))).length,
    minutes: r.minutes,
    costUsd: r.usage ? r.usage.costUsd : null,
    notCompleted: r.status === "completed" ? 0 : 1,
  };
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const sum = (ts: Tally[], k: keyof Tally) => ts.reduce((s, t) => s + (t[k] ?? 0), 0);
// null when no run reports the value.
const meanOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

// The metrics of a set of case runs, pooled: recall is all found bugs over all bugs, noise and time are per case run.
function metrics(ts: Tally[]): Record<Metric, number | null> {
  return {
    recall: ratio(sum(ts, "found"), sum(ts, "bugs")),
    humanRecall: ratio(sum(ts, "humanFound"), sum(ts, "human")),
    precision: ratio(sum(ts, "shownMatched"), sum(ts, "shown")),
    trapRate: ratio(sum(ts, "trapHits"), sum(ts, "traps")),
    noise: ratio(sum(ts, "noise"), ts.length),
    falsePositives: ratio(sum(ts, "shown") - sum(ts, "shownMatched"), ts.length),
    extras: ratio(sum(ts, "extraHits"), ts.length),
    severityOk: ratio(sum(ts, "severityOk"), sum(ts, "found")),
    candidateRecall: ratio(sum(ts, "candidates"), sum(ts, "bugs")),
    minutes: meanOf(ts.map((t) => t.minutes)),
    costUsd: meanOf(ts.map((t) => t.costUsd)),
    notCompleted: sum(ts, "notCompleted"),
  };
}

// The mean, min, and max over repeats. A repeat with no value for the metric does not count.
function stats(perRepeat: Record<Metric, number | null>[]): Record<Metric, Stat> {
  const out = {} as Record<Metric, Stat>;
  for (const m of METRICS) {
    const v = perRepeat.map((r) => r[m]).filter((x): x is number => x !== null);
    out[m] = v.length ? { mean: v.reduce((s, x) => s + x, 0) / v.length, min: Math.min(...v), max: Math.max(...v) } : null;
  }
  return out;
}

export function score(r: EvalResult): Score {
  const byId = new Map(r.cases.map((c) => [c.id, c]));
  const runs = r.runs.flatMap((x) => {
    const c = byId.get(x.case);
    return c ? [{ repeat: x.repeat, case: c.id, t: tally(c, x, r.tolerance ?? 0) }] : [];
  });
  const repeats = [...new Set(runs.map((x) => x.repeat))].sort((a, b) => a - b);
  const suite = stats(repeats.map((n) => metrics(runs.filter((x) => x.repeat === n).map((x) => x.t))));
  const cases: Record<string, Record<Metric, Stat>> = {};
  for (const c of r.cases) {
    const mine = runs.filter((x) => x.case === c.id);
    if (mine.length) cases[c.id] = stats(mine.map((x) => metrics([x.t])));
  }
  return { suite, cases };
}

// ---------- Reply cases (docs/plans/review-v2/spec.md section 2.13, `--replies`) ----------

// judgement: the accepted values. action: the wanted action, absent for any. cites: the threads that the reply must cite.
export type ReplyExpect = { thread: number; judgement: string[]; action?: "reply" | "none"; cites: number[] };
export type ReplyCaseInfo = { id: string; title: string; threads: number[]; expect: ReplyExpect[] };
// replies: one entry per stored reply draft of the run. status error: the harness failed, see error.
export type ReplyRun = {
  case: string;
  repeat: number;
  run: number | null;
  status: RunStatus | "error";
  error: string | null;
  minutes: number | null;
  usage: RunUsage | null;
  replies: { thread: number; judgement: string | null; action: string; cites: number[] }[];
};
export type ReplyEvalResult = {
  format: 1;
  kind: "replies";
  createdAt: string;
  commit: string;
  dirty: boolean;
  promptVersion: string;
  cliVersion: string;
  runner: "real" | "fake";
  profile: Record<string, unknown> & { id: string; name: string; revision: string };
  requested: { model: string; effort: string };
  repeat: number;
  cases: ReplyCaseInfo[];
  runs: ReplyRun[];
};
// The share of runs whose replies meet each expectation, per check and in total. null: no run of the case.
export type ReplyScore = Record<string, { runs: number; judgement: number; action: number; cites: number; pass: number } | null>;

// Judgement, action, and cites only (spec.md section 2.13). A run passes when every expectation of its case holds.
export function scoreReplies(r: ReplyEvalResult): ReplyScore {
  const out: ReplyScore = {};
  for (const c of r.cases) {
    const runs = r.runs.filter((x) => x.case === c.id);
    if (!runs.length) {
      out[c.id] = null;
      continue;
    }
    const checks = runs.map((x) => {
      const each = c.expect.map((e) => {
        const got = x.replies.find((y) => y.thread === e.thread);
        return {
          judgement: !!got && got.judgement !== null && e.judgement.includes(got.judgement),
          action: !!got && (e.action === undefined || got.action === e.action),
          cites: !!got && e.cites.every((t) => got.cites.includes(t)),
        };
      });
      const all = (k: "judgement" | "action" | "cites") => each.every((x) => x[k]);
      return { judgement: all("judgement"), action: all("action"), cites: all("cites") };
    });
    const share = (f: (x: (typeof checks)[number]) => boolean) => checks.filter(f).length / checks.length;
    out[c.id] = {
      runs: runs.length,
      judgement: share((x) => x.judgement),
      action: share((x) => x.action),
      cites: share((x) => x.cites),
      pass: share((x) => x.judgement && x.action && x.cites),
    };
  }
  return out;
}
