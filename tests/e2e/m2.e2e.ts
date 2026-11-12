// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// M2 browser acceptance (plan v3 WP11): the review brief, the run line, the run log, drafts, and raw output.
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { type APIRequestContext, test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, addOwnProfiles, control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
// A pull request of another repository (tests/e2e/serve.ts).
const OTHER = "Drop the legacy export endpoint";
const NOTE = "ABC-1: the flush must stay atomic for readers. Check the lock scope first.";
// A run passes the git workspace, the fake CLI, and the validator.
const RUN_MS = 60_000;

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
const runLine = (page: Page) => page.locator("#runline");
// The row of the newest run of one kind. data-run-state: running, done, failed, limit, or cancelled.
const runRow = (page: Page, kind = "review") => page.locator(`#runline [data-run-kind='${kind}']`);
const runLog = (page: Page) => page.getByRole("dialog", { name: "Review run log" });

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

async function runs(request: APIRequestContext) {
  const prs = (await (await request.get(`${APP}/api/prs`)).json()) as { id: number; title: string }[];
  const id = prs.find((p) => p.title === TITLE)?.id;
  return (await (await request.get(`${APP}/api/prs/${id}/runs`)).json()) as { id: number; profile: string; note: string; status: string }[];
}

// docs/plans/review-v2/design.md R8: the e2e change is small, so only reviewer mode always gives the run rl-reviewer.
async function securityAlways(page: Page) {
  const status = await page.evaluate(async () => {
    const headers = {
      "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "",
      "Content-Type": "application/json",
    };
    const s = (await (await fetch("/api/settings", { headers })).json()) as { baseUrl: string; profiles: { id: string }[] };
    const profiles = s.profiles.map((p) => (p.id === "security" ? { ...p, reviewer: { model: null, effort: null, mode: "always" } } : p));
    return (await fetch("/api/settings", { method: "PUT", headers, body: JSON.stringify({ baseUrl: s.baseUrl, profiles }) })).status;
  });
  expect(status).toBe(200);
  await page.reload();
}

// Shift+R opens the brief with focus in the note. Ctrl+Enter saves the brief and starts the review.
async function startWithBrief(page: Page, note = NOTE) {
  await page.keyboard.press("Shift+R");
  const field = page.getByLabel("Your note");
  await expect(field).toBeFocused();
  await field.fill(note);
  await field.press("Control+Enter");
}

test("a brief with a note and a profile; drafts, summary, and the subagent tree; r opens the stored brief again", async ({
  page,
  request,
}) => {
  await connect(page);
  // The profiles Review, Over-engineering, Security, and Explain. The reload keeps the list, so the row opens the PR again.
  await addOwnProfiles(page);
  await securityAlways(page);
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
  await page.getByLabel("Your note").fill(NOTE);
  await page.getByRole("radio", { name: /^Security/ }).check();
  await expect(page.getByRole("radio", { name: /^Security/ })).toBeChecked();
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(page.locator("#brief")).toHaveCount(0);

  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(runLine(page)).toContainText("3 findings, 1 question");
  // Plan pr-view-v4 2.7: one Drafts section between the Description and the threads. It holds the findings, then the question.
  // docs/plans/review-v2/spec.md section 1.4: the Balanced volume keeps the nit in the closed Low confidence fold between them.
  // Only the first untriaged row starts open. The ledger names the open drafts in plain words. The status strip counts all four.
  const section = page.locator("#s-drafts");
  const heads = section.locator("[data-row-head]");
  await expect(page.locator("#s-overview ~ #s-drafts ~ #s-threads")).toHaveCount(1);
  await expect(section.locator("h2")).toHaveText("Drafts");
  await expect(section.locator("[data-drafts-ledger]")).toHaveText("1 must fix · 1 worth fixing · 1 low confidence · 1 question");
  await expect(page.getByRole("navigation", { name: "Pull request summary" }).getByRole("button", { name: "4 drafts" })).toBeVisible();
  await expect(heads).toHaveCount(4);
  await expect(heads.nth(0)).toContainText("Blocker");
  await expect(heads.nth(0)).toContainText("src/cache/flush.ts:3");
  await expect(heads.nth(2)).toHaveText("Low confidence (1)");
  await expect(heads.nth(3)).toContainText("QuestionMust flush() stay atomic for readers?");
  for (const [i, open] of [true, false, false, false].entries()) await expect(heads.nth(i)).toHaveAttribute("aria-expanded", String(open));
  await expect(page.locator("#s-threads [data-draft], #s-threads [data-draft-question]")).toHaveCount(0);
  // One button per part of the ledger. Each one goes to its first draft. The fold part opens the fold first.
  await expect(runLine(page).locator("[data-ledger]")).toHaveText(["1 must fix", "1 worth fixing", "1 low confidence", "1 question"]);
  await runLine(page).getByRole("button", { name: "1 low confidence" }).click();
  await expect(page.getByRole("article", { name: /^Draft from Claude\. Nit\. README\.md:1\./ })).toBeFocused();
  await expect(heads.nth(2)).toHaveAttribute("aria-expanded", "true");
  // Run setup opens in place with the inputs of the run.
  const setup = runRow(page).getByRole("button", { name: "Run setup of the review run" });
  await expect(page.getByText(`Your note: ${NOTE}`)).toBeHidden();
  await setup.click();
  await expect(setup).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText(`Your note: ${NOTE}`)).toBeVisible();
  // Exact, moved, and outside drafts. The finding on a file that the snapshot does not have is dropped.
  await expect(page.locator("[data-draft]")).toHaveCount(3);
  await expect(page.getByText("Moved from line 6: the quoted code is on line 5.")).toBeHidden();
  await heads.nth(1).click();
  await expect(heads.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Moved from line 6: the quoted code is on line 5.")).toBeVisible();
  await expect(page.getByText("Outside the diff. Posts as a general comment with a link to README.md:1.")).toBeVisible();
  // The record holds the summary. Nothing was skipped, so "Not checked: 0" starts closed and holds the dropped finding.
  await expect(runRow(page)).toContainText("The lock moves into the loop. A reader can see a partly flushed batch.");
  const gaps = runRow(page).getByRole("button", { name: "Not checked: 0" });
  await expect(gaps).toHaveAttribute("aria-expanded", "false");
  await gaps.click();
  await expect(page.getByText("1 finding dropped: its code reference did not match the snapshot.")).toBeVisible();
  await expect(runRow(page)).toContainText("Also not done, by design: Tests did not run, because the review has read-only tools.");
  await runRow(page).getByRole("button", { name: "Risk areas: 2" }).click();
  await expect(runRow(page).getByText("Readers of the cache during a flush.")).toBeVisible();
  // The ledger counts the question too. It opens the question row after the findings.
  await runLine(page).getByRole("button", { name: "1 question" }).click();
  await expect(page.locator("[data-draft-question]")).toBeFocused();
  await expect(heads.last()).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("The description does not say if a reader may see a partial batch.")).toBeVisible();

  // The record names the subagents of the run. The run defined only rl-reviewer, so the refused others are built-in.
  await expect(runRow(page).locator("[data-run-subagents]")).toHaveText(
    "Subagents: general-purpose ×1 (built-in), user-agent-5 ×1 (built-in), rl-reviewer ×1 (claude-haiku-5-5)",
  );
  // "from rl-reviewer" opens the log at that agent. Its calls nest under it by parent.
  await page.getByRole("button", { name: "from rl-reviewer" }).click();
  const log = runLog(page);
  const agent = log.getByRole("button", { name: /^rl-reviewer subagent, done, claude-haiku-5-5, 5k tokens, 3 tool calls/ });
  await expect(agent).toBeFocused();
  await expect(agent).toHaveAttribute("aria-expanded", "true");
  const kids = log.locator(`[id="${await agent.getAttribute("aria-controls")}"] > li`);
  await expect(kids).toHaveCount(3);
  await expect(kids.first()).toContainText("note-reviewer.txt");
  await agent.click();
  await expect(agent).toHaveAttribute("aria-expanded", "false");
  await expect(kids.first()).toBeHidden();
  // The keyboard folds and unfolds the agent too.
  await agent.press("Enter");
  await expect(agent).toHaveAttribute("aria-expanded", "true");
  await agent.press("Space");
  await expect(agent).toHaveAttribute("aria-expanded", "false");
  await expect(log.getByRole("button", { name: /^general-purpose subagent, failed, built-in, / })).toBeVisible();
  await expect(log.locator("footer [data-run-subagents]")).toContainText("rl-reviewer ×1 (claude-haiku-5-5)");
  await expect(log.locator("footer")).toContainText("Result: 3 findings, 1 question.");
  await page.keyboard.press("Escape");
  await expect(log).toBeHidden();
  await expect(page.getByRole("button", { name: "from rl-reviewer" })).toBeFocused();

  // 3 opens the log, 2 goes to the first draft, r opens the stored brief again. Only Start runs it.
  await page.keyboard.press("3");
  await expect(log).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("2");
  await expect(page.locator("[data-draft]").first()).toBeFocused();
  // Plan pr-view-v4 section 6: j and k move over the Drafts rows, then on to the threads. o and Enter open and close a row.
  await page.keyboard.press("j");
  await expect(heads.nth(1)).toBeFocused();
  await page.keyboard.press("o");
  await expect(heads.nth(1)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(heads.nth(1)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("k");
  await expect(heads.nth(0)).toBeFocused();
  await heads.last().focus();
  await page.keyboard.press("j");
  await expect(page.locator("#s-threads [data-thread]").first()).toBeFocused();
  await page.keyboard.press("k");
  await expect(heads.last()).toBeFocused();
  await page.keyboard.press("r");
  await expect(page.getByLabel("Your note")).toHaveValue(NOTE);
  await expect(page.getByRole("radio", { name: /^Security/ })).toBeChecked();
  expect((await runs(request)).length).toBe(1);
  await page.getByLabel("Your note").press("Control+Enter");
  await expect.poll(async () => (await runs(request)).length, { timeout: RUN_MS }).toBe(2);
  expect((await runs(request))[0]).toMatchObject({ profile: "security", note: NOTE });
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(page.locator("#nav-runs")).toHaveAccessibleName("Review runs: 1");

  // The Review runs row names the state, the findings, and the time of the newest run.
  await page.locator("#nav-runs").click();
  await expect(row(page).locator("[data-run-chip]")).toHaveText("Done");
  await expect(row(page)).toContainText("3 findings");
  await expect(row(page).locator("time")).toHaveText(/^(now|\d+m)$/);
});

test("Esc closes the brief; cancel stops a running review, and nothing from it stays", async ({ page, request }) => {
  await control("claude", { stream: "tree", hang: true });
  await connect(page);
  // r opens the brief. Esc closes it and starts nothing.
  await page.keyboard.press("r");
  await expect(page.getByLabel("Your note")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#brief")).toHaveCount(0);
  await expect(page.locator("#review-btn")).toBeFocused();

  await startWithBrief(page);
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
  await expect(runLine(page)).toContainText(/\d+ tool calls?/, { timeout: RUN_MS });
  await page.keyboard.press("3");
  await expect(runLog(page).locator("footer")).toContainText("Running.");
  await page.keyboard.press("Escape");
  await runLine(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toContainText(/Cancelled after \d+ tool calls?/, { timeout: RUN_MS });
  await page.keyboard.press("3");
  await expect(runLog(page).locator("footer")).toContainText("You cancelled the run. Nothing from it can be posted.");
  await expect(page.locator("[data-draft]")).toHaveCount(0);
  expect((await runs(request)).map((r) => r.status)).toEqual(["cancelled"]);
});

test("a usage limit is one line with the CLI message, and the inbox keeps working", async ({ page }) => {
  await control("claude", { stream: "limit" });
  await connect(page);
  await startWithBrief(page);
  await expect(runLine(page)).toContainText(/Claude Code: Usage limit reached\. .* PR Review Inbox does not retry by itself\./, {
    timeout: RUN_MS,
  });
  await expect(runLine(page).getByRole("button", { name: "Show raw output" })).toHaveCount(0);
  await page.locator("#nav-runs").click();
  await expect(row(page).locator("[data-run-chip]")).toHaveText("Usage limit");
  await page
    .locator("nav[aria-label='Views']")
    .getByRole("button", { name: /^Reviewing/ })
    .click();
  await expect(page.locator("[data-row]")).toHaveCount(3);
});

test("a failed run shows its raw output, read-only, with Copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  await control("claude", { stream: "schema" });
  await connect(page);
  await startWithBrief(page);
  await expect(runLine(page)).toContainText("Failed. The result does not match the review schema.", { timeout: RUN_MS });
  await runLine(page).getByRole("button", { name: "Show raw output" }).click();
  const raw = page.locator("#raw-out");
  await expect(raw).toContainText("SCHEMA-CANARY");
  await expect(raw).toContainText("# structured_output");
  await expect(page.locator("#raw-copy")).toBeFocused();
  await page.locator("#raw-copy").click();
  await expect(page.getByText("Copied the raw output.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("SCHEMA-CANARY");
  // The log footer hides the raw output again.
  await runLog(page).getByRole("button", { name: "Hide raw output" }).click();
  await expect(raw).toHaveCount(0);
});

test("two pages share one run: the brief of the second page cannot start while it runs, and a cancel in one page ends it in both", async ({
  page,
  context,
  request,
}) => {
  await control("claude", { stream: "tree", hang: true });
  await connect(page);
  await startWithBrief(page);
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });

  const other = await context.newPage();
  await other.goto("/");
  await row(other).click();
  await expect(runLine(other)).toContainText("Finding problems…");
  await expect(other.locator("#nav-runs")).toHaveAccessibleName("Review runs: 1, 1 running");
  // r opens the brief. Start stays disabled while a run works on this pull request (A14, AC-B196), and Ctrl+Enter only says why.
  await other.keyboard.press("r");
  const start = other.locator("#brief").getByRole("button", { name: "Start review" });
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await expect(start).toHaveAccessibleDescription("Claude is reviewing this pull request. One run per pull request.");
  await other.getByLabel("Your note").press("Control+Enter");
  await expect(other.locator("[data-slot=toast-title]", { hasText: "Claude is reviewing this pull request." })).toBeVisible();
  expect((await runs(request)).length).toBe(1);
  await other.keyboard.press("Escape");
  await expect(other.locator("#brief")).toHaveCount(0);

  await runLine(other).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toHaveAttribute("data-run-state", "cancelled", { timeout: RUN_MS });
  await expect(runRow(other)).toHaveAttribute("data-run-state", "cancelled");
  await expect(page.locator("#nav-runs")).toHaveAccessibleName("Review runs: 1");
});

// docs/plans/review-v2/parallel-runs.md section 3.6 (AC-B196, AC-B221): a run on another pull request leaves a free slot. With the limit
// 1, the brief of another pull request names the limit and the running run, and Start waits until the run ends.
test("a full run pool names the limit and the running run, and a run end frees Start", async ({ page }) => {
  await control("claude", { stream: "tree", hang: true });
  await connect(page);
  await startWithBrief(page);
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });

  // The other pull request is in the Reviewing view only.
  const openOther = async () => {
    await page
      .locator("nav[aria-label='Views']")
      .getByRole("button", { name: /^Reviewing/ })
      .click();
    await page.locator("[data-row]", { hasText: OTHER }).first().click();
    await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(OTHER);
    await page.keyboard.press("r");
  };
  const start = page.locator("#brief").getByRole("button", { name: "Start review" });
  await openOther();
  await expect(start).toBeVisible();
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
  await expect(start).toHaveAccessibleDescription("Ctrl+Enter starts the review. Esc closes the brief.");

  const call = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const headers = {
          "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "",
          "Content-Type": "application/json",
        };
        const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
      },
      { method, path, body },
    );
  const s = (await call("GET", "/api/settings")).json as { baseUrl: string };
  expect((await call("PUT", "/api/settings", { baseUrl: s.baseUrl, runLimits: { runsAtOnce: 1 } })).status).toBe(200);
  await page.reload();
  await openOther();
  const full = /^Claude runs 1 run at once, your limit\. Running: Review of \S+ #1001\.$/;
  await expect(start).toHaveAttribute("aria-disabled", "true");
  await expect(start).toHaveAccessibleDescription(full);
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(page.locator("[data-slot=toast-title]", { hasText: "Claude runs 1 run at once, your limit." })).toBeVisible();
  const slots = (await call("GET", "/api/runs/slots")).json as { limit: number; running: { run: number; pr: number }[] };
  expect(slots.limit).toBe(1);
  expect(slots.running).toHaveLength(1);

  // The run end comes through the live update: Start frees without a reload.
  expect((await call("POST", `/api/runs/${slots.running[0]?.run}/cancel`)).status).toBeLessThan(300);
  await expect(start).not.toHaveAttribute("aria-disabled", "true", { timeout: RUN_MS });
  await expect(start).toHaveAccessibleDescription("Ctrl+Enter starts the review. Esc closes the brief.");
});

// A new Bitbucket origin opens another database and cancels the runs. Their end write fails on the closed database, so no live update
// names them. The Settings save refreshes the runs itself.
test("a settings save that swaps the database ends the running run in the page and frees Start without a reload", async ({ page }) => {
  await control("claude", { stream: "tree", hang: true });
  await connect(page);
  await startWithBrief(page);
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
  await expect(page.locator("#nav-runs")).toHaveAccessibleName("Review runs: 1, 1 running");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const conn = page.locator("section[aria-labelledby='h-connection']");
  // The same fake server under another origin.
  await conn.getByLabel("Bitbucket URL").fill(FAKE_URL.replace("127.0.0.1", "localhost"));
  await conn.getByLabel("Access token").fill(E2E_TOKEN);
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/settings");
  await conn.getByRole("button", { name: "Save" }).click();
  expect((await saved).status()).toBe(200);
  await expect(conn).toHaveCount(0);

  // The new database fills at its first sync.
  await expect(row(page)).toBeVisible({ timeout: RUN_MS });
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
  await page.keyboard.press("r");
  const start = page.locator("#brief").getByRole("button", { name: "Start review" });
  await expect(start).toBeVisible();
  await expect(start).not.toHaveAttribute("aria-disabled", "true");
  await expect(start).toHaveAccessibleDescription("Ctrl+Enter starts the review. Esc closes the brief.");
  // The sidebar stays mounted through the save, so only the save refreshes its run count.
  await expect(page.locator("#nav-runs")).toHaveAccessibleName("Review runs: 0");
});
