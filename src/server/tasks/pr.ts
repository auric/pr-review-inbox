// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// "Open the PR" of a task part (docs/plans/review-v2/spec.md sections 6.8, 6.9, 6.12, and 6.16.8) and the part diff of the Diff tab.
// The pushes and the PR creates run only on the user's click: the routes are that click. push.ts refuses the target branch and every
// branch that is not a part branch of the task before git runs. With several repositories, all pushes run first, deepest first, then
// the creates, submodules first, and each description links the other PRs. "Point <parent> at the merged commit" commits the gitlink
// of a merged submodule and pushes the parent, also only on its click.
import type { Database } from "bun:sqlite";
import type { TaskDiffDto } from "../../shared/dto";
import { TASK_STATE_TEXT } from "../../shared/task";
import type { PullRequest } from "../../shared/types";
import { ForgeError } from "../bitbucket/client";
import { writeProblem } from "../bitbucket/errors";
import type { ForgeProvider } from "../bitbucket/provider";
import { followKey } from "../inbox/queries";
import type { Live } from "../live";
import { log } from "../log";
import { AI_MARK } from "../publish/plan";
import { identity } from "../review/clone";
import { parseDiff } from "../review/diffmap";
import { git } from "../review/git";
import type { ReviewJobs } from "../review/jobs";
import { type BranchRemote, cachePath, diffArgs, gitSetup, longPath, noUrl } from "../review/workspace";
import type { Settings } from "../settings";
import { endStep, insertStep } from "./implement";
import type { Plan } from "./plan";
import { commitGitlink, noMergeText, pointerTarget } from "./pointer";
import { type PreflightDeps, preflight } from "./preflight";
import { type PushResult, pushTaskBranch } from "./push";
import { fullPath, type PrRow, prRows, type TaskRepoRow, taskRepos } from "./repos";
import { advance, advancePart, docsOf, TASK_CHANGED, type TaskResult, type TaskRow, taskDto, taskRow, taskSettingsOf } from "./tasks";

const MAX_ROWS = 2000;
const MAX_LINE = 2000;
const DIFF_MS = 60_000;
// spec.md section 6.16.8, Links: the heading of the PR links at the end of each description.
const RELATED = "Related PRs:";
const BUSY = "Claude is still working on this task. Wait for the step to end.";
// The part states with a built head (tasks.ts BUILT).
const BUILT = new Set(["self_reviewed", "pr_open", "changes_requested", "approved"]);

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
  lines: number | null;
  files: number | null;
};

const Q = {
  part: `SELECT id, ord, kind, title, branch, state, head, pushed, pr, remote_pr, lines, files FROM task_part
    WHERE id = $part AND task = $task`,
  branches: "SELECT branch FROM task_part WHERE task = $task",
  // The code parts that wait for their PR after this one opens. None left: LAST_PR_OPEN.
  unopened:
    "SELECT 1 FROM task_part WHERE task = $task AND id <> $part AND kind <> 'spec' AND state IN ('planned', 'implementing', 'self_reviewed')",
  pushed: "UPDATE task_part SET pushed = $commit, updated_at = $now WHERE id = $id",
  linked: "UPDATE task_part SET pr = $pr, remote_pr = $remote, updated_at = $now WHERE id = $id",
  busy: "SELECT 1 FROM task_step WHERE task = $id AND state IN ('waiting', 'running')",
  // spec.md section 6.16.9: the task_pr row of a repository other than the main one.
  subPushed: "UPDATE task_pr SET pushed = $commit, state = 'pushed', error = NULL WHERE part = $part AND task_repo = $repo",
  subFailed: "UPDATE task_pr SET state = 'failed', error = $error WHERE part = $part AND task_repo = $repo",
  subLinked: `UPDATE task_pr SET pr = $pr, remote_pr = $remote, state = 'pr_open', error = NULL, pointer_state = 'task_branch'
    WHERE part = $part AND task_repo = $repo`,
  pointerRow: `SELECT p.id, p.part, p.task_repo, p.base_branch, p.remote_pr, p.state, p.pointer_state FROM task_pr p
    JOIN task_part t ON t.id = p.part WHERE p.id = $id AND t.task = $task`,
  repoRow: "SELECT * FROM task_repo WHERE id = $id",
  pointerError: "UPDATE task_pr SET error = $error WHERE id = $id",
  pointed: "UPDATE task_pr SET pointer_state = 'merged_commit', error = NULL WHERE id = $id",
  // After the pointer move, the merge commit is the base of the submodule and its head (spec.md section 6.16.6, Changed repositories).
  moved: "UPDATE task_repo SET pinned = $commit, base_commit = $commit WHERE id = $id",
  subHead: "UPDATE task_pr SET head = $commit WHERE id = $id",
  partHead: "UPDATE task_part SET head = $head, updated_at = $now WHERE id = $id",
  clone: "SELECT path FROM repo_clone WHERE project = $project AND repo = $repo",
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

// spec.md section 6.16.8, Links: the description without an earlier link section, then "Related PRs:" and one line per other PR of the
// task, with its link when Bitbucket gave one of the configured origin.
export function withRelated(description: string, others: { name: string; id: number; url?: string | undefined }[]): string {
  const text = description.replaceAll("\r\n", "\n");
  const at = text.lastIndexOf(`\n\n${RELATED}\n`);
  const body = (at >= 0 ? text.slice(0, at) : text).trimEnd();
  if (!others.length) return body;
  const lines = others.map((o) => (o.url ? `- [${o.name} #${o.id}](${o.url})` : `- ${o.name} #${o.id}`));
  return `${body}\n\n${RELATED}\n${lines.join("\n")}`;
}

// The sentence of a push that did not happen, or null after the push.
function pushSentence(r: PushResult, branch: string): string | null {
  if (r.status === "refused") return r.reason;
  if (r.status === "stale") return r.sentence;
  if (r.status === "needs_force") return `${branch} on the server has commits that this part does not have. Get them first.`;
  if (r.status === "failed") return `The push of ${branch} failed: ${noUrl(r.message)}`;
  return null;
}

const createSentence = (e: unknown, at: { project: string; repo: string }) =>
  e instanceof ForgeError ? writeProblem(e, "create", at).sentence : `The PR create failed: ${noUrl((e as Error).message)}`;

const nameOf = (r: Pick<PrRow, "project" | "repo">) => `${r.project}/${r.repo}`;

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
  // Two tabs that click "Open the PR" run one push and one create. The second click gets 409 while the first one runs. The PR rows and
  // the pointer move of a task share this lock, because they push the same branches.
  const opening = new Set<number>();
  // The PR rows and the pointer moves that run after their 202.
  const running = new Map<number, Promise<void>>();
  const conflict = (db: Database, id: number, error: string): TaskResult => {
    const t = taskRow(db, id);
    return t ? { status: 409, error, task: taskDto(db, t) } : { status: 404, error: "Task not found." };
  };
  const changed = (id: number) => deps.live.broadcast("changed", { tasks: [id] });
  const preflightDeps: PreflightDeps = {
    dataDir: deps.review.dataDir,
    provider: () => deps.settings.provider().catch(() => null),
    remote: (project, repo) => deps.review.taskRemote(project, repo),
    now,
  };
  const fresh = (db: Database, id: number, partId: number) => {
    const t = taskRow(db, id) as TaskRow;
    const part = db.query(Q.part).get({ part: partId, task: id }) as PartRow;
    return { t, part, rows: prRows(db, t, part) };
  };

  async function open(db: Database, id: number, partId: number, input: { version: number; reviewers: string[] }): Promise<TaskResult> {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    const part = db.query(Q.part).get({ part: partId, task: id }) as PartRow | null;
    if (!part) return { status: 404, error: "Part not found." };
    // spec.md section 6.14: a second "Open PR" gets the same part with its PR.
    if (part.remote_pr !== null && part.state !== "self_reviewed") return { status: 200, task: taskDto(db, t) };
    if (t.version !== input.version) return conflict(db, id, TASK_CHANGED);
    if (opening.has(id)) return conflict(db, id, "The PR of this part opens now.");
    if (t.state !== "implementing" || t.blocked_json !== null || part.state !== "self_reviewed" || !part.head)
      return conflict(db, id, "This part is not ready for its PR.");
    if (deps.working(id) || db.query(Q.busy).get({ id })) return conflict(db, id, BUSY);
    const docs = docsOf(t);
    if (!docs) return conflict(db, id, "The task has no approved plan.");
    opening.add(id);
    try {
      return await push(db, t, part, docs.parsed, input.reviewers);
    } finally {
      opening.delete(id);
      changed(id);
    }
  }

  async function push(db: Database, t: TaskRow, part: PartRow, plan: Plan, reviewers: string[]): Promise<TaskResult> {
    const id = t.id;
    const head = part.head as string;
    // The prefix of the plan approval. A part made before spec.md section 6.16 keeps the prefix that its stored branch carries.
    const prefix = taskSettingsOf(t).branchPrefix ?? part.branch.slice(0, Math.max(0, part.branch.indexOf(`${t.key}-`)));
    const step = insertStep(db, { task: id, part: part.id, kind: "push", item: part.branch }, now());
    changed(id);
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
    const pf = await preflight(db, preflightDeps, t, part.branch, new Map([[main, part.pushed]]));
    if (pf) return fail(409, pf.text);
    const branches = (db.query(Q.branches).all({ task: id }) as { branch: string }[]).map((b) => b.branch);
    let r: PushResult;
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
    const refused = pushSentence(r, part.branch);
    if (refused) return fail(r.status === "failed" ? 502 : 409, refused);
    db.transaction(() => {
      db.query(Q.pushed).run({ id: part.id, commit: head, now: now() });
      endStep(db, step, "ok", { notes: [`Pushed ${head} to ${part.branch}.`] }, now());
    })();

    const prStep = insertStep(db, { task: id, part: part.id, kind: "pr", item: part.branch }, now());
    changed(id);
    const text = prText(t, plan, deps.settings.config()?.markAi ?? true, t.size === "small" ? "plan.md" : "tasks.md");
    let created: { prId: number; dropped: string[] };
    try {
      const provider = await deps.settings.provider();
      if (!provider) return fail(409, "Configure the Bitbucket URL and token first.", prStep);
      const res = await provider.createPullRequest(t.project, t.repo, { ...text, from: part.branch, to: t.target_branch, reviewers });
      created = { prId: res.pr.ref.id, dropped: res.status === "created" ? res.dropped : [] };
    } catch (e) {
      // The step must end in every case, or the task stays busy.
      log(`Task ${id}: the PR create of ${part.branch} failed: ${noUrl((e as Error).message)}`);
      return fail(502, createSentence(e, t), prStep);
    }
    linkMain(db, t, part, created, prStep);
    deps.syncNow();
    return { status: 200, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  // The PR of the main repository: the task follows it, so the sync reads it (spec.md section 6.10), and the part and the task move.
  function linkMain(db: Database, t: TaskRow, part: PartRow, created: { prId: number; dropped: string[] }, prStep: number) {
    const id = t.id;
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
  }

  // Runs work after its 202 under the lock of the task. Each end sends one change notice.
  function start(id: number, work: () => Promise<void>) {
    opening.add(id);
    const p = work()
      .catch((e) => log(`Task ${id}: the PR work failed: ${noUrl((e as Error).message)}`))
      .finally(() => {
        opening.delete(id);
        running.delete(id);
        changed(id);
      });
    running.set(id, p);
  }

  // The checks of the PR rows and of the pointer move: the task, its version, its state, and no work on it.
  function ready(db: Database, id: number, version: number): TaskRow | TaskResult {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== version) return conflict(db, id, TASK_CHANGED);
    if (opening.has(id)) return conflict(db, id, "The PRs of this task open now.");
    if (t.state !== "implementing" && t.state !== "ready") return conflict(db, id, TASK_STATE_TEXT[t.state]);
    if (t.blocked_json !== null) return conflict(db, id, (JSON.parse(t.blocked_json) as { text: string }).text);
    if (deps.working(id) || db.query(Q.busy).get({ id })) return conflict(db, id, BUSY);
    return t;
  }

  // POST /api/tasks/:id/parts/:part/prs (spec.md section 6.16.8). The pre-flight runs first. Then all pushes, deepest first, and the
  // creates, submodules first. One row is a retry, and a row with its PR gets no second create.
  async function openRows(
    db: Database,
    id: number,
    partId: number,
    input: { version: number; rows: { taskRepo: number; reviewers: string[] }[] },
  ): Promise<TaskResult> {
    const t = ready(db, id, input.version);
    if ("status" in t) return t;
    const part = db.query(Q.part).get({ part: partId, task: id }) as PartRow | null;
    if (!part) return { status: 404, error: "Part not found." };
    if (!BUILT.has(part.state) || !part.head) return conflict(db, id, "This part is not ready for its PR.");
    if (!docsOf(t)) return conflict(db, id, "The task has no approved plan.");
    const all = prRows(db, t, part);
    const ids = input.rows.map((r) => r.taskRepo);
    if (new Set(ids).size !== ids.length) return { status: 400, error: "Each repository is listed once." };
    for (const x of ids)
      if (!all.some((r) => r.taskRepo === x)) return { status: 400, error: `Repository ${x} has no change in this part.` };
    const want = all.filter((r) => ids.includes(r.taskRepo) && r.remotePr === null).map((r) => r.taskRepo);
    if (!want.length) return { status: 200, task: taskDto(db, t) };
    opening.add(id);
    let pf: Awaited<ReturnType<typeof preflight>>;
    try {
      // spec.md section 6.16.7: the pre-flight before each push, with the lease of each row.
      pf = await preflight(db, preflightDeps, t, part.branch, new Map(all.map((r) => [r.taskRepo, r.pushed])));
    } catch (e) {
      pf = { kind: "preflight", step: null, text: `Needs you: the pre-flight failed. ${noUrl((e as Error).message)}` };
    } finally {
      opening.delete(id);
    }
    if (pf) return conflict(db, id, pf.text);
    const reviewers = new Map(input.rows.map((r) => [r.taskRepo, r.reviewers]));
    start(id, () => runRows(db, id, partId, want, reviewers));
    return { status: 202, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  async function runRows(db: Database, id: number, partId: number, want: number[], reviewers: Map<number, string[]>) {
    const order = fresh(db, id, partId)
      .rows.filter((r) => want.includes(r.taskRepo))
      .map((r) => r.taskRepo);
    for (const taskRepo of order) {
      const { t, part, rows } = fresh(db, id, partId);
      const r = rows.find((x) => x.taskRepo === taskRepo) as PrRow;
      if (r.head && r.pushed === r.head) continue;
      const step = insertStep(db, { task: id, part: partId, kind: "push", item: nameOf(r) }, now());
      changed(id);
      // A parent commit points at the commit of each changed child, so a child that is not on the server stops the parent push. A merged
      // child is on its base branch.
      const child = rows.find((c) => c.parent === r.taskRepo && c.state !== "merged" && (c.head === null || c.pushed !== c.head));
      let error: string | null;
      try {
        error = child ? `${nameOf(r)} waits, because ${nameOf(child)} is not on the server yet.` : await pushOne(db, t, part, r);
      } catch (e) {
        error = `The push of ${r.branch} failed: ${noUrl((e as Error).message)}`;
      }
      db.transaction(() => {
        if (error) {
          endStep(db, step, "failed", { notes: [error] }, now());
          if (r.role !== "main") db.query(Q.subFailed).run({ part: partId, repo: r.taskRepo, error });
          return;
        }
        if (r.role === "main") db.query(Q.pushed).run({ id: partId, commit: r.head, now: now() });
        else db.query(Q.subPushed).run({ part: partId, repo: r.taskRepo, commit: r.head });
        endStep(db, step, "ok", { notes: [`Pushed ${r.head} to ${r.branch} of ${nameOf(r)}.`] }, now());
      })();
      changed(id);
    }
    const provider = await deps.settings.provider().catch(() => null);
    const urls = new Map<number, string>();
    let opened = 0;
    for (const taskRepo of order) {
      const { t, part, rows } = fresh(db, id, partId);
      const r = rows.find((x) => x.taskRepo === taskRepo) as PrRow;
      if (r.remotePr !== null || !r.head || r.pushed !== r.head) continue;
      const step = insertStep(db, { task: id, part: partId, kind: "pr", item: nameOf(r) }, now());
      changed(id);
      try {
        if (!provider) throw new Error("Configure the Bitbucket URL and token first.");
        const docs = docsOf(t) as NonNullable<ReturnType<typeof docsOf>>;
        const text = prText(t, docs.parsed, deps.settings.config()?.markAi ?? true, t.size === "small" ? "plan.md" : "tasks.md");
        const others = rows
          .filter((o) => o !== r && o.remotePr !== null)
          .map((o) => ({ name: nameOf(o), id: o.remotePr as number, url: urls.get(o.taskRepo) }));
        const res = await provider.createPullRequest(r.project, r.repo, {
          title: text.title,
          description: withRelated(text.description, others),
          from: r.branch,
          to: r.baseBranch,
          reviewers: reviewers.get(r.taskRepo) ?? [],
        });
        if (res.pr.webUrl) urls.set(r.taskRepo, res.pr.webUrl);
        const created = { prId: res.pr.ref.id, dropped: res.status === "created" ? res.dropped : [] };
        opened++;
        if (r.role === "main") linkMain(db, t, part, created, step);
        else linkSub(db, id, r, created, step);
      } catch (e) {
        log(`Task ${id}: the PR create of ${r.branch} in ${nameOf(r)} failed: ${noUrl((e as Error).message)}`);
        const error = provider ? createSentence(e, r) : (e as Error).message;
        db.transaction(() => {
          endStep(db, step, "failed", { notes: [error] }, now());
          if (r.role !== "main") db.query(Q.subFailed).run({ part: partId, repo: r.taskRepo, error });
        })();
        changed(id);
      }
    }
    if (opened && provider) await linkRows(db, id, partId, provider, urls);
    if (opened) deps.syncNow();
  }

  // The PR of a submodule or an added repository (spec.md section 6.16.9, task_pr).
  function linkSub(db: Database, id: number, r: PrRow, created: { prId: number; dropped: string[] }, step: number) {
    const row = followKey(db, { project: r.project, repo: r.repo, pr_id: created.prId });
    db.transaction(() => {
      db.query(Q.subLinked).run({ part: r.part, repo: r.taskRepo, pr: row.id, remote: created.prId });
      const dropped = created.dropped.length ? [`Bitbucket did not add these reviewers: ${created.dropped.join(", ")}.`] : [];
      endStep(db, step, "ok", { notes: [`Opened PR #${created.prId} into ${r.baseBranch} of ${nameOf(r)}.`, ...dropped] }, now());
    })();
    deps.live.broadcast("changed", { prs: [row.id], tasks: [id] });
  }

  // One push of a row from the cache of its repository, with the lease of its last push.
  async function pushOne(db: Database, t: TaskRow, part: PartRow, r: PrRow): Promise<string | null> {
    if (r.access !== "edit") return `The token cannot push to ${nameOf(r)}.`;
    if (!r.head) return `${nameOf(r)} has no commit to push.`;
    const prefix = taskSettingsOf(t).branchPrefix ?? part.branch.slice(0, Math.max(0, part.branch.indexOf(`${t.key}-`)));
    const branches = (db.query(Q.branches).all({ task: t.id }) as { branch: string }[]).map((b) => b.branch);
    let remote: BranchRemote;
    try {
      remote = await deps.review.taskRemote(r.project, r.repo);
    } catch (e) {
      return writeProblem(e, "create", { project: r.project, repo: r.repo }).sentence;
    }
    const dataDir = longPath(deps.review.dataDir);
    const res = await pushTaskBranch({
      cache: cachePath(dataDir, { project: r.project, repo: r.repo, id: t.id }),
      emptyGlobal: gitSetup(dataDir).empty,
      url: remote.url,
      config: remote.config,
      commit: r.head,
      branch: r.branch,
      lease: r.pushed,
      task: { key: t.key, prefix, branches, target: r.baseBranch },
    });
    return pushSentence(res, r.branch);
  }

  // spec.md section 6.16.8, Links: after the last create, each open PR of the part lists the other PRs. A fresh read gives the version
  // and the text of each PR; a PR that changed in between keeps its text, and the log says so.
  async function linkRows(db: Database, id: number, partId: number, provider: ForgeProvider, urls: Map<number, string>) {
    const listed = fresh(db, id, partId).rows.filter((r) => r.remotePr !== null);
    if (listed.length < 2) return;
    const read = new Map<number, PullRequest>();
    for (const r of listed)
      try {
        read.set(r.taskRepo, await provider.getPullRequest({ project: r.project, repo: r.repo, id: r.remotePr as number }));
      } catch (e) {
        log(`Task ${id}: cannot read PR #${r.remotePr} of ${nameOf(r)}: ${noUrl((e as Error).message)}`);
      }
    for (const r of listed) {
      const pr = read.get(r.taskRepo);
      if (r.state !== "pr_open" || !pr) continue;
      const others = listed
        .filter((o) => o !== r)
        .map((o) => ({ name: nameOf(o), id: o.remotePr as number, url: read.get(o.taskRepo)?.webUrl ?? urls.get(o.taskRepo) }));
      const before = (pr.description ?? "").replaceAll("\r\n", "\n");
      const description = withRelated(before, others);
      if (description === before) continue;
      try {
        await provider.updatePullRequest(pr.ref, {
          version: pr.version,
          title: pr.title,
          description,
          reviewers: pr.reviewers.map((x) => x.login),
        });
      } catch (e) {
        log(`Task ${id}: the PR links of ${nameOf(r)} #${pr.ref.id} did not change: ${noUrl((e as Error).message)}`);
      }
    }
  }

  // POST /api/tasks/:id/prs/:taskPr/pointer (spec.md section 6.16.8, Pointer after a submodule merge). The merge commit comes from the
  // MERGED activity, else from properties.mergeCommit (Gate G17). Without one, 409 asks for the newest base commit (newest).
  async function pointer(
    db: Database,
    id: number,
    taskPr: number,
    input: { version: number; newest?: true | undefined },
  ): Promise<TaskResult> {
    const t = ready(db, id, input.version);
    if ("status" in t) return t;
    const row = db.query(Q.pointerRow).get({ id: taskPr, task: id }) as {
      id: number;
      part: number;
      task_repo: number;
      base_branch: string;
      remote_pr: number | null;
      state: string;
      pointer_state: string | null;
    } | null;
    if (!row) return { status: 404, error: "PR not found." };
    const sub = db.query(Q.repoRow).get({ id: row.task_repo }) as TaskRepoRow | null;
    const part = db.query(Q.part).get({ part: row.part, task: id }) as PartRow | null;
    if (!sub?.project || !sub.repo || sub.role !== "submodule" || !part?.head || row.remote_pr === null)
      return conflict(db, id, "This PR moves no pointer.");
    const sname = `${sub.project}/${sub.repo}`;
    if (row.pointer_state === "merged_commit") return { status: 200, task: taskDto(db, t) };
    if (row.state !== "merged") return conflict(db, id, `The ${sname} PR is not merged yet.`);
    const provider = await deps.settings.provider().catch(() => null);
    if (!provider) return conflict(db, id, "Configure the Bitbucket URL and token first.");
    let merge: string | null = null;
    if (!input.newest) {
      try {
        merge = await provider.mergeCommit({ project: sub.project, repo: sub.repo, id: row.remote_pr });
      } catch (e) {
        return { status: 502, error: `Cannot read the merge of ${sname} #${row.remote_pr}. ${noUrl((e as Error).message)}` };
      }
      if (!merge) return conflict(db, id, noMergeText(`${t.project}/${t.repo}`, row.base_branch, sname));
    }
    opening.add(id);
    let pf: Awaited<ReturnType<typeof preflight>>;
    try {
      pf = await preflight(db, preflightDeps, t, part.branch, new Map(prRows(db, t, part).map((r) => [r.taskRepo, r.pushed])));
    } catch (e) {
      pf = { kind: "preflight", step: null, text: `Needs you: the pre-flight failed. ${noUrl((e as Error).message)}` };
    } finally {
      opening.delete(id);
    }
    if (pf) return conflict(db, id, pf.text);
    start(id, () => movePointer(db, id, row.id, row.base_branch, sub, part.id, merge));
    return { status: 202, task: taskDto(db, taskRow(db, id) as TaskRow) };
  }

  async function movePointer(
    db: Database,
    id: number,
    taskPr: number,
    base: string,
    sub: TaskRepoRow,
    partId: number,
    merge: string | null,
  ) {
    const project = sub.project as string;
    const repo = sub.repo as string;
    const t = taskRow(db, id) as TaskRow;
    const part = db.query(Q.part).get({ part: partId, task: id }) as PartRow;
    const path = fullPath(taskRepos(db, t), sub);
    const step = insertStep(db, { task: id, part: partId, kind: "commit", item: "pointer" }, now());
    changed(id);
    const fail = (at: number, error: string) =>
      db.transaction(() => {
        endStep(db, at, "failed", { notes: [error] }, now());
        db.query(Q.pointerError).run({ id: taskPr, error });
      })();
    try {
      const target = await pointerTarget(
        deps.review.dataDir,
        id,
        { id: sub.id, project, repo, base },
        await deps.review.taskRemote(project, repo),
        merge,
      );
      if ("error" in target) return fail(step, target.error);
      const clone = db.query(Q.clone).get({ project: t.project, repo: t.repo }) as { path: string } | null;
      const who = await identity(clone?.path ?? null);
      if (!who) return fail(step, "Set user.name and user.email in your git config.");
      const c = await commitGitlink({ dataDir: deps.review.dataDir, db, t, part, sub, commit: target.commit, who });
      if ("error" in c) return fail(step, c.error);
      db.transaction(() => {
        db.query(Q.partHead).run({ id: partId, head: c.head, now: now() });
        db.query(Q.moved).run({ id: sub.id, commit: target.commit });
        db.query(Q.subHead).run({ id: taskPr, commit: target.commit });
        endStep(db, step, "ok", { notes: [`Pointed ${path} at ${target.commit}.`] }, now());
      })();
    } catch (e) {
      return fail(step, `The app could not move the pointer of ${path}: ${noUrl((e as Error).message)}`);
    }
    changed(id);
    // The push of the parent with its lease.
    const f = fresh(db, id, partId);
    const main = f.rows.find((r) => r.role === "main") as PrRow;
    const push = insertStep(db, { task: id, part: partId, kind: "push", item: nameOf(main) }, now());
    changed(id);
    let error: string | null;
    try {
      error = main.pushed === main.head ? null : await pushOne(db, f.t, f.part, main);
    } catch (e) {
      error = `The push of ${main.branch} failed: ${noUrl((e as Error).message)}`;
    }
    if (error) return fail(push, error);
    db.transaction(() => {
      db.query(Q.pushed).run({ id: partId, commit: main.head, now: now() });
      db.query(Q.pointed).run({ id: taskPr });
      endStep(db, push, "ok", { notes: [`Pushed ${main.head} to ${main.branch} of ${nameOf(main)}.`] }, now());
    })();
    deps.syncNow();
  }

  return {
    open,
    openRows,
    pointer,
    // Resolves when the PR work of the task ends.
    idle: (id: number): Promise<void> => running.get(id) ?? Promise.resolve(),
    // At app stop: the PR work ends first.
    async shutdown() {
      await Promise.all(running.values());
    },
  };
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
