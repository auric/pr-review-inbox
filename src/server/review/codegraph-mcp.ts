// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Stdio MCP proxy in front of `codegraph serve`. codegraph 1.6.3 lets each tool open the nearest index above any path through the
// projectPath argument (lib/dist/mcp/tools.js getCodeGraph). No flag turns that off, so the proxy hides projectPath and refuses each call that sets it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { killTree } from "./claude";

const PROJECT_PATH = "projectPath";
// The CLI owns the tool deadline. This is the largest setTimeout delay.
const NO_DEADLINE_MS = 2_147_483_647;
export const REFUSED = `This server reads only the index of the run's repository. Call the tool again without ${PROJECT_PATH}.`;

// codegraph withRequiredProjectPath can also list projectPath in required.
export function hideProjectPath(tool: Tool): Tool {
  const { properties, required, ...schema } = tool.inputSchema;
  const props = { ...properties };
  delete props[PROJECT_PATH];
  return {
    ...tool,
    inputSchema: {
      ...schema,
      ...(properties ? { properties: props } : {}),
      ...(required ? { required: required.filter((k) => k !== PROJECT_PATH) } : {}),
    },
  };
}

// The proxy server for a connected codegraph client. Only tools/list and tools/call pass.
export function createCodegraphProxy(client: Client): Server {
  const server = new Server({ name: "codegraph", version: "1" }, { capabilities: { tools: {} }, instructions: client.getInstructions() });
  server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const r = await client.listTools(req.params, { signal: extra.signal, timeout: NO_DEADLINE_MS });
    return { ...r, tools: r.tools.map(hideProjectPath) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (req.params.arguments && Object.hasOwn(req.params.arguments, PROJECT_PATH))
      return { content: [{ type: "text", text: REFUSED }], isError: true };
    return client.request({ method: "tools/call", params: req.params }, CallToolResultSchema, {
      signal: extra.signal,
      timeout: NO_DEADLINE_MS,
    });
  });
  return server;
}

// argv: -- <codegraph command> serve --mcp ... The child gets the proxy's environment and working folder.
export async function runCodegraphMcp(argv: string[]) {
  const [command, ...args] = argv[0] === "--" ? argv.slice(1) : argv;
  if (!command) {
    console.error("usage: --codegraph-mcp -- <codegraph command> serve --mcp --path <repo>");
    process.exit(2);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const child = new StdioClientTransport({ command, args, env, stderr: "inherit" });
  const client = new Client({ name: "review-loop-codegraph-proxy", version: "1" });
  let ending = false;
  const end = async (code: number) => {
    if (ending) return;
    ending = true;
    // A command such as npx starts child processes. On Windows only taskkill /T ends the tree. It runs first, so the PID is not reused yet.
    const pid = child.pid;
    if (pid && process.platform === "win32") await killTree(pid).catch(() => {});
    await client.close().catch(() => {});
    process.exit(code);
  };
  client.onclose = () => void end(0);
  try {
    await client.connect(child);
  } catch (e) {
    console.error(`codegraph did not start: ${(e as Error).message}`);
    await end(1);
    return;
  }
  process.stdin.on("end", () => void end(0));
  process.stdin.on("close", () => void end(0));
  await createCodegraphProxy(client).connect(new StdioServerTransport());
}
