// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Session consult server state and per-viewer storage (docs/plans/session-consult.md parts A, C, and D). Key ['pr', pr, 'consult']:
// live.ts invalidates it with the PR. Storage can be off or full, so each read and write has a fallback.
import { useQuery } from "@tanstack/react-query";
import {
  type ConsultData,
  type ConsultGroup,
  type ConsultImportDto,
  type ConsultUndoDto,
  consultGroups,
  type SessionAnswerDto,
  type SessionListDto,
  type SessionMode,
  type SessionStartInput,
  sessionModes,
} from "../../shared/consult";
import { api } from "../api";
import { started, useStart } from "../review/data";
import { read } from "../shell/data";

const param = (id: number) => ({ param: { id: String(id) } });

export const consultKey = (pr: number) => ["pr", pr, "consult"] as const;

// GET /api/prs/:id/consult: the header and the item blocks of all groups. It reads the git cache, so it runs only while a dialog is open.
export const useConsultData = (pr: number, enabled: boolean) =>
  useQuery({
    queryKey: consultKey(pr),
    enabled,
    staleTime: 0,
    queryFn: async () => read<ConsultData>(await api.api.prs[":id"].consult.$get(param(pr))),
  });

// Part C: the server reads the entries and the item keys of the session run. Part D: it also adds the proposed fix of the run.
export const postSessionImport = async (pr: number, session: number) =>
  read<ConsultImportDto>(await api.api.prs[":id"].consult.import.$post({ ...param(pr), json: { session } }));

export const postUndo = async (pr: number, run: number) =>
  read<ConsultUndoDto>(await api.api.prs[":id"].consult[":run"].undo.$post({ param: { id: String(pr), run: String(run) } }));

// ---------- Part C ----------

// GET /api/prs/:id/consult/sessions reads the transcript folder, so it runs only while the picker shows. Its key is outside
// ['pr', pr]: a PR change does not read the folder again.
export const useSessions = (pr: number, enabled: boolean) =>
  useQuery({
    queryKey: ["sessions", pr],
    enabled,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => read<SessionListDto>(await api.api.prs[":id"].consult.sessions.$get(param(pr))),
  });

// The answer of an ended session run does not change.
export const useSessionAnswer = (pr: number, run: number | null) =>
  useQuery({
    queryKey: ["pr", pr, "consult", "session", run],
    enabled: run !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () =>
      read<SessionAnswerDto>(await api.api.prs[":id"].consult.session[":run"].$get({ param: { id: String(pr), run: String(run ?? 0) } })),
  });

// POST /api/prs/:id/consult/session. 202 starts a run. 409 with `running` names the run of the PR or of a full run pool.
export const useStartSession = (pr: number) =>
  useStart(pr, async (json: SessionStartInput) => started(await api.api.prs[":id"].consult.session.$post({ ...param(pr), json })));

// ---------- Per viewer ----------

const GROUPS = "rl:consult-groups";
const MODE = "rl:consult-mode";

// Part D: the mode of the last session run that this viewer started. Default: judge.
export function loadMode(): SessionMode {
  try {
    const raw = localStorage.getItem(MODE);
    if (sessionModes.includes(raw as SessionMode)) return raw as SessionMode;
  } catch {}
  return "judge";
}
export function saveMode(mode: SessionMode) {
  try {
    localStorage.setItem(MODE, mode);
  } catch {}
}

// The ticked groups of the copy dialog. Default: all.
export function loadGroups(): Set<ConsultGroup> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUPS) ?? "null") as unknown;
    if (Array.isArray(raw)) return new Set(consultGroups.filter((g) => raw.includes(g)));
  } catch {}
  return new Set(consultGroups);
}
export function saveGroups(groups: ReadonlySet<ConsultGroup>) {
  try {
    localStorage.setItem(GROUPS, JSON.stringify([...groups]));
  } catch {}
}
