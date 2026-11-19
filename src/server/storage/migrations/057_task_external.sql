-- docs/plans/task-builder-v2.md sections 5.2 and 11.4: the checklist of the steps outside Claude. part: the plan part number that the
-- step follows, NULL for the whole task. plan_task: the plan task that a build run moved here (`[-]` in the plan file), NULL for a step
-- of the approved plan. by: 'user' or 'app', the actor of the last state change. at: ms of that change. The kind is not checked here,
-- so a new kind needs no table rebuild.
CREATE TABLE task_external (
  id INTEGER PRIMARY KEY,
  task INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
  part INTEGER,
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  plan_task TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'waived')),
  by TEXT CHECK (by IN ('user', 'app')),
  at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (task, ord)
);
CREATE UNIQUE INDEX task_external_moved ON task_external (task, plan_task) WHERE plan_task IS NOT NULL;
