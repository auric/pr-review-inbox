// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.21 (WP-C2c): "Commands Claude may run" in the browser. Settings > Tasks shows the first-use
// warning before the first pattern and the confirm before Most commands; Cancel and Esc change nothing and give the focus back. The plan
// screen offers Claude's proposals with ticks, and the approval shows the first-use warning. A step asks to allow three commands, and
// the row takes Allow once, Allow for this repository, and Refuse. The header names the mode, and the Log tab and the run log show the
// commands that Claude ran. Settings then shows the server's reason for a pattern, saves "Longest command", and turns on Most commands, then Unrestricted.
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
  makeClone,
  openApp,
} from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const PR_TITLE = "Batch cache writes in the sync worker";
const REPO = "PROJ1/sample-repo-2";
const SETTINGS = `/api/repos/${REPO}/task-settings`;
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const ANY_WRITE =
  "Most commands lets Claude run every command as you, with your files, your keys, and your network, except the fixed deny list. Claude can write any file that you can write.";
const UNRESTRICTED_START =
  "Unrestricted lets Claude run every command as you, with your files, your keys, and your network, except git and the Bitbucket and Jira hosts. A command such as bash -c can still run git. After each step, the app checks the git state and restores it.";
const WARNING_START = "Claude can run each command that matches this list, as you, with your files, your keys, and your network.";
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
    commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }],
    services: [],
    notes: "",
    allow: [
      { pattern: "bun run gen *", reason: "The tests read the files that this script makes." },
      { pattern: "node scripts/seed.js", reason: "The seed script fills the test data." },
    ],
  },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
};
const README_TEST = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("the README title says that the app works", () => expect(readFileSync("README.md", "utf8")).toContain("works"));
`;
const ASKS = [
  { pattern: "cmake --build *", command: "cmake --build repo/build", reason: "The step builds the native module." },
  { pattern: "ctest --test-dir *", command: "ctest --test-dir repo/build", reason: "The step runs the native tests." },
  { pattern: "pkg-config --libs *", command: "pkg-config --libs zlib", reason: "The build needs the zlib flags." },
];
const CLAUDE = {
  stream: "task",
  spec: SPEC,
  review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
  seq: {
    "implement:tests": [{ writes: [{ path: "repo/tests/readme.test.ts", text: README_TEST }] }],
    "implement:implement": [
      // Attempt 1: Claude Code refuses the build, and the step asks to allow three commands.
      {
        bash: [{ command: "cmake --build repo/build", refused: "allowlist" }],
        implement: {
          summary: "Claude Code refused a command.",
          done: false,
          tests: [],
          question: null,
          specChange: "",
          allowRequest: ASKS,
          notes: [],
          coverage: NO_COVERAGE,
        },
      },
      // Attempt 2 runs both commands and changes the README.
      {
        bash: [
          { command: "cmake --build repo/build", output: "[100%] Built target flush" },
          { command: "ctest --test-dir repo/build", output: "100% tests passed, 0 tests failed out of 4" },
        ],
        writes: [{ path: "repo/README.md", text: "# Sample works\n" }],
      },
    ],
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

type Shell = {
  shellMode: string;
  allow: { pattern: string; source: string }[];
  bashTimeoutSec: number;
  shellWarnedAt: number | null;
  runChecks: boolean;
};
const shell = async (page: Page) => (await api(page, "GET", SETTINGS)).json as Shell;
const status = (page: Page) => page.locator("#task-status");
const primary = (page: Page) => page.locator("[data-primary]");
const repoBox = (page: Page) => page.locator(`[data-task-commands='${REPO}']`);
const openRepo = async (page: Page) => {
  await openApp(page, "/settings/tasks");
  await repoBox(page).locator("summary").click();
  await expect(repoBox(page).locator("[data-shell-settings]")).toBeVisible();
};

test("Commands Claude may run: the warnings, the plan picks, an allow request with three choices, the Log rows, and Settings", async ({
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

  // 1. Build on the task chip. The questions wait, so the repository shows in Settings > Tasks.
  await page.locator("[data-row]", { hasText: PR_TITLE }).first().click();
  await page.getByRole("button", { name: `Build this task: ${JIRA_ISSUE}` }).click();
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  const taskPath = new URL(page.url()).pathname;
  await expect(page.locator("[data-task-shell]")).toHaveText("Commands: allowlist, 0 patterns");

  // 2. Settings: the first pattern shows the first-use warning, and Cancel adds no row and gives the focus back to the button.
  await openRepo(page);
  const box = repoBox(page);
  const anyToggle = box.getByRole("button", { name: "Most commands" });
  await expect(box.getByRole("button", { name: "Allowlist" })).toHaveAttribute("aria-pressed", "true");
  const add = box.getByRole("button", { name: "Add a pattern" });
  await add.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Commands that Claude runs" })).toBeVisible();
  await expect(dialog).toContainText(WARNING_START);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await expect(box.locator("[data-allow-row]")).toHaveCount(0);
  // Most commands shows its confirm each time. Esc changes nothing and gives the focus back to the toggle.
  await anyToggle.click();
  await expect(dialog.getByRole("heading", { name: "Turn on Most commands?" })).toBeVisible();
  await expect(dialog).toContainText(ANY_WRITE);
  await expect(dialog.getByRole("button", { name: "Turn on Most commands" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(anyToggle).toBeFocused();
  await expect(anyToggle).toHaveAttribute("aria-pressed", "false");
  // spec.md section 6.21.1: the help next to the mode switch, and the switch of the approved checks with the first-use warning.
  await expect(box.getByText("Applies to the next step. A running step keeps its mode.")).toBeVisible();
  const checks = box.getByRole("switch", { name: /may run the approved checks$/ });
  await expect(checks).not.toBeChecked();
  await checks.click();
  await expect(dialog).toContainText(WARNING_START);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(checks).toBeFocused();
  await expect(checks).not.toBeChecked();
  expect(await shell(page)).toMatchObject({ shellMode: "allowlist", allow: [], shellWarnedAt: null, runChecks: false });

  // 3. The plan offers Claude's proposals ticked, each with its reason. An interpreter pattern shows its warning.
  await openApp(page, taskPath);
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  const plan = page.locator("[data-plan-allow]");
  await expect(plan.getByRole("checkbox", { name: "Allow bun run gen *" })).toBeChecked();
  await expect(plan.getByRole("textbox", { name: "Reason for bun run gen *" })).toHaveValue(SPEC.testing.allow[0]?.reason as string);
  await expect(plan.locator("[data-allow-row='node scripts/seed.js']")).toContainText("This pattern lets Claude run any code.");
  await plan.getByRole("checkbox", { name: "Allow node scripts/seed.js" }).uncheck();
  await page.getByRole("checkbox", { name: "I understand" }).check();
  // The approval shows the first-use warning. Cancel sends nothing and gives the focus back to the primary button.
  await primary(page).click();
  await expect(dialog).toContainText(WARNING_START);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(primary(page)).toBeFocused();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.");
  await primary(page).click();
  await dialog.getByRole("button", { name: "I understand" }).click();

  // 4. The code step asks to allow three commands. The header names the list of the repository.
  await expect(status(page)).toHaveText("Needs you: Claude asks to allow a command.", { timeout: 180_000 });
  await expect(page.locator("[data-task-shell]")).toHaveText("Commands: allowlist, 1 pattern");
  const form = page.getByRole("form", { name: /^\S+ asks to allow 3 commands\.$/ });
  await expect(form).toBeVisible();
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Continue");
  for (const a of ASKS) {
    const row = form.locator(`[data-allow-ask='${a.pattern}']`);
    await expect(row).toContainText(a.command);
    await expect(row).toContainText(a.reason);
    await expect(row.getByRole("radio", { name: "Allow once" })).toBeChecked();
  }
  // The keyboard moves the choice of the second command; a click refuses the third.
  const second = form.locator(`[data-allow-ask='${ASKS[1]?.pattern}']`);
  await second.getByRole("radio", { name: "Allow once" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(second.getByRole("radio", { name: "Allow for this repository" })).toBeChecked();
  await form.locator(`[data-allow-ask='${ASKS[2]?.pattern}']`).getByRole("radio", { name: "Refuse" }).check();
  await primary(page).click();
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 180_000 });
  await expect(page.locator("[data-task-shell]")).toHaveText("Commands: allowlist, 2 patterns");
  expect((await shell(page)).allow.map((a) => [a.pattern, a.source])).toEqual([
    ["bun run gen *", "plan"],
    ["ctest --test-dir *", "request"],
  ]);

  // 5. The Log tab: the asking step lists the choices and its refused command; the next try lists the commands that Claude ran.
  await page.getByRole("tab", { name: "Log" }).click();
  const asked = page.locator("[data-task-item]").filter({ has: page.locator("[data-allow-decision]") });
  await expect(asked).toHaveCount(1);
  await expect(asked.locator("[data-allow-decision]")).toHaveText([
    "cmake --build *: allowed once",
    "ctest --test-dir *: allowed for this repository",
    "pkg-config --libs *: refused",
  ]);
  await expect(asked.locator("[data-step-shell] p")).toHaveText("Commands: allowlist, 1 pattern. Refused: 1");
  const ran = page.locator("[data-task-item]").filter({ has: page.locator("[data-shell-command='ok']") });
  await expect(ran).toHaveCount(1);
  await expect(ran).toContainText("try 2");
  await expect(ran.locator("[data-step-shell] p")).toHaveText("Commands: allowlist, 3 patterns");
  await ran.getByText(/^Commands \S+ ran \(2\)$/).click();
  await expect(ran.locator("[data-shell-command='ok'] code")).toHaveText(["cmake --build repo/build", "ctest --test-dir repo/build"]);
  // The run log shows each command as code and its output folded.
  await ran.getByRole("button", { name: "Run log" }).click();
  const bash = page.locator("[data-bash]");
  await expect(bash.locator("code")).toHaveText(["cmake --build repo/build", "ctest --test-dir repo/build"]);
  const output = bash.first().getByText("Output", { exact: true });
  await expect(bash.first().locator("pre")).toBeHidden();
  await output.focus();
  await page.keyboard.press("Enter");
  await expect(bash.first().locator("pre")).toHaveText("[100%] Built target flush");
  await page.keyboard.press("Escape");
  await expect(bash).toHaveCount(0);

  // 6. Settings: the list of the repository. A new pattern needs no warning now. The page refuses git, and the server refuses a host.
  await openRepo(page);
  await expect(box.locator("[data-allow-row]")).toHaveCount(2);
  await expect(box.locator("[data-allow-source]")).toHaveText(["from a plan", "from a request"]);
  await add.click();
  await expect(dialog).toHaveCount(0);
  const fresh = box.locator("[data-allow-row]").last().getByRole("textbox").first();
  await expect(fresh).toBeFocused();
  await fresh.fill("git status");
  await expect(box.locator("[data-allow-row]").last()).toContainText("Claude cannot run git commands.");
  const saveLine = page.locator("#task-cmd-PROJ1-sample-repo-2-status");
  await expect(saveLine).toHaveText("A marked pattern is not saved. Fix it to save the list.");
  const host = new URL(FAKE_URL).hostname;
  await fresh.fill(`ping ${host}`);
  await fresh.blur();
  await expect(saveLine).toContainText(`Not saved. ping ${host}: A pattern cannot name the Bitbucket or Jira host.`);
  await fresh.fill("ninja -C repo/build");
  await box.getByRole("textbox", { name: "Reason for ninja -C repo/build" }).fill("The step builds with ninja.");
  await box.getByLabel("Longest command").fill("15");
  await box.getByLabel("Longest command").blur();
  await expect(saveLine).toHaveText("Saved. The next step uses these commands.");
  await expect.poll(async () => (await shell(page)).bashTimeoutSec).toBe(900);
  expect((await shell(page)).allow.map((a) => a.pattern)).toEqual(["bun run gen *", "ctest --test-dir *", "ninja -C repo/build"]);
  // Most commands: the confirm turns it on.
  await anyToggle.click();
  await dialog.getByRole("button", { name: "Turn on Most commands" }).click();
  await expect(dialog).toBeHidden();
  await expect(anyToggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await shell(page)).shellMode).toBe("any");

  // 7. The header names Most commands.
  await openApp(page, taskPath);
  await expect(page.locator("[data-task-shell]")).toHaveText("Commands: most commands");

  // 8. Unrestricted shows its own dialog each time. Cancel changes nothing. The confirm turns it on, and the header names it.
  await openRepo(page);
  const unrestricted = box.getByRole("button", { name: "Unrestricted" });
  await unrestricted.click();
  await expect(dialog.getByRole("heading", { name: "Turn on Unrestricted?" })).toBeVisible();
  await expect(dialog).toContainText(UNRESTRICTED_START);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(unrestricted).toBeFocused();
  await expect(unrestricted).toHaveAttribute("aria-pressed", "false");
  expect((await shell(page)).shellMode).toBe("any");
  await unrestricted.click();
  await dialog.getByRole("button", { name: "Turn on Unrestricted" }).click();
  await expect(dialog).toBeHidden();
  await expect(unrestricted).toHaveAttribute("aria-pressed", "true");
  await expect(box.locator(`#task-cmd-PROJ1-sample-repo-2-mode-line`)).toContainText("except these: git and commands that name the");
  await expect.poll(async () => (await shell(page)).shellMode).toBe("unrestricted");
  await openApp(page, taskPath);
  await expect(page.locator("[data-task-shell]")).toHaveText("Commands: unrestricted");
});

// check-fix.md: a fix step that changes no file stops the task with a question, Continue and See why. The switch of the approved checks
// gives the next fix step the test command, and the header and the Log tab count it.
test("a fix step that changes no file asks; the approved checks switch gives the next fix step the test command", async ({ page }) => {
  test.setTimeout(600_000);
  const todo = { path: "repo/README.md", text: "# Sample todo\n" };
  await control("claude", {
    ...CLAUDE,
    spec: { ...SPEC, testing: { ...SPEC.testing, allow: [] } },
    seq: {
      "implement:tests": [{ writes: [{ path: "repo/tests/readme.test.ts", text: README_TEST }] }],
      "implement:implement": [{ writes: [todo] }],
      // Try 1 changes no file. Try 2 makes the test pass.
      "implement:fix": [{ writes: [] }, { writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
    },
  } satisfies ClaudeScenario);
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
  const taskPath = new URL(page.url()).pathname;
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();

  // The fix step changes no file: the task asks at once, with Continue and See why.
  await expect(status(page)).toHaveText("Needs you: the fix step of part 1 changed no file. See why.", { timeout: 180_000 });
  await expect(primary(page)).toHaveText("Continue");
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "See why" }).click();
  await expect(page.getByRole("tab", { name: "Log" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-task-item]:focus")).toContainText("Fix");
  // The checks on the part base ran once, before the first step of Claude.
  await expect(page.locator("[data-task-item]", { hasText: "The approved checks on the part base" })).toHaveCount(1);

  // Settings: the switch needs the first-use warning. Then the header counts the test command.
  await openRepo(page);
  const box = repoBox(page);
  await box.getByRole("switch", { name: /may run the approved checks$/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "I understand" }).click();
  await expect(box.getByRole("switch", { name: /may run the approved checks$/ })).toBeChecked();
  await expect.poll(async () => (await shell(page)).runChecks).toBe(true);
  await openApp(page, taskPath);
  await expect(page.locator("[data-task-shell]")).toHaveText("Commands: allowlist, 0 patterns, 1 approved check");

  // Continue: the next fix step can run the test command, and the build ends green.
  await primary(page).click();
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 180_000 });
  await page.getByRole("tab", { name: "Log" }).click();
  // Resume runs the code step of the task again, then the fix: both are try 2, and both can run the test command.
  const second = page.locator("[data-task-item]", { hasText: "try 2" }).filter({ has: page.locator("[data-step-shell]") });
  await expect(second.locator("[data-step-shell] p")).toHaveText([
    "Commands: allowlist, 0 patterns, 1 approved check",
    "Commands: allowlist, 0 patterns, 1 approved check",
  ]);
});
