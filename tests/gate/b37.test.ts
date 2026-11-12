// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate B37 helpers (scripts/gate/session.ts), the sanitizer core on B37 event shapes, and the B37 dry run. No test starts claude.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countHits, formPairs, type Json, sanitizer, scanPatterns } from "../../scripts/gate/sanitize-core";
import {
  agentOutcome,
  encodeCwd,
  labelIds,
  mainUsage,
  perProcess,
  rateLimits,
  resumeShape,
  sessionArgs,
  transcriptFacts,
  u97,
  u98,
  u99,
  u100,
  u101,
  u103,
  u104,
  u105,
  u108,
  usageOf,
  userLine,
} from "../../scripts/gate/session";
import { implementArgs } from "../../src/server/review/claude";

const ROOT = join(import.meta.dir, "../..");
const TMP = mkdtempSync(join(tmpdir(), "rl-gate-b37-test-"));
// An empty PATH folder: the dry run then finds no claude and no git, and runs no CLI at all.
const NO_TOOLS = mkdtempSync(join(tmpdir(), "rl-gate-test-path-"));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(NO_TOOLS, { recursive: true, force: true });
});
const KEPT = join(TMP, "sessions", "00000000-0000-4000-8000-000000000001.jsonl");

// The app argv of a shell step with rl-explorer, as B37 builds it.
function appArgs(appDir = join(TMP, "app")) {
  return implementArgs({
    implement: true,
    cwd: join(TMP, "work"),
    appDir,
    prompt: "",
    schema: { type: "object" },
    maxTurns: 8,
    model: "haiku",
    shell: { mode: "allowlist", rules: ["node rlgb-probe.cjs *", "sleep *"], bashTimeoutSec: 900, dataDir: join(TMP, "data"), origins: [] },
    explorer: { description: "Read-only search.", prompt: "Search read-only.", model: "haiku" },
  });
}

const assistant = (content: unknown[], usage: unknown, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content, usage },
});
const result = (blocks: unknown[]) => ({ type: "user", message: { content: blocks } });
const USAGE = { input_tokens: 2, cache_creation_input_tokens: 15227, cache_read_input_tokens: 10, output_tokens: 17 };

describe("B37 argv", () => {
  test("sessionArgs turns the implement argv into a resume with every flag and no --no-session-persistence", () => {
    const { args } = appArgs();
    expect(args).toContain("--no-session-persistence");
    const out = sessionArgs(args, { resume: KEPT });
    expect(out.slice(0, 4)).toEqual(["-p", "--resume", KEPT, "--fork-session"]);
    expect(out).not.toContain("--no-session-persistence");
    for (const f of ["--restricted", "--settings", "--agents", "--json-schema", "--max-turns"]) expect(out).toContain(f);
    expect(out[out.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,Bash,Agent");
    expect(out[out.indexOf("--agent") + 1]).toBe("rl-main");
    expect(resumeShape(out)).toBe(true);
    expect(resumeShape(args)).toBe(false);
    expect(resumeShape(sessionArgs(args))).toBe(false);
  });

  test("model and effort replace the implement values, and live adds stream-json input", () => {
    const out = sessionArgs(["-p", "--model", "haiku", "--effort", "high", "--no-session-persistence"], {
      resume: KEPT,
      model: "sonnet",
      effort: "low",
      live: true,
    });
    expect(out).toEqual([
      "-p",
      "--resume",
      KEPT,
      "--fork-session",
      "--input-format",
      "stream-json",
      "--model",
      "sonnet",
      "--effort",
      "low",
    ]);
    expect(sessionArgs(["-p", "--model", "haiku"])).toEqual(["-p", "--model", "haiku"]);
  });

  test("a resume path must be an absolute .jsonl path", () => {
    expect(() => sessionArgs(["-p"], { resume: "sessions/x.jsonl" })).toThrow("absolute .jsonl");
    expect(() => sessionArgs(["-p"], { resume: join(TMP, "x.json") })).toThrow("absolute .jsonl");
  });

  test("userLine writes one stream-json user message per line", () => {
    const line = userLine("Run this:\n```\nnode rlgb-probe.cjs b37live\n```");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: "Run this:\n```\nnode rlgb-probe.cjs b37live\n```" },
      parent_tool_use_id: null,
    });
  });

  test("encodeCwd gives the per-cwd folder name of Claude Code", () => {
    expect(encodeCwd("C:\\Users\\x\\rl-gb-b37-AB\\work")).toBe("C--Users-x-rl-gb-b37-AB-work");
    expect(encodeCwd("/tmp/rl-gb-b37-AB/work")).toBe("-tmp-rl-gb-b37-AB-work");
  });
});

describe("B37 event readers", () => {
  test("mainUsage counts the main-thread assistant events with all three token fields", () => {
    const events = [
      assistant([], USAGE),
      assistant([], USAGE, "toolu_1"),
      assistant([], { input_tokens: 3, output_tokens: 1 }),
      assistant([], { ...USAGE, cache_read_input_tokens: 15227, cache_creation_input_tokens: 100 }),
      { type: "result" },
    ];
    expect(mainUsage(events)).toEqual({ events: 3, complete: 2, firstCacheRead: 10, context: 2 + 15227 + 100 });
    expect(mainUsage([])).toEqual({ events: 0, complete: 0, firstCacheRead: null, context: null });
  });

  test("rateLimits reads the status, type, and unit of resetsAt", () => {
    const now = 1_791_670_000_000;
    const ev = (resetsAt: unknown) => ({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt, rateLimitType: "five_hour" },
    });
    const r = rateLimits(
      [ev(1_791_678_600), ev(1_791_678_600_000), { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }],
      now,
    );
    expect(r.map((x) => [x.status, x.type, x.resetsAt, x.unit, x.inMin])).toEqual([
      ["allowed", "five_hour", 1_791_678_600, "s", 143],
      ["allowed", "five_hour", 1_791_678_600_000, "ms", 143],
      ["rejected", "absent", null, "absent", null],
    ]);
    expect(r[0]?.keys).toEqual(["rateLimitType", "resetsAt", "status"]);
  });

  test("usageOf reads the last result, and perProcess decides only on a lower resumed value", () => {
    const res = (cost: number, output: number) => ({
      type: "result",
      total_cost_usd: cost,
      usage: { input_tokens: 4, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 },
      modelUsage: { "claude-haiku-5-5": {} },
    });
    const first = usageOf([res(9, 9), res(0.05, 300)]);
    expect(first).toEqual({ cost: 0.05, input: 4, output: 300, cacheRead: 5, cacheCreation: 6, models: ["claude-haiku-5-5"] });
    expect(usageOf([{ type: "assistant" }])).toBeNull();
    expect(perProcess(first, [usageOf([res(0.08, 320)]), usageOf([res(0.02, 40)])], "output")).toBe("per process");
    expect(perProcess(first, [usageOf([res(0.08, 320)])], "cost")).toBe("not decided (each resumed value >= run 1)");
    expect(perProcess(null, [first], "cost")).toBe("unknown");
    expect(perProcess(first, [null], "cost")).toBe("unknown");
  });

  test("agentOutcome tells a refused call from a run, and lists the ok writes of the child", () => {
    const events = [
      assistant(
        [
          { type: "tool_use", id: "gp", name: "Agent", input: { subagent_type: "general-purpose" } },
          { type: "tool_use", id: "ex", name: "Agent", input: { subagent_type: "rl-explorer" } },
        ],
        USAGE,
      ),
      result([{ type: "tool_result", tool_use_id: "gp", is_error: true, content: "Agent type 'general-purpose' not found." }]),
      { type: "system", subtype: "task_started", tool_use_id: "ex" },
      assistant(
        [
          { type: "tool_use", id: "r1", name: "Read", input: {} },
          { type: "tool_use", id: "w1", name: "Write", input: {} },
        ],
        USAGE,
        "ex",
      ),
      result([
        { type: "tool_result", tool_use_id: "r1", content: "1→RLGB-B2" },
        { type: "tool_result", tool_use_id: "w1", is_error: true, content: "No such tool available: Write" },
      ]),
    ];
    expect(agentOutcome(events, "general-purpose")).toEqual({ state: "refused", tools: [], writes: [] });
    expect(agentOutcome(events, "rl-explorer")).toEqual({ state: "ran", tools: ["Read", "Write"], writes: [] });
    expect(agentOutcome(events, "other")).toEqual({ state: "absent", tools: [], writes: [] });
    const wrote = events.map((e) =>
      e.type === "user" ? result([{ type: "tool_result", tool_use_id: "w1", content: "File created" }]) : e,
    );
    expect(agentOutcome(wrote, "rl-explorer").writes).toEqual(["Write"]);
  });

  test("transcriptFacts sees a cut last line", () => {
    const whole = `${JSON.stringify({ type: "user" })}\n${JSON.stringify({ type: "assistant", text: "RLGB-K5" })}\n`;
    expect(transcriptFacts(whole, "RLGB-K5")).toEqual({ lines: 2, lastWhole: true, endsWithNewline: true, holds: true });
    expect(transcriptFacts(`${whole}{"type":"assi`, "RLGB-X")).toEqual({
      lines: 3,
      lastWhole: false,
      endsWithNewline: false,
      holds: false,
    });
  });

  test("labelIds replaces the session IDs and every other ID in file names", () => {
    const run1 = "0f3a2b1c-1111-4222-8333-444455556666";
    const names = [`${run1}.jsonl (900 B)`, `${run1}/subagents/agent-a1b2c3d4e5f6a7b8.jsonl (12 B)`, "memory/MEMORY.md (3 B)"];
    expect(labelIds(names, { [run1]: "<run1>", "": "<none>" })).toEqual([
      "<run1>.jsonl (900 B)",
      "<run1>/subagents/agent-<id>.jsonl (12 B)",
      "memory/MEMORY.md (3 B)",
    ]);
    expect(labelIds(["9e8d7c6b-1111-4222-8333-444455556666.jsonl"], {})).toEqual(["<id>.jsonl"]);
  });
});

describe("B37 judges", () => {
  const argv = sessionArgs(appArgs().args, { resume: KEPT });
  const allowed = [...appArgs().allowed];
  const want = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "Agent"];
  const init = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "StructuredOutput"];

  test("U97 passes only with the resume shape, the exact tools, the default mode, and a parsed result", () => {
    const ok = { argv, exit: 0, tools: init, want, allowed, mode: "default", zod: "ok" };
    expect(u97(ok).status).toBe("PASS");
    expect(u97({ ...ok, tools: init.filter((t) => t !== "Bash") }).evidence).toContain("missing=Bash");
    expect(u97({ ...ok, tools: [...init, "WebFetch"] }).status).toBe("FAIL");
    expect(u97({ ...ok, mode: "dontAsk" }).status).toBe("FAIL");
    expect(u97({ ...ok, zod: "summary: Required" }).status).toBe("FAIL");
    expect(u97({ ...ok, argv: [...argv, "--no-session-persistence"] }).status).toBe("FAIL");
    expect(u97({ ...ok, tools: null }).evidence).toContain("init.tools=no init");
  });

  test("U98 needs each refusal with its app label and the probe marker", () => {
    const ok = {
      write: { state: "refused", file: false },
      git: { state: "refused", label: "deny" },
      unlisted: { state: "refused", label: "allowlist", marker: false },
      compound: { state: "refused", label: "deny", marker: false },
      probe: { state: "ran", label: "none", marker: true },
    };
    expect(u98(ok).status).toBe("PASS");
    expect(u98({ ...ok, unlisted: { state: "ran", label: "none", marker: true } }).status).toBe("FAIL");
    expect(u98({ ...ok, git: { state: "refused", label: "check" } }).status).toBe("FAIL");
    expect(u98({ ...ok, write: { state: "not tried", file: false } }).status).toBe("FAIL");
    expect(u98({ ...ok, compound: { state: "refused", label: "deny", marker: true } }).status).toBe("FAIL");
  });

  test("U99 passes when init has no Bash and no agent tool, and no Bash call ran", () => {
    const tools = ["Read", "Grep", "Glob", "Edit", "Write", "StructuredOutput"];
    expect(u99({ exit: 0, tools, bash: { state: "not tried" }, marker: false }).status).toBe("PASS");
    expect(u99({ exit: 0, tools: [...tools, "Task"], bash: { state: "not tried" }, marker: false }).status).toBe("FAIL");
    expect(u99({ exit: 0, tools, bash: { state: "ran" }, marker: true }).status).toBe("FAIL");
    expect(u99({ exit: 1, tools, bash: { state: "not tried" }, marker: false }).status).toBe("FAIL");
  });

  test("U100 needs the new text of both files and the final edit; the stale Edit is INFO", () => {
    const marks = { old: "RLGB-A1", newA: ["RLGB-A2", "RLGB-A3"], newB: "RLGB-B2", edited: "RLGB-A4" };
    const ok = {
      setup: "ran",
      stale: { state: "refused", text: "File has been modified since read" },
      readA: "1→RLGB-A2",
      readB: "1→RLGB-B2",
      final: "RLGB-A4",
      marks,
    };
    const f = u100(ok);
    expect(f.status).toBe("PASS");
    expect(f.evidence).toContain('INFO: run 1 Write of a.txt=ran; Edit before a new Read=refused "modified since read"=true');
    expect(u100({ ...ok, stale: { state: "ran", text: "" }, readA: "1→RLGB-A3" }).status).toBe("PASS");
    expect(u100({ ...ok, readA: "1→RLGB-A1" }).status).toBe("FAIL");
    expect(u100({ ...ok, readB: "1→RLGB-B0" }).status).toBe("FAIL");
    expect(u100({ ...ok, final: "RLGB-A3" }).status).toBe("FAIL");
  });

  test("U101 passes when the resume knows the Write without a tool call", () => {
    const ok = { killed: true, wroteFirst: true, kept: true, exit: 0, summary: "repo/k.txt: RLGB-K5", marker: "RLGB-K5", calls: [] };
    expect(u101(ok).status).toBe("PASS");
    expect(u101({ ...ok, calls: ["Read"] }).status).toBe("INFO");
    expect(u101({ ...ok, summary: "none" }).status).toBe("FAIL");
    expect(u101({ ...ok, killed: false }).status).toBe("FAIL");
    expect(u101({ ...ok, exit: 1 }).status).toBe("FAIL");
  });

  test("U103 needs both transcripts in place, a new fork ID, the resume, and the unchanged moved file", () => {
    const ok = { placed: [true, true], newId: true, files: [["<run1>.jsonl (9 B)"], []], resumed: true, kept: true };
    expect(u103(ok).status).toBe("PASS");
    expect(u103(ok).evidence).toContain("files run 1=[<run1>.jsonl (9 B)] run 2=[]");
    expect(u103({ ...ok, placed: [true, false] }).status).toBe("FAIL");
    expect(u103({ ...ok, placed: [true] }).status).toBe("FAIL");
    expect(u103({ ...ok, newId: false }).status).toBe("FAIL");
    expect(u103({ ...ok, kept: false }).status).toBe("FAIL");
  });

  test("U104 needs the sent message, the marker, structured_output, and an exit", () => {
    const ok = {
      sent: true,
      marker: true,
      structured: true,
      results: 1,
      queued: [0],
      waited: true,
      exitedBeforeClose: false,
      exitAfterCloseMs: 120,
      exit: 0,
    };
    expect(u104(ok).status).toBe("PASS");
    expect(u104(ok).evidence).toContain("exit=0, exit 120 ms after the close; INFO: waits for stdin after a result=true");
    expect(u104({ ...ok, exitAfterCloseMs: null }).evidence).toContain("no exit within the limit after the close");
    const early = u104({ ...ok, waited: null, exitedBeforeClose: true, exitAfterCloseMs: null });
    expect(early.status).toBe("PASS");
    expect(early.evidence).toContain("exit before the close; INFO: waits for stdin after a result=false");
    expect(u104({ ...ok, exitAfterCloseMs: null }).status).toBe("FAIL");
    expect(u104({ ...ok, marker: false }).status).toBe("FAIL");
    expect(u104({ ...ok, sent: false }).status).toBe("FAIL");
  });

  test("U105 needs all three token fields on each main-thread assistant event", () => {
    const ok = [{ name: "run1", events: [assistant([], USAGE), assistant([], { input_tokens: 1 }, "toolu_1")] }];
    expect(u105(ok).status).toBe("PASS");
    expect(u105([...ok, { name: "run2", events: [assistant([], { input_tokens: 1, output_tokens: 2 })] }]).status).toBe("FAIL");
    expect(u105([{ name: "run1", events: [] }])).toEqual({ id: "U105", status: "FAIL", evidence: "no main-thread assistant event" });
  });

  test("U108 needs a refused general-purpose call and an explorer run with no write", () => {
    const ran = { state: "ran", tools: ["Read"], writes: [] };
    expect(u108({ gp: { state: "refused", tools: [], writes: [] }, ex: ran, explorerFile: false }).status).toBe("PASS");
    expect(u108({ gp: { state: "absent", tools: [], writes: [] }, ex: ran, explorerFile: false }).status).toBe("FAIL");
    expect(u108({ gp: { state: "refused", tools: [], writes: [] }, ex: { ...ran, writes: ["Write"] }, explorerFile: true }).status).toBe(
      "FAIL",
    );
  });
});

describe("sanitizer core on B37 output", () => {
  const home = "C:\\Users\\jdoe";
  const sid = "0f3a2b1c-1111-4222-8333-444455556666";
  const work = `${home}\\AppData\\Local\\Temp\\rl-gb-b37-AB12\\work`;
  const events: Json[] = [
    {
      type: "system",
      subtype: "init",
      cwd: work,
      session_id: sid,
      memory_paths: { auto: `${home}\\.claude\\projects\\${encodeCwd(work)}\\memory` },
      messaging_socket_path: `${home}\\AppData\\Local\\Temp\\claude-sock`,
    },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1791678600, rateLimitType: "five_hour" }, session_id: sid },
    result([
      { type: "tool_result", tool_use_id: "w1", is_error: true, content: `Write refused: ${work.replaceAll("\\", "/")}/../outside.txt` },
    ]) as Json,
    { type: "system", subtype: "hook_response", output: "jdoe was here" },
  ];
  const tokens = new Map([["jdoe", "user"]]);
  const uuids = new Map([[sid, "00000000-0000-4000-8000-000000000001"]]);
  const { res } = scanPatterns(tokens, [home], uuids.keys());

  test("the raw events hold the real values, and the sanitized events hold none", () => {
    const raw = events.map((e) => JSON.stringify(e));
    expect(countHits(raw, res)).toBeGreaterThan(0);
    const { sanitize } = sanitizer(tokens, formPairs(home, "C:\\Users\\user"), uuids);
    const out = events.map((e) => JSON.stringify(sanitize(e)));
    expect(countHits(out, res)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(encodeCwd("C:\\Users\\user\\AppData\\Local\\Temp\\rl-gb-b37-AB12\\work"));
    expect(text).toContain("C:/Users/user/AppData/Local/Temp/rl-gb-b37-AB12/work/../outside.txt");
    expect(text).toContain("00000000-0000-4000-8000-000000000001");
    expect(text).toContain('"output":"<hook output>"');
  });
});

describe("claude-checks.ts B37", () => {
  test("a dry run plans eight runs with the session flags", () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["PATH", "MSYSTEM"].includes(k.toUpperCase())) env[k] = v;
    env.PATH = NO_TOOLS;
    const r = Bun.spawnSync([process.execPath, join(ROOT, "scripts/gate/claude-checks.ts"), "--dry-run", "--only", "B37"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    const out = r.stdout.toString();
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(out).toContain("DRY-RUN  B37  calls=8 planned claude calls=8; shell rules=2; other model=sonnet effort=low");
    const line = (tag: string) => out.split("\n").find((l) => l.startsWith(`dry-run b37-${tag}:`)) ?? "";
    for (const tag of ["run1-create", "run2-resume", "run3-nobash", "run4-model", "run5-kill", "run6-after-kill", "run7-live"]) {
      expect(line(tag)).toContain('"--restricted"');
      expect(line(tag)).not.toContain("--no-session-persistence");
    }
    for (const tag of ["run2-resume", "run3-nobash", "run4-model", "run6-after-kill"]) expect(line(tag)).toContain('"--fork-session"');
    for (const tag of ["run1-create", "run5-kill", "run7-live"]) expect(line(tag)).not.toContain("--resume");
    expect(line("run2-resume")).toContain('"--tools","Read,Grep,Glob,Edit,Write,Bash,Agent"');
    expect(line("run3-nobash")).toContain('"--tools","Read,Grep,Glob,Edit,Write"');
    expect(line("run3-nobash")).not.toContain("--settings");
    expect(line("run3-nobash")).not.toContain("--agents");
    expect(line("run4-model")).toContain('"--model","sonnet","--effort","low"');
    expect(line("run7-live")).toContain('"-p","--input-format","stream-json"');
    expect(line("run8-critic")).toContain('"--no-session-persistence"');
    expect(line("run8-critic")).toContain('"--model","haiku"');
    const file = join(ROOT, ".gate0/v3-local/results.b37.dry-run.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).ownCalls).toEqual({ b37: 8 });
  });
});
