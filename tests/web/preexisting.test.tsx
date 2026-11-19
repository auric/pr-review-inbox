// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v3.md WP-V6: the Pre-existing fold of the Drafts list. Its cards have no post action. Pure rules and static markup.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReviewItemDto, RunSummary, Volume } from "../../src/shared/dto";
import type { FindingPayload, VerifyMark } from "../../src/shared/review";
import { draftGroups, isPreexisting, ledgerParts, ledgerText } from "../../src/web/review/model";
import { Acts, type TriageCtx } from "../../src/web/review/Triage";

console.log(`preexisting.test.tsx imported from ${Bun.resolveSync("../../src/web/review/model", import.meta.dir)}`);

const anchor = { state: "outside" as const, path: "src/old.ts", oldPath: null, line: 2, lineEnd: 2, excerpt: [] };
const mark = (verdict: VerifyMark["verdict"]): VerifyMark => ({
  verdict,
  severity: "major",
  reason: "R.",
  evidence: "E.",
  duplicateOf: null,
  by: "rl-verify",
});
const finding = (id: number, f: Partial<FindingPayload> = {}, o: Partial<ReviewItemDto> = {}): ReviewItemDto => {
  const payload: FindingPayload = {
    path: "src/old.ts",
    side: "new",
    line: 2,
    lineEnd: null,
    anchorText: "x",
    severity: "major",
    category: "behavior",
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
const summary = (volume?: Volume): RunSummary => ({
  summary: "S.",
  risks: [],
  coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
  dropped: [],
  ...(volume && { volume }),
  verify: { candidates: 0, confirmed: 0, refuted: 0, unsure: 0, questions: 0, duplicates: 0, unchecked: 0 },
});
const ids = (l: ReviewItemDto[]) => l.map((i) => i.id);

// 1 and 2 are normal findings. 3 and 4 are pre-existing, 5 is a pre-existing finding that the check refuted.
const SET = [
  finding(1, { severity: "blocker", verify: mark("confirmed") }),
  finding(2, { severity: "nit", verify: mark("confirmed") }),
  finding(3, { preexisting: true, severity: "blocker", verify: mark("confirmed") }),
  finding(4, { preexisting: true, verify: mark("confirmed") }),
  finding(5, { preexisting: true, verify: mark("refuted"), discardedBy: "verify" }, { status: "discarded" }),
];

describe("draft groups", () => {
  test("pre-existing findings go to their own group at every volume, never to main or the fold More", () => {
    for (const volume of ["quiet", "balanced", "thorough", undefined] as const) {
      const g = draftGroups(SET, summary(volume));
      expect(ids(g.preexisting)).toEqual([3, 4]);
      expect(ids(g.hidden)).toEqual([5]);
      expect([...g.main, ...g.fold].some(isPreexisting)).toBe(false);
    }
    // The ledger counts the main list and More only.
    expect(ledgerParts(draftGroups(SET, summary("balanced")), null).map(ledgerText)).toEqual(["1 must fix", "1 more"]);
  });
});

describe("card actions", () => {
  const noop = () => {};
  const tctx: TriageCtx = {
    pr: 1,
    act: noop,
    edit: noop,
    save: noop,
    move: noop,
    moveTo: noop,
    tick: noop,
    reason: noop,
    quiet: () => false,
  };
  test("a pre-existing card offers Discard only: no Accept, no Edit, no Move", () => {
    const pre = renderToStaticMarkup(<Acts it={SET[2] as ReviewItemDto} busy={false} noPost ctx={tctx} />);
    expect(pre).toContain("Discard");
    for (const word of ["Accept", "Edit", "Move"]) expect(pre).not.toContain(word);
    const plain = renderToStaticMarkup(<Acts it={SET[0] as ReviewItemDto} busy={false} ctx={tctx} />);
    for (const word of ["Accept", "Edit", "Discard", "Move"]) expect(plain).toContain(word);
  });
});
