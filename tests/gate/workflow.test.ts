// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate B35 and B36 helpers (scripts/gate/workflow.ts) on fake events, and the B35 and B36 dry runs. No test starts claude.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_OUTPUT, hideAgentOutput, type Json, pathForms } from "../../scripts/gate/sanitize-core";
import {
  agentCall,
  agentDef,
  agentFront,
  agentStats,
  bashHas,
  bashIs,
  callOutcome,
  cwdFilesFact,
  KEPT_KEYS,
  leadDef,
  lift,
  modelOfAgent,
  outsideFolders,
  overlap,
  pathEnds,
  redactPaths,
  touchLine,
  u82a,
  u82b,
  u82c,
  u82d,
  u82f,
  u82g,
  u82h,
  u83,
  u84,
  u85,
  u86,
  u89,
  u91,
  u93,
  u96,
  withFlag,
} from "../../scripts/gate/workflow";

const ROOT = join(import.meta.dir, "../..");
const NO_TOOLS = mkdtempSync(join(tmpdir(), "rl-gate-test-path-"));
afterAll(() => rmSync(NO_TOOLS, { recursive: true, force: true }));

const use = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null, msg = `m-${id}`) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { id: msg, model: parent ? "claude-sonnet-x" : "claude-haiku-x", content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, text: string, isError = false, extra: Record<string, unknown> = {}, parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] },
  ...extra,
});
const denied = (id: string, parent: string | null) => ({
  type: "system",
  subtype: "permission_denied",
  tool_use_id: id,
  parent_tool_use_id: parent,
});

// A lead that starts rl-gb-writer. The writer runs a refused Bash call, an ok Write, and a refused Agent call.
const events = [
  use("a1", "Agent", { subagent_type: "rl-gb-writer", prompt: "go" }),
  use("b1", "Bash", { command: "git status" }, "a1"),
  denied("b1", "a1"),
  result("b1", "Permission to use Bash with command git status has been denied.", true, {}, "a1"),
  use("w1", "Write", { file_path: "C:\\t\\work\\repo\\w.txt", content: "x" }, "a1"),
  result("w1", "File created", false, {}, "a1"),
  use("n1", "Agent", { subagent_type: "general-purpose", prompt: "OK" }, "a1"),
  result("n1", "No such tool available: Agent", true, {}, "a1"),
  result("a1", "done", false, { tool_use_result: { resolvedModel: "claude-sonnet-x", totalTokens: 1234 } }),
];

describe("agents.json transform", () => {
  test("the cap, the forced deny list, maxTurns, and only the kept keys", () => {
    const d = agentDef(
      {
        description: "d".repeat(2000),
        prompt: "p",
        tools: ["Read", "Edit", "Bash", "WebFetch"],
        permissionMode: "bypassPermissions",
        hooks: { PreToolUse: [] },
        mcpServers: { x: {} },
        memory: "user",
        maxTurns: 50,
      },
      { shell: false, stepTurns: 20 },
    );
    expect(Object.keys(d).every((k) => KEPT_KEYS.includes(k))).toBe(true);
    expect(d.tools).toEqual(["Read", "Edit"]);
    expect(d.disallowedTools).toEqual(
      expect.arrayContaining(["Agent", "WebFetch", "WebSearch", "PowerShell", "NotebookEdit", "Bash", "Write"]),
    );
    expect(d.disallowedTools).not.toContain("Edit");
    expect(d.maxTurns).toBe(20);
    expect(d.description.length).toBe(1024);
    expect(d.omitClaudeMd).toBe(true);
    expect(agentDef({ description: "d", prompt: "p", maxTurns: 2.5 }, { shell: true, stepTurns: 9 }).maxTurns).toBe(9);
    expect(agentDef({ description: "d", prompt: "p", maxTurns: 2 }, { shell: true, stepTurns: 9 }).maxTurns).toBe(2);
    expect(agentDef({ description: "d", prompt: "p" }, { shell: true, stepTurns: 9 }).tools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Write",
      "Bash",
    ]);
    expect(agentDef({ description: "d", prompt: "p", tools: ["Write"] }, { shell: true, readOnly: true, stepTurns: 9 }).tools).toEqual([]);
  });

  test("lift, the lead, and the flag swap", () => {
    const d = lift(agentDef({ description: "d", prompt: "p" }, { shell: false, stepTurns: 5 }), "WebFetch");
    expect(d.tools).toContain("WebFetch");
    expect(d.disallowedTools).not.toContain("WebFetch");
    expect(d.disallowedTools).toContain("Agent");
    expect(leadDef(["a", "b"], false).tools).toEqual(["Agent(a, b)", "Read", "Grep", "Glob", "StructuredOutput"]);
    expect(leadDef(["a"], true).tools).toContain("Edit");
    expect(leadDef(["a"], false).prompt).toBe("");
    expect(withFlag(["--allowedTools", "Read,Edit", "-p"], "--allowedTools", "Read")).toEqual(["--allowedTools", "Read", "-p"]);
    expect(() => withFlag(["-p"], "--allowedTools", "x")).toThrow();
  });

  test("agentFront reads name and model of the front matter", () => {
    expect(agentFront("---\nname: helper\nmodel: haiku\n---\nbody", "f.md")).toEqual({ name: "helper", model: "haiku" });
    expect(agentFront("no front matter", "f.md")).toEqual({ name: "f", model: undefined });
    expect(agentFront("---\nname: \"helper\"\nmodel: 'haiku'\n---\nbody", "f.md")).toEqual({ name: "helper", model: "haiku" });
    expect(agentFront('---\nname: "it\'s"\n---\n', "f.md").name).toBe("it's");
  });

  test("redactPaths covers every path form, the dash form of the per-cwd folder names too", () => {
    const forms = pathForms("C:\\Users\\Bob");
    expect(redactPaths("a C:\\Users\\bob\\x b", forms)).toBe("a ~\\x b");
    expect(redactPaths("c:/users/bob/x", forms)).toBe("~/x");
    expect(redactPaths(JSON.stringify("C:\\Users\\Bob\\x"), forms)).toBe('"~\\\\x"');
    expect(redactPaths("projects/C--Users-Bob-AppData-Local-Temp-rl-gb-b36-x-work", forms)).toBe(
      "projects/~-AppData-Local-Temp-rl-gb-b36-x-work",
    );
    expect(redactPaths("same", ["", ...forms])).toBe("same");
  });

  test("bashHas finds a wrapped command", () => {
    expect(bashHas("sleep 600")({ command: "cd repo && sleep 600" })).toBe(true);
    expect(bashHas("sleep 600")({ command: "timeout 700 sleep 600\n" })).toBe(true);
    expect(bashHas("sleep 600")({ command: "sleep 60" })).toBe(false);
    expect(bashHas("sleep 600")({})).toBe(false);
  });
});

describe("event readers", () => {
  test("a nested call is found under its parent only", () => {
    expect(callOutcome(events, null, "Bash").state).toBe("not tried");
    const b = callOutcome(events, "a1", "Bash", bashIs(" git status\r\n"));
    expect(b.state).toBe("refused");
    expect(b.deniedParent).toBe("a1");
    expect(callOutcome(events, "a1", "Write", pathEnds("w.txt")).state).toBe("ran");
    expect(callOutcome(events, "a1", "Agent").state).toBe("error");
    expect(callOutcome(events, "a1", "Edit").state).toBe("not tried");
  });

  // CLI 2.1.322: a subagent permission_denied event has agent_id and no parent_tool_use_id. Its agent_id is the task_id of task_started.
  test("a subagent refusal names the agent call through task_started", () => {
    const sub = [
      use("a9", "Agent", { subagent_type: "rl-gb-writer", prompt: "go" }),
      { type: "system", subtype: "task_started", task_id: "a0f0f0f0f0f0f0f0f", tool_use_id: "a9" },
      use("b9", "Bash", { command: "git status" }, "a9"),
      { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "b9", agent_id: "a0f0f0f0f0f0f0f0f" },
      result("b9", "Permission to use Bash with command git status has been denied.", true, {}, "a9"),
      use("b8", "Bash", { command: "touch x.ran" }, "a9"),
      { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "b8", agent_id: "a1111111111111111" },
    ];
    const b = callOutcome(sub, "a9", "Bash", bashIs("git status"));
    expect(b.state).toBe("refused");
    expect(b.deniedParent).toBe("a9");
    expect(callOutcome(sub, "a9", "Bash", bashIs("touch x.ran")).deniedParent).toBeUndefined();
    const cmds = { git: { ...b, label: "deny", want: "deny", marker: false } };
    const f = u85("allowlist", { called: true, agent: "a9", cmds, control: { state: "ran", text: "", marker: true } });
    expect(f.status).toBe("PASS");
    expect(f.evidence).toContain("event parent=agent call");
  });

  test("touchLine", () => {
    expect(touchLine({ state: "refused", label: "check" }, false)).toBe("touch in the cwd with no allow rule=refused (check) marker=false");
    expect(touchLine({ state: "ran", label: "none" }, true, 'allow rule "touch *"')).toBe(
      'touch in the cwd with allow rule "touch *"=ran marker=true',
    );
  });

  test("agent stats and the agent call", () => {
    const c = agentCall(events, "rl-gb-writer");
    expect(c?.id).toBe("a1");
    expect(agentCall(events, "general-purpose")).toBeUndefined();
    const s = agentStats(events, "a1");
    expect(s.resolvedModel).toBe("claude-sonnet-x");
    expect(s.totalTokens).toBe(1234);
    expect(s.childModels).toEqual(["claude-sonnet-x"]);
    expect(s.text).toBe("done");
    expect(modelOfAgent({ ...s, resolvedModel: null })).toBe("claude-sonnet-x");
  });

  test("overlap of two agent calls", () => {
    const both = [use("x", "Agent", {}, null, "m1"), use("y", "Agent", {}, null, "m1"), result("x", "a"), result("y", "b")];
    expect(overlap(both, "x", "y")).toEqual({ started: true, overlap: true, oneMessage: true });
    const serial = [use("x", "Agent", {}), result("x", "a"), use("y", "Agent", {}), result("y", "b")];
    expect(overlap(serial, "x", "y")).toEqual({ started: true, overlap: false, oneMessage: false });
    expect(overlap(serial, "x", "z").started).toBe(false);
  });

  test("outsideFolders", () => {
    const dirs = ["C:\\p\\proj\\-w", "C:\\t\\claude\\-w"];
    expect(
      outsideFolders(["C:\\p\\proj\\-w\\a\\agent-1.jsonl", "c:\\T\\claude\\-w\\x.out", "C:\\t\\other\\y.out", "C:\\p\\proj\\-w"], dirs),
    ).toEqual(["C:\\t\\other\\y.out", "C:\\p\\proj\\-w"]);
  });
});

const o = (state: "refused" | "ran" | "error" | "no result" | "not tried", extra: Record<string, unknown> = {}) => ({
  state,
  text: "",
  ...extra,
});

describe("B35 judges", () => {
  test("U82a to U82d", () => {
    const cwdText = "C:\\t\\out.txt is outside C:\\t\\work; --restricted confines the file tools to the working directory.";
    const ok = {
      rel: { ...o("refused"), file: false },
      abs: { ...o("error", { text: cwdText }), file: false },
      repo: { ...o("ran"), file: true },
    };
    expect(u82a(ok).status).toBe("PASS");
    expect(u82a(ok).evidence).toContain("--restricted confines");
    expect(u82a({ ...ok, abs: { ...o("error", { text: "ENOENT: no such file or directory" }), file: false } }).status).toBe("FAIL");
    expect(u82a({ ...ok, abs: { ...o("no result"), file: false } }).status).toBe("FAIL");
    const perm = "Claude requested permissions to write to x, but you haven't granted it yet.";
    expect(u82a({ ...ok, abs: { ...o("error", { text: perm }), file: false } }).status).toBe("PASS");
    expect(u82a({ ...ok, abs: { ...o("not tried"), file: false } }).status).toBe("FAIL");
    expect(u82a({ ...ok, rel: { ...o("refused"), file: true } }).status).toBe("FAIL");
    const b = {
      git: { state: "refused", label: "deny" },
      compound: { state: "refused", label: "deny", marker: false },
      probe: { state: "ran", marker: true },
    };
    expect(u82b(b).status).toBe("PASS");
    expect(u82b({ ...b, compound: { ...b.compound, marker: true } }).status).toBe("FAIL");
    expect(u82c({ unlisted: { state: "refused", label: "allowlist", marker: false } }).status).toBe("PASS");
    expect(u82c({ unlisted: { state: "refused", label: "check", marker: false } }).status).toBe("FAIL");
    const step = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
    expect(u82d({ tools: [...step, "Task", "StructuredOutput"], step, mode: "default" }).status).toBe("PASS");
    expect(u82d({ tools: [...step, "Task", "StructuredOutput", "WebFetch"], step, mode: "default" }).status).toBe("FAIL");
    expect(u82d({ tools: [...step, "StructuredOutput"], step, mode: "default" }).status).toBe("FAIL");
    expect(u82d({ tools: [...step, "Task", "StructuredOutput"], step, mode: "acceptEdits" }).status).toBe("FAIL");
  });

  test("U82f to U82h and the per-cwd files", () => {
    const ex = { state: "ran", tools: ["Read", "Write"], writes: [] as string[] };
    const ref = { state: "refused", tools: [], writes: [] };
    expect(u82f({ gp: ref, user: null, ex, exModel: "claude-haiku-4", want: "haiku" }).status).toBe("PASS");
    expect(u82f({ gp: ref, user: { ...ex }, ex, exModel: "claude-haiku-4", want: "haiku" }).status).toBe("FAIL");
    expect(u82f({ gp: ref, user: ref, ex, exModel: "claude-sonnet-4", want: "haiku" }).status).toBe("FAIL");
    expect(u82g({ ex, file: false, marker: false }).status).toBe("PASS");
    expect(u82g({ ex: { ...ex, writes: ["Write"] }, file: false, marker: false }).status).toBe("FAIL");
    expect(u82h({ started: true, cliMs: 400, limitMs: 5000 }).status).toBe("PASS");
    expect(u82h({ started: false, cliMs: null, limitMs: 5000 }).status).toBe("FAIL");
    const f = { names: ["<id>/subagents/agent-1.jsonl (9 B)"], agentFiles: 1, outside: [], inCwd: [], left: 0 };
    expect(cwdFilesFact("U94", f).status).toBe("PASS");
    expect(cwdFilesFact("U94", { ...f, inCwd: ["settings.json"] }).status).toBe("FAIL");
    expect(cwdFilesFact("U94", { ...f, outside: ["x"] }).status).toBe("FAIL");
    expect(cwdFilesFact("U94", { ...f, names: [], agentFiles: 0 }).status).toBe("FAIL");
  });
});

describe("B36 judges", () => {
  test("U83, U84, U86, U89, U96", () => {
    const w = { rel: { ...o("refused"), file: false }, abs: { ...o("refused"), file: false }, repo: { ...o("ran"), file: true } };
    expect(u83({ called: true, ...w }).status).toBe("PASS");
    expect(u83({ called: false, ...w }).status).toBe("FAIL");
    expect(u83({ called: true, ...w, repo: { ...o("not tried"), file: false } }).evidence).toContain("run B36 again");
    expect(u83({ called: true, ...w, abs: { ...o("error", { text: "Invalid path" }), file: false } }).status).toBe("FAIL");
    expect(u83({ called: true, ...w, abs: { ...o("not tried"), file: false } }).status).toBe("FAIL");
    expect(u84({ edit: o("refused"), changed: false }).status).toBe("PASS");
    expect(u84({ edit: o("error"), changed: false }).status).toBe("FAIL");
    expect(u84({ edit: o("refused"), changed: true }).status).toBe("FAIL");
    const union = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "Agent"];
    const init = ["Read", "Bash", "Task", "StructuredOutput"];
    const missing = o("error", { text: "<tool_use_error>Error: No such tool available: WebFetch</tool_use_error>" });
    expect(u86({ tools: init, union, fetch: missing }).status).toBe("PASS");
    expect(u86({ tools: init, union, fetch: o("refused") }).status).toBe("PASS");
    expect(u86({ tools: init, union, fetch: o("not tried") }).status).toBe("FAIL");
    expect(u86({ tools: init, union, fetch: o("not tried") }).evidence).toContain("run B36 again");
    expect(u86({ tools: init, union, fetch: o("error", { text: "getaddrinfo ENOTFOUND example.invalid" }) }).status).toBe("FAIL");
    expect(u86({ tools: init, union, fetch: o("error", { text: "not available: fetch failed" }) }).status).toBe("FAIL");
    expect(u86({ tools: init, union, fetch: o("no result") }).status).toBe("FAIL");
    expect(u86({ tools: ["Read", "WebFetch"], union, fetch: missing }).status).toBe("FAIL");
    expect(u86({ tools: ["Read"], union, fetch: o("ran") }).status).toBe("FAIL");
    const run = { call: o("error", { text: "No such tool available: Agent" }), grandchild: 0, end: true };
    const both = { depth: { ...run, depthSet: true }, noDepth: { ...run, depthSet: false } };
    expect(u89(both, "x").status).toBe("PASS");
    expect(u89({ ...both, noDepth: { ...both.noDepth, call: o("refused") } }, "x").status).toBe("PASS");
    expect(u89({ ...both, depth: { ...both.depth, grandchild: 3 } }, "x").status).toBe("FAIL");
    expect(u89({ ...both, depth: { ...both.depth, call: o("not tried") } }, "x").status).toBe("FAIL");
    expect(u89({ ...both, noDepth: { ...both.noDepth, call: o("no result") } }, "x").status).toBe("FAIL");
    expect(u89({ ...both, noDepth: { ...both.noDepth, end: false } }, "x").status).toBe("FAIL");
    expect(u89({ ...both, noDepth: { ...both.noDepth, depthSet: true } }, "x").status).toBe("FAIL");
    expect(u89({ ...both, noDepth: null }, "x").status).toBe("FAIL");
    expect(u89({ ...both, noDepth: null }, "x").evidence).toContain("run lost");
    const typeRefused = o("error", { text: "Agent type 'general-purpose' is not allowed in this session." });
    expect(u89({ ...both, noDepth: { ...both.noDepth, call: typeRefused } }, "x").status).toBe("FAIL");
    expect(u96({ leadEdit: o("not tried"), leadWrite: o("refused"), leadFile: false, agentFile: true }).status).toBe("PASS");
    expect(u96({ leadEdit: o("ran"), leadWrite: o("not tried"), leadFile: true, agentFile: true }).status).toBe("FAIL");
    expect(u96({ leadEdit: o("not tried"), leadWrite: o("not tried"), leadFile: false, agentFile: false }).status).toBe("FAIL");
  });

  test("U85 checks each label, each marker, and the control", () => {
    const cmd = (label: string, want: string, marker = false) => ({ ...o("refused", { deniedParent: "a1" }), label, want, marker });
    const base = { called: true, agent: "a1", control: { ...o("ran"), marker: true } };
    const cmds = { unlisted: cmd("allowlist", "allowlist"), git: cmd("deny", "deny") };
    const f = u85("allowlist", { ...base, cmds });
    expect(f.id).toBe("U85.allowlist");
    expect(f.status).toBe("PASS");
    expect(f.evidence).toContain("event parent=agent call");
    expect(u85("any", { ...base, cmds: { ...cmds, git: cmd("check", "deny") } }).status).toBe("FAIL");
    expect(u85("any", { ...base, cmds: { ...cmds, git: cmd("deny", "deny", true) } }).status).toBe("FAIL");
    expect(u85("any", { ...base, cmds, control: { ...o("refused"), marker: false } }).status).toBe("FAIL");
    const lead = { ...cmd("deny", "deny"), deniedParent: undefined };
    expect(u85("any", { ...base, cmds: { ...cmds, git: lead } }).status).toBe("FAIL");
    expect(u85("any", { ...base, cmds: { ...cmds, git: { ...lead, deniedParent: "other" } } }).status).toBe("FAIL");
  });

  test("U91 and U93", () => {
    const u = {
      write: { parent: true, filePath: true },
      bash: { parent: true },
      totalTokens: 10,
      childModels: ["claude-sonnet-x"],
      usageModels: ["claude-haiku-x", "claude-sonnet-x"],
      cost: 0.01,
    };
    expect(u91(u).status).toBe("PASS");
    expect(u91({ ...u, usageModels: ["claude-haiku-x"] }).status).toBe("FAIL");
    expect(u91({ ...u, totalTokens: null }).status).toBe("FAIL");
    const s = { started: true, sleeps: [7], cliMs: 300, sleepMs: 320, job: [7, 8], win: true, left: [] };
    expect(u93(s).status).toBe("PASS");
    expect(u93({ ...s, job: [8] }).status).toBe("FAIL");
    expect(u93({ ...s, job: null, win: false }).status).toBe("PASS");
    expect(u93({ ...s, sleepMs: null }).status).toBe("FAIL");
  });
});

describe("user agent output in fixtures (U88)", () => {
  test("hideAgentOutput replaces the reply of a user agent call only", () => {
    const ev = (e: unknown) => e as Json;
    const evs = [
      ev(use("u1", "Agent", { subagent_type: "Mine", prompt: "go" })),
      ev({
        type: "assistant",
        parent_tool_use_id: "u1",
        message: {
          content: [
            { type: "text", text: "secret reply" },
            { type: "thinking", thinking: "t" },
          ],
        },
      }),
      ev({ type: "system", subtype: "task_notification", tool_use_id: "u1", summary: "secret summary" }),
      ev(result("u1", "secret reply", false, { tool_use_result: { content: [{ type: "text", text: "secret reply" }], totalTokens: 5 } })),
      ev(use("e1", "Agent", { subagent_type: "Explore", prompt: "go" })),
      ev({ type: "assistant", parent_tool_use_id: "e1", message: { content: [{ type: "text", text: "RLGB-DEF-EXPLORE" }] } }),
      ev(result("e1", "RLGB-DEF-EXPLORE")),
    ];
    const out = JSON.stringify(hideAgentOutput(evs, new Set(["mine"])));
    expect(out).not.toContain("secret");
    expect(out).toContain(AGENT_OUTPUT);
    expect(out).toContain("RLGB-DEF-EXPLORE");
    expect(out).toContain('"totalTokens":5');
    expect(hideAgentOutput(evs, new Set(["other"]))).toBe(evs);
    const refused = [
      ev(use("r1", "Agent", { subagent_type: "Mine", prompt: "go" })),
      ev(result("r1", "Agent type 'Mine' is not allowed", true)),
    ];
    expect(hideAgentOutput(refused, new Set(["mine"]))).toBe(refused);
  });
});

// An empty PATH: the dry run then finds no claude and no git, and runs no CLI at all.
function dryRun(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["PATH", "MSYSTEM"].includes(k.toUpperCase())) env[k] = v;
  env.PATH = NO_TOOLS;
  const r = Bun.spawnSync([process.execPath, join(ROOT, "scripts/gate/claude-checks.ts"), "--dry-run", ...args], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const out = r.stdout.toString();
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
  return (tag: string) => out.split("\n").find((l) => l.startsWith(`dry-run ${tag}:`)) ?? "";
}

describe("claude-checks.ts B35 and B36", () => {
  test("B35 plans three runs: with --agent rl-main, without it, and the stop run", () => {
    const line = dryRun("--only", "B35");
    for (const t of ["agent", "stop"]) expect(line(`b35-${t}`)).toContain('"--agent","rl-main"');
    expect(line("b35-plain")).not.toContain("--agent");
    expect(line("b35-agent")).toContain('"--tools","Read,Grep,Glob,Edit,Write,Bash,Agent"');
    expect(line("b35-plain")).toContain('"--tools","Read,Grep,Glob,Edit,Write,Bash"');
    const file = join(ROOT, ".gate0/v3-local/results.b35.dry-run.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).ownCalls).toEqual({ b35: 3 });
  });

  test("B36 plans eight runs, and nine with --opus", () => {
    const line = dryRun("--only", "B36", "--opus");
    for (const t of ["writer", "nodepth", "any", "stop", "turns", "models", "badmodel", "advisor", "opus"])
      expect(line(`b36-${t}`)).toContain('"--agent","rl-main"');
    expect(line("b36-any")).toContain('"--allowedTools","Read,Grep,Glob,Write"');
    expect(line("b36-writer")).toContain('"--allowedTools","Read,Grep,Glob,Edit,Write"');
    expect(line("b36-turns")).toContain('"--max-turns","4"');
    expect(line("b36-advisor")).toContain('"--advisor","opus"');
    const file = join(ROOT, ".gate0/v3-local/results.b36.dry-run.json");
    expect(JSON.parse(readFileSync(file, "utf8")).ownCalls).toEqual({ b36: 9 });
    dryRun("--only", "B36");
    expect(JSON.parse(readFileSync(file, "utf8")).ownCalls).toEqual({ b36: 8 });
  });
});
