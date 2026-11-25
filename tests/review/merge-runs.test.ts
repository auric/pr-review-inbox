// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/thorough-review.md WP-T1a: the merge of the two arms of a run of the variant "twice" (D2, D3).
import { describe, expect, test } from "bun:test";
import type { RunOutcome } from "../../src/server/review/claude";
import { triage } from "../../src/server/review/items";
import { type CandidateLink, type Ending, mergeRuns } from "../../src/server/review/judge";
import type { NewItem } from "../../src/server/review/run-rows";
import { openDb } from "../../src/server/storage/db";
import type { RunPhase, RunSummary, RunUsage } from "../../src/shared/dto";
import { type CopySpot, copyPairs, type FindingPayload, type Severity, type VerifyMark } from "../../src/shared/review";
import type { RunEvent } from "../../src/shared/run-log";

console.log(`merge-runs.test.ts imported from ${Bun.resolveSync("../../src/server/review/judge", import.meta.dir)}`);

type F = {
  path?: string;
  line: number;
  end?: number;
  side?: "new" | "old";
  severity?: Severity;
  verdict?: VerifyMark["verdict"];
  status?: "new" | "discarded";
  extra?: Partial<FindingPayload>;
};

const finding = (f: F): NewItem => {
  const severity = f.severity ?? "major";
  const payload = {
    title: `T ${f.path ?? "a.ts"}:${f.line}`,
    body: "B",
    severity,
    side: f.side ?? "new",
    ...(f.verdict && { verify: { verdict: f.verdict, severity, reason: "R", evidence: "e", duplicateOf: null, by: "rl-verify" } }),
    ...f.extra,
  };
  return {
    kind: "finding",
    payload_json: JSON.stringify(payload),
    body: "B",
    path: f.path ?? "a.ts",
    side: f.side ?? "new",
    line: f.line,
    line_end: f.end ?? f.line,
    anchor_state: "exact",
    excerpt_json: "[]",
    status: f.status ?? "new",
    thread: null,
    edited: 0,
  } as NewItem;
};
const other = (kind: "question" | "reply", body: string): NewItem =>
  ({
    kind,
    payload_json: "{}",
    body,
    path: null,
    side: null,
    line: null,
    line_end: null,
    anchor_state: null,
    excerpt_json: null,
    status: "new",
    thread: kind === "reply" ? 7 : null,
    edited: 0,
  }) as NewItem;

const use = (cost: number): RunUsage => ({ costUsd: cost, turns: 1, durationMs: 10, tokens: { input_tokens: 100 } });
const ev = (id: string): RunEvent => ({ id, seq: 0, parent: null }) as RunEvent;
const outcome = (cost: number, ids: string[]): RunOutcome =>
  ({
    status: "completed",
    kind: null,
    text: null,
    result: { total_cost_usd: cost, num_turns: 1, duration_ms: 10, usage: { input_tokens: 100 } },
    init: null,
    events: ids.map(ev),
  }) as unknown as RunOutcome;
const verifyOf = (candidates: number) => ({
  candidates,
  confirmed: 0,
  refuted: 0,
  unsure: 0,
  questions: 0,
  duplicates: 0,
  unchecked: candidates,
});

type Arm = {
  items: NewItem[];
  // [item index, n, duplicateOf]
  links?: [number, number, number | null][];
  candidates?: number;
  summary?: Partial<RunSummary>;
  status?: "completed" | "incomplete";
  usage?: RunUsage | null;
  cost?: number;
  events?: string[];
  phases?: RunPhase[];
};
const arm = (a: Arm): Ending => {
  const links = new Map<NewItem, CandidateLink>((a.links ?? []).map(([i, n, d]) => [a.items[i] as NewItem, { n, duplicateOf: d }]));
  return {
    status: a.status ?? "completed",
    kind: null,
    text: null,
    raw: "raw",
    outcome: outcome(a.cost ?? 1, a.events ?? []),
    ...(a.usage !== undefined && { usage: a.usage }),
    result: {
      summary: {
        summary: "S",
        risks: [],
        coverage: { read: ["a.ts"], skipped: [], unavailable: [], notChecked: [] },
        dropped: [],
        volume: "thorough",
        verify: verifyOf(a.candidates ?? a.items.length),
        phases: a.phases ?? [],
        ...a.summary,
      },
      items: a.items,
      links,
    },
  };
};
const failed = (kind: "max_turns" | "usage_limit", cost: number, events: string[]): Ending => ({
  status: "failed",
  kind,
  text: "x",
  raw: "fail",
  outcome: { ...outcome(cost, events), status: "failed", kind },
});

const res = (e: Ending) => e.result as NonNullable<Ending["result"]>;
const pay = (it: NewItem) => JSON.parse(it.payload_json) as FindingPayload;
const linkOf = (e: Ending, it: NewItem) => res(e).links?.get(it);

describe("copyPairs (thorough-review.md D2)", () => {
  const s = (line: number, o: Partial<CopySpot> = {}): CopySpot => ({ path: "a.ts", side: "new", line, lineEnd: null, ...o });
  test("a gap of 3 lines pairs, 4 do not", () => {
    expect(copyPairs([s(10)], [s(13)])).toEqual([[0, 0]]);
    expect(copyPairs([s(10)], [s(14)])).toEqual([]);
    expect(copyPairs([s(10, { lineEnd: 12 })], [s(15)])).toEqual([[0, 0]]);
    expect(copyPairs([s(10, { lineEnd: 12 })], [s(16)])).toEqual([]);
  });
  test("another path, side, preexisting, or polish does not pair", () => {
    expect(copyPairs([s(10)], [s(10, { side: "old" })])).toEqual([]);
    expect(copyPairs([s(10)], [s(10, { path: "b.ts" })])).toEqual([]);
    expect(copyPairs([s(10)], [s(10, { preexisting: true })])).toEqual([]);
    expect(copyPairs([s(10, { polish: false })], [s(10, { polish: true })])).toEqual([]);
    expect(copyPairs([s(10, { polish: false })], [s(10)])).toEqual([[0, 0]]);
  });
  test("one to one: two b spots near one a spot pair once; the nearest free a spot wins, then the first", () => {
    expect(copyPairs([s(10)], [s(11), s(12)])).toEqual([[0, 0]]);
    expect(copyPairs([s(10), s(20)], [s(19), s(11)])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(copyPairs([s(10), s(14)], [s(12)])).toEqual([[0, 0]]);
  });
});

describe("mergeRuns (thorough-review.md D3)", () => {
  test("arm order, pass per arm, replies from the first usable arm only, runs key, raw sections", () => {
    const a = arm({ items: [finding({ line: 10 }), other("question", "QA"), other("reply", "RA")] });
    const b = arm({ items: [finding({ path: "b.ts", line: 10 }), other("question", "QB"), other("reply", "RB")] });
    const m = mergeRuns([a, b], "thorough");
    expect(m.status).toBe("completed");
    expect(res(m).items.map((i) => (i.body === "B" ? `${i.path}` : i.body))).toEqual(["a.ts", "QA", "RA", "b.ts", "QB"]);
    expect(
      res(m)
        .items.filter((i) => i.kind === "finding")
        .map((i) => pay(i).pass),
    ).toEqual([1, 2]);
    expect(res(m).summary.runs).toEqual({ count: 2, copies: 0 });
    expect(m.raw).toContain("# Run 1 of 2");
    expect(m.raw).toContain("# Run 2 of 2");
  });

  test("links and duplicateOf of arm B move up by the candidates of arm A; fromRisk moves up by the arm A risks", () => {
    const a = arm({
      items: [finding({ line: 10 }), finding({ line: 50, status: "discarded", verdict: "duplicate" })],
      links: [
        [0, 1, null],
        [1, 2, 1],
      ],
      candidates: 3,
      summary: {
        finderRisks: {
          listed: 2,
          found: 0,
          asked: 0,
          cleared: 2,
          covered: 0,
          open: 0,
          list: [
            { text: "r1", outcome: "cleared", note: "" },
            { text: "r2", outcome: "cleared", note: "" },
          ],
        },
      },
    });
    const b = arm({
      items: [
        finding({ path: "b.ts", line: 10 }),
        finding({ path: "b.ts", line: 40, status: "discarded", verdict: "duplicate" }),
        finding({ path: "c.ts", line: 1, extra: { fromRisk: 0 } }),
      ],
      links: [
        [0, 1, null],
        [1, 2, 1],
      ],
      summary: {
        finderRisks: { listed: 1, found: 1, asked: 0, cleared: 0, covered: 0, open: 0, list: [{ text: "r3", outcome: "found", note: "" }] },
      },
    });
    const m = mergeRuns([a, b], "thorough");
    const items = res(m).items;
    expect(items.map((i) => linkOf(m, i))).toEqual([
      { n: 1, duplicateOf: null },
      { n: 2, duplicateOf: 1 },
      { n: 4, duplicateOf: null },
      { n: 5, duplicateOf: 4 },
      undefined,
    ]);
    expect(pay(items[4] as NewItem).fromRisk).toBe(2);
    expect(res(m).summary.finderRisks?.list.map((r) => r.text)).toEqual(["r1", "r2", "r3"]);
    expect(res(m).summary.finderRisks).toMatchObject({ listed: 3, found: 1, cleared: 2 });
    expect(res(m).summary.risks).toEqual([]);
  });

  test("one find phase and one check phase; verify counts add; the usage sums, also for an Ending without usage", () => {
    const ph = (name: "find" | "check", s: number, e: number, c: number): RunPhase => ({ name, startedAt: s, endedAt: e, usage: use(c) });
    const a = arm({ items: [], candidates: 2, usage: use(3), events: ["e1"], phases: [ph("find", 100, 200, 1), ph("check", 200, 300, 2)] });
    const b = arm({ items: [], candidates: 5, cost: 4, events: ["pass2:e1"], phases: [ph("find", 90, 250, 4)] });
    const m = mergeRuns([a, b], "balanced");
    const s = res(m).summary;
    expect(s.phases).toEqual([
      { name: "find", startedAt: 90, endedAt: 250, usage: { ...use(5), turns: 2, durationMs: 20, tokens: { input_tokens: 200 } } },
      { name: "check", startedAt: 200, endedAt: 300, usage: use(2) },
    ]);
    expect(s.verify?.candidates).toBe(7);
    expect(s.verify?.unchecked).toBe(7);
    expect(s.volume).toBe("balanced");
    expect(m.usage?.costUsd).toBe(7);
    expect(m.outcome?.events.map((e) => e.id)).toEqual(["e1", "pass2:e1"]);
  });

  test("a 3-line copy hides as an app duplicate linked to the survivor; a 4-line gap stays", () => {
    const a = arm({ items: [finding({ line: 10 }), finding({ line: 30 })], links: [[0, 1, null]], candidates: 2 });
    const b = arm({
      items: [finding({ line: 13 }), finding({ line: 34 })],
      links: [
        [0, 1, null],
        [1, 2, null],
      ],
      candidates: 2,
    });
    const m = mergeRuns([a, b], "thorough");
    const items = res(m).items;
    expect(items.map((i) => i.status)).toEqual(["new", "new", "discarded", "new"]);
    const copy = pay(items[2] as NewItem);
    expect(copy.discardedBy).toBe("verify");
    expect(copy.verify).toEqual({
      verdict: "duplicate",
      severity: "major",
      reason: "Run 1 of 2 raised the same point.",
      evidence: "a.ts:10",
      duplicateOf: null,
      by: "app",
    });
    expect(copy.ownVerify).toBeUndefined();
    expect(copy.pass).toBe(2);
    expect(linkOf(m, items[2] as NewItem)).toEqual({ n: 3, duplicateOf: 1 });
    expect(res(m).summary.runs).toEqual({ count: 2, copies: 1 });
  });

  test("a hidden copy keeps the verdict of its own run as ownVerify; a duplicate of the check gets none", () => {
    const a = arm({ items: [finding({ line: 10, verdict: "confirmed" })], links: [[0, 1, null]], candidates: 1 });
    const b = arm({
      items: [finding({ line: 12, verdict: "confirmed" }), finding({ line: 40, status: "discarded", verdict: "duplicate" })],
      links: [
        [0, 1, null],
        [1, 2, 1],
      ],
      candidates: 2,
    });
    const items = res(mergeRuns([a, b], "thorough")).items;
    const copy = pay(items[1] as NewItem);
    expect(copy.verify?.by).toBe("app");
    expect(copy.ownVerify).toEqual({
      verdict: "confirmed",
      severity: "major",
      reason: "R",
      evidence: "e",
      duplicateOf: null,
      by: "rl-verify",
    });
    const dup = pay(items[2] as NewItem);
    expect(dup.verify?.by).toBe("rl-verify");
    expect(dup.ownVerify).toBeUndefined();
  });

  test("a survivor without a link gets a number above both arms", () => {
    const a = arm({ items: [finding({ line: 10 })], candidates: 2 });
    const b = arm({ items: [finding({ line: 11 })], candidates: 3 });
    const m = mergeRuns([a, b], "thorough");
    const items = res(m).items;
    expect(linkOf(m, items[0] as NewItem)).toEqual({ n: 6, duplicateOf: null });
    expect(linkOf(m, items[1] as NewItem)).toEqual({ n: 7, duplicateOf: 6 });
  });

  test("two arm B items near one arm A item hide only one", () => {
    const a = arm({ items: [finding({ line: 10 })] });
    const b = arm({ items: [finding({ line: 11 }), finding({ line: 12 })] });
    const m = mergeRuns([a, b], "thorough");
    expect(res(m).items.map((i) => i.status)).toEqual(["new", "discarded", "new"]);
  });

  test("a demoted refuted major stays, and the unsure minor of the other arm stays shown", () => {
    const a = arm({ items: [finding({ line: 10, verdict: "refuted", extra: { demoted: true } })] });
    const b = arm({ items: [finding({ line: 10, severity: "minor", verdict: "unsure" })] });
    const m = mergeRuns([a, b], "balanced");
    expect(res(m).items.map((i) => i.status)).toEqual(["new", "new"]);
    expect(res(m).summary.runs?.copies).toBe(0);
  });

  test("refuted and hidden items take no part", () => {
    const a = arm({ items: [finding({ line: 10, status: "discarded", verdict: "refuted", extra: { discardedBy: "verify" } })] });
    const b = arm({ items: [finding({ line: 10 })] });
    const m = mergeRuns([a, b], "thorough");
    expect(res(m).items.map((i) => i.status)).toEqual(["discarded", "new"]);
    expect(res(m).summary.runs?.copies).toBe(0);
  });

  test("survivor order: main before fold, then severity, then check, then arm A", () => {
    const keep = (x: F, y: F, volume: "quiet" | "balanced" | "thorough") => {
      const m = mergeRuns([arm({ items: [finding(x)] }), arm({ items: [finding(y)] })], volume);
      return res(m).items.findIndex((i) => i.status === "new") === 0 ? "A" : "B";
    };
    // Balanced folds an unsure finding and a nit, and shows a checked minor.
    expect(keep({ line: 1, severity: "major", verdict: "unsure" }, { line: 1, severity: "minor", verdict: "confirmed" }, "balanced")).toBe(
      "B",
    );
    expect(keep({ line: 1, severity: "nit", verdict: "confirmed" }, { line: 1, severity: "minor", verdict: "confirmed" }, "balanced")).toBe(
      "B",
    );
    expect(keep({ line: 1, severity: "minor", verdict: "unsure" }, { line: 1, severity: "minor", verdict: "confirmed" }, "balanced")).toBe(
      "B",
    );
    expect(keep({ line: 1, severity: "minor" }, { line: 1, severity: "major" }, "thorough")).toBe("B");
    expect(keep({ line: 1, verdict: "unsure" }, { line: 1, verdict: "confirmed" }, "thorough")).toBe("B");
    expect(keep({ line: 1 }, { line: 1, verdict: "unsure" }, "thorough")).toBe("B");
    expect(keep({ line: 1, verdict: "confirmed" }, { line: 1, verdict: "confirmed" }, "thorough")).toBe("A");
    // The hidden arm A copy names run 2.
    const m = mergeRuns([arm({ items: [finding({ line: 1, severity: "minor" })] }), arm({ items: [finding({ line: 2 })] })], "thorough");
    expect(pay(res(m).items[0] as NewItem).verify?.reason).toBe("Run 2 of 2 raised the same point.");
  });

  test("one usable arm: its result with the gap line of the failed arm, incomplete, usage of both", () => {
    const b = arm({ items: [finding({ line: 10 })], cost: 2, events: ["pass2:x"] });
    const m = mergeRuns([failed("max_turns", 3, ["pass1:x"]), b], "thorough");
    expect(m.status).toBe("incomplete");
    expect(res(m).summary.coverage.skipped).toEqual(["Run 1 of 2 failed: max_turns. Its findings are missing."]);
    expect(res(m).items.map((i) => pay(i).pass)).toEqual([2]);
    expect(m.usage?.costUsd).toBe(5);
    expect(m.outcome?.events.map((e) => e.id)).toEqual(["pass1:x", "pass2:x"]);
  });

  test("no usable arm: the arm A Ending with the usage sum and the events of both arms", () => {
    const m = mergeRuns([failed("usage_limit", 1, ["a"]), failed("max_turns", 2, ["b"])], "thorough");
    expect(m.status).toBe("failed");
    expect(m.kind).toBe("usage_limit");
    expect(m.result).toBeUndefined();
    expect(m.usage?.costUsd).toBe(3);
    expect(m.outcome?.events.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("Restore of a hidden copy (thorough-review.md D2)", () => {
  const own = { verdict: "confirmed", severity: "major", reason: "R", evidence: "e", duplicateOf: null, by: "rl-verify" } as const;
  const app = { ...own, verdict: "duplicate", reason: "Run 1 of 2 raised the same point.", evidence: "a.ts:10", by: "app" } as const;
  const restored = (p: object) => {
    const db = openDb(":memory:");
    db.run("INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'PROJ', 'repo', 1)");
    const { id: run } = db
      .query(
        `INSERT INTO review_run (pr, kind, profile, profile_name, prompt_version, note, idem_key, source_head, target_head, status, started_at)
        VALUES (1, 'review', 'general', 'General', '2.9+twice', '', 'k', 'h', 't', 'completed', 1) RETURNING id`,
      )
      .get() as { id: number };
    const { id } = db
      .query(
        `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status, revision, edited)
        VALUES ($run, 'finding', $payload, 'b', 'a.ts', 'new', 12, 12, 'discarded', 0, 0) RETURNING id`,
      )
      .get({ run, payload: JSON.stringify({ title: "T", body: "B", severity: "major", discardedBy: "verify", ...p }) }) as {
      id: number;
    };
    const r = triage(db, id, { action: "restore", revision: 0 });
    expect(r).toMatchObject({ status: 200, item: { status: "new" } });
    const row = db.query("SELECT payload_json FROM review_item WHERE id = $id").get({ id }) as { payload_json: string };
    return JSON.parse(row.payload_json) as FindingPayload;
  };

  test("a copy with ownVerify gets its own verdict back as verify", () => {
    const p = restored({ verify: app, ownVerify: own });
    expect(p.verify).toEqual(own);
    expect(p.ownVerify).toBeUndefined();
    expect(p.discardedBy).toBeUndefined();
  });

  test("an old copy without ownVerify and a duplicate of the check keep their verify", () => {
    expect(restored({ verify: app }).verify).toEqual(app);
    const dup = { ...own, verdict: "duplicate", duplicateOf: 3 } as const;
    expect(restored({ verify: dup, ownVerify: own })).toMatchObject({ verify: dup, ownVerify: own });
  });
});
