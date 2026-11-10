// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// PR notes (docs/plans/review-v2/spec.md section 2.7, AC-P12): add a note, Keep a suggestion on a draft card, edit a note, delete it
// and Undo, with the focus moves and the live region words of the spec. Runs against serve.ts only: the fake Bitbucket, a temp git
// remote, and the fake Claude Code CLI, which proposes one note with its echo reply (tests/support/fake-claude.ts echoReplies).
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;
// control("state", { turns: 1 }): my general comment 1000101 with a reply by another user, so it is my turn.
const THREAD = 1000101;
const SUGGESTION = "Keep the flush order in one batch.";

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      context.on("weberror", (e) => seen.logs.push(e.error().message));
      await control("reset");
      await use(seen);
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN))).toEqual([]);
      expect(seen.logs.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l))).toEqual([]);
    },
    { auto: true },
  ],
});

const row = (page: Page) => page.locator("[data-row]", { hasText: TITLE }).first();
const notes = (page: Page) => page.locator("#s-notes");
const said = (page: Page, text: string) => page.getByRole("status").filter({ hasText: new RegExp(`^${text.replace(".", "\\.")}$`) });
const focused = (page: Page) => page.locator(":focus");

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { turns: 1 });
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

// WCAG 2.5.8: every target of the block is at least 24 by 24 px.
async function targets(page: Page) {
  for (const b of await notes(page).locator("button").all()) {
    const box = await b.boundingBox();
    expect(box && box.height >= 24 && box.width >= 24, `${await b.innerText()} is at least 24 by 24 px`).toBe(true);
  }
}

test("AC-P12: add a note, keep a suggestion on the draft card, edit, delete, and undo, with the focus moves of the spec", async ({
  page,
}) => {
  await control("claude", { stream: "tree", notes: [{ text: SUGGESTION, thread: THREAD, pr: null }] });
  await connect(page);
  const block = notes(page);
  await expect(block).toContainText("Notes for this PR. Claude reads them before each run.");
  // The block sits after the description in the tab order.
  expect(await page.evaluate(() => !!document.querySelector("#s-overview ~ #s-notes"))).toBe(true);
  await targets(page);

  // Add a note: Esc closes the box and gives the focus back to the button.
  const add = block.getByRole("button", { name: "Add a note" });
  await add.click();
  await expect(block.getByLabel("Note", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(block.getByLabel("Note", { exact: true })).toBeHidden();
  await expect(add).toBeFocused();
  await add.click();
  await block.getByLabel("Note", { exact: true }).fill("No retry in the client.");
  // No length limit and no counter.
  await expect(block.getByLabel("Note", { exact: true })).not.toHaveAttribute("maxlength");
  await expect(block).not.toContainText("characters");
  await page.keyboard.press("Control+Enter");
  await expect(said(page, "Note saved.")).toHaveCount(1);
  await expect(block.locator("li").filter({ hasText: "No retry in the client." })).toHaveCount(1);
  await expect(block.getByRole("button", { name: "Add a note" })).toBeFocused();

  // Draft replies: the reply run proposes a note for my thread. The card and the block show the same suggestion.
  await page.locator("#replies-btn").click();
  const card = page.locator(`#t-${THREAD} [data-reply-draft]`);
  await expect(card.locator("[data-note-suggestion]")).toContainText(`Claude suggests a note: ${SUGGESTION}`, { timeout: RUN_MS });
  await expect(block.getByRole("heading", { name: "Claude suggests" })).toBeVisible();
  await expect(block).toContainText("Claude does not use a suggestion until you keep it.");
  await expect(block).toContainText("From your thread");
  await targets(page);

  // Keep on the card: the block lists it as kept, and the card keeps the focus.
  await card.locator("[data-note-suggestion]").getByRole("button", { name: "Keep" }).click();
  await expect(said(page, "Note kept.")).toHaveCount(1);
  await expect(card.locator("[data-note-suggestion]")).toHaveCount(0);
  await expect(block.getByRole("heading", { name: "Claude suggests" })).toHaveCount(0);
  const kept = block.locator("li").filter({ hasText: SUGGESTION });
  await expect(kept).toContainText("Kept from Claude's suggestion");
  await expect(focused(page)).toHaveAttribute("id", /^rd-/);

  // Edit the first note.
  const first = block.locator("li").filter({ hasText: "No retry in the client." });
  await first.getByRole("button", { name: "Edit" }).click();
  const box = block.getByLabel("Note", { exact: true });
  await expect(box).toBeFocused();
  await box.fill("No retry in the client. Callers retry.");
  await block.getByRole("button", { name: "Save" }).click();
  await expect(said(page, "Note saved.")).toHaveCount(1);
  const edited = block.locator("li").filter({ hasText: "No retry in the client. Callers retry." });
  await expect(edited).toHaveCount(1);
  await expect(edited.getByRole("button", { name: "Edit" })).toBeFocused();

  // Delete asks no confirm. The row offers Undo, which holds the focus.
  await edited.getByRole("button", { name: "Delete" }).click();
  await expect(said(page, "Note deleted.")).toHaveCount(1);
  const undo = block.getByRole("button", { name: "Undo" });
  await expect(block).toContainText("Note deleted.");
  await expect(undo).toBeFocused();
  await targets(page);
  await undo.click();
  await expect(block.locator("li").filter({ hasText: "No retry in the client. Callers retry." })).toHaveCount(1);
  await expect(block.getByRole("button", { name: "Undo" })).toHaveCount(0);
});
