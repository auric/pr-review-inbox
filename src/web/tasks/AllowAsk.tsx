// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The row of a task that waits on blocked kind allow (docs/plans/review-v2/spec.md section 6.21.4): each command that the step asks
// to allow, with the refused command, the runner's reason, and the choice Allow once (default), Allow for this repository, or Refuse. The
// header button "Continue" submits this form. The first "Allow for this repository" shows the first-use warning first.
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { TaskAllowAskDto } from "../../shared/dto";
import { ALLOW_CHOICES, type AllowChoice, allowWarning } from "../../shared/task";
import { type ShellAsk, ShellDialog, useShellNames } from "./AllowEditor";
import { allowDecisions, CHOICE_TEXT, choiceLine } from "./allow";

export const ALLOW_FORM = "task-allow";

export function AllowAskForm(props: {
  ask: TaskAllowAskDto;
  runner: string;
  onSend: (decisions: { pattern: string; choice: AllowChoice }[], shellWarning: boolean) => void;
}) {
  const { ask, runner } = props;
  const [picks, setPicks] = useState<Record<string, AllowChoice>>({});
  const [dialog, setDialog] = useState<ShellAsk | null>(null);
  const n = ask.requests.length;
  const names = useShellNames();
  return (
    <form
      id={ALLOW_FORM}
      aria-labelledby="task-allow-title"
      className="grid gap-3 rounded-md border bg-card px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        const { decisions, warning } = allowDecisions(ask, picks);
        if (warning) setDialog({ kind: "warning", run: () => props.onSend(decisions, true) });
        else props.onSend(decisions, false);
      }}
    >
      <div className="grid gap-0.5">
        <p id="task-allow-title" className="m-0 text-sm font-semibold">
          {runner} asks to allow {n === 1 ? "a command" : `${n} commands`}.
        </p>
        <p className="m-0 text-sm text-ink-2">
          {names.cli} refused {n === 1 ? "this command" : "these commands"} in the step. Pick a choice for each pattern, then Continue runs
          the step again from the last commit.
        </p>
      </div>
      {ask.requests.map((r, i) => {
        const id = `task-allow-${i}`;
        const warning = allowWarning(r.pattern);
        const choice = picks[r.pattern] ?? "once";
        return (
          <fieldset
            key={r.pattern}
            data-allow-ask={r.pattern}
            aria-describedby={`${id}-info`}
            className="m-0 min-w-0 border-0 border-t p-0 pt-3"
          >
            {/* A floated legend sits inside the box, not on its border. */}
            <legend className="float-left mb-1.5 w-full p-0">
              <code
                translate="no"
                className="inline-block max-w-full rounded-[5px] bg-pane px-1.5 py-0.5 font-mono text-[12.5px] font-semibold [overflow-wrap:anywhere]"
              >
                {r.pattern}
              </code>
            </legend>
            <div className="clear-both grid gap-1.5">
              <dl id={`${id}-info`} className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-ink-2">Refused command</dt>
                <dd className="m-0">
                  <code translate="no" className="font-mono text-xs [overflow-wrap:anywhere]">
                    {r.command}
                  </code>
                </dd>
                <dt className="text-ink-2">{runner}'s reason</dt>
                <dd className="m-0 [overflow-wrap:anywhere]">{r.reason || "None given."}</dd>
              </dl>
              {warning && (
                <p className="m-0 flex items-start gap-[5px] text-xs font-medium text-warn">
                  <TriangleAlert aria-hidden className="mt-px size-[13px] shrink-0" />
                  {warning}
                </p>
              )}
              <div className="grid gap-0.5">
                {ALLOW_CHOICES.map((c) => (
                  <label
                    key={c}
                    className="-mx-1.5 grid min-h-6 cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-[5px] px-1.5 py-1 hover:bg-hover"
                  >
                    <input
                      id={`${id}-${c}`}
                      type="radio"
                      name={id}
                      checked={choice === c}
                      aria-describedby={`${id}-${c}-line`}
                      className="m-0 mt-[3px] size-4 accent-foreground"
                      onChange={() => setPicks((p) => ({ ...p, [r.pattern]: c }))}
                    />
                    <span className="text-sm">{CHOICE_TEXT[c]}</span>
                    <span id={`${id}-${c}-line`} className="col-start-2 text-xs text-muted-foreground">
                      {choiceLine(c, names)}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </fieldset>
        );
      })}
      <ShellDialog ask={dialog} onClose={() => setDialog(null)} />
    </form>
  );
}
