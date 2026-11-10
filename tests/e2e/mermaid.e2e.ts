// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Mermaid diagrams in an Ask answer (plan review-v2 spec 3.1, 3.5, AC-X5, AC-X6) under the real CSP of the app.
// A valid diagram shows as a data: URL image, a broken one shows its code and the error line, and another type shows as code.
// Runs against serve.ts only: the fake Bitbucket and the fake Claude Code CLI.
import { test as base, expect, type Page } from "@playwright/test";
import { APP_PORT, control, E2E_TOKEN, FAKE_URL, openApp } from "./control";

const APP = `http://127.0.0.1:${APP_PORT}`;
const TITLE = "Batch cache writes in the sync worker";
const RUN_MS = 60_000;
const COVERAGE = { read: ["src/cache/flush.ts"], skipped: [], unavailable: [], notChecked: [] };
// The %%{init} line must not reach mermaid: with it, the light page would get the dark theme.
const FLOW = '%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A["Sync worker"] --> B["flush()"]\n  B --> C["Cache store"]';
const SEQ = "sequenceDiagram\n  participant W as Sync worker\n  participant S as Store\n  W->>S: write batch\n  S-->>W: done";
const CLASS = "classDiagram\n  class Cache\n  class Store\n  Cache --> Store";
const BROKEN = 'flowchart TD\n  A["open --> B';
const PIE = 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85';
const ANSWER = [FLOW, SEQ, CLASS, BROKEN, PIE].map((c) => `\`\`\`mermaid\n${c}\n\`\`\``).join("\n\nNext:\n\n");

const test = base.extend<{ seen: { urls: string[]; csp: string[]; errors: string[] } }>({
  seen: [
    async ({ context }, use) => {
      const seen = { urls: [] as string[], csp: [] as string[], errors: [] as string[] };
      context.on("request", (r) => seen.urls.push(r.url()));
      context.on("console", (m) => {
        if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) seen.csp.push(m.text());
      });
      context.on("weberror", (e) => seen.errors.push(e.error().message));
      await control("reset");
      await use(seen);
      // The CSP stays as it is (spec 3.5). Any console CSP message goes into the report.
      for (const m of seen.csp) test.info().annotations.push({ type: "csp", description: m });
      if (seen.csp.length) console.log(`CSP console messages (${seen.csp.length}):\n${[...new Set(seen.csp)].join("\n")}`);
      expect(seen.errors).toEqual([]);
      expect(seen.urls.filter((u) => !u.startsWith(`${APP}/`) && !u.startsWith("data:"))).toEqual([]);
    },
    { auto: true },
  ],
});

test.use({ colorScheme: "light" });

const answer = (page: Page) => page.locator("[data-ask]").first();
const figures = (page: Page) => answer(page).locator("figure[data-diagram]");
const mermaidChunk = (urls: string[]) => urls.filter((u) => /\/assets\/(mermaid|Diagram)[.-]/.test(u));

async function ask(page: Page) {
  await openApp(page);
  await page.getByLabel("Bitbucket URL").fill(FAKE_URL);
  await page.getByLabel("Access token").fill(E2E_TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Access token")).toBeHidden();
  await control("state", {});
  await page.locator("[data-row]", { hasText: TITLE }).first().click();
  await expect(page.locator("section[aria-label='Details'] h1")).toHaveText(TITLE);
  await page.keyboard.press("q");
  await page.getByLabel("Your question").fill("Draw the write path.");
  await page.getByLabel("Your question").press("Control+Enter");
  await expect(answer(page).getByRole("status")).toContainText(/Claude answered on/, { timeout: RUN_MS });
}

test("an Ask answer shows allowed diagrams as images, and a broken or other diagram as code", async ({ page, context, seen }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP });
  await control("claude", { stream: "tree", answer: { answer: ANSWER, coverage: COVERAGE } });
  await ask(page);
  await expect(figures(page)).toHaveCount(5);
  const fig = (i: number) => figures(page).nth(i);
  const [flow, seq, cls, broken, pie] = [fig(0), fig(1), fig(2), fig(3), fig(4)];
  const all = [flow, seq, cls, broken, pie];
  // Images for a visual check, in test-results/.
  const shots = async (scheme: string) => {
    for (const [i, f] of all.entries()) await f.screenshot({ path: test.info().outputPath(`diagram-${i}-${scheme}.png`) });
  };

  // AC-X5: each allowed type is an img with a data: URL that the browser decodes. No diagram svg enters the page.
  for (const [f, title] of [
    [flow, "flowchart TD"],
    [seq, "sequenceDiagram"],
    [cls, "classDiagram"],
  ] as const) {
    await expect(f).toHaveAttribute("data-diagram", "image", { timeout: RUN_MS });
    const img = f.getByRole("img", { name: `Diagram: ${title}` });
    await expect(img).toHaveAttribute("src", /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
    // The SVG has its own pixel width, so a small diagram does not grow to the text width.
    expect(decodeURIComponent((await img.getAttribute("src")) ?? "")).toMatch(/^[^<]*<svg [^>]*\bwidth="\d+(\.\d+)?"/);
    await expect(f.locator("pre")).toHaveCount(0);
  }
  await expect(answer(page).locator("figure svg:not(.lucide)")).toHaveCount(0);
  await expect(page.locator("[id^='rl-mmd-'], [id^='drl-mmd-']")).toHaveCount(0);
  // The node fill is the light --sunken token, so the %%{init} line with the dark theme did not reach mermaid.
  const flowSrc = decodeURIComponent((await flow.getByRole("img").getAttribute("src")) ?? "");
  expect(flowSrc).toContain("#edf0f4");
  expect(flowSrc).toContain(">flush()</tspan>");
  // AC-X6: the mermaid chunk loaded for this answer.
  expect(mermaidChunk(seen.urls).length).toBeGreaterThan(0);

  // A broken diagram: its code, the first error line, and Copy code. No Show code.
  await expect(broken).toHaveAttribute("data-diagram", "code");
  await expect(broken.locator("pre")).toHaveText(BROKEN);
  await expect(broken).toContainText("The diagram did not render: ");
  await expect(broken.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(broken.getByRole("button", { name: "Show code" })).toHaveCount(0);
  // Another type: its code and a note. Mermaid could render a pie, but the app does not.
  await expect(pie).toHaveAttribute("data-diagram", "code");
  await expect(pie.locator("pre")).toHaveText(PIE);
  await expect(pie).toContainText("Only flowchart, sequence, and class diagrams show as pictures. This one shows as code.");
  await expect(pie.getByRole("img")).toHaveCount(0);

  // Show code is a disclosure button with a 24 px target, reachable by keyboard.
  const show = flow.getByRole("button", { name: "Show code" });
  expect((await show.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(24);
  await show.focus();
  await page.keyboard.press("Enter");
  await expect(flow.getByRole("button", { name: "Hide code" })).toHaveAttribute("aria-expanded", "true");
  await expect(flow.locator("pre")).toHaveText(FLOW);
  await expect(flow.getByRole("img")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(flow.locator("pre")).toHaveCount(0);
  await expect(show).toHaveAttribute("aria-expanded", "false");

  // Copy code copies the code as written. The Windows clipboard gives CRLF line ends.
  await flow.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByText("Copied the diagram code.")).toBeVisible();
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n").trimEnd()).toBe(FLOW);

  await shots("light");
  // A theme change renders the diagrams again with the dark tokens.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await expect.poll(async () => decodeURIComponent((await flow.getByRole("img").getAttribute("src")) ?? "")).toContain("#151618");
  await expect(page.locator("[id^='rl-mmd-'], [id^='drl-mmd-']")).toHaveCount(0);
  await shots("dark");
});

// docs/plans/review-v2/spec.md section 2.18 (AC-F10): a diagram in the follow-up turn of a conversation, and the earlier turn above it.
test("a Mermaid answer in a conversation renders as an image", async ({ page }) => {
  await control("claude", { stream: "tree", answer: { answer: "The worker writes in batches.", coverage: COVERAGE } });
  await ask(page);
  await control("claude", { stream: "tree", answer: { answer: `The write path:\n\n\`\`\`mermaid\n${SEQ}\n\`\`\``, coverage: COVERAGE } });
  await page.getByLabel("Follow up").fill("Draw it.");
  await page.getByLabel("Follow up").press("Control+Enter");
  const turns = page.locator("#ask ol[data-conversation]").first().locator("[data-ask]");
  await expect(turns).toHaveCount(2);
  const second = turns.nth(1);
  await expect(second.getByRole("status")).toContainText(/Claude answered on/, { timeout: RUN_MS });
  await expect(second.locator("figure[data-diagram]")).toHaveAttribute("data-diagram", "image", { timeout: RUN_MS });
  await expect(second.getByRole("img", { name: "Diagram: sequenceDiagram" })).toHaveAttribute("src", /^data:image\/svg\+xml/);
  await expect(turns.nth(0)).toContainText("The worker writes in batches.");
});

test("a page without a diagram does not load the mermaid chunk", async ({ page, seen }) => {
  await control("claude", { stream: "tree", answer: { answer: "No diagram here.\n\n```ts\nconst a = 1;\n```", coverage: COVERAGE } });
  await ask(page);
  await expect(answer(page).locator("pre")).toHaveText("const a = 1;");
  await expect(answer(page).locator("figure")).toHaveCount(0);
  expect(mermaidChunk(seen.urls)).toEqual([]);
});

// The large view: the image and Zoom open a dialog with the same data: URL. It opens at the fit scale.
test("a diagram opens in a large dialog with zoom buttons, keys, Ctrl+wheel, and Fit", async ({ page }) => {
  await control("claude", { stream: "tree", answer: { answer: `\`\`\`mermaid\n${FLOW}\n\`\`\``, coverage: COVERAGE } });
  await ask(page);
  const flow = figures(page).first();
  await expect(flow).toHaveAttribute("data-diagram", "image", { timeout: RUN_MS });
  const src = await flow.locator("img").getAttribute("src");
  const open = flow.getByRole("button", { name: "Open diagram: flowchart TD" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Diagram: flowchart TD" });
  await expect(dialog).toBeVisible();
  const big = dialog.locator("img");
  await expect(big).toHaveAttribute("src", src ?? "");
  await expect.poll(() => big.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  // Near full viewport.
  const view = page.viewportSize() ?? { width: 0, height: 0 };
  expect((await dialog.boundingBox())?.width ?? 0).toBeGreaterThan(view.width * 0.9);

  const zoom = dialog.locator("output[data-zoom]");
  const fit = dialog.getByRole("button", { name: "Fit" });
  await expect(fit).toHaveAttribute("aria-pressed", "true");
  const fitText = (await zoom.textContent()) ?? "";
  expect(fitText).toMatch(/^\d+%$/);
  // The small flowchart grows to fill the box.
  expect(Number.parseInt(fitText, 10)).toBeGreaterThan(100);
  await test.info().attach("diagram-dialog", { body: await page.screenshot(), contentType: "image/png" });

  await page.keyboard.press("1");
  await expect(zoom).toHaveText("100%");
  await expect(fit).toHaveAttribute("aria-pressed", "false");
  expect(await big.evaluate((i: HTMLImageElement) => Math.round(i.getBoundingClientRect().width) === i.naturalWidth)).toBe(true);
  await page.keyboard.press("+");
  await expect(zoom).toHaveText("125%");
  await page.keyboard.press("-");
  await page.keyboard.press("-");
  await expect(zoom).toHaveText("80%");
  await dialog.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoom).toHaveText("100%");
  await dialog.getByRole("button", { name: "Zoom out" }).click();
  await expect(zoom).toHaveText("80%");
  await dialog.getByRole("button", { name: "100%" }).click();
  await expect(zoom).toHaveText("100%");

  // Ctrl+wheel zooms the diagram, not the page.
  const box = dialog.getByRole("region", { name: "Diagram view: flowchart TD" });
  const b = (await box.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect(zoom).toHaveText("125%");
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

  await page.keyboard.press("0");
  await expect(zoom).toHaveText(fitText);
  await expect(fit).toHaveAttribute("aria-pressed", "true");

  // Esc closes the dialog and gives the focus back. Zoom opens it again at the fit scale.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await flow.getByRole("button", { name: "Zoom", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(zoom).toHaveText(fitText);
});
