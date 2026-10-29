// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2 AC-M1: the eval scorer gives the documented numbers on a hand-made result. No process, no file.
import { describe, expect, test } from "bun:test";
import type { EvalBug } from "../../scripts/eval/cases";
import { compareText, summaryText } from "../../scripts/eval/compare";
import { rescore } from "../../scripts/eval/rescore";
import { type CaseRun, type EvalItem, type EvalResult, overlaps, score } from "../../scripts/eval/score";

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
