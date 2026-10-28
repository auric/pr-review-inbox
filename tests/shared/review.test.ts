// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review v2 contracts (docs/plans/review-v2/spec.md sections 1.5, 1.6, 2.4, 3.3). The CLI gets draft-07 with every key required.
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { MODULE_IDS, profileInput } from "../../src/shared/dto";
import {
  coverage,
  discussJsonSchema,
  discussResult,
  explainJsonSchema,
  explainResult,
  MAX_FINDINGS,
  question,
  REVIEW_PROMPT_VERSION,
  reviewJsonSchema,
  reviewResult,
  severities,
  verifyJsonSchema,
  verifyResult,
} from "../../src/shared/review";

type Node = { $schema?: string; type?: string; required?: string[]; properties?: Record<string, Node>; items?: Node; anyOf?: Node[] };
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };

// Each object level lists every one of its keys as required, so the CLI never leaves a key out.
function allRequired(n: Node, path = "$"): string[] {
  const own = n.properties
    ? Object.keys(n.properties)
        .filter((k) => !n.required?.includes(k))
        .map((k) => `${path}.${k}`)
    : [];
  const kids = [
    ...Object.entries(n.properties ?? {}).map(([k, v]) => allRequired(v, `${path}.${k}`)),
    ...(n.items ? [allRequired(n.items, `${path}[]`)] : []),
    ...(n.anyOf ?? []).map((v) => allRequired(v, path)),
  ];
  return [...own, ...kids.flat()];
}

// A finding as results stored before review v2 hold it.
const V1_FINDING = {
  path: "src/a.ts",
  side: "new",
  line: 3,
  lineEnd: null,
  anchorText: "x",
  severity: "major",
  category: "Correctness",
  body: "Body.",
  evidence: "src/a.ts:3",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
};
const V1_RESULT = { summary: "One line.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [V1_FINDING], answered: [] };

describe("finding v2 (AC-R14)", () => {
  test("the CLI schema of a review run is draft-07 and lists the new keys as required", () => {
    const s = reviewJsonSchema() as Node;
    expect(s.$schema).toBe(DRAFT_07);
    const items = s.properties?.findings?.items as Node;
    expect(items.required).toEqual(expect.arrayContaining(["title", "trigger", "cause", "rule", "module"]));
    expect(allRequired(s)).toEqual([]);
    // cause is null or a place with the anchor keys.
    const cause = items.properties?.cause as Node;
    expect(cause.anyOf?.map((n) => n.type)).toEqual(["object", "null"]);
    expect(cause.anyOf?.[0]?.required).toEqual(["path", "side", "line", "lineEnd", "anchorText"]);
    expect(allRequired(reviewJsonSchema(true) as Node)).toEqual([]);
  });

  test("an older stored result without the new keys parses with the defaults", () => {
    const parsed = reviewResult.parse(V1_RESULT);
    expect(parsed.findings[0]).toEqual({
      ...V1_FINDING,
      side: "new",
      title: "",
      trigger: "",
      cause: null,
      rule: "",
      module: "core",
    } as never);
  });

  test("a v2 finding keeps its keys; the limits hold", () => {
    const cause = { path: "src/a.ts", side: "new", line: 1, lineEnd: null, anchorText: "y" };
    const v2 = {
      ...V1_FINDING,
      title: "Race on fill",
      trigger: "Two lookups at once.",
      cause,
      rule: "Name each lock.",
      module: "concurrency",
    };
    expect(reviewResult.parse({ ...V1_RESULT, findings: [v2] }).findings[0]).toEqual(v2 as never);
    for (const bad of [{ title: "x".repeat(201) }, { trigger: "x".repeat(2001) }, { rule: "x".repeat(2001) }, { module: "x".repeat(41) }])
      expect(reviewResult.safeParse({ ...V1_RESULT, findings: [{ ...V1_FINDING, ...bad }] }).success).toBe(false);
    expect(reviewResult.safeParse({ ...V1_RESULT, findings: [{ ...V1_FINDING, cause: { path: "a" } }] }).success).toBe(false);
  });

  test("the review v2 prompts with the PR context rules ship as prompt version 2.2 (2.1: without them, 2.0: no verify phase)", () => {
    expect(REVIEW_PROMPT_VERSION).toBe("2.3");
  });
});

describe("verify, discuss, and explain schemas", () => {
  test("each CLI schema is draft-07 with every key required", () => {
    for (const s of [verifyJsonSchema(), discussJsonSchema(), explainJsonSchema()] as Node[]) {
      expect(s.$schema).toBe(DRAFT_07);
      expect(s.type).toBe("object");
      expect(allRequired(s)).toEqual([]);
    }
    const verdict = (verifyJsonSchema() as Node).properties?.verdicts?.items as Node;
    expect(verdict.properties?.verdict).toMatchObject({ enum: ["confirmed", "refuted", "unsure", "question", "duplicate"] });
    expect((discussJsonSchema() as Node).properties?.verdict).toMatchObject({ enum: ["upheld", "revised", "withdrawn"] });
  });

  test("verify: entries without duplicateOf and question parse with the defaults; the caps hold", () => {
    const v = {
      candidate: 3,
      verdict: "refuted",
      severity: "minor",
      reason: "The caller holds the lock (src/a.ts:9).",
      evidence: "src/a.ts:9",
    };
    expect(verifyResult.parse({ verdicts: [v], coverage: NO_COVERAGE }).verdicts).toEqual([
      { ...v, duplicateOf: null, question: "" },
    ] as never);
    for (const bad of [{ candidate: 0 }, { verdict: "maybe" }, { severity: "info" }, { reason: "x".repeat(1001) }, { duplicateOf: 0 }])
      expect(verifyResult.safeParse({ verdicts: [{ ...v, ...bad }], coverage: NO_COVERAGE }).success).toBe(false);
    const many = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => ({ ...v, candidate: i + 1 }));
    expect(verifyResult.safeParse({ verdicts: many, coverage: NO_COVERAGE }).success).toBe(false);
  });

  test("discuss: a result without revision and reply parses with the defaults; the caps hold", () => {
    const d = { answer: "The lock covers it.", verdict: "upheld", reason: "The code guards it.", coverage: NO_COVERAGE };
    // WP-PN: notes and cites (spec.md section 2.9) default to empty lists, so stored results and old CLI output parse.
    expect(discussResult.parse(d)).toEqual({ ...d, verdict: "upheld", revision: null, reply: "", notes: [], cites: [] });
    const revised = {
      ...d,
      verdict: "revised",
      revision: { severity: "minor", title: "T", body: "B" },
      reply: "Thanks.",
      notes: [],
      cites: [],
    };
    expect(discussResult.parse(revised)).toEqual(revised as never);
    for (const bad of [{ answer: "x".repeat(8001) }, { verdict: "kept" }, { reason: "x".repeat(501) }, { revision: { severity: "minor" } }])
      expect(discussResult.safeParse({ ...d, ...bad }).success).toBe(false);
  });

  test("explain: a result without glossary parses with an empty list; the caps hold", () => {
    const e = {
      summary: "Adds a cache.",
      walkthrough: "## Cache\n\nSee [fill](diff:src/a.ts#N3).",
      order: [{ path: "src/a.ts", why: "Entry point." }],
      files: [{ path: "src/a.ts", role: "core", summary: "The cache." }],
      risks: [{ text: "Two fills race.", path: "src/a.ts", side: "new", line: 3, lineEnd: null, anchorText: "x" }],
      questions: [{ text: "Why 60 s?", why: "The TTL is not explained." }],
      coverage: NO_COVERAGE,
    };
    expect(explainResult.parse(e)).toEqual({ ...e, glossary: [] } as never);
    for (const bad of [
      { summary: "x".repeat(301) },
      { walkthrough: "x".repeat(60_001) },
      { files: [{ path: "a", role: "main", summary: "" }] },
      { risks: [{ ...e.risks[0], line: 0 }] },
      { glossary: Array.from({ length: 41 }, () => ({ term: "t", meaning: "m" })) },
    ])
      expect(explainResult.safeParse({ ...e, ...bad }).success).toBe(false);
  });
});

// integration-check.md "Review v2": gates B18 and B20 ran on these copies of the spec.md schemas (scripts/gate/claude-checks.ts at
// commit 510d890). The shipped schemas add descriptions only. Any other change needs a new gate run.
const lineNo = z.number().int().min(1);
const B20 = {
  verify: z.object({
    verdicts: z
      .array(
        z.object({
          candidate: z.number().int().min(1),
          verdict: z.enum(["confirmed", "refuted", "unsure", "question", "duplicate"]),
          severity: z.enum(severities),
          reason: z.string().max(1000),
          evidence: z.string().max(1000),
          duplicateOf: z.number().int().min(1).nullable().default(null),
          question: z.string().max(1000).default(""),
        }),
      )
      .max(MAX_FINDINGS),
    coverage,
  }),
  explain: z.object({
    summary: z.string().max(300),
    walkthrough: z.string().max(60_000),
    order: z.array(z.object({ path: z.string(), why: z.string().max(300) })).max(60),
    files: z
      .array(
        z.object({
          path: z.string(),
          role: z.enum(["core", "supporting", "tests", "config", "generated", "docs"]),
          summary: z.string().max(600),
        }),
      )
      .max(300),
    risks: z
      .array(
        z.object({
          text: z.string().max(600),
          path: z.string().nullable(),
          side: z.enum(["new", "old"]),
          line: lineNo.nullable(),
          lineEnd: lineNo.nullable(),
          anchorText: z.string(),
        }),
      )
      .max(30),
    glossary: z
      .array(z.object({ term: z.string().max(80), meaning: z.string().max(300) }))
      .max(40)
      .default([]),
    questions: z.array(question).max(20),
    coverage,
  }),
  discuss: z.object({
    answer: z.string().max(8000),
    verdict: z.enum(["upheld", "revised", "withdrawn"]),
    reason: z.string().max(500),
    revision: z
      .object({ severity: z.enum(severities), title: z.string().max(200), body: z.string().max(4000) })
      .nullable()
      .default(null),
    reply: z.string().max(4000).default(""),
    coverage,
  }),
};
const shape = (s: Record<string, unknown>) => JSON.stringify(s, (k, v) => (k === "description" ? undefined : v));
const draft07 = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-07" }) as Record<string, unknown>;

// WP-PN (spec.md section 2.9) adds notes and cites to the discuss result. Gate B20 ran the shape without them. Run B20 again before
// WP-D2 ships the discuss run.
const PN_KEYS = {
  notes: z
    .array(z.object({ text: z.string().min(1).max(500), thread: lineNo, pr: z.number().int().positive().nullable().default(null) }))
    .max(2)
    .default([]),
  cites: z.array(lineNo).max(5).default([]),
};

test("the shipped verify, explain, and discuss schemas have the shape that gates B18 and B20 accepted", () => {
  expect(shape(verifyJsonSchema())).toBe(shape(draft07(B20.verify)));
  expect(shape(explainJsonSchema())).toBe(shape(draft07(B20.explain)));
  expect(shape(discussJsonSchema())).toBe(shape(draft07(B20.discuss.extend(PN_KEYS))));
});

describe("profile fields of review v2 (spec.md section 1.2)", () => {
  const base = { id: "mine", name: "Mine", note: "", prompt: "Find bugs.", explain: false, docs: false, maxTurns: 20 };

  test("a profile saved before them parses with modules [], volume balanced, and the verifier on", () => {
    expect(profileInput.parse(base)).toMatchObject({
      modules: [],
      volume: "balanced",
      verifier: { mode: "on", model: null, effort: null },
    });
  });

  test("an unknown module ID drops, a repeated one counts once; a bad volume or verifier fails", () => {
    expect(profileInput.parse({ ...base, modules: ["security", "future-check", 7, "security", "tests"] }).modules).toEqual([
      "security",
      "tests",
    ]);
    expect(MODULE_IDS).toEqual([
      "security",
      "concurrency",
      "performance",
      "tests",
      "api",
      "docs",
      "simplify",
      "rules",
      "intent",
      "failures",
    ]);
    for (const bad of [
      { volume: "loud" },
      { verifier: { mode: "maybe" } },
      { verifier: { effort: "ultra" } },
      { verifier: { model: "-x" } },
    ])
      expect(profileInput.safeParse({ ...base, ...bad }).success).toBe(false);
    expect(profileInput.parse({ ...base, verifier: { mode: "off" } }).verifier).toEqual({ mode: "off", model: null, effort: null });
  });
});
