// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The commands that the runner may run (docs/plans/review-v2/spec.md section 6.21): the rows of the allowlist editors, the picks of the
// plan screen and of an allow request, the first-use warnings, and the words of the mode. UI code holds no product name
// (tests/ui/names.test.ts), so each text takes the names from GET /api/meta.
import type { TaskAllowAskDto, TaskPlanDto, TaskPlanInput } from "../../shared/dto";
import { type AllowChoice, type AllowEntry, allowProblem, BASH_TIMEOUT_MAX_SEC, type ShellMode } from "../../shared/task";

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

// "Commands: allowlist, 2 patterns" or "Commands: any command". n: the patterns of the list or of the run.
export const shellText = (mode: ShellMode, n: number) =>
  mode === "any" ? "Commands: any command" : `Commands: allowlist, ${n} ${n === 1 ? "pattern" : "patterns"}`;

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

// spec.md section 6.21.8: the dialog before each switch to Any command, and the first-use warning of the allowlist.
export const ANY_TITLE = "Turn on Any command?";
export const anyText = (n: ShellNames) =>
  `Any command lets ${n.runner} run every command as you, with your files, your keys, and your network. Any command can write any file that you can write. Text in a ${n.tracker} task, an attachment, or a comment can tell ${n.runner} to run a harmful command. The deny list and the Log tab only reduce mistakes. They do not stop an attacker. Use Any command only for repositories and tasks that you trust.`;
export const warningTitle = (n: ShellNames) => `Commands that ${n.runner} runs`;
export const warningText = (n: ShellNames) =>
  `${n.runner} can run each command that matches this list, as you, with your files, your keys, and your network. A pattern can match more than you expect. A pattern for an interpreter, such as python, lets ${n.runner} run any code. The deny list and the Log tab only reduce mistakes. They do not stop an attacker.`;

// "Longest command" in minutes. The server takes 1 s to BASH_TIMEOUT_MAX_SEC.
export const timeoutMinutes = (sec: number) => String(Math.round((sec / 60) * 100) / 100);
export function timeoutSec(minutes: string): number | null {
  const m = Number(minutes.trim());
  if (!minutes.trim() || !Number.isFinite(m)) return null;
  const sec = Math.round(m * 60);
  return sec >= 1 && sec <= BASH_TIMEOUT_MAX_SEC ? sec : null;
}
export const TIMEOUT_PROBLEM = `Enter a time from 1 second to ${BASH_TIMEOUT_MAX_SEC / 60} minutes.`;

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
