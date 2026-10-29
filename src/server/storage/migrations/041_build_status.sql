-- docs/plans/ci-builds.md, Layer A: the Bitbucket build status of the source head of an open PR, read during the sync. A table of its own,
-- as pr_merge_result in 037_task_update.sql: an ALTER of pull_request makes the migration check every child table of pull_request.
-- head: the commit of the read. stats_json: the counts of the stats GET. builds_json: at most 10 statuses {name, state, url}; NULL when
-- the list read failed. read_at: ms of the read.
CREATE TABLE pr_build (
  pr INTEGER PRIMARY KEY REFERENCES pull_request (id) ON DELETE CASCADE,
  head TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  builds_json TEXT,
  read_at INTEGER NOT NULL
);

-- SQLite cannot change a CHECK, so event is rebuilt as in 029_draft_stale.sql, with its column order and row IDs. No table refers to event.
-- ref: the source head (build_failed, build_passed).
CREATE TABLE event_new (
  id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL REFERENCES pull_request (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('comment_new', 'commits_pushed', 'reviewer_added', 'draft_stale', 'build_failed', 'build_passed')),
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  digest INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  UNIQUE (pr, kind, ref)
);

INSERT INTO event_new (id, pr, kind, ref, created_at, digest, claimed_at) SELECT id, pr, kind, ref, created_at, digest, claimed_at FROM event;

DROP TABLE event;
ALTER TABLE event_new RENAME TO event;

CREATE INDEX event_unclaimed ON event (id) WHERE claimed_at IS NULL;
