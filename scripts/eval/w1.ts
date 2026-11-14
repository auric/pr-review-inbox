// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Wave W1 of docs/plans/review-v2/review-quality-2026.md in one command (docs/eval/local.md): pre-checks, the probe smoke run, the
// baseline (eval:ab), the labels (eval:label), and a summary to paste. Each step writes <step>.done into the results folder, and a
// re-run skips it. Usage: see USAGE.
// Exit codes: 0 done, 1 a step failed, 2 a usage error, a failed pre-check, or a No answer, 3 the usage limit, 130 stopped.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, dbPath } from "../../src/server/config";
import { DEFAULT_PORT } from "../../src/server/main";
import { createClaudeRunner } from "../../src/server/review/claude";
import { main as abMain, failedRuns } from "./ab";
import { loadCases, setDir } from "./cases";
import { readResult, summaryText } from "./compare";
import { main as labelMain, loadGrounding } from "./label";
import { main as runMain } from "./run";
import { type EvalResult, score } from "./score";

const REPO = resolve(import.meta.dir, "../..");
export const USAGE = `Usage: bun run eval:w1 -- [--results <folder>] [--yes] [--skip-smoke] [--runner <command> <args...>]
--results: the folder of the results and the step markers. Default: eval-results/w1.
--yes: start the baseline and the labels without a question.
--skip-smoke: skip the probe smoke run. A broken setup then fails in the costly baseline.
--runner runs the given CLI instead of the claude CLI on PATH and must come last. It is for tests.`;
export const STEPS = ["smoke", "baseline", "labels"] as const;
export type Step = (typeof STEPS)[number];
// review-quality-2026.md section 3, wave W1. Not measured.
export const PLAN_TEXT =
  "Plan estimate for the W1 baseline and labels, not measured: about $140-180 and about 5 hours at the shipped efforts.";
export const PASTE = "Paste the lines between the two markers to Claude.";
export const BEGIN = "===== W1 summary begin =====";
export const END = "===== W1 summary end =====";
// label.ts call(): the text of a label run that ended with the usage limit, and the cost line.
const LABEL_LIMIT = / run ended with usage_limit\./;
const LABEL_COST = /^Label runs: .*, total \$(\d+(?:\.\d+)?)\.$/m;
// run.ts, ab.ts, and label.ts set these for their own runs and do not restore them.
const STEP_ENV = ["REVIEW_LOOP_DATA_DIR", "REVIEW_LOOP_SECRETS", "REVIEW_LOOP_EVAL_LOCAL"] as const;

type Main = (argv: string[]) => Promise<number>;
export type Deps = { run: Main; ab: Main; label: Main; ask: (question: string) => boolean };
const askUser = (question: string) => /^y(es)?$/i.test(prompt(question)?.trim() ?? "");
const DEPS: Deps = { run: runMain, ab: abMain, label: labelMain, ask: askUser };

type Marker = { file: string | null; costUsd: number; minutes: number; finishedAt: string };
type Outcome = { code: number; file: string | null; costUsd: number; limit: boolean; why: string | null };

export const markerPath = (results: string, step: Step) => join(results, `${step}.done`);
const readMarker = (results: string, step: Step): Marker | null =>
  existsSync(markerPath(results, step)) ? (JSON.parse(readFileSync(markerPath(results, step), "utf8")) as Marker) : null;
const usd = (x: number) => `$${x.toFixed(2)}`;
// Coordinator decision: above this share of failed runs, the baseline numbers are not usable.
const MAX_FAILED_SHARE = 0.25;
// The error kinds of the failed runs with their counts, for example "process 2, max_turns 1".
const failedKinds = (r: EvalResult) => {
  const n = new Map<string, number>();
  for (const x of r.runs)
    if (x.status !== "completed" && x.status !== "incomplete") n.set(x.errorKind ?? x.status, (n.get(x.errorKind ?? x.status) ?? 0) + 1);
  return [...n].map(([k, c]) => `${k} ${c}`).join(", ");
};
const failedText = (r: EvalResult) => `${failedRuns(r)} of ${r.runs.length} baseline runs failed: ${failedKinds(r)}`;
const costOf = (r: EvalResult) => r.runs.reduce((n, x) => n + (x.usage?.costUsd ?? 0), 0);

// True when something accepts a TCP connection on 127.0.0.1:port within 2 s.
export function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: "127.0.0.1", port });
    const end = (v: boolean) => {
      s.destroy();
      done(v);
    };
    s.setTimeout(2000, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

// The input checks of eval:local (local.ts main) for the data folder of the app, or null.
export function dataRefusal(): string | null {
  const app = dataDir();
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(join(app, "config.json"), "utf8")) as Record<string, unknown>;
  } catch {
    // No config.json: the base URL check below refuses.
  }
  const field = (k: string) => (typeof config[k] === "string" && config[k] ? (config[k] as string) : null);
  const url = field("baseUrl");
  let db: string | null = null;
  try {
    db = url ? dbPath(app, url) : null;
  } catch {
    db = null;
  }
  if (!db) return "No local eval data: config.json of the app has no base URL.";
  if (!existsSync(db) || !existsSync(join(app, "git"))) return "No local eval data: the database or the git cache of the app is missing.";
  if (!field("userSlug")) return "No local eval data: config.json of the app has no user slug.";
  return null;
}

// A step that runs again starts in an empty folder. The earlier folder stays for its cost record.
function freshFolder(dir: string) {
  if (existsSync(dir)) renameSync(dir, `${dir}-earlier-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

const firstJson = (dir: string) => (existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".json")) : undefined);

// The checks of a result file after a smoke or baseline run.
function runOutcome(code: number, dir: string, expected: number | null): Outcome {
  const name = firstJson(dir);
  if (!name) return { code: code || 1, file: null, costUsd: 0, limit: false, why: `the run gave no result file (exit code ${code})` };
  const file = join(dir, name);
  const r = readResult(file);
  const limit = r.runs.some((x) => x.errorKind === "usage_limit");
  const failed = failedRuns(r);
  const why =
    code === 130
      ? "the run was stopped"
      : failed
        ? `${failed} of ${r.runs.length} case runs failed`
        : expected !== null && r.runs.length < expected
          ? `the run is incomplete: ${r.runs.length} of ${expected} case runs`
          : code !== 0
            ? `the run ended with exit code ${code}`
            : null;
  return { code, file, costUsd: costOf(r), limit, why };
}

// Runs f with console.log copied into the returned text.
async function teed(f: () => Promise<number>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
    log(...a);
  };
  try {
    return { code: await f(), text: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

// The arguments of each step. eval:ab takes no --real: it runs the claude CLI on PATH unless --runner is given.
export function stepArgs(results: string, runner: string[] | null) {
  const cli = runner ? ["--runner", ...runner] : ["--real"];
  const baseline = join(results, "baseline");
  return {
    smoke: ["--set", "probe", "--repeat", "1", "--out", join(results, "smoke"), ...cli],
    baseline: ["--clean", "8", "--repeat", "3", "--baseline-only", "--review-only", "--results", baseline, ...(runner ? cli : [])],
    plan: [baseline],
    labels: [baseline, ...cli],
  };
}

export async function main(argv: string[], deps: Deps = DEPS): Promise<number> {
  const at = argv.indexOf("--runner");
  const runner = at < 0 ? null : argv.slice(at + 1);
  let v: { results?: string; yes?: boolean; "skip-smoke"?: boolean };
  try {
    v = parseArgs({
      args: at < 0 ? argv : argv.slice(0, at),
      strict: true,
      allowPositionals: false,
      options: { results: { type: "string" }, yes: { type: "boolean" }, "skip-smoke": { type: "boolean" } },
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (runner?.length === 0) {
    console.error(`--runner needs a command.\n${USAGE}`);
    return 2;
  }
  const results = resolve(v.results ?? join(REPO, "eval-results", "w1"));
  const args = stepArgs(results, runner);

  // Step 0: no check starts a model call.
  const checked = await createClaudeRunner({ command: runner ?? undefined }).check();
  if (!checked.ok) {
    console.error(`The Claude CLI check failed: ${checked.message}`);
    return 2;
  }
  console.log(`Claude Code ${checked.version}, authMethod claude.ai.`);
  const port = Number(process.env.REVIEW_LOOP_PORT ?? DEFAULT_PORT);
  if (await listening(port)) {
    console.error("Close PR Review Inbox first.");
    return 2;
  }
  const refused = dataRefusal();
  if (refused) {
    console.error(`${refused} See docs/eval/local.md.`);
    return 2;
  }
  mkdirSync(results, { recursive: true });

  const record = (step: Step, outcome: string, costUsd: number, minutes: number) =>
    appendFileSync(join(results, "costs.jsonl"), `${JSON.stringify({ step, outcome, costUsd, minutes, at: new Date().toISOString() })}\n`);
  // One step: skip it when its marker exists, else run it and write the marker only after a clean end.
  const step = async (name: Step, run: () => Promise<Outcome | "no">): Promise<number | null> => {
    if (readMarker(results, name)) {
      console.log(`Done before: ${name}`);
      return null;
    }
    console.log(`\n=== W1 step: ${name} ===`);
    const started = Date.now();
    const env = STEP_ENV.map((k) => [k, process.env[k]] as const);
    let o: Outcome | "no";
    try {
      o = await run();
    } finally {
      for (const [k, x] of env)
        if (x === undefined) delete process.env[k];
        else process.env[k] = x;
    }
    if (o === "no") {
      console.log("Stopped. Run bun run eval:w1 again to continue.");
      return 2;
    }
    const minutes = (Date.now() - started) / 60000;
    const ok = !o.limit && o.why === null;
    record(name, o.limit ? "usage limit" : ok ? "done" : "failed", o.costUsd, minutes);
    if (o.limit) {
      console.error(
        `Your Claude usage limit is reached. Run \`bun run eval:w1\` again after the limit resets. Finished steps are kept. This ${name} attempt cost ${usd(o.costUsd)}.`,
      );
      if (name === "baseline") console.error("eval:ab cannot continue a cut baseline. The next run repeats the whole baseline.");
      return 3;
    }
    if (!ok) {
      console.error(`The ${name} step failed: ${o.why}. This attempt cost ${usd(o.costUsd)}.`);
      return o.code === 130 ? 130 : o.code === 2 ? 2 : 1;
    }
    const marker: Marker = {
      file: o.file && relative(results, o.file),
      costUsd: o.costUsd,
      minutes,
      finishedAt: new Date().toISOString(),
    };
    writeFileSync(markerPath(results, name), `${JSON.stringify(marker, null, 2)}\n`);
    return null;
  };

  // Step 1: the probe set once, with the real CLI.
  if (v["skip-smoke"]) console.log("Warning: --skip-smoke skips the probe smoke run. A broken setup then fails in the costly baseline.");
  else {
    const stop = await step("smoke", async () => {
      const dir = join(results, "smoke");
      freshFolder(dir);
      const code = await deps.run(args.smoke);
      const o = runOutcome(code, dir, loadCases("all", setDir("probe")).length);
      if (o.file) {
        const r = readResult(o.file);
        console.log(
          `Smoke: ${r.runs.length} case runs, ${failedRuns(r)} failed, ${usd(o.costUsd)}, ${r.runs.reduce((n, x) => n + (x.minutes ?? 0), 0).toFixed(1)} min.`,
        );
      }
      return o;
    });
    if (stop !== null) return stop;
  }

  // Step 2: the baseline.
  const baseline = join(results, "baseline");
  let stop = await step("baseline", async () => {
    console.log(PLAN_TEXT);
    if (!v.yes && !deps.ask("Start the baseline? [y/N]")) return "no";
    freshFolder(baseline);
    const code = await deps.ab(args.baseline);
    // eval:ab passes no case list, so a complete run holds cases x repeats runs.
    const o = runOutcome(code, join(baseline, "review-baseline"), null);
    if (!o.file || o.limit || code === 130) return o;
    const r = readResult(o.file);
    const total = r.cases.length * r.repeat;
    if (r.runs.length < total) return { ...o, why: `the run is incomplete: ${r.runs.length} of ${total} case runs` };
    const failed = failedRuns(r);
    if (failed === 0) return o;
    if (failed > total * MAX_FAILED_SHARE)
      return { ...o, why: `${failed} of ${total} baseline runs failed (${failedKinds(r)}), more than 25%, so the numbers are not usable` };
    // A failed run scores as a run with no finding (score.ts notCompleted). eval:ab --baseline accepts the result.
    console.log(`Warning: ${failedText(r)}. The baseline is kept. The summary marks it.`);
    return { ...o, why: null };
  });
  if (stop !== null) return stop;

  // Step 3: the labels. eval:label resumes from its cache.
  stop = await step("labels", async () => {
    const dry = await teed(() => deps.label(args.plan));
    const none: Outcome = { code: 0, file: null, costUsd: 0, limit: false, why: null };
    if (dry.code === 0) return none;
    if (dry.code !== 2 || !dry.text.includes("Open work:"))
      return { ...none, code: dry.code, why: `eval:label refused the baseline (exit code ${dry.code})` };
    if (!v.yes && !deps.ask("Start the labels? [y/N]")) return "no";
    const real = await teed(() => deps.label(args.labels));
    const costUsd = Number(real.text.match(LABEL_COST)?.[1] ?? 0);
    const limit = LABEL_LIMIT.test(real.text);
    return { code: real.code, file: null, costUsd, limit, why: real.code === 0 ? null : `eval:label ended with exit code ${real.code}` };
  });
  if (stop !== null) return stop;

  // Step 4: aggregate numbers only. Case rows show ordinals. No path: it can hold the user name.
  const base = readMarker(results, "baseline");
  const r = readResult(join(results, base?.file as string));
  const ids = r.cases.map((c) => c.id);
  const steps = STEPS.map((s) => {
    const m = readMarker(results, s);
    return m ? `${s} ${usd(m.costUsd)}, ${m.minutes.toFixed(1)} min` : `${s} skipped`;
  });
  console.log(
    [
      "",
      PASTE,
      BEGIN,
      `Steps: ${steps.join("; ")}.`,
      `Baseline: ${r.cases.length} cases x ${r.repeat} repeats, ${r.runs.length} case runs, ${failedRuns(r)} failed runs, ${usd(costOf(r))}.`,
      ...(failedRuns(r) ? [`Marked: ${failedText(r)}. The baseline is kept with these runs. They score as runs with no finding.`] : []),
      summaryText(r, score(r, loadGrounding(r)), (id) => `case ${ids.indexOf(id) + 1}`),
      END,
    ].join("\n"),
  );
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
