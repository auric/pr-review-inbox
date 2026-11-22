// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/seeded-truth.md WP-SG2: the seeder and validator runs with the fake CLI and the hand-written streams
// fixtures/claude-synthetic/seed-*.jsonl, the keep conditions, and the context files. No model call. The repository is the synthetic
// natural set of tests/support/seed-fixture.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SEED_KINDS } from "../../scripts/eval/cases";
import { bindingOf, type Host, hostsOf } from "../../scripts/eval/seed-build";
import {
  avoidMd,
  editMd,
  KIND_ORDER,
  KINDS_MD,
  keepRefusal,
  kindMd,
  NO_BLOB,
  proofMissing,
  proposeHost,
  recheckSeed,
  SEEDER,
  SEEDER_PROMPT,
  SEEDER_SCHEMA,
  SEEDER_STDIN,
  seedCtx,
  seedSpots,
  VALIDATOR,
  VALIDATOR_PROMPT,
  VALIDATOR_SCHEMA,
  VALIDATOR_STDIN,
  validateSeed,
} from "../../scripts/eval/seed-runs";
import type { SeedRecord, SeedValidation } from "../../scripts/eval/seed-store";
import { createClaudeRunner } from "../../src/server/review/claude";
import { UNTRUSTED } from "../../src/server/review/workspace";
import { readRecords } from "../support/fake-claude";
import { ARCH, addTargetMerge, gitIn, makeNaturalSet, type NaturalSet, PATHS, PR_TITLE, seedFields } from "../support/seed-fixture";

console.log(`seed-runs.test.ts imported from ${Bun.resolveSync("../../scripts/eval/seed-runs", import.meta.dir)}`);

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const stream = (name: string) => join(ROOT, "fixtures/claude-synthetic", `${name}.jsonl`);
const TMP = mkdtempSync(join(tmpdir(), "rl-seed-runs-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

let nat: NaturalSet;
let host: Host;
beforeAll(async () => {
  nat = await makeNaturalSet(join(TMP, "fx"));
  mkdirSync(join(TMP, "hosts"));
  host = (await hostsOf(nat.dir, join(TMP, "hosts"))(nat.host)) as Host;
}, SLOW);

type Rec = {
  argv: string[];
  stdin: string;
  context: Record<string, string>;
  mcp: Record<string, unknown> | null;
  agents: Record<string, { prompt: string }> | null;
  files?: Record<string, string>;
};
const flag = (r: Rec, name: string) => r.argv[r.argv.indexOf(name) + 1];

// A context of the fake CLI with one stream. Each run appends one record with the files of its workspace.
let ctxs = 0;
function fake(name: string, extra: Record<string, unknown> = {}) {
  const dir = join(TMP, `run-${++ctxs}`);
  mkdirSync(dir);
  const record = join(dir, "calls.jsonl");
  const scenario = join(dir, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      record,
      auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
      delayMs: 1,
      fixture: stream(name),
      files: true,
      ...extra,
    }),
  );
  const ctx = seedCtx(createClaudeRunner({ command: [process.execPath, FAKE, scenario] }), dir);
  return { ctx, runs: () => readRecords<Rec>(record).filter((r) => r.argv.includes("-p")) };
}

describe("prompts, schemas, and kinds.md (sections 5.1 and 5.4)", () => {
  test("the prompts hold the design lines, and the models are those of section 14 decision 4", () => {
    expect(SEEDER_PROMPT).toContain("Give the route name in route. Leave route empty for every other kind.");
    expect(SEEDER_PROMPT).toContain("Do not say that the defect was planted.");
    expect(SEEDER_PROMPT).toContain(
      "Edit only files with these extensions: .ts, .tsx, .js, .jsx, .mjs, .cjs, .c, .cc, .cpp, .cxx, .h, .hpp, .cs, .py.",
    );
    expect(SEEDER_PROMPT).toContain("The anchor line is a line that the change or the edit adds, or a line within 3 lines of one.");
    expect(SEEDER_PROMPT).toContain("Leave no name unused or dangling.");
    expect(SEEDER_PROMPT).toContain(
      "Do not revert or break code or a value that the PR description, its checklist, or a nearby comment names exactly.",
    );
    // The middle rule (seeded-truth.md section 14 row 24): a design doc or a commit subject is no giveaway.
    expect(SEEDER_PROMPT).not.toContain("design doc");
    expect(SEEDER_PROMPT).not.toContain("commit message");
    expect(SEEDER_PROMPT).not.toContain("git_blame");
    expect(SEEDER_PROMPT).toContain("Pick the kind by the nature of the defect, not by the place of the edit.");
    expect(SEEDER_PROMPT).toContain("The PR description can list the defects that its tests catch. Do not plant one of them.");
    expect(SEEDER_PROMPT).toContain("For a security defect, the repository must show where the untrusted input comes from.");
    expect(SEEDER_PROMPT).toContain("Do not change a literal value that nearby code, a comment, or a doc restates.");
    expect(SEEDER_PROMPT).not.toContain("Leave no unused import or name behind.");
    expect(SEEDER_PROMPT.split("\n")).toHaveLength(30);
    expect(VALIDATOR_PROMPT).toContain("When the old lines call code that the new lines leave out, read that code to its end.");
    expect(VALIDATOR_PROMPT).toContain("with the path from the root of ./repo");
    expect(VALIDATOR_PROMPT).toContain("Set kindOk to false when the failure does not fit the claimed kind by that kind order.");
    expect(VALIDATOR_PROMPT.split("\n")).toHaveLength(12);
    expect(SEEDER).toEqual({ model: "opus", effort: "high" });
    expect(VALIDATOR).toEqual({ model: "opus", effort: "medium" });
    const seedProps = (SEEDER_SCHEMA as { properties: { seeds: { items: { properties: Record<string, unknown> } } } }).properties.seeds
      .items.properties;
    expect(Object.keys(seedProps).sort()).toEqual(
      ["alt", "anchor", "comment", "find", "kind", "path", "replace", "route", "severity", "trigger", "why"].sort(),
    );
    const valProps = (VALIDATOR_SCHEMA as { properties: Record<string, { description?: string }> }).properties;
    expect(Object.keys(valProps).sort()).toEqual(
      ["kindOk", "originalOk", "plausible", "proof", "severity", "trigger", "verdict", "why"].sort(),
    );
    expect((VALIDATOR_SCHEMA as { required: string[] }).required).toContain("kindOk");
    expect(valProps.proof?.description).toContain("path:line, with the path from the root of ./repo");
  });

  test("kinds.md has a row per kind, the kind order, and the field route", () => {
    expect([...KIND_ORDER].sort()).toEqual([...SEED_KINDS].sort());
    for (const k of SEED_KINDS) expect(KINDS_MD).toContain(`\n| ${k} | `);
    expect(KIND_ORDER[0]).toBe("security");
    expect(KINDS_MD).toContain("1. security: the source of the untrusted input, and the sink, the check, or the secret.");
    expect(KINDS_MD).toContain("2. contract:");
    expect(KINDS_MD).toContain("4. architecture: the route body and its uses at BASE.");
    expect(KINDS_MD).toContain("Not security: TLS off in test code, a theoretical race, an old library.");
    expect(KINDS_MD).toContain("For every other kind, route is empty.");
    expect(KINDS_MD).toContain("Edit only files with these extensions: .ts, .tsx,");
    expect(KINDS_MD).toContain("Each text occurs once in its file.");
    // kind.md of the validator: the claim, the table, and the kind order, without the seeder rules.
    const kind = kindMd("local");
    expect(kind).toContain("The edit claims the kind local.");
    for (const k of SEED_KINDS) expect(kind).toContain(`\n| ${k} | `);
    expect(kind).toContain("6. local: the function alone.");
    expect(kind).not.toContain("Edit only files");
    expect(kind).not.toContain("route is empty");
  });

  test(
    "seedSpots gives the whole-line range of a find text, and no range when the file does not hold it once as whole lines",
    async () => {
      const f = seedFields({ kind: "local", path: PATHS.route, find: "x", replace: "y", anchor: { path: PATHS.route, text: "y" } });
      const at = (find: string, path: string = PATHS.route) =>
        seedSpots(host, [
          {
            ...f,
            path,
            find,
            id: "sd0000000000",
            state: "invalid",
            host: { id: host.id, base: host.base, head: host.head, blob: NO_BLOB },
          },
        ]);
      expect(await at("  store.set(key.trim(), value);\n")).toEqual([{ path: PATHS.route, lines: [3, 3] }]);
      expect(await at("no such text anywhere\n")).toEqual([]);
      expect(await at("value")).toEqual([]);
      expect(await at("x\n", "src/nope.ts")).toEqual([]);
    },
    SLOW,
  );

  test("avoid.md widens each new-side natural place by 6 lines, and edit.md holds no seeder reasoning", () => {
    expect(avoidMd(host)).toContain(`- ${PATHS.feature}: lines 39 to 51\n`);
    expect(avoidMd(host)).toContain(`- ${PATHS.other}: lines 32 to 44\n`);
    expect(avoidMd({ file: { ...host.file, bugs: [], traps: [], extras: [], human: [] } })).toContain("None.");
    const text = editMd({ path: "a.ts", find: "old();\n", replace: "", trigger: "The input x." }, 7);
    expect(text).toContain("Path: a.ts\nThe old lines started at line 7 of that file.");
    expect(text).toContain("## Old lines\n\n    old();\n");
    expect(text).toContain("None. The edit removes the old lines.");
    expect(text).toContain("## Claimed failure\n\n    The input x.\n");
  });
});

describe("validator keep conditions (section 5.4)", () => {
  const ok: SeedValidation = {
    verdict: "breaks",
    severity: "high",
    trigger: "t",
    proof: ["src/a.ts:1"],
    originalOk: true,
    plausible: true,
    why: "w",
  };
  test("all conditions hold: keep", () => expect(keepRefusal(ok, [])).toBeNull());
  test("kindOk true: keep", () => expect(keepRefusal({ ...ok, kindOk: true }, [])).toBeNull());
  test("kindOk false: refute", () => expect(keepRefusal({ ...ok, kindOk: false }, [])).toContain("does not fit the claimed kind"));
  test("verdict holds: refute", () => expect(keepRefusal({ ...ok, verdict: "holds" }, [])).toContain("verdict holds"));
  test("verdict unsure: refute", () => expect(keepRefusal({ ...ok, verdict: "unsure" }, [])).toContain("verdict unsure"));
  test("severity medium: refute", () => expect(keepRefusal({ ...ok, severity: "medium" }, [])).toContain("severity medium"));
  test("originalOk false: refute", () => expect(keepRefusal({ ...ok, originalOk: false }, [])).toContain("old lines fail"));
  test("plausible false: refute", () => expect(keepRefusal({ ...ok, plausible: false }, [])).toContain("not plausible"));
  test("an empty proof: refute", () => expect(keepRefusal({ ...ok, proof: [] }, [])).toContain("no path:line"));
  test("a proof with no path:line at all: refute", () =>
    expect(keepRefusal({ ...ok, proof: ["The key keeps its spaces.", "So the lookup fails."] }, [])).toContain("no path:line"));
  test("a proof entry with no reference beside one with a reference: keep", () =>
    expect(keepRefusal({ ...ok, proof: ["The key keeps its spaces.", "src/a.ts:1"] }, [])).toBeNull());
  test("a proof line that the seeded head does not have: refute", () => expect(keepRefusal(ok, ["src/a.ts:99"])).toContain("src/a.ts:99"));

  test(
    "proofMissing reads each path:line at the head, a last newline adds no line, and an entry with no reference is skipped",
    async () => {
      const r = (proof: string[]) => proofMissing(host.repo, host.head, proof);
      // route.ts has 4 lines.
      expect(await r([`${PATHS.route}:3`, `${PATHS.route}:2-4`, `see ${PATHS.route}:1`, "no reference"])).toEqual([]);
      expect(await r([`${PATHS.route}:0`, `${PATHS.route}:5`, `${PATHS.route}:3-5`, "src/nope.ts:1"])).toEqual([
        `${PATHS.route}:0`,
        `${PATHS.route}:5`,
        `${PATHS.route}:3-5`,
        "src/nope.ts:1",
      ]);
    },
    SLOW,
  );

  test(
    "a bare file name resolves to the one file that ends with it, and an ambiguous or missing one is missing",
    async () => {
      // A tree of the head plus lib/route.ts, so the name route.ts ends two paths.
      const env = { ...host.repo.env, GIT_INDEX_FILE: join(TMP, "dup.index") };
      const run = async (args: string[], stdin?: string) => (await gitIn(env, host.repo.dir, args, stdin)).toString("utf8").trim();
      await run(["read-tree", host.head]);
      const blob = await run(["hash-object", "-w", "--no-filters", "--stdin"], "export const other = 1;\n");
      await run(["update-index", "--add", "--cacheinfo", `100644,${blob},lib/route.ts`]);
      const dup = await run(["write-tree"]);
      expect(await proofMissing(host.repo, host.head, ["route.ts:3", "the writer at route.ts:2-4", "src/route.ts:4"])).toEqual([]);
      expect(await proofMissing(host.repo, host.head, ["route.ts:5", "nope.ts:1", "c/route.ts:1"])).toEqual([
        "route.ts:5",
        "nope.ts:1",
        "c/route.ts:1",
      ]);
      expect(await proofMissing(host.repo, dup, ["route.ts:1", "src/route.ts:4", "lib/route.ts:1", "lib/route.ts:2"])).toEqual([
        "route.ts:1",
        "lib/route.ts:2",
      ]);
    },
    SLOW,
  );
});

describe("seeder and validator runs with the fake CLI", () => {
  let proposed: SeedRecord[] = [];

  test(
    "a seeder answer becomes proposed seeds and passes through the checks",
    async () => {
      const f = fake("seed-propose");
      const got = await proposeHost(host, f.ctx, { kinds: null, known: new Set(), earlier: [] });
      expect(f.ctx.errors).toEqual([]);
      expect(got?.otherKind).toBe(0);
      expect(got?.repeated).toBe(0);
      proposed = got?.seeds ?? [];
      expect(proposed.map((s) => [s.kind, s.state])).toEqual([
        ["architecture", "applied"],
        ["omission", "applied"],
        ["local", "applied"],
        ["leak", "invalid"],
        ["error", "invalid"],
        ["lifetime", "applied"],
      ]);
      expect(proposed[3]?.reason).toBe("check 4: The seed adds a comment line.");
      expect(proposed[4]?.reason).toBe("check 1: The path does not exist at the head.");
      expect(proposed[4]?.host.blob).toBe(NO_BLOB);
      expect(new Set(proposed.map((s) => s.id)).size).toBe(6);
      for (const s of proposed.filter((x) => x.state === "applied")) expect(await bindingOf(host, s.path)).toEqual(s.host);
      // The run: the judge pattern with the seeder prompt, model, and effort, and kinds.md and avoid.md beside pr.md.
      const [run] = f.runs();
      expect(f.runs()).toHaveLength(1);
      if (!run) throw new Error("no run");
      expect(run.stdin).toBe(SEEDER_STDIN);
      expect(flag(run, "--model")).toBe("opus");
      expect(flag(run, "--effort")).toBe("high");
      expect(flag(run, "--tools")).toBe("Read,Grep,Glob");
      expect(Object.keys(run.mcp ?? {})).toEqual(["rl-git"]);
      expect(Object.values(run.agents ?? {}).map((a) => a.prompt)).toEqual([SEEDER_PROMPT]);
      expect(run.context["kinds.md"]).toBe(KINDS_MD);
      expect(run.context["avoid.md"]).toBe(UNTRUSTED + avoidMd(host));
      expect(run.context["pr.md"]).toContain(PR_TITLE);
      expect(run.files?.[`repo/${PATHS.feature}`]).toContain("  saveRecord(store, k, value);");
    },
    SLOW,
  );

  test(
    "--kinds keeps only its kinds, a known ID is no new seed, and avoid.md lists the earlier edits and each file with a passed seed",
    async () => {
      const f = fake("seed-propose");
      const arch = proposed[0] as SeedRecord;
      // WP-SG5: architecture passed in feature.ts. The other earlier seeds give their find lines, in any state.
      const earlier = proposed.map((s, n) => (n === 0 ? { ...s, state: "confirmed" as const } : s));
      const got = await proposeHost(host, f.ctx, { kinds: ["architecture", "local"], known: new Set([arch.id]), earlier });
      expect(got?.seeds.map((s) => s.kind)).toEqual(["local"]);
      expect(got?.otherKind).toBe(4);
      expect(got?.repeated).toBe(1);
      const [run] = f.runs();
      expect(run?.stdin).toBe(`${SEEDER_STDIN}\nPropose only defects of these kinds: architecture, local.`);
      const avoid = run?.context["avoid.md"] ?? "";
      expect(avoid).toBe(UNTRUSTED + avoidMd(host, await seedSpots(host, earlier)));
      const lines = (path: string) => (run?.files?.[`repo/${path}`] ?? "").replaceAll("\r", "").replace(/\n$/, "").split("\n");
      expect(avoid).toContain(`- ${PATHS.feature}: lines 1 to ${lines(PATHS.feature).length}\n`);
      const others = proposed.filter((x) => x.path !== PATHS.feature && x.path !== "src/missing.ts");
      expect(others.length).toBe(3);
      for (const s of others) {
        const first = s.find.split("\n")[0] as string;
        const at = lines(s.path).indexOf(first) + 1;
        const end = at + s.find.replace(/\r?\n$/, "").split("\n").length - 1;
        expect(at).toBeGreaterThan(0);
        expect(avoid).toContain(`- ${s.path}: lines ${at} to ${end}\n`);
      }
      // The lifetime seed is in feature.ts, so the whole file covers it. The error seed has no file at the head.
      const lifetime = lines(PATHS.feature).indexOf((proposed[5] as SeedRecord).find.replace(/\n$/, "")) + 1;
      expect(lifetime).toBeGreaterThan(0);
      expect(avoid).not.toContain(`- ${PATHS.feature}: lines ${lifetime} to ${lifetime}\n`);
      expect(avoidMd(host)).not.toContain(`- ${PATHS.feature}: lines 1 to`);
      expect(avoid).not.toContain("src/missing.ts");
    },
    SLOW,
  );

  test(
    "the validator sees the seeded head with this seed only, and edit.md holds no why, comment, or kind",
    async () => {
      const f = fake("seed-validate");
      const arch = proposed[0] as SeedRecord;
      const next = await validateSeed(host, arch, f.ctx);
      expect(f.ctx.errors).toEqual([]);
      expect(next.state).toBe("confirmed");
      expect(next.reason).toBeUndefined();
      expect(next.validation?.proof).toEqual([`${PATHS.feature}:22`, `${PATHS.route}:3`]);
      const [run] = f.runs();
      if (!run) throw new Error("no run");
      expect(run.stdin).toBe(VALIDATOR_STDIN);
      expect(flag(run, "--model")).toBe("opus");
      expect(flag(run, "--effort")).toBe("medium");
      expect(flag(run, "--tools")).toBe("Read,Grep,Glob");
      expect(Object.values(run.agents ?? {}).map((a) => a.prompt)).toEqual([VALIDATOR_PROMPT]);
      const edit = run.context["edit.md"] ?? "";
      for (const t of [arch.path, "  saveRecord(store, k, value);", "  store.set(k, v);", arch.trigger]) expect(edit).toContain(t);
      for (const t of [arch.why, arch.comment, "architecture", "Willow"]) expect(edit).not.toContain(t);
      expect(Object.keys(run.context).sort()).toEqual(["edit.md", "kind.md", "pr.md"]);
      expect(run.context["kind.md"]).toBe(kindMd("architecture"));
      expect(next.validation?.kindOk).toBe(true);
      // The worktree holds this seed and no other seed of the host.
      const files = run.files ?? {};
      expect(files[`repo/${PATHS.feature}`]).toContain("  store.set(k, v);");
      expect(files[`repo/${PATHS.feature}`]).toContain("export const f26 = 26 + 1;");
      expect(files[`repo/${PATHS.other}`]).toContain("export const o31 = 31 + 1;");
    },
    SLOW,
  );

  test(
    "a proof line that does not exist refutes the seed",
    async () => {
      const f = fake("seed-validate-missing");
      const next = await validateSeed(host, proposed[1] as SeedRecord, f.ctx);
      expect(next.state).toBe("refuted");
      expect(next.reason).toBe(`The proof names lines that the seeded head does not have: ${PATHS.feature}:999.`);
      expect(next.validation?.verdict).toBe("breaks");
    },
    SLOW,
  );

  test(
    "check 11, or a failed check 1 to 10, refutes an applied seed before any run, with its reason",
    async () => {
      const f = fake("seed-validate");
      const flagged = seedFields({
        kind: "contract",
        path: PATHS.feature,
        find: "  saveRecord(store, k, value);",
        replace: "  saveRecord(store, key, value);",
        anchor: { path: PATHS.feature, text: "saveRecord(store, key, value);" },
      });
      const s: SeedRecord = {
        ...flagged,
        id: "sd00000000b1",
        state: "applied",
        host: (await bindingOf(host, PATHS.feature)) as SeedRecord["host"],
      };
      const next = await validateSeed(host, s, f.ctx);
      expect(next.state).toBe("refuted");
      expect(next.reason).toBe("check 11: The edit leaves these names unused or dangling: k.");
      expect(next.validation).toBeUndefined();
      expect(f.runs()).toEqual([]);
      expect(f.ctx.cost.validator.runs).toBe(0);
      // A seed that fails a check that is newer than the seed (here check 4 on a docstring line) also gets val- and no run.
      const doc = await validateSeed(
        host,
        {
          ...s,
          id: "sd00000000b2",
          find: "  saveRecord(store, k, value);",
          replace: "  saveRecord(store, k, value); /*\n  the value stays as given */",
          anchor: { path: PATHS.feature, text: "saveRecord(store, k, value); /*" },
        },
        f.ctx,
      );
      expect(doc.state).toBe("refuted");
      expect(doc.reason).toBe("check 4: The seed adds a line inside a comment or a docstring.");
      expect(f.runs()).toEqual([]);
    },
    SLOW,
  );

  test(
    "a seed whose fold commit lies before a merge on its file gets val- and no run (WP-SG6)",
    async () => {
      const f = fake("seed-validate");
      const target = (await hostsOf(nat.dir, mkdtempSync(join(TMP, "hosts-")))(addTargetMerge(nat))) as Host;
      const path = "src/block.ts";
      const fields = seedFields({
        kind: "local",
        path,
        find: "  for (const x of list) total += x;",
        replace: "  for (const x of list) total -= x;",
        anchor: { path, text: "for (const x of list) total -= x;" },
      });
      const s: SeedRecord = {
        ...fields,
        id: "sd00000000b3",
        state: "applied",
        host: (await bindingOf(target, path)) as SeedRecord["host"],
      };
      const next = await validateSeed(target, s, f.ctx);
      expect(next.state).toBe("refuted");
      expect(next.reason).toBe(
        "fold: The fold commit is a merge, or a later merge changes the path, so git show of that merge can print the seed.",
      );
      expect(f.runs()).toEqual([]);
    },
    SLOW,
  );

  test(
    "an invalid answer or a failed run leaves the seed applied (val!)",
    async () => {
      // The seeder stream answers with seeds, which is no validator answer.
      const invalid = fake("seed-propose");
      const a = await validateSeed(host, proposed[2] as SeedRecord, invalid.ctx);
      expect(a.state).toBe("applied");
      expect(a.reason).toBe("The validator answer is invalid.");
      expect(a.validation).toBeUndefined();
      expect(invalid.ctx.errors).toEqual(["A validator answer is invalid."]);
      // The auth check of the run fails.
      const failed = fake("seed-validate", { auth: { loggedIn: true, authMethod: "console" } });
      const b = await validateSeed(host, proposed[2] as SeedRecord, failed.ctx);
      expect(b.state).toBe("applied");
      expect(b.reason).toBe("The validator run failed.");
      expect(failed.runs()).toEqual([]);
      expect(failed.ctx.cost.validator.failed).toBe(1);
    },
    SLOW,
  );
});

describe("recheck (section 8)", () => {
  const answer: SeedValidation = {
    verdict: "breaks",
    severity: "high",
    trigger: "t",
    proof: ["The key keeps its spaces.", "route.ts:3", `${PATHS.feature}:22`],
    originalOk: true,
    plausible: true,
    why: "w",
  };
  const refuted = async (v: SeedValidation | undefined): Promise<SeedRecord> => ({
    ...ARCH,
    id: "sd0000000001",
    state: "refuted",
    host: (await bindingOf(host, ARCH.path)) as SeedRecord["host"],
    reason: "The proof names lines that the seeded head does not have.",
    ...(v ? { validation: v } : {}),
  });

  test(
    "a stored answer that passes the keep conditions now moves the seed to confirmed and removes the reason",
    async () => {
      const next = await recheckSeed(host, await refuted(answer));
      expect(next.state).toBe("confirmed");
      expect(next.reason).toBeUndefined();
      expect(next.validation).toEqual(answer);
    },
    SLOW,
  );

  test(
    "severity medium, verdict holds, originalOk false, plausible false, a missing line, or no answer: the seed stays refuted",
    async () => {
      for (const v of [
        { ...answer, severity: "medium" as const },
        { ...answer, verdict: "holds" as const },
        { ...answer, originalOk: false },
        { ...answer, plausible: false },
        { ...answer, proof: ["route.ts:9"] },
        undefined,
      ]) {
        const s = await refuted(v);
        expect(await recheckSeed(host, s)).toBe(s);
      }
    },
    SLOW,
  );

  test(
    "a stored answer that passes the keep conditions, on a seed that check 11 flags: the seed stays refuted",
    async () => {
      const s = {
        ...(await refuted(answer)),
        kind: "contract" as const,
        route: "",
        find: "  saveRecord(store, k, value);",
        replace: "  saveRecord(store, key, value);",
        anchor: { path: PATHS.feature, text: "saveRecord(store, key, value);" },
      };
      expect(await recheckSeed(host, s)).toBe(s);
    },
    SLOW,
  );
});
