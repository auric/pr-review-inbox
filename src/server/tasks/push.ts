// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The push of a task branch from the bare cache (spec.md section 6.8, design.md section 10 Q3). The app pushes nothing else.
import { log } from "../log";
import { GitError, git, gitEnv } from "../review/git";

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// spec.md section 6.11: the Jira key of a task.
const KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
// spec.md section 6.8: <prefix><KEY>-spec, <prefix><KEY>-<n>-<slug>, <prefix><KEY>-<slug>, with -2 or -3 for a taken name.
const SUFFIX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// No ":" (refspec), no space, no leading "-" (option), no ".." (git check-ref-format).
const SAFE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const PUSH_MS = 120_000;

export const staleText = (branch: string) => `Someone else pushed to ${branch}. Get their commits first.`;

export type PushInput = {
  // The bare cache. It holds commit and lease.
  cache: string;
  // An empty file in place of the global git config (gitSetup in workspace.ts).
  emptyGlobal: string;
  // RepoRemote.url: the http clone link of the configured origin.
  url: string;
  // RepoRemote.config. git gets it only in the env (GIT_CONFIG_*), never in argv.
  config: [string, string][];
  commit: string;
  branch: string;
  // null: a new branch, which the remote must not have. Else the commit that the app pushed last.
  lease: string | null;
  // A rebase push: it may replace commits that the lease names. The caller gets the user's confirm first.
  force?: boolean;
  // branches: the task_part branches of this task that the app may push, no tracked PR. target: the target branch of the repository. key:
  // the Jira key of the part. found: the found branch that the user picked with "Continue on <branch>" for the part (spec.md section
  // 6.20.2). Its name has the key, but its suffix can break the name rule of the app.
  task: { key: string; prefix: string; branches: string[]; target: string; found?: string[] };
  signal?: AbortSignal;
  // The tests pass a spy.
  git?: typeof git;
};

// needs_force: the commit does not contain the lease, so the push rewrites published commits. It needs force and the confirm.
// stale: the remote branch is not at the lease. The push changed nothing.
export type PushResult =
  | { status: "pushed" }
  | { status: "refused"; reason: string }
  | { status: "needs_force" }
  | { status: "stale"; sentence: string }
  | { status: "failed"; message: string };

// The reason to refuse a push before git runs, or null.
export function pushRefusal(input: Pick<PushInput, "branch" | "commit" | "lease" | "task">): string | null {
  const { branch, task } = input;
  // Refs collide by case on a case-insensitive file system.
  if (branch.toLowerCase() === task.target.toLowerCase()) return `The app never pushes to the target branch ${task.target}.`;
  if (!task.branches.includes(branch)) return `${branch} is not a branch of task ${task.key}.`;
  const head = `${task.prefix}${task.key}-`;
  const suffix = branch.slice(head.length);
  if (
    !KEY.test(task.key) ||
    !SAFE.test(branch) ||
    branch.includes("..") ||
    !branch.startsWith(head) ||
    !(SUFFIX.test(suffix) || (suffix.length > 0 && task.found?.includes(branch)))
  )
    return `${branch} is not a task branch name.`;
  if (!HASH.test(input.commit) || (input.lease !== null && !HASH.test(input.lease))) return "The commit hash is invalid.";
  return null;
}

export async function pushTaskBranch(input: PushInput): Promise<PushResult> {
  const reason = pushRefusal(input);
  if (reason) {
    log(`Refused the push of ${input.branch}: ${reason}`);
    return { status: "refused", reason };
  }
  const run = input.git ?? git;
  const { branch, commit, lease } = input;
  const long = { timeoutMs: PUSH_MS, ...(input.signal && { signal: input.signal }) };
  const clean = (m: string) => input.config.reduce((s, [, v]) => (v ? s.replaceAll(v, "[redacted]") : s), m);
  try {
    // An explicit lease forces any update that matches it (git push docs), so the fast-forward check runs here.
    if (lease !== null && !input.force) {
      const behind = await run([`--git-dir=${input.cache}`, "rev-list", "--count", `${commit}..${lease}`], {
        env: gitEnv(input.emptyGlobal),
        ...long,
      });
      if (behind.trim() !== "0") return { status: "needs_force" };
    }
    // Never a "+" refspec: it defeats the lease (tests/tasks/push.test.ts, stale case). The lease alone allows a rewrite that matches it.
    const refspec = `${commit}:refs/heads/${branch}`;
    await run(
      [
        `--git-dir=${input.cache}`,
        "push",
        "--no-verify",
        `--force-with-lease=refs/heads/${branch}:${lease ?? ""}`,
        "--end-of-options",
        input.url,
        refspec,
      ],
      // LC_ALL=C: untranslated git messages, because the stale check reads them.
      { env: { ...gitEnv(input.emptyGlobal, input.config), LC_ALL: "C" }, ...long },
    );
    log(`Pushed ${commit.slice(0, 12)} to ${branch}.`);
    return { status: "pushed" };
  } catch (e) {
    const message = clean((e as Error).message);
    // Gate G6: a stale lease exits 1 with the markers "[rejected]" and "(stale info)".
    if (e instanceof GitError && !e.stopped && /\[rejected\][^\n]*\(stale info\)/.test(message)) {
      log(`The push of ${branch} was refused: the remote branch moved.`);
      return { status: "stale", sentence: staleText(branch) };
    }
    log(`The push of ${branch} failed: ${message}`);
    return { status: "failed", message };
  }
}
