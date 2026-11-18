// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Durable outbox (plan v3 WP13a): each approved text reaches the forge once, from the user's point of view.
// A row goes pending, then sent (committed before the request), then confirmed, failed, or unknown.
// An unknown row is checked against the remote comments before any new send. Without a match, the user decides.
import type { Database } from "bun:sqlite";
import type {
  BlockedDraft,
  PlannedPost,
  PostDestination,
  PostDto,
  PostState,
  ReplyConflict,
  ReplyPostInput,
  ReviewItemDto,
  ThreadResolveError,
  ThreadResolveInput,
} from "../../shared/dto";
import { isMe } from "../../shared/me";
import type { ReplyPayload } from "../../shared/review";
import { staleReasons } from "../../shared/stale";
import { newestLive, type TurnMsg } from "../../shared/turn";
import type { Comment, PrRef } from "../../shared/types";
import { ForgeError } from "../bitbucket/client";
import type { ForgeProvider, NewAnchor, ResolveResult, ThreadState } from "../bitbucket/provider";
import type { Live } from "../live";
import { log } from "../log";
import { git, userGitEnv } from "../review/git";
import type { Settings } from "../settings";

type Ref = { id: number; revision: number };

type PostRow = {
  id: number;
  pr: number;
  run: number | null;
  kind: PostDestination["kind"];
  idem_key: string;
  body: string;
  destination_json: string;
  items_json: string;
  state: PostState;
  remote_id: number | null;
  remote_version: number | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  resolve_root: number | null;
  resolve_state: "pending" | "done" | "failed" | null;
  resolve_error: string | null;
};

const UNCONFIGURED = "Configure the Bitbucket URL and token first.";
const NO_MATCH = "No matching comment on Bitbucket. Post again or drop.";

// The reason of a resolve or reopen that did not end in the wanted state.
function resolveText(status: Exclude<ResolveResult["status"], "done">, resolved: boolean): string {
  const act = resolved ? "resolve" : "reopen";
  switch (status) {
    case "changed":
      return `The thread changed on Bitbucket. Read it, then ${act} it again.`;
    case "forbidden":
      return `Bitbucket refused to ${act} the thread. Only the comment author, the PR author, or a repository admin may do it. Open the thread on Bitbucket.`;
    case "gone":
      return "The thread was deleted on Bitbucket.";
    case "ignored":
      return `Bitbucket took the request, but the thread did not ${act}. Open the thread on Bitbucket.`;
  }
}

const SQL = {
  recover: "UPDATE post SET state = 'unknown', last_error = $text, updated_at = $now WHERE state = 'sent'",
  unknown: "SELECT id FROM post WHERE state = 'unknown' ORDER BY id",
  next: "SELECT * FROM post WHERE state = 'pending' ORDER BY id LIMIT 1",
  // The resolve step runs only after the comment step confirmed the row.
  resolveNext: "SELECT * FROM post WHERE state = 'confirmed' AND resolve_state = 'pending' ORDER BY id LIMIT 1",
  resolveEnd:
    "UPDATE post SET resolve_state = $state, resolve_error = $text, updated_at = $now WHERE id = $id AND resolve_state = 'pending'",
  resolveAgain: `UPDATE post SET resolve_state = 'pending', resolve_error = NULL, updated_at = $now
    WHERE id = $id AND state = 'confirmed' AND resolve_state = 'failed'`,
  // The thread state that a resolve or reopen read back. A newer synced version wins. from: the version of the first read.
  // The version and the read mark move only when the stored root has version from. Else the stored text is older than the read:
  // only the flags change, and the next sync brings the text. The read mark moves on when it covered the old version.
  // In SQLite, SET reads the old values.
  threadState: `UPDATE comment SET thread_resolved = $resolved, thread_resolver_json = $resolver, thread_resolved_at = $at,
      ack_version = IIF(version = $from AND ack_version >= version, $version, ack_version), version = IIF(version = $from, $version, version)
    WHERE pr = $pr AND comment_id = $root AND parent_id IS NULL AND version <= $version`,
  // The turn rule reads the flag of every message of a thread (shared/turn.ts), so the replies follow the root.
  threadReplies: "UPDATE comment SET thread_resolved = $resolved WHERE pr = $pr AND root_id = $root AND parent_id IS NOT NULL",
  get: "SELECT * FROM post WHERE id = $id",
  byPr: "SELECT * FROM post WHERE pr = $pr ORDER BY id",
  byKey: "SELECT * FROM post WHERE idem_key = $key",
  runPosts: "SELECT * FROM post WHERE pr = $pr AND run IS NOT NULL ORDER BY id",
  owned: "SELECT remote_id FROM post WHERE pr = $pr AND id != $id AND remote_id IS NOT NULL",
  ref: "SELECT project, repo, pr_id AS id FROM pull_request WHERE id = $pr",
  heads: "SELECT source_head, target_head FROM review_run WHERE id = $run",
  // docs/plans/review-v2/stale-drafts.md F1: the runs of the PR on another source head than the stored one.
  older: `SELECT r.id, r.source_head AS head FROM review_run r JOIN pull_request p ON p.id = r.pr
    WHERE r.pr = $pr AND r.source_head <> p.source_head`,
  parent: "SELECT root_id, tombstoned_at FROM comment WHERE pr = $pr AND comment_id = $id",
  // Plan r3: sync writes pr_commit and meta_head together, after a complete commits fetch for the current heads.
  fixed: `SELECT 1 FROM pull_request p JOIN pr_commit c ON c.pr = p.id AND c.hash = $hash
    WHERE p.id = $pr AND p.meta_head = p.source_head || ':' || p.target_head`,
  fixRow: "SELECT short_hash, mode, clone_path, branch FROM fix_commit WHERE id = $id",
  thread: `SELECT comment_id AS id, root_id AS rootId, author_slug AS authorSlug, author_login AS authorLogin, created_at AS createdAt,
      tombstoned_at IS NOT NULL AS deleted, thread_resolved AS threadResolved FROM comment WHERE pr = $pr AND root_id = $root`,
  insert: `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, created_at, updated_at, resolve_root, resolve_state)
    VALUES ($pr, $run, $kind, $key, $body, $destination, $items, 'pending', $now, $now, $resolve, IIF($resolve IS NULL, NULL, 'pending'))
    RETURNING *`,
  // `from` makes each step a compare-and-set, so two pages or a page and the sender never both win.
  move: `UPDATE post SET state = $to, last_error = $text, remote_id = COALESCE($remoteId, remote_id),
      remote_version = COALESCE($remoteVersion, remote_version), updated_at = $now WHERE id = $id AND state = $from`,
  // Committed before the request. A stop after this point gives unknown at the next start.
  sent: "UPDATE post SET state = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = $now WHERE id = $id AND state = 'pending'",
  drop: "DELETE FROM post WHERE id = $id AND state = $state",
  // An item of a post stays `posted` until the user drops the post.
  take: "UPDATE review_item SET status = 'posted' WHERE id = $id AND revision = $revision AND status = 'accepted'",
  release: `UPDATE review_item SET status = 'accepted', revision = revision + 1, anchor_state = IIF($outside = 1, 'outside', anchor_state)
    WHERE id = $id AND status = 'posted'`,
};

const parseList = (s: string) => JSON.parse(s) as Ref[];

// Only the status or the error kind goes into a row. Never a header or a response text.
function reason(e: unknown): string {
  if (!(e instanceof ForgeError)) return "internal error";
  if (e.status !== undefined) return `HTTP ${e.status}`;
  return e.code ? `${e.kind} ${e.code}` : e.kind;
}

// The forge processed and refused the request: a redirect or a client error. Anything else can follow an accepted write.
const refused = (e: unknown): e is ForgeError & { status: number } =>
  e instanceof ForgeError && e.status !== undefined && e.status >= 300 && e.status < 500;

// The anchor line that the POST sends and Bitbucket returns. Gate v3 U4: a CONTEXT anchor holds the old-side line.
// A ctx row stored before srcLine existed was posted with its new-side line.
const postedLine = (d: Extract<PostDestination, { kind: "inline" }>) => d.srcLine ?? d.line;

function sameDestination(c: Comment, d: PostDestination): boolean {
  if (d.kind === "reply") return c.parentId === d.parentId;
  if (c.parentId !== null) return false;
  const a = c.anchor as { path?: unknown; line?: unknown } | undefined;
  return d.kind === "general" ? !a : a?.path === d.path && a.line === postedLine(d);
}

// The planned posts whose items the request names with the same revisions. null: the plan differs from the confirm on screen.
export function selectPosts(plan: PlannedPost[], want: Map<number, number>): PlannedPost[] | null {
  const chosen = plan.filter((p) => p.items.some((i) => want.has(i.id)));
  const exact = chosen.every((p) => p.items.every((i) => want.get(i.id) === i.revision));
  return exact && chosen.reduce((n, p) => n + p.items.length, 0) === want.size ? chosen : null;
}

// A git read in the user's clone during a plan read stops after this time.
const CLONE_READ_MS = 10_000;

// The newest live message of the thread of comment id. null: the comment is not stored, or every message is deleted.
function newestOf(db: Database, pr: number, id: number): number | null {
  const parent = db.query(SQL.parent).get({ pr, id }) as { root_id: number } | null;
  return parent ? (newestLive(db.query(SQL.thread).all({ pr, root: parent.root_id }) as TurnMsg[])?.id ?? null) : null;
}

// D14: the reply parent is a live comment and the newest live message of its thread.
export function replyCurrent(db: Database, pr: number, id: number): boolean {
  const thread = { newest: newestOf(db, pr, id), resolved: false, orphanedAt: null };
  return !staleReasons({ body: "", payload: { replyTo: id } }, thread, null).includes("out-of-date");
}

// git merge-base prints the commit itself when the commit is an ancestor of the branch (git-merge-base(1)).
// null: git cannot read the clone, the branch, or the commit. Git in the clone runs no network command.
async function inBranch(path: string, branch: string, commit: string): Promise<boolean | null> {
  try {
    const base = await git(["merge-base", commit, `refs/heads/${branch}`], { cwd: path, env: userGitEnv(), timeoutMs: CLONE_READ_MS });
    return base.trim() === commit;
  } catch {
    return null;
  }
}

// Plan r3: a "Fixed in" reply posts only when the stored PR commits hold its commit and belong to the current heads.
// Else commit-gone when the clone branch of the fix no longer holds the commit, and unpushed in every other case. null: it can post.
// fix.id null: a task commit (AC-B394). It has no clone row, so it waits as unpushed.
async function fixCheck(db: Database, pr: number, fix: NonNullable<ReplyPayload["fix"]>) {
  if (db.query(SQL.fixed).get({ pr, hash: fix.commit })) return null;
  const row = (fix.id === null ? null : db.query(SQL.fixRow).get({ id: fix.id })) as {
    short_hash: string | null;
    mode: string;
    clone_path: string | null;
    branch: string | null;
  } | null;
  const gone =
    row?.mode === "clone" &&
    row.clone_path !== null &&
    row.branch !== null &&
    (await inBranch(row.clone_path, row.branch, fix.commit)) === false;
  return { reason: gone ? "commit-gone" : "unpushed", commit: row?.short_hash ?? fix.commit.slice(0, 7) } as const;
}

// docs/plans/thread-outcome.md: the accepted reply drafts that confirm cannot post now, with one reason each, in this order:
// out-of-date, resolved-since, then unpushed or commit-gone. resolved: the root comments of the resolved threads.
// A draft without text posts no reply, so a resolved thread never blocks it.
// docs/plans/review-v2/stale-drafts.md F1: an accepted finding or question of a run on an older head is older-commit. A revision
// never posts (plan.ts), so it never blocks. Confirm still checks the live head of the posts that remain.
export async function blockedDrafts(db: Database, pr: number, items: ReviewItemDto[], resolved: number[] = []): Promise<BlockedDraft[]> {
  const shut = new Set(resolved);
  const older = new Map((db.query(SQL.older).all({ pr }) as { id: number; head: string }[]).map((r) => [r.id, r.head]));
  const out: BlockedDraft[] = [];
  for (const it of items) {
    const head = older.get(it.run);
    if ((it.kind === "finding" || it.kind === "question") && it.status === "accepted" && head !== undefined) {
      if ((it.payload as { revises?: number }).revises !== undefined) continue;
      const at = it.anchor && { path: it.anchor.path, line: it.anchor.line };
      out.push({ item: it.id, revision: it.revision, reason: "older-commit", commit: head.slice(0, 7), ...at });
      continue;
    }
    if (it.kind !== "reply" || it.status !== "accepted") continue;
    const p = it.payload as ReplyPayload;
    const text = it.body.trim() !== "";
    if (!text && !p.resolveTick) continue;
    const draft = { item: it.id, revision: it.revision, thread: p.thread };
    const thread = { newest: newestOf(db, pr, p.replyTo), resolved: shut.has(p.thread), orphanedAt: null };
    // Code changed never blocks a post.
    const reason = staleReasons({ body: it.body, payload: p }, thread, null).find((r) => r !== "code-changed");
    if (reason) out.push({ ...draft, reason });
    else {
      const fix = p.fix && (await fixCheck(db, pr, p.fix));
      if (fix) out.push({ ...draft, ...fix });
    }
  }
  return out;
}

const runKey = (pr: number, p: PlannedPost) =>
  `run:${pr}:${p.run}:${[...p.items]
    .sort((a, b) => a.id - b.id)
    .map((i) => `${i.id}@${i.revision}`)
    .join(",")}`;

export type ReplyResult =
  | { status: 200 | 202; post: PostDto }
  | { status: 404; error: string }
  | { status: 409; error: string }
  | { status: 409; conflict: ReplyConflict };
export type RetryResult = { status: 200 | 202; post: PostDto } | { status: 404 | 409 | 502; error: string };
export type DropResult = { status: 200; items: Ref[] } | { status: 400 | 404 | 409; error: string };
export type HeadCheck = { warning: string | null } | { status: 409 | 502; error: string };
export type ResolveRetry = { status: 202; post: PostDto } | { status: 404 | 409; error: string };
export type ThreadResolveResult =
  | { status: 200; thread: number; resolved: boolean }
  | { status: 403 | 404 | 409 | 502; error: string; reason?: ThreadResolveError["reason"] };

export function createOutbox(opts: { settings: Settings; live: Live; now?: () => number }) {
  const { settings, live } = opts;
  const now = opts.now ?? Date.now;
  const recovered = new WeakSet<Database>();
  // Unknown rows that wait for a check or are in one.
  const checking = new Set<number>();
  let busy: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const provider = (): Promise<ForgeProvider | null> => settings.provider().catch(() => null);
  const notify = (pr: number) => live.broadcast("changed", { prs: [pr] });
  const row = (db: Database, id: number) => db.query(SQL.get).get({ id }) as PostRow | null;
  const refOf = (db: Database, pr: number) => db.query(SQL.ref).get({ pr }) as PrRef | null;
  const move = (db: Database, id: number, from: PostState, to: PostState, text: string | null, remote?: { id: number; version: number }) =>
    db.query(SQL.move).run({ id, from, to, text, remoteId: remote?.id ?? null, remoteVersion: remote?.version ?? null, now: now() })
      .changes > 0;

  function toDto(r: PostRow): PostDto {
    return {
      id: r.id,
      pr: r.pr,
      run: r.run,
      destination: JSON.parse(r.destination_json) as PostDestination,
      body: r.body,
      items: parseList(r.items_json),
      state: r.state,
      remoteId: r.remote_id,
      remoteVersion: r.remote_version,
      attempts: r.attempts,
      lastError: r.last_error,
      checking: r.state === "unknown" && checking.has(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(r.resolve_root !== null &&
        r.resolve_state !== null && { resolve: { root: r.resolve_root, state: r.resolve_state, error: r.resolve_error } }),
    };
  }

  function applyState(db: Database, pr: number, root: number, res: { state: ThreadState; from: number }) {
    const s = res.state;
    const resolved = s.threadResolved ? 1 : 0;
    db.transaction(() => {
      const moved = db.query(SQL.threadState).run({
        pr,
        root,
        resolved,
        resolver: s.threadResolver ? JSON.stringify(s.threadResolver) : null,
        at: s.threadResolvedAt ?? null,
        version: s.version,
        from: res.from,
      });
      if (moved.changes) db.query(SQL.threadReplies).run({ pr, root, resolved });
    })();
  }

  // Bitbucket takes no reply in a resolved thread (integration-check.md U67). So the reply step reopens the thread first.
  // A retry reads the thread again, so it never reopens an open thread. Returns the reason that stops the reply, else put: a PUT went out.
  async function reopenFor(
    db: Database,
    r: PostRow,
    ref: PrRef,
    forge: ForgeProvider,
    parentId: number,
  ): Promise<{ error: string } | { put: boolean }> {
    const root = rootOf(db, r.pr, parentId);
    let res: ResolveResult;
    try {
      res = await forge.setThreadResolved(ref, root, false);
    } catch (e) {
      if (!(e instanceof ForgeError)) log(`Post ${r.id} reopen: ${(e as Error).message}`);
      return { error: `Could not read the thread state on Bitbucket (${reason(e)}). The reply was not sent.` };
    }
    if (res.status !== "done") return { error: `${resolveText(res.status, false)} The reply was not sent.` };
    applyState(db, r.pr, root, res);
    return { put: res.put };
  }

  const rootOf = (db: Database, pr: number, parentId: number) =>
    (db.query(SQL.parent).get({ pr, id: parentId }) as { root_id: number } | null)?.root_id ?? parentId;

  // Data Center 9.x refuses a reply in a resolved thread with 400 ArgumentValidationException (integration-check.md U67).
  // The reopen step runs first, so this needs a resolve between the reopen and the post.
  async function resolvedRefusal(db: Database, r: PostRow, ref: PrRef, forge: ForgeProvider, dest: PostDestination, e: ForgeError) {
    if (dest.kind !== "reply" || e.status !== 400 || e.code !== "ArgumentValidationException") return false;
    const state = await forge.threadState(ref, rootOf(db, r.pr, dest.parentId)).catch(() => null);
    return state?.threadResolved === true;
  }

  // The database of the configured origin. Its first use turns sent rows into unknown rows and resumes the outbox.
  function open(): Database | null {
    const db = settings.db();
    if (db && !recovered.has(db)) {
      recovered.add(db);
      db.query(SQL.recover).run({ text: "The app stopped while the post was out.", now: now() });
      // The row IDs of another database name other rows.
      checking.clear();
      for (const { id } of db.query(SQL.unknown).all() as { id: number }[]) checking.add(id);
      void kick();
    }
    return db;
  }

  // ---------- Sender ----------
  async function send(db: Database, r: PostRow) {
    // A resolve-only row posts no comment. Its resolve step runs next.
    if (!r.body) {
      move(db, r.id, "pending", "confirmed", null);
      return notify(r.pr);
    }
    const dest = JSON.parse(r.destination_json) as PostDestination;
    const fail = (text: string) => {
      move(db, r.id, "pending", "failed", text);
      notify(r.pr);
    };
    const ref = refOf(db, r.pr);
    const forge = await provider();
    if (!ref || !forge) return fail(UNCONFIGURED);
    let anchor: NewAnchor | undefined;
    // The words after a failed post when the reply step reopened the thread.
    let reopened = "";
    if (dest.kind === "reply") {
      // D14: a reply checks its parent, not the heads.
      const status = await forge.commentStatus(ref, dest.parentId).catch((e: unknown) => e);
      if (status === "deleted") return fail("The comment was deleted. The reply was not sent.");
      if (status !== "present") return fail(`Could not check the comment (${reason(status)}). The reply was not sent.`);
      const open = await reopenFor(db, r, ref, forge, dest.parentId);
      if ("error" in open) return fail(open.error);
      if (open.put) reopened = " The app reopened the thread before the post.";
    } else if (dest.kind === "inline") {
      if (dest.lineType === "ctx" && dest.srcLine === undefined)
        return fail("The context line has no old line number. Move the finding to the general comment.");
      const h = r.run === null ? null : (db.query(SQL.heads).get({ run: r.run }) as { source_head: string; target_head: string } | null);
      if (!h) return fail("The review run is gone.");
      anchor = {
        path: dest.path,
        srcPath: dest.srcPath,
        line: postedLine(dest),
        lineType: dest.lineType,
        fromHash: h.target_head,
        toHash: h.source_head,
      };
    }
    if (!db.query(SQL.sent).run({ id: r.id, now: now() }).changes) return;
    notify(r.pr);
    try {
      const c = await forge.createComment(ref, { text: r.body, parentId: dest.kind === "reply" ? dest.parentId : undefined, anchor });
      move(db, r.id, "sent", "confirmed", null, c);
    } catch (e) {
      if (refused(e)) {
        // v3 R2 (U4): Bitbucket can refuse a context line. The drop route can move the finding to the general comment.
        const ctx = dest.kind === "inline" && dest.lineType === "ctx" && e.status === 400;
        move(
          db,
          r.id,
          "sent",
          "failed",
          ctx
            ? "Bitbucket refused the inline comment on a context line (HTTP 400). Post the finding in the general comment."
            : (await resolvedRefusal(db, r, ref, forge, dest, e))
              ? "This thread is resolved. Reopen it first."
              : `Bitbucket refused the comment (${reason(e)}).${reopened}`,
        );
      } else {
        if (!(e instanceof ForgeError)) log(`Post ${r.id}: ${(e as Error).message}`);
        move(db, r.id, "sent", "unknown", `No clear answer from Bitbucket (${reason(e)}).${reopened}`);
        checking.add(r.id);
      }
    }
    notify(r.pr);
  }

  // confirmed: a remote comment matches. none: the remote comments hold no match. unclear: the check could not run.
  // A match needs my author, the exact text, the same destination, and an ID that no other post owns.
  async function check(db: Database, id: number): Promise<"confirmed" | "none" | "unclear" | "not_unknown"> {
    const r = row(db, id);
    if (r?.state !== "unknown") return "not_unknown";
    const unclear = (text: string) => {
      move(db, id, "unknown", "unknown", text);
      return "unclear" as const;
    };
    const ref = refOf(db, r.pr);
    const forge = await provider();
    if (!ref || !forge) return unclear(UNCONFIGURED);
    let list: Awaited<ReturnType<ForgeProvider["listComments"]>>;
    try {
      list = await forge.listComments(ref);
    } catch (e) {
      if (!(e instanceof ForgeError)) log(`Post ${id} check: ${(e as Error).message}`);
      return unclear(`Could not read the comments on Bitbucket (${reason(e)}).`);
    }
    if (!list.complete) return unclear(`Could not read all comments on Bitbucket (${list.reason}).`);
    const me = settings.config()?.userSlug ?? null;
    const dest = JSON.parse(r.destination_json) as PostDestination;
    const owned = new Set((db.query(SQL.owned).all({ pr: r.pr, id }) as { remote_id: number }[]).map((o) => o.remote_id));
    const hit = list.items
      .filter((c) => !owned.has(c.id) && isMe(c.author, me) && c.text === r.body && sameDestination(c, dest))
      .sort((a, b) => a.id - b.id)[0];
    if (!hit) {
      move(db, id, "unknown", "unknown", NO_MATCH);
      return "none";
    }
    move(db, id, "unknown", "confirmed", null, hit);
    return "confirmed";
  }

  // Runs after the comment step. Each end leaves the pending state, so the drain loop cannot repeat a row.
  async function resolveStep(db: Database, r: PostRow) {
    const end = (state: "done" | "failed", text: string | null) => {
      db.query(SQL.resolveEnd).run({ id: r.id, state, text, now: now() });
      notify(r.pr);
    };
    const ref = refOf(db, r.pr);
    const forge = await provider();
    if (!ref || !forge || r.resolve_root === null) return end("failed", UNCONFIGURED);
    let res: ResolveResult;
    try {
      res = await forge.setThreadResolved(ref, r.resolve_root, true);
    } catch (e) {
      if (!(e instanceof ForgeError)) log(`Post ${r.id} resolve: ${(e as Error).message}`);
      return end("failed", `No clear answer from Bitbucket (${reason(e)}). Resolve again reads the thread first.`);
    }
    if (res.status !== "done") return end("failed", resolveText(res.status, true));
    applyState(db, r.pr, r.resolve_root, res);
    end("done", null);
  }

  async function drain() {
    for (;;) {
      const db = stopped ? null : open();
      if (!db) return;
      const next = db.query(SQL.next).get() as PostRow | null;
      if (next) {
        await send(db, next);
        continue;
      }
      const resolving = db.query(SQL.resolveNext).get() as PostRow | null;
      if (resolving) {
        await resolveStep(db, resolving);
        continue;
      }
      const [id] = checking;
      if (id === undefined) return;
      const pr = row(db, id)?.pr;
      await check(db, id);
      checking.delete(id);
      if (pr !== undefined) notify(pr);
    }
  }

  // One drain at a time. A kick during a drain runs one more pass.
  function kick(): Promise<void> {
    if (stopped) return Promise.resolve();
    again = true;
    busy ??= (async () => {
      try {
        while (again && !stopped) {
          again = false;
          try {
            await drain();
          } catch (e) {
            // A settings change closes the database. A kick during the drain still runs the next pass.
            log(`Outbox pass stopped: ${(e as Error).message}`);
          }
        }
      } finally {
        busy = null;
      }
    })();
    return busy;
  }

  settings.onSettingsChanged(() => {
    open();
  });

  // The source head must equal the reviewed head of every run. A moved target head only warns (D2).
  async function headCheck(db: Database, pr: number, runs: number[]): Promise<HeadCheck> {
    const ref = refOf(db, pr);
    const forge = await provider();
    if (!ref || !forge) return { status: 409, error: UNCONFIGURED };
    let live: Awaited<ReturnType<ForgeProvider["getPullRequest"]>>;
    try {
      live = await forge.getPullRequest(ref);
    } catch (e) {
      return { status: 502, error: `Could not read the pull request on Bitbucket (${reason(e)}).` };
    }
    const heads = runs.map((run) => db.query(SQL.heads).get({ run }) as { source_head: string; target_head: string } | null);
    if (heads.some((h) => h?.source_head !== live.sourceHead))
      return { status: 409, error: "The source branch has new commits since the review. Review it again." };
    return {
      warning: heads.some((h) => h?.target_head !== live.targetHead)
        ? "The target branch moved since the review. The comments stay on the reviewed commits."
        : null,
    };
  }

  // The rows of an earlier confirm with exactly these items and revisions (A14), else null.
  function existing(db: Database, pr: number, want: Map<number, number>): PostDto[] | null {
    const rows = (db.query(SQL.runPosts).all({ pr }) as PostRow[]).filter((r) => {
      const items = parseList(r.items_json);
      return items.length > 0 && items.every((i) => want.get(i.id) === i.revision);
    });
    const ids = new Set(rows.flatMap((r) => parseList(r.items_json).map((i) => i.id)));
    return rows.length > 0 && ids.size === want.size ? rows.map(toDto) : null;
  }

  return {
    open,
    // Restart recovery, then the send of pending rows and the check of unknown rows.
    start() {
      stopped = false;
      open();
    },
    // Waits for the active request. Rows that wait stay pending for the next start.
    async stop() {
      stopped = true;
      await busy;
    },
    // Resolves when the sender is idle.
    wait: () => busy ?? Promise.resolve(),
    headCheck,
    existing,

    posts(db: Database, pr: number): PostDto[] | null {
      return refOf(db, pr) ? (db.query(SQL.byPr).all({ pr }) as PostRow[]).map(toDto) : null;
    },

    // One transaction: the items become posted and the rows appear. existing: an earlier confirm made the rows.
    // null: an item changed after the plan was read.
    enqueue(db: Database, pr: number, posts: PlannedPost[], want: Map<number, number>): { rows: PostDto[]; existing: boolean } | null {
      const conflict = new Error("conflict");
      let out: { rows: PostDto[]; existing: boolean };
      try {
        out = db.transaction(() => {
          const done = existing(db, pr, want);
          if (done) return { rows: done, existing: true };
          const rows = posts.map((p) => {
            for (const it of p.items) if (!db.query(SQL.take).run(it).changes) throw conflict;
            return toDto(
              db.query(SQL.insert).get({
                pr,
                run: p.run,
                kind: p.destination.kind,
                key: runKey(pr, p),
                body: p.body,
                destination: JSON.stringify(p.destination),
                items: JSON.stringify(p.items),
                now: now(),
                resolve: p.resolve ?? null,
              }) as PostRow,
            );
          });
          return { rows, existing: false };
        })();
      } catch (e) {
        if (e === conflict) return null;
        throw e;
      }
      if (!out.existing) {
        notify(pr);
        void kick();
      }
      return out;
    },

    // A manual reply (replies.md step 3). The same key returns its row and never sends twice.
    reply(db: Database, pr: number, input: ReplyPostInput): ReplyResult {
      const key = `reply:${pr}:${input.key}`;
      const dup = db.query(SQL.byKey).get({ key }) as PostRow | null;
      if (dup) {
        const d = JSON.parse(dup.destination_json) as PostDestination;
        return dup.body === input.body && d.kind === "reply" && d.parentId === input.parentId
          ? { status: 200, post: toDto(dup) }
          : { status: 409, error: "This reply was already sent with another text." };
      }
      if (!refOf(db, pr)) return { status: 404, error: "Pull request not found." };
      const parent = db.query(SQL.parent).get({ pr, id: input.parentId }) as { root_id: number; tombstoned_at: number | null } | null;
      if (!parent) return { status: 404, error: "Comment not found." };
      if (parent.tombstoned_at !== null) return { status: 409, error: "The comment was deleted." };
      const newest = newestLive(db.query(SQL.thread).all({ pr, root: parent.root_id }) as TurnMsg[]);
      if (newest && newest.id !== input.seen)
        return { status: 409, conflict: { error: "New messages arrived in the thread. Read them first.", newest: newest.id } };
      const destination: PostDestination = { kind: "reply", parentId: input.parentId };
      const r = db.query(SQL.insert).get({
        pr,
        run: null,
        kind: "reply",
        key,
        body: input.body,
        destination: JSON.stringify(destination),
        items: "[]",
        now: now(),
        resolve: null,
      }) as PostRow;
      notify(pr);
      void kick();
      return { status: 202, post: toDto(r) };
    },

    // "Post again". An unknown row is checked first, so a match confirms it with no second POST.
    async retry(db: Database, id: number): Promise<RetryResult> {
      let r = row(db, id);
      if (!r) return { status: 404, error: "Post not found." };
      if (r.state === "unknown") {
        checking.add(id);
        notify(r.pr);
        const found = await check(db, id).finally(() => checking.delete(id));
        if (found === "unclear") return { status: 502, error: "Could not check the comments on Bitbucket. Try again, or drop the post." };
        r = row(db, id);
        if (!r) return { status: 404, error: "Post not found." };
        if (r.state === "confirmed") {
          notify(r.pr);
          return { status: 200, post: toDto(r) };
        }
      }
      if (r.state !== "unknown" && r.state !== "failed") return { status: 409, error: "Only an unknown or failed post can post again." };
      // D14: a reply post checks its parent, never the heads. A reply post of a review run too.
      if (r.run !== null && r.kind !== "reply") {
        const heads = await headCheck(db, r.pr, [r.run]);
        if ("error" in heads) return heads;
      }
      if (!move(db, id, r.state, "pending", null)) return { status: 409, error: "The post changed. Check it again." };
      notify(r.pr);
      void kick();
      return { status: 202, post: toDto(row(db, id) as PostRow) };
    },

    // "Resolve again" after a failed resolve step. The comment of the row is posted already, so only the resolve runs again.
    retryResolve(db: Database, id: number): ResolveRetry {
      const r = row(db, id);
      if (!r) return { status: 404, error: "Post not found." };
      if (!db.query(SQL.resolveAgain).run({ id, now: now() }).changes)
        return { status: 409, error: "Only a failed resolve can run again." };
      notify(r.pr);
      void kick();
      return { status: 202, post: toDto(row(db, id) as PostRow) };
    },

    // A manual resolve or reopen: one immediate user action, never queued. seen: the newest live message on screen.
    async setResolved(db: Database, pr: number, input: ThreadResolveInput): Promise<ThreadResolveResult> {
      const ref = refOf(db, pr);
      if (!ref) return { status: 404, error: "Pull request not found." };
      const root = db.query(SQL.parent).get({ pr, id: input.thread }) as { root_id: number } | null;
      if (root?.root_id !== input.thread) return { status: 404, error: "Thread not found." };
      const newest = newestLive(db.query(SQL.thread).all({ pr, root: input.thread }) as TurnMsg[]);
      if (newest && newest.id !== input.seen)
        return { status: 409, error: "New messages arrived in the thread. Read them first.", reason: "messages" };
      const forge = await provider();
      if (!forge) return { status: 409, error: UNCONFIGURED };
      let res: ResolveResult;
      try {
        res = await forge.setThreadResolved(ref, input.thread, input.resolved);
      } catch (e) {
        if (!(e instanceof ForgeError)) log(`Thread ${input.thread} resolve: ${(e as Error).message}`);
        return { status: 502, error: `No clear answer from Bitbucket (${reason(e)}). Try again: the app reads the thread first.` };
      }
      if (res.status === "done") {
        applyState(db, pr, input.thread, res);
        notify(pr);
        return { status: 200, thread: input.thread, resolved: input.resolved };
      }
      const status = { changed: 409, forbidden: 403, gone: 404, ignored: 502 } as const;
      return { status: status[res.status], error: resolveText(res.status, input.resolved), reason: res.status };
    },

    // The user gives up an unknown or failed post. Its items return to accepted with a new revision.
    // general: the findings of a failed inline post go into the general comment of the next plan.
    drop(db: Database, id: number, general: boolean): DropResult {
      const r = row(db, id);
      if (!r) return { status: 404, error: "Post not found." };
      if (r.state !== "unknown" && r.state !== "failed") return { status: 409, error: "Only an unknown or failed post can be dropped." };
      if (general && (r.kind !== "inline" || r.state !== "failed"))
        return { status: 400, error: "Only a failed inline post can move to the general comment." };
      const items = parseList(r.items_json);
      const done = db.transaction(() => {
        if (!db.query(SQL.drop).run({ id, state: r.state }).changes) return false;
        for (const it of items) db.query(SQL.release).run({ id: it.id, outside: general ? 1 : 0 });
        return true;
      })();
      if (!done) return { status: 409, error: "The post changed. Check it again." };
      checking.delete(id);
      notify(r.pr);
      return { status: 200, items };
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
