-- docs/plans/review-v2/part-session.md section 5.3: the Claude session of one part. A side table, as pr_merge_result is, so no child
-- table of task_part needs a check (spec.md section 6.18.6). file: the absolute path of the kept transcript; file_sha256 its hash.
-- heads_json: [{taskRepo, head}] of each worktree at the last point where the app brought the session up to date. context_tokens:
-- the context size of the last run; NULL is unknown. totals_json: the usage totals of the session (U107). ci_fix_left and ci_fix_max:
-- the red-build fixes of section 2.15. Section 9.4 rule 8 keeps resumeAt and armed in the usage reason, so this table has no columns
-- for them.
CREATE TABLE task_part_session (
  part INTEGER PRIMARY KEY REFERENCES task_part (id) ON DELETE CASCADE,
  session_id TEXT,
  file TEXT,
  file_sha256 TEXT,
  heads_json TEXT NOT NULL DEFAULT '[]',
  context_tokens INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  totals_json TEXT,
  ci_fix_left INTEGER,
  ci_fix_max INTEGER,
  updated_at INTEGER NOT NULL
);
