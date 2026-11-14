// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// bun run eval -- --resume: a cut result continues in its own file with the fake CLI. A test cuts a result by an edit of its JSON, as a
// stop between two case runs leaves it. Each child bun process preloads no-real-claude.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo, loadCases, SETS } from "../../scripts/eval/cases";
import { callsDir, resumeRefusal } from "../../scripts/eval/run";
import type { CaseRun, EvalResult } from "../../scripts/eval/score";
import { claudeStream } from "../support/review-fixture";

const SLOW = 180_000;
const ROOT = resolve(import.meta.dir, "../..");
const RUN = join(ROOT, "scripts/eval/run.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const TMP = mkdtempSync(join(tmpdir(), "rl-eval-resume-test-"));
const CLEAN = "probe-clean-axis-ticks";
const TASK = "probe-task-csv-quoting";
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

async function bun(args: string[]) {
  const p = Bun.spawn([process.execPath, "--preload", NO_REAL, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_DATA_DIR: join(TMP, "data") },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

// A fake CLI scenario with one finding on the bug of the task case. version: the CLI version that `claude --version` prints.
let finding: Record<string, unknown>;
function scenario(name: string, version?: string) {
  const file = join(TMP, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      record: join(TMP, `${name}-calls.jsonl`),
      ...(version && { version }),
      auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(TMP, "projects") },
      fixture: claudeStream(TMP, name, "claude-synthetic/review-agent-tree.jsonl", {
        summary: "Fake review.",
        risks: [],
        questions: [],
        coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
        findings: [finding],
      }),
      delayMs: 1,
    }),
  );
  return file;
}
const modelCalls = (name: string) =>
  readFileSync(join(TMP, `${name}-calls.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.includes('"-p"')).length;

beforeAll(async () => {
  console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/run.ts", import.meta.dir)}`);
  mkdirSync(join(TMP, "data"));
  mkdirSync(join(TMP, "repo"));
  const [task] = loadCases(TASK, SETS.probe);
  const bug = task?.bugs[0];
  if (!task || !bug) throw new Error(`The case ${TASK} or its bug is missing.`);
  const repo = await buildRepo(task, join(TMP, "repo"));
  const text = (await repo.show(repo.head, bug.path)).split("\n");
  finding = {
    path: bug.path,
    side: "new",
    line: bug.lines[0],
    lineEnd: bug.lines[1],
    anchorText: (text[bug.lines[0] - 1] ?? "").trim(),
    severity: "major",
    category: "logic",
    body: "A finding of the fake CLI.",
    evidence: `${bug.path}:${bug.lines[0]}`,
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
  };
}, SLOW);

const pairs = (r: EvalResult) => r.runs.map((x) => `${x.case} #${x.repeat}`);
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as EvalResult;

describe("eval --resume with the fake CLI", () => {
  const base = ["--set", "probe", "--cases", `${CLEAN},${TASK}`];
  let file = "";
  let full: EvalResult;

  test(
    "a cut result resumes in its file: the kept runs stay, a failed run and the lost runs run again, and stale calls go",
    async () => {
      const s = scenario("record");
      const out = join(TMP, "out");
      const r0 = await bun([RUN, ...base, "--repeat", "2", "--out", out, "--runner", process.execPath, FAKE, s]);
      expect(r0.stderr).toBe("");
      expect(r0.code).toBe(0);
      file = join(out, readdirSync(out).find((f) => f.endsWith(".json")) as string);
      full = read(file);
      expect(pairs(full)).toEqual([`${CLEAN} #1`, `${TASK} #1`, `${CLEAN} #2`, `${TASK} #2`]);
      const calls = callsDir(file);
      const keptCalls = readFileSync(join(calls, `${CLEAN}-1-1.json`), "utf8");

      // The cut: the run of the task case in repeat 1 failed, and the stop lost both runs of repeat 2. Their calls stay on disk, and
      // two stray calls stand for the partial calls of a cut run.
      const failed: CaseRun = { ...(full.runs[1] as CaseRun), status: "failed", errorKind: "process", items: [] };
      writeFileSync(file, JSON.stringify({ ...full, runs: [full.runs[0], failed] }));
      writeFileSync(join(calls, `${TASK}-1-9.json`), "{}");
      writeFileSync(join(calls, `${CLEAN}-2-9.json`), "{}");
      const before = modelCalls("record");

      const r = await bun([RUN, ...base, "--repeat", "2", "--resume", file, "--runner", process.execPath, FAKE, s]);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Resume: 1 of 4 runs are done. It drops 1 saved run that did not finish or hit the usage limit.");
      expect(r.stdout).not.toContain("[1/4]");
      for (const line of [`[2/4] ${TASK} #1: completed`, `[3/4] ${CLEAN} #2: completed`, `[4/4] ${TASK} #2: completed`])
        expect(r.stdout).toContain(line);
      expect(r.stdout).toContain(`Result: ${file}`);
      // Same commit as the cut run: no warning.
      expect(r.stdout).not.toContain("Warning: the saved result ran at commit");
      // The clean case asks no verify call: 1 + 2 + 1 + 2 calls for the four runs, of which 2 + 1 + 2 run again.
      expect(modelCalls("record") - before).toBe(5);

      expect(readdirSync(join(TMP, "out")).filter((f) => f.endsWith(".json"))).toEqual([file.split(/[\\/]/).at(-1) as string]);
      const after = read(file);
      expect(after.runs).toHaveLength(4);
      expect(new Set(pairs(after)).size).toBe(4);
      expect(after.runs[0]).toEqual(full.runs[0] as CaseRun);
      expect(after.runs.find((x) => x.case === TASK && x.repeat === 1)).toMatchObject({ status: "completed", errorKind: null });
      expect(after.cases).toEqual(full.cases);
      expect(after).toMatchObject({ createdAt: full.createdAt, commit: full.commit, dirty: full.dirty, repeat: 2 });
      expect(after.resumes).toEqual([{ commit: full.commit, dirty: full.dirty, at: expect.any(String) }]);
      // The calls of the kept run stay as they were. The stray calls are gone, and each run that ran again has its calls.
      expect(readFileSync(join(calls, `${CLEAN}-1-1.json`), "utf8")).toBe(keptCalls);
      expect(readdirSync(calls).sort()).toEqual(
        [`${CLEAN}-1-1.json`, `${CLEAN}-2-1.json`, `${TASK}-1-1.json`, `${TASK}-1-2.json`, `${TASK}-2-1.json`, `${TASK}-2-2.json`].sort(),
      );
    },
    SLOW,
  );

  test(
    "a lower --repeat resumes when the finished runs fit, and is refused when they do not",
    async () => {
      expect(file).not.toBe("");
      const s = scenario("repeat");
      const bytes = readFileSync(file, "utf8");
      const low = await bun([RUN, ...base, "--repeat", "1", "--resume", file, "--runner", process.execPath, FAKE, s]);
      expect(low.code).toBe(2);
      expect(low.stderr).toContain("Refused: --resume: 2 finished runs of the saved result are outside 2 cases x 1 repeats.");
      expect(readFileSync(file, "utf8")).toBe(bytes);

      // Repeat 1 finished. A failed run of repeat 2 is dropped, so it does not block --repeat 1.
      const cut = read(file);
      const failed = { ...(cut.runs[3] as CaseRun), status: "failed", errorKind: "usage_limit" } as CaseRun;
      writeFileSync(file, JSON.stringify({ ...cut, runs: [cut.runs[0], cut.runs[1], failed] }));
      const fit = await bun([RUN, ...base, "--repeat", "1", "--resume", file, "--runner", process.execPath, FAKE, s]);
      expect(fit.stderr).toBe("");
      expect(fit.code).toBe(0);
      expect(fit.stdout).toContain("Resume: 2 of 2 runs are done. It drops 1 saved run that did not finish or hit the usage limit.");
      expect(modelCalls("repeat")).toBe(0);
      const after = read(file);
      expect(after.repeat).toBe(1);
      expect(after.runs).toEqual([cut.runs[0], cut.runs[1]] as CaseRun[]);
      expect(readdirSync(callsDir(file)).some((f) => f.includes("-2-"))).toBe(false);
    },
    SLOW,
  );

  test(
    "another CLI version is refused before any case run",
    async () => {
      expect(file).not.toBe("");
      const bytes = readFileSync(file, "utf8");
      const r = await bun([RUN, ...base, "--resume", file, "--runner", process.execPath, FAKE, scenario("cli", "9.9.9 (Claude Code)")]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`Refused: --resume: the saved result ran CLI ${full.cliVersion}, but this run has 9.9.9.`);
      expect(modelCalls("cli")).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    },
    SLOW,
  );
});

describe("resumeRefusal", () => {
  const run = (id: string, repeat: number, status = "completed") => ({ case: id, repeat, status, errorKind: null }) as CaseRun;
  const saved = (): EvalResult => ({
    format: 1,
    createdAt: "2026-11-14T00:00:00.000Z",
    commit: "abc",
    dirty: true,
    promptVersion: "2.7",
    profileVersion: 9,
    cliVersion: "2.1.302",
    runner: "real",
    profile: { id: "general", name: "Review", revision: "a".repeat(64) },
    volume: "balanced",
    requested: { model: "default", effort: "high", verifier: "on", verifierEffort: "medium", reviewerMode: "auto" },
    set: "local",
    tolerance: 3,
    fingerprint: "f".repeat(64),
    repeat: 3,
    cases: [],
    runs: [run("a", 1), run("b", 1), run("a", 2, "failed")],
  });
  const now = (o: Partial<EvalResult> = {}): EvalResult => ({ ...saved(), commit: "def", dirty: false, runs: [], ...o });
  const it = "Refused: --resume: the saved result ran";

  test("the same setup passes, also at another commit and with a dirty checkout", () => {
    expect(resumeRefusal(saved(), now(), ["a", "b"])).toBeNull();
  });

  test("each field of the run setup is refused when it differs", () => {
    const refused = (o: Partial<EvalResult>) => resumeRefusal(saved(), now(o), ["a", "b"]);
    expect(refused({ cliVersion: "2.1.400" })).toBe(`${it} CLI 2.1.302, but this run has 2.1.400.`);
    expect(refused({ fingerprint: "e".repeat(64) })).toBe(`${it} set fingerprint ffffffffffff, but this run has eeeeeeeeeeee.`);
    // The check compares the whole hash. The text shows its first 12 characters.
    expect(refused({ fingerprint: `${"f".repeat(63)}0` })).toBe(`${it} set fingerprint ffffffffffff, but this run has ffffffffffff.`);
    expect(refused({ profile: { id: "general", name: "Review", revision: `${"a".repeat(63)}0` } })).toContain("profile revision");
    expect(refused({ promptVersion: "2.8" })).toBe(`${it} prompt version 2.7, but this run has 2.8.`);
    expect(refused({ profileVersion: 10 })).toContain(`${it} profile version 9`);
    expect(refused({ profile: { id: "general", name: "Review", revision: "b".repeat(64) } })).toContain(
      `${it} profile revision aaaaaaaaaaaa`,
    );
    expect(refused({ runner: "fake" })).toContain(`${it} runner real`);
    expect(refused({ set: "probe" })).toContain(`${it} set local`);
    expect(refused({ rereview: true })).toBe(`${it} mode review, but this run has re-review.`);
    expect(refused({ volume: "thorough" })).toContain(`${it} volume balanced`);
    expect(refused({ tolerance: 0 })).toContain(`${it} tolerance 3`);
    const asked = saved().requested as NonNullable<EvalResult["requested"]>;
    expect(refused({ requested: { ...asked, effort: "low" } })).toBe(`${it} requested effort high, but this run has low.`);
    expect(refused({ requested: { ...asked, replayOf: "x.json" } })).toBe(`${it} requested replayOf none, but this run has x.json.`);
  });

  test("the finished runs must fit the cases and the repeats of this run; a failed run need not", () => {
    // The failed run of repeat 2 runs again, so a repeat of 1 fits.
    expect(resumeRefusal(saved(), now({ repeat: 1 }), ["a", "b"])).toBeNull();
    expect(resumeRefusal(saved(), now({ repeat: 1 }), ["a"])).toBe(
      "Refused: --resume: 1 finished runs of the saved result are outside 1 cases x 1 repeats.",
    );
    const two = { ...saved(), runs: [run("a", 1), run("a", 2)] };
    expect(resumeRefusal(two, now({ repeat: 1 }), ["a", "b"])).toBe(
      "Refused: --resume: 1 finished runs of the saved result are outside 2 cases x 1 repeats.",
    );
  });
});
