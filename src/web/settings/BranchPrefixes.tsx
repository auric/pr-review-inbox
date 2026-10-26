// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Settings > Tasks (docs/plans/review-v2/spec.md section 6.16.1): the ordered list "Branch prefixes" of the plan screen chips, with the
// row controls of TaskRules.tsx, and the approved commands of each task repository (TaskCommands.tsx). Each change saves by itself
// (autosave.tsx). A row with a problem holds the save back.
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CircleAlert, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SettingsDto, SettingsInput } from "../../shared/dto";
import { PREFIX_MAX, PREFIXES_MAX } from "../../shared/task";
import { api } from "../api";
import { read } from "../shell/data";
import { Hint } from "../shell/Hint";
import { SaveStatus, TYPING_MS, useSaver } from "./autosave";
import {
  changePrefixes,
  listProblem,
  PREFIX_ADD_ID,
  type PrefixChange,
  prefixesToSave,
  prefixFocus,
  prefixId,
  prefixProblems,
  toPrefixDrafts,
} from "./prefixes";
import { TaskCommands } from "./TaskCommands";

const iconBtn =
  "inline-grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-ink-2 hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function BranchPrefixes({ settings }: { settings: SettingsDto }) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState(() => toPrefixDrafts(settings.taskBranchPrefixes));
  // The newest rows. Event handlers set them before the render, so a save in the same handler sends the change.
  const latest = useRef(drafts);
  const [focus, setFocus] = useState<string | null>(null);
  const problems = prefixProblems(drafts);
  const whole = listProblem(drafts);

  // The cache holds the newest saved settings, also after a save in another section.
  const current = () => qc.getQueryData<SettingsDto>(["settings"]) ?? settings;
  const { state, saver } = useSaver(
    (): SettingsInput | null => {
      const s = current();
      const list = prefixesToSave(latest.current);
      if (!list || same(list, s.taskBranchPrefixes)) return null;
      return { baseUrl: s.baseUrl ?? "", caFile: s.caFile ?? "", taskBranchPrefixes: list };
    },
    async (input: SettingsInput) => {
      qc.setQueryData(["settings"], await read<SettingsDto>(await api.api.settings.$put({ json: input })));
    },
  );

  // Focus moves after the list renders with the change.
  useEffect(() => {
    if (focus) document.getElementById(focus)?.focus();
    setFocus(null);
  }, [focus]);

  // delay: 0 for a list change; TYPING_MS for a key in a field.
  const apply = (c: PrefixChange, delay = 0) => {
    const next = changePrefixes(latest.current, c);
    latest.current = next;
    setDrafts(next);
    const to = prefixFocus(c, next.length);
    if (to) setFocus(to);
    saver.request(delay);
  };

  const shown = problems.some((p) => p !== null) || whole;
  return (
    <section aria-labelledby="h-tasks" className="mt-6 grid max-w-[560px] gap-3 border-t pt-4">
      <div className="grid gap-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id="h-tasks" tabIndex={-1} className="m-0 scroll-mt-4 text-[15px] font-bold outline-none">
            Tasks
          </h2>
          <SaveStatus
            id="tasks-status"
            state={state}
            problem={shown ? "A marked prefix is not saved. Fix it to save the list." : null}
            saved="Saved. New plans offer these prefixes."
            onRetry={() => saver.request(0)}
          />
        </div>
        <p className="m-0 text-xs text-muted-foreground">
          Changes save as you make them. Text saves when you leave the field or stop typing.
        </p>
      </div>
      <div className="grid gap-1.5">
        <h3 id="prefixes-title" className="m-0 text-sm font-semibold">
          Branch prefixes
        </h3>
        <p id="prefixes-help" className="m-0 text-sm text-ink-2">
          A task branch starts with one of these, such as <code className="font-mono text-xs">feature/</code>. The first prefix starts
          selected on the plan screen.
        </p>
      </div>
      <ol aria-labelledby="prefixes-title" aria-describedby="prefixes-help" className="m-0 list-none border-t p-0">
        {drafts.map((r, i) => {
          const n = i + 1;
          const problem = problems[i] ?? null;
          return (
            <li key={r.id} className="grid grid-cols-[2ch_minmax(0,22rem)_auto] items-center gap-x-3 gap-y-1 border-b py-2">
              <span aria-hidden className="text-right text-sm text-muted-foreground">
                {n}
              </span>
              <input
                id={prefixId(i, "text")}
                name={`branchPrefix${n}`}
                aria-label={`Prefix ${n}`}
                className="h-[30px] w-full min-w-0 rounded-md border border-input bg-pane px-2 font-mono text-[12.5px] text-foreground focus-visible:outline-offset-0 aria-invalid:border-destructive"
                value={r.text}
                maxLength={PREFIX_MAX}
                placeholder="feature/"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? prefixId(i, "error") : undefined}
                onChange={(e) => apply({ act: "edit", i, text: e.target.value }, TYPING_MS)}
                onBlur={() => {
                  if (latest.current[i]?.fresh) apply({ act: "leave", i }, TYPING_MS);
                  void saver.flush();
                }}
              />
              <span className="flex gap-0.5">
                <Hint label="Move up">
                  <button
                    type="button"
                    id={prefixId(i, "up")}
                    className={iconBtn}
                    aria-label={`Move prefix ${n} up`}
                    disabled={i === 0}
                    onClick={() => apply({ act: "move", i, d: -1 })}
                  >
                    <ArrowUp aria-hidden className="size-[15px]" />
                  </button>
                </Hint>
                <Hint label="Move down">
                  <button
                    type="button"
                    id={prefixId(i, "down")}
                    className={iconBtn}
                    aria-label={`Move prefix ${n} down`}
                    disabled={i === drafts.length - 1}
                    onClick={() => apply({ act: "move", i, d: 1 })}
                  >
                    <ArrowDown aria-hidden className="size-[15px]" />
                  </button>
                </Hint>
                <Hint label="Remove">
                  <button
                    type="button"
                    id={prefixId(i, "remove")}
                    className={iconBtn}
                    aria-label={`Remove prefix ${n}`}
                    onClick={() => apply({ act: "remove", i })}
                  >
                    <X aria-hidden className="size-[15px]" />
                  </button>
                </Hint>
              </span>
              {problem && (
                <p id={prefixId(i, "error")} className="col-start-2 m-0 flex items-start gap-[5px] text-xs text-destructive">
                  <CircleAlert aria-hidden className="mt-px size-[15px] shrink-0" />
                  <span>{problem}</span>
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {whole && (
        <p className="m-0 flex items-start gap-[5px] text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
          <span>{whole}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          id={PREFIX_ADD_ID}
          variant="outline"
          size="sm"
          disabled={drafts.length >= PREFIXES_MAX}
          aria-describedby={drafts.length >= PREFIXES_MAX ? "prefixes-max" : undefined}
          onClick={() => apply({ act: "add" })}
        >
          <Plus data-icon="inline-start" />
          Add a prefix
        </Button>
        {drafts.length >= PREFIXES_MAX && (
          <span id="prefixes-max" className="text-xs text-muted-foreground">
            At most {PREFIXES_MAX} prefixes.
          </span>
        )}
      </div>
      <TaskCommands />
    </section>
  );
}
