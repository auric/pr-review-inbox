// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// bun run eval:ab: the local set from a temp "live" data folder, read only, then baseline and candidate runs with the fake CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  type AbOptions,
  FLAGS_FILE,
  failedRuns,
  flagsRefusal,
  largeBaseline,
  largeCases,
  modeText,
  parseAb,
  reuseRefusal,
  runArgs,
  runFlags,
} from "../../scripts/eval/ab";
import { callsDir, evalProfile, parseOptions } from "../../scripts/eval/run";
import { type EvalResult, endedOnLimit, LIMIT_EXIT } from "../../scripts/eval/score";

console.log(`ab.test.ts imported from ${Bun.resolveSync("../../scripts/eval/ab", import.meta.dir)}`);

import { dbPath, PROFILES_VERSION } from "../../src/server/config";
import { profileRevision, promptVersion } from "../../src/server/review/catalog";
import { git, gitEnv } from "../../src/server/review/git";
import { openDb } from "../../src/server/storage/db";
import { readRecords, schemaKind } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";

const SLOW = 180_000;
const ROOT = resolve(import.meta.dir, "../..");
const AB = join(ROOT, "scripts/eval/ab.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const PATH = "src/calc.ts";
const BASE_URL = "https://bitbucket.example.invalid";

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-ab-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));
const LIVE = join(TMP, "live");
const APPDATA = join(TMP, "appdata");
// Distinctive synthetic names: the eval:ab output must show none of them.
const REPO_NAME = "zebracornrepo";
const PR_TITLE = "Quokkaflux calc helpers";
const CACHE = join(LIVE, "git", "PROJ", `${REPO_NAME}.git`);
mkdirSync(LIVE, { recursive: true });
mkdirSync(APPDATA, { recursive: true });

async function bun(args: string[]) {
  const p = Bun.spawn([process.execPath, "--preload", NO_REAL, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_DATA_DIR: LIVE, LOCALAPPDATA: APPDATA, XDG_DATA_HOME: APPDATA, REVIEW_LOOP_EVAL_LOCAL: "" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

const fileAt = (changed: Set<number>) =>
  `${Array.from({ length: 40 }, (_, k) => `export const v${k + 1} = ${k + 1}${changed.has(k + 1) ? " + 1" : ""};`).join("\n")}\n`;
const CHANGED = new Set([10, 11, 12, 30]);

// The live data folder: config.json, the database at its app name, the cache with a review worktree, and a loose object.
async function makeLive() {
  const empty = join(TMP, "empty.gitconfig");
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
  const src = join(TMP, "src");
  await git(["init", "-q", "--template=", src], { env });
  mkdirSync(join(src, "src"));
  const commit = async (text: string, msg: string) => {
    writeFileSync(join(src, PATH), text);
    await git(["-C", src, "add", "."], { env });
    await git(["-C", src, "commit", "-q", "-m", msg], { env });
    return (await git(["-C", src, "rev-parse", "HEAD"], { env })).trim();
  };
  const base = await commit(fileAt(new Set()), "base");
  const head = await commit(fileAt(CHANGED), "head");
  await git(["clone", "-q", "--bare", src, CACHE], { env });
  await git(["--git-dir", CACHE, "worktree", "add", "-q", "--detach", join(LIVE, "work", "r1"), head], { env });
  await git(["--git-dir", CACHE, "hash-object", "-w", "--stdin"], { env, stdin: "a loose object\n" });

  writeFileSync(join(LIVE, "config.json"), JSON.stringify({ baseUrl: BASE_URL, userSlug: "me", notifications: false }));
  const db = openDb(dbPath(LIVE, BASE_URL));
  db.query(
    `INSERT INTO pull_request (id, project, repo, pr_id, title, description, author_slug, source_head, target_head)
      VALUES (1, 'PROJ', $repo, 7, $title, 'Synthetic PR.', 'author', $head, $base)`,
  ).run({ head, base, repo: REPO_NAME, title: PR_TITLE });
  const { id: run } = db
    .query(
      `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, merge_base, status, started_at)
        VALUES (1, 'review', 'general', '', 'k1', $head, $base, $base, 'completed', 1) RETURNING id`,
    )
    .get({ head, base }) as { id: number };
  const item = (status: string, lines: [number, number], p: Record<string, unknown>) =>
    db
      .query(
        `INSERT INTO review_item (run, kind, payload_json, body, path, side, line, line_end, status)
          VALUES ($run, 'finding', $payload, 'b', $path, 'new', $line, $end, $status)`,
      )
      .run({
        run,
        payload: JSON.stringify({ severity: "major", module: "core", ...p }),
        path: PATH,
        line: lines[0],
        end: lines[1],
        status,
      });
  item("posted", [10, 11], {});
  item("discarded", [30, 30], { discardReason: { code: "bug" } });
  // A task row stored before WP-JC1: the Gate JC-A overlay test replaces it.
  db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES (1, 'ABC-12', 'branch', NULL, 0)").run();
  db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES (1, 'ABC-12', 'jira', $json, 1)").run({
    json: JSON.stringify({
      key: "ABC-12",
      summary: "Add the calc helpers",
      status: "In Progress",
      description: "Stored task text.",
      comments: [],
      commentsTotal: 0,
      truncated: false,
    }),
  });
  db.close();
  return { env };
}

// Every file under the live folder: its bytes and its modification time.
function snapshot(dir: string, at = dir, out = new Map<string, string>()) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) snapshot(p, at, out);
    else out.set(relative(at, p), `${createHash("sha256").update(readFileSync(p)).digest("hex")} ${statSync(p).mtimeMs}`);
  }
  return out;
}

let env: Record<string, string>;
let before: Map<string, string>;
let gitBefore: string[];
const gitState = () =>
  Promise.all([
    git(["--git-dir", CACHE, "worktree", "list", "--porcelain"], { env }),
    git(["--git-dir", CACHE, "count-objects", "-v"], { env }),
    git(["--git-dir", CACHE, "for-each-ref"], { env }),
  ]);

beforeAll(async () => {
  console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/ab.ts", import.meta.dir)}`);
  env = (await makeLive()).env;
  gitBefore = await gitState();
  before = snapshot(LIVE);
}, SLOW);

const opts = (o: Partial<AbOptions> = {}): AbOptions => ({
  repeat: "1",
  candidateRepeat: null,
  variants: ["broad", "verify2"],
  modules: ["failures"],
  baseEffort: null,
  effort: null,
  reviewerEffort: null,
  reviewerMode: null,
  verifier: null,
  verifierEffort: null,
  replay: false,
  jiraFamily: false,
  tasksOverlay: null,
  baselineOnly: false,
  reviewOnly: false,
  large: false,
  build: [],
  results: null,
  baseline: null,
  resume: false,
  runner: ["fake"],
  ...o,
});

// A result header as eval:ab writes it for one side, with no case and no run.
function header(mode: "review" | "rereview", side: "baseline" | "candidate", o = opts()): EvalResult {
  const p = parseOptions(runArgs(mode, side, o, ""));
  const e = "error" in p ? p : evalProfile(p);
  if ("error" in e) throw new Error(e.error);
  const profile = e.profile;
  return {
    format: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    commit: "abc",
    dirty: false,
    promptVersion: promptVersion(profile),
    profileVersion: PROFILES_VERSION,
    cliVersion: "1.0.0",
    runner: "fake",
    profile: { ...profile, revision: profileRevision(profile) },
    volume: null,
    requested: { model: profile.model ?? "default", effort: profile.effort ?? "default", verifier: profile.verifier.mode },
    set: "local",
    tolerance: 3,
    fingerprint: "f".repeat(64),
    ...(mode === "rereview" && { rereview: true }),
    repeat: 1,
    cases: [],
    runs: [],
  };
}

describe("eval:ab --baseline checks", () => {
  const FP = "f".repeat(64);
  test("a matching stored baseline passes, each mismatch is refused", () => {
    for (const mode of ["review", "rereview"] as const) expect(reuseRefusal(mode, header(mode, "baseline"), opts(), FP)).toBeNull();
    const a = header("review", "baseline");
    const refused = (r: Partial<EvalResult>, o = opts()) => reuseRefusal("review", { ...a, ...r }, o, FP);
    expect(reuseRefusal("rereview", a, opts(), FP)).toContain("ran the other mode");
    expect(refused({ requested: { ...(a.requested as NonNullable<EvalResult["requested"]>), tasksOverlay: "0123456789ab" } })).toBe(
      "Refused: the stored review baseline ran with the task overlay 0123456789ab, but a baseline runs the stored task rows.",
    );
    expect(reuseRefusal("review", a, opts(), "e".repeat(64))).toContain(
      "ran case set ffffffffffff, but the set now has fingerprint eeeeeeeeeeee",
    );
    expect(refused({}, opts({ baseEffort: "low" }))).toContain("but this run needs effort low");
    // --candidate-effort changes only the candidate, so the baseline still matches.
    expect(refused({}, opts({ effort: "low" }))).toBeNull();
    expect(refused({ profileVersion: PROFILES_VERSION - 1 })).toContain(`but the shipped profile is now version ${PROFILES_VERSION}`);
    expect(refused({ promptVersion: "1.0" })).toContain("ran prompt version 1.0, but the baseline now has prompt version");
    expect(refused({ requested: { model: "opus", effort: a.requested?.effort as string } })).toContain("ran with model opus");
    expect(refused({ profile: { ...a.profile, revision: "0".repeat(64) } })).toContain("ran profile revision 00000000");
    expect(refused({ repeat: 2 }, opts({ repeat: "3" }))).toContain("ran with --repeat 2, but the candidate runs 3 repeats");
    expect(refused({ repeat: 2 }, opts({ candidateRepeat: "3" }))).toContain("ran with --repeat 2, but the candidate runs 3 repeats");
    // A different commit and CLI version are allowed.
    expect(refused({ commit: "def", cliVersion: "2.0.0" })).toBeNull();
  });

  test("a cut or short baseline is refused: its finished runs are fewer than the set cases x repeats", () => {
    const run = (id: string, status: string, o: Partial<EvalResult["runs"][number]> = {}) =>
      ({ case: id, repeat: 1, status, errorKind: null, ...o }) as EvalResult["runs"][number];
    const info = (id: string) => ({ id, title: id, language: "ts", changedLines: 1, base: "b", head: "h", bugs: [], traps: [] });
    const a = (runs: EvalResult["runs"]) => ({ ...header("review", "baseline"), cases: ["a", "b"].map(info), runs });
    const full = a([run("a", "completed"), run("b", "incomplete")]);
    expect(reuseRefusal("review", full, opts(), FP, false, 2)).toBeNull();
    // A cut in the first pass: a.cases lists only the cases that ran, so the set count decides.
    const cut = { ...a([run("a", "completed")]), cases: [info("a")] };
    expect(reuseRefusal("review", cut, opts(), FP, false, 2)).toBe(
      "Refused: the stored review baseline has 1 finished runs of 2 (2 cases x 1 repeats). Resume it with eval:ab --resume, then use it.",
    );
    expect(
      reuseRefusal("review", a([run("a", "completed"), run("b", "failed", { errorKind: "process" })]), opts(), FP, false, 2),
    ).toContain("has 1 finished runs of 2");
    // judge.ts: a usage limit in the check phase leaves an incomplete run with verify.failed.
    const limited = run("b", "incomplete", { verify: { failed: { kind: "usage_limit", text: null } } as never });
    expect(reuseRefusal("review", a([run("a", "completed"), limited]), opts(), FP, false, 2)).toContain("has 1 finished runs of 2");
    expect(reuseRefusal("review", cut, opts(), FP, true, 2)).toBe(
      "Refused: the stored review candidate has 1 finished runs of 2 (2 cases x 1 repeats).",
    );
  });

  test("--resume needs --results, also for a candidate run, and reaches only the runner arguments of its run", () => {
    expect(parseAb(["--resume"])).toEqual({ error: "--resume needs --results." });
    expect(parseAb(["--resume", "--results", "r"])).toMatchObject({ resume: true, baselineOnly: false });
    expect(parseAb(["--resume", "--results", "r", "--baseline-only"])).toMatchObject({ resume: true });
    expect(parseAb(["--resume", "--results", "r", "--candidate-replay"])).toMatchObject({ resume: true, replay: true });
    expect(parseAb([])).toMatchObject({ resume: false });
    const args = runArgs("review", "baseline", opts(), "out", [], undefined, "cut.json");
    expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", "cut.json"]);
    expect(runArgs("review", "baseline", opts(), "out")).not.toContain("--resume");
  });

  test("--resume refuses each run flag that differs from the cut run and names it; a baseline-only run can lower --repeat", () => {
    const parsed = (argv: string[]) => {
      const o = parseAb(argv);
      if ("error" in o) throw new Error(o.error);
      return o;
    };
    const cut = ["--clean", "8", "--repeat", "2", "--candidate-variants", "broad", "--candidate-effort", "low", "--review-only"];
    const saved = runFlags(parsed(cut));
    expect(flagsRefusal(saved, parsed(cut))).toBeNull();
    // A changed or dropped flag of the cut run, and a flag that it did not have.
    const changes: [string[], string][] = [
      [cut.map((x) => (x === "broad" ? "verify2" : x)), "--candidate-variants broad, but this run has --candidate-variants verify2."],
      [cut.map((x) => (x === "low" ? "high" : x)), "--candidate-effort low, but this run has --candidate-effort high."],
      [
        [...cut, "--candidate-reviewer-effort", "high"],
        "--candidate-reviewer-effort none, but this run has --candidate-reviewer-effort high.",
      ],
      [[...cut, "--candidate-reviewer-mode", "off"], "--candidate-reviewer-mode none, but this run has --candidate-reviewer-mode off."],
      [cut.map((x) => (x === "2" ? "3" : x)), "--repeat 2, but this run has --repeat 3."],
      [[...cut, "--candidate-repeat", "1"], "--candidate-repeat none, but this run has --candidate-repeat 1."],
      [cut.filter((x) => x !== "--review-only"), "--review-only on, but this run has --review-only off."],
      [cut.map((x) => (x === "8" ? "4" : x)), "--clean 8, but this run has --clean 4."],
    ];
    for (const [argv, why] of changes)
      expect(flagsRefusal(saved, parsed(argv))).toBe(`Refused: --resume: the cut run had ${why} Give the flags of the cut run.`);
    // --candidate-replay refuses a finder change, so it compares on a cut run that changes only the verifier.
    const verify = ["--candidate-verifier-effort", "high"];
    expect(flagsRefusal(runFlags(parsed(verify)), parsed([...verify, "--candidate-replay"]))).toBe(
      "Refused: --resume: the cut run had --candidate-replay off, but this run has --candidate-replay on. Give the flags of the cut run.",
    );
    const only = ["--repeat", "3", "--baseline-only", "--review-only"];
    expect(flagsRefusal(runFlags(parsed(only)), parsed(["--repeat", "2", "--baseline-only", "--review-only"]))).toBeNull();
    expect(flagsRefusal(runFlags(parsed(only)), parsed(["--repeat", "3", "--baseline-only"]))).toContain("--review-only on");
  });

  test("Gate JC-A: --candidate-jira-family and --candidate-tasks-overlay reach only the candidate, and --resume checks them", () => {
    const file = join(TMP, "overlay-flag.json");
    writeFileSync(file, "{}");
    const o = parseAb(["--candidate-jira-family", "--candidate-tasks-overlay", file]);
    if ("error" in o) throw new Error(o.error);
    expect([o.jiraFamily, o.tasksOverlay]).toEqual([true, file]);
    const cand = runArgs("review", "candidate", o, "out");
    expect(cand).toContain("--jira-family");
    expect(cand.slice(cand.indexOf("--tasks-overlay"), cand.indexOf("--tasks-overlay") + 2)).toEqual(["--tasks-overlay", file]);
    const base = runArgs("review", "baseline", o, "out");
    expect(base).not.toContain("--jira-family");
    expect(base).not.toContain("--tasks-overlay");
    expect(parseAb(["--candidate-tasks-overlay", join(TMP, "none.json")])).toEqual({
      error: `--candidate-tasks-overlay: no file ${join(TMP, "none.json")}.`,
    });
    expect(parseAb(["--candidate-tasks-overlay", file, "--candidate-replay"])).toEqual({
      error: "--candidate-replay replays the finder of the baseline, but --candidate-tasks-overlay changes the finder input.",
    });
    expect(parseAb(["--candidate-jira-family", "--candidate-replay"])).toMatchObject({ error: expect.stringContaining("jiraFamily") });
    // A cut run of an earlier version recorded neither flag: off and none.
    const old = runFlags(opts());
    delete old["--candidate-jira-family"];
    delete old["--candidate-tasks-overlay"];
    expect(flagsRefusal(old, opts())).toBeNull();
    expect(flagsRefusal(old, opts({ jiraFamily: true }))).toBe(
      "Refused: --resume: the cut run had --candidate-jira-family off, but this run has --candidate-jira-family on. Give the flags of the cut run.",
    );
  });

  test("a usage limit in the finder or the verify phase counts as a limit, a failed or completed run does not", () => {
    const run = (o: Partial<EvalResult["runs"][number]>) => ({ case: "a", repeat: 1, status: "completed", errorKind: null, ...o }) as never;
    expect(LIMIT_EXIT).toBe(3);
    expect(endedOnLimit({ runs: [run({}), run({ status: "failed", errorKind: "usage_limit" })] })).toBe(true);
    expect(endedOnLimit({ runs: [run({ status: "incomplete", verify: { failed: { kind: "usage_limit", text: null } } as never })] })).toBe(
      true,
    );
    expect(endedOnLimit({ runs: [run({}), run({ status: "failed", errorKind: "process" })] })).toBe(false);
  });

  test("a repeat-2 candidate reuses a repeat-3 baseline, also with no --repeat", () => {
    const a = { ...header("review", "baseline"), repeat: 3 };
    expect(reuseRefusal("review", a, opts({ candidateRepeat: "2" }), FP)).toBeNull();
    expect(reuseRefusal("review", a, opts({ repeat: "3", candidateRepeat: "2" }), FP)).toBeNull();
    expect(reuseRefusal("review", a, opts(), FP)).toBeNull();
    expect(reuseRefusal("review", a, opts({ candidateRepeat: "4" }), FP)).toContain("ran with --repeat 3, but the candidate runs 4");
  });

  test("a stored candidate of the current shipped profile passes with an older profile version, a stored baseline does not", () => {
    const a = { ...header("review", "baseline"), profileVersion: PROFILES_VERSION - 1 };
    expect(reuseRefusal("review", a, opts(), FP)).toContain(`but the shipped profile is now version ${PROFILES_VERSION}`);
    expect(reuseRefusal("review", a, opts(), FP, true)).toBeNull();
    // The revision still decides: a candidate with its own module is no baseline.
    const b = header("review", "candidate", opts({ variants: [] }));
    expect(reuseRefusal("review", b, opts(), FP, true)).toContain("Refused: the stored review candidate ran profile revision");
  });

  test("the profile warning shows only when the base profiles differ", () => {
    const warn = "A and B used different profiles";
    for (const mode of ["review", "rereview"] as const) {
      const a = header(mode, "baseline");
      const b = header(mode, "candidate");
      expect(b.profile.revision).not.toBe(a.profile.revision);
      expect(modeText(mode, a, b, ["a", "b"])).not.toContain(warn);
      const other = { ...b.profile, note: "another base profile" };
      expect(modeText(mode, a, { ...b, profile: { ...other, revision: profileRevision(other as never) } }, ["a", "b"])).toContain(warn);
    }
  });
});

describe("eval:ab --large (docs/plans/review-v3.md WP-V13)", () => {
  const baseProfile = () => {
    const p = parseOptions(runArgs("review", "baseline", opts(), ""));
    const e = "error" in p ? p : evalProfile(p);
    if ("error" in e) throw new Error(e.error);
    return e.profile;
  };

  test(
    "picks a case at 1,200 changed lines and a case at 30 files, and skips a case of 29 files",
    async () => {
      const root = join(TMP, "large");
      const src = join(root, "src");
      mkdirSync(src, { recursive: true });
      const genv = { ...env };
      await git(["init", "-q", "--template=", src], { env: genv });
      writeFileSync(join(src, "README"), "base\n");
      await git(["-C", src, "add", "."], { env: genv });
      await git(["-C", src, "commit", "-q", "-m", "base"], { env: genv });
      const base = (await git(["-C", src, "rev-parse", "HEAD"], { env: genv })).trim();
      const head = async (branch: string, files: Record<string, string>) => {
        await git(["-C", src, "checkout", "-q", "-b", branch, base], { env: genv });
        for (const [p, text] of Object.entries(files)) {
          mkdirSync(join(src, p, ".."), { recursive: true });
          writeFileSync(join(src, p), text);
        }
        await git(["-C", src, "add", "."], { env: genv });
        await git(["-C", src, "commit", "-q", "-m", branch], { env: genv });
        return (await git(["-C", src, "rev-parse", "HEAD"], { env: genv })).trim();
      };
      const lines = (n: number) => `${Array.from({ length: n }, (_, k) => `line ${k}`).join("\n")}\n`;
      const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, k) => [`f/${k}.ts`, "x\n"]));
      const heads = {
        lines: await head("lines", { "big.ts": lines(1200) }),
        files: await head("files", many(30)),
        // 28 new files and one changed file: 29 files, 30 changed lines.
        small: await head("small", { ...many(28), README: "base\nmore\n" }),
      };
      const bundle = join(root, "repo.bundle");
      await git(["-C", src, "bundle", "create", "-q", bundle, "--all"], { env: genv });
      const cases = Object.entries(heads).map(([id, h]) => ({ id, local: { bundle, base, head: h, hash: id } }));
      expect(await largeCases([...cases, { id: "fixture" }], baseProfile(), mkdtempSync(join(root, "tmp-")))).toEqual(["lines", "files"]);
    },
    SLOW,
  );

  const FULL = "f".repeat(64);
  const SUB = "5".repeat(64);
  const caseInfo = (id: string) => ({ id, title: id, language: "ts", changedLines: 1, base: "b", head: "h", bugs: [], traps: [] });
  const caseRun = (id: string, repeat = 1) => ({ case: id, repeat, status: "completed" }) as EvalResult["runs"][number];
  const full = (): EvalResult => ({
    ...header("review", "baseline"),
    cases: ["a", "b", "c"].map(caseInfo),
    runs: [caseRun("a"), caseRun("b"), caseRun("c")],
  });

  test("a full-set baseline passes the reuse checks, then keeps only the large runs with the subset fingerprint", () => {
    const cut = largeBaseline(full(), opts(), FULL, SUB, ["a", "c"]);
    if (typeof cut === "string") throw new Error(cut);
    expect(cut.fingerprint).toBe(SUB);
    expect(cut.cases.map((c) => c.id)).toEqual(["a", "c"]);
    expect(cut.runs.map((r) => r.case)).toEqual(["a", "c"]);
    // A large baseline from an earlier --large run passes as it is.
    expect(largeBaseline(cut, opts(), FULL, SUB, ["a", "c"])).toBe(cut);
  });

  test("a stored baseline with another full fingerprint, another repeat, or no run of a large case is refused", () => {
    expect(largeBaseline(full(), opts(), "e".repeat(64), SUB, ["a"])).toContain("ran case set ffffffffffff");
    expect(largeBaseline(full(), opts({ repeat: "2" }), FULL, SUB, ["a"])).toContain("ran with --repeat 1");
    expect(largeBaseline(full(), opts(), FULL, SUB, ["a", "d"])).toBe("Refused: the stored review baseline has no run of 1 large case.");
  });

  test("--large and --candidate-reviewer-effort parse, reach the runner arguments, and a bad effort is an error", () => {
    expect(parseAb(["--large"])).toMatchObject({ large: true, reviewerEffort: null });
    expect(parseAb([])).toMatchObject({ large: false });
    const o = parseAb(["--candidate-reviewer-effort", "xhigh"]);
    if ("error" in o) throw new Error(o.error);
    expect(o.reviewerEffort).toBe("xhigh");
    const cand = runArgs("review", "candidate", o, "", ["a", "c"]);
    expect(cand.slice(0, 6)).toEqual(["--set", "local", "--repeat", "1", "--cases", "a,c"]);
    expect(cand[cand.indexOf("--reviewer-effort") + 1]).toBe("xhigh");
    expect(runArgs("review", "baseline", o, "")).not.toContain("--reviewer-effort");
    expect(runArgs("review", "baseline", o, "")).not.toContain("--cases");
    expect(parseAb(["--candidate-reviewer-effort", "bogus"])).toMatchObject({
      error: expect.stringContaining("--candidate-reviewer-effort must be one of"),
    });
  });

  test("--candidate-verifier reaches only the candidate runner arguments, and a bad mode is an error", () => {
    expect(parseAb([])).toMatchObject({ verifier: null });
    const o = parseAb(["--candidate-verifier", "off"]);
    if ("error" in o) throw new Error(o.error);
    for (const mode of ["review", "rereview"] as const) {
      const cand = runArgs(mode, "candidate", o, "");
      expect(cand[cand.indexOf("--verifier") + 1]).toBe("off");
      expect(runArgs(mode, "baseline", o, "")).not.toContain("--verifier");
    }
    expect(runArgs("review", "candidate", opts(), "")).not.toContain("--verifier");
    expect(parseAb(["--candidate-verifier", "bogus"])).toMatchObject({ error: expect.stringContaining("--verifier must be one of") });
  });

  test(
    "the command exits 2 on a bad --candidate-reviewer-effort",
    async () => {
      const r = await bun([AB, "--candidate-reviewer-effort", "bogus"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--candidate-reviewer-effort must be one of");
    },
    SLOW,
  );
});

describe("eval:ab arguments", () => {
  test("defaults, overrides, and the build flags", () => {
    const o = parseAb(["--repeat", "2", "--db", "x.sqlite", "--clean", "8", "--runner", "cli", "a"]);
    if ("error" in o) throw new Error(o.error);
    expect(o).toMatchObject({
      repeat: "2",
      candidateRepeat: null,
      variants: [],
      modules: [],
      baseEffort: null,
      effort: null,
      reviewerMode: null,
      verifierEffort: null,
      replay: false,
      baselineOnly: false,
      reviewOnly: false,
      runner: ["cli", "a"],
    });
    // eval:local gets --clean, so the rebuilt set keeps the clean cases of a stored baseline.
    expect(o.build).toEqual(["--db", "x.sqlite", "--clean", "8"]);
    expect(parseAb(["--candidate-repeat", "2", "--candidate-replay", "--baseline-only", "--review-only"])).toMatchObject({
      error: expect.stringContaining("--baseline-only runs only the baseline"),
    });
    expect(parseAb(["--candidate-repeat", "2", "--review-only", "--baseline-only"])).toMatchObject({
      candidateRepeat: "2",
      reviewOnly: true,
      baselineOnly: true,
    });
    expect(parseAb(["--candidate-repeat", "0"])).toMatchObject({ error: expect.stringContaining("--repeat must be") });
    const none = parseAb(["--candidate-variants", "", "--candidate-modules", ""]);
    expect(none).toMatchObject({ variants: [], modules: [] });
    expect(parseAb(["--candidate-effort", "max"])).toMatchObject({ effort: "max" });
    expect(parseAb(["--effort", "medium"])).toMatchObject({ baseEffort: "medium", effort: null });
  });

  test("unknown names, a bad repeat, and an unknown flag are errors", () => {
    expect(parseAb(["--candidate-variants", "loud"])).toMatchObject({ error: expect.stringContaining("--variants must be") });
    expect(parseAb(["--candidate-modules", "magic"])).toMatchObject({ error: expect.stringContaining("--modules must be") });
    expect(parseAb(["--candidate-variants", "rules3"])).toMatchObject({ error: expect.stringContaining("--variants must be") });
    expect(parseAb(["--candidate-effort", "huge"])).toMatchObject({ error: expect.stringContaining("--candidate-effort must be one of") });
    expect(parseAb(["--effort", "huge"])).toMatchObject({ error: expect.stringContaining("--effort must be one of") });
    expect(parseAb(["--repeat", "0"])).toMatchObject({ error: expect.stringContaining("--repeat must be") });
    expect("error" in parseAb(["--set", "v1"])).toBe(true);
    expect(parseAb(["--runner"])).toMatchObject({ error: "--runner needs a command." });
    expect(parseAb(["--baseline", join(TMP, "no-such-folder")])).toMatchObject({ error: expect.stringContaining("--baseline: no folder") });
  });

  test("the candidate of each mode", () => {
    const shippedModules = "security,concurrency,api,rules,intent";
    expect(runArgs("review", "baseline", opts(), "o")).toEqual([
      "--set",
      "local",
      "--repeat",
      "1",
      "--ordinals",
      "--out",
      "o",
      "--runner",
      "fake",
    ]);
    expect(runArgs("review", "candidate", opts(), "o")).toEqual([
      ...["--set", "local", "--repeat", "1", "--variants", "broad,verify2", "--modules", `${shippedModules},failures`],
      ...["--ordinals", "--out", "o", "--runner", "fake"],
    ]);
    // --candidate-effort: only the candidate gets --effort.
    expect(runArgs("review", "candidate", opts({ effort: "xhigh" }), "")).toEqual([
      ...["--set", "local", "--repeat", "1", "--variants", "broad,verify2", "--modules", `${shippedModules},failures`],
      ...["--effort", "xhigh", "--ordinals", "--runner", "fake"],
    ]);
    expect(runArgs("review", "baseline", opts({ effort: "xhigh" }), "")).not.toContain("--effort");
    // --effort: both sides get it. --candidate-effort overrides the candidate only.
    const effortOf = (a: string[]) => a[a.indexOf("--effort") + 1];
    for (const mode of ["review", "rereview"] as const) {
      expect(effortOf(runArgs(mode, "baseline", opts({ baseEffort: "medium" }), ""))).toBe("medium");
      expect(effortOf(runArgs(mode, "candidate", opts({ baseEffort: "medium" }), ""))).toBe("medium");
      expect(effortOf(runArgs(mode, "baseline", opts({ baseEffort: "medium", effort: "low" }), ""))).toBe("medium");
      expect(effortOf(runArgs(mode, "candidate", opts({ baseEffort: "medium", effort: "low" }), ""))).toBe("low");
    }
    expect(runArgs("rereview", "baseline", opts({ runner: null }), "")).toEqual([
      "--set",
      "local",
      "--repeat",
      "1",
      "--rereview",
      "--ordinals",
      "--real",
    ]);
    // A re-review candidate gets the same variants as a review candidate.
    expect(runArgs("rereview", "candidate", opts({ runner: null }), "")).toEqual([
      ...["--set", "local", "--repeat", "1", "--rereview", "--variants", "broad,verify2"],
      ...["--modules", `${shippedModules},failures`, "--ordinals", "--real"],
    ]);
    // Bisect: no variants and no extra module.
    const bare = opts({ variants: [], modules: [] });
    for (const mode of ["review", "rereview"] as const)
      expect(runArgs(mode, "candidate", bare, "")).toEqual([
        ...["--set", "local", "--repeat", "1", ...(mode === "rereview" ? ["--rereview"] : [])],
        ...["--modules", shippedModules, "--ordinals", "--runner", "fake"],
      ]);
  });

  // review-quality-2026.md WP-R1: the retired variants are refused before any build.
  test("--candidate-variants takes broad and verify2 and refuses the retired variants", () => {
    expect(parseAb(["--candidate-variants", "broad"])).toMatchObject({ variants: ["broad"] });
    expect(parseAb(["--candidate-variants", "verify2,broad"])).toMatchObject({ variants: ["verify2", "broad"] });
    // review-quality-2026.md item 7.
    expect(parseAb(["--candidate-variants", "classes"])).toMatchObject({ variants: ["classes"] });
    // review-quality-2026.md item 10.
    expect(parseAb(["--candidate-variants", "security2"])).toMatchObject({ variants: ["security2"] });
    expect(parseAb(["--candidate-variants", "security2-verify"])).toMatchObject({ variants: ["security2-verify"] });
    // review-v3.md WP-V6 and the caller rule, with the flags of the Gate A command.
    const gate = ["--review-only", "--clean", "8", "--repeat", "2"];
    expect(parseAb([...gate, "--candidate-variants", "preexisting"])).toMatchObject({ variants: ["preexisting"], reviewOnly: true });
    expect(parseAb([...gate, "--candidate-variants", "callers"])).toMatchObject({ variants: ["callers"], repeat: "2" });
    expect(parseAb([...gate, "--candidate-variants", "preexisting,callers"])).toMatchObject({ variants: ["preexisting", "callers"] });
    for (const retired of ["signal", "order", "rules2", "rereview-strict"])
      expect(parseAb(["--candidate-variants", retired])).toMatchObject({
        error: expect.stringContaining(
          "--variants must be a comma list of broad, callers, classes, obligations, parts, preexisting, risk-check, security2, security2-verify, verify2.",
        ),
      });
  });

  test("the default candidate equals the baseline in both modes", () => {
    const o = parseAb([]);
    if ("error" in o) throw new Error(o.error);
    const revision = (mode: "review" | "rereview", side: "baseline" | "candidate") => header(mode, side, o).profile.revision;
    for (const mode of ["review", "rereview"] as const) expect(revision(mode, "candidate")).toBe(revision(mode, "baseline"));
  });

  test("the reviewer mode, verify effort, and candidate repeat reach only the candidate runner arguments", () => {
    const o = parseAb([
      ...["--repeat", "3", "--candidate-repeat", "2", "--candidate-reviewer-mode", "off"],
      ...["--candidate-verifier-effort", "high"],
    ]);
    if ("error" in o) throw new Error(o.error);
    const at = (a: string[], flag: string) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
    for (const mode of ["review", "rereview"] as const) {
      const base = runArgs(mode, "baseline", o, "");
      const cand = runArgs(mode, "candidate", o, "", [], "r.json");
      expect([at(base, "--repeat"), at(base, "--reviewer-mode"), at(base, "--verifier-effort"), at(base, "--replay-find")]).toEqual([
        "3",
        undefined,
        undefined,
        undefined,
      ]);
      expect([at(cand, "--repeat"), at(cand, "--reviewer-mode"), at(cand, "--verifier-effort")]).toEqual(["2", "off", "high"]);
      expect(at(cand, "--replay-find")).toBe("r.json");
    }
    expect(parseAb(["--candidate-reviewer-mode", "bogus"])).toMatchObject({ error: expect.stringContaining("--reviewer-mode must be") });
    expect(parseAb(["--candidate-verifier-effort", "bogus"])).toMatchObject({
      error: expect.stringContaining("--verifier-effort must be"),
    });
  });

  test("--candidate-replay refuses a candidate flag that changes the finder, and keeps the verifier flags", () => {
    for (const flags of [
      ["--candidate-effort", "low"],
      ["--candidate-reviewer-effort", "low"],
      ["--candidate-reviewer-mode", "off"],
      ["--candidate-modules", "failures"],
      ["--candidate-variants", "broad"],
      ["--candidate-variants", "broad,verify2"],
      ["--candidate-variants", "classes"],
      ["--candidate-variants", "security2"],
      // review-v3.md WP-V6 and the caller rule change the finder prompt.
      ["--candidate-variants", "preexisting"],
      ["--candidate-variants", "callers"],
      // catalog.ts checked(): the verify mode changes the finder prompt.
      ["--candidate-verifier", "off"],
    ])
      expect(parseAb(["--candidate-replay", ...flags])).toMatchObject({
        error: expect.stringContaining("--candidate-replay replays the finder of the baseline, but the candidate changes"),
      });
    expect(parseAb(["--candidate-replay", "--candidate-verifier-effort", "high"])).toMatchObject({ replay: true, verifierEffort: "high" });
    // review-quality-2026.md item 4: verify2 changes only the verify prompts, so a replay can test it.
    expect(parseAb(["--candidate-replay", "--candidate-variants", "verify2"])).toMatchObject({ replay: true, variants: ["verify2"] });
    // review-quality-2026.md item 10: security2-verify is the verify half of security2.
    expect(parseAb(["--candidate-replay", "--candidate-variants", "security2-verify"])).toMatchObject({
      replay: true,
      variants: ["security2-verify"],
    });
    // risk-check.md section 7: the risk check changes only the verify prompts.
    expect(parseAb(["--candidate-replay", "--candidate-variants", "risk-check"])).toMatchObject({ replay: true, variants: ["risk-check"] });
    // obligations.md section 8: the obligation check changes only the verify prompts.
    expect(parseAb(["--candidate-replay", "--candidate-variants", "risk-check,obligations"])).toMatchObject({
      replay: true,
      variants: ["risk-check", "obligations"],
    });
    // --effort changes both sides, so the finder of the replay matches its baseline.
    expect(parseAb(["--candidate-replay", "--effort", "medium"])).toMatchObject({ replay: true });
  });

  test(
    "the command exits 2 on --candidate-replay with a finder flag, before any build",
    async () => {
      const r = await bun([AB, "--candidate-replay", "--candidate-effort", "low"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--candidate-replay replays the finder of the baseline, but the candidate changes effort");
      expect(r.stdout).not.toContain("Local eval set");
    },
    SLOW,
  );

  test("a run that did not finish counts as failed, an incomplete run does not", () => {
    const r = { runs: [{ status: "completed" }, { status: "incomplete" }, { status: "failed" }, { status: "error" }] };
    expect(failedRuns(r as unknown as EvalResult)).toBe(2);
  });

  test(
    "the command refuses an unknown name and an --out folder in the live data folder",
    async () => {
      const bad = await bun([AB, "--candidate-modules", "magic"]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("--modules must be");
      const inLive = await bun([AB, "--out", join(LIVE, "eval-local"), "--runner", "fake"]);
      expect(inLive.code).toBe(2);
      expect(inLive.stderr).toContain("Refused: --out is inside the live data folder");
    },
    SLOW,
  );
});

describe("eval:ab end to end with the fake CLI", () => {
  const dir = join(TMP, "fake");
  const scenario = join(dir, "scenario.json");
  const out = join(TMP, "set", "eval-local");
  const results = join(TMP, "results");
  // The fake CLI records each call, the auth check included.
  const calls = () =>
    readFileSync(join(dir, "calls.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"argv"')).length;
  let firstRun = 0;
  test(
    "builds from the live folder without a write, runs baseline and candidate, and skips the re-review mode",
    async () => {
      mkdirSync(dir);
      const text = fileAt(CHANGED).split("\n");
      writeFileSync(
        scenario,
        JSON.stringify({
          record: join(dir, "calls.jsonl"),
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", {
            summary: "Fake review.",
            risks: [],
            questions: [],
            coverage: { read: [PATH], skipped: [], unavailable: [], notChecked: [] },
            findings: [
              {
                path: PATH,
                side: "new",
                line: 11,
                lineEnd: 11,
                anchorText: text[10] ?? "",
                severity: "major",
                category: "logic",
                body: "A finding of the fake CLI.",
                evidence: `${PATH}:11`,
                evidenceStatus: "code",
                confidence: "high",
                agent: null,
              },
            ],
          }),
          delayMs: 1,
        }),
      );
      const r = await bun([
        AB,
        "--out",
        out,
        "--results",
        results,
        "--candidate-effort",
        "low",
        "--runner",
        process.execPath,
        FAKE,
        scenario,
      ]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);

      // The live folder: same files, same bytes, same times. Same worktrees, objects, and refs.
      expect(snapshot(LIVE)).toEqual(before);
      expect<string[]>(await gitState()).toEqual(gitBefore);

      expect(r.stdout).toContain("Local eval set: 1 cases");
      expect(r.stdout).toContain("== Review cases: 1 cases x 1 ==");
      expect(r.stdout).toContain("== Re-review cases: skipped, the set has none ==");
      expect(r.stdout).toMatch(/recall: seeded bugs with a shown finding\s+100\.0%\s+100\.0%\s+\+0\.0 pts/);
      expect(r.stdout).toContain("Failed runs: baseline 0, candidate 0.");
      const file = (side: string) => {
        const d = join(results, `review-${side}`);
        const [f] = readdirSync(d).filter((x) => x.endsWith(".json"));
        expect(r.stdout).toContain(join(d, f as string));
        return JSON.parse(readFileSync(join(d, f as string), "utf8")) as EvalResult & {
          profile: { modules: string[]; variants: string[] };
        };
      };
      const a = file("baseline");
      const b = file("candidate");
      // No case ID, repository name, PR title, or set path in the output. The case shows as an ordinal.
      const id = a.cases[0]?.id as string;
      expect(id).toBeTruthy();
      for (const s of [id, REPO_NAME, PR_TITLE, PATH, out]) expect(r.stdout).not.toContain(s);
      expect(r.stdout).toContain("[1/1] case 1 #1:");
      // The default candidate adds nothing to the shipped profile.
      expect(a.profile.variants).toEqual([]);
      expect(a.profile.modules).not.toContain("failures");
      expect(b.profile.variants).toEqual([]);
      expect(b.profile.modules).toEqual(a.profile.modules);
      expect(a.requested?.effort).not.toBe("low");
      expect(b.requested?.effort).toBe("low");
      expect(a.fingerprint).toBe(b.fingerprint as string);
      expect(readdirSync(results).sort()).toEqual([FLAGS_FILE, "review-baseline", "review-candidate"]);
      firstRun = calls();
    },
    SLOW,
  );

  const run = (args: string[]) => bun([AB, "--out", out, ...args, "--runner", process.execPath, FAKE, scenario]);

  test(
    "--baseline reuses the stored baseline and runs only the candidate",
    async () => {
      expect(firstRun).toBeGreaterThan(0);
      const before = calls();
      const again = join(TMP, "results-reuse");
      const r = await run(["--results", again, "--baseline", results]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(calls() - before).toBe(firstRun / 2);
      const [a] = readdirSync(join(results, "review-baseline")).filter((x) => x.endsWith(".json"));
      const stored = join(results, "review-baseline", a as string);
      expect(r.stdout).toContain(`--- review baseline: reused ${stored} ---`);
      expect(r.stdout).toContain(`Result A: ${stored}`);
      expect(r.stdout).toContain("== Review cases: 1 cases x 1 ==");
      // Same base profile, same effort: the candidate adds only variants and modules.
      expect(r.stdout).not.toContain("A and B used different profiles");
      expect(readdirSync(again).sort()).toEqual([FLAGS_FILE, "review-candidate"]);
    },
    SLOW,
  );

  test(
    "Gate JC-A: the candidate seeds the overlay rows with jiraFamily on, and the baseline keeps the stored rows",
    async () => {
      expect(firstRun).toBeGreaterThan(0);
      const taskFiles = () =>
        readRecords<{ argv: string[]; context?: Record<string, string> }>(join(dir, "calls.jsonl"))
          .filter((x) => x.argv.includes("-p"))
          .map((x) => x.context?.["task.md"] ?? "");
      const seen = taskFiles().length;
      const [stored] = readdirSync(join(results, "review-baseline")).filter((x) => x.endsWith(".json"));
      const c = (JSON.parse(readFileSync(join(results, "review-baseline", stored as string), "utf8")) as EvalResult).cases[0];
      const issue = {
        key: "ABC-12",
        summary: "Add the calc helpers",
        status: "In Progress",
        description: "Overlay task text.",
        comments: [],
        commentsTotal: 0,
        truncated: false,
        format: "markdown",
        parent: "ABC-10",
        type: "Story",
        texts: [{ id: "customfield_10100", name: "Acceptance criteria", text: "Each helper adds one." }],
        related: [{ key: "ABC-31", text: "blocks", summary: "Remove the old helpers", status: "Done", category: "done", type: "Task" }],
        parentIssue: { key: "ABC-10", summary: "Calc rework", status: "In Progress", description: "Parent text.", truncated: false },
      };
      const file = join(TMP, "tasks-overlay.json");
      const text = `${JSON.stringify({ format: 1, cases: [{ id: c?.id, head: c?.head, tasks: { "ABC-12": JSON.stringify(issue) } }] })}\n`;
      writeFileSync(file, text);
      const out = join(TMP, "results-overlay");
      const r = await run(["--results", out, "--baseline", results, "--candidate-tasks-overlay", file, "--candidate-jira-family"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const before = taskFiles().slice(0, seen).filter(Boolean);
      const after = taskFiles().slice(seen).filter(Boolean);
      expect(before.length).toBeGreaterThan(0);
      for (const t of before) {
        expect(t).toContain("Stored task text.");
        expect(t).not.toContain("### Linked issues");
      }
      expect(after.length).toBeGreaterThan(0);
      for (const t of after) {
        expect(t).toContain("Overlay task text.");
        expect(t).toContain("- Type: Story\n");
        expect(t).toContain("### Acceptance criteria\n\nEach helper adds one.\n");
        expect(t).toContain("- ABC-12 blocks ABC-31: Remove the old helpers (Done, Task)");
        expect(t).toContain("### Parent ABC-10: Calc rework");
      }
      const [b] = readdirSync(join(out, "review-candidate")).filter((x) => x.endsWith(".json"));
      const cand = JSON.parse(readFileSync(join(out, "review-candidate", b as string), "utf8")) as EvalResult & {
        profile: { jiraFamily: boolean };
      };
      expect(cand.profile.jiraFamily).toBe(true);
      expect(cand.requested?.tasksOverlay).toBe(createHash("sha256").update(text).digest("hex").slice(0, 12));
      expect(r.stdout).not.toContain(c?.id as string);
    },
    SLOW,
  );

  test(
    "--baseline takes a stored candidate of the shipped profile when the folder has no baseline",
    async () => {
      // results-reuse holds only the default candidate of the test above: the shipped profile.
      const reuse = join(TMP, "results-reuse");
      const before = calls();
      const r = await run(["--results", join(TMP, "results-from-candidate"), "--baseline", reuse]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const [b] = readdirSync(join(reuse, "review-candidate")).filter((x) => x.endsWith(".json"));
      expect(r.stdout).toContain(`--- review baseline: reused ${join(reuse, "review-candidate", b as string)} ---`);
      expect(calls() - before).toBe(firstRun / 2);
    },
    SLOW,
  );

  test(
    "--baseline refuses a stored baseline of another repeat count or effort, before any run",
    async () => {
      const before = calls();
      const repeat = await run(["--results", join(TMP, "results-refused"), "--baseline", results, "--repeat", "2"]);
      expect(repeat.code).toBe(2);
      expect(repeat.stderr).toContain("Refused: the stored review baseline ran with --repeat 1, but the candidate runs 2 repeats.");
      const effort = await run(["--results", join(TMP, "results-refused"), "--baseline", results, "--effort", "max"]);
      expect(effort.code).toBe(2);
      expect(effort.stderr).toContain("but this run needs effort max.");
      expect(calls()).toBe(before);
    },
    SLOW,
  );

  test(
    "--large on a set with no large case exits 2 before any run",
    async () => {
      const before = calls();
      const r = await run(["--results", join(TMP, "results-large"), "--large", "--baseline", results]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--large: no review case of the set gives the baseline the rl-reviewer agent.");
      expect(calls()).toBe(before);
    },
    SLOW,
  );

  test(
    "--baseline without a review-baseline folder runs the baseline",
    async () => {
      const empty = join(TMP, "no-baseline");
      mkdirSync(empty);
      const before = calls();
      const again = join(TMP, "results-fallback");
      const r = await run(["--results", again, "--baseline", empty]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`No review baseline in ${empty}, so the review baseline runs.`);
      expect(calls() - before).toBe(firstRun);
      expect(readdirSync(again).sort()).toEqual([FLAGS_FILE, "review-baseline", "review-candidate"]);
    },
    SLOW,
  );

  test(
    "--baseline-only records the calls, and --candidate-replay on that baseline runs only the verify calls",
    async () => {
      const only = join(TMP, "results-only");
      const r = await run(["--results", only, "--baseline-only", "--review-only"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("== Review cases: 1 cases x 1, baseline only ==");
      expect(r.stdout).toContain("== Re-review cases: skipped, --review-only ==");
      expect(readdirSync(only).sort()).toEqual([FLAGS_FILE, "review-baseline"]);
      const base = join(only, "review-baseline");
      const file = readdirSync(base).find((f) => f.endsWith(".json")) as string;
      const a = JSON.parse(readFileSync(join(base, file), "utf8")) as EvalResult;
      const id = a.cases[0]?.id as string;
      expect(readdirSync(callsDir(join(base, file))).sort()).toEqual([`${id}-1-1.json`, `${id}-1-2.json`]);

      const kinds = () =>
        readRecords<{ argv: string[] }>(join(dir, "calls.jsonl"))
          .filter((x) => x.argv.includes("-p"))
          .map((x) => schemaKind(JSON.parse(x.argv[x.argv.indexOf("--json-schema") + 1] ?? "{}").properties ?? {}));
      const before = kinds().length;
      const replayed = join(TMP, "results-replay");
      const c = await run(["--results", replayed, "--baseline", only, "--candidate-replay", "--candidate-verifier-effort", "high"]);
      expect(c.stderr).toBe("");
      expect(c.code).toBe(0);
      expect(c.stdout).toContain(`finder replayed from ${file}`);
      // The finder of the candidate came from the recording: the fake CLI saw only the verify call.
      expect(kinds().slice(before)).toEqual(["verify"]);
      const cand = join(replayed, "review-candidate");
      const b = JSON.parse(readFileSync(join(cand, readdirSync(cand).find((f) => f.endsWith(".json")) as string), "utf8")) as EvalResult;
      expect(b.requested).toMatchObject({ replayOf: file, verifierEffort: "high", reviewerMode: "auto" });
      expect(b.runs[0]?.items.map((i) => [i.path, i.line, i.verdict])).toEqual(a.runs[0]?.items.map((i) => [i.path, i.line, i.verdict]));
    },
    SLOW,
  );

  test(
    "--resume continues the cut baseline in its own file, and a lower --repeat works only when the finished runs fit",
    async () => {
      const res = join(TMP, "results-resume");
      const flags = ["--results", res, "--baseline-only", "--review-only"];
      const none = await run([...flags, "--resume"]);
      expect(none.code).toBe(2);
      expect(none.stderr).toContain(`--resume: ${res} holds no cut result.`);

      const first = await run([...flags, "--repeat", "2"]);
      expect(first.code).toBe(0);
      const base = join(res, "review-baseline");
      const name = readdirSync(base).find((f) => f.endsWith(".json")) as string;
      const file = join(base, name);
      const read = () => JSON.parse(readFileSync(file, "utf8")) as EvalResult;
      const a = read();
      expect(a.runs.map((x) => x.repeat)).toEqual([1, 2]);
      // A baseline of an earlier version has no flag record. A baseline-only resume works without it.
      rmSync(join(res, FLAGS_FILE));
      // The cut: the run of repeat 2 has no entry. Its calls stay on disk.
      writeFileSync(file, JSON.stringify({ ...a, runs: a.runs.slice(0, 1) }));
      // A cut result is no baseline to reuse.
      const reuse = await run(["--results", join(TMP, "results-resume-reuse"), "--baseline", res, "--repeat", "2"]);
      expect(reuse.code).toBe(2);
      expect(reuse.stderr).toContain("Refused: the stored review baseline has 1 finished runs of 2 (1 cases x 2 repeats).");

      const before = calls();
      const r = await run([...flags, "--repeat", "2", "--resume"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Resume: 1 of 2 runs are done.");
      expect(r.stdout).not.toContain("[1/2]");
      expect(r.stdout).toContain("[2/2] case 1 #2:");
      expect(calls() - before).toBe(firstRun / 2);
      expect(readdirSync(base).filter((f) => f.endsWith(".json"))).toEqual([name]);
      const b = read();
      expect(b.runs.map((x) => x.repeat)).toEqual([1, 2]);
      expect(b.runs[0]).toEqual(a.runs[0] as EvalResult["runs"][number]);
      expect(b.resumes).toHaveLength(1);

      // Repeat 2 holds a finished run, so --repeat 1 does not fit. The file stays as it is.
      const bytes = readFileSync(file, "utf8");
      const low = await run([...flags, "--repeat", "1", "--resume"]);
      expect(low.code).toBe(2);
      expect(low.stderr).toContain("Refused: --resume: 1 finished runs of the saved result are outside 1 cases x 1 repeats.");
      expect(readFileSync(file, "utf8")).toBe(bytes);
      // A cut in repeat 1 fits --repeat 1: no case run, the result takes repeat 1, and the calls of repeat 2 go.
      const id = a.cases[0]?.id as string;
      const pairOne = readdirSync(callsDir(file)).filter((f) => f.startsWith(`${id}-1-`));
      expect(pairOne.length).toBeGreaterThan(0);
      writeFileSync(file, JSON.stringify({ ...b, runs: b.runs.slice(0, 1) }));
      const fit = await run([...flags, "--repeat", "1", "--resume"]);
      expect(fit.stderr).toBe("");
      expect(fit.code).toBe(0);
      expect(fit.stdout).toContain("Resume: 1 of 1 runs are done.");
      expect(read()).toMatchObject({ repeat: 1, runs: [b.runs[0]] });
      expect(readdirSync(callsDir(file)).sort()).toEqual(pairOne.sort());
    },
    SLOW,
  );

  const resultIn = (d: string) => join(d, readdirSync(d).find((f) => f.endsWith(".json")) as string);
  const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8")) as EvalResult;

  test(
    "--resume continues a cut candidate run with --baseline, and refuses a changed flag or a missing flag record before any run",
    async () => {
      const res = join(TMP, "results-cand-resume");
      const flags = ["--results", res, "--baseline", results, "--candidate-effort", "low"];
      const first = await run(flags);
      expect(first.code).toBe(0);
      const file = resultIn(join(res, "review-candidate"));
      const a = readJson(file);
      writeFileSync(file, JSON.stringify({ ...a, runs: [] }));
      const bytes = readFileSync(file, "utf8");
      const before = calls();
      const effort = await run([...flags.slice(0, -2), "--resume"]);
      expect(effort.code).toBe(2);
      expect(effort.stderr).toContain(
        "Refused: --resume: the cut run had --candidate-effort low, but this run has --candidate-effort none. Give the flags of the cut run.",
      );
      const only = await run([...flags, "--review-only", "--resume"]);
      expect(only.code).toBe(2);
      expect(only.stderr).toContain("the cut run had --review-only off, but this run has --review-only on.");
      expect(calls()).toBe(before);
      expect(readFileSync(file, "utf8")).toBe(bytes);

      const r = await run([...flags, "--resume"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("--- review baseline: reused");
      expect(r.stdout).toContain("Resume: 0 of 1 runs are done.");
      expect(r.stdout).toContain("== Review cases: 1 cases x 1 ==");
      expect(calls() - before).toBe(firstRun / 2);
      expect(readdirSync(join(res, "review-candidate")).filter((f) => f.endsWith(".json"))).toEqual([basename(file)]);
      const b = readJson(file);
      expect(b.runs).toHaveLength(1);
      expect(b.resumes).toHaveLength(1);
      expect(b.requested?.effort).toBe("low");

      rmSync(join(res, FLAGS_FILE));
      const lost = await run([...flags, "--resume"]);
      expect(lost.code).toBe(2);
      expect(lost.stderr).toContain(`--resume: ${res} has no ${FLAGS_FILE}, so the flags of the cut run are not known.`);
    },
    SLOW,
  );

  test(
    "--resume continues a cut --candidate-replay run with only the verify calls",
    async () => {
      const only = join(TMP, "results-only");
      const replayed = join(TMP, "results-replay");
      const file = resultIn(join(replayed, "review-candidate"));
      const a = readJson(file);
      writeFileSync(file, JSON.stringify({ ...a, runs: [] }));
      const kinds = () =>
        readRecords<{ argv: string[] }>(join(dir, "calls.jsonl"))
          .filter((x) => x.argv.includes("-p"))
          .map((x) => schemaKind(JSON.parse(x.argv[x.argv.indexOf("--json-schema") + 1] ?? "{}").properties ?? {}));
      const before = kinds().length;
      const r = await run([
        "--results",
        replayed,
        "--baseline",
        only,
        "--candidate-replay",
        "--candidate-verifier-effort",
        "high",
        "--resume",
      ]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Resume: 0 of 1 runs are done.");
      expect(kinds().slice(before)).toEqual(["verify"]);
      const b = readJson(file);
      expect(b.resumes).toHaveLength(1);
      expect(b.runs.map((x) => x.items.map((i) => [i.path, i.line, i.verdict]))).toEqual(
        a.runs.map((x) => x.items.map((i) => [i.path, i.line, i.verdict])),
      );
    },
    SLOW,
  );

  test(
    "a usage limit exits 3 and stops before the candidate, and the same command with --resume finishes both sides",
    async () => {
      const limit = join(dir, "limit.json");
      writeFileSync(
        limit,
        JSON.stringify({
          record: join(dir, "calls.jsonl"),
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "limit", "claude-synthetic/usage-limit.jsonl"),
          exitCode: 1,
          delayMs: 1,
        }),
      );
      const res = join(TMP, "results-limit");
      const hit = await bun([AB, "--out", out, "--results", res, "--runner", process.execPath, FAKE, limit]);
      expect(hit.code).toBe(3);
      expect(hit.stderr).toContain(
        "The review baseline run hit the usage limit. Run the same command with --resume after the limit resets.",
      );
      expect(readdirSync(res).sort()).toEqual([FLAGS_FILE, "review-baseline"]);
      expect(readJson(resultIn(join(res, "review-baseline"))).runs[0]).toMatchObject({ status: "failed", errorKind: "usage_limit" });

      const r = await run(["--results", res, "--resume"]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("It drops 1 saved run that did not finish or hit the usage limit.");
      expect(r.stdout).toContain("Failed runs: baseline 0, candidate 0.");
      expect(readJson(resultIn(join(res, "review-baseline"))).resumes).toHaveLength(1);
      expect(readJson(resultIn(join(res, "review-candidate"))).resumes).toBeUndefined();
    },
    SLOW,
  );
});
