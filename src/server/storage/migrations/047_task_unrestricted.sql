-- docs/plans/review-v2/spec.md section 6.21.1: the shell mode 'unrestricted' (user decision of 2026-11-06).
-- SQLite cannot change a CHECK, so repo_task_settings is rebuilt with its column order. No table refers to it.
CREATE TABLE repo_task_settings_new (
  project TEXT NOT NULL, repo TEXT NOT NULL,
  spec_dir TEXT NOT NULL DEFAULT 'specs/{key}/', branch_prefix TEXT NOT NULL DEFAULT 'feature/',
  line_budget INTEGER NOT NULL DEFAULT 400, max_open INTEGER NOT NULL DEFAULT 2, approvals INTEGER NOT NULL DEFAULT 1,
  commands_json TEXT NOT NULL DEFAULT '[]', test_globs_json TEXT, exclude_globs_json TEXT,
  isolate_home INTEGER NOT NULL DEFAULT 1, warned_at INTEGER, updated_at INTEGER NOT NULL,
  last_base TEXT,
  shell_mode TEXT NOT NULL DEFAULT 'allowlist' CHECK (shell_mode IN ('allowlist', 'any', 'unrestricted')),
  allow_json TEXT NOT NULL DEFAULT '[]',
  shell_warned_at INTEGER,
  bash_timeout_sec INTEGER NOT NULL DEFAULT 600 CHECK (bash_timeout_sec BETWEEN 1 AND 3600),
  task_cache INTEGER NOT NULL DEFAULT 0 CHECK (task_cache IN (0, 1)),
  run_checks INTEGER NOT NULL DEFAULT 0 CHECK (run_checks IN (0, 1)),
  PRIMARY KEY (project, repo)
);

INSERT INTO repo_task_settings_new (project, repo, spec_dir, branch_prefix, line_budget, max_open, approvals, commands_json,
    test_globs_json, exclude_globs_json, isolate_home, warned_at, updated_at, last_base, shell_mode, allow_json, shell_warned_at,
    bash_timeout_sec, task_cache, run_checks)
  SELECT project, repo, spec_dir, branch_prefix, line_budget, max_open, approvals, commands_json, test_globs_json, exclude_globs_json,
    isolate_home, warned_at, updated_at, last_base, shell_mode, allow_json, shell_warned_at, bash_timeout_sec, task_cache, run_checks
  FROM repo_task_settings;

DROP TABLE repo_task_settings;
ALTER TABLE repo_task_settings_new RENAME TO repo_task_settings;
