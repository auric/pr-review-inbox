// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// "Move in <tracker>…" of a task with sub-tasks (docs/plans/review-v2/spec.md sections 6.20.9 and 6.20.13). The dialog reads the
// moves that the tracker offers for the key now and lists them as radio buttons, such as "Start review → In Review". Only its primary
// button sends the one tracker write. The tracker name comes from meta.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { dialogKeys } from "../fix/CloneDialog";
import { moveIssue, readTransitions, type TrackerId } from "./data";

export function JiraMoveDialog(props: {
  task: number;
  source: TrackerId;
  tracker: string;
  // The issue key and its status from the newest read.
  issue: { key: string; status: string | null } | null;
  onClose: () => void;
}) {
  const { issue } = props;
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["task", props.task, "transitions", issue?.key],
    enabled: issue !== null,
    staleTime: 0,
    gcTime: 0,
    queryFn: () => readTransitions(props.task, props.source, issue?.key ?? ""),
  });
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = (open: boolean) => {
    if (open) return;
    setPick(null);
    setError(null);
    props.onClose();
  };
  const moves = list.data?.transitions ?? [];
  return (
    <Dialog open={issue !== null} onOpenChange={close}>
      <DialogContent className="sm:max-w-[460px]" onKeyDown={dialogKeys(() => close(false))}>
        <DialogHeader>
          <DialogTitle>
            Move <span translate="no">{issue?.key}</span> in {props.tracker}?
          </DialogTitle>
          <DialogDescription>
            {props.tracker} says {issue?.status ?? "an unknown status"} now. The app changes the status only when you click Move.
          </DialogDescription>
        </DialogHeader>
        <form
          id="tracker-move"
          className="grid gap-2 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!issue || !pick) return setError("Pick a move first.");
            setBusy(true);
            setError(null);
            try {
              await moveIssue(qc, props.task, props.source, issue.key, pick);
              close(false);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <FieldSet className="gap-1">
            <FieldLegend className="text-sm font-medium">Moves that {props.tracker} offers</FieldLegend>
            {list.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : list.error ? (
              <p role="alert" className="m-0 text-destructive">
                {list.error.message}
              </p>
            ) : moves.length === 0 ? (
              <p className="m-0 text-ink-2">{props.tracker} offers no move for this issue now.</p>
            ) : (
              moves.map((m) => (
                <label
                  key={m.id}
                  className="-mx-1.5 flex min-h-6 cursor-pointer items-center gap-2 rounded-[5px] px-1.5 py-1 hover:bg-hover"
                >
                  <input
                    type="radio"
                    name="tracker-move"
                    value={m.id}
                    checked={pick === m.id}
                    className="m-0 size-4 accent-foreground"
                    onChange={() => setPick(m.id)}
                  />
                  <span>
                    {m.name}
                    {m.to && m.to !== m.name ? ` → ${m.to}` : ""}
                  </span>
                </label>
              ))
            )}
          </FieldSet>
          {error && (
            <p role="alert" className="m-0 text-destructive">
              {error}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="submit" form="tracker-move" disabled={busy || !pick}>
            {busy ? "Moving…" : `Move in ${props.tracker}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
