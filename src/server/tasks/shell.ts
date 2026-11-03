// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.21: the Bash tool of a tests, implement, fix, or instruct step. The rules go into a settings
// file, because --restricted loads --settings (V9). Rules match the command text only (V4): they reduce mistakes, they stop no attacker.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASH_TIMEOUT_MAX_SEC, CREDENTIAL_TOOLS, programOf, type ShellMode, type TaskCommand } from "../../shared/task";
import { longPath } from "../review/workspace";

// rules: the inner patterns, such as "ssh build1 *". bashTimeoutSec: the time limit of one command. dataDir: the app data folder.
// origins: the Bitbucket and Jira base URLs of the config.
export type ShellSpec = { mode: ShellMode; rules: string[]; bashTimeoutSec: number; dataDir: string; origins: string[] };

// A deny rule wins over every allow rule, in both modes (V5).
const GIT_DENY = ["Bash(git *)", "Bash(*/git *)", "Bash(git.exe *)", "Bash(*/git.exe *)", "Bash(*\\git.exe *)"];
export const NETWORK_TOOLS = ["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "tftp", "sftp", "scp", "ssh", "rsync"];
const CREDENTIAL_DENY = [...CREDENTIAL_TOOLS.map((t) => `Bash(${t} *)`), "Bash(powershell*)", "Bash(pwsh*)"];
// The config, the database files (config.ts dbPath), and the run folders with their MCP files. The step cwd is in <dataDir>/tasks.
const DATA_DENY = ["config.json*", "*.sqlite*", "runs/**"];
const HOME_DENY = ["Read(~/.ssh/**)", "Read(~/.git-credentials)", "Read(~/.netrc)", "Read(~/_netrc)", "Read(~/.claude/.credentials.json)"];
// Read rules use the gitignore syntax (code.claude.com/docs/en/permissions), and ( ) end the rule. A path with these characters cannot
// go into a rule.
const RULE_UNSAFE = /[()*?[\]\\]/;
const PLAIN_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/;

export const hostsOf = (origins: readonly string[]) => [...new Set(origins.map((o) => new URL(o).hostname.toLowerCase()))];

// V20: a rule names the Windows path C:\x as //c/x, and the POSIX path /x as //x.
export function rulePath(dir: string, platform: NodeJS.Platform = process.platform) {
  const drive = /^([A-Za-z]):[\\/]/.exec(dir)?.[1];
  if (platform === "win32" ? !drive : !dir.startsWith("/")) throw new Error(`The data folder ${dir} is not an absolute path.`);
  const p = (drive ? `${drive.toLowerCase()}/${dir.slice(3).replaceAll("\\", "/")}` : dir.replace(/^\/+/, "")).replace(/\/+$/, "");
  if (RULE_UNSAFE.test(p)) throw new Error(`The data folder ${dir} has a character that a permission rule cannot hold: ( ) * ? [ ] or \\.`);
  return `//${p}`;
}

// The settings file of a shell step. A network program stays allowed only when an allowlist entry names it as its program.
export function shellSettings(spec: ShellSpec, platform: NodeJS.Platform = process.platform) {
  const t = spec.bashTimeoutSec;
  if (!Number.isInteger(t) || t < 1 || t > BASH_TIMEOUT_MAX_SEC) throw new Error(`Invalid Bash time limit: ${t}`);
  if (spec.mode === "allowlist" && !spec.rules.length) throw new Error("An allowlist shell step needs at least one pattern.");
  for (const r of spec.rules) if (!r.trim() || /[()\r\n]/.test(r)) throw new Error(`Invalid allowlist pattern: ${r}`);
  const named = new Set(spec.rules.map(programOf));
  const data = rulePath(longPath(spec.dataDir), platform);
  return {
    permissions: {
      allow: spec.mode === "any" ? ["Bash"] : spec.rules.map((r) => `Bash(${r})`),
      deny: [
        ...GIT_DENY,
        ...hostsOf(spec.origins).map((h) => `Bash(*${h}*)`),
        ...NETWORK_TOOLS.filter((n) => !named.has(n)).map((n) => `Bash(${n} *)`),
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

// D1: with "Claude may run the approved checks" on, each approved build, test, or lint argv of plain words becomes one pattern.
export const checkPatterns = (commands: readonly TaskCommand[]) => [
  ...new Set(commands.filter((c) => c.kind !== "setup" && c.argv.every((a) => PLAIN_ARG.test(a))).map((c) => `${c.argv.join(" ")} *`)),
];

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
