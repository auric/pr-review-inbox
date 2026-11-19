// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/ps6-ps7-plan.md section 4 (PS6-C, AC-B399): PR comments on a task PR in the browser. A small task opens its PR,
// and the reviewer adds two threads. "Sort the comments" runs the reply run, and the Task view lists two groups. A first send stops,
// and the Tell box stays empty. A second sort and send: Claude fixes one thread and pushes back on the other. The PR view shows the
// "Fixed in" draft and the push-back draft. After Accept, "Push and post 2 replies" pushes and posts both. No URL outside the app.
// Runs against serve.ts only: the fake Bitbucket, the fake Jira, the fake CLI, and a local git remote.
import { test as base, expect, type Page } from "@playwright/test";
import {
  APP_PORT,
  buildTask,
  type ClaudeScenario,
  control,
  E2E_JIRA_TOKEN,
  E2E_TOKEN,
  FAKE_URL,
  JIRA_URL,
  makeClone,
  openApp,
  taskPrComments,
  taskRemote,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
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
// The reviewer's threads: one asks for a change, one is not valid.
const RENAME = 6000001;
const KEEP = 6000002;
const THREADS = [
  { id: RENAME, text: "Say in the title that it works well." },
  { id: KEEP, text: "Drop the README test. It tests nothing." },
];
const REPLIES = {
  summary: "Two replies.",
  replies: [
    {
      thread: RENAME,
      action: "reply",
      body: "Agreed, I change the title.",
      reason: "The comment asks for a change.",
      evidenceStatus: "code",
      judgement: "valid",
      group: 1,
    },
    {
      thread: KEEP,
      action: "reply",
      body: "The test checks the title.",
      reason: "The test has a purpose.",
      evidenceStatus: "code",
      judgement: "invalid",
      group: 2,
    },
  ],
  coverage: NO_COVERAGE,
};
const POINTS = {
  summary: "Changed the title. Kept the test.",
  done: true,
  tests: [],
  question: null,
  specChange: "",
  notes: [],
  coverage: NO_COVERAGE,
  points: [
    { id: RENAME, verdict: "fixed", reason: "The title now says that it works well.", why: null, cite: "" },
    { id: KEEP, verdict: "pushback", reason: "The test guards the title, so it stays.", why: "invalid", cite: "" },
  ],
};
const WELL = { writes: [{ path: "repo/README.md", text: "# Sample works well\n" }], implement: POINTS };
const CLAUDE = {
  stream: "task",
  spec: SPEC,
  replies: REPLIES,
  review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
  seq: {
    "implement:build": [
      {
        writes: [
          { path: "repo/tests/readme.test.ts", text: README_TEST },
          { path: "repo/README.md", text: "# Sample works\n" },
        ],
        ticks: { path: "*", ids: ["*"] },
      },
    ],
    // The first comment run runs until Stop, if its CLI starts at all.
    "implement:comments": [{ hang: true }],
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
const groups = (page: Page) => page.locator("[data-comment-groups] [data-group]");
const more = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const card = (page: Page, id: number) => page.locator(`#t-${id}`).locator("[data-reply-draft]");
async function openThread(page: Page, id: number) {
  const head = page.locator(`#th-${id}`);
  await expect(async () => {
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true", { timeout: 1000 });
  }).toPass();
}

test("PR comments of a task PR: sort, send, a stopped run keeps the Tell box empty, then fixed and push-back drafts post after the push", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await control("claude", CLAUDE);
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

  // 1. Build the small task and open its PR.
  await buildTask(page, "PROJ1/sample-repo-2");
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  // The fake remote has a branch "feature", so the task branch takes the prefix "task/" (the reset removes those branches).
  await page.locator("label", { has: page.getByRole("radio", { name: "Other…", exact: true }) }).click();
  await page.getByLabel("Prefix", { exact: true }).fill("task/");
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();
  await expect(status(page)).toHaveText(/^Your change is ready(: [^.]+)?\.$/, { timeout: 180_000 });
  await primary(page).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Push and open PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText("Waiting for the review of your PR. Nothing to do.");
  const branch = Object.keys((await taskRemote()).heads).find((b) => b.startsWith("task/ABC-42-")) as string;
  expect(branch).toBeTruthy();

  // 2. The reviewer adds two threads. The row offers "Sort the comments" (AC-B398).
  await taskPrComments(THREADS);
  await expect(status(page)).toHaveText("2 comments on the PR wait for you.", { timeout: 60_000 });
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Sort the comments");

  // 3. The sort lists one group per cause with the defaults: Fix for valid, Push back for invalid.
  await primary(page).click();
  await expect(status(page)).toHaveText("1 group to fix, 1 to push back.", { timeout: 120_000 });
  await expect(groups(page)).toHaveCount(2);
  await expect(groups(page).first()).toContainText("Agreed, I change the title.");
  await expect(groups(page).first().getByRole("button", { name: "Fix", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(groups(page).nth(1).getByRole("button", { name: "Push back" })).toHaveAttribute("aria-pressed", "true");
  await expect(primary(page)).toHaveText(/^Send 1 group to \S+$/);
  // The user sends the push-back group to Claude too.
  await groups(page).nth(1).getByRole("button", { name: "Fix", exact: true }).click();
  await expect(status(page)).toHaveText("2 groups to fix.");
  await expect(primary(page)).toHaveText(/^Send 2 groups to \S+$/);

  // 4. The first send runs until Stop. The Tell box stays empty: the comments are no text of the user.
  await primary(page).click();
  await expect(status(page)).toHaveText(/^\S+ works on the PR comments for your change\.$/, { timeout: 60_000 });
  await more(page, "Stop");
  await expect(status(page)).toHaveText("2 comments on the PR wait for you.", { timeout: 60_000 });
  await expect(page.locator("[data-send]").first()).toContainText("Stopped");
  const box = page.getByRole("form", { name: /^Tell \S+$/ });
  await expect(box.getByRole("textbox", { name: /^Tell \S+$/ })).toHaveValue("");
  expect((await taskRemote()).heads[branch]).toBeTruthy();

  // 5. Sort and send again. Claude fixes one thread and pushes back on the other. The commit and the own review follow.
  await control("claude", { ...CLAUDE, seq: { ...CLAUDE.seq, "implement:comments": [WELL, WELL] } });
  const pushed = (await taskRemote()).heads[branch];
  await primary(page).click();
  await expect(status(page)).toHaveText("1 group to fix, 1 to push back.", { timeout: 120_000 });
  await groups(page).nth(1).getByRole("button", { name: "Fix", exact: true }).click();
  await primary(page).click();
  await expect(status(page)).toHaveText("Your change has new commits that are not on the server yet.", { timeout: 180_000 });
  await expect(primary(page)).toHaveText(`Push to ${branch}`);
  await page.getByRole("tab", { name: "Log" }).click();
  await expect(page.locator("[data-send]").first()).toContainText("PR comments");
  await expect(page.locator("[data-send]").first()).toContainText("Comments: 1 fixed, 1 pushed back.");
  expect((await taskRemote()).heads[branch]).toBe(pushed);

  // 6. The PR view shows the drafts: "Fixed in <short>" and the push-back reason. Accept both. Nothing posts yet.
  await more(page, "Go to the PR");
  await openThread(page, RENAME);
  await expect(card(page, RENAME)).toContainText(/Fixed in [0-9a-f]{7,}: The title now says that it works well\./, { timeout: 30_000 });
  await card(page, RENAME).getByRole("button", { name: "Accept" }).click();
  await expect(card(page, RENAME)).toContainText("Accepted");
  await openThread(page, KEEP);
  await expect(card(page, KEEP)).toContainText("The test guards the title, so it stays.");
  await card(page, KEEP).getByRole("button", { name: "Accept" }).click();
  await expect(card(page, KEEP)).toContainText("Accepted");
  expect(await taskPrComments()).toEqual([]);

  // 7. Fix on the task PR opens the Task view (AC-B397). One confirm pushes, then posts both replies under their threads (AC-B395).
  await page.locator(`#t-${RENAME}`).getByRole("button", { name: "Fix", exact: true }).click();
  await page.waitForURL(/\/tasks\/\d+$/);
  await expect(status(page)).toHaveText("Your change has new commits that are not on the server yet. 2 replies wait.", { timeout: 30_000 });
  await expect(primary(page)).toHaveText("Push and post 2 replies");
  await primary(page).click();
  const confirm = page.getByRole("dialog", { name: `Push to ${branch} and post 2 replies?` });
  await expect(confirm.getByRole("list", { name: "Replies" }).getByRole("listitem")).toHaveCount(2);
  await confirm.getByRole("button", { name: "Push and post" }).click();
  await expect.poll(async () => (await taskPrComments()).length, { timeout: 60_000 }).toBe(2);
  const bodies = await taskPrComments();
  expect(bodies.map((b) => b.parent?.id).sort()).toEqual([RENAME, KEEP].sort());
  expect(bodies.find((b) => b.parent?.id === RENAME)?.text).toMatch(/Fixed in [0-9a-f]{7,}: /);
  expect((await taskRemote()).heads[branch]).not.toBe(pushed);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
