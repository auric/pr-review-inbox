// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate G-ADV helpers and its dry run. No test starts claude.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advisorInInit,
  advisorOff,
  advisorOn,
  advisorStream,
  advisorTools,
  counts,
  flagEffect,
  namesModel,
} from "../../scripts/gate/advisor";

const JSONL = [
  { type: "system", subtype: "init", tools: ["Read", "advisor"], model: "claude-sonnet-4-6", advisorModel: "opus", plugins: [] },
  {
    type: "assistant",
    message: {
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
        { type: "advisor_tool_result", tool_use_id: "srvtoolu_1", content: { type: "advisor_result", text: "x" } },
        { type: "text", text: "ok" },
      ],
      usage: { iterations: [{ type: "message" }, { type: "advisor_message", model: "claude-opus-4-6" }] },
    },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.05,
    usage: { iterations: [{ type: "advisor_message" }] },
    modelUsage: { "claude-sonnet-4-6": {}, "claude-opus-4-6": {} },
    permission_denials: [{ tool_name: "advisor" }, { tool_name: "Bash" }],
  },
]
  .map((e) => JSON.stringify(e))
  .join("\n");
const events = JSONL.split("\n").map((l) => JSON.parse(l) as unknown);

describe("Gate G-ADV helpers", () => {
  test("advisorInInit names each init key that mentions the advisor and never prints a nested value", () => {
    const init = { ...(events[0] as object), settings: { advisorModel: "opus", secret: "s3cret" } };
    expect(advisorInInit(init)).toEqual(["tools[]=advisor", "advisorModel=opus", "settings: nested"]);
    expect(advisorInInit({ type: "system", tools: ["Read"], model: "x" })).toEqual([]);
    expect(advisorInInit(undefined)).toEqual([]);
  });

  test("advisorTools reads only the init tools list", () => {
    expect(advisorTools(events[0])).toEqual(["advisor"]);
    expect(advisorTools({ tools: ["Read"] })).toEqual([]);
    expect(advisorTools(undefined)).toEqual([]);
  });

  test("advisorStream counts advisor blocks, iterations, denials, and result models", () => {
    const s = advisorStream([...events, "not an event", null]);
    expect(s.advisorCalls).toBe(1);
    expect(s.advisorResults).toBe(1);
    expect(s.advisorIterations).toBe(1);
    expect(s.resultAdvisorIterations).toBe(1);
    expect(s.advisorDenials).toBe(1);
    expect(counts(s.eventTypes)).toBe("system/init=1,assistant=1,result/success=1");
    expect(counts(s.blockTypes)).toBe("server_tool_use=1,advisor_tool_result=1,text=1");
    expect(s.results).toEqual([{ subtype: "success", isError: false, costUsd: 0.05, models: ["claude-sonnet-4-6", "claude-opus-4-6"] }]);
    expect(s.results[0]?.models.some((m) => namesModel(m, "opus"))).toBe(true);
    expect(counts({})).toBe("none");
  });

  // Run 1: slash_commands listed the /advisor command in the run without --advisor, and the gate said FAIL.
  test("advisorOff ignores slash_commands and judges by init.tools and the advisor use", () => {
    const init = { type: "system", subtype: "init", tools: ["Read"], slash_commands: ["advisor", "compact"] };
    expect(advisorOff({ init, used: false }, 1)).toBe("PASS");
    expect(advisorOff({ init, used: true }, 1)).toBe("FAIL");
    expect(advisorOff({ init: { ...init, tools: ["Read", "advisor"] }, used: false }, 1)).toBe("FAIL");
    // No control call: no advisor call proves nothing.
    expect(advisorOff({ init, used: false }, 0)).toBe("UNKNOWN");
    expect(advisorOff({ init: undefined, used: false }, 1)).toBe("UNKNOWN");
    expect(advisorOff(undefined, 1)).toBe("UNKNOWN");
  });

  // CLI 2.1.322: the --advisor run called the advisor, but init.tools did not list it, and the gate said FAIL.
  test("GADV.3 judges by advisor calls, not by init.tools", () => {
    const run = [
      { type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"], slash_commands: ["advisor"] },
      { type: "assistant", message: { content: [{ type: "server_tool_use", id: "srvtoolu_9", name: "advisor", input: {} }] } },
    ];
    expect(advisorTools(run[0])).toEqual([]);
    expect(advisorOn(advisorStream(run).advisorCalls)).toBe("PASS");
    expect(advisorOn(advisorStream(run.slice(0, 1)).advisorCalls)).toBe("FAIL");
  });

  test("GADV.5a and GADV.5b report the flag effect as text", () => {
    expect(flagEffect(2)).toBe("the flag does not remove the advisor: calls=2");
    expect(flagEffect(0)).toBe("no advisor call: calls=0");
  });

  // GADV.5b: run "advisor" omits the advisor from --tools. The control is run "tools", which lists it in --tools.
  test("GADV.5b passes when the run without the advisor in --tools makes no call and the control run calls it", () => {
    const init = { type: "system", subtype: "init", tools: ["Read"] };
    expect(advisorOff({ init, used: false }, 1)).toBe("PASS");
    expect(advisorOff({ init, used: true }, 1)).toBe("FAIL");
    expect(advisorOff({ init, used: true }, 0)).toBe("FAIL");
    expect(advisorOff({ init, used: false }, 0)).toBe("UNKNOWN");
  });
});

// An empty PATH folder: the dry run then finds no claude and runs no CLI at all.
const NO_TOOLS = mkdtempSync(join(tmpdir(), "rl-gate-test-path-"));
afterAll(() => rmSync(NO_TOOLS, { recursive: true, force: true }));

describe("claude-checks.ts GADV", () => {
  const script = join(import.meta.dir, "../../scripts/gate/claude-checks.ts");
  const run = (args: string[]) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k.toUpperCase() !== "PATH") env[k] = v;
    env.PATH = NO_TOOLS;
    const r = Bun.spawnSync([process.execPath, script, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  test("a dry run plans five runs with the app flags and --advisor", () => {
    const r = run(["--dry-run", "G-ADV", "--advisor", "opus", "--main-model", "sonnet"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY-RUN  GADV calls=5 planned claude calls=5; advisor=opus main=sonnet");
    const line = (tag: string) => r.out.split("\n").find((l) => l.startsWith(`dry-run gadv-${tag}:`)) ?? "";
    for (const tag of ["advisor", "none", "envoff", "disallowed", "tools"]) expect(line(tag)).toContain('"--restricted"');
    expect(line("advisor")).toContain('"--advisor","opus"');
    expect(line("advisor")).toContain('"--model","sonnet"');
    expect(line("none")).not.toContain("--advisor");
    expect(line("disallowed")).toContain('"--disallowedTools","advisor"');
    // Run "tools" is the control of GADV.4, 5a, 5b, and 6. The switch runs keep the advisor in --tools, so only the switch can remove it.
    for (const tag of ["tools", "envoff", "disallowed"]) {
      expect(line(tag)).toContain('"--tools","Read,Grep,Glob,advisor"');
      expect(line(tag)).toMatch(/"--allowedTools","[^"]*,advisor"/);
    }
    expect(line("advisor")).toContain('"--tools","Read,Grep,Glob"');
  });

  test("a bad model name exits 2", () => {
    const r = run(["--dry-run", "GADV", "--advisor", "a;b"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--advisor takes one model name.");
  });
});
