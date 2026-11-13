// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Turns Claude Code stream-json lines into run_event upserts and a final verdict. Pure: no I/O.
import { isAbsolute, relative, sep } from "node:path";
import type {
  ContentBlock,
  RunErrorKind,
  RunEvent,
  RunEventStatus,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKPermissionDeniedMessage,
  SDKRateLimitEvent,
  SDKResultMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKUserMessage,
} from "../../shared/run-log";
import { CD_REFUSED_NOTE, REFUSED_NOTE } from "../../shared/run-log";
import type { ShellMode } from "../../shared/task";

const NOTE_MAX = 300;
// spec.md section 6.21 (D7): the Log tab shows each Bash command and the end of its output.
const COMMAND_MAX = 4000;
const OUTPUT_BYTES = 4096;
// Over this number of refused Bash commands, the runner ends the run.
export const REFUSED_MAX = 5;
export const TIME_LIMIT_TEXT = "The run passed its time limit.";
// V12: on Windows, Claude Code offers Bash only when Git Bash is installed.
export const NO_BASH_TEXT =
  process.platform === "win32"
    ? "Install Git for Windows. Claude Code needs Git Bash to run commands."
    : "Claude Code did not offer the Bash tool, so the step cannot run commands.";
// init.tools names the agent tool "Task". tool_use blocks name it "Agent" (Gate B8).
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const AUTH_ERRORS = new Set<SDKAssistantMessageError>(["authentication_failed", "oauth_org_not_allowed"]);
const TASK_END: Record<SDKTaskNotificationMessage["status"], RunEventStatus> = { completed: "ok", failed: "error", stopped: "stopped" };
// RunEvent.tool of an advisor call. Gate G-ADV (gadv-advisor.jsonl): a server_tool_use block named advisor, then an
// advisor_tool_result block in a later assistant event. platform.claude.com advisor-tool docs: the result content is advisor_result,
// advisor_redacted_result, or advisor_tool_result_error with an error_code. A server tool is not a CLI tool, so the init check and
// the refusal count never see it.
export const ADVISOR_TOOL = "Advisor";
function advisorOutcome(content: unknown): { status: RunEventStatus; target: string } {
  const c = content && typeof content === "object" ? (content as Record<string, unknown>) : {};
  if (c.type === "advisor_tool_result_error")
    return { status: "error", target: `unavailable (${typeof c.error_code === "string" ? c.error_code : "unknown"})` };
  // Messages API: stop_reason "refusal" means that the model declined the request.
  return { status: "ok", target: c.stop_reason === "refusal" ? "declined" : "reviewed" };
}
// Gate B5 (integration-check.md, fixtures/claude-synthetic/auth-failed.jsonl): the CLI writes its own error messages with this model name.
const SYNTHETIC = "<synthetic>";
const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const modelOf = (v: unknown) => (typeof v === "string" && v && v !== SYNTHETIC ? v : null);

// The character cap of StreamState.notes. Over the cap, the oldest notes go first.
export const NOTES_MAX = 200_000;

// One note of a run: a text block of rl-main, or the report of a finished Agent call. from: "rl-main", or the Agent call.
export type RunNote = { from: string; text: string };

// A Bash command that Claude Code refused. command: the event target. by: what refused it (REFUSED_NOTE).
export type Refusal = { command: string; by: keyof typeof REFUSED_NOTE };
export { REFUSED_NOTE };

export type StreamState = {
  inits: SDKSystemMessage[];
  results: SDKResultMessage[];
  apiErrors: SDKAssistantMessageError[];
  rateLimitRejected: boolean;
  // Tools in an init event that are not in the allowlist.
  badTools: string[];
  // A shell step whose init event lists no Bash tool.
  noBash: boolean;
  refused: Refusal[];
  // The notes of the run in stream order, at most NOTES_MAX characters. A salvage run reads them (spec.md section 1.6).
  notes: RunNote[];
};

const slash = (p: string) => p.replaceAll("\\", "/");

function relPath(cwd: string, p: string) {
  if (!isAbsolute(p)) return slash(p);
  const r = relative(cwd, p);
  if (r === "") return ".";
  return r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r) ? slash(p) : slash(r);
}

function targetOf(tool: string, input: Record<string, unknown>, cwd: string) {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  if (tool === "Agent") return str("description") ?? "";
  if (tool === "Bash") return (str("command") ?? "").slice(0, COMMAND_MAX);
  const file = str("file_path") ?? str("path");
  const pattern = str("pattern");
  if (pattern !== undefined) return file === undefined ? pattern : `${pattern} in ${relPath(cwd, file)}`;
  if (file !== undefined) return relPath(cwd, file);
  const json = JSON.stringify(input);
  return json === "{}" ? "" : json.slice(0, NOTE_MAX);
}

function note(text: string) {
  const t = text
    .replace(/<\/?tool_use_error>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, NOTE_MAX) : null;
}

// The last OUTPUT_BYTES bytes of a Bash result, with its line breaks. A cut inside a character leaves replacement characters; they go.
function outputTail(text: string) {
  const t = text.replace(/<\/?tool_use_error>/g, "");
  const bytes = new TextEncoder().encode(t);
  const tail = bytes.length > OUTPUT_BYTES ? new TextDecoder().decode(bytes.subarray(-OUTPUT_BYTES)).replace(/^\uFFFD+/, "") : t;
  return tail.trim() ? tail : null;
}

function resultText(b: ContentBlock, sep = " ") {
  const c = b.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((x) => x?.text ?? "").join(sep) : "";
}

const blocks = (c: unknown): ContentBlock[] => (Array.isArray(c) ? c.filter((b) => b && typeof b === "object") : []);

// Gate B38 (2.1.323): the message of a permission_denied event for a deny rule on an Agent parameter.
const PARAM_DENIED = /^Permission to use Agent with (model|effort):\* has been denied\.$/;
const askedOf = (input: Record<string, unknown>) => ({
  model: typeof input.model === "string" ? input.model : null,
  effort: typeof input.effort === "string" ? input.effort : null,
});
// A model alias such as "sonnet" is part of the resolved model ID, as in Gate B38.
const sameModel = (resolved: string, alias: string) => resolved.toLowerCase().includes(alias.toLowerCase());

// agents: the subagent names that the run defined. An Agent call of any other name is marked builtin. models: the definition model of
// each subagent that has one. shell: the mode of a run that must get Bash.
export function createStreamParser(opts: {
  cwd: string;
  allowedTools: Set<string>;
  agents?: ReadonlySet<string>;
  models?: ReadonlyMap<string, string>;
  shell?: ShellMode;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const events = new Map<string, RunEvent>();
  // The model and effort that the lead put on each Agent call, by tool_use id.
  const asked = new Map<string, { model: string | null; effort: string | null }>();
  // Notes of Agent calls that the end of the call must keep.
  const kept = new Map<string, string>();
  // A background Agent call gets its tool_result at launch. Only its task_notification ends it.
  const background = new Set<string>();
  const state: StreamState = {
    inits: [],
    results: [],
    apiErrors: [],
    rateLimitRejected: false,
    badTools: [],
    noBash: false,
    refused: [],
    notes: [],
  };
  let seq = 0;
  let noteChars = 0;

  function addNote(from: string, raw: string) {
    const text = raw.trim();
    if (!text) return;
    state.notes.push({ from, text: text.slice(-NOTES_MAX) });
    noteChars += Math.min(text.length, NOTES_MAX);
    while (noteChars > NOTES_MAX) noteChars -= (state.notes.shift() as RunNote).text.length;
  }

  function end(changed: Map<string, RunEvent>, id: string, status: RunEventStatus, text: string | null) {
    const e = events.get(id);
    if (e?.status !== "running") return;
    const next = { ...e, status, note: kept.get(id) ?? text, endedAt: now() };
    events.set(id, next);
    changed.set(id, next);
  }

  // Sets a note of an Agent call that stays after the call ends.
  function keepNote(changed: Map<string, RunEvent>, e: RunEvent, text: string) {
    kept.set(e.id, text);
    const next = { ...e, note: text };
    events.set(e.id, next);
    changed.set(e.id, next);
  }

  // Sets the model or the token total of an Agent call. A null value keeps the old one.
  function agentStats(changed: Map<string, RunEvent>, id: string | null | undefined, model: string | null, tokens: number | null) {
    const e = id ? events.get(id) : undefined;
    if (e?.tool !== "Agent") return;
    const next = { ...e, model: model ?? e.model, tokens: tokens ?? e.tokens };
    if (next.model === e.model && next.tokens === e.tokens) return;
    events.set(e.id, next);
    changed.set(e.id, next);
    // A deny rule refuses a per-call model (Gate B38). This note shows a CLI that runs the call on it anyway.
    const want = asked.get(e.id)?.model;
    const def = e.agent ? opts.models?.get(e.agent) : undefined;
    if (model && want && def && !kept.has(e.id) && sameModel(model, want) && !sameModel(model, def))
      keepNote(changed, next, `The lead changed the model of ${e.agent} to ${want}. The app rule did not stop it.`);
  }

  // Returns the events that this line created or changed.
  function line(text: string): RunEvent[] {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text);
    } catch {
      return [];
    }
    if (!m || typeof m !== "object") return [];
    const changed = new Map<string, RunEvent>();

    if (m.type === "assistant") {
      const a = m as SDKAssistantMessage;
      if (a.error) state.apiErrors.push(a.error);
      // The first message of a subagent names its model before the Agent call ends.
      if (a.parent_tool_use_id && events.get(a.parent_tool_use_id)?.model === null)
        agentStats(changed, a.parent_tool_use_id, modelOf(a.message?.model), null);
      for (const b of blocks(a.message?.content)) {
        if (b.type === "text" && !a.parent_tool_use_id && typeof b.text === "string") addNote("rl-main", b.text);
        if (b.type === "advisor_tool_result" && b.tool_use_id) {
          const e = events.get(b.tool_use_id);
          if (e?.tool === ADVISOR_TOOL && e.status === "running") {
            const next = { ...e, ...advisorOutcome((b as { content?: unknown }).content), endedAt: now() };
            events.set(e.id, next);
            changed.set(e.id, next);
          }
        }
        if (b.type === "server_tool_use" && b.name === "advisor" && b.id && !events.has(b.id)) {
          const e: RunEvent = {
            id: b.id,
            seq: seq++,
            parent: a.parent_tool_use_id ?? null,
            tool: ADVISOR_TOOL,
            target: "",
            status: "running",
            note: null,
            agent: null,
            model: null,
            tokens: null,
            builtin: false,
            startedAt: now(),
            endedAt: null,
          };
          events.set(e.id, e);
          changed.set(e.id, e);
        }
        if (b.type !== "tool_use" || !b.id || !b.name || b.name === "StructuredOutput" || events.has(b.id)) continue;
        const tool = AGENT_TOOLS.has(b.name) ? "Agent" : b.name;
        const input = b.input && typeof b.input === "object" ? b.input : {};
        const agent = tool === "Agent" && typeof input.subagent_type === "string" ? input.subagent_type : null;
        const e: RunEvent = {
          id: b.id,
          seq: seq++,
          parent: a.parent_tool_use_id ?? null,
          tool,
          target: targetOf(tool, input, opts.cwd),
          status: "running",
          note: null,
          agent,
          model: null,
          tokens: null,
          builtin: agent !== null && !opts.agents?.has(agent),
          startedAt: now(),
          endedAt: null,
        };
        events.set(e.id, e);
        changed.set(e.id, e);
        if (tool === "Agent") asked.set(e.id, askedOf(input));
      }
    } else if (m.type === "user") {
      const u = m as SDKUserMessage;
      const r = u.tool_use_result && typeof u.tool_use_result === "object" ? u.tool_use_result : null;
      for (const b of blocks(u.message?.content)) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        if (r) agentStats(changed, b.tool_use_id, modelOf(r.resolvedModel), count(r.totalTokens));
        const call = events.get(b.tool_use_id);
        if (call?.tool === "Agent" && call.status === "running" && !b.is_error && !background.has(b.tool_use_id))
          addNote(`${call.agent ?? "Agent"} report: ${call.target}`, resultText(b, "\n"));
        const bash = call?.tool === "Bash";
        if (b.is_error) end(changed, b.tool_use_id, "error", bash ? outputTail(resultText(b, "\n")) : note(resultText(b)));
        else if (!background.has(b.tool_use_id)) end(changed, b.tool_use_id, "ok", bash ? outputTail(resultText(b, "\n")) : null);
      }
    } else if (m.type === "system" && m.subtype === "init") {
      const init = m as SDKSystemMessage;
      state.inits.push(init);
      const tools = Array.isArray(init.tools) ? init.tools : [];
      for (const t of tools) if (!opts.allowedTools.has(t) && !state.badTools.includes(t)) state.badTools.push(t);
      if (opts.shell && !tools.includes("Bash")) state.noBash = true;
    } else if (m.type === "system" && m.subtype === "permission_denied") {
      // V7. Gate B17 order (fixtures/claude-synthetic/implement-ok.jsonl): this event comes before the error tool_result of the call, so end() keeps the refusal note.
      const d = m as SDKPermissionDeniedMessage;
      if (d.tool_name === "Bash") {
        // SU3: a deny rule arrives as type "rule", or as "subcommandResults" with this message. No allow rule: type "other" with
        // "This command requires approval", which only allowlist mode can give. Gate B36 (2.1.323): a command that changes files in the
        // working folders gets the file-change ask with no type, and an allow rule such as "touch *" satisfies it. Each other refusal is
        // a safety check of the CLI, such as the B22 redirect outside the working folders, with no type.
        const deny =
          d.decision_reason_type === "rule" || /^Permission to use \w+ with command [\s\S]* has been denied\.$/.test(d.message ?? "");
        const unlisted =
          opts.shell === "allowlist" &&
          ((d.decision_reason_type === "other" && /requires approval/.test(d.message ?? d.decision_reason ?? "")) ||
            /asks before a shell command creates, changes or removes files/i.test(d.message ?? ""));
        const by = deny ? "deny" : unlisted ? "allowlist" : "check";
        const id = typeof d.tool_use_id === "string" ? d.tool_use_id : "";
        state.refused.push({ command: events.get(id)?.target ?? "", by });
        // SU14 (B30a): `cd <dir> && <command>`. SU18 (B31): the read block of allowlist mode refuses a lone cd.
        const cd = by === "check" && /requires approval: cd\s|^cd names a path that is computed at run time/.test(d.message ?? "");
        end(changed, id, "error", cd ? CD_REFUSED_NOTE : REFUSED_NOTE[by]);
      } else if (AGENT_TOOLS.has(d.tool_name)) {
        const e = typeof d.tool_use_id === "string" ? events.get(d.tool_use_id) : undefined;
        const param = PARAM_DENIED.exec(d.message ?? "")?.[1] as "model" | "effort" | undefined;
        const value = e && param ? asked.get(e.id)?.[param] : null;
        if (e && param && value) {
          const text = `The lead asked for ${param} ${value} for ${e.agent ?? "an agent"}. The app refused it, so that agent step did not run.`;
          keepNote(changed, e, text.slice(0, NOTE_MAX));
          end(changed, e.id, "error", null);
        }
      }
    } else if (m.type === "system" && m.subtype === "task_started") {
      const t = m as SDKTaskStartedMessage;
      if (t.tool_use_id && t.is_backgrounded) background.add(t.tool_use_id);
    } else if (m.type === "system" && m.subtype === "task_progress") {
      const t = m as SDKTaskProgressMessage;
      agentStats(changed, t.tool_use_id, null, count(t.usage?.total_tokens));
    } else if (m.type === "system" && m.subtype === "task_notification") {
      const t = m as SDKTaskNotificationMessage;
      agentStats(changed, t.tool_use_id, null, count(t.usage?.total_tokens));
      if (t.tool_use_id) end(changed, t.tool_use_id, TASK_END[t.status] ?? "error", note(t.summary ?? ""));
    } else if (m.type === "rate_limit_event") {
      if ((m as SDKRateLimitEvent).rate_limit_info?.status === "rejected") state.rateLimitRejected = true;
    } else if (m.type === "result") {
      state.results.push(m as SDKResultMessage);
    }
    return [...changed.values()];
  }

  // Marks every running event as stopped. Call it once, after the process ends.
  function stop(): RunEvent[] {
    const changed = new Map<string, RunEvent>();
    for (const id of events.keys()) end(changed, id, "stopped", null);
    return [...changed.values()];
  }

  return { state, line, stop, events: () => [...events.values()] };
}

export type Verdict = {
  status: "completed" | "failed" | "cancelled";
  kind: RunErrorKind | null;
  text: string | null;
  // completed: the result that carries structured_output. Otherwise the last result.
  result: SDKResultMessage | null;
};

function errorKind(s: StreamState, last: SDKResultMessage | undefined): RunErrorKind {
  // Gate B5: an auth failure is subtype success with is_error true. The assistant message has error authentication_failed.
  if (s.apiErrors.some((e) => AUTH_ERRORS.has(e)) || last?.api_error_status === 401) return "auth";
  // Not verified (U9). The shape comes from SDKAssistantMessageError, SDKRateLimitInfo, and HTTP 429.
  if (s.apiErrors.includes("rate_limit") || s.rateLimitRejected || last?.api_error_status === 429) return "usage_limit";
  if (last?.subtype === "error_max_turns") return "max_turns";
  if (last?.subtype === "error_max_structured_output_retries" || (last?.subtype === "success" && !last.is_error)) return "schema";
  return "process";
}

export function classify(s: StreamState, end: { exitCode: number | null; cancelled: boolean; timedOut: boolean }): Verdict {
  const last = s.results.at(-1);
  // Gate B3: a background task adds a second result event. The final one with structured_output wins.
  const done = s.results.findLast((r) => r.structured_output !== undefined && !r.is_error);
  const failed = (kind: RunErrorKind, text: string): Verdict => ({ status: "failed", kind, text, result: last ?? null });
  if (end.cancelled) return { status: "cancelled", kind: null, text: null, result: done ?? last ?? null };
  if (s.noBash) return failed("tool_check", NO_BASH_TEXT);
  if (s.badTools.length) return failed("tool_check", `init lists tools outside the allowlist: ${s.badTools.join(", ")}.`);
  if (s.refused.length > REFUSED_MAX) return failed("tool_check", `Claude Code refused more than ${REFUSED_MAX} commands in this run.`);
  if (done) return { status: "completed", kind: null, text: null, result: done };
  if (end.timedOut) return failed("process", TIME_LIMIT_TEXT);
  const kind = errorKind(s, last);
  const fallback =
    kind === "schema"
      ? "The result has no structured output."
      : last
        ? `The run ended with ${last.terminal_reason ?? last.subtype}.`
        : `claude exited with code ${end.exitCode} and sent no result.`;
  return failed(kind, (last?.is_error ? last.result : undefined) || last?.errors?.join("\n") || fallback);
}
