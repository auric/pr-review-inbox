// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The checklist of the steps outside the runner (docs/plans/task-builder-v2.md sections 5.2 and 11.4): one row per step with its owner
// and state, and Done, Waive, or Reopen. The user also ticks a step of the app, because no row links to the click of its app action yet.
// runner: the short runner name of the app meta.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskDto, TaskExternalDto } from "../../shared/dto";
import { postExternal } from "./data";

type Action = "done" | "waive" | "reopen";
const OWNER: Record<TaskExternalDto["owner"], string> = { user: "You", app: "App" };
const STATE: Record<Exclude<TaskExternalDto["state"], "open">, string> = { done: "Done", waived: "Waived" };

// A line of the facts that the plan gives: the part, the moved plan task, and the host.
const factsOf = (x: TaskExternalDto) =>
  [x.part === null ? null : `After part ${x.part}`, x.planTask && `Moved from ${x.planTask}`, x.host && `Host ${x.host}`]
    .filter(Boolean)
    .join(" · ");

export function Checklist({ t, runner }: { t: TaskDto; runner: string }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (v: { item: number; action: Action }) => postExternal(qc, t, v.item, v.action),
    onError: () => qc.invalidateQueries({ queryKey: ["task", t.id] }),
  });
  if (!t.external.length) return null;
  const open = t.external.filter((x) => x.state === "open").length;
  const locked = act.isPending || t.state === "done" || t.state === "failed";
  return (
    <section aria-labelledby="task-checklist" className="grid gap-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 id="task-checklist" className="m-0 text-sm font-semibold">
          Outside {runner}
        </h3>
        <span className="text-xs text-muted-foreground">
          {open ? `${open} open. The task ends when each step is done or waived.` : "Each step is done or waived."}
        </span>
      </div>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {t.external.map((x) => {
          const facts = factsOf(x);
          return (
            <li key={x.id} className="flex flex-wrap items-start gap-2 rounded-md border px-2.5 py-2">
              <Badge variant={x.owner === "user" ? "soft" : "quiet"}>{OWNER[x.owner]}</Badge>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className={cn("text-sm", x.state !== "open" && "text-muted-foreground line-through")}>{x.title}</span>
                {x.why && <span className="text-xs text-muted-foreground">{x.why}</span>}
                {facts && <span className="text-xs text-muted-foreground">{facts}</span>}
              </div>
              <div className="flex items-center gap-1">
                {x.state === "open" ? (
                  <>
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={locked}
                      aria-label={`Mark "${x.title}" done`}
                      onClick={() => act.mutate({ item: x.id, action: "done" })}
                    >
                      Done
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={locked}
                      aria-label={`Waive "${x.title}"`}
                      onClick={() => act.mutate({ item: x.id, action: "waive" })}
                    >
                      Waive
                    </Button>
                  </>
                ) : (
                  <>
                    <Badge variant="quiet">{STATE[x.state]}</Badge>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={locked}
                      aria-label={`Reopen "${x.title}"`}
                      onClick={() => act.mutate({ item: x.id, action: "reopen" })}
                    >
                      Reopen
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {act.error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {act.error.message}
        </p>
      )}
    </section>
  );
}
