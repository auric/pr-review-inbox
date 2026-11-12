// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Settings > Tasks, "Run limits" (docs/plans/review-v2/limits.md decision 3). Each valid change saves by itself (autosave.tsx). A field
// with a problem holds only its own value back. The server reads each value when a run starts.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SettingsDto, SettingsInput } from "../../shared/dto";
import { type RunLimits as Limits, RUN_LIMIT_KEYS, RUN_LIMITS, type RunLimitKey, runLimitValue } from "../../shared/task";
import { api } from "../api";
import { useMeta } from "../meta";
import { read } from "../shell/data";
import { SaveStatus, TYPING_MS, useSaver } from "./autosave";

// runner: the short runner name of the meta, such as the name of the CLI.
const FIELDS: Record<RunLimitKey, { label: string; unit: string; help: (runner: string) => string }> = {
  stepMinutes: {
    label: "Task step time",
    unit: "minutes",
    help: (r) => `${r} stops one step of a task after this time. The part time limit can stop it earlier.`,
  },
  reviewMinutes: {
    label: "Review run time",
    unit: "minutes",
    help: (r) => `${r} stops a review, Explain, Ask, Fix, interview, or plan run after this time.`,
  },
  interviewRounds: {
    label: "Interview rounds",
    unit: "rounds",
    help: (r) => `${r} can ask questions in this number of rounds before it writes the plan.`,
  },
  testFixTries: {
    label: "Test-fix tries",
    unit: "tries",
    help: (r) => `${r} tries to fix red tests this number of times. Then the task waits for you.`,
  },
  planTurns: { label: "Plan turns", unit: "turns", help: () => "The plan run stops after this number of turns." },
  runsAtOnce: {
    label: "Runs at once",
    unit: "runs",
    help: (r) =>
      `Reviews, Explain, Ask, Fix, and task steps share this number. Each pull request has one run at a time. Builds of 2 or more sub-tasks at once run beside it. More runs use your ${r} usage faster.`,
  },
};

const toDrafts = (l: Limits) => Object.fromEntries(RUN_LIMIT_KEYS.map((k) => [k, String(l[k])])) as Record<RunLimitKey, string>;

export function RunLimits({ settings }: { settings: SettingsDto }) {
  const qc = useQueryClient();
  const runner = useMeta().data?.runner.short ?? "";
  const [drafts, setDrafts] = useState(() => toDrafts(settings.runLimits));
  const current = () => qc.getQueryData<SettingsDto>(["settings"]) ?? settings;
  const { state, saver } = useSaver(
    (): SettingsInput | null => {
      const s = current();
      const changed: Partial<Limits> = {};
      for (const k of RUN_LIMIT_KEYS) {
        const n = runLimitValue(k, drafts[k]);
        if (n !== null && n !== s.runLimits[k]) changed[k] = n;
      }
      return Object.keys(changed).length ? { baseUrl: s.baseUrl ?? "", caFile: s.caFile ?? "", runLimits: changed } : null;
    },
    async (input: SettingsInput) => {
      qc.setQueryData(["settings"], await read<SettingsDto>(await api.api.settings.$put({ json: input })));
      // A new "Runs at once" frees or fills the run pool at once (spec.md section 6.26, AC-B191).
      void qc.invalidateQueries({ queryKey: ["runs", "slots"] });
    },
  );
  const bad = RUN_LIMIT_KEYS.some((k) => runLimitValue(k, drafts[k]) === null);

  return (
    <div className="grid gap-3 border-t pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="limits-title" className="m-0 text-sm font-semibold">
          Run limits
        </h3>
        <SaveStatus
          id="limits-status"
          state={state}
          problem={bad ? "A marked limit is not saved. Fix it to save it." : null}
          saved="Saved. New runs use these limits."
          onRetry={() => saver.request(0)}
        />
      </div>
      <FieldGroup role="group" aria-labelledby="limits-title" className="gap-4">
        {RUN_LIMIT_KEYS.map((k) => {
          const f = FIELDS[k];
          const { def, min, max } = RUN_LIMITS[k];
          const invalid = runLimitValue(k, drafts[k]) === null;
          const id = `limit-${k}`;
          return (
            <Field key={k} data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={id}>{f.label}</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id={id}
                  name={k}
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  step={1}
                  className="h-[30px] w-24"
                  aria-invalid={invalid || undefined}
                  aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ""}`}
                  value={drafts[k]}
                  onChange={(e) => {
                    setDrafts((d) => ({ ...d, [k]: e.target.value }));
                    saver.request(TYPING_MS);
                  }}
                  onBlur={() => void saver.flush()}
                />
                <span className="text-sm text-ink-2">{f.unit}</span>
              </div>
              <FieldDescription id={`${id}-help`}>
                {f.help(runner)} Default {def}. From {min} to {max}.
              </FieldDescription>
              {invalid && (
                <FieldError id={`${id}-error`}>
                  Type a whole number from {min} to {max}.
                </FieldError>
              )}
            </Field>
          );
        })}
      </FieldGroup>
    </div>
  );
}
