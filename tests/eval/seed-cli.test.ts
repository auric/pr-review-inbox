// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/seeded-truth.md WP-SG2: eval:seed with the fake CLI. Host selection, the paid guard, the auth check, validate with
// its binding pass and stop rule, the sample draw, the release and escalate rules, the user events, build, and leaks. The seeds root and
// the natural set are temp folders; tests/support/seed-fixture.ts makes the natural set.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { localCaseFile, SEED_KINDS } from "../../scripts/eval/cases";
import { caseId } from "../../scripts/eval/local";
import { drawSample, settle } from "../../scripts/eval/seed";
import { bindingOf, type Host, hostsOf, type SeedKind } from "../../scripts/eval/seed-build";
import { loadStore, type SeedRecord, type SeedState, saveStore, seedId } from "../../scripts/eval/seed-store";
import { readRecords } from "../support/fake-claude";
import { makeNaturalSet, type NaturalSet, PATHS, seedFields } from "../support/seed-fixture";

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
      expect(r.stdout).toContain("1 hosts, one per PR group. 1 more hosts have a merge commit in their range and take no seed.");
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
    "propose takes one host per PR group by the newest committer date, skips merge hosts, and skips hosts with seeds",
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
    "validate fires host- through the binding, and validates in seeder order until a host has 4 confirmed seeds",
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
      expect(plan.stdout).toContain("Validator runs: 4 to 6 (model opus, effort medium).");
      expect(readFileSync(join(seeds(), "seeds.json"), "utf8")).toBe(before);

      const f = fake("seed-validate");
      const r = await cli(["validate", ...f.runner], seeds());
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Validated: 4 confirmed, 0 refuted, 0 failed runs (still applied). 1 seeds went stale.");
      expect(f.runs()).toHaveLength(4);
      expect(store().map((s) => [s.kind, s.state, s.was])).toEqual([
        ["architecture", "confirmed", undefined],
        ["omission", "confirmed", undefined],
        ["local", "confirmed", undefined],
        ["leak", "invalid", undefined],
        ["error", "invalid", undefined],
        ["lifetime", "confirmed", undefined],
        ["entry", "applied", undefined],
        ["entry", "stale", "applied"],
      ]);
      // The host has 4 confirmed seeds, so no run is left.
      const done = await cli(["validate"], seeds());
      expect(done.code).toBe(0);
      expect(done.stdout).toContain("no applied seed needs a validator run");
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
      expect(r.stdout).toContain("Seeded set: 1 cases with 3 seeds. Spare kept seeds: 1.");
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

// Confirmed seeds per kind. architecture and lifetime tie at 3 for the fifth second draw: the kind order gives it to architecture, the
// SEED_KINDS order would give it to lifetime.
const COUNTS: Record<SeedKind, number> = {
  lifetime: 3,
  contract: 5,
  omission: 4,
  entry: 2,
  concurrency: 2,
  leak: 4,
  error: 1,
  architecture: 3,
  local: 6,
};
const HOST = { id: "pr1-aaaaaaaaaaaa-bbbbbbbb", base: "a".repeat(40), head: "b".repeat(40), blob: "c".repeat(40) };
const confirmed = (): SeedRecord[] =>
  SEED_KINDS.flatMap((kind) =>
    Array.from({ length: COUNTS[kind] }, (_, n) => {
      const f = seedFields({ kind, path: `src/${kind}${n}.ts`, find: "a();", replace: "b();", anchor: { path: "x.ts", text: "b();" } });
      return { ...f, id: seedId(HOST.id, f), state: "confirmed" as const, host: HOST };
    }),
  );
const kindsOf = (ids: string[], seeds: SeedRecord[]) =>
  Object.fromEntries(SEED_KINDS.map((k) => [k, ids.filter((id) => seeds.find((s) => s.id === id)?.kind === k).length]));
const withState = (seeds: SeedRecord[], ids: string[], state: SeedState) => seeds.map((s) => (ids.includes(s.id) ? { ...s, state } : s));

describe("the sample draw and the release rule", () => {
  test("the draw gives 14 seeds with 9 kinds, the second draws go to the five largest kinds, and it is the same on every call", () => {
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
      leak: 2,
      error: 1,
      architecture: 2,
      local: 2,
    });
    expect(drawSample(seeds)).toEqual(drawn);
    expect(drawSample([...seeds].reverse())).toEqual(drawn);
    // Only confirmed seeds take part.
    const one = seeds.find((s) => s.kind === "error") as SeedRecord;
    expect(drawSample(withState(seeds, [one.id], "kept"))).not.toContain(one.id);
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
    expect(three.escalate).toEqual(["contract", "omission", "architecture", "lifetime", "concurrency", "leak", "entry", "local"]);
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

      // A refused event names the state and changes nothing.
      const before = readFileSync(join(seeds(), "seeds.json"), "utf8");
      const refused = await cli(["decide", drawn[0] as string, "keep"], seeds());
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("is kept");
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
