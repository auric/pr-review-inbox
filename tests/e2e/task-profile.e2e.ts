// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.19.1 (AC-B71): the "Profile" select of the Build form. It lists the review profiles only,
// the created task shows its profile in the header, and the next form of the same repository preselects it. Section 6.12: the
// "Main repository" combobox also lists the repositories that the token can push to, with no PR in the inbox. Runs against serve.ts
// only: the fake Bitbucket, the fake Jira, the fake CLI, and a local git remote.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_ISSUE, JIRA_URL, openApp, pickRepo } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const REPO = "PROJ1/sample-repo-2";

const test = base.extend<{ seen: { urls: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      await control("reset");
      await use(seen);
      // Only the local app gets requests. Bitbucket and Jira get them from the server only.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
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

test("the Build form picks the profile of the task, the task header shows it, and the next form preselects it", async ({ page }) => {
  test.setTimeout(180_000);
  await control("claude", { stream: "task" });
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  // A second review profile beside the shipped Review and Explain profiles.
  const s = (await api(page, "GET", "/api/settings")).json as { baseUrl: string; profiles: { id: string; name: string }[] };
  const general = s.profiles.find((p) => p.id === "general");
  const profiles = [...s.profiles, { ...general, id: "strict", name: "Strict" }];
  expect((await api(page, "PUT", "/api/settings", { baseUrl: s.baseUrl, profiles })).status).toBe(200);
  await page.reload();

  await page.getByRole("button", { name: /^Tasks: / }).click();
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  const form = page.getByRole("form", { name: "Build a Jira task" });
  await form.getByLabel("Jira key").fill(JIRA_ISSUE);
  await pickRepo(form, REPO);
  const picker = form.getByLabel("Profile");
  // A repository with no task starts on the default profile. An Explain profile gives no code, so it is no choice.
  await expect(picker).toHaveValue("general");
  await expect(picker.locator("option")).toHaveText(["Review", "Strict"]);
  await picker.selectOption("strict");
  await form.getByRole("button", { name: "Read the task" }).click();
  await form.getByRole("button", { name: "Build this task" }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(page.locator("header").getByText("Profile: Strict")).toBeVisible();

  // The next form of the same repository starts on the profile of the newest task there.
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  await pickRepo(page.getByRole("form", { name: "Build a Jira task" }), REPO);
  await expect(page.getByRole("form", { name: "Build a Jira task" }).getByLabel("Profile")).toHaveValue("strict");
});

test("the Build form starts a task in a repository with no pull request, and a task repository stays a choice", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  await page.reload();

  await page.getByRole("button", { name: /^Tasks: / }).click();
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  const form = page.getByRole("form", { name: "Build a Jira task" });
  await form.getByLabel("Jira key").fill(JIRA_ISSUE);
  // PROJ1/app has no pull request. The forge list of the repositories with write names it.
  const field = form.getByLabel("Main repository");
  await field.fill("proj1/ap");
  const list = form.getByRole("listbox", { name: "Repositories" });
  await expect(list.getByRole("option")).toHaveText(["PROJ1/app"]);
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(field).toHaveValue("PROJ1/app");
  await form.getByRole("button", { name: "Read the task" }).click();
  await form.getByRole("button", { name: "Build this task" }).click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await expect(page.locator("#rows").getByText("PROJ1/app", { exact: true })).toBeVisible();

  // A failed forge list keeps the known repositories, and the list says why.
  await control("state", { noRepoList: true });
  await page.reload();
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  await form.getByLabel("Main repository").click();
  await expect(list.getByRole("option", { name: "PROJ1/app", exact: true })).toBeVisible();
  await expect(form.getByText(/Cannot list the other repositories\./)).toBeVisible();
});
