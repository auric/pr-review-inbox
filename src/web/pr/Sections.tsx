// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Description, Files, and Commits of the detail pane (prototype/v3 overview, filesSec, commitsSec; pr-view-v4 2.5).
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  File,
  FileDiff,
  FileMinus,
  FilePlus,
  FileSymlink,
  LoaderCircle,
  type LucideIcon,
  MessageSquare,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import type { ChangedFile, CommitDto, PrDetail } from "../../shared/dto";
import { isMe } from "../../shared/me";
import type { Hints } from "../shell/Hint";
import { HintTrigger } from "../shell/Hint";
import { ago } from "../shell/model";
import { CheckBanner } from "../states";
import { fullTime, Text } from "./Thread";
import type { ThreadModel } from "./threads";
import { DescribePanel, WriteDescriptionButton } from "./WriteDescription";

export const STATUS_TEXT: Record<string, string> = { APPROVED: "Approved", NEEDS_WORK: "Needs work", UNAPPROVED: "Not reviewed" };

const h2 = "m-0 flex items-baseline gap-2 text-[15px] font-bold tracking-[-0.005em]";
const linkish = "rl-hit inline-flex w-fit items-center gap-1 rounded text-sm font-medium text-pen hover:underline";

// Plan pr-view-v4 2.5: the author's text, the reviewers, and the notices. The runner's summary is in the run record.
// describe: the props of Write description. It shows on an own open PR only.
export function Description(props: {
  detail: PrDetail;
  me: string | null;
  describe?: { runner: string; forge: string; announce: (text: string) => void };
}) {
  const { detail, me } = props;
  const { pr, description } = detail;
  const describe = pr.role === "AUTHOR" && pr.state === "OPEN" ? props.describe : undefined;
  const [more, setMore] = useState(false);
  const text = description?.trim() ?? "";
  const blocks = text.split(/\n\s*\n/);
  const long = blocks.length > 1;
  return (
    // minmax(0, 1fr): a long word must not widen the column past the pane.
    <section
      id="s-overview"
      aria-labelledby="h-desc"
      className="grid max-w-[86ch] scroll-mt-3 grid-cols-[minmax(0,1fr)] justify-items-start gap-2.5 pt-6"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="h-desc" className={h2}>
          Description
        </h2>
        {describe && <WriteDescriptionButton pr={pr.id} {...describe} />}
      </div>
      {!pr.followed && (
        <p className="m-0 text-muted-foreground">Not followed. PR Review Inbox does not check this pull request for new comments.</p>
      )}
      <div id="desc" className="max-w-[72ch] [overflow-wrap:anywhere]">
        {text ? <Text text={long && !more ? (blocks[0] ?? text) : text} /> : <p className="m-0 text-muted-foreground">No description.</p>}
      </div>
      {long && (
        <button
          type="button"
          className={`${linkish} cursor-pointer`}
          aria-expanded={more}
          aria-controls="desc"
          onClick={() => setMore(!more)}
        >
          {more ? "Show less" : "Show more"}
        </button>
      )}
      {describe && <DescribePanel pr={pr.id} {...describe} />}
      <CheckBanner checkpoint={pr.checkpoint} />
      {pr.reviewers.length > 0 && (
        <dl className="m-0 mt-1.5 grid max-w-[72ch] grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-2">
          <dt className="pt-px text-sm text-muted-foreground">Reviewers</dt>
          <dd className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            {pr.reviewers.map((r) => (
              <span key={r.slug} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
                {isMe(r, me) ? "You" : r.name}
                {r.status === "APPROVED" ? (
                  <span className="inline-flex items-center gap-1 self-center text-sm text-ok">
                    <Check aria-hidden className="size-[14px]" />
                    {STATUS_TEXT[r.status]}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">{STATUS_TEXT[r.status] ?? r.status}</span>
                )}
              </span>
            ))}
          </dd>
        </dl>
      )}
    </section>
  );
}

function DiffLink({ web, forge }: { web: string; forge: string }) {
  return (
    <a className={linkish} href={`${web}/diff`} target="_blank" rel="noopener noreferrer">
      <ExternalLink aria-hidden className="size-[15px]" />
      Open the diff in {forge}
    </a>
  );
}

// Files and Commits start closed. The detail keeps them open across renders. wide: the fold takes the full pane width, for code.
export function Fold({
  id,
  head,
  open,
  onOpen,
  wide,
  children,
}: {
  id: string;
  head: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      id={`s-${id}`}
      open={open}
      onToggle={(e) => onOpen(e.currentTarget.open)}
      className={cn("scroll-mt-3 pt-6 open:pb-3", !wide && "max-w-[86ch]")}
    >
      {/* The cap keeps the chevron of a wide fold in the chevron column of the 86ch sections. */}
      <summary id={`s-${id}-sum`} className="mr-8 -ml-1.5 max-w-[calc(86ch-1.625rem)] rounded hover:bg-hover">
        <h2 className={`${h2} items-center px-1.5 py-1`}>
          {head}
          <ChevronRight aria-hidden className="rl-chev ml-auto size-[15px] text-muted-foreground" />
        </h2>
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

const CHANGE: Record<string, [LucideIcon, string]> = {
  ADD: [FilePlus, "Added"],
  MODIFY: [FileDiff, "Modified"],
  DELETE: [FileMinus, "Deleted"],
  MOVE: [FileSymlink, "Moved"],
  COPY: [Copy, "Copied"],
};

const icon = "size-[15px] shrink-0";

export function Err({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1.5 text-destructive">
      <CircleAlert aria-hidden className={cn(icon, "mt-0.5")} />
      <span>{children}</span>
    </span>
  );
}

// Plan r2 UI-DIFF: every loaded PR has Files. n: the file count, null while no list is known. stat: "+a −d" once the code is there.
// children: the file list.
export function FilesFold(props: {
  n: number | null;
  stat: string | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  web: string | null;
  forge: string;
  children: ReactNode;
}) {
  return (
    <Fold
      id="files"
      wide
      open={props.open}
      onOpen={props.onOpen}
      head={
        <>
          <FoldHead label="Files" n={props.n === null ? "" : `${props.n}`} />
          {props.stat && <span className="font-mono text-xs font-normal text-muted-foreground">{props.stat}</span>}
        </>
      }
    >
      {props.children}
      {props.web && <DiffLink web={props.web} forge={props.forge} />}
    </Fold>
  );
}

// One file row (plan pr-view-v4 2.9). The whole row is the button that opens the diff under it, so every file has an action.
// The open row sticks under the action bar: the list sets --rl-bar to the bar height. busy: the row waits for the code.
export function FileRowButton(props: {
  id: string;
  path: string;
  icon: LucideIcon;
  word: string;
  threads: number;
  open: boolean;
  controls?: string;
  busy?: boolean;
  stat?: string;
  hints: Hints;
  onClick: () => void;
}) {
  const { path, word, threads, icon: Icon } = props;
  const cut = path.lastIndexOf("/") + 1;
  return (
    <button
      id={props.id}
      type="button"
      aria-expanded={props.open}
      aria-controls={props.controls}
      aria-busy={props.busy || undefined}
      onClick={props.onClick}
      className={cn(
        "grid w-full cursor-pointer grid-cols-[15px_15px_minmax(0,1fr)_auto_auto] items-center gap-2 border-b px-1.5 py-1.5 text-left text-sm hover:bg-hover",
        props.open && "sticky top-[var(--rl-bar,0px)] z-[2] bg-sunken",
      )}
    >
      <ChevronRight aria-hidden className={cn("rl-chev text-muted-foreground", icon)} />
      <HintTrigger hints={props.hints} label={word}>
        <span className="inline-flex text-muted-foreground">
          <Icon aria-hidden className={icon} />
        </span>
      </HintTrigger>
      <span translate="no" className="min-w-0 font-mono [overflow-wrap:anywhere]">
        <span className="text-muted-foreground">{path.slice(0, cut)}</span>
        {path.slice(cut)}
      </span>
      <span className="sr-only">. {word}.</span>
      {threads > 0 ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <MessageSquare aria-hidden className={icon} />
          {threads}
          <span className="sr-only">{threads === 1 ? " thread" : " threads"}</span>
        </span>
      ) : (
        <span />
      )}
      {props.busy ? (
        <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
          <LoaderCircle aria-hidden className={cn(icon, "animate-spin motion-reduce:animate-none")} />
          Getting the code
        </span>
      ) : (
        <span className="min-w-[9ch] text-right font-mono text-xs whitespace-nowrap text-muted-foreground">{props.stat}</span>
      )}
    </button>
  );
}

// The forge file list. It shows until the git index of the diff viewer loads. A row click gets the code, then opens the file.
// busy: the path of the row that waits for the code. error: the path and the error text of the row whose fetch failed.
export function ForgeFiles(props: {
  files: ChangedFile[];
  threads: ThreadModel[];
  hints: Hints;
  busy: string | null;
  error: { path: string; text: string } | null;
  onOpen: (path: string) => void;
}) {
  return (
    <ul aria-label="Changed files" className="m-0 mb-2.5 max-w-[86ch] list-none border-t p-0">
      {props.files.map((f, i) => {
        const [Icon, type] = CHANGE[f.type] ?? [File, "Changed"];
        const failed = props.error?.path === f.path ? props.error.text : null;
        return (
          <li key={f.path}>
            <FileRowButton
              id={`ff-${i}`}
              path={f.path}
              icon={Icon}
              word={f.srcPath ? `${type} from ${f.srcPath}` : type}
              threads={props.threads.filter((t) => t.anchor?.path === f.path).length}
              open={false}
              busy={props.busy === f.path}
              hints={props.hints}
              onClick={() => props.onOpen(f.path)}
            />
            {failed !== null && (
              // The same columns as the row, so the text starts under the path.
              <p className="m-0 grid grid-cols-[15px_15px_minmax(0,1fr)] gap-2 border-b px-1.5 py-1.5 text-sm">
                <span className="col-start-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Err>Cannot get the code. {failed}</Err>
                  <button
                    type="button"
                    className={cn(linkish, "cursor-pointer")}
                    onClick={() => {
                      // The retry removes this line, so the focus goes to the row that shows the progress.
                      document.getElementById(`ff-${i}`)?.focus();
                      props.onOpen(f.path);
                    }}
                  >
                    Try again
                  </button>
                </span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function FoldHead({ label, n }: { label: string; n: string }) {
  return (
    <>
      {label}
      <span className="text-sm font-medium text-muted-foreground">{n}</span>
    </>
  );
}

// The mark sits above the commit that my last review covered. Newer commits are new since that review.
export function CommitsFold(props: {
  commits: CommitDto[];
  detail: PrDetail;
  me: string | null;
  open: boolean;
  onOpen: (open: boolean) => void;
  now: number;
  hints: Hints;
}) {
  const mine = props.detail.pr.reviewers.find((r) => isMe(r, props.me));
  const at = mine?.lastReviewedCommit ? props.commits.findIndex((c) => c.hash === mine.lastReviewedCommit) : -1;
  const n = props.commits.length;
  return (
    <Fold
      id="commits"
      open={props.open}
      onOpen={props.onOpen}
      head={<FoldHead label="Commits" n={at > 0 ? `${n}, ${at} since your review` : `${n}`} />}
    >
      <ul className="m-0 list-none p-0">
        {props.commits.map((c, i) => (
          <Fragment key={c.hash}>
            {i === at && mine && (
              <li className="border-b pt-3.5 pb-1.5 text-xs text-muted-foreground">
                Your review ({(STATUS_TEXT[mine.status] ?? mine.status).toLowerCase()}) covered the commits below.
              </li>
            )}
            <li className="grid grid-cols-[9ch_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b py-[7px]">
              <span translate="no" className="font-mono text-xs text-ink-2">
                {c.hash.slice(0, 7)}
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {c.message.split("\n")[0]}
                {i < at && <span className="sr-only"> (new since your review)</span>}
              </span>
              <span className="text-xs whitespace-nowrap text-muted-foreground">
                {c.author},{" "}
                <HintTrigger hints={props.hints} label={fullTime(c.at)}>
                  <time dateTime={new Date(c.at).toISOString()}>{ago(c.at, props.now)}</time>
                </HintTrigger>
              </span>
            </li>
          </Fragment>
        ))}
      </ul>
    </Fold>
  );
}
