// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review API (plan v3 WP10, WP12, replies.md WP17, r2 S-RR, S-ASK, r3 S-FIX, review-v2 parts 2 and 3): brief, start, re-review, ask,
// explain, discuss, reply drafts, fix runs, cancel, run, raw output, item triage, review quality stats, and Improve prompt. Every
// mutation of PR data broadcasts `changed`.
// Improve prompt: a new start replaces the running proposal. Nothing saves until the user applies the proposal.
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import {
  type ApiError,
  askInput,
  briefInput,
  discussInput,
  fixRunInput,
  type ItemConflict,
  improveInput,
  itemActionInput,
  type MovedConflict,
  replyRunInput,
  reviewRunInput,
  reviewStatsInput,
} from "../../shared/dto";
import type { Live } from "../live";
import { threadHistory } from "./history";
import { triage } from "./items";
import type { ReviewJobs } from "./jobs";
import { reviewStats } from "./stats";

const positiveId = (what: string) =>
  validator("param", (v: Record<string, string>, c) => {
    const id = Number(v.id);
    return Number.isSafeInteger(id) && id > 0 ? { id } : c.json<ApiError>({ error: `Invalid ${what} ID.` }, 400);
  });
const prParam = positiveId("pull request");
const runParam = positiveId("run");
const itemParam = positiveId("item");
const proposalParam = positiveId("proposal");
const historyParams = z.object({ id: z.coerce.number().int().positive(), thread: z.coerce.number().int().positive() });
const historyParam = validator("param", (v: Record<string, string>, c) => {
  const r = historyParams.safeParse(v);
  return r.success ? r.data : c.json<ApiError>({ error: "Invalid pull request or thread ID." }, 400);
});

const unconfigured = { error: "Configure the Bitbucket URL and token first." } satisfies ApiError;
const UNKNOWN_PROFILE = "Unknown review profile.";
// A bad profile ID gets its own message. Any other bad field gets `what`.
const invalid = (e: z.ZodError, what: string) => (e.issues.some((i) => i.path[0] === "profile") ? UNKNOWN_PROFILE : what);
const notFound = (what: string) => ({ error: `${what} not found.` }) satisfies ApiError;

export function createReviewRoutes(opts: { review: ReviewJobs; live: Live }) {
  const { review, live } = opts;
  return new Hono()
    .get("/prs/:id/brief", prParam, (c) => {
      const db = review.open();
      const brief = db && review.brief(db, c.req.valid("param").id);
      return brief ? c.json(brief, 200) : c.json(notFound("Pull request"), 404);
    })
    .put(
      "/prs/:id/brief",
      prParam,
      validator("json", (v, c) => {
        const r = briefInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid brief." }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const id = c.req.valid("param").id;
        const input = c.req.valid("json");
        if (!review.hasProfile(input.profile)) return c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
        const brief = review.saveBrief(db, id, input);
        if (!brief) return c.json(notFound("Pull request"), 404);
        live.broadcast("changed", { prs: [id] });
        return c.json(brief, 200);
      },
    )
    .post(
      "/prs/:id/review",
      prParam,
      // A query, not a body: clients from before the profile option send no body.
      validator("query", (v, c) => {
        const r = reviewRunInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const { profile } = c.req.valid("query");
        if (profile && !review.hasProfile(profile)) return c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
        const r = review.review(db, c.req.valid("param").id, profile);
        if ("run" in r) return r.status === 202 ? c.json(r.run, 202) : c.json(r.run, 200);
        if ("conflict" in r) return c.json(r.conflict, 409);
        return r.status === 404 ? c.json({ error: r.error }, 404) : c.json({ error: r.error }, 409);
      },
    )
    .post("/prs/:id/rereview", prParam, (c) => {
      const db = review.open();
      if (!db) return c.json(unconfigured, 409);
      const r = review.rereview(db, c.req.valid("param").id);
      if ("run" in r) return r.status === 202 ? c.json(r.run, 202) : c.json(r.run, 200);
      if ("conflict" in r) return c.json(r.conflict, 409);
      return r.status === 404 ? c.json({ error: r.error }, 404) : c.json({ error: r.error }, 409);
    })
    .post(
      "/prs/:id/ask",
      prParam,
      validator("json", (v, c) => {
        const r = askInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: invalid(r.error, "Invalid question.") }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const { question, profile, parent } = c.req.valid("json");
        if (profile && !review.hasProfile(profile)) return c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
        const r = review.ask(db, c.req.valid("param").id, question, profile, parent);
        if ("run" in r) return r.status === 202 ? c.json(r.run, 202) : c.json(r.run, 200);
        if ("conflict" in r) return c.json(r.conflict, 409);
        if (r.moved) return c.json<MovedConflict>({ error: r.error, moved: r.moved }, 409);
        if (r.status === 400) return c.json({ error: r.error }, 400);
        return r.status === 404 ? c.json({ error: r.error }, 404) : c.json({ error: r.error }, 409);
      },
    )
    .post(
      "/prs/:id/explain",
      prParam,
      // docs/plans/review-v2/spec.md section 3.2. A query, as for the review start.
      validator("query", (v, c) => {
        const r = reviewRunInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const { profile } = c.req.valid("query");
        if (profile && !review.hasProfile(profile)) return c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
        const r = review.explain(db, c.req.valid("param").id, profile);
        if ("run" in r) return r.status === 202 ? c.json(r.run, 202) : c.json(r.run, 200);
        if ("conflict" in r) return c.json(r.conflict, 409);
        return r.status === 404 ? c.json({ error: r.error }, 404) : c.json({ error: r.error }, 409);
      },
    )
    .get("/prs/:id/explain", prParam, (c) => {
      const db = review.open();
      const r = db && review.explanation(db, c.req.valid("param").id);
      return r ? c.json(r.explain, 200) : c.json(notFound("Pull request"), 404);
    })
    .get("/prs/:id/asks", prParam, (c) => {
      const db = review.open();
      if (!db) return c.json([], 200);
      const asks = review.asks(db, c.req.valid("param").id);
      return asks ? c.json(asks, 200) : c.json(notFound("Pull request"), 404);
    })
    .post(
      "/prs/:id/reply-run",
      prParam,
      validator("json", (v, c) => {
        const r = replyRunInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: invalid(r.error, "Invalid thread list.") }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const { threads, profile } = c.req.valid("json");
        if (profile && !review.hasProfile(profile)) return c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
        const r = review.draftReplies(db, c.req.valid("param").id, threads, profile);
        if ("run" in r) return r.status === 202 ? c.json(r.run, 202) : c.json(r.run, 200);
        if ("conflict" in r) return c.json(r.conflict, 409);
        if (r.status === 400) return c.json({ error: r.error }, 400);
        return r.status === 404 ? c.json({ error: r.error }, 404) : c.json({ error: r.error }, 409);
      },
    )
    .get("/prs/:id/reply-drafts", prParam, (c) => {
      const db = review.open();
      const items = db && review.replyDrafts(db, c.req.valid("param").id);
      return items ? c.json(items, 200) : c.json(notFound("Pull request"), 404);
    })
    .post(
      "/prs/:id/fix-run",
      prParam,
      validator("json", (v, c) => {
        const r = fixRunInput.safeParse(v);
        // The custom issue is the cap on threads and findings together.
        const cap = r.error?.issues.find((i) => i.code === "custom")?.message;
        return r.success ? r.data : c.json<ApiError>({ error: invalid(r.error, cap ?? "Invalid thread or finding list.") }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const { threads, findings, profile, anyway } = c.req.valid("json");
        if (profile && !review.hasProfile(profile)) return c.json<ApiError>({ error: UNKNOWN_PROFILE }, 400);
        const r = review.fix(db, c.req.valid("param").id, { threads, findings, anyway }, profile);
        if ("run" in r) return r.status === 202 ? c.json(r.run, 202) : c.json(r.run, 200);
        if ("conflict" in r) return c.json(r.conflict, 409);
        if (r.status === 400) return c.json({ error: r.error }, 400);
        return r.status === 404 ? c.json({ error: r.error }, 404) : c.json({ error: r.error }, 409);
      },
    )
    .get("/prs/:id/fixes", prParam, (c) => {
      const db = review.open();
      if (!db) return c.json([], 200);
      const fixes = review.fixes(db, c.req.valid("param").id);
      return fixes ? c.json(fixes, 200) : c.json(notFound("Pull request"), 404);
    })
    .get("/prs/:id/threads/:thread/history", historyParam, (c) => {
      const db = review.open();
      const { id, thread } = c.req.valid("param");
      const history = db && threadHistory(db, id, thread);
      return history ? c.json(history, 200) : c.json(notFound("Thread"), 404);
    })
    .get("/prs/:id/runs", prParam, (c) => {
      const db = review.open();
      return c.json(db ? review.runs(db, c.req.valid("param").id, 20) : [], 200);
    })
    .get("/runs", (c) => {
      const db = review.open();
      return c.json(db ? review.runs(db, null, 50) : [], 200);
    })
    .get("/runs/slots", (c) => {
      // It comes before /runs/:id, which refuses a name that is not a number.
      return c.json(review.slots(review.open()), 200);
    })
    .get("/runs/:id", runParam, (c) => {
      const db = review.open();
      const run = db && review.run(db, c.req.valid("param").id);
      return run ? c.json(run, 200) : c.json(notFound("Run"), 404);
    })
    .get("/runs/:id/raw", runParam, (c) => {
      const db = review.open();
      const raw = db && review.raw(db, c.req.valid("param").id);
      if (typeof raw !== "string") return c.json(notFound("Raw output"), 404);
      c.header("Cache-Control", "no-store");
      return c.text(raw, 200);
    })
    .post(
      "/items/:id",
      itemParam,
      validator("json", (v, c) => {
        const r = itemActionInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid item change." }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const r = triage(db, c.req.valid("param").id, c.req.valid("json"));
        if (r.status === 404) return c.json(notFound("Item"), 404);
        if (r.status === 400) return c.json({ error: r.error }, 400);
        if (r.status === 409) return c.json(r.conflict, 409);
        live.broadcast("changed", { prs: [r.pr], runs: [...new Set([r.item.run, ...(r.runs ?? [])])] });
        return c.json(r.item, 200);
      },
    )
    .post(
      "/items/:id/discuss",
      itemParam,
      // docs/plans/review-v2/spec.md section 2.3: a talk about one finding. Each message is one discuss run. Nothing posts.
      validator("json", (v, c) => {
        const r = discussInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid message." }, 400);
      }),
      (c) => {
        const db = review.open();
        if (!db) return c.json(unconfigured, 409);
        const { message, revision } = c.req.valid("json");
        const r = review.discuss(db, c.req.valid("param").id, message, revision);
        if ("run" in r) return r.status === 202 ? c.json(r.run, 202) : c.json(r.run, 200);
        if ("conflict" in r) return c.json(r.conflict, 409);
        if (r.item) return c.json<ItemConflict>({ error: r.error, item: r.item }, 409);
        return r.status === 404 ? c.json({ error: r.error }, 404) : c.json({ error: r.error }, 409);
      },
    )
    .get("/items/:id/discuss", itemParam, (c) => {
      const db = review.open();
      const turns = db && review.turns(db, c.req.valid("param").id);
      return turns ? c.json(turns, 200) : c.json(notFound("Item"), 404);
    })
    .post(
      "/profiles/improve",
      validator("json", (v, c) => {
        const r = improveInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid profile or goal." }, 400);
      }),
      (c) => c.json(review.improve.start(c.req.valid("json")), 202),
    )
    .get("/profiles/improve/:id", proposalParam, (c) => {
      const p = review.improve.get(c.req.valid("param").id);
      c.header("Cache-Control", "no-store");
      return p ? c.json(p, 200) : c.json(notFound("Proposal"), 404);
    })
    .post("/profiles/improve/:id/cancel", proposalParam, (c) =>
      review.improve.cancel(c.req.valid("param").id)
        ? c.json({ cancelling: true }, 202)
        : c.json<ApiError>({ error: "The proposal is not running." }, 409),
    )
    .get(
      "/stats/review",
      validator("query", (v, c) => {
        const r = reviewStatsInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid number of days. Use 1 to 365." }, 400);
      }),
      (c) => {
        const db = review.open();
        return c.json(db ? reviewStats(db, c.req.valid("query").days) : [], 200);
      },
    )
    .post("/runs/:id/cancel", runParam, (c) => {
      const db = review.open();
      if (!db) return c.json(unconfigured, 409);
      const r = review.cancel(db, c.req.valid("param").id);
      if (r === null) return c.json(notFound("Run"), 404);
      if (r === "not_running") return c.json({ error: "The run is not running." }, 409);
      return c.json({ cancelling: true }, 202);
    });
}
