// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.10, 6.20.7, and 6.20.11 (WP-ST5, AC-B84): the part gate from the synced PR rows, the part
// events of the sync, LAST_PR_OPEN and ALL_MERGED, and the start rule of the loop. SQLite only: no forge, no Jira, no CLI.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/storage/db";
import { partGate, startable, syncParts } from "../../src/server/tasks/gates";
import { taskDto, taskRow } from "../../src/server/tasks/tasks";

for (const m of ["tasks/gates", "tasks/tasks"])
  console.log(`gates.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const ZERO = { successful: 0, inProgress: 0, failed: 0, cancelled: 0, unknown: 0 };

const dir = mkdtempSync(join(tmpdir(), "rl-gates-"));
const db: Database = openDb(join(dir, "gates.sqlite"));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

let prSeq = 0;
// A followed PR of PROJ/repo. reviewers: [name, status] pairs.
function pr(state: string, reviewers: [string, string][] = [], head = HEAD): number {
  prSeq++;
  const json = JSON.stringify(reviewers.map(([name, status]) => ({ slug: name.toLowerCase(), name, login: null, status })));
  return (
    db
      .query(`INSERT INTO pull_request (project, repo, pr_id, title, source_branch, target_branch, state, source_head, reviewers_json)
        VALUES ('PROJ', 'repo', $n, 'x', $branch, 'main', $state, $head, $json) RETURNING id`)
      .get({ n: prSeq, branch: `feature/ABC-${prSeq}-x`, state, head, json }) as { id: number }
  ).id;
}
const build = (id: number, counts: Partial<typeof ZERO>, head = HEAD) =>
  db
    .query("INSERT OR REPLACE INTO pr_build (pr, head, stats_json, builds_json, read_at) VALUES ($pr, $head, $stats, NULL, 1)")
    .run({ pr: id, head, stats: JSON.stringify({ ...ZERO, ...counts }) });

// A task with sub-tasks in state implementing, and one part per entry. after: the index of the lower part in the list.
function task(parts: { state: string; pr?: number | null; start?: string; after?: number }[], o: { approvals?: number } = {}) {
  const id = (
    db
      .query(`INSERT INTO task (project, repo, key, title, state, size, target_branch, spec_dir, settings_json, subtasks, created_at,
          updated_at)
        VALUES ('PROJ', 'repo', $key, 'T', 'implementing', 'small', 'main', 'specs/K/', $settings, 1, 1, 1) RETURNING id`)
      .get({ key: `ABC-${1000 + prSeq++}`, settings: JSON.stringify(o.approvals === undefined ? {} : { approvals: o.approvals }) }) as {
      id: number;
    }
  ).id;
  const ids: number[] = [];
  parts.forEach((p, i) => {
    const row = db
      .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, pr, state, keys_json, start_mode, after_part,
          created_at, updated_at)
        VALUES ($task, $ord, 'single', 'P', $branch, 'main', $pr, $state, $keys, $start, $after, 1, 1) RETURNING id`)
      .get({
        task: id,
        ord: i + 1,
        branch: `feature/ABC-${i + 11}-p`,
        pr: p.pr ?? null,
        state: p.state,
        keys: JSON.stringify([`ABC-${i + 11}`]),
        start: p.start ?? "base",
        after: p.after === undefined ? null : (ids[p.after] as number),
      }) as { id: number };
    ids.push(row.id);
  });
  return { id, parts: ids };
}
const stateOf = (part: number) => (db.query("SELECT state FROM task_part WHERE id = $part").get({ part }) as { state: string }).state;

describe("partGate (spec.md sections 6.10 and 6.20.11, AC-B84)", () => {
  test("approvals, NEEDS_WORK, and the build counts of the newest head", () => {
    const one = pr("OPEN", [["Anna", "APPROVED"]]);
    build(one, { successful: 2 });
    expect(partGate(db, { pr: one }, 1)).toEqual({ pass: true, why: "Approved. The builds passed." });
    expect(partGate(db, { pr: one }, 2)).toEqual({ pass: false, why: "Waits for approvals: 1 of 2." });

    // NEEDS_WORK blocks the gate, whatever the approvals say.
    const asks = pr("OPEN", [
      ["Anna", "APPROVED"],
      ["Ben", "NEEDS_WORK"],
    ]);
    build(asks, {});
    expect(partGate(db, { pr: asks }, 1)).toEqual({ pass: false, why: "Ben asks for changes." });

    const failed = pr("OPEN", [["Anna", "APPROVED"]]);
    build(failed, { successful: 1, failed: 1 });
    expect(partGate(db, { pr: failed }, 1)).toEqual({ pass: false, why: "A build failed." });
    const running = pr("OPEN", [["Anna", "APPROVED"]]);
    build(running, { successful: 1, inProgress: 1 });
    expect(partGate(db, { pr: running }, 1)).toEqual({ pass: false, why: "A build runs." });
  });

  test("no build statuses count as green; a read of an older head or no read counts as not read", () => {
    const none = pr("OPEN", [["Anna", "APPROVED"]]);
    build(none, {});
    expect(partGate(db, { pr: none }, 1)).toEqual({ pass: true, why: "Approved. No builds reported." });
    const old = pr("OPEN", [["Anna", "APPROVED"]]);
    build(old, { successful: 1 }, OLD);
    expect(partGate(db, { pr: old }, 1)?.pass).toBe(false);
    const unread = pr("OPEN", [["Anna", "APPROVED"]]);
    expect(partGate(db, { pr: unread }, 1)).toEqual({ pass: false, why: "The app has not read the builds of the newest commit yet." });
  });

  test("no gate result without an open PR", () => {
    expect(partGate(db, { pr: null }, 1)).toBeNull();
    const merged = pr("MERGED", [["Anna", "APPROVED"]]);
    expect(partGate(db, { pr: merged }, 1)).toBeNull();
  });

  test("the part DTO carries the gate, and the task settings set the approvals", () => {
    const open = pr("OPEN", [["Anna", "APPROVED"]]);
    build(open, {});
    const t = task([{ state: "pr_open", pr: open }, { state: "planned" }], { approvals: 2 });
    const dto = taskDto(db, taskRow(db, t.id) as NonNullable<ReturnType<typeof taskRow>>);
    expect(dto.parts.map((p) => p.gate)).toEqual([{ pass: false, why: "Waits for approvals: 1 of 2." }, null]);
  });
});

describe("syncParts (spec.md sections 6.20.7 and 6.20.11)", () => {
  test("GATE_PASSED, CHANGES_REQUESTED, and GATE_PASSED again after the reviewer approves", () => {
    const p = pr("OPEN", [["Anna", "APPROVED"]]);
    build(p, {});
    const t = task([
      { state: "pr_open", pr: p },
      { state: "planned", start: "stack", after: 0 },
    ]);
    expect(syncParts(db, [p], 5)).toEqual([t.id]);
    expect(stateOf(t.parts[0] as number)).toBe("approved");
    // Nothing changed: no event, no task change.
    expect(syncParts(db, [p], 6)).toEqual([]);

    db.query("UPDATE pull_request SET reviewers_json = $json WHERE id = $id").run({
      id: p,
      json: JSON.stringify([{ slug: "anna", name: "Anna", login: null, status: "NEEDS_WORK" }]),
    });
    expect(syncParts(db, [p], 7)).toEqual([t.id]);
    expect(stateOf(t.parts[0] as number)).toBe("changes_requested");
    db.query("UPDATE pull_request SET reviewers_json = $json WHERE id = $id").run({
      id: p,
      json: JSON.stringify([{ slug: "anna", name: "Anna", login: null, status: "APPROVED" }]),
    });
    expect(syncParts(db, [p], 8)).toEqual([t.id]);
    expect(stateOf(t.parts[0] as number)).toBe("approved");
  });

  test("an approved part whose gate fails later goes back to pr_open, and the part on top of it waits again", () => {
    const anna = (status: string) => JSON.stringify([{ slug: "anna", name: "Anna", login: null, status }]);
    const p = pr("OPEN", [["Anna", "APPROVED"]]);
    build(p, {});
    const t = task([
      { state: "pr_open", pr: p },
      { state: "planned", start: "stack", after: 0 },
    ]);
    const lower = t.parts[0] as number;
    const dto = () => taskDto(db, taskRow(db, t.id) as NonNullable<ReturnType<typeof taskRow>>);
    expect(syncParts(db, [p], 5)).toEqual([t.id]);
    expect(stateOf(lower)).toBe("approved");
    expect(startable(db, t.id)).toBe(true);

    // The reviewer removes the approval.
    db.query("UPDATE pull_request SET reviewers_json = $json WHERE id = $id").run({ id: p, json: anna("UNAPPROVED") });
    expect(syncParts(db, [p], 6)).toEqual([t.id]);
    expect(stateOf(lower)).toBe("pr_open");
    expect(startable(db, t.id)).toBe(false);
    expect(dto().parts[1]?.wait).toBe(`Waits for a review of ${dto().parts[0]?.keys[0]}.`);

    // A failed build.
    db.query("UPDATE pull_request SET reviewers_json = $json WHERE id = $id").run({ id: p, json: anna("APPROVED") });
    expect(syncParts(db, [p], 7)).toEqual([t.id]);
    expect(stateOf(lower)).toBe("approved");
    build(p, { failed: 1 });
    expect(syncParts(db, [p], 8)).toEqual([t.id]);
    expect(stateOf(lower)).toBe("pr_open");

    // A new commit whose builds the app has not read yet.
    build(p, {});
    expect(syncParts(db, [p], 9)).toEqual([t.id]);
    db.query("UPDATE pull_request SET source_head = $head WHERE id = $id").run({ id: p, head: OLD });
    expect(syncParts(db, [p], 10)).toEqual([t.id]);
    expect(stateOf(lower)).toBe("pr_open");
    // A failed gate of a pr_open part changes nothing.
    expect(syncParts(db, [p], 11)).toEqual([]);
  });

  test("a failed gate sends no event; a PR that is not in the list is not read", () => {
    const p = pr("OPEN", []);
    build(p, {});
    const t = task([{ state: "pr_open", pr: p }]);
    expect(syncParts(db, [p], 5)).toEqual([]);
    expect(stateOf(t.parts[0] as number)).toBe("pr_open");
    const other = pr("MERGED");
    const u = task([{ state: "pr_open", pr: other }]);
    expect(syncParts(db, [p], 6)).toEqual([]);
    expect(stateOf(u.parts[0] as number)).toBe("pr_open");
    expect(syncParts(db, [], 7)).toEqual([]);
  });

  test("MERGED and DECLINED; ALL_MERGED when every part merged or was dropped", () => {
    const a = pr("MERGED");
    const b = pr("DECLINED");
    const t = task([
      { state: "approved", pr: a },
      { state: "pr_open", pr: b },
    ]);
    db.query("UPDATE task SET state = 'ready' WHERE id = $id").run({ id: t.id });
    expect(syncParts(db, [a, b], 5)).toEqual([t.id]);
    expect([stateOf(t.parts[0] as number), stateOf(t.parts[1] as number)]).toEqual(["merged", "declined"]);
    expect(taskRow(db, t.id)?.state).toBe("ready");

    const c = pr("MERGED");
    const u = task([{ state: "pr_open", pr: c }, { state: "abandoned" }]);
    db.query("UPDATE task SET state = 'ready' WHERE id = $id").run({ id: u.id });
    expect(syncParts(db, [c], 6)).toEqual([u.id]);
    expect(taskRow(db, u.id)?.state).toBe("done");
  });

  test("LAST_PR_OPEN only when no part waits for its PR; a done task gets no event", () => {
    const a = pr("MERGED");
    const t = task([{ state: "pr_open", pr: a }, { state: "planned" }]);
    expect(syncParts(db, [a], 5)).toEqual([t.id]);
    expect(taskRow(db, t.id)?.state).toBe("implementing");

    const b = pr("MERGED");
    const c = pr("OPEN");
    const u = task([
      { state: "pr_open", pr: b },
      { state: "pr_open", pr: c },
    ]);
    expect(syncParts(db, [b], 6)).toEqual([u.id]);
    expect(taskRow(db, u.id)?.state).toBe("ready");

    const d = pr("MERGED");
    const v = task([{ state: "pr_open", pr: d }]);
    db.query("UPDATE task SET state = 'done' WHERE id = $id").run({ id: v.id });
    expect(syncParts(db, [d], 7)).toEqual([]);
    expect(stateOf(v.parts[0] as number)).toBe("pr_open");
  });
});

describe("startable: the sync kicks the loop only for a task with a startable part (AC-B84)", () => {
  test("a part on top of a lower part starts after the gate passed, never before", () => {
    const p = pr("OPEN", [["Anna", "APPROVED"]]);
    const t = task([
      { state: "pr_open", pr: p },
      { state: "planned", start: "stack", after: 0 },
    ]);
    expect(startable(db, t.id)).toBe(false);
    build(p, {});
    syncParts(db, [p], 5);
    expect(startable(db, t.id)).toBe(true);
  });

  test("no kick while a part builds, at the limit, for a blocked task, or for a task in another state", () => {
    expect(startable(db, task([{ state: "implementing" }, { state: "planned" }]).id)).toBe(false);
    const open = Array.from({ length: 3 }, () => ({ state: "pr_open", pr: pr("OPEN") }));
    expect(startable(db, task([...open, { state: "planned" }]).id)).toBe(false);
    const blocked = task([{ state: "planned" }]);
    expect(startable(db, blocked.id)).toBe(true);
    db.query(`UPDATE task SET blocked_json = '{"kind":"needs_you","text":"x"}' WHERE id = $id`).run({ id: blocked.id });
    expect(startable(db, blocked.id)).toBe(false);
    const ready = task([{ state: "planned" }]);
    db.query("UPDATE task SET state = 'ready' WHERE id = $id").run({ id: ready.id });
    expect(startable(db, ready.id)).toBe(false);
  });
});
