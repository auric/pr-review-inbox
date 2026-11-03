// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Inbox API (plan G5). Every mutation broadcasts `changed`.
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { type ApiError, archiveInput, type Claimed, followInput, followUrlInput, readInput } from "../../shared/dto";
import { parsePrUrl } from "../../shared/pr-url";
import { ForgeError } from "../bitbucket/client";
import type { Live } from "../live";
import type { Settings } from "../settings";
import type { SyncEngine } from "../sync/engine";
import { claimTaskEvents } from "../tasks/notify";
import {
  claimEvents,
  cleanupEvents,
  dashboardCheckpoint,
  followKey,
  listArchived,
  listPrs,
  markRead,
  markSeen,
  prDetail,
  setArchived,
  setFollowed,
} from "./queries";

const json = <T extends z.ZodType>(schema: T) =>
  validator("json", (v, c) => {
    const r = schema.safeParse(v);
    return r.success ? (r.data as z.infer<T>) : c.json({ error: "Invalid request." }, 400);
  });

const idParam = validator("param", (v: Record<string, string>, c) => {
  const id = Number(v.id);
  return Number.isSafeInteger(id) && id > 0 ? { id } : c.json({ error: "Invalid pull request ID." }, 400);
});

export function createInboxRoutes(opts: { settings: Settings; sync: SyncEngine; live: Live; now?: () => number }) {
  const { settings, sync, live } = opts;
  const now = opts.now ?? Date.now;
  let cleaned: Database | null = null;

  // The database of the configured origin. The first use of each database deletes claimed events older than 30 days.
  const open = () => {
    const db = settings.db();
    const config = settings.config();
    if (!db || !config) return null;
    if (cleaned !== db) {
      cleanupEvents(db, now());
      cleaned = db;
    }
    return { db, me: config.userSlug };
  };
  const changed = (id: number) => live.broadcast("changed", { prs: [id] });
  const unconfigured = { error: "Configure the Bitbucket URL and token first." } satisfies ApiError;

  return new Hono()
    .get("/status", (c) => {
      const s = open();
      return c.json({ sync: sync.status(), dashboard: s ? dashboardCheckpoint(s.db) : null });
    })
    .get("/prs", (c) => {
      const s = open();
      return c.json(s ? listPrs(s.db, s.me) : []);
    })
    .get("/archive", (c) => {
      const s = open();
      return c.json(s ? listArchived(s.db, s.me) : []);
    })
    .get("/prs/:id", idParam, (c) => {
      const s = open();
      const detail = s && prDetail(s.db, s.me, c.req.valid("param").id);
      return detail ? c.json(detail, 200) : c.json({ error: "Pull request not found." }, 404);
    })
    .post("/read", json(readInput), (c) => {
      const s = open();
      if (!s) return c.json(unconfigured, 409);
      const { pr, items } = c.req.valid("json");
      const updated = markRead(s.db, pr, items);
      changed(pr);
      return c.json({ updated }, 200);
    })
    .post("/prs/:id/follow", idParam, json(followInput), (c) => {
      const s = open();
      if (!s) return c.json(unconfigured, 409);
      const { followed } = c.req.valid("json");
      const state = setFollowed(s.db, c.req.valid("param").id, followed);
      if (!state) return c.json({ error: "Pull request not found." }, 404);
      changed(state.id);
      if (followed) void sync.syncNow();
      return c.json(state, 200);
    })
    .post("/prs/:id/seen", idParam, (c) => {
      const s = open();
      if (!s) return c.json(unconfigured, 409);
      const seen = markSeen(s.db, c.req.valid("param").id, now());
      if (!seen) return c.json({ error: "Pull request not found." }, 404);
      changed(seen.id);
      return c.json(seen, 200);
    })
    .post("/prs/:id/archive", idParam, json(archiveInput), (c) => {
      const s = open();
      if (!s) return c.json(unconfigured, 409);
      const state = setArchived(s.db, c.req.valid("param").id, c.req.valid("json").archived, now());
      if (!state) return c.json({ error: "Pull request not found." }, 404);
      changed(state.id);
      return c.json(state, 200);
    })
    .post("/follow", json(followUrlInput), async (c) => {
      const config = settings.config();
      if (!config) return c.json(unconfigured, 409);
      let ref: ReturnType<typeof parsePrUrl>;
      try {
        // Refuses a foreign origin before any request, so the token never goes to another host.
        ref = parsePrUrl(c.req.valid("json").url, config.baseUrl);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
      let provider: Awaited<ReturnType<Settings["provider"]>>;
      try {
        provider = await settings.provider();
      } catch {
        return c.json({ error: "Cannot read the CA file." }, 409);
      }
      if (!provider) return c.json(unconfigured, 409);
      const s = open();
      if (!s) return c.json(unconfigured, 409);
      let key: { project: string; repo: string; pr_id: number };
      try {
        // The response key is canonical. The URL key can differ in case.
        const pr = await provider.getPullRequest(ref);
        key = { project: pr.ref.project, repo: pr.ref.repo, pr_id: pr.ref.id };
      } catch (e) {
        if (!(e instanceof ForgeError)) throw e;
        if (e.kind === "not_found") return c.json({ error: "Bitbucket does not know this pull request." }, 404);
        return c.json({ error: `Bitbucket request failed: ${e.message}` }, 502);
      }
      // A settings change during the request switched the database. The key belongs to the old origin.
      if (settings.db() !== s.db) return c.json({ error: "The settings changed. Try again." }, 409);
      const state = followKey(s.db, key);
      changed(state.id);
      void sync.syncNow();
      return c.json(state, 200);
    })
    .post("/notifications/claim", (c) => {
      const s = open();
      if (!s) return c.json(unconfigured, 409);
      const events = claimEvents(s.db, now());
      if (events.length) live.broadcast("changed", { prs: [...new Set(events.map((e) => e.pr))] });
      const claimed: Claimed[] = [...events, ...claimTaskEvents(s.db, now())];
      return c.json(claimed, 200);
    });
}
