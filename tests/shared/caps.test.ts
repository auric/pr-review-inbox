// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/limits.md decision 4: an AI result over a schema cap is cut, not failed. Exact caps still fail.
import { describe, expect, test } from "bun:test";
import type { RunOutcome } from "../../src/server/review/claude";
import { judgeAsk, judgeDiscuss, judgeTask } from "../../src/server/review/judge";
import { aiJsonSchema, cutText, parseCut } from "../../src/shared/caps";
import { consultCaps, consultJsonSchema, consultOutput } from "../../src/shared/consult";
import {
  askJsonSchema,
  discussJsonSchema,
  explainJsonSchema,
  explainResult,
  fixJsonSchema,
  fixResult,
  replyJsonSchema,
  replyResult,
  rereviewJsonSchema,
  reviewJsonSchema,
  reviewResult,
  verifyJsonSchema,
  verifyResult,
} from "../../src/shared/review";
import {
  implementJsonSchema,
  implementResult,
  interviewJsonSchema,
  interviewResult,
  specJsonSchema,
  specResult,
} from "../../src/shared/task";
import { echoSpec } from "../support/fake-claude";

console.log(`caps.test.ts imported from ${Bun.resolveSync("../../src/shared/caps", import.meta.dir)}`);

const NONE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
const outcome = (structured: unknown): RunOutcome => ({
  status: "completed",
  kind: null,
  text: null,
  result: {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: structured,
    num_turns: 2,
    duration_ms: 1000,
    total_cost_usd: 0.5,
    usage: { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
    modelUsage: {},
    session_id: "s",
  },
  init: null,
  events: [],
  exitCode: 0,
  stderrTail: "",
});

// The paths of a JSON schema that keep maxItems, maxLength, or a maximum below the safe integer.
function capped(j: unknown, path = ""): string[] {
  if (typeof j !== "object" || j === null) return [];
  const o = j as Record<string, unknown>;
  const own =
    o.maxItems !== undefined || o.maxLength !== undefined || (typeof o.maximum === "number" && o.maximum < Number.MAX_SAFE_INTEGER)
      ? [path]
      : [];
  const props = Object.entries((o.properties ?? {}) as Record<string, unknown>).flatMap(([k, v]) => capped(v, path ? `${path}.${k}` : k));
  const anyOf = ((o.anyOf ?? []) as unknown[]).flatMap((v) => capped(v, path));
  return [...own, ...props, ...capped(o.items, `${path}[]`), ...anyOf];
}

describe("the CLI schema keeps only the exact caps", () => {
  const exact: [string, Record<string, unknown>, string[]][] = [
    ["review", reviewJsonSchema(), ["findings[].rule", "findings[].module"]],
    ["re-review", rereviewJsonSchema(), ["findings[].rule", "findings[].module"]],
    ["verify", verifyJsonSchema(), []],
    ["discuss", discussJsonSchema(), []],
    ["explain", explainJsonSchema(), []],
    ["reply", replyJsonSchema(), []],
    ["fix", fixJsonSchema(), ["edits[].old", "edits[].new"]],
    ["ask", askJsonSchema(), []],
    ["session", consultJsonSchema("fix"), ["fix.edits[].old", "fix.edits[].new"]],
    ["interview", interviewJsonSchema(), []],
    [
      "spec",
      specJsonSchema(),
      [
        "map[].path",
        "map[].symbol",
        "parts[].tests[].test",
        "parts[].tasks[].run[]",
        "parts[].after",
        "testing.commands[].name",
        "testing.commands[].argv",
        "testing.commands[].argv[]",
        "testing.allow[].pattern",
        "flag.name",
        "repos[].project",
        "repos[].repo",
        "contracts[].path",
      ],
    ],
    ["implement", implementJsonSchema(), ["allowRequest[].pattern", "allowRequest[].command"]],
  ];
  for (const [name, schema, want] of exact)
    test(name, () => {
      expect(capped(schema)).toEqual(want);
    });

  test("a cut cap goes into the description", () => {
    const j = explainJsonSchema() as { properties: Record<string, { description?: string; items?: unknown }> };
    expect(j.properties.files?.description).toBe("At most 300 entries.");
    expect(j.properties.walkthrough?.description).toBe(
      "The walkthrough as Markdown. Links into the change use diff: links. At most 60000 characters.",
    );
    expect(JSON.stringify(aiJsonSchema(explainResult))).toBe(JSON.stringify(explainJsonSchema()));
  });
});

describe("cutText", () => {
  test("ends at a line break or a space in the second half, with the mark", () => {
    expect(cutText(`${"a".repeat(30)}\n${"b".repeat(40)}`, 50)).toBe(`${"a".repeat(30)} [cut]`);
    expect(cutText(`${"word ".repeat(20)}`, 50)).toBe(`${"word ".repeat(9).trimEnd()} [cut]`);
    expect(cutText("x".repeat(100), 50)).toBe(`${"x".repeat(44)} [cut]`);
  });

  test("never splits a surrogate pair", () => {
    const out = cutText(`${"a".repeat(43)}\u{1F600}${"b".repeat(20)}`, 50);
    expect(out).toBe(`${"a".repeat(43)} [cut]`);
  });
});

describe("over-cap results complete with the cut and a note", () => {
  const finding = (i: number) => ({
    path: "src/a.ts",
    side: "new",
    line: i + 1,
    lineEnd: null,
    anchorText: "x",
    severity: "minor",
    category: "Correctness",
    body: `Body ${i}.`,
    evidence: "src/a.ts:1",
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
    title: i === 0 ? "t".repeat(300) : `Title ${i}`,
  });
  const review = (o: Record<string, unknown> = {}) => ({
    summary: "S.",
    risks: [],
    questions: [],
    coverage: NONE,
    findings: times(140, finding),
    ...o,
  });

  test("review: 140 findings keep the first 100 in finder order; a long title is cut", () => {
    const r = parseCut(reviewResult, review());
    expect(r.success).toBe(true);
    expect(r.data?.findings.map((f) => f.line)).toEqual(times(100, (i) => i + 1));
    expect(r.data?.findings[0]?.title).toHaveLength(200);
    expect(r.data?.findings[0]?.title).toEndWith(" [cut]");
    expect(r.cuts).toEqual([
      "Claude returned 140 findings; the app kept the first 100.",
      "The app cut findings[].title from 300 to 200 characters.",
    ]);
  });

  test("review control: an exact cap still fails the parse", () => {
    const r = parseCut(reviewResult, review({ findings: [{ ...finding(1), rule: "r".repeat(2001) }] }));
    expect(r.success).toBe(false);
  });

  test("verify: 101 verdicts keep 100", () => {
    const v = (i: number) => ({ candidate: i + 1, verdict: "confirmed", severity: "minor", reason: "r".repeat(1200), evidence: "e" });
    const r = parseCut(verifyResult, { verdicts: times(101, v), coverage: NONE });
    expect(r.success).toBe(true);
    expect(r.cuts).toEqual([
      "Claude returned 101 verdicts; the app kept the first 100.",
      "The app cut 100 texts in verdicts[].reason to 1,000 characters.",
    ]);
  });

  test("explain: each list and the walkthrough", () => {
    const line = `${"w".repeat(99)}\n`;
    const r = parseCut(explainResult, {
      summary: "S.",
      walkthrough: line.repeat(610),
      order: times(61, (i) => ({ path: `f${i}`, why: "W." })),
      files: times(301, (i) => ({ path: `f${i}`, role: "core", summary: "F." })),
      risks: times(31, () => ({ text: "R.", path: null, side: "new", line: null, lineEnd: null, anchorText: "" })),
      glossary: times(41, () => ({ term: "t", meaning: "m" })),
      questions: times(21, () => ({ text: "Q?", why: "W." })),
      coverage: NONE,
    });
    expect(r.success).toBe(true);
    expect(r.data?.walkthrough).toBe(`${line.repeat(598)}${"w".repeat(99)} [cut]`);
    expect(r.cuts).toEqual([
      "The app cut walkthrough from 61,000 to 60,000 characters.",
      "Claude returned 61 order; the app kept the first 60.",
      "Claude returned 301 files; the app kept the first 300.",
      "Claude returned 31 risks; the app kept the first 30.",
      "Claude returned 41 glossary; the app kept the first 40.",
      "Claude returned 21 questions; the app kept the first 20.",
    ]);
  });

  test("discuss: the answer, the notes, and the cites; the note goes to coverage.skipped", () => {
    const e = judgeDiscuss(
      outcome({
        answer: "a".repeat(9000),
        verdict: "upheld",
        reason: "R.",
        revision: null,
        reply: "",
        coverage: NONE,
        notes: times(3, () => ({ text: "N.", thread: 1, pr: null })),
        cites: [1, 2, 3, 4, 5, 6],
      }),
      [],
      [],
    );
    expect(e.status).toBe("incomplete");
    expect(e.result?.answer).toHaveLength(8000);
    expect(e.result?.summary.coverage.skipped).toEqual([
      "The app cut answer from 9,000 to 8,000 characters.",
      "Claude returned 3 notes; the app kept the first 2.",
      "Claude returned 6 cites; the app kept the first 5.",
    ]);
  });

  test("reply: 26 replies keep 25", () => {
    const d = (i: number) => ({ thread: i + 1, action: "none", body: "", reason: "R.", evidenceStatus: "code", judgement: null });
    const r = parseCut(replyResult, { summary: "S.", replies: times(26, d), coverage: NONE });
    expect(r.success).toBe(true);
    expect(r.cuts).toEqual(["Claude returned 26 replies; the app kept the first 25."]);
  });

  test("fix: 51 edits keep 50; control: an edit text over its cap still fails", () => {
    const edit = (i: number, old = `old ${i}`) => ({ thread: 1, path: "src/a.ts", old, new: "new" });
    const fix = (edits: unknown[]) => ({ summary: "S.", threads: [], edits, coverage: NONE });
    const r = parseCut(fixResult, fix(times(51, (i) => edit(i))));
    expect(r.success).toBe(true);
    expect(r.data?.edits).toHaveLength(50);
    expect(r.cuts).toEqual(["Claude returned 51 edits; the app kept the first 50."]);
    expect(parseCut(fixResult, fix([edit(0, "o".repeat(20_001))])).success).toBe(false);
  });

  test("ask: a long answer", () => {
    const e = judgeAsk(outcome({ answer: "a ".repeat(10_500), coverage: NONE }), [], []);
    expect(e.status).toBe("incomplete");
    expect(e.result?.answer?.length).toBeLessThanOrEqual(20_000);
    expect(e.result?.summary.coverage.skipped).toEqual(["The app cut answer from 21,000 to 20,000 characters."]);
  });

  test("session: 501 answers and a long reason", () => {
    const entry = (i: number) => ({ id: `T${i + 1}`, verdict: "accept", reason: i === 0 ? "r".repeat(4001) : "R." });
    const r = parseCut(consultOutput, { answers: times(501, entry) }, consultCaps);
    expect(r.success).toBe(true);
    expect(r.data?.answers).toHaveLength(500);
    expect((r.data?.answers[0] as { reason: string } | undefined)?.reason).toHaveLength(4000);
    expect(r.cuts).toEqual([
      "Claude returned 501 answers; the app kept the first 500.",
      "The app cut answers[].reason from 4,001 to 4,000 characters.",
    ]);
  });

  const task = (schema: Parameters<typeof judgeTask>[1], value: unknown) =>
    judgeTask(outcome(value), schema, "spec", [], [], async (r) => ({ result: r, skipped: [] }));

  test("interview: 9 questions keep 8", async () => {
    const q = (i: number) => ({ id: `q${i + 1}`, text: "Q?", why: "W.", kind: "text", options: [], recommended: null });
    const e = await task(interviewResult, { done: false, summary: "S.", questions: times(9, q), unknowns: [], coverage: NONE });
    expect(e.status).toBe("incomplete");
    expect(e.result?.summary.coverage.skipped).toEqual(["Claude returned 9 questions; the app kept the first 8."]);
  });

  test("spec: lists, texts, and numbers; control: an exact path still fails", async () => {
    const spec = echoSpec();
    const contract = { name: "n", path: "", change: "add", users: "u", compat: "c", part: null };
    const e = await task(specResult, {
      ...spec,
      title: "t".repeat(250),
      estimate: { ...spec.estimate, parts: 40 },
      questions: times(11, () => "Q?"),
      contracts: times(13, () => contract),
    });
    expect(e.status).toBe("incomplete");
    expect(e.result?.summary.coverage.skipped).toEqual([
      "The app cut title from 250 to 200 characters.",
      "The app lowered estimate.parts from 40 to 30.",
      "Claude returned 11 questions; the app kept the first 10.",
      "Claude returned 13 contracts; the app kept the first 12.",
    ]);
    const bad = await task(specResult, { ...spec, map: [{ ...spec.map[0], path: "p".repeat(401) }] });
    expect([bad.status, bad.kind]).toEqual(["failed", "schema"]);
  });

  test("implement: 21 notes keep 20", async () => {
    const e = await task(implementResult, { summary: "S.", done: true, notes: times(21, () => "N."), coverage: NONE });
    expect(e.result?.summary.coverage.skipped).toEqual(["Claude returned 21 notes; the app kept the first 20."]);
  });
});
