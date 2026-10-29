// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Bitbucket build status (docs/plans/ci-builds.md, Layer A, UI): the list row meta, the PR header build line, and the notification of
// a failed build on your own PR. The task view rows have unit tests (tests/web/tasks-model.test.ts).
import { test as base, expect, type Page } from "@playwright/test";
import type { FakeBuild } from "../support/fake-bitbucket";
import { control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const A = "Batch cache writes in the sync worker";
// Your own PR 1004. It shares the source head with the reviews 210 and 77.
const D = "Release the write lock after each entry";
const D_KEY = "PROJ1/sample-repo-4 #1004";
const CI = "https://ci.example.test/job/sample/7/";

type Note = { title: string; body?: string; tag?: string };
type Win = { __notes: Note[] };

// Headless Chromium denies notifications. A recorder replaces the Notification API.
const test = base.extend<{ notes: () => Promise<Note[]> }>({
  notes: async ({ context, page }, use) => {
    await context.grantPermissions(["notifications"]);
    await context.addInitScript(() => {
      const w = window as unknown as Win;
      w.__notes = [];
      class Recorder {
        static permission = "granted";
        static requestPermission = async () => "granted";
        onclick: (() => void) | null = null;
        constructor(title: string, opts: NotificationOptions = {}) {
          w.__notes.push({ title, body: opts.body, tag: opts.tag });
        }
        close() {}
      }
      Object.defineProperty(window, "Notification", { value: Recorder, configurable: true, writable: true });
    });
    await control("reset");
    await use(() => page.evaluate(() => [...(window as unknown as Win).__notes]));
  },
});

// Sets the statuses of the source head of PR pr. Every e2e PR but a pushed PR 1001 has the same source head.
async function setBuilds(pr: number, builds: FakeBuild[]) {
  const res = await fetch(`${FAKE_URL}/__control/build`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pr, builds }),
  });
  if (!res.ok) throw new Error(`control build: ${res.status}`);
}

const row = (page: Page, title: string) => page.locator("[data-row]", { hasText: title }).first();
const header = (page: Page) => page.locator("section[aria-label='Details'] header [data-build]");

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await page.getByRole("button", { name: "Settings" }).click();
  const toggle = page.getByLabel("Show a desktop notification for new activity");
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.getByRole("button", { name: "Cancel" }).click();
}

async function open(page: Page, title: string) {
  await row(page, title).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(title);
}

test("failed and running builds show on the rows and in the header; a passed build shows in the header only; your own PR notifies", async ({
  page,
  notes,
}) => {
  await connect(page);
  // push: PR 1001 gets its own source head. author: your own PR 1004 has its first sync now.
  await control("state", { push: true, author: true });
  await setBuilds(1001, [
    { key: "lint", state: "SUCCESSFUL", name: "lint", url: `${CI}lint` },
    { key: "unit", state: "FAILED", name: "unit tests", url: CI },
  ]);
  await setBuilds(1004, [{ key: "deploy", state: "INPROGRESS", name: "deploy check" }]);
  await control("state", {});

  const failed = row(page, A).locator("[data-build]");
  await expect(failed).toHaveAttribute("data-build", "failed");
  await expect(failed).toHaveText("Build failed");
  await expect(failed.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await failed.hover();
  await expect(page.locator("[data-slot='tooltip-content']")).toHaveText("Build failed: unit tests. 1 failed, 1 passed.");
  await expect(row(page, D).locator("[data-build]")).toHaveText("Build running");

  await open(page, A);
  await expect(header(page)).toHaveText("Build failed: unit tests (1 failed, 1 passed)");
  const link = header(page).getByRole("link", { name: "unit tests" });
  await expect(link).toHaveAttribute("href", CI.replace(/\/+$/, ""));
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");

  // The running build passes: the row meta goes, the header says so, and your own PR notifies. The failed review 1001 never does.
  await setBuilds(1004, [{ key: "deploy", state: "SUCCESSFUL", name: "deploy check" }]);
  await control("state", {});
  await expect(row(page, D).locator("[data-build]")).toHaveCount(0);
  await open(page, D);
  await expect(header(page)).toHaveAttribute("data-build", "passed");
  await expect(header(page)).toHaveText("Build passed: deploy check (1 passed)");
  // A status without a link names the build in plain text.
  await expect(header(page).getByRole("link")).toHaveCount(0);

  await setBuilds(1004, [{ key: "deploy", state: "FAILED", name: "deploy check" }]);
  await control("state", {});
  await expect(header(page)).toHaveText("Build failed: deploy check (1 failed)");
  const note = (kind: string) => ({ title: D, body: `${D_KEY}: build ${kind}`, tag: D_KEY });
  await expect.poll(async () => (await notes()).filter((n) => n.body?.includes("build"))).toEqual([note("passed"), note("failed")]);
});
