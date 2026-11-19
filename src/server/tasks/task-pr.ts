// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task part of a PR (docs/plans/review-v2/ps6-ps7-plan.md section 1 item 11).
import type { Database } from "bun:sqlite";
import type { TaskPartDto } from "../../shared/dto";
import type { ReplyPayload } from "../../shared/review";
import type { TaskSize } from "../../shared/task";
import { byThread, type TurnMsg, threadTurn } from "../../shared/turn";
import { threadPlace } from "../review/context-files";
import { currentDrafts } from "../review/drafts";
import { docNames } from "./plan";
import { partsPlan } from "./tasks";

// A live task PR: the PR of a task_part or task_pr row whose part is not adopted and whose task is not done or failed. The newest
// part wins. main: the PR is task_part.pr, so its branch holds the plan files. plan: the repository paths of the plan files.
export type LiveTaskPart = { task: number; key: string; part: number; main: boolean; plan: string[] };

const LIVE = `SELECT t.id AS task, t.key, p.id AS part, p.pr = $pr AS main, COALESCE(p.spec_dir, t.spec_dir) AS specDir, t.size,
    t.subtasks, t.settings_json
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
    subtasks: number;
    settings_json: string;
  } | null;
  if (!r) return null;
  // A task without a size has no plan files yet. A part of a parts plan holds the plan.md of its slice.
  const plan = r.size === null ? [] : docNames(partsPlan(r) ? "small" : r.size).map((n) => specPath(r.specDir, n));
  return { task: r.task, key: r.key, part: r.part, main: r.main === 1, plan };
}

// AC-B396: the refusal of Fix and of the Apply of a fix run on a live task PR.
export const taskPrText = (key: string) => `This PR belongs to task ${key}. Fix its comments from the Task view.`;

// ---------- PR comments of a task part (docs/plans/review-v2/ps6-ps7-plan.md section 4, PS6-B) ----------

// Item 8: the newest reply run of the PR. An instruct row of the part whose comments name that run sent it.
const SORT = {
  newest: `SELECT id FROM review_run WHERE pr = $pr AND kind = 'reply' AND status IN ('completed', 'incomplete') ORDER BY id DESC LIMIT 1`,
  sent: `SELECT 1 FROM task_step WHERE part = $part AND kind = 'instruct' AND json_extract(detail_json, '$.instruct.comments.run') = $run`,
  items: `SELECT id, thread, body, payload_json FROM review_item
    WHERE run = $run AND kind = 'reply' AND status IN ('new', 'accepted') AND thread IS NOT NULL ORDER BY thread, id`,
  role: "SELECT my_role FROM pull_request WHERE id = $pr",
  turns: `SELECT comment_id AS id, root_id AS rootId, author_slug AS authorSlug, author_login AS authorLogin, created_at AS createdAt,
      tombstoned_at IS NOT NULL AS deleted, thread_resolved AS threadResolved FROM comment WHERE pr = $pr`,
  root: "SELECT anchor_json, excerpt_json FROM comment WHERE pr = $pr AND comment_id = $thread",
};

// The groups of a sort, by number. A thread without a group gets its own number after the highest group, in thread order.
export function groupsOf<T extends { group: number | null }>(threads: readonly T[]): { n: number; threads: T[] }[] {
  let next = Math.max(0, ...threads.map((t) => t.group ?? 0));
  const out = new Map<number, T[]>();
  for (const t of threads) {
    const n = t.group ?? ++next;
    out.set(n, [...(out.get(n) ?? []), t]);
  }
  return [...out].sort((a, b) => a[0] - b[0]).map(([n, list]) => ({ n, threads: list }));
}

// A thread of the sorted run: its open reply draft of that run. One draft per thread: the newest.
export type SortedThread = { thread: number; item: number; body: string; payload: ReplyPayload };

// The sorted run of the main PR of a part that no comment run sent yet, with its open drafts. null: none.
export function sortedRun(db: Database, part: number, pr: number): { run: number; threads: SortedThread[] } | null {
  const r = db.query(SORT.newest).get({ pr }) as { id: number } | null;
  if (!r || db.query(SORT.sent).get({ part, run: r.id })) return null;
  const rows = db.query(SORT.items).all({ run: r.id }) as { id: number; thread: number; body: string; payload_json: string }[];
  const by = new Map<number, SortedThread>();
  for (const x of rows)
    by.set(x.thread, { thread: x.thread, item: x.id, body: x.body, payload: JSON.parse(x.payload_json) as ReplyPayload });
  return { run: r.id, threads: [...by.values()] };
}

// TaskPartDto.comments of one part. me: the user slug of the settings.
export function partComments(db: Database, part: { id: number; pr: number | null }, me: string | null): TaskPartDto["comments"] {
  if (part.pr === null) return null;
  const pr = part.pr;
  const live = liveTaskPart(db, pr);
  if (!live?.main || live.part !== part.id) return null;
  const author = (db.query(SORT.role).get({ pr }) as { my_role: string } | null)?.my_role === "AUTHOR";
  type Row = Omit<TurnMsg, "deleted" | "threadResolved"> & { deleted: number; threadResolved: number };
  const rows = (db.query(SORT.turns).all({ pr }) as Row[]).map((m) => ({
    ...m,
    deleted: m.deleted === 1,
    threadResolved: m.threadResolved === 1,
  }));
  const turn = [...byThread(rows).values()].filter((t) => threadTurn(t, me, author) === "your").length;
  const accepted = [...currentDrafts(db, pr).values()].filter((d) => d.status === "accepted").length;
  const s = sortedRun(db, part.id, pr);
  const sorted = s && {
    run: s.run,
    groups: groupsOf(s.threads.map((t) => ({ ...t, group: t.payload.group ?? null }))).map((g) => ({
      n: g.n,
      threads: g.threads.map((t) => {
        const root = db.query(SORT.root).get({ pr, thread: t.thread }) as {
          anchor_json: string | null;
          excerpt_json: string | null;
        } | null;
        return {
          thread: t.thread,
          place: threadPlace(root?.anchor_json ?? null, root?.excerpt_json ?? null).place,
          judgement: t.payload.judgement ?? null,
          body: t.body,
          item: t.item,
        };
      }),
    })),
  };
  return { turn, sorted, accepted };
}

// ps6-ps7-plan.md section 3: the refusal of a part route that needs the main PR of a live task part.
export const NO_TASK_PR = "This part has no PR of the app.";
