// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate JC-A data (docs/plans/review-v2/jira-context.md section 5, WP-JC-E): read the first task keys of each local case again with the
// Jira settings of the app, read only, and write tasks-overlay.json beside the set. eval:ab --candidate-tasks-overlay seeds these rows.
// Usage: bun run eval:refetch-tasks [-- --out <tasks-overlay.json>]. Default --out: tasks-overlay.json in the local set folder.
// It prints counts only: the task text and the case IDs can hold names from the user's own repositories.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, readConfig } from "../../src/server/config";
import { createJiraSource } from "../../src/server/context/jira";
import { ContextError, type ContextSource } from "../../src/server/context/source";
import { MAX_KEYS, readIssue } from "../../src/server/context/task-fetch";
import { git } from "../../src/server/review/git";
import { createSecrets } from "../../src/server/secrets";
import type { IssueContext } from "../../src/shared/dto";
import { bundleRepo, type EvalCase, loadCases, localDir, OVERLAY_FILE, rereviewDir, setDir, type TasksOverlay } from "./cases";

const USAGE = "Usage: bun run eval:refetch-tasks [-- --out <tasks-overlay.json>]";

export type RefetchCounts = {
  cases: number;
  taskCases: number;
  read: number;
  failed: Record<string, number>;
  droppedComments: number;
  // Cases whose overlay JSON is longer than their stored JSON, over all keys (Gate JC-A rule 5).
  added: number;
};

// A comment counts only when Jira gave a date at or before the head commit. A missing or bad date drops it, so no later text leaks in.
export function cutComments(i: IssueContext, headMs: number): { issue: IssueContext; dropped: number } {
  const kept = i.comments.filter((c) => {
    const at = Date.parse(c.created);
    return Number.isFinite(at) && at <= headMs;
  });
  const dropped = i.comments.length - kept.length;
  return { issue: { ...i, comments: kept, commentsTotal: Math.max(kept.length, i.commentsTotal - dropped) }, dropped };
}

const size = (json: string | null) => (json === null ? 0 : Buffer.byteLength(json));

// The overlay of the cases: each key is read once, and each case cuts the comments at its own head commit time. tmp: a folder for the
// bare repositories of the bundles.
export async function refetch(
  cases: EvalCase[],
  source: ContextSource,
  tmp: string,
): Promise<{ overlay: TasksOverlay; counts: RefetchCounts }> {
  const counts: RefetchCounts = { cases: cases.length, taskCases: 0, read: 0, failed: {}, droppedComments: 0, added: 0 };
  const reads = new Map<string, Promise<IssueContext | null>>();
  const read = (key: string) => {
    let r = reads.get(key);
    if (!r) {
      r = readIssue(source, key).then(
        (i) => {
          counts.read++;
          return i;
        },
        (e: unknown) => {
          const kind = e instanceof ContextError ? e.kind : "server";
          counts.failed[kind] = (counts.failed[kind] ?? 0) + 1;
          return null;
        },
      );
      reads.set(key, r);
    }
    return r;
  };
  const bundles = new Map<string, string>();
  const overlay: TasksOverlay = { format: 1, cases: [] };
  const seen = new Set<string>();
  for (const c of cases) {
    const keys = (c.tasks ?? []).slice(0, MAX_KEYS);
    if (!c.local || !keys.length) continue;
    counts.taskCases++;
    if (seen.has(`${c.id} ${c.local.head}`)) continue;
    seen.add(`${c.id} ${c.local.head}`);
    const repo = await bundleRepo(c.local, tmp, bundles);
    const headMs = Number((await git(["--git-dir", repo.url, "log", "-1", "--format=%ct", c.local.head], { env: repo.env })).trim()) * 1000;
    const tasks: Record<string, string> = {};
    for (const t of keys) {
      const i = await read(t.key);
      if (!i) continue;
      const cut = cutComments(i, headMs);
      counts.droppedComments += cut.dropped;
      tasks[t.key] = JSON.stringify(cut.issue);
    }
    if (keys.reduce((n, t) => n + size(tasks[t.key] ?? t.json), 0) > keys.reduce((n, t) => n + size(t.json), 0)) counts.added++;
    overlay.cases.push({ id: c.id, head: c.local.head, tasks });
  }
  return { overlay, counts };
}

export const countsText = (n: RefetchCounts) => {
  const failed = Object.entries(n.failed)
    .sort()
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `Cases: ${n.cases}. Cases with task keys: ${n.taskCases}.`,
    `Keys read: ${n.read}. Keys failed: ${failed || "none"}.`,
    `Comments dropped after the head commit: ${n.droppedComments}.`,
    `Cases where the overlay adds text: ${n.added} of ${n.taskCases}.`,
  ].join("\n");
};

// source: the Jira source. Tests pass the fake Jira. Without it, the Jira settings and token of the app data folder apply.
export async function main(argv: string[], source?: ContextSource): Promise<number> {
  let out: string;
  try {
    const v = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { out: { type: "string" } } }).values;
    out = resolve(v.out ?? join(localDir(), OVERLAY_FILE));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!existsSync(join(localDir(), "MANIFEST.json"))) {
    console.error("No local set. Build it with bun run eval:local, and point REVIEW_LOOP_EVAL_LOCAL at its folder (docs/eval/local.md).");
    return 2;
  }
  const cases = [setDir("local"), rereviewDir()].filter((d) => existsSync(d)).flatMap((d) => loadCases("all", d));
  let jira = source;
  if (!jira) {
    const j = readConfig(dataDir())?.jira;
    const token = j && (await createSecrets(undefined, "jira-token").get());
    if (!j || !token) {
      console.error("The app has no Jira settings or no Jira token. Set up Jira in the app first.");
      return 2;
    }
    jira = createJiraSource({ baseUrl: j.baseUrl, token, caFile: j.caFile, email: j.email });
  }
  const tmp = mkdtempSync(join(tmpdir(), "rl-eval-refetch-"));
  const print = console.log;
  // The log lines of the Jira client name task keys and endpoint paths.
  console.log = () => {};
  let done: Awaited<ReturnType<typeof refetch>>;
  try {
    done = await refetch(cases, jira, tmp);
    writeFileSync(out, `${JSON.stringify(done.overlay, null, 2)}\n`);
  } catch (e) {
    console.error(`The refetch failed: ${(e as Error).name}`);
    return 1;
  } finally {
    console.log = print;
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log(`${countsText(done.counts)}\nOverlay: ${out}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
