// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Approve, Needs work, and their clear (BRIEF section 9 backlog): the provider calls, the error sentences, and the route. No network.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { ForgeError } from "../../src/server/bitbucket/client";
import { NotReviewer, reviewProblem } from "../../src/server/bitbucket/errors";
import { createBitbucketProvider } from "../../src/server/bitbucket/provider";
import { writeConfig } from "../../src/server/config";
import { createLive, type LiveEvent } from "../../src/server/live";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { SyncEngine } from "../../src/server/sync/engine";
import { FAKE_TOKEN, FAKE_USER, type FakeBitbucket, key, reviewWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { asUsername, type RawPr, REVIEW_PR_PATH, reviewPr } from "../support/scenarios";

process.env.REVIEW_LOOP_SECRETS = "memory";
const root = mkdtempSync(join(tmpdir(), "rl-review-status-"));
process.env.REVIEW_LOOP_DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const REF = { project: "PROJ1", repo: "sample-repo-2", id: 1001 };
type Reviewed = Parameters<typeof reviewWrites>[2];

let fake: FakeBitbucket;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  fake?.stop();
});

// The recorded reviewer PR on the fake. user: the username of the token owner; the slug stays "jdoe".
function serve(user = FAKE_USER) {
  fake = startFakeBitbucket();
  fake.user = user;
  const pr = asUsername(reviewPr(), FAKE_USER, user) as RawPr & Reviewed;
  fake.routes[key("GET", REVIEW_PR_PATH)] = () => ({ status: 200, body: pr });
  const writes = reviewWrites(fake, REVIEW_PR_PATH, pr);
  const provider = createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN });
  const sent = () => fake.requests.filter((r) => !r.startsWith("GET "));
  return { pr, writes, provider, sent };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

describe("setReviewStatus", () => {
  test("approve, clear, needs work, and clear send the documented calls, with the slug in the path and the username in the body", async () => {
    const { provider, writes, sent } = serve("J.Doe");
    const mine = async (status: "APPROVED" | "NEEDS_WORK" | "UNAPPROVED") =>
      (await provider.setReviewStatus(REF, "J.Doe", status)).reviewers[0]?.status;
    expect(await mine("APPROVED")).toBe("APPROVED");
    expect(await mine("UNAPPROVED")).toBe("UNAPPROVED");
    expect(await mine("NEEDS_WORK")).toBe("NEEDS_WORK");
    expect(await mine("UNAPPROVED")).toBe("UNAPPROVED");
    expect(writes).toEqual([
      { method: "POST", status: "APPROVED" },
      { method: "DELETE", status: "UNAPPROVED" },
      { method: "PUT", status: "NEEDS_WORK" },
      { method: "PUT", status: "UNAPPROVED" },
    ]);
    expect(sent()).toEqual([
      `POST ${REVIEW_PR_PATH}/approve`,
      `DELETE ${REVIEW_PR_PATH}/approve`,
      `PUT ${REVIEW_PR_PATH}/participants/jdoe`,
      `PUT ${REVIEW_PR_PATH}/participants/jdoe`,
    ]);
  });

  test("needs work over an approval sends one PUT", async () => {
    const { provider, pr, sent } = serve();
    Object.assign(pr.reviewers[0] as object, { status: "APPROVED", approved: true });
    expect((await provider.setReviewStatus(REF, FAKE_USER, "NEEDS_WORK")).reviewers[0]?.status).toBe("NEEDS_WORK");
    expect(sent()).toEqual([`PUT ${REVIEW_PR_PATH}/participants/jdoe`]);
  });

  test("a user who is not a reviewer gets NotReviewer and sends no write", async () => {
    const { provider, sent } = serve();
    expect(await caught(provider.setReviewStatus(REF, "someone", "APPROVED"))).toBeInstanceOf(NotReviewer);
    expect(sent()).toEqual([]);
  });

  test("a refused write throws the ForgeError with its status", async () => {
    const { provider, pr } = serve();
    pr.state = "MERGED";
    expect(await caught(provider.setReviewStatus(REF, FAKE_USER, "APPROVED"))).toMatchObject({ status: 409 });
    fake.routes[key("PUT", `${REVIEW_PR_PATH}/participants/*`)] = { status: 403, body: { errors: [{ message: "No." }] } };
    expect(await caught(provider.setReviewStatus(REF, FAKE_USER, "NEEDS_WORK"))).toMatchObject({ kind: "forbidden", status: 403 });
  });
});

describe("reviewProblem", () => {
  const at = REF;
  const forge = (kind: ConstructorParameters<typeof ForgeError>[0], status?: number) => new ForgeError(kind, "/x", status);
  test("maps 401, 403, 404, and 409 to one clear sentence each", () => {
    expect(reviewProblem(forge("auth", 401), at)).toBe("Bitbucket rejected the token. Enter a new token in Settings.");
    expect(reviewProblem(forge("forbidden", 403), at)).toContain("does not let the token review pull request #1001 in PROJ1/sample-repo-2");
    expect(reviewProblem(forge("not_found", 404), at)).toBe(
      "Bitbucket cannot find pull request #1001 in PROJ1/sample-repo-2. Sync the inbox, then try again.",
    );
    expect(reviewProblem(forge("server", 409), at)).toContain("The pull request is not open, or you are its author.");
    expect(reviewProblem(forge("timeout"), at)).toContain("Sync the inbox to see your review status.");
    expect(reviewProblem(new NotReviewer(1001), at)).toBe("You are not a reviewer of pull request #1001. Sync the inbox.");
  });
});

// ---------- the route ----------
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
let n = 0;

async function app(row: { my_role?: string; state?: string } = {}) {
  const f = serve();
  const dir = join(root, `case-${n++}`);
  writeConfig(dir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: true });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const events: [LiveEvent, unknown][] = [];
  const live = { ...createLive(), broadcast: (e: LiveEvent, d: unknown) => void events.push([e, d]) };
  const syncs = { count: 0 };
  const sync = {
    start() {},
    stop() {},
    async syncNow() {
      syncs.count++;
    },
    status: () => ({ running: false, state: "ok", lastCompleteAt: 5, nextAt: null, error: null }),
    onTaskPrs() {},
  } satisfies SyncEngine;
  const server = createApp({ port: PORT, token: SESSION, live, settings, sync });
  const db = settings.db() as Database;
  cleanup.push(() => db.close());
  const { id } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, my_role, my_status, state, on_dashboard)
      VALUES ('PROJ1', 'sample-repo-2', 1001, 'A change', $role, 'UNAPPROVED', $state, 1) RETURNING id`,
    )
    .get({ role: row.my_role ?? "REVIEWER", state: row.state ?? "OPEN" }) as { id: number };
  const post = async (status: unknown, session = SESSION, prId: number | string = id) => {
    const res = await server.request(`${ORIGIN}/api/prs/${prId}/review-status`, {
      method: "POST",
      headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": session, "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text.startsWith("{") ? JSON.parse(text) : text) as { error?: string; status?: string; id?: number },
    };
  };
  const stored = () => (db.query("SELECT my_status FROM pull_request WHERE id = $id").get({ id }) as { my_status: string }).my_status;
  return { ...f, id, post, stored, events, syncs };
}

describe("POST /api/prs/:id/review-status", () => {
  test("approve, needs work, and clear store the status Bitbucket reports, broadcast the change, and start a sync", async () => {
    const h = await app();
    expect(await h.post("APPROVED")).toEqual({ status: 200, body: { id: h.id, status: "APPROVED" } });
    expect(h.stored()).toBe("APPROVED");
    expect(await h.post("NEEDS_WORK")).toEqual({ status: 200, body: { id: h.id, status: "NEEDS_WORK" } });
    expect(h.stored()).toBe("NEEDS_WORK");
    expect(await h.post("UNAPPROVED")).toEqual({ status: 200, body: { id: h.id, status: "UNAPPROVED" } });
    expect(h.stored()).toBe("UNAPPROVED");
    expect(h.events).toEqual([0, 1, 2].map(() => ["changed", { prs: [h.id] }]));
    expect(h.syncs.count).toBe(3);
  });

  test("the author, a closed PR, and an unknown PR get no Bitbucket write", async () => {
    const author = await app({ my_role: "AUTHOR" });
    expect(await author.post("APPROVED")).toEqual({ status: 409, body: { error: "Only a reviewer can approve this pull request." } });
    expect(author.sent()).toEqual([]);
    fake.stop();
    const closed = await app({ state: "MERGED" });
    expect(await closed.post("NEEDS_WORK")).toEqual({ status: 409, body: { error: "The pull request is not open." } });
    expect((await closed.post("APPROVED", SESSION, 999)).status).toBe(404);
    expect(closed.sent()).toEqual([]);
  });

  test("a bad status gives 400 and a missing session token gives 403, before any write", async () => {
    const h = await app();
    expect((await h.post("MERGED")).status).toBe(400);
    expect((await h.post("APPROVED", "x".repeat(64))).status).toBe(403);
    expect(h.sent()).toEqual([]);
  });

  test("a refused write gives 502 with the sentence and keeps the stored status", async () => {
    const h = await app();
    h.pr.state = "DECLINED";
    expect(await h.post("APPROVED")).toEqual({
      status: 502,
      body: {
        error:
          "Bitbucket refused the review status for pull request #1001 in PROJ1/sample-repo-2. The pull request is not open, or you are its author.",
      },
    });
    expect(h.stored()).toBe("UNAPPROVED");
    expect(h.syncs.count).toBe(1);
  });

  test("a write that Bitbucket accepts without effect gives 502 and stores the status of the read", async () => {
    const h = await app();
    fake.routes[key("POST", `${REVIEW_PR_PATH}/approve`)] = { status: 200, body: {} };
    expect(await h.post("APPROVED")).toEqual({
      status: 502,
      body: { error: "Bitbucket did not apply the change. You now have: no review status." },
    });
    expect(h.stored()).toBe("UNAPPROVED");
  });
});
