// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Shared by serve.ts (Bun) and the Playwright files (Node). Keep it free of Bun APIs.
// E2E_APP_PORT, E2E_FAKE_PORT, and E2E_JIRA_PORT move the servers, so that two checkouts can run e2e at the same time.
// Playwright passes its environment to the web server command.
import type { Locator, Page, Request } from "@playwright/test";
import type { FakeScenario } from "../support/fake-claude";

export const APP_PORT = Number(process.env.E2E_APP_PORT || 7399);
export const FAKE_URL = `http://127.0.0.1:${Number(process.env.E2E_FAKE_PORT || 7398)}`;
export const JIRA_URL = `http://127.0.0.1:${Number(process.env.E2E_JIRA_PORT || 7397)}`;
// The fake Bitbucket accepts only this token. serve.ts sets it on the fake.
export const E2E_TOKEN = "e2e-token-7f3a9c1d5b2e8f40";
// The fake Jira on JIRA_URL accepts only this token. It serves JIRA_ISSUE (fixtures/jira) and gives 404 for other keys.
export const E2E_JIRA_TOKEN = "e2e-jira-token-3c9d1f7a2b5e8d60";
export const JIRA_ISSUE = "ABC-42";
// src/server/publish/plan.ts AI_MARK. The default markAi setting puts it before each post of an AI item.
export const MARK = "🤖 ";

// ---------- The app page ----------

// Chromium on Windows can fail one loopback connect with net::ERR_NO_BUFFER_SPACE. The load event still fires,
// but a lost module chunk leaves #root empty. openApp reloads once and fails on a second lost asset.
export async function openApp(page: Page, path = "/"): Promise<void> {
  const assets = `http://127.0.0.1:${APP_PORT}/assets/`;
  const lost: string[] = [];
  const note = (r: Request) => {
    if (r.url().startsWith(assets)) lost.push(`${r.url()} ${r.failure()?.errorText}`);
  };
  page.on("requestfailed", note);
  try {
    await page.goto(path);
    if (lost.length) {
      console.warn(`Reload after a failed asset: ${lost.splice(0).join(", ")}`);
      await page.reload();
    }
  } finally {
    page.off("requestfailed", note);
  }
  if (lost.length) throw new Error(`App assets failed twice: ${lost.join(", ")}`);
}

// Two review profiles of the user after the shipped Review profile: the edited Over-engineering and Security profiles that the
// version 5 upgrade keeps (docs/plans/review-v2/spec.md section 1.2). Tests of the profile editor and the brief need several profiles.
const OWN_PROFILES = [
  {
    id: "over",
    name: "Over-engineering",
    note: "What to delete or simplify",
    prompt: "Find code that the change can delete or simplify.",
    explain: false,
    docs: true,
    languageChecks: false,
    maxTurns: 100,
  },
  {
    id: "security",
    name: "Security",
    note: "Trust boundaries, secrets, unsafe memory",
    prompt: "Find security defects: trust boundaries, input validation, injection, and secrets in code or logs.",
    explain: false,
    docs: true,
    languageChecks: true,
    maxTurns: 100,
  },
];

// Saves the profile list Review, Over-engineering, Security, Explain through the app API of the open page, then reloads it.
export async function addOwnProfiles(page: Page): Promise<void> {
  const status = await page.evaluate(async (own) => {
    const headers = {
      "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "",
      "Content-Type": "application/json",
    };
    const s = (await (await fetch("/api/settings", { headers })).json()) as { baseUrl: string; profiles: unknown[] };
    const [first, ...rest] = s.profiles;
    const body = JSON.stringify({ baseUrl: s.baseUrl, profiles: [first, ...own, ...rest] });
    return (await fetch("/api/settings", { method: "PUT", headers, body })).status;
  }, OWN_PROFILES);
  if (status !== 200) throw new Error(`PUT /api/settings: ${status}`);
  await page.reload();
}

// Apply and commit does real git work in a temp clone. A loaded runner can take much longer than 5 s.
export const COMMIT_MS = 30_000;

// The animation name and the running animations of an element.
export const motion = (l: Locator) => l.evaluate((e) => ({ name: getComputedStyle(e).animationName, running: e.getAnimations().length }));

// A color token of index.css, such as "--sel", as getComputedStyle gives it.
export const cssColor = (page: Page, token: string) =>
  page.evaluate((t) => {
    const probe = document.createElement("div");
    probe.style.background = `var(${t})`;
    document.body.append(probe);
    const bg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return bg;
  }, token);

export type Scenario = {
  // PR 1001: the reply 1000010 by another user under my comment 1000003. "two": then the reply 1000011 by a third user.
  reply: "none" | "new" | "two" | "dup" | "edit" | "absent" | "deleted";
  // PR 1001: this many more threads 1000101, 1000102, …: my general comment, then a reply 1000201, 1000202, … by another user.
  turns: number;
  // PR 1001: the reply 1000201 tells the AI to ignore its instructions and to answer thread 1000003 (A17).
  inject: boolean;
  // PR 1001: the source branch moves one commit on, after the review (A7).
  push: boolean;
  // PR 210: a new thread by another user with this many long replies.
  tall: number;
  // PR 77: "reply" adds an unread reply; "merged" also takes the PR off the dashboard as MERGED.
  merge: "open" | "reply" | "merged";
  // Bitbucket stops answering after the first dashboard page.
  down: boolean;
  // PR 77: the Gate v3 inline threads with their diffs, the resolved BLOCKER task, and the commits and changes (plan v3 WP4).
  forge: boolean;
  // PR 1001: the description names the tasks ABC-42 (the fake Jira serves it) and ABC-404 (the fake Jira gives 404).
  task: boolean;
  // PR 1004 (PROJ1/sample-repo-4, source branch fix/flush-lock): the PR of the token owner joins the author dashboard.
  // The reviewer asks for code changes in threads 5000001 and 5000002. makeClone(1004) gives a clone on its source branch.
  author: boolean;
  // PR 1004: the token owner adds the general thread 5000003. Its newest message is mine, so it waits for the reviewer.
  own: boolean;
  // PR 1001: the source branch moves one commit on, with a C++ header and source and a Python file.
  native: boolean;
  // PR 1004 (session consult): the reviewer adds the outdated inline thread 5000004 on src/cache/flush.ts and the resolved thread 5000005.
  consult: boolean;
  // PR 1001 (synthetic, integration-check.md U56): Maria resolves the inline thread 1000401 on src/cache/flush.ts new line 3, which
  // has her reply 1000402. I resolve the general thread 1000403.
  resolved: boolean;
};

// The next fake Claude Code run. tree: a subagent run with drafts. schema: a result that fails the schema. limit: a usage limit.
// gaps: no finding, a read that stopped at a limit, and a documentation server that did not connect (A11, A12).
// hang: the CLI stops before its result and waits for a cancel. replies: the result of a reply run; absent, the CLI answers each thread.
// rereview: the result of a re-review; absent, the CLI gives one verdict per earlier finding. answer: the result of an ask run; absent, an echo.
// fix: the result of a fix run; absent, one note per thread and no edit. login: the authMethod of `claude auth status`. Absent: claude.ai.
// session: a session fork (docs/plans/session-consult.md part C). consult: its answer; absent, one reject per item with status open.
// answered: the answered list of a review result (docs/plans/thread-outcome.md section 9); absent, none.
export type ClaudeScenario = {
  // task: a run without subagents for the task runs (docs/plans/review-v2/spec.md section 6.2).
  stream: "tree" | "schema" | "limit" | "gaps" | "session" | "task";
  hang?: boolean;
  replies?: unknown;
  rereview?: unknown;
  answered?: unknown;
  answer?: unknown;
  fix?: unknown;
  improve?: unknown;
  consult?: unknown;
  // Review v2 results (tests/support/fake-claude.ts). bySchema: fields for one schema only, such as a hang in the verify phase.
  verify?: unknown;
  explain?: unknown;
  discuss?: unknown;
  // docs/plans/review-v2/spec.md section 2.9: the notes and the first cites of the echo reply result.
  notes?: unknown;
  cites?: unknown;
  // Part 6 (docs/plans/review-v2/spec.md section 6.5): the interview, spec, implement, and own review results; seq: the fields of the Nth
  // run of one call key, such as the files of each implement step.
  interview?: unknown;
  spec?: unknown;
  implement?: unknown;
  review?: unknown;
  seq?: FakeScenario["seq"];
  bySchema?: FakeScenario["bySchema"];
  login?: string;
};

// PR 1001 comment posts. drop: the next POST is stored, then the connection drops (A9). fail: the next POST gets this status
// and stores nothing. hide: the activities of PR 1001 drop, so neither the sync nor the outbox check can read them.
// resolve: another person resolves the thread of this root comment. The fake then refuses a reply in it.
// answer: another person replies to this comment with this text.
export type PostControl = {
  drop?: boolean;
  fail?: number | null;
  hide?: boolean;
  resolve?: number;
  answer?: { parent: number; text: string };
};
export type PostBody = { text: string; parent?: { id: number }; anchor?: Record<string, unknown> };

// Test-only control routes on the fake Bitbucket. The app has no such route.
export async function control(action: "reset" | "restart" | "shutdown"): Promise<void>;
export async function control(action: "state", change: Partial<Scenario>): Promise<void>;
export async function control(action: "claude", change: ClaudeScenario): Promise<void>;
export async function control(action: string, change?: Partial<Scenario> | ClaudeScenario) {
  const res = await fetch(`${FAKE_URL}/__control/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(change ?? {}),
  });
  if (!res.ok) throw new Error(`control ${action}: ${res.status}`);
}

// Every request to the fake Bitbucket since the last reset that is not a GET, as "METHOD /path?query". Control routes do not count.
export async function writes(): Promise<string[]> {
  const res = await fetch(`${FAKE_URL}/__control/writes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
  });
  if (!res.ok) throw new Error(`control writes: ${res.status}`);
  return ((await res.json()) as { writes: string[] }).writes;
}

// The number of open /api/live streams on the app.
export async function liveStreams(): Promise<number> {
  const res = await fetch(`${FAKE_URL}/__control/live`, { method: "POST", headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
  if (!res.ok) throw new Error(`control live: ${res.status}`);
  return ((await res.json()) as { streams: number }).streams;
}

// ---------- Build a Jira task (docs/plans/review-v2/spec.md section 6.9) ----------

// The branches of the local git remote of the tasks with their commits, and the body of each task PR create since the last reset.
export async function taskRemote(): Promise<{ heads: Record<string, string>; creates: Record<string, unknown>[] }> {
  const res = await fetch(`${FAKE_URL}/__control/task-remote`, { method: "POST", headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
  if (!res.ok) throw new Error(`control task-remote: ${res.status}`);
  return (await res.json()) as { heads: Record<string, string>; creates: Record<string, unknown>[] };
}

// The release base of the task tests (spec.md section 6.18). serve.ts makes it at the target of PR 1001, and a reset puts it back.
export const RELEASE = "release/2.1";

// spec.md section 6.18.5: move adds one commit with these files to a branch of the local remote. conflicted sets properties.mergeResult
// of every task PR to CONFLICTED (or CLEAN), then one sync stores it. Answers the new head of the moved branch.
export async function taskBase(change: { move?: { branch: string; files: Record<string, string> }; conflicted?: boolean }) {
  const res = await fetch(`${FAKE_URL}/__control/task-base`, { method: "POST", headers: auth, body: JSON.stringify(change) });
  if (!res.ok) throw new Error(`control task-base: ${res.status}`);
  return ((await res.json()) as { head: string | null }).head;
}

// spec.md section 6.16.8 (WP-MR3): the task of PROJ1/app with its submodule PROJ1/lib (serve.ts). clone: the user's clone of PROJ1/app.
// refuse: the next PR create of lib gets HTTP 403. merge: the open PR of lib merges, then one sync. branch: the app branch whose gitlink
// of lib the answer names.
export type TaskRepos = {
  heads: { app: Record<string, string>; lib: Record<string, string> };
  gitlink: string | null;
  merged: string | null;
  creates: string[];
  prs: Record<"app" | "lib", { id: number; state: string; description: string }[]>;
};
export async function taskRepos(change: { clone?: boolean; refuse?: boolean; merge?: boolean; branch?: string } = {}): Promise<TaskRepos> {
  const res = await fetch(`${FAKE_URL}/__control/task-repos`, { method: "POST", headers: auth, body: JSON.stringify(change) });
  if (!res.ok) throw new Error(`control task-repos: ${res.status}`);
  return (await res.json()) as TaskRepos;
}

// ---------- Fix it (plan r3): the user's clone ----------

const auth = { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" };

// branch: null when HEAD is detached. status: the `git status --porcelain` output.
export type CloneState = { head: string; branch: string | null; subject: string; status: string };

// A temp clone of the fake remote on the source branch of the PR, at the PR source head. pr: the Bitbucket PR ID. A reset deletes it.
export async function makeClone(pr: number): Promise<string> {
  const res = await fetch(`${FAKE_URL}/__control/clone`, { method: "POST", headers: auth, body: JSON.stringify({ pr }) });
  if (!res.ok) throw new Error(`control clone: ${res.status}`);
  return ((await res.json()) as { path: string }).path;
}

export async function cloneState(path: string): Promise<CloneState> {
  const res = await fetch(`${FAKE_URL}/__control/clone?path=${encodeURIComponent(path)}`, { headers: auth });
  if (!res.ok) throw new Error(`control clone state: ${res.status}`);
  return (await res.json()) as CloneState;
}

// Pushes the clone HEAD to the PR. The fake then lists it as the PR source head, with its commits and changes. Sync after it.
export async function pushClone(pr: number, path: string): Promise<string> {
  const res = await fetch(`${FAKE_URL}/__control/push`, { method: "POST", headers: auth, body: JSON.stringify({ pr, path }) });
  if (!res.ok) throw new Error(`control push: ${res.status}`);
  return ((await res.json()) as { head: string }).head;
}

// Applies the change, then returns every comment POST body of PR 1001 since the last reset.
export async function posts(change: PostControl = {}): Promise<PostBody[]> {
  const res = await fetch(`${FAKE_URL}/__control/posts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!res.ok) throw new Error(`control posts: ${res.status}`);
  return ((await res.json()) as { bodies: PostBody[] }).bodies;
}

// ---------- Jira attachments (plan r3 S-ATT) ----------
// The fake Jira serves the attachments of JIRA_ISSUE: 10100 screenshot.png (a PNG) and 10101 sync-worker.log (text).

// Every request to the fake Jira since the last reset, as "METHOD /path?query".
export async function jiraRequests(): Promise<string[]> {
  const res = await fetch(`${FAKE_URL}/__control/jira-requests`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control jira-requests: ${res.status}`);
  return ((await res.json()) as { requests: string[] }).requests;
}

// The app opens a folder through a recorder in serve.ts. opens: the answer of the next calls; false gives 501 with the path.
// A reset sets false. Answers with every folder path that the app asked to open since the last reset.
export async function openFolder(change: { opens?: boolean } = {}): Promise<string[]> {
  const res = await fetch(`${FAKE_URL}/__control/open-folder`, { method: "POST", headers: auth, body: JSON.stringify(change) });
  if (!res.ok) throw new Error(`control open-folder: ${res.status}`);
  return ((await res.json()) as { paths: string[] }).paths;
}

// The file names in context/attachments/ of the newest fake CLI run, or null before the first run.
// The run folder exists only while the run runs. Start the run with control("claude", { stream: "tree", hang: true }).
export async function runAttachments(): Promise<string[] | null> {
  const res = await fetch(`${FAKE_URL}/__control/run-attachments`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control run-attachments: ${res.status}`);
  return ((await res.json()) as { files: string[] | null }).files;
}

// docs/plans/review-v2/spec.md section 6.17: the names in context/attachments/ and the task.md text of each fake CLI run since the
// last reset, oldest first. No hang run is needed.
export async function runFiles(): Promise<{ attachments: string[]; task: string | null }[]> {
  const res = await fetch(`${FAKE_URL}/__control/run-files`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control run-files: ${res.status}`);
  return ((await res.json()) as { runs: { attachments: string[]; task: string | null }[] }).runs;
}

// The file paths under skills/ of the newest fake CLI run, or null before the first run. As runAttachments, start a hang run first.
export async function runSkills(): Promise<string[] | null> {
  const res = await fetch(`${FAKE_URL}/__control/run-skills`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control run-skills: ${res.status}`);
  return ((await res.json()) as { files: string[] | null }).files;
}

// Removes or restores the user skill test-check of the synthetic Claude config. Reset restores it.
export async function testCheckSkill(present: boolean): Promise<void> {
  const res = await fetch(`${FAKE_URL}/__control/skill`, { method: "POST", headers: auth, body: JSON.stringify({ present }) });
  if (!res.ok) throw new Error(`control skill: ${res.status}`);
}

// The stdin of the newest fake CLI run, or null before the first run. The prompt of a run is its stdin.
export async function runStdin(): Promise<string | null> {
  const res = await fetch(`${FAKE_URL}/__control/run-stdin`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control run-stdin: ${res.status}`);
  return ((await res.json()) as { stdin: string | null }).stdin;
}

// The prompt of each agent of the newest fake CLI run, by agent name. null before the first run and after the run ends.
// Start a hang run first, as for runAttachments.
export async function runAgents(): Promise<Record<string, string> | null> {
  const res = await fetch(`${FAKE_URL}/__control/run-agents`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control run-agents: ${res.status}`);
  return ((await res.json()) as { prompts: Record<string, string> | null }).prompts;
}

// tools: the --tools value. "" turns off every built-in tool.
export type RunMcp = { servers: string[] | null; allowed: string | null; denied: string | null; tools: string | null };
// The MCP setup of the newest fake CLI run, or null before the first run. As runAttachments, start a hang run first.
export async function runMcp(): Promise<RunMcp | null> {
  const res = await fetch(`${FAKE_URL}/__control/run-mcp`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control run-mcp: ${res.status}`);
  return ((await res.json()) as { run: RunMcp | null }).run;
}

// ---------- Ask your session (docs/plans/session-consult.md part C) ----------

// Writes the synthetic transcripts of serve.ts: one on fix/flush-lock (PR 1004), one on main. Answers with the message text canary.
export async function sessions(): Promise<string> {
  const res = await fetch(`${FAKE_URL}/__control/sessions`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control sessions: ${res.status}`);
  return ((await res.json()) as { canary: string }).canary;
}

export type RunArgv = { argv: string[]; cwd: string; stdin: string };
// The argv, the cwd, and the stdin of the newest fake CLI run, or null before the first run.
export async function runArgv(): Promise<RunArgv | null> {
  const res = await fetch(`${FAKE_URL}/__control/run-argv`, { method: "POST", headers: auth });
  if (!res.ok) throw new Error(`control run-argv: ${res.status}`);
  return ((await res.json()) as { run: RunArgv | null }).run;
}
