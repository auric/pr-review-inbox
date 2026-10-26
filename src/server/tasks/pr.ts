// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// "Open the PR" of a task part (docs/plans/review-v2/spec.md sections 6.8, 6.9, and 6.12) and the part diff of the Diff tab. The push
// and the PR create run only on the user's click: the route is that click. push.ts refuses the target branch and every branch that is
// not a part branch of the task before git runs.
import type { Database } from "bun:sqlite";
import type { TaskDiffDto } from "../../shared/dto";
import { ForgeError } from "../bitbucket/client";
import { writeProblem } from "../bitbucket/errors";
import { followKey } from "../inbox/queries";
import type { Live } from "../live";
import { log } from "../log";
import { AI_MARK } from "../publish/plan";
import { parseDiff } from "../review/diffmap";
import { git } from "../review/git";
import type { ReviewJobs } from "../review/jobs";
import { type BranchRemote, cachePath, diffArgs, gitSetup, longPath, noUrl } from "../review/workspace";
import type { Settings } from "../settings";
import { endStep, insertStep } from "./implement";
import type { Plan } from "./plan";
import { preflight } from "./preflight";
import { pushTaskBranch } from "./push";
import { taskRepos } from "./repos";
import { advance, advancePart, docsOf, TASK_CHANGED, type TaskResult, type TaskRow, taskDto, taskRow, taskSettingsOf } from "./tasks";

const MAX_ROWS = 2000;
const MAX_LINE = 2000;
const DIFF_MS = 60_000;

type PartRow = {
  id: number;
  ord: number;
  kind: string;
  title: string;
  branch: string;
  state: string;
  head: string | null;
  pushed: string | null;
  pr: number | null;
  remote_pr: number | null;
};

const Q = {
  part: "SELECT id, ord, kind, title, branch, state, head, pushed, pr, remote_pr FROM task_part WHERE id = $part AND task = $task",
  branches: "SELECT branch FROM task_part WHERE task = $task",
  // The code parts that wait for their PR after this one opens. None left: LAST_PR_OPEN.
  unopened:
    "SELECT 1 FROM task_part WHERE task = $task AND id <> $part AND kind <> 'spec' AND state IN ('planned', 'implementing', 'self_reviewed')",
  pushed: "UPDATE task_part SET pushed = $commit, updated_at = $now WHERE id = $id",
  linked: "UPDATE task_part SET pr = $pr, remote_pr = $remote, updated_at = $now WHERE id = $id",
  busy: "SELECT 1 FROM task_step WHERE task = $id AND state IN ('waiting', 'running')",
};

// spec.md section 6.9, the PR text: title "<KEY>: <title>", and a description with the goal, the acceptance criteria, and the tests of
// the plan. The mark follows the markAi setting.
export function prText(t: Pick<TaskRow, "key" | "title" | "spec_dir">, plan: Plan, mark: boolean, file: string) {
  const out: string[] = [];
  for (const p of plan.parts) {
    out.push(plan.parts.length > 1 ? `Part ${p.n}: ${p.goal}` : p.goal, "");
    out.push("Acceptance:", ...p.acceptance.map((a) => `- ${a.id} ${a.text}`), "");
    if (p.tests.length) out.push("Tests:", ...p.tests.map((x) => `- ${x.test}: proves ${x.proves.join(", ")}`), "");
  }
  out.push(`The plan: ${t.spec_dir.replace(/\/+$/, "")}/${file}`);
  const description = out.join("\n");
  return { title: `${t.key}: ${t.title}`, description: mark ? AI_MARK + description : description };
}

export type OpenPrDeps = {
  review: ReviewJobs;
  settings: Settings;
  // true while the build loop works on the task (loop.running).
  working: (id: number) => boolean;
  // Starts a sync cycle, so the new PR shows in My PRs.
  syncNow: () => void;
  live: Pick<Live, "broadcast">;
  now?: () => number;
};

export function createPrOpener(deps: OpenPrDeps) {
  const now = deps.now ?? Date.now;
  // Two tabs that click "Open the PR" run one push and one create. The second click gets 409 while the first one runs.
  const opening = new Set<number>();
  const conflict = (db: Database, id: number, error: string): TaskResult => {
    const t = taskRow(db, id);
    return t ? { status: 409, error, task: taskDto(db, t) } : { status: 404, error: "Task not found." };
  };

  async function open(db: Database, id: number, partId: number, input: { version: number; reviewers: string[] }): Promise<TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    const part = db.query(Q.part).get({ part: partId, task: id }) as PartRow | null;
    if (!part) return { status: 404, error: "Part not found." };
    // spec.md section 6.14: a second "Open PR" gets the same part with its PR.
    if (part.remote_pr !== null && part.state !== "self_reviewed") return { status: 200, task: taskDto(db, t) };
    if (t.version !== input.version) return conflict(db, id, TASK_CHANGED);
    if (opening.has(partId)) return conflict(db, id, "The PR of this part opens now.");
    if (t.state !== "implementing" || t.blocked_json !== null || part.state !== "self_reviewed" || !part.head)
      return conflict(db, id, "This part is not ready for its PR.");
    if (deps.working(id) || db.query(Q.busy).get({ id }))
      return conflict(db, id, "Claude is still working on this task. Wait for the step to end.");
    const docs = docsOf(t);
    if (!docs) return conflict(db, id, "The task has no approved plan.");
    opening.add(partId);
    try {
      return await push(db, t, part, docs.parsed, input.reviewers);
    } finally {
      opening.delete(partId);
      deps.live.broadcast("changed", { tasks: [id] });
    }
  }

  async function push(db: Database, t: TaskRow, part: PartRow, plan: Plan, reviewers: string[]): Promise<TaskResult> {
    const id = t.id;
    const head = part.head as string;
    // The prefix of the plan approval. A part made before spec.md section 6.16 keeps the prefix that its stored branch carries.
    const prefix = taskSettingsOf(t).branchPrefix ?? part.branch.slice(0, Math.max(0, part.branch.indexOf(`${t.key}-`)));
    const step = insertStep(db, { task: id, part: part.id, kind: "push", item: part.branch }, now());
    deps.live.broadcast("changed", { tasks: [id] });
    const fail = (status: 409 | 502, error: string, at = step): TaskResult => {
      endStep(db, at, "failed", { notes: [error] }, now());
      return status === 409 ? conflict(db, id, error) : { status, error };
    };
    let remote: BranchRemote;
    try {
      remote = await deps.review.taskRemote(t.project, t.repo);
    } catch (e) {
      return fail(409, writeProblem(e, "create", { project: t.project, repo: t.repo }).sentence);
    }
    // spec.md section 6.16.7: the pre-flight runs again before each push.
    const main = taskRepos(db, t).find((r) => r.role === "main")?.id ?? 0;
    const pf = await preflight(
      db,
      {
        dataDir: deps.review.dataDir,
        provider: () => deps.settings.provider().catch(() => null),
        remote: (project, repo) => deps.review.taskRemote(project, repo),
        now,
      },
      t,
      part.branch,
      new Map([[main, part.pushed]]),
    );
    if (pf) return fail(409, pf.text);
    const branches = (db.query(Q.branches).all({ task: id }) as { branch: string }[]).map((b) => b.branch);
    let r: Awaited<ReturnType<typeof pushTaskBranch>>;
    try {
      const dataDir = longPath(deps.review.dataDir);
      r = await pushTaskBranch({
        cache: cachePath(dataDir, { project: t.project, repo: t.repo, id }),
        emptyGlobal: gitSetup(dataDir).empty,
        url: remote.url,
        config: remote.config,
        commit: head,
        branch: part.branch,
        lease: part.pushed,
        task: { key: t.key, prefix, branches, target: t.target_branch },
      });
    } catch (e) {
      return fail(502, `The push of ${part.branch} failed: ${noUrl((e as Error).message)}`);
    }
    if (r.status === "refused") return fail(409, r.reason);
    if (r.status === "stale") return fail(409, r.sentence);
    if (r.status === "needs_force")
      return fail(409, `${part.branch} on the server has commits that this part does not have. Get them first.`);
    if (r.status === "failed") return fail(502, `The push of ${part.branch} failed: ${noUrl(r.message)}`);
    db.transaction(() => {
      db.query(Q.pushed).run({ id: part.id, commit: head, now: now() });
      endStep(db, step, "ok", { notes: [`Pushed ${head} to ${part.branch}.`] }, now());
    })();

    const prStep = insertStep(db, { task: id, part: part.id, kind: "pr", item: part.branch }, now());
    deps.live.broadcast("changed", { tasks: [id] });
    const text = prText(t, plan, deps.settings.config()?.markAi ?? true, t.size === "small" ? "plan.md" : "tasks.md");
    let created: { prId: number; dropped: string[] };
    try {
      const provider = await deps.settings.provider();
      if (!provider) return fail(409, "Configure the Bitbucket URL and token first.", prStep);
      const res = await provider.createPullRequest(t.project, t.repo, { ...text, from: part.branch, to: t.target_branch, reviewers });
      created = { prId: res.pr.ref.id, dropped: res.status === "created" ? res.dropped : [] };
    } catch (e) {
      // The step must end in every case, or the task stays busy.
      const message = noUrl((e as Error).message);
      log(`Task ${id}: the PR create of ${part.branch} failed: ${message}`);
      const sentence =
        e instanceof ForgeError
          ? writeProblem(e, "create", { project: t.project, repo: t.repo }).sentence
          : `The PR create failed: ${message}`;
      return fail(502, sentence, prStep);
    }
    // spec.md section 6.10: the task follows its PR, so the sync reads it.
    const row = followKey(db, { project: t.project, repo: t.repo, pr_id: created.prId });
    const error = db.transaction((): string | null => {
      db.query(Q.linked).run({ id: part.id, pr: row.id, remote: created.prId, now: now() });
      const dropped = created.dropped.length ? [`Bitbucket did not add these reviewers: ${created.dropped.join(", ")}.`] : [];
      endStep(db, prStep, "ok", { notes: [`Opened PR #${created.prId} into ${t.target_branch}.`, ...dropped] }, now());
      const cur = taskRow(db, id) as TaskRow;
      const p = advancePart(db, { task: id, version: cur.version, part: part.id }, { type: "PR_OPENED" }, {}, now());
      if (p.status !== 200) return p.error;
      if (db.query(Q.unopened).get({ task: id, part: part.id })) return null;
      const a = advance(db, { task: id, version: p.version }, { type: "LAST_PR_OPEN" }, {}, now());
      return a.status === 200 ? null : a.error;
    })();
    if (error) log(`Task ${id}: PR #${created.prId} is open, but the task state did not move: ${error}`);
    deps.live.broadcast("changed", { prs: [row.id], tasks: [id] });
    deps.syncNow();
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  return { open };
}

// GET /api/tasks/:id/parts/:part/diff: the diff of the part head against the base commit, from the cache of the task.
export async function partDiff(dataDir: string, t: TaskRow, partHead: string | null): Promise<TaskDiffDto | null> {
  if (!t.base_commit || !partHead) return null;
  const dir = longPath(dataDir);
  const { env } = gitSetup(dir);
  const cache = cachePath(dir, { project: t.project, repo: t.repo, id: t.id });
  const text = await git([`--git-dir=${cache}`, "diff", ...diffArgs, t.base_commit, partHead], { env, timeoutMs: DIFF_MS });
  const files = parseDiff(text).map((f) => {
    let added = 0;
    let removed = 0;
    for (const r of f.rows) {
      if (r.kind === "add") added++;
      else if (r.kind === "del") removed++;
    }
    const rows = f.rows.slice(0, MAX_ROWS).map((r) => (r.text.length > MAX_LINE ? { ...r, text: r.text.slice(0, MAX_LINE) } : r));
    return { path: f.path, oldPath: f.oldPath, binary: f.binary, added, removed, rows, more: f.rows.length - rows.length };
  });
  return { base: t.base_commit, head: partHead, files };
}
