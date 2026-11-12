// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review server state through TanStack Query. Keys: ['brief', pr], ['runs'], ['runs', 'pr', pr], ['runs', 'slots'], ['run', id],
// ['raw', id], ['pr', pr, 'reply-drafts']. live.ts invalidates ['runs'] with its sub-keys and ['run', id] when SSE `changed` names
// the run, and ['pr', pr] and ['runs', 'pr', pr] when it names the PR.
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type {
  BriefDto,
  BriefInput,
  ItemActionInput,
  ItemConflict,
  ProfileInput,
  ReviewItemDto,
  RunConflict,
  RunDetail,
  RunDto,
  RunSlotsDto,
  SettingsDto,
} from "../../shared/dto";
import { api } from "../api";
import { ApiError, read } from "../shell/data";

const param = (id: number) => ({ param: { id: String(id) } });

export const useBrief = (pr: number) =>
  useQuery({ queryKey: ["brief", pr], queryFn: async () => read<BriefDto>(await api.api.prs[":id"].brief.$get(param(pr))) });

// A plain function, so a save from an unmounted composer still ends and updates the cache.
export async function putBrief(qc: QueryClient, pr: number, input: BriefInput) {
  const dto = await read<BriefDto>(await api.api.prs[":id"].brief.$put({ ...param(pr), json: input }));
  qc.setQueryData(["brief", pr], dto);
  return dto;
}

// Decision D2 (plan pr-view-v4): the profile of the last review start on any PR, per browser. It only sets the preselection of
// a brief that is not stored yet, so a blocked or absent storage gives null and keeps nothing.
const LAST_PROFILE = "rl:last-profile";
export function loadLastProfile(): string | null {
  try {
    return localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}
export function saveLastProfile(id: string) {
  try {
    localStorage.setItem(LAST_PROFILE, id);
  } catch {}
}

// docs/plans/review-v2/spec.md section 1.1: a check or volume change in the brief saves to the profile at once. The cache shows the
// change at once. The saves go out one after the other, and a queued save that a newer one replaces is skipped, so the last request
// carries every change.
export function useSaveProfile() {
  const qc = useQueryClient();
  const chain = useRef(Promise.resolve());
  const last = useRef(0);
  return useCallback(
    (id: string, patch: Partial<Pick<ProfileInput, "modules" | "volume" | "languageChecks">>, onError: (e: unknown) => void) => {
      const s = qc.getQueryData<SettingsDto>(["settings"]);
      if (!s) return;
      qc.setQueryData<SettingsDto>(["settings"], { ...s, profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
      const mine = ++last.current;
      chain.current = chain.current.then(async () => {
        const now = qc.getQueryData<SettingsDto>(["settings"]);
        if (!now || mine !== last.current) return;
        try {
          const json = { baseUrl: now.baseUrl ?? "", caFile: now.caFile ?? "", profiles: now.profiles };
          const dto = await read<SettingsDto>(await api.api.settings.$put({ json }));
          if (mine === last.current) qc.setQueryData(["settings"], dto);
          // Meta never goes stale by itself. The Review button and the brief read the profiles from it.
          void qc.invalidateQueries({ queryKey: ["meta"] });
        } catch (e) {
          void qc.invalidateQueries({ queryKey: ["settings"] });
          onError(e);
        }
      });
    },
    [qc],
  );
}

export const usePrRuns = (pr: number) =>
  useQuery({ queryKey: ["runs", "pr", pr], queryFn: async () => read<RunDto[]>(await api.api.prs[":id"].runs.$get(param(pr))) });

// GET /api/runs: the 50 newest runs of all PRs, newest first.
export const useRuns = () => useQuery({ queryKey: ["runs"], queryFn: async () => read<RunDto[]>(await api.api.runs.$get()) });

// GET /api/runs/slots (spec.md section 6.26): the run limit and the pool runs, oldest first.
export const useRunSlots = () =>
  useQuery({ queryKey: ["runs", "slots"], queryFn: async () => read<RunSlotsDto>(await api.api.runs.slots.$get()) });

export const getRun = async (id: number) => read<RunDetail>(await api.api.runs[":id"].$get(param(id)));

export const useRun = (id: number | null) => useQuery({ queryKey: ["run", id], enabled: id !== null, queryFn: () => getRun(id ?? 0) });

// The raw output of an ended run does not change.
export const useRaw = (id: number, enabled: boolean) =>
  useQuery({
    queryKey: ["raw", id],
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const res = await api.api.runs[":id"].raw.$get(param(id));
      if (!res.ok) return read<string>(res);
      return res.text();
    },
  });

export const replyKey = (pr: number) => ["pr", pr, "reply-drafts"] as const;

// GET /api/prs/:id/reply-drafts (replies.md WP17): the newest unposted reply draft of each thread.
export const useReplyDrafts = (pr: number) =>
  useQuery({
    queryKey: replyKey(pr),
    queryFn: async () => read<ReviewItemDto[]>(await api.api.prs[":id"]["reply-drafts"].$get(param(pr))),
  });

export type StartResult = { run: RunDto } | { conflict: RunConflict };

// 409 with `running` names the run of the PR, or the oldest run of a full pool (A14, spec.md section 6.26). Any other 409 is an error.
export async function started(res: {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<StartResult> {
  if (res.status !== 409) return { run: await read<RunDto>(res) };
  const text = await res.text();
  let body: Partial<RunConflict> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (body.running) return { conflict: body as RunConflict };
  throw new ApiError(409, body.error ?? text);
}

export function useStart<A>(pr: number, post: (a: A) => Promise<StartResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: post,
    onSuccess: (r) => {
      // A refused start shows that the slots data is old.
      if (!("run" in r)) return void qc.invalidateQueries({ queryKey: ["runs", "slots"] });
      qc.setQueryData<RunDto[]>(["runs", "pr", pr], (old) => [r.run, ...(old ?? []).filter((x) => x.id !== r.run.id)]);
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

// A run start. profile: a profile for this run only. Absent: the brief profile.
export type RunStart = { threads?: number[]; profile?: string };
export const runBody = ({ threads, profile }: RunStart) => ({ ...(threads && { threads }), ...(profile && { profile }) });

// POST /api/prs/:id/review runs the stored brief.
export const useStartReview = (pr: number) =>
  useStart(pr, async () => started(await api.api.prs[":id"].review.$post({ ...param(pr), query: {} })));

// POST /api/prs/:id/rereview (plan r2 S-RR) reviews the commits since the newest review run and carries its open items.
export const useStartRereview = (pr: number) => useStart(pr, async () => started(await api.api.prs[":id"].rereview.$post(param(pr))));

// POST /api/prs/:id/reply-run runs the stored brief as reply drafts. Absent threads: every thread where it is my turn.
export const useStartReplies = (pr: number) =>
  useStart(pr, async (o: RunStart) => started(await api.api.prs[":id"]["reply-run"].$post({ ...param(pr), json: runBody(o) })));

export type ItemResult = { item: ReviewItemDto } | { conflict: ItemConflict };

// Item requests that are out. The post confirm reads the plan only after they end.
const sending = new Set<Promise<ItemResult>>();
export const itemsSettled = () => Promise.allSettled(sending);

export function sendItem(id: number, input: ItemActionInput): Promise<ItemResult> {
  const p = postItem(id, input).finally(() => sending.delete(p));
  sending.add(p);
  return p;
}

// POST /api/items/:id (WP12). 409 with `item`: the item changed in another page. The page then shows that item.
async function postItem(id: number, input: ItemActionInput): Promise<ItemResult> {
  const res = await api.api.items[":id"].$post({ ...param(id), json: input });
  if (res.status !== 409) return { item: await read<ReviewItemDto>(res) };
  const text = await res.text();
  let body: Partial<ItemConflict> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (body.item) return { conflict: body as ItemConflict };
  throw new ApiError(409, body.error ?? text);
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => read<{ cancelling: boolean }>(await api.api.runs[":id"].cancel.$post(param(id))),
    onSettled: (_, __, id) => qc.invalidateQueries({ queryKey: ["run", id] }),
  });
}
