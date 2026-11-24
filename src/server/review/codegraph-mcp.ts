// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Stdio MCP proxy in front of `codegraph serve`. codegraph 1.6.3 lets each tool open the nearest index above any path through the
// projectPath argument (lib/dist/mcp/tools.js getCodeGraph). No flag turns that off, so the proxy hides projectPath and refuses each call that sets it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { killTree, NAME } from "./claude";
import { LIST_TIMEOUT_MS } from "./user-mcp";

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

// The CLI exposes a tool only as mcp__<server>__<tool> (code.claude.com/docs/en/mcp). codegraph 1.6.3 server-instructions.js and the
// tool descriptions of tools.js name the bare tool, and a call by that name fails with "No such tool". Tool results keep their text,
// because they hold source code.
export function fullToolNames(text: string, server: string, tools: string[]): string {
  const names = tools.filter((t) => NAME.test(t));
  if (!names.length) return text;
  return text.replace(new RegExp(`(?<!\\w)(?:${names.join("|")})(?!\\w)`, "g"), (t) => `mcp__${server}__${t}`);
}

// The proxy server for a connected codegraph client. Only tools/list and tools/call pass. server: the mcp.json key of the proxy.
// tools: the tool names of the client.
export function createCodegraphProxy(client: Client, server: string, tools: string[]): Server {
  const text = client.getInstructions();
  const proxy = new Server(
    { name: "codegraph", version: "1" },
    { capabilities: { tools: {} }, instructions: text && fullToolNames(text, server, tools) },
  );
  proxy.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
    const r = await client.listTools(req.params, { signal: extra.signal, timeout: NO_DEADLINE_MS });
    const full = (t: Tool) => (t.description ? { ...t, description: fullToolNames(t.description, server, tools) } : t);
    return { ...r, tools: r.tools.map((t) => full(hideProjectPath(t))) };
  });
  proxy.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (req.params.arguments && Object.hasOwn(req.params.arguments, PROJECT_PATH))
      return { content: [{ type: "text", text: REFUSED }], isError: true };
    return client.request({ method: "tools/call", params: req.params }, CallToolResultSchema, {
      signal: extra.signal,
      timeout: NO_DEADLINE_MS,
    });
  });
  return proxy;
}

// argv: <server> -- <codegraph command> serve --mcp ... The child gets the proxy's environment and working folder.
export async function runCodegraphMcp(argv: string[]) {
  const [server, sep, command, ...args] = argv;
  if (!server || !NAME.test(server) || sep !== "--" || !command) {
    console.error("usage: --codegraph-mcp <server> -- <codegraph command> serve --mcp --path <repo>");
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
  const tools: string[] = [];
  try {
    const signal = AbortSignal.timeout(LIST_TIMEOUT_MS);
    let cursor: string | undefined;
    do {
      const r = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: LIST_TIMEOUT_MS });
      tools.push(...r.tools.map((t) => t.name));
      cursor = r.nextCursor;
    } while (cursor);
  } catch (e) {
    console.error(`codegraph did not list its tools: ${(e as Error).message}`);
    await end(1);
    return;
  }
  process.stdin.on("end", () => void end(0));
  process.stdin.on("close", () => void end(0));
  await createCodegraphProxy(client, server, tools).connect(new StdioServerTransport());
}
