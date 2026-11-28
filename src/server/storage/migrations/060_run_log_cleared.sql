-- Audit S2: the start-up cleanup clears raw_output and the run_event rows of the runs of long-archived PRs.
-- log_cleared_at: the time of that cleanup. NULL: the run keeps its log.
ALTER TABLE review_run ADD COLUMN log_cleared_at INTEGER;
