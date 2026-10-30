// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Jira sub-tasks of a task (docs/plans/review-v2/spec.md section 6.20): the task_subtask rows, the found work of the spec run, the
// review times of context/pr-history.md, and the app checks of the plan and of its approval. The callers write task and task_part.
import type { Database } from "bun:sqlite";
import { branchName as branchRule, type IssueContext, type IssueSubtask, type SubtaskDto } from "../../shared/dto";
import { isMe } from "../../shared/me";
import {
  branchName,
  FOUND_CHANGES_MAX,
  FOUND_COMMITS_MAX,
  type FoundItem,
  MAX_OPEN_CAP,
  MAX_OPEN_DEFAULT,
  namesKey,
  type SpecResult,
  type StartMode,
} from "../../shared/task";
import type { ForgeProvider } from "../bitbucket/provider";
import { foundOf } from "../context/task-file";
import { git, gitEnv } from "../review/git";
import { type BranchRemote, type ContextFile, cachePath, gitSetup, locked, longPath, noUrl } from "../review/workspace";
import { firstFree } from "./worktree";

export type SubtaskRow = {
  key: string;
  ord: number;
  summary: string;
  status: string | null;
  category: IssueSubtask["category"];
  issue_json: string | null;
  links_json: string;
  found_json: string;
  read_at: number;
  status_at: number | null;
  added_at: number | null;
  removed_at: number | null;
};

const SQL = {
  rows: "SELECT * FROM task_subtask WHERE task = $task ORDER BY ord",
  insert: `INSERT INTO task_subtask (task, key, ord, summary, status, category, issue_json, links_json, read_at, status_at)
    VALUES ($task, $key, $ord, $summary, $status, $category, $issue, $links, $at, $at)`,
  found: "UPDATE task_subtask SET found_json = $found WHERE task = $task AND key = $key",
  stored: `SELECT pr_id, title, source_branch, target_branch, state, source_head FROM pull_request
    WHERE project = $project AND repo = $repo AND state IN ('OPEN', 'MERGED') ORDER BY pr_id`,
  openCount: "SELECT COUNT(*) AS n FROM pull_request WHERE project = $project AND repo = $repo AND my_role = 'AUTHOR' AND state = 'OPEN'",
};

const FETCH_MS = 60_000;
const HEAD = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export const subtaskRows = (db: Database, task: number) => db.query(SQL.rows).all({ task }) as SubtaskRow[];

// The create click (spec.md section 6.20.1): one row per sub-task in Jira order. issue: the read of an open sub-task, null for a done one.
export function saveSubtasks(db: Database, task: number, list: { sub: IssueSubtask; issue: IssueContext | null }[], at: number) {
  const q = db.query(SQL.insert);
  for (const [ord, { sub, issue }] of list.entries())
    q.run({
      task,
      key: sub.key,
      ord: ord + 1,
      summary: issue?.summary ?? sub.summary,
      status: issue?.status ?? sub.status,
      category: sub.category,
      issue: issue ? JSON.stringify(issue) : null,
      links: JSON.stringify(issue?.links ?? []),
      at,
    });
}

const isOpen = (r: SubtaskRow) => r.category !== "done" && r.issue_json !== null;
type FoundPr = Extract<FoundItem, { kind: "pr" }>;

// The PR that the app follows for an open sub-task (spec.md section 6.20.2): its one open PR, the pick among several, else its newest
// merged PR. "pick" without pick: the user must pick one of several open PRs.
export function trackedPr(r: SubtaskRow, pick?: number): FoundPr | "pick" | null {
  if (!isOpen(r)) return null;
  const prs = foundOf(r.found_json).filter((f): f is FoundPr => f.kind === "pr");
  const open = prs.filter((p) => p.state === "OPEN");
  if (open.length > 1) return open.find((p) => p.pr === pick) ?? "pick";
  if (open[0]) return open[0];
  return prs.filter((p) => p.state === "MERGED").sort((a, b) => b.pr - a.pr)[0] ?? null;
}

// The keys that a part can build: open sub-tasks without a tracked PR.
const buildable = (rows: SubtaskRow[]) => new Set(rows.filter((r) => isOpen(r) && trackedPr(r) === null).map((r) => r.key));

export type FoundDeps = {
  provider: Pick<ForgeProvider, "listBranches" | "listOpenPullRequests" | "listChanges"> | null;
  dataDir: string;
  remote: () => Promise<BranchRemote>;
};

// The found work at the spec run start (spec.md section 6.20.2), in the main repository only. head: the fetched base head. It writes
// found_json of each open sub-task and returns the lines of failed reads. A failed read leaves the rest of the search. keys: only these
// sub-tasks, for the plan run of "Add to plan" (section 6.20.14).
export async function findWork(
  db: Database,
  deps: FoundDeps,
  t: { id: number; project: string; repo: string },
  head: string,
  keys?: ReadonlySet<string>,
): Promise<string[]> {
  const rows = subtaskRows(db, t.id).filter((r) => isOpen(r) && (!keys || keys.has(r.key)));
  if (!rows.length) return [];
  const notes: string[] = [];
  const why = (e: unknown) => noUrl((e as Error).message);
  const p = deps.provider;
  if (!p) return ["Configure the Bitbucket URL and token first. The app did not search the branches and PRs."];
  const ref = { project: t.project, repo: t.repo };
  let live: Awaited<ReturnType<typeof p.listOpenPullRequests>> | null = null;
  try {
    live = await p.listOpenPullRequests(t.project, t.repo);
    if (!live.complete) notes.push("The app read one page of the open PRs. It can miss an open PR of a sub-task.");
  } catch (e) {
    notes.push(`The app could not read the open PRs: ${why(e)}`);
  }
  const stored = db.query(SQL.stored).all(ref) as {
    pr_id: number;
    title: string | null;
    source_branch: string | null;
    target_branch: string | null;
    state: string;
    source_head: string | null;
  }[];
  const dataDir = longPath(deps.dataDir);
  const cache = cachePath(dataDir, { ...ref, id: t.id });
  const { empty, env } = gitSetup(dataDir);
  const c = (args: string[]) => git([`--git-dir=${cache}`, ...args], { env });
  let n = 0;
  for (const r of rows) {
    const key = r.key;
    let names: string[] = [];
    try {
      names = (await p.listBranches(t.project, t.repo, key)).branches
        .map((b) => b.name)
        .filter((b) => namesKey(b, key) && branchRule.safeParse(b).success);
    } catch (e) {
      notes.push(`The app could not search the branches of ${key}: ${why(e)}`);
    }
    const prs: FoundPr[] = [];
    const add = (x: FoundPr) => {
      if (!prs.some((y) => y.pr === x.pr)) prs.push(x);
    };
    for (const x of live?.items ?? [])
      if (namesKey(x.title, key) || namesKey(x.sourceBranch, key) || names.includes(x.sourceBranch))
        add({
          kind: "pr",
          pr: x.ref.id,
          title: x.title,
          branch: x.sourceBranch,
          target: x.targetBranch,
          state: "OPEN",
          head: x.sourceHead,
          changes: [],
          more: false,
        });
    // The live list is the truth for open PRs. A stored open row counts only when that read failed.
    for (const s of stored)
      if ((s.state === "MERGED" || !live) && (namesKey(s.title ?? "", key) || namesKey(s.source_branch ?? "", key)))
        add({
          kind: "pr",
          pr: s.pr_id,
          title: s.title ?? "",
          branch: s.source_branch ?? "",
          target: s.target_branch ?? "",
          state: s.state === "MERGED" ? "MERGED" : "OPEN",
          head: s.source_head,
          changes: [],
          more: false,
        });
    for (const x of prs.filter((y) => y.state === "OPEN"))
      try {
        const ch = await p.listChanges({ ...ref, id: x.pr });
        x.changes = ch.items.slice(0, FOUND_CHANGES_MAX).map((y) => y.path);
        x.more = ch.items.length > FOUND_CHANGES_MAX || !ch.complete;
      } catch (e) {
        notes.push(`The app could not read the changed paths of PR #${x.pr}: ${why(e)}`);
      }
    const branches: FoundItem[] = [];
    for (const name of names.filter((b) => !prs.some((x) => x.branch === b))) {
      n++;
      const target = `refs/rl/task/${t.id}/found/${n}`;
      const item: Extract<FoundItem, { kind: "branch" }> = {
        kind: "branch",
        name,
        ref: null,
        head: null,
        subjects: [],
        stat: "",
        error: null,
      };
      try {
        const remote = await deps.remote();
        const tip = await locked(cache, async () => {
          await git(
            [
              `--git-dir=${cache}`,
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              "--end-of-options",
              remote.url,
              `+refs/heads/${name}:${target}`,
            ],
            {
              env: gitEnv(empty, remote.config),
              timeoutMs: FETCH_MS,
            },
          );
          return (await c(["rev-parse", "--verify", "--quiet", `${target}^{commit}`])).trim();
        });
        if (!HEAD.test(tip)) throw new Error("The fetch gave no commit.");
        item.ref = target;
        item.head = tip;
        item.subjects = (await c(["log", "--format=%s", `--max-count=${FOUND_COMMITS_MAX}`, `${head}..${target}`]))
          .split("\n")
          .filter(Boolean);
        item.stat = await c(["diff", "--stat=200", `--stat-count=${FOUND_CHANGES_MAX}`, `${head}...${target}`]).catch(
          () => "No commit is shared with the base.",
        );
      } catch (e) {
        item.error = `The app could not read it: ${why(e)}`;
      }
      branches.push(item);
    }
    db.query(SQL.found).run({ task: t.id, key, found: JSON.stringify([...prs, ...branches]) });
  }
  return notes;
}

// context/pr-history.md (spec.md section 6.20.4): the open PRs of the user in the repository (stored rows) and the median time from open
// to merge of the user's own PRs in one page of the newest merged PRs.
export async function prHistoryFile(
  db: Database,
  provider: Pick<ForgeProvider, "mergedPullRequests"> | null,
  me: string | null,
  project: string,
  repo: string,
): Promise<ContextFile> {
  const open = (db.query(SQL.openCount).get({ project, repo }) as { n: number }).n;
  const out = [`# Your PRs in ${project}/${repo}`, "", `- Open PRs that you wrote: ${open}.`];
  let times: number[] = [];
  try {
    const merged = provider ? await provider.mergedPullRequests(project, repo) : [];
    times = merged.filter((m) => isMe(m.author, me) && m.closedDate !== null).map((m) => (m.closedDate as number) - m.createdDate);
  } catch (e) {
    out.push(`- The app could not read the merged PRs: ${noUrl((e as Error).message)}`);
  }
  if (!times.length) out.push("- No review time data.");
  else {
    const s = times.sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const median = s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
    const hours = median / 3_600_000;
    const text = hours < 48 ? `${hours.toFixed(1)} hours` : `${(hours / 24).toFixed(1)} days`;
    out.push(`- Median time from open to merge of your ${s.length} newest merged PRs: ${text}.`);
  }
  return { name: "pr-history.md", text: out.join("\n") };
}

// The start of one plan part (spec.md section 6.20.4). after: a part number such as "2", or the key of a tracked sub-task. skip: the part
// builds no open sub-task without a tracked PR, so the approval makes no part of it.
export type SubtaskStart = { n: number; keys: string[]; start: StartMode; after: string | null; reason: string; skip: boolean };
// docs_json.subtasks: the checked sub-task plan of the spec run. notes: the lines of the app checks for the plan screen.
export type SubtaskPlan = { starts: SubtaskStart[]; maxOpen: { value: number; reason: string }; notes: string[] };

// The name of a part in a sentence: its first key, and "ABC-12 (2 of 3)" for part k of a split sub-task (spec.md section 6.20.13).
function labelOf(s: SubtaskStart, live: SubtaskStart[]) {
  const key = s.keys[0];
  if (key === undefined) return `Part ${s.n}`;
  const twins = live.filter((x) => x.keys[0] === key);
  return twins.length > 1 ? `${key} (${twins.indexOf(s) + 1} of ${twins.length})` : key;
}

// The first cycle of the after links between parts, as [a, b]: a builds on b, and b builds on a through zero or more parts.
function cycleOf(starts: SubtaskStart[]): [SubtaskStart, SubtaskStart] | null {
  const lower = (s: SubtaskStart) =>
    s.start !== "base" && s.after !== null && /^\d+$/.test(s.after) ? starts.find((x) => x.n === Number(s.after)) : undefined;
  for (const s of starts) {
    const seen = new Set<number>([s.n]);
    for (let x = lower(s); x; x = lower(x)) {
      if (x.n === s.n) return [s, lower(s) as SubtaskStart];
      if (seen.has(x.n)) break;
      seen.add(x.n);
    }
  }
  return null;
}

// The check of the after of one start. live: the parts that the approval makes. "done": it names a done sub-task, so the part starts
// from the base. null: it names no such part and no tracked sub-task.
function afterCheck(s: SubtaskStart, live: SubtaskStart[], rows: SubtaskRow[], tracked: Set<string>): "ok" | "done" | null {
  if (s.start === "base") return "ok";
  if (s.after === null) return null;
  if (/^\d+$/.test(s.after)) return Number(s.after) !== s.n && live.some((x) => x.n === Number(s.after)) ? "ok" : null;
  if (tracked.has(s.after)) return "ok";
  return rows.some((r) => r.key === s.after && r.category === "done") ? "done" : null;
}

const cycleText = ([a, b]: [SubtaskStart, SubtaskStart], live: SubtaskStart[]) =>
  `${labelOf(a, live)} cannot build on ${labelOf(b, live)}, because ${labelOf(b, live)} builds on ${labelOf(a, live)}.`;

// The app checks of a spec result in sub-task mode (spec.md section 6.20.4). They use no guess. Each failed check gives a note, which
// is also a coverage line. base: the base branch of the task. outside: the keys of the parts of an approved plan, which a part of
// "Add to plan" can build on (section 6.20.14).
export function checkSubtaskPlan(r: SpecResult, rows: SubtaskRow[], base: string, outside: Iterable<string> = []): SubtaskPlan {
  const notes: string[] = [];
  const can = buildable(rows);
  const tracked = new Set([...rows.filter((x) => trackedPr(x) !== null).map((x) => x.key), ...outside]);
  const starts: SubtaskStart[] = r.parts.map((p, i) => {
    const n = i + 1;
    const keys = [...new Set(p.keys)].filter((k) => {
      if (can.has(k)) return true;
      notes.push(`Part ${n} names ${k}, which is no open sub-task without a PR. The part leaves it out.`);
      return false;
    });
    if (!keys.length) notes.push(`Part ${n} builds no open sub-task without a PR. The app leaves it out.`);
    return { n, keys, start: p.start, after: p.start === "base" ? null : p.after, reason: p.startReason, skip: !keys.length };
  });
  const live = starts.filter((s) => !s.skip);
  for (const s of live) {
    const ok = afterCheck(s, live, rows, tracked);
    if (ok === "ok") continue;
    notes.push(
      ok === "done"
        ? `${labelOf(s, live)} needs ${s.after}, which is done. It starts from ${base}.`
        : `${labelOf(s, live)} builds on ${s.after ?? "nothing"}, which is no part of the plan. It starts from ${base}.`,
    );
    s.start = "base";
    s.after = null;
  }
  const cycle = cycleOf(live);
  if (cycle) notes.push(cycleText(cycle, live));
  const planned = new Set(live.flatMap((s) => s.keys));
  for (const k of can) if (!planned.has(k)) notes.push(`Claude planned no PR for ${k}.`);
  return { starts, maxOpen: { value: r.maxOpen ?? MAX_OPEN_DEFAULT, reason: r.maxOpenReason }, notes };
}

// One part row of an approved sub-task plan. n: the plan part, null for a tracked PR. after: the n of the lower part, or the key of a
// tracked sub-task. pr: the tracked PR.
export type PlannedPart = {
  n: number | null;
  keys: string[];
  title: string;
  branch: string;
  base: string;
  start: StartMode;
  after: string | null;
  specDir: string | null;
  pr: FoundPr | null;
};

export type ApprovalInput = {
  parts: { n: number; start: StartMode; after: string | null; existing?: "continue" | "new" }[];
  track: { key: string; pr: number }[];
  maxOpen: number;
};

// The checks of a sub-task plan approval (spec.md sections 6.20.4 and 6.20.5) and its part rows. A string is the sentence of the 409, a
// {bad} the sentence of the 400. A plan part that builds no open sub-task without a tracked PR gets no row. The approval pushes nothing
// and posts nothing. outside: key to branch of each part of an approved plan, which a part of "Add to plan" can build on (section 6.20.14).
export function approveSubtasks(o: {
  t: { key: string; title: string; target_branch: string };
  plan: { n: number; title: string }[];
  sub: SubtaskPlan | null;
  rows: SubtaskRow[];
  input: ApprovalInput | undefined;
  prefix: string;
  specDir: string;
  outside?: ReadonlyMap<string, string>;
}): { parts: PlannedPart[]; maxOpen: number } | string | { bad: string } {
  const { t, rows, input } = o;
  const given = new Map((input?.parts ?? []).map((p) => [p.n, p]));
  if (given.size !== (input?.parts.length ?? 0)) return { bad: "Each part takes one start." };
  const picks = new Map((input?.track ?? []).map((x) => [x.key, x.pr]));
  if (picks.size !== (input?.track.length ?? 0)) return { bad: "Each sub-task takes one PR." };
  for (const [key, pr] of picks) {
    const r = rows.find((x) => x.key === key);
    const got = r ? trackedPr(r, pr) : null;
    if (!r || !got || got === "pick" || got.pr !== pr) return { bad: `PR #${pr} is no open PR of ${key}.` };
  }
  const tracked = new Map<string, FoundPr>();
  for (const r of rows) {
    const got = trackedPr(r, picks.get(r.key));
    if (got === "pick") return `Pick the PR that the app tracks for ${r.key}.`;
    if (got) tracked.set(r.key, got);
  }
  const can = buildable(rows);
  const live = o.plan.flatMap((p): SubtaskStart[] => {
    const s = o.sub?.starts.find((x) => x.n === p.n);
    const keys = (s?.keys ?? []).filter((k) => can.has(k));
    if (!keys.length) return [];
    const g = given.get(p.n);
    const start = g?.start ?? s?.start ?? "base";
    return [
      { n: p.n, keys, start, after: start === "base" ? null : ((g ? g.after : s?.after) ?? null), reason: s?.reason ?? "", skip: false },
    ];
  });
  for (const n of given.keys()) if (!live.some((s) => s.n === n)) return { bad: `Part ${n} is not in the plan.` };
  const trackedKeys = new Set([...tracked.keys(), ...(o.outside?.keys() ?? [])]);
  for (const s of live) {
    const ok = afterCheck(s, live, rows, trackedKeys);
    if (ok === null) return `${labelOf(s, live)} builds on ${s.after ?? "nothing"}, which is no part of the plan.`;
    if (ok === "done") {
      s.start = "base";
      s.after = null;
    }
  }
  const cycle = cycleOf(live);
  if (cycle) return cycleText(cycle, live);
  const parts: PlannedPart[] = [];
  for (const s of live) {
    const key = s.keys[0] as string;
    const twins = live.filter((x) => x.keys[0] === key);
    const k = twins.indexOf(s) + 1;
    const row = rows.find((r) => r.key === key) as SubtaskRow;
    const title = row.summary;
    const planned = branchName(o.prefix, key, twins.length > 1 ? { kind: "part", n: k, title } : { kind: "small", title });
    // spec.md section 6.20.2: "Continue on <branch>" takes a found branch with no PR whose name passes the push name rule.
    const found = foundOf(row.found_json).flatMap((f) => (f.kind === "branch" && f.error === null ? [f.name] : []));
    const pushable = found.find((name) => name.startsWith(`${o.prefix}${key}-`));
    const existing = given.get(s.n)?.existing;
    if (existing === "continue" && found.length && !pushable) return `The app pushes only to names like ${o.prefix}${key}-….`;
    const dir = o.specDir.replaceAll("{key}", key);
    parts.push({
      n: s.n,
      keys: s.keys,
      title: o.plan.find((p) => p.n === s.n)?.title ?? title,
      // "Start a new branch" never takes a found name, or the part start would continue on it.
      branch: existing === "new" ? firstFree(planned, new Set(found)) : (pushable ?? planned),
      base: t.target_branch,
      start: s.start,
      after: s.after,
      specDir: k > 1 ? `${dir.replace(/\/?$/, "/")}part-${k}/` : dir,
      pr: null,
    });
  }
  for (const r of rows) {
    const pr = tracked.get(r.key);
    if (pr)
      parts.push({
        n: null,
        keys: [r.key],
        title: r.summary,
        branch: pr.branch,
        base: pr.target,
        start: "base",
        after: null,
        specDir: null,
        pr,
      });
  }
  // The planned base of a part on top of another part: the lower branch. The part start sets the newest head (WP-ST3).
  for (const p of parts) {
    const after = p.after;
    if (p.start !== "stack" || after === null) continue;
    const lower = /^\d+$/.test(after) ? parts.find((x) => x.n === Number(after)) : parts.find((x) => x.pr && x.keys[0] === after);
    const branch = lower?.branch ?? o.outside?.get(after);
    if (branch) p.base = branch;
  }
  return { parts, maxOpen: Math.min(input?.maxOpen ?? o.sub?.maxOpen.value ?? MAX_OPEN_DEFAULT, MAX_OPEN_CAP) };
}

// The sub-tasks of a task for TaskDto (spec.md section 6.20.8). parts: the task_part rows with their keys.
export function subtaskDtos(db: Database, task: number, parts: { id: number; keys_json: string | null }[]): SubtaskDto[] {
  return subtaskRows(db, task).map((r) => {
    const issue = r.issue_json === null ? null : (JSON.parse(r.issue_json) as IssueContext);
    return {
      key: r.key,
      summary: r.summary,
      status: r.status,
      category: r.category,
      statusAt: r.status_at,
      links: JSON.parse(r.links_json),
      found: foundOf(r.found_json),
      parts: parts.filter((p) => (JSON.parse(p.keys_json ?? "[]") as string[]).includes(r.key)).map((p) => p.id),
      attachments: issue?.attachments ?? [],
      added: r.added_at,
      removed: r.removed_at,
    };
  });
}
