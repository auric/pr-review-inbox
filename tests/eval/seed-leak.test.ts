// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/seeded-truth.md section 7 and WP-SG1: no seed metadata and no original head reach a run of a seeded case. run.ts
// runs the synthetic seeded set with the fake CLI, which records stdin, ./context, and every workspace file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCases } from "../../scripts/eval/cases";
import { bindingOf, buildSeededSet, type Host, hostsOf, type SeedBuild } from "../../scripts/eval/seed-build";
import { type SeedRecord, saveStore } from "../../scripts/eval/seed-store";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";
import { ARCH, gitIn, keptSeed, makeNaturalSet, type NaturalSet, OMIT, PATHS, PR_TITLE } from "../support/seed-fixture";

console.log(`seed-leak.test.ts imported from ${Bun.resolveSync("../../scripts/eval/seed-build", import.meta.dir)}`);

const SLOW = 180_000;
const ROOT = resolve(import.meta.dir, "../..");
const RUN = join(ROOT, "scripts/eval/run.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const TMP = mkdtempSync(join(tmpdir(), "rl-seed-leak-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));
const LIVE = join(TMP, "live");
const APPDATA = join(TMP, "appdata");
mkdirSync(LIVE);
mkdirSync(APPDATA);

async function bun(args: string[], env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, "--preload", NO_REAL, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_DATA_DIR: LIVE, LOCALAPPDATA: APPDATA, XDG_DATA_HOME: APPDATA, ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

const IDS = ["sd00000000b1", "sd00000000b2"];
let nat: NaturalSet;
let set: string;
let head: string;
let id: string;
let fingerprint: string;
beforeAll(async () => {
  nat = await makeNaturalSet(join(TMP, "fx"));
  mkdirSync(join(TMP, "hosts"));
  const host = (await hostsOf(nat.dir, join(TMP, "hosts"))(nat.host)) as Host;
  const seeds = join(TMP, "seeds");
  saveStore(seeds, {
    format: 1,
    seeds: [
      keptSeed(IDS[0] as string, ARCH, (await bindingOf(host, PATHS.feature)) as SeedRecord["host"]),
      keptSeed(IDS[1] as string, OMIT, (await bindingOf(host, PATHS.other)) as SeedRecord["host"]),
    ],
  });
  const b = (await buildSeededSet({ seeds, local: nat.dir })) as SeedBuild;
  expect(b.manifest.seeded.seeds).toBe(2);
  fingerprint = b.manifest.fingerprint;
  set = join(seeds, "set");
  const [c] = loadCases("all", join(set, "cases"));
  head = c?.local?.head as string;
  id = c?.id as string;
}, SLOW);

describe("seed leakage (section 7)", () => {
  test(
    "the bundle holds no ref and no object of the original head",
    async () => {
      const [bundle] = readdirSync(join(set, "bundles"));
      const file = join(set, "bundles", bundle as string);
      const heads = (await gitIn(nat.env, null, ["bundle", "list-heads", file])).toString("utf8");
      expect(heads.trim().split("\n")).toHaveLength(2);
      expect(heads).toContain(head);
      const fresh = join(TMP, "fresh.git");
      await gitIn(nat.env, null, ["init", "-q", "--bare", "--template=", fresh]);
      await gitIn(nat.env, fresh, ["fetch", "-q", "--no-tags", file, "+refs/*:refs/*"]);
      const all = (await gitIn(nat.env, fresh, ["rev-list", "--all"])).toString("utf8");
      for (const c of nat.commits.slice(1)) {
        expect(heads).not.toContain(c);
        expect(all).not.toContain(c);
      }
      await expect(gitIn(nat.env, fresh, ["cat-file", "-e", nat.head])).rejects.toThrow();
    },
    SLOW,
  );

  test(
    "a fake-CLI run of the seeded case sees no seed ID, comment, kind name, or original head",
    async () => {
      const dir = join(TMP, "run");
      mkdirSync(dir);
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "seeded", "claude-synthetic/review-agent-tree.jsonl", {
            summary: "Fake review.",
            risks: [],
            questions: [],
            coverage: { read: [PATHS.feature], skipped: [], unavailable: [], notChecked: [] },
            findings: [],
          }),
          delayMs: 1,
          files: true,
        }),
      );
      const out = join(dir, "out");
      const r = await bun([RUN, "--set", "local", "--cases", id, "--out", out, "--runner", process.execPath, FAKE, scenario], {
        REVIEW_LOOP_EVAL_LOCAL: set,
      });
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`[1/1] ${id} #1: completed`);
      // eval:ab --seeded compares the result with the set by this fingerprint.
      const [result] = readdirSync(out).filter((f) => f.endsWith(".json"));
      expect(JSON.parse(readFileSync(join(out, result as string), "utf8")).fingerprint).toBe(fingerprint);
      type Call = { argv: string[]; stdin: string; context: Record<string, string>; files?: Record<string, string> };
      const calls = readRecords<Call>(record).filter((c) => c.argv.includes("-p"));
      expect(calls.length).toBeGreaterThan(0);
      const seen = calls.flatMap((c) => [c.stdin, ...Object.values(c.context), ...Object.entries(c.files ?? {}).flat()]).join("\n");
      // Positive controls: the record holds the PR text, a kept thread, and the seeded code of the workspace.
      expect(seen).toContain(PR_TITLE);
      expect(seen).toContain("Check the order here.");
      expect(Object.keys(calls[0]?.files ?? {})).toContain("repo/src/feature.ts");
      expect(calls[0]?.files?.["repo/src/feature.ts"]).toContain("  store.set(k, v);");
      expect(seen).toContain(head.slice(0, 12));
      // The thread on the seed lines went.
      expect(seen).not.toContain("Why not the shared writer?");
      for (const text of [...IDS, ARCH.comment, OMIT.comment, "Zebra", "seedKind", nat.head.slice(0, 12), ...nat.commits.slice(1)])
        expect(seen).not.toContain(text);
      for (const word of [/\bseeded\b/i, /\barchitecture\b/i, /\bomission\b/i]) expect(seen).not.toMatch(word);
    },
    SLOW,
  );
});
