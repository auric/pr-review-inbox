// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Explain page in the detail pane (docs/plans/review-v2/spec.md sections 3.1 and 3.5): one status sentence with one primary
// button, then the walkthrough at reading width: the summary, the reading order, the walkthrough with its diagrams and diff links,
// the risks on their code, the files with their roles, and the words used. Opening the page starts no run (AC-X7).
import {
  ArrowLeft,
  Braces,
  CircleAlert,
  CircleStop,
  ClipboardCopy,
  Ellipsis,
  FileCode,
  History,
  LoaderCircle,
  MessageCircleQuestionMark,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { MetaDto, PrRow, RunDto } from "../../shared/dto";
import { plural } from "../../shared/outcome";
import type { ExplainResult } from "../../shared/review";
import type { FileRef } from "../lib/route";
import { Markdown } from "../pr/Markdown";
import { agoLong } from "../pr/threads";
import { Inline } from "../review/Drafts";
import { useBrief, useCancelRun } from "../review/data";
import { notChecked } from "../review/model";
import { useSlots } from "../review/useSlots";
import { Hint } from "../shell/Hint";
import { failText, prKey } from "../shell/model";
import { useNow } from "../shell/Sidebar";
import { useExplain, useStartExplain } from "./data";
import { linesText, parseDiffLink, placeText, riskLink } from "./links";
import { type ExplainView, explainMarkdown, explainProfiles, explainView, headText, ROLE_LABEL, soFar } from "./model";

const icon = "size-[15px] shrink-0";
const linkish =
  "rl-hit inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline disabled:cursor-default disabled:opacity-60";
const h2 = "m-0 mb-2.5 text-[15px] font-bold tracking-[-0.005em]";
// Reading width for the text parts. Lists and tables can use the same width.
const measure = "max-w-[72ch]";

// The clock of a running run. It sits outside the live region: a screen reader reads the region again on each tick of a clock in it.
function SoFar({ from }: { from: number }) {
  return <span className="text-sm text-muted-foreground">{soFar(from, useNow(true))}</span>;
}

// A repository path: the folder muted, the file name in the text color. Long paths break anywhere.
function PathText({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return (
    <span translate="no" className="font-mono text-[0.92em] [overflow-wrap:anywhere]">
      <span className="text-muted-foreground">{path.slice(0, cut)}</span>
      <span className="font-semibold text-foreground">{path.slice(cut)}</span>
    </span>
  );
}

// A path that opens its file in the Files diff of the PR.
function PathButton({ path, onDiff }: { path: string; onDiff: (to: FileRef) => void }) {
  return (
    <button
      type="button"
      data-explain-path={path}
      className="rl-hit min-w-0 cursor-pointer rounded text-left underline-offset-3 hover:underline"
      aria-label={`${path}. Open it in the Files diff.`}
      onClick={() => onDiff({ path, line: null, side: "new" })}
    >
      <PathText path={path} />
    </button>
  );
}

export function ExplainPage(props: {
  pr: PrRow;
  meta: MetaDto;
  now: number;
  announce: (text: string) => void;
  // Back to the PR: the browser Back, or the PR itself when the page is the first entry of the app.
  onBack: () => void;
  // Opens the Files diff of the PR at a file or a line and pushes a history entry (spec.md section 3.1). Pass a stable function.
  onDiff: (to: FileRef) => void;
  onLog: (run: number, raw?: boolean) => void;
  // Back to the PR at its drafts.
  onDrafts: () => void;
}) {
  const { pr, meta, announce, onDiff } = props;
  const runner = meta.runner.short;
  const q = useExplain(pr.id);
  // The start button waits while busy is set.
  const { note: busy, refused } = useSlots(pr.id, runner);
  const brief = useBrief(pr.id).data;
  const start = useStartExplain(pr.id);
  const cancel = useCancelRun();
  const v = explainView(q.data, runner);
  const profiles = explainProfiles(meta.profiles, brief?.profile, v.shown?.run.profile ?? v.run?.profile);
  const [chosen, setChosen] = useState<string | null>(null);
  const pick = chosen !== null && profiles.list.some((p) => p.id === chosen) ? chosen : profiles.pick;
  const picker = profiles.list.length >= 2;
  const title = pr.title ?? prKey(pr);
  const head = useRef<HTMLHeadingElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  // docs/plans/review-v2/spec.md section 7.1 (AC-UX10): focus moves to the new primary button, else to the page heading. It moves
  // when the page opens, and after a state change only when the focus was in the status box or got lost with a removed button.
  const kind = q.data === undefined ? null : v.kind;
  const seen = useRef<typeof kind | "mount">("mount");
  useLayoutEffect(() => {
    if (kind === null || seen.current === kind) return;
    const first = seen.current === "mount";
    seen.current = kind;
    const a = document.activeElement;
    const lost = !a || a === document.body || !a.isConnected || !!box.current?.contains(a);
    if (first || lost) (primary.current ?? head.current)?.focus({ preventScroll: true });
  }, [kind]);

  const begin = () => {
    if (start.isPending) return;
    if (busy) return void toast.add({ title: "The walkthrough did not start", description: busy });
    start.mutate(picker ? pick : null, {
      onSuccess: (r) => {
        if ("conflict" in r) {
          toast.add({ title: "The walkthrough did not start", description: refused(r.conflict) });
          return;
        }
        if (r.run.status === "running") announce(`${runner} is reading the change.`);
      },
      onError: (e) => toast.add({ title: "The walkthrough did not start", description: failText(e) }),
    });
  };
  const copy = () => {
    const s = v.shown;
    if (!s) return;
    void copyText(explainMarkdown(s.result, title, s.run)).then((ok) =>
      ok
        ? announce("Copied the walkthrough as Markdown.")
        : toast.add({ title: "The clipboard is blocked here. Select the text of the page and press Ctrl+C." }),
    );
  };
  const links = useCallback(
    (href: string) => {
      const l = parseDiffLink(href);
      return l ? () => onDiff({ path: l.path, line: l.line, side: l.side }) : null;
    },
    [onDiff],
  );

  return (
    <div data-explain className="pb-16">
      <div className="sticky top-0 z-[3] flex items-center gap-3 border-b bg-pane px-6 py-2 max-[759px]:px-4">
        <Hint label="Back to the pull request. Key: Esc">
          <Button
            id="explain-back"
            variant="ghost"
            size="sm"
            className="-ml-2 text-ink-2"
            aria-keyshortcuts="Escape"
            onClick={props.onBack}
          >
            <ArrowLeft aria-hidden data-icon="inline-start" />
            Back to the pull request
          </Button>
        </Hint>
        <DropdownMenu modal={false}>
          <Hint label="More actions">
            <DropdownMenuTrigger
              render={<Button id="explain-more" variant="ghost" size="icon-sm" aria-label="More actions" className="ml-auto text-ink-2" />}
            >
              <Ellipsis aria-hidden />
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!v.shown} onClick={copy}>
                <ClipboardCopy aria-hidden />
                Copy as Markdown
              </DropdownMenuItem>
              {v.run && (
                <DropdownMenuItem onClick={() => props.onLog((v.run as RunDto).id)}>
                  <ScrollText aria-hidden />
                  Show the run log
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="grid gap-7 px-6 pt-4 max-[759px]:px-4">
        <header className="grid gap-1.5">
          <span translate="no" className="font-mono text-xs text-ink-2">
            {prKey(pr)}
          </span>
          <h1
            ref={head}
            id="explain-h"
            tabIndex={-1}
            className="m-0 text-(length:--fs-title) leading-tight font-bold tracking-[-0.015em] text-balance outline-none [overflow-wrap:anywhere]"
          >
            <span className="sr-only">Walkthrough: </span>
            {title}
          </h1>
          {v.shown && <Byline run={v.shown.run} runner={runner} now={props.now} />}
        </header>
        {q.isPending ? (
          <div role="status" aria-busy="true" aria-label="Loading the walkthrough" className={cn("grid gap-3", measure)}>
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : q.error ? (
          <div className={cn("grid justify-items-start gap-2", measure)}>
            <p role="alert" className="m-0 flex items-start gap-1.5 text-sm text-destructive">
              <CircleAlert aria-hidden className={cn(icon, "mt-0.5")} />
              <span>Cannot load the walkthrough. {q.error.message}</span>
            </p>
            <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
              Load again
            </Button>
          </div>
        ) : (
          <>
            {v.sentence !== null && (
              <Status
                v={v}
                boxRef={box}
                primaryRef={primary}
                starting={start.isPending}
                busy={busy}
                cancelling={cancel.isPending}
                onStart={begin}
                onCancel={(id) => cancel.mutate(id, { onError: (e) => toast.add({ title: "Cancel failed", description: failText(e) }) })}
                onLog={props.onLog}
                picker={
                  picker && v.primary !== null ? (
                    <ToggleGroup
                      aria-label="Profile"
                      variant="outline"
                      size="sm"
                      spacing={0}
                      className="flex-wrap"
                      value={pick ? [pick] : []}
                      onValueChange={(x) => x[0] && setChosen(x[0])}
                    >
                      {profiles.list.map((p) => (
                        <ToggleGroupItem
                          key={p.id}
                          value={p.id}
                          className="aria-pressed:bg-foreground aria-pressed:font-semibold aria-pressed:text-background"
                        >
                          {p.name}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  ) : null
                }
              />
            )}
            {v.shown && <Walk result={v.shown.result} runner={runner} links={links} onDiff={onDiff} onDrafts={props.onDrafts} />}
          </>
        )}
      </div>
    </div>
  );
}

function Byline({ run, runner, now }: { run: RunDto; runner: string; now: number }) {
  const at = run.finishedAt ?? run.startedAt;
  return (
    <p className="m-0 text-sm text-ink-2">
      Walkthrough by {runner} with the {run.profileName} profile.{" "}
      <span translate="no">
        {headText(run)}, <time dateTime={new Date(at).toISOString()}>{agoLong(at, now)}</time>.
      </span>
    </p>
  );
}

const STATUS_ICON: Partial<Record<ExplainView["kind"], ReactNode>> = {
  running: <LoaderCircle aria-hidden className={cn(icon, "mt-0.5 animate-spin motion-reduce:animate-none")} />,
  failed: <CircleAlert aria-hidden className={cn(icon, "mt-0.5 text-destructive")} />,
  cancelled: <CircleStop aria-hidden className={cn(icon, "mt-0.5")} />,
  stale: <History aria-hidden className={cn(icon, "mt-0.5 text-warn")} />,
};

// The status box: one sentence that names the actor or the wait (spec.md section 7.1, AC-UX3), the one primary button (AC-UX1),
// and the run actions. The sentence is a polite live region.
function Status(props: {
  v: ExplainView;
  boxRef: RefObject<HTMLDivElement | null>;
  primaryRef: RefObject<HTMLButtonElement | null>;
  starting: boolean;
  // The run-slot note (W1 or W2) of useSlots, or null.
  busy: string | null;
  cancelling: boolean;
  picker: ReactNode;
  onStart: () => void;
  onCancel: (run: number) => void;
  onLog: (run: number, raw?: boolean) => void;
}) {
  const { v } = props;
  const run = v.run;
  return (
    <div
      ref={props.boxRef}
      data-explain-state={v.kind}
      className={cn("grid justify-items-start gap-2.5 rounded-lg border border-rule-strong px-4 py-3", measure)}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p
          role="status"
          className={cn("m-0 flex items-start gap-1.5 text-sm", v.kind === "failed" ? "text-destructive" : "text-foreground")}
        >
          {STATUS_ICON[v.kind]}
          <span key={v.kind} className="rl-fade">
            {v.sentence}
          </span>
        </p>
        {v.kind === "running" && run && <SoFar from={run.startedAt} />}
      </div>
      {v.shown && v.kind !== "stale" && (
        <p className="m-0 text-xs text-muted-foreground">The walkthrough below is from an earlier run. {headText(v.shown.run)}.</p>
      )}
      {(v.primary !== null || props.picker || run) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {v.primary !== null && (
            <Button
              ref={props.primaryRef}
              id="explain-start"
              size="sm"
              data-primary
              disabled={props.starting || !!props.busy}
              focusableWhenDisabled
              className="aria-disabled:cursor-default aria-disabled:opacity-50"
              aria-describedby={props.busy ? "explain-busy" : undefined}
              onClick={props.onStart}
            >
              {props.starting && <LoaderCircle aria-hidden data-icon="inline-start" className="animate-spin motion-reduce:animate-none" />}
              {v.primary}
            </Button>
          )}
          {props.picker}
          {run && v.kind === "running" && (
            <button type="button" className={linkish} disabled={props.cancelling} onClick={() => props.onCancel(run.id)}>
              {props.cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {run && v.kind === "failed" && run.hasRaw && (
            <button type="button" className={linkish} onClick={() => props.onLog(run.id, true)}>
              <Braces aria-hidden className={icon} />
              Show raw output
            </button>
          )}
          {run && (
            <button type="button" className={linkish} onClick={() => props.onLog(run.id)}>
              <ScrollText aria-hidden className={icon} />
              Log
            </button>
          )}
        </div>
      )}
      {v.primary !== null && props.busy && (
        <p id="explain-busy" className="m-0 text-xs text-muted-foreground">
          {props.busy}
        </p>
      )}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} className={measure}>
      <h2 id={`${id}-h`} className={h2}>
        {title}
      </h2>
      {children}
    </section>
  );
}

// The walkthrough in the order of spec.md section 3.1. Each part shows only when the run gave it.
function Walk(props: {
  result: ExplainResult;
  runner: string;
  links: (href: string) => (() => void) | null;
  onDiff: (to: FileRef) => void;
  onDrafts: () => void;
}) {
  const { result: r, onDiff } = props;
  const gaps = notChecked(r.coverage);
  return (
    <>
      <p data-explain-summary className={cn("m-0 text-[1.08em] leading-relaxed text-foreground [overflow-wrap:anywhere]", measure)}>
        <Inline text={r.summary} />
      </p>
      {r.order.length > 0 && (
        <Section id="ex-order" title="Read in this order">
          <ol className="m-0 grid list-none gap-3 border-l-[3px] border-foreground p-0 pl-3.5">
            {r.order.map((o, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the reading order keeps its order, and a path can come twice.
              <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-1.5 gap-y-0.5 text-sm">
                <span className="font-mono text-xs leading-6 text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="grid justify-items-start gap-0.5">
                  <PathButton path={o.path} onDiff={onDiff} />
                  <span className="text-ink-2 [overflow-wrap:anywhere]">
                    <Inline text={o.why} />
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {r.walkthrough.trim() && (
        <Section id="ex-walk" title="Walkthrough">
          <div className="rl-read [overflow-wrap:anywhere]">
            <Markdown text={r.walkthrough} diagrams links={props.links} />
          </div>
        </Section>
      )}
      {r.risks.length > 0 && (
        <Section id="ex-risks" title="Risks">
          <ul className="m-0 grid list-none gap-2.5 p-0">
            {r.risks.map((x, i) => {
              const l = riskLink(x);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the risks keep their order.
                <li key={i} data-explain-risk className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-sm">
                  <TriangleAlert aria-hidden className={cn(icon, "mt-0.5 text-warn")} />
                  <span className="[overflow-wrap:anywhere]">
                    <Inline text={x.text} />
                  </span>
                  {l && (
                    <button
                      type="button"
                      data-risk-link
                      className={cn(linkish, "col-start-2 justify-self-start font-normal")}
                      aria-label={`Open ${l.path}, ${linesText(l)}, in the Files diff`}
                      onClick={() => onDiff({ path: l.path, line: l.line, side: l.side })}
                    >
                      <FileCode aria-hidden className={icon} />
                      <span translate="no">{placeText(l)}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {r.files.length > 0 && (
        <Section id="ex-files" title="Files">
          <ul className="m-0 grid list-none gap-2 p-0">
            {r.files.map((f) => (
              <li key={f.path} data-explain-file={f.role} className="grid gap-0.5 text-sm">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Badge variant="quiet">{ROLE_LABEL[f.role]}</Badge>
                  <PathButton path={f.path} onDiff={onDiff} />
                </span>
                {f.summary && (
                  <span className="text-ink-2 [overflow-wrap:anywhere]">
                    <Inline text={f.summary} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {r.glossary.length > 0 && (
        <Section id="ex-words" title="Words used">
          <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm @min-[560px]/detail:grid-cols-[minmax(0,max-content)_minmax(0,1fr)]">
            {r.glossary.map((g) => (
              <div key={g.term} className="contents">
                <dt className="font-semibold [overflow-wrap:anywhere] @min-[560px]/detail:max-w-[18rem]">{g.term}</dt>
                <dd className="m-0 mb-1 text-ink-2 [overflow-wrap:anywhere] @min-[560px]/detail:mb-0">{g.meaning}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {r.questions.length > 0 && (
        <p className={cn("m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2", measure)}>
          <span className="inline-flex items-start gap-1.5">
            <MessageCircleQuestionMark aria-hidden className={cn(icon, "mt-0.5")} />
            {props.runner} asked {plural(r.questions.length, "question")} for the author. They wait in Drafts, marked From Explain.
          </span>
          <button type="button" className={linkish} onClick={props.onDrafts}>
            Go to the drafts
          </button>
        </p>
      )}
      {gaps.n > 0 && (
        <details className={cn("text-sm", measure)}>
          <summary className="rl-hit inline-flex cursor-pointer rounded font-medium text-warn hover:underline">
            <TriangleAlert aria-hidden className={cn(icon, "mt-0.5 mr-1.5")} />
            {gaps.label}
          </summary>
          <ul className="m-0 mt-1.5 grid list-disc gap-1 pl-5 text-ink-2">
            {gaps.lines.map((l) => (
              <li key={l} className="[overflow-wrap:anywhere]">
                {l}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
