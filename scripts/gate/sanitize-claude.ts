// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Writes .gate0/claude/*.jsonl (git-ignored) from the Gate B raw stream-json in .gate0/v3-local/raw/.
// Usage: bun scripts/gate/sanitize-claude.ts [--raw <dir>] [--out <dir>]
// Real values come from the raw files, `claude auth status`, and the local Claude config at run time. This file holds no real values.
// Output is counts only. Exit code 1 when the scan finds a real value in the output.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { claudeOutDir, countHits, formPairs, hideAgentOutput, isObj, type Json, sanitizer, scanPatterns, UUID } from "./sanitize-core";
import { agentFront } from "./workflow";

const ROOT = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1] as string) : def;
};
const RAW = opt("--raw", join(ROOT, ".gate0/v3-local/raw"));
let OUT: string;
try {
  OUT = claudeOutDir(ROOT, opt("--out", "") || undefined);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const CHECKS: Record<string, string> = {
  b1: "B1. A review agent from an `--agents` file tries a shell command, Write, and a Read of a sibling folder.",
  b2: "B2. The main agent tries `general-purpose`, a user agent, and `rl-reviewer`. Variants: `Agent(...)` deny rules, `Task(...)` deny rules, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, and an `--agent` main thread.",
  b3: "B3. One subagent run with `--json-schema`: Agent tool_use, child events, `task_*` events, result events. Variant: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.",
  b4: "B4. One subagent run with `--no-session-persistence`.",
  b5: "B5. Errors: `--max-turns 1` on a two-step task, and a run with an empty `CLAUDE_CONFIG_DIR` (auth failure).",
  b6: "B6. A sanitized hostile repository with the app flags. Expect no hook, no canary, and only the app MCP server.",
  b7: "B7. A stub stdio MCP server with one read-only tool, called by the main agent and by a subagent.",
  b8: "B8. `--restricted` with stream-json, `--json-schema`, the stub MCP server, and `rl-reviewer`. Variant: `--setting-sources user` and `--settings`.",
  "b9-first-try":
    "B9, first try. The WP8 flag set with `--allowedTools mcp__rl-*` and no `StructuredOutput` in the `rl-main` tools. The stub tool is refused, and no result event has `structured_output`.",
  b9: "B9. The WP8 flag set with a long-path cwd: `--restricted`, `--agent rl-main`, `rl-reviewer`, the stub MCP server, `--json-schema`, `--no-session-persistence`, and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.",
  "b11-reply":
    "B11, reply run. The runner flag set without review agents and the reply JSON schema. Expect `structured_output` with one `judgement` set to JSON null.",
  "b11-fix":
    "B11, fix run. The runner flag set without review agents and the fix JSON schema. Expect `structured_output` with one edit whose `new` text has 2 KB or more.",
  gadv: "Gate G-ADV. The app flag set with `--advisor`: an advisor call, no `--advisor` (`none`), `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` (`envoff`), `--disallowedTools advisor` (`disallowed`), and `--tools` with the advisor (`tools`).",
  b12: "B12. The runner flag set without review agents. The agent reads a PNG attachment with Read and names its color in `structured_output`.",
  b35: "B35. A write run as `--agent rl-main` with `Agent(rl-explorer)` and the shell allowlist (`agent`), the same step without `--agent` (`plain`), and a Stop during an rl-explorer call (`stop`).",
  b36: "B36. Workflow agents under an rl-main lead: agent writes and Bash in allowlist mode (`writer`) and Most commands mode (`any`), Stop in an agent `sleep 600` (`stop`), turn caps (`turns`), a writer with Agent disallowed and no spawn depth variable (`nodepth`), model priority and two agents at once (`models`), model inherit and an unknown alias (`badmodel`), `--advisor` (`advisor`), and Opus efforts (`opus`, with `--opus` only).",
  b37: "B37. One Claude session per task part: a create run with the implement flags and no `--no-session-persistence`, resumes with `--resume <kept file> --fork-session` (all flags, no Bash and Agent, another model), a run cut by the app kill and its resume, stream-json input, and a critic review run.",
};
// Public built-in agent and product names. They are not private data, and a replacement would break the event shapes.
const RESERVED = new Set(["claude", "general-purpose", "explore", "plan", "statusline-setup", "claude-code-guide", "builtin"]);

// ---------- read raw ----------
if (!existsSync(RAW)) {
  console.error(`no raw folder: ${RAW}`);
  process.exit(1);
}
const files = readdirSync(RAW)
  .filter((f) => f.endsWith(".jsonl"))
  .sort();
if (!files.length) {
  console.error("no raw .jsonl files");
  process.exit(1);
}
const raw = new Map<string, Json[]>();
for (const f of files)
  raw.set(
    f,
    readFileSync(join(RAW, f), "utf8")
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l) as Json),
  );

// ---------- collect real values ----------
const tokenMap = new Map<string, string>(); // lowercased real value -> fake
const counters: Record<string, number> = {};
const add = (real: unknown, kind: string, make: (n: number) => string) => {
  if (typeof real !== "string") return;
  const k = real.trim().toLowerCase();
  if (k.length < 3 || RESERVED.has(k) || tokenMap.has(k)) return;
  counters[kind] = (counters[kind] ?? 0) + 1;
  tokenMap.set(k, make(counters[kind]));
};

const auth = (() => {
  const claude = Bun.which("claude");
  if (!claude) return {};
  const r = Bun.spawnSync([claude, "auth", "status"], { stdout: "pipe", stderr: "pipe" });
  try {
    return JSON.parse(r.stdout.toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
})();
if (typeof auth.email !== "string") {
  console.error("claude auth status gave no account data. The scan needs it.");
  process.exit(1);
}
add(auth.orgName, "org", () => "Example Org");
add(auth.email, "email", () => "user@example.test");
const [local, domain] = auth.email.split("@");
add(local, "user", () => "user");
add(domain, "domain", () => "example.test");
add(auth.orgId, "orgid", () => "00000000-0000-4000-8000-0000000000aa");

// The home folder appears in its long form and in the 8.3 short form that TEMP uses.
const HOME = homedir();
const homes = new Set([HOME]);
for (const t of [tmpdir(), process.env.TEMP, process.env.TMP]) {
  if (!t) continue;
  const long = realpathSync.native(t);
  const suffix = long.slice(HOME.length).toLowerCase();
  if (long.toLowerCase().startsWith(HOME.toLowerCase()) && t.toLowerCase().endsWith(suffix) && t.length > suffix.length)
    homes.add(t.slice(0, t.length - suffix.length));
}
for (const h of homes) add(basename(h), "user", () => "user");
add(userInfo().username, "user", () => "user");
const FAKE_HOME = "C:\\Users\\user";
const configDir =
  typeof auth.configDirectory === "string" ? auth.configDirectory : (process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude"));
// A custom config folder name can hold a personal name.
const homeForms = [...[...homes].flatMap((h) => formPairs(h, FAKE_HOME)), ...formPairs(configDir, `${FAKE_HOME}\\.claude`)];
add(basename(configDir), "config", () => ".claude");
const list = (d: string) => (existsSync(d) ? readdirSync(d) : []);
// U88: the gate calls one user agent by its front-matter name. Its reply is the user's text.
const agentNames = new Set<string>();
for (const f of list(join(configDir, "agents")).filter((x) => x.endsWith(".md"))) {
  const { name } = agentFront(readFileSync(join(configDir, "agents", f), "utf8"), f);
  for (const n of [name, basename(f, ".md")]) {
    add(n, "agent", (k) => `user-agent-${k}`);
    if (!RESERVED.has(n.trim().toLowerCase())) agentNames.add(n.trim().toLowerCase());
  }
}
for (const d of list(join(configDir, "skills"))) add(d, "skill", (n) => `user-skill-${n}`);

const realUuids = new Set<string>();
for (const evs of raw.values())
  for (const e of evs) {
    for (const m of JSON.stringify(e).matchAll(UUID)) realUuids.add(m[0].toLowerCase());
    if (!isObj(e) || e.subtype !== "init") continue;
    for (const p of Array.isArray(e.plugins) ? e.plugins : []) {
      if (!isObj(p)) continue;
      add(p.name, "plugin", (n) => `plugin-${n}`);
      if (typeof p.source === "string") {
        const [name, market] = p.source.split("@");
        add(name, "plugin", (n) => `plugin-${n}`);
        add(market, "market", (n) => `marketplace-${n}`);
      }
    }
    // App servers of the gate scripts start with "rl-". Every other server comes from the user config.
    for (const s of Array.isArray(e.mcp_servers) ? e.mcp_servers : [])
      if (isObj(s) && typeof s.name === "string" && !s.name.startsWith("rl-")) add(s.name, "mcp", (n) => `mcp-server-${n}`);
  }
const uuidMap = new Map([...realUuids].map((u, i) => [u, `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`]));

// ---------- sanitize ----------
const { sanitize } = sanitizer(tokenMap, homeForms, uuidMap);

mkdirSync(OUT, { recursive: true });
for (const f of list(OUT)) if (f.endsWith(".jsonl")) rmSync(join(OUT, f));
let version = "";
for (const [f, evs] of raw) {
  const out = hideAgentOutput(evs, agentNames).map((e) => sanitize(e));
  for (const e of out) if (isObj(e) && e.subtype === "init" && typeof e.claude_code_version === "string") version ||= e.claude_code_version;
  writeFileSync(join(OUT, f), `${out.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
const rows = files.map(
  (f) => `| \`${f}\` | ${CHECKS[basename(f, ".jsonl")] ?? CHECKS[f.split(/[-.]/)[0] as string] ?? "Not mapped to a check."} |`,
);
writeFileSync(
  join(OUT, "README.md"),
  [
    "# Claude Code stream-json samples (Gate B)",
    "",
    `Recorded with Claude Code ${version || "unknown"}. WP8 requires this CLI version or later.`,
    "",
    "`scripts/gate/sanitize-claude.ts` writes these files from the raw output of `scripts/gate/claude-checks.ts`. It replaces session IDs, UUIDs, home paths, the user name, email, organization, user agent, skill, plugin, and MCP server names, user hook output, and the reply text of a user agent. Do not commit these files. Tests read only the hand-written streams in `fixtures/claude-synthetic/`.",
    "",
    "| File | Check |",
    "|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

// ---------- scan ----------
const { res, names } = scanPatterns(tokenMap, [...homes, configDir], realUuids);
const hits = countHits(
  list(OUT).map((f) => readFileSync(join(OUT, f), "utf8")),
  res,
);
console.log(
  `files written=${files.length} values checked=${res.length} (names=${names} homes=${homes.size} uuids=${realUuids.size}) hits=${hits}`,
);
if (hits) process.exit(1);
