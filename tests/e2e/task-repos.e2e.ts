// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.12, 6.16.5, and 6.16.8 (WP-MR3; AC-B33, AC-B38, AC-B39, AC-B41, AC-B44 in the UI): a task of
// PROJ1/app, which holds the submodule PROJ1/lib on the fake Bitbucket and a submodule of another server. The plan lists the repositories
// with their access, a base picker each, and a proposal with Add and Skip. The build changes both repositories. "Push and open 2 PRs"
// pushes and creates the lib PR first. A refused create shows "Try again" on its row only, and the retry opens only that PR. The merged
// lib PR offers "Point PROJ1/app at the merged commit". Runs against serve.ts only: the fake Bitbucket, the fake Jira, the fake CLI, and
// temp git remotes.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_ISSUE, JIRA_URL, openApp, taskRepos } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
// fixtures/jira/issue.json: the summary of ABC-42 is the task title, and the first branch prefix of Settings > Tasks is feature/.
const BRANCH = "feature/ABC-42-flush-the-cache-before-the-write-lock";
const LIB = "PROJ1/lib";
const MAIN = "PROJ1/app";
const PROPOSED = "PROJ1/sample-repo-2";

const SPEC = {
  title: "Set the lib value",
  size: "small",
  estimate: { parts: 1, lines: 6, files: 2, modules: ["lib"], db: false, api: false, unknowns: [] },
  map: [{ path: "lib/lib.c", line: 1, symbol: "lib", kind: "change", what: "The lib value." }],
  change: "Set the lib value to 2.",
  design: null,
  spec: null,
  parts: [
    {
      n: 1,
      kind: "part",
      title: "Lib value",
      goal: "lib.c sets the value 2.",
      lines: 6,
      acceptance: [{ id: "A1", text: "lib.c sets the value 2." }],
      tests: [{ test: "tests/lib.test.ts", proves: ["A1"] }],
      tasks: [{ id: "T1", title: "Set the lib value", files: ["lib/lib.c"], run: ["tests/lib.test.ts"], done: "The lib test passes." }],
    },
  ],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
  repos: [{ project: "PROJ1", repo: "sample-repo-2", reason: "The client of the app lives there." }],
};
const LIB_TEST = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("lib sets the value 2", () => expect(readFileSync("lib/lib.c", "utf8")).toContain("lib = 2"));
`;

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      context.on("weberror", (e) => seen.logs.push(e.error().message));
      await control("reset");
      await use(seen);
      // Only the local app gets requests. Bitbucket and Jira get them from the server only.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN) || l.includes(E2E_JIRA_TOKEN))).toEqual([]);
    },
    { auto: true },
  ],
});

// A call to the app API with the session token of the page, as the page itself sends it.
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
const createOf = (repo: "app" | "lib") => `POST /rest/api/1.0/projects/PROJ1/repos/${repo}/pull-requests`;

test("several repositories: the plan with access and a proposal, two PR rows, a refused create, Try again, and the pointer", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await control("claude", {
    stream: "task",
    spec: SPEC,
    review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
    seq: {
      "implement:tests": [{ writes: [{ path: "repo/tests/lib.test.ts", text: LIB_TEST }] }],
      "implement:implement": [{ writes: [{ path: "repo/lib/lib.c", text: "int lib = 2;\n" }] }],
    },
  });
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  // Setup that the user does once: Jira, and the clone of PROJ1/app with the git identity of the commits.
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  await taskRepos({ clone: true });
  const created = await api(page, "POST", "/api/tasks", { project: "PROJ1", repo: "app", key: JIRA_ISSUE });
  expect(created.status).toBe(201);
  await openApp(page, `/tasks/${(created.json as { id: number }).id}`);
  await expect(status(page)).toHaveText(/^\S+ has 2 questions before it writes the plan\.$/, { timeout: 60_000 });
  await page.getByRole("form", { name: "Questions" }).getByRole("button", { name: "Send answers" }).click();

  // 1. AC-B33, AC-B44: the plan lists each repository with its access and the reason of the one that the task cannot change. Each one
  // that the task changes has its own base picker. The proposal of the spec run shows with Add and Skip.
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR per changed repository, about 6 changed lines.", {
    timeout: 60_000,
  });
  const list = page.getByRole("list", { name: "Repositories of the task" }).getByRole("listitem");
  await expect(list).toHaveCount(3);
  await expect(list.nth(0)).toContainText(`${MAIN}Main repositoryCan change`);
  await expect(list.nth(1)).toContainText(`${LIB}Submodule at libCan change`);
  await expect(list.nth(2)).toContainText("vendorSubmodule at vendorNot available");
  await expect(list.nth(2)).toContainText("It comes from another server.");
  await expect(page.getByRole("combobox", { name: `Base branch of ${MAIN}` })).toHaveValue("main");
  await expect(page.getByRole("combobox", { name: `Base branch of ${LIB}` })).toHaveValue("main");
  await expect(page.getByRole("combobox", { name: "Base branch" })).toHaveCount(2);
  const proposal = page.getByRole("region", { name: new RegExp(`proposes another repository: ${PROPOSED}`) });
  await expect(proposal).toContainText("The client of the app lives there.");
  await expect(proposal.getByRole("button", { name: `Add ${PROPOSED}` })).toBeVisible();
  // Skip keeps the plan, and the proposal goes.
  await proposal.getByRole("button", { name: `Skip ${PROPOSED}` }).click();
  await expect(proposal).toHaveCount(0);
  await expect(status(page)).toHaveText("The plan is ready: small, 1 PR per changed repository, about 6 changed lines.");
  await page.getByRole("checkbox", { name: "I understand" }).check();
  const sent = page.waitForRequest((r) => r.method() === "POST" && /\/api\/tasks\/\d+\/plan$/.test(r.url()));
  await primary(page).click();
  const bases = ((await sent).postDataJSON() as { bases?: { branch: string }[] }).bases;
  expect(bases?.map((b) => b.branch)).toEqual(["main", "main"]);

  // 2. The build changes both repositories. Nothing goes out before the click.
  await expect(status(page)).toHaveText(/^Your change in 2 repositories is ready and checked by \S+\.$/, { timeout: 180_000 });
  await expect(primary(page)).toHaveText("Open 2 PRs");
  const before = await taskRepos();
  expect([Object.keys(before.heads.app), Object.keys(before.heads.lib), before.creates]).toEqual([["main"], ["main"], []]);

  // 3. AC-B38, AC-B39: one dialog with a row per repository, the submodule first. The create of lib is refused once: its row says why
  // and has its own Try again; the PR of app opens.
  await taskRepos({ refuse: true });
  await primary(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(`Push ${BRANCH} and open 2 PRs?`);
  const row = (name: string) => dialog.locator(`[data-pr-row="${name}"]`);
  await expect(dialog.locator("[data-pr-row]")).toHaveCount(2);
  await expect(dialog.locator("[data-pr-row]").first()).toHaveAttribute("data-pr-row", LIB);
  await expect(row(LIB)).toContainText(`${BRANCH} → main`);
  await expect(row(LIB)).toContainText("Waiting");
  await dialog.getByRole("button", { name: "Push and open 2 PRs" }).click();
  await expect(row(LIB)).toContainText(`Failed: The token cannot create pull requests in ${LIB}.`, { timeout: 60_000 });
  await expect(row(MAIN)).toContainText("PR #101 open");
  await expect(row(LIB).getByRole("button", { name: `Try again for ${LIB}` })).toBeVisible();
  await expect(row(MAIN).getByRole("button")).toHaveCount(0);
  await expect(dialog.getByText("1 of 2 PRs are open.")).toBeVisible();
  await expect(status(page)).toHaveText(`1 of 2 PRs are open. The PR for ${LIB} failed.`);
  const partial = await taskRepos();
  // Both branches went out before the first create, and the lib create came first.
  expect(partial.heads.lib[BRANCH]).toBeTruthy();
  expect(partial.heads.app[BRANCH]).toBeTruthy();
  expect(partial.creates).toEqual([createOf("lib"), createOf("app")]);

  // 4. Try again of the lib row opens only its PR. The dialog closes when every row has its PR, and both PRs link the other one.
  await row(LIB)
    .getByRole("button", { name: `Try again for ${LIB}` })
    .click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(status(page)).toHaveText("All 2 PRs are open. Waiting for the review of your PR. Nothing to do.");
  const open = await taskRepos();
  expect(open.creates).toEqual([createOf("lib"), createOf("app"), createOf("lib")]);
  expect(open.prs.lib[0]?.description).toContain(`Related PRs:\n- [${MAIN} #101](`);
  expect(open.prs.app[0]?.description).toContain(`Related PRs:\n- [${LIB} #101](`);
  await expect(page.getByRole("list", { name: "Pull requests of the task" })).toContainText(`${LIB}PR #101 open`);

  // 5. AC-B41: the lib PR merges. PROJ1/app still points at the task branch commit of lib until the click; the click commits the gitlink
  // at the merge commit and pushes the app branch with its lease.
  const merged = await taskRepos({ merge: true });
  await expect(status(page)).toHaveText(`The ${LIB} PR merged. ${MAIN} still points at the task branch commit.`, { timeout: 30_000 });
  await expect(primary(page)).toHaveText(`Point ${MAIN} at the merged commit`);
  expect((await taskRepos({ branch: BRANCH })).gitlink).toBe(open.heads.lib[BRANCH]);
  await primary(page).click();
  await expect(status(page)).toHaveText("Waiting for the review of your PR. Nothing to do.", { timeout: 60_000 });
  const pointed = await taskRepos({ branch: BRANCH });
  expect(pointed.gitlink).toBe(merged.merged);
  expect(pointed.heads.app[BRANCH]).not.toBe(open.heads.app[BRANCH]);
  // The pointer move opens no PR.
  expect(pointed.creates).toHaveLength(3);
});
