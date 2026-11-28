// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Write description: describe runs with the fake CLI, a temp git remote, and a fake Bitbucket. No test starts the real CLI or reaches
// a forge. The update writes only to the fake Bitbucket.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { AI_MARK } from "../../src/server/publish/plan";
import { DESCRIBE_RULES, describeAgent, type Profile, SHIPPED_PROFILES } from "../../src/server/review/catalog";
import { createReviewJobs, DESCRIBE_OPEN_ONLY, DESCRIBE_OWN_ONLY } from "../../src/server/review/jobs";
import { buildDescribePrompt, type PromptInput } from "../../src/server/review/prompt";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import { subtaskPrText } from "../../src/server/tasks/pr";
import { type TaskRow, taskRow } from "../../src/server/tasks/tasks";
import type { ApiError, DescribeDto, DescriptionConflict, RunDetail, RunDto } from "../../src/shared/dto";
import { describeJsonSchema, describeResult } from "../../src/shared/review";
import { specResult } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, key, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, type FakeScenario, readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, reviewRemote, stubListTools } from "../support/review-fixture";

for (const m of ["review/jobs", "review/catalog", "review/prompt", "tasks/pr", "publish/plan"])
  console.log(`describe.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Call = { argv: string[]; cwd: string; stdin: string };
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;
const COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };

describe("describe schema and prompt", () => {
  test("the result needs a title, and the CLI schema asks for title, description, and coverage", () => {
    expect(describeResult.safeParse({ title: " ", description: "", coverage: COVERAGE }).success).toBe(false);
    expect(describeResult.safeParse({ title: "A".repeat(256), description: "", coverage: COVERAGE }).success).toBe(false);
    const ok = describeResult.parse({ title: " ABC-1: Lock ", description: "## Risks\n\nNone found.", coverage: COVERAGE });
    expect(ok.title).toBe("ABC-1: Lock");
    const schema = describeJsonSchema() as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["coverage", "description", "title"]);
    expect([...schema.required].sort()).toEqual(["coverage", "description", "title"]);
  });

  test("the agent prompt holds the key rules, and the stdin names the range and the PR text", () => {
    const profile = SHIPPED_PROFILES[0] as Profile;
    const prompt = describeAgent(profile).prompt;
    for (const line of DESCRIBE_RULES) expect(prompt).toContain(line);
    expect(prompt).toContain("so do not invent facts");
    expect(prompt).toContain("Keep each part of the current description that is still true.");
    expect(prompt).toContain("## What changed and why, ## How to test, and ## Risks");
    expect(prompt).toContain("You cannot change files, and you post nothing.");
    // A describe run follows its own rules, not the review prompt of the profile.
    expect(prompt).not.toContain(profile.prompt);
    const input = {
      mergeBase: "b".repeat(40),
      head: "h".repeat(40),
      note: "",
      profile,
      pr: { project: "PROJ", repo: "repo", prId: 2, webUrl: null },
      tasks: [],
      taskFile: true,
    } as unknown as PromptInput;
    const stdin = buildDescribePrompt(input);
    expect(stdin).toContain(`Write the title and the description of the pull request for the change ${"b".repeat(40)}..${"h".repeat(40)}`);
    expect(stdin).toContain("./context/pr.md holds the pull request text");
    expect(stdin).toContain("./context/task.md holds the text of the linked tasks");
  });
});

async function setup(role: "AUTHOR" | "REVIEWER", state = "OPEN", markAi?: boolean) {
  const root = mkdtempSync(join(tmpdir(), "rl-desc-"));
  dirs.push(root);
  const remote = await reviewRemote(root, { 2: "source" });
  const runner = fakeRunner(root);
  const stream = claudeStream(root, "b6", "claude-synthetic/review-flat.jsonl");
  const scenario = (s: Omit<FakeScenario, "record" | "auth" | "fixture"> = {}) => runner.write({ fixture: stream, ...s });
  scenario();
  const fake = startFakeBitbucket();
  cleanup.push(() => fake.stop());
  // The fake PR 101 at version 0, as the create of Gate G1 gives it.
  const forge = repoWrites(fake, "PROJ", "repo");
  const created = await fetch(`${fake.url}${forge.path}/pull-requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${FAKE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Lock",
      description: "Locks each entry.",
      fromRef: { id: "refs/heads/feature" },
      toRef: { id: "refs/heads/main" },
    }),
  });
  expect(created.status).toBe(201);
  forge.writes.length = 0;
  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false, ...(markAi !== undefined && { markAi }) });
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
  const { id: pr } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, pr_version, source_head,
        target_head, source_branch, target_branch, updated_date, on_dashboard, followed)
      VALUES ('PROJ', 'repo', 101, 'Lock', 'Locks each entry.', 'jdoe', 'Jordan', $role, $state, 0, $source, $target, 'feature', 'main',
        1000, 1, 1)
      RETURNING id`,
    )
    .get({ role, state, source: remote.source, target: remote.target }) as { id: number };
  const json = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const start = () => json<RunDto & ApiError>(`/api/prs/${pr}/describe`, { method: "POST" });
  const get = () => json<DescribeDto | null>(`/api/prs/${pr}/describe`);
  const update = (body: unknown) => json<{ version: number } & DescriptionConflict>(`/api/prs/${pr}/description`, { body });
  const finish = async (id: number) => {
    await review.wait();
    return (await json<RunDetail>(`/api/runs/${id}`)).body;
  };
  const runCalls = (): Call[] => readRecords<Call>(join(root, "calls.jsonl")).filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  const row = () => db.query("SELECT title, description, pr_version FROM pull_request WHERE id = $id").get({ id: pr });
  return { db, pr, fake, forge, scenario, json, start, get, update, finish, runCalls, row };
}

describe("describe runs", () => {
  test(
    "a describe run on an own PR: kind describe, the describe schema, no Agent tool; the proposal shows until Update on Bitbucket",
    async () => {
      const h = await setup("AUTHOR");
      expect((await h.get()).body).toBeNull();
      const started = await h.start();
      expect(started.status).toBe(202);
      expect(started.body).toMatchObject({ kind: "describe", status: "running" });
      const d = await h.finish(started.body.id);
      expect(d.run).toMatchObject({ kind: "describe", status: "completed", findings: 0 });
      expect(d.items).toEqual([]);

      const call = h.runCalls().at(-1) as Call;
      const schema = JSON.parse(flag(call.argv, "--json-schema")) as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties).sort()).toEqual(["coverage", "description", "title"]);
      expect(flag(call.argv, "--tools").split(",")).not.toContain("Agent");
      expect(call.argv).not.toContain("--bare");
      expect(call.stdin).toContain(`Write the title and the description of the pull request for the change ${d.run.mergeBase}..`);
      // An echo title names the head commit of the task line.
      const got = (await h.get()).body as DescribeDto;
      expect(got.run.id).toBe(d.run.id);
      expect(got.version).toBe(0);
      expect(got.result?.title).toBe(`Echo title ${d.run.sourceHead.slice(0, 7)}`);
      expect(got.result?.description).toContain("## How to test");
      // The run posts nothing.
      expect(h.forge.writes).toEqual([]);

      const ok = await h.update({ version: 0, title: "Edited title", description: "Edited text.", run: d.run.id });
      expect(ok.status).toBe(200);
      expect(ok.body.version).toBe(1);
      expect(h.forge.writes.map((w) => [w.method, w.path, w.body.version, w.body.title, w.body.description])).toEqual([
        ["PUT", `${h.forge.path}/pull-requests/101`, 0, "Edited title", `${AI_MARK}Edited text.`],
      ]);
      expect(h.row()).toEqual({ title: "Edited title", description: `${AI_MARK}Edited text.`, pr_version: 1 });
      // The proposal closes after the update.
      expect((await h.get()).body?.result).toBeNull();
    },
    SLOW,
  );

  test(
    "a stale version gives 409 with a clear message, and the app stores the current PR text and version",
    async () => {
      const h = await setup("AUTHOR");
      // Another person changes the PR in Bitbucket: version 1.
      const pr = h.forge.prs.get(101) as { version: number; description?: string };
      Object.assign(pr, { version: 1, description: "Changed in Bitbucket." });
      const r = await h.update({ version: 0, title: "Mine", description: "Mine." });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain("Someone changed this pull request in Bitbucket after the app read it.");
      expect(r.body).toMatchObject({ title: "Lock", description: "Changed in Bitbucket.", version: 1 });
      expect(h.row()).toEqual({ title: "Lock", description: "Changed in Bitbucket.", pr_version: 1 });
      // One PUT, never repeated.
      expect(h.forge.writes.filter((w) => w.method === "PUT")).toHaveLength(1);
      const again = await h.update({ version: 1, title: "Mine", description: "Mine." });
      expect(again.status).toBe(200);
    },
    SLOW,
  );

  test(
    "Discard closes the proposal and posts nothing",
    async () => {
      const h = await setup("AUTHOR");
      const started = await h.start();
      await h.finish(started.body.id);
      expect((await h.get()).body?.result).not.toBeNull();
      const res = await h.json(`/api/prs/${h.pr}/describe/discard`, { body: { run: started.body.id } });
      expect(res.status).toBe(200);
      expect((await h.get()).body?.result).toBeNull();
      expect(h.forge.writes).toEqual([]);
    },
    SLOW,
  );

  test(
    "a PR that the user did not author: the start and the update refuse, and nothing goes to Bitbucket",
    async () => {
      const h = await setup("REVIEWER");
      const started = await h.start();
      expect(started.status).toBe(409);
      expect(started.body.error).toBe(DESCRIBE_OWN_ONLY);
      const r = await h.update({ version: 0, title: "Mine", description: "Mine." });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(DESCRIBE_OWN_ONLY);
      expect(h.runCalls()).toEqual([]);
      expect(h.forge.writes).toEqual([]);
    },
    SLOW,
  );

  test(
    "a merged own PR: the start and the update refuse, and nothing goes to Bitbucket",
    async () => {
      const h = await setup("AUTHOR", "MERGED");
      const started = await h.start();
      expect(started.status).toBe(409);
      expect(started.body.error).toBe(DESCRIBE_OPEN_ONLY);
      const r = await h.update({ version: 0, title: "Mine", description: "Mine." });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe(DESCRIBE_OPEN_ONLY);
      expect(h.runCalls()).toEqual([]);
      expect(h.forge.writes).toEqual([]);
    },
    SLOW,
  );

  test(
    "a 409 with an unchanged PR version is no stale text: 502 with the refusal, and the stored text stays",
    async () => {
      const h = await setup("AUTHOR");
      h.fake.routes[key("PUT", `${h.forge.path}/pull-requests/101`)] = { status: 409, body: { errors: [{ message: "Closed." }] } };
      const r = await h.update({ version: 0, title: "Mine", description: "Mine." });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("Bitbucket refused the change (HTTP 409). Check pull request #101 in Bitbucket.");
      expect(h.row()).toEqual({ title: "Lock", description: "Locks each entry.", pr_version: 0 });
    },
    SLOW,
  );

  test(
    "the update input refuses an empty title",
    async () => {
      const h = await setup("AUTHOR");
      const r = await h.update({ version: 0, title: "  ", description: "x" });
      expect(r.status).toBe(400);
      expect(h.forge.writes).toEqual([]);
    },
    SLOW,
  );

  test(
    "the AI mark follows the markAi setting: off adds none, and a text that has the mark keeps one",
    async () => {
      const off = await setup("AUTHOR", "OPEN", false);
      expect((await off.update({ version: 0, title: "T", description: "Plain." })).status).toBe(200);
      expect(off.forge.writes.at(-1)?.body.description).toBe("Plain.");
      const on = await setup("AUTHOR");
      expect((await on.update({ version: 0, title: "T", description: `${AI_MARK}Marked.` })).status).toBe(200);
      expect(on.forge.writes.at(-1)?.body.description).toBe(`${AI_MARK}Marked.`);
    },
    SLOW,
  );

  test(
    "a task PR keeps its plan link, part list, and related links once, and a stale part list goes",
    async () => {
      const h = await setup("AUTHOR");
      const spec = specResult.parse({
        ...echoSpec(),
        title: "Two parts",
        map: ["one", "two"].map((name) => ({ path: `src/${name}.ts`, line: null, symbol: "", kind: "change", what: `The ${name}.` })),
        parts: ["one", "two"].map((name, i) => ({
          n: i + 1,
          kind: "part",
          title: `Part ${name}`,
          goal: `The ${name} works.`,
          lines: 20,
          acceptance: [{ id: "A1", text: `The ${name} works.` }],
          tests: [{ test: `tests/${name}.test.ts`, proves: ["A1"] }],
          tasks: [{ id: "T1", title: `Write ${name}`, files: [`src/${name}.ts`], run: [`tests/${name}.test.ts`], done: "Done." }],
        })),
      });
      const plan = toPlan(spec, "c".repeat(40), [false, false], []);
      const docs = { ...renderDocs("ABC-10", "Two parts", "small", plan), version: 1, parsed: plan, approved: true };
      const { id: task } = h.db
        .query(
          `INSERT INTO task (project, repo, key, title, state, size, target_branch, spec_dir, docs_json, subtasks, created_at, updated_at)
          VALUES ('PROJ', 'repo', 'ABC-10', 'Two parts', 'implementing', 'small', 'main', 'specs/ABC-10/', $docs, 1, 1, 1) RETURNING id`,
        )
        .get({ docs: JSON.stringify(docs) }) as { id: number };
      const part = (ord: number, pr: number | null, remote: number | null, state: string) =>
        (
          h.db
            .query(
              `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, pr, remote_pr, state, keys_json, created_at, updated_at)
              VALUES ($task, $ord, 'part', $title, $branch, 'main', $pr, $remote, $state, $keys, 1, 1) RETURNING id`,
            )
            .get({ task, ord, pr, remote, state, title: `Part ${ord}`, branch: `b${ord}`, keys: JSON.stringify([`ABC-1${ord}`]) }) as {
            id: number;
          }
        ).id;
      const p1 = part(1, h.pr, 101, "pr_open");
      const p2 = part(2, null, null, "planned");
      const related = "\n\nRelated PRs:\n- [PROJ/lib #7](https://forge.invalid/7)";
      // The text that the PR create gave: part 2 had no PR then.
      const created = `${(subtaskPrText(h.db, taskRow(h.db, task) as TaskRow, p1, true) as { description: string }).description}${related}`;
      expect(created).toContain("ABC-11: this PR · ABC-12: next");
      h.db.query("UPDATE pull_request SET description = $d WHERE id = $id").run({ d: created, id: h.pr });
      h.db.query("UPDATE task_part SET remote_pr = 102, state = 'pr_open' WHERE id = $id").run({ id: p2 });
      const tail = "The plan: specs/ABC-10/plan.md\n\nParent: ABC-10\nABC-11: this PR · ABC-12: #102 (in review)";
      // Claude keeps the old text below its own and moves the plan link up.
      const text = `The plan: specs/ABC-10/plan.md\n\n## What changed and why\n\nTwo parts.\n\n${created}`;
      expect((await h.update({ version: 0, title: "T", description: text })).status).toBe(200);
      const put = h.forge.writes.at(-1)?.body.description as string;
      const count = (x: string) => put.split(x).length - 1;
      expect(put.startsWith(`${AI_MARK}## What changed and why\n\nTwo parts.`)).toBe(true);
      expect(put.endsWith(`\n\n${tail}${related}`)).toBe(true);
      for (const x of ["The plan: ", "Parent: ABC-10", "ABC-11: this PR", "Related PRs:", "#7](", AI_MARK.trimEnd()])
        expect([x, count(x)]).toEqual([x, 1]);
      expect(put).not.toContain("ABC-12: next");
      // An update of the stored text changes nothing.
      expect((await h.update({ version: 1, title: "T", description: put })).status).toBe(200);
      expect(h.forge.writes.at(-1)?.body.description).toBe(put);
    },
    SLOW,
  );
});
