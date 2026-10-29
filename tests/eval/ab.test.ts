// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// bun run eval:ab: the local set from a temp "live" data folder, read only, then baseline and candidate runs with the fake CLI.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { type AbOptions, failedRuns, parseAb, runArgs } from "../../scripts/eval/ab";
import type { EvalResult } from "../../scripts/eval/score";
import { dbPath } from "../../src/server/config";
import { git, gitEnv } from "../../src/server/review/git";
import { openDb } from "../../src/server/storage/db";
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
  variants: ["signal", "order", "rules2"],
  modules: ["failures"],
  baseEffort: null,
  effort: null,
  build: [],
  results: null,
  runner: ["fake"],
  ...o,
});

describe("eval:ab arguments", () => {
  test("defaults, overrides, and the build flags", () => {
    const o = parseAb(["--repeat", "2", "--db", "x.sqlite", "--runner", "cli", "a"]);
    if ("error" in o) throw new Error(o.error);
    expect(o).toMatchObject({
      repeat: "2",
      variants: ["signal", "order", "rules2"],
      modules: ["failures"],
      baseEffort: null,
      effort: null,
      runner: ["cli", "a"],
    });
    expect(o.build).toEqual(["--db", "x.sqlite"]);
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
      ...["--set", "local", "--repeat", "1", "--variants", "signal,order,rules2", "--modules", `${shippedModules},failures`],
      ...["--ordinals", "--out", "o", "--runner", "fake"],
    ]);
    // --candidate-effort: only the candidate gets --effort.
    expect(runArgs("review", "candidate", opts({ effort: "xhigh" }), "")).toEqual([
      ...["--set", "local", "--repeat", "1", "--variants", "signal,order,rules2", "--modules", `${shippedModules},failures`],
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
    expect(runArgs("rereview", "candidate", opts({ runner: null }), "")).toEqual([
      ...["--set", "local", "--repeat", "1", "--rereview", "--variants", "signal,order,rules2,rereview-strict"],
      ...["--modules", `${shippedModules},failures`, "--ordinals", "--real"],
    ]);
    // Bisect: no variants and no extra module. rereview-strict changes nothing in a review run, so the review candidate drops it.
    const bare = opts({ variants: ["rereview-strict"], modules: [] });
    expect(runArgs("review", "candidate", bare, "")).toEqual([
      "--set",
      "local",
      "--repeat",
      "1",
      "--modules",
      shippedModules,
      "--ordinals",
      "--runner",
      "fake",
    ]);
    expect(runArgs("rereview", "candidate", bare, "")).toContain("rereview-strict");
  });

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
  test(
    "builds from the live folder without a write, runs baseline and candidate, and skips the re-review mode",
    async () => {
      const dir = join(TMP, "fake");
      mkdirSync(dir);
      const text = fileAt(CHANGED).split("\n");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record: join(dir, "calls.jsonl"),
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude/b9-wp8-flags.jsonl", {
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
      const out = join(TMP, "set", "eval-local");
      const results = join(TMP, "results");
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
      expect(a.profile.variants).toEqual([]);
      expect(a.profile.modules).not.toContain("failures");
      expect(b.profile.variants).toEqual(["order", "rules2", "signal"]);
      expect(b.profile.modules).toContain("failures");
      expect(a.requested?.effort).not.toBe("low");
      expect(b.requested?.effort).toBe("low");
      expect(a.fingerprint).toBe(b.fingerprint as string);
      expect(readdirSync(results).sort()).toEqual(["review-baseline", "review-candidate"]);
    },
    SLOW,
  );
});
