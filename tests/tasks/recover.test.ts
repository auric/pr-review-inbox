// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/part-session.md section 9.5 (Q-SM2, package PS3, AC-B297): the restart recovery of each state. recoverTasks ends
// each open step row. A task that builds or follows up keeps its state and gets a reason per cut part; held and waiting part rows stay.
// Then Continue reaches the phase that GO picks. A temp database and the fake CLI only.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/storage/db";
import { RESTART_TEXT, recoverTasks, setUsageArmed, TASK_CHANGED, taskRow, UPDATE_RESTART } from "../../src/server/tasks/tasks";
import { type TaskBlocked, taskBlocked } from "../../src/shared/task";
import { cleanupAll, SLOW, stopInGate } from "./loop-fixture";

for (const m of ["tasks/tasks", "tasks/loop", "storage/db"])
  console.log(`recover.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);

describe("restart per state (part-session.md section 9.5)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-recover-"));
  const db: Database = openDb(join(dir, "tasks.sqlite"));
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  let n = 0;
  const task = (state: string, blocked: TaskBlocked | null = null) =>
    (
      db
        .query(`INSERT INTO task (project, repo, key, title, state, size, target_branch, spec_dir, blocked_json, created_at, updated_at)
          VALUES ('P', 'r', $key, 'T', $state, 'small', 'main', 'specs/K/', $b, 1, 1) RETURNING id`)
        .get({ key: `R-${++n}`, state, b: blocked && JSON.stringify(blocked) }) as { id: number }
    ).id;
  const part = (t: number, ord: number, state: string, blocked: TaskBlocked | null = null) =>
    (
      db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, blocked_json, created_at, updated_at)
          VALUES ($t, $ord, 'part', 'P', $b, 'main', $s, $j, 1, 1) RETURNING id`)
        .get({ t, ord, b: `feature/R-${t}-${ord}`, s: state, j: blocked && JSON.stringify(blocked) }) as { id: number }
    ).id;
  const run = (t: number) =>
    (
      db
        .query(`INSERT INTO review_run (task, kind, profile, note, idem_key, source_head, target_head, status, started_at)
          VALUES ($t, 'implement', 'general', '', $k, '', '', 'running', 1) RETURNING id`)
        .get({ t, k: `run-${t}-${Math.random()}` }) as { id: number }
    ).id;
  const step = (t: number, p: number | null, kind: string, state: string, o: { run?: number; detail?: unknown } = {}) =>
    (
      db
        .query(`INSERT INTO task_step (task, part, kind, run, state, ord, detail_json, started_at)
          VALUES ($t, $p, $kind, $run, $state, 1, $d, 1) RETURNING id`)
        .get({ t, p, kind, run: o.run ?? null, state, d: JSON.stringify(o.detail ?? {}) }) as { id: number }
    ).id;
  const blockedOf = (t: number) => {
    const b = taskRow(db, t)?.blocked_json;
    return b ? (JSON.parse(b) as TaskBlocked) : null;
  };
  const rowOf = (p: number) => {
    const r = db.query("SELECT blocked_json FROM task_part WHERE id = $id").get({ id: p }) as { blocked_json: string | null };
    return r.blocked_json && (JSON.parse(r.blocked_json) as TaskBlocked);
  };
  const stateOf = (id: number) => (db.query("SELECT state FROM task_step WHERE id = $id").get({ id }) as { state: string }).state;

  test("AC-B297: each state of section 9.5 takes its target; no waiting part row is lost", () => {
    // interview with a run: the step fails, and the task stops, so Resume runs it again.
    const iv = task("interview");
    const ivStep = step(iv, null, "interview", "running", { run: run(iv) });
    // implementing, phase not idle: a running build run of part 1. Part 2 holds a waiting reason, which stays.
    const waiting: TaskBlocked = { kind: "question", step: 999, text: "Needs you: Claude asks: Which name?" };
    const busy = task("implementing");
    const p1 = part(busy, 1, "implementing");
    const p2 = part(busy, 2, "implementing", waiting);
    const busyStep = step(busy, p1, "implement", "running", { run: run(busy) });
    // implementing, a part that builds between two steps.
    const between = task("implementing");
    const bp = part(between, 1, "implementing");
    // implementing, a slot wait: the soft reason gives way to error/restart.
    const slot = task("implementing");
    const sp = part(slot, 1, "implementing");
    const slotStep = step(slot, sp, "fix", "waiting");
    db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({
      id: slot,
      b: JSON.stringify({ kind: "slot", step: slotStep, text: "Waiting for a free run slot." }),
    });
    // implementing, a reason and no open step: kept.
    const red: TaskBlocked = { kind: "red", cause: "checks", step: 5, text: "Needs you: the checks of part 1 stay red after 3 tries." };
    const kept = task("implementing", red);
    part(kept, 1, "implementing");
    // updating: the reason update instead of STOP, and the update row takes the restart mark for loop.recover.
    const upd = task("ready");
    const up = part(upd, 1, "pr_open");
    const updStep = step(upd, up, "update", "running", { detail: { update: { repos: [], preHeads: [] } } });
    // ready, following: a send on a built part.
    const fol = task("ready");
    const fp = part(fol, 1, "pr_open");
    const folStep = step(fol, fp, "instruct", "running", { run: run(fol) });
    // PR states, idle; stopped; done: nothing changes.
    const idle = task("ready");
    part(idle, 1, "pr_open");
    const stopped = task("stopped", red);
    const done = task("done");
    const versions = new Map([idle, stopped, done, kept].map((t) => [t, taskRow(db, t)?.version]));

    recoverTasks(db, 50);

    expect([taskRow(db, iv)?.state, stateOf(ivStep)]).toEqual(["stopped", "failed"]);
    expect([taskRow(db, busy)?.state, taskRow(db, busy)?.stopped_from, stateOf(busyStep)]).toEqual(["implementing", null, "failed"]);
    expect(blockedOf(busy)).toEqual({ kind: "error", cause: "restart", step: busyStep, text: RESTART_TEXT(1) });
    expect(rowOf(p2)).toEqual(waiting);
    expect(blockedOf(between)).toEqual({ kind: "error", cause: "restart", step: null, part: bp, text: RESTART_TEXT(1) });
    expect([stateOf(slotStep), blockedOf(slot)]).toEqual([
      "failed",
      { kind: "error", cause: "restart", step: slotStep, text: RESTART_TEXT(1) },
    ]);
    expect(blockedOf(kept)).toEqual(red);
    expect([taskRow(db, upd)?.state, blockedOf(upd)]).toEqual(["ready", { kind: "update", step: updStep, text: UPDATE_RESTART }]);
    const ud = JSON.parse(
      (db.query("SELECT detail_json FROM task_step WHERE id = $id").get({ id: updStep }) as { detail_json: string }).detail_json,
    );
    expect(ud.update.result).toBe("restart");
    expect([taskRow(db, fol)?.state, blockedOf(fol)]).toEqual([
      "ready",
      { kind: "error", cause: "restart", step: folStep, text: RESTART_TEXT(1) },
    ]);
    for (const [t, v] of versions) expect([t, taskRow(db, t)?.version]).toEqual([t, v]);
    expect(taskRow(db, stopped)?.state).toBe("stopped");
    expect(taskRow(db, done)?.state).toBe("done");
    // A second part of the cut task that has its own open row gets its reason in its part row (spec.md section 6.25.3).
    const two = task("implementing");
    const a = part(two, 1, "implementing");
    const b = part(two, 2, "implementing");
    const sa = step(two, a, "implement", "running", { run: run(two) });
    const sb = step(two, b, "implement", "running", { run: run(two) });
    recoverTasks(db, 60);
    expect(blockedOf(two)).toMatchObject({ kind: "error", cause: "restart", step: sa });
    expect(rowOf(b)).toMatchObject({ kind: "error", cause: "restart", step: sb, text: RESTART_TEXT(2) });
  });

  test("AC-B337: a held part row stays; a task with only held parts keeps its version; a held part gets no restart reason", () => {
    const held: TaskBlocked = { kind: "held", step: null, text: "Needs you: part 1 is on hold." };
    const only = task("implementing");
    const h = part(only, 1, "implementing", held);
    // The held part comes first by ord, so a restart reason for it would take the first place.
    const mixed = task("implementing");
    const m1 = part(mixed, 1, "implementing", held);
    const m2 = part(mixed, 2, "implementing");
    const v = taskRow(db, only)?.version;

    recoverTasks(db, 70);

    expect([taskRow(db, only)?.version, blockedOf(only), rowOf(h)]).toEqual([v, null, held]);
    expect([blockedOf(mixed), rowOf(m1), rowOf(m2)]).toEqual([
      { kind: "error", cause: "restart", step: null, part: m2, text: RESTART_TEXT(2) },
      held,
      null,
    ]);
  });

  test("AC-B339: one arm or disarm sets armed on every usage reason with one version move; a restart keeps it", () => {
    const usage = (step: number): TaskBlocked => ({ kind: "usage", step, text: "Needs you: the usage limit.", resumeAt: 9_000 });
    const red: TaskBlocked = { kind: "red", cause: "checks", step: 3, text: "Needs you: red." };
    const t = task("implementing", usage(1));
    const [p1, p2, p3] = [part(t, 1, "implementing"), part(t, 2, "implementing", usage(2)), part(t, 3, "implementing", red)];
    const v = taskRow(db, t)?.version as number;
    expect(setUsageArmed(db, { task: t, version: v }, true, 80)).toBe(v + 1);
    expect([taskRow(db, t)?.version, blockedOf(t), rowOf(p1), rowOf(p2), rowOf(p3)]).toEqual([
      v + 1,
      { ...usage(1), armed: true },
      null,
      { ...usage(2), armed: true },
      red,
    ]);
    // The stored JSON keeps a boolean, so the reason still parses.
    expect(taskBlocked.parse(blockedOf(t)).armed).toBe(true);
    recoverTasks(db, 90);
    const armed = { ...usage(2), armed: true };
    expect([taskRow(db, t)?.version, blockedOf(t)?.armed, rowOf(p2)]).toEqual([v + 1, true, armed]);
    // A stale version changes nothing. Disarm needs no usage reason first: a red first reason stays as it is.
    expect(() => setUsageArmed(db, { task: t, version: v }, false, 95)).toThrow(TASK_CHANGED);
    expect(rowOf(p2)).toEqual(armed);
    db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ id: t, b: JSON.stringify(red) });
    expect(setUsageArmed(db, { task: t, version: v + 1 }, false, 100)).toBe(v + 2);
    expect([blockedOf(t), rowOf(p2)]).toEqual([red, { ...usage(2), armed: false }]);
  });
});

describe("Continue after a restart (part-session.md section 9.5)", () => {
  test(
    "AC-B297: a restart during the gate gives error/restart; Continue runs GO, which picks the checks of the kept work",
    async () => {
      const { s } = await stopInGate();
      // The app stopped while the checks of the gate ran.
      const check = s.steps().at(-1) as { id: number; kind: string };
      expect(check.kind).toBe("check");
      s.db.query("UPDATE task_step SET state = 'running', ended_at = NULL WHERE id = $id").run({ id: check.id });
      s.db.query("UPDATE task SET state = 'implementing', stopped_from = NULL").run();
      recoverTasks(s.db, Date.now(), s.dataDir);
      expect([s.t().state, s.blocked()]).toEqual([
        "implementing",
        { kind: "error", cause: "restart", step: check.id, text: RESTART_TEXT(1) },
      ]);
      s.mode("green");
      const before = s.phases.length;
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      expect(s.phases.slice(before).map((p) => `${p.event}>${p.to}`)[0]).toBe("GO>checking");
      // No build run starts again: the kept work holds every tick.
      expect(s.steps().filter((x) => x.kind === "implement")).toHaveLength(1);
    },
    SLOW,
  );
});
