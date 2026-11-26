// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan pr-view-v4 P1: the URL holds the view, the PR, the thread, the file, and the settings section. Back and Forward walk them.
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
// PR 1001 of PROJ1/sample-repo-2. Its general thread is 1000003. The fake git remote gives one changed file.
const A = "Batch cache writes in the sync worker";
const A_PATH = "/needs/PROJ1/sample-repo-2/1001";
// PR 77 of PROJ1/sample-repo-3: the token owner is a reviewer, so it is in Reviewing and not in My PRs.
const C = "Drop the legacy export endpoint";
// PR 210: the tall scenario gives it a long thread.
const B = "Show build status on the release page";

const test = base.extend<{ seen: { urls: string[]; reads: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], reads: [] as string[] };
      context.on("request", (r) => {
        seen.urls.push(r.url());
        const path = new URL(r.url()).pathname;
        if (r.method() === "POST" && (path === "/api/read" || path.endsWith("/seen"))) seen.reads.push(path);
      });
      await control("reset");
      await use(seen);
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
    },
    { auto: true },
  ],
});

const row = (page: Page, title: string) => page.locator("[data-row]", { hasText: title }).first();
const h1 = (page: Page) => page.locator("section[aria-label='Details'] h1");
const pane = (page: Page) => page.locator("[data-scroll]");
const path = (page: Page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};
const depth = (page: Page) => page.evaluate(() => history.length);

// A low window, so the detail of PR 1001 scrolls.
async function connect(page: Page) {
  await page.setViewportSize({ width: 1280, height: 440 });
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await expect(row(page, A)).toBeVisible();
}

test("a click opens a PR and a file with their own entries; Back closes the file at the same scroll, then shows the PR before", async ({
  page,
}) => {
  await connect(page);
  // A view change pushes an entry. Its first row is the default selection.
  await page.getByRole("button", { name: /^Reviewing/ }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/reviewing/PROJ1/sample-repo-2/1001");
  await row(page, C).click();
  await expect(h1(page)).toHaveText(C);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/reviewing/PROJ1/sample-repo-3/77");

  await row(page, A).click();
  await expect(h1(page)).toHaveText(A);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/reviewing/PROJ1/sample-repo-2/1001");
  // j in the list replaces the entry: no new Back step.
  const before = await depth(page);
  await row(page, A).focus();
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await expect(h1(page)).toHaveText(A);
  expect(await depth(page)).toBe(before);

  // The file click pushes an entry with the file. Back closes it and restores the scroll position.
  const get = page.locator("#s-files").getByRole("button", { name: "Get the code", exact: true });
  await page.locator("#s-files-sum").click();
  await get.click();
  const file = page.locator("#df-0");
  await expect(file).toBeFocused();
  // The file header stays in view, so the click below scrolls nothing before it saves the position.
  const top = await pane(page).evaluate((el) => {
    document.getElementById("df-0")?.scrollIntoView({ block: "center" });
    return el.scrollTop;
  });
  expect(top).toBeGreaterThan(20);
  await page.waitForTimeout(300);
  await file.click();
  await expect(file).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/\?(.*&)?file=src\/cache\/flush\.ts/);
  await pane(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  await page.goBack();
  await expect(file).toHaveAttribute("aria-expanded", "false");
  await expect(h1(page)).toHaveText(A);
  expect(path(page)).not.toContain("file=");
  await expect.poll(() => pane(page).evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(top + 2);
  expect(await pane(page).evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(top - 2);

  await page.goBack();
  await expect(h1(page)).toHaveText(C);
  expect(new URL(page.url()).pathname).toBe("/reviewing/PROJ1/sample-repo-3/77");

  // Forward comes back to the PR and then to the open file.
  await page.goForward();
  await expect(h1(page)).toHaveText(A);
  await page.goForward();
  await expect(file).toHaveAttribute("aria-expanded", "true");
});

test("Settings sections and Edit <profile> push entries; Back walks the sections, then returns to the PR", async ({ page }) => {
  await connect(page);
  await row(page, A).click();
  await expect(h1(page)).toHaveText(A);
  const prUrl = path(page);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(`${APP}/settings`);
  const source = page.getByRole("link", { name: "Source code" });
  await expect(source).toHaveAttribute("href", "https://github.com/auric/pr-review-inbox");
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(source).toHaveAttribute("rel", "noopener noreferrer");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("link", { name: "Task IDs" }).click();
  await expect(page).toHaveURL(`${APP}/settings/task-ids`);
  await expect(page.getByRole("heading", { name: "Task IDs" })).toBeFocused();
  await nav.getByRole("link", { name: "Checks" }).click();
  await expect(page).toHaveURL(`${APP}/settings/checks`);

  await page.goBack();
  await expect(page).toHaveURL(`${APP}/settings/task-ids`);
  await expect(page.getByRole("heading", { name: "Task IDs" })).toBeFocused();
  await expect(nav.locator("[aria-current='true']")).toHaveText("Task IDs");
  await page.goBack();
  await expect(page).toHaveURL(`${APP}/settings`);
  await page.goBack();
  await expect(h1(page)).toHaveText(A);
  expect(path(page)).toBe(prUrl);

  // "Edit <profile>" in the brief opens the profile URL. Back returns to the PR.
  await page.keyboard.press("r");
  await page.locator("#brief").getByRole("link", { name: "Edit Review" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(`${APP}/settings/profiles/general`);
  await page.goBack();
  await expect(h1(page)).toHaveText(A);

  // Close replaces the settings entry, so Back goes to the entry before Settings.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(`${APP}/settings`);
  await page.keyboard.press("Escape");
  await expect(h1(page)).toHaveText(A);
  expect(path(page)).toBe(prUrl);
});

test("keys in the license dialog do not act behind it; Esc closes only the dialog", async ({ page }) => {
  await connect(page);
  await row(page, A).click();
  await expect(h1(page)).toHaveText(A);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(`${APP}/settings`);
  // Base UI moves the focus into the dialog one frame after it opens. A key in that frame must not act behind it.
  // The observer sends r when the dialog enters the DOM, while the focus is still on the License button.
  await page.evaluate(() => {
    new MutationObserver((_, o) => {
      if (!document.querySelector('[data-slot="dialog-content"]')) return;
      o.disconnect();
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "License", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "License" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator("#brief")).toHaveCount(0);
  await expect(page).toHaveURL(`${APP}/settings`);
  await page.keyboard.press("r");
  await page.waitForTimeout(300);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(`${APP}/settings`);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`${APP}/settings`);
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});

test("narrow: the detail has its own entry; Esc and Back to the list go back; a link in a new tab has a list to go back to", async ({
  page,
}) => {
  await connect(page);
  await page.setViewportSize({ width: 400, height: 860 });
  const list = page.locator(".rl-list");
  const detail = page.locator(".rl-detail");
  await expect(list).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/needs");

  await row(page, A).click();
  await expect(detail).toBeVisible();
  await expect(list).toBeHidden();
  await expect.poll(() => new URL(page.url()).pathname).toBe(A_PATH);
  await page.keyboard.press("Escape");
  await expect(list).toBeVisible();
  await expect(detail).toBeHidden();
  expect(new URL(page.url()).pathname).toBe("/needs");
  await expect(row(page, A)).toBeFocused();

  await row(page, A).click();
  await expect(detail).toBeVisible();
  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(list).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/needs");
  await page.goForward();
  await expect(detail).toBeVisible();
  await expect(h1(page)).toHaveText(A);

  // A deep link has no earlier entry of the app. Esc then shows the list and replaces the entry.
  await openApp(page, A_PATH);
  await expect(detail).toBeVisible();
  await expect(h1(page)).toHaveText(A);
  await page.keyboard.press("Escape");
  await expect(list).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/needs");
});

test("a reload or a deep link shows the same place; an unknown view and a gone PR fall back without a blank page", async ({
  page,
  seen,
}) => {
  await connect(page);
  await row(page, A).click();
  await expect(h1(page)).toHaveText(A);
  await page.locator("#th-1000003").click();
  await expect(page).toHaveURL(/thread=1000003/);
  const top = await pane(page).evaluate((el) => {
    el.scrollTop = Math.min(80, el.scrollHeight - el.clientHeight);
    return el.scrollTop;
  });
  expect(top).toBeGreaterThan(20);
  await page.waitForTimeout(300);
  await page.reload();
  await expect(h1(page)).toHaveText(A);
  await expect(page.locator("#th-1000003")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => pane(page).evaluate((el) => Math.round(el.scrollTop))).toBe(Math.round(top));

  // A deep link in a new tab: the thread opens and takes the focus.
  const tab = await page.context().newPage();
  await tab.goto(`${A_PATH}?thread=1000003`);
  await expect(h1(tab)).toHaveText(A);
  await expect(tab.locator("#t-1000003")).toBeFocused();
  await tab.close();

  // A PR outside the view stays shown, and the list keeps it.
  await openApp(page, "/mine/PROJ1/sample-repo-3/77");
  await expect(h1(page)).toHaveText(C);
  await expect(row(page, C)).toHaveAttribute("aria-current", "true");
  await expect(page.locator("[data-row]")).toHaveCount(1);
  // The re-sort keeps this row too, so no chip offers it.
  await expect(page.locator("[data-row]").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /updated · re-sort/ })).toHaveCount(0);

  // An unknown view gives Needs you.
  await openApp(page, "/inbox/x");
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/needs/);
  await expect(page.locator("[data-row]").first()).toBeVisible();

  // A gone PR: the detail says so, and no other PR opens or turns read.
  const reads = seen.reads.length;
  await openApp(page, "/needs/PROJ1/sample-repo-2/999");
  await expect(page.getByRole("heading", { name: "Cannot find this pull request" })).toBeVisible();
  await expect(page.locator("section[aria-label='Details']")).toContainText("PROJ1/sample-repo-2 #999");
  await page.waitForTimeout(1500);
  expect(seen.reads.slice(reads)).toEqual([]);
  expect(new URL(page.url()).pathname).toBe("/needs/PROJ1/sample-repo-2/999");
  // A click on a row leaves the stale link.
  await row(page, A).click();
  await expect(h1(page)).toHaveText(A);
});

// "Skip to the list" moves the focus and leaves the history as it is: no "#rows" entry without a state.
test("Skip to the list focuses the list with no history entry", async ({ page }) => {
  await connect(page);
  await row(page, A).click();
  await expect(h1(page)).toHaveText(A);
  const before = await depth(page);
  const url = page.url();
  const skip = page.getByRole("button", { name: "Skip to the list" });
  await skip.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#rows")).toBeFocused();
  expect(page.url()).toBe(url);
  expect(await depth(page)).toBe(before);
});

test("the next PR opens at the top: a key press after a scroll keeps no old scroll position and acks nothing below the fold", async ({
  page,
  request,
}) => {
  await connect(page);
  // PR 210 gets a long thread of unread messages.
  await control("state", { tall: 6 });
  await page.getByRole("button", { name: /^Reviewing/ }).click();
  const titles = await page.locator("[data-row]").evaluateAll((rows) => rows.map((r) => r.textContent ?? ""));
  const at = titles.findIndex((t) => t.includes(B));
  // The neighbour row of PR 210, and the key that moves from it to PR 210.
  const [from, key] = at > 0 ? [at - 1, "j"] : [at + 1, "k"];
  const unread = async () => {
    const rows = (await (await request.get(`${APP}/api/prs`)).json()) as { id: number; title: string }[];
    const id = rows.find((r) => r.title === B)?.id;
    const detail = (await (await request.get(`${APP}/api/prs/${id}`)).json()) as { comments: { id: number; unread: boolean }[] };
    return detail.comments.filter((c) => c.unread).map((c) => c.id);
  };
  // A first visit puts PR 210 in the query cache, so the key press below shows it at once, without a loading state.
  await page.locator("[data-row]").nth(at).click();
  await expect(h1(page)).toHaveText(B);
  await expect(page.locator("#c-2000000")).toBeVisible();
  // Longer than the 1 s ack batch.
  await page.waitForTimeout(2500);
  const before = await unread();
  await page.locator("[data-row]").nth(from).click();
  await expect(h1(page)).not.toHaveText(B);
  await pane(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(() => pane(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.locator("[data-row]").nth(from).focus();
  await page.keyboard.press(key);
  await expect(h1(page)).toHaveText(B);
  expect(await pane(page).evaluate((el) => el.scrollTop)).toBe(0);
  // The unread messages below the fold of PR 210 stay unread after the ack batch.
  const below = (
    await page.locator("[data-scroll] [data-id]").evaluateAll((els) => {
      const box = els[0]?.closest("[data-scroll]")?.getBoundingClientRect();
      return els.filter((e) => box && e.getBoundingClientRect().top >= box.bottom).map((e) => Number(e.getAttribute("data-id")));
    })
  ).filter((m) => before.includes(m));
  expect(below.length).toBeGreaterThan(0);
  await page.waitForTimeout(2500);
  const after = await unread();
  for (const m of below) expect(after).toContain(m);
});
