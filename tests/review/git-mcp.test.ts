// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { git, gitEnv } from "../../src/server/review/git";
import { GIT_MCP_TOOLS, gitMcpServer, PAGE_BYTES, pages } from "../../src/server/review/git-mcp";

const MAIN = resolve(import.meta.dir, "../../src/server/main.ts");
const SLOW = 60_000;

let root = "";
let cache = "";
let client: Client;
let movesClient: Client;
let rereviewClient: Client;
const c = { c1: "", c2: "", c3: "", c4: "", c5: "", c6: "", c7: "" };
const m = { m1: "", m2: "", m3: "" };
// git blame -M and -C need a moved block of at least 20 alphanumeric characters.
const LONG = ["alpha line that is long enough to move", "beta line that is long enough to move", "gamma line that is long enough to move"];

// A 20,000-line added file. Its diff spans many pages.
const HUGE = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1} of the huge change\n`).join("");

// A bare repository like the WP6 cache. Commits go through a temp index.
// c1 -> c2 (target); c1 -> c3 -> c4 (head); c1 -> c5 (side, unrelated to all pins). The merge base is c1.
// Re-review: c1 -> c6 (an earlier head before a force push); c7 = merge(c6, c1), an app-made range base like rangeBaseOf builds.
// The moves repository: m1 -> m2 (rename old.txt to new.txt) -> m3 (move the first line of f.txt to the end).
async function fixture() {
  root = mkdtempSync(join(tmpdir(), "rl-wp7-"));
  cache = join(root, "cache.git");
  await repo(cache, async (commit) => {
    const big = `${"x".repeat(99)}\n`.repeat(4000);
    c.c1 = await commit(null, { "a.txt": "one\ntwo\nthree\n", "big.txt": big }, "first commit");
    c.c2 = await commit(c.c1, { "a.txt": "one\ntwo\nthree\nfour\n" }, "target change");
    c.c3 = await commit(c.c1, { "src/b.txt": "bee\n" }, "add bee");
    c.c4 = await commit(c.c3, { "a.txt": "one\nTWO\nthree\n", "huge.txt": HUGE }, "shout two");
    c.c5 = await commit(c.c1, { "side.txt": "side\n" }, "side work");
    c.c6 = await commit(c.c1, { "old.txt": "old head\n" }, "old head before force push");
    c.c7 = await commit([c.c6, c.c1], {}, "Range base");
    return [
      ["refs/rl/1/source", c.c4],
      ["refs/rl/1/target", c.c2],
      ["refs/heads/side", c.c5],
      ["refs/rl/1/reviewed", c.c6],
    ];
  });
  await repo(join(root, "moves.git"), async (commit) => {
    m.m1 = await commit(null, { "old.txt": "kept through a rename\n", "f.txt": `${LONG.join("\n")}\n` }, "add files");
    m.m2 = await commit(m.m1, { "old.txt": null, "new.txt": "kept through a rename\n" }, "rename old to new");
    m.m3 = await commit(m.m2, { "f.txt": `${LONG[1]}\n${LONG[2]}\n${LONG[0]}\n` }, "move alpha down");
    return [["refs/rl/2/source", m.m3]];
  });
}

type Commit = (parent: string | string[] | null, files: Record<string, string | null>, msg: string) => Promise<string>;

// A bare repository like the WP6 cache. Commits go through a temp index. A null body removes the path.
async function repo(dir: string, build: (commit: Commit) => Promise<[string, string][]>) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "Ann",
    GIT_AUTHOR_EMAIL: "ann@example.invalid",
    GIT_COMMITTER_NAME: "Ann",
    GIT_COMMITTER_EMAIL: "ann@example.invalid",
    GIT_INDEX_FILE: join(root, "author.index"),
  };
  const g = async (args: string[], stdin?: string) => (await git([`--git-dir=${dir}`, ...args], { env, stdin })).trim();
  await git(["init", "-q", "--bare", "--template=", dir], { env });
  let n = 0;
  const commit: Commit = async (parent, files, msg) => {
    const parents = parent === null ? [] : [parent].flat();
    await g(parents[0] ? ["read-tree", parents[0]] : ["read-tree", "--empty"]);
    for (const [path, body] of Object.entries(files)) {
      if (body === null) {
        // A bare repository has no work tree for --force-remove. Mode 0 in --index-info removes the entry.
        await g(["update-index", "--index-info"], `0 ${"0".repeat(40)}\t${path}\n`);
        continue;
      }
      const f = join(root, `blob-${n++}`);
      writeFileSync(f, body);
      const sha = await g(["hash-object", "-w", "--no-filters", f]);
      await g(["update-index", "--add", "--cacheinfo", `100644,${sha},${path}`]);
    }
    return g(["commit-tree", await g(["write-tree"]), ...parents.flatMap((p) => ["-p", p]), "-m", msg]);
  };
  for (const [ref, sha] of await build(commit)) await g(["update-ref", ref, sha]);
  rmSync(join(root, "author.index"));
}

// Every file under refs, objects, and the config files, by relative path.
function snapshot() {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(cache, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(join(cache, "refs"));
  walk(join(cache, "objects"));
  for (const f of ["config", "packed-refs", "HEAD"]) {
    try {
      out[f] = readFileSync(join(cache, f)).toString("base64");
    } catch {}
  }
  return out;
}

let before: Record<string, string> = {};

beforeAll(async () => {
  await fixture();
  before = snapshot();
  const spec = gitMcpServer({ cache, sourceHead: c.c4, rangeBase: c.c1, targetHead: c.c2 }, MAIN);
  client = new Client({ name: "wp7-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, stderr: "pipe" }));
  const moves = gitMcpServer({ cache: join(root, "moves.git"), sourceHead: m.m3, rangeBase: m.m1, targetHead: m.m1 }, MAIN);
  movesClient = new Client({ name: "wp7-moves-test", version: "0" });
  await movesClient.connect(new StdioClientTransport({ command: moves.command, args: moves.args, stderr: "pipe" }));
  const rereview = gitMcpServer({ cache, sourceHead: c.c4, rangeBase: c.c7, targetHead: c.c2 }, MAIN);
  rereviewClient = new Client({ name: "wp7-rereview-test", version: "0" });
  await rereviewClient.connect(new StdioClientTransport({ command: rereview.command, args: rereview.args, stderr: "pipe" }));
}, SLOW);

afterAll(async () => {
  await client?.close();
  await movesClient?.close();
  await rereviewClient?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

type Result = { isError?: boolean; content: { type: string; text: string }[] };
const call = async (name: string, args: Record<string, unknown>, on = client) => (await on.callTool({ name, arguments: args })) as Result;
const ok = async (name: string, args: Record<string, unknown>, on = client) => {
  const r = await call(name, args, on);
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  return r.content[0]?.text ?? "";
};
const refused = async (name: string, args: Record<string, unknown>, on = client) => {
  const r = await call(name, args, on);
  expect(r.isError).toBe(true);
  return r.content[0]?.text ?? "";
};

describe("git MCP server", () => {
  test("the RunSpec entry names the server command and the four tools", () => {
    const spec = gitMcpServer({ cache, sourceHead: c.c4, rangeBase: c.c1, targetHead: c.c2 }, MAIN);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args.slice(0, 3)).toEqual([MAIN, "--git-mcp", `--git-dir=${cache}`]);
    expect(spec.tools).toEqual(GIT_MCP_TOOLS);
  });

  test("offers exactly the four read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["git_blame", "git_diff", "git_log", "git_show"]);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  test("git_log lists the head history and the PR commits", async () => {
    const all = await ok("git_log", {});
    for (const h of [c.c4, c.c3, c.c1]) expect(all).toContain(h);
    expect(all).not.toContain(c.c2);
    const pr = await ok("git_log", { since: "BASE" });
    expect(pr).toContain(c.c4);
    expect(pr).toContain(c.c3);
    expect(pr).not.toContain(c.c1);
    expect(await ok("git_log", { rev: "TARGET", path: "a.txt", max_count: 1 })).toContain("target change");
    await refused("git_log", { max_count: 201 });
  });

  test("git_blame names the commit of each line", async () => {
    const out = await ok("git_blame", { path: "a.txt" });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(c.c1.slice(0, 39));
    expect(lines[1]).toStartWith(c.c4);
    expect(await ok("git_blame", { path: "a.txt", start_line: 2, max_lines: 1 })).toContain("TWO");
    await refused("git_blame", { path: "a.txt", max_lines: 401 });
  });

  test("git_log with a path follows a rename", async () => {
    const r = (await movesClient.callTool({ name: "git_log", arguments: { path: "new.txt" } })) as Result;
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    expect(r.content[0]?.text).toContain(m.m2);
    expect(r.content[0]?.text).toContain(m.m1);
  });

  test("git_blame keeps the commit of a moved line", async () => {
    const r = (await movesClient.callTool({ name: "git_blame", arguments: { path: "f.txt" } })) as Result;
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const lines = (r.content[0]?.text ?? "").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(LONG[0] as string);
    // The root commit prints as a boundary: "^" and 39 hex digits.
    expect(lines[2]).toStartWith(`^${m.m1.slice(0, 39)}`);
  });

  test("git_show shows a commit and a file at a commit", async () => {
    const commit = await ok("git_show", { rev: c.c3.slice(0, 7) });
    expect(commit).toContain("add bee");
    expect(commit).toContain("+bee");
    expect(await ok("git_show", { rev: "HEAD", path: "src/b.txt" })).toBe("bee\n");
  });

  test("git_show names a missing file instead of a bad revision", async () => {
    for (const [rev, p] of [
      ["BASE", "src/b.txt"],
      ["HEAD~1", "src/none.txt"],
    ]) {
      const out = await refused("git_show", { rev, path: p });
      expect(out).toContain(`File ${p} does not exist at ${rev}.`);
      expect(out).not.toContain("bad revision");
    }
    expect(await ok("git_show", { rev: "HEAD~1", path: "src/b.txt" })).toBe("bee\n");
  });

  test("git_diff shows the PR changes", async () => {
    const out = await ok("git_diff", {});
    expect(out).toContain("+TWO");
    expect(await ok("git_diff", { stat_only: true })).toBe(
      "1\t1\ta.txt\n20000\t0\thuge.txt\n1\t0\tsrc/b.txt\n create mode 100644 huge.txt\n create mode 100644 src/b.txt\n",
    );
    expect(await ok("git_diff", { from: "BASE", to: "TARGET", stat_only: true })).toContain("a.txt");
  });

  test("refuses options, traversal, refs, and commits outside the pinned history", async () => {
    const bads = [
      "--output=x",
      "-c",
      "-p",
      "refs/rl/1/source",
      "side",
      "main",
      "HEAD@{1}",
      "HEAD^{tree}",
      ":/side",
      "HEAD~1:a.txt",
      "HEAD^3",
      "HEAD~",
    ];
    for (const bad of [...bads, `${c.c1}..${c.c4}`]) {
      await refused("git_show", { rev: bad });
      await refused("git_diff", { from: bad });
    }
    for (const bad of ["--output=x", "-c", "../x", "src/../../x", "..", "/etc/passwd", "C:/x", "C:x", "\\\\host\\share"]) {
      await refused("git_show", { rev: "HEAD", path: bad });
      await refused("git_blame", { path: bad });
      await refused("git_log", { path: bad });
    }
    expect(await refused("git_show", { rev: c.c5 })).toContain("not in the history");
    expect(await refused("git_log", { rev: c.c5.slice(0, 8) })).toContain("not in the history");
    await refused("git_log", { rev: "HEAD", extra: "--output=x" });
    // TARGET history is allowed.
    expect(await ok("git_show", { rev: c.c2 })).toContain("target change");
  });

  test("accepts ~N and ^N after a hash or an alias", async () => {
    for (const r of ["HEAD~1", "HEAD^", "HEAD^1", `${c.c4}~1`, `${c.c4.slice(0, 8)}^`])
      expect(await ok("git_show", { rev: r })).toContain("add bee");
    expect(await ok("git_log", { rev: "HEAD~1", since: "HEAD~2" })).toContain(c.c3);
    expect(await refused("git_show", { rev: "HEAD~9" })).toContain("Unknown or ambiguous commit");
    expect(await refused("git_show", { rev: `${c.c5}~0` })).toContain("not in the history");
  });

  test("a re-review accepts the BASE history, also by hash", async () => {
    // c7 and c6 are only in the history of BASE. A first review refuses them.
    expect(await refused("git_show", { rev: c.c6 })).toContain("HEAD, BASE, or TARGET");
    expect(await ok("git_show", { rev: c.c7 }, rereviewClient)).toContain("Range base");
    expect(await ok("git_show", { rev: c.c6 }, rereviewClient)).toContain("old head before force push");
    expect(await ok("git_show", { rev: "BASE^" }, rereviewClient)).toContain("old head before force push");
    expect(await ok("git_show", { rev: "BASE^2", path: "a.txt" }, rereviewClient)).toBe("one\ntwo\nthree\n");
    expect(await ok("git_diff", { from: c.c7, stat_only: true }, rereviewClient)).toContain("src/b.txt");
    for (const r of [c.c5, `${c.c5}~0`, "side", "refs/rl/1/reviewed"]) await refused("git_show", { rev: r }, rereviewClient);
  });

  test("git_diff pages a 20,000-line change without a gap", async () => {
    const marker = /\n\[page (\d+) of (\d+)\.( Call again with page=(\d+)\.)?\]$/;
    const parts: string[] = [];
    let total = 0;
    for (let n = 1; ; n++) {
      const out = await ok("git_diff", { path: "huge.txt", page: n });
      expect(Buffer.byteLength(out)).toBeLessThan(PAGE_BYTES + 100);
      const m = marker.exec(out);
      expect(m?.[1]).toBe(String(n));
      total = Number(m?.[2]);
      parts.push(out.slice(0, m?.index));
      if (n === total) {
        expect(m?.[3]).toBeUndefined();
        break;
      }
      expect(m?.[4]).toBe(String(n + 1));
    }
    expect(total).toBeGreaterThan(5);
    const full = parts.join("");
    expect(full).toStartWith("diff --git a/huge.txt b/huge.txt\n");
    expect(full).toContain("@@ -0,0 +1,20000 @@\n");
    expect(full).toEndWith(
      HUGE.split("\n")
        .filter(Boolean)
        .map((l) => `+${l}\n`)
        .join(""),
    );
    expect(await refused("git_diff", { path: "huge.txt", page: total + 1 })).toContain(`The output has ${total} pages.`);
    // A short output has no marker.
    expect(await ok("git_show", { rev: "HEAD", path: "src/b.txt", page: 1 })).toBe("bee\n");
  });

  test("pages splits a long line, keeps surrogate pairs, and loses nothing", () => {
    const text = `${"\u{1F600}é".repeat(50_000)}\nshort\n${"x".repeat(PAGE_BYTES)}`;
    const parts = pages(text);
    expect(parts.join("")).toBe(text);
    for (const p of parts) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(PAGE_BYTES);
      expect(Buffer.from(p).toString()).toBe(p);
    }
  });

  test("leaves refs, objects, and config byte-equal", () => {
    expect(snapshot()).toEqual(before);
  });
});

test("gitEnv drops Bun and Node runtime flags from every git child", () => {
  const set = { BUN_BE_BUN: "1", BUN_OPTIONS: "--smol", NODE_OPTIONS: "--inspect", RL_KEEP_ME: "kept" };
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  try {
    for (const env of [gitEnv("/dev/null"), gitEnv("/dev/null", [["http.extraHeader", "x"]])]) {
      const keys = Object.keys(env).map((k) => k.toUpperCase());
      for (const k of ["BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS"]) expect(keys).not.toContain(k);
      expect(env.RL_KEEP_ME).toBe("kept");
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
