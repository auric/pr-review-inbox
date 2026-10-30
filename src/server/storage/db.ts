// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Database } from "bun:sqlite";
import m001_m1 from "./migrations/001_m1.sql" with { type: "text" };
import m002_reviewers from "./migrations/002_reviewers.sql" with { type: "text" };
import m003_author_login from "./migrations/003_author_login.sql" with { type: "text" };
import m004_v3 from "./migrations/004_v3.sql" with { type: "text" };
import m005_tasks from "./migrations/005_tasks.sql" with { type: "text" };
import m006_forge from "./migrations/006_forge.sql" with { type: "text" };
import m007_review from "./migrations/007_review.sql" with { type: "text" };
import m008_post from "./migrations/008_post.sql" with { type: "text" };
import m009_reply from "./migrations/009_reply.sql" with { type: "text" };
import m010_profiles from "./migrations/010_profiles.sql" with { type: "text" };
import m011_run_explain from "./migrations/011_run_explain.sql" with { type: "text" };
import m012_r2_runs from "./migrations/012_r2_runs.sql" with { type: "text" };
import m013_task_context from "./migrations/013_task_context.sql" with { type: "text" };
import m014_r3_runs from "./migrations/014_r3_runs.sql" with { type: "text" };
import m015_fix from "./migrations/015_fix.sql" with { type: "text" };
import m016_task_attachment from "./migrations/016_task_attachment.sql" with { type: "text" };
import m017_branch_links from "./migrations/017_branch_links.sql" with { type: "text" };
import m018_run_effort from "./migrations/018_run_effort.sql" with { type: "text" };
import m019_run_effort_default from "./migrations/019_run_effort_default.sql" with { type: "text" };
import m020_instructions from "./migrations/020_instructions.sql" with { type: "text" };
import m021_run_skills from "./migrations/021_run_skills.sql" with { type: "text" };
import m022_author_link from "./migrations/022_author_link.sql" with { type: "text" };
import m023_fix_finding from "./migrations/023_fix_finding.sql" with { type: "text" };
import m024_consult from "./migrations/024_consult.sql" with { type: "text" };
import m025_session from "./migrations/025_session.sql" with { type: "text" };
import m026_thread_resolver from "./migrations/026_thread_resolver.sql" with { type: "text" };
import m027_post_resolve from "./migrations/027_post_resolve.sql" with { type: "text" };
import m028_run_event_agent from "./migrations/028_run_event_agent.sql" with { type: "text" };
import m029_draft_stale from "./migrations/029_draft_stale.sql" with { type: "text" };
import m030_review_v2 from "./migrations/030_review_v2.sql" with { type: "text" };
import m031_pr_notes from "./migrations/031_pr_notes.sql" with { type: "text" };
import m032_ask_parent from "./migrations/032_ask_parent.sql" with { type: "text" };
import m033_task from "./migrations/033_task.sql" with { type: "text" };
import m034_task_base from "./migrations/034_task_base.sql" with { type: "text" };
import m035_task_repos from "./migrations/035_task_repos.sql" with { type: "text" };
import m036_task_file from "./migrations/036_task_file.sql" with { type: "text" };
import m037_task_update from "./migrations/037_task_update.sql" with { type: "text" };
import m038_task_profile from "./migrations/038_task_profile.sql" with { type: "text" };
import m039_task_files from "./migrations/039_task_files.sql" with { type: "text" };
import m040_task_base_changed from "./migrations/040_task_base_changed.sql" with { type: "text" };
import m041_build_status from "./migrations/041_build_status.sql" with { type: "text" };
import m042_task_subtasks from "./migrations/042_task_subtasks.sql" with { type: "text" };

// Index i holds the SQL that raises user_version from i to i + 1. The list order, not the file number, sets the version.
const MIGRATIONS = [
  m001_m1,
  m002_reviewers,
  m003_author_login,
  m004_v3,
  m005_tasks,
  m007_review,
  m008_post,
  m009_reply,
  m006_forge, // 006_forge.sql (WP4) came last, so it runs after 009_reply.sql.
  m010_profiles,
  m011_run_explain,
  m012_r2_runs,
  m013_task_context,
  m014_r3_runs,
  m015_fix,
  m016_task_attachment,
  m017_branch_links,
  m018_run_effort,
  m019_run_effort_default,
  m020_instructions,
  m021_run_skills,
  m022_author_link,
  m023_fix_finding,
  m024_consult,
  m025_session,
  m026_thread_resolver,
  m027_post_resolve,
  m028_run_event_agent,
  m029_draft_stale,
  m030_review_v2,
  m031_pr_notes,
  m032_ask_parent,
  m033_task,
  m034_task_base,
  m035_task_repos,
  m036_task_file,
  m037_task_update,
  m038_task_profile,
  m039_task_files,
  m040_task_base_changed,
  m041_build_status,
  m042_task_subtasks,
];

const tables = (db: Database) =>
  new Map(
    (db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as { name: string; sql: string }[]).map((r) => [
      r.name,
      r.sql,
    ]),
  );

// The tables that a migration created or changed, and their child tables. An orphan row elsewhere is older than the migration.
function touched(db: Database, before: Map<string, string>) {
  const after = tables(db);
  const changed = new Set([...after].filter(([n, sql]) => before.get(n) !== sql).map(([n]) => n.toLowerCase()));
  const out = new Set(changed);
  for (const n of after.keys())
    for (const k of db.query('SELECT "table" FROM pragma_foreign_key_list(?)').all(n) as { table: string }[])
      if (changed.has(k.table.toLowerCase())) out.add(n.toLowerCase());
  return out;
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  // journal_mode cannot change inside a transaction.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // A table rebuild drops a parent table. With foreign keys on, the drop deletes the child rows (ON DELETE CASCADE).
  // foreign_keys cannot change inside a transaction (SQLite lang_altertable.html, "Making other kinds of table schema changes").
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        const before = tables(db);
        db.exec(MIGRATIONS[v] as string);
        const broken = [...touched(db, before)].flatMap((t) => db.query(`PRAGMA foreign_key_check("${t.replaceAll('"', '""')}")`).all());
        if (broken.length)
          throw new Error(`Migration ${v + 1} breaks ${broken.length} foreign keys: ${JSON.stringify(broken.slice(0, 3))}`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  } catch (e) {
    db.close();
    throw e;
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
