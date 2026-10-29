// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Detail header (plan pr-view-v4 2.1 to 2.3): the key link, the title, the byline, the action bar, and the status strip.
// The action bar sticks to the top of the pane. When the title leaves the view, the bar shows the key and the title.
// Rule 2.1: each name of a server object opens that object. The key "PROJ/repo #id" opens the PR (decision D1).
import {
  Archive,
  BookOpenText,
  Check,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleX,
  ClipboardCopy,
  Copy,
  Ellipsis,
  ExternalLink,
  FileDiff,
  History,
  Link,
  LoaderCircle,
  Maximize2,
  MessageCircleQuestionMark,
  MessageSquare,
  Minimize2,
  Reply,
  Star,
} from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { BuildState } from "../../shared/build";
import type { BuildDto, PrRow } from "../../shared/dto";
import { archived } from "../../shared/views";
import type { ConsultUi } from "../consult/Consult";
import { useMeta } from "../meta";
import { useArchive, useFollow } from "../shell/data";
import { Hint } from "../shell/Hint";
import { prKey, taskHint } from "../shell/model";
import { BUILD_WORD, countsText, namedBuild } from "./build";
import { Avatar, NewMark } from "./Thread";
import { visitText } from "./threads";

// Only http(s) links from the server reach an href.
export function webLink(url: string | null): string | null {
  if (!url) return null;
  try {
    return /^https?:$/.test(new URL(url).protocol) ? url.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

const iconBtn = "text-ink-2 hover:bg-hover hover:text-foreground";
const external = { target: "_blank", rel: "noopener noreferrer" } as const;

// The branch name links to its page on the forge. copy: a visible copy button after the name (plan pr-view-v4 2.1, H3).
function BranchRef(props: { name: string; url: string | null; forge: string; copy?: boolean; announce: (text: string) => void }) {
  const { name, announce } = props;
  // A count, so a second copy within 1.5 s starts the time again.
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const h = setTimeout(() => setCopied(0), 1500);
    return () => clearTimeout(h);
  }, [copied]);
  const href = webLink(props.url);
  const copy = () =>
    copyText(name).then((ok) => {
      if (!ok) return toast.add({ title: "The clipboard is blocked here. Select the branch name and press Ctrl+C." });
      setCopied((n) => n + 1);
      announce(`Copied ${name}.`);
    });
  const text = "min-w-0 font-mono text-xs text-ink-2 [overflow-wrap:anywhere]";
  return (
    <span data-branch={name} className="inline-flex min-w-0 items-center">
      {href ? (
        <Hint label={`Open the branch in ${props.forge}`}>
          <a
            href={href}
            {...external}
            className={cn(
              text,
              "rl-hit rounded underline decoration-rule-strong decoration-dotted underline-offset-3 hover:text-pen hover:decoration-current hover:decoration-solid",
            )}
          >
            {name}
          </a>
        </Hint>
      ) : (
        <code className={text}>{name}</code>
      )}
      {props.copy && (
        <Hint label={copied ? "Copied" : "Copy the branch name"}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Copy ${name}`}
            className="ml-0.5 text-muted-foreground hover:text-foreground"
            onClick={() => void copy()}
          >
            {copied ? <Check key={copied} aria-hidden className="rl-pop" /> : <Copy aria-hidden />}
          </Button>
        </Hint>
      )}
    </span>
  );
}

// The author's name links to the user page when the server gives one with the configured origin (data need N2).
function Author({ pr, forge }: { pr: PrRow; forge: string }) {
  const name = pr.authorName ?? pr.authorSlug;
  if (!name) return null;
  const own = pr.role === "AUTHOR";
  const href = own ? null : webLink(pr.authorUrl);
  const word = "font-medium text-foreground";
  return (
    <span data-author className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar p={{ slug: pr.authorSlug ?? name, name, me: own }} />
      <span className="sr-only">Opened by </span>
      {own ? (
        <span className={word}>You</span>
      ) : href ? (
        <Hint label={`Open the user page in ${forge}`}>
          <a
            href={href}
            {...external}
            className={cn(word, "rl-hit rounded [overflow-wrap:anywhere] hover:text-pen hover:underline underline-offset-3")}
          >
            {name}
          </a>
        </Hint>
      ) : (
        <span className={cn(word, "[overflow-wrap:anywhere]")}>{name}</span>
      )}
    </span>
  );
}

const chip = "inline-flex items-center gap-1 rounded-[5px] border px-[7px] font-mono text-xs leading-5 whitespace-nowrap";

// A task ID with a link opens the task. Without a link pattern, the chip opens Settings, Task IDs (plan pr-view-v4 2.1, H2).
// The dashed border and the name carry the state, not only the color.
function TaskChip({ t, onTaskIds }: { t: PrRow["tasks"][number]; onTaskIds: () => void }) {
  const url = webLink(t.url);
  return url ? (
    <Hint label={taskHint(t)}>
      <a
        href={url}
        {...external}
        translate="no"
        data-task-chip={t.key}
        className={cn(chip, "border-rule-strong text-pen hover:border-pen hover:underline")}
      >
        {t.key}
        <ExternalLink aria-hidden className="size-3 shrink-0" />
      </a>
    </Hint>
  ) : (
    <Hint label="No link pattern yet. Opens Settings, Task IDs.">
      <button
        type="button"
        translate="no"
        data-task-chip={t.key}
        aria-label={`${t.key}. No task link yet. Opens Settings, Task IDs.`}
        className={cn(
          chip,
          "cursor-pointer border-dashed border-rule-strong text-ink-2 hover:border-muted-foreground hover:text-foreground",
        )}
        onClick={onTaskIds}
      >
        {t.key}
      </button>
    </Hint>
  );
}

export const BUILD_ICON: Record<BuildState, typeof Check> = {
  failed: CircleX,
  running: CircleDashed,
  passed: CircleCheck,
  other: CircleQuestionMark,
  none: CircleQuestionMark,
};

// docs/plans/ci-builds.md, Layer A: the state word, the named build, and the counts. The word carries the state, not only the color.
// The build page opens only in the browser.
export function BuildLine({ b, className }: { b: BuildDto | null; className?: string }) {
  const word = b && BUILD_WORD[b.state];
  if (!b || !word) return null;
  const s = namedBuild(b);
  const href = webLink(s?.url ?? null);
  const Icon = BUILD_ICON[b.state];
  return (
    <span data-build={b.state} className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1.5", className)}>
      <span className={cn("inline-flex items-center gap-1.5 font-medium", b.state === "failed" && "text-destructive")}>
        <Icon aria-hidden className="size-[15px] shrink-0" />
        {word}
        {s && ":"}
      </span>
      {/* A flex box drops the spaces from the layout, but the text keeps them. */}{" "}
      {s &&
        (href ? (
          <Hint label="Open the build page">
            <a
              href={href}
              {...external}
              className="rl-hit inline-flex min-w-0 items-center gap-1 rounded underline decoration-rule-strong decoration-dotted underline-offset-3 [overflow-wrap:anywhere] hover:text-pen hover:decoration-current hover:decoration-solid"
            >
              {s.name}
              <ExternalLink aria-hidden className="size-3 shrink-0" />
            </a>
          </Hint>
        ) : (
          <span className="[overflow-wrap:anywhere]">{s.name}</span>
        ))}{" "}
      <span className="text-muted-foreground">
        ({countsText(b)}
        {b.builds === null && "; details not available"})
      </span>
    </span>
  );
}

// Plan pr-view-v4 2.2 and section 9: More holds the PR link actions and, on your own PR, the session consult (session-consult.md parts A to C).
function MoreMenu({
  pr,
  forge,
  announce,
  consult,
}: {
  pr: PrRow;
  forge: string;
  announce: (text: string) => void;
  consult: Pick<ConsultUi, "copy" | "session" | "sessions">;
}) {
  const web = webLink(pr.webUrl);
  const own = pr.role === "AUTHOR";
  if (!web && !own) return null;
  const copyLink = (url: string) =>
    copyText(url).then((ok) =>
      ok
        ? announce("Copied the pull request link.")
        : toast.add({ title: "The clipboard is blocked here. Copy the link from the address bar of the server page." }),
    );
  const item = (label: string, note: string, Icon: typeof Link, onClick: () => void) => (
    <DropdownMenuItem className="items-start py-1.5" onClick={onClick}>
      <Icon aria-hidden className="mt-0.5" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu modal={false}>
      <Hint label="More actions">
        <DropdownMenuTrigger render={<Button id="more-btn" variant="ghost" size="icon-sm" aria-label="More actions" className={iconBtn} />}>
          <Ellipsis aria-hidden />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-72">
        {web && (
          <DropdownMenuGroup>
            <DropdownMenuItem render={<a href={web} {...external} />}>
              <ExternalLink aria-hidden />
              Open on {forge}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copyLink(web)}>
              <Link aria-hidden />
              Copy the pull request link
            </DropdownMenuItem>
          </DropdownMenuGroup>
        )}
        {own && (
          <>
            {web && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              {item("Copy for your session…", "Give open comments to the session that wrote the code.", ClipboardCopy, () =>
                consult.copy(),
              )}
              {/* docs/plans/session-consult.md part C. It shows only while its opt-in in Settings, Clones is on. */}
              {consult.sessions &&
                item("Ask your session…", "Resume a copy of the session that wrote the code and ask it directly.", History, () =>
                  consult.session(),
                )}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The bar sticks once the header part above it leaves the view. Then it shows the key and the title.
// It sets the scroll padding of the pane to its height, so a scroll target stops below it.
function ActionBar({
  top,
  label,
  title,
  children,
}: {
  top: RefObject<HTMLElement | null>;
  label: string;
  title: string;
  children: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = top.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e && setStuck(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0)), {
      root: bar.current?.closest<HTMLElement>("[data-scroll]") ?? null,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [top]);
  useLayoutEffect(() => {
    const el = bar.current;
    const pane = el?.closest<HTMLElement>("[data-scroll]");
    if (!el || !pane) return;
    const ro = new ResizeObserver(() => {
      pane.style.scrollPaddingTop = `${el.offsetHeight}px`;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      pane.style.scrollPaddingTop = "";
    };
  }, []);
  return (
    <div
      ref={bar}
      data-actionbar
      data-stuck={stuck || undefined}
      className="sticky top-0 z-[3] flex items-center gap-3 border-b border-transparent bg-pane px-6 py-2 max-[759px]:px-4 data-stuck:border-border"
    >
      {stuck && (
        // The h1 above holds the same words for a screen reader. A pane of 520 px or less gives the width to the buttons.
        <p aria-hidden className="rl-fade m-0 flex min-w-0 flex-[1_1_0] items-baseline gap-2 overflow-hidden @max-[520px]/detail:hidden">
          <span translate="no" className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted-foreground">
            {label}
          </span>
          <span className="truncate text-sm font-semibold">{title}</span>
        </p>
      )}
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

const jump = "rl-hit inline-flex cursor-pointer items-center gap-1.5 rounded underline-offset-3 hover:text-foreground hover:underline";

// Status strip (plan pr-view-v4 2.3): one line of jumps. Each part is a button. Only "No comments yet" is text.
// since: the last visit before this one. fresh: the new messages. open: the threads that are not resolved.
// files: the count of Files, null while no list is known. answering: a question runs while Ask is closed (plan 2.4).
export function Strip(p: {
  your: number;
  fresh: number;
  since: number | null;
  now: number;
  threads: number;
  open: number;
  drafts: number;
  files: number | null;
  answering: boolean;
  onYour: () => void;
  onNew: () => void;
  onThreads: () => void;
  onDrafts: () => void;
  onFiles: () => void;
  onAnswering: () => void;
}) {
  return (
    <>
      {p.your > 0 && (
        <Hint label="Next thread where it is your turn. Key: y">
          <button type="button" aria-keyshortcuts="y" onClick={p.onYour} className={cn(jump, "font-semibold text-turn hover:text-turn")}>
            <Reply aria-hidden className="size-[15px]" />
            Your turn in {p.your} {p.your === 1 ? "thread" : "threads"}
          </button>
        </Hint>
      )}
      {p.fresh > 0 && (
        <Hint label="Next new message. Key: n">
          <button type="button" aria-keyshortcuts="n" onClick={p.onNew} className={jump}>
            <NewMark text={`${p.fresh} new`} />
            {/* A flex box drops the space from the layout, but the name keeps it: "2 new since yesterday". */}
            {p.since !== null && (
              <>
                {" "}
                <span>since {visitText(p.since, p.now)}</span>
              </>
            )}
          </button>
        </Hint>
      )}
      {p.threads > 0 ? (
        <Hint label={p.open ? "Go to the first open thread" : "Show the resolved threads"}>
          <button type="button" onClick={p.onThreads} className={jump}>
            <MessageSquare aria-hidden className="size-[15px]" />
            {p.open ? `${p.open} open ${p.open === 1 ? "thread" : "threads"}` : "No open thread"}
          </button>
        </Hint>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <MessageSquare aria-hidden className="size-[15px]" />
          No comments yet
        </span>
      )}
      {p.drafts > 0 && (
        <Hint label="Go to the drafts. Key: 2">
          <button type="button" aria-keyshortcuts="2" onClick={p.onDrafts} className={jump}>
            {p.drafts} {p.drafts === 1 ? "draft" : "drafts"}
          </button>
        </Hint>
      )}
      <Hint label="Go to Files. Keys: g, then f">
        <button type="button" onClick={p.onFiles} className={jump}>
          <FileDiff aria-hidden className="size-[15px]" />
          {p.files === null ? "Files" : `${p.files} ${p.files === 1 ? "file" : "files"}`}
        </button>
      </Hint>
      {/* Last, so the other parts keep their place when it shows and goes. */}
      {p.answering && (
        <Hint label="Open Ask. The answer shows there. Key: q">
          <button type="button" aria-keyshortcuts="q" onClick={p.onAnswering} className={jump}>
            <LoaderCircle aria-hidden className="size-[15px] animate-spin motion-reduce:animate-none" />
            Answering…
          </button>
        </Hint>
      )}
    </>
  );
}

// action: the run buttons (plan v3 WP11). slot: the panel slot under the strip, the brief or Ask (plan pr-view-v4 2.4).
// strip: the parts of the status strip, null while the PR loads. askOpen, onAsk: Ask in the slot. full, onFull: full width
// (plan 4.3, the z key). onTaskIds: opens Settings, Task IDs. onExplain: opens the Explain page (review-v2 spec.md section 3.1).
export function Header(props: {
  pr: PrRow;
  strip: ReactNode;
  onLeave: () => void;
  askOpen: boolean;
  onAsk: () => void;
  onExplain: () => void;
  full: boolean;
  onFull: () => void;
  onTaskIds: () => void;
  announce: (text: string) => void;
  consult: Pick<ConsultUi, "copy" | "session" | "sessions">;
  action: ReactNode;
  slot: ReactNode;
}) {
  const { pr, announce } = props;
  const follow = useFollow();
  const archive = useArchive();
  const meta = useMeta().data;
  const forge = meta?.forge.name ?? "";
  const runner = meta?.runner.short ?? "";
  const top = useRef<HTMLElement>(null);
  const key = prKey(pr);
  const title = pr.title ?? key;
  const web = webLink(pr.webUrl);
  const onArchive = () => {
    props.onLeave();
    archive.mutate({ id: pr.id, label: key });
  };
  const following = pr.followed ? "Following. Select to stop." : "Follow";
  // The archive notice of the detail holds the one action for an archived PR.
  const listed = !archived(pr);
  const pad = "px-6 max-[759px]:px-4";
  const keyText = (
    <>
      <span className="[overflow-wrap:anywhere]">
        {pr.project}/{pr.repo}
      </span>{" "}
      <b className="font-semibold whitespace-nowrap text-foreground group-hover/key:text-pen">#{pr.prId}</b>
    </>
  );
  return (
    <>
      <header ref={top} className={cn("grid gap-1.5 pt-3.5 max-[759px]:pt-2", pad)}>
        <div className="flex min-w-0 items-center gap-1.5">
          {web ? (
            <Hint label={`Open the pull request in ${forge}`}>
              <a
                id="pr-key"
                href={web}
                {...external}
                translate="no"
                className="group/key rl-hit inline-flex min-w-0 items-center gap-1.5 rounded font-mono text-xs text-ink-2 underline-offset-3 hover:text-pen hover:underline"
              >
                <span className="min-w-0">{keyText}</span>
                <ExternalLink aria-hidden className="size-[13px] shrink-0" />
              </a>
            </Hint>
          ) : (
            <span id="pr-key" translate="no" className="min-w-0 font-mono text-xs text-ink-2">
              {keyText}
            </span>
          )}
          {listed && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              <Hint label={following}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={iconBtn}
                  aria-label="Follow"
                  aria-pressed={pr.followed}
                  disabled={follow.isPending}
                  onClick={() => {
                    // Off the dashboard, an unfollowed PR leaves every list but Archive.
                    if (pr.followed && !pr.onDashboard) props.onLeave();
                    follow.mutate({ pr, followed: !pr.followed });
                  }}
                >
                  <Star aria-hidden className={cn(pr.followed && "fill-current")} />
                </Button>
              </Hint>
              <Hint label="Archive">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={iconBtn}
                  aria-label="Archive"
                  disabled={archive.isPending}
                  onClick={onArchive}
                >
                  <Archive aria-hidden />
                </Button>
              </Hint>
            </span>
          )}
        </div>
        <h1 className="m-0 min-w-0 text-(length:--fs-title) leading-tight font-bold tracking-[-0.015em] text-balance [overflow-wrap:anywhere]">
          {title}
        </h1>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-sm text-ink-2">
          <Author pr={pr} forge={forge} />
          {pr.sourceBranch && (
            <span translate="no" className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <BranchRef name={pr.sourceBranch} url={pr.sourceBranchUrl} forge={forge} copy announce={announce} />
              <span className="text-muted-foreground">into</span>
              {pr.targetBranch ? (
                <BranchRef name={pr.targetBranch} url={pr.targetBranchUrl} forge={forge} announce={announce} />
              ) : (
                <code className="font-mono text-xs text-ink-2">?</code>
              )}
            </span>
          )}
          {pr.tasks.length > 0 && (
            <span className="inline-flex flex-wrap gap-1.5">
              {pr.tasks.map((t) => (
                <TaskChip key={t.key} t={t} onTaskIds={props.onTaskIds} />
              ))}
            </span>
          )}
          <BuildLine b={pr.build} />
        </div>
      </header>
      <ActionBar top={top} label={key} title={title}>
        <Hint label={`Ask ${runner} a question about this pull request. Key: q`}>
          <Button
            id="ask-btn"
            size="sm"
            variant="outline"
            aria-label={`Ask ${runner}`}
            aria-keyshortcuts="q"
            aria-expanded={props.askOpen}
            onClick={props.onAsk}
          >
            <MessageCircleQuestionMark aria-hidden data-icon="inline-start" />
            Ask
          </Button>
        </Hint>
        <Hint label={`${runner} explains the change in plain words: what to read first, the risks, and diagrams. Key: w`}>
          <Button id="explain-btn" size="sm" variant="outline" aria-keyshortcuts="w" onClick={props.onExplain}>
            <BookOpenText aria-hidden data-icon="inline-start" />
            Explain this PR
          </Button>
        </Hint>
        {props.action}
        {/* The one pane layout has no full width. */}
        <Hint label={props.full ? "Back to three panes. Keys: z or Esc" : "Full width. Key: z"}>
          <Button
            id="full-btn"
            variant="ghost"
            size="icon-sm"
            className={cn(iconBtn, "rl-wide-only")}
            aria-label="Full width"
            aria-pressed={props.full}
            aria-keyshortcuts="z"
            onClick={props.onFull}
          >
            {props.full ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
          </Button>
        </Hint>
        <MoreMenu pr={pr} forge={forge} announce={announce} consult={props.consult} />
      </ActionBar>
      <nav
        aria-label="Pull request summary"
        className={cn("flex min-h-[29px] flex-wrap items-center gap-x-4 gap-y-1 border-b pt-0.5 pb-3 text-sm text-ink-2", pad)}
      >
        {props.strip}
      </nav>
      {/* The panel slot: the brief or Ask, one at a time. The task chips show here while both are closed. */}
      <div className={cn("pt-3 empty:hidden", pad)}>{props.slot}</div>
    </>
  );
}
