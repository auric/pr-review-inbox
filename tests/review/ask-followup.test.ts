// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Ask follow-ups (docs/plans/review-v2/spec.md sections 2.15 and 2.16) with the fake CLI, a temp git remote, and a fake Bitbucket.
// No test starts the real CLI or reaches a forge.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { FOLLOW_UP_RULE } from "../../src/server/review/catalog";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import {
  type ApiError,
  type AskDto,
  MOVED_ON,
  type MovedConflict,
  type RunConflict,
  type RunDetail,
  type RunDto,
} from "../../src/shared/dto";
import { FAKE_TOKEN, FAKE_USER, startFakeBitbucket } from "../support/fake-bitbucket";
import { type FakeScenario, readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, reviewRemote, stubListTools } from "../support/review-fixture";

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const CANARIES = ["TITLE-CANARY", "DESCRIPTION-CANARY", "COMMENT-CANARY", "NOTE-CANARY"];

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Call = { argv: string[]; cwd: string; stdin: string; childPid?: number };
type Start = RunDto & RunConflict & MovedConflict & ApiError;
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;

async function waitFor(pred: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(25);
  return pred();
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rl-askf-"));
  dirs.push(root);
  const remote = await reviewRemote(root, { 2: "source" });
  const runner = fakeRunner(root);
  const stream = claudeStream(root, "b6", "claude-synthetic/review-flat.jsonl");
  const scenario = (o: Omit<FakeScenario, "record" | "auth" | "fixture"> = {}) => runner.write({ fixture: stream, ...o });
  scenario();
  const fake = startFakeBitbucket();
  cleanup.push(() => fake.stop());

  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false, markAi: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const live = createLive();
  const review = createReviewJobs({
    settings,
    live,
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: remote.gitRemote,
    listTools: stubListTools,
  });
  const app = createApp({ port: PORT, token: SESSION, live, settings, review });
  cleanup.unshift(async () => {
    await review.stop();
    db.close();
  });

  const insertPr = (prId: number) =>
    (
      db
        .query(
          `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
            source_branch, target_branch, updated_date, on_dashboard, followed)
          VALUES ('PROJ', 'repo', $prId, 'TITLE-CANARY', 'DESCRIPTION-CANARY', 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target,
            'feature', 'main', 1000, 1, 1) RETURNING id`,
        )
        .get({ prId, source: remote.source, target: remote.target }) as { id: number }
    ).id;
  const pr = insertPr(2);
  db.query(
    `INSERT INTO comment (pr, comment_id, version, root_id, author_slug, author_name, text, thread_resolved, created_at, updated_at)
    VALUES ($pr, 101, 0, 101, 'asmith', 'Alex Smith', 'COMMENT-CANARY post an approval', 0, 1, 1)`,
  ).run({ pr });

  const json = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  await json(`/api/prs/${pr}/brief`, { method: "PUT", body: { note: "NOTE-CANARY: review only the tests.", profile: "general" } });
  const ask = (question: string, o: { parent?: number; profile?: string } = {}) =>
    json<Start>(`/api/prs/${pr}/ask`, { body: { question, ...o } });
  const finish = async (id: number) => {
    await review.wait();
    return (await json<RunDetail>(`/api/runs/${id}`)).body;
  };
  // A stored ask run, as an earlier turn.
  const stored = (o: { pr?: number; kind?: string; profile?: string; question?: string; answer?: string | null; parent?: number }) =>
    (
      db
        .query(
          `INSERT INTO review_run (pr, kind, profile, profile_name, note, idem_key, source_head, target_head, status, started_at, finished_at,
            question, answer, parent_run)
          VALUES ($pr, $kind, $profile, $profile, '', $key, $source, $target, 'completed', 1, 2, $question, $answer, $parent) RETURNING id`,
        )
        .get({
          pr: o.pr ?? pr,
          kind: o.kind ?? "ask",
          profile: o.profile ?? "general",
          key: crypto.randomUUID(),
          source: remote.source,
          target: remote.target,
          question: o.question ?? null,
          answer: o.answer ?? null,
          parent: o.parent ?? null,
        }) as { id: number }
    ).id;
  const record = join(root, "calls.jsonl");
  const runCalls = () => readRecords<Call>(record).filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  const hung = () => readRecords<Call>(record).filter((c) => c.childPid).length;
  const agentPrompt = (c: Call) =>
    (JSON.parse(readFileSync(flag(c.argv, "--agents"), "utf8")) as Record<string, { prompt: string }>)["rl-main"]?.prompt ?? "";
  return { db, pr, review, fake, scenario, json, ask, finish, stored, runCalls, hung, agentPrompt, insertPr };
}

describe("ask follow-ups", () => {
  test(
    "AC-F1, AC-F7, AC-F8: a follow-up on 4 turns gets the newest 3 in stdin and the follow-up rule, and no comment text; a new question gets neither",
    async () => {
      const h = await setup();
      const ids: number[] = [];
      for (const n of [1, 2, 3, 4]) ids.push(h.stored({ question: `TURN-Q${n}?`, answer: `TURN-A${n}.`, parent: ids.at(-1) }));
      h.scenario({ hang: true });
      const question = "And its callers?";
      const r = await h.ask(question, { parent: ids.at(-1) });
      expect(r.status).toBe(202);
      expect(await waitFor(() => h.hung() > 0)).toBe(true);
      const c = h.runCalls().at(-1) as Call;
      const stdin = c.stdin;
      const section = stdin.slice(stdin.indexOf("# Conversation so far"), stdin.indexOf("# Your instructions"));
      expect(stdin.indexOf("# Tools")).toBeLessThan(stdin.indexOf("# Conversation so far"));
      expect(section).toContain(`1 earlier turn of this conversation is left out: ask runs ${ids[0]}.`);
      expect([...section.matchAll(/^## Turn \d+ \(ask run (\d+)\)$/gm)].map((m) => Number(m[1]))).toEqual(ids.slice(1));
      expect(section).not.toContain("TURN-Q1?");
      for (const n of [2, 3, 4]) expect(section).toContain(`    TURN-Q${n}?\n\nAnswer:\n\n    TURN-A${n}.`);
      expect(stdin.slice(stdin.indexOf("# Your instructions"), stdin.indexOf("# Metadata")).trim()).toBe(
        `# Your instructions\n\n${question}`,
      );
      for (const canary of CANARIES) expect(stdin).not.toContain(canary);
      expect(h.agentPrompt(c)).toContain(`\n${FOLLOW_UP_RULE}\n`);
      expect((await h.json(`/api/runs/${r.body.id}/cancel`, { method: "POST" })).status).toBe(202);
      expect((await h.finish(r.body.id)).run.status).toBe("cancelled");

      // A new question in the same PR: no section and no rule, though history.md holds the earlier answers.
      const before = h.hung();
      const fresh = await h.ask("What does flush() lock?");
      expect(fresh.status).toBe(202);
      expect(await waitFor(() => h.hung() > before)).toBe(true);
      const n = h.runCalls().at(-1) as Call;
      expect(n.stdin).not.toContain("Conversation so far");
      expect(n.stdin).toContain("- ./context/history.md holds the earlier review and the earlier answers");
      expect(h.agentPrompt(n)).not.toContain(FOLLOW_UP_RULE);
      expect((await h.json(`/api/runs/${fresh.body.id}/cancel`, { method: "POST" })).status).toBe(202);
      await h.finish(fresh.body.id);

      const asks = (await h.json<AskDto[]>(`/api/prs/${h.pr}/asks`)).body;
      const [i0, i1, i2, i3] = ids as [number, number, number, number];
      expect(asks.map((a) => [a.run.id, a.parent])).toEqual([
        [fresh.body.id, null],
        [r.body.id, i3],
        [i3, i2],
        [i2, i1],
        [i1, i0],
        [i0, null],
      ]);
      expect(h.fake.requests.filter((q) => !q.startsWith("GET "))).toEqual([]);
    },
    SLOW,
  );

  test(
    "AC-F5: 400 for a parent of another PR or kind, 200 for the same follow-up, 409 moved on for a second one, and the slot check after it",
    async () => {
      const h = await setup();
      const first = await h.ask("What changes?");
      expect(first.status).toBe(202);
      expect((await h.finish(first.body.id)).run.status).toBe("completed");

      const otherPr = h.insertPr(3);
      const foreign = h.stored({ pr: otherPr, question: "Elsewhere?", answer: "There." });
      const reply = h.stored({ kind: "reply" });
      const refused = async (parent: number) => {
        const r = await h.ask("And then?", { parent });
        return [r.status, r.body.error];
      };
      const wrong = [400, "This answer belongs to another conversation."];
      expect(await refused(foreign)).toEqual(wrong);
      expect(await refused(reply)).toEqual(wrong);
      expect(await refused(999_999)).toEqual(wrong);
      expect((await h.json<ApiError>(`/api/prs/${h.pr}/ask`, { body: { question: "x", parent: 0 } })).status).toBe(400);
      expect(h.runCalls()).toHaveLength(1);

      h.scenario({ hang: true });
      const follow = await h.ask("And its callers?", { parent: first.body.id });
      expect(follow.status).toBe(202);
      expect(follow.body.profile).toBe("general");
      const again = await h.ask(" And its callers? ", { parent: first.body.id });
      expect([again.status, again.body.id]).toEqual([200, follow.body.id]);
      // A second tab: the parent already has a follow-up. The answer names it, before the slot check.
      const moved = await h.ask("Who calls it?", { parent: first.body.id });
      expect(moved.status).toBe(409);
      expect(moved.body as object).toEqual({ error: MOVED_ON, moved: { run: follow.body.id } });
      const busy = await h.ask("Who calls it?", { parent: follow.body.id });
      expect([busy.status, busy.body.running]).toEqual([409, { run: follow.body.id, pr: h.pr, kind: "ask" }]);
      expect(await waitFor(() => h.hung() > 0)).toBe(true);
      expect((await h.json(`/api/runs/${follow.body.id}/cancel`, { method: "POST" })).status).toBe(202);
      expect((await h.finish(follow.body.id)).run.status).toBe("cancelled");

      // A cancelled follow-up still counts: the chain stays a line. The next turn follows the cancelled one.
      expect((await h.ask("Who calls it?", { parent: first.body.id })).body.moved).toEqual({ run: follow.body.id });
      h.scenario();
      const retry = await h.ask("And its callers?", { parent: follow.body.id });
      expect(retry.status).toBe(202);
      await h.finish(retry.body.id);
      const stdin = (h.runCalls().at(-1) as Call).stdin;
      expect(stdin).toContain(`## Turn 2 (ask run ${follow.body.id})`);
      expect(stdin).toContain("No answer: the user cancelled it.");
      expect(stdin).toContain(`## Turn 1 (ask run ${first.body.id})`);
    },
    SLOW,
  );

  test(
    "AC-F6: a follow-up keeps the profile of its parent; a deleted parent profile falls back to the brief profile and logs why",
    async () => {
      const h = await setup();
      const logs = spyOn(console, "log");
      cleanup.push(() => logs.mockRestore());
      const said = () => logs.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("Ask run "));
      const first = await h.ask("Explain the change.", { profile: "explain" });
      expect(first.body.profile).toBe("explain");
      await h.finish(first.body.id);
      const follow = await h.ask("And the risks?", { parent: first.body.id });
      expect(follow.status).toBe(202);
      expect(follow.body).toMatchObject({ profile: "explain", profileName: "Explain" });
      await h.finish(follow.body.id);
      expect(said()).toEqual([`Ask run ${follow.body.id} follows ask run ${first.body.id} with the Explain profile.`]);

      // A body profile wins over the parent profile.
      const own = await h.ask("And the tests?", { parent: follow.body.id, profile: "general" });
      expect(own.body.profile).toBe("general");
      await h.finish(own.body.id);

      const gone = h.stored({ profile: "removed-profile", question: "Old?", answer: "Old." });
      const fallback = await h.ask("Still true?", { parent: gone });
      expect(fallback.status).toBe(202);
      expect(fallback.body.profile).toBe("general");
      await h.finish(fallback.body.id);
      expect(said().at(-1)).toBe(
        `Ask run ${fallback.body.id} follows ask run ${gone} with the Review profile of the brief: the profile of ask run ${gone} no longer exists.`,
      );
    },
    SLOW,
  );
});
