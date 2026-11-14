// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The cards under each thread and finding (docs/plans/thread-outcome.md): the outcome line, the conflict note, the reply draft card,
// and the fix card.
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useMemo, useRef } from "react";
import type { CommitDto, ItemActionInput, PrRow, ReviewItemDto } from "../../shared/dto";
import type { FixUi } from "../fix/FixBar";
import { fixWaiting } from "../fix/model";
import type { ThreadModel } from "../pr/threads";
import { usePostPlan } from "../publish/data";
import { usePr } from "../shell/data";
import { modeOf, type TriageState } from "./Drafts";
import { getRun, replyKey } from "./data";
import { plural, replyCard, replyOf } from "./model";
import { type Conflict, conflictText, findingConflict, findingConflictText, threadOutcome } from "./outcome";
import { ConflictNote, OutcomeLine, type ReplyCtx, ReplyDraftCard } from "./ReplyDraft";
import type { TriageAction } from "./Triage";
import type { Focus } from "./useReview";

export function useThreadCards(
  pr: PrRow,
  o: {
    threads: ThreadModel[];
    commits: CommitDto[] | undefined;
    byThread: ReadonlyMap<number, ReviewItemDto>;
    pending: { run: number; threads: number[] } | null;
    findings: ReviewItemDto[];
    triage: TriageState;
    replyCtx: ReplyCtx;
    fix: FixUi;
    author: boolean;
    send: (it: ReviewItemDto, input: ItemActionInput) => Promise<boolean>;
    onTriage: RefObject<{ act: (it: ReviewItemDto, action: TriageAction) => void }>;
    announce: (text: string) => void;
    focusAfter: (f: Focus) => void;
  },
) {
  const qc = useQueryClient();
  const { threads, commits, byThread, pending, findings: ds, triage, replyCtx, fix, author, send, onTriage, focusAfter } = o;
  const { cards: fixCards, findingCards: fixFindingCards, fixes, ticks, tick: setTicks } = fix;
  // PrDetail reads the same query, so this adds no request.
  const prHead = usePr(pr.id).data?.sourceHead ?? null;
  // The outcome of each thread, and the conflict note when its reply and its fix disagree.
  const outcomes = useMemo(
    () =>
      new Map(
        threads.map((t) => [
          t.id,
          threadOutcome({
            thread: { id: t.id, turn: t.turn, newest: t.last?.id ?? null, orphanedAt: t.root.orphanedAt ?? null },
            draft: byThread.get(t.id),
            fixes,
            commits,
            ticks,
            author,
            prHead,
          }),
        ]),
      ),
    [threads, byThread, fixes, commits, ticks, author, prHead],
  );
  const need = threads.filter((t) => outcomes.get(t.id)?.outcome.needsReply).length;
  // WP-S3: the post plan names the accepted "Fixed in" drafts whose commit the clone branch no longer holds.
  const cannotPost = usePostPlan(pr.id).data?.blocked;
  const gone = useMemo(() => new Set(cannotPost?.flatMap((b) => (b.reason === "commit-gone" ? [b.item] : []))), [cannotPost]);

  // "Keep the reply" and "Keep the reject": the fix card keeps the focus, as the note leaves.
  const untick = (edits: number[], card: string) => {
    setTicks(edits, false);
    o.announce(`Unticked ${plural(edits.length, "edit")}. Apply leaves ${edits.length === 1 ? "it" : "them"} out.`);
    focusAfter({ id: card, block: "nearest", flash: false });
  };
  // "Keep the fix" of a "yes" conflict: discard the reply, then restore the nofix draft of the note when the run holds one.
  const keepFix = async (c: Extract<Conflict, { kind: "yes" }>, thread: number) => {
    const d = await qc.fetchQuery({ queryKey: ["run", c.run], queryFn: () => getRun(qc, c.run) }).catch(() => null);
    const back = d?.items.find((x) => {
      const p = replyOf(x);
      return x.kind === "reply" && x.status === "discarded" && p.thread === thread && p.origin === "nofix" && !p.declined;
    });
    if (!(await send(c.reply, { action: "discard", revision: c.reply.revision })) || !back) return;
    if (await send(back, { action: "restore", revision: back.revision })) void qc.invalidateQueries({ queryKey: replyKey(pr.id) });
  };
  const resolveConflict = (c: Conflict, thread: number, keep: boolean) => {
    if (c.kind === "no") {
      if (!keep) return void send(c.reply, { action: "discard", revision: c.reply.revision });
      untick(c.edits, `fx-${thread}`);
      return;
    }
    if (!keep) return void keepFix(c, thread);
    if (c.text) void send(c.reply, { action: "accept", revision: c.reply.revision });
    else fix.again({ kind: "thread", id: thread }, true);
  };
  const onConflict = useRef({ resolveConflict, untick });
  onConflict.current = { resolveConflict, untick };

  // Per thread, so a memo thread renders again only when its own card changes. The outcome line comes first, then the conflict note,
  // the reply draft card, and the fix card.
  const { cards, drafted } = useMemo(() => {
    const out = new Map<number, ReactNode>();
    const drafted = new Set<number>();
    for (const t of threads) {
      const card = replyCard(byThread.get(t.id), t.last?.id ?? null, !!pending?.threads.includes(t.id));
      if (card?.kind === "draft" || card?.kind === "pending") drafted.add(t.id);
      const fixCard = fixCards.get(t.id);
      if (!card && !fixCard) continue;
      const it = !card || card.kind === "pending" ? null : card.it;
      const p = it && replyOf(it);
      const to = p && t.msgs.find((m) => m.id === p.replyTo);
      const state = outcomes.get(t.id);
      const c = state?.conflict;
      out.set(
        t.id,
        <>
          {state && <OutcomeLine o={state.outcome} />}
          {c && (
            <ConflictNote
              c={conflictText(c)}
              busy={triage.busy.has(c.reply.id)}
              onKeep={() => onConflict.current.resolveConflict(c, t.id, true)}
              onFix={() => onConflict.current.resolveConflict(c, t.id, false)}
            />
          )}
          {card && (
            <ReplyDraftCard
              card={card}
              thread={t.id}
              mine={t.root.who.me}
              to={to ? (to.who.me ? "your message" : to.who.name) : null}
              mode={it ? modeOf(triage, it.id) : null}
              busy={!!it && (triage.busy.has(it.id) || (!!it.revised && triage.busy.has(it.revised.id)))}
              waiting={p ? fixWaiting(p, commits, fixes) : null}
              gone={!!it && gone.has(it.id)}
              resolved={t.turn !== "resolved" ? null : p?.threadOpen ? "since" : "now"}
              code={!!state?.outcome.markers.includes("code")}
              ctx={replyCtx}
            />
          )}
          {fixCard}
        </>,
      );
    }
    return { cards: out, drafted };
  }, [threads, byThread, pending, triage, replyCtx, fixCards, fixes, commits, outcomes, gone]);

  // session-consult.md part C: a finding that your session rejected, with edits still ticked, gets the conflict note on its fix card.
  const findingCards = useMemo(() => {
    const out = new Map(fixFindingCards);
    for (const it of ds) {
      const edits = findingConflict(it, fixes, ticks);
      const card = out.get(it.id);
      if (!edits || !card) continue;
      out.set(
        it.id,
        <>
          <ConflictNote
            c={findingConflictText(edits)}
            busy={triage.busy.has(it.id)}
            onKeep={() => onConflict.current.untick(edits, `fx-f${it.id}`)}
            onFix={() => onTriage.current.act(it, "restore")}
          />
          {card}
        </>,
      );
    }
    return out;
  }, [fixFindingCards, ds, fixes, ticks, triage.busy, onTriage]);

  return { cards, drafted, findingCards, need };
}
