// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Notification claim flow (plan G7). The server claim gives each event to one tab only.
import { useEffect, useRef } from "react";
import type { Claimed, ClaimedEvent, ClaimedTaskEvent } from "../shared/dto";
import { liveEvents } from "./live";
import { prKey } from "./shell/model";

// pr null: a digest, or a task note with task set. A digest click opens Needs you, a task note click opens its task.
export type Note = { title: string; body: string; tag: string; pr: number | null; task?: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type CountKind = Exclude<ClaimedEvent["kind"], RunKind>;
type RunKind = "run_finished" | "run_failed";
const isRun = (k: ClaimedEvent["kind"]): k is RunKind => k === "run_finished" || k === "run_failed";

const KIND_TEXT: Record<CountKind, (n: number) => string> = {
  comment_new: (n) => plural(n, "new comment"),
  commits_pushed: () => "new commits",
  reviewer_added: () => "review requested",
  draft_stale: (n) => `${plural(n, "reply draft")} out of date`,
  build_failed: () => "build failed",
  build_passed: () => "build passed",
};

const REASON_MAX = 80;
const reason = (text: string) => {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
};

// The result of one run in plain words. A run row that is gone gives a short text.
export function runText(e: ClaimedEvent): string {
  const r = e.run;
  if (!r) return e.kind === "run_finished" ? "run done" : "run failed";
  const name = r.kind === "explain" ? "explanation" : r.rereview ? "re-review" : "review";
  const found = r.findings ? plural(r.findings, "finding") : "no findings";
  const why = r.error ? ` (${reason(r.error)})` : "";
  if (r.status === "completed") return r.kind === "explain" ? "explanation ready" : `${name} done, ${found}`;
  if (r.status === "incomplete") return r.kind === "explain" ? `explanation incomplete${why}` : `${name} incomplete, ${found}${why}`;
  return `${name} failed${why}`;
}

const taskNote = (e: ClaimedTaskEvent): Note => ({
  title: `${e.key}: ${e.title}`,
  body: e.text,
  tag: `task-${e.task}`,
  pr: null,
  task: e.task,
});

// The first claim of a tab, or a batch with a digest event, gives one digest. Otherwise one note per PR and one per task event.
export function planNotes(claimed: Claimed[], first: boolean): Note[] {
  if (!claimed.length) return [];
  const events = claimed.filter((e): e is ClaimedEvent => !("task" in e));
  const tasks = claimed.filter((e): e is ClaimedTaskEvent => "task" in e);
  const byPr = new Map<number, ClaimedEvent[]>();
  for (const e of events) byPr.set(e.pr, [...(byPr.get(e.pr) ?? []), e]);
  if (first || events.some((e) => e.digest)) {
    // A task can have several events, such as two parts that got ready.
    const waiting = new Set(tasks.map((e) => e.task)).size;
    const parts = [
      ...(events.length ? [`${plural(events.length, "update")} in ${plural(byPr.size, "pull request")}`] : []),
      ...(waiting ? [`${plural(waiting, "task")} ${waiting === 1 ? "needs" : "need"} you`] : []),
    ];
    return [{ title: "PR Review Inbox", body: parts.join(", "), tag: "digest", pr: null }];
  }
  const prNotes = [...byPr].map(([pr, list]): Note => {
    const head = list[0] as ClaimedEvent;
    const counts = new Map<CountKind, number>();
    const runs: string[] = [];
    for (const e of list)
      if (isRun(e.kind)) runs.push(runText(e));
      else counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const body = [...runs, ...[...counts].map(([kind, n]) => KIND_TEXT[kind](n))].join(", ");
    return { title: head.title ?? prKey(head), body: `${prKey(head)}: ${body}`, tag: prKey(head), pr };
  });
  return [...prNotes, ...tasks.map(taskNote)];
}

export const notifyPermission = (): NotificationPermission | "unsupported" =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

// Claims once on load and on each `events` message, also with notifications off, so no backlog floods later.
// ready: the settings are loaded and hold a base URL. An unconfigured server refuses the claim, and the next claim would count as the first.
export function useClaims(
  claim: () => Promise<Claimed[]>,
  ready: boolean,
  enabled: boolean,
  onOpen: (pr: number | null, task?: number) => void,
) {
  const latest = useRef({ claim, enabled, onOpen });
  latest.current = { claim, enabled, onOpen };
  const first = useRef(true);
  useEffect(() => {
    if (!ready) return;
    const run = async () => {
      let events: Claimed[];
      try {
        events = await latest.current.claim();
      } catch {
        return;
      }
      const notes = planNotes(events, first.current);
      first.current = false;
      if (!latest.current.enabled || notifyPermission() !== "granted") return;
      for (const note of notes) {
        const n = new Notification(note.title, { body: note.body, tag: note.tag });
        n.onclick = () => {
          window.focus();
          latest.current.onOpen(note.pr, note.task);
          n.close();
        };
      }
    };
    void run();
    liveEvents.addEventListener("events", run);
    return () => liveEvents.removeEventListener("events", run);
  }, [ready]);
}
