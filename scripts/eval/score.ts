// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Scoring of an eval result file (docs/plans/review-v2/spec.md section 4.3). Pure: no file, no process, no clock.
import { repoPath } from "../../src/server/review/validate";
import type { RunPhase, RunUsage, VerifySummary, Volume } from "../../src/shared/dto";
import {
  type AnchorState,
  bugClass,
  type Check,
  type Coverage,
  type DisplayGroup,
  displayGroup,
  type Severity,
  type Side,
} from "../../src/shared/review";
import type { RunStatus } from "../../src/shared/run-log";
import type { EvalBug, EvalEarlier, EvalExtra, EvalHuman, EvalSet, EvalTrap } from "./cases";

export type { Check, Severity, Volume };
// run.ts sets it with displayGroup of src/shared/review.ts. Scoring reads the stored group, so older result files keep their groups:
// prompt version 1 shows every finding, and version 2.0 has no verdicts, so its items are unchecked.
export type Group = DisplayGroup;

const RANK: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 3 };

// The severities that the volume never shows in the main group, from displayGroup. Recall leaves out the bugs of these severities.
export const unshowable = (volume: Volume | null): Severity[] =>
  (Object.keys(RANK) as Severity[]).filter((s) => displayGroup({ severity: s }, volume ?? undefined) !== "main");
// The bugs that recall counts under the volume of the result.
export const mustFind = (c: Pick<EvalCaseInfo, "bugs">, volume: Volume | null): EvalBug[] => {
  const out = unshowable(volume);
  return c.bugs.filter((b) => !out.includes(b.severityMin));
};

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
  // A re-review only: the copy of an earlier finding (payload carried). Absent in files made before this field existed: false.
  carried?: boolean;
  // The finder text of the finding (review-ideas.md idea 3). No metric reads them. Absent in files made before these fields existed.
  evidence?: string;
  anchorText?: string;
  cause?: { path: string; side: Side; line: number; lineEnd: number | null; anchorText: string };
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
  // A re-review only: the IDs of the posted earlier findings whose thread got a resolve proposal (a fixed verdict).
  resolves?: string[];
  // docs/plans/review-v3.md WP-V13 (run.ts runFacts): the rl-reviewer calls of the find phase, the repository paths that it opened, and
  // the most tool calls under one rl-reviewer call. Absent in files made before these fields existed.
  agentCalls?: number;
  opened?: string[];
  toolsPerCall?: number;
  // docs/plans/review-v3.md WP-V14 (run.ts partFacts): the part files of the run, and those that an rl-reviewer call read. Absent in
  // files made before these fields existed.
  parts?: number;
  partsRead?: number;
  // The counts of summary.finderQuestions (prompt version 2.7). Absent in files made before this field existed, and in a run without them.
  finderQuestions?: { asked: number; answered: number; findings: number; kept: number };
};

// An earlier finding of a re-review case (cases.ts evalEarlier). lines: its range at the head of the case, or null when the change from
// the earlier head to the head touches it. resolved: the later state of the thread of a posted finding, else null.
export type EarlierInfo = {
  id: string;
  path: string;
  side: Side;
  lines: [number, number] | null;
  status: EvalEarlier["status"];
  resolved: boolean | null;
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
  // A re-review case only: the findings of the earlier run.
  earlier?: EarlierInfo[];
  // The case fields of cases.ts for the slices of review-quality-2026.md E5. Absent in files made before these fields existed.
  clean?: true;
  group?: string;
  hasTask?: boolean;
  large?: boolean;
  task?: string;
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
  // verifier: the verify mode that ran, after --verifier. verifierEffort and reviewerMode: the values that ran, after
  // --verifier-effort and --reviewer-mode. Absent in files made before the flags existed. replayOf: the file name of the
  // --replay-find result. Absent: the finder ran.
  requested?: { model: string; effort: string; verifier?: string; verifierEffort?: string; reviewerMode?: string; replayOf?: string };
  // The case set. Absent in files made before this field existed: v1.
  set?: EvalSet;
  // Set by eval:rescore, which replaces the bugs and traps of each case with the current fixture.
  rescoredAt?: string;
  // T: an item matches a bug, a human comment, or an extra within T lines of its range. Traps always use T = 0. Absent: 0.
  tolerance?: number;
  // Local set only: setFingerprint of the cases that ran.
  fingerprint?: string;
  // --rereview: each case ran as a re-review after its seeded earlier run. Absent: false.
  rereview?: boolean;
  // eval:rescore --fold-refuted moved each refuted item of main to fold. Absent: false.
  refutedFolded?: boolean;
  // run.ts --resume: the checkout and the CLI version of each resume, in order. commit, dirty, and cliVersion above are those of the
  // first run. Absent: no resume.
  resumes?: { commit: string; dirty: boolean; cliVersion: string; at: string }[];
  repeat: number;
  cases: EvalCaseInfo[];
  runs: CaseRun[];
};

// A run that finished: completed, or incomplete with coverage gaps. A failed, cancelled, or error run did not.
export const finished = (r: Pick<CaseRun, "status">) => r.status === "completed" || r.status === "incomplete";
// judge.ts: a usage limit in the check phase ends the run incomplete, with verify.failed.kind usage_limit and no errorKind.
export const hitLimit = (r: Pick<CaseRun, "errorKind" | "verify">) =>
  r.errorKind === "usage_limit" || r.verify?.failed?.kind === "usage_limit";
// A run that run.ts --resume keeps and that counts toward a full result.
export const keptRun = (r: CaseRun) => finished(r) && !hitLimit(r);

// The tolerance of a run on the local set (docs/plans/review-v3.md Q2). Fixture sets run with 0.
export const LOCAL_TOLERANCE = 3;

// Both ends inclusive (spec.md section 4.3).
export const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];
type Spot = { path: string; side: Side; lines: [number, number] };
// An item on the main place or on any alt place of a bug or trap matches it. t widens each place by t lines on both ends.
export const matches = (i: EvalItem, r: Spot & { alt?: Spot[] }, t = 0) =>
  [r, ...(r.alt ?? [])].some(
    (p) => i.path === p.path && i.side === p.side && overlaps([i.line, i.lineEnd], [p.lines[0] - t, p.lines[1] + t]),
  );

// ---------- Gold items, matcher labels, and judge labels (docs/plans/review-v2/review-quality-2026.md E3, E4) ----------

export type GoldKind = "bug" | "human" | "trap" | "extra";
// key: the kind and the ID, because two kinds can use the same ID. An extra has no ID, so its key holds its index. text: the gold text,
// else note or why, because a fixture set has no text.
export type Gold = Spot & { key: string; kind: GoldKind; alt?: Spot[]; text: string };

// The order is the claim order below: bugs and your own comments first, then traps, then extras.
export function goldOf(c: Pick<EvalCaseInfo, "bugs" | "traps" | "extras" | "human">): Gold[] {
  const spot = (x: Spot & { alt?: Spot[] }) => ({ path: x.path, side: x.side, lines: x.lines, ...(x.alt && { alt: x.alt }) });
  return [
    ...c.bugs.map((b) => ({ ...spot(b), key: `bug:${b.id}`, kind: "bug" as const, text: b.text ?? b.note })),
    ...(c.human ?? []).map((h) => ({ ...spot(h), key: `human:${h.id}`, kind: "human" as const, text: h.text ?? h.note })),
    ...c.traps.map((x) => ({ ...spot(x), key: `trap:${x.id}`, kind: "trap" as const, text: x.text ?? x.why })),
    ...(c.extras ?? []).map((x, n) => ({ ...spot(x), key: `extra:${n}`, kind: "extra" as const, text: x.text ?? x.note })),
  ];
}

// The matcher compares an item and a gold item only when they share a file. An item has the files of its anchor and its cause. A gold
// item has its path and each alt path.
export const itemFiles = (i: Pick<EvalItem, "path" | "cause">) => [...new Set([i.path, ...(i.cause ? [i.cause.path] : [])])];
export const goldFiles = (g: Pick<Gold, "path" | "alt">) => [...new Set([g.path, ...(g.alt ?? []).map((p) => p.path)])];
export const shareFile = (a: string[], b: string[]) => a.some((f) => b.includes(f));

export const JUDGE_LEVELS = ["low", "medium", "high"] as const;
export type JudgeLevel = (typeof JUDGE_LEVELS)[number];
export type JudgeLabel = { label: "tp" | "fp"; severity: JudgeLevel; category: string; scope: string; why: string };
// The judge level of each app severity, from the severity lines of the finder (catalog.ts) and of the judge prompt (label.ts): blocker
// and major must be fixed before the merge (high), minor should be fixed (medium), nit can wait (low).
const LEVEL: Record<Severity, number> = { nit: 0, minor: 1, major: 2, blocker: 2 };

// matches: the gold keys that the matcher matched to the item, [] for none. undefined: a gold item in a file of the item has no matcher
// answer. judge: the judge label of the item, or undefined.
export type Grounding = {
  matches: (c: EvalCaseInfo, i: EvalItem) => readonly string[] | undefined;
  judge: (c: EvalCaseInfo, i: EvalItem) => JudgeLabel | undefined;
};

// ReviewBench 6.2.4 (review-quality-2026.md E3): shown items claim gold items in item order. Each item claims at most one, the first
// unclaimed one of its matches, and each gold item goes to one item. A shown item whose matches are all claimed gets null. An item
// outside main claims nothing and takes its first match. null: the judge labels the item.
export function goldLabels(gold: Gold[], items: EvalItem[], matched: (n: number) => readonly string[]): (Gold | null)[] {
  const taken = new Set<string>();
  return items.map((i, n) => {
    const m = matched(n);
    const shown = i.group === "main";
    const g = gold.find((x) => m.includes(x.key) && !(shown && taken.has(x.key))) ?? null;
    if (g && shown) taken.add(g.key);
    return g;
  });
}

// review-quality-2026.md E5, verifier loss: the state of an item after the check, in the order of visibility. demoted: a refuted
// finding that stays in the list (review.ts FindingPayload.demoted). folded: in fold and not refuted. duplicate, refuted: hidden.
export const STATES = ["main", "demoted", "folded", "duplicate", "refuted"] as const;
type State = (typeof STATES)[number];
const stateOf = (i: EvalItem): State =>
  i.group === "hidden"
    ? i.verdict === "duplicate"
      ? "duplicate"
      : "refuted"
    : i.verdict === "refuted"
      ? "demoted"
      : i.group === "main"
        ? "main"
        : "folded";

export const METRICS = [
  "groundedRecall",
  "groundedPrecision",
  "groundedNoise",
  "recall",
  "humanRecall",
  "precision",
  "trapRate",
  "noise",
  "falsePositives",
  "extras",
  "severityOk",
  "candidateRecall",
  "bugOpened",
  "agentCalls",
  "parts",
  "partsRead",
  "reRaises",
  "verdictOk",
  "minutes",
  "costUsd",
  "notCompleted",
  "incomplete",
  "groundedRaised",
  "lossMain",
  "lossDemoted",
  "lossFolded",
  "lossDuplicate",
  "lossRefuted",
  "refutedShown",
  "augmentedPrecision",
  "augmentedRecall",
  "newTp",
  "severityAbove",
] as const;
export type Metric = (typeof METRICS)[number];
export type Stat = { mean: number; min: number; max: number } | null;
// One slice of review-quality-2026.md E5. A gold slice counts the counted must-finds of its kind. A case slice counts the case runs of
// its kind, and their noise and unmatched shown items that the judge gives fp. null: no grounded number.
export type Slice = { name: string; mustFinds: number; found: number; runs: number | null; noise: number | null; judgeFp: number | null };
// leftOut: the bugs of all cases that recall leaves out under the volume, and their severities. grounded: the grounded metrics and the
// slices come from the matcher. macro: the mean over the cases of the case means. confusion: the label (gold or judge) of every item by
// its verdict, over all runs. union: unionRecall for k = 1 to the repeat count. finderQuestions: the sums over all runs. recallBugs:
// the found must-finds of each repeat, for the spread S_R in bugs of the ship rules (review-quality-2026.md section 2).
export type Score = {
  suite: Record<Metric, Stat>;
  cases: Record<string, Record<Metric, Stat>>;
  leftOut: { count: number; severities: Severity[] };
  grounded: boolean;
  macro: Record<Metric, number | null>;
  confusion: Record<string, { tp: number; fp: number }> | null;
  slices: Slice[];
  // review-quality-2026.md item 10: the shown findings with category security, summed over all runs. gold: they claim a gold item.
  // tp, fp, unlabeled: the judge label of the other ones. null: not grounded.
  security: Sec | null;
  union: { k: number; shown: number; raised: number }[];
  finderQuestions: { asked: number; answered: number; findings: number; kept: number } | null;
  recallBugs: { repeat: number; found: number; mustFinds: number }[];
};

export type Sec = { runs: number; shown: number; gold: number; tp: number; fp: number; unlabeled: number };
const SEC_KEYS = ["shown", "gold", "tp", "fp", "unlabeled"] as const;

// The counted must-finds (goldOf keys) that a shown item finds and that any item raises.
type Hits = { shown: Set<string>; raised: Set<string> };

// The grounded counts of one run (review-quality-2026.md E5). tp, fp: shown items that claim a bug or your own comment, or a trap.
// shown: shown items that claim no extra. unmatched: shown items that claim nothing. newTp, judgeFp, above: null when an unmatched
// shown item has no judge label. confusion: null when an item has neither a gold item nor a judge label.
type Ground = {
  hits: Hits;
  loss: Record<State, number>;
  tp: number;
  fp: number;
  shown: number;
  unmatched: number;
  newTp: number | null;
  judgeFp: number | null;
  above: number | null;
  confusion: Record<string, { tp: number; fp: number }> | null;
  security: Omit<Sec, "runs">;
};

// null: an item has no matcher answer.
function ground(c: EvalCaseInfo, r: CaseRun, volume: Volume | null, g: Grounding): Ground | null {
  const m = r.items.map((i) => g.matches(c, i));
  if (m.some((x) => x === undefined)) return null;
  const of = (n: number) => m[n] ?? [];
  const labels = goldLabels(goldOf(c), r.items, of);
  const counted = mustFind(c, volume).map((b) => `bug:${b.id}`);
  const on = (k: string, shownOnly: boolean) => r.items.filter((i, n) => of(n).includes(k) && (!shownOnly || i.group === "main"));
  const shownKeys = counted.filter((k) => on(k, true).length);
  const raisedKeys = counted.filter((k) => on(k, false).length);
  const loss = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<State, number>;
  for (const k of raisedKeys) {
    const best = STATES[Math.min(...on(k, false).map((i) => STATES.indexOf(stateOf(i))))];
    if (best) loss[best]++;
  }
  const shown = r.items.flatMap((i, n) => (i.group === "main" ? [{ i, gold: labels[n] ?? null }] : []));
  const unmatched = shown.filter((x) => x.gold === null).map((x) => ({ i: x.i, j: g.judge(c, x.i) }));
  const judged = unmatched.every((x) => x.j !== undefined);
  // The exact category text, as the verify rules of catalog.ts SECURITY2 match it.
  const sec = unmatched.filter((x) => x.i.category === "security");
  const count = (f: (x: (typeof unmatched)[number]) => boolean) => (judged ? unmatched.filter(f).length : null);
  const truth = r.items.map((i, n) => {
    const gl = labels[n];
    return gl ? (gl.kind === "trap" ? "fp" : "tp") : g.judge(c, i)?.label;
  });
  let confusion: Ground["confusion"] = null;
  if (truth.every((x) => x !== undefined)) {
    const rows: Record<string, { tp: number; fp: number }> = {};
    r.items.forEach((i, n) => {
      const row = rows[i.verdict ?? "none"] ?? { tp: 0, fp: 0 };
      rows[i.verdict ?? "none"] = row;
      row[truth[n] as "tp" | "fp"]++;
    });
    confusion = rows;
  }
  return {
    hits: { shown: new Set(shownKeys), raised: new Set(raisedKeys) },
    loss,
    tp: shown.filter((x) => x.gold?.kind === "bug" || x.gold?.kind === "human").length,
    fp: shown.filter((x) => x.gold?.kind === "trap").length,
    // An item on an extra leaves the shown count, as in the line match.
    shown: shown.filter((x) => x.gold?.kind !== "extra").length,
    unmatched: unmatched.length,
    newTp: count((x) => x.j?.label === "tp"),
    judgeFp: count((x) => x.j?.label === "fp"),
    above: count((x) => x.j?.label === "tp" && LEVEL[x.i.severity] > JUDGE_LEVELS.indexOf(x.j.severity)),
    confusion,
    security: {
      shown: shown.filter((x) => x.i.category === "security").length,
      gold: shown.filter((x) => x.i.category === "security" && x.gold !== null).length,
      tp: sec.filter((x) => x.j?.label === "tp").length,
      fp: sec.filter((x) => x.j?.label === "fp").length,
      unlabeled: sec.filter((x) => x.j === undefined).length,
    },
  };
}

// The counts of one run of one case. hits: by the line match. ground: by the matcher, null without labels.
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
  // The counted bugs of a run that records opened, and those whose file it opened. 0 and 0 for a run without opened.
  openedOf: number;
  bugOpened: number;
  agentCalls: number | null;
  parts: number | null;
  partsRead: number | null;
  rereview: boolean;
  reRaises: number;
  verdicts: number;
  verdictOk: number;
  minutes: number | null;
  costUsd: number | null;
  // A failed, cancelled, or error run. An incomplete run finished and counts in incomplete.
  notCompleted: number;
  incomplete: number;
  refutedShown: number;
  hits: Hits;
  ground: Ground | null;
};

// t: the tolerance of the result. Traps use t = 0 (docs/plans/review-v3.md WP-V1).
function tally(c: EvalCaseInfo, r: CaseRun, t: number, volume: Volume | null, g: Grounding | undefined): Tally {
  const shown = r.items.filter((i) => i.group === "main");
  const human = c.human ?? [];
  // docs/plans/review-v3.md WP-V3: a re-raise is a new item on an earlier finding that you posted or discarded. Its lines must be the
  // same at both heads. The copy of a carried finding is no re-raise.
  const decided = (c.earlier ?? []).flatMap((e) =>
    e.lines && (e.status === "posted" || e.status === "discarded") ? [{ path: e.path, side: e.side, lines: e.lines }] : [],
  );
  const scored = (c.earlier ?? []).filter((e) => e.status === "posted" && e.resolved !== null);
  const bugs = mustFind(c, volume);
  const found = bugs.filter((b) => shown.some((i) => matches(i, b, t)));
  // review-quality-2026.md E5: the denominator of recall, so candidateRecall - recall is the share that the check lost.
  const raised = bugs.filter((b) => r.items.some((i) => matches(i, b, t)));
  let severityOk = 0;
  for (const b of found) {
    const best = Math.max(...shown.filter((i) => matches(i, b, t)).map((i) => RANK[i.severity]));
    if (best >= RANK[b.severityMin]) severityOk++;
  }
  // An item on your own comment is a true finding too. Only recall keeps the comments apart (humanRecall).
  const bugHit = (i: EvalItem) => c.bugs.some((b) => matches(i, b, t)) || human.some((h) => matches(i, h, t));
  // A re-raise is noise, also on an extra.
  const reRaise = (i: EvalItem) => !i.carried && !bugHit(i) && decided.some((e) => matches(i, e, t));
  // An item on an extra counts as neither a bug hit, nor noise, nor a false positive. It leaves the shown count.
  const extraHit = (i: EvalItem) => !bugHit(i) && !reRaise(i) && (c.extras ?? []).some((x) => matches(i, x, t));
  const trapHit = (i: EvalItem) => !extraHit(i) && c.traps.some((x) => matches(i, x));
  const extraHits = shown.filter(extraHit).length;
  return {
    bugs: bugs.length,
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
    candidates: raised.length,
    openedOf: r.opened ? bugs.length : 0,
    // Any place of the bug counts: its main place or an alt place.
    bugOpened: r.opened ? bugs.filter((b) => [b, ...(b.alt ?? [])].some((p) => r.opened?.includes(p.path))).length : 0,
    agentCalls: r.agentCalls ?? null,
    parts: r.parts ?? null,
    partsRead: r.partsRead ?? null,
    rereview: c.earlier !== undefined,
    reRaises: shown.filter(reRaise).length,
    // A fixed verdict on a posted finding is right when you resolved its thread later. open and outdated give no proposal.
    verdicts: scored.length,
    verdictOk: scored.filter((e) => (r.resolves ?? []).includes(e.id) === e.resolved).length,
    minutes: r.minutes,
    costUsd: r.usage ? r.usage.costUsd : null,
    notCompleted: finished(r) ? 0 : 1,
    incomplete: r.status === "incomplete" ? 1 : 0,
    // review-quality-2026.md E5: refuted items of the protected classes stay in main (displayGroup). They count apart.
    refutedShown: shown.filter((i) => i.verdict === "refuted").length,
    hits: { shown: new Set(found.map((b) => `bug:${b.id}`)), raised: new Set(raised.map((b) => `bug:${b.id}`)) },
    ground: g ? ground(c, r, volume, g) : null,
  };
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
type Count = { [K in keyof Tally]: Tally[K] extends number | null ? K : never }[keyof Tally];
const sum = (ts: Tally[], k: Count) => ts.reduce((s, t) => s + (t[k] ?? 0), 0);
// null when no run reports the value.
const meanOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

// The metrics of a set of case runs, pooled: recall is all found bugs over all bugs, noise and time are per case run. The grounded
// metrics are null unless every run has its ground counts.
function metrics(ts: Tally[]): Record<Metric, number | null> {
  const gr = ts.every((t) => t.ground !== null) ? ts.map((t) => t.ground as Ground) : null;
  // null without ground counts, or when a run has no value.
  const gs = (f: (x: Ground) => number | null) => {
    if (!gr) return null;
    let s = 0;
    for (const x of gr) {
      const v = f(x);
      if (v === null) return null;
      s += v;
    }
    return s;
  };
  const counted = sum(ts, "bugs");
  const found = gs((x) => x.hits.shown.size);
  const tp = gs((x) => x.tp);
  const fp = gs((x) => x.fp);
  const newTp = gs((x) => x.newTp);
  const of = (v: number | null, d: number | null) => (v === null || d === null ? null : ratio(v, d));
  const loss = (s: State) =>
    of(
      gs((x) => x.loss[s]),
      counted,
    );
  return {
    groundedRecall: of(found, counted),
    groundedPrecision: of(tp, tp === null || fp === null ? null : tp + fp),
    groundedNoise: of(
      gs((x) => x.unmatched),
      ts.length,
    ),
    recall: ratio(sum(ts, "found"), sum(ts, "bugs")),
    humanRecall: ratio(sum(ts, "humanFound"), sum(ts, "human")),
    precision: ratio(sum(ts, "shownMatched"), sum(ts, "shown")),
    trapRate: ratio(sum(ts, "trapHits"), sum(ts, "traps")),
    noise: ratio(sum(ts, "noise"), ts.length),
    falsePositives: ratio(sum(ts, "shown") - sum(ts, "shownMatched"), ts.length),
    extras: ratio(sum(ts, "extraHits"), ts.length),
    severityOk: ratio(sum(ts, "severityOk"), sum(ts, "found")),
    candidateRecall: ratio(sum(ts, "candidates"), sum(ts, "bugs")),
    bugOpened: ratio(sum(ts, "bugOpened"), sum(ts, "openedOf")),
    agentCalls: meanOf(ts.map((t) => t.agentCalls)),
    parts: meanOf(ts.map((t) => t.parts)),
    partsRead: meanOf(ts.map((t) => t.partsRead)),
    // null outside a re-review, so plain results show no value.
    reRaises: ts.some((x) => x.rereview) ? ratio(sum(ts, "reRaises"), ts.length) : null,
    verdictOk: ratio(sum(ts, "verdictOk"), sum(ts, "verdicts")),
    minutes: meanOf(ts.map((t) => t.minutes)),
    costUsd: meanOf(ts.map((t) => t.costUsd)),
    notCompleted: sum(ts, "notCompleted"),
    incomplete: sum(ts, "incomplete"),
    groundedRaised: of(
      gs((x) => x.hits.raised.size),
      counted,
    ),
    lossMain: loss("main"),
    lossDemoted: loss("demoted"),
    lossFolded: loss("folded"),
    lossDuplicate: loss("duplicate"),
    lossRefuted: loss("refuted"),
    refutedShown: ratio(sum(ts, "refutedShown"), ts.length),
    augmentedPrecision: of(
      tp === null || newTp === null ? null : tp + newTp,
      gs((x) => x.shown),
    ),
    augmentedRecall: of(found === null || newTp === null ? null : found + newTp, newTp === null ? null : counted + newTp),
    newTp: of(newTp, ts.length),
    severityAbove: of(
      gs((x) => x.above),
      newTp,
    ),
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

type RunTally = { repeat: number; c: EvalCaseInfo; t: Tally };

// The tallies of the runs of known cases. The result is grounded only when every run has its ground counts. Else no run keeps them, so
// no metric mixes the matcher and the line match.
function tallies(r: EvalResult, g?: Grounding): { runs: RunTally[]; grounded: boolean; hits: (x: RunTally) => Hits } {
  const byId = new Map(r.cases.map((c) => [c.id, c]));
  const runs = r.runs.flatMap((x) => {
    const c = byId.get(x.case);
    return c ? [{ repeat: x.repeat, c, t: tally(c, x, r.tolerance ?? 0, r.volume, g) }] : [];
  });
  const grounded = g !== undefined && runs.every((x) => x.t.ground !== null);
  if (!grounded) for (const x of runs) x.t.ground = null;
  return { runs, grounded, hits: (x) => x.t.ground?.hits ?? x.t.hits };
}

// The class names of shared/review.ts bugClass, as local.ts BUG_CLASS_NAMES has them.
const CLASS_NAMES = ["security", "concurrency", "resource", "behavior", "other"] as const;

// review-quality-2026.md E5. Gold slices: severity, source, module, and bug class of the counted must-finds. Case slices: size, task
// text, and clean cases. The probe set is a set of its own (--set probe), so its result is its slice.
function slices(runs: RunTally[], grounded: boolean, hits: (x: RunTally) => Hits, volume: Volume | null): Slice[] {
  type Acc = { mustFinds: number; found: number; runs: number; noise: number; judgeFp: number | null; gold: boolean };
  const acc = new Map<string, Acc>();
  const row = (name: string, gold: boolean) => {
    let a = acc.get(name);
    if (!a) {
      a = { mustFinds: 0, found: 0, runs: 0, noise: 0, judgeFp: grounded ? 0 : null, gold };
      acc.set(name, a);
    }
    return a;
  };
  for (const x of runs) {
    const h = hits(x);
    for (const b of mustFind(x.c, volume)) {
      const hit = h.shown.has(`bug:${b.id}`) ? 1 : 0;
      for (const name of [
        `severity ${b.severityMin === "blocker" || b.severityMin === "major" ? "blocker, major" : "minor, nit"}`,
        `source ${b.source ?? "none"}`,
        `module ${b.module}`,
        `class ${CLASS_NAMES[bugClass({ module: b.module, category: b.category })] ?? "other"}`,
      ]) {
        const a = row(name, true);
        a.mustFinds++;
        a.found += hit;
      }
    }
    const names = [
      ...(x.c.large === undefined ? [] : [x.c.large ? "large cases" : "small cases"]),
      x.c.hasTask || x.c.task !== undefined ? "cases with task text" : "cases without task text",
      ...(x.c.clean ? ["clean cases"] : []),
    ];
    for (const name of names) {
      const a = row(name, false);
      a.runs++;
      a.mustFinds += x.t.bugs;
      a.found += h.shown.size;
      a.noise += x.t.ground?.unmatched ?? x.t.noise;
      const fp = x.t.ground?.judgeFp ?? null;
      a.judgeFp = a.judgeFp === null || fp === null ? null : a.judgeFp + fp;
    }
  }
  return [...acc]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, a]) => ({
      name,
      mustFinds: a.mustFinds,
      found: a.found,
      runs: a.gold ? null : a.runs,
      noise: a.gold ? null : a.noise / a.runs,
      judgeFp: a.gold || a.judgeFp === null ? null : a.judgeFp / a.runs,
    }));
}

const subsetsOf = <T>(xs: T[], k: number): T[][] =>
  k === 0 ? [[]] : xs.flatMap((x, n) => subsetsOf(xs.slice(n + 1), k - 1).map((s) => [x, ...s]));

// review-quality-2026.md E5: the mean over the k-subsets of repeats of the share of the counted must-finds that any run of the subset
// shows (shown) or raises (raised). Grounded with labels, else by the line match. null: k is out of range, or no must-find counts.
export function unionRecall(r: EvalResult, k: number, g?: Grounding): { shown: number; raised: number } | null {
  const { runs, hits } = tallies(r, g);
  const repeats = [...new Set(runs.map((x) => x.repeat))].sort((a, b) => a - b);
  const total = r.cases.reduce((n, c) => n + mustFind(c, r.volume).length, 0);
  if (k < 1 || k > repeats.length || total === 0) return null;
  const subsets = subsetsOf(repeats, k);
  let shown = 0;
  let raised = 0;
  for (const set of subsets)
    for (const c of r.cases) {
      const mine = runs.filter((x) => x.c.id === c.id && set.includes(x.repeat));
      shown += new Set(mine.flatMap((x) => [...hits(x).shown])).size;
      raised += new Set(mine.flatMap((x) => [...hits(x).raised])).size;
    }
  return { shown: shown / subsets.length / total, raised: raised / subsets.length / total };
}

// A small seeded generator (mulberry32), so the bootstrap interval is the same on each call.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const BOOTSTRAP = { seed: 2026, samples: 2000 } as const;

// review-quality-2026.md E5, information only: the mean over the counted must-finds of both results of the hit rate in B minus the hit
// rate in A. The hit rate of a must-find is the share of the runs of its case that show it. The 90% interval comes from a bootstrap over
// the PR groups (the case group, else the case ID). Grounded when both results have labels, else by the line match on both sides.
// null: no must-find has runs in both results.
export function pairedDelta(
  a: EvalResult,
  b: EvalResult,
  ga?: Grounding,
  gb?: Grounding,
): { delta: number; low: number; high: number; mustFinds: number; groups: number; grounded: boolean } | null {
  let ta = tallies(a, ga);
  let tb = tallies(b, gb);
  const grounded = ta.grounded && tb.grounded;
  if (!grounded) [ta, tb] = [tallies(a), tallies(b)];
  const rate = (p: typeof ta, id: string, key: string) => {
    const mine = p.runs.filter((x) => x.c.id === id);
    return mine.length ? mine.filter((x) => p.hits(x).shown.has(key)).length / mine.length : null;
  };
  const byGroup = new Map<string, number[]>();
  for (const c of a.cases) {
    const other = b.cases.find((x) => x.id === c.id);
    if (!other) continue;
    const inB = new Set(mustFind(other, b.volume).map((x) => `bug:${x.id}`));
    for (const key of mustFind(c, a.volume).map((x) => `bug:${x.id}`)) {
      const x = rate(ta, c.id, key);
      const y = rate(tb, c.id, key);
      if (!inB.has(key) || x === null || y === null) continue;
      const group = c.group ?? c.id;
      byGroup.set(group, [...(byGroup.get(group) ?? []), y - x]);
    }
  }
  const groups = [...byGroup.values()];
  const all = groups.flat();
  if (!all.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const next = seeded(BOOTSTRAP.seed);
  const means = Array.from({ length: BOOTSTRAP.samples }, () =>
    mean(Array.from({ length: groups.length }, () => groups[Math.floor(next() * groups.length)] ?? []).flat()),
  ).sort((x, y) => x - y);
  const at = (q: number) => means[Math.min(means.length - 1, Math.floor(q * means.length))] as number;
  return { delta: mean(all), low: at(0.05), high: at(0.95), mustFinds: all.length, groups: groups.length, grounded };
}

// g: the matcher and judge labels of eval:label. Without g, or when a run has no labels, every grounded metric is null.
export function score(r: EvalResult, g?: Grounding): Score {
  const { runs, grounded, hits } = tallies(r, g);
  const repeats = [...new Set(runs.map((x) => x.repeat))].sort((a, b) => a - b);
  const suite = stats(repeats.map((n) => metrics(runs.filter((x) => x.repeat === n).map((x) => x.t))));
  const cases: Record<string, Record<Metric, Stat>> = {};
  for (const c of r.cases) {
    const mine = runs.filter((x) => x.c.id === c.id);
    if (mine.length) cases[c.id] = stats(mine.map((x) => metrics([x.t])));
  }
  const macro = Object.fromEntries(METRICS.map((m) => [m, meanOf(Object.values(cases).map((c) => c[m]?.mean ?? null))])) as Record<
    Metric,
    number | null
  >;
  let confusion: Score["confusion"] = null;
  if (grounded && runs.every((x) => x.t.ground?.confusion)) {
    confusion = {};
    for (const x of runs)
      for (const [v, n] of Object.entries(x.t.ground?.confusion ?? {})) {
        const row = confusion[v] ?? { tp: 0, fp: 0 };
        confusion[v] = row;
        row.tp += n.tp;
        row.fp += n.fp;
      }
  }
  const union = repeats.flatMap((_, n) => {
    const u = unionRecall(r, n + 1, g);
    return u ? [{ k: n + 1, ...u }] : [];
  });
  const fq = r.runs.flatMap((x) => (x.finderQuestions ? [x.finderQuestions] : []));
  const add = (k: "asked" | "answered" | "findings" | "kept") => fq.reduce((s, x) => s + x[k], 0);
  const severities = unshowable(r.volume);
  const count = r.cases.reduce((n, c) => n + c.bugs.length - mustFind(c, r.volume).length, 0);
  const security: Sec | null = grounded ? { runs: runs.length, shown: 0, gold: 0, tp: 0, fp: 0, unlabeled: 0 } : null;
  if (security) for (const x of runs) for (const k of SEC_KEYS) security[k] += x.t.ground?.security[k] ?? 0;
  return {
    suite,
    cases,
    leftOut: { count, severities },
    grounded,
    macro,
    confusion,
    slices: slices(runs, grounded, hits, r.volume),
    security,
    union,
    finderQuestions: fq.length ? { asked: add("asked"), answered: add("answered"), findings: add("findings"), kept: add("kept") } : null,
    recallBugs: repeats.map((n) => {
      const mine = runs.filter((x) => x.repeat === n);
      return { repeat: n, found: mine.reduce((s, x) => s + hits(x).shown.size, 0), mustFinds: mine.reduce((s, x) => s + x.t.bugs, 0) };
    }),
  };
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

// ---------- Evidence references (review-quality-2026.md item 8, the zero-cost gate) ----------

// catalog.ts asks the finder for "path:line for each line that shows the problem" in evidence. A reference is a token with a "/", "\",
// or "." before ":<line>", with an optional "-<line>" end. It starts at the text start, after white space, or after an opening quote,
// backtick, or bracket. So a URL is none, and a path with another character, such as "[id]" or "@types", is none too.
const EVIDENCE_REF = /(?<=^|[\s"'`([{<])([\w./\\-]*[./\\][\w./\\-]*):(\d+)(?:-(\d+))?/g;
export type EvidenceRef = { path: string; line: number; end: number };
// path: the repository path, or the raw token when repoPath refuses it, so that the head lookup fails.
export const evidenceRefs = (text: string): EvidenceRef[] =>
  [...text.matchAll(EVIDENCE_REF)].map((m) => {
    const line = Number(m[2]);
    return { path: repoPath(m[1] as string) ?? (m[1] as string), line, end: Math.max(line, Number(m[3] ?? line)) };
  });

// The label of an item for the evidence table: the kind of the gold item that it claims, else the judge label.
export const EVIDENCE_LABELS = ["must-find", "trap", "extra", "judge tp", "judge fp", "no label"] as const;
export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];
// findings: items of all runs. unrecorded: items without the evidence field (files made before it existed). noRef: items whose
// evidence has no reference. withRef: items with one or more references, and refs their references. noFile: items with a reference to
// a file that is not in the head tree. pastEnd: items with a reference to a line that the head file does not have. A cut or prefixed
// path lands in noFile, so only pastEnd is free of parser misses.
export type EvidenceRow = {
  findings: number;
  unrecorded: number;
  noRef: number;
  withRef: number;
  refs: number;
  noFile: number;
  pastEnd: number;
};

// lines: the line count of a file at the head of a case, undefined when the head tree has no such file. A line is out of the file when
// it is 0 or its end is past the last line. An old-side reference also counts against the head.
export function evidenceCheck(
  results: EvalResult[],
  g: Grounding | undefined,
  lines: (caseId: string, path: string) => number | undefined,
): Record<EvidenceLabel, EvidenceRow> {
  const out = Object.fromEntries(
    EVIDENCE_LABELS.map((l) => [l, { findings: 0, unrecorded: 0, noRef: 0, withRef: 0, refs: 0, noFile: 0, pastEnd: 0 }]),
  ) as Record<EvidenceLabel, EvidenceRow>;
  for (const r of results)
    for (const run of r.runs) {
      const c = r.cases.find((x) => x.id === run.case);
      if (!c) continue;
      const m = run.items.map((i) => g?.matches(c, i));
      const gold = m.every((x) => x !== undefined) ? goldLabels(goldOf(c), run.items, (n) => m[n] ?? []) : null;
      run.items.forEach((i, n) => {
        const gl = gold?.[n];
        const j = gold && !gl ? g?.judge(c, i) : undefined;
        const label: EvidenceLabel = gl
          ? gl.kind === "trap"
            ? "trap"
            : gl.kind === "extra"
              ? "extra"
              : "must-find"
          : j
            ? j.label === "tp"
              ? "judge tp"
              : "judge fp"
            : "no label";
        const row = out[label];
        row.findings++;
        if (i.evidence === undefined) {
          row.unrecorded++;
          return;
        }
        const refs = evidenceRefs(i.evidence);
        if (!refs.length) {
          row.noRef++;
          return;
        }
        row.withRef++;
        row.refs += refs.length;
        const counts = refs.map((x) => lines(c.id, x.path));
        if (counts.some((n) => n === undefined)) row.noFile++;
        if (refs.some((x, k) => counts[k] !== undefined && (x.line < 1 || x.end > (counts[k] as number)))) row.pastEnd++;
      });
    }
  return out;
}
