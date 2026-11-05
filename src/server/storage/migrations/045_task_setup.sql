-- docs/plans/review-v2/spec.md section 6.3: task_cache gives each app-run command REVIEW_LOOP_TASK_CACHE, one folder per task.
-- Setup gets 60 min by default. A stored setup command with 600 s has the old default, because no editor could set the time before.
ALTER TABLE repo_task_settings ADD COLUMN task_cache INTEGER NOT NULL DEFAULT 0 CHECK (task_cache IN (0, 1));
UPDATE repo_task_settings SET commands_json = (
    SELECT json_group_array(
      CASE WHEN json_extract(value, '$.kind') = 'setup' AND json_extract(value, '$.timeoutSec') = 600
        THEN json_set(value, '$.timeoutSec', 3600) ELSE json(value) END ORDER BY key)
    FROM json_each(repo_task_settings.commands_json))
  WHERE json_valid(commands_json) AND EXISTS (
    SELECT 1 FROM json_each(repo_task_settings.commands_json)
    WHERE json_extract(value, '$.kind') = 'setup' AND json_extract(value, '$.timeoutSec') = 600);
