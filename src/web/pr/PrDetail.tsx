// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// PR detail (plan v3 WP5, r2 UI-ASK, r2 UI-DIFF, pr-view-v4 section 2): header, status strip, and the panel slot (the brief or Ask),
// then one column of the run record, Description, Notes, Drafts, Threads, Files, and Commits. The run record goes after the Description
// until a review exists (decision D3). Notes: docs/plans/review-v2/spec.md section 2.7. The Explain page (spec.md section 3.1)
// replaces the view and keeps the PR mounted, so Back finds the PR as it was.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  type Ref,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import type { CommentDto, PrRow } from "../../shared/dto";
import { archived } from "../../shared/views";
import { AskPanel } from "../ask/AskPanel";
import { useAsks } from "../ask/data";
import { fileCount, useDiffIndex } from "../diff/data";
import { type DiffCtx, DiffSection, useDiffView } from "../diff/FileDiff";
import type { Card } from "../diff/model";
import { detailStep, type Layer } from "../keys";
import { type FileRef, restoreScroll } from "../lib/route";
import { diffRefresh } from "../live";
import { useMeta } from "../meta";
import { setThreadResolved } from "../publish/data";
import { PostsGroup, useOutbox } from "../publish/Outbox";
import { usePostBar } from "../publish/PostBar";
import { type Focus, useReview } from "../review/useReview";
import { ApiError, sendSeen, usePr } from "../shell/data";
import { createHints, SharedHint } from "../shell/Hint";
import { useMinute } from "../shell/ListPane";
import { ArchiveNotice, Calm } from "../states";
import { Header, Strip, webLink } from "./Header";
import { Notes } from "./Notes";
import type { ReplyTarget } from "./ReplyComposer";
import { CommitsFold, Description } from "./Sections";
import { type ThreadCtx, useSettled } from "./Thread";
import { Threads } from "./ThreadList";
import { buildThreads, mergeHighlights, newMessages, ordered, type Person, passes, reveal, shownThreads, summary } from "./threads";
import { useAck } from "./useAck";

// The Explain page, its Markdown, and its diagram code load with the first open.
const ExplainPage = lazy(() => import("../explain/ExplainPage").then((m) => ({ default: m.ExplainPage })));

// The shell calls these for the detail keys (keys.ts effects).
export type DetailApi = {
  // Opens the thread that put the PR in the inbox and focuses its message. Waits for the data when it is not loaded yet.
  cause(): void;
  step(d: 1 | -1): void;
  toggle(): void;
  nextNew(d: 1 | -1): void;
  nextYour(): void;
  section(id: "files" | "commits"): void;
  // Plan r2 UI-DIFF: g d focuses the line of the focused inline thread or draft in the diff.
  showInDiff(): void;
  // Plan pr-view-v4 2.4: q opens Ask in the panel slot with the focus in its box.
  ask(): void;
  // Plan pr-view-v4 section 6: f opens the Fix list with the current thread or finding ticked. F opens it with the default ticks.
  fix(list: boolean): void;
  // x: the Resolve or Reopen button of the current thread. A closed thread opens first.
  resolve(): void;
  // Plan v3 WP11: r, Shift+R, 2, 3, and the Esc layers of the review. Plan r2 UI-RR: c.
  rerun(): void;
  rereview(): void;
  brief(): void;
  drafts(): void;
  log(): void;
  // Plan v3 WP14a: a, e, d, and p.
  triage(key: "accept" | "edit" | "discard"): void;
  post(): void;
  // docs/plans/review-v2/spec.md section 2.1: t opens the talk about the focused finding.
  discuss(): void;
  layer(target: EventTarget | null): Layer;
  close(layer: Exclude<Layer, null>): void;
};

// The URL state that the detail restores on mount and on each Back or Forward (plan pr-view-v4 section 5).
// key: the PR (prKeyOf). close: the file of the entry that Back or Forward left. scroll: the saved scrollTop, null for none.
// explain: an entry of the Explain page. It restores only the scroll position.
export type DetailAt = {
  key: string;
  thread: number | null;
  file: FileRef | null;
  close: string | null;
  scroll: number | null;
  n: number;
  explain?: boolean;
};
export type DetailPatch = { thread?: number | null; file?: FileRef | null };

// The rows of an open Files section, in screen order. Both file lists put the row button first in its item.
const FILE_ROWS = "#s-files[open] ul[aria-label='Changed files'] > li > button";
// The head buttons of the Drafts rows, in screen order. The row is the [data-item] element around the head.
const DRAFT_ROWS = "#s-drafts [data-row-head]";
const draftRow = (el: Element | null) => el?.closest("#s-drafts [data-item]") ?? null;

const NO_COMMENTS: CommentDto[] = [];
const NONE: ReadonlySet<number> = new Set();

const toggled = <T,>(s: ReadonlySet<T>, v: T) => {
  const out = new Set(s);
  if (!out.delete(v)) out.add(v);
  return out;
};

// A jump target keeps a static highlight while it holds the focus ([data-jump]:focus in index.css). Jumps repeat often, so no animation.
function markJump(el: HTMLElement) {
  el.setAttribute("data-jump", "");
  el.addEventListener("blur", () => el.removeAttribute("data-jump"), { once: true });
}

// full, onFull: full width (plan pr-view-v4 4.3), for the action bar button.
// onLeave: the shell moves the selection away before the PR leaves the list. onSettings: the brief links to the task ID rules.
// onTaskIds: a header task chip without a link opens Settings, Task IDs. onProfile: "Edit <profile>" in the brief opens the
// settings at one profile. onRestore: the Archive view brings the PR back.
// at: the URL state to restore. file: the file path in the URL. onRoute: the current thread and the opened file go to the URL.
// explain: the Explain page shows. onExplain: opens it, or goes back to the PR; push: a step to the PR that pushes a history entry.
// onDiff: goes from the Explain page to the Files diff at a file or a line, with a history entry.
export function PrDetail({
  pr: row,
  me,
  at,
  file,
  full,
  explain,
  onFull,
  onRoute,
  onExplain,
  onDiff,
  onLeave,
  onSettings,
  onTaskIds,
  onProfile,
  onRestore,
  ref,
}: {
  pr: PrRow;
  me: string | null;
  at: DetailAt | null;
  file: string | null;
  full: boolean;
  explain: boolean;
  onFull: () => void;
  onRoute: (patch: DetailPatch) => void;
  onExplain: (open: boolean, push?: boolean) => void;
  onDiff: (to: FileRef) => void;
  onLeave: () => void;
  onSettings: () => void;
  onTaskIds: () => void;
  onProfile: (id: string) => void;
  onRestore: (pr: PrRow) => void;
  ref: Ref<DetailApi | null>;
}) {
  const q = usePr(row.id);
  const data = q.data;
  const pr = data?.pr ?? row;
  const comments = data?.comments ?? NO_COMMENTS;
  const meta = useMeta().data;
  const forge = meta?.forge.name ?? "";
  const runner = meta?.runner.name ?? "";
  const now = useMinute();
  const [hints] = useState(createHints);
  const steady = useSettled(data ? row.id : null);
  // The last visit before this one. The POST below moves the stored value to now.
  const [since] = useState(row.seenAt);
  const { mutate: markSeen } = useMutation({ mutationFn: () => sendSeen(row.id) });
  useEffect(() => markSeen(), [markSeen]);

  // Highlights keep the messages that were new at open, so they stay marked after the read.
  const [hl, setHl] = useState(NONE);
  const next = mergeHighlights(hl, comments);
  if (next !== hl) setHl(next);
  const { role, authorSlug, authorName } = pr;
  const threads = useMemo(
    () => buildThreads(comments, next, me, { role, authorSlug, authorName }),
    [comments, next, me, role, authorSlug, authorName],
  );
  const latest = useRef(threads);
  latest.current = threads;
  const ackRef = useAck(row.id, comments);

  const [open, setOpen] = useState<ReadonlyMap<number, boolean>>(new Map());
  const [spines, setSpines] = useState(NONE);
  const [branches, setBranches] = useState(NONE);
  const [needMe, setNeedMe] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [cur, setCur] = useState<number | null>(null);
  const [secs, setSecs] = useState<ReadonlySet<string>>(new Set());
  const [targets, setTargets] = useState<ReadonlyMap<number, ReplyTarget>>(new Map());
  // The panel slot holds the brief or Ask. The review hook owns the brief state, so this holds only Ask.
  const [askOpen, setAskOpen] = useState(false);
  // n gives each text a new node, so a screen reader reads the same text again.
  const [said, setSaid] = useState({ text: "", n: 0 });

  // Focus moves after the render that shows its target.
  const focus = useRef<Focus | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const focusAfter = useCallback((f: Focus) => {
    focus.current = f;
    rerender();
  }, []);
  useLayoutEffect(() => {
    const f = focus.current;
    focus.current = null;
    const el = f && document.getElementById(f.id);
    if (!f || !el) return;
    el.scrollIntoView({ block: f.block });
    el.focus({ preventScroll: true });
    if (f.flash) markJump(el);
  });

  // focus false: Back and Forward open the thread and leave the scroll position to the saved one.
  const jump = useCallback(
    (tid: number, msg?: number, focus = true) => {
      const t = latest.current.find((x) => x.id === tid);
      if (!t) return;
      const m = msg === undefined ? undefined : t.msgs.find((x) => x.id === msg)?.id;
      setNeedMe((on) => on && passes(t, true));
      if (t.turn === "resolved") setShowResolved(true);
      if (m !== undefined) {
        const r = reveal(t, m);
        if (r.spine) setSpines((s) => new Set(s).add(tid));
        if (r.branches.length) setBranches((b) => new Set([...b, ...r.branches]));
      }
      setOpen((o) => new Map(o).set(tid, true));
      setCur(tid);
      if (focus) focusAfter({ id: m === undefined ? `t-${tid}` : `c-${m}`, block: "start", flash: m !== undefined });
    },
    [focusAfter],
  );

  const outbox = useOutbox(row.id, comments, forge);
  const qc = useQueryClient();
  const head = data?.sourceHead;
  const lastHead = useRef(head);
  useEffect(() => {
    const f = diffRefresh(row.id, lastHead.current, head);
    if (head !== undefined) lastHead.current = head;
    if (f) void qc.invalidateQueries(f);
  }, [qc, row.id, head]);
  // My avatar comes from my own messages. Without one, the slug stands in.
  const mine = useMemo<Person>(
    () => threads.flatMap((t) => t.msgs).find((m) => m.who.me)?.who ?? { slug: me ?? "", name: me ?? "You", me: true },
    [threads, me],
  );
  const onReply = useCallback(
    (tid: number, msg: number | null) =>
      setTargets((m) => {
        const out = new Map(m);
        if (msg === null) out.delete(tid);
        else out.set(tid, { msg, n: (m.get(tid)?.n ?? 0) + 1 });
        return out;
      }),
    [],
  );
  const announce = useCallback((text: string) => setSaid((s) => ({ text, n: s.n + 1 })), []);
  // The review hook comes after the thread context, so the context reads its action through this ref.
  const draftReply = useRef((_: number) => {});
  // The diff view needs the drafts of the review hook. The thread context and the drafts read its action through this ref.
  const showDiff = useRef((_: Card) => {});
  const fixRef = useRef<{ open: (thread: number) => void; copy: ThreadCtx["copyPrompt"] }>({
    open: () => {},
    copy: async () => null,
  });
  const logRef = useRef((_: number) => {});
  // Opens threads without a focus change. A thread that the "Need me" filter hides turns the filter off.
  const show = useCallback((ids: number[]) => {
    const hidden = latest.current.some((t) => ids.includes(t.id) && !passes(t, true));
    if (hidden) setNeedMe(false);
    setOpen((o) => {
      const out = new Map(o);
      for (const id of ids) out.set(id, true);
      return out;
    });
  }, []);

  const web = webLink(pr.webUrl);
  const ctx = useMemo<ThreadCtx>(
    () => ({
      pr: row.id,
      hints,
      now,
      forge,
      web,
      runner,
      me: mine,
      ackRef,
      onToggle: (tid) => {
        const t = latest.current.find((x) => x.id === tid);
        if (t) setOpen((o) => new Map(o).set(tid, !(o.get(tid) ?? t.open)));
        setCur(tid);
      },
      onFold: (tid, fold) => {
        if (fold.kind === "spine") setSpines((s) => toggled(s, tid));
        else setBranches((b) => toggled(b, fold.at));
        setCur(tid);
        // An opened fold row moves above its first message, so the button mounts again.
        focusAfter({ id: `fold-${fold.at}`, block: "nearest", flash: false });
      },
      onQuote: jump,
      announce,
      onReply,
      onDraftReply: (tid) => draftReply.current(tid),
      onShowInDiff: (tid) => showDiff.current({ kind: "thread", id: tid }),
      author: role === "AUTHOR",
      onFix: (tid) => fixRef.current.open(tid),
      copyPrompt: (tid) => fixRef.current.copy(tid),
      posts: outbox.ctx,
      // A done change comes back through SSE. A refused one reloads the thread, so the user reads it before the next try.
      setResolved: async (tid, resolved, seen) => {
        const out = await setThreadResolved(row.id, { thread: tid, resolved, seen });
        if (out) void qc.invalidateQueries({ queryKey: ["pr", row.id] });
        return out;
      },
      onLog: (run) => logRef.current(run),
    }),
    [row.id, hints, now, forge, web, runner, mine, ackRef, focusAfter, jump, announce, onReply, outbox.ctx, role, qc],
  );

  const review = useReview(pr, {
    commits: data?.commits,
    threads,
    hints,
    now,
    focusAfter,
    reveal: jump,
    show,
    announce,
    onSettings,
    onTaskIds,
    onProfile,
    showInDiff: (card) => showDiff.current(card),
    openExplain: () => onExplain(true),
  });
  draftReply.current = review.api.draftReply;
  fixRef.current = { open: review.api.fix, copy: review.fix.copyPrompt };
  logRef.current = review.api.openRunLog;
  // One slot: a brief that opens closes Ask.
  const briefOpen = review.api.layer(null) === "brief";
  if (briefOpen && askOpen) setAskOpen(false);
  const answering = useAsks(row.id).data?.some((a) => a.run.status === "running") ?? false;
  const openFiles = useCallback(() => setSecs((s) => (s.has("files") ? s : new Set(s).add("files"))), []);
  const diff = useDiffView(row.id, { ...review.diff, threads, forge, openFold: openFiles, focusAfter });
  // The same query as Files, so the summary line and the head of Files show the same count.
  const files = fileCount(useDiffIndex(row.id, secs.has("files")).data, data?.files);
  showDiff.current = diff.show;
  const { openDraft } = review.api;
  const diffCtx = useMemo<DiffCtx | null>(
    () =>
      meta
        ? {
            pr: row.id,
            meta,
            hints,
            now,
            threads,
            ...review.diff,
            onThread: jump,
            onDraft: openDraft,
            focusAfter,
            announce,
          }
        : null,
    [row.id, meta, hints, now, threads, review.diff, jump, openDraft, focusAfter, announce],
  );
  const bar = usePostBar(pr, {
    comments,
    forge,
    announce: ctx.announce,
    jump,
    reopen: async (tid) => {
      const t = latest.current.find((x) => x.id === tid);
      if (!t?.last) return { error: "The thread is not loaded yet.", reason: null };
      return t.root.who.me ? ctx.setResolved(tid, false, t.last.id) : "ask";
    },
    onPosted: (rows) => rows[0] && focusAfter({ id: `p-${rows[0].id}`, block: "nearest", flash: false }),
  });

  // ---------- URL state (plan pr-view-v4 section 5) ----------
  const routeRef = useRef(onRoute);
  routeRef.current = onRoute;
  const body = useRef<HTMLDivElement>(null);
  const stopRestore = useRef(() => {});
  useEffect(() => () => stopRestore.current(), []);
  // The request waits for the data. This effect comes before the one that applies it.
  const want = useRef<DetailAt | null>(null);
  useLayoutEffect(() => {
    want.current = at;
  }, [at]);
  // The Explain page shares the scroll box with the PR. It opens at the top. The PR keeps its scroll position for a Back that is no
  // history step (the Back of a restored entry restores it). The focus goes back to "Explain this PR".
  const wasExplain = useRef(explain);
  const prTop = useRef(0);
  const wantDrafts = useRef(false);
  useLayoutEffect(() => {
    if (wasExplain.current === explain) return;
    wasExplain.current = explain;
    const box = body.current?.closest<HTMLElement>("[data-scroll]");
    const restoring = !!want.current;
    if (explain) {
      if (box && !restoring) {
        prTop.current = box.scrollTop;
        box.scrollTop = 0;
      }
      return;
    }
    if (box && !restoring && !wantDrafts.current) box.scrollTop = prTop.current;
    document.getElementById("explain-btn")?.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    const a = want.current;
    if (!a || !data) return;
    want.current = null;
    if (a.explain) {
      const box = body.current?.closest<HTMLElement>("[data-scroll]");
      if (box) {
        stopRestore.current();
        stopRestore.current = restoreScroll(box, a.scroll ?? 0);
      }
      return;
    }
    if (bar.api.isOpen) bar.api.close();
    const l = review.api.layer(null);
    if (l) review.api.close(l);
    setAskOpen(false);
    // Without a saved scroll position, as in a new tab, the file or else the thread gets the focus.
    const fresh = a.scroll === null;
    if (a.thread !== null) jump(a.thread, undefined, fresh && !a.file);
    if (a.close !== null) diff.closeFile(a.close);
    if (a.file) diff.goFile(a.file, fresh);
    const box = body.current?.closest<HTMLElement>("[data-scroll]");
    if (!fresh && box) {
      stopRestore.current();
      stopRestore.current = restoreScroll(box, a.scroll ?? 0);
    }
  });
  // "Go to the drafts" on the Explain page: the PR shows first, then key 2 does its move.
  useLayoutEffect(() => {
    if (explain || !wantDrafts.current) return;
    wantDrafts.current = false;
    review.api.drafts();
  });
  const goDrafts = () => {
    wantDrafts.current = true;
    onExplain(false, true);
  };
  // Markdown keeps its links while this stays the same.
  const diffTo = useRef(onDiff);
  diffTo.current = onDiff;
  const openDiff = useCallback((to: FileRef) => diffTo.current(to), []);
  // Thread focus replaces the URL. The first value is the one of the route, so it is not sent.
  const sentCur = useRef(cur);
  useEffect(() => {
    if (cur === sentCur.current) return;
    sentCur.current = cur;
    routeRef.current({ thread: cur });
  }, [cur]);
  // A file that opens goes to the URL, and the shell pushes an entry. The close of that file clears it.
  const sentOpen = useRef(diff.open);
  useEffect(() => {
    const was = sentOpen.current;
    if (was === diff.open) return;
    sentOpen.current = diff.open;
    const added = [...diff.open].find((n) => !was.has(n));
    if (added !== undefined) {
      if (added !== file) routeRef.current({ file: { path: added, line: null, side: "new" } });
    } else if (file !== null && was.has(file) && !diff.open.has(file)) routeRef.current({ file: null });
  }, [diff.open, file]);

  const isOpen = (t: { id: number; open: boolean }) => open.get(t.id) ?? t.open;
  // The cause waits for the data. Cached data from an earlier visit can miss it, so the first fetch after mount must end too.
  const wantCause = useRef(false);
  const settled = q.isFetchedAfterMount || !q.isFetching;
  useLayoutEffect(() => {
    if (!wantCause.current || !data || !settled) return;
    wantCause.current = false;
    const c = data.pr.cause;
    if (c) jump(c.thread, c.msg);
  });

  // n and N wrap around. They start after the focused message.
  const nextNew = (d: 1 | -1) => {
    const list = newMessages(ordered(threads, needMe));
    if (!list.length) {
      toast.add({ title: "No new message is left in this view." });
      return;
    }
    const at = document.activeElement?.closest("[data-id]")?.getAttribute("data-id");
    const i = list.findIndex(([, id]) => String(id) === at);
    const hit = list[i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length];
    if (hit) jump(hit[0], hit[1]);
  };
  // The q key, the Ask button, and "Answering…" in the strip. The focus that closeBrief sets gives way to the box.
  const openAsk = () => {
    if (!data) {
      toast.add({ title: "The pull request is still loading." });
      return;
    }
    if (briefOpen) review.api.close("brief");
    setAskOpen(true);
    focusAfter({ id: "ask-q", block: "nearest", flash: false });
  };
  const closeAsk = () => {
    setAskOpen(false);
    focusAfter({ id: "ask-btn", block: "nearest", flash: false });
  };
  const nextYour = () => {
    const ids = ordered(threads, needMe)
      .filter((t) => t.turn === "your")
      .map((t) => t.id);
    const id = ids[(cur === null ? 0 : ids.indexOf(cur) + 1) % ids.length];
    if (id === undefined) toast.add({ title: "No thread waits on you." });
    else jump(id);
  };
  // The threads part of the strip: the first open thread in screen order. With none open, the first resolved one.
  const goThreads = () => {
    const t = ordered(threads, false).find((x) => x.turn !== "resolved") ?? threads.find((x) => x.turn === "resolved");
    if (t) jump(t.id);
  };

  // x on a closed thread: the button mounts with the open thread, so the click waits for that render.
  const wantResolve = useRef<number | null>(null);
  useLayoutEffect(() => {
    const id = wantResolve.current;
    if (id === null) return;
    wantResolve.current = null;
    const button = document.querySelector<HTMLButtonElement>(`#t-${id} [data-resolve-thread]`);
    if (button) button.click();
    else toast.add({ title: "Every message of this thread is deleted. It cannot be resolved here." });
  });

  useImperativeHandle(ref, () => ({
    cause() {
      wantCause.current = true;
      rerender();
    },
    // Plan pr-view-v4 section 6: j and k move over the Drafts rows, the threads, and the rows of an open Files section.
    step(d) {
      const heads = [...document.querySelectorAll<HTMLElement>(DRAFT_ROWS)];
      const ids = shownThreads(threads, needMe, showResolved).map((t) => t.id);
      const rows = [...document.querySelectorAll<HTMLElement>(FILE_ROWS)];
      const item = draftRow(document.activeElement);
      const h = item ? heads.findIndex((b) => draftRow(b) === item) : -1;
      const f = rows.indexOf(document.activeElement as HTMLElement);
      const t = cur === null ? -1 : ids.indexOf(cur);
      const at = h >= 0 ? h : f >= 0 ? heads.length + ids.length + f : t >= 0 ? heads.length + t : -1;
      // k without a current item goes to the last thread.
      const next = detailStep(heads.length + ids.length + rows.length, at, d, ids.length ? heads.length + ids.length - 1 : undefined);
      if (next === null) return;
      const el = next < heads.length ? heads[next] : rows[next - heads.length - ids.length];
      const id = ids[next - heads.length];
      if (el) {
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
      } else if (id !== undefined) {
        setCur(id);
        focusAfter({ id: `t-${id}`, block: "nearest", flash: false });
      }
    },
    toggle() {
      // o on a file row opens or closes its diff, like Enter. o on a Drafts row opens or closes it, like a click on its head.
      const row = document.activeElement;
      if (row instanceof HTMLElement && row.matches(FILE_ROWS)) return row.click();
      const head = draftRow(row)?.querySelector<HTMLElement>("[data-row-head]");
      if (head) {
        head.click();
        return head.focus({ preventScroll: true });
      }
      const at = document.activeElement?.closest("[data-thread]")?.getAttribute("data-thread");
      const id = cur ?? (at ? Number(at) : null);
      if (id === null) return;
      ctx.onToggle(id);
      focusAfter({ id: `th-${id}`, block: "nearest", flash: false });
    },
    nextNew,
    nextYour,
    post: bar.api.open,
    section(id) {
      // Plan r2 UI-DIFF: Files shows for every loaded PR. Without the code it offers the fetch.
      if (id === "files" ? !data : !data?.commits?.length) {
        toast.add({ title: id === "files" ? "The pull request is still loading." : "No commit list for this pull request yet." });
        return;
      }
      // Plan pr-view-v4 section 6: g f focuses the first file row. Without a file list, the focus goes to Get the code.
      if (id === "files") return diff.firstRow();
      setSecs((s) => new Set(s).add(id));
      focusAfter({ id: `s-${id}-sum`, block: "start", flash: false });
    },
    showInDiff() {
      const at = document.activeElement;
      const d = at?.closest("[data-draft]")?.getAttribute("data-draft");
      const t = at?.closest("[data-thread]")?.getAttribute("data-thread") ?? (cur === null ? null : String(cur));
      if (at?.closest("[data-draft-question]")) toast.add({ title: "A question has no line in the diff. It posts as a general comment." });
      else if (d) diff.show({ kind: "draft", id: Number(d) });
      else if (t) diff.show({ kind: "thread", id: Number(t) });
      else toast.add({ title: "Move to an inline thread or a draft first. Then g d shows its line in the diff." });
    },
    ask: openAsk,
    ...review.api,
    fix(list) {
      if (list) return review.api.fix(undefined, true);
      const at = document.activeElement;
      const d = at?.closest("[data-draft]")?.getAttribute("data-draft");
      if (d) return review.api.fixFinding(Number(d), true);
      if (role === "AUTHOR" && at?.closest("[data-draft-question]")) {
        toast.add({ title: "A question has no code to fix. Fix works on threads and findings." });
        return;
      }
      const t = at?.closest("[data-thread]")?.getAttribute("data-thread");
      review.api.fix(t ? Number(t) : cur, true);
    },
    resolve() {
      const at = document.activeElement?.closest("[data-thread]")?.getAttribute("data-thread");
      const id = at ? Number(at) : cur;
      if (id === null) {
        toast.add({ title: "Move to a thread first. Then x resolves or reopens it." });
        return;
      }
      const button = document.querySelector<HTMLButtonElement>(`#t-${id} [data-resolve-thread]`);
      if (button) return button.click();
      wantResolve.current = id;
      jump(id, undefined, false);
    },
    // prototype/v3 Esc order: an edit, the brief, the post confirm, the run log. Ask comes after the dialogs (plan pr-view-v4 4.4).
    // Ask uses the "brief" layer of keys.ts: both are the panel slot, and only one is open.
    // The Explain page hides the brief, Ask, and the post confirm. Only the run log shows over it.
    layer(target) {
      if (explain) return review.sheet ? "log" : null;
      const l = review.api.layer(target);
      if (l === "brief") return l;
      if (bar.api.isOpen) return "confirm";
      return l ?? (askOpen ? "brief" : null);
    },
    close(layer) {
      if (layer === "confirm") bar.api.close();
      else if (layer === "brief" && askOpen) closeAsk();
      else review.api.close(layer);
    },
  }));
  const explainPage = explain && meta && (
    <Suspense
      fallback={
        <div role="status" aria-busy="true" aria-label="Loading the walkthrough" className="grid max-w-[72ch] gap-3 px-6 pt-6">
          <Skeleton className="h-6 w-3/5" />
          <Skeleton className="h-24 w-full" />
        </div>
      }
    >
      <ExplainPage
        pr={pr}
        meta={meta}
        now={now}
        announce={announce}
        onBack={() => onExplain(false)}
        onDiff={openDiff}
        onLog={review.api.openRunLog}
        onDrafts={goDrafts}
      />
    </Suspense>
  );

  const openSec = (id: string) => (on: boolean) => setSecs((s) => (on === s.has(id) ? s : toggled(s, id)));
  const fresh = comments.filter((c) => next.has(c.id) && !c.deleted).length;
  const notFound = q.error instanceof ApiError && q.error.status === 404;
  const sum = summary(threads);
  return (
    <>
      <div hidden={explain}>
        <Header
          pr={pr}
          strip={
            data && diffCtx ? (
              <Strip
                your={sum.your}
                fresh={fresh}
                since={since}
                now={now}
                threads={threads.length}
                open={sum.unresolved}
                drafts={review.draftCount}
                files={files}
                answering={answering && !askOpen}
                onYour={nextYour}
                onNew={() => nextNew(1)}
                onThreads={goThreads}
                onDrafts={review.api.drafts}
                onFiles={diff.firstRow}
                onAnswering={openAsk}
              />
            ) : null
          }
          onLeave={onLeave}
          askOpen={askOpen}
          onAsk={() => (askOpen ? closeAsk() : openAsk())}
          onExplain={() => onExplain(true)}
          full={full}
          onFull={onFull}
          onTaskIds={onTaskIds}
          announce={announce}
          consult={review.consult}
          action={review.action}
          slot={
            askOpen && meta ? (
              <AskPanel pr={pr} meta={meta} now={now} onClose={closeAsk} onLog={review.api.openRunLog} announce={announce} />
            ) : (
              review.brief
            )
          }
        />
        <div ref={body} data-mounting={!steady || undefined} className="px-6 pb-16 max-[759px]:px-4">
          {archived(pr) && <ArchiveNotice pr={pr} now={now} onRestore={() => onRestore(pr)} />}
          {data ? (
            <>
              {review.reviewed && review.run}
              <Description detail={data} me={me} />
              <Notes pr={row.id} own={pr} threads={threads} jump={jump} announce={announce} focusAfter={focusAfter} />
              {!review.reviewed && review.run}
              {review.drafts}
              <Threads
                threads={threads}
                needMe={needMe}
                showResolved={showResolved}
                isOpen={isOpen}
                cur={cur}
                spines={spines}
                branches={branches}
                ctx={ctx}
                posts={outbox.threads}
                targets={targets}
                cards={review.cards}
                drafted={review.drafted}
                talks={review.talks}
                outbox={<PostsGroup posts={outbox.rest} comments={comments} forge={forge} web={web} hints={hints} ctx={outbox.ctx} />}
                onNeedMe={setNeedMe}
                onShowResolved={() => {
                  setShowResolved(true);
                  const first = threads.find((t) => t.turn === "resolved");
                  if (first) focusAfter({ id: `t-${first.id}`, block: "nearest", flash: false });
                }}
              />
              {diffCtx && (
                <DiffSection
                  files={data.files}
                  open={secs.has("files")}
                  onOpen={openSec("files")}
                  web={web}
                  forge={forge}
                  branches={pr.sourceBranch && pr.targetBranch ? [pr.sourceBranch, pr.targetBranch] : null}
                  view={diff}
                  ctx={diffCtx}
                />
              )}
              {data.commits?.length ? (
                <CommitsFold
                  commits={data.commits}
                  detail={data}
                  me={me}
                  open={secs.has("commits")}
                  onOpen={openSec("commits")}
                  now={now}
                  hints={hints}
                />
              ) : null}
            </>
          ) : q.error ? (
            <Calm title={notFound ? "Cannot find this pull request" : "Cannot load this pull request"}>
              <p className="m-0">{notFound ? "PR Review Inbox has no data for it. Select another pull request." : q.error.message}</p>
            </Calm>
          ) : (
            <div role="status" aria-busy="true" aria-label="Loading the pull request" className="grid max-w-[86ch] gap-3 pt-6">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
        </div>
        {/* Plan pr-view-v4 2.11: one bar at the bottom of the pane for the fix run and the post. The post confirm opens in it. */}
        {data && (review.fix.bar || bar.part || bar.confirm) && (
          <div data-postbar className="sticky bottom-0 z-[2] border-t border-rule-strong bg-pane px-6 text-sm max-[759px]:px-4">
            {(review.fix.bar || bar.part) && (
              // A wide pane keeps the parts in one row, with a rule between them. A narrow pane wraps them without the rule.
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 @min-[800px]/detail:[&>*+*]:border-l @min-[800px]/detail:[&>*+*]:pl-4">
                {review.fix.bar}
                {bar.part}
              </div>
            )}
            {bar.confirm}
          </div>
        )}
      </div>
      {explainPage}
      {review.fix.dialog}
      {review.consult.dialog}
      <SharedHint hints={hints} />
      <p role="status" className="sr-only">
        <span key={said.n}>{said.text}</span>
      </p>
      {review.sheet}
    </>
  );
}
