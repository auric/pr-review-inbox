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
  // The tests wait up to RUN_MS (60 s) for a run and COMMIT_MS (30 s) for a commit, so the default of 30 s per test cut them. A full
  // run on 2026-11-09 measured passing fix.e2e tests at 23 to 29 s, and 5 tests failed only at the 30 s test timeout.
  timeout: 120_000,
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
