// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The editable list of task commands (docs/plans/review-v2/spec.md section 6.3): name, kind, time limit, and the command line of each
// row, Move up, Move down, Remove, and "Add a command". The list order is the run order. The plan screen adds a tick per row and the
// reason of a proposed time limit; Settings > Commands has none. A command stays an argv list (commands.ts).
import { ArrowDown, ArrowUp, CircleAlert, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_TASK_COMMANDS } from "../../shared/dto";
import { CHECK_TIMEOUT_SEC, type CommandKind, SETUP_TIMEOUT_SEC } from "../../shared/task";
import { Hint } from "../shell/Hint";
import {
  type CommandDraft,
  commandTimeout,
  defaultMinutes,
  draftProblem,
  freeId,
  joinArgv,
  KIND_TEXT,
  KINDS,
  LIMIT_PROBLEM,
  moveDraft,
  splitArgv,
} from "./commands";

const SETUP_MIN = SETUP_TIMEOUT_SEC / 60;
const CHECK_MIN = CHECK_TIMEOUT_SEC / 60;

const iconBtn =
  "inline-grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-ink-2 hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";

export function CommandsEditor(props: {
  // The prefix of the DOM IDs, unique on the page.
  idPrefix: string;
  drafts: CommandDraft[];
  // typing: a key in a field, so the caller can wait before a save.
  onChange: (drafts: CommandDraft[], typing: boolean) => void;
  onBlur?: () => void;
  // The plan screen: the ticked rows run. Absent: every row runs.
  picked?: ReadonlySet<string>;
  onPick?: (id: string, on: boolean) => void;
  // The IDs of the commands that the repository approved before.
  saved?: ReadonlySet<string>;
  // The ID prefix of an added row.
  newPrefix: string;
  // The runner name for the reason of a proposed time limit.
  runner?: string;
}) {
  const { drafts, idPrefix } = props;
  const set = (i: number, patch: Partial<CommandDraft>, typing = true) =>
    props.onChange(
      drafts.map((d, k) => (k === i ? { ...d, ...patch } : d)),
      typing,
    );
  const add = () => {
    const id = freeId(drafts, props.newPrefix);
    props.onChange([...drafts, { id, name: "", kind: "test", line: "", minutes: defaultMinutes("test") }], false);
    props.onPick?.(id, true);
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-${id}-name`)?.focus());
  };
  const move = (i: number, d: -1 | 1) => {
    const row = drafts[i];
    if (!row) return;
    const j = i + d;
    props.onChange(moveDraft(drafts, i, d), false);
    // The button in the same direction is disabled at the end of the list.
    const end = d < 0 ? j === 0 : j === drafts.length - 1;
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-${row.id}-${d < 0 !== end ? "up" : "down"}`)?.focus());
  };
  return (
    <div className="grid gap-2">
      {drafts.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {drafts.map((d, i) => {
            const id = `${idPrefix}-${d.id}`;
            const problem = draftProblem(d);
            const limitBad = commandTimeout(d.minutes) === null;
            const r = splitArgv(d.line);
            const label = d.name.trim() || `command ${i + 1}`;
            return (
              <li key={d.id} data-command-row className="grid gap-1.5 rounded-md border bg-card px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {props.picked && (
                    <input
                      type="checkbox"
                      aria-label={`Run ${label}: ${"argv" in r ? joinArgv(r.argv) : d.line}`}
                      checked={props.picked.has(d.id)}
                      className="m-0 size-4 accent-foreground"
                      onChange={(e) => props.onPick?.(d.id, e.target.checked)}
                    />
                  )}
                  <Input
                    id={`${id}-name`}
                    aria-label={`Name of ${label}`}
                    className="h-[30px] w-40 min-w-0"
                    value={d.name}
                    maxLength={60}
                    placeholder="Name"
                    autoComplete="off"
                    onChange={(e) => set(i, { name: e.target.value })}
                    onBlur={props.onBlur}
                  />
                  <select
                    id={`${id}-kind`}
                    aria-label={`Kind of ${label}`}
                    className="h-[30px] rounded-md border border-input bg-pane px-1.5 text-sm text-foreground"
                    value={d.kind}
                    onChange={(e) => {
                      const kind = e.target.value as CommandKind;
                      set(i, { kind, ...(d.minutes === defaultMinutes(d.kind) && { minutes: defaultMinutes(kind) }) }, false);
                    }}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_TEXT[k]}
                      </option>
                    ))}
                  </select>
                  {props.saved?.has(d.id) && <span className="text-xs text-muted-foreground">approved before</span>}
                  <Hint label="Move up">
                    <button
                      type="button"
                      id={`${id}-up`}
                      className={`${iconBtn} ml-auto`}
                      aria-label={`Move ${label} up`}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp aria-hidden className="size-[15px]" />
                    </button>
                  </Hint>
                  <Hint label="Move down">
                    <button
                      type="button"
                      id={`${id}-down`}
                      className={iconBtn}
                      aria-label={`Move ${label} down`}
                      disabled={i === drafts.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown aria-hidden className="size-[15px]" />
                    </button>
                  </Hint>
                  <Hint label="Remove">
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={`Remove ${label}`}
                      onClick={() =>
                        props.onChange(
                          drafts.filter((_, k) => k !== i),
                          false,
                        )
                      }
                    >
                      <X aria-hidden className="size-[15px]" />
                    </button>
                  </Hint>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id={`${id}-line`}
                    aria-label={`Command line of ${label}`}
                    aria-invalid={problem && problem !== LIMIT_PROBLEM ? true : undefined}
                    aria-describedby={problem && problem !== LIMIT_PROBLEM ? `${id}-error` : `${idPrefix}-help`}
                    className="h-[30px] min-w-0 flex-1 basis-60 font-mono text-[12.5px]"
                    translate="no"
                    spellCheck={false}
                    autoComplete="off"
                    value={d.line}
                    placeholder="bun test"
                    onChange={(e) => set(i, { line: e.target.value })}
                    onBlur={props.onBlur}
                  />
                  <span className="flex shrink-0 items-center gap-1.5">
                    <label htmlFor={`${id}-timeout`} className="text-xs whitespace-nowrap text-ink-2">
                      Time limit (min)
                    </label>
                    <Input
                      id={`${id}-timeout`}
                      aria-label={`Time limit (min) of ${label}`}
                      type="number"
                      inputMode="decimal"
                      // No min or max: the browser check would block the plan form without the inline problem text.
                      step="any"
                      className="h-[30px] w-20 tabular-nums"
                      autoComplete="off"
                      aria-invalid={limitBad ? true : undefined}
                      aria-describedby={limitBad ? `${id}-error` : undefined}
                      value={d.minutes}
                      onChange={(e) => set(i, { minutes: e.target.value })}
                      onBlur={props.onBlur}
                    />
                  </span>
                </div>
                {d.reason && (
                  <p className="m-0 text-xs text-ink-2">
                    {props.runner ? `${props.runner}: ` : ""}
                    {d.reason}
                  </p>
                )}
                {problem && (
                  <p id={`${id}-error`} className="m-0 flex items-start gap-[5px] text-xs text-destructive">
                    <CircleAlert aria-hidden className="mt-px size-[13px] shrink-0" />
                    {problem}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p id={`${idPrefix}-help`} className="m-0 text-xs text-muted-foreground">
        Commands run one at a time, top to bottom. Setup runs first, once per worktree. The app runs each command without a shell, from the
        repository root. Spaces split the arguments. Quotes keep spaces in one argument. Setup gets {SETUP_MIN} minutes by default, the
        other commands {CHECK_MIN}. A command stops at its time limit.
      </p>
      <div>
        <Button type="button" variant="outline" size="sm" disabled={drafts.length >= MAX_TASK_COMMANDS} onClick={add}>
          <Plus data-icon="inline-start" />
          Add a command
        </Button>
      </div>
    </div>
  );
}
