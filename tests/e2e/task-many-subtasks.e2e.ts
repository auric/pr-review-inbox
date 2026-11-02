// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.20.1: the Build form of a Jira task with many sub-tasks in a short window. The parent BIG-1 has
// 40 open sub-tasks, so the form is taller than the window. The form scrolls inside the list pane, and its buttons stay in view and
// take the click without a resize of the window or the list. Runs against serve.ts only: the fake Bitbucket and the fake Jira.
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_URL, openApp, pickRepo } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;

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

async function api(page: Page, method: string, path: string, body?: unknown): Promise<number> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const headers = {
        "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "",
        "Content-Type": "application/json",
      };
      return (await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })).status;
    },
    { method, path, body },
  );
}

// The button is fully in the viewport, and the point at its center hits the button itself, so no pane edge clips or covers it.
async function reachable(button: Locator) {
  await expect(button).toBeInViewport({ ratio: 1 });
  const hit = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at !== null && (at === el || el.contains(at));
  });
  expect(hit).toBe(true);
}

test("the Build form of a task with 40 sub-tasks scrolls in a short window and keeps its buttons in view", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 600 });
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", { task: true });
  expect(await api(page, "PUT", "/api/settings/jira", { baseUrl: JIRA_URL, token: E2E_JIRA_TOKEN })).toBe(200);
  await page.reload();

  await page.getByRole("button", { name: /^Tasks: / }).click();
  await page.getByRole("button", { name: "Build a Jira task" }).click();
  const form = page.getByRole("form", { name: "Build a Jira task" });
  await form.getByLabel("Jira key").fill("BIG-1");
  await pickRepo(form, "PROJ1/sample-repo-2");
  await form.getByRole("button", { name: "Read the task" }).click();
  await expect(form.getByText("BIG-1 has 40 sub-tasks. The app reads the first 20.")).toBeVisible();
  // The sub-task reads arrive after the form shows. Each open sub-task read adds its files to the form.
  await expect(form.getByRole("region", { name: "Files of BIG-21" }).getByRole("checkbox").first()).toBeVisible();
  await expect(form.getByRole("status")).toHaveCount(0);

  // The form is taller than the window, so its buttons must stay in view on their own.
  const build = form.getByRole("button", { name: "Build this task" });
  const cancel = form.getByRole("button", { name: "Cancel" });
  await reachable(build);
  await reachable(cancel);

  // The mode choice scrolls into view inside the form, and a click changes the mode. The buttons stay in view.
  const one = form.getByRole("radio", { name: "Build BIG-1 as one task" });
  await one.click();
  await expect(one).toBeChecked();
  await reachable(build);
  await form.getByRole("radio", { name: "Build the sub-tasks, one PR each" }).click();
  await expect(form.getByRole("region", { name: "Files of BIG-21" })).toBeVisible();
  // The last sub-task of the form scrolls into view too.
  await form.getByRole("region", { name: "Files of BIG-21" }).getByRole("checkbox").first().scrollIntoViewIfNeeded();
  await expect(form.getByRole("region", { name: "Files of BIG-21" }).getByRole("checkbox").first()).toBeInViewport();
  await reachable(build);

  // The narrow layout shows the list pane alone. The buttons stay in view there too.
  await page.setViewportSize({ width: 390, height: 640 });
  await reachable(build);
  await reachable(cancel);

  await cancel.click();
  await expect(form).toBeHidden();
});
