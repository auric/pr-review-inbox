// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The sub-task list of the Task view (docs/plans/review-v2/spec.md section 6.20.13): one row per sub-task with one sentence, the person
// who acts, and the tracker status. A click on a row moves the focus, so the status and the primary button follow that part. Each row
// has at most one secondary action and the More item "Move in <tracker>…". model.ts subtaskRows decides the words.
// ConfirmDialog is the one confirm of a part action that changes the code host, such as "Move <key> to <base>".
import { Ellipsis } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { dialogKeys } from "../fix/CloneDialog";
import type { Action, SubRow } from "./model";

export function SubtaskList(props: {
  rows: SubRow[];
  focused: number | null;
  // The primary action of the shown part. The focused row leaves out the same action, so it shows once.
  primary: Action["kind"] | null;
  tracker: string;
  busy: boolean;
  // The parent row: its key, its status, and the hint when every part merged.
  parent: { key: string; status: string | null; hint: string | null };
  onFocus: (part: number) => void;
  onAction: (row: SubRow, a: Action) => void;
  onMove: (issue: { key: string; status: string | null }) => void;
}) {
  const { tracker } = props;
  return (
    <section aria-labelledby="subtask-list" className="grid gap-2">
      <h3 id="subtask-list" className="m-0 text-sm font-semibold">
        Sub-tasks
      </h3>
      <ul className="m-0 grid list-none gap-2 p-0">
        {props.rows.map((r) => {
          const focused = r.part !== null && r.part.id === props.focused;
          const move = { key: r.part?.keys[0] ?? r.key, status: r.status };
          return (
            <li
              key={r.id}
              data-subtask={r.key}
              className={cn("grid gap-1 rounded-md border bg-card px-3 py-2.5", focused && "border-foreground/60 bg-sel")}
            >
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                {r.part ? (
                  <button
                    type="button"
                    data-task-item
                    aria-pressed={focused}
                    aria-label={`${r.label}: ${r.summary}. ${focused ? "Shown above." : "Show this sub-task above."}`}
                    className="cursor-pointer rounded-[4px] text-left text-sm font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => r.part && props.onFocus(r.part.id)}
                  >
                    <span translate="no" className="font-mono">
                      {r.key}
                    </span>
                    {r.label.slice(r.key.length)} <span className="[overflow-wrap:anywhere]">{r.summary}</span>
                  </button>
                ) : (
                  <span className="text-sm font-semibold">
                    <span translate="no" className="font-mono">
                      {r.key}
                    </span>
                    {r.label.slice(r.key.length)} <span className="[overflow-wrap:anywhere]">{r.summary}</span>
                  </span>
                )}
                {focused && <Badge variant="soft">Shown above</Badge>}
              </div>
              <p className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
                <span>{r.text}</span>
                <span className="text-ink-2">Who acts: {r.actor}</span>
                <span className="text-ink-2">
                  {tracker}: {r.status ?? "not known"}
                </span>
              </p>
              {r.hint && <p className="m-0 text-xs text-ink-2">{r.hint}</p>}
              <div className="flex flex-wrap items-center gap-2">
                {r.action && !(focused && r.action.kind === props.primary) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={props.busy}
                    aria-label={`${r.action.label}: ${r.key}`}
                    onClick={() => r.action && props.onAction(r, r.action)}
                  >
                    {r.action.label}
                  </Button>
                )}
                <RowMore label={`More for ${r.key}`} item={`Move in ${tracker}…`} onMove={() => props.onMove(move)} />
              </div>
            </li>
          );
        })}
        <li data-subtask={props.parent.key} className="grid gap-1 rounded-md border border-dashed bg-card px-3 py-2.5">
          <p className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
            <span className="font-semibold">
              Parent{" "}
              <span translate="no" className="font-mono">
                {props.parent.key}
              </span>
            </span>
            <span className="text-ink-2">
              {tracker}: {props.parent.status ?? "not known"}
            </span>
          </p>
          {props.parent.hint && <p className="m-0 text-sm">{props.parent.hint}</p>}
          <div>
            <RowMore
              label={`More for ${props.parent.key}`}
              item={`Move in ${tracker}…`}
              onMove={() => props.onMove({ key: props.parent.key, status: props.parent.status })}
            />
          </div>
        </li>
      </ul>
    </section>
  );
}

function RowMore(props: { label: string; item: string; onMove: () => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label={props.label} />}>
        More
        <Ellipsis aria-hidden data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={props.onMove}>{props.item}</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One confirm before a part action that changes the code host. confirm: the label of its primary button.
export type Confirm = { title: string; text: string; confirm: string; run: () => void };

export function ConfirmDialog(props: { confirm: Confirm | null; busy: boolean; onClose: () => void }) {
  const c = props.confirm;
  return (
    <Dialog open={c !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="sm:max-w-[460px]" onKeyDown={dialogKeys(props.onClose)}>
        <DialogHeader>
          <DialogTitle>{c?.title}</DialogTitle>
          <DialogDescription>{c?.text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={props.busy}
            onClick={() => {
              c?.run();
              props.onClose();
            }}
          >
            {c?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
