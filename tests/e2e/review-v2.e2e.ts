// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review UI v2 browser acceptance (docs/plans/review-v2/spec.md sections 1.1, 1.4, 1.9; AC-UX1, AC-UX3, AC-UX10 for the brief and
// Drafts): the checks and the volume in the brief, the phase line, the ledger, the fold, the check chip, the refuted list with
// Restore, the run log groups, and a check that did not finish. Runs against serve.ts only: the fake Bitbucket, a temp git remote,
// and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;

const test = base.extend<{ seen: string[] }>({
  seen: [
    async ({ context }, use) => {
      const urls: string[] = [];
      context.on("request", (r) => urls.push(r.url()));
      await control("reset");
      await use(urls);
      expect(urls.filter((u) => !u.startsWith(`${APP}/`))).toEqual([]);
    },
    { auto: true },
  ],
});

// tests/support/review-fixture.ts REVIEW_RESULT after validation: candidate 1 is the blocker on flush.ts line 3, candidate 2 the
// minor on line 6 (moved to line 5), candidate 3 the README nit. The finding on a file that the snapshot lacks drops.
const verdict = (candidate: number, v: string, severity: string, reason: string, evidence: string) => ({
  candidate,
  verdict: v,
  severity,
  reason,
  evidence,
  duplicateOf: null,
  question: "",
});
const VERIFY = {
  verdicts: [
    verdict(1, "confirmed", "blocker", "`write()` reads the batch between two entries without the lock.", "src/cache/flush.ts:4"),
    verdict(2, "refuted", "minor", "The caller releases the lock in a `finally` block.", "src/cache/flush.ts:9"),
    verdict(3, "unsure", "nit", "No reader of the README depends on the flush order.", "README.md:1"),
  ],
  coverage: { read: ["src/cache/flush.ts"], skipped: [], unavailable: [], notChecked: [] },
};

const runLine = (page: Page) => page.locator("#runline");
const runRow = (page: Page) => page.locator("#runline [data-run-kind='review']");
const drafts = (page: Page) => page.locator("[data-draft]");
const brief = (page: Page) => page.locator("#brief");

async function connect(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
}

// The stored Review profile, through the app API of the open page.
const review = (page: Page) =>
  page.evaluate(async () => {
    const headers = { "X-RL-Session": document.querySelector<HTMLMetaElement>('meta[name="rl-session"]')?.content ?? "" };
    const s = (await (await fetch("/api/settings", { headers })).json()) as {
      profiles: { id: string; modules: string[]; volume: string; languageChecks: boolean }[];
    };
    return s.profiles.find((p) => p.id === "general");
  });

async function start(page: Page) {
  await page.keyboard.press("Shift+R");
  await expect(page.getByLabel("Your note")).toBeFocused();
  await page.getByLabel("Your note").press("Control+Enter");
  await expect(brief(page)).toHaveCount(0);
}

test("the brief: checks and the volume save to the profile at once, and Start review is the one primary button", async ({ page }) => {
  await connect(page);
  await page.keyboard.press("Shift+R");
  await expect(brief(page).locator("[data-primary]")).toHaveCount(1);
  await expect(brief(page).locator("[data-primary]")).toHaveText("Start review");

  // The shipped Review profile: Security, Threads and races, and Compatibility in view. Project rules and Matches the task are on
  // under More checks, with the language checklists.
  const checks = brief(page).getByRole("group", { name: "Checks" });
  for (const name of ["Security", "Threads and races", "Compatibility"]) await expect(checks.getByLabel(name)).toBeChecked();
  for (const name of ["Performance", "Tests", "Simplify (what to delete)"]) await expect(checks.getByLabel(name)).not.toBeChecked();
  await expect(checks.getByLabel("Project rules")).toBeHidden();
  await checks.getByText("More checks (3 on)").click();
  await expect(checks.getByLabel("Project rules")).toBeChecked();
  await expect(checks.getByLabel("Language checklists (C++, C, Python)")).toBeChecked();

  await checks.getByLabel("Performance").check();
  await expect
    .poll(async () => (await review(page))?.modules)
    .toEqual(["security", "concurrency", "performance", "api", "rules", "intent"]);
  await checks.getByLabel("Language checklists (C++, C, Python)").uncheck();
  await expect.poll(async () => (await review(page))?.languageChecks).toBe(false);

  // The volume: three steps, Balanced first. The line under it says what each one does.
  const volume = brief(page).getByRole("group", { name: "Show" });
  await expect(volume.getByRole("button", { name: "Balanced" })).toHaveAttribute("aria-pressed", "true");
  await expect(brief(page).locator("#brief-volume-line")).toHaveText(
    "Balanced: must-fix and worth-fixing points. Unsure points wait in a fold.",
  );
  await volume.getByRole("button", { name: "Show everything" }).click();
  await expect(volume.getByRole("button", { name: "Show everything" })).toHaveAttribute("aria-pressed", "true");
  await expect(brief(page).locator("#brief-volume-line")).toHaveText("Show everything: also small polish and unsure points.");
  await expect.poll(async () => (await review(page))?.volume).toBe("thorough");
  await expect(brief(page)).toContainText("Applies to every review with this setup.");

  // The choices stay after the brief closes and opens again.
  await page.keyboard.press("Escape");
  await page.keyboard.press("r");
  await expect(brief(page).getByRole("group", { name: "Show" }).getByRole("button", { name: "Show everything" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(brief(page).getByRole("group", { name: "Checks" }).getByLabel("Performance")).toBeChecked();
});

test("a two-phase run: the phase line, the ledger, the fold, the check chip, the refuted list with Restore, and keys on a fold item", async ({
  page,
}) => {
  // The check phase writes its stream slowly, so the run line shows it.
  await control("claude", { stream: "tree", verify: VERIFY, bySchema: { verify: { delayMs: 120 } } });
  await connect(page);
  await start(page);
  await expect(runLine(page)).toContainText("Checking 3 findings…", { timeout: RUN_MS });
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(runRow(page).locator("[data-phase-time]")).toHaveText([/^Finding \d+ s$/, /^Checking \d+ s$/]);

  // Balanced: the confirmed blocker shows. The unsure nit waits in the fold. The refuted minor stays in the run record.
  await expect(page.locator("[data-drafts-ledger]")).toHaveText("1 must fix · 1 low confidence · 1 question");
  await expect(runLine(page).locator("[data-ledger]")).toHaveText(["1 must fix", "1 low confidence", "1 question"]);
  await expect(drafts(page)).toHaveCount(1);
  const blocker = drafts(page).first();
  await expect(blocker.locator("[data-check]")).toHaveText("Checked");
  await expect(blocker).toContainText("When: Two writers flush at once.");
  await expect(blocker.locator("[data-check-reason]")).toHaveText(
    "Check: write() reads the batch between two entries without the lock. (src/cache/flush.ts:4)",
  );
  const fold = page.getByRole("button", { name: "Low confidence (1)" });
  await expect(fold).toHaveAttribute("aria-expanded", "false");

  // The run record: one line for the refuted point. It opens the reason and Restore.
  const refuted = runRow(page).getByRole("button", { name: "1 refuted by the check" });
  await expect(refuted).toHaveAttribute("aria-expanded", "false");
  await refuted.click();
  const item = runRow(page).locator("[data-hidden-item]");
  await expect(item).toContainText("Check: The caller releases the lock in a finally block. (src/cache/flush.ts:9)");

  // j and k reach the fold as a Drafts row between the findings and the question. o opens it. The keys a, e, and d work on a fold item.
  const question = page.locator("[data-draft-question]");
  await page.keyboard.press("2");
  await expect(blocker).toBeFocused();
  await page.keyboard.press("j");
  await expect(fold).toBeFocused();
  await page.keyboard.press("j");
  await expect(question.locator("[data-row-head]")).toBeFocused();
  await page.keyboard.press("k");
  await expect(fold).toBeFocused();
  await page.keyboard.press("o");
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(drafts(page)).toHaveCount(2);
  const nit = drafts(page).filter({ hasText: "The README does not name the flush order." });
  await expect(nit).toHaveAccessibleName(/^Draft from Claude\. Nit\. README\.md:1\..* Low confidence\.$/);
  await expect(nit.locator("[data-check]")).toHaveText("Low confidence");
  await page.keyboard.press("j");
  await expect(nit.locator("[data-row-head]")).toBeFocused();
  await page.keyboard.press("e");
  await expect(nit.getByRole("textbox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nit.getByRole("textbox")).toHaveCount(0);
  await expect(nit).toBeFocused();
  await page.keyboard.press("a");
  await expect(nit).toHaveAccessibleName(/ Accepted\. /);
  // The focus moves on to the next untriaged draft: the question after the fold.
  await expect(question).toBeFocused();
  await nit.locator("[data-row-head]").focus();
  await page.keyboard.press("d");
  await expect(nit).toHaveAccessibleName("Discarded draft. README.md:1.");

  // Restore moves the point into the Drafts list and the focus with it. The card says that you restored it.
  await item.getByRole("button", { name: /^Restore / }).click();
  const back = page.getByRole("article", { name: /^Draft from Claude\. Minor\. flush\.ts:5\./ });
  await expect(back).toBeFocused();
  await expect(back).toContainText("Refuted by the check. You restored it.");
  await expect(back.locator("[data-check]")).toHaveText("Not checked");
  await expect(runRow(page).locator("[data-refuted]")).toHaveCount(0);
  await expect(page.locator("[data-drafts-ledger]")).toHaveText("1 must fix · 1 worth fixing · 1 question");

  // The run log shows the check events under Check, after the finder events.
  await runRow(page).getByRole("button", { name: "Log of the review run" }).click();
  const log = page.getByRole("dialog", { name: "Review run log" });
  await expect(log.locator("[data-log-phase]")).toHaveText(["Find", "Check"]);
});

test("a refuted concurrency finding stays in the Drafts list, last in its group, with the Refuted chip and the check reason (AC-R17)", async ({
  page,
}) => {
  const verify = {
    ...VERIFY,
    verdicts: [
      verdict(1, "refuted", "blocker", "One lock guards the whole loop at the head commit.", "src/cache/flush.ts:2"),
      verdict(2, "confirmed", "minor", "No finally block releases the lock.", "src/cache/flush.ts:6"),
      verdict(3, "confirmed", "nit", "The README names no order.", "README.md:1"),
    ],
  };
  await control("claude", { stream: "tree", verify });
  await connect(page);
  await start(page);
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(drafts(page)).toHaveCount(2);
  // The refuted blocker of category Concurrency is not hidden. It comes after the confirmed minor.
  await expect(drafts(page).nth(0)).toContainText("Release the lock in a finally block.");
  const low = drafts(page).nth(1);
  await expect(low).toHaveAttribute("data-demoted", "true");
  await expect(low.locator("[data-check]")).toHaveText("Refuted");
  await expect(low).toHaveAccessibleName(/Refuted by the check\. It stays last in its group\./);
  await low.locator("[data-row-head]").click();
  await expect(low.locator("[data-check-reason]")).toHaveText(
    "Check: One lock guards the whole loop at the head commit. (src/cache/flush.ts:2)",
  );
  await expect(runRow(page).getByRole("button", { name: /refuted by the check/ })).toHaveCount(0);
});

test("a volume change keeps the view of an earlier run; the next run shows everything with the Low confidence chip", async ({ page }) => {
  await control("claude", { stream: "tree", verify: VERIFY });
  await connect(page);
  await start(page);
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect(page.getByRole("button", { name: "Low confidence (1)" })).toBeVisible();

  await page.keyboard.press("r");
  await brief(page).getByRole("group", { name: "Show" }).getByRole("button", { name: "Show everything" }).click();
  await expect.poll(async () => (await review(page))?.volume).toBe("thorough");
  await page.keyboard.press("Escape");
  // The run stored its volume, so its fold stays.
  await expect(page.getByRole("button", { name: "Low confidence (1)" })).toBeVisible();

  await start(page);
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  await expect.poll(async () => page.getByRole("button", { name: /^Low confidence \(/ }).count(), { timeout: RUN_MS }).toBe(0);
  await expect(drafts(page)).toHaveCount(2);
  await expect(page.locator("[data-drafts-ledger]")).toHaveText("1 must fix · 1 polish · 1 question");
  await expect(page.getByRole("article", { name: /README\.md:1\..* Low confidence\.$/ })).toBeVisible();
});

test("a check that does not finish: the run line says how many findings are not checked, never that nothing is wrong", async ({ page }) => {
  await control("claude", { stream: "tree", verify: { verdicts: "not a list" } });
  await connect(page);
  await start(page);
  await expect(runRow(page)).toHaveAttribute("data-run-state", "done", { timeout: RUN_MS });
  const failed = runRow(page).locator("[data-check-failed]");
  await expect(failed).toContainText("The check did not finish: 3 findings are not checked.");
  await expect(runRow(page)).not.toContainText("No problems found");
  await expect(drafts(page).first().locator("[data-check]")).toHaveText("Not checked");
  await failed.getByRole("button", { name: "Show log of the review run" }).click();
  await expect(page.getByRole("dialog", { name: "Review run log" })).toBeVisible();
});
