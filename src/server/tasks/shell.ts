// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.21: the Bash tool of a tests, implement, fix, or instruct step. The rules go into a settings
// file, because --restricted loads --settings (V9). Rules match the command text only (V4): they reduce mistakes, they stop no attacker.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOW_MAX,
  ALLOW_REQUESTS_MAX,
  type AllowEntry,
  type AllowProposal,
  type AllowRequest,
  ANY_LIFTS,
  allowProblem,
  BASH_TIMEOUT_MAX_SEC,
  CREDENTIAL_TOOLS,
  NETWORK_TOOLS,
  programOf,
  type ShellMode,
  type TaskCommand,
} from "../../shared/task";
import type { Refusal } from "../review/stream";
import { longPath } from "../review/workspace";

// rules: the saved inner patterns, such as "ssh build1 *". checks: the approved checks that the step may run, as their argv text
// (checkRules). bashTimeoutSec: the time limit of one command. dataDir: the app data folder. origins: the Bitbucket and Jira base URLs of
// the config.
export type ShellSpec = {
  mode: ShellMode;
  rules: string[];
  checks?: string[];
  bashTimeoutSec: number;
  dataDir: string;
  origins: string[];
};
// The shell of one task step. The run adds dataDir and origins. notes: go into the step notes (checkRules).
export type StepShell = Pick<ShellSpec, "mode" | "rules" | "checks" | "bashTimeoutSec"> & { notes?: string[] };

// A deny rule wins over every allow rule, in both modes (V5).
const GIT_DENY = ["Bash(git *)", "Bash(*/git *)", "Bash(git.exe *)", "Bash(*/git.exe *)", "Bash(*\\git.exe *)"];
// Read-only search in allowlist mode. The CLI folder check still guards their paths (shell.md, run 2).
export const SEARCH_RULES = ["grep *", "rg *"];
const CREDENTIAL_DENY = [...CREDENTIAL_TOOLS.map((t) => `Bash(${t} *)`), "Bash(powershell*)", "Bash(pwsh*)"];
// The config, the database files (config.ts dbPath), and the run folders with their MCP files. The step cwd is in <dataDir>/tasks.
const DATA_DENY = ["config.json*", "*.sqlite*", "runs/**"];
const HOME_DENY = ["Read(~/.ssh/**)", "Read(~/.git-credentials)", "Read(~/.netrc)", "Read(~/_netrc)", "Read(~/.claude/.credentials.json)"];
// Read rules use the gitignore syntax (code.claude.com/docs/en/permissions), and ( ) end the rule. A path with these characters cannot
// go into a rule.
const RULE_UNSAFE = /[()*?[\]\\]/;
const PLAIN_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/;

export const hostsOf = (origins: readonly string[]) => [...new Set(origins.map((o) => new URL(o).hostname.toLowerCase()))];

// The Bitbucket and Jira base URLs of the config.
export const originsOf = (c: { baseUrl?: string; jira?: { baseUrl: string } } | null) =>
  [c?.baseUrl, c?.jira?.baseUrl].filter((u): u is string => !!u && URL.canParse(u));

// D1: adds patterns to the allowlist of a repository. A pattern in the list stays as it is. A new entry gets the first free ID a<n>.
// Returns the reason for 400 when a pattern fails allowProblem or the list grows over ALLOW_MAX.
export function mergeAllow(
  list: readonly AllowEntry[],
  add: readonly AllowProposal[],
  source: AllowEntry["source"],
  hosts: readonly string[],
  now: number,
): AllowEntry[] | { error: string } {
  const out = [...list];
  const ids = new Set(out.map((e) => e.id));
  let n = 1;
  for (const a of add) {
    const pattern = a.pattern.trim();
    const problem = allowProblem(pattern, hosts);
    if (problem) return { error: `${pattern}: ${problem}` };
    if (out.some((e) => e.pattern === pattern)) continue;
    while (ids.has(`a${n}`)) n++;
    ids.add(`a${n}`);
    out.push({ id: `a${n}`, pattern, reason: a.reason.trim(), source, addedAt: now });
  }
  return out.length > ALLOW_MAX ? { error: `The list can hold at most ${ALLOW_MAX} patterns.` } : out;
}

// D3: the requests that a step gives the user. requests: allowRequest of the result. killed: the runner ended the run over REFUSED_MAX
// refused commands, so each allowlist refusal becomes a request with its exact command as the pattern. A deny refusal never becomes
// a request. rules: the patterns of the run. refusedBefore: the patterns that the user refused for this task. notes: why a request
// does not show.
export function allowAsks(i: {
  mode: ShellMode | null;
  requests: readonly AllowRequest[];
  refused: readonly Refusal[];
  killed: boolean;
  rules: readonly string[];
  refusedBefore: ReadonlySet<string>;
  hosts: readonly string[];
}): { asks: AllowRequest[]; notes: string[] } {
  if (i.mode === "any")
    return { asks: [], notes: i.requests.length ? ["Any command is on, so the app ignored the allow requests of the step."] : [] };
  const denied = new Set(i.refused.filter((r) => r.by === "deny").map((r) => r.command));
  const asked = i.killed
    ? i.refused
        .filter((r) => r.by === "allowlist" && r.command.trim())
        .map((r) => ({ pattern: r.command.trim(), command: r.command, reason: "Claude Code refused this command in the step." }))
    : i.requests;
  const asks: AllowRequest[] = [];
  const notes: string[] = [];
  for (const a of asked) {
    const pattern = a.pattern.trim();
    const problem = allowProblem(pattern, i.hosts);
    if (asks.some((x) => x.pattern === pattern)) continue;
    if (problem) notes.push(`Claude asked to allow ${pattern}. The app refused it: ${problem}`);
    else if (denied.has(a.command)) notes.push(`Claude asked to allow ${pattern}. The deny list refused ${a.command}.`);
    else if (i.refusedBefore.has(pattern)) notes.push(`Claude asked again to allow ${pattern}. You refused it for this task.`);
    else if (i.rules.includes(pattern)) notes.push(`Claude asked to allow ${pattern}, which the step had already.`);
    else if (asks.length >= ALLOW_REQUESTS_MAX)
      notes.push(`Claude asked for more than ${ALLOW_REQUESTS_MAX} commands. The app left out ${pattern}.`);
    else asks.push({ ...a, pattern });
  }
  return { asks, notes };
}

// V20: a rule names the Windows path C:\x as //c/x, and the POSIX path /x as //x.
export function rulePath(dir: string, platform: NodeJS.Platform = process.platform) {
  const drive = /^([A-Za-z]):[\\/]/.exec(dir)?.[1];
  if (platform === "win32" ? !drive : !dir.startsWith("/")) throw new Error(`The data folder ${dir} is not an absolute path.`);
  const p = (drive ? `${drive.toLowerCase()}/${dir.slice(3).replaceAll("\\", "/")}` : dir.replace(/^\/+/, "")).replace(/\/+$/, "");
  if (RULE_UNSAFE.test(p)) throw new Error(`The data folder ${dir} has a character that a permission rule cannot hold: ( ) * ? [ ] or \\.`);
  return `//${p}`;
}

// The network programs whose deny rule a saved pattern lifts: each one that a pattern names as its program in allowlist mode, and only
// ssh in Any command mode.
const lifted = (mode: ShellMode, rules: readonly string[]) => {
  const named = new Set(rules.map(programOf));
  return new Set(NETWORK_TOOLS.filter((n) => named.has(n) && (mode === "allowlist" || ANY_LIFTS.includes(n))));
};

// The settings file of a shell step. A network program stays denied unless a saved pattern lifts it (lifted). xargs stays denied in
// allowlist mode unless a saved pattern names it. Gate facts do not confirm that `Bash(<argv> *)` matches the bare argv, so each
// check also gets the exact rule.
export function shellSettings(spec: ShellSpec, platform: NodeJS.Platform = process.platform) {
  const t = spec.bashTimeoutSec;
  const checks = spec.checks ?? [];
  if (!Number.isInteger(t) || t < 1 || t > BASH_TIMEOUT_MAX_SEC) throw new Error(`Invalid Bash time limit: ${t}`);
  if (spec.mode === "allowlist" && !spec.rules.length && !checks.length)
    throw new Error("An allowlist shell step needs at least one pattern.");
  for (const r of [...spec.rules, ...checks]) if (!r.trim() || /[()\r\n]/.test(r)) throw new Error(`Invalid allowlist pattern: ${r}`);
  const named = new Set(spec.rules.map(programOf));
  const open = lifted(spec.mode, spec.rules);
  const data = rulePath(longPath(spec.dataDir), platform);
  const allow = [...new Set([...spec.rules, ...checks.flatMap((c) => [`${c} *`, c]), ...SEARCH_RULES])];
  return {
    permissions: {
      allow: spec.mode === "any" ? ["Bash"] : allow.map((r) => `Bash(${r})`),
      deny: [
        ...GIT_DENY,
        ...hostsOf(spec.origins).map((h) => `Bash(*${h}*)`),
        ...NETWORK_TOOLS.filter((n) => !open.has(n)).map((n) => `Bash(${n} *)`),
        // Outside Windows, the CLI runs xargs with no allow rule. Its folder check misses paths from stdin (shell.md, run 2).
        ...(spec.mode === "allowlist" && !named.has("xargs") ? ["Bash(xargs *)"] : []),
        ...CREDENTIAL_DENY,
        ...DATA_DENY.map((f) => `Read(${data}/${f})`),
        ...HOME_DENY,
      ],
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: "disable",
    },
  };
}

// Writes shell.json into appDir, outside the step cwd, and returns its path.
export function writeShellSettings(appDir: string, spec: ShellSpec) {
  const settings = shellSettings(spec);
  mkdirSync(appDir, { recursive: true });
  const file = join(appDir, "shell.json");
  writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

// D1: the approved build, test, and lint commands that a step may run, as their argv text. A command qualifies only when each argument
// is a plain word, allowProblem accepts it, and the deny list of the step does not refuse its program. rules: the saved patterns of the
// step. notes: one per command that does not qualify.
export function checkRules(
  commands: readonly TaskCommand[],
  i: { mode: ShellMode; rules: readonly string[]; hosts: readonly string[] },
): { checks: string[]; notes: string[] } {
  const open = lifted(i.mode, i.rules);
  const checks: string[] = [];
  const notes: string[] = [];
  for (const c of commands) {
    if (c.kind === "setup") continue;
    const text = c.argv.join(" ");
    const program = programOf(text);
    const why = !c.argv.every((a) => PLAIN_ARG.test(a))
      ? "An argument holds a character that is not a letter, a digit, or one of _ . / : = @ % + , -."
      : (allowProblem(text, i.hosts) ??
        (NETWORK_TOOLS.includes(program) && !open.has(program) ? `The deny list refuses ${program}.` : null));
    if (why) notes.push(`The step cannot run the check "${c.name}". ${why}`);
    else if (!checks.includes(text)) checks.push(text);
  }
  return { checks, notes };
}

// D5: the real HOME stays, so ssh finds its keys and config. No askpass program, no git credential helper, and no prompt. V13: the CLI
// reads the Bash time limits from the env. Windows env names ignore case, so a set name replaces each spelling of it.
export function shellEnv(base: Record<string, string>, bashTimeoutSec: number): Record<string, string> {
  const ms = String(bashTimeoutSec * 1000);
  const set: Record<string, string> = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
    BASH_DEFAULT_TIMEOUT_MS: ms,
    BASH_MAX_TIMEOUT_MS: ms,
  };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    const K = k.toUpperCase();
    if (!K.startsWith("GIT_") && K !== "SSH_ASKPASS" && !(K in set)) env[k] = v;
  }
  return { ...env, ...set };
}
