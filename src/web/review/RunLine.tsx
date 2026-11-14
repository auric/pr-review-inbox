// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Run record (plan pr-view-v4 2.6, prototype/pr-view-v4 reviewRecord): the newest run of each kind in one block with an ink rule.
// The review comes first: its result, the summary, a ledger of the open drafts, and what it read and did not check.
// Every other kind is one line. Each row opens "Not checked" and "Run setup" in place. Only Log opens the run log.
// Failed, usage-limit, and cancelled runs are one line each. A re-review names its range (plan r2 UI-RR).
import { Braces, Check, ChevronRight, CircleAlert, CircleStop, LoaderCircle, ScrollText, TriangleAlert, Undo2 } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MetaDto, ReviewItemDto, RunDto } from "../../shared/dto";
import type { FindingPayload } from "../../shared/review";
import { fullTime, useSettled } from "../pr/Thread";
import { agoLong, snippet } from "../pr/threads";
import { Hint } from "../shell/Hint";
import { useNow } from "../shell/Sidebar";
import { AiAvatar, Dotted, Dropped, Inline, Severity } from "./Drafts";
import {
  answeredQuestions,
  checkFailedText,
  checkText,
  clockDur,
  draftTitle,
  hiddenParts,
  instructionsText,
  KIND_LABEL,
  type LedgerPart,
  limitText,
  lineText,
  notChecked,
  phaseParts,
  plural,
  type RunLineState,
  runningText,
  setupText,
  shortHash,
  skillsText,
} from "./model";
import { sizeText } from "./tasks";

const icon = "size-[15px] shrink-0";
const linkish =
  "rl-hit inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline disabled:cursor-default disabled:opacity-60";

function Elapsed({ from }: { from: number }) {
  const now = useNow(true);
  return <span>{clockDur(Math.max(0, now - from) / 1000)}</span>;
}

// Parts of one line, joined by a dot that screen readers skip. The no-break space keeps each dot at the end of a line.
// The parts must stay inline boxes: an inline-flex part lets the line break before its dot.
function Joined({ parts }: { parts: ReactNode[] }) {
  return parts.filter(Boolean).map((p, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts keep their order.
    <Fragment key={i}>
      {i > 0 && (
        <>
          <span aria-hidden className="text-muted-foreground">
            {" ·"}
          </span>{" "}
        </>
      )}
      {p}
    </Fragment>
  ));
}

const Hash = ({ h }: { h: string }) => (
  <code translate="no" className="font-mono text-[0.95em] text-foreground">
    {h}
  </code>
);

function Err({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1.5 text-destructive">
      <CircleAlert aria-hidden className={cn(icon, "mt-0.5")} />
      <span>{children}</span>
    </span>
  );
}

// The outer span is a live region that stays, so a screen reader reads each later state. The key gives each state a new node.
// full: the state takes its own line. quiet: no live region.
export function RunStatus({ state, full, quiet, children }: { state: string; full?: boolean; quiet?: boolean; children: ReactNode }) {
  return (
    <span role={quiet ? undefined : "status"} className={full ? "rl-full" : "inline-flex"}>
      <span key={state} className="rl-fade inline-flex items-center gap-1.5">
        {children}
      </span>
    </span>
  );
}

// The open drafts of the newest review run in plain words (docs/plans/review-v2/design.md section 8). Each part goes to its first draft.
const GO_TO: Record<LedgerPart["key"], string> = {
  must: "Go to the first must-fix draft",
  worth: "Go to the first worth-fixing draft",
  polish: "Go to the first polish draft",
  fold: "Open the fold and go to its first draft",
  questions: "Go to the first question",
};
export function Ledger({ parts, onDraft }: { parts: LedgerPart[]; onDraft: (draft: number) => void }) {
  if (!parts.length) return null;
  const btn = "rl-hit group inline-flex cursor-pointer items-baseline gap-1.5 rounded";
  const big = "text-[18px] leading-none font-bold tracking-[-0.01em] text-foreground";
  const word = "text-ink-2 underline-offset-3 group-hover:underline";
  return (
    <ul aria-label="Open drafts" className="m-0 flex list-none flex-wrap items-center gap-x-[18px] gap-y-1.5 p-0 text-sm">
      {parts.map((p) => (
        <li key={p.key}>
          <Hint label={GO_TO[p.key]}>
            <button type="button" data-ledger={p.key} className={btn} onClick={() => onDraft(p.first)}>
              <span className={big}>{p.n}</span> <span className={word}>{p.word}</span>
            </button>
          </Hint>
        </li>
      ))}
    </ul>
  );
}

// docs/plans/review-v2/spec.md section 1.1: the refuted and duplicate findings of the newest review run, each with its reason and
// Restore. A restore moves the focus to the draft in the Drafts list (useTriage advance).
export function Refuted({
  hidden,
  busy,
  onRestore,
}: {
  hidden: ReviewItemDto[];
  busy: ReadonlySet<number>;
  onRestore: (it: ReviewItemDto) => void;
}) {
  const [on, setOn] = useState(false);
  const parts = hiddenParts(hidden);
  if (!parts.length) return null;
  return (
    <div className="grid gap-1.5" data-refuted>
      <div>
        <Disc on={on} controls="rv-refuted" onClick={() => setOn(!on)}>
          <span>
            <Dotted parts={parts} />
          </span>
        </Disc>
      </div>
      <Reveal id="rv-refuted" on={on}>
        <ul aria-label="Points that the check took out" className={revealList}>
          {hidden.map((it) => {
            const f = it.payload as FindingPayload;
            const a = it.anchor ?? f.anchor;
            const title = snippet(draftTitle(it), 160);
            return (
              <li key={it.id} data-hidden-item={it.id} className="grid gap-1 border-b border-rule pb-2 last:border-b-0 last:pb-0">
                <p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="text-xs">
                    <Severity s={f.severity} />
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <Inline text={title} />
                  </span>
                  <span translate="no" className="font-mono text-xs text-muted-foreground">
                    {(a?.path ?? f.path).split("/").pop()}:{a ? lineText(a) : f.line}
                  </span>
                </p>
                <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {f.verify?.verdict === "duplicate" ? "The check found the same point in another draft. " : ""}
                  <Inline text={checkText(it) ?? "The check gave no reason."} />
                </p>
                {/* items.ts refuses Restore for a finding without an anchor: a re-review found its code gone. */}
                {it.anchor && (
                  <div>
                    <Button size="sm" variant="outline" disabled={busy.has(it.id)} onClick={() => onRestore(it)}>
                      <Undo2 aria-hidden data-icon="inline-start" />
                      Restore<span className="sr-only"> {title.replaceAll("`", "")}</span>
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Reveal>
    </div>
  );
}

// stale: staleText of the run. ledger: the open drafts of the newest review run. refuted: its refuted and duplicate findings.
// context: the task text that the run read.
export type KindRun = {
  run: RunDto;
  state: RunLineState;
  stale: string | null;
  ledger: ReactNode;
  refuted: ReactNode;
  context: string;
};

type RowProps = {
  meta: MetaDto;
  now: number;
  cancelling: boolean;
  onLog: (run: number, raw?: boolean) => void;
  onCancel: (run: number) => void;
  // A session run (docs/plans/session-consult.md part C): opens its answer in the preview.
  onAnswer: (run: number) => void;
  // An explain run (docs/plans/review-v2/spec.md section 3.1): opens the Explain page.
  onExplain: () => void;
};

export function RunRecord({ rows, ...props }: RowProps & { rows: KindRun[] }) {
  const steady = useSettled(rows[0]?.run.pr);
  if (!rows.length) return null;
  const newest = rows[0]?.run.id;
  // The review leads. The other kinds keep their order, newest first.
  const shown = [...rows.filter((r) => r.run.kind === "review"), ...rows.filter((r) => r.run.kind !== "review")];
  const title = shown[0]?.run.kind === "review" ? "Review" : rows.length > 1 ? "Last runs" : "Last run";
  return (
    <section id="s-review" aria-labelledby="h-review" className="max-w-[86ch] scroll-mt-3 pt-6">
      <h2 id="h-review" className="m-0 mb-2 text-[15px] font-bold tracking-[-0.005em]">
        {title}
      </h2>
      <ul
        id="runline"
        aria-label="Newest run of each kind"
        data-mounting={!steady || undefined}
        className="m-0 grid list-none gap-4 border-l-[3px] border-foreground py-1 pl-3.5 text-sm text-ink-2"
      >
        {shown.map((row) => (
          <RunRow key={row.run.kind} row={row} first={row.run.id === newest} {...props} />
        ))}
      </ul>
    </section>
  );
}

// "Not checked" starts open the first time a run with gaps shows (plan pr-view-v4 2.6). The store keeps the runs that showed it.
// The key adds the start time, because a new data folder starts the run IDs again.
const SEEN = "rl:gaps-seen";
const decided = new Map<string, boolean>();
function firstShow(key: string): boolean {
  const known = decided.get(key);
  if (known !== undefined) return known;
  let first = true;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEEN) ?? "[]");
    const seen = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    first = !seen.includes(key);
    if (first) localStorage.setItem(SEEN, JSON.stringify([...seen, key].slice(-200)));
  } catch {
    // Without the store, each page load counts as the first one.
  }
  decided.set(key, first);
  return first;
}

function Disc({
  on,
  controls,
  warn,
  onClick,
  children,
}: {
  on: boolean;
  controls: string;
  warn?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={on}
      aria-controls={controls}
      onClick={onClick}
      className={cn(
        "rl-hit inline-flex cursor-pointer items-center gap-1 rounded text-sm underline-offset-3 hover:underline",
        warn ? "font-semibold text-warn" : "font-medium text-foreground",
      )}
    >
      <ChevronRight aria-hidden className={cn(icon, "rl-chev")} />
      {children}
    </button>
  );
}

function Reveal({ id, on, children }: { id: string; on: boolean; children: ReactNode }) {
  return (
    <div id={id} hidden={!on} className="grid gap-1.5 rounded-md bg-sunken px-3 py-2 text-sm text-foreground">
      {children}
    </div>
  );
}

const revealList = "m-0 grid list-none gap-1.5 p-0";
const revealItem = "grid grid-cols-[16px_minmax(0,1fr)] gap-2 [overflow-wrap:anywhere]";

// first: the newest run. Only it can run, so only its state is a live region. Key 3 opens its log.
function RunRow({ row, first, meta, now, cancelling, onLog, onCancel, onAnswer, onExplain }: RowProps & { row: KindRun; first: boolean }) {
  const { run, state: s } = row;
  const review = run.kind === "review";
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const part = (name: string, start = false) => {
    const key = `${run.id}:${name}`;
    const on = open.get(key) ?? start;
    return { on, id: `rv-${run.id}-${name}`, flip: () => setOpen((m) => new Map(m).set(key, !on)) };
  };
  const sum = s.kind === "done" ? run.summary : null;
  const nc = sum ? notChecked(sum.coverage) : null;
  const dropped = sum?.dropped.length ?? 0;
  const gaps = part("nc", !!nc && nc.n > 0 && firstShow(`${run.id}:${run.startedAt}`));
  const setup = part("setup");
  const read = part("read");
  const risk = part("risk");
  const qa = part("qa");
  const answered = review ? answeredQuestions(sum) : null;
  // The phase is part of the key, so the live region reads "Checking 9 findings…" when the check starts.
  const state = `${run.id}:${s.kind}:${s.kind === "running" ? (run.phase ?? "") : ""}`;
  const failedCheck = review && s.kind === "done" ? checkFailedText(run.summary) : null;
  const phases = review && s.kind === "done" ? phaseParts(run.summary) : [];
  const at = run.finishedAt ?? run.startedAt;
  // The log footer also shows the tokens. Here they stay in the hint.
  const tokens =
    s.kind === "done" && s.tokens !== null ? `. ${s.tokens.toLocaleString()} tokens in ${plural(run.usage?.turns ?? 0, "turn")}` : "";
  const time = (
    <Hint label={`${fullTime(at)}${tokens}`}>
      <time dateTime={new Date(at).toISOString()}>{agoLong(at, now)}</time>
    </Hint>
  );
  const ncButton = nc && (nc.n > 0 || nc.design || dropped > 0) && (
    <Disc on={gaps.on} controls={gaps.id} warn={nc.n > 0} onClick={gaps.flip}>
      {nc.n > 0 && <TriangleAlert aria-hidden className={icon} />}
      {nc.label}
    </Disc>
  );
  let lead: ReactNode;
  let rest: ReactNode = null;
  switch (s.kind) {
    case "running":
      lead = (
        <RunStatus state={state} quiet={!first}>
          <LoaderCircle aria-hidden className={cn(icon, "animate-spin")} />
          {runningText(run)}
        </RunStatus>
      );
      // The counters stay outside the live region, so a screen reader does not read each tick.
      rest = (
        <span>
          <Joined
            parts={[s.agents > 0 && plural(s.agents, "agent"), plural(s.calls, "tool call"), <Elapsed key="t" from={s.startedAt} />]}
          />
        </span>
      );
      break;
    case "done":
      lead = (
        <RunStatus state={state} quiet={!first}>
          <span className={review ? "font-semibold text-foreground" : undefined}>{s.result || "Done"}</span>
        </RunStatus>
      );
      rest =
        run.kind === "session" ? (
          <button id="session-answer-btn" type="button" className={linkish} onClick={() => onAnswer(run.id)}>
            Show the answer
          </button>
        ) : run.kind === "explain" ? (
          <>
            <button type="button" className={linkish} aria-keyshortcuts="w" onClick={onExplain}>
              Open the walkthrough
            </button>
            {ncButton}
          </>
        ) : (
          !review && ncButton
        );
      break;
    case "failed":
      lead = (
        <RunStatus state={state} quiet={!first} full>
          <Err>Failed. {s.text}</Err>
        </RunStatus>
      );
      rest = s.raw && (
        <button type="button" className={linkish} onClick={() => onLog(run.id, true)}>
          <Braces aria-hidden className={icon} />
          Show raw output
        </button>
      );
      break;
    case "limit":
      lead = (
        <RunStatus state={state} quiet={!first} full>
          <Err>{limitText(meta.runner.name, s.text)}</Err>
        </RunStatus>
      );
      break;
    default:
      lead = (
        <RunStatus state={state} quiet={!first}>
          <CircleStop aria-hidden className={icon} />
          {s.calls === null ? "Cancelled" : `Cancelled after ${plural(s.calls, "tool call")}`}
        </RunStatus>
      );
  }
  const instructions = instructionsText(run);
  const skills = skillsText(run);
  const tasks = run.tasks ?? [];
  const ids = tasks.map((t) => t.key).join(", ");
  const range = run.since?.incremental ? shortHash(run.since.head) : null;
  const risks = sum?.risks ?? [];
  const files = sum?.coverage.read ?? [];
  return (
    <li data-run-kind={run.kind} data-run-state={s.kind} className="grid gap-2.5">
      <div className="flex items-baseline gap-x-3">
        {/* Three groups: the state, its details, and what the run read. A long error takes its own line. */}
        <p className="m-0 flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 [&>.rl-full]:basis-full">
          {!review && (
            <b className="font-semibold text-foreground">
              {KIND_LABEL[run.kind]}
              {s.kind === "done" && " done"}
            </b>
          )}
          {lead}
          {rest}
          <span className="min-w-0">
            <Joined
              parts={[
                run.kind === "session" ? (
                  <span key="session" className="[overflow-wrap:anywhere]">
                    {run.consult?.title ?? "Session without a title"}
                  </span>
                ) : (
                  `${run.profileName} profile`
                ),
                // What the run read: the commit or the range of a re-review.
                <span key="head">
                  <span className="sr-only">{range ? "Changes " : "Commit "}</span>
                  {range && (
                    <>
                      <Hash h={range} />
                      <span aria-hidden className="mx-1">
                        →
                      </span>
                      <span className="sr-only"> to </span>
                    </>
                  )}
                  <Hash h={shortHash(run.sourceHead)} />
                </span>,
                run.since && !run.since.incremental && (
                  <span key="full">
                    The run reviewed the full change, not only the commits since <Hash h={shortHash(run.since.head)} />
                  </span>
                ),
                row.stale,
                // Plan r3 Feature C: the run records its tasks at its start. A run from before Release 3 has no record.
                tasks.length > 0 && (
                  <span key="tasks" title={`Task text that this run read: ${ids}`}>
                    <span className="sr-only">{tasks.length > 1 ? "Tasks" : "Task"}: </span>
                    <code translate="no" className="font-mono text-foreground">
                      {ids}
                    </code>
                  </span>
                ),
                // docs/plans/review-v2/spec.md section 1.1: the time of each phase. Run setup also names their tokens.
                ...phases.map((p) => (
                  <span key={p} data-phase-time>
                    {p}
                  </span>
                )),
                s.kind !== "running" && time,
              ]}
            />
          </span>
        </p>
        <span className="flex shrink-0 items-center gap-3">
          {s.kind === "running" && (
            <button type="button" className={linkish} disabled={cancelling} onClick={() => onCancel(run.id)}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          <button type="button" className={linkish} aria-expanded={setup.on} aria-controls={setup.id} onClick={setup.flip}>
            Run setup<span className="sr-only"> of the {KIND_LABEL[run.kind].toLowerCase()} run</span>
          </button>
          {/* R3: no tooltip, so the focus after a start does not leave one open. The help sheet names the key. */}
          <button
            id={first ? "runline-log" : undefined}
            type="button"
            className={linkish}
            aria-keyshortcuts={first ? "3" : undefined}
            onClick={() => onLog(run.id)}
          >
            <ScrollText aria-hidden className={icon} />
            Log<span className="sr-only"> of the {KIND_LABEL[run.kind].toLowerCase()} run</span>
          </button>
        </span>
      </div>
      {instructions?.notLoaded && (
        <p className="m-0 flex items-start gap-1.5 text-destructive" data-run-not-loaded>
          <CircleAlert aria-hidden className={cn(icon, "mt-0.5")} />
          {instructions.notLoaded}
        </p>
      )}
      {failedCheck && (
        <p className="m-0 flex flex-wrap items-start gap-x-3 gap-y-1 font-semibold text-warn" data-check-failed>
          <span className="inline-flex items-start gap-1.5">
            <TriangleAlert aria-hidden className={cn(icon, "mt-0.5")} />
            {failedCheck}
          </span>
          <button type="button" className={linkish} onClick={() => onLog(run.id)}>
            <ScrollText aria-hidden className={icon} />
            Show log<span className="sr-only"> of the review run</span>
          </button>
        </p>
      )}
      {s.kind === "done" && s.subagents && (
        <p className="m-0 text-muted-foreground [overflow-wrap:anywhere]" data-run-subagents>
          Subagents: {s.subagents}
        </p>
      )}
      {review && s.kind === "running" && (
        <p className="m-0 text-muted-foreground">Drafts show when the review ends. You can read and reply meanwhile.</p>
      )}
      {review && sum && (
        <>
          <p className="m-0 flex max-w-[68ch] items-start gap-2 text-[15.5px] leading-[1.45] tracking-[-0.005em] text-foreground">
            <AiAvatar meta={meta} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <Inline text={sum.summary} />
            </span>
          </p>
          {row.ledger}
          {row.refuted}
          {answered && (
            <div className="grid gap-1.5" data-answered>
              <div>
                <Disc on={qa.on} controls={qa.id} onClick={qa.flip}>
                  {answered.label}
                </Disc>
              </div>
              <Reveal id={qa.id} on={qa.on}>
                <ul aria-label="Questions that the check answered" className={revealList}>
                  {answered.items.map((q, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: two questions can have the same words.
                    <li key={i} data-answered-item className="grid gap-1 border-b border-rule pb-2 last:border-b-0 last:pb-0">
                      <p className="m-0 text-sm [overflow-wrap:anywhere]">
                        <Inline text={q.text} />
                      </p>
                      <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        <span className="font-semibold">Answer:</span> <Inline text={q.answer} />
                      </p>
                    </li>
                  ))}
                </ul>
              </Reveal>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1">
            {files.length > 0 && (
              <Disc on={read.on} controls={read.id} onClick={read.flip}>
                Read {plural(files.length, "file")}
              </Disc>
            )}
            {ncButton}
            {risks.length > 0 && (
              <Disc on={risk.on} controls={risk.id} onClick={risk.flip}>
                Risk areas: {risks.length}
              </Disc>
            )}
          </div>
          <Reveal id={read.id} on={read.on}>
            <ul className={revealList}>
              {files.map((f) => (
                <li key={f} className={revealItem}>
                  <Check aria-hidden className={cn(icon, "mt-0.5 text-muted-foreground")} />
                  <span>
                    <Inline text={f} />
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>
        </>
      )}
      {nc && (
        <Reveal id={gaps.id} on={gaps.on}>
          {nc.lines.length > 0 && (
            <ul className={revealList}>
              {nc.lines.map((x, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two gaps can have the same words.
                <li key={i} className={revealItem}>
                  <TriangleAlert aria-hidden className={cn(icon, "mt-0.5 text-warn")} />
                  <span>
                    <Inline text={x} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {dropped > 0 && (
            <div>
              <Dropped run={run} meta={meta} />
            </div>
          )}
          <p className="m-0 text-xs text-muted-foreground">{nc.design ? `${nc.design} ` : ""}The Log shows each step.</p>
        </Reveal>
      )}
      {review && risks.length > 0 && (
        <Reveal id={risk.id} on={risk.on}>
          <ul className="m-0 list-disc pl-[18px]">
            {risks.map((r) => (
              <li key={r}>
                <Inline text={r} />
              </li>
            ))}
          </ul>
        </Reveal>
      )}
      <Reveal id={setup.id} on={setup.on}>
        <ul className={revealList}>
          <li data-run-setup>
            <span className="text-muted-foreground">Model and effort:</span> {setupText(run, meta.runner.defaults)}
          </li>
          {phases.length > 0 && (
            <li data-run-phases>
              <span className="text-muted-foreground">Steps:</span> {phaseParts(run.summary, true).join("; ")}
            </li>
          )}
          {run.consult && (
            <li data-run-session className="[overflow-wrap:anywhere]">
              <span className="text-muted-foreground">Session:</span> {run.consult.title ?? "no title"}, {sizeText(run.consult.bytes)} of
              history, up to about {run.consult.tokens.toLocaleString()} tokens. It got {plural(run.consult.items, "review point")} (
              {sizeText(run.consult.textBytes)}).{run.consult.mode === "fix" && " Mode: judge and propose fixes."}
            </li>
          )}
          {instructions?.short && (
            <li title={`Project instructions of this run:\n${instructions.long}`} data-run-instructions>
              <span className="text-muted-foreground">Project instructions:</span> {instructions.short}
            </li>
          )}
          {skills && (
            <li data-run-skills>
              <span className="text-muted-foreground">Skills:</span> {skills}
            </li>
          )}
          <li>{row.context}</li>
          {run.note.trim() && (
            <li className="whitespace-pre-line [overflow-wrap:anywhere]">
              <span className="text-muted-foreground">Your note:</span> {run.note}
            </li>
          )}
        </ul>
      </Reveal>
    </li>
  );
}
