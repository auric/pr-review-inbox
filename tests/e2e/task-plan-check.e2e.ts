// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.22.9 (WP-PQ5, AC-B102 UI part, AC-B103): the plan check and its repair on the plan screen, the
// Plan tab blocks "Contracts and risks", "Plan check", and "App checks", the Log labels, a problem under its sub-task label, and the
// switch of Settings > Tasks. Runs against serve.ts only: the fake Bitbucket, the fake Jira, the fake CLI, and a local git remote.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, buildTask, control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_URL, makeClone, openApp, pickRepo } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const REPO = "PROJ1/sample-repo-2";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const NO_QUESTIONS = { done: true, summary: "The task is clear.", questions: [], unknowns: [], coverage: NO_COVERAGE };
const task = (key: string, title: string, file: string) => ({
  id: "T1",
  title,
  files: [file],
  run: [`tests/${key}.test.ts`],
  done: "The test passes.",
  proof: { command: "test", test: "" },
});
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
      tasks: [task("readme", "Change the README title", "README.md")],
    },
  ],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
  flag: null,
  questions: [],
  contracts: [
    {
      name: "README title",
      path: "README.md",
      change: "change",
      users: "The readers of the README.",
      compat: "The title keeps its first word.",
      part: 1,
    },
  ],
  risks: [{ text: "The title test can miss a typo.", check: "tests/readme.test.ts", part: 1 }],
  coverage: NO_COVERAGE,
};
const P1 = {
  id: "p1",
  severity: "major",
  part: 1,
  path: "README.md",
  line: 1,
  text: "The plan names the wrong title line.",
  fix: "Name line 1 of README.md.",
};

const test = base.extend<{ seen: { urls: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      await control("reset");
      await use(seen);
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
    },
    { auto: true },
  ],
});

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

// A control route of serve.ts with its answer.
async function ask<T>(action: string, body: unknown): Promise<T> {
  const res = await fetch(`${FAKE_URL}/__control/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${action}: ${res.status}`);
  return (await res.json().catch(() => null)) as T;
}

// The token, the Jira site, and the clone.
async function prepare(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  const prs = (await api(page, "GET", "/api/prs")).json as { id: number; prId: number }[];
  const prA = prs.find((p) => p.prId === 1001)?.id as number;
  expect((await api(page, "PUT", `/api/prs/${prA}/clone`, { path: await makeClone(1001) })).status).toBe(200);
  await control("plan-check", { on: true });
  await page.reload();
}

test("a major problem of the check starts one repair; the plan screen and the Plan tab show the result; the approval works", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await control("claude", {
    stream: "task",
    interview: NO_QUESTIONS,
    spec: SPEC,
    planCheck: { summary: "One map line is wrong.", problems: [P1], coverage: NO_COVERAGE },
    seq: {
      spec: [{ spec: SPEC }, { spec: { ...SPEC, repairs: [{ id: "p1", fixed: true, note: "Named line 1 of README.md." }] } }],
    },
  });
  await prepare(page);
  await buildTask(page, REPO);
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 90_000 });
  await expect(primary(page)).toHaveText("Approve the plan");
  await expect(page.locator("[data-plan-check]")).toHaveText(
    /^\S+ wrote the plan again to fix 1 problem of the check\. The Plan tab shows the result\.$/,
  );

  await page.getByRole("tab", { name: "Plan" }).click();
  await expect(page.getByRole("heading", { name: "Contracts and risks" })).toBeVisible();
  await expect(page.getByText("Users: The readers of the README. Compat: The title keeps its first word.")).toBeVisible();
  await expect(page.getByText("Risk: The title test can miss a typo.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Plan check" })).toBeVisible();
  const p1 = page.locator('[data-plan-problem="p1"]');
  await expect(p1).toContainText("Major: The plan names the wrong title line.");
  await expect(p1).toContainText("Fix: Name line 1 of README.md.");
  await expect(p1).toContainText(/\S+: fixed\. Named line 1 of README\.md\./);
  await expect(p1).toContainText("Part 1 · README.md:1");
  await expect(page.getByRole("heading", { name: "App checks" })).toBeVisible();

  await page.getByRole("tab", { name: "Log" }).click();
  await expect(page.getByText("Plan check", { exact: true })).toBeVisible();
  await expect(page.getByText("Plan again after the check", { exact: true })).toBeVisible();

  const box = page.getByRole("checkbox", { name: "I understand" });
  if (await box.count()) await box.check();
  const done = page.waitForResponse((r) => r.url().endsWith("/plan") && r.request().method() === "POST");
  await primary(page).click();
  expect((await done).status()).toBe(200);
});

test("a task with sub-tasks shows a problem of the check under its sub-task label and one check line", async ({ page }) => {
  test.setTimeout(300_000);
  const part = (n: number, key: string, title: string, file: string) => ({
    n,
    kind: "part",
    title,
    goal: `${title}.`,
    lines: 100 * n,
    acceptance: [{ id: "A1", text: `${file} names ${key}.` }],
    tests: [{ test: `tests/${key.toLowerCase()}.test.ts`, proves: ["A1"] }],
    tasks: [task(key.toLowerCase(), title, file)],
    keys: [key],
    start: "base",
    after: null,
    startReason: n === 1 ? "It needs no other sub-task." : "It changes other files than ABC-13.",
  });
  const spec = {
    ...SPEC,
    title: "Split the cache work",
    estimate: { parts: 2, lines: 300, files: 4, modules: ["docs"], db: false, api: false, unknowns: [] },
    parts: [part(1, "ABC-13", "Flush before the write lock", "FLUSH.md"), part(2, "ABC-14", "Measure the lock wait", "WAIT.md")],
    maxOpen: 2,
    maxOpenReason: "Two sub-tasks can run side by side.",
  };
  const minor = { ...P1, severity: "minor", part: 1, text: "The flush part names no caller." };
  await control("claude", {
    stream: "task",
    interview: NO_QUESTIONS,
    spec,
    planCheck: { summary: "One minor gap.", problems: [minor], coverage: NO_COVERAGE },
  });
  await prepare(page);
  await ask("subtasks", { openPr: false });
  await page.reload();
  await page.getByRole("button", { name: /^Tasks: / }).click();
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  const form = page.getByRole("form", { name: "Build a Jira task" });
  await form.getByLabel("Jira key").fill("ABC-10");
  await pickRepo(form, REPO);
  await form.getByRole("button", { name: "Read the task" }).click();
  await expect(form.getByRole("radio", { name: "Build the sub-tasks, one PR each" })).toBeChecked();
  await form.getByRole("button", { name: "Build this task" }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(primary(page)).toHaveText("Approve the plan", { timeout: 90_000 });
  await expect(page.locator("[data-plan-check]")).toHaveCount(1);
  await expect(page.locator("[data-plan-check]")).toHaveText("The plan check found 1 problem: 1 minor. The Plan tab lists them.");

  await page.getByRole("tab", { name: "Plan" }).click();
  const p1 = page.locator('[data-plan-problem="p1"]');
  await expect(p1).toContainText("Minor: The flush part names no caller.");
  await expect(p1).toContainText("ABC-13 · README.md:1");
});

test("Settings > Tasks has the plan check switch, on by default, and it saves at once", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await openApp(page, "/settings/tasks");
  const on = page.getByRole("switch", { name: /^Check each plan with a second \S+ run$/ });
  await expect(on).toBeChecked();
  await on.click();
  await expect(on).not.toBeChecked();
  await expect.poll(async () => ((await api(page, "GET", "/api/settings")).json as { taskPlanCheck: boolean }).taskPlanCheck).toBe(false);
});
