// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/self-approved-plans.md sections 3.1, 5.1, and 5.5 (SA-3, AC-SA4, AC-SA13, AC-SA14): a large plan that the user
// approves alone. The plan screen shows the "Plan review" choice under the large size. The approval builds part 1 only. Its PR opens on
// the click, a colleague approves it on the fake server, part 2 starts on top of it, and the PR dialog of part 2 names the branch of
// part 1 as the target. Runs against serve.ts only.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, buildTask, control, E2E_JIRA_TOKEN, E2E_TOKEN, FAKE_URL, JIRA_URL, makeClone, openApp, taskRemote } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
// fixtures/jira/issue.json: the key of the task.
const KEY = "ABC-42";
// fixtures/bitbucket/dashboard-reviewer-page.json: the target branch of PR 1001, the default branch of the task repository.
const TARGET = "topic/sample-4";
// docs/plans/review-v2/spec.md section 7.1, AC-UX2: the words that no task screen shows.
const UX2 = /(?<!\.)\b(slices?|stacks?|stacked|gates?|verdicts?|candidates?|phases?|modules?|idem)\b/i;

const part = (n: number, title: string, file: string) => ({
  n,
  kind: "part",
  title,
  goal: `${title}.`,
  lines: 150,
  acceptance: [{ id: "A1", text: `${file} names ${KEY}.` }],
  tests: [{ test: `tests/part-${n}.test.ts`, proves: ["A1"] }],
  tasks: [{ id: "T1", title, files: [file], run: [`tests/part-${n}.test.ts`], done: "The test passes." }],
});
const SPEC = {
  title: "Flush the cache in two steps",
  size: "large",
  estimate: { parts: 2, lines: 300, files: 4, modules: ["docs"], db: false, api: false, unknowns: [] },
  map: [{ path: "README.md", line: 1, symbol: "", kind: "change", what: "The title line." }],
  change: "",
  design: { decision: "Flush first, then measure the lock wait.", alternatives: "", risks: "No flag." },
  spec: { behavior: "The cache flushes before the write lock.", edgeCases: "None.", outOfScope: "Other caches." },
  parts: [part(1, "Flush before the write lock", "FLUSH.md"), part(2, "Measure the lock wait", "WAIT.md")],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
};
const fileTest = (file: string) => `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
test("${file} names ${KEY}", () => expect(readFileSync("${file}", "utf8")).toContain("${KEY}"));
`;
const build = (n: number, file: string) => ({
  writes: [
    { path: `repo/tests/part-${n}.test.ts`, text: fileTest(file) },
    { path: `repo/${file}`, text: `# ${KEY} part ${n}\n` },
  ],
  ticks: { path: "*", ids: ["*"] },
});

const test = base.extend<{ seen: { urls: string[]; logs: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], logs: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => seen.logs.push(m.text()));
      await control("reset");
      await use(seen);
      // Only the local app gets requests. Bitbucket and Jira get them from the server only.
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
const row = (page: Page, n: number) => page.locator(`[data-subtask="${KEY} (${n} of 2)"]`);
// The text of the Task view without its Details tabs. The tabs show the plan files, which the runner writes.
const screenText = async (page: Page) => (await page.locator('[data-task] > :not([aria-label="Details"])').allInnerTexts()).join("\n");

test("a large plan that I approve myself: part 1 builds, its PR opens, an approval starts part 2 on top of it", async ({ page }) => {
  test.setTimeout(420_000);
  await control("claude", {
    stream: "task",
    interview: { done: true, summary: "The plan needs two parts.", questions: [], unknowns: [], coverage: NO_COVERAGE },
    spec: SPEC,
    review: { summary: "A small change.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] },
    seq: { "implement:build": [build(1, "FLUSH.md"), build(2, "WAIT.md")] },
  });
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
  const settings = await api(page, "PUT", "/api/repos/PROJ1/sample-repo-2/task-settings", {
    specDir: "specs/{key}/",
    lineBudget: 1000,
    maxOpen: 2,
    approvals: 1,
    commands: [],
    testGlobs: null,
    excludeGlobs: null,
    isolateHome: true,
  });
  expect(settings.status).toBe(200);
  await page.reload();

  // 1. The plan screen (AC-SA4): the "Plan review" choice under the large size. The spec PR choice is disabled with its note.
  await buildTask(page, "PROJ1/sample-repo-2");
  const id = Number(new URL(page.url()).pathname.split("/").pop());
  await expect(primary(page)).toHaveText("Approve the plan", { timeout: 90_000 });
  await expect(page.getByRole("radio", { name: /^Large: the code comes in small PRs/ })).toBeChecked();
  const review = page.getByRole("group", { name: "Plan review" });
  await expect(review.getByRole("radio", { name: "I approve the plan myself. Colleagues review only the code PRs." })).toBeChecked();
  const specPr = review.getByRole("radio", { name: "Colleagues review the plan first, in a spec PR." });
  await expect(specPr).toBeDisabled();
  await expect(specPr).toHaveAccessibleDescription("This version cannot open a spec PR yet.");
  await expect(page.locator('[data-task] [aria-current="step"]')).toHaveText("Plan");
  await expect(page.locator("[data-task]").getByRole("list", { name: "Steps", exact: true })).not.toContainText("Spec review");
  // The local remote has a branch "feature", so a "feature/" branch cannot exist there. The prefix of this task is "task/".
  await page.locator("label", { has: page.getByRole("radio", { name: "Other…", exact: true }) }).click();
  await page.getByLabel("Prefix", { exact: true }).fill("task/");
  await page.getByRole("checkbox", { name: "I understand" }).check();
  expect(UX2.exec(await screenText(page))).toBeNull();
  const approved = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/tasks\/\d+\/plan$/.test(r.url()));
  await primary(page).click();
  const sent = (await approved).request().postDataJSON() as { review?: string };
  expect(sent.review).toBe("self");

  // 2. The build of part 1 (AC-SA13). Part 2 waits for its review. Nothing went out before the click.
  await expect(status(page)).toHaveText(new RegExp(`^${KEY} \\(1 of 2\\) is ready(: [^.]+)?\\.$`), { timeout: 180_000 });
  await expect(page.getByText("Parts: 2, one PR each")).toBeVisible();
  // self-approved-plans.md section 4.1: a plan that I approve myself has no spec review step.
  await expect(page.locator("[data-task]").getByRole("list", { name: "Steps", exact: true })).not.toContainText("Spec review");
  await expect(page.locator('[data-task] [aria-current="step"]')).toHaveText("Build parts (1 of 2)");
  await expect(primary(page)).toHaveText("Open the PR");
  await expect(row(page, 1)).toContainText("Ready. Open its PR.");
  await expect(row(page, 2)).toContainText(`Waits for a review of ${KEY} (1 of 2).`);
  await expect(page.getByRole("button", { name: /^More for / })).toHaveCount(0);
  await expect(page.locator(`[data-subtask="${KEY}"]`)).toHaveCount(0);
  await row(page, 2)
    .getByRole("button", { name: new RegExp(`^${KEY} \\(2 of 2\\)`) })
    .click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Drop this part" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect((await taskRemote()).creates).toEqual([]);
  expect(UX2.exec(await screenText(page))).toBeNull();

  // 3. Open the PR of part 1. It targets the target branch.
  await row(page, 1)
    .getByRole("button", { name: new RegExp(`^${KEY} \\(1 of 2\\)`) })
    .click();
  await primary(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toHaveText(new RegExp(`^Push task/${KEY}-1-\\S+ and open a PR into ${TARGET}\\?$`));
  const branch1 = /^Push (\S+) and/.exec((await dialog.getByRole("heading").innerText()).trim())?.[1] as string;
  await expect(dialog.getByText(`Title: ${KEY} (part 1 of 2): Flush before the write lock`)).toBeVisible();
  await dialog.getByRole("button", { name: "Push and open PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(row(page, 1)).toContainText("In review.", { timeout: 30_000 });
  expect((await taskRemote()).creates).toHaveLength(1);

  // 4. A colleague approves the PR of part 1. Part 2 starts on top of it and gets ready.
  await control("task-pr-approve");
  await expect(row(page, 1)).toContainText("Approved. Waits for the merge.", { timeout: 30_000 });
  await expect(row(page, 2)).toContainText("Ready. Open its PR.", { timeout: 180_000 });
  const dto = (await api(page, "GET", `/api/tasks/${id}`)).json as { parts: { ord: number; baseBranch: string }[] };
  expect(dto.parts.find((p) => p.ord === 2)?.baseBranch).toBe(branch1);

  // 5. The PR dialog of part 2 names the branch of part 1 as the target. Cancel sends nothing.
  await row(page, 2)
    .getByRole("button", { name: new RegExp(`^${KEY} \\(2 of 2\\)`) })
    .click();
  await expect(primary(page)).toHaveText("Open the PR");
  await primary(page).click();
  await expect(dialog.getByRole("heading")).toHaveText(new RegExp(`^Push task/${KEY}-2-\\S+ and open a PR into ${branch1}\\?$`));
  await expect(dialog.getByText(`Title: ${KEY} (part 2 of 2): Measure the lock wait`)).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect((await taskRemote()).creates).toHaveLength(1);
  expect(UX2.exec(await screenText(page))).toBeNull();
});
