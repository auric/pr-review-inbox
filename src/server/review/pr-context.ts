// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 2.8: the rows and the Bitbucket facts of context/pr-context.md. prContextFile (context-files.ts)
// builds the file from them. App code only: no Claude call, and no memory between runs except the path cache of other PRs.
import type { Database } from "bun:sqlite";
import type { CommitDto, IssueContext, ReviewItemDto } from "../../shared/dto";
import { isMe } from "../../shared/me";
import { stateText, threadOutcome } from "../../shared/outcome";
import { byThread, newestLive, type TurnMsg, threadTurn } from "../../shared/turn";
import { ForgeError } from "../bitbucket/client";
import type { ForgeProvider } from "../bitbucket/provider";
import {
  type KeptNote,
  PEER_PRS_READ,
  PEER_READ_MS,
  type PeerPr,
  type PrContextInput,
  type PrContextThread,
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

export type PrContextReader = Pick<ForgeProvider, "buildStats" | "listOpenPullRequests" | "listChanges" | "getPullRequest">;
// threads: the threads of the run in full text. paths: the paths of the discussed finding.
export type PrContextFocus = { threads: number[]; paths?: string[] };
// peers: the other open PRs of the file, by PR number, for the link rule of note proposals. build: the build stats were read.
export type PrContext = { input: PrContextInput; notes: KeptNote[]; peers: Map<number, { title: string; state: string }>; build: boolean };

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
  o: { me: string | null; dataDir: string; now: number; peerReads?: boolean },
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

  const [build] = await Promise.all([
    readBuild(),
    refreshLinks(db, pr.id, provider ? (ref) => provider.getPullRequest(ref) : null, o.now, deadline),
    readPeers(),
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
    },
    notes: keptNotes(db, pr.id),
    peers: new Map(peers.map((p) => [p.prId, { title: p.title, state: p.state }])),
    build: "stats" in build,
  };
}
