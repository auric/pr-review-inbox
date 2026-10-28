// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure model of the review profile editor (M4). No DOM access, so bun test runs it.
import {
  type Effort,
  MAX_MCP_TOOLS,
  MAX_NOTE,
  MAX_PROFILE_MCP,
  MAX_PROFILE_SKILLS,
  MAX_PROFILES,
  type McpPick,
  type McpToolSafety,
  type ProfileInput,
  type ReviewerMode,
  type SettingValue,
} from "../../shared/dto";

// The inline limits of profileInput in src/shared/dto.ts. tests/ui/profiles.test.ts pins them.
export const LIMITS = {
  profiles: MAX_PROFILES,
  id: 40,
  name: 60,
  note: 200,
  prompt: MAX_NOTE,
  minTurns: 2,
  maxTurns: 200,
  skills: MAX_PROFILE_SKILLS,
  mcp: MAX_PROFILE_MCP,
  mcpTools: MAX_MCP_TOOLS,
  model: 200,
} as const;

// The modelName pattern of src/shared/dto.ts. A value import of the schema would put zod into the page.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;
// The EFFORTS of src/shared/dto.ts.
export const EFFORT_CHOICES: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// The text of the "no flag" choice. v: the value from the runner settings, if the server knows it.
export const defaultChoice = (v: SettingValue | null | undefined) =>
  v ? `Use my default (${v.value}${v.sure ? "" : ", from your settings"})` : "Use my default";

// A new profile saves at once, so it starts valid: a review profile with 100 turns, the documentation servers, and language checks.
const NEW_NAME = "New profile";
export const NEW_PROMPT = "Find defects in the change: wrong logic, missed edge cases, and effects on callers outside the diff.";
const NEW_TURNS = 100;

// key: a stable React key, so a moved profile keeps its DOM nodes. id: the saved ID; a new profile gets it when it is added.
// maxTurns, model: the text of the field. "" in a model or effort: no flag, so the runner uses its default.
// skills: skill IDs in the order the user picked them. mcp: MCP servers in the order the user picked them.
export type Draft = {
  key: number;
  id: string;
  name: string;
  note: string;
  prompt: string;
  explain: boolean;
  docs: boolean;
  languageChecks: boolean;
  maxTurns: string;
  skills: string[];
  alwaysSkills: string[];
  mcp: McpPick[];
  model: string;
  effort: Effort | "";
  reviewer: { model: string; effort: Effort | ""; mode: ReviewerMode };
  // docs/plans/review-v2/spec.md section 1.2. verifier "" model: the profile model. "" effort: medium.
  modules: ProfileInput["modules"];
  volume: ProfileInput["volume"];
  verifier: { mode: ProfileInput["verifier"]["mode"]; model: string; effort: Effort | "" };
  // docs/plans/review-v3.md WP-V2: eval switches. The editor has no control for them, and a save keeps them.
  variants: ProfileInput["variants"];
};

let lastKey = 0;

export const toDrafts = (profiles: ProfileInput[]): Draft[] =>
  profiles.map((p) => ({
    ...p,
    key: ++lastKey,
    maxTurns: String(p.maxTurns),
    model: p.model ?? "",
    effort: p.effort ?? "",
    reviewer: { model: p.reviewer.model ?? "", effort: p.reviewer.effort ?? "", mode: p.reviewer.mode },
    verifier: { mode: p.verifier.mode, model: p.verifier.model ?? "", effort: p.verifier.effort ?? "" },
  }));

// The profileInput ID pattern is [a-z0-9-]{1,40}.
export function slug(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, LIMITS.id)
    .replace(/^-+|-+$/g, "");
  return s || "profile";
}

function unique(base: string, taken: Set<string>, tail: (n: number) => string, max: number): string {
  let out = base;
  for (let n = 2; taken.has(out); n++) {
    const t = tail(n);
    out = `${base.slice(0, max - t.length).replace(/-+$/, "")}${t}`;
  }
  return out;
}

const uniqueId = (base: string, taken: Set<string>) => unique(base, taken, (n) => `-${n}`, LIMITS.id);

export function toProfiles(list: Draft[]): ProfileInput[] {
  return list.map((d) => {
    const turns = d.maxTurns.trim();
    return {
      id: d.id,
      name: d.name.trim(),
      note: d.note.trim(),
      prompt: d.prompt.trim(),
      explain: d.explain,
      docs: d.docs,
      languageChecks: d.languageChecks,
      maxTurns: turns ? Number(turns) : Number.NaN,
      skills: d.skills,
      alwaysSkills: d.alwaysSkills.filter((id) => d.skills.includes(id)),
      mcp: d.mcp,
      model: d.model.trim() || null,
      effort: d.effort || null,
      reviewer: { model: d.reviewer.model.trim() || null, effort: d.reviewer.effort || null, mode: d.reviewer.mode },
      modules: d.modules,
      volume: d.volume,
      verifier: { mode: d.verifier.mode, model: d.verifier.model.trim() || null, effort: d.verifier.effort || null },
      variants: d.variants,
    };
  });
}

// Every key at every level, so the comparison ignores the key order.
const KEYS = [
  "id",
  "name",
  "note",
  "prompt",
  "explain",
  "docs",
  "languageChecks",
  "maxTurns",
  "skills",
  "alwaysSkills",
  "mcp",
  "server",
  "tools",
  "model",
  "effort",
  "reviewer",
  "mode",
  "modules",
  "volume",
  "verifier",
  "variants",
];
export const sameProfiles = (a: ProfileInput[], b: ProfileInput[]) => JSON.stringify(a, KEYS) === JSON.stringify(b, KEYS);

export type Field = "name" | "note" | "prompt" | "maxTurns" | "model" | "reviewerModel" | "verifierModel";
export type Problems = Partial<Record<Field, string>>;

const modelProblem = (text: string) =>
  !text.trim() || MODEL.test(text.trim()) ? null : "Enter a model name without spaces that starts with a letter or a digit.";

// The profileInput rules: the server trims each text before it checks the length.
export function problems(d: Draft): Problems {
  const out: Problems = {};
  const name = d.name.trim();
  const prompt = d.prompt.trim();
  const turns = d.maxTurns.trim() ? Number(d.maxTurns) : Number.NaN;
  if (!name) out.name = "Enter a name.";
  else if (name.length > LIMITS.name) out.name = `Use ${LIMITS.name} characters or fewer for the name.`;
  if (d.note.trim().length > LIMITS.note) out.note = `Use ${LIMITS.note} characters or fewer for the note.`;
  if (!prompt) out.prompt = "Enter a prompt.";
  else if (prompt.length > LIMITS.prompt) out.prompt = `Use ${LIMITS.prompt.toLocaleString("en")} characters or fewer for the prompt.`;
  if (!Number.isInteger(turns) || turns < LIMITS.minTurns || turns > LIMITS.maxTurns)
    out.maxTurns = `Enter a turn cap from ${LIMITS.minTurns} to ${LIMITS.maxTurns}.`;
  const model = modelProblem(d.model);
  if (model) out.model = model;
  const reviewer = modelProblem(d.reviewer.model);
  if (reviewer) out.reviewerModel = reviewer;
  const verifier = modelProblem(d.verifier.model);
  if (verifier) out.verifierModel = verifier;
  return out;
}

export const allValid = (list: Draft[]) =>
  list.length >= 1 && list.length <= LIMITS.profiles && list.every((d) => Object.keys(problems(d)).length === 0);

// The profile that a new draft falls back to before its first save.
const newProfile = (id: string): ProfileInput => ({
  id,
  name: NEW_NAME,
  note: "",
  prompt: NEW_PROMPT,
  explain: false,
  docs: true,
  languageChecks: true,
  maxTurns: NEW_TURNS,
  skills: [],
  alwaysSkills: [],
  mcp: [],
  model: null,
  effort: null,
  reviewer: { model: null, effort: null, mode: "auto" },
  modules: [],
  volume: "balanced",
  verifier: { mode: "on", model: null, effort: null },
  variants: [],
});

// The list that an autosave sends. A field with a problem keeps its saved value, so the other fields still save.
// saved: the profiles that the server holds now. A draft without a saved profile falls back to the new-profile values.
export function toPayload(list: Draft[], saved: ProfileInput[]): ProfileInput[] {
  const byId = new Map(saved.map((p) => [p.id, p]));
  return toProfiles(list).map((p, i) => {
    const found = problems(list[i] as Draft);
    const base = byId.get(p.id) ?? newProfile(p.id);
    return {
      ...p,
      name: found.name ? base.name : p.name,
      note: found.note ? base.note : p.note,
      prompt: found.prompt ? base.prompt : p.prompt,
      maxTurns: found.maxTurns ? base.maxTurns : p.maxTurns,
      model: found.model ? base.model : p.model,
      reviewer: { ...p.reviewer, model: found.reviewerModel ? base.reviewer.model : p.reviewer.model },
      verifier: { ...p.verifier, model: found.verifierModel ? base.verifier.model : p.verifier.model },
    };
  });
}

export type Edit = Partial<
  Pick<
    Draft,
    | "name"
    | "note"
    | "prompt"
    | "explain"
    | "docs"
    | "languageChecks"
    | "maxTurns"
    | "skills"
    | "alwaysSkills"
    | "mcp"
    | "model"
    | "effort"
    | "reviewer"
    | "modules"
    | "volume"
    | "verifier"
  >
>;

export type Change =
  | { act: "add" }
  | { act: "remove"; i: number }
  | { act: "move"; i: number; d: -1 | 1 }
  | { act: "edit"; i: number; patch: Edit }
  | { act: "copy"; i: number };

const SETUP_KEYS = ["skills", "alwaysSkills", "mcp", "server", "tools"];
// The skills, the Always use marks, and the MCP picks of a profile. A mark needs its skill (profileInput).
const setupOf = (d: Draft): Pick<Draft, "skills" | "alwaysSkills" | "mcp"> => ({
  skills: [...d.skills],
  alwaysSkills: d.alwaysSkills.filter((id) => d.skills.includes(id)),
  mcp: d.mcp.map((m) => ({ server: m.server, tools: [...m.tools] })),
});
const setupText = (d: Draft) => JSON.stringify(setupOf(d), SETUP_KEYS);

// The indexes of the other profiles whose skills or MCP picks differ from those of profile i.
export function copyTargets(list: Draft[], i: number): number[] {
  const from = list[i];
  if (!from) return [];
  const text = setupText(from);
  return list.flatMap((d, j) => (j !== i && setupText(d) !== text ? [j] : []));
}

export function change(list: Draft[], c: Change): Draft[] {
  switch (c.act) {
    case "add": {
      if (list.length >= LIMITS.profiles) return list;
      const id = uniqueId(slug(NEW_NAME), new Set(list.map((d) => d.id)));
      const name = unique(NEW_NAME, new Set(list.map((d) => d.name.trim())), (n) => ` ${n}`, LIMITS.name);
      const [d] = toDrafts([{ ...newProfile(id), name }]) as [Draft];
      return [...list, d];
    }
    case "remove":
      // The server needs at least one profile.
      return list.length <= 1 ? list : list.filter((_, i) => i !== c.i);
    case "move": {
      const j = c.i + c.d;
      const d = list[c.i];
      if (!d || j < 0 || j >= list.length) return list;
      const out = list.filter((_, i) => i !== c.i);
      out.splice(j, 0, d);
      return out;
    }
    case "edit":
      return list.map((d, i) => (i === c.i ? { ...d, ...c.patch } : d));
    case "copy": {
      const from = list[c.i];
      const targets = copyTargets(list, c.i);
      if (!from || !targets.length) return list;
      return list.map((d, j) => (targets.includes(j) ? { ...d, ...setupOf(from) } : d));
    }
  }
}

// DOM ids of the editor controls.
export type Part =
  | "row"
  | "name"
  | "note"
  | "prompt"
  | "turns"
  | "explain"
  | "docs"
  | "lang"
  | "model"
  | "model-id"
  | "effort"
  | "reviewer"
  | "reviewer-model"
  | "reviewer-model-id"
  | "reviewer-effort"
  | "checks"
  | "volume"
  | "verifier"
  | "verifier-model"
  | "verifier-model-id"
  | "verifier-effort"
  | "setup"
  | "skills"
  | "skills-label"
  | "mcp"
  | "mcp-label"
  | "copy"
  | "improve"
  | "up"
  | "down"
  | "remove"
  | `${Field}-error`;
export const profileId = (i: number, part: Part) => `profile-${i}-${part}`;
export const ADD_ID = "profile-add";

// The control that keeps the place after a change. n: the profile count after it.
export function focusAfter(c: Change, n: number): string | null {
  switch (c.act) {
    case "add":
      return profileId(n - 1, "name");
    case "remove":
      // The remove button of the last profile is disabled.
      return n > 1 ? profileId(Math.min(c.i, n - 1), "remove") : ADD_ID;
    case "move": {
      const j = c.i + c.d;
      // The button in the same direction is disabled at the end of the list.
      const end = c.d < 0 ? j === 0 : j === n - 1;
      return profileId(j, c.d < 0 !== end ? "up" : "down");
    }
    default:
      return null;
  }
}

// Adds or removes one skill ID. A new skill goes to the end.
export const toggleSkill = (list: string[], id: string, on: boolean) =>
  on ? (list.includes(id) ? list : [...list, id]) : list.filter((x) => x !== id);

// The patch for a new skill list. A skill that leaves the list loses its Always use mark.
export const skillsPatch = (d: Pick<Draft, "alwaysSkills">, skills: string[]) => ({
  skills,
  alwaysSkills: d.alwaysSkills.filter((id) => skills.includes(id)),
});

// Adds every ID that is not in the list yet, in the given order, up to the skill limit.
export const addSkills = (list: string[], ids: string[]) =>
  [...list, ...ids.filter((id) => !list.includes(id))].slice(0, Math.max(list.length, LIMITS.skills));

// Adds a server with the given tools at the end, or removes it.
export const toggleServer = (list: McpPick[], server: string, on: boolean, tools: string[] = []) =>
  on ? (list.some((m) => m.server === server) ? list : [...list, { server, tools }]) : list.filter((m) => m.server !== server);

// Sets the tools of one picked server.
export const setTools = (list: McpPick[], server: string, tools: string[]) =>
  list.map((m) => (m.server === server ? { server, tools } : m));

// What a tick on a tool does. A blocked tool cannot be ticked. An unmarked tool needs a confirm first. Unticking is always allowed.
export const tickAction = (safety: McpToolSafety, on: boolean): "set" | "confirm" | "none" =>
  !on || safety === "readOnly" ? "set" : safety === "unmarked" ? "confirm" : "none";

// Select all of one server: the ticked tools plus every read-only tool, at once. unmarked: the tools that need one confirm. A blocked tool never joins.
export function selectAll(ticked: string[], tools: { name: string; safety: McpToolSafety }[]) {
  const add = (list: string[], names: string[]) => [...list, ...names.filter((n) => !list.includes(n))].slice(0, LIMITS.mcpTools);
  const readOnly = add(
    ticked,
    tools.filter((t) => t.safety === "readOnly").map((t) => t.name),
  );
  const unmarked = tools.filter((t) => t.safety === "unmarked" && !readOnly.includes(t.name)).map((t) => t.name);
  return { tools: readOnly, unmarked, withUnmarked: add(readOnly, unmarked) };
}

export const unmarkedQuestion = (tool: string, server: string) =>
  `${tool} on ${server} has no read-only mark. PR Review Inbox cannot check what it does. Allow it in runs of this profile?`;

export const unmarkedListQuestion = (tools: string[], server: string) =>
  tools.length === 1
    ? unmarkedQuestion(tools[0] as string, server)
    : `These ${tools.length} tools on ${server} have no read-only mark: ${tools.join(", ")}. PR Review Inbox cannot check what they do. Allow them in runs of this profile?`;

// Words for a profile in labels. A profile can have no name while the user edits it.
export const profileLabel = (d: Draft, i: number) => d.name.trim() || `profile ${i + 1}`;

const count = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : `no ${word}s`);
export const setupSummary = (d: Draft, label: string) =>
  `${label} has ${count(d.skills.length, "skill")} and ${count(d.mcp.length, "MCP server")}.`;
export const copiedText = (label: string, n: number) => `Saved. ${count(n, "profile")} got the skills and MCP servers of ${label}.`;

// The select value of a model text: "" for the default, one of the runner aliases, or "other" for any other ID.
export const modelChoice = (text: string, aliases: string[]) => {
  const t = text.trim();
  return !t ? "" : aliases.includes(t) ? t : "other";
};
