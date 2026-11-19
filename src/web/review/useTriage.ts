// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Triage of drafts, questions, and reply drafts (plan v3 WP14a): the open rows, the busy items, the server actions, and keys a, e, d.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import type { DiscardReason, ItemActionInput, MetaDto, PrRow, ReviewItemDto, RunDetail, RunSummary } from "../../shared/dto";
import { displayGroup, type FindingPayload } from "../../shared/review";
import type { ThreadModel } from "../pr/threads";
import { planKey } from "../publish/data";
import { failText } from "../shell/model";
import { draftDomId, type TriageState } from "./Drafts";
import { replyKey, sendItem } from "./data";
import { draftGroups, drafts, isPreexisting, questions, replyCard, replyOf, triageText } from "./model";
import { storedEdit, type TriageAction, type TriageCtx, writeEdit } from "./Triage";
import type { Focus } from "./useReview";

export const NO_ITEMS: ReviewItemDto[] = [];

export function useTriage(
  pr: PrRow,
  o: {
    meta: MetaDto;
    items: ReviewItemDto[];
    // The summary of the run of the items. Its volume sets the groups of the drafts.
    summary: RunSummary | null | undefined;
    replyItems: ReviewItemDto[];
    threads: ThreadModel[];
    announce: (text: string) => void;
    focusAfter: (f: Focus) => void;
  },
) {
  const { items, summary, focusAfter } = o;
  const qc = useQueryClient();
  const [openDrafts, setOpenDrafts] = useState<ReadonlyMap<number, boolean>>(new Map());
  // An unsent edit from an earlier visit opens its editor again (plan pr-view-v4 section 5).
  const [triage, setTriage] = useState<TriageState>(() => {
    const id = storedEdit(pr.id);
    return { open: id === null ? null : { id, mode: "edit", quiet: true }, busy: new Set(), chips: null };
  });
  // docs/plans/review-v2/spec.md section 1.4: the fold of the Drafts list starts closed. So does the Pre-existing fold.
  const [foldOpen, setFoldOpen] = useState(false);
  const [preOpen, setPreOpen] = useState(false);

  // Stable while the items stay, so the diff renders again only when they change.
  const ds = useMemo(() => (items.length ? drafts(items) : NO_ITEMS), [items]);
  const groups = useMemo(() => draftGroups(ds, summary), [ds, summary]);
  const qs = useMemo(() => (items.length ? questions(items) : NO_ITEMS), [items]);
  // Plan pr-view-v4 2.7: one list of the findings, then the questions. The fold of findings sits between them. The first untriaged
  // row outside the fold starts open. shown: the rows on screen. A closed fold renders no rows.
  const list = useMemo(() => [...groups.main, ...qs], [groups, qs]);
  const shown = useMemo(
    () => (foldOpen || preOpen ? [...groups.main, ...(foldOpen ? groups.fold : []), ...(preOpen ? groups.preexisting : []), ...qs] : list),
    [foldOpen, preOpen, list, groups, qs],
  );
  const firstNew = list.find((x) => x.status === "new")?.id ?? null;
  const all = [...items, ...o.replyItems];
  const latestItems = useRef(all);
  latestItems.current = all;
  const latestList = useRef({ list: shown, firstNew, volume: summary?.volume });
  latestList.current = { list: shown, firstNew, volume: summary?.volume };
  // A draft in a closed fold opens that fold first, so its row exists before the focus moves.
  const reveal = useCallback((it: ReviewItemDto | undefined) => {
    const g = it?.kind === "finding" ? displayGroup(it.payload as FindingPayload, latestList.current.volume) : null;
    if (g === "fold") setFoldOpen(true);
    else if (g === "preexisting") setPreOpen(true);
  }, []);
  const isDraftOpen = (it: ReviewItemDto) => openDrafts.get(it.id) ?? it.id === firstNew;
  const toggleDraft = useCallback(
    (id: number) => setOpenDrafts((m) => new Map(m).set(id, !(m.get(id) ?? id === latestList.current.firstNew))),
    [],
  );
  // Opens finding drafts without a focus change, so their fix cards mount.
  const showFindings = useCallback(
    (ids: number[]) =>
      setOpenDrafts((m) => {
        const out = new Map(m);
        for (const id of ids) out.set(id, true);
        return out;
      }),
    [],
  );
  // Opens a draft or a question and focuses it: "Go to draft" in the diff, the ledger, and key 2.
  const openDraft = useCallback(
    (id: number) => {
      const it = latestItems.current.find((x) => x.id === id);
      reveal(it);
      setOpenDrafts((m) => new Map(m).set(id, true));
      focusAfter({ id: it ? draftDomId(it) : `d-${id}`, block: "start", flash: true });
    },
    [focusAfter, reveal],
  );

  const domId = (it: ReviewItemDto) => (it.kind === "reply" ? `rd-${it.id}` : draftDomId(it));
  const setBusy = (id: number, on: boolean) =>
    setTriage((s) => {
      const busy = new Set(s.busy);
      if (on) busy.add(id);
      else busy.delete(id);
      return { ...s, busy };
    });
  const putItem = (it: ReviewItemDto) => {
    qc.setQueryData<RunDetail>(["run", it.run], (old) => old && { ...old, items: old.items.map((x) => (x.id === it.id ? it : x)) });
    // Use revision returns the used revision: it takes the place of the draft that held it. A waiting revision is no draft of its own.
    const used = !replyOf(it).revises;
    if (it.kind === "reply")
      // An item action answers without the note suggestions of GET reply-drafts, so the card keeps them.
      qc.setQueryData<ReviewItemDto[]>(replyKey(pr.id), (old) =>
        old?.map((x) => (x.id === it.id ? { ...it, ...(x.notes && { notes: x.notes }) } : used && x.revised?.id === it.id ? it : x)),
      );
  };

  // prototype/v3 setItem: accept and discard close the row and open the next untriaged row of the Drafts list.
  // A reply draft stays under its thread, so the focus stays on it.
  const advance = (it: ReviewItemDto) => {
    if (it.kind === "reply") {
      focusAfter({ id: domId(it), block: "nearest", flash: false });
    } else if (it.status === "accepted" || it.status === "discarded") {
      const same = latestList.current.list;
      const fresh = (x: ReviewItemDto) => x.id !== it.id && x.status === "new";
      const next = same.slice(same.findIndex((x) => x.id === it.id) + 1).find(fresh) ?? same.find(fresh) ?? it;
      setOpenDrafts((m) => new Map(m).set(it.id, false).set(next.id, next !== it));
      focusAfter({ id: domId(next), block: "nearest", flash: false });
    } else {
      // A restore from the run record list moves the focus to the draft in the Drafts list.
      reveal(it);
      setOpenDrafts((m) => new Map(m).set(it.id, true));
      focusAfter({ id: domId(it), block: "nearest", flash: false });
    }
  };

  // Resolves to true when the server took the change.
  async function send(it: ReviewItemDto, input: ItemActionInput, close = false): Promise<boolean> {
    setBusy(it.id, true);
    // docs/plans/review-v2/spec.md section 4.1: the chips leave on the next move.
    if (input.action !== "reason") setTriage((s) => (s.chips === null ? s : { ...s, chips: null }));
    try {
      const r = await sendItem(it.id, input);
      if ("conflict" in r) {
        putItem(r.conflict.item);
        // A conflict of a revision changes the draft or the finding that holds it, so the list loads again.
        if (it.kind === "reply") void qc.invalidateQueries({ queryKey: replyKey(pr.id) });
        else if ((it.payload as FindingPayload).revises !== undefined) void qc.invalidateQueries({ queryKey: ["run", it.run] });
        toast.add({ title: r.conflict.error });
        return false;
      }
      putItem(r.item);
      if (input.action !== "move") writeEdit(pr.id, it.id, null);
      void qc.invalidateQueries({ queryKey: planKey(pr.id) });
      // The focus goes on to the next item, so the live region says what happened to this one.
      o.announce(triageText(it, r.item, input.action));
      if (close) setTriage((s) => ({ ...s, open: s.open?.id === it.id ? null : s.open }));
      if (input.action === "discard" && r.item.kind === "finding" && r.item.status === "discarded")
        setTriage((s) => ({ ...s, chips: r.item.id }));
      if (input.action === "move") focusAfter({ id: domId(r.item), block: "nearest", flash: false });
      else if (input.action !== "reason") advance(r.item);
      return true;
    } catch (e) {
      toast.add({ title: "The change was not saved", description: failText(e) });
      return false;
    } finally {
      setBusy(it.id, false);
    }
  }

  const openMode = (it: ReviewItemDto | null, mode: "edit" | "move") => {
    const was = triage.open;
    setTriage((s) => ({ ...s, open: it && { id: it.id, mode } }));
    if (it) {
      setOpenDrafts((m) => new Map(m).set(it.id, true));
      return;
    }
    const back = was && latestItems.current.find((x) => x.id === was.id);
    if (back) focusAfter({ id: domId(back), block: "nearest", flash: false });
  };

  const triageFns = {
    act: (it: ReviewItemDto, action: TriageAction) => void send(it, { action, revision: it.revision }),
    edit: (it: ReviewItemDto | null) => openMode(it, "edit"),
    // An unchanged text only accepts, so the item does not get the "edited by you" mark.
    save: (it: ReviewItemDto, text: string) =>
      void send(
        it,
        text === it.body ? { action: "accept", revision: it.revision } : { action: "edit", revision: it.revision, body: text },
        true,
      ),
    move: (it: ReviewItemDto | null) => openMode(it, "move"),
    moveTo: (it: ReviewItemDto, line: number) => void send(it, { action: "move", revision: it.revision, line }, true),
    tick: (it: ReviewItemDto, on: boolean) => void send(it, { action: "resolve", revision: it.revision, resolve: on }),
    reason: (it: ReviewItemDto, code: DiscardReason) => void send(it, { action: "reason", revision: it.revision, code }),
    plain: (it: ReviewItemDto) => void send(it, { action: "plain", revision: it.revision }),
    takeRevision: (rev: ReviewItemDto, mine: ReviewItemDto) =>
      void send(rev, { action: "use-revision", revision: rev.revision, draft: mine.revision }),
    keepMine: (rev: ReviewItemDto) => void send(rev, { action: "keep-mine", revision: rev.revision }),
    newest: (it: ReviewItemDto) => void send(it, { action: "reply-to-newest", revision: it.revision }),
  };
  const onTriage = useRef(triageFns);
  onTriage.current = triageFns;
  const quiet = useRef<number | null>(null);
  quiet.current = triage.open?.quiet ? triage.open.id : null;
  // Stable, so the memo drafts render again only when their own data changes.
  const prId = pr.id;
  const triageCtx = useMemo<TriageCtx>(
    () => ({
      pr: prId,
      act: (it, a) => onTriage.current.act(it, a),
      edit: (it) => onTriage.current.edit(it),
      save: (it, t) => onTriage.current.save(it, t),
      move: (it) => onTriage.current.move(it),
      moveTo: (it, l) => onTriage.current.moveTo(it, l),
      tick: (it, on) => onTriage.current.tick(it, on),
      reason: (it, code) => onTriage.current.reason(it, code),
      quiet: (id) => quiet.current === id,
    }),
    [prId],
  );

  // Keys a, e, and d act on the draft, question, or reply draft that holds the focus (prototype/v3 triageKey).
  const triageKey = (key: "accept" | "edit" | "discard") => {
    const at = Number(document.activeElement?.closest("[data-item]")?.getAttribute("data-item"));
    const it = all.find((x) => x.id === at && x.status !== "posted");
    if (!it) {
      toast.add({ title: `Move to a draft or a question first. Key 2 goes to the drafts from ${o.meta.runner.short}.` });
      return;
    }
    if (triage.busy.has(it.id)) return;
    // items.ts refuses every action but discard on a finding without an anchor. Such a finding is always discarded.
    if (it.kind === "finding" && !it.anchor) {
      toast.add({ title: "The code of this finding is gone. It cannot come back." });
      return;
    }
    // The card of an out-of-date reply draft has no Accept and no Edit (Acts stale). items.ts refuses them too.
    const t = it.kind === "reply" ? o.threads.find((x) => x.id === replyOf(it).thread) : undefined;
    const c = t && replyCard(it, t.last?.id ?? null, false);
    if (c?.kind === "draft" && c.stale && (key === "edit" || (key === "accept" && it.status !== "accepted"))) {
      toast.add({ title: "New messages arrived after this draft. Draft it again, or reply to the newest as is." });
      return;
    }
    // The card of a pre-existing finding has no Accept and no Edit (Acts noPost). items.ts refuses them too.
    if (isPreexisting(it) && (key === "edit" || (key === "accept" && it.status !== "accepted"))) {
      toast.add({ title: "The app does not post a pre-existing finding. Discard it, or use Discuss or Fix." });
      return;
    }
    if (key === "accept") triageFns.act(it, it.status === "accepted" ? "restore" : "accept");
    else if (key === "discard") triageFns.act(it, it.status === "discarded" ? "restore" : "discard");
    else if (it.status !== "discarded") triageFns.edit(it);
  };

  const toggleFold = useCallback(() => setFoldOpen((v) => !v), []);
  const togglePre = useCallback(() => setPreOpen((v) => !v), []);
  return {
    triage,
    ds,
    groups,
    qs,
    list,
    foldOpen,
    toggleFold,
    preOpen,
    togglePre,
    isDraftOpen,
    toggleDraft,
    showFindings,
    openDraft,
    send,
    onTriage,
    triageCtx,
    triageKey,
  };
}
