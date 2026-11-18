// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The confirm step (prototype/v3 postBar confirm): the destination and the exact text of each comment. Nothing posts without it.
import { Ban, CircleAlert, CircleCheck, LoaderCircle, RotateCcw, Send } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Text } from "../pr/Thread";

// reopen: the reopen step before a reply in a resolved thread, as words. resolve: the resolve step of the post, as words. null: none.
export type ConfirmEntry = {
  key: string;
  code: string | null;
  dest: string;
  body: string;
  warning: string | null;
  reopen: string | null;
  resolve: string | null;
};

// docs/plans/thread-outcome.md: a draft that the post leaves out. onThread: go to its thread, null for a draft without a thread.
// detail: the fix commit or the run head, else null. action: a button that makes the draft postable or discards it, else null.
export type BlockedEntry = {
  key: string;
  dest: string;
  detail: string | null;
  onThread: (() => void) | null;
  action: { label: string; run: () => void } | null;
};
// The blocked drafts of one reason. text: what the user can do.
export type BlockedGroup = { key: string; title: string; text: string; items: BlockedEntry[] };

// entries: null while the plan loads. blocked: the drafts that the post leaves out. error: the answer of the last post, shown in the dialog.
export function Confirm(props: {
  id: string;
  title: string;
  note: ReactNode;
  entries: ConfirmEntry[] | null;
  blocked?: BlockedGroup[];
  posting: boolean;
  error: string | null;
  // canPost: false keeps Post off, for example while the plan loads or when no draft can post. off: why Post is off, shown next to it.
  canPost: boolean;
  off?: string;
  onPost: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const post = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const ready = props.entries !== null;
  // The focus goes to Cancel when Post is off, so both buttons name the reason.
  const off = ready && !props.canPost && props.off ? `${props.id}-off` : undefined;
  // prototype/v3 openConfirm: focus goes to Post once the list shows. Posting removes the button, so a post that ends
  // with the dialog still open (an error, a new plan) puts the focus back on it. A disabled Post takes no focus.
  useLayoutEffect(() => {
    if (ready && !props.posting) (props.canPost ? post : cancel).current?.focus({ preventScroll: true });
  }, [ready, props.posting, props.canPost]);
  return (
    <section
      id={props.id}
      role="dialog"
      aria-labelledby={`${props.id}-t`}
      aria-describedby={`${props.id}-n`}
      className={cn("flex min-h-0 flex-col gap-2", props.className)}
    >
      <h2 id={`${props.id}-t`} className="m-0 text-[15px] font-bold [overflow-wrap:anywhere]">
        {props.title}
      </h2>
      <p id={`${props.id}-n`} className="m-0 text-sm text-ink-2">
        {props.note}
      </p>
      {!props.entries ? (
        <div role="status" aria-busy="true" aria-label="Loading the comments" className="grid gap-2 border-t pt-2">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        props.entries.length > 0 && (
          <ol aria-label="Comments to post" className="m-0 min-h-0 flex-[0_1_auto] list-none overflow-auto border-t p-0">
            {props.entries.map((e) => (
              <li
                key={e.key}
                className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-0.5 border-b py-2 @min-[560px]/detail:grid-cols-[24ch_minmax(0,1fr)]"
              >
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {e.code && (
                    <>
                      <code translate="no" className="font-mono text-foreground">
                        {e.code}
                      </code>
                      <br />
                    </>
                  )}
                  {e.dest}
                </span>
                <div className="max-w-[72ch] text-sm [overflow-wrap:anywhere]">
                  {e.reopen && (
                    <p data-reopen className="m-0 mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-2">
                      <RotateCcw aria-hidden className="size-[13px] shrink-0" />
                      {e.reopen}
                    </p>
                  )}
                  {e.body && <Text text={e.body} />}
                  {e.resolve && (
                    <p data-resolve className="m-0 mt-1 flex items-center gap-1.5 text-xs font-medium text-ink-2">
                      <CircleCheck aria-hidden className="size-[13px] shrink-0" />
                      {e.resolve}
                    </p>
                  )}
                </div>
                {e.warning && (
                  <p className="m-0 text-xs text-ink-2 @min-[560px]/detail:col-start-2">
                    <CircleAlert aria-hidden className="mr-1 inline size-[13px] align-[-2px]" />
                    {e.warning}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )
      )}
      {props.entries && props.blocked && props.blocked.length > 0 && (
        <div data-blocked-list className="flex min-h-0 flex-[0_1_auto] flex-col gap-1 overflow-auto border-t pt-2">
          <h3 className="m-0 text-xs font-semibold text-ink-2">Cannot post now</h3>
          {props.blocked.map((g) => (
            <section key={g.key} data-blocked-group={g.key} aria-labelledby={`${props.id}-${g.key}`} className="grid gap-0.5">
              <h4 id={`${props.id}-${g.key}`} className="m-0 flex items-center gap-1.5 text-sm font-semibold">
                <Ban aria-hidden className="size-[13px] shrink-0 text-ink-2" />
                {g.title} ({g.items.length})
              </h4>
              <p className="m-0 text-xs text-ink-2">{g.text}</p>
              <ul aria-label={g.title} className="m-0 list-none p-0">
                {g.items.map((b) => (
                  <li key={b.key} data-blocked className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 text-sm">
                    {/* The target is 24 px high (WCAG 2.5.8). The negative margins keep the row as it was. */}
                    {b.onThread ? (
                      <button
                        type="button"
                        className="-my-[3px] inline-flex min-h-6 min-w-0 cursor-pointer items-center rounded text-left font-medium text-pen [overflow-wrap:anywhere] hover:underline"
                        onClick={b.onThread}
                      >
                        {b.dest}
                      </button>
                    ) : (
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{b.dest}</span>
                    )}
                    {b.detail && (
                      <code translate="no" className="font-mono text-xs text-muted-foreground">
                        {b.detail}
                      </code>
                    )}
                    {b.action && (
                      <Button size="sm" variant="outline" className="ml-auto" onClick={b.action.run}>
                        {b.action.label}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {props.error && (
        <p role="alert" className="m-0 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
          {props.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {props.posting ? (
          <span role="status" className="inline-flex items-center gap-1.5 text-sm text-ink-2">
            <LoaderCircle aria-hidden className="size-[15px] animate-spin motion-reduce:animate-none" />
            Posting…
          </span>
        ) : (
          <>
            <Button ref={post} size="sm" disabled={!props.canPost} aria-describedby={off} onClick={props.onPost}>
              <Send aria-hidden data-icon="inline-start" />
              Post
            </Button>
            <Button ref={cancel} size="sm" variant="outline" title="Key: Esc" aria-describedby={off} onClick={props.onCancel}>
              Cancel
            </Button>
            {off && (
              <span id={off} className="ml-1 text-xs text-ink-2">
                {props.off}
              </span>
            )}
            <span className="ml-1 text-xs text-muted-foreground">Esc cancels.</span>
          </>
        )}
      </div>
    </section>
  );
}
