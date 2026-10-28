// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Builds the local eval set from your own decisions (docs/plans/review-v3.md WP-V1). docs/eval/local.md gives the steps.
// Usage: bun run eval:local -- --db <copy> --cache <copy> [--out <folder>] [--user <slug>]
// --db: a copy of the db-*.sqlite file. --cache: a copy of the git folder. Both come from a copy of the data folder of the closed app.
// The builder refuses a path in the live data folder. It reads a temp copy of the database and writes nothing to the copies.
// stdout gets counts only: no path, host, or name. Exit codes: 0 done, 1 a build error, 2 a usage error or a refused path.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "../../src/server/config";
import { git, gitEnv } from "../../src/server/review/git";
import { type StatsPayload, userDiscard } from "../../src/server/review/stats";
import { diffArgs } from "../../src/server/review/workspace";
import { isMe } from "../../src/shared/me";
import { finding } from "../../src/shared/review";
import { type ExcerptLine, threadSpot } from "../../src/shared/types";
import {
  changedLines,
  type EvalBug,
  type EvalEarlier,
  type EvalExtra,
  type EvalHuman,
  type EvalTrap,
  type LocalCaseFile,
  localCaseFile,
  localDir,
  MODULE_IDS,
  setFingerprint,
} from "./cases";
import { overlaps } from "./score";

const REPO = resolve(import.meta.dir, "../..");
export const USAGE =
  "Usage: bun run eval:local -- --db <copy of db-*.sqlite> --cache <copy of the git folder> [--out <folder>] [--user <slug>]";
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

// The user slug of config.json beside the database copy, or null.
function userOf(db: string): string | null {
  try {
    const c = JSON.parse(readFileSync(join(dirname(db), "config.json"), "utf8")) as { userSlug?: unknown };
    return typeof c.userSlug === "string" && c.userSlug ? c.userSlug : null;
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
  items: `SELECT i.id, i.run, i.status, i.path, i.side, i.line, i.line_end, i.body, i.payload_json,
      EXISTS (SELECT 1 FROM review_item c WHERE c.kind = 'finding' AND json_extract(c.payload_json, '$.carried.from') = i.id) AS copied
    FROM review_item i JOIN review_run r ON r.id = i.run
    WHERE i.kind = 'finding' AND r.pr IS NOT NULL AND r.kind = 'review' AND r.status IN ('completed', 'incomplete') ORDER BY i.id`,
  // The outbox posts findings and reply drafts. Only a root comment that it did not post is your own comment.
  comments: `SELECT c.pr, c.comment_id, c.author_slug, c.author_login, c.anchor_json, c.excerpt_json FROM comment c
    WHERE c.parent_id IS NULL AND c.tombstoned_at IS NULL AND c.anchor_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM post p WHERE p.pr = c.pr AND p.remote_id = c.comment_id) ORDER BY c.pr, c.comment_id`,
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
};
type PrRow = { id: number; pr_id: number; project: string; repo: string; title: string | null; description: string | null };
type TaskRow = { pr: number; key: string; source: string; json: string | null };
type Spot = { path: string; side: "new" | "old"; lines: [number, number] };

// One case before the repository steps: a reviewed (PR, head, merge base) and the decisions of its runs.
export type Draft = {
  pr: number;
  head: string;
  base: string;
  runs: number;
  bugs: EvalBug[];
  traps: EvalTrap[];
  extras: EvalExtra[];
  human: EvalHuman[];
};

// A re-review case (docs/plans/review-v3.md WP-V3): one re-review run, the decisions on its own items, and its earlier run.
export type RereviewDraft = Omit<Draft, "runs" | "human"> & { run: number; since: string; sinceBase: string; earlier: EvalEarlier[] };

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
};

export const caseId = (d: Pick<Draft, "pr" | "head" | "base">) => `pr${d.pr}-${d.head.slice(0, 12)}-${d.base.slice(0, 8)}`;
export const rereviewId = (d: Pick<RereviewDraft, "pr" | "run">) => `pr${d.pr}-rr${d.run}`;

// Pure: the database rows to drafts. me: the user slug, as isMe reads it.
export function select(
  db: Database,
  me: string,
): { drafts: Draft[]; skipped: Skipped; rereviews: RereviewDraft[]; rereviewSkipped: RereviewSkipped } {
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
  };
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
    const d = drafts.get(key) ?? { pr: r.pr, head: r.head, base: r.base, runs: 0, bugs: [], traps: [], extras: [], human: [] };
    drafts.set(key, d);
    d.runs++;
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
    if (end.status === "posted") {
      const module = end.p.module ?? "core";
      const bug: EvalBug = {
        id: `item-${i.id}`,
        ...spot,
        severityMin: end.p.severity,
        module: (MODULE_IDS as readonly string[]).includes(module) ? (module as EvalBug["module"]) : "core",
        note: `Posted finding ${end.id}.`,
      };
      for (const x of to) x.bugs.push(bug);
    } else if (end.status !== "discarded") skipped.undecided++;
    // The check is under test, so its verdict is no truth. A restore removes discardedBy.
    else if (end.p.discardedBy === "verify") skipped.refuted++;
    // A fix commit, a closing re-review, or a session reject discarded it, not you.
    else if (!userDiscard(end.p, end.copied === 1)) skipped.notYours++;
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
    if (!list || !isMe({ slug: c.author_slug, login: c.author_login }, me)) continue;
    const anchor = JSON.parse(c.anchor_json) as { fromHash?: unknown; toHash?: unknown };
    const excerpt = c.excerpt_json === null ? undefined : (JSON.parse(c.excerpt_json) as ExcerptLine[]);
    const spot = threadSpot({ anchor, excerpt });
    if (!spot || spot.line === null) {
      skipped.commentNoLine++;
      continue;
    }
    // A comment anchor names its diff with fromHash and toHash (BRIEF section 3.3). New-side lines are numbered at toHash, old-side
    // lines at fromHash.
    const at = list.filter((d) => d.head === anchor.toHash && (spot.side === "new" || d.base === anchor.fromHash));
    if (!at.length) skipped.commentOtherHead++;
    for (const d of at)
      d.human.push({
        id: `comment-${c.comment_id}`,
        path: spot.path,
        side: spot.side,
        lines: [spot.line, spot.lineEnd],
        note: `Your comment ${c.comment_id}.`,
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
  return { drafts: [...drafts.values()], skipped, rereviews, rereviewSkipped: rrSkipped };
}

// ---------- Build ----------

export type Manifest = {
  format: 1;
  createdAt: string;
  fingerprint: string;
  counts: { cases: number; runs: number; repositories: number; bugs: number; traps: number; extras: number; human: number };
  skipped: Skipped;
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
    // A read-only open of a WAL database still makes -shm and -wal files beside it. The temp copy keeps them out of your copy.
    const file = join(tmp, "db.sqlite");
    copyFileSync(o.db, file);
    if (existsSync(`${o.db}-wal`)) copyFileSync(`${o.db}-wal`, `${file}-wal`);
    const db = new Database(file, { readonly: true });
    let sel: ReturnType<typeof select>;
    let prs: Map<number, PrRow>;
    let tasks: TaskRow[];
    try {
      sel = select(db, o.me);
      prs = new Map((db.query(SQL.prs).all() as PrRow[]).map((p) => [p.id, p]));
      tasks = db.query(SQL.tasks).all() as TaskRow[];
    } finally {
      db.close();
    }
    const { skipped } = sel;
    const drafts = sel.drafts.filter((d) => d.bugs.length || d.traps.length || d.human.length);
    skipped.emptyCases += sel.drafts.length - drafts.length;

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
      if (!NAME.test(project) || !NAME.test(repo) || !existsSync(cache)) {
        skipped.missingCommits += list.length;
        rrSkipped.missingCommits += rrs.length;
        continue;
      }
      const g = (args: string[], stdin?: string) => git(["--git-dir", cache, ...args], { env, stdin });
      const need = (d: Draft | RereviewDraft) => ("since" in d ? [d.base, d.head, d.since, d.sinceBase] : [d.base, d.head]);
      const shas = [...new Set([...list, ...rrs].flatMap(need))];
      const types = (await g(["cat-file", "--batch-check=%(objecttype)"], `${shas.join("\n")}\n`)).split("\n");
      const present = new Set(shas.filter((_, k) => types[k] === "commit"));
      const ok = list.filter((d) => need(d).every((c) => present.has(c)));
      const rrOk = rrs.filter((d) => need(d).every((c) => present.has(c)));
      skipped.missingCommits += list.length - ok.length;
      rrSkipped.missingCommits += rrs.length - rrOk.length;
      if (!ok.length && !rrOk.length) continue;

      // The bundle name hides the project key and the repository slug.
      const bundle = `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.bundle`;
      const temp = join(tmp, `bundle-${repositories}.git`);
      await git(["init", "-q", "--bare", "--template=", temp], { env });
      mkdirSync(join(temp, "objects", "info"), { recursive: true });
      // The temp repository borrows the objects of the cache copy, so the copy gets no write.
      writeFileSync(join(temp, "objects", "info", "alternates"), `${join(cache, "objects").replaceAll("\\", "/")}\n`);
      const commits = [...new Set([...ok, ...rrOk].flatMap(need))];
      await git(["--git-dir", temp, "update-ref", "--stdin"], { env, stdin: commits.map((c) => `create refs/eval/${c} ${c}\n`).join("") });
      await git(["--git-dir", temp, "bundle", "create", "-q", join(o.out, "bundles", bundle), "--all"], { env });
      repositories++;

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
  const { counts: n, skipped: s, rereview: r } = m;
  const lines = [
    `Local eval set: ${n.cases} cases from ${n.runs} review runs in ${n.repositories} repositories.`,
    `Must find: ${n.bugs} posted findings and ${n.human} of your own comments. Must not raise: ${n.traps}. Neutral: ${n.extras}.`,
    `Left out: ${s.refuted} refuted by the check, ${s.notYours} discarded without your triage, ${s.undecided} without a decision, ${s.noAnchor} without an anchor, ${s.conflicts} in opposite decisions, ${s.noMergeBase} runs without a merge base, ${s.missingCommits} cases with missing commits, ${s.emptyCases} cases with nothing to find or avoid, ${s.commentNoLine} comments without a line, ${s.commentOtherHead} comments at a head with no review.`,
    `Fingerprint: ${m.fingerprint.slice(0, 12)}. MANIFEST.json holds these counts.`,
    `Re-review cases: ${r.counts.cases}, with ${r.counts.earlier} earlier findings. Must find: ${r.counts.bugs}. Must not raise: ${r.counts.traps}. Neutral: ${r.counts.extras}.`,
    `Re-reviews left out: ${r.skipped.noEarlier} without their earlier run, ${r.skipped.missingCommits} with missing commits, ${r.skipped.emptyCases} with nothing to measure. Earlier findings left out: ${r.skipped.badPayload} with a payload that is no finding.`,
  ];
  if (n.cases < MINIMUM.cases || n.bugs < MINIMUM.bugs || n.traps < MINIMUM.traps)
    lines.push(
      `The set is below the recommended minimum of ${MINIMUM.cases} cases, ${MINIMUM.bugs} posted findings, and ${MINIMUM.traps} must-not-raise findings.`,
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
  if (!v.db || !v.cache) {
    console.error(`Give --db and --cache.\n${USAGE}`);
    return 2;
  }
  const paths = { "--db": resolve(v.db), "--cache": resolve(v.cache), "--out": resolve(v.out ?? localDir()) };
  // The checks run before any read of the paths.
  const live = liveFolders();
  for (const [flag, p] of Object.entries(paths))
    if (live.some((d) => isInside(p, d))) {
      console.error(`Refused: ${flag} is inside the live data folder of the app. Close the app, copy its data folder, and pass the copy.`);
      return 2;
    }
  const { "--db": db, "--cache": cache, "--out": out } = paths;
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
  const me = v.user ?? userOf(db);
  if (!me) {
    console.error("No user slug. Pass --user <slug>, or keep config.json of the copy beside the database file.");
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
