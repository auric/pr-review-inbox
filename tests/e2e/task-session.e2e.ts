// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/ps5-plan.md sections 4.2 and 7 (AC-B369 to AC-B371, AC-B373, AC-B375, AC-B379, AC-B380, AC-B383): the part session
// in the browser. Hold and Continue, the usage limit with its resume, a push-back of the judging run, Start again, "Go on without these
// fixes", Leave it, "Push to <branch>", and a queued Tell message with the live gate off.
// Runs against serve.ts only: the fake Bitbucket, the fake Jira, the fake CLI, and a local git remote.
import { test as base, expect, type Page } from "@playwright/test";
import {
  APP_PORT,
  type ClaudeScenario,
  control,
  E2E_JIRA_TOKEN,
  E2E_TOKEN,
  FAKE_URL,
  JIRA_ISSUE,
  JIRA_URL,
  liveGate,
  makeClone,
  openApp,
  runArgv,
  taskRemote,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const PR_TITLE = "Batch cache writes in the sync worker";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const SPEC = {
  title: "Name the app state in the README",
  size: "small",
  estimate: { parts: 1, lines: 5, files: 2, modules: ["docs"], db: false, api: false, unknowns: [] },
  map: [{ path: "README.md", line: 1, symbol: "", kind: "change", what: "The title line." }],
  change: "Add the word works to the title line of the README.",
  design: null,
  spec: null,
  parts: [
    {
      n: 1,
      kind: "part",
      title: "README title",
      goal: "The README title says that the app works.",
      lines: 5,
      acceptance: [{ id: "A1", text: "The README title contains works." }],
      tests: [{ test: "tests/readme.test.ts", proves: ["A1"] }],
      tasks: [
        {
          id: "T1",
          title: "Change the README title",
          files: ["README.md"],
          run: ["tests/readme.test.ts"],
          done: "The README test passes.",
        },
      ],
    },
  ],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
};
const README_TEST = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("the README title says that the app works", () => expect(readFileSync("README.md", "utf8")).toContain("works"));
`;
// A build run that finishes the part: the test, the README, and a tick of each task.
const BUILD = {
  writes: [
    { path: "repo/tests/readme.test.ts", text: README_TEST },
    { path: "repo/README.md", text: "# Sample works\n" },
  ],
  ticks: { path: "*", ids: ["*"] },
};
const CLEAN = { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] };
// A must-fix point on the README title line. Each fix keeps line 1, so the point still anchors there.
const BLOCKER = {
  path: "README.md",
  side: "new",
  line: 1,
  lineEnd: null,
  anchorText: "# Sample works",
  severity: "blocker",
  category: "Correctness",
  body: "The title does not say what works.",
  evidence: "README.md:1 says only works.",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  trigger: "A reader of the README cannot tell what works.",
};
// Fix runs that each change the README below the title, so each fix makes a new commit.
const FIXES = Array.from({ length: 12 }, (_, k) => ({ writes: [{ path: "repo/README.md", text: `# Sample works\n\nFix ${k + 1}.\n` }] }));
const CLAUDE = {
  stream: "task",
  spec: SPEC,
  review: CLEAN,
  seq: {
    // Run 1 hangs until Hold ends it. Run 2, after Continue, finishes the part.
    "implement:build": [{ hang: true }, BUILD],
    "implement:fix": [{ writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
  },
} satisfies ClaudeScenario;

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
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN) || l.includes(E2E_JIRA_TOKEN))).toEqual([]);
    },
    { auto: true },
  ],
});

async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers = {
        "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "",
        "Content-Type": "application/json",
      };
      const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

const status = (page: Page) => page.locator("#task-status");
const primary = (page: Page) => page.locator("[data-primary]");
const menu = async (page: Page) => {
  await page.getByRole("button", { name: "More actions" }).click();
  return page.getByRole("menu");
};
const READY = /^Your change is ready(: [^.]+)?\.$/;
const BUILDING = /^\S+ builds your change(: \d+ of \d+ tasks done)?\.$/;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The JSON body of the next task resume request that the action sends.
const resumeBody = async (page: Page, act: () => Promise<void>) => {
  const req = page.waitForRequest((r) => r.method() === "POST" && /\/api\/tasks\/\d+\/resume$/.test(r.url()));
  await act();
  return (await req).postDataJSON() as Record<string, unknown>;
};

// Connects the app, runs the interview and the plan with the scenario, and starts the build. live false turns the live gate off first.
// task: the branch prefix "task/", which a reset removes. The remote has a branch "feature", so a "feature/" branch cannot push.
async function startBuild(page: Page, claude: ClaudeScenario, o: { live?: boolean; task?: boolean } = {}) {
  await control("claude", claude);
  if (o.live === false) await liveGate(false);
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  const prs = (await api(page, "GET", "/api/prs")).json as { id: number; prId: number }[];
  const prA = prs.find((p) => p.prId === 1001)?.id as number;
  expect((await api(page, "PUT", `/api/prs/${prA}/clone`, { path: await makeClone(1001) })).status).toBe(200);
  await page.reload();

  await page.locator("[data-row]", { hasText: PR_TITLE }).first().click();
  await page.getByRole("button", { name: `Build this task: ${JIRA_ISSUE}` }).click();
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  if (o.task) {
    await page.locator("label", { has: page.getByRole("radio", { name: "Other…", exact: true }) }).click();
    await page.getByLabel("Prefix", { exact: true }).fill("task/");
    await expect(page.locator("#task-branch")).toHaveText(/^task\/ABC-42-/);
  }
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();
}

test("Hold keeps the work of a building part, the confirm of Start again sends nothing, and Continue runs the build to ready", async ({
  page,
  seen,
}) => {
  test.setTimeout(600_000);
  await startBuild(page, CLAUDE);

  // 1. The build run hangs. A Hold before the CLI starts would leave the hang entry unused, so the test waits for the build run.
  await expect(status(page)).toHaveText(BUILDING, { timeout: 180_000 });
  await expect.poll(async () => (await runArgv())?.stdin.includes("- Mode: build") ?? false, { timeout: 60_000 }).toBe(true);
  const building = await menu(page);
  await expect(building.getByRole("menuitem")).toHaveText(["Hold", "Stop"]);
  await building.getByRole("menuitem", { name: "Hold", exact: true }).click();

  // 2. AC-B369: the part is on hold, and Continue takes the focus.
  await expect(status(page)).toHaveText("Your change is on hold. Its work is kept.", { timeout: 60_000 });
  await expect(primary(page)).toHaveText("Continue");
  await expect(primary(page)).toBeFocused();

  // 3. AC-B370: the confirm of Start again closes on Esc and on Cancel, and sends nothing.
  const held = await menu(page);
  await expect(held.getByRole("menuitem")).toHaveText(["Start this part again", "Stop"]);
  await held.getByRole("menuitem", { name: "Start this part again" }).click();
  const confirm = page.getByRole("dialog", { name: "Start your change again?" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("The app keeps the old work as a patch and as a backup branch in the app cache.");
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await (await menu(page)).getByRole("menuitem", { name: "Start this part again" }).click();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(seen.urls.filter((u) => u.includes("/restart"))).toEqual([]);
  await expect(status(page)).toHaveText("Your change is on hold. Its work is kept.");

  // 4. Enter on Continue resumes the part, and the build ends green.
  await primary(page).focus();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText(READY, { timeout: 180_000 });

  // 5. AC-B380: the Plan tab ticks each task of the part from the run rows.
  await page.getByRole("tab", { name: "Plan" }).click();
  const plan = page.getByRole("tabpanel");
  await expect(plan.getByText(/^Done: $/)).not.toHaveCount(0);
  await expect(plan.getByText(/^Open: $/)).toHaveCount(0);

  // 6. AC-B379: the Log names the new session of the build run and the critic run.
  await page.getByRole("tab", { name: "Log" }).click();
  const log = page.getByRole("tabpanel");
  await expect(log.getByText(/^New session/).first()).toBeVisible();
  await expect(log.getByText("Quick review", { exact: true }).first()).toBeVisible();
});

// The text of a reset time as model.ts resetText gives it, in the locale and the day of the page.
const resetText = (page: Page, ms: number) =>
  page.evaluate((ms) => {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }, ms);

test("a usage limit with a future reset arms the resume, and Cancel the resume gives the button back", async ({ page }) => {
  test.setTimeout(600_000);
  const at = Math.floor(Date.now() / 1000) + 3 * 60 * 60;
  await startBuild(page, { ...CLAUDE, usageAt: at, seq: { "implement:build": [{ exitCode: 1 }, BUILD] } });

  // 1. AC-B371: the reason says when the limit resets, and the primary resumes at that time.
  const time = reEscape(await resetText(page, at * 1000));
  await expect(status(page)).toHaveText(new RegExp(`^Your \\S+ usage limit is reached\\. It resets at ${time}\\.$`), {
    timeout: 180_000,
  });
  await expect(primary(page)).toHaveText(new RegExp(`^Resume at ${time}$`));

  // 2. The click arms the resume: no primary, and More offers "Cancel the resume".
  expect(await resumeBody(page, () => primary(page).click())).not.toHaveProperty("option");
  await expect(status(page)).toHaveText(new RegExp(`^\\S+ resumes at ${time}\\.$`));
  await expect(primary(page)).toHaveCount(0);
  const armed = await menu(page);
  await expect(armed.getByRole("menuitem")).toHaveText(["Cancel the resume", "Stop"]);

  // 3. "Cancel the resume" sends option disarm, and the button comes back.
  expect(await resumeBody(page, () => armed.getByRole("menuitem", { name: "Cancel the resume" }).click())).toMatchObject({
    option: "disarm",
  });
  await expect(status(page)).toHaveText(new RegExp(`^Your \\S+ usage limit is reached\\. It resets at ${time}\\.$`));
  await expect(primary(page)).toHaveText(new RegExp(`^Resume at ${time}$`));
});

test("a usage limit with a past reset offers Resume, and the click runs the build to ready", async ({ page }) => {
  test.setTimeout(600_000);
  const at = Math.floor(Date.now() / 1000) - 60;
  await startBuild(page, { ...CLAUDE, usageAt: at, seq: { "implement:build": [{ exitCode: 1 }, BUILD] } });
  await expect(status(page)).toHaveText(/^Your \S+ usage limit is reached\. It resets at [^.]+\.$/, { timeout: 180_000 });
  await expect(primary(page)).toHaveText("Resume");
  await primary(page).click();
  await expect(status(page)).toHaveText(READY, { timeout: 180_000 });
});

test("a push-back of the judging run asks without recommended answers, and Accept goes on to ready", async ({ page }) => {
  test.setTimeout(600_000);
  await startBuild(page, {
    ...CLAUDE,
    seq: {
      "implement:build": [BUILD],
      // The first own review confirms the blocker. The review after the judging run is clean.
      review: [{ review: { ...CLEAN, findings: [BLOCKER] } }, { review: CLEAN }],
      "implement:fix": [
        { ...FIXES[0], judge: [{ verdict: "pushback", why: "plan", reason: "The plan names this title.", cite: "README.md:1" }] },
      ],
    },
  });

  // 1. AC-B373: the push-back waits as a question with its point. The primary opens it.
  await expect(primary(page)).toHaveText("Judge the push-back", { timeout: 180_000 });
  await primary(page).click();
  const form = page.getByRole("form", { name: "Questions" });
  await expect(form).toBeVisible();
  await expect(form).toContainText("Reason: The plan names this title.");
  await expect(page.getByRole("button", { name: "Use the recommended answers" })).toHaveCount(0);
  await expect(form.getByText("Recommended", { exact: true })).toHaveCount(0);

  // 2. Accept the push-back: the point closes, and the part goes on to ready.
  await form.getByRole("radio", { name: /^Accept the push-back/ }).check();
  await form.getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText(READY, { timeout: 180_000 });
});

test("Start this part again in ready runs the build again and pushes nothing", async ({ page }) => {
  test.setTimeout(600_000);
  // The second build run is slow, so the page shows it.
  await startBuild(page, { ...CLAUDE, seq: { "implement:build": [BUILD, { ...BUILD, delayMs: 400 }] } });
  await expect(status(page)).toHaveText(READY, { timeout: 180_000 });
  const before = await taskRemote();

  const ready = await menu(page);
  await ready.getByRole("menuitem", { name: "Start this part again" }).click();
  const confirm = page.getByRole("dialog", { name: "Start your change again?" });
  await confirm.getByRole("button", { name: "Start again" }).click();
  await expect(confirm).toBeHidden();
  await expect(status(page)).toHaveText(BUILDING, { timeout: 60_000 });
  await expect(status(page)).toHaveText(READY, { timeout: 180_000 });
  expect(await taskRemote()).toEqual(before);
});

test("Go on without these fixes keeps the points listed; Leave it in ready gives back the push row; Push to <branch> pushes once", async ({
  page,
}) => {
  test.setTimeout(600_000);
  // Each own review confirms the blocker, so the fix rounds end at the reason blocker.
  await startBuild(
    page,
    {
      ...CLAUDE,
      seq: {
        "implement:build": [BUILD],
        review: [{ review: { ...CLEAN, findings: [BLOCKER] } }],
        "implement:fix": FIXES,
        "implement:instruct": [{ writes: [{ path: "repo/README.md", text: "# Sample works well\n" }] }],
      },
    },
    { task: true },
  );

  // 1. AC-B375: the blocker row offers "Go on without these fixes", which sends option without.
  await expect(primary(page)).toHaveText("Continue", { timeout: 300_000 });
  const blocked = await menu(page);
  await expect(blocked.getByRole("menuitem", { name: "Go on without these fixes" })).toBeVisible();
  const without = await resumeBody(page, () => blocked.getByRole("menuitem", { name: "Go on without these fixes" }).click());
  expect(without).toMatchObject({ option: "without" });
  await expect(status(page)).toHaveText(READY, { timeout: 180_000 });
  await expect(page.getByText(/^\S+'s own review left 1 point:$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Fix these too" })).toBeVisible();

  // 2. Open the PR pushes the branch for the first time.
  await primary(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Push and open PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText(/^Waiting for the review of your PR\./, { timeout: 60_000 });
  const opened = await taskRemote();
  const branch = Object.keys(opened.heads).find((b) => b.startsWith("task/ABC-42-")) ?? "";
  expect(opened.updates[branch]).toHaveLength(1);

  // 3. A send in ready makes a commit, and its own review ends at the blocker again. "Leave it" sends option leave.
  const box = page.getByRole("form", { name: /^Tell \S+$/ });
  await box.getByRole("textbox", { name: /^Tell \S+$/ }).fill("Say in the title that it works well.");
  await box.getByRole("button", { name: /^Send to \S+$/ }).click();
  await expect(primary(page)).toHaveText("Continue", { timeout: 300_000 });
  const again = await menu(page);
  await expect(again.getByRole("menuitem", { name: "Leave it" })).toBeVisible();
  expect(await resumeBody(page, () => again.getByRole("menuitem", { name: "Leave it" }).click())).toMatchObject({ option: "leave" });

  // 4. The commits of the send wait for "Push to <branch>". The click pushes once, from the pushed head to the new head.
  await expect(status(page)).toHaveText("Your change has new commits that are not on the server yet.", { timeout: 60_000 });
  await expect(primary(page)).toHaveText(`Push to ${branch}`);
  expect(await taskRemote()).toEqual(opened);
  await primary(page).click();
  await expect(status(page)).toHaveText(/^Waiting for the review of your PR\./, { timeout: 60_000 });
  const pushed = await taskRemote();
  expect(pushed.heads[branch]).not.toBe(opened.heads[branch]);
  expect(pushed.updates[branch]).toEqual([...(opened.updates[branch] ?? []), [opened.heads[branch], pushed.heads[branch]]]);
});

test("with the live gate off, a Tell message during the build run waits for the run end, then runs", async ({ page }) => {
  test.setTimeout(600_000);
  // The build run sends its stream slowly, so the message comes during the run.
  await startBuild(
    page,
    {
      ...CLAUDE,
      seq: {
        "implement:build": [{ ...BUILD, delayMs: 1500 }],
        "implement:instruct": [{ writes: [{ path: "repo/README.md", text: "# Sample works well\n" }] }],
      },
    },
    { live: false },
  );
  await expect.poll(async () => (await runArgv())?.stdin.includes("- Mode: build") ?? false, { timeout: 180_000 }).toBe(true);

  // 1. part-session.md section 2.9: the hint says that the message waits for the end of the current run.
  const box = page.getByRole("form", { name: /^Tell \S+$/ });
  await expect(box.getByText(/^\S+ reads this when the current run ends\.$/)).toBeVisible({ timeout: 30_000 });
  const ASK = "Say in the title that it works well.";
  await box.getByRole("textbox", { name: /^Tell \S+$/ }).fill(ASK);
  await box.getByRole("button", { name: /^Send to \S+$/ }).click();

  // 2. The build run goes on with no input, and the message runs after it.
  await expect(status(page)).toHaveText(BUILDING);
  const build = await runArgv();
  expect(build?.stdin).toContain("- Mode: build");
  expect(build?.stdin).not.toContain(ASK);
  const send = page.locator("[data-send]");
  await page.getByRole("tab", { name: "Log" }).click();
  await expect(send.first()).toContainText(ASK, { timeout: 180_000 });
  await expect(send.first()).toContainText(/Done: 1 file changed\. Checks green\./, { timeout: 180_000 });
});
