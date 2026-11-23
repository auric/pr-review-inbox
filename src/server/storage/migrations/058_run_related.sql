-- docs/plans/review-v2/submodule-prs.md section 6 and stacked-prs.md K19: the related context line of a run, a JSON array of
-- { label, text, warn }. NULL for runs made before it, and for runs that read no related context.
ALTER TABLE review_run ADD COLUMN related_json TEXT;
