// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2 AC-M2 and AC-M3: the eval harness refuses to run without --real, the fixture cases are valid, and one case runs
// end to end with the fake CLI. Each child bun process preloads no-real-claude.ts, so a lookup of the real CLI ends it with exit 1.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  buildRepo,
  type EvalCase,
  FIXTURE_SUFFIX,
  type FixtureSet,
  INSTRUCTION_FILE,
  loadCases,
  MANIFEST_FILE,
  SETS,
} from "../../scripts/eval/cases";
import { compareText, readResult } from "../../scripts/eval/compare";
import {
  callsDir,
  caseInfo,
  DEFAULT_MODEL_WARNING,
  evalProfile,
  finderChange,
  type Options,
  parseOptions,
  partFacts,
  replayRefusal,
  runFacts,
  WARNING,
} from "../../scripts/eval/run";
import { type EvalResult, score } from "../../scripts/eval/score";
import { PROFILES_VERSION } from "../../src/server/config";
import { profileRevision, SHIPPED_PROFILES, shippedProfileAt } from "../../src/server/review/catalog";
import { git } from "../../src/server/review/git";
import { createStreamParser } from "../../src/server/review/stream";
import { DEFAULT_VERIFIER } from "../../src/shared/dto";
import { REVIEW_PROMPT_VERSION } from "../../src/shared/review";
import { CHECK_EVENT, type RunEvent } from "../../src/shared/run-log";
import { readRecords, schemaKind } from "../support/fake-claude";
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

  test("--reviewer-effort sets only the rl-reviewer effort of the run profile (docs/plans/review-v3.md WP-V13)", () => {
    expect(parseOptions([])).toMatchObject({ reviewerEffort: null });
    expect(parseOptions(["--reviewer-effort", "bogus"])).toHaveProperty("error");
    const p = evalProfile(parseOptions(["--reviewer-effort", "xhigh"]) as Options);
    if ("error" in p) throw new Error(p.error);
    expect(p.profile.reviewer).toEqual({ ...(SHIPPED_PROFILES[0]?.reviewer as typeof p.profile.reviewer), effort: "xhigh" });
    expect(p.profile.effort).toBe(SHIPPED_PROFILES[0]?.effort ?? null);
  });

  test("the two reviewer flags and the two verifier flags survive together (review-quality-2026.md E2)", () => {
    // None of the four values is the shipped one, so a flag that drops another shows.
    const o = parseOptions([
      ...["--reviewer-effort", "xhigh", "--reviewer-mode", "off"],
      ...["--verifier", "off", "--verifier-effort", "high"],
    ]);
    if ("error" in o) throw new Error(o.error);
    const p = evalProfile(o);
    if ("error" in p) throw new Error(p.error);
    expect(p.profile.reviewer).toEqual({ model: null, effort: "xhigh", mode: "off" });
    expect(p.profile.verifier).toEqual({ mode: "off", model: null, effort: "high" });
    const one = evalProfile(parseOptions(["--reviewer-mode", "always", "--verifier-effort", "low"]) as Options);
    if ("error" in one) throw new Error(one.error);
    expect(one.profile.reviewer).toEqual({ ...(SHIPPED_PROFILES[0]?.reviewer as typeof one.profile.reviewer), mode: "always" });
    expect(one.profile.verifier).toEqual({ ...DEFAULT_VERIFIER, ...SHIPPED_PROFILES[0]?.verifier, effort: "low" });
    expect(parseOptions(["--reviewer-mode", "bogus"])).toMatchObject({ error: expect.stringContaining("--reviewer-mode must be") });
    expect(parseOptions(["--verifier-effort", "bogus"])).toMatchObject({ error: expect.stringContaining("--verifier-effort must be") });
  });

  test("finderChange names the finder fields, and leaves out the verifier effort and model", () => {
    const p = evalProfile(parseOptions([]) as Options);
    if ("error" in p) throw new Error(p.error);
    const base = { ...p.profile, revision: "a" };
    expect(
      finderChange(base, { ...p.profile, revision: "b", verifier: { ...p.profile.verifier, effort: "max", model: "sonnet" } }),
    ).toEqual([]);
    expect(finderChange(base, { ...p.profile, verifier: { ...p.profile.verifier, mode: "off" } })).toEqual(["verifier"]);
    expect(finderChange(base, { ...p.profile, effort: "low", reviewer: { ...p.profile.reviewer, mode: "off" } })).toEqual([
      "effort",
      "reviewer",
    ]);
    expect(finderChange(base, { ...p.profile, variants: ["order"] })).toEqual(["variants"]);
  });

  test("the result case keeps the case fields clean, group, hasTask, large, and task", () => {
    const [c] = loadCases("ts-cache-race");
    if (!c) throw new Error("The case ts-cache-race is missing.");
    const info = caseInfo({ ...c, clean: true, group: "pr1", hasTask: true, large: false, task: "Task text." }, "b", "h");
    expect(info).toMatchObject({
      id: c.id,
      base: "b",
      head: "h",
      clean: true,
      group: "pr1",
      hasTask: true,
      large: false,
      task: "Task text.",
    });
    const plain = JSON.parse(JSON.stringify(caseInfo({ ...c, task: undefined }, "b", "h")));
    for (const k of ["clean", "group", "hasTask", "large", "task"]) expect(plain).not.toHaveProperty(k);
  });

  test("runFacts counts rl-reviewer calls and the repository files that the finder opened, never a context file", () => {
    const cwd = join(TMP, "run");
    const parser = createStreamParser({ cwd, allowedTools: new Set() });
    const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
    const say = (parent: string | null, ...content: unknown[]) =>
      parser.line(JSON.stringify({ type: "assistant", parent_tool_use_id: parent, session_id: "s", message: { content } }));
    const done = (id: string, isError = false) =>
      parser.line(
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "x", is_error: isError }] } }),
      );
    const git = (t: string) => `mcp__rl-git__${t}`;
    say(null, use("m1", "Read", { file_path: join(cwd, "context", "pr.md") }));
    say(null, use("a1", "Agent", { subagent_type: "rl-reviewer", description: "Part 1" }));
    say(null, use("a2", "Agent", { subagent_type: "rl-reviewer", description: "Part 2" }));
    say(
      "a1",
      use("r1", "Read", { file_path: join(cwd, "repo", "src", "a.ts") }),
      use("r2", git("git_diff"), { path: "src/b.ts" }),
      use("r3", git("git_diff"), { stat_only: true }),
      use("r4", "Read", { file_path: "./repo/src/c.ts" }),
      use("r5", "Read", { file_path: join(cwd, "context", "task.md") }),
    );
    say(
      "a2",
      use("s1", git("git_blame"), { path: "src/d.ts", rev: "HEAD" }),
      use("s2", git("git_show"), { rev: "HEAD" }),
      use("s3", git("git_show"), { rev: "abcd", path: "lib/e.ts" }),
      use("s4", "Read", { file_path: join(cwd, "repo", "src", "f.ts") }),
    );
    say(null, use("m2", "Read", { file_path: join(cwd, "repo", "src", "g.ts") }), use("m3", "Agent", { subagent_type: "other" }));
    for (const id of ["m1", "r1", "r2", "r3", "r4", "r5", "s1", "s2", "s3", "a1", "a2", "m2", "m3"]) done(id);
    done("s4", true);
    const events = [...parser.events(), { ...(parser.events()[0] as RunEvent), id: `${CHECK_EVENT}c1`, target: "repo/src/h.ts" }];
    expect(runFacts(events)).toEqual({
      agentCalls: 2,
      opened: ["lib/e.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/g.ts"],
      toolsPerCall: 5,
    });
    expect(runFacts([])).toEqual({ agentCalls: 0, opened: [], toolsPerCall: 0 });
  });

  test("partFacts counts the part files that an rl-reviewer call of the find phase read (docs/plans/review-v3.md WP-V14)", () => {
    const cwd = join(TMP, "run");
    const parser = createStreamParser({ cwd, allowedTools: new Set() });
    const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
    const say = (parent: string | null, ...content: unknown[]) =>
      parser.line(JSON.stringify({ type: "assistant", parent_tool_use_id: parent, session_id: "s", message: { content } }));
    const done = (id: string, isError = false) =>
      parser.line(
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "x", is_error: isError }] } }),
      );
    const part = (n: number) => join(cwd, "context", "parts", `part-${n}.md`);
    say(null, use("a1", "Agent", { subagent_type: "rl-reviewer", description: "Part 1" }));
    say("a1", use("r1", "Read", { file_path: part(1) }), use("r2", "Read", { file_path: part(3) }));
    say(null, use("m1", "Read", { file_path: part(2) }));
    for (const id of ["r1", "a1", "m1"]) done(id);
    done("r2", true);
    const [call, read] = parser.events();
    // A verify-phase event does not count.
    const check = [
      { ...(call as RunEvent), id: `${CHECK_EVENT}a9` },
      { ...(read as RunEvent), id: `${CHECK_EVENT}r9`, parent: `${CHECK_EVENT}a9`, target: "context/parts/part-4.md" },
    ];
    expect(partFacts([...parser.events(), ...check], 4)).toEqual({ parts: 4, partsRead: 1 });
    expect(partFacts([], 0)).toEqual({ parts: 0, partsRead: 0 });
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
    expect(parseOptions(["--variants", "rules2, order"])).toMatchObject({ variants: ["rules2", "order"] });
    for (const bad of ["bogus", "signal", "rules2,", ""]) expect(parseOptions(["--variants", bad])).toHaveProperty("error");
    expect(profileOf([]).variants).toEqual([]);
    expect(profileOf(["--variants", "rules2,order"]).variants).toEqual(["order", "rules2"]);
    expect(profileOf(["--variants", "rereview-strict", "--rereview", "--profile-version", "4"]).variants).toEqual(["rereview-strict"]);
    // WP-V3: rereview-strict changes only the re-review stdin, so a run without --rereview would measure no change.
    expect(parseOptions(["--variants", "rules2,rereview-strict"])).toEqual({
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
      ["--reviewer-effort", "bogus", "--reviewer-effort must be one of"],
      ["--model", "bad name", "--model must be a model alias"],
      ["--variants", "bogus", "--variants must be a comma list of order, parts, rereview-strict, rules2."],
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
  probe: { bugs: [0, 1], traps: [1, 2], lines: [10, 200] },
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

  test("no file under fixtures has a manifest name that the GitHub dependency graph reads", () => {
    const manifests = [...new Bun.Glob("fixtures/**").scanSync({ cwd: ROOT, dot: true })].filter((p) =>
      MANIFEST_FILE.test(p.replaceAll("\\", "/").split("/").at(-1) ?? ""),
    );
    expect(manifests).toEqual([]);
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
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", structured),
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
      // Shipped efforts: no --effort flag runs the finder at high and the verify call at medium.
      expect(result.requested).toEqual({
        model: "default",
        effort: "high",
        verifier: "on",
        verifierEffort: "medium",
        reviewerMode: "auto",
      });
      expect(result.profileVersion).toBe(PROFILES_VERSION);
      expect(r.stdout).toContain(DEFAULT_MODEL_WARNING);
      expect(result.cliVersion).toContain("2.1.302");
      expect(result.profile).toMatchObject({ id: "general" });
      expect(result.cases.map((x) => [x.id, x.head])).toEqual([[c.id, repo.head]]);
      const [run] = result.runs;
      expect(run).toMatchObject({ case: c.id, repeat: 1, status: "completed", error: null, questions: 0 });
      expect(run?.finderQuestions).toEqual({ asked: 0, answered: 0, findings: 0, kept: 0 });
      expect(run?.agentCalls).toBeNumber();
      expect(run?.toolsPerCall).toBeNumber();
      expect(run?.opened).toBeArray();
      expect(run).toMatchObject({ parts: 0, partsRead: 0 });
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

      // docs/plans/review-v3.md WP-V14: the variant reads the diff of the run. A change under the R8 limits gets no part file.
      const partsOut = join(dir, "parts");
      const parted = await bun([
        RUN,
        "--cases",
        c.id,
        "--variants",
        "parts",
        "--out",
        partsOut,
        "--runner",
        process.execPath,
        FAKE,
        scenario,
      ]);
      expect(parted.code).toBe(0);
      const partsFile = readdirSync(partsOut).find((f) => f.endsWith(".json")) as string;
      const partsResult = JSON.parse(readFileSync(join(partsOut, partsFile), "utf8")) as EvalResult;
      expect(partsResult.promptVersion).toBe(`${REVIEW_PROMPT_VERSION}+parts`);
      expect(partsResult.runs[0]).toMatchObject({ status: "completed", parts: 0, partsRead: 0 });
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
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", {
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
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", {
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
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", empty),
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
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", empty),
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
        "rules2,order",
        "--out",
        out,
      ];
      const r = await bun([RUN, ...args, "--runner", process.execPath, FAKE, scenario]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const version = `${REVIEW_PROMPT_VERSION}+order+rules2`;
      expect(r.stdout).toContain(
        `with variants rules2, order, model haiku, effort low, reviewer mode auto, verifier off, verifier effort medium, prompt version ${version}`,
      );
      expect(r.stdout).not.toContain(DEFAULT_MODEL_WARNING);
      const argv = readRecords<{ argv: string[] }>(record).find((x) => x.argv.includes("-p"))?.argv ?? [];
      expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
      expect(argv[argv.indexOf("--effort") + 1]).toBe("low");

      const files = readdirSync(out).filter((f) => f.endsWith(".json"));
      const a = JSON.parse(readFileSync(join(out, files[0] as string), "utf8")) as EvalResult;
      expect(a.requested).toEqual({ model: "haiku", effort: "low", verifier: "off", verifierEffort: "medium", reviewerMode: "auto" });
      expect(a.profile).toMatchObject({ model: "haiku", effort: "low", verifier: { mode: "off" }, variants: ["order", "rules2"] });
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
      expect(text).toContain("reviewer mode auto, verifier off, verifier effort medium, fake CLI");
      expect(compareText(a, { ...a, requested: { model: "haiku", effort: "low" } })).toContain(
        "reviewer mode not recorded, verifier off, verifier effort not recorded, fake CLI",
      );
    },
    SLOW,
  );

  test(
    "a run records its calls, --replay-find runs only the verify calls, and a missing recording gives an error run with no live finder",
    async () => {
      const dir = temp("replay");
      const [task] = loadCases("probe-task-csv-quoting", SETS.probe);
      const bug = task?.bugs[0];
      if (!task || !bug) throw new Error("The case probe-task-csv-quoting or its bug is missing.");
      const repo = await buildRepo(task, temp("repo"));
      const text = (await repo.show(repo.head, bug.path)).split("\n");
      const finding = {
        path: bug.path,
        side: "new",
        line: bug.lines[0],
        lineEnd: bug.lines[1],
        anchorText: (text[bug.lines[0] - 1] ?? "").trim(),
        severity: "major",
        category: "logic",
        body: "A finding of the fake CLI.",
        evidence: `${bug.path}:${bug.lines[0]}`,
        evidenceStatus: "code",
        confidence: "high",
        agent: null,
      };
      const scenario = (name: string, findings: unknown[]) => {
        const file = join(dir, `${name}.json`);
        const structured = {
          summary: "Fake review.",
          risks: [],
          questions: [],
          coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
          findings,
        };
        writeFileSync(
          file,
          JSON.stringify({
            record: join(dir, `${name}-calls.jsonl`),
            auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
            fixture: claudeStream(dir, name, "claude-synthetic/review-agent-tree.jsonl", structured),
            delayMs: 1,
          }),
        );
        return file;
      };
      // The --json-schema kind and the --effort value of each model call of a scenario.
      const calls = (name: string) =>
        readRecords<{ argv: string[] }>(join(dir, `${name}-calls.jsonl`))
          .filter((x) => x.argv.includes("-p"))
          .map((x) => [
            schemaKind(JSON.parse(x.argv[x.argv.indexOf("--json-schema") + 1] ?? "{}").properties ?? {}),
            x.argv[x.argv.indexOf("--effort") + 1],
          ]);
      const run = async (name: string, findings: unknown[], args: string[]) => {
        const out = join(dir, `out-${name}`);
        const r = await bun([RUN, "--set", "probe", ...args, "--out", out, "--runner", process.execPath, FAKE, scenario(name, findings)]);
        // A refused run makes no out folder.
        const names = r.code === 0 ? readdirSync(out, { withFileTypes: true }) : [];
        const file = join(out, names.find((f) => f.isFile() && f.name.endsWith(".json"))?.name ?? "none");
        return { ...r, file };
      };
      const ids = `probe-clean-axis-ticks,${task.id}`;
      const rec = await run("record", [finding], ["--cases", ids]);
      expect(rec.stderr).toBe("");
      expect(rec.code).toBe(0);
      const a = readResult(rec.file);
      // review-quality-2026.md E5: the slices read the case fields from the result file.
      expect(a.cases.find((c) => c.id === "probe-clean-axis-ticks")).toMatchObject({ clean: true });
      expect(a.cases.find((c) => c.id === task.id)?.task).toBe(task.task as string);
      // The clean case has no file of the finding, so its run has no candidate and no verify call.
      expect(readdirSync(callsDir(rec.file)).sort()).toEqual([
        "probe-clean-axis-ticks-1-1.json",
        `${task.id}-1-1.json`,
        `${task.id}-1-2.json`,
      ]);
      expect(calls("record")).toEqual([
        ["review", "high"],
        ["review", "high"],
        ["verify", "medium"],
      ]);
      const found = (r: EvalResult) => r.runs.find((x) => x.case === task.id)?.items.map((i) => [i.path, i.line, i.verdict]);
      expect(found(a)).toEqual([[bug.path, bug.lines[0], "confirmed"]]);

      // A live finder of this scenario finds nothing, so the found item comes from the recording.
      const replay = await run("replay", [], ["--cases", ids, "--replay-find", rec.file, "--verifier-effort", "high"]);
      expect(replay.stderr).toBe("");
      expect(replay.code).toBe(0);
      expect(replay.stdout).toContain(`Replay: the finder and salvage calls come from ${basename(rec.file)}.`);
      const b = readResult(replay.file);
      expect(b.requested).toMatchObject({ replayOf: basename(rec.file), verifierEffort: "high", reviewerMode: "auto" });
      expect(found(b)).toEqual(found(a));
      expect(calls("replay")).toEqual([["verify", "high"]]);
      // The replay records its calls too, so a later replay can use it.
      expect(readdirSync(callsDir(replay.file)).sort()).toEqual(readdirSync(callsDir(rec.file)).sort());

      // Another mode, set, repeat count, or finder prompt version is refused.
      const refusal = (args: string[], r: EvalResult = a) => {
        const o = parseOptions(["--set", "probe", "--replay-find", rec.file, ...args]);
        if ("error" in o) throw new Error(o.error);
        const p = evalProfile(o);
        if ("error" in p) throw new Error(p.error);
        return replayRefusal(r, o, p.profile);
      };
      expect(refusal([])).toBeNull();
      expect(refusal(["--verifier-effort", "max"])).toBeNull();
      expect(refusal(["--rereview"])).toContain("the recording ran the other mode");
      expect(refusal(["--set", "hard"])).toContain("the recording ran set probe, but this run has set hard");
      expect(refusal(["--repeat", "2"])).toContain("the recording has 1 repeats, but this run asks for 2");
      expect(refusal([], { ...a, promptVersion: "2.0" })).toContain("the recording ran finder prompt version 2.0");
      expect(refusal(["--verifier", "off"])).toContain("changes the finder setup of the recording: verifier.");

      // A flag that changes the finder exits 2 before any run.
      const flag = await run("flag", [], ["--cases", ids, "--replay-find", rec.file, "--effort", "low"]);
      expect(flag.code).toBe(2);
      expect(flag.stderr).toContain("Refused: --replay-find: this run changes the finder setup of the recording: effort.");
      expect(calls("flag")).toEqual([]);

      // A missing recording and a case that the recording has no run of give error runs. No finder runs live.
      rmSync(join(callsDir(rec.file), `${task.id}-1-1.json`));
      const gap = await run("gap", [finding], ["--cases", `${ids},probe-claim-single-thread`, "--replay-find", rec.file]);
      expect(gap.stderr).toBe("");
      expect(gap.code).toBe(0);
      const g = readResult(gap.file);
      const runOf = (r: EvalResult, id: string) => r.runs.find((x) => x.case === id);
      expect(runOf(g, task.id)).toMatchObject({ status: "error", error: `The recording has no finder call ${task.id}-1-1.json.` });
      expect(runOf(g, "probe-claim-single-thread")).toMatchObject({
        status: "error",
        error: "The recording has no run of this case at this head.",
      });
      expect(runOf(g, "probe-clean-axis-ticks")?.status).toBe(runOf(a, "probe-clean-axis-ticks")?.status);
      expect(calls("gap")).toEqual([]);
    },
    SLOW,
  );
});
