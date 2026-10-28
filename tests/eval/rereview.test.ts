// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v3.md WP-V3: the re-review eval mode. The earlier run of a case, the re-review cases of the local set, the line map
// from the earlier head to the head, the re-raise and verdict score, and a re-review run with the fake CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo, type LocalCaseFile, loadCases, mapSpot } from "../../scripts/eval/cases";
import { refusal } from "../../scripts/eval/compare";
import type { Manifest } from "../../scripts/eval/local";
import { type CaseRun, type EarlierInfo, type EvalItem, type EvalResult, score } from "../../scripts/eval/score";
import { parseDiff } from "../../src/server/review/diffmap";
import { git, gitEnv } from "../../src/server/review/git";
import { openDb } from "../../src/server/storage/db";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const LOCAL = join(ROOT, "scripts/eval/local.ts");
const RUN = join(ROOT, "scripts/eval/run.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const PATH = "src/calc.ts";

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-rereview-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;
const temp = (name: string) => {
  const d = join(TMP, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
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

// ---------- The line map ----------

describe("mapSpot", () => {
  const diff = (body: string, head = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n") => parseDiff(`${head}${body}`);
  test("lines after an insert move down, lines before it stay", () => {
    const files = diff("@@ -1,0 +2,2 @@\n+x\n+y\n");
    expect(mapSpot(files, { path: "a.ts", lines: [10, 11] })).toEqual({ path: "a.ts", lines: [12, 13] });
    expect(mapSpot(files, { path: "a.ts", lines: [1, 1] })).toEqual({ path: "a.ts", lines: [1, 1] });
    expect(mapSpot(files, { path: "b.ts", lines: [5, 5] })).toEqual({ path: "b.ts", lines: [5, 5] });
  });
  test("a range with a changed, deleted, or inserted line maps to null, and a delete before it moves it up", () => {
    expect(mapSpot(diff("@@ -30 +30 @@\n-a\n+b\n"), { path: "a.ts", lines: [29, 31] })).toBeNull();
    expect(mapSpot(diff("@@ -10,2 +10,3 @@\n a\n+x\n b\n"), { path: "a.ts", lines: [10, 11] })).toBeNull();
    expect(mapSpot(diff("@@ -3,2 +2,0 @@\n-a\n-b\n"), { path: "a.ts", lines: [10, 10] })).toEqual({ path: "a.ts", lines: [8, 8] });
    expect(
      mapSpot(parseDiff("diff --git a/a.ts b/a.ts\ndeleted file mode 100644\n--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n"), {
        path: "a.ts",
        lines: [1, 1],
      }),
    ).toBeNull();
  });
  test("a renamed file keeps its lines under the new path", () => {
    const files = parseDiff("diff --git a/a.ts b/c.ts\nsimilarity index 100%\nrename from a.ts\nrename to c.ts\n");
    expect(mapSpot(files, { path: "a.ts", lines: [4, 5] })).toEqual({ path: "c.ts", lines: [4, 5] });
  });
});

// ---------- The score ----------

const item = (o: Partial<EvalItem> & Pick<EvalItem, "line">): EvalItem => ({
  path: "a.ts",
  side: "new",
  lineEnd: o.line,
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
const caseRun = (items: EvalItem[], resolves: string[]): CaseRun => ({
  case: "r",
  repeat: 1,
  run: 1,
  status: "completed",
  errorKind: null,
  error: null,
  model: null,
  effort: null,
  effortDefault: null,
  startedAt: 0,
  finishedAt: 0,
  minutes: 1,
  usage: null,
  items,
  dropped: [],
  questions: 0,
  resolves,
});
const early = (id: string, line: number | null, status: EarlierInfo["status"], resolved: boolean | null = null): EarlierInfo => ({
  id,
  path: "a.ts",
  side: "new",
  lines: line === null ? null : [line, line],
  status,
  resolved,
});
const RR: EvalResult = {
  format: 1,
  createdAt: "2026-10-28T00:00:00.000Z",
  commit: "abc",
  dirty: false,
  promptVersion: "2.3+rereview-strict",
  cliVersion: "2.1.295",
  runner: "fake",
  profile: { id: "general", name: "Review", revision: "0123456789" },
  volume: "balanced",
  set: "local",
  tolerance: 3,
  fingerprint: "f".repeat(64),
  rereview: true,
  repeat: 1,
  cases: [
    {
      id: "r",
      title: "Re-review",
      language: "unknown",
      changedLines: 10,
      base: "b",
      head: "h",
      bugs: [{ id: "B", path: "a.ts", side: "new", lines: [2, 2], severityMin: "minor", module: "core", note: "n" }],
      traps: [],
      extras: [{ path: "a.ts", side: "new", lines: [50, 50], note: "n" }],
      earlier: [
        early("posted", 20, "posted", true),
        early("discarded", 50, "discarded"),
        early("open", 70, "open"),
        early("dropped", 80, "dropped"),
        early("moved", null, "discarded"),
        early("kept", 90, "posted", false),
      ],
    },
  ],
  runs: [],
};

describe("re-review score", () => {
  test("a re-raise of a posted or discarded finding is noise, and a new posted finding is a hit", () => {
    const r = { ...RR, runs: [caseRun([item({ line: 2 }), item({ line: 21 }), item({ line: 51 })], ["posted"])] };
    const s = score(r).suite;
    expect(s.recall?.mean).toBe(1);
    expect(s.reRaises?.mean).toBe(2);
    expect(s.noise?.mean).toBe(2);
    // The re-raise on the extra at 50 stays in the shown count.
    expect(s.precision?.mean).toBeCloseTo(1 / 3, 10);
    expect(s.extras?.mean).toBe(0);
  });

  test("a carried copy, an open or dropped finding, and changed lines give no re-raise", () => {
    const r = {
      ...RR,
      runs: [caseRun([item({ line: 20, carried: true }), item({ line: 70 }), item({ line: 80 }), item({ line: 30 })], ["posted"])],
    };
    expect(score(r).suite.reRaises?.mean).toBe(0);
  });

  test("a fixed verdict counts against the later thread state of a posted finding", () => {
    expect(score({ ...RR, runs: [caseRun([], ["posted"])] }).suite.verdictOk?.mean).toBe(1);
    expect(score({ ...RR, runs: [caseRun([], ["posted", "kept"])] }).suite.verdictOk?.mean).toBe(1 / 2);
    expect(score({ ...RR, runs: [caseRun([], [])] }).suite.verdictOk?.mean).toBe(1 / 2);
  });

  test("a plain result has no re-raise and no verdict value, and compare refuses a mix of modes", () => {
    const { earlier: _, ...plainCase } = RR.cases[0] as EvalResult["cases"][number];
    const plain: EvalResult = { ...RR, rereview: undefined, cases: [plainCase], runs: [caseRun([item({ line: 21 })], [])] };
    expect(score(plain).suite.reRaises).toBeNull();
    expect(score(plain).suite.verdictOk).toBeNull();
    expect(refusal(RR, plain)).toContain("different modes");
    expect(refusal(RR, RR)).toBeNull();
  });
});

// ---------- Fixture cases ----------

describe("re-review fixture case", () => {
  test("earlier.patch makes the earlier head, and the head is its child", async () => {
    const root = temp("fixture");
    const dir = join(root, "rr-case");
    mkdirSync(join(dir, "base"), { recursive: true });
    writeFileSync(join(dir, "base", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(
      join(dir, "earlier.patch"),
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-export const a = 1;\n+export const a = 3;\n export const b = 2;\n",
    );
    writeFileSync(
      join(dir, "head.patch"),
      "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-export const a = 1;\n-export const b = 2;\n+export const a = 3;\n+export const b = 4;\n",
    );
    const payload = {
      path: "a.ts",
      side: "new",
      line: 1,
      lineEnd: null,
      anchorText: "export const a = 3;",
      severity: "major",
      category: "logic",
      body: "a is wrong.",
      evidence: "a.ts:1",
      evidenceStatus: "code",
      confidence: "high",
      agent: null,
    };
    const earlier = [
      { id: "e1", path: "a.ts", side: "new", lines: [1, 1], status: "discarded", resolved: null, body: "a is wrong.", payload },
    ];
    const json = {
      id: "rr-case",
      title: "Re-review",
      language: "typescript",
      pr: { title: "Change b", description: "" },
      bugs: [],
      traps: [{ id: "t", path: "a.ts", side: "new", lines: [2, 2], why: "w" }],
      rereview: { earlier },
    };
    writeFileSync(join(dir, "case.json"), JSON.stringify(json));
    const [c] = loadCases("all", root);
    expect(c?.rereview?.earlier.map((e) => [e.id, e.payload.title])).toEqual([["e1", ""]]);
    const repo = await buildRepo(c as NonNullable<typeof c>, temp("repo"));
    expect(repo.sinceBase).toBe(repo.base);
    const parent = (await git(["--git-dir", repo.url, "rev-parse", `${repo.head}^`], { env: repo.env })).trim();
    expect(parent).toBe(repo.since as string);
    expect(await repo.show(repo.since as string, "a.ts")).toBe("export const a = 3;\nexport const b = 2;\n");
    expect(await repo.show(repo.head, "a.ts")).toBe("export const a = 3;\nexport const b = 4;\n");

    rmSync(join(dir, "earlier.patch"));
    expect(() => loadCases("all", root)).toThrow("has a rereview block but no earlier.patch");
  });
});

// ---------- The local set: re-review cases and a fake run ----------

// Base: 40 lines. A changes lines 10 to 14 and 20 to 24. B inserts two lines after line 1 and changes line 30 of A (32 at B).
const line = (i: number, changed: boolean) => `export const v${i} = ${i}${changed ? " + 1" : ""};`;
const A_CHANGED = new Set([10, 11, 12, 13, 14, 20, 21, 22, 23, 24]);
const lines = (changed: Set<number>) => Array.from({ length: 40 }, (_, k) => line(k + 1, changed.has(k + 1)));
const BASE_TEXT = lines(new Set());
const A_TEXT = lines(A_CHANGED);
const B_TEXT = [A_TEXT[0] as string, "export const n1 = 1;", "export const n2 = 2;", ...lines(new Set([...A_CHANGED, 30])).slice(1)];
const text = (l: string[]) => `${l.join("\n")}\n`;

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
  const commit = async (t: string, msg: string) => {
    writeFileSync(join(src, PATH), t);
    await git(["-C", src, "add", "."], { env });
    await git(["-C", src, "commit", "-q", "-m", msg], { env });
    return (await git(["-C", src, "rev-parse", "HEAD"], { env })).trim();
  };
  const base = await commit(text(BASE_TEXT), "base");
  const a = await commit(text(A_TEXT), "head A");
  const b = await commit(text(B_TEXT), "head B");
  const cache = join(root, "git");
  await git(["clone", "-q", "--bare", src, join(cache, "PROJ", "repo.git")], { env });
  return { cache, base, a, b };
}

const finding = (at: string[], l: number, o: Record<string, unknown> = {}) => ({
  path: PATH,
  side: "new",
  line: l,
  lineEnd: l,
  anchorText: at[l - 1] ?? "",
  severity: "major",
  category: "logic",
  body: `Finding at ${l}.`,
  evidence: `${PATH}:${l}`,
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  ...o,
});

type Heads = { base: string; a: string; b: string };

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
        (2, 'PROJ', 'repo', 8, 'Lost earlier run', '', 'author', $b, $base)`,
  ).run({ b: h.b, base: h.base });
  let keys = 0;
  const run = (pr: number, head: string, since: string | null) =>
    (
      db
        .query(
          `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, merge_base, since_head, status, started_at)
          VALUES ($pr, 'review', 'general', '', $key, $head, $base, $base, $since, 'completed', 1) RETURNING id`,
        )
        .get({ pr, key: `k${keys++}`, head, base: h.base, since }) as { id: number }
    ).id;
  const item = (r: number, status: string, at: string[], l: number, p: Record<string, unknown> = {}) =>
    (
      db
        .query(
          `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status)
          VALUES ($run, 'finding', $payload, $body, $path, 'new', $line, $line, $status) RETURNING id`,
        )
        .get({
          run: r,
          payload: JSON.stringify({ ...finding(at, l), module: "core", ...p }),
          body: `Finding at ${l}.`,
          path: PATH,
          line: l,
          status,
        }) as {
        id: number;
      }
    ).id;

  const ra = run(1, h.a, null);
  const ids = {
    posted: item(ra, "posted", A_TEXT, 10),
    intended: item(ra, "discarded", A_TEXT, 22, { discardReason: { code: "intended" } }),
    refuted: item(ra, "discarded", A_TEXT, 14, { discardedBy: "verify", verify: { verdict: "refuted" } }),
    open: item(ra, "discarded", A_TEXT, 13),
    worth: item(ra, "discarded", A_TEXT, 30, { discardReason: { code: "worth" } }),
    copy: 0,
    added: 0,
    trap: 0,
  };
  const rb = run(1, h.b, h.a);
  ids.copy = item(rb, "posted", B_TEXT, 15, { carried: { from: ids.open, verdict: "open", reason: "", since: h.a } });
  ids.added = item(rb, "posted", B_TEXT, 2);
  ids.trap = item(rb, "discarded", B_TEXT, 35, { discardReason: { code: "bug" } });
  // The earlier run of PR 2 reviewed another head: no re-review case.
  run(2, h.a, null);
  item(run(2, h.b, "f".repeat(40)), "posted", B_TEXT, 2);

  db.query(
    `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, remote_id, created_at, updated_at)
      VALUES (1, $run, 'inline', 'p1', 'b', '{}', $items, 'confirmed', 200, 1, 1)`,
  ).run({ run: ra, items: JSON.stringify([{ id: ids.posted, revision: 0 }]) });
  db.run(
    `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, text, anchor_json, thread_resolved, created_at, updated_at)
      VALUES (1, 200, 0, NULL, 200, 'me', 'b', '{}', 1, 1, 1)`,
  );
  db.close();
  return { file, ids };
}

let heads: Heads;
let ids: ReturnType<typeof makeDb>["ids"];
let OUT: string;
let built: { code: number; stdout: string; stderr: string };
const rrCase = (): LocalCaseFile => {
  const [id] = readdirSync(join(OUT, "rereview"));
  return JSON.parse(readFileSync(join(OUT, "rereview", id as string, "case.json"), "utf8")) as LocalCaseFile;
};

beforeAll(async () => {
  for (const f of ["run.ts", "local.ts", "score.ts"])
    console.log(`Code under test: ${Bun.resolveSync(`../../scripts/eval/${f}`, import.meta.dir)}`);
  const repo = await makeCache(temp("cache"));
  heads = repo;
  const copy = temp("copy");
  const db = makeDb(copy, heads);
  ids = db.ids;
  OUT = join(temp("set"), "eval-local");
  built = await bun([LOCAL, "--db", db.file, "--cache", repo.cache, "--out", OUT]);
}, SLOW);

describe("eval:local re-review cases", () => {
  test("one case per re-review run with its earlier run, and a lost earlier run is counted", () => {
    expect(built.stderr).toBe("");
    expect(built.code).toBe(0);
    expect(built.stdout).toContain("Re-review cases: 1, with 5 earlier findings. Must find: 2. Must not raise: 1. Neutral: 0.");
    expect(built.stdout).toContain("Re-reviews left out: 1 without their earlier run, 0 with missing commits, 0 with nothing to measure.");
    const m = JSON.parse(readFileSync(join(OUT, "MANIFEST.json"), "utf8")) as Manifest;
    expect(m.rereview.counts).toEqual({ cases: 1, bugs: 2, traps: 1, extras: 0, earlier: 5 });
    expect(readdirSync(join(OUT, "rereview"))).toEqual([`pr1-rr2`]);
  });

  test("the earlier findings keep their state at the re-review start and the later thread state", () => {
    const c = rrCase();
    expect(c.rereview).toMatchObject({ since: heads.a, sinceBase: heads.base });
    expect(c.bundle).toMatchObject({ base: heads.base, head: heads.b });
    expect(c.rereview?.earlier.map((e) => [e.id, e.lines, e.status, e.resolved])).toEqual([
      [`item-${ids.posted}`, [10, 10], "posted", true],
      [`item-${ids.intended}`, [22, 22], "discarded", null],
      [`item-${ids.refuted}`, [14, 14], "dropped", null],
      // The re-review carried it, so it was open then. carryOver discarded the source later.
      [`item-${ids.open}`, [13, 13], "open", null],
      [`item-${ids.worth}`, [30, 30], "discarded", null],
    ]);
    // The decisions of the re-review run only: the posted copy, the new posted finding, and the Not a bug trap.
    expect(c.bugs.map((b) => [b.id, b.lines])).toEqual([
      [`item-${ids.copy}`, [15, 15]],
      [`item-${ids.added}`, [2, 2]],
    ]);
    expect(c.traps.map((t) => [t.id, t.lines])).toEqual([[`item-${ids.trap}`, [35, 35]]]);
  });

  test(
    "--rereview seeds the earlier run, runs a re-review, and scores re-raises and verdicts",
    async () => {
      const dir = temp("fake");
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      const coverage = { read: [PATH], skipped: [], unavailable: [], notChecked: [] };
      // 2: the new posted finding. 24: a re-raise of the Intended discard (22 at A). 32: line 30 of A, which B changed: no re-raise.
      // judge.ts capOf: an unchecked finding without a trigger becomes a question.
      const findings = [2, 24, 32].map((l) => finding(B_TEXT, l, { trigger: `Input ${l} gives a wrong sum.` }));
      // The seeded earlier run is the first run of the temp database, so its items have IDs 1 to 5 in case order.
      const earlier = [
        { id: 4, status: "open", reason: "Still there.", path: null, line: 15 },
        { id: 1, status: "fixed", reason: "The new commits fix it.", path: null, line: null },
      ];
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude/b9-wp8-flags.jsonl", {
            summary: "s",
            risks: [],
            questions: [],
            coverage,
            findings: [],
          }),
          rereview: { summary: "Fake re-review.", risks: [], questions: [], coverage, findings, earlier },
          delayMs: 1,
        }),
      );
      const out = join(dir, "out");
      const r = await bun(
        [RUN, "--set", "local", "--rereview", "--verifier", "off", "--out", out, "--runner", process.execPath, FAKE, scenario],
        { REVIEW_LOOP_EVAL_LOCAL: OUT },
      );
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("[1/1] pr1-rr2 #1: completed");
      const stdin = readRecords<{ argv: string[]; stdin: string }>(record).find((x) => x.argv.includes("-p"))?.stdin ?? "";
      expect(stdin).toContain(`An earlier run reviewed this change at ${heads.a}.`);
      expect(stdin).toContain("Earlier findings: 4, 1");
      expect(stdin).toContain("Posted findings: 1.");
      const [file] = readdirSync(out).filter((f) => f.endsWith(".json"));
      const result = JSON.parse(readFileSync(join(out, file as string), "utf8")) as EvalResult;
      expect(result.rereview).toBe(true);
      // The earlier lines at head B: A lines 10 to 24 move down by 2, and A line 30 changed.
      expect(result.cases[0]?.earlier?.map((e) => [e.status, e.lines])).toEqual([
        ["posted", [12, 12]],
        ["discarded", [24, 24]],
        ["dropped", [16, 16]],
        ["open", [15, 15]],
        ["discarded", null],
      ]);
      expect(result.runs[0]?.resolves).toEqual([`item-${ids.posted}`]);
      expect(result.runs[0]?.items.map((i) => [i.line, i.carried ?? false])).toEqual([
        [2, false],
        [24, false],
        [32, false],
        [15, true],
      ]);
      const s = score(result).suite;
      expect(s.recall?.mean).toBe(1);
      expect(s.reRaises?.mean).toBe(1);
      expect(s.noise?.mean).toBe(2);
      expect(s.verdictOk?.mean).toBe(1);
    },
    SLOW,
  );

  test("--rereview refusals exit 2", async () => {
    const strict = await bun([RUN, "--variants", "rereview-strict"]);
    expect(strict.code).toBe(2);
    expect(strict.stderr).toContain("--variants rereview-strict changes only the re-review prompt. Add --rereview");
    const plan = await bun([RUN, "--set", "local", "--rereview", "--variants", "rereview-strict"], { REVIEW_LOOP_EVAL_LOCAL: OUT });
    expect(plan.code).toBe(2);
    expect(plan.stdout).toContain("Eval plan: 1 case, 1 repeat, profile general with variants rereview-strict, set local, re-reviews.");
    expect(plan.stdout).toContain("5 earlier findings");
    const v1 = await bun([RUN, "--set", "v1", "--rereview"]);
    expect(v1.code).toBe(2);
    expect(v1.stderr).toContain("Set v1 has no re-review case.");
  });
});
