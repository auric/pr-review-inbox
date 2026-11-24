// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2 AC-M2 and AC-M3: the eval harness refuses to run without --real, the fixture cases are valid, and one case runs
// end to end with the fake CLI. Each child bun process preloads no-real-claude.ts, so a lookup of the real CLI ends it with exit 1.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  buildRepo,
  bundleRepo,
  type EvalCase,
  FIXTURE_SUFFIX,
  type FixtureSet,
  INSTRUCTION_FILE,
  loadCase,
  loadCases,
  MANIFEST_FILE,
  rereviewDir,
  SETS,
  setDir,
} from "../../scripts/eval/cases";
import { compareText, readResult } from "../../scripts/eval/compare";
import {
  callKind,
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
  VERIFY_ONLY,
  WARNING,
} from "../../scripts/eval/run";
import { type EvalResult, score } from "../../scripts/eval/score";
import { PROFILES_VERSION } from "../../src/server/config";
import { profileRevision, SHIPPED_PROFILES, shippedProfileAt } from "../../src/server/review/catalog";
import { git } from "../../src/server/review/git";
import { createStreamParser } from "../../src/server/review/stream";
import { movedGitlinks } from "../../src/server/review/submodules";
import { DEFAULT_VERIFIER } from "../../src/shared/dto";
import { REVIEW_PROMPT_VERSION, reviewJsonSchema, verifyJsonSchema } from "../../src/shared/review";
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
    expect(r.stdout).toContain("Model: the Claude Code default. Effort: medium.");
    const hard = await bun([RUN, "--set", "hard"], guard);
    expect(hard.code).toBe(2);
    expect(hard.stdout).toContain(`Eval plan: ${loadCases("all", SETS.hard).length} cases, 1 repeat, profile general, set hard.`);
    const v4 = await bun([RUN, "--set", "hard", "--profile-version", "4"], guard);
    expect(v4.code).toBe(2);
    expect(v4.stdout).toContain("profile general of profile version 4, set hard.");
    expect(v4.stdout).toContain(`Model: the Claude Code default. Effort: the Claude Code default. ${DEFAULT_MODEL_WARNING}`);
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
    expect(v4?.advisor).toBeNull();
    // Versions 5 to 7 shipped the finder and rl-reviewer efforts high (FORMER[7]). Versions 1 to 8 shipped no advisor (FORMER[8]).
    const v8 = { ...(SHIPPED_PROFILES[0] as NonNullable<typeof v4>), advisor: null };
    const v7 = { ...v8, ...({ effort: "high", reviewer: { model: null, effort: "high", mode: "auto" } } as const) };
    expect(shippedProfileAt("general", 5)).toEqual(v7);
    expect(shippedProfileAt("general", 7)).toEqual(v7);
    expect(shippedProfileAt("general", 8)).toEqual(v8);
    expect(shippedProfileAt("general", 9)).toEqual(SHIPPED_PROFILES[0] as NonNullable<typeof v4>);
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
    expect(finderChange(base, { ...p.profile, variants: ["broad"] })).toEqual(["variants"]);
    // focused-passes.md section 5.4: --candidate-replay refuses lenses3 and runs3, because they change the finder.
    expect(finderChange(base, { ...p.profile, variants: ["lenses3"] })).toEqual(["variants"]);
    expect(finderChange(base, { ...p.profile, variants: ["runs3"] })).toEqual(["variants"]);
    // review-quality-2026.md item 4: verify2 changes only the verify prompts, so a replay can switch it.
    expect(VERIFY_ONLY).toEqual(["obligations", "refute-issue", "security2-verify", "verify2"]);
    // verifier-rule.md AC-R58: the rule changes only the verify prompts.
    expect(finderChange(base, { ...p.profile, variants: ["refute-issue"] })).toEqual([]);
    expect(finderChange(base, { ...p.profile, variants: ["refute-issue", "callers"] })).toEqual(["variants"]);
    expect(finderChange(base, { ...p.profile, variants: ["verify2"] })).toEqual([]);
    // obligations.md section 8: the obligation check changes only the verify prompts.
    expect(finderChange(base, { ...p.profile, variants: ["obligations"] })).toEqual([]);
    // A replay runs each verify call live, also one with the obligations schema.
    expect(callKind({ schema: verifyJsonSchema() })).toBe("verify");
    expect(callKind({ schema: verifyJsonSchema(true) })).toBe("verify");
    expect(callKind({ schema: reviewJsonSchema() })).toBe("find");
    expect(callKind({})).toBe("find");
    // review-quality-2026.md item 10: security2 changes the finder, security2-verify only the verify prompts.
    expect(finderChange(base, { ...p.profile, variants: ["security2-verify"] })).toEqual([]);
    expect(finderChange(base, { ...p.profile, variants: ["security2"] })).toEqual(["variants"]);
    expect(finderChange(base, { ...p.profile, variants: ["broad", "verify2"] })).toEqual(["variants"]);
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
    expect(parseOptions(["--variants", "verify2, broad"])).toMatchObject({ variants: ["verify2", "broad"] });
    // review-quality-2026.md WP-R1: the retired variants are unknown names.
    for (const bad of ["bogus", "signal", "order", "rules2", "rereview-strict", "preexisting", "risk-check", "broad,", ""])
      expect(parseOptions(["--variants", bad])).toHaveProperty("error");
    expect(profileOf([]).variants).toEqual([]);
    expect(profileOf(["--variants", "verify2,broad"]).variants).toEqual(["broad", "verify2"]);
    expect(profileOf(["--variants", "verify2", "--rereview", "--profile-version", "4"]).variants).toEqual(["verify2"]);
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
      [
        "--variants",
        "rules2",
        "--variants must be a comma list of architecture, broad, callers, classes, codegraph, lenses3, minor-fold, obligations, parts, refute-issue, runs3, security2, security2-verify, stack, submodules, verify2.",
      ],
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
          // A submodule case can move only the gitlink: its 2 changed lines are the "Subproject commit" lines.
          const lim = c.submodule ? { ...LIMITS[set], lines: [2, LIMITS[set].lines[1]] as [number, number] } : LIMITS[set];
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
    // It builds each case repository one by one: 80 s alone on 2026-11-23, and more on a loaded machine.
    SLOW * 5,
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
      // Shipped efforts: no --effort flag runs the finder and the verify call at medium.
      expect(result.requested).toEqual({
        model: "default",
        effort: "medium",
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

      // focused-passes.md WP-L2: each item of a lenses3 run carries its pass. The calls record 3 finder calls, then the verify call.
      const lensOut = join(dir, "lenses3");
      const lensed = await bun([
        RUN,
        "--cases",
        c.id,
        "--variants",
        "lenses3",
        "--out",
        lensOut,
        "--runner",
        process.execPath,
        FAKE,
        scenario,
      ]);
      expect(lensed.code).toBe(0);
      const lensFile = join(lensOut, readdirSync(lensOut).find((f) => f.endsWith(".json")) as string);
      const lensResult = JSON.parse(readFileSync(lensFile, "utf8")) as EvalResult;
      expect(lensResult.promptVersion).toBe(`${REVIEW_PROMPT_VERSION}+lenses3`);
      const passes = lensResult.runs[0]?.items.map((i) => i.pass) ?? [];
      expect(passes).toEqual([...findings.map(() => 1), ...findings.map(() => 2), ...findings.map(() => 3)]);
      const recorded = readdirSync(callsDir(lensFile))
        .sort((x, y) => Number(/-(\d+)\.json$/.exec(x)?.[1]) - Number(/-(\d+)\.json$/.exec(y)?.[1]))
        .map((f) => (JSON.parse(readFileSync(join(callsDir(lensFile), f), "utf8")) as { kind: string }).kind);
      expect(recorded).toEqual(["find", "find", "find", "verify"]);
      expect(result.runs[0]?.items.some((i) => i.pass !== undefined)).toBe(false);
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
      // verifier-rule.md AC-R59: each finding item keeps the verify reason.
      expect(run?.items.map((i) => i.checkReason)).toEqual([
        "The fake check gives candidate 1 the verdict refuted.",
        "The fake check gives candidate 2 the verdict confirmed.",
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
    "the model notes alone keep a run completed; the run records its coverage, and its run line names the skipped and unavailable entries",
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
      expect(r.stdout).toContain(`[1/1] ${c.id} #1: completed`);
      expect(r.stdout).toContain("    skipped: tests/thread_pool_test.cpp: over the read limit\n");
      expect(r.stdout).toContain("    unavailable: third_party/: not in the snapshot\n");
      const files = readdirSync(out).filter((f) => f.endsWith(".json"));
      const result = JSON.parse(readFileSync(join(out, files[0] as string), "utf8")) as EvalResult;
      expect(result.set).toBe("v1");
      // The case has no project rules, so the app adds the spec 1.3 line to notChecked.
      expect(result.runs[0]).toMatchObject({
        status: "completed",
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
        "verify2,broad",
        "--out",
        out,
      ];
      const r = await bun([RUN, ...args, "--runner", process.execPath, FAKE, scenario]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const version = `${REVIEW_PROMPT_VERSION}+broad+verify2`;
      expect(r.stdout).toContain(
        `with variants verify2, broad, model haiku, effort low, reviewer mode auto, verifier off, verifier effort medium, prompt version ${version}`,
      );
      expect(r.stdout).not.toContain(DEFAULT_MODEL_WARNING);
      const argv = readRecords<{ argv: string[] }>(record).find((x) => x.argv.includes("-p"))?.argv ?? [];
      expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
      expect(argv[argv.indexOf("--effort") + 1]).toBe("low");

      const files = readdirSync(out).filter((f) => f.endsWith(".json"));
      const a = JSON.parse(readFileSync(join(out, files[0] as string), "utf8")) as EvalResult;
      expect(a.requested).toEqual({ model: "haiku", effort: "low", verifier: "off", verifierEffort: "medium", reviewerMode: "auto" });
      expect(a.profile).toMatchObject({ model: "haiku", effort: "low", verifier: { mode: "off" }, variants: ["broad", "verify2"] });
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
      const scenario = (name: string, findings: unknown[], risks: string[], extra: Record<string, unknown>) => {
        const file = join(dir, `${name}.json`);
        const structured = {
          summary: "Fake review.",
          risks,
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
            ...extra,
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
      const run = async (name: string, findings: unknown[], args: string[], risks: string[] = [], extra: Record<string, unknown> = {}) => {
        const out = join(dir, `out-${name}`);
        const r = await bun([
          RUN,
          "--set",
          "probe",
          ...args,
          "--out",
          out,
          "--runner",
          process.execPath,
          FAKE,
          scenario(name, findings, risks, extra),
        ]);
        // A refused run makes no out folder.
        const names = r.code === 0 ? readdirSync(out, { withFileTypes: true }) : [];
        const file = join(out, names.find((f) => f.isFile() && f.name.endsWith(".json"))?.name ?? "none");
        return { ...r, file };
      };
      const ids = `probe-clean-axis-ticks,${task.id}`;
      // risk-check.md WP-RC3: since prompt 2.9, each run checks its finder risks. A run with only a risk starts the verify phase.
      const RISK = "A secret risk text of the fake CLI.";
      const rec = await run("record", [finding], ["--cases", ids], [RISK]);
      expect(rec.stderr).toBe("");
      expect(rec.code).toBe(0);
      const a = readResult(rec.file);
      // review-quality-2026.md E5: the slices read the case fields from the result file.
      expect(a.cases.find((c) => c.id === "probe-clean-axis-ticks")).toMatchObject({ clean: true });
      expect(a.cases.find((c) => c.id === task.id)?.task).toBe(task.task as string);
      // The clean case has no file of the finding, so its verify call checks only the risk.
      expect(readdirSync(callsDir(rec.file)).sort()).toEqual([
        "probe-clean-axis-ticks-1-1.json",
        "probe-clean-axis-ticks-1-2.json",
        `${task.id}-1-1.json`,
        `${task.id}-1-2.json`,
      ]);
      expect(calls("record").sort()).toEqual([
        ["review", "medium"],
        ["review", "medium"],
        ["verify", "medium"],
        ["verify", "medium"],
      ]);
      const found = (r: EvalResult) => r.runs.find((x) => x.case === task.id)?.items.map((i) => [i.path, i.line, i.verdict]);
      expect(found(a)).toEqual([[bug.path, bug.lines[0], "confirmed"]]);
      // The echo check gives no risk verdict, so each risk stays open.
      const open = { listed: 1, found: 0, asked: 0, cleared: 0, covered: 0, open: 1 };
      expect(a.runs.map((x) => x.finderRisks)).toEqual([open, open]);

      // A live finder of this scenario finds nothing, so the found item comes from the recording.
      const replay = await run("replay", [], ["--cases", ids, "--replay-find", rec.file, "--verifier-effort", "high"]);
      expect(replay.stderr).toBe("");
      expect(replay.code).toBe(0);
      expect(replay.stdout).toContain(`Replay: the finder and salvage calls come from ${basename(rec.file)}.`);
      const b = readResult(replay.file);
      expect(b.requested).toMatchObject({ replayOf: basename(rec.file), verifierEffort: "high", reviewerMode: "auto" });
      expect(found(b)).toEqual(found(a));
      expect(calls("replay")).toEqual([
        ["verify", "high"],
        ["verify", "high"],
      ]);
      // The replay records its calls too, so a later replay can use it.
      expect(readdirSync(callsDir(replay.file)).sort()).toEqual(readdirSync(callsDir(rec.file)).sort());
      expect(b.runs.map((x) => x.finderRisks)).toEqual([open, open]);
      // risk-check.md section 7: the result file holds the counts, never the risk text.
      expect(readFileSync(replay.file, "utf8")).not.toContain(RISK);
      expect(replay.stdout).toContain("Finder risks, all runs: 2 listed, 0 found, 0 asked, 0 cleared, 0 same as a finding, 2 open.");
      expect(replay.stdout).toContain("Question items per case run, per repeat (all question items): 1: 0/2 = 0.00. Spread: 0.00.");
      expect(b.runs.map((x) => x.obligations)).toEqual([undefined, undefined]);

      // obligations.md section 8: the obligation check changes only the verify prompts, so a replay can switch it on. Its verify call
      // has its own schema, and the replay must still run it live.
      const MUST = "A secret obligation text of the fake CLI.";
      const obligation = (status: string) => ({
        source: "surface",
        must: MUST,
        consumer: "A reader of docs/guide.md.",
        cite: { path: "docs/guide.md", quote: "x" },
        status,
        evidence: "docs/guide.md:1",
        severity: "minor",
        duplicateOf: null,
        finding: null,
      });
      const verify = {
        verdicts: [],
        coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
        obligations: [obligation("met"), obligation("unsure")],
      };
      const obliged = await run(
        "obliged",
        [],
        ["--cases", "probe-clean-axis-ticks", "--replay-find", rec.file, "--variants", "obligations"],
        [],
        { verify },
      );
      expect(obliged.stderr).toBe("");
      expect(obliged.code).toBe(0);
      const o = readResult(obliged.file);
      // O1 gives met, O8 gives open. The clean case has no candidate, so the check starts with zero blocks.
      expect(o.runs.map((x) => x.obligations)).toEqual([{ listed: 2, met: 1, deferred: 0, covered: 0, found: 0, open: 1 }]);
      expect(calls("obliged")).toEqual([["verify", "medium"]]);
      expect(readFileSync(obliged.file, "utf8")).not.toContain(MUST);
      expect(obliged.stdout).toContain("Obligations, all runs: 2 listed, 1 met, 0 deferred, 0 same as a finding, 0 found, 1 open.");

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
      // A PR note changes the finder prompt.
      expect(refusal(["--notes"])).toContain("the recording ran without --notes");
      expect(refusal([], { ...a, requested: { model: "default", effort: "default", ...a.requested, notes: true } })).toContain(
        "the recording ran with --notes",
      );
      expect(refusal(["--set", "hard"])).toContain("the recording ran set probe, but this run has set hard");
      expect(refusal(["--repeat", "2"])).toContain("the recording has 1 repeats, but this run asks for 2");
      expect(refusal([], { ...a, promptVersion: "2.0" })).toContain("the recording ran finder prompt version 2.0");
      expect(refusal(["--verifier", "off"])).toContain("changes the finder setup of the recording: verifier.");
      // review-quality-2026.md item 4: verify2 changes only the verify prompts. broad changes the finder.
      expect(refusal(["--variants", "verify2"])).toBeNull();
      // verifier-rule.md AC-R58: refute-issue changes only the verify prompts.
      expect(refusal(["--variants", "refute-issue"])).toBeNull();
      expect(refusal(["--variants", "broad"])).toContain("the recording ran finder prompt version");
      expect(refusal(["--variants", "verify2"], { ...a, promptVersion: `${a.promptVersion}+broad` })).toContain(
        `the recording ran finder prompt version ${a.promptVersion}+broad`,
      );

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
      // Only the clean case runs its verify call live, for its recorded risk.
      expect(calls("gap")).toEqual([["verify", "medium"]]);
    },
    SLOW,
  );
});

type Call = { argv: string[]; stdin: string; context: Record<string, string>; agents: unknown; mcp: Record<string, { args?: string[] }> };
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
// A fake eval run of probe cases. Without findings, one finder call per case and no verify call. Each call answers with findings.
async function fakeEval(ids: string, variants: string[] = [], findings: unknown[] = []) {
  const dir = temp("probe");
  const record = join(dir, "calls.jsonl");
  const scenario = join(dir, "scenario.json");
  const structured = {
    summary: "Fake review.",
    risks: [],
    questions: [],
    coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
    findings,
  };
  writeFileSync(
    scenario,
    JSON.stringify({
      record,
      auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
      fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", structured),
      delayMs: 1,
    }),
  );
  const r = await bun([
    RUN,
    "--set",
    "probe",
    "--cases",
    ids,
    ...variants,
    "--out",
    join(dir, "out"),
    "--runner",
    process.execPath,
    FAKE,
    scenario,
  ]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  const out = join(dir, "out");
  const file = readdirSync(out).find((f) => f.endsWith(".json")) as string;
  return {
    calls: readRecords<Call>(record).filter((x) => x.argv.includes("-p")),
    result: JSON.parse(readFileSync(join(out, file), "utf8")) as EvalResult,
  };
}
const fakeRun = async (ids: string, variants: string[] = []) => (await fakeEval(ids, variants)).calls;
const prompt = (c: Call) => JSON.stringify(c.agents) + c.stdin;

// docs/plans/review-v2/stacked-prs.md WP-SK3: the probe cases of the variant "stack". The pins come from the harness before WP-SK3.
describe("stacked probe cases with the fake CLI (WP-SK3)", () => {
  console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/run.ts", import.meta.dir)}`);
  const parentBase = (c: Call) => c.mcp["rl-git"]?.args?.find((a) => a.startsWith("--parent-base="));

  test(
    "a case without stack or submodule keeps its repository, prompt, and context files, also with the variant stack or submodules",
    async () => {
      const [c] = loadCases("probe-obl-criterion-deferred", SETS.probe);
      if (!c) throw new Error("The case probe-obl-criterion-deferred is missing.");
      const repo = await buildRepo(c, temp("repo"));
      expect([repo.base, repo.head]).toEqual(["3dea3d52b9ae35f29d3eb47dc9efe6dfda0f25e3", "bb323f6520d9a4ba0e13e9ccb0cdad8a032af7c4"]);
      const ref = (name: string) => git(["--git-dir", repo.url, "rev-parse", "--verify", "-q", name], { env: repo.env }).catch(() => "");
      expect(await ref("refs/heads/parent")).toBe("");
      const [plain] = await fakeRun(c.id);
      const [variant] = await fakeRun(c.id, ["--variants", "stack"]);
      // submodule-prs.md AC-SM2: without a moved gitlink, the variant "submodules" changes no byte.
      const [sub] = await fakeRun(c.id, ["--variants", "submodules"]);
      // A probe case has no note.md, so --notes changes no byte.
      const [notes] = await fakeRun(c.id, ["--notes"]);
      for (const x of [plain, variant, sub, notes]) {
        if (!x) throw new Error("No finder call.");
        // task.md holds the fetch time, so it is left out.
        expect({
          stdin: sha(x.stdin),
          prContext: sha(x.context["pr-context.md"] ?? ""),
          pr: sha(x.context["pr.md"] ?? ""),
          agents: sha(JSON.stringify(x.agents)),
        }).toEqual({
          stdin: "8146d0b96eed6e046b8708d996584e1c5e80b5a1471185849442b93a9a842d56",
          prContext: "c2a6d3d041135f89ac1b4127f72cea904a9cd796f5d4cecd7d2e178a070a119a",
          pr: "bb514415e70b2ac1c35a280b5af825236a885ac1a438060cb2d9499d637a8110",
          // A prompt change of catalog.ts changes this pin.
          agents: "26d79267f825fb89532da6ad8ec4e9904c58973676171b4efe9b7490949f20a0",
        });
        expect(prompt(x)).not.toContain("stacked");
        expect(parentBase(x)).toBeUndefined();
        expect(Object.keys(x.context)).not.toContain("submodules.md");
      }
    },
    SLOW,
  );

  test(
    "a stack case builds the parent branch, and the variant gives the section, the prompt lines, and PARENT_BASE",
    async () => {
      const [c] = loadCases("probe-stack-relies", SETS.probe);
      if (!c) throw new Error("The case probe-stack-relies is missing.");
      const repo = await buildRepo(c, temp("repo"));
      const ref = (name: string) => git(["--git-dir", repo.url, "rev-parse", name], { env: repo.env }).then((s) => s.trim());
      const main = await ref("refs/heads/main");
      // base is the parent head, the child of main. The head is the child of the parent head.
      expect(await ref("refs/heads/parent")).toBe(repo.base);
      expect(await ref(`${repo.base}^`)).toBe(main);
      expect(await ref(`${repo.head}^`)).toBe(repo.base);
      expect(await repo.show(repo.base, "src/config/quota.ts")).toContain("export function parseQuota");
      expect(await repo.show(main, "src/api/limits.ts")).toContain("return DEFAULT_QUOTA;");

      const [stacked] = await fakeRun(c.id, ["--variants", "stack"]);
      const file = stacked?.context["pr-context.md"] ?? "";
      expect(file).toContain(`- Source: feature/eval at ${repo.head.slice(0, 7)}. Target: parent at ${repo.base.slice(0, 7)}.`);
      expect(file).toContain(
        [
          "## Stacked pull requests",
          "",
          '### Parent #2 "Add parseQuota for quota settings" by Eval Author, open',
          `- Source: parent at ${repo.base.slice(0, 7)}. Target: main.`,
          "- Changed paths (1): src/config/quota.ts.",
        ].join("\n"),
      );
      expect(file).not.toContain("### Child");
      expect(prompt(stacked as Call)).toContain("This pull request is stacked.");
      expect(prompt(stacked as Call)).toContain("git_diff from PARENT_BASE to TARGET shows the change of the parent pull request.");
      expect(parentBase(stacked as Call)).toBe(`--parent-base=${main}`);

      // The control: the same repository with no stack facts.
      const [plain] = await fakeRun(c.id);
      expect(plain?.context["pr-context.md"]).not.toContain("## Stacked pull requests");
      expect(prompt(plain as Call)).not.toContain("stacked");
      expect(parentBase(plain as Call)).toBeUndefined();
    },
    SLOW,
  );

  test(
    "a fake run of the 3 stack cases shows the section in each, and a child with no parent gives no PARENT_BASE",
    async () => {
      const ids = ["probe-stack-child-fills", "probe-stack-relies", "probe-stack-unreached"];
      const calls = await fakeRun(ids.join(","), ["--variants", "stack"]);
      expect(calls).toHaveLength(3);
      const files = calls.map((x) => x.context["pr-context.md"] ?? "");
      for (const f of files) expect(f).toContain("## Stacked pull requests");
      const [fills, relies, unreached] = calls;
      expect(files[0]).toContain('### Child #3 "Add the Retry-After header" by Eval Author, open');
      expect(files[0]).toContain("- Source: feature/eval-child-1. Target: feature/eval, the source branch of this pull request.");
      expect(files[0]).toContain("- Changed paths (2): src/api/limit.ts, src/api/server.ts.");
      expect(files[0]).not.toContain("### Parent");
      expect(files[0]).toContain("Target: main at");
      expect(prompt(fills as Call)).toContain("A child pull request builds on this change.");
      expect(parentBase(fills as Call)).toBeUndefined();
      expect(files[2]).toContain('### Parent #2 "Add backoffMs for retry waits"');
      for (const x of [relies, unreached]) expect(parentBase(x as Call)).toMatch(/^--parent-base=[0-9a-f]{40}$/);
    },
    SLOW,
  );
});

// docs/plans/review-v2/submodule-prs.md WP-SM3: the probe cases of the variant "submodules".
describe("submodule probe cases with the fake CLI (WP-SM3)", () => {
  console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/run.ts", import.meta.dir)}`);
  const IDS = ["probe-sub-caller", "probe-sub-signature", "probe-sub-unreached"];
  const load = (id: string) => {
    const [c] = loadCases(id, SETS.probe);
    if (!c?.submodule) throw new Error(`The submodule case ${id} is missing.`);
    return { ...c, submodule: c.submodule };
  };

  test(
    "a submodule case builds the submodule repository, and the main head moves the gitlink",
    async () => {
      const c = load("probe-sub-signature");
      const repo = await buildRepo(c, temp("repo"));
      if (!repo.sub) throw new Error("No submodule repository.");
      const sub = repo.sub;
      const g = (dir: string, args: string[]) => git(["--git-dir", dir, ...args], { env: repo.env }).then((s) => s.trim());
      expect(await g(sub.url, ["rev-parse", "refs/heads/main"])).toBe(sub.head);
      expect(await g(sub.url, ["rev-parse", `${sub.head}^`])).toBe(sub.base);
      expect(await g(sub.url, ["log", "-1", "--format=%s", sub.head])).toBe(c.submodule.title);
      expect(await g(sub.url, ["show", `${sub.base}:src/clamp.ts`])).toContain("clamp(value: number, min: number, max: number)");
      expect(await g(sub.url, ["show", `${sub.head}:src/clamp.ts`])).toContain("clamp(min: number, max: number, value: number)");
      expect(await repo.show(repo.base, ".gitmodules")).toBe(
        '[submodule "vendor/mathlib"]\n\tpath = vendor/mathlib\n\turl = ../mathlib.git\n',
      );
      // ls-tree: "<mode> <type> <object>\t<path>".
      const link = (commit: string) => g(repo.url, ["ls-tree", commit, "vendor/mathlib"]);
      expect(await link(repo.base)).toBe(`160000 commit ${sub.base}\tvendor/mathlib`);
      expect(await link(repo.head)).toBe(`160000 commit ${sub.head}\tvendor/mathlib`);
      expect(await movedGitlinks(repo.url, repo.env, repo.base, repo.head)).toEqual([
        { path: "vendor/mathlib", old: sub.base, new: sub.head },
      ]);
      // An empty head.patch moves only the gitlink.
      const caller = await buildRepo(load("probe-sub-caller"), temp("repo"));
      expect(await g(caller.url, ["diff", "--name-only", caller.base, caller.head])).toBe("vendor/configkit");
    },
    SLOW,
  );

  test(
    "a fake run of the 3 cases gives submodules.md and the prompt lines with the variant, and neither without it",
    async () => {
      const calls = await fakeRun(IDS.join(","), ["--variants", "submodules"]);
      expect(calls).toHaveLength(3);
      for (const [i, x] of calls.entries()) {
        const c = load(IDS[i] as string);
        const file = x.context["submodules.md"] ?? "";
        expect(file).toContain("# Submodule changes");
        expect(file).toMatch(new RegExp(`## Diff of ${c.submodule.path}: git diff [0-9a-f]{12} [0-9a-f]{12}`));
        expect(file).toContain(c.submodule.title);
        expect(prompt(x)).toContain("./context/submodules.md shows what the new commit brings.");
      }
      expect(calls[0]?.context["submodules.md"]).toContain('+  if (raw === "unlimited") return null;');
      expect(calls[1]?.context["submodules.md"]).toContain("+export function clamp(min: number, max: number, value: number): number {");
      expect(calls[2]?.context["submodules.md"]).toContain("+  if (size < 0) return Math.round(size * factor);");

      // The control: the same repositories with no submodule facts.
      const plain = await fakeRun(IDS.join(","));
      expect(plain).toHaveLength(3);
      for (const x of plain) {
        expect(Object.keys(x.context)).not.toContain("submodules.md");
        expect(prompt(x)).not.toContain("submodules.md");
      }
    },
    SLOW * 2,
  );

  test(
    "a must-find on an unchanged caller with its cause on the gitlink line stays and scores as found only with the variant",
    async () => {
      const c = load("probe-sub-caller");
      const bug = c.bugs[0];
      if (!bug) throw new Error("The case has no bug.");
      const repo = await buildRepo(c, temp("repo"));
      if (!repo.sub) throw new Error("No submodule repository.");
      // The must-find is on unchanged code: the main change touches no line of its file.
      expect(await git(["--git-dir", repo.url, "diff", "--name-only", repo.base, repo.head, "--", bug.path], { env: repo.env })).toBe("");
      const text = (await repo.show(repo.head, bug.path)).split("\n");
      const finding = {
        path: bug.path,
        side: "new",
        line: bug.lines[0],
        lineEnd: bug.lines[1],
        anchorText: text.slice(bug.lines[0] - 1, bug.lines[1]).join("\n"),
        severity: "major",
        category: "logic",
        body: "A finding of the fake CLI.",
        evidence: `${bug.path}:${bug.lines[0]}`,
        evidenceStatus: "code",
        confidence: "high",
        agent: null,
        // ./repo has no file of the gitlink, so the finder gives an empty quote for its line (Gate SM-P).
        cause: { path: c.submodule.path, side: "new", line: 1, lineEnd: null, anchorText: "" },
        preexisting: false,
      };
      const kept = await fakeEval(c.id, ["--variants", "submodules"], [finding]);
      const [run] = kept.result.runs;
      expect(run?.status).toBe("completed");
      expect(run?.items.map((i) => [i.path, i.line, i.lineEnd])).toEqual([[bug.path, bug.lines[0], bug.lines[1]]]);
      expect(score(kept.result).suite.recall?.mean).toBe(1);
      // Without the variant, the judge has no gitlinks, so the finding drops as unchanged.
      const dropped = await fakeEval(c.id, [], [finding]);
      expect(dropped.result.runs[0]?.items).toEqual([]);
      expect(score(dropped.result).suite.recall?.mean).toBe(0);
    },
    SLOW * 2,
  );

  // SD3 premise: no case of the local set moves a gitlink, so the variant changes nothing there. The local set is private, so the check
  // prints and compares counts only. It runs only with REVIEW_LOOP_GITLINK_CHECK=1, so bun run check never reads eval-local.
  test.skipIf(process.env.REVIEW_LOOP_GITLINK_CHECK !== "1" || !existsSync(setDir("local")))(
    "no case of the local set moves a gitlink (skipped without REVIEW_LOOP_GITLINK_CHECK=1 and eval-local)",
    async () => {
      const root = temp("local");
      const bundles = new Map<string, string>();
      let checked = 0;
      let moved = 0;
      let failed = 0;
      for (const dir of [setDir("local"), rereviewDir()]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter((x) => existsSync(join(dir, x, "case.json")))) {
          try {
            const c = loadCase(join(dir, f));
            if (!c.local) throw new Error("Not a local case.");
            const repo = await bundleRepo(c.local, root, bundles);
            const ranges: [string, string][] = [[repo.base, repo.head]];
            if (repo.since && repo.sinceBase) ranges.push([repo.sinceBase, repo.since]);
            let hit = false;
            for (const [from, to] of ranges) {
              // A review run reads the gitlinks from the merge base to the head (submodules.ts movedGitlinks).
              const base = (await git(["--git-dir", repo.url, "merge-base", from, to], { env: repo.env })).trim();
              if ((await movedGitlinks(repo.url, repo.env, base, to)).length) hit = true;
            }
            checked++;
            if (hit) moved++;
          } catch {
            failed++;
          }
        }
      }
      console.log(`Local set gitlink check: ${checked} cases checked, ${moved} move a gitlink, ${failed} not read.`);
      expect({ checked: checked > 0, moved, failed }).toEqual({ checked: true, moved: 0, failed: 0 });
    },
    SLOW * 5,
  );
});
