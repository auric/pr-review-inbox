// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review UI v2 (docs/plans/review-v2/spec.md sections 1.1, 1.4, 1.8, 1.9): the display groups per volume, the ledger, the check chip
// and lines, the refuted list, the phase line, and the run log groups. Pure rules only.
import { describe, expect, test } from "bun:test";
import { MODULES } from "../../src/server/review/catalog";
import { MODULE_IDS, type ReviewItemDto, type RunDto, type RunSummary, TRIAL_MODULES, type Volume } from "../../src/shared/dto";
import type { FindingPayload, VerifyMark } from "../../src/shared/review";
import type { RunEvent } from "../../src/shared/run-log";
import {
  checkChip,
  checkFailedText,
  checkText,
  countText,
  draftGroups,
  draftTitle,
  hiddenParts,
  ledgerParts,
  ledgerText,
  logPhases,
  logTree,
  MODULE_LABEL,
  MORE_CHECKS,
  phaseParts,
  restoredNote,
  runningText,
  SHOWN_CHECKS,
  VOLUME_LINE,
} from "../../src/web/review/model";
import { problems, toDrafts, toProfiles } from "../../src/web/settings/profiles";

const anchor = { state: "exact" as const, path: "src/cache.ts", oldPath: null, line: 40, lineEnd: 40, excerpt: [] };
const mark = (verdict: VerifyMark["verdict"], o: Partial<VerifyMark> = {}): VerifyMark => ({
  verdict,
  severity: "major",
  reason: "The guard on line 12 stops it.",
  evidence: "src/cache.ts:12",
  duplicateOf: null,
  by: "rl-verify",
  ...o,
});
const finding = (id: number, f: Partial<FindingPayload> = {}, o: Partial<ReviewItemDto> = {}): ReviewItemDto => {
  const payload: FindingPayload = {
    path: "src/cache.ts",
    side: "new",
    line: 40,
    lineEnd: null,
    anchorText: "x",
    severity: "major",
    category: "Correctness",
    body: `Body ${id}.`,
    evidence: "",
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
    anchor,
    ...f,
  };
  return {
    id,
    run: 1,
    kind: "finding",
    body: payload.body,
    payload,
    anchor: { ...anchor, side: "new" },
    status: "new",
    revision: 0,
    edited: false,
    ...o,
  };
};
const summary = (o: Partial<RunSummary> = {}): RunSummary => ({
  summary: "S.",
  risks: [],
  coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
  dropped: [],
  ...o,
});
const VERIFY = { candidates: 0, confirmed: 0, refuted: 0, unsure: 0, questions: 0, duplicates: 0, unchecked: 0 };

// One finding of each kind that spec.md section 1.4 sorts.
const SET = [
  finding(1, { severity: "blocker", verify: mark("confirmed") }),
  finding(2, { severity: "major" }),
  finding(3, { severity: "minor", verify: mark("confirmed") }),
  finding(4, { severity: "minor", verify: mark("unsure") }),
  finding(5, { severity: "nit", verify: mark("confirmed") }),
  finding(6, { verify: mark("refuted"), discardedBy: "verify" }, { status: "discarded" }),
  finding(7, { verify: mark("duplicate"), discardedBy: "verify" }, { status: "discarded" }),
];
const ids = (l: ReviewItemDto[]) => l.map((i) => i.id);
const groupsOf = (volume?: Volume) => draftGroups(SET, summary({ ...(volume && { volume }), verify: VERIFY }));

describe("display groups per volume (spec.md section 1.4)", () => {
  test("quiet: blocker and major in main, the rest in the fold More", () => {
    const g = groupsOf("quiet");
    expect([ids(g.main), ids(g.fold), ids(g.hidden), g.foldName]).toEqual([[1, 2], [3, 4, 5], [6, 7], "More"]);
  });

  test("balanced: no nits and no unsure points in main; they wait in Low confidence", () => {
    const g = groupsOf("balanced");
    expect([ids(g.main), ids(g.fold), ids(g.hidden), g.foldName]).toEqual([[1, 2, 3], [4, 5], [6, 7], "Low confidence"]);
  });

  test("thorough: everything but refuted and duplicates in main, no fold", () => {
    const g = groupsOf("thorough");
    expect([ids(g.main), ids(g.fold), ids(g.hidden), g.foldName]).toEqual([[1, 2, 3, 4, 5], [], [6, 7], null]);
  });

  test("a run from before review v2 shows every finding and no chip", () => {
    const g = draftGroups(SET.slice(0, 5), summary());
    expect([ids(g.main), g.foldName, g.checked]).toEqual([[1, 2, 3, 4, 5], null, false]);
    expect(checkChip(SET[0] as ReviewItemDto, g.checked)).toBeNull();
    expect(draftGroups([], null)).toMatchObject({ main: [], checked: false });
  });

  test("a restored refuted finding leaves the run record and shows as not checked", () => {
    const back = finding(8, { severity: "minor", verify: mark("refuted") });
    const g = draftGroups([back], summary({ volume: "balanced", verify: VERIFY }));
    expect(ids(g.main)).toEqual([8]);
    expect(checkChip(back, g.checked)).toBe("Not checked");
    expect(restoredNote(back)).toBe("Refuted by the check. You restored it.");
    expect(restoredNote(finding(9, { verify: mark("duplicate") }))).toBe("A duplicate by the check. You restored it.");
    // Hidden, or discarded again by the user: no note.
    expect(restoredNote(SET[5] as ReviewItemDto)).toBeNull();
    expect(restoredNote(finding(10, { verify: mark("refuted") }, { status: "discarded" }))).toBeNull();
    expect(restoredNote(SET[0] as ReviewItemDto)).toBeNull();
  });
});

describe("cards: chip, title, trigger, and check reason (spec.md section 1.1)", () => {
  test("the chip names the check state in words", () => {
    expect(SET.slice(0, 4).map((i) => checkChip(i, true))).toEqual(["Checked", "Not checked", "Checked", "Low confidence"]);
  });

  test("the check line gives the reason and the line that shows it", () => {
    expect(checkText(SET[0] as ReviewItemDto)).toBe("Check: The guard on line 12 stops it. (src/cache.ts:12)");
    expect(checkText(finding(1, { verify: mark("unsure", { evidence: " " }) }))).toBe("Check: The guard on line 12 stops it.");
    expect(checkText(SET[1] as ReviewItemDto)).toBeNull();
  });

  test("a row shows the title, or the body of a finding without one", () => {
    expect(draftTitle(finding(1, { title: "Lost update on concurrent fill" }))).toBe("Lost update on concurrent fill");
    expect(draftTitle(finding(1, { title: " " }))).toBe("Body 1.");
    expect(draftTitle(finding(1))).toBe("Body 1.");
  });
});

describe("ledger and refuted line", () => {
  test("plain words: must fix, worth fixing, polish, the fold, and questions, each with its first draft", () => {
    const g = groupsOf("balanced");
    expect(ledgerParts(g, { n: 2, first: 30 }).map((p) => [ledgerText(p), p.first])).toEqual([
      ["2 must fix", 1],
      ["1 worth fixing", 3],
      ["2 low confidence", 4],
      ["2 questions", 30],
    ]);
    expect(ledgerParts(groupsOf("quiet"), null).map(ledgerText)).toEqual(["2 must fix", "3 more"]);
    expect(ledgerParts(groupsOf("thorough"), { n: 1, first: 30 }).map(ledgerText)).toEqual([
      "2 must fix",
      "2 worth fixing",
      "1 polish",
      "1 question",
    ]);
  });

  test("discarded drafts do not count, and an empty run gives no part", () => {
    const g = draftGroups([finding(1, {}, { status: "discarded" }), finding(2, { severity: "minor" }, { status: "accepted" })], summary());
    expect(ledgerParts(g, null).map(ledgerText)).toEqual(["1 worth fixing"]);
    expect(ledgerParts(draftGroups([], null), null)).toEqual([]);
  });

  test("the run record line counts refuted points and duplicates apart", () => {
    expect(hiddenParts(groupsOf("balanced").hidden)).toEqual(["1 refuted by the check", "1 duplicate"]);
    expect(hiddenParts([SET[5] as ReviewItemDto, SET[5] as ReviewItemDto])).toEqual(["2 refuted by the check"]);
    expect(hiddenParts([])).toEqual([]);
  });

  test("the run result leaves out the refuted points; a complete v2 run without findings names the checked areas", () => {
    expect(countText(SET, false, "review", true)).toBe("5 findings");
    expect(countText([SET[5] as ReviewItemDto], false, "review", true)).toBe("No problems found in the checked areas");
    // G6: an incomplete run never says that it found nothing wrong.
    expect(countText([SET[5] as ReviewItemDto], true, "review", true)).toBe("No findings in what it read");
    expect(countText([], false, "review", false)).toBe("No findings");
  });
});

describe("run line (spec.md sections 1.1 and 1.9)", () => {
  const run = (o: Partial<RunDto> = {}) => ({ kind: "review", explain: null, since: null, ...o }) as RunDto;

  test("a running review names its phase", () => {
    expect(runningText(run({ phase: "finding" }))).toBe("Finding problems…");
    expect(runningText(run())).toBe("Finding problems…");
    expect(runningText(run({ phase: "checking", candidates: 9 }))).toBe("Checking 9 findings…");
    expect(runningText(run({ phase: "checking", candidates: 1 }))).toBe("Checking 1 finding…");
    expect(runningText(run({ phase: "indexing" }))).toBe("Indexing for codegraph…");
    expect(runningText(run({ since: { head: "abcdef0123456789", incremental: true } }))).toBe(
      "Finding problems in the changes since abcdef0…",
    );
    expect(runningText(run({ kind: "reply" }))).toBe("Drafting replies…");
    expect(runningText(run({ explain: true }))).toBe("Reviewing…");
  });

  test("a finished run gives the time of each phase, and the run setup adds their tokens", () => {
    const usage = (n: number) => ({ costUsd: 0, turns: 1, durationMs: 1, tokens: { input_tokens: n, output_tokens: 0 } });
    const s = summary({
      phases: [
        { name: "find", startedAt: 0, endedAt: 8 * 60_000, usage: usage(120_000) },
        { name: "check", startedAt: 8 * 60_000, endedAt: 8 * 60_000 + 40_000, usage: null },
      ],
    });
    expect(phaseParts(s)).toEqual(["Finding 8 min", "Checking 40 s"]);
    expect(phaseParts(s, true)).toEqual(["Finding 8 min, 120k tokens", "Checking 40 s"]);
    expect(phaseParts(summary({ phases: [{ name: "find", startedAt: 0, endedAt: null, usage: null }] }))).toEqual([]);
    expect(phaseParts(summary())).toEqual([]);
  });

  test("a check that did not finish says how many findings are not checked", () => {
    const failed = { kind: "usage_limit" as const, text: "Limit." };
    expect(checkFailedText(summary({ verify: { ...VERIFY, unchecked: 9, failed } }))).toBe(
      "The check did not finish: 9 findings are not checked.",
    );
    expect(checkFailedText(summary({ verify: { ...VERIFY, unchecked: 1, failed } }))).toBe(
      "The check did not finish: 1 finding is not checked.",
    );
    // The check off: each finding is unchecked, but nothing failed.
    expect(checkFailedText(summary({ verify: { ...VERIFY, unchecked: 4 } }))).toBeNull();
    expect(checkFailedText(null)).toBeNull();
  });
});

describe("run log groups (design.md section 5.1)", () => {
  const ev = (id: string, seq: number, parent: string | null = null): RunEvent => ({
    id,
    seq,
    parent,
    tool: "Read",
    target: "x",
    status: "ok",
    note: null,
    agent: null,
    model: null,
    tokens: null,
    builtin: false,
    startedAt: 0,
    endedAt: 1,
  });

  test("the check events show under Check, after the finder events", () => {
    const tree = logTree([ev("a", 1), ev("check:b", 2), ev("check:c", 3, "check:b"), ev("d", 0)]);
    expect(logPhases(tree).map((g) => [g.phase, g.nodes.map((n) => n.e.id)])).toEqual([
      ["find", ["d", "a"]],
      ["check", ["check:b"]],
    ]);
    expect(logPhases(logTree([ev("a", 1)])).map((g) => g.phase)).toEqual(["find"]);
  });
});

describe("checks and volume of a profile (spec.md sections 1.1 to 1.4)", () => {
  test("the labels are the module labels of the review prompt", () => {
    expect(MODULE_LABEL).toEqual(Object.fromEntries(MODULE_IDS.map((m) => [m, MODULES[m].label])) as typeof MODULE_LABEL);
    // docs/plans/review-v3.md WP-V2: a trial module stays out of the brief until WP-V4.
    expect([...SHOWN_CHECKS, ...MORE_CHECKS, ...TRIAL_MODULES].sort()).toEqual([...MODULE_IDS].sort());
    expect(VOLUME_LINE.balanced).toBe("Balanced: must-fix and worth-fixing points. Unsure points wait in a fold.");
  });

  test("the editor keeps the check step: an empty model or effort saves as null, and a bad model name is a problem", () => {
    const base = {
      id: "general",
      name: "Review",
      note: "",
      prompt: "P.",
      explain: false,
      docs: true,
      languageChecks: true,
      maxTurns: 100,
      skills: [],
      alwaysSkills: [],
      mcp: [],
      model: null,
      effort: null,
      reviewer: { model: null, effort: null, mode: "auto" as const },
      modules: ["security" as const],
      volume: "quiet" as const,
      verifier: { mode: "on" as const, model: null, effort: "high" as const },
      variants: [],
    };
    const [d] = toDrafts([base]);
    expect(d?.verifier).toEqual({ mode: "on", model: "", effort: "high" });
    expect(toProfiles([{ ...(d as NonNullable<typeof d>), verifier: { mode: "off", model: " ", effort: "" } }])[0]).toMatchObject({
      modules: ["security"],
      volume: "quiet",
      verifier: { mode: "off", model: null, effort: null },
    });
    expect(
      problems({ ...(d as NonNullable<typeof d>), verifier: { mode: "on", model: "bad name", effort: "" } }).verifierModel,
    ).toBeTruthy();
  });
});
