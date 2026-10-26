// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.12, 6.16, and 7.2 (WP-B5, WP-BR2): the small task walkthrough in the browser. Build on the
// task chip of a PR, the questions with the recommended answers, the plan approval with the "Branch type" chips, "Other…", the base
// picker with its confirm, and the first-use warning, the build with a stop at the line limit and "Keep one PR", "Open the PR" with its
// confirm, Close, and a second task of the same key that continues on the existing branch. The Build form with its attachment boxes
// and the policy question, and the Attachments tab (spec.md section 6.17). Then Settings > Tasks. Runs against serve.ts
// only: the fake Bitbucket, the fake Jira, the fake CLI, and a local git remote. The approved test command is "bun test" in the task
// worktree.
import { test as base, expect, type Page } from "@playwright/test";
import {
  APP_PORT,
  control,
  E2E_JIRA_TOKEN,
  E2E_TOKEN,
  FAKE_URL,
  JIRA_ISSUE,
  JIRA_URL,
  jiraRequests,
  makeClone,
  openApp,
  runFiles,
  taskRemote,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const PR_TITLE = "Batch cache writes in the sync worker";
// fixtures/jira/issue.json: the summary of ABC-42 is the task title.
const TITLE = "Flush the cache before the write lock";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
// The line limit of the repository in this test. The plan estimate is under it, and the branch with its plan file is over it.
const LIMIT = 10;
// fixtures/bitbucket/dashboard-reviewer-page.json: the target branch of PR 1001. serve.ts gives the local remote this branch, and the
// fake Bitbucket names it the default branch of the repository.
const TARGET = "topic/sample-4";
// The base that the test picks: main of the local remote, at the same commit as TARGET (tests/support/review-fixture.ts).
const BASE = "main";

const SPEC = {
  title: "Name the app state in the README",
  size: "small",
  estimate: { parts: 1, lines: 5, files: 2, modules: ["docs"], db: false, api: false, unknowns: [] },
  map: [{ path: "README.md", line: 1, symbol: "", kind: "change", what: "The title line." }],
  change: "Add the word works to the title line of the README.",
  design: null,
  spec: null,
  parts: [
    {
      n: 1,
      kind: "part",
      title: "README title",
      goal: "The README title says that the app works.",
      lines: 5,
      acceptance: [{ id: "A1", text: "The README title contains works." }],
      tests: [{ test: "tests/readme.test.ts", proves: ["A1"] }],
      tasks: [
        {
          id: "T1",
          title: "Change the README title",
          files: ["README.md"],
          run: ["tests/readme.test.ts"],
          done: "The README test passes.",
        },
      ],
    },
  ],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
};
const README_TEST = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("the README title says that the app works", () => expect(readFileSync("README.md", "utf8")).toContain("works"));
`;
const README = "# Sample works\n";
const MINOR = {
  path: "README.md",
  side: "new",
  line: 1,
  lineEnd: null,
  anchorText: "# Sample works",
  severity: "minor",
  category: "Maintainability",
  body: "Say what works in the title.",
  evidence: "README.md:1 says only works.",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  trigger: "A reader of the README cannot tell what works.",
};

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      context.on("weberror", (e) => seen.logs.push(e.error().message));
      await control("reset");
      await use(seen);
      // Only the local app gets requests. Bitbucket and Jira get them from the server only.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN) || l.includes(E2E_JIRA_TOKEN))).toEqual([]);
    },
    { auto: true },
  ],
});

// A call to the app API with the session token of the page, as the page itself sends it.
async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers = {
        "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "",
        "Content-Type": "application/json",
      };
      const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const status = (page: Page) => page.locator("#task-status");
const primary = (page: Page) => page.locator("[data-primary]");
// A "Branch type" chip of the plan screen: a native radio with the prefix as its name.
const chip = (page: Page, name: string) => page.getByRole("radio", { name, exact: true });

test("a small task: chip, questions, plan with the branch and the warning, a stop at the line limit, Open the PR, Close, and Continue", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await control("claude", {
    stream: "task",
    spec: SPEC,
    review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [MINOR] },
    seq: {
      "implement:tests": [{ writes: [{ path: "repo/tests/readme.test.ts", text: README_TEST }] }],
      "implement:implement": [{ writes: [{ path: "repo/README.md", text: README }] }],
      "implement:fix": [{ writes: [{ path: "repo/README.md", text: README }] }],
    },
  });
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  // Setup that the user does once: Jira, the clone with the git identity of the commits, and a low line limit for this test.
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  const prs = (await api(page, "GET", "/api/prs")).json as { id: number; prId: number }[];
  const prA = prs.find((p) => p.prId === 1001)?.id as number;
  expect((await api(page, "PUT", `/api/prs/${prA}/clone`, { path: await makeClone(1001) })).status).toBe(200);
  // The local remote has a branch "feature", so a "feature/" branch cannot exist there (git refs are paths). Step 3 changes the
  // prefix of this task to "task/" on the plan screen.
  const limit = await api(page, "PUT", "/api/repos/PROJ1/sample-repo-2/task-settings", {
    specDir: "specs/{key}/",
    lineBudget: LIMIT,
    maxOpen: 2,
    approvals: 1,
    commands: [],
    testGlobs: null,
    excludeGlobs: null,
    isolateHome: true,
  });
  expect(limit.status).toBe(200);
  await page.reload();

  // 1. Build on the task chip of the PR: one click, then the Task view.
  await page.locator("[data-row]", { hasText: PR_TITLE }).first().click();
  await page.getByRole("button", { name: `Build this task: ${JIRA_ISSUE}` }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(page.getByRole("heading", { level: 2, name: TITLE })).toBeVisible();
  await expect(page.locator('[aria-current="step"]')).toHaveText("Questions");

  // 2. The questions as a form: the recommended option is preselected and marked. Send answers.
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/);
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Answer 2 questions");
  const form = page.getByRole("form", { name: "Questions" });
  await expect(form.getByRole("radio", { name: /Keep it/ })).toBeChecked();
  await expect(form.getByText("Recommended", { exact: true })).toBeVisible();
  await expect(form.getByText("Why it matters: Echo: it changes the tests.")).toBeVisible();
  await primary(page).click();
  await expect(form.getByRole("radio", { name: /Keep it/ })).toBeFocused();
  await form.getByRole("button", { name: "Send answers" }).click();

  // 3. The plan: the size, the commands, and the warning of the first build in this repository.
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  await expect(page.locator('[aria-current="step"]')).toHaveText("Plan");
  await expect(primary(page)).toHaveText("Approve the plan");
  await expect(page.getByRole("radio", { name: /^Small: one PR/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /bun test/ })).toBeChecked();
  await expect(page.getByText("Before the first build in this repository")).toBeVisible();
  // The "Branch type" chips start at the first prefix of Settings > Tasks (spec.md section 6.16.1). The arrow keys move over the chips,
  // and the planned name follows at once. "Other…" takes a free prefix with the same rule, and Enter in its field does not approve.
  const planned = page.locator("#task-branch");
  await expect(chip(page, "feature/")).toBeChecked();
  await expect(planned).toHaveText("feature/ABC-42-flush-the-cache-before-the-write-lock");
  await chip(page, "feature/").focus();
  await page.keyboard.press("ArrowRight");
  await expect(chip(page, "bugfix/")).toBeChecked();
  await expect(planned).toHaveText("bugfix/ABC-42-flush-the-cache-before-the-write-lock");
  await page.locator("label", { has: chip(page, "Other…") }).click();
  const prefix = page.getByLabel("Prefix", { exact: true });
  await prefix.fill("bad..");
  await expect(page.getByRole("alert").filter({ hasText: "Invalid branch prefix." })).toBeVisible();
  await expect(planned).toHaveCount(0);
  await prefix.fill("task/");
  await expect(planned).toHaveText("task/ABC-42-flush-the-cache-before-the-write-lock");
  await prefix.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "tick “I understand” first" })).toHaveCount(0);
  await expect(primary(page)).toHaveCount(1);
  // The name is free on the server, so no existing-branch choice shows.
  await expect(page.getByText("already exists on the server.")).toHaveCount(0);
  // The repository settings keep no prefix (spec.md section 6.16.1).
  expect((await api(page, "GET", "/api/repos/PROJ1/sample-repo-2/task-settings")).json).not.toHaveProperty("branchPrefix");

  // The base picker (spec.md section 6.16.3): the branch search of the fake Bitbucket with the default mark and the no-match sentence.
  // A pick asks one confirm, because the plan exists. Cancel keeps the base.
  const base = page.getByRole("combobox", { name: "Base branch" });
  await expect(base).toHaveValue(TARGET);
  await expect(page.getByText("(default)", { exact: true })).toBeVisible();
  await base.click();
  const options = page.getByRole("listbox", { name: "Branches" }).getByRole("option");
  await expect(options.filter({ hasText: TARGET })).toContainText("(default)");
  await base.fill("zzz");
  await expect(page.getByText("No branch matches “zzz”.")).toBeVisible();
  await base.fill("mai");
  await expect(options).toHaveText(["main"]);
  await base.press("Enter");
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByRole("heading")).toHaveText(`The plan was written on ${TARGET}. Write it again on ${BASE}?`);
  await expect(confirm.getByText("The plan starts again. Your answers stay.")).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(base).toBeFocused();
  await expect(base).toHaveValue(TARGET);
  // The pick with the mouse and "Write the plan again": the plan runs again on main (202). The answers and the branch type stay.
  await base.click();
  await base.fill(BASE);
  await options.filter({ hasText: /^main$/ }).click();
  await confirm.getByRole("button", { name: "Write the plan again" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByText(`PROJ1/sample-repo-2 into ${BASE}`)).toBeVisible();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  await expect(planned).toHaveText("task/ABC-42-flush-the-cache-before-the-write-lock");
  await expect(base).toHaveValue(BASE);
  const taskId = Number(new URL(page.url()).pathname.split("/").pop());
  const replanned = (await api(page, "GET", `/api/tasks/${taskId}`)).json as { questions: { answer: unknown }[] };
  expect(replanned.questions.length).toBe(2);
  expect(replanned.questions.every((q) => q.answer !== null)).toBe(true);
  await primary(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "tick “I understand” first" })).toBeVisible();
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();

  // 4. The build stops at the line limit. "Keep one PR" lets it go on.
  await expect(page.locator('[aria-current="step"]')).toHaveText("Build", { timeout: 60_000 });
  await expect(status(page)).toHaveText(new RegExp(`^Needs you: this PR would have \\d+ changed lines, over your ${LIMIT} limit\\.$`), {
    timeout: 120_000,
  });
  await expect(primary(page)).toHaveText("Keep one PR");
  await primary(page).click();

  // 5. The change is ready and checked. The small point of the own review is listed. Nothing went out before the click.
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 180_000 });
  await expect(primary(page)).toHaveText("Open the PR");
  await expect(primary(page)).toBeFocused();
  await expect(page.getByText("Say what works in the title.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fix the small points too" })).toBeVisible();
  const before = await taskRemote();
  expect(Object.keys(before.heads).filter((b) => b.startsWith("task/"))).toEqual([]);
  expect(before.creates).toEqual([]);

  // The Log tab holds the checks with their output, and the Diff tab the change.
  await page.getByRole("tab", { name: "Log" }).click();
  await expect(page.getByRole("tabpanel").getByText("bun test").first()).toBeVisible();
  // The red checks of the tests step are no failure.
  await expect(page.getByRole("tabpanel").getByText("Red as expected").first()).toBeVisible();
  await page.getByRole("tab", { name: "Diff" }).click();
  await expect(page.getByRole("tabpanel").getByText("README.md", { exact: true })).toBeVisible();

  // 6. Open the PR: one confirm, one push to the task branch, and one PR create.
  await primary(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(/^Push task\/ABC-42-\S+ and open a PR into main\?$/);
  await dialog.getByRole("button", { name: "Push and open PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText("Waiting for the review of your PR. Nothing to do.");
  await expect(primary(page)).toHaveText("Go to the PR");
  const after = await taskRemote();
  const branch = Object.keys(after.heads).find((b) => b.startsWith("task/ABC-42-")) as string;
  expect(branch).toBeTruthy();
  expect(after.heads[BASE]).toBe(before.heads[BASE]);
  expect(after.creates).toHaveLength(1);
  expect(after.creates[0]).toMatchObject({
    title: `${JIRA_ISSUE}: ${TITLE}`,
    fromRef: { id: `refs/heads/${branch}` },
    toRef: { id: `refs/heads/${BASE}` },
  });

  // 7. Close the task. The branch and the PR stay.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Close the task" }).click();
  await expect(status(page)).toHaveText("Closed. The branches and PRs stay as they are.");
  await expect(primary(page)).toHaveCount(0);
  expect((await taskRemote()).heads[branch]).toBe(after.heads[branch]);

  // The Tasks view lists the task with its status.
  await page.getByRole("button", { name: /^Tasks: / }).click();
  await expect(page.locator("[data-row]", { hasText: TITLE })).toContainText("Closed");

  // 8. A second task with the same key (spec.md section 6.16.4). Its base starts at the last pick of the repository. With "task/", the
  // branch of the first task exists on the server: "Continue on" starts selected, and the approval sends the choice.
  const second = await api(page, "POST", "/api/tasks", { project: "PROJ1", repo: "sample-repo-2", key: JIRA_ISSUE });
  expect(second.status).toBe(201);
  await openApp(page, `/tasks/${(second.json as { id: number }).id}`);
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  await expect(base).toHaveValue(BASE);
  await expect(chip(page, "feature/")).toBeChecked();
  await expect(page.getByText("already exists on the server.")).toHaveCount(0);
  await page.locator("label", { has: chip(page, "Other…") }).click();
  await prefix.fill("task/");
  await expect(page.getByText(`${branch} already exists on the server.`)).toBeVisible();
  const keep = page.getByRole("radio", { name: `Continue on ${branch}` });
  await expect(keep).toBeChecked();
  await expect(page.getByText("Build on top of its commits. The app never overwrites them.")).toBeVisible();
  await page.getByRole("radio", { name: `Start a new branch (${branch}-2)` }).check();
  await keep.check();
  const sent = page.waitForRequest((r) => r.method() === "POST" && /\/api\/tasks\/\d+\/plan$/.test(r.url()));
  await primary(page).click();
  expect((await sent).postDataJSON()).toMatchObject({ prefix: "task/", existing: "continue" });
  await expect(page.locator('[aria-current="step"]')).toHaveText("Build", { timeout: 60_000 });
});

// docs/plans/review-v2/spec.md section 6.17: fixtures/jira/issue.json lists a PNG and a log. The fake Jira serves both.
test("the Build form lists the attachments with boxes and asks the policy question once; each step gets the ticked files", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await control("claude", {
    stream: "task",
    spec: SPEC,
    review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
  });
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  await page.reload();

  // 1. The form: the key and the repository, then "Read the task" reads the summary and the attachments.
  await page.getByRole("button", { name: /^Tasks: / }).click();
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  const form = page.getByRole("form", { name: "Build a Jira task" });
  await form.getByLabel("Jira key").fill(JIRA_ISSUE);
  await form.getByLabel("Main repository").selectOption("PROJ1/sample-repo-2");
  await form.getByRole("button", { name: "Read the task" }).click();
  await expect(form.getByText(TITLE)).toBeVisible();
  const shot = form.getByRole("checkbox", { name: /screenshot\.png/ });
  const log = form.getByRole("checkbox", { name: /sync-worker\.log/ });
  // A new data folder asks before the first tick, so no box starts ticked.
  await expect(shot).not.toBeChecked();
  await expect(log).not.toBeChecked();
  await expect(form.getByRole("button", { name: "Include all" })).toBeVisible();

  // 2. The first tick asks the company AI policy question. The box ticks only after the answer, and the answer is kept.
  await shot.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText("Include screenshot.png?");
  const include = dialog.getByRole("button", { name: "Include", exact: true });
  await expect(include).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /My company AI policy allows/ }).check();
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/settings");
  await include.click();
  await expect(dialog).toBeHidden();
  expect((await saved).status()).toBe(200);
  await expect(shot).toBeChecked();
  await log.click();
  await expect(log).toBeChecked();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // 3. Build: the app downloads the ticked files into the task, and the interview gets both.
  await form.getByRole("button", { name: "Build this task" }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  const [interview] = await runFiles();
  expect(interview?.attachments).toEqual(["10100.png", "10101.txt"]);
  expect(interview?.task).toContain("- screenshot.png: 2048 bytes, image/png. Included as ./attachments/10100.png.");
  expect((await jiraRequests()).filter((r) => r.includes("/secure/attachment/"))).toEqual([
    "GET /secure/attachment/10100/screenshot.png",
    "GET /secure/attachment/10101/sync-worker.log",
  ]);

  // 4. The Attachments tab: an untick applies from the next step. The spec run after the answers gets the image only.
  await page.getByRole("tab", { name: "Attachments" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("checkbox", { name: /screenshot\.png/ })).toBeChecked();
  await panel.getByRole("checkbox", { name: /sync-worker\.log/ }).click();
  await expect(panel.getByRole("checkbox", { name: /sync-worker\.log/ })).not.toBeChecked();
  await expect(panel.getByText(/Downloaded\. \S+ does not get it\./)).toBeVisible();
  await expect(panel.getByText("A change applies from the next step.", { exact: false })).toBeVisible();
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  const spec = (await runFiles()).at(-1);
  expect(spec?.attachments).toEqual(["10100.png"]);
  expect(spec?.task).toContain("- sync-worker.log: 512 bytes, text/plain. Not included.");
  // The untick downloaded nothing again.
  expect((await jiraRequests()).filter((r) => r.includes("/secure/attachment/"))).toHaveLength(2);
});

test("Settings > Tasks keeps the branch prefixes in order and refuses a repeat", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await openApp(page, "/settings/tasks");
  await expect(page.getByRole("heading", { level: 2, name: "Tasks" })).toBeFocused();
  const rows = page.getByRole("list", { name: "Branch prefixes" }).getByRole("textbox");
  const values = () => rows.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  await expect.poll(values).toEqual(["feature/", "bugfix/", "hotfix/"]);
  await expect(page.getByText("The first prefix starts selected on the plan screen.", { exact: false })).toBeVisible();
  // Move down saves at once, and the focus stays on the moved row.
  await page.getByRole("button", { name: "Move prefix 1 down" }).click();
  await expect.poll(values).toEqual(["bugfix/", "feature/", "hotfix/"]);
  await expect(page.getByRole("button", { name: "Move prefix 2 down" })).toBeFocused();
  await expect(page.locator("#tasks-status")).toHaveText("Saved. New plans offer these prefixes.");
  const saved = async () => ((await api(page, "GET", "/api/settings")).json as { taskBranchPrefixes: string[] }).taskBranchPrefixes;
  expect(await saved()).toEqual(["bugfix/", "feature/", "hotfix/"]);
  // A repeat and an invalid prefix show their sentences and save nothing.
  // The buttons of a row name it too ("Move prefix 4 up"), so the field needs the exact name.
  const fourth = page.getByLabel("Prefix 4", { exact: true });
  await page.getByRole("button", { name: "Add a prefix" }).click();
  await expect(fourth).toBeFocused();
  await expect(page.getByText("Invalid branch prefix.")).toHaveCount(0);
  await fourth.fill("feature/");
  await fourth.blur();
  await expect(page.getByText("This prefix is already in the list.")).toBeVisible();
  await fourth.fill("bad..");
  await fourth.blur();
  await expect(page.getByText("Invalid branch prefix.")).toBeVisible();
  await expect(page.locator("#tasks-status")).toHaveText("A marked prefix is not saved. Fix it to save the list.");
  expect(await saved()).toEqual(["bugfix/", "feature/", "hotfix/"]);
  await fourth.fill("task/");
  await fourth.blur();
  await expect(page.locator("#tasks-status")).toHaveText("Saved. New plans offer these prefixes.");
  expect(await saved()).toEqual(["bugfix/", "feature/", "hotfix/", "task/"]);
});
