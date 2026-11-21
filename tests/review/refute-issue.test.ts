// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/verifier-rule.md WP-VR1 (AC-R57 to AC-R59): the verify-only variant "refute-issue". AC-R56 (no byte change
// without the variant) is pinned by the hashes in prompt.test.ts, risk-check.test.ts, and obligations.test.ts. Pure parts only.
import { describe, expect, test } from "bun:test";
import { itemHash } from "../../scripts/eval/label";
import type { EvalItem } from "../../scripts/eval/score";
import {
  DO_NOT_FLAG,
  mainAgent,
  NO_CONTEXT,
  obligationCheck,
  promptVersion,
  REFUTE_ISSUE_VERIFY,
  type ReviewContext,
  refuteIssue,
  reviewerAgent,
  SHIPPED_PROFILES,
  salvageAgent,
  verifierAgent,
  verifyAgent,
} from "../../src/server/review/catalog";
import { REVIEW_PROMPT_VERSION, verifyJsonSchema } from "../../src/shared/review";

console.log(`refute-issue.test.ts imported from ${Bun.resolveSync("../../src/server/review/catalog", import.meta.dir)}`);

const general = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];
const on = <P extends (typeof SHIPPED_PROFILES)[number]>(p: P) => ({ ...p, variants: [...p.variants, "refute-issue" as const] });
const refuting = on(general);
const GOAL: ReviewContext = { ...NO_CONTEXT, taskFile: true, goal: true, prContext: true };
const NO_TRIGGER = "For a candidate without a trigger, look for one. When you find it, give confirmed, and put the trigger into reason.";
const lines = (prompt: string) => prompt.split("\n");

describe("variant refute-issue (verifier-rule.md WP-VR1)", () => {
  test("AC-R57: rl-verify and rl-verifier hold the lines once, right after the no-trigger line, also with questions and risks", () => {
    for (const q of [false, true])
      for (const r of [false, true]) {
        const agents = [
          verifyAgent(refuting, GOAL, q, [], r),
          verifyAgent(refuting, GOAL, q, [], r, true),
          verifierAgent(refuting, GOAL, q, [], r),
        ];
        for (const a of agents) {
          const l = lines(a.prompt);
          const at = l.indexOf(NO_TRIGGER);
          expect(at).toBeGreaterThan(-1);
          expect(l.slice(at + 1, at + 1 + REFUTE_ISSUE_VERIFY.length)).toEqual(REFUTE_ISSUE_VERIFY);
          for (const x of REFUTE_ISSUE_VERIFY) expect(l.filter((y) => y === x)).toHaveLength(1);
        }
        for (const a of [verifyAgent(general, GOAL, q, [], r), verifierAgent(general, GOAL, q, [], r)])
          for (const x of REFUTE_ISSUE_VERIFY) expect(lines(a.prompt)).not.toContain(x);
      }
  });

  test("AC-R58: the finder, reviewer, and salvage prompts and the verify schema stay the same; the version names the variant", () => {
    for (const p of SHIPPED_PROFILES) {
      expect(refuteIssue(p)).toBe(false);
      const v = on(p);
      expect(refuteIssue(v)).toBe(true);
      for (const c of [NO_CONTEXT, GOAL]) {
        expect(mainAgent(v, c).prompt).toBe(mainAgent(p, c).prompt);
        expect(reviewerAgent(v, c).prompt).toBe(reviewerAgent(p, c).prompt);
      }
      expect(salvageAgent(v).prompt).toBe(salvageAgent(p).prompt);
      expect(verifyJsonSchema(obligationCheck(v))).toEqual(verifyJsonSchema(obligationCheck(p)));
    }
    expect(promptVersion(refuting)).toBe(`${REVIEW_PROMPT_VERSION}+refute-issue`);
  });

  test("ASD-STE100: each sentence of the lines has at most 20 words, with no CRITICAL, MUST, or IMPORTANT", () => {
    const long = REFUTE_ISSUE_VERIFY.flatMap((l) => l.split(/(?<=[.!?])\s+/)).filter((s) => s.split(/\s+/).filter(Boolean).length > 20);
    expect(long).toEqual([]);
    expect(REFUTE_ISSUE_VERIFY.join("\n")).not.toMatch(/\b(CRITICAL|MUST|IMPORTANT)\b/);
    // Line 8 quotes a do-not-flag item. It must match that item.
    expect(DO_NOT_FLAG).toContain("a choice between two correct designs");
  });

  test("AC-R59: checkReason stays out of the label hash, so labels carry over between replays", () => {
    const item = {
      path: "src/a.ts",
      side: "new",
      line: 3,
      lineEnd: 3,
      title: "T",
      trigger: "When x is null.",
      body: "B",
    } as EvalItem;
    expect(itemHash({ ...item, checkReason: "The right trigger is src/a.ts:9." })).toBe(itemHash(item));
  });
});
