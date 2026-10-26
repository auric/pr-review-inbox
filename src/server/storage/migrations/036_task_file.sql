-- docs/plans/review-v2/spec.md section 6.17: the Jira attachments that a task downloaded. A row exists only for a downloaded file.
-- att_id: the source ID, digits only. file: the path under <dataDir>/attachments. image, text, pdf, include: 1 or 0. downloaded_at: ms.
-- include: Claude gets the file in each step of the task. The PR brief keeps its own rows in task_attachment.
CREATE TABLE task_file (
  task INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  att_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  file TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  image INTEGER NOT NULL,
  text INTEGER NOT NULL,
  pdf INTEGER NOT NULL,
  include INTEGER NOT NULL DEFAULT 0,
  downloaded_at INTEGER NOT NULL,
  PRIMARY KEY (task, att_id)
) WITHOUT ROWID;
