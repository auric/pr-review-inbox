-- docs/plans/review-v2/spec.md section 6.18.6: Tell Claude and Update from the base branch. SQLite cannot change a CHECK, so task_step is
-- rebuilt with its column order and row IDs, as in 025_session.sql. db.ts runs migrations with foreign keys off. The kinds instruct,
-- update, and resolve are new. rebase stays for the stack (spec.md section 6.8).
CREATE TABLE task_step_new (
  id INTEGER PRIMARY KEY, task INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  part INTEGER REFERENCES task_part (id) ON DELETE CASCADE, ord INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interview','spec','tests','implement','check','fix','review','commit','push','pr','retarget','rebase','replan','question','spec_change','size','instruct','update','resolve')),
  run INTEGER REFERENCES review_run (id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','running','ok','failed','cancelled','skipped')),
  attempt INTEGER NOT NULL DEFAULT 1, item TEXT, detail_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL, ended_at INTEGER
);

INSERT INTO task_step_new (id, task, part, ord, kind, run, state, attempt, item, detail_json, started_at, ended_at)
  SELECT id, task, part, ord, kind, run, state, attempt, item, detail_json, started_at, ended_at FROM task_step;

DROP TABLE task_step;
ALTER TABLE task_step_new RENAME TO task_step;

-- spec.md section 6.18.5: properties.mergeResult of the synced PR as JSON {outcome, current}. NULL: the server named none. A table of its
-- own, as pr_branch_link in 017_branch_links.sql: an ALTER of pull_request makes the migration check every child table of pull_request,
-- so an old orphan row there would block the upgrade (db.ts touched).
CREATE TABLE pr_merge_result (
  pr INTEGER PRIMARY KEY REFERENCES pull_request (id) ON DELETE CASCADE,
  merge_result TEXT
);
