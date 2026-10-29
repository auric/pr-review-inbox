// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigWriteError, readConfig, writeConfig } from "../src/server/config";

const root = mkdtempSync(join(tmpdir(), "rl-config-write-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(root, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const A: Config = { baseUrl: "https://bitbucket.example.test", userSlug: "me", notifications: false };
const B: Config = { ...A, notifications: true };
// A rename that another program blocks, as Windows does while an editor holds config.json open.
const locked = (code: string, times = Number.POSITIVE_INFINITY) => {
  let calls = 0;
  const rename = (from: string, to: string) => {
    calls++;
    if (calls <= times) throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code });
    writeFileSync(to, readFileSync(from));
    rmSync(from);
  };
  return { rename, calls: () => calls };
};

describe("writeConfig with a locked config.json", () => {
  test("a rename that fails twice with EBUSY succeeds on a retry and writes no .prev", () => {
    const dir = fresh();
    writeConfig(dir, A);
    const r = locked("EBUSY", 2);
    writeConfig(dir, B, r.rename);
    expect(r.calls()).toBe(3);
    expect(readConfig(dir)?.notifications).toBe(true);
    expect(existsSync(join(dir, "config.json.prev"))).toBe(false);
    expect(existsSync(join(dir, "config.json.tmp"))).toBe(false);
  });

  test("a rename that stays refused falls back to a write in place after about 500 ms, with the old text in .prev", () => {
    const dir = fresh();
    writeConfig(dir, A);
    const old = readFileSync(join(dir, "config.json"), "utf8");
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      for (const code of ["EPERM", "EACCES"]) {
        const r = locked(code);
        const start = performance.now();
        writeConfig(dir, B, r.rename);
        expect(performance.now() - start).toBeGreaterThanOrEqual(450);
        expect(r.calls()).toBeGreaterThan(2);
        expect(readConfig(dir)?.notifications).toBe(true);
        expect(existsSync(join(dir, "config.json.tmp"))).toBe(false);
        writeConfig(dir, A);
      }
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(dir, "config.json.prev"), "utf8")).toBe(old);
    expect(lines.join("\n")).toContain("The app wrote the file in place.");
  });

  test("another rename error is not retried", () => {
    const dir = fresh();
    const r = locked("ENOSPC");
    expect(() => writeConfig(dir, A, r.rename)).toThrow("ENOSPC");
    expect(r.calls()).toBe(1);
  });

  test("when the write in place fails too, the error says in plain words that another program has the file open", () => {
    const dir = fresh();
    // A folder at the config.json path refuses the write in place on every OS.
    mkdirSync(join(dir, "config.json"));
    const r = locked("EPERM");
    let error: unknown;
    try {
      writeConfig(dir, A, r.rename);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigWriteError);
    expect((error as Error).message).toBe(
      `Cannot save ${join(dir, "config.json")}. Another program has the file open. Close it there, then save again.`,
    );
    expect(existsSync(join(dir, "config.json.tmp"))).toBe(false);
    expect(existsSync(join(dir, "config.json.prev"))).toBe(false);
  });
});

describe("readConfig with config.json.prev", () => {
  const quiet = () => spyOn(console, "log").mockImplementation(() => {});

  test("a truncated config.json reads from .prev and keeps the broken text in .bak", () => {
    const dir = fresh();
    writeConfig(dir, B);
    writeFileSync(join(dir, "config.json.prev"), readFileSync(join(dir, "config.json")));
    writeFileSync(join(dir, "config.json"), '{ "baseUrl": "https://bitb');
    const spy = quiet();
    try {
      expect(readConfig(dir)).toMatchObject({ baseUrl: B.baseUrl, notifications: true });
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(dir, "config.json.bak"), "utf8")).toBe('{ "baseUrl": "https://bitb');
  });

  test("an empty or missing config.json reads from .prev; a broken .prev gives null", () => {
    const dir = fresh();
    writeConfig(dir, B);
    const text = readFileSync(join(dir, "config.json"), "utf8");
    writeFileSync(join(dir, "config.json.prev"), text);
    const spy = quiet();
    try {
      writeFileSync(join(dir, "config.json"), "");
      expect(readConfig(dir)?.notifications).toBe(true);
      rmSync(join(dir, "config.json"));
      expect(readConfig(dir)?.notifications).toBe(true);
      writeFileSync(join(dir, "config.json.prev"), "{");
      expect(readConfig(dir)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("a valid config.json wins over .prev", () => {
    const dir = fresh();
    writeConfig(dir, A);
    writeFileSync(join(dir, "config.json.prev"), JSON.stringify(B));
    expect(readConfig(dir)?.notifications).toBe(false);
  });
});
