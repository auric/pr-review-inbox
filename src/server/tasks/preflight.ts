// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The pre-flight of a build and of each push (docs/plans/review-v2/spec.md section 6.16.7, design.md B21): write permission, base
// branch, branch rules, and the branch check, per repository with access edit. It sends GET requests and `git ls-remote` only, so no
// Claude step runs before it passes.
import type { Database } from "bun:sqlite";
import { REPO_REASON, type TaskBlocked } from "../../shared/task";
import { ForgeError } from "../bitbucket/client";
import type { ForgeProvider } from "../bitbucket/provider";
import { log } from "../log";
import { git, gitEnv } from "../review/git";
import { type BranchRemote, gitSetup, longPath, noUrl } from "../review/workspace";
import { staleText } from "./push";
import { canWrite, setAccess, type TaskRepoRow, taskRepos } from "./repos";

// Data Center 9.6 REST, branch permissions: the restriction types that stop a push of the task branch.
const BLOCKING = new Set(["read-only", "pull-request-only", "no-creates"]);
const LS_REMOTE_MS = 60_000;
const HEAD = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\trefs\/heads\/(.+)$/;

export type PreflightProvider = Pick<ForgeProvider, "origin" | "writableRepos" | "restrictions">;

export type PreflightDeps = {
  dataDir: string;
  // null: no Bitbucket URL or token. Steps 1 and 3 need it, and the push needs it too, so they skip.
  provider: () => Promise<PreflightProvider | null>;
  remote: (project: string, repo: string) => Promise<BranchRemote>;
  now?: () => number;
};

type TaskRef = Parameters<typeof taskRepos>[1] & { id: number };

export const noWriteText = (repo: string) =>
  `Needs you: the token cannot push to ${repo}. Give it Repository write in Bitbucket, then try again.`;
export const baseGoneText = (base: string, repo: string) => `Needs you: ${base} no longer exists in ${repo}. Pick another base branch.`;
export const ruleText = (repo: string, branch: string) =>
  `Needs you: a branch rule in ${repo} forbids pushes to ${branch}. Pick another prefix.`;
export const existsText = (branch: string) => `Needs you: ${branch} already exists on the server.`;

const blocked = (text: string): TaskBlocked => ({ kind: "preflight", step: null, text });

// The heads of names on the remote (`git ls-remote --heads`).
async function heads(dataDir: string, remote: BranchRemote, names: string[]): Promise<Map<string, string>> {
  const { empty } = gitSetup(longPath(dataDir));
  const out = await git(["ls-remote", "--heads", "--end-of-options", remote.url, ...names.map((n) => `refs/heads/${n}`)], {
    env: gitEnv(empty, remote.config),
    timeoutMs: LS_REMOTE_MS,
  });
  const map = new Map<string, string>();
  for (const l of out.split("\n")) {
    const m = HEAD.exec(l.trimEnd());
    if (m) map.set(m[2] as string, m[1] as string);
  }
  return map;
}

const reason = (e: unknown, config: [string, string][] = []) =>
  config.reduce((s, [, v]) => (v ? s.replaceAll(v, "[redacted]") : s), noUrl((e as Error).message));

// The repositories that get the task branch: access edit, mapped to Bitbucket.
const editable = (rows: TaskRepoRow[]) => rows.filter((r) => r.access === "edit" && r.project && r.repo);

// Returns the first reason that stops the build or the push, or null. branch: the task branch. leases: the lease of the next push per
// task_repo id (main: id of its row, or 0 for a task without rows); absent or null: the branch must not exist yet. A first-level
// submodule without write gets access read with its reason.
export async function preflight(
  db: Database,
  deps: PreflightDeps,
  t: TaskRef,
  branch: string,
  leases: ReadonlyMap<number, string | null> | null = null,
): Promise<TaskBlocked | null> {
  const now = deps.now ?? Date.now;
  const p = await deps.provider();
  let rows = editable(taskRepos(db, t));
  // Step 1: write permission (Gate G15). The REPO_WRITE filter is the only write check.
  if (p) {
    const keep: TaskRepoRow[] = [];
    for (const r of rows) {
      const name = `${r.project}/${r.repo}`;
      let ok: boolean;
      try {
        ok = await canWrite(p, { project: r.project as string, slug: r.repo as string }, now());
      } catch (e) {
        log(`Pre-flight of task ${t.id}: cannot read ${name}: ${reason(e)}`);
        return blocked(`Needs you: the app cannot check ${name} on Bitbucket. ${reason(e)}`);
      }
      if (ok) keep.push(r);
      else if (r.role === "submodule" && r.depth === 1) setAccess(db, r.id, "read", REPO_REASON.noWrite);
      else return blocked(noWriteText(name));
    }
    rows = keep;
  }
  for (const r of rows) {
    const name = `${r.project}/${r.repo}`;
    const base = r.role === "main" ? t.target_branch : (r.base_branch ?? "");
    let remote: BranchRemote | null = null;
    let found: Map<string, string>;
    // Steps 2 and 4: the base branch and the task branch on the server.
    try {
      remote = await deps.remote(r.project as string, r.repo as string);
      found = await heads(deps.dataDir, remote, [base, branch]);
    } catch (e) {
      return blocked(`Needs you: Cannot read the branches of ${name}. ${reason(e, remote?.config)}`);
    }
    if (!base || !found.has(base)) return { ...blocked(baseGoneText(base, name)), base: { taskRepo: r.id, branch: base } };
    // Step 3: the branch rules, only when the token can read them (HTTP 401 for a plain token, Gate G15).
    if (p) {
      try {
        const rules = await p.restrictions(r.project as string, r.repo as string);
        if (rules.some((x) => BLOCKING.has(x.type) && x.matcherType === "BRANCH" && x.matcherId === `refs/heads/${branch}`))
          return blocked(ruleText(name, branch));
      } catch (e) {
        if (!(e instanceof ForgeError && (e.kind === "auth" || e.kind === "forbidden")))
          return blocked(`Needs you: the app cannot read the branch rules of ${name}. ${reason(e)}`);
      }
    }
    // Step 4 (section 6.16.4): a branch that exists needs the lease of Continue; a lease needs the remote at that commit.
    const head = found.get(branch);
    const lease = leases?.get(r.id) ?? null;
    if (head && lease === null && leases?.has(r.id)) return blocked(existsText(branch));
    if (head && lease !== null && head !== lease) return blocked(staleText(branch));
  }
  return null;
}
