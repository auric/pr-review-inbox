-- SQLite cannot change a CHECK, so event is rebuilt as in 041_build_status.sql, with its column order and row IDs. No table refers to event.
-- ref: the review_run ID (run_finished, run_failed).
CREATE TABLE event_new (
  id INTEGER PRIMARY KEY,
  pr INTEGER NOT NULL REFERENCES pull_request (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('comment_new', 'commits_pushed', 'reviewer_added', 'draft_stale', 'build_failed', 'build_passed', 'run_finished', 'run_failed')),
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
