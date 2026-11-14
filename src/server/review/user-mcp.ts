// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// MCP servers of the user's Claude config (user scope) and of the enabled plugins for review profiles. Entries can hold secrets: no URL, header, command, args, or env value leaves this module except into the run's mcp.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type McpPick, type McpServerDto, type McpToolDto, mcpServerId, mcpToolSafety } from "../../shared/dto";
import { DOC_SERVERS, GIT_SERVER } from "./catalog";
import { childEnv, killTree, NAME, type UserMcpEntry, type UserServerSpec } from "./claude";
import { claudeConfigDir, enabledPlugins, readJson } from "./skills";

const LIST_TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;
const MAX_DESCRIPTION = 500;
// The app's own servers keep these names.
const RESERVED = new Set([GIT_SERVER, ...Object.keys(DOC_SERVERS)]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Claude Code 2.1.x (getGlobalClaudeFile): <config home>/.config.json when it exists, else .claude.json in CLAUDE_CONFIG_DIR or the home folder.
// configDir: CLAUDE_CONFIG_DIR. The child env of the CLI keeps it.
export function claudeJsonPath(configDir = process.env.CLAUDE_CONFIG_DIR) {
  const legacy = join(configDir || join(homedir(), ".claude"), ".config.json");
  return existsSync(legacy) ? legacy : join(configDir || homedir(), ".claude.json");
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> | null =>
  v === undefined ? {} : record(v) && Object.values(v).every((x) => typeof x === "string") ? (v as Record<string, string>) : null;

// A remote server needs https. Plain http stays on this machine.
function remoteUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname)) ? v : null;
  } catch {
    return null;
  }
}

// Keeps only the fields that the CLI needs to start the server. null: the entry is not usable.
function entryOf(v: unknown): UserMcpEntry | null {
  if (!record(v)) return null;
  const type = v.type ?? "stdio";
  if (type === "stdio") {
    const args = v.args ?? [];
    const env = strings(v.env);
    if (typeof v.command !== "string" || !v.command || !Array.isArray(args) || !args.every((a) => typeof a === "string") || !env)
      return null;
    return { type, command: v.command, args, env };
  }
  if (type === "http" || type === "sse") {
    const url = remoteUrl(v.url);
    const headers = strings(v.headers);
    return url && headers ? { type, url, headers } : null;
  }
  return null;
}

// The top-level mcpServers of the config file. Reads the disk on each call. A missing file or bad JSON gives no servers, never an error.
export function readUserServers(file = claudeJsonPath()): Map<string, UserMcpEntry> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
  const servers = record(json) && record(json.mcpServers) ? json.mcpServers : {};
  const out = new Map<string, UserMcpEntry>();
  for (const [name, v] of Object.entries(servers)) {
    const e = NAME.test(name) && !RESERVED.has(name) ? entryOf(v) : null;
    if (e) out.set(name, e);
  }
  return out;
}

// key: the server name in the run's mcp.json. plugin: the plugin that declares the server.
export type FoundServer = { key: string; entry: UserMcpEntry; plugin?: string };

// A file of plugin servers: { mcpServers: {...} } or the bare map.
const serverMap = (j: unknown): Record<string, unknown> => (record(j) && record(j.mcpServers) ? j.mcpServers : record(j) ? j : {});

// code.claude.com/docs/en/plugins-reference, "mcpServers": .mcp.json first, then each plugin.json shape in order. A later name replaces an earlier one.
// A .json path must stay in the plugin folder. MCP bundles (.mcpb, .dxt) are not supported.
function pluginServerMap(root: string): Record<string, unknown> {
  const out = { ...serverMap(readJson(join(root, ".mcp.json"))) };
  const manifest = readJson(join(root, ".claude-plugin", "plugin.json"));
  const declared = record(manifest) ? manifest.mcpServers : undefined;
  for (const d of Array.isArray(declared) ? declared : [declared]) {
    if (record(d)) Object.assign(out, d);
    else if (typeof d === "string" && d.endsWith(".json")) {
      const path = resolve(root, d);
      const rel = relative(root, path);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) Object.assign(out, serverMap(readJson(path)));
    }
  }
  return out;
}

// The user servers by name, then the servers of each enabled plugin by <plugin>:<server>. Reads the disk on each call.
// A plugin server gets the key plugin_<plugin>_<server>, as in the CLI. A key that is already in use drops the plugin server.
export function readServers(file = claudeJsonPath(), config = claudeConfigDir()): Map<string, FoundServer> {
  const out = new Map<string, FoundServer>();
  for (const [name, entry] of readUserServers(file)) out.set(name, { key: name, entry });
  const keys = new Set([...RESERVED, ...out.keys()]);
  for (const p of enabledPlugins(config)) {
    // code.claude.com/docs/en/plugins-reference, "Environment variables": the CLI resolves these in command, args, env, url, and headers.
    const vars = {
      CLAUDE_PLUGIN_ROOT: p.path,
      CLAUDE_PLUGIN_DATA: join(config, "plugins", "data", p.key.replace(/[^A-Za-z0-9_-]/g, "-")),
    };
    for (const [name, raw] of Object.entries(pluginServerMap(p.path))) {
      const id = `${p.plugin}:${name}`;
      const key = `plugin_${p.plugin}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
      const text = JSON.stringify(raw);
      // The CLI fills ${user_config.KEY} from values that the app cannot read. Such a server cannot start.
      if (!NAME.test(name) || !mcpServerId.safeParse(id).success || keys.has(key) || text.includes("${user_config.")) continue;
      const entry = entryOf(
        JSON.parse(text, (_, v) =>
          typeof v === "string" ? v.replace(/\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA)\}/g, (_m, k: keyof typeof vars) => vars[k]) : v,
        ),
      );
      if (!entry) continue;
      if (entry.type === "stdio") {
        // The CLI exports both variables to a stdio server and creates the data folder on first reference.
        entry.env = { ...vars, ...entry.env };
        if (/\$\{CLAUDE_PLUGIN_DATA\}/.test(text)) mkdirSync(vars.CLAUDE_PLUGIN_DATA, { recursive: true });
      }
      keys.add(key);
      out.set(id, { key, entry, plugin: p.plugin });
    }
  }
  return out;
}

export const discoverMcpServers = (file = claudeJsonPath(), config = claudeConfigDir()): McpServerDto[] =>
  [...readServers(file, config)].map(([name, s]) =>
    s.plugin ? { name, transport: s.entry.type, source: "plugin", plugin: s.plugin } : { name, transport: s.entry.type, source: "user" },
  );

// code.claude.com/docs/en/mcp, "Environment variable expansion": ${VAR} and ${VAR:-default}. The run's CLI expands the copied entry itself.
export const expand = (s: string, env: Record<string, string>) =>
  s.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (m, k: string, d?: string) => env[k] ?? d ?? m);
export const expandAll = (o: Record<string, string>, env: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v, env)]));

// A failure with a message that holds no URL, header, or command text.
export class McpListError extends Error {
  override name = "McpListError";
}

function safeError(e: unknown, timeoutMs: number): McpListError {
  const err = e as { code?: unknown; name?: unknown };
  // McpError RequestTimeout is -32001. AbortSignal.timeout gives a TimeoutError. The SDK HTTP errors carry the HTTP status as code.
  if (err?.code === -32001 || err?.name === "TimeoutError") return new McpListError(`no answer in ${timeoutMs / 1000} s`);
  if (err?.code === "ENOENT") return new McpListError("the command was not found");
  if (typeof err?.code === "number" && err.code >= 400 && err.code < 600) return new McpListError(`HTTP ${err.code}`);
  return new McpListError("the server did not start or did not answer");
}

// timeoutMs covers the server start and every tools/list page.
export type ListUserTools = (entry: UserMcpEntry, timeoutMs?: number) => Promise<McpToolDto[]>;

// Starts or calls one server and runs tools/list. Tool names that the CLI flags cannot hold are dropped.
export const listUserTools: ListUserTools = async (entry, timeoutMs = LIST_TIMEOUT_MS) => {
  const env = childEnv();
  let transport: Transport;
  let stdio: StdioClientTransport | null = null;
  let cwd: string | null = null;
  if (entry.type === "stdio") {
    // The CLI starts the server in the run folder. Discovery has no run folder. An empty folder keeps scans such as codegraph short.
    cwd = mkdtempSync(join(tmpdir(), "rl-mcp-"));
    stdio = new StdioClientTransport({
      command: expand(entry.command, env),
      args: entry.args.map((a) => expand(a, env)),
      env: { ...env, ...expandAll(entry.env, env) },
      cwd,
      stderr: "ignore",
    });
    transport = stdio;
  } else {
    const url = new URL(expand(entry.url, env));
    const requestInit = { headers: expandAll(entry.headers, env) };
    transport =
      entry.type === "http" ? new StreamableHTTPClientTransport(url, { requestInit }) : new SSEClientTransport(url, { requestInit });
  }
  const client = new Client({ name: "review-loop", version: "1" });
  const timer = AbortSignal.timeout(timeoutMs);
  try {
    await client.connect(transport, { timeout: timeoutMs, signal: timer });
    const out: McpToolDto[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs, signal: timer });
      for (const t of r.tools)
        if (NAME.test(t.name))
          out.push({
            name: t.name,
            description: (t.description ?? "").slice(0, MAX_DESCRIPTION),
            readOnlyHint: typeof t.annotations?.readOnlyHint === "boolean" ? t.annotations.readOnlyHint : null,
            destructiveHint: typeof t.annotations?.destructiveHint === "boolean" ? t.annotations.destructiveHint : null,
          });
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  } catch (e) {
    throw safeError(e, timeoutMs);
  } finally {
    // A command such as npx starts child processes. On Windows only taskkill /T ends the tree. It runs first, so the PID is not reused yet.
    const pid = stdio?.pid;
    if (pid && process.platform === "win32") await killTree(pid).catch(() => {});
    await client.close().catch(() => {});
    // Windows locks the cwd of a live process. The retries cover the exit after the kill. A folder left behind does not fail the listing.
    if (cwd)
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {}
  }
};

// The servers of the run for the profile picks. It re-reads the config, so a run gets the current entries.
// gaps: one line for each picked server or tool that the run does not get. A pick with no tools is skipped.
// unmarked: each allowed tool with no readOnlyHint, as "<tool> (<server>)". A blocked tool is never allowed.
export async function userServers(
  picks: McpPick[],
  file = claudeJsonPath(),
  configDir = claudeConfigDir(),
  list: ListUserTools = listUserTools,
): Promise<{ servers: Record<string, UserServerSpec>; gaps: string[]; unmarked: string[] }> {
  const servers: Record<string, UserServerSpec> = {};
  const gaps: string[] = [];
  const unmarked: string[] = [];
  const used = picks.filter((p) => p.tools.length);
  if (!used.length) return { servers, gaps, unmarked };
  const config = readServers(file, configDir);
  const found = await Promise.allSettled(
    used.map(async (p) => {
      const s = config.get(p.server);
      return s ? { key: s.key, user: s.entry, plugin: !!s.plugin, tools: await list(s.entry) } : null;
    }),
  );
  used.forEach((p, i) => {
    const r = found[i] as PromiseSettledResult<{ key: string; user: UserMcpEntry; plugin: boolean; tools: McpToolDto[] } | null>;
    if (r.status === "rejected") {
      gaps.push(`MCP server ${p.server}: unavailable (${r.reason instanceof McpListError ? r.reason.message : "error"})`);
      return;
    }
    if (!r.value) {
      gaps.push(`MCP server ${p.server}: not found in the Claude config`);
      return;
    }
    const { key, user, plugin } = r.value;
    const safety = new Map(r.value.tools.map((t) => [t.name, mcpToolSafety(t)]));
    const tools = [...safety.keys()];
    for (const t of p.tools)
      if (!safety.has(t)) gaps.push(`MCP tool ${p.server}/${t}: not found`);
      else if (safety.get(t) === "blocked") gaps.push(`MCP tool ${p.server}/${t}: blocked by the safety rule`);
    const chosen = p.tools.filter((t) => safety.has(t) && safety.get(t) !== "blocked");
    for (const t of chosen) if (safety.get(t) === "unmarked") unmarked.push(`${t} (${plugin ? "plugin " : ""}${p.server})`);
    if (chosen.length) servers[key] = { user, tools: chosen, deny: tools.filter((t) => !chosen.includes(t)) };
  });
  return { servers, gaps, unmarked };
}
