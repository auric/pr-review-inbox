// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Drafts section (plan pr-view-v4 2.7, prototype pr-view-v4 drafts()): the findings and questions of the newest review run in one
// list of rows, with triage (WP14a), then the questions of the newest explain run. Only you see drafts until you post them. On your
// own PR, an open finding has Fix and its fix card (docs/plans/fix-ux.md phase 2). Each finding card has the talk with the runner
// (docs/plans/review-v2/spec.md section 2.1).
import { Check, ChevronRight, CircleAlert, FileCode, GitCommitHorizontal, MessageCircleQuestionMark, Wrench } from "lucide-react";
import { Fragment, memo, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MetaDto, ReviewItemDto, RunDto } from "../../shared/dto";
import type { AnchoredFinding, Question } from "../../shared/review";
import { Text } from "../pr/Thread";
import { snippet } from "../pr/threads";
import { FindingRevision, TalkLink } from "./Discuss";
import { withdrawnNote } from "./discuss-model";
import {
  anchorNote,
  CHECK_LABEL,
  carriedNote,
  checkChip,
  checkText,
  closedLabel,
  DROP_REASON,
  type DraftGroups,
  draftExcerpt,
  draftTitle,
  EVIDENCE,
  fixedNote,
  isDemoted,
  type LedgerPart,
  ledgerText,
  lineText,
  restoredNote,
  SEVERITY,
  sessionNote,
} from "./model";
import { Acts, Editor, Mover, ReasonChips, type TriageCtx, type TriageMode } from "./Triage";

const icon = "size-[15px] shrink-0";
const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Backticks become code. The text is the runner's output, so nothing else renders as markup.
export function Inline({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text keep their order.
      <code key={i} className="rounded-[3px] bg-sunken px-[3px] font-mono text-[0.9em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

export function AiAvatar({ meta }: { meta: MetaDto }) {
  return (
    <span aria-hidden className="rl-av" data-ai>
      {meta.runner.initials}
    </span>
  );
}

export function Severity({ s }: { s: AnchoredFinding["severity"] }) {
  // Hue rule: the error hue marks only errors and Blocker findings.
  return s === "blocker" ? (
    <span className="inline-flex shrink-0 items-center gap-1 font-semibold whitespace-nowrap text-destructive">
      <CircleAlert aria-hidden className={icon} />
      {SEVERITY[s]}
    </span>
  ) : (
    <span className="shrink-0 font-semibold whitespace-nowrap text-ink-2">{SEVERITY[s]}</span>
  );
}

const SIGN = { add: "+", del: "−", ctx: " " } as const;

function Lines({ lines }: { lines: ReturnType<typeof draftExcerpt> }) {
  return lines.map((l) => (
    <span key={`${l.kind}${l.n}`} className="rl-cl" data-k={l.kind} data-hit={l.hit || undefined}>
      <span className="rl-no">{l.n}</span>
      <span className="rl-sg">{SIGN[l.kind]}</span>
      <span>{l.text}</span>
    </span>
  ));
}

// The check chip (docs/plans/review-v2/spec.md section 1.1). The words carry the state, so the hue is only a hint.
export function CheckChip({ label }: { label: string }) {
  return (
    <Badge
      variant={label === CHECK_LABEL.checked ? "quiet" : label === CHECK_LABEL.unsure ? "warn" : "outline"}
      className="h-auto rounded-sm px-1.5 py-0 text-[11px] font-semibold"
      data-check={label}
    >
      {label === CHECK_LABEL.checked && <Check aria-hidden />}
      {label}
    </Badge>
  );
}

// asker: the person that the questions ask, as the question rows name them.
// checked: the run of the drafts had the check step, so each finding card shows its check chip.
// explainRun: the explain run whose questions are in the list (docs/plans/review-v2/spec.md section 3.1). They show "From Explain".
export type DraftCtx = {
  meta: MetaDto;
  asker: string;
  checked: boolean;
  explainRun: number | null;
  onToggle: (id: number) => void;
  onFrom: (agent: string) => void;
  // Plan r2 UI-DIFF: focuses the line of the draft in the diff.
  onShowInDiff: (id: number) => void;
  // Your own PR: opens the Fix list with only this finding ticked. null: a PR of another author.
  onFix: ((id: number) => void) | null;
  triage: TriageCtx;
  // spec.md section 2.1: the link "Ask <runner> about this" opens or closes the talk under a finding card.
  talk: { toggle: (id: number) => void };
  // Use the new text and Keep mine of a changed finding. take: rev replaces the text of it. keep: rev goes.
  revision: { take: (rev: ReviewItemDto, it: ReviewItemDto) => void; keep: (rev: ReviewItemDto) => void };
};

// The ID of the row element. The diff, the ledger, and the keys focus it.
export const draftDomId = (it: ReviewItemDto) => (it.kind === "question" ? `q-${it.id}` : `d-${it.id}`);

// One row: kind, title, place, and state. Enter, o, or a click opens the body with the triage actions (plan pr-view-v4 2.7).
// mode: the open editor or line field of this draft. busy: a triage request of this draft is out. fix: the fix card of the finding.
// chips: the discard reason chips show under the row. talk: the open talk under the card (Discuss.tsx Talk).
export const Draft = memo(function Draft({
  it,
  open,
  mode,
  busy,
  chips,
  fix,
  talk,
  ctx,
}: {
  it: ReviewItemDto;
  open: boolean;
  mode: TriageMode;
  busy: boolean;
  chips?: boolean;
  fix?: ReactNode;
  talk?: ReactNode;
  ctx: DraftCtx;
}) {
  const short = ctx.meta.runner.short;
  const f = it.kind === "finding" ? (it.payload as AnchoredFinding) : null;
  // A re-review drops the anchor of a finding whose code is gone. The row then names the place that the base run showed.
  const a = f ? (it.anchor ?? f.anchor) : null;
  const path = f ? (a?.path ?? f.path) : null;
  const line = f ? (a ? lineText(a) : String(f.line)) : null;
  const where = path && `${base(path)}:${line}`;
  const closed = it.status === "discarded" ? closedLabel(it) : null;
  const accepted = it.status === "accepted";
  const carried = carriedNote(it);
  const restored = fixedNote(it) ?? restoredNote(it);
  const chip = f ? checkChip(it, ctx.checked) : null;
  const demoted = isDemoted(it);
  const explained = !f && it.run === ctx.explainRun;
  const label = !f
    ? closed
      ? `Discarded question${explained ? ", from Explain" : ""}`
      : `Question from ${short}${explained ? ", from Explain" : ""}${accepted ? ", accepted" : ""}`
    : closed
      ? closed === "Discarded"
        ? `Discarded draft. ${where}.`
        : `Draft, ${closed.toLowerCase()}. ${where}.`
      : `Draft from ${short}. ${SEVERITY[f.severity]}. ${where}.${accepted ? " Accepted." : ""}${carried ? ` ${carried}` : ""}${restored ? ` ${restored}` : ""}${chip ? ` ${chip}.` : ""}${it.revised ? " A new text waits." : ""}`;
  const cut = path ? path.lastIndexOf("/") + 1 : 0;
  return (
    <article
      id={draftDomId(it)}
      data-draft={f ? it.id : undefined}
      data-draft-question={f ? undefined : it.id}
      data-item={it.id}
      data-demoted={demoted || undefined}
      tabIndex={-1}
      aria-label={label}
      className={cn("scroll-mt-3 border-b", !closed && "rl-enter")}
    >
      <button
        id={`dh-${it.id}`}
        data-row-head
        type="button"
        aria-expanded={open}
        aria-controls={`db-${it.id}`}
        onClick={() => ctx.onToggle(it.id)}
        className="grid min-h-[38px] w-full cursor-pointer grid-cols-[16px_84px_minmax(0,1fr)_auto] items-center gap-2 rounded px-1.5 py-[7px] text-left text-sm hover:bg-hover"
      >
        <ChevronRight aria-hidden className={cn("rl-chev", icon)} />
        <span className="text-xs">
          {f ? (
            <Severity s={f.severity} />
          ) : (
            <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap text-ink-2">
              <MessageCircleQuestionMark aria-hidden className="size-[13px] shrink-0" />
              Question
            </span>
          )}
        </span>
        <span className="grid min-w-0">
          {explained ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className={cn("truncate", demoted && "text-muted-foreground", closed && "text-muted-foreground line-through")}>
                {snippet(draftTitle(it), 160)}
              </span>
              <Badge variant="quiet" data-from-explain className="shrink-0">
                From Explain
              </Badge>
            </span>
          ) : (
            <span className={cn("truncate", demoted && "text-muted-foreground", closed && "text-muted-foreground line-through")}>
              {snippet(draftTitle(it), 160)}
            </span>
          )}
          {path && (
            <span className="flex min-w-0 items-center gap-2">
              <span translate="no" className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {path.slice(0, cut)}
                <span className="text-ink-2">{path.slice(cut)}</span>:{line}
              </span>
              {chip && !closed && <CheckChip label={chip} />}
            </span>
          )}
        </span>
        {it.status === "discarded" && it.payload.fixed ? (
          <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
            <GitCommitHorizontal aria-hidden className="size-[13px] shrink-0" />
            Fixed in{" "}
            <code translate="no" className="font-mono">
              {it.payload.fixed.short}
            </code>
          </span>
        ) : closed ? (
          <span className="text-xs whitespace-nowrap text-muted-foreground">{closed}</span>
        ) : accepted ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap text-ink-2">
            <Check aria-hidden className="size-[13px] shrink-0" />
            Accepted
          </span>
        ) : null}
      </button>
      {chips && f && <ReasonChips it={it} busy={busy} ctx={ctx.triage} />}
      <div id={`db-${it.id}`} hidden={!open}>
        {open &&
          (f ? (
            <FindingBody it={it} mode={mode} busy={busy} fix={fix} talk={talk} ctx={ctx} />
          ) : (
            <QuestionBody it={it} mode={mode} busy={busy} ctx={ctx} />
          ))}
      </div>
    </article>
  );
});

// The body lines up with the kind column of the row.
const body = "pt-1 pr-1.5 pb-4 pl-[30px]";
const note = "m-0 mt-1.5 max-w-[72ch] text-xs text-muted-foreground [overflow-wrap:anywhere]";

function FindingBody(props: { it: ReviewItemDto; mode: TriageMode; busy: boolean; fix: ReactNode; talk: ReactNode; ctx: DraftCtx }) {
  const { it, mode, busy, fix, ctx } = props;
  const f = it.payload as AnchoredFinding;
  const a = it.anchor;
  const lines = a ? draftExcerpt(a) : [];
  const anchored = anchorNote(it);
  const carried = carriedNote(it);
  const restored = fixedNote(it) ?? restoredNote(it);
  const session = sessionNote(it);
  const withdrawn = withdrawnNote(it);
  const short = ctx.meta.runner.short;
  const rev = it.revised;
  const trigger = f.trigger?.trim();
  const check = checkText(it);
  const onFix = ctx.onFix;
  // Acts shows lead only for a draft that is not discarded. jobs.ts fixFindings also needs the anchor.
  const toFix = onFix && a && (
    <Button size="sm" variant="outline" disabled={busy} title="Key: f" aria-keyshortcuts="f" onClick={() => onFix(it.id)}>
      <Wrench aria-hidden data-icon="inline-start" />
      Fix
    </Button>
  );
  const at = a ? `${a.path} line ${lineText(a)}` : f.path;
  const toDiff = a && (
    <button
      type="button"
      title="Key: g d"
      aria-keyshortcuts="g d"
      className="rl-hit ml-1 inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline"
      onClick={() => ctx.onShowInDiff(it.id)}
    >
      <FileCode aria-hidden className={icon} />
      Show in diff
    </button>
  );
  return (
    <div className={body}>
      {lines.length > 0 && (
        <figure
          className="rl-code m-0 mb-2.5"
          aria-label={`Code at ${at}${a?.state === "outside" ? ", from the snapshot, outside the diff" : ""}`}
        >
          <pre className="rl-pre">
            <Lines lines={lines} />
          </pre>
        </figure>
      )}
      {mode === "edit" && it.status !== "discarded" ? (
        <Editor it={it} busy={busy} flush ctx={ctx.triage} />
      ) : (
        <>
          <div className="max-w-[72ch] [overflow-wrap:anywhere]">
            <Text text={it.body} />
          </div>
          {trigger && (
            <p className="m-0 mt-1.5 max-w-[72ch] text-ink-2 [overflow-wrap:anywhere]" data-trigger>
              <span className="font-semibold">When:</span> <Inline text={trigger} />
            </p>
          )}
          {check && (
            <p className={note} data-check-reason>
              <Inline text={check} />
            </p>
          )}
          <div className={note}>
            <Text text={`${EVIDENCE[f.evidenceStatus]}, ${f.confidence} confidence.${f.evidence.trim() ? ` ${f.evidence.trim()}` : ""}`} />
          </div>
          <p className={cn(note, "flex flex-wrap items-center gap-x-3 gap-y-0.5")}>
            <span>{f.category}</span>
            {f.agent && (
              <button
                type="button"
                title="Open the run log at this agent"
                className="rl-hit inline-flex cursor-pointer items-center rounded hover:text-foreground hover:underline"
                onClick={() => ctx.onFrom(f.agent as string)}
              >
                from {f.agent}
              </button>
            )}
            {it.edited && <span>Edited by you</span>}
          </p>
          {carried && <p className={note}>{carried}</p>}
          {restored && <p className={note}>{restored}</p>}
          {session && (
            <p className={note} data-session-note>
              <Inline text={session} />
            </p>
          )}
          {withdrawn && (
            <p className={note} data-withdrawn>
              <Inline text={withdrawn} />
            </p>
          )}
          {anchored && <p className={note}>{anchored}</p>}
          {mode === "move" ? (
            <Mover it={it} busy={busy} ctx={ctx.triage} />
          ) : (
            <Acts
              it={it}
              busy={busy}
              flush
              ctx={ctx.triage}
              lead={toFix}
              always={<TalkLink it={it} open={!!props.talk} runner={short} onClick={() => ctx.talk.toggle(it.id)} />}
            >
              {toDiff}
            </Acts>
          )}
          {rev && (
            <FindingRevision
              it={it}
              rev={rev}
              busy={busy}
              runner={short}
              onTake={() => ctx.revision.take(rev, it)}
              onKeep={() => ctx.revision.keep(rev)}
            />
          )}
        </>
      )}
      {props.talk}
      {fix}
    </div>
  );
}

// prototype pr-view-v4 draft 14. The body is the question as it will post. why stays as the runner wrote it.
// publish/plan.ts generalText puts the questions into one general comment.
function QuestionBody({ it, mode, busy, ctx }: { it: ReviewItemDto; mode: TriageMode; busy: boolean; ctx: DraftCtx }) {
  const p = it.payload as Question;
  return (
    <div className={body}>
      {mode === "edit" && it.status !== "discarded" ? (
        <Editor it={it} busy={busy} flush ctx={ctx.triage} />
      ) : (
        <>
          <p className="m-0 max-w-[72ch] [overflow-wrap:anywhere]">
            <Inline text={it.body} />
          </p>
          <p className="m-0 mt-1 max-w-[72ch] text-ink-2 [overflow-wrap:anywhere]">
            <Inline text={p.why} />
          </p>
          <p className={note}>A question for {ctx.asker}. It posts as a general comment.</p>
          <Acts it={it} busy={busy} flush ctx={ctx.triage} />
        </>
      )}
    </div>
  );
}

// open: the item with an open editor or line field. quiet: the editor opened again with its unsent text when the PR opened.
// busy: items with a triage request out. chips: the finding that the user just discarded. Its card shows the reason chips
// until the next triage action.
export type TriageState = {
  open: { id: number; mode: Exclude<TriageMode, null>; quiet?: boolean } | null;
  busy: ReadonlySet<number>;
  chips: number | null;
};
export const modeOf = (s: TriageState, id: number): TriageMode => (s.open?.id === id ? s.open.mode : null);

// Parts of one line, joined by a dot that screen readers skip. The space stays outside the dot, so the words stay apart.
export function Dotted({ parts }: { parts: ReactNode[] }) {
  return parts.filter(Boolean).map((p, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts keep their order.
    <Fragment key={i}>
      {i > 0 && (
        <>
          <span aria-hidden className="text-muted-foreground">
            {" ·"}
          </span>{" "}
        </>
      )}
      {p}
    </Fragment>
  ));
}

// The ID of the fold row element. j and k reach its button as a Drafts row (PrDetail.tsx DRAFT_ROWS); the keys a, e, and d find no
// item in it.
const FOLD_ROW = "fold";

// groups: the findings of the newest review run by display group (docs/plans/review-v2/spec.md section 1.4). questions: its questions.
// The main findings come first, then the fold, then the questions (plan pr-view-v4 2.7: the findings, then the questions). A closed
// fold renders no rows, so j and k skip them. ledger: the open drafts in plain words. cards: the fix card of each finding, by item ID.
// talks: the open talk under each finding card, by item ID.
export function Drafts({
  groups,
  questions,
  ledger,
  foldOpen,
  onFold,
  isOpen,
  triage,
  cards,
  talks,
  ctx,
}: {
  groups: DraftGroups;
  questions: ReviewItemDto[];
  ledger: LedgerPart[];
  foldOpen: boolean;
  onFold: () => void;
  isOpen: (it: ReviewItemDto) => boolean;
  triage: TriageState;
  cards: ReadonlyMap<number, ReactNode>;
  talks: ReadonlyMap<number, ReactNode>;
  ctx: DraftCtx;
}) {
  const fold = groups.foldName ? groups.fold : [];
  if (!groups.main.length && !fold.length && !questions.length) return null;
  const row = (it: ReviewItemDto) => {
    const mode = modeOf(triage, it.id);
    return (
      <li key={it.id}>
        <Draft
          it={it}
          open={isOpen(it) || mode !== null}
          mode={mode}
          busy={triage.busy.has(it.id) || (!!it.revised && triage.busy.has(it.revised.id))}
          chips={triage.chips === it.id && it.status === "discarded"}
          fix={cards.get(it.id)}
          talk={talks.get(it.id)}
          ctx={ctx}
        />
      </li>
    );
  };
  return (
    <section id="s-drafts" aria-labelledby="h-drafts" className="max-w-[86ch] scroll-mt-3 pt-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="h-drafts" className="m-0 text-[15px] font-bold tracking-[-0.005em]">
          Drafts
        </h2>
        {ledger.length > 0 && (
          <p className="m-0 text-sm font-medium text-ink-2" data-drafts-ledger>
            <Dotted parts={ledger.map(ledgerText)} />
          </p>
        )}
        <p className="m-0 text-xs text-muted-foreground">Only you see drafts until you post them.</p>
      </div>
      <div className="border-t">
        <ol className="m-0 list-none p-0">{groups.main.map(row)}</ol>
        {fold.length > 0 && (
          <>
            <div data-item={FOLD_ROW} className="border-b">
              <button
                id="fold-btn"
                data-row-head
                type="button"
                aria-expanded={foldOpen}
                aria-controls="d-fold"
                onClick={onFold}
                className="flex min-h-[38px] w-full cursor-pointer items-center gap-2 rounded px-1.5 py-[7px] text-left text-sm font-medium text-ink-2 hover:bg-hover"
              >
                <ChevronRight aria-hidden className={cn("rl-chev", icon)} />
                {groups.foldName} ({fold.length})
              </button>
            </div>
            <ol id="d-fold" hidden={!foldOpen} aria-label={groups.foldName ?? undefined} className="m-0 list-none p-0">
              {foldOpen && fold.map(row)}
            </ol>
          </>
        )}
        <ol className="m-0 list-none p-0">{questions.map(row)}</ol>
      </div>
    </section>
  );
}

// docs/plans/review-v2/spec.md section 1.7: the anchor checks drop a finding for its code reference, a place outside the change, or a
// quoted rule that no instruction file holds. One line names each kind.
export function Dropped({ run, meta }: { run: RunDto; meta: MetaDto }) {
  const d = run.summary?.dropped ?? [];
  const n = (pred: (r: (typeof d)[number]["reason"]) => boolean) => d.filter((x) => pred(x.reason)).length;
  const refs = n((r) => r !== "unchanged" && r !== "rule");
  const outside = n((r) => r === "unchanged");
  const rules = n((r) => r === "rule");
  const lead = (k: number) => (k === 1 ? "1 finding dropped" : `${k} findings dropped`);
  return (
    <>
      {[
        refs ? `${lead(refs)}: ${refs === 1 ? "its code reference" : "their code references"} did not match the snapshot.` : "",
        outside ? `${lead(outside)}: not part of this change.` : "",
        rules ? `${lead(rules)}: the quoted rule is not in the project instructions for this path.` : "",
      ]
        .filter(Boolean)
        .join(" ")}
      <details className="mt-0.5">
        <summary className="rl-hit inline-flex rounded font-medium text-pen hover:underline">Show {d.length === 1 ? "it" : "them"}</summary>
        {d.map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: dropped findings have no ID.
          <div key={i} className="mt-1.5 mb-0.5 border-l border-rule-strong pl-2.5">
            <p className="m-0 mt-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              From {x.agent ?? meta.runner.short}. It quoted{" "}
              <code className="rounded-[3px] bg-sunken px-[3px] font-mono">{snippet(x.anchorText, 120)}</code> at{" "}
              <code className="rounded-[3px] bg-sunken px-[3px] font-mono">
                {base(x.path)}:{x.line}
              </code>
              . {DROP_REASON[x.reason]}
            </p>
            <div className="max-w-[72ch] [overflow-wrap:anywhere]">
              <Text text={x.body} />
            </div>
          </div>
        ))}
      </details>
    </>
  );
}
