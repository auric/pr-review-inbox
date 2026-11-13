// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure helpers of Gate B35 (task-subagents.md, Design; integration-check.md U82) and Gate B36 (agent-workflow.md section 6, U83 to
// U96). They build the agents.json definitions, read stream-json events, and judge the facts. They start no process.
import path from "node:path";
import { type AgentSeen, type Fact, resultOf, type Seen, type Status, type ToolCall, toolCalls } from "./session";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const objs = (events: unknown[]) => events.filter(isObj);
const list = (v: string[]) => v.join(",") || "none";
const shown = (s: Seen) => `${s.state}${s.label && s.label !== "none" ? ` (${s.label})` : ""}`;

// ---------- agents.json (agent-workflow.md section 3.6) ----------
// AW1 is built. This is the gate copy of the transform: the tool cap, the forced disallowedTools, maxTurns, and omitClaudeMd. The
// prompt is the test text, without the app rules.
export const READ_TOOLS = ["Read", "Grep", "Glob"];
const WRITE_TOOLS = [...READ_TOOLS, "Edit", "Write"];
const FORCED_DENY = ["Agent", "NotebookEdit", "PowerShell", "WebFetch", "WebSearch"];
// claude.ts SUBAGENT_DENY (Gate B1).
const SUBAGENT_DENY = ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit", "Agent"];
export const KEPT_KEYS = ["description", "prompt", "tools", "disallowedTools", "model", "effort", "maxTurns", "omitClaudeMd"];

export type AgentFile = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string;
  maxTurns?: unknown;
  [k: string]: unknown;
};
export type AgentDef = {
  description: string;
  prompt: string;
  tools: string[];
  disallowedTools: string[];
  model?: string;
  effort?: string;
  maxTurns: number;
  omitClaudeMd: true;
};

export function agentDef(f: AgentFile, o: { shell: boolean; readOnly?: boolean; stepTurns: number }): AgentDef {
  const cap = o.readOnly ? READ_TOOLS : [...WRITE_TOOLS, ...(o.shell ? ["Bash"] : [])];
  const tools = f.tools ? cap.filter((t) => f.tools?.includes(t)) : cap;
  const deny = [...new Set([...(f.disallowedTools ?? []), ...FORCED_DENY, ...SUBAGENT_DENY.filter((t) => !tools.includes(t))])];
  const turns = typeof f.maxTurns === "number" && Number.isInteger(f.maxTurns) && f.maxTurns > 0 ? f.maxTurns : o.stepTurns;
  return {
    description: f.description.slice(0, 1024),
    prompt: f.prompt,
    tools,
    disallowedTools: deny,
    ...(f.model ? { model: f.model } : {}),
    ...(f.effort ? { effort: f.effort } : {}),
    maxTurns: Math.min(turns, o.stepTurns),
    omitClaudeMd: true,
  };
}

// A gate fact that needs a tool outside the cap (U86 WebFetch, U89 Agent) adds it to tools and takes it out of disallowedTools.
export const lift = (d: AgentDef, tool: string): AgentDef => ({
  ...d,
  tools: [...d.tools, tool],
  disallowedTools: d.disallowedTools.filter((t) => t !== tool),
});

// The lead is rl-main with an empty prompt (section 3.3). It never gets Bash.
export const leadDef = (names: string[], edits: boolean) => ({
  description: "Main thread of a task step.",
  prompt: "",
  tools: [`Agent(${names.join(", ")})`, ...READ_TOOLS, ...(edits ? ["Edit", "Write"] : []), "StructuredOutput"],
});

// Replaces the value after flag in argv. The flag must be present.
export function withFlag(args: readonly string[], flag: string, value: string) {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) throw new Error(`argv has no ${flag} value`);
  return args.map((a, j) => (j === i + 1 ? value : a));
}

// name and model of a user agent file (front matter only). YAML quotes are not part of the value.
export function agentFront(text: string, file: string) {
  const fm = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : "";
  const key = (k: string) =>
    fm
      .match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  return { name: key("name") ?? file.replace(/\.md$/, ""), model: key("model") };
}

// Replaces each path form (sanitize-core.ts pathForms) with ~. Case does not matter on Windows.
export function redactPaths(s: string, forms: string[]) {
  let out = s;
  for (const f of forms.filter(Boolean).sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "~");
  return out;
}

// ---------- event readers ----------
// The first main-thread Agent call of one subagent type.
export const agentCall = (events: unknown[], type: string): ToolCall | undefined =>
  toolCalls(events).find((t) => t.parent === null && (t.name === "Agent" || t.name === "Task") && t.input.subagent_type === type);

export type Outcome = { state: "refused" | "ran" | "error" | "no result" | "not tried"; text: string; id?: string; deniedParent?: string };
const textOf = (b: Obj | undefined) =>
  !b
    ? ""
    : typeof b.content === "string"
      ? b.content
      : Array.isArray(b.content)
        ? b.content.map((x) => (isObj(x) && typeof x.text === "string" ? x.text : "")).join("\n")
        : "";

// The first call of tool under parent (null: the main thread) whose input matches. A permission_denied event of the call makes it
// refused. deniedParent: the parent_tool_use_id of that event. CLI 2.1.322 gives a subagent event agent_id instead: then it is the
// tool_use_id of the task_started event whose task_id equals agent_id (Gate B36, integration-check.md U85).
export function callOutcome(events: unknown[], parent: string | null, tool: string, match: (input: Obj) => boolean = () => true): Outcome {
  const t = toolCalls(events).find((c) => c.parent === parent && c.name === tool && match(c.input));
  if (!t) return { state: "not tried", text: "" };
  const res = resultOf(events, t.id);
  const text = textOf(res);
  const all = objs(events);
  const denied = all.find((e) => e.type === "system" && e.subtype === "permission_denied" && e.tool_use_id === t.id);
  if (denied) {
    const task =
      typeof denied.agent_id === "string"
        ? all.find((e) => e.type === "system" && e.subtype === "task_started" && e.task_id === denied.agent_id)
        : undefined;
    const by = typeof denied.parent_tool_use_id === "string" ? denied.parent_tool_use_id : task?.tool_use_id;
    return { state: "refused", text, id: t.id, deniedParent: typeof by === "string" ? by : undefined };
  }
  return { state: !res ? "no result" : res.is_error === true ? "error" : "ran", text, id: t.id };
}
const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
export const bashIs = (cmd: string) => (i: Obj) => norm(String(i.command ?? "")) === norm(cmd);
// The model can wrap the command, for example with a cd or a timeout. The watch must still find it.
export const bashHas = (part: string) => (i: Obj) => String(i.command ?? "").includes(part);
export const pathEnds = (name: string) => (i: Obj) =>
  String(i.file_path ?? "")
    .replaceAll("\\", "/")
    .endsWith(`/${name}`);

// The Agent tool_result of a call: tool_use_result.resolvedModel and totalTokens, and the message.model of each child assistant event.
export function agentStats(events: unknown[], id: string) {
  const user = objs(events).find(
    (e) =>
      e.type === "user" &&
      isObj(e.message) &&
      Array.isArray(e.message.content) &&
      e.message.content.some((b) => isObj(b) && b.type === "tool_result" && b.tool_use_id === id),
  );
  const r = user && isObj(user.tool_use_result) ? user.tool_use_result : {};
  const models = objs(events)
    .filter((e) => e.type === "assistant" && e.parent_tool_use_id === id)
    .map((e) => (isObj(e.message) && typeof e.message.model === "string" ? e.message.model : "none"));
  return {
    resolvedModel: typeof r.resolvedModel === "string" ? r.resolvedModel : null,
    totalTokens: typeof r.totalTokens === "number" ? r.totalTokens : null,
    childModels: [...new Set(models)],
    childEvents: objs(events).filter((e) => e.parent_tool_use_id === id).length,
    text: textOf(resultOf(events, id)),
  };
}
export type AgentStats = ReturnType<typeof agentStats>;

// The model of an agent run: resolvedModel, else the first child model.
export const modelOfAgent = (s: AgentStats) => s.resolvedModel ?? s.childModels[0] ?? "none";

// Two Agent calls overlap when both tool_use blocks come before either tool_result. oneMessage: both blocks are in assistant events of
// one message ID.
export function overlap(events: unknown[], a: string, b: string) {
  const all = objs(events);
  const at = (pred: (bl: Obj, e: Obj) => boolean) =>
    all.findIndex((e) => isObj(e.message) && Array.isArray(e.message.content) && e.message.content.some((bl) => isObj(bl) && pred(bl, e)));
  const use = (id: string) => at((bl) => bl.type === "tool_use" && bl.id === id);
  const res = (id: string) => at((bl) => bl.type === "tool_result" && bl.tool_use_id === id);
  const ua = use(a);
  const ub = use(b);
  if (ua < 0 || ub < 0) return { started: false, overlap: false, oneMessage: false };
  const ends = [res(a), res(b)].map((i) => (i < 0 ? Number.POSITIVE_INFINITY : i));
  const msg = (i: number) => {
    const m = all[i]?.message;
    return isObj(m) && typeof m.id === "string" ? m.id : `#${i}`;
  };
  return { started: true, overlap: Math.max(ua, ub) < Math.min(...ends), oneMessage: msg(ua) === msg(ub) };
}

// Files under the per-cwd folders, and output files of task_notification events that lie outside them.
// The paths come from the host, so the host path module applies. path.win32 compares without case, path.posix with case.
export function outsideFolders(files: string[], folders: string[], p: typeof path = path) {
  const inside = (f: string) =>
    folders.some((d) => {
      const r = p.relative(d, f);
      return r !== "" && !r.startsWith("..") && !p.isAbsolute(r);
    });
  return files.filter((f) => !inside(f));
}

// ---------- B35 judges (integration-check.md U82) ----------
export type Write = Outcome & { file: boolean };
const clip = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").slice(0, 120));
// A real refusal: a permission_denied event, or an error that names a permission or the working directory (the texts of Gate B17 and
// B7). Another error, such as a bad path, proves nothing.
const refusedWrite = (w: Write) =>
  !w.file && (w.state === "refused" || (w.state === "error" && /permission|working director/i.test(w.text)));
const writeLine = (name: string, w: Write) => `${name}=${w.state} file=${w.file} text=${clip(w.text)}`;

// (a) Writes outside the cwd are refused, and the repo/ write runs.
export function u82a(o: { rel: Write; abs: Write; repo: Write }): Fact {
  const pass = refusedWrite(o.rel) && refusedWrite(o.abs) && o.repo.state === "ran" && o.repo.file;
  return {
    id: "U82a",
    status: pass ? "PASS" : "FAIL",
    evidence: `${writeLine("Write ../outside", o.rel)}; ${writeLine("Write absolute outside", o.abs)}; ${writeLine("Write ./repo", o.repo)}`,
  };
}

// (b) The deny rule and the compound check apply. The probe pattern runs.
export function u82b(o: { git: Seen; compound: Seen & { marker: boolean }; probe: Seen & { marker: boolean } }): Fact {
  const pass =
    o.git.state === "refused" &&
    o.git.label === "deny" &&
    o.compound.state === "refused" &&
    o.compound.label === "deny" &&
    !o.compound.marker &&
    o.probe.state === "ran" &&
    o.probe.marker;
  return {
    id: "U82b",
    status: pass ? "PASS" : "FAIL",
    evidence: `git status=${shown(o.git)} (want deny); <probe> && git status=${shown(o.compound)} marker=${o.compound.marker} (want deny); probe=${shown(o.probe)} marker=${o.probe.marker}`,
  };
}

// (c) A command with no allow rule is refused (V7).
export function u82c(o: { unlisted: Seen & { marker: boolean } }): Fact {
  const pass = o.unlisted.state === "refused" && o.unlisted.label === "allowlist" && !o.unlisted.marker;
  return {
    id: "U82c",
    status: pass ? "PASS" : "FAIL",
    evidence: `command with no allow rule=${shown(o.unlisted)} marker=${o.unlisted.marker} (want allowlist)`,
  };
}

// INFO for U82c, U85, U98, and touch-rule: touch in the cwd. With no allow rule, the CLI refuses it through a file-change ask with no
// decision_reason_type. In allowlist mode the app label is allowlist. The allow rule "touch *" satisfies the ask (SU22, CLI 2.1.323).
export const touchLine = (s: Seen, marker: boolean, rule = "no allow rule") => `touch in the cwd with ${rule}=${shown(s)} marker=${marker}`;

// (d) init lists the step tools, Task, and StructuredOutput, and nothing else. permissionMode is default.
export function u82d(o: { tools: string[] | null; step: string[]; mode?: string }): Fact {
  const init = o.tools ?? [];
  const want = [...o.step, "StructuredOutput"];
  const missing = want.filter((t) => !init.includes(t));
  const agent = init.includes("Task") || init.includes("Agent");
  const extra = init.filter((t) => !want.includes(t) && t !== "Task" && t !== "Agent");
  const pass = o.tools !== null && !missing.length && agent && !extra.length && o.mode === "default";
  return {
    id: "U82d",
    status: pass ? "PASS" : "FAIL",
    evidence: `init.tools=${o.tools ? list(init) : "no init"} missing=${list(missing)} Task or Agent=${agent} extra=${list(extra)} permissionMode=${o.mode ?? "none"}`,
  };
}

// (e) INFO: the same small step with and without --agent rl-main. The edit and the platform line of the environment block.
export function u82e(o: { agent: { file: string; platform: string }; plain: { file: string; platform: string }; want: string }): Fact {
  const same = o.agent.file === o.plain.file;
  return {
    id: "U82e",
    status: "INFO",
    evidence: `same edit with and without --agent=${same}; with --agent: e.txt=${JSON.stringify(o.agent.file)} platform=${JSON.stringify(o.agent.platform)}; without: e.txt=${JSON.stringify(o.plain.file)} platform=${JSON.stringify(o.plain.platform)}; process.platform=${o.want}`,
  };
}

// (f) general-purpose and a user agent are refused, and rl-explorer runs on its model.
export function u82f(o: { gp: AgentSeen; user: AgentSeen | null; ex: AgentSeen; exModel: string; want: string }): Fact {
  const onModel = o.exModel.toLowerCase().includes(o.want.toLowerCase());
  const userOk = o.user === null || o.user.state === "refused";
  const pass = o.gp.state === "refused" && userOk && o.ex.state === "ran" && onModel;
  return {
    id: "U82f",
    status: pass ? "PASS" : "FAIL",
    evidence: `general-purpose=${o.gp.state}; user agent=${o.user ? o.user.state : "no user agent file"}; rl-explorer=${o.ex.state} model=${o.exModel} (want ${o.want})`,
  };
}

// (g) rl-explorer has no Edit, Write, or Bash: no such child call gets an ok result, and its file does not exist.
export function u82g(o: { ex: AgentSeen; file: boolean; marker: boolean }): Fact {
  const pass = o.ex.state === "ran" && !o.ex.writes.length && !o.file && !o.marker;
  return {
    id: "U82g",
    status: pass ? "PASS" : "FAIL",
    evidence: `rl-explorer=${o.ex.state} child tools=${list(o.ex.tools)} ok writes=${list(o.ex.writes)} file=${o.file} Bash marker=${o.marker}`,
  };
}

// (h) Stop during an rl-explorer call ends the CLI within limitMs.
export function u82h(o: { started: boolean; cliMs: number | null; limitMs: number }): Fact {
  const pass = o.started && o.cliMs !== null && o.cliMs <= o.limitMs;
  return {
    id: "U82h",
    status: pass ? "PASS" : "FAIL",
    evidence: `kill during rl-explorer=${o.started}; CLI gone in ${o.cliMs ?? `>${o.limitMs}`} ms`,
  };
}

// (i) and U94: subagent files only in the per-cwd folders, none in the cwd, and none left after the delete.
export function cwdFilesFact(
  id: string,
  o: { names: string[]; agentFiles: number; outside: string[]; inCwd: string[]; left: number },
): Fact {
  // Gate B4: a subagent run writes subagents/agent-* files. None means the agent did not run, so the fact has no evidence.
  const pass = o.agentFiles > 0 && !o.outside.length && !o.inCwd.length && o.left === 0;
  return {
    id,
    status: pass ? "PASS" : "FAIL",
    evidence: `${o.agentFiles ? "" : "no subagent file: run again; "}per-cwd files=${o.names.length} (subagent files=${o.agentFiles}): ${o.names.slice(0, 8).join(", ") || "none"}; output files outside the per-cwd folders=${list(o.outside)}; Claude files in the cwd=${list(o.inCwd)}; per-cwd folders left after the delete=${o.left}`,
  };
}

// ---------- B36 judges (agent-workflow.md section 6) ----------
const tried = (s: Outcome) => s.state !== "not tried";
// The CLI text for a tool outside the session: "No such tool available: Edit. Edit is disabled for this session" (integration-check.md U86). A
// network error means that the tool ran.
const notAvailable = (s: Outcome) =>
  s.state === "refused" ||
  (s.state === "error" && /No such tool|not available/i.test(s.text) && !/ENOTFOUND|getaddrinfo|fetch failed/i.test(s.text));

// U83: the agent's writes outside the part folder are refused, and its repo/ write runs.
export function u83(o: { called: boolean; rel: Write; abs: Write; repo: Write }): Fact {
  const pass = o.called && refusedWrite(o.rel) && refusedWrite(o.abs) && o.repo.state === "ran" && o.repo.file;
  return {
    id: "U83",
    status: pass ? "PASS" : "FAIL",
    evidence: `agent called=${o.called}; agent ${writeLine("Write ../outside", o.rel)}; ${writeLine("absolute outside", o.abs)}; ${writeLine("./repo", o.repo)}${[o.rel, o.abs, o.repo].some((w) => !tried(w)) ? "; a call was not tried: run B36 again" : ""}`,
  };
}

// U84: the agent's tools hold Edit, --allowedTools has none. The Edit is refused and the file keeps its text.
export function u84(o: { edit: Outcome; changed: boolean }): Fact {
  const pass = o.edit.state === "refused" && !o.changed;
  return {
    id: "U84",
    status: pass ? "PASS" : "FAIL",
    evidence: `agent Edit without an allow rule=${o.edit.state} file changed=${o.changed} text=${JSON.stringify(o.edit.text.slice(0, 160))}${tried(o.edit) ? "" : "; not tried: run B36 again"}`,
  };
}

// U85 for one shell mode. Each listed command is refused with its label, and its permission_denied event names the agent call.
export type Cmd = Outcome & { label: string; want: string; marker: boolean };
export function u85(
  mode: string,
  o: { called: boolean; cmds: Record<string, Cmd>; control: Outcome & { marker: boolean }; agent: string },
): Fact {
  const bad = Object.entries(o.cmds).filter(
    ([, c]) => !(c.state === "refused" && c.label === c.want && !c.marker && c.deniedParent === o.agent),
  );
  const pass = o.called && !bad.length && o.control.state === "ran" && o.control.marker;
  const each = Object.entries(o.cmds)
    .map(
      ([k, c]) =>
        `${k}=${c.state}${c.label !== "none" ? ` (${c.label})` : ""} marker=${c.marker} (want ${c.want}) event parent=${c.deniedParent === o.agent ? "agent call" : (c.deniedParent ?? "none")}`,
    )
    .join("; ");
  return {
    id: `U85.${mode}`,
    status: pass ? "PASS" : "FAIL",
    evidence: `agent called=${o.called}; ${each}; probe control=${o.control.state} marker=${o.control.marker}`,
  };
}

// U86: init lists only the --tools union, and the CLI refuses the agent's WebFetch as a missing tool. A network error means that the
// tool ran. A call that was not tried proves nothing.
export function u86(o: { tools: string[] | null; union: string[]; fetch: Outcome }): Fact {
  const init = o.tools ?? [];
  const extra = init.filter((t) => !o.union.includes(t) && t !== "Task" && t !== "StructuredOutput");
  const f = o.fetch;
  const missing = notAvailable(f);
  const pass = o.tools !== null && !extra.length && !init.includes("WebFetch") && missing;
  return {
    id: "U86",
    status: pass ? "PASS" : "FAIL",
    evidence: `init.tools=${o.tools ? list(init) : "no init"} outside the --tools union=${list(extra)}; agent WebFetch=${f.state} not available=${missing} text=${clip(f.text)}${tried(f) ? "" : "; not tried: run B36 again"}`,
  };
}

// U89: an agent with Agent disallowed starts no agent. The agent makes its Agent call, the call is refused or fails, no event runs
// under it, and the agent then runs its end probe. depth: the run with CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1. noDepth: the run
// without the variable. It proves that disallowedTools alone holds. depthSet: the variable is in the env of that run.
export type U89Run = { call: Outcome; grandchild: number; end: boolean; depthSet: boolean };
export function u89(o: { depth: U89Run | null; noDepth: U89Run | null }, info: string): Fact {
  // An error for another cause, such as a refused agent type, does not prove disallowedTools.
  const ok = (r: U89Run | null) => !!r && notAvailable(r.call) && r.grandchild === 0 && r.end;
  const line = (label: string, r: U89Run | null) =>
    r
      ? `${label} (depth variable set=${r.depthSet}): Agent call=${r.call.state} events under it=${r.grandchild} end probe=${r.end} text=${clip(r.call.text)}${tried(r.call) ? "" : " (not tried: run B36 again)"}`
      : `${label}: run lost`;
  const pass = ok(o.depth) && ok(o.noDepth) && o.depth?.depthSet === true && o.noDepth?.depthSet === false;
  return {
    id: "U89",
    status: pass ? "PASS" : "FAIL",
    evidence: `agent with Agent disallowed: ${line("with depth 1", o.depth)}; ${line("without the depth variable", o.noDepth)}; INFO: ${info}`,
  };
}

// U91: nested Write and Bash events carry parent_tool_use_id and file_path; totalTokens is set; modelUsage names each agent model;
// total_cost_usd is a number.
export function u91(o: {
  write: { parent: boolean; filePath: boolean };
  bash: { parent: boolean };
  totalTokens: number | null;
  childModels: string[];
  usageModels: string[];
  cost: number | null;
}): Fact {
  const missing = o.childModels.filter((m) => !o.usageModels.some((k) => k.toLowerCase().includes(m.toLowerCase())));
  const pass =
    o.write.parent &&
    o.write.filePath &&
    o.bash.parent &&
    o.totalTokens !== null &&
    o.childModels.length > 0 &&
    !missing.length &&
    o.cost !== null;
  return {
    id: "U91",
    status: pass ? "PASS" : "FAIL",
    evidence: `nested Write parent=${o.write.parent} file_path=${o.write.filePath}; nested Bash parent=${o.bash.parent}; totalTokens=${o.totalTokens ?? "none"}; agent models=${list(o.childModels)} missing in modelUsage=${list(missing)} (modelUsage=${list(o.usageModels)}); total_cost_usd=${o.cost ?? "none"}`,
  };
}

// U93: Stop during an agent Bash `sleep 600`. The CLI and the sleep end within the limit. Windows: the Job Object lists the sleep.
export function u93(o: {
  started: boolean;
  sleeps: number[];
  cliMs: number | null;
  sleepMs: number | null;
  job: number[] | null;
  win: boolean;
  left: string[];
}): Fact {
  const inJob = o.sleeps.length > 0 && o.sleeps.every((p) => o.job?.includes(p));
  const pass = o.started && o.sleeps.length > 0 && o.cliMs !== null && o.sleepMs !== null && (!o.win || inJob);
  return {
    id: "U93",
    status: pass ? "PASS" : "FAIL",
    evidence: `kill in the agent sleep=${o.started}; sleep found=${o.sleeps.length}; CLI gone in ${o.cliMs ?? "> limit"} ms; sleep gone in ${o.sleepMs ?? "> limit"} ms; Job Object lists the sleep=${o.win ? inJob : "not Windows"}; leftovers killed by PID=${list(o.left)}`,
  };
}

// U96: the lead has no Edit or Write. No main-thread edit runs, and the agent edit runs.
export function u96(o: { leadEdit: Outcome; leadWrite: Outcome; leadFile: boolean; agentFile: boolean }): Fact {
  const pass = o.leadEdit.state !== "ran" && o.leadWrite.state !== "ran" && !o.leadFile && o.agentFile;
  return {
    id: "U96",
    status: pass ? "PASS" : "FAIL",
    evidence: `lead Edit=${o.leadEdit.state} lead Write=${o.leadWrite.state} lead file=${o.leadFile}; agent file=${o.agentFile}`,
  };
}

export const info = (id: string, evidence: string, status: Status = "INFO"): Fact => ({ id, status, evidence });

// ---------- B38 judges: deny rules on Agent input parameters (integration-check.md "Agent parameter deny rules") ----------
// code.claude.com/docs/en/permissions, "Match by input parameter": a `Tool(param:value)` deny rule matches a top-level input field,
// `*` matches any value, and a field that the call omits never matches.
export const B38_DENY = ["Agent(model:*)", "Agent(effort:*)"];

// Adds deny rules to the --disallowedTools value of argv, or appends the flag when argv has none.
export function withDeny(args: readonly string[], rules: string[]) {
  const i = args.indexOf("--disallowedTools");
  if (i < 0) return [...args, "--disallowedTools", rules.join(",")];
  if (i + 1 >= args.length) throw new Error("argv has no --disallowedTools value");
  return args.map((a, j) => (j === i + 1 ? [a, ...rules].join(",") : a));
}

// Takes deny rules out of the --disallowedTools value of argv, and drops the flag when no rule is left.
export function withoutDeny(args: readonly string[], rules: string[]) {
  const i = args.indexOf("--disallowedTools");
  if (i < 0) return [...args];
  const left = (args[i + 1] ?? "").split(",").filter((r) => r && !rules.includes(r));
  return left.length ? args.map((a, j) => (j === i + 1 ? left.join(",") : a)) : args.filter((_, j) => j !== i && j !== i + 1);
}

// The main-thread Agent calls of one type whose prompt holds mark, in stream order. A retry of a step repeats its mark.
export const markedCalls = (events: unknown[], type: string, mark: string): ToolCall[] =>
  toolCalls(events).filter(
    (t) =>
      t.parent === null &&
      (t.name === "Agent" || t.name === "Task") &&
      t.input.subagent_type === type &&
      String(t.input.prompt ?? "").includes(mark),
  );

export type PinSeen = {
  id: string;
  model: string | null;
  effort: string | null;
  state: Outcome["state"];
  text: string;
  denied: Obj | null;
  under: number;
  resolved: string | null;
  childModels: string[];
  agentId: string | null;
};
const strOf = (v: unknown) => (v === undefined || v === null ? null : String(v));
const holdsResult = (e: Obj, id: string) =>
  e.type === "user" &&
  isObj(e.message) &&
  Array.isArray(e.message.content) &&
  e.message.content.some((b) => isObj(b) && b.type === "tool_result" && b.tool_use_id === id);

// One Agent call: its outcome, its permission_denied event, the events under it (task_started included), and its models.
export function pinSeen(events: unknown[], c: ToolCall): PinSeen {
  const all = objs(events);
  const o = callOutcome(events, null, c.name, (i) => i === c.input);
  const s = agentStats(events, c.id);
  const started = all.filter((e) => e.subtype === "task_started" && e.tool_use_id === c.id);
  const user = all.find((e) => holdsResult(e, c.id));
  const fromResult = user && isObj(user.tool_use_result) ? strOf(user.tool_use_result.agentId) : null;
  return {
    id: c.id,
    model: strOf(c.input.model),
    effort: strOf(c.input.effort),
    state: o.state,
    text: o.text,
    denied: all.find((e) => e.type === "system" && e.subtype === "permission_denied" && e.tool_use_id === c.id) ?? null,
    under: s.childEvents + started.length,
    resolved: s.resolvedModel,
    childModels: s.childModels,
    agentId: fromResult ?? strOf(started[0]?.task_id),
  };
}
const pinModel = (p: PinSeen) => p.resolved ?? p.childModels[0] ?? "none";
const ranOn = (p: PinSeen) => p.state === "ran" && p.under > 0;
const pinLine = (p: PinSeen) =>
  `state=${p.state} asked model=${p.model ?? "none"} asked effort=${p.effort ?? "none"} events under it=${p.under} model=${pinModel(p)}`;
// INFO: one call, or "not called".
export const pinFact = (id: string, label: string, p: PinSeen | undefined): Fact =>
  info(id, `${label}: ${p ? `${pinLine(p)} result text=${clip(p.text)}` : "not called"}`);

// Start: the run exits 0, stderr has no "Invalid" line (the CLI text of Gate B13 for a bad --agents file), and init still lists the
// Agent tool.
export function b38Start(id: string, o: { exit: number | null; stderr: string; tools: string[] | null; agents: string[] | null }): Fact {
  const tools = o.tools ?? [];
  const agent = tools.includes("Agent") || tools.includes("Task");
  const lines = o.stderr.split(/\r?\n/).filter((l) => l.trim());
  const invalid = lines.some((l) => /invalid/i.test(l));
  const pass = o.exit === 0 && o.tools !== null && agent && !invalid;
  return {
    id,
    status: pass ? "PASS" : "FAIL",
    evidence: `exit=${o.exit} init=${o.tools !== null} init.tools has Agent or Task=${agent} init.agents=${list(o.agents ?? [])} "Invalid" in stderr=${invalid} stderr first line=${lines[0] ? clip(lines.find((l) => /invalid/i.test(l)) ?? lines[0]) : "none"}`,
  };
}

// Control: the first marked call without model and effort runs on the pinned model.
export function b38Control(id: string, calls: PinSeen[], want: string): Fact {
  const c = calls.find((p) => p.model === null && p.effort === null);
  const pass = !!c && ranOn(c) && pinModel(c).toLowerCase().includes(want.toLowerCase());
  return {
    id,
    status: pass ? "PASS" : "FAIL",
    evidence: c
      ? `pinned agent without a per-call model: ${pinLine(c)} (want ${want})`
      : `no call without model and effort among ${calls.length} marked calls: run again`,
  };
}
export const controlRan = (calls: PinSeen[]) => calls.some((p) => p.model === null && p.effort === null && ranOn(p));

// A per-call parameter is refused: a permission_denied event, or an error result that names a permission. Nothing runs under the
// call, and no model answers it. control: the control call of the same run ran, so the deny rules do not block the agent name.
export function b38Refused(id: string, param: "model" | "effort", calls: PinSeen[], control: boolean): Fact {
  const c = calls.find((p) => p[param] !== null);
  if (!c) return { id, status: "FAIL", evidence: `not tried: the lead left out ${param} in all ${calls.length} marked calls: run again` };
  const refused = c.state === "refused" || (c.state === "error" && /permission|denied|deny/i.test(c.text));
  const pass = refused && c.under === 0 && c.resolved === null && c.childModels.length === 0 && control;
  const d = c.denied;
  const shape = d
    ? `tool_name=${strOf(d.tool_name) ?? "none"} decision_reason_type=${strOf(d.decision_reason_type) ?? "none"} decision_reason=${clip(strOf(d.decision_reason) ?? "")} message=${clip(strOf(d.message) ?? "")}`
    : "no permission_denied event";
  return {
    id,
    status: pass ? "PASS" : "FAIL",
    evidence: `per-call ${param}=${c[param]}: ${pinLine(c)} result text=${clip(c.text)}; control ran=${control}; INFO event: ${shape}`,
  };
}

// INFO: the calls of the same step after the first call with param. A retry without param shows on which model it ran.
export function b38Retry(id: string, param: "model" | "effort", calls: PinSeen[]): Fact {
  const i = calls.findIndex((p) => p[param] !== null);
  const later = i < 0 ? [] : calls.slice(i + 1);
  const each = later.map((p, k) => `retry ${k + 1} ${p[param] === null ? `without ${param}` : `with ${param}=${p[param]}`}: ${pinLine(p)}`);
  return {
    id,
    status: "INFO",
    evidence: i < 0 ? `no call with ${param}` : later.length ? each.join("; ") : `no retry after the call with ${param}`,
  };
}

// The allow list holds: Agent(<name>) in the lead tools, and the deny rules do not block that name. The per-call model is refused, so
// the CLI reads Agent(model:*) as a parameter rule and not as an agent named "model:*".
export function b38Allow(o: {
  name: string;
  runs: { label: string; agents: string[] | null; control: boolean }[];
  modelRefused: boolean;
}): Fact {
  const listed = (r: { agents: string[] | null }) => (r.agents ?? []).includes(o.name);
  const pass = o.runs.length > 0 && o.runs.every((r) => r.control && listed(r)) && o.modelRefused;
  return {
    id: "allow",
    status: pass ? "PASS" : "FAIL",
    evidence: `${o.runs.map((r) => `${r.label}: init.agents lists ${o.name}=${listed(r)} control ran=${r.control}`).join("; ") || "no run"}; per-call model refused=${o.modelRefused}`,
  };
}

// Every scalar field whose key names effort, as path=value.
export function effortFields(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => effortFields(x, `${path}[${i}]`));
  if (!isObj(v)) return [];
  return Object.entries(v).flatMap(([k, x]) => {
    const p = path ? `${path}.${k}` : k;
    return /effort/i.test(k) && (x === null || typeof x !== "object") ? [`${p}=${String(x)}`] : effortFields(x, p);
  });
}

// The effort fields of the stream sources of one call: its tool_use_result, its task_* events, and the events under it.
export function streamEffort(events: unknown[], id: string) {
  return objs(events).flatMap((e) => {
    if (e.parent_tool_use_id === id || (String(e.subtype ?? "").startsWith("task_") && e.tool_use_id === id)) return effortFields(e);
    return holdsResult(e, id) ? effortFields({ tool_use_result: e.tool_use_result }) : [];
  });
}

// INFO: the effort level of each pinned call. meta: the keys and effort fields of subagents/agent-<id>.meta.json, null when the gate
// found no file. stream: streamEffort.
export type EffortSeen = { label: string; seen: PinSeen | null; meta: { keys: string[]; effort: string[] } | null; stream: string[] };
export function b38Effort(rows: EffortSeen[]): Fact {
  const found = rows.some((r) => (r.meta?.effort.length ?? 0) + r.stream.length > 0);
  const each = rows.map((r) =>
    r.seen
      ? `${r.label}: ${pinLine(r.seen)} meta.json=${r.meta ? `keys ${list(r.meta.keys)} effort ${list(r.meta.effort)}` : "not found"} stream effort=${list(r.stream)}`
      : `${r.label}: not called`,
  );
  const why = found
    ? ""
    : "not observable: no field named effort in the agent meta.json, the Agent tool_use_result, the task events, or the events under each call; ";
  return { id: "effort-level", status: "INFO", evidence: `${why}${each.join("; ")}` };
}
