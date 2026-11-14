// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task part of a PR (docs/plans/review-v2/ps6-ps7-plan.md section 1 item 11).
import type { Database } from "bun:sqlite";
import type { TaskSize } from "../../shared/task";
import { docNames } from "./plan";

// A live task PR: the PR of a task_part or task_pr row whose part is not adopted and whose task is not done or failed. The newest
// part wins. main: the PR is task_part.pr, so its branch holds the plan files. plan: the repository paths of the plan files.
export type LiveTaskPart = { task: number; key: string; part: number; main: boolean; plan: string[] };

const LIVE = `SELECT t.id AS task, t.key, p.id AS part, p.pr = $pr AS main, COALESCE(p.spec_dir, t.spec_dir) AS specDir, t.size
  FROM task_part p JOIN task t ON t.id = p.task
  WHERE p.adopted = 0 AND t.state NOT IN ('done', 'failed')
    AND (p.pr = $pr OR EXISTS (SELECT 1 FROM task_pr x WHERE x.part = p.id AND x.pr = $pr))
  ORDER BY p.id DESC LIMIT 1`;

// The same path as "<spec_dir>/<name>.md" in tasks/loop.ts specPath.
const specPath = (specDir: string, name: string) => `${specDir.replace(/\/+$/, "")}/${name}.md`;

export function liveTaskPart(db: Database, pr: number): LiveTaskPart | null {
  const r = db.query(LIVE).get({ pr }) as {
    task: number;
    key: string;
    part: number;
    main: number | null;
    specDir: string;
    size: TaskSize | null;
  } | null;
  if (!r) return null;
  // A task without a size has no plan files yet.
  const plan = r.size === null ? [] : docNames(r.size).map((n) => specPath(r.specDir, n));
  return { task: r.task, key: r.key, part: r.part, main: r.main === 1, plan };
}

// AC-B396: the refusal of Fix and of the Apply of a fix run on a live task PR.
export const taskPrText = (key: string) => `This PR belongs to task ${key}. Fix its comments from the Task view.`;
