// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2 AC-M1: the eval scorer gives the documented numbers on a hand-made result. No process, no file.
import { describe, expect, test } from "bun:test";
import type { EvalBug } from "../../scripts/eval/cases";
import { compareText, evidenceText, summaryText } from "../../scripts/eval/compare";
import { foldRefuted, rescore } from "../../scripts/eval/rescore";
import {
  type CaseRun,
  type EvalCaseInfo,
  type EvalItem,
  type EvalResult,
  evidenceCheck,
  evidenceRefs,
  type Grounding,
  type JudgeLabel,
  overlaps,
  pairedDelta,
  score,
  unionRecall,
} from "../../scripts/eval/score";

console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/score.ts", import.meta.dir)}`);

const item = (o: Partial<EvalItem> & Pick<EvalItem, "path" | "side" | "line" | "lineEnd">): EvalItem => ({
  anchorState: "exact",
  severity: "minor",
  finderSeverity: o.severity ?? "minor",
  verdict: null,
  check: null,
  group: "main",
  status: "new",
  title: "",
  body: "A finding.",
  category: "logic",
  module: null,
  trigger: null,
  confidence: "high",
  evidenceStatus: "code",
  agent: null,
  ...o,
});

const run = (c: string, repeat: number, items: EvalItem[], o: Partial<CaseRun> = {}): CaseRun => ({
  case: c,
  repeat,
  run: 1,
  status: "completed",
  errorKind: null,
  error: null,
  model: "claude-test",
  effort: "default",
  effortDefault: null,
  startedAt: 0,
  finishedAt: 0,
  minutes: 1,
  usage: null,
  items,
  dropped: [],
  questions: 0,
  ...o,
});

const usage = (costUsd: number) => ({ costUsd, turns: 3, durationMs: 1000, tokens: {} });

// Case a: bugs at a.ts:10-12 (major) and a.ts:30 (minor), a trap at a.ts:50-55.
// Case b: a bug on the old side of b.py:5-8 (minor), traps at b.py:20 and b.py:40-41.
// Each boundary item touches its bug range at exactly one line.
const RESULT: EvalResult = {
  format: 1,
  createdAt: "2026-10-22T00:00:00.000Z",
  commit: "abc",
  dirty: false,
  promptVersion: "1",
  cliVersion: "2.1.295",
  runner: "fake",
  profile: { id: "general", name: "General", revision: "0123456789" },
  volume: null,
  repeat: 2,
  cases: [
    {
      id: "a",
      title: "Case a",
      language: "typescript",
      changedLines: 200,
      base: "b1",
      head: "h1",
      bugs: [
        { id: "B1", path: "a.ts", side: "new", lines: [10, 12], severityMin: "major", module: "core", note: "n" },
        { id: "B2", path: "a.ts", side: "new", lines: [30, 30], severityMin: "minor", module: "core", note: "n" },
      ],
      traps: [{ id: "T1", path: "a.ts", side: "new", lines: [50, 55], why: "w" }],
    },
    {
      id: "b",
      title: "Case b",
      language: "python",
      changedLines: 180,
      base: "b2",
      head: "h2",
      bugs: [{ id: "B1", path: "b.py", side: "old", lines: [5, 8], severityMin: "minor", module: "core", note: "n" }],
      traps: [
        { id: "T1", path: "b.py", side: "new", lines: [20, 20], why: "w" },
        { id: "T2", path: "b.py", side: "new", lines: [40, 41], why: "w" },
      ],
    },
  ],
  runs: [
    run(
      "a",
      1,
      [
        item({ path: "a.ts", side: "new", line: 12, lineEnd: 14, severity: "major" }),
        item({ path: "a.ts", side: "new", line: 52, lineEnd: 52 }),
        item({ path: "a.ts", side: "new", line: 70, lineEnd: 70, severity: "nit" }),
        item({ path: "a.ts", side: "new", line: 30, lineEnd: 30, verdict: "refuted", check: "unchecked", group: "hidden" }),
      ],
      { minutes: 4, usage: usage(0.5) },
    ),
    run(
      "b",
      1,
      [
        item({ path: "b.py", side: "old", line: 8, lineEnd: 8, severity: "nit" }),
        item({ path: "b.py", side: "new", line: 5, lineEnd: 8, severity: "major" }),
      ],
      { minutes: 6, usage: usage(1.5) },
    ),
    run(
      "a",
      2,
      [
        item({ path: "a.ts", side: "new", line: 9, lineEnd: 9, severity: "blocker" }),
        item({ path: "a.ts", side: "new", line: 29, lineEnd: 30 }),
      ],
      { minutes: 8, usage: usage(0.7) },
    ),
    run("b", 2, [], { status: "failed", minutes: 1 }),
  ],
};

describe("eval score (AC-M1)", () => {
  test("ranges overlap with both ends inclusive", () => {
    expect(overlaps([1, 3], [3, 5])).toBe(true);
    expect(overlaps([3, 5], [1, 3])).toBe(true);
    expect(overlaps([4, 4], [4, 4])).toBe(true);
    expect(overlaps([1, 2], [3, 4])).toBe(false);
  });

  test("suite numbers pool the cases of each repeat, then give mean, min, and max", () => {
    const s = score(RESULT).suite;
    // Repeat 1: 2 of 3 bugs found, 2 of 5 shown items match, 1 trap hit of 3 traps, 2 noise items in 2 cases.
    // Repeat 2: 1 of 3 bugs found, 1 of 2 shown items match, no trap hit, 1 noise item, case b failed.
    expect(s.recall).toEqual({ mean: 0.5, min: 1 / 3, max: 2 / 3 });
    expect(s.precision?.mean).toBeCloseTo(0.45, 10);
    expect(s.precision).toMatchObject({ min: 0.4, max: 0.5 });
    expect(s.trapRate?.mean).toBeCloseTo(1 / 6, 10);
    expect(s.trapRate).toMatchObject({ min: 0, max: 1 / 3 });
    expect(s.noise).toEqual({ mean: 0.75, min: 0.5, max: 1 });
    // Repeat 1: 3 shown items on no bug in 2 cases. Repeat 2: 1 in 2 cases.
    expect(s.falsePositives).toEqual({ mean: 1, min: 0.5, max: 1.5 });
    expect(s.severityOk).toEqual({ mean: 0.75, min: 0.5, max: 1 });
    // The refuted item of repeat 1 still counts as a candidate for bug a/B2.
    expect(s.candidateRecall?.mean).toBeCloseTo(2 / 3, 10);
    expect(s.candidateRecall).toMatchObject({ min: 1 / 3, max: 1 });
    expect(s.minutes).toEqual({ mean: 4.75, min: 4.5, max: 5 });
    expect(s.costUsd?.mean).toBeCloseTo(0.85, 10);
    expect(s.notCompleted).toEqual({ mean: 0.5, min: 0, max: 1 });
    expect(s.incomplete).toEqual({ mean: 0, min: 0, max: 0 });
  });

  test("failed runs count failed, cancelled, and error runs; incomplete runs count apart", () => {
    const r: EvalResult = {
      ...RESULT,
      runs: [
        run("a", 1, [], { status: "incomplete" }),
        run("b", 1, [], { status: "failed" }),
        run("a", 2, [], { status: "cancelled" }),
        run("b", 2, [], { status: "error" }),
      ],
    };
    const s = score(r).suite;
    expect(s.notCompleted).toEqual({ mean: 1.5, min: 1, max: 2 });
    expect(s.incomplete).toEqual({ mean: 0.5, min: 0, max: 1 });
    const text = summaryText(r);
    expect(text).toMatch(/failed runs: failed, cancelled, or error, per repeat\s+1\.5 \(1\.0 to 2\.0\)/);
    expect(text).toMatch(/runs with coverage gaps \(incomplete\), per repeat\s+0\.5 \(0\.0 to 1\.0\)/);
    expect(compareText(r, r)).toContain("runs with coverage gaps (incomplete), per repeat");
  });

  test("case numbers use the repeats of that case", () => {
    const { a, b } = score(RESULT).cases;
    expect(a?.recall).toEqual({ mean: 0.5, min: 0.5, max: 0.5 });
    expect(a?.precision?.mean).toBeCloseTo(5 / 12, 10);
    expect(a?.candidateRecall).toEqual({ mean: 0.75, min: 0.5, max: 1 });
    expect(b?.recall).toEqual({ mean: 0.5, min: 0, max: 1 });
    // The failed repeat shows nothing, so it gives no precision and no severity number.
    expect(b?.precision).toEqual({ mean: 0.5, min: 0.5, max: 0.5 });
    expect(b?.severityOk).toEqual({ mean: 0, min: 0, max: 0 });
    expect(b?.costUsd).toEqual({ mean: 1.5, min: 1.5, max: 1.5 });
  });

  test("compare prints a table per metric with the delta", () => {
    const better: EvalResult = {
      ...RESULT,
      runs: RESULT.runs.map((r) =>
        r.case === "b" && r.repeat === 2 ? run("b", 2, [item({ path: "b.py", side: "old", line: 5, lineEnd: 5 })]) : r,
      ),
    };
    const text = compareText(RESULT, better);
    expect(text).toContain("recall: seeded bugs with a shown finding");
    // Recall goes from 50.0% to 66.7%: repeat 2 finds b/B1 too.
    expect(text).toMatch(/all cases\s+50\.0% \(33\.3% to 66\.7%\)\s+66\.7%\s+\+16\.7 pts/);
    expect(summaryText(RESULT)).toContain("prompt version 1");
  });
});

describe("opened-file facts (docs/plans/review-v3.md WP-V13)", () => {
  // Repeat 1 opened a.ts (both bugs of a) but not b.py. Repeat 2 of a opened nothing; repeat 2 of b is an old run with no facts.
  // WP-V14: repeat 1 has 2 part files, and case b read 1 of them. Repeat 2 of a has none.
  const OPENED: EvalResult = {
    ...RESULT,
    runs: RESULT.runs.map((r) =>
      r.repeat === 1
        ? {
            ...r,
            agentCalls: r.case === "a" ? 3 : 1,
            opened: r.case === "a" ? ["a.ts", "z.ts"] : ["c.py"],
            toolsPerCall: 7,
            parts: 2,
            partsRead: r.case === "a" ? 2 : 1,
          }
        : r.case === "a"
          ? { ...r, agentCalls: 0, opened: [], toolsPerCall: 0, parts: 0, partsRead: 0 }
          : r,
    ),
  };

  test("bugOpened counts the bugs whose file the run opened, per case run and pooled; a run without facts does not count", () => {
    const s = score(OPENED);
    // Repeat 1: 2 of 3 bugs. Repeat 2: case a only, 0 of 2.
    expect(s.suite.bugOpened).toEqual({ mean: 1 / 3, min: 0, max: 2 / 3 });
    expect(s.cases.a?.bugOpened).toEqual({ mean: 0.5, min: 0, max: 1 });
    expect(s.cases.b?.bugOpened).toEqual({ mean: 0, min: 0, max: 0 });
    expect(s.suite.agentCalls).toEqual({ mean: 1, min: 0, max: 2 });
    expect(s.cases.a?.agentCalls).toEqual({ mean: 1.5, min: 0, max: 3 });
    expect(s.suite.parts).toEqual({ mean: 1, min: 0, max: 2 });
    expect(s.suite.partsRead).toEqual({ mean: 0.75, min: 0, max: 1.5 });
    expect(s.cases.b?.partsRead).toEqual({ mean: 1, min: 1, max: 1 });
  });

  test("compare shows bugOpened, agentCalls, parts, and partsRead, and an old result file shows -", () => {
    expect(score(RESULT).suite.bugOpened).toBeNull();
    expect(score(RESULT).suite.agentCalls).toBeNull();
    expect(score(RESULT).suite.parts).toBeNull();
    const text = compareText(RESULT, OPENED);
    expect(text).toMatch(/bug opened: [^\n]+\ncase\s+A\s+B\s+delta\nall cases\s+-\s+33\.3% \(0\.0% to 66\.7%\)\s+-/);
    expect(text).toMatch(/rl-reviewer calls per case\ncase\s+A\s+B\s+delta\nall cases\s+-\s+1\.0 \(0\.0 to 2\.0\)\s+-/);
    expect(text).toMatch(/part files per case \(variant parts\)\ncase\s+A\s+B\s+delta\nall cases\s+-\s+1\.0 \(0\.0 to 2\.0\)\s+-/);
    expect(text).toMatch(/parts read: [^\n]+\ncase\s+A\s+B\s+delta\nall cases\s+-\s+0\.8 \(0\.0 to 1\.5\)\s+-/);
    expect(summaryText(RESULT)).toMatch(/bug opened\s+rl-reviewer calls\s+parts\s+parts read\s+minutes\n/);
    expect(summaryText(RESULT)).toMatch(/\na\s[^\n]*\s-\s+-\s+-\s+-\s+6\.0 \(4\.0 to 8\.0\)\n/);
    expect(summaryText(OPENED)).toMatch(
      /\na\s[^\n]*\s50\.0% \(0\.0% to 100\.0%\)\s+1\.5 \(0\.0 to 3\.0\)\s+1\.0 \(0\.0 to 2\.0\)\s+1\.0 \(0\.0 to 2\.0\)\s+6\.0 \(4\.0 to 8\.0\)\n/,
    );
    expect(summaryText(RESULT)).toContain("reviewer effort not recorded");
  });
});

describe("alt places", () => {
  // Bug B1: the declaration at c.h:5 or the definition at c.cpp:40-42. Trap T1: c.cpp:60 or its caller at main.cpp:9.
  const ALT: EvalResult = {
    ...RESULT,
    repeat: 1,
    cases: [
      {
        id: "c",
        title: "Case c",
        language: "cpp",
        changedLines: 200,
        base: "b3",
        head: "h3",
        bugs: [
          {
            id: "B1",
            path: "c.h",
            side: "new",
            lines: [5, 5],
            alt: [{ path: "c.cpp", side: "new", lines: [40, 42] }],
            severityMin: "minor",
            module: "core",
            note: "n",
          },
        ],
        traps: [
          { id: "T1", path: "c.cpp", side: "new", lines: [60, 60], alt: [{ path: "main.cpp", side: "new", lines: [9, 9] }], why: "w" },
        ],
      },
    ],
    runs: [
      run("c", 1, [
        item({ path: "c.cpp", side: "new", line: 42, lineEnd: 44 }),
        item({ path: "main.cpp", side: "new", line: 9, lineEnd: 9 }),
        item({ path: "c.cpp", side: "old", line: 40, lineEnd: 40 }),
      ]),
    ],
  };

  test("an item on any place of a bug or a trap matches it", () => {
    const s = score(ALT).suite;
    expect(s.recall?.mean).toBe(1);
    expect(s.precision?.mean).toBeCloseTo(1 / 3, 10);
    expect(s.trapRate?.mean).toBe(1);
    // The old-side item is on no place: the side must match too.
    expect(s.noise?.mean).toBe(1);
    expect(s.falsePositives?.mean).toBe(2);
  });
});

describe("compare by the models and efforts that ran", () => {
  // A file made before "requested" and "models" existed: no flags, and only the init model of each run.
  const OLD: EvalResult = {
    ...RESULT,
    runs: RESULT.runs.map((r) => ({ ...r, model: "claude-opus-5-5", effort: "default", effortDefault: "high" })),
  };
  // A later run with --model opus and no --effort. Its runs also record a subagent model.
  const LATER: EvalResult = {
    ...OLD,
    requested: { model: "opus", effort: "default" },
    runs: OLD.runs.map((r) => ({ ...r, models: ["claude-opus-5-5", "claude-haiku-4-5"] })),
  };

  test("a file with no requested field compares by the init models and efforts that ran", () => {
    const text = compareText(OLD, LATER);
    expect(text).not.toContain("used different");
    expect(text).toContain("model not recorded (ran claude-opus-5-5), effort not recorded (ran high)");
    expect(text).toContain("model opus (ran claude-haiku-4-5, claude-opus-5-5), effort default (ran high)");
  });

  test("a real difference still warns", () => {
    const sonnet = { ...LATER, runs: LATER.runs.map((r) => ({ ...r, model: "claude-sonnet-5", models: ["claude-sonnet-5"] })) };
    expect(compareText(OLD, sonnet)).toContain("A and B used different models.");
    const low = { ...LATER, runs: LATER.runs.map((r) => ({ ...r, effort: "low" })) };
    expect(compareText(OLD, low)).toContain("A and B used different efforts.");
    expect(compareText(OLD, low)).not.toContain("used different models");
  });

  test("a different profile revision warns, and the header names the profile version", () => {
    const v4 = { ...LATER, profileVersion: 4 };
    const text = compareText(OLD, v4);
    expect(text).not.toContain("used different profiles");
    expect(text).toContain("profile general of profile version 4 (revision 01234567)");
    const review = { ...LATER, profileVersion: 5, profile: { ...LATER.profile, name: "Review", revision: "abcdef0123" } };
    expect(compareText(v4, review)).toContain(
      "A and B used different profiles: revision 01234567 of profile version 4, revision abcdef01 of profile version 5. The numbers do not compare.",
    );
    expect(compareText(OLD, review)).toContain("revision 01234567 of profile version not recorded");
  });
});

describe("eval:rescore", () => {
  const [a, b] = RESULT.cases as [EvalResult["cases"][number], EvalResult["cases"][number]];

  test("puts the current bugs and traps into each case and notes a changed head", () => {
    // The current fixture of case a gives bug B2 an alt place on the nit item of repeat 1.
    const bugs = a.bugs.map((x) =>
      x.id === "B2" ? { ...x, alt: [{ path: "a.ts", side: "new" as const, lines: [70, 70] as [number, number] }] } : x,
    );
    const truth = new Map([
      ["a", { head: "h1", bugs, traps: a.traps, extras: [] }],
      ["b", { head: "h9", bugs: b.bugs, traps: b.traps, extras: [] }],
    ]);
    const { result, notes } = rescore(RESULT, truth, "2026-10-22T01:00:00.000Z");
    expect(result.cases.map((c) => c.bugs)).toEqual([bugs, b.bugs]);
    expect(result.rescoredAt).toBe("2026-10-22T01:00:00.000Z");
    expect(result.runs).toBe(RESULT.runs);
    // Repeat 1 now finds 3 of 3 bugs, repeat 2 still 1 of 3.
    expect(score(result).suite.recall).toEqual({ mean: 2 / 3, min: 1 / 3, max: 1 });
    expect(notes).toEqual([
      "Case b: the fixture head is h9, the runs reviewed h2. Its numbers can be wrong.",
      "Cases with new bugs, traps, or extras: a.",
    ]);
    expect(RESULT.cases[0]?.bugs[1]).not.toHaveProperty("alt");
  });

  test("applies the extras of the current fixture: an item on an extra counts for no metric but extras", () => {
    // a.ts:70 holds the nit item of repeat 1. a.ts:12 overlaps the item on bug B1, which stays a bug hit.
    const extras = [
      { path: "a.ts", side: "new" as const, lines: [70, 70] as [number, number], note: "n" },
      { path: "a.ts", side: "new" as const, lines: [12, 12] as [number, number], note: "n" },
    ];
    const truth = new Map([
      ["a", { head: "h1", bugs: a.bugs, traps: a.traps, extras }],
      ["b", { head: "h2", bugs: b.bugs, traps: b.traps, extras: [] }],
    ]);
    const { result, notes } = rescore(RESULT, truth, "2026-10-22T01:00:00.000Z");
    expect(notes).toEqual(["Cases with new bugs, traps, or extras: a."]);
    const s = score(result).suite;
    // Repeat 1: 2 of 4 counted shown items match, 1 noise item and 2 false positives in 2 cases, 1 extra.
    expect(s.recall).toEqual(score(RESULT).suite.recall);
    expect(s.precision).toMatchObject({ min: 0.5, max: 0.5 });
    expect(s.noise).toEqual({ mean: 0.5, min: 0.5, max: 0.5 });
    expect(s.falsePositives).toEqual({ mean: 0.75, min: 0.5, max: 1 });
    expect(s.extras).toEqual({ mean: 0.25, min: 0, max: 0.5 });
    expect(score(RESULT).suite.extras).toEqual({ mean: 0, min: 0, max: 0 });
    expect(summaryText(result)).toContain("extras matched: shown findings on a known real issue");
  });

  test("a case with no fixture keeps its stored bugs and traps", () => {
    const { result, notes } = rescore(RESULT, new Map(), "2026-10-22T01:00:00.000Z");
    expect(result.cases).toEqual(RESULT.cases);
    expect(notes).toEqual([
      "Case a has no fixture now. It keeps its stored bugs and traps.",
      "Case b has no fixture now. It keeps its stored bugs and traps.",
      "No case has new bugs, traps, or extras.",
    ]);
  });
});

describe("recall leaves out the bugs that the volume cannot show", () => {
  const bug = (id: string, line: number, severityMin: EvalBug["severityMin"]): EvalBug => ({
    id,
    path: "v.ts",
    side: "new",
    lines: [line, line],
    severityMin,
    module: "core",
    note: "n",
  });
  const result = (volume: "balanced" | "quiet", items: EvalItem[]): EvalResult => ({
    ...RESULT,
    volume,
    repeat: 1,
    cases: [
      {
        id: "v",
        title: "Case v",
        language: "typescript",
        changedLines: 50,
        base: "b",
        head: "h",
        bugs: [bug("N", 10, "nit"), bug("M", 20, "minor"), bug("J", 30, "major")],
        traps: [],
      },
    ],
    runs: [run("v", 1, items)],
  });

  test("balanced: a nit bug leaves the recall count", () => {
    const r = result("balanced", [
      item({ path: "v.ts", side: "new", line: 10, lineEnd: 10, severity: "nit", group: "fold" }),
      item({ path: "v.ts", side: "new", line: 20, lineEnd: 20, severity: "minor" }),
      item({ path: "v.ts", side: "new", line: 30, lineEnd: 30, severity: "major" }),
    ]);
    const s = score(r);
    expect(s.suite.recall).toEqual({ mean: 1, min: 1, max: 1 });
    expect(s.suite.candidateRecall?.mean).toBe(1);
    expect(s.leftOut).toEqual({ count: 1, severities: ["nit"] });
    expect(summaryText(r)).toContain("Must-find items this volume cannot show: 1 (nit).");
    expect(score(rescore(r, new Map(), "2026-10-22T01:00:00.000Z").result).suite.recall).toEqual(s.suite.recall);
  });

  test("quiet: nit and minor bugs leave the recall count", () => {
    const r = result("quiet", [
      item({ path: "v.ts", side: "new", line: 20, lineEnd: 20, severity: "minor", group: "fold" }),
      item({ path: "v.ts", side: "new", line: 30, lineEnd: 30, severity: "major" }),
    ]);
    const s = score(r);
    expect(s.suite.recall).toEqual({ mean: 1, min: 1, max: 1 });
    expect(s.leftOut).toEqual({ count: 2, severities: ["nit", "minor"] });
    expect(summaryText(r)).toContain("Must-find items this volume cannot show: 2 (nit, minor).");
    expect(compareText(r, r)).toContain("Must-find items this volume cannot show: A 2, B 2.");
  });

  test("no volume counts every bug", () => {
    expect(score(RESULT).leftOut).toEqual({ count: 0, severities: [] });
    expect(summaryText(RESULT)).toContain("Must-find items this volume cannot show: 0.");
  });
});

// ---------- Grounded metrics (docs/plans/review-v2/review-quality-2026.md E3 to E5) ----------

// A hand grounding: the matcher answer and the judge label of each item by its title. An item without an answer is unlabelled.
const grounding = (m: Record<string, string[]>, j: Record<string, Pick<JudgeLabel, "label" | "severity">> = {}): Grounding => ({
  matches: (_c, i) => m[i.title],
  judge: (_c, i) => {
    const x = j[i.title];
    return x && { ...x, category: "correctness", scope: "introduced", why: "w" };
  },
});
const gbug = (id: string, line: number, o: Partial<EvalBug> = {}): EvalBug => ({
  id,
  path: "g.ts",
  side: "new",
  lines: [line, line],
  severityMin: "major",
  module: "core",
  note: "n",
  ...o,
});
const at = (title: string, o: Partial<EvalItem> = {}) => item({ path: "g.ts", side: "new", line: 1, lineEnd: 1, title, ...o });
const gcase = (id: string, bugs: EvalBug[], o: Partial<EvalCaseInfo> = {}): EvalCaseInfo => ({
  id,
  title: id,
  language: "typescript",
  changedLines: 10,
  base: "b",
  head: "h",
  bugs,
  traps: [{ id: "T1", path: "g.ts", side: "new", lines: [70, 70], why: "w" }],
  extras: [{ path: "g.ts", side: "new", lines: [90, 90], note: "x" }],
  ...o,
});
const gresult = (cases: EvalCaseInfo[], runs: CaseRun[], volume: EvalResult["volume"] = null): EvalResult => ({
  ...RESULT,
  volume,
  repeat: Math.max(...runs.map((x) => x.repeat)),
  cases,
  runs,
});

describe("grounded metrics (review-quality-2026.md E5)", () => {
  // B1, B2, B3 are counted must-finds. dual matches B1 and B2, dup repeats B1 (a claimed duplicate), trap hits T1, extra hits the
  // extra, noise and over match nothing, gone is a hidden refuted item on B3.
  const c = gcase("g", [gbug("B1", 10), gbug("B2", 30, { severityMin: "minor" }), gbug("B3", 50)]);
  const items = [
    at("dual", { verdict: "confirmed", check: "checked" }),
    at("dup", { verdict: "confirmed", check: "checked" }),
    at("trap", { verdict: "unsure", check: "unsure" }),
    at("extra"),
    at("noise"),
    at("over", { severity: "blocker", verdict: "confirmed", check: "checked" }),
    at("gone", { verdict: "refuted", check: "unchecked", group: "hidden" }),
  ];
  const r = gresult([c], [run("g", 1, items)]);
  const g = grounding(
    { dual: ["bug:B1", "bug:B2"], dup: ["bug:B1"], trap: ["trap:T1"], extra: ["extra:0"], noise: [], over: [], gone: ["bug:B3"] },
    { dup: { label: "tp", severity: "high" }, noise: { label: "fp", severity: "low" }, over: { label: "tp", severity: "low" } },
  );

  test("ReviewBench: one item that matches two gold items finds both and claims one; a claimed duplicate goes to the judge", () => {
    const s = score(r, g);
    expect(s.grounded).toBe(true);
    // Found: B1 and B2 of 3. Claims: dual takes B1 (tp), trap takes T1 (fp), extra leaves the shown count. dup finds B1 taken.
    expect(s.suite.groundedRecall?.mean).toBeCloseTo(2 / 3, 10);
    expect(s.suite.groundedPrecision?.mean).toBe(0.5);
    // Unmatched shown: dup, noise, over.
    expect(s.suite.groundedNoise?.mean).toBe(3);
  });

  test("augmented precision, new tp, augmented recall, and severity above use the judge labels of unmatched shown items", () => {
    const s = score(r, g).suite;
    // (1 claimed tp + 2 judge tp) over 5 shown items without the extra.
    expect(s.augmentedPrecision?.mean).toBe(0.6);
    expect(s.newTp?.mean).toBe(2);
    expect(s.augmentedRecall?.mean).toBe(4 / 5);
    // over: blocker against the judge level low. dup: minor (medium) against high is not above.
    expect(s.severityAbove?.mean).toBe(0.5);
  });

  test("the verifier confusion matrix labels every item by gold item, else by judge, by its verdict", () => {
    expect(score(r, g).confusion).toEqual({
      confirmed: { tp: 3, fp: 0 },
      unsure: { tp: 0, fp: 1 },
      none: { tp: 1, fp: 1 },
      refuted: { tp: 1, fp: 0 },
    });
  });

  test("an item without a matcher answer makes every grounded metric null, and the summary says so", () => {
    const s = score(r, grounding({ dual: ["bug:B1"] }));
    expect(s.grounded).toBe(false);
    expect(s.suite.groundedRecall).toBeNull();
    expect(s.confusion).toBeNull();
    expect(s.suite.recall).toEqual(score(r).suite.recall);
    expect(summaryText(r, s)).toContain("Labels: none.");
    expect(summaryText(r, score(r, g))).toContain("Ship decisions use grounded metrics only.");
  });

  test("an unmatched shown item without a judge label leaves the judge metrics null, not the matcher metrics", () => {
    const s = score(r, grounding({ dual: ["bug:B1"], dup: [], trap: [], extra: [], noise: [], over: [], gone: [] })).suite;
    expect(s.groundedRecall?.mean).toBeCloseTo(1 / 3, 10);
    expect(s.augmentedPrecision).toBeNull();
    expect(s.newTp).toBeNull();
  });

  test("verifier loss: each raised must-find counts once, by the state of its best item, on one denominator", () => {
    const lc = gcase("l", [gbug("L1", 1), gbug("L2", 2), gbug("L3", 3), gbug("L4", 4), gbug("L5", 5)]);
    const lr = gresult(
      [lc],
      [
        run("l", 1, [
          at("folded", { group: "fold", severity: "minor" }),
          at("folded-refuted", { group: "hidden", verdict: "refuted" }),
          // A refuted finding of a protected class stays in main (review.ts FindingPayload.demoted).
          at("demoted", { verdict: "refuted" }),
          at("duplicate", { group: "hidden", verdict: "duplicate" }),
          at("refuted", { group: "hidden", verdict: "refuted" }),
          at("demoted-too", { verdict: "refuted" }),
          at("shown"),
        ]),
      ],
      "balanced",
    );
    const lg = grounding({
      folded: ["bug:L1"],
      "folded-refuted": ["bug:L1"],
      demoted: ["bug:L2"],
      duplicate: ["bug:L3"],
      refuted: ["bug:L4"],
      "demoted-too": ["bug:L5"],
      shown: ["bug:L5"],
    });
    const s = score(lr, lg).suite;
    // Shown: L2 (demoted, in main) and L5.
    expect(s.groundedRecall?.mean).toBe(0.4);
    expect(s.groundedRaised?.mean).toBe(1);
    const states = ["lossMain", "lossDemoted", "lossFolded", "lossDuplicate", "lossRefuted"] as const;
    for (const m of states) expect(s[m]?.mean).toBe(0.2);
    expect(states.reduce((n, m) => n + (s[m]?.mean ?? 0), 0)).toBeCloseTo(s.groundedRaised?.mean ?? 0, 10);
  });

  test("refuted findings in main count apart, and --fold-refuted folds them for recall and noise", () => {
    const fc = gcase("f", [gbug("F1", 10)], { traps: [], extras: [] });
    const fr = gresult(
      [fc],
      [
        run("f", 1, [
          item({ path: "g.ts", side: "new", line: 10, lineEnd: 10, verdict: "refuted", title: "kept" }),
          item({ path: "g.ts", side: "new", line: 40, lineEnd: 40, verdict: "refuted", title: "noise" }),
        ]),
      ],
    );
    expect(score(fr).suite.refutedShown?.mean).toBe(2);
    expect(score(fr).suite.recall?.mean).toBe(1);
    expect(score(fr).suite.noise?.mean).toBe(1);
    const { result, n } = foldRefuted(fr);
    expect(n).toBe(2);
    const s = score(result).suite;
    expect(s.refutedShown?.mean).toBe(0);
    expect(s.recall?.mean).toBe(0);
    expect(s.noise?.mean).toBe(0);
    expect(summaryText(result)).toContain("refuted findings folded");
  });

  test("candidate recall divides by the counted must-finds, as recall does", () => {
    // balanced: the nit bug N is out of the count. N is raised in fold, M is shown, J is missed.
    const cr = gresult(
      [gcase("c", [gbug("N", 10, { severityMin: "nit" }), gbug("M", 20, { severityMin: "minor" }), gbug("J", 30)])],
      [
        run("c", 1, [
          item({ path: "g.ts", side: "new", line: 10, lineEnd: 10, severity: "nit", group: "fold" }),
          item({ path: "g.ts", side: "new", line: 20, lineEnd: 20 }),
        ]),
      ],
      "balanced",
    );
    const s = score(cr).suite;
    expect(s.recall?.mean).toBe(0.5);
    // The old count: 2 raised of all 3 bugs. Now 1 raised of the 2 counted bugs.
    expect(s.candidateRecall?.mean).toBe(0.5);
  });

  test("slices count by severity, source, module, bug class, size, task text, and clean cases", () => {
    const sc = gcase(
      "s",
      [
        gbug("S1", 10, { source: "posted", module: "intent", category: "security" }),
        gbug("S2", 20, { severityMin: "minor", source: "other" }),
      ],
      { large: true, hasTask: true },
    );
    const clean = gcase("k", [], { large: false, clean: true });
    const sr = gresult([sc, clean], [run("s", 1, [at("hit"), at("miss")]), run("k", 1, [at("k-noise"), at("k-fp")])]);
    const sg = grounding(
      { hit: ["bug:S1"], miss: [], "k-noise": [], "k-fp": [] },
      {
        miss: { label: "tp", severity: "medium" },
        "k-noise": { label: "tp", severity: "low" },
        "k-fp": { label: "fp", severity: "low" },
      },
    );
    const rows = Object.fromEntries(score(sr, sg).slices.map((x) => [x.name, x]));
    expect(rows["severity blocker, major"]).toMatchObject({ mustFinds: 1, found: 1, runs: null });
    expect(rows["severity minor, nit"]).toMatchObject({ mustFinds: 1, found: 0 });
    expect(rows["source posted"]).toMatchObject({ mustFinds: 1, found: 1 });
    expect(rows["source other"]).toMatchObject({ mustFinds: 1, found: 0 });
    expect(rows["module intent"]).toMatchObject({ mustFinds: 1, found: 1 });
    expect(rows["class security"]).toMatchObject({ mustFinds: 1, found: 1 });
    expect(rows["class other"]).toMatchObject({ mustFinds: 1, found: 0 });
    expect(rows["large cases"]).toMatchObject({ mustFinds: 2, found: 1, runs: 1, noise: 1, judgeFp: 0 });
    expect(rows["small cases"]).toMatchObject({ mustFinds: 0, runs: 1, noise: 2, judgeFp: 1 });
    expect(rows["clean cases"]).toMatchObject({ runs: 1, noise: 2, judgeFp: 1 });
    expect(rows["cases with task text"]).toMatchObject({ runs: 1 });
    expect(rows["cases without task text"]).toMatchObject({ runs: 1 });
    expect(summaryText(sr, score(sr, sg))).toMatch(/clean cases\s+0\/0\s+-\s+1\s+2\.00\s+1\.00/);
  });

  test("the security row counts shown findings with category security per case run, by gold match and judge label", () => {
    const sec = { category: "security" };
    const sc = gcase("s", [gbug("S1", 10)]);
    const sr = gresult(
      [sc],
      [
        run("s", 1, [at("hit", sec), at("tp", sec), at("fp", sec), at("fp2", sec), at("other-fp")]),
        // A hidden finding and the category "injection" stay out.
        run("s", 2, [at("open", sec), at("hidden-fp", { ...sec, group: "hidden" }), at("inj-fp", { category: "injection" })]),
      ],
    );
    const sg = grounding(
      { hit: ["bug:S1"], tp: [], fp: [], fp2: [], "other-fp": [], open: [], "hidden-fp": [], "inj-fp": [] },
      {
        tp: { label: "tp", severity: "medium" },
        fp: { label: "fp", severity: "low" },
        fp2: { label: "fp", severity: "low" },
        "other-fp": { label: "fp", severity: "low" },
        "hidden-fp": { label: "fp", severity: "low" },
        "inj-fp": { label: "fp", severity: "low" },
      },
    );
    const s = score(sr, sg);
    expect(s.security).toEqual({ runs: 2, shown: 5, gold: 1, tp: 1, fp: 2, unlabeled: 1 });
    expect(summaryText(sr, s)).toMatch(
      /\ncase runs\s+shown\s+gold match\s+judge tp\s+judge fp\s+no label\n2\s+2\.50\s+0\.50\s+0\.50\s+1\.00\s+0\.50\n/,
    );
    // eval:compare prints the row for A and for B.
    expect(
      compareText(sr, sr, (id) => id, sr.profile.revision, [sg, sg]).match(/\n2\s+2\.50\s+0\.50\s+0\.50\s+1\.00\s+0\.50\n/g),
    ).toHaveLength(2);
    expect(score(sr).security).toBeNull();
  });

  test("macro is the mean of the case means, micro pools the cases", () => {
    const a = gcase("a", [gbug("A1", 10)], { traps: [], extras: [] });
    const b = gcase("b", [gbug("B1", 10), gbug("B2", 20), gbug("B3", 30)], { traps: [], extras: [] });
    const mr = gresult([a, b], [run("a", 1, [item({ path: "g.ts", side: "new", line: 10, lineEnd: 10 })]), run("b", 1, [])]);
    const s = score(mr);
    expect(s.suite.recall?.mean).toBe(0.25);
    expect(s.macro.recall).toBe(0.5);
    expect(summaryText(mr, s)).toMatch(/recall: seeded bugs with a shown finding\s+25\.0%\s+50\.0%/);
  });

  test("finderQuestions sums the counts of every run", () => {
    const q = {
      ...RESULT,
      runs: RESULT.runs.map((x, n) => ({ ...x, finderQuestions: { asked: n + 1, answered: n, findings: 1, kept: 0 } })),
    };
    expect(score(q).finderQuestions).toEqual({ asked: 10, answered: 6, findings: 4, kept: 0 });
    expect(summaryText(q)).toContain("Finder questions, all runs: 10 asked, 6 answered, 4 findings, 0 kept.");
    expect(score(RESULT).finderQuestions).toBeNull();
  });

  test("unionRecall: the mean over the k-subsets of repeats of the must-finds that any run shows or raises", () => {
    const u = gcase("u", [gbug("X", 10), gbug("Y", 20)], { traps: [], extras: [] });
    const ur = gresult(
      [u],
      [
        run("u", 1, [item({ path: "g.ts", side: "new", line: 10, lineEnd: 10 })]),
        run("u", 2, [
          item({ path: "g.ts", side: "new", line: 20, lineEnd: 20 }),
          item({ path: "g.ts", side: "new", line: 10, lineEnd: 10, group: "hidden", verdict: "refuted" }),
        ]),
      ],
    );
    expect(unionRecall(ur, 1)).toEqual({ shown: 0.5, raised: 0.75 });
    expect(unionRecall(ur, 2)).toEqual({ shown: 1, raised: 1 });
    expect(unionRecall(ur, 3)).toBeNull();
    expect(score(ur).union).toEqual([
      { k: 1, shown: 0.5, raised: 0.75 },
      { k: 2, shown: 1, raised: 1 },
    ]);
    // The ship rules read the spread S_R in bugs.
    expect(score(ur).recallBugs).toEqual([
      { repeat: 1, found: 1, mustFinds: 2 },
      { repeat: 2, found: 1, mustFinds: 2 },
    ]);
    expect(summaryText(ur)).toContain("Recall in bugs per repeat (line match): 1: 1/2, 2: 1/2. Spread: 0 bugs.");
  });

  test("pairedDelta: per must-find hit rate of B minus A, with a fixed-seed bootstrap over PR groups", () => {
    const p1 = gcase("p1", [gbug("P", 10)], { group: "g1", traps: [], extras: [] });
    const p2 = gcase("p2", [gbug("P", 10)], { group: "g2", traps: [], extras: [] });
    const a = gresult([p1, p2], [run("p1", 1, []), run("p2", 1, [])]);
    const b = gresult([p1, p2], [run("p1", 1, [item({ path: "g.ts", side: "new", line: 10, lineEnd: 10 })]), run("p2", 1, [])]);
    const d = pairedDelta(a, b);
    expect(d).toMatchObject({ delta: 0.5, low: 0, high: 1, mustFinds: 2, groups: 2, grounded: false });
    expect(pairedDelta(a, b)).toEqual(d);
    expect(compareText(a, b)).toContain("Paired delta (information only): B - A hit rate per counted must-find, line match: +50.0 pts");
    expect(pairedDelta(a, { ...b, cases: [] })).toBeNull();
  });
});

describe("evidence references (review-quality-2026.md item 8 gate)", () => {
  test("a reference is path:line or path:line-line with a / or . in the path; a URL, a bare word, and prose are none", () => {
    expect(evidenceRefs("src/a.ts:12 and `lib/b.py:3-5`, (c.go:7).")).toEqual([
      { path: "src/a.ts", line: 12, end: 12 },
      { path: "lib/b.py", line: 3, end: 5 },
      { path: "c.go", line: 7, end: 7 },
    ]);
    // A backslash path and a ./ prefix become repository paths. A column after the line is no end line.
    expect(evidenceRefs("src\\win\\x.cs:4 ./d/e.ts:9:2")).toEqual([
      { path: "src/win/x.cs", line: 4, end: 4 },
      { path: "d/e.ts", line: 9, end: 9 },
    ]);
    expect(evidenceRefs("see https://host.invalid:8080/x, Note:3, line 42 of a.ts, ratio 3:4")).toEqual([]);
    // A token must start at a boundary, so a path with a character outside the class is no reference, not a cut path.
    expect(evidenceRefs("src/app/[id]/page.tsx:12 src/@types/x.d.ts:3 x+y/a.cc:3")).toEqual([]);
    // A path that repoPath refuses stays raw, so the head lookup fails.
    expect(evidenceRefs("../up.ts:1")).toEqual([{ path: "../up.ts", line: 1, end: 1 }]);
  });

  // g.ts has 10 lines at the head. dual claims B1, trap claims T1, extra claims the extra, dup (a claimed duplicate) and noise get
  // judge labels, and plain has no label.
  const c = gcase("g", [gbug("B1", 10)]);
  const items = [
    at("dual", { evidence: "g.ts:10 and g.ts:9-10" }),
    at("dup", { evidence: "g.ts:11" }),
    at("trap", { evidence: "gone.ts:1" }),
    at("extra", { evidence: "no reference" }),
    at("noise", { evidence: "g.ts:0, g.ts:10-11, gone.ts:2" }),
    at("plain"),
  ];
  const r = gresult([c], [run("g", 1, items)]);
  const g = grounding(
    { dual: ["bug:B1"], dup: ["bug:B1"], trap: ["trap:T1"], extra: ["extra:0"], noise: [], plain: [] },
    { dup: { label: "tp", severity: "high" }, noise: { label: "fp", severity: "low" } },
  );
  const lines = (id: string, path: string) => (id === "g" && path === "g.ts" ? 10 : undefined);
  const zero = { findings: 0, unrecorded: 0, noRef: 0, withRef: 0, refs: 0, noFile: 0, pastEnd: 0 };

  test("each finding counts under its gold or judge label; a missing file and a line out of the file count apart", () => {
    expect(evidenceCheck([r], g, lines)).toEqual({
      "must-find": { ...zero, findings: 1, withRef: 1, refs: 2 },
      trap: { ...zero, findings: 1, withRef: 1, refs: 1, noFile: 1 },
      extra: { ...zero, findings: 1, noRef: 1 },
      "judge tp": { ...zero, findings: 1, withRef: 1, refs: 1, pastEnd: 1 },
      "judge fp": { ...zero, findings: 1, withRef: 1, refs: 3, noFile: 1, pastEnd: 1 },
      "no label": { ...zero, findings: 1, unrecorded: 1 },
    });
    // Without labels, or with an item that has no matcher answer, every finding of the run has no label.
    const none = evidenceCheck([r], undefined, lines)["no label"];
    expect(none).toEqual({ findings: 6, unrecorded: 1, noRef: 1, withRef: 4, refs: 7, noFile: 2, pastEnd: 2 });
    expect(evidenceCheck([r], grounding({ dual: ["bug:B1"] }), lines)["no label"]).toEqual(none);
    // Two results pool their runs.
    expect(evidenceCheck([r, r], g, lines).trap.findings).toBe(2);
  });

  test("the table prints counts and shares, and no path or finding text", () => {
    const text = evidenceText(evidenceCheck([r], g, lines));
    expect(text).toMatch(
      /label\s+findings\s+no evidence field\s+no path:line\s+with path:line\s+references\s+missing file\s+share\s+line out of file\s+share/,
    );
    expect(text).toMatch(/\ntrap\s+1\s+0\s+0\s+1\s+1\s+1\s+100\.0%\s+0\s+0\.0%\n/);
    expect(text).toMatch(/\nextra\s+1\s+0\s+1\s+0\s+0\s+0\s+-\s+0\s+-\n/);
    expect(text).not.toContain("g.ts");
    expect(text).not.toContain("dual");
  });
});
