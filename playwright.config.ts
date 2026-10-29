// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { defineConfig } from "@playwright/test";
import { APP_PORT } from "./tests/e2e/control";

// One server and one data folder for all tests, so the tests run one at a time.
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.e2e.ts",
  workers: 1,
  fullyParallel: false,
  // The list reporter names a test that passes only on the retry as flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  globalTeardown: "./tests/e2e/teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    browserName: "chromium",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    // The build makes the tests run the current UI.
    command: "bun run build && bun tests/e2e/serve.ts",
    url: `http://127.0.0.1:${APP_PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
  },
});
