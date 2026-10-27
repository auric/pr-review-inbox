// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/storage/db";

process.env.REVIEW_LOOP_SECRETS = "memory";
const dir = mkdtempSync(join(tmpdir(), "rl-db-"));
process.env.REVIEW_LOOP_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The user_version after the last migration of db.ts.
const LATEST = 38;

// One transaction per setup: a commit per statement is slow on Windows CI disks.
const migrate = (db: Database, files: string[]) =>
  db.transaction(() => {
    for (const f of files) db.exec(readFileSync(join(import.meta.dir, "../../src/server/storage/migrations", f), "utf8"));
  })();

const schema = (path: string) => {
  const db = openDb(path);
  try {
    return {
      version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
      journal: (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      fk: (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
      busy: (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      objects: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() as { type: string; name: string; sql: string }[],
    };
  } finally {
    db.close();
  }
};

test("migration runs on an empty file and creates every M1 table", () => {
  const s = schema(join(dir, "empty.sqlite"));
  expect(s.version).toBe(LATEST);
  expect(s.journal).toBe("wal");
  expect(s.fk).toBe(1);
  expect(s.busy).toBe(5000);
  const tables = s.objects.filter((o) => o.type === "table").map((o) => o.name);
  expect(tables).toEqual(
    expect.arrayContaining([
      "pull_request",
      "comment",
      "sync_checkpoint",
      "event",
      "pr_brief",
      "review_run",
      "run_event",
      "review_item",
      "post",
      "pr_commit",
      "pr_change",
      "task_context",
      "repo_clone",
      "fix_edit",
      "fix_commit",
      "pr_note",
      "task_attachment",
      "pr_branch_link",
      "task",
      "task_question",
      "task_part",
      "task_step",
      "task_event",
      "repo_task_settings",
    ]),
  );
  const indexes = s.objects.filter((o) => o.type === "index" && o.sql).map((o) => o.name);
  expect(indexes).toEqual(expect.arrayContaining(["comment_thread", "event_unclaimed"]));
  expect(s.objects.find((o) => o.name === "pull_request")?.sql).toContain("seen_at INTEGER");
  // 006_forge.sql runs last (db.ts list order).
  expect(s.objects.find((o) => o.name === "pull_request")?.sql).toContain("meta_head TEXT");
  expect(s.objects.find((o) => o.name === "comment")?.sql).toContain("excerpt_json TEXT");
  expect(s.objects.find((o) => o.name === "review_run")?.sql).toContain("profile_revision TEXT");
  expect(s.objects.find((o) => o.name === "review_run")?.sql).toContain("answer TEXT");
  expect(s.objects.find((o) => o.name === "review_run")?.sql).toContain("tasks_json TEXT");
  expect(s.objects.find((o) => o.name === "review_run")?.sql).toContain("effort TEXT");
  expect(s.objects.find((o) => o.name === "review_run")?.sql).toContain("effort_default TEXT");
  expect(s.objects.find((o) => o.name === "review_run")?.sql).toContain("explain_json TEXT");
});

// The db.ts list order up to version 9.
const V9 = [
  "001_m1.sql",
  "002_reviewers.sql",
  "003_author_login.sql",
  "004_v3.sql",
  "005_tasks.sql",
  "007_review.sql",
  "008_post.sql",
  "009_reply.sql",
  "006_forge.sql",
];

const R2_COLUMNS = { since_head: null, range_base: null, question: null, answer: null };
// 014_r3_runs.sql, 018_run_effort.sql, 019_run_effort_default.sql, 020_instructions.sql, 021_run_skills.sql, and 025_session.sql.
const R3_COLUMNS = {
  fix_json: null,
  tasks_json: null,
  effort: null,
  effort_default: null,
  instructions_json: null,
  skills_json: null,
  consult_json: null,
};
// 030_review_v2.sql, 032_ask_parent.sql, and 033_task.sql.
const V2_COLUMNS = { prompt_version: null, item: null, discuss_json: null, explain_json: null, parent_run: null, task: null };
const V2_NAMES = Object.keys(V2_COLUMNS);

test("migration from a version-9 database keeps every run", () => {
  const path = join(dir, "v9.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, V9);
  old.exec("PRAGMA user_version = 9");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'completed', 1),
             (7, 1, 'reply', 'explain', '', 'k2', 'a', 'b', 'failed', 2);`);
  const before = old.query("SELECT * FROM review_run ORDER BY id").all() as Record<string, unknown>[];
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("SELECT * FROM review_run ORDER BY id").all()).toEqual(
      before.map((r) => ({ ...r, profile_name: null, profile_revision: null, explain: null, ...R2_COLUMNS, ...R3_COLUMNS, ...V2_COLUMNS })),
    );
  } finally {
    db.close();
  }
});

test("a second run changes nothing", () => {
  const path = join(dir, "rerun.sqlite");
  const first = schema(path);
  const second = schema(path);
  expect(second).toEqual(first);
});

test("foreign keys and the event key hold", () => {
  const db = openDb(join(dir, "keys.sqlite"));
  try {
    expect(() => db.run("INSERT INTO event (pr, kind, ref, created_at) VALUES (99, 'comment_new', '1', 0)")).toThrow();
    db.run("INSERT INTO pull_request (project, repo, pr_id) VALUES ('P', 'r', 1)");
    db.run("INSERT INTO event (pr, kind, ref, created_at) VALUES (1, 'comment_new', '1', 0)");
    expect(() => db.run("INSERT INTO event (pr, kind, ref, created_at) VALUES (1, 'comment_new', '1', 1)")).toThrow();
  } finally {
    db.close();
  }
});

// ---------- Release 2: the review_run rebuild (012_r2_runs.sql) ----------

const V11 = [...V9, "010_profiles.sql", "011_run_explain.sql"];
const CHILDREN = ["run_event", "review_item", "post"];

// A version-11 database. foreign_keys is off unless the caller turns it on.
function v11(path: string) {
  const db = new Database(path, { create: true, strict: true });
  migrate(db, V11);
  db.exec("PRAGMA user_version = 11");
  return db;
}

// 027_post_resolve.sql adds the resolve columns to post. 028_run_event_agent.sql adds the subagent columns to run_event.
const LATER: Record<string, Record<string, null | number>> = {
  post: { resolve_root: null, resolve_state: null, resolve_error: null },
  run_event: { model: null, tokens: null, builtin: 0 },
};
const later = (t: string, rows: unknown) => (rows as Record<string, unknown>[]).map((r) => ({ ...r, ...LATER[t] }));

const dump = (db: Database) =>
  Object.fromEntries(["review_run", ...CHILDREN].map((t) => [t, db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
const columns = (db: Database, t: string) => (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

test("migration from a version-11 database keeps every run, event, item, and post", () => {
  const path = join(dir, "v11.sqlite");
  const old = v11(path);
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1), (2, 'P', 'r', 2);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, profile_name, profile_revision, explain)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'completed', 1, 'General', 'rev', 0),
             (7, 1, 'reply', 'explain', '', 'k2', 'a', 'b', 'running', 2, NULL, NULL, NULL),
             (9, 2, 'review', 'general', '', 'k3', 'a', 'b', 'failed', 3, NULL, NULL, 1);
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at)
      VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1), (4, 't2', 2, 'Agent', 'x', 'ok', 1), (7, 't3', 1, 'Grep', 'y', 'running', 2);
    INSERT INTO review_item (id, run, kind, payload_json, body, status, thread)
      VALUES (11, 4, 'finding', '{}', 'f', 'accepted', NULL), (12, 7, 'reply', '{}', 'r', 'new', 100), (13, 9, 'question', '{}', 'q', 'posted', NULL);
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 4, 'inline', 'run:1:4:11@0', 'f', '{}', '[]', 'confirmed', 1, 1), (22, 1, NULL, 'reply', 'reply:1:x', 'r', '{}', '[]', 'pending', 1, 1);`);
  const before = dump(old);
  const oldColumns = columns(old, "review_run");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(columns(db, "review_run")).toEqual([
      ...oldColumns,
      "since_head",
      "range_base",
      "question",
      "answer",
      "fix_json",
      "tasks_json",
      "effort",
      "effort_default",
      "instructions_json",
      "skills_json",
      "consult_json",
      ...V2_NAMES,
    ]);
    const after = dump(db);
    expect(after.review_run).toEqual(
      (before.review_run as Record<string, unknown>[]).map((r) => ({ ...r, ...R2_COLUMNS, ...R3_COLUMNS, ...V2_COLUMNS })),
    );
    for (const t of CHILDREN) expect(after[t]).toEqual(later(t, before[t]));
    for (const t of CHILDREN)
      expect((db.query(`PRAGMA foreign_key_list(${t})`).all() as { table: string }[]).map((k) => k.table)).toContain("review_run");

    const insert = (id: number, kind: string, key: string) =>
      db.run(
        `INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, question)
        VALUES (${id}, 2, '${kind}', 'general', '', '${key}', 'a', 'b', 'running', 5, 'Why?')`,
      );
    insert(30, "ask", "k4");
    expect(() => insert(31, "bogus", "k5")).toThrow(/CHECK/);
    // review_run_running: one running run per key.
    expect(() => insert(32, "ask", "k4")).toThrow(/UNIQUE/);
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'review_run' AND type = 'index' ORDER BY name").all()).toEqual([
      { name: "review_run_item" },
      { name: "review_run_parent" },
      { name: "review_run_pr" },
      { name: "review_run_running" },
      { name: "review_run_task" },
    ]);
    // The children still cascade from the rebuilt table.
    db.run("DELETE FROM review_run WHERE id = 4");
    expect(db.query("SELECT COUNT(*) AS n FROM run_event WHERE run = 4").get()).toEqual({ n: 0 });
    expect(db.query("SELECT id FROM review_item ORDER BY id").all()).toEqual([{ id: 12 }, { id: 13 }]);
    expect(db.query("SELECT id FROM post ORDER BY id").all()).toEqual([{ id: 22 }]);
  } finally {
    db.close();
  }

  const rows = () => {
    const d = new Database(path, { readonly: true });
    try {
      return dump(d);
    } finally {
      d.close();
    }
  };
  const first = { ...schema(path), rows: rows() };
  const second = { ...schema(path), rows: rows() };
  expect(second).toEqual(first);
});

test("an orphan row in a table that no migration touches does not block the upgrade", () => {
  const path = join(dir, "orphan.sqlite");
  const old = v11(path);
  old.exec("INSERT INTO pr_task (pr, key, source, url, ord) VALUES (99, 'ABC-1', 'branch', NULL, 0)");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([
      { table: "pr_task", rowid: expect.anything(), parent: "pull_request", fkid: 0 },
    ]);
  } finally {
    db.close();
  }
});

test("a migration that leaves a broken foreign key rolls back and throws", () => {
  const path = join(dir, "broken.sqlite");
  const old = v11(path);
  old.exec("INSERT INTO run_event (run, id, seq, tool, target, status, started_at) VALUES (99, 't1', 1, 'Read', 'a.ts', 'ok', 1)");
  old.close();

  expect(() => openDb(path)).toThrow(/foreign key/);
  const db = new Database(path, { readonly: true });
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(11);
    expect(columns(db, "review_run")).not.toContain("since_head");
    expect(db.query("SELECT run, id FROM run_event").all()).toEqual([{ run: 99, id: "t1" }]);
  } finally {
    db.close();
  }
});

// ---------- Release 3: the review_run rebuild (014_r3_runs.sql) and the new tables ----------

const V13 = [...V11, "012_r2_runs.sql", "013_task_context.sql"];

test("migration from a version-13 database keeps every run, event, item, and post", () => {
  const path = join(dir, "v13.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, V13);
  old.exec("PRAGMA user_version = 13");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1), (2, 'P', 'r', 2);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, profile_name, explain,
        since_head, range_base, question, answer)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'completed', 1, 'General', 0, 'h0', 'rb', NULL, NULL),
             (7, 1, 'reply', 'general', '', 'k2', 'a', 'b', 'running', 2, NULL, NULL, NULL, NULL, NULL, NULL),
             (9, 2, 'ask', 'general', '', 'k3', 'a', 'b', 'completed', 3, 'General', 0, NULL, NULL, 'Why?', 'Because.');
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at)
      VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1), (7, 't2', 1, 'Grep', 'y', 'running', 2), (9, 't3', 1, 'Read', 'b.ts', 'ok', 3);
    INSERT INTO review_item (id, run, kind, payload_json, body, status, thread)
      VALUES (11, 4, 'finding', '{}', 'f', 'accepted', NULL), (12, 7, 'reply', '{}', 'r', 'new', 100), (13, 4, 'question', '{}', 'q', 'posted', NULL);
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 4, 'inline', 'run:1:4:11@0', 'f', '{}', '[]', 'confirmed', 1, 1), (22, 1, 7, 'reply', 'run:1:7:12@0', 'r', '{}', '[]', 'pending', 1, 1);
    INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES (1, 'ABC-1', 'jira', '{}', 5);`);
  const before = dump(old);
  const oldColumns = columns(old, "review_run");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(columns(db, "review_run")).toEqual([
      ...oldColumns,
      "fix_json",
      "tasks_json",
      "effort",
      "effort_default",
      "instructions_json",
      "skills_json",
      "consult_json",
      ...V2_NAMES,
    ]);
    const after = dump(db);
    expect(after.review_run).toEqual((before.review_run as Record<string, unknown>[]).map((r) => ({ ...r, ...R3_COLUMNS, ...V2_COLUMNS })));
    for (const t of CHILDREN) expect(after[t]).toEqual(later(t, before[t]));

    const insert = (id: number, kind: string, key: string) =>
      db.run(
        `INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, fix_json, tasks_json)
        VALUES (${id}, 2, '${kind}', 'general', '', '${key}', 'a', 'b', 'running', 5, '[]', '[{"key":"ABC-1","fetchedAt":5}]')`,
      );
    insert(30, "fix", "k4");
    expect(() => insert(31, "bogus", "k5")).toThrow(/CHECK/);
    expect(() => insert(32, "fix", "k4")).toThrow(/UNIQUE/);
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'review_run' AND type = 'index' ORDER BY name").all()).toEqual([
      { name: "review_run_item" },
      { name: "review_run_parent" },
      { name: "review_run_pr" },
      { name: "review_run_running" },
      { name: "review_run_task" },
    ]);

    // The new tables: an undone fix commit frees its key, and the rows cascade from their parents.
    db.run(
      `INSERT INTO fix_edit (id, run, ord, thread, path, old, new, start, rows_json) VALUES (1, 30, 0, 100, 'a.ts', 'x', 'y', 0, '[]')`,
    );
    const commit = (id: number, state: string) =>
      db.run(
        `INSERT INTO fix_commit (id, pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
        VALUES (${id}, 2, 30, '30:clone:1', '[1]', 'clone', 'a', '${state}', 'm', 1, 1)`,
      );
    commit(1, "undone");
    commit(2, "committed");
    expect(() => commit(3, "staged")).toThrow(/UNIQUE/);
    expect(() =>
      db.run(`INSERT INTO fix_commit (id, pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
        VALUES (4, 2, 30, 'k', '[]', 'push', 'a', 'committed', 'm', 1, 1)`),
    ).toThrow(/CHECK/);
    db.run("INSERT INTO repo_clone (project, repo, path, updated_at) VALUES ('P', 'r', '/clone', 1)");
    db.run(`INSERT INTO task_attachment (pr, key, att_id, filename, mime, size, file, sha256, image, text, downloaded_at)
      VALUES (1, 'ABC-1', '10001', 'a.png', 'image/png', 3, 'f', 'h', 1, 0, 1)`);
    expect(() =>
      db.run(`INSERT INTO task_attachment (pr, key, att_id, filename, mime, size, file, sha256, image, text, downloaded_at)
        VALUES (1, 'ABC-9', '10002', 'b.txt', NULL, 3, 'f', 'h', 0, 1, 1)`),
    ).toThrow(/FOREIGN KEY/);
    db.run("DELETE FROM review_run WHERE id = 30");
    expect(db.query("SELECT (SELECT COUNT(*) FROM fix_edit) + (SELECT COUNT(*) FROM fix_commit) AS n").get()).toEqual({ n: 0 });
    db.run("DELETE FROM task_context WHERE pr = 1 AND key = 'ABC-1'");
    expect(db.query("SELECT COUNT(*) AS n FROM task_attachment").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }

  const rows = () => {
    const d = new Database(path, { readonly: true });
    try {
      return dump(d);
    } finally {
      d.close();
    }
  };
  const first = { ...schema(path), rows: rows() };
  const second = { ...schema(path), rows: rows() };
  expect(second).toEqual(first);
});

// ---------- fix-ux WP3: the fix_edit rebuild (023_fix_finding.sql) ----------

const V22 = [
  ...V13,
  "014_r3_runs.sql",
  "015_fix.sql",
  "016_task_attachment.sql",
  "017_branch_links.sql",
  "018_run_effort.sql",
  "019_run_effort_default.sql",
  "020_instructions.sql",
  "021_run_skills.sql",
  "022_author_link.sql",
];

test("migration from a version-22 database keeps every fix edit; an edit names exactly one thread or one finding", () => {
  const path = join(dir, "v22.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, V22);
  old.exec("PRAGMA user_version = 22");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
      VALUES (4, 1, 'review', 'general', '', 'k1', 'a', 'b', 'completed', 1), (7, 1, 'fix', 'general', '', 'k2', 'a', 'b', 'completed', 2);
    INSERT INTO review_item (id, run, kind, payload_json, body, status) VALUES (11, 4, 'finding', '{}', 'f', 'accepted');
    INSERT INTO fix_edit (id, run, ord, thread, path, old, new, start, rows_json)
      VALUES (3, 7, 0, 100, 'a.ts', 'x', 'y', 0, '[]'), (5, 7, 1, 200, 'b.ts', '', 'z', 0, '[{"kind":"add"}]');
    INSERT INTO fix_commit (id, pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
      VALUES (1, 1, 7, '7:clone:3,5', '[3,5]', 'clone', 'a', 'committed', 'm', 1, 1);`);
  const before = old.query("SELECT * FROM fix_edit ORDER BY id").all() as Record<string, unknown>[];
  const commits = old.query("SELECT * FROM fix_commit").all();
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(columns(db, "fix_edit")).toEqual(["id", "run", "ord", "thread", "path", "old", "new", "start", "rows_json", "item"]);
    expect(db.query("SELECT * FROM fix_edit ORDER BY id").all()).toEqual(before.map((r) => ({ ...r, item: null })));
    expect(db.query("SELECT * FROM fix_commit").all()).toEqual(commits);
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'fix_edit' AND type = 'index'").all()).toEqual([
      { name: "fix_edit_run" },
    ]);

    const insert = (id: number, thread: number | null, item: number | null) =>
      db
        .query(
          "INSERT INTO fix_edit (id, run, ord, thread, item, path, old, new, start, rows_json) VALUES ($id, 7, 2, $thread, $item, 'c.ts', 'x', 'y', 0, '[]')",
        )
        .run({ id, thread, item });
    insert(8, null, 11);
    expect(() => insert(9, null, null)).toThrow(/CHECK/);
    expect(() => insert(9, 100, 11)).toThrow(/CHECK/);
    expect(() => insert(9, null, 99)).toThrow(/FOREIGN KEY/);
    // The edits still cascade from their run.
    db.run("DELETE FROM review_run WHERE id = 7");
    expect(db.query("SELECT COUNT(*) AS n FROM fix_edit").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

// ---------- Session consult: the review_run rebuild (024_consult.sql) ----------

const V23 = [...V22, "023_fix_finding.sql"];

test("migration from a version-23 database keeps every run and child row; kind consult is new", () => {
  const path = join(dir, "v23.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, V23);
  old.exec("PRAGMA user_version = 23");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, effort, skills_json)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'completed', 1, 'high', '[]'),
             (7, 1, 'fix', 'general', '', 'k2', 'a', 'b', 'completed', 2, NULL, NULL);
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at) VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1);
    INSERT INTO review_item (id, run, kind, payload_json, body, status) VALUES (11, 4, 'finding', '{}', 'f', 'accepted');
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 4, 'inline', 'run:1:4:11@0', 'f', '{}', '[]', 'confirmed', 1, 1);
    INSERT INTO fix_edit (id, run, ord, thread, item, path, old, new, start, rows_json) VALUES (3, 7, 0, NULL, 11, 'a.ts', 'x', 'y', 0, '[]');
    INSERT INTO fix_commit (id, pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
      VALUES (1, 1, 7, '7:clone:3', '[3]', 'clone', 'a', 'committed', 'm', 1, 1);`);
  const before = dump(old);
  const fixes = old
    .query("SELECT (SELECT json_group_array(id) FROM fix_edit) AS e, (SELECT json_group_array(id) FROM fix_commit) AS c")
    .get();
  const oldColumns = columns(old, "review_run");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // 025_session.sql adds consult_json. 030_review_v2.sql adds the review v2 columns.
    expect(columns(db, "review_run")).toEqual([...oldColumns, "consult_json", ...V2_NAMES]);
    const after = dump(db);
    expect(after.review_run).toEqual(
      (before.review_run as Record<string, unknown>[]).map((r) => ({ ...r, consult_json: null, ...V2_COLUMNS })),
    );
    for (const t of CHILDREN) expect(after[t]).toEqual(later(t, before[t]));
    expect(
      db.query("SELECT (SELECT json_group_array(id) FROM fix_edit) AS e, (SELECT json_group_array(id) FROM fix_commit) AS c").get(),
    ).toEqual(fixes);
    const insert = (id: number, kind: string) =>
      db.run(`INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
        VALUES (${id}, 1, '${kind}', '', '', 'consult:${id}', 'a', 'b', 'completed', 5)`);
    insert(30, "consult");
    expect(() => insert(31, "bogus")).toThrow(/CHECK/);
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'review_run' AND type = 'index' ORDER BY name").all()).toEqual([
      { name: "review_run_item" },
      { name: "review_run_parent" },
      { name: "review_run_pr" },
      { name: "review_run_running" },
      { name: "review_run_task" },
    ]);
    // The children still cascade from their run.
    db.run("DELETE FROM review_run WHERE id = 7");
    expect(db.query("SELECT (SELECT COUNT(*) FROM fix_edit) + (SELECT COUNT(*) FROM fix_commit) AS n").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

// ---------- Ask your session: the review_run rebuild (025_session.sql) ----------

test("migration from a version-24 database keeps every run and child row; kind session and consult_json are new", () => {
  const path = join(dir, "v24.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [...V23, "024_consult.sql"]);
  old.exec("PRAGMA user_version = 24");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, raw_output)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'completed', 1, NULL),
             (5, 1, 'consult', '', '', 'consult:1:5', 'a', 'b', 'completed', 2, '[]');
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at) VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1);
    INSERT INTO review_item (id, run, kind, payload_json, body, status, thread) VALUES (11, 4, 'finding', '{}', 'f', 'accepted', NULL),
      (12, 5, 'reply', '{}', 'r', 'new', 100);
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 4, 'inline', 'run:1:4:11@0', 'f', '{}', '[]', 'confirmed', 1, 1);`);
  const before = dump(old);
  const oldColumns = columns(old, "review_run");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(columns(db, "review_run")).toEqual([...oldColumns, "consult_json", ...V2_NAMES]);
    const after = dump(db);
    expect(after.review_run).toEqual(
      (before.review_run as Record<string, unknown>[]).map((r) => ({ ...r, consult_json: null, ...V2_COLUMNS })),
    );
    for (const t of CHILDREN) expect(after[t]).toEqual(later(t, before[t]));
    db.run(`INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, consult_json)
      VALUES (30, 1, 'session', '', '', 'session:30', 'a', 'b', 'running', 5, '{}')`);
    expect(() =>
      db.run(`INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
        VALUES (31, 1, 'bogus', '', '', 'x', 'a', 'b', 'completed', 5)`),
    ).toThrow(/CHECK/);
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'review_run' AND type = 'index' ORDER BY name").all()).toEqual([
      { name: "review_run_item" },
      { name: "review_run_parent" },
      { name: "review_run_pr" },
      { name: "review_run_running" },
      { name: "review_run_task" },
    ]);
    db.run("DELETE FROM review_run WHERE id = 4");
    expect(db.query("SELECT (SELECT COUNT(*) FROM run_event) + (SELECT COUNT(*) FROM post) AS n").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

// ---------- Thread resolver (026_thread_resolver.sql) ----------

test("migration from a version-25 database keeps every comment; the resolver columns are new and NULL", () => {
  const path = join(dir, "v25.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [...V23, "024_consult.sql", "025_session.sql"]);
  old.exec("PRAGMA user_version = 25");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO comment (pr, comment_id, version, root_id, author_slug, text, thread_resolved, created_at, updated_at)
      VALUES (1, 10, 0, 10, 'alex', 'Root.', 1, 1, 1), (1, 11, 0, 10, 'jdoe', 'Reply.', 0, 2, 2);`);
  const before = old.query("SELECT * FROM comment ORDER BY comment_id").all() as Record<string, unknown>[];
  const oldColumns = columns(old, "comment");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    // 029_draft_stale.sql adds orphaned_at.
    expect(columns(db, "comment")).toEqual([...oldColumns, "thread_resolver_json", "thread_resolved_at", "orphaned_at"]);
    expect(db.query("SELECT * FROM comment ORDER BY comment_id").all()).toEqual(
      before.map((r) => ({ ...r, thread_resolver_json: null, thread_resolved_at: null, orphaned_at: null })),
    );
  } finally {
    db.close();
  }
});

// ---------- Resolve after posting (027_post_resolve.sql) ----------

test("migration from a version-26 database keeps every post; the resolve columns are new, NULL, and checked", () => {
  const path = join(dir, "v26.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [...V23, "024_consult.sql", "025_session.sql", "026_thread_resolver.sql"]);
  old.exec("PRAGMA user_version = 26");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO post (pr, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (1, 'reply', 'reply:1:k', 'Text.', '{"kind":"reply","parentId":5}', '[]', 'confirmed', 1, 1);`);
  const before = old.query("SELECT * FROM post ORDER BY id").all() as Record<string, unknown>[];
  const oldColumns = columns(old, "post");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(columns(db, "post")).toEqual([...oldColumns, "resolve_root", "resolve_state", "resolve_error"]);
    expect(db.query("SELECT * FROM post ORDER BY id").all()).toEqual(later("post", before));
    db.run("UPDATE post SET resolve_root = 5, resolve_state = 'pending'");
    expect(() => db.run("UPDATE post SET resolve_state = 'bogus'")).toThrow(/CHECK/);
  } finally {
    db.close();
  }
});

// ---------- Out-of-date draft alerts (029_draft_stale.sql) ----------

test("migration from a version-28 database keeps every event and comment; kind draft_stale and orphaned_at are new", () => {
  const path = join(dir, "v28.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [
    ...V23,
    "024_consult.sql",
    "025_session.sql",
    "026_thread_resolver.sql",
    "027_post_resolve.sql",
    "028_run_event_agent.sql",
  ]);
  old.exec("PRAGMA user_version = 28");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1), (2, 'P', 'r', 2);
    INSERT INTO event (id, pr, kind, ref, created_at, digest, claimed_at)
      VALUES (3, 1, 'comment_new', '10', 1, 0, NULL), (5, 1, 'commits_pushed', 'abc', 2, 1, 7), (9, 2, 'reviewer_added', '4', 3, 0, NULL);
    INSERT INTO comment (pr, comment_id, version, root_id, author_slug, text, anchor_json, created_at, updated_at)
      VALUES (1, 10, 0, 10, 'alex', 'Root.', '{"path":"a.ts","orphaned":true}', 1, 1);`);
  const events = old.query("SELECT * FROM event ORDER BY id").all();
  const comments = old.query("SELECT * FROM comment").all() as Record<string, unknown>[];
  const eventColumns = columns(old, "event");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(columns(db, "event")).toEqual(eventColumns);
    expect(db.query("SELECT * FROM event ORDER BY id").all()).toEqual(events);
    expect(db.query("SELECT * FROM comment").all()).toEqual(comments.map((r) => ({ ...r, orphaned_at: null })));
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'event' AND type = 'index' AND sql IS NOT NULL").all()).toEqual([
      { name: "event_unclaimed" },
    ]);
    const insert = (kind: string, ref: string) =>
      db.query("INSERT INTO event (pr, kind, ref, created_at) VALUES (1, $kind, $ref, 4)").run({ kind, ref });
    insert("draft_stale", "12:out-of-date:11");
    expect(() => insert("bogus", "x")).toThrow(/CHECK/);
    expect(() => insert("draft_stale", "12:out-of-date:11")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO event (pr, kind, ref, created_at) VALUES (99, 'draft_stale', 'y', 4)")).toThrow(/FOREIGN KEY/);
    // A new row gets the next ID, and the rows still cascade from their PR.
    expect(db.query("SELECT MAX(id) AS id FROM event").get()).toEqual({ id: 10 });
    db.run("DELETE FROM pull_request WHERE id = 2");
    expect(db.query("SELECT id FROM event ORDER BY id").all()).toEqual([{ id: 3 }, { id: 5 }, { id: 10 }]);
  } finally {
    db.close();
  }
});

// ---------- Review v2: the review_run rebuild (030_review_v2.sql, docs/plans/review-v2/spec.md section 8) ----------

test("migration from a version-29 database keeps every run and child row; kinds explain and discuss and the review v2 columns are new", () => {
  const path = join(dir, "v29.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [
    ...V23,
    "024_consult.sql",
    "025_session.sql",
    "026_thread_resolver.sql",
    "027_post_resolve.sql",
    "028_run_event_agent.sql",
    "029_draft_stale.sql",
  ]);
  old.exec("PRAGMA user_version = 29");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, summary_json, consult_json)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'completed', 1, '{"summary":"s"}', NULL),
             (5, 1, 'consult', '', '', 'consult:1:5', 'a', 'b', 'completed', 2, NULL, NULL),
             (6, 1, 'session', '', '', 'session:6', 'a', 'b', 'completed', 3, NULL, '{"session":"x"}'),
             (7, 1, 'fix', 'general', '', 'k2', 'a', 'b', 'completed', 4, NULL, NULL);
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at, agent) VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1, 'rl-reviewer');
    INSERT INTO review_item (id, run, kind, payload_json, body, status, thread) VALUES (11, 4, 'finding', '{}', 'f', 'accepted', NULL),
      (12, 5, 'reply', '{}', 'r', 'new', 100);
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 4, 'inline', 'run:1:4:11@0', 'f', '{}', '[]', 'confirmed', 1, 1);
    INSERT INTO fix_edit (id, run, ord, thread, item, path, old, new, start, rows_json) VALUES (3, 7, 0, NULL, 11, 'a.ts', 'x', 'y', 0, '[]');
    INSERT INTO fix_commit (id, pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
      VALUES (1, 1, 7, '7:clone:3', '[3]', 'clone', 'a', 'committed', 'm', 1, 1);`);
  const before = dump(old);
  const fixes = old
    .query("SELECT (SELECT json_group_array(id) FROM fix_edit) AS e, (SELECT json_group_array(id) FROM fix_commit) AS c")
    .get();
  const oldColumns = columns(old, "review_run");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(columns(db, "review_run")).toEqual([...oldColumns, ...V2_NAMES]);
    const after = dump(db);
    expect(after.review_run).toEqual((before.review_run as Record<string, unknown>[]).map((r) => ({ ...r, ...V2_COLUMNS })));
    for (const t of CHILDREN) expect(after[t]).toEqual(before[t]);
    expect(
      db.query("SELECT (SELECT json_group_array(id) FROM fix_edit) AS e, (SELECT json_group_array(id) FROM fix_commit) AS c").get(),
    ).toEqual(fixes);
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'review_run' AND type = 'index' ORDER BY name").all()).toEqual([
      { name: "review_run_item" },
      { name: "review_run_parent" },
      { name: "review_run_pr" },
      { name: "review_run_running" },
      { name: "review_run_task" },
    ]);

    const insert = (id: number, kind: string, item: number | null) =>
      db
        .query(`INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, item, prompt_version)
          VALUES ($id, 1, $kind, 'general', '', $key, 'a', 'b', 'completed', 5, $item, '2.0')`)
        .run({ id, kind, key: `k${id}`, item });
    insert(30, "explain", null);
    insert(31, "discuss", 11);
    insert(32, "discuss", 11);
    expect(() => insert(33, "bogus", null)).toThrow(/CHECK/);
    expect(() => insert(34, "discuss", 99)).toThrow(/FOREIGN KEY/);
    expect(db.query("SELECT id FROM review_run WHERE item = 11 ORDER BY id").all()).toEqual([{ id: 31 }, { id: 32 }]);
    // A deleted finding leaves its talk: the discuss runs keep their rows with item NULL.
    db.run("DELETE FROM review_item WHERE id = 11");
    expect(db.query("SELECT id, item FROM review_run WHERE kind = 'discuss' ORDER BY id").all()).toEqual([
      { id: 31, item: null },
      { id: 32, item: null },
    ]);
    // The children still cascade from their run.
    db.run("DELETE FROM review_run WHERE id = 7");
    expect(db.query("SELECT (SELECT COUNT(*) FROM fix_edit) + (SELECT COUNT(*) FROM fix_commit) AS n").get()).toEqual({ n: 0 });
    db.run("DELETE FROM review_run WHERE id = 4");
    expect(db.query("SELECT (SELECT COUNT(*) FROM run_event) + (SELECT COUNT(*) FROM post) AS n").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }

  // A second open changes nothing.
  const rows = () => {
    const d = new Database(path, { readonly: true });
    try {
      return dump(d);
    } finally {
      d.close();
    }
  };
  const first = { ...schema(path), rows: rows() };
  const second = { ...schema(path), rows: rows() };
  expect(second).toEqual(first);
});

// Bun 1.4.3 and earlier dropped a runtime error in any statement but the last of db.exec(). The DROP TABLE then lost the runs.
test("a migration statement that fails before the last one rolls back the whole migration and keeps every run", () => {
  const path = join(dir, "v29-bad-row.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [
    ...V23,
    "024_consult.sql",
    "025_session.sql",
    "026_thread_resolver.sql",
    "027_post_resolve.sql",
    "028_run_event_agent.sql",
    "029_draft_stale.sql",
  ]);
  old.exec("PRAGMA user_version = 29");
  old.exec("PRAGMA ignore_check_constraints = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'bogus', 1)`);
  old.close();

  expect(() => openDb(path)).toThrow(/CHECK/);
  const db = new Database(path, { readonly: true });
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(29);
    expect(db.query("SELECT id, status FROM review_run").all()).toEqual([{ id: 4, status: "bogus" }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'review_run_new'").all()).toEqual([]);
  } finally {
    db.close();
  }
});

// ---------- PR notes (031_pr_notes.sql, docs/plans/review-v2/spec.md sections 2.9 and 8) ----------

// The review_run rows of a dump after 032_ask_parent.sql and 033_task.sql.
const withParent = (d: object) =>
  ((d as Record<string, unknown>).review_run as Record<string, unknown>[]).map((r) => ({ ...r, parent_run: null, task: null }));

const V30 = [
  ...V23,
  "024_consult.sql",
  "025_session.sql",
  "026_thread_resolver.sql",
  "027_post_resolve.sql",
  "028_run_event_agent.sql",
  "029_draft_stale.sql",
  "030_review_v2.sql",
];

test("migration from a version-30 database keeps every row and adds pr_note with its checks", () => {
  const path = join(dir, "v30.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, V30);
  old.exec("PRAGMA user_version = 30");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1), (2, 'P', 'r', 2);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, consult_json)
      VALUES (4, 1, 'reply', 'general', '', 'k1', 'a', 'b', 'completed', 1, NULL),
             (5, 1, 'consult', '', '', 'consult:1:5', 'a', 'b', 'completed', 2, NULL),
             (6, 1, 'fix', 'general', '', 'k2', 'a', 'b', 'completed', 3, NULL);
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at) VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1);
    INSERT INTO review_item (id, run, kind, payload_json, body, status, thread) VALUES (11, 4, 'reply', '{}', 'r', 'new', 100);
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 4, 'reply', 'reply:11@0', 'r', '{}', '[]', 'confirmed', 1, 1);
    INSERT INTO fix_edit (id, run, ord, thread, item, path, old, new, start, rows_json) VALUES (3, 6, 0, 100, NULL, 'a.ts', 'x', 'y', 0, '[]');
    INSERT INTO fix_commit (id, pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
      VALUES (1, 1, 6, '6:clone:3', '[3]', 'clone', 'a', 'committed', 'm', 1, 1);`);
  const before = { ...dump(old), fix: old.query("SELECT * FROM fix_edit, fix_commit").all() };
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect({ ...dump(db), fix: db.query("SELECT * FROM fix_edit, fix_commit").all() } as Record<string, unknown>).toEqual({
      ...before,
      review_run: withParent(before),
    });
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'pr_note' AND type = 'index'").all()).toEqual([
      { name: "pr_note_pr" },
    ]);
    const add = (o: Record<string, unknown>) =>
      db
        .query(`INSERT INTO pr_note (pr, text, source, state, thread, run, item, ref_project, ref_repo, ref_pr, ref_state, created_at, updated_at)
          VALUES ($pr, $text, $source, $state, $thread, $run, $item, $rp, $rr, $rn, $rs, 1, 1) RETURNING id`)
        .get({
          pr: 1,
          text: "Callers retry.",
          source: "user",
          state: "kept",
          thread: null,
          run: null,
          item: null,
          rp: null,
          rr: null,
          rn: null,
          rs: null,
          ...o,
        }) as { id: number };
    const kept = add({}).id;
    const proposed = add({ source: "claude", state: "proposed", thread: 100, run: 4, item: 11 }).id;
    add({ rp: "P", rr: "r", rn: 2, rs: "MERGED" });
    expect(() => add({ text: "" })).toThrow(/CHECK/);
    expect(() => add({ text: "x".repeat(501) })).toThrow(/CHECK/);
    expect(() => add({ source: "bot" })).toThrow(/CHECK/);
    expect(() => add({ state: "proposed" })).toThrow(/CHECK/);
    expect(() => add({ source: "claude", state: "gone" })).toThrow(/CHECK/);
    expect(() => add({ rn: 2 })).toThrow(/CHECK/);
    expect(() => add({ rp: "P", rr: "r", rn: 2, rs: "CLOSED" })).toThrow(/CHECK/);
    expect(() => add({ pr: 99 })).toThrow(/FOREIGN KEY/);
    expect(() => add({ source: "claude", state: "proposed", run: 99 })).toThrow(/FOREIGN KEY/);
    // A removed draft or run leaves the suggestion with NULL links.
    db.run("DELETE FROM review_item WHERE id = 11");
    db.run("DELETE FROM review_run WHERE id = 4");
    expect(db.query("SELECT id, run, item FROM pr_note WHERE id = $id").get({ id: proposed })).toEqual({
      id: proposed,
      run: null,
      item: null,
    });
    // A removed PR removes its notes.
    db.run("DELETE FROM pull_request WHERE id = 1");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_note WHERE id IN ($a, $b)").get({ a: kept, b: proposed })).toEqual({ n: 0 });
  } finally {
    db.close();
  }

  // A second open changes nothing.
  const first = schema(path);
  expect(schema(path)).toEqual(first);
});

// ---------- Ask follow-ups (032_ask_parent.sql, docs/plans/review-v2/spec.md sections 2.15 and 8) ----------

test("migration from a version-31 database keeps every row and adds parent_run with one follow-up per ask run", () => {
  const path = join(dir, "v31.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [...V30, "031_pr_notes.sql"]);
  old.exec("PRAGMA user_version = 31");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, question, answer)
      VALUES (4, 1, 'ask', 'general', '', 'k1', 'a', 'b', 'completed', 1, 'Q1', 'A1'),
             (5, 1, 'reply', 'general', '', 'k2', 'a', 'b', 'completed', 2, NULL, NULL),
             (6, 1, 'fix', 'general', '', 'k3', 'a', 'b', 'completed', 3, NULL, NULL);
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at) VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1);
    INSERT INTO review_item (id, run, kind, payload_json, body, status, thread) VALUES (11, 5, 'reply', '{}', 'r', 'new', 100);
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 5, 'reply', 'reply:11@0', 'r', '{}', '[]', 'confirmed', 1, 1);
    INSERT INTO fix_edit (id, run, ord, thread, item, path, old, new, start, rows_json) VALUES (3, 6, 0, 100, NULL, 'a.ts', 'x', 'y', 0, '[]');
    INSERT INTO pr_note (id, pr, text, source, state, run, created_at, updated_at) VALUES (1, 1, 'Callers retry.', 'claude', 'proposed', 5, 1, 1);`);
  const before = { ...dump(old), notes: old.query("SELECT * FROM pr_note").all(), fix: old.query("SELECT * FROM fix_edit").all() };
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const after = { ...dump(db), notes: db.query("SELECT * FROM pr_note").all(), fix: db.query("SELECT * FROM fix_edit").all() };
    expect(after as Record<string, unknown>).toEqual({ ...before, review_run: withParent(before) });
    expect(columns(db, "review_run").slice(-2)).toEqual(["parent_run", "task"]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'review_run_parent'").all()).toEqual([{ name: "review_run_parent" }]);

    const ask = (id: number, parent: number | null) =>
      db
        .query(`INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, question, parent_run)
          VALUES ($id, 1, 'ask', 'general', '', $key, 'a', 'b', 'completed', 5, 'Q', $parent)`)
        .run({ id, key: `k${id}`, parent });
    ask(7, 4);
    ask(8, 7);
    ask(9, null);
    ask(10, null);
    // AC-F5: a conversation is one straight chain. A second follow-up of run 4 fails in the database.
    expect(() => ask(12, 4)).toThrow(/UNIQUE/);
    expect(() => ask(13, 99)).toThrow(/FOREIGN KEY/);
    // A removed parent leaves its follow-up as the first turn of the conversation.
    db.run("DELETE FROM review_run WHERE id = 7");
    expect(db.query("SELECT id, parent_run FROM review_run WHERE id = 8").get()).toEqual({ id: 8, parent_run: null });
  } finally {
    db.close();
  }

  // A second open changes nothing.
  const first = schema(path);
  expect(schema(path)).toEqual(first);
});

// ---------- Build a Jira task (033_task.sql, docs/plans/review-v2/spec.md sections 6.3 and 8) ----------

test("migration from a version-32 database keeps every row and child row; task runs and the task tables are new", () => {
  const path = join(dir, "v32.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [...V30, "031_pr_notes.sql", "032_ask_parent.sql"]);
  old.exec("PRAGMA user_version = 32");
  old.exec("PRAGMA foreign_keys = ON");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO review_run (id, pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, question, parent_run, item)
      VALUES (4, 1, 'review', 'general', 'n', 'k1', 'a', 'b', 'completed', 1, NULL, NULL, NULL),
             (5, 1, 'ask', 'general', '', 'k2', 'a', 'b', 'completed', 2, 'Q1', NULL, NULL),
             (6, 1, 'ask', 'general', '', 'k3', 'a', 'b', 'running', 3, 'Q2', 5, NULL),
             (7, 1, 'fix', 'general', '', 'k4', 'a', 'b', 'completed', 4, NULL, NULL, NULL);
    INSERT INTO run_event (run, id, seq, tool, target, status, started_at) VALUES (4, 't1', 1, 'Read', 'a.ts', 'ok', 1);
    INSERT INTO review_item (id, run, kind, payload_json, body, status, thread) VALUES (11, 4, 'finding', '{}', 'f', 'accepted', NULL),
      (12, 7, 'reply', '{}', 'r', 'new', 100);
    UPDATE review_run SET item = 11 WHERE id = 4;
    INSERT INTO post (id, pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at)
      VALUES (21, 1, 4, 'inline', 'run:1:4:11@0', 'f', '{}', '[]', 'confirmed', 1, 1);
    INSERT INTO fix_edit (id, run, ord, thread, item, path, old, new, start, rows_json) VALUES (3, 7, 0, NULL, 11, 'a.ts', 'x', 'y', 0, '[]');
    INSERT INTO fix_commit (id, pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
      VALUES (1, 1, 7, '7:clone:3', '[3]', 'clone', 'a', 'committed', 'm', 1, 1);
    INSERT INTO pr_note (id, pr, text, source, state, run, created_at, updated_at) VALUES (1, 1, 'Callers retry.', 'claude', 'proposed', 7, 1, 1);`);
  const extra = (d: Database) => ({
    fix: d.query("SELECT * FROM fix_edit, fix_commit").all(),
    notes: d.query("SELECT * FROM pr_note").all(),
  });
  const before: Record<string, unknown> = { ...dump(old), ...extra(old) };
  const oldColumns = columns(old, "review_run");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(columns(db, "review_run")).toEqual([...oldColumns, "task"]);
    expect({ ...dump(db), ...extra(db) } as Record<string, unknown>).toEqual({
      ...before,
      review_run: (before.review_run as Record<string, unknown>[]).map((r) => ({ ...r, task: null })),
    });
    expect(
      (db.query("PRAGMA table_info(review_run)").all() as { name: string; notnull: number }[]).find((c) => c.name === "pr")?.notnull,
    ).toBe(0);
    expect(db.query("SELECT name FROM sqlite_master WHERE tbl_name = 'review_run' AND type = 'index' ORDER BY name").all()).toEqual([
      { name: "review_run_item" },
      { name: "review_run_parent" },
      { name: "review_run_pr" },
      { name: "review_run_running" },
      { name: "review_run_task" },
    ]);

    const task = (o: Record<string, unknown> = {}) =>
      (
        db
          .query(`INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, spec_dir, created_at, updated_at)
            VALUES ($project, 'r', $key, 'T', $state, $size, $by, 'main', 'specs/ABC-1/', 1, 1) RETURNING id`)
          .get({ project: "P", key: "ABC-1", state: "interview", size: null, by: null, ...o }) as { id: number }
      ).id;
    const t = task();
    expect(db.query("SELECT settings_json, version, blocked_json FROM task WHERE id = $t").get({ t })).toEqual({
      settings_json: "{}",
      version: 0,
      blocked_json: null,
    });
    // task_open: one open task per repository and key. A done or failed task frees the key.
    expect(() => task()).toThrow(/UNIQUE/);
    task({ project: "Q" });
    db.run(`UPDATE task SET state = 'done' WHERE project = 'Q'`);
    task({ project: "Q" });
    expect(() => task({ key: "ABC-2", state: "bogus" })).toThrow(/CHECK/);
    expect(() => task({ key: "ABC-3", size: "huge" })).toThrow(/CHECK/);
    expect(() => task({ key: "ABC-4", by: "bot" })).toThrow(/CHECK/);

    const run = (id: number, pr: number | null, taskId: number | null, kind: string) =>
      db
        .query(`INSERT INTO review_run (id, pr, task, kind, profile, note, idem_key, source_head, target_head, status, started_at)
          VALUES ($id, $pr, $task, $kind, 'general', '', $key, 'a', 'b', 'completed', 5)`)
        .run({ id, pr, task: taskId, kind, key: `k${id}` });
    for (const [id, kind] of [
      [30, "interview"],
      [31, "spec"],
      [32, "implement"],
      [33, "review"],
    ] as const)
      run(id, null, t, kind);
    expect(() => run(34, null, null, "review")).toThrow(/CHECK/);
    expect(() => run(35, null, t, "bogus")).toThrow(/CHECK/);
    expect(() => run(36, null, 999, "spec")).toThrow(/FOREIGN KEY/);
    run(37, 1, null, "review");

    const part = db
      .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
        VALUES ($t, 1, 'single', 'One', 'feature/ABC-1-one', 'main', 'planned', 1, 1) RETURNING id`)
      .get({ t }) as { id: number };
    expect(() =>
      db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
        VALUES ($t, 1, 'part', 'Two', 'b', 'main', 'planned', 1, 1)`)
        .run({ t }),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
        VALUES ($t, 2, 'part', 'Two', 'b', 'main', 'gone', 1, 1)`)
        .run({ t }),
    ).toThrow(/CHECK/);
    const step = (kind: string, state: string, runId: number | null) =>
      db
        .query(`INSERT INTO task_step (task, part, ord, kind, run, state, started_at) VALUES ($t, $part, 1, $kind, $run, $state, 1)`)
        .run({ t, part: part.id, kind, run: runId, state });
    step("implement", "running", 32);
    step("check", "ok", null);
    expect(() => step("bogus", "ok", null)).toThrow(/CHECK/);
    expect(() => step("check", "done", null)).toThrow(/CHECK/);
    expect(db.query("SELECT detail_json, attempt FROM task_step WHERE run = 32").get()).toEqual({ detail_json: "{}", attempt: 1 });
    const question = (source: string, kind: string) =>
      db
        .query(
          `INSERT INTO task_question (task, source, round, ord, text, why, kind, asked_at) VALUES ($t, $source, 1, 1, 'Q?', 'W', $kind, 1)`,
        )
        .run({ t, source, kind });
    question("interview", "choice");
    expect(() => question("chat", "choice")).toThrow(/CHECK/);
    expect(() => question("loop", "radio")).toThrow(/CHECK/);
    const event = (kind: string, ref: string) =>
      db.query("INSERT INTO task_event (task, kind, ref, created_at) VALUES ($t, $kind, $ref, 1)").run({ t, kind, ref });
    event("needs_you", "7");
    expect(() => event("needs_you", "7")).toThrow(/UNIQUE/);
    expect(() => event("draft_stale", "8")).toThrow(/CHECK/);
    db.run("INSERT INTO repo_task_settings (project, repo, updated_at) VALUES ('P', 'r', 1)");
    expect(db.query("SELECT * FROM repo_task_settings").get()).toEqual({
      project: "P",
      repo: "r",
      spec_dir: "specs/{key}/",
      branch_prefix: "feature/",
      line_budget: 400,
      max_open: 2,
      approvals: 1,
      commands_json: "[]",
      test_globs_json: null,
      exclude_globs_json: null,
      isolate_home: 1,
      warned_at: null,
      // 034_task_base.sql runs after 033_task.sql in openDb.
      last_base: null,
      updated_at: 1,
    });
    expect(() => db.run("INSERT INTO repo_task_settings (project, repo, updated_at) VALUES ('P', 'r', 2)")).toThrow(/UNIQUE/);

    // A removed run leaves its step with run NULL. A removed task removes its runs, parts, steps, questions, and events.
    db.run("DELETE FROM review_run WHERE id = 32");
    expect(db.query("SELECT run FROM task_step WHERE kind = 'implement'").get()).toEqual({ run: null });
    db.query("DELETE FROM task WHERE id = $t").run({ t });
    expect(
      db
        .query(`SELECT (SELECT COUNT(*) FROM review_run WHERE task IS NOT NULL) + (SELECT COUNT(*) FROM task_part)
          + (SELECT COUNT(*) FROM task_step) + (SELECT COUNT(*) FROM task_question) + (SELECT COUNT(*) FROM task_event) AS n`)
        .get(),
    ).toEqual({ n: 0 });
    // The PR runs and their children stay.
    expect(db.query("SELECT id FROM review_run ORDER BY id").all()).toEqual([{ id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }, { id: 37 }]);
    db.run("DELETE FROM review_run WHERE id = 4");
    expect(db.query("SELECT (SELECT COUNT(*) FROM run_event) + (SELECT COUNT(*) FROM post) AS n").get()).toEqual({ n: 0 });
    db.run("DELETE FROM review_run WHERE id = 5");
    expect(db.query("SELECT parent_run FROM review_run WHERE id = 6").get()).toEqual({ parent_run: null });
  } finally {
    db.close();
  }

  // A second open changes nothing.
  const rows = () => {
    const d = new Database(path, { readonly: true });
    try {
      return dump(d);
    } finally {
      d.close();
    }
  };
  const first = { ...schema(path), rows: rows() };
  const second = { ...schema(path), rows: rows() };
  expect(second).toEqual(first);
});

test("migration from a version-33 database keeps every task setting; last_base is new and NULL; branch_prefix stays", () => {
  const path = join(dir, "v33.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [...V30, "031_pr_notes.sql", "032_ask_parent.sql", "033_task.sql"]);
  old.exec("PRAGMA user_version = 33");
  old.exec(
    `INSERT INTO repo_task_settings (project, repo, branch_prefix, commands_json, updated_at) VALUES ('P', 'r', 'users/me/', '[]', 1)`,
  );
  const before = old.query("SELECT * FROM repo_task_settings").all();
  const oldColumns = columns(old, "repo_task_settings");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(columns(db, "repo_task_settings")).toEqual([...oldColumns, "last_base"]);
    expect(db.query("SELECT * FROM repo_task_settings").all()).toEqual(
      (before as Record<string, unknown>[]).map((r) => ({ ...r, last_base: null })),
    );
  } finally {
    db.close();
  }
});

test("migration from a version-34 database adds task_repo with a main row per task, and task_pr", () => {
  const path = join(dir, "v34.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [...V30, "031_pr_notes.sql", "032_ask_parent.sql", "033_task.sql", "034_task_base.sql"]);
  old.exec("PRAGMA user_version = 34");
  old.exec(`INSERT INTO task (project, repo, key, title, state, target_branch, base_commit, spec_dir, created_at, updated_at)
    VALUES ('P', 'r', 'ABC-1', 'One', 'implementing', 'develop', 'abc', 'specs/ABC-1/', 7, 7)`);
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(db.query("SELECT task, role, project, repo, depth, access, base_branch, base_commit, created_at FROM task_repo").all()).toEqual([
      {
        task: 1,
        role: "main",
        project: "P",
        repo: "r",
        depth: 0,
        access: "edit",
        base_branch: "develop",
        base_commit: "abc",
        created_at: 7,
      },
    ]);
    // task_repo_one: a repository once per task; a submodule without a Bitbucket repository has project NULL.
    const sub = (project: string | null, repo: string | null) =>
      db
        .query(`INSERT INTO task_repo (task, role, project, repo, parent, path, depth, access, created_at)
          VALUES (1, 'submodule', $project, $repo, 1, 'x', 1, 'none', 1)`)
        .run({ project, repo });
    expect(() => sub("P", "r")).toThrow(/UNIQUE/);
    sub(null, null);
    sub(null, null);
    expect(() => db.run("INSERT INTO task_repo (task, role, depth, access, created_at) VALUES (1, 'other', 0, 'edit', 1)")).toThrow(
      /CHECK/,
    );
    expect(() => db.run("INSERT INTO task_repo (task, role, depth, access, created_at) VALUES (1, 'added', 0, 'write', 1)")).toThrow(
      /CHECK/,
    );
    db.run(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
      VALUES (1, 1, 'single', 'One', 'b', 'develop', 'implementing', 1, 1)`);
    const pr = (state: string) =>
      db
        .query(`INSERT INTO task_pr (part, task_repo, branch, base_branch, base_commit, state) VALUES (1, 2, 'b', 'main', 'c', $state)`)
        .run({ state });
    expect(() => pr("open")).toThrow(/CHECK/);
    pr("changed");
    expect(() => pr("changed")).toThrow(/UNIQUE/);
    // A removed task removes its repositories and their PR rows.
    db.run("DELETE FROM task WHERE id = 1");
    expect(db.query("SELECT (SELECT COUNT(*) FROM task_repo) + (SELECT COUNT(*) FROM task_pr) AS n").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});

test("migration from a version-36 database keeps every task step with its ID; instruct, update, resolve, and pr_merge_result are new", () => {
  const path = join(dir, "v36.sqlite");
  const old = new Database(path, { create: true, strict: true });
  migrate(old, [
    ...V30,
    "031_pr_notes.sql",
    "032_ask_parent.sql",
    "033_task.sql",
    "034_task_base.sql",
    "035_task_repos.sql",
    "036_task_file.sql",
  ]);
  old.exec("PRAGMA user_version = 36");
  old.exec(`INSERT INTO pull_request (id, project, repo, pr_id) VALUES (1, 'P', 'r', 1);
    INSERT INTO task (id, project, repo, key, title, state, target_branch, spec_dir, created_at, updated_at)
      VALUES (1, 'P', 'r', 'ABC-1', 'One', 'implementing', 'main', 'specs/ABC-1/', 1, 1);
    INSERT INTO task_part (id, task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
      VALUES (1, 1, 1, 'single', 'One', 'b', 'main', 'implementing', 1, 1);
    INSERT INTO task_step (id, task, part, ord, kind, state, attempt, item, detail_json, started_at, ended_at)
      VALUES (7, 1, 1, 1, 'rebase', 'ok', 2, 'P1', '{"notes":["x"]}', 3, 4), (9, 1, NULL, 2, 'commit', 'running', 1, NULL, '{}', 5, NULL);`);
  const before = old.query("SELECT * FROM task_step ORDER BY id").all();
  const columnsBefore = columns(old, "task_step");
  old.close();

  const db = openDb(path);
  try {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST);
    expect(columns(db, "task_step")).toEqual(columnsBefore);
    expect(db.query("SELECT * FROM task_step ORDER BY id").all()).toEqual(before);
    for (const kind of ["instruct", "update", "resolve"])
      db.query("INSERT INTO task_step (task, part, ord, kind, state, started_at) VALUES (1, 1, 3, $kind, 'running', 1)").run({ kind });
    expect(() => db.run("INSERT INTO task_step (task, ord, kind, state, started_at) VALUES (1, 4, 'other', 'ok', 1)")).toThrow(/CHECK/);
    // pull_request keeps its columns. The merge result has its own table; a removed PR removes its row.
    db.run(`INSERT INTO pr_merge_result (pr, merge_result) VALUES (1, '{"outcome":"CLEAN","current":true}')`);
    expect(() => db.run("INSERT INTO pr_merge_result (pr, merge_result) VALUES (2, NULL)")).toThrow(/FOREIGN KEY/);
    db.run("DELETE FROM pull_request WHERE id = 1");
    expect(db.query("SELECT COUNT(*) AS n FROM pr_merge_result").get()).toEqual({ n: 0 });
    // The rebuilt table keeps its foreign keys: a removed task removes its steps.
    db.run("DELETE FROM task WHERE id = 1");
    expect(db.query("SELECT COUNT(*) AS n FROM task_step").get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
