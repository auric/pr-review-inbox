-- docs/plans/review-v2/spec.md section 6.16.9: the repositories of a task and the code PRs of the repositories other than the main one.
-- source: the earlier row of the same repository, for a submodule that names it a second time (spec.md section 6.16.5).
CREATE TABLE task_repo (
  id INTEGER PRIMARY KEY, task INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('main','submodule','added')),
  project TEXT, repo TEXT,
  url TEXT,
  parent INTEGER REFERENCES task_repo (id) ON DELETE CASCADE, path TEXT, depth INTEGER NOT NULL DEFAULT 0,
  access TEXT NOT NULL CHECK (access IN ('edit','read','none')), reason TEXT,
  base_branch TEXT, base_commit TEXT, pinned TEXT,
  proposal TEXT CHECK (proposal IN ('proposed','added','skipped')), proposal_reason TEXT,
  source INTEGER REFERENCES task_repo (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX task_repo_one ON task_repo (task, project, repo) WHERE project IS NOT NULL;

CREATE TABLE task_pr (
  id INTEGER PRIMARY KEY, part INTEGER NOT NULL REFERENCES task_part (id) ON DELETE CASCADE,
  task_repo INTEGER NOT NULL REFERENCES task_repo (id) ON DELETE CASCADE,
  branch TEXT NOT NULL, base_branch TEXT NOT NULL, base_commit TEXT NOT NULL,
  head TEXT, pushed TEXT, lines INTEGER,
  pr INTEGER REFERENCES pull_request (id) ON DELETE SET NULL, remote_pr INTEGER,
  state TEXT NOT NULL CHECK (state IN ('changed','pushed','pr_open','merged','declined','failed')),
  error TEXT, pointer_state TEXT CHECK (pointer_state IN ('task_branch','merged_commit')),
  UNIQUE (part, task_repo)
);

-- Every task has its main repository row.
INSERT INTO task_repo (task, role, project, repo, depth, access, base_branch, base_commit, created_at)
  SELECT id, 'main', project, repo, 0, 'edit', target_branch, base_commit, created_at FROM task;
