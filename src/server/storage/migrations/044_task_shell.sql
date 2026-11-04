-- docs/plans/review-v2/spec.md section 6.21: the commands that Claude may run with the Bash tool. allow_json: the allowlist entries.
-- shell_warned_at: the first-use warning of these commands was accepted then. bash_timeout_sec: the time limit of one command.
ALTER TABLE repo_task_settings ADD COLUMN shell_mode TEXT NOT NULL DEFAULT 'allowlist' CHECK (shell_mode IN ('allowlist', 'any'));
ALTER TABLE repo_task_settings ADD COLUMN allow_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE repo_task_settings ADD COLUMN shell_warned_at INTEGER;
ALTER TABLE repo_task_settings ADD COLUMN bash_timeout_sec INTEGER NOT NULL DEFAULT 600 CHECK (bash_timeout_sec BETWEEN 1 AND 3600);
