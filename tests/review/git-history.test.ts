// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/git-history.md WP-GH1 (AC-GH1 to AC-GH4): the opt-in finder variant "git-history". AC-GH5 is in
// git-mcp.test.ts. The hashes in prompt.test.ts also pin AC-GH1. Pure parts only.
import { describe, expect, test } from "bun:test";
import {
  ARCHITECTURE_LINES,
  explainAgent,
  gitHistory,
  gitToolLines,
  HISTORY_LINES,
  LENS_LINES,
  type Lens,
  mainAgent,
  NO_CONTEXT,
  promptVersion,
  type ReviewContext,
  reviewerAgent,
  SHIPPED_PROFILES,
  salvageAgent,
  verifierAgent,
  verifyAgent,
} from "../../src/server/review/catalog";
import { profileInput, type Variant } from "../../src/shared/dto";
import { REVIEW_PROMPT_VERSION } from "../../src/shared/review";

console.log(`git-history.test.ts imported from ${Bun.resolveSync("../../src/server/review/catalog", import.meta.dir)}`);

type Shipped = (typeof SHIPPED_PROFILES)[number];
const general = SHIPPED_PROFILES[0] as Shipped;
const withV = (p: Shipped, ...v: Variant[]) => ({ ...p, variants: [...p.variants, ...v] });
const GOAL: ReviewContext = { ...NO_CONTEXT, taskFile: true, goal: true, prContext: true };
const REREVIEW: ReviewContext = { ...NO_CONTEXT, rereview: true };
const CONTEXTS = [NO_CONTEXT, GOAL, REREVIEW];
const lines = (prompt: string) => prompt.split("\n");
const finders = (p: Shipped, c: ReviewContext, lens: Lens | null = null) => [
  mainAgent(p, c, lens),
  reviewerAgent(p, c, false, lens),
  reviewerAgent(p, c, true, lens),
];
const others = (p: Shipped, c: ReviewContext) => [
  explainAgent(p),
  verifyAgent(p, c),
  verifyAgent(p, c, true, [], true, true),
  verifierAgent(p, c, true, [], true),
  salvageAgent(p),
];
const reviewProfiles = SHIPPED_PROFILES.filter((x) => !x.explain);
// Index of the first line of block in l, or -1. The block must be contiguous.
const at = (l: string[], block: readonly string[]) => l.findIndex((_, i) => block.every((x, j) => l[i + j] === x));
const once = (l: string[]) => {
  const k = at(l, HISTORY_LINES);
  expect(k).toBeGreaterThan(-1);
  for (const x of HISTORY_LINES) expect(l.filter((y) => y === x)).toHaveLength(1);
  return k;
};

describe("variant git-history (git-history.md WP-GH1)", () => {
  test("AC-GH1: without the variant, no agent prompt holds a line of HISTORY_LINES", () => {
    for (const p of SHIPPED_PROFILES) {
      expect(gitHistory(p)).toBe(false);
      for (const c of CONTEXTS)
        for (const a of [...finders(p, c), ...others(p, c)]) for (const x of HISTORY_LINES) expect(lines(a.prompt)).not.toContain(x);
    }
  });

  test("AC-GH2: rl-main and rl-reviewer hold the block once, in one piece, after ARCHITECTURE_LINES and before the lens lines", () => {
    for (const p of reviewProfiles)
      for (const c of CONTEXTS) {
        const base = finders(p, c);
        const gh = finders(withV(p, "git-history"), c);
        const stacked = finders(withV(p, "callers", "architecture", "git-history"), c);
        for (let i = 0; i < base.length; i++) {
          const a = lines(gh[i]?.prompt ?? "");
          const k = once(a);
          // Only the block differs from the default prompt.
          expect([...a.slice(0, k), ...a.slice(k + HISTORY_LINES.length)]).toEqual(lines(base[i]?.prompt ?? ""));
          const s = lines(stacked[i]?.prompt ?? "");
          expect(once(s)).toBe(at(s, ARCHITECTURE_LINES) + ARCHITECTURE_LINES.length);
        }
        for (const lens of ["failure", "contract", "system"] as const)
          for (const a of finders(withV(p, "lenses3", "git-history"), c, lens)) {
            const l = lines(a.prompt);
            expect(at(l, LENS_LINES[lens])).toBe(once(l) + HISTORY_LINES.length);
          }
      }
  });

  test("AC-GH2: with handoff, rl-reviewer holds the rl-git tool lines and the block once each", () => {
    for (const p of reviewProfiles)
      for (const c of CONTEXTS)
        for (const parts of [false, true]) {
          const l = lines(reviewerAgent(withV(p, "handoff", "git-history"), c, parts).prompt);
          const g = at(l, gitToolLines(c.rereview));
          expect(g).toBeGreaterThan(-1);
          for (const x of gitToolLines(c.rereview)) expect(l.filter((y) => y === x)).toHaveLength(1);
          expect(once(l)).toBeGreaterThan(g);
        }
  });

  test("AC-GH3: Explain, the verify agents, the verifier, and salvage do not change", () => {
    for (const p of SHIPPED_PROFILES)
      for (const c of CONTEXTS) {
        const base = others(p, c).map((a) => a.prompt);
        expect(others(withV(p, "git-history"), c).map((a) => a.prompt)).toEqual(base);
      }
    // The Explain profile runs explainAgent as rl-main, which gets no finder lines.
    const explain = SHIPPED_PROFILES.find((p) => p.explain) as Shipped;
    expect(mainAgent(withV(explain, "git-history")).prompt).toBe(mainAgent(explain).prompt);
  });

  test("AC-GH4: the prompt version names the variant; profileInput keeps the name", () => {
    expect(gitHistory(withV(general, "git-history"))).toBe(true);
    expect(promptVersion(withV(general, "git-history"))).toBe(`${REVIEW_PROMPT_VERSION}+git-history`);
    expect(profileInput.parse(withV(general, "git-history")).variants).toEqual(["git-history"]);
  });

  test("each sentence of the lines has at most 20 words, with no CRITICAL, MUST, or IMPORTANT", () => {
    const long = HISTORY_LINES.flatMap((l) => l.split(/(?<=[.!?])\s+/)).filter((s) => s.split(/\s+/).filter(Boolean).length > 20);
    expect(long).toEqual([]);
    expect(HISTORY_LINES.join("\n")).not.toMatch(/\b(CRITICAL|MUST|IMPORTANT)\b/);
  });
});
