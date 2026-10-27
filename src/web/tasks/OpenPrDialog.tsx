// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The open-PR confirm (docs/plans/review-v2/spec.md section 6.12): one outward dialog with the branch, the target, the title, the
// reviewers as editable chips, and the file and line counts. "Push and open PR" is the only way to push: nothing pushes before it.
// OpenPrsDialog is the same confirm for a part that changes several repositories (spec.md section 6.16.8): one row per repository, the
// submodules first, each with its reviewers and its state. It stays open while the server pushes and opens the PRs, and each failed row
// gets its own "Try again".
import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TaskDto, TaskPartDto, TaskPrDto } from "../../shared/dto";
import { MAX_TASK_REVIEWERS } from "../../shared/dto";
import { dialogKeys } from "../fix/CloneDialog";
import { useTaskDiff } from "./data";
import { prName, prRowLook, type RowLook, rowSize } from "./model";

export function OpenPrDialog(props: {
  t: TaskDto;
  part: TaskPartDto;
  open: boolean;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reviewers: string[]) => void;
}) {
  const { t, part } = props;
  const [reviewers, setReviewers] = useState<string[]>(t.reviewers);
  const diff = useTaskDiff(t.id, part.id, part.head, props.open);
  const files = diff.data?.files.length;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" onKeyDown={dialogKeys(() => props.onOpenChange(false))}>
        <DialogHeader>
          <DialogTitle>
            Push <span translate="no">{part.branch}</span> and open a PR into <span translate="no">{t.targetBranch}</span>?
          </DialogTitle>
          <DialogDescription>The app pushes only this branch, and only now. It never pushes to {t.targetBranch}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="m-0">
            <span className="text-ink-2">Title:</span> {t.key}: {t.title}
          </p>
          <p className="m-0 text-ink-2">
            {files === undefined ? "" : `${files} ${files === 1 ? "file" : "files"}, `}
            {part.lines === null ? "the line count is not known yet" : `${part.lines} changed lines`}
          </p>
          <div className="grid gap-1.5">
            <span id="pr-reviewers" className="text-ink-2">
              Reviewers
            </span>
            <ReviewerChips
              labelledBy="pr-reviewers"
              reviewers={reviewers}
              addLabel="Add a reviewer by user name"
              empty="No reviewer. Add a user name, or open the PR without one."
              onChange={setReviewers}
            />
          </div>
          {props.error && (
            <p role="alert" className="m-0 text-destructive">
              {props.error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={props.busy} onClick={() => props.onConfirm(reviewers)}>
            {props.busy ? "Pushing…" : props.error ? "Try again" : "Push and open PR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The reviewer chips of one PR. Without onChange the chips are read only, as for a row whose PR is open.
function ReviewerChips(props: {
  labelledBy: string;
  reviewers: string[];
  addLabel: string;
  empty: string;
  onChange?: (reviewers: string[]) => void;
}) {
  const { reviewers, onChange } = props;
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (n && !reviewers.includes(n) && reviewers.length < MAX_TASK_REVIEWERS) onChange?.([...reviewers, n]);
    setName("");
  };
  return (
    <>
      <ul aria-labelledby={props.labelledBy} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {reviewers.map((r) => (
          <li
            key={r}
            className={cn("inline-flex items-center gap-1 rounded-[5px] border py-0.5 pl-2 text-xs", onChange ? "pr-0.5" : "pr-2")}
          >
            <span translate="no">{r}</span>
            {onChange && (
              <button
                type="button"
                aria-label={`Remove ${r}`}
                className="inline-grid size-6 cursor-pointer place-items-center rounded-[4px] text-ink-2 hover:bg-hover hover:text-foreground"
                onClick={() => onChange(reviewers.filter((x) => x !== r))}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            )}
          </li>
        ))}
        {!reviewers.length && <li className="text-xs text-muted-foreground">{props.empty}</li>}
      </ul>
      {onChange && (
        <div className="flex gap-2">
          <Input
            aria-label={props.addLabel}
            name="reviewer"
            placeholder="User name…"
            autoComplete="off"
            spellCheck={false}
            value={name}
            className="h-8"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add();
            }}
          />
          <Button type="button" variant="outline" onClick={add} disabled={!name.trim()}>
            Add
          </Button>
        </div>
      )}
    </>
  );
}

// The state of a row: an icon and the words, so the state never shows by color alone.
const LOOK_ICON = { waiting: CircleDashed, running: LoaderCircle, open: CircleCheck, failed: CircleAlert } as const;

function RowState({ look, className }: { look: RowLook; className?: string }) {
  const Icon = LOOK_ICON[look.state];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-start gap-1.5 text-xs",
        look.state === "failed" ? "text-destructive" : "text-ink-2",
        className,
      )}
    >
      <Icon aria-hidden className={cn("mt-px size-3.5 shrink-0", look.state === "running" && "motion-safe:animate-spin")} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{look.text}</span>
    </span>
  );
}

export type PrRowInput = { taskRepo: number; reviewers: string[] };

export function OpenPrsDialog(props: {
  t: TaskDto;
  rows: TaskPrDto[];
  open: boolean;
  busy: boolean;
  error: string | null;
  // The reviewers that the user picked per repository. A row without a pick has its default reviewers.
  picks: Readonly<Record<number, string[]>>;
  // The newest step ID when the user sent each row in this dialog (model.ts prRowLook).
  sent: Readonly<Record<number, number>>;
  onPick: (taskRepo: number, reviewers: string[]) => void;
  onOpenChange: (open: boolean) => void;
  onSend: (rows: PrRowInput[]) => void;
}) {
  const { t, rows, sent } = props;
  const reviewersOf = (r: TaskPrDto) => props.picks[r.taskRepo] ?? r.reviewers;
  const looks = rows.map((r) => prRowLook(r, t.steps, sent[r.taskRepo] ?? null));
  // Before the first send, the footer button sends every row. After it, each failed row has its own "Try again".
  const unsent = rows.every((r) => r.remotePr === null && sent[r.taskRepo] === undefined);
  const working = rows.some((r, i) => sent[r.taskRepo] !== undefined && (looks[i]?.state === "waiting" || looks[i]?.state === "running"));
  const opened = rows.filter((r) => r.remotePr !== null).length;
  const failures = looks.filter((l) => l.state === "failed").length;
  const failed = failures > 0;
  const branch = rows.find((r) => r.role === "main")?.branch ?? rows[0]?.branch ?? "";
  const note = working
    ? "The app pushes the branches and opens the PRs. You can close this dialog. The work goes on."
    : !unsent && failed
      ? `${opened} of ${rows.length} PRs are open.`
      : "";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-[600px]" onKeyDown={dialogKeys(() => props.onOpenChange(false))}>
        <DialogHeader>
          <DialogTitle>
            Push <span translate="no">{branch}</span> and open {rows.length} PRs?
          </DialogTitle>
          <DialogDescription>
            The app pushes only this branch, and only now. It never pushes to a base branch. Submodules go first, because their parent
            points at their commit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="m-0">
            <span className="text-ink-2">Title:</span> {t.key}: {t.title}
          </p>
          <ol aria-label="Pull requests" className="m-0 grid max-h-[50dvh] list-none gap-2 overflow-y-auto p-0">
            {rows.map((r, i) => {
              const look = looks[i] as RowLook;
              const name = prName(r);
              const size = rowSize(r);
              const editable =
                r.remotePr === null && look.state !== "running" && !(sent[r.taskRepo] !== undefined && look.state === "waiting");
              return (
                <li key={r.taskRepo} data-pr-row={name} className="grid gap-2 rounded-md border bg-card px-3 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <div className="grid min-w-0 gap-0.5">
                      <span translate="no" className="font-semibold [overflow-wrap:anywhere]">
                        {name}
                      </span>
                      <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">
                        <span translate="no" className="font-mono">
                          {r.branch} → {r.baseBranch}
                        </span>
                        {size && ` · ${size}`}
                      </span>
                    </div>
                    {look.state !== "failed" && <RowState look={look} />}
                  </div>
                  <div className="grid gap-1.5">
                    <span id={`pr-reviewers-${r.taskRepo}`} className="text-xs text-ink-2">
                      Reviewers<span className="sr-only"> of {name}</span>
                    </span>
                    <ReviewerChips
                      labelledBy={`pr-reviewers-${r.taskRepo}`}
                      reviewers={reviewersOf(r)}
                      addLabel={`Add a reviewer to ${name}`}
                      empty={editable ? "No reviewer. Add a user name, or open the PR without one." : "No reviewer."}
                      onChange={editable ? (list) => props.onPick(r.taskRepo, list) : undefined}
                    />
                  </div>
                  {look.state === "failed" && (
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <RowState look={look} className="flex-1 basis-60" />
                      {!unsent && (
                        <Button
                          variant={failures === 1 ? "default" : "outline"}
                          size="sm"
                          aria-label={`Try again for ${name}`}
                          disabled={props.busy}
                          onClick={() => props.onSend([{ taskRepo: r.taskRepo, reviewers: reviewersOf(r) }])}
                        >
                          Try again
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <p aria-live="polite" className={cn("m-0 text-ink-2", !note && "sr-only")}>
            {note}
          </p>
          {props.error && (
            <p role="alert" className="m-0 text-destructive">
              {props.error}
            </p>
          )}
        </div>
        <DialogFooter>
          {unsent ? (
            <>
              <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={props.busy}
                onClick={() => props.onSend(rows.map((r) => ({ taskRepo: r.taskRepo, reviewers: reviewersOf(r) })))}
              >
                {props.busy ? "Pushing…" : `Push and open ${rows.length} PRs`}
              </Button>
            </>
          ) : (
            <Button variant={working || failed ? "outline" : "default"} onClick={() => props.onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
