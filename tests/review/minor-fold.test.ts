// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/minor-fold.md WP-MF1 (variant "minor-fold", AC-R60 to AC-R65): the anchor check, the settle drop and cap, the
// candidates file, the display group, the post path, and the task loop. Pure functions and an in-memory database. No process, no forge.
import { describe, expect, test } from "bun:test";
import { buildPlan } from "../../src/server/publish/plan";
import type { RunOutcome } from "../../src/server/review/claude";
import { type Candidate, candidatesFile } from "../../src/server/review/context-files";
import { triage } from "../../src/server/review/items";
import { type CheckRun, type Found, type SettleInput, settle } from "../../src/server/review/judge";
import type { NewItem } from "../../src/server/review/run-rows";
import { validate } from "../../src/server/review/validate";
import { openDb } from "../../src/server/storage/db";
import { mustFixPoint } from "../../src/server/tasks/tasks";
import type { ReviewItemDto } from "../../src/shared/dto";
import {
  type Anchor,
  displayGroup,
  type Finding,
  type FindingPayload,
  POLISH_MAX,
  reviewResult,
  type VerifyVerdict,
} from "../../src/shared/review";

console.log(`minor-fold.test.ts imported from ${Bun.resolveSync("../../src/server/review/validate", import.meta.dir)}`);

const NONE = { read: [], skipped: [], unavailable: [], notChecked: [] };

// Line 2 of src/a.ts changed. Lines 1, 3, and 4 are unchanged.
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,4 @@",
  " // Keep the first entry.",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  " const d = 5;",
  "",
].join("\n");
const NEW_FILES = new Map([["src/a.ts", "// Keep the first entry.\nconst b = 3;\nconst c = 4;\nconst d = 5;\n"]]);
const OLD_FILES = new Map([["src/a.ts", "// Keep the first entry.\nconst b = 2;\nconst c = 4;\nconst d = 5;\n"]]);
const ON_CHANGE = { path: "src/a.ts", side: "new" as const, line: 2, lineEnd: null, anchorText: "const b = 3;" };
const ON_COMMENT = { path: "src/a.ts", side: "new" as const, line: 1, lineEnd: null, anchorText: "// Keep the first entry." };

const F = (o: Partial<Finding> = {}): Finding => ({
  ...ON_CHANGE,
  severity: "nit",
  category: "todo",
  body: "Body.",
  evidence: "src/a.ts:2",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  title: "Title",
  trigger: "A reader expects a ticket.",
  cause: null,
  rule: "",
  module: "core",
  ...o,
});
const check = (findings: Finding[], polish: boolean, preexisting = false) =>
  validate({
    result: { summary: "", risks: [], questions: [], coverage: NONE, findings, answered: [] },
    diff: DIFF,
    newFiles: NEW_FILES,
    oldFiles: OLD_FILES,
    agents: [],
    polish,
    preexisting,
  });

describe("result schema", () => {
  test("a result without the key parses as before, and the mark survives the parse", () => {
    const result = { summary: "S.", risks: [], questions: [], coverage: NONE, answered: [] };
    expect(reviewResult.parse({ ...result, findings: [F()] }).findings[0]).not.toHaveProperty("polish");
    expect(reviewResult.parse({ ...result, findings: [F({ polish: true })] }).findings[0]?.polish).toBe(true);
    expect(reviewResult.safeParse({ ...result, findings: [F({ polish: "yes" as never })] }).success).toBe(false);
  });
});

describe("anchor check (validate.ts, AC-R60)", () => {
  test("variant on: a marked finding on a changed line keeps the mark; variant off or polish false drops the mark", () => {
    const on = check([F({ polish: true }), F({ polish: false }), F()], true);
    expect(on.findings.map((f) => f.polish ?? null)).toEqual([true, null, null]);
    expect(check([F({ polish: true })], false).findings.map((f) => "polish" in f)).toEqual([false]);
  });

  test("an unchanged stale comment stays only with a changed cause, as any finding", () => {
    const v = check([F({ ...ON_COMMENT, polish: true, category: "stale", cause: ON_CHANGE }), F({ ...ON_COMMENT, polish: true })], true);
    expect(v.findings.map((f) => [f.polish, f.cause?.anchor?.line])).toEqual([[true, 2]]);
    expect(v.dropped.map((d) => d.reason)).toEqual(["unchanged"]);
  });

  test("a finding keeps at most one mark: pre-existing wins", () => {
    const v = check([F({ ...ON_COMMENT, severity: "major", preexisting: true, polish: true })], true, true);
    expect(v.findings.map((f) => [f.preexisting, "polish" in f])).toEqual([[true, false]]);
  });
});

// ---------- settle (judge.ts) ----------

const anchor = (line: number): Anchor => ({
  state: "exact",
  path: "src/a.ts",
  oldPath: null,
  line,
  lineEnd: line,
  excerpt: [{ n: line, kind: "add", text: `line ${line}` }],
});
const payload = (n: number, o: Partial<FindingPayload> = {}): FindingPayload => ({
  ...F({ line: n, anchorText: `line ${n}`, title: `Title ${n}` }),
  anchor: anchor(n),
  polish: true,
  ...o,
});
const C = (n: number, o: Partial<FindingPayload> = {}, from: number | null = null): Candidate => ({
  n,
  group: null,
  from,
  finding: payload(n, o),
});
const V = (candidate: number, verdict: VerifyVerdict["verdict"], o: Partial<VerifyVerdict> = {}): VerifyVerdict => ({
  candidate,
  verdict,
  severity: "nit",
  reason: "R.",
  evidence: "E.",
  duplicateOf: null,
  question: verdict === "question" ? "Why?" : "",
  finding: null,
  ...o,
});
const outcome = (structured: unknown): RunOutcome => ({
  status: "completed",
  kind: null,
  text: null,
  result: {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: structured,
    num_turns: 1,
    duration_ms: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    session_id: "s",
  },
  init: null,
  events: [],
  exitCode: 0,
  stderrTail: "",
});
const found = (candidates: Candidate[]): Found => ({
  raw: "RAW",
  outcome: outcome({}),
  summary: { summary: "S.", risks: [], coverage: NONE, dropped: [] },
  candidates,
  questions: [],
  replies: [],
  gaps: [],
});
const checkRun = (verdicts: VerifyVerdict[]): CheckRun => ({
  o: outcome({ verdicts, coverage: NONE }),
  startedAt: 1,
  endedAt: 2,
  written: verdicts.length,
  asked: 0,
});
const input = (o: Partial<SettleInput> = {}): SettleInput => ({
  volume: "balanced",
  find: { name: "find", startedAt: 0, endedAt: 1, usage: null },
  check: null,
  verify: true,
  written: 0,
  servers: [],
  ...o,
});
const payloads = (items: NewItem[]) => items.filter((i) => i.kind === "finding").map((i) => JSON.parse(i.payload_json) as FindingPayload);
const end = (cands: Candidate[], verdicts: VerifyVerdict[], o: Partial<SettleInput> = {}) => {
  const e = settle(found(cands), input({ check: checkRun(verdicts), written: verdicts.length, ...o }));
  return {
    items: payloads(e.result?.items ?? []),
    all: e.result?.items ?? [],
    notChecked: e.result?.summary.coverage.notChecked ?? [],
    carried: e.result?.carried,
  };
};

describe("settle (judge.ts, AC-R61)", () => {
  test("at most POLISH_MAX shown, by check then confidence; a question drops; each kind of drop gives one coverage line", () => {
    expect(POLISH_MAX).toBe(3);
    const cands = [
      C(1, { confidence: "low" }),
      C(2, { confidence: "high" }),
      C(3, { confidence: "high" }),
      C(4, { confidence: "medium" }),
      C(5),
      C(6),
    ];
    const verdicts = [
      V(1, "confirmed"),
      V(2, "unsure"),
      V(3, "confirmed", { severity: "minor" }),
      V(4, "confirmed"),
      V(5, "question"),
      V(6, "refuted"),
    ];
    const r = end(cands, verdicts);
    const shown = r.items.filter((p) => p.discardedBy !== "verify");
    expect(shown.map((p) => p.title)).toEqual(["Title 3", "Title 4", "Title 1"]);
    // The refuted point hides as any finding, and the cap does not count it.
    expect(r.items.filter((p) => p.discardedBy === "verify").map((p) => p.title)).toEqual(["Title 6"]);
    expect(r.all.filter((i) => i.kind === "question")).toEqual([]);
    expect(r.notChecked).toEqual([
      "1 polish point was left out: the check asked a question, or no trigger was named.",
      "1 polish point was left out: a run shows at most 3.",
    ]);
  });

  test("with the verify phase off, a point without a trigger drops; one with a trigger shows unchecked in the fold", () => {
    const e = settle(found([C(1), C(2, { trigger: "" })]), input({ verify: false }));
    const items = payloads(e.result?.items ?? []);
    expect(items.map((p) => [p.title, displayGroup(p, "balanced")])).toEqual([["Title 1", "fold"]]);
    expect(e.result?.summary.coverage.notChecked).toEqual([
      "1 polish point was left out: the check asked a question, or no trigger was named.",
    ]);
  });

  test("carried polish points of a re-review are not capped and give no coverage line", () => {
    const cands = [1, 2, 3, 4, 5].map((n) => C(n, {}, 100 + n));
    const r = end(
      cands,
      cands.map((c) => V(c.n, "confirmed")),
    );
    expect(r.carried?.size).toBe(5);
    expect(r.notChecked).toEqual([]);
  });

  test("unmarked findings keep their path: the cap touches only marked findings", () => {
    const cands = [1, 2, 3, 4, 5].map((n) => C(n, { polish: undefined, severity: "major" }));
    const r = end(
      cands,
      cands.map((c) => V(c.n, "confirmed", { severity: "major" })),
    );
    expect(r.items).toHaveLength(5);
    expect(r.notChecked).toEqual([]);
  });
});

describe("display group (AC-R62)", () => {
  test("a polish point goes to fold at quiet and balanced, whatever its severity; main at thorough; refuted hides", () => {
    for (const severity of ["blocker", "major", "minor", "nit"] as const) {
      const p = payload(1, { severity, verify: { verdict: "confirmed" } as never });
      expect([displayGroup(p, "quiet"), displayGroup(p, "balanced"), displayGroup(p, "thorough")]).toEqual(["fold", "fold", "main"]);
      expect(displayGroup({ ...p, polish: undefined }, "balanced")).toBe(severity === "nit" ? "fold" : "main");
    }
    expect(displayGroup(payload(1, { discardedBy: "verify" }), "balanced")).toBe("hidden");
    expect(displayGroup(payload(1, { preexisting: true }), "balanced")).toBe("preexisting");
  });
});

describe("candidates file (context-files.ts, AC-R63)", () => {
  test("only a marked candidate gets the Polish line", () => {
    const text = candidatesFile([C(1), C(2, { polish: undefined }), C(3, { polish: false })]).file.text;
    expect(text.split("- Polish: yes.")).toHaveLength(2);
    expect(text.indexOf("- Polish: yes.")).toBeLessThan(text.indexOf("## Candidate 2"));
  });
});

describe("post path and task loop (AC-R64, AC-R65)", () => {
  test("Accept works on a polish point, and buildPlan posts it only after Accept", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'PROJ', 'repo', 1)");
    const { id: run } = db
      .query(
        `INSERT INTO review_run (pr, kind, profile, profile_name, prompt_version, note, idem_key, source_head, target_head, status, started_at)
        VALUES (1, 'review', 'general', 'General', '2.8+minor-fold', '', 'k', 'h', 't', 'completed', 1) RETURNING id`,
      )
      .get() as { id: number };
    const id = (
      db
        .query(
          `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status, revision, edited)
          VALUES ($run, 'finding', $payload, 'b', 'src/a.ts', 'new', 2, 2, 'new', 0, 0) RETURNING id`,
        )
        .get({ run, payload: JSON.stringify(payload(2)) }) as { id: number }
    ).id;
    expect(triage(db, id, { action: "accept", revision: 0 })).toMatchObject({ status: 200, item: { status: "accepted" } });

    const item = (n: number, status: ReviewItemDto["status"]): ReviewItemDto => {
      const p = payload(n);
      return {
        id: n,
        run: 1,
        kind: "finding",
        body: `Body ${n}.`,
        payload: p,
        anchor: { ...p.anchor, side: "new" } as never,
        status,
        revision: 1,
        edited: false,
      };
    };
    const runs = [{ id: 1, sourceHead: "a".repeat(40), targetHead: "b".repeat(40), mergeBase: "c".repeat(40) }];
    const plan = buildPlan({ me: "me", mark: false, severity: false, runs, items: [item(1, "new"), item(2, "accepted")], comments: [] });
    expect(plan.flatMap((p) => p.items.map((i) => i.id))).toEqual([2]);
  });

  test("mustFixPoint never picks a polish point", () => {
    const confirmed = { verify: { verdict: "confirmed" } as never, severity: "major" as const };
    expect(mustFixPoint(confirmed)).toBe(true);
    expect(mustFixPoint({ ...confirmed, polish: true })).toBe(false);
    expect(mustFixPoint({ ...confirmed, polish: false })).toBe(true);
  });
});
