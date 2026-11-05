// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The command line of an approved task command (docs/plans/review-v2/spec.md section 6.3, commands_json). A command stays an argv
// list: the line is only its text form. No shell parses it, so no backslash escape exists, and a Windows path keeps its backslashes.
// Spaces split the arguments. Double or single quotes keep spaces and the other quote. Quoted parts next to text join one argument.
import {
  COMMAND_KINDS,
  COMMAND_TIMEOUT_MAX_SEC,
  type CommandKind,
  defaultTimeoutSec,
  MAX_TASK_COMMAND_ARGS,
  type TaskCommand,
} from "../../shared/task";
import { timeoutMinutes, timeoutSec } from "./allow";

export function splitArgv(line: string): { argv: string[] } | { error: string } {
  const argv: string[] = [];
  let cur: string | null = null;
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur ??= "";
    } else if (/\s/.test(ch)) {
      if (cur !== null) argv.push(cur);
      cur = null;
    } else cur = (cur ?? "") + ch;
  }
  if (quote) return { error: `Close the ${quote === '"' ? "double" : "single"} quote.` };
  if (cur !== null) argv.push(cur);
  if (!argv.length) return { error: "Type the command." };
  if (argv.some((a) => a === "")) return { error: "An argument is empty. Remove the empty quotes." };
  if (argv.length > MAX_TASK_COMMAND_ARGS) return { error: `A command has at most ${MAX_TASK_COMMAND_ARGS} arguments.` };
  return { argv };
}

// The inverse of splitArgv: splitArgv(joinArgv(a)) gives a again.
export function joinArgv(argv: readonly string[]): string {
  return argv
    .map((a) => {
      if (a && !/[\s"']/.test(a)) return a;
      if (!a.includes('"')) return `"${a}"`;
      if (!a.includes("'")) return `'${a}'`;
      return a
        .split('"')
        .map((p) => `"${p}"`)
        .join(`'"'`);
    })
    .join(" ");
}

// One row of a command editor. line: the typed command line. minutes: the typed time limit (spec.md section 6.3). reason: why the
// plan proposes a longer time limit.
export type CommandDraft = { id: string; name: string; kind: CommandKind; line: string; minutes: string; reason?: string };

export const toDraft = (c: TaskCommand & { timeoutReason?: string }): CommandDraft => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  line: joinArgv(c.argv),
  minutes: timeoutMinutes(c.timeoutSec),
  ...(c.timeoutReason && { reason: c.timeoutReason }),
});

// The time limit of a new row, and of a row whose kind changes while it keeps the default of its old kind.
export const defaultMinutes = (kind: CommandKind) => timeoutMinutes(defaultTimeoutSec(kind));
export const commandTimeout = (minutes: string) => timeoutSec(minutes, COMMAND_TIMEOUT_MAX_SEC);
export const LIMIT_PROBLEM = `Enter a time limit from 1 second to ${COMMAND_TIMEOUT_MAX_SEC / 60} minutes.`;

// The problem of a row, or null.
export function draftProblem(d: CommandDraft): string | null {
  if (!d.name.trim()) return "Give the command a name.";
  const r = splitArgv(d.line);
  if ("error" in r) return r.error;
  return commandTimeout(d.minutes) === null ? LIMIT_PROBLEM : null;
}

// The commands of the rows, or null while a row has a problem.
export function draftsToCommands(drafts: readonly CommandDraft[]): TaskCommand[] | null {
  const out: TaskCommand[] = [];
  for (const d of drafts) {
    const r = splitArgv(d.line);
    const sec = commandTimeout(d.minutes);
    if ("error" in r || !d.name.trim() || sec === null) return null;
    out.push({ id: d.id, name: d.name.trim(), kind: d.kind, argv: r.argv, timeoutSec: sec });
  }
  return out;
}

// The rows with row i moved by d. The list order is the run order. Out of range: the same list.
export function moveDraft<T>(drafts: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  const row = drafts[i];
  if (row === undefined || j < 0 || j >= drafts.length) return drafts;
  const out = drafts.filter((_, k) => k !== i);
  out.splice(j, 0, row);
  return out;
}

// The first free ID with the prefix, such as cmd3 or new-u2. The server gives a "new-" command a stored ID at the plan approval.
export function freeId(drafts: readonly { id: string }[], prefix: string): string {
  let n = 1;
  while (drafts.some((d) => d.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const KINDS = COMMAND_KINDS;
export const KIND_TEXT: Record<CommandKind, string> = { setup: "Setup", build: "Build", test: "Test", lint: "Lint" };
