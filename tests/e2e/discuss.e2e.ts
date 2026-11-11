// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Discuss a finding in the browser (docs/plans/review-v2/spec.md section 2.1; AC-D3, AC-D4, AC-D6, AC-D7, AC-D9; AC-UX1, AC-UX3, AC-UX7,
// AC-UX10 for the talk): t and the link open the talk with the focus in its box, Esc gives the focus back, one primary button, the
// running state with Cancel, the slot line, the kept, changed, and withdrawn answers, Use the new text and Keep mine, Restore, the
// talk under the thread of a posted finding with its reply draft, and the 20-message cap. Runs against serve.ts only: the fake
// Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp, writes } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;
// tests/support/review-fixture.ts REVIEW_RESULT: the blocker on flush.ts line 3.
const LOCK = "The lock now covers one entry at a time. Another writer can run between two entries. Take the lock once, before the loop.";
const MESSAGE = "evict() holds the cache lock already. Is this still a blocker?";
const NO_COVERAGE = { read: ["src/cache/flush.ts"], skipped: [], unavailable: [], notChecked: [] };
const NEW_BODY =
  "The lock covers one entry at a time. The timer runs `flush()` without the cache lock, so a writer can run between two entries.";
const REVISED = {
  answer: "You are right about `evict()`. The timer path calls `flush()` without the lock, so the point stays at a lower severity.",
  verdict: "revised",
  reason: "The timer path still has no lock.",
  revision: { severity: "major", title: "A writer can run between two entries", body: NEW_BODY },
  reply: "",
  coverage: NO_COVERAGE,
};
const WITHDRAWN = {
  answer: "The timer takes the cache lock in `tick()` before it calls `flush()`. No writer can run between two entries.",
  verdict: "withdrawn",
  reason: "Every caller holds the cache lock",
  revision: null,
  reply: "",
  coverage: NO_COVERAGE,
};
const FULL = "This talk has reached 100 messages. Start a new review for a fresh look.";

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
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

const runRow = (page: Page, kind = "review") => page.locator(`#runline [data-run-kind='${kind}']`);
const blocker = (page: Page) => page.locator("[data-draft]").filter({ hasText: LOCK });
// The one live region of the detail.
const status = (page: Page) => page.locator("p[role='status'].sr-only");

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

// Shift+R opens the brief, Ctrl+Enter starts the review. Returns the ID of the blocker finding.
async function reviewed(page: Page): Promise<number> {
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(blocker(page)).toHaveCount(1);
  return Number(await blocker(page).getAttribute("data-draft"));
}

const talkOf = (page: Page, id: number) => ({
  talk: page.locator(`#talk-${id}`),
  box: page.locator(`#talk-${id}-box`),
  link: page.locator(`#talk-link-${id}`),
  turns: page.locator(`#talk-${id} [data-turn]`),
});

async function ask(page: Page, id: number, message: string) {
  const { box } = talkOf(page, id);
  await box.fill(message);
  await box.press("Control+Enter");
}

test("t opens the talk with the focus in its box; Esc gives the focus back to the link; a kept point changes nothing", async ({ page }) => {
  await control("claude", { stream: "tree" });
  await connect(page);
  const id = await reviewed(page);
  const { talk, box, link, turns } = talkOf(page, id);

  // AC-D9: t on the focused finding opens the talk under the card with the focus in its box. One primary button: Ask.
  await page.keyboard.press("2");
  await expect(blocker(page)).toBeFocused();
  await page.keyboard.press("t");
  await expect(box).toBeFocused();
  await expect(box).toHaveAccessibleName("Ask why, push back, or add context");
  await expect(box).toHaveAttribute("placeholder", "Ask why, push back, or add context…");
  await expect(talk.locator("[data-primary]")).toHaveCount(1);
  await expect(talk.locator("[data-primary]")).toHaveText("Ask");
  await expect(link).toHaveAttribute("aria-expanded", "true");
  await expect(talk.locator(`#talk-${id}-help`)).toHaveText("Ctrl+Enter asks. Esc closes the talk.");

  // Esc closes only the talk. The focus goes back to the link, and the detail stays.
  await page.keyboard.press("Escape");
  await expect(talk).toHaveCount(0);
  await expect(link).toBeFocused();
  await expect(link).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);

  // The link opens it again. The fake CLI echo keeps the point.
  await link.click();
  await expect(box).toBeFocused();
  await ask(page, id, MESSAGE);
  await expect(turns).toHaveCount(1);
  await expect(turns.first()).toContainText(MESSAGE);
  await expect(status(page)).toHaveText("Asked. Claude is reading the code.");
  await expect(turns.first().locator("[data-verdict='upheld']")).toHaveText("Claude keeps this point", { timeout: RUN_MS });
  await expect(turns.first()).toContainText(`Echo: ${MESSAGE}`);
  await expect(turns.first()).toContainText("Echo: the code still shows the problem.");
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await expect(talk.locator(`#talk-${id}-help`)).toHaveText("Ctrl+Enter asks. Esc closes the talk. 99 messages left.");
  await expect(blocker(page).locator("[data-revision]")).toHaveCount(0);
  await expect(blocker(page)).toHaveAccessibleName(/^Draft from Claude\. Blocker\. flush\.ts:3\./);

  // The talk stays after a close: t on the card opens it with its turns.
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await page.keyboard.press("t");
  await expect(box).toBeFocused();
  await expect(turns).toHaveCount(1);
});

test("a running turn says who works and since when, with Cancel; another start names the run that holds the slot", async ({ page }) => {
  await control("claude", { stream: "tree" });
  await connect(page);
  const id = await reviewed(page);
  const { talk, turns } = talkOf(page, id);
  await control("claude", { stream: "tree", hang: true });
  await talkOf(page, id).link.click();
  await ask(page, id, MESSAGE);
  await expect(turns.first()).toContainText("Claude is reading the code.");
  await expect(turns.first()).toContainText(/Started \d+ s ago\./);

  // AC-UX7: the refused start names the cause in one sentence, with one button that opens the run.
  await ask(page, id, "And the second caller?");
  const refused = talk.locator("[data-talk-refused]");
  await expect(refused).toHaveText(/Another run is working: Ask about a finding of this pull request\. Ask again when it ends\./);
  await refused.getByRole("button", { name: "Open it" }).click();
  await expect(page.getByRole("dialog", { name: "Ask about a finding run log" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ask about a finding run log" })).toHaveCount(0);

  // Cancel ends the turn. Ask again sends the same message once more.
  await turns.first().getByRole("button", { name: "Cancel" }).click();
  await expect(turns.first()).toContainText("You cancelled this message.", { timeout: RUN_MS });
  await control("claude", { stream: "tree" });
  await turns.first().getByRole("button", { name: "Ask again" }).click();
  await expect(turns).toHaveCount(2);
  await expect(turns.nth(1).locator("[data-verdict='upheld']")).toBeVisible({ timeout: RUN_MS });
  await expect(turns.nth(1)).toContainText(MESSAGE);
  // The text that the refused start left stays in the box.
  await expect(talkOf(page, id).box).toHaveValue("And the second caller?");
});

test("a changed point: the card shows the word diff; Use the new text makes it the finding; Keep mine drops a later one", async ({
  page,
}) => {
  await control("claude", { stream: "tree", discuss: REVISED });
  await connect(page);
  const id = await reviewed(page);
  const { turns } = talkOf(page, id);
  const card = page.locator(`#d-${id}`);
  await page.keyboard.press("2");
  await page.keyboard.press("t");
  await ask(page, id, MESSAGE);
  await expect(turns.first().locator("[data-verdict='revised']")).toHaveText("Claude changed this point", { timeout: RUN_MS });
  await expect(turns.first().locator("[data-talk-outcome]")).toHaveText("The new text waits on the card. Use it, or keep your text.");

  // AC-D3: the finding keeps its text. The new text waits as a word diff with the two choices.
  const rev = card.locator("[data-revision]");
  await expect(rev).toContainText("Claude changed this point");
  await expect(rev.locator("[data-diff-severity] del")).toHaveText("Blocker");
  await expect(rev.locator("[data-diff-severity] ins")).toHaveText("Major");
  await expect(rev.locator("[data-diff-title] ins")).toHaveText("A writer can run between two entries");
  await expect(rev.locator("[data-diff] ins").first()).toBeVisible();
  await expect(card).toContainText(LOCK);
  await expect(card).toHaveAccessibleName(/^Draft from Claude\. Blocker\. flush\.ts:3\./);

  await rev.getByRole("button", { name: "Use the new text" }).click();
  await expect(rev).toHaveCount(0);
  await expect(card).toBeFocused();
  await expect(status(page)).toHaveText("The new text is the finding now. Accept it to post.");
  await expect(card).toHaveAccessibleName(/^Draft from Claude\. Major\. flush\.ts:3\./);
  await expect(card).toContainText("The timer runs flush() without the cache lock");
  await expect(card.locator("[data-row-head]")).toContainText("A writer can run between two entries");
  // The outcome line of the turn follows the card: the new text no longer waits.
  await expect(turns.first().locator("[data-talk-outcome]")).toHaveCount(0);

  // A second change and Keep mine: the new text goes, the finding stays as it is.
  await control("claude", {
    stream: "tree",
    discuss: { ...REVISED, revision: { ...REVISED.revision, body: "A different text that you do not want." } },
  });
  await card.locator(`#talk-${id}-box`).focus();
  await ask(page, id, "Say it shorter.");
  await expect(turns.nth(1).locator("[data-verdict='revised']")).toBeVisible({ timeout: RUN_MS });
  await expect(rev.locator("[data-diff] ins")).toContainText("you do not want");
  await rev.getByRole("button", { name: "Keep mine" }).click();
  await expect(rev).toHaveCount(0);
  await expect(status(page)).toHaveText("Kept your text. The new text is gone.");
  await expect(card).toContainText("The timer runs flush() without the cache lock");
  await expect(card).not.toContainText("you do not want");
});

test("a withdrawn point moves to the discarded drafts with its reason; Restore brings it back and keeps the mark", async ({ page }) => {
  await control("claude", { stream: "tree", discuss: WITHDRAWN });
  await connect(page);
  const id = await reviewed(page);
  const { talk, turns } = talkOf(page, id);
  const card = page.locator(`#d-${id}`);
  await page.keyboard.press("2");
  await page.keyboard.press("t");
  await ask(page, id, MESSAGE);
  await expect(turns.first().locator("[data-verdict='withdrawn']")).toHaveText("Claude withdrew this point", { timeout: RUN_MS });

  // AC-D4: the finding is discarded with the mark. The talk stays open under the card.
  await expect(card).toHaveAccessibleName("Draft, withdrawn. flush.ts:3.");
  await expect(card.locator("[data-row-head]")).toContainText("Withdrawn");
  await expect(card.locator("[data-withdrawn]")).toHaveText("Withdrawn after your talk: Every caller holds the cache lock.");
  await expect(turns.first().locator("[data-talk-outcome]")).toHaveText(
    "The finding moved to the discarded drafts. Restore brings it back.",
  );
  await expect(talk).toBeVisible();

  await card.getByRole("button", { name: "Restore" }).click();
  await expect(card).toHaveAccessibleName(/^Draft from Claude\. Blocker\. flush\.ts:3\./);
  await expect(card.locator("[data-withdrawn]")).toHaveText(
    "Withdrawn after your talk: Every caller holds the cache lock. You restored it.",
  );
  await expect(status(page)).toHaveText("Restored.");
});

test("a posted finding: More opens the talk under its thread; the answer makes a reply draft there, and nothing posts", async ({
  page,
}) => {
  await control("claude", { stream: "tree" });
  await connect(page);
  const id = await reviewed(page);
  await blocker(page).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Ready to post: 1 inline comment")).toBeVisible();
  await page.keyboard.press("p");
  const box = page.getByRole("dialog", { name: "Post 1 inline comment to PROJ1/sample-repo-2 #1001?" });
  await box.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.locator("[data-post]", { hasText: "Posted." })).toHaveCount(1);
  // The next sync brings the posted comment as a thread.
  await control("state", {});
  const thread = page.locator("[data-thread]").filter({ hasText: LOCK });
  await expect(thread).toHaveCount(1);
  const tid = await thread.getAttribute("data-thread");
  const head = page.locator(`#th-${tid}`);
  await expect(async () => {
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
  const sent = await writes();

  await control("claude", {
    stream: "tree",
    discuss: { ...WITHDRAWN, reply: "You are right. The timer takes the lock in `tick()`, so I withdraw this point." },
  });
  const more = thread.getByRole("button", { name: "More for this thread" });
  await more.click();
  await page.getByRole("menuitem", { name: "Ask Claude about this comment" }).click();
  const { talk, turns } = talkOf(page, id);
  await expect(talkOf(page, id).box).toBeFocused();
  await expect(thread.locator(`#talk-${id}`)).toHaveCount(1);
  await ask(page, id, MESSAGE);
  await expect(turns.first().locator("[data-verdict='withdrawn']")).toBeVisible({ timeout: RUN_MS });

  // AC-D7: one reply draft from the talk, with the resolve tick on my own thread. Nothing posts.
  const card = thread.locator("[data-reply-draft]");
  await expect(card).toContainText("from your talk with Claude");
  await expect(card).toContainText("You are right. The timer takes the lock in tick(), so I withdraw this point.");
  await expect(card.getByLabel("Resolve after posting")).toBeChecked();
  await expect(turns.first().locator("[data-talk-outcome]")).toContainText(
    "Claude drafted a reply in this thread. Nothing posts until you accept it.",
  );
  await turns.first().getByRole("button", { name: "Go to the draft" }).click();
  await expect(card).toBeFocused();
  expect(await writes()).toEqual(sent);

  // Esc in the talk gives the focus back to More.
  await talkOf(page, id).box.focus();
  await page.keyboard.press("Escape");
  await expect(talk).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("the cap: after 100 messages the box gives way to one sentence, and the server refuses the 101st", async ({ page }) => {
  test.setTimeout(1_200_000);
  await control("claude", { stream: "tree" });
  await connect(page);
  const id = await reviewed(page);
  // 100 turns through the app API, one run at a time. Each wait is bounded.
  const last = await page.evaluate(async (item) => {
    const session = document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "";
    const headers = { "X-RL-Session": session, "Content-Type": "application/json" };
    const get = async (url: string) => (await fetch(url, { headers })).json();
    const runs = (await get("/api/runs")) as { id: number; kind: string }[];
    const review = runs.find((r) => r.kind === "review");
    const detail = (await get(`/api/runs/${review?.id}`)) as { items: { id: number; revision: number }[] };
    const revision = detail.items.find((x) => x.id === item)?.revision;
    const pause = () => new Promise((r) => setTimeout(r, 100));
    const post = (message: string) =>
      fetch(`/api/items/${item}/discuss`, { method: "POST", headers, body: JSON.stringify({ message, revision }) });
    for (let i = 1; i <= 100; i++) {
      let res = await post(`Message ${i}`);
      // The slot frees a moment after the run ends.
      for (let k = 0; res.status === 409 && k < 100; k++) {
        await pause();
        res = await post(`Message ${i}`);
      }
      if (res.status !== 202) return { status: res.status, body: await res.text(), at: i };
      for (let k = 0; k < 600; k++) {
        const turns = (await get(`/api/items/${item}/discuss`)) as { status: string }[];
        if (turns.at(-1)?.status !== "running") break;
        await pause();
      }
    }
    let res = await post("Message 101");
    for (let k = 0; res.status === 409 && (await res.clone().text()).includes('"running"') && k < 100; k++) {
      await pause();
      res = await post("Message 101");
    }
    return { status: res.status, body: await res.text(), at: 101 };
  }, id);
  expect(last).toEqual({ status: 409, body: JSON.stringify({ error: FULL }), at: 101 });

  // The talk opens with the cap line instead of the box. Its first control takes the focus.
  const { talk, turns } = talkOf(page, id);
  await page.keyboard.press("2");
  await page.keyboard.press("t");
  await expect(turns).toHaveCount(100);
  await expect(talk.locator("[data-talk-full]")).toContainText(FULL);
  await expect(talk.getByRole("textbox")).toHaveCount(0);
  await expect(talk.locator("[data-primary]")).toHaveCount(0);
  const brief = talk.getByRole("button", { name: "Open the review brief" });
  await expect(brief).toBeFocused();
  await brief.click();
  await expect(page.locator("#brief")).toBeVisible();
});
