// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// PR notes (docs/plans/review-v2/spec.md section 2.9): the rows, the checks of note proposals and cites at the run end, the note
// changes of the routes, and the PR links. Only kept notes reach a run (context-files.ts notesFile).
import type { Database } from "bun:sqlite";
import type { NoteCreateInput, NoteDto, NoteRef, NoteUpdateInput } from "../../shared/dto";
import { foldCase, isMe } from "../../shared/me";
import type { NoteProposal } from "../../shared/review";
import { byThread, type TurnMsg } from "../../shared/turn";
import type { PrRef, PullRequest } from "../../shared/types";
import { ForgeError } from "../bitbucket/client";
import type { KeptNote } from "./context-files";

export type NoteRow = {
  id: number;
  pr: number;
  text: string;
  source: NoteDto["source"];
  state: NoteDto["state"];
  thread: number | null;
  run: number | null;
  item: number | null;
  ref_project: string | null;
  ref_repo: string | null;
  ref_pr: number | null;
  ref_title: string | null;
  ref_state: NonNullable<NoteRef["state"]> | null;
  ref_checked_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};
type RefState = NonNullable<NoteRef["state"]>;
// checkedAt: ms of the last read. null: never read.
export type Link = { project: string; repo: string; prId: number; title: string | null; state: RefState | null; checkedAt: number | null };
// The PR of the notes.
export type NotePr = { id: number; project: string; repo: string; pr_id: number };
// Reads one PR from Bitbucket (provider.getPullRequest). null: no Bitbucket connection.
export type ReadPr = ((ref: PrRef) => Promise<PullRequest>) | null;

// The notes GET and the context build read links older than this, at most LINK_READS per call.
export const LINK_AGE_MS = 10 * 60_000;
export const LINK_READS = 5;

const LIVE = "deleted_at IS NULL AND state IN ('kept', 'proposed')";
export const NOTE_SQL = {
  byId: "SELECT * FROM pr_note WHERE id = $id",
  list: `SELECT * FROM pr_note WHERE pr = $pr AND ${LIVE} ORDER BY created_at, id`,
  kept: "SELECT * FROM pr_note WHERE pr = $pr AND deleted_at IS NULL AND state = 'kept' ORDER BY created_at, id",
  // Every text counts against a repeat: kept, proposed, dismissed, and deleted notes.
  texts: "SELECT text FROM pr_note WHERE pr = $pr",
  links: `SELECT ref_project, ref_repo, ref_pr, ref_title, ref_state, ref_checked_at FROM pr_note WHERE pr = $pr AND ref_pr IS NOT NULL`,
  // The suggestions of reply drafts for GET reply-drafts.
  suggestions: `SELECT * FROM pr_note WHERE pr = $pr AND item IS NOT NULL AND deleted_at IS NULL AND state = 'proposed' ORDER BY created_at, id`,
  stale: `SELECT * FROM pr_note WHERE pr = $pr AND ref_pr IS NOT NULL AND ${LIVE} AND (ref_checked_at IS NULL OR ref_checked_at < $before)
    ORDER BY ref_checked_at IS NOT NULL, ref_checked_at, id LIMIT ${LINK_READS}`,
  // A link refresh changes no text and no state, so it keeps the version of the note.
  refreshed: "UPDATE pr_note SET ref_title = COALESCE($title, ref_title), ref_state = $state, ref_checked_at = $now WHERE id = $id",
  insert: `INSERT INTO pr_note (pr, text, source, state, thread, run, item, ref_project, ref_repo, ref_pr, ref_title, ref_state, ref_checked_at,
      created_at, updated_at)
    VALUES ($pr, $text, $source, $state, $thread, $run, $item, $project, $repo, $prId, $title, $refState, $checkedAt, $now, $now) RETURNING *`,
  update: `UPDATE pr_note SET text = $text, state = $state, ref_project = $project, ref_repo = $repo, ref_pr = $prId, ref_title = $title,
      ref_state = $refState, ref_checked_at = $checkedAt, deleted_at = $deleted, version = version + 1, updated_at = $now
    WHERE id = $id AND version = $version RETURNING *`,
  stored: "SELECT title, state FROM pull_request WHERE project = $project AND repo = $repo AND pr_id = $prId",
  turns: `SELECT comment_id AS id, root_id AS rootId, author_slug AS authorSlug, author_login AS authorLogin, created_at AS createdAt,
      tombstoned_at IS NOT NULL AS deleted, thread_resolved AS threadResolved FROM comment WHERE pr = $pr`,
  draftOf: "SELECT id FROM review_item WHERE run = $run AND kind = 'reply' AND thread = $thread ORDER BY id DESC LIMIT 1",
};

const refStates = new Set<string>(["OPEN", "MERGED", "DECLINED", "MISSING"]);
const refState = (s: string | null | undefined): RefState | null => (s && refStates.has(s) ? (s as RefState) : null);

const linkOf = (r: Pick<NoteRow, "ref_project" | "ref_repo" | "ref_pr" | "ref_title" | "ref_state" | "ref_checked_at">): Link | null =>
  r.ref_pr === null || r.ref_project === null || r.ref_repo === null
    ? null
    : { project: r.ref_project, repo: r.ref_repo, prId: r.ref_pr, title: r.ref_title, state: r.ref_state, checkedAt: r.ref_checked_at };

export function toNoteDto(r: NoteRow): NoteDto {
  const l = linkOf(r);
  return {
    id: r.id,
    text: r.text,
    source: r.source,
    state: r.state,
    thread: r.thread,
    run: r.run,
    item: r.item,
    ref: l && { project: l.project, repo: l.repo, prId: l.prId, title: l.title, state: l.state },
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.deleted_at !== null && { deletedAt: r.deleted_at }),
  };
}

export const listNotes = (db: Database, pr: number) => (db.query(NOTE_SQL.list).all({ pr }) as NoteRow[]).map(toNoteDto);

// The kept notes of context/notes.md, oldest first.
export const keptNotes = (db: Database, pr: number): KeptNote[] =>
  (db.query(NOTE_SQL.kept).all({ pr }) as NoteRow[]).map((r) => {
    const l = linkOf(r);
    return { id: r.id, createdAt: r.created_at, text: r.text, ref: l && { ...l } };
  });

// The suggestions that name each reply draft, by item ID.
export function suggestionsByItem(db: Database, pr: number): Map<number, NoteDto[]> {
  const out = new Map<number, NoteDto[]>();
  for (const r of db.query(NOTE_SQL.suggestions).all({ pr }) as NoteRow[])
    out.set(r.item as number, [...(out.get(r.item as number) ?? []), toNoteDto(r)]);
  return out;
}

// Trim and whitespace collapse. The repeat check is case-sensitive.
const norm = (s: string) => s.trim().replace(/\s+/g, " ");

// ---------- Proposals and cites at the run end (pure) ----------

// threads: per thread with a live message, true when a live message is the user's. texts: every note text of the PR.
// peers: the other open PRs of this run's pr-context.md.
// links: the stored links of the notes of this PR, by PR number in its own repository. me: the user slug of Settings.
export type ProposalCtx = {
  me: string | null;
  threads: ReadonlyMap<number, boolean>;
  texts: readonly string[];
  own: { project: string; repo: string };
  peers: ReadonlyMap<number, { title: string; state: string }>;
  links: ReadonlyMap<number, Link>;
};
export type NewNote = { text: string; thread: number; ref: Link | null };

// spec.md section 2.9 "Validation at the run end". Every drop goes to skipped with its reason. A proposal needs a live message of the
// user in its thread, so a comment of another person alone cannot plant a note.
export function proposeNotes(list: readonly NoteProposal[], c: ProposalCtx, now: number): { add: NewNote[]; skipped: string[] } {
  const add: NewNote[] = [];
  const skipped: string[] = [];
  const seen = new Set(c.texts.map(norm));
  for (const p of list) {
    const text = norm(p.text);
    const drop = (why: string) => skipped.push(`Note proposal for thread ${p.thread} dropped: ${why}.`);
    const mine = c.threads.get(p.thread);
    if (mine === undefined) drop("the thread has no live message");
    else if (c.me === null) drop("no user is set in Settings, so no message counts as the user's");
    else if (!mine) drop("the thread has no message of the user");
    else if (!text) drop("the text is empty");
    else if (seen.has(text)) drop("a note with the same text exists");
    else {
      const peer = p.pr === null ? undefined : c.peers.get(p.pr);
      const stored = p.pr === null ? undefined : c.links.get(p.pr);
      const ref: Link | null = peer
        ? { ...c.own, prId: p.pr as number, title: peer.title, state: refState(peer.state), checkedAt: now }
        : (stored ?? null);
      if (p.pr !== null && !ref)
        skipped.push(`Link of the note proposal for thread ${p.thread} dropped: PR #${p.pr} is not in ./context/pr-context.md.`);
      add.push({ text, thread: p.thread, ref });
      seen.add(text);
    }
  }
  return { add, skipped };
}

// A cite must name another thread of this PR with a live message. own: the thread of the draft, or null for an answer without a thread.
// where: the text that names the answer in a drop line.
export function checkCites(
  cites: readonly number[],
  own: number | null,
  live: ReadonlySet<number>,
  where = `the reply for thread ${own}`,
): { cites: number[]; skipped: string[] } {
  const out: number[] = [];
  const skipped: string[] = [];
  for (const c of new Set(cites)) {
    const why =
      c === own ? "it is the thread of the reply" : !live.has(c) ? "no thread of this pull request with a live message has it" : null;
    if (why) skipped.push(`Cite of thread ${c} in ${where} dropped: ${why}.`);
    else out.push(c);
  }
  return { cites: out, skipped };
}

// The threads of the PR with a live message, and whether a live message is the user's.
export function liveThreads(db: Database, pr: number, me: string | null): Map<number, boolean> {
  type Row = Omit<TurnMsg, "deleted" | "threadResolved"> & { deleted: number; threadResolved: number };
  const out = new Map<number, boolean>();
  const rows = (db.query(NOTE_SQL.turns).all({ pr }) as Row[]).map((m) => ({
    ...m,
    deleted: m.deleted === 1,
    threadResolved: m.threadResolved === 1,
  }));
  for (const [id, msgs] of byThread(rows)) {
    const live = msgs.filter((m) => !m.deleted);
    if (live.length)
      out.set(
        id,
        live.some((m) => isMe({ slug: m.authorSlug, login: m.authorLogin }, me)),
      );
  }
  return out;
}

// The ProposalCtx of a run end. peers: the other open PRs of the run's pr-context.md.
export function proposalContext(
  db: Database,
  pr: NotePr,
  me: string | null,
  peers: ReadonlyMap<number, { title: string; state: string }>,
): ProposalCtx {
  const links = new Map<number, Link>();
  for (const r of db.query(NOTE_SQL.links).all({ pr: pr.id }) as NoteRow[]) {
    const l = linkOf(r);
    if (l && l.project === pr.project && l.repo === pr.repo) links.set(l.prId, l);
  }
  return {
    me,
    threads: liveThreads(db, pr.id, me),
    texts: (db.query(NOTE_SQL.texts).all({ pr: pr.id }) as { text: string }[]).map((r) => r.text),
    own: { project: pr.project, repo: pr.repo },
    peers,
    links,
  };
}

// Stores the suggestions of a run and gives their IDs. Call it in the transaction that stores the drafts of the run. item: the draft of
// the same run in that thread, else NULL.
export function storeProposals(db: Database, pr: number, run: number, add: readonly NewNote[], now: number): number[] {
  const draft = db.query(NOTE_SQL.draftOf);
  const insert = db.query(NOTE_SQL.insert);
  return add.map(
    (n) =>
      (
        insert.get({
          pr,
          text: n.text,
          source: "claude",
          state: "proposed",
          thread: n.thread,
          run,
          item: (draft.get({ run, thread: n.thread }) as { id: number } | null)?.id ?? null,
          ...linkParams(n.ref),
          now,
        }) as NoteRow
      ).id,
  );
}

const linkParams = (l: Link | null) => ({
  project: l?.project ?? null,
  repo: l?.repo ?? null,
  prId: l?.prId ?? null,
  title: l?.title ?? null,
  refState: l?.state ?? null,
  checkedAt: l?.checkedAt ?? null,
});

// ---------- PR links ----------

const notFound = (e: unknown) => e instanceof ForgeError && e.kind === "not_found";

// A link resolves from a stored pull_request row first, else through Bitbucket. Another error keeps the link without a state.
async function resolveLink(
  db: Database,
  pr: NotePr,
  ref: NonNullable<NoteCreateInput["ref"]>,
  read: ReadPr,
  now: number,
): Promise<Link | { status: 400 | 404; error: string }> {
  const project = ref.project ?? pr.project;
  const repo = ref.repo ?? pr.repo;
  // Bitbucket project keys and repository slugs ignore case.
  if (foldCase(project) === foldCase(pr.project) && foldCase(repo) === foldCase(pr.repo) && ref.prId === pr.pr_id)
    return { status: 400, error: "A note cannot wait for its own PR." };
  const base = { project, repo, prId: ref.prId };
  const stored = db.query(NOTE_SQL.stored).get(base) as { title: string | null; state: string | null } | null;
  if (stored) return { ...base, title: stored.title, state: refState(stored.state), checkedAt: now };
  if (!read) return { ...base, title: null, state: null, checkedAt: null };
  try {
    const p = await read({ project, repo, id: ref.prId });
    return { ...base, title: p.title, state: refState(p.state), checkedAt: now };
  } catch (e) {
    if (notFound(e)) return { status: 404, error: `No PR #${ref.prId} in ${project}/${repo}.` };
    return { ...base, title: null, state: null, checkedAt: null };
  }
}

// Reads the links older than LINK_AGE_MS, at most LINK_READS. A 404 gives MISSING. Another failure keeps the old state.
// Without Bitbucket, a stored pull_request row gives the state. signal: the deadline of the caller.
export async function refreshLinks(db: Database, pr: number, read: ReadPr, now: number, signal?: AbortSignal) {
  for (const r of db.query(NOTE_SQL.stale).all({ pr, before: now - LINK_AGE_MS }) as NoteRow[]) {
    if (signal?.aborted) return;
    const l = linkOf(r) as Link;
    const save = (title: string | null, state: RefState | null) => db.query(NOTE_SQL.refreshed).run({ id: r.id, title, state, now });
    if (!read) {
      const s = db.query(NOTE_SQL.stored).get({ project: l.project, repo: l.repo, prId: l.prId }) as {
        title: string | null;
        state: string;
      } | null;
      if (s) save(s.title, refState(s.state));
      continue;
    }
    try {
      const p = await within(read({ project: l.project, repo: l.repo, id: l.prId }), signal);
      save(p.title, refState(p.state));
    } catch (e) {
      if (notFound(e)) save(null, "MISSING");
    }
  }
}

// Ends the wait on abort. The request itself ends at its client timeout.
export function within<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", stop);
        reject(e);
      },
    );
  });
}

// ---------- Route changes ----------

export type NoteResult =
  | { status: 200 | 201; note: NoteDto }
  | { status: 400 | 404; error: string }
  | { status: 409; error: string; note?: NoteDto };

const STALE_TEXT = "The note changed in another place. The current note is shown.";
const rowOf = (db: Database, id: number) => db.query(NOTE_SQL.byId).get({ id }) as NoteRow | null;

export async function createNote(db: Database, pr: NotePr, input: NoteCreateInput, read: ReadPr, now: number): Promise<NoteResult> {
  const link = input.ref ? await resolveLink(db, pr, input.ref, read, now) : null;
  if (link && "error" in link) return link;
  return db.transaction((): NoteResult => {
    const r = db.query(NOTE_SQL.insert).get({
      pr: pr.id,
      text: input.text,
      source: "user",
      state: "kept",
      thread: null,
      run: null,
      item: null,
      ...linkParams(link),
      now,
    }) as NoteRow;
    return { status: 201, note: toNoteDto(r) };
  })();
}

// pr: the PR of the note. A text edit of a suggestion with state kept keeps it in one step.
export async function updateNote(
  db: Database,
  id: number,
  pr: (id: number) => NotePr | null,
  input: NoteUpdateInput,
  read: ReadPr,
  now: number,
): Promise<NoteResult> {
  const cur = rowOf(db, id);
  const owner = cur && pr(cur.pr);
  if (!cur || !owner) return { status: 404, error: "Note not found." };
  if (cur.version !== input.version) return { status: 409, error: STALE_TEXT, note: toNoteDto(cur) };
  if (input.state && cur.source === "user") return { status: 400, error: "A note that you wrote has no suggestion state." };
  if (input.state === "dismissed" && cur.state === "kept")
    return { status: 400, error: "A kept note cannot be dismissed. Delete it instead." };
  if (input.restore && cur.deleted_at === null) return { status: 400, error: "The note is not deleted." };
  if (!input.restore && cur.deleted_at !== null) return { status: 400, error: "The note is deleted. Undo the delete first." };
  const link = input.ref === undefined ? linkOf(cur) : input.ref === null ? null : await resolveLink(db, owner, input.ref, read, now);
  if (link && "error" in link) return link;
  return db.transaction((): NoteResult => {
    const state = input.state ?? cur.state;
    const r = db.query(NOTE_SQL.update).get({
      id,
      version: input.version,
      text: input.text ?? cur.text,
      state,
      ...linkParams(link),
      deleted: input.restore ? null : cur.deleted_at,
      now,
    }) as NoteRow | null;
    if (!r) return { status: 409, error: STALE_TEXT, note: toNoteDto(rowOf(db, id) as NoteRow) };
    return { status: 200, note: toNoteDto(r) };
  })();
}

export function deleteNote(db: Database, id: number, version: number, now: number): NoteResult {
  const cur = rowOf(db, id);
  if (!cur) return { status: 404, error: "Note not found." };
  if (cur.version !== version) return { status: 409, error: STALE_TEXT, note: toNoteDto(cur) };
  if (cur.deleted_at !== null) return { status: 200, note: toNoteDto(cur) };
  const r = db.query(NOTE_SQL.update).get({
    id,
    version,
    text: cur.text,
    state: cur.state,
    ...linkParams(linkOf(cur)),
    deleted: now,
    now,
  }) as NoteRow | null;
  return r ? { status: 200, note: toNoteDto(r) } : { status: 409, error: STALE_TEXT, note: toNoteDto(rowOf(db, id) as NoteRow) };
}
