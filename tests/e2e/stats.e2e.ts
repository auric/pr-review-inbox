// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review quality browser acceptance (docs/plans/review-v2/spec.md sections 4.1, 4.2; AC-M5): the discard reason chips and the
// Settings table. Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp, posts } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;

const test = base.extend<{ seen: string[] }>({
  seen: [
    async ({ context }, use) => {
      const urls: string[] = [];
      context.on("request", (r) => urls.push(r.url()));
      await control("reset");
      await use(urls);
      expect(urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
    },
    { auto: true },
  ],
});

const drafts = (page: Page) => page.locator("[data-draft]");

async function reviewed(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").fill("ABC-1: check the lock scope.");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(page.locator("#runline [data-run-kind='review']")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  // The README nit waits in the Low confidence fold (docs/plans/review-v2/spec.md section 1.4). The fold opens for the triage.
  await expect(drafts(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Low confidence (1)" }).click();
  await expect(drafts(page)).toHaveCount(3);
}

test("AC-M5: a reason chip after a discard stores the reason, and Review quality counts it", async ({ page }) => {
  await reviewed(page);
  await drafts(page).nth(0).getByRole("button", { name: "Accept" }).click();
  await expect(drafts(page).nth(1)).toBeFocused();
  await page.keyboard.press("a");
  await expect(drafts(page).nth(2)).toBeFocused();
  await page.keyboard.press("d");
  await expect(drafts(page).nth(2)).toHaveAccessibleName("Discarded draft. README.md:1.");

  // The discarded card offers the chips. No chip is required.
  const chips = drafts(page).nth(2).locator("[data-reason-chips]");
  await expect(chips.getByRole("button")).toHaveText(["Not a bug", "Not worth fixing", "Duplicate", "Intended", "Wrong place"]);
  await chips.getByRole("button", { name: "Not a bug" }).click();
  await expect(chips.getByRole("button", { name: "Not a bug" })).toHaveAttribute("aria-pressed", "true");
  await expect(chips.getByRole("button", { name: "Intended" })).toHaveAttribute("aria-pressed", "false");

  // The next triage action takes the chips away.
  await page.locator("[data-draft-question]").getByRole("button", { name: "Discard" }).click();
  await expect(chips).toHaveCount(0);

  await page.keyboard.press("p");
  const box = page.getByRole("dialog", { name: /^Post 2 inline comments to / });
  await box.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.locator("[data-post]", { hasText: "Posted." })).toHaveCount(2);
  expect(await posts()).toHaveLength(2);

  await openApp(page, "/settings/quality");
  const section = page.locator("[data-review-quality]");
  await expect(section).toContainText("Counts come from your own triage in this app.");
  const rows = section.locator("[data-stats-row]");
  await expect(rows).toHaveCount(1);
  const cells = rows.first().locator("td");
  // Runs, shown per run, check, accepted, discarded, posted.
  // The run volume is balanced. Its main list holds no nits (spec.md section 1.4), so the README.md nit is not shown.
  await expect(cells.nth(0)).toHaveText("1");
  await expect(cells.nth(1)).toHaveText("2.0");
  await expect(cells.nth(3)).toHaveText("2 of 2 (100%)");
  await expect(cells.nth(4)).toHaveText("1Not a bug 1");
  expect(await cells.nth(5).evaluate((e) => e.firstChild?.textContent)).toBe("2");
  await expect(cells.nth(5).locator("span")).toHaveText(["0 resolved or fixed (0%)", "0 outdated (0%)"]);
});
