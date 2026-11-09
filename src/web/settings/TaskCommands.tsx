// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Settings > Commands: per task repository, the approved commands that the app runs (docs/plans/review-v2/spec.md section 6.3,
// repo_task_settings.commands_json) with the editor of the plan screen, and the commands that the runner may run (section 6.21): the mode,
// the allowlist, and "Longest command". Each change saves by itself (autosave.tsx). The first-use warning of the app commands stays on
// the plan screen: a saved list here does not accept it. The first pattern, the first switch to "<runner> may run the approved checks",
// and each switch to Most commands or to Unrestricted show their own dialog here.
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import type { RepoTaskSettingsDto, RepoTaskSettingsInput } from "../../shared/dto";
import { SHELL_MODES, type ShellMode, TASK_CACHE_ENV } from "../../shared/task";
import { api } from "../api";
import { read } from "../shell/data";
import { AllowEditor, type ShellAsk, ShellDialog, useShellNames } from "../tasks/AllowEditor";
import {
  type AllowDraft,
  draftsToAllow,
  MODE_TEXT,
  modeLine,
  TIMEOUT_PROBLEM,
  timeoutMinutes,
  timeoutSec,
  toAllowDraft,
} from "../tasks/allow";
import { CommandsEditor } from "../tasks/CommandsEditor";
import { type CommandDraft, draftsToCommands, toDraft } from "../tasks/commands";
import { useRepoTaskSettings, useTasks } from "../tasks/data";
import { SaveStatus, TYPING_MS, useSaver } from "./autosave";

export function TaskCommands() {
  const tasks = useTasks();
  const runner = useShellNames().runner;
  const repos = [...new Map((tasks.data ?? []).map((t) => [`${t.project}/${t.repo}`, { project: t.project, repo: t.repo }])).values()].sort(
    (a, b) => `${a.project}/${a.repo}`.localeCompare(`${b.project}/${b.repo}`),
  );
  return (
    <section aria-labelledby="h-commands" className="mt-6 grid max-w-[560px] gap-3 border-t pt-4">
      <div className="grid gap-0.5">
        <h2 id="h-commands" tabIndex={-1} className="m-0 scroll-mt-4 text-[15px] font-bold outline-none">
          Commands
        </h2>
        <p className="m-0 text-xs text-muted-foreground">
          Changes save as you make them. Text saves when you leave the field or stop typing.
        </p>
      </div>
      <p className="m-0 text-sm text-ink-2">
        The app runs the approved commands of a repository after each step of a task. {runner} runs only the commands that the repository
        allows. The plan screen adds the commands that you approve.
      </p>
      {tasks.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : tasks.error ? (
        <p className="m-0 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
          Cannot read the tasks. {tasks.error.message}
        </p>
      ) : repos.length ? (
        <ul aria-label="Task repositories" className="m-0 grid list-none rounded-md border p-0">
          {repos.map((r) => (
            <RepoCommands key={`${r.project}/${r.repo}`} project={r.project} repo={r.repo} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">No repository yet. A repository shows here after you start a task in it.</p>
      )}
    </section>
  );
}

function RepoCommands({ project, repo }: { project: string; repo: string }) {
  const name = `${project}/${repo}`;
  const [open, setOpen] = useState(false);
  return (
    <li data-task-commands={name} className="border-b last:border-b-0">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer px-3 py-2">
          <span translate="no" className="font-mono text-sm font-semibold [overflow-wrap:anywhere]">
            {name}
          </span>
        </summary>
        {open && <RepoCommandsBody project={project} repo={repo} />}
      </details>
    </li>
  );
}

function RepoCommandsBody({ project, repo }: { project: string; repo: string }) {
  const q = useRepoTaskSettings(project, repo);
  if (q.isPending) return <Skeleton className="mx-3 mb-3 h-10" />;
  if (q.error)
    return (
      <p className="m-0 flex items-start gap-1.5 px-3 pb-3 text-sm text-destructive">
        <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
        Cannot read the commands. {q.error.message}
      </p>
    );
  return <Editor s={q.data} />;
}

type Rows = { commands: CommandDraft[]; allow: AllowDraft[]; mode: ShellMode; minutes: string; cache: boolean; checks: boolean };

function Editor({ s }: { s: RepoTaskSettingsDto }) {
  const qc = useQueryClient();
  const names = useShellNames();
  const key = ["task-settings", s.project, s.repo];
  const [rows, setRows] = useState<Rows>(() => ({
    commands: s.commands.map(toDraft),
    allow: s.allow.map(toAllowDraft),
    mode: s.shellMode,
    minutes: timeoutMinutes(s.bashTimeoutSec),
    cache: s.taskCache,
    checks: s.runChecks,
  }));
  // The newest rows. Event handlers set them before the render, so a save in the same handler sends the change.
  const latest = useRef(rows);
  // A shell warning that the user accepted on this page. The server keeps the first time.
  const warned = useRef(s.shellWarnedAt !== null);
  const [ask, setAsk] = useState<ShellAsk | null>(null);
  const commands = draftsToCommands(rows.commands);
  const allow = draftsToAllow(rows.allow);
  const sec = timeoutSec(rows.minutes);
  // A part with a problem stays unsaved. The other parts save with the stored value of that part.
  const { state, saver } = useSaver(
    (): RepoTaskSettingsInput | null => {
      const cur = qc.getQueryData<RepoTaskSettingsDto>(key) ?? s;
      const r = latest.current;
      const {
        project: _p,
        repo: _r,
        warnedAt: _w,
        shellWarnedAt: _s,
        allow: stored,
        shellMode,
        bashTimeoutSec,
        taskCache,
        runChecks,
        ...rest
      } = cur;
      const next = {
        commands: draftsToCommands(r.commands) ?? cur.commands,
        shellMode: r.mode,
        allow: draftsToAllow(r.allow) ?? stored.map(({ pattern, reason }) => ({ pattern, reason })),
        bashTimeoutSec: timeoutSec(r.minutes) ?? bashTimeoutSec,
        taskCache: r.cache,
        runChecks: r.checks,
      };
      const was = {
        commands: cur.commands,
        shellMode,
        allow: stored.map(({ pattern, reason }) => ({ pattern, reason })),
        bashTimeoutSec,
        taskCache,
        runChecks,
      };
      if (JSON.stringify(next) === JSON.stringify(was)) return null;
      return { ...rest, ...next, ...(warned.current && { shellWarning: true as const }) };
    },
    async (input: RepoTaskSettingsInput) => {
      const dto = await read<RepoTaskSettingsDto>(
        await api.api.repos[":project"][":repo"]["task-settings"].$put({ param: { project: s.project, repo: s.repo }, json: input }),
      );
      qc.setQueryData(key, dto);
      // The Task view header shows the mode and the number of patterns.
      qc.invalidateQueries({ queryKey: ["task"] });
    },
  );
  const change = (patch: Partial<Rows>, typing: boolean) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setRows(next);
    saver.request(typing ? TYPING_MS : 0);
  };
  const id = `task-cmd-${s.project}-${s.repo}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const accept = (then: () => void) => () => {
    warned.current = true;
    then();
  };
  return (
    <div className="grid gap-4 px-3 pb-3">
      <SaveStatus
        id={`${id}-status`}
        state={state}
        problem={
          !commands
            ? "A marked command is not saved. Fix it to save the list."
            : !allow
              ? "A marked pattern is not saved. Fix it to save the list."
              : sec === null
                ? `"Longest command" is not saved. ${TIMEOUT_PROBLEM}`
                : null
        }
        saved="Saved. The next step uses these commands."
        onRetry={() => saver.request(0)}
      />
      <FieldSet className="gap-1.5">
        <FieldLegend variant="label" className="mb-0 font-semibold">
          Commands that the app runs
        </FieldLegend>
        <CommandsEditor
          idPrefix={id}
          drafts={rows.commands}
          newPrefix="cmd"
          onChange={(next, typing) => change({ commands: next }, typing)}
          onBlur={() => void saver.flush()}
        />
        <Field orientation="horizontal" data-task-cache className="mt-1">
          <Switch
            id={`${id}-cache`}
            aria-describedby={`${id}-cache-help`}
            checked={rows.cache}
            onCheckedChange={(cache) => change({ cache }, false)}
          />
          <FieldContent>
            <FieldLabel htmlFor={`${id}-cache`}>Shared task folder</FieldLabel>
            <FieldDescription id={`${id}-cache-help`}>
              Off by default. When on, each command gets the variable{" "}
              <code translate="no" className="[overflow-wrap:anywhere]">
                {TASK_CACHE_ENV}
              </code>
              . It names one folder per task, shared by all its parts and worktrees. A setup script can keep its downloads there, so the
              next part does not download them again. The folder stays in the app data folder after the task closes.
              {s.isolateHome && (
                <span className="mt-1 flex items-start gap-1.5 font-medium text-warn">
                  <TriangleAlert aria-hidden className="mt-0.5 size-[13px] shrink-0" />
                  Each command gets an empty home folder, so caches in the home folder do not survive. Point the tool caches to this folder
                  instead.
                </span>
              )}
            </FieldDescription>
          </FieldContent>
        </Field>
      </FieldSet>
      <FieldSet data-shell-settings className="gap-2">
        <FieldLegend variant="label" className="mb-0 font-semibold">
          Commands {names.runner} may run
        </FieldLegend>
        <FieldDescription className="m-0">
          The tests, code, fix, and Tell {names.runner} steps can run these commands themselves, such as a remote build. They run as you,
          with your files, keys, and network.
        </FieldDescription>
        <div className="grid gap-1">
          <ToggleGroup
            aria-label="Mode"
            aria-describedby={`${id}-mode-line ${id}-mode-help`}
            variant="outline"
            size="sm"
            spacing={0}
            className="flex-wrap"
            value={[rows.mode]}
            onValueChange={(v) => {
              const mode = v[0] as ShellMode | undefined;
              if (!mode || mode === rows.mode) return;
              if (mode === "allowlist") return change({ mode }, false);
              setAsk({ kind: mode, run: accept(() => change({ mode }, false)) });
            }}
          >
            {SHELL_MODES.map((m) => (
              <ToggleGroupItem
                key={m}
                value={m}
                className="aria-pressed:bg-foreground aria-pressed:font-semibold aria-pressed:text-background"
              >
                {m !== "allowlist" && <TriangleAlert aria-hidden data-icon="inline-start" />}
                {MODE_TEXT[m]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p
            id={`${id}-mode-line`}
            aria-live="polite"
            className={cn("m-0 text-xs", rows.mode === "allowlist" ? "text-muted-foreground" : "font-medium text-warn")}
          >
            {modeLine(rows.mode, names)}
          </p>
          <p id={`${id}-mode-help`} className="m-0 text-xs text-muted-foreground">
            Applies to the next step. A running step keeps its mode.
          </p>
        </div>
        <Field orientation="horizontal" data-run-checks>
          <Switch
            id={`${id}-checks`}
            aria-describedby={`${id}-checks-help`}
            checked={rows.checks}
            onCheckedChange={(checks) =>
              !checks || warned.current
                ? change({ checks }, false)
                : setAsk({ kind: "warning", run: accept(() => change({ checks: true }, false)) })
            }
          />
          <FieldContent>
            <FieldLabel htmlFor={`${id}-checks`}>{names.runner} may run the approved checks</FieldLabel>
            <FieldDescription id={`${id}-checks-help`}>
              Off by default. When on, the tests, code, fix, and Tell {names.runner} steps can run the build, test, and lint commands above,
              also with no pattern in this list. A command with a character other than letters, digits, and _ . / : = @ % + , - gets no
              rule, and so does a command that the deny list refuses. The step notes in the Log tab name each one.
            </FieldDescription>
          </FieldContent>
        </Field>
        <AllowEditor
          idPrefix={`${id}-allow`}
          drafts={rows.allow}
          newPrefix="a"
          onChange={(next, typing) => change({ allow: next }, typing)}
          onBlur={() => void saver.flush()}
          onAdd={(add) => (warned.current ? add() : setAsk({ kind: "warning", run: accept(add) }))}
        />
        <div className="grid gap-1">
          <label htmlFor={`${id}-timeout`} className="text-sm font-medium">
            Longest command
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-timeout`}
              type="number"
              inputMode="decimal"
              min={1}
              max={60}
              step="any"
              className="h-[30px] w-24"
              aria-invalid={sec === null ? true : undefined}
              aria-describedby={`${id}-timeout-help`}
              value={rows.minutes}
              onChange={(e) => change({ minutes: e.target.value }, true)}
              onBlur={() => void saver.flush()}
            />
            <span className="text-sm text-ink-2">minutes</span>
          </div>
          <p id={`${id}-timeout-help`} className="m-0 text-xs text-muted-foreground">
            {names.cli} stops a command that runs longer. 10 minutes by default, 60 at most.
          </p>
        </div>
      </FieldSet>
      <ShellDialog ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}
