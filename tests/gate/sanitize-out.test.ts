// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { claudeOutDir } from "../../scripts/gate/sanitize-core";

const ROOT = resolve(import.meta.dir, "../..");

describe("sanitize-claude output folder", () => {
  test("defaults to the git-ignored .gate0/claude", () => {
    expect(claudeOutDir(ROOT)).toBe(join(ROOT, ".gate0", "claude"));
    const ignored = spawnSync("git", ["check-ignore", "-q", ".gate0/claude/b1.jsonl"], { cwd: ROOT });
    expect(ignored.status).toBe(0);
  });

  test("accepts a folder outside fixtures/", () => {
    expect(claudeOutDir(ROOT, join(ROOT, ".gate0", "other"))).toBe(join(ROOT, ".gate0", "other"));
    expect(claudeOutDir(ROOT, join(ROOT, "fixtures-copy"))).toBe(join(ROOT, "fixtures-copy"));
  });

  test("refuses fixtures/ and every folder in it", () => {
    for (const out of ["fixtures", "fixtures/claude", join(ROOT, "fixtures", "claude"), "fixtures/claude/../bitbucket"])
      expect(() => claudeOutDir(ROOT, out)).toThrow("outside fixtures/");
  });
});
