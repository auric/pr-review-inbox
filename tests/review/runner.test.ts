// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRunner, type RunnerOptions, type RunSpec } from "../../src/server/review/claude";
import { classify, createStreamParser, NOTES_MAX } from "../../src/server/review/stream";
import type { RunEvent } from "../../src/shared/run-log";
import { type FakeScenario, readRecords } from "../support/fake-claude";

const FAKE = join(import.meta.dir, "../support/fake-claude.ts");
const REAL = join(import.meta.dir, "../../fixtures/claude");
const SYNTHETIC = join(import.meta.dir, "../../fixtures/claude-synthetic");
const SCHEMA = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false };
const DERIVED = mkdtempSync(join(tmpdir(), "rl-wp8-fixtures-"));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => rmSync(DERIVED, { recursive: true, force: true }));

const real = (name: string) => join(REAL, name);
const encoded = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

// A real fixture with one patch per event. The file says which fixture it came from.
function derive(name: string, patch: (e: Record<string, unknown>) => Record<string, unknown>) {
  const out = readFileSync(real(name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.stringify(patch(JSON.parse(l))));
  const f = join(DERIVED, `derived-${name}`);
  writeFileSync(f, `${out.join("\n")}\n`);
  return f;
}
// b6 is a flat run without --json-schema. The patch adds the structured_output that a schema run sends.
const flatSuccess = () =>
  derive("b6-hostile-repo.jsonl", (e) => (e.type === "result" ? { ...e, structured_output: { summary: "ok" } } : e));

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(20);
  return pred();
}

type Call = { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; pid: number; childPid?: number };

function setup(scenario: Partial<FakeScenario> = {}, opts: RunnerOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), "rl-wp8-"));
  dirs.push(base);
  const work = join(base, "work");
  const app = join(base, "app");
  mkdirSync(work);
  const projects = join(base, "config", "projects");
  const record = join(base, "record.jsonl");
  const s: FakeScenario = {
    record,
    auth: {
      loggedIn: true,
      authMethod: "claude.ai",
      email: "someone@example.test",
      configDirectory: join(base, "config"),
      projectsDirectory: projects,
    },
    ...scenario,
  };
  const scenarioFile = join(base, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify(s));
  const runner = createClaudeRunner({ command: [process.execPath, FAKE, scenarioFile], ...opts });
  const spec: RunSpec = {
    cwd: work,
    appDir: app,
    prompt: "Review the change from the merge base to the head.",
    schema: SCHEMA,
    maxTurns: 40,
    main: { description: "Main thread.", prompt: "You coordinate review agents." },
    agents: { "rl-reviewer": { description: "Read-only reviewer.", prompt: "You are a read-only reviewer." } },
    mcpServers: { "rl-stub": { command: "bun", args: ["stub.ts"], tools: ["get_fact"] } },
  };
  const calls = (): Call[] => readRecords(record);
  return { base, work, app, projects, runner, spec, calls };
}

const byId = (events: RunEvent[], id: string) => events.find((e) => e.id === id);

describe("outcomes", () => {
  test("flat success: one level, relative targets, structured output", async () => {
    const { runner, spec } = setup({ fixture: flatSuccess() });
    const seen: RunEvent[] = [];
    const o = await runner.run(spec, (ev) => seen.push(...ev));
    expect(o.status).toBe("completed");
    expect(o.kind).toBeNull();
    expect(o.result?.structured_output).toEqual({ summary: "ok" });
    expect(o.init?.claude_code_version).toBe("2.1.295");
    expect(o.events.map((e) => [e.parent, e.tool, e.target, e.status])).toEqual([[null, "Glob", "**/* in repo", "ok"]]);
    expect(seen.map((e) => e.status)).toEqual(["running", "ok"]);
  });

  test("subagent tree: parent from parent_tool_use_id, task events end the agent", async () => {
    const { runner, spec } = setup({ fixture: real("b9-wp8-flags.jsonl") });
    const seen: RunEvent[] = [];
    const o = await runner.run(spec, (ev) => seen.push(...ev));
    expect(o.status).toBe("completed");
    expect(o.result?.structured_output).toEqual({ mainWord: "MAGNOLIA", reviewerWord: "JUNIPER", fact: "STUBFACT-5150" });

    const agent = byId(o.events, "toolu_01LSbcECPmHiTBS4CDvWoCbj");
    expect(agent).toMatchObject({ parent: null, tool: "Agent", agent: "rl-reviewer", target: "Run rl-reviewer step list", status: "ok" });
    expect(agent?.note).toStartWith("1. Read note-reviewer.txt: succeeded.");
    const secret = "C:/Users/user/AppData/Local/Temp/rl-gb-b9-ByCyyZ/app/secret.txt";
    expect(o.events.filter((e) => e.parent === agent?.id).map((e) => [e.tool, e.target, e.status])).toEqual([
      ["Read", "note-reviewer.txt", "ok"],
      ["Read", secret, "error"],
      ["mcp__rl-stub__get_fact", "", "ok"],
    ]);
    expect(o.events.filter((e) => e.parent === null && e.tool !== "Agent").map((e) => [e.tool, e.target, e.status])).toEqual([
      ["Read", "note-main.txt", "ok"],
      ["Read", secret, "error"],
      ["mcp__rl-stub__get_fact", "", "ok"],
      ["Write", "write-canary.txt", "error"],
      ["Edit", "note-main.txt", "error"],
    ]);
    const refused = o.events.find((e) => e.agent === "general-purpose");
    expect(refused?.status).toBe("error");
    expect(refused?.note).toBe("Agent type 'general-purpose' not found. Available agents: rl-reviewer");
    expect(o.events.find((e) => e.tool === "Write")?.note).toStartWith("Error: No such tool available: Write.");
    expect(o.events.some((e) => e.tool === "StructuredOutput")).toBe(false);
    expect(o.events.every((e) => e.endedAt !== null)).toBe(true);
    expect([...new Set(seen.filter((e) => e.id === agent?.id).map((e) => e.status))]).toEqual(["running", "ok"]);
  });

  test("subagent stats: model, tokens, and the built-in mark come from the stream", async () => {
    const { runner, spec } = setup({ fixture: real("b9-wp8-flags.jsonl") });
    const seen: RunEvent[] = [];
    const o = await runner.run(spec, (ev) => seen.push(...ev));
    const id = "toolu_01LSbcECPmHiTBS4CDvWoCbj";
    // The first subagent message names the model. task_progress raises the tokens. The tool result gives totalTokens.
    expect(byId(o.events, id)).toMatchObject({ agent: "rl-reviewer", model: "claude-haiku-5-5", tokens: 5382, builtin: false });
    const live = seen.filter((e) => e.id === id).map((e) => [e.status, e.model, e.tokens]);
    expect(live[0]).toEqual(["running", null, null]);
    expect(live).toContainEqual(["running", "claude-haiku-5-5", 4413]);
    expect(live.at(-1)).toEqual(["ok", "claude-haiku-5-5", 5382]);
    // The run defined only rl-reviewer. The refused calls of other agents are marked built-in.
    expect(o.events.filter((e) => e.tool === "Agent").map((e) => [e.agent, e.builtin])).toEqual([
      ["general-purpose", true],
      ["user-agent-5", true],
      ["rl-reviewer", false],
    ]);
    expect(o.events.filter((e) => e.tool !== "Agent").every((e) => e.model === null && e.tokens === null && !e.builtin)).toBe(true);
  });

  test("two result events: the final one with structured_output wins; a background agent ends at its notification", async () => {
    const { runner, spec } = setup({ fixture: real("b3-default.jsonl") });
    const o = await runner.run(spec);
    expect(o.status).toBe("completed");
    expect((o.result?.structured_output as { answer?: string } | undefined)?.answer).toStartWith("No word available.");
    expect(o.result?.origin?.kind).toBe("task-notification");
    const agent = byId(o.events, "toolu_012D82eht13YtSvEVwCqV89Z");
    expect(agent?.status).toBe("ok");
    expect(agent?.note).toStartWith("Read of `");
    expect(o.events.filter((e) => e.parent === agent?.id).map((e) => [e.tool, e.target, e.status])).toEqual([
      ["Read", "note.txt", "error"],
    ]);
    // A background agent: resolvedModel at launch, the tokens at its notification.
    expect(agent).toMatchObject({ model: "claude-haiku-5-5", tokens: 4601 });
  });

  test("max turns", async () => {
    const { runner, spec } = setup({ fixture: real("b5-max-turns.jsonl"), exitCode: 1 });
    const o = await runner.run(spec);
    expect(o).toMatchObject({ status: "failed", kind: "max_turns", text: "Reached maximum number of turns (1)", exitCode: 1 });
    expect(o.events.map((e) => [e.tool, e.target, e.status])).toEqual([["Read", "a.txt", "error"]]);
  });

  test("auth failure in the stream (Gate B5)", async () => {
    const { runner, spec } = setup({ fixture: real("b5-auth.jsonl"), exitCode: 1 });
    const o = await runner.run(spec);
    expect(o).toMatchObject({ status: "failed", kind: "auth", text: "Not logged in · Please run /login" });
  });

  test("usage limit (synthetic fixture, shape not verified)", async () => {
    const { runner, spec } = setup({ fixture: join(SYNTHETIC, "usage-limit.jsonl"), exitCode: 1 });
    const o = await runner.run(spec);
    expect(o).toMatchObject({ status: "failed", kind: "usage_limit", text: "Usage limit reached. Your limit resets at 6pm." });
  });

  test("schema failure: a success without structured_output (Gate B9 first try)", async () => {
    const { runner, spec } = setup({ fixture: real("b9-first-try.jsonl") });
    const o = await runner.run(spec);
    expect(o).toMatchObject({ status: "failed", kind: "schema", text: "The result has no structured output." });
    expect(o.result?.subtype).toBe("success");
  });

  test("schema failure: the CLI used up its structured output retries", () => {
    const p = createStreamParser({ cwd: "/w", allowedTools: new Set() });
    p.line(
      JSON.stringify({
        type: "result",
        subtype: "error_max_structured_output_retries",
        is_error: true,
        errors: ["Schema retries used up"],
      }),
    );
    expect(classify(p.state, { exitCode: 1, cancelled: false, timedOut: false })).toMatchObject({
      kind: "schema",
      text: "Schema retries used up",
    });
  });

  test("notes: rl-main text and Agent reports in order, no subagent text, no failed call", () => {
    const p = createStreamParser({ cwd: "/w", allowedTools: new Set() });
    const lines = readFileSync(join(import.meta.dir, "../../fixtures/claude-synthetic/max-turns-notes.jsonl"), "utf8");
    for (const l of lines.split("\n").filter(Boolean)) p.line(l);
    expect(p.state.notes).toEqual([
      { from: "rl-main", text: "Plan: read src/server/app.ts first. MAIN-PLAN" },
      { from: "rl-reviewer report: Review web", text: "Finding: src/server/app.ts:22 b1 is wrong. REPORT-MARK" },
      { from: "rl-main", text: "Note: web/main.ts:2 looks fine. MAIN-LAST" },
    ]);
    const q = createStreamParser({ cwd: "/w", allowedTools: new Set() });
    const use = { type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "rl-reviewer", description: "D" } };
    q.line(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [use] } }));
    q.line(
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "denied" }] },
      }),
    );
    expect(q.state.notes).toEqual([]);
  });

  test("a time limit wins over a max_turns result, so the salvage trigger never sees a timeout", () => {
    const p = createStreamParser({ cwd: "/w", allowedTools: new Set(["Task", "Read", "Grep", "Glob", "StructuredOutput"]) });
    const lines = readFileSync(join(import.meta.dir, "../../fixtures/claude-synthetic/max-turns-notes.jsonl"), "utf8");
    for (const l of lines.split("\n").filter(Boolean)) p.line(l);
    expect(classify(p.state, { exitCode: 1, cancelled: false, timedOut: false }).kind).toBe("max_turns");
    expect(classify(p.state, { exitCode: null, cancelled: false, timedOut: true }).kind).toBe("process");
    expect(classify(p.state, { exitCode: null, cancelled: true, timedOut: false }).status).toBe("cancelled");
  });

  test("notes: over NOTES_MAX characters, the oldest notes go first", () => {
    const p = createStreamParser({ cwd: "/w", allowedTools: new Set() });
    const say = (text: string) =>
      p.line(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }));
    const big = Math.floor(NOTES_MAX / 3);
    for (const c of ["a", "b", "c", "d"]) say(c.repeat(big));
    expect(p.state.notes.map((n) => n.text[0])).toEqual(["b", "c", "d"]);
    say("e".repeat(NOTES_MAX + 10));
    expect(p.state.notes).toEqual([{ from: "rl-main", text: "e".repeat(NOTES_MAX) }]);
  });

  test("no result event: process error with the stderr tail", async () => {
    const fixture = derive("b6-hostile-repo.jsonl", (e) => (e.type === "result" ? { type: "noise" } : e));
    const { runner, spec } = setup({ fixture, exitCode: 3, stderr: "boom\n" });
    const o = await runner.run(spec);
    expect(o).toMatchObject({
      status: "failed",
      kind: "process",
      text: "claude exited with code 3 and sent no result.",
      stderrTail: "boom\n",
    });
  });
});

describe("safety", () => {
  test("init tool check kills the run before any tool use", async () => {
    const { runner, spec, calls } = setup({ fixture: real("b8-plain.jsonl"), delayMs: 30 });
    const seen: RunEvent[] = [];
    const o = await runner.run(spec, (ev) => seen.push(...ev));
    expect(o.status).toBe("failed");
    expect(o.kind).toBe("tool_check");
    expect(o.text).toContain("Edit");
    expect(o.text).toContain("Write");
    expect(o.text).not.toContain("Read,");
    expect(o.events).toEqual([]);
    expect(seen).toEqual([]);
    const pid = calls().at(-1)?.pid ?? 0;
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  test("auth refusal before spawn logs only authMethod", async () => {
    const logs = spyOn(console, "log");
    try {
      const { runner, spec, calls } = setup({ auth: { loggedIn: true, authMethod: "api_key", email: "someone@example.test" } });
      const o = await runner.run(spec);
      expect(o).toMatchObject({ status: "failed", kind: "auth" });
      expect(calls().map((c) => c.argv)).toEqual([["--version"], ["auth", "status"]]);
      const lines = logs.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain("claude auth status: authMethod=api_key");
      expect(lines.some((l) => l.includes("someone@example.test"))).toBe(false);
    } finally {
      logs.mockRestore();
    }
  });

  test("a logged-out CLI is refused before spawn", async () => {
    const { runner, spec, calls } = setup({ auth: { loggedIn: false }, authExit: 1 });
    expect(await runner.run(spec)).toMatchObject({ status: "failed", kind: "auth" });
    expect(calls().some((c) => c.argv.includes("-p"))).toBe(false);
  });

  test("a CLI older than the Gate B version is unavailable", async () => {
    const { runner, spec, calls } = setup({ version: "2.1.294 (Claude Code)" });
    expect(await runner.check()).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await runner.run(spec)).toMatchObject({ status: "failed", kind: "process" });
    expect(calls().every((c) => c.argv[0] === "--version")).toBe(true);
  });

  test.skipIf(process.platform !== "win32")("a .cmd claude is refused", async () => {
    const { base } = setup();
    const runner = createClaudeRunner({ command: [join(base, "claude.cmd")] });
    expect(await runner.check()).toMatchObject({ ok: false, kind: "unavailable", message: "claude.cmd is not the native claude.exe." });
  });

  test("scrubbed env: no API key, no nested-session markers, no Bun or Node runtime flags, background tasks off", async () => {
    const set = {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_AUTH_TOKEN: "test-token",
      CLAUDECODE: "1",
      CLAUDE_PID: "4242",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SOMETHING: "x",
      BUN_BE_BUN: "1",
      BUN_OPTIONS: "--smol",
      NODE_OPTIONS: "--inspect",
      RL_KEEP_ME: "kept",
    };
    const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    Object.assign(process.env, set);
    try {
      const { runner, spec, calls } = setup({ fixture: flatSuccess() });
      expect((await runner.run(spec)).status).toBe("completed");
      expect(calls()).toHaveLength(3);
      for (const c of calls()) {
        const keys = Object.keys(c.env).map((k) => k.toUpperCase());
        for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_PID"]) expect(keys).not.toContain(k);
        for (const k of ["BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS"]) expect(keys).not.toContain(k);
        expect(keys.filter((k) => k.startsWith("CLAUDE_CODE_"))).toEqual(["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]);
        expect(c.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
        expect(c.env.RL_KEEP_ME).toBe("kept");
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("exact flags, no --bare, prompt on stdin, agents and MCP files", async () => {
    const { runner, spec, app, calls } = setup({ fixture: flatSuccess() });
    await runner.run(spec);
    const [version, auth, run] = calls();
    expect(version?.argv).toEqual(["--version"]);
    expect(auth?.argv).toEqual(["auth", "status"]);
    expect(run?.argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config",
      join(app, "mcp.json"),
      "--tools",
      "Read,Grep,Glob,Agent",
      "--allowedTools",
      "Read,Grep,Glob,mcp__rl-stub",
      "--agents",
      join(app, "agents.json"),
      "--agent",
      "rl-main",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--max-turns",
      "40",
      "--no-session-persistence",
    ]);
    for (const c of calls()) {
      expect(c.argv).not.toContain("--bare");
      expect(c.argv).not.toContain("--permission-mode");
    }
    expect(run?.stdin).toBe(spec.prompt);
    expect(JSON.parse(readFileSync(join(app, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { "rl-stub": { command: "bun", args: ["stub.ts"] } },
    });
    expect(JSON.parse(readFileSync(join(app, "agents.json"), "utf8"))).toEqual({
      "rl-main": {
        description: "Main thread.",
        prompt: "You coordinate review agents.",
        tools: ["Agent(rl-reviewer)", "Read", "Grep", "Glob", "mcp__rl-stub__get_fact", "StructuredOutput"],
      },
      "rl-reviewer": {
        description: "Read-only reviewer.",
        prompt: "You are a read-only reviewer.",
        tools: ["Read", "Grep", "Glob", "mcp__rl-stub__get_fact"],
        disallowedTools: ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit", "Agent"],
        omitClaudeMd: true,
      },
    });
  });

  test("--model and --effort go out only when set; the review agent gets its own model and effort fields", async () => {
    const { runner, spec, app, calls } = setup({ fixture: flatSuccess() });
    await runner.run({ ...spec, model: null, effort: null });
    const plain = calls().at(-1)?.argv ?? [];
    expect(plain).not.toContain("--model");
    expect(plain).not.toContain("--effort");
    const reviewer = spec.agents["rl-reviewer"] as RunSpec["main"];
    await runner.run({
      ...spec,
      model: "claude-opus-5-5",
      effort: "xhigh",
      agents: { "rl-reviewer": { ...reviewer, model: "haiku", effort: "low" } },
    });
    const argv = calls().at(-1)?.argv ?? [];
    expect(argv.slice(argv.indexOf("--max-turns"))).toEqual([
      "--max-turns",
      "40",
      "--model",
      "claude-opus-5-5",
      "--effort",
      "xhigh",
      "--no-session-persistence",
    ]);
    const agents = JSON.parse(readFileSync(join(app, "agents.json"), "utf8"));
    expect(agents["rl-reviewer"]).toMatchObject({ model: "haiku", effort: "low", omitClaudeMd: true });
    expect(agents["rl-main"]).not.toHaveProperty("model");
    expect(agents["rl-main"]).not.toHaveProperty("effort");
    // A value that could read as a flag, or an effort that the CLI does not know, never reaches the command line.
    const before = calls().length;
    await expect(runner.run({ ...spec, model: "--bare" })).rejects.toThrow("Invalid model name");
    await expect(runner.run({ ...spec, effort: "turbo" as RunSpec["effort"] })).rejects.toThrow("Invalid effort");
    await expect(runner.run({ ...spec, agents: { "rl-reviewer": { ...reviewer, model: "a b" } } })).rejects.toThrow("Invalid model name");
    expect(
      calls()
        .slice(before)
        .some((c) => c.argv[0] === "-p"),
    ).toBe(false);
  });

  test("names that break the flag lists are refused", async () => {
    const { runner, spec } = setup({ fixture: flatSuccess() });
    await expect(runner.run({ ...spec, agents: { "a,b": spec.main } })).rejects.toThrow("Invalid");
    await expect(runner.run({ ...spec, agents: { "rl-main": spec.main } })).rejects.toThrow("rl-main");
  });

  test("a remote MCP server: http entry without headers, allowed by server name", async () => {
    const { runner, spec, app, calls } = setup({ fixture: flatSuccess() });
    const learn = { type: "http" as const, url: "https://learn.example.test/api/mcp", tools: ["docs_search"] };
    await runner.run({ ...spec, mcpServers: { ...spec.mcpServers, learn } });
    expect(JSON.parse(readFileSync(join(app, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { "rl-stub": { command: "bun", args: ["stub.ts"] }, learn: { type: "http", url: "https://learn.example.test/api/mcp" } },
    });
    const argv = calls()[2]?.argv ?? [];
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,mcp__rl-stub,mcp__learn");
    const agents = JSON.parse(readFileSync(join(app, "agents.json"), "utf8"));
    expect(agents["rl-main"].tools).toContain("mcp__learn__docs_search");
    expect(agents["rl-reviewer"].tools).toContain("mcp__learn__docs_search");
  });

  test("a remote MCP server without https is refused before spawn", async () => {
    const { runner, spec, calls } = setup({ fixture: flatSuccess() });
    for (const url of ["http://learn.example.test/mcp", "file:///etc/passwd", "not a url"])
      await expect(runner.run({ ...spec, mcpServers: { learn: { type: "http", url, tools: ["x"] } } })).rejects.toThrow();
    expect(calls().some((c) => c.argv[0] === "-p")).toBe(false);
  });

  test("long-path cwd", async () => {
    const { runner, spec, work, calls } = setup({ fixture: flatSuccess() });
    await runner.run(spec);
    const cwd = calls().at(-1)?.cwd;
    expect(cwd).toBe(realpathSync.native(work));
    if (work.includes("~")) expect(cwd).not.toContain("~");
  });

  test("per-cwd folders go after the run; other folders stay", async () => {
    const { base, runner, spec, work, projects } = setup({ fixture: flatSuccess() });
    const name = encoded(realpathSync.native(work));
    const mine = [join(projects, name), join(tmpdir(), "claude", name)];
    const others = [join(projects, `${name}-other`), join(tmpdir(), "claude", `${encoded(base)}-other`)];
    for (const d of others) mkdirSync(d, { recursive: true });
    try {
      let during = false;
      await runner.run(spec, () => {
        during ||= mine.every((d) => existsSync(d));
      });
      expect(during).toBe(true);
      expect(mine.filter((d) => existsSync(d))).toEqual([]);
      expect(others.filter((d) => existsSync(d))).toEqual(others);
    } finally {
      for (const d of others) rmSync(d, { recursive: true, force: true });
    }
  });

  test("cancel ends the CLI and its child, stops running events, and cleans up", async () => {
    const { runner, spec, work, projects, calls } = setup({ fixture: real("b9-wp8-flags.jsonl"), hang: true, delayMs: 20 });
    const seen: RunEvent[] = [];
    const run = runner.run(spec, (ev) => {
      seen.push(...ev);
      if (ev.some((e) => e.tool === "Agent" && e.agent === "rl-reviewer" && e.status === "running")) runner.cancel();
    });
    await expect(runner.run(spec)).rejects.toThrow("active");
    const o = await run;
    expect(o.status).toBe("cancelled");
    expect(o.kind).toBeNull();
    expect(o.events.find((e) => e.agent === "rl-reviewer")?.status).toBe("stopped");
    expect(o.events.some((e) => e.status === "running")).toBe(false);
    const run3 = calls().find((c) => c.argv.includes("-p"));
    const child = calls().find((c) => c.childPid)?.childPid;
    expect(child).toBeNumber();
    expect(await waitFor(() => !alive(run3?.pid ?? 0) && !alive(child ?? 0))).toBe(true);
    const name = encoded(realpathSync.native(work));
    expect(existsSync(join(projects, name)) || existsSync(join(tmpdir(), "claude", name))).toBe(false);
    expect(runner.cancel()).toBe(false);
  });
});
