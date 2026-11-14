// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 2.13: the reply eval. The scorer over a fixed result, `--replies` without `--real` exits 2,
// the cases are valid, and one case runs end to end with the fake CLI. Each child bun process preloads no-real-claude.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo } from "../../scripts/eval/cases";
import { loadReplyCases } from "../../scripts/eval/replies";
import { WARNING } from "../../scripts/eval/run";
import { type ReplyEvalResult, type ReplyRun, scoreReplies } from "../../scripts/eval/score";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const RUN = join(ROOT, "scripts/eval/run.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const TMP = mkdtempSync(join(tmpdir(), "rl-eval-replies-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;
const temp = (name: string) => {
  const d = join(TMP, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

async function bun(args: string[], preload = NO_REAL) {
  const p = Bun.spawn([process.execPath, "--preload", preload, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_DATA_DIR: temp("data") },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

const run = (c: string, repeat: number, replies: ReplyRun["replies"], status: ReplyRun["status"] = "completed"): ReplyRun => ({
  case: c,
  repeat,
  run: repeat,
  status,
  error: null,
  minutes: 1,
  usage: null,
  replies,
});
const result = (runs: ReplyRun[]): ReplyEvalResult => ({
  format: 1,
  kind: "replies",
  createdAt: "2026-10-23T00:00:00.000Z",
  commit: "abc",
  dirty: false,
  promptVersion: "reply",
  cliVersion: "2.1.306",
  runner: "fake",
  profile: { id: "general", name: "Review", revision: "r" },
  requested: { model: "default", effort: "default" },
  repeat: 2,
  cases: loadReplyCases("all").map((c) => ({ id: c.id, title: c.title, threads: c.run, expect: c.expect })),
  runs,
});

describe("reply eval", () => {
  test("the scorer checks judgement, action, and cites per run; the pair needs invalid with cite 230, and valid or partly", () => {
    console.log(`WP-PN eval imports ${Bun.resolveSync("../../scripts/eval/score", import.meta.dir)}`);
    const s = scoreReplies(
      result([
        run("general-decision", 1, [{ thread: 101, judgement: "invalid", action: "reply", cites: [230] }]),
        run("general-decision", 2, [{ thread: 101, judgement: "invalid", action: "reply", cites: [] }]),
        run("general-decision-control", 1, [{ thread: 101, judgement: "partly", action: "reply", cites: [] }]),
        run("general-decision-control", 2, [{ thread: 101, judgement: "invalid", action: "reply", cites: [] }]),
      ]),
    );
    expect(s).toEqual({
      "general-decision": { runs: 2, judgement: 1, action: 1, cites: 0.5, pass: 0.5 },
      "general-decision-control": { runs: 2, judgement: 0.5, action: 1, cites: 1, pass: 0.5 },
    });
    // A run with no reply for the thread fails every check. A case without a run gives null.
    expect(scoreReplies(result([run("general-decision", 1, [], "failed")]))).toEqual({
      "general-decision": { runs: 1, judgement: 0, action: 0, cites: 0, pass: 0 },
      "general-decision-control": null,
    });
  });

  test("the cases: the pair shares its code; the control has no thread 230", async () => {
    const [a, b] = loadReplyCases("all");
    expect([a?.id, b?.id]).toEqual(["general-decision", "general-decision-control"]);
    expect([...(a?.base.entries() ?? [])]).toEqual([...(b?.base.entries() ?? [])]);
    expect(a?.threads.map((t) => t.id)).toEqual([101, 230]);
    expect(b?.threads.map((t) => t.id)).toEqual([101]);
    // The patch applies to the base.
    const repo = await buildRepo(a as NonNullable<typeof a>, temp("repo"));
    expect(await repo.show(repo.head, "src/client.ts")).toContain("AbortSignal.timeout(5000)");
    expect(() => loadReplyCases("nope")).toThrow(/Unknown reply case: nope/);
  });

  test("--replies without --real prints the plan and exits 2", async () => {
    const r = await bun([RUN, "--replies", "--repeat", "2"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("Reply eval plan: 2 cases, 2 repeats, profile general.");
    expect(r.stdout).toContain("general-decision: threads 101");
    expect(r.stdout).toContain(WARNING);
  });

  test(
    "one case end to end with the fake CLI: a reply run on thread 101 with the PR context, and the score",
    async () => {
      const dir = temp("e2e");
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-flat.jsonl"),
          replies: {
            summary: "S.",
            replies: [
              {
                thread: 101,
                action: "reply",
                body: "Callers retry 3 times already, as agreed in the general thread.",
                reason: "r",
                evidenceStatus: "code",
                judgement: "invalid",
                cites: [230],
              },
            ],
            coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
          },
          delayMs: 1,
        }),
      );
      const out = join(dir, "out");
      const r = await bun([RUN, "--replies", "--cases", "general-decision", "--out", out, "--runner", process.execPath, FAKE, scenario]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("general-decision #1: completed, pass.");
      const file = readdirSync(out).find((f) => f.endsWith("-replies.json")) as string;
      const saved = JSON.parse(readFileSync(join(out, file), "utf8")) as ReplyEvalResult;
      expect(saved.runs).toEqual([
        expect.objectContaining({ status: "completed", replies: [{ thread: 101, judgement: "invalid", action: "reply", cites: [230] }] }),
      ]);
      const call = readRecords<{ argv: string[]; stdin: string }>(record).find((c) => c.argv.includes("-p"));
      expect(call?.stdin).toContain("Threads: 101 (answer message 101, another person started it)");
      expect(call?.stdin).toContain("./context/pr-context.md");
      expect(call?.stdin).not.toContain("No retry in the client.");
    },
    SLOW,
  );
});
