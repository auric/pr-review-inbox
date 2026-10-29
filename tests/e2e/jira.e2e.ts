// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 UI-JIRA browser acceptance: the Jira settings, the task chips of the review brief, and the imported task text.
// Plan r3 UI-TASKS: the same chips next to the run buttons and in the Ask section. UI-ATT: the task attachments.
// Runs against serve.ts only: the fake Bitbucket, the fake Jira on JIRA_URL, and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import {
  APP_PORT,
  control,
  E2E_JIRA_TOKEN,
  E2E_TOKEN,
  FAKE_URL,
  JIRA_ISSUE,
  JIRA_URL,
  jiraRequests,
  openApp,
  openFolder,
  runAttachments,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
// serve.ts: the PR 1001 description names it with Scenario.task. The fake Jira gives 404 for it.
const MISSING = "ABC-404";
// fixtures/jira/issue.json and comments-p1.json.
const SUMMARY = "Flush the cache before the write lock";

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      context.on("weberror", (e) => seen.logs.push(e.error().message));
      // Chrome logs no console line for some blocked evals. The event reports every violation.
      await context.addInitScript(() =>
        document.addEventListener("securitypolicyviolation", (e) => console.error(`Content Security Policy: ${e.violatedDirective}`)),
      );
      await control("reset");
      await use(seen);
      // Only the local app gets requests. Jira gets them from the server only.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN) || l.includes(E2E_JIRA_TOKEN))).toEqual([]);
      expect(seen.logs.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l))).toEqual([]);
    },
    { auto: true },
  ],
});

const brief = (page: Page) => page.locator("#brief");
const fold = (page: Page, key: string) => page.locator(`details[data-task="${key}"]`);
const fetchBtn = (page: Page, key: string) => brief(page).getByRole("button", { name: `Fetch ${key} from Jira` });
// The one live region of the detail.
const status = (page: Page) => page.locator("p[role='status'].sr-only");
// exact: a header task chip without a link names Settings too ("Opens Settings, Task IDs").
const openSettings = (page: Page) => page.getByRole("button", { name: "Settings", exact: true }).click();
const closeSettings = (page: Page) => page.getByRole("button", { name: "Close the settings" }).click();

async function open(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

async function openBrief(page: Page) {
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
  await expect(brief(page).getByText(JIRA_ISSUE, { exact: true })).toBeVisible();
  await expect(brief(page).getByText(MISSING, { exact: true })).toBeVisible();
}

test("without Jira settings, the brief offers Set up Jira and no Fetch", async ({ page }) => {
  await open(page);
  await openBrief(page);
  await expect(brief(page).getByRole("button", { name: /^Fetch / })).toHaveCount(0);
  await brief(page).getByRole("button", { name: "Set up Jira" }).click();
  await expect(page.getByLabel("Jira URL")).toBeFocused();
  await expect(page.getByLabel("Personal access token")).toHaveAttribute("placeholder", "Personal access token…");
});

test("connect Jira, fetch a task, show a fetch error, fetch again, remove, and disconnect", async ({ page, request }) => {
  await open(page);

  // Connect. The token goes to the server and never comes back.
  await openSettings(page);
  await page.getByLabel("Jira URL").fill(JIRA_URL);
  await page.getByLabel("Personal access token").fill(E2E_JIRA_TOKEN);
  await page.getByRole("button", { name: "Save Jira settings" }).click();
  await expect(page.getByText("Saved. Jira accepted the token.")).toBeVisible();
  const token = page.getByLabel("Personal access token");
  await expect(token).toHaveValue("");
  await expect(token).toHaveAttribute("placeholder", "Stored. Leave empty to keep it.");
  const dto = await (await request.get(`${APP}/api/settings`)).text();
  expect(dto).not.toContain(E2E_JIRA_TOKEN);
  expect(JSON.parse(dto).jira).toEqual({ baseUrl: JIRA_URL, caFile: null, email: null, tokenStored: true });
  // The reload keeps the settings URL, so Settings opens again by itself (plan pr-view-v4 section 5).
  await page.reload();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByLabel("Jira URL")).toHaveValue(JIRA_URL);
  await expect(page.getByLabel("Personal access token")).toHaveValue("");
  expect(await page.content()).not.toContain(E2E_JIRA_TOKEN);
  await closeSettings(page);

  // Fetch. The fold shows the summary and stays closed until the user opens it.
  await openBrief(page);
  await expect(brief(page).getByRole("button", { name: "Set up Jira" })).toHaveCount(0);
  await fetchBtn(page, JIRA_ISSUE).click();
  const task = fold(page, JIRA_ISSUE);
  await expect(task.locator("summary")).toContainText(SUMMARY);
  // The Fetch button stays in place with its new name, so focus stays on it.
  await expect(brief(page).getByRole("button", { name: `Fetch ${JIRA_ISSUE} again` })).toBeFocused();
  await expect(task.locator("summary")).toContainText("In Progress, 3 comments, 2 attachments, fetched today");
  await expect(task).toHaveJSProperty("open", false);
  const description = task.getByText("The sync worker writes each cache entry on its own.", { exact: false });
  await expect(description).toBeHidden();
  await task.locator("summary").click();
  await expect(description).toBeVisible();
  // Markdown from the rendered HTML (plan r3 S-JMD).
  await expect(task.getByRole("heading", { level: 3, name: "Acceptance criteria" })).toBeVisible();
  await expect(task.locator(".rl-md").getByRole("listitem")).toHaveText(["Batch the writes.", "Flush the cache before the write lock."]);
  await expect(task.locator("pre code")).toHaveText('String fence = "``` is not a fence";');
  // A GFM table. A wide table scrolls in its own box, and the panes keep their width.
  const table = task.getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["Step", "Owner"]);
  await expect(table.getByRole("cell")).toHaveText(["Flush | now", "Alex Smith", "Lock", "sync worker"]);
  const panes = page.locator("#brief, section[aria-label='Details']");
  const widths = () => panes.evaluateAll((els) => els.map((el) => [el.scrollWidth, el.clientWidth]));
  const before = await widths();
  const cell = table.getByRole("cell", { name: "sync worker" });
  await cell.evaluate((td) => {
    td.textContent = "wide".repeat(100);
  });
  expect(await task.locator(".rl-md-table").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await widths()).toEqual(before);
  await table.getByRole("cell", { name: "wide".repeat(100) }).evaluate((td) => {
    td.textContent = "sync worker";
  });
  // A long code line scrolls in its own box too.
  const code = task.locator("pre code");
  const line = await code.evaluate((el) => {
    const text = el.textContent;
    el.textContent = "x".repeat(400);
    return text;
  });
  expect(await task.locator("pre").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await widths()).toEqual(before);
  await code.evaluate((el, text) => {
    el.textContent = text;
  }, line);
  const link = task.getByRole("link", { name: "design note" });
  await expect(link).toHaveAttribute("href", "https://docs.example.test/cache");
  await expect(link).toHaveAttribute("target", "_blank");
  // A mention is a plain name. The javascript: link is text. The attachment image shows its alt text and loads nothing.
  await expect(task.getByRole("link", { name: /Alex Smith|old note/ })).toHaveCount(0);
  await expect(task).toContainText("Alex Smith");
  await expect(task.getByText("image 10100", { exact: true })).toBeVisible();
  await expect(task.locator("img, script, style, iframe, a[href^='javascript:' i]")).toHaveCount(0);
  // The hostile comment keeps its visible text only.
  await expect(task.getByText("QA: test with an empty cache too.")).toBeVisible();
  await expect(task.getByText("Click [here](javascript:alert(2)) now.")).toBeVisible();
  await expect(task).not.toContainText("CANARY");
  expect(await page.title()).not.toContain("CANARY");
  await expect(task.getByText("Kenji Ito")).toBeVisible();

  // A fetch error shows the fixed server text and stores nothing.
  await fetchBtn(page, MISSING).click();
  const failed = `${MISSING}: Jira has no such issue, or the token may not see it.`;
  await expect(brief(page).locator("span", { hasText: failed })).toBeVisible();
  await expect(status(page)).toHaveText(failed);
  await expect(fold(page, MISSING)).toHaveCount(0);
  await expect(fetchBtn(page, MISSING)).toBeVisible();

  // Fetch again replaces the text. The open fold stays open.
  const again = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/task-context/${JIRA_ISSUE}`));
  await brief(page)
    .getByRole("button", { name: `Fetch ${JIRA_ISSUE} again` })
    .click();
  expect((await again).status()).toBe(200);
  await expect(task).toHaveJSProperty("open", true);
  await expect(description).toBeVisible();

  // Remove asks first. Cancel and Escape keep the text, and focus goes back to the Remove button.
  const remove = brief(page).getByRole("button", { name: `Remove the ${JIRA_ISSUE} text` });
  const confirm = page.getByRole("dialog", { name: `Remove the ${JIRA_ISSUE} text?` });
  await remove.click();
  await expect(confirm).toContainText(`The app deletes the stored text of ${JIRA_ISSUE}.`);
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(fold(page, JIRA_ISSUE)).toHaveCount(1);
  await remove.press("Enter");
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(fold(page, JIRA_ISSUE)).toHaveCount(1);
  // Esc before the dialog takes the focus closes only the dialog. The brief stays open.
  // A MutationObserver callback runs as a microtask, so the Esc goes out before the next animation frame.
  const focused = await remove.evaluate(
    (el: HTMLElement) =>
      new Promise<boolean>((resolve) => {
        const obs = new MutationObserver(() => {
          if (!document.querySelector('[data-slot="dialog-content"]')) return;
          obs.disconnect();
          const still = document.activeElement === el;
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          resolve(still);
        });
        obs.observe(document.body, { childList: true, subtree: true });
        el.click();
      }),
  );
  expect(focused).toBe(true);
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeVisible();
  await expect(fold(page, JIRA_ISSUE)).toHaveCount(1);

  // Remove deletes the stored text. Focus goes back to the Fetch button of the chip.
  await remove.click();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(fold(page, JIRA_ISSUE)).toHaveCount(0);
  await expect(fetchBtn(page, JIRA_ISSUE)).toBeFocused();

  // Disconnect deletes the token after a confirmation. The brief offers Set up Jira again.
  await openSettings(page);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Jira" }).click();
  await expect(page.getByText("Disconnected. The token is deleted.")).toBeVisible();
  await expect(page.getByLabel("Jira URL")).toHaveValue("");
  await expect(page.getByLabel("Jira URL")).toBeFocused();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  expect(JSON.parse(await (await request.get(`${APP}/api/settings`)).text()).jira).toEqual({
    baseUrl: null,
    caFile: null,
    email: null,
    tokenStored: false,
  });
  await closeSettings(page);
  await openBrief(page);
  await expect(brief(page).getByRole("button", { name: "Set up Jira" })).toBeVisible();
  await expect(brief(page).getByRole("button", { name: /^Fetch / })).toHaveCount(0);
});

// ---------- Plan r3 UI-TASKS and UI-ATT ----------

const RUN_MS = 60_000;
const runLine = (page: Page) => page.locator("#runline");
// The row of the newest run of one kind. data-run-state: running, done, failed, limit, or cancelled.
const runRow = (page: Page, kind = "review") => page.locator(`#runline [data-run-kind='${kind}']`);
// The task row next to the run buttons while the brief is closed, and the one of the Ask section.
const runChips = (page: Page) => page.locator("[data-task-chips='tk-runs']");
const askChips = (page: Page) => page.locator("[data-task-chips='tk-ask']");
const runTasks = (page: Page, ids: string, kind = "review") => runRow(page, kind).getByTitle(`Task text that this run read: ${ids}`);
const downloads = async () => (await jiraRequests()).filter((r) => r.includes("/secure/attachment/"));

const POLICY = "My company AI policy allows sending task attachments to an AI service.";
const askSwitch = (page: Page) => page.getByRole("switch", { name: /^Ask before .+ reads a Jira attachment$/ });

// The brief after a fetch. The fetched key then shows twice, so openBrief does not fit.
async function reopen(page: Page) {
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
}

async function connectJira(page: Page) {
  await openSettings(page);
  await page.getByLabel("Jira URL").fill(JIRA_URL);
  await page.getByLabel("Personal access token").fill(E2E_JIRA_TOKEN);
  await page.getByRole("button", { name: "Save Jira settings" }).click();
  await expect(page.getByText("Saved. Jira accepted the token.")).toBeVisible();
  await closeSettings(page);
}

test("the run buttons and the Ask section share the task chips of the brief, and each run line keeps the tasks of its run", async ({
  page,
}) => {
  await open(page);
  // Without Jira there is nothing to fetch, so no task row shows outside the brief.
  await expect(runChips(page)).toHaveCount(0);
  await connectJira(page);

  // Next to Draft replies: the keys that Jira can fetch, with their fetch state in words.
  const runs = runChips(page);
  await expect(runs).toContainText(`${JIRA_ISSUE} · not fetched`);
  await expect(runs).toContainText(`${MISSING} · not fetched`);
  await runs.getByRole("button", { name: `Fetch ${JIRA_ISSUE} from Jira` }).click();
  await expect(runs).toContainText(`${JIRA_ISSUE} · fetched today`);
  await expect(runs.getByRole("button", { name: `Fetch ${JIRA_ISSUE} again` })).toBeFocused();
  await expect(status(page)).toHaveText(`Fetched ${JIRA_ISSUE} from Jira.`);

  // The brief takes the place of the row and shows the same chip and the fetched text.
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
  await expect(runChips(page)).toHaveCount(0);
  await expect(brief(page).getByRole("button", { name: `Fetch ${JIRA_ISSUE} again` })).toBeVisible();
  await expect(fold(page, JIRA_ISSUE).locator("summary")).toContainText(SUMMARY);

  // A review records the fetched tasks at its start.
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(runTasks(page, JIRA_ISSUE)).toBeVisible();

  // Remove changes the PR tasks, not the record of the run.
  await runs.getByRole("button", { name: `Remove the ${JIRA_ISSUE} text` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(runs).toContainText(`${JIRA_ISSUE} · not fetched`);
  await expect(runs.getByRole("button", { name: `Fetch ${JIRA_ISSUE} from Jira` })).toBeFocused();
  await expect(runTasks(page, JIRA_ISSUE)).toBeVisible();
  await page.locator("#runline-log").click();
  await expect(page.locator("#run-log").getByTitle(`Task text that this run read: ${JIRA_ISSUE}`)).toBeVisible();
  await page.getByRole("button", { name: "Close the run log" }).click();

  // Ask takes the place of the chip row in the panel slot. It shares the query: a fetch there shows in the row after Ask closes.
  await page.keyboard.press("q");
  const ask = askChips(page);
  await expect(runs).toHaveCount(0);
  await expect(ask).toContainText(`${JIRA_ISSUE} · not fetched`);
  await ask.getByRole("button", { name: `Fetch ${MISSING} from Jira` }).click();
  await expect(ask.getByText(`${MISSING}: Jira has no such issue, or the token may not see it.`)).toBeVisible();
  await ask.getByRole("button", { name: `Fetch ${JIRA_ISSUE} from Jira` }).click();
  await expect(ask).toContainText(`${JIRA_ISSUE} · fetched today`);
  await page.getByLabel("Your question").fill("Which callers of the flush need the lock?");
  await page.getByLabel("Your question").press("Control+Enter");
  await expect(runRow(page, "ask")).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(runTasks(page, JIRA_ISSUE, "ask")).toBeVisible();
  // After the first answer, the box follows it up (docs/plans/review-v2/spec.md section 2.14).
  await page.getByLabel("Follow up").press("Escape");
  await expect(runs).toContainText(`${JIRA_ISSUE} · fetched today`);
});

test("attachments: download all, the inline image, save, include after the policy confirm, a run gets the image, open folder, delete", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  await open(page);
  await connectJira(page);
  await openBrief(page);
  await fetchBtn(page, JIRA_ISSUE).click();
  const task = fold(page, JIRA_ISSUE);
  await expect(task.locator("summary")).toContainText("2 attachments");
  await task.locator("summary").click();

  const files = task.getByRole("region", { name: "Attachments (2)" });
  const png = files.locator("li[data-att='10100']");
  const log = files.locator("li[data-att='10101']");
  await expect(png).toContainText("screenshot.png");
  await expect(png).toContainText("2 KB, image/png. Not downloaded.");
  await expect(log).toContainText("sync-worker.log");
  await expect(log).toContainText("512 B, text/plain. Not downloaded.");
  // The fetch lists the files and downloads none. The image token shows its alt text.
  expect(await downloads()).toEqual([]);
  await expect(task.locator("img")).toHaveCount(0);
  await expect(task.getByText("image 10100", { exact: true })).toBeVisible();

  // Download all gets one file after the other through the server.
  await files.getByRole("button", { name: "Download all (2)" }).click();
  await expect(png).toContainText("2 KB, image/png. Downloaded.");
  await expect(log).toContainText("512 B, text/plain. Downloaded.");
  expect(await downloads()).toEqual(["GET /secure/attachment/10100/screenshot.png", "GET /secure/attachment/10101/sync-worker.log"]);
  await expect(files.getByRole("button", { name: "Open folder" })).toBeFocused();
  await expect(status(page)).toHaveText("Downloaded 2 files.");

  // The image shows in the description. It comes from the local image route.
  const img = task.locator("img");
  await expect(img).toHaveAttribute("src", /^\/api\/prs\/\d+\/task-context\/ABC-42\/files\/10100\/image$/);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(8);

  // Save is a real download with the file name.
  const saved = page.waitForEvent("download");
  await png.getByRole("link", { name: "Save screenshot.png" }).click();
  expect((await saved).suggestedFilename()).toBe("screenshot.png");

  // Include asks first. Esc keeps the file out of runs, and the focus goes back to the switch.
  const include = png.getByRole("switch", { name: "Include screenshot.png in runs" });
  await expect(include).not.toBeChecked();
  await include.click();
  const dialog = page.getByRole("dialog", { name: "Include screenshot.png in runs?" });
  await expect(dialog).toContainText("Company AI policy");
  const policy = dialog.getByRole("checkbox", { name: POLICY });
  await expect(policy).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Include in runs" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(include).toBeFocused();
  await expect(include).not.toBeChecked();
  await expect(brief(page)).toBeVisible();
  await include.click();
  await policy.check();
  await dialog.getByRole("button", { name: "Include in runs" }).click();
  await expect(include).toBeChecked();
  await expect(png).toContainText("Included in runs.");
  await expect(status(page)).toHaveText("screenshot.png is included in runs.");
  await expect(log.getByRole("switch", { name: "Include sync-worker.log in runs" })).not.toBeChecked();

  // A run gets the included image only.
  await control("claude", { stream: "tree", hang: true });
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
  await expect.poll(runAttachments, { timeout: RUN_MS }).toEqual(["10100.png"]);
  await runLine(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toContainText(/Cancelled after \d+ tool calls?/, { timeout: RUN_MS });

  // Open folder without a file manager shows the path with Copy. serve.ts gives the server a recorder, so no window opens.
  await page.keyboard.press("Shift+R");
  await task.locator("summary").click();
  await files.getByRole("button", { name: "Open folder" }).click();
  await expect(files).toContainText("No file manager opened the folder. Copy the path.");
  const [path = ""] = await openFolder();
  expect(path).toMatch(/[\\/]attachments[\\/][^\\/]+[\\/]\d+[\\/]ABC-42$/);
  await expect(files.getByText(path, { exact: true })).toBeVisible();
  const copy = files.getByRole("button", { name: "Copy the folder path" });
  await expect(copy).toBeFocused();
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(path);
  await openFolder({ opens: true });
  await files.getByRole("button", { name: "Open folder" }).click();
  await expect(status(page)).toHaveText(`Opened the folder of ${JIRA_ISSUE}.`);
  await expect(files.getByText(path, { exact: true })).toHaveCount(0);
  // The server asks for the task folder both times, never for a file.
  expect(await openFolder()).toEqual([path, path]);

  // Delete removes the local copy. The image goes back to its alt text, and focus goes to Download.
  await png.getByRole("button", { name: "Delete screenshot.png" }).click();
  await expect(png).toContainText("2 KB, image/png. Not downloaded.");
  await expect(png.getByRole("button", { name: "Download screenshot.png" })).toBeFocused();
  await expect(task.locator("img")).toHaveCount(0);
  await expect(task.getByText("image 10100", { exact: true })).toBeVisible();
  expect(await downloads()).toHaveLength(2);
});

test("the attachment policy question shows once, and the Jira settings switch brings it back", async ({ page }) => {
  await open(page);
  await connectJira(page);
  await openSettings(page);
  await expect(askSwitch(page)).toBeChecked();
  await closeSettings(page);
  await openBrief(page);
  await fetchBtn(page, JIRA_ISSUE).click();
  const task = fold(page, JIRA_ISSUE);
  await task.locator("summary").click();
  const files = task.getByRole("region", { name: "Attachments (2)" });
  await files.getByRole("button", { name: "Download all (2)" }).click();
  const png = files.locator("li[data-att='10100']");
  const log = files.locator("li[data-att='10101']");
  await expect(log).toContainText("Downloaded.");

  // The first include asks.
  const incPng = png.getByRole("switch", { name: "Include screenshot.png in runs" });
  await incPng.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("asks this only once");
  await dialog.getByRole("checkbox", { name: POLICY }).check();
  await dialog.getByRole("button", { name: "Include in runs" }).click();
  await expect(incPng).toBeChecked();

  // The next include goes straight through, also after a reload.
  await page.reload();
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
  await reopen(page);
  await task.locator("summary").click();
  const incLog = log.getByRole("switch", { name: "Include sync-worker.log in runs" });
  await incLog.click();
  await expect(incLog).toBeChecked();
  await expect(dialog).toHaveCount(0);
  await incLog.click();
  await expect(incLog).not.toBeChecked();

  // The confirmation turned the switch off. On brings the question back.
  await page.keyboard.press("Escape");
  await openSettings(page);
  await expect(askSwitch(page)).not.toBeChecked();
  await askSwitch(page).click();
  await expect(askSwitch(page)).toBeChecked();
  await closeSettings(page);
  await reopen(page);
  await task.locator("summary").click();
  await incLog.click();
  await expect(page.getByRole("dialog", { name: "Include sync-worker.log in runs?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(incLog).not.toBeChecked();
});
