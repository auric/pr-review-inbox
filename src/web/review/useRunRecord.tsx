// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The rows of the run record (plan r2 R14): the newest run of each kind with its state, its stale note, its ledger, and its task text.
import type { CommitDto, FixDto, MetaDto, ReviewItemDto, RunDetail, RunDto, RunKind } from "../../shared/dto";
import { useRun } from "./data";
import { type DraftGroups, ledgerParts, questionJump, riskEntries, runLine, staleText } from "./model";
import { RiskEntries } from "./RiskEntries";
import { Ledger, Refuted } from "./RunLine";
import { useTaskContext } from "./TaskChips";
import { contextLines, trackerOf } from "./tasks";

export function useRunRecord(
  pr: number,
  o: {
    meta: MetaDto;
    // The newest run of each kind.
    kinds: RunDto[];
    // The details of the newest review run, of the newest explain run with a result, and of the run that the log sheet pins.
    review: RunDetail | undefined;
    explain: RunDetail | undefined;
    pinned: RunDetail | undefined;
    // The finding drafts of the newest review run by display group.
    groups: DraftGroups;
    items: ReviewItemDto[];
    fixes: FixDto[] | undefined;
    commits: CommitDto[] | undefined;
    now: number;
    openDraft: (id: number) => void;
    // Restore of a refuted or duplicate finding, and the items with a request out.
    restore: (it: ReviewItemDto) => void;
    busy: ReadonlySet<number>;
  },
) {
  const { meta, kinds } = o;
  const newestOf = (k: RunKind) => kinds.find((r) => r.kind === k)?.id ?? null;
  // Each row reads the log and the items of its run.
  const replyRun = useRun(newestOf("reply"));
  const fixRun = useRun(newestOf("fix"));
  const askRun = useRun(newestOf("ask"));
  const sessionRun = useRun(newestOf("session"));
  // The review row can show a cancelled or failed run that is newer than latest.
  const reviewRun = useRun(newestOf("review"));
  const fetched = useTaskContext(pr).data;

  const details = [o.review, reviewRun.data, replyRun.data, fixRun.data, askRun.data, sessionRun.data, o.explain, o.pinned];
  const tracker = trackerOf(meta);
  // The task text that a run read, as the run setup names it.
  const taskText = (r: RunDto) => {
    const lines = tracker ? contextLines(fetched ?? [], r, tracker.name, o.now) : [];
    if (lines.length) return `Task text: ${lines.join("; ")}`;
    return tracker?.configured ? "No task text fetched." : "No context source is set up.";
  };
  const qJump = questionJump(o.items);
  const ledger = ledgerParts(o.groups, qJump);
  const rows = kinds.map((r) => {
    const d = details.find((x) => x?.run.id === r.id);
    const shown = d ? { ...d.run, stale: r.stale } : r;
    const review = r.kind === "review";
    return {
      run: shown,
      state: runLine(shown, d, meta.profiles, o.fixes?.find((f) => f.run.id === r.id)?.edits.length),
      stale: staleText(shown, o.commits),
      // The ledger and the refuted list follow the drafts of latestReview. The record shows them only for a done run.
      ledger: review ? <Ledger parts={ledger} onDraft={o.openDraft} /> : null,
      refuted: review ? <Refuted hidden={o.groups.hidden} busy={o.busy} onRestore={o.restore} /> : null,
      // postable-risks.md section 4.3: o.items holds every item of latestReview, posted ones too.
      risks: review ? <RiskEntries entries={riskEntries(shown.summary, o.items, r.id)} onDraft={o.openDraft} /> : null,
      context: taskText(shown),
    };
  });
  return { rows, details, qJump, ledger };
}
