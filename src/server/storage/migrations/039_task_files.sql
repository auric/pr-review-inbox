-- docs/plans/review-v2/spec.md section 6.16.8: the changed files of each code PR next to its changed lines, for the dialog row
-- "PROJ/repo · <branch> → <base> · 3 files, 42 lines". NULL until the next line count of the part.
ALTER TABLE task_part ADD COLUMN files INTEGER;
ALTER TABLE task_pr ADD COLUMN files INTEGER;
