// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A task link on a phone: the narrow layout opens /tasks/<id> at the task, not at the Tasks list, and the URL keeps the task.
// Runs against serve.ts only: the fake Bitbucket, the fake Jira, and the fake CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_ISSUE, JIRA_URL, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
// fixtures/jira/issue.json: the summary of ABC-42 is the task title.
const TITLE = "Flush the cache before the write lock";

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

test("a task link opened at 390 px shows the task, and the URL keeps it", async ({ page }) => {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  expect((await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).status).toBe(200);
  const created = await api(page, "POST", "/api/tasks", { project: "PROJ1", repo: "sample-repo-2", key: JIRA_ISSUE });
  expect(created.status).toBe(201);
  const path = `/tasks/${(created.json as { id: number }).id}`;

  await page.setViewportSize({ width: 390, height: 800 });
  await openApp(page, path);
  await expect(page.getByRole("heading", { level: 2, name: TITLE })).toBeVisible();
  await expect(page.locator("#task-status")).toBeVisible();
  await expect(page.locator("[data-row]", { hasText: TITLE })).toBeHidden();
  await expect(page).toHaveURL(`${APP}${path}`);
});
