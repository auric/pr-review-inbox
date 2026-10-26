// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The command line of an approved task command (docs/plans/review-v2/spec.md section 6.3, commands_json). A command stays an argv
// list: the line is only its text form. No shell parses it, so no backslash escape exists, and a Windows path keeps its backslashes.
// Spaces split the arguments. Double or single quotes keep spaces and the other quote. Quoted parts next to text join one argument.
import { COMMAND_KINDS, type CommandKind, MAX_TASK_COMMAND_ARGS, type TaskCommand } from "../../shared/task";

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

// One row of a command editor. line: the typed command line.
export type CommandDraft = { id: string; name: string; kind: CommandKind; line: string; timeoutSec: number };

export const toDraft = (c: TaskCommand): CommandDraft => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  line: joinArgv(c.argv),
  timeoutSec: c.timeoutSec,
});

// The problem of a row, or null.
export function draftProblem(d: CommandDraft): string | null {
  if (!d.name.trim()) return "Give the command a name.";
  const r = splitArgv(d.line);
  return "error" in r ? r.error : null;
}

// The commands of the rows, or null while a row has a problem.
export function draftsToCommands(drafts: readonly CommandDraft[]): TaskCommand[] | null {
  const out: TaskCommand[] = [];
  for (const d of drafts) {
    const r = splitArgv(d.line);
    if ("error" in r || !d.name.trim()) return null;
    out.push({ id: d.id, name: d.name.trim(), kind: d.kind, argv: r.argv, timeoutSec: d.timeoutSec });
  }
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
