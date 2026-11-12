// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure helpers of Gate B37 (docs/plans/review-v2/part-session.md section 4). They build argv, read stream-json events, and judge the
// recorded facts. They start no process.
import { isAbsolute } from "node:path";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const objs = (events: unknown[]) => events.filter(isObj);
const contentOf = (e: Obj) => (isObj(e.message) && Array.isArray(e.message.content) ? e.message.content.filter(isObj) : []);

export type Status = "PASS" | "FAIL" | "INFO";
export type Fact = { id: string; status: Status; evidence: string };

// ---------- argv ----------
// A session run: the implementArgs argv without --no-session-persistence. resume adds `--resume <abs .jsonl> --fork-session`
// (session-consult.md:19), model and effort replace the values of implementArgs, and live adds stream-json input.
export function sessionArgs(args: readonly string[], o: { resume?: string; model?: string; effort?: string; live?: boolean } = {}) {
  if (o.resume !== undefined && (!isAbsolute(o.resume) || !o.resume.endsWith(".jsonl")))
    throw new Error("The session path must be an absolute .jsonl path.");
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--no-session-persistence") continue;
    if ((a === "--model" && o.model) || (a === "--effort" && o.effort)) {
      i++;
      continue;
    }
    out.push(a);
  }
  const head = [...(o.resume ? ["--resume", o.resume, "--fork-session"] : []), ...(o.live ? ["--input-format", "stream-json"] : [])];
  out.splice(out.indexOf("-p") + 1, 0, ...head);
  return [...out, ...(o.model ? ["--model", o.model] : []), ...(o.effort ? ["--effort", o.effort] : [])];
}

// The resume shape that U97 needs: `--resume <abs .jsonl> --fork-session` and no --no-session-persistence.
export function resumeShape(args: readonly string[]) {
  const i = args.indexOf("--resume");
  const file = i >= 0 ? (args[i + 1] ?? "") : "";
  return (
    i >= 0 && isAbsolute(file) && file.endsWith(".jsonl") && args.includes("--fork-session") && !args.includes("--no-session-persistence")
  );
}

// The per-cwd folder name of Claude Code: each character that is not a letter or digit becomes "-" (claude.ts removeCwdFolders).
export const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

// One stream-json input line (code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
export const userLine = (text: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })}\n`;

// ---------- event readers ----------
export type ToolCall = { id: string; name: string; input: Obj; parent: string | null };
export const toolCalls = (events: unknown[]): ToolCall[] =>
  objs(events)
    .filter((e) => e.type === "assistant")
    .flatMap((e) =>
      contentOf(e)
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          input: isObj(b.input) ? b.input : {},
          parent: typeof e.parent_tool_use_id === "string" ? e.parent_tool_use_id : null,
        })),
    );
const resultOf = (events: unknown[], id: string) =>
  objs(events)
    .filter((e) => e.type === "user")
    .flatMap(contentOf)
    .find((b) => b.type === "tool_result" && b.tool_use_id === id);

const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell"];
// U108: the first main-thread Agent call of one subagent type. state: ran (child events), refused (error result), no run, no result,
// or absent. writes: the write and shell tools of the child that got an ok result.
export function agentOutcome(events: unknown[], type: string) {
  const calls = toolCalls(events);
  const call = calls.find((t) => t.parent === null && (t.name === "Agent" || t.name === "Task") && t.input.subagent_type === type);
  if (!call) return { state: "absent", tools: [] as string[], writes: [] as string[] };
  const ran = objs(events).some((e) => e.parent_tool_use_id === call.id || (e.subtype === "task_started" && e.tool_use_id === call.id));
  const res = resultOf(events, call.id);
  const child = calls.filter((t) => t.parent === call.id);
  const ok = (id: string) => {
    const r = resultOf(events, id);
    return !!r && r.is_error !== true;
  };
  const writes = child.filter((t) => WRITE_TOOLS.includes(t.name) && ok(t.id)).map((t) => t.name);
  return { state: ran ? "ran" : res?.is_error ? "refused" : res ? "no run" : "no result", tools: child.map((t) => t.name), writes };
}
export type AgentSeen = ReturnType<typeof agentOutcome>;

// U105: the usage of each main-thread assistant event. The context size is input + cache-read + cache-creation tokens.
export function mainUsage(events: unknown[]) {
  const all = objs(events)
    .filter((e) => e.type === "assistant" && !e.parent_tool_use_id)
    .map((e) => {
      const u = isObj(e.message) && isObj(e.message.usage) ? e.message.usage : {};
      return { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheCreation: num(u.cache_creation_input_tokens) };
    });
  const whole = all.filter((f) => f.input !== null && f.cacheRead !== null && f.cacheCreation !== null);
  const last = whole.at(-1);
  return {
    events: all.length,
    complete: whole.length,
    firstCacheRead: all[0]?.cacheRead ?? null,
    context: last ? (last.input ?? 0) + (last.cacheRead ?? 0) + (last.cacheCreation ?? 0) : null,
  };
}

// U106: each rate_limit_event. A reset time lies near now, so the unit is the one whose reading is nearer to now.
export function rateLimits(events: unknown[], nowMs: number) {
  return objs(events)
    .filter((e) => e.type === "rate_limit_event")
    .map((e) => {
      const i = isObj(e.rate_limit_info) ? e.rate_limit_info : {};
      const r = i.resetsAt;
      const unit =
        typeof r !== "number" ? (r === undefined ? "absent" : typeof r) : Math.abs(r - nowMs / 1000) < Math.abs(r - nowMs) ? "s" : "ms";
      const inMin = typeof r === "number" ? Math.round(((unit === "s" ? r * 1000 : r) - nowMs) / 60_000) : null;
      const resetsAt = typeof r === "number" ? r : null;
      return {
        status: String(i.status ?? "absent"),
        type: String(i.rateLimitType ?? "absent"),
        resetsAt,
        unit,
        inMin,
        keys: Object.keys(i).sort(),
      };
    });
}

// U107: the cost fields of the last result event.
export function usageOf(events: unknown[]) {
  const r = objs(events)
    .filter((e) => e.type === "result")
    .at(-1);
  if (!r) return null;
  const u = isObj(r.usage) ? r.usage : {};
  return {
    cost: num(r.total_cost_usd),
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    models: isObj(r.modelUsage) ? Object.keys(r.modelUsage) : [],
  };
}
export type Usage = NonNullable<ReturnType<typeof usageOf>>;

// Session totals hold the first run, so a resumed run that reports less than the first run reports its own process only.
export function perProcess(first: Usage | null, resumed: (Usage | null)[], key: "cost" | "output") {
  const f = first?.[key];
  const vals = resumed.map((r) => r?.[key]).filter((v): v is number => typeof v === "number");
  if (typeof f !== "number" || !vals.length) return "unknown";
  return vals.some((v) => v < f) ? "per process" : "not decided (each resumed value >= run 1)";
}

// A kept transcript: its line count, whether its last line is whole JSON, and whether it holds the needle.
export function transcriptFacts(text: string, needle: string) {
  const lines = text.split("\n").filter((l) => l.trim());
  let lastWhole = false;
  try {
    JSON.parse(lines.at(-1) ?? "");
    lastWhole = true;
  } catch {}
  return { lines: lines.length, lastWhole, endsWithNewline: text.endsWith("\n"), holds: text.includes(needle) };
}

// File names under a per-cwd folder for the console: the session IDs become labels, and every other UUID or long hex run becomes <id>.
export function labelIds(names: string[], ids: Record<string, string>) {
  return names.map((n) => {
    let out = n;
    for (const [id, label] of Object.entries(ids)) if (id) out = out.replaceAll(id, label);
    return out
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
      .replace(/(?<![0-9a-z])[0-9a-f]{12,}(?![0-9a-z])/gi, "<id>");
  });
}

// ---------- judges ----------
// state: ran, refused, error, no result, or not tried. label: the app stream parser label of a refused Bash command.
export type Seen = { state: string; label?: string };
const seen = (s: Seen) => `${s.state}${s.label && s.label !== "none" ? ` (${s.label})` : ""}`;
const refusedAs = (s: Seen, label: string) => s.state === "refused" && s.label === label;
const list = (v: string[]) => v.join(",") || "none";

// U97: exit 0, init.tools equals the --tools list (init names Agent "Task", Gate B8) plus StructuredOutput, permissionMode default, and
// structured_output parses as implementResult.
export function u97(o: {
  argv: readonly string[];
  exit: number | null;
  tools: string[] | null;
  want: string[];
  allowed: string[];
  mode?: string;
  zod: string;
}): Fact {
  const init = o.tools ?? [];
  const missing = [...o.want, "StructuredOutput"].filter((t) => !init.includes(t) && !(t === "Agent" && init.includes("Task")));
  const extra = init.filter((t) => !o.allowed.includes(t));
  const shape = resumeShape(o.argv);
  const pass = shape && o.exit === 0 && o.tools !== null && !missing.length && !extra.length && o.mode === "default" && o.zod === "ok";
  return {
    id: "U97",
    status: pass ? "PASS" : "FAIL",
    evidence: `--resume <abs> --fork-session without --no-session-persistence=${shape}; exit=${o.exit} init.tools=${o.tools ? list(init) : "no init"} missing=${list(missing)} extra=${list(extra)} permissionMode=${o.mode ?? "none"} implementResult=${o.zod}`,
  };
}

// U98: a resumed run keeps the limits. Write outside the cwd, git status, a command with no allow rule, and a compound with git are
// refused, each Bash refusal with its app label. The probe pattern runs.
export function u98(o: {
  write: Seen & { file: boolean };
  git: Seen;
  unlisted: Seen & { marker: boolean };
  compound: Seen & { marker: boolean };
  probe: Seen & { marker: boolean };
}): Fact {
  const pass =
    o.write.state === "refused" &&
    !o.write.file &&
    refusedAs(o.git, "deny") &&
    refusedAs(o.unlisted, "allowlist") &&
    !o.unlisted.marker &&
    refusedAs(o.compound, "deny") &&
    !o.compound.marker &&
    o.probe.state === "ran" &&
    o.probe.marker;
  return {
    id: "U98",
    status: pass ? "PASS" : "FAIL",
    evidence: `Write outside=${seen(o.write)} file=${o.write.file}; git status=${seen(o.git)} (want deny); unlisted=${seen(o.unlisted)} marker=${o.unlisted.marker} (want allowlist); <probe> && git status=${seen(o.compound)} marker=${o.compound.marker} (want deny); probe=${seen(o.probe)} marker=${o.probe.marker}`,
  };
}

// U99: a resume without Bash and Agent (a resolve run). init lists no Bash, no Agent, and no Task, and no Bash call runs.
export function u99(o: { exit: number | null; tools: string[] | null; bash: Seen; marker: boolean }): Fact {
  const init = o.tools ?? [];
  const off = !init.some((t) => ["Bash", "Agent", "Task"].includes(t));
  const pass = o.exit === 0 && o.tools !== null && off && o.bash.state !== "ran" && !o.marker;
  return {
    id: "U99",
    status: pass ? "PASS" : "FAIL",
    evidence: `exit=${o.exit} init.tools=${o.tools ? list(init) : "no init"}; Bash call=${seen(o.bash)} marker=${o.marker}`,
  };
}

// U100: the gate committed a change of a.txt and edited b.txt between the runs. The resumed run reads the new text of both and edits
// a.txt. INFO: the outcome of an Edit of a.txt before any new Read. setup: the state of the run 1 Write of a.txt; the INFO part needs
// "ran".
export function u100(o: {
  setup: string;
  stale: Seen & { text: string };
  readA: string;
  readB: string;
  final: string;
  marks: { old: string; newA: string[]; newB: string; edited: string };
}): Fact {
  const sawA = o.marks.newA.some((m) => o.readA.includes(m)) && !o.readA.includes(o.marks.old);
  const sawB = o.readB.includes(o.marks.newB);
  const pass = sawA && sawB && o.final === o.marks.edited;
  return {
    id: "U100",
    status: pass ? "PASS" : "FAIL",
    evidence: `Read a.txt shows the committed text=${sawA}; Read b.txt shows the disk edit=${sawB}; a.txt edited=${o.final === o.marks.edited}; INFO: run 1 Write of a.txt=${o.setup}; Edit before a new Read=${seen(o.stale)} "modified since read"=${/modified since/i.test(o.stale.text)} text=${JSON.stringify(o.stale.text)}`,
  };
}

// U101: the resume of a transcript that a kill cut. The run knows the Write of the cut run without a tool call.
export function u101(o: {
  killed: boolean;
  wroteFirst: boolean;
  kept: boolean;
  exit: number | null;
  summary: string;
  marker: string;
  calls: string[];
}): Fact {
  const knows = o.summary.includes(o.marker);
  const pass = o.killed && o.wroteFirst && o.kept && o.exit === 0 && knows && !o.calls.length;
  const status: Status = pass ? "PASS" : o.killed && o.kept && o.exit === 0 && knows ? "INFO" : "FAIL";
  return {
    id: "U101",
    status,
    evidence: `killed in the sleep=${o.killed} Write result before the kill=${o.wroteFirst} partial transcript kept=${o.kept}; resume exit=${o.exit} knows the Write=${knows} tool calls=${list(o.calls)}`,
  };
}

// U103: the transcript place without --no-session-persistence, and a resume from the moved file in another folder.
export function u103(o: { placed: boolean[]; newId: boolean; files: string[][]; resumed: boolean; kept: boolean }): Fact {
  const pass = o.placed.length > 1 && o.placed.every(Boolean) && o.newId && o.resumed && o.kept;
  return {
    id: "U103",
    status: pass ? "PASS" : "FAIL",
    evidence: `<projectsDir>/<encoded cwd>/<session id>.jsonl: run 1=${o.placed[0] ?? false} run 2=${o.placed[1] ?? false} new id on the fork=${o.newId}; resume from the moved file=${o.resumed}; the moved run 1 file keeps its name and hash=${o.kept}; files run 1=[${o.files[0]?.join(", ") ?? ""}] run 2=[${o.files[1]?.join(", ") ?? ""}]`,
  };
}

// U104: a second stream-json message during `sleep 20` asks for a marker file. exitAfterCloseMs: null when the CLI did not exit within
// the limit after the close. waited: after the first result, the CLI was alive with stdin open and sent no event for some seconds; null
// when no result came.
export function u104(o: {
  sent: boolean;
  marker: boolean;
  structured: boolean;
  results: number;
  queued: unknown[];
  waited: boolean | null;
  exitedBeforeClose: boolean;
  exitAfterCloseMs: number | null;
  exit: number | null;
}): Fact {
  const exited = o.exitedBeforeClose || o.exitAfterCloseMs !== null;
  const pass = o.sent && o.marker && o.structured && exited;
  const end = o.exitedBeforeClose
    ? "exit before the close"
    : o.exitAfterCloseMs !== null
      ? `exit ${o.exitAfterCloseMs} ms after the close`
      : "no exit within the limit after the close";
  return {
    id: "U104",
    status: pass ? "PASS" : "FAIL",
    evidence: `second message sent in the sleep=${o.sent}; marker=${o.marker}; structured_output=${o.structured}; result events=${o.results} queued_turn_count=${o.queued.map(String).join(",") || "none"}; exit=${o.exit}, ${end}; INFO: waits for stdin after a result=${o.waited ?? (o.exitedBeforeClose ? false : "no result")}`,
  };
}

// U105: each main-thread assistant event of each run carries input, cache-read, and cache-creation tokens.
export function u105(runs: { name: string; events: unknown[] }[]): Fact {
  const per = runs.map((r) => ({ name: r.name, ...mainUsage(r.events) })).filter((r) => r.events > 0);
  const pass = per.length > 0 && per.every((r) => r.complete === r.events);
  return {
    id: "U105",
    status: pass ? "PASS" : "FAIL",
    evidence: per.length
      ? per.map((r) => `${r.name}: ${r.complete}/${r.events} with all three, last context=${r.context ?? "none"}`).join("; ")
      : "no main-thread assistant event",
  };
}

// U108: the resumed run asks for general-purpose and for rl-explorer. general-purpose is refused, and rl-explorer runs with no write.
export function u108(o: { gp: AgentSeen; ex: AgentSeen; explorerFile: boolean }): Fact {
  const pass = o.gp.state === "refused" && o.ex.state === "ran" && !o.ex.writes.length && !o.explorerFile;
  return {
    id: "U108",
    status: pass ? "PASS" : "FAIL",
    evidence: `general-purpose=${o.gp.state}; rl-explorer=${o.ex.state} tools=${list(o.ex.tools)} ok writes=${list(o.ex.writes)} explorer file=${o.explorerFile}`,
  };
}
