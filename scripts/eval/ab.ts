// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate U-V1 in one command (docs/plans/review-v3.md, docs/eval/local.md): build the local set from the data folder of the app, then
// run the shipped profile (baseline) and the candidate on it, for the review cases and the re-review cases, and print one table each.
// Usage: see USAGE. Without --runner, the runs use the claude CLI on PATH. Exit codes: 0 done, 1 a build error or a failed run, 2 a
// usage error or a refusal, 130 stopped.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROFILES_VERSION } from "../../src/server/config";
import { delegation, type Profile, profileRevision, promptVersion } from "../../src/server/review/catalog";
import { parseDiff } from "../../src/server/review/diffmap";
import { git } from "../../src/server/review/git";
import { diffArgs } from "../../src/server/review/workspace";
import { EFFORTS, REVIEWER_MODES, VERIFIER_MODES } from "../../src/shared/dto";
import { bundleRepo, type EvalCase, loadCases, localDir, setDir, setFingerprint } from "./cases";
import { compareText, readResult, refusal, suiteDelta } from "./compare";
import { main as buildMain, type Manifest } from "./local";
import { callsDir, checkoutState, evalProfile, finderChange, parseOptions, main as runMain } from "./run";
import { type EvalResult, finished, keptRun, score } from "./score";

const REPO = resolve(import.meta.dir, "../..");
export const USAGE = `Usage: bun run eval:ab -- [--repeat N] [--candidate-repeat N] [--candidate-variants a,b] [--candidate-modules a,b] [--effort ${EFFORTS.join("|")}] [--candidate-effort ${EFFORTS.join("|")}]
  [--candidate-reviewer-effort ${EFFORTS.join("|")}] [--candidate-reviewer-mode ${REVIEWER_MODES.join("|")}] [--candidate-verifier ${VERIFIER_MODES.join("|")}] [--candidate-verifier-effort ${EFFORTS.join("|")}]
  [--candidate-replay] [--baseline-only] [--review-only] [--large] [--clean N] [--db <db-*.sqlite>] [--cache <git folder>] [--out <folder>] [--user <slug>] [--results <folder>] [--baseline <folder>] [--resume] [--runner <command> <args...>]
--results: the folder of the result files. Default: a new folder in eval-results/.
--resume: continue the cut baseline result in each <mode>-baseline folder of --results (run.ts --resume). It needs --results and --baseline-only. Give the flags of the cut run. --repeat can be lower when the finished runs fit.
--baseline: the folder of an earlier eval:ab run. Its review-baseline/ and rereview-baseline/ results replace the baseline runs. A candidate result there that matches the current shipped profile can serve as well. A mode without a result runs the baseline.
--repeat: the repeats of the baseline. --candidate-repeat: the repeats of the candidate, at most those of the baseline. Default: --repeat.
--candidate-variants and --candidate-modules: what the candidate adds to the shipped profile. Default: nothing, so the candidate is the shipped profile.
--effort: the effort of the baseline and candidate runs. Default: the effort of the shipped profile.
--candidate-effort: the effort of the candidate runs. Default: the effort of the baseline.
--candidate-reviewer-effort and --candidate-reviewer-mode: the rl-reviewer effort and mode of the candidate runs. Default: those of the shipped profile.
--candidate-verifier and --candidate-verifier-effort: the verify mode and effort of the candidate runs. Default: those of the shipped profile.
--candidate-replay: the candidate replays the recorded finder calls of the baseline and runs only the verify calls. It refuses a candidate flag that changes the finder.
--baseline-only: run only the baseline. --review-only: skip the re-review cases.
--large: run only the review cases that give the baseline the rl-reviewer agent. The re-review cases do not run.
--clean N: the clean cases of the set build (eval:local --clean). Give the same N to each run that compares with a stored baseline.
--runner runs the given CLI instead of the claude CLI on PATH and must come last.`;
// review-quality-2026.md E2: the default candidate is the shipped profile.
const DEFAULT_VARIANTS = "";
const DEFAULT_MODULES = "";

export type Mode = "review" | "rereview";
export type AbOptions = {
  repeat: string;
  // null: the candidate runs --repeat repeats.
  candidateRepeat: string | null;
  variants: string[];
  modules: string[];
  // null: both sides run with the effort of the shipped profile.
  baseEffort: string | null;
  // null: the candidate runs with the effort of the baseline.
  effort: string | null;
  // null: the candidate runs with the rl-reviewer effort of the shipped profile.
  reviewerEffort: string | null;
  // null: the candidate keeps the rl-reviewer mode of the shipped profile. run.ts --reviewer-mode checks the value.
  reviewerMode: string | null;
  // null: the candidate keeps the verify mode of the shipped profile. run.ts --verifier checks the value.
  verifier: string | null;
  // null: the candidate keeps the verify effort of the shipped profile. run.ts --verifier-effort checks the value.
  verifierEffort: string | null;
  // The candidate replays the recorded finder and salvage calls of the baseline (run.ts --replay-find).
  replay: boolean;
  baselineOnly: boolean;
  reviewOnly: boolean;
  // docs/plans/review-v3.md WP-V13: only the review cases where delegation() of the baseline profile is not null.
  large: boolean;
  build: string[];
  results: string | null;
  // The folder of an earlier eval:ab run whose baseline results this run reuses.
  baseline: string | null;
  // Continue the cut baseline results in the results folder.
  resume: boolean;
  runner: string[] | null;
};

const list = (s: string) => (s.trim() ? s.split(",").map((x) => x.trim()) : []);

export function parseAb(argv: string[]): AbOptions | { error: string } {
  const at = argv.indexOf("--runner");
  const runner = at < 0 ? null : argv.slice(at + 1);
  if (runner?.length === 0) return { error: "--runner needs a command." };
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args: at < 0 ? argv : argv.slice(0, at),
      strict: true,
      allowPositionals: false,
      options: {
        repeat: { type: "string", default: "1" },
        "candidate-repeat": { type: "string" },
        "candidate-variants": { type: "string", default: DEFAULT_VARIANTS },
        "candidate-modules": { type: "string", default: DEFAULT_MODULES },
        effort: { type: "string" },
        "candidate-effort": { type: "string" },
        "candidate-reviewer-effort": { type: "string" },
        "candidate-reviewer-mode": { type: "string" },
        "candidate-verifier": { type: "string" },
        "candidate-verifier-effort": { type: "string" },
        "candidate-replay": { type: "boolean", default: false },
        "baseline-only": { type: "boolean", default: false },
        "review-only": { type: "boolean", default: false },
        large: { type: "boolean", default: false },
        clean: { type: "string" },
        db: { type: "string" },
        cache: { type: "string" },
        out: { type: "string" },
        user: { type: "string" },
        results: { type: "string" },
        baseline: { type: "string" },
        resume: { type: "boolean", default: false },
      },
    }).values;
  } catch (e) {
    return { error: (e as Error).message };
  }
  const str = (k: string) => v[k] as string | undefined;
  // local.ts checks --clean. Each run builds the set again, so a stored baseline compares only with the same --clean.
  const build = (["db", "cache", "out", "user", "clean"] as const).flatMap((k) => (v[k] === undefined ? [] : [`--${k}`, str(k) as string]));
  const results = str("results");
  const baseline = str("baseline");
  const o: AbOptions = {
    repeat: str("repeat") ?? "1",
    candidateRepeat: str("candidate-repeat") ?? null,
    variants: list(str("candidate-variants") ?? DEFAULT_VARIANTS),
    modules: list(str("candidate-modules") ?? DEFAULT_MODULES),
    baseEffort: str("effort") ?? null,
    effort: str("candidate-effort") ?? null,
    reviewerEffort: str("candidate-reviewer-effort") ?? null,
    reviewerMode: str("candidate-reviewer-mode") ?? null,
    verifier: str("candidate-verifier") ?? null,
    verifierEffort: str("candidate-verifier-effort") ?? null,
    replay: v["candidate-replay"] === true,
    baselineOnly: v["baseline-only"] === true,
    reviewOnly: v["review-only"] === true,
    large: v.large === true,
    build,
    results: results === undefined ? null : resolve(results),
    baseline: baseline === undefined ? null : resolve(baseline),
    resume: v.resume === true,
    runner,
  };
  if (o.baseline !== null && !existsSync(o.baseline)) return { error: `--baseline: no folder ${o.baseline}.` };
  if (o.baselineOnly && (o.baseline !== null || o.replay))
    return { error: "--baseline-only runs only the baseline. Leave out --baseline and --candidate-replay." };
  // A new candidate result in a used folder would sit beside the old one, and main reads the first file it finds.
  if (o.resume && (o.results === null || !o.baselineOnly)) return { error: "--resume needs --results and --baseline-only." };
  for (const [flag, e] of [
    ["--effort", o.baseEffort],
    ["--candidate-effort", o.effort],
    ["--candidate-reviewer-effort", o.reviewerEffort],
  ] as const)
    if (e !== null && !(EFFORTS as readonly string[]).includes(e)) return { error: `${flag} must be one of ${EFFORTS.join(", ")}.` };
  // The eval runner checks each name and the repeat count.
  for (const mode of ["review", "rereview"] as const) {
    const profiles: Profile[] = [];
    for (const side of ["baseline", "candidate"] as const) {
      const p = parseOptions(runArgs(mode, side, o, ""));
      const e = "error" in p ? p : evalProfile(p);
      if ("error" in e) return { error: e.error ?? "Invalid profile." };
      profiles.push(e.profile);
    }
    const changed = o.replay ? finderChange(profiles[0] as Profile, profiles[1] as Profile) : [];
    if (changed.length)
      return { error: `--candidate-replay replays the finder of the baseline, but the candidate changes ${changed.join(", ")}.` };
  }
  return o;
}

// The modules and variants of the shipped profile: the baseline.
function shipped() {
  const p = parseOptions(["--set", "local"]);
  const e = "error" in p ? p : evalProfile(p);
  if ("error" in e) throw new Error(e.error);
  return { modules: e.profile.modules, variants: e.profile.variants ?? [] };
}

// The eval runner arguments of one run. The candidate adds its variants and modules to the shipped profile. cases: the --large cases.
// replay: the baseline result whose recorded finder calls the candidate replays. resume: the cut result that the run continues.
export function runArgs(
  mode: Mode,
  side: "baseline" | "candidate",
  o: AbOptions,
  out: string,
  cases: string[] = [],
  replay?: string,
  resume?: string,
): string[] {
  const cand = side === "candidate";
  const repeat = (cand ? o.candidateRepeat : null) ?? o.repeat;
  const args = ["--set", "local", "--repeat", repeat, ...(mode === "rereview" ? ["--rereview"] : [])];
  if (cases.length) args.push("--cases", cases.join(","));
  if (cand) {
    const base = shipped();
    const variants = [...new Set([...base.variants, ...o.variants])];
    if (variants.length) args.push("--variants", variants.join(","));
    args.push("--modules", [...new Set([...base.modules, ...o.modules])].join(","));
  }
  const effort = (cand ? o.effort : null) ?? o.baseEffort;
  if (effort !== null) args.push("--effort", effort);
  if (cand && o.reviewerEffort !== null) args.push("--reviewer-effort", o.reviewerEffort);
  if (cand && o.reviewerMode !== null) args.push("--reviewer-mode", o.reviewerMode);
  if (cand && o.verifier !== null) args.push("--verifier", o.verifier);
  if (cand && o.verifierEffort !== null) args.push("--verifier-effort", o.verifierEffort);
  if (cand && replay) args.push("--replay-find", replay);
  if (resume) args.push("--resume", resume);
  args.push("--ordinals");
  if (out) args.push("--out", out);
  args.push(...(o.runner ? ["--runner", ...o.runner] : ["--real"]));
  return args;
}

// --baseline: why the stored result of a mode does not match the baseline that this run would make, or null.
// fingerprint: the set fingerprint of the mode in MANIFEST.json. A different commit or CLI version is allowed. candidate: the result
// is the candidate of an earlier run. It ran the shipped profile of its time, so only its revision must match, not its profile version.
// cases: the case count of the set. a.cases lists only the cases that ran, so a cut result has too few.
export function reuseRefusal(
  mode: Mode,
  a: EvalResult,
  o: AbOptions,
  fingerprint: string,
  candidate = false,
  cases = a.cases.length,
): string | null {
  const p = parseOptions(runArgs(mode, "baseline", o, ""));
  const e = "error" in p ? p : evalProfile(p);
  if ("error" in e) return e.error ?? "Invalid baseline profile.";
  const want = e.profile;
  const it = `Refused: the stored ${mode} ${candidate ? "candidate" : "baseline"}`;
  const ran = a.requested ?? { model: "not recorded", effort: "not recorded" };
  const short = (s: string | undefined) => s?.slice(0, 12) ?? "none";
  if (!!a.rereview !== (mode === "rereview")) return `${it} ran the other mode.`;
  if (a.fingerprint !== fingerprint)
    return `${it} ran case set ${short(a.fingerprint)}, but the set now has fingerprint ${short(fingerprint)}. Give the --clean of the stored run.`;
  if (ran.effort !== (want.effort ?? "default"))
    return `${it} ran with effort ${ran.effort}, but this run needs effort ${want.effort ?? "default"}.`;
  if (!candidate && a.profileVersion !== PROFILES_VERSION)
    return `${it} ran profile version ${a.profileVersion ?? "not recorded"}, but the shipped profile is now version ${PROFILES_VERSION}.`;
  if (a.promptVersion !== promptVersion(want))
    return `${it} ran prompt version ${a.promptVersion}, but the baseline now has prompt version ${promptVersion(want)}.`;
  if (ran.model !== (want.model ?? "default"))
    return `${it} ran with model ${ran.model}, but this run needs model ${want.model ?? "default"}.`;
  if (a.profile.revision !== profileRevision(want))
    return `${it} ran profile revision ${a.profile.revision.slice(0, 8)}, but the shipped profile is now revision ${profileRevision(want).slice(0, 8)}.`;
  const runs = Number(o.candidateRepeat ?? o.repeat);
  if (a.repeat < runs) return `${it} ran with --repeat ${a.repeat}, but the candidate runs ${runs} repeats.`;
  const kept = a.runs.filter(keptRun).length;
  if (kept < cases * a.repeat)
    return `${it} has ${kept} finished runs of ${cases * a.repeat} (${cases} cases x ${a.repeat} repeats).${candidate ? "" : " Resume it with eval:ab --resume, then use it."}`;
  return null;
}

// --large: the IDs of the local cases that give the profile the rl-reviewer agent, in case order. jobs.ts gives it only to a review run,
// by delegation() over parseDiff of the change. tmp: a folder for the bare repositories of the bundles.
export async function largeCases(cases: Pick<EvalCase, "id" | "local">[], profile: Profile, tmp: string): Promise<string[]> {
  const bundles = new Map<string, string>();
  const out: string[] = [];
  for (const c of cases) {
    if (!c.local) continue;
    const repo = await bundleRepo(c.local, tmp, bundles);
    const files = parseDiff(await git(["--git-dir", repo.url, "diff", ...diffArgs, repo.base, repo.head], { env: repo.env }));
    if (delegation(profile, files) !== null) out.push(c.id);
  }
  return out;
}

// --large with --baseline: a full-set baseline passes reuseRefusal against the full fingerprint, then keeps only the large cases and
// gets the subset fingerprint. A baseline that ran the subset already passes against the subset fingerprint. Else the refusal text.
// fullCases: the case count of the full set.
export function largeBaseline(
  a: EvalResult,
  o: AbOptions,
  full: string,
  subset: string,
  ids: string[],
  candidate = false,
  fullCases = a.cases.length,
): EvalResult | string {
  if (a.fingerprint === subset) return reuseRefusal("review", a, o, subset, candidate, ids.length) ?? a;
  const refused = reuseRefusal("review", a, o, full, candidate, fullCases);
  if (refused) return refused;
  const missing = ids.filter((id) => !a.cases.some((c) => c.id === id) || !a.runs.some((r) => r.case === id)).length;
  if (missing) return `Refused: the stored review baseline has no run of ${missing} large case${missing === 1 ? "" : "s"}.`;
  const keep = new Set(ids);
  return { ...a, fingerprint: subset, cases: a.cases.filter((c) => keep.has(c.id)), runs: a.runs.filter((r) => keep.has(r.case)) };
}

type Stored = EvalResult["profile"] & Profile;
// The profile revision of the candidate without what eval:ab added: its variants and modules cut to those of the baseline.
export function baseRevision(a: EvalResult, b: EvalResult): string {
  const [pa, pb] = [a.profile as Stored, b.profile as Stored];
  const keep = <T>(x: T[], y: T[]) => x.filter((v) => y.includes(v));
  return profileRevision({ ...pb, modules: keep(pa.modules, pb.modules), variants: keep(pa.variants, pb.variants) });
}

// The runs that did not finish: a failed, cancelled, or error run. An incomplete run finished with gaps and counts.
export const failedRuns = (r: EvalResult) => r.runs.filter((x) => !finished(x)).length;

const total = (r: EvalResult, f: (x: EvalResult["runs"][number]) => number | null | undefined) =>
  r.runs.reduce((n, x) => n + (f(x) ?? 0), 0);
const titleOf = (mode: Mode) => (mode === "review" ? "Review cases" : "Re-review cases");
const cost = (r: EvalResult) => `$${total(r, (x) => x.usage?.costUsd).toFixed(3)} for ${r.repeat} repeats`;
const time = (r: EvalResult) => `${total(r, (x) => x.minutes).toFixed(1)} min`;

export function modeText(mode: Mode, a: EvalResult, b: EvalResult, files: [string, string]): string {
  // compareText: the A and B headers and the warnings come before the first blank line.
  const order = [...new Set([...a.cases, ...b.cases].map((c) => c.id))];
  const head = compareText(a, b, (id) => `case ${order.indexOf(id) + 1}`, baseRevision(a, b)).split("\n\n")[0] ?? "";
  const repeats = a.repeat === b.repeat ? `${a.repeat}` : `${a.repeat} (baseline), ${b.repeat} (candidate)`;
  return [
    `== ${titleOf(mode)}: ${a.cases.length} cases x ${repeats} ==`,
    head,
    "",
    suiteDelta(score(a), score(b), ["baseline (A)", "candidate (B)"]),
    "",
    `Total cost: baseline ${cost(a)}, candidate ${cost(b)}. Total time: baseline ${time(a)}, candidate ${time(b)}.`,
    `Failed runs: baseline ${failedRuns(a)}, candidate ${failedRuns(b)}.`,
    `Result A: ${files[0]}`,
    `Result B: ${files[1]}`,
  ].join("\n");
}

// --baseline-only: the totals of the baseline. run.ts printed its table.
const baselineText = (mode: Mode, a: EvalResult, file: string) =>
  [
    `== ${titleOf(mode)}: ${a.cases.length} cases x ${a.repeat}, baseline only ==`,
    `Total cost: ${cost(a)}. Total time: ${time(a)}.`,
    `Failed runs: ${failedRuns(a)}.`,
    `Result A: ${file}`,
  ].join("\n");

export async function main(argv: string[]): Promise<number> {
  const o = parseAb(argv);
  if ("error" in o) {
    console.error(`${o.error}\n${USAGE}`);
    return 2;
  }
  const built = await buildMain(o.build);
  if (built !== 0) return built;
  // The eval runner reads the set from REVIEW_LOOP_EVAL_LOCAL.
  const outAt = o.build.indexOf("--out");
  const set = resolve(outAt < 0 ? localDir() : (o.build[outAt + 1] as string));
  process.env.REVIEW_LOOP_EVAL_LOCAL = set;
  const manifest = JSON.parse(readFileSync(join(set, "MANIFEST.json"), "utf8")) as Manifest;
  const { commit } = await checkoutState();
  const results = o.results ?? join(REPO, "eval-results", `ab-${new Date().toISOString().replace(/[:.]/g, "-")}-${commit}`);
  // --large: jobs.ts gives no re-review run the rl-reviewer agent, so only review cases qualify.
  let large: { ids: string[]; fingerprint: string } | null = null;
  if (o.large) {
    const tmp = mkdtempSync(join(tmpdir(), "rl-eval-large-"));
    try {
      const p = parseOptions(runArgs("review", "baseline", o, ""));
      const e = "error" in p ? p : evalProfile(p);
      if ("error" in e) throw new Error(e.error);
      const all = loadCases("all", setDir("local"));
      const ids = await largeCases(all, e.profile, tmp);
      const fingerprint = setFingerprint(all.flatMap((c) => (c.local && ids.includes(c.id) ? [{ id: c.id, hash: c.local.hash }] : [])));
      large = { ids, fingerprint };
    } catch (e) {
      console.error(`--large: ${(e as Error).message}`);
      return 1;
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
    if (!large.ids.length) {
      console.error("--large: no review case of the set gives the baseline the rl-reviewer agent.");
      return 2;
    }
    console.log(`--large: ${large.ids.length} of ${manifest.counts.cases} review cases give the baseline the rl-reviewer agent.`);
  }
  const subset = large;
  const cases = (mode: Mode) => (mode === "review" && subset ? subset.ids : []);
  const count = (mode: Mode) =>
    mode === "review" ? (subset?.ids.length ?? manifest.counts.cases) : subset || o.reviewOnly ? 0 : manifest.rereview.counts.cases;
  // --baseline: check each stored result before any run, so a refusal costs no run. The baseline result comes first, then a candidate
  // result whose profile shipped since. origin: the stored file. Its recorded calls sit beside it, not beside a --large cut copy.
  const stored = new Map<Mode, { path: string; origin: string }>();
  const from = o.baseline;
  for (const mode of from === null ? [] : (["review", "rereview"] as const).filter((m) => count(m) > 0)) {
    const found = (["baseline", "candidate"] as const).flatMap((side) => {
      const dir = join(from as string, `${mode}-${side}`);
      const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".json")) : undefined;
      return file ? [{ side, origin: join(dir, file) }] : [];
    });
    if (!found.length) {
      console.log(`No ${mode} baseline in ${from}, so the ${mode} baseline runs.`);
      continue;
    }
    const refusals: string[] = [];
    for (const { side, origin } of found) {
      const candidate = side === "candidate";
      try {
        const a = readResult(origin);
        const fingerprint = mode === "review" ? manifest.fingerprint : manifest.rereview.fingerprint;
        const kept = subset
          ? largeBaseline(a, o, manifest.fingerprint, subset.fingerprint, subset.ids, candidate, manifest.counts.cases)
          : (reuseRefusal(mode, a, o, fingerprint, candidate, count(mode)) ?? a);
        if (typeof kept === "string") refusals.push(kept);
        else if (o.replay && !existsSync(callsDir(origin)))
          refusals.push(`Refused: the stored ${mode} ${side} has no recorded calls for --candidate-replay.`);
        else {
          let path = origin;
          if (kept !== a) {
            // The cut copy goes to the new result folder, so a later --large --baseline can reuse that folder as it is.
            const to = join(results, `${mode}-baseline`);
            mkdirSync(to, { recursive: true });
            path = join(to, basename(origin));
            writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`);
          }
          stored.set(mode, { path, origin });
          break;
        }
      } catch (e) {
        refusals.push((e as Error).message);
      }
    }
    if (!stored.has(mode)) {
      console.error(refusals.join("\n"));
      return 2;
    }
  }
  // --resume: the one cut result of each baseline mode, found before any run.
  const resumed = new Map<Mode, string>();
  for (const mode of o.resume ? (["review", "rereview"] as const).filter((m) => count(m) > 0) : []) {
    const dir = join(results, `${mode}-baseline`);
    const found = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    if (found.length !== 1) {
      console.error(`--resume: ${dir} holds ${found.length} result files, but it must hold exactly one.`);
      return 2;
    }
    resumed.set(mode, join(dir, found[0] as string));
  }
  const runs = Number(o.candidateRepeat ?? o.repeat);
  if (!o.baselineOnly && runs > Number(o.repeat) && (["review", "rereview"] as const).some((m) => count(m) > 0 && !stored.has(m))) {
    console.error(
      `--candidate-repeat ${runs} is above --repeat ${o.repeat}. The baseline needs at least as many repeats as the candidate.`,
    );
    return 2;
  }
  const sides = o.baselineOnly ? (["baseline"] as const) : (["baseline", "candidate"] as const);
  const texts: string[] = [];
  let failed = false;
  for (const mode of ["review", "rereview"] as const) {
    const n = count(mode);
    if (n === 0) {
      const why = subset ? "--large runs only review cases" : o.reviewOnly ? "--review-only" : "the set has none";
      texts.push(`== ${titleOf(mode)}: skipped, ${why} ==`);
      continue;
    }
    const files: string[] = [];
    for (const side of sides) {
      const reused = side === "baseline" ? stored.get(mode) : undefined;
      if (reused) {
        console.log(`\n--- ${mode} baseline: reused ${reused.path} ---`);
        files.push(reused.path);
        continue;
      }
      const out = join(results, `${mode}-${side}`);
      console.log(`\n--- ${mode} ${side} ---`);
      const replay = o.replay ? (stored.get(mode)?.origin ?? files[0]) : undefined;
      const code = await runMain(runArgs(mode, side, o, out, cases(mode), replay, resumed.get(mode)));
      const file = existsSync(out) ? readdirSync(out).find((f) => f.endsWith(".json")) : undefined;
      if (code !== 0 || !file) {
        failed = true;
        console.error(`The ${mode} ${side} run failed with exit code ${code}.`);
        // 2: run.ts refused the run before its first case run, for example a --resume refusal.
        if (code === 130 || code === 2) return code;
        break;
      }
      files.push(join(out, file));
    }
    if (files.length !== sides.length) {
      texts.push(`== ${titleOf(mode)}: no table, a run failed ==`);
      continue;
    }
    if (o.baselineOnly) {
      const a = readResult(files[0] as string);
      if (failedRuns(a)) failed = true;
      texts.push(baselineText(mode, a, files[0] as string));
      continue;
    }
    const [a, b] = files.map(readResult) as [EvalResult, EvalResult];
    const refused = refusal(a, b);
    if (refused) {
      failed = true;
      texts.push(`== ${mode}: no table. ${refused} ==`);
      continue;
    }
    if (failedRuns(a) || failedRuns(b)) failed = true;
    texts.push(modeText(mode, a, b, files as [string, string]));
  }
  console.log(`\n${texts.join("\n\n")}`);
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
