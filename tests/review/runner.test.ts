// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explorerAgent, type Profile, SHIPPED_PROFILES } from "../../src/server/review/catalog";
import {
  createClaudeRunner,
  IMPLEMENT_TOOLS,
  type ImplementSpec,
  implementArgs,
  MIN_CLI_VERSION,
  RUN_MARKER,
  type RunnerOptions,
  type RunSpec,
} from "../../src/server/review/claude";
import { classify, createStreamParser, NO_BASH_TEXT, NOTES_MAX } from "../../src/server/review/stream";
import { type ShellSpec, shellSettings } from "../../src/server/tasks/shell";
import { CD_REFUSED_NOTE, type RunEvent } from "../../src/shared/run-log";
import { implementJsonSchema, SHELL_MODES } from "../../src/shared/task";
import { logTree } from "../../src/web/review/model";
import { type FakeScenario, readRecords } from "../support/fake-claude";

for (const m of ["review/claude", "review/stream", "review/catalog", "tasks/shell"])
  console.log(`runner.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

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

type Call = { argv: string[]; env: Record<string, string>; cwd: string; stdin: string; pid: number; childPid?: number; orphanPid?: number };

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

  test("a CLI older than 2.1.302 is unavailable: from 2.1.302, -p refuses each call that needs approval (V7)", async () => {
    expect(MIN_CLI_VERSION).toBe("2.1.302");
    const { runner, spec, calls } = setup({ version: "2.1.301 (Claude Code)" });
    expect(await runner.check()).toEqual({ ok: false, kind: "unavailable", message: "Claude Code 2.1.301 is older than 2.1.302." });
    expect(await runner.run(spec)).toMatchObject({ status: "failed", kind: "process" });
    expect(calls().every((c) => c.argv[0] === "--version")).toBe(true);
    const ok = setup({ version: "2.1.302 (Claude Code)" });
    expect(await ok.runner.check()).toMatchObject({ ok: true, version: "2.1.302" });
  });

  test.skipIf(process.platform !== "win32")("a .cmd claude is refused", async () => {
    const { base } = setup();
    const runner = createClaudeRunner({ command: [join(base, "claude.cmd")] });
    expect(await runner.check()).toMatchObject({ ok: false, kind: "unavailable", message: "claude.cmd is not the native claude.exe." });
  });

  test("scrubbed env: no API key, no nested-session markers, no gate tokens, no Bun or Node runtime flags, background tasks off", async () => {
    const set = {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_AUTH_TOKEN: "test-token",
      CLAUDECODE: "1",
      CLAUDE_PID: "4242",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SOMETHING: "x",
      CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe",
      GATE_BITBUCKET_TOKEN: "gate-token",
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
        for (const k of ["BUN_BE_BUN", "BUN_OPTIONS", "NODE_OPTIONS", "GATE_BITBUCKET_TOKEN"]) expect(keys).not.toContain(k);
        expect(keys.filter((k) => k.startsWith("CLAUDE_CODE_")).sort()).toEqual([
          "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
          "CLAUDE_CODE_GIT_BASH_PATH",
        ]);
        expect(c.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
        expect(c.env.CLAUDE_CODE_GIT_BASH_PATH).toBe("C:\\Git\\bin\\bash.exe");
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

  // shell.md run 2: the Job Object (Windows) or the marker scan (/proc) ends it. macOS has neither.
  test.skipIf(process.platform === "darwin")("the end of a completed run ends a process that the CLI left", async () => {
    const { runner, spec, calls } = setup({ fixture: flatSuccess(), orphan: true });
    const o = await runner.run(spec);
    expect(o.status).toBe("completed");
    const run = calls().find((c) => c.argv.includes("-p"));
    expect(run?.env[RUN_MARKER]).toMatch(/^[0-9a-f-]{36}$/);
    const orphan = calls().find((c) => c.orphanPid)?.orphanPid ?? 0;
    try {
      expect(await waitFor(() => !alive(orphan), 2000)).toBe(true);
    } finally {
      if (alive(orphan)) process.kill(orphan, "SIGKILL");
    }
  });
});

// docs/plans/review-v2/spec.md section 6.21: an implement run with the Bash tool. The fake CLI lists the --tools names in init.
describe("shell steps", () => {
  const SCHEMA_I = implementJsonSchema();
  const S = "00000000-0000-4000-8000-000000000001";
  const stub = { command: "bun", args: ["stub.ts"], tools: ["get_fact"] };
  function implement(scenario: Partial<FakeScenario>, shell?: Partial<ShellSpec>) {
    const s = setup(scenario);
    const spec: ImplementSpec = {
      implement: true,
      cwd: s.work,
      appDir: s.app,
      mcpServers: { "rl-stub": stub },
      prompt: "- Mode: implement\nDo the step.",
      schema: SCHEMA_I,
      maxTurns: 80,
      ...(shell && {
        shell: {
          mode: "allowlist",
          rules: ["ssh build1 *"],
          bashTimeoutSec: 600,
          dataDir: s.base,
          origins: ["https://bitbucket.example.test"],
          ...shell,
        },
      }),
    };
    return { ...s, spec };
  }
  const head = ["-p", "--output-format", "stream-json", "--verbose", "--restricted", "--strict-mcp-config", "--mcp-config"];
  const tail = ["--json-schema", JSON.stringify(SCHEMA_I), "--max-turns", "80", "--no-session-persistence"];

  // Stream lines of a run with Bash calls. A refused call: the tool_use, permission_denied (V7), and the error tool_result.
  const line = {
    init: {
      type: "system",
      subtype: "init",
      cwd: "C:\\fake-cwd",
      tools: [],
      mcp_servers: [],
      model: "m",
      permissionMode: "default",
      session_id: S,
    },
    bash: (id: string, command: string) => ({
      type: "assistant",
      parent_tool_use_id: null,
      session_id: S,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command, description: "Run it" } }] },
    }),
    out: (id: string, content: string, is_error = false) => ({
      type: "user",
      parent_tool_use_id: null,
      session_id: S,
      message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
    }),
    denied: (id: string, type?: string, message = "Permission to use Bash has been denied.") => ({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Bash",
      tool_use_id: id,
      ...(type && { decision_reason_type: type }),
      decision_reason: "Refused",
      message,
    }),
    result: { type: "result", subtype: "success", is_error: false, result: "", structured_output: {}, num_turns: 3, session_id: S },
  };
  const refused = (id: string, command: string, type?: string, message?: string) => [
    line.bash(id, command),
    line.denied(id, type, message),
    line.out(id, message ?? "Permission to use Bash has been denied.", true),
  ];
  // The shell gate run B22 (CLI 2.1.316): a CLI safety check with no decision_reason_type.
  const REDIRECT =
    "Output redirection to '/tmp/outside.txt' needs approval. The path is outside the working directories for this session ('/tmp/work'). Allowing runs the command as written.";
  const synthetic = (name: string, events: unknown[]) => {
    const f = join(DERIVED, `${name}.jsonl`);
    writeFileSync(f, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
    return f;
  };

  test("no shell: the implement argv stays as before, with no settings file", async () => {
    const { runner, spec, app, calls } = implement({ fixture: flatSuccess() });
    expect((await runner.run(spec)).status).toBe("completed");
    expect(calls()[2]?.argv).toEqual([
      ...head,
      join(app, "mcp.json"),
      "--tools",
      "Read,Grep,Glob,Edit,Write",
      "--allowedTools",
      "Read,Grep,Glob,Edit,Write,mcp__rl-stub",
      ...tail,
    ]);
    expect(existsSync(join(app, "shell.json"))).toBe(false);
    expect(Object.keys(calls()[2]?.env ?? {}).map((k) => k.toUpperCase())).not.toContain("BASH_DEFAULT_TIMEOUT_MS");
  });

  test("allowlist: Bash in --tools, shell.json, no --permission-mode; init with Bash passes the check", async () => {
    const { runner, spec, app, calls } = implement({ fixture: flatSuccess() }, {});
    const o = await runner.run(spec);
    expect(o.status).toBe("completed");
    expect(o.init?.tools).toContain("Bash");
    expect(calls()[2]?.argv).toEqual([
      ...head,
      join(app, "mcp.json"),
      "--tools",
      "Read,Grep,Glob,Edit,Write,Bash",
      "--allowedTools",
      "Read,Grep,Glob,Edit,Write,mcp__rl-stub",
      "--settings",
      join(app, "shell.json"),
      ...tail,
    ]);
    const file = JSON.parse(readFileSync(join(app, "shell.json"), "utf8"));
    expect(file).toEqual(shellSettings(spec.shell as ShellSpec));
    expect(file.permissions.allow).toEqual(["Bash(ssh build1 *)", "Bash(grep *)", "Bash(rg *)"]);
    expect(file.permissions.deny).toContain("Bash(*bitbucket.example.test*)");
    expect(file.permissions.deny).not.toContain("Bash(ssh *)");
  });

  test("Any command: shell.json allows Bash, and the deny list keeps ssh off without an ssh entry", async () => {
    const { runner, spec, app, calls } = implement({ fixture: flatSuccess() }, { mode: "any", rules: [] });
    expect((await runner.run(spec)).status).toBe("completed");
    const argv = calls()[2]?.argv ?? [];
    expect(argv.slice(argv.indexOf("--settings"), argv.indexOf("--json-schema"))).toEqual(["--settings", join(app, "shell.json")]);
    const file = JSON.parse(readFileSync(join(app, "shell.json"), "utf8"));
    expect(file.permissions.allow).toEqual(["Bash"]);
    expect(file.permissions.deny).toContain("Bash(ssh *)");
  });

  test("a shell step without an app folder or with a bad time limit never starts the CLI", async () => {
    const { runner, spec, calls } = implement({ fixture: flatSuccess() }, {});
    await expect(runner.run({ ...spec, appDir: undefined })).rejects.toThrow("app folder");
    await expect(runner.run({ ...spec, shell: { ...(spec.shell as ShellSpec), bashTimeoutSec: 0 } })).rejects.toThrow("time limit");
    expect(calls().some((c) => c.argv[0] === "-p")).toBe(false);
  });

  test("child env (D5): real HOME and ssh agent, no GIT_*, askpass, or gate token, the git and Bash switches set", async () => {
    const set = {
      GIT_DIR: "/elsewhere",
      SSH_ASKPASS: "/bin/askpass",
      GATE_JIRA_TOKEN: "gate-token",
      CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      RL_KEEP_ME: "kept",
    };
    const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
    Object.assign(process.env, set);
    try {
      const { runner, spec, calls } = implement({ fixture: flatSuccess() }, { bashTimeoutSec: 900 });
      expect((await runner.run(spec)).status).toBe("completed");
      const env = calls()[2]?.env ?? {};
      const keys = Object.keys(env).map((k) => k.toUpperCase());
      expect(keys.filter((k) => k.startsWith("GIT_")).sort()).toEqual([
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_VALUE_0",
        "GIT_TERMINAL_PROMPT",
      ]);
      // git-deny.md fix B: an empty file of the app beside shell.json, never the file of gitSetup.
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(spec.appDir as string, "empty.gitconfig"));
      expect(readFileSync(env.GIT_CONFIG_GLOBAL as string, "utf8")).toBe("");
      for (const k of ["SSH_ASKPASS", "GATE_JIRA_TOKEN"]) expect(keys).not.toContain(k);
      expect(keys.filter((k) => k.startsWith("CLAUDE_CODE_")).sort()).toEqual([
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
        "CLAUDE_CODE_GIT_BASH_PATH",
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
      ]);
      expect(env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe",
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
        BASH_DEFAULT_TIMEOUT_MS: "900000",
        BASH_MAX_TIMEOUT_MS: "900000",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        RL_KEEP_ME: "kept",
      });
      if (process.env.HOME !== undefined) expect(env.HOME).toBe(process.env.HOME);
      if (process.env.USERPROFILE !== undefined) expect(env.USERPROFILE).toBe(process.env.USERPROFILE);
      // The version and auth checks get the plain child env.
      expect(Object.keys(calls()[0]?.env ?? {}).map((k) => k.toUpperCase())).toContain("GIT_DIR");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("an init without Bash fails a shell step with the Git Bash text and kills the run", async () => {
    const { runner, spec, calls } = implement({ fixture: flatSuccess(), noBash: true, delayMs: 30 }, {});
    const o = await runner.run(spec);
    expect(o).toMatchObject({ status: "failed", kind: "tool_check", text: NO_BASH_TEXT, events: [] });
    if (process.platform === "win32") expect(o.text).toBe("Install Git for Windows. Claude Code needs Git Bash to run commands.");
    const pid = calls().at(-1)?.pid ?? 0;
    expect(await waitFor(() => !alive(pid))).toBe(true);
    // A step without shell needs no Bash.
    const plain = implement({ fixture: flatSuccess(), noBash: true });
    expect((await plain.runner.run(plain.spec)).status).toBe("completed");
  });

  test("the init check accepts Bash only for a shell step", () => {
    const base = mkdtempSync(join(tmpdir(), "rl-wp8-"));
    dirs.push(base);
    const init = JSON.stringify({ ...line.init, tools: [...IMPLEMENT_TOOLS, "Bash", "StructuredOutput"] });
    const plain = implementArgs({ implement: true, cwd: base, prompt: "p", schema: SCHEMA_I, maxTurns: 80 });
    const p = createStreamParser({ cwd: base, allowedTools: plain.allowed });
    p.line(init);
    expect(classify(p.state, { exitCode: 0, cancelled: false, timedOut: false })).toMatchObject({
      kind: "tool_check",
      text: "init lists tools outside the allowlist: Bash.",
    });
    const shell = { mode: "any" as const, rules: [], bashTimeoutSec: 600, dataDir: base, origins: [] };
    const withShell = implementArgs({
      implement: true,
      cwd: base,
      appDir: join(base, "app"),
      prompt: "p",
      schema: SCHEMA_I,
      maxTurns: 80,
      shell,
    });
    const q = createStreamParser({ cwd: base, allowedTools: withShell.allowed, shell: "any" });
    q.line(init);
    expect(q.state.badTools).toEqual([]);
    expect(q.state.noBash).toBe(false);
  });

  test("Bash events: the command as target, the output tail as note, and a refusal note per rule list", async () => {
    const out = `${"ü".repeat(3000)}x`;
    const long = `echo ${"y".repeat(5000)}`;
    const fixture = synthetic("bash-events", [
      line.init,
      line.bash("b1", "bun test"),
      line.out("b1", out),
      line.bash("b2", long),
      line.out("b2", "Exit code 1\nline one\n<tool_use_error>boom</tool_use_error>", true),
      ...refused("b3", "git status", "rule"),
      ...refused("b4", "curl https://x.example.test", "other", "This command requires approval"),
      ...refused("b5", "echo x > ../outside.txt", undefined, REDIRECT),
      line.result,
    ]);
    const { runner, spec } = implement({ fixture }, {});
    const o = await runner.run(spec);
    expect(o.status).toBe("completed");
    expect(o.events.map((e) => [e.id, e.tool, e.status])).toEqual([
      ["b1", "Bash", "ok"],
      ["b2", "Bash", "error"],
      ["b3", "Bash", "error"],
      ["b4", "Bash", "error"],
      ["b5", "Bash", "error"],
    ]);
    const [b1, b2, b3, b4, b5] = o.events;
    expect(b1?.target).toBe("bun test");
    // 4096 bytes end inside a two-byte character; its half goes.
    expect(b1?.note).toBe(`${"ü".repeat(2047)}x`);
    expect(b2?.target).toBe(long.slice(0, 4000));
    expect(b2?.note).toBe("Exit code 1\nline one\nboom");
    expect([b3?.target, b3?.note]).toEqual(["git status", "Refused by the deny list"]);
    expect([b4?.target, b4?.note]).toEqual(["curl https://x.example.test", "Refused by the allowlist"]);
    expect(b5?.note).toBe("Refused by a Claude Code safety check");
  });

  test("refusal labels (SU3): the B22 permission_denied events of CLI 2.1.316, and a type rule event", () => {
    const p = createStreamParser({ cwd: "/w", allowedTools: new Set(), shell: "allowlist" });
    const deny = (cmd: string) => `Permission to use Bash with command ${cmd} has been denied.`;
    const seen: [string, string, Record<string, string>][] = [
      [
        "d1",
        "node rlgb-probe.cjs refused",
        { decision_reason_type: "other", decision_reason: "This command requires approval", message: "This command requires approval" },
      ],
      ["d2", "git status", { decision_reason_type: "subcommandResults", message: deny("git status") }],
      ["d3", "curl https://example.invalid", { decision_reason_type: "subcommandResults", message: deny("curl https://example.invalid") }],
      ["d4", "id", { decision_reason_type: "rule", decision_reason: "Refused", message: "Refused" }],
    ];
    for (const [id, cmd, fields] of seen) {
      p.line(JSON.stringify(line.bash(id, cmd)));
      p.line(JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: id, ...fields }));
    }
    expect(p.state.refused).toEqual([
      { command: "node rlgb-probe.cjs refused", by: "allowlist" },
      { command: "git status", by: "deny" },
      { command: "curl https://example.invalid", by: "deny" },
      { command: "id", by: "deny" },
    ]);
  });

  test("refusal labels by mode: a safety check is never the allowlist, and Any command never shows the allowlist", () => {
    const approval = {
      decision_reason_type: "other",
      decision_reason: "This command requires approval",
      message: "This command requires approval",
    };
    const labels = (shell: "allowlist" | "any") => {
      const p = createStreamParser({ cwd: "/w", allowedTools: new Set(), shell });
      const seen: [string, Record<string, string>][] = [
        ["e1", approval],
        ["e2", { message: REDIRECT }],
        ["e3", { decision_reason_type: "subcommandResults", message: "Permission to use Bash with command git status has been denied." }],
        ["e4", { decision_reason_type: "other", message: "Contains backslash-escaped whitespace" }],
      ];
      for (const [id, fields] of seen) {
        p.line(JSON.stringify(line.bash(id, id)));
        p.line(JSON.stringify({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: id, ...fields }));
      }
      return { by: p.state.refused.map((r) => r.by), notes: p.events().map((e) => e.note) };
    };
    expect(labels("allowlist")).toEqual({
      by: ["allowlist", "check", "deny", "check"],
      notes: [
        "Refused by the allowlist",
        "Refused by a Claude Code safety check",
        "Refused by the deny list",
        "Refused by a Claude Code safety check",
      ],
    });
    expect(labels("any").by).toEqual(["check", "check", "deny", "check"]);
    expect(labels("any").notes).not.toContain("Refused by the allowlist");
  });

  test("Gate B30a: a refused `cd <dir> && <command>` keeps the label check and gets the cd note in both modes", () => {
    for (const shell of ["allowlist", "any"] as const) {
      const p = createStreamParser({ cwd: "/w", allowedTools: new Set(), shell });
      p.line(JSON.stringify(line.bash("c1", "cd repo && cat README.md")));
      p.line(
        JSON.stringify({
          type: "system",
          subtype: "permission_denied",
          tool_name: "Bash",
          tool_use_id: "c1",
          decision_reason_type: "subcommandResults",
          message: "This Bash command contains multiple operations. The following part requires approval: cd repo && cat README.md",
        }),
      );
      expect(p.state.refused).toEqual([{ command: "cd repo && cat README.md", by: "check" }]);
      expect(p.events().map((e) => e.note)).toEqual([CD_REFUSED_NOTE]);
    }
  });

  test("Gate B31: the read block of allowlist mode refuses a lone cd, and the call gets the cd note", () => {
    const p = createStreamParser({ cwd: "/w", allowedTools: new Set(), shell: "allowlist" });
    p.line(JSON.stringify(line.bash("c1", "cd repo")));
    p.line(
      JSON.stringify({
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "c1",
        decision_reason_type: "safetyCheck",
        message:
          "cd names a path that is computed at run time, which cannot be checked against the read block (permissions.blockReadsOutsideWorkingDirectories)",
      }),
    );
    expect(p.state.refused).toEqual([{ command: "cd repo", by: "check" }]);
    expect(p.events().map((e) => e.note)).toEqual([CD_REFUSED_NOTE]);
  });

  test("more than 5 refused commands kill the run", async () => {
    const calls7 = Array.from({ length: 7 }, (_, i) =>
      refused(`r${i}`, `curl https://x${i}.example.test`, "other", "This command requires approval"),
    ).flat();
    const fixture = synthetic("bash-refused", [line.init, ...calls7, line.result]);
    const { runner, spec, calls } = implement({ fixture, delayMs: 30 }, {});
    const seen: RunEvent[] = [];
    const o = await runner.run(spec, (ev) => seen.push(...ev));
    expect(o).toMatchObject({ status: "failed", kind: "tool_check", text: "Claude Code refused more than 5 commands in this run." });
    expect(o.events.map((e) => [e.id, e.status, e.note])).toEqual(
      Array.from({ length: 6 }, (_, i) => [`r${i}`, "error", "Refused by the allowlist"]),
    );
    expect(seen.filter((e) => e.status === "error")).toHaveLength(6);
    const pid = calls().at(-1)?.pid ?? 0;
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });
});

// docs/plans/review-v2/task-subagents.md decision 1 and Design: the read-only subagent rl-explorer of a task step.
describe("rl-explorer in task steps", () => {
  const SCHEMA_I = implementJsonSchema();
  const g = SHIPPED_PROFILES[0] as Profile;
  const EXPLORER = explorerAgent({ ...g, reviewer: { ...g.reviewer, model: "sonnet" } });
  const stub = { command: "bun", args: ["stub.ts"], tools: ["get_fact"] };
  const flagOf = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const NO_TOOL = ["Bash", "PowerShell", "Write", "Edit", "NotebookEdit", "Agent"];
  const folder = () => {
    const base = mkdtempSync(join(tmpdir(), "rl-sa1-"));
    dirs.push(base);
    const cwd = join(base, "work");
    mkdirSync(cwd);
    return { base, cwd, app: join(base, "app") };
  };
  const init = (tools: string[]) =>
    JSON.stringify({ type: "system", subtype: "init", cwd: "/w", tools, mcp_servers: [], model: "m", permissionMode: "default" });
  type AgentsRec = { argv: string[]; agents: Record<string, { tools: string[]; disallowedTools?: string[]; omitClaudeMd?: boolean }> };

  test("an implement step in each shell mode is rl-main with Agent(rl-explorer); rl-explorer reads only, on the review subagent model", () => {
    expect(EXPLORER.model).toBe("sonnet");
    for (const mode of [undefined, ...SHELL_MODES]) {
      const { base, cwd, app } = folder();
      const shell = mode && { mode, rules: mode === "allowlist" ? ["make *"] : [], bashTimeoutSec: 600, dataDir: base, origins: [] };
      const step = {
        implement: true as const,
        cwd,
        appDir: app,
        mcpServers: { "rl-stub": stub },
        prompt: "p",
        schema: SCHEMA_I,
        maxTurns: 80,
      };
      const { args, allowed, agents } = implementArgs({ ...step, explorer: EXPLORER, ...(shell && { shell }) });
      const file = join(app, "agents.json");
      const at = args.indexOf("--agents");
      expect(args.slice(at, at + 4)).toEqual(["--agents", file, "--agent", "rl-main"]);
      const builtins = [...IMPLEMENT_TOOLS, ...(mode ? ["Bash"] : [])];
      expect(flagOf(args, "--tools")).toBe([...builtins, "Agent"].join(","));
      // Gate B9: the Agent tool needs no allow rule. Gate B8: init names it Task.
      expect(flagOf(args, "--allowedTools")).toBe("Read,Grep,Glob,Edit,Write,mcp__rl-stub");
      expect([allowed.has("Agent"), allowed.has("Task")]).toEqual([true, true]);
      expect([...agents]).toEqual(["rl-main", "rl-explorer"]);
      expect(args).toContain("--restricted");
      const defs = JSON.parse(readFileSync(file, "utf8"));
      expect(defs).toEqual({
        "rl-main": {
          description: "Main thread of a task step.",
          prompt: "",
          tools: ["Agent(rl-explorer)", ...builtins, "mcp__rl-stub__get_fact", "StructuredOutput"],
        },
        "rl-explorer": { ...EXPLORER, tools: ["Read", "Grep", "Glob"], disallowedTools: NO_TOOL, omitClaudeMd: true },
      });
      for (const t of NO_TOOL) expect(defs["rl-explorer"].tools).not.toContain(t);
      // Gate B4 rule: the agents file stays in the run folder, outside the cwd.
      expect(readdirSync(cwd)).toEqual([]);
    }
  });

  test("a step without an app folder never gets rl-explorer, and no review agent takes its name", async () => {
    const { cwd } = folder();
    expect(() => implementArgs({ implement: true, cwd, prompt: "p", schema: SCHEMA_I, maxTurns: 80, explorer: EXPLORER })).toThrow(
      "app folder",
    );
    const { runner, spec, calls } = setup({ fixture: flatSuccess() });
    await expect(runner.run({ ...spec, agents: { "rl-explorer": EXPLORER } })).rejects.toThrow("rl-explorer cannot be a review agent.");
    await expect(runner.run({ ...spec, agents: {}, mcpServers: {}, noTools: true, explorer: EXPLORER })).rejects.toThrow("without tools");
    expect(calls().some((c) => c.argv[0] === "-p")).toBe(false);
  });

  test("an interview or spec run adds Agent(rl-explorer) with no MCP tool; a run without it (the plan check) gets no Agent tool", async () => {
    const { runner, spec, calls } = setup({ fixture: flatSuccess() });
    const task = { ...spec, agents: {}, explorer: EXPLORER };
    expect((await runner.run(task)).status).toBe("completed");
    const withIt = calls().at(-1) as unknown as AgentsRec;
    expect(flagOf(withIt.argv, "--tools")).toBe("Read,Grep,Glob,Agent");
    expect(flagOf(withIt.argv, "--agent")).toBe("rl-main");
    expect(withIt.agents["rl-main"]?.tools).toEqual([
      "Agent(rl-explorer)",
      "Read",
      "Grep",
      "Glob",
      "mcp__rl-stub__get_fact",
      "StructuredOutput",
    ]);
    expect(withIt.agents["rl-explorer"]).toEqual({
      ...EXPLORER,
      tools: ["Read", "Grep", "Glob"],
      disallowedTools: NO_TOOL,
      omitClaudeMd: true,
    });
    // A review run with its own agents keeps them next to rl-explorer.
    await runner.run({ ...spec, explorer: EXPLORER });
    const review = calls().at(-1) as unknown as AgentsRec;
    expect(review.agents["rl-main"]?.tools[0]).toBe("Agent(rl-reviewer, rl-explorer)");

    const { explorer: _, ...check } = task;
    expect((await runner.run(check)).status).toBe("completed");
    const without = calls().at(-1) as unknown as AgentsRec;
    expect(flagOf(without.argv, "--tools")).toBe("Read,Grep,Glob");
    expect(Object.keys(without.agents)).toEqual(["rl-main"]);
    expect(without.agents["rl-main"]?.tools).toEqual(["Read", "Grep", "Glob", "mcp__rl-stub__get_fact", "StructuredOutput"]);
  });

  test("the init check: with rl-explorer Agent and Task pass, and each other extra tool still stops the step; without it Task stops", () => {
    const { cwd, app } = folder();
    const step = { implement: true as const, cwd, appDir: app, prompt: "p", schema: SCHEMA_I, maxTurns: 80 };
    const withIt = implementArgs({ ...step, explorer: EXPLORER });
    const ok = createStreamParser({ cwd, allowedTools: withIt.allowed, agents: withIt.agents });
    ok.line(init([...IMPLEMENT_TOOLS, "Task", "Agent", "StructuredOutput"]));
    expect(ok.state.badTools).toEqual([]);
    for (const extra of ["Bash", "PowerShell", "WebFetch", "NotebookEdit"]) {
      const p = createStreamParser({ cwd, allowedTools: withIt.allowed, agents: withIt.agents });
      p.line(init([...IMPLEMENT_TOOLS, "Task", extra, "StructuredOutput"]));
      expect(classify(p.state, { exitCode: 0, cancelled: false, timedOut: false })).toMatchObject({
        status: "failed",
        kind: "tool_check",
        text: `init lists tools outside the allowlist: ${extra}.`,
      });
    }
    const plain = implementArgs(step);
    const p = createStreamParser({ cwd, allowedTools: plain.allowed, agents: plain.agents });
    p.line(init([...IMPLEMENT_TOOLS, "Task", "StructuredOutput"]));
    expect(p.state.badTools).toEqual(["Task"]);
  });

  test("an rl-explorer call of an implement step nests its calls under it in the step log, as an app agent", async () => {
    const fixture = derive("b9-wp8-flags.jsonl", (e) => JSON.parse(JSON.stringify(e).replaceAll("rl-reviewer", "rl-explorer")));
    const { runner, work, app, calls } = setup({ fixture });
    const o = await runner.run({
      implement: true,
      cwd: work,
      appDir: app,
      mcpServers: { "rl-stub": stub },
      prompt: "- Mode: implement\nDo the step.",
      schema: SCHEMA_I,
      maxTurns: 80,
      explorer: EXPLORER,
    });
    expect(o.status).toBe("completed");
    expect(o.init?.tools).toContain("Task");
    expect(flagOf(calls().at(-1)?.argv ?? [], "--agent")).toBe("rl-main");
    const agent = byId(o.events, "toolu_01LSbcECPmHiTBS4CDvWoCbj");
    expect(agent).toMatchObject({ parent: null, tool: "Agent", agent: "rl-explorer", builtin: false, status: "ok" });
    const node = logTree(o.events).find((n) => n.e.id === agent?.id);
    expect(node?.kids.map((k) => [k.e.tool, k.e.parent])).toEqual([
      ["Read", agent?.id ?? null],
      ["Read", agent?.id ?? null],
      ["mcp__rl-stub__get_fact", agent?.id ?? null],
    ]);
    // An agent that the app did not define keeps the built-in mark.
    expect(o.events.find((e) => e.agent === "general-purpose")?.builtin).toBe(true);
  });
});
