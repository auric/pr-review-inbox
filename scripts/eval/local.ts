// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Builds the local eval set from your own decisions (docs/plans/review-v3.md WP-V1). docs/eval/local.md gives the steps.
// Usage: bun run eval:local -- [--db <db-*.sqlite>] [--cache <git folder>] [--out <folder>] [--user <slug>]
// Default --db and --cache: the database and the git folder of the data folder of the app. Close the app first.
// The builder only reads --db and --cache: it reads a temp copy of the database, and its git commands only read the cache.
// It refuses an --out folder in the live data folder. stdout gets counts only: no path, host, or name.
// Exit codes: 0 done, 1 a build error, 2 a usage error or a refused path.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, dbPath } from "../../src/server/config";
import { type DiffFile, parseDiff } from "../../src/server/review/diffmap";
import { git, gitEnv } from "../../src/server/review/git";
import { type StatsPayload, userDiscard } from "../../src/server/review/stats";
import { diffArgs } from "../../src/server/review/workspace";
import { isMe } from "../../src/shared/me";
import { finding } from "../../src/shared/review";
import { type ExcerptLine, threadSpot } from "../../src/shared/types";
import {
  changedLines,
  EVAL_AUTHOR,
  EVAL_USER,
  type EvalBug,
  type EvalEarlier,
  type EvalExtra,
  type EvalHuman,
  type EvalThreadComment,
  type EvalTrap,
  LOCAL_RULES,
  type LocalCaseFile,
  localCaseFile,
  localDir,
  MODULE_IDS,
  mapSpot,
  setFingerprint,
} from "./cases";
import { overlaps } from "./score";

const REPO = resolve(import.meta.dir, "../..");
export const USAGE = "Usage: bun run eval:local -- [--db <db-*.sqlite>] [--cache <git folder>] [--out <folder>] [--user <slug>]";
// cachePath of src/server/review/workspace.ts: a project key or a repository slug that is a safe folder name.
const NAME = /^[A-Za-z0-9~_][A-Za-z0-9._~-]*$/;
// docs/plans/review-v3.md WP-V1: Not a bug and Intended must not come back. The other codes and no code are neutral.
const TRAP_CODES = new Set(["bug", "intended"]);
// docs/plans/review-v3.md Q3.
const MINIMUM = { cases: 30, bugs: 40, traps: 20 };
// The builder writes only these names into --out. It removes them before a new build.
const OUT_NAMES = new Set(["cases", "rereview", "bundles", "MANIFEST.json"]);

// ---------- Paths ----------

// The real path of p. A missing tail keeps its names under the real path of the nearest folder that exists.
function realOf(p: string): string {
  let dir = resolve(p);
  const rest: string[] = [];
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return resolve(p);
    rest.unshift(basename(dir));
    dir = up;
  }
  return join(realpathSync.native(dir), ...rest);
}

export function isInside(child: string, parent: string): boolean {
  const r = relative(realOf(parent), realOf(child));
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

// The data folders of the app: the config dataDir, and also its default folder when REVIEW_LOOP_DATA_DIR names another one.
export function liveFolders(): string[] {
  const set = process.env.REVIEW_LOOP_DATA_DIR;
  delete process.env.REVIEW_LOOP_DATA_DIR;
  try {
    return [...new Set([dataDir(), ...(set ? [set] : [])])];
  } finally {
    if (set !== undefined) process.env.REVIEW_LOOP_DATA_DIR = set;
  }
}

// Only the ignore files of the repository count: the empty global config hides the user's excludes file.
async function ignored(path: string): Promise<boolean> {
  const rel = relative(realOf(REPO), realOf(path)).replaceAll("\\", "/");
  // A file name under the folder: a pattern with a trailing slash matches only a folder, and the folder can be missing.
  return git(["-C", REPO, "check-ignore", "-q", "--", `${rel}/MANIFEST.json`], { env: gitEnv("/dev/null") }).then(
    () => true,
    () => false,
  );
}

// null: --out is missing or empty, or it holds only the files of an earlier build.
function outRefusal(out: string): string | null {
  if (!existsSync(out)) return null;
  return readdirSync(out).some((f) => !OUT_NAMES.has(f))
    ? "Refused: the --out folder holds other files. Pick an empty folder or the folder of an earlier build."
    : null;
}

// A string field of config.json in dir, or null. readConfig is not used: it can write a backup file.
function configField(dir: string, key: "userSlug" | "baseUrl"): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as Record<string, unknown>)[key];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

// The database of the app in its data folder (config.ts dbPath), or null without a base URL.
function liveDb(dir: string): string | null {
  const url = configField(dir, "baseUrl");
  try {
    return url ? dbPath(dir, url) : null;
  } catch {
    return null;
  }
}

// ---------- Selection ----------

const SQL = {
  // stats.ts: running, failed, and cancelled runs store no findings to triage. The self-review of a task (pr NULL) counts nowhere.
  // since: the earlier head of a re-review. explain: the run is an old Explain run, which run-rows.ts baseRun skips.
  runs: `SELECT id, pr, source_head AS head, merge_base AS base, since_head AS since, COALESCE(explain, profile = 'explain') AS explain
    FROM review_run WHERE pr IS NOT NULL AND kind = 'review' AND status IN ('completed', 'incomplete') ORDER BY id`,
  // The thread of a posted finding: its confirmed inline post holds one finding (run-rows.ts posted).
  threads: `SELECT json_extract(p.items_json, '$[0].id') AS item, c.thread_resolved AS resolved FROM post p
    JOIN comment c ON c.pr = p.pr AND c.comment_id = p.remote_id AND c.parent_id IS NULL AND c.tombstoned_at IS NULL
    WHERE p.kind = 'inline' AND p.state = 'confirmed' AND p.remote_id IS NOT NULL`,
  // A posted finding that you withdrew in its thread: you posted the reply of a discuss run with verdict withdrawn. discuss.ts gives
  // only that reply the judgement settled.
  withdrawn: `SELECT DISTINCT json_extract(p.items_json, '$[0].id') AS item FROM post p
    JOIN review_item r ON r.kind = 'reply' AND r.thread = p.remote_id AND r.status = 'posted'
    JOIN review_run rr ON rr.id = r.run AND rr.pr = p.pr
    WHERE p.kind = 'inline' AND p.state = 'confirmed' AND p.remote_id IS NOT NULL
      AND json_extract(r.payload_json, '$.origin') = 'discuss' AND json_extract(r.payload_json, '$.judgement') = 'settled'`,
  items: `SELECT i.id, i.run, i.status, i.path, i.side, i.line, i.line_end, i.body, i.payload_json,
      EXISTS (SELECT 1 FROM review_item c WHERE c.kind = 'finding' AND json_extract(c.payload_json, '$.carried.from') = i.id) AS copied
    FROM review_item i JOIN review_run r ON r.id = i.run
    WHERE i.kind = 'finding' AND r.pr IS NOT NULL AND r.kind = 'review' AND r.status IN ('completed', 'incomplete') ORDER BY i.id`,
  // The outbox posts findings and reply drafts. Only a root comment that it did not post is a human comment: yours or of another person.
  comments: `SELECT c.pr, c.comment_id, c.author_slug, c.author_login, c.anchor_json, c.excerpt_json, c.thread_resolved AS resolved,
      pr.author_slug AS pr_author FROM comment c JOIN pull_request pr ON pr.id = c.pr
    WHERE c.parent_id IS NULL AND c.tombstoned_at IS NULL AND c.anchor_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM post p WHERE p.pr = c.pr AND p.remote_id = c.comment_id) ORDER BY c.pr, c.comment_id`,
  // Every comment of a PR for its threads at a reviewed head (caseThreads). author_name is read only to remove it from the text.
  threadRows: `SELECT c.pr, c.comment_id AS id, c.root_id AS root, c.author_slug AS slug, c.author_login AS login, c.author_name AS name,
      c.text, c.anchor_json AS anchor, c.excerpt_json AS excerpt, c.thread_resolved AS resolved, c.thread_resolved_at AS resolvedAt,
      c.created_at AS at, c.updated_at AS updated, c.tombstoned_at IS NOT NULL AS deleted, pr.author_slug AS prAuthor,
      pr.author_name AS prAuthorName
    FROM comment c JOIN pull_request pr ON pr.id = c.pr ORDER BY c.pr, c.created_at, c.comment_id`,
  // The people of the whole database, read only to remove their names from the thread text.
  people: `SELECT author_slug AS slug, author_login AS login, author_name AS name FROM comment
    UNION SELECT author_slug, NULL, author_name FROM pull_request`,
  starts: "SELECT id, started_at AS at FROM review_run",
  // The thread root of each posted finding (run-rows.ts posted).
  postedRoots: `SELECT json_extract(items_json, '$[0].id') AS item, remote_id AS root FROM post
    WHERE kind = 'inline' AND state = 'confirmed' AND remote_id IS NOT NULL`,
  prs: "SELECT id, pr_id, project, repo, title, description FROM pull_request",
  tasks: `SELECT t.pr, t.key, t.source, x.json FROM pr_task t LEFT JOIN task_context x ON x.pr = t.pr AND x.key = t.key
    ORDER BY t.pr, t.ord`,
};

type RunRow = { id: number; pr: number; head: string; base: string | null; since: string | null; explain: number };
type ItemRow = {
  id: number;
  run: number;
  status: string;
  path: string | null;
  side: string | null;
  line: number | null;
  line_end: number | null;
  body: string;
  payload_json: string;
  copied: number;
};
type CommentRow = {
  pr: number;
  comment_id: number;
  author_slug: string;
  author_login: string | null;
  anchor_json: string;
  excerpt_json: string | null;
  resolved: number;
  pr_author: string | null;
};
export type ThreadRow = {
  pr: number;
  id: number;
  root: number;
  slug: string;
  login: string | null;
  name: string | null;
  text: string;
  anchor: string | null;
  excerpt: string | null;
  resolved: number;
  resolvedAt: number | null;
  at: number;
  updated: number;
  deleted: number;
  prAuthor: string | null;
  prAuthorName: string | null;
};
export type Person = { slug: string | null; login: string | null; name: string | null };
type PrRow = { id: number; pr_id: number; project: string; repo: string; title: string | null; description: string | null };
type TaskRow = { pr: number; key: string; source: string; json: string | null };
type Spot = { path: string; side: "new" | "old"; lines: [number, number] };

// One case before the repository steps: a reviewed (PR, head, merge base) and the decisions of its runs. first, last: its run IDs.
export type Draft = {
  pr: number;
  head: string;
  base: string;
  runs: number;
  first: number;
  last: number;
  bugs: EvalBug[];
  traps: EvalTrap[];
  extras: EvalExtra[];
  human: EvalHuman[];
};

// A re-review case (docs/plans/review-v3.md WP-V3): one re-review run, the decisions on its own items, and its earlier run.
export type RereviewDraft = Omit<Draft, "runs" | "first" | "last" | "human"> & {
  run: number;
  since: string;
  sinceBase: string;
  earlier: EvalEarlier[];
};

// noEarlier: a re-review run whose earlier run is not in the copy, or does not match its earlier head. badPayload: an earlier finding
// whose stored payload is no finding.
export type RereviewSkipped = { noEarlier: number; badPayload: number; missingCommits: number; emptyCases: number };

export type Skipped = {
  refuted: number;
  notYours: number;
  undecided: number;
  noAnchor: number;
  conflicts: number;
  noMergeBase: number;
  missingCommits: number;
  emptyCases: number;
  commentNoLine: number;
  commentOtherHead: number;
  // Root line comments of other reviewers. open: neither resolved nor orphaned. author: by the PR author.
  otherOpen: number;
  otherNoLine: number;
  otherOtherHead: number;
  otherAuthor: number;
  // Comments of other reviewers on the lines of a must find of the same case.
  otherOverlap: number;
};

// The selected items by source, before the conflict rule and carry. withdrawn: posted, then withdrawn in the thread (a trap).
// other: line comments of other reviewers that a later head changed or that are resolved.
export type Sources = { posted: number; fixed: number; session: number; withdrawn: number; other: number };

export const caseId = (d: Pick<Draft, "pr" | "head" | "base">) => `pr${d.pr}-${d.head.slice(0, 12)}-${d.base.slice(0, 8)}`;
export const rereviewId = (d: Pick<RereviewDraft, "pr" | "run">) => `pr${d.pr}-rr${d.run}`;

// Pure: the database rows to drafts. me: the user slug, as isMe reads it.
export function select(
  db: Database,
  me: string,
): { drafts: Draft[]; skipped: Skipped; sources: Sources; rereviews: RereviewDraft[]; rereviewSkipped: RereviewSkipped } {
  const skipped: Skipped = {
    refuted: 0,
    notYours: 0,
    undecided: 0,
    noAnchor: 0,
    conflicts: 0,
    noMergeBase: 0,
    missingCommits: 0,
    emptyCases: 0,
    commentNoLine: 0,
    commentOtherHead: 0,
    otherOpen: 0,
    otherNoLine: 0,
    otherOtherHead: 0,
    otherAuthor: 0,
    otherOverlap: 0,
  };
  const sources: Sources = { posted: 0, fixed: 0, session: 0, withdrawn: 0, other: 0 };
  const drafts = new Map<string, Draft>();
  const byRun = new Map<number, Draft>();
  const rrSkipped: RereviewSkipped = { noEarlier: 0, badPayload: 0, missingCommits: 0, emptyCases: 0 };
  const rrByRun = new Map<number, RereviewDraft & { from: number }>();
  const runs = db.query(SQL.runs).all() as RunRow[];
  for (const [k, r] of runs.entries()) {
    if (r.since !== null && r.base !== null) {
      // run-rows.ts baseRun: the newest finished review run of the PR when the re-review started.
      const e = runs.slice(0, k).findLast((x) => x.pr === r.pr && x.explain === 0);
      if (!e || e.head !== r.since || e.base === null) rrSkipped.noEarlier++;
      else
        rrByRun.set(r.id, {
          pr: r.pr,
          run: r.id,
          from: e.id,
          head: r.head,
          base: r.base,
          since: e.head,
          sinceBase: e.base,
          bugs: [],
          traps: [],
          extras: [],
          earlier: [],
        });
    }
    if (r.base === null) {
      skipped.noMergeBase++;
      continue;
    }
    // One case per reviewed head. The merge base is part of the key, because old-side lines are numbered at it.
    const key = `${r.pr} ${r.head} ${r.base}`;
    const d = drafts.get(key) ?? {
      pr: r.pr,
      head: r.head,
      base: r.base,
      runs: 0,
      first: r.id,
      last: r.id,
      bugs: [],
      traps: [],
      extras: [],
      human: [],
    };
    drafts.set(key, d);
    d.runs++;
    d.last = r.id;
    byRun.set(r.id, d);
  }

  const items = (db.query(SQL.items).all() as ItemRow[]).map((r) => ({ ...r, p: JSON.parse(r.payload_json) as StatsPayload }));
  // stats.ts: the decision on a carried finding is on its newest copy. Copies have higher IDs than their sources.
  const copyOf = new Map<number, (typeof items)[number]>();
  for (const i of items) if (i.p.carried) copyOf.set(i.p.carried.from, i);
  const last = (i: (typeof items)[number]) => {
    let at = i;
    for (let next = copyOf.get(at.id); next; next = copyOf.get(at.id)) at = next;
    return at;
  };
  const withdrawn = new Set((db.query(SQL.withdrawn).all() as { item: number }[]).map((t) => t.item));
  for (const i of items) {
    const d = byRun.get(i.run);
    // A revision of a finding (payload revises) is no finding of its own.
    if (!d || i.p.revises !== undefined) continue;
    if (i.path === null || i.line === null || (i.side !== "new" && i.side !== "old")) {
      skipped.noAnchor++;
      continue;
    }
    const spot: Spot = { path: i.path, side: i.side, lines: [i.line, i.line_end ?? i.line] };
    const end = last(i);
    const code = end.p.discardReason?.code;
    // A re-review case gets the decisions on the items of its own run.
    const rr = rrByRun.get(i.run);
    const to = rr ? [d, rr] : [d];
    const yours = end.status === "discarded" && end.p.discardedBy !== "verify" && userDiscard(end.p, end.copied === 1);
    // A fix commit or an accept of the session that wrote the code confirms the finding. Your own discard still wins.
    const confirmed =
      end.status !== "posted" && !yours ? (end.p.fixed ? "fixed" : end.p.session?.verdict === "accept" ? "session" : null) : null;
    if (end.status === "posted" && withdrawn.has(end.id)) {
      sources.withdrawn++;
      for (const x of to) x.traps.push({ id: `item-${i.id}`, ...spot, why: `Posted, then withdrawn in its thread: finding ${end.id}.` });
    } else if (end.status === "posted" || confirmed) {
      const module = end.p.module ?? "core";
      const bug: EvalBug = {
        id: `item-${i.id}`,
        ...spot,
        severityMin: end.p.severity,
        module: (MODULE_IDS as readonly string[]).includes(module) ? (module as EvalBug["module"]) : "core",
        note:
          confirmed === "fixed"
            ? `Finding ${end.id} covered by a fix commit.`
            : confirmed === "session"
              ? `Finding ${end.id} accepted by your session.`
              : `Posted finding ${end.id}.`,
      };
      sources[confirmed ?? "posted"]++;
      for (const x of to) x.bugs.push(bug);
    } else if (end.status !== "discarded") skipped.undecided++;
    // The check is under test, so its verdict is no truth. A restore removes discardedBy.
    else if (end.p.discardedBy === "verify") skipped.refuted++;
    // A closing re-review or a session reject discarded it, not you.
    else if (!yours) skipped.notYours++;
    else if (code && TRAP_CODES.has(code)) {
      for (const x of to) x.traps.push({ id: `item-${i.id}`, ...spot, why: `Discarded as ${code}: finding ${end.id}.` });
    } else
      for (const x of to) x.extras.push({ ...spot, note: `Discarded ${code ? `as ${code}` : "without a reason"}: finding ${end.id}.` });
  }

  // The earlier findings of each re-review case, with their state when the re-review started. A copy in the re-review shows that the
  // finding was new or accepted then. Questions of the earlier run stay out.
  const resolved = new Map((db.query(SQL.threads).all() as { item: number; resolved: number }[]).map((t) => [t.item, t.resolved === 1]));
  for (const rr of rrByRun.values())
    for (const i of items) {
      if (i.run !== rr.from || i.p.revises !== undefined || i.path === null || i.line === null || (i.side !== "new" && i.side !== "old"))
        continue;
      const carried = copyOf.get(i.id)?.run === rr.run;
      const status = carried || i.status === "new" || i.status === "accepted" ? "open" : i.status;
      if (status !== "open" && status !== "posted" && status !== "discarded") continue;
      const payload = finding.loose().safeParse(i.p);
      if (!payload.success) {
        rrSkipped.badPayload++;
        continue;
      }
      // Only your own discard is a decision. Others stay in the earlier run, as the app had them, with no re-raise check.
      const yours = status !== "discarded" || (i.p.discardedBy !== "verify" && userDiscard(i.p, i.copied === 1));
      rr.earlier.push({
        id: `item-${i.id}`,
        path: i.path,
        side: i.side,
        lines: [i.line, i.line_end ?? i.line],
        status: yours ? status : "dropped",
        resolved: status === "posted" ? (resolved.get(i.id) ?? null) : null,
        body: i.body,
        payload: payload.data,
      });
    }

  const byPr = Map.groupBy(drafts.values(), (d) => d.pr);
  for (const c of db.query(SQL.comments).all() as CommentRow[]) {
    const list = byPr.get(c.pr);
    if (!list) continue;
    const mine = isMe({ slug: c.author_slug, login: c.author_login }, me);
    // The comments of the PR author explain the change. They are no review.
    if (!mine && c.author_slug && c.author_slug === c.pr_author) {
      skipped.otherAuthor++;
      continue;
    }
    const anchor = JSON.parse(c.anchor_json) as { fromHash?: unknown; toHash?: unknown };
    const excerpt = c.excerpt_json === null ? undefined : (JSON.parse(c.excerpt_json) as ExcerptLine[]);
    const spot = threadSpot({ anchor, excerpt });
    if (!spot || spot.line === null) {
      skipped[mine ? "commentNoLine" : "otherNoLine"]++;
      continue;
    }
    // integration-check.md U12: a push that changes the commented line makes the anchor orphaned. A force push can also orphan it.
    if (!mine && !spot.orphaned && c.resolved !== 1) {
      skipped.otherOpen++;
      continue;
    }
    // A comment anchor names its diff with fromHash and toHash (BRIEF section 3.3). New-side lines are numbered at toHash, old-side
    // lines at fromHash.
    const at = list.filter((d) => d.head === anchor.toHash && (spot.side === "new" || d.base === anchor.fromHash));
    if (!at.length) skipped[mine ? "commentOtherHead" : "otherOtherHead"]++;
    else if (!mine) sources.other++;
    const place = { path: spot.path, side: spot.side, lines: [spot.line, spot.lineEnd] as [number, number] };
    for (const d of at)
      if (mine) d.human.push({ id: `comment-${c.comment_id}`, ...place, note: `Your comment ${c.comment_id}.` });
      // A comment has no severity. minor counts at the volumes balanced and thorough (score.ts mustFind).
      // One defect is one must find. A comment on the lines of a must find of the case adds none.
      else if (d.bugs.some((b) => b.path === place.path && b.side === place.side && overlaps(b.lines, place.lines))) skipped.otherOverlap++;
      else
        d.bugs.push({
          id: `comment-${c.comment_id}`,
          ...place,
          severityMin: "minor",
          module: "core",
          source: "other",
          note: `Comment ${c.comment_id} of another reviewer, ${c.resolved === 1 ? "resolved" : "on a line that a later head changed"}.`,
        });
  }

  // Must find and must not raise on overlapping lines of one case: both go.
  const hit = (a: Spot, b: Spot) => a.path === b.path && a.side === b.side && overlaps(a.lines, b.lines);
  for (const d of drafts.values()) {
    const found = [...d.bugs, ...d.human];
    const keep = <T extends Spot>(list: T[], other: Spot[]) => {
      const left = list.filter((x) => !other.some((y) => hit(x, y)));
      skipped.conflicts += list.length - left.length;
      return left;
    };
    const traps = keep(d.traps, found);
    d.bugs = keep(d.bugs, d.traps);
    d.human = keep(d.human, d.traps);
    d.traps = traps;
  }
  // The same rule for a re-review case. Its items are in a plain case too, which counts them.
  const rereviews = [...rrByRun.values()].map(({ from: _, ...rr }) => {
    const apart = <T extends Spot>(list: T[], other: Spot[]) => list.filter((x) => !other.some((y) => hit(x, y)));
    return { ...rr, bugs: apart(rr.bugs, rr.traps), traps: apart(rr.traps, rr.bugs) };
  });
  return { drafts: [...drafts.values()], skipped, sources, rereviews, rereviewSkipped: rrSkipped };
}

// ---------- Carry ----------

// changed: a hunk touches the lines. gone: the later commit deletes the file. overlap: the later case has its own item there.
export type Carry = { carried: number; changed: number; gone: number; overlap: number };

// A posted finding (a bug) or a trap of a case also counts at each later case of the same PR while its lines hold. Run IDs give the
// order, so an item never goes to an earlier head. New-side lines move with the diff from head to head, old-side lines with the diff
// from merge base to merge base (run.ts earlierAt). The newest decision on a place wins, so the newest case gives first. A case gives
// before it gets, so it gives only its own items. Re-review cases get nothing: their earlier findings are in rereview.earlier, and an
// item there is a re-raise.
export async function carry(drafts: Draft[], diff: (from: string, to: string) => Promise<DiffFile[]>): Promise<Carry> {
  const n: Carry = { carried: 0, changed: 0, gone: 0, overlap: 0 };
  const hit = (a: Spot, b: Spot) => a.path === b.path && a.side === b.side && overlaps(a.lines, b.lines);
  const sorted = [...drafts].sort((a, b) => b.first - a.first);
  for (const from of sorted) {
    for (const to of sorted.toReversed()) {
      if (to.pr !== from.pr || to.first <= from.last) continue;
      const files = { new: await diff(from.head, to.head), old: await diff(from.base, to.base) };
      const move = <T extends EvalBug | EvalTrap>(list: T[], into: T[]) => {
        for (const x of list) {
          const m = mapSpot(files[x.side], x);
          if (!m) {
            if (files[x.side].some((f) => f.oldPath === x.path && f.path === null)) n.gone++;
            else n.changed++;
          } else if ([...to.bugs, ...to.traps, ...to.human, ...to.extras].some((y) => hit({ ...x, ...m }, y))) n.overlap++;
          else {
            into.push({ ...x, ...m, carriedFrom: from.head });
            n.carried++;
          }
        }
      };
      move(from.bugs, to.bugs);
      move(from.traps, to.traps);
    }
  }
  return n;
}

// ---------- Threads ----------

// Caps per case. pr-context.md shows at most PR_CONTEXT_BYTES (context-files.ts), so more text gives the run nothing.
export const THREAD_COMMENTS_MAX = 60;
export const THREAD_TEXT_MAX = 2000;
// Counts per case. capped: comments that the cap left out. unplaced: inline threads whose lines do not map to the reviewed head; they
// stay as file comments. mineRoot: replies of other people in threads that you started, left out with those threads. overlap: threads
// on the lines of a must-find of the case, left out. edited: comments edited from the cutoff on, left out; an edited root takes its
// thread. earlier: replies of the PR author in the threads of posted earlier findings (re-review cases).
export type ThreadTally = {
  cases: number;
  threads: number;
  comments: number;
  capped: number;
  unplaced: number;
  mineRoot: number;
  overlap: number;
  edited: number;
  earlier: number;
};
export const noThreads = (): ThreadTally => ({
  cases: 0,
  threads: 0,
  comments: 0,
  capped: 0,
  unplaced: 0,
  mineRoot: 0,
  overlap: 0,
  edited: 0,
  earlier: 0,
});
const CUT_NOTE = "\n[The eval builder cut this comment.]";
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// The placeholder of a person who has no role in the PR, and of an @mention of an unknown name.
export const SOMEONE = "someone";
// Slugs and logins that are common words. They change only in an @mention, not as bare words. Display-name words too.
const COMMON = new Set(
  "admin author bot build ci deploy dev develop email guest host main master none null owner release review reviewer root service someone support system team test tester unknown user".split(
    " ",
  ),
);
// URL schemes with a host part, email addresses, and the @mention forms: @{name}, [~name] (Jira), @"name", and @word.
const URL_HOST = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#<>"'()[\]]+/giu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const MENTION = /@\{([^}]*)\}|\[~([^\]]*)\]|@"([^"]*)"|(?<![\p{L}\p{N}_])@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/gu;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsed = <T>(s: string | null): T | undefined => {
  try {
    return s ? (JSON.parse(s) as T) : undefined;
  } catch {
    return undefined;
  }
};

type Anchor = { fromHash?: unknown; toHash?: unknown; lineType?: unknown };
type Where = Pick<EvalThreadComment, "path" | "side" | "lines" | "lineType" | "newPlace">;

// The threads of other people when a review run started, for pr-context.md of the run (docs/plans/review-v2/review-ideas.md idea 2).
// rows: the comments of the PR in created order, deleted ones too. before: the start time of the review run in ms. A comment from
// that time on, or edited from that time on, did not exist at the review in this form. skip: the item IDs of the case. must: the
// places of the must-finds of the case. A thread that is a must-find, or on the lines of one, stays out, so the run never reads its
// own truth. people: every person of the database. earlier: the posted earlier findings by thread root (re-review cases).
// place: the lines at the reviewed head on the given side, mapped from the given commit, or null when they do not map.
// People of the PR become EVAL_AUTHOR, EVAL_USER, or reviewer-<n> in first-comment order over the PR, in the author field and in the
// text. Other people become SOMEONE in the text. A root that is deleted but has live replies stays, as pr-context.ts shows it.
export async function caseThreads(
  rows: ThreadRow[],
  o: {
    me: string;
    before: number;
    skip: Set<string>;
    must: Spot[];
    people: Person[];
    earlier?: Map<number, string>;
    place: (
      s: { path: string; lines: [number, number] },
      from: unknown,
      side: "new" | "old",
    ) => Promise<{ path: string; lines: [number, number] } | null>;
  },
  n: ThreadTally,
): Promise<EvalThreadComment[]> {
  const mine = (r: { slug: string | null; login: string | null }) => isMe({ slug: r.slug ?? "", login: r.login }, o.me);
  const key = (s: string) => s.normalize("NFC").toLowerCase();
  const prAuthor = rows[0]?.prAuthor ?? null;
  const isAuthor = (slug: string) => prAuthor !== null && key(slug) === key(prAuthor);
  const bySlug = new Map<string, string>();
  const placeholder = (r: ThreadRow) => {
    if (isAuthor(r.slug)) return EVAL_AUTHOR;
    const p = bySlug.get(key(r.slug)) ?? `reviewer-${bySlug.size + 1}`;
    bySlug.set(key(r.slug), p);
    return p;
  };
  // bare: names that change as whole words. tag: names that change in an @mention.
  const bare = new Map<string, string>();
  const tag = new Map<string, string>();
  const set = (m: Map<string, string>, s: string | null, p: string) => {
    if (s?.trim() && !m.has(key(s))) m.set(key(s), p);
  };
  const person = (u: Person, p: string) => {
    for (const s of [u.slug, u.login]) {
      set(tag, s, p);
      if (s && s.length >= 4 && !COMMON.has(key(s))) set(bare, s, p);
    }
    if (!u.name?.trim()) return;
    set(tag, u.name, p);
    const words = u.name.split(/[^\p{L}\p{N}]+/u).filter((w) => (w.match(/\p{L}/gu)?.length ?? 0) >= 3);
    for (const s of [u.name, ...words]) if (!COMMON.has(key(s))) set(bare, s, p);
  };
  person({ slug: prAuthor, login: null, name: rows[0]?.prAuthorName ?? null }, EVAL_AUTHOR);
  for (const r of rows) person(r, mine(r) ? EVAL_USER : placeholder(r));
  for (const u of o.people) person(u, mine(u) ? EVAL_USER : SOMEONE);
  // The regex folds case by Unicode rules, which can differ from toLowerCase. A miss then repeats the match of the regex per name.
  const find = (m: Map<string, string>, s: string) =>
    m.get(key(s)) ?? [...m].find(([k]) => new RegExp(`^${reEscape(k)}$`, "iu").test(s.normalize("NFC")))?.[1];
  // A whole-word match of each name. The longest name goes first. A dot or a hyphen joins a word only when a letter or digit follows
  // it, so "name." at a sentence end matches and "name.other" does not.
  const words = [...bare.keys()].sort((a, b) => b.length - a.length).map(reEscape);
  const pattern = words.length
    ? new RegExp(`(?<![\\p{L}\\p{N}_]|[\\p{L}\\p{N}_][.-])(?:${words.join("|")})(?![\\p{L}\\p{N}_]|[.-][\\p{L}\\p{N}_])`, "giu")
    : null;
  const clean = (text: string) => {
    let t = text
      .normalize("NFC")
      .replace(URL_HOST, "$1<host>")
      .replace(EMAIL, "<email>")
      .replace(MENTION, (_, ...g: (string | undefined)[]) => `@${find(tag, g.slice(0, 4).find((x) => x !== undefined) ?? "") ?? SOMEONE}`);
    if (pattern) t = t.replace(pattern, (m) => find(bare, m) ?? SOMEONE);
    return t.length > THREAD_TEXT_MAX ? `${t.slice(0, THREAD_TEXT_MAX)}${CUT_NOTE}` : t;
  };

  const known = (r: ThreadRow) => r.at < o.before;
  const fresh = (r: ThreadRow) => r.updated < o.before;
  type Thread = { rows: ThreadRow[]; where: Where; earlier?: string; unplaced?: boolean };
  const candidates: Thread[] = [];
  for (const root of rows.filter((r) => r.id === r.root && known(r))) {
    const all = rows.filter((r) => r.root === root.id && r.id !== root.id && known(r) && r.deleted === 0 && !mine(r));
    const replies = all.filter(fresh);
    if (mine(root)) {
      const e = o.earlier?.get(root.id);
      const by = e ? all.filter((r) => isAuthor(r.slug)) : [];
      n.mineRoot += all.length - by.length;
      n.edited += by.filter((r) => !fresh(r)).length;
      if (by.some(fresh)) candidates.push({ rows: [root, ...by.filter(fresh)], where: {}, earlier: e });
    } else if (o.skip.has(`comment-${root.id}`) || (root.deleted === 1 && !replies.length)) continue;
    else if (root.deleted === 0 && !fresh(root)) n.edited++;
    else {
      n.edited += all.length - replies.length;
      candidates.push({ rows: [root, ...replies], where: {} });
    }
  }

  // The place of each inline root at the reviewed head. A thread on the lines of a must-find goes.
  const onMust = (s: Spot) => o.must.some((b) => b.path === s.path && b.side === s.side && overlaps(b.lines, s.lines));
  const threads: Thread[] = [];
  for (const t of candidates) {
    const r = t.rows[0] as ThreadRow;
    const anchor = t.earlier ? undefined : parsed<Anchor>(r.anchor);
    const excerpt = parsed<ExcerptLine[]>(r.excerpt);
    const spot = anchor ? threadSpot({ anchor, excerpt }) : null;
    if (spot && spot.line === null) t.where.path = spot.path;
    else if (spot && anchor) {
      const s = { path: spot.path, lines: [spot.line as number, spot.lineEnd] as [number, number] };
      const m = await o.place(s, spot.side === "new" ? anchor.toHash : anchor.fromHash, spot.side);
      if (!m) Object.assign(t, { where: { path: spot.path }, unplaced: true });
      else {
        Object.assign(t.where, { path: m.path, side: spot.side, lines: m.lines });
        const hit = excerpt?.find((l) => l.hit);
        let head: { path: string; lines: [number, number] } | null = null;
        if (spot.side === "old" && (hit ? hit.kind === "ctx" : anchor.lineType === "CONTEXT")) {
          t.where.lineType = "CONTEXT";
          head = await o.place(s, anchor.fromHash, "new");
          if (head) t.where.newPlace = head;
        }
        if (onMust({ path: m.path, side: spot.side, lines: m.lines }) || (head && onMust({ ...head, side: "new" }))) {
          n.overlap++;
          continue;
        }
      }
    }
    threads.push(t);
  }

  // The newest threads stay, as pr-context.md orders them.
  const newest = (t: Thread) => Math.max(...t.rows.map((r) => r.at));
  threads.sort((a, b) => newest(b) - newest(a) || (b.rows[0] as ThreadRow).id - (a.rows[0] as ThreadRow).id);
  const kept: Thread[] = [];
  let count = 0;
  for (const t of threads)
    if (count + t.rows.length > THREAD_COMMENTS_MAX) n.capped += t.rows.length;
    else {
      kept.push(t);
      count += t.rows.length;
    }
  const of = new Map(kept.map((t) => [(t.rows[0] as ThreadRow).id, t]));
  const all = kept.flatMap((t) => t.rows).sort((a, b) => a.at - b.at || a.id - b.id);
  const local = new Map(all.map((r, k) => [r.id, k + 1]));
  const out: EvalThreadComment[] = [];
  for (const r of all) {
    const t = of.get(r.root) as Thread;
    // run.ts seeds the root of an earlier finding from rereview.earlier.
    if (t.earlier && r.id === r.root) continue;
    const c: EvalThreadComment = {
      id: local.get(r.id) as number,
      root: local.get(r.root) as number,
      author: placeholder(r),
      at: r.at,
      text: r.deleted === 1 ? "" : clean(r.text),
    };
    if (t.earlier) {
      c.earlier = t.earlier;
      n.earlier++;
    } else if (r.id === r.root) {
      Object.assign(c, t.where);
      if (t.unplaced) n.unplaced++;
      if (r.deleted === 1) c.deleted = true;
      if (r.resolved === 1 && r.resolvedAt !== null && r.resolvedAt < o.before) c.resolved = true;
    }
    out.push(c);
  }
  if (kept.length) n.cases++;
  n.threads += kept.length;
  n.comments += out.length;
  return out;
}

// ---------- Build ----------

export type Manifest = {
  format: 1;
  createdAt: string;
  fingerprint: string;
  counts: { cases: number; runs: number; repositories: number; bugs: number; traps: number; extras: number; human: number };
  skipped: Skipped;
  sources: Sources;
  // The items that a case got from an earlier head of the same PR, and those that stayed behind (carry). Bugs and traps above include
  // the carried items.
  carried: Carry;
  // The PR threads in the written cases (caseThreads). Absent in a manifest of rules 2. overlap, edited, and earlier: rules 4.
  threads: ThreadTally;
  // The re-review cases in rereview/ (docs/plans/review-v3.md WP-V3). bun run eval --rereview runs them.
  rereview: {
    fingerprint: string;
    counts: { cases: number; bugs: number; traps: number; extras: number; earlier: number };
    skipped: RereviewSkipped;
  };
};

async function build(o: { db: string; cache: string; out: string; me: string }): Promise<Manifest> {
  const tmp = mkdtempSync(join(tmpdir(), "rl-eval-local-"));
  try {
    // A read-only open of a WAL database still makes -shm and -wal files beside it. The temp copy keeps them out of the data folder.
    const file = join(tmp, "db.sqlite");
    copyFileSync(o.db, file);
    if (existsSync(`${o.db}-wal`)) copyFileSync(`${o.db}-wal`, `${file}-wal`);
    const db = new Database(file, { readonly: true });
    let sel: ReturnType<typeof select>;
    let prs: Map<number, PrRow>;
    let tasks: TaskRow[];
    let threadRows: Map<number, ThreadRow[]>;
    let people: Person[];
    let starts: Map<number, number>;
    let postedRoots: Map<number, number>;
    try {
      sel = select(db, o.me);
      prs = new Map((db.query(SQL.prs).all() as PrRow[]).map((p) => [p.id, p]));
      tasks = db.query(SQL.tasks).all() as TaskRow[];
      threadRows = Map.groupBy(db.query(SQL.threadRows).all() as ThreadRow[], (r) => r.pr);
      people = db.query(SQL.people).all() as Person[];
      starts = new Map((db.query(SQL.starts).all() as { id: number; at: number }[]).map((r) => [r.id, r.at]));
      postedRoots = new Map((db.query(SQL.postedRoots).all() as { item: number; root: number }[]).map((r) => [r.item, r.root]));
    } finally {
      db.close();
    }
    const { skipped } = sel;
    // A case can get its first item from an earlier head, so the empty check runs after carry.
    const drafts = sel.drafts;
    const truth = (d: Draft) => d.bugs.length > 0 || d.traps.length > 0 || d.human.length > 0;
    const carried: Carry = { carried: 0, changed: 0, gone: 0, overlap: 0 };
    const threadTally = noThreads();

    const empty = join(tmp, "empty.gitconfig");
    writeFileSync(empty, "");
    const env = gitEnv(empty);
    for (const f of OUT_NAMES) rmSync(join(o.out, f), { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(join(o.out, "cases"), { recursive: true });
    mkdirSync(join(o.out, "bundles"), { recursive: true });

    // A re-review case needs something to find, to avoid, or to not raise again.
    const rrSkipped = sel.rereviewSkipped;
    const rereviews = sel.rereviews.filter(
      (r) => r.bugs.length || r.traps.length || r.earlier.some((e) => e.status === "posted" || e.status === "discarded"),
    );
    rrSkipped.emptyCases += sel.rereviews.length - rereviews.length;
    mkdirSync(join(o.out, "rereview"), { recursive: true });

    const written: { id: string; hash: string }[] = [];
    const rrWritten: { id: string; hash: string }[] = [];
    let runs = 0;
    let repositories = 0;
    const repoOf = (pr: number) => {
      const p = prs.get(pr) as PrRow;
      return `${p.project}/${p.repo}`;
    };
    const byRepo = Map.groupBy(drafts, (d) => repoOf(d.pr));
    const rrByRepo = Map.groupBy(rereviews, (d) => repoOf(d.pr));
    for (const key of [...new Set([...byRepo.keys(), ...rrByRepo.keys()])].sort()) {
      const list = byRepo.get(key) ?? [];
      const rrs = rrByRepo.get(key) ?? [];
      const [project = "", repo = ""] = key.split("/");
      const cache = join(o.cache, project, `${repo}.git`);
      // A case with nothing to find or avoid stays empty without its commits.
      const lost = (l: Draft[]) => {
        const empty = l.filter((d) => !truth(d)).length;
        skipped.emptyCases += empty;
        skipped.missingCommits += l.length - empty;
      };
      if (!NAME.test(project) || !NAME.test(repo) || !existsSync(cache)) {
        lost(list);
        rrSkipped.missingCommits += rrs.length;
        continue;
      }
      const g = (args: string[], stdin?: string) => git(["--git-dir", cache, ...args], { env, stdin });
      const need = (d: Draft | RereviewDraft) => ("since" in d ? [d.base, d.head, d.since, d.sinceBase] : [d.base, d.head]);
      const shas = [...new Set([...list, ...rrs].flatMap(need))];
      const types = (await g(["cat-file", "--batch-check=%(objecttype)"], `${shas.join("\n")}\n`)).split("\n");
      const present = new Set(shas.filter((_, k) => types[k] === "commit"));
      const all = list.filter((d) => need(d).every((c) => present.has(c)));
      const rrOk = rrs.filter((d) => need(d).every((c) => present.has(c)));
      lost(list.filter((d) => !all.includes(d)));
      rrSkipped.missingCommits += rrs.length - rrOk.length;
      const diffs = new Map<string, DiffFile[]>();
      const diff = async (from: string, to: string) => {
        if (from === to) return [];
        const k = `${from} ${to}`;
        const f = diffs.get(k) ?? parseDiff(await g(["diff", ...diffArgs, from, to]));
        diffs.set(k, f);
        return f;
      };
      const got = await carry(all, diff);
      for (const k of Object.keys(carried) as (keyof Carry)[]) carried[k] += got[k];
      const ok = all.filter(truth);
      skipped.emptyCases += all.length - ok.length;
      if (!ok.length && !rrOk.length) continue;

      // The bundle name hides the project key and the repository slug.
      const bundle = `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.bundle`;
      const temp = join(tmp, `bundle-${repositories}.git`);
      await git(["init", "-q", "--bare", "--template=", temp], { env });
      mkdirSync(join(temp, "objects", "info"), { recursive: true });
      // The temp repository borrows the objects of the cache, so the cache gets no write. Against the cache itself, the builder runs
      // only cat-file, diff, and log, which read.
      writeFileSync(join(temp, "objects", "info", "alternates"), `${join(cache, "objects").replaceAll("\\", "/")}\n`);
      const commits = [...new Set([...ok, ...rrOk].flatMap(need))];
      await git(["--git-dir", temp, "update-ref", "--stdin"], { env, stdin: commits.map((c) => `create refs/eval/${c} ${c}\n`).join("") });
      await git(["--git-dir", temp, "bundle", "create", "-q", join(o.out, "bundles", bundle), "--all"], { env });
      repositories++;
      // New-side lines move to the reviewed head, old-side lines to the case merge base. A commit that is not in the cache makes the git
      // diff fail, so the thread stays without lines.
      const threadsOf = async (d: Draft | RereviewDraft) => {
        const rr = "since" in d;
        // The review run of the case started at this time. A re-review case reviews its own run, a plain case its first run.
        const before = starts.get(rr ? d.run : d.first) as number;
        const must = [...d.bugs, ...("human" in d ? d.human : [])];
        const skip = new Set([...must, ...d.traps].map((x) => x.id));
        const earlier = new Map<number, string>();
        if (rr)
          for (const e of d.earlier) {
            const root = e.status === "posted" ? postedRoots.get(Number(e.id.slice("item-".length))) : undefined;
            if (root !== undefined) earlier.set(root, e.id);
          }
        const place = async (s: { path: string; lines: [number, number] }, from: unknown, side: "new" | "old") => {
          if (typeof from !== "string" || !COMMIT.test(from)) return null;
          try {
            return mapSpot(await diff(from, side === "new" ? d.head : d.base), s);
          } catch {
            return null;
          }
        };
        const list = await caseThreads(threadRows.get(d.pr) ?? [], { me: o.me, before, skip, must, people, earlier, place }, threadTally);
        return list.length ? { threads: list } : {};
      };

      for (const d of ok) {
        const p = prs.get(d.pr) as PrRow;
        const title = p.title?.trim() || `PR ${p.pr_id}`;
        const c: LocalCaseFile = localCaseFile.parse({
          id: caseId(d),
          title,
          language: "unknown",
          pr: { title, description: p.description ?? "" },
          bugs: d.bugs,
          traps: d.traps,
          extras: d.extras,
          human: d.human,
          tasks: tasks.filter((t) => t.pr === d.pr).map(({ key, source, json }) => ({ key, source, json })),
          bundle: { file: bundle, base: d.base, head: d.head },
          changedLines: changedLines(await g(["diff", ...diffArgs, d.base, d.head])),
          rules: LOCAL_RULES,
          ...(await threadsOf(d)),
        });
        const text = `${JSON.stringify(c, null, 2)}\n`;
        mkdirSync(join(o.out, "cases", c.id));
        writeFileSync(join(o.out, "cases", c.id, "case.json"), text);
        written.push({ id: c.id, hash: createHash("sha256").update(text).digest("hex") });
        runs += d.runs;
      }
      for (const d of rrOk) {
        const p = prs.get(d.pr) as PrRow;
        const title = p.title?.trim() || `PR ${p.pr_id}`;
        const c: LocalCaseFile = localCaseFile.parse({
          id: rereviewId(d),
          title,
          language: "unknown",
          pr: { title, description: p.description ?? "" },
          bugs: d.bugs,
          traps: d.traps,
          extras: d.extras,
          human: [],
          tasks: tasks.filter((t) => t.pr === d.pr).map(({ key, source, json }) => ({ key, source, json })),
          bundle: { file: bundle, base: d.base, head: d.head },
          changedLines: changedLines(await g(["diff", ...diffArgs, d.base, d.head])),
          rereview: { since: d.since, sinceBase: d.sinceBase, earlier: d.earlier },
          ...(await threadsOf(d)),
        });
        const text = `${JSON.stringify(c, null, 2)}\n`;
        mkdirSync(join(o.out, "rereview", c.id));
        writeFileSync(join(o.out, "rereview", c.id, "case.json"), text);
        rrWritten.push({ id: c.id, hash: createHash("sha256").update(text).digest("hex") });
      }
    }

    const ids = new Set(written.map((w) => w.id));
    const kept = drafts.filter((d) => ids.has(caseId(d)));
    const total = (k: "bugs" | "traps" | "extras" | "human") => kept.reduce((n, d) => n + d[k].length, 0);
    const rrIds = new Set(rrWritten.map((w) => w.id));
    const rrKept = rereviews.filter((d) => rrIds.has(rereviewId(d)));
    const rrTotal = (k: "bugs" | "traps" | "extras" | "earlier") => rrKept.reduce((n, d) => n + d[k].length, 0);
    const manifest: Manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      fingerprint: setFingerprint(written),
      counts: {
        cases: written.length,
        runs,
        repositories,
        bugs: total("bugs"),
        traps: total("traps"),
        extras: total("extras"),
        human: total("human"),
      },
      skipped,
      sources: sel.sources,
      carried,
      threads: threadTally,
      rereview: {
        fingerprint: setFingerprint(rrWritten),
        counts: {
          cases: rrWritten.length,
          bugs: rrTotal("bugs"),
          traps: rrTotal("traps"),
          extras: rrTotal("extras"),
          earlier: rrTotal("earlier"),
        },
        skipped: rrSkipped,
      },
    };
    writeFileSync(join(o.out, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function report(m: Manifest): string {
  const { counts: n, skipped: s, sources: o, rereview: r } = m;
  const lines = [
    `Local eval set: ${n.cases} cases from ${n.runs} review runs in ${n.repositories} repositories.`,
    `Must find: ${n.bugs} findings and ${n.human} of your own comments. Must not raise: ${n.traps}. Neutral: ${n.extras}.`,
    `Sources before carry: ${o.posted} posted, ${o.fixed} covered by a fix commit, ${o.session} accepted by your session, ${o.withdrawn} posted and then withdrawn in the thread (must not raise), ${o.other} line comments of other reviewers that are resolved or on a changed line.`,
    `Left out: ${s.refuted} refuted by the check, ${s.notYours} discarded without your triage, ${s.undecided} without a decision, ${s.noAnchor} without an anchor, ${s.conflicts} in opposite decisions, ${s.noMergeBase} runs without a merge base, ${s.missingCommits} cases with missing commits, ${s.emptyCases} cases with nothing to find or avoid, ${s.commentNoLine} comments without a line, ${s.commentOtherHead} comments at a head with no review.`,
    `Comments of other reviewers left out: ${s.otherOpen} open on an unchanged line, ${s.otherNoLine} without a line, ${s.otherOtherHead} at a head with no review, ${s.otherAuthor} by the PR author, ${s.otherOverlap} on the lines of a must find of the same case.`,
    `Carried from earlier heads of the same PR: ${m.carried.carried}. Not carried: ${m.carried.changed} with changed lines, ${m.carried.gone} in a deleted file, ${m.carried.overlap} on an item of the later head.`,
    `PR threads of other people at the reviewed heads: ${m.threads.threads} threads with ${m.threads.comments} comments in ${m.threads.cases} cases. Left out: ${m.threads.capped} comments over the cap of ${THREAD_COMMENTS_MAX} per case, ${m.threads.mineRoot} replies in threads that you started, ${m.threads.overlap} threads on the lines of a must find, ${m.threads.edited} comments edited from the run start on. Without lines: ${m.threads.unplaced} inline threads whose lines do not map to the reviewed head. Re-review cases: ${m.threads.earlier} replies of the PR author to posted earlier findings.`,
    `Fingerprint: ${m.fingerprint.slice(0, 12)}. MANIFEST.json holds these counts.`,
    `Re-review cases: ${r.counts.cases}, with ${r.counts.earlier} earlier findings. Must find: ${r.counts.bugs}. Must not raise: ${r.counts.traps}. Neutral: ${r.counts.extras}.`,
    `Re-reviews left out: ${r.skipped.noEarlier} without their earlier run, ${r.skipped.missingCommits} with missing commits, ${r.skipped.emptyCases} with nothing to measure. Earlier findings left out: ${r.skipped.badPayload} with a payload that is no finding.`,
  ];
  if (n.cases < MINIMUM.cases || n.bugs < MINIMUM.bugs || n.traps < MINIMUM.traps)
    lines.push(
      `The set is below the recommended minimum of ${MINIMUM.cases} cases, ${MINIMUM.bugs} must-find findings, and ${MINIMUM.traps} must-not-raise findings.`,
    );
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  let v: { db?: string; cache?: string; out?: string; user?: string };
  try {
    v = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { db: { type: "string" }, cache: { type: "string" }, out: { type: "string" }, user: { type: "string" } },
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  // The data folder of the app, as config.ts dataDir gives it.
  const app = dataDir();
  const appDb = v.db ?? liveDb(app);
  if (!appDb) {
    console.error(`No database in the data folder of the app: config.json has no baseUrl. Pass --db.\n${USAGE}`);
    return 2;
  }
  const db = resolve(appDb);
  const cache = resolve(v.cache ?? join(app, "git"));
  const out = resolve(v.out ?? localDir());
  // The builder only reads --db and --cache. It writes only into --out, so --out must be outside every live data folder.
  if (liveFolders().some((d) => isInside(out, d))) {
    console.error("Refused: --out is inside the live data folder of the app. Use eval-local/ or a folder outside the data folder.");
    return 2;
  }
  if (isInside(out, REPO) && !(await ignored(out))) {
    console.error("Refused: --out is inside this repository, and git does not ignore it. Use eval-local/ or a folder outside it.");
    return 2;
  }
  const refused = outRefusal(out);
  if (refused) {
    console.error(refused);
    return 2;
  }
  if (!existsSync(db) || !existsSync(cache)) {
    console.error("The --db file or the --cache folder does not exist.");
    return 2;
  }
  const me = v.user ?? configField(dirname(db), "userSlug");
  if (!me) {
    console.error("No user slug. Pass --user <slug>, or keep config.json beside the database file.");
    return 2;
  }
  try {
    console.log(report(await build({ db, cache, out, me })));
    return 0;
  } catch (e) {
    console.error(`The build failed: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
