// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// One EventSource for all tabs of the app. EventSource reconnects by itself.
import type { InvalidateQueryFilters, Query, QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

// Dispatches "events" when the server stored new notification events.
export const liveEvents = new EventTarget();

// The queries that one "changed" event makes stale.
// The diff keys stay out: diffRefresh refetches them when the source head changes. A review run fills the missing code, so an index that asks for it refetches.
// tasks: the tasks of docs/plans/review-v2/spec.md section 6.11. A task change alone leaves the PR list as it is.
export function changedFilters(data: { prs?: number[]; runs?: number[]; tasks?: number[] }): InvalidateQueryFilters[] {
  const prs = data.prs ?? [];
  const runs = data.runs ?? [];
  const tasks = data.tasks ?? [];
  const out: InvalidateQueryFilters[] = [];
  // A run event without PRs is a log update. The PR list does not change with it.
  if (prs.length || (!runs.length && !tasks.length)) out.push({ queryKey: ["prs"] }, { queryKey: ["status"] });
  if (tasks.length) out.push({ queryKey: ["tasks"] }, ...tasks.map((id) => ({ queryKey: ["task", id] })));
  for (const id of prs)
    out.push(
      {
        queryKey: ["pr", id],
        predicate: (q) =>
          q.queryKey[2] !== "diff" || (q.queryKey.length === 3 && (q.state.data as { fetch?: unknown } | undefined)?.fetch === true),
      },
      { queryKey: ["brief", id] },
      // RunDto.stale compares the run heads with the PR heads, so a synced push changes the runs of the PR.
      { queryKey: ["runs", "pr", id] },
    );
  if (runs.length) {
    out.push({ queryKey: ["runs"] }, ...runs.map((id) => ({ queryKey: ["run", id] })));
    // A run start and a run end name the PR too. Each of them refreshes the runner check.
    if (prs.length) out.push({ queryKey: ["meta"] });
  }
  return out;
}

// The diff queries of PR pr after its source head changed from before to head. null: no change, or the first value.
export const diffRefresh = (
  pr: number,
  before: string | null | undefined,
  head: string | null | undefined,
): InvalidateQueryFilters | null =>
  before !== undefined && head !== undefined && before !== head ? { queryKey: ["pr", pr, "diff"] } : null;

// resync: the stream reconnected or moved to another tab. Messages in the gap are lost.
export type LiveMessage =
  | { type: "changed"; data: { prs?: number[]; runs?: number[]; tasks?: number[] } }
  | { type: "events" }
  | { type: "resync" };

type Qc = Pick<QueryClient, "invalidateQueries" | "cancelQueries">;

// TanStack Query gives an invalidated query in its first load the request that is out. That request can be older than the change.
// So the change cancels it, and the invalidate sends a new one. The filter keeps to the queries that the invalidate refetches.
function refetch(qc: Qc, f?: InvalidateQueryFilters) {
  const first = (q: Query) => q.state.data === undefined && !q.isDisabled() && !q.isStatic() && (f?.predicate?.(q) ?? true);
  void qc.cancelQueries({ queryKey: f?.queryKey, type: "active", fetchStatus: "fetching", predicate: first }, { silent: true });
  void qc.invalidateQueries(f);
}

export function applyLive(qc: Qc, m: LiveMessage) {
  if (m.type === "changed") for (const f of changedFilters(m.data)) refetch(qc, f);
  if (m.type === "resync") refetch(qc);
  // Each tab claims the new events. The server gives each event to one tab only.
  if (m.type !== "changed") liveEvents.dispatchEvent(new Event("events"));
}

export type LiveEnv = {
  source: () => Pick<EventSource, "addEventListener" | "close">;
  locks?: Pick<LockManager, "request">;
  channel?: Pick<BroadcastChannel, "postMessage" | "close" | "onmessage">;
};

const LOCK = "rl-live";

// Browsers allow 6 HTTP/1.1 connections per host across all tabs. The tab that holds the lock owns the only stream
// and forwards its messages to the other tabs. A hidden tab keeps the stream, because notifications need it.
export function connectLive(qc: Qc, env: LiveEnv): () => void {
  const stop = new AbortController();
  const { locks, channel } = env;
  // Resolves on disconnect, which frees the lock.
  const own = (takeover: boolean) =>
    new Promise<void>((resolve) => {
      if (stop.signal.aborted) return resolve();
      const es = env.source();
      const send = (m: LiveMessage) => {
        applyLive(qc, m);
        channel?.postMessage(m);
      };
      let opened = false;
      es.addEventListener("changed", (e) => {
        let data: { prs?: number[]; runs?: number[]; tasks?: number[] } = {};
        try {
          data = JSON.parse((e as MessageEvent<string>).data);
        } catch {}
        send({ type: "changed", data });
      });
      es.addEventListener("events", () => send({ type: "events" }));
      es.addEventListener("open", () => {
        if (opened || takeover) send({ type: "resync" });
        opened = true;
      });
      stop.signal.addEventListener("abort", () => {
        es.close();
        resolve();
      });
    });
  if (!locks || !channel) {
    void own(false);
    return () => stop.abort();
  }
  channel.onmessage = (e: MessageEvent<LiveMessage>) => applyLive(qc, e.data);
  // The spec forbids signal together with ifAvailable, so the first request has no signal.
  locks
    .request(LOCK, { ifAvailable: true }, (lock) => (lock ? own(false) : locks.request(LOCK, { signal: stop.signal }, () => own(true))))
    .catch(() => {});
  return () => {
    stop.abort();
    channel.close();
  };
}

export function useLive(qc: QueryClient) {
  useEffect(
    () =>
      connectLive(qc, {
        source: () => new EventSource("/api/live"),
        locks: navigator.locks,
        channel: typeof BroadcastChannel === "function" ? new BroadcastChannel(LOCK) : undefined,
      }),
    [qc],
  );
}
