// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v3.md WP-V1: the local eval set from your own decisions, its near-line score, and a local case run with the fake CLI.
// The tests make a synthetic database copy and a temp repository. Every data folder that a child can see is a temp folder.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type LocalCaseFile, loadCases, setFingerprint } from "../../scripts/eval/cases";
import { refusal } from "../../scripts/eval/compare";
import type { Manifest } from "../../scripts/eval/local";
import { rescore } from "../../scripts/eval/rescore";
import { type CaseRun, type EvalItem, type EvalResult, score } from "../../scripts/eval/score";
import { git, gitEnv } from "../../src/server/review/git";
import { openDb } from "../../src/server/storage/db";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const LOCAL = join(ROOT, "scripts/eval/local.ts");
const RUN = join(ROOT, "scripts/eval/run.ts");
const COMPARE = join(ROOT, "scripts/eval/compare.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const PATH = "src/calc.ts";

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
// Head A changes lines 10 to 14, 22, 27, and 30. Head B also changes line 20.
const A_LINES = new Set([10, 11, 12, 13, 14, 22, 27, 30]);
const B_LINES = new Set([...A_LINES, 20]);

// The copy of the git folder: <cache>/PROJ/repo.git with the base, A, and B commits.
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
  const cache = join(root, "git");
  await git(["clone", "-q", "--bare", src, join(cache, "PROJ", "repo.git")], { env });
  return { cache, base, a, b };
}

type Heads = { base: string; a: string; b: string };

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
          VALUES ($pr, 'review', 'general', '', $key, $head, $base, $mb, $status, 1) RETURNING id`,
        )
        .get({ pr, key: `k${keys++}`, head, base: h.base, mb: base, status }) as { id: number }
    ).id;
  const item = (r: number, status: string, lines: [number, number], p: Record<string, unknown> = {}) =>
    (
      db
        .query(
          `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status)
          VALUES ($run, 'finding', $payload, 'b', $path, 'new', $line, $end, $status) RETURNING id`,
        )
        .get({
          run: r,
          payload: JSON.stringify({ severity: "minor", module: "core", ...p }),
          path: PATH,
          line: lines[0],
          end: lines[1],
          status,
        }) as { id: number }
    ).id;
  const comment = (id: number, o: { author?: string; parent?: number; anchor?: object | null }) =>
    db
      .query(
        `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, text, anchor_json, created_at, updated_at)
        VALUES (1, $id, 0, $parent, $root, $author, 't', $anchor, 1, 1)`,
      )
      .run({
        id,
        parent: o.parent ?? null,
        root: o.parent ?? id,
        author: o.author ?? "me",
        anchor: o.anchor === null ? null : JSON.stringify(o.anchor ?? {}),
      });
  const anchor = (lineNo: number | undefined, toHash = h.a) => ({
    path: PATH,
    ...(lineNo !== undefined && { line: lineNo, lineType: "ADDED", fileType: "TO" }),
    diffType: "EFFECTIVE",
    fromHash: h.base,
    toHash,
  });

  const r1 = run(1, h.a, h.base);
  const r2 = run(1, h.a, h.base);
  const r3 = run(1, h.b, h.base);
  const failed = run(1, h.a, h.base, "failed");
  run(1, h.a, null);
  const ids = {
    posted: item(r1, "posted", [10, 11], { severity: "major" }),
    notBug: item(r1, "discarded", [30, 30], { discardReason: { code: "bug" } }),
    intended: item(r1, "discarded", [5, 5], { discardReason: { code: "intended" } }),
    worth: item(r1, "discarded", [15, 15], { discardReason: { code: "worth" } }),
    refuted: item(r1, "discarded", [20, 20], { discardedBy: "verify", verify: { verdict: "refuted" } }),
    noReason: item(r1, "discarded", [25, 25]),
    restored: item(r1, "posted", [2, 2], { verify: { verdict: "refuted" } }),
    carried: item(r1, "discarded", [35, 35]),
    fixed: item(r1, "discarded", [38, 38], { fixed: { id: 1, commit: "c", short: "c", was: "new" } }),
    open: item(r1, "new", [39, 39]),
    clashPosted: item(r1, "posted", [33, 33]),
    clashTrap: item(r1, "discarded", [27, 27], { discardReason: { code: "bug" } }),
    clashIntended: item(r2, "discarded", [33, 34], { discardReason: { code: "intended" } }),
    second: item(r2, "posted", [12, 12], { severity: "blocker" }),
    copy: 0,
  };
  // A revision of a finding is no finding. A finding of a failed run counts nowhere.
  item(r2, "discarded", [12, 12], { revises: ids.second });
  item(failed, "posted", [1, 1]);
  ids.copy = item(r3, "posted", [35, 35], { severity: "major", carried: { from: ids.carried, verdict: "open", reason: "", since: h.a } });
  // Only extras: no case. A repository without a cache copy: missing commits.
  item(run(2, h.a, h.base), "discarded", [15, 15], { discardReason: { code: "worth" } });
  item(run(3, h.a, h.base), "posted", [10, 10]);

  comment(100, { anchor: anchor(22) });
  comment(101, { author: "other", anchor: anchor(22) });
  comment(102, { anchor: anchor(22, "f".repeat(40)) });
  comment(103, { anchor: anchor(10) });
  db.query(
    `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, remote_id, created_at, updated_at)
      VALUES (1, $run, 'inline', 'p1', 'b', '{}', $items, 'confirmed', 103, 1, 1)`,
  ).run({ run: r1, items: JSON.stringify([{ id: ids.posted, revision: 0 }]) });
  comment(104, { parent: 100, anchor: null });
  comment(105, { anchor: anchor(undefined) });
  // Your comment on the Not a bug finding at line 27: opposite decisions.
  comment(106, { anchor: anchor(27) });
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
    expect(built.stdout).toContain("Must find: 5 posted findings and 1 of your own comments. Must not raise: 2. Neutral: 2.");
    expect(built.stdout).toContain(
      "Left out: 1 refuted by the check, 1 discarded without your triage, 1 without a decision, 0 without an anchor, 4 in opposite decisions, 1 runs without a merge base, 1 cases with missing commits, 1 cases with nothing to find or avoid, 1 comments without a line, 1 comments at a head with no review.",
    );
    expect(built.stdout).toContain("below the recommended minimum");
    for (const name of [TMP, OUT, "PROJ", "Add the calc helpers", "EVAL-9"]) expect(built.stdout).not.toContain(name);
    const m = JSON.parse(readFileSync(join(OUT, "MANIFEST.json"), "utf8")) as Manifest;
    expect(m.counts).toEqual({ cases: 2, runs: 3, repositories: 1, bugs: 5, traps: 2, extras: 2, human: 1 });
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
      [ofItem(ids.second), [12, 12], "blocker"],
    ]);
    expect(caseOf(heads.b).bugs.map((b) => [b.id, b.lines])).toEqual([[ofItem(ids.copy), [35, 35]]]);
    expect(a.bugs.every((b) => b.path === PATH && b.side === "new")).toBe(true);
  });

  test("Not a bug and Intended become traps", () => {
    expect(caseOf(heads.a).traps.map((t) => [t.id, t.lines])).toEqual([
      [ofItem(ids.notBug), [30, 30]],
      [ofItem(ids.intended), [5, 5]],
    ]);
  });

  test("Not worth fixing and a discard without a reason are neutral extras", () => {
    expect(caseOf(heads.a).extras.map((x) => x.lines)).toEqual([
      [15, 15],
      [25, 25],
    ]);
  });

  test("a refuted finding that you never restored is left out, and a restored one counts", () => {
    const a = caseOf(heads.a);
    const all = [...a.bugs, ...a.traps, ...a.extras].map((x) => x.lines[0]);
    expect(all).not.toContain(20);
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

  test("your own root comment at a reviewed head is a must-find item", () => {
    expect(caseOf(heads.a).human).toEqual([{ id: "comment-100", path: PATH, side: "new", lines: [22, 22], note: "Your comment 100." }]);
    expect(caseOf(heads.b).human).toEqual([]);
  });

  test("a case holds the PR text, the task rows, the commits, and the changed lines", () => {
    const a = caseOf(heads.a);
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
    "a path in the live data folder is refused before any read",
    async () => {
      const inLive = join(LIVE, "db-x.sqlite");
      for (const args of [
        ["--db", inLive, "--cache", cache],
        ["--db", dbFile, "--cache", join(LIVE, "git")],
        ["--db", dbFile, "--cache", cache, "--out", join(LIVE, "eval")],
      ]) {
        const r = await bun([LOCAL, ...args]);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("is inside the live data folder of the app");
      }
      expect(readdirSync(LIVE)).toEqual([]);
      // The app default folder stays live while REVIEW_LOOP_DATA_DIR names another folder (config.ts dataDir).
      if (process.platform !== "darwin") {
        const r = await bun([LOCAL, "--db", join(APPDATA, "review-loop", "db-x.sqlite"), "--cache", cache]);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("Refused: --db is inside the live data folder");
      }
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
          fixture: claudeStream(dir, "eval", "claude/b9-wp8-flags.jsonl", {
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
      expect(s.recall?.mean).toBe(2 / 4);
      expect(s.humanRecall?.mean).toBe(1);
      expect(s.trapRate?.mean).toBe(1 / 2);
      expect(s.precision?.mean).toBeCloseTo(2 / 3, 10);
      // The finder got the task of the case.
      const stdin = readRecords<{ argv: string[]; stdin: string }>(record).find((x) => x.argv.includes("-p"))?.stdin ?? "";
      expect(stdin).toContain("- Task IDs from the pull request fields: EVAL-9 (branch)");

      // compare refuses a result of the other tolerance.
      const other = join(dir, "other.json");
      writeFileSync(other, JSON.stringify({ ...result, tolerance: 0 }));
      const cmp = await bun([COMPARE, join(out, file as string), other]);
      expect(cmp.code).toBe(2);
      expect(cmp.stderr).toContain("different tolerances");
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
