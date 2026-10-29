// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// List pane (prototype/v3 renderList): Needs you, Waiting on others, and a folded Done group.
// The Review runs, Ready to post, and Archive views are one flat list.
import {
  ArchiveRestore,
  BellOff,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  CircleX,
  History,
  Hourglass,
  LoaderCircle,
  Menu,
  Plus,
  Reply,
  Search,
  User,
  X,
} from "lucide-react";
import { memo, type Ref, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { PrRow, RunDto } from "../../shared/dto";
import type { PrRef } from "../../shared/types";
import { BUILD_WORD, buildHint } from "../pr/build";
import type { ReadyLine } from "../publish/model";
import { runWhy } from "../review/model";
import { createHints, Hint, type Hints, HintTrigger, SharedHint } from "./Hint";
import { ago, archiveWhy, incompleteText, type ListGroup, prKey, restoreWords, taskHint, why } from "./model";

// prototype/v3 kbd: an outlined mono key.
const kbd = "border border-rule-strong bg-transparent font-mono text-[11px] text-ink-2";
const groupHead = "m-0 flex items-center gap-2 border-b bg-pane-2 px-4 pt-[9px] pb-1.5 text-xs font-semibold text-ink-2";

// The relative times in the rows change once a minute.
export function useMinute() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function ListPane(props: {
  title: string;
  count: number;
  groups: ListGroup[];
  // The rows that change place when the list sorts again. The list keeps its order while the user works in it.
  updated: number;
  onResort: () => void;
  loading: boolean;
  repo: string | null;
  query: string;
  empty: string;
  selected: number | null;
  focused: boolean;
  doneOpen: boolean;
  forge: string;
  // The Review runs view: the newest run of each row. Its why-line names the run, not the inbox reason.
  runs: ReadonlyMap<number, RunDto> | null;
  // The Ready to post view: what each row posts and how many drafts cannot post. Its why-line names the comments (prototype/v3 whyPost).
  ready: ReadonlyMap<number, ReadyLine> | null;
  // The Archive view: each row names why it is there and has a Restore button.
  onRestore: ((p: PrRow) => void) | null;
  candidate: PrRef | null;
  following: boolean;
  followError: string | null;
  banner: React.ReactNode;
  filterRef: Ref<HTMLInputElement>;
  onQuery: (q: string) => void;
  onRepo: (r: string | null) => void;
  onDoneOpen: (open: boolean) => void;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
  onFollow: () => void;
  onMenu: () => void;
  onFocus: () => void;
}) {
  const now = useMinute();
  const [hints] = useState(createHints);
  const rows = (g: ListGroup) => (
    <ul className="m-0 list-none p-0">
      {g.rows.map((p) => (
        <Row
          key={p.id}
          p={p}
          now={now}
          forge={props.forge}
          hints={hints}
          run={props.runs?.get(p.id)}
          ready={props.ready?.get(p.id)}
          selected={p.id === props.selected}
          onSelect={props.onSelect}
          onOpen={props.onOpen}
          onRestore={props.onRestore}
        />
      ))}
    </ul>
  );
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
          <h2
            id="view-name"
            translate={props.repo ? "no" : undefined}
            title={props.repo ?? undefined}
            className="m-0 min-w-0 truncate text-[16px] font-bold tracking-[-0.01em]"
          >
            {props.title}
          </h2>
          <span className="text-sm text-muted-foreground">
            {props.loading ? "" : props.count}
            <span className="sr-only"> pull requests</span>
          </span>
          <span aria-live="polite" className="ml-auto self-center">
            {props.updated > 0 && (
              <button
                type="button"
                className="inline-flex h-[22px] cursor-pointer items-center gap-1 rounded-full bg-sel px-2 text-xs font-semibold whitespace-nowrap text-foreground hover:bg-hover"
                onClick={props.onResort}
              >
                {props.updated} updated · re-sort
              </button>
            )}
          </span>
        </div>
        <div className="flex h-[34px] items-center gap-2 rounded-[7px] border border-input bg-pane px-2.5 text-muted-foreground focus-within:border-pen focus-within:shadow-[0_0_0_1px_var(--pen)]">
          <Search aria-hidden className="size-[15px] shrink-0" />
          <input
            ref={props.filterRef}
            type="search"
            className="min-w-24 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="Filter, or paste a pull request URL…"
            aria-label="Filter the list"
            autoComplete="off"
            spellCheck={false}
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
          />
          {props.repo && (
            <span className="inline-flex h-[22px] min-w-0 items-center gap-1 rounded-full bg-sel pr-1 pl-2 text-xs font-semibold text-foreground">
              <span translate="no" title={props.repo} className="truncate">
                {props.repo}
              </span>
              <Hint label="Show all repositories">
                <button
                  type="button"
                  className="grid size-4 shrink-0 cursor-pointer place-items-center rounded-full hover:bg-hover"
                  aria-label="Show all repositories"
                  onClick={() => props.onRepo(null)}
                >
                  <X aria-hidden className="size-3" />
                </button>
              </Hint>
            </span>
          )}
        </div>
      </header>
      <div>{props.banner}</div>
      <div className="relative overflow-auto overscroll-contain" id="rows" tabIndex={-1}>
        {props.candidate && (
          <div className="grid gap-1 border-b bg-pane px-4 py-2.5">
            <button
              type="button"
              className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1 font-semibold text-primary-foreground disabled:opacity-60"
              onClick={props.onFollow}
              disabled={props.following}
            >
              <Plus aria-hidden className="size-3.5" />
              {props.following ? "Following…" : "Follow this pull request"}
            </button>
            <span translate="no" className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {props.candidate.project}/{props.candidate.repo} #{props.candidate.id}
            </span>
            {props.followError && (
              <span role="alert" className="text-sm text-destructive">
                {props.followError}
              </span>
            )}
          </div>
        )}
        {props.loading ? (
          <SkeletonRows />
        ) : props.groups.length ? (
          props.groups.map((g) =>
            !g.label ? (
              <div key={g.id}>{rows(g)}</div>
            ) : g.id === "done" ? (
              <details key={g.id} open={props.doneOpen} onToggle={(e) => props.onDoneOpen(e.currentTarget.open)}>
                <summary className="sticky top-0 z-[1] focus-visible:outline-offset-[-2px] [&:hover_h3]:bg-hover">
                  <h3 id={`g-${g.id}`} className={groupHead}>
                    {g.label}
                    <span className="font-medium text-muted-foreground">{g.rows.length}</span>
                    <ChevronRight aria-hidden className="rl-chev ml-auto size-[15px] text-muted-foreground" />
                  </h3>
                </summary>
                {rows(g)}
              </details>
            ) : (
              <section key={g.id} aria-labelledby={`g-${g.id}`}>
                <h3 id={`g-${g.id}`} className={cn(groupHead, "sticky top-0 z-[1]")}>
                  {g.label}
                  <span className="font-medium text-muted-foreground">{g.rows.length}</span>
                </h3>
                {rows(g)}
              </section>
            ),
          )
        ) : (
          !props.candidate && (
            <p className="m-0 px-4 py-8 text-ink-2">{props.query.trim() ? "No pull requests match this filter." : props.empty}</p>
          )
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
          <Kbd className={kbd}>/</Kbd> filter
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd className={kbd}>?</Kbd> all keys
        </span>
      </footer>
      <SharedHint hints={hints} />
    </section>
  );
}

const fullTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// An icon with words for screen readers and a tooltip with the same words.
function IconHint({ hints, label, icon: Icon }: { hints: Hints; label: string; icon: typeof User }) {
  return (
    <HintTrigger hints={hints} label={label}>
      <span role="img" aria-label={label} className="inline-flex shrink-0 text-muted-foreground">
        <Icon aria-hidden className="size-[15px]" />
      </span>
    </HintTrigger>
  );
}

// Memo: a key press renders the shell again, but a row changes only with its data or its selection.
const Row = memo(function Row({
  p,
  now,
  forge,
  hints,
  run,
  ready,
  selected,
  onSelect,
  onOpen,
  onRestore,
}: {
  p: PrRow;
  now: number;
  forge: string;
  hints: Hints;
  run: RunDto | undefined;
  ready: ReadyLine | undefined;
  selected: boolean;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
  onRestore: ((p: PrRow) => void) | null;
}) {
  const w = onRestore ? archiveWhy(p, now) : why(p, now);
  const time = run ? (run.finishedAt ?? run.startedAt) : p.lastActivity;
  const task = p.tasks[0];
  const incomplete = incompleteText(p.checkpoint, forge);
  const { verb } = restoreWords(p);
  return (
    <li className={cn(onRestore && "relative")}>
      <button
        type="button"
        id={`row-${p.id}`}
        data-row
        aria-current={selected ? "true" : undefined}
        className={cn(
          "@container/row grid w-full cursor-pointer gap-[3px] border-0 border-b bg-transparent px-4 py-(--row-y) text-left hover:bg-hover focus-visible:outline-offset-[-2px]",
          selected && "bg-sel hover:bg-sel",
        )}
        onClick={() => onSelect(p.id)}
        onDoubleClick={() => onOpen(p.id)}
      >
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span translate="no" title={prKey(p)} className="min-w-0 truncate font-mono">
            {prKey(p)}
          </span>
          {task && (
            <HintTrigger hints={hints} label={taskHint(task)}>
              <span translate="no" className="shrink-0 font-mono text-ink-2">
                {task.key}
              </span>
            </HintTrigger>
          )}
          {p.role === "AUTHOR" && <IconHint hints={hints} label="Your pull request" icon={User} />}
          {!p.followed && <IconHint hints={hints} label="Not followed" icon={BellOff} />}
          {incomplete && (
            <HintTrigger hints={hints} label={incomplete}>
              <span className="inline-flex min-w-0 items-center gap-[5px] text-destructive">
                <CircleAlert aria-hidden className="size-[15px] shrink-0" />
                <span className="truncate">Last check incomplete</span>
              </span>
            </HintTrigger>
          )}
          {/* docs/plans/thread-outcome.md section 11: a count only. Groups, views, and sort ignore it. The count never truncates, so a
              row of 416 px or less drops "reply" from the visible words. */}
          {p.staleDrafts > 0 && (
            <HintTrigger hints={hints} label="Open the pull request to update them.">
              <span data-stale-drafts className="inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap">
                <History aria-hidden className="size-[15px] shrink-0" />
                <span>
                  {p.staleDrafts}
                  <span className="@max-[26rem]/row:sr-only"> reply</span> {p.staleDrafts === 1 ? "draft" : "drafts"} out of date
                </span>
              </span>
            </HintTrigger>
          )}
          {/* docs/plans/ci-builds.md, Layer A: failed and running only. A passed build is the normal case. */}
          {(p.build?.state === "failed" || p.build?.state === "running") && (
            <HintTrigger hints={hints} label={buildHint(p.build)}>
              <span
                data-build={p.build.state}
                className={cn(
                  "inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap",
                  p.build.state === "failed" && "text-destructive",
                )}
              >
                {p.build.state === "failed" ? (
                  <CircleX aria-hidden className="size-[15px] shrink-0" />
                ) : (
                  <CircleDashed aria-hidden className="size-[15px] shrink-0" />
                )}
                <span>{BUILD_WORD[p.build.state]}</span>
              </span>
            </HintTrigger>
          )}
          <HintTrigger
            hints={hints}
            label={run ? `Run ${run.status === "running" ? "started" : "ended"} ${fullTime(time)}` : fullTime(time)}
          >
            <time dateTime={new Date(time).toISOString()} className="ml-auto shrink-0 whitespace-nowrap">
              {ago(time, now)}
            </time>
          </HintTrigger>
        </span>
        {p.title === null ? (
          <span className="min-w-0 truncate text-muted-foreground italic">Loading details…</span>
        ) : (
          <span title={p.title} className="min-w-0 truncate font-semibold">
            {p.title}
          </span>
        )}
        {ready ? (
          <span className="min-w-0 truncate text-sm text-ink-2">
            {ready.posts && (
              <>
                <b className="font-semibold text-foreground">Ready:</b> {ready.posts}
              </>
            )}
            {ready.posts && ready.blocked && " · "}
            {ready.blocked}
          </span>
        ) : run ? (
          <RunWhyLine run={run} />
        ) : (
          // The Restore button sits over the end of this line.
          <span className={cn("flex min-w-0 items-baseline gap-2 text-sm text-ink-2", onRestore && "pr-24")}>
            {w.closed && <b className="shrink-0 font-semibold text-foreground">{w.closed}</b>}
            {w.turn?.kind === "your" && (
              <span className="inline-flex shrink-0 items-center gap-1.5 self-center font-semibold whitespace-nowrap text-turn">
                <Reply aria-hidden className="size-[15px]" />
                {w.turn.text}
              </span>
            )}
            {w.turn?.kind === "wait" && (
              <span className="inline-flex self-center">
                <IconHint hints={hints} label={w.turn.text} icon={Hourglass} />
              </span>
            )}
            {(w.lead || w.text) && (
              <span className="min-w-0 truncate">
                {w.lead && <b className="font-semibold text-foreground">{w.lead}</b>}
                {w.lead && w.text && " "}
                {w.text}
              </span>
            )}
            {p.unread > 0 && !onRestore && (
              <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 self-center text-xs font-semibold whitespace-nowrap text-foreground">
                <span aria-hidden className="size-[7px] rounded-full bg-foreground" />
                {p.unread} new
              </span>
            )}
          </span>
        )}
      </button>
      {onRestore && (
        // A sibling of the row button: a button never holds another one.
        <Button
          variant="outline"
          size="xs"
          aria-label={`${verb} ${prKey(p)}`}
          className="absolute right-4 bottom-[calc(var(--row-y)-2px)]"
          onClick={() => onRestore(p)}
        >
          <ArchiveRestore aria-hidden data-icon="inline-start" />
          {verb}
        </Button>
      )}
    </li>
  );
});

// prototype/v3 whyRun: the state, the findings, the profile, and the outcome of the newest run.
// The chip is a word. An error adds an icon and the error hue.
function RunWhyLine({ run }: { run: RunDto }) {
  const w = runWhy(run);
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm text-ink-2">
      <Badge
        variant={w.error ? "destructive" : "quiet"}
        data-run-chip={run.status}
        className="h-auto rounded-sm px-1.5 py-0 text-[11px] font-semibold"
      >
        {w.error ? <CircleAlert aria-hidden /> : run.status === "running" ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
        {w.chip}
      </Badge>
      <span className="shrink-0 font-medium whitespace-nowrap text-foreground">{w.count}</span>
      <span className="min-w-0 truncate">
        {w.lead && <b className="font-semibold text-foreground">{w.lead}</b>}
        {w.lead && w.text && " "}
        {w.text}
      </span>
    </span>
  );
}

function SkeletonRows() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading pull requests">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="grid gap-2 border-b px-4 py-3">
          <Skeleton className="h-3 w-2/5" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      ))}
    </div>
  );
}
