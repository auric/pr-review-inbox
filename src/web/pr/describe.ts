// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Write description server state. Key ['pr', pr, 'describe']: live.ts invalidates it with the PR when a run starts or ends.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DescribeDto, DescribeUpdateInput, DescriptionConflict } from "../../shared/dto";
import { api } from "../api";
import { started, useStart } from "../review/data";
import { ApiError, read } from "../shell/data";

const param = (id: number) => ({ param: { id: String(id) } });

export const describeKey = (pr: number) => ["pr", pr, "describe"] as const;

// GET /api/prs/:id/describe: the newest describe run with its open proposal, or null. Reading starts no run.
export const useDescribe = (pr: number) =>
  useQuery({ queryKey: describeKey(pr), queryFn: async () => read<DescribeDto | null>(await api.api.prs[":id"].describe.$get(param(pr))) });

// POST /api/prs/:id/describe with the brief profile. 202 starts a run, 200 gives the running run.
export function useStartDescribe(pr: number) {
  const qc = useQueryClient();
  return useStart(pr, async () => {
    const r = await started(await api.api.prs[":id"].describe.$post({ ...param(pr), query: {} }));
    if ("run" in r) void qc.invalidateQueries({ queryKey: describeKey(pr) });
    return r;
  });
}

// POST /api/prs/:id/describe/discard: closes the proposal. Nothing goes to the forge.
export function useDiscardDescribe(pr: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (run: number) => read<{ ok: true }>(await api.api.prs[":id"].describe.discard.$post({ ...param(pr), json: { run } })),
    onSettled: () => qc.invalidateQueries({ queryKey: describeKey(pr) }),
  });
}

// A stale PR version. current: the text that the server read again and stored. Absent: the read failed too.
export class StaleDescription extends ApiError {
  constructor(
    message: string,
    readonly current?: Omit<DescriptionConflict, "error">,
  ) {
    super(409, message);
  }
}

// POST /api/prs/:id/description: the user's click on the update button. A 409 throws StaleDescription.
export function useUpdateDescription(pr: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DescribeUpdateInput) => {
      const res = await api.api.prs[":id"].description.$post({ ...param(pr), json: input });
      if (res.status !== 409) return read<{ version: number }>(res);
      const body = (await res.json()) as Partial<DescriptionConflict>;
      const { error = "Someone changed this pull request after the app read it.", ...current } = body;
      throw new StaleDescription(error, current.version === undefined ? undefined : (current as Omit<DescriptionConflict, "error">));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: describeKey(pr) });
      void qc.invalidateQueries({ queryKey: ["pr", pr] });
    },
  });
}
