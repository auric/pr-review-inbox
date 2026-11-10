-- docs/plans/review-v2/spec.md section 6.25.2: the reason of a part that waits while the task holds the reason of another part. NULL: no
-- reason waits. task.blocked_json keeps the first reason, so a stored task needs no backfill.
ALTER TABLE task_part ADD COLUMN blocked_json TEXT;
