// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/submodule-prs.md SD21 and AC-SM8: a cause on line 1 of a moved gitlink path. The diff and the cache come from
// real git, the oracle for the gitlink hunk.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIPPED_PROFILES } from "../../src/server/review/catalog";
import type { RunOutcome } from "../../src/server/review/claude";
import { type Found, type Gitlinks, judge } from "../../src/server/review/judge";
import { diffArgs, type Workspace } from "../../src/server/review/workspace";
import type { Finding } from "../../src/shared/review";

console.log(`judge-gitlinks.test.ts imported from ${Bun.resolveSync("../../src/server/review/judge", import.meta.dir)}`);

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const USE = ["import { parse } from '../lib/parse';", "export const read = (s: string) => parse(s).value;", ""].join("\n");

let dir = "";
let ws: Workspace;

function git(cwd: string, env: Record<string, string>, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    env,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rl-sm1-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  const globalCfg = join(dir, "gitconfig");
  writeFileSync(globalCfg, "");
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalCfg, GIT_TERMINAL_PROMPT: "0" };
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && v !== undefined) env[k] ??= v;
  git(repo, env, "init", "-q");
  writeFileSync(join(repo, "src/use.ts"), USE);
  git(repo, env, "add", "-A");
  git(repo, env, "update-index", "--add", "--cacheinfo", `160000,${OLD},lib`);
  git(repo, env, "commit", "-q", "-m", "base");
  git(repo, env, "update-index", "--cacheinfo", `160000,${NEW},lib`);
  git(repo, env, "commit", "-q", "-m", "head");
  const mergeBase = git(repo, env, "rev-parse", "HEAD~1").trim();
  const sourceHead = git(repo, env, "rev-parse", "HEAD").trim();
  const diff = git(repo, env, "diff", ...diffArgs, mergeBase, sourceHead);
  ws = { cache: join(repo, ".git"), mergeBase, sourceHead, diff } as Workspace;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const caller: Finding = {
  path: "src/use.ts",
  side: "new",
  line: 2,
  lineEnd: null,
  anchorText: "export const read = (s: string) => parse(s).value;",
  severity: "minor",
  category: "Correctness",
  body: "The new parse returns no value field.",
  evidence: "src/use.ts:2",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  title: "read breaks with the new parse",
  trigger: "Any call of read.",
  cause: { path: "lib", side: "new", line: 1, lineEnd: null, anchorText: `Subproject commit ${NEW}` },
  rule: "",
  module: "core",
  preexisting: false,
};
const outcome: RunOutcome = {
  status: "completed",
  kind: null,
  text: null,
  result: {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: {
      summary: "One line.",
      risks: [],
      questions: [],
      coverage: { read: ["src/use.ts"], skipped: [], unavailable: [], notChecked: [] },
      findings: [caller],
      answered: [],
    },
    num_turns: 2,
    duration_ms: 1000,
    total_cost_usd: 0.5,
    usage: { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
    modelUsage: {},
    session_id: "s",
  },
  init: null,
  events: [],
  exitCode: 0,
  stderrTail: "",
};
const profile = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];
const run = (gitlinks?: Gitlinks) => judge(outcome, ws, profile, [], [], null, [], [], false, gitlinks) as Promise<Found>;

describe("gitlink cause (submodule-prs.md SD21, AC-SM8)", () => {
  test("git diff shows the moved gitlink as one hunk at line 1", () => {
    expect(ws.diff).toContain(`@@ -1 +1 @@\n-Subproject commit ${OLD}\n+Subproject commit ${NEW}\n`);
  });

  test("with gitlinks, a finding on an unchanged caller with its cause on line 1 of the gitlink path stays", async () => {
    const f = await run(new Map([["lib", { old: OLD, new: NEW }]]));
    expect(f.summary.dropped).toEqual([]);
    expect(f.candidates).toHaveLength(1);
    const kept = f.candidates[0]?.finding;
    expect(kept?.path).toBe("src/use.ts");
    expect(kept?.cause?.anchor).toMatchObject({ path: "lib", line: 1, lineEnd: 1 });
  });

  test("without gitlinks, the same finding drops as unchanged", async () => {
    const f = await run();
    expect(f.candidates).toEqual([]);
    expect(f.summary.dropped.map((d) => d.reason)).toEqual(["unchanged"]);
  });
});
