// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codegraphEntry, codegraphIndex, indexCodegraph } from "../../src/server/review/codegraph";
import { sanitize } from "../../src/server/review/workspace";

const FAKE_CG = join(import.meta.dir, "../support/fake-codegraph/codegraph.js");
const root = mkdtempSync(join(tmpdir(), "rl-cg-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

const stdio = (command: string, args: string[], env: Record<string, string> = {}) => ({ type: "stdio" as const, command, args, env });
let n = 0;
function fixture(env: Record<string, string> = {}, cacheDir = join(root, `cache-${n}`)) {
  const dir = join(root, String(n++));
  const repo = join(dir, "work", "repo");
  mkdirSync(repo, { recursive: true });
  const log = join(dir, "calls.jsonl");
  const entry = stdio(process.execPath, [FAKE_CG, "serve", "--mcp"], { FAKE_CG_LOG: log, ...env });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { cmd: string; args: string[]; cwd: string; env: Record<string, string | null> })
      : [];
  return { repo, entry, calls, cacheDb: join(cacheDir, "codegraph.db"), dataDir: join(dir, "data") };
}

describe("codegraph detection", () => {
  test("finds `codegraph serve --mcp` in the command or the args", () => {
    expect(codegraphIndex(stdio("codegraph", ["serve", "--mcp"]))).toBe(0);
    expect(codegraphIndex(stdio("C:\\tools\\codegraph.cmd", ["serve", "--mcp"]))).toBe(0);
    expect(codegraphIndex(stdio("/usr/local/bin/codegraph", ["serve", "--path", "/x", "--mcp"]))).toBe(0);
    expect(codegraphIndex(stdio("npx", ["-y", "@colbymchenry/codegraph@1.6.2", "serve", "--mcp"]))).toBe(2);
    expect(codegraphIndex(stdio("node", ["/plugins/cg/codegraph.js", "serve", "--mcp"]))).toBe(1);
    expect(codegraphIndex(stdio("codegraph", ["serve"]))).toBe(-1);
    expect(codegraphIndex(stdio("codegraph", ["--mcp", "serve"]))).toBe(-1);
    expect(codegraphIndex(stdio("codegraph", ["init", "--mcp"]))).toBe(-1);
    expect(codegraphIndex(stdio("codegraph-lite", ["serve", "--mcp"]))).toBe(-1);
    expect(codegraphIndex(stdio("other", ["serve", "--mcp"]))).toBe(-1);
    expect(codegraphIndex({ type: "http", url: "https://codegraph.example.test/serve", headers: {} })).toBe(-1);
  });

  test("the run entry keeps the command, drops the user's serve options, and pins the snapshot", () => {
    const user = stdio("npx", ["-y", "@colbymchenry/codegraph", "serve", "--path", "/home/me/clone", "--mcp"], {
      CODEGRAPH_DIR: "x",
      KEEP: "1",
    });
    expect(codegraphEntry(user, "/data/runs/7/work/repo")).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@colbymchenry/codegraph", "serve", "--mcp", "--path", "/data/runs/7/work/repo", "--no-watch"],
      env: {
        KEEP: "1",
        CODEGRAPH_DIR: "",
        CODEGRAPH_NO_DAEMON: "1",
        DO_NOT_TRACK: "1",
        CODEGRAPH_NO_UPDATE_CHECK: "1",
        CODEGRAPH_NO_DOWNLOAD: "1",
      },
    });
  });

  test("the sanitizer removes .codegraph folders at any depth", async () => {
    const repo = join(root, "sanitize");
    for (const d of [".codegraph", "sub/.codegraph", "sub/.CodeGraph-WSL"]) {
      mkdirSync(join(repo, d), { recursive: true });
      writeFileSync(join(repo, d, "codegraph.db"), "pr index");
    }
    writeFileSync(join(repo, "keep.ts"), "");
    const { removed } = await sanitize(repo, []);
    expect(removed.sort()).toEqual([".codegraph", "sub/.CodeGraph-WSL", "sub/.codegraph"]);
    expect(existsSync(join(repo, "keep.ts"))).toBe(true);
  });
});

describe("indexCodegraph with a fake codegraph", () => {
  test("no cache: init in the snapshot, then status; the db goes to the cache. A cache: sync", async () => {
    const before = process.env.CODEGRAPH_DIR;
    process.env.CODEGRAPH_DIR = ".elsewhere";
    const a = fixture({ CODEGRAPH_NO_WATCH: "1" });
    try {
      expect(await indexCodegraph(a)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.CODEGRAPH_DIR;
      else process.env.CODEGRAPH_DIR = before;
    }
    const calls = a.calls();
    expect(calls.map((c) => c.cmd)).toEqual(["init", "status"]);
    expect(calls[0]?.args).toEqual(["--yes", a.repo]);
    expect(calls[1]?.args).toEqual(["--json", a.repo]);
    for (const c of calls) {
      expect(c.cwd.toLowerCase()).toBe(a.repo.toLowerCase());
      expect(c.env).toEqual({
        DO_NOT_TRACK: "1",
        CODEGRAPH_NO_UPDATE_CHECK: "1",
        CODEGRAPH_NO_DOWNLOAD: "1",
        CODEGRAPH_DIR: null,
        CODEGRAPH_NO_WATCH: null,
        GIT_CONFIG_NOSYSTEM: "1",
      });
    }
    expect(readFileSync(a.cacheDb, "utf8")).toBe("fake-index\n");

    const b = fixture({}, join(a.cacheDb, ".."));
    expect(await indexCodegraph(b)).toBeNull();
    expect(b.calls().map((c) => c.cmd)).toEqual(["sync", "status"]);
    expect(readFileSync(join(b.repo, ".codegraph", "codegraph.db"), "utf8")).toBe("fake-index\nsynced\n");
    expect(readFileSync(b.cacheDb, "utf8")).toBe("fake-index\nsynced\n");
  });

  test("a failed sync of the cache falls back to init", async () => {
    const a = fixture();
    mkdirSync(join(a.cacheDb, ".."), { recursive: true });
    writeFileSync(a.cacheDb, "damaged");
    const b = fixture({ FAKE_CG: "fail-sync" }, join(a.cacheDb, ".."));
    expect(await indexCodegraph(b)).toBeNull();
    expect(b.calls().map((c) => c.cmd)).toEqual(["sync", "init", "status"]);
    expect(readFileSync(b.cacheDb, "utf8")).toBe("fake-index\n");
  });

  test("a failure, a timeout, a cancel, or an index outside the snapshot gives a reason and no cache", async () => {
    const fail = fixture({ FAKE_CG: "fail" });
    expect(await indexCodegraph(fail)).toBe("codegraph init or sync failed");
    expect(existsSync(fail.cacheDb)).toBe(false);

    const outside = fixture({ FAKE_CG: "outside" });
    expect(await indexCodegraph(outside)).toBe("codegraph status failed");
    expect(existsSync(outside.cacheDb)).toBe(false);

    const hang = fixture({ FAKE_CG: "hang" });
    const t0 = Date.now();
    expect(await indexCodegraph({ ...hang, timeoutMs: 1_500 })).toBe("no index in 2 s");
    expect(Date.now() - t0).toBeLessThan(15_000);

    const cancel = fixture({ FAKE_CG: "hang" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect(await indexCodegraph({ ...cancel, signal: ac.signal })).toBe("cancelled");
  }, 30_000);
});

// Real codegraph, when it is on PATH. It indexes a two-file temp folder only.
const real = Bun.which("codegraph");
describe.skipIf(!real)("indexCodegraph with the real codegraph", () => {
  test("init, then a sync from the cache in a new snapshot", async () => {
    const cacheDir = join(root, "real-cache");
    const make = () => {
      const f = fixture({}, cacheDir);
      writeFileSync(join(f.repo, "a.ts"), "export function alpha() { return beta(); }\nfunction beta() { return 1; }\n");
      return { ...f, entry: stdio("codegraph", ["serve", "--mcp"]) };
    };
    const a = make();
    expect(await indexCodegraph(a)).toBeNull();
    expect(existsSync(a.cacheDb)).toBe(true);
    const b = make();
    writeFileSync(join(b.repo, "b.ts"), "export const gamma = 2;\n");
    expect(await indexCodegraph(b)).toBeNull();
    expect(existsSync(join(b.repo, ".codegraph", "codegraph.db"))).toBe(true);
  }, 300_000);
});
