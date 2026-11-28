// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// bunfig.toml preloads this file for bun test only. A test file that sets no data folder or secrets mode never reaches the user's data
// folder or the OS credential store. bun test --parallel gives each file a fresh environment, so a file cannot inherit these values from
// an earlier file.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `rl-test-data-${process.pid}`);
process.env.REVIEW_LOOP_SECRETS = "memory";
process.env.REVIEW_LOOP_DATA_DIR = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
