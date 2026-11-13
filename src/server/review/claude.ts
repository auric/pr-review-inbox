// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Starts, watches, and stops one Claude Code review process. The flags, env, and cwd rules come from integration-check.md, "Gate v3, local".
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { EFFORTS, type Effort, modelName } from "../../shared/dto";
import type { RunErrorKind, RunEvent, SDKResultMessage, SDKSystemMessage } from "../../shared/run-log";
import { RUN_LIMITS, RUN_TIME_MAX_MS } from "../../shared/task";
import { log } from "../log";
import { type ShellSpec, shellEnv, shellGitConfig, writeShellSettings } from "../tasks/shell";
import { RUNTIME_ENV } from "./git";
import { classify, createStreamParser, REFUSED_MAX, type Refusal, type RunNote } from "./stream";

// Gate B ran on 2.1.295. From 2.1.302, -p refuses each call that needs approval (V7), and the Bash rules of a shell step rely on it.
export const MIN_CLI_VERSION = "2.1.302";
export const MAIN_AGENT = "rl-main";
// docs/plans/review-v2/task-subagents.md decision 1: the read-only subagent of a task step.
export const EXPLORER_AGENT = "rl-explorer";
export const READ_TOOLS = ["Read", "Grep", "Glob"];
// Gate B1: a subagent with these tools denied has no shell and no write tool.
export const SUBAGENT_DENY = ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit", "Agent"];
// Gate B38 (2.1.323): these rules refuse an Agent call that passes model or effort. A subagent keeps its definition model and effort.
export const AGENT_PARAM_DENY = ["Agent(model:*)", "Agent(effort:*)"];
// Names go into comma lists of CLI flags.
export const NAME = /^[A-Za-z0-9_-]+$/;
const STDERR_TAIL = 16_384;
const EXEC_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 5_000;
export const RUN_TIMEOUT_MS = RUN_LIMITS.reviewMinutes.def * 60_000;
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
  // --advisor. Absent or null: no flag, and advisorEnv turns the advisor off.
  advisor?: string | null;
  main: AgentSpec;
  // Review subagents, by name. rl-main can call only these.
  agents: Record<string, AgentSpec>;
  mcpServers: Record<string, McpServerSpec>;
  // No built-in tool and no MCP server: the model can only answer. agents and mcpServers must be empty.
  noTools?: boolean;
  // The subagent rl-explorer with the read tools only (explorerDef). Absent: none.
  explorer?: AgentSpec;
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
// worktree, and context/. timeoutMs: lower than the runner limit. appDir and mcpServers: the MCP servers of the profile and the git
// MCP server, as in RunSpec. appDir must be outside cwd. Absent: no MCP server. shell: the Bash tool with the rules of spec.md section
// 6.21; it needs appDir. Absent: no Bash. explorer: the only subagent, as in RunSpec; it needs appDir. Absent: no Agent tool.
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
  advisor?: string | null;
  timeoutMs?: number;
  shell?: ShellSpec;
  explorer?: AgentSpec;
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
  // The rl-main text and the subagent reports of the stream (stream.ts StreamState.notes). Absent: the run did not start.
  notes?: RunNote[];
  // The Bash commands that Claude Code refused (spec.md section 6.21). Absent: the run did not start.
  refused?: Refusal[];
  // The --advisor value of the run. null: off. Absent: the run did not start.
  advisor?: string | null;
  exitCode: number | null;
  stderrTail: string;
};

export type RunnerOptions = {
  // The CLI argv prefix. Default: `claude` on PATH. Tests pass the fake CLI.
  command?: string[];
  // The time of a run without its own timeoutMs. A function is read at the start of each run. Default: RUN_TIMEOUT_MS.
  timeoutMs?: number | (() => number);
};

// Gate B: ANTHROPIC_* selects API billing. CLAUDECODE, CLAUDE_PID, and CLAUDE_CODE_* mark a nested session. CLAUDE_CODE_GIT_BASH_PATH
// is the user's Git Bash for the Bash tool (V12). GATE_* hold the tokens of the gate scripts.
// The git MCP child gets this env through the CLI. mcp.json sets no env for it.
export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Windows env names ignore case.
    const K = process.platform === "win32" ? k.toUpperCase() : k;
    if (v === undefined || K === "ANTHROPIC_API_KEY" || K === "ANTHROPIC_AUTH_TOKEN" || K === "CLAUDECODE" || K === "CLAUDE_PID") continue;
    if ((K.startsWith("CLAUDE_CODE_") && K !== "CLAUDE_CODE_GIT_BASH_PATH") || K.startsWith("GATE_") || RUNTIME_ENV.test(K)) continue;
    env[k] = v;
  }
  // Gate B3: with this switch, subagents run in the foreground and the run sends one result event.
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  return env;
}

// docs/plans/review-v2/advisor.md. Off: the advisor switch is a second guard; GADV.4 verified that it turns the advisor off. The app never
// relies on --tools, --allowedTools, or --disallowedTools for the advisor (GADV.5a, 5b). On: the advisor needs feature-flag fetching, which
// DISABLE_TELEMETRY turns off. childEnv already drops the CLAUDE_CODE_* switches that turn it off.
export function advisorEnv(env: Record<string, string>, advisor: string | null | undefined): Record<string, string> {
  if (!advisor) return { ...env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" };
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== "DISABLE_TELEMETRY"));
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

// The env name of the run marker. Each CLI or check process gets a new value. The kill finds the leftovers of the process by it.
export const RUN_MARKER = "REVIEW_LOOP_RUN";
// learn.microsoft.com JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: 144 bytes, and BasicLimitInformation.LimitFlags at
// offset 16, after two LARGE_INTEGER fields. SetInformationJobObject refuses 143 and 145 bytes with ERROR_BAD_LENGTH (24).
// JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then one ULONG_PTR process ID each from offset 8.
const EXTENDED_LIMIT_INFO = 9;
const EXTENDED_LIMIT_SIZE = 144;
const KILL_ON_JOB_CLOSE = 0x2000;
const BASIC_PROCESS_ID_LIST = 3;
// PROCESS_TERMINATE | PROCESS_SET_QUOTA: AssignProcessToJobObject needs both.
const ASSIGN_ACCESS = 0x0101;
// WaitForSingleObject needs SYNCHRONIZE. WAIT_OBJECT_0: the process has ended.
const SYNCHRONIZE = 0x00100000;
const WAIT_OBJECT_0 = 0;
const JOB_IDS_MAX = 1024;
const JOB_WAIT_MS = 2000;
const MARK_PASSES = 4;
const MARK_WAIT_MS = 200;

function openKernel32() {
  // require, not import: a failed load must not stop the app. Then the kill uses taskkill /T only.
  const { dlopen, FFIType: T } = require("bun:ffi") as typeof import("bun:ffi");
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [T.ptr, T.ptr], returns: T.ptr },
    SetInformationJobObject: { args: [T.ptr, T.i32, T.ptr, T.u32], returns: T.i32 },
    OpenProcess: { args: [T.u32, T.i32, T.u32], returns: T.ptr },
    AssignProcessToJobObject: { args: [T.ptr, T.ptr], returns: T.i32 },
    QueryInformationJobObject: { args: [T.ptr, T.i32, T.ptr, T.u32, T.ptr], returns: T.i32 },
    TerminateJobObject: { args: [T.ptr, T.u32], returns: T.i32 },
    CloseHandle: { args: [T.ptr], returns: T.i32 },
    WaitForSingleObject: { args: [T.ptr, T.u32], returns: T.u32 },
  }).symbols;
}
type Kernel32 = ReturnType<typeof openKernel32>;
type Handle = NonNullable<ReturnType<Kernel32["CreateJobObjectW"]>>;
let kernel32: Kernel32 | null | undefined;
function k32() {
  if (kernel32 === undefined)
    try {
      kernel32 = openKernel32();
    } catch (e) {
      kernel32 = null;
      log(`bun:ffi did not load kernel32.dll, so Stop uses taskkill /T only: ${(e as Error).message}`);
    }
  return kernel32;
}

// A Job Object with kill-on-close that holds the process, or null.
function newJob(pid: number): Handle | null {
  const k = k32();
  if (!k) return null;
  const job = k.CreateJobObjectW(null, null);
  if (!job) {
    log("CreateJobObjectW failed, so Stop uses taskkill /T only for this run.");
    return null;
  }
  const info = new Uint8Array(EXTENDED_LIMIT_SIZE);
  new DataView(info.buffer).setUint32(16, KILL_ON_JOB_CLOSE, true);
  const proc = k.OpenProcess(ASSIGN_ACCESS, 0, pid);
  const failed = !k.SetInformationJobObject(job, EXTENDED_LIMIT_INFO, info, EXTENDED_LIMIT_SIZE)
    ? "SetInformationJobObject"
    : !proc
      ? "OpenProcess"
      : !k.AssignProcessToJobObject(job, proc)
        ? "AssignProcessToJobObject"
        : null;
  if (proc) k.CloseHandle(proc);
  if (!failed) return job;
  k.CloseHandle(job);
  log(`${failed} failed, so Stop uses taskkill /T only for this run.`);
  return null;
}

function jobIds(k: Kernel32, job: Handle) {
  const list = new BigUint64Array(1 + JOB_IDS_MAX);
  if (!k.QueryInformationJobObject(job, BASIC_PROCESS_ID_LIST, list, list.byteLength, null)) return [];
  return [...list.subarray(1, 1 + Number((list[0] ?? 0n) >> 32n))].map(Number);
}

// The processes whose env holds the marker. /proc/<pid>/environ of another user's process throws, and a zombie has an empty env.
function markedIds(marker: string) {
  const want = `${RUN_MARKER}=${marker}`;
  let ids: string[];
  try {
    ids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  return ids.flatMap((d) => {
    try {
      return readFileSync(`/proc/${d}/environ`, "latin1").split("\0").includes(want) ? [Number(d)] : [];
    } catch {
      return [];
    }
  });
}

// SIGTERM, then SIGKILL to each match that is left after MARK_WAIT_MS. Without a match, nothing waits.
async function killMarked(marker: string) {
  const hit = new Set<number>();
  const send = (signal: NodeJS.Signals) => {
    const ids = markedIds(marker);
    for (const id of ids) {
      hit.add(id);
      try {
        process.kill(id, signal);
      } catch {}
    }
    return ids.length > 0;
  };
  if (send("SIGTERM")) {
    const until = Date.now() + MARK_WAIT_MS;
    while (markedIds(marker).length && Date.now() < until) await Bun.sleep(20);
    for (let pass = 0; pass < MARK_PASSES && send("SIGKILL"); pass++) await Bun.sleep(20);
  }
  return [...hit];
}

// The processes that contain() registered for killTree. job: the Job Object handle on Windows, null after CloseHandle.
const contained = new Map<number, { marker: string; job: Handle | null }>();

// Call right after the spawn. The child env must hold RUN_MARKER=marker. On Windows the child goes into a Job Object. A process that the
// child starts before this call stays outside the job.
export function contain(pid: number, marker: string) {
  contained.set(pid, { marker, job: process.platform === "win32" ? newJob(pid) : null });
}

// What a kill reached, for gate B25 (SU5). job: the processes that the Job Object held when the app ended it, null without a job.
// marked: the processes that the marker scan signalled.
export type KillReport = { job: number[] | null; marked: number[] };

// Ends a process and the processes that it started. Gate 0 g: taskkill /T ends claude.exe and its MCP children. SU5: taskkill /T
// follows parent links, and a command under Git Bash has no live parent after fork and exec. The Linux CLI starts each Bash command in
// its own process group. So a contained process also gets its Job Object ended (Windows) or its marker scan (where /proc exists).
// end: the process has ended or the run is over. Its pid can be reused, so only the job and the marker reach the leftovers. The
// registration ends.
export async function killTree(pid: number, end = false): Promise<KillReport> {
  const c = contained.get(pid);
  if (!end) {
    if (process.platform === "win32")
      await Bun.spawn(["taskkill", "/T", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore", timeout: EXEC_TIMEOUT_MS })
        .exited;
    else
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
  }
  const report: KillReport = { job: null, marked: [] };
  const k = k32();
  // Read c.job after the taskkill: an end call can close the handle meanwhile, and Windows reuses handle values.
  const job = c?.job;
  if (end && c) {
    contained.delete(pid);
    c.job = null;
  }
  if (job && k) {
    report.job = jobIds(k, job);
    // TerminateJobObject only starts the ends, and an ending process can still hold its folder. Its handle signals when it is gone.
    const procs = report.job.flatMap((id) => k.OpenProcess(SYNCHRONIZE, 0, id) ?? []);
    k.TerminateJobObject(job, 1);
    if (end) k.CloseHandle(job);
    const until = Date.now() + JOB_WAIT_MS;
    while (procs.some((h) => k.WaitForSingleObject(h, 0) !== WAIT_OBJECT_0) && Date.now() < until) await Bun.sleep(20);
    for (const h of procs) k.CloseHandle(h);
  }
  if (c && process.platform !== "win32") report.marked = await killMarked(c.marker);
  return report;
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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const realDir = (p: string) => {
  try {
    const s = lstatSync(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};

// CLI 2.1.322 writes subagent output to <root>/<16 hex>/<session id>/tasks/<agent id>.output (Gate B35, B36). root: <tmpdir>/claude.
// Only real folders count: a link is never followed.
export function sessionFolders(sessionIds: string[], root = join(tmpdir(), "claude")): string[] {
  const ids = [...new Set(sessionIds.filter((s) => SESSION_ID.test(s)))];
  if (!ids.length || !realDir(root)) return [];
  return readdirSync(root)
    .filter((h) => realDir(join(root, h)))
    .flatMap((h) => ids.map((id) => join(root, h, id)).filter(realDir));
}

// Deletes the session folders, then each parent folder that is empty. Other sessions can share a parent folder.
export function removeSessionFolders(sessionIds: string[], root = join(tmpdir(), "claude")) {
  for (const dir of sessionFolders(sessionIds, root))
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      try {
        rmdirSync(dirname(dir));
      } catch (e) {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      }
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

function checkAgentFields(list: { model?: string | null; effort?: Effort | null; advisor?: string | null }[]) {
  for (const a of list) {
    if (a.model != null && !modelName.safeParse(a.model).success) throw new Error(`Invalid model name: ${a.model}`);
    if (a.advisor != null && !modelName.safeParse(a.advisor).success) throw new Error(`Invalid model name: ${a.advisor}`);
    if (a.effort != null && !EFFORTS.includes(a.effort)) throw new Error(`Invalid effort: ${a.effort}`);
  }
}

// task-subagents.md decision 1: no MCP tool, also in a run with MCP servers. The same in each shell mode.
const explorerDef = (a: AgentSpec) => ({ ...a, tools: READ_TOOLS, disallowedTools: SUBAGENT_DENY, omitClaudeMd: true });

// Writes the MCP and agents files and returns the CLI arguments, the init tool allowlist, and the agent names of the run.
function prepare(spec: RunSpec) {
  const reviewers = Object.keys(spec.agents);
  const subs = [...reviewers, ...(spec.explorer ? [EXPLORER_AGENT] : [])];
  const servers = Object.keys(spec.mcpServers);
  for (const n of reviewers) if (!NAME.test(n)) throw new Error(`Invalid agent, server, or tool name: ${n}`);
  for (const n of [MAIN_AGENT, EXPLORER_AGENT]) if (reviewers.includes(n)) throw new Error(`${n} cannot be a review agent.`);
  if (spec.noTools && (subs.length || servers.length)) throw new Error("A run without tools cannot have agents or MCP servers.");
  checkAgentFields([spec, spec.main, ...Object.values(spec.agents), ...(spec.explorer ? [spec.explorer] : [])]);

  const mcp = writeMcp(spec.appDir, spec.mcpServers);
  const builtins = spec.noTools ? [] : READ_TOOLS;
  const readTools = [...builtins, ...mcp.tools];
  const denied = mcp.denied;
  const agentTool = subs.length ? [`Agent(${subs.join(", ")})`] : [];
  const deny = [...denied, ...(subs.length ? AGENT_PARAM_DENY : [])];
  const mcpFile = mcp.file;
  const agentsFile = join(spec.appDir, "agents.json");
  // Gate B9: without StructuredOutput in the rl-main tools, no result carries structured_output.
  const agents = {
    [MAIN_AGENT]: { ...spec.main, tools: [...agentTool, ...readTools, "StructuredOutput"] },
    ...Object.fromEntries(
      reviewers.map((n) => [n, { ...spec.agents[n], tools: readTools, disallowedTools: SUBAGENT_DENY, omitClaudeMd: true }]),
    ),
    ...(spec.explorer && { [EXPLORER_AGENT]: explorerDef(spec.explorer) }),
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
    [...builtins, ...(subs.length ? ["Agent"] : [])].join(","),
    ...(spec.noTools ? [] : ["--allowedTools", [...READ_TOOLS, ...mcp.allow].join(",")]),
    // A deny rule wins over every allow rule. The other tools of a user server stay off.
    ...(deny.length ? ["--disallowedTools", deny.join(",")] : []),
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
    ...(spec.advisor ? ["--advisor", spec.advisor] : []),
    "--no-session-persistence",
  ];
  // JSON quoting is close to the Windows argument quoting.
  if (JSON.stringify(args).length > MAX_ARGV)
    throw new Error("The MCP tool lists are too long for the command line. Pick fewer MCP servers.");
  // Init can list a denied tool. The deny rule keeps it off, so the init check accepts it.
  const allowed = new Set([...readTools, ...denied, "StructuredOutput", ...(subs.length ? ["Agent", "Task"] : [])]);
  return { args, allowed, agents: new Set([MAIN_AGENT, ...subs]), models: defModels(agents) };
}

// The definition model of each subagent that has one. rl-main runs on the run model.
const defModels = (defs: Record<string, { model?: string | null }>) =>
  new Map(Object.entries(defs).flatMap(([n, d]) => (n !== MAIN_AGENT && d.model ? [[n, d.model] as const] : [])));

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
  return { args, allowed: new Set([...READ_TOOLS, "StructuredOutput"]), agents: new Set<string>(), models: new Map<string, string>() };
}

// The CLI arguments of an implement run: the flags of Gate B17 (scripts/gate/claude-checks.ts b17) and the runner output flags. No
// --permission-mode: -p denies a call without an allow rule, and --allowedTools pre-approves the five tools and the chosen MCP tools.
// The MCP flags are those of a review run (prepare). The init check accepts only these tools, the denied MCP tools, and StructuredOutput.
// A shell step (spec.md section 6.21) adds Bash to --tools and the Bash rules in shell.json. No dontAsk: shellEnv sets
// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which forces the default mode. In -p, the default mode refuses each command that has no allow
// rule (SU1). Unrestricted uses the same flags: --restricted refuses bypassPermissions, and dontAsk refuses more (Gate B32).
// explorer (task-subagents.md, Design): the run is rl-main with Agent(rl-explorer), as a review run (Gates B2, B9), and the init check
// also accepts Agent and Task (Gate B8). Gate B35 is open.
export function implementArgs(spec: ImplementSpec) {
  const builtins = [...IMPLEMENT_TOOLS, ...(spec.shell ? ["Bash"] : [])];
  checkAgentFields([spec, ...(spec.explorer ? [spec.explorer] : [])]);
  if (spec.shell && !spec.appDir) throw new Error("A shell step needs an app folder outside the step folder.");
  if (spec.explorer && !spec.appDir) throw new Error("A step with rl-explorer needs an app folder outside the step folder.");
  const mcp = spec.appDir && spec.mcpServers ? writeMcp(spec.appDir, spec.mcpServers) : null;
  const settings = spec.shell && spec.appDir ? writeShellSettings(spec.appDir, spec.shell) : null;
  let agentsFile: string | null = null;
  if (spec.explorer && spec.appDir) {
    mkdirSync(spec.appDir, { recursive: true });
    agentsFile = join(spec.appDir, "agents.json");
    // code.claude.com/docs/en/sub-agents: an empty prompt with no memory field keeps the default system prompt (CLI 2.1.281).
    const main = {
      description: "Main thread of a task step.",
      prompt: "",
      tools: [`Agent(${EXPLORER_AGENT})`, ...builtins, ...(mcp?.tools ?? []), "StructuredOutput"],
    };
    writeFileSync(agentsFile, JSON.stringify({ [MAIN_AGENT]: main, [EXPLORER_AGENT]: explorerDef(spec.explorer) }));
  }
  const deny = [...(mcp?.denied ?? []), ...(agentsFile ? AGENT_PARAM_DENY : [])];
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--strict-mcp-config",
    ...(mcp ? ["--mcp-config", mcp.file] : []),
    "--tools",
    [...builtins, ...(agentsFile ? ["Agent"] : [])].join(","),
    "--allowedTools",
    [...IMPLEMENT_TOOLS, ...(mcp?.allow ?? [])].join(","),
    // A deny rule wins over every allow rule. The other tools of a user server stay off.
    ...(deny.length ? ["--disallowedTools", deny.join(",")] : []),
    ...(settings ? ["--settings", settings] : []),
    ...(agentsFile ? ["--agents", agentsFile, "--agent", MAIN_AGENT] : []),
    "--json-schema",
    JSON.stringify(spec.schema),
    "--max-turns",
    String(spec.maxTurns),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.effort ? ["--effort", spec.effort] : []),
    ...(spec.advisor ? ["--advisor", spec.advisor] : []),
    "--no-session-persistence",
  ];
  if (JSON.stringify(args).length > MAX_ARGV)
    throw new Error("The MCP tool lists are too long for the command line. Pick fewer MCP servers.");
  const agentTools = agentsFile ? ["Agent", "Task"] : [];
  return {
    args,
    allowed: new Set([...builtins, ...(mcp?.tools ?? []), ...(mcp?.denied ?? []), "StructuredOutput", ...agentTools]),
    agents: new Set(agentsFile ? [MAIN_AGENT, EXPLORER_AGENT] : []),
    models: defModels(agentsFile && spec.explorer ? { [EXPLORER_AGENT]: spec.explorer } : {}),
  };
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
    let inits: SDKSystemMessage[] = [];
    try {
      const c = await check();
      if (!c.ok) return empty("failed", c.kind === "auth" ? "auth" : "process", c.message);
      if (self.cancelled) return empty("cancelled", null, null);
      // Gate B9: an 8.3 short cwd makes the CLI refuse Reads inside it.
      cwd = realpathSync.native(spec.cwd);
      projectsDir = c.projectsDir;
      const { args, allowed, agents, models } =
        "implement" in spec ? implementArgs(spec) : "resume" in spec ? resumeArgs(spec) : prepare(spec);
      const own = "implement" in spec || "resume" in spec ? spec.timeoutMs : undefined;
      const base = typeof opts.timeoutMs === "function" ? opts.timeoutMs() : opts.timeoutMs;
      const limit = Math.min(own ?? base ?? RUN_TIMEOUT_MS, RUN_TIME_MAX_MS);
      const shell = "implement" in spec ? spec.shell : undefined;
      const advisor = "resume" in spec ? null : spec.advisor;
      // implementArgs wrote this file beside shell.json.
      const shellGit = "implement" in spec && spec.appDir ? shellGitConfig(spec.appDir) : "";
      const parser = createStreamParser({ cwd, allowedTools: allowed, agents, models, shell: shell?.mode });
      inits = parser.state.inits;
      const marker = crypto.randomUUID();
      const p = Bun.spawn([...c.command, ...args], {
        cwd,
        env: { ...advisorEnv(shell ? shellEnv(childEnv(), shell, shellGit) : childEnv(), advisor), [RUN_MARKER]: marker },
        stdin: new Blob([spec.prompt]),
        stdout: "pipe",
        stderr: "pipe",
        // POSIX: a new process group, so one kill ends the CLI and its MCP children.
        detached: process.platform !== "win32",
      });
      proc = p;
      self.pid = p.pid;
      contain(p.pid, marker);

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
        if (parser.state.badTools.length || parser.state.noBash) {
          stopped = true;
          void killTree(p.pid);
          return;
        }
        if (changed.length) onEvents(changed);
        // SU5 checks that the tree kill also ends a running Bash command and its children.
        if (parser.state.refused.length > REFUSED_MAX) {
          stopped = true;
          void killTree(p.pid);
        }
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
      return {
        ...verdict,
        init: parser.state.inits[0] ?? null,
        events: parser.events(),
        notes: parser.state.notes,
        refused: parser.state.refused,
        advisor: advisor ?? null,
        exitCode,
        stderrTail: stderr,
      };
    } finally {
      if (proc && self.pid !== undefined) {
        if (proc.exitCode === null) {
          await killTree(self.pid);
          await Promise.race([proc.exited, Bun.sleep(DRAIN_TIMEOUT_MS)]);
        }
        // A command that Claude started can outlive the CLI, for example `cmd &`.
        await killTree(self.pid, true);
      }
      if (cwd && projectsDir) removeCwdFolders(cwd, projectsDir);
      removeSessionFolders(inits.map((i) => i.session_id));
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
