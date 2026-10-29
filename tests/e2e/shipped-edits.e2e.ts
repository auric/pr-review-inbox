// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Edits of shipped profiles: the Edited mark, Reset to shipped, the newer shipped version, Duplicate, and the agent picker labels.
// Runs against serve.ts only: the fake Bitbucket and a temp data folder.
import { expect, type Page, test } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const SAVED = "Saved. New runs use these profiles.";
const MINE = "Find wrong logic only.";

type Settings = {
  profiles: { id: string; name: string; prompt: string; maxTurns: number }[];
  shippedProfiles: { id: string; prompt: string; maxTurns: number }[];
  profileEdits: Record<string, { fields: string[]; newer: string[] }>;
};

const field = (page: Page, label: string, n: number) => page.getByLabel(`${label} of profile ${n}`, { exact: true });
// A textarea adds its text to the label text, so the role name finds it.
const prompt = (page: Page) => page.getByRole("textbox", { name: "Prompt of profile 1", exact: true });
const saved = (page: Page) => expect(page.locator("#profiles-status")).toHaveText(SAVED);
const edits = (page: Page) => page.getByRole("group", { name: /^Your edits to the shipped Review profile \(profile 1\)/ });
// serve.ts /__control/shipped-older: the stored edit of the field becomes an edit of an older shipped value, and the app restarts.
async function shippedOlder(id: string, field: string) {
  const res = await fetch(`${FAKE_URL}/__control/shipped-older`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id, field }),
  });
  expect(res.status).toBe(204);
}
const settingsApi = async (page: Page) => (await (await page.request.get(`${APP}/api/settings`)).json()) as Settings;

test.beforeEach(async ({ page }) => {
  await control("reset");
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await page.getByRole("button", { name: "Settings" }).click();
});

test("an edited field of the shipped Review profile shows Edited, resets to shipped, and a newer shipped version can be viewed", async ({
  page,
}) => {
  const shipped = (await settingsApi(page)).shippedProfiles[0] as Settings["shippedProfiles"][number];
  await expect(edits(page)).toHaveCount(0);
  await prompt(page).fill(MINE);
  await field(page, "Turn cap", 1).fill("120");
  await field(page, "Turn cap", 1).blur();
  await saved(page);
  await expect(edits(page).getByRole("listitem")).toHaveText([/^Turn cap\s*Edited/, /^Prompt\s*Edited/]);
  await expect.poll(async () => (await settingsApi(page)).profileEdits.general?.fields).toEqual(["prompt", "maxTurns"]);

  // Reset one field. The other edit stays.
  await page.getByRole("button", { name: "Reset to shipped turn cap of profile 1" }).click();
  await expect(field(page, "Turn cap", 1)).toHaveValue(String(shipped.maxTurns));
  await saved(page);
  await expect(edits(page).getByRole("listitem")).toHaveText([/^Prompt\s*Edited/]);
  await expect.poll(async () => (await settingsApi(page)).profiles[0]?.maxTurns).toBe(shipped.maxTurns);
  expect((await settingsApi(page)).profileEdits.general).toEqual({ fields: ["prompt"], newer: [] });
  await expect(edits(page)).not.toContainText("A newer shipped version exists.");

  // After an update with a new shipped prompt, the edit stays and the newer version shows.
  await shippedOlder("general", "prompt");
  await page.reload();
  await expect(prompt(page)).toHaveValue(MINE);
  await expect(edits(page)).toContainText("A newer shipped version exists.");
  await edits(page).getByRole("button", { name: "View the shipped prompt of profile 1" }).click();
  const view = page.getByRole("dialog", { name: "Shipped prompt of Review" });
  await expect(view).toContainText(shipped.prompt.split("\n")[0] as string);
  await expect(view).toContainText(MINE);
  await view.getByRole("button", { name: "Reset to shipped" }).click();
  await expect(view).toHaveCount(0);
  await expect(prompt(page)).toHaveValue(shipped.prompt);
  await saved(page);
  await expect(edits(page)).toHaveCount(0);
  await expect.poll(async () => (await settingsApi(page)).profileEdits.general).toEqual({ fields: [], newer: [] });
});

test("Duplicate adds an editable copy after the profile with every field, and the agent pickers name the main run values", async ({
  page,
}) => {
  await field(page, "Turn cap", 1).fill("90");
  await field(page, "Turn cap", 1).blur();
  await saved(page);
  await page.getByRole("button", { name: "Duplicate Review" }).click();
  await expect(field(page, "Name", 2)).toBeFocused();
  await expect(field(page, "Name", 2)).toHaveValue("Review copy");
  await expect(field(page, "Turn cap", 2)).toHaveValue("90");
  await saved(page);
  await expect
    .poll(async () => (await settingsApi(page)).profiles.map((p) => [p.id, p.name, p.maxTurns]))
    .toEqual([
      ["general", "Review", 90],
      ["review-copy", "Review copy", 90],
      ["explain", "Explain", 60],
    ]);
  // The copy is a user profile, so it shows no shipped edits.
  await expect(page.getByRole("group", { name: /^Your edits to the shipped .* \(profile 2\)/ })).toHaveCount(0);
  await page.reload();
  await expect(field(page, "Name", 2)).toHaveValue("Review copy");

  // Review has effort High and no model, so the agent pickers name the main run values.
  await expect(page.locator("#profile-0-reviewer-effort option").first()).toHaveText("Same as the main run (High)");
  await expect(page.locator("#profile-0-reviewer-model option").first()).toHaveText(/^Same as the main run/);
  await expect(page.locator("#profile-0-verifier-model option").first()).toHaveText(/^Same as the main run/);
  await expect(page.getByText("Model and effort of the lead agent that writes the findings.").first()).toBeVisible();
});
