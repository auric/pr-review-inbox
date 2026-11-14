// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/review-quality-2026.md E3, E4: eval:label with the fake CLI and canned matcher and judge answers. No model call.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo, type EvalBug, type EvalTrap, findCase, setFingerprint } from "../../scripts/eval/cases";
import {
  chunkPairs,
  findingsText,
  groundingOf,
  JUDGE,
  JUDGE_HASH,
  judgeAnswer,
  labelKey,
  MATCHER,
  matcherAnswer,
  matchText,
  openStore,
} from "../../scripts/eval/label";
import { type CaseRun, type EvalItem, type EvalResult, score } from "../../scripts/eval/score";
import { git, gitEnv } from "../../src/server/review/git";
import { readRecords } from "../support/fake-claude";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const LABEL = join(ROOT, "scripts/eval/label.ts");
const COMPARE = join(ROOT, "scripts/eval/compare.ts");
const RESCORE = join(ROOT, "scripts/eval/rescore.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const PLAIN = join(ROOT, "fixtures/claude-synthetic/plain.jsonl");
const GIT_TOOLS = ["git_log", "git_blame", "git_show", "git_diff"].map((t) => `mcp__rl-git__${t}`);

console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/label.ts", import.meta.dir)}`);

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-label-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

describe("chunk pairs (E3)", () => {
  test("pairs only share a file, chunks hold 10 by 10, and a known or asked pair needs no new chunk", () => {
    // c0 to c11 are in a.ts. c12 has its anchor in b.ts and its cause in a.ts. r0 to r2 are in a.ts, r3 in b.ts.
    const cands = [...Array.from({ length: 12 }, () => ["a.ts"]), ["b.ts", "a.ts"]];
    const refs = [["a.ts"], ["a.ts"], ["a.ts"], ["b.ts"]];
    expect(chunkPairs(cands, refs, () => false)).toEqual([
      { cands: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], refs: [0, 1, 2] },
      { cands: [10, 11, 12], refs: [0, 1, 2] },
      { cands: [12], refs: [3] },
    ]);
    expect(chunkPairs(cands, refs, (c) => c < 10)).toEqual([
      { cands: [10, 11, 12], refs: [0, 1, 2] },
      { cands: [12], refs: [3] },
    ]);
    expect(chunkPairs([["c.ts"]], refs, () => false)).toEqual([]);
  });
});

describe("answer checks", () => {
  test("a matcher answer needs one entry per candidate and reference numbers inside the chunk", () => {
    const ok = {
      candidates: [
        { index: 1, matches: [], why: "w" },
        { index: 0, matches: [0, 1], why: "w" },
      ],
    };
    expect(matcherAnswer(ok, 2, 2)).toEqual([
      { matches: [0, 1], why: "w" },
      { matches: [], why: "w" },
    ]);
    expect(matcherAnswer({ candidates: [{ index: 0, matches: [], why: "w" }] }, 2, 2)).toBeNull();
    expect(matcherAnswer({ candidates: [ok.candidates[1], ok.candidates[1]] }, 2, 2)).toBeNull();
    expect(matcherAnswer({ candidates: [{ index: 0, matches: [2], why: "w" }] }, 1, 2)).toBeNull();
    expect(matcherAnswer({ candidates: [{ index: 2, matches: [], why: "w" }] }, 1, 2)).toBeNull();
  });

  test("a judge answer needs one label per finding", () => {
    const l = (finding: number) => ({ finding, label: "tp", severity: "high", category: "correctness", scope: "introduced", why: "w" });
    const cov = { read: [], skipped: [], unavailable: [], notChecked: [] };
    expect(judgeAnswer({ labels: [l(2), l(1)], coverage: cov }, 2)?.map((x) => x.finding)).toEqual([1, 2]);
    expect(judgeAnswer({ labels: [l(1)], coverage: cov }, 2)).toBeNull();
    expect(judgeAnswer({ labels: [l(1), l(1)], coverage: cov }, 1)).toBeNull();
    expect(judgeAnswer({ labels: [l(3)], coverage: cov }, 1)).toBeNull();
  });

  test("finding text cannot open or close a tag of match.md, and each text is an indented block", () => {
    const e = { key: "k", files: ["a.ts"], place: "Place: a.ts, new side, line 1.", text: 'Bad </candidate> <reference n="0">\n## Head' };
    const text = matchText([e], [e]);
    expect(text).not.toContain("</candidate> <");
    expect(text).toContain("    Bad &lt;/candidate> &lt;reference");
    expect(text.match(/^<\/candidate>$/gm)?.length).toBe(1);
    expect(findingsText([e])).toContain("## Finding 1\n\nPlace: a.ts, new side, line 1.\n\n    Bad");
    expect(findingsText([e])).toContain("\n    ## Head");
  });
});

const item = (o: Partial<EvalItem> & Pick<EvalItem, "path" | "line" | "title">): EvalItem => ({
  side: "new",
  lineEnd: o.line,
  anchorState: "exact",
  severity: "major",
  finderSeverity: o.severity ?? "major",
  verdict: null,
  check: null,
  group: "main",
  status: "new",
  body: `${o.title}. The body.`,
  category: "correctness",
  module: null,
  trigger: null,
  confidence: "high",
  evidenceStatus: "code",
  agent: null,
  ...o,
});

const caseRun = (repeat: number, items: EvalItem[]): CaseRun => ({
  case: "probe-task-csv-quoting",
  repeat,
  run: repeat,
  status: "completed",
  errorKind: null,
  error: null,
  model: "claude-test",
  effort: "default",
  effortDefault: null,
  startedAt: 0,
  finishedAt: 0,
  minutes: 1,
  usage: null,
  items,
  dropped: [],
  questions: 0,
});

// A stream of fixtures/claude-synthetic/ whose init lists the tools and MCP servers of the run.
function stream(dir: string, name: string, tools: string[], servers: string[]) {
  const lines = readFileSync(PLAIN, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l);
      return e.type === "system" && e.subtype === "init"
        ? { ...e, tools, mcp_servers: servers.map((s) => ({ name: s, status: "connected" })) }
        : e;
    });
  const out = join(dir, `${name}.jsonl`);
  writeFileSync(out, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return out;
}

// script: label.ts, compare.ts, or rescore.ts. local: the eval-local folder, which holds the labels.
async function label(args: string[], local: string, script = LABEL) {
  const p = Bun.spawn([process.execPath, "--preload", NO_REAL, script, ...args], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_LOOP_EVAL_LOCAL: local },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SLOW,
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

type Rec = {
  argv: string[];
  stdin: string;
  context: Record<string, string>;
  mcp: Record<string, unknown> | null;
  agents: Record<string, { tools?: string[] }> | null;
};
const flag = (r: Rec, name: string) => r.argv[r.argv.indexOf(name) + 1];

describe("eval:label with the fake CLI (E3, E4)", () => {
  // The probe case probe-task-csv-quoting: bug B1 at src/export/csv.ts:9, trap T1 at csv.ts:8, no text, so note and why stand in.
  // Repeat 1: i1 finds B1, i2 repeats it at another line (a claimed duplicate), i3 hits T1, i4 is on a file with no gold item, and
  // i5 is hidden. Repeat 2: i1 again, and i4b is a new text of the i4 problem, so it takes the label of i4.
  const csv = "src/export/csv.ts";
  const route = "src/export/route.ts";
  const i1 = item({ path: csv, line: 9, title: "Values are not quoted" });
  const i2 = item({ path: csv, line: 3, title: "Commas break the columns", severity: "minor" });
  const i3 = item({ path: csv, line: 8, title: "Rounding of the total", severity: "minor" });
  const i4 = item({ path: route, line: 6, title: "No auth check on the export route" });
  const i4b = item({ path: route, line: 6, title: "The export route skips the auth check" });
  const i5 = item({ path: csv, line: 11, title: "Line ends are wrong", group: "hidden", verdict: "refuted", check: "unchecked" });
  const cov = { read: [], skipped: [], unavailable: [], notChecked: [] };
  const lab = (finding: number, l: "tp" | "fp", severity: string) => ({
    finding,
    label: l,
    severity,
    category: "correctness",
    scope: "introduced",
    why: `src/export/csv.ts:${finding} holds it.`,
  });

  test(
    "plans without --real, labels with the fake CLI, reuses each answer, and scores grounded metrics",
    async () => {
      const dir = mkdtempSync(join(TMP, "run-"));
      const local = join(dir, "local");
      const fx = findCase("probe-task-csv-quoting");
      if (!fx) throw new Error("The probe case is missing.");
      const repo = await buildRepo(fx, mkdtempSync(join(dir, "repo-")));
      const result: EvalResult = {
        format: 1,
        createdAt: "2026-11-14T00:00:00.000Z",
        commit: "abc",
        dirty: false,
        promptVersion: "2.7",
        cliVersion: "2.1.302",
        runner: "fake",
        profile: { id: "general", name: "Review", revision: "0123456789" },
        volume: "balanced",
        set: "probe",
        tolerance: 0,
        repeat: 2,
        cases: [
          {
            id: fx.id,
            title: fx.title,
            language: fx.language,
            changedLines: fx.changedLines,
            base: repo.base,
            head: repo.head,
            bugs: fx.bugs,
            traps: fx.traps,
            extras: [],
            task: fx.task,
          },
        ],
        runs: [caseRun(1, [i1, i2, i3, i4, i5]), caseRun(2, [i1, i4b])],
      };
      const results = join(dir, "results");
      mkdirSync(join(results, "review-baseline", "x.calls"), { recursive: true });
      writeFileSync(join(results, "review-baseline", "r.json"), JSON.stringify(result));
      // review-quality-2026.md item 8 gate: a copy of the result with evidence, in its own folder. Evidence is not in the item hash, so
      // the copy shares the label set. i1 cites the last line of csv.ts at the head, i3 the line after it, i4 a file that is not there.
      const head = (await repo.show(repo.head, csv)).split("\n");
      const last = head.at(-1) === "" ? head.length - 1 : head.length;
      const ev = (i: EvalItem, evidence: string) => ({ ...i, evidence });
      const evDir = join(dir, "evidence");
      mkdirSync(evDir);
      writeFileSync(
        join(evDir, "r.json"),
        JSON.stringify({
          ...result,
          runs: [
            caseRun(1, [
              ev(i1, `${csv}:${last}`),
              ev(i2, "no reference"),
              ev(i3, `${csv}:${last + 1}`),
              ev(i4, "src/export/nope.ts:1"),
              i5,
            ]),
            caseRun(2, [ev(i1, `${csv}:1-${last}`), ev(i4b, `https://host.invalid:8080/x and ${csv}:1`)]),
          ],
        }),
      );
      const evidence = async () => {
        const x = await label([evDir, "--evidence"], local);
        expect(x.stderr).toBe("");
        expect(x.code).toBe(0);
        expect(x.stdout).not.toContain("csv.ts");
        expect(x.stdout).not.toContain(fx.id);
        return x.stdout;
      };
      // No labels yet: every finding has no label. No CLI runs.
      expect(await evidence()).toMatch(/\nno label\s+7\s+1\s+1\s+5\s+5\s+1\s+20\.0%\s+1\s+20\.0%(\n|$)/);
      // A JSON file that is no result.
      writeFileSync(join(results, "MANIFEST.json"), "{}");

      const plan = await label([results], local);
      expect(plan.stderr).toBe("");
      expect(plan.code).toBe(2);
      expect(plan.stdout).toContain("1 result files in 1 label sets.");
      expect(plan.stdout).toContain(
        `Open work: 1 matcher chunk pairs (model ${MATCHER.model}, effort ${MATCHER.effort}), 0 findings without a judge label, 1 cases without calibration`,
      );
      expect(plan.stdout).toContain("Add --real");

      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          delayMs: 1,
          bySchema: {
            matcher: { fixture: stream(dir, "matcher", ["Read", "Grep", "Glob", "StructuredOutput"], []) },
            // The calibration: B1 (expected tp) and T1 (expected fp).
            judge: {
              fixture: stream(dir, "judge", ["Read", "Grep", "Glob", ...GIT_TOOLS, "StructuredOutput"], ["rl-git"]),
              judge: { labels: [lab(1, "tp", "high"), lab(2, "fp", "low")], coverage: cov },
            },
          },
          // The first entry whose text is in a ./context file wins.
          match: [
            {
              // The gold match: candidates i1, i2, i3, i5 (first appearance order), references B1, T1.
              when: "Values are not quoted",
              seq: {
                matcher: [
                  {
                    matcher: {
                      candidates: [
                        { index: 0, matches: [0], why: "Same missing quoting." },
                        { index: 1, matches: [0], why: "Same missing quoting." },
                        { index: 2, matches: [1], why: "Same rounding claim." },
                        { index: 3, matches: [], why: "Another problem." },
                      ],
                    },
                  },
                ],
              },
            },
            {
              // The reuse step of repeat 2: candidate i4b, reference i4.
              when: "The export route skips the auth check",
              seq: { matcher: [{ matcher: { candidates: [{ index: 0, matches: [0], why: "Same missing check." }] } }] },
            },
            {
              // The judge of repeat 1: i2, i4, i5.
              when: "Commas break the columns",
              seq: { judge: [{ judge: { labels: [lab(1, "tp", "high"), lab(2, "fp", "medium"), lab(3, "fp", "low")], coverage: cov } }] },
            },
          ],
        }),
      );
      const runner = ["--runner", process.execPath, FAKE, scenario];

      const first = await label([results, ...runner], local);
      expect(first.stderr).toBe("");
      expect(first.code).toBe(0);
      const runs = readRecords<Rec>(record).filter((r) => r.argv.includes("-p"));
      const kinds = runs.map((r) => (JSON.parse(flag(r, "--json-schema") ?? "{}").properties.candidates ? "matcher" : "judge"));
      // The gold match, the calibration, the judge of repeat 1, and the reuse match of repeat 2.
      expect(kinds).toEqual(["matcher", "judge", "judge", "matcher"]);
      for (const r of runs) {
        // E3, E4: read tools only, no agent, no Bash. The finding text stays out of stdin.
        expect(flag(r, "--tools")).toBe("Read,Grep,Glob");
        expect(r.argv.join(" ")).not.toContain("Bash");
        expect(Object.keys(r.agents ?? {})).toEqual(["rl-main"]);
        expect(r.agents?.["rl-main"]?.tools).not.toContain("Agent");
        for (const t of [i1, i2, i4, i4b]) expect(r.stdin).not.toContain(t.title);
      }
      const matchers = runs.filter((_, n) => kinds[n] === "matcher");
      const judges = runs.filter((_, n) => kinds[n] === "judge");
      for (const r of matchers) {
        expect(Object.keys(r.context)).toEqual(["match.md"]);
        expect(r.mcp).toEqual({});
        expect([flag(r, "--model"), flag(r, "--effort")]).toEqual(["sonnet", "low"]);
        expect(r.context["match.md"]).toStartWith("# UNTRUSTED DATA");
      }
      // Fixture items have no text: note and why stand in.
      expect(matchers[0]?.context["match.md"]).toContain(fx.bugs[0]?.note.slice(0, 40));
      expect(matchers[0]?.context["match.md"]).toContain(fx.traps[0]?.why.slice(0, 40));
      for (const r of judges) {
        expect(Object.keys(r.mcp ?? {})).toEqual(["rl-git"]);
        expect(flag(r, "--allowedTools")).toBe("Read,Grep,Glob,mcp__rl-git");
        expect([flag(r, "--model"), flag(r, "--effort")]).toEqual(["sonnet", "medium"]);
        expect(Object.keys(r.context).sort()).toEqual(["findings.md", "pr.md", "task.md"]);
        expect(r.context["pr.md"]).toContain(fx.pr.title);
        expect(r.context["task.md"]).toContain("Acceptance criteria");
      }
      expect(judges[1]?.context["findings.md"]).toContain("## Finding 3");
      expect(first.stdout).toContain("must-finds labelled tp 1/1, traps labelled fp 1/1, agreement 100.0%. Not a ship gate.");
      expect(first.stdout).toContain("Line match and matcher disagree on 1 item and gold pairs.");
      expect(first.stdout).toContain("Open work: 0 matcher chunk pairs, 0 findings without a judge label, 0 cases without calibration.");
      expect(first.stdout).toContain("Label runs: matcher 2 ($0.01), judge 1 ($0.01), calibration 1 ($0.01), total $0.02.");

      // The store holds the model, effort, prompt hash, and CLI version of each label. The case fixture gets nothing.
      const st = openStore(join(local, "labels", labelKey(result)));
      const box = st.labels.cases[fx.id] ?? {};
      expect(Object.values(box).map((e) => [e.label, e.model, e.effort, e.promptHash, e.cliVersion])).toEqual([
        ["tp", JUDGE.model, JUDGE.effort, JUDGE_HASH, "2.1.302"],
        ["fp", JUDGE.model, JUDGE.effort, JUDGE_HASH, "2.1.302"],
        ["fp", JUDGE.model, JUDGE.effort, JUDGE_HASH, "2.1.302"],
        ["fp", JUDGE.model, JUDGE.effort, JUDGE_HASH, "2.1.302"],
      ]);
      expect(Object.values(box)[3]?.from).toBe(Object.keys(box)[1]);
      expect(readFileSync(join(fx.dir, "case.json"), "utf8")).not.toContain("labels");
      expect(readFileSync(join(st.dir, "disagreements.md"), "utf8")).toContain("against bug:B1: line match no, matcher yes");

      // Repeat 1: i1 claims B1 (tp), i2 is a claimed duplicate (unmatched, judge tp), i3 claims T1 (fp), i4 is unmatched (judge fp).
      // Repeat 2: i1 claims B1, i4b is unmatched (fp by reuse).
      const s = score(result, groundingOf(st));
      expect(s.grounded).toBe(true);
      expect(s.suite.groundedRecall).toEqual({ mean: 1, min: 1, max: 1 });
      expect(s.suite.groundedPrecision).toEqual({ mean: 0.75, min: 0.5, max: 1 });
      expect(s.suite.groundedNoise).toEqual({ mean: 1.5, min: 1, max: 2 });
      expect(s.suite.augmentedPrecision).toEqual({ mean: 0.5, min: 0.5, max: 0.5 });
      expect(first.stdout).toMatch(/grounded precision: [^\n]+75\.0% \(50\.0% to 100\.0%\)/);

      // A second run finds every answer in the store: no CLI run, no --real, the same numbers.
      const again = await label([results], local);
      expect(again.stderr).toBe("");
      expect(again.code).toBe(0);
      expect(readRecords<Rec>(record).filter((r) => r.argv.includes("-p")).length).toBe(runs.length);
      expect(again.stdout).toContain("Label runs: matcher 0 ($0.00), judge 0 ($0.00), calibration 0 ($0.00), total $0.00.");
      expect(again.stdout).toMatch(/grounded precision: [^\n]+75\.0% \(50\.0% to 100\.0%\)/);
      expect(again.stdout).toContain("agreement 100.0%");
      expect(existsSync(join(local, "labels", labelKey(result), "matches.json"))).toBe(true);

      // The evidence table with the labels: i1 claims B1 twice, i3 claims T1, i2 is judge tp, and i4, i5, i4b are judge fp.
      const table = await evidence();
      expect(table).toContain("Label set ");
      expect(table).toMatch(/\nmust-find\s+2\s+0\s+0\s+2\s+2\s+0\s+0\.0%\s+0\s+0\.0%\n/);
      expect(table).toMatch(/\ntrap\s+1\s+0\s+0\s+1\s+1\s+0\s+0\.0%\s+1\s+100\.0%\n/);
      expect(table).toMatch(/\njudge tp\s+1\s+0\s+1\s+0\s+0\s+0\s+-\s+0\s+-\n/);
      expect(table).toMatch(/\njudge fp\s+3\s+1\s+0\s+2\s+2\s+1\s+50\.0%\s+0\s+0\.0%\n/);
      expect(table).toMatch(/\nno label\s+0\s+0\s+0\s+0\s+0\s+0\s+-\s+0\s+-(\n|$)/);

      // eval:compare and eval:rescore read the same labels.
      const file = join(results, "review-baseline", "r.json");
      const cmp = await label([file, file], local, COMPARE);
      expect(cmp.stderr).toBe("");
      expect(cmp.code).toBe(0);
      expect(cmp.stdout).toMatch(/grounded precision: [^\n]+\ncase\s+A\s+B\s+delta\nall cases\s+75\.0% \(50\.0% to 100\.0%\)\s+75\.0%/);
      expect(cmp.stdout).toContain("Paired delta (information only): B - A hit rate per counted must-find, matcher: +0.0 pts");
      const rs = await label([file], local, RESCORE);
      expect(rs.stderr).toBe("");
      expect(rs.code).toBe(0);
      expect(rs.stdout).toMatch(/grounded precision: [^\n]+75\.0% \(50\.0% to 100\.0%\)\s+75\.0% \(50\.0% to 100\.0%\)\s+\+0\.0 pts/);
    },
    SLOW,
  );

  test(
    "a local result: ordinals only, gold text, a judge workspace from the bundle, and a refusal after a new build of the set",
    async () => {
      const dir = mkdtempSync(join(TMP, "local-"));
      const local = join(dir, "local");
      const src = join(dir, "src");
      mkdirSync(src, { recursive: true });
      const empty = join(dir, "empty.gitconfig");
      writeFileSync(empty, "");
      const env = {
        ...gitEnv(empty),
        GIT_AUTHOR_NAME: "Eval Author",
        GIT_AUTHOR_EMAIL: "eval@example.invalid",
        GIT_COMMITTER_NAME: "Eval Author",
        GIT_COMMITTER_EMAIL: "eval@example.invalid",
      };
      const g = async (args: string[]) => (await git(["-C", src, ...args], { env })).trim();
      await git(["init", "-q", "--template=", src], { env });
      const text = (k: number) => `${Array.from({ length: 10 }, (_, n) => (n === k ? "changed" : `line ${n + 1}`)).join("\n")}\n`;
      writeFileSync(join(src, "a.ts"), text(-1));
      await g(["add", "."]);
      await g(["commit", "-q", "-m", "base"]);
      const base = await g(["rev-parse", "HEAD"]);
      writeFileSync(join(src, "a.ts"), text(4));
      await g(["commit", "-q", "-am", "head"]);
      const head = await g(["rev-parse", "HEAD"]);
      const bundle = "0123456789abcdef.bundle";
      mkdirSync(join(local, "bundles"), { recursive: true });
      await g(["bundle", "create", "-q", join(local, "bundles", bundle), "--all"]);
      const id = "pr7-h1";
      const bugs: EvalBug[] = [
        {
          id: "B1",
          path: "a.ts",
          side: "new",
          lines: [5, 5],
          severityMin: "major",
          module: "core",
          note: "Posted finding 1.",
          text: "The loop stops one item early.",
          source: "posted",
        },
      ];
      const traps: EvalTrap[] = [
        { id: "T1", path: "a.ts", side: "new", lines: [8, 8], why: "Discarded.", text: "The cast loses the sign.", source: "own" },
      ];
      const fields = {
        title: "Local case",
        language: "typescript",
        bugs,
        traps,
        extras: [],
        human: [],
        group: "pr7",
        hasTask: false,
        large: false,
      };
      const caseJson = JSON.stringify({
        id,
        ...fields,
        pr: { title: "Local PR title", description: "Local PR text." },
        tasks: [],
        bundle: { file: bundle, base, head },
        changedLines: 2,
        rules: 5,
      });
      const caseFile = join(local, "cases", id, "case.json");
      mkdirSync(join(caseFile, ".."), { recursive: true });
      writeFileSync(caseFile, caseJson);
      const result: EvalResult = {
        format: 1,
        createdAt: "2026-11-14T00:00:00.000Z",
        commit: "abc",
        dirty: false,
        promptVersion: "2.7",
        cliVersion: "2.1.302",
        runner: "fake",
        profile: { id: "general", name: "Review", revision: "0123456789" },
        volume: "balanced",
        set: "local",
        fingerprint: setFingerprint([{ id, hash: createHash("sha256").update(caseJson).digest("hex") }]),
        tolerance: 3,
        repeat: 1,
        cases: [{ id, changedLines: 2, base, head, ...fields }],
        runs: [
          {
            ...caseRun(1, [
              item({ path: "a.ts", line: 5, title: "Loop ends early", evidence: "a.ts:10" }),
              item({ path: "a.ts", line: 2, title: "Unused import", evidence: "a.ts:11" }),
            ]),
            case: id,
          },
        ],
      };
      const file = join(dir, "results", "r.json");
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify(result));
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          delayMs: 1,
          bySchema: {
            matcher: {
              fixture: stream(dir, "matcher", ["Read", "Grep", "Glob", "StructuredOutput"], []),
              matcher: {
                candidates: [
                  { index: 0, matches: [0], why: "Same loop bound." },
                  { index: 1, matches: [], why: "Another problem." },
                ],
              },
            },
            judge: { fixture: stream(dir, "judge", ["Read", "Grep", "Glob", ...GIT_TOOLS, "StructuredOutput"], ["rl-git"]) },
          },
          // The calibration (B1, T1), then the judge of the run (Unused import).
          seq: {
            judge: [
              { judge: { labels: [lab(1, "tp", "high"), lab(2, "fp", "low")], coverage: cov } },
              { judge: { labels: [lab(1, "fp", "low")], coverage: cov } },
            ],
          },
        }),
      );
      const out = await label([file, "--runner", process.execPath, FAKE, scenario], local);
      expect(out.stderr).toBe("");
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("case 1");
      expect(out.stdout).not.toContain(id);
      expect(out.stdout).toContain("agreement 100.0%");
      const runs = readRecords<Rec>(record).filter((r) => r.argv.includes("-p"));
      expect(runs.length).toBe(3);
      expect(runs[0]?.context["match.md"]).toContain("The loop stops one item early.");
      expect(runs[1]?.context["pr.md"]).toContain("Local PR title");
      expect(Object.keys(runs[2]?.context ?? {}).sort()).toEqual(["findings.md", "pr.md"]);
      expect(runs[2]?.context["findings.md"]).toContain("Unused import");
      expect(out.stdout).toMatch(/grounded noise: [^\n]+1\.00/);

      // review-quality-2026.md item 8 gate: the head files come from the bundle. a.ts has 10 lines, so a.ts:11 is out of the file.
      const ev = await label([file, "--evidence"], local);
      expect(ev.stderr).toBe("");
      expect(ev.code).toBe(0);
      expect(ev.stdout).toMatch(/\nmust-find\s+1\s+0\s+0\s+1\s+1\s+0\s+0\.0%\s+0\s+0\.0%\n/);
      expect(ev.stdout).toMatch(/\njudge fp\s+1\s+0\s+0\s+1\s+1\s+0\s+0\.0%\s+1\s+100\.0%\n/);
      expect(ev.stdout).not.toContain(id);
      expect(ev.stdout).not.toContain("a.ts");

      // A new build of the set changes case.json, so the labels of this result no longer fit.
      writeFileSync(caseFile, `${caseJson}\n`);
      const refused = await label([file], local);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("fingerprint");
    },
    SLOW,
  );

  test("refuses --real with --runner, no path, and a folder without results", async () => {
    const dir = mkdtempSync(join(TMP, "usage-"));
    expect((await label([], dir)).code).toBe(2);
    expect((await label([dir, "--real", "--runner", "x"], dir)).code).toBe(2);
    expect((await label([dir, "--evidence", "--real"], dir)).code).toBe(2);
    const none = await label([dir], dir);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("No eval result file");
  });
});
