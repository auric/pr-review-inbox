// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate B38 helpers (scripts/gate/workflow.ts) on synthetic events, and the B38 dry run. No test starts claude.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  B38_DENY,
  b38Allow,
  b38Control,
  b38Effort,
  b38Refused,
  b38Retry,
  b38Start,
  controlRan,
  effortFields,
  markedCalls,
  type PinSeen,
  pinFact,
  pinSeen,
  streamEffort,
  withDeny,
  withoutDeny,
} from "../../scripts/gate/workflow";
import { AGENT_PARAM_DENY } from "../../src/server/review/claude";

const ROOT = join(import.meta.dir, "../..");
const NO_TOOLS = mkdtempSync(join(tmpdir(), "rl-gate-test-path-"));
afterAll(() => rmSync(NO_TOOLS, { recursive: true, force: true }));

const PIN = "rl-gb-pinned";
const call = (id: string, mark: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: {
    id: `m-${id}`,
    model: "claude-haiku-x",
    content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: PIN, prompt: `Reply with the word ${mark}.`, ...extra } }],
  },
});
const result = (id: string, text: string, isError: boolean, toolUseResult?: Record<string, unknown>) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] },
  ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
});
// The CLI shape of a refused call: a permission_denied event and an error tool_result (fixtures/claude b36 runs).
const refused = (id: string, mark: string, extra: Record<string, unknown>) => [
  call(id, mark, extra),
  {
    type: "system",
    subtype: "permission_denied",
    tool_name: "Agent",
    tool_use_id: id,
    decision_reason_type: "rule",
    decision_reason: "deny rule Agent(model:*)",
    message: "Permission to use Agent has been denied.",
  },
  result(id, "Permission to use Agent has been denied.", true),
];
// An allowed call: task_started, a child assistant event on the model, and a tool_use_result.
const ran = (id: string, mark: string, model: string, extra: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => [
  call(id, mark, extra),
  { type: "system", subtype: "task_started", task_id: `agent-${id}`, tool_use_id: id },
  { type: "assistant", parent_tool_use_id: id, message: { id: `c-${id}`, model, content: [{ type: "text", text: mark }] } },
  result(id, mark, false, { resolvedModel: model, agentId: `agent-${id}`, ...more }),
];
const seen = (events: unknown[], mark: string): PinSeen[] => markedCalls(events, PIN, mark).map((c) => pinSeen(events, c));

const CTL = "RLGB-PIN-CTL";
const MODEL = "RLGB-PIN-MODEL";
const EFFORT = "RLGB-PIN-EFFORT";
const run = [
  ...ran("t1", CTL, "claude-sonnet-x"),
  ...refused("t2", MODEL, { model: "haiku" }),
  ...ran("t3", MODEL, "claude-sonnet-x"),
  ...refused("t4", EFFORT, { effort: "high" }),
];

describe("B38 argv", () => {
  test("withDeny appends the flag, or extends its value", () => {
    expect(withDeny(["-p", "--json-schema", "{}"], B38_DENY)).toEqual([
      "-p",
      "--json-schema",
      "{}",
      "--disallowedTools",
      "Agent(model:*),Agent(effort:*)",
    ]);
    const ext = withDeny(["--disallowedTools", "mcp__x__y", "--agent", "rl-main"], B38_DENY);
    expect(ext).toEqual(["--disallowedTools", "mcp__x__y,Agent(model:*),Agent(effort:*)", "--agent", "rl-main"]);
    expect(() => withDeny(["--disallowedTools"], B38_DENY)).toThrow();
  });

  test("withoutDeny takes the rules out, and drops the flag when no rule is left", () => {
    const only = ["-p", "--disallowedTools", "Agent(model:*),Agent(effort:*)", "--agent", "rl-main"];
    expect(withoutDeny(only, B38_DENY)).toEqual(["-p", "--agent", "rl-main"]);
    const mixed = ["--disallowedTools", "mcp__x__y,Agent(model:*),Agent(effort:*)", "--agent", "rl-main"];
    expect(withoutDeny(mixed, B38_DENY)).toEqual(["--disallowedTools", "mcp__x__y", "--agent", "rl-main"]);
    expect(withoutDeny(["-p"], B38_DENY)).toEqual(["-p"]);
    // The app rules are the rules that Gate B38 checked.
    expect(AGENT_PARAM_DENY).toEqual(B38_DENY);
  });
});

describe("B38 judges", () => {
  test("start passes on exit 0 with Agent in init.tools; a missing Agent or an invalid rule fails", () => {
    const ok = { exit: 0, stderr: "", tools: ["Read", "Agent", "StructuredOutput"], agents: ["rl-main", PIN] };
    expect(b38Start("start.review", ok).status).toBe("PASS");
    expect(b38Start("start.review", { ...ok, tools: ["Read", "StructuredOutput"] }).status).toBe("FAIL");
    expect(b38Start("start.review", { ...ok, stderr: "Invalid permission rule: Agent(model:*)" }).status).toBe("FAIL");
    expect(b38Start("start.review", { ...ok, stderr: "warning: unknown terminal" }).status).toBe("PASS");
    expect(b38Start("start.review", { ...ok, exit: 1 }).status).toBe("FAIL");
    expect(b38Start("start.review", { ...ok, tools: null }).status).toBe("FAIL");
  });

  test("control passes when the call without model runs on the pinned model", () => {
    expect(b38Control("control.implement", seen(run, CTL), "sonnet").status).toBe("PASS");
    expect(controlRan(seen(run, CTL))).toBe(true);
    // Control mutation: the pinned agent runs on haiku.
    const haiku = ran("t1", CTL, "claude-haiku-x");
    expect(b38Control("control.implement", seen(haiku, CTL), "sonnet").status).toBe("FAIL");
    // Control mutation: the lead passed a model, so no control call exists.
    const withModel = ran("t1", CTL, "claude-sonnet-x", { model: "sonnet" });
    const f = b38Control("control.implement", seen(withModel, CTL), "sonnet");
    expect(f.status).toBe("FAIL");
    expect(f.evidence).toContain("run again");
  });

  test("a refused per-call model passes and records the event shape", () => {
    const f = b38Refused("model", "model", seen(run, MODEL), true);
    expect(f.status).toBe("PASS");
    expect(f.evidence).toContain("tool_name=Agent decision_reason_type=rule");
    expect(f.evidence).toContain("events under it=0");
    expect(b38Refused("effort", "effort", seen(run, EFFORT), true).status).toBe("PASS");
  });

  test("a per-call model that runs fails", () => {
    // Control mutation: no deny rule, the call runs on haiku.
    const allowed = ran("t2", MODEL, "claude-haiku-x", { model: "haiku" });
    const f = b38Refused("model", "model", seen(allowed, MODEL), true);
    expect(f.status).toBe("FAIL");
    expect(f.evidence).toContain("model=claude-haiku-x");
  });

  test("a refusal fails without the control, without the parameter, or with an error for another cause", () => {
    expect(b38Refused("model", "model", seen(run, MODEL), false).status).toBe("FAIL");
    const omitted = ran("t2", MODEL, "claude-sonnet-x");
    const f = b38Refused("model", "model", seen(omitted, MODEL), true);
    expect(f.status).toBe("FAIL");
    expect(f.evidence).toContain("not tried");
    const other = [call("t2", MODEL, { model: "haiku" }), result("t2", "Agent type not found.", true)];
    expect(b38Refused("model", "model", seen(other, MODEL), true).status).toBe("FAIL");
    const named = [call("t2", MODEL, { model: "haiku" }), result("t2", "Permission to use Agent has been denied.", true)];
    expect(b38Refused("model", "model", seen(named, MODEL), true).status).toBe("PASS");
  });

  test("retry lists the later calls of the step and their model", () => {
    const f = b38Retry("model.retry", "model", seen(run, MODEL));
    expect(f.status).toBe("INFO");
    expect(f.evidence).toContain("retry 1 without model: state=ran");
    expect(f.evidence).toContain("model=claude-sonnet-x");
    // Control mutation: no retry.
    expect(b38Retry("effort.retry", "effort", seen(run, EFFORT)).evidence).toBe("no retry after the call with effort");
  });

  test("allow passes when both runs list the agent, both controls ran, and the model was refused", () => {
    const runs = [
      { label: "review", agents: ["rl-main", PIN], control: true },
      { label: "implement", agents: ["rl-main", PIN], control: true },
    ];
    expect(b38Allow({ name: PIN, runs, modelRefused: true }).status).toBe("PASS");
    expect(b38Allow({ name: PIN, runs, modelRefused: false }).status).toBe("FAIL");
    expect(
      b38Allow({ name: PIN, runs: [runs[0] as (typeof runs)[0], { ...(runs[1] as (typeof runs)[0]), control: false }], modelRefused: true })
        .status,
    ).toBe("FAIL");
    expect(b38Allow({ name: PIN, runs: [{ label: "review", agents: ["rl-main"], control: true }], modelRefused: true }).status).toBe(
      "FAIL",
    );
  });

  test("effort fields come from meta.json and the stream; none gives not observable", () => {
    expect(effortFields({ a: { effortLevel: "low", b: [{ effort: "high" }] }, effortList: ["x"] }, "meta")).toEqual([
      "meta.a.effortLevel=low",
      "meta.a.b[0].effort=high",
    ]);
    const s = seen(run, CTL)[0] as PinSeen;
    expect(s.agentId).toBe("agent-t1");
    expect(streamEffort(run, "t1")).toEqual([]);
    const none = b38Effort([{ label: "no per-call model", seen: s, meta: { keys: ["agentType"], effort: [] }, stream: [] }]);
    expect(none.status).toBe("INFO");
    expect(none.evidence).toStartWith("not observable");
    // Control mutation: the tool_use_result names an effort level.
    const withEffort = ran("t1", CTL, "claude-sonnet-x", {}, { effortLevel: "low" });
    expect(streamEffort(withEffort, "t1")).toEqual(["tool_use_result.effortLevel=low"]);
    const found = b38Effort([{ label: "no per-call model", seen: s, meta: { keys: ["effort"], effort: ["meta.effort=low"] }, stream: [] }]);
    expect(found.evidence).not.toContain("not observable");
    expect(found.evidence).toContain("meta.effort=low");
  });

  test("pinFact shows the no-rule control call, or not called", () => {
    const allowed = ran("t9", "RLGB-PIN-HAIKU", "claude-haiku-x", { model: "haiku" });
    const f = pinFact("nodeny.model", "no deny rules, per-call model haiku", seen(allowed, "RLGB-PIN-HAIKU")[0]);
    expect(f.status).toBe("INFO");
    expect(f.evidence).toContain("state=ran asked model=haiku");
    expect(f.evidence).toContain("model=claude-haiku-x");
    expect(pinFact("nodeny.effort", "x", undefined).evidence).toBe("x: not called");
  });
});

describe("claude-checks.ts B38", () => {
  test("a dry run plans three runs, with the deny rules in the first two only", () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["PATH", "MSYSTEM"].includes(k.toUpperCase())) env[k] = v;
    env.PATH = NO_TOOLS;
    const r = Bun.spawnSync([process.execPath, join(ROOT, "scripts/gate/claude-checks.ts"), "--dry-run", "--only", "B38"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    const out = r.stdout.toString();
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    const line = (tag: string) => out.split("\n").find((l) => l.startsWith(`dry-run ${tag}:`)) ?? "";
    const deny = '"--disallowedTools","Agent(model:*),Agent(effort:*)"';
    expect(line("b38-review")).toContain(deny);
    expect(line("b38-review")).toContain('"--tools","Read,Grep,Glob,Agent"');
    expect(line("b38-implement")).toContain(deny);
    expect(line("b38-effort")).not.toContain("--disallowedTools");
    expect(line("b38-implement")).toContain("--no-session-persistence");
    expect(line("b38-effort")).not.toContain("--no-session-persistence");
    for (const t of ["review", "implement", "effort"]) expect(line(`b38-${t}`)).toContain('"--agent","rl-main"');
    const file = join(ROOT, ".gate0/v3-local/results.b38.dry-run.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).ownCalls).toEqual({ b38: 3 });
  });
});
