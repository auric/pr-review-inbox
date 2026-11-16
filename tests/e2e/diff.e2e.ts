// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 UI-DIFF in the browser: get the code on a click, open a file, threads and drafts on their lines, Show in diff and
// back, and the diff marks nothing read. Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, cssColor, E2E_TOKEN, FAKE_URL, makeClone, openApp, pushClone, writes } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
const PR_PATH = "/rest/api/1.0/projects/PROJ1/repos/sample-repo-2/pull-requests/1001";
const RUN_MS = 60_000;
// tests/support/review-fixture.ts: the diff of src/cache/flush.ts. The context row "for (…)" is old line 3, new line 2.
// REVIEW_RESULT: the exact draft on new line 3, the moved draft on new line 5, and a README draft outside the diff.
const LOCK = "The lock now covers one entry at a time.";
const RELEASE = "lock.release() does not run when write() throws.";
const NOTE = "Keep the loop header as it is.";

const test = base.extend<{ seen: { urls: string[]; reads: number } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], reads: 0 };
      context.on("request", (r) => {
        seen.urls.push(r.url());
        if (r.method() === "POST" && new URL(r.url()).pathname === "/api/read") seen.reads++;
      });
      await control("reset");
      await use(seen);
      // The page sends requests to the local app only. Get the code runs git on the server.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
    },
    { auto: true },
  ],
});

const drafts = (page: Page) => page.locator("[data-draft]");
const files = (page: Page) => page.locator("#s-files");
// The cards after the row of one line.
const cardsAt = (page: Page, row: string) => page.locator(`#${row} + .rl-dcard`);

// Gate v3 U4: the app posts a context-line comment as lineType CONTEXT with the old-side line. My own comment is read at once.
async function contextComment() {
  const res = await fetch(`${FAKE_URL}${PR_PATH}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: NOTE,
      anchor: { path: "src/cache/flush.ts", line: 3, lineType: "CONTEXT", fileType: "TO", diffType: "COMMIT" },
    }),
  });
  expect(res.status).toBe(201);
}

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

// Shift+R opens the brief. Ctrl+Enter starts the review. The fake CLI gives 3 drafts and 1 question. The README nit waits in the
// closed More fold (docs/plans/review-v2/spec.md section 1.4).
async function review(page: Page) {
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(page.locator("#runline [data-run-kind='review']")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(drafts(page)).toHaveCount(2);
}

// The fetch moves the focus to the first file. PR 1001 has no forge file list, so the note offers the fetch alone.
async function getCode(page: Page, first: string) {
  const get = files(page).getByRole("button", { name: "Get the code", exact: true });
  await expect(get).toBeVisible();
  await get.click();
  await expect(page.locator("#df-0")).toBeFocused();
  await expect(page.locator("#df-0")).toContainText(first);
}

test("get the code, open flush.ts, cards on their lines, Show in diff and back, and nothing turns read", async ({ page, seen }) => {
  await contextComment();
  await connect(page);

  // The general thread stays closed, so the reply that comes next never shows. Only the diff could mark it read.
  const general = page.locator("#th-1000003");
  await expect(general).toHaveAttribute("aria-expanded", "false");
  await general.click();
  await general.click();
  await expect(general).toHaveAttribute("aria-expanded", "false");
  await control("state", { reply: "new" });
  await expect(general).toContainText("1 new");
  const reads = seen.reads;

  // Every loaded PR has Files. The fetch waits for a click. Plan pr-view-v4 section 6: g f goes to the first file row, and without
  // a file list to Get the code.
  await page.keyboard.press("g");
  await page.keyboard.press("f");
  await expect(files(page)).toHaveAttribute("open", "");
  await expect(page.locator("#diff-get")).toBeFocused();
  await getCode(page, "src/cache/flush.ts");
  await page.keyboard.press("Enter");
  await expect(page.locator("#df-0")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#dl-0-n3")).toContainText("const lock = cache.lock();");
  await expect(page.locator("#dl-0-o2")).toContainText("const lock = cache.lock();");
  // U4: the CONTEXT line 3 is old line 3, the row "for (…)" at new line 2. New line 3 is the added lock line.
  await expect(page.locator("#dl-0-n2")).toContainText("for (const entry of cache.dirty())");
  await expect(cardsAt(page, "dl-0-n2")).toContainText(`You: ${NOTE}`);
  await expect(cardsAt(page, "dl-0-n3")).toHaveCount(0);

  await review(page);
  await expect(cardsAt(page, "dl-0-n3")).toContainText(LOCK);
  await expect(cardsAt(page, "dl-0-n5")).toContainText(RELEASE);
  await expect(cardsAt(page, "dl-0-n2")).toContainText(`You: ${NOTE}`);

  // Show in diff from a draft, then back to the draft from its card.
  const first = drafts(page).nth(0);
  await first.getByRole("button", { name: "Show in diff" }).click();
  await expect(page.locator("#dl-0-n3")).toBeFocused();
  // The jump mark of a diff row is a static band inside its focus ring. The row keeps its added color.
  const added = page.locator("#dl-0-n3");
  await expect(added).toHaveAttribute("data-jump", "");
  await expect(added).toHaveAttribute("data-k", "add");
  await expect(added).toHaveCSS("background-color", await cssColor(page, "--add"));
  await expect(added).toHaveCSS("box-shadow", `${await cssColor(page, "--sel")} 0px 0px 0px 4px inset`);
  await expect(added).toHaveCSS("outline-style", "solid");
  expect(await added.evaluate((e) => e.getAnimations().length)).toBe(0);
  await cardsAt(page, "dl-0-n3").getByRole("button", { name: "Go to draft" }).click();
  await expect(first).toBeFocused();
  // g d from the focused draft.
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(page.locator("#dl-0-n3")).toBeFocused();
  // Plan pr-view-v4 2.7: g d also works from a closed row. A question has no line, so g d says why.
  const strip = page.getByRole("navigation", { name: "Pull request summary" });
  const ledger = page.locator("[data-drafts-ledger]");
  await expect(strip.getByRole("button", { name: "4 drafts" })).toBeVisible();
  await expect(ledger).toHaveText("1 must fix · 1 worth fixing · 1 more · 1 question");
  const minor = drafts(page).nth(1).locator("[data-row-head]");
  await expect(minor).toHaveAttribute("aria-expanded", "false");
  await minor.focus();
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(page.locator("#dl-0-n5")).toBeFocused();
  const question = page.locator("[data-draft-question] [data-row-head]");
  await question.focus();
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(page.locator("[data-slot=toast-title]", { hasText: "A question has no line in the diff." })).toBeVisible();
  await expect(question).toBeFocused();
  // d discards the question. The strip and the ledger count only the drafts that are not discarded.
  await page.keyboard.press("d");
  await expect(page.locator("[data-draft-question]")).toHaveAccessibleName("Discarded question");
  await expect(strip.getByRole("button", { name: "3 drafts" })).toBeVisible();
  await expect(ledger).toHaveText("1 must fix · 1 worth fixing · 1 more");

  // Show in diff from the inline thread finds the old-side line.
  const mine = page.locator("[data-thread]", { hasText: "flush.ts" }).first();
  await mine.locator("button[aria-expanded]").first().click();
  // Show in diff sits in More of the thread footer (plan pr-view-v4 2.8).
  await mine.getByRole("button", { name: "More for this thread" }).click();
  await page.getByRole("menuitem", { name: "Show in diff" }).click();
  await expect(page.locator("#dl-0-n2")).toBeFocused();
  await cardsAt(page, "dl-0-n2").getByRole("button", { name: "Go to thread" }).click();
  await expect(mine).toBeFocused();

  // The reply stays unread: no card and no step above sent a read.
  await page.waitForTimeout(1500);
  await expect(general).toContainText("1 new");
  await expect(general).toHaveAttribute("aria-expanded", "false");
  expect(seen.reads).toBe(reads);
  await expect(page.locator("[data-row]", { hasText: TITLE }).first()).toContainText("1 new");
  // Nothing went to Bitbucket but the comment of this test.
  expect(await writes()).toEqual([`POST ${PR_PATH}/comments`]);
});

test("the files part of the status strip goes to Files as g f does; without the code it goes to Get the code", async ({ page }) => {
  await connect(page);
  const link = page.getByRole("navigation", { name: "Pull request summary" }).getByRole("button", { name: /^(Files|\d+ files?)$/ });
  const first = page.locator("#df-0");
  // The e2e data has no forge file list, so the count waits for the git index.
  await expect(link).toHaveText("Files");
  await link.click();
  await expect(files(page)).toHaveAttribute("open", "");
  await expect(page.locator("#diff-get")).toBeFocused();
  await getCode(page, "src/cache/flush.ts");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  // One count for the strip and the head of Files. The head adds the line counts once the code is there.
  await expect(link).toHaveText("1 file");
  await expect(page.locator("#s-files-sum")).toHaveText(/^Files1\+\d+ −\d+$/);

  // From a closed Files, the strip opens it and focuses the first row. No diff opens.
  await page.locator("#s-files-sum").click();
  await expect(files(page)).not.toHaveAttribute("open", "");
  await link.click();
  await expect(files(page)).toHaveAttribute("open", "");
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  expect(await writes()).toEqual([]);
});

test("after a push, the drafts of the older head go to the list above the lines", async ({ page }) => {
  await connect(page);
  await review(page);
  await page.keyboard.press("g");
  await page.keyboard.press("f");
  // The review run filled the cache, so the file list shows at once.
  await expect(page.locator("#df-0")).toContainText("src/cache/flush.ts");
  await page.locator("#df-0").click();
  await expect(cardsAt(page, "dl-0-n3")).toContainText(LOCK);
  const head = ((await page.locator("#runline code").first().textContent()) ?? "").trim();

  // The new head is not in the cache: the file list goes back to the fetch button.
  await control("state", { push: true });
  await getCode(page, "docs/flush.md");
  const flush = page.locator("#df-1");
  await expect(flush).toContainText("src/cache/flush.ts");
  if ((await flush.getAttribute("aria-expanded")) !== "true") await flush.click();
  const list = page.locator(".rl-doff");
  await expect(list).toContainText("Not on the lines shown");
  await expect(list).toContainText(LOCK);
  await expect(list).toContainText(`From the review of ${head}. The code changed after it.`);
  await expect(page.locator(".rl-dcard")).toHaveCount(0);

  // Show in diff now focuses the entry in the list.
  await drafts(page).nth(0).getByRole("button", { name: "Show in diff" }).click();
  await expect(list.locator("li").first()).toBeFocused();
});

// Plan pr-view-v4 P6. The native commit and a push give PR 1001 a forge file list of 4 files. The cache does not hold that head.
async function forgeList(page: Page) {
  await control("state", { native: true });
  await pushClone(1001, await makeClone(1001));
  await control("state", {});
  await page.keyboard.press("g");
  await page.keyboard.press("f");
  // The forge list before the fetch and the git list after it have the same name.
  const list = files(page).getByRole("list", { name: "Changed files" });
  await expect(list.locator("button[aria-expanded]")).toHaveCount(4);
  return list;
}
const live = (page: Page) => page.locator("p[role='status'].sr-only");
const FETCH = "**/api/prs/*/diff/fetch";

// The next fetches wait until the test calls the result, so the progress stays on screen.
async function holdFetch(page: Page) {
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(FETCH, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

test("a file row without the code gets the code, shows the progress in the row, then opens that file", async ({ page }) => {
  await connect(page);
  const list = await forgeList(page);
  await expect(files(page)).toContainText("Select a file to see its diff.");
  await expect(files(page).getByRole("button", { name: "Get the code now" })).toBeVisible();
  // Rows keep the reading measure while no diff is open.
  expect(await list.evaluate((el) => getComputedStyle(el).maxWidth)).not.toBe("none");

  const release = await holdFetch(page);
  // The third row, so the diff that opens cannot be the first file by chance.
  const flush = list.locator("button[aria-expanded]", { hasText: "src/cache/flush.ts" });
  await expect(list.locator("button[aria-expanded]").nth(2)).toContainText("src/cache/flush.ts");
  await flush.click();
  await expect(flush).toHaveAttribute("aria-busy", "true");
  await expect(flush).toContainText("Getting the code");
  await expect(flush).toBeFocused();
  await expect(live(page)).toHaveText("Getting the code. Fetching topic/sample-3 and topic/sample-4.");
  release();

  await expect(flush).toHaveAttribute("aria-expanded", "true");
  await expect(flush).toBeFocused();
  await expect(live(page)).toHaveText("Got the code. 4 changed files. Showing src/cache/flush.ts.");
  await expect(page.locator(`#${await flush.getAttribute("aria-controls")}`)).toContainText("const lock = cache.lock();");
  await expect(list.locator("button[aria-expanded='true']")).toHaveCount(1);
  await expect(page.locator("#s-files-sum")).toHaveText(/^Files4\+\d+ −\d+$/);
  // The open diff takes the full width. Its row sticks under the action bar.
  expect(await list.evaluate((el) => getComputedStyle(el).maxWidth)).toBe("none");
  const bar = await page.locator("[data-actionbar]").evaluate((el) => (el as HTMLElement).offsetHeight);
  expect(await flush.evaluate((el) => [getComputedStyle(el).position, getComputedStyle(el).top])).toEqual(["sticky", `${bar}px`]);
  expect(await writes()).toEqual([]);
});

test("a failed fetch shows in its file row with Try again, and the focus stays on the row", async ({ page }) => {
  await connect(page);
  const list = await forgeList(page);
  const error = "The pull request has new commits. Sync first.";
  await page.route(FETCH, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error }) }));
  const flush = list.locator("button[aria-expanded]", { hasText: "src/cache/flush.ts" });
  const item = list.locator("li").filter({ hasText: "src/cache/flush.ts" });
  await flush.click();
  await expect(item).toContainText(`Cannot get the code. ${error}`);
  await expect(live(page)).toHaveText(`Cannot get the code. ${error}`);
  await expect(flush).toBeFocused();
  await expect(flush).toHaveAttribute("aria-expanded", "false");
  // Only the row that started the fetch shows the error.
  await expect(list.getByRole("button", { name: "Try again" })).toHaveCount(1);

  // The retry removes the error line. The focus goes to the row, which shows the progress.
  await page.unroute(FETCH);
  const release = await holdFetch(page);
  await item.getByRole("button", { name: "Try again" }).click();
  await expect(flush).toHaveAttribute("aria-busy", "true");
  await expect(flush).toBeFocused();
  await expect(list.getByRole("button", { name: "Try again" })).toHaveCount(0);
  release();
  await expect(flush).toHaveAttribute("aria-expanded", "true");
  await expect(flush).toBeFocused();
  expect(await writes()).toEqual([]);
});
