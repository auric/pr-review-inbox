// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.20.1, 6.20.5, 6.20.9, and 6.20.13 (WP-ST6, AC-B72, AC-B88, AC-UX1, AC-UX2): a Jira task with
// sub-tasks in the browser. The parent ABC-10 has ABC-11 done, ABC-12 with an open PR, and ABC-13 and ABC-14 to build. The Build form
// preselects the sub-task mode and lists the files of each open sub-task. The plan screen tracks the PR of ABC-12 and skips ABC-11.
// One start select changes, the approval builds ABC-13, and its PR opens. ABC-14 waits for that merge. The sub-task list gives one
// sentence and one actor per row. "Move in Jira" moves the fake status only after its confirm. Runs against serve.ts only.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_URL, makeClone, openApp, pickRepo, taskRemote } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
// fixtures/bitbucket/dashboard-reviewer-page.json: the target branch of PR 1001, the default branch of the task repository.
const TARGET = "topic/sample-4";
// docs/plans/review-v2/spec.md section 7.1, AC-UX2: the words that no task screen shows.
const UX2 = /(?<!\.)\b(slices?|stacks?|stacked|gates?|verdicts?|candidates?|phases?|modules?|idem)\b/i;

const part = (n: number, key: string, title: string, file: string) => ({
  n,
  kind: "part",
  title,
  goal: `${title}.`,
  lines: 100 * n,
  acceptance: [{ id: "A1", text: `${file} names ${key}.` }],
  tests: [{ test: `tests/${key.toLowerCase()}.test.ts`, proves: ["A1"] }],
  tasks: [{ id: "T1", title, files: [file], run: [`tests/${key.toLowerCase()}.test.ts`], done: "The test passes." }],
  keys: [key],
  start: "base",
  after: null,
  startReason: n === 1 ? "It needs no other sub-task." : "It changes other files than ABC-13.",
});
const SPEC = {
  title: "Split the cache work",
  size: "small",
  estimate: { parts: 2, lines: 300, files: 4, modules: ["docs"], db: false, api: false, unknowns: [] },
  map: [{ path: "README.md", line: 1, symbol: "", kind: "change", what: "The title line." }],
  change: "Build each open sub-task as its own PR.",
  design: null,
  spec: null,
  parts: [part(1, "ABC-13", "Flush before the write lock", "FLUSH.md"), part(2, "ABC-14", "Measure the lock wait", "WAIT.md")],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
  flag: null,
  questions: [],
  maxOpen: 2,
  maxOpenReason: "Two sub-tasks can run side by side.",
  coverage: NO_COVERAGE,
};
const FLUSH_TEST = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("FLUSH.md names ABC-13", () => expect(readFileSync("FLUSH.md", "utf8")).toContain("ABC-13"));
`;

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      await control("reset");
      await use(seen);
      // Only the local app gets requests. Bitbucket and Jira get them from the server only.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN) || l.includes(E2E_JIRA_TOKEN))).toEqual([]);
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
const row = (page: Page, key: string) => page.locator(`[data-subtask="${key}"]`);
// A control route of serve.ts with its answer.
async function ask<T>(action: string, body: unknown): Promise<T> {
  const res = await fetch(`${FAKE_URL}/__control/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${action}: ${res.status}`);
  return (await res.json()) as T;
}
const jiraStatus = (set?: { key: string; category: "new" | "indeterminate" | "done" }) =>
  ask<{ statuses: Record<string, string | null>; transitions: Record<string, string[]> }>("jira-status", set ? { set } : {});
// The text of the Task view without its Details tabs. The tabs show the plan files, which the runner writes.
const screenText = async (page: Page) => (await page.locator('[data-task] > :not([aria-label="Details"])').allInnerTexts()).join("\n");

test("a task with sub-tasks: mode choice, plan with a tracked PR, one part built, its PR, the rows, and Move in Jira", async ({ page }) => {
  test.setTimeout(420_000);
  await control("claude", {
    stream: "task",
    interview: { done: true, summary: "Two sub-tasks need code. ABC-12 has a PR.", questions: [], unknowns: [], coverage: NO_COVERAGE },
    spec: SPEC,
    review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
    seq: {
      "implement:tests": [{ writes: [{ path: "repo/tests/abc-13.test.ts", text: FLUSH_TEST }] }],
      "implement:implement": [{ writes: [{ path: "repo/FLUSH.md", text: "# ABC-13 flushes first\n" }] }],
      "implement:fix": [{ writes: [{ path: "repo/FLUSH.md", text: "# ABC-13 flushes first\n" }] }],
    },
  });
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  const prs = (await api(page, "GET", "/api/prs")).json as { id: number; prId: number }[];
  const prA = prs.find((p) => p.prId === 1001)?.id as number;
  expect((await api(page, "PUT", `/api/prs/${prA}/clone`, { path: await makeClone(1001) })).status).toBe(200);
  const settings = await api(page, "PUT", "/api/repos/PROJ1/sample-repo-2/task-settings", {
    specDir: "specs/{key}/",
    lineBudget: 1000,
    maxOpen: 2,
    approvals: 1,
    commands: [],
    testGlobs: null,
    excludeGlobs: null,
    isolateHome: true,
  });
  expect(settings.status).toBe(200);
  const tracked = await ask<{ pr: number }>("subtasks", { openPr: true });
  expect(tracked.pr).toBeGreaterThan(0);
  await page.reload();

  // 1. The Build form (AC-B72): the parent has open sub-tasks, so "Build the sub-tasks, one PR each" starts selected. Each open
  // sub-task lists its files with a box.
  await page.getByRole("button", { name: /^Tasks: / }).click();
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  const form = page.getByRole("form", { name: "Build a Jira task" });
  await form.getByLabel("Jira key").fill("ABC-10");
  await pickRepo(form, "PROJ1/sample-repo-2");
  await form.getByRole("button", { name: "Read the task" }).click();
  await expect(form.getByText("ABC-10 has 4 sub-tasks: 2 open, 1 in progress, 1 done.")).toBeVisible();
  await expect(form.getByRole("radio", { name: "Build the sub-tasks, one PR each" })).toBeChecked();
  await expect(form.getByRole("radio", { name: "Build ABC-10 as one task" })).not.toBeChecked();
  for (const key of ["ABC-12", "ABC-13", "ABC-14"])
    await expect(form.getByRole("region", { name: `Files of ${key}` }).getByRole("checkbox", { name: /screenshot\.png/ })).toBeVisible();
  await expect(form.getByRole("region", { name: "Files of ABC-11" })).toHaveCount(0);
  await form.getByRole("button", { name: "Build this task" }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  const id = Number(new URL(page.url()).pathname.split("/").pop());

  // 2. The plan screen (spec.md section 6.20.5): one row per sub-task, the tracked PR, the skipped done sub-task, and the starts.
  await expect(status(page)).toHaveText("The plan is ready: 4 sub-tasks, 2 to build, about 300 changed lines.", { timeout: 90_000 });
  await expect(page.getByText("Sub-tasks: 4, one PR each")).toBeVisible();
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Approve the plan");
  await expect(page.locator('[data-plan-row="ABC-11"]')).toContainText("Done in Jira. The app skips it.");
  await expect(page.locator('[data-plan-row="ABC-12"]')).toContainText(
    `In review outside the app: PR #${tracked.pr} from feature/ABC-12-event-generator. The app tracks it.`,
  );
  await expect(page.locator('[data-plan-row="ABC-13"]')).toContainText("about 100 lines");
  await expect(page.getByText("proposes 2: Two sub-tasks can run side by side.")).toBeVisible();
  // ABC-14 starts after ABC-13 merges.
  await page.locator("#plan-start-2").selectOption({ label: "After another sub-task merges" });
  await expect(page.getByLabel("After the merge of")).toHaveValue("1");
  // The local remote has a branch "feature", so a "feature/" branch cannot exist there. The prefix of this task is "task/".
  await page.locator("label", { has: page.getByRole("radio", { name: "Other…", exact: true }) }).click();
  await page.getByLabel("Prefix", { exact: true }).fill("task/");
  await expect(page.locator('[data-plan-row="ABC-14"]')).toContainText("Branch: task/ABC-14-measure-the-lock-wait");
  await page.getByRole("checkbox", { name: "I understand" }).check();
  expect(UX2.exec(await screenText(page))).toBeNull();
  await primary(page).click();

  // 3. The build of ABC-13. ABC-14 waits for its merge. Nothing went out before the click.
  await expect(status(page)).toHaveText(/^ABC-13 \(\d of 3\) is ready and checked by \S+\.$/, { timeout: 180_000 });
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Open the PR");
  await expect(row(page, "ABC-11")).toContainText("Done in Jira.");
  await expect(row(page, "ABC-11")).toContainText("Who acts: No one");
  await expect(row(page, "ABC-12")).toContainText(`In review outside the app: PR #${tracked.pr}.`);
  await expect(row(page, "ABC-13")).toContainText("Ready. Open its PR.");
  await expect(row(page, "ABC-13")).toContainText("Who acts: You");
  await expect(row(page, "ABC-13")).toContainText("Jira: To Do");
  await expect(row(page, "ABC-14")).toContainText("Waits for ABC-13 to merge.");
  await expect(row(page, "ABC-10")).toContainText("Jira: In Progress");
  expect((await taskRemote()).creates).toEqual([]);
  expect(UX2.exec(await screenText(page))).toBeNull();

  // A click on a row shows that part above; its state has no primary button.
  await row(page, "ABC-14")
    .getByRole("button", { name: /^ABC-14/ })
    .click();
  await expect(status(page)).toHaveText(/^ABC-14 \(\d of 3\): Waits for ABC-13 to merge\.$/);
  await expect(primary(page)).toHaveCount(0);
  await row(page, "ABC-13")
    .getByRole("button", { name: /^ABC-13/ })
    .click();
  await expect(primary(page)).toHaveText("Open the PR");

  // 4. Open the PR of ABC-13: one confirm, one push, one PR create with the part key in the title.
  await primary(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(new RegExp(`^Push task/ABC-13-\\S+ and open a PR into ${TARGET}\\?$`));
  await expect(dialog.getByText("Title: ABC-13: Flush before the write lock")).toBeVisible();
  await dialog.getByRole("button", { name: "Push and open PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, "ABC-13")).toContainText("In review.", { timeout: 30_000 });
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Go to the PR");
  const after = await taskRemote();
  expect(after.creates).toHaveLength(1);
  expect(after.creates[0]).toMatchObject({ title: "ABC-13: Flush before the write lock" });
  expect(String((after.creates[0] as { description?: string }).description)).toContain("Parent: ABC-10");

  // 5. "Move in Jira" (spec.md section 6.20.9, AC-B86): the dialog lists the moves. Cancel sends nothing; the confirm sends one move.
  await expect(row(page, "ABC-13")).toContainText("Jira says To Do, but the PR is open.");
  const more = row(page, "ABC-13").getByRole("button", { name: "More for ABC-13" });
  await more.click();
  await page.getByRole("menuitem", { name: "Move in Jira…" }).click();
  const move = page.getByRole("dialog");
  await expect(move.getByRole("heading")).toHaveText("Move ABC-13 in Jira?");
  await expect(move.getByRole("radio", { name: "In Progress" })).toBeVisible();
  await move.getByRole("button", { name: "Cancel" }).click();
  await expect(move).toBeHidden();
  expect((await jiraStatus()).transitions).toEqual({});
  await more.click();
  await page.getByRole("menuitem", { name: "Move in Jira…" }).click();
  await move.getByRole("radio", { name: "In Progress" }).check();
  await move.getByRole("button", { name: "Move in Jira" }).click();
  await expect(move).toBeHidden();
  await expect(row(page, "ABC-13")).toContainText("Jira: In Progress");
  const moved = await jiraStatus();
  expect(moved.transitions).toEqual({ "ABC-13": ["21"] });
  expect(moved.statuses["ABC-13"]).toBe("In Progress");
  await expect(row(page, "ABC-13")).not.toContainText("but the PR is open");

  // "Read Jira again" reads only: a status that a colleague changed shows on the row.
  await jiraStatus({ key: "ABC-14", category: "indeterminate" });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Read Jira again" }).click();
  await expect(row(page, "ABC-14")).toContainText("Jira: In Progress");
  expect((await jiraStatus()).transitions).toEqual({ "ABC-13": ["21"] });
  const dto = (await api(page, "GET", `/api/tasks/${id}`)).json as { subtasks: { key: string }[] };
  expect(dto.subtasks.map((s) => s.key)).toEqual(["ABC-11", "ABC-12", "ABC-13", "ABC-14"]);
});
