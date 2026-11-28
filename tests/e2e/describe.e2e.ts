// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Write description in the browser: on the user's own PR 1004, the run proposes a title and a description, the user edits them, and
// Update on Bitbucket sends one PUT with the PR version. A stale version shows a clear message and loads the current text.
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { control, E2E_TOKEN, FAKE_URL, openApp, writes } from "./control";

const OWN = "Release the write lock after each entry";
const OTHER = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;
const PUT = "PUT /rest/api/1.0/projects/PROJ1/repos/sample-repo-4/pull-requests/1004";

const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      context.on("weberror", (e) => errors.push(e.error().message));
      await control("reset");
      await control("claude", { stream: "tree" });
      await use(errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

const h1 = (page: Page) => page.locator("section[aria-label='Details'] h1");
const form = (page: Page) => page.getByRole("form", { name: "Proposed description" });
// The Description shows the first paragraph of a long text until Show more.
async function fullText(page: Page) {
  await page.getByRole("button", { name: "Show more" }).click();
  return page.locator("#desc");
}

async function connect(page: Page, title: string) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { author: true });
  await page.locator("[data-row]", { hasText: title }).first().click();
  await expect(h1(page)).toHaveText(title);
}

async function propose(page: Page) {
  await page.getByRole("button", { name: "Write description" }).click();
  await expect(form(page)).toBeVisible({ timeout: RUN_MS });
  await expect(form(page).getByLabel("Proposed title")).toHaveValue(/^Echo title \w{7}$/);
  await expect(form(page).getByLabel("Proposed description (Markdown)")).toHaveValue(/## How to test/);
}

test("Write description proposes a text; the edited text goes to Bitbucket only on Update on Bitbucket", async ({ page }) => {
  await connect(page, OWN);
  await propose(page);
  // The run and the proposal post nothing.
  expect(await writes()).toEqual([]);
  await form(page).getByLabel("Proposed title").fill("Release the lock for each entry");
  await form(page).getByLabel("Proposed description (Markdown)").fill("## What changed and why\n\nThe edited text.");
  await form(page).getByRole("button", { name: "Update on Bitbucket" }).click();
  await expect(form(page)).toBeHidden();
  await expect(await fullText(page)).toContainText("The edited text.");
  await expect(h1(page)).toHaveText("Release the lock for each entry");
  expect(await writes()).toEqual([PUT]);
});

test("Discard closes the proposal and posts nothing", async ({ page }) => {
  await connect(page, OWN);
  await propose(page);
  await form(page).getByRole("button", { name: "Discard" }).click();
  await expect(form(page)).toBeHidden();
  await expect(page.locator("#desc")).toContainText("Synthetic e2e data.");
  expect(await writes()).toEqual([]);
});

test("a stale PR version shows a clear message, loads the current text, and the next update works", async ({ page }) => {
  await connect(page, OWN);
  await propose(page);
  // Another person changes the PR in Bitbucket after the app read it.
  const res = await fetch(`${FAKE_URL}/rest/api/1.0/projects/PROJ1/repos/sample-repo-4/pull-requests/1004`, {
    headers: { Authorization: `Bearer ${E2E_TOKEN}` },
  });
  const pr = (await res.json()) as { version: number };
  const put = await fetch(`${FAKE_URL}/rest/api/1.0/projects/PROJ1/repos/sample-repo-4/pull-requests/1004`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version: pr.version, description: "Changed in Bitbucket." }),
  });
  expect(put.status).toBe(200);
  await form(page).getByRole("button", { name: "Update on Bitbucket" }).click();
  await expect(form(page).getByText(/Someone changed this pull request in Bitbucket after the app read it/)).toBeVisible();
  await expect(page.locator("#desc")).toContainText("Changed in Bitbucket.");
  // The form keeps the proposal, and the next click uses the version that the app loaded.
  await form(page).getByRole("button", { name: "Update on Bitbucket" }).click();
  await expect(form(page)).toBeHidden();
  await expect(await fullText(page)).toContainText("Echo: the change.");
});

test("a PR of another author shows no Write description", async ({ page }) => {
  await connect(page, OTHER);
  await expect(page.locator("#desc")).toBeVisible();
  await expect(page.getByRole("button", { name: "Write description" })).toHaveCount(0);
});
