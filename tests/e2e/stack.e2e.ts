// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/stacked-prs.md WP-SK3: a review with "Stacked PRs" on, on a PR with one child PR (its target is the source branch
// of the reviewed PR). The run log footer shows the stack line. Runs against serve.ts only: the fake Bitbucket, a temp git remote, and
// the fake Claude Code CLI. tests/review/stack.test.ts covers the detection.
import { expect, type Page, test } from "@playwright/test";
import { control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const TITLE = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;
const row = (page: Page) => page.locator("[data-row]", { hasText: TITLE }).first();
const runRow = (page: Page) => page.locator("#runline [data-run-kind='review']");
const runLog = (page: Page) => page.getByRole("dialog", { name: "Review run log" });

test.beforeEach(async () => {
  await control("reset");
});

test("a review with Stacked PRs on shows the stack line of the child PR in the run log footer", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await page.getByRole("button", { name: "Settings" }).click();
  const stack = page.getByLabel("Stacked PRs of profile 1", { exact: true });
  await expect(stack).not.toBeChecked();
  await stack.check();
  await expect(page.locator("#profiles-status")).toHaveText(/saved/i);
  await page.getByRole("button", { name: "Close the settings" }).click();
  await control("stack-child");
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);

  await control("claude", { stream: "tree" });
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await page.keyboard.press("3");
  await expect(runLog(page).locator("footer [data-run-related]")).toHaveText("Stack: no parent, 1 children");
});
