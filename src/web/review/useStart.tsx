// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The start of review, re-review, and reply-draft runs, and the brief that a review starts from (plan v3 WP11, r2 UI-RR, replies.md step 6).
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { CommitDto, MetaDto, PrRow, RunConflict, RunDto } from "../../shared/dto";
import { busyText } from "../ask/model";
import type { ThreadModel } from "../pr/threads";
import { Hint } from "../shell/Hint";
import { failText, prKey } from "../shell/model";
import type { BriefMode } from "./Brief";
import { saveLastProfile, useBrief, usePrRuns, useRuns, useStartReplies, useStartRereview, useStartReview } from "./data";
import { activeRun, briefState, newCommits, plural, rereviewState, shortHash } from "./model";
import type { Focus } from "./useReview";

// The open brief and the review that its Start begins.
type Composer = { kind: "review" } | { kind: "rereview" } | null;

// Plan r2 UI-RR. It shows only when the server takes a re-review (rereviewState).
export function RereviewButton({ since, busy, onClick }: { since: string; busy: boolean; onClick: () => void }) {
  return (
    <Hint label={`Open the review brief for the commits after ${since}. The open drafts carry over and get a new check. Key: c`}>
      <Button id="rereview-btn" size="sm" variant="outline" disabled={busy} aria-keyshortcuts="c" onClick={onClick}>
        Review changes since{" "}
        <code translate="no" className="font-mono">
          {since}
        </code>
      </Button>
    </Hint>
  );
}

export function useStart(
  pr: PrRow,
  o: {
    meta: MetaDto;
    latest: RunDto | null;
    newest: RunDto | null;
    commits: CommitDto[] | undefined;
    threads: ThreadModel[];
    announce: (text: string) => void;
    focusAfter: (f: Focus) => void;
  },
) {
  const { meta, latest, newest, focusAfter } = o;
  const qc = useQueryClient();
  const brief = useBrief(pr.id);
  const active = activeRun(useRuns().data, usePrRuns(pr.id).data);
  const start = useStartReview(pr.id);
  const startReplies = useStartReplies(pr.id);
  const startRereview = useStartRereview(pr.id);
  const [composer, setComposer] = useState<Composer>(null);
  // The threads of the reply run that this page started. They show a pending card while it runs.
  const [asked, setAsked] = useState<{ run: number; threads: number[] } | null>(null);

  const state = briefState(brief.data, active, pr.id, meta.profiles);

  const where = (id: number | null) => {
    if (id === null) return "a task";
    if (id === pr.id) return "this pull request";
    const other = qc.getQueryData<PrRow[]>(["prs"])?.find((p) => p.id === id);
    return other ? prKey(other) : "another pull request";
  };
  // The run that holds the only slot, as words. The brief cannot start until it ends.
  const busy = active ? busyText(meta.runner.short, active.kind, where(active.pr)) : null;

  const slotTaken = (c: RunConflict) => toast.add({ title: busyText(meta.runner.short, c.running.kind, where(c.running.pr)) });

  // A review runs the stored brief. Its profile becomes the last used one (decision D2).
  const runNow = () =>
    start.mutate(undefined, {
      onSuccess: (r) => {
        if ("conflict" in r) return slotTaken(r.conflict);
        saveLastProfile(r.run.profile);
        setComposer(null);
        focusAfter({ id: "runline-log", block: "nearest", flash: false });
      },
      onError: (e) => toast.add({ title: "The review did not start", description: failText(e) }),
    });

  const rr = rereviewState(latest, brief.data, meta.profiles);
  const rereviewNow = () => {
    if (startRereview.isPending) return;
    startRereview.mutate(undefined, {
      onSuccess: (r) => {
        if ("conflict" in r) return slotTaken(r.conflict);
        saveLastProfile(r.run.profile);
        setComposer(null);
        focusAfter({ id: "runline-log", block: "nearest", flash: false });
      },
      onError: (e) => toast.add({ title: "The review of the new commits did not start", description: failText(e) }),
    });
  };

  // threads absent: every thread where it is my turn, as the server selects them (WP17). The run uses the brief profile.
  const draftReplies = (threads?: number[]) => {
    const ids = threads ?? o.threads.filter((t) => t.turn === "your").map((t) => t.id);
    startReplies.mutate(
      { threads },
      {
        onSuccess: (r) => {
          if ("conflict" in r) return slotTaken(r.conflict);
          setAsked({ run: r.run.id, threads: ids });
          o.announce(threads ? "Drafting a reply." : `Drafting replies for ${plural(ids.length, "thread")}.`);
        },
        onError: (e) => toast.add({ title: "The reply drafts did not start", description: failText(e) }),
      },
    );
  };

  // An open brief keeps its note and only changes the review that Start begins.
  const openBrief = (next: NonNullable<Composer> = { kind: "review" }) => {
    if (composer) document.getElementById("brief-note")?.focus();
    setComposer(next);
  };
  const closeBrief = () => {
    setComposer(null);
    focusAfter({ id: "review-btn", block: "nearest", flash: false });
  };
  const rereview = () => {
    if ("why" in rr) toast.add({ title: rr.why });
    else openBrief({ kind: "rereview" });
  };
  // A re-review keeps the head of its base also when the brief profile makes it impossible, so the brief can say why.
  const mode: BriefMode =
    composer?.kind === "rereview" && latest
      ? { kind: "rereview", since: shortHash(latest.sourceHead), commits: newCommits(latest, o.commits) }
      : { kind: "review" };
  const blocked = busy ?? (mode.kind === "rereview" && "why" in rr ? rr.why : null);
  const pending = asked && newest?.id === asked.run && newest.status === "running" ? asked : null;

  return {
    brief,
    state,
    busy,
    slotTaken,
    starting: start.isPending || startRereview.isPending,
    rereviewPending: startRereview.isPending,
    startNow: () => (mode.kind === "rereview" ? rereviewNow() : runNow()),
    draftReplies,
    composer,
    openBrief,
    closeBrief,
    rereview,
    mode,
    blocked,
    rr,
    pending,
  };
}
