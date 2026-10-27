// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Server state of the tasks (docs/plans/review-v2/spec.md sections 6.11 and 6.18.6). Keys: ['tasks'], ['task', id],
// ['task', id, 'diff', head], ['task', id, 'run', run], ['task', id, 'branch', prefix], ['task-settings', project, repo],
// ['branches', project, repo, filter], ['task-profile', project, repo].
// live.ts refetches ['tasks'] and ['task', id] with the keys under it when SSE `changed` names the task.
import { keepPreviousData, type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  BranchCheckDto,
  BranchSearchDto,
  RepoTaskSettingsDto,
  RunDetail,
  TaskAnswersInput,
  TaskCreateInput,
  TaskDiffDto,
  TaskDto,
  TaskIssueDto,
  TaskPlanInput,
  TaskProfileDto,
  TaskRowDto,
} from "../../shared/dto";
import type { TaskDoc, TaskSize } from "../../shared/task";
import { api } from "../api";
import { ApiError, read } from "../shell/data";

const id$ = (id: number) => ({ id: String(id) });

export const useTasks = () =>
  useQuery({ queryKey: ["tasks"], queryFn: async () => read<TaskRowDto[]>(await api.api.tasks.$get({ query: { state: "all" } })) });

export const useTask = (id: number | null) =>
  useQuery({
    queryKey: ["task", id],
    enabled: id !== null,
    queryFn: async () => read<TaskDto>(await api.api.tasks[":id"].$get({ param: id$(id ?? 0) })),
  });

export const useTaskDiff = (id: number, part: number, head: string | null, enabled: boolean) =>
  useQuery({
    queryKey: ["task", id, "diff", head],
    enabled: enabled && head !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () =>
      read<TaskDiffDto>(await api.api.tasks[":id"].parts[":part"].diff.$get({ param: { id: String(id), part: String(part) } })),
  });

export const useTaskRun = (id: number, run: number | null) =>
  useQuery({
    queryKey: ["task", id, "run", run],
    enabled: run !== null,
    queryFn: async () =>
      read<RunDetail>(await api.api.tasks[":id"].runs[":run"].$get({ param: { id: String(id), run: String(run ?? 0) } })),
  });

// spec.md section 6.16.3: typing in the base picker waits this long before a read.
export const TYPE_WAIT_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

// GET /api/repos/:project/:repo/branches: one page of the branch search. filter: the text of that page, for its no-match sentence.
// The list keeps the previous page while the next one loads.
export function useBranches(project: string, repo: string, text: string) {
  const filter = useDebounced(text, TYPE_WAIT_MS);
  return useQuery({
    queryKey: ["branches", project, repo, filter],
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async () => ({
      ...(await read<BranchSearchDto>(
        await api.api.repos[":project"][":repo"].branches.$get({ param: { project, repo }, query: { filter } }),
      )),
      filter,
    }),
  });
}

// GET /api/tasks/:id/branch (spec.md section 6.16.4): where the planned name exists on the server. prefix null: no valid prefix, so
// no read. checked: the prefix of the current answer, which a typed prefix reaches after the wait.
export function useBranchCheck(id: number, prefix: string | null) {
  const checked = useDebounced(prefix, TYPE_WAIT_MS);
  const q = useQuery({
    queryKey: ["task", id, "branch", checked],
    enabled: checked !== null,
    queryFn: async () => read<BranchCheckDto>(await api.api.tasks[":id"].branch.$get({ param: id$(id), query: { prefix: checked ?? "" } })),
  });
  return { ...q, checked };
}

const repoSettings$ = () => api.api.repos[":project"][":repo"]["task-settings"];

export const useRepoTaskSettings = (project: string, repo: string) =>
  useQuery({
    queryKey: ["task-settings", project, repo],
    queryFn: async () => read<RepoTaskSettingsDto>(await repoSettings$().$get({ param: { project, repo } })),
  });

// GET /api/tasks/profile (spec.md section 6.2): the profile that the Build form preselects for a repository. null: no request.
export const useTaskProfile = (r: { project: string; repo: string } | null) =>
  useQuery({
    queryKey: ["task-profile", r?.project, r?.repo],
    enabled: r !== null,
    queryFn: async () =>
      read<TaskProfileDto>(await api.api.tasks.profile.$get({ query: { project: r?.project ?? "", repo: r?.repo ?? "" } })),
  });

// POST /api/tasks: 201 with a new task, or 200 with the open task of the same key.
export async function createTask(input: TaskCreateInput): Promise<TaskDto> {
  return read<TaskDto>(await api.api.tasks.$post({ json: input }));
}

// POST /api/tasks/issue (spec.md section 6.17): the summary and the attachments of a key. One tracker read on the user's click.
export async function readIssue(key: string): Promise<TaskIssueDto> {
  return read<TaskIssueDto>(await api.api.tasks.issue.$post({ json: { key } }));
}

// PUT /api/tasks/:id/files/:att (spec.md section 6.17): a tick downloads the file once and includes it. The answer holds the task.
export async function putTaskFile(qc: QueryClient, id: number, att: string, include: boolean): Promise<TaskDto> {
  const dto = await read<TaskDto>(await api.api.tasks[":id"].files[":att"].$put({ param: { id: String(id), att }, json: { include } }));
  qc.setQueryData(["task", id], dto);
  return dto;
}

// A 409 of a task mutation holds the current task (TaskConflict). The view takes it, so the next click sends the new version.
export type TaskAction =
  | { kind: "answers"; input: Omit<TaskAnswersInput, "version"> }
  | { kind: "plan"; input: Omit<TaskPlanInput, "version"> }
  // taskRepo: a repository of the task other than the main one (spec.md section 6.16.3).
  | { kind: "base"; branch: string; taskRepo?: number }
  // spec.md section 6.16.5: Add or Skip of a proposed repository.
  | { kind: "repo"; taskRepo: number; add: boolean }
  | { kind: "docs"; doc: TaskDoc; text: string }
  | { kind: "size"; size: TaskSize }
  | { kind: "pause" | "stop" | "resume" | "close" }
  | { kind: "keep" }
  | { kind: "limit"; lineBudget: number }
  | { kind: "change"; step: number; accept: boolean }
  | { kind: "pr"; part: number; reviewers: string[] }
  // spec.md section 6.16.8: "Push and open N PRs" and the retry of some rows (202), and "Point <parent> at the merged commit".
  | { kind: "prs"; part: number; rows: { taskRepo: number; reviewers: string[] }[] }
  | { kind: "pointer"; taskPr: number; newest?: true }
  | { kind: "fix"; part: number }
  // spec.md section 6.18.6: a send of the Tell box (the part of the current state), "Update from <base>", and "Undo the update".
  | { kind: "instruct"; text: string }
  | { kind: "update" | "undo"; part: number }
  // spec.md section 6.18.5: the base check before the PR dialog.
  | { kind: "base-check" };

async function send(t: TaskDto, a: TaskAction): Promise<TaskDto> {
  const param = id$(t.id);
  const version = t.version;
  const tasks = api.api.tasks[":id"];
  switch (a.kind) {
    case "answers":
      return read(await tasks.answers.$post({ param, json: { version, ...a.input } }));
    case "plan":
      return read(await tasks.plan.$post({ param, json: { version, ...a.input } }));
    // 200, or 202 when the plan runs again on the new base. Both hold the task.
    case "base":
      return read(
        await tasks.base.$put({ param, json: { version, branch: a.branch, ...(a.taskRepo !== undefined && { taskRepo: a.taskRepo }) } }),
      );
    // 202 after Add (the plan runs again), 200 after Skip.
    case "repo":
      return read(
        await tasks.repos[":taskRepo"].$post({ param: { ...param, taskRepo: String(a.taskRepo) }, json: { version, add: a.add } }),
      );
    case "docs":
      return read(await tasks.docs.$put({ param, json: { version, doc: a.doc, text: a.text } }));
    case "size":
      return read(await tasks.size.$post({ param, json: { version, size: a.size } }));
    case "pause":
      return read(await tasks.pause.$post({ param, json: { version } }));
    case "stop":
      return read(await tasks.stop.$post({ param, json: { version } }));
    case "resume":
      return read(await tasks.resume.$post({ param, json: { version } }));
    case "close":
      return read(await tasks.close.$post({ param, json: { version } }));
    case "keep":
      return read(await tasks.limit.$post({ param, json: { version, keep: true } }));
    case "limit":
      return read(await tasks.limit.$post({ param, json: { version, lineBudget: a.lineBudget } }));
    case "change":
      return read(
        await tasks["spec-change"][":step"].$post({ param: { ...param, step: String(a.step) }, json: { version, accept: a.accept } }),
      );
    case "pr":
      return read(
        await tasks.parts[":part"].pr.$post({ param: { ...param, part: String(a.part) }, json: { version, reviewers: a.reviewers } }),
      );
    case "prs":
      return read(await tasks.parts[":part"].prs.$post({ param: { ...param, part: String(a.part) }, json: { version, rows: a.rows } }));
    case "pointer":
      return read(
        await tasks.prs[":taskPr"].pointer.$post({
          param: { ...param, taskPr: String(a.taskPr) },
          json: { version, ...(a.newest && { newest: a.newest }) },
        }),
      );
    case "fix":
      return read(await tasks.parts[":part"].fix.$post({ param: { ...param, part: String(a.part) }, json: { version } }));
    case "instruct":
      return read(await tasks.instructions.$post({ param, json: { version, text: a.text } }));
    case "update":
      return read(await tasks.parts[":part"].update.$post({ param: { ...param, part: String(a.part) }, json: { version } }));
    case "undo":
      return read(await tasks.parts[":part"].update.undo.$post({ param: { ...param, part: String(a.part) }, json: { version } }));
    case "base-check":
      return read(await tasks["base-check"].$post({ param }));
  }
}

// Every task mutation. A success and a 409 with the current task both refresh the cached task.
export function useTaskAction(t: TaskDto | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: TaskAction) => {
      if (!t) throw new ApiError(409, "The task is not loaded yet.");
      return send(t, a);
    },
    onSuccess: (dto) => {
      qc.setQueryData(["task", dto.id], dto);
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: () => {
      if (t) qc.invalidateQueries({ queryKey: ["task", t.id] });
    },
  });
}
