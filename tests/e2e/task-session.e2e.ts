// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/ps5-plan.md sections 4.2 and 7 (AC-B369, AC-B370): Hold, On hold, and Continue of a part in the browser. The
// first build run hangs. More offers Hold in place of Pause. After Hold, the status says that the work is kept, and Continue has the
// focus. The confirm of "Start this part again" closes on Esc and on Cancel, and sends nothing. Enter on Continue runs the build to
// ready. The usage rows need a future reset time, which serve.ts cannot give yet (PS5-E), so tests/web/tasks-model.test.ts covers them.
// Runs against serve.ts only: the fake Bitbucket, the fake Jira, the fake CLI, and a local git remote.
import { test as base, expect, type Page } from "@playwright/test";
import {
  APP_PORT,
  type ClaudeScenario,
  control,
  E2E_JIRA_TOKEN,
  E2E_TOKEN,
  FAKE_URL,
  JIRA_ISSUE,
  JIRA_URL,
  makeClone,
  openApp,
  runArgv,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const PR_TITLE = "Batch cache writes in the sync worker";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
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
const CLAUDE = {
  stream: "task",
  spec: SPEC,
  review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
  seq: {
    // Run 1 hangs until Hold ends it. Run 2, after Continue, finishes the part.
    "implement:build": [
      { hang: true },
      {
        writes: [
          { path: "repo/tests/readme.test.ts", text: README_TEST },
          { path: "repo/README.md", text: "# Sample works\n" },
        ],
        ticks: { path: "*", ids: ["*"] },
      },
    ],
    "implement:fix": [{ writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
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
const menu = async (page: Page) => {
  await page.getByRole("button", { name: "More actions" }).click();
  return page.getByRole("menu");
};

test("Hold keeps the work of a building part, the confirm of Start again sends nothing, and Continue runs the build to ready", async ({
  page,
  seen,
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

  await page.locator("[data-row]", { hasText: PR_TITLE }).first().click();
  await page.getByRole("button", { name: `Build this task: ${JIRA_ISSUE}` }).click();
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();

  // 1. The build run hangs. A Hold before the CLI starts would leave the hang entry unused, so the test waits for the build run.
  await expect(status(page)).toHaveText(/^\S+ builds your change\.$/, { timeout: 180_000 });
  await expect.poll(async () => (await runArgv())?.stdin.includes("- Mode: build") ?? false, { timeout: 60_000 }).toBe(true);
  const building = await menu(page);
  await expect(building.getByRole("menuitem")).toHaveText(["Hold", "Stop"]);
  await building.getByRole("menuitem", { name: "Hold", exact: true }).click();

  // 2. AC-B369: the part is on hold, and Continue takes the focus.
  await expect(status(page)).toHaveText("Your change is on hold. Its work is kept.", { timeout: 60_000 });
  await expect(primary(page)).toHaveText("Continue");
  await expect(primary(page)).toBeFocused();

  // 3. AC-B370: the confirm of Start again closes on Esc and on Cancel, and sends nothing.
  const held = await menu(page);
  await expect(held.getByRole("menuitem")).toHaveText(["Start this part again", "Stop"]);
  await held.getByRole("menuitem", { name: "Start this part again" }).click();
  const confirm = page.getByRole("dialog", { name: "Start your change again?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("The app keeps the old work as a patch and as a backup branch in the app cache.");
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await (await menu(page)).getByRole("menuitem", { name: "Start this part again" }).click();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(seen.urls.filter((u) => u.includes("/restart"))).toEqual([]);
  await expect(status(page)).toHaveText("Your change is on hold. Its work is kept.");

  // 4. Enter on Continue resumes the part, and the build ends green.
  await primary(page).focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 180_000 });
});
