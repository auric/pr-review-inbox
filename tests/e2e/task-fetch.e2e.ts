// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/jira-context.md section 4.8 (AC-JC17): the fetch state of the task chips. fetched, refresh failed, not fetched
// with a short reason and a hint with the full reason, skipped, Skip of a failed key, and Fetch ends a skip.
// Runs against serve.ts only: the fake Bitbucket, the fake Jira on JIRA_URL, and the fake Claude Code CLI.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_ISSUE, JIRA_URL, jiraIssue, openApp } from "./control";

const TITLE = "Batch cache writes in the sync worker";
// serve.ts: the PR 1001 description names it with Scenario.task. The fake Jira gives 404 for it.
const MISSING = "ABC-404";
const NOT_FOUND = "Jira has no such issue, or the token may not see it.";

const runChips = (page: Page) => page.locator("[data-task-chips='tk-runs']");
const briefChips = (page: Page) => page.locator("#brief [data-task-chips='tk']");
const status = (page: Page) => page.locator("p[role='status'].sr-only");
const tooltip = (page: Page) => page.locator("[data-slot='tooltip-content']");

test.beforeEach(() => control("reset"));

// Each chip and its row end inside the window, and the page has no horizontal overflow.
const fits = (l: Locator) =>
  l.evaluate((el) => {
    const right = document.documentElement.clientWidth;
    return {
      chips: [el, ...el.querySelectorAll("[data-task-chip]")].every((c) => c.getBoundingClientRect().right <= right + 0.5),
      page: document.documentElement.scrollWidth <= right,
    };
  });

async function open(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Jira URL").fill(JIRA_URL);
  await page.getByLabel("Personal access token").fill(E2E_JIRA_TOKEN);
  await page.getByRole("button", { name: "Save Jira settings" }).click();
  await expect(page.getByText("Saved. Jira accepted the token.")).toBeVisible();
  await page.getByRole("button", { name: "Close the settings" }).click();
}

test("the chips show fetched, refresh failed, not fetched with a reason, and skipped; Skip silences a failed key; Fetch ends the skip", async ({
  page,
}) => {
  await open(page);
  const runs = runChips(page);
  await expect(runs).toContainText(`${JIRA_ISSUE} · not fetched`);
  await expect(runs).toContainText(`${MISSING} · not fetched`);

  // A failed read: the short reason in the chip, the full reason in its hint and in its accessible name.
  await runs.getByRole("button", { name: `Fetch ${MISSING} from Jira` }).click();
  await expect(runs).toContainText(`${MISSING} · not fetched: no such issue`);
  const missing = runs.locator(`[data-task-chip='${MISSING}']`);
  await expect(missing).toContainText(NOT_FOUND);
  await missing.locator("code").hover();
  await expect(tooltip(page)).toHaveText(NOT_FOUND);

  // fetched, then a failed refresh keeps the text and says so.
  await runs.getByRole("button", { name: `Fetch ${JIRA_ISSUE} from Jira` }).click();
  await expect(runs).toContainText(`${JIRA_ISSUE} · fetched today`);
  await expect(runs).not.toContainText("refresh failed");
  await jiraIssue(JIRA_ISSUE, 500);
  await runs.getByRole("button", { name: `Fetch ${JIRA_ISSUE} again` }).click();
  await expect(runs).toContainText(/ABC-42 · fetched today [^,]+, refresh failed/);

  // Skip of a failed key. Fetch takes the focus, and no run reads the key.
  await runs.getByRole("button", { name: `Skip ${MISSING}` }).click();
  await expect(runs).toContainText(`${MISSING} · skipped`);
  await expect(status(page)).toHaveText(`Skipped ${MISSING}.`);
  await expect(runs.getByRole("button", { name: `Fetch ${MISSING} from Jira` })).toBeFocused();
  await expect(runs.getByRole("button", { name: `Skip ${MISSING}` })).toHaveCount(0);

  // The full chip in the brief shows the source, then the state for failed and skipped keys.
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
  const brief = briefChips(page);
  await expect(brief).toContainText(`${MISSING} · from description · skipped`);
  await expect(brief).toContainText(/ABC-42 · from description · fetched today [^,]+, refresh failed/);

  // A narrow pane wraps the long chips. Nothing scrolls sideways.
  await page.setViewportSize({ width: 400, height: 860 });
  await expect(brief).toBeVisible();
  expect(await fits(brief)).toEqual({ chips: true, page: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  // A Fetch ends the skip, whether it fails or succeeds.
  await brief.getByRole("button", { name: `Fetch ${MISSING} from Jira` }).click();
  await expect(brief).toContainText(`${MISSING} · from description · not fetched: no such issue`);
  await jiraIssue(JIRA_ISSUE);
  await brief.getByRole("button", { name: `Fetch ${JIRA_ISSUE} again` }).click();
  await expect(brief).not.toContainText("refresh failed");
});

test("Skip of a never-fetched key needs no confirm, and Fetch ends it", async ({ page }) => {
  await open(page);
  const runs = runChips(page);
  await runs.getByRole("button", { name: `Skip ${JIRA_ISSUE}` }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(runs).toContainText(`${JIRA_ISSUE} · skipped`);
  await runs.getByRole("button", { name: `Fetch ${JIRA_ISSUE} from Jira` }).click();
  await expect(runs).toContainText(`${JIRA_ISSUE} · fetched today`);
  await expect(runs.getByRole("button", { name: `Skip ${JIRA_ISSUE}` })).toHaveCount(0);
});
