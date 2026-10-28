// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { MAX_NOTE, MAX_PROFILES, type ProfileInput, profileInput, profileList } from "../../src/shared/dto";
import {
  ADD_ID,
  addSkills,
  allValid,
  change,
  copiedText,
  copyTargets,
  type Draft,
  defaultChoice,
  focusAfter,
  LIMITS,
  modelChoice,
  NEW_PROMPT,
  problems,
  profileId,
  sameProfiles,
  selectAll,
  setTools,
  setupSummary,
  skillsPatch,
  slug,
  tickAction,
  toDrafts,
  toggleServer,
  toggleSkill,
  toPayload,
  toProfiles,
  unmarkedListQuestion,
  unmarkedQuestion,
} from "../../src/web/settings/profiles";

const p = (id: string, name: string, o: Partial<ProfileInput> = {}): ProfileInput => ({
  id,
  name,
  note: `${name} note`,
  prompt: `Check ${name}.`,
  explain: false,
  docs: true,
  languageChecks: false,
  maxTurns: 40,
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
  ...o,
});
const SAVED = [p("general", "General"), p("security", "Security"), p("explain", "Explain", { explain: true, docs: false, maxTurns: 12 })];

// Model texts: empty, aliases, full IDs, and texts that the server refuses.
const MODELS = [
  "",
  "  ",
  "opus",
  "claude-opus-5-5",
  "opus[1m]",
  "us.anthropic.claude:0",
  " sonnet ",
  "-x",
  "a b",
  "m".repeat(200),
  "m".repeat(201),
];

const added = (list: Draft[], name: string, prompt = "Look.") => {
  const next = change(list, { act: "add" });
  return change(next, { act: "edit", i: next.length - 1, patch: { name, prompt } });
};
const ids = (list: Draft[]) => toProfiles(list).map((x) => x.id);

describe("profile editor model", () => {
  test("saved profiles become drafts and back without loss", () => {
    const d = toDrafts(SAVED);
    expect(toProfiles(d)).toEqual(SAVED);
    expect(sameProfiles(toProfiles(d), SAVED)).toBe(true);
    expect(d.map((x) => x.maxTurns)).toEqual(["40", "40", "12"]);
    expect(new Set(d.map((x) => x.key)).size).toBe(3);
  });

  test("a profile keeps its ID through a rename; a new profile gets a unique ID and name when it is added", () => {
    let d = change(toDrafts(SAVED), { act: "edit", i: 0, patch: { name: "Correctness" } });
    expect(ids(d)[0]).toBe("general");
    // An added profile saves at once, so its ID comes from the name it starts with.
    d = change(d, { act: "add" });
    d = change(d, { act: "add" });
    d = added(d, "Perf");
    expect(ids(d)).toEqual(["general", "security", "explain", "new-profile", "new-profile-2", "new-profile-3"]);
    expect(toProfiles(d).map((x) => x.name)).toEqual(["Correctness", "Security", "Explain", "New profile", "New profile 2", "Perf"]);
    expect(profileList.safeParse(toProfiles(d)).success).toBe(true);
    // A removed ID can come back for the next new profile.
    expect(ids(change(change(d, { act: "remove", i: 3 }), { act: "add" })).at(-1)).toBe("new-profile");
  });

  test("slugs fit the server ID pattern for any name", () => {
    expect(slug("Überprüfung der API")).toBe("uberprufung-der-api");
    expect(slug("  --Over-engineering--  ")).toBe("over-engineering");
    expect(slug("Код ревью")).toBe("profile");
    expect(slug("🤖")).toBe("profile");
    const long = `${"a".repeat(LIMITS.id - 1)} b`;
    expect(slug(long)).toBe("a".repeat(LIMITS.id - 1));
    let d = toDrafts([p("x", "X")]);
    for (let i = 0; i < 12; i++) d = added(d, "Y".repeat(70));
    const out = ids(d);
    expect(new Set(out).size).toBe(out.length);
    for (const id of out) expect(profileInput.shape.id.safeParse(id).success).toBe(true);
    expect(out.at(-1)).toBe("new-profile-12");
  });

  test("remove keeps one profile, add stops at the limit, move keeps the keys", () => {
    const d = toDrafts(SAVED);
    expect(ids(change(d, { act: "remove", i: 1 }))).toEqual(["general", "explain"]);
    const one = toDrafts([p("only", "Only")]);
    expect(change(one, { act: "remove", i: 0 })).toBe(one);
    let full = d;
    for (let i = 0; i < 30; i++) full = change(full, { act: "add" });
    expect(full).toHaveLength(MAX_PROFILES);
    const moved = change(d, { act: "move", i: 2, d: -1 });
    expect(ids(moved)).toEqual(["general", "explain", "security"]);
    expect(moved.map((x) => x.key)).toEqual([0, 2, 1].map((i) => d[i]?.key ?? -1));
    expect(change(d, { act: "move", i: 0, d: -1 })).toBe(d);
    expect(change(d, { act: "move", i: 2, d: 1 })).toBe(d);
    // A new profile saves at once, so it starts valid: a review profile with 100 turns, documentation and language checks on, and the default run setup.
    const fresh = change(d, { act: "add" });
    expect(fresh.at(-1)).toMatchObject({
      id: "new-profile",
      name: "New profile",
      prompt: NEW_PROMPT,
      explain: false,
      docs: true,
      languageChecks: true,
      maxTurns: "100",
      model: "",
      effort: "",
      reviewer: { model: "", effort: "", mode: "auto" },
    });
    expect(allValid(fresh)).toBe(true);
  });

  test("focus keeps the place after each change", () => {
    expect(focusAfter({ act: "add" }, 4)).toBe(profileId(3, "name"));
    expect(focusAfter({ act: "remove", i: 2 }, 2)).toBe(profileId(1, "remove"));
    expect(focusAfter({ act: "remove", i: 0 }, 2)).toBe(profileId(0, "remove"));
    // One profile is left, and its remove button is disabled.
    expect(focusAfter({ act: "remove", i: 0 }, 1)).toBe(ADD_ID);
    expect(focusAfter({ act: "move", i: 2, d: -1 }, 3)).toBe(profileId(1, "up"));
    expect(focusAfter({ act: "move", i: 1, d: -1 }, 3)).toBe(profileId(0, "down"));
    expect(focusAfter({ act: "move", i: 1, d: 1 }, 3)).toBe(profileId(2, "up"));
    expect(focusAfter({ act: "edit", i: 0, patch: {} }, 3)).toBeNull();
  });

  test("problems read as text", () => {
    const [base] = toDrafts([p("general", "General")]) as [Draft];
    expect(problems(base)).toEqual({});
    expect(problems({ ...base, name: "  ", prompt: "", maxTurns: "" })).toEqual({
      name: "Enter a name.",
      prompt: "Enter a prompt.",
      maxTurns: "Enter a turn cap from 2 to 200.",
    });
    expect(problems({ ...base, name: "n".repeat(61) }).name).toBe("Use 60 characters or fewer for the name.");
    expect(problems({ ...base, note: "n".repeat(201) }).note).toBe("Use 200 characters or fewer for the note.");
    expect(problems({ ...base, prompt: "p".repeat(MAX_NOTE + 1) }).prompt).toBe("Use 20,000 characters or fewer for the prompt.");
  });

  test("the client accepts exactly what the server schema accepts", () => {
    const [base] = toDrafts([p("general", "General")]) as [Draft];
    const cases: Partial<Draft>[] = [
      {},
      { name: "" },
      { name: "   " },
      { name: ` ${"n".repeat(60)} ` },
      { name: "n".repeat(61) },
      { note: "" },
      { note: ` ${"n".repeat(200)} ` },
      { note: "n".repeat(201) },
      { prompt: " \n " },
      { prompt: "p".repeat(MAX_NOTE) },
      { prompt: "p".repeat(MAX_NOTE + 1) },
      ...["1", "2", "200", "201", "2.5", "", " 12 ", "abc", "-3", "1e2"].map((maxTurns) => ({ maxTurns })),
      ...MODELS.map((model) => ({ model })),
      ...MODELS.map((model) => ({ reviewer: { model, effort: "" as const, mode: "always" as const } })),
      { effort: "xhigh" as const },
      { reviewer: { model: "", effort: "max" as const, mode: "off" as const } },
    ];
    for (const c of cases) {
      const d = { ...base, ...c };
      expect([c, allValid([d])]).toEqual([c, profileList.safeParse(toProfiles([d])).success]);
    }
    expect(allValid([])).toBe(profileList.safeParse([]).success);
  });

  test("dirty compares the saved form: trimmed text, numbers, and order", () => {
    const d = toDrafts(SAVED);
    const dirty = (list: Draft[]) => !sameProfiles(toProfiles(list), SAVED);
    expect(dirty(d)).toBe(false);
    expect(dirty(change(d, { act: "edit", i: 0, patch: { name: " General  " } }))).toBe(false);
    expect(dirty(change(d, { act: "edit", i: 0, patch: { maxTurns: "040" } }))).toBe(false);
    expect(dirty(change(d, { act: "edit", i: 0, patch: { docs: false } }))).toBe(true);
    expect(dirty(change(d, { act: "edit", i: 0, patch: { languageChecks: true } }))).toBe(true);
    expect(dirty(change(d, { act: "edit", i: 2, patch: { prompt: "Other." } }))).toBe(true);
    const moved = change(d, { act: "move", i: 0, d: 1 });
    expect(dirty(moved)).toBe(true);
    expect(dirty(change(moved, { act: "move", i: 1, d: -1 }))).toBe(false);
    expect(dirty(change(d, { act: "remove", i: 1 }))).toBe(true);
    expect(dirty(change(d, { act: "add" }))).toBe(true);
    const picked = change(d, { act: "edit", i: 0, patch: { skills: toggleSkill([], "p:x", true) } });
    expect(dirty(picked)).toBe(true);
    expect(toProfiles(picked)[0]?.skills).toEqual(["p:x"]);
    expect(dirty(change(picked, { act: "edit", i: 0, patch: { skills: toggleSkill(["p:x"], "p:x", false) } }))).toBe(false);
  });

  test("an Always use mark saves, and a skill that leaves the list (toggle or Clear) loses its mark", () => {
    const d = toDrafts(SAVED);
    const dirty = (list: Draft[]) => !sameProfiles(toProfiles(list), SAVED);
    const picked = change(d, { act: "edit", i: 0, patch: skillsPatch(d[0] as Draft, ["a", "b"]) });
    const marked = change(picked, { act: "edit", i: 0, patch: { alwaysSkills: toggleSkill([], "b", true) } });
    expect(dirty(marked)).toBe(true);
    expect(toProfiles(marked)[0]).toMatchObject({ skills: ["a", "b"], alwaysSkills: ["b"] });
    expect(profileInput.safeParse(toProfiles(marked)[0]).success).toBe(true);
    const untoggled = change(marked, { act: "edit", i: 0, patch: skillsPatch(marked[0] as Draft, toggleSkill(["a", "b"], "b", false)) });
    expect(toProfiles(untoggled)[0]).toMatchObject({ skills: ["a"], alwaysSkills: [] });
    const cleared = change(marked, { act: "edit", i: 0, patch: skillsPatch(marked[0] as Draft, []) });
    expect(dirty(cleared)).toBe(false);
    // A stale mark never reaches the server.
    const stale = change(marked, { act: "edit", i: 0, patch: { skills: ["a"] } });
    expect(toProfiles(stale)[0]?.alwaysSkills).toEqual([]);
  });

  test("toggleSkill adds at the end once and removes every copy", () => {
    expect(toggleSkill(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleSkill(["a", "b"], "a", true)).toEqual(["a", "b"]);
    expect(toggleSkill(["a", "b"], "a", false)).toEqual(["b"]);
  });

  test("a blocked tool cannot be ticked; an unmarked tool asks first; any tool unticks", () => {
    expect(tickAction("readOnly", true)).toBe("set");
    expect(tickAction("unmarked", true)).toBe("confirm");
    expect(tickAction("blocked", true)).toBe("none");
    for (const s of ["readOnly", "unmarked", "blocked"] as const) expect(tickAction(s, false)).toBe("set");
    expect(unmarkedQuestion("ctx_execute", "context-mode:context-mode")).toBe(
      "ctx_execute on context-mode:context-mode has no read-only mark. PR Review Inbox cannot check what it does. Allow it in runs of this profile?",
    );
  });

  test("toggleServer and setTools keep the pick order; a tool edit marks the profile dirty", () => {
    const one = toggleServer([], "a", true, ["x"]);
    expect(toggleServer(one, "a", true)).toBe(one);
    const two = toggleServer(one, "b", true);
    expect(two).toEqual([
      { server: "a", tools: ["x"] },
      { server: "b", tools: [] },
    ]);
    expect(setTools(two, "b", ["y"])).toEqual([
      { server: "a", tools: ["x"] },
      { server: "b", tools: ["y"] },
    ]);
    expect(toggleServer(two, "a", false)).toEqual([{ server: "b", tools: [] }]);
    const d = toDrafts(SAVED);
    const dirty = (l: Draft[]) => !sameProfiles(toProfiles(l), SAVED);
    const picked = change(d, { act: "edit", i: 0, patch: { mcp: one } });
    expect(dirty(picked)).toBe(true);
    expect(toProfiles(picked)[0]?.mcp).toEqual(one);
    expect(dirty(change(picked, { act: "edit", i: 0, patch: { mcp: [] } }))).toBe(false);
  });

  test("copy gives every other profile the skills, the Always use marks, and the MCP picks with their tools", () => {
    const mcp = [
      { server: "docs", tools: ["search", "lookup"] },
      { server: "p:graph", tools: ["explore"] },
    ];
    // A stale mark of the source never reaches a target. The Explain profile also takes skills and MCP servers.
    const from = { skills: ["a", "p:b"], alwaysSkills: ["p:b", "gone"], mcp };
    const d = toDrafts([
      p("general", "General", { languageChecks: true, model: "opus" }),
      p("security", "Security", { skills: ["c"], alwaysSkills: ["c"], mcp: [{ server: "old", tools: ["x"] }] }),
      p("explain", "Explain", { explain: true }),
      p("same", "Same", { skills: ["a", "p:b"], alwaysSkills: ["p:b"], mcp }),
    ]);
    const edited = change(d, { act: "edit", i: 0, patch: from });
    expect(copyTargets(edited, 0)).toEqual([1, 2]);
    const copied = change(edited, { act: "copy", i: 0 });
    expect(copied[0]).toBe(edited[0]);
    expect(copied[3]).toBe(edited[3]);
    const out = toProfiles(copied);
    for (const t of out.slice(1)) expect(t).toMatchObject({ skills: ["a", "p:b"], alwaysSkills: ["p:b"], mcp });
    expect(profileList.safeParse(out).success).toBe(true);
    // Only the picks change. The targets get their own lists, so a later tool edit of one profile leaves the others.
    expect(out[1]).toEqual({ ...toProfiles(edited)[1], skills: ["a", "p:b"], alwaysSkills: ["p:b"], mcp } as ProfileInput);
    expect(out[2]?.explain).toBe(true);
    expect(copied[1]?.mcp[0]?.tools).not.toBe(edited[0]?.mcp[0]?.tools);
    const later = change(copied, { act: "edit", i: 1, patch: { mcp: setTools(copied[1]?.mcp ?? [], "docs", ["search"]) } });
    expect(later[2]?.mcp[0]?.tools).toEqual(["search", "lookup"]);
    // Nothing to copy: the same list, so no save starts.
    expect(copyTargets(copied, 0)).toEqual([]);
    expect(change(copied, { act: "copy", i: 0 })).toBe(copied);
    // An empty setup clears the picks of the others.
    const cleared = toProfiles(
      change(change(copied, { act: "edit", i: 0, patch: { skills: [], alwaysSkills: [], mcp: [] } }), { act: "copy", i: 0 }),
    );
    for (const t of cleared) expect(t).toMatchObject({ skills: [], alwaysSkills: [], mcp: [] });
    expect(setupSummary(copied[0] as Draft, "General")).toBe("General has 2 skills and 2 MCP servers.");
    expect(setupSummary(toDrafts([p("x", "X", { skills: ["a"] })])[0] as Draft, "X")).toBe("X has 1 skill and no MCP servers.");
    expect(copiedText("General", 1)).toBe("Saved. 1 profile got the skills and MCP servers of General.");
    expect(copiedText("General", 3)).toBe("Saved. 3 profiles got the skills and MCP servers of General.");
  });

  test("the limits match the shared request schema", () => {
    expect(LIMITS.profiles).toBe(MAX_PROFILES);
    expect(LIMITS.prompt).toBe(MAX_NOTE);
    const ok = (o: Partial<ProfileInput>) => profileInput.safeParse(p("x", "X", o)).success;
    expect(ok({ id: "a".repeat(LIMITS.id) })).toBe(true);
    expect(ok({ id: "a".repeat(LIMITS.id + 1) })).toBe(false);
    expect(ok({ name: "n".repeat(LIMITS.name) })).toBe(true);
    expect(ok({ name: "n".repeat(LIMITS.name + 1) })).toBe(false);
    expect(ok({ note: "n".repeat(LIMITS.note) })).toBe(true);
    expect(ok({ note: "n".repeat(LIMITS.note + 1) })).toBe(false);
    expect(ok({ maxTurns: LIMITS.minTurns })).toBe(true);
    expect(ok({ maxTurns: LIMITS.minTurns - 1 })).toBe(false);
    expect(ok({ maxTurns: LIMITS.maxTurns })).toBe(true);
    expect(ok({ maxTurns: LIMITS.maxTurns + 1 })).toBe(false);
    expect(LIMITS.skills).toBe(200);
    expect(ok({ skills: Array.from({ length: LIMITS.skills }, (_, i) => `s${i}`) })).toBe(true);
    expect(ok({ skills: Array.from({ length: LIMITS.skills + 1 }, (_, i) => `s${i}`) })).toBe(false);
    const servers = (n: number) => Array.from({ length: n }, (_, i) => ({ server: `s${i}`, tools: [] }));
    expect(ok({ mcp: servers(LIMITS.mcp) })).toBe(true);
    expect(ok({ mcp: servers(LIMITS.mcp + 1) })).toBe(false);
    const tools = (n: number) => [{ server: "s", tools: Array.from({ length: n }, (_, i) => `t${i}`) }];
    expect(ok({ mcp: tools(LIMITS.mcpTools) })).toBe(true);
    expect(ok({ mcp: tools(LIMITS.mcpTools + 1) })).toBe(false);
  });
});

describe("autosave payload", () => {
  test("a field with a problem keeps its saved value; the other fields of the change still go", () => {
    const d = toDrafts(SAVED);
    const edited = change(change(d, { act: "edit", i: 0, patch: { name: "  ", note: "New note", maxTurns: "abc" } }), {
      act: "edit",
      i: 1,
      patch: { model: "bad model", effort: "high", reviewer: { model: "a b", effort: "low", mode: "always" } },
    });
    const out = toPayload(edited, SAVED);
    expect(out[0]).toMatchObject({ id: "general", name: "General", note: "New note", maxTurns: 40 });
    expect(out[1]).toMatchObject({ id: "security", model: null, effort: "high", reviewer: { model: null, effort: "low", mode: "always" } });
    expect(profileList.safeParse(out).success).toBe(true);
    // Nothing valid changed: the payload equals the saved list, so no request goes out.
    const invalidOnly = change(d, { act: "edit", i: 0, patch: { name: "" } });
    expect(sameProfiles(toPayload(invalidOnly, SAVED), SAVED)).toBe(true);
  });

  test("a new profile without a saved copy falls back to the new-profile values", () => {
    const d = change(toDrafts(SAVED), { act: "add" });
    const broken = change(d, { act: "edit", i: 3, patch: { name: "", prompt: " ", maxTurns: "1", note: "Kept" } });
    expect(toPayload(broken, SAVED)[3]).toMatchObject({
      id: "new-profile",
      name: "New profile",
      prompt: NEW_PROMPT,
      maxTurns: 100,
      note: "Kept",
    });
    expect(profileList.safeParse(toPayload(broken, SAVED)).success).toBe(true);
  });

  test("model text: empty for the default, an alias, or another ID", () => {
    const aliases = ["opus", "sonnet", "haiku"];
    expect(modelChoice("", aliases)).toBe("");
    expect(modelChoice(" opus ", aliases)).toBe("opus");
    expect(modelChoice("haiku", aliases)).toBe("haiku");
    expect(modelChoice("claude-opus-5-5", aliases)).toBe("other");
    expect(modelChoice("opus", [])).toBe("other");
    expect(toProfiles(toDrafts([p("x", "X", { model: "sonnet", effort: "max" })]))[0]).toMatchObject({ model: "sonnet", effort: "max" });
    const cleared = change(toDrafts([p("x", "X", { model: "sonnet", effort: "max" })]), {
      act: "edit",
      i: 0,
      patch: { model: "  ", effort: "" },
    });
    expect(toProfiles(cleared)[0]).toMatchObject({ model: null, effort: null });
  });
});

describe("pickers", () => {
  test("Select all of skills adds the missing IDs in order and stops at the limit", () => {
    expect(addSkills(["b"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    const many = Array.from({ length: LIMITS.skills + 5 }, (_, i) => `s${i}`);
    expect(addSkills([], many)).toHaveLength(LIMITS.skills);
  });

  test("Select all of a server ticks the read-only tools at once, asks once for the unmarked ones, and never ticks a blocked one", () => {
    const tools = [
      { name: "search", safety: "readOnly" as const },
      { name: "note", safety: "unmarked" as const },
      { name: "drop", safety: "blocked" as const },
      { name: "lookup", safety: "readOnly" as const },
      { name: "tag", safety: "unmarked" as const },
    ];
    const r = selectAll(["tag"], tools);
    expect(r.tools).toEqual(["tag", "search", "lookup"]);
    expect(r.unmarked).toEqual(["note"]);
    expect(r.withUnmarked).toEqual(["tag", "search", "lookup", "note"]);
    expect(r.withUnmarked).not.toContain("drop");
    expect(selectAll([], tools.slice(0, 1)).unmarked).toEqual([]);
    const lots = Array.from({ length: LIMITS.mcpTools + 3 }, (_, i) => ({ name: `t${i}`, safety: "readOnly" as const }));
    expect(selectAll([], lots).tools).toHaveLength(LIMITS.mcpTools);
    expect(unmarkedListQuestion(["a"], "s")).toBe(unmarkedQuestion("a", "s"));
    expect(unmarkedListQuestion(["a", "b"], "s")).toBe(
      "These 2 tools on s have no read-only mark: a, b. PR Review Inbox cannot check what they do. Allow them in runs of this profile?",
    );
  });
});

describe("the no flag choice", () => {
  test("names the value from the runner settings, and its source when the precedence is not documented", () => {
    expect(defaultChoice(null)).toBe("Use my default");
    expect(defaultChoice(undefined)).toBe("Use my default");
    expect(defaultChoice({ value: "xhigh", sure: true })).toBe("Use my default (xhigh)");
    expect(defaultChoice({ value: "low", sure: false })).toBe("Use my default (low, from your settings)");
  });
});
