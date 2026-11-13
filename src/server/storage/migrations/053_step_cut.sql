-- docs/plans/review-v2/part-session.md section 2.5: the git state at the start of a Claude run and the inputs of its path check, as JSON
-- (implement.ts cutJson). The start transaction of the run writes it, the run end clears it, and the restart recovery reads it for a
-- cut run. It replaces the file part-<n>.gitsnap.json, which a Bash command of the run could change.
ALTER TABLE task_step ADD COLUMN cut_json TEXT;
