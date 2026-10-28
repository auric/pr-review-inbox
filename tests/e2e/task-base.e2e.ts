// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.16.7: "Pick a base branch" after the build started. The plan picks the release base, and the
// release branch goes away on the local remote before the approval. The pre-flight blocks with "Pick a base branch". The picker under
// the status takes the default branch, and the build goes on there with nothing pushed. Runs against serve.ts only: the fake Bitbucket,
// the fake Jira, the fake CLI, and a local git remote.
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
  RELEASE,
  taskBase,
  taskRemote,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const PR_TITLE = "Batch cache writes in the sync worker";
const REPO = "PROJ1/sample-repo-2";
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
    "implement:tests": [{ writes: [{ path: "repo/tests/readme.test.ts", text: README_TEST }] }],
    "implement:implement": [{ writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
    "implement:fix": [{ writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
  },
} satisfies ClaudeScenario;

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

test("a base that is gone at the build start offers Pick a base branch, and the build goes on from the picked base", async ({ page }) => {
  test.setTimeout(400_000);
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

  // 1. The plan on the release base.
  await page.locator("[data-row]", { hasText: PR_TITLE }).first().click();
  await page.getByRole("button", { name: `Build this task: ${JIRA_ISSUE}` }).click();
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  const pick = page.getByRole("combobox", { name: "Base branch" });
  await pick.click();
  await pick.fill("release");
  await page.getByRole("listbox", { name: "Branches" }).getByRole("option", { name: RELEASE }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Write the plan again" }).click();
  await expect(page.getByText(`${REPO} into ${RELEASE}`)).toBeVisible();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });

  // 2. The release branch goes away, then the approval starts the build. The pre-flight blocks before any Claude step.
  await taskBase({ remove: RELEASE });
  const before = await taskRemote();
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();
  await expect(status(page)).toHaveText(`Needs you: ${RELEASE} no longer exists in ${REPO}. Pick another base branch.`, {
    timeout: 60_000,
  });
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Pick a base branch");

  // 3. The primary moves the focus to the picker under the status. The default branch takes the build.
  await primary(page).click();
  const picker = page.getByRole("combobox", { name: `Base branch of ${REPO}` });
  await expect(picker).toBeFocused();
  await picker.click();
  await page.getByRole("listbox", { name: "Branches" }).getByRole("option").filter({ hasText: "(default)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(/^Build on \S+\?$/);
  await dialog.getByRole("button", { name: /^Use \S+$/ }).click();
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 180_000 });
  await expect(page.getByText(`${REPO} into ${RELEASE}`)).toHaveCount(0);
  await expect(primary(page)).toHaveText("Open the PR");
  // The picked base moved nothing on the server.
  expect(await taskRemote()).toEqual(before);
});
