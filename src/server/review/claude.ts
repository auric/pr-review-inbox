// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Starts, watches, and stops one Claude Code review process. The flags, env, and cwd rules come from integration-check.md, "Gate v3, local".
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { EFFORTS, type Effort, modelName } from "../../shared/dto";
import type { RunErrorKind, RunEvent, SDKResultMessage, SDKSystemMessage } from "../../shared/run-log";
import { log } from "../log";
import { RUNTIME_ENV } from "./git";
import { classify, createStreamParser } from "./stream";

// Gate B ran on this version. Older versions have other flags and event shapes.
export const MIN_CLI_VERSION = "2.1.295";
export const MAIN_AGENT = "rl-main";
const READ_TOOLS = ["Read", "Grep", "Glob"];
// Names go into comma lists of CLI flags.
export const NAME = /^[A-Za-z0-9_-]+$/;
const STDERR_TAIL = 16_384;
const EXEC_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 5_000;
export const RUN_TIMEOUT_MS = 60 * 60_000;
// CreateProcess limits the Windows command line to 32,767 characters.
const MAX_ARGV = 32_000;

// model, effort: agent definition fields. Absent: Claude Code picks them.
export type AgentSpec = { description: string; prompt: string; model?: string; effort?: Effort };
// tools: the tool names the server offers, without the mcp__<server>__ prefix. A remote server gets no headers or credentials.
export type StdioServerSpec = { command: string; args: string[]; tools: string[] };
// A server entry of the user's Claude config, as the CLI reads it. It can hold secrets: never log it or store it.
export type UserMcpEntry =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };
// tools: the chosen tools. deny: the other tools of the server.
export type UserServerSpec = { user: UserMcpEntry; tools: string[]; deny: string[] };
export type McpServerSpec = StdioServerSpec | { type: "http"; url: string; tools: string[] } | UserServerSpec;
export type RunSpec = {
  // The work folder. The runner uses its long path.
  cwd: string;
  // The runner writes mcp.json and agents.json here. It must be outside cwd.
  appDir: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTurns: number;
  // --model and --effort. Absent or null: no flag.
  model?: string | null;
  effort?: Effort | null;
  main: AgentSpec;
  // Review subagents, by name. rl-main can call only these.
  agents: Record<string, AgentSpec>;
  mcpServers: Record<string, McpServerSpec>;
  // No built-in tool and no MCP server: the model can only answer. agents and mcpServers must be empty.
  noTools?: boolean;
};

// docs/plans/session-consult.md part C: a fork of the user's own session. resume: the absolute path of its transcript.
// The run gets no agent, no MCP server, and only the read tools. timeoutMs: lower than the runner limit.
export type ResumeSpec = {
  cwd: string;
  appDir: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTurns: number;
  resume: string;
  timeoutMs?: number;
};

// docs/plans/review-v2/spec.md section 6.7: one Claude step of a task (run kind implement). cwd: the part folder with repo/, the task
// worktree, and context/. The run gets no agent. timeoutMs: lower than the runner limit. appDir and mcpServers: the MCP servers of
// the profile and the git MCP server, as in RunSpec. appDir must be outside cwd. Absent: no MCP server.
export type ImplementSpec = {
  implement: true;
  cwd: string;
  appDir?: string;
  mcpServers?: Record<string, McpServerSpec>;
  prompt: string;
  schema: Record<string, unknown>;
  maxTurns: number;
  model?: string | null;
  effort?: Effort | null;
  timeoutMs?: number;
};

// Gate B17 (integration-check.md U72): with these tools, --restricted keeps Edit and Write inside the cwd. No Bash, no Agent.
export const IMPLEMENT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write"];

export type RunnerCheck =
  | { ok: true; command: string[]; version: string; projectsDir: string }
  | { ok: false; kind: "unavailable" | "auth"; message: string };

export type RunOutcome = {
  status: "completed" | "failed" | "cancelled";
  kind: RunErrorKind | null;
  text: string | null;
  // completed: the result that carries structured_output.
  result: SDKResultMessage | null;
  init: SDKSystemMessage | null;
  events: RunEvent[];
  exitCode: number | null;
  stderrTail: string;
};

export type RunnerOptions = {
  // The CLI argv prefix. Default: `claude` on PATH. Tests pass the fake CLI.
  command?: string[];
  timeoutMs?: number;
};

// Gate B: ANTHROPIC_* selects API billing. CLAUDECODE, CLAUDE_PID, and CLAUDE_CODE_* mark a nested session.
// The git MCP child gets this env through the CLI. mcp.json sets no env for it.
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Windows env names ignore case.
    const K = process.platform === "win32" ? k.toUpperCase() : k;
    if (v === undefined || K === "ANTHROPIC_API_KEY" || K === "ANTHROPIC_AUTH_TOKEN" || K === "CLAUDECODE" || K === "CLAUDE_PID") continue;
    if (K.startsWith("CLAUDE_CODE_") || RUNTIME_ENV.test(K)) continue;
    env[k] = v;
  }
  // Gate B3: with this switch, subagents run in the foreground and the run sends one result event.
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  return env;
}

function older(v: string, min: string) {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

async function exec(argv: string[], env: Record<string, string>) {
  try {
    const p = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: EXEC_TIMEOUT_MS, killSignal: "SIGKILL" });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } catch {
    return { code: -1, out: "" };
  }
}

// TS 5.9 types ReadableStream without an async iterator.
async function readText(stream: ReadableStream<Uint8Array>, each: (text: string) => void) {
  const r = stream.getReader();
  const dec = new TextDecoder();
  for (let c = await r.read(); !c.done; c = await r.read()) each(dec.decode(c.value, { stream: true }));
  each(dec.decode());
}

export async function killTree(pid: number) {
  // Gate 0 g: taskkill /T ends claude.exe and its MCP children.
  if (process.platform === "win32")
    await Bun.spawn(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore", timeout: EXEC_TIMEOUT_MS }).exited;
  else
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
}

// Gate B4: --no-session-persistence still writes these per-cwd folders. Their name is the cwd with each non-alphanumeric character replaced by "-".
function removeCwdFolders(cwd: string, projectsDir: string) {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  for (const dir of [join(projectsDir, name), join(tmpdir(), "claude", name)])
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (e) {
      log(`Could not delete a Claude Code session folder: ${(e as Error).message}`);
    }
}

// Checks the servers and writes mcp.json into appDir. tools: the full names of the chosen tools. allow: the --allowedTools entries.
// denied: the other tools of the user servers.
function writeMcp(appDir: string, mcpServers: Record<string, McpServerSpec>) {
  const servers = Object.entries(mcpServers);
  for (const n of servers.flatMap(([s, c]) => [s, ...c.tools, ...("user" in c ? c.deny : [])]))
    if (!NAME.test(n)) throw new Error(`Invalid agent, server, or tool name: ${n}`);
  for (const [s, c] of servers)
    if ("url" in c && new URL(c.url).protocol !== "https:") throw new Error(`MCP server ${s} needs an https URL.`);
  mkdirSync(appDir, { recursive: true });
  const file = join(appDir, "mcp.json");
  writeFileSync(
    file,
    // code.claude.com/docs/en/mcp: a remote entry needs "type": "http"; without it the CLI reads the entry as stdio.
    JSON.stringify({
      mcpServers: Object.fromEntries(
        servers.map(([s, c]) => [
          s,
          "user" in c ? c.user : "url" in c ? { type: "http", url: c.url } : { command: c.command, args: c.args },
        ]),
      ),
    }),
    // A user entry can hold secrets. Windows ignores the mode; the run folder is in the user's data folder.
    { mode: 0o600 },
  );
  return {
    file,
    // Gate B9: agent tool lists need full MCP tool names. --allowedTools needs mcp__<server>; a wildcard does not work.
    tools: servers.flatMap(([s, c]) => c.tools.map((t) => `mcp__${s}__${t}`)),
    allow: servers.flatMap(([s, c]) => ("user" in c ? c.tools.map((t) => `mcp__${s}__${t}`) : [`mcp__${s}`])),
    denied: servers.flatMap(([s, c]) => ("user" in c ? c.deny.map((t) => `mcp__${s}__${t}`) : [])),
  };
}

// Writes the MCP and agents files and returns the CLI arguments and the init tool allowlist.
function prepare(spec: RunSpec) {
  const reviewers = Object.keys(spec.agents);
  const servers = Object.keys(spec.mcpServers);
  for (const n of reviewers) if (!NAME.test(n)) throw new Error(`Invalid agent, server, or tool name: ${n}`);
  if (reviewers.includes(MAIN_AGENT)) throw new Error(`${MAIN_AGENT} cannot be a review agent.`);
  if (spec.noTools && (reviewers.length || servers.length)) throw new Error("A run without tools cannot have agents or MCP servers.");
  for (const a of [spec, spec.main, ...Object.values(spec.agents)]) {
    if (a.model != null && !modelName.safeParse(a.model).success) throw new Error(`Invalid model name: ${a.model}`);
    if (a.effort != null && !EFFORTS.includes(a.effort)) throw new Error(`Invalid effort: ${a.effort}`);
  }

  const mcp = writeMcp(spec.appDir, spec.mcpServers);
  const builtins = spec.noTools ? [] : READ_TOOLS;
  const readTools = [...builtins, ...mcp.tools];
  const denied = mcp.denied;
  const agentTool = reviewers.length ? [`Agent(${reviewers.join(", ")})`] : [];
  const mcpFile = mcp.file;
  const agentsFile = join(spec.appDir, "agents.json");
  // Gate B9: without StructuredOutput in the rl-main tools, no result carries structured_output.
  const agents = {
    [MAIN_AGENT]: { ...spec.main, tools: [...agentTool, ...readTools, "StructuredOutput"] },
    ...Object.fromEntries(
      reviewers.map((n) => [
        n,
        {
          ...spec.agents[n],
          tools: readTools,
          disallowedTools: ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit", "Agent"],
          omitClaudeMd: true,
        },
      ]),
    ),
  };
  writeFileSync(agentsFile, JSON.stringify(agents));

  // Never --bare: it breaks the subscription login. Never --permission-mode: 2.1.295 has no "default" choice.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    mcpFile,
    // code.claude.com/docs/en/cli-reference: --tools "" disables all built-in tools. StructuredOutput comes from --json-schema.
    "--tools",
    [...builtins, ...(reviewers.length ? ["Agent"] : [])].join(","),
    ...(spec.noTools ? [] : ["--allowedTools", [...READ_TOOLS, ...mcp.allow].join(",")]),
    // A deny rule wins over every allow rule. The other tools of a user server stay off.
    ...(denied.length ? ["--disallowedTools", denied.join(",")] : []),
    "--agents",
    agentsFile,
    "--agent",
    MAIN_AGENT,
    "--json-schema",
    JSON.stringify(spec.schema),
    "--max-turns",
    String(spec.maxTurns),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
    "--no-session-persistence",
  ];
  // JSON quoting is close to the Windows argument quoting.
  if (JSON.stringify(args).length > MAX_ARGV)
    throw new Error("The MCP tool lists are too long for the command line. Pick fewer MCP servers.");
  // Init can list a denied tool. The deny rule keeps it off, so the init check accepts it.
  const allowed = new Set([...readTools, ...denied, "StructuredOutput", ...(reviewers.length ? ["Agent", "Task"] : [])]);
  return { args, allowed };
}

// The CLI arguments of a session fork. Resume does not restore the launch flags, so each one is passed again (session-consult.md
// section 1). --fork-session is always present: without it, a running background session attaches, or the CLI exits with code 1.
// No --permission-mode, as for review runs: --restricted ignores the settings files, and 2.1.295 has no "default" choice.
// Gate B16 (d): --no-session-persistence with --fork-session writes no fork transcript (2.1.301). The run end still deletes the
// per-cwd folders of the run (removeCwdFolders), because the flag still writes them (gate B4).
export function resumeArgs(spec: ResumeSpec) {
  if (!isAbsolute(spec.resume) || !spec.resume.endsWith(".jsonl")) throw new Error("The session path must be an absolute .jsonl path.");
  mkdirSync(spec.appDir, { recursive: true });
  const mcpFile = join(spec.appDir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
  const tools = READ_TOOLS.join(",");
  const args = [
    "-p",
    "--resume",
    spec.resume,
    "--fork-session",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    mcpFile,
    "--tools",
    tools,
    "--allowedTools",
    tools,
    "--json-schema",
    JSON.stringify(spec.schema),
    "--max-turns",
    String(spec.maxTurns),
    "--no-session-persistence",
  ];
  return { args, allowed: new Set([...READ_TOOLS, "StructuredOutput"]) };
}

// The CLI arguments of an implement run: the flags of Gate B17 (scripts/gate/claude-checks.ts b17) and the runner output flags. No
// --permission-mode: -p denies a call without an allow rule, and --allowedTools pre-approves the five tools and the chosen MCP tools.
// The MCP flags are those of a review run (prepare). The init check accepts only these tools, the denied MCP tools, and StructuredOutput.
export function implementArgs(spec: ImplementSpec) {
  const tools = IMPLEMENT_TOOLS.join(",");
  if (spec.model != null && !modelName.safeParse(spec.model).success) throw new Error(`Invalid model name: ${spec.model}`);
  if (spec.effort != null && !EFFORTS.includes(spec.effort)) throw new Error(`Invalid effort: ${spec.effort}`);
  const mcp = spec.appDir && spec.mcpServers ? writeMcp(spec.appDir, spec.mcpServers) : null;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--strict-mcp-config",
    ...(mcp ? ["--mcp-config", mcp.file] : []),
    "--tools",
    tools,
    "--allowedTools",
    [...IMPLEMENT_TOOLS, ...(mcp?.allow ?? [])].join(","),
    // A deny rule wins over every allow rule. The other tools of a user server stay off.
    ...(mcp?.denied.length ? ["--disallowedTools", mcp.denied.join(",")] : []),
    "--json-schema",
    JSON.stringify(spec.schema),
    "--max-turns",
    String(spec.maxTurns),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
    "--no-session-persistence",
  ];
  if (JSON.stringify(args).length > MAX_ARGV)
    throw new Error("The MCP tool lists are too long for the command line. Pick fewer MCP servers.");
  return { args, allowed: new Set([...IMPLEMENT_TOOLS, ...(mcp?.tools ?? []), ...(mcp?.denied ?? []), "StructuredOutput"]) };
}

export function createClaudeRunner(opts: RunnerOptions = {}) {
  let active: { cancelled: boolean; pid?: number } | undefined;

  // Finds the CLI, checks its version, and runs `claude auth status`. It starts no model call.
  async function check(): Promise<RunnerCheck> {
    const unavailable = (message: string): RunnerCheck => ({ ok: false, kind: "unavailable", message });
    const found = opts.command ? undefined : Bun.which("claude");
    const command = opts.command ?? (found ? [found] : undefined);
    if (!command?.[0]) return unavailable("Claude Code is not on PATH.");
    // Gate 0: the native claude.exe. A .cmd shim runs through cmd.exe, which parses the arguments again.
    if (process.platform === "win32" && !command[0].toLowerCase().endsWith(".exe"))
      return unavailable(`${basename(command[0])} is not the native claude.exe.`);
    const env = childEnv();
    const v = await exec([...command, "--version"], env);
    const version = v.out.match(/\d+\.\d+\.\d+/)?.[0];
    if (v.code !== 0 || !version) return unavailable("claude --version failed.");
    if (older(version, MIN_CLI_VERSION)) return unavailable(`Claude Code ${version} is older than ${MIN_CLI_VERSION}.`);

    const a = await exec([...command, "auth", "status"], env);
    let auth: Record<string, unknown> = {};
    try {
      const j = JSON.parse(a.out);
      if (j && typeof j === "object") auth = j;
    } catch {}
    // The output holds account data. Log only authMethod.
    log(`claude auth status: authMethod=${String(auth.authMethod)}`);
    if (a.code !== 0 || auth.authMethod !== "claude.ai")
      return { ok: false, kind: "auth", message: `authMethod is ${String(auth.authMethod)}. Review needs the claude.ai login.` };
    const configDir =
      typeof auth.configDirectory === "string" ? auth.configDirectory : (env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"));
    const projectsDir = typeof auth.projectsDirectory === "string" ? auth.projectsDirectory : join(configDir, "projects");
    return { ok: true, command, version, projectsDir };
  }

  // Runs one review. onEvents gets each new or changed run_event. Only one run is active at a time.
  async function run(spec: RunSpec | ResumeSpec | ImplementSpec, onEvents: (events: RunEvent[]) => void = () => {}): Promise<RunOutcome> {
    if (active) throw new Error("A review run is active.");
    const self: { cancelled: boolean; pid?: number } = { cancelled: false };
    active = self;
    const empty = (status: RunOutcome["status"], kind: RunErrorKind | null, text: string | null): RunOutcome => ({
      status,
      kind,
      text,
      result: null,
      init: null,
      events: [],
      exitCode: null,
      stderrTail: "",
    });
    let cwd: string | undefined;
    let projectsDir: string | undefined;
    let proc: { exitCode: number | null; exited: Promise<number> } | undefined;
    try {
      const c = await check();
      if (!c.ok) return empty("failed", c.kind === "auth" ? "auth" : "process", c.message);
      if (self.cancelled) return empty("cancelled", null, null);
      // Gate B9: an 8.3 short cwd makes the CLI refuse Reads inside it.
      cwd = realpathSync.native(spec.cwd);
      projectsDir = c.projectsDir;
      const { args, allowed } = "implement" in spec ? implementArgs(spec) : "resume" in spec ? resumeArgs(spec) : prepare(spec);
      const own = "implement" in spec || "resume" in spec ? spec.timeoutMs : undefined;
      const limit = Math.min(opts.timeoutMs ?? RUN_TIMEOUT_MS, own ?? RUN_TIMEOUT_MS);
      const agents = new Set("main" in spec ? [MAIN_AGENT, ...Object.keys(spec.agents)] : []);
      const parser = createStreamParser({ cwd, allowedTools: allowed, agents });
      const p = Bun.spawn([...c.command, ...args], {
        cwd,
        env: childEnv(),
        stdin: new Blob([spec.prompt]),
        stdout: "pipe",
        stderr: "pipe",
        // POSIX: a new process group, so one kill ends the CLI and its MCP children.
        detached: process.platform !== "win32",
      });
      proc = p;
      self.pid = p.pid;

      let stopped = false;
      let error: unknown;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void killTree(p.pid);
      }, limit);
      const handle = (line: string) => {
        if (stopped || self.cancelled || !line.trim()) return;
        const changed = parser.line(line);
        if (parser.state.badTools.length) {
          stopped = true;
          void killTree(p.pid);
          return;
        }
        if (changed.length) onEvents(changed);
      };
      let buf = "";
      const out = readText(p.stdout, (text) => {
        buf += text;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          handle(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      })
        .then(() => handle(buf))
        .catch((e) => {
          error ??= e;
          stopped = true;
          void killTree(p.pid);
        });
      let stderr = "";
      const err = readText(p.stderr, (text) => {
        stderr = (stderr + text).slice(-STDERR_TAIL);
      }).catch(() => {});

      const exitCode = await p.exited;
      clearTimeout(timer);
      // A leftover child can hold the pipes open. It must not block the run.
      await Promise.race([Promise.all([out, err]), Bun.sleep(DRAIN_TIMEOUT_MS)]);
      stopped = true;
      if (error) throw error;
      const tail = parser.stop();
      if (tail.length) onEvents(tail);
      const verdict = classify(parser.state, { exitCode, cancelled: self.cancelled, timedOut });
      return { ...verdict, init: parser.state.inits[0] ?? null, events: parser.events(), exitCode, stderrTail: stderr };
    } finally {
      if (proc && proc.exitCode === null && self.pid !== undefined) {
        await killTree(self.pid);
        await Promise.race([proc.exited, Bun.sleep(DRAIN_TIMEOUT_MS)]);
      }
      if (cwd && projectsDir) removeCwdFolders(cwd, projectsDir);
      active = undefined;
    }
  }

  // Cancels the active run. The run then ends with status cancelled.
  function cancel(): boolean {
    if (!active) return false;
    active.cancelled = true;
    if (active.pid !== undefined) void killTree(active.pid);
    return true;
  }

  return { check, run, cancel };
}

export type ReviewRunner = ReturnType<typeof createClaudeRunner>;
