// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// M1 browser acceptance (plan G8, BRIEF section 6). Runs against the fake Bitbucket of serve.ts only.
import { type APIRequestContext, test as base, expect, type Locator, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, liveStreams, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = {
  a: "Batch cache writes in the sync worker",
  b: "Show build status on the release page",
  c: "Drop the legacy export endpoint",
};

type Note = { title: string; body?: string; tag?: string };
type Win = { __notes: (Note & { click(): void })[] };

const test = base.extend<{ permission: "granted" | "denied"; seen: { urls: string[]; logs: string[] } }>({
  permission: ["granted", { option: true }],
  seen: [
    async ({ context, permission }, use) => {
      // Headless Chromium reports "denied". A recorder replaces the Notification API.
      if (permission === "granted") await context.grantPermissions(["notifications"]);
      await context.addInitScript((p) => {
        const w = window as unknown as Win;
        w.__notes = [];
        class Recorder {
          static permission = p;
          static requestPermission = async () => p;
          onclick: (() => void) | null = null;
          constructor(title: string, opts: NotificationOptions = {}) {
            w.__notes.push({ title, body: opts.body, tag: opts.tag, click: () => this.onclick?.() });
          }
          close() {}
        }
        Object.defineProperty(window, "Notification", { value: Recorder, configurable: true, writable: true });
      }, permission);
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      context.on("weberror", (e) => seen.logs.push(e.error().message));
      await control("reset");
      await use(seen);
      // Every test: only the local app gets requests, and the console holds no token and no CSP violation.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN))).toEqual([]);
      expect(seen.logs.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l))).toEqual([]);
    },
    { auto: true },
  ],
});

const row = (page: Page, title: string) => page.locator("[data-row]", { hasText: title });
const notes = (page: Page) => page.evaluate(() => (window as unknown as Win).__notes.map(({ title, body, tag }) => ({ title, body, tag })));
const nav = (page: Page, view: string) => page.locator("nav[aria-label='Views']").getByRole("button", { name: view, exact: false }).first();
const detailTitle = (page: Page) => page.locator("section[aria-label='Details'] h1");

async function prRow(request: APIRequestContext, title: string) {
  const rows = (await (await request.get(`${APP}/api/prs`)).json()) as {
    id: number;
    title: string;
    unread: number;
    state: string;
    followed: boolean;
  }[];
  const hit = rows.find((p) => p.title === title);
  if (!hit) throw new Error(`no row ${title}`);
  return hit;
}

async function unreadIds(request: APIRequestContext, title: string) {
  const { id } = await prRow(request, title);
  const detail = (await (await request.get(`${APP}/api/prs/${id}`)).json()) as { comments: { id: number; unread: boolean }[] };
  return detail.comments.filter((c) => c.unread).map((c) => c.id);
}

// US9 in the browser: the URL and the token go through the settings screen. Then the first check imports silently.
async function connect(page: Page, notify = true) {
  await openApp(page);
  await expect(page.getByText("Connect PR Review Inbox to your Bitbucket Server.")).toBeVisible();
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await expect(row(page, TITLE.a)).toBeVisible();
  await expect(page).toHaveTitle("PR Review Inbox");
  // The token is never in the page or in localStorage.
  expect(await page.content()).not.toContain(E2E_TOKEN);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(E2E_TOKEN);
  if (notify) {
    await page.getByRole("button", { name: "Settings" }).click();
    const toggle = page.getByLabel("Show a desktop notification for new activity");
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.getByRole("button", { name: "Cancel" }).click();
  }
}

// Shows a PR without unread messages in the detail pane, so the tested PR stays unread.
async function park(page: Page, title = TITLE.c) {
  await nav(page, "Reviewing").click();
  await row(page, title).click();
  await expect(detailTitle(page)).toHaveText(title);
}

test("A1: a reply is one unread event in the right thread and stays unread after a restart", async ({ page, request }) => {
  await connect(page);
  await park(page);
  await control("state", { reply: "new" });
  await expect(row(page, TITLE.a)).toContainText("1 new");
  await expect(page).toHaveTitle("(1) PR Review Inbox");
  await expect.poll(() => notes(page)).toEqual([expect.objectContaining({ tag: "PROJ1/sample-repo-2 #1001" })]);

  await control("restart");
  expect(await unreadIds(request, TITLE.a)).toEqual([1000010]);
  // A reload keeps the parked PR in the URL (plan pr-view-v4 section 5). The plain start URL opens Needs you.
  await openApp(page);
  // Needs you opens the PR first. The highlight keeps the state at open.
  const reply = page.locator("#c-1000010");
  await expect(detailTitle(page)).toHaveText(TITLE.a);
  await expect(reply).toHaveAttribute("data-new", "true");
  await expect(page.locator("li", { has: page.locator("#c-1000003") }).locator("#c-1000010")).toHaveCount(1);
  // v3 (WP5): the first row was on screen after the import, so the header names that visit.
  await expect(page.getByRole("button", { name: /^1 new since (today|yesterday) \d\d:\d\d$/ })).toBeVisible();
  await expect.poll(() => unreadIds(request, TITLE.a)).toEqual([]);
});

test("A2: a message below the viewport stays unread; the scroll position stays when events arrive", async ({ page, request }) => {
  await connect(page);
  await park(page);
  await control("state", { tall: 6 });
  await expect(row(page, TITLE.b)).toContainText("7 new");
  await row(page, TITLE.b).click();
  await expect(page.locator("#c-2000000")).toBeVisible();
  // A new message arrives while the first ones are read.
  await control("state", { tall: 7 });
  await expect(page.locator("#c-2000007")).toHaveAttribute("data-new", "true");
  await expect.poll(() => unreadIds(request, TITLE.b)).not.toContain(2000000);
  // Longer than the 1 s ack batch plus one retry window.
  await page.waitForTimeout(2500);
  const left = await unreadIds(request, TITLE.b);
  expect(left).toContain(2000006);
  expect(left).toContain(2000007);

  const pane = page.locator("[data-scroll]");
  await pane.evaluate((el) => el.scrollTo({ top: 400 }));
  const before = await pane.evaluate((el) => el.scrollTop);
  const listBefore = await page.locator("#rows").evaluate((el) => el.scrollTop);
  await control("state", { tall: 8 });
  await expect(page.locator("#c-2000008")).toBeAttached();
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(before);
  expect(await page.locator("#rows").evaluate((el) => el.scrollTop)).toBe(listBefore);
});

test("A2: a visible message edited before its ack is read at the new version", async ({ page, request }) => {
  await connect(page);
  await park(page);
  await control("state", { reply: "new" });
  await expect(row(page, TITLE.a)).toContainText("1 new");
  // Holds the first ack, so the edit lands while the message is still unread on screen.
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const sent = new Promise<void>((resolve) =>
    page.route("**/api/read", async (route) => {
      if (!first) return route.continue();
      first = false;
      resolve();
      await held;
      await route.continue();
    }),
  );
  await row(page, TITLE.a).click();
  await expect(page.locator("#c-1000010")).toBeVisible();
  await sent;
  await control("state", { reply: "edit" });
  await expect(page.locator("#c-1000010")).toContainText("Edited: the flush order is fixed now.");
  release();
  await expect.poll(() => unreadIds(request, TITLE.a)).toEqual([]);
});

test("A3, A4, A5: duplicates, edit, delete after the 404, multi-page data, and a visible gap", async ({ page, request }) => {
  await connect(page);
  await park(page);
  await control("state", { reply: "dup" });
  await expect(row(page, TITLE.a)).toContainText("1 new");
  await expect(row(page, TITLE.a)).toHaveCount(1);
  await expect.poll(() => notes(page)).toHaveLength(1);
  await row(page, TITLE.a).click();
  // Activities come one per page. Every message of every page is there once.
  for (const id of [1000003, 1000001, 1000010]) await expect(page.locator(`#c-${id}`)).toHaveCount(1);
  await expect.poll(() => unreadIds(request, TITLE.a)).toEqual([]);

  // A4: an edit is unread again, with the new text, and gives no notification.
  await park(page);
  await control("state", { reply: "edit" });
  await expect(row(page, TITLE.a)).toContainText("1 new");
  await row(page, TITLE.a).click();
  await expect(page.locator("#c-1000010")).toContainText("Edited: the flush order is fixed now.");
  await expect(page.locator("#c-1000010")).toHaveAttribute("data-new", "true");
  expect(await notes(page)).toHaveLength(1);

  // Absent from the activities, but Bitbucket still has it: a gap, not a delete (A5).
  await control("state", { reply: "absent" });
  // v3 (WP5): the tabs are gone. The banner sits in the Overview section.
  const panel = page.locator("#s-overview");
  await expect(panel.getByText("Last check incomplete", { exact: true })).toBeVisible();
  await expect(panel.getByText("a comment is missing from the activities")).toBeVisible();
  // v3 (WP3): the row says "Last check incomplete", as in prototype/v3 row().
  await expect(row(page, TITLE.a)).toContainText("Last check incomplete");
  await expect(page.locator("#c-1000010")).toContainText("Edited: the flush order is fixed now.");

  // The 404 confirms the delete.
  await control("state", { reply: "deleted" });
  await expect(page.locator("#c-1000010")).toContainText("Deleted on Bitbucket");
  await expect(page.locator("#c-1000010")).not.toContainText("Edited");
  await expect(panel.getByText("Last check incomplete", { exact: true })).toBeHidden();
});

test("A6: Bitbucket goes down mid-page: offline state, nothing deleted, then recovery", async ({ page }) => {
  await connect(page);
  await control("state", { down: true });
  await expect(page.getByText(/^Offline\. Last checked \d\d:\d\d\./).first()).toBeVisible();
  await nav(page, "Reviewing").click();
  for (const t of Object.values(TITLE)) await expect(row(page, t)).toBeVisible();
  await row(page, TITLE.a).click();
  // v3 (WP5, plan I1): a read thread that waits on others is collapsed and renders no message. Open it first.
  await page.locator("#th-1000003").click();
  await expect(page.locator("#c-1000003")).toHaveCount(1);
  await expect(page.getByText("Deleted on Bitbucket")).toHaveCount(0);

  await control("state", { down: false });
  await expect(page.getByText(/^Offline\./)).toHaveCount(0);
  await expect(page.getByText(/^Checked \d\d:\d\d$/).first()).toBeAttached();
  for (const t of Object.values(TITLE)) await expect(row(page, t)).toBeVisible();
});

test("A14: two pages get one notification; read in one page updates the other; a click opens the PR", async ({ page, context }) => {
  await connect(page);
  const other = await context.newPage();
  const claimed = other.waitForResponse((r) => r.url().endsWith("/api/notifications/claim"));
  await other.goto("/");
  await claimed;
  for (const p of [page, other]) await park(p);

  await control("state", { reply: "new" });
  for (const p of [page, other]) await expect(row(p, TITLE.a)).toContainText("1 new");
  const count = async () => (await notes(page)).length + (await notes(other)).length;
  await expect.poll(count).toBe(1);
  await page.waitForTimeout(1500);
  expect(await count()).toBe(1);

  const [clicker, watcher] = (await notes(page)).length ? [page, other] : [other, page];
  await clicker.evaluate(() => (window as unknown as Win).__notes[0]?.click());
  await expect(detailTitle(clicker)).toHaveText(TITLE.a);
  await expect(nav(clicker, "Needs you")).toHaveAttribute("aria-current", "page");
  await expect(row(watcher, TITLE.a)).not.toContainText("1 new");
});

test("a review run end notifies with its result; a failed run says why; a click opens the PR", async ({ page }) => {
  const KEY = "PROJ1/sample-repo-2 #1001";
  const runRow = page.locator("#runline [data-run-kind='review']");
  const runNotes = async () => (await notes(page)).filter((n) => n.body?.startsWith(`${KEY}: review`));
  const review = async () => {
    await page.keyboard.press("Shift+R");
    await expect(page.getByLabel("Your note")).toBeFocused();
    await page.getByLabel("Your note").fill("Check the flush order.");
    await page.getByLabel("Your note").press("Control+Enter");
  };
  await connect(page);
  await row(page, TITLE.a).click();
  await expect(detailTitle(page)).toHaveText(TITLE.a);

  await review();
  await expect(runRow).toHaveAttribute("data-run-state", "done", { timeout: 60_000 });
  const found = /(\d+) findings?/.exec((await page.locator("#runline").textContent()) ?? "")?.[1];
  const word = found === "1" ? "finding" : "findings";
  await expect.poll(runNotes).toEqual([{ title: TITLE.a, body: `${KEY}: review done, ${found} ${word}`, tag: KEY }]);

  await control("claude", { stream: "limit" });
  await review();
  await expect(page.locator("#runline")).toContainText("Usage limit reached", { timeout: 60_000 });
  await expect.poll(async () => (await runNotes()).length).toBe(2);
  expect((await runNotes())[1]?.body).toMatch(/^PROJ1\/sample-repo-2 #1001: review failed \(.+\)$/);

  await park(page);
  await page.evaluate(() => (window as unknown as Win).__notes.at(-1)?.click());
  await expect(detailTitle(page)).toHaveText(TITLE.a);
});

test("three pages share one live stream; a change reaches every page; the stream moves when its page closes", async ({ page, context }) => {
  const streams: string[] = [];
  context.on("request", (r) => {
    if (r.url().endsWith("/api/live")) streams.push(r.url());
  });
  await connect(page);
  const others = [await context.newPage(), await context.newPage()];
  for (const p of others) await openApp(p);
  for (const p of [page, ...others]) await park(p);
  await expect.poll(liveStreams).toBe(1);
  await page.waitForTimeout(1000);
  expect(await liveStreams()).toBe(1);
  expect(streams).toHaveLength(1);

  await control("state", { reply: "new" });
  for (const p of [page, ...others]) await expect(row(p, TITLE.a)).toContainText("1 new");

  // The first page holds the lock. Another page takes it over.
  await page.close();
  await expect.poll(() => streams.length).toBe(2);
  await control("state", { reply: "two" });
  for (const p of others) await expect(row(p, TITLE.a)).toContainText("2 new");
  await expect.poll(liveStreams).toBe(1);
});

test("A15: a merge leaves Reviewing, stays in Needs you on my turn, and stays followed", async ({ page, request }) => {
  await connect(page);
  await park(page, TITLE.b);
  await control("state", { merge: "reply" });
  await expect(row(page, TITLE.c)).toContainText("1 new");
  await control("state", { merge: "merged" });
  await expect(row(page, TITLE.c)).toHaveCount(0);
  expect(await prRow(request, TITLE.c)).toMatchObject({ state: "MERGED", unread: 1, followed: true });

  await nav(page, "Needs you").click();
  await expect(row(page, TITLE.c)).toContainText("Merged");
  await expect(row(page, TITLE.c)).toContainText("1 new");
  // v3 (WP1): the reply makes it my turn, so the PR stays in Needs you after the read. M1 dropped it from Needs you.
  await expect(row(page, TITLE.c)).not.toContainText("1 new");
  expect(await prRow(request, TITLE.c)).toMatchObject({ state: "MERGED", unread: 0, yourTurn: 1, group: "your" });
  // v3 (WP3, D1): the row sits in the Needs you group, and its why-line starts with "Merged.".
  const needs = page.locator("section[aria-labelledby='g-needs'] [data-row]", { hasText: TITLE.c });
  await expect(needs).toContainText(/Merged\.\s*Your turn/);
  await nav(page, "Following").click();
  await expect(needs).toContainText("Merged.");
});

test("copy: a message copies as raw Markdown without a toast; a deleted message has no Copy", async ({ page, context, request }) => {
  // U19: headless Chromium reads the clipboard after this grant (m2 raw output test).
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  const md = "Check the **flush order** again, then `flush()`.";
  // The e2e data has no Markdown. The detail response gets it for the new reply.
  await page.route(/\/api\/prs\/\d+$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { comments: { id: number; text: string | null }[] };
    for (const c of body.comments) if (c.id === 1000010 && c.text !== null) c.text = md;
    await route.fulfill({ response: res, json: body });
  });
  await connect(page, false);
  await park(page);
  await control("state", { reply: "new" });
  await expect(row(page, TITLE.a)).toContainText("1 new");
  await row(page, TITLE.a).click();
  const msg = page.locator("#c-1000010");
  await expect(msg.locator("strong")).toHaveText("flush order");
  await expect.poll(() => unreadIds(request, TITLE.a)).toEqual([]);

  const copy = msg.getByRole("button", { name: "Copy Markdown" });
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(md);
  await expect(msg.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Copied" })).toHaveCount(1);
  await expect(page.locator("[data-slot='toast']")).toHaveCount(0);
  // The label goes back after 1.5 s. The copy changes no read state.
  await expect(copy).toBeVisible();
  await expect(msg).toHaveAttribute("data-new", "true");
  expect(await unreadIds(request, TITLE.a)).toEqual([]);

  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("blocked")) }));
  await copy.click();
  await expect(page.locator("[data-slot='toast']")).toHaveCount(1);
  await expect(page.locator("[data-slot='toast']")).toContainText("The clipboard is blocked here.");
  await expect(copy).toBeVisible();

  await control("state", { reply: "deleted" });
  await expect(msg).toContainText("Deleted on Bitbucket");
  await expect(msg.getByRole("button", { name: /^Cop/ })).toHaveCount(0);
  await expect(page.locator("#c-1000003").getByRole("button", { name: "Copy Markdown" })).toBeVisible();
});

test("task rules: a live preview, a syntax error that stays unsaved, and the autosaved rule on the rows", async ({ page }) => {
  await connect(page, false);
  await nav(page, "Reviewing").click();
  await row(page, TITLE.a).click();
  await page.getByRole("button", { name: "Settings" }).click();
  // The default rules find nothing in the e2e PR, whose branch is topic/sample-3.
  await expect(page.getByText("No match.")).toBeVisible();
  const pattern = page.getByLabel("Pattern of rule 1");
  const status = page.locator("#taskids-status");
  await expect(page.getByRole("button", { name: "Save task rules" })).toHaveCount(0);
  await pattern.fill("(");
  await expect(page.getByText("This is not a valid regular expression")).toBeVisible();
  await expect(status).toHaveText("A marked rule is not saved. Fix it to save it.");
  // A bad task link stays unsaved too and shows its own error.
  const link = page.getByLabel("Task link (optional)");
  await link.fill("ftp://tracker.example.test/{key}");
  await expect(page.getByText("The task link must be an https URL with {key}.", { exact: false })).toBeVisible();
  await link.fill("");
  await pattern.fill(String.raw`sample-\d+`);
  await expect(page.getByRole("list", { name: "Task IDs found" })).toContainText("sample-3");
  await expect(status).toHaveText("Saved. The inbox finds the task IDs again in the background.");
  await page.getByRole("button", { name: "Cancel" }).click();
  // The background pass writes the IDs, and the live channel refreshes the list.
  await expect(row(page, TITLE.a)).toContainText("sample-3");
});

test("settings: the section links focus each section, each section says how it saves, and Appearance sets the theme", async ({ page }) => {
  await connect(page, false);
  const settings = page.locator("nav[aria-label='Views']").getByRole("button", { name: "Settings" });
  await settings.click();
  await expect(settings).toHaveAttribute("aria-current", "page");
  const links = page.getByRole("navigation", { name: "Settings sections" });
  await expect(links.getByRole("link").first()).toHaveText("Connection");
  await expect(links.getByRole("link").last()).toHaveText("Project instructions");

  await links.getByRole("link", { name: "Clones" }).click();
  await expect(page.getByRole("heading", { name: "Clones" })).toBeFocused();
  await expect(page.locator("section[aria-labelledby='h-clones']")).toContainText("Change saves from its dialog. Remove saves at once.");
  await expect(page.locator("section[aria-labelledby='h-instructions']")).toContainText("Changes save as you make them.");
  await expect(page.locator("section[aria-labelledby='h-connection']")).toContainText(
    "Press Save to keep the changes. Save tests the connection to the server first, so it does not save by itself.",
  );
  await expect(page.locator("section[aria-labelledby='checks-title']")).toContainText("Changes save at once.");
  await expect(page.locator("section[aria-labelledby='h-profiles']")).toContainText("Changes save as you make them.");
  await expect(page.locator("section[aria-labelledby='h-taskids']")).toContainText("Changes save as you make them.");

  await links.getByRole("link", { name: "Appearance" }).click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeFocused();
  const html = page.locator("html");
  await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
  await page.locator("label", { hasText: /^Dark$/ }).click();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(html).toHaveClass(/\bdark\b/);
  await page.getByRole("radio", { name: "Dark" }).press("ArrowRight");
  await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
  await page.locator("label", { hasText: /^Light$/ }).click();
  await expect(html).not.toHaveClass(/\bdark\b/);
  // The theme button of the sidebar stays. It cycles the same value: light, then dark.
  await page.getByRole("button", { name: /^Theme: light\./ }).click();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(html).toHaveClass(/\bdark\b/);
});

test("Ready to post without accepted drafts: the detail pane says so and goes to Review runs", async ({ page }) => {
  await connect(page, false);
  await page.locator("#nav-post").click();
  const detail = page.locator("section[aria-label='Details']");
  await expect(detail).toContainText("Nothing is ready to post");
  await expect(detail).not.toContainText("Select a pull request in the list.");
  await detail.getByRole("button", { name: "Go to Review runs" }).click();
  await expect(page.locator("#view-name")).toHaveText("Review runs");
  await expect(page.locator("#nav-runs")).toHaveAttribute("aria-current", "page");
});

test.describe("denied notifications", () => {
  test.use({ permission: "denied" });
  test("a denied permission does not block the inbox", async ({ page }) => {
    await connect(page, false);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("This browser blocks notifications for PR Review Inbox.")).toBeVisible();
    const toggle = page.getByLabel("Show a desktop notification for new activity");
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.getByRole("button", { name: "Cancel" }).click();
    await park(page);
    await control("state", { reply: "new" });
    await expect(row(page, TITLE.a)).toContainText("1 new");
    await page.waitForTimeout(1500);
    expect(await notes(page)).toEqual([]);
  });
});

test("keys j, k, Enter, Esc, /, n, N, o, g f, and ? work", async ({ page }) => {
  await connect(page, false);
  await nav(page, "Reviewing").click();
  const rows = page.locator("[data-row]");
  await expect(rows).toHaveCount(3);
  const ids = await rows.evaluateAll((els) => els.map((e) => e.id));
  const current = page.locator("[data-row][aria-current='true']");
  const details = page.locator("section[aria-label='Details']");

  // v3 (WP5, prototype/v3 row click): a click opens the PR in the detail, as Enter does. Esc goes back to the row.
  await rows.nth(0).click();
  await expect(details).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(current).toBeFocused();
  await page.keyboard.press("j");
  await expect(current).toHaveId(String(ids[1]));
  await page.keyboard.press("k");
  await expect(current).toHaveId(String(ids[0]));

  // No thread needs me in this PR, so Enter focuses the pane.
  await page.keyboard.press("Enter");
  await expect(details).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(current).toBeFocused();

  await page.keyboard.press("/");
  const filter = page.getByLabel("Filter the list");
  await expect(filter).toBeFocused();
  await page.keyboard.type("export");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(filter).not.toBeFocused();
  await filter.fill("");
  await expect(rows).toHaveCount(3);

  // The selection is PR 77 now, so PR 210 opens with all 4 new messages.
  await control("state", { tall: 3 });
  // The cause comes with the sync, so the click waits for the new messages on the row.
  await expect(row(page, TITLE.b)).toContainText("4 new");
  await row(page, TITLE.b).click();
  await expect(page.locator("[data-new]")).toHaveCount(4);
  // v3 (WP5): the click opens the PR at its cause, the first new message. n and N follow the thread order.
  await expect(page.locator("#c-2000000")).toBeFocused();
  await page.keyboard.press("n");
  await expect(page.locator("#c-2000001")).toBeFocused();
  await page.keyboard.press("n");
  await expect(page.locator("#c-2000002")).toBeFocused();
  await page.keyboard.press("N");
  await expect(page.locator("#c-2000001")).toBeFocused();

  // v3 (WP5, plan I14): j and k move between threads. The thread that waits on others comes first.
  await page.keyboard.press("k");
  await expect(page.locator("#t-1000003")).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator("#t-2000000")).toBeFocused();
  // o closes the current thread. A closed thread renders no message.
  await page.keyboard.press("o");
  await expect(page.locator("#th-2000000")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-new]")).toHaveCount(0);
  await page.keyboard.press("o");
  await expect(page.locator("#th-2000000")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("[data-new]")).toHaveCount(4);
  // The e2e data has no forge file list (WP4). Plan r2 UI-DIFF: Files opens anyway and offers to get the code. Nothing fetches yet.
  await page.keyboard.press("g");
  await page.keyboard.press("f");
  await expect(page.locator("#s-files")).toHaveAttribute("open", "");
  await expect(page.locator("#s-files").getByRole("button", { name: "Get the code", exact: true })).toBeFocused();

  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

// Elements of a pane that end right of the pane edge, with 0.5 px for subpixel rounding.
const outside = (pane: Locator, parts = "*") =>
  pane.evaluate((el, sel) => {
    const edge = el.getBoundingClientRect().right + 0.5;
    return [...el.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().right > edge).map((e) => e.outerHTML.slice(0, 120));
  }, parts);

test("long repository and branch names stay inside their panes", async ({ page }) => {
  // The repository list shows only next to the full sidebar: 1440 px and wider (plan pr-view-v4 decision D4).
  await page.setViewportSize({ width: 1440, height: 800 });
  await connect(page, false);
  const side = page.locator("nav[aria-label='Views']");
  const list = page.locator("section[aria-labelledby='view-name']");
  const detail = page.locator("section[aria-label='Details']");
  await side.getByRole("button", { name: "release-pipeline-observability-dashboard" }).click();
  await expect(list.getByRole("button", { name: "Show all repositories" })).toBeVisible();
  await row(page, TITLE.b).click();
  await expect(detailTitle(page)).toHaveText(TITLE.b);
  // Wide and rail layouts give the list 368 px and 320 px.
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await outside(list)).toEqual([]);
    expect(await outside(side)).toEqual([]);
    expect(await outside(detail, "header, header *")).toEqual([]);
    expect((await page.getByLabel("Filter the list").boundingBox())?.width).toBeGreaterThanOrEqual(96);
  }
});

test("at 1100 px the sidebar is a rail: names, tooltips, and count badges stay, and j, k, and the views work", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await connect(page, false);
  const side = page.locator("nav[aria-label='Views']");
  const detail = page.locator("section[aria-label='Details']");
  expect((await side.boundingBox())?.width).toBe(60);
  const reviewing = side.locator("#nav-reviewing");
  await expect(reviewing.locator(".rl-lbl").first()).toBeHidden();
  await expect(reviewing).toHaveAccessibleName(/^Reviewing: \d+$/);
  const n = ((await reviewing.getAttribute("aria-label")) ?? "").split(": ")[1];
  await expect(reviewing.locator(".rl-badge")).toHaveText(n ?? "");
  await reviewing.hover();
  await expect(page.locator("[data-slot='tooltip-content']")).toHaveText(`Reviewing: ${n}`);

  // A click and Enter switch the view.
  await reviewing.click();
  await expect(page.locator("#view-name")).toHaveText("Reviewing");
  await expect(reviewing).toHaveAttribute("aria-current", "page");
  await side.locator("#nav-needs").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#view-name")).toHaveText("Needs you");
  await reviewing.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#view-name")).toHaveText("Reviewing");

  // j and k move the selection as in the wide layout.
  const rows = page.locator("[data-row]");
  await expect(rows).toHaveCount(3);
  const ids = await rows.evaluateAll((els) => els.map((e) => e.id));
  const current = page.locator("[data-row][aria-current='true']");
  await rows.nth(0).click();
  await expect(detail).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(current).toBeFocused();
  await page.keyboard.press("j");
  await expect(current).toHaveId(String(ids[1]));
  await page.keyboard.press("k");
  await expect(current).toHaveId(String(ids[0]));
  expect(await outside(side)).toEqual([]);
  expect(await outside(detail, "#s-overview, #s-overview *")).toEqual([]);
});

test("a read row keeps its place, so the next unread row is not shown and read; the chip sorts again", async ({ page, request }) => {
  await connect(page);
  await park(page, TITLE.b);
  await control("state", { reply: "new", merge: "reply" });
  await expect(row(page, TITLE.a)).toContainText("1 new");
  await expect(row(page, TITLE.c)).toContainText("1 new");

  await nav(page, "Needs you").click();
  const rows = page.locator("[data-row]");
  const [first, second] = await Promise.all([rows.nth(0).innerText(), rows.nth(1).innerText()]);
  const firstTitle = first.includes(TITLE.a) ? TITLE.a : TITLE.c;
  const secondTitle = firstTitle === TITLE.a ? TITLE.c : TITLE.a;
  expect(second).toContain(secondTitle);
  await expect(detailTitle(page)).toHaveText(firstTitle);
  // The default row is read. On the server it now sorts below the other unread row.
  await expect.poll(async () => (await prRow(request, firstTitle)).unread).toBe(0);
  await expect(row(page, firstTitle)).not.toContainText("1 new");
  const chip = page.getByRole("button", { name: "1 updated · re-sort" });
  await expect(chip).toBeVisible();
  // Longer than the 1 s ack batch plus one retry window.
  await page.waitForTimeout(2500);
  await expect(rows.nth(0)).toContainText(firstTitle);
  await expect(detailTitle(page)).toHaveText(firstTitle);
  await expect(row(page, secondTitle)).toContainText("1 new");
  expect((await prRow(request, secondTitle)).unread).toBe(1);

  await chip.click();
  await expect(chip).toHaveCount(0);
  await expect(rows.nth(0)).toContainText(secondTitle);
  // The selection follows the PR, not the first place.
  await expect(detailTitle(page)).toHaveText(firstTitle);
  await expect(row(page, firstTitle)).toHaveAttribute("aria-current", "true");
  expect((await prRow(request, secondTitle)).unread).toBe(1);
});
