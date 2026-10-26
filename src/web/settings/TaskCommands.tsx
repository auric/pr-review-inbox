// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Settings > Tasks, "Commands": the approved commands of each task repository (docs/plans/review-v2/spec.md section 6.3,
// repo_task_settings.commands_json), with the editor of the plan screen. Each change saves by itself (autosave.tsx). The first-use
// warning stays on the plan screen: a saved list here does not accept it.
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { RepoTaskSettingsDto, RepoTaskSettingsInput } from "../../shared/dto";
import { api } from "../api";
import { read } from "../shell/data";
import { CommandsEditor } from "../tasks/CommandsEditor";
import { type CommandDraft, draftsToCommands, toDraft } from "../tasks/commands";
import { useRepoTaskSettings, useTasks } from "../tasks/data";
import { SaveStatus, TYPING_MS, useSaver } from "./autosave";

export function TaskCommands() {
  const tasks = useTasks();
  const repos = [...new Map((tasks.data ?? []).map((t) => [`${t.project}/${t.repo}`, { project: t.project, repo: t.repo }])).values()].sort(
    (a, b) => `${a.project}/${a.repo}`.localeCompare(`${b.project}/${b.repo}`),
  );
  return (
    <div className="grid gap-1.5">
      <h3 id="task-commands-title" className="m-0 text-sm font-semibold">
        Commands
      </h3>
      <p className="m-0 text-sm text-ink-2">
        The app runs the approved commands of a repository after each step of a task. The plan screen adds the commands that you approve.
      </p>
      {tasks.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : tasks.error ? (
        <p className="m-0 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
          Cannot read the tasks. {tasks.error.message}
        </p>
      ) : repos.length ? (
        <ul aria-labelledby="task-commands-title" className="m-0 grid list-none rounded-md border p-0">
          {repos.map((r) => (
            <RepoCommands key={`${r.project}/${r.repo}`} project={r.project} repo={r.repo} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">No repository yet. A repository shows here after you start a task in it.</p>
      )}
    </div>
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

function Editor({ s }: { s: RepoTaskSettingsDto }) {
  const qc = useQueryClient();
  const key = ["task-settings", s.project, s.repo];
  const [drafts, setDrafts] = useState<CommandDraft[]>(() => s.commands.map(toDraft));
  const latest = useRef(drafts);
  const saved = useRef(JSON.stringify(s.commands));
  const commands = draftsToCommands(drafts);
  const { state, saver } = useSaver(
    (): RepoTaskSettingsInput | null => {
      const list = draftsToCommands(latest.current);
      if (!list || JSON.stringify(list) === saved.current) return null;
      const { project: _p, repo: _r, warnedAt: _w, ...rest } = qc.getQueryData<RepoTaskSettingsDto>(key) ?? s;
      return { ...rest, commands: list };
    },
    async (input: RepoTaskSettingsInput) => {
      const dto = await read<RepoTaskSettingsDto>(
        await api.api.repos[":project"][":repo"]["task-settings"].$put({ param: { project: s.project, repo: s.repo }, json: input }),
      );
      saved.current = JSON.stringify(dto.commands);
      qc.setQueryData(key, dto);
    },
  );
  const id = `task-cmd-${s.project}-${s.repo}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return (
    <div className="grid gap-2 px-3 pb-3">
      <SaveStatus
        id={`${id}-status`}
        state={state}
        problem={commands ? null : "A marked command is not saved. Fix it to save the list."}
        saved="Saved. The next check uses these commands."
        onRetry={() => saver.request(0)}
      />
      <CommandsEditor
        idPrefix={id}
        drafts={drafts}
        newPrefix="cmd"
        onChange={(next, typing) => {
          latest.current = next;
          setDrafts(next);
          saver.request(typing ? TYPING_MS : 0);
        }}
        onBlur={() => void saver.flush()}
      />
    </div>
  );
}
