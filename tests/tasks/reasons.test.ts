// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/part-session.md section 9.4 (package PS3, AC-B297, AC-B305): the reason exits that PS3 owns, seeded in
// implementing (I) and in ready (R). Continue clears a reason of a run end, a restart, or an old kind, and starts the right driver.
// Continue on a form reason answers 409 with its text. ps4-plan.md WP-3 adds the exits in ready (AC-B344). WP-4 adds held and the usage
// arm. The fake CLI only.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertStep, patchStep } from "../../src/server/tasks/implement";
import type { Phase } from "../../src/server/tasks/machine";
import { setupMark } from "../../src/server/tasks/worktree";
import type { TaskBlocked } from "../../src/shared/task";
import { cleanupAll, FIXED, point, SLOW, setup, TEST_FILE, TICK, WORKS } from "./loop-fixture";

for (const m of ["tasks/loop", "tasks/tasks"])
  console.log(`reasons.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);

type S = Awaited<ReturnType<typeof setup>>;
// A reason written as the loop writes it: a version move with it.
const seed = (s: S, b: TaskBlocked | null) =>
  s.db.query("UPDATE task SET blocked_json = $b, version = version + 1 WHERE id = $id").run({ id: s.task, b: b && JSON.stringify(b) });
const partRow = (s: S, state: string) =>
  (
    s.db
      .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
        VALUES ($t, 1, 'single', 'Add the feature', 'feature/K-1-add-the-feature', 'main', $state, 1, 1) RETURNING id`)
      .get({ t: s.task, state }) as { id: number }
  ).id;

describe("reason exits in implementing", () => {
  test(
    "AC-B297, AC-B305: Continue clears each reason of a run end, a restart, and an old kind, and a build driver starts; form reasons answer 409",
    async () => {
      const s = await setup();
      const part = partRow(s, "implementing");
      const row = insertStep(s.db, { task: s.task, part, kind: "implement", item: "build", state: "failed" });
      const reasons: TaskBlocked[] = [
        { kind: "error", cause: "run", step: row, text: "Needs you: the run of part 1 failed. The run failed." },
        {
          kind: "error",
          cause: "restart",
          step: row,
          text: "Needs you: the app stopped during the work on part 1. Continue goes on from there.",
        },
        {
          kind: "error",
          cause: "restart",
          step: null,
          part,
          text: "Needs you: the app stopped during the work on part 1. Continue goes on from there.",
        },
        { kind: "stuck", cause: "stall", step: row, text: "Needs you: Claude sent nothing for 15 minutes, so the app stopped the run." },
        { kind: "stuck", cause: "loop", step: row, text: "Needs you: Claude made the same call 5 times with the same result." },
        { kind: "stuck", cause: "turns", step: row, text: "Needs you: the runs of part 1 reached their turn cap twice." },
        { kind: "unfinished", step: row, text: "Needs you: Claude ended the run before part 1 was done." },
        { kind: "usage", step: row, text: "Needs you: your Claude usage limit is reached. Continue runs the step again." },
        // part-session.md section 5.4: the kinds that the app sets no more.
        { kind: "budget", step: null, text: "Needs you: part 1 used its 120 min. Continue with 60 more min?" },
        { kind: "size", step: null, text: "Needs you: this PR would have 520 changed lines, over your 400 limit." },
        { kind: "push", step: null, text: "Needs you: push the part." },
        { kind: "question", step: null, text: "Task T1.1 is done. Continue?" },
      ];
      for (const b of reasons) {
        seed(s, b);
        const r = s.loop.resume(s.db, s.task, { version: s.t().version });
        expect([b.kind, b.cause, r.status]).toEqual([b.kind, b.cause, 200]);
        expect(s.blocked()).toBeNull();
        expect(s.loop.running(s.task)).toBe(true);
        // The driver goes no further in this test: Stop ends it, and the next reason comes on a building task.
        expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
        await s.loop.idle(s.task);
        s.db.query("UPDATE task SET state = 'implementing', stopped_from = NULL, blocked_json = NULL WHERE id = $id").run({ id: s.task });
      }
      // Form reasons: their own action comes first.
      const forms: [TaskBlocked, string][] = [
        [
          { kind: "spec_change", step: row, text: "Needs you: Claude proposes a change to the spec." },
          "Accept or reject the change to the spec first.",
        ],
        [{ kind: "allow", step: row, text: "Needs you: Claude asks to allow a command." }, "Pick a choice for each command first."],
        [{ kind: "slot", step: row, text: "Waiting for a free run slot." }, "The build waits for the run slot. It goes on by itself."],
      ];
      for (const [b, error] of forms) {
        seed(s, b);
        expect(s.loop.resume(s.db, s.task, { version: s.t().version })).toMatchObject({ status: 409, error });
        expect(s.loop.running(s.task)).toBe(false);
      }
      s.db
        .query(
          `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, step, asked_at)
          VALUES ($t, 'loop', 1, 0, 'Which name?', 'Two fit.', 'text', '[]', $step, 1)`,
        )
        .run({ t: s.task, step: row });
      seed(s, { kind: "question", step: row, text: "Needs you: Claude asks: Which name?" });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version })).toMatchObject({ status: 409, error: "Answer the question first." });
    },
    SLOW,
  );
});

describe("reason exits in ready", () => {
  // ps4-plan.md AC-B344, part-session.md section 9.4 column "Continue does": each reason of a built part in ready, with the phase that GO
  // picks first. following: the reason names a send that did not finish, so the send runs again. checking: the gate runs on the kept
  // work. setup: setup runs again. reviewing: one more judging round with the stored points. null: no phase has work, or the reason
  // names no part (preflight), and the reason clears.
  test(
    "AC-B297, AC-B344: Continue in ready answers 200 for each reason of a built part and runs the right phase; form reasons answer 409",
    async () => {
      // A built part with its plan commit, as a part with an open PR has.
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          "implement:instruct": [{ writes: [] }],
          "implement:fix": [{ writes: [FIXED] }],
        },
      });
      await s.build();
      const part = s.part().id;
      s.db.query("UPDATE task_part SET state = 'pr_open' WHERE id = $id").run({ id: part });
      s.db.query("UPDATE task SET state = 'ready' WHERE id = $id").run({ id: s.task });
      const send = insertStep(s.db, { task: s.task, part, kind: "instruct", item: "I1", state: "failed" });
      patchStep(s.db, send, { instruct: { text: "Rename the flag.", part, blockedBefore: null, result: null, committed: false } });
      // The step of a gate reason is the red gate row of its case, set in the loop.
      const GATE = 1;
      const setupRow = insertStep(s.db, { task: s.task, part, kind: "check", item: "setup", state: "failed" });
      const n = { text: "Needs you: x." };
      const cases: [TaskBlocked, Phase | null][] = [
        [{ kind: "error", cause: "run", step: send, ...n }, "following"],
        [{ kind: "error", cause: "restart", step: send, ...n }, "following"],
        [{ kind: "stuck", cause: "stall", step: send, ...n }, "following"],
        [{ kind: "stuck", cause: "loop", step: send, ...n }, "following"],
        [{ kind: "stuck", cause: "turns", step: send, ...n }, "following"],
        [{ kind: "stuck", cause: "time", step: send, ...n }, "following"],
        [{ kind: "unfinished", step: send, ...n }, "following"],
        [{ kind: "usage", step: send, ...n }, "following"],
        [{ kind: "denied_path", cause: "path", step: send, ...n }, "following"],
        [{ kind: "denied_path", cause: "git_state", step: send, ...n }, "following"],
        [{ kind: "question", cause: "red_before", step: GATE, ...n }, "checking"],
        [{ kind: "question", cause: "no_change", step: GATE, ...n }, "checking"],
        [{ kind: "red", cause: "checks", step: GATE, ...n }, "checking"],
        [{ kind: "red", cause: "update", step: GATE, ...n }, "checking"],
        [{ kind: "denied_path", cause: "commit", step: null, part, ...n }, "checking"],
        [{ kind: "red", cause: "setup", step: setupRow, ...n }, "setup"],
        [{ kind: "red", cause: "setup_time", step: setupRow, ...n }, "setup"],
        // The step is the newest own review, set in the loop.
        [{ kind: "blocker", step: send, ...n }, "reviewing"],
        [{ kind: "error", cause: "restart", step: null, part, ...n }, null],
        [{ kind: "error", cause: "app", step: null, part, ...n }, null],
        [{ kind: "preflight", step: null, ...n }, null],
      ];
      const w = await s.wt();
      for (const [k, [given, phase]] of cases.entries()) {
        let b = given;
        // The kept work of a red gate: a gate row with no green HEAD is the newest one. A stale setup mark.
        if (phase === "checking") {
          writeFileSync(join(w.repo, "src", "feature.ts"), `export const feature = 'works';\n// ${k}\n`);
          const gate = insertStep(s.db, { task: s.task, part, kind: "check", item: "I1", state: "failed" });
          if (b.step !== null) b = { ...b, step: gate };
        }
        if (phase === "setup") rmSync(setupMark(w), { force: true });
        // The stored points of the newest own review hold a confirmed major point.
        if (phase === "reviewing") {
          const own = s
            .steps()
            .filter((x) => x.kind === "review")
            .at(-1) as { id: number; run: number };
          s.db
            .query("INSERT INTO review_item (run, kind, payload_json, body) VALUES ($run, 'finding', $p, 'b')")
            .run({ run: own.run, p: JSON.stringify({ ...point("major"), verify: { verdict: "confirmed" } }) });
          b = { ...b, step: own.id };
        }
        seed(s, b);
        const at = s.phases.length;
        const r = s.loop.resume(s.db, s.task, { version: s.t().version });
        expect([b.kind, b.cause, r.status]).toEqual([b.kind, b.cause, 200]);
        await s.loop.idle(s.task);
        const first = s.phases.slice(at).find((p) => p.event === "GO")?.to ?? null;
        expect([b.kind, b.cause, first]).toEqual([b.kind, b.cause, phase]);
        expect([b.kind, b.cause, s.t().state, s.blocked(), s.part().state]).toEqual([b.kind, b.cause, "ready", null, "pr_open"]);
        if (phase === "following") {
          const last = s
            .steps()
            .filter((x) => x.kind === "instruct")
            .at(-1) as { item: string; detail_json: string };
          expect([last.item, JSON.parse(last.detail_json).instruct]).toEqual(["I1", expect.objectContaining({ text: "Rename the flag." })]);
        }
      }
      expect(s.runCalls().filter((c) => s.modeOf(c) === "instruct")).toHaveLength(cases.filter(([, p]) => p === "following").length);
      // Form reasons: their own action comes first. The update runs again only through its route until WP-5.
      s.db
        .query(
          `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, step, asked_at)
          VALUES ($t, 'loop', 1, 0, 'Which name?', 'Two fit.', 'text', '[]', $step, 1)`,
        )
        .run({ t: s.task, step: send });
      const forms: [TaskBlocked, string][] = [
        [{ kind: "question", cause: "claude", step: send, ...n }, "Answer the question first."],
        [{ kind: "spec_change", step: send, ...n }, "Accept or reject the change to the spec first."],
        [{ kind: "allow", step: send, ...n }, "Pick a choice for each command first."],
        [{ kind: "slot", step: send, ...n }, "The build waits for the run slot. It goes on by itself."],
        [{ kind: "update", step: send, ...n }, "All PRs of the task are open."],
      ];
      for (const [b, error] of forms) {
        seed(s, b);
        expect(s.loop.resume(s.db, s.task, { version: s.t().version })).toMatchObject({ status: 409, error });
        expect(s.loop.running(s.task)).toBe(false);
      }
    },
    SLOW * 2,
  );
});
