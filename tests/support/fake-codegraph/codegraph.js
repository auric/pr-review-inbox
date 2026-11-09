// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fake codegraph CLI for tests. It never parses code. The file name makes the app treat it as codegraph.
// Usage: bun codegraph.js init --yes <path> | sync <path> | status --json <path> | serve --mcp [...]
// FAKE_CG: fail (every index command exits 1), fail-sync, hang, outside (status names another index folder).
// FAKE_CG_LOG: a file that gets one JSON line per call.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const [cmd, ...rest] = process.argv.slice(2);
const mode = process.env.FAKE_CG ?? "";
const keys = [
  "DO_NOT_TRACK",
  "CODEGRAPH_NO_UPDATE_CHECK",
  "CODEGRAPH_NO_DOWNLOAD",
  "CODEGRAPH_DIR",
  "CODEGRAPH_NO_WATCH",
  "GIT_CONFIG_NOSYSTEM",
];
const env = Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));
if (process.env.FAKE_CG_LOG) appendFileSync(process.env.FAKE_CG_LOG, `${JSON.stringify({ cmd, args: rest, cwd: process.cwd(), env })}\n`);

if (cmd === "serve") {
  const server = new McpServer({ name: "fake-codegraph", version: "1.0.0" });
  server.registerTool("codegraph_explore", { description: "Explores the fake index.", annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: "explore" }],
  }));
  await server.connect(new StdioServerTransport());
} else {
  if (mode === "hang") await new Promise((r) => setTimeout(r, 60_000));
  if (mode === "fail" || (mode === "fail-sync" && cmd === "sync")) process.exit(1);
  const path = rest.at(-1) ?? "";
  const db = join(path, ".codegraph", "codegraph.db");
  if (cmd === "init") {
    mkdirSync(dirname(db), { recursive: true });
    writeFileSync(db, "fake-index\n");
  } else if (cmd === "sync") {
    if (!existsSync(db)) process.exit(1);
    appendFileSync(db, "synced\n");
  } else if (cmd === "status")
    console.log(
      JSON.stringify({ initialized: existsSync(db), indexPath: mode === "outside" ? join(dirname(path), ".codegraph") : dirname(db) }),
    );
  else process.exit(2);
}
