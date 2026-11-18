-- docs/plans/review-v2/jira-context.md section 4.3: the fetch state of a task key that task_context cannot show. No row: none, or
-- fetched when a task_context row exists. kind: the ContextErrorKind of a failed read, only for 'failed'. at: ms.
CREATE TABLE task_fetch (
  pr INTEGER NOT NULL REFERENCES pull_request (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('failed', 'skipped')),
  kind TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (pr, key),
  CHECK ((state = 'failed') = (kind IS NOT NULL))
) WITHOUT ROWID;
