// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// bun run eval:w1: pre-checks, step order, markers, questions, failed steps, and the usage limit. The auth check runs the fake CLI.
// The steps run stand-ins of run.ts, ab.ts, and label.ts that write synthetic result files.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CaseRun, EvalResult } from "../../scripts/eval/score";
import { BEGIN, type Deps, END, main, markerPath, PASTE } from "../../scripts/eval/w1";
import { dataDir, dbPath } from "../../src/server/config";

const ROOT = resolve(import.meta.dir, "../..");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const TMP = mkdtempSync(join(tmpdir(), "rl-eval-w1-test-"));
const LIVE = join(TMP, "live");
const BASE_URL = "https://bitbucket.example.invalid";
// Distinctive synthetic case text: the summary must show none of it.
const CASE_ID = "zebracorn-case";
const CASE_TITLE = "Quokkaflux helpers";
const ENV = ["REVIEW_LOOP_DATA_DIR", "REVIEW_LOOP_EVAL_LOCAL", "REVIEW_LOOP_PORT", "REVIEW_LOOP_SECRETS"] as const;
const saved = ENV.map((k) => [k, process.env[k]] as const);

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });

let runner: string[];
beforeAll(async () => {
  console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/w1.ts", import.meta.dir)}`);
  mkdirSync(join(LIVE, "git"), { recursive: true });
  writeFileSync(join(LIVE, "config.json"), JSON.stringify({ baseUrl: BASE_URL, userSlug: "me" }));
  writeFileSync(dbPath(LIVE, BASE_URL), "");
  process.env.REVIEW_LOOP_DATA_DIR = LIVE;
  process.env.REVIEW_LOOP_EVAL_LOCAL = join(TMP, "eval-local");
  process.env.REVIEW_LOOP_PORT = String(await freePort());
  const scenario = join(TMP, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      record: join(TMP, "calls.jsonl"),
      auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(TMP, "projects") },
    }),
  );
  runner = ["--runner", process.execPath, FAKE, scenario];
});
afterAll(() => {
  for (const [k, v] of saved)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
});

const caseRun = (n: number, repeat: number, o: Partial<CaseRun> = {}): CaseRun => ({
  case: `${CASE_ID}-${n}`,
  repeat,
  run: n,
  status: "completed",
  errorKind: null,
  error: null,
  model: "opus",
  effort: "high",
  effortDefault: null,
  startedAt: 1,
  finishedAt: 2,
  minutes: 1,
  usage: { costUsd: 0.5 } as CaseRun["usage"],
  items: [],
  dropped: [],
  questions: 0,
  ...o,
});

// A result of `cases` cases x `repeat` repeats. bad: overrides of the first nBad runs.
function result(cases: number, repeat: number, bad: Partial<CaseRun> = {}, nBad = 1): EvalResult {
  const runs: CaseRun[] = [];
  for (let k = 1; k <= repeat; k++) for (let n = 1; n <= cases; n++) runs.push(caseRun(n, k, runs.length < nBad ? bad : {}));
  return {
    format: 1,
    createdAt: "2026-11-14T00:00:00.000Z",
    commit: "abc",
    dirty: false,
    promptVersion: "2.7",
    cliVersion: "2.1.0",
    runner: "fake",
    profile: { id: "general", name: "Review", revision: "0123456789" },
    volume: null,
    set: "local",
    tolerance: 3,
    repeat,
    cases: Array.from({ length: cases }, (_, k) => ({
      id: `${CASE_ID}-${k + 1}`,
      title: CASE_TITLE,
      language: "ts",
      changedLines: 3,
      base: "b",
      head: "h",
      bugs: [],
      traps: [],
    })),
    runs,
  };
}

const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;
const save = (dir: string, r: EvalResult) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-14T00-00-00-000Z-abc.json"), JSON.stringify(r));
};

// Stand-ins of the three scripts. calls: the order of the calls and their arguments.
type Script = {
  smoke?: Partial<CaseRun>;
  baseline?: Partial<CaseRun>;
  labelText?: string;
  labelCode?: number;
  answers?: boolean[];
  baselineFailed?: number;
};
function deps(s: Script = {}) {
  const calls: { name: string; argv: string[] }[] = [];
  const asked: string[] = [];
  let dataAtAb = "";
  const d: Deps = {
    run: async (argv) => {
      calls.push({ name: "run", argv });
      // run.ts sets this and does not restore it.
      process.env.REVIEW_LOOP_DATA_DIR = join(TMP, "run-temp");
      save(flag(argv, "--out"), result(8, 1, s.smoke));
      return 0;
    },
    ab: async (argv) => {
      calls.push({ name: "ab", argv });
      dataAtAb = dataDir();
      const r = result(16, 3, s.baseline, s.baselineFailed);
      save(join(flag(argv, "--results"), "review-baseline"), r);
      return r.runs.some((x) => x.status !== "completed") ? 1 : 0;
    },
    label: async (argv) => {
      const real = argv.includes("--runner") || argv.includes("--real");
      calls.push({ name: real ? "label" : "label-plan", argv });
      if (!real) {
        console.log("Open work: 2 matcher chunk pairs, 3 findings without a judge label, 1 cases without calibration.");
        return 2;
      }
      console.log(s.labelText ?? "Label runs: matcher 2 ($0.06), judge 1 ($0.30), calibration 1 ($0.10), total $0.46.");
      return s.labelCode ?? 0;
    },
    ask: (q) => {
      asked.push(q);
      return s.answers?.shift() ?? false;
    },
  };
  return { d, calls, asked, dataAtAb: () => dataAtAb };
}

async function go(args: string[], d: Deps) {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  try {
    const code = await main([...args, ...runner], d);
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

let results: string;
beforeEach(() => {
  results = mkdtempSync(join(TMP, "results-"));
});
const markers = () => (["smoke", "baseline", "labels"] as const).filter((s) => existsSync(markerPath(results, s)));

describe("eval:w1", () => {
  test("runs smoke, baseline, plan, and labels in order, writes the markers, and a re-run skips them", async () => {
    const f = deps();
    const r = await go(["--results", results, "--yes"], f.d);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(f.calls.map((c) => c.name)).toEqual(["run", "ab", "label-plan", "label"]);
    expect(f.asked).toEqual([]);
    const [smoke, ab, plan, label] = f.calls.map((c) => c.argv) as string[][];
    expect(smoke).toEqual(["--set", "probe", "--repeat", "1", "--out", join(results, "smoke"), ...runner]);
    expect(ab).toEqual([
      "--clean",
      "8",
      "--repeat",
      "3",
      "--baseline-only",
      "--review-only",
      "--results",
      join(results, "baseline"),
      ...runner,
    ]);
    expect(plan).toEqual([join(results, "baseline")]);
    expect(label).toEqual([join(results, "baseline"), ...runner]);
    // The smoke run changed the data folder variable. The baseline still saw the live folder.
    expect(f.dataAtAb()).toBe(LIVE);
    expect(markers()).toEqual(["smoke", "baseline", "labels"]);
    expect(r.stdout).toContain("Claude Code ");
    expect(r.stdout).toContain("Smoke: 8 case runs, 0 failed, $4.00");
    expect(r.stdout).toContain("about $140-180 and about 5 hours");

    // The summary: aggregates and ordinals between the markers, no case text and no path.
    const summary = r.stdout.slice(r.stdout.indexOf(BEGIN), r.stdout.indexOf(END));
    expect(r.stdout.indexOf(PASTE)).toBeLessThan(r.stdout.indexOf(BEGIN));
    expect(summary).toContain("Steps: smoke $4.00");
    expect(summary).toContain("labels $0.46");
    expect(summary).toContain("Baseline: 16 cases x 3 repeats, 48 case runs, 0 failed runs, $24.00.");
    expect(summary).toContain("case 2");
    for (const s of [CASE_ID, CASE_TITLE, results, TMP]) expect(summary).not.toContain(s);

    const again = deps();
    const r2 = await go(["--results", results], again.d);
    expect(r2.code).toBe(0);
    expect(again.calls).toEqual([]);
    expect(again.asked).toEqual([]);
    for (const s of ["smoke", "baseline", "labels"]) expect(r2.stdout).toContain(`Done before: ${s}`);
    expect(r2.stdout).toContain(BEGIN);
  });

  test("a failed smoke run stops before the baseline and writes no marker", async () => {
    const f = deps({ smoke: { status: "failed", errorKind: "process" } });
    const r = await go(["--results", results, "--yes"], f.d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The smoke step failed: 1 of 8 case runs failed.");
    expect(f.calls.map((c) => c.name)).toEqual(["run"]);
    expect(markers()).toEqual([]);
  });

  test("without --yes each step asks, and a No answer stops with no marker", async () => {
    const no = deps({ answers: [false] });
    const r = await go(["--results", results], no.d);
    expect(r.code).toBe(2);
    expect(no.asked).toEqual(["Start the baseline? [y/N]"]);
    expect(no.calls.map((c) => c.name)).toEqual(["run"]);
    expect(markers()).toEqual(["smoke"]);

    const half = deps({ answers: [true, false] });
    const r2 = await go(["--results", results], half.d);
    expect(r2.code).toBe(2);
    expect(half.asked).toEqual(["Start the baseline? [y/N]", "Start the labels? [y/N]"]);
    expect(half.calls.map((c) => c.name)).toEqual(["ab", "label-plan"]);
    expect(markers()).toEqual(["smoke", "baseline"]);
  });

  test("--skip-smoke warns and starts with the baseline", async () => {
    const f = deps();
    const r = await go(["--results", results, "--yes", "--skip-smoke"], f.d);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Warning: --skip-smoke");
    expect(f.calls.map((c) => c.name)).toEqual(["ab", "label-plan", "label"]);
    expect(r.stdout).toContain("smoke skipped");
  });

  test("a usage limit in the baseline exits 3 with no marker, and the next run repeats the baseline in a new folder", async () => {
    const f = deps({ baseline: { status: "failed", errorKind: "usage_limit" } });
    const r = await go(["--results", results, "--yes"], f.d);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Your Claude usage limit is reached. Run `bun run eval:w1` again after the limit resets.");
    expect(r.stderr).toContain("The next run repeats the whole baseline.");
    expect(r.stderr).toContain("This baseline attempt cost $24.00.");
    expect(markers()).toEqual(["smoke"]);

    const again = deps();
    const r2 = await go(["--results", results, "--yes"], again.d);
    expect(r2.code).toBe(0);
    expect(again.calls.map((c) => c.name)).toEqual(["ab", "label-plan", "label"]);
    // The cut baseline stays aside. The summary reads the new result only.
    expect(readdirSync(results).filter((x) => x.startsWith("baseline-earlier-")).length).toBe(1);
    expect(r2.stdout).toContain("48 case runs, 0 failed runs");
  });

  test("a complete baseline with 1 failed run of 48 keeps its marker, warns, and the summary marks it", async () => {
    const f = deps({ baseline: { status: "failed", errorKind: "max_turns" } });
    const r = await go(["--results", results, "--yes"], f.d);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Warning: 1 of 48 baseline runs failed: max_turns 1. The baseline is kept. The summary marks it.");
    expect(markers()).toEqual(["smoke", "baseline", "labels"]);
    const summary = r.stdout.slice(r.stdout.indexOf(BEGIN), r.stdout.indexOf(END));
    expect(summary).toContain("48 case runs, 1 failed runs");
    expect(summary).toContain("Marked: 1 of 48 baseline runs failed: max_turns 1.");
  });

  test("a baseline with 40% failed runs exits 1 with no marker", async () => {
    const f = deps({ baseline: { status: "failed", errorKind: "process" }, baselineFailed: 20 });
    const r = await go(["--results", results, "--yes"], f.d);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("The baseline step failed: 20 of 48 baseline runs failed (process 20), more than 25%");
    expect(markers()).toEqual(["smoke"]);
    expect(f.calls.map((c) => c.name)).toEqual(["run", "ab"]);
  });

  test("a usage limit in the labels exits 3 with no labels marker", async () => {
    const f = deps({ labelText: "A judge run ended with usage_limit.", labelCode: 1 });
    const r = await go(["--results", results, "--yes"], f.d);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Your Claude usage limit is reached.");
    expect(markers()).toEqual(["smoke", "baseline"]);
  });

  test("a listener on the app port exits 2 before any step", async () => {
    const server: Server = createServer();
    await new Promise<void>((done) => server.listen(Number(process.env.REVIEW_LOOP_PORT), "127.0.0.1", done));
    try {
      const f = deps();
      const r = await go(["--results", results, "--yes"], f.d);
      expect(r.code).toBe(2);
      expect(r.stderr).toBe("Close PR Review Inbox first.");
      expect(f.calls).toEqual([]);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test("a data folder without the app database exits 2 before any step", async () => {
    const old = process.env.REVIEW_LOOP_DATA_DIR;
    process.env.REVIEW_LOOP_DATA_DIR = join(TMP, "no-data");
    try {
      const f = deps();
      const r = await go(["--results", results, "--yes"], f.d);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("No local eval data");
      expect(f.calls).toEqual([]);
    } finally {
      process.env.REVIEW_LOOP_DATA_DIR = old;
    }
  });
});
