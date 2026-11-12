// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Discuss a finding (docs/plans/review-v2/spec.md section 2.1): the talk under a finding card or under the thread of a posted finding,
// and the new text of a changed finding. Each message is one run in a slot of the run pool. Nothing posts.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleStop,
  Info,
  LoaderCircle,
  MessagesSquare,
  PenLine,
  ScrollText,
  Undo2,
  User,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { DISCUSS_FULL, type DiscussTurnDto, type ItemConflict, type MetaDto, type ReviewItemDto } from "../../shared/dto";
import { type DiscussVerdict, MAX_QUESTION } from "../../shared/review";
import { api } from "../api";
import { Text } from "../pr/Thread";
import { ApiError, read } from "../shell/data";
import { failText } from "../shell/model";
import { useNow } from "../shell/Sidebar";
import { AiAvatar, Inline } from "./Drafts";
import { started, useCancelRun, useRun, useStart } from "./data";
import {
  askedText,
  outcomeLines,
  pendingTurn,
  refusedLine,
  revisionParts,
  startedText,
  talkHint,
  talkLeft,
  turnView,
} from "./discuss-model";
import { Cites, DiffText, type ReplyCtx, Suggestions } from "./ReplyDraft";
import { RunStatus } from "./RunLine";
import { useSlots } from "./useSlots";

const icon = "size-[15px] shrink-0";
// A text button in a line of text. rl-hit gives it a 24 px target (WCAG 2.5.8).
const linkish =
  "rl-hit inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline disabled:cursor-default disabled:opacity-60";
const PLACEHOLDER = "Ask why, push back, or add context";

const param = (id: number) => ({ param: { id: String(id) } });

// live.ts refreshes ['pr', pr] keys when a run of the PR starts or ends.
export const talkKey = (pr: number, item: number) => ["pr", pr, "discuss", item] as const;

const useTurns = (pr: number, item: number) =>
  useQuery({
    queryKey: talkKey(pr, item),
    queryFn: async () => read<DiscussTurnDto[]>(await api.api.items[":id"].discuss.$get(param(item))),
  });

// The 409 of a start whose finding changed on another page. item: the finding as the server has it.
class ItemChanged extends Error {
  constructor(
    readonly item: ReviewItemDto,
    message: string,
  ) {
    super(message);
  }
}

// POST /api/items/:id/discuss. 202 starts a run, 200 gives the running run of the same message. The new turn shows at once.
function useStartTalk(pr: number, item: number) {
  const qc = useQueryClient();
  return useStart(pr, async ({ message, revision }: { message: string; revision: number }) => {
    const res = await api.api.items[":id"].discuss.$post({ ...param(item), json: { message, revision } });
    if (res.status === 409) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as Partial<ItemConflict> | null;
      if (body?.item) throw new ItemChanged(body.item, body.error ?? "The finding changed on another page. Check it again.");
    }
    const r = await started(res);
    if ("run" in r)
      qc.setQueryData<DiscussTurnDto[]>(talkKey(pr, item), (old) => [
        ...(old ?? []).filter((t) => t.run !== r.run.id),
        pendingTurn(r.run, message),
      ]);
    return r;
  });
}

// The unsent text of each talk while the page lives. A closed talk keeps it for the next open.
const unsent = new Map<number, string>();

// onLog: the run log sheet of one run. onBrief: opens the review brief. toDraft: focuses the reply draft card of a thread.
// notes and cite: the note suggestion rows and the cites line, as on the reply draft cards.
export type TalkCtx = {
  pr: number;
  meta: MetaDto;
  announce: (text: string) => void;
  onLog: (run: number) => void;
  onBrief: () => void;
  toDraft: (draft: number) => void;
  notes: ReplyCtx["notes"];
  cite: ReplyCtx["cite"];
};

// The link on a finding card (key t). It opens and closes the talk under the card.
export function TalkLink({ it, open, runner, onClick }: { it: ReviewItemDto; open: boolean; runner: string; onClick: () => void }) {
  return (
    <button
      id={`talk-link-${it.id}`}
      type="button"
      title="Key: t"
      aria-keyshortcuts="t"
      aria-expanded={open}
      aria-controls={open ? `talk-${it.id}` : undefined}
      className="rl-hit ml-1 inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline"
      onClick={onClick}
    >
      <MessagesSquare aria-hidden className={icon} />
      Ask {runner} about this
    </button>
  );
}

const VERDICT_ICON: Record<DiscussVerdict, typeof CircleCheck> = { upheld: CircleCheck, revised: PenLine, withdrawn: CircleSlash };

function Err({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1.5 text-destructive">
      <CircleAlert aria-hidden className={cn(icon, "mt-0.5")} />
      <span>{children}</span>
    </span>
  );
}

// A clock outside the live region: a screen reader reads the region again on each tick of a clock in it.
function Started({ at }: { at: number }) {
  return <span>{startedText(at, useNow(true))}</span>;
}

// The talk of one finding: its turns oldest first, then one box with one primary button. posted: the finding is posted, so the talk
// sits under its thread and an answer can make a reply draft there. onClose: Esc and Close; the caller moves the focus back.
export function Talk({ it, onClose, ctx }: { it: ReviewItemDto; onClose: () => void; ctx: TalkCtx }) {
  const { meta } = ctx;
  const runner = meta.runner.short;
  const qc = useQueryClient();
  const turns = useTurns(ctx.pr, it.id);
  const list = turns.data ?? [];
  const start = useStartTalk(ctx.pr, it.id);
  const cancel = useCancelRun();
  const [text, setText] = useState(() => unsent.get(it.id) ?? "");
  // A start that the server refused. run: the run of the PR, or the oldest run of a full pool.
  const [refused, setRefused] = useState<{ text: string; run: number | null } | null>(null);
  const id = `talk-${it.id}`;
  const box = `${id}-box`;
  const posted = it.status === "posted";
  const full = talkLeft(list) === 0;
  // The box leaves when the talk reaches the cap. Its focus goes to the first control of the cap line.
  const fullRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const a = document.activeElement;
    if (full && (!a || a === document.body)) fullRef.current?.focus({ preventScroll: true });
  }, [full]);

  // The turn of this talk shows its own state, so only another run gives the busy line.
  const { note: busy, where } = useSlots(ctx.pr, runner, (run) => list.some((t) => t.run === run));

  const change = (v: string) => {
    setText(v);
    if (v) unsent.set(it.id, v);
    else unsent.delete(it.id);
  };
  const send = (message: string) => {
    document.getElementById(box)?.focus();
    const m = message.trim();
    if (!m) {
      toast.add({ title: "Type a message first." });
      return;
    }
    if (start.isPending) return;
    if (busy) {
      toast.add({ title: busy });
      return;
    }
    setRefused(null);
    start.mutate(
      { message: m, revision: it.revision },
      {
        onSuccess: (r) => {
          if ("conflict" in r) {
            setRefused({ text: refusedLine(runner, r.conflict, where), run: r.conflict.running.run });
            return;
          }
          // Text typed while the request was out stays in the box.
          setText((t) => {
            const next = t.trim() === m ? "" : t;
            if (!next) unsent.delete(it.id);
            return next;
          });
          ctx.announce(askedText(runner));
        },
        onError: (e) => {
          if (e instanceof ItemChanged) {
            void qc.invalidateQueries({ queryKey: ["run", e.item.run] });
            toast.add({ title: e.message });
            return;
          }
          // A 409 names its cause in one sentence: the message cap, a missing sync, or an item that takes no talk.
          setRefused({ text: e instanceof ApiError && e.status === 409 ? e.message : failText(e), run: null });
          if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: talkKey(ctx.pr, it.id) });
        },
      },
    );
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // The shell key handler never sees it, so the detail stays.
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  return (
    <section
      id={id}
      data-talk={it.id}
      aria-label={`Talk with ${runner} about this finding`}
      className="rl-enter mt-3 grid max-w-[72ch] gap-2 border-l-2 border-rule-strong pl-3"
      onKeyDown={onKeyDown}
    >
      {turns.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : turns.error ? (
        <p className="m-0 text-sm">
          <Err>Cannot load the talk. {turns.error.message}</Err>
        </p>
      ) : (
        list.length > 0 && (
          <ol className="m-0 list-none p-0">
            {list.map((t) => (
              <Turn
                key={t.run}
                t={t}
                posted={posted}
                waiting={it.revised?.id}
                cancelling={cancel.isPending && cancel.variables === t.run}
                onCancel={() => cancel.mutate(t.run, { onError: (e) => toast.add({ title: "Cancel failed", description: failText(e) }) })}
                onAgain={() => send(t.message)}
                ctx={ctx}
              />
            ))}
          </ol>
        )
      )}
      {full ? (
        <p data-talk-full className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
          <span>{DISCUSS_FULL}</span>
          {/* The box ID: an opened talk focuses its first control. */}
          <button ref={fullRef} id={box} type="button" className={linkish} onClick={ctx.onBrief}>
            Open the review brief
          </button>
          <button type="button" className={linkish} title="Key: Esc" onClick={onClose}>
            Close
          </button>
        </p>
      ) : (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <Textarea
            id={box}
            rows={2}
            maxLength={MAX_QUESTION}
            spellCheck
            autoComplete="off"
            name="message"
            value={text}
            aria-label={PLACEHOLDER}
            aria-describedby={`${id}-help`}
            placeholder={`${PLACEHOLDER}…`}
            className="field-sizing-fixed resize-y bg-pane leading-normal"
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Button
              type="submit"
              size="sm"
              data-primary
              disabled={start.isPending || !!busy}
              focusableWhenDisabled
              className="aria-disabled:cursor-default aria-disabled:opacity-50"
              aria-describedby={`${id}-help`}
              aria-keyshortcuts="Control+Enter"
              title="Key: Ctrl+Enter"
            >
              {start.isPending && <LoaderCircle aria-hidden data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />}
              Ask
            </Button>
            <Button type="button" size="sm" variant="outline" title="Key: Esc" onClick={onClose}>
              Close
            </Button>
            <span id={`${id}-help`} className="ml-1 text-xs text-muted-foreground">
              {talkHint(list, busy)}
            </span>
          </div>
        </form>
      )}
      {refused && (
        <p role="alert" data-talk-refused className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Err>{refused.text}</Err>
          {refused.run !== null && (
            <button type="button" className={linkish} onClick={() => ctx.onLog(refused.run as number)}>
              Open it
            </button>
          )}
        </p>
      )}
    </section>
  );
}

// One message and its answer. waiting: the revision that the finding card shows now.
function Turn(props: {
  t: DiscussTurnDto;
  posted: boolean;
  waiting: number | undefined;
  cancelling: boolean;
  onCancel: () => void;
  onAgain: () => void;
  ctx: TalkCtx;
}) {
  const { t, ctx } = props;
  const runner = ctx.meta.runner.short;
  const v = turnView(t, runner);
  const turnId = `talk-turn-${t.run}`;
  // The buttons of each turn name its message for screen readers.
  const about = `${turnId}-q`;
  const log = (
    <button type="button" className={linkish} aria-describedby={about} onClick={() => ctx.onLog(t.run)}>
      <ScrollText aria-hidden className={icon} />
      Log
    </button>
  );
  const again = (
    <button type="button" className={linkish} aria-describedby={about} onClick={props.onAgain}>
      Ask again
    </button>
  );
  let status: ReactNode;
  let actions: ReactNode;
  switch (v.kind) {
    case "running":
      status = (
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <LoaderCircle aria-hidden className={cn(icon, "animate-spin motion-reduce:animate-none")} />
          {runner} is reading the code.
        </span>
      );
      actions = (
        <>
          {log}
          <button type="button" className={linkish} aria-describedby={about} disabled={props.cancelling} onClick={props.onCancel}>
            {props.cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </>
      );
      break;
    case "answered": {
      const Icon = t.verdict ? VERDICT_ICON[t.verdict] : Check;
      status = v.chip ? (
        <Badge variant="outline" data-verdict={t.verdict}>
          <Icon aria-hidden data-icon="inline-start" />
          {v.chip}
        </Badge>
      ) : (
        <span className="text-foreground">{runner} answered.</span>
      );
      actions = log;
      break;
    }
    case "failed":
      status = <Err>{v.text}</Err>;
      actions = (
        <>
          {again}
          {log}
        </>
      );
      break;
    default:
      status = (
        <span className="inline-flex items-center gap-1.5">
          <CircleStop aria-hidden className={icon} />
          You cancelled this message.
        </span>
      );
      actions = (
        <>
          {again}
          {log}
        </>
      );
  }
  const lines = v.kind === "answered" ? outcomeLines(t, { posted: props.posted, waiting: props.waiting, runner }) : [];
  return (
    <li id={turnId} data-turn={t.run} tabIndex={-1} className="rl-enter grid grid-cols-[minmax(0,1fr)] gap-1.5 border-b py-2.5 first:pt-0">
      <p className="m-0 flex gap-2">
        <User aria-hidden className={cn(icon, "mt-[3px] text-muted-foreground")} />
        <span id={about} className="min-w-0 font-medium whitespace-pre-line [overflow-wrap:anywhere]">
          <span className="sr-only">You wrote: </span>
          {t.message}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-2">
        <AiAvatar meta={ctx.meta} />
        <RunStatus state={v.kind}>{status}</RunStatus>
        {v.kind === "running" && <Started at={v.startedAt} />}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">{actions}</span>
      </div>
      {v.kind === "answered" && (
        <div className="rl-fade grid pl-7">
          {v.answer && (
            <div className="[overflow-wrap:anywhere]">
              <Text text={v.answer} />
            </div>
          )}
          {v.reason?.trim() && (
            <p className="m-0 mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <Inline text={v.reason} />
            </p>
          )}
          <Cites cites={t.cites} flush ctx={ctx} />
          <Suggestions notes={t.notes} card={turnId} flush ctx={ctx} />
          {lines.map((l) => (
            <p key={l} data-talk-outcome className="m-0 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
              <Info aria-hidden className="size-[13px] shrink-0" />
              <span className="min-w-0">{l}</span>
              {t.applied.draft !== undefined && (
                <button type="button" className={linkish} onClick={() => ctx.toDraft(t.applied.draft as number)}>
                  Go to the draft
                </button>
              )}
            </p>
          ))}
        </div>
      )}
    </li>
  );
}

// The talk of a posted finding under its thread. The run detail of the finding gives its revision for the start.
export function ThreadTalk({ item, run, onClose, ctx }: { item: number; run: number; onClose: () => void; ctx: TalkCtx }) {
  const d = useRun(run);
  const it = d.data?.items.find((x) => x.id === item);
  if (it) return <Talk it={it} onClose={onClose} ctx={ctx} />;
  if (d.isPending) return <Skeleton className="mt-3 h-10 max-w-[72ch]" />;
  return (
    <p className="m-0 mt-3 text-sm">
      <Err>Cannot load the finding of this comment. {d.error ? failText(d.error) : "Its review run no longer lists it."}</Err>
    </p>
  );
}

// spec.md section 2.1: the new text of a changed finding as a word diff against the current text, with Use the new text and Keep mine.
export function FindingRevision(props: {
  it: ReviewItemDto;
  rev: ReviewItemDto;
  busy: boolean;
  runner: string;
  onTake: () => void;
  onKeep: () => void;
}) {
  const id = useId();
  const parts = revisionParts(props.it, props.rev);
  return (
    <section
      aria-labelledby={`${id}-t`}
      data-revision={props.rev.id}
      className="rl-enter mt-3 max-w-[72ch] border-l-2 border-pen/60 pl-2.5"
    >
      <p id={`${id}-t`} className="m-0 flex flex-wrap items-center gap-x-1.5 text-sm font-semibold">
        <PenLine aria-hidden className="size-[13px] shrink-0 text-pen" />
        {props.runner} changed this point
      </p>
      {parts.severity && (
        <p data-diff-severity className="m-0 mt-1 text-sm">
          <span className="font-semibold">Severity:</span> <DiffText parts={parts.severity} />
        </p>
      )}
      {parts.title && (
        <p data-diff-title className="m-0 mt-1 font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">
          <DiffText parts={parts.title} />
        </p>
      )}
      <p data-diff className="m-0 mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
        <DiffText parts={parts.body} />
      </p>
      <p id={`${id}-d`} className="m-0 mt-1.5 text-xs text-muted-foreground">
        Struck text leaves your text, underlined text comes in. Use the new text makes it the finding, not accepted. Keep mine drops it.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={props.busy} aria-describedby={`${id}-d`} onClick={props.onTake}>
          <Check aria-hidden data-icon="inline-start" />
          Use the new text
        </Button>
        <Button size="sm" variant="outline" disabled={props.busy} aria-describedby={`${id}-d`} onClick={props.onKeep}>
          <Undo2 aria-hidden data-icon="inline-start" />
          Keep mine
        </Button>
      </div>
    </section>
  );
}
