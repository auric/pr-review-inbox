// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/seeded-truth.md WP-SG2: eval:seed with the fake CLI. Host selection, the paid guard, the auth check, validate with
// its binding pass and stop rule, the sample draw, the release and escalate rules, the user events, build, and leaks. The seeds root and
// the natural set are temp folders; tests/support/seed-fixture.ts makes the natural set.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localCaseFile, SEED_KINDS } from "../../scripts/eval/cases";
import { caseId } from "../../scripts/eval/local";
import { drawSample, settle } from "../../scripts/eval/seed";
import { bindingOf, type Host, hostsOf, pickSeeds, type SeedKind } from "../../scripts/eval/seed-build";
import {
  loadStore,
  type SeedFields,
  type SeedRecord,
  type SeedState,
  type SeedValidation,
  saveStore,
  seedId,
  twinKey,
} from "../../scripts/eval/seed-store";
import { readRecords } from "../support/fake-claude";
import { ARCH, addTargetMerge, addTwin, gitIn, makeNaturalSet, type NaturalSet, OMIT, PATHS, seedFields } from "../support/seed-fixture";

console.log(`seed-cli.test.ts imported from ${Bun.resolveSync("../../scripts/eval/seed", import.meta.dir)}`);

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const SEED = join(ROOT, "scripts/eval/seed.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const TMP = mkdtempSync(join(tmpdir(), "rl-seed-cli-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

let nat: NaturalSet;
// The pr7 case at head c3. c3 has a newer committer date than c4, so it is the host of group pr7.
let c3: string;
beforeAll(async () => {
  nat = await makeNaturalSet(join(TMP, "fx"));
  const file = localCaseFile.parse(JSON.parse(readFileSync(join(nat.dir, "cases", nat.host, "case.json"), "utf8")));
  const head = nat.commits[2] as string;
  c3 = caseId({ pr: 7, head, base: nat.base });
  mkdirSync(join(nat.dir, "cases", c3));
  writeFileSync(join(nat.dir, "cases", c3, "case.json"), JSON.stringify({ ...file, id: c3, bundle: { ...file.bundle, head } }, null, 2));
}, SLOW);

async function cli(args: string[], seeds: string, local = nat.dir) {
  const p = Bun.spawn([process.execPath, "--preload", NO_REAL, SEED, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_EVAL_SEEDS: seeds, REVIEW_LOOP_EVAL_LOCAL: local, REVIEW_LOOP_DATA_DIR: join(TMP, "live") },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

type Rec = { argv: string[]; stdin: string; context: Record<string, string> };
let scenarios = 0;
// The --runner arguments of the fake CLI with one stream, and its call records.
function fake(stream: string, auth: Record<string, unknown> = { loggedIn: true, authMethod: "claude.ai" }) {
  const dir = join(TMP, `fake-${++scenarios}`);
  mkdirSync(dir);
  const record = join(dir, "calls.jsonl");
  const scenario = join(dir, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      record,
      auth: { ...auth, projectsDirectory: join(dir, "projects") },
      delayMs: 1,
      fixture: join(ROOT, "fixtures/claude-synthetic", `${stream}.jsonl`),
    }),
  );
  return {
    runner: ["--runner", process.execPath, FAKE, scenario],
    calls: () => readRecords<Rec>(record),
    runs: () => readRecords<Rec>(record).filter((r) => r.argv.includes("-p")),
  };
}

describe("usage", () => {
  test("a bad command line exits 2", async () => {
    const seeds = join(TMP, "usage");
    for (const args of [[], ["propose", "--real", "--runner", "x"], ["decide", "sd0000000000", "maybe"], ["list", "x"], ["show"]]) {
      const r = await cli(args, seeds);
      expect(r.code).toBe(2);
    }
    expect((await cli(["sample", "--runner", "x"], seeds)).code).toBe(2);
    expect(existsSync(seeds)).toBe(false);
  });
});

describe("propose, validate, and build", () => {
  const seeds = () => join(TMP, "seeds");
  const store = () => loadStore(seeds()).seeds;

  test(
    "a paid command without --real prints its plan, exits 2, and writes nothing",
    async () => {
      const r = await cli(["propose"], seeds());
      expect(r.stderr).toBe("");
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("1 hosts, one per PR group. 1 more hosts have a side-branch merge in their range and take no seed.");
      expect(r.stdout).toContain("Seeder runs: 1 (model opus, effort high).");
      expect(r.stdout).toContain("about $1.59");
      expect(r.stdout).toContain("Add --real");
      expect(existsSync(seeds())).toBe(false);
    },
    SLOW,
  );

  test(
    "the auth check runs before any paid call",
    async () => {
      const f = fake("seed-propose", { loggedIn: true, authMethod: "console" });
      const r = await cli(["propose", ...f.runner], seeds());
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("The Claude CLI check failed: authMethod is console.");
      expect(f.calls().some((c) => c.argv[0] === "auth")).toBe(true);
      expect(f.runs()).toEqual([]);
      expect(existsSync(seeds())).toBe(false);
    },
    SLOW,
  );

  test(
    "propose takes one host per PR group by the newest committer date, skips side-branch merge hosts, and skips hosts with seeds",
    async () => {
      const f = fake("seed-propose");
      const r = await cli(["propose", ...f.runner], seeds());
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Proposals: 4 applied, 2 invalid");
      expect(f.runs()).toHaveLength(1);
      expect(f.runs()[0]?.context["pr.md"]).toBeDefined();
      expect(store().map((s) => [s.host.id, s.host.head])).toEqual(Array(6).fill([c3, nat.commits[2]]));
      expect(store().map((s) => s.state)).toEqual(["applied", "applied", "applied", "invalid", "invalid", "applied"]);
      // A second plain call has no host left.
      const again = await cli(["propose", ...f.runner], seeds());
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("Seeder runs: 0");
      expect(f.runs()).toHaveLength(1);
      expect(store()).toHaveLength(6);
      // The re-propose of U-SG1: --cases runs a host with seeds again, and --kinds names the kinds. Known seeds stay out.
      const more = await cli(["propose", "--cases", c3, "--kinds", "local", ...f.runner], seeds());
      expect(more.code).toBe(0);
      expect(more.stdout).toContain("Proposals: 0 applied, 0 invalid, 5 of another kind and 1 repeated (not stored).");
      expect(f.runs()).toHaveLength(2);
      expect(f.runs()[1]?.stdin).toContain("Propose only defects of these kinds: local.");
      expect(store()).toHaveLength(6);
      // --cases takes only hosts. --kinds takes only kinds.
      const notHost = await cli(["propose", "--cases", nat.host], seeds());
      expect(notHost.code).toBe(2);
      expect(notHost.stderr).toContain(`case ${nat.host} is no host`);
      expect((await cli(["propose", "--cases", nat.mergeHost], seeds())).code).toBe(2);
      expect((await cli(["propose", "--kinds", "style"], seeds())).code).toBe(2);
    },
    SLOW,
  );

  test(
    "validate fires host- through the binding, and validates in seeder order until the passed seeds of a host cover 3 files",
    async () => {
      const host = (await hostsOf(nat.dir, mkdtempSync(join(TMP, "hosts-")))(c3)) as Host;
      const entry = seedFields({
        kind: "entry",
        path: "src/crlf.ts",
        find: "export const c12 = 12 + 1;",
        replace: "export const c12 = 12;",
        anchor: { path: "src/crlf.ts", text: "export const c11 = 11 + 1;" },
      });
      const moved = { ...entry, replace: "export const c12 = 12 + 2;" };
      const binding = (await bindingOf(host, entry.path)) as SeedRecord["host"];
      const all = store();
      all.push({ ...entry, id: seedId(c3, entry), state: "applied", host: binding });
      all.push({ ...moved, id: seedId(c3, moved), state: "applied", host: { ...binding, blob: "1".repeat(40) } });
      saveStore(seeds(), { format: 1, seeds: all });
      const before = readFileSync(join(seeds(), "seeds.json"), "utf8");

      const plan = await cli(["validate"], seeds());
      expect(plan.code).toBe(2);
      expect(plan.stdout).toContain(
        "Each host stops when its passed seeds cover 3 files. 0 applied seeds are in a file that holds a passed seed",
      );
      expect(plan.stdout).toContain("Validator runs: 3 to 6 (model opus, effort medium).");
      expect(readFileSync(join(seeds(), "seeds.json"), "utf8")).toBe(before);

      const f = fake("seed-validate");
      const r = await cli(["validate", ...f.runner], seeds());
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        "Validated: 3 confirmed, 0 refuted, 0 refuted by a check without a run, 0 failed runs (still applied). 0 skipped for a full file (still applied). 1 seeds went stale.",
      );
      expect(f.runs()).toHaveLength(3);
      expect(store().map((s) => [s.kind, s.state, s.was])).toEqual([
        ["architecture", "confirmed", undefined],
        ["omission", "confirmed", undefined],
        ["local", "confirmed", undefined],
        ["leak", "invalid", undefined],
        ["error", "invalid", undefined],
        ["lifetime", "applied", undefined],
        ["entry", "applied", undefined],
        ["entry", "stale", "applied"],
      ]);
      // The passed seeds cover 3 files, so no run is left. The lifetime seed is in a file with a passed seed.
      const done = await cli(["validate"], seeds());
      expect(done.code).toBe(0);
      expect(done.stdout).toContain(
        "no applied seed needs a validator run. 1 applied seeds are in a file that holds a passed seed, and take no run.",
      );
      // WP-SG5: propose skips the full host, also under --cases.
      const p = fake("seed-propose");
      const full = await cli(["propose", "--cases", c3, ...p.runner], seeds());
      expect(full.code).toBe(0);
      expect(full.stdout).toContain("1 hosts are full: their passed seeds cover 3 files, and they take no seeder run.");
      expect(full.stdout).toContain("Seeder runs: 0");
      expect(p.runs()).toEqual([]);
    },
    SLOW,
  );

  test(
    "build: exit 0 with counts, 2 on a refusal, 1 on an error",
    async () => {
      for (const s of store().filter((x) => x.state === "confirmed")) expect((await cli(["decide", s.id, "keep"], seeds())).code).toBe(0);
      const r = await cli(["build"], seeds());
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Seeded set: 1 cases with 3 seeds. Spare kept seeds: 0.");
      // The floor warns and never blocks (seeded-truth.md section 14 row 13).
      expect(r.stdout).toContain("kind architecture: under floor");
      expect(r.stdout).toContain("Kinds under the floor of 4 kept seeds:");
      expect(existsSync(join(seeds(), "set", "MANIFEST.json"))).toBe(true);
      const refused = await cli(["build"], seeds(), join(TMP, "no-natural-set"));
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("No natural set");
      const broken = join(TMP, "broken");
      mkdirSync(broken);
      writeFileSync(join(broken, "seeds.json"), "{");
      const failed = await cli(["build"], broken);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("The build failed:");
    },
    SLOW,
  );
});

// ---------- Sample (section 5.5, architecture-bugs.md section 3.6) ----------

// Confirmed seeds per kind. architecture and lifetime tie at 3 for the fourth second draw: the kind order gives it to architecture, the
// SEED_KINDS order would give it to lifetime.
const COUNTS: Record<SeedKind, number> = {
  lifetime: 3,
  contract: 5,
  omission: 4,
  entry: 2,
  concurrency: 2,
  leak: 2,
  error: 1,
  architecture: 3,
  security: 2,
  local: 6,
};
const HOST = { id: "pr1-aaaaaaaaaaaa-bbbbbbbb", base: "a".repeat(40), head: "b".repeat(40), blob: "c".repeat(40) };
// A head commit ID per commit series.
const series = (name: string) => createHash("sha1").update(name).digest("hex");
// One host per seed, each with its own head, so the build caps do not limit the draw.
const confirmed = (): SeedRecord[] =>
  SEED_KINDS.flatMap((kind) =>
    Array.from({ length: COUNTS[kind] }, (_, n) => {
      const f = seedFields({ kind, path: `src/${kind}${n}.ts`, find: "a();", replace: "b();", anchor: { path: "x.ts", text: "b();" } });
      const host = { ...HOST, id: `${kind}-${n}`, head: series(`${kind}-${n}`) };
      return { ...f, id: seedId(host.id, f), state: "confirmed" as const, host };
    }),
  );
const kindsOf = (ids: string[], seeds: SeedRecord[]) =>
  Object.fromEntries(SEED_KINDS.map((k) => [k, ids.filter((id) => seeds.find((s) => s.id === id)?.kind === k).length]));
const withState = (seeds: SeedRecord[], ids: string[], state: SeedState) => seeds.map((s) => (ids.includes(s.id) ? { ...s, state } : s));

describe("the sample draw and the release rule", () => {
  test("the draw gives 14 seeds with 10 kinds, the second draws go to the four largest kinds, and it is the same on every call", () => {
    const seeds = confirmed();
    const drawn = drawSample(seeds);
    expect(drawn).toHaveLength(14);
    expect(new Set(drawn).size).toBe(14);
    expect(kindsOf(drawn, seeds)).toEqual({
      lifetime: 1,
      contract: 2,
      omission: 2,
      entry: 1,
      concurrency: 1,
      leak: 1,
      error: 1,
      architecture: 2,
      security: 1,
      local: 2,
    });
    expect(drawSample(seeds)).toEqual(drawn);
    expect(drawSample([...seeds].reverse())).toEqual(drawn);
    // Only confirmed seeds take part.
    const one = seeds.find((s) => s.kind === "error") as SeedRecord;
    expect(drawSample(withState(seeds, [one.id], "kept"))).not.toContain(one.id);
  });

  test("the draw keeps the build caps: at most 3 seeds per host with the kept seeds and its twins, one per file, and the build takes every one", () => {
    let n = 0;
    const mk = (kind: SeedKind, hostId: string, path: string, state: SeedState = "confirmed", of = hostId): SeedRecord => {
      const f = seedFields({ kind, path, find: `a${++n}();`, replace: "b();", anchor: { path, text: "b();" } });
      return { ...f, id: seedId(hostId, f), state, host: { ...HOST, id: hostId, head: series(of) } };
    };
    const seeds = [
      // Host a: seven seeds, two pairs on one file, and the only error seed. Host a2 is its twin.
      mk("local", "a", "src/1.ts"),
      mk("local", "a", "src/2.ts"),
      mk("contract", "a", "src/1.ts"),
      mk("contract", "a", "src/3.ts"),
      mk("omission", "a", "src/4.ts"),
      mk("leak", "a", "src/5.ts"),
      mk("error", "a", "src/6.ts"),
      mk("concurrency", "a2", "src/7.ts", "confirmed", "a"),
      mk("entry", "a2", "src/8.ts", "confirmed", "a"),
      // Host b: a kept seed takes one place and its file.
      mk("lifetime", "b", "src/1.ts", "kept"),
      mk("lifetime", "b", "src/1.ts"),
      mk("lifetime", "b", "src/2.ts"),
      mk("contract", "b", "src/3.ts"),
      mk("local", "b", "src/4.ts"),
      // Host c: two seeds on one file.
      mk("omission", "c", "src/1.ts"),
      mk("leak", "c", "src/1.ts"),
      mk("local", "c", "src/2.ts"),
    ];
    const drawn = drawSample(seeds);
    expect(drawSample(seeds)).toEqual(drawn);
    expect(drawSample([...seeds].reverse())).toEqual(drawn);
    const used = seeds.filter((s) => drawn.includes(s.id) || s.state === "kept");
    for (const [, list] of Map.groupBy(used, twinKey)) {
      expect(list.length).toBeLessThanOrEqual(3);
      expect(new Set(list.map((s) => s.path)).size).toBe(list.length);
    }
    // The build is the oracle: it takes every drawn seed and the kept seed, with no spare.
    expect(pickSeeds(Map.groupBy(used, twinKey)).spares).toBe(0);
    // The smallest kinds draw first, ties in the kind order: concurrency, error, and entry have one seed each, all on hosts a and a2.
    // Their twin group is then full, so no other seed of host a is drawn.
    expect(drawn.slice(0, 3)).toEqual([seeds[7]?.id, seeds[6]?.id, seeds[8]?.id] as string[]);
    expect(drawn.filter((id) => seeds.find((s) => s.id === id)?.host.head === series("a"))).toHaveLength(3);
    // The places: 3 on hosts a and a2, 2 on host b beside the kept seed, and 2 files on host c.
    expect(drawn.length).toBeLessThanOrEqual(7);
  });

  test("a kind releases on 0 drops, escalates on 1, and every kind escalates above 20% drops", () => {
    const seeds = confirmed();
    const drawn = drawSample(seeds);
    const sampled = withState(seeds, drawn, "sampled");
    // Undecided: nothing changes.
    const wait = settle(sampled, drawn);
    expect(wait.undecided).toBe(14);
    expect(wait.seeds).toBe(sampled);
    // 0 drops: every kind releases its 16 unsampled confirmed seeds.
    const keptAll = settle(withState(sampled, drawn, "kept"), drawn);
    expect(keptAll.released).toBe(16);
    expect(keptAll.escalate).toEqual([]);
    expect(keptAll.seeds.filter((s) => s.state === "confirmed")).toEqual([]);
    // 1 drop in local: local escalates and keeps its 4 confirmed seeds. The other kinds release.
    const dropLocal = drawn.find((id) => seeds.find((s) => s.id === id)?.kind === "local") as string;
    const one = settle(withState(withState(sampled, drawn, "kept"), [dropLocal], "dropped"), drawn);
    expect(one.escalate).toEqual(["local"]);
    expect(one.released).toBe(12);
    expect(one.seeds.filter((s) => s.state === "confirmed").map((s) => s.kind)).toEqual(Array(4).fill("local"));
    // 3 drops of 14 (21%): every kind with confirmed seeds escalates, and none releases.
    const three = settle(withState(withState(sampled, drawn, "kept"), drawn.slice(0, 3), "dropped"), drawn);
    expect(three.released).toBe(0);
    expect(three.escalate).toEqual([
      "security",
      "contract",
      "omission",
      "architecture",
      "lifetime",
      "concurrency",
      "leak",
      "entry",
      "local",
    ]);
    // A kind with confirmed seeds and no drawn seed waits for single decisions.
    const noError = drawn.filter((id) => seeds.find((s) => s.id === id)?.kind !== "error");
    const unsampled = settle(withState(seeds, noError, "kept"), noError);
    expect(unsampled.unsampled).toEqual(["error"]);
    expect(unsampled.seeds.find((s) => s.kind === "error" && s.state === "confirmed")).toBeDefined();
  });
});

describe("sample, decide, escalate, retire, list, and show", () => {
  const seeds = () => join(TMP, "sample");
  const store = () => loadStore(seeds()).seeds;

  test(
    "an escalation needs an explicit command, and without it the seeds stay confirmed",
    async () => {
      saveStore(seeds(), { format: 1, seeds: confirmed() });
      const first = await cli(["sample"], seeds());
      expect(first.stderr).toBe("");
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("Drew 14 seeds:");
      const drawnFile = readFileSync(join(seeds(), "sample.json"), "utf8");
      const drawn = (JSON.parse(drawnFile) as { drawn: string[] }).drawn;
      expect(drawn).toEqual(drawSample(confirmed()));
      expect(store().filter((s) => s.state === "sampled")).toHaveLength(14);
      // A second call draws nothing new.
      const again = await cli(["sample"], seeds());
      expect(again.stdout).toContain("The sample holds 14 seeds:");
      expect(readFileSync(join(seeds(), "sample.json"), "utf8")).toBe(drawnFile);
      expect((await cli(["sample", "--escalate", "local"], seeds())).code).toBe(2);

      // Keep every drawn seed except one of local, which the user drops.
      const local = drawn.find((id) => store().find((s) => s.id === id)?.kind === "local") as string;
      let last = { code: 0, stdout: "", stderr: "" };
      for (const id of drawn) {
        last = await cli(id === local ? ["decide", id, "drop", "--why", "It stands out."] : ["decide", id, "keep"], seeds());
        expect(last.code).toBe(0);
      }
      expect(last.stdout).toContain("Released to kept: 12 confirmed seeds.");
      expect(last.stdout).toContain("Kinds that escalate to full review: local.");
      expect(store().find((s) => s.id === local)?.reason).toBe("It stands out.");
      const left = await cli(["list", "--state", "confirmed"], seeds());
      expect(left.stdout).toContain("4 seeds.");
      expect(
        store()
          .filter((s) => s.state === "confirmed")
          .map((s) => s.kind),
      ).toEqual(Array(4).fill("local"));

      // A refused event names the state and changes nothing. A dropped seed takes no keep.
      const before = readFileSync(join(seeds(), "seeds.json"), "utf8");
      const refused = await cli(["decide", local, "keep"], seeds());
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("is dropped");
      const wrongKind = await cli(["sample", "--escalate", "contract"], seeds());
      expect(wrongKind.code).toBe(2);
      expect(wrongKind.stderr).toContain("kind contract does not escalate");
      expect(readFileSync(join(seeds(), "seeds.json"), "utf8")).toBe(before);

      // The explicit command escalates local.
      const ok = await cli(["sample", "--escalate", "local"], seeds());
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("Escalated to full review: 4 seeds.");
      expect(store().filter((s) => s.state === "confirmed")).toEqual([]);
      expect(
        store()
          .filter((s) => s.state === "sampled")
          .map((s) => s.kind),
      ).toEqual(Array(4).fill("local"));
    },
    SLOW,
  );

  test(
    "retire needs --why; list and show check their arguments",
    async () => {
      const kept = store().find((s) => s.state === "kept") as SeedRecord;
      expect((await cli(["retire", kept.id], seeds())).code).toBe(2);
      const r = await cli(["retire", kept.id, "--why", "A finder named it."], seeds());
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("The next build needs a new seeded baseline.");
      expect(store().find((s) => s.id === kept.id)?.state).toBe("retired");
      const shown = await cli(["show", kept.id], seeds());
      expect(shown.code).toBe(0);
      expect(shown.stdout).toContain(`--- ${kept.path}\n+++ ${kept.path}\n-a();\n+b();\n`);
      expect(shown.stdout).toContain("Validator: none yet.");
      expect(shown.stdout).toContain("Reason: A finder named it.");
      expect((await cli(["show", "sd0000000000"], seeds())).code).toBe(2);
      expect((await cli(["list", "--state", "lost"], seeds())).code).toBe(2);
      expect((await cli(["list", "--state", "retired"], seeds())).stdout).toContain(`${kept.id}  retired`);
    },
    SLOW,
  );
});

describe("recheck (section 8)", () => {
  test(
    "recheck moves a refuted seed whose stored answer passes now, and a seed with severity medium stays refuted",
    async () => {
      const seeds = join(TMP, "recheck");
      const host = (await hostsOf(nat.dir, mkdtempSync(join(TMP, "hosts-")))(nat.host)) as Host;
      const answer: SeedValidation = {
        verdict: "breaks",
        severity: "high",
        trigger: "t",
        proof: ["The key keeps its spaces.", "route.ts:3"],
        originalOk: true,
        plausible: true,
        why: "w",
      };
      const reason = "The proof names lines that the seeded head does not have: route.ts:3.";
      const refuted = async (f: SeedFields, validation: SeedValidation): Promise<SeedRecord> => ({
        ...f,
        id: seedId(nat.host, f),
        state: "refuted",
        host: (await bindingOf(host, f.path)) as SeedRecord["host"],
        reason,
        validation,
      });
      const pass = await refuted(ARCH, answer);
      const medium = await refuted(OMIT, { ...answer, severity: "medium" });
      saveStore(seeds, { format: 1, seeds: [pass, medium] });
      expect((await cli(["recheck", "--runner", "x"], seeds)).code).toBe(2);
      const r = await cli(["recheck"], seeds);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Rechecked: 1 refuted seeds are now confirmed, 1 stay refuted, and 0 were not rechecked");
      const after = loadStore(seeds).seeds;
      expect(after.map((s) => [s.id, s.state, s.reason])).toEqual([
        [pass.id, "confirmed", undefined],
        [medium.id, "refuted", reason],
      ]);
      // A second call finds nothing to move.
      expect((await cli(["recheck"], seeds)).stdout).toContain("Rechecked: 0 refuted seeds are now confirmed, 1 stay refuted");
    },
    SLOW,
  );
});

describe("the tenth kind security (seeded-truth.md section 4.1)", () => {
  test(
    "a security seed flows through sample, decide, and build into a seeded bug of module and category security",
    async () => {
      const fx = await makeNaturalSet(join(TMP, "fx-security"));
      const host = (await hostsOf(fx.dir, mkdtempSync(join(TMP, "hosts-")))(fx.host)) as Host;
      const find = "export const o30 = 30 + 1;";
      const replace = "export const o30 = 30;";
      const fields = seedFields({ kind: "security", path: PATHS.other, find, replace, anchor: { path: PATHS.other, text: replace } });
      const bound = (await bindingOf(host, PATHS.other)) as SeedRecord["host"];
      const sec: SeedRecord = { ...fields, id: seedId(fx.host, fields), state: "confirmed", host: bound };
      const root = join(TMP, "seeds-security");
      saveStore(root, { format: 1, seeds: [sec] });
      expect(drawSample([sec])).toEqual([sec.id]);
      const drew = await cli(["sample"], root, fx.dir);
      expect(drew.code).toBe(0);
      expect(drew.stdout).toContain("Drew 1 seeds: security 1, contract 0");
      expect((await cli(["decide", sec.id, "keep"], root, fx.dir)).code).toBe(0);
      const built = await cli(["build"], root, fx.dir);
      expect(built.stderr).toBe("");
      expect(built.code).toBe(0);
      expect(built.stdout).toContain(", architecture 0, security 1, local 0.");
      const [id] = readdirSync(join(root, "set", "cases"));
      const file = localCaseFile.parse(JSON.parse(readFileSync(join(root, "set", "cases", id as string, "case.json"), "utf8")));
      expect(file.bugs).toHaveLength(1);
      expect(file.bugs[0]).toMatchObject({
        seedKind: "security",
        module: "security",
        category: "security",
        note: "Seeded security defect.",
        source: "seeded",
      });
    },
    SLOW,
  );
});

describe("report (checks 11 and 12, twin hosts)", () => {
  test(
    "report lists by ID the bound seeds that fail a check, leave a name unused, or show a removed token, lists the twin hosts, and changes nothing",
    async () => {
      const fx = await makeNaturalSet(join(TMP, "fx-report"));
      const twin = addTwin(fx, fx.host, 9);
      const seeds = join(TMP, "report");
      const host = (await hostsOf(fx.dir, mkdtempSync(join(TMP, "hosts-")))(fx.host)) as Host;
      const rec = async (f: Partial<SeedFields> & Pick<SeedFields, "path" | "find" | "replace">, state: SeedState): Promise<SeedRecord> => {
        const fields = seedFields({ kind: "contract", anchor: { path: f.path, text: f.replace }, ...f });
        return { ...fields, id: seedId(fx.host, fields), state, host: (await bindingOf(host, f.path)) as SeedRecord["host"] };
      };
      const names = await rec(
        { path: PATHS.feature, find: "  saveRecord(store, k, value);", replace: "  saveRecord(store, key, value);" },
        "kept",
      );
      // c3 "Raise o30 and o31 for the café" adds line 30, and the seed removes the token o30. The middle rule (seeded-truth.md section
      // 14 row 24): a commit subject is no giveaway, so only the PR description below flags it.
      const subject = await rec(
        { path: PATHS.other, find: "export const o30 = 30 + 1;", replace: "export const o29 = 30 + 1;" },
        "confirmed",
      );
      const broken = await rec({ path: PATHS.feature, find: "  nothing();", replace: "  something();" }, "applied");
      const good = await rec(OMIT, "sampled");
      // A refuted seed is not bound, so report does not read it.
      const off = await rec({ path: PATHS.feature, find: "  nothing();", replace: "  other();" }, "refuted");
      saveStore(seeds, { format: 1, seeds: [names, subject, broken, good, off] });
      const caseJson = join(fx.dir, "cases", fx.host, "case.json");
      const plain = readFileSync(caseJson, "utf8");
      expect((await cli(["report"], seeds, fx.dir)).stdout).not.toContain("check 12: ");
      writeFileSync(caseJson, plain.replace("raises some values.", "raises o30."));
      const before = readFileSync(join(seeds, "seeds.json"), "utf8");
      expect((await cli(["report", "x"], seeds, fx.dir)).code).toBe(2);
      const r = await cli(["report"], seeds, fx.dir);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        `${names.id}  kept       contract      check 11: k`,
        `${subject.id}  confirmed  contract      check 12: description`,
        `${broken.id}  applied    contract      fails check 1`,
        `Twin hosts: ${fx.host} and ${twin}. They count as one host.`,
        "Report: 4 bound seeds checked. 1 fail a check, 1 leave a name unused or dangling (check 11), and 1 show a removed token in the PR description (check 12). 0 have a changed host. Twin hosts: 1.",
      ]);
      expect(readFileSync(join(seeds, "seeds.json"), "utf8")).toBe(before);
    },
    SLOW,
  );
});

describe("twin hosts in propose and validate", () => {
  test(
    "propose takes one twin, skips a twin group with seeds, refuses a twin in --cases, and validate stops a twin group at 3 passed files",
    async () => {
      const fx = await makeNaturalSet(join(TMP, "fx-twins"));
      const twin = addTwin(fx, fx.host, 9);
      const seeds = join(TMP, "twins");
      const plan = await cli(["propose"], seeds, fx.dir);
      expect(plan.code).toBe(2);
      expect(plan.stdout).toContain(
        "1 hosts, one per PR group. 1 more hosts have a side-branch merge in their range and take no seed. 1 more hosts are twins: they have the base and head of a host, and take no seed.",
      );
      expect(plan.stdout).toContain("Seeder runs: 1 (model opus, effort high).");
      const notHost = await cli(["propose", "--cases", twin], seeds, fx.dir);
      expect(notHost.code).toBe(2);
      expect(notHost.stderr).toContain(`case ${twin} is no host`);
      // A seed on the twin: the host of the group has seeds, so propose skips it.
      const host = (await hostsOf(fx.dir, mkdtempSync(join(TMP, "hosts-")))(fx.host)) as Host;
      const bound = (await bindingOf(host, PATHS.feature)) as SeedRecord["host"];
      const rec = (n: number, state: SeedState, id: string, path: string = PATHS.feature): SeedRecord => {
        const f = seedFields({ kind: "local", path, find: `f${n}();`, replace: "g();", anchor: { path, text: "g();" } });
        return { ...f, id: seedId(id, f), state, host: { ...bound, id } };
      };
      saveStore(seeds, { format: 1, seeds: [rec(0, "applied", twin)] });
      expect((await cli(["propose"], seeds, fx.dir)).stdout).toContain("Seeder runs: 0");
      // WP-SG5: passed seeds in 2 files of the twin group. An applied seed in one of them takes no run. One in a third file takes one.
      const two = [rec(1, "confirmed", fx.host), rec(2, "kept", twin, PATHS.other), rec(3, "confirmed", fx.host, PATHS.other)];
      saveStore(seeds, { format: 1, seeds: [...two, rec(0, "applied", twin)] });
      const skip = await cli(["validate"], seeds, fx.dir);
      expect(skip.code).toBe(0);
      expect(skip.stdout).toContain("no applied seed needs a validator run. 1 applied seeds are in a file that holds a passed seed");
      saveStore(seeds, { format: 1, seeds: [...two, rec(0, "applied", twin), rec(4, "applied", twin, "src/block.ts")] });
      const one = await cli(["validate"], seeds, fx.dir);
      expect(one.code).toBe(2);
      expect(one.stdout).toContain("1 applied seeds are in a file that holds a passed seed, and take no run.");
      expect(one.stdout).toContain("Validator runs: 1 to 1");
      // Passed seeds in 3 files, split across the twins: the twin group is full for validate and propose.
      saveStore(seeds, { format: 1, seeds: [...two, rec(5, "sampled", twin, PATHS.route), rec(4, "applied", twin, "src/block.ts")] });
      const done = await cli(["validate"], seeds, fx.dir);
      expect(done.code).toBe(0);
      expect(done.stdout).toContain("no applied seed needs a validator run. 0 applied seeds are in a file that holds a passed seed");
      expect((await cli(["propose", "--cases", fx.host], seeds, fx.dir)).stdout).toContain(
        "1 hosts are full: their passed seeds cover 3 files, and they take no seeder run.",
      );
    },
    SLOW,
  );
});

describe("validate takes one passed seed per file (WP-SG5)", () => {
  test(
    "an applied seed in a file with a passed seed takes no run and stays applied, and the host stops at 3 files",
    async () => {
      const seeds = join(TMP, "seeds-full-file");
      const f = fake("seed-propose");
      expect((await cli(["propose", ...f.runner], seeds)).code).toBe(0);
      const host = (await hostsOf(nat.dir, mkdtempSync(join(TMP, "hosts-")))(c3)) as Host;
      const entry = seedFields({
        kind: "entry",
        path: "src/crlf.ts",
        find: "export const c12 = 12 + 1;",
        replace: "export const c12 = 12;",
        anchor: { path: "src/crlf.ts", text: "export const c11 = 11 + 1;" },
      });
      const all = loadStore(seeds).seeds;
      const of = (kind: string) => all.find((s) => s.kind === kind) as SeedRecord;
      // feature, feature, other, block, crlf: run, skip, run, run, stop.
      const order = [of("architecture"), of("lifetime"), of("omission"), of("local"), of("leak"), of("error")];
      order.push({ ...entry, id: seedId(c3, entry), state: "applied", host: (await bindingOf(host, entry.path)) as SeedRecord["host"] });
      saveStore(seeds, { format: 1, seeds: order });
      const v = fake("seed-validate");
      const r = await cli(["validate", ...v.runner], seeds);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        "Validated: 3 confirmed, 0 refuted, 0 refuted by a check without a run, 0 failed runs (still applied). 1 skipped for a full file (still applied). 0 seeds went stale.",
      );
      expect(v.runs()).toHaveLength(3);
      expect(loadStore(seeds).seeds.map((s) => [s.kind, s.state])).toEqual([
        ["architecture", "confirmed"],
        ["lifetime", "applied"],
        ["omission", "confirmed"],
        ["local", "confirmed"],
        ["leak", "invalid"],
        ["error", "invalid"],
        ["entry", "applied"],
      ]);
    },
    SLOW,
  );
});

describe("decide --kind (the build kind)", () => {
  test(
    "keep --kind sets the build kind and keeps the seeder kind, a second keep changes it, and the seeder kind removes it",
    async () => {
      const seeds = join(TMP, "relabel");
      const [a, b] = confirmed().filter((s) => s.kind === "local");
      if (!a || !b) throw new Error("no seeds");
      saveStore(seeds, { format: 1, seeds: [a, b] });
      const one = (id: string) => loadStore(seeds).seeds.find((s) => s.id === id) as SeedRecord;
      const r = await cli(["decide", a.id, "keep", "--kind", "contract", "--why", "A caller breaks."], seeds);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Seed ${a.id} is kept, with kind contract in the build.`);
      expect(one(a.id)).toMatchObject({ state: "kept", kind: "local", label: "contract", reason: "A caller breaks." });
      // A kept seed takes keep again, so a wrong label can change.
      expect((await cli(["decide", a.id, "keep", "--kind", "error"], seeds)).code).toBe(0);
      expect(one(a.id)).toMatchObject({ state: "kept", kind: "local", label: "error" });
      expect((await cli(["decide", a.id, "keep", "--kind", "local"], seeds)).code).toBe(0);
      expect(one(a.id).label).toBeUndefined();
      // --kind goes with keep only, and it must be a kind.
      expect((await cli(["decide", b.id, "drop", "--kind", "contract"], seeds)).code).toBe(2);
      expect((await cli(["decide", b.id, "keep", "--kind", "style"], seeds)).code).toBe(2);
      expect(one(b.id).state).toBe("confirmed");
    },
    SLOW,
  );
});

describe("a host without code", () => {
  test(
    "propose skips a host whose change adds lines to doc files only, before any seeder run",
    async () => {
      const docs = await makeNaturalSet(join(TMP, "fx-docs"));
      // A PR of its own group that changes docs/notes.md only.
      const ix = { ...docs.env, GIT_INDEX_FILE: join(TMP, "docs.index") };
      const run = async (args: string[], stdin?: string, env = docs.env) =>
        (await gitIn(env, docs.repo, args, stdin)).toString("utf8").trim();
      await run(["read-tree", docs.base], undefined, ix);
      const blob = await run(["hash-object", "-w", "--no-filters", "--stdin"], "# Notes\n\nThe store keeps values.\nIt has a size.\n");
      await run(["update-index", "--add", "--cacheinfo", `100644,${blob},docs/notes.md`], undefined, ix);
      const tree = await run(["write-tree"], undefined, ix);
      const head = await run(["commit-tree", tree, "-p", docs.base, "-m", "Explain the size"]);
      await run(["update-ref", `refs/eval/${head}`, head]);
      await run(["bundle", "create", "-q", join(docs.dir, "bundles", docs.bundle), "--all"]);
      const id = caseId({ pr: 9, head, base: docs.base });
      const file = localCaseFile.parse(JSON.parse(readFileSync(join(docs.dir, "cases", docs.host, "case.json"), "utf8")));
      mkdirSync(join(docs.dir, "cases", id));
      writeFileSync(
        join(docs.dir, "cases", id, "case.json"),
        JSON.stringify(
          { ...file, id, group: "pr9", bundle: { ...file.bundle, head }, bugs: [], traps: [], extras: [], human: [], threads: [] },
          null,
          2,
        ),
      );
      const seeds = join(TMP, "seeds-docs");
      const plan = await cli(["propose"], seeds, docs.dir);
      expect(plan.stderr).toBe("");
      expect(plan.code).toBe(2);
      expect(plan.stdout).toContain("2 hosts, one per PR group.");
      expect(plan.stdout).toContain("1 hosts add no line to a file of a known code type and take no seeder run.");
      expect(plan.stdout).toContain("Seeder runs: 1 (model opus, effort high).");
      expect(plan.stdout).toContain("about $1.59");
      const f = fake("seed-propose");
      const r = await cli(["propose", ...f.runner], seeds, docs.dir);
      expect(r.code).toBe(0);
      expect(f.runs()).toHaveLength(1);
      const stored = loadStore(seeds).seeds;
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.every((s) => s.host.id === docs.host)).toBe(true);
    },
    SLOW,
  );
});

describe("leaks (section 7)", () => {
  test("counts the findings with an injection word and prints no finding text", async () => {
    const item = (title: string, body: string) => ({ title, body, trigger: null, path: PATHS.feature, line: 1 });
    const file = join(TMP, "result.json");
    writeFileSync(
      file,
      JSON.stringify({
        format: 1,
        cases: [{ id: "pr1-x" }],
        runs: [
          {
            case: "pr1-x",
            repeat: 2,
            items: [item("A bug in apply", "The key keeps its spaces."), item("Odd edit", "This looks Planted on purpose.")],
          },
        ],
      }),
    );
    const r = await cli(["leaks", file], join(TMP, "none"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Case 1, repeat 2, finding 2: the word "planted".');
    expect(r.stdout).toContain("Leak words: 1 of 2 findings.");
    expect(r.stdout).not.toContain("on purpose");
  });
});

describe("target-merge hosts (WP-SG6)", () => {
  test(
    "propose takes a host whose range merges the target branch, and still leaves out a side-branch merge",
    async () => {
      const fx = await makeNaturalSet(join(TMP, "fx-target"));
      const id = addTargetMerge(fx);
      const seeds = join(TMP, "target");
      const plan = await cli(["propose"], seeds, fx.dir);
      expect(plan.code).toBe(2);
      expect(plan.stdout).toContain("2 hosts, one per PR group. 1 more hosts have a side-branch merge in their range and take no seed.");
      expect(plan.stdout).toContain("Seeder runs: 2 (model opus, effort high).");
      const one = await cli(["propose", "--cases", id], seeds, fx.dir);
      expect(one.stderr).toBe("");
      expect(one.code).toBe(2);
      expect(one.stdout).toContain("Seeder runs: 1 (model opus, effort high).");
      expect((await cli(["propose", "--cases", fx.mergeHost], seeds, fx.dir)).stderr).toContain(`case ${fx.mergeHost} is no host`);
      expect(existsSync(seeds)).toBe(false);
    },
    SLOW,
  );
});
