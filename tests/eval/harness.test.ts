// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2 AC-M2 and AC-M3: the eval harness refuses to run without --real, the fixture cases are valid, and one case runs
// end to end with the fake CLI. Each child bun process preloads no-real-claude.ts, so a lookup of the real CLI ends it with exit 1.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo, type EvalCase, FIXTURE_SUFFIX, type FixtureSet, INSTRUCTION_FILE, loadCases, SETS } from "../../scripts/eval/cases";
import { compareText } from "../../scripts/eval/compare";
import { DEFAULT_MODEL_WARNING, evalProfile, type Options, parseOptions, WARNING } from "../../scripts/eval/run";
import { type EvalResult, score } from "../../scripts/eval/score";
import { PROFILES_VERSION } from "../../src/server/config";
import { profileRevision, SHIPPED_PROFILES, shippedProfileAt } from "../../src/server/review/catalog";
import { git } from "../../src/server/review/git";
import { DEFAULT_VERIFIER } from "../../src/shared/dto";
import { REVIEW_PROMPT_VERSION } from "../../src/shared/review";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const RUN = join(ROOT, "scripts/eval/run.ts");
const COMPARE = join(ROOT, "scripts/eval/compare.ts");
const RESCORE = join(ROOT, "scripts/eval/rescore.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;
const temp = (name: string) => {
  const d = join(TMP, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// The child gets the preload guard and no data folder of the user.
async function bun(args: string[], preload = NO_REAL) {
  const p = Bun.spawn([process.execPath, "--preload", preload, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_DATA_DIR: temp("data") },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

describe("eval harness without --real (AC-M2)", () => {
  test("prints the plan and the quota warning, exits 2, and starts no process", async () => {
    // Any spawn ends the child with exit 3, any lookup of claude with exit 1.
    const guard = join(temp("guard"), "guard.ts");
    writeFileSync(
      guard,
      [
        `import ${JSON.stringify(NO_REAL)};`,
        "const stop = () => { console.error('guard: a process started'); process.exit(3); };",
        "Bun.spawn = stop as never;",
        "Bun.spawnSync = stop as never;",
      ].join("\n"),
    );
    const r = await bun([RUN, "--cases", "all", "--repeat", "2"], guard);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`Eval plan: ${loadCases("all").length} cases, 2 repeats, profile general, set v1.`);
    expect(r.stdout).toContain(WARNING);
    expect(r.stdout).toContain(DEFAULT_MODEL_WARNING);
    expect(r.stdout).toContain("Model: the default of your Claude Code settings. Effort: high.");
    const hard = await bun([RUN, "--set", "hard"], guard);
    expect(hard.code).toBe(2);
    expect(hard.stdout).toContain(`Eval plan: ${loadCases("all", SETS.hard).length} cases, 1 repeat, profile general, set hard.`);
    const v4 = await bun([RUN, "--set", "hard", "--profile-version", "4"], guard);
    expect(v4.code).toBe(2);
    expect(v4.stdout).toContain("profile general of profile version 4, set hard.");
    expect(v4.stdout).toContain(
      "Model: the default of your Claude Code settings. Effort: the default of your Claude Code settings. The result depends on your Claude Code settings.",
    );
  });

  test("--set picks the case folder, and --cases works within it", () => {
    expect(parseOptions([])).toMatchObject({ set: "v1", cases: "all" });
    expect(parseOptions(["--set", "hard", "--cases", "a,b"])).toMatchObject({ set: "hard", cases: "a,b" });
    expect(parseOptions(["--set", "toString"])).toHaveProperty("error");
    const [first] = loadCases("all", SETS.hard);
    if (!first) throw new Error("The hard set is empty.");
    expect(loadCases(first.id, SETS.hard).map((c) => c.id)).toEqual([first.id]);
    expect(() => loadCases(first.id)).toThrow("Unknown case");
  });

  test("--profile-version rebuilds the shipped general profile of the first baseline", () => {
    expect(parseOptions([])).toMatchObject({ profileVersion: null });
    expect(parseOptions(["--profile-version", "4"])).toMatchObject({ profileVersion: 4 });
    for (const bad of ["0", String(PROFILES_VERSION + 1), "4.5", "x"])
      expect(parseOptions(["--profile-version", bad])).toHaveProperty("error");
    const v4 = shippedProfileAt("general", 4);
    expect(v4).toMatchObject({ name: "General", effort: null, modules: [], volume: "balanced", verifier: DEFAULT_VERIFIER });
    // The revision of the first baseline file (commit 9391ec4, prompt version 1).
    expect(profileRevision(v4 as NonNullable<typeof v4>)).toBe("3a4df4727d3b45ecb2b399e811d6bc1a9d379877122c4137d88e672f6c6789d8");
    expect(shippedProfileAt("general", 5)).toEqual(SHIPPED_PROFILES[0] as NonNullable<typeof v4>);
  });

  test("parses --model and --effort with the profile rules of the app", () => {
    expect(parseOptions([])).toMatchObject({ model: null, effort: null });
    expect(parseOptions(["--model", "haiku", "--effort", "xhigh"])).toMatchObject({ model: "haiku", effort: "xhigh" });
    expect(parseOptions(["--model", "claude-opus-5-5"])).toMatchObject({ model: "claude-opus-5-5", effort: null });
    expect(parseOptions(["--model", "opus[1m]", "--effort", "max"])).toMatchObject({ model: "opus[1m]", effort: "max" });
    expect(parseOptions(["--model", "bad name"])).toHaveProperty("error");
    expect(parseOptions(["--effort", "ultracode"])).toHaveProperty("error");
  });

  test("--verifier sets the verify mode of the run profile and keeps its verifier model and effort", () => {
    expect(parseOptions([])).toMatchObject({ verifier: null });
    expect(parseOptions(["--verifier", "bad"])).toHaveProperty("error");
    const profileOf = (argv: string[]) => {
      const p = evalProfile(parseOptions(argv) as Options);
      if ("error" in p) throw new Error(p.error);
      return p.profile;
    };
    expect(profileOf([]).verifier).toEqual(SHIPPED_PROFILES[0]?.verifier as typeof DEFAULT_VERIFIER);
    expect(profileOf(["--verifier", "off"]).verifier).toEqual({ ...SHIPPED_PROFILES[0]?.verifier, mode: "off" } as typeof DEFAULT_VERIFIER);
    expect(profileOf(["--verifier", "on", "--profile-version", "4"]).verifier).toEqual(DEFAULT_VERIFIER);
  });

  test("--variants sets the variants of the run profile; without it the profile keeps its own (docs/plans/review-v3.md WP-V2)", () => {
    const profileOf = (argv: string[]) => {
      const p = evalProfile(parseOptions(argv) as Options);
      if ("error" in p) throw new Error(p.error);
      return p.profile;
    };
    expect(parseOptions([])).toMatchObject({ variants: null });
    expect(parseOptions(["--variants", "signal, order"])).toMatchObject({ variants: ["signal", "order"] });
    for (const bad of ["bogus", "signal,", ""]) expect(parseOptions(["--variants", bad])).toHaveProperty("error");
    expect(profileOf([]).variants).toEqual([]);
    expect(profileOf(["--variants", "signal,order"]).variants).toEqual(["order", "signal"]);
    expect(profileOf(["--variants", "rereview-strict", "--rereview", "--profile-version", "4"]).variants).toEqual(["rereview-strict"]);
    // WP-V3: rereview-strict changes only the re-review stdin, so a run without --rereview would measure no change.
    expect(parseOptions(["--variants", "signal,rereview-strict"])).toEqual({
      error: "--variants rereview-strict changes only the re-review prompt. Add --rereview, or the run measures no change.",
    });
  });

  test("--modules takes only module IDs of this app version, so a typo never runs a profile without the check", () => {
    expect(parseOptions(["--modules", "security, failures"])).toMatchObject({ modules: ["security", "failures"] });
    expect(parseOptions(["--modules", ""])).toMatchObject({ modules: [] });
    for (const bad of ["failure", "security,", "core"]) expect(parseOptions(["--modules", bad])).toHaveProperty("error");
    const p = evalProfile(parseOptions(["--modules", "security,concurrency,api,rules,intent,failures"]) as Options);
    if ("error" in p) throw new Error(p.error);
    expect(p.profile.modules).toEqual(["security", "concurrency", "api", "rules", "intent", "failures"]);
  });

  test("an invalid --model, --effort, --modules, or --variants exits 2 with the usage text", async () => {
    for (const [flag, value, message] of [
      ["--effort", "huge", "--effort must be one of"],
      ["--model", "bad name", "--model must be a model alias"],
      ["--variants", "bogus", "--variants must be a comma list of order, rereview-strict, rules2, signal."],
      ["--modules", "failure", "--modules must be a comma list of security, concurrency,"],
    ] as const) {
      const r = await bun([RUN, flag, value, "--runner", process.execPath, FAKE, "none.json"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.stderr).toContain("Usage: bun run eval");
    }
  });

  test("refuses --real together with --runner", async () => {
    const r = await bun([RUN, "--real", "--runner", process.execPath, FAKE, "none.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Pass --real or --runner, not both.");
  });
});

// The bug, trap, and changed-line limits of each set (fixtures/eval/README.md).
const LIMITS: Record<FixtureSet, { bugs: [number, number]; traps: [number, number]; lines: [number, number] }> = {
  v1: { bugs: [1, 3], traps: [1, 2], lines: [150, 500] },
  hard: { bugs: [0, 3], traps: [3, 4], lines: [150, 1500] },
};
const within = (n: number, [lo, hi]: [number, number]) => n >= lo && n <= hi;

describe("eval cases", () => {
  const cases = loadCases("all");
  const sets = Object.entries(SETS).map(([set, dir]) => [set as FixtureSet, loadCases("all", dir)] as const);
  let instructionFiles = 0;

  test(
    "each case applies to its base, and each bug, trap, alt, and extra range holds text on its side",
    async () => {
      for (const [set, all] of sets)
        for (const c of all as EvalCase[]) {
          const repo = await buildRepo(c, temp(c.id));
          const numstat = await git(["--git-dir", repo.url, "diff", "--numstat", "--no-renames", repo.base, repo.head], { env: repo.env });
          const counted = numstat
            .trim()
            .split("\n")
            .reduce((s, l) => s + Number(l.split("\t")[0]) + Number(l.split("\t")[1]), 0);
          expect({ id: c.id, lines: c.changedLines }).toEqual({ id: c.id, lines: counted });
          const lim = LIMITS[set];
          expect({ id: c.id, lines: within(c.changedLines, lim.lines), bugs: within(c.bugs.length, lim.bugs) }).toEqual({
            id: c.id,
            lines: true,
            bugs: true,
          });
          expect({ id: c.id, traps: within(c.traps.length, lim.traps) }).toEqual({ id: c.id, traps: true });
          const extras = (c.extras ?? []).map((x, n) => ({ ...x, id: `extra ${n + 1}`, alt: undefined }));
          for (const p of [...c.bugs, ...c.traps, ...extras])
            for (const [i, s] of [p, ...(p.alt ?? [])].entries()) {
              const place = i ? `${p.id} alt ${i}` : p.id;
              const text = (await repo.show(s.side === "new" ? repo.head : repo.base, s.path)).split("\n");
              if (text.at(-1) === "") text.pop();
              expect({ id: c.id, place, inside: s.lines[1] <= text.length }).toEqual({ id: c.id, place, inside: true });
              const lines = text
                .slice(s.lines[0] - 1, s.lines[1])
                .join("")
                .trim();
              expect({ id: c.id, place, empty: lines === "" }).toEqual({ id: c.id, place, empty: false });
            }
          // Each stored instruction file lands in the base commit under its real name, byte for byte.
          for (const stored of new Bun.Glob(`**/*${FIXTURE_SUFFIX}`).scanSync(join(c.dir, "base"))) {
            const path = stored.replaceAll("\\", "/").slice(0, -FIXTURE_SUFFIX.length);
            const built = Buffer.from(await repo.show(repo.base, path));
            expect({ id: c.id, path, same: built.equals(readFileSync(join(c.dir, "base", stored))) }).toEqual({
              id: c.id,
              path,
              same: true,
            });
            instructionFiles++;
          }
        }
      expect(instructionFiles).toBeGreaterThan(0);
    },
    SLOW,
  );

  test("no file under fixtures has a name that Claude Code loads as instructions", () => {
    const loaded = [...new Bun.Glob("fixtures/**").scanSync({ cwd: ROOT, dot: true })].filter((p) =>
      INSTRUCTION_FILE.test(p.replaceAll("\\", "/").split("/").at(-1) ?? ""),
    );
    expect(loaded).toEqual([]);
  });

  test("the set has 4 cases per language and one case of about 500 changed lines", () => {
    const per = Object.groupBy(cases, (c) => c.language);
    expect({ typescript: per.typescript?.length, cpp: per.cpp?.length, python: per.python?.length }).toEqual({
      typescript: 4,
      cpp: 4,
      python: 4,
    });
    expect(Math.max(...cases.map((c) => c.changedLines))).toBeGreaterThanOrEqual(450);
  });

  test("the hard set has 8 to 10 cases in all three languages, 1 or 2 cases with no bug, and a diff of 800 lines or more", () => {
    const hard = loadCases("all", SETS.hard);
    expect(hard.length).toBeGreaterThanOrEqual(8);
    expect(hard.length).toBeLessThanOrEqual(10);
    expect(new Set(hard.map((c) => c.language)).size).toBe(3);
    expect([1, 2]).toContain(hard.filter((c) => c.bugs.length === 0).length);
    expect(Math.max(...hard.map((c) => c.changedLines))).toBeGreaterThanOrEqual(800);
    // Case IDs are unique over all sets, so eval:rescore finds each case by its ID.
    const ids = sets.flatMap(([, all]) => all.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("eval harness with the fake CLI (AC-M3)", () => {
  test(
    "one case runs end to end, scores, and compare reads the result file",
    async () => {
      const [c] = loadCases("ts-cache-race");
      if (!c) throw new Error("The case ts-cache-race is missing.");
      const dir = temp("fake");
      const repo = await buildRepo(c, temp("repo"));
      const line = async (path: string, n: number) => ((await repo.show(repo.head, path)).split("\n")[n - 1] ?? "").trim();
      const at = async (path: string, lines: [number, number], severity: string) => ({
        path,
        side: "new",
        line: lines[0],
        lineEnd: lines[1],
        anchorText: await line(path, lines[0]),
        severity,
        category: "logic",
        body: "A finding of the fake CLI.",
        evidence: `${path}:${lines[0]}`,
        evidenceStatus: "code",
        confidence: "high",
        agent: null,
      });
      const trap = c.traps[0];
      if (!trap) throw new Error("The case has no trap.");
      // One finding per seeded bug, one on the first trap, and one on a changed line with neither.
      const findings = [
        ...(await Promise.all(c.bugs.map((b) => at(b.path, b.lines, b.severityMin)))),
        await at(trap.path, [trap.lines[0], trap.lines[0]], "minor"),
        // Not a nit: volume balanced folds an unchecked nit, and then noise counts nothing.
        await at("src/users/cache.ts", [1, 1], "minor"),
      ];
      const structured = {
        summary: "Fake review.",
        risks: [],
        questions: [],
        coverage: { read: ["src/users/service.ts"], skipped: [], unavailable: [], notChecked: [] },
        findings,
      };
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude/b9-wp8-flags.jsonl", structured),
          delayMs: 1,
        }),
      );
      const out = join(dir, "out");
      const r = await bun([RUN, "--cases", c.id, "--out", out, "--runner", process.execPath, FAKE, scenario]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`[1/1] ${c.id} #1: completed`);

      const files = readdirSync(out).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const file = join(out, files[0] as string);
      const result = JSON.parse(readFileSync(file, "utf8")) as EvalResult;
      expect(result).toMatchObject({ format: 1, promptVersion: REVIEW_PROMPT_VERSION, runner: "fake", repeat: 1, volume: "balanced" });
      expect(result.requested).toEqual({ model: "default", effort: "high", verifier: "on" });
      expect(result.profileVersion).toBe(PROFILES_VERSION);
      expect(r.stdout).toContain(DEFAULT_MODEL_WARNING);
      expect(result.cliVersion).toContain("2.1.295");
      expect(result.profile).toMatchObject({ id: "general" });
      expect(result.cases.map((x) => [x.id, x.head])).toEqual([[c.id, repo.head]]);
      const [run] = result.runs;
      expect(run).toMatchObject({ case: c.id, repeat: 1, status: "completed", error: null, questions: 0 });
      // The echo check confirms each candidate.
      expect(run?.items.map((i) => [i.path, i.line, i.anchorState, i.verdict, i.check, i.group])).toEqual(
        findings.map((f) => [f.path, f.line, "exact", "confirmed", "checked", "main"]),
      );
      expect(run?.verify).toEqual({
        candidates: findings.length,
        confirmed: findings.length,
        refuted: 0,
        unsure: 0,
        questions: 0,
        duplicates: 0,
        unchecked: 0,
      });
      expect(run?.phases?.map((p) => p.name)).toEqual(["find", "check"]);
      const phaseCost = (run?.phases ?? []).reduce((sum, p) => sum + (p.usage?.costUsd ?? 0), 0);
      expect(phaseCost).toBeGreaterThan(0);
      expect(run?.usage?.costUsd).toBeCloseTo(phaseCost, 10);
      const s = score(result).suite;
      expect(s.recall?.mean).toBe(1);
      expect(s.candidateRecall?.mean).toBe(1);
      expect(s.precision?.mean).toBe(c.bugs.length / findings.length);
      expect(s.trapRate?.mean).toBe(1 / c.traps.length);
      expect(s.noise?.mean).toBe(1);
      expect(s.severityOk?.mean).toBe(1);

      // The auth route check ran. The review ran two processes, finder and check, with the fake CLI. The finder got the task file and
      // the project rules of the case.
      const calls = readRecords<{ argv: string[]; stdin: string }>(record);
      expect(calls.some((x) => x.argv[0] === "auth" && x.argv[1] === "status")).toBe(true);
      const runs = calls.filter((x) => x.argv.includes("-p"));
      expect(runs).toHaveLength(2);
      expect(runs.map((x) => JSON.parse(x.argv[x.argv.indexOf("--json-schema") + 1] ?? "{}").properties?.verdicts !== undefined)).toEqual([
        false,
        true,
      ]);
      expect(calls.some((x) => x.argv.includes("--bare"))).toBe(false);
      const stdin = runs[0]?.stdin ?? "";
      expect(stdin).toContain("- ./context/task.md holds the text of the linked tasks");
      expect(stdin).toContain("- Task IDs from the pull request fields: EVAL-1 (branch)");
      expect(stdin).toContain(c.instructions ?? "no instructions in the case");

      const cmp = await bun([COMPARE, file, file]);
      expect(cmp.code).toBe(0);
      expect(cmp.stdout).toMatch(/all cases\s+100\.0%\s+100\.0%\s+\+0\.0 pts/);
      expect(cmp.stdout).not.toContain("used different");

      // The fixture did not change, so a re-score finds the same head and gives the same numbers.
      const rescored = join(dir, "rescored.json");
      const re = await bun([RESCORE, file, "--out", rescored]);
      expect(re.stderr).toBe("");
      expect(re.code).toBe(0);
      expect(re.stdout).toContain("No case has new bugs, traps, or extras.");
      expect(re.stdout).not.toContain("the fixture head is");
      const again = JSON.parse(readFileSync(rescored, "utf8")) as EvalResult;
      expect(again.rescoredAt).toBeString();
      expect(score(again)).toEqual(score(result));
    },
    SLOW,
  );

  test(
    "a finding that the check refutes is hidden from shown items but counts in candidate recall",
    async () => {
      const [c] = loadCases("ts-cache-race");
      const bug = c?.bugs[0];
      if (!c || !bug) throw new Error("The case ts-cache-race or its first bug is missing.");
      const dir = temp("refute");
      const repo = await buildRepo(c, temp("repo"));
      const at = async (path: string, line: number, severity: string) => ({
        path,
        side: "new",
        line,
        lineEnd: line,
        anchorText: ((await repo.show(repo.head, path)).split("\n")[line - 1] ?? "").trim(),
        severity,
        category: "logic",
        body: "A finding of the fake CLI.",
        evidence: `${path}:${line}`,
        evidenceStatus: "code",
        confidence: "high",
        agent: null,
      });
      // Candidate 1 is on the bug, candidate 2 on a line with no bug and no trap.
      const findings = [await at(bug.path, bug.lines[0], bug.severityMin), await at("src/users/cache.ts", 1, "minor")];
      const verdict = (candidate: number, v: string, severity: string) => ({
        candidate,
        verdict: v,
        severity,
        reason: `The fake check gives candidate ${candidate} the verdict ${v}.`,
        evidence: `${findings[candidate - 1]?.path}:${findings[candidate - 1]?.line}`,
        duplicateOf: null,
        question: "",
      });
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
            coverage: { read: ["src/users/service.ts"], skipped: [], unavailable: [], notChecked: [] },
            findings,
          }),
          bySchema: {
            verify: {
              verify: {
                verdicts: [verdict(1, "refuted", bug.severityMin), verdict(2, "confirmed", "minor")],
                coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
              },
            },
          },
          delayMs: 1,
        }),
      );
      const out = join(dir, "out");
      const r = await bun([RUN, "--cases", c.id, "--out", out, "--runner", process.execPath, FAKE, scenario]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`[1/1] ${c.id} #1: completed`);
      expect(r.stdout).toContain(", 1 shown, 0/");
      const files = readdirSync(out).filter((f) => f.endsWith(".json"));
      const result = JSON.parse(readFileSync(join(out, files[0] as string), "utf8")) as EvalResult;
      const [run] = result.runs;
      expect(run?.items.map((i) => [i.line, i.verdict, i.check, i.group])).toEqual([
        [bug.lines[0], "refuted", "unchecked", "hidden"],
        [1, "confirmed", "checked", "main"],
      ]);
      expect(run?.verify).toMatchObject({ candidates: 2, confirmed: 1, refuted: 1, unchecked: 0 });
      const s = score(result).suite;
      expect(s.recall?.mean).toBe(0);
      expect(s.candidateRecall?.mean).toBe(1 / c.bugs.length);
      expect(s.noise?.mean).toBe(1);
    },
    SLOW,
  );

  test(
    "an incomplete run records its coverage, and its run line names the skipped and unavailable entries",
    async () => {
      const [c] = loadCases("cpp-job-queue");
      if (!c) throw new Error("The case cpp-job-queue is missing.");
      const dir = temp("coverage");
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      const coverage = {
        read: ["src/thread_pool.cpp"],
        skipped: ["tests/thread_pool_test.cpp: over the read limit"],
        unavailable: ["third_party/: not in the snapshot"],
        notChecked: ["the CMake files"],
      };
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude/b9-wp8-flags.jsonl", {
            summary: "Partial.",
            risks: [],
            questions: [],
            coverage,
            findings: [],
          }),
          delayMs: 1,
        }),
      );
      const out = join(dir, "out");
      const r = await bun([RUN, "--cases", c.id, "--out", out, "--runner", process.execPath, FAKE, scenario]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`[1/1] ${c.id} #1: incomplete`);
      expect(r.stdout).toContain("    skipped: tests/thread_pool_test.cpp: over the read limit\n");
      expect(r.stdout).toContain("    unavailable: third_party/: not in the snapshot\n");
      const files = readdirSync(out).filter((f) => f.endsWith(".json"));
      const result = JSON.parse(readFileSync(join(out, files[0] as string), "utf8")) as EvalResult;
      expect(result.set).toBe("v1");
      // The case has no project rules, so the app adds the spec 1.3 line to notChecked.
      expect(result.runs[0]).toMatchObject({
        status: "incomplete",
        coverage: { ...coverage, notChecked: [...coverage.notChecked, "Project rules: no instructions loaded."] },
      });
    },
    SLOW,
  );

  test(
    "a stored root CLAUDE.md reaches the run as a project instruction of the target branch",
    async () => {
      const [c] = loadCases("ts-settings-api");
      if (!c) throw new Error("The case ts-settings-api is missing.");
      const rules = readFileSync(join(c.dir, "base", `CLAUDE.md${FIXTURE_SUFFIX}`), "utf8");
      const dir = temp("rules");
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      const empty = {
        summary: "No findings.",
        risks: [],
        questions: [],
        coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
        findings: [],
      };
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude/b9-wp8-flags.jsonl", empty),
          delayMs: 1,
        }),
      );
      const r = await bun([RUN, "--cases", c.id, "--out", join(dir, "out"), "--runner", process.execPath, FAKE, scenario]);
      expect(r.code).toBe(0);
      const stdin = readRecords<{ argv: string[]; stdin: string }>(record).find((x) => x.argv.includes("-p"))?.stdin ?? "";
      expect(stdin).toContain("## From the target branch: CLAUDE.md");
      for (const l of rules.split("\n").filter(Boolean)) expect(stdin).toContain(l);
    },
    SLOW,
  );

  test(
    "--model and --effort reach the CLI, the result file records them with the --variants prompt version, and compare warns on a mismatch",
    async () => {
      const [c] = loadCases("ts-cache-race");
      if (!c) throw new Error("The case ts-cache-race is missing.");
      const dir = temp("flags");
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      const empty = {
        summary: "No findings.",
        risks: [],
        questions: [],
        coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
        findings: [],
      };
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude/b9-wp8-flags.jsonl", empty),
          delayMs: 1,
        }),
      );
      const out = join(dir, "out");
      const args = [
        "--cases",
        c.id,
        "--model",
        "haiku",
        "--effort",
        "low",
        "--verifier",
        "off",
        "--variants",
        "signal,order",
        "--out",
        out,
      ];
      const r = await bun([RUN, ...args, "--runner", process.execPath, FAKE, scenario]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const version = `${REVIEW_PROMPT_VERSION}+order+signal`;
      expect(r.stdout).toContain(`with variants signal, order, model haiku, effort low, verifier off, prompt version ${version}`);
      expect(r.stdout).not.toContain(DEFAULT_MODEL_WARNING);
      const argv = readRecords<{ argv: string[] }>(record).find((x) => x.argv.includes("-p"))?.argv ?? [];
      expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
      expect(argv[argv.indexOf("--effort") + 1]).toBe("low");

      const files = readdirSync(out).filter((f) => f.endsWith(".json"));
      const a = JSON.parse(readFileSync(join(out, files[0] as string), "utf8")) as EvalResult;
      expect(a.requested).toEqual({ model: "haiku", effort: "low", verifier: "off" });
      expect(a.profile).toMatchObject({ model: "haiku", effort: "low", verifier: { mode: "off" }, variants: ["order", "signal"] });
      expect(a.promptVersion).toBe(version);
      const [run] = a.runs;
      expect(run).toMatchObject({ status: "completed", effort: "low" });
      expect(run?.models?.length).toBeGreaterThan(0);
      expect(run?.models).toContain(run?.model as string);

      expect(compareText(a, a)).not.toContain("used different");
      const b: EvalResult = {
        ...a,
        requested: { model: "opus", effort: "low" },
        runs: a.runs.map((x) => ({ ...x, model: "claude-opus-5-5", models: ["claude-opus-5-5"] })),
      };
      const text = compareText(a, b);
      expect(text).toContain("A and B used different models.");
      expect(text).not.toContain("used different efforts");
      expect(compareText(a, { ...a, requested: { model: "haiku", effort: "high" } })).toContain("A and B used different efforts.");
      expect(compareText(a, { ...a, requested: { model: "haiku", effort: "low", verifier: "on" } })).toContain(
        "A and B used different verify modes: off and on. The numbers do not compare.",
      );
      expect(text).toContain("verifier off");
    },
    SLOW,
  );
});
