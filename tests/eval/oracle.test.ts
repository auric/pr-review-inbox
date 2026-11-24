// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/eval/local.md, oracle look: eval:oracle with fixture data and the fake CLI. No model call.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo, findCase, loadCase, setFingerprint } from "../../scripts/eval/cases";
import { itemHash, labelKey } from "../../scripts/eval/label";
import {
  decoyScore,
  decoySpots,
  finderSetup,
  neverFound,
  type OracleOut,
  parseOracle,
  pointText,
  rescoreOut,
  summaryLines,
} from "../../scripts/eval/oracle";
import type { CaseRun, EvalCaseInfo, EvalItem, EvalResult } from "../../scripts/eval/score";
import { bindingOf, buildSeededSet, type Host, hostsOf } from "../../scripts/eval/seed-build";
import { type SeedRecord, saveStore } from "../../scripts/eval/seed-store";
import { readRecords } from "../support/fake-claude";
import { ARCH, addTargetMerge, keptSeed, makeNaturalSet, type NaturalSet, OMIT, PATHS, seedFields } from "../support/seed-fixture";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const ORACLE = join(ROOT, "scripts/eval/oracle.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const PLAIN = join(ROOT, "fixtures/claude-synthetic/plain.jsonl");
const GIT_TOOLS = ["git_log", "git_blame", "git_show", "git_diff"].map((t) => `mcp__rl-git__${t}`);

console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/oracle.ts", import.meta.dir)}`);

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-oracle-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

const item = (o: Partial<EvalItem> & Pick<EvalItem, "path" | "line" | "title">): EvalItem => ({
  side: "new",
  lineEnd: o.line,
  anchorState: "exact",
  severity: "major",
  finderSeverity: "major",
  verdict: null,
  check: null,
  group: "main",
  status: "new",
  body: `${o.title}. The body.`,
  category: "correctness",
  module: null,
  trigger: null,
  confidence: "high",
  evidenceStatus: "code",
  agent: null,
  ...o,
});

const caseRun = (id: string, repeat: number, items: EvalItem[]): CaseRun => ({
  case: id,
  repeat,
  run: repeat,
  status: "completed",
  errorKind: null,
  error: null,
  model: "claude-test",
  effort: "high",
  effortDefault: null,
  startedAt: 0,
  finishedAt: 0,
  minutes: 1,
  usage: { costUsd: 2, turns: 1, durationMs: 1, tokens: {} },
  phases: [{ name: "find", startedAt: 0, endedAt: 1, usage: { costUsd: 0.5, turns: 1, durationMs: 1, tokens: {} } }],
  items,
  dropped: [],
  questions: 0,
});

const info = (id: string, extras: EvalCaseInfo["extras"], o: Partial<EvalCaseInfo> = {}): EvalCaseInfo => ({
  id,
  title: "t",
  language: "typescript",
  changedLines: 10,
  base: "b",
  head: "h",
  bugs: [],
  traps: [],
  extras,
  ...o,
});

const result = (cases: EvalCaseInfo[], runs: CaseRun[], set: EvalResult["set"] = "probe"): EvalResult => ({
  format: 1,
  createdAt: "2026-11-23T00:00:00.000Z",
  commit: "abc",
  dirty: false,
  promptVersion: "2.9",
  cliVersion: "2.1.302",
  runner: "fake",
  profile: { id: "general", name: "Review", revision: "0123456789", effort: "high", reviewer: { model: null, effort: "medium" } },
  volume: "balanced",
  set,
  tolerance: 3,
  repeat: runs.length,
  cases,
  runs,
});

describe("selection", () => {
  test("keeps the extras that no run matches by line or by the matcher, with their global index", () => {
    const x = (path: string, a: number) => ({ path, side: "new" as const, lines: [a, a] as [number, number], note: "n" });
    const near = item({ path: "a.ts", line: 13, title: "near" });
    const elsewhere = item({ path: "a.ts", line: 40, title: "elsewhere" });
    const r = result(
      [info("c1", [x("a.ts", 10), x("a.ts", 30)]), info("c2", [x("b.ts", 5), x("b.ts", 50)])],
      [caseRun("c1", 1, [near]), caseRun("c2", 1, [elsewhere]), caseRun("c2", 2, [])],
    );
    // a.ts:13 is within 3 lines of a.ts:10. The matcher store says the c2 item matches extra 1 of c2, in another file.
    const box = { c2: { [`${itemHash(elsewhere)} extra:1 m1 h`]: { match: true } } };
    expect(neverFound(r, (id) => box[id as "c2"])).toEqual([
      { case: "c1", extra: 1, global: 1 },
      { case: "c2", extra: 0, global: 2 },
    ]);
    // A false matcher entry is no hit.
    const no = { c2: { [`${itemHash(elsewhere)} extra:1 m1 h`]: { match: false } } };
    expect(neverFound(r, (id) => no[id as "c2"]).map((i) => i.global)).toEqual([1, 2, 3]);
  });

  test("decoys avoid each gold place by the tolerance, keep the gold file types, and pick the same spots each time", () => {
    const c = info("c1", [{ path: "a.ts", side: "new", lines: [10, 12], note: "n" }], {
      bugs: [
        {
          id: "S1",
          path: "z.ts",
          side: "new",
          lines: [5, 5],
          alt: [{ path: "a.ts", side: "new", lines: [40, 40] }],
          severityMin: "major",
          module: "core",
          note: "n",
        },
      ],
    });
    const runs = [
      { path: "a.ts", lines: [14, 20] as [number, number] },
      { path: "a.ts", lines: [16, 20] as [number, number] },
      { path: "a.ts", lines: [1, 6] as [number, number] },
      { path: "a.ts", lines: [7, 7] as [number, number] },
      { path: "a.ts", lines: [37, 37] as [number, number] },
      { path: "z.ts", lines: [8, 9] as [number, number] },
      { path: "z.ts", lines: [9, 9] as [number, number] },
      { path: "README.md", lines: [1, 5] as [number, number] },
    ];
    const all = decoySpots([{ c, runs }], 100);
    const keys = all.map((s) => `${s.path}:${s.lines.join("-")}`).sort();
    expect(keys).toEqual(["a.ts:1-6", "a.ts:16-20", "z.ts:9-9"]);
    expect(decoySpots([{ c, runs }], 100)).toEqual(all);
    expect(decoySpots([{ c, runs }], 2)).toEqual(all.slice(0, 2));
    expect(all.every((s) => s.case === "c1")).toBe(true);
  });

  test("the finder setup is the model of the runs and the rl-reviewer effort", () => {
    const r = result([info("c1", [])], [caseRun("c1", 1, [])]);
    expect(finderSetup(r)).toEqual({ model: "claude-test", effort: "medium" });
    expect(finderSetup({ ...r, runs: [caseRun("c1", 1, []), { ...caseRun("c1", 2, []), model: "other" }] })).toBeNull();
  });
});

describe("prompt and rules", () => {
  test("the pointed text names the place only, at two levels", () => {
    expect(pointText("file", "src/a.ts", "new", [3, 4])).toStartWith(
      "This change touches src/a.ts. A reviewer suspects a defect in this file.",
    );
    expect(pointText("file", "src/a.ts", "new", [3, 4])).not.toContain("3-4");
    expect(pointText("lines", "src/a.ts", "new", [3, 4])).toStartWith("This change touches src/a.ts lines 3-4. A reviewer suspects");
    expect(pointText("lines", "src/a.ts", "old", [3, 4])).toContain("lines 3-4 of the base version");
  });

  test("a decoy false claim is a major finding at the decoy spot that lies on no gold place", () => {
    const spot = { path: "a.ts", lines: [20, 22] as [number, number] };
    const seed = { path: "a.ts", side: "new" as const, lines: [27, 27] as [number, number] };
    const f = (path: string, line: number, severity: "blocker" | "major" | "minor" = "major") => ({ path, line, severity });
    expect(decoyScore(spot, [seed], [])).toEqual({ claim: false, other: 0 });
    // Elsewhere: another file, or more than 3 lines from the spot.
    expect(decoyScore(spot, [seed], [f("b.ts", 21), f("a.ts", 26, "blocker")])).toEqual({ claim: false, other: 2 });
    // At the spot (within 3 lines) and within 3 lines of the seed: no false claim.
    expect(decoyScore(spot, [seed], [f("a.ts", 25)])).toEqual({ claim: false, other: 1 });
    // At the spot and on no gold place.
    expect(decoyScore(spot, [seed], [f("a.ts", 17), f("b.ts", 1)])).toEqual({ claim: true, other: 1 });
    expect(decoyScore(spot, [], [f("a.ts", 21, "minor")])).toEqual({ claim: false, other: 0 });
    // An alt place counts as gold too.
    expect(
      decoyScore(
        spot,
        [{ path: "z.ts", side: "new", lines: [1, 1], alt: [{ path: "a.ts", side: "new", lines: [21, 21] }] }],
        [f("a.ts", 21)],
      ).claim,
    ).toBe(false);
  });

  test("rescore applies the decoy rule and the seed status, keeps the matcher verdicts, and reports excluded issues apart", () => {
    const call = (status: string, findings: { path: string; line: number; severity: string }[]) =>
      ({
        level: "lines",
        repeat: 1,
        status,
        costUsd: 0,
        summary: "",
        findings: findings.map((x) => ({ ...x, title: "t", trigger: "t", impact: "i" })),
      }) as OracleOut["targets"][number]["calls"][number];
    const seed = { path: "s.ts", side: "new" as const, lines: [5, 5] as [number, number] };
    const o = {
      format: 1,
      kind: "oracle",
      createdAt: "",
      record: "r.json",
      model: "m",
      effort: "e",
      cliVersion: "1",
      repeat: 1,
      levels: ["lines"],
      maxUsd: 1,
      estimateUsd: 1,
      stopped: false,
      costUsd: { point: 0, matcher: 0, total: 0 },
      targets: [
        {
          kind: "issue",
          case: "c1",
          extra: 0,
          global: 0,
          path: "a.ts",
          side: "new",
          lines: [1, 1],
          calls: [
            call("missed", [{ path: "s.ts", line: 6, severity: "major" }]),
            call("found", [{ path: "s.ts", line: 5, severity: "major" }]),
          ],
        },
        {
          kind: "issue",
          case: "c1",
          extra: 1,
          global: 1,
          path: "a.ts",
          side: "new",
          lines: [9, 9],
          calls: [call("missed", [{ path: "a.ts", line: 9, severity: "minor" }])],
        },
        // A stored seed place wins over the case data.
        {
          kind: "decoy",
          case: "c1",
          extra: null,
          global: null,
          path: "s.ts",
          side: "new",
          lines: [3, 3],
          gold: [],
          seeds: [],
          calls: [call("claim", [{ path: "s.ts", line: 5, severity: "major" }])],
        },
        {
          kind: "decoy",
          case: "c1",
          extra: null,
          global: null,
          path: "s.ts",
          side: "new",
          lines: [3, 3],
          calls: [call("claim", [{ path: "s.ts", line: 5, severity: "major" }])],
        },
        {
          kind: "decoy",
          case: "gone",
          extra: null,
          global: null,
          path: "s.ts",
          side: "new",
          lines: [3, 3],
          calls: [call("claim", [{ path: "q.ts", line: 1, severity: "major" }])],
        },
      ],
    } as OracleOut;
    const { out, oldClaims, noData } = rescoreOut({ ...o, excluded: [1] }, (id) => (id === "c1" ? { gold: [seed], seeds: [seed] } : null));
    expect(out.targets.map((t) => t.calls.map((c) => c.status))).toEqual([
      ["seed", "found"],
      ["missed"],
      ["claim"],
      ["clean"],
      ["unscored"],
    ]);
    expect([oldClaims, noData]).toEqual([2, 1]);
    const text = summaryLines(out).join("\n");
    expect(text).toContain("Level lines: issues pointed 1, with a scored call 1. Found in at least 1 call: 1 of 1.");
    expect(text).toContain("Calls taken by seeds: 1.");
    expect(text).toContain("Excluded issues (--exclude): 1 indexes, 1 with calls.");
    expect(text).toContain("Calls with a false claim: 1 of 2.");
    expect(text).toContain("Other findings (major or blocker, no false claim: elsewhere or on a gold place): 1 in 1 calls.");
  });

  test("the options have the defaults of the plan and refuse bad values", () => {
    const o = parseOracle(["r.json"]);
    if ("error" in o) throw new Error(o.error);
    expect([o.real, o.runner, o.repeat, o.levels, o.decoys, o.maxUsd, o.issues]).toEqual([false, null, 3, ["file", "lines"], 10, 60, null]);
    expect([o.seeded, o.exclude, o.rescore]).toEqual([false, [], null]);
    const q = parseOracle(["r.json", "--seeded", "--exclude", "2,3", "--natural", "nat"]);
    if ("error" in q) throw new Error(q.error);
    expect([q.seeded, q.exclude, q.natural]).toEqual([true, [2, 3], resolve("nat")]);
    const rs = parseOracle(["--rescore", "o.json"]);
    if ("error" in rs) throw new Error(rs.error);
    expect(rs.rescore).toBe(resolve("o.json"));
    const p = parseOracle(["r.json", "--issues", "1,4", "--levels", "lines", "--repeat", "5", "--decoys", "0", "--max-usd", "2.5"]);
    if ("error" in p) throw new Error(p.error);
    expect([p.issues, p.levels, p.repeat, p.decoys, p.maxUsd]).toEqual([[1, 4], ["lines"], 5, 0, 2.5]);
    for (const bad of [
      [],
      ["r.json", "--real", "--runner", "x"],
      ["r.json", "--levels", "hunk"],
      ["r.json", "--repeat", "0"],
      ["r.json", "--max-usd", "-1"],
      ["r.json", "--runner"],
      ["r.json", "--exclude", "x"],
      ["--rescore", "o.json", "r.json"],
      ["--rescore", "o.json", "--real"],
      ["--rescore"],
    ])
      expect("error" in parseOracle(bad)).toBe(true);
  });
});

// A stream of fixtures/claude-synthetic/ whose init lists the tools and MCP servers of the run. Its result costs $0.0055.
function stream(dir: string, name: string, tools: string[], servers: string[]) {
  const lines = readFileSync(PLAIN, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l);
      return e.type === "system" && e.subtype === "init"
        ? { ...e, tools, mcp_servers: servers.map((s) => ({ name: s, status: "connected" })) }
        : e;
    });
  const out = join(dir, `${name}.jsonl`);
  writeFileSync(out, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return out;
}

async function oracle(args: string[], local: string) {
  const p = Bun.spawn([process.execPath, "--preload", NO_REAL, ORACLE, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_EVAL_LOCAL: local },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

type Rec = { argv: string[]; stdin: string; context: Record<string, string>; files?: Record<string, string> };
const flag = (r: Rec, name: string) => r.argv[r.argv.indexOf(name) + 1];
const isPoint = (r: Rec) => r.argv.includes("-p") && JSON.parse(flag(r, "--json-schema") ?? "{}").properties?.findings !== undefined;

describe("eval:oracle with the fake CLI", () => {
  // The probe case probe-task-csv-quoting adds src/export/csv.ts (12 lines), src/export/route.ts (7 lines), and a test file. Extra 0
  // is the never-found issue. Extra 1 is found by line. The decoy can only be in route.ts or the test file.
  const GOLD = "GOLDTEXT the header row drops the customer column";
  const FOUND = "FOUNDTEXT a found extra";
  const csv = "src/export/csv.ts";

  async function setup() {
    const dir = mkdtempSync(join(TMP, "run-"));
    const local = join(dir, "local");
    const fx = findCase("probe-task-csv-quoting");
    if (!fx) throw new Error("The probe case is missing.");
    const repo = await buildRepo(fx, mkdtempSync(join(dir, "repo-")));
    const r = result(
      [
        info(
          fx.id,
          [
            { path: csv, side: "new", lines: [3, 3], note: "n", text: GOLD },
            { path: csv, side: "new", lines: [11, 11], note: "n", text: FOUND },
          ],
          { base: repo.base, head: repo.head, bugs: fx.bugs, traps: fx.traps, title: fx.title },
        ),
      ],
      [caseRun(fx.id, 1, [item({ path: csv, line: 11, title: "Found one" })])],
    );
    const file = join(dir, "r.json");
    writeFileSync(file, JSON.stringify(r));
    mkdirSync(join(local, "labels", labelKey(r)), { recursive: true });
    writeFileSync(join(local, "labels", labelKey(r), "matches.json"), JSON.stringify({ format: 1, cases: {} }));
    const record = join(dir, "calls.jsonl");
    const finding = (title: string, path: string, severity: string) => ({ title, trigger: "t", impact: "i", path, line: 3, severity });
    const scenario = join(dir, "scenario.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        record,
        auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
        delayMs: 1,
        files: true,
        bySchema: {
          review: { fixture: stream(dir, "point", ["Read", "Grep", "Glob", ...GIT_TOOLS, "StructuredOutput"], ["rl-git"]) },
          matcher: { fixture: stream(dir, "matcher", ["Read", "Grep", "Glob", "StructuredOutput"], []) },
        },
        // Repeat 1: the issue at level file (found), the issue at level lines (missed), and the decoy (a false claim).
        seq: {
          review: [
            { review: { summary: "s", findings: [finding("FINDINGTITLE one", `repo/${csv}`, "major")] } },
            { review: { summary: "No defect.", findings: [] } },
            { review: { summary: "s", findings: [finding("FINDINGTITLE two", "src/export/route.ts", "major")] } },
          ],
          matcher: [{ matcher: { candidates: [{ index: 0, matches: [0], why: "Same problem." }] } }],
        },
      }),
    );
    return { dir, local, file, record, out: join(dir, "out"), runner: ["--runner", process.execPath, FAKE, scenario], id: fx.id };
  }

  const clean = (s: string, id: string) => {
    for (const bad of [csv, "route.ts", "csv.test.ts", id, GOLD, FOUND, "FINDINGTITLE", "Found one"]) expect(s).not.toContain(bad);
  };

  test(
    "prints the plan and runs no CLI without --real or --runner",
    async () => {
      const s = await setup();
      const x = await oracle([s.file, "--out", s.out], s.local);
      expect(x.stderr).toBe("");
      expect(x.code).toBe(2);
      expect(x.stdout).toContain("eval:oracle: 1 never-found issues in 1 cases, 2 decoys (asked 10).");
      expect(x.stdout).toContain("Calls: 12 (levels file,lines, repeat 3)");
      expect(x.stdout).toContain("Model claude-test, effort medium");
      // 12 calls x $0.50 + 6 issue calls x $0.03.
      expect(x.stdout).toContain("about $6.18");
      expect(x.stdout).toContain("Add --real");
      clean(x.stdout, s.id);
      expect(existsSync(s.record)).toBe(false);
      expect(existsSync(s.out)).toBe(false);
      // Extra 1 was found and index 7 names no extra.
      const some = await oracle([s.file, "--issues", "0,1,7"], s.local);
      expect(some.code).toBe(2);
      expect(some.stdout).toContain("eval:oracle: 1 never-found issues in 1 cases");
      expect(some.stdout).toContain("--issues: 3 indexes, 2 skipped (a found issue or no extra).");
      clean(some.stdout, s.id);
      const none = await oracle([s.file, "--issues", "1"], s.local);
      expect(none.stdout).toContain("eval:oracle: 0 never-found issues in 0 cases, 0 decoys");
    },
    SLOW,
  );

  test(
    "points each target, scores with the matcher, leaks no gold text into a pointed run, and prints counts only",
    async () => {
      const s = await setup();
      const x = await oracle([s.file, "--repeat", "1", "--decoys", "1", "--out", s.out, ...s.runner], s.local);
      expect(x.stderr).toBe("");
      expect(x.code).toBe(0);
      clean(x.stdout, s.id);
      expect(x.stdout).toContain("Level file: issues pointed 1, with a scored call 1. Found in at least 1 call: 1 of 1.");
      expect(x.stdout).toContain("Level lines: issues pointed 1, with a scored call 1. Found in at least 1 call: 0 of 1.");
      expect(x.stdout).toContain("on no gold place) in at least 1 call: 1 of 1. In a majority: 1 of 1. Calls with a false claim: 1 of 1.");
      const runs = readRecords<Rec>(s.record).filter((r) => r.argv.includes("-p"));
      const points = runs.filter(isPoint);
      expect(points.length).toBe(3);
      expect(runs.length).toBe(4);
      for (const r of points) {
        expect(flag(r, "--tools")).toBe("Read,Grep,Glob");
        expect([flag(r, "--model"), flag(r, "--effort")]).toEqual(["claude-test", "medium"]);
        expect(r.argv.join(" ")).not.toContain("Bash");
        const seen = [r.argv.join(" "), r.stdin, ...Object.values(r.context), ...Object.values(r.files ?? {})].join("\n");
        expect(seen).not.toContain(GOLD);
        expect(seen).not.toContain(FOUND);
      }
      expect(points[0]?.stdin).toStartWith(`This change touches ${csv}. A reviewer suspects a defect in this file.`);
      expect(points[1]?.stdin).toStartWith(`This change touches ${csv} lines 3-3.`);
      const [name] = readdirSync(s.out).filter((f) => f.endsWith(".json"));
      const out = JSON.parse(readFileSync(join(s.out, name as string), "utf8")) as OracleOut;
      expect(out.targets.map((t) => [t.kind, t.calls.map((c) => `${c.level}:${c.status}`)])).toEqual([
        ["issue", ["file:found", "lines:missed"]],
        ["decoy", ["lines:claim"]],
      ]);
      expect(out.targets[0]?.calls[0]?.findings[0]?.path).toBe(csv);
      expect(out.stopped).toBe(false);
    },
    SLOW,
  );

  test(
    "starts no new call after the spent cost reaches --max-usd",
    async () => {
      const s = await setup();
      // The first pointed call and its matcher call cost $0.011.
      const x = await oracle([s.file, "--max-usd", "0.01", "--out", s.out, ...s.runner], s.local);
      expect(x.stderr).toBe("");
      expect(x.code).toBe(0);
      expect(x.stdout).toContain("The limit stopped the run before all calls.");
      expect(readRecords<Rec>(s.record).filter(isPoint).length).toBe(1);
      clean(x.stdout, s.id);
    },
    SLOW,
  );
});

describe("eval:oracle on a seeded set", () => {
  // The seeded set of tests/support/seed-fixture.ts with the seeds ARCH (feature.ts) and OMIT (other.ts). Extra 1 of the seeded case is
  // the natural bug item-1: feature.ts line 45 at the natural head, line 46 at the seeded head. A second host, the target-merge PR, shares
  // the bundle of the first. It gets one extra on block.ts line 3 (global index 4) and the seed AFTER (other.ts).
  let nat: NaturalSet;
  let set: string;
  let file: string;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(TMP, "seeded-"));
    nat = await makeNaturalSet(join(dir, "fx"));
    mkdirSync(join(dir, "hosts"));
    const second = addTargetMerge(nat);
    const caseFile = join(nat.dir, "cases", second, "case.json");
    const raw = JSON.parse(readFileSync(caseFile, "utf8"));
    raw.extras = [{ path: "src/block.ts", side: "new", lines: [3, 3], note: "A loop note.", text: "The loop note.", source: "other" }];
    writeFileSync(
      caseFile,
      `${JSON.stringify(raw, null, 2)}
`,
    );
    const open = hostsOf(nat.dir, join(dir, "hosts"));
    const host = (await open(nat.host)) as Host;
    const target = (await open(second)) as Host;
    const bind = async (h: Host, path: string) => (await bindingOf(h, path)) as SeedRecord["host"];
    const after = seedFields({
      kind: "local",
      path: PATHS.other,
      find: "export const o31 = 31;",
      replace: "export const o31 = 32;",
      anchor: { path: PATHS.other, text: "export const o31 = 32;" },
    });
    const seeds = join(dir, "seeds");
    saveStore(seeds, {
      format: 1,
      seeds: [
        keptSeed("sd00000000a1", ARCH, await bind(host, PATHS.feature)),
        keptSeed("sd00000000a2", OMIT, await bind(host, PATHS.other)),
        keptSeed("sd00000000a3", after, await bind(target, PATHS.other)),
      ],
    });
    const built = await buildSeededSet({ seeds, local: nat.dir });
    if ("refused" in built) throw new Error(built.refused);
    set = join(seeds, "set");
    // The pr7 case first, so its extras have the global indexes 0 to 3.
    const cs = readdirSync(join(set, "cases"))
      .map((id) => loadCase(join(set, "cases", id)))
      .sort((a, b) => (a.group === "pr7" ? -1 : b.group === "pr7" ? 1 : 0));
    expect(cs.length).toBe(2);
    const hash = (id: string) =>
      createHash("sha256")
        .update(readFileSync(join(set, "cases", id, "case.json"), "utf8"))
        .digest("hex");
    const r = {
      ...result(
        cs.map((c) => info(c.id, c.extras, { base: c.local?.base, head: c.local?.head, bugs: c.bugs, traps: c.traps, human: c.human })),
        cs.map((c) => caseRun(c.id, 1, [])),
        "local",
      ),
      fingerprint: setFingerprint(cs.map((c) => ({ id: c.id, hash: hash(c.id) }))),
    } as EvalResult;
    file = join(dir, "r.json");
    writeFileSync(file, JSON.stringify(r));
    mkdirSync(join(set, "labels", labelKey(r)), { recursive: true });
    writeFileSync(join(set, "labels", labelKey(r), "matches.json"), JSON.stringify({ format: 1, cases: {} }));
  }, SLOW);

  async function pointOnce(extra: string[], issues = "1", decoys = "1") {
    const run = mkdtempSync(join(dir, "run-"));
    const record = join(run, "calls.jsonl");
    const scenario = join(run, "scenario.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        record,
        auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(run, "projects") },
        delayMs: 1,
        files: true,
        bySchema: { review: { fixture: stream(run, "point", ["Read", "Grep", "Glob", ...GIT_TOOLS, "StructuredOutput"], ["rl-git"]) } },
        seq: { review: [1, 2].map(() => ({ review: { summary: "No defect.", findings: [] } })) },
      }),
    );
    const out = join(run, "out");
    const x = await oracle(
      [
        file,
        "--issues",
        issues,
        "--levels",
        "lines",
        "--repeat",
        "1",
        "--decoys",
        decoys,
        "--out",
        out,
        ...extra,
        "--runner",
        process.execPath,
        FAKE,
        scenario,
      ],
      set,
    );
    const points = readRecords<Rec>(record).filter(isPoint);
    const [name] = readdirSync(out).filter((f) => f.endsWith(".json"));
    return { x, points, out: JSON.parse(readFileSync(join(out, name as string), "utf8")) as OracleOut };
  }

  const repoText = (r: Rec | undefined, path: string = PATHS.feature) =>
    Object.entries(r?.files ?? {})
      .filter(([k]) => k.replaceAll("\\", "/").endsWith(path))
      .map(([, v]) => v)
      .join("\n");

  test(
    "--unseeded (the default) reviews the natural head: no seed line in the snapshot, and the issue place at the natural head",
    async () => {
      const { x, points, out } = await pointOnce(["--natural", nat.dir]);
      expect(x.stderr).toBe("");
      expect(x.code).toBe(0);
      expect(x.stdout).toContain("Snapshot: the natural head without seeds for 1 of 1 cases. The other 0 use the seeded head");
      expect(points.length).toBe(2);
      const text = repoText(points[0]);
      expect(text).toContain(ARCH.find.trim());
      expect(text).not.toContain("store.set(k, v);");
      expect(points[0]?.stdin).toStartWith(`This change touches ${PATHS.feature} lines 45-45.`);
      expect(out.unseeded).toBe(true);
      expect(out.targets[0]?.seeds).toEqual([]);
      expect(out.targets[0]?.calls.map((c) => c.status)).toEqual(["missed"]);
      // The decoy keeps the seeded case ID and the natural gold places.
      expect(out.targets.map((t) => [t.kind, t.case === out.targets[0]?.case, t.seeds?.length])).toEqual([
        ["issue", true, 0],
        ["decoy", true, 0],
      ]);
    },
    SLOW,
  );

  test(
    "two natural hosts on one bundle each review their own head",
    async () => {
      const { x, points, out } = await pointOnce(["--natural", nat.dir], "1,4", "0");
      expect(x.stderr).toBe("");
      expect(x.code).toBe(0);
      expect(x.stdout).toContain("Snapshot: the natural head without seeds for 2 of 2 cases.");
      expect(points.map((p) => p.stdin.split(". ")[0])).toEqual([
        `This change touches ${PATHS.feature} lines 45-45`,
        "This change touches src/block.ts lines 3-3",
      ]);
      // pr7 ends at c4 (block.ts takes number[]). The target-merge PR ends at p3 (block.ts takes readonly number[]).
      expect(repoText(points[0], "src/block.ts")).toContain("run(list: number[])");
      expect(repoText(points[1], "src/block.ts")).toContain("run(list: readonly number[])");
      expect(repoText(points[1], PATHS.other)).not.toContain("o31 = 32;");
      expect(out.targets.map((t) => t.calls[0]?.status)).toEqual(["missed", "missed"]);
    },
    SLOW,
  );

  test(
    "--seeded reviews the seeded head, and the unseeded run refuses a missing natural set",
    async () => {
      const { x, points, out } = await pointOnce(["--seeded"]);
      expect(x.code).toBe(0);
      expect(repoText(points[0])).toContain("store.set(k, v);");
      expect(points[0]?.stdin).toStartWith(`This change touches ${PATHS.feature} lines 46-46.`);
      expect(out.targets[0]?.seeds?.length).toBeGreaterThan(0);
      const none = await oracle([file, "--natural", join(dir, "no-such-set")], set);
      expect(none.code).toBe(2);
      expect(none.stderr).toContain("Give --natural <folder> with the natural set, or --seeded");
    },
    SLOW,
  );

  test(
    // The preload no-real-claude.ts fails the run on any claude lookup, and --rescore refuses --runner and --real.
    "--rescore reads an oracle result, prints counts only, and makes no CLI call",
    async () => {
      const { out } = await pointOnce(["--seeded"]);
      const id = out.targets[0]?.case as string;
      // An older result: no stored places, and a decoy answer on the seed of feature.ts (line 23 at the seeded head).
      const old: OracleOut = {
        ...out,
        unseeded: undefined,
        targets: [
          {
            kind: "decoy",
            case: id,
            extra: null,
            global: null,
            path: PATHS.feature,
            side: "new",
            lines: [21, 21],
            calls: [
              {
                level: "lines",
                repeat: 1,
                status: "claim",
                costUsd: 0,
                summary: "",
                findings: [{ title: "SECRETTITLE", trigger: "t", impact: "i", path: PATHS.feature, line: 23, severity: "major" }],
              },
            ],
          },
        ],
      };
      const f = join(dir, "old-oracle.json");
      writeFileSync(f, JSON.stringify(old));
      const x = await oracle(["--rescore", f, "--exclude", "1"], set);
      expect(x.stderr).toBe("");
      expect(x.code).toBe(0);
      expect(x.stdout).toContain("Calls with a false claim: 0 of 1.");
      expect(x.stdout).toContain("(the old rule): 1 of 1.");
      expect(x.stdout).toContain("Excluded issues (--exclude): 1 indexes, 0 with calls.");
      for (const bad of [id, "SECRETTITLE", "src/"]) expect(x.stdout).not.toContain(bad);
    },
    SLOW,
  );
});
