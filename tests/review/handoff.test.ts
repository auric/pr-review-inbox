// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
// docs/plans/review-v2/delegation-gaps.md section 3, fixes 1, 3, and 4: the opt-in variant "handoff". Pure parts only. The in-run
// check is in delegate.test.ts.
import { createHash } from "node:crypto";
import { evalProfile, finderChange, type Options, parseOptions } from "../../scripts/eval/run";
import {
  contextBlock,
  gitToolLines,
  HANDOFF_DELEGATE,
  HANDOFF_REVIEWER,
  handoff,
  ISSUE_FILES_LINE,
  ISSUE_LINES,
  type McpUse,
  mainAgent,
  mcpLines,
  NO_CONTEXT,
  promptVersion,
  type ReviewContext,
  reviewerAgent,
  SHIPPED_PROFILES,
  withDelegation,
} from "../../src/server/review/catalog";
import { REVIEW_PROMPT_VERSION } from "../../src/shared/review";

console.log(`handoff.test.ts imported from ${Bun.resolveSync("../../src/server/review/catalog", import.meta.dir)}`);

type Shipped = (typeof SHIPPED_PROFILES)[number];
const general = SHIPPED_PROFILES[0] as Shipped;
const withV = (p: Shipped) => ({ ...p, variants: [...p.variants, "handoff" as const] });
const lines = (prompt: string) => prompt.split("\n");
const TRIGGER = "In trigger, give a concrete case: the input or state, the path through the code, and the wrong result.";
const SEARCH = "When you cannot name a trigger, search the code for one. When you still cannot name one, write a question for the author.";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const FULL: ReviewContext = {
  taskFile: true,
  attachments: true,
  history: true,
  questions: true,
  rereview: false,
  instructions: true,
  goal: true,
  prContext: true,
  notes: true,
  plan: false,
};
const USED: McpUse[] = [
  { server: "jira", tools: ["get_issue"], remote: true },
  { server: "local", tools: ["read"], remote: false },
];

describe("variant handoff (delegation-gaps.md fixes 1, 3, and 4)", () => {
  test("the default delegation lines and MCP lines keep their bytes (hashes taken at ca795d1, before the variant)", () => {
    const pins = {
      auto: sha(withDelegation(mainAgent(general, FULL), "auto").prompt),
      always: sha(withDelegation(mainAgent(general, FULL), "always").prompt),
      parts: sha(withDelegation(mainAgent(general, FULL), "auto", 3).prompt),
      reviewer: sha(
        [reviewerAgent(general, FULL), reviewerAgent(general, { ...FULL, rereview: true }, true)].map((a) => a.prompt).join("\n---\n"),
      ),
      mcp: sha([...mcpLines(USED, true), "---", ...mcpLines(USED, false)].join("\n")),
    };
    expect(pins).toEqual({
      auto: "d8f1bacef6d6ef339404cb70eeba63a182789f3944ab4fd38e64f61953484f63",
      always: "ada3a400ef022f50b981b7008e4149b63b52ec987b027f108356809bcffa52b3",
      parts: "170eeec0e47f2b75632eccd5c77239173ad70bf0d431a3a60e73100ca35cc30c",
      reviewer: "7b8c0aa5ef2b7aa9c32b9d0cd08d5db699a9a79b7ec94443f1d54bac3d29d8de",
      mcp: "1033bf4c74a3fc65962a001d2b4f99eb420489d45db0ac1993176e4afb200679",
    });
    for (const p of SHIPPED_PROFILES) expect(handoff(p)).toBe(false);
  });

  test("rl-main keeps its prompt; rl-reviewer gets exactly the trigger search, the rl-git lines, and HANDOFF_REVIEWER", () => {
    for (const p of SHIPPED_PROFILES.filter((x) => !x.explain))
      for (const c of [NO_CONTEXT, FULL, { ...FULL, rereview: true }])
        for (const parts of [false, true]) {
          const on = withV(p);
          expect(mainAgent(on, c).prompt).toBe(mainAgent(p, c).prompt);
          const base = lines(reviewerAgent(p, c, parts).prompt);
          const got = lines(reviewerAgent(on, c, parts).prompt);
          const git = gitToolLines(c.rereview);
          // The rl-git lines follow the context block.
          const k = got.indexOf(git[0] as string);
          expect(got.slice(k - contextBlock(c).length, k)).toEqual(contextBlock(c));
          expect(got.slice(k, k + 2)).toEqual(git);
          // The trigger search follows the trigger line, as in rl-main.
          expect(got[got.indexOf(TRIGGER) + 1]).toBe(SEARCH);
          expect(got.slice(-HANDOFF_REVIEWER.length)).toEqual(HANDOFF_REVIEWER);
          const added = [...git, SEARCH, ...HANDOFF_REVIEWER];
          for (const x of added) expect(got.filter((y) => y === x)).toHaveLength(1);
          expect(got.filter((x) => !added.includes(x))).toEqual(base);
          expect(got).toHaveLength(base.length + added.length);
        }
  });

  test("the delegation lines get HANDOFF_DELEGATE last in modes auto, always, and parts", () => {
    const main = mainAgent(general, FULL);
    for (const [mode, parts] of [
      ["auto", 0],
      ["always", 0],
      ["auto", 3],
    ] as const)
      expect(withDelegation(main, mode, parts, true).prompt).toBe(
        [withDelegation(main, mode, parts).prompt, ...HANDOFF_DELEGATE].join("\n"),
      );
    expect(withDelegation(main, null, 0, true)).toBe(main);
  });

  test("the issue lines of rl-reviewer name the context files, not the Metadata section", () => {
    const on = mcpLines(USED, "files");
    const off = mcpLines(USED, true);
    const i = off.indexOf(ISSUE_LINES[1] as string);
    expect(i).toBeGreaterThan(-1);
    expect(on).toEqual(off.map((l, j) => (j === i ? ISSUE_FILES_LINE : l)));
    expect(on.join("\n")).not.toContain("Metadata");
  });

  // The stdin bytes, the rl-git lines included, stay pinned by the run kind hashes in prompt.test.ts.
  test("the prompt version gets +handoff", () => {
    expect(promptVersion(withV(general))).toBe(`${REVIEW_PROMPT_VERSION}+handoff`);
    expect(promptVersion(withV({ ...general, variants: ["parts"] }))).toBe(`${REVIEW_PROMPT_VERSION}+handoff+parts`);
  });

  test("ASD-STE100: every new line has at most 20 words in a sentence", () => {
    const all = [...HANDOFF_REVIEWER, ...HANDOFF_DELEGATE, ISSUE_FILES_LINE];
    const long = all.flatMap((l) => l.split(/(?<=[.!?])\s+/)).filter((s) => s.split(/\s+/).length > 20);
    expect(long).toEqual([]);
  });

  test("the eval run accepts --variants handoff, and counts it as a finder change", () => {
    const p = evalProfile(parseOptions(["--variants", "handoff"]) as Options);
    if ("error" in p) throw new Error(p.error);
    expect(p.profile.variants).toEqual(["handoff"]);
    expect(finderChange(general, p.profile)).toContain("variants");
  });
});
