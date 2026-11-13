// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The pure core of sanitize-claude.ts: it replaces real values in parsed stream-json and counts the real values that a text still holds.
// It reads no file content and starts no process. filesIn only lists a folder.
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export const isObj = (v: Json): v is { [k: string]: Json } => !!v && typeof v === "object" && !Array.isArray(v);
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const word = (t: string) => `(?<![a-z0-9])${esc(t)}(?![a-z0-9])`;
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Claude Code names per-cwd folders with every non-alphanumeric character replaced by "-".
export const pathForms = (p: string) => [p, p.replaceAll("\\", "/"), p.replaceAll("\\", "\\\\"), p.replace(/[^a-zA-Z0-9]/g, "-")];
export const formPairs = (real: string, fake: string) =>
  pathForms(real).map((r, i) => [r, pathForms(fake)[i] as string] as [string, string]);

// Gate transcripts are never committed. A test fixture is a reviewed copy, and the sanitizer deletes every .jsonl in its output folder.
export const claudeOutDir = (root: string, out?: string) => {
  const dir = resolve(root, out ?? ".gate0/claude");
  const rel = relative(resolve(root, "fixtures"), dir);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error(`the output folder must be outside fixtures/: ${dir}`);
  return dir;
};

// The names of the regular files in dir. The output folder can hold sub-folders, such as a copy of an older run.
export const filesIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

const HOOK_FIELDS = new Set(["output", "stdout", "stderr"]);

// tokens: lower-case real value -> fake. paths: [real, fake] path forms. uuids: lower-case real UUID -> fake.
export function sanitizer(tokens: Map<string, string>, paths: [string, string][], uuids: Map<string, string>) {
  const keys = [...tokens.keys()].sort((a, b) => b.length - a.length);
  const tokenRe = keys.length ? new RegExp(keys.map(word).join("|"), "gi") : null;
  const forms = [...paths].sort((a, b) => b[0].length - a[0].length);
  const fix = (s: string): string => {
    let out = s;
    for (const [real, fake] of forms) out = out.replace(new RegExp(esc(real), "gi"), fake);
    out = out.replace(UUID, (u) => uuids.get(u.toLowerCase()) ?? u);
    return tokenRe ? out.replace(tokenRe, (m) => tokens.get(m.toLowerCase()) ?? m) : out;
  };
  const sanitize = (v: Json): Json => {
    if (Array.isArray(v)) return v.map((x) => sanitize(x));
    if (isObj(v)) {
      // User hooks print their own text. It is not part of the event shape.
      const isHook = typeof v.subtype === "string" && v.subtype.startsWith("hook_");
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [fix(k), isHook && HOOK_FIELDS.has(k) && typeof x === "string" ? "<hook output>" : sanitize(x)]),
      );
    }
    return typeof v === "string" ? fix(v) : v;
  };
  return { fix, sanitize };
}

export const AGENT_OUTPUT = "<user agent output>";
// Replaces the text of a user agent (Gate B36 U88) before sanitize. It is the user's own text. names: lower-case real agent names.
// It covers the text of the agent's assistant events, the Agent tool_result and tool_use_result of the parent thread, and the summary of
// task events. Only a call that ran (session.ts agentOutcome) is covered. A refused call keeps the CLI refusal text, which B2 and B35 need.
export function hideAgentOutput(events: Json[], names: Set<string>): Json[] {
  const ids = new Set<string>();
  const ran = (id: string) =>
    events.some((e) => isObj(e) && (e.parent_tool_use_id === id || (e.subtype === "task_started" && e.tool_use_id === id)));
  for (const e of events) {
    const content = isObj(e) && isObj(e.message ?? null) ? (e.message as { [k: string]: Json }).content : null;
    for (const b of Array.isArray(content) ? content : [])
      if (
        isObj(b) &&
        b.type === "tool_use" &&
        (b.name === "Agent" || b.name === "Task") &&
        typeof b.id === "string" &&
        isObj(b.input ?? null) &&
        names.has(String((b.input as { [k: string]: Json }).subagent_type ?? "").toLowerCase()) &&
        ran(b.id)
      )
        ids.add(b.id);
  }
  if (!ids.size) return events;
  const hideBlock = (b: Json): Json =>
    !isObj(b)
      ? b
      : {
          ...b,
          ...(typeof b.text === "string" ? { text: AGENT_OUTPUT } : {}),
          ...(typeof b.thinking === "string" ? { thinking: AGENT_OUTPUT } : {}),
        };
  const hideContent = (c: Json): Json => (Array.isArray(c) ? c.map(hideBlock) : typeof c === "string" ? AGENT_OUTPUT : c);
  return events.map((e) => {
    if (!isObj(e)) return e;
    const under = typeof e.parent_tool_use_id === "string" && ids.has(e.parent_tool_use_id);
    let out: { [k: string]: Json } = e;
    if (typeof e.tool_use_id === "string" && ids.has(e.tool_use_id) && typeof e.summary === "string")
      out = { ...out, summary: AGENT_OUTPUT };
    const msg = out.message ?? null;
    if (!isObj(msg) || !Array.isArray(msg.content)) return out;
    if (under && out.type === "assistant") return { ...out, message: { ...msg, content: msg.content.map(hideBlock) } };
    const results = msg.content.some(
      (b) => isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string" && ids.has(b.tool_use_id),
    );
    if (!results) return out;
    const content = msg.content.map((b) =>
      isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string" && ids.has(b.tool_use_id)
        ? { ...b, content: hideContent(b.content ?? null) }
        : b,
    );
    const tur = out.tool_use_result ?? null;
    return {
      ...out,
      message: { ...msg, content },
      ...(isObj(tur) && "content" in tur ? { tool_use_result: { ...tur, content: hideContent(tur.content ?? null) } } : {}),
    };
  });
}

// The scan patterns: each real name that differs from its fake, each form of each real path, and each real UUID. The scan reads lower case.
// names: the count of name patterns.
export function scanPatterns(tokens: Map<string, string>, paths: string[], uuids: Iterable<string>) {
  const names = [...tokens.keys()].filter((t) => tokens.get(t)?.toLowerCase() !== t);
  const res = [
    ...names.map((t) => new RegExp(word(t))),
    ...paths.flatMap(pathForms).map((h) => new RegExp(esc(h.toLowerCase()))),
    ...[...uuids].map((u) => new RegExp(esc(u))),
  ];
  return { res, names: names.length };
}

// The count of (text, pattern) pairs where the pattern matches.
export const countHits = (texts: string[], res: RegExp[]) =>
  texts.reduce((n, t) => n + res.filter((re) => re.test(t.toLowerCase())).length, 0);
