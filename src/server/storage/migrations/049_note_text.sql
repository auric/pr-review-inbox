-- PR notes have no length limit and no count cap. The zod input schema holds the only size guard.
-- SQLite cannot drop a CHECK, so pr_note is rebuilt with its column order and its index. No table refers to it.
CREATE TABLE pr_note_new (
  id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL REFERENCES pull_request (id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) >= 1),
  source TEXT NOT NULL CHECK (source IN ('user','claude')),
  state TEXT NOT NULL CHECK (state IN ('kept','proposed','dismissed')),
  thread INTEGER,
  run INTEGER REFERENCES review_run (id) ON DELETE SET NULL,
  item INTEGER REFERENCES review_item (id) ON DELETE SET NULL,
  ref_project TEXT, ref_repo TEXT, ref_pr INTEGER, ref_title TEXT,
  ref_state TEXT CHECK (ref_state IN ('OPEN','MERGED','DECLINED','MISSING')),
  ref_checked_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  CHECK (source = 'claude' OR state = 'kept'),
  CHECK ((ref_pr IS NULL) = (ref_project IS NULL) AND (ref_pr IS NULL) = (ref_repo IS NULL))
);

INSERT INTO pr_note_new (id, pr, text, source, state, thread, run, item, ref_project, ref_repo, ref_pr, ref_title, ref_state,
    ref_checked_at, version, created_at, updated_at, deleted_at)
  SELECT id, pr, text, source, state, thread, run, item, ref_project, ref_repo, ref_pr, ref_title, ref_state, ref_checked_at, version,
    created_at, updated_at, deleted_at
  FROM pr_note;

DROP TABLE pr_note;
ALTER TABLE pr_note_new RENAME TO pr_note;
CREATE INDEX pr_note_pr ON pr_note (pr, created_at) WHERE deleted_at IS NULL;
