// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure rules of a talk about a finding (docs/plans/review-v2/spec.md section 2.1). No DOM access, so bun test runs them directly.
import {
  DISCUSS_CHANGED,
  type DiscussTurnDto,
  type PostDto,
  type ReviewItemDto,
  type RunConflict,
  type RunDto,
  type RunKind,
} from "../../shared/dto";
import { type DiscussVerdict, type FindingPayload, MAX_DISCUSS_MESSAGES } from "../../shared/review";
import { fullText } from "../ask/model";
import { type DiffLine, wordDiff } from "../lib/textdiff";
import { KIND_LABEL, plural, RUN_TEXT, SEVERITY } from "./model";

// The chip of an answer. The words carry the state, so the icon only repeats it.
export function verdictChip(v: DiscussVerdict, runner: string): string {
  if (v === "upheld") return `${runner} keeps this point`;
  return v === "revised" ? `${runner} changed this point` : `${runner} withdrew this point`;
}

// answered: chip null when the run ended without a valid result.
export type TurnView =
  | { kind: "running"; startedAt: number }
  | { kind: "answered"; chip: string | null; answer: string | null; reason: string | null }
  | { kind: "failed"; text: string }
  | { kind: "cancelled" };

export function turnView(t: DiscussTurnDto, runner: string): TurnView {
  switch (t.status) {
    case "running":
      return { kind: "running", startedAt: t.at };
    case "cancelled":
      return { kind: "cancelled" };
    case "failed":
      return { kind: "failed", text: `${RUN_TEXT.discuss.failed} ${t.error?.trim() || "No reason was recorded."}` };
    default:
      return { kind: "answered", chip: t.verdict ? verdictChip(t.verdict, runner) : null, answer: t.answer, reason: t.reason };
  }
}

// "Started 20 s ago." while the run works.
export function startedText(startedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  return s < 60 ? `Started ${s} s ago.` : `Started ${Math.floor(s / 60)} min ago.`;
}

// The messages that the talk still takes. Every turn counts, also a failed one (jobs.ts discuss counts each run).
export const talkLeft = (turns: readonly DiscussTurnDto[]) => Math.max(0, MAX_DISCUSS_MESSAGES - turns.length);

// The line under the box. busy: the run-slot note (W1 or W2) of useSlots.
export function talkHint(turns: readonly DiscussTurnDto[], busy: string | null): string {
  if (busy) return busy;
  const left = talkLeft(turns);
  return `Ctrl+Enter asks. Esc closes the talk.${turns.length ? ` ${plural(left, "message")} left.` : ""}`;
}

// A refused start: a run works on this PR. where: "this pull request" or the PR key.
export const busyLine = (kind: RunKind, where: string) =>
  `Another run is working: ${KIND_LABEL[kind]} of ${where}. Ask again when it ends.`;

// docs/plans/review-v2/parallel-runs.md section 3.5, W4: the line of a 409. A full pool names the limit.
export const refusedLine = (runner: string, c: RunConflict, where: (pr: number | null) => string) =>
  c.full ? `${fullText(runner, c.full)} Ask again when one ends.` : busyLine(c.running.kind, where(c.running.pr));

export const askedText = (runner: string) => `Asked. ${runner} is reading the code.`;

// What the run stored, in plain words. posted: the finding is posted. waiting: the revision that the finding card shows now.
export function outcomeLines(t: DiscussTurnDto, o: { posted: boolean; waiting: number | undefined; runner: string }): string[] {
  if (t.changed) return [DISCUSS_CHANGED];
  if (t.applied.draft !== undefined) return [`${o.runner} drafted a reply in this thread. Nothing posts until you accept it.`];
  if (o.posted) return [];
  if (t.applied.revision !== undefined && t.applied.revision === o.waiting)
    return ["The new text waits on the card. Use it, or keep your text."];
  if (t.applied.discarded) return ["The finding moved to the discarded drafts. Restore brings it back."];
  return [];
}

// The turn that a start adds before the next fetch.
export const pendingTurn = (run: RunDto, message: string): DiscussTurnDto => ({
  run: run.id,
  status: run.status,
  message,
  answer: null,
  verdict: null,
  reason: null,
  revision: null,
  at: run.startedAt,
  error: null,
  cites: [],
  notes: [],
  applied: {},
  changed: false,
});

// The posted findings that a talk can start from, by thread. discuss.ts postedThread takes the newest confirmed post that holds the
// finding. Only an inline post holds exactly one finding (run-rows.ts SQL.posted). A general post groups many items.
export function talkThreads(posts: readonly PostDto[] | undefined): Map<number, { item: number; run: number }> {
  const out = new Map<number, { item: number; run: number }>();
  for (const p of posts ?? []) {
    const it = p.items[0];
    if (p.state !== "confirmed" || p.remoteId === null || p.run === null || p.destination.kind !== "inline" || p.items.length !== 1 || !it)
      continue;
    const was = out.get(p.remoteId);
    if (!was || was.item < it.id) out.set(p.remoteId, { item: it.id, run: p.run });
  }
  return out;
}

// The new text of a changed finding against the current text. severity and title: null when they stay. A finding from before
// review v2 has no title, so its new title shows as added text.
export function revisionParts(
  it: ReviewItemDto,
  rev: ReviewItemDto,
): { severity: DiffLine[] | null; title: DiffLine[] | null; body: DiffLine[] } {
  const a = it.payload as FindingPayload;
  const b = rev.payload as FindingPayload;
  const titleA = a.title?.trim() ?? "";
  const titleB = b.title?.trim() ?? "";
  return {
    severity: a.severity === b.severity ? null : wordDiff(SEVERITY[a.severity], SEVERITY[b.severity]),
    title: titleA === titleB ? null : wordDiff(titleA, titleB),
    body: wordDiff(it.body.trim(), rev.body.trim()),
  };
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

// spec.md section 2.2: the withdrawn mark of a finding. A restore keeps the mark and says so. null: no mark, or the user discarded the
// finding again after the restore.
export function withdrawnNote(it: ReviewItemDto): string | null {
  const w = it.kind === "finding" ? (it.payload as FindingPayload).withdrawn : undefined;
  if (!w) return null;
  const lead = `Withdrawn after your talk: ${sentence(w.reason)}`;
  if (!w.restored) return it.status === "discarded" ? lead : null;
  return it.status === "discarded" ? null : `${lead} You restored it.`;
}
