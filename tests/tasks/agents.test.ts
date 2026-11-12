// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { KEPT_KEYS } from "../../scripts/gate/workflow";
import { SHIPPED_PROFILES } from "../../src/server/review/catalog";
import {
  type AgentFile,
  APP_RULES,
  agentInfoOf,
  buildAgentDef,
  MAX_AGENT_BYTES,
  PRESET_WORKFLOW,
  parseAgentFile,
  presetAgents,
  userAgents,
  workflowProblems,
} from "../../src/server/tasks/agents";
import { agentDef, workflow } from "../../src/shared/agents";
import { EFFORTS, modelName } from "../../src/shared/dto";
import { STEP_TURNS } from "../../src/shared/task";

const tmp = mkdtempSync(join(tmpdir(), "rl-agents-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const md = (front: string, body = "Do the work.") => `---\n${front}\n---\n${body}\n`;
const parse = (front: string, body?: string) => parseAgentFile("user", "a.md", md(front, body));
const ok = (front = "") => parse(`name: helper\ndescription: Helps.\n${front}`);
const profile = { ...(SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number]) };

describe("parseAgentFile refusals (section 3.5)", () => {
  const cases: [string, string, string?][] = [
    ["", "a.md: the file has no readable front matter. Put name and description between --- lines."],
    ["name: [x", "a.md: the file has no readable front matter. Put name and description between --- lines."],
    ["description: Helps.", 'a.md: the name "" is not valid. Use letters, digits, - and _ only, at most 64 characters.'],
    ["name: a b\ndescription: Helps.", 'a.md: the name "a b" is not valid. Use letters, digits, - and _ only, at most 64 characters.'],
    [
      `name: ${"x".repeat(65)}\ndescription: Helps.`,
      `a.md: the name "${"x".repeat(65)}" is not valid. Use letters, digits, - and _ only, at most 64 characters.`,
    ],
    ["name: rl-mine\ndescription: Helps.", "a.md: names that start with rl- belong to the app."],
    ["name: helper", "a.md: add a description. The lead picks agents by it."],
    [
      "name: helper\ndescription: Helps.\nmodel: -x",
      'a.md: the model "-x" is not a model name. Use opus, sonnet, haiku, fable, inherit, or a full model ID.',
    ],
    ["name: helper\ndescription: Helps.\neffort: ultra", 'a.md: the effort "ultra" is not valid. Use low, medium, high, xhigh, or max.'],
    ["name: helper\ndescription: Helps.", "a.md: the file has no instructions after the front matter.", ""],
  ];
  for (const [front, text, body] of cases)
    test(text, () => {
      const f = front ? parse(front, body) : parseAgentFile("user", "a.md", "No front matter.");
      expect(f.problems).toEqual([text]);
    });

  test("a private key and a file over 64 KB", () => {
    const key = ok().body.length ? parse("name: helper\ndescription: Helps.", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc") : null;
    expect(key?.problems).toEqual(["a.md: the file holds a private key. The app does not send it to Claude."]);
    const big = parseAgentFile("user", "a.md", md("name: helper\ndescription: Helps.", "x".repeat(MAX_AGENT_BYTES)));
    expect(big.problems).toEqual(["a.md: the file is over 64 KB."]);
  });

  test("notes refuse nothing: maxTurns, unknown tools, tool rules, dropped keys", () => {
    const f = ok("maxTurns: 2.5\ntools: Read, Frobnicate, Bash(npm *)\npermissionMode: bypassPermissions\ncolor: red");
    expect(f.problems).toEqual([]);
    expect(f.notes).toEqual([
      "maxTurns is not a whole number. The step limit applies.",
      "Unknown tools: Frobnicate.",
      "A tool rule such as Bash(npm *) gives no tool: Bash(npm *). Use the bare name, such as Bash. The step rules apply.",
    ]);
    expect(f.ignored).toEqual(["permissionMode", "color"]);
  });

  test("a field of another YAML type is a problem, never a throw or its String() text", () => {
    const name = (v: string) => `a.md: the name "${v}" is not valid. Use letters, digits, - and _ only, at most 64 characters.`;
    const noDescription = "a.md: add a description. The lead picks agents by it.";
    const front = (...lines: string[]) => parse(lines.join("\n"));
    expect(front("name: { a: 1 }", "description: Helps.").problems).toEqual([name("<a mapping>")]);
    expect(front("name: [helper]", "description: Helps.").problems).toEqual([name("<a list>")]);
    expect(front("name: 123", "description: Helps.").problems).toEqual([name("<a number>")]);
    expect(front("name: helper", "description: [a, b]").problems).toEqual([noDescription]);
    expect(front("name: helper", "description: { a: 1 }").problems).toEqual([noDescription]);
    expect(ok("effort: [high]").problems).toEqual(['a.md: the effort "<a list>" is not valid. Use low, medium, high, xhigh, or max.']);
    expect(ok("effort: { high: 1 }").problems).toEqual([
      'a.md: the effort "<a mapping>" is not valid. Use low, medium, high, xhigh, or max.',
    ]);
    expect(ok("model: { a: 1 }").problems).toEqual([
      'a.md: the model "<a mapping>" is not a model name. Use opus, sonnet, haiku, fable, inherit, or a full model ID.',
    ]);
  });

  test("a YAML alias tree as description and a __proto__ key", () => {
    const prev = (i: number) => (i ? `*a${i - 1}` : "*a");
    const tree = [
      "x: &a [aaaaaaaaaa, aaaaaaaaaa, aaaaaaaaaa]",
      ...Array.from({ length: 9 }, (_, i) => `x${i}: &a${i} [${prev(i)}, ${prev(i)}, ${prev(i)}]`),
    ];
    const f = parse(["name: helper", ...tree, "description: *a8"].join("\n"));
    expect(f.problems).toEqual(["a.md: add a description. The lead picks agents by it."]);
    expect(f.description).toBe("");
    const proto = parse(["__proto__:", "  name: evil", "  description: Evil.", "description: Helps."].join("\n"));
    expect(proto.name).toBe("a");
    expect(proto.problems[0]).toContain('the name "" is not valid');
    expect(proto.ignored).toContain("__proto__");
  });

  test("tool names: *, Bash(*), and lower case give no tool", () => {
    const star = ok('tools: "*"');
    expect(star.notes).toEqual(["Unknown tools: *."]);
    expect(buildAgentDef(star, { mode: "implement", shell: true }).def).toBeNull();
    const rule = ok("tools: Bash(*)");
    expect(rule.notes).toEqual([
      "A tool rule such as Bash(npm *) gives no tool: Bash(*). Use the bare name, such as Bash. The step rules apply.",
    ]);
    expect(buildAgentDef(rule, { mode: "implement", shell: true }).def).toBeNull();
    const lower = ok("tools: read, bash, edit");
    expect(lower.notes).toEqual(["Unknown tools: read, bash, edit."]);
    expect(buildAgentDef(lower, { mode: "implement", shell: true }).def).toBeNull();
  });

  test("inherit, a YAML tool list, a BOM, CRLF, and the SHA-256 of the bytes", () => {
    const text =
      "﻿---\r\nname: helper\r\ndescription: Helps.\r\nmodel: inherit\r\neffort: high\r\ntools:\r\n  - Read\r\n  - Edit\r\n---\r\nBody.\r\n";
    const f = parseAgentFile("user", "a.md", text);
    expect(f.problems).toEqual([]);
    expect(f).toMatchObject({ name: "helper", model: "inherit", effort: "high", tools: ["Read", "Edit"], body: "Body." });
    expect(f.sha256).toBe(createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"));
  });
});

describe("buildAgentDef (section 3.6)", () => {
  const all = ok(
    [
      "model: sonnet",
      "effort: low",
      "maxTurns: 500",
      "tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, Agent, mcp__x__y",
      "disallowedTools: Grep",
      "permissionMode: bypassPermissions",
      "mcpServers: { x: { command: evil } }",
      "hooks: { PreToolUse: [] }",
      "memory: user",
      "skills: [a]",
      "isolation: worktree",
      "background: true",
      "initialPrompt: hi",
      "autoCompactWindow: 5",
      "prompt: other",
    ].join("\n"),
  );

  test("only the kept keys reach agents.json, and the forced limits hold", () => {
    const { def } = buildAgentDef(all, { mode: "implement", shell: true });
    expect(Object.keys(def ?? {}).sort()).toEqual([...KEPT_KEYS].sort());
    expect(def).toMatchObject({ tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"], model: "sonnet", effort: "low" });
    expect(def?.maxTurns).toBe(STEP_TURNS.implement);
    expect(def?.omitClaudeMd).toBe(true);
    expect(def?.disallowedTools).toEqual(["Grep", "Agent", "NotebookEdit", "PowerShell", "WebFetch", "WebSearch"]);
    expect(def?.prompt).toBe(`${APP_RULES}\n\nInstructions from the agent file user:helper:\nDo the work.`);
  });

  test("the cap per kind: no shell, read-only, no tools field", () => {
    const noShell = buildAgentDef(all, { mode: "fix", shell: false });
    expect(noShell.def?.tools).toEqual(["Read", "Grep", "Glob", "Edit", "Write"]);
    expect(noShell.def?.disallowedTools).toContain("Bash");
    expect(noShell.notes).toEqual(["Agent helper cannot run commands in this step."]);
    const ro = buildAgentDef(all, { mode: "fix", shell: true, readOnly: true });
    expect(ro.def?.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(ro.def?.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Agent"]));
    const bare = buildAgentDef(ok(), { mode: "tests", shell: true });
    expect(bare.def?.tools).toEqual(["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
    expect(bare.def?.disallowedTools).toEqual(["Agent", "NotebookEdit", "PowerShell", "WebFetch", "WebSearch"]);
    expect(agentInfoOf(ok("tools: Read, Bash")).kind).toBe("commands");
  });

  test("no model or effort that the user did not set; overrides win", () => {
    const { def } = buildAgentDef(ok(), { mode: "instruct", shell: false });
    expect(def && "model" in def).toBe(false);
    expect(def && "effort" in def).toBe(false);
    const long = parse(`name: helper\ndescription: ${"d".repeat(2000)}`);
    expect(buildAgentDef(long, { mode: "fix", shell: false }).def?.description).toHaveLength(1024);
    expect(buildAgentDef(all, { mode: "fix", shell: false, model: "haiku", effort: "max" }).def).toMatchObject({
      model: "haiku",
      effort: "max",
    });
    expect(() => buildAgentDef(ok(), { mode: "fix", shell: false, model: "-bad" })).toThrow("Invalid model name");
  });

  test("maxTurns takes the smaller value; no tool leaves the agent out; a refused file throws", () => {
    expect(buildAgentDef(ok("maxTurns: 3"), { mode: "fix", shell: false }).def?.maxTurns).toBe(3);
    const bashOnly = buildAgentDef(ok("tools: Bash"), { mode: "implement", shell: false });
    expect(bashOnly.def).toBeNull();
    expect(bashOnly.notes).toEqual([
      "Agent helper cannot run commands in this step.",
      "Agent helper has no tool in this step. The app leaves it out.",
    ]);
    expect(buildAgentDef(ok("tools: Bash(npm *)"), { mode: "implement", shell: true }).def).toBeNull();
    expect(() => buildAgentDef(parse("name: helper"), { mode: "fix", shell: false })).toThrow("cannot be used");
  });
});

describe("preset and discovery", () => {
  test("the preset definitions pass the agent checks", () => {
    const files = presetAgents({ ...profile, reviewer: { ...profile.reviewer, model: "sonnet" } });
    expect(files.map((f) => f.name)).toEqual([
      "rl-implementer",
      "rl-implementer-strong",
      "rl-investigator",
      "rl-explorer",
      "rl-runner",
      "rl-planner",
    ]);
    for (const f of files) {
      expect(f.problems).toEqual([]);
      if (f.model !== null) expect(modelName.safeParse(f.model).success).toBe(true);
      if (f.effort !== null) expect(EFFORTS).toContain(f.effort);
      const { def } = buildAgentDef(f, { mode: "implement", shell: true });
      expect(agentDef.safeParse(def).success).toBe(true);
    }
    expect(files.find((f) => f.name === "rl-explorer")?.model).toBe("sonnet");
    expect(files.find((f) => f.name === "rl-runner")?.effort).toBeNull();
    expect(workflowProblems(PRESET_WORKFLOW, files)).toEqual([]);
    expect(PRESET_WORKFLOW).toMatchObject({ lead: null, leadModel: "opus", leadEffort: "high", leadEdits: true });
    expect(PRESET_WORKFLOW.agents.map((a) => a.name)).not.toContain("rl-planner");
  });

  test("userAgents reads <config>/agents/*.md, top level only, and CLAUDE_CONFIG_DIR", () => {
    const config = join(tmp, "config");
    mkdirSync(join(config, "agents", "nested"), { recursive: true });
    writeFileSync(join(config, "agents", "b.md"), md("name: beta\ndescription: B."));
    writeFileSync(join(config, "agents", "a.md"), md("name: alpha\ndescription: A."));
    writeFileSync(join(config, "agents", "notes.txt"), "x");
    writeFileSync(join(config, "agents", "nested", "c.md"), md("name: gamma\ndescription: C."));
    writeFileSync(join(config, "agents", "big.md"), "x".repeat(MAX_AGENT_BYTES + 1));
    expect(userAgents(config).map((f) => [f.file, f.name, f.problems.length])).toEqual([
      ["a.md", "alpha", 0],
      ["b.md", "beta", 0],
      ["big.md", "big", 1],
    ]);
    expect(userAgents(join(tmp, "missing"))).toEqual([]);
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      expect(userAgents().map((f) => f.name)).toEqual(["alpha", "beta", "big"]);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  test("userAgents: two files with one name both get a problem; a relative CLAUDE_CONFIG_DIR resolves against the cwd", () => {
    const config = join(tmp, "dupes");
    mkdirSync(join(config, "agents"), { recursive: true });
    writeFileSync(join(config, "agents", "one.md"), md("name: same\ndescription: A."));
    writeFileSync(join(config, "agents", "two.md"), md("name: same\ndescription: B."));
    writeFileSync(join(config, "agents", "three.md"), md("name: other\ndescription: C."));
    const dup = (file: string) => `${file}: another agent file has the name "same". Give each file its own name.`;
    expect(userAgents(config).map((f) => [f.file, f.problems])).toEqual([
      ["one.md", [dup("one.md")]],
      ["three.md", []],
      ["two.md", [dup("two.md")]],
    ]);
    const rel = relative(process.cwd(), config);
    const before = process.env.CLAUDE_CONFIG_DIR;
    const cwd = process.cwd();
    // On another drive relative() gives an absolute path. The test then runs from the temp folder.
    const from = isAbsolute(rel) ? tmp : cwd;
    process.chdir(from);
    process.env.CLAUDE_CONFIG_DIR = relative(from, config);
    try {
      expect(isAbsolute(process.env.CLAUDE_CONFIG_DIR)).toBe(false);
      expect(userAgents().map((f) => f.name)).toEqual(["same", "other", "same"]);
    } finally {
      process.chdir(cwd);
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  test("workflow save checks: clash, no agent, no writer, refused file", () => {
    const user = [ok(), { ...ok(), name: "rl-explorer" } as AgentFile, parseAgentFile("user", "bad.md", "x")];
    const files = [...presetAgents(profile), ...user];
    const w = (agents: { source: "preset" | "user"; name: string; readOnly?: boolean }[], leadEdits = false) =>
      workflow.parse({ id: "w", name: "W", agents, leadEdits });
    expect(
      workflowProblems(
        w([
          { source: "preset", name: "rl-explorer" },
          { source: "user", name: "rl-explorer" },
        ]),
        files,
      ),
    ).toContain("Two agents are named rl-explorer. Pick one.");
    expect(workflowProblems(w([]), files)).toContain("Pick at least one agent.");
    expect(workflowProblems(w([{ source: "preset", name: "rl-investigator" }]), files)).toEqual([
      "Pick an agent that writes files, or let the lead edit files.",
    ]);
    expect(workflowProblems(w([{ source: "user", name: "helper", readOnly: true }]), files)).toEqual([
      "Pick an agent that writes files, or let the lead edit files.",
    ]);
    expect(workflowProblems(w([{ source: "preset", name: "rl-investigator" }], true), files)).toEqual([]);
    expect(workflowProblems(w([{ source: "user", name: "a" }], true), files)).toEqual(["The agent a is not available."]);
    expect(workflowProblems(w([{ source: "user", name: "bad" }], true), files)).toEqual([
      "bad.md: the file has no readable front matter. Put name and description between --- lines.",
    ]);
  });
});
