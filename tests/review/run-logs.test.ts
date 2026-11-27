// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Audit S2: the start-up cleanup clears the raw output and the tool calls of the runs of long-archived PRs only.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRunLogs, type RunRow, SQL, toRunDto } from "../../src/server/review/run-rows";
import { openDb } from "../../src/server/storage/db";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const DAY = 24 * 60 * 60 * 1000;

test("an old archived PR's run loses its raw output and tool calls; its items stay; an open PR's run keeps them", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-run-logs-"));
  dirs.push(dir);
  const db = openDb(join(dir, "test.db"));
  try {
    const now = 100 * DAY;
    const pr = (n: number, archived: number | null) =>
      (
        db
          .query(
            "INSERT INTO pull_request (project, repo, pr_id, state, archived_at) VALUES ('PRJ', 'repo', $n, 'OPEN', $archived) RETURNING id",
          )
          .get({ n, archived }) as { id: number }
      ).id;
    const run = (p: number, status: string) => {
      const { id } = db
        .query(
          `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, raw_output, summary_json, started_at, finished_at)
          VALUES ($p, 'review', 'general', '', $key, 'a', 'b', $status, 'raw text', '{"x":1}', 1, 2) RETURNING id`,
        )
        .get({ p, key: `k-${p}-${status}`, status }) as { id: number };
      db.query("INSERT INTO run_event (run, id, seq, tool, target, status, started_at) VALUES ($id, 'e1', 1, 'Read', 'a.ts', 'ok', 1)").run(
        { id },
      );
      db.query(
        "INSERT INTO review_item (run, kind, payload_json, body, anchor_state, status, edited) VALUES ($id, 'finding', '{}', 'b', 'none', 'new', 0)",
      ).run({ id });
      return id;
    };
    const old = run(pr(1, now - 40 * DAY), "completed");
    const oldRunning = run(pr(2, now - 40 * DAY), "running");
    const recent = run(pr(3, now - 5 * DAY), "completed");
    const open = run(pr(4, null), "completed");

    clearRunLogs(db, now - 30 * DAY, now);

    const row = (id: number) => db.query(`${SQL.run} WHERE r.id = $id`).get({ id }) as RunRow;
    const events = (id: number) => (db.query("SELECT COUNT(*) AS n FROM run_event WHERE run = $id").get({ id }) as { n: number }).n;
    const items = (id: number) => (db.query("SELECT COUNT(*) AS n FROM review_item WHERE run = $id").get({ id }) as { n: number }).n;
    const dto = toRunDto(row(old));
    expect(dto).toMatchObject({ hasRaw: false, logCleared: true, summary: { x: 1 } });
    expect([events(old), items(old)]).toEqual([0, 1]);
    for (const id of [oldRunning, recent, open]) {
      const d = toRunDto(row(id));
      expect(d.hasRaw).toBe(true);
      expect(d.logCleared).toBeUndefined();
      expect([events(id), items(id)]).toEqual([1, 1]);
    }
    // A second pass changes nothing.
    clearRunLogs(db, now - 30 * DAY, now + 1);
    expect(row(old).log_cleared_at).toBe(now);
  } finally {
    db.close();
  }
});
