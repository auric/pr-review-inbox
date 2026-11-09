// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The commands that the runner may run (docs/plans/review-v2/spec.md section 6.21): the rows of the allowlist editors, the picks of the
// plan screen and of an allow request, the first-use warnings, and the words of the mode. UI code holds no product name
// (tests/ui/names.test.ts), so each text takes the names from GET /api/meta.
import type { TaskAllowAskDto, TaskPlanDto, TaskPlanInput } from "../../shared/dto";
import {
  type AllowChoice,
  type AllowEntry,
  ANY_LIFTS,
  allowProblem,
  BASH_TIMEOUT_MAX_SEC,
  NETWORK_TOOLS,
  type ShellMode,
  TEST_GLOB_MAX,
  TEST_GLOBS_MAX,
} from "../../shared/task";

type AllowSource = AllowEntry["source"];

// runner: the short runner name. cli: the runner program name. forge and tracker: the code host and the issue tracker.
export type ShellNames = { runner: string; cli: string; forge: string; tracker: string };

// One row of an allowlist editor. pattern: the inner pattern of the rule Bash(<pattern>). source: where a saved pattern came from.
export type AllowDraft = { id: string; pattern: string; reason: string; source?: AllowSource };

export const toAllowDraft = (a: { id: string; pattern: string; reason: string; source?: AllowSource }): AllowDraft => ({
  id: a.id,
  pattern: a.pattern,
  reason: a.reason,
  ...(a.source && { source: a.source }),
});

export const SOURCE_TEXT: Record<AllowSource, string> = { plan: "from a plan", request: "from a request", user: "added by you" };

// The problem of a row, or null. The page does not know the forge and tracker hosts, so the server checks them on each save.
export function allowDraftProblem(d: AllowDraft, all: readonly AllowDraft[]): string | null {
  const problem = allowProblem(d.pattern, []);
  if (problem) return problem;
  const p = d.pattern.trim();
  return all.some((x) => x.id !== d.id && x.pattern.trim() === p) ? "This pattern is in the list already. Remove one of the rows." : null;
}

// The entries of the rows, or null while a row has a problem.
export function draftsToAllow(drafts: readonly AllowDraft[]): { pattern: string; reason: string }[] | null {
  if (drafts.some((d) => allowDraftProblem(d, drafts))) return null;
  return drafts.map((d) => ({ pattern: d.pattern.trim(), reason: d.reason.trim() }));
}

// "Commands: allowlist, 2 patterns, 1 approved check", "Commands: most commands", or "Commands: unrestricted". n: the patterns of the list
// or of the run. checks: the approved checks that the steps may run (spec.md section 6.21.1).
export const shellText = (mode: ShellMode, n: number, checks = 0) =>
  mode === "any"
    ? "Commands: most commands"
    : mode === "unrestricted"
      ? "Commands: unrestricted"
      : `Commands: allowlist, ${n} ${n === 1 ? "pattern" : "patterns"}${checks ? `, ${checks} approved ${checks === 1 ? "check" : "checks"}` : ""}`;

export const MODE_TEXT: Record<ShellMode, string> = { allowlist: "Allowlist", any: "Most commands", unrestricted: "Unrestricted" };

// spec.md section 6.21.8: the line under the mode switch names what the mode blocks (src/server/tasks/shell.ts shellSettings).
const ANY_BLOCKS = [...NETWORK_TOOLS.filter((t) => !ANY_LIFTS.includes(t)), ...ANY_LIFTS].join(", ");
export const modeLine = (mode: ShellMode, n: ShellNames) =>
  ({
    allowlist: `${n.runner} runs only the commands that match a pattern of this list. grep, rg, and read-only commands such as ls and cat also run. ${n.runner} cannot run cd or read files outside the folder of the step.`,
    any: `${n.runner} runs every command, except these: git, the ${n.forge} and ${n.tracker} hosts, ${ANY_BLOCKS}, powershell, pwsh, and the password and key store tools. ${n.runner} also cannot read the app data or your ssh keys. A pattern for ssh in this list lets every ssh command run. The list applies again when you switch back.`,
    unrestricted: `${n.runner} runs every command, except these: git and commands that name the ${n.forge} or ${n.tracker} host. ${n.runner} can read and write any file that you can, also your keys and the app data. The list applies again when you switch back.`,
  })[mode];

export const CHOICE_TEXT: Record<AllowChoice, string> = {
  once: "Allow once",
  repo: "Allow for this repository",
  refuse: "Refuse",
};
export const choiceLine = (c: AllowChoice, n: ShellNames) =>
  ({
    once: "Only the next run of this step can run it.",
    repo: "Each later step can run it. Settings > Tasks lists it.",
    refuse: `${n.runner} does the step without it, or asks you a question.`,
  })[c];
export const DECIDED_TEXT: Record<AllowChoice, string> = {
  once: "allowed once",
  repo: "allowed for this repository",
  refuse: "refused",
};

// spec.md section 6.21.8: the dialogs before each switch to Most commands and to Unrestricted, and the first-use warning of the allowlist.
export const ANY_TITLE = "Turn on Most commands?";
export const UNRESTRICTED_TITLE = "Turn on Unrestricted?";
export const unrestrictedText = (n: ShellNames) =>
  `Unrestricted lets ${n.runner} run every command as you, with your files, your keys, and your network, except git and the ${n.forge} and ${n.tracker} hosts. ${n.runner} can read and write any file that you can. Text in a task, an attachment, or a comment can tell ${n.runner} to run a harmful command. Use it only for repositories and tasks that you trust.`;
// The note of the plan screen while the repository is not in allowlist mode.
export const planModeText = (mode: Exclude<ShellMode, "allowlist">, n: ShellNames) =>
  mode === "any"
    ? `The mode "Most commands" is on for this repository. ${n.runner} can run every command, except the fixed deny list.`
    : `The mode "Unrestricted" is on for this repository. ${n.runner} can run every command, except git and the ${n.forge} and ${n.tracker} hosts.`;
export const anyText = (n: ShellNames) =>
  `Most commands lets ${n.runner} run every command as you, with your files, your keys, and your network, except the fixed deny list. ${n.runner} can write any file that you can write. Text in a ${n.tracker} task, an attachment, or a comment can tell ${n.runner} to run a harmful command. The deny list and the Log tab only reduce mistakes. They do not stop an attacker. Use Most commands only for repositories and tasks that you trust.`;
export const warningTitle = (n: ShellNames) => `Commands that ${n.runner} runs`;
export const warningText = (n: ShellNames) =>
  `${n.runner} can run each command that matches this list, as you, with your files, your keys, and your network. A pattern can match more than you expect. A pattern for an interpreter, such as python, lets ${n.runner} run any code. The deny list and the Log tab only reduce mistakes. They do not stop an attacker.`;

// "Longest command" in minutes. The server takes 1 s to max, BASH_TIMEOUT_MAX_SEC by default.
export const timeoutMinutes = (sec: number) => String(Math.round((sec / 60) * 100) / 100);
export function timeoutSec(minutes: string, max = BASH_TIMEOUT_MAX_SEC): number | null {
  const m = Number(minutes.trim());
  if (!minutes.trim() || !Number.isFinite(m)) return null;
  const sec = Math.round(m * 60);
  return sec >= 1 && sec <= max ? sec : null;
}
export const TIMEOUT_PROBLEM = `Enter a time from 1 second to ${BASH_TIMEOUT_MAX_SEC / 60} minutes.`;

// "Test files" of Settings > Commands (spec.md section 6.7, AC-B161): one glob per line. No glob stores null, which takes the defaults.
export const testGlobsText = (globs: readonly string[] | null) => (globs ?? []).join("\n");
export function parseTestGlobs(text: string): { globs: string[] | null } | { problem: string } {
  const globs = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (globs.length > TEST_GLOBS_MAX) return { problem: `Enter ${TEST_GLOBS_MAX} globs at most.` };
  if (globs.some((g) => g.length > TEST_GLOB_MAX)) return { problem: `Each glob has ${TEST_GLOB_MAX} characters at most.` };
  return { globs: globs.length ? globs : null };
}

// The allow picks of the plan approval (spec.md section 6.21.3): each ticked row that the list does not hold. An unchanged proposal goes
// as its ID, an edited or added row as the whole entry. warning: the picks need the first-use warning.
export function planAllow(
  plan: Pick<TaskPlanDto, "allow" | "shellWarning">,
  drafts: readonly AllowDraft[],
  picked: ReadonlySet<string>,
): { allow: NonNullable<TaskPlanInput["allow"]>; warning: boolean } {
  const allow: NonNullable<TaskPlanInput["allow"]> = [];
  for (const d of drafts) {
    const offered = plan.allow.find((o) => o.id === d.id);
    if (!picked.has(d.id) || offered?.saved) continue;
    const pattern = d.pattern.trim();
    const reason = d.reason.trim();
    allow.push(offered && offered.pattern === pattern && offered.reason === reason ? d.id : { id: d.id, pattern, reason });
  }
  return { allow, warning: plan.shellWarning && allow.length > 0 };
}

// The decisions of an allow request. A request without a pick takes "Allow once" (spec.md section 6.21.4).
export function allowDecisions(ask: Pick<TaskAllowAskDto, "requests" | "warning">, picks: Readonly<Record<string, AllowChoice>>) {
  const decisions = ask.requests.map((r) => ({ pattern: r.pattern, choice: picks[r.pattern] ?? ("once" as const) }));
  return { decisions, warning: ask.warning && decisions.some((d) => d.choice === "repo") };
}
