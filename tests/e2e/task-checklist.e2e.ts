// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/task-builder-v2.md sections 5.2, 11.1, and 11.4: the "Outside Claude" checklist in the browser. The approval writes one row
// per step outside the runner. Done, Waive, and Reopen change a row at once. A merged task with an open row says "Needs you: finish your
// checklist" until each row is done or waived. Runs against serve.ts only: the fake Bitbucket, the fake Jira, the fake CLI, and a local
// git remote. tests/tasks/external.test.ts covers the server.
import { test as base, expect, type Page } from "@playwright/test";
import {
  APP_PORT,
  buildTask,
  type ClaudeScenario,
  control,
  E2E_JIRA_TOKEN,
  E2E_TOKEN,
  FAKE_URL,
  JIRA_URL,
  makeClone,
  openApp,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const REPO = "PROJ1/sample-repo-2";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const VERIFY = "Check the README on the wiki page";
const COMMENT = "Tell the support team in ABC-42";
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
  external: [
    { id: "E1", kind: "manual_verify", title: VERIFY, after: 1, host: "", why: "The wiki is outside the repository." },
    { id: "E2", kind: "tracker_comment", title: COMMENT, after: null, host: "", why: "" },
  ],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "", allow: [] },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
};
const README_TEST = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("the README title says that the app works", () => expect(readFileSync("README.md", "utf8")).toContain("works"));
`;
const CLAUDE = {
  stream: "task",
  spec: SPEC,
  review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
  seq: {
    "implement:build": [
      {
        writes: [
          { path: "repo/tests/readme.test.ts", text: README_TEST },
          { path: "repo/README.md", text: "# Sample works\n" },
        ],
        ticks: { path: "*", ids: ["*"] },
      },
    ],
  },
} satisfies ClaudeScenario;

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      context.on("weberror", (e) => seen.logs.push(e.error().message));
      await control("reset");
      await use(seen);
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
const checklist = (page: Page) => page.locator("section[aria-labelledby='task-checklist']");
const item = (page: Page, title: string) => checklist(page).getByRole("listitem").filter({ hasText: title });
// The row of the task in the Tasks list. Its status line comes from rowStatus (src/shared/task-status.ts).
const taskRow = (page: Page) => page.locator("[data-row]", { hasText: "ABC-42" });

test("the Outside Claude checklist: Done, Waive, and Reopen; a merged task asks to finish the checklist until each row is closed", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await control("claude", CLAUDE);
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
  await page.reload();

  // 1. The approval writes one checklist row per outside step, each open.
  await buildTask(page, REPO);
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  // The local remote has a branch "feature", so a "feature/" branch cannot exist there (git refs are paths).
  const bugfix = page.getByRole("radio", { name: "bugfix/", exact: true });
  await page.locator("label", { has: bugfix }).click();
  await expect(bugfix).toBeChecked();
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();
  await expect(checklist(page).getByRole("heading")).toHaveText(/^Outside \S+$/, { timeout: 60_000 });
  await expect(checklist(page)).toContainText("2 open. The task ends when each step is done or waived.");
  await expect(item(page, VERIFY)).toContainText("After part 1");

  // 2. Done and Waive close a row at once. Reopen opens it again.
  await item(page, VERIFY)
    .getByRole("button", { name: `Mark "${VERIFY}" done` })
    .click();
  await expect(item(page, VERIFY)).toContainText("Done");
  await expect(checklist(page)).toContainText("1 open.");
  await item(page, COMMENT)
    .getByRole("button", { name: `Waive "${COMMENT}"` })
    .click();
  await expect(item(page, COMMENT)).toContainText("Waived");
  await expect(checklist(page)).toContainText("Each step is done or waived.");
  await item(page, VERIFY)
    .getByRole("button", { name: `Reopen "${VERIFY}"` })
    .click();
  await expect(item(page, VERIFY).getByRole("button", { name: `Mark "${VERIFY}" done` })).toBeVisible();
  await expect(checklist(page)).toContainText("1 open.");

  // 3. The change is ready. Open the PR, then a colleague merges it. The open row keeps the task on the user.
  await expect(status(page)).toHaveText(/^Your change is ready(: [^.]+)?\.$/, { timeout: 240_000 });
  await primary(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Push and open PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText("Waiting for the review of your PR. Nothing to do.");
  await control("task-pr-merge");
  await expect(status(page)).toHaveText("The PR merged. Finish your checklist: 1 step is open.", { timeout: 30_000 });
  await expect(taskRow(page)).toContainText("Needs you: finish your checklist");

  // 4. The last open row closes, so the task no longer needs the user.
  await item(page, VERIFY)
    .getByRole("button", { name: `Mark "${VERIFY}" done` })
    .click();
  await expect(taskRow(page)).not.toContainText("Needs you", { timeout: 30_000 });
  await expect(status(page)).not.toContainText("Finish your checklist");
  await expect(checklist(page)).toContainText("Each step is done or waived.");
});
