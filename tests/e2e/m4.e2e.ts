// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// M4 browser acceptance (BRIEF US9): the check interval and the review profiles in the settings, the brief before each review,
// and the settings section links.
// Runs against serve.ts only: the fake Bitbucket, a temp git remote, and the fake Claude Code CLI.
import { type APIRequestContext, test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, addOwnProfiles, control, E2E_TOKEN, FAKE_URL, openApp, runAgents, runMcp, runSkills, testCheckSkill } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
// src/server/review/catalog.ts SHIPPED_PROFILES.
const SHIPPED = ["Review", "Explain"];
// A run passes the git workspace, the fake CLI, and the validator.
const RUN_MS = 60_000;
const SAVED = "Saved. New runs use these profiles.";

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      context.on("weberror", (e) => seen.logs.push(e.error().message));
      await control("reset");
      await use(seen);
      // Every test: only the local app gets requests, and the console holds no token and no CSP violation.
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
      expect(seen.logs.filter((l) => l.includes(E2E_TOKEN))).toEqual([]);
      expect(seen.logs.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l))).toEqual([]);
    },
    { auto: true },
  ],
});

const row = (page: Page) => page.locator("[data-row]", { hasText: TITLE }).first();
const reviewButton = (page: Page) => page.locator("#review-btn");
const runLine = (page: Page) => page.locator("#runline");
// The row of the newest run of one kind. data-run-state: running, done, failed, limit, or cancelled.
const runRow = (page: Page, kind = "review") => page.locator(`#runline [data-run-kind='${kind}']`);
const runLog = (page: Page) => page.getByRole("dialog", { name: "Review run log" });
const field = (page: Page, label: string, n: number) => page.getByLabel(`${label} of profile ${n}`, { exact: true });
const status = (page: Page) => page.locator("#profiles-status");
const names = (page: Page) =>
  page
    .getByRole("list", { name: "Review profiles" })
    .getByRole("textbox", { name: /^Name of profile \d+$/ })
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  // The profiles Review, Over-engineering, Security, and Explain.
  await addOwnProfiles(page);
  await control("state", {});
  await row(page).click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

const openSettings = (page: Page) => page.getByRole("button", { name: "Settings" }).click();
const closeSettings = (page: Page) => page.getByRole("button", { name: "Close the settings" }).click();
// A reload keeps the settings URL, so Settings opens again by itself (plan pr-view-v4 section 5).
async function reloadSettings(page: Page) {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

// Autosave: the status names the save. A text field saves when it loses focus or after a pause.
const saved = (page: Page) => expect(status(page)).toHaveText(SAVED);

// The names of the profile radios in the review brief. Esc closes the brief again.
async function briefNames(page: Page) {
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
  const radios = page.locator("#brief").getByRole("radio");
  const out = await radios.evaluateAll((els) => els.map((e) => e.closest("label")?.querySelector("span")?.textContent ?? ""));
  await page.keyboard.press("Escape");
  await expect(page.locator("#brief")).toHaveCount(0);
  return out;
}

type SavedProfile = {
  id: string;
  name: string;
  note: string;
  prompt?: string;
  skills?: string[];
  alwaysSkills?: string[];
  mcp?: unknown;
  model?: string | null;
  effort?: string | null;
  reviewer?: unknown;
  languageChecks?: boolean;
};
async function settingsApi(request: APIRequestContext) {
  return (await (await request.get(`${APP}/api/settings`)).json()) as { checkSeconds: number; profiles: SavedProfile[] };
}

async function runs(request: APIRequestContext) {
  const prs = (await (await request.get(`${APP}/api/prs`)).json()) as { id: number; title: string }[];
  const id = prs.find((p) => p.title === TITLE)?.id;
  return (await (await request.get(`${APP}/api/prs/${id}/runs`)).json()) as { profile: string; kind: string }[];
}

// Remove asks first. The dialog names the profile.
async function removeProfile(page: Page, name: string) {
  await page.getByRole("button", { name: `Remove ${name}` }).click();
  const ask = page.getByRole("dialog", { name: `Remove ${name}?` });
  await ask.getByRole("button", { name: "Remove profile" }).click();
  await expect(ask).toHaveCount(0);
}

test("the check interval persists after a reload", async ({ page, request }) => {
  await connect(page);
  await openSettings(page);
  const every = page.getByLabel("Check for new activity");
  await expect(every).toHaveValue("60");
  await expect(every.locator("option")).toHaveText([
    "Every 30 seconds",
    "Every minute",
    "Every 2 minutes",
    "Every 5 minutes",
    "Every 10 minutes",
    "Every 15 minutes",
  ]);
  await every.selectOption({ label: "Every 5 minutes" });
  await expect.poll(async () => (await settingsApi(request)).checkSeconds).toBe(300);
  await reloadSettings(page);
  await expect(page.getByLabel("Check for new activity")).toHaveValue("300");
});

test("a renamed profile shows in the brief and in the run labels; a run keeps the name it started with", async ({ page }) => {
  await connect(page);
  await openSettings(page);
  const name = field(page, "Name", 1);
  await expect(name).toHaveValue("Review");
  await name.fill("Correctness");
  await name.blur();
  await saved(page);
  await closeSettings(page);
  // The Review button names no profile. The brief holds the pick and its Edit link.
  await expect(reviewButton(page)).toHaveText("Review");

  await page.keyboard.press("Shift+R");
  await expect(page.getByRole("radio", { name: /^Correctness/ })).toBeChecked();
  await expect(page.locator("#brief").getByRole("link", { name: "Edit Correctness" })).toBeVisible();
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await page.keyboard.press("3");
  await expect(runLog(page)).toContainText("Correctness profile");
  await page.keyboard.press("Escape");
  await expect(runLog(page)).toBeHidden();

  // The brief follows a second rename at once. The finished run keeps its first name and its explain flag.
  await openSettings(page);
  await field(page, "Name", 1).fill("Logic");
  await field(page, "Explain only", 1).check();
  await saved(page);
  await closeSettings(page);
  expect(await briefNames(page)).toEqual(["Logic", "Over-engineering", "Security", "Explain"]);
  await expect(runRow(page)).toContainText("Correctness profile");
  await page.keyboard.press("3");
  await expect(runLog(page)).toContainText("Correctness profile");
  await page.keyboard.press("Escape");
  await page.locator("#nav-runs").click();
  await expect(row(page)).toContainText("Correctness:");
});

test("autosave: each change persists without a Save button, also after a reload; an invalid name stays unsaved", async ({
  page,
  request,
}) => {
  await connect(page);
  await openSettings(page);
  await expect(page.getByRole("button", { name: "Save profiles" })).toHaveCount(0);
  await expect(page.locator("section[aria-labelledby='h-profiles']")).toContainText("Changes save as you make them.");
  // A text field saves about one second after the last key, without a blur.
  await field(page, "Note", 1).fill("Typed note");
  await saved(page);
  expect((await settingsApi(request)).profiles[0]?.note).toBe("Typed note");

  // An empty name shows its error and stays unsaved. The note of the same profile still saves.
  await field(page, "Name", 2).fill("");
  await expect(page.getByText("Enter a name.")).toBeVisible();
  await expect(field(page, "Name", 2)).toHaveAttribute("aria-invalid", "true");
  await expect(status(page)).toHaveText("A marked field is not saved. Fix it to save it.");
  await field(page, "Note", 2).fill("Kept while the name is empty");
  await field(page, "Note", 2).blur();
  await expect.poll(async () => (await settingsApi(request)).profiles[1]?.note).toBe("Kept while the name is empty");
  expect((await settingsApi(request)).profiles[1]?.name).toBe("Over-engineering");

  // Closing the settings sends a waiting change at once.
  await field(page, "Name", 2).fill("Simplify");
  await closeSettings(page);
  await expect.poll(async () => (await settingsApi(request)).profiles[1]?.name).toBe("Simplify");

  await page.reload();
  await openSettings(page);
  await expect(field(page, "Note", 1)).toHaveValue("Typed note");
  await expect(field(page, "Name", 2)).toHaveValue("Simplify");
  await expect(field(page, "Note", 2)).toHaveValue("Kept while the name is empty");
});

test("an added profile appears in the brief, and a removed one disappears after a confirm", async ({ page, request }) => {
  await connect(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Add profile" }).click();
  // A new profile saves at once, so it starts valid. Its name is selected, so typing replaces it.
  const name = field(page, "Name", 5);
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("New profile");
  await saved(page);
  await page.keyboard.type("API review");
  await field(page, "Note", 5).fill("Public API and compatibility");
  // A label also holds the text of its textarea, so the prompt goes by its accessible name.
  const prompt = page.getByRole("textbox", { name: "Prompt of profile 5", exact: true });
  await expect(prompt).toHaveValue("Find defects in the change: wrong logic, missed edge cases, and effects on callers outside the diff.");
  await prompt.fill("Check the public API for breaking changes.");
  await prompt.blur();
  await saved(page);

  // Remove asks first. Cancel keeps the profile; the dialog gives the focus back to the button.
  const remove = page.getByRole("button", { name: "Remove Over-engineering" });
  await remove.click();
  const ask = page.getByRole("dialog", { name: "Remove Over-engineering?" });
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(remove).toBeFocused();
  await removeProfile(page, "Over-engineering");
  await expect(page.getByRole("button", { name: "Remove Security" })).toBeFocused();
  await saved(page);
  expect(await names(page)).toEqual(["Review", "Security", "Explain", "API review"]);
  await expect
    .poll(async () => (await settingsApi(request)).profiles.map((p) => [p.id, p.name]))
    .toEqual([
      ["general", "Review"],
      ["security", "Security"],
      ["explain", "Explain"],
      ["new-profile", "API review"],
    ]);
  await closeSettings(page);
  expect(await briefNames(page)).toEqual(["Review", "Security", "Explain", "API review"]);
});

test("reset brings back the two shipped profiles", async ({ page, request }) => {
  await connect(page);
  await openSettings(page);
  await field(page, "Name", 1).fill("Mine");
  await removeProfile(page, "Explain");
  await saved(page);
  expect(await names(page)).toEqual(["Mine", "Over-engineering", "Security"]);

  const reset = page.getByRole("button", { name: "Reset to shipped profiles" });
  await reset.click();
  const question = page.getByRole("group", { name: /^Replace all profiles with the shipped profiles\?/ });
  await expect(question.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Esc closes only the question. The settings stay open.
  await page.keyboard.press("Escape");
  await expect(question).toHaveCount(0);
  await expect(reset).toBeFocused();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  await reset.click();
  await question.getByRole("button", { name: "Reset profiles" }).click();
  await expect(question).toHaveCount(0);
  await expect.poll(() => names(page)).toEqual(SHIPPED);
  expect((await settingsApi(request)).profiles.map((p) => p.name)).toEqual(SHIPPED);
  await closeSettings(page);
  // One review profile: the brief has no profile picker (docs/plans/review-v2/spec.md section 1.1). Explain has its own page.
  expect(await briefNames(page)).toEqual([]);
});

// serve.ts gives the app a synthetic Claude Code config folder with the user skill test-check and the plugin skill e2e-plugin:style.
test("skills picked in the dialog save at once and are copied into the run folder", async ({ page, request }) => {
  await connect(page);
  await openSettings(page);
  const chips = page.getByRole("list", { name: "Skills of profile 1" });
  await expect(chips).toHaveCount(0);
  await page.getByRole("button", { name: "Choose… skills of profile 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Skills of Review" });
  await expect(dialog.getByText("Finds changed code without a test.")).toBeVisible();
  await expect(dialog.getByText("Plugin 1.2.0 · Checks the naming style.")).toBeVisible();
  // Search narrows the list. Select all then picks only the shown skills.
  await dialog.getByRole("searchbox", { name: "Search skills" }).fill("naming");
  // One row: the skill box and its Always use box.
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Select all shown" }).click();
  await expect(dialog.getByRole("checkbox", { name: /^style e2e-plugin:style/ })).toBeChecked();
  await dialog.getByRole("searchbox", { name: "Search skills" }).fill("");
  await dialog.getByRole("checkbox", { name: /^test-check test-check/ }).check();
  await expect(dialog.getByRole("status")).toHaveText("2 of 2 chosen");
  await dialog.getByRole("button", { name: "Clear" }).click();
  await expect(dialog.getByRole("status")).toHaveText("0 of 2 chosen");
  await dialog.getByRole("checkbox", { name: /^test-check test-check/ }).check();
  await dialog.getByRole("checkbox", { name: /^style e2e-plugin:style/ }).check();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("button", { name: "Choose… skills of profile 1" })).toBeFocused();
  await expect(chips.getByRole("listitem")).toHaveText(["test-check", "style"]);
  await saved(page);
  await expect.poll(async () => (await settingsApi(request)).profiles[0]?.skills).toEqual(["test-check", "e2e-plugin:style"]);
  await closeSettings(page);

  await control("claude", { stream: "tree", hang: true });
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
  await expect.poll(runSkills, { timeout: RUN_MS }).toEqual(["e2e-plugin+style/SKILL.md", "test-check/SKILL.md", "test-check/notes.md"]);
  await runLine(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toHaveAttribute("data-run-state", "cancelled", { timeout: RUN_MS });
});

test("an Always use skill shows on its chip, goes first, and blocks the review while it is missing", async ({ page, request }) => {
  const ALWAYS_ERROR =
    "Skill test-check is marked Always use, but it is not found. Enable the plugin again, or remove the Always use mark in Settings > Review profiles.";
  await connect(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Choose… skills of profile 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Skills of Review" });
  // Every row has the mark, as its own box outside the row label. It stays disabled until the skill is ticked.
  const mark = dialog.getByRole("checkbox", { name: "Always use test-check" });
  await expect(
    dialog.getByText("A ticked skill is read when it applies to the change. Always use reads it first in every run."),
  ).toBeVisible();
  await expect(mark).toBeDisabled();
  await expect(mark).toHaveAccessibleDescription("Tick the skill first.");
  await dialog.getByRole("checkbox", { name: /^test-check test-check/ }).check();
  await mark.check();
  // Ticking off the skill also clears its mark.
  await dialog.getByRole("checkbox", { name: /^test-check test-check/ }).uncheck();
  await expect(mark).toBeDisabled();
  await expect(mark).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /^test-check test-check/ }).check();
  await expect(mark).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /^style e2e-plugin:style/ }).check();
  await mark.check();
  await expect(dialog.getByRole("checkbox", { name: /^test-check test-check/ })).toBeChecked();
  await expect(dialog.locator("label label")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done" }).click();
  const chips = page.getByRole("list", { name: "Skills of profile 1" });
  await expect(chips.getByRole("listitem")).toHaveText(["test-check · Always", "style"]);
  await saved(page);
  await expect
    .poll(async () => (await settingsApi(request)).profiles[0])
    .toMatchObject({ skills: ["test-check", "e2e-plugin:style"], alwaysSkills: ["test-check"] });
  await closeSettings(page);

  // The run row and the run log mark the skill.
  await control("claude", { stream: "tree", hang: true });
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
  await expect
    .poll(async () => (await runAgents())?.["rl-main"] ?? "", { timeout: RUN_MS })
    .toContain(
      "Before you start, read ./skills/test-check/SKILL.md and follow it for the whole run.\nThis skill adds checks. It does not remove the task, the rules, or the output format above.\nThe user chose these skills: ./skills/e2e-plugin+style/SKILL.md.",
    );
  await expect(runRow(page).locator("[data-run-skills]")).toHaveText("Skills: test-check (always), e2e-plugin:style");
  await runLine(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toHaveAttribute("data-run-state", "cancelled", { timeout: RUN_MS });
  const before = (await runs(request)).length;

  // The skill goes away after the brief read the skills list. The server refuses the start and stores no run.
  await page.keyboard.press("Shift+R");
  const brief = page.locator("#brief");
  await expect(brief.getByRole("button", { name: "Start review" })).toBeEnabled();
  await testCheckSkill(false);
  await brief.getByRole("button", { name: "Start review" }).click();
  await expect(page.locator("[data-slot='toast']", { hasText: "The review did not start" })).toContainText(ALWAYS_ERROR);
  expect((await runs(request)).length).toBe(before);
  await page.keyboard.press("Escape");
  await expect(brief).toHaveCount(0);

  // A new brief reads the skills list again. It names the skill, and Start stays disabled.
  await page.keyboard.press("Shift+R");
  await expect(brief.locator("#brief-foot")).toHaveText(ALWAYS_ERROR);
  await expect(brief.getByRole("button", { name: "Start review" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await openSettings(page);
  await expect(chips.getByRole("listitem")).toHaveText(["test-check · Always, not found", "style"]);
});

// serve.ts gives the app a Claude config with the user MCP server fake-docs and the plugin server e2e-plugin:docs. Both run tests/support/fake-mcp.ts.
test("an MCP server picked in the dialog gets only its ticked tools in the run", async ({ page, request }) => {
  await connect(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Choose… MCP servers of profile 1" }).click();
  const dialog = page.getByRole("dialog", { name: "MCP servers of Review" });
  await expect(dialog.getByRole("checkbox", { name: /^e2e-plugin:docs Local command, plugin e2e-plugin$/ })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /^fake-docs Local command/ }).check();
  const tools = page.getByRole("group", { name: "Tools of fake-docs" });
  // Only the tools with readOnlyHint true start ticked.
  await expect(tools.getByRole("checkbox", { name: /^search / })).toBeChecked();
  await expect(tools.getByRole("checkbox", { name: /^lookup / })).toBeChecked();
  // delete_item says readOnlyHint false: the safety rule blocks it.
  const del = tools.getByRole("checkbox", { name: /^delete_item / });
  await expect(del).not.toBeChecked();
  await expect(del).toBeDisabled();
  await expect(tools.getByText("Blocked: the server marks this tool as able to change data.")).toHaveCount(1);
  // note_tool has no hint: a tick asks first.
  const note = tools.getByRole("checkbox", { name: /^note_tool / });
  await expect(note).not.toBeChecked();
  await expect(tools.getByText("May change data. PR Review Inbox cannot check this.")).toHaveCount(1);
  const ask = page.getByRole("dialog", { name: "Allow note_tool?" });
  await note.click();
  await expect(ask).toContainText(
    "note_tool on fake-docs has no read-only mark. PR Review Inbox cannot check what it does. Allow it in runs of this profile?",
  );
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(note).not.toBeChecked();

  // Clear unticks every tool. Select all ticks the read-only tools at once and asks once for the unmarked one. Blocked stays off.
  const clear = tools.getByRole("button", { name: "Clear tools of fake-docs" });
  const all = tools.getByRole("button", { name: "Select all tools of fake-docs" });
  await clear.click();
  await expect(tools.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await expect(tools).toContainText("No tool is ticked. Runs skip this server.");
  await all.click();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(tools.getByRole("checkbox", { checked: true })).toHaveCount(2);
  await expect(tools.getByRole("checkbox", { name: /^search / })).toBeChecked();
  await expect(tools.getByRole("checkbox", { name: /^lookup / })).toBeChecked();
  await expect(note).not.toBeChecked();
  await clear.click();
  await all.click();
  await ask.getByRole("button", { name: "Allow in runs" }).click();
  await expect(tools.getByRole("checkbox", { checked: true })).toHaveCount(3);
  await expect(note).toBeChecked();
  await expect(del).not.toBeChecked();
  await expect(tools.getByText("bad.name")).toHaveCount(0);
  await tools.getByRole("checkbox", { name: /^lookup / }).uncheck();
  await expect(page.getByText("E2E-MCP-SECRET")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("list", { name: "MCP servers of profile 1" })).toHaveText("fake-docs (2 tools)");
  await saved(page);
  await expect
    .poll(async () => (await settingsApi(request)).profiles[0]?.mcp)
    .toEqual([{ server: "fake-docs", tools: ["search", "note_tool"] }]);
  await closeSettings(page);

  await control("claude", { stream: "tree", hang: true });
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
  // The record of this run names the picked tool. Then both its mcp.json and its argv are current.
  await expect
    .poll(async () => (await runMcp())?.allowed?.split(",").includes("mcp__fake-docs__search") ?? false, { timeout: RUN_MS })
    .toBe(true);
  const run = await runMcp();
  expect(run?.servers).toContain("fake-docs");
  expect(run?.allowed?.split(",")).toEqual(expect.arrayContaining(["mcp__fake-docs__search", "mcp__fake-docs__note_tool"]));
  expect(run?.allowed).not.toContain("mcp__fake-docs__lookup");
  expect(run?.denied?.split(",").sort()).toEqual(["mcp__fake-docs__delete_item", "mcp__fake-docs__lookup"]);
  await runLine(page).getByRole("button", { name: "Cancel" }).click();
  await expect(runRow(page)).toHaveAttribute("data-run-state", "cancelled", { timeout: RUN_MS });
});

test("Copy to all profiles asks first, then gives every profile the skills and MCP servers in one save that a reload keeps", async ({
  page,
  request,
}) => {
  const SETUP = {
    skills: ["test-check", "e2e-plugin:style"],
    alwaysSkills: ["test-check"],
    mcp: [{ server: "fake-docs", tools: ["search", "lookup"] }],
  };
  const puts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url() === `${APP}/api/settings`) puts.push(r.url());
  });
  await connect(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Choose… skills of profile 1" }).click();
  const skills = page.getByRole("dialog", { name: "Skills of Review" });
  await skills.getByRole("checkbox", { name: /^test-check test-check/ }).check();
  await skills.getByRole("checkbox", { name: /^style e2e-plugin:style/ }).check();
  await skills.getByRole("checkbox", { name: "Always use test-check" }).check();
  await skills.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Choose… MCP servers of profile 1" }).click();
  const servers = page.getByRole("dialog", { name: "MCP servers of Review" });
  await servers.getByRole("checkbox", { name: /^fake-docs Local command/ }).check();
  await expect(page.getByRole("group", { name: "Tools of fake-docs" }).getByRole("checkbox", { checked: true })).toHaveCount(2);
  await servers.getByRole("button", { name: "Done" }).click();
  await saved(page);
  await expect.poll(async () => (await settingsApi(request)).profiles[0]).toMatchObject(SETUP);

  // The dialog names each profile that changes. Cancel changes nothing and gives the focus back.
  const copy = page.getByRole("button", { name: "Copy to all profiles from profile 1" });
  await expect(copy).toHaveAccessibleDescription("Gives the other profiles these skills and MCP servers.");
  await copy.click();
  const ask = page.getByRole("dialog", { name: "Copy the skills and MCP servers of Review?" });
  await expect(ask).toContainText(
    "Review has 2 skills and 1 MCP server. Each profile in the list gets the same skills, Always use marks, MCP servers, and tools. This replaces its current skills and MCP servers.",
  );
  await expect(ask.getByRole("list", { name: "Profiles that change" }).getByRole("listitem")).toHaveText([
    "Over-engineering",
    "Security",
    "Explain",
  ]);
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(copy).toBeFocused();
  await expect(page.getByRole("list", { name: "Skills of profile 4" })).toHaveCount(0);

  const before = puts.length;
  await copy.click();
  await ask.getByRole("button", { name: "Copy to 3 profiles" }).click();
  await expect(ask).toHaveCount(0);
  await expect(status(page)).toHaveText("Saved. 3 profiles got the skills and MCP servers of Review.");
  expect(puts.length - before).toBe(1);
  expect((await settingsApi(request)).profiles.map((p) => ({ skills: p.skills, alwaysSkills: p.alwaysSkills, mcp: p.mcp }))).toEqual([
    SETUP,
    SETUP,
    SETUP,
    SETUP,
  ]);
  // The next change gives the plain save text again.
  await field(page, "Note", 4).fill("Explain note");
  await saved(page);

  await reloadSettings(page);
  for (const n of [2, 3, 4]) {
    await expect(page.getByRole("list", { name: `Skills of profile ${n}` }).getByRole("listitem")).toHaveText([
      "test-check · Always",
      "style",
    ]);
    await expect(page.getByRole("list", { name: `MCP servers of profile ${n}` })).toHaveText("fake-docs (2 tools)");
  }
  // Nothing left to copy: the dialog says so and changes nothing.
  await page.getByRole("button", { name: "Copy to all profiles from profile 2" }).click();
  const same = page.getByRole("dialog", { name: "Copy the skills and MCP servers of Over-engineering?" });
  await expect(same).toContainText("The other profiles have the same skills and MCP servers.");
  await same.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(same).toHaveCount(0);
});

test("Improve prompt shows a line diff of the proposal; Apply saves it for good, and Cancel or an error changes nothing", async ({
  page,
  request,
}) => {
  // The fake CLI adds this line to the current prompt (tests/support/fake-claude.ts echoImprove).
  const ADDED = "Echo: report each finding with its trigger.";
  await connect(page);
  await openSettings(page);
  // getByLabel misses a textarea: the label text then holds the textarea text too.
  const prompt = page.getByRole("textbox", { name: "Prompt of profile 1", exact: true });
  const before = await prompt.inputValue();
  const improve = page.getByRole("button", { name: "Improve prompt… of profile 1" });
  await expect(improve).toHaveAccessibleDescription("Proposes a clearer prompt. You see the changes before you apply them.");
  const dialog = page.getByRole("dialog", { name: "Improve the prompt of Review" });
  const goal = dialog.getByLabel("What should the prompt focus on? Optional.");
  const changes = dialog.getByRole("region", { name: "Changes to the prompt" });

  // A running proposal shows the progress line. The run has no built-in tool. Cancel closes the dialog and gives the focus back.
  await control("claude", { stream: "tree", hang: true });
  await improve.click();
  await goal.fill("C++ lifetime bugs in engine code");
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Claude is writing a proposal…");
  await expect.poll(async () => (await runMcp())?.tools).toBe("");
  expect((await runMcp())?.allowed).toBeNull();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(improve).toBeFocused();

  // The proposal shows as a line diff with its reasons. Cancel keeps the prompt.
  await control("claude", { stream: "tree" });
  await improve.click();
  await goal.fill("C++ lifetime bugs in engine code");
  await goal.press("Enter");
  await expect(changes.locator("[data-k='add']")).toHaveCount(1);
  await expect(changes.locator("[data-k='add']")).toContainText(ADDED);
  await expect(changes.locator("[data-k='del']")).toHaveCount(0);
  await expect(changes.locator("[data-k='same']")).toHaveCount(before.split("\n").length);
  await expect(dialog.getByRole("list", { name: "Reasons" }).getByRole("listitem")).toHaveText(["Echo: added the trigger rule."]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(prompt).toHaveValue(before);
  expect((await settingsApi(request)).profiles[0]?.prompt).toBe(before);

  // An invalid result shows the error and offers Try again, but no Apply.
  await control("claude", { stream: "tree", improve: { prompt: "", reasons: [] } });
  await improve.click();
  await dialog.getByRole("button", { name: "Start" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The proposal failed. The result does not match the proposal schema.");
  await expect(dialog.getByRole("button", { name: "Apply" })).toHaveCount(0);

  // Try again gives a good proposal. Apply saves it at once, and a reload keeps it.
  await control("claude", { stream: "tree" });
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(changes.locator("[data-k='add']")).toContainText(ADDED);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(prompt).toHaveValue(`${before}\n${ADDED}`);
  await saved(page);
  await expect.poll(async () => (await settingsApi(request)).profiles[0]?.prompt).toBe(`${before}\n${ADDED}`);
  await reloadSettings(page);
  await expect(prompt).toHaveValue(`${before}\n${ADDED}`);
});

test("the run setup saves model, effort, and reviewer agents; the run row and the log show the model and the effort", async ({
  page,
  request,
}) => {
  await connect(page);
  // Before any change, a run shows the shipped setup: the init event names the model, and the Review profile sends --effort high.
  await page.keyboard.press("Shift+R");
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(runRow(page).locator("[data-run-setup]")).toHaveText("Model and effort: claude-haiku-5-5, high effort");

  await openSettings(page);
  // The settings file names no model, so the default model and its effort are unknown. An alias has a known default effort.
  await expect(field(page, "Model", 1).locator("option").first()).toHaveText("Use my default");
  await expect(field(page, "Effort", 1).locator("option").first()).toHaveText("Use my default");
  await field(page, "Model", 1).selectOption("haiku");
  await expect(field(page, "Effort", 1).locator("option").first()).toHaveText("Use my default (medium)");
  await field(page, "Model", 1).selectOption("other");
  const id = page.getByLabel("Model ID of profile 1", { exact: true });
  await expect(id).toBeFocused();
  await id.fill("bad model");
  await expect(page.getByText("Enter a model name without spaces that starts with a letter or a digit.")).toBeVisible();
  await id.fill("claude-opus-5-5");
  await id.blur();
  // The server resolves the default effort for the full model ID of the profile too.
  await expect(field(page, "Effort", 1).locator("option").first()).toHaveText("Use my default (medium)");
  // xhigh, not the shipped high, so the run line of the next run differs from the first one.
  await field(page, "Effort", 1).selectOption("xhigh");
  await page.getByRole("radiogroup", { name: "Reviewer agents of profile 1" }).getByText("Always", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Always" }).first()).toBeChecked();
  await field(page, "Agent effort", 1).selectOption("low");
  await field(page, "Agent model", 1).selectOption("haiku");
  await saved(page);
  await expect
    .poll(async () => {
      const p = (await settingsApi(request)).profiles[0];
      return [p?.model, p?.effort, p?.reviewer];
    })
    .toEqual(["claude-opus-5-5", "xhigh", { model: "haiku", effort: "low", mode: "always" }]);
  // Explain only turns the reviewer agents off for the profile.
  await field(page, "Explain only", 1).check();
  await expect(page.locator("#profile-0-reviewer-help")).toHaveText("Explain only runs use no reviewer agents.");
  await expect(field(page, "Agent effort", 1)).toBeDisabled();
  await field(page, "Explain only", 1).uncheck();
  await saved(page);
  await closeSettings(page);

  // The brief shows the run setup of the profile before the run.
  await page.keyboard.press("Shift+R");
  await expect(page.locator("#brief-setup")).toHaveText(
    "Run setup: claude-opus-5-5, xhigh effort. Reviewer agents: Always. No skills or MCP servers.",
  );
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  // The fake CLI init event names claude-haiku-5-5, the model that ran.
  await expect(runRow(page).locator("[data-run-setup]")).toHaveText("Model and effort: claude-haiku-5-5, xhigh effort");
  await page.keyboard.press("3");
  await expect(runLog(page).locator("footer [data-run-setup]")).toHaveText("Model and effort: claude-haiku-5-5, xhigh effort");
});

// The native scenario moves the PR head to a commit with native/hash.h, native/hash.cpp, and tools/check.py.
test("Language checks: on for Review and Security, saved at once, and a review run gives rl-main the lists of the changed languages", async ({
  page,
  request,
}) => {
  await connect(page);
  await control("state", { native: true });
  await openSettings(page);
  const lang = field(page, "Language checks", 1);
  await expect(lang).toBeChecked();
  await expect(page.locator("#profile-0-lang-help")).toHaveText("Adds checklists for the languages in the change. Review runs only.");
  await expect(field(page, "Language checks", 2)).not.toBeChecked();
  await expect(field(page, "Language checks", 3)).toBeChecked();
  await expect(field(page, "Language checks", 4)).not.toBeChecked();
  await closeSettings(page);

  // The agents file exists only while the run runs, so the run hangs until the cancel.
  const review = async () => {
    await control("claude", { stream: "tree", hang: true });
    await page.keyboard.press("Shift+R");
    await page.getByLabel("Your note").press("Control+Enter");
    await expect(runLine(page)).toContainText("Finding problems…", { timeout: RUN_MS });
    await expect.poll(runAgents, { timeout: RUN_MS }).not.toBeNull();
    const prompts = (await runAgents()) as Record<string, string>;
    await runLine(page).getByRole("button", { name: "Cancel" }).click();
    await expect(runRow(page)).toHaveAttribute("data-run-state", "cancelled", { timeout: RUN_MS });
    return prompts;
  };
  const on = await review();
  // docs/plans/review-v2/design.md R8: the change is small, so the run gets no rl-reviewer. tests/review/jobs.test.ts covers its lists.
  expect(Object.keys(on)).toEqual(["rl-main"]);
  for (const prompt of Object.values(on)) {
    expect(prompt).toContain("\nC++ list:\n- lifetime: ");
    expect(prompt).toContain("\nPython list:\n- defaults: ");
    expect(prompt).not.toContain("\nC list:");
  }

  await openSettings(page);
  await lang.uncheck();
  await saved(page);
  await expect.poll(async () => (await settingsApi(request)).profiles[0]?.languageChecks).toBe(false);
  await reloadSettings(page);
  await expect(field(page, "Language checks", 1)).not.toBeChecked();
  await closeSettings(page);
  await row(page).click();
  const off = await review();
  for (const prompt of Object.values(off)) expect(prompt).not.toContain(" list:\n- ");
});

test("Edit <profile> in the brief opens the settings at the checked profile, through the profile URL", async ({ page }) => {
  await connect(page);
  await page.keyboard.press("Shift+R");
  const brief = page.locator("#brief");
  // The Edit link keeps its own name: the radio group is named "Profile" only.
  await expect(brief.getByRole("group", { name: "Profile", exact: true })).toBeVisible();
  await expect(brief.getByRole("link", { name: "Edit Review" })).toHaveAttribute("href", "/settings/profiles/general");
  await brief.getByRole("radio", { name: /^Security/ }).check();
  const edit = brief.getByRole("link", { name: "Edit Security" });
  await expect(edit).toHaveAttribute("href", "/settings/profiles/security");
  await edit.click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(`${APP}/settings/profiles/security`);
  await expect(field(page, "Name", 3)).toBeFocused();
  await expect(field(page, "Name", 3)).toHaveValue("Security");
  await expect(field(page, "Name", 3)).toBeInViewport();
  // The settings opened another way start at the top.
  await closeSettings(page);
  await openSettings(page);
  await expect(field(page, "Name", 3)).not.toBeFocused();
});

test("every review start opens the brief first; Cancel and Esc start nothing; the brief preselects the last used profile (decision D2)", async ({
  page,
  request,
}) => {
  await connect(page);
  const brief = page.locator("#brief");
  const note = page.getByLabel("Your note");
  const setup = page.locator("#brief-setup");
  const radio = (name: string) => brief.getByRole("radio", { name: new RegExp(`^${name}`) });
  const lastUsed = brief.locator("label", { hasText: "Last used" });
  const stored = () => page.evaluate(() => localStorage.getItem("rl:last-profile"));

  // Review is one plain button: no profile name and no profile menu.
  await expect(reviewButton(page)).toHaveText("Review");
  await expect(page.locator("#review-btn-menu")).toHaveCount(0);

  // The Review button opens the brief with the run setup of the brief profile. Cancel starts nothing.
  await reviewButton(page).click();
  await expect(note).toBeFocused();
  await expect(setup).toHaveText("Run setup: default model, high effort. Reviewer agents: Auto. No skills or MCP servers.");
  // No stored brief and no profile used yet: the default profile, without the mark.
  await expect(radio("Review")).toBeChecked();
  await expect(lastUsed).toHaveCount(0);
  await brief.getByRole("button", { name: "Cancel" }).click();
  await expect(brief).toHaveCount(0);
  await expect(reviewButton(page)).toBeFocused();

  // r opens the brief. Esc closes it and starts nothing.
  await page.keyboard.press("r");
  await expect(note).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(brief).toHaveCount(0);
  expect(await runs(request)).toEqual([]);

  // A review on another PR used Security. This PR has no stored brief, so the brief preselects Security and marks it.
  await page.evaluate(() => localStorage.setItem("rl:last-profile", "security"));
  await page.keyboard.press("r");
  await expect(radio("Security")).toBeChecked();
  await expect(lastUsed).toHaveCount(1);
  await expect(lastUsed).toContainText("Security");
  await expect(lastUsed.locator("[title]")).toHaveAttribute("title", "The last profile you used on any pull request.");
  // Start stores the preselected profile first, so the run uses it. The started run sets the last used profile again.
  await page.evaluate(() => localStorage.removeItem("rl:last-profile"));
  await brief.getByRole("button", { name: "Start review" }).click();
  await expect(brief).toHaveCount(0);
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  expect((await runs(request)).map((r) => [r.kind, r.profile])).toEqual([["review", "security"]]);
  expect(await stored()).toBe("security");

  // A pick saves the brief profile at once. The mark stays on the preselected profile.
  await page.keyboard.press("r");
  await radio("Over-engineering").check();
  await expect(lastUsed).toContainText("Security");
  await page.keyboard.press("Escape");
  await expect(brief).toHaveCount(0);
  // The stored brief of this PR wins over the last used profile.
  await page.keyboard.press("r");
  await expect(radio("Over-engineering")).toBeChecked();
  await expect(lastUsed).toContainText("Over-engineering");
  await expect(lastUsed.locator("[title]")).toHaveAttribute("title", "The last profile you used on this pull request.");
  await page.keyboard.press("Escape");
  expect(await runs(request)).toHaveLength(1);
  expect(await stored()).toBe("security");
});

test("the settings section links mark the section in view: at once on a click, on scroll, and the last section at the end", async ({
  page,
}) => {
  await connect(page);
  await openSettings(page);
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  const current = nav.locator("[aria-current='true']");
  // The settings scroll pane holds the sections.
  const pane = page.locator("section[aria-labelledby='h-connection']").locator("xpath=..");
  const settle = () =>
    expect
      .poll(async () => {
        const a = await pane.evaluate((e) => e.scrollTop);
        await page.waitForTimeout(150);
        return a === (await pane.evaluate((e) => e.scrollTop));
      })
      .toBe(true);
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText("Connection");

  // A click marks its link at once. The scroll after it never moves the mark to another link.
  await nav.evaluate((el) => {
    const marks: string[] = [];
    Object.assign(window, { marks });
    new MutationObserver(() => {
      const t = el.querySelector("[aria-current='true']")?.textContent ?? "";
      if (marks.at(-1) !== t) marks.push(t);
    }).observe(el, { subtree: true, attributes: true, attributeFilter: ["aria-current"] });
  });
  await nav.getByRole("link", { name: "Task IDs" }).click();
  await expect(current).toHaveText("Task IDs");
  await expect(page.getByRole("heading", { name: "Task IDs" })).toBeFocused();
  await settle();
  expect(await page.evaluate(() => (window as unknown as { marks: string[] }).marks)).toEqual(["Task IDs"]);

  // Scroll: the end of the pane marks the last section, also when its heading cannot reach the top. The top marks the first.
  await pane.hover({ position: { x: 8, y: 8 } });
  await page.mouse.wheel(0, 50_000);
  await expect(current).toHaveText("Project instructions");
  await page.mouse.wheel(0, -50_000);
  await expect(current).toHaveText("Connection");
  // A heading at the top of the pane marks its section, also when the section is short.
  await pane.evaluate((e) => {
    const h = document.getElementById("h-appearance");
    if (h) e.scrollTop += h.getBoundingClientRect().top - e.getBoundingClientRect().top - 20;
  });
  await expect(current).toHaveText("Appearance");

  // A narrow pane scrolls the links sideways and keeps the marked link in view.
  await page.setViewportSize({ width: 400, height: 800 });
  await pane.hover({ position: { x: 8, y: 8 } });
  await page.mouse.wheel(0, 50_000);
  await expect(current).toHaveText("Project instructions");
  await expect(current).toBeInViewport({ ratio: 1 });
  await page.mouse.wheel(0, -50_000);
  await expect(current).toHaveText("Connection");
  await expect(current).toBeInViewport({ ratio: 1 });
});
