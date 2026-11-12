// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fix it on the own pull request (plan r3 UI-FIX, pr-view-v4 2.11 and 2.12, docs/plans/fix-ux.md): the Fix button and the Fix list,
// the fix runs, the fix card of each thread and finding, the runner prompt, and the fix part of the bottom bar with the apply dialog.
// The fix part shows while a fix run runs, and while an edit is ticked, as the post part shows while an item is accepted.
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import type { FixCommitDto, FixDto, MetaDto, PrRow, ReviewItemDto, RunConflict } from "../../shared/dto";
import type { PromptCopy } from "../pr/Thread";
import type { ThreadModel } from "../pr/threads";
import { planKey } from "../publish/data";
import { replyKey } from "../review/data";
import { lineText, plural, shortHash } from "../review/model";
import type { Focus } from "../review/useReview";
import { Hint, type Hints } from "../shell/Hint";
import { failText, prKey, repoOf } from "../shell/model";
import { ApplyDialog, type ApplyTarget } from "./ApplyDialog";
import { CloneFolder } from "./CloneDialog";
import { cloneKey, declineFix, fixesKey, getClone, undeclineFix, undoFix, useClone, useClones, useFixes, useStartFix } from "./data";
import { FixCard, type FixCtx } from "./FixCard";
import { FixPicker } from "./FixPicker";
import { handoffText } from "./handoff";
import {
  type Asked,
  applyText,
  cardKey,
  type FixTarget,
  findingFixWhy,
  fixReason,
  fixState,
  fixTargets,
  noteDraft,
  OWN_ONLY,
  selection,
  threadFixWhy,
} from "./model";

const icon = "size-[15px] shrink-0";

export type FixUi = {
  // "Fix N" next to Draft replies. false on a pull request of another author.
  button: ReactNode;
  // The fix card of each thread, keyed by thread ID.
  cards: ReadonlyMap<number, ReactNode>;
  // The fix card of each finding draft, keyed by review item ID.
  findingCards: ReadonlyMap<number, ReactNode>;
  // The fix parts of the bottom bar, or false.
  bar: ReactNode;
  // The apply dialog and the Fix list.
  dialog: ReactNode;
  fixes: FixDto[] | undefined;
  // Opens the Fix list. thread absent: the default ticks. A thread ID: only that thread is ticked. null: no current thread.
  // A pull request of another author, a resolved thread, or a thread without a live message gives a toast.
  // key: a shortcut key opens the list, so it shows no animation.
  open: (thread?: number | null, key?: boolean) => void;
  // Opens the Fix list with only this finding ticked. A pull request of another author or a closed finding gives a toast.
  openFinding: (id: number, key?: boolean) => void;
  // Opens the Fix list with exactly these targets ticked: the accepts of a session answer (session-consult.md part C).
  openWith: (targets: FixTarget[]) => void;
  // Copies the runner prompt of the thread. Call it in the click handler. Resolves to the next step, or null.
  copyPrompt: (thread: number) => Promise<PromptCopy | null>;
  // The choice of the user per free edit ID. Without a choice, selection() ticks the edits of the newest run.
  ticks: ReadonlyMap<number, boolean>;
  // Ticks or unticks these edits: "Keep the reply" of a conflict note (docs/plans/thread-outcome.md).
  tick: (edits: number[], on: boolean) => void;
  // A new fix run for one target, with the checks of Fix again. anyway: "Fix anyway".
  again: (t: FixTarget, anyway?: boolean) => void;
};

const NO_CARDS: ReadonlyMap<number, ReactNode> = new Map();
const NO_TICKS: ReadonlySet<string> = new Set();

// The fix card of each thread or finding with fix state, keyed by thread or review item ID. of: the threads, or the finding drafts
// with their status. replies: the current reply draft of each thread. declining: the cardKey of each card with a decline request out.
function fixCards(
  kind: FixTarget["kind"],
  of: { id: number; status?: ReviewItemDto["status"] }[],
  list: FixDto[] | undefined,
  asked: Asked | null,
  ticks: ReadonlyMap<number, boolean>,
  undoing: ReadonlySet<number>,
  replies: ReviewItemDto[] | undefined,
  declining: ReadonlySet<string>,
  ctx: FixCtx,
) {
  const out = new Map<number, ReactNode>();
  for (const { id, status } of of) {
    const target = { kind, id };
    const s = fixState(list, target, asked);
    if (!s) continue;
    const done = s.kind === "done" ? s : null;
    const busy = (!!done?.commit && undoing.has(done.commit.id)) || declining.has(cardKey(target));
    const draft = done ? noteDraft(done.fix, done.note, target, replies) : null;
    // The server refuses the undo once the "Won't fix" reply or the finding is posted. replies holds only the current, unposted draft
    // of each thread.
    const undecline = !!done?.note?.declined && (kind === "thread" ? draft !== null : status !== "posted");
    out.set(id, <FixCard state={s} target={target} ticks={ticks} busy={busy} draft={draft} undecline={undecline} ctx={ctx} />);
  }
  return out;
}

export function useFix(
  pr: PrRow,
  o: {
    meta: MetaDto;
    hints: Hints;
    threads: ThreadModel[];
    replies: ReviewItemDto[] | undefined;
    // The finding drafts of the newest review run, in screen order.
    findings: ReviewItemDto[];
    // The brief profile. Each fix run uses it.
    profile: { name: string; explain: boolean };
    // The run-slot note (W1 or W2) of useSlots, or null.
    busy: string | null;
    // The server has the source and target head of the PR.
    synced: boolean;
    announce: (text: string) => void;
    focusAfter: (f: Focus) => void;
    onLog: (run: number) => void;
    slotTaken: (c: RunConflict) => void;
    // Opens these threads, so their fix cards mount.
    show: (threads: number[]) => void;
    // Opens these finding drafts, so their fix cards mount.
    showFindings: (ids: number[]) => void;
    // "Copy for your session" in the Fix list footer.
    onConsult: () => void;
  },
): FixUi {
  const author = pr.role === "AUTHOR";
  const qc = useQueryClient();
  const fixes = useFixes(pr.id, author);
  const start = useStartFix(pr.id);
  // The threads and findings of the fix run that this page started. They show a pending card while it runs.
  const [asked, setAsked] = useState<Asked | null>(null);
  const [ticks, setTicks] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [undoing, setUndoing] = useState<ReadonlySet<number>>(new Set());
  const [declining, setDeclining] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<ApplyTarget | null>(null);
  const clone = useClone(pr.id, author && target !== null);
  // The element that takes the focus when the apply dialog closes. The dialog can read it more than once, so only an open clears it.
  const focusTo = useRef<string | null>(null);
  const threads = useRef(o.threads);
  threads.current = o.threads;
  const findings = useRef(o.findings);
  findings.current = o.findings;
  const list = fixes.data;
  const { announce, focusAfter } = o;

  // ---------- The Fix list ----------
  const targets = useMemo(() => fixTargets(o.threads, o.replies, list, o.findings), [o.threads, o.replies, list, o.findings]);
  // The cardKey of each ticked row while the Fix list is open. null: closed.
  const [pick, setPick] = useState<ReadonlySet<string> | null>(null);
  const [keyed, setKeyed] = useState(false);
  const tick = (kind: FixTarget["kind"], id: number) => cardKey({ kind, id });
  const tickedThreads = pick ? targets.rows.flatMap((r) => (pick.has(tick("thread", r.thread)) ? [r.thread] : [])) : [];
  const tickedFindings = pick ? targets.findings.flatMap((r) => (pick.has(tick("finding", r.finding)) ? [r.finding] : [])) : [];
  const rowCount = targets.rows.length + targets.findings.length;
  const reason = fixReason({
    rows: rowCount,
    ticked: tickedThreads.length + tickedFindings.length,
    synced: o.synced,
    profile: o.profile,
    busy: o.busy,
  });

  const showList = (ticks: Iterable<string>, key: boolean) => {
    setKeyed(key);
    setPick(new Set(ticks));
  };
  const open = (thread?: number | null, key = false) => {
    if (!author) return void toast.add({ title: OWN_ONLY });
    if (thread === undefined) {
      const rows = targets.rows.flatMap((r) => (r.tick ? [tick("thread", r.thread)] : []));
      return showList([...rows, ...targets.findings.flatMap((r) => (r.tick ? [tick("finding", r.finding)] : []))], key);
    }
    const t = threads.current.find((x) => x.id === thread);
    const why = threadFixWhy(t);
    if (why !== null || !t) return void toast.add({ title: why ?? "" });
    showList([tick("thread", t.id)], key);
  };
  const openFinding = (id: number, key = false) => {
    if (!author) return void toast.add({ title: OWN_ONLY });
    const why = findingFixWhy(findings.current.find((x) => x.id === id));
    if (why !== null) return void toast.add({ title: why });
    showList([tick("finding", id)], key);
  };
  const openWith = (targets: FixTarget[]) => {
    if (!author) return void toast.add({ title: OWN_ONLY });
    showList(targets.map(cardKey), false);
  };

  // focus: the element that takes the focus after the start, or null. anyway: "Fix anyway" for the one target.
  const runFor = (ts: number[], fs: number[], focus: string | null = null, anyway = false) => {
    const n = ts.length + fs.length;
    start.mutate(
      // fixRunInput refuses an empty list.
      { threads: ts.length ? ts : undefined, findings: fs.length ? fs : undefined, anyway },
      {
        onSuccess: (r) => {
          if ("conflict" in r) return o.slotTaken(r.conflict);
          setAsked({ run: r.run.id, threads: ts, findings: fs });
          setPick(null);
          o.show(ts);
          o.showFindings(fs);
          void qc.invalidateQueries({ queryKey: fixesKey(pr.id) });
          announce(n === 1 ? "Proposing a fix." : `Proposing fixes for ${plural(n, "point")}.`);
          if (focus) focusAfter({ id: focus, block: "nearest", flash: false });
        },
        onError: (e) => toast.add({ title: "The fix run did not start", description: failText(e) }),
      },
    );
  };
  const propose = () => {
    if (reason.kind !== "ok" || start.isPending) return;
    runFor(tickedThreads, tickedFindings);
  };
  // Fix again and Fix anyway on a card: the same checks as the Fix list with one ticked row.
  const again = (t: FixTarget, anyway = false) => {
    if (start.isPending) return;
    const why = fixReason({ rows: rowCount, ticked: 1, synced: o.synced, profile: o.profile, busy: o.busy });
    if (why.kind !== "ok") return void toast.add({ title: why.text });
    // The button leaves with the card, so the focus goes to the running card.
    runFor(t.kind === "thread" ? [t.id] : [], t.kind === "finding" ? [t.id] : [], `fx-${cardKey(t)}`, anyway);
  };

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: fixesKey(pr.id) });
    void qc.invalidateQueries({ queryKey: replyKey(pr.id) });
    void qc.invalidateQueries({ queryKey: planKey(pr.id) });
    void qc.invalidateQueries({ queryKey: cloneKey(pr.id) });
  };
  const put = (c: FixCommitDto) =>
    qc.setQueryData<FixDto[]>(fixesKey(pr.id), (old) =>
      old?.map((f) => (f.run.id === c.run ? { ...f, commits: [c, ...f.commits.filter((x) => x.id !== c.id)] } : f)),
    );

  // Opens the threads and findings of a selection, so their cards mount. Returns the cardKey of its first edit.
  const reveal = (s: Pick<ApplyTarget, "threads" | "findings" | "first">) => {
    o.show(s.threads);
    o.showFindings(s.findings);
    return s.first ? cardKey(s.first) : null;
  };

  const committed = (c: FixCommitDto, s: ApplyTarget) => {
    put(c);
    refresh();
    announce(
      c.mode === "clone"
        ? `Committed ${c.short ?? ""} on ${c.branch ?? "the branch"}. Push it, then post the “Fixed in” reply.`
        : `Committed ${c.short ?? ""} to an app branch. Run the two commands in your clone.`,
    );
    const key = reveal(s);
    focusTo.current = key && `fxc-${key}`;
    if (c.mode === "clone") setTarget(null);
  };

  // target: the card to focus after the undo. null: the focus stays, as in the apply dialog.
  const undo = async (c: FixCommitDto, target: FixTarget | null) => {
    if (undoing.has(c.id)) return;
    setUndoing((s) => new Set(s).add(c.id));
    try {
      const r = await undoFix(c.id);
      put(r);
      announce(r.mode === "clone" ? `Undone. Your clone is back at ${shortHash(r.before)}.` : "Undone. The app branch is deleted.");
      if (target !== null) focusAfter({ id: `fx-${cardKey(target)}`, block: "nearest", flash: false });
    } catch (e) {
      toast.add({ title: "The undo did not run", description: failText(e) });
    } finally {
      refresh();
      setUndoing((s) => {
        const out = new Set(s);
        out.delete(c.id);
        return out;
      });
    }
  };

  // "Don't fix" with a reason, or its undo with reason null. The card keeps the focus, so a keyboard user stays at the outcome.
  const decline = async (t: FixTarget, run: number, reason: string | null) => {
    const key = cardKey(t);
    if (declining.has(key)) return false;
    setDeclining((s) => new Set(s).add(key));
    const at = t.kind === "thread" ? { run, thread: t.id } : { run, finding: t.id };
    try {
      if (reason === null) await undeclineFix(at);
      else await declineFix({ ...at, reason });
      announce(
        reason === null
          ? "Undone. The proposal is back."
          : t.kind === "thread"
            ? "Declined. A “Won't fix” reply draft is in the thread."
            : "Declined. The finding is discarded.",
      );
      focusAfter({ id: `fx-${key}`, block: "nearest", flash: false });
      return true;
    } catch (e) {
      toast.add({ title: reason === null ? "The undo did not run" : "The decline did not save", description: failText(e) });
      return false;
    } finally {
      refresh();
      setDeclining((s) => {
        const out = new Set(s);
        out.delete(key);
        return out;
      });
    }
  };

  const { meta, hints, onLog } = o;
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const copyPrompt = async (thread: number) => {
    const t = threads.current.find((x) => x.id === thread);
    if (!t) return null;
    const newest = t.last && t.last.id !== t.root.id ? t.last : null;
    const text = handoffText({
      pr: prKey(pr),
      branch: pr.sourceBranch,
      place: t.anchor && { path: t.anchor.path, line: t.anchor.line },
      root: { id: t.root.id, author: t.root.who.name, text: t.root.text ?? "" },
      newest: newest && { id: newest.id, author: newest.who.name, text: newest.text ?? "" },
    });
    const copied = await copyText(text);
    if (copied) announce("Copied the prompt.");
    const path = await qc
      .fetchQuery({ queryKey: cloneKey(pr.id), queryFn: () => getClone(pr.id), staleTime: 30_000 })
      .then((c) => c.path)
      .catch(() => null);
    // runner.login is the command that signs the runner in. Its first word is the command of the runner.
    const command = meta.runner.login.split(" ")[0] ?? meta.runner.short;
    const next = `Open a terminal in ${path ?? `your clone of ${repoOf(pr)}`}, run ${command}, and paste.`;
    return copied ? { next } : { next, text };
  };
  const setMany = useCallback(
    (ids: number[], on: boolean) =>
      setTicks((m) => {
        const out = new Map(m);
        for (const id of ids) out.set(id, on);
        return out;
      }),
    [],
  );
  // The newest actions. The stable ctx calls them, so a card never runs a stale one.
  const acts = useRef({ undo, decline, again, copyPrompt });
  acts.current = { undo, decline, again, copyPrompt };
  // Stable, so the memo cards render again only when their own data changes.
  const ctx = useMemo<FixCtx>(
    () => ({
      meta,
      hints,
      announce,
      onLog: (r) => onLogRef.current(r),
      onTick: (id, on) => setTicks((m) => new Map(m).set(id, on)),
      onUndo: (c, target) => void acts.current.undo(c, target),
      onDecline: (t, run, reason) => acts.current.decline(t, run, reason),
      onUndecline: (t, run) => void acts.current.decline(t, run, null),
      onAgain: (t, anyway) => acts.current.again(t, anyway),
      onPrompt: (thread) => acts.current.copyPrompt(thread),
      onDraft: (item) => focusAfter({ id: `rd-${item}`, block: "nearest", flash: true }),
    }),
    [meta, hints, announce, focusAfter],
  );

  const { replies } = o;
  const cards = useMemo(
    () => (author ? fixCards("thread", o.threads, list, asked, ticks, undoing, replies, declining, ctx) : NO_CARDS),
    [author, o.threads, list, asked, ticks, undoing, replies, declining, ctx],
  );
  const findingCards = useMemo(
    () => (author ? fixCards("finding", o.findings, list, asked, ticks, undoing, replies, declining, ctx) : NO_CARDS),
    [author, o.findings, list, asked, ticks, undoing, replies, declining, ctx],
  );
  const places = useMemo(
    () => new Map(o.findings.flatMap((f) => (f.anchor ? [[f.id, `${f.anchor.path}:${lineText(f.anchor)}`] as const] : []))),
    [o.findings],
  );

  const free = (list ?? []).flatMap((f, i) => {
    if (f.run.status === "running") return [];
    const s = selection(f, i === 0, ticks);
    return s.edits.length ? [{ f, s }] : [];
  });
  const clones = useClones(author && free.length > 0).data;
  const folder = clones?.find((c) => c.project === pr.project && c.repo === pr.repo && !c.missing)?.path;
  // The run that this page started shows before GET /fixes lists it.
  const runningRun =
    list?.find((f) => f.run.status === "running")?.run.id ?? (asked && !list?.some((f) => f.run.id === asked.run) ? asked.run : null);
  const points = asked && asked.run === runningRun ? asked.threads.length + asked.findings.length : 0;
  // Review edits: the card of the first ticked edit.
  const reviewEdits = (s: Pick<ApplyTarget, "threads" | "findings" | "first">) => {
    const key = reveal(s);
    if (key) focusAfter({ id: `fx-${key}`, block: "start", flash: true });
  };
  const part = "inline-flex flex-wrap items-center gap-x-3 gap-y-2";
  const bar = author && (runningRun !== null || free.length > 0) && (
    <>
      {runningRun !== null && (
        <span data-fixbar className={part}>
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            <LoaderCircle aria-hidden className={`${icon} animate-spin`} />
            Fix: checking {points ? plural(points, "point") : "the points"} and proposing edits
          </span>
          <Button variant="link" size="sm" className="rl-hit h-auto px-0" onClick={() => o.onLog(runningRun)}>
            Log
          </Button>
        </span>
      )}
      {free.map(({ f, s }, i) => (
        <span key={f.run.id} data-fixbar className={part}>
          <span className="inline-flex items-center gap-1.5 text-ink-2">
            <Wrench aria-hidden className={icon} />
            {f.run.consult ? "Fix from your session" : "Fix"}: {plural(f.edits.length, "edit")} proposed
          </span>
          {s.first && (
            <Button variant="link" size="sm" className="rl-hit h-auto px-0" onClick={() => reviewEdits(s)}>
              Review edits
            </Button>
          )}
          {i === 0 && folder && <CloneFolder pr={pr.id} path={folder} icons />}
          <Button
            id={`fix-apply-${f.run.id}`}
            size="sm"
            onClick={() => {
              focusTo.current = null;
              setTarget({ run: f.run.id, ...s });
            }}
          >
            {applyText(s.edits.length, s.threads.length, s.findings.length)}
          </Button>
        </span>
      ))}
    </>
  );

  const dialog = author && (
    <>
      <FixPicker
        open={pick !== null}
        instant={keyed}
        prKey={prKey(pr)}
        targets={targets}
        ticks={pick ?? NO_TICKS}
        reason={reason}
        starting={start.isPending}
        onTick={(key, on) =>
          setPick((p) => {
            const out = new Set(p);
            if (on) out.add(key);
            else out.delete(key);
            return out;
          })
        }
        onPropose={propose}
        onClose={() => setPick(null)}
        onConsult={() => {
          setPick(null);
          o.onConsult();
        }}
      />
      <ApplyDialog
        target={target}
        pr={pr.id}
        prNumber={pr.prId}
        repo={repoOf(pr)}
        fixes={list ?? []}
        places={places}
        clone={{ data: clone.data, error: clone.error, refetch: () => void clone.refetch() }}
        onCommitted={committed}
        onRefused={(s) => {
          // A failed commit holds the edits, so the bar can go. The focus then goes to the card of the edits.
          const key = reveal(s);
          focusTo.current = key && `fx-${key}`;
          refresh();
        }}
        onClose={() => setTarget(null)}
        ctx={ctx}
        focusTo={() => focusTo.current}
      />
    </>
  );

  const found = targets.findings.length;
  return {
    button: author && (
      <Hint label="Choose the threads and findings to fix. Key: F. The f key fixes the current thread or finding.">
        <Button
          id="fix-btn"
          size="sm"
          variant="outline"
          aria-label={`Fix, ${plural(targets.rows.length, "open thread")}${found ? `, ${plural(found, "open finding")}` : ""}`}
          aria-keyshortcuts="Shift+F"
          onClick={() => open()}
        >
          <Wrench aria-hidden data-icon="inline-start" />
          Fix
          <span aria-hidden className="rounded-[4px] bg-sel px-1 text-xs font-semibold text-ink-2">
            {rowCount}
          </span>
        </Button>
      </Hint>
    ),
    cards,
    findingCards,
    bar,
    dialog,
    fixes: list,
    open,
    openFinding,
    openWith,
    copyPrompt,
    ticks,
    tick: setMany,
    again: (t, anyway) => acts.current.again(t, anyway),
  };
}
