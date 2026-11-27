// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/thorough-review.md: "Thorough review" in Settings runs the review twice at once. The Run setup line names both
// runs and the hidden copies, the Drafts list keeps the survivor of each copy pair (D2), and a failed second run leaves its gap line.
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI, which answers arm 2 by its run folder
// "<id>-2". tests/review/twice.test.ts covers the runs and the merge.
import { expect, type Page, test } from "@playwright/test";
import { control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const TITLE = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;
const ARM2 = "-2$";
const row = (page: Page) => page.locator("[data-row]", { hasText: TITLE }).first();
const runRow = (page: Page) => page.locator("#runline [data-run-kind='review']");
const drafts = (page: Page) => page.locator("[data-draft]");

// The arm 1 result is REVIEW_RESULT of tests/support/review-fixture.ts. Arm 2 repeats its blocker on line 3 with a minor severity, and
// its README point with a major severity. D2 keeps the higher severity: the arm 1 blocker and the arm 2 README point.
const finding = (o: Record<string, unknown>) => ({
  path: "src/cache/flush.ts",
  side: "new",
  lineEnd: null,
  category: "Concurrency",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  evidence: "",
  ...o,
});
const ARM2_README = "ARM2: the README must name the lock order of a flush.";
const ARM2_RESULT = {
  summary: "Arm two.",
  risks: [],
  questions: [],
  coverage: { read: ["src/cache/flush.ts"], skipped: [], unavailable: [], notChecked: [] },
  findings: [
    finding({
      line: 3,
      anchorText: "const lock = cache.lock();",
      severity: "minor",
      body: "ARM2: the lock is taken per entry.",
      trigger: "Two writers flush at once.",
    }),
    finding({
      path: "README.md",
      line: 1,
      anchorText: "# Sample",
      severity: "major",
      category: "Documentation",
      body: ARM2_README,
      trigger: "A reader adds code that needs the whole batch.",
      cause: { path: "src/cache/flush.ts", side: "new", line: 3, lineEnd: null, anchorText: "const lock = cache.lock();" },
    }),
  ],
};

test.beforeEach(async () => {
  await control("reset");
});

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  // The switch saves at once. A reload shows it on.
  await page.getByRole("button", { name: "Settings" }).click();
  const twice = page.getByLabel("Thorough review of profile 1", { exact: true });
  await expect(twice).not.toBeChecked();
  await twice.check();
  await expect(page.locator("#profiles-status")).toHaveText(/saved/i);
  await page.reload();
  await expect(page.getByLabel("Thorough review of profile 1", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Close the settings" }).click();
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

async function review(page: Page) {
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await runRow(page)
    .getByRole("button", { name: /^Run setup/ })
    .click();
}

test("Thorough review: the run line names both runs and the hidden copies, and Drafts keeps one survivor per copy pair", async ({
  page,
}) => {
  await connect(page);
  await control("claude", { stream: "tree", byCwd: { [ARM2]: { review: ARM2_RESULT } } });
  await review(page);
  await expect(runRow(page).locator("[data-run-twice]")).toHaveText("Thorough review: 2 runs at once. 2 repeated findings hidden.");
  // Arm 1: the blocker and the minor point. Arm 2: the README point at major, which replaces the arm 1 nit.
  await expect(drafts(page)).toHaveCount(3);
  await expect(drafts(page).filter({ hasText: "The lock now covers one entry at a time." })).toHaveCount(1);
  await expect(drafts(page).filter({ hasText: "does not run when" })).toHaveCount(1);
  await expect(drafts(page).filter({ hasText: ARM2_README })).toHaveCount(1);
  await expect(drafts(page).filter({ hasText: "ARM2: the lock is taken per entry." })).toHaveCount(0);
  await expect(drafts(page).filter({ hasText: "The README does not name the flush order." })).toHaveCount(0);
});

test("Thorough review: a failed second run leaves its gap line, and the first run gives the drafts", async ({ page }) => {
  await connect(page);
  // A result that fails the schema.
  await control("claude", { stream: "tree", byCwd: { [ARM2]: { review: { findings: "bad" } } } });
  await review(page);
  await expect(runRow(page).locator("[data-run-twice]")).toHaveText("Thorough review: 2 runs at once. 0 repeated findings hidden.");
  await expect(runRow(page)).toContainText("Run 2 of 2 failed: schema. Its findings are missing.");
  await expect(drafts(page)).toHaveCount(2);
});
