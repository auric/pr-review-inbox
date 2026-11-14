// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v3.md WP-V1: the local eval set from your own decisions, its near-line score, and a local case run with the fake CLI.
// The tests make a synthetic database copy and a temp repository. Every data folder that a child can see is a temp folder.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type EvalBug, ITEM_SOURCES, type LocalCaseFile, loadCases, setFingerprint } from "../../scripts/eval/cases";
import { refusal } from "../../scripts/eval/compare";
import {
  BUG_CLASS_NAMES,
  carry,
  caseThreads,
  type Draft,
  type Manifest,
  noThreads,
  THREAD_COMMENTS_MAX,
  THREAD_TEXT_MAX,
  type ThreadRow,
} from "../../scripts/eval/local";
import { localRefusal, rescore } from "../../scripts/eval/rescore";
import { type CaseRun, type EvalItem, type EvalResult, score } from "../../scripts/eval/score";
import { threadCheck } from "../../scripts/eval/threads";
import { parseDiff } from "../../src/server/review/diffmap";
import { git, gitEnv } from "../../src/server/review/git";
import { openDb } from "../../src/server/storage/db";
import { bugClass } from "../../src/shared/review";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const LOCAL = join(ROOT, "scripts/eval/local.ts");
const RUN = join(ROOT, "scripts/eval/run.ts");
const COMPARE = join(ROOT, "scripts/eval/compare.ts");
const THREADS = join(ROOT, "scripts/eval/threads.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const PATH = "src/calc.ts";
const THREAD_TEXT = "Handled in v23. Ask @zelda-quux or Zelda Quux. Moe Mine agrees, zquux too.";
const CLEAN_TEXT = "Handled in v23. Ask @reviewer-2 or reviewer-2. eval-reviewer agrees, reviewer-2 too.";
const NOTE_TEXT = "Olga Far wrote to olga.far@corp.example.invalid, see https://git.corp.example.invalid/x and @nobody-here.";
const NOTE_CLEAN = "someone wrote to <email>, see https://<host>/x and @someone.";
const REAL = ["zelda", "Zelda", "zquux", "Moe Mine", "yuri", "xena", "Olga", "olga", "corp", "nobody", "wanda"];
// Your comment 100 and comment 109 of another reviewer: their gold text gets the placeholders of the threads and the cap.
const MINE_TEXT = "Ask Zelda Quux or @zquux. Mail olga.far@corp.example.invalid.";
const MINE_CLEAN = "Ask reviewer-2 or @reviewer-2. Mail <email>.";
const OTHER_TEXT = `Moe Mine says ${"z".repeat(2500)}`;
// Your edit of a finding body. It gets the names replaced, as your comments do.
const EDITED = "Your edit of the body. Zelda Quux agrees.";
const EDITED_CLEAN = "Your edit of the body. reviewer-2 agrees.";
// The review runs start after the head commit time (2026-01-01).
const RUN_START = Date.UTC(2027, 0, 1);

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-local-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;
const temp = (name: string) => {
  const d = join(TMP, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
// The live data folder of the children, and the parent of their default data folder (LOCALAPPDATA, XDG_DATA_HOME).
const LIVE = temp("live");
const APPDATA = temp("appdata");

async function bun(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, "--preload", NO_REAL, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_DATA_DIR: LIVE, LOCALAPPDATA: APPDATA, XDG_DATA_HOME: APPDATA, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

// ---------- The synthetic repository and database ----------

const line = (i: number, changed: boolean) => `export const v${i} = ${i}${changed ? " + 1" : ""};`;
const fileAt = (changed: Set<number>) => `${Array.from({ length: 40 }, (_, k) => line(k + 1, changed.has(k + 1))).join("\n")}\n`;
// Head A changes lines 10 to 14, 22, 27, and 30. Head B also changes lines 18, 20, and 37.
const A_LINES = new Set([10, 11, 12, 13, 14, 22, 27, 30]);
const B_LINES = new Set([...A_LINES, 18, 20, 37]);

// The copy of the git folder: <cache>/PROJ/repo.git with the base, A, B, and C commits. Head C adds 30 files to head B, so a case at C
// is large (catalog.ts REVIEWER_MIN_FILES).
async function makeCache(root: string) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "Eval Author",
    GIT_AUTHOR_EMAIL: "eval@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Eval Author",
    GIT_COMMITTER_EMAIL: "eval@example.invalid",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const src = join(root, "src");
  await git(["init", "-q", "--template=", src], { env });
  mkdirSync(join(src, "src"));
  const commit = async (text: string, msg: string) => {
    writeFileSync(join(src, PATH), text);
    await git(["-C", src, "add", "."], { env });
    await git(["-C", src, "commit", "-q", "-m", msg], { env });
    return (await git(["-C", src, "rev-parse", "HEAD"], { env })).trim();
  };
  const base = await commit(fileAt(new Set()), "base");
  const a = await commit(fileAt(A_LINES), "head A");
  const b = await commit(fileAt(B_LINES), "head B");
  for (let k = 1; k <= 30; k++)
    writeFileSync(
      join(src, "src", `gen${k}.ts`),
      `export const g${k} = ${k};
`,
    );
  const c = await commit(fileAt(B_LINES), "head C");
  const cache = join(root, "git");
  await git(["clone", "-q", "--bare", src, join(cache, "PROJ", "repo.git")], { env });
  return { cache, base, a, b, c };
}

type Heads = { base: string; a: string; b: string; c: string };

// The copy of the data folder: config.json and the database file. Each scenario names the case and the expected class.
function makeDb(dir: string, h: Heads) {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ baseUrl: "https://bitbucket.example.invalid", userSlug: "me", notifications: false }),
  );
  const file = join(dir, "db-test.sqlite");
  const db = openDb(file);
  db.query(
    `INSERT INTO pull_request (id, project, repo, pr_id, title, description, author_slug, source_head, target_head)
      VALUES (1, 'PROJ', 'repo', 7, 'Add the calc helpers', 'Synthetic PR.', 'author', $b, $base),
        (2, 'PROJ', 'repo', 8, 'Only neutral', '', 'author', $a, $base),
        (3, 'PROJ', 'gone', 9, 'No cache', '', 'author', $a, $base)`,
  ).run({ a: h.a, b: h.b, base: h.base });
  const issue = { key: "EVAL-9", summary: "Calc helpers", status: "Open", description: "Add v1 to v40.", comments: [], commentsTotal: 0 };
  db.run("INSERT INTO pr_task (pr, key, source, url, ord) VALUES (1, 'EVAL-9', 'branch', NULL, 0)");
  db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES (1, 'EVAL-9', 'jira', $json, 1)").run({
    json: JSON.stringify({ ...issue, truncated: false }),
  });
  let keys = 0;
  const run = (pr: number, head: string, base: string | null, status = "completed") =>
    (
      db
        .query(
          `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, merge_base, status, started_at)
          VALUES ($pr, 'review', 'general', '', $key, $head, $base, $mb, $status, $started) RETURNING id`,
        )
        .get({ pr, key: `k${keys++}`, head, base: h.base, mb: base, status, started: RUN_START }) as { id: number }
    ).id;
  // A finding as judge.ts stores it: the body column starts as the body of the payload. edited: the body column after your edit.
  const item = (r: number, status: string, lines: [number, number], p: Record<string, unknown> = {}, edited?: string) => {
    const payload = {
      severity: "minor",
      module: "core",
      category: "logic",
      title: `Title ${lines[0]}`,
      trigger: `Trigger ${lines[0]}`,
      body: `Body ${lines[0]}`,
      ...p,
    };
    return (
      db
        .query(
          `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status)
          VALUES ($run, 'finding', $payload, $body, $path, 'new', $line, $end, $status) RETURNING id`,
        )
        .get({
          run: r,
          payload: JSON.stringify(payload),
          body: edited ?? payload.body,
          path: PATH,
          line: lines[0],
          end: lines[1],
          status,
        }) as { id: number }
    ).id;
  };
  const comment = (
    id: number,
    o: {
      author?: string;
      name?: string;
      login?: string;
      parent?: number;
      anchor?: object | null;
      resolved?: boolean;
      resolvedAt?: number;
      text?: string;
      at?: number;
      updated?: number;
      deleted?: boolean;
      pr?: number;
    },
  ) =>
    db
      .query(
        `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, author_name, author_login, text, anchor_json,
          thread_resolved, thread_resolved_at, created_at, updated_at, tombstoned_at)
        VALUES ($pr, $id, 0, $parent, $root, $author, $name, $login, $text, $anchor, $resolved, $resolvedAt, $at, $updated, $deleted)`,
      )
      .run({
        id,
        parent: o.parent ?? null,
        root: o.parent ?? id,
        author: o.author ?? "me",
        name: o.name ?? null,
        login: o.login ?? null,
        text: o.text ?? "t",
        anchor: o.anchor === null ? null : JSON.stringify(o.anchor ?? {}),
        resolved: o.resolved ? 1 : 0,
        resolvedAt: o.resolvedAt ?? null,
        at: o.at ?? 1,
        updated: o.updated ?? o.at ?? 1,
        deleted: o.deleted ? 1 : null,
        pr: o.pr ?? 1,
      });
  const anchor = (lineNo: number | undefined, toHash = h.a, orphaned = false) => ({
    path: PATH,
    ...(lineNo !== undefined && { line: lineNo, lineType: "ADDED", fileType: "TO" }),
    diffType: "EFFECTIVE",
    fromHash: h.base,
    toHash,
    orphaned,
  });

  const r1 = run(1, h.a, h.base);
  const r2 = run(1, h.a, h.base);
  const r3 = run(1, h.b, h.base);
  const failed = run(1, h.a, h.base, "failed");
  run(1, h.a, null);
  const ids = {
    posted: item(r1, "posted", [10, 11], { severity: "major", category: "Security" }, EDITED),
    notBug: item(r1, "discarded", [30, 30], { discardReason: { code: "bug" } }),
    intended: item(r1, "discarded", [5, 5], { discardReason: { code: "intended" } }),
    worth: item(r1, "discarded", [15, 15], { discardReason: { code: "worth" } }),
    refuted: item(r1, "discarded", [20, 20], { discardedBy: "verify", verify: { verdict: "refuted" } }),
    noReason: item(r1, "discarded", [25, 25]),
    restored: item(r1, "posted", [2, 2], { verify: { verdict: "refuted" } }),
    carried: item(r1, "discarded", [35, 35]),
    fixed: item(r1, "discarded", [38, 38], { fixed: { id: 1, commit: "c", short: "c", was: "new" } }),
    open: item(r1, "new", [39, 39]),
    // Head B changes line 20, so this finding stays at head A.
    session: item(r1, "new", [20, 20], { session: { run: 1, verdict: "accept", reason: "r", replaced: [] } }),
    sessionDiscarded: item(r1, "discarded", [40, 40], { session: { run: 1, verdict: "accept", reason: "r", replaced: [] } }),
    withdrawn: item(r1, "posted", [6, 6]),
    clashPosted: item(r1, "posted", [33, 33]),
    clashTrap: item(r1, "discarded", [27, 27], { discardReason: { code: "bug" } }),
    clashIntended: item(r2, "discarded", [33, 34], { discardReason: { code: "intended" } }),
    // A finding of prompt version 1 has no title, trigger, or category.
    second: item(r2, "posted", [12, 12], { severity: "blocker", title: undefined, trigger: undefined, category: undefined }),
    // Head B changes line 37, so this finding stays at head A.
    changed: item(r2, "posted", [37, 37]),
    copy: 0,
    onlyB: 0,
  };
  // A revision of a finding is no finding. A finding of a failed run counts nowhere.
  item(r2, "discarded", [12, 12], { revises: ids.second });
  item(failed, "posted", [1, 1]);
  ids.copy = item(r3, "posted", [35, 35], {
    severity: "major",
    title: "Title of the copy",
    carried: { from: ids.carried, verdict: "open", reason: "", since: h.a },
  });
  ids.onlyB = item(r3, "posted", [3, 3]);
  // Only extras: no case. A repository without a cache copy: missing commits.
  item(run(2, h.a, h.base), "discarded", [15, 15], { discardReason: { code: "worth" } });
  item(run(3, h.a, h.base), "posted", [10, 10]);

  comment(100, { anchor: anchor(22), text: MINE_TEXT });
  // Another reviewer: open on an unchanged line, so no must-find.
  comment(101, { author: "other", anchor: anchor(24) });
  // Another reviewer: a resolved thread on the lines of the session bug, so no second must-find. An orphaned anchor. Head B changes
  // lines 18 and 20, so neither carries.
  comment(108, { author: "other", anchor: anchor(20), resolved: true });
  comment(109, { author: "other", anchor: anchor(18, h.a, true), text: OTHER_TEXT });
  // Left out: the PR author, a file comment without a line, and a head with no review.
  comment(110, { author: "author", anchor: anchor(13), resolved: true, resolvedAt: 1 });
  comment(111, { author: "other", anchor: anchor(undefined), resolved: true });
  comment(112, { author: "other", anchor: anchor(3, "f".repeat(40)), resolved: true });
  // A general comment has no anchor. The query skips it, so no count moves.
  comment(113, { author: "other", anchor: null, resolved: true });
  comment(102, { anchor: anchor(22, "f".repeat(40)) });
  comment(103, { anchor: anchor(10) });
  db.query(
    `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, remote_id, created_at, updated_at)
      VALUES (1, $run, 'inline', 'p1', 'b', '{}', $items, 'confirmed', 103, 1, 1)`,
  ).run({ run: r1, items: JSON.stringify([{ id: ids.posted, revision: 0 }]) });
  // You posted the reply of a discuss run that withdrew the posted finding at line 6.
  comment(107, { anchor: anchor(6) });
  db.query(
    `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, remote_id, created_at, updated_at)
      VALUES (1, $run, 'inline', 'p2', 'b', '{}', $items, 'confirmed', 107, 1, 1)`,
  ).run({ run: r1, items: JSON.stringify([{ id: ids.withdrawn, revision: 0 }]) });
  const talk = (
    db
      .query(
        `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, started_at)
        VALUES (1, 'discuss', 'general', '', 'talk', $head, $base, 'completed', 1) RETURNING id`,
      )
      .get({ head: h.a, base: h.base }) as { id: number }
  ).id;
  const reply = (judgement: string, thread: number) =>
    db
      .query(
        `INSERT INTO review_item (run, kind, payload_json, body, status, thread) VALUES ($run, 'reply', $payload, 'You are right.', 'posted', $thread)`,
      )
      .run({ run: talk, thread, payload: JSON.stringify({ thread, action: "reply", origin: "discuss", judgement }) });
  reply("settled", 107);
  // A discuss reply without the withdrawn judgement keeps the posted finding a bug.
  reply(null as unknown as string, 103);
  comment(104, { parent: 100, anchor: null });
  comment(105, { anchor: anchor(undefined) });
  // Your comment on the Not a bug finding at line 27: opposite decisions.
  comment(106, { anchor: anchor(27) });
  // Thread rows of review-ideas.md idea 2. Replies and general comments change no must-find count. The names are synthetic.
  comment(130, { author: "zelda-quux", name: "Zelda Quux", login: "zquux", parent: 101, anchor: null, text: THREAD_TEXT });
  comment(131, { name: "Moe Mine", parent: 101, anchor: null, text: "Your own reply." });
  comment(132, { author: "yuri-late", parent: 101, anchor: null, text: "After the head.", at: 2_000_000_000_000 });
  comment(133, { author: "xena-long", anchor: null, text: "x".repeat(5000) });
  comment(134, { author: "zelda-quux", anchor: null, text: "Deleted.", deleted: true });
  comment(135, { author: "author", parent: 101, anchor: null, text: "The PR owner says it is fine." });
  comment(136, { author: "zelda-quux", parent: 100, anchor: null, text: "A reply in your thread." });
  // After the head commit time and before the run start: in the case. The names come from a comment of another PR.
  comment(137, { author: "other", anchor: null, text: NOTE_TEXT, at: RUN_START - 1 });
  comment(150, { author: "olga-far", name: "Olga Far", pr: 2, anchor: null, text: "On another PR." });
  // A reply edited at the run start: out.
  comment(138, { author: "other", parent: 101, anchor: null, text: "Edited later.", updated: RUN_START });
  // A deleted root with a live reply: in the case, without the root text.
  comment(139, { author: "wanda-gone", anchor: null, text: "Deleted root.", deleted: true });
  comment(140, { author: "other", parent: 139, anchor: null, text: "Still open." });
  // An open comment on an unchanged line, numbered on the old side (Gate v3 U4).
  comment(141, { author: "other", anchor: { ...anchor(undefined), line: 36, lineType: "CONTEXT", fileType: "FROM" } });
  db.close();
  return { file, ids };
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

let heads: Heads;
let cache: string;
let dbDir: string;
let dbFile: string;
let dbHash: string;
let ids: ReturnType<typeof makeDb>["ids"];
let OUT: string;
let built: { code: number; stdout: string; stderr: string };
const caseOf = (head: string): LocalCaseFile => {
  const id = `pr1-${head.slice(0, 12)}-${heads.base.slice(0, 8)}`;
  return JSON.parse(readFileSync(join(OUT, "cases", id, "case.json"), "utf8")) as LocalCaseFile;
};
const ofItem = (id: number) => `item-${id}`;

beforeAll(async () => {
  console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/local.ts", import.meta.dir)}`);
  const repo = await makeCache(temp("cache"));
  heads = repo;
  cache = repo.cache;
  dbDir = temp("copy");
  const db = makeDb(dbDir, heads);
  dbFile = db.file;
  ids = db.ids;
  dbHash = sha256(dbFile);
  OUT = join(temp("set"), "eval-local");
  built = await bun([LOCAL, "--db", dbFile, "--cache", cache, "--out", OUT]);
}, SLOW);

describe("eval:local selection", () => {
  test("builds two cases and prints counts only", () => {
    expect(built.stderr).toBe("");
    expect(built.code).toBe(0);
    expect(built.stdout).toContain("Local eval set: 2 cases from 3 review runs in 1 repositories.");
    expect(built.stdout).toContain("Must find: 14 findings and 1 of your own comments. Must not raise: 6. Neutral: 3.");
    expect(built.stdout).toContain(
      "Sources before carry: 9 posted, 1 covered by a fix commit, 1 accepted by your session, 1 posted and then withdrawn in the thread (must not raise), 2 line comments of other reviewers that are resolved or on a changed line.",
    );
    expect(built.stdout).toContain(
      "Comments of other reviewers left out: 2 open on an unchanged line, 1 without a line, 1 at a head with no review, 1 by the PR author, 1 on the lines of a must find of the same case.",
    );
    expect(built.stdout).toContain(
      "Left out: 1 refuted by the check, 0 discarded without your triage, 1 without a decision, 0 without an anchor, 4 in opposite decisions, 1 runs without a merge base, 1 cases with missing commits, 1 cases with nothing to find or avoid, 1 comments without a line, 1 comments at a head with no review.",
    );
    expect(built.stdout).toContain(
      "Carried from earlier heads of the same PR: 7. Not carried: 3 with changed lines, 0 in a deleted file, 1 on an item of the later head.",
    );
    expect(built.stdout).toContain("below the recommended minimum");
    for (const name of [TMP, OUT, "PROJ", "Add the calc helpers", "EVAL-9"]) expect(built.stdout).not.toContain(name);
    const m = JSON.parse(readFileSync(join(OUT, "MANIFEST.json"), "utf8")) as Manifest;
    expect(m.counts).toEqual({ cases: 2, runs: 3, repositories: 1, bugs: 14, traps: 6, extras: 3, human: 1 });
    expect(m.sources).toEqual({ posted: 9, fixed: 1, session: 1, withdrawn: 1, other: 2 });
    expect(m.carried).toEqual({ carried: 7, changed: 3, gone: 0, overlap: 1 });
    expect(readdirSync(join(OUT, "bundles"))).toHaveLength(1);
    // run.ts gives the same fingerprint for a run of the whole set.
    const loaded = loadCases("all", join(OUT, "cases"));
    expect(setFingerprint(loaded.flatMap((c) => (c.local ? [{ id: c.id, hash: c.local.hash }] : [])))).toBe(m.fingerprint);
  });

  test("a posted finding is a bug at its anchor with the posted severity", () => {
    const a = caseOf(heads.a);
    expect(a.bugs.map((b) => [b.id, b.lines, b.severityMin])).toEqual([
      [ofItem(ids.posted), [10, 11], "major"],
      [ofItem(ids.restored), [2, 2], "minor"],
      // The decision on a carried finding is on its copy: posted at head B with severity major.
      [ofItem(ids.carried), [35, 35], "major"],
      // A fix commit covered it, and your session accepted the other one.
      [ofItem(ids.fixed), [38, 38], "minor"],
      [ofItem(ids.session), [20, 20], "minor"],
      [ofItem(ids.second), [12, 12], "blocker"],
      [ofItem(ids.changed), [37, 37], "minor"],
      ["comment-109", [18, 18], "minor"],
    ]);
    const notes = new Map(a.bugs.map((b) => [b.id, b.note]));
    expect(notes.get(ofItem(ids.fixed))).toBe(`Finding ${ids.fixed} covered by a fix commit.`);
    expect(notes.get(ofItem(ids.session))).toBe(`Finding ${ids.session} accepted by your session.`);
    expect(a.bugs.every((b) => b.path === PATH && b.side === "new" && b.carriedFrom === undefined)).toBe(true);
  });

  test("a later head of the PR gets the bugs and traps whose lines still hold, and never the other way", () => {
    const b = caseOf(heads.b);
    expect(b.bugs.map((x) => [x.id, x.lines, x.carriedFrom ?? null])).toEqual([
      [ofItem(ids.copy), [35, 35], null],
      [ofItem(ids.onlyB), [3, 3], null],
      [ofItem(ids.posted), [10, 11], heads.a],
      [ofItem(ids.restored), [2, 2], heads.a],
      // ids.carried overlaps its own copy at head B: one item. ids.changed: head B changes line 37.
      // ids.session: head B changes line 20.
      [ofItem(ids.fixed), [38, 38], heads.a],
      [ofItem(ids.second), [12, 12], heads.a],
    ]);
    expect(b.traps.map((x) => [x.id, x.lines, x.carriedFrom ?? null])).toEqual([
      [ofItem(ids.notBug), [30, 30], heads.a],
      [ofItem(ids.intended), [5, 5], heads.a],
      [ofItem(ids.withdrawn), [6, 6], heads.a],
    ]);
    // Neither extras nor your comments move.
    expect(b.extras).toEqual([]);
    expect(b.human).toEqual([]);
    expect(caseOf(heads.a).bugs.map((x) => x.id)).not.toContain(ofItem(ids.onlyB));
  });

  test("Not a bug, Intended, and a posted finding that you withdrew in its thread become traps", () => {
    const a = caseOf(heads.a);
    expect(a.traps.map((t) => [t.id, t.lines])).toEqual([
      [ofItem(ids.notBug), [30, 30]],
      [ofItem(ids.intended), [5, 5]],
      [ofItem(ids.withdrawn), [6, 6]],
    ]);
    expect(a.bugs.map((b) => b.id)).not.toContain(ofItem(ids.withdrawn));
  });

  test("Not worth fixing and a discard without a reason are neutral extras, also after a session accept", () => {
    expect(caseOf(heads.a).extras.map((x) => x.lines)).toEqual([
      [15, 15],
      [25, 25],
      [40, 40],
    ]);
  });

  test("a refuted finding that you never restored is left out, and a restored one counts", () => {
    const a = caseOf(heads.a);
    expect([...a.bugs, ...a.traps].map((x) => x.id)).not.toContain(ofItem(ids.refuted));
    expect(a.extras.some((x) => x.note.includes(`finding ${ids.refuted}.`))).toBe(false);
    expect(a.bugs.map((b) => b.id)).toContain(ofItem(ids.restored));
  });

  test("opposite decisions on overlapping lines drop both", () => {
    const a = caseOf(heads.a);
    const all = [...a.bugs, ...a.traps, ...a.human].map((x) => x.lines[0]);
    for (const l of [27, 33]) expect(all).not.toContain(l);
  });

  test("two runs on one head make one case", () => {
    const a = caseOf(heads.a);
    // ids.posted comes from the first run, ids.second from the second.
    expect(a.bugs.map((b) => b.id)).toEqual(expect.arrayContaining([ofItem(ids.posted), ofItem(ids.second)]));
    expect(readdirSync(join(OUT, "cases")).sort()).toEqual(
      [heads.a, heads.b].map((h) => `pr1-${h.slice(0, 12)}-${heads.base.slice(0, 8)}`).sort(),
    );
  });

  test("a line comment of another reviewer is a must-find when its thread is resolved or a later head changed its line", () => {
    const a = caseOf(heads.a);
    const spot = { path: PATH, side: "new", severityMin: "minor", module: "core", source: "other" } as const;
    expect(a.bugs.filter((b) => b.source === "other")).toEqual([
      {
        id: "comment-109",
        ...spot,
        lines: [18, 18],
        note: "Comment 109 of another reviewer, on a line that a later head changed.",
        text: `${`eval-reviewer says ${"z".repeat(2500)}`.slice(0, THREAD_TEXT_MAX)}
[The eval builder cut this comment.]`,
      },
    ]);
    // One defect is one must-find: comment 108 is on the lines of the session bug.
    expect(a.bugs.map((b) => b.id)).not.toContain("comment-108");
    // The open comment 101, the PR author, and the file comment stay out.
    for (const id of ["comment-101", "comment-110", "comment-111", "comment-112", "comment-113"])
      expect([...a.bugs, ...a.human].map((x) => x.id)).not.toContain(id);
    expect(caseOf(heads.b).bugs.filter((b) => b.source === "other")).toEqual([]);
  });

  test("each plain case states the must-find rules, so a new rule gives a new set fingerprint", () => {
    expect([caseOf(heads.a).rules, caseOf(heads.b).rules]).toEqual([5, 5]);
  });

  test("a case holds the threads of other people when its run started, with placeholders for the names of the database's people", () => {
    const a = caseOf(heads.a);
    const t = a.threads ?? [];
    // Roots 101, 110, 111, 112, 113, 133, 139, 141, and 137 with replies 130, 135, and 140. Comment 109 is a must-find of the case.
    // Comment 108 is on the lines of the session bug. Your comments, the reply after the run start, the reply edited at the run start,
    // the deleted comment without replies, and the reply in your thread stay out.
    expect(t.map((c) => [c.id, c.root, c.author, c.path ?? null, c.side ?? null, c.lines ?? null, c.resolved ?? false])).toEqual([
      [1, 1, "reviewer-1", PATH, "new", [24, 24], false],
      // The thread is resolved, and its resolved time is before the run start.
      [2, 2, "eval-author", PATH, "new", [13, 13], true],
      [3, 3, "reviewer-1", PATH, null, null, false],
      // Its anchor head is not in the cache, so its lines do not map.
      [4, 4, "reviewer-1", PATH, null, null, false],
      [5, 5, "reviewer-1", null, null, null, false],
      [6, 1, "reviewer-2", null, null, null, false],
      [7, 7, "reviewer-3", null, null, null, false],
      [8, 1, "eval-author", null, null, null, false],
      [9, 9, "reviewer-4", null, null, null, false],
      [10, 9, "reviewer-1", null, null, null, false],
      [11, 11, "reviewer-1", PATH, "old", [36, 36], false],
      // After the head commit time and before the run start.
      [12, 12, "reviewer-1", null, null, null, false],
    ]);
    expect(t[5]?.text).toBe(CLEAN_TEXT);
    expect(t[6]?.text).toBe(`${"x".repeat(2000)}\n[The eval builder cut this comment.]`);
    expect([t[8]?.deleted, t[8]?.text, t[9]?.text]).toEqual([true, "", "Still open."]);
    expect([t[10]?.lineType, t[10]?.newPlace]).toEqual(["CONTEXT", { path: PATH, lines: [36, 36] }]);
    expect(t[11]?.text).toBe(NOTE_CLEAN);
    const text = JSON.stringify(a.threads);
    for (const name of REAL) expect(text).not.toContain(name);
    // Head B: comment 109 is no must-find there, and comment 108 is on no must-find. Head B changes lines 18 and 20, so threads 108 and
    // 109 lose their lines.
    const b = caseOf(heads.b).threads ?? [];
    expect(b.filter((c) => c.id === c.root).map((c) => [c.path ?? null, c.lines ?? null])).toEqual([
      [PATH, [24, 24]],
      [PATH, null],
      [PATH, null],
      [PATH, [13, 13]],
      [PATH, null],
      [PATH, null],
      [null, null],
      [null, null],
      [null, null],
      [PATH, [36, 36]],
      [null, null],
    ]);
    const m = JSON.parse(readFileSync(join(OUT, "MANIFEST.json"), "utf8")) as Manifest;
    expect(m.threads).toEqual({
      cases: 2,
      threads: 20,
      comments: 26,
      capped: 0,
      unplaced: 4,
      mineRoot: 2,
      overlap: 1,
      edited: 2,
      earlier: 0,
    });
    expect(built.stdout).toContain(
      "PR threads of other people at the reviewed heads: 20 threads with 26 comments in 2 cases. Left out: 0 comments over the cap of 60 per case, 2 replies in threads that you started, 1 threads on the lines of a must find, 2 comments edited from the run start on. Without lines: 4 inline threads whose lines do not map to the reviewed head. Re-review cases: 0 replies of the PR author to posted earlier findings.",
    );
    for (const name of REAL) expect(built.stdout).not.toContain(name);
  });

  test("the thread text loses every name, mention, email address, and URL host", async () => {
    const row = (id: number, slug: string, name: string | null, text = "ok", login: string | null = null): ThreadRow => ({
      pr: 1,
      id,
      root: 1,
      slug,
      login,
      name,
      text,
      anchor: null,
      excerpt: null,
      resolved: 0,
      resolvedAt: null,
      at: id,
      updated: id,
      deleted: 0,
      prAuthor: "author",
      prAuthorName: null,
    });
    const text = [
      "Zelda and Quux agree. @ghost-user, @{Olga Far}, and [~al] know. Olga too. Moe agrees.",
      "Mail zq@corp.example.invalid or see http://user@git.corp.example.invalid:7990/p.",
      // NFD accents, upper case, and a long s that the regex folds to s.
      "José Núñez and JOSÉ. José too. Koſtas too. al is a word here, but @al is a mention.",
    ].join(" ");
    const rows = [row(1, "zelda-quux", "Zelda Quux", text, "zquux"), row(2, "al", "José Núñez"), row(3, "kostas", null)];
    const people = [
      { slug: "olga-far", login: null, name: "Olga Far" },
      { slug: "me", login: null, name: "Moe Mine" },
    ];
    const out = await caseThreads(rows, { me: "me", before: 10, skip: new Set(), must: [], people, place: async () => null }, noThreads());
    expect(out[0]?.text).toBe(
      [
        // A first name alone of a person of another PR stays. This is a known limit.
        "reviewer-1 and reviewer-1 agree. @someone, @someone, and @reviewer-2 know. Olga too. eval-reviewer agrees.",
        "Mail <email> or see http://<host>/p.",
        // A name in all capitals is not the capitalized form, so it stays. This is a known limit.
        "reviewer-2 and JOSÉ. reviewer-2 too. reviewer-3 too. al is a word here, but @reviewer-2 is a mention.",
      ].join(" "),
    );
  });

  test("a single name word changes only for the people of the PR and only when capitalized", async () => {
    const row = (id: number, slug: string, name: string, text = "ok"): ThreadRow => ({
      pr: 1,
      id,
      root: 1,
      slug,
      login: null,
      name,
      text,
      anchor: null,
      excerpt: null,
      resolved: 0,
      resolvedAt: null,
      at: id,
      updated: id,
      deleted: 0,
      prAuthor: "author",
      prAuthorName: null,
    });
    const text = "Will, can you check? Mark agrees. This will mark the row. Ask Grant Chase or grant chase. Grant may help.";
    const rows = [row(1, "wmark", "Will Mark", text)];
    // A one-word display name of another PR does not change the word "mark". A lowercase full name stays too.
    const people = [
      { slug: "gchase", login: null, name: "Grant Chase" },
      { slug: "mk1", login: null, name: "Mark" },
    ];
    const out = await caseThreads(rows, { me: "me", before: 10, skip: new Set(), must: [], people, place: async () => null }, noThreads());
    expect(out[0]?.text).toBe(
      "reviewer-1, can you check? reviewer-1 agrees. This will mark the row. Ask someone or grant chase. Grant may help.",
    );
  });

  test("the thread cap keeps the newest threads", async () => {
    const row = (id: number, at: number): ThreadRow => ({
      pr: 1,
      id,
      root: id,
      slug: `person-${id % 3}`,
      login: null,
      name: null,
      text: `Comment ${id}.`,
      anchor: null,
      excerpt: null,
      resolved: 0,
      resolvedAt: null,
      at,
      updated: at,
      deleted: 0,
      prAuthor: "author",
      prAuthorName: null,
    });
    const rows = Array.from({ length: THREAD_COMMENTS_MAX + 2 }, (_, k) => row(k + 1, k + 1));
    const n = noThreads();
    const place = async () => null;
    const out = await caseThreads(rows, { me: "me", before: 1_000, skip: new Set(), must: [], people: [], place }, n);
    expect(out).toHaveLength(THREAD_COMMENTS_MAX);
    expect(out[0]?.text).toBe("Comment 3.");
    expect(n).toEqual({ ...noThreads(), cases: 1, threads: THREAD_COMMENTS_MAX, comments: THREAD_COMMENTS_MAX, capped: 2 });
    expect(new Set(out.map((c) => c.author))).toEqual(new Set(["reviewer-1", "reviewer-2", "reviewer-3"]));
  });

  test("your own root comment at a reviewed head is a must-find item", () => {
    expect(caseOf(heads.a).human).toEqual([
      { id: "comment-100", path: PATH, side: "new", lines: [22, 22], note: "Your comment 100.", text: MINE_CLEAN, source: "own" },
    ]);
    expect(caseOf(heads.b).human).toEqual([]);
  });

  test("each item has its gold text, category, and source, and no case holds a name", () => {
    const a = caseOf(heads.a);
    const b = caseOf(heads.b);
    const of = new Map([...a.bugs, ...a.traps].map((x) => [x.id, x]));
    // The title, trigger, and body. Your edit of the body wins over the text of the finder.
    expect(of.get(ofItem(ids.posted))).toMatchObject({
      text: `Title 10\n\nTrigger 10\n\n${EDITED_CLEAN}`,
      category: "Security",
      source: "posted",
    });
    // A finding of prompt version 1: the body only, and no category.
    expect([of.get(ofItem(ids.second))?.text, of.get(ofItem(ids.second))?.category]).toEqual(["Body 12", undefined]);
    // The decision on a carried finding is on its copy, so the text is of the copy too.
    expect(of.get(ofItem(ids.carried))?.text).toBe("Title of the copy\n\nTrigger 35\n\nBody 35");
    expect(a.bugs.map((x) => [x.id, x.source, x.category])).toEqual([
      [ofItem(ids.posted), "posted", "Security"],
      [ofItem(ids.restored), "posted", "logic"],
      [ofItem(ids.carried), "posted", "logic"],
      [ofItem(ids.fixed), "fixed", "logic"],
      [ofItem(ids.session), "session", "logic"],
      [ofItem(ids.second), "posted", undefined],
      [ofItem(ids.changed), "posted", "logic"],
      ["comment-109", "other", undefined],
    ]);
    // Your discards, your withdrawal, and your comment.
    expect([...a.traps, ...a.extras, ...a.human].map((x) => x.source)).toEqual(Array(7).fill("own"));
    expect(a.traps.map((x) => x.text)).toEqual([
      "Title 30\n\nTrigger 30\n\nBody 30",
      "Title 5\n\nTrigger 5\n\nBody 5",
      "Title 6\n\nTrigger 6\n\nBody 6",
    ]);
    expect(a.extras.map((x) => [x.text, x.category])).toEqual([
      ["Title 15\n\nTrigger 15\n\nBody 15", "logic"],
      ["Title 25\n\nTrigger 25\n\nBody 25", "logic"],
      ["Title 40\n\nTrigger 40\n\nBody 40", "logic"],
    ]);
    // Carried items keep their text and source.
    expect(b.bugs.find((x) => x.id === ofItem(ids.posted))).toMatchObject({
      text: `Title 10\n\nTrigger 10\n\n${EDITED_CLEAN}`,
      source: "posted",
    });
    for (const c of [a, b]) {
      const all = [...c.bugs, ...c.traps, ...c.extras, ...c.human];
      expect(all.filter((x) => !x.text || !(ITEM_SOURCES as readonly (string | undefined)[]).includes(x.source))).toEqual([]);
      for (const name of REAL) expect(JSON.stringify(c)).not.toContain(name);
    }
  });

  test("MANIFEST.json counts the findings by decision per bug class, category, and module, with no text", () => {
    const m = JSON.parse(readFileSync(join(OUT, "MANIFEST.json"), "utf8")) as Manifest;
    const zero = { posted: 0, fixed: 0, session: 0, withdrawn: 0, notBugOrIntended: 0, otherDiscard: 0, refuted: 0 };
    // All runs of the copy count, also those of a case that no build writes. A carried finding counts at each head, as in sources.
    const rest = { fixed: 1, session: 1, withdrawn: 1, notBugOrIntended: 4, otherDiscard: 4, refuted: 1 };
    expect(m.categories).toEqual({
      byClass: { security: { ...zero, posted: 1 }, other: { ...zero, ...rest, posted: 8 } },
      byCategory: { security: { ...zero, posted: 1 }, logic: { ...zero, ...rest, posted: 7 }, none: { ...zero, posted: 1 } },
      byModule: { core: { ...zero, ...rest, posted: 9 } },
    });
    expect(m.categories.byModule.core?.posted).toBe(m.sources.posted);
    // The class names follow shared/review.ts bugClass. A category of no class is "other".
    expect(BUG_CLASS_NAMES.map((name) => bugClass({ category: name }))).toEqual([0, 1, 2, 3, 4]);
    expect(readFileSync(join(OUT, "MANIFEST.json"), "utf8")).not.toContain("Title");
  });

  test("a case holds the PR text, the task rows, the commits, and the changed lines", () => {
    const a = caseOf(heads.a);
    // group: the key of the PR. hasTask: the task row has its text. 16 changed lines in one file are no large case.
    expect([a.group, a.hasTask, a.large, a.clean, caseOf(heads.b).group]).toEqual(["pr1", true, false, undefined, "pr1"]);
    expect(a.pr).toEqual({ title: "Add the calc helpers", description: "Synthetic PR." });
    expect(a.tasks.map((t) => [t.key, t.source, JSON.parse(t.json ?? "{}").description])).toEqual([["EVAL-9", "branch", "Add v1 to v40."]]);
    expect(a.bundle).toMatchObject({ base: heads.base, head: heads.a });
    expect(a.changedLines).toBe(2 * A_LINES.size);
    const [loaded] = loadCases(a.id, join(OUT, "cases"));
    expect(loaded?.local).toMatchObject({ base: heads.base, head: heads.a });
  });

  test("the copies stay unchanged: same database bytes, no new file beside them", () => {
    expect(sha256(dbFile)).toBe(dbHash);
    expect(readdirSync(dbDir).sort()).toEqual(["config.json", "db-test.sqlite"]);
  });
});

describe("eval:local refusals", () => {
  test(
    "an --out folder in the live data folder is refused, and a data folder without baseUrl needs --db",
    async () => {
      const r = await bun([LOCAL, "--db", dbFile, "--cache", cache, "--out", join(LIVE, "eval")]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Refused: --out is inside the live data folder of the app");
      // The app default folder stays live while REVIEW_LOOP_DATA_DIR names another folder (config.ts dataDir).
      if (process.platform !== "darwin") {
        const d = await bun([LOCAL, "--db", dbFile, "--cache", cache, "--out", join(APPDATA, "review-loop", "eval")]);
        expect(d.code).toBe(2);
        expect(d.stderr).toContain("Refused: --out is inside the live data folder");
      }
      const none = await bun([LOCAL]);
      expect(none.code).toBe(2);
      expect(none.stderr).toContain("config.json has no baseUrl");
      expect(readdirSync(LIVE)).toEqual([]);
    },
    SLOW,
  );

  test(
    "eval-local/ is git-ignored, and an --out folder in the repository that git does not ignore is refused",
    async () => {
      const env = gitEnv(join(temp("git"), "none"));
      await git(["-C", ROOT, "check-ignore", "-q", "--", "eval-local/MANIFEST.json"], { env });
      await git(["-C", ROOT, "check-ignore", "-q", "--", "eval-local/cases/x/case.json"], { env });
      const out = join(ROOT, "scripts", "eval", `out-${process.pid}`);
      const r = await bun([LOCAL, "--db", dbFile, "--cache", cache, "--out", out]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("git does not ignore it");
      expect(existsSync(out)).toBe(false);
      // A folder named eval-local in the repository builds. Its own parent keeps a set of the user in eval-local/ untouched.
      const parent = join(ROOT, `.eval-local-test-${process.pid}`);
      try {
        const ok = await bun([LOCAL, "--db", dbFile, "--cache", cache, "--out", join(parent, "eval-local")]);
        expect(ok.stderr).toBe("");
        expect(ok.code).toBe(0);
        expect(existsSync(join(parent, "eval-local", "MANIFEST.json"))).toBe(true);
      } finally {
        rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    SLOW,
  );

  test("an --out folder with other files is refused and kept", async () => {
    const out = temp("busy");
    writeFileSync(join(out, "notes.txt"), "mine");
    const r = await bun([LOCAL, "--db", dbFile, "--cache", cache, "--out", out]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("holds other files");
    expect(readdirSync(out)).toEqual(["notes.txt"]);
  });

  test("--clean takes a whole number only", async () => {
    for (const bad of ["x", "1.5", ""]) {
      const r = await bun([LOCAL, "--db", dbFile, "--cache", cache, "--out", temp("bad-clean"), "--clean", bad]);
      expect([bad, r.code]).toEqual([bad, 2]);
      expect(r.stderr).toContain("--clean must be a whole number");
    }
  });
});

// ---------- Clean cases ----------

// The PRs of the clean rule (docs/plans/review-v2/review-quality-2026.md E1). Each comment names the expected result.
function makeCleanDb(dir: string, h: Heads) {
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ baseUrl: "https://bitbucket.example.invalid", userSlug: "me", notifications: false }),
  );
  const file = join(dir, "db-clean.sqlite");
  const db = openDb(file);
  const pr = (id: number, state: string, head: string) =>
    db
      .query(
        `INSERT INTO pull_request (id, project, repo, pr_id, title, description, author_slug, state, source_head, target_head)
        VALUES ($id, 'PROJ', 'repo', $id, $title, '', 'author', $state, $head, $base)`,
      )
      .run({ id, title: `PR ${id}`, state, head, base: h.base });
  let keys = 0;
  const run = (p: number, head: string, base = h.base) =>
    (
      db
        .query(
          `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, merge_base, status, started_at)
          VALUES ($pr, 'review', 'general', '', $key, $head, $base, $base, 'completed', $started) RETURNING id`,
        )
        .get({ pr: p, key: `c${keys++}`, head, base, started: RUN_START }) as { id: number }
    ).id;
  const item = (r: number, status: string, line: number, p: Record<string, unknown> = {}) =>
    db
      .query(
        `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status)
        VALUES ($run, 'finding', $payload, 'b', $path, 'new', $line, $line, $status)`,
      )
      .run({ run: r, payload: JSON.stringify({ severity: "minor", module: "core", body: "b", ...p }), path: PATH, line, status });
  const comment = (id: number, p: number, author: string, toHash: string, orphaned = false) =>
    db
      .query(
        `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, text, anchor_json, thread_resolved, created_at,
          updated_at) VALUES ($pr, $id, 0, NULL, $id, $author, 't', $anchor, 0, 1, 1)`,
      )
      .run({
        pr: p,
        id,
        author,
        anchor: JSON.stringify({ path: PATH, line: 24, lineType: "ADDED", fileType: "TO", fromHash: h.base, toHash, orphaned }),
      });
  // 1: merged at head B. Head A had a later push, so it is no clean case. Head B: a clean case with its neutral extra. Its task row
  // has no text.
  pr(1, "MERGED", h.b);
  run(1, h.a);
  item(run(1, h.b), "discarded", 15, { discardReason: { code: "worth" } });
  db.run("INSERT INTO pr_task (pr, key, source, url, ord) VALUES (1, 'EVAL-1', 'branch', NULL, 0)");
  // 2: open, so no clean case.
  pr(2, "OPEN", h.a);
  run(2, h.a);
  // 3: an open line comment of another reviewer at the head.
  pr(3, "MERGED", h.a);
  run(3, h.a);
  comment(300, 3, "other", h.a);
  // 4: a posted finding at head A carries to head B. Both are plain cases.
  pr(4, "MERGED", h.b);
  item(run(4, h.a), "posted", 2);
  run(4, h.b);
  // 5: opposite decisions on one line drop both, but the head had a decision.
  pr(5, "MERGED", h.a);
  item(run(5, h.a), "posted", 10);
  item(run(5, h.a), "discarded", 10, { discardReason: { code: "bug" } });
  // 6: a comment of another reviewer at head A that the push to head B did not orphan, so it is on the code of head B.
  pr(6, "MERGED", h.b);
  run(6, h.a);
  run(6, h.b);
  comment(600, 6, "other", h.a);
  // 7: merged at head C, which adds 30 files. A comment of the PR author does not count. A clean and large case.
  pr(7, "MERGED", h.c);
  run(7, h.c);
  comment(700, 7, "author", h.c);
  // 8: two merge bases at the last head: one candidate, from the newest run. --clean 2 leaves it out: its runs are the newest.
  pr(8, "MERGED", h.b);
  run(8, h.b);
  run(8, h.b, h.a);
  // 9: merged at head B, but the only review is at head A, which had a later push.
  pr(9, "MERGED", h.b);
  run(9, h.a);
  db.close();
  return file;
}

describe("eval:local clean cases", () => {
  let out: string;
  let built: { code: number; stdout: string; stderr: string };
  const at = (p: number, head: string, base: string) => `pr${p}-${head.slice(0, 12)}-${base.slice(0, 8)}`;
  beforeAll(async () => {
    out = join(temp("clean"), "eval-local");
    built = await bun([LOCAL, "--db", makeCleanDb(temp("clean-copy"), heads), "--cache", cache, "--out", out, "--clean", "2"]);
  }, SLOW);

  test("a clean case comes only from a merged PR at its last head, with nothing to find and no comment on its code", () => {
    expect(built.stderr).toBe("");
    expect(built.code).toBe(0);
    expect(built.stdout).toContain(
      "Clean cases: 2 of 3 heads of merged PRs with nothing to find, no comment, and no later push (--clean 2).",
    );
    const m = JSON.parse(readFileSync(join(out, "MANIFEST.json"), "utf8")) as Manifest;
    expect(m.clean).toEqual({ asked: 2, candidates: 3, cases: 2 });
    expect(m.counts.cases).toBe(4);
    // Heads with nothing to find that the build leaves out: 1 A, 2, 3, 5, 6 A and B, both merge bases of 8, and 9.
    expect(m.skipped.emptyCases).toBe(9);
    const cases = loadCases("all", join(out, "cases"));
    expect(cases.map((c) => [c.id, c.clean ?? false]).sort()).toEqual(
      [
        [at(1, heads.b, heads.base), true],
        [at(4, heads.a, heads.base), false],
        [at(4, heads.b, heads.base), false],
        [at(7, heads.c, heads.base), true],
      ].sort(),
    );
    const one = cases.find((c) => c.id === at(1, heads.b, heads.base));
    expect(one).toMatchObject({ bugs: [], traps: [], human: [], group: "pr1", hasTask: false, large: false, rules: 5 });
    expect(one?.extras?.map((x) => [x.lines, x.source])).toEqual([[[15, 15], "own"]]);
    expect(one?.tasks?.map((t) => t.json)).toEqual([null]);
    expect(cases.find((c) => c.id === at(7, heads.c, heads.base))).toMatchObject({ bugs: [], group: "pr7", large: true });
  });
});

describe("eval:threads check", () => {
  test("only completed runs count, and only a case with a thread that has lines counts as a case with threads", () => {
    const bug = { id: "b", path: PATH, side: "new", lines: [30, 30], severityMin: "major", module: "core", note: "n" } as const;
    const r = {
      volume: null,
      tolerance: 0,
      cases: [
        { id: "lines", bugs: [bug] },
        { id: "file", bugs: [bug] },
      ],
      runs: [
        { case: "lines", status: "completed", items: [] },
        { case: "lines", status: "failed", items: [] },
        { case: "file", status: "cancelled", items: [] },
      ],
    } as unknown as EvalResult;
    const threads = new Map([
      [
        "lines",
        [
          {
            id: 1,
            root: 1,
            author: "reviewer-1",
            at: 1,
            text: "t",
            path: PATH,
            side: "old" as const,
            lines: [5, 5] as [number, number],
            lineType: "CONTEXT" as const,
            newPlace: { path: PATH, lines: [25, 25] as [number, number] },
          },
        ],
      ],
      ["file", [{ id: 1, root: 1, author: "reviewer-1", at: 1, text: "t", path: PATH }]],
    ]);
    // The CONTEXT root is near the new-side bug through its new-side lines only.
    expect(threadCheck(r, threads)).toEqual({
      runs: 1,
      notCompleted: 2,
      cases: 2,
      withThreads: 1,
      missed: 1,
      missedNear: 1,
      found: 0,
      foundNear: 0,
    });
  });
});

// ---------- Carry to later heads ----------

describe("eval:local carry", () => {
  const H1 = "1".repeat(40);
  const H2 = "2".repeat(40);
  const BASE = "b".repeat(40);
  const bug = (id: string, path: string, lines: [number, number]) =>
    ({ id, path, side: "new", lines, severityMin: "minor", module: "core", note: "n" }) as const;
  const draft = (head: string, first: number, o: Partial<Draft> = {}): Draft => ({
    pr: 1,
    head,
    base: BASE,
    runs: 1,
    first,
    last: first,
    bugs: [],
    traps: [],
    extras: [],
    human: [],
    ...o,
  });
  // H1 to H2: x.ts becomes z.ts with one line added after line 1 and line 9 changed. y.ts is deleted.
  const DIFF = [
    "diff --git a/x.ts b/z.ts",
    "similarity index 90%",
    "rename from x.ts",
    "rename to z.ts",
    "--- a/x.ts",
    "+++ b/z.ts",
    "@@ -1,0 +2 @@",
    "+added",
    "@@ -9 +10 @@",
    "-old",
    "+new",
    "diff --git a/y.ts b/y.ts",
    "deleted file mode 100644",
    "--- a/y.ts",
    "+++ /dev/null",
    "@@ -1,3 +0,0 @@",
    "-a",
    "-b",
    "-c",
    "",
  ].join("\n");
  const diff = async (from: string, to: string) => (from === H1 && to === H2 ? parseDiff(DIFF) : []);

  test("an item moves through a rename, and stays behind on changed lines or a deleted file", async () => {
    const from = draft(H1, 1, {
      bugs: [bug("moved", "x.ts", [5, 6]), bug("changed", "x.ts", [9, 9])],
      traps: [{ id: "gone", path: "y.ts", side: "new", lines: [2, 2], why: "w" }],
    });
    const to = draft(H2, 2);
    expect(await carry([from, to], diff)).toEqual({ carried: 1, changed: 1, gone: 1, overlap: 0 });
    expect(to.bugs).toEqual([{ ...bug("moved", "z.ts", [6, 7]), carriedFrom: H1 }]);
    expect(to.traps).toEqual([]);
  });

  test("nothing goes to an earlier head or another PR, and the newest decision on a place wins", async () => {
    const earlier = draft(H1, 1, { bugs: [bug("e", "a.ts", [1, 1])] });
    // Its run is between the runs of the earlier case: no order.
    const mixed = draft(H1, 2, { base: "c".repeat(40), last: 2 });
    earlier.last = 3;
    const other = draft(H2, 4, { pr: 2 });
    const later = draft(H2, 5, { traps: [{ id: "own", path: "a.ts", side: "new", lines: [1, 2], why: "w" }] });
    const last = draft(H2, 6, { base: "d".repeat(40) });
    // The trap of H2 goes to the last case. The bug of H1 meets that trap there and the own trap of the later case.
    expect(await carry([last, later, other, mixed, earlier], diff)).toEqual({ carried: 1, changed: 0, gone: 0, overlap: 2 });
    expect([mixed.bugs, other.bugs, later.bugs, last.bugs]).toEqual([[], [], [], []]);
    expect(last.traps).toEqual([{ id: "own", path: "a.ts", side: "new", lines: [1, 2], why: "w", carriedFrom: H2 }]);
    // A carried bug alone in a later case.
    const solo = draft(H2, 7);
    expect(await carry([earlier, solo], diff)).toEqual({ carried: 1, changed: 0, gone: 0, overlap: 0 });
    expect(solo.bugs).toEqual([{ ...bug("e", "a.ts", [1, 1]), carriedFrom: H1 }]);
  });
});

// ---------- Score, compare, and rescore ----------

const item = (o: Partial<EvalItem> & Pick<EvalItem, "line" | "lineEnd">): EvalItem => ({
  path: "a.ts",
  side: "new",
  anchorState: "exact",
  severity: "major",
  finderSeverity: "major",
  verdict: null,
  check: null,
  group: "main",
  status: "new",
  title: "",
  body: "A finding.",
  category: "logic",
  module: null,
  trigger: null,
  confidence: "high",
  evidenceStatus: "code",
  agent: null,
  ...o,
});
const run = (items: EvalItem[]): CaseRun => ({
  case: "l",
  repeat: 1,
  run: 1,
  status: "completed",
  errorKind: null,
  error: null,
  model: "claude-test",
  effort: "default",
  effortDefault: null,
  startedAt: 0,
  finishedAt: 0,
  minutes: 1,
  usage: null,
  items,
  dropped: [],
  questions: 0,
});
// A bug at a.ts:10-11, your comment at a.ts:40, a trap at a.ts:60, an extra at a.ts:80.
const NEAR: EvalResult = {
  format: 1,
  createdAt: "2026-10-28T00:00:00.000Z",
  commit: "abc",
  dirty: false,
  promptVersion: "2.3",
  cliVersion: "2.1.295",
  runner: "fake",
  profile: { id: "general", name: "Review", revision: "0123456789" },
  volume: "balanced",
  set: "local",
  tolerance: 3,
  fingerprint: "f".repeat(64),
  repeat: 1,
  cases: [
    {
      id: "l",
      title: "Local",
      language: "unknown",
      changedLines: 10,
      base: "b",
      head: "h",
      bugs: [{ id: "B", path: "a.ts", side: "new", lines: [10, 11], severityMin: "major", module: "core", note: "n" }],
      traps: [{ id: "T", path: "a.ts", side: "new", lines: [60, 60], why: "w" }],
      extras: [{ path: "a.ts", side: "new", lines: [80, 80], note: "n" }],
      human: [{ id: "H", path: "a.ts", side: "new", lines: [40, 40], note: "n" }],
    },
  ],
  // 14 is 3 lines after the bug, 43 is 3 lines after your comment, 62 is 2 lines after the trap, 83 is 3 lines after the extra.
  runs: [
    run([
      item({ line: 14, lineEnd: 14 }),
      item({ line: 43, lineEnd: 44 }),
      item({ line: 62, lineEnd: 62 }),
      item({ line: 83, lineEnd: 83 }),
    ]),
  ],
};

describe("near-line score", () => {
  test("a bug, your comment, and an extra match within T lines, a trap only on its own lines", () => {
    const s = score(NEAR).suite;
    expect(s.recall?.mean).toBe(1);
    expect(s.humanRecall?.mean).toBe(1);
    expect(s.trapRate?.mean).toBe(0);
    expect(s.extras?.mean).toBe(1);
    // Shown: 3 counted items, 2 on a must-find place. The item 2 lines after the trap is noise.
    expect(s.precision?.mean).toBeCloseTo(2 / 3, 10);
    expect(s.noise?.mean).toBe(1);
  });

  test("T = 0 matches only overlapping lines, and a fixture set has no human recall", () => {
    const s = score({ ...NEAR, tolerance: 0 }).suite;
    expect(s.recall?.mean).toBe(0);
    expect(s.humanRecall?.mean).toBe(0);
    expect(s.noise?.mean).toBe(4);
    const fixture = score({ ...NEAR, tolerance: undefined, cases: NEAR.cases.map(({ human: _, ...c }) => c) }).suite;
    expect(fixture.humanRecall).toBeNull();
  });

  test("compare refuses another set fingerprint or another tolerance", () => {
    expect(refusal(NEAR, NEAR)).toBeNull();
    expect(refusal(NEAR, { ...NEAR, fingerprint: "e".repeat(64) })).toContain("different case sets");
    expect(refusal(NEAR, { ...NEAR, fingerprint: undefined })).toContain("different case sets");
    expect(refusal(NEAR, { ...NEAR, tolerance: 0 })).toContain("different tolerances: 3 and 0 lines");
    // Files made before the field existed read as T = 0.
    expect(
      refusal({ ...NEAR, fingerprint: undefined, tolerance: undefined }, { ...NEAR, fingerprint: undefined, tolerance: 0 }),
    ).toBeNull();
  });

  test("a comment of another reviewer counts at volume balanced and above, not at quiet", () => {
    const other: EvalBug = {
      id: "O",
      path: "a.ts",
      side: "new",
      lines: [20, 20],
      severityMin: "minor",
      module: "core",
      note: "n",
      source: "other",
    };
    const r: EvalResult = {
      ...NEAR,
      cases: NEAR.cases.map((c) => ({ ...c, bugs: [...c.bugs, other] })),
      runs: [run([item({ line: 20, lineEnd: 20, severity: "minor" })])],
    };
    expect(score(r).suite.recall?.mean).toBe(1 / 2);
    expect(score({ ...r, volume: "thorough" }).suite.recall?.mean).toBe(1 / 2);
    // Quiet never shows a minor item, so recall leaves the comment out.
    const quiet = score({ ...r, volume: "quiet" });
    expect(quiet.suite.recall?.mean).toBe(0);
    expect(quiet.leftOut.count).toBe(1);
  });

  test("a result file without evidence, anchorText, or cause in its items still scores", () => {
    const old = NEAR.runs[0]?.items ?? [];
    expect(old.every((i) => i.evidence === undefined && i.anchorText === undefined && i.cause === undefined)).toBe(true);
    expect(score(JSON.parse(JSON.stringify(NEAR)) as EvalResult).suite.recall?.mean).toBe(1);
  });

  test("rescore refuses a local result whose cases changed since the run", () => {
    const ids = readdirSync(join(OUT, "cases")).sort();
    const hash = (id: string) =>
      createHash("sha256")
        .update(readFileSync(join(OUT, "cases", id, "case.json"), "utf8"))
        .digest("hex");
    const ran = (fingerprint: string | undefined): EvalResult => ({
      ...NEAR,
      fingerprint,
      runs: ids.map((id) => ({ ...run([]), case: id })),
    });
    const now = setFingerprint(ids.map((id) => ({ id, hash: hash(id) })));
    expect(localRefusal(ran(now), join(OUT, "cases"))).toBeNull();
    expect(localRefusal({ ...ran("e".repeat(64)), set: "v1" }, join(OUT, "cases"))).toBeNull();
    expect(localRefusal(ran("e".repeat(64)), join(OUT, "cases"))).toContain(
      `The result ran local set eeeeeeeeeeee, but its cases now have fingerprint ${now.slice(0, 12)}.`,
    );
    expect(localRefusal(ran(undefined), join(OUT, "cases"))).toContain("has no set fingerprint");
    expect(localRefusal({ ...ran(now), runs: [{ ...run([]), case: "pr1-gone" }] }, join(OUT, "cases"))).toContain(
      "The local set has no case pr1-gone now.",
    );
  });

  test("rescore with another tolerance keeps the local truth and notes the change once", () => {
    const { result, notes } = rescore(NEAR, new Map(), "2026-10-28T01:00:00.000Z", 10);
    expect(result.tolerance).toBe(10);
    expect(result.cases).toEqual(NEAR.cases);
    expect(notes).toEqual(["No case has new bugs, traps, or extras.", "The tolerance goes from 3 to 10 lines."]);
    expect(score(result).suite.recall?.mean).toBe(1);
    expect(score(rescore(NEAR, new Map(), "2026-10-28T01:00:00.000Z", 0).result).suite.recall?.mean).toBe(0);
  });
});

// ---------- A local case end to end ----------

describe("eval --set local with the fake CLI", () => {
  test(
    "runs case A from its bundle, records T and the fingerprint, and scores near-line hits",
    async () => {
      const dir = temp("fake");
      const text = fileAt(A_LINES).split("\n");
      const at = (l: number, severity: string) => ({
        path: PATH,
        side: "new",
        line: l,
        lineEnd: l,
        anchorText: text[l - 1] ?? "",
        severity,
        category: "logic",
        body: "A finding of the fake CLI.",
        evidence: `${PATH}:${l}`,
        evidenceStatus: "code",
        confidence: "high",
        agent: null,
      });
      // 14: within 3 lines of the bugs at 10-11 and 12. 22: your comment. 30: the Not a bug trap.
      const findings = [at(14, "major"), at(22, "minor"), at(30, "minor")];
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", {
            summary: "Fake review.",
            risks: [],
            questions: [],
            coverage: { read: [PATH], skipped: [], unavailable: [], notChecked: [] },
            findings,
          }),
          delayMs: 1,
        }),
      );
      const a = caseOf(heads.a);
      const out = join(dir, "out");
      const r = await bun([RUN, "--set", "local", "--cases", a.id, "--out", out, "--runner", process.execPath, FAKE, scenario], {
        REVIEW_LOOP_EVAL_LOCAL: OUT,
      });
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`[1/1] ${a.id} #1: completed`);
      const [file] = readdirSync(out).filter((f) => f.endsWith(".json"));
      const result = JSON.parse(readFileSync(join(out, file as string), "utf8")) as EvalResult;
      const manifest = JSON.parse(readFileSync(join(OUT, "MANIFEST.json"), "utf8")) as Manifest;
      expect(result).toMatchObject({ set: "local", tolerance: 3 });
      expect(result.cases.map((c) => [c.id, c.base, c.head, c.human?.length])).toEqual([[a.id, heads.base, heads.a, 1]]);
      // One case of the two: its own fingerprint, not the one of the whole set.
      expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(result.fingerprint).not.toBe(manifest.fingerprint);
      expect(result.runs[0]?.items.map((i) => [i.line, i.anchorState, i.group])).toEqual(findings.map((f) => [f.line, "exact", "main"]));
      const s = score(result).suite;
      // 22 is also within 3 lines of the session bug at 20.
      expect(s.recall?.mean).toBe(3 / 8);
      // The items keep the finder text for review-ideas.md idea 3.
      expect(result.runs[0]?.items.map((i) => [i.evidence, i.anchorText, i.cause])).toEqual(
        findings.map((f) => [f.evidence, f.anchorText, undefined]),
      );
      expect(s.humanRecall?.mean).toBe(1);
      expect(s.trapRate?.mean).toBe(1 / 3);
      expect(s.precision?.mean).toBeCloseTo(2 / 3, 10);
      // The finder got the task of the case.
      const stdin = readRecords<{ argv: string[]; stdin: string }>(record).find((x) => x.argv.includes("-p"))?.stdin ?? "";
      expect(stdin).toContain("- Task IDs from the pull request fields: EVAL-9 (branch)");
      // review-ideas.md idea 2: the seeded threads reach pr-context.md as the app writes it.
      const calls = readRecords<{ argv: string[]; context?: Record<string, string> }>(record).filter((x) => x.argv.includes("-p"));
      const prContext = calls[0]?.context?.["pr-context.md"] ?? "";
      expect(prContext).toContain(`inline comment on ${PATH} line 24`);
      expect(prContext).toContain(`inline comment on ${PATH} line 36`);
      expect(prContext).toContain(NOTE_CLEAN);
      expect(prContext).toContain("Still open.");
      for (const gone of ["Deleted root.", "Edited later.", "After the head.", "Moe Mine", "Your own reply."])
        expect(prContext).not.toContain(gone);
      expect(prContext).toContain(`inline comment on ${PATH} line 13`);
      expect(prContext).toContain("Messages: 3, by reviewer-1, reviewer-2, and eval-author");
      expect(prContext).toContain("The PR owner says it is fine.");
      expect(prContext).toContain(`${"x".repeat(299)}…`);
      for (const name of REAL) expect(prContext).not.toContain(name);

      // compare refuses a result of the other tolerance.
      const other = join(dir, "other.json");
      writeFileSync(other, JSON.stringify({ ...result, tolerance: 0 }));
      const cmp = await bun([COMPARE, join(out, file as string), other]);
      expect(cmp.code).toBe(2);
      expect(cmp.stderr).toContain("different tolerances");

      // A case built before rules 3 has no threads and still runs. Its text differs, so the fingerprint differs.
      const old = join(dir, "old-set");
      const { threads: _, ...rest } = a;
      mkdirSync(join(old, "cases", a.id), { recursive: true });
      mkdirSync(join(old, "bundles"));
      writeFileSync(join(old, "cases", a.id, "case.json"), `${JSON.stringify({ ...rest, rules: 2 }, null, 2)}\n`);
      writeFileSync(join(old, "bundles", a.bundle.file), readFileSync(join(OUT, "bundles", a.bundle.file)));
      writeFileSync(join(old, "MANIFEST.json"), readFileSync(join(OUT, "MANIFEST.json")));
      const oldOut = join(dir, "old-out");
      const r2 = await bun([RUN, "--set", "local", "--cases", a.id, "--out", oldOut, "--runner", process.execPath, FAKE, scenario], {
        REVIEW_LOOP_EVAL_LOCAL: old,
      });
      expect(r2.stderr).toBe("");
      expect(r2.code).toBe(0);
      const [oldFile] = readdirSync(oldOut).filter((f) => f.endsWith(".json"));
      const oldResult = JSON.parse(readFileSync(join(oldOut, oldFile as string), "utf8")) as EvalResult;
      expect(oldResult.runs[0]?.status).toBe("completed");
      expect(oldResult.fingerprint).not.toBe(result.fingerprint);
      const oldCalls = readRecords<{ argv: string[]; context?: Record<string, string> }>(record).filter((x) => x.argv.includes("-p"));
      expect(oldCalls.at(-1)?.context?.["pr-context.md"]).not.toContain("The PR owner says it is fine.");

      // The idea 2 check on the result: counts only. Threads have new-side lines 13 and 24, and old-side line 36 on an unchanged line,
      // which is new-side line 36. Found: 10-11, 12, and 20, all near. Missed: 2, 18, 35, 37, and 38. All but 2 are near a thread.
      const check = await bun([THREADS, join(out, file as string)], { REVIEW_LOOP_EVAL_LOCAL: OUT });
      expect(check.stderr).toBe("");
      expect(check.code).toBe(0);
      expect(check.stdout).toBe(
        [
          "Idea 2 check: 1 completed runs of 1 cases. Left out: 0 runs that did not complete. 1 cases have PR threads with lines.",
          "Missed must-finds: 5. With a thread comment within 10 lines in the same file: 4.",
          "Found must-finds: 3. With a thread comment within 10 lines in the same file: 3.",
          "",
        ].join("\n"),
      );
      const refused = await bun([THREADS, join(oldOut, oldFile as string)], { REVIEW_LOOP_EVAL_LOCAL: OUT });
      expect(refused.code).toBe(2);
    },
    SLOW,
  );

  test("the plan lists the whole set, and a missing set exits 2", async () => {
    // Without --real or --runner the harness only plans, so no CLI runs.
    const r = await bun([RUN, "--set", "local"], { REVIEW_LOOP_EVAL_LOCAL: OUT });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("Eval plan: 2 cases, 1 repeat, profile general, set local.");
    expect(r.stdout).toContain("1 own comment");
    const none = await bun([RUN, "--set", "local"], { REVIEW_LOOP_EVAL_LOCAL: join(TMP, "missing") });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("No local set.");
  });
});
