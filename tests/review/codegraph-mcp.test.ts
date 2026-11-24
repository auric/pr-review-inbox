// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fullToolNames, hideProjectPath, REFUSED } from "../../src/server/review/codegraph-mcp";

const MAIN = join(import.meta.dir, "../../src/server/main.ts");
const FAKE_CG = join(import.meta.dir, "../support/fake-codegraph/codegraph.js");
const root = mkdtempSync(join(tmpdir(), "rl-cgmcp-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
const SLOW = 30_000;

let n = 0;
function fixture() {
  const log = join(root, `calls-${n++}.jsonl`);
  const argv = [MAIN, "--codegraph-mcp", "cg", "--", process.execPath, FAKE_CG, "serve", "--mcp"];
  const env: Record<string, string> = { FAKE_CG_LOG: log };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] ??= v;
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { cmd?: string; call?: string; arguments?: Record<string, unknown>; pid?: number })
          .filter((l) => l.call)
      : [];
  return { argv, env, calls };
}

async function connect(f: ReturnType<typeof fixture>) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: f.argv, env: f.env, stderr: "ignore" }));
  return client;
}

async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("codegraph MCP proxy", () => {
  test("hideProjectPath drops the property and the required entry", () => {
    const tool = {
      name: "codegraph_explore",
      inputSchema: {
        type: "object" as const,
        properties: { query: { type: "string" }, projectPath: { type: "string" } },
        required: ["query", "projectPath"],
      },
      annotations: { readOnlyHint: true },
    };
    expect(hideProjectPath(tool)).toEqual({
      name: "codegraph_explore",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { readOnlyHint: true },
    });
  });

  test("fullToolNames writes the full name of each listed tool and keeps other words", () => {
    expect(fullToolNames("Use `a_b`, a_b. Not a_bc or x_a_b or mcp__s__a_b.", "s", ["a_b", "bad name"])).toBe(
      "Use `mcp__s__a_b`, mcp__s__a_b. Not a_bc or x_a_b or mcp__s__a_b.",
    );
    expect(fullToolNames("text", "s", [])).toBe("text");
  });

  test(
    "the server instructions name each tool by the full name that the CLI exposes",
    async () => {
      const client = await connect(fixture());
      try {
        expect(client.getInstructions()).toBe(
          "Call `mcp__cg__codegraph_explore` first. mcp__cg__codegraph_note writes notes. codegraph_explorer is no tool.",
        );
      } finally {
        await client.close();
      }
    },
    SLOW,
  );

  test(
    "lists the tools without projectPath and keeps the annotations",
    async () => {
      const client = await connect(fixture());
      try {
        const { tools } = await client.listTools();
        const explore = tools.find((t) => t.name === "codegraph_explore");
        expect(Object.keys(explore?.inputSchema.properties ?? {})).toEqual(["query"]);
        expect(explore?.inputSchema.required ?? []).not.toContain("projectPath");
        expect(explore?.annotations?.readOnlyHint).toBe(true);
        expect(explore?.description).toBe("Explores the fake index. mcp__cg__codegraph_note writes notes.");
        expect(tools.map((t) => t.name).sort()).toEqual(["codegraph_explore", "codegraph_note"]);
      } finally {
        await client.close();
      }
    },
    SLOW,
  );

  test(
    "refuses a call with projectPath before the child and passes a plain call",
    async () => {
      const f = fixture();
      const client = await connect(f);
      try {
        for (const projectPath of ["/home/me/clone", "", null]) {
          const r = await client.callTool({ name: "codegraph_explore", arguments: { query: "x", projectPath } });
          expect(r.isError).toBe(true);
          expect(r.content).toEqual([{ type: "text", text: REFUSED }]);
        }
        const ok = await client.callTool({ name: "codegraph_explore", arguments: { query: "x" } });
        expect(ok.isError).toBeFalsy();
        expect(ok.content).toEqual([{ type: "text", text: "explore" }]);
        expect(f.calls().map((c) => c.arguments)).toEqual([{ query: "x" }]);
      } finally {
        await client.close();
      }
    },
    SLOW,
  );

  test(
    "the codegraph child exits when the proxy stdin closes",
    async () => {
      const f = fixture();
      const proxy = Bun.spawn([process.execPath, ...f.argv], { env: f.env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      const msg = (m: object) => `${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`;
      proxy.stdin.write(
        msg({
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }) +
          msg({ method: "notifications/initialized" }) +
          msg({ id: 2, method: "tools/call", params: { name: "codegraph_explore", arguments: { query: "x" } } }),
      );
      proxy.stdin.flush();
      try {
        expect(await waitFor(() => f.calls().length === 1)).toBe(true);
        const pid = f.calls()[0]?.pid as number;
        expect(alive(pid)).toBe(true);
        proxy.stdin.end();
        expect(await Promise.race([proxy.exited, Bun.sleep(10_000).then(() => "timeout")])).toBe(0);
        expect(await waitFor(() => !alive(pid))).toBe(true);
      } finally {
        proxy.kill();
      }
    },
    SLOW,
  );
});
