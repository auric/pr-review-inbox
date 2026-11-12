// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The review half of the detail (plan v3 WP11, replies.md WP18, pr-view-v4 2.6): buttons, brief, run record, drafts, questions,
// reply drafts, and run log for one PR.
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import type { CommitDto, MetaDto, PrRow, ReviewItemDto, RunDetail, RunDto } from "../../shared/dto";
import { type ConsultUi, useConsult } from "../consult/Consult";
import type { Card } from "../diff/model";
import { type FixUi, useFix } from "../fix/FixBar";
import type { Layer } from "../keys";
import { useMeta } from "../meta";
import { putNote, useNoteSend } from "../pr/Notes";
import type { ThreadTalkEntry } from "../pr/Thread";
import { ordered, type ThreadModel } from "../pr/threads";
import { usePosts } from "../publish/data";
import type { Hints } from "../shell/Hint";
import { failText, prKey } from "../shell/model";
import { BriefComposer, ReviewButton } from "./Brief";
import { Talk, type TalkCtx, ThreadTalk } from "./Discuss";
import { type DraftCtx, Drafts } from "./Drafts";
import { useCancelRun, usePrRuns, useReplyDrafts, useRun } from "./data";
import { talkThreads } from "./discuss-model";
import { kindRuns, latestExplain, latestReview, replyMap, withQuestions } from "./model";
import { DraftRepliesButton, type ReplyCtx } from "./ReplyDraft";
import { RunRecord } from "./RunLine";
import { RunLog } from "./RunLog";
import { TaskChips } from "./TaskChips";
import { useRunLog } from "./useRunLog";
import { useRunRecord } from "./useRunRecord";
import { RereviewButton, useStart } from "./useStart";
import { useThreadCards } from "./useThreadCards";
import { NO_ITEMS, useTriage } from "./useTriage";
// flash: mark the target as a jump target. It gets a static highlight while it holds the focus, with no animation.
export type Focus = { id: string; block: ScrollLogicalPosition; flash: boolean };

export type ReviewApi = {
  // Keys r and Shift+R: open the brief. Every review starts from it.
  rerun(): void;
  // Key c (plan r2 UI-RR): open the brief for a review of the commits since the newest review run.
  rereview(): void;
  brief(): void;
  drafts(): void;
  log(): void;
  // The log sheet of one run, such as an ask run (plan r2 UI-ASK). raw: show its raw output.
  openRunLog(run: number, raw?: boolean): void;
  // Keys a, e, and d act on the draft, question, or reply draft that holds the focus (prototype/v3 triageKey).
  triage(key: "accept" | "edit" | "discard"): void;
  // A reply-draft run for one thread (replies.md step 6).
  draftReply(thread: number): void;
  // Keys f and F (plan pr-view-v4 section 6): the Fix list. thread absent: the default ticks. null: no current thread.
  // key: a shortcut key opens the list, so it shows no animation.
  fix(thread?: number | null, key?: boolean): void;
  // Key f on a finding draft: the Fix list with only that finding ticked.
  fixFinding(id: number, key?: boolean): void;
  // Plan r2 UI-DIFF: opens a draft and focuses it, for "Go to draft" in the diff.
  openDraft(id: number): void;
  // Key t (docs/plans/review-v2/spec.md section 2.1): the talk about the focused finding, or about the posted finding of the focused
  // thread, with the focus in its box.
  discuss(): void;
  // The layer that Esc closes first, for focus at target.
  layer(target: EventTarget | null): Layer;
  close(layer: Exclude<Layer, null>): void;
};

export type ReviewUi = {
  action: ReactNode;
  brief: ReactNode;
  run: ReactNode;
  // A review run exists, so the run record goes before the Description (plan pr-view-v4 decision D3).
  reviewed: boolean;
  // The open drafts and questions of the newest review run, for the status strip.
  draftCount: number;
  drafts: ReactNode;
  // The reply draft card of each thread, keyed by thread ID.
  cards: ReadonlyMap<number, ReactNode>;
  // The threads of posted findings: the More item that opens the talk, and the open talk.
  talks: ReadonlyMap<number, ThreadTalkEntry>;
  // The threads with a reply draft that the user can accept, or one on the way. Their footer has no Draft reply.
  drafted: ReadonlySet<number>;
  sheet: ReactNode;
  api: ReviewApi;
  // Plan r2 UI-DIFF: the finding drafts, the source head of their run, and the reply draft of each thread. checked: the run had the
  // check step, so each draft card shows its check chip.
  diff: { drafts: ReviewItemDto[]; head: string | null; replies: ReadonlyMap<number, ReviewItemDto>; checked: boolean };
  // Plan pr-view-v4 2.11 and 2.12: the fix parts of the bottom bar, the Fix list and the apply dialog, and the runner prompt.
  fix: { bar: ReactNode; dialog: ReactNode; copyPrompt: FixUi["copyPrompt"] };
  // docs/plans/session-consult.md parts A to C: the More menu items, the Fix list footer link, the session run row, and their dialogs.
  consult: ConsultUi;
};

// A new run shows its line at once. Its log and items come with the next fetch.
// A synced push changes only `stale`, with no run event. Then only the runs list refetches (live.ts), so `stale` comes from it.
const detailOf = (r: RunDto | null, d: RunDetail | undefined): RunDetail | null =>
  r ? (d?.run.id === r.id ? { ...d, run: { ...d.run, stale: r.stale } } : { run: r, events: [], items: [] }) : null;

// The box of the talk about a finding (Discuss.tsx Talk).
const boxOf = (item: number) => `talk-${item}-box`;

const without = (s: ReadonlySet<number>, v: number): ReadonlySet<number> => {
  if (!s.has(v)) return s;
  const out = new Set(s);
  out.delete(v);
  return out;
};

export function useReview(
  pr: PrRow,
  o: {
    commits: CommitDto[] | undefined;
    threads: ThreadModel[];
    hints: Hints;
    now: number;
    focusAfter: (f: Focus) => void;
    // Opens and shows a thread, so its reply draft card mounts.
    reveal: (thread: number) => void;
    // Opens these threads without a focus change, so their fix cards mount.
    show: (threads: number[]) => void;
    announce: (text: string) => void;
    onSettings: () => void;
    // Opens Settings, Task IDs: "Set up task IDs" in the brief.
    onTaskIds: () => void;
    // Opens the settings at one profile: "Edit <profile>" in the brief.
    onProfile: (id: string) => void;
    // Focuses the line of a draft or a thread in the diff.
    showInDiff: (card: Card) => void;
    // Opens the Explain page: "Open the walkthrough" on the Explain row of the run record.
    openExplain: () => void;
  },
): ReviewUi {
  const meta = useMeta().data as MetaDto;
  const prRuns = usePrRuns(pr.id).data;
  // R14: the run list shows the newest run of each kind. The newest review run drives the drafts, the summary, and the brief.
  const newest = prRuns?.[0] ?? null;
  const latest = latestReview(prRuns);
  const kinds = kindRuns(prRuns);
  const run = useRun(latest?.id ?? null);
  // docs/plans/review-v2/spec.md section 3.1: the questions of the newest explain run with a result join the Drafts, marked From Explain.
  const explainRun = latestExplain(prRuns);
  const explained = useRun(explainRun?.id ?? null);
  const replies = useReplyDrafts(pr.id);
  const cancel = useCancelRun();
  const { focusAfter } = o;
  const st = useStart(pr, { meta, latest, newest, commits: o.commits, threads: o.threads, announce: o.announce, focusAfter });
  const runLog = useRunLog(latest, newest);
  const { log, openLog, closeLog } = runLog;

  const detail = detailOf(latest, run.data);
  const reviewItems = detail?.items ?? NO_ITEMS;
  const explainItems = explained.data?.run.id === explainRun?.id ? explained.data?.items : undefined;
  const items = useMemo(() => withQuestions(reviewItems, explainItems), [reviewItems, explainItems]);
  const replyItems = replies.data ?? NO_ITEMS;
  const summary = detail?.run.summary;
  const tr = useTriage(pr, { meta, items, summary, replyItems, threads: o.threads, announce: o.announce, focusAfter });
  const { triage, ds, groups, list, openDraft, triageCtx, onTriage } = tr;

  const onLog = useRef(openLog);
  onLog.current = openLog;
  const onDraft = useRef(st.draftReplies);
  onDraft.current = st.draftReplies;
  const onShow = useRef(o.showInDiff);
  onShow.current = o.showInDiff;
  const author = pr.role === "AUTHOR";
  // useFix comes after the drafts context, so the Fix action of a draft reads it through this ref.
  const onFix = useRef((_: number) => {});
  // The questions ask the author. On your own PR, the runner asks you as the author.
  const asker = pr.role === "AUTHOR" ? "the author" : ((pr.authorName ?? pr.authorSlug ?? "the author").split(/\s+/)[0] ?? "the author");
  const { toggleDraft } = tr;
  const checked = groups.checked;
  const explainId = explainRun?.id ?? null;

  // ---------- Fix it (plan r3 UI-FIX) ----------
  // useConsult comes after useFix, so the Fix list footer reads it through this ref.
  const onConsult = useRef(() => {});
  const fix = useFix(pr, {
    meta,
    hints: o.hints,
    threads: o.threads,
    replies: replies.data,
    findings: ds,
    profile: { name: st.state.name, explain: meta.profiles.find((p) => p.id === st.state.profile)?.explain ?? false },
    busy: st.busy,
    synced: pr.synced,
    announce: o.announce,
    focusAfter,
    onLog: (id) => openLog(null, false, id),
    slotTaken: st.slotTaken,
    show: o.show,
    showFindings: tr.showFindings,
    onConsult: () => onConsult.current(),
  });
  onFix.current = fix.openFinding;
  const consult = useConsult(pr, { announce: o.announce, openFix: fix.openWith });
  onConsult.current = () => consult.copy("fix-btn");

  // ---------- Note suggestions and cites on the draft cards (docs/plans/review-v2/spec.md section 2.7) ----------
  const noteSend = useNoteSend(pr.id);
  const sendNote = useRef(noteSend);
  sendNote.current = noteSend;
  const [noteBusy, setNoteBusy] = useState<ReadonlySet<number>>(new Set());
  const { announce, reveal } = o;
  const notes = useMemo<ReplyCtx["notes"]>(
    () => ({
      busy: noteBusy,
      // The card keeps the focus: the Notes block is far above it.
      choose: async (n, state, card) => {
        setNoteBusy((b) => new Set(b).add(n.id));
        const r = await sendNote.current(() => putNote(n.id, { version: n.version, state }));
        setNoteBusy((b) => new Set([...b].filter((x) => x !== n.id)));
        if (r.error) return void toast.add({ title: r.error });
        announce(state === "kept" ? "Note kept." : "Suggestion dismissed.");
        focusAfter({ id: card, block: "nearest", flash: false });
      },
    }),
    [noteBusy, announce, focusAfter],
  );
  const cite = useMemo<ReplyCtx["cite"]>(
    () => ({
      name: (thread) => {
        const t = o.threads.find((x) => x.id === thread);
        return t?.last ? (t.root.who.me ? "you" : t.root.who.name) : null;
      },
      go: reveal,
    }),
    [o.threads, reveal],
  );

  // ---------- Talks about findings (docs/plans/review-v2/spec.md section 2.1) ----------
  // items: the findings with an open talk under their card. threads: the threads of posted findings with an open talk under them.
  const [talkItems, setTalkItems] = useState<ReadonlySet<number>>(() => new Set());
  const [talkThreadIds, setTalkThreadIds] = useState<ReadonlySet<number>>(() => new Set());
  const posts = usePosts(pr.id).data;
  const talkable = useMemo(() => talkThreads(posts), [posts]);
  const onBrief = useRef(st.openBrief);
  onBrief.current = st.openBrief;
  const talkCtx = useMemo<TalkCtx>(
    () => ({
      pr: pr.id,
      meta,
      announce,
      onLog: (run) => onLog.current(null, false, run),
      onBrief: () => onBrief.current(),
      toDraft: (id) => focusAfter({ id: `rd-${id}`, block: "nearest", flash: true }),
      notes,
      cite,
    }),
    [pr.id, meta, announce, focusAfter, notes, cite],
  );
  const { openDraft: showDraft } = tr;
  // openDraft opens the fold of the finding and its row. The focus then goes to the box.
  const openTalk = useCallback(
    (id: number) => {
      showDraft(id);
      setTalkItems((s) => (s.has(id) ? s : new Set(s).add(id)));
      focusAfter({ id: boxOf(id), block: "nearest", flash: false });
    },
    [showDraft, focusAfter],
  );
  const talkOpen = useRef(talkItems);
  talkOpen.current = talkItems;
  // Stable, so a change of the threads or the notes renders again only the cards with an open talk.
  const talk = useMemo<DraftCtx["talk"]>(
    () => ({ toggle: (id) => (talkOpen.current.has(id) ? setTalkItems((s) => without(s, id)) : openTalk(id)) }),
    [openTalk],
  );
  const talkCards = useMemo(() => {
    const out = new Map<number, ReactNode>();
    for (const id of talkItems) {
      const it = ds.find((x) => x.id === id);
      const close = () => {
        setTalkItems((s) => without(s, id));
        focusAfter({ id: `talk-link-${id}`, block: "nearest", flash: false });
      };
      if (it) out.set(id, <Talk it={it} onClose={close} ctx={talkCtx} />);
    }
    return out;
  }, [talkItems, ds, talkCtx, focusAfter]);
  const openThreadTalk = (thread: number) => {
    const t = talkable.get(thread);
    if (!t) return;
    o.show([thread]);
    setTalkThreadIds((s) => (s.has(thread) ? s : new Set(s).add(thread)));
    focusAfter({ id: boxOf(t.item), block: "nearest", flash: false });
  };
  const onThreadTalk = useRef(openThreadTalk);
  onThreadTalk.current = openThreadTalk;
  // The More button of the thread stays mounted, so it takes the focus back at once.
  const closeThreadTalk = useCallback((thread: number) => {
    setTalkThreadIds((s) => without(s, thread));
    document.querySelector<HTMLElement>(`#t-${thread} [data-thread-more]`)?.focus({ preventScroll: true });
  }, []);
  const short = meta.runner.short;
  const talks = useMemo(() => {
    const out = new Map<number, ThreadTalkEntry>();
    for (const [thread, t] of talkable)
      out.set(thread, {
        label: `Ask ${short} about this comment`,
        open: () => onThreadTalk.current(thread),
        chat: talkThreadIds.has(thread) ? (
          <ThreadTalk item={t.item} run={t.run} onClose={() => closeThreadTalk(thread)} ctx={talkCtx} />
        ) : null,
      });
    return out;
  }, [talkable, talkThreadIds, short, closeThreadTalk, talkCtx]);

  const draftCtx = useMemo<DraftCtx>(
    () => ({
      meta,
      asker,
      checked,
      explainRun: explainId,
      onToggle: toggleDraft,
      onFrom: (agent) => onLog.current(agent, false, "review"),
      onShowInDiff: (id) => onShow.current({ kind: "draft", id }),
      onFix: author ? (id) => onFix.current(id) : null,
      triage: triageCtx,
      talk,
      revision: { take: (rev, it) => onTriage.current.takeRevision(rev, it), keep: (rev) => onTriage.current.keepMine(rev) },
    }),
    [meta, asker, checked, explainId, toggleDraft, triageCtx, author, talk, onTriage],
  );

  // ---------- Reply drafts (replies.md step 6) ----------
  const replyCtx = useMemo<ReplyCtx>(
    () => ({
      meta,
      hints: o.hints,
      announce: o.announce,
      triage: triageCtx,
      again: (thread) => onDraft.current([thread]),
      plain: (it) => onTriage.current.plain(it),
      revision: { take: (rev, it) => onTriage.current.takeRevision(rev, it), keep: (rev) => onTriage.current.keepMine(rev) },
      newest: (it) => onTriage.current.newest(it),
      diff: (thread) => onShow.current({ kind: "thread", id: thread }),
      author,
      notes,
      cite,
    }),
    [meta, o.hints, o.announce, triageCtx, onTriage, author, notes, cite],
  );
  const byThread = useMemo(() => replyMap(replies.data), [replies.data]);
  const { cards, drafted, findingCards, need } = useThreadCards(pr, {
    threads: o.threads,
    commits: o.commits,
    byThread,
    pending: st.pending,
    findings: ds,
    triage,
    replyCtx,
    fix,
    author,
    send: tr.send,
    onTriage,
    announce: o.announce,
    focusAfter,
  });

  const api: ReviewApi = {
    rerun: () => st.openBrief(),
    rereview: st.rereview,
    brief: () => st.openBrief(),
    drafts() {
      // prototype/v3 goDrafts: the first row of the Drafts section that is not discarded. A fold draft counts only when no other row exists.
      // The reply drafts come next, in screen order. A press in the Drafts section goes on to them.
      const first = list.find((i) => i.status !== "discarded") ?? list[0] ?? groups.fold[0];
      const rs = ordered(o.threads, false).flatMap((t) => {
        const it = byThread.get(t.id);
        return it ? [{ thread: t.id, it }] : [];
      });
      const reply = rs.find((r) => r.it.status !== "discarded") ?? rs[0];
      const inReview = !!document.activeElement?.closest("#s-drafts");
      if (reply && (inReview || !first)) {
        o.reveal(reply.thread);
        focusAfter({ id: `rd-${reply.it.id}`, block: "start", flash: true });
      } else if (first) openDraft(first.id);
      else toast.add({ title: `No drafts. Press r to start a review with ${meta.runner.name}.` });
    },
    log: () => openLog(null),
    openRunLog: (id, raw = false) => openLog(null, raw, id),
    triage: tr.triageKey,
    draftReply: (thread) => st.draftReplies([thread]),
    fix: (thread, key) => fix.open(thread, key),
    fixFinding: (id, key) => fix.openFinding(id, key),
    openDraft,
    discuss() {
      const at = document.activeElement;
      const d = Number(at?.closest("[data-draft]")?.getAttribute("data-draft"));
      if (d) return openTalk(d);
      const t = Number(at?.closest("[data-thread]")?.getAttribute("data-thread"));
      if (t && talkable.has(t)) return openThreadTalk(t);
      toast.add({
        title: at?.closest("[data-draft-question]")
          ? `A question has no talk. Move to a finding. Then t asks ${short} about it.`
          : `Move to a finding first. Then t asks ${short} about it.`,
      });
    },
    layer(target) {
      const inSheet = target instanceof Node && !!document.getElementById("run-log")?.contains(target);
      if (st.composer && !inSheet) return "brief";
      return log ? "log" : null;
    },
    close: (layer) => (layer === "brief" ? st.closeBrief() : closeLog()),
  };

  const head = latest?.sourceHead ?? null;
  const forDiff = useMemo(() => ({ drafts: ds, head, replies: byThread, checked }), [ds, head, byThread, checked]);
  const { rows, details, qJump, ledger } = useRunRecord(pr.id, {
    meta,
    kinds,
    review: run.data,
    explain: explained.data,
    pinned: runLog.pinned.data,
    groups,
    items,
    fixes: fix.fixes,
    commits: o.commits,
    now: o.now,
    openDraft,
    restore: (it) => triageCtx.act(it, "restore"),
    busy: triage.busy,
  });
  const { rr } = st;
  return {
    action: (
      <ReviewButton
        state={st.state}
        meta={meta}
        extra={
          <>
            {"since" in rr && <RereviewButton since={rr.since} busy={st.rereviewPending} onClick={st.rereview} />}
            <DraftRepliesButton turns={o.threads.map((t) => t.turn)} need={need} onRun={() => st.draftReplies()} />
            {fix.button}
          </>
        }
        onOpen={() => st.openBrief()}
      />
    ),
    // Plan r3 Feature C: every run kind reads the fetched task text. While the brief is closed, its task row shows here.
    brief: st.composer ? (
      st.brief.data ? (
        <BriefComposer
          pr={pr.id}
          brief={st.brief.data}
          tasks={pr.tasks}
          meta={meta}
          mode={st.mode}
          blocked={st.blocked}
          starting={st.starting}
          onStart={st.startNow}
          onClose={st.closeBrief}
          onSettings={o.onSettings}
          onTaskIds={o.onTaskIds}
          onEditProfile={o.onProfile}
          announce={o.announce}
        />
      ) : (
        <Skeleton className="mt-1.5 h-40 w-full rounded-lg" />
      )
    ) : (
      <TaskChips
        pr={pr.id}
        tasks={pr.tasks}
        meta={meta}
        id="tk-runs"
        focusTo="review-btn"
        compact
        announce={o.announce}
        onSettings={o.onSettings}
      />
    ),
    run: (
      <RunRecord
        rows={rows}
        meta={meta}
        now={o.now}
        cancelling={cancel.isPending}
        onLog={(id, raw) => openLog(null, raw, id)}
        onCancel={(id) => cancel.mutate(id, { onError: (e) => toast.add({ title: "Cancel failed", description: failText(e) }) })}
        onAnswer={(id) => consult.session("session-answer-btn", id)}
        onExplain={o.openExplain}
      />
    ),
    reviewed: latest !== null,
    draftCount: ds.filter((d) => d.status !== "discarded").length + (qJump?.n ?? 0),
    drafts: (
      <Drafts
        groups={groups}
        questions={tr.qs}
        ledger={ledger}
        foldOpen={tr.foldOpen}
        onFold={tr.toggleFold}
        isOpen={tr.isDraftOpen}
        triage={triage}
        cards={findingCards}
        talks={talkCards}
        ctx={draftCtx}
      />
    ),
    cards,
    talks,
    drafted,
    sheet: log && (
      <RunLog
        detail={details.find((d) => d && d.run.id === runLog.logRun)}
        meta={meta}
        prKey={prKey(pr)}
        now={o.now}
        target={log}
        onRaw={(show) => runLog.setLog((l) => l && { ...l, agent: null, raw: show, n: show ? l.n + 1 : l.n })}
        onClose={closeLog}
      />
    ),
    api,
    diff: forDiff,
    fix: { bar: fix.bar, dialog: fix.dialog, copyPrompt: fix.copyPrompt },
    consult,
  };
}
