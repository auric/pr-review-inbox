// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The run setup line "N changed files that no agent read": judge.ts unreadFiles over the events of stream.ts, and model.ts unreadText.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DiffFile } from "../../src/server/review/diffmap";
import { unreadFiles } from "../../src/server/review/judge";
import { createStreamParser } from "../../src/server/review/stream";
import type { RunSummary } from "../../src/shared/dto";
import { CHECK_EVENT, type RunEvent } from "../../src/shared/run-log";
import { unreadText } from "../../src/web/review/model";

const cwd = join(import.meta.dir, "run");
const file = (path: string | null, oldPath: string | null = path, binary = false): DiffFile => ({
  path,
  oldPath,
  binary,
  rows: [],
  newLines: new Map(),
  oldLines: new Map(),
});
const git = (t: string) => `mcp__rl-git__${t}`;

// The events of a stream with these tool calls. failed: the ids whose result is an error.
function events(calls: [parent: string | null, id: string, tool: string, input: Record<string, unknown>][], failed: string[] = []) {
  const parser = createStreamParser({ cwd, allowedTools: new Set() });
  for (const [parent, id, name, input] of calls)
    parser.line(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: parent,
        session_id: "s",
        message: { content: [{ type: "tool_use", id, name, input }] },
      }),
    );
  // A call of an agent ends before the Agent call, else stream.ts marks it stopped.
  for (const [, id] of [...calls].reverse())
    parser.line(
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: id, content: "x", is_error: failed.includes(id) }] },
      }),
    );
  return parser.events();
}

describe("unreadFiles", () => {
  const changed = [
    file("src/a.ts"),
    file("src/b.ts"),
    file("src/c.ts"),
    file("src/new.ts", "src/old.ts"),
    file(null, "src/gone.ts"),
    file("img/logo.png", "img/logo.png", true),
    file("src/f.ts"),
  ];

  test("a Read under ./repo by any agent and a git tool call with the path or the old path count; the rest stays unread", () => {
    const e = events(
      [
        [null, "a1", "Agent", { subagent_type: "rl-reviewer", description: "Half 1" }],
        ["a1", "r1", "Read", { file_path: join(cwd, "repo", "src", "a.ts") }],
        ["a1", "r2", "Read", { file_path: "./repo/src/b.ts" }],
        [null, "m1", git("git_diff"), { path: "src/old.ts" }],
        [null, "m2", git("git_show"), { rev: "BASE", path: "src/gone.ts" }],
        [null, "m3", git("git_log"), { path: "src/c.ts" }],
        [null, "m4", "Read", { file_path: join(cwd, "context", "pr.md") }],
        [null, "m5", "Grep", { pattern: "x", path: join(cwd, "repo", "src", "c.ts") }],
        [null, "m6", "Read", { file_path: join(cwd, "repo", "src", "f.ts") }],
        [null, "m7", git("git_diff"), { stat_only: true }],
      ],
      ["m6"],
    );
    // Unread: c.ts (git_log and Grep do not read it) and f.ts (the Read failed). The binary file never counts.
    expect(unreadFiles(e, changed)).toBe(2);
  });

  test("a git_diff without a path and without stat_only shows every file, so no file counts as unread", () => {
    for (const input of [{}, { page: 2 }, { from: "BASE", to: "HEAD" }])
      expect(unreadFiles(events([[null, "m1", git("git_diff"), input]]), changed)).toBe(0);
    // The same call that failed reads nothing.
    expect(unreadFiles(events([[null, "m1", git("git_diff"), {}]], ["m1"]), changed)).toBe(6);
  });

  test("a call of the verify phase does not count, and no event leaves every text file unread", () => {
    const [read] = events([[null, "r1", "Read", { file_path: join(cwd, "repo", "src", "a.ts") }]]);
    const check = { ...(read as RunEvent), id: `${CHECK_EVENT}r1` };
    expect(unreadFiles([check], changed)).toBe(6);
    expect(unreadFiles([], changed)).toBe(6);
    expect(unreadFiles([], [])).toBe(0);
  });
});

describe("unreadText", () => {
  const summary = (o: Partial<RunSummary>): RunSummary => ({
    summary: "",
    risks: [],
    coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
    dropped: [],
    ...o,
  });

  test("the line shows only for one or more unread files", () => {
    expect(unreadText(summary({ unreadFiles: 3 }))).toBe("3 changed files that no agent read.");
    expect(unreadText(summary({ unreadFiles: 1 }))).toBe("1 changed file that no agent read.");
    expect(unreadText(summary({ unreadFiles: 0 }))).toBeNull();
    expect(unreadText(summary({}))).toBeNull();
    expect(unreadText(null)).toBeNull();
    expect(unreadText(undefined)).toBeNull();
  });
});
