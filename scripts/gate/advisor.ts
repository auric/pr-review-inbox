// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure helpers of Gate G-ADV (docs/plans/review-v2/advisor.md). They read stream-json events and start no process.
// Wire names come from the advisor docs: a `server_tool_use` block named `advisor`, an `advisor_tool_result` block, and
// `usage.iterations[]` entries with `type: "advisor_message"`.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const ADVISOR = /advisor/i;

// One entry per init key that names the advisor: "key=value" for a scalar, "key[]=a,b" for the matching list items,
// "key: nested" for an object or a long value. The init event can hold user config, so no full value goes out.
export function advisorInInit(init: unknown): string[] {
  if (!isObj(init)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(init)) {
    if (Array.isArray(v)) {
      const hits = v.filter((x) => ADVISOR.test(typeof x === "string" ? x : (JSON.stringify(x) ?? "")));
      if (hits.length) out.push(`${k}[]=${hits.map((x) => (typeof x === "string" ? x : "<object>")).join(",")}`);
      else if (ADVISOR.test(k)) out.push(`${k}[]=<${v.length} items>`);
      continue;
    }
    const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
    if (!ADVISOR.test(k) && !ADVISOR.test(s)) continue;
    out.push(!isObj(v) && s.length <= 80 ? `${k}=${s}` : `${k}: nested`);
  }
  return out;
}

export const advisorTools = (init: unknown) =>
  isObj(init) && Array.isArray(init.tools) ? init.tools.filter((t): t is string => typeof t === "string" && ADVISOR.test(t)) : [];

export type AdvisorStream = {
  eventTypes: Record<string, number>;
  blockTypes: Record<string, number>;
  advisorCalls: number;
  advisorResults: number;
  advisorIterations: number;
  resultAdvisorIterations: number;
  results: { subtype: string; isError: boolean; costUsd: number | null; models: string[] }[];
  advisorDenials: number;
};

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
const advisorIters = (usage: unknown) =>
  isObj(usage) && Array.isArray(usage.iterations) ? usage.iterations.filter((i) => isObj(i) && i.type === "advisor_message").length : 0;

// Counts and type names only. Events are parsed stream-json lines.
export function advisorStream(events: unknown[]): AdvisorStream {
  const s: AdvisorStream = {
    eventTypes: {},
    blockTypes: {},
    advisorCalls: 0,
    advisorResults: 0,
    advisorIterations: 0,
    resultAdvisorIterations: 0,
    results: [],
    advisorDenials: 0,
  };
  for (const e of events) {
    if (!isObj(e) || typeof e.type !== "string") continue;
    bump(s.eventTypes, typeof e.subtype === "string" ? `${e.type}/${e.subtype}` : e.type);
    const msg = isObj(e.message) ? e.message : undefined;
    for (const b of Array.isArray(msg?.content) ? msg.content : []) {
      if (!isObj(b) || typeof b.type !== "string") continue;
      bump(s.blockTypes, b.type);
      if (b.type === "server_tool_use" && b.name === "advisor") s.advisorCalls++;
      if (b.type === "advisor_tool_result") s.advisorResults++;
    }
    s.advisorIterations += advisorIters(msg?.usage);
    if (e.type !== "result") continue;
    s.resultAdvisorIterations += advisorIters(e.usage);
    s.results.push({
      subtype: typeof e.subtype === "string" ? e.subtype : "none",
      isError: e.is_error === true,
      costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : null,
      models: isObj(e.modelUsage) ? Object.keys(e.modelUsage) : [],
    });
    for (const d of Array.isArray(e.permission_denials) ? e.permission_denials : [])
      if (isObj(d) && typeof d.tool_name === "string" && ADVISOR.test(d.tool_name)) s.advisorDenials++;
  }
  return s;
}

// The verdict of a run that must have no advisor (GADV.2, GADV.4). CLI 2.1.322: init.tools never lists the advisor, and
// slash_commands lists the /advisor command whether the advisor is on or off. So only init.tools and the advisor use count.
// used: the run shows an advisor call or advisor usage. controlCalls: the advisor calls of the run with --advisor and no switch.
// PASS needs a control call: without one, no advisor call proves nothing.
export function advisorOff(r: { init: unknown; used: boolean } | undefined, controlCalls: number): "PASS" | "FAIL" | "UNKNOWN" {
  if (!r?.init) return "UNKNOWN";
  if (advisorTools(r.init).length || r.used) return "FAIL";
  return controlCalls > 0 ? "PASS" : "UNKNOWN";
}

// GADV.3: the advisor is a server tool, and init.tools never lists it (CLI 2.1.322). Only a call proves it.
export const advisorOn = (calls: number): "PASS" | "FAIL" => (calls > 0 ? "PASS" : "FAIL");

// GADV.5a and GADV.5b: the effect of a tool flag on the advisor, as an INFO text.
export const flagEffect = (calls: number) =>
  calls > 0 ? `the flag does not remove the advisor: calls=${calls}` : `no advisor call: calls=${calls}`;

// A full model ID holds the family alias: "opus" matches "claude-opus-4-6".
export const namesModel = (key: string, model: string) => key.toLowerCase().includes(model.toLowerCase());

export const counts = (m: Record<string, number>) =>
  Object.entries(m)
    .map(([k, n]) => `${k}=${n}`)
    .join(",") || "none";
