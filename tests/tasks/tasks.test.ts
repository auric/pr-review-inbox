// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.1 to 6.5 and 6.11 (WP-B2, AC-B1 to AC-B4): create a task from a PR chip or a typed key, the
// interview run, the answers, the spec run with the map check and the size rules, the plan screen actions, and the routes. The fake
// CLI, the fake Bitbucket, the fake Jira, and a temp git remote. No test starts the real CLI or reaches a forge or Jira.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { SHIPPED_PROFILES } from "../../src/server/review/catalog";
import { git, gitEnv } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { pickProblem } from "../../src/server/tasks/files";
import { advance, setBlocked } from "../../src/server/tasks/tasks";
import {
  type ApiError,
  type BranchCheckDto,
  type BranchSearchDto,
  type InstructionPreviewDto,
  type InstructionRepoDto,
  MAX_ATTACHMENT_BYTES,
  MAX_PR_ATTACHMENT_BYTES,
  type ProfileInput,
  RUN_IMAGE_BYTES,
  type RunConflict,
  type TaskConflict,
  type TaskDto,
  type TaskIssueDto,
  type TaskRowDto,
} from "../../src/shared/dto";
import { FAKE_TOKEN, FAKE_USER, key, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, type FakeScenario, readRecords } from "../support/fake-claude";
import { attachmentPath, ISSUE_KEY, JIRA_TOKEN, pngOf, startFakeJira } from "../support/fake-jira";
import { claudeStream, fakeRunner, reviewRemote, stubListTools } from "../support/review-fixture";

for (const m of ["tasks/tasks", "tasks/files", "tasks/plan", "tasks/interview", "tasks/routes", "review/jobs", "review/workspace"])
  console.log(`tasks.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const SUMMARY = "Flush the cache before the write lock";

type Call = {
  argv: string[];
  cwd: string;
  stdin: string;
  childPid?: number;
  context: Record<string, string>;
  attachments: string[];
  skills?: string[];
  agents?: Record<string, { prompt: string }> | null;
};

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const until = async (f: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(20);
  }
};

async function setup(o: { config?: string; profiles?: ProfileInput[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rl-wpb2-"));
  dirs.push(root);
  const remote = await reviewRemote(root, { 2: "source" });
  // Bitbucket names the default branch in HEAD of the repository.
  await git(["--git-dir", remote.remote, "symbolic-ref", "HEAD", "refs/heads/main"], { env: gitEnv(join(root, "empty.gitconfig")) });
  const runner = fakeRunner(root);
  const stream = claudeStream(root, "b6", "claude/b6-hostile-repo.jsonl");
  const scenario = (s: Omit<FakeScenario, "record" | "auth" | "fixture"> = {}) => runner.write({ fixture: stream, ...s });
  scenario();
  const fake = startFakeBitbucket();
  const jira = startFakeJira();
  cleanup.push(
    () => fake.stop(),
    () => jira.stop(),
  );
  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false, ...(o.profiles && { profiles: o.profiles }) });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const db = settings.db() as Database;
  // hold() makes the next remote lookups wait until release.
  let held: (() => Promise<void>) | null = null;
  const hold = () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    held = () => {
      entered.resolve();
      return release.promise;
    };
    return { entered: entered.promise, release: () => release.resolve() };
  };
  const live = createLive();
  const events: { event: string; data: unknown }[] = [];
  const broadcast = live.broadcast;
  live.broadcast = (event, data) => {
    events.push({ event, data });
    broadcast(event, data);
  };
  const review = createReviewJobs({
    settings,
    live,
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: remote.gitRemote,
    repoRemote: async () => {
      await held?.();
      return { url: remote.remote, config: [] };
    },
    listTools: stubListTools,
    claudeConfigDir: o.config ?? join(root, "no-claude-config"),
  });
  const app = createApp({ port: PORT, token: SESSION, live, settings, review });
  cleanup.unshift(async () => {
    await review.stop();
    db.close();
  });
  const { id: pr } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
        source_branch, target_branch, updated_date, on_dashboard, followed)
      VALUES ('PROJ', 'repo', 2, 'Lock', 'Locks each entry.', 'asmith', 'Alex', 'AUTHOR', 'OPEN', $source, $target, 'feature', 'main', 1000, 1, 1)
      RETURNING id`,
    )
    .get({ source: remote.source, target: remote.target }) as { id: number };
  db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, $key, 'title', NULL, 0)").run({ pr, key: ISSUE_KEY });
  const json = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const connectJira = async () =>
    expect((await json("/api/settings/jira", { method: "PUT", body: { baseUrl: jira.url, token: JIRA_TOKEN } })).status).toBe(200);
  const create = (body: Record<string, unknown> = { project: "PROJ", repo: "repo", key: ISSUE_KEY, originPr: pr }) =>
    json<TaskDto & RunConflict & ApiError>("/api/tasks", { body });
  const get = async (id: number) => (await json<TaskDto>(`/api/tasks/${id}`)).body;
  // Waits until no run holds the slot. A run end can start the next run of the task in the same tick.
  const settle = async () => {
    for (;;) {
      await review.wait();
      if (!review.busy()) return;
    }
  };
  const record = join(root, "calls.jsonl");
  const runCalls = (): Call[] => readRecords<Call>(record).filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  const runs = (task: number) =>
    db
      .query("SELECT id, pr, task, kind, status, source_head, summary_json FROM review_run WHERE task = $task ORDER BY id")
      .all({ task }) as {
      id: number;
      pr: number | null;
      task: number;
      kind: string;
      status: string;
      source_head: string;
      summary_json: string | null;
    }[];
  // Answers with the recommended options, then waits for the runs.
  const recommend = async (t: TaskDto) => {
    const r = await json<TaskDto>(`/api/tasks/${t.id}/answers`, { body: { version: t.version, answers: [], recommended: true } });
    expect(r.status).toBe(202);
    await settle();
    return get(t.id);
  };
  // A task from the chip, through the interview, to the plan.
  const toPlan = async () => {
    await connectJira();
    const c = await create();
    expect(c.status).toBe(201);
    await settle();
    return recommend(await get(c.body.id));
  };
  // A branch of the remote at the target head.
  const branchAt = (name: string) =>
    git(["--git-dir", remote.remote, "update-ref", `refs/heads/${name}`, remote.target], { env: gitEnv(join(root, "empty.gitconfig")) });
  return {
    db,
    pr,
    remote,
    scenario,
    json,
    create,
    get,
    settle,
    runCalls,
    runs,
    connectJira,
    recommend,
    toPlan,
    jira,
    events,
    review,
    dir,
    fake,
    branchAt,
    hold,
  };
}

const specWith = (o: Record<string, unknown>) => ({ ...echoSpec(), ...o });

describe("the profile of a task (spec.md section 6.2)", () => {
  test(
    "the task keeps the picked profile; the interview and the spec run use its model and skills; the next Build form preselects it",
    async () => {
      const config = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-task-config-")));
      dirs.push(config);
      mkdirSync(join(config, "skills", "tdd"), { recursive: true });
      writeFileSync(join(config, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test first.\n---\n\nWrite the test first.\n");
      const strict = { ...SHIPPED_PROFILES[0], id: "strict", name: "Strict", model: "sonnet", skills: ["tdd"] } as ProfileInput;
      const h = await setup({ config, profiles: [...SHIPPED_PROFILES, strict] });
      await h.connectJira();
      const pick = async () => (await h.json<{ profile: string }>("/api/tasks/profile?project=PROJ&repo=repo")).body.profile;
      expect(await pick()).toBe("general");
      expect((await h.json("/api/tasks/profile?project=PROJ")).status).toBe(400);
      const base = { project: "PROJ", repo: "repo", key: ISSUE_KEY, originPr: h.pr };
      // An Explain profile gives no code, and an unknown profile is no pick.
      for (const profile of ["explain", "nope"]) expect((await h.create({ ...base, profile })).status).toBe(400);
      expect(h.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
      const c = await h.create({ ...base, profile: "strict" });
      expect([c.status, c.body.profile]).toEqual([201, "strict"]);
      await h.settle();
      expect(await pick()).toBe("strict");
      const t = await h.recommend(await h.get(c.body.id));
      expect(t.plan).not.toBeNull();
      const calls = h.runCalls();
      expect(calls.length).toBe(2);
      for (const call of calls) {
        expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("sonnet");
        expect(call.skills).toContain("tdd/SKILL.md");
        expect(call.agents?.["rl-main"]?.prompt).toContain("The user chose these skills: ./skills/tdd/SKILL.md.");
      }
      const rows = h.db.query("SELECT kind, profile, profile_name FROM review_run WHERE task = $task ORDER BY id").all({ task: c.body.id });
      expect(rows).toEqual([
        { kind: "interview", profile: "strict", profile_name: "Strict" },
        { kind: "spec", profile: "strict", profile_name: "Strict" },
      ]);
    },
    SLOW,
  );
});

describe("create and interview (spec.md sections 6.2 and 6.11, AC-B1)", () => {
  test(
    "AC-B1: Build this task on a chip creates one task and a read-only interview of the target head; a second click opens the same task",
    async () => {
      const h = await setup();
      await h.connectJira();
      const a = await h.create();
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({
        key: ISSUE_KEY,
        title: SUMMARY,
        state: "interview",
        originPr: h.pr,
        targetBranch: "main",
        specDir: `specs/${ISSUE_KEY}/`,
        profile: "general",
      });
      const again = await h.create();
      expect([again.status, again.body.id]).toEqual([200, a.body.id]);
      await h.settle();
      expect((await h.create()).body.id).toBe(a.body.id);
      expect(h.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 1 });

      const [run, ...more] = h.runs(a.body.id);
      expect(more).toEqual([]);
      expect(run).toMatchObject({ pr: null, task: a.body.id, kind: "interview", status: "completed", source_head: h.remote.target });
      const [call] = h.runCalls();
      const flag = (name: string) => call?.argv[call.argv.indexOf(name) + 1];
      expect(flag("--tools")).toBe("Read,Grep,Glob");
      expect(call?.argv).toContain("--restricted");
      expect(call?.cwd).toBe(join(realpathSync.native(h.dir), "runs", String(run?.id), "work"));
      expect(call?.stdin).toContain(`- ./repo holds the branch main at commit ${h.remote.target}.`);
      expect(call?.stdin).toContain("- Round: 1");
      expect(call?.stdin).not.toContain("answers.md");
      // The click fetched the task once and stored it for the PR.
      expect(h.jira.requests.filter((r) => r.startsWith(`GET /rest/api/2/issue/${ISSUE_KEY}?`))).toHaveLength(1);
      expect(h.db.query("SELECT key FROM task_context WHERE pr = $pr").all({ pr: h.pr })).toEqual([{ key: ISSUE_KEY }]);

      const t = await h.get(a.body.id);
      expect(t.state).toBe("interview");
      expect(t.blocked).toEqual({
        kind: "question",
        step: t.steps[0]?.id ?? -1,
        text: "Claude has 2 questions before it writes the plan.",
      });
      expect(t.questions.map((q) => [q.round, q.kind, q.recommended, q.answer])).toEqual([
        [1, "choice", 0, null],
        [1, "text", null, null],
      ]);
      expect(t.steps.map((s) => [s.kind, s.state, s.run])).toEqual([["interview", "ok", run?.id ?? null]]);
      expect(t.interview).toEqual({ round: 1, summary: "Echo: the task asks for a small change.", unknowns: [], done: true });
      expect(t.strip).toEqual({ steps: ["Questions", "Plan", "Build", "Done"], current: 0 });
      expect(h.events).toContainEqual({ event: "changed", data: { prs: [h.pr], tasks: [a.body.id] } });
      // The PR routes never give a task run.
      expect((await h.json(`/api/runs/${run?.id}`)).status).toBe(404);
      expect((await h.json(`/api/runs/${run?.id}/raw`)).status).toBe(404);
      expect((await h.json(`/api/runs/${run?.id}/cancel`, { method: "POST" })).status).toBe(404);
      expect((await h.json<TaskRowDto[]>("/api/tasks")).body.map((r) => r.id)).toEqual([a.body.id]);
    },
    SLOW,
  );

  test(
    "the snapshot is sanitized, the task text is untrusted data, and a cancelled run stops the task",
    async () => {
      const h = await setup();
      await h.connectJira();
      h.scenario({ hang: true });
      const a = await h.create();
      await until(() => h.runCalls().length === 1);
      const run = h.runs(a.body.id)[0]?.id as number;
      const work = join(realpathSync.native(h.dir), "runs", String(run), "work");
      expect(existsSync(join(work, "repo", "CLAUDE.untrusted.md"))).toBe(true);
      expect(existsSync(join(work, "repo", "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(work, "context", "pr.md"))).toBe(false);
      const task = readFileSync(join(work, "context", "task.md"), "utf8");
      expect(task.startsWith("# UNTRUSTED DATA")).toBe(true);
      expect(task).toContain(`## Task ${ISSUE_KEY}: ${SUMMARY}`);
      // A PR start during the task run names it.
      const busy = await h.json<RunConflict>(`/api/prs/${h.pr}/review`, { method: "POST" });
      expect([busy.status, busy.body.running]).toEqual([409, { run, pr: null, kind: "interview", task: a.body.id }]);
      expect(busy.body.error).toBe(`Claude is building ${ISSUE_KEY}. Pause building after this step to start your run.`);
      await h.review.stop();
      const t = await h.get(a.body.id);
      expect([t.state, t.stoppedFrom]).toEqual(["stopped", "interview"]);
      expect(t.blocked).toEqual({ kind: "error", step: t.steps[0]?.id ?? -1, text: "The run was cancelled." });
      expect(t.steps[0]?.state).toBe("cancelled");
      expect(existsSync(join(realpathSync.native(h.dir), "runs", String(run)))).toBe(false);
    },
    SLOW,
  );

  test(
    "Stop during the interview run cancels the run at once",
    async () => {
      const h = await setup();
      await h.connectJira();
      h.scenario({ hang: true });
      const a = await h.create();
      await until(() => h.runCalls().length === 1);
      const t0 = Date.now();
      const stop = await h.json<TaskDto>(`/api/tasks/${a.body.id}/stop`, { body: { version: (await h.get(a.body.id)).version } });
      expect([stop.status, stop.body.state]).toEqual([200, "stopped"]);
      await h.settle();
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(h.runs(a.body.id).map((r) => [r.kind, r.status])).toEqual([["interview", "cancelled"]]);
      const t = await h.get(a.body.id);
      expect([t.state, t.stoppedFrom, t.steps[0]?.state]).toEqual(["stopped", "interview", "cancelled"]);
    },
    SLOW,
  );

  test(
    "Stop right as the interview run ends starts no spec run",
    async () => {
      const h = await setup();
      await h.connectJira();
      h.scenario({ interview: { done: true, summary: "S.", questions: [], unknowns: [], coverage: NO_COVERAGE } });
      // The run end, its finish, and the effect that starts the spec run are one synchronous sequence, so no request can come between
      // them. The hook applies the state change of Stop right after the outer commit of the finish, before the effect.
      const tx = h.db.transaction.bind(h.db);
      let fired = false;
      let depth = 0;
      h.db.transaction = ((fn: (...a: unknown[]) => unknown) => {
        const run = tx(fn);
        return (...a: unknown[]) => {
          depth++;
          let r: unknown;
          try {
            r = run(...a);
          } finally {
            depth--;
          }
          if (depth > 0) return r;
          const t = h.db.query("SELECT id, version FROM task WHERE state = 'spec_draft'").get() as { id: number; version: number } | null;
          if (!fired && t) {
            fired = true;
            const s = advance(h.db, { task: t.id, version: t.version }, { type: "STOP" }, {}, Date.now());
            if (s.status === 200) setBlocked(h.db, { task: t.id, version: s.version }, null, Date.now());
          }
          return r;
        };
      }) as typeof h.db.transaction;
      cleanup.push(() => {
        h.db.transaction = tx;
      });
      const c = await h.create();
      await h.settle();
      expect(fired).toBe(true);
      expect(h.runs(c.body.id).map((r) => [r.kind, r.status])).toEqual([["interview", "completed"]]);
      const t = await h.get(c.body.id);
      expect([t.state, t.stoppedFrom]).toEqual(["stopped", "spec_draft"]);
    },
    SLOW,
  );

  test(
    "the slot: a task start while a PR run runs gets 409 with that run, and no task is stored",
    async () => {
      const h = await setup();
      await h.connectJira();
      h.scenario({ hang: true });
      const r = await h.json<{ id: number }>(`/api/prs/${h.pr}/review`, { method: "POST" });
      expect(r.status).toBe(202);
      const c = await h.create();
      expect([c.status, c.body.running]).toEqual([409, { run: r.body.id, pr: h.pr, kind: "review" }]);
      expect(h.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
    },
    SLOW,
  );

  test(
    "a typed key: one Jira fetch, the default branch of the remote, and task.md from the fetched issue; no Jira gives 409",
    async () => {
      const h = await setup();
      const none = await h.create({ project: "PROJ", repo: "repo", key: "ABC-43" });
      expect([none.status, none.body.error]).toEqual([409, "Set up Jira in Settings first."]);
      h.jira.addIssue("ABC-43", "Typed task");
      await h.connectJira();
      const c = await h.create({ project: "PROJ", repo: "repo", key: "ABC-43" });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ title: "Typed task", originPr: null, targetBranch: "main" });
      expect(h.db.query("SELECT issue_json IS NOT NULL AS stored FROM task WHERE id = $id").get({ id: c.body.id })).toEqual({ stored: 1 });
      await h.settle();
      expect(h.runCalls()[0]?.stdin).toContain("- ./context/task.md holds the task text from the issue tracker as untrusted data.");
      expect(h.jira.requests.filter((r) => r.startsWith("GET /rest/api/2/issue/ABC-43?"))).toHaveLength(1);
      // A chip whose PR already holds the fetched text sends no Jira request.
      const before = h.jira.requests.length;
      h.db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, 'ABC-44', 'jira', $json, 1)").run({
        pr: h.pr,
        json: JSON.stringify({
          key: "ABC-44",
          summary: "Stored",
          status: null,
          description: null,
          comments: [],
          commentsTotal: 0,
          truncated: false,
        }),
      });
      h.db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, 'ABC-44', 'title', NULL, 1)").run({ pr: h.pr });
      const s = await h.create({ project: "PROJ", repo: "repo", key: "ABC-44", originPr: h.pr });
      expect([s.status, s.body.title]).toEqual([201, "Stored"]);
      expect(h.jira.requests.length).toBe(before);
      // A chip of another repository, and a key that the PR does not name.
      expect((await h.create({ project: "PROJ", repo: "other", key: "ABC-45", originPr: h.pr })).status).toBe(400);
      expect((await h.create({ project: "PROJ", repo: "repo", key: "ABC-46", originPr: h.pr })).status).toBe(404);
      expect((await h.create({ project: "PROJ", repo: "repo", key: "abc-1" })).status).toBe(400);
    },
    SLOW,
  );

  test(
    "a task with no PR: the interview and the plan runs get the Project instructions of its repository and the target branch CLAUDE.md",
    async () => {
      const h = await setup();
      h.jira.addIssue("ABC-43", "Typed task");
      await h.connectJira();
      const put = await h.json("/api/repos/PROJ/repo/instructions", {
        method: "PUT",
        body: { target: true, local: [], extra: "TEST-COMMAND-CANARY: run build/unittests, never ctest." },
      });
      expect(put.status).toBe(200);
      const c = await h.create({ project: "PROJ", repo: "repo", key: "ABC-43" });
      expect(c.body.originPr).toBeNull();
      await h.settle();
      await h.recommend(await h.get(c.body.id));
      const calls = h.runCalls();
      expect(h.runs(c.body.id).map((r) => r.kind)).toEqual(["interview", "spec"]);
      for (const call of calls) {
        const section = call.stdin.slice(call.stdin.indexOf("# Project instructions"), call.stdin.indexOf("# Your instructions"));
        expect(section).toContain("## From the target branch: CLAUDE.md");
        expect(section).toContain("Name each lock after the data it guards.");
        expect(section).toContain("TEST-COMMAND-CANARY: run build/unittests, never ctest.");
      }
      // A repository that only a task names shows in the list with no PR and saves by its key.
      h.db
        .query(
          "INSERT INTO task_repo (task, role, project, repo, depth, access, pinned, created_at) VALUES ($task, 'submodule', 'PROJ', 'lib', 1, 'edit', $pin, 1)",
        )
        .run({ task: c.body.id, pin: h.remote.target });
      const list = await h.json<InstructionRepoDto[]>("/api/instructions");
      expect(list.body.map((r) => [r.project, r.repo, r.pr])).toEqual([
        ["PROJ", "lib", null],
        ["PROJ", "repo", h.pr],
      ]);
      const lib = { target: false, local: [], extra: "LIB-RULES" };
      expect(await h.json("/api/repos/PROJ/lib/instructions", { method: "PUT", body: lib })).toEqual({ status: 200, body: lib });
      const preview = await h.json<InstructionPreviewDto>("/api/repos/PROJ/lib/instructions/preview");
      expect([preview.status, preview.body.target, preview.body.text.includes("LIB-RULES")]).toEqual([200, "off", true]);
      const repoPreview = await h.json<InstructionPreviewDto>("/api/repos/PROJ/repo/instructions/preview");
      expect([repoPreview.body.target, repoPreview.body.text.includes("Name each lock")]).toEqual(["read", true]);
      expect((await h.json("/api/repos/PROJ/none/instructions", { method: "PUT", body: lib })).status).toBe(404);
      expect((await h.json("/api/repos/PROJ/lib/instructions", { method: "PUT", body: { ...lib, extra: 1 } })).status).toBe(400);
      expect((await h.json("/api/repos/..%2Fx/lib/instructions", { method: "PUT", body: lib })).status).toBe(400);
    },
    SLOW,
  );

  test(
    "a failed interview run stops the task with the reason; Resume runs the interview again; Stop and Resume keep open questions",
    async () => {
      const h = await setup();
      await h.connectJira();
      h.scenario({ interview: { nope: true } });
      const c = await h.create();
      await h.settle();
      const t = await h.get(c.body.id);
      expect([t.state, t.stoppedFrom, t.blocked?.kind, t.steps[0]?.state]).toEqual(["stopped", "interview", "error", "failed"]);
      expect(t.blocked?.text).toStartWith("The result does not match the interview schema.");
      h.scenario();
      const r = await h.json<TaskDto>(`/api/tasks/${c.body.id}/resume`, { body: { version: t.version } });
      expect([r.status, r.body.state, r.body.blocked]).toEqual([200, "interview", null]);
      await h.settle();
      expect(h.runs(c.body.id).map((x) => x.kind)).toEqual(["interview", "interview"]);
      expect(h.runCalls().at(-1)?.stdin).toContain("- Round: 1");
      const asked = await h.get(c.body.id);
      expect(asked.blocked?.kind).toBe("question");
      const stop = await h.json<TaskDto>(`/api/tasks/${c.body.id}/stop`, { body: { version: asked.version } });
      expect([stop.status, stop.body.state, stop.body.stoppedFrom, stop.body.blocked]).toEqual([200, "stopped", "interview", null]);
      const back = await h.json<TaskDto>(`/api/tasks/${c.body.id}/resume`, { body: { version: stop.body.version } });
      expect([back.status, back.body.state, back.body.blocked?.text]).toEqual([
        200,
        "interview",
        "Claude has 2 questions before it writes the plan.",
      ]);
      expect(h.runs(c.body.id).length).toBe(2);
      // A version mismatch gives 409 with the task.
      const old = await h.json<TaskConflict>(`/api/tasks/${c.body.id}/stop`, { body: { version: stop.body.version } });
      expect([old.status, old.body.task.state]).toEqual([409, "interview"]);
    },
    SLOW,
  );
});

describe("answers (spec.md sections 6.2 and 6.11, AC-B2 and AC-B3)", () => {
  test(
    "AC-B2: Use the recommended answers stores them and starts the spec run; the plan is small with plan.md",
    async () => {
      const h = await setup();
      const t = await h.toPlan();
      expect(t.questions.map((q) => q.answer)).toEqual([
        { choice: 0, text: "" },
        { choice: null, text: "" },
      ]);
      expect(h.runs(t.id).map((r) => [r.kind, r.status])).toEqual([
        ["interview", "completed"],
        ["spec", "completed"],
      ]);
      const spec = h.runCalls()[1];
      expect(spec?.stdin).toContain("- ./context/answers.md holds the user's answers to the questions of the interview.");
      expect(spec?.stdin).toContain("- Line budget: 400 changed lines per pull request");
      expect(t).toMatchObject({ state: "spec_draft", size: "small", sizeBy: "claude", baseCommit: h.remote.target, blocked: null });
      expect(Object.keys(t.docs ?? {}).sort()).toEqual(["plan", "version"]);
      expect(t.docs?.plan).toStartWith(
        `# Plan: ${ISSUE_KEY} ${SUMMARY}\n\n## Integration map\n\n- README.md:1: change — Echo: the title line.\n`,
      );
      expect(t.plan).toEqual({
        proposed: "small",
        minimum: "small",
        rules: [],
        budget: 400,
        missing: 0,
        base: h.remote.target,
        commands: [{ id: "new-1", name: "test", kind: "test", argv: ["bun", "test"], timeoutSec: 600, saved: false }],
        warning: true,
        approved: false,
        maxOpen: null,
        starts: [],
        notes: [],
      });
      expect(t.strip.current).toBe(1);
      // The base commit stays in the cache for later reads.
      const cache = join(realpathSync.native(h.dir), "git", "PROJ", "repo.git");
      expect(
        (
          await git(["--git-dir", cache, "rev-parse", `refs/rl/task/${t.id}/base`], { env: gitEnv(join(h.dir, "git", "empty.gitconfig")) })
        ).trim(),
      ).toBe(h.remote.target);
    },
    SLOW,
  );

  test(
    "AC-B3: round 2 runs once when Claude says the answers can raise new questions; its answers start the spec run",
    async () => {
      const h = await setup();
      await h.connectJira();
      const question = (id: string, text: string) => ({
        id,
        text,
        why: "It changes the tests.",
        kind: "choice",
        options: [
          { label: "Yes", detail: "Do it." },
          { label: "No", detail: "Skip it." },
        ],
        recommended: 1,
      });
      h.scenario({
        interview: {
          done: false,
          summary: "S.",
          questions: [question("q1", "One?"), question("q2", "Two?")],
          unknowns: ["Cache size."],
          coverage: NO_COVERAGE,
        },
      });
      const c = await h.create();
      await h.settle();
      let t = await h.get(c.body.id);
      const [q1, q2] = t.questions;
      const bad = await h.json<ApiError>(`/api/tasks/${t.id}/answers`, {
        body: { version: t.version, answers: [{ question: q1?.id, choice: 7 }] },
      });
      expect([bad.status, bad.body.error]).toEqual([400, `Question ${q1?.id} has no option 7.`]);
      const missing = await h.json<ApiError>(`/api/tasks/${t.id}/answers`, {
        body: { version: t.version, answers: [{ question: q1?.id, choice: 0 }] },
      });
      expect([missing.status, missing.body.error]).toEqual([400, "Answer each question, or use the recommended answers."]);
      const r = await h.json<TaskDto>(`/api/tasks/${t.id}/answers`, {
        body: {
          version: t.version,
          answers: [
            { question: q1?.id, choice: 0, text: "Also log it." },
            { question: q2?.id, choice: 1 },
          ],
        },
      });
      expect([r.status, r.body.state]).toEqual([202, "interview"]);
      await h.settle();
      t = await h.get(c.body.id);
      expect(t.questions.map((q) => [q.round, q.answer])).toEqual([
        [1, { choice: 0, text: "Also log it." }],
        [1, { choice: 1, text: "" }],
        [2, null],
        [2, null],
      ]);
      expect(h.runCalls()[1]?.stdin).toContain("- Round: 2");
      expect(h.runCalls()[1]?.stdin).toContain("answers.md");
      t = await h.recommend(t);
      expect(t.state).toBe("spec_draft");
      expect(h.runs(t.id).map((x) => x.kind)).toEqual(["interview", "interview", "spec"]);
    },
    SLOW,
  );

  test(
    "version and state conflicts give 409 with the current task",
    async () => {
      const h = await setup();
      await h.connectJira();
      const c = await h.create();
      await h.settle();
      const t = await h.get(c.body.id);
      const stale = await h.json<TaskConflict>(`/api/tasks/${t.id}/answers`, {
        body: { version: t.version - 1, answers: [], recommended: true },
      });
      expect([stale.status, stale.body.error, stale.body.task.version]).toEqual([
        409,
        "The task changed on another page. Check it again.",
        t.version,
      ]);
      const early = await h.json<TaskConflict>(`/api/tasks/${t.id}/plan`, { body: { version: t.version, size: "small", commands: [] } });
      expect([early.status, early.body.error]).toEqual([409, "Claude reads the task and asks its questions."]);
      const p = await h.recommend(t);
      for (const [path, body] of [
        ["plan", { version: p.version - 1, size: "small", commands: [] }],
        ["size", { version: p.version - 1, size: "medium" }],
      ] as const) {
        const r = await h.json<TaskConflict>(`/api/tasks/${p.id}/${path}`, { body });
        expect([r.status, r.body.task.version]).toEqual([409, p.version]);
      }
      const docs = await h.json<TaskConflict>(`/api/tasks/${p.id}/docs`, {
        method: "PUT",
        body: { version: p.version - 1, doc: "plan", text: "x" },
      });
      expect(docs.status).toBe(409);
      expect((await h.json(`/api/tasks/${p.id}/answers`, { body: { version: p.version, answers: [] } })).status).toBe(409);
      expect((await h.json(`/api/tasks/${p.id + 99}`)).status).toBe(404);
    },
    SLOW,
  );
});

describe("plan (spec.md sections 6.1 and 6.4, AC-B4)", () => {
  test(
    "the map check: a missing path and a line past the end keep the mark and count in coverage.skipped",
    async () => {
      const h = await setup();
      h.scenario({
        spec: specWith({
          map: [
            { path: "README.md", line: 1, symbol: "", kind: "change", what: "The title." },
            { path: "src/gone.ts", line: null, symbol: "", kind: "caller", what: "Gone." },
            { path: "README.md", line: 99, symbol: "", kind: "test", what: "Past the end." },
          ],
        }),
      });
      const t = await h.toPlan();
      const at = h.remote.target.slice(0, 12);
      expect(t.plan?.missing).toBe(2);
      expect(t.docs?.plan).toContain(`- src/gone.ts: caller — Gone. (not found at ${at})`);
      expect(t.docs?.plan).toContain(`- README.md:99: test to extend — Past the end. (not found at ${at})`);
      expect(t.docs?.plan).toContain("- README.md:1: change — The title.\n");
      const spec = h.runs(t.id)[1];
      expect(spec?.status).toBe("incomplete");
      expect((JSON.parse(spec?.summary_json ?? "{}") as { coverage: { skipped: string[] } }).coverage.skipped).toEqual([
        `Map line 2: src/gone.ts is not found at ${at}.`,
        `Map line 3: README.md:99 is not found at ${at}.`,
      ]);
    },
    SLOW,
  );

  test(
    "AC-B4: db true and size small shows medium with the rule line; a pick under the minimum is refused",
    async () => {
      const h = await setup();
      h.scenario({ spec: specWith({ estimate: { ...echoSpec().estimate, db: true } }) });
      const t = await h.toPlan();
      expect([t.size, t.sizeBy, t.plan?.proposed, t.plan?.minimum, t.plan?.rules]).toEqual([
        "medium",
        "rule",
        "small",
        "medium",
        ["Set to medium: it changes the database."],
      ]);
      expect(Object.keys(t.docs ?? {}).sort()).toEqual(["design", "spec", "tasks", "version"]);
      expect(t.strip.steps).toEqual(["Questions", "Plan", "Spec review", "Build", "Done"]);
      for (const path of ["size", "plan"]) {
        const r = await h.json<TaskConflict>(`/api/tasks/${t.id}/${path}`, { body: { version: t.version, size: "small", commands: [] } });
        expect([r.status, r.body.error]).toEqual([409, "Set to medium: it changes the database."]);
      }
    },
    SLOW,
  );

  test(
    "AC-B4: an estimate of 900 lines with a 400 budget shows large; medium is refused",
    async () => {
      const h = await setup();
      h.scenario({ spec: specWith({ estimate: { ...echoSpec().estimate, lines: 900 } }) });
      const t = await h.toPlan();
      expect([t.size, t.sizeBy, t.plan?.rules]).toEqual(["large", "rule", ["Set to large: the estimate is over 400 changed lines."]]);
      const r = await h.json<TaskConflict>(`/api/tasks/${t.id}/size`, { body: { version: t.version, size: "medium" } });
      expect([r.status, r.body.error]).toEqual([409, "Set to large: the estimate is over 400 changed lines."]);
    },
    SLOW,
  );

  test(
    "plan approval: the first plan of a repository needs the warning and stores the picked commands; a small plan goes to the build",
    async () => {
      const h = await setup();
      const t = await h.toPlan();
      const body = { version: t.version, size: "small", commands: ["new-1"] };
      const warn = await h.json<TaskConflict>(`/api/tasks/${t.id}/plan`, { body });
      expect([warn.status, warn.body.error]).toEqual([409, "Accept the warning first"]);
      expect((await h.json<ApiError>(`/api/tasks/${t.id}/plan`, { body: { ...body, commands: ["nope"], warning: true } })).body).toEqual({
        error: "Command nope is not in the plan.",
      });
      expect((await h.json<ApiError>(`/api/tasks/${t.id}/plan`, { body: { ...body, warning: true, prefix: "bad.." } })).status).toBe(400);
      const ok = await h.json<TaskDto>(`/api/tasks/${t.id}/plan`, { body: { ...body, warning: true, prefix: "task/" } });
      expect([ok.status, ok.body.state, ok.body.plan?.approved, ok.body.plan?.warning]).toEqual([200, "implementing", true, false]);
      // spec.md section 6.16: the prefix and the existing-branch pick go into the task settings, the base into last_base.
      expect(ok.body.settings).toMatchObject({ branchPrefix: "task/", existing: "continue" });
      expect(h.db.query("SELECT last_base FROM repo_task_settings WHERE project = $p AND repo = $r").get({ p: "PROJ", r: "repo" })).toEqual(
        {
          last_base: "main",
        },
      );
      const row = h.db.query("SELECT commands_json, warned_at FROM repo_task_settings WHERE project = 'PROJ' AND repo = 'repo'").get() as {
        commands_json: string;
        warned_at: number | null;
      };
      expect(JSON.parse(row.commands_json)).toEqual([{ id: "cmd1", name: "test", kind: "test", argv: ["bun", "test"], timeoutSec: 600 }]);
      expect(row.warned_at).not.toBeNull();
      const settings = await h.json<{ commands: unknown[]; warnedAt: number | null; lineBudget: number }>(
        "/api/repos/PROJ/repo/task-settings",
      );
      expect([settings.body.commands.length, settings.body.warnedAt, settings.body.lineBudget]).toEqual([1, row.warned_at, 400]);
    },
    SLOW,
  );

  test(
    "plan approval with edited commands: an edited proposal and an added command are stored as the user wrote them",
    async () => {
      const h = await setup();
      const t = await h.toPlan();
      const edited = { id: "new-1", name: "unit", kind: "test", argv: ["build/unittests", "--all"], timeoutSec: 600 };
      const added = { id: "new-u1", name: "venv", kind: "setup", argv: ["python", "-m", "venv", ".venv"], timeoutSec: 600 };
      const body = { version: t.version, size: "small", warning: true };
      // An object needs an offered ID or a "new-" ID, and the IDs stay unique.
      expect((await h.json<ApiError>(`/api/tasks/${t.id}/plan`, { body: { ...body, commands: [{ ...added, id: "cmd9" }] } })).body).toEqual(
        {
          error: "Command cmd9 is not in the plan.",
        },
      );
      expect((await h.json<ApiError>(`/api/tasks/${t.id}/plan`, { body: { ...body, commands: ["new-1", edited] } })).status).toBe(400);
      expect((await h.json(`/api/tasks/${t.id}/plan`, { body: { ...body, commands: [{ ...added, argv: [] }] } })).status).toBe(400);
      const ok = await h.json<TaskDto>(`/api/tasks/${t.id}/plan`, { body: { ...body, commands: [added, edited] } });
      expect(ok.status).toBe(200);
      const row = h.db.query("SELECT commands_json FROM repo_task_settings WHERE project = 'PROJ' AND repo = 'repo'").get() as {
        commands_json: string;
      };
      expect(JSON.parse(row.commands_json)).toEqual([
        { ...added, id: "cmd1" },
        { ...edited, id: "cmd2" },
      ]);
    },
    SLOW,
  );

  test("task settings: the defaults without a row; PUT stores the fields and keeps the warning; bad input gives 400", async () => {
    const h = await setup();
    const get = () =>
      h.json<{ specDir: string; lineBudget: number; commands: unknown[]; warnedAt: number | null }>("/api/repos/PROJ/repo/task-settings");
    expect((await get()).body).toMatchObject({ specDir: "specs/{key}/", lineBudget: 400, commands: [], warnedAt: null });
    h.db.query("INSERT INTO repo_task_settings (project, repo, warned_at, updated_at) VALUES ('PROJ', 'repo', 5, 5)").run();
    const cmd = { id: "t", name: "test", kind: "test", argv: ["bun", "test"], timeoutSec: 60 };
    const body = {
      specDir: "docs/specs/{key}/",
      branchPrefix: "task/",
      lineBudget: 300,
      maxOpen: 1,
      approvals: 2,
      commands: [cmd],
      testGlobs: ["tests/**"],
      excludeGlobs: null,
      isolateHome: false,
    };
    const put = await h.json(`/api/repos/PROJ/repo/task-settings`, { method: "PUT", body });
    expect(put.status).toBe(200);
    // spec.md section 6.16.1: the route drops branchPrefix, and the column keeps its value.
    expect(put.body).not.toHaveProperty("branchPrefix");
    expect(
      h.db.query("SELECT branch_prefix FROM repo_task_settings WHERE project = $p AND repo = $r").get({ p: "PROJ", r: "repo" }),
    ).toEqual({
      branch_prefix: "feature/",
    });
    expect((await get()).body).toMatchObject({ specDir: "docs/specs/{key}/", lineBudget: 300, commands: [cmd], warnedAt: 5 });
    expect((await h.json(`/api/repos/PROJ/repo/task-settings`, { method: "PUT", body: { ...body, commands: [cmd, cmd] } })).status).toBe(
      400,
    );
    expect((await h.json(`/api/repos/PROJ/repo/task-settings`, { method: "PUT", body: { ...body, specDir: "../x" } })).status).toBe(400);
    expect(
      (await h.json(`/api/repos/PROJ/repo/task-settings`, { method: "PUT", body: { ...body, commands: [{ ...cmd, argv: [] }] } })).status,
    ).toBe(400);
    expect((await h.json("/api/repos/PR%20J/repo/task-settings")).status).toBe(400);
  });

  test(
    "a medium plan stays in spec_draft after its approval; the next plan of the repository needs no warning and offers a saved command once",
    async () => {
      const h = await setup();
      const first = await h.toPlan();
      expect(
        (
          await h.json(`/api/tasks/${first.id}/plan`, {
            body: { version: first.version, size: "small", commands: ["new-1"], warning: true },
          })
        ).status,
      ).toBe(200);
      h.jira.addIssue("ABC-47", "Second task");
      h.scenario({ spec: specWith({ estimate: { ...echoSpec().estimate, api: true } }) });
      const c = await h.create({ project: "PROJ", repo: "repo", key: "ABC-47" });
      expect(c.status).toBe(201);
      await h.settle();
      const t = await h.recommend(await h.get(c.body.id));
      expect([t.size, t.plan?.warning]).toEqual(["medium", false]);
      expect(t.plan?.commands).toEqual([{ id: "cmd1", name: "test", kind: "test", argv: ["bun", "test"], timeoutSec: 600, saved: true }]);
      const ok = await h.json<TaskDto>(`/api/tasks/${t.id}/plan`, { body: { version: t.version, size: "medium", commands: ["cmd1"] } });
      expect([ok.status, ok.body.state, ok.body.plan?.approved]).toEqual([200, "spec_draft", true]);
    },
    SLOW,
  );

  test(
    "PUT docs: a valid tasks edit parses back; a broken edit gives 422 with the line and keeps the old text; a size change moves the edits",
    async () => {
      const h = await setup();
      const t = await h.toPlan();
      const plan = t.docs?.plan ?? "";
      const added = `${plan}\n### [ ] T1.2 Second task\nFiles: README.md\nRun: tests/readme.test.ts\nDone when: The test passes.\n`;
      const ok = await h.json<TaskDto>(`/api/tasks/${t.id}/docs`, {
        method: "PUT",
        body: { version: t.version, doc: "plan", text: added },
      });
      expect([ok.status, ok.body.docs?.plan, ok.body.docs?.version]).toEqual([200, added, (t.docs?.version ?? 0) + 1]);
      const broken = added.replace("Done when: The test passes.\n", "");
      const line = broken.split("\n").indexOf("### [ ] T1.2 Second task") + 1;
      const bad = await h.json<ApiError & { line: number }>(`/api/tasks/${t.id}/docs`, {
        method: "PUT",
        body: { version: ok.body.version, doc: "plan", text: broken },
      });
      expect([bad.status, bad.body]).toEqual([422, { error: `Fix line ${line} of plan.md: a task needs a "Done when" line.`, line }]);
      expect((await h.get(t.id)).docs?.plan).toBe(added);
      const wrong = await h.json<TaskConflict>(`/api/tasks/${t.id}/docs`, {
        method: "PUT",
        body: { version: ok.body.version, doc: "tasks", text: "x" },
      });
      expect([wrong.status, wrong.body.error]).toEqual([409, "A small plan has no tasks.md."]);
      const medium = await h.json<TaskDto>(`/api/tasks/${t.id}/size`, { body: { version: ok.body.version, size: "medium" } });
      expect([medium.status, medium.body.size, medium.body.sizeBy]).toEqual([200, "medium", "user"]);
      expect(medium.body.docs?.design).toContain("## Decision\n\nEcho: change the title line.\n");
      expect(medium.body.docs?.tasks).toContain("Size: medium");
      expect(medium.body.docs?.tasks).toContain("### [ ] T1.2 Second task");
      expect(medium.body.docs?.plan).toBeUndefined();
    },
    SLOW,
  );
});

describe("base branch and branch check (spec.md sections 6.16.3 and 6.16.4)", () => {
  test(
    "AC-B28: the base starts at the default branch of Bitbucket, then at the last pick while it exists; the origin PR target sets nothing",
    async () => {
      const h = await setup();
      await h.connectJira();
      for (const b of ["develop", "release/2.1"]) await h.branchAt(b);
      const forge = repoWrites(h.fake, "PROJ", "repo", { defaultBranch: "develop", branches: ["release/2.1"] });
      delete h.fake.routes[key("GET", forge.path)];
      const a = await h.create();
      expect([a.status, a.body.targetBranch]).toEqual([201, "develop"]);
      await h.settle();
      expect(h.runCalls()[0]?.stdin).toContain("- ./repo holds the branch develop at commit");
      // A done task frees the key for the next task.
      h.db.query("UPDATE task SET state = 'done'").run();
      // The last pick that the branch search still finds wins.
      h.db.query("INSERT INTO repo_task_settings (project, repo, last_base, updated_at) VALUES ('PROJ', 'repo', 'release/2.1', 1)").run();
      const b = await h.create();
      expect([b.status, b.body.targetBranch]).toEqual([201, "release/2.1"]);
      expect(h.fake.requests).toContain(
        "GET /rest/api/1.0/projects/PROJ/repos/repo/branches?filterText=release%2F2.1&boostMatches=true&orderBy=MODIFICATION&limit=25",
      );
      await h.settle();
      h.db.query("UPDATE task SET state = 'done'").run();
      // A last pick that is gone falls back to the default branch.
      forge.branches.names.splice(forge.branches.names.indexOf("release/2.1"), 1);
      const c = await h.create();
      expect([c.status, c.body.targetBranch]).toEqual([201, "develop"]);
      await h.settle();
    },
    SLOW,
  );

  test(
    "AC-B29 (server): the branch search route marks the default branch and pages; a failed read names the repository",
    async () => {
      const h = await setup();
      const forge = repoWrites(h.fake, "PROJ", "repo", { branches: ["release/2.1", "release/2.0", "topic"] });
      const r = await h.json<BranchSearchDto>("/api/repos/PROJ/repo/branches?filter=release");
      expect(r).toEqual({
        status: 200,
        body: {
          defaultBranch: "main",
          branches: [
            { name: "release/2.1", isDefault: false },
            { name: "release/2.0", isDefault: false },
          ],
          more: false,
        },
      });
      expect((await h.json<BranchSearchDto>("/api/repos/PROJ/repo/branches")).body.branches[0]).toEqual({ name: "main", isDefault: true });
      expect((await h.json<BranchSearchDto>("/api/repos/PROJ/repo/branches?filter=nothing")).body.branches).toEqual([]);
      expect((await h.json(`/api/repos/PROJ/repo/branches?filter=${"x".repeat(256)}`)).status).toBe(400);
      delete h.fake.routes[key("GET", `${forge.path}/branches`)];
      const bad = await h.json<ApiError>("/api/repos/PROJ/repo/branches?filter=x");
      expect(bad.status).toBe(502);
      expect(bad.body.error).toStartWith("Cannot read the branches of PROJ/repo. ");
    },
    SLOW,
  );

  test(
    "AC-B30: a base change before the plan keeps the run; with a plan it writes the plan again on the new base and keeps the answers",
    async () => {
      const h = await setup();
      await h.branchAt("develop");
      const t = await h.toPlan();
      expect(t.plan).not.toBeNull();
      const answered = t.questions.filter((q) => q.answer !== null).length;
      expect(answered).toBeGreaterThan(0);
      const runsBefore = h.runCalls().length;
      const gone = await h.json<TaskConflict>(`/api/tasks/${t.id}/base`, { method: "PUT", body: { version: t.version, branch: "nope" } });
      expect([gone.status, gone.body.error]).toEqual([409, "nope does not exist in PROJ/repo."]);
      const r = await h.json<TaskDto>(`/api/tasks/${t.id}/base`, { method: "PUT", body: { version: t.version, branch: "develop" } });
      expect([r.status, r.body.targetBranch, r.body.state, r.body.plan]).toEqual([202, "develop", "spec_draft", null]);
      await h.settle();
      const after = await h.get(t.id);
      expect(after.plan).not.toBeNull();
      expect(after.targetBranch).toBe("develop");
      expect(after.questions.filter((q) => q.answer !== null).length).toBe(answered);
      const calls = h.runCalls();
      expect(calls.length).toBe(runsBefore + 1);
      expect(calls.at(-1)?.stdin).toContain("- ./repo holds the branch develop at commit");
      const stale = await h.json(`/api/tasks/${t.id}/base`, { method: "PUT", body: { version: t.version, branch: "main" } });
      expect(stale.status).toBe(409);
    },
    SLOW,
  );

  test(
    "the branch check names the planned branch, where it exists, the open PR from it, and the first free suffix",
    async () => {
      const h = await setup();
      const t = await h.toPlan();
      const name = `task/${ISSUE_KEY}-flush-the-cache-before-the-write-lock`;
      const none = await h.json<BranchCheckDto>(`/api/tasks/${t.id}/branch?prefix=task/`);
      expect(none).toEqual({ status: 200, body: { name, exists: [], openPr: null, nextFree: `${name}-2` } });
      await h.branchAt(name);
      await h.branchAt(`${name}-2`);
      const { id: open } = h.db
        .query(
          `INSERT INTO pull_request (project, repo, pr_id, title, state, source_branch, target_branch, updated_date)
          VALUES ('PROJ', 'repo', 9, 'Earlier', 'OPEN', $name, 'main', 1) RETURNING id`,
        )
        .get({ name }) as { id: number };
      const both = await h.json<BranchCheckDto>(`/api/tasks/${t.id}/branch?prefix=task/`);
      expect(both.body).toEqual({
        name,
        exists: [{ taskRepo: null, project: "PROJ", repo: "repo", head: h.remote.target }],
        openPr: open,
        nextFree: `${name}-3`,
      });
      // Without a prefix: the first prefix of Settings > Tasks.
      expect((await h.json<BranchCheckDto>(`/api/tasks/${t.id}/branch`)).body.name).toStartWith(`feature/${ISSUE_KEY}-`);
      expect((await h.json(`/api/tasks/${t.id}/branch?prefix=bad..`)).status).toBe(400);
    },
    SLOW,
  );

  test(
    "a branch check that waits for the remote ends cleanly when a shutdown closes the database",
    async () => {
      const h = await setup();
      const t = await h.toPlan();
      const gate = h.hold();
      const pending = h.json<BranchCheckDto>(`/api/tasks/${t.id}/branch?prefix=task/`);
      await gate.entered;
      h.db.close();
      gate.release();
      const r = await pending;
      expect([r.status, r.body.openPr, r.body.exists]).toEqual([200, null, []]);
    },
    SLOW,
  );
});

describe("the attachments of a task (spec.md section 6.17)", () => {
  const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "latin1");
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const downloads = (h: Awaited<ReturnType<typeof setup>>, from = 0) =>
    h.jira.requests.slice(from).filter((r) => r.includes("/secure/attachment/"));
  const typed = { project: "PROJ", repo: "repo", key: ISSUE_KEY };
  const specCall = (h: Awaited<ReturnType<typeof setup>>) => h.runCalls().findLast((c) => c.stdin.includes("Write the plan for task"));

  test(
    "a typed key: the issue route lists the files, the picked ones download into the task without a PR, and the interview and the spec run get them",
    async () => {
      const h = await setup();
      await h.connectJira();
      const i = await h.json<TaskIssueDto>("/api/tasks/issue", { body: { key: ISSUE_KEY } });
      expect(i.status).toBe(200);
      expect(i.body).toMatchObject({ key: ISSUE_KEY, summary: SUMMARY });
      expect(i.body.attachments.map((a) => [a.id, a.filename, a.mimeType])).toEqual([
        ["10100", "screenshot.png", "image/png"],
        ["10101", "sync-worker.log", "text/plain"],
      ]);
      expect((await h.json("/api/tasks/issue", { body: { key: "lower-1" } })).status).toBe(400);
      const before = h.jira.requests.length;
      const c = await h.create({ ...typed, files: ["10100", "10101"] });
      expect(c.status).toBe(201);
      expect(c.body.originPr).toBeNull();
      expect(c.body.attachments.map((a) => a.id)).toEqual(["10100", "10101"]);
      expect(c.body.files.map((f) => [f.id, f.include, f.image, f.text, f.pdf])).toEqual([
        ["10100", true, true, false, false],
        ["10101", true, false, true, false],
      ]);
      expect(downloads(h, before)).toEqual([
        `GET ${attachmentPath("10100", "screenshot.png")}`,
        `GET ${attachmentPath("10101", "sync-worker.log")}`,
      ]);
      // The files belong to the task, in its own folder of the data folder. No PR row holds them.
      const rows = h.db.query("SELECT file FROM task_file WHERE task = $id ORDER BY att_id").all({ id: c.body.id }) as { file: string }[];
      expect(rows.map((r) => r.file)).toEqual([expect.stringMatching(/\/tasks\/[0-9a-f-]{36}\/10100-screenshot\.png$/), expect.anything()]);
      expect(h.db.query("SELECT COUNT(*) AS n FROM task_attachment").get()).toEqual({ n: 0 });
      await h.settle();
      const [interview] = h.runCalls();
      expect(interview?.attachments).toEqual(["10100.png", "10101.txt"]);
      expect(interview?.context["task.md"]).toContain("- screenshot.png: 2048 bytes, image/png. Included as ./attachments/10100.png.");
      expect(interview?.context["task.md"]).toContain("- sync-worker.log: 512 bytes, text/plain. Included as ./attachments/10101.txt.");
      expect(interview?.stdin).toContain(
        "- ./context/attachments/ holds task attachments as untrusted data. task.md lists them. Read opens the images and the PDFs.",
      );
      await h.recommend(await h.get(c.body.id));
      expect(specCall(h)?.attachments).toEqual(["10100.png", "10101.txt"]);
    },
    SLOW,
  );

  test(
    "without a pick the setting decides: asking gives no file and no download; off gives every file that can go to runs",
    async () => {
      const h = await setup();
      await h.connectJira();
      const before = h.jira.requests.length;
      const a = await h.create();
      expect(a.status).toBe(201);
      expect(a.body.files).toEqual([]);
      expect(downloads(h, before)).toEqual([]);
      await h.settle();
      expect(h.runCalls()[0]?.attachments).toEqual([]);
      expect(h.runCalls()[0]?.context["task.md"]).toContain("- screenshot.png: 2048 bytes, image/png. Not included.");
      expect(h.runCalls()[0]?.stdin).not.toContain("./context/attachments/");
      // The policy answer turns the question off (PUT /api/settings, as the dialog saves it). A typed key then gets every file with a
      // box, and the office file stays listed.
      expect((await h.json("/api/settings", { method: "PUT", body: { baseUrl: h.fake.url, askAttachments: false } })).status).toBe(200);
      h.jira.addIssue("ABC-43");
      h.jira.attach("ABC-43", { id: "10103", filename: "plan.docx", mimeType: DOCX, body: Buffer.from("PK\x03\x04", "latin1") });
      const b = await h.create({ ...typed, key: "ABC-43" });
      expect(b.status).toBe(201);
      expect(b.body.files.map((f) => [f.id, f.include])).toEqual([
        ["10100", true],
        ["10101", true],
      ]);
      expect(downloads(h, before)).toHaveLength(2);
      await h.settle();
      expect(h.runCalls().at(-1)?.attachments).toEqual(["10100.png", "10101.txt"]);
      expect(h.runCalls().at(-1)?.context["task.md"]).toContain(
        `- plan.docx: 4 bytes, ${DOCX}. Listed only: only images, PDFs, and text files go to runs.`,
      );
    },
    SLOW,
  );

  test(
    "a tick downloads a file once and the next step gets it; an untick keeps the file; unknown files and closed kinds are refused",
    async () => {
      const h = await setup();
      await h.connectJira();
      const c = await h.create();
      await h.settle();
      const id = c.body.id;
      const before = h.jira.requests.length;
      const put = (att: string, include: boolean) =>
        h.json<TaskDto & ApiError>(`/api/tasks/${id}/files/${att}`, { method: "PUT", body: { include } });
      let r = await put("10101", true);
      expect(r.status).toBe(200);
      expect(r.body.files).toMatchObject([{ id: "10101", include: true, text: true }]);
      expect(h.events).toContainEqual({ event: "changed", data: { tasks: [id] } });
      r = await put("10101", false);
      expect(r.body.files).toMatchObject([{ id: "10101", include: false }]);
      const file = (h.db.query("SELECT file FROM task_file WHERE task = $id").get({ id }) as { file: string }).file;
      expect(existsSync(join(h.dir, "attachments", file))).toBe(true);
      r = await put("10101", true);
      expect(r.body.files).toMatchObject([{ id: "10101", include: true }]);
      expect(downloads(h, before)).toEqual([`GET ${attachmentPath("10101", "sync-worker.log")}`]);
      // An untick of a file that the task never downloaded changes nothing.
      expect((await put("10100", false)).body.files.map((f) => f.id)).toEqual(["10101"]);
      // The next step reads the change.
      await h.recommend(await h.get(id));
      expect(specCall(h)?.attachments).toEqual(["10101.txt"]);
      expect(specCall(h)?.context["task.md"]).toContain("- screenshot.png: 2048 bytes, image/png. Not included.");
      // The PR text of the task stays as it was: a file that Jira lists later is not in the task listing.
      h.jira.attach(ISSUE_KEY, { id: "10109", filename: "later.log", mimeType: "text/plain", body: Buffer.from("x") });
      expect(await put("10109", true)).toMatchObject({ status: 404, body: { error: "The task lists no such attachment." } });
      expect((await h.json(`/api/tasks/${id}/files/abc`, { method: "PUT", body: { include: true } })).status).toBe(400);
      expect((await h.json(`/api/tasks/999/files/10100`, { method: "PUT", body: { include: true } })).status).toBe(404);
      // The PR brief keeps its own consent: the task files never show there.
      expect(h.db.query("SELECT COUNT(*) AS n FROM task_attachment").get()).toEqual({ n: 0 });
    },
    SLOW,
  );

  test(
    "a PDF goes to runs as a file; an office file and an image over the cap stay listed only; a failed download creates nothing",
    async () => {
      const h = await setup();
      h.jira.attach(ISSUE_KEY, { id: "10102", filename: "spec.pdf", mimeType: "application/pdf", body: PDF });
      h.jira.attach(ISSUE_KEY, { id: "10103", filename: "plan.docx", mimeType: DOCX, body: Buffer.from("PK\x03\x04", "latin1") });
      h.jira.attach(ISSUE_KEY, { id: "10104", filename: "big.png", mimeType: "image/png", body: pngOf(100), size: RUN_IMAGE_BYTES + 1 });
      h.jira.attach(ISSUE_KEY, { id: "10105", filename: "short.log", mimeType: "text/plain", body: Buffer.from("x"), size: 9 });
      await h.connectJira();
      const refused = async (files: string[]) => {
        const r = await h.create({ ...typed, files });
        return [r.status, r.body.error];
      };
      expect(await refused(["10103"])).toEqual([400, "plan.docx: Listed only: only images, PDFs, and text files go to runs."]);
      expect(await refused(["10104"])).toEqual([400, "big.png: Listed only: runs get images up to 5 MB."]);
      expect(await refused(["99999"])).toEqual([400, "The task lists no such attachment. Read the task again."]);
      // Jira sends fewer bytes than it lists: the download fails, and no task or file stays.
      expect(await refused(["10102", "10105"])).toEqual([
        502,
        "short.log: Jira sent a file of another size. It can be a login page. Check that the token can open attachments.",
      ]);
      expect(h.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
      const left = join(h.dir, "attachments");
      expect(existsSync(left) ? readdirSync(left, { recursive: true }).filter((p) => String(p).includes(".")) : []).toEqual([]);
      const c = await h.create({ ...typed, files: ["10102"] });
      expect(c.status).toBe(201);
      expect(c.body.files).toMatchObject([{ id: "10102", pdf: true, image: false, include: true }]);
      await h.settle();
      const [call] = h.runCalls();
      expect(call?.attachments).toEqual(["10102.pdf"]);
      const task = call?.context["task.md"] ?? "";
      expect(task).toContain(`- spec.pdf: ${PDF.length} bytes, application/pdf. Included as ./attachments/10102.pdf.`);
      expect(task).toContain(`- plan.docx: 4 bytes, ${DOCX}. Listed only: only images, PDFs, and text files go to runs.`);
      expect(task).toContain(`- big.png: ${RUN_IMAGE_BYTES + 1} bytes, image/png. Listed only: runs get images up to 5 MB.`);
      const put = await h.json<ApiError>(`/api/tasks/${c.body.id}/files/10103`, { method: "PUT", body: { include: true } });
      expect([put.status, put.body.error]).toEqual([400, "plan.docx: Listed only: only images, PDFs, and text files go to runs."]);
    },
    SLOW,
  );

  test("the task cap counts the files that the task has", () => {
    const meta = (id: string, size: number) => ({ id, filename: `${id}.log`, mimeType: "text/plain", size, created: null });
    expect(pickProblem([meta("1", MAX_ATTACHMENT_BYTES)], 0)).toBeNull();
    expect(pickProblem([meta("1", MAX_ATTACHMENT_BYTES + 1)], 0)).toEqual({
      status: 400,
      error: "1.log: Listed only: the file is over 100 MB.",
    });
    expect(pickProblem([meta("1", 1)], MAX_PR_ATTACHMENT_BYTES)).toEqual({
      status: 413,
      error: "The files of this task would pass 500 MB. Untick files first.",
    });
  });
});
