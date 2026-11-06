-- docs/plans/review-v2/spec.md section 6.21.1: "Claude may run the approved checks". 1: each build, test, and lint command of plain words
-- becomes an allow rule of the shell steps. Off by default, because the switch needs the shell warning.
ALTER TABLE repo_task_settings ADD COLUMN run_checks INTEGER NOT NULL DEFAULT 0 CHECK (run_checks IN (0, 1));
