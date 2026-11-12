// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 UI-ASK and pr-view-v4 2.4 in the browser: q opens Ask in the panel slot, Ctrl+Enter asks, and the answer shows as safe
// Markdown. The slot holds the brief or Ask, one at a time.
// The answer is text only: no draft, no post, and no write request to the forge.
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp, posts, writes } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
// A run passes the git workspace, the fake CLI, and the result check.
const RUN_MS = 60_000;
const QUESTION = "Which callers of flush() are not updated?";
const SECOND = "Does the worker drop writes on shutdown?";
const COVERAGE = { read: ["src/cache/flush.ts"], skipped: [], unavailable: [], notChecked: [] };
// Raw HTML and a remote image must not render. The fixture check fails on any request outside the app.
const ANSWER =
  "## Callers\n\nBoth callers of `flush()` take the lock in **src/cache/worker.ts**.\n\n<b>raw</b> HTML stays out.\n\n![diagram](https://x.test/d.png)";

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
      // Every test: an ask sends nothing to the forge.
      expect(await writes()).toEqual([]);
      expect(await posts()).toEqual([]);
    },
    { auto: true },
  ],
});

const runLine = (page: Page) => page.locator("#runline");
// The row of the newest run of one kind. data-run-state: running, done, failed, limit, or cancelled.
const runRow = (page: Page, kind = "review") => page.locator(`#runline [data-run-kind='${kind}']`);
// Its label is "Your question", "Follow up", or "New question" (docs/plans/review-v2/spec.md section 2.14).
const box = (page: Page) => page.locator("#ask-q");
const answers = (page: Page) => page.locator("[data-ask]");
const conversations = (page: Page) => page.locator("#ask ol[data-conversation]");
const asked = (page: Page) => page.waitForRequest((r) => r.method() === "POST" && /\/api\/prs\/\d+\/ask$/.test(r.url()));
const slot = (page: Page) => page.locator("#ask");
const strip = (page: Page) => page.locator("nav[aria-label='Pull request summary']");
const askBtn = (page: Page) => page.locator("#ask-btn");
const runLog = (page: Page) => page.getByRole("dialog", { name: "Ask run log" });

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
  // The strip shows once the pull request data loads. Ask stays closed until q or the Ask button.
  await expect(strip(page).getByRole("button", { name: /file/i })).toBeVisible();
  await expect(slot(page)).toHaveCount(0);
}

test("q opens Ask in the slot, Ctrl+Enter asks, the answer is safe Markdown, and Log opens the log of that run", async ({ page }) => {
  await control("claude", { stream: "tree", answer: { answer: ANSWER, coverage: COVERAGE } });
  await connect(page);
  // The bottom Ask fold is gone.
  await expect(page.locator("#s-ask")).toHaveCount(0);
  await expect(askBtn(page)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("q");
  await expect(slot(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  await expect(page.getByRole("region", { name: "Ask Claude" })).toBeVisible();
  await expect(askBtn(page)).toHaveAttribute("aria-expanded", "true");
  // The slot sits under the strip, above the run record and the Description.
  const [s, b] = [await strip(page).boundingBox(), await slot(page).boundingBox()];
  expect((b?.y ?? 0) >= (s?.y ?? 0) + (s?.height ?? 0)).toBe(true);
  // Ask takes the place of the task chip row, as the brief does.
  await expect(page.locator("[data-task-chips='tk-runs']")).toHaveCount(0);

  await box(page).fill(QUESTION);
  await box(page).press("Control+Enter");
  await expect(box(page)).toHaveValue("");
  await expect(runRow(page, "ask")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(runRow(page, "ask")).toContainText("Answered");
  await expect(answers(page)).toHaveCount(1);

  const a = answers(page).first();
  await expect(a).toContainText(QUESTION);
  await expect(a.getByRole("status")).toContainText(/Claude answered on [0-9a-f]{7}/);
  await expect(a.getByRole("heading", { name: "Callers" })).toBeVisible();
  await expect(a.locator("strong")).toHaveText("src/cache/worker.ts");
  await expect(a.locator("b")).toHaveCount(0);
  await expect(a.locator("img")).toHaveCount(0);
  await expect(a.getByRole("link", { name: "diagram" })).toHaveAttribute("href", "https://x.test/d.png");
  // An answer is no draft and no question for the author.
  await expect(page.locator("[data-draft]")).toHaveCount(0);

  await a.getByRole("button", { name: "Log", exact: true }).click();
  await expect(runLog(page)).toBeVisible();
  await expect(runLog(page).locator("footer")).toContainText("Answered.");
  await page.keyboard.press("Escape");
  await expect(runLog(page)).toHaveCount(0);
  await expect(a.getByRole("button", { name: "Log", exact: true })).toBeFocused();

  // The second question follows up the first answer. The conversation shows its turns oldest first.
  await expect(page.getByLabel("Follow up")).toBeVisible();
  await box(page).fill(SECOND);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(answers(page)).toHaveCount(2);
  await expect(answers(page).first()).toContainText(QUESTION);
  await expect(answers(page).nth(1)).toContainText(SECOND);
  await expect(answers(page).nth(1).getByRole("status")).toContainText(/Claude answered on/, { timeout: RUN_MS });

  // Esc closes the slot and gives the focus back to the Ask button. Nothing says "Answering…" when no question runs.
  await box(page).focus();
  await page.keyboard.press("Escape");
  await expect(slot(page)).toHaveCount(0);
  await expect(askBtn(page)).toBeFocused();
  await expect(askBtn(page)).toHaveAttribute("aria-expanded", "false");
  await expect(strip(page).getByRole("button", { name: "Answering…" })).toHaveCount(0);
  // The Ask button opens and closes the slot. Close does what Esc does.
  await askBtn(page).click();
  await expect(box(page)).toBeFocused();
  await askBtn(page).click();
  await expect(slot(page)).toHaveCount(0);
  await page.keyboard.press("q");
  await slot(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(slot(page)).toHaveCount(0);
  await expect(askBtn(page)).toBeFocused();

  // One slot: Ask closes the brief, and the brief closes Ask.
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
  await page.locator("#review-btn").focus();
  await page.keyboard.press("q");
  await expect(box(page)).toBeFocused();
  await expect(page.locator("#brief")).toHaveCount(0);
  await page.locator("#review-btn").click();
  await expect(page.locator("#brief")).toBeVisible();
  await expect(slot(page)).toHaveCount(0);
});

test("a busy pull request keeps the typed question, also after a reload, and a running answer can be cancelled", async ({ page }) => {
  await control("claude", { stream: "tree", hang: true });
  await connect(page);
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").fill("Check the lock scope.");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });

  await page.keyboard.press("q");
  // AC-B196: Ask waits while a run works on this pull request, and Ctrl+Enter only says why.
  await expect(slot(page)).toContainText("Claude is reviewing this pull request. One run per pull request.");
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toHaveAttribute("aria-disabled", "true");
  await box(page).fill(QUESTION);
  await box(page).press("Control+Enter");
  await expect(page.getByText("The question was not sent")).toBeVisible();
  await expect(box(page)).toHaveValue(QUESTION);
  await expect(answers(page)).toHaveCount(0);
  // The unsent question stays in this browser.
  await page.reload();
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(strip(page).getByRole("button", { name: /file/i })).toBeVisible();
  await page.keyboard.press("q");
  await expect(box(page)).toHaveValue(QUESTION);

  await runLine(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toContainText(/Cancelled after \d+ tool calls?/, { timeout: RUN_MS });
  await box(page).press("Control+Enter");
  await expect(runLine(page)).toContainText("Answering…", { timeout: RUN_MS });
  const a = answers(page).first();
  await expect(a.getByRole("status")).toContainText("Answering…");
  // While Ask is open, the strip does not repeat it. A closed slot leaves "Answering…" in the strip, and it opens Ask again.
  const answering = strip(page).getByRole("button", { name: "Answering…" });
  await expect(answering).toHaveCount(0);
  await box(page).press("Escape");
  await expect(slot(page)).toHaveCount(0);
  await expect(answering).toBeVisible();
  await expect(answering).toHaveAttribute("aria-keyshortcuts", "q");
  await answering.click();
  await expect(box(page)).toBeFocused();
  await expect(answering).toHaveCount(0);
  await a.getByRole("button", { name: "Cancel" }).click();
  await expect(a.getByRole("status")).toContainText("You cancelled the question.", { timeout: RUN_MS });
  await expect(runRow(page, "ask")).toContainText(/Cancelled after \d+ tool calls?/);
  // spec.md section 2.14: the empty box gets the question of the cancelled newest turn, so one Ask sends it again as a follow-up.
  await expect(page.getByLabel("Follow up")).toHaveValue(QUESTION);
  await page.keyboard.press("Escape");
  await expect(slot(page)).toHaveCount(0);
  await expect(strip(page).getByRole("button", { name: "Answering…" })).toHaveCount(0);
});

// The live stream holds its messages while window.rlHold is set. release() sends them in their order.
type Held = Window & { rlHold?: (() => void)[] };
async function holdableLive(page: Page) {
  await page.addInitScript(() => {
    const w = window as Held;
    const add = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (
      this: EventSource,
      type: string,
      fn: EventListenerOrEventListenerObject | null,
      o?: boolean | AddEventListenerOptions,
    ) {
      const call = (e: Event) => (typeof fn === "function" ? fn.call(this, e) : fn?.handleEvent(e));
      add.call(this, type, (e: Event) => (w.rlHold ? w.rlHold.push(() => call(e)) : call(e)), o);
    } as typeof add;
  });
}
const hold = (page: Page) =>
  page.evaluate(() => {
    (window as Held).rlHold = [];
  });
const release = (page: Page) =>
  page.evaluate(() => {
    const w = window as Held;
    const held = w.rlHold ?? [];
    w.rlHold = undefined;
    for (const f of held) f();
  });
// The server state, not the page cache.
const slotsFree = (page: Page) =>
  page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "";
    const res = await fetch("/api/runs/slots", { headers: { "X-RL-Session": token } });
    return ((await res.json()) as { running: unknown[] }).running.length === 0;
  });

test("after Cancel, Ask is ready in the render where the run row shows the end, also before the live update", async ({ page }) => {
  await holdableLive(page);
  await control("claude", { stream: "tree", hang: true });
  await connect(page);
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").fill("Check the lock scope.");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
  await page.keyboard.press("q");
  const send = page.getByRole("button", { name: "Ask", exact: true });
  await expect(send).toHaveAttribute("aria-disabled", "true");
  await box(page).fill(QUESTION);

  // The live stream holds the run end. The run detail read after Cancel goes out only after the server freed the slot. So the run
  // row shows the end, and the slots in the page are still from before it.
  await hold(page);
  await page.route(
    /\/api\/runs\/\d+$/,
    async (route) => {
      await expect.poll(() => slotsFree(page), { timeout: RUN_MS }).toBe(true);
      await route.continue();
    },
    { times: 1 },
  );
  await runLine(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toContainText(/Cancelled after \d+ tool calls?/, { timeout: RUN_MS });
  // No wait: the render that shows the end also frees Ask.
  expect(await send.getAttribute("aria-disabled")).not.toBe("true");
  const sent = asked(page);
  await box(page).press("Control+Enter");
  expect((await sent).postDataJSON()).toEqual({ question: QUESTION });
  await expect(runLine(page)).toContainText("Answering…", { timeout: RUN_MS });

  await release(page);
  const a = answers(page).first();
  await a.getByRole("button", { name: "Cancel" }).click();
  await expect(a.getByRole("status")).toContainText("You cancelled the question.", { timeout: RUN_MS });
});

test("a failed answer shows the reason and its raw output", async ({ page }) => {
  await control("claude", { stream: "tree", answer: { answer: 42, coverage: COVERAGE } });
  await connect(page);
  await page.keyboard.press("q");
  await box(page).fill(QUESTION);
  await box(page).press("Control+Enter");
  const a = answers(page).first();
  await expect(a.getByRole("status")).toContainText("The question failed. The result does not match the ask schema.", { timeout: RUN_MS });
  await a.getByRole("button", { name: "Show raw output" }).click();
  await expect(page.locator("#raw-out")).toContainText("# structured_output");
  await expect(page.locator("#raw-copy")).toBeFocused();
});

// docs/plans/review-v2/spec.md sections 2.14 and 2.18 (AC-F10). mermaid.e2e.ts checks a diagram in a conversation: Mermaid logs CSP
// messages, and this file fails on any.
const FOLLOW = "And who calls flush() on shutdown?";
const FRESH = "Does the cache drop writes?";
const STALE = "Who else calls it?";

test("q focuses the Follow up box under the newest answer, a follow-up carries its parent, and New question starts a conversation on top", async ({
  page,
}) => {
  await control("claude", { stream: "tree", answer: { answer: ANSWER, coverage: COVERAGE } });
  await connect(page);
  await page.keyboard.press("q");
  await expect(page.getByLabel("Your question")).toBeFocused();
  await expect(slot(page).getByRole("button", { name: "New question" })).toHaveCount(0);
  await box(page).fill(QUESTION);
  const first = asked(page);
  await box(page).press("Control+Enter");
  expect((await first).postDataJSON()).toEqual({ question: QUESTION });
  const a1 = answers(page).first();
  await expect(a1.getByRole("status")).toContainText(/Claude answered on/, { timeout: RUN_MS });
  const parent = Number(await a1.getAttribute("data-ask"));

  // The box follows the newest answer and has one primary button.
  await expect(page.getByLabel("Follow up")).toBeFocused();
  await expect(box(page)).toHaveAttribute("placeholder", "Ask about the answer above");
  await expect(slot(page)).toContainText("Claude answers with the Review profile and sees this conversation. Nothing posts to Bitbucket.");
  await expect(slot(page).locator("[data-primary]")).toHaveCount(1);
  await expect(slot(page).locator("[data-primary]")).toHaveText("Ask");
  // q focuses the box under the newest answer.
  await page.keyboard.press("Escape");
  await expect(slot(page)).toHaveCount(0);
  await page.keyboard.press("q");
  await expect(page.getByLabel("Follow up")).toBeFocused();
  const [ans, input] = [await a1.boundingBox(), await box(page).boundingBox()];
  expect((input?.y ?? 0) >= (ans?.y ?? 0) + (ans?.height ?? 0)).toBe(true);

  // Ctrl+Enter sends a follow-up with its parent. The turns show oldest first.
  await control("claude", { stream: "tree", answer: { answer: "Only the worker calls it.", coverage: COVERAGE } });
  await box(page).fill(FOLLOW);
  const second = asked(page);
  await box(page).press("Control+Enter");
  expect((await second).postDataJSON()).toEqual({ question: FOLLOW, parent });
  await expect(page.getByText("Asked. Claude is answering.")).toBeAttached();
  await expect(box(page)).toBeFocused();
  await expect(conversations(page)).toHaveCount(1);
  const turns = conversations(page).first().locator("[data-ask]");
  await expect(turns).toHaveCount(2);
  await expect(turns.nth(0)).toContainText(QUESTION);
  await expect(turns.nth(1)).toContainText(FOLLOW);
  await expect(turns.nth(1).getByRole("status")).toContainText(/Claude answered on/, { timeout: RUN_MS });
  await page.locator("#ask").screenshot({ path: test.info().outputPath("ask-follow-up.png") });

  // New question switches the same box. The typed text and the focus stay in the box.
  await box(page).fill(FRESH);
  await slot(page).getByRole("button", { name: "New question" }).click();
  await expect(page.getByLabel("New question")).toBeFocused();
  await expect(box(page)).toHaveValue(FRESH);
  await expect(slot(page)).toContainText("Claude starts fresh. It does not see the conversation above.");
  await expect(slot(page).getByRole("button", { name: "Back to follow up" })).toBeVisible();
  await expect(slot(page).locator("[data-primary]")).toHaveCount(1);
  const third = asked(page);
  await slot(page).getByRole("button", { name: "Ask", exact: true }).click();
  expect((await third).postDataJSON()).toEqual({ question: FRESH });
  await expect(page.getByText("New question asked. Claude is answering.")).toBeAttached();
  // The new answer starts a conversation on top. The earlier one moves under "Earlier questions", read only.
  await expect(conversations(page)).toHaveCount(2);
  await expect(conversations(page).first().locator("[data-ask]")).toHaveCount(1);
  await expect(conversations(page).first()).toContainText(FRESH);
  const earlier = slot(page).getByRole("region", { name: "Earlier questions" });
  await expect(earlier.locator("[data-ask]")).toHaveCount(2);
  await expect(earlier.locator("textarea")).toHaveCount(0);
  await expect(page.getByLabel("Follow up")).toBeFocused();
  await expect(conversations(page).first().getByRole("status")).toContainText(/Claude answered on/, { timeout: RUN_MS });
  await page.locator("#ask").screenshot({ path: test.info().outputPath("ask-earlier.png") });

  // A second tab already followed up this parent: the server answers 409, the toast says so, and the box keeps its text.
  const route = /\/api\/prs\/\d+\/ask$/;
  await page.route(route, (r) => r.continue({ postData: JSON.stringify({ ...r.request().postDataJSON(), parent }) }));
  await box(page).fill(STALE);
  await box(page).press("Control+Enter");
  await expect(page.getByText("This conversation moved on in another tab. The newest turn is shown now.")).toBeVisible();
  await expect(box(page)).toHaveValue(STALE);
  await page.unroute(route);
  await expect(answers(page)).toHaveCount(3);
});
