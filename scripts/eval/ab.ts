// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate U-V1 in one command (docs/plans/review-v3.md, docs/eval/local.md): build the local set from the data folder of the app, then
// run the shipped profile (baseline) and the candidate on it, for the review cases and the re-review cases, and print one table each.
// Usage: bun run eval:ab -- [--repeat N] [--candidate-variants a,b] [--candidate-modules a,b] [--db f] [--cache d] [--out d]
//   [--effort e] [--candidate-effort e] [--candidate-reviewer-effort e] [--candidate-verifier on|off] [--large] [--user slug] [--results d] [--baseline d]
//   [--runner <command> <args...>]
// Without --runner, the runs use the claude CLI on PATH. Exit codes: 0 done, 1 a build error or a failed run, 2 a usage error.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROFILES_VERSION } from "../../src/server/config";
import { delegation, type Profile, profileRevision, promptVersion } from "../../src/server/review/catalog";
import { parseDiff } from "../../src/server/review/diffmap";
import { git } from "../../src/server/review/git";
import { diffArgs } from "../../src/server/review/workspace";
import { EFFORTS, type Variant, VERIFIER_MODES } from "../../src/shared/dto";
import { bundleRepo, type EvalCase, loadCases, localDir, setDir, setFingerprint } from "./cases";
import { compareText, readResult, refusal, suiteDelta } from "./compare";
import { main as buildMain, type Manifest } from "./local";
import { checkoutState, evalProfile, parseOptions, main as runMain } from "./run";
import { type EvalResult, score } from "./score";

const REPO = resolve(import.meta.dir, "../..");
export const USAGE = `Usage: bun run eval:ab -- [--repeat N] [--candidate-variants order,rules2] [--candidate-modules failures] [--effort ${EFFORTS.join("|")}] [--candidate-effort ${EFFORTS.join("|")}] [--candidate-reviewer-effort ${EFFORTS.join("|")}] [--candidate-verifier ${VERIFIER_MODES.join("|")}] [--large] [--db <db-*.sqlite>] [--cache <git folder>] [--out <folder>] [--user <slug>] [--results <folder>] [--baseline <folder>] [--runner <command> <args...>]
--results: the folder of the result files. Default: a new folder in eval-results/.
--baseline: the folder of an earlier eval:ab run. Its review-baseline/ and rereview-baseline/ results replace the baseline runs. A mode without its folder runs the baseline.
--candidate-variants and --candidate-modules: what the candidate adds to the shipped profile. An empty value adds nothing.
--effort: the effort of the baseline and candidate runs. Default: the effort of the shipped profile.
--candidate-effort: the effort of the candidate runs. Default: the effort of the baseline.
--candidate-reviewer-effort: the rl-reviewer effort of the candidate runs. Default: the rl-reviewer effort of the shipped profile.
--candidate-verifier: the verify mode of the candidate runs. Default: the verify mode of the shipped profile.
--large: run only the review cases that give the baseline the rl-reviewer agent. The re-review cases do not run.
--runner runs the given CLI instead of the claude CLI on PATH and must come last.`;
const DEFAULT_VARIANTS = "order,rules2";
const DEFAULT_MODULES = "failures";
// docs/plans/review-v3.md WP-V2: this variant changes only the re-review stdin. The re-review candidate always adds it.
const STRICT: Variant = "rereview-strict";

export type Mode = "review" | "rereview";
export type AbOptions = {
  repeat: string;
  variants: string[];
  modules: string[];
  // null: both sides run with the effort of the shipped profile.
  baseEffort: string | null;
  // null: the candidate runs with the effort of the baseline.
  effort: string | null;
  // null: the candidate runs with the rl-reviewer effort of the shipped profile.
  reviewerEffort: string | null;
  // null: the candidate keeps the verify mode of the shipped profile. run.ts --verifier checks the value.
  verifier: string | null;
  // docs/plans/review-v3.md WP-V13: only the review cases where delegation() of the baseline profile is not null.
  large: boolean;
  build: string[];
  results: string | null;
  // The folder of an earlier eval:ab run whose baseline results this run reuses.
  baseline: string | null;
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
        "candidate-variants": { type: "string", default: DEFAULT_VARIANTS },
        "candidate-modules": { type: "string", default: DEFAULT_MODULES },
        effort: { type: "string" },
        "candidate-effort": { type: "string" },
        "candidate-reviewer-effort": { type: "string" },
        "candidate-verifier": { type: "string" },
        large: { type: "boolean", default: false },
        db: { type: "string" },
        cache: { type: "string" },
        out: { type: "string" },
        user: { type: "string" },
        results: { type: "string" },
        baseline: { type: "string" },
      },
    }).values;
  } catch (e) {
    return { error: (e as Error).message };
  }
  const str = (k: string) => v[k] as string | undefined;
  const build = (["db", "cache", "out", "user"] as const).flatMap((k) => (v[k] === undefined ? [] : [`--${k}`, str(k) as string]));
  const results = str("results");
  const baseline = str("baseline");
  const o: AbOptions = {
    repeat: str("repeat") ?? "1",
    variants: list(str("candidate-variants") ?? DEFAULT_VARIANTS),
    modules: list(str("candidate-modules") ?? DEFAULT_MODULES),
    baseEffort: str("effort") ?? null,
    effort: str("candidate-effort") ?? null,
    reviewerEffort: str("candidate-reviewer-effort") ?? null,
    verifier: str("candidate-verifier") ?? null,
    large: v.large === true,
    build,
    results: results === undefined ? null : resolve(results),
    baseline: baseline === undefined ? null : resolve(baseline),
    runner,
  };
  if (o.baseline !== null && !existsSync(o.baseline)) return { error: `--baseline: no folder ${o.baseline}.` };
  for (const [flag, e] of [
    ["--effort", o.baseEffort],
    ["--candidate-effort", o.effort],
    ["--candidate-reviewer-effort", o.reviewerEffort],
  ] as const)
    if (e !== null && !(EFFORTS as readonly string[]).includes(e)) return { error: `${flag} must be one of ${EFFORTS.join(", ")}.` };
  // The eval runner checks each name and the repeat count.
  for (const mode of ["review", "rereview"] as const)
    for (const side of ["baseline", "candidate"] as const) {
      const p = parseOptions(runArgs(mode, side, o, ""));
      if ("error" in p) return p;
      const e = evalProfile(p);
      if (e.error !== undefined) return { error: e.error };
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
export function runArgs(mode: Mode, side: "baseline" | "candidate", o: AbOptions, out: string, cases: string[] = []): string[] {
  const args = ["--set", "local", "--repeat", o.repeat, ...(mode === "rereview" ? ["--rereview"] : [])];
  if (cases.length) args.push("--cases", cases.join(","));
  if (side === "candidate") {
    const base = shipped();
    const extra = mode === "rereview" ? [...o.variants, STRICT] : o.variants.filter((x) => x !== STRICT);
    const variants = [...new Set([...base.variants, ...extra])];
    if (variants.length) args.push("--variants", variants.join(","));
    args.push("--modules", [...new Set([...base.modules, ...o.modules])].join(","));
  }
  const effort = (side === "candidate" ? o.effort : null) ?? o.baseEffort;
  if (effort !== null) args.push("--effort", effort);
  if (side === "candidate" && o.reviewerEffort !== null) args.push("--reviewer-effort", o.reviewerEffort);
  if (side === "candidate" && o.verifier !== null) args.push("--verifier", o.verifier);
  args.push("--ordinals");
  if (out) args.push("--out", out);
  args.push(...(o.runner ? ["--runner", ...o.runner] : ["--real"]));
  return args;
}

// --baseline: why the stored baseline of a mode does not match the baseline that this run would make, or null.
// fingerprint: the set fingerprint of the mode in MANIFEST.json. A different commit or CLI version is allowed.
export function reuseRefusal(mode: Mode, a: EvalResult, o: AbOptions, fingerprint: string): string | null {
  const p = parseOptions(runArgs(mode, "baseline", o, ""));
  const e = "error" in p ? p : evalProfile(p);
  if ("error" in e) return e.error ?? "Invalid baseline profile.";
  const want = e.profile;
  const it = `Refused: the stored ${mode} baseline`;
  const ran = a.requested ?? { model: "not recorded", effort: "not recorded" };
  const short = (s: string | undefined) => s?.slice(0, 12) ?? "none";
  if (!!a.rereview !== (mode === "rereview")) return `${it} ran the other mode.`;
  if (a.fingerprint !== fingerprint)
    return `${it} ran case set ${short(a.fingerprint)}, but the set now has fingerprint ${short(fingerprint)}.`;
  if (ran.effort !== (want.effort ?? "default"))
    return `${it} ran with effort ${ran.effort}, but this run needs effort ${want.effort ?? "default"}.`;
  if (a.profileVersion !== PROFILES_VERSION)
    return `${it} ran profile version ${a.profileVersion ?? "not recorded"}, but the shipped profile is now version ${PROFILES_VERSION}.`;
  if (a.promptVersion !== promptVersion(want))
    return `${it} ran prompt version ${a.promptVersion}, but the baseline now has prompt version ${promptVersion(want)}.`;
  if (ran.model !== (want.model ?? "default"))
    return `${it} ran with model ${ran.model}, but this run needs model ${want.model ?? "default"}.`;
  if (a.profile.revision !== profileRevision(want))
    return `${it} ran profile revision ${a.profile.revision.slice(0, 8)}, but the shipped profile is now revision ${profileRevision(want).slice(0, 8)}.`;
  if (String(a.repeat) !== o.repeat) return `${it} ran with --repeat ${a.repeat}, but this run asks for --repeat ${o.repeat}.`;
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
export function largeBaseline(a: EvalResult, o: AbOptions, full: string, subset: string, ids: string[]): EvalResult | string {
  if (a.fingerprint === subset) return reuseRefusal("review", a, o, subset) ?? a;
  const refused = reuseRefusal("review", a, o, full);
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
export const failedRuns = (r: EvalResult) => r.runs.filter((x) => x.status !== "completed" && x.status !== "incomplete").length;

const total = (r: EvalResult, f: (x: EvalResult["runs"][number]) => number | null | undefined) =>
  r.runs.reduce((n, x) => n + (f(x) ?? 0), 0);

export function modeText(mode: Mode, a: EvalResult, b: EvalResult, files: [string, string]): string {
  const title = mode === "review" ? "Review cases" : "Re-review cases";
  // compareText: the A and B headers and the warnings come before the first blank line.
  const order = [...new Set([...a.cases, ...b.cases].map((c) => c.id))];
  const head = compareText(a, b, (id) => `case ${order.indexOf(id) + 1}`, baseRevision(a, b)).split("\n\n")[0] ?? "";
  const cost = (r: EvalResult) => `$${total(r, (x) => x.usage?.costUsd).toFixed(3)}`;
  const time = (r: EvalResult) => `${total(r, (x) => x.minutes).toFixed(1)} min`;
  return [
    `== ${title}: ${a.cases.length} cases x ${a.repeat} ==`,
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
    subset ? (mode === "review" ? subset.ids.length : 0) : mode === "review" ? manifest.counts.cases : manifest.rereview.counts.cases;
  // --baseline: check each stored baseline before any run, so a refusal costs no run.
  const stored = new Map<Mode, string>();
  const from = o.baseline;
  for (const mode of from === null ? [] : (["review", "rereview"] as const).filter((m) => count(m) > 0)) {
    const dir = join(from as string, `${mode}-baseline`);
    const file = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".json")) : undefined;
    if (!file) {
      console.log(`No ${mode} baseline in ${from}, so the ${mode} baseline runs.`);
      continue;
    }
    let refused: string | null;
    let path = join(dir, file);
    try {
      const a = readResult(path);
      if (subset) {
        const cut = largeBaseline(a, o, manifest.fingerprint, subset.fingerprint, subset.ids);
        refused = typeof cut === "string" ? cut : null;
        if (typeof cut !== "string" && cut !== a) {
          // The cut copy goes to the new result folder, so a later --large --baseline can reuse that folder as it is.
          const to = join(results, `${mode}-baseline`);
          mkdirSync(to, { recursive: true });
          path = join(to, basename(file));
          writeFileSync(path, `${JSON.stringify(cut, null, 2)}\n`);
        }
      } else refused = reuseRefusal(mode, a, o, mode === "review" ? manifest.fingerprint : manifest.rereview.fingerprint);
    } catch (e) {
      refused = (e as Error).message;
    }
    if (refused) {
      console.error(refused);
      return 2;
    }
    stored.set(mode, path);
  }
  const texts: string[] = [];
  let failed = false;
  for (const mode of ["review", "rereview"] as const) {
    const n = count(mode);
    if (n === 0) {
      const why = subset ? "--large runs only review cases" : "the set has none";
      texts.push(`== ${mode === "review" ? "Review" : "Re-review"} cases: skipped, ${why} ==`);
      continue;
    }
    const files: string[] = [];
    for (const side of ["baseline", "candidate"] as const) {
      const reused = side === "baseline" ? stored.get(mode) : undefined;
      if (reused) {
        console.log(`\n--- ${mode} baseline: reused ${reused} ---`);
        files.push(reused);
        continue;
      }
      const out = join(results, `${mode}-${side}`);
      console.log(`\n--- ${mode} ${side} ---`);
      const code = await runMain(runArgs(mode, side, o, out, cases(mode)));
      const file = existsSync(out) ? readdirSync(out).find((f) => f.endsWith(".json")) : undefined;
      if (code !== 0 || !file) {
        failed = true;
        console.error(`The ${mode} ${side} run failed with exit code ${code}.`);
        if (code === 130) return 130;
        break;
      }
      files.push(join(out, file));
    }
    if (files.length !== 2) {
      texts.push(`== ${mode === "review" ? "Review" : "Re-review"} cases: no table, a run failed ==`);
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
