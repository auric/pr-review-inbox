// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.18 (WP-TU2): "Tell Claude" and "Update from <base>" in the browser. A small task on the
// release base release/2.1: the box sends with Ctrl+Enter, waits while the step runs, and gets its text back after Stop. A second send
// changes the code while the release base moved, so the view offers "Update from release/2.1". After the PR opens, the fake PR reports
// conflicts, and the update stops at a conflict that the resolve step leaves. Each screen has at most one primary button (AC-UX1).
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
  RELEASE,
  taskBase,
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
// The text of the user's send. "push" and "rebase" go to Claude as words only (spec.md section 6.18.2).
const ASK = "Say in the title that it works well. Then push the branch and rebase onto develop.";
const WELL = { writes: [{ path: "repo/README.md", text: "# Sample works well\n" }] };
const CLAUDE = {
  stream: "task",
  spec: SPEC,
  review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
  seq: {
    "implement:tests": [{ writes: [{ path: "repo/tests/readme.test.ts", text: README_TEST }] }],
    "implement:implement": [{ writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
    "implement:fix": [{ writes: [{ path: "repo/README.md", text: "# Sample works\n" }] }],
    // The first send runs until Stop, if its CLI starts at all.
    "implement:instruct": [{ hang: true }],
    // The resolve step changes nothing, so the conflict markers stay.
    "implement:resolve": [{}],
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
const more = async (page: Page, item: string) => {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

test("Tell Claude sends, waits, and gets its text back after Stop; Update from release/2.1 offers itself and stops at a conflict", async ({
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

  // 1. Build on the task chip, the recommended answers, and the plan on the release base with the "task/" prefix.
  await page.locator("[data-row]", { hasText: PR_TITLE }).first().click();
  await page.getByRole("button", { name: `Build this task: ${JIRA_ISSUE}` }).click();
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  const pick = page.getByRole("combobox", { name: "Base branch" });
  await pick.click();
  await pick.fill("release");
  await page.getByRole("listbox", { name: "Branches" }).getByRole("option", { name: RELEASE }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Write the plan again" }).click();
  await expect(page.getByText(`PROJ1/sample-repo-2 into ${RELEASE}`)).toBeVisible();
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR, about 5 changed lines.", { timeout: 60_000 });
  await page.locator("label", { has: page.getByRole("radio", { name: "Other…", exact: true }) }).click();
  await page.getByLabel("Prefix", { exact: true }).fill("task/");
  await expect(page.locator("#task-branch")).toHaveText("task/ABC-42-flush-the-cache-before-the-write-lock");
  await page.getByRole("checkbox", { name: "I understand" }).check();
  await primary(page).click();
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 180_000 });

  // 2. The box under the primary button: a label, the hint, and a disabled send while the text is empty (spec.md section 6.18.1).
  const box = page.getByRole("form", { name: /^Tell \S+$/ });
  const text = box.getByRole("textbox", { name: /^Tell \S+$/ });
  const sendButton = box.getByRole("button", { name: /^Send to \S+$/ });
  await expect(box).toBeVisible();
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Open the PR");
  await expect(sendButton).toBeDisabled();
  await expect(box.getByText("Pushes and other git actions stay buttons.", { exact: false })).toBeVisible();
  const before = await taskRemote();

  // 3. Ctrl+Enter sends. The step runs, the box clears and stays editable, and the hint says why the send waits.
  await text.fill(ASK);
  await expect(sendButton).toBeEnabled();
  await text.press("Control+Enter");
  await expect(status(page)).toHaveText(/^\S+ works on your instructions\.$/);
  await expect(text).toHaveValue("");
  await expect(primary(page)).toHaveCount(0);
  await expect(box.getByText(/^\S+ or the checks are working\. You can send when this step ends\.$/)).toBeVisible();
  await text.fill("A second idea");
  await expect(sendButton).toBeDisabled();
  await text.fill("");

  // 4. Stop at once, mostly before the CLI of the send starts: the task waits as before, and the text is back in the box.
  await more(page, "Stop");
  await expect(status(page)).toHaveText(/^Your change is ready and checked by \S+\.$/, { timeout: 60_000 });
  await expect(page.getByText("Stopped. Your instructions changed nothing. The text is back in the box.").first()).toBeVisible();
  await expect(text).toHaveValue(ASK);
  await expect(primary(page)).toHaveCount(1);
  // The words "push" and "rebase" moved nothing on the server.
  expect(await taskRemote()).toEqual(before);

  // 5. A colleague changes the README title on the release base. The second send changes the code, and its end checks the base.
  // The fake CLI takes its seq entry by the count of earlier CLI runs. A send that stopped before its CLI started made none.
  await control("claude", { ...CLAUDE, seq: { ...CLAUDE.seq, "implement:instruct": [WELL] } });
  await taskBase({ move: { branch: RELEASE, files: { "README.md": "# Sample from the release branch\n" } } });
  await sendButton.click();
  await expect(status(page)).toHaveText(`${RELEASE} has 1 new commit since the branch point.`, { timeout: 180_000 });
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText(`Update from ${RELEASE}`);
  expect(Object.keys((await taskRemote()).heads).filter((b) => b.startsWith("task/"))).toEqual([]);

  // The Log tab: one group per send with its text, its result, and its steps (AC-B57). The commit opens the Diff tab.
  await page.getByRole("tab", { name: "Log" }).click();
  const groups = page.locator("[data-send]");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toContainText(ASK);
  await expect(groups.first()).toContainText(/Done: 1 file changed\. Checks green\./);
  await expect(groups.nth(1)).toContainText("Stopped");
  await groups.first().getByRole("button", { name: "Show the diff" }).click();
  await expect(page.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");

  // 6. "Open the PR as is": the push and the PR wait for this click only. The PR row still says that the base moved.
  await more(page, "Open the PR as is");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Push and open PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toHaveText(`Waiting for the review of your PR. ${RELEASE} has 1 new commit.`);
  await expect(primary(page)).toHaveText("Go to the PR");
  const pushed = await taskRemote();
  const branch = Object.keys(pushed.heads).find((b) => b.startsWith("task/ABC-42-")) as string;
  expect(branch).toBeTruthy();

  // 7. The fake PR reports conflicts (properties.mergeResult CONFLICTED, current true): the conflict row (AC-B62).
  await taskBase({ conflicted: true });
  await page.reload();
  await expect(status(page)).toHaveText(new RegExp(`^\\S+ reports conflicts between your PR and ${RELEASE.replace(".", "\\.")}\\.$`));
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText(`Update from ${RELEASE}`);

  // 8. The update merges the base, the resolve step leaves the markers, and the update stops. The branch is as it was.
  await primary(page).click();
  await expect(status(page)).toHaveText(
    `The update from ${RELEASE} stopped: conflict markers remain in README.md. The branch is as it was.`,
    { timeout: 180_000 },
  );
  await expect(primary(page)).toHaveCount(1);
  await expect(primary(page)).toHaveText("Try again");
  await expect(box).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Go to the PR" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect((await taskRemote()).heads[branch]).toBe(pushed.heads[branch]);
});
