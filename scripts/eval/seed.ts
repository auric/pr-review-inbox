// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The seed CLI (docs/plans/review-v2/seeded-truth.md sections 4.2, 5, 8, and 9 WP-SG2; architecture-bugs.md section 3.6). It proposes,
// validates, samples, and decides seeds in <seeds>/seeds.json, and builds the frozen seeded set. The natural set is the folder of
// REVIEW_LOOP_EVAL_LOCAL (default eval-local/), and the seeds root the folder of REVIEW_LOOP_EVAL_SEEDS (default eval-seeds/).
// The seeds hold private code: only list, show, and report print paths or code, and only to this terminal.
// Exit codes: 0 done, 1 a CLI run or a step failed, 2 a usage error, a refusal, or the plan of a paid command.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createClaudeRunner } from "../../src/server/review/claude";
import { git } from "../../src/server/review/git";
import { localDir, SEED_KINDS, seedsDir } from "./cases";
import { readResult } from "./compare";
import { seededSet } from "./local";
import { BOOTSTRAP } from "./score";
import {
  bindingHolds,
  buildSeededSet,
  buildText,
  checkSeed,
  giveaways,
  HOST_CAP,
  type Host,
  hasCodeChange,
  hostsOf,
  rangeOf,
  type SeedKind,
  unusedNames,
} from "./seed-build";
import { KIND_ORDER, proposeHost, recheckSeed, SEEDER, type SeedCtx, seedCtx, step, VALIDATOR, validateSeed } from "./seed-runs";
import {
  fire,
  kindOf,
  loadStore,
  passedPaths,
  rootRefusal,
  SEED_STATES,
  type SeedRecord,
  type SeedState,
  type SeedStore,
  saveStore,
  twinKey,
} from "./seed-store";

export const USAGE = [
  "Usage: bun run eval:seed -- <command>",
  "  propose [--cases <id,...>] [--kinds <kind,...>] (--real | --runner <command> <args...>)",
  "  validate (--real | --runner <command> <args...>)",
  "  recheck",
  "  report",
  "  sample [--escalate <kind,...> | --escalate all]",
  "  list [--state <state>]",
  "  show <seed>",
  "  decide <seed> keep|drop [--why <text>] [--kind <kind>]",
  "  retire <seed> --why <text>",
  "  build",
  "  leaks <result.json>",
  "recheck runs no claude: it applies the keep conditions again to the stored validator answers of refuted seeds.",
  "report runs no claude and changes no state: it lists by ID the bound seeds that fail a check, leave a name unused (check 11), or show a removed token in the PR description (check 12), and the twin hosts.",
  "propose and validate are paid. Without --real or --runner, they print the plan and an estimate, and exit with code 2. --runner runs the given CLI instead of claude and must come last.",
].join("\n");

// Not measured. Section 4.4 gives $40-100 for 23 seeder runs and 70 to 90 validator runs. A seeder run reads the whole change, as a
// review run at the C1b price ($1.59). With that, 80 validator runs at $0.40 give about $69, the middle of the range.
const SEEDER_USD = 1.59;
const VALIDATOR_USD = 0.4;
// Section 5.5: the second draws go to the four largest kinds, so 10 kinds give 14 seeds. More than 20% drops in the sample escalate every
// kind.
const SECOND_DRAWS = 4;
const DROP_SHARE = 0.2;
// Section 8: the states with a binding that validate checks (host-).
const BOUND = new Set<SeedState>(["applied", "confirmed", "sampled", "kept"]);
// A drawn seed is decided when the user kept, dropped, or retired it. A stale seed counts by its state before host-.
const DECIDED = new Set<SeedState>(["kept", "dropped", "retired"]);
// Section 7 "Finder notices injection": the injection words of check 5. Its code markers (todo, fixme, xxx, hack, bug) are ordinary
// review words, so they stay out.
const LEAK_WORDS = /\b(seed|seeded|inject|injected|planted|intentional|deliberate)\b/i;

const usd = (x: number) => `$${x.toFixed(2)}`;

// ---------- Args ----------

type Args = { cmd: string; pos: string[]; flags: Map<string, string | true>; runner: string[] | null };
const VALUE_FLAGS = new Set(["--cases", "--kinds", "--state", "--why", "--escalate", "--kind"]);

export function parseSeed(argv: string[]): Args | null {
  const at = argv.indexOf("--runner");
  const runner = at < 0 ? null : argv.slice(at + 1);
  const args = at < 0 ? argv : argv.slice(0, at);
  const [cmd, ...rest] = args;
  if (!cmd || runner?.length === 0) return null;
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (VALUE_FLAGS.has(a)) {
      const v = rest[++i];
      if (v === undefined || flags.has(a)) return null;
      flags.set(a, v);
    } else if (a === "--real") flags.set(a, true);
    else if (a.startsWith("-")) return null;
    else pos.push(a);
  }
  const allowed: Record<string, { flags: string[]; pos: number[] }> = {
    propose: { flags: ["--cases", "--kinds", "--real"], pos: [0] },
    validate: { flags: ["--real"], pos: [0] },
    recheck: { flags: [], pos: [0] },
    report: { flags: [], pos: [0] },
    sample: { flags: ["--escalate"], pos: [0] },
    list: { flags: ["--state"], pos: [0] },
    show: { flags: [], pos: [1] },
    decide: { flags: ["--why", "--kind"], pos: [2] },
    retire: { flags: ["--why"], pos: [1] },
    build: { flags: [], pos: [0] },
    leaks: { flags: [], pos: [1] },
  };
  const rule = allowed[cmd];
  if (!rule?.pos.includes(pos.length) || [...flags.keys()].some((f) => !rule.flags.includes(f))) return null;
  const paid = cmd === "propose" || cmd === "validate";
  if (runner && (!paid || flags.has("--real"))) return null;
  return { cmd, pos, flags, runner };
}

const listFlag = (a: Args, name: string) =>
  typeof a.flags.get(name) === "string" ? (a.flags.get(name) as string).split(",").map((x) => x.trim()) : null;

// ---------- Hosts (section 4.2) ----------

// User decision 1: one host per PR group, the case whose head commit has the newest committer date. A tie goes to the lower case ID.
// side: the hosts whose range has a side-branch merge. They take no seed (section 5.3). Twin hosts count once (section 4.2).
export async function selectHosts(local: string, open: (id: string) => Promise<Host | null>) {
  const best = new Map<string, { h: Host; at: number }>();
  for (const id of readdirSync(join(local, "cases")).sort()) {
    const h = await open(id);
    if (!h) continue;
    const at = Number((await git(["--git-dir", h.repo.dir, "log", "-1", "--format=%ct", h.head], { env: h.repo.env })).trim());
    const group = h.file.group ?? `pr${h.pr}`;
    const b = best.get(group);
    if (!b || at > b.at) best.set(group, { h, at });
  }
  const hosts: Host[] = [];
  const side: Host[] = [];
  // twins: a host with the base and head of a host with a lower case ID. Its PR is the same commit series, so it takes no seed.
  const twins: { host: Host; of: Host }[] = [];
  for (const { h } of [...best.values()].sort((a, b) => (a.h.id < b.h.id ? -1 : 1))) {
    const of = [...hosts, ...side].find((x) => x.base === h.base && x.head === h.head);
    if (of) twins.push({ host: h, of });
    else ((await rangeOf(h.repo, h.base, h.head)).side ? side : hosts).push(h);
  }
  return { hosts, side, twins };
}

// ---------- Sample (section 5.5) ----------

// The generator of score.ts (mulberry32), which score.ts does not export. Section 5.5 names it.
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// One confirmed seed per kind, then one more from each of the four kinds with the most confirmed seeds. Ties go by the kind order. The
// draw reads only the confirmed seeds, each kind in ID order, so it is the same on every call. It keeps the build caps (pickSeeds): with
// the kept and sampled seeds, at most HOST_CAP seeds per host and one per file. Twin hosts count as one host. The first draws go to the
// smallest kinds first, so a kind with few seeds keeps its chance on a full host.
export function drawSample(seeds: readonly SeedRecord[]): string[] {
  const rand = mulberry32(BOOTSTRAP.seed);
  const confirmed = seeds.filter((s) => s.state === "confirmed").sort((a, b) => (a.id < b.id ? -1 : 1));
  const pool = new Map(KIND_ORDER.map((k) => [k, confirmed.filter((s) => s.kind === k)]));
  const size = new Map([...pool].map(([k, p]) => [k, p.length]));
  const taken = seeds.filter((s) => s.state === "kept" || s.state === "sampled");
  const fits = (s: SeedRecord) => {
    const mine = taken.filter((x) => twinKey(x) === twinKey(s));
    return mine.length < HOST_CAP && !mine.some((x) => x.path === s.path);
  };
  const take = (k: SeedKind) => {
    const p = pool.get(k) as SeedRecord[];
    const open = p.filter(fits);
    if (!open.length) return [];
    const s = open[Math.floor(rand() * open.length)] as SeedRecord;
    p.splice(p.indexOf(s), 1);
    taken.push(s);
    return [s.id];
  };
  // sort is stable, so equal sizes keep the kind order.
  const first = [...KIND_ORDER].sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0)).flatMap(take);
  const largest = [...KIND_ORDER].sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0)).slice(0, SECOND_DRAWS);
  return [...first, ...largest.flatMap(take)];
}

export type Settle = {
  seeds: SeedRecord[];
  // undecided: drawn seeds without a decision. The rules wait for the whole sample, because a kept seed cannot escalate later.
  undecided: number;
  released: number;
  // Kinds whose confirmed seeds need the user's OK to escalate. Until then, they stay confirmed and out of the build.
  escalate: SeedKind[];
  // Kinds with confirmed seeds and no drawn seed. Decide those seeds one by one.
  unsampled: SeedKind[];
};

// The release and escalate rules. A kind with drawn seeds and 0 drops releases its confirmed seeds to kept. A kind with a drop, or every
// kind when more than 20% of the sample is dropped, escalates only with the user's OK (sample --escalate).
export function settle(seeds: SeedRecord[], drawn: readonly string[]): Settle {
  const ds = seeds.filter((s) => drawn.includes(s.id));
  const undecided = ds.filter((s) => !DECIDED.has(s.state === "stale" ? (s.was as SeedState) : s.state)).length;
  const none: Settle = { seeds, undecided, released: 0, escalate: [], unsampled: [] };
  if (!ds.length || undecided) return none;
  const drops = (list: SeedRecord[]) => list.filter((s) => s.state === "dropped").length;
  const all = drops(ds) > DROP_SHARE * ds.length;
  const release = new Set<SeedKind>();
  for (const k of KIND_ORDER) {
    if (!seeds.some((s) => s.kind === k && s.state === "confirmed")) continue;
    const mine = ds.filter((s) => s.kind === k);
    if (!mine.length) none.unsampled.push(k);
    else if (all || drops(mine) > 0) none.escalate.push(k);
    else release.add(k);
  }
  const next = seeds.map((s) => (s.state === "confirmed" && release.has(s.kind) ? step(s, "release") : s));
  return { ...none, seeds: next, released: next.filter((s, i) => s !== seeds[i]).length };
}

// <seeds>/sample.json: the IDs that the sample drew. keep and drop end the sampled state, so the store alone cannot tell them.
const sampleFile = z.object({ format: z.literal(1), drawn: z.array(z.string()) });
const SAMPLE_FILE = "sample.json";

function loadSample(root: string): string[] {
  const file = join(root, SAMPLE_FILE);
  return existsSync(file) ? sampleFile.parse(JSON.parse(readFileSync(file, "utf8"))).drawn : [];
}

// A temp file, then a rename, as saveStore writes the store.
function saveSample(root: string, drawn: string[]) {
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `${SAMPLE_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ format: 1, drawn }, null, 2)}\n`);
    renameSync(tmp, join(root, SAMPLE_FILE));
  } finally {
    rmSync(tmp, { force: true });
  }
}

function settleText(st: Settle): string[] {
  if (st.undecided) return [`The sample has ${st.undecided} undecided seeds. Decide them, then the release rule applies.`];
  const out = [`Released to kept: ${st.released} confirmed seeds.`];
  if (st.escalate.length)
    out.push(
      `Kinds that escalate to full review: ${st.escalate.join(", ")}. Their confirmed seeds stay out of the build until you agree. To agree, run: bun run eval:seed -- sample --escalate ${st.escalate.join(",")}`,
    );
  if (st.unsampled.length)
    out.push(`Kinds with confirmed seeds and no drawn seed: ${st.unsampled.join(", ")}. Decide those seeds one by one.`);
  return out;
}

// ---------- Commands ----------

const byKind = (seeds: SeedRecord[]) => KIND_ORDER.map((k) => `${k} ${seeds.filter((s) => s.kind === k).length}`).join(", ");

// The natural set must exist and must not be a seeded set.
function naturalRefusal(local: string): string | null {
  if (seededSet(local)) return "Refused: REVIEW_LOOP_EVAL_LOCAL points at a seeded set. Point it at the natural set.";
  if (!existsSync(join(local, "cases"))) return "Refused: no natural set. Build it with eval:local first.";
  return null;
}

// The run setup of label.ts main: a temp data folder, memory secrets, and the auth check before the first paid call.
async function paidCtx(a: Args, tmp: string): Promise<SeedCtx | null> {
  process.env.REVIEW_LOOP_DATA_DIR = tmp;
  process.env.REVIEW_LOOP_SECRETS = "memory";
  const ctx = seedCtx(createClaudeRunner({ command: a.runner ?? undefined }), tmp);
  // The auth route check of the app: authMethod must be claude.ai (claude.ts).
  const checked = await ctx.runner.check();
  if (checked.ok) return ctx;
  console.error(`The Claude CLI check failed: ${checked.message}`);
  return null;
}

function costLine(ctx: SeedCtx) {
  const c = ctx.cost;
  return `Runs: seeder ${c.seeder.runs} (${usd(c.seeder.usd)}), validator ${c.validator.runs} (${usd(c.validator.usd)}).`;
}

async function propose(a: Args, seeds: string, local: string): Promise<number> {
  const kinds = listFlag(a, "--kinds");
  const bad = kinds?.find((k) => !(SEED_KINDS as readonly string[]).includes(k));
  if (bad !== undefined) {
    console.error(`Unknown kind: ${bad}. Kinds: ${SEED_KINDS.join(", ")}.`);
    return 2;
  }
  const store = loadStore(seeds);
  const tmp = mkdtempSync(join(tmpdir(), "rl-eval-seed-"));
  try {
    const open = hostsOf(local, tmp);
    const { hosts, side, twins } = await selectHosts(local, open);
    const cases = listFlag(a, "--cases");
    const missing = cases?.find((id) => !hosts.some((h) => h.id === id));
    if (missing !== undefined) {
      console.error(
        `Refused: case ${missing} is no host. A host is the newest case of its PR group, with no side-branch merge in its range and no twin with a lower case ID.`,
      );
      return 2;
    }
    // A plain propose skips the hosts that have seeds, also on a twin, so a second call continues a cut one. --cases runs the given hosts
    // again, except a full host: its passed seeds cover HOST_CAP files, the build cap (WP-SG5).
    const seeded = new Set(store.seeds.map(twinKey));
    const paths = passedPaths(store.seeds);
    const isFull = (h: Host) => (paths.get(twinKey({ host: h }))?.size ?? 0) >= HOST_CAP;
    const full = hosts.filter(isFull).length;
    const asked = hosts.filter((h) => (cases ? cases.includes(h.id) && !isFull(h) : !seeded.has(twinKey({ host: h }))));
    const todo: Host[] = [];
    for (const h of asked) if (await hasCodeChange(h)) todo.push(h);
    const plan = [
      `eval:seed propose: ${hosts.length} hosts, one per PR group. ${side.length} more hosts have a side-branch merge in their range and take no seed. ${twins.length} more hosts are twins: they have the base and head of a host, and take no seed.`,
      `${full} hosts are full: their passed seeds cover ${HOST_CAP} files, and they take no seeder run.`,
      `${asked.length - todo.length} hosts add no line to a file of a known code type and take no seeder run.`,
      `Seeder runs: ${todo.length} (model ${SEEDER.model}, effort ${SEEDER.effort})${kinds ? `, kinds ${kinds.join(", ")} only` : ""}. ${hosts.length - asked.length} hosts are skipped.`,
    ];
    if (!a.flags.has("--real") && !a.runner) {
      console.log(
        [
          ...plan,
          `Estimate at ${usd(SEEDER_USD)} per seeder run (not measured): about ${usd(todo.length * SEEDER_USD)}.`,
          "Add --real to run your Claude CLI. It uses your plan quota.",
        ].join("\n"),
      );
      return 2;
    }
    console.log(plan.join("\n"));
    if (!todo.length) return 0;
    const ctx = await paidCtx(a, tmp);
    if (!ctx) return 1;
    const got = { applied: 0, invalid: 0, otherKind: 0, repeated: 0 };
    for (const [n, h] of todo.entries()) {
      console.log(`Host ${n + 1}/${todo.length}`);
      try {
        const earlier = store.seeds.filter((s) => twinKey(s) === twinKey({ host: h }));
        const r = await proposeHost(h, ctx, { kinds: kinds as SeedKind[] | null, known: new Set(store.seeds.map((s) => s.id)), earlier });
        if (!r) continue;
        store.seeds.push(...r.seeds);
        saveStore(seeds, store);
        got.applied += r.seeds.filter((s) => s.state === "applied").length;
        got.invalid += r.seeds.filter((s) => s.state === "invalid").length;
        got.otherKind += r.otherKind;
        got.repeated += r.repeated;
      } catch (e) {
        ctx.errors.push(`Host ${n + 1}: ${(e as Error).message.replaceAll(h.id, `host ${n + 1}`)}`);
      }
    }
    console.log(
      `Proposals: ${got.applied} applied, ${got.invalid} invalid, ${got.otherKind} of another kind and ${got.repeated} repeated (not stored).`,
    );
    console.log(costLine(ctx));
    for (const e of ctx.errors) console.log(e);
    return ctx.errors.length ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

// Section 8: validate and recheck fire host- on a bound seed whose host changed. Returns the count of new stale seeds.
async function staleCheck(store: SeedStore, seeds: string, open: (id: string) => Promise<Host | null>): Promise<number> {
  let stale = 0;
  for (const [i, s] of store.seeds.entries())
    if (BOUND.has(s.state) && !(await bindingHolds(await open(s.host.id), s))) {
      store.seeds[i] = step(s, "host-");
      stale++;
    }
  if (stale) saveStore(seeds, store);
  return stale;
}

// Section 8 event recheck: no run. A refuted seed with a stored validator answer and an unchanged binding gets the keep conditions
// again. The output holds counts only, because a reason names paths.
async function recheck(seeds: string, local: string): Promise<number> {
  const store = loadStore(seeds);
  const tmp = mkdtempSync(join(tmpdir(), "rl-eval-seed-"));
  try {
    const open = hostsOf(local, tmp);
    const stale = await staleCheck(store, seeds, open);
    const tally = { confirmed: 0, refuted: 0, held: 0 };
    const errors: string[] = [];
    for (const [i, s] of store.seeds.entries()) {
      if (s.state !== "refuted") continue;
      const h = await open(s.host.id);
      if (!s.validation || !h || !(await bindingHolds(h, s))) {
        tally.held++;
        continue;
      }
      try {
        const next = await recheckSeed(h, s);
        if (next.state !== "confirmed") {
          tally.refuted++;
          continue;
        }
        store.seeds[i] = next;
        saveStore(seeds, store);
        tally.confirmed++;
      } catch (e) {
        tally.held++;
        errors.push(`Seed ${s.id}: ${(e as Error).message.replaceAll(s.host.id, "its host")}`);
      }
    }
    console.log(
      `Rechecked: ${tally.confirmed} refuted seeds are now confirmed, ${tally.refuted} stay refuted, and ${tally.held} were not rechecked (no validator answer, a changed host, or a failed check). ${stale} seeds went stale.`,
    );
    for (const e of errors) console.log(e);
    return errors.length ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

// The free report (sections 4.2 and 5.2): no run, and no state change. One line per finding on a bound seed whose binding holds: a failed
// check with its number, check 11 with the names, and check 12 with the sources only. Then the twin hosts. The output holds names and
// case IDs, so it goes only to this terminal.
async function report(seeds: string, local: string): Promise<number> {
  const store = loadStore(seeds);
  const tmp = mkdtempSync(join(tmpdir(), "rl-eval-seed-"));
  try {
    const open = hostsOf(local, tmp);
    const tally = { checked: 0, failed: 0, names: 0, giveaways: 0, changed: 0 };
    for (const s of store.seeds) {
      if (!BOUND.has(s.state)) continue;
      const h = await open(s.host.id);
      if (!h || !(await bindingHolds(h, s))) {
        tally.changed++;
        continue;
      }
      tally.checked++;
      const row = `${s.id}  ${s.state.padEnd(9)}  ${kindOf(s).padEnd(12)}`;
      const c = await checkSeed(h, s);
      if ("check" in c) {
        tally.failed++;
        console.log(`${row}  fails check ${c.check}`);
        continue;
      }
      const flagged = await unusedNames(h, s, c);
      if (flagged.length) {
        tally.names++;
        console.log(`${row}  check 11: ${flagged.join(", ")}`);
      }
      const where = giveaways(h, s);
      if (where.length) {
        tally.giveaways++;
        console.log(`${row}  check 12: ${where.join(", ")}`);
      }
    }
    const { twins } = await selectHosts(local, open);
    for (const t of twins) console.log(`Twin hosts: ${t.of.id} and ${t.host.id}. They count as one host.`);
    console.log(
      `Report: ${tally.checked} bound seeds checked. ${tally.failed} fail a check, ${tally.names} leave a name unused or dangling (check 11), and ${tally.giveaways} show a removed token in the PR description (check 12). ${tally.changed} have a changed host. Twin hosts: ${twins.length}.`,
    );
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function validate(a: Args, seeds: string, local: string): Promise<number> {
  const store = loadStore(seeds);
  const applied = store.seeds.filter((s) => s.state === "applied");
  // Twin hosts count as one host. The build takes one seed per file and HOST_CAP files per host (WP-SG5): an applied seed in a file with a
  // passed seed takes no run, and a host stops when its passed seeds cover HOST_CAP files.
  const byHost = Map.groupBy(applied, twinKey);
  const filesOf = (key: string) => passedPaths(store.seeds).get(key) ?? new Set<string>();
  let low = 0;
  let high = 0;
  let inFull = 0;
  for (const [key, list] of byHost) {
    const files = filesOf(key);
    const room = Math.max(0, HOST_CAP - files.size);
    const left = list.filter((s) => !files.has(s.path));
    inFull += list.length - left.length;
    low += Math.min(new Set(left.map((s) => s.path)).size, room);
    high += room ? left.length : 0;
  }
  const fullLine = `${inFull} applied seeds are in a file that holds a passed seed, and take no run.`;
  if (!high) {
    console.log(`eval:seed validate: no applied seed needs a validator run. ${fullLine}`);
    return 0;
  }
  if (!a.flags.has("--real") && !a.runner) {
    console.log(
      [
        `eval:seed validate: ${applied.length} applied seeds at ${byHost.size} hosts. Each host stops when its passed seeds cover ${HOST_CAP} files. ${fullLine}`,
        `Validator runs: ${low} to ${high} (model ${VALIDATOR.model}, effort ${VALIDATOR.effort}).`,
        `Estimate at ${usd(VALIDATOR_USD)} per validator run (not measured): about ${usd(low * VALIDATOR_USD)} to ${usd(high * VALIDATOR_USD)}.`,
        "Add --real to run your Claude CLI. It uses your plan quota.",
      ].join("\n"),
    );
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), "rl-eval-seed-"));
  try {
    const ctx = await paidCtx(a, tmp);
    if (!ctx) return 1;
    const open = hostsOf(local, tmp);
    const stale = await staleCheck(store, seeds, open);
    const tally = { confirmed: 0, refuted: 0, checks: 0, failed: 0, skipped: 0 };
    const hosts = [...new Set(store.seeds.filter((s) => s.state === "applied").map(twinKey))];
    for (const [n, key] of hosts.entries()) {
      for (const [i, s] of store.seeds.entries()) {
        if (twinKey(s) !== key || s.state !== "applied") continue;
        const files = filesOf(key);
        if (files.size >= HOST_CAP) break;
        if (files.has(s.path)) {
          tally.skipped++;
          continue;
        }
        console.log(`Host ${n + 1}/${hosts.length}, seed ${s.id}`);
        const id = s.host.id;
        try {
          const next = await validateSeed((await open(id)) as Host, s, ctx);
          store.seeds[i] = next;
          saveStore(seeds, store);
          if (next.state === "confirmed") tally.confirmed++;
          else if (next.state === "refuted" && !next.validation) tally.checks++;
          else if (next.state === "refuted") tally.refuted++;
          else tally.failed++;
        } catch (e) {
          ctx.errors.push(`Host ${n + 1}, seed ${s.id}: ${(e as Error).message.replaceAll(id, `host ${n + 1}`)}`);
        }
      }
    }
    console.log(
      `Validated: ${tally.confirmed} confirmed, ${tally.refuted} refuted, ${tally.checks} refuted by a check without a run, ${tally.failed} failed runs (still applied). ${tally.skipped} skipped for a full file (still applied). ${stale} seeds went stale.`,
    );
    console.log(costLine(ctx));
    for (const e of ctx.errors) console.log(e);
    return ctx.errors.length || tally.failed ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

function sample(a: Args, seeds: string): number {
  const store = loadStore(seeds);
  let drawn = loadSample(seeds);
  const fresh = !drawn.length;
  const escalate = listFlag(a, "--escalate");
  if (escalate && fresh) {
    console.error("Refused: no sample exists yet. Run sample without --escalate first.");
    return 2;
  }
  if (fresh) {
    drawn = drawSample(store.seeds);
    if (!drawn.length) {
      console.error("No confirmed seed to draw. Run validate first.");
      return 2;
    }
    // The drawn IDs go first: a cut call leaves them confirmed, and the next call fires their draw.
    saveSample(seeds, drawn);
  }
  let next = store.seeds.map((s) => (drawn.includes(s.id) && s.state === "confirmed" ? step(s, "draw") : s));
  const st = settle(next, drawn);
  next = st.seeds;
  if (escalate) {
    const want = escalate.length === 1 && escalate[0] === "all" ? st.escalate : escalate;
    const no = want.find((k) => !(st.escalate as string[]).includes(k));
    if (st.undecided || !want.length || no !== undefined) {
      console.error(
        `Refused: ${st.undecided ? "the sample has undecided seeds" : `kind ${no ?? "none"} does not escalate`}. Kinds that escalate: ${st.escalate.join(", ") || "none"}.`,
      );
      return 2;
    }
    next = next.map((s) => (s.state === "confirmed" && want.includes(s.kind) ? step(s, "escalate") : s));
  }
  saveStore(seeds, { ...store, seeds: next });
  const mine = next.filter((s) => drawn.includes(s.id));
  console.log(
    `${fresh ? "Drew" : "The sample holds"} ${drawn.length} seeds: ${byKind(mine)}. ${mine.filter((s) => s.state === "sampled").length} are undecided.`,
  );
  if (escalate)
    console.log(`Escalated to full review: ${next.filter((s) => s.state === "sampled" && !drawn.includes(s.id)).length} seeds.`);
  else for (const l of settleText(st)) console.log(l);
  console.log("List them with: bun run eval:seed -- list --state sampled");
  return 0;
}

function list(a: Args, seeds: string): number {
  const want = a.flags.get("--state");
  if (typeof want === "string" && !(SEED_STATES as readonly string[]).includes(want)) {
    console.error(`Unknown state: ${want}. States: ${SEED_STATES.join(", ")}.`);
    return 2;
  }
  const all = loadStore(seeds).seeds;
  const rows = all.filter((s) => want === undefined || s.state === want);
  for (const s of rows) console.log(`${s.id}  ${s.state.padEnd(9)}  ${kindOf(s).padEnd(12)}  ${s.host.id}  ${s.path}`);
  console.log(`${rows.length} seeds. By state: ${SEED_STATES.map((x) => `${x} ${all.filter((s) => s.state === x).length}`).join(", ")}.`);
  return 0;
}

function show(a: Args, seeds: string): number {
  const s = loadStore(seeds).seeds.find((x) => x.id === a.pos[0]);
  if (!s) {
    console.error(`No seed ${a.pos[0]}.`);
    return 2;
  }
  const lines = (t: string, p: string) =>
    t === ""
      ? []
      : t
          .replace(/\r?\n$/, "")
          .split(/\r?\n/)
          .map((l) => `${p}${l}`);
  const v = s.validation;
  console.log(
    [
      `Seed ${s.id}: ${s.state}${s.was ? ` (was ${s.was})` : ""}, kind ${s.kind}${s.label ? ` (build kind ${s.label}, set by the user)` : ""}, severity ${s.severity}${s.route ? `, route ${s.route}` : ""}.`,
      `Host ${s.host.id}`,
      `--- ${s.path}`,
      `+++ ${s.path}`,
      ...lines(s.find, "-"),
      ...lines(s.replace, "+"),
      `Anchor: ${s.anchor.path}: ${s.anchor.text}`,
      ...s.alt.map((x) => `Alt: ${x.path}: ${x.text}`),
      `Trigger: ${s.trigger}`,
      `Why: ${s.why}`,
      `Comment: ${s.comment}`,
      ...(v
        ? [
            `Validator: ${v.verdict}, severity ${v.severity}, originalOk ${v.originalOk}, plausible ${v.plausible}, kindOk ${v.kindOk ?? "not asked"}.`,
            `Validator trigger: ${v.trigger}`,
            ...v.proof.map((p) => `Proof: ${p}`),
            `Validator why: ${v.why}`,
          ]
        : ["Validator: none yet."]),
      ...(s.reason ? [`Reason: ${s.reason}`] : []),
    ].join("\n"),
  );
  return 0;
}

// One user event on one seed: keep, drop, or retire. why: the stored reason. kind: keep only, the kind that the build uses (label). The
// seeder kind stays in kind, so the checks and the sample do not change. A kind equal to the seeder kind removes the label.
function decide(seeds: string, id: string, event: "keep" | "drop" | "retire", why: string | undefined, kind?: SeedKind): number {
  const store = loadStore(seeds);
  const i = store.seeds.findIndex((s) => s.id === id);
  const s = store.seeds[i];
  if (!s) {
    console.error(`No seed ${id}.`);
    return 2;
  }
  const next = fire(s, event);
  if ("refused" in next) {
    console.error(next.refused);
    return 2;
  }
  const { label: _, ...bare } = next;
  const labeled = kind === undefined ? next : kind === s.kind ? bare : { ...bare, label: kind };
  store.seeds[i] = why === undefined ? labeled : { ...labeled, reason: why };
  const st = settle(store.seeds, loadSample(seeds));
  saveStore(seeds, { ...store, seeds: st.seeds });
  console.log(`Seed ${id} is ${next.state}${kind === undefined ? "" : `, with kind ${kind} in the build`}.`);
  if (event === "retire") console.log("The retire takes effect at the next build. The next build needs a new seeded baseline.");
  else if (loadSample(seeds).length) for (const l of settleText(st)) console.log(l);
  return 0;
}

async function build(seeds: string, local: string): Promise<number> {
  try {
    const b = await buildSeededSet({ seeds, local });
    if ("refused" in b) {
      console.error(b.refused);
      return 2;
    }
    console.log(buildText(b));
    return 0;
  } catch (e) {
    console.error(`The build failed: ${(e as Error).message}`);
    return 1;
  }
}

// Section 7: the findings of an eval result that hold an injection word. SG-A needs 0. The output holds no finding text.
function leaks(path: string): number {
  let r: ReturnType<typeof readResult>;
  try {
    r = readResult(resolve(path));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const ids = r.cases.map((c) => c.id);
  let findings = 0;
  let hits = 0;
  for (const run of r.runs)
    for (const [n, i] of run.items.entries()) {
      findings++;
      const word = LEAK_WORDS.exec([i.title, i.body, i.trigger ?? "", i.evidence ?? ""].join("\n"))?.[1];
      if (!word) continue;
      hits++;
      console.log(`Case ${ids.indexOf(run.case) + 1}, repeat ${run.repeat}, finding ${n + 1}: the word "${word.toLowerCase()}".`);
    }
  console.log(`Leak words: ${hits} of ${findings} findings.`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseSeed(argv);
  if (!a) {
    console.error(USAGE);
    return 2;
  }
  if (a.cmd === "leaks") return leaks(a.pos[0] as string);
  const seeds = seedsDir();
  const local = localDir();
  const refused = await rootRefusal(seeds);
  if (refused) {
    console.error(refused);
    return 2;
  }
  if (a.cmd === "propose" || a.cmd === "validate" || a.cmd === "recheck" || a.cmd === "report") {
    const no = naturalRefusal(local);
    if (no) {
      console.error(no);
      return 2;
    }
    if (a.cmd === "recheck") return recheck(seeds, local);
    if (a.cmd === "report") return report(seeds, local);
    return a.cmd === "propose" ? propose(a, seeds, local) : validate(a, seeds, local);
  }
  const why = a.flags.get("--why") as string | undefined;
  switch (a.cmd) {
    case "sample":
      return sample(a, seeds);
    case "list":
      return list(a, seeds);
    case "show":
      return show(a, seeds);
    case "decide": {
      const verdict = a.pos[1];
      const kind = a.flags.get("--kind") as string | undefined;
      if ((verdict !== "keep" && verdict !== "drop") || (kind !== undefined && verdict !== "keep")) {
        console.error(USAGE);
        return 2;
      }
      if (kind !== undefined && !(SEED_KINDS as readonly string[]).includes(kind)) {
        console.error(`Unknown kind: ${kind}. Kinds: ${SEED_KINDS.join(", ")}.`);
        return 2;
      }
      return decide(seeds, a.pos[0] as string, verdict, why, kind as SeedKind | undefined);
    }
    case "retire":
      if (!why) {
        console.error("retire needs --why <text>.");
        return 2;
      }
      return decide(seeds, a.pos[0] as string, "retire", why);
    default:
      return build(seeds, local);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
