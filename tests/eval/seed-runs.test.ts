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
  NO_BLOB,
  proofMissing,
  proposeHost,
  SEEDER,
  SEEDER_PROMPT,
  SEEDER_SCHEMA,
  SEEDER_STDIN,
  seedCtx,
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
import { makeNaturalSet, type NaturalSet, PATHS, PR_TITLE } from "../support/seed-fixture";

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
    expect(SEEDER_PROMPT.split("\n")).toHaveLength(22);
    expect(VALIDATOR_PROMPT).toContain("When the old lines call code that the new lines leave out, read that code to its end.");
    expect(VALIDATOR_PROMPT.split("\n")).toHaveLength(9);
    expect(SEEDER).toEqual({ model: "opus", effort: "high" });
    expect(VALIDATOR).toEqual({ model: "opus", effort: "medium" });
    const seedProps = (SEEDER_SCHEMA as { properties: { seeds: { items: { properties: Record<string, unknown> } } } }).properties.seeds
      .items.properties;
    expect(Object.keys(seedProps).sort()).toEqual(
      ["alt", "anchor", "comment", "find", "kind", "path", "replace", "route", "severity", "trigger", "why"].sort(),
    );
    expect(Object.keys((VALIDATOR_SCHEMA as { properties: Record<string, unknown> }).properties).sort()).toEqual(
      ["originalOk", "plausible", "proof", "severity", "trigger", "verdict", "why"].sort(),
    );
  });

  test("kinds.md has a row per kind, the kind order, and the field route", () => {
    expect([...KIND_ORDER].sort()).toEqual([...SEED_KINDS].sort());
    for (const k of SEED_KINDS) expect(KINDS_MD).toContain(`\n| ${k} | `);
    expect(KINDS_MD).toContain("1. contract:");
    expect(KINDS_MD).toContain("3. architecture: the route body and its uses at BASE.");
    expect(KINDS_MD).toContain("For every other kind, route is empty.");
  });

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
  test("verdict holds: refute", () => expect(keepRefusal({ ...ok, verdict: "holds" }, [])).toContain("verdict holds"));
  test("verdict unsure: refute", () => expect(keepRefusal({ ...ok, verdict: "unsure" }, [])).toContain("verdict unsure"));
  test("severity medium: refute", () => expect(keepRefusal({ ...ok, severity: "medium" }, [])).toContain("severity medium"));
  test("originalOk false: refute", () => expect(keepRefusal({ ...ok, originalOk: false }, [])).toContain("old lines fail"));
  test("plausible false: refute", () => expect(keepRefusal({ ...ok, plausible: false }, [])).toContain("not plausible"));
  test("an empty proof: refute", () => expect(keepRefusal({ ...ok, proof: [] }, [])).toContain("no path:line"));
  test("a proof line that the seeded head does not have: refute", () => expect(keepRefusal(ok, ["src/a.ts:99"])).toContain("src/a.ts:99"));

  test(
    "proofMissing reads each path:line at the head, a last newline adds no line",
    async () => {
      const r = (proof: string[]) => proofMissing(host.repo, host.head, proof);
      // route.ts has 4 lines.
      expect(await r([`${PATHS.route}:3`, `${PATHS.route}:2-4`, `see ${PATHS.route}:1`])).toEqual([]);
      expect(await r([`${PATHS.route}:0`, `${PATHS.route}:5`, `${PATHS.route}:3-5`, "src/nope.ts:1", "no reference"])).toEqual([
        `${PATHS.route}:0`,
        `${PATHS.route}:5`,
        `${PATHS.route}:3-5`,
        "src/nope.ts:1",
        "no reference",
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
      const got = await proposeHost(host, f.ctx, { kinds: null, known: new Set() });
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
    "--kinds keeps only its kinds, and a known ID is no new seed",
    async () => {
      const f = fake("seed-propose");
      const arch = proposed[0] as SeedRecord;
      const got = await proposeHost(host, f.ctx, { kinds: ["architecture", "local"], known: new Set([arch.id]) });
      expect(got?.seeds.map((s) => s.kind)).toEqual(["local"]);
      expect(got?.otherKind).toBe(4);
      expect(got?.repeated).toBe(1);
      expect(f.runs()[0]?.stdin).toBe(`${SEEDER_STDIN}\nPropose only defects of these kinds: architecture, local.`);
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
      expect(Object.keys(run.context).sort()).toEqual(["edit.md", "pr.md"]);
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
