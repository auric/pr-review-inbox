// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/submodule-prs.md WP-SM2: a review with the variant "submodules" on a PR whose head adds the gitlink lib. The run
// log footer shows the submodule context line. Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude
// Code CLI. tests/review/submodules.test.ts covers the reads and the fetches.
import { expect, type Page, test } from "@playwright/test";
import { control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const TITLE = "Batch cache writes in the sync worker";
// A run passes the git workspace, the fake CLI, and the validator.
const RUN_MS = 60_000;
const row = (page: Page) => page.locator("[data-row]", { hasText: TITLE }).first();
const runRow = (page: Page) => page.locator("#runline [data-run-kind='review']");
const runLog = (page: Page) => page.getByRole("dialog", { name: "Review run log" });

test.beforeEach(async () => {
  await control("reset");
});

test("a review with the variant submodules shows the submodule context line in the run log footer", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  // The UI offers no variants, so the test sets one on the first profile through the settings API.
  const status = await page.evaluate(async () => {
    const headers = {
      "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "",
      "Content-Type": "application/json",
    };
    const s = (await (await fetch("/api/settings", { headers })).json()) as { baseUrl: string; profiles: Record<string, unknown>[] };
    const profiles = s.profiles.map((p, i) => (i === 0 ? { ...p, variants: ["submodules"] } : p));
    return (await fetch("/api/settings", { method: "PUT", headers, body: JSON.stringify({ baseUrl: s.baseUrl, profiles }) })).status;
  });
  expect(status).toBe(200);
  await control("state", { submodule: true });
  await page.reload();
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);

  await control("claude", { stream: "tree" });
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await page.keyboard.press("3");
  await expect(runLog(page).locator("footer [data-run-related]")).toHaveText("Submodule context: lib: added, not compared");
  // An "added" part is no warning, so the run line shows no submodule text.
  await expect(runRow(page)).not.toContainText("Submodule context");
});
