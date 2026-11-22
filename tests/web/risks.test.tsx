// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/risk-check.md sections 4.8 and 4.9 (AC-R46, AC-R47) and postable-risks.md section 4.3: the risk toggle, the
// risk entries with their drafts, and the risk lines of Review quality. Pure rules and one element tree.
import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FinderRisks, ReviewItemDto, ReviewStatsDto, RunDto, RunSummary } from "../../src/shared/dto";
import type { FindingPayload } from "../../src/shared/review";
import { riskEntries, risksLabel, runningText } from "../../src/web/review/model";
import { RiskEntries } from "../../src/web/review/RiskEntries";
import { risksText } from "../../src/web/settings/quality";

console.log(`risks.test.tsx imported from ${Bun.resolveSync("../../src/web/review/model", import.meta.dir)}`);

const anchor = { state: "exact" as const, path: "src/cache.ts", oldPath: null, line: 40, lineEnd: 40, excerpt: [] };
const finding = (id: number, f: Partial<FindingPayload> = {}, o: Partial<ReviewItemDto> = {}): ReviewItemDto => {
  const payload: FindingPayload = {
    path: "src/cache.ts",
    side: "new",
    line: 40,
    lineEnd: null,
    anchorText: "x",
    severity: "minor",
    category: "risk",
    title: `Title ${id}`,
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
    run: 7,
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
const LIST: FinderRisks["list"] = [
  { text: "The TODO is stale.", outcome: "found", note: "Title 10" },
  { text: "A reader sees a partial batch.", outcome: "cleared", note: "src/cache.ts:12 holds the lock." },
  { text: "Same as finding 1.", outcome: "covered", note: "Same point as: Title 1 (confirmed)" },
  { text: "Does the folder ship?", outcome: "open", note: "Confirmed, but the check could not place it: The folder ships" },
  { text: "An old asked risk.", outcome: "asked", note: "Must b2 ship?" },
];
const summary = (finderRisks?: FinderRisks): RunSummary => ({
  summary: "S.",
  risks: ["Risk area one.", "Risk area two."],
  coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
  dropped: [],
  ...(finderRisks && { finderRisks }),
});
const RISKS: FinderRisks = { listed: 5, found: 1, asked: 1, cleared: 1, covered: 1, open: 1, list: LIST };

describe("the risk toggle (AC-R46)", () => {
  test("names the counts above zero; a run without finderRisks keeps the old list", () => {
    expect(risksLabel(summary(RISKS))).toBe("Risks: 1 found, 1 asked, 1 cleared, 1 same as a finding, 1 open");
    expect(risksLabel(summary({ ...RISKS, listed: 3, found: 1, asked: 0, cleared: 2, covered: 0, open: 0 }))).toBe(
      "Risks: 1 found, 2 cleared",
    );
    expect(risksLabel(summary())).toBeNull();
    expect(risksLabel(summary({ listed: 0, found: 0, asked: 0, cleared: 0, covered: 0, open: 0, list: [] }))).toBeNull();
    expect(risksLabel(null)).toBeNull();
  });

  test("a check with no candidate names its questions and risks", () => {
    const run = (o: Partial<RunDto>) => ({ kind: "review", explain: false, phase: "checking", ...o }) as RunDto;
    expect(runningText(run({ candidates: 0, checkRisks: 2 }))).toBe("Checking 2 risks…");
    expect(runningText(run({ candidates: 0, checkQuestions: 1, checkRisks: 2 }))).toBe("Checking 1 question and 2 risks…");
    expect(runningText(run({ candidates: 0, checkQuestions: 2 }))).toBe("Checking 2 questions…");
    expect(runningText(run({ candidates: 3, checkRisks: 2 }))).toBe("Checking 3 findings…");
  });
});

describe("risk entries and their drafts (postable-risks.md 4.2, 4.3)", () => {
  test("each entry keeps its text and outcome; line 2 names the note when no draft matches", () => {
    const e = riskEntries(summary(RISKS), [], 7);
    expect(e?.map((x) => [x.outcome, x.text, x.note, x.draft])).toEqual([
      ["found", "The TODO is stale.", "Draft: Title 10", undefined],
      ["cleared", "A reader sees a partial batch.", "The check says: src/cache.ts:12 holds the lock.", undefined],
      ["covered", "Same as finding 1.", "Same point as: Title 1 (confirmed)", undefined],
      ["open", "Does the folder ship?", "Confirmed, but the check could not place it: The folder ships", undefined],
      ["asked", "An old asked risk.", "Question: Must b2 ship?", undefined],
    ]);
    // A run without finderRisks gives null, so the run line keeps "Risk areas: N".
    expect(riskEntries(summary(), [finding(10, { fromRisk: 0 })], 7)).toBeNull();
  });

  test("the state word follows the item; a posted draft has no link", () => {
    const state = (o: Partial<ReviewItemDto>, f: Partial<FindingPayload> = {}) =>
      riskEntries(summary(RISKS), [finding(10, { fromRisk: 0, ...f }, o)], 7)?.[0]?.draft;
    expect(state({})).toEqual({ id: 10, state: "Draft", title: "Title 10", linked: true });
    expect(state({ status: "accepted" })?.state).toBe("Accepted");
    expect(state({ status: "discarded" })?.state).toBe("Discarded");
    expect(state({ status: "discarded" }, { fixed: { id: 1, commit: "c", short: "abc1234", was: "new" } } as never)?.state).toBe(
      "Fixed in abc1234",
    );
    expect(state({ status: "posted" })).toEqual({ id: 10, state: "Posted", title: "Title 10", linked: false });
    // An edit shows: the title comes from draftTitle.
    expect(state({}, { title: "Edited title" })?.title).toBe("Edited title");
  });

  test("a carried copy, a Discuss revision, an item of another run, and an item without fromRisk never match", () => {
    const carried = { carried: { from: 3, verdict: "open" as const, reason: "", since: "h" } };
    const items = [
      finding(11, { fromRisk: 0, ...carried } as Partial<FindingPayload>),
      finding(12, { fromRisk: 0, revises: 10 }, { status: "discarded" }),
      finding(13, { fromRisk: 0 }, { run: 6 }),
      finding(14),
    ];
    expect(riskEntries(summary(RISKS), items, 7)?.map((x) => x.draft)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    // Only entry k gets the item with fromRisk k.
    const linked = riskEntries(summary(RISKS), [...items, finding(15, { fromRisk: 3 })], 7);
    expect(linked?.map((x) => x.draft?.id)).toEqual([undefined, undefined, undefined, 15, undefined]);
  });
});

// The element tree of RiskEntries, without a DOM: each button with its props.
function buttons(node: ReactNode): ReactElement<{ onClick: () => void; children: ReactNode }>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as ReactElement<{ children?: ReactNode; onClick: () => void }>;
  const inner = typeof el.type === "function" ? buttons((el.type as (p: unknown) => ReactNode)(el.props)) : buttons(el.props.children);
  return el.type === "button" ? [el as ReactElement<{ onClick: () => void; children: ReactNode }>, ...inner] : inner;
}

describe("the entry markup", () => {
  test('"Show draft" calls openDraft with the item ID; a posted draft and an entry without a draft have no button', () => {
    const items = [finding(10, { fromRisk: 0 }), finding(20, { fromRisk: 1 }, { status: "posted" })];
    const entries = riskEntries(summary(RISKS), items, 7);
    const opened: number[] = [];
    const tree = RiskEntries({ entries, onDraft: (id) => opened.push(id) });
    const found = buttons(tree);
    expect(found).toHaveLength(1);
    found[0]?.props.onClick();
    expect(opened).toEqual([10]);
    const html = renderToStaticMarkup(<RiskEntries entries={entries} onDraft={() => {}} />);
    expect(html).toContain('Show draft<span class="sr-only"> of risk 1</span>');
    expect(html).toContain("Posted:");
    expect(html).toContain("same as a finding");
    expect(renderToStaticMarkup(<RiskEntries entries={null} onDraft={() => {}} />)).toBe("");
  });
});

describe("Review quality risk lines (AC-R47)", () => {
  const risks = (o: Partial<NonNullable<ReviewStatsDto["risks"]>> = {}): ReviewStatsDto["risks"] => ({
    runs: 2,
    listed: 12,
    found: 3,
    asked: 1,
    cleared: 5,
    covered: 2,
    open: 1,
    posted: 2,
    discarded: 1,
    questions: { posted: 0, discarded: 0 },
    ...o,
  });
  test("the sums and the risk findings; risk questions only when one posted or was discarded; nothing without runs", () => {
    expect(risksText(risks())).toEqual([
      "Risks: 12 listed",
      "3 found, 1 asked, 5 cleared, 2 same as a finding, 1 open",
      "Risk findings: 2 posted, 1 discarded",
    ]);
    expect(risksText(risks({ questions: { posted: 1, discarded: 0 } }))[3]).toBe("Risk questions: 1 posted, 0 discarded");
    // A stored group from before WP-RC4 has no risks key.
    expect(risksText(undefined)).toEqual([]);
    expect(risksText(risks({ runs: 0 }))).toEqual([]);
    // Zero outcomes drop; a group with runs and no listed risk shows only the sums.
    expect(risksText(risks({ found: 0, asked: 0, covered: 0 }))[1]).toBe("5 cleared, 1 open");
    expect(risksText(risks({ listed: 0, found: 0, asked: 0, cleared: 0, covered: 0, open: 0 }))).toEqual([
      "Risks: 0 listed",
      "Risk findings: 2 posted, 1 discarded",
    ]);
  });
});
