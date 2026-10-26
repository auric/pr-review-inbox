// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The README screenshots of the demo (scripts/demo.ts): synthetic data, a fake Bitbucket, a fake Jira, and the fake CLI.
// Usage: bun run screenshots. It builds the UI, starts the demo on SHOTS_PORT (default 7419), and writes WebP files to docs/screenshots/.
// The demo gets its own temp folder, so the script can delete every file that the demo makes. The run log shows paths in it.
// So on Windows the folder is at the drive root, outside the user profile. SHOTS_TEMP sets another parent folder.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "docs", "screenshots");
const PORT = Number(process.env.SHOTS_PORT || 7419);
const BASE = `http://127.0.0.1:${PORT}`;
const START_MS = 60_000;
const RUN_MS = 60_000;
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 400, height: 860 };

// Starts the demo and resolves when it prints its URL.
function startDemo(temp: string): Promise<ChildProcess> {
  const env = { ...process.env, DEMO_PORT: String(PORT), TEMP: temp, TMP: temp, TMPDIR: temp };
  const child = spawn("bun", ["scripts/demo.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`The demo did not start in ${START_MS} ms.`)), START_MS);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes(`demo: ${BASE}/`)) {
        clearTimeout(timer);
        ok(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`The demo exited with code ${code}:\n${out}`));
    });
  });
}

// Windows has no SIGTERM handler, so taskkill ends the demo and its children. The temp folder removal then cleans up.
async function stopDemo(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  const exited = new Promise((ok) => child.once("exit", ok));
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  else child.kill("SIGTERM");
  await Promise.race([exited, new Promise((ok) => setTimeout(ok, 10_000))]);
}

// Chromium encodes the PNG screenshot as WebP, so the script needs no image package.
let encoder: Page;
async function save(page: Page, name: string, clip?: Locator) {
  const png = clip ? await clip.screenshot() : await page.screenshot();
  const webp = await encoder.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    return new Promise<string>((ok) => {
      const reader = new FileReader();
      reader.onload = () => ok(String(reader.result));
      reader.readAsDataURL(blob);
    });
  }, png.toString("base64"));
  const file = join(OUT, `${name}.webp`);
  writeFileSync(file, Buffer.from(webp.slice(webp.indexOf(",") + 1), "base64"));
  console.log(`${name}.webp ${Math.round(statSync(file).size / 1024)} KB`);
}

// Puts the element near the top of its scroll pane. The gap keeps it clear of the compact title row.
const toTop = (l: Locator, gap = 0) =>
  l.evaluate((e, gap) => {
    e.scrollIntoView({ block: "start" });
    let pane = e.parentElement;
    while (pane && pane.scrollHeight <= pane.clientHeight) pane = pane.parentElement;
    pane?.scrollBy({ top: -gap });
  }, gap);

// A colleague's commit on topic/sample-4, the base of the demo task. scripts/demo.ts keeps its git remote in
// <temp>/review-loop-demo-claude-*/remote.git. git gets an empty config, so no signing or hook of the user runs.
function moveDemoBase() {
  const dir = readdirSync(temp).find((n) => n.startsWith("review-loop-demo-claude-"));
  if (!dir) throw new Error("The git remote of the demo is missing.");
  const config = join(temp, "empty.gitconfig");
  writeFileSync(config, "");
  const env = {
    ...process.env,
    GIT_DIR: join(temp, dir, "remote.git"),
    GIT_INDEX_FILE: join(temp, "base.index"),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Demo",
    GIT_AUTHOR_EMAIL: "demo@example.invalid",
    GIT_COMMITTER_NAME: "Demo",
    GIT_COMMITTER_EMAIL: "demo@example.invalid",
  };
  const git = (args: string[], input?: string) => {
    const r = spawnSync("git", args, { env, input, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const ref = "refs/heads/topic/sample-4";
  const parent = git(["rev-parse", ref]);
  git(["read-tree", parent]);
  const blob = git(["hash-object", "-w", "--stdin"], "Release notes.\n");
  git(["update-index", "--add", "--cacheinfo", `100644,${blob},docs/release.md`]);
  git(["update-ref", ref, git(["commit-tree", git(["write-tree"]), "-p", parent, "-m", "Add the release notes"]), parent]);
}

const row = (page: Page, title: string) => page.locator("[data-row]", { hasText: title }).first();
const runRow = (page: Page, kind: string) => page.locator(`#runline [data-run-kind='${kind}']`);

async function openPr(page: Page, title: string) {
  await row(page, title).click();
  await page.locator("#s-threads").waitFor();
}

// Shift+R opens the brief. Ctrl+Enter starts the review. brief: a callback while the brief is open.
async function review(page: Page, brief?: () => Promise<void>) {
  await page.keyboard.press("Shift+R");
  const note = page.getByLabel("Your note");
  await note.waitFor();
  await brief?.();
  await note.press("Control+Enter");
  await runRow(page, "review").and(page.locator("[data-run-state='done']")).waitFor({ timeout: RUN_MS });
}

async function shots(browser: Browser) {
  const ctx = await browser.newContext({ viewport: WIDE, colorScheme: "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await openPr(page, "Take the cache lock");
  await review(page, async () => {
    await page.getByLabel("Your note").fill("Check the lock order in evict(). Callers hold the cache lock today.");
    await save(page, "brief");
  });
  // The review record: the plain-word ledger, the refuted points with their reasons, and the "Not checked" list. The list starts
  // open when the run has gaps.
  const gaps = runRow(page, "review").getByRole("button", { name: /^Not checked/ });
  if ((await gaps.getAttribute("aria-expanded")) !== "true") await gaps.click();
  await runRow(page, "review")
    .getByRole("button", { name: /refuted by the check/ })
    .click();
  await toTop(page.locator("#runline"), 64);
  await save(page, "review");
  // The Drafts list with its check chips and the open "Low confidence" fold.
  await page.getByRole("button", { name: /^Low confidence \(/ }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // The rows of the fold fade in (.rl-enter).
  await page.waitForTimeout(400);
  await toTop(page.locator("#s-drafts"), 64);
  await save(page, "drafts");
  await page.keyboard.press("3");
  await page.getByRole("dialog", { name: "Review run log" }).waitFor();
  // The log opens at its end. Its start shows the first agent and its calls.
  await page.locator("ol[aria-label='Tool calls']").evaluate((e) => e.scrollTo({ top: 0 }));
  await save(page, "run-log");
  await page.keyboard.press("Escape");
  // The hero: the inbox and the pull request with its review. The compact title row hides when the pane is back at the top.
  await page.keyboard.press("1");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  await save(page, "inbox-light");
  // Ask Claude about a finding (docs/plans/review-v2/spec.md section 2.1): t opens the talk under the first card. The answer changes
  // the point, so the card shows the new text as a word diff (scripts/demo.ts DISCUSS).
  const first = page.locator("[data-draft]").first();
  await first.locator("[data-row-head]").focus();
  await page.keyboard.press("t");
  const talkBox = first.locator("[data-talk] textarea");
  await talkBox.fill("evict() takes the cache lock before it calls flush(). Is this still a blocker?");
  await talkBox.press("Control+Enter");
  await first.locator("[data-talk] [data-verdict]").waitFor({ timeout: RUN_MS });
  await first.locator("[data-revision]").waitFor();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  // The card actions, the new text, and the talk under them.
  await toTop(first.locator("[data-revision]"), 150);
  await save(page, "discuss");
  // Keep mine and Esc: the card is as before for the next shots.
  await first.locator("[data-revision]").getByRole("button", { name: "Keep mine" }).click();
  await first.locator("[data-revision]").waitFor({ state: "detached" });
  await talkBox.focus();
  await page.keyboard.press("Escape");
  await first.locator("[data-talk]").waitFor({ state: "detached" });
  // A discard offers the reason chips on the card. One chip is picked.
  await page.locator("[data-draft]").first().getByRole("button", { name: "Discard" }).click();
  const chips = page.locator("[data-reason-chips]");
  await chips.getByRole("button", { name: "Not a bug" }).click();
  await chips.locator("[aria-pressed='true']").waitFor();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await toTop(page.locator("#s-drafts"), 64);
  await save(page, "discard-reason");

  // Fix it on my own PR: a review, reply drafts, then the Fix list.
  await openPr(page, "Release the write lock after each entry");
  await review(page);
  await page.locator("#replies-btn").click();
  await runRow(page, "reply").and(page.locator("[data-run-state='done']")).waitFor({ timeout: RUN_MS });
  await page.locator("#fix-btn").focus();
  await page.keyboard.press("Shift+F");
  const list = page.getByRole("dialog", { name: "Fix comments on your pull request" });
  await list.waitFor();
  await save(page, "fix-list");
  // The fix run of the two ticked threads. The first thread then shows its outcome line, its reply draft, and its fix card.
  await list.getByRole("button", { name: /^Propose fixes for / }).click();
  await runRow(page, "fix").and(page.locator("[data-run-state='done']")).waitFor({ timeout: RUN_MS });
  const head = page.locator("#th-2000");
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await page.locator("#t-2000 [data-fix] [data-edit]").waitFor();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await toTop(page.locator("#t-2000"), 64);
  await save(page, "fix-thread");

  // Thread history: the resolved thread 3000 of my other PR, with its draft, my edit, the fix commit, the revision, the post, and
  // the resolve (scripts/demo.ts). Show changes opens the word diff of my edit.
  await openPr(page, "Replace the polling timer");
  await page.getByRole("button", { name: /^Show \d+ resolved$/ }).click();
  const resolved = page.locator("#th-3000");
  if ((await resolved.getAttribute("aria-expanded")) !== "true") await resolved.click();
  await page.locator("#t-3000").getByRole("button", { name: "More for this thread" }).click();
  await page.getByRole("menuitem", { name: "Show history" }).click();
  const history = page.locator("#hist-3000");
  await history.locator("[data-history-line]").first().waitFor();
  await history.getByRole("button", { name: "Show changes" }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await toTop(history, 120);
  await save(page, "thread-history");
  // PR notes (scripts/demo.ts): the Notes block with a kept note and a suggestion, and the draft card that cites another thread.
  await page.locator(`#s-notes [data-note-ref]`).waitFor();
  await toTop(page.locator("#s-notes"), 64);
  await save(page, "notes");
  const card = page.locator("#t-1000003 [data-reply-draft]");
  await card.locator("[data-note-suggestion]").waitFor();
  await toTop(page.locator("#t-1000003"), 64);
  await save(page, "reply-note");

  // Build a Jira task (docs/plans/review-v2/spec.md section 7.2): Build on the task chip of my PR, the questions with the recommended
  // answers preselected, the plan with the first-use warning, then the change that waits for its PR (scripts/demo.ts TASK_*).
  // The pointer moves away after each click, so no button shows its hover color. The button color has a short transition.
  const rest = async () => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };
  await openPr(page, "Release the write lock after each entry");
  await page.getByRole("button", { name: "Build this task: ABC-10688" }).click();
  const questions = page.locator("#task-questions");
  await questions.waitFor({ timeout: RUN_MS });
  await rest();
  await save(page, "task-questions");
  await questions.getByRole("button", { name: "Send answers" }).click();
  await page.locator("#task-plan").waitFor({ timeout: RUN_MS });
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await rest();
  await save(page, "task-plan");
  await page.locator("[data-primary]").click();
  await page.locator("[data-primary]", { hasText: "Open the PR" }).waitFor({ timeout: 3 * RUN_MS });
  await rest();
  await save(page, "task-build");
  // The base of the task moves (spec.md section 6.18.5). The app checks the base at most once a minute when the view loads, so the page
  // loads again until the row shows "Update from <base>" with the Tell Claude box under it.
  moveDemoBase();
  const update = page.locator("[data-primary]", { hasText: "Update from topic/sample-4" });
  for (let i = 0; !(await update.isVisible()); i++) {
    if (i >= 15) throw new Error("The base check did not offer the update.");
    await page.waitForTimeout(10_000);
    await page.reload();
    await update.waitFor({ timeout: 5_000 }).catch(() => undefined);
  }
  await rest();
  await save(page, "task-update");

  await page.goto(`${BASE}/settings/profiles`);
  await page.locator("#h-profiles").waitFor();
  await toTop(page.locator("#h-profiles"));
  await save(page, "settings-profiles");
  await page.goto(`${BASE}/settings/quality`);
  await page.locator("[data-stats-row]").first().waitFor();
  await toTop(page.locator("#h-quality"));
  await save(page, "settings-quality");
  await ctx.close();

  const narrow = await browser.newContext({ viewport: NARROW, colorScheme: "light", reducedMotion: "reduce" });
  const phone = await narrow.newPage();
  await phone.goto(`${BASE}/`);
  await row(phone, "Take the cache lock").waitFor();
  await save(phone, "narrow");
  await narrow.close();

  // The same view in the dark theme.
  const dark = await browser.newContext({ viewport: WIDE, colorScheme: "dark", reducedMotion: "reduce" });
  const night = await dark.newPage();
  await night.goto(`${BASE}/`);
  await openPr(night, "Take the cache lock");
  await night.keyboard.press("1");
  await night.waitForTimeout(500);
  await save(night, "inbox-dark");
  await dark.close();

  // Explain this PR (docs/plans/review-v2/spec.md section 3.1), after the inbox shots, so both of them show the same run record.
  // w opens the page, and its one button starts the run. The page shows the walkthrough with its diagram (scripts/demo.ts EXPLAIN).
  for (const scheme of ["light", "dark"] as const) {
    const c = await browser.newContext({ viewport: WIDE, colorScheme: scheme, reducedMotion: "reduce" });
    const p = await c.newPage();
    await p.goto(`${BASE}/`);
    await openPr(p, "Take the cache lock");
    await p.keyboard.press("w");
    // The dark page finds the stored walkthrough of the same head. Opening the page starts no run.
    if (scheme === "light") await p.locator("[data-explain] [data-primary]").click();
    await p.locator("[data-explain] figure[data-diagram='image'] img").waitFor({ timeout: RUN_MS });
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await save(p, `explain-${scheme}`);
    await c.close();
  }
}

mkdirSync(OUT, { recursive: true });
const parent = process.env.SHOTS_TEMP || (process.platform === "win32" ? `${process.env.SystemDrive || "C:"}\\` : tmpdir());
const temp = mkdtempSync(join(parent, "pr-review-inbox-shots-"));
let demo: ChildProcess | undefined;
let browser: Browser | undefined;
try {
  demo = await startDemo(temp);
  browser = await chromium.launch();
  encoder = await (await browser.newContext()).newPage();
  await shots(browser);
} finally {
  await browser?.close();
  if (demo) await stopDemo(demo);
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
