// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createSecrets, type SecretBackend } from "../../src/server/secrets";

const fail = () => Promise.reject(new TypeError("no keyring"));
const FALLBACK = "Secret store failed (TypeError). The token stays in memory only.";

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  spy?.mockRestore();
  spy = null;
});
function captureLog() {
  const lines: string[] = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  return lines;
}

describe("token store failures", () => {
  test("a read failure switches to memory and logs once", async () => {
    const lines = captureLog();
    let reads = 0;
    const backend: SecretBackend = {
      get: () => {
        reads++;
        return fail();
      },
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(true),
    };
    const s = createSecrets(backend);
    expect(s.storage()).toBe("os");
    expect(await s.get()).toBeNull();
    expect(s.storage()).toBe("memory");
    expect(lines).toEqual([FALLBACK]);
    await s.set("tok-read");
    expect(await s.get()).toBe("tok-read");
    expect(reads).toBe(1);
    expect(lines).toEqual([FALLBACK]);
  });

  test("a clear failure switches to memory, logs, and drops the token", async () => {
    const lines = captureLog();
    const stored: string[] = [];
    const backend: SecretBackend = {
      get: () => Promise.resolve(null),
      set: (o) => {
        stored.push(o.value);
        return Promise.resolve();
      },
      delete: fail,
    };
    const s = createSecrets(backend);
    await s.set("tok-clear");
    expect(stored).toEqual(["tok-clear"]);
    await s.clear();
    expect(s.storage()).toBe("memory");
    expect(lines).toEqual([FALLBACK]);
    expect(await s.get()).toBeNull();
    await s.set("tok-next");
    expect(stored).toEqual(["tok-clear"]);
  });
});
