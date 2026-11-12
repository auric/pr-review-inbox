// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.3 and 6.7: the setup commands in the browser. The plan screen lists the saved commands first,
// then the new ones, each with "Time limit (min)" and the reason of a proposed limit. The Log tab shows the output of a running setup
// command. A setup command that reaches its time limit shows "time limit" and the status with "Change the time limit". The dialog
// saves the new limit, and "Run setup again" lets the build go on. Settings > Commands has its own heading and section link, and it
// saves the "Shared task folder" switch.
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
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const REPO = "PROJ1/sample-repo-2";
const SETTINGS = `/api/repos/${REPO}/task-settings`;
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
// The setup command prints one line, then works for 10 s. Its first limit of 6 s stops it.
const DEPS = ["bun", "-e", "console.log('downloading packages'); await Bun.sleep(10000); console.log('packages done')"];
const REASON = "It downloads the packages.";
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
  testing: {
    commands: [
      { name: "deps", kind: "setup", argv: DEPS, timeoutSec: 6, timeoutReason: REASON },
      { name: "test", kind: "test", argv: ["bun", "test"] },
    ],
    services: [],
    notes: "",
    allow: [],
  },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
};
const README_TEST = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("the README title says that the app works", () => expect(readFileSync("README.md", "utf8")).toContain("works"));
`;
const CLAUDE = {
  stream: "task",
  spec: SPEC,
  review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
  seq: {
    "implement:tests": [{ writes: [{ path: "repo/tests/readme.test.ts", text: README_TEST }] }],
    "implement:implement": [{ writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
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

type Settings = { commands: { id: string; name: string; timeoutSec: number }[]; taskCache: boolean } & Record<string, unknown>;
const settings = async (page: Page) => (await api(page, "GET", SETTINGS)).json as Settings;
const status = (page: Page) => page.locator("#task-status");
const primary = (page: Page) => page.locator("[data-primary]");
const names = (page: Page) =>
  page.locator("[data-command-row] input[id$='-name']").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const more = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

test("setup: saved commands first, the time limit with its reason, the live output, Change the time limit, and the shared task folder", async ({
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
  // One saved command of the repository. The plan proposes deps and test.
  const version = { id: "cmd1", name: "version", kind: "lint", argv: ["bun", "--version"], timeoutSec: 600 };
  const saved = {
    specDir: "specs/{key}/",
    lineBudget: 400,
    maxOpen: 2,
    approvals: 1,
    commands: [version],
    testGlobs: null,
    excludeGlobs: null,
    isolateHome: true,
  };
  expect((await api(page, "PUT", SETTINGS, saved)).status).toBe(200);
  await page.reload();

  // 1. The plan screen: the saved command first, then the proposals. Setup gets the proposed limit with Claude's reason.
  await buildTask(page, REPO);
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  await expect.poll(() => names(page)).toEqual(["version", "deps", "test"]);
  await expect(page.getByLabel("Time limit (min) of version")).toHaveValue("10");
  await expect(page.getByLabel("Time limit (min) of deps")).toHaveValue("0.1");
  await expect(page.getByLabel("Time limit (min) of test")).toHaveValue("10");
  await expect(page.locator("[data-command-row]", { hasText: REASON })).toHaveCount(1);
  await expect(page.getByText("Commands run one at a time, top to bottom. Setup runs first, once per worktree.")).toBeVisible();
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();

  // 2. The Log tab shows the setup output while the command runs. At its limit, the row says "time limit".
  await page.getByRole("tab", { name: "Log" }).click();
  const running = page.locator("[data-command='running']");
  await expect(running).toContainText("deps", { timeout: 60_000 });
  await expect(running).toContainText("running");
  await expect(running).toContainText("downloading packages");
  await expect(status(page)).toHaveText('Needs you: the setup command "deps" of part 1 reached its time limit of 0.1 min.', {
    timeout: 60_000,
  });
  await expect(page.locator("[data-task-item] details", { hasText: "deps" }).first()).toContainText("time limit 0.1 min");
  await expect(page.locator("[data-command='running']")).toHaveCount(0);

  // 3. Change the time limit: the dialog opens at the row of deps. Save stores the new limit.
  await expect(primary(page)).toHaveText("Change the time limit");
  await primary(page).click();
  const dialog = page.getByRole("dialog", { name: "Change the time limit" });
  const limit = dialog.getByLabel("Time limit (min) of deps");
  await expect(limit).toBeFocused();
  await expect(limit).toHaveValue("0.1");
  await limit.fill("999");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Fix the marked command first.");
  await limit.fill("1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => (await settings(page)).commands.map((c) => [c.name, c.timeoutSec]))
    .toEqual([
      ["version", 600],
      ["deps", 60],
      ["test", 600],
    ]);

  // 4. Run setup again passes with the new limit, and the build goes on to the own review.
  await more(page, "Run setup again");
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 240_000 });
  await expect(page.locator("[data-task-item] details", { hasText: "deps" }).first()).toContainText("exit 0");

  // 5. Settings > Commands has its own heading and section link. The Tasks link goes to the Tasks heading.
  await openApp(page, "/settings/commands");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(page.getByRole("heading", { level: 2, name: "Commands", exact: true })).toBeFocused();
  await expect(nav.locator("[aria-current='true']")).toHaveText("Commands");
  await expect(nav.getByRole("link", { name: "Commands", exact: true })).toHaveAttribute("href", "/settings/commands");
  await nav.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Tasks", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/\/settings\/tasks$/);
  await nav.getByRole("link", { name: "Commands", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Commands", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/\/settings\/commands$/);

  // 6. The "Shared task folder" switch is off, warns about the empty home folder, and saves at once.
  const box = page.locator(`[data-task-commands='${REPO}']`);
  await box.locator("summary").click();
  const cache = box.getByRole("switch", { name: "Shared task folder" });
  await expect(cache).not.toBeChecked();
  await expect(box.locator("[data-task-cache]")).toContainText("REVIEW_LOOP_TASK_CACHE");
  await expect(box.locator("[data-task-cache]")).toContainText("caches in the home folder do not survive");
  await cache.click();
  await expect.poll(async () => (await settings(page)).taskCache).toBe(true);
  await expect(box.getByLabel("Time limit (min) of deps")).toHaveValue("1");
});
