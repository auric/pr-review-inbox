// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v3.md WP-V5: the opt-in variant "codegraph", an app-run CodeGraph server on the sanitized snapshot. Pure parts, then
// review runs with the fake CLI, the fake codegraph, a temp git remote, and a temp data folder. No test starts the real CLI or codegraph.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import {
  codegraphLine,
  ISSUE_LINES,
  type McpUse,
  mainAgent,
  mcpLines,
  NO_CONTEXT,
  promptVersion,
  type ReviewContext,
  reviewerAgent,
  SHIPPED_PROFILES,
  salvageAgent,
  verifierAgent,
  verifyAgent,
  withMcp,
} from "../../src/server/review/catalog";
import { APP_CODEGRAPH, appCodegraphEntry } from "../../src/server/review/codegraph";
import { type Candidate, candidatesFile } from "../../src/server/review/context-files";
import { createReviewJobs } from "../../src/server/review/jobs";
import { buildPrompt, type PromptInput } from "../../src/server/review/prompt";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { ProfileInput, RunDetail, RunDto, Variant } from "../../src/shared/dto";
import { type AnchoredFinding, REVIEW_PROMPT_VERSION, reviewJsonSchema, verifyJsonSchema } from "../../src/shared/review";
import { FAKE_TOKEN, FAKE_USER } from "../support/fake-bitbucket";
import { readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, reviewRemote, stubListTools } from "../support/review-fixture";

const MAIN = join(import.meta.dir, "../../src/server/main.ts");

process.env.REVIEW_LOOP_SECRETS = "memory";
console.log(`codegraph-default.test.ts imported from ${Bun.resolveSync("../../src/server/review/jobs", import.meta.dir)}`);

const SLOW = 120_000;
const FAKE_CG = join(import.meta.dir, "../support/fake-codegraph/codegraph.js");
type Shipped = (typeof SHIPPED_PROFILES)[number];
const general = SHIPPED_PROFILES[0] as Shipped;
const withV = (p: Shipped, ...v: Variant[]) => ({ ...p, variants: [...p.variants, ...v] });
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const FULL: ReviewContext = {
  taskFile: true,
  attachments: true,
  history: true,
  questions: true,
  rereview: false,
  instructions: true,
  goal: true,
  prContext: true,
  notes: true,
};
const input: PromptInput = {
  mergeBase: "a".repeat(40),
  head: "b".repeat(40),
  note: "NOTE",
  profile: general,
  pr: { project: "P", repo: "r", prId: 1, webUrl: null },
  tasks: [],
  taskFile: true,
  attachments: true,
  history: true,
  questions: true,
  prContext: true,
  notes: true,
  instructions: "# Project instructions\n\nRULE\n",
};
const USER: McpUse[] = [
  { server: "fake", tools: ["lookup", "read_item"], remote: false },
  { server: "jira", tools: ["get_issue"], remote: true },
];
const APP: McpUse = { server: "codegraph", tools: ["codegraph_explore"], remote: false, app: true };

const finding = (line: number): AnchoredFinding =>
  ({
    path: "src/a.ts",
    side: "new",
    line,
    lineEnd: null,
    anchorText: `const x${line} = ${line};`,
    severity: "major",
    category: "Correctness",
    body: `Body ${line}.`,
    evidence: `src/a.ts:${line}`,
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
    title: `Title ${line}`,
    trigger: `Trigger ${line}.`,
    cause: null,
    rule: "",
    module: "core",
    anchor: {
      path: "src/a.ts",
      line,
      lineEnd: line,
      state: "exact",
      excerpt: [{ n: line, kind: "add", text: `const x${line} = ${line};` }],
    },
  }) as AnchoredFinding;

// The bytes of tests/review/passes.test.ts defaultBytes for the profiles p gives.
function defaultBytes(p: (s: Shipped) => Shipped) {
  const agents: string[] = [];
  for (const s of SHIPPED_PROFILES)
    for (const c of [NO_CONTEXT, FULL]) {
      const q = p(s);
      agents.push(
        mainAgent(q, c).prompt,
        reviewerAgent(q, c).prompt,
        reviewerAgent(q, c, true).prompt,
        verifyAgent(q, c, true, true, true).prompt,
        verifierAgent(q, c, true, true).prompt,
        salvageAgent(q).prompt,
      );
    }
  const stdin = [buildPrompt({ ...input, profile: p(general) }), buildPrompt({ ...input, profile: p(general), questions: false })];
  const schemas = [reviewJsonSchema(false, false), reviewJsonSchema(true, false), verifyJsonSchema(false), verifyJsonSchema(true)];
  const cands: Candidate[] = [1, 2, 3].map((l, i) => ({ n: i + 1, finding: finding(l), group: l < 3 ? 1 : null, from: null }));
  const file = candidatesFile(cands, [{ text: "Q?", why: "W." }], ["Risk."]).file.text;
  return {
    agents: sha(agents.join("\n---\n")),
    stdin: sha(stdin.join("\n---\n")),
    schemas: sha(schemas.map((s) => JSON.stringify(s)).join("\n---\n")),
    candidates: sha(file),
  };
}

// The MCP lines of the user servers in each shipped profile. First pinned at main f96ed42. The Explain question rules of 2026-11-23 changed it.
function mcpBytes() {
  const out: string[] = [];
  for (const p of SHIPPED_PROFILES)
    for (const issues of [false, true])
      for (const used of [[], USER, USER.slice(0, 1)])
        out.push(
          withMcp(mainAgent(p, NO_CONTEXT), used, issues).prompt,
          withMcp(reviewerAgent(p, NO_CONTEXT), used, issues).prompt,
          mcpLines(used, issues).join("\n"),
        );
  return sha(out.join("\n---\n"));
}

describe("variant codegraph: prompts (review-v3.md WP-V5)", () => {
  test("the variant alone changes no prompt, stdin, schema, or candidates.md; the user MCP lines keep the bytes of main", () => {
    // The hashes that tests/review/passes.test.ts pins for main.
    const main = {
      agents: "ef2425086d5d5a9675e0bc1f6da32165cb0b074200ff88df6f0e10eee7db9148",
      stdin: "6e2209d2e28204fe397333590c8813ac50a96c659cb7dba9b55ccd4b037a62bc",
      schemas: "ba9856660e7af30f719ff44e874af06e6defd430ed222db830311e8f814484fe",
      candidates: "d80a93c3b1ebd4eb0d7857f3b53bd99eea168143571c4ce11d9511f4c373b32d",
    };
    expect(defaultBytes((s) => s)).toEqual(main);
    expect(defaultBytes((s) => withV(s, "codegraph"))).toEqual(main);
    expect(mcpBytes()).toBe("1ed42b00e77744f3974dc4faa7d89b8bbb7071d70835885054e24e61683beb10");
    expect(promptVersion(withV(general, "codegraph"))).toBe(`${REVIEW_PROMPT_VERSION}+codegraph`);
  });

  test("the app server gets the CodeGraph line after the user lines, and no user or issue lines of its own", () => {
    const line = codegraphLine(["mcp__codegraph__codegraph_explore"]);
    expect(line).toBe(
      "The app indexed ./repo for these CodeGraph tools: mcp__codegraph__codegraph_explore. Use them to find the callers and dependents of each changed symbol.",
    );
    expect(mcpLines([APP], true)).toEqual([line]);
    expect(mcpLines([...USER, APP], true)).toEqual([...mcpLines(USER, true), line]);
    expect(mcpLines([APP], true)).not.toContain(ISSUE_LINES[0]);
  });

  test("the app entry runs only the given executable, never npx", () => {
    expect(APP_CODEGRAPH).toEqual(["codegraph"]);
    expect(appCodegraphEntry(APP_CODEGRAPH)).toEqual({ type: "stdio", command: "codegraph", args: ["serve", "--mcp"], env: {} });
    expect(appCodegraphEntry(["node", "/x/codegraph.js"])).toEqual({
      type: "stdio",
      command: "node",
      args: ["/x/codegraph.js", "serve", "--mcp"],
      env: {},
    });
  });
});

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Call = {
  argv: string[];
  cwd: string;
  mcp: Record<string, { command: string; args: string[]; env: Record<string, string> }> | null;
  agents: Record<string, { prompt: string; tools?: string[] }>;
};
type CgCall = { cmd: string; args: string[]; cwd: string; env: Record<string, string | null> };
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;
const NONE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const RESULT = { summary: "One line.", risks: [], questions: [], coverage: NONE, findings: [] };
const LINE = codegraphLine(["mcp__codegraph__codegraph_explore"]);
const FULL_NAME = /^mcp__([A-Za-z0-9-]+)__([A-Za-z0-9_-]+)$/;

// The CLI exposes a server tool only as mcp__<server>__<tool>. In each agent prompt of a run, a tool of a run server appears only by
// that full name, and each full name in a prompt is in the agent tools and in --allowedTools. Returns the full names in the prompts.
function expectFullToolNames(c: Call): string[] {
  const allowed = flag(c.argv, "--allowedTools").split(",");
  const denied = c.argv.includes("--disallowedTools") ? flag(c.argv, "--disallowedTools").split(",") : [];
  const tools = [...allowed, ...denied].flatMap((t) => FULL_NAME.exec(t)?.slice(2, 3) ?? []);
  const seen: string[] = [];
  for (const [agent, def] of Object.entries(c.agents)) {
    for (const tool of tools)
      expect({ agent, tool, bare: new RegExp(`(?<!\\w)${tool}(?!\\w)`).test(def.prompt) }).toMatchObject({ bare: false });
    for (const full of def.prompt.match(/mcp__[A-Za-z0-9-]+__[A-Za-z0-9_-]+/g) ?? []) {
      expect({ agent, full, tool: def.tools?.includes(full), allowed: allowed.includes(full) }).toMatchObject({
        tool: true,
        allowed: true,
      });
      seen.push(full);
    }
  }
  return seen;
}

// command: the codegraph argv prefix of the app. Absent: a wrapper of the fake codegraph that logs each call. mode: FAKE_CG.
async function setup(o: { mode?: string; command?: string[]; pick?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rl-cgdef-"));
  dirs.push(root);
  const remote = await reviewRemote(root, { 2: "source" });
  const runner = fakeRunner(root);
  const log = join(root, "cg.jsonl");
  const bin = join(root, "bin");
  mkdirSync(bin);
  // The file name makes the app treat the wrapper as codegraph. The fake reads its env when it loads.
  const wrapper = join(bin, "codegraph.js");
  writeFileSync(
    wrapper,
    `process.env.FAKE_CG_LOG = ${JSON.stringify(log)};\nprocess.env.FAKE_CG = ${JSON.stringify(o.mode ?? "")};\nawait import(${JSON.stringify(pathToFileURL(FAKE_CG).href)});\n`,
  );
  const config = join(root, "claude-config");
  mkdirSync(config);
  writeFileSync(
    join(config, ".claude.json"),
    JSON.stringify({ mcpServers: { cg: { command: process.execPath, args: [wrapper, "serve", "--mcp"], env: {} } } }),
  );
  const profiles: ProfileInput[] = [
    general,
    { ...general, id: "cg", name: "CodeGraph", variants: ["codegraph"], reviewer: { ...general.reviewer, mode: "always" } },
    {
      ...general,
      id: "pick",
      name: "Pick",
      variants: ["codegraph"],
      mcp: [{ server: "cg", tools: ["codegraph_explore"] }],
      reviewer: { ...general.reviewer, mode: "always" },
    },
  ];
  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: "http://127.0.0.1:9", userSlug: FAKE_USER, notifications: false, markAi: false, profiles });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const review = createReviewJobs({
    settings,
    live: createLive(),
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: remote.gitRemote,
    listTools: stubListTools,
    claudeConfigDir: config,
    codegraphCommand: o.command ?? [process.execPath, wrapper],
  });
  cleanup.unshift(async () => {
    await review.stop();
    settings.close();
  });
  const { id: pr } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
        source_branch, target_branch, updated_date, on_dashboard, followed)
      VALUES ('PROJ', 'repo', 2, 'Synthetic change', NULL, 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target,
        'feature', 'main', 1000, 1, 1) RETURNING id`,
    )
    .get({ source: remote.source, target: remote.target }) as { id: number };
  // The init event lists the servers of the run as connected, as the real CLI does.
  const stream = claudeStream(root, "s", "claude-synthetic/review-agent-tree.jsonl", RESULT);
  const events = readFileSync(stream, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .map((e) =>
      e.type === "system" && e.subtype === "init"
        ? {
            ...e,
            mcp_servers: [...e.mcp_servers, ...["codegraph", "cg"].map((name) => ({ name, status: "connected", source: "dynamic" }))],
          }
        : e,
    );
  writeFileSync(stream, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  runner.write({ fixture: stream });
  const run = async (profile: string) => {
    const r = review.review(db, pr, profile);
    expect(r.status).toBe(202);
    await review.wait();
    return review.run(db, (r as { run: RunDto }).run.id) as RunDetail;
  };
  const finder = () =>
    readRecords<Call>(join(root, "calls.jsonl")).find(
      (c) => c.argv?.includes("-p") && !flag(c.argv, "--json-schema").includes('"verdicts"'),
    ) as Call;
  const cg = () => (existsSync(log) ? readRecords<CgCall>(log) : []);
  const runs = () => readRecords<Call>(join(root, "calls.jsonl")).filter((c) => c.argv?.includes("-p"));
  return { root, dir, run, finder, runs, cg, wrapper };
}

describe("variant codegraph: review runs with the fake CLI (review-v3.md WP-V5)", () => {
  test(
    "switch off: no codegraph process, no server, no tool, no line",
    async () => {
      const h = await setup();
      const d = await h.run("general");
      expect(d.run.status).toBe("completed");
      expect(h.cg()).toEqual([]);
      const c = h.finder();
      expect(Object.keys(c.mcp ?? {})).not.toContain("codegraph");
      expect(flag(c.argv, "--allowedTools")).not.toContain("mcp__codegraph");
      expect(c.agents["rl-main"]?.prompt).not.toContain("CodeGraph");
      expect(d.run.summary?.coverage.unavailable.filter((g) => g.startsWith("CodeGraph"))).toEqual([]);
    },
    SLOW,
  );

  test(
    "switch on and found: the app indexes repo/ of the snapshot, pins the server to it, allows only read-only tools, and adds the line",
    async () => {
      const h = await setup();
      const d = await h.run("cg");
      expect(d.run.status).toBe("completed");
      const c = h.finder();
      const repo = join(c.cwd, "repo").toLowerCase();
      const calls = h.cg();
      // init and status index repo/. serve lists the tools on the pinned entry.
      expect(calls.map((x) => [x.cmd, x.cwd.toLowerCase()]).slice(0, 2)).toEqual([
        ["init", repo],
        ["status", repo],
      ]);
      const serve = calls.find((x) => x.cmd === "serve") as CgCall;
      expect(serve.args.map((a) => a.toLowerCase())).toEqual(["--mcp", "--path", repo, "--no-watch"]);
      expect(serve.env).toMatchObject({ DO_NOT_TRACK: "1", CODEGRAPH_NO_UPDATE_CHECK: "1", CODEGRAPH_NO_DOWNLOAD: "1" });
      expect(calls.every((x) => !x.args.includes("npx"))).toBe(true);
      const s = c.mcp?.codegraph as { command: string; args: string[]; env: Record<string, string> };
      expect([s.command, ...s.args].map((a) => a.toLowerCase())).toEqual(
        [
          process.execPath,
          MAIN,
          "--codegraph-mcp",
          "codegraph",
          "--",
          process.execPath,
          h.wrapper,
          "serve",
          "--mcp",
          "--path",
          repo,
          "--no-watch",
        ].map((a) => a.toLowerCase()),
      );
      expect(s.env).toMatchObject({
        CODEGRAPH_NO_DAEMON: "1",
        DO_NOT_TRACK: "1",
        CODEGRAPH_NO_UPDATE_CHECK: "1",
        CODEGRAPH_NO_DOWNLOAD: "1",
      });
      expect(flag(c.argv, "--allowedTools").split(",")).toContain("mcp__codegraph__codegraph_explore");
      expect(flag(c.argv, "--allowedTools")).not.toContain("codegraph_note");
      expect(flag(c.argv, "--disallowedTools").split(",")).toContain("mcp__codegraph__codegraph_note");
      expect(c.agents["rl-main"]?.prompt.split("\n")).toContain(LINE);
      expect(Object.keys(c.agents)).toContain("rl-reviewer");
      expect(h.runs().flatMap(expectFullToolNames)).toContain("mcp__codegraph__codegraph_explore");
      expect(existsSync(join(h.dir, "cache", "codegraph", "PROJ", "repo", "codegraph.db"))).toBe(true);
      expect(d.run.summary?.coverage.unavailable.filter((g) => g.startsWith("CodeGraph"))).toEqual([]);
    },
    SLOW,
  );

  test(
    "switch on and missing: one gap line, no server, no line, and the run goes on",
    async () => {
      const h = await setup({ command: [join(tmpdir(), "rl-no-such-dir", "codegraph")] });
      const d = await h.run("cg");
      // A gap line that the app adds makes the run incomplete (judge.ts).
      expect(d.run.status).toBe("incomplete");
      expect(h.cg()).toEqual([]);
      const c = h.finder();
      expect(Object.keys(c.mcp ?? {})).not.toContain("codegraph");
      expect(c.agents["rl-main"]?.prompt).not.toContain(LINE);
      expect(d.run.summary?.coverage.unavailable).toContain("CodeGraph: the codegraph executable is not installed");
    },
    SLOW,
  );

  test(
    "switch on and a failed index: one gap line, no server, no line, and the run goes on",
    async () => {
      const h = await setup({ mode: "fail" });
      const d = await h.run("cg");
      expect(d.run.status).toBe("incomplete");
      expect(h.cg().map((x) => x.cmd)).toEqual(["init"]);
      const c = h.finder();
      expect(Object.keys(c.mcp ?? {})).not.toContain("codegraph");
      expect(flag(c.argv, "--allowedTools")).not.toContain("mcp__codegraph");
      expect(c.agents["rl-main"]?.prompt).not.toContain(LINE);
      expect(d.run.summary?.coverage.unavailable).toContain("CodeGraph: no index (codegraph init or sync failed)");
    },
    SLOW,
  );

  test(
    "switch on and no read-only tool: one gap line, no server, no line",
    async () => {
      const h = await setup({ mode: "unmarked" });
      const d = await h.run("cg");
      expect(d.run.status).toBe("incomplete");
      expect(h.cg().map((x) => x.cmd)).toEqual(["init", "status", "serve"]);
      const c = h.finder();
      expect(Object.keys(c.mcp ?? {})).not.toContain("codegraph");
      expect(c.agents["rl-main"]?.prompt).not.toContain(LINE);
      expect(d.run.summary?.coverage.unavailable).toContain("CodeGraph: the server has no read-only tools");
    },
    SLOW,
  );

  test(
    "a picked codegraph server and the switch: one index, the picked server only, no app line",
    async () => {
      const h = await setup();
      const d = await h.run("pick");
      expect(d.run.status).toBe("completed");
      expect(h.cg().filter((x) => x.cmd === "init" || x.cmd === "sync")).toHaveLength(1);
      const c = h.finder();
      expect(c.mcp?.cg).toBeDefined();
      expect(Object.keys(c.mcp ?? {})).not.toContain("codegraph");
      expect(flag(c.argv, "--allowedTools")).toContain("mcp__cg__codegraph_explore");
      expect(c.agents["rl-main"]?.prompt).not.toContain(LINE);
      expect(Object.keys(c.agents)).toContain("rl-reviewer");
      expect(h.runs().flatMap(expectFullToolNames)).toContain("mcp__cg__codegraph_explore");
    },
    SLOW,
  );
});

describe("variant codegraph: eval runner (review-v3.md WP-V5)", () => {
  test("a real eval run with the variant and no codegraph on PATH exits 2 before any run, so no run of it equals the baseline", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rl-nopath-"));
    dirs.push(empty);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^path$/i.test(k)) env[k] = v;
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/eval/run.ts"), ...args], {
        env: { ...env, PATH: empty },
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      return { code, stderr };
    };
    const r = await run("--real", "--variants", "codegraph");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--variants codegraph needs the codegraph executable on PATH.");
    // Without --real the fake CLI runs, so the executable is not needed. Only the parse result matters here.
    const { parseOptions } = await import("../../scripts/eval/run");
    expect("error" in parseOptions(["--variants", "codegraph"])).toBe(false);
  });
});
