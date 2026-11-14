// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review quality (docs/plans/review-v2/spec.md sections 4.1, 4.2; AC-M4, AC-M5): the discard reason action and the stats route.
// An in-memory database, no runner, no git.
import { describe, expect, test } from "bun:test";
import { createLive } from "../../src/server/live";
import { triage } from "../../src/server/review/items";
import type { ReviewJobs } from "../../src/server/review/jobs";
import { createReviewRoutes } from "../../src/server/review/routes";
import { postOutcome, reviewStats } from "../../src/server/review/stats";
import { openDb } from "../../src/server/storage/db";
import type { ReviewStatsDto } from "../../src/shared/dto";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const MIN = 60_000;
const ZERO = { addressed: 0, open: 0, pending: 0 };
const NONE = { blocker: ZERO, major: ZERO, minor: ZERO, nit: ZERO };

function setup() {
  const db = openDb(":memory:");
  db.run("INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'PROJ', 'repo', 1)");
  let keys = 0;
  const run = (o: {
    profile?: string;
    version?: string | null;
    status?: string;
    started: number;
    minutes?: number;
    summary?: object;
    cost?: number;
  }) =>
    (
      db
        .query(
          `INSERT INTO review_run (pr, kind, profile, profile_name, prompt_version, note, idem_key, source_head, target_head, status,
            started_at, finished_at, summary_json, usage_json)
          VALUES (1, 'review', 'general', $name, $version, '', $key, 'h', 't', $status, $started, $finished, $summary, $usage) RETURNING id`,
        )
        .get({
          name: o.profile ?? "General",
          version: o.version === undefined ? null : o.version,
          key: `k${keys++}`,
          status: o.status ?? "completed",
          started: o.started,
          finished: o.started + (o.minutes ?? 1) * MIN,
          summary: JSON.stringify({ summary: "", risks: [], coverage: {}, dropped: [], ...o.summary }),
          usage: o.cost === undefined ? null : JSON.stringify({ costUsd: o.cost, turns: 3, durationMs: 1, tokens: {} }),
        }) as { id: number }
    ).id;
  const finding = (r: number, status: string, p: Record<string, unknown> = {}, edited = 0) =>
    (
      db
        .query(
          `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status, revision, edited)
          VALUES ($run, 'finding', $payload, 'b', 'a.ts', 'new', 3, 3, $status, 0, $edited) RETURNING id`,
        )
        .get({ run: r, payload: JSON.stringify({ severity: "major", ...p }), status, edited }) as { id: number }
    ).id;
  const comment = (id: number, o: { resolved?: boolean; orphanedAt?: number } = {}) =>
    db
      .query(
        `INSERT INTO comment (pr, comment_id, version, root_id, author_slug, text, created_at, updated_at, thread_resolved, orphaned_at)
        VALUES (1, $id, 0, $id, 'me', 't', 10, 10, $resolved, $orphaned)`,
      )
      .run({ id, resolved: o.resolved ? 1 : 0, orphaned: o.orphanedAt ?? null });
  const post = (r: number, items: number[], remote: number, state = "confirmed") =>
    db
      .query(
        `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, remote_id, created_at, updated_at)
        VALUES (1, $run, 'inline', $key, 'b', '{}', $items, $state, $remote, $at, $at)`,
      )
      .run({ run: r, key: `p${keys++}`, items: JSON.stringify(items.map((id) => ({ id, revision: 0 }))), state, remote, at: NOW - DAY });
  const fixedIn = (thread: number, commitState: string) => {
    const fr = (
      db
        .query(
          `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
          VALUES (1, 'fix', '', '', $key, 'h', 't', 'completed', $at) RETURNING id`,
        )
        .get({ key: `k${keys++}`, at: NOW - DAY }) as { id: number }
    ).id;
    const fc = (
      db
        .query(
          `INSERT INTO fix_commit (pr, run, idem_key, edits_json, mode, before_head, commit_hash, short_hash, state, message, created_at, updated_at)
          VALUES (1, $run, $key, '[]', 'clone', 'b', 'c', 'c', $state, 'm', 1, 1) RETURNING id`,
        )
        .get({ run: fr, key: `c${keys++}`, state: commitState }) as { id: number }
    ).id;
    db.query(
      `INSERT INTO review_item (run, kind, payload_json, body, status, thread) VALUES ($run, 'reply', $payload, 'Fixed in c', 'new', $thread)`,
    ).run({ run: fr, thread, payload: JSON.stringify({ thread, action: "reply", replyTo: thread, fix: { id: fc, commit: "c" } }) });
  };
  const stats = (days = 30) => reviewStats(db, days, NOW);
  const row = (version: string) => stats().find((s) => s.promptVersion === version) as ReviewStatsDto;
  return { db, run, finding, comment, post, fixedIn, stats, row };
}

// A v1 run and its re-review, a v2 run with the check phase, and runs that the window or the status leaves out.
function seeded() {
  const s = setup();
  const a = s.run({ version: null, started: NOW - 2 * DAY, minutes: 10, cost: 0.5 });
  s.finding(a, "accepted", {}, 1);
  const resolved = s.finding(a, "posted");
  const orphaned = s.finding(a, "posted");
  const fixed = s.finding(a, "posted");
  const plain = s.finding(a, "posted");
  s.comment(500, { resolved: true });
  s.comment(600, { orphanedAt: NOW - DAY + 1 });
  s.comment(700);
  s.comment(800, { orphanedAt: NOW - DAY - 1 });
  s.post(a, [resolved], 500);
  s.post(a, [orphaned], 600);
  s.post(a, [fixed], 700);
  s.post(a, [plain], 800);
  s.fixedIn(700, "committed");
  s.fixedIn(800, "undone");
  const byReason = s.finding(a, "new");
  const noReason = s.finding(a, "new");
  s.finding(a, "discarded", { fixed: { id: 1, commit: "c", short: "c", was: "new" } });
  const source = s.finding(a, "discarded");
  const b = s.run({ version: "1", started: NOW - DAY, minutes: 4, cost: 0.25 });
  s.finding(b, "accepted", { carried: { from: source, verdict: "open", reason: "", since: "h" } });
  s.finding(b, "new");
  s.finding(b, "discarded", { revises: byReason });

  const c = s.run({
    version: "2",
    started: NOW - DAY,
    minutes: 3,
    summary: {
      volume: "balanced",
      verify: { candidates: 5, confirmed: 1, refuted: 2, unsure: 1, questions: 0, duplicates: 0, unchecked: 1 },
    },
  });
  s.finding(c, "new", { verify: { verdict: "confirmed" } });
  s.finding(c, "new", { severity: "nit" });
  s.finding(c, "new", { severity: "minor", verify: { verdict: "unsure" } });
  s.finding(c, "discarded", { verify: { verdict: "refuted" }, discardedBy: "verify" });
  s.finding(c, "discarded", { verify: { verdict: "refuted" }, discardedBy: "verify" });
  s.finding(c, "discarded", { session: { run: 1, verdict: "reject", reason: "r", was: "new" } });

  s.finding(s.run({ version: "1", started: NOW - 40 * DAY }), "accepted");
  s.finding(s.run({ version: "1", started: NOW - DAY, status: "failed" }), "accepted");
  return { ...s, byReason, noReason };
}

describe("discard reason action (AC-M5)", () => {
  test("stores payload.discardReason on a discarded finding, and a new discard drops it", () => {
    const s = setup();
    const r = s.run({ started: NOW });
    const id = s.finding(r, "new");
    expect(triage(s.db, id, { action: "reason", revision: 0, code: "bug" })).toMatchObject({ status: 400 });
    expect(triage(s.db, id, { action: "discard", revision: 0 })).toMatchObject({ status: 200 });
    const saved = triage(s.db, id, { action: "reason", revision: 1, code: "intended" });
    expect(saved).toMatchObject({
      status: 200,
      item: { status: "discarded", revision: 2, payload: { discardReason: { code: "intended" } } },
    });
    expect(triage(s.db, id, { action: "restore", revision: 2 })).toMatchObject({ status: 200, item: { status: "new" } });
    const again = triage(s.db, id, { action: "discard", revision: 3 });
    expect(again.status === 200 && again.item.payload.discardReason).toBeUndefined();
  });

  test("refuses a refuted finding, a reply draft, and a stale revision", () => {
    const s = setup();
    const r = s.run({ started: NOW });
    const refuted = s.finding(r, "discarded", { discardedBy: "verify" });
    expect(triage(s.db, refuted, { action: "reason", revision: 0, code: "bug" })).toMatchObject({ status: 400 });
    const mine = s.finding(r, "discarded");
    expect(triage(s.db, mine, { action: "reason", revision: 5, code: "bug" })).toMatchObject({ status: 409 });
    s.db
      .query(
        `INSERT INTO review_item (id, run, kind, payload_json, body, status, thread) VALUES (99, $run, 'reply', $p, 'b', 'discarded', 1)`,
      )
      .run({ run: r, p: JSON.stringify({ thread: 1, action: "reply", replyTo: 1, discardedBy: "user" }) });
    expect(triage(s.db, 99, { action: "reason", revision: 0, code: "bug" })).toMatchObject({ status: 400 });
  });
});

describe("reviewStats (AC-M4)", () => {
  test("counts runs, shown, accepted, discarded by reason, posted, addressed, and outdated per profile and prompt version", () => {
    const s = seeded();
    expect(triage(s.db, s.byReason, { action: "discard", revision: 0 }).status).toBe(200);
    expect(triage(s.db, s.byReason, { action: "reason", revision: 1, code: "bug" }).status).toBe(200);
    expect(triage(s.db, s.noReason, { action: "discard", revision: 0 }).status).toBe(200);
    const all = s.stats();
    expect(all.map((r) => [r.profile, r.promptVersion])).toEqual([
      ["General", "2"],
      ["General", "1"],
    ]);
    expect(s.row("1")).toEqual({
      profile: "General",
      promptVersion: "1",
      runs: 2,
      // 9 findings in run A, 1 new in run B. The copy and the revision count in no run.
      candidates: 10,
      refuted: 0,
      unsure: 0,
      shown: 10,
      // The accepted one, 4 posted ones, and the source whose copy is accepted.
      accepted: 6,
      // A run without a volume shows every finding.
      acceptedShown: 6,
      edited: 1,
      discarded: { total: 2, byReason: { bug: 1, worth: 0, duplicate: 0, intended: 0, place: 0, none: 1 } },
      posted: 4,
      // Resolved thread 500 and the "Fixed in" draft of thread 700. Thread 800 has only an undone fix.
      addressed: 2,
      // Comment 600 turned orphaned after its post. Comment 800 before it.
      outdated: 1,
      // AC-R29: 500 resolved, 600 changed after the post. 700 and 800 wait for a new head: a "Fixed in" draft is no signal.
      outcomes: { ...NONE, major: { addressed: 2, open: 0, pending: 2 } },
      medianMinutes: 7,
      usage: { costUsd: 0.75, turns: 6 },
      // Runs before prompt version 2.7 have no question counts.
      questions: { runs: 0, asked: 0, answered: 0, findings: 0, kept: 0 },
    });
    expect(s.row("2")).toMatchObject({
      runs: 1,
      candidates: 5,
      refuted: 2,
      unsure: 1,
      // Balanced: the confirmed major and the unchecked major. Not the nit, the unsure one, or the refuted ones.
      shown: 2,
      accepted: 0,
      acceptedShown: 0,
      // Refuted items and a session reject are no discards by the user.
      discarded: { total: 0 },
      medianMinutes: 3,
      usage: { costUsd: 0, turns: 0 },
    });
  });

  test("accepted of shown counts only shown findings, so it never exceeds shown; fold accepts stay in accepted", () => {
    const s = setup();
    const r = s.run({
      version: "2",
      started: NOW - DAY,
      summary: {
        volume: "balanced",
        verify: { candidates: 3, confirmed: 1, refuted: 0, unsure: 1, questions: 0, duplicates: 0, unchecked: 1 },
      },
    });
    s.finding(r, "accepted", { verify: { verdict: "confirmed" } });
    // Balanced folds the nit and the unsure one. The user accepts both from the fold.
    s.finding(r, "accepted", { severity: "nit" });
    s.finding(r, "posted", { severity: "minor", verify: { verdict: "unsure" } });
    const row = s.row("2");
    expect([row.shown, row.accepted, row.acceptedShown]).toEqual([1, 3, 1]);
    expect(row.acceptedShown).toBeLessThanOrEqual(row.shown);
  });

  test("AC-R38: the question counts of summary.finderQuestions sum per group; a run without them counts no run", () => {
    const s = setup();
    const q = (asked: number, answered: number, findings: number, kept: number) => ({
      finderQuestions: { asked, answered, findings, kept, answers: [] },
    });
    s.run({ version: "2.7", started: NOW - DAY, summary: q(3, 1, 1, 1) });
    s.run({ version: "2.7", started: NOW - DAY, summary: q(2, 0, 0, 2) });
    s.run({ version: "2.7", started: NOW - DAY });
    s.run({ version: "2.6", started: NOW - DAY });
    expect(s.row("2.7")).toMatchObject({ runs: 3, questions: { runs: 2, asked: 5, answered: 1, findings: 1, kept: 3 } });
    expect(s.row("2.6").questions).toEqual({ runs: 0, asked: 0, answered: 0, findings: 0, kept: 0 });
  });

  test("the window leaves out older runs", () => {
    const s = seeded();
    expect(s.stats(1).map((r) => [r.promptVersion, r.runs])).toEqual([
      ["2", 1],
      ["1", 1],
    ]);
    expect(s.stats(365).find((r) => r.promptVersion === "1")?.runs).toBe(3);
  });

  test("an empty database gives no rows", () => {
    expect(setup().stats()).toEqual([]);
  });
});

describe("addressed rate of posted findings (AC-R29)", () => {
  test("postOutcome: resolved or changed is addressed; else a new head or a closed PR counts it; else pending", () => {
    const o = (resolved: boolean, changed: boolean, moved: boolean) => postOutcome({ resolved, changed, moved });
    expect(o(true, false, false)).toBe("addressed");
    expect(o(false, true, true)).toBe("addressed");
    expect(o(false, false, true)).toBe("open");
    expect(o(false, false, false)).toBe("pending");
  });

  test("counts per severity from the stored comment, PR head, and PR state", () => {
    const s = setup();
    const r = s.run({ version: "2.5", started: NOW - 2 * DAY });
    const changed = s.finding(r, "posted", { severity: "blocker" });
    const untouched = s.finding(r, "posted", { severity: "major" });
    const resolved = s.finding(r, "posted", { severity: "minor" });
    const outside = s.finding(r, "posted", { severity: "nit" });
    s.finding(r, "accepted", { severity: "major" });
    s.comment(1, { orphanedAt: NOW - DAY + 1 });
    s.comment(2);
    s.comment(3, { resolved: true });
    s.comment(4);
    s.post(r, [changed], 1);
    s.post(r, [untouched], 2);
    s.post(r, [resolved], 3);
    s.post(r, [outside], 4);
    // The PR head is still the run head: only the changed line and the resolved thread count.
    s.db.run("UPDATE pull_request SET source_head = 'h', state = 'OPEN'");
    expect(s.row("2.5").outcomes).toEqual({
      blocker: { addressed: 1, open: 0, pending: 0 },
      major: { addressed: 0, open: 0, pending: 1 },
      minor: { addressed: 1, open: 0, pending: 0 },
      nit: { addressed: 0, open: 0, pending: 1 },
    });
    // A new head that left the anchors of 2 and 4 alone (not orphaned): counted, not addressed.
    s.db.run("UPDATE pull_request SET source_head = 'h2'");
    expect(s.row("2.5").outcomes.major).toEqual({ addressed: 0, open: 1, pending: 0 });
    expect(s.row("2.5").outcomes.nit).toEqual({ addressed: 0, open: 1, pending: 0 });
    // A merged or declined PR counts the rest too.
    s.db.run("UPDATE pull_request SET source_head = 'h', state = 'DECLINED'");
    expect(s.row("2.5").outcomes.major).toEqual({ addressed: 0, open: 1, pending: 0 });
    // An orphaned anchor from before the post is no change after it.
    s.db.run("UPDATE pull_request SET state = 'OPEN'");
    s.db.run(`UPDATE comment SET orphaned_at = ${NOW - DAY - 1} WHERE comment_id = 2`);
    expect(s.row("2.5").outcomes.major).toEqual({ addressed: 0, open: 0, pending: 1 });
  });
});

describe("GET /api/stats/review", () => {
  const app = (db: ReturnType<typeof setup>["db"] | null) =>
    createReviewRoutes({ review: { open: () => db } as unknown as ReviewJobs, live: createLive() });

  test("returns the rows, takes days from 1 to 365, and answers [] without a database", async () => {
    const s = seeded();
    s.db.run(`UPDATE review_run SET started_at = started_at - ${NOW} + ${Date.now()}`);
    const ok = await app(s.db).request("/stats/review");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ReviewStatsDto[]).map((r) => r.promptVersion)).toEqual(["2", "1"]);
    expect((await app(s.db).request("/stats/review?days=365")).status).toBe(200);
    for (const bad of ["0", "366", "1.5", "x"]) expect((await app(s.db).request(`/stats/review?days=${bad}`)).status).toBe(400);
    const none = await app(null).request("/stats/review");
    expect(await none.json()).toEqual([]);
  });
});
