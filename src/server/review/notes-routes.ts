// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// PR notes API (docs/plans/review-v2/spec.md section 2.9): list, add, change, delete, and undo. Every change broadcasts `changed`
// for the PR. Nothing here goes to Bitbucket except the read of a linked PR.
import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { validator } from "hono/validator";
import type { ZodError } from "zod";
import { type ApiError, noteCreateInput, noteDeleteInput, noteUpdateInput } from "../../shared/dto";
import type { Live } from "../live";
import type { Settings } from "../settings";
import { PEER_READ_MS } from "./context-files";
import type { ReviewJobs } from "./jobs";
import { createNote, deleteNote, listNotes, type NotePr, type NoteResult, type ReadPr, refreshLinks, updateNote } from "./notes";

const positiveId = (what: string) =>
  validator("param", (v: Record<string, string>, c) => {
    const id = Number(v.id);
    return Number.isSafeInteger(id) && id > 0 ? { id } : c.json<ApiError>({ error: `Invalid ${what} ID.` }, 400);
  });
const prParam = positiveId("pull request");
const noteParam = positiveId("note");
const unconfigured = { error: "Configure the Bitbucket URL and token first." } satisfies ApiError;
const PR_SQL = "SELECT id, project, repo, pr_id FROM pull_request WHERE id = $id";
const NOTE_PR = "SELECT pr FROM pr_note WHERE id = $id";
const textError = (e: ZodError) => e.issues.find((i) => i.path[0] === "text")?.message;

// now: the tests pass a clock.
export function createNotesRoutes(opts: { review: ReviewJobs; settings: Settings; live: Live; now?: () => number }) {
  const { review, settings, live } = opts;
  const now = opts.now ?? Date.now;
  const prOf = (db: Database, id: number) => db.query(PR_SQL).get({ id }) as NotePr | null;
  const read = async (): Promise<ReadPr> => {
    const p = await settings.provider().catch(() => null);
    return p ? (ref) => p.getPullRequest(ref) : null;
  };
  const answer = (c: Context, r: NoteResult) => {
    if ("error" in r) {
      if (r.status === 409) return c.json(r.note ? { error: r.error, note: r.note } : { error: r.error }, 409);
      return r.status === 404 ? c.json<ApiError>({ error: r.error }, 404) : c.json<ApiError>({ error: r.error }, 400);
    }
    const pr = (review.open()?.query(NOTE_PR).get({ id: r.note.id }) as { pr: number } | null)?.pr;
    if (pr !== undefined) live.broadcast("changed", { prs: [pr] });
    return r.status === 201 ? c.json(r.note, 201) : c.json(r.note, 200);
  };

  return new Hono()
    .get("/prs/:id/notes", prParam, async (c) => {
      const db = review.open();
      if (!db) return c.json([], 200);
      const id = c.req.valid("param").id;
      if (!prOf(db, id)) return c.json<ApiError>({ error: "Pull request not found." }, 404);
      await refreshLinks(db, id, await read(), now(), AbortSignal.timeout(PEER_READ_MS));
      return c.json(listNotes(db, id), 200);
    })
    .post(
      "/prs/:id/notes",
      prParam,
      validator("json", (v, c) => {
        const r = noteCreateInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: textError(r.error) ?? "Invalid note." }, 400);
      }),
      async (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const pr = prOf(db, c.req.valid("param").id);
        if (!pr) return c.json<ApiError>({ error: "Pull request not found." }, 404);
        return answer(c, await createNote(db, pr, c.req.valid("json"), await read(), now()));
      },
    )
    .put(
      "/notes/:id",
      noteParam,
      validator("json", (v, c) => {
        const r = noteUpdateInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: textError(r.error) ?? "Invalid note change." }, 400);
      }),
      async (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        return answer(c, await updateNote(db, c.req.valid("param").id, (id) => prOf(db, id), c.req.valid("json"), await read(), now()));
      },
    )
    .delete(
      "/notes/:id",
      noteParam,
      validator("json", (v, c) => {
        const r = noteDeleteInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: textError(r.error) ?? "Invalid note change." }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        return answer(c, deleteNote(db, c.req.valid("param").id, c.req.valid("json").version, now()));
      },
    );
}
