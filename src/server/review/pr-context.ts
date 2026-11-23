// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 2.8: the rows and the Bitbucket facts of context/pr-context.md. prContextFile (context-files.ts)
// builds the file from them. App code only: no Claude call, and no memory between runs except the path cache of other PRs.
import type { Database } from "bun:sqlite";
import type { CommitDto, IssueContext, ReviewItemDto } from "../../shared/dto";
import { isMe } from "../../shared/me";
import { stateText, threadOutcome } from "../../shared/outcome";
import { byThread, newestLive, type TurnMsg, threadTurn } from "../../shared/turn";
import type { PullRequest } from "../../shared/types";
import { ForgeError } from "../bitbucket/client";
import type { ForgeProvider } from "../bitbucket/provider";
import {
  type KeptNote,
  PEER_PRS_READ,
  PEER_READ_MS,
  type PeerPr,
  type PrContextInput,
  type PrContextThread,
  STACK_CHILDREN_SHOWN,
  STACK_UP_MAX,
  type Stack,
  type StackPr,
  threadPlace,
} from "./context-files";
import { currentDrafts, revisions, withRevision } from "./drafts";
import { prFixes } from "./fix-routes";
import { keptNotes, refreshLinks, within } from "./notes";
import type { Heads } from "./run-rows";

// Gates G9 and G12 (integration-check.md) are not run yet. Until the user records both as PASS, only stored PRs are listed
// (spec.md section 2.8, tasks.md WP-PN). Set it to true after the PASS.
export const PEER_READS = false;
export const PEER_GATE_TEXT = "Only PRs in your inbox are listed: the app does not read other open pull requests from Bitbucket yet.";

// docs/plans/review-v2/stacked-prs.md K12: Gates G9, G12, and G20 are not run yet. Until the user records all three as PASS, only stored
// PRs join a stack: no branch search, and no change list of a PR outside the inbox. Set it to true after the PASS.
export const STACK_READS = false;

export type PrContextReader = Pick<
  ForgeProvider,
  "buildStats" | "listOpenPullRequests" | "listChanges" | "getPullRequest" | "defaultBranch"
>;
// threads: the threads of the run in full text. paths: the paths of the discussed finding.
export type PrContextFocus = { threads: number[]; paths?: string[] };
// peers: the other open PRs of the file, by PR number, for the link rule of note proposals. build: the build stats were read.
// stack: the stack part of the run log line (stacked-prs.md section 5.7), null when the run did not look for a stack.
export type PrContext = {
  input: PrContextInput;
  notes: KeptNote[];
  peers: Map<number, { title: string; state: string }>;
  build: boolean;
  stack: string | null;
};

const SQL = {
  comments: `SELECT comment_id AS id, root_id AS rootId, author_slug AS authorSlug, author_login AS authorLogin, author_name AS authorName,
      created_at AS createdAt, tombstoned_at IS NOT NULL AS deleted, thread_resolved AS threadResolved, text, anchor_json AS anchor,
      excerpt_json AS excerpt, orphaned_at AS orphanedAt
    FROM comment WHERE pr = $pr ORDER BY created_at, comment_id`,
  // inbox/queries.ts SQL.commits: the CommitDto rows of the PR detail.
  commits: "SELECT hash, message, author_name AS author, ts AS at FROM pr_commit WHERE pr = $pr ORDER BY ord",
  tasks: "SELECT key FROM pr_task WHERE pr = $pr ORDER BY ord",
  taskContext: "SELECT key, json FROM task_context WHERE pr = $pr ORDER BY key",
  changes: "SELECT path, src_path AS srcPath FROM pr_change WHERE pr = $pr",
  peers: `SELECT id, pr_id, title, author_name, author_slug, state, target_branch, updated_date FROM pull_request
    WHERE project = $project AND repo = $repo AND state = 'OPEN' AND id <> $id ORDER BY pr_id`,
  storedIds: "SELECT pr_id FROM pull_request WHERE project = $project AND repo = $repo",
  storedId: "SELECT id FROM pull_request WHERE project = $project AND repo = $repo AND pr_id = $prId",
  // stacked-prs.md section 5.1 steps 6 and 7: the stored open PRs from or into a branch.
  stackFrom: `SELECT id, pr_id, title, description, author_name, author_slug, state, source_branch, target_branch, source_head, updated_date
    FROM pull_request WHERE project = $project AND repo = $repo AND state = 'OPEN' AND source_branch = $branch AND id <> $id ORDER BY pr_id`,
  stackInto: `SELECT id, pr_id, title, description, author_name, author_slug, state, source_branch, target_branch, source_head, updated_date
    FROM pull_request WHERE project = $project AND repo = $repo AND state = 'OPEN' AND target_branch = $branch AND id <> $id ORDER BY pr_id`,
};

type StackRow = {
  id: number;
  pr_id: number;
  title: string | null;
  description: string | null;
  author_name: string | null;
  author_slug: string | null;
  state: string;
  source_branch: string | null;
  target_branch: string | null;
  source_head: string | null;
  updated_date: number | null;
};

type CommentRow = Omit<TurnMsg, "deleted" | "threadResolved"> & {
  deleted: number;
  threadResolved: number;
  authorName: string | null;
  text: string;
  anchor: string | null;
  excerpt: string | null;
  orphanedAt: number | null;
};

// The changed paths of another PR by (project, repo, PR number, updatedDate). An unchanged PR costs no second read.
const peerCache = new Map<string, string[]>();
// Bounds the memory of a long session. The oldest entry goes first.
const PEER_CACHE_MAX = 1000;
export const clearPeerCache = () => peerCache.clear();

const json = <T>(s: string | null): T | undefined => {
  try {
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
};

// The other PR's paths and src paths that equal a path or src path of this PR. No glob and no fuzzy match.
const overlap = (own: ReadonlySet<string>, theirs: readonly string[]) => [...new Set(theirs.filter((p) => own.has(p)))].sort();

// Threads with the State line (shared/outcome.ts, the same input as the UI), from the stored rows only. A thread with no live message
// is left out. The comment run of a task part (tasks/loop.ts) reads them too.
export function contextThreads(
  db: Database,
  pr: Pick<Heads, "id" | "my_role" | "source_head" | "project" | "repo" | "pr_id">,
  me: string | null,
  dataDir: string,
): PrContextThread[] {
  const author = pr.my_role === "AUTHOR";
  // GET reply-drafts (jobs.ts replyDrafts): the current draft of each thread, unless it is posted, with its waiting revision.
  const revs = revisions(db, pr.id);
  const drafts = new Map<number, ReviewItemDto>();
  for (const [thread, r] of currentDrafts(db, pr.id)) if (r.status !== "posted") drafts.set(thread, withRevision(r, revs));
  const fixes = prFixes(db, dataDir, pr);
  const commits = db.query(SQL.commits).all({ pr: pr.id }) as CommitDto[];
  const rows = (db.query(SQL.comments).all({ pr: pr.id }) as CommentRow[]).map((r) => ({
    ...r,
    deleted: r.deleted === 1,
    threadResolved: r.threadResolved === 1,
  }));
  const threads: PrContextThread[] = [];
  for (const [id, list] of byThread(rows)) {
    const live = list.filter((m) => !m.deleted);
    if (!live.length) continue;
    const root = list.find((m) => m.id === id) ?? (list[0] as (typeof list)[number]);
    const { path, place } = threadPlace(root.anchor, root.excerpt);
    const { outcome } = threadOutcome({
      thread: { id, turn: threadTurn(list, me, author), newest: newestLive(list)?.id ?? null, orphanedAt: root.orphanedAt },
      draft: drafts.get(id),
      fixes,
      commits,
      ticks: new Map(),
      author,
      prHead: pr.source_head,
    });
    const mine = (m: typeof root) => isMe({ slug: m.authorSlug, login: m.authorLogin }, me);
    threads.push({
      id,
      place,
      path,
      starter: { author: root.authorName ?? root.authorSlug, mine: mine(root) },
      resolved: list.some((m) => m.threadResolved),
      state: stateText(outcome),
      msgs: live.map((m) => ({ id: m.id, author: m.authorName ?? m.authorSlug, mine: mine(m), at: m.createdAt, text: m.text })),
    });
  }
  return threads;
}

export async function loadPrContext(
  db: Database,
  provider: PrContextReader | null,
  pr: Heads,
  focus: PrContextFocus,
  signal: AbortSignal,
  // stack: look for a stack (stacked-prs.md K2 and K4: a review run with the variant "stack"). stackReads: tests only, in place of STACK_READS.
  o: { me: string | null; dataDir: string; now: number; peerReads?: boolean; stack?: boolean; stackReads?: boolean },
): Promise<PrContext> {
  const { me } = o;
  const author = pr.my_role === "AUTHOR";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(PEER_READ_MS)]);
  const why = (e: unknown) =>
    signal.aborted
      ? "the run was cancelled"
      : deadline.aborted
        ? `the reads took longer than ${PEER_READ_MS / 1000} s`
        : e instanceof ForgeError
          ? `Bitbucket error ${e.kind}${e.status ? ` ${e.status}` : ""}`
          : "an error";

  // ---------- Bitbucket reads: build stats, note links, other open PRs ----------
  const own = new Set(
    (db.query(SQL.changes).all({ pr: pr.id }) as { path: string; srcPath: string | null }[]).flatMap((c) =>
      c.srcPath ? [c.path, c.srcPath] : [c.path],
    ),
  );
  const peers: PeerPr[] = [];
  const peerNotes: string[] = [];
  type PeerRow = {
    id: number;
    pr_id: number;
    title: string | null;
    author_name: string | null;
    author_slug: string | null;
    state: string;
    target_branch: string | null;
    updated_date: number | null;
  };
  for (const r of db.query(SQL.peers).all({ project: pr.project, repo: pr.repo, id: pr.id }) as PeerRow[]) {
    const theirs = (db.query(SQL.changes).all({ pr: r.id }) as { path: string; srcPath: string | null }[]).flatMap((c) =>
      c.srcPath ? [c.path, c.srcPath] : [c.path],
    );
    const paths = overlap(own, theirs);
    if (paths.length)
      peers.push({
        prId: r.pr_id,
        title: r.title ?? "",
        author: r.author_name ?? r.author_slug ?? "unknown",
        state: r.state,
        target: r.target_branch ?? "unknown",
        updated: r.updated_date,
        paths,
      });
  }

  async function readPeers() {
    if (!provider) return void peerNotes.push("Only PRs in your inbox are listed: no Bitbucket connection.");
    if (!(o.peerReads ?? PEER_READS)) return void peerNotes.push(PEER_GATE_TEXT);
    try {
      const list = await within(provider.listOpenPullRequests(pr.project, pr.repo), deadline);
      const stored = new Set(
        (db.query(SQL.storedIds).all({ project: pr.project, repo: pr.repo }) as { pr_id: number }[]).map((r) => r.pr_id),
      );
      const todo = list.items
        .filter((p) => p.ref.id !== pr.pr_id && !stored.has(p.ref.id))
        .sort((a, b) => (b.updatedDate ?? 0) - (a.updatedDate ?? 0) || a.ref.id - b.ref.id);
      if (todo.length > PEER_PRS_READ) peerNotes.push(`${todo.length - PEER_PRS_READ} more open PRs were not checked.`);
      for (const p of todo.slice(0, PEER_PRS_READ)) {
        const key = JSON.stringify([pr.project, pr.repo, p.ref.id, p.updatedDate ?? null]);
        let theirs = peerCache.get(key);
        if (!theirs) {
          try {
            theirs = (await within(provider.listChanges(p.ref), deadline)).items.flatMap((c) =>
              c.srcPath ? [c.path, c.srcPath] : [c.path],
            );
          } catch (e) {
            // A PR that closed after the list gives 404. It leaves the list with no line.
            if (e instanceof ForgeError && e.kind === "not_found") continue;
            throw e;
          }
          peerCache.set(key, theirs);
          if (peerCache.size > PEER_CACHE_MAX) peerCache.delete(peerCache.keys().next().value as string);
        }
        const paths = overlap(own, theirs);
        if (paths.length)
          peers.push({
            prId: p.ref.id,
            title: p.title,
            author: p.author.name,
            state: p.state,
            target: p.targetBranch ?? "unknown",
            updated: p.updatedDate ?? null,
            paths,
          });
      }
    } catch (e) {
      peerNotes.push(`Only PRs in your inbox are listed: ${why(e)}.`);
    }
  }

  async function readBuild(): Promise<PrContextInput["build"]> {
    if (!provider) return { error: "no Bitbucket connection" };
    try {
      return { stats: await within(provider.buildStats(pr.source_head), deadline) };
    } catch (e) {
      return { error: why(e) };
    }
  }

  // stacked-prs.md section 5.1. log: the stack part of the run log line. stack: absent unless a parent or a child is kept (K3, K14).
  async function readStack(): Promise<{ stack?: Stack; log: string }> {
    if (!provider) return { log: "not read (no Bitbucket connection)" };
    const forge = provider;
    const reads = o.stackReads ?? STACK_READS;
    const ref = { project: pr.project, repo: pr.repo };
    let self: PullRequest;
    let main: string;
    try {
      [self, main] = await Promise.all([
        within(forge.getPullRequest({ ...ref, id: pr.pr_id }), deadline),
        within(forge.defaultBranch(pr.project, pr.repo), deadline),
      ]);
    } catch (e) {
      return { log: `not read (${why(e)})` };
    }
    // K8: both refs in this repository.
    const here = (p: PullRequest) => p.sourceRepo?.project === p.ref.project && p.sourceRepo?.repo === p.ref.repo;
    const fromPr = (p: PullRequest): StackPr => ({
      prId: p.ref.id,
      title: p.title,
      author: p.author.name,
      mine: isMe({ slug: p.author.slug, login: p.author.login }, me),
      state: p.state,
      source: p.sourceBranch,
      target: p.targetBranch,
      ...(p.targetRef !== undefined && { targetRef: p.targetRef }),
      sourceHead: p.sourceHead,
      updated: p.updatedDate,
      paths: null,
      description: p.description ?? "",
    });
    const fromRow = (r: StackRow): StackPr => ({
      prId: r.pr_id,
      title: r.title ?? "",
      author: r.author_name ?? r.author_slug ?? "unknown",
      mine: r.author_slug !== null && isMe({ slug: r.author_slug }, me),
      state: r.state,
      source: r.source_branch ?? "unknown",
      target: r.target_branch ?? "unknown",
      sourceHead: r.source_head,
      updated: r.updated_date,
      paths: null,
      description: r.description ?? "",
    });
    const rows = (sql: string, branch: string) =>
      db.query(sql).all({ project: pr.project, repo: pr.repo, branch, id: pr.id }) as StackRow[];
    const notes: string[] = [];
    let failed: string | null = null;
    const fail = (part: string, e: unknown) => {
      failed ??= why(e);
      notes.push(`Not read: ${part} (${why(e)}).`);
    };

    // Steps 6 and 8: the stored rows and, after the gates, the branch search. A stored PR that the search does not list gets one read.
    // It stays only when it is open with both refs in this repository.
    async function parentsOf(branch: string): Promise<StackPr[]> {
      const listed = reads
        ? (await within(forge.listOpenPullRequests(pr.project, pr.repo, branch), deadline)).items.filter(
            (p) => p.ref.id !== pr.pr_id && p.sourceBranch === branch,
          )
        : [];
      const kept = listed.filter(here).map(fromPr);
      for (const r of rows(SQL.stackFrom, branch)) {
        if (listed.some((p) => p.ref.id === r.pr_id)) continue;
        try {
          const p = await within(forge.getPullRequest({ ...ref, id: r.pr_id }), deadline);
          if (p.state === "OPEN" && here(p)) kept.push(fromPr(p));
        } catch (e) {
          // A PR that was deleted after the sync gives 404. It is no candidate.
          if (!(e instanceof ForgeError && e.kind === "not_found")) throw e;
        }
      }
      return kept;
    }

    // Steps 5 and 10, and the stop rules of section 5.1.
    const parents: StackPr[] = [];
    let several = 0;
    const sources = new Map([[self.sourceBranch, self.ref.id]]);
    let below = self.ref.id;
    for (let branch = self.targetBranch; branch !== main; ) {
      const back = sources.get(branch);
      if (back !== undefined) {
        notes.push(`Not followed: the chain returns to #${back}.`);
        break;
      }
      if (parents.length === STACK_UP_MAX) {
        notes.push(`The app follows at most ${STACK_UP_MAX} pull requests down the stack.`);
        break;
      }
      let found: StackPr[];
      try {
        found = await parentsOf(branch);
      } catch (e) {
        fail(`the parent of #${below}`, e);
        break;
      }
      if (found.length > 1) {
        // K10: no server fact picks one of several parents.
        if (parents.length) notes.push(`Not followed: ${found.length} open pull requests use ${branch} as their source branch.`);
        else several = found.length;
        break;
      }
      const p = found[0];
      if (!p) break;
      parents.push(p);
      sources.set(p.source, p.prId);
      below = p.prId;
      branch = p.target;
    }

    // Step 7: a PR from a fork, or from the default branch, gets no children search. A child from a fork is listed.
    let all: StackPr[] = [];
    if (here(self) && self.sourceBranch !== main) {
      try {
        const listed = reads
          ? (await within(forge.listOpenPullRequests(pr.project, pr.repo, self.sourceBranch, "INCOMING"), deadline)).items.filter(
              (p) => p.ref.id !== pr.pr_id && p.targetBranch === self.sourceBranch,
            )
          : [];
        const ids = new Set(listed.map((p) => p.ref.id));
        all = [
          ...listed.map(fromPr),
          ...rows(SQL.stackInto, self.sourceBranch)
            .filter((r) => !ids.has(r.pr_id))
            .map(fromRow),
        ]
          .filter((c) => !parents.some((p) => p.prId === c.prId))
          .sort((a, z) => (z.updated ?? 0) - (a.updated ?? 0) || a.prId - z.prId);
      } catch (e) {
        fail("the child pull requests", e);
      }
    }
    const children = all.slice(0, STACK_CHILDREN_SHOWN);

    if (!parents.length && !children.length)
      return { log: failed ? `not read (${failed})` : several ? `none (${several} parent candidates)` : "none" };

    // Step 9: the stored change list, else, after the gates, the cached read.
    for (const p of [...parents, ...children]) {
      const id = (db.query(SQL.storedId).get({ ...ref, prId: p.prId }) as { id: number } | null)?.id;
      const stored = id === undefined ? [] : (db.query(SQL.changes).all({ pr: id }) as { path: string }[]).map((c) => c.path);
      if (stored.length) {
        p.paths = stored;
        continue;
      }
      if (!reads) continue;
      const key = JSON.stringify(["stack", pr.project, pr.repo, p.prId, p.updated]);
      const cached = peerCache.get(key);
      if (cached) {
        p.paths = cached;
        continue;
      }
      try {
        const list = await within(forge.listChanges({ ...ref, id: p.prId }), deadline);
        // client.list gives a failed page as an incomplete list with its error.
        if (!list.complete && list.error) throw list.error;
        const paths = list.items.map((c) => c.path);
        p.paths = paths;
        peerCache.set(key, paths);
        if (peerCache.size > PEER_CACHE_MAX) peerCache.delete(peerCache.keys().next().value as string);
      } catch (e) {
        fail(`the changed paths of #${p.prId}`, e);
      }
    }
    const top = parents[0];
    return {
      stack: { parents, children, childrenLeft: all.length - children.length, notes },
      log: `${top ? `parent #${top.prId}` : several ? `no parent (${several} candidates)` : "no parent"}, ${all.length} children`,
    };
  }

  const [build, , , stack] = await Promise.all([
    readBuild(),
    refreshLinks(db, pr.id, provider ? (ref) => provider.getPullRequest(ref) : null, o.now, deadline),
    readPeers(),
    o.stack ? readStack() : null,
  ]);

  const threads = contextThreads(db, pr, me, o.dataDir);
  const focusPaths = new Set(focus.paths ?? []);
  const focusIds = new Set(focus.threads);
  for (const t of threads) if (focusIds.has(t.id) && t.path !== null) focusPaths.add(t.path);

  // ---------- Linked tasks ----------
  const summaries = new Map(
    (db.query(SQL.taskContext).all({ pr: pr.id }) as { key: string; json: string }[]).map((r) => [
      r.key,
      json<IssueContext>(r.json)?.summary ?? null,
    ]),
  );
  const keys = (db.query(SQL.tasks).all({ pr: pr.id }) as { key: string }[]).map((r) => r.key);
  const tasks = [...new Set([...keys, ...summaries.keys()])].map((key) => ({ key, summary: summaries.get(key) ?? null }));

  return {
    input: {
      pr: {
        project: pr.project,
        repo: pr.repo,
        prId: pr.pr_id,
        state: pr.state,
        title: pr.title ?? "",
        author: pr.author_name ?? pr.author_slug ?? "unknown",
        mine: author || (pr.author_slug !== null && isMe({ slug: pr.author_slug }, me)),
        source: pr.source_branch ?? "unknown",
        sourceHead: pr.source_head,
        target: pr.target_branch ?? "unknown",
        targetHead: pr.target_head,
        description: pr.description ?? "",
      },
      tasks,
      build,
      threads,
      focus: focus.threads,
      paths: [...focusPaths].sort(),
      peers,
      peerNotes,
      ...(stack?.stack && { stack: stack.stack }),
    },
    notes: keptNotes(db, pr.id),
    peers: new Map(peers.map((p) => [p.prId, { title: p.title, state: p.state }])),
    build: "stats" in build,
    stack: stack?.log ?? null,
  };
}
