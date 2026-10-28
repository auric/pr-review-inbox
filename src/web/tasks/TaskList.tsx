// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Tasks view of the list pane (docs/plans/review-v2/spec.md section 6.12): "Build a task" with a key, a repository of the stored PRs,
// of the tasks, or of the forge list (the base branch starts at the last pick or the default branch, spec.md section 6.16.3), then one
// row per task with "<KEY> <title> · <repo>" and the status in the meta line.
import { CircleAlert, Menu, Plus } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { type ProfileDto, TASK_KEY, type TaskCreateInput, type TaskIssueDto, type TaskRowDto } from "../../shared/dto";
import { REPO_LIST_MAX, taskProfileId } from "../../shared/task";
import { useMinute } from "../shell/ListPane";
import { ago, type ProjectRepos } from "../shell/model";
import { askText, boxId, FilePicker, NoAttachments, usePolicy } from "./Attachments";
import { readIssue, useTaskProfile, useTaskRepos } from "./data";
import { fileChoices, firstPicks, repoChoices, rowStatus } from "./model";
import { RepoField } from "./RepoField";

const kbd = "border border-rule-strong bg-transparent font-mono text-[11px] text-ink-2";
const groupHead = "m-0 flex items-center gap-2 border-b bg-pane-2 px-4 pt-[9px] pb-1.5 text-xs font-semibold text-ink-2";

// The open tasks first, newest first. Done and failed tasks follow.
export function taskGroups(rows: TaskRowDto[]): { id: "open" | "done"; label: string; rows: TaskRowDto[] }[] {
  const open = rows.filter((r) => r.state !== "done" && r.state !== "failed");
  const done = rows.filter((r) => r.state === "done" || r.state === "failed");
  return [
    ...(open.length ? [{ id: "open" as const, label: "Open", rows: open }] : []),
    ...(done.length ? [{ id: "done" as const, label: "Done", rows: done }] : []),
  ];
}

export function TaskList(props: {
  rows: TaskRowDto[] | undefined;
  selected: number | null;
  focused: boolean;
  repos: ProjectRepos[];
  // The tracker name from meta, such as the name of the issue tracker.
  tracker: string;
  // The short name of the CLI from meta.
  runner: string;
  // The profiles from meta. The Build form picks the profile of the task from them.
  profiles: ProfileDto[];
  banner: ReactNode;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
  onCreate: (input: TaskCreateInput) => Promise<void>;
  onMenu: () => void;
  onFocus: () => void;
}) {
  const now = useMinute();
  const groups = taskGroups(props.rows ?? []);
  const count = props.rows?.filter((r) => r.state !== "done" && r.state !== "failed").length ?? 0;
  return (
    <section
      aria-labelledby="view-name"
      onFocus={props.onFocus}
      className={cn(
        "rl-pane rl-list grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)_auto] border-r bg-pane-2",
        props.focused && "pane-edge",
      )}
    >
      <header className="grid grid-cols-[minmax(0,1fr)] gap-2.5 border-b px-4 pt-3.5 pb-3">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            className="rl-m-only size-[30px] cursor-pointer items-center justify-center self-center rounded-md text-ink-2 hover:bg-hover"
            aria-label="Open views"
            onClick={props.onMenu}
          >
            <Menu aria-hidden className="size-[15px]" />
          </button>
          <h2 id="view-name" className="m-0 min-w-0 truncate text-[16px] font-bold tracking-[-0.01em]">
            Tasks
          </h2>
          <span className="text-sm text-muted-foreground">
            {props.rows ? count : ""}
            <span className="sr-only"> open tasks</span>
          </span>
        </div>
        <NewTask
          repos={props.repos}
          used={props.rows ?? []}
          tracker={props.tracker}
          runner={props.runner}
          profiles={props.profiles}
          onCreate={props.onCreate}
        />
      </header>
      <div>{props.banner}</div>
      <div className="relative overflow-auto overscroll-contain" id="rows" tabIndex={-1}>
        {!props.rows ? (
          <div role="status" aria-busy="true" aria-label="Loading tasks">
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid gap-2 border-b px-4 py-3">
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
            ))}
          </div>
        ) : groups.length ? (
          groups.map((g) => (
            <section key={g.id} aria-labelledby={`tg-${g.id}`}>
              <h3 id={`tg-${g.id}`} className={cn(groupHead, "sticky top-0 z-[1]")}>
                {g.label}
                <span className="font-medium text-muted-foreground">{g.rows.length}</span>
              </h3>
              <ul className="m-0 list-none p-0">
                {g.rows.map((r) => (
                  <Row key={r.id} r={r} now={now} selected={r.id === props.selected} onSelect={props.onSelect} onOpen={props.onOpen} />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className="m-0 px-4 py-8 text-ink-2">
            No task yet. Type a {props.tracker} key above, or use Build on a task chip of a pull request.
          </p>
        )}
      </div>
      <footer className="rl-wide-only flex flex-wrap gap-x-3 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Kbd className={kbd}>j</Kbd>
          <Kbd className={kbd}>k</Kbd> move
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd className={kbd}>Enter</Kbd> open
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd className={kbd}>?</Kbd> all keys
        </span>
      </footer>
    </section>
  );
}

// spec.md section 6.17: two steps. "Read the task" reads the summary and the attachments of the key (one tracker read on the click).
// Then the boxes pick the files that the runner gets, and "Build this task" creates the task. A new key goes back to the first step.
function NewTask(props: {
  repos: ProjectRepos[];
  // The tasks: their repositories are choices too, with or without a stored PR.
  used: TaskRowDto[];
  tracker: string;
  runner: string;
  profiles: ProfileDto[];
  onCreate: (input: TaskCreateInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const listed = useTaskRepos(open);
  const all = repoChoices(
    [...props.repos.flatMap((g) => g.repos.map((r) => ({ project: g.project, repo: r.repo }))), ...props.used],
    listed.data?.repos ?? [],
  );
  const [key, setKey] = useState("");
  const [repo, setRepo] = useState("");
  // The user's pick for the chosen repository. null: the preselection of the server.
  const [picked, setPicked] = useState<{ repo: string; profile: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<TaskIssueDto | null>(null);
  const [picks, setPicks] = useState<ReadonlySet<string>>(new Set());
  const policy = usePolicy(props.runner, props.tracker);
  const chosen = all.find((r) => r.key === (repo || all[0]?.key));
  const listNote = listed.isPending
    ? "Reading the other repositories…"
    : listed.error
      ? `Cannot list the other repositories. ${listed.error.message}`
      : listed.data?.complete === false
        ? `The list stops at ${REPO_LIST_MAX} repositories.`
        : null;
  // spec.md section 6.2: an Explain profile gives no code, so the picker leaves it out.
  const choices = props.profiles.filter((p) => !p.explain);
  const pre = useTaskProfile(open ? (chosen ?? null) : null).data?.profile;
  const profile = (picked?.repo === chosen?.key ? picked?.profile : null) ?? pre ?? taskProfileId(props.profiles, null);
  if (!open)
    return (
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setOpen(true)}>
        <Plus aria-hidden data-icon="inline-start" />
        Build a {props.tracker} task
      </Button>
    );
  const k = key.trim().toUpperCase();
  const read = issue?.key === k ? issue : null;
  const rows = read ? fileChoices(read.attachments, []) : [];
  const tick = (ids: string[], on: boolean) =>
    setPicks((p) => {
      const n = new Set(p);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  const close = () => {
    setOpen(false);
    setIssue(null);
    setError(null);
  };
  return (
    <form
      aria-label={`Build a ${props.tracker} task`}
      className="grid gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!TASK_KEY.test(k)) return setError(`Type a key such as ABC-12.`);
        if (!chosen) return setError("Pick a repository.");
        setBusy(true);
        setError(null);
        try {
          if (!read) {
            const i = await readIssue(k);
            setIssue(i);
            setPicks(new Set(firstPicks(fileChoices(i.attachments, []), policy.asking)));
            return;
          }
          await props.onCreate({
            project: chosen.project,
            repo: chosen.repo,
            key: k,
            files: rows.flatMap((r) => (picks.has(r.id) ? [r.id] : [])),
            profile,
          });
          setKey("");
          close();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-1 text-sm">
        <label htmlFor="new-task-key" className="text-ink-2">
          {props.tracker} key
        </label>
        <Input
          id="new-task-key"
          autoFocus
          required
          name="key"
          placeholder="ABC-12…"
          autoComplete="off"
          spellCheck={false}
          value={key}
          className="h-8"
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div className="grid gap-1 text-sm">
        <label htmlFor="new-task-repo" className="text-ink-2">
          Main repository
        </label>
        <RepoField id="new-task-repo" value={chosen?.key ?? ""} choices={all} note={listNote} onPick={setRepo} />
      </div>
      <div className="grid gap-1 text-sm">
        <label htmlFor="new-task-profile" className="text-ink-2">
          Profile
        </label>
        <select
          id="new-task-profile"
          name="profile"
          aria-describedby="new-task-profile-help"
          className="h-8 rounded-md border border-input bg-pane px-2 text-sm"
          value={profile}
          onChange={(e) => chosen && setPicked({ repo: chosen.key, profile: e.target.value })}
        >
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p id="new-task-profile-help" className="m-0 text-xs text-muted-foreground">
          Every step uses its model, skills, and MCP tools.
        </p>
      </div>
      <p aria-live="polite" className="sr-only">
        {read ? `${read.key}: ${rows.length === 1 ? "1 attachment" : `${rows.length} attachments`}.` : ""}
      </p>
      {read && (
        <div className="grid gap-2">
          <p className="m-0 text-sm">
            <span className="text-ink-2">Task: </span>
            <span className="font-medium [overflow-wrap:anywhere]">{read.summary}</span>
          </p>
          {rows.length ? (
            <FilePicker
              id="new-task-file"
              rows={rows}
              checked={picks}
              disabled={busy}
              note={`${props.runner} reads the ticked files in each step. The task screen can change them later.`}
              onToggle={(r, on) =>
                on ? policy.ask(askText(props.runner, [r], boxId("new-task-file", r)), () => tick([r.id], true)) : tick([r.id], false)
              }
              onAll={() => {
                const todo = rows.filter((r) => r.why === null && !picks.has(r.id));
                // "Include all" goes away when every box is ticked, so the focus goes to the first new box.
                const first = boxId("new-task-file", todo[0] ?? { id: "" });
                policy.ask(askText(props.runner, todo, first), () => {
                  tick(
                    todo.map((r) => r.id),
                    true,
                  );
                  requestAnimationFrame(() => document.getElementById(first)?.focus());
                });
              }}
            />
          ) : (
            <NoAttachments runner={props.runner} />
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !chosen}>
          {read ? (busy ? "Starting…" : "Build this task") : busy ? "Reading…" : "Read the task"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={close}>
          Cancel
        </Button>
      </div>
      {policy.dialog}
    </form>
  );
}

const Row = memo(function Row(props: {
  r: TaskRowDto;
  now: number;
  selected: boolean;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
}) {
  const { r } = props;
  const s = rowStatus(r);
  return (
    <li>
      <button
        type="button"
        id={`row-${r.id}`}
        data-row
        aria-current={props.selected ? "true" : undefined}
        className={cn(
          "grid w-full cursor-pointer gap-[3px] border-0 border-b bg-transparent px-4 py-(--row-y) text-left hover:bg-hover focus-visible:outline-offset-[-2px]",
          props.selected && "bg-sel hover:bg-sel",
        )}
        onClick={() => props.onSelect(r.id)}
        onDoubleClick={() => props.onOpen(r.id)}
      >
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span translate="no" className="shrink-0 font-mono text-ink-2">
            {r.key}
          </span>
          <span translate="no" className="min-w-0 truncate font-mono">
            {r.project}/{r.repo}
          </span>
          <time dateTime={new Date(r.updatedAt).toISOString()} className="ml-auto shrink-0 whitespace-nowrap">
            {ago(r.updatedAt, props.now)}
          </time>
        </span>
        <span title={r.title} className="min-w-0 truncate font-semibold">
          {r.title}
        </span>
        <span className={cn("flex min-w-0 items-center gap-1.5 text-sm text-ink-2", s.needsYou && "font-semibold text-turn")}>
          {s.needsYou && <CircleAlert aria-hidden className="size-[15px] shrink-0" />}
          <span className="truncate">{s.text}</span>
        </span>
      </button>
    </li>
  );
});
