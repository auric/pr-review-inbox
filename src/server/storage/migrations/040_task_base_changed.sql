-- docs/plans/review-v2/spec.md section 6.16.7: "Pick a base branch" after the build started. 1: the repository has commits on the old
-- base, so the next update rebases them from base_commit onto the head of the new base_branch. The update sets it back to 0.
ALTER TABLE task_repo ADD COLUMN base_changed INTEGER NOT NULL DEFAULT 0;
