// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// One thread of the detail pane (prototype/v3 thread, threadBody, tree, msg). A collapsed thread renders no message, so it acks nothing.
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardCopy,
  Clock,
  Copy,
  CornerDownRight,
  Ellipsis,
  ExternalLink,
  FileCode,
  History,
  Hourglass,
  Link,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Reply,
  RotateCcw,
  SquareCheckBig,
  SquareDot,
  Wrench,
} from "lucide-react";
import { lazy, memo, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { ExcerptLine, PostDto, ReviewItemDto } from "../../shared/dto";
import { commentUrl } from "../../shared/links";
import type { ResolveOutcome } from "../publish/data";
import { type PostCtx, ReplyPosts } from "../publish/Outbox";
import { lineText } from "../review/model";
import { Hint, type Hints, HintTrigger } from "../shell/Hint";
import { ago, initials } from "../shell/model";
import { ReplyComposer, type ReplyTarget } from "./ReplyComposer";
import { ThreadHistory } from "./ThreadHistory";
import {
  type Anchor,
  agoLong,
  type FoldRow,
  firstName,
  hueOf,
  type Li,
  layout,
  type Node,
  names,
  type Person,
  resolvedText,
  snippet,
  splitExcerpt,
  type ThreadModel,
  turnText,
} from "./threads";

// The Markdown renderer loads on first use, so the main chunk stays small. Plain text shows until then.
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

export function Text({ text, diagrams }: { text: string; diagrams?: boolean }) {
  return (
    <Suspense fallback={<p className="m-0 whitespace-pre-wrap">{text}</p>}>
      <Markdown text={text} diagrams={diagrams} />
    </Suspense>
  );
}

// The result of a runner prompt copy. next: the next step. text: the prompt, when the clipboard is blocked.
export type PromptCopy = { next: string; text?: string };

// The next step after a prompt copy. A blocked clipboard also shows the prompt in a field. The field takes the focus with the prompt
// selected, so Ctrl+C copies it.
export function PromptNote({ id, r, className }: { id: string; r: PromptCopy; className?: string }) {
  const selectAll = useCallback((el: HTMLTextAreaElement | null) => {
    el?.focus();
    el?.select();
  }, []);
  return (
    <>
      {r.text !== undefined && (
        <div className={cn("rl-fade mt-1.5 max-w-[72ch]", className)}>
          <label htmlFor={id} className="text-xs text-ink-2">
            The clipboard is blocked here. The prompt is selected: press Ctrl+C to copy it.
          </label>
          <Textarea
            ref={selectAll}
            id={id}
            readOnly
            spellCheck={false}
            rows={6}
            value={r.text}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1 field-sizing-fixed resize-y bg-pane font-mono text-xs"
          />
        </div>
      )}
      <p className={cn("rl-fade m-0 mt-1.5 max-w-[72ch] text-xs text-ink-2 [overflow-wrap:anywhere]", className)}>
        {r.text === undefined && <Check aria-hidden className="mr-1 inline size-[13px] align-[-2px]" />}
        {r.next}
      </p>
    </>
  );
}

export type ThreadCtx = {
  pr: number;
  hints: Hints;
  now: number;
  forge: string;
  // The PR link of the server (webLink). null: no comment links.
  web: string | null;
  // The runner name, for "Posted from a <runner> review".
  runner: string;
  // I, for the avatar of my replies on the way.
  me: Person;
  ackRef: (el: HTMLElement | null) => (() => void) | undefined;
  onToggle: (thread: number) => void;
  onFold: (thread: number, row: FoldRow) => void;
  onQuote: (thread: number, msg: number) => void;
  announce: (text: string) => void;
  // msg null: the reply box of the thread answers the newest live message again.
  onReply: (thread: number, msg: number | null) => void;
  // Starts a reply-draft run for this thread only (replies.md step 6, D13).
  onDraftReply: (thread: number) => void;
  // Plan r2 UI-DIFF: focuses the line of an inline thread in the diff.
  onShowInDiff: (thread: number) => void;
  // The user's own pull request: open threads get Fix and the runner prompt (plan pr-view-v4 2.8).
  author: boolean;
  // Opens the Fix list with only this thread ticked.
  onFix: (thread: number) => void;
  // Copies the runner prompt of the thread. Call it in the click handler. Resolves to the next step, or null.
  copyPrompt: (thread: number) => Promise<PromptCopy | null>;
  posts: PostCtx;
  // Resolves or reopens a thread on the forge now. seen: the newest live message on screen. null: done.
  setResolved: (thread: number, resolved: boolean, seen: number) => Promise<ResolveOutcome>;
  // Opens the log sheet of one run, for the AI lines of the thread history.
  onLog: (run: number) => void;
  // The current reply draft of the thread (GET reply-drafts), read when the reply confirm opens.
  replyDraft: (thread: number) => ReviewItemDto | undefined;
};

// docs/plans/review-v2/spec.md section 2.1: a thread that a posted finding started. label and open: the More item that opens the talk
// about the finding. chat: the open talk under the thread, null when it is closed.
export type ThreadTalkEntry = { label: string; open: () => void; chat: ReactNode };

// False until one frame after `key` changes. Put data-mounting on a container while it is false: the motion classes of
// index.css then skip the content that mounts with that container.
export function useSettled(key: unknown): boolean {
  const [settled, setSettled] = useState<{ key: unknown } | null>(null);
  useEffect(() => {
    const h = requestAnimationFrame(() => setSettled({ key }));
    return () => cancelAnimationFrame(h);
  }, [key]);
  return settled !== null && Object.is(settled.key, key);
}

export const fullTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const icon = "size-[15px] shrink-0";

export function Avatar({ p }: { p: Person }) {
  return (
    <span aria-hidden className="rl-av" data-h={p.me ? undefined : hueOf(p.slug)} data-me={p.me || undefined}>
      {initials(p.name)}
    </span>
  );
}

// An icon without visible words: the words go to screen readers and to the shared tooltip.
function IconHint({ hints, label, children }: { hints: Hints; label: string; children: ReactNode }) {
  return (
    <HintTrigger hints={hints} label={label}>
      <span role="img" aria-label={label} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
        {children}
      </span>
    </HintTrigger>
  );
}

// New: one filled dot plus the word.
export function NewMark({ text }: { text: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-semibold whitespace-nowrap text-foreground">
      <span aria-hidden className="size-[7px] rounded-full bg-foreground" />
      {text}
    </span>
  );
}

// queries.ts: a task is a BLOCKER comment, OPEN or RESOLVED on the forge. The words carry the state; the mark is no control.
function TaskMark({ task }: { task: "open" | "done" }) {
  return (
    <Badge variant={task === "done" ? "quiet" : "soft"} data-task={task}>
      {task === "done" ? <SquareCheckBig aria-hidden /> : <SquareDot aria-hidden />}
      {task === "done" ? "Resolved task" : "Open task"}
    </Badge>
  );
}

// A resolved thread: an icon and words, never color alone. The tooltip gives the full name and time when the forge sent them.
// In a narrow head the mark shrinks before the file name.
export function ResolvedMark({ t, hints, now }: { t: Pick<ThreadModel, "resolver" | "resolvedAt">; hints: Hints; now: number }) {
  const badge = (
    <Badge variant="quiet" data-resolved="" className="min-w-0 shrink-[4]">
      <CircleCheck aria-hidden />
      <span className="truncate">{resolvedText(t, now)}</span>
    </Badge>
  );
  if (!t.resolver && t.resolvedAt === null) return badge;
  const by = t.resolver ? ` by ${t.resolver.me ? "you" : t.resolver.name}` : "";
  return (
    <HintTrigger hints={hints} label={`Resolved${by}${t.resolvedAt === null ? "" : `, ${fullTime(t.resolvedAt)}`}`}>
      <span className="inline-flex min-w-0 shrink-[4]">{badge}</span>
    </HintTrigger>
  );
}

// The lines of a thread: "7", or "3–12" for a range comment.
const linesOf = (a: Anchor) => (a.line === undefined ? undefined : lineText({ line: a.line, lineEnd: a.lineEnd ?? a.line }));

const placeOf = (t: ThreadModel) =>
  t.anchor ? `${t.anchor.path}${t.anchor.line === undefined ? "" : `:${linesOf(t.anchor)}`}` : "General comment";

// A collapsed thread is one line that sums it up. An open thread shows the same facts in its messages, so the line drops them.
// posts: my replies on the way. target: the message that the reply box answers. draft: the AI reply draft card (WP18).
// drafted: the thread has a reply draft to accept, or one on the way, so the footer has no Draft reply. talk: the thread of a posted
// finding.
export const Thread = memo(function Thread({
  t,
  open,
  cur,
  spine,
  branches,
  posts,
  target,
  draft,
  drafted,
  talk,
  ctx,
}: {
  t: ThreadModel;
  open: boolean;
  cur: boolean;
  spine: boolean;
  branches: ReadonlySet<number>;
  posts?: readonly PostDto[];
  target?: ReplyTarget;
  draft?: ReactNode;
  drafted: boolean;
  talk?: ThreadTalkEntry;
  ctx: ThreadCtx;
}) {
  const a = t.anchor;
  const base = a ? a.path.slice(a.path.lastIndexOf("/") + 1) : null;
  const replies = t.msgs.length - 1;
  const last = t.last;
  const settled = useSettled(open);
  return (
    <article
      id={`t-${t.id}`}
      data-thread={t.id}
      tabIndex={-1}
      aria-label={`${turnText(t)}. ${placeOf(t)}.${t.fresh ? ` ${t.fresh} new.` : ""}`}
      className="scroll-mt-3 border-b"
    >
      <div className="flex items-center gap-0.5">
        <button
          id={`th-${t.id}`}
          type="button"
          aria-expanded={open}
          aria-controls={`tb-${t.id}`}
          onClick={() => ctx.onToggle(t.id)}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded px-1.5 py-2 text-left text-sm text-muted-foreground hover:bg-hover",
            cur && "bg-sel hover:bg-sel",
          )}
        >
          {a ? (
            <HintTrigger hints={ctx.hints} label={a.path}>
              <span translate="no" className="min-w-0 shrink truncate font-mono text-foreground">
                {base}
                {a.line !== undefined && <span className="text-muted-foreground">:{linesOf(a)}</span>}
              </span>
            </HintTrigger>
          ) : (
            <span className="shrink-0 text-foreground">General comment</span>
          )}
          {t.turn === "resolved" && <ResolvedMark t={t} hints={ctx.hints} now={ctx.now} />}
          {!open && (
            <>
              {a?.orphaned && (
                <IconHint hints={ctx.hints} label="Outdated. The code changed after this comment.">
                  <History aria-hidden className={icon} />
                </IconHint>
              )}
              {t.task && <TaskMark task={t.task} />}
              <span className="rl-wide-pane min-w-0 flex-1 truncate text-ink-2">
                {last ? `${last.who.me ? "You" : firstName(last.who)}: ${snippet(last.text, 160)}` : `Deleted on ${ctx.forge}`}
              </span>
              {replies > 0 && (
                <IconHint hints={ctx.hints} label={`${replies} ${replies === 1 ? "reply" : "replies"}`}>
                  <MessageSquare aria-hidden className={icon} />
                  {replies}
                </IconHint>
              )}
              {t.fresh > 0 && <NewMark text={`${t.fresh} new`} />}
            </>
          )}
          <HintTrigger hints={ctx.hints} label={fullTime(t.newest)}>
            <time dateTime={new Date(t.newest).toISOString()} className="ml-auto shrink-0 whitespace-nowrap">
              {ago(t.newest, ctx.now)}
            </time>
          </HintTrigger>
          <ChevronRight aria-hidden className={cn("rl-chev", icon)} />
        </button>
        {/* The link column keeps every chevron in one line. An open thread links to its root comment (plan v3 WP13b). */}
        <span className="flex w-[30px] flex-none justify-end">
          {open && ctx.web && <ForgeLink href={commentUrl(ctx.web, t.id)} label={`Open this thread in ${ctx.forge}`} hints={ctx.hints} />}
        </span>
      </div>
      <div id={`tb-${t.id}`} hidden={!open} data-mounting={!settled || undefined} className="px-1.5 pt-0.5 pb-4">
        {open && (
          <Body
            t={t}
            spine={spine}
            branches={branches}
            ctx={ctx}
            after={
              <>
                {posts && (
                  <ReplyPosts
                    posts={posts}
                    avatar={<Avatar p={ctx.me} />}
                    forge={ctx.forge}
                    ctx={ctx.posts}
                    web={ctx.web}
                    hints={ctx.hints}
                  />
                )}
                {draft}
                {talk?.chat}
                <Footer t={t} drafted={drafted} target={target} talk={talk} ctx={ctx} />
              </>
            }
          />
        )}
      </div>
    </article>
  );
});

// Plan pr-view-v4 2.8: the reply box, Draft reply on a your-turn thread without a draft, Fix on an open thread of the own PR,
// Resolve or Reopen, and More. The note after a prompt copy stays, so the user can read the next step.
// docs/plans/thread-outcome.md section 10: More opens the thread history under the footer. Its close gives the focus back to More.
// docs/plans/review-v2/spec.md section 2.1: on the thread of a posted finding, More opens the talk about the finding.
function Footer(props: { t: ThreadModel; drafted: boolean; target?: ReplyTarget; talk?: ThreadTalkEntry; ctx: ThreadCtx }) {
  const { t, drafted, target, talk, ctx } = props;
  const [next, setNext] = useState<PromptCopy | null>(null);
  const [history, setHistory] = useState(false);
  const open = t.turn !== "resolved" && t.last !== null;
  const link = ctx.web && commentUrl(ctx.web, t.id);
  const prompt = ctx.author && t.last !== null;
  const resolve = useResolve(t, ctx);
  const moreEl = () => document.querySelector<HTMLElement>(`#t-${t.id} [data-thread-more]`);
  const hideHistory = () => {
    setHistory(false);
    moreEl()?.focus({ preventScroll: true });
  };
  // After a pointer press on the menu item Hide history, Base UI 1.8 focused no element (tests/e2e/history.e2e.ts). So More takes it.
  const refocus = useRef(false);
  const menuDone = (on: boolean) => {
    if (on || !refocus.current) return;
    refocus.current = false;
    moreEl()?.focus({ preventScroll: true });
  };
  const copyLink = (url: string) =>
    copyText(url).then((ok) =>
      ok
        ? ctx.announce("Copied the comment link.")
        : toast.add({ title: `The clipboard is blocked here. Open the thread on ${ctx.forge}.` }),
    );
  return (
    <>
      <ReplyComposer
        t={t}
        target={target}
        ctx={ctx}
        aside={
          <span className="flex flex-wrap items-center gap-1.5">
            {t.turn === "your" && !drafted && (
              <Button size="sm" variant="outline" onClick={() => ctx.onDraftReply(t.id)}>
                <Bot aria-hidden data-icon="inline-start" />
                Draft reply
              </Button>
            )}
            {ctx.author && open && (
              <Hint label="Fix this thread. Key: f">
                <Button size="sm" variant="outline" aria-keyshortcuts="f" onClick={() => ctx.onFix(t.id)}>
                  <Wrench aria-hidden data-icon="inline-start" />
                  Fix
                </Button>
              </Hint>
            )}
            {resolve.can && (
              <Hint label={`${resolve.resolved ? "Reopen" : "Resolve"} this thread on ${ctx.forge}. Key: x`}>
                <Button
                  size="sm"
                  variant="outline"
                  data-resolve-thread
                  aria-label={resolve.resolved ? "Reopen thread" : "Resolve thread"}
                  aria-keyshortcuts="x"
                  onClick={resolve.start}
                >
                  {resolve.resolved ? (
                    <RotateCcw aria-hidden data-icon="inline-start" />
                  ) : (
                    <CircleCheck aria-hidden data-icon="inline-start" />
                  )}
                  {resolve.resolved ? "Reopen" : "Resolve"}
                </Button>
              </Hint>
            )}
            <DropdownMenu modal={false} onOpenChangeComplete={menuDone}>
              <Hint label="More for this thread">
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label="More for this thread" data-thread-more className="text-ink-2" />
                  }
                >
                  <Ellipsis aria-hidden />
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuGroup>
                  {t.anchor && (
                    <DropdownMenuItem onClick={() => ctx.onShowInDiff(t.id)}>
                      <FileCode aria-hidden />
                      Show in diff
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => {
                      refocus.current = history;
                      setHistory(!history);
                    }}
                  >
                    <Clock aria-hidden />
                    {history ? "Hide history" : "Show history"}
                  </DropdownMenuItem>
                  {talk && (
                    <DropdownMenuItem onClick={talk.open}>
                      <MessagesSquare aria-hidden />
                      {talk.label}
                    </DropdownMenuItem>
                  )}
                  {prompt && (
                    <DropdownMenuItem onClick={() => void ctx.copyPrompt(t.id).then((r) => r && setNext(r))}>
                      <ClipboardCopy aria-hidden />
                      Copy prompt for {ctx.runner}
                    </DropdownMenuItem>
                  )}
                  {link && (
                    <>
                      <DropdownMenuItem onClick={() => void copyLink(link)}>
                        <Link aria-hidden />
                        Copy the comment link
                      </DropdownMenuItem>
                      <DropdownMenuItem render={<a href={link} target="_blank" rel="noopener noreferrer" />}>
                        <ExternalLink aria-hidden />
                        Open on {ctx.forge}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        }
      />
      {next && <PromptNote id={`pm-${t.id}`} r={next} />}
      {resolve.panel}
      {history && <ThreadHistory t={t} ctx={ctx} onClose={hideHistory} />}
    </>
  );
}

type ResolveState = { kind: "ask" } | { kind: "busy" } | { kind: "error"; out: NonNullable<ResolveOutcome> } | null;

// A manual resolve or reopen goes to the forge at once. A thread that another person started asks first.
// Errors stay inline: "changed" and "messages" ask to read the thread again; "forbidden" and "ignored" link to the forge.
function useResolve(t: ThreadModel, ctx: ThreadCtx) {
  const [state, setState] = useState<ResolveState>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const resolved = t.turn === "resolved";
  const can = t.last !== null;
  const act = resolved ? "Reopen" : "Resolve";
  const link = ctx.web && commentUrl(ctx.web, t.id);
  useEffect(() => {
    if (state?.kind === "ask") confirm.current?.focus({ preventScroll: true });
  }, [state]);
  const run = async () => {
    if (!t.last || state?.kind === "busy") return;
    setState({ kind: "busy" });
    const out = await ctx.setResolved(t.id, !resolved, t.last.id).catch((e: unknown) => ({ error: (e as Error).message, reason: null }));
    setState(out ? { kind: "error", out } : null);
    // The alert reads an error. A done change moves the thread, so the live region says it.
    if (!out) ctx.announce(resolved ? "Thread reopened." : "Thread resolved.");
  };
  const start = () => (t.root.who.me ? void run() : setState({ kind: "ask" }));
  const panel =
    state?.kind === "ask" ? (
      <div className="rl-fade mt-2 flex max-w-[72ch] flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        <span className="[overflow-wrap:anywhere]">
          {t.root.who.name} started this thread. {act} it on {ctx.forge}?
        </span>
        <Button ref={confirm} size="sm" onClick={() => void run()}>
          {act}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setState(null)}>
          Cancel
        </Button>
      </div>
    ) : state?.kind === "busy" ? (
      <p role="status" className="m-0 mt-2 inline-flex items-center gap-1.5 text-sm text-ink-2">
        <LoaderCircle aria-hidden className="size-[15px] animate-spin motion-reduce:animate-none" />
        {resolved ? "Reopening the thread…" : "Resolving the thread…"}
      </p>
    ) : state?.kind === "error" ? (
      <p role="alert" className="m-0 mt-2 flex max-w-[72ch] flex-wrap items-start gap-x-1.5 gap-y-1 text-sm text-destructive">
        <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{state.out.error}</span>
        {(state.out.reason === "forbidden" || state.out.reason === "ignored") && link && (
          <a href={link} target="_blank" rel="noopener noreferrer" className="rl-hit font-medium text-pen hover:underline">
            Open on {ctx.forge}
          </a>
        )}
      </p>
    ) : null;
  return { can, resolved, start, panel };
}

const SIGN = { add: "+", del: "−", ctx: " " } as const;

function Lines({ lines }: { lines: ExcerptLine[] }) {
  return lines.map((l) => (
    <span key={`${l.kind}${l.n}`} className="rl-cl" data-k={l.kind} data-hit={l.hit || undefined}>
      <span className="rl-no">{l.n}</span>
      <span className="rl-sg">{SIGN[l.kind]}</span>
      <span>
        {l.text}
        {l.hit && <span className="sr-only"> (commented line)</span>}
      </span>
    </span>
  ));
}

// An inline thread splits its excerpt after the commented line. The discussion sits in the gap.
// after: my replies on the way, the draft card, and the reply box, under the tree.
function Body(props: { t: ThreadModel; spine: boolean; branches: ReadonlySet<number>; ctx: ThreadCtx; after: ReactNode }) {
  const { t, spine, branches, ctx } = props;
  const tree = (
    <>
      <ol className="rl-tree">
        {layout(t, { spine, branches }).map((li) => (
          <Item key={li.msg?.id ?? `f${li.fold?.at}`} li={li} t={t} ctx={ctx} />
        ))}
      </ol>
      {props.after}
    </>
  );
  const a = t.anchor;
  const lines = t.root.excerpt;
  if (!a || !lines?.length) {
    return (
      <>
        {a?.orphaned && <p className="m-0 mb-1 text-xs text-muted-foreground">The code changed after this comment.</p>}
        <div className="rl-disc">{tree}</div>
      </>
    );
  }
  const { head, tail } = splitExcerpt(lines);
  const at = a.line === undefined ? a.path : `${a.path} ${(a.lineEnd ?? a.line) > a.line ? "lines" : "line"} ${linesOf(a)}`;
  return (
    <>
      <figure
        className={cn("rl-code m-0", tail.length > 0 && "rl-head")}
        aria-label={`Code at ${at}${a.orphaned ? ", as it was when the comment was written" : ""}`}
      >
        {a.orphaned && (
          <p className="m-0 px-2.5 pt-1.5 text-xs text-muted-foreground">
            Code as it was when the comment was written. The file changed after that.
          </p>
        )}
        <pre className="rl-pre">
          <Lines lines={head} />
        </pre>
      </figure>
      <div className="rl-disc rl-anchored">{tree}</div>
      {tail.length > 0 && (
        <figure className="rl-code rl-tail m-0" aria-label={`Code after line ${a.line ?? ""}`.trim()}>
          <pre className="rl-pre">
            <Lines lines={tail} />
          </pre>
        </figure>
      )}
    </>
  );
}

function Item({ li, t, ctx }: { li: Li; t: ThreadModel; ctx: ThreadCtx }) {
  const kids = li.kids.length > 0;
  return (
    <li className={cn(li.fold?.open && li.msg && "rl-opened", (kids || li.foot) && "rl-kids", li.foot && "rl-has-foot")}>
      {li.fold && <FoldButton row={li.fold} tid={t.id} ctx={ctx} />}
      {li.msg && <Message m={li.msg} quote={li.quote} tid={t.id} ctx={ctx} />}
      {kids && (
        <ol>
          {li.kids.map((k) => (
            <Item key={k.msg?.id ?? `f${k.fold?.at}`} li={k} t={t} ctx={ctx} />
          ))}
        </ol>
      )}
      {li.foot && (
        <p className="rl-foot m-0">
          {t.turn === "your" ? (
            <span className="inline-flex h-(--av) items-center gap-1.5 font-semibold text-turn">
              <Reply aria-hidden className={icon} />
              Your turn
            </span>
          ) : (
            <span className="inline-flex h-(--av) items-center gap-1.5 font-medium text-ink-2">
              <Hourglass aria-hidden className={icon} />
              {turnText(t)}
            </span>
          )}
        </p>
      )}
    </li>
  );
}

// Fold row: the chevron takes the avatar slot, so the tree line ends on it.
function FoldButton({ row, tid, ctx }: { row: FoldRow; tid: number; ctx: ThreadCtx }) {
  return (
    <button
      id={`fold-${row.at}`}
      type="button"
      aria-expanded={row.open}
      onClick={() => ctx.onFold(tid, row)}
      className="rl-fold-b relative flex min-h-(--av) max-w-full cursor-pointer items-center gap-1.5 rounded text-sm text-ink-2 hover:text-foreground hover:[&>.rl-fold-t]:underline"
    >
      {/* The chevron takes the avatar slot, so the tree line ends on it. */}
      <ChevronRight aria-hidden className={cn("rl-chev mx-[calc((var(--av)-15px)/2)] text-muted-foreground", icon)} />
      {row.kind === "branch" && (
        <span className="rl-stack inline-flex flex-none">
          {row.people.slice(0, 3).map((p) => (
            <Avatar key={p.slug} p={p} />
          ))}
        </span>
      )}
      <span className="rl-fold-t min-w-0 truncate">
        {row.kind === "spine"
          ? `${row.open ? "Hide" : "Show"} ${row.n} earlier ${row.n === 1 ? "reply" : "replies"}`
          : `${names(row.people)}, ${row.count} replies · ${ago(row.newest, ctx.now)}`}
      </span>
    </button>
  );
}

const msgBtn = "-my-1 text-muted-foreground hover:bg-hover hover:text-foreground";

// A link into the forge, opened in a new tab. The posted outbox rows use it too.
export function ForgeLink({ href, label, hints }: { href: string; label: string; hints: Hints }) {
  return (
    <HintTrigger hints={hints} label={label}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        className={buttonVariants({
          variant: "ghost",
          size: "icon-sm",
          className: "-my-1.5 text-ink-2 hover:bg-hover hover:text-foreground",
        })}
      >
        <ExternalLink aria-hidden />
      </a>
    </HintTrigger>
  );
}

// WP16: copies the raw Markdown. The reply draft card (WP18) uses it too.
export function CopyButton({ text, ctx }: { text: string; ctx: Pick<ThreadCtx, "hints" | "announce"> }) {
  // A count, so a second copy within 1.5 s starts the time again.
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const h = setTimeout(() => setCopied(0), 1500);
    return () => clearTimeout(h);
  }, [copied]);
  const label = copied ? "Copied" : "Copy Markdown";
  const copy = () =>
    copyText(text).then((ok) => {
      if (!ok) return toast.add({ title: "The clipboard is blocked here. Select the text and press Ctrl+C." });
      setCopied((n) => n + 1);
      ctx.announce("Copied");
    });
  return (
    <HintTrigger hints={ctx.hints} label={label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={copy} className={msgBtn}>
        {copied ? <Check key={copied} aria-hidden className="rl-pop" /> : <Copy aria-hidden />}
      </Button>
    </HintTrigger>
  );
}

const Message = memo(function Message({ m, quote, tid, ctx }: { m: Node; quote: boolean; tid: number; ctx: ThreadCtx }) {
  const p = m.parent;
  const name = m.who.me ? "You" : m.who.name;
  return (
    <article
      id={`c-${m.id}`}
      data-id={m.id}
      data-new={m.isNew || undefined}
      tabIndex={-1}
      ref={m.unread ? ctx.ackRef : undefined}
      aria-label={`${name}${p ? `, reply to ${firstName(p.who)}` : ""}, ${agoLong(m.createdAt, ctx.now)}${m.isNew ? ", new" : ""}`}
      className="rl-msg"
    >
      <div className="flex min-h-(--av) flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
        <Avatar p={m.who} />
        <b className="font-semibold text-foreground">{name}</b>
        <HintTrigger hints={ctx.hints} label={fullTime(m.createdAt)}>
          <time dateTime={new Date(m.createdAt).toISOString()}>{ago(m.createdAt, ctx.now)}</time>
        </HintTrigger>
        {m.task && <TaskMark task={m.task} />}
        {m.isNew && <NewMark text="new" />}
        {m.posted === "run" && <span>Posted from a {ctx.runner} review</span>}
        {m.posted === "draft" && <span>Posted from a reply draft</span>}
        {!m.deleted && m.text !== null && (
          <span className="ml-auto flex items-center gap-0.5">
            <HintTrigger hints={ctx.hints} label={`Reply to ${m.who.me ? "your message" : m.who.name}`}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Reply to ${m.who.me ? "your message" : m.who.name}`}
                onClick={() => ctx.onReply(tid, m.id)}
                className={msgBtn}
              >
                <Reply aria-hidden />
              </Button>
            </HintTrigger>
            <CopyButton text={m.text} ctx={ctx} />
          </span>
        )}
      </div>
      {/* The target reaches into the row above. 66 px is the 8 px of the indent plus the Reply and Copy buttons there (2 x 28 px, 2 px
          gap), so the target stays clear of them. */}
      {quote && p && (
        <button
          type="button"
          onClick={() => ctx.onQuote(tid, p.id)}
          className="rl-hit rl-indent mt-[calc(1px-var(--rl-hit))] flex w-fit max-w-[calc(100%-var(--av)-66px)] cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground hover:text-ink-2 hover:[&>span]:underline"
        >
          <CornerDownRight aria-hidden className="size-[13px] shrink-0" />
          <span className="min-w-0 truncate">
            <span className="sr-only">Replies to </span>
            {p.who.me ? "You" : firstName(p.who)}: {p.deleted ? `Deleted on ${ctx.forge}` : snippet(p.text, 64)}
          </span>
        </button>
      )}
      <div className="rl-indent mt-px max-w-[72ch] [overflow-wrap:anywhere]">
        {m.deleted || m.text === null ? <p className="m-0 text-muted-foreground italic">Deleted on {ctx.forge}</p> : <Text text={m.text} />}
      </div>
    </article>
  );
});
