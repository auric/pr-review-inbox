// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/submodule-prs.md section 6 (WP-RP0): review_run.related_json reads back as RunDto.related. An in-memory database.
import { expect, test } from "bun:test";
import { type RunRow, SQL, toRunDto } from "../../src/server/review/run-rows";
import { openDb } from "../../src/server/storage/db";

console.log(`run-related.test.ts imported from ${Bun.resolveSync("../../src/server/review/run-rows", import.meta.dir)}`);

function setup() {
  const db = openDb(":memory:");
  const { id: pr } = db.query("INSERT INTO pull_request (project, repo, pr_id) VALUES ('PROJ', 'repo', 2) RETURNING id").get() as {
    id: number;
  };
  const { id } = db
    .query(
      `INSERT INTO review_run (pr, kind, profile, profile_name, explain, note, idem_key, source_head, target_head, merge_base, status, started_at)
      VALUES ($pr, 'review', 'general', 'General', 0, '', 'k', 'h', 't', 'm', 'completed', 1) RETURNING id`,
    )
    .get({ pr }) as { id: number };
  const read = () => toRunDto(db.query(`${SQL.run} WHERE r.id = $id`).get({ id }) as RunRow, () => null);
  return { db, id, read };
}

test("a run without a related_json value has no related field", () => {
  const { db, read } = setup();
  try {
    const dto = read();
    expect(dto.related).toBeUndefined();
    expect("related" in dto).toBe(false);
  } finally {
    db.close();
  }
});

test("SQL.related stores the parts, and the run reads them back in order", () => {
  const { db, id, read } = setup();
  try {
    const related = [
      { label: "Submodule context", text: "lib/a read", warn: false },
      { label: "Submodule context", text: "lib/b not read", warn: true },
    ];
    db.query(SQL.related).run({ id, json: JSON.stringify(related) });
    expect(read().related).toEqual(related);
  } finally {
    db.close();
  }
});
