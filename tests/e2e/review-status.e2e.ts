// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Approve and Needs work in the PR header (BRIEF section 9 backlog). Runs against serve.ts only: the fake Bitbucket keeps the review
// status of the token user on PR 1001, and a reset restores it.
import { expect, type Page, test } from "@playwright/test";
import { control, E2E_TOKEN, FAKE_URL, openApp, type Scenario } from "./control";

// PR 1001 of PROJ1/sample-repo-2: the token user is a reviewer with no status.
const A = "Batch cache writes in the sync worker";
// PR 1004: the token user is the author (scenario author).
const D = "Release the write lock after each entry";

test.beforeEach(() => control("reset"));

const title = (page: Page) => page.locator("section[aria-label='Details'] h1");

async function connect(page: Page, pr: string, state: Partial<Scenario> = {}) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", state);
  await page.locator("[data-row]", { hasText: pr }).first().click();
  await expect(title(page)).toHaveText(pr);
}

test("approve, then needs work, then clear: each click sets the status on Bitbucket, and the header shows it after a reload", async ({
  page,
}) => {
  await connect(page, A);
  const review = page.getByRole("group", { name: "Your review" });
  const approve = review.getByRole("button", { name: "Approve", exact: true });
  const needs = review.getByRole("button", { name: "Needs work", exact: true });
  const shows = async (a: boolean, n: boolean) => {
    await expect(approve).toHaveAttribute("aria-pressed", String(a));
    await expect(needs).toHaveAttribute("aria-pressed", String(n));
  };
  const reload = async () => {
    await page.reload();
    await expect(title(page)).toHaveText(A);
  };
  await shows(false, false);

  await approve.click();
  await shows(true, false);
  await reload();
  await shows(true, false);

  await needs.click();
  await shows(false, true);
  await reload();
  await shows(false, true);

  // A second click on the pressed button clears the status. The keyboard reaches the button.
  await needs.focus();
  await page.keyboard.press("Enter");
  await shows(false, false);
  await reload();
  await shows(false, false);
});

test("the author of a pull request gets no review buttons", async ({ page }) => {
  await connect(page, D, { author: true });
  await expect(page.locator("[data-review]")).toHaveCount(0);
});
