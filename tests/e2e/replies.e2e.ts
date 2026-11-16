// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Reply drafts (docs/plans/replies.md WP18): the Draft replies button, the draft card in each thread, its triage and post,
// the stale mark, cancel, a reply confirm that stays open when its thread changes group, and the thread footer with the
// "All | Need me" filter (plan pr-view-v4 2.8).
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI. The CLI echoes one reply per
// thread of its "Threads:" line, and every third thread gets action none (tests/support/fake-claude.ts echoReplies).
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, MARK, openApp, posts, writes } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
// A run passes the git workspace, the fake CLI, and the validator.
const RUN_MS = 60_000;
// PR 1001: my general comment 1000003 with my reply 1000001 (activities-nested-reply.json).
const ROOT = 1000003;
// The echo body for the message that a draft answers. Markdown shows the backticks as code.
const echo = (msg: number) => `Thanks. I checked message ${msg} against flush() and will change it.`;
const echoRaw = (msg: number) => `Thanks. I checked message ${msg} against \`flush()\` and will change it.`;

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
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

const row = (page: Page) => page.locator("[data-row]", { hasText: TITLE }).first();
const drafts = (page: Page) => page.locator("[data-draft]");
const thread = (page: Page, id: number) => page.locator(`#t-${id}`);
const card = (page: Page, id: number) => thread(page, id).locator("[data-reply-draft]");
const runline = (page: Page) => page.locator("#runline");
// The row of the newest run of one kind. data-run-state: running, done, failed, limit, or cancelled.
const runRow = (page: Page, kind = "review") => page.locator(`#runline [data-run-kind='${kind}']`);
// The accessible name counts the threads where it is your turn (plan pr-view-v4 2.2).
const repliesButton = (page: Page) => page.locator("#replies-btn");
const confirmBox = (page: Page) => page.getByRole("dialog", { name: /^Post .* to PROJ1\/sample-repo-2 #1001\?$/ });
const postButton = (box: Locator) => box.getByRole("button", { name: "Post", exact: true });

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

// A sync can open the thread between the read and the click, so the click repeats until the thread stays open.
async function openThread(page: Page, id: number) {
  const head = page.locator(`#th-${id}`);
  await expect(async () => {
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
}

test("Draft replies: three your-turn threads get inline drafts, one needs no reply; Accept and p post one reply under its parent", async ({
  page,
}) => {
  await connect(page);
  await control("state", { turns: 3 });
  const btn = repliesButton(page);
  await expect(btn).toHaveAccessibleName("Draft replies, 3 threads");
  await btn.click();
  await expect(runRow(page, "reply")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(runline(page)).toContainText("2 reply drafts, 1 thread needs no reply");
  // docs/plans/thread-outcome.md: each thread with an AI card gets one outcome line. A reviewer answers the point, so a valid
  // judgement reads Answered. Every your-turn thread has a current draft now, so the button counts none.
  await expect(thread(page, 1000101).locator("[data-outcome]")).toHaveText("Outcome: Answered");
  await expect(thread(page, 1000103).locator("[data-outcome]")).toHaveText("Outcome: No reply needed");
  await expect(card(page, 1000101).locator("[data-origin]")).toHaveText("from the reply run");
  await expect(btn).toHaveAccessibleName("Draft replies");
  // Key 2 with no review drafts goes to the first reply draft.
  await page.keyboard.press("2");
  await expect(page.locator(":focus")).toHaveAttribute("id", /^rd-/);
  await expect(page.locator(":focus")).toContainText("Reply draft to Alex Smith");

  for (const [t, msg] of [
    [1000101, 1000201],
    [1000102, 1000202],
  ] as const) {
    const c = card(page, t);
    await expect(c).toContainText(`Reply draft to Alex Smith`);
    await expect(c).toContainText(echo(msg));
    await expect(c).toContainText("Shown in code. The comment asks for a change.");
    await expect(c.getByRole("button", { name: "Copy Markdown" })).toBeVisible();
    await expect(c.getByRole("button", { name: "Accept" })).toBeVisible();
  }
  // Action none: the reason, and the reply box of the thread for your own reply.
  await expect(card(page, 1000103)).toContainText("No reply needed: The thread needs no answer from you.");
  await expect(card(page, 1000103).getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(thread(page, 1000103).getByRole("button", { name: "Write a reply" })).toBeVisible();
  // The waiting thread was not asked, and a reply run makes no review draft.
  await openThread(page, ROOT);
  await expect(card(page, ROOT)).toHaveCount(0);
  await expect(drafts(page)).toHaveCount(0);

  await card(page, 1000101).getByRole("button", { name: "Accept" }).click();
  await expect(card(page, 1000101)).toContainText("Accepted");
  await expect(card(page, 1000101)).toBeFocused();
  await expect(page.getByText("Ready to post: 1 reply")).toBeVisible();
  expect(await posts()).toEqual([]);

  await page.keyboard.press("p");
  const box = confirmBox(page);
  await expect(box).toHaveAccessibleName("Post 1 reply to PROJ1/sample-repo-2 #1001?");
  const items = box.getByRole("list", { name: "Comments to post" }).getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Reply to Alex Smith in the general comment");
  await expect(items.first()).toContainText(echo(1000201));
  await postButton(box).click();
  await expect(thread(page, 1000101).locator("[data-post]")).toContainText("Posted.");
  await expect(card(page, 1000101)).toHaveCount(0);
  expect(await posts()).toMatchObject([{ text: MARK + echoRaw(1000201), parent: { id: 1000201 } }]);

  // The next check brings the reply back as a message with the label of its source.
  await control("state", {});
  await expect(thread(page, 1000101).locator("[data-post]")).toHaveCount(0);
  await expect(thread(page, 1000101)).toContainText("Posted from a reply draft");
  await expect(thread(page, 1000101)).not.toContainText("Posted from a Claude Code review");
});

test("review drafts stay after a reply run (R14), and a per-thread draft replaces only that thread's draft", async ({ page }) => {
  await connect(page);
  await control("state", { turns: 3 });
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").fill("ABC-1: check the lock scope.");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  // The README nit waits in the closed More fold (docs/plans/review-v2/spec.md section 1.4).
  await expect(drafts(page)).toHaveCount(2);

  await repliesButton(page).click();
  await expect(runRow(page, "reply")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  // The newest review run still drives the drafts, the summary, and the brief.
  await expect(drafts(page)).toHaveCount(2);
  await expect(runRow(page)).toContainText("The lock moves into the loop.");
  await expect(card(page, 1000103)).toContainText("No reply needed");
  // Key 2 goes to the review drafts, then on to the reply drafts, then back.
  const focused = page.locator(":focus");
  await page.keyboard.press("2");
  await expect(focused).toHaveAttribute("id", /^d-/);
  await page.keyboard.press("2");
  await expect(focused).toHaveAttribute("id", /^rd-/);
  await expect(focused).toContainText("Reply draft to Alex Smith");
  await page.keyboard.press("2");
  await expect(focused).toHaveAttribute("id", /^d-/);
  const kept = await card(page, 1000101).getAttribute("id");

  await thread(page, 1000103).getByRole("button", { name: "Draft reply" }).click();
  await expect(card(page, 1000103)).toContainText(echo(1000203), { timeout: RUN_MS });
  await expect(card(page, 1000103)).not.toContainText("No reply needed");
  await expect(card(page, 1000101)).toHaveAttribute("id", kept ?? "");
  await expect(card(page, 1000102)).toContainText(echo(1000202));
  await expect(drafts(page)).toHaveCount(2);
});

test("a stale draft says new messages arrived; Draft again answers the newest message, and an edit posts as written", async ({ page }) => {
  await connect(page);
  await control("state", { reply: "new" });
  await expect(thread(page, ROOT)).toHaveAttribute("aria-label", /^Your turn\./);
  await expect(repliesButton(page)).toHaveAccessibleName("Draft replies, 1 thread");
  await repliesButton(page).click();
  await expect(card(page, ROOT)).toContainText(echo(1000010), { timeout: RUN_MS });
  await expect(card(page, ROOT)).not.toContainText("New messages since this draft.");

  await expect(repliesButton(page)).toHaveAccessibleName("Draft replies");

  await control("state", { reply: "two" });
  await expect(page.locator("#c-1000011")).toBeVisible();
  await expect(card(page, ROOT)).toContainText("New messages since this draft.");
  // The outcome line marks the draft out of date, and Draft replies counts the thread again.
  const outcome = thread(page, ROOT).locator("[data-outcome]");
  await expect(outcome.locator("[data-marker='stale']")).toHaveText("Out of date");
  await expect(repliesButton(page)).toHaveAccessibleName("Draft replies, 1 thread");
  // P9: the out-of-date card has no Accept and no Edit. The key a refuses with a hint, so the draft stays unaccepted.
  await expect(card(page, ROOT).getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(card(page, ROOT).getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card(page, ROOT).getByRole("button", { name: "Discard" })).toBeVisible();
  await card(page, ROOT).focus();
  await page.keyboard.press("a");
  await expect(page.getByText("New messages arrived after this draft. Draft it again, or reply to the newest as is.")).toBeVisible();
  await expect(card(page, ROOT)).not.toContainText("Accepted");
  await card(page, ROOT).getByRole("button", { name: "Draft again" }).click();
  await expect(card(page, ROOT)).toContainText(echo(1000011), { timeout: RUN_MS });
  await expect(card(page, ROOT)).not.toContainText("New messages since this draft.");
  await expect(outcome.locator("[data-marker]")).toHaveCount(0);
  // The pending line and then the new draft took the place of Draft again, so the focus followed them.
  await expect(card(page, ROOT)).toBeFocused();

  const text = "Done. The flush runs first now.";
  await card(page, ROOT).getByRole("button", { name: "Edit" }).click();
  const box = card(page, ROOT).getByRole("textbox", { name: "Edit the reply" });
  await expect(box).toBeFocused();
  await box.fill(text);
  await box.press("Control+Enter");
  await expect(card(page, ROOT)).toContainText("edited by you");
  await expect(card(page, ROOT)).toContainText("Accepted");
  await page.keyboard.press("p");
  await postButton(confirmBox(page)).click();
  await expect(thread(page, ROOT).locator("[data-post]")).toContainText("Posted.");
  expect(await posts()).toMatchObject([{ text: MARK + text, parent: { id: 1000011 } }]);
});

test("focus: a sync that puts a draft out of date moves the focus from Accept to Draft again; the pending line keeps the card ID and the focus", async ({
  page,
}) => {
  await connect(page);
  await control("state", { reply: "new" });
  await repliesButton(page).click();
  await expect(card(page, ROOT)).toContainText(echo(1000010), { timeout: RUN_MS });
  const id = (await card(page, ROOT).getAttribute("id")) ?? "";
  expect(id).toMatch(/^rd-\d+$/);

  // Accept leaves the card in the sync. The focus goes to Draft again, and the live region says why once.
  await card(page, ROOT).getByRole("button", { name: "Accept" }).focus();
  await control("state", { reply: "two" });
  await expect(page.locator("#c-1000011")).toBeVisible();
  const again = card(page, ROOT).getByRole("button", { name: "Draft again" });
  await expect(again).toBeFocused();
  const live = page.locator("p[role='status'].sr-only");
  await expect(live).toContainText("New messages arrived after this draft. Draft it again, or reply to the newest as is.");

  // Draft again leaves too. The pending line takes the focus and the ID of the card.
  await control("claude", { stream: "tree", hang: true });
  await page.keyboard.press("Enter");
  await expect(card(page, ROOT)).toContainText("Claude is drafting a reply…");
  await expect(card(page, ROOT)).toHaveAttribute("role", "status");
  await expect(card(page, ROOT)).toHaveAttribute("id", id);
  await expect(card(page, ROOT)).toBeFocused();

  // A cancel brings the out-of-date draft back under the same ID.
  await expect(runline(page)).toContainText("Drafting replies…", { timeout: RUN_MS });
  await runline(page).getByRole("button", { name: "Cancel" }).click();
  await expect(card(page, ROOT)).toContainText("New messages since this draft.", { timeout: RUN_MS });
  await expect(card(page, ROOT)).toHaveAttribute("id", id);
  await expect(card(page, ROOT)).not.toHaveAttribute("role", "status");
  expect(await posts()).toEqual([]);
});

// docs/plans/thread-outcome.md decision C: a reply run revises a draft that you edited, and never replaces it.
test("revise my reply: the revision shows a word diff against your text; Keep mine keeps your exact text; Use revision makes it the draft", async ({
  page,
}) => {
  await connect(page);
  await control("state", { reply: "new" });
  await repliesButton(page).click();
  await expect(card(page, ROOT)).toContainText(echo(1000010), { timeout: RUN_MS });
  const mine = "MINE: the flush runs first now.";
  await card(page, ROOT).getByRole("button", { name: "Edit" }).click();
  await card(page, ROOT).getByRole("textbox", { name: "Edit the reply" }).fill(mine);
  await card(page, ROOT).getByRole("textbox", { name: "Edit the reply" }).press("Control+Enter");
  await expect(card(page, ROOT)).toContainText("edited by you");

  // New messages: your edited draft is out of date. Draft replies counts it, because a run revises it.
  await control("state", { reply: "two" });
  await expect(page.locator("#c-1000011")).toBeVisible();
  const outcome = thread(page, ROOT).locator("[data-outcome]");
  await expect(outcome.locator("[data-marker='stale']")).toHaveText("Out of date");
  await expect(repliesButton(page)).toHaveAccessibleName("Draft replies, 1 thread");
  await expect(card(page, ROOT).getByRole("button", { name: "Draft again" })).toHaveCount(0);
  await card(page, ROOT).getByRole("button", { name: "Revise my reply" }).click();

  const revision = card(page, ROOT).locator("[data-revision]");
  await expect(revision).toBeVisible({ timeout: RUN_MS });
  await expect(card(page, ROOT).getByRole("region", { name: "Claude revised your reply" })).toBeVisible();
  // The diff strikes your words and underlines the new ones. Your draft stays as it is above it.
  await expect(revision.locator("del").first()).toContainText("MINE:");
  await expect(revision.locator("ins").first()).toContainText("Thanks.");
  await expect(revision.locator("[data-diff]")).toContainText("1000011");
  await expect(card(page, ROOT).locator(".rl-indent").first()).toHaveText(mine);
  await expect(outcome.locator("[data-marker='revision']")).toHaveText("Revision waiting");
  // The revision answers the newest message, so Draft replies has nothing new to do.
  await expect(repliesButton(page)).toHaveAccessibleName("Draft replies");

  // Keep mine by keyboard: your exact text stays, still accepted and out of date. The focus goes to your draft.
  await revision.getByRole("button", { name: "Keep mine" }).focus();
  await page.keyboard.press("Enter");
  await expect(revision).toHaveCount(0);
  await expect(card(page, ROOT)).toBeFocused();
  await expect(card(page, ROOT).locator(".rl-indent").first()).toHaveText(mine);
  await expect(card(page, ROOT)).toContainText("Accepted");
  await expect(outcome.locator("[data-marker='revision']")).toHaveCount(0);
  await expect(outcome.locator("[data-marker='stale']")).toHaveText("Out of date");

  // Revise again, then Use revision: the revision is the draft now, not accepted, and it answers the newest message.
  await card(page, ROOT).getByRole("button", { name: "Revise my reply" }).click();
  await expect(revision).toBeVisible({ timeout: RUN_MS });
  await revision.getByRole("button", { name: "Use revision" }).click();
  await expect(card(page, ROOT)).toContainText(echo(1000011));
  // The card of your draft holds the revision now, and it keeps the focus.
  await expect(card(page, ROOT)).toBeFocused();
  await expect(card(page, ROOT)).not.toContainText(mine);
  await expect(card(page, ROOT)).not.toContainText("Accepted");
  await expect(card(page, ROOT)).toContainText("from the reply run");
  await expect(card(page, ROOT).locator("[data-revision]")).toHaveCount(0);
  await expect(outcome.locator("[data-marker]")).toHaveCount(0);
  expect(await posts()).toEqual([]);
});

// docs/plans/thread-outcome.md decision D: no AI run. The draft answers the newest message with the same text and stays accepted.
test("reply to the newest as is: an accepted out-of-date draft posts its text under the newest message", async ({ page }) => {
  await connect(page);
  await control("state", { reply: "new" });
  await repliesButton(page).click();
  await expect(card(page, ROOT)).toContainText(echo(1000010), { timeout: RUN_MS });
  await card(page, ROOT).getByRole("button", { name: "Accept" }).click();
  await expect(card(page, ROOT)).toContainText("Accepted");
  await control("state", { reply: "two" });
  await expect(card(page, ROOT)).toContainText("New messages since this draft.");

  await card(page, ROOT).getByRole("button", { name: "Reply to the newest as is" }).click();
  await expect(card(page, ROOT)).not.toContainText("New messages since this draft.");
  await expect(card(page, ROOT)).toContainText("Accepted");
  await expect(card(page, ROOT)).toContainText(echo(1000010));
  await expect(thread(page, ROOT).locator("[data-outcome] [data-marker]")).toHaveCount(0);
  await page.keyboard.press("p");
  await postButton(confirmBox(page)).click();
  await expect(thread(page, ROOT).locator("[data-post]")).toContainText("Posted.");
  expect(await posts()).toMatchObject([{ text: MARK + echoRaw(1000010), parent: { id: 1000011 } }]);
});

test("cancel stops a reply run: the pending card goes, and no draft appears", async ({ page }) => {
  await connect(page);
  await control("state", { turns: 1 });
  await control("claude", { stream: "tree", hang: true });
  await thread(page, 1000101).getByRole("button", { name: "Draft reply" }).click();
  await expect(card(page, 1000101)).toContainText("Claude is drafting a reply…");
  // The pending line takes the place of Draft reply, so it takes the focus too.
  await expect(card(page, 1000101)).toHaveAttribute("role", "status");
  await expect(card(page, 1000101)).toBeFocused();
  await expect(runline(page)).toContainText("Drafting replies…", { timeout: RUN_MS });
  await runline(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page, "reply")).toContainText(/Cancelled after \d+ tool calls?/, { timeout: RUN_MS });
  await expect(card(page, 1000101)).toHaveCount(0);
  await expect(thread(page, 1000101).getByRole("button", { name: "Draft reply" })).toBeVisible();
  expect(await posts()).toEqual([]);
});

test("a reply confirm stays open while its thread moves from Waiting to Your turn", async ({ page }) => {
  const text = "The flush order is fixed now.";
  // The heading of the group that holds the thread: the nearest h3 before it.
  const group = () =>
    thread(page, ROOT).evaluate((el) => {
      let e = el.previousElementSibling;
      while (e && e.tagName !== "H3") e = e.previousElementSibling;
      return e?.textContent ?? "";
    });
  await connect(page);
  await expect(thread(page, ROOT)).toHaveAttribute("aria-label", /^Waiting/);
  expect(await group()).toMatch(/^Waiting on others/);
  await openThread(page, ROOT);
  await thread(page, ROOT).getByRole("button", { name: "Write a reply" }).click();
  const reply = thread(page, ROOT).getByRole("textbox", { name: /^Reply to / });
  await reply.fill(text);
  await reply.press("Control+Enter");
  const box = thread(page, ROOT).getByRole("dialog");
  await expect(postButton(box)).toBeFocused();
  const node = await thread(page, ROOT).elementHandle();

  // Another user answers, so the thread moves to the Your turn group.
  await control("state", { reply: "new" });
  await expect(thread(page, ROOT)).toHaveAttribute("aria-label", /^Your turn\./);
  expect(await group()).toMatch(/^Your turn/);
  // The same element, with the confirm still open and the focus still on Post.
  expect(await node?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(box).toBeVisible();
  await expect(postButton(box)).toBeFocused();

  await box.getByRole("button", { name: "Cancel" }).click();
  await expect(box).toBeHidden();
  await expect(reply).toHaveValue(text);
  expect(await posts()).toEqual([]);
});

test("the confirm shows the mark on an AI reply draft, and not after the settings switch is off", async ({ page }) => {
  await connect(page);
  await control("state", { turns: 1 });
  await expect(repliesButton(page)).toHaveAccessibleName("Draft replies, 1 thread");
  await repliesButton(page).click();
  await expect(card(page, 1000101)).toContainText(echo(1000201), { timeout: RUN_MS });
  await card(page, 1000101).getByRole("button", { name: "Accept" }).click();
  await expect(card(page, 1000101)).toContainText("Accepted");

  const item = () => confirmBox(page).getByRole("list", { name: "Comments to post" }).getByRole("listitem").first();
  await page.locator("#post-btn").click();
  await expect(item()).toContainText(MARK + echo(1000201));
  await confirmBox(page).getByRole("button", { name: "Cancel" }).click();
  await expect(confirmBox(page)).toBeHidden();

  await page.getByRole("button", { name: "Settings" }).click();
  const mark = page.getByRole("switch", { name: "Mark Claude-drafted comments with 🤖" });
  await expect(mark).toBeChecked();
  await mark.click();
  await expect(mark).not.toBeChecked();
  await expect(mark).toBeEnabled();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.locator("#post-btn").click();
  await expect(item()).toContainText(echo(1000201));
  await expect(item()).not.toContainText(MARK.trim());
  await postButton(confirmBox(page)).click();
  await expect(thread(page, 1000101).locator("[data-post]")).toContainText("Posted.");
  expect(await posts()).toMatchObject([{ text: echoRaw(1000201), parent: { id: 1000201 } }]);
});

test("the thread footer: Draft reply only on a your-turn thread without a draft, More with the links, no Fix; Need me filters", async ({
  page,
}) => {
  await connect(page);
  await control("state", { turns: 1 });
  await openThread(page, ROOT);
  await openThread(page, 1000101);
  // ROOT waits for the other person. 1000101 is your turn.
  await expect(thread(page, ROOT).getByRole("button", { name: "Write a reply" })).toBeVisible();
  await expect(thread(page, ROOT).getByRole("button", { name: "Draft reply" })).toHaveCount(0);
  await expect(thread(page, 1000101).getByRole("button", { name: "Draft reply" })).toBeVisible();
  // A reviewer PR gets no Fix and no runner prompt.
  await expect(thread(page, 1000101).getByRole("button", { name: "Fix", exact: true })).toHaveCount(0);
  // Resolve is a footer button, not a More item.
  await expect(thread(page, 1000101).getByRole("button", { name: "Resolve thread", exact: true })).toHaveText("Resolve");
  await thread(page, 1000101).getByRole("button", { name: "More for this thread" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Show history", "Copy the comment link", "Open on Bitbucket"]);
  await expect(menu.getByRole("menuitem", { name: "Open on Bitbucket" })).toHaveAttribute(
    "href",
    `${FAKE_URL}/projects/PROJ1/repos/sample-repo-2/pull-requests/1001/overview?commentId=1000101`,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  // A reply draft in the thread takes the place of Draft reply.
  await thread(page, 1000101).getByRole("button", { name: "Draft reply" }).click();
  await expect(card(page, 1000101)).toContainText(echo(1000201), { timeout: RUN_MS });
  await expect(thread(page, 1000101).getByRole("button", { name: "Draft reply" })).toHaveCount(0);

  // Need me shows only the threads where it is your turn or with a new message.
  const filter = page.getByRole("group", { name: "Show threads" });
  await expect(filter.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await filter.getByRole("button", { name: "Need me" }).click();
  await expect(filter.getByRole("button", { name: "Need me" })).toHaveAttribute("aria-pressed", "true");
  await expect(thread(page, ROOT)).toHaveCount(0);
  await expect(thread(page, 1000101)).toBeVisible();
  await filter.getByRole("button", { name: "All" }).click();
  await expect(thread(page, ROOT)).toBeVisible();
  expect(await posts()).toEqual([]);
});

// docs/plans/thread-outcome.md on my PR 1004: two general threads by the reviewer. The reply run judges LOCK not valid and LOOP valid.
// The fix run then proposes an edit for LOCK, so the reply and the fix disagree there.
const OWN_TITLE = "Release the write lock after each entry";
const LOCK = 5000001;
const LOOP = 5000002;
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const REPLIES = {
  summary: "Two replies.",
  replies: [
    {
      thread: LOCK,
      action: "reply",
      body: "The caller releases the lock, so the loop needs no change.",
      reason: "The caller releases the lock.",
      evidenceStatus: "code",
      judgement: "invalid",
    },
    {
      thread: LOOP,
      action: "reply",
      body: "Good point. I add the lock order.",
      reason: "The order is not noted.",
      evidenceStatus: "code",
      judgement: "valid",
    },
  ],
  coverage: NO_COVERAGE,
};
const FIX_LOCK = {
  summary: "One fix.",
  threads: [{ thread: LOCK, fixed: true, reason: "Release the lock in a `finally` block." }],
  edits: [
    {
      thread: LOCK,
      path: "src/cache/flush.ts",
      old: "    write(entry);\n    lock.release();\n",
      new: "    try {\n      write(entry);\n    } finally {\n      lock.release();\n    }\n",
    },
  ],
  coverage: NO_COVERAGE,
};

test("a blocked clipboard shows the runner prompt in a field with the focus and the text selected", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { author: true });
  await page.locator("[data-row]", { hasText: OWN_TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(OWN_TITLE);
  await openThread(page, LOCK);

  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("blocked")) }));
  await thread(page, LOCK).getByRole("button", { name: "More for this thread" }).click();
  await page.getByRole("menuitem", { name: "Copy prompt for Claude Code" }).click();
  const field = thread(page, LOCK).getByRole("textbox", {
    name: "The clipboard is blocked here. The prompt is selected: press Ctrl+C to copy it.",
  });
  await expect(field).toBeFocused();
  await expect(field).toHaveJSProperty("readOnly", true);
  await expect(field).toHaveValue(/A reviewer commented on my pull request PROJ1\/sample-repo-4 #1004\./);
  expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart === el.value.length)).toBe(true);
  await expect(thread(page, LOCK)).toContainText("Open a terminal in your clone of PROJ1/sample-repo-4, run claude, and paste.");
  await expect(page.locator("[data-slot='toast']")).toHaveCount(0);
});

test("the outcome line follows the reply and the fix; a Not valid reply next to a ticked edit gets the conflict note and both actions", async ({
  page,
}) => {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { author: true });
  await page.locator("[data-row]", { hasText: OWN_TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(OWN_TITLE);

  await control("claude", { stream: "tree", replies: REPLIES });
  await expect(repliesButton(page)).toHaveAccessibleName("Draft replies, 2 threads");
  await repliesButton(page).click();
  await expect(runRow(page, "reply")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  for (const id of [LOCK, LOOP]) await openThread(page, id);
  const lockLine = thread(page, LOCK).locator("[data-outcome]");
  // On my own PR a valid point is To fix. A not valid point is answered.
  await expect(lockLine).toHaveText("Outcome: Answered");
  await expect(thread(page, LOOP).locator("[data-outcome]")).toHaveText("Outcome: To fix");
  await expect(thread(page, LOCK).locator("[data-conflict]")).toHaveCount(0);

  // Fix in the footer of LOCK proposes one edit. The edit is ticked, so the note says that the reply and the fix disagree.
  await control("claude", { stream: "tree", fix: FIX_LOCK });
  await thread(page, LOCK).getByRole("button", { name: "Fix", exact: true }).click();
  const list = page.getByRole("dialog", { name: "Fix comments on your pull request" });
  await list.getByRole("button", { name: "Propose fixes for 1" }).click();
  await expect(list).toBeHidden();
  const fixCard = thread(page, LOCK).locator("[data-fix]");
  await expect(fixCard).toContainText("Proposed fix, 1 edit", { timeout: RUN_MS });
  await expect(lockLine).toHaveText("Outcome: Fix proposed");
  const note = thread(page, LOCK).getByRole("note", { name: "The reply and the fix disagree" });
  await expect(note).toContainText("The reply draft says the comment is not valid, but 1 edit is ticked for Apply.");
  await expect(note).toContainText("Keep the reply unticks the edit, so Apply leaves it out. Keep the fix discards the reply draft.");
  // The note sits between the outcome line and the cards.
  const order = await thread(page, LOCK)
    .locator("[data-outcome], [data-conflict], [data-reply-draft], [data-fix]")
    .evaluateAll((els) =>
      els.map((e) =>
        e.hasAttribute("data-outcome")
          ? "outcome"
          : e.hasAttribute("data-conflict")
            ? "note"
            : e.hasAttribute("data-fix")
              ? "fix"
              : "reply",
      ),
    );
  expect(order).toEqual(["outcome", "note", "reply", "fix"]);

  // Keep the reply: the edit is unticked, the bar has nothing to apply, the reply states the outcome, and the fix card has the focus.
  const box = fixCard.getByRole("checkbox", { name: /^Include in apply src\/cache\/flush\.ts/ });
  await note.getByRole("button", { name: "Keep the reply" }).click();
  await expect(box).not.toBeChecked();
  await expect(note).toHaveCount(0);
  await expect(page.locator("[data-fixbar]")).toHaveCount(0);
  await expect(lockLine).toHaveText("Outcome: Answered");
  await expect(page.locator(`#fx-${LOCK}`)).toBeFocused();
  await expect(page.locator("p[role='status'].sr-only")).toContainText("Unticked 1 edit. Apply leaves it out.");

  // A tick brings the note back. Keep the fix discards the reply, and the proposal states the outcome.
  await box.check();
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: "Keep the fix" }).click();
  await expect(note).toHaveCount(0);
  await expect(card(page, LOCK)).toContainText("Discarded reply draft");
  await expect(lockLine).toHaveText("Outcome: Fix proposed");
  await expect(box).toBeChecked();
  expect(await writes()).toEqual([]);
});
