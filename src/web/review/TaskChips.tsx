// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task chips (plan r2 task context UI, plan r3 Feature C): the task IDs of the PR with Fetch, Fetch again, and Clear text.
// Every run kind reads the fetched task text. So the brief, the run buttons, and Ask in the panel slot show the chips.
// All places share one query, so a fetch in one place shows in all.
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle, Settings2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { MetaDto, PrTask, TaskContextDto } from "../../shared/dto";
import { api } from "../api";
import { dialogKeys } from "../fix/CloneDialog";
import { webLink } from "../pr/Header";
import { ApiError, read } from "../shell/data";
import { Hint } from "../shell/Hint";
import { taskHint } from "../shell/model";
import { fetchedText, mergeTask, offerSetup, removeText, taskChips, trackerOf } from "./tasks";
import { focusFirst, useFocusAfter } from "./useFocusAfter";

const icon = "size-[15px] shrink-0";
const SOURCE: Record<PrTask["source"], string> = { branch: "branch", title: "title", description: "description" };

export const taskKey = (pr: number) => ["pr", pr, "task-context"] as const;
export const keyParam = (pr: number, key: string) => ({ param: { id: String(pr), key } });

// GET reads the local database. live.ts refetches it when SSE `changed` names the PR.
// The server shares one param validator with the :key routes, so the client type asks for a key. This path has no key.
export const useTaskContext = (pr: number) =>
  useQuery({
    queryKey: taskKey(pr),
    queryFn: async () => read<TaskContextDto[]>(await api.api.prs[":id"]["task-context"].$get(keyParam(pr, ""))),
  });

// The chips of the PR tasks and the fetched rows. Without a tracker, no row shows.
export function useTaskChips(pr: number, tasks: PrTask[], meta: MetaDto) {
  const tracker = trackerOf(meta);
  const data = useTaskContext(pr).data;
  const on = tracker?.configured === true;
  return { tracker, on, source: tracker?.name ?? "", chips: taskChips(tasks, (tracker && data) || [], on) };
}

// The only request of the chips that reaches the tracker, through the server.
async function fetchTask(qc: QueryClient, pr: number, key: string) {
  const dto = await read<TaskContextDto>(await api.api.prs[":id"]["task-context"][":key"].$post(keyParam(pr, key)));
  qc.setQueryData<TaskContextDto[]>(taskKey(pr), (old) => mergeTask(old, dto));
}

async function removeTask(qc: QueryClient, pr: number, key: string) {
  const res = await api.api.prs[":id"]["task-context"][":key"].$delete(keyParam(pr, key));
  if (!res.ok) await read(res);
  qc.setQueryData<TaskContextDto[]>(taskKey(pr), (old) => old?.filter((t) => t.key !== key));
}

// setup: the server has no tracker source (409), so the error offers the settings.
type TaskError = { key: string; message: string; setup: boolean };

// WCAG 2.5.3: the names of the fetch and clear buttons start with their visible words.
const fetchBtn =
  "inline-flex cursor-pointer items-center gap-1 border-l px-2 text-xs font-medium text-pen last:rounded-r-[4px] hover:bg-hover hover:underline aria-busy:cursor-progress";
const clearBtn =
  "inline-flex cursor-pointer items-center border-l px-2 text-xs text-ink-2 last:rounded-r-[4px] hover:bg-hover hover:text-foreground aria-busy:cursor-progress";

// id: the prefix of the element IDs, one per place. focusTo: the element that takes the focus when Clear text takes the chip away.
// compact: a place outside the brief. It shows only the chips that can fetch or hold fetched text, with the fetch state
// instead of the source. It shows nothing when no chip is left. onSettings: opens Settings with the focus on the tracker URL field.
// onSettings absent: an error offers no settings link.
// onTaskIds: "Set up task IDs" opens Settings, Task IDs.
export function TaskChips(props: {
  pr: number;
  tasks: PrTask[];
  meta: MetaDto;
  id: string;
  focusTo: string;
  compact?: boolean;
  announce: (text: string) => void;
  onSettings?: () => void;
  onTaskIds?: () => void;
}) {
  const { pr, tasks, meta, id, compact, announce, onSettings } = props;
  const qc = useQueryClient();
  const { tracker, on, source, chips: all } = useTaskChips(pr, tasks, meta);
  const chips = compact ? all.filter((c) => c.fetchable || c.fetched) : all;
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<TaskError[]>([]);
  // The task that the Clear text confirm asks about. The last one stays while the dialog plays its close transition.
  const [asking, setAsking] = useState<{ key: string; files: number } | null>(null);
  const last = useRef(asking);
  if (asking) last.current = asking;
  const shown = last.current;
  const now = Date.now();
  const focus = useFocusAfter(chips);

  // The Clear text button while the request runs, then the Fetch button, then focusTo when the chip is gone.
  const targets = (key: string) => [`${id}-remove-${key}`, `${id}-fetch-${key}`, props.focusTo];
  const run = async (key: string, act: "fetch" | "remove") => {
    if (busy.has(key)) return;
    setBusy((b) => new Set(b).add(key));
    setErrors((es) => es.filter((e) => e.key !== key));
    try {
      if (act === "fetch") await fetchTask(qc, pr, key);
      else await removeTask(qc, pr, key);
      announce(act === "fetch" ? `Fetched ${key} from ${source}.` : `Cleared the ${key} text.`);
      // Clear text takes its own button away, and the chip too when the PR no longer names the task.
      if (act === "remove") focus(targets(key), (cs) => !cs.some((c) => c.key === key && c.fetched));
    } catch (e) {
      const message = (e as Error).message;
      const setup = !!onSettings && e instanceof ApiError && e.status === 409;
      setErrors((es) => [...es.filter((x) => x.key !== key), { key, message, setup }]);
      announce(`${key}: ${message}`);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    }
  };

  if (!chips.length) {
    if (compact) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        <span className="mr-1.5 font-semibold">Task</span>
        <span className="text-ink-2">No task ID found.</span>
        <button
          type="button"
          className="rl-hit cursor-pointer rounded text-sm font-medium text-pen hover:underline"
          onClick={props.onTaskIds}
        >
          Set up task IDs
        </button>
      </div>
    );
  }
  const chip = "inline-flex items-baseline gap-1.5 px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground";
  return (
    <div data-task-chips={id} className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        <span className="mr-1.5 font-semibold">Task</span>
        {chips.map((t) => {
          const url = webLink(t.url);
          const state = compact
            ? t.fetched
              ? fetchedText(t.fetched, now)
              : "not fetched"
            : t.source
              ? `from ${SOURCE[t.source]}`
              : "no longer in this pull request";
          const body = (
            <>
              <code translate="no" className={cn("font-mono text-xs", url ? "text-pen" : "text-ink-2")}>
                {t.key}
              </code>{" "}
              {/* Flex ignores the space. It keeps the key and the state apart in the text and in the accessible name. */}
              <span>· {state}</span>
            </>
          );
          const wait = busy.has(t.key);
          return (
            <span key={t.key} className="inline-flex items-stretch rounded-[5px] border has-[a:hover]:border-rule-strong">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${t.key} in a new tab`}
                  className={cn(chip, "rounded-[4px] [&:hover>code]:underline")}
                >
                  {body}
                  <span className="sr-only">, opens a new tab</span>
                </a>
              ) : (
                <span
                  className={chip}
                  title={t.source ? taskHint({ key: t.key, source: t.source }) : "The pull request no longer names this task."}
                >
                  {body}
                </span>
              )}
              {t.fetchable && (
                <Hint label={t.fetched ? `Fetch ${t.key} again` : `Fetch ${t.key} from ${source}`}>
                  <button
                    id={`${id}-fetch-${t.key}`}
                    type="button"
                    className={fetchBtn}
                    aria-label={t.fetched ? `Fetch ${t.key} again` : `Fetch ${t.key} from ${source}`}
                    aria-busy={wait || undefined}
                    onClick={() => void run(t.key, "fetch")}
                  >
                    {wait && <LoaderCircle aria-hidden className={cn(icon, "animate-spin")} />}
                    Fetch
                  </button>
                </Hint>
              )}
              {t.fetched && (
                <Hint label={`Clear text of ${t.key}`}>
                  <button
                    id={`${id}-remove-${t.key}`}
                    type="button"
                    className={clearBtn}
                    aria-label={`Clear text of ${t.key}`}
                    aria-haspopup="dialog"
                    aria-busy={wait || undefined}
                    onClick={() => !wait && setAsking({ key: t.key, files: t.fetched?.files.length ?? 0 })}
                  >
                    Clear text
                  </button>
                </Hint>
              )}
            </span>
          );
        })}
        {!compact && tracker && offerSetup(tasks, on) && (
          <button
            type="button"
            className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-xs text-ink-2 hover:bg-hover hover:text-foreground"
            onClick={onSettings}
          >
            <Settings2 aria-hidden className={icon} />
            Set up {source}
          </button>
        )}
      </div>
      {errors.map((e) => (
        <p key={e.key} className="m-0 flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert aria-hidden className={icon} />
          <span>
            <code translate="no" className="font-mono">
              {e.key}
            </code>
            : {e.message}
            {e.setup && (
              <>
                {" "}
                <button type="button" className="cursor-pointer rounded font-medium text-pen hover:underline" onClick={onSettings}>
                  Set up {source}
                </button>
              </>
            )}
          </span>
        </p>
      ))}
      <Dialog
        open={asking !== null}
        onOpenChange={(on) => !on && setAsking(null)}
        onOpenChangeComplete={(on) => !on && shown && focusFirst(targets(shown.key))}
      >
        <DialogContent className="sm:max-w-[440px]" finalFocus={false} onKeyDown={dialogKeys(() => setAsking(null))}>
          {shown && (
            <>
              <DialogHeader>
                <DialogTitle>Clear the {shown.key} text?</DialogTitle>
                <DialogDescription>{removeText(shown.key, shown.files)}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAsking(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setAsking(null);
                    void run(shown.key, "remove");
                  }}
                >
                  Clear text
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
