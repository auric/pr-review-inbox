-- docs/plans/review-v2/spec.md section 6.20.8: build the Jira sub-tasks of a task, one PR per part.
-- task.subtasks: 1 builds the Jira sub-tasks of task.key, one PR per part. task.size is small then.
ALTER TABLE task ADD COLUMN subtasks INTEGER NOT NULL DEFAULT 0;
-- One row per sub-task of the parent. category: statusCategory.key of Jira. issue_json: IssueContext of the last read (NULL for a
-- done sub-task). links_json: [{text, key}] links to other sub-tasks of the parent. found_json: branches and PRs that name the key.
-- removed_at: the status read no longer lists the key.
CREATE TABLE task_subtask (
  task INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  key TEXT NOT NULL, ord INTEGER NOT NULL, summary TEXT NOT NULL,
  status TEXT, category TEXT CHECK (category IN ('new','indeterminate','done')),
  issue_json TEXT, links_json TEXT NOT NULL DEFAULT '[]', found_json TEXT NOT NULL DEFAULT '[]',
  read_at INTEGER NOT NULL, status_at INTEGER, added_at INTEGER, removed_at INTEGER,
  PRIMARY KEY (task, key)
);
-- keys_json: the sub-task keys of the part. start_mode, after_part: section 6.20.6. base_commit: the branch point of the part; NULL
-- takes task.base_commit. spec_dir: the plan folder of the part; NULL takes task.spec_dir. adopted: 1 for a PR that the app did not
-- create; the app never pushes to its branch. override: the user started a part that builds on an unapproved PR.
ALTER TABLE task_part ADD COLUMN keys_json TEXT;
ALTER TABLE task_part ADD COLUMN start_mode TEXT CHECK (start_mode IN ('base','stack','merge'));
ALTER TABLE task_part ADD COLUMN after_part INTEGER REFERENCES task_part (id) ON DELETE SET NULL;
ALTER TABLE task_part ADD COLUMN base_commit TEXT;
ALTER TABLE task_part ADD COLUMN spec_dir TEXT;
ALTER TABLE task_part ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_part ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
-- issue: the Jira key of the file. NULL is the task key.
ALTER TABLE task_file ADD COLUMN issue TEXT;
