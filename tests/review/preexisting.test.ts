// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v3.md WP-V6, D1, and Q6 (variant "preexisting"): the result schema, the anchor check, the settle floor and cap, the
// candidates file, and the post guard. Pure functions and an in-memory database. No process, no forge.
import { describe, expect, test } from "bun:test";
import { buildPlan } from "../../src/server/publish/plan";
import type { RunOutcome } from "../../src/server/review/claude";
import { type Candidate, candidatesFile } from "../../src/server/review/context-files";
import { triage } from "../../src/server/review/items";
import { answerFinding, type CheckRun, type Found, obligationFinding, type SettleInput, settle } from "../../src/server/review/judge";
import type { NewItem } from "../../src/server/review/run-rows";
import { validate } from "../../src/server/review/validate";
import { openDb } from "../../src/server/storage/db";
import type { ReviewItemDto } from "../../src/shared/dto";
import {
  type Anchor,
  displayGroup,
  type Finding,
  type FindingPayload,
  PREEXISTING_MAX,
  reviewResult,
  type VerifyVerdict,
} from "../../src/shared/review";

console.log(`preexisting.test.ts imported from ${Bun.resolveSync("../../src/server/review/validate", import.meta.dir)}`);

const NONE = { read: [], skipped: [], unavailable: [], notChecked: [] };

// Line 2 of src/a.ts changed. src/old.ts is outside the diff, so it is the same at base and head.
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  " const d = 5;",
  "",
].join("\n");
const NEW_FILES = new Map([
  ["src/a.ts", "const a = 1;\nconst b = 3;\nconst c = 4;\nconst d = 5;\n"],
  ["src/old.ts", "export function load() {\n  return read();\n}\n"],
]);
const OLD_FILES = new Map([["src/a.ts", "const a = 1;\nconst b = 2;\nconst c = 4;\nconst d = 5;\n"]]);
const ON_OLD = { path: "src/old.ts", side: "new" as const, line: 2, lineEnd: null, anchorText: "return read();" };
const ON_CHANGE = { path: "src/a.ts", side: "new" as const, line: 2, lineEnd: null, anchorText: "const b = 3;" };

const F = (o: Partial<Finding> = {}): Finding => ({
  ...ON_OLD,
  severity: "major",
  category: "behavior",
  body: "Body.",
  evidence: "src/old.ts:2",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  title: "Title",
  trigger: "Trigger.",
  cause: null,
  rule: "",
  module: "core",
  ...o,
});
const check = (findings: Finding[], preexisting: boolean) =>
  validate({
    result: { summary: "", risks: [], questions: [], coverage: NONE, findings, answered: [] },
    diff: DIFF,
    newFiles: NEW_FILES,
    oldFiles: OLD_FILES,
    agents: [],
    preexisting,
  });

describe("result schema", () => {
  test("a result without the key parses as before, and the mark survives the parse", () => {
    const { preexisting: _, ...old } = F();
    const result = { summary: "S.", risks: [], questions: [], coverage: NONE, answered: [] };
    expect(reviewResult.parse({ ...result, findings: [old] }).findings[0]).not.toHaveProperty("preexisting");
    expect(reviewResult.parse({ ...result, findings: [F({ preexisting: true })] }).findings[0]?.preexisting).toBe(true);
    expect(reviewResult.safeParse({ ...result, findings: [F({ preexisting: "yes" as never })] }).success).toBe(false);
  });
});

describe("anchor check (validate.ts)", () => {
  test("variant on: a marked major or blocker finding in unchanged code stays, with the mark and no cause", () => {
    const cause = { ...ON_OLD, line: 1, anchorText: "export function load() {" };
    const v = check([F({ preexisting: true }), F({ preexisting: true, severity: "blocker", cause })], true);
    expect(v.dropped).toEqual([]);
    expect(v.findings.map((f) => [f.preexisting, f.cause, f.anchor.state])).toEqual([
      [true, null, "outside"],
      [true, null, "outside"],
    ]);
  });

  test("a minor mark, no mark, or the variant off drops the finding as unchanged, as before", () => {
    for (const [f, on] of [
      [F({ preexisting: true, severity: "minor" }), true],
      [F({ preexisting: true, severity: "nit" }), true],
      [F({ preexisting: false }), true],
      [F(), true],
      [F({ preexisting: true }), false],
    ] as const) {
      const v = check([f], on);
      expect(v.findings).toEqual([]);
      expect(v.dropped.map((d) => d.reason)).toEqual(["unchanged"]);
    }
  });

  test("a finding in the change loses the mark: by its anchor, or by its changed cause", () => {
    for (const on of [true, false]) {
      const v = check([F({ ...ON_CHANGE, preexisting: true }), F({ preexisting: true, cause: ON_CHANGE })], on);
      expect(v.dropped).toEqual([]);
      expect(v.findings.map((f) => "preexisting" in f)).toEqual([false, false]);
      expect(v.findings[1]?.cause?.anchor?.line).toBe(2);
    }
  });

  test("a wrong quote still drops: the mark needs the anchor quote", () => {
    expect(check([F({ preexisting: true, anchorText: "return write();" })], true).dropped.map((d) => d.reason)).toEqual(["match"]);
  });

  test("risk and obligation findings of the verify phase never carry the mark", () => {
    const at = { ...ON_CHANGE, title: "T", body: "B." };
    const v = { severity: "major" as const, reason: "R.", evidence: "E." };
    expect(answerFinding(v, at, "risk")).not.toHaveProperty("preexisting");
    const o = {
      source: "surface" as const,
      must: "M.",
      consumer: "C.",
      cite: { path: "README.md", quote: "q" },
      status: "missing" as const,
      evidence: "",
      duplicateOf: null,
      severity: "minor" as const,
      finding: at,
    };
    expect(obligationFinding(o as never, at)).not.toHaveProperty("preexisting");
  });
});

// ---------- settle (judge.ts) ----------

const anchor = (line: number): Anchor => ({
  state: "outside",
  path: "src/old.ts",
  oldPath: null,
  line,
  lineEnd: line,
  excerpt: [{ n: line, kind: "ctx", text: `line ${line}` }],
});
const payload = (n: number, o: Partial<FindingPayload> = {}): FindingPayload => ({
  ...F({ line: n, anchorText: `line ${n}`, title: `Title ${n}`, path: "src/old.ts" }),
  anchor: anchor(n),
  preexisting: true,
  ...o,
});
const C = (n: number, o: Partial<FindingPayload> = {}): Candidate => ({ n, group: null, from: null, finding: payload(n, o) });
const V = (candidate: number, verdict: VerifyVerdict["verdict"], o: Partial<VerifyVerdict> = {}): VerifyVerdict => ({
  candidate,
  verdict,
  severity: "major",
  reason: "R.",
  evidence: "E.",
  duplicateOf: null,
  question: "",
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
  return { items: payloads(e.result?.items ?? []), notChecked: e.result?.summary.coverage.notChecked ?? [], all: e.result?.items ?? [] };
};

describe("settle (judge.ts)", () => {
  test("at most PREEXISTING_MAX shown, by severity then confidence; the rest gives one coverage line", () => {
    expect(PREEXISTING_MAX).toBe(5);
    const conf = ["low", "high", "medium", "high", "low", "high", "medium"] as const;
    const cands = conf.map((confidence, i) => C(i + 1, { confidence }));
    const verdicts = cands.map((c) => V(c.n, "confirmed", { severity: c.n === 7 ? "blocker" : "major" }));
    const r = end(cands, verdicts);
    expect(r.items.map((p) => p.title)).toEqual(["Title 7", "Title 2", "Title 4", "Title 6", "Title 3"]);
    expect(r.items.every((p) => displayGroup(p, "balanced") === "preexisting")).toBe(true);
    expect(r.notChecked).toEqual(["2 pre-existing findings were left out: a run shows at most 5."]);
  });

  test("below major after the check, unsure, or a question: no item, one coverage line; refuted hides as any finding", () => {
    const cands = [C(1), C(2), C(3), C(4), C(5, { trigger: "" })];
    const verdicts = [V(1, "confirmed", { severity: "minor" }), V(2, "unsure"), V(3, "question"), V(4, "refuted"), V(5, "unsure")];
    const r = end(cands, verdicts);
    expect(r.items.map((p) => [p.title, p.discardedBy ?? null, displayGroup(p, "thorough")])).toEqual([["Title 4", "verify", "hidden"]]);
    expect(r.all.filter((i) => i.kind === "question")).toEqual([]);
    expect(r.notChecked).toEqual(["4 pre-existing findings were left out: below major after the check."]);
  });

  test("a refuted pre-existing finding never stays in the list, also under the outcome demote and a protected class", () => {
    const r = end([C(1, { category: "security" })], [V(1, "refuted")], { demote: true });
    expect(r.items.map((p) => [p.demoted ?? null, p.discardedBy ?? null])).toEqual([[null, "verify"]]);
  });

  test("with the verify phase off, only code evidence keeps the severity, so unverified evidence drops", () => {
    const e = settle(found([C(1), C(2, { evidenceStatus: "unverified" })]), input({ verify: false }));
    expect(payloads(e.result?.items ?? []).map((p) => p.title)).toEqual(["Title 1"]);
  });

  test("normal findings keep their path: the floor and the cap touch only marked findings", () => {
    const cands = [C(1, { preexisting: undefined, severity: "minor" }), ...[2, 3, 4, 5, 6, 7].map((n) => C(n))];
    const r = end(
      cands,
      cands.map((c) => V(c.n, "confirmed", { severity: c.n === 1 ? "minor" : "major" })),
    );
    expect(r.items.filter((p) => !p.preexisting).map((p) => [p.title, p.severity])).toEqual([["Title 1", "minor"]]);
    expect(r.items.filter((p) => p.preexisting)).toHaveLength(5);
  });
});

describe("candidates file (context-files.ts)", () => {
  test("only a marked candidate gets the Pre-existing line", () => {
    const text = candidatesFile([C(1), C(2, { preexisting: undefined })]).file.text;
    expect(text.split("- Pre-existing: yes.")).toHaveLength(2);
    expect(text.indexOf("- Pre-existing: yes.")).toBeLessThan(text.indexOf("## Candidate 2"));
  });
});

describe("post guard", () => {
  test("items.ts refuses Accept and Edit of a pre-existing finding; Discard and Restore work", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'PROJ', 'repo', 1)");
    const { id: run } = db
      .query(
        `INSERT INTO review_run (pr, kind, profile, profile_name, prompt_version, note, idem_key, source_head, target_head, status, started_at)
        VALUES (1, 'review', 'general', 'General', '2.8+preexisting', '', 'k', 'h', 't', 'completed', 1) RETURNING id`,
      )
      .get() as { id: number };
    const add = (p: object) =>
      (
        db
          .query(
            `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status, revision, edited)
            VALUES ($run, 'finding', $payload, 'b', 'src/old.ts', 'new', 2, 2, 'new', 0, 0) RETURNING id`,
          )
          .get({ run, payload: JSON.stringify(p) }) as { id: number }
      ).id;
    const pre = add(payload(2));
    const plain = add(payload(3, { preexisting: undefined }));
    for (const input of [
      { action: "accept", revision: 0 },
      { action: "edit", revision: 0, body: "New." },
    ] as const)
      expect(triage(db, pre, input)).toEqual({ status: 400, error: "A pre-existing finding is never posted." });
    expect(triage(db, plain, { action: "accept", revision: 0 })).toMatchObject({ status: 200, item: { status: "accepted" } });
    expect(triage(db, pre, { action: "discard", revision: 0 })).toMatchObject({ status: 200, item: { status: "discarded" } });
    expect(triage(db, pre, { action: "restore", revision: 1 })).toMatchObject({ status: 200, item: { status: "new" } });
  });

  test("buildPlan leaves out a pre-existing finding, also when its status is accepted", () => {
    const item = (id: number, p: FindingPayload): ReviewItemDto => ({
      id,
      run: 1,
      kind: "finding",
      body: `Body ${id}.`,
      payload: p,
      anchor: { ...p.anchor, state: "exact", side: "new" } as never,
      status: "accepted",
      revision: 1,
      edited: false,
    });
    const runs = [{ id: 1, sourceHead: "a".repeat(40), targetHead: "b".repeat(40), mergeBase: "c".repeat(40) }];
    const plan = (items: ReviewItemDto[]) =>
      buildPlan({ me: "me", mark: false, severity: false, runs, items, comments: [] }).flatMap((p) => p.items.map((i) => i.id));
    expect(plan([item(1, payload(2)), item(2, payload(3, { preexisting: undefined }))])).toEqual([2]);
  });
});
