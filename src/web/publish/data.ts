// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Publish server state (plan v3 WP14a). Keys: ['pr', pr, 'post-plan'] and ['pr', pr, 'posts'].
// live.ts invalidates ['pr', pr] when SSE `changed` names the PR, and the prefix covers both keys.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type {
  ConfirmDto,
  PostDto,
  PostPlanDto,
  ReplyConflict,
  ReplyPostInput,
  ThreadResolveError,
  ThreadResolveInput,
} from "../../shared/dto";
import { api } from "../api";
import { ApiError, read } from "../shell/data";

const param = (id: number) => ({ param: { id: String(id) } });

export const planKey = (pr: number) => ["pr", pr, "post-plan"] as const;
export const postsKey = (pr: number) => ["pr", pr, "posts"] as const;

export const fetchPlan = async (pr: number) => read<PostPlanDto>(await api.api.prs[":id"]["post-plan"].$get(param(pr)));

export const usePostPlan = (pr: number) => useQuery({ queryKey: planKey(pr), queryFn: () => fetchPlan(pr) });

export const usePosts = (pr: number) =>
  useQuery({ queryKey: postsKey(pr), queryFn: async () => read<PostDto[]>(await api.api.prs[":id"].posts.$get(param(pr))) });

// existing: an earlier confirm with the same items made the rows, for example in another page (A14).
export async function confirmPosts(pr: number, items: { id: number; revision: number }[]) {
  const res = await api.api.prs[":id"].confirm.$post({ ...param(pr), json: { items } });
  const dto = await read<ConfirmDto>(res);
  return { ...dto, existing: res.status === 200 };
}

export type ReplyResult = { post: PostDto } | { conflict: ReplyConflict };

// The AI reply drafts to discard once the user's own reply post is confirmed: item ID by post ID (Outbox.tsx useOutbox). Memory only,
// so a reload keeps the draft.
export const replyDiscards = new Map<number, number>();

// 409 with `newest`: new messages arrived after the page showed the thread. Any other 409 is an error.
export async function postReply(pr: number, input: ReplyPostInput): Promise<ReplyResult> {
  const res = await api.api.prs[":id"].replies.$post({ ...param(pr), json: input });
  if (res.status !== 409) return { post: await read<PostDto>(res) };
  const text = await res.text();
  let body: Partial<ReplyConflict> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (typeof body.newest === "number") return { conflict: body as ReplyConflict };
  throw new ApiError(409, body.error ?? text);
}

export const retryPost = async (id: number) => read<PostDto>(await api.api.posts[":id"].retry.$post(param(id)));

// "Resolve again" after a failed resolve step. The comment is not posted again.
export const retryResolve = async (id: number) => read<PostDto>(await api.api.posts[":id"].resolve.$post(param(id)));

// null: the thread has the wanted state now. Else the reason and the words to show.
export type ResolveOutcome = { error: string; reason: ThreadResolveError["reason"] | null } | null;

// POST /api/prs/:id/resolve: a manual resolve or reopen, sent now.
export async function setThreadResolved(pr: number, input: ThreadResolveInput): Promise<ResolveOutcome> {
  const res = await api.api.prs[":id"].resolve.$post({ ...param(pr), json: input });
  if (res.ok) return null;
  const text = await res.text();
  let body: Partial<ThreadResolveError> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  return { error: body.error ?? `The request failed (HTTP ${res.status}).`, reason: body.reason ?? null };
}

// general: the findings of a failed inline post go into the next general comment.
export const dropPost = async (id: number, general: boolean) =>
  read<{ items: { id: number; revision: number }[] }>(await api.api.posts[":id"].drop.$post({ ...param(id), json: { general } }));

// The Ready to post view: the plan of each PR with a review run that has posts or blocked drafts. One local request per PR.
// shortcut: one plan request per PR with a run; a server count in PrRow replaces it if the list grows.
export function useReadyToPost(prs: number[]): ReadonlyMap<number, PostPlanDto> {
  const results = useQueries({ queries: prs.map((pr) => ({ queryKey: planKey(pr), queryFn: () => fetchPlan(pr) })) });
  const sig = results.map((r) => r.dataUpdatedAt).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: sig changes with every new plan.
  return useMemo(() => {
    const out = new Map<number, PostPlanDto>();
    for (const r of results) if (r.data?.posts.length || r.data?.blocked?.length) out.set(r.data.pr, r.data);
    return out;
  }, [sig]);
}
