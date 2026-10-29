// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Notification claim flow (plan G7). The server claim gives each event to one tab only.
import { useEffect, useRef } from "react";
import type { ClaimedEvent } from "../shared/dto";
import { liveEvents } from "./live";
import { prKey } from "./shell/model";

// pr null: a digest. Its click opens Needs you.
export type Note = { title: string; body: string; tag: string; pr: number | null };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const KIND_TEXT: Record<ClaimedEvent["kind"], (n: number) => string> = {
  comment_new: (n) => plural(n, "new comment"),
  commits_pushed: () => "new commits",
  reviewer_added: () => "review requested",
  draft_stale: (n) => `${plural(n, "reply draft")} out of date`,
  build_failed: () => "build failed",
  build_passed: () => "build passed",
};

// The first claim of a tab, or a batch with a digest event, gives one digest. Otherwise one note per PR.
export function planNotes(events: ClaimedEvent[], first: boolean): Note[] {
  if (!events.length) return [];
  const byPr = new Map<number, ClaimedEvent[]>();
  for (const e of events) byPr.set(e.pr, [...(byPr.get(e.pr) ?? []), e]);
  if (first || events.some((e) => e.digest)) {
    return [
      {
        title: "PR Review Inbox",
        body: `${plural(events.length, "update")} in ${plural(byPr.size, "pull request")}`,
        tag: "digest",
        pr: null,
      },
    ];
  }
  return [...byPr].map(([pr, list]) => {
    const head = list[0] as ClaimedEvent;
    const counts = new Map<ClaimedEvent["kind"], number>();
    for (const e of list) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const body = [...counts].map(([kind, n]) => KIND_TEXT[kind](n)).join(", ");
    return { title: head.title ?? prKey(head), body: `${prKey(head)}: ${body}`, tag: prKey(head), pr };
  });
}

export const notifyPermission = (): NotificationPermission | "unsupported" =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

// Claims once on load and on each `events` message, also with notifications off, so no backlog floods later.
// ready: the settings are loaded and hold a base URL. An unconfigured server refuses the claim, and the next claim would count as the first.
export function useClaims(claim: () => Promise<ClaimedEvent[]>, ready: boolean, enabled: boolean, onOpen: (pr: number | null) => void) {
  const latest = useRef({ claim, enabled, onOpen });
  latest.current = { claim, enabled, onOpen };
  const first = useRef(true);
  useEffect(() => {
    if (!ready) return;
    const run = async () => {
      let events: ClaimedEvent[];
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
          latest.current.onOpen(note.pr);
          n.close();
        };
      }
    };
    void run();
    liveEvents.addEventListener("events", run);
    return () => liveEvents.removeEventListener("events", run);
  }, [ready]);
}
