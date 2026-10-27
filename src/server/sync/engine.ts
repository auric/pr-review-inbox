// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Polling sync (plan G4): dashboard, PR states, comments, delete checks, events. One cycle at a time.
import type { CheckpointReason, SyncState, SyncStatus } from "../../shared/dto";
import { isMe } from "../../shared/me";
import type { Change, Commit, ForgeErrorInfo, IncompleteReason, PrRef, PullRequest } from "../../shared/types";
import { ForgeError } from "../bitbucket/client";
import type { ForgeProvider } from "../bitbucket/provider";
import { staleKeys } from "../inbox/stale";
import type { Live } from "../live";
import { log } from "../log";
import type { Settings, TaskPlan } from "../settings";
import { type NewEvent, nextDelay, parseRetryAfter, prEvents, reconcile, roleOf, type StoredComment } from "./reconcile";

const NETWORK = new Set(["network", "timeout"]);

export type Timers = { set(fn: () => unknown, ms: number): unknown; clear(handle: unknown): void };

type Params = Record<string, string | number | null>;
type PrKey = { id: number; project: string; repo: string; pr_id: number; state: string | null };
type Outcome = { state: SyncState; error?: string; pause?: boolean; retryAfterMs?: number };
// tasks: the tasks whose code PR rows changed.
type Tally = { startedAt: number; changed: Set<number>; events: number; tasks: Set<number> };

class Cancelled extends Error {}
class Unauthorized extends Error {}
class RateLimited extends Error {
  constructor(readonly retryAfter?: string) {
    super("rate");
  }
}

// A merged or declined PR gets at most one poll in this time.
const CLOSED_POLL_MS = 3_600_000;

const SQL = {
  forget: "UPDATE pull_request SET initialized_at = NULL WHERE initialized_at IS NOT NULL AND (followed = 0 OR archived_at IS NOT NULL)",
  polled: "SELECT id, project, repo, pr_id, state FROM pull_request WHERE followed = 1 AND archived_at IS NULL ORDER BY id",
  // Bitbucket cannot reopen a MERGED PR, so its stored state is final.
  away: "SELECT id, project, repo, pr_id, state FROM pull_request WHERE followed = 1 AND archived_at IS NULL AND on_dashboard = 0 AND state IS NOT 'MERGED' ORDER BY id",
  unfollow: "UPDATE pull_request SET followed = 0 WHERE id = $id",
  prBefore:
    "SELECT id, my_role, source_head, initialized_at, followed, archived_at FROM pull_request WHERE project = $project AND repo = $repo AND pr_id = $pr_id",
  prUpsert: `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, my_status, last_reviewed_commit,
      state, pr_version, source_head, target_head, source_branch, target_branch, web_url, repo_url, updated_date, on_dashboard, reviewers_json)
    VALUES ($project, $repo, $pr_id, $title, $description, $author_slug, $author_name, $my_role, $my_status, $last_reviewed_commit,
      $state, $pr_version, $source_head, $target_head, $source_branch, $target_branch, $web_url, $repo_url, $updated_date, $on_dashboard, $reviewers_json)
    ON CONFLICT (project, repo, pr_id) DO UPDATE SET title = excluded.title, description = excluded.description,
      author_slug = excluded.author_slug, author_name = excluded.author_name, my_role = excluded.my_role, my_status = excluded.my_status,
      last_reviewed_commit = excluded.last_reviewed_commit, state = excluded.state, pr_version = excluded.pr_version,
      source_head = excluded.source_head, target_head = excluded.target_head, source_branch = excluded.source_branch,
      target_branch = excluded.target_branch, web_url = excluded.web_url, repo_url = excluded.repo_url, updated_date = excluded.updated_date,
      on_dashboard = excluded.on_dashboard,
      reviewers_json = excluded.reviewers_json
    RETURNING id`,
  branchLink: `INSERT INTO pr_branch_link (pr, source_url, target_url, author_url) VALUES ($pr, $source, $target, $author)
    ON CONFLICT (pr) DO UPDATE SET source_url = excluded.source_url, target_url = excluded.target_url, author_url = excluded.author_url`,
  // docs/plans/review-v2/spec.md section 6.18.5: properties.mergeResult of the PR, NULL when the server names none.
  mergeResult: `INSERT INTO pr_merge_result (pr, merge_result) VALUES ($pr, $result)
    ON CONFLICT (pr) DO UPDATE SET merge_result = excluded.merge_result`,
  // docs/plans/review-v2/spec.md section 6.16.8: the code PR of a task repository follows its synced PR. Bitbucket cannot reopen a
  // merged PR, so merged stays.
  taskPr: `UPDATE task_pr SET state = CASE $state WHEN 'MERGED' THEN 'merged' WHEN 'DECLINED' THEN 'declined' ELSE 'pr_open' END
    WHERE pr = $pr AND state IN ('pr_open', 'declined')
      AND state IS NOT (CASE $state WHEN 'MERGED' THEN 'merged' WHEN 'DECLINED' THEN 'declined' ELSE 'pr_open' END)
    RETURNING part`,
  partTask: "SELECT task FROM task_part WHERE id = $part",
  offDashboard:
    "UPDATE pull_request SET on_dashboard = 0 WHERE on_dashboard = 1 AND id NOT IN (SELECT value FROM json_each($ids)) RETURNING id",
  prState: "SELECT my_role, initialized_at, source_head, target_head, meta_head, state FROM pull_request WHERE id = $id",
  watched: "SELECT id FROM pull_request WHERE id = $id AND followed = 1 AND archived_at IS NULL",
  stored:
    "SELECT comment_id AS id, root_id AS rootId, author_slug AS author, author_login AS login, tombstoned_at IS NULL AS live FROM comment WHERE pr = $pr",
  // A3: a lower or equal version never overwrites. ack_version stays unless this write acknowledges the new version.
  // commentMeta writes the anchor, the resolved flag and its resolver, the task fields, and the excerpt.
  commentUpsert: `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, author_name, author_login, text, anchor_json,
      thread_resolved, created_at, updated_at, ack_version, severity, task_state, excerpt_json, thread_resolver_json, thread_resolved_at)
    VALUES ($pr, $comment_id, $version, $parent_id, $root_id, $author_slug, $author_name, $author_login, $text, $anchor_json,
      $thread_resolved, $created_at, $updated_at, $ack_version, $severity, $task_state, $excerpt_json, $thread_resolver_json, $thread_resolved_at)
    ON CONFLICT (pr, comment_id) DO UPDATE SET version = excluded.version, parent_id = excluded.parent_id, root_id = excluded.root_id,
      author_slug = excluded.author_slug, author_name = excluded.author_name, author_login = excluded.author_login, text = excluded.text, updated_at = excluded.updated_at,
      ack_version = COALESCE(excluded.ack_version, comment.ack_version)
    WHERE excluded.version > comment.version`,
  // Bitbucket can change orphaned and threadResolved without a new version. The resolver follows threadResolved. The stored row with the highest version wins; at an equal version, the latest complete fetch wins.
  // A task resolve raises the version and adds no activity (Gate v3 U14). The equal-version write also fills rows stored before 006_forge.sql.
  // orphaned_at (thread-outcome.md section 11): the sync time when a stored anchor that was not orphaned turns orphaned. An anchor that is
  // orphaned at first sight keeps NULL. SET expressions read the stored row.
  commentMeta: `UPDATE comment SET anchor_json = $anchor_json, thread_resolved = $thread_resolved, severity = $severity, task_state = $task_state,
      excerpt_json = $excerpt_json, thread_resolver_json = $thread_resolver_json, thread_resolved_at = $thread_resolved_at,
      orphaned_at = CASE WHEN json_extract($anchor_json, '$.orphaned') IS NOT 1 OR anchor_json IS NULL THEN NULL
        WHEN json_extract(anchor_json, '$.orphaned') IS 1 THEN orphaned_at ELSE $now END
    WHERE pr = $pr AND comment_id = $comment_id AND version <= $version AND (anchor_json IS NOT $anchor_json OR thread_resolved IS NOT $thread_resolved
      OR severity IS NOT $severity OR task_state IS NOT $task_state OR excerpt_json IS NOT $excerpt_json
      OR thread_resolver_json IS NOT $thread_resolver_json OR thread_resolved_at IS NOT $thread_resolved_at)`,
  clearCommits: "DELETE FROM pr_commit WHERE pr = $pr",
  commit: `INSERT INTO pr_commit (pr, hash, ord, message, author_slug, author_name, ts) VALUES ($pr, $hash, $ord, $message, $author_slug, $author_name, $ts)
    ON CONFLICT DO NOTHING`,
  clearChanges: "DELETE FROM pr_change WHERE pr = $pr",
  change: "INSERT INTO pr_change (pr, path, src_path, type) VALUES ($pr, $path, $src_path, $type) ON CONFLICT DO NOTHING",
  metaHead: "UPDATE pull_request SET meta_head = $heads WHERE id = $pr",
  tombstone: "UPDATE comment SET tombstoned_at = $now WHERE pr = $pr AND comment_id = $id AND tombstoned_at IS NULL",
  initialized: "UPDATE pull_request SET initialized_at = COALESCE(initialized_at, $now) WHERE id = $id",
  event: "INSERT INTO event (pr, kind, ref, created_at, digest) VALUES ($pr, $kind, $ref, $now, $digest) ON CONFLICT DO NOTHING",
  lastComplete: "SELECT last_complete_at FROM sync_checkpoint WHERE scope = $scope",
  checkpointDone: `INSERT INTO sync_checkpoint (scope, last_complete_at, incomplete_reason, last_error, updated_at) VALUES ($scope, $now, $reason, $error, $now)
    ON CONFLICT (scope) DO UPDATE SET last_complete_at = excluded.last_complete_at, incomplete_reason = excluded.incomplete_reason,
      last_error = excluded.last_error, updated_at = excluded.updated_at`,
  // An incomplete fetch keeps last_complete_at.
  checkpointFail: `INSERT INTO sync_checkpoint (scope, incomplete_reason, last_error, updated_at) VALUES ($scope, $reason, $error, $now)
    ON CONFLICT (scope) DO UPDATE SET incomplete_reason = excluded.incomplete_reason, last_error = excluded.last_error, updated_at = excluded.updated_at`,
};

const refOf = (row: PrKey): PrRef => ({ project: row.project, repo: row.repo, id: row.pr_id });

export function createSyncEngine(opts: { settings: Settings; live: Live; now?: () => number; random?: () => number; timers?: Timers }) {
  const { settings, live } = opts;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const timers: Timers = opts.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  // A settings change bumps the generation. A cycle of an older generation must not touch the database again.
  let generation = 0;
  let started = false;
  let timer: unknown = null;
  let running: Promise<void> | null = null;
  let rerun: Promise<void> | null = null;
  // One provider, so its 2-slot semaphore covers every sync request.
  let provider: ForgeProvider | null = null;
  let failures = 0;
  // The start time of the last poll of each merged or declined PR.
  const closedPolledAt = new Map<number, number>();
  const status: Omit<SyncStatus, "running"> = { state: "idle", lastCompleteAt: null, nextAt: null, error: null };

  async function cycle(gen: number, tally: Tally): Promise<Outcome> {
    const config = settings.config();
    const db = settings.db();
    if (!config || !db) return { state: "unconfigured", pause: true };
    if (!provider) {
      let built: ForgeProvider | null;
      try {
        built = await settings.provider();
      } catch (e) {
        // settings.provider() throws an fs error with a code for the CA file, and a plain Error for the URL.
        const code = (e as { code?: unknown }).code;
        return { state: "error", error: code ? `Cannot read the CA file (${code}).` : (e as Error).message, pause: true };
      }
      // A provider built from replaced settings must not reach the next cycle.
      if (gen !== generation) throw new Cancelled();
      if (!built) return { state: "unconfigured", pause: true };
      provider = built;
    }
    const forge = provider;
    const me = config.userSlug;
    const digest = status.lastCompleteAt === null || tally.startedAt - status.lastCompleteAt > 2 * settings.checkMs() ? 1 : 0;
    const problems: { kind: string; retryAfter?: string }[] = [];
    let reached = false;
    let broken: string | null = null;

    // bun:sqlite transactions are synchronous, so no settings change can run between this check and the commit.
    const tx = <T>(fn: () => T): T => {
      if (gen !== generation) throw new Cancelled();
      return db.transaction(fn)();
    };
    const run = (sql: string, params: Params) => db.query(sql).run(params);

    // Records a failed call and returns its message. A 401, 429, or 503 ends the cycle.
    const failed = (kind: string, err?: ForgeErrorInfo): string => {
      if (kind === "auth") throw new Unauthorized();
      if (kind === "rate") throw new RateLimited(err?.retryAfter);
      if (!NETWORK.has(kind)) reached = true;
      problems.push({ kind, retryAfter: err?.retryAfter });
      return err?.message ?? kind;
    };
    const checkpoint = (scope: string, done: boolean, reason: CheckpointReason | null, error: string | null) =>
      run(done ? SQL.checkpointDone : SQL.checkpointFail, { scope, reason, error, now: now() });
    const addEvents = (pr: number, list: NewEvent[]) => {
      let added = 0;
      for (const e of list) added += run(SQL.event, { pr, kind: e.kind, ref: e.ref, now: now(), digest }).changes;
      return added;
    };
    const savePr = (pr: PullRequest, onDashboard: boolean, dashboardSeen: boolean, tasks: TaskPlan | null | undefined) => {
      const key = { project: pr.ref.project, repo: pr.ref.repo, pr_id: pr.ref.id };
      const row = db.query(SQL.prBefore).get(key) as {
        id: number;
        my_role: string | null;
        source_head: string | null;
        initialized_at: number | null;
        followed: number;
        archived_at: number | null;
      } | null;
      const mine = pr.reviewers.find((r) => isMe(r, me));
      const { id } = db.query(SQL.prUpsert).get({
        ...key,
        title: pr.title,
        description: pr.description ?? null,
        author_slug: pr.author.slug,
        author_name: pr.author.name,
        my_role: roleOf(pr, me),
        my_status: mine?.status ?? null,
        last_reviewed_commit: mine?.lastReviewedCommit ?? null,
        state: pr.state,
        pr_version: pr.version,
        source_head: pr.sourceHead,
        target_head: pr.targetHead,
        source_branch: pr.sourceBranch,
        target_branch: pr.targetBranch,
        web_url: pr.webUrl ?? null,
        repo_url: pr.repoUrl ?? null,
        updated_date: pr.updatedDate,
        on_dashboard: onDashboard ? 1 : 0,
        reviewers_json: JSON.stringify(
          pr.reviewers.map((r) => ({
            slug: r.slug,
            name: r.name,
            login: r.login,
            status: r.status,
            lastReviewedCommit: r.lastReviewedCommit,
          })),
        ),
      }) as { id: number };
      run(SQL.branchLink, { pr: id, source: pr.sourceBranchUrl ?? null, target: pr.targetBranchUrl ?? null, author: pr.authorUrl ?? null });
      run(SQL.mergeResult, { pr: id, result: pr.mergeResult ? JSON.stringify(pr.mergeResult) : null });
      for (const r of db.query(SQL.taskPr).all({ pr: id, state: pr.state }) as { part: number }[]) {
        const t = db.query(SQL.partTask).get({ part: r.part }) as { task: number } | null;
        if (t) tally.tasks.add(t.task);
      }
      settings.applyTasks(db, id, tasks);
      const before = row && {
        role: row.my_role,
        sourceHead: row.source_head,
        initialized: row.initialized_at !== null,
        watched: row.followed === 1 && row.archived_at === null,
      };
      return { id, events: addEvents(id, prEvents(before, pr, me, dashboardSeen)) };
    };

    // Archive and unfollow stop polling, so a later follow must import the missed history silently.
    tx(() => run(SQL.forget, {}));

    // Step 1: the dashboard. Its transaction also writes commits_pushed and reviewer_added.
    const lists = await Promise.all([forge.listDashboard("REVIEWER"), forge.listDashboard("AUTHOR")]);
    let dashboardDone = false;
    let incomplete: { reason: IncompleteReason; message: string } | null = null;
    for (const l of lists) {
      if (l.complete) {
        reached = true;
        continue;
      }
      const message = failed(l.reason, l.error);
      incomplete ??= { reason: l.reason, message };
    }
    if (incomplete) {
      const { reason, message } = incomplete;
      tx(() => checkpoint("dashboard", false, reason, message));
      // The PR calls go to the same unreachable host. Each would wait up to 30 s before it fails.
      if (NETWORK.has(reason)) return outcome();
    } else {
      const items = lists.flatMap((l) => l.items);
      const plans = await settings.planTasks(db, items);
      const written = tx(() => {
        const seen =
          (db.query(SQL.lastComplete).get({ scope: "dashboard" }) as { last_complete_at: number | null } | null)?.last_complete_at != null;
        const ids: number[] = [];
        let events = 0;
        for (const [i, pr] of items.entries()) {
          const r = savePr(pr, true, seen, plans[i]);
          ids.push(r.id);
          events += r.events;
        }
        for (const r of db.query(SQL.offDashboard).all({ ids: JSON.stringify(ids) }) as { id: number }[]) ids.push(r.id);
        checkpoint("dashboard", true, null, null);
        return { ids, events };
      });
      for (const id of written.ids) tally.changed.add(id);
      tally.events += written.events;
      dashboardDone = true;
    }

    // Step 2: followed PRs off the dashboard get the single-PR GET, for MERGED, DECLINED, and the current role. A stored MERGED PR gets no GET.
    const skip = new Set<number>();
    const resting = (row: PrKey) =>
      (row.state === "MERGED" || row.state === "DECLINED") && tally.startedAt - (closedPolledAt.get(row.id) ?? -Infinity) < CLOSED_POLL_MS;
    if (dashboardDone) {
      for (const row of tx(() => db.query(SQL.away).all({}) as PrKey[])) {
        if (gen !== generation) throw new Cancelled();
        if (resting(row)) continue;
        try {
          // The stored key wins, so the update always hits this row.
          const pr = { ...(await forge.getPullRequest(refOf(row))), ref: refOf(row) };
          reached = true;
          const [plan] = await settings.planTasks(db, [pr]);
          const r = tx(() => savePr(pr, false, false, plan));
          tally.changed.add(r.id);
          tally.events += r.events;
        } catch (e) {
          if (!(e instanceof ForgeError)) throw e;
          const message = failed(e.kind, e);
          skip.add(row.id);
          tx(() => {
            checkpoint(`pr:${row.id}`, false, e.kind, message);
            // A deleted PR moves to the archive with its data.
            if (e.kind === "not_found") run(SQL.unfollow, { id: row.id });
          });
          tally.changed.add(row.id);
        }
      }
    }

    const syncPr = async (row: PrKey) => {
      const scope = `pr:${row.id}`;
      const ref = refOf(row);
      if (gen !== generation) throw new Cancelled();
      const r = await forge.listComments(ref);
      if (!r.complete) {
        const message = failed(r.reason, r.error);
        tx(() => checkpoint(scope, false, r.reason, message));
        tally.changed.add(row.id);
        return;
      }
      reached = true;
      // Only this engine writes my_role, initialized_at, and comment rows, and cycles never overlap. Follow state is checked again at commit.
      type State = {
        my_role: string | null;
        initialized_at: number | null;
        source_head: string | null;
        target_head: string | null;
        meta_head: string | null;
        state: string | null;
      };
      const { pr, stored } = tx(() => ({
        pr: db.query(SQL.prState).get({ id: row.id }) as State,
        stored: (db.query(SQL.stored).all({ pr: row.id }) as (Omit<StoredComment, "live"> & { live: number })[]).map((s) => ({
          ...s,
          live: s.live === 1,
        })),
      }));
      const plan = reconcile({ stored, fetched: r.items, me, initialized: pr.initialized_at !== null, role: pr.my_role });

      // Plan v3 WP4: commits and changes only after a head change. A partial fetch writes nothing, so the next cycle tries again.
      let meta: { heads: string; commits: Commit[]; changes: Change[] } | null = null;
      const heads = pr.source_head && pr.target_head ? `${pr.source_head}:${pr.target_head}` : null;
      if (heads && heads !== pr.meta_head) {
        const [commits, changes] = await Promise.all([forge.listCommits(ref), forge.listChanges(ref)]);
        for (const l of [commits, changes]) if (!l.complete) failed(l.reason, l.error);
        if (commits.complete && changes.complete) meta = { heads, commits: commits.items, changes: changes.items };
      }

      // Step 4: a delete needs absence from a complete fetch plus a 404.
      const deleted: number[] = [];
      const gaps: number[] = [];
      let unsure: { reason: CheckpointReason; message: string } | null = null;
      for (const id of plan.candidates) {
        if (gen !== generation) throw new Cancelled();
        try {
          ((await forge.commentStatus(ref, id)) === "deleted" ? deleted : gaps).push(id);
          reached = true;
        } catch (e) {
          if (!(e instanceof ForgeError)) throw e;
          unsure = { reason: e.kind, message: failed(e.kind, e) };
        }
      }
      const reason = gaps.length ? "gap" : (unsure?.reason ?? null);
      const error = gaps.length ? `Present on Bitbucket but missing from the activities: ${gaps.join(", ")}` : (unsure?.message ?? null);

      // Step 5: one transaction per PR.
      const events = tx(() => {
        if (!db.query(SQL.watched).get({ id: row.id })) return null;
        const t = now();
        // thread-outcome.md section 11: no draft_stale event on the first sync or for a merged or declined PR.
        const before = pr.initialized_at !== null && pr.state !== "MERGED" && pr.state !== "DECLINED" ? staleKeys(db, row.id, me) : null;
        for (const c of plan.rows) {
          const anchor = c.anchor === undefined ? null : JSON.stringify(c.anchor);
          const resolved = c.threadResolved ? 1 : 0;
          const fields = {
            severity: c.severity ?? null,
            task_state: c.state ?? null,
            excerpt_json: c.excerpt ? JSON.stringify(c.excerpt) : null,
            thread_resolver_json: c.threadResolver ? JSON.stringify(c.threadResolver) : null,
            thread_resolved_at: c.threadResolvedAt ?? null,
          };
          run(SQL.commentUpsert, {
            pr: row.id,
            comment_id: c.id,
            version: c.version,
            parent_id: c.parentId,
            root_id: c.rootId,
            author_slug: c.author.slug,
            author_name: c.author.name,
            author_login: c.author.login,
            text: c.text,
            anchor_json: anchor,
            thread_resolved: resolved,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
            ack_version: c.ackVersion,
            ...fields,
          });
          run(SQL.commentMeta, {
            pr: row.id,
            comment_id: c.id,
            version: c.version,
            anchor_json: anchor,
            thread_resolved: resolved,
            ...fields,
            now: t,
          });
        }
        if (meta) {
          run(SQL.clearCommits, { pr: row.id });
          for (const [ord, c] of meta.commits.entries())
            run(SQL.commit, {
              pr: row.id,
              hash: c.hash,
              ord,
              message: c.message,
              author_slug: c.authorSlug,
              author_name: c.authorName,
              ts: c.at,
            });
          run(SQL.clearChanges, { pr: row.id });
          for (const c of meta.changes) run(SQL.change, { pr: row.id, path: c.path, src_path: c.srcPath, type: c.type });
          run(SQL.metaHead, { pr: row.id, heads: meta.heads });
        }
        for (const id of deleted) run(SQL.tombstone, { pr: row.id, id, now: t });
        // Only a draft that turns stale in this sync notifies.
        const stale = before
          ? [...staleKeys(db, row.id, me)].flatMap(([k, ref]): NewEvent[] =>
              ref !== null && !before.has(k) ? [{ kind: "draft_stale", ref }] : [],
            )
          : [];
        const added = addEvents(row.id, [
          ...plan.newCommentIds.map((id): NewEvent => ({ kind: "comment_new", ref: String(id) })),
          ...stale,
        ]);
        run(SQL.initialized, { id: row.id, now: t });
        checkpoint(scope, true, reason, error);
        return added;
      });
      if (events === null) return;
      tally.changed.add(row.id);
      tally.events += events;
    };

    // Steps 3 to 5 for each followed, non-archived PR.
    // ponytail: one PR at a time; run two workers if the cycle time grows too long (plan R1).
    for (const row of tx(() => db.query(SQL.polled).all({}) as PrKey[])) {
      if (skip.has(row.id) || resting(row)) continue;
      try {
        await syncPr(row);
        if (row.state === "MERGED" || row.state === "DECLINED") closedPolledAt.set(row.id, tally.startedAt);
      } catch (e) {
        if (e instanceof Cancelled || e instanceof Unauthorized || e instanceof RateLimited) throw e;
        broken = (e as Error).message;
        log(`Sync error on PR ${row.project}/${row.repo}/${row.pr_id}: ${broken}`);
      }
    }
    return outcome();

    function outcome(): Outcome {
      const waits = problems.map((p) => parseRetryAfter(p.retryAfter)).filter((ms) => ms !== undefined);
      const retryAfterMs = waits.length ? Math.max(...waits) : undefined;
      if (broken) return { state: "error", error: broken, retryAfterMs };
      if (problems.length && !reached) return { state: "offline", error: `No answer from Bitbucket (${problems[0]?.kind}).`, retryAfterMs };
      return { state: "ok", retryAfterMs };
    }
  }

  async function runCycle(gen: number): Promise<void> {
    status.nextAt = null;
    const tally: Tally = { startedAt: now(), changed: new Set(), events: 0, tasks: new Set() };
    let out: Outcome;
    try {
      out = await cycle(gen, tally);
    } catch (e) {
      if (e instanceof Cancelled || gen !== generation) return;
      out =
        e instanceof Unauthorized
          ? { state: "auth", error: "Bitbucket rejected the token.", pause: true }
          : e instanceof RateLimited
            ? { state: "error", error: "Bitbucket asks to slow down.", retryAfterMs: parseRetryAfter(e.retryAfter) }
            : { state: "error", error: (e as Error).message };
    }
    if (gen !== generation) return;
    // Step 6: everything below runs after the commits.
    live.broadcast("changed", { prs: [...tally.changed], ...(tally.tasks.size > 0 && { tasks: [...tally.tasks] }) });
    if (tally.events) live.broadcast("events", { count: tally.events });
    if (out.state !== "ok" && (out.state !== status.state || out.error !== status.error))
      log(`Sync ${out.state}${out.error ? `: ${out.error}` : ""}`);
    if (out.state === "offline") failures++;
    else if (out.state === "ok") {
      failures = 0;
      status.lastCompleteAt = tally.startedAt;
    }
    status.state = out.state;
    status.error = out.error ?? null;
    if (started && !out.pause) schedule(Math.max(out.retryAfterMs ?? 0, nextDelay(failures, random, settings.checkMs())));
  }

  function clearTimer() {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  function schedule(ms: number) {
    clearTimer();
    status.nextAt = now() + ms;
    timer = timers.set(launch, ms);
  }

  function launch(): Promise<void> {
    clearTimer();
    const p: Promise<void> = runCycle(generation).finally(() => {
      if (running === p) running = null;
    });
    running = p;
    return p;
  }

  function stop() {
    started = false;
    generation++;
    clearTimer();
    running = null;
    rerun = null;
    status.nextAt = null;
  }

  function start() {
    if (started) return;
    started = true;
    schedule(0);
  }

  settings.onTasksChanged((prs) => live.broadcast("changed", { prs }));

  // Runs synchronously inside the settings PUT, before the old database closes.
  settings.onSettingsChanged(() => {
    const was = started;
    stop();
    provider = null;
    failures = 0;
    if (was) start();
  });

  return {
    // The first cycle runs at once, then a setTimeout chain with no overlap.
    start,
    stop,
    // Starts a cycle now, or one more cycle after the running one. Resolves when that cycle ends. Never rejects.
    syncNow(): Promise<void> {
      if (rerun) return rerun;
      if (!running) return launch();
      const gen = generation;
      const r: Promise<void> = running.then(() => {
        if (rerun === r) rerun = null;
        if (gen === generation) return launch();
      });
      rerun = r;
      return r;
    },
    status: (): SyncStatus => ({ ...status, running: running !== null }),
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
