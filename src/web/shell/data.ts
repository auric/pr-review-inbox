// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Server state through TanStack Query. Keys: ['prs'], ['prs', 'archive'], ['pr', id], ['status'], ['settings'], ['meta'], ['task-preview', ...].
// An invalidation of ['prs'] also refreshes ['prs', 'archive'].
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import type { CheckpointDto, Claimed, FollowState, PrDetail, PrRow, SettingsDto, SettingsInput, SyncStatus } from "../../shared/dto";
import { api } from "../api";
import type { AckItem } from "../pr/ack";
import { ARCHIVED_TEXT, failText, prKey, restoreWords, unfollowText } from "./model";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // The server restarted and the page holds an old session token.
    readonly stale = false,
  ) {
    super(message);
  }
}

// A rejected fetch means that the local server does not answer.
export const isStopped = (e: unknown) => e instanceof TypeError;
export const isStale = (e: unknown) => e instanceof ApiError && e.stale;

// The hc client response. Its type is not a DOM Response.
type Res = { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };

// Retries only failures that can pass: not a stopped server, not an answer from the server.
export const retry = (n: number, e: unknown) => !isStopped(e) && !(e instanceof ApiError) && n < 2;

export async function read<T>(res: Res): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const text = await res.text();
  if (res.status === 403 && text === "session_stale") throw new ApiError(403, "The service restarted. Reload the page.", true);
  let message = text || `Request failed (${res.status}).`;
  try {
    message = (JSON.parse(text) as { error?: string }).error ?? message;
  } catch {}
  throw new ApiError(res.status, message);
}

export type Status = { sync: SyncStatus; dashboard: CheckpointDto | null };

export const usePrs = () => useQuery({ queryKey: ["prs"], queryFn: async () => read<PrRow[]>(await api.api.prs.$get()) });
export const useArchived = (enabled: boolean) =>
  useQuery({ queryKey: ["prs", "archive"], enabled, queryFn: async () => read<PrRow[]>(await api.api.archive.$get()) });
export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: async () => read<Status>(await api.api.status.$get()) });
export const useSettings = () =>
  useQuery({ queryKey: ["settings"], queryFn: async () => read<SettingsDto>(await api.api.settings.$get()) });

export const usePr = (id: number, enabled = true) =>
  useQuery({
    queryKey: ["pr", id],
    enabled,
    queryFn: async () => read<PrDetail>(await api.api.prs[":id"].$get({ param: { id: String(id) } })),
  });

// plan v3 section 2: the last visit. The detail keeps the previous value for "N new since".
export const sendSeen = async (id: number) =>
  read<{ id: number; seenAt: number }>(await api.api.prs[":id"].seen.$post({ param: { id: String(id) } }));

export const claimEvents = async () => read<Claimed[]>(await api.api.notifications.claim.$post());

// keepalive: the request also completes when the page closes.
export const sendRead = async (pr: number, items: AckItem[]) =>
  read<{ updated: number }>(await api.api.read.$post({ json: { pr, items } }, { init: { keepalive: true } }));

// Follow also clears archived_at and starts a check.
const postFollow = async (id: number, followed: boolean) =>
  read<FollowState>(await api.api.prs[":id"].follow.$post({ param: { id: String(id) }, json: { followed } }));

const postArchive = async (id: number, archived: boolean) =>
  read<FollowState>(await api.api.prs[":id"].archive.$post({ param: { id: String(id) }, json: { archived } }));

const undoFailed = (e: Error) => toast.add({ title: "Undo failed", description: failText(e, "page") });

// An unfollow can take the PR out of every view but Archive, so its toast offers Undo.
export function useFollow() {
  const qc = useQueryClient();
  const refresh = (id: number) => {
    qc.invalidateQueries({ queryKey: ["prs"] });
    qc.invalidateQueries({ queryKey: ["pr", id] });
  };
  return useMutation({
    mutationFn: ({ pr, followed }: { pr: PrRow; followed: boolean }) => postFollow(pr.id, followed),
    onSuccess: (_, { pr, followed }) => {
      if (followed) return;
      toast.add({
        title: `Stopped following ${prKey(pr)}`,
        description: unfollowText(pr),
        actionProps: { children: "Undo", onClick: () => postFollow(pr.id, true).then(() => refresh(pr.id), undoFailed) },
      });
    },
    onError: (e, { followed }) => toast.add({ title: followed ? "Follow failed" : "Unfollow failed", description: failText(e, "page") }),
    onSettled: (_, __, { pr }) => refresh(pr.id),
  });
}

// The Archive view. The row leaves the view before the request.
export function useRestore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pr: PrRow) => postFollow(pr.id, true),
    onMutate: async (pr) => {
      await qc.cancelQueries({ queryKey: ["prs", "archive"] });
      qc.setQueryData<PrRow[]>(["prs", "archive"], (old) => old?.filter((p) => p.id !== pr.id));
    },
    onSuccess: (_, pr) => toast.add({ title: `${restoreWords(pr).done} ${prKey(pr)}`, description: "It is back in Following." }),
    onError: (e, pr) => toast.add({ title: `${restoreWords(pr).verb} failed`, description: failText(e, "page") }),
    onSettled: (_, __, pr) => {
      qc.invalidateQueries({ queryKey: ["prs"] });
      qc.invalidateQueries({ queryKey: ["pr", pr.id] });
    },
  });
}

// The PR leaves the list before the request, so its detail unmounts and never refetches into a 404.
// Hook-level callbacks run also after the detail unmounts. Per-call callbacks would not.
export function useArchive() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["prs"] });
  return useMutation({
    mutationFn: ({ id }: { id: number; label: string }) => postArchive(id, true),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: ["prs"] });
      qc.setQueryData<PrRow[]>(["prs"], (old) => old?.filter((p) => p.id !== id));
    },
    onSuccess: (_, { id, label }) =>
      toast.add({
        title: `Archived ${label}`,
        description: ARCHIVED_TEXT,
        actionProps: { children: "Undo", onClick: () => postArchive(id, false).then(refresh, undoFailed) },
      }),
    onError: (e) => toast.add({ title: "Archive failed", description: failText(e, "page") }),
    onSettled: refresh,
  });
}

export function useCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => read<SyncStatus>(await api.api.sync.$post()),
    onSuccess: (sync) => qc.setQueryData<Status>(["status"], (old) => (old ? { ...old, sync } : old)),
  });
}

export function useFollowUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (url: string) => read<FollowState>(await api.api.follow.$post({ json: { url } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prs"] }),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SettingsInput) => read<SettingsDto>(await api.api.settings.$put({ json: input })),
    onSuccess: (dto) => {
      qc.setQueryData(["settings"], dto);
      qc.invalidateQueries({ queryKey: ["prs"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      // A new URL, token, or CA file cancels the runs (jobs.ts). A new origin closes their database before their end write, so no live
      // update names them.
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
