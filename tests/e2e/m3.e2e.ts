// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// M3 browser acceptance (plan v3 WP14a): triage, the post confirm, the outbox states, and replies.
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, MARK, openApp, posts } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
// A run passes the git workspace, the fake CLI, and the validator.
const RUN_MS = 60_000;
// tests/support/review-fixture.ts REVIEW_RESULT: the exact and the moved finding on src/cache/flush.ts.
const LOCK = "The lock now covers one entry at a time. Another writer can run between two entries. Take the lock once, before the loop.";
const RELEASE = "`lock.release()` does not run when `write()` throws. Release the lock in a `finally` block.";
// PR 1001: my general comment 1000003 with my reply 1000001 (activities-nested-reply.json).
const ROOT = 1000003;

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
const confirmBox = (page: Page) => page.getByRole("dialog", { name: /^Post .* to PROJ1\/sample-repo-2 #1001\?$/ });
const postButton = (box: Locator) => box.getByRole("button", { name: "Post", exact: true });
const thread = (page: Page) => page.locator(`#t-${ROOT}`);
const replyBox = (page: Page) => thread(page).getByRole("textbox", { name: /^Reply to / });

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await open(page);
}

async function open(page: Page) {
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

// Shift+R opens the brief. Ctrl+Enter starts the review. The fake CLI gives 3 drafts and 1 question. The README nit waits in the
// More fold between the findings and the question (docs/plans/review-v2/spec.md section 1.4). The fold opens here, so the
// tests triage all 3 drafts.
async function reviewed(page: Page) {
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").fill("ABC-1: check the lock scope.");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(page.locator("#runline [data-run-kind='review']")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(drafts(page)).toHaveCount(2);
  await page.getByRole("button", { name: "More (1)" }).click();
  await expect(drafts(page)).toHaveCount(3);
}

// A sync can open the thread between the read and the click, so the click repeats until the thread stays open.
async function openThread(page: Page) {
  const head = page.locator(`#th-${ROOT}`);
  await expect(async () => {
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
}

async function startReply(page: Page, text: string) {
  await openThread(page);
  await thread(page).getByRole("button", { name: "Write a reply" }).click();
  await expect(replyBox(page)).toBeFocused();
  await replyBox(page).fill(text);
}

test("A8: two of the drafts are accepted, and exactly those two texts post after the confirm", async ({ page }) => {
  await connect(page);
  await reviewed(page);
  // Accept moves the focus to the next untriaged draft, so the keys a and d triage the rest.
  await drafts(page).nth(0).getByRole("button", { name: "Accept" }).click();
  await expect(drafts(page).nth(1)).toBeFocused();
  await page.keyboard.press("a");
  await expect(drafts(page).nth(2)).toBeFocused();
  await page.keyboard.press("d");
  await expect(drafts(page).nth(2)).toHaveAccessibleName("Discarded draft. README.md:1.");
  await expect(drafts(page).nth(2).locator("[data-row-head]")).toContainText(
    "The README does not name the flush order.README.md:1Discarded",
  );
  // The question follows the findings in the same list. The focus and the open row go on to it.
  const question = page.locator("[data-draft-question]");
  await expect(question).toBeFocused();
  await question.getByRole("button", { name: "Discard" }).click();
  await expect(question).toHaveAccessibleName("Discarded question");
  await expect(question.locator("[data-row-head]")).toContainText("Must flush() stay atomic for readers?Discarded");
  await expect(page.getByText("Ready to post: 2 inline comments")).toBeVisible();
  await expect(page.locator("#nav-post")).toHaveAccessibleName("Ready to post: 1");

  // Esc closes the confirm, and nothing posts.
  await page.keyboard.press("p");
  const box = confirmBox(page);
  await expect(box).toHaveAccessibleName("Post 2 inline comments to PROJ1/sample-repo-2 #1001?");
  await expect(postButton(box)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  await expect(page.locator("#post-btn")).toBeFocused();
  expect(await posts()).toEqual([]);

  // The confirm shows the destination and the exact text of each comment.
  await page.keyboard.press("p");
  const items = box.getByRole("list", { name: "Comments to post" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("flush.ts:3");
  await expect(items.nth(0)).toContainText("Inline comment");
  await expect(items.nth(0)).toContainText(LOCK);
  // The default markSeverity setting starts each finding with its severity in bold.
  await expect(items.nth(0).locator("strong", { hasText: "Blocker:" })).toHaveCount(1);
  await expect(items.nth(1)).toContainText("flush.ts:5");
  await postButton(box).click();
  await expect(box).toBeHidden();
  await expect(page.locator("[data-post]", { hasText: "Posted." })).toHaveCount(2);
  // Plan v3 WP13b: a posted row links to its comment on the PR link of the server.
  const link = (id: number) => `${FAKE_URL}/projects/PROJ1/repos/sample-repo-2/pull-requests/1001/overview?commentId=${id}`;
  await expect(page.locator(`[data-post] a[href="${link(4_000_001)}"], [data-post] a[href="${link(4_000_002)}"]`)).toHaveCount(2);
  await expect(drafts(page)).toHaveCount(1);
  await expect(page.locator("#nav-post")).toHaveAccessibleName("Ready to post: 0");

  const sent = await posts();
  expect(sent.map((b) => b.text)).toEqual([`${MARK}**Blocker:** ${LOCK}`, `${MARK}**Minor:** ${RELEASE}`]);
  expect(sent.map((b) => [b.anchor?.path, b.anchor?.line, b.parent])).toEqual([
    ["src/cache/flush.ts", 3, undefined],
    ["src/cache/flush.ts", 5, undefined],
  ]);

  // The next check brings the comments back as threads, so the outbox rows go away.
  await control("state", {});
  await expect(page.locator("[data-post]")).toHaveCount(0);
  const posted = page.locator("[data-thread]", { hasText: "flush.ts:" });
  await expect(posted).toHaveCount(2);
  await posted.first().locator("button[aria-expanded]").first().click();
  await expect(posted.first()).toContainText("Posted from a Claude Code review");
  await expect(posted.first().getByRole("link", { name: "Open this thread in Bitbucket" })).toHaveAttribute(
    "href",
    /\/overview\?commentId=400000[12]$/,
  );
});

test("the detail keys do nothing in the post confirm: q, w, d, and a leave the confirm open and the draft untriaged", async ({ page }) => {
  await connect(page);
  await reviewed(page);
  await drafts(page).nth(0).getByRole("button", { name: "Accept" }).click();
  await expect(drafts(page).nth(1)).toBeFocused();
  await page.keyboard.press("p");
  const box = confirmBox(page);
  await expect(postButton(box)).toBeFocused();
  for (const key of ["q", "w", "d", "a"]) {
    await page.keyboard.press(key);
    await expect(box).toBeVisible();
    await expect(postButton(box)).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  await expect(drafts(page).nth(1)).not.toHaveAccessibleName(/^(Discarded|Accepted)/);
  await expect(page.getByText("Ready to post: 1 inline comment")).toBeVisible();
  expect(await posts()).toEqual([]);
});

test("A9: the connection drops after Bitbucket accepts; the outcome is unknown, and Post again finds it with no second post", async ({
  page,
}) => {
  await connect(page);
  await reviewed(page);
  await drafts(page).nth(0).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Ready to post: 1 inline comment")).toBeVisible();
  // The POST is stored, then the connection drops. The check cannot read the comments yet.
  await posts({ drop: true, hide: true });
  await page.keyboard.press("p");
  await postButton(confirmBox(page)).click();
  const out = page.locator("[data-post]");
  await expect(out).toContainText("Outcome unknown.");
  await expect(out).toContainText(/Could not read (all|the) comments on Bitbucket/);
  await expect(out.getByRole("button", { name: "Drop" })).toBeVisible();
  expect(await posts({ hide: false })).toHaveLength(1);

  await out.getByRole("button", { name: "Post again" }).click();
  await expect(out).toContainText("Posted.");
  await expect(page.getByText("The comment is on Bitbucket already. Nothing was posted again.")).toBeVisible();
  expect(await posts()).toHaveLength(1);
});

test("a failed inline post shows the reason and moves to the general comment", async ({ page }) => {
  await connect(page);
  await reviewed(page);
  await drafts(page).nth(0).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Ready to post: 1 inline comment")).toBeVisible();
  await posts({ fail: 400 });
  await page.keyboard.press("p");
  await postButton(confirmBox(page)).click();
  const out = page.locator("[data-post]");
  await expect(out).toContainText("Failed.");
  await expect(out).toContainText("HTTP 400");
  await expect(out.getByRole("button", { name: "Retry" })).toBeVisible();
  await out.getByRole("button", { name: "Move to general comment" }).click();
  await expect(out).toHaveCount(0);
  await expect(page.getByText("Ready to post: 1 general comment")).toBeVisible();

  await page.keyboard.press("p");
  const box = confirmBox(page);
  await expect(box).toContainText("General comment");
  await expect(box).toContainText(`src/cache/flush.ts:3: Blocker: ${LOCK}`);
  await postButton(box).click();
  await expect(out).toContainText("Posted.");
  const sent = await posts();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.text).toBe(`${MARK}src/cache/flush.ts:3: **Blocker:** ${LOCK}`);
  expect(sent[0]?.anchor).toBeUndefined();
});

test("p right after Accept opens the confirm while the accept request is still out", async ({ page }) => {
  await connect(page);
  await reviewed(page);
  // A loaded machine: the accept answer comes 400 ms late, so p lands before it.
  await page.route("**/api/items/*", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await drafts(page).nth(0).getByRole("button", { name: "Accept" }).click();
  await page.keyboard.press("p");
  const box = confirmBox(page);
  await expect(box).toHaveAccessibleName("Post 1 inline comment to PROJ1/sample-repo-2 #1001?");
  await expect(page.getByText("Nothing is accepted yet. Accept drafts, questions, or replies first.")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(box).toBeHidden();
  expect(await posts()).toEqual([]);
});

// Plan pr-view-v4 section 5: a triage edit keeps its text when the PR closes. A click on the PR or Back opens the editor again.
test("an unsent triage edit survives a change of PR and Back; Save and Cancel clear it", async ({ page }) => {
  await connect(page);
  await reviewed(page);
  const other = page.locator("[data-row]", { hasText: "Drop the legacy export endpoint" }).first();
  const h1 = page.locator("section[aria-label='Details'] h1");
  const edit = page.getByRole("textbox", { name: "Edit the finding" });
  const stored = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("rl:edit:")));
  // The Reviewing view holds this PR and PR 77.
  await page.getByRole("button", { name: /^Reviewing/ }).click();
  await drafts(page).nth(0).getByRole("button", { name: "Edit" }).click();
  await expect(edit).toBeFocused();
  await edit.fill(`${LOCK} Unsent edit.`);

  // Another PR, then this one again: the editor is open with the text. It leaves the focus where it is.
  await other.click();
  await expect(h1).toHaveText("Drop the legacy export endpoint");
  await row(page).click();
  await expect(h1).toHaveText(TITLE);
  await expect(edit).toHaveValue(`${LOCK} Unsent edit.`);
  await expect(edit).not.toBeFocused();
  // Back from another PR does the same.
  await other.click();
  await expect(h1).toHaveText("Drop the legacy export endpoint");
  await page.goBack();
  await expect(h1).toHaveText(TITLE);
  await expect(edit).toHaveValue(`${LOCK} Unsent edit.`);

  // Save posts nothing. It accepts the new text and clears the stored text.
  await drafts(page).nth(0).getByRole("button", { name: "Save and accept" }).click();
  await expect(edit).toHaveCount(0);
  await expect(drafts(page).nth(0).locator("[data-row-head]")).toContainText("Unsent edit.");
  await expect(drafts(page).nth(0).locator("[data-row-head]")).toContainText("Accepted");
  expect(await stored()).toEqual([]);

  // Cancel clears the text too, so the next visit opens no editor.
  const minor = page.getByRole("textbox", { name: "Edit the finding" });
  await expect(drafts(page).nth(1)).toBeFocused();
  await page.keyboard.press("e");
  await expect(minor).toBeFocused();
  await minor.fill("A text that I cancel.");
  expect(await stored()).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(minor).toHaveCount(0);
  expect(await stored()).toEqual([]);
  await other.click();
  await expect(h1).toHaveText("Drop the legacy export endpoint");
  await row(page).click();
  await expect(h1).toHaveText(TITLE);
  // The PR opens again with its fold closed.
  await expect(drafts(page)).toHaveCount(2);
  await expect(page.getByRole("textbox", { name: /^Edit the / })).toHaveCount(0);
  expect(await posts()).toEqual([]);
});

test("two pages confirm the same items, and only one post goes out (A14)", async ({ page, context }) => {
  await connect(page);
  await reviewed(page);
  await drafts(page).nth(0).getByRole("button", { name: "Accept" }).click();
  const other = await context.newPage();
  await other.goto("/");
  await open(other);
  await expect(other.getByText("Ready to post: 1 inline comment")).toBeVisible();
  for (const p of [page, other]) {
    await p.keyboard.press("p");
    await expect(postButton(confirmBox(p))).toBeFocused();
  }
  await postButton(confirmBox(page)).click();
  await expect(page.locator("[data-post]")).toContainText("Posted.");
  await postButton(confirmBox(other)).click();
  await expect(other.getByText("These comments were posted from another page already. Nothing was posted again.")).toBeVisible();
  await expect(other.locator("[data-post]")).toContainText("Posted.");
  expect(await posts()).toHaveLength(1);
});

test("a reply round trip: preview, confirm with the destination, post, and the reply comes back read", async ({ page }) => {
  const text = "Thanks. **Fixed** in the next commit.";
  await connect(page);
  await startReply(page, text);
  await thread(page).getByRole("button", { name: "Preview" }).click();
  await expect(thread(page).locator("strong", { hasText: "Fixed" })).toBeVisible();
  await thread(page).getByRole("button", { name: "Preview" }).click();
  await replyBox(page).press("Control+Enter");
  const box = thread(page).getByRole("dialog", { name: "Post this reply to your message?" });
  await expect(box).toContainText("Reply to your message in the general comment");
  await expect(box.locator("strong", { hasText: "Fixed" })).toBeVisible();
  await postButton(box).click();
  const out = thread(page).locator("[data-post]");
  await expect(out).toContainText("Posted.");
  await expect(thread(page).getByRole("button", { name: "Write a reply" })).toBeVisible();
  expect(await posts()).toMatchObject([{ text, parent: { id: 1000001 } }]);

  await control("state", {});
  await expect(out).toHaveCount(0);
  const mine = thread(page).locator("article.rl-msg", { hasText: "in the next commit" });
  await expect(mine).toBeVisible();
  await expect(mine).not.toHaveAttribute("data-new");
});

test("new messages after the confirm opened give 409: the page says so, and the second confirm posts once", async ({ page }) => {
  const text = "Looks good to me now.";
  await connect(page);
  await control("state", { reply: "new" });
  await expect(thread(page)).toHaveAttribute("aria-label", /^Your turn\./);
  await startReply(page, text);
  await replyBox(page).press("Control+Enter");
  const box = thread(page).getByRole("dialog");
  await expect(postButton(box)).toBeFocused();
  // Another reply arrives while the confirm is open. The thread stays in the same group.
  await control("state", { reply: "two" });
  await expect(page.locator("#c-1000011")).toBeVisible();
  await postButton(box).click();
  await expect(thread(page).getByRole("alert")).toHaveText("New messages arrived in this thread. Read them, then post your reply again.");
  await expect(replyBox(page)).toHaveValue(text);
  expect(await posts()).toEqual([]);

  await replyBox(page).press("Control+Enter");
  await postButton(thread(page).getByRole("dialog")).click();
  await expect(thread(page).locator("[data-post]")).toContainText("Posted.");
  expect(await posts()).toMatchObject([{ text, parent: { id: 1000011 } }]);
});

test("an unsent reply survives a reload; Discard clears it", async ({ page }) => {
  const text = "A draft that survives a reload.";
  await connect(page);
  await startReply(page, text);
  await page.reload();
  await open(page);
  await openThread(page);
  await expect(replyBox(page)).toHaveValue(text);
  // Discard offers Undo, which gives the text back to the reply box.
  await thread(page).getByRole("button", { name: "Discard" }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(replyBox(page)).toHaveValue(text);
  await thread(page).getByRole("button", { name: "Discard" }).click();
  await page.reload();
  await open(page);
  await openThread(page);
  await expect(thread(page).getByRole("button", { name: "Write a reply" })).toBeVisible();
  expect(await posts()).toEqual([]);
});
