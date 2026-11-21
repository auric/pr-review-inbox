// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/architecture-bugs.md WP-AR1 (AC-R68 to AC-R72): the opt-in finder variant "architecture". The hashes in
// prompt.test.ts, risk-check.test.ts, and obligations.test.ts also pin AC-R68. Pure parts only.
import { describe, expect, test } from "bun:test";
import {
  ARCHITECTURE_LINES,
  ARCHITECTURE_VERIFY,
  architecture,
  CALLERS_LINES,
  DO_NOT_FLAG,
  mainAgent,
  NO_CONTEXT,
  PREEXISTING_VERIFY,
  promptVersion,
  type ReviewContext,
  reviewerAgent,
  SHIPPED_PROFILES,
  salvageAgent,
  verifierAgent,
  verifyAgent,
} from "../../src/server/review/catalog";
import type { Variant } from "../../src/shared/dto";
import { REVIEW_PROMPT_VERSION } from "../../src/shared/review";

console.log(`architecture.test.ts imported from ${Bun.resolveSync("../../src/server/review/catalog", import.meta.dir)}`);

type Shipped = (typeof SHIPPED_PROFILES)[number];
const general = SHIPPED_PROFILES[0] as Shipped;
const withV = (p: Shipped, ...v: Variant[]) => ({ ...p, variants: [...p.variants, ...v] });
const GOAL: ReviewContext = { ...NO_CONTEXT, taskFile: true, goal: true, prContext: true };
const lines = (prompt: string) => prompt.split("\n");
const ALL = [...ARCHITECTURE_LINES, ...ARCHITECTURE_VERIFY];
const finders = (p: Shipped, c: ReviewContext) => [mainAgent(p, c), reviewerAgent(p, c), reviewerAgent(p, c, true)];
const verifiers = (p: Shipped, c: ReviewContext) => [
  verifyAgent(p, c),
  verifyAgent(p, c, true, [], true, true),
  verifierAgent(p, c, true, [], true),
];
// Index of the first line of block in l, or -1. The block must be contiguous.
const at = (l: string[], block: readonly string[]) => l.findIndex((_, i) => block.every((x, j) => l[i + j] === x));

describe("variant architecture (architecture-bugs.md WP-AR1)", () => {
  test("AC-R68: without the variant, no prompt holds a line of the variant", () => {
    for (const p of SHIPPED_PROFILES) {
      expect(architecture(p)).toBe(false);
      for (const c of [NO_CONTEXT, GOAL])
        for (const a of [...finders(p, c), ...verifiers(p, c), salvageAgent(p)])
          for (const x of ALL) expect(lines(a.prompt)).not.toContain(x);
    }
  });

  test("AC-R69: rl-main and rl-reviewer hold the finder lines once, at the place of CALLERS_LINES, and stacked right after them", () => {
    // The Explain profile runs explainAgent as rl-main, which gets no finder lines.
    const explain = SHIPPED_PROFILES.find((p) => p.explain) as Shipped;
    expect(mainAgent(withV(explain, "architecture")).prompt).toBe(mainAgent(explain).prompt);
    for (const p of SHIPPED_PROFILES.filter((x) => !x.explain))
      for (const c of [NO_CONTEXT, GOAL]) {
        const base = finders(p, c);
        const arch = finders(withV(p, "architecture"), c);
        const call = finders(withV(p, "callers"), c);
        const both = finders(withV(p, "callers", "architecture"), c);
        for (let i = 0; i < base.length; i++) {
          const a = lines(arch[i]?.prompt ?? "");
          const k = at(a, ARCHITECTURE_LINES);
          expect(k).toBeGreaterThan(-1);
          for (const x of ARCHITECTURE_LINES) expect(a.filter((y) => y === x)).toHaveLength(1);
          // Only the block differs from the default prompt.
          expect([...a.slice(0, k), ...a.slice(k + ARCHITECTURE_LINES.length)]).toEqual(lines(base[i]?.prompt ?? ""));
          const cl = lines(call[i]?.prompt ?? "");
          expect(a[k - 1]).toBe(cl[at(cl, CALLERS_LINES) - 1]);
          const b = lines(both[i]?.prompt ?? "");
          const j = at(b, CALLERS_LINES);
          expect(j).toBeGreaterThan(-1);
          expect(at(b, ARCHITECTURE_LINES)).toBe(j + CALLERS_LINES.length);
          for (const x of ARCHITECTURE_VERIFY) expect(b).not.toContain(x);
        }
      }
  });

  test("AC-R70: rl-verify and rl-verifier hold the verify lines once, only under the variant", () => {
    for (const p of SHIPPED_PROFILES)
      for (const c of [NO_CONTEXT, GOAL]) {
        for (const a of verifiers(withV(p, "architecture"), c)) {
          const l = lines(a.prompt);
          expect(at(l, ARCHITECTURE_VERIFY)).toBeGreaterThan(-1);
          for (const x of ARCHITECTURE_VERIFY) expect(l.filter((y) => y === x)).toHaveLength(1);
          for (const x of ARCHITECTURE_LINES) expect(l).not.toContain(x);
        }
        for (const a of verifiers(p, c)) for (const x of ARCHITECTURE_VERIFY) expect(lines(a.prompt)).not.toContain(x);
        for (const a of verifiers(withV(p, "architecture"), c)) {
          const l = lines(a.prompt);
          expect(at(l, ARCHITECTURE_VERIFY)).toBe(at(l, PREEXISTING_VERIFY) + PREEXISTING_VERIFY.length);
        }
      }
  });

  test("AC-R71: the salvage prompt stays the same; the prompt version names the variant", () => {
    for (const p of SHIPPED_PROFILES) {
      expect(architecture(withV(p, "architecture"))).toBe(true);
      expect(salvageAgent(withV(p, "architecture")).prompt).toBe(salvageAgent(p).prompt);
    }
    expect(promptVersion(withV(general, "architecture"))).toBe(`${REVIEW_PROMPT_VERSION}+architecture`);
    expect(promptVersion(withV(general, "callers", "architecture"))).toBe(`${REVIEW_PROMPT_VERSION}+architecture+callers`);
  });

  test("AC-R72: each sentence of the lines has at most 20 words, with no CRITICAL, MUST, or IMPORTANT", () => {
    const long = ALL.flatMap((l) => l.split(/(?<=[.!?])\s+/)).filter((s) => s.split(/\s+/).filter(Boolean).length > 20);
    expect(long).toEqual([]);
    expect(ALL.join("\n")).not.toMatch(/\b(CRITICAL|MUST|IMPORTANT)\b/);
    // The last finder line and the last verify line quote a do-not-flag item. It must match that item.
    expect(DO_NOT_FLAG).toContain("a choice between two correct designs");
  });
});
