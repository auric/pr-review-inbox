// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The cleanup of subagent output folders (CLI 2.1.322 layout). Each test uses its own temp root, never <tmpdir>/claude.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSessionFolders, sessionFolders } from "../../src/server/review/claude";

const SID = "11111111-2222-4333-8444-555555555555";
const OTHER = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function root() {
  const r = mkdtempSync(join(tmpdir(), "rl-session-folders-"));
  roots.push(r);
  return r;
}
function output(r: string, hash: string, sid: string) {
  const dir = join(r, "claude", hash, sid, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a0123456789abcdef.output"), "x");
  return join(r, "claude", hash, sid);
}

describe("removeSessionFolders", () => {
  test("deletes the session folder and its empty parent", () => {
    const r = root();
    const dir = output(r, "0123456789abcdef", SID);
    expect(sessionFolders([SID], join(r, "claude"))).toEqual([dir]);
    removeSessionFolders([SID], join(r, "claude"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(r, "claude", "0123456789abcdef"))).toBe(false);
    expect(existsSync(join(r, "claude"))).toBe(true);
  });

  test("keeps the parent folder when another session uses it", () => {
    const r = root();
    const dir = output(r, "0123456789abcdef", SID);
    const other = output(r, "0123456789abcdef", OTHER);
    removeSessionFolders([SID], join(r, "claude"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(other, "tasks", "a0123456789abcdef.output"))).toBe(true);
  });

  test("ignores an ID that is not a uuid", () => {
    const r = root();
    mkdirSync(join(r, "claude", "h", "x"), { recursive: true });
    output(r, "h", SID);
    for (const bad of ["..", "x", `${SID}/..`, "", "*"]) expect(sessionFolders([bad], join(r, "claude"))).toEqual([]);
    removeSessionFolders(["..", "x"], join(r, "claude"));
    expect(existsSync(join(r, "claude", "h", "x"))).toBe(true);
    expect(existsSync(join(r, "claude", "h", SID))).toBe(true);
  });

  test("never follows a link", () => {
    const r = root();
    const target = join(r, "target");
    mkdirSync(join(target, SID), { recursive: true });
    writeFileSync(join(target, SID, "keep.txt"), "x");
    mkdirSync(join(r, "claude", "h"), { recursive: true });
    // A junction needs no privilege on Windows. On POSIX the type is ignored and a plain link results.
    symlinkSync(target, join(r, "claude", "linked"), "junction");
    symlinkSync(join(target, SID), join(r, "claude", "h", SID), "junction");
    expect(sessionFolders([SID], join(r, "claude"))).toEqual([]);
    removeSessionFolders([SID], join(r, "claude"));
    expect(existsSync(join(target, SID, "keep.txt"))).toBe(true);
  });

  test("a missing root is no error", () => {
    expect(sessionFolders([SID], join(root(), "absent"))).toEqual([]);
    removeSessionFolders([SID], join(root(), "absent"));
  });
});
