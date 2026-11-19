// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/task-builder-v2.md section 4: the capability manifest. It tells Claude the real tools of the build runs of a task. It reads
// the inputs of the shell of a step (shellSettings), so the words and the sandbox cannot disagree.
import type { Database } from "bun:sqlite";
import { NETWORK_TOOLS, type ShellMode, type StepMode } from "../../shared/task";
import { checkRules, deniedPrograms, hostsOf, type StepShell } from "./shell";
import { repoSettings } from "./tasks";

// A build host of Settings > Tasks (TB-11). No setting holds one yet, so production passes none.
export type BuildHost = { name: string; alias: string; platform: string; dir: string };

// repo: <project>/<repo> of the main repository. Its mode applies to every repository of the task (D5). commands: the build runs get the
// Bash tool. rules: the saved patterns, with "Allow once" patterns for a step. denied: the programs that shell.json denies, besides git and
// hosts (deniedPrograms). hosts: the Bitbucket and Jira host names. buildHosts: only when ssh runs.
export type Capabilities = {
  repo: string;
  mode: ShellMode;
  commands: boolean;
  rules: string[];
  checks: string[];
  denied: string[];
  hosts: string[];
  buildHosts: BuildHost[];
};

export const SHELL_MODE_TEXT: Record<ShellMode, string> = { allowlist: "Allowlist", any: "Most commands", unrestricted: "Unrestricted" };

// The Bash tool of a build run (spec.md section 6.21): Most commands and Unrestricted always, an allowlist only with a pattern or an
// approved check. once: the "Allow once" patterns of the last run of the step. Most commands and Unrestricted list the checks for the
// prompt only and give no notes.
export function buildShell(
  db: Database,
  t: { project: string; repo: string },
  origins: readonly string[],
  once: readonly string[] = [],
): StepShell | null {
  const repo = repoSettings(db, t.project, t.repo);
  const rules = [...new Set([...repo.allow.map((e) => e.pattern), ...once])];
  const any = repo.shellMode !== "allowlist";
  const run =
    any || repo.runChecks ? checkRules(repo.commands, { mode: repo.shellMode, rules, hosts: hostsOf(origins) }) : { checks: [], notes: [] };
  if (!any && !rules.length && !run.checks.length) return null;
  return { mode: repo.shellMode, rules, checks: run.checks, bashTimeoutSec: repo.bashTimeoutSec, notes: any ? [] : run.notes };
}

// shell: the shell that the run gets, null for no Bash tool. mode: the mode of the main repository.
export function manifest(
  shell: StepShell | null,
  i: { repo: string; mode: ShellMode; origins: readonly string[]; buildHosts?: readonly BuildHost[] },
): Capabilities {
  const rules = shell?.rules ?? [];
  const denied = shell ? deniedPrograms(shell.mode, rules) : [];
  const ssh = shell !== null && !denied.includes("ssh");
  return {
    repo: i.repo,
    mode: shell?.mode ?? i.mode,
    commands: shell !== null,
    rules: [...rules],
    checks: [...(shell?.checks ?? [])],
    denied,
    hosts: hostsOf(i.origins),
    buildHosts: ssh ? [...(i.buildHosts ?? [])] : [],
  };
}

// The manifest of the build runs of a task, with no "Allow once" pattern. The interview and spec runs get it too, and keep no Bash tool
// (BRIEF 3.5). A resolve run never gets Bash, so it has no manifest. A step uses manifest() with its own shell (loop.ts shellOf).
export function capabilities(
  db: Database,
  t: { project: string; repo: string },
  _runKind: Exclude<StepMode, "resolve"> | "interview" | "spec",
  origins: readonly string[] = [],
): Capabilities {
  const mode = repoSettings(db, t.project, t.repo).shellMode;
  return manifest(buildShell(db, t, origins), { repo: `${t.project}/${t.repo}`, mode, origins });
}

export const UNRESTRICTED_LINE =
  "You can run any command as the user, with the user's files, ssh keys, and ssh config. ssh, scp, and curl work.";
export const NO_COMMANDS_LINE = "Claude cannot run commands in this task. Pick a mode in Settings > Tasks.";
export const TRY_FIRST_RULE = "Try a command before you say that you cannot run it. Quote the refusal when it comes.";

// The prompt lines of a manifest. Each sentence has at most 20 words, except the pattern list of an allowlist.
export function capabilityLines(m: Capabilities): string[] {
  const network = m.denied.filter((p) => NETWORK_TOOLS.includes(p));
  const other = m.denied.filter((p) => !NETWORK_TOOLS.includes(p));
  const hosts = m.hosts.length ? ` (${m.hosts.join(", ")})` : "";
  const patterns = [...m.rules, ...m.checks.map((c) => `${c} *`)].map((r) => `\`${r}\``).join(", ");
  const runs = !m.commands
    ? []
    : [
        m.mode === "unrestricted"
          ? UNRESTRICTED_LINE
          : m.mode === "any"
            ? "You can run every command with the Bash tool, except the refused programs below."
            : `You can run only these commands: ${patterns}. Read-only commands, such as ls, cat, grep, and rg, also run. Claude Code refuses every other command.`,
        ...(network.length ? [`The deny list refuses these network programs: ${network.join(", ")}.`] : []),
        ...(other.length ? [`It also refuses these programs: ${other.join(", ")}.`] : []),
        ...m.buildHosts.map((h) => `Build host ${h.name}: ssh alias ${h.alias}, ${h.platform}, work folder ${h.dir}.`),
      ];
  return [
    m.commands
      ? `Commands: ${SHELL_MODE_TEXT[m.mode]} (main repository ${m.repo}). It applies to every repository of the task.`
      : NO_COMMANDS_LINE,
    ...runs,
    `Every mode refuses git and each command that names the Bitbucket or Jira host${hosts}.`,
    "You have no CI token and no Jira or Bitbucket access.",
    "The Read, Edit, and Write tools work only in the run folder.",
    "The app commits after its checks. It pushes and opens the PRs only on a click of the user.",
    "With a submodule, the app opens the submodule PR first, and a person merges it.",
    'Then "Point <repo> at the merged commit" moves the submodule pointer.',
    'The app reads the build status of each PR. "Update from <base>" brings in the new base commits.',
    "Only the user merges and approves PRs, and writes Jira comments and fields.",
    "Only the user starts a CI build again, and creates or changes CI jobs.",
    "Only the user handles secrets, signing keys, notary access, and host steps that need a person.",
    ...(m.commands ? [TRY_FIRST_RULE] : []),
  ];
}

// The manifest block of the interview and spec runs (catalog.ts specAgent and interviewAgent).
export const buildToolLines = (m: Capabilities | null) =>
  m ? ["The build runs of this task have these tools:", ...capabilityLines(m).map((l) => `- ${l}`)] : [];
