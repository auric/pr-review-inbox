-- Write description: a run of kind describe proposes a title and a description for an own pull request.
-- SQLite cannot change a CHECK, so review_run is rebuilt with its column order and row IDs, as in 033_task.sql.
-- db.ts runs migrations with foreign keys off, so DROP TABLE keeps the child rows.
-- describe_json: the validated result of a describe run. NULL for other runs, and after Discard or Update on Bitbucket.
CREATE TABLE review_run_new (
  id INTEGER PRIMARY KEY,
  pr INTEGER REFERENCES pull_request (id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  note TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  source_head TEXT NOT NULL,
  target_head TEXT NOT NULL,
  merge_base TEXT,
  fetch_via TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'incomplete', 'failed', 'cancelled')),
  error_kind TEXT CHECK (error_kind IN ('usage_limit', 'auth', 'max_turns', 'schema', 'tool_check', 'workspace', 'process', 'restart')),
  error_text TEXT,
  session_id TEXT,
  cli_version TEXT,
  model TEXT,
  usage_json TEXT,
  summary_json TEXT,
  raw_output TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'review'
    CHECK (kind IN ('review', 'reply', 'ask', 'fix', 'consult', 'session', 'explain', 'discuss', 'interview', 'spec', 'implement', 'describe')),
  profile_name TEXT,
  profile_revision TEXT,
  explain INTEGER,
  since_head TEXT,
  range_base TEXT,
  question TEXT,
  answer TEXT,
  fix_json TEXT,
  tasks_json TEXT,
  effort TEXT,
  effort_default TEXT,
  instructions_json TEXT,
  skills_json TEXT,
  consult_json TEXT,
  prompt_version TEXT,
  item INTEGER REFERENCES review_item (id) ON DELETE SET NULL,
  discuss_json TEXT,
  explain_json TEXT,
  parent_run INTEGER REFERENCES review_run (id) ON DELETE SET NULL,
  task INTEGER REFERENCES task (id) ON DELETE CASCADE,
  related_json TEXT,
  describe_json TEXT,
  CHECK (pr IS NOT NULL OR task IS NOT NULL)
);

INSERT INTO review_run_new (id, pr, profile, note, idem_key, source_head, target_head, merge_base, fetch_via, status, error_kind, error_text,
    session_id, cli_version, model, usage_json, summary_json, raw_output, started_at, finished_at, kind, profile_name, profile_revision, explain,
    since_head, range_base, question, answer, fix_json, tasks_json, effort, effort_default, instructions_json, skills_json, consult_json,
    prompt_version, item, discuss_json, explain_json, parent_run, task, related_json)
  SELECT id, pr, profile, note, idem_key, source_head, target_head, merge_base, fetch_via, status, error_kind, error_text,
    session_id, cli_version, model, usage_json, summary_json, raw_output, started_at, finished_at, kind, profile_name, profile_revision, explain,
    since_head, range_base, question, answer, fix_json, tasks_json, effort, effort_default, instructions_json, skills_json, consult_json,
    prompt_version, item, discuss_json, explain_json, parent_run, task, related_json
  FROM review_run;

DROP TABLE review_run;
ALTER TABLE review_run_new RENAME TO review_run;

CREATE UNIQUE INDEX review_run_running ON review_run (idem_key) WHERE status = 'running';
CREATE INDEX review_run_pr ON review_run (pr, id);
CREATE INDEX review_run_item ON review_run (item) WHERE item IS NOT NULL;
CREATE UNIQUE INDEX review_run_parent ON review_run (parent_run) WHERE parent_run IS NOT NULL;
CREATE INDEX review_run_task ON review_run (task, id) WHERE task IS NOT NULL;
