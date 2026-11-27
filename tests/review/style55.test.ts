// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/research/opus55-prompting.md sections 7 and 8.1: the opt-in variant "style55" (B1, B2, and the rule reasons).
// The hashes in prompt.test.ts and passes.test.ts pin the default bytes. Pure parts only.
import { describe, expect, test } from "bun:test";
import {
  explainAgent,
  mainAgent,
  NO_CONTEXT,
  PREEXISTING_LINES,
  promptVersion,
  REASONS_55,
  type ReviewContext,
  reviewerAgent,
  SHIPPED_PROFILES,
  STACK_PREEXISTING,
  salvageAgent,
  style55,
  VERIFY_NIT_55,
  verifierAgent,
  verifyAgent,
} from "../../src/server/review/catalog";
import { profileInput, type Variant } from "../../src/shared/dto";
import { REVIEW_PROMPT_VERSION } from "../../src/shared/review";

console.log(`style55.test.ts imported from ${Bun.resolveSync("../../src/server/review/catalog", import.meta.dir)}`);

type Shipped = (typeof SHIPPED_PROFILES)[number];
const general = SHIPPED_PROFILES[0] as Shipped;
const withV = (p: Shipped, ...v: Variant[]) => ({ ...p, variants: [...p.variants, ...v] });
const SUBMODULES: ReviewContext = { ...NO_CONTEXT, submodules: true };
const PARENT: ReviewContext = { ...NO_CONTEXT, stack: { parent: true, parentBase: true, children: true } };
const FULL: ReviewContext = { ...NO_CONTEXT, taskFile: true, history: true, questions: true, goal: true, prContext: true };
const CONTEXTS = [NO_CONTEXT, SUBMODULES, PARENT, FULL];
const reviewProfiles = SHIPPED_PROFILES.filter((x) => !x.explain);
const lines = (prompt: string) => prompt.split("\n");
const finders = (p: Shipped, c: ReviewContext) => [mainAgent(p, c), reviewerAgent(p, c, false), reviewerAgent(p, c, true), salvageAgent(p)];
const verifiers = (p: Shipped, c: ReviewContext) => [
  verifyAgent(p, c),
  verifyAgent(p, c, true, true, true),
  verifierAgent(p, c, true, true),
];
const ONLY = "Report only problems that the change adds or makes reachable. BASE..HEAD is the change.";
const ANCHOR = Object.keys(REASONS_55)[0] as string;
const GIVE_NO_NITS = "nit: optional polish. Give no nits.";
const reasoned = Object.entries(REASONS_55).map(([k, r]) => `${k} ${r}`);
// The style55 line back to its default form.
const unstyle = (l: string) => {
  const k = Object.keys(REASONS_55).find((x) => l === `${x} ${REASONS_55[x]}`);
  return k ?? (l === VERIFY_NIT_55 ? GIVE_NO_NITS : l);
};
const count = (l: string[], x: string) => l.filter((y) => y === x).length;

describe("variant style55 (opus55-prompting.md section 8.1)", () => {
  test("without the variant, no prompt holds a style55 line, and the pre-existing block follows the anchor line", () => {
    for (const p of SHIPPED_PROFILES) {
      expect(style55(p)).toBe(false);
      for (const c of CONTEXTS) {
        for (const a of [...finders(p, c), ...verifiers(p, c), explainAgent(p)]) {
          const l = lines(a.prompt);
          expect(l).not.toContain(VERIFY_NIT_55);
          for (const x of reasoned) expect(l).not.toContain(x);
        }
        if (p.explain) continue;
        for (const a of finders(p, c)) {
          const l = lines(a.prompt);
          expect(l.indexOf(PREEXISTING_LINES[0] as string)).toBeGreaterThan(l.indexOf(ANCHOR));
        }
      }
    }
  });

  test("each reason key is a line of a default finder or verify prompt; a reason is one short sentence", () => {
    const seen = new Set(CONTEXTS.flatMap((c) => [...finders(general, c), ...verifiers(general, c)].flatMap((a) => lines(a.prompt))));
    for (const k of Object.keys(REASONS_55)) expect([k, seen.has(k)]).toEqual([k, true]);
    for (const r of [...Object.values(REASONS_55), VERIFY_NIT_55.replace("nit: optional polish. ", "")]) {
      expect(r.split(/(?<=[.!?])\s+/)).toHaveLength(1);
      expect(r.split(/\s+/).length).toBeLessThanOrEqual(20);
      expect(r).not.toMatch(/\b(CRITICAL|MUST|IMPORTANT|NEVER|ALWAYS)\b/);
    }
  });

  test("B2: the pre-existing block follows the rule that it makes an exception to, in every finder and context", () => {
    for (const p of reviewProfiles)
      for (const c of CONTEXTS)
        for (const [i, a] of finders(withV(p, "style55"), c).entries()) {
          const l = lines(a.prompt);
          const k = l.indexOf(ONLY);
          expect(k).toBeGreaterThan(-1);
          // Salvage (index 3) gets no context files, so it has no stack lines.
          const block = [...PREEXISTING_LINES, ...(c.stack?.parent && i < 3 ? STACK_PREEXISTING : [])];
          expect(l.slice(k + 1, k + 1 + block.length)).toEqual(block);
          expect(l[k + 1 + block.length]).toBe(`${ANCHOR} ${REASONS_55[ANCHOR]}`);
          for (const x of block) expect(count(l, x)).toBe(1);
        }
  });

  test("B1: only the verify agents get the verify nit line, once; the finders keep Give no nits", () => {
    for (const p of reviewProfiles)
      for (const c of CONTEXTS) {
        const s = withV(p, "style55");
        for (const a of verifiers(s, c)) {
          const l = lines(a.prompt);
          expect(count(l, VERIFY_NIT_55)).toBe(1);
          expect(l.filter((x) => x.includes("Give no nits"))).toEqual([]);
        }
        for (const a of verifiers(p, c)) expect(count(lines(a.prompt), GIVE_NO_NITS)).toBe(1);
        for (const a of finders(s, c)) {
          const l = lines(a.prompt);
          expect(count(l, GIVE_NO_NITS)).toBe(1);
          expect(l).not.toContain(VERIFY_NIT_55);
        }
      }
    // The thorough volume gets the same verify line: the volume nit rule is a finder rule.
    const thorough = { ...withV(general, "style55"), volume: "thorough" as const };
    const l = lines(verifyAgent(thorough, NO_CONTEXT).prompt);
    expect(count(l, VERIFY_NIT_55)).toBe(1);
    expect(l.filter((x) => x.startsWith("nit: "))).toEqual([VERIFY_NIT_55]);
  });

  test("reasons: each reasoned line appears once in each agent that has its rule, and the bare rule is gone", () => {
    for (const p of reviewProfiles)
      for (const c of CONTEXTS) {
        const s = withV(p, "style55");
        const pairs = [...finders(p, c), ...verifiers(p, c)].map((a, i) => [a, [...finders(s, c), ...verifiers(s, c)][i]] as const);
        for (const [base, styled] of pairs) {
          const b = lines(base.prompt);
          const l = lines(styled?.prompt ?? "");
          for (const [k, r] of Object.entries(REASONS_55)) {
            expect(count(l, `${k} ${r}`)).toBe(count(b, k) > 0 ? 1 : 0);
            expect(l).not.toContain(k);
          }
          // Only the three changes: the same lines in another order, with the reasons and the nit line put back.
          expect(l.map(unstyle).sort()).toEqual([...b].sort());
        }
      }
  });

  test("style55 leaves Explain alone; the version and the parse name the variant", () => {
    const explain = SHIPPED_PROFILES.find((x) => x.explain) as Shipped;
    expect(mainAgent(withV(explain, "style55")).prompt).toBe(mainAgent(explain).prompt);
    expect(style55(withV(general, "style55"))).toBe(true);
    expect(promptVersion(withV(general, "style55"))).toBe(`${REVIEW_PROMPT_VERSION}+style55`);
    expect(promptVersion(withV(general, "style55"))).toBe("2.9+style55");
    expect(profileInput.parse(withV(general, "style55")).variants).toEqual(["style55"]);
  });
});
