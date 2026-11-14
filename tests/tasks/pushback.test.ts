// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/pushback.md section 6.23 and ps4-plan.md WP-6 (AC-B361, AC-B362, AC-B111): a judging run of the own review
// points, the push-back questions after the gate, Accept, "Fix it anyway", and context/history.md of the next own review. The fake CLI
// gives the verdicts. No test starts the real CLI or reaches a forge.
import { afterEach, describe, expect, test } from "bun:test";
import { REVIEW_HEAD } from "../../src/server/tasks/loop";
import { taskDto } from "../../src/server/tasks/tasks";
import type { FindingPayload } from "../../src/shared/review";
import {
  type Call,
  cleanupAll,
  FIXED,
  KEY,
  NO_COVERAGE,
  point,
  review,
  SLOW,
  type Step,
  setup,
  TEST_FILE,
  TICK,
  WORKS,
} from "./loop-fixture";

for (const m of ["tasks/loop", "tasks/tasks", "review/jobs"])
  console.log(`pushback.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);

const EXTRA = { path: "repo/src/extra.ts", text: "export const extra = 1;\n" };
const onTest = { ...point("major"), path: "tests/feature.test.ts", anchorText: "test('feature works', () => {});", body: "A test point." };
const onExtra = { ...point("blocker"), path: "src/extra.ts", anchorText: "export const extra = 1;", body: "An extra point." };
const FORCED = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const checked = true;\n// Forced.\n" };
const PLAN = { verdict: "pushback" as const, why: "plan", reason: "The plan keeps a fixed value.", cite: "spec/plan.md#Feature" };
const LOST = { verdict: "pushback" as const, why: "already", reason: "The guard handles it.", cite: "src/missing.ts:3" };
const ECHO = { summary: "s", done: true, tests: [], question: null, specChange: "", notes: [], coverage: NO_COVERAGE };

describe("judge the review points (pushback.md section 6.23)", () => {
  test(
    "AC-B361, AC-B362, AC-B111: push-backs give questions after the gate; Accept discards, Fix it anyway commits as pushback; history.md holds the accepted point",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS, EXTRA], ticks: TICK }],
          review: [{ review: review([point("blocker"), onTest, onExtra]) }, { review: review([point("minor")]) }],
          "implement:fix": [
            {
              writes: [FIXED],
              implement: { ...ECHO, points: [{ id: 9999, verdict: "fixed", why: null, reason: "Done.", cite: "" }] },
              pointVerdicts: [PLAN, LOST, null],
            },
            { writes: [FORCED], pointVerdicts: [{ verdict: "pushback", why: "invalid", reason: "Still fine.", cite: "" }] },
          ],
        },
      });
      await s.build();
      const items = s.db
        .query(
          "SELECT id FROM review_item WHERE kind = 'finding' AND run = (SELECT run FROM task_step WHERE item = 'review' AND kind = 'review') ORDER BY id",
        )
        .all() as { id: number }[];
      const [a, b, c] = items.map((x) => x.id) as [number, number, number];
      // AC-B361: the reason question/claude at idle, after the gate and the commit. No second own review starts.
      expect(s.blocked()).toMatchObject({
        kind: "question",
        cause: "claude",
        text: "Needs you: Claude disagrees with 2 review points of part 1. Judge them.",
      });
      expect(s.phases.slice(-4).map((p) => `${p.event}>${p.to}`)).toEqual([
        "GO>reviewing",
        "POINTS>judging",
        "RUN_DONE>checking",
        "CHECKS_GREEN>idle",
      ]);
      expect(s.flow().filter((f) => f.startsWith("review:"))).toEqual(["review:critic:ok", "review:review:ok"]);
      expect(await s.log()).toContain(`Ada Example <ada@example.invalid>|${KEY}: Fix the review points of part 1`);
      // The judging run gets failure.md with the 6.23.3 header and the check lines, and the 6.23.8 lines.
      const judging = s.runCalls().find((x) => x.stdin.includes("- Mode: fix")) as Call;
      expect(judging.context["failure.md"]).toContain(REVIEW_HEAD);
      expect(judging.context["failure.md"]).toContain("- Check: Echo: the code shows candidate");
      expect(judging.context["failure.md"]).toContain("- Evidence: src/feature.ts:1");
      expect(judging.stdin).toContain(
        "./context/failure.md holds review points from a second Claude run. Each point is a claim to check, not an order.",
      );
      // An unknown ID drops with a note; a missing entry gives a note and counts as fixed.
      const fix = s.steps().find((x) => x.kind === "fix" && x.item === "review") as Step;
      expect(JSON.parse(fix.detail_json).notes).toEqual([
        "Claude gave a verdict on point 9999, which failure.md does not hold. The app dropped it.",
        `No verdict for point ${c}.`,
      ]);
      // payload.pushback with citeFound: a plan file counts, a path that is not in the worktree does not.
      const pushback = (id: number) =>
        (
          JSON.parse(
            (s.db.query("SELECT payload_json FROM review_item WHERE id = $id").get({ id }) as { payload_json: string }).payload_json,
          ) as FindingPayload
        ).pushback;
      expect(pushback(a)).toEqual({ step: fix.id, why: "plan", reason: PLAN.reason, cite: PLAN.cite, citeFound: true, fixedBy: null });
      expect(pushback(b)).toMatchObject({ why: "already", citeFound: false });
      expect(pushback(c)).toBeUndefined();
      // One question per push-back, in one round, with point set and no recommended answer.
      const qs = taskDto(s.db, s.t()).questions.filter((q) => q.source === "loop");
      expect(qs.map((q) => [q.point?.id, q.recommended, q.kind, q.step, q.ord, q.options.map((o) => o.label)])).toEqual([
        [a, null, "choice", fix.id, 0, ["Accept the push-back", "Fix it anyway"]],
        [b, null, "choice", fix.id, 1, ["Accept the push-back", "Fix it anyway"]],
      ]);
      expect(new Set(qs.map((q) => q.round)).size).toBe(1);
      expect(qs[0]?.text).toBe(`Review point ${a} (blocker, src/feature.ts:1): A blocker point in the feature.`);
      expect(qs[0]?.why).toBe(`Claude: ${PLAN.reason} Proof: ${PLAN.cite}`);
      expect(qs[1]?.point).toEqual({
        id: b,
        check: expect.stringMatching(/^Echo: the code shows candidate \d+\.$/),
        reason: LOST.reason,
        cite: LOST.cite,
        citeFound: false,
      });
      // AC-B362: the recommended answers, or a note with no choice, give 400.
      const v = () => s.t().version;
      expect(s.loop.answer(s.db, s.task, { version: v(), answers: [], recommended: true })).toEqual({
        status: 400,
        error: "Judge each push-back of Claude first.",
      });
      const noChoice = [
        { question: qs[0]?.id as number, text: "Fine." },
        { question: qs[1]?.id as number, choice: 1 },
      ];
      expect(s.loop.answer(s.db, s.task, { version: v(), answers: noChoice })).toMatchObject({ status: 400 });
      const answers = [
        { question: qs[0]?.id as number, choice: 0 },
        { question: qs[1]?.id as number, choice: 1 },
      ];
      expect(s.loop.answer(s.db, s.task, { version: v(), answers }).status).toBe(202);
      await s.loop.idle(s.task);
      // Accept: discarded by the user with the reason of its why. Fix it anyway: the item stays, and the commit sets fixedBy.
      const row = (id: number) =>
        s.db.query("SELECT status, payload_json FROM review_item WHERE id = $id").get({ id }) as { status: string; payload_json: string };
      const accepted = JSON.parse(row(a).payload_json);
      expect([row(a).status, accepted.discardReason, accepted.discardedBy]).toEqual(["discarded", { code: "intended" }, undefined]);
      expect(row(b).status).not.toBe("discarded");
      const forced = s.steps().find((x) => x.kind === "fix" && x.item === "pushback") as Step;
      expect(JSON.parse(forced.detail_json)).toMatchObject({ findings: [b], notes: [`The user decided to fix point ${b}.`] });
      const commit = s.steps().find((x) => x.kind === "commit" && x.item === "pushback") as Step;
      expect(commit.state).toBe("ok");
      expect(pushback(b)?.fixedBy).toBe(commit.id);
      expect(await s.log()).toContain(`Ada Example <ada@example.invalid>|${KEY}: Fix the chosen review points of part 1`);
      // The forced run reads only its point, and answers.md holds the answers.
      const fixes = s.runCalls().filter((x) => x.stdin.includes("- Mode: fix"));
      const run = fixes.at(-1) as Call;
      expect(run.context["failure.md"]).toContain(`## Point ${b}:`);
      expect(run.context["failure.md"]).not.toContain(`## Point ${a}:`);
      expect(run.context["answers.md"]).toContain("- Answer: Fix it anyway.");
      // AC-B111: the next own review holds history.md with the accepted point, and the finder and verify prompts hold the history lines.
      const reviews = s.runCalls().filter((x) => s.modeOf(x) === "review" && !x.argv.includes("haiku"));
      const next = reviews.at(-1) as Call;
      expect(next.context["history.md"]).toContain(`### Finding ${a}`);
      expect(next.context["history.md"]).toContain("- State: discarded by the user");
      expect(next.context["history.md"]).toContain(`- Why: ${PLAN.reason}`);
      expect(next.context["history.md"]).not.toContain(`### Finding ${b}`);
      expect((reviews[0] as Call).context["history.md"]).toBeUndefined();
      const prompts = (x: Call) =>
        Object.values(x.agents ?? {})
          .map((g) => g.prompt)
          .join("\n");
      expect(prompts(next)).toContain('Do not raise a finding with the state "discarded by the user" again');
      const verify = s
        .runCalls()
        .filter((x) => s.modeOf(x) === "verify")
        .at(-1) as Call;
      expect(prompts(verify)).toContain('A candidate with the state "discarded by the user" in ./context/history.md is refuted');
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
      expect(s.flow().filter((f) => f.startsWith("review:"))).toEqual(["review:critic:ok", "review:review:ok", "review:review:ok"]);
    },
    SLOW,
  );

  test(
    "AC-B362: Accept after a judging run that changed nothing closes the point at the same head; the stored review does not judge it again",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          review: [{ review: review([point("blocker")]) }],
          "implement:fix": [{ pointVerdicts: [PLAN] }],
        },
      });
      await s.build();
      expect(s.blocked()).toMatchObject({ kind: "question", cause: "claude" });
      expect(s.flow().filter((f) => f.startsWith("commit:review"))).toEqual([]);
      const q = taskDto(s.db, s.t()).questions.find((x) => x.source === "loop" && x.answer === null);
      expect(s.loop.answer(s.db, s.task, { version: s.t().version, answers: [{ question: q?.id as number, choice: 0 }] }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.flow().filter((f) => f.startsWith("review:review") || f.startsWith("fix:review"))).toEqual([
        "review:review:ok",
        "fix:review:ok",
      ]);
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
    },
    SLOW,
  );
});
