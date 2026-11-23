// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/focused-passes.md WP-L1: the opt-in variants "lenses3" and "runs3". Pure parts, then review runs with the fake
// CLI, a temp git remote, and a temp data folder. No test starts the real CLI.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import {
  ANSWERED_RULES,
  ARCHITECTURE_LINES,
  ARCHITECTURE_VERIFY,
  CALLERS_LINES,
  LENS_LINES,
  type Lens,
  mainAgent,
  NO_CONTEXT,
  passLabel,
  passLenses,
  promptVersion,
  type ReviewContext,
  reviewerAgent,
  SHIPPED_PROFILES,
  salvageAgent,
  VERIFY2,
  verifierAgent,
  verifyAgent,
} from "../../src/server/review/catalog";
import type { RunOutcome } from "../../src/server/review/claude";
import { type Candidate, candidatesFile } from "../../src/server/review/context-files";
import { createReviewJobs } from "../../src/server/review/jobs";
import { type Found, mergeFound } from "../../src/server/review/judge";
import { buildPrompt, type PromptInput } from "../../src/server/review/prompt";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { ProfileInput, ReviewItemDto, RunDetail, RunDto, Variant } from "../../src/shared/dto";
import {
  type AnchoredFinding,
  type FindingPayload,
  REVIEW_PROMPT_VERSION,
  reviewJsonSchema,
  verifyJsonSchema,
} from "../../src/shared/review";
import type { RunEvent } from "../../src/shared/run-log";
import { FAKE_TOKEN, FAKE_USER } from "../support/fake-bitbucket";
import { readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, reviewRemote, stubListTools } from "../support/review-fixture";

process.env.REVIEW_LOOP_SECRETS = "memory";
console.log(`passes.test.ts imported from ${Bun.resolveSync("../../src/server/review/jobs", import.meta.dir)}`);

const SLOW = 120_000;
type Shipped = (typeof SHIPPED_PROFILES)[number];
const general = SHIPPED_PROFILES[0] as Shipped;
const withV = (p: Shipped, ...v: Variant[]) => ({ ...p, variants: [...p.variants, ...v] });
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const lines = (prompt: string) => prompt.split("\n");
// Index of the first line of block in l, or -1. The block must be contiguous.
const at = (l: string[], block: readonly string[]) => l.findIndex((_, i) => block.every((x, j) => l[i + j] === x));
const FULL: ReviewContext = {
  taskFile: true,
  attachments: true,
  history: true,
  questions: true,
  rereview: false,
  instructions: true,
  goal: true,
  prContext: true,
  notes: true,
};
const input: PromptInput = {
  mergeBase: "a".repeat(40),
  head: "b".repeat(40),
  note: "NOTE",
  profile: general,
  pr: { project: "P", repo: "r", prId: 1, webUrl: null },
  tasks: [],
  taskFile: true,
  attachments: true,
  history: true,
  questions: true,
  prContext: true,
  notes: true,
  instructions: "# Project instructions\n\nRULE\n",
};
const LENSES: Lens[] = ["failure", "contract", "system"];

const anchor = (line: number) => ({
  path: "src/a.ts",
  line,
  lineEnd: line,
  state: "exact" as const,
  excerpt: [{ n: line, kind: "add" as const, text: `const x${line} = ${line};` }],
});
const finding = (line: number, o: Partial<AnchoredFinding> = {}): AnchoredFinding =>
  ({
    path: "src/a.ts",
    side: "new",
    line,
    lineEnd: null,
    anchorText: `const x${line} = ${line};`,
    severity: "major",
    category: "Correctness",
    body: `Body ${line}.`,
    evidence: `src/a.ts:${line}`,
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
    title: `Title ${line}`,
    trigger: `Trigger ${line}.`,
    cause: null,
    rule: "",
    module: "core",
    anchor: anchor(line),
    ...o,
  }) as AnchoredFinding;

// The prompts, stdin, schemas, and candidates.md of the default profiles at main 1177784, before the variants existed.
function defaultBytes() {
  const agents: string[] = [];
  for (const p of SHIPPED_PROFILES)
    for (const c of [NO_CONTEXT, FULL])
      agents.push(
        mainAgent(p, c).prompt,
        reviewerAgent(p, c).prompt,
        reviewerAgent(p, c, true).prompt,
        verifyAgent(p, c, true, [], true, true).prompt,
        verifierAgent(p, c, true, [], true).prompt,
        salvageAgent(p).prompt,
      );
  const stdin = [buildPrompt(input), buildPrompt({ ...input, questions: false })];
  const schemas = [reviewJsonSchema(false, false), reviewJsonSchema(true, false), verifyJsonSchema(false), verifyJsonSchema(true)];
  const cands: Candidate[] = [1, 2, 3].map((l, i) => ({ n: i + 1, finding: finding(l), group: l < 3 ? 1 : null, from: null }));
  const file = candidatesFile(cands, [{ text: "Q?", why: "W." }], ["Risk."]).file.text;
  return {
    agents: sha(agents.join("\n---\n")),
    stdin: sha(stdin.join("\n---\n")),
    schemas: sha(schemas.map((s) => JSON.stringify(s)).join("\n---\n")),
    candidates: sha(file),
  };
}

describe("variants lenses3 and runs3: prompts (focused-passes.md WP-L1)", () => {
  test("without the variants, every prompt, the stdin, both schemas, and candidates.md keep the bytes of main", () => {
    expect(defaultBytes()).toEqual({
      agents: "ef2425086d5d5a9675e0bc1f6da32165cb0b074200ff88df6f0e10eee7db9148",
      stdin: "6e2209d2e28204fe397333590c8813ac50a96c659cb7dba9b55ccd4b037a62bc",
      schemas: "ba9856660e7af30f719ff44e874af06e6defd430ed222db830311e8f814484fe",
      candidates: "d80a93c3b1ebd4eb0d7857f3b53bd99eea168143571c4ce11d9511f4c373b32d",
    });
    for (const p of SHIPPED_PROFILES) {
      expect(passLenses(p)).toEqual([null]);
      for (const c of [NO_CONTEXT, FULL]) {
        expect(mainAgent(p, c, null)).toEqual(mainAgent(p, c));
        expect(reviewerAgent(p, c, true, null)).toEqual(reviewerAgent(p, c, true));
      }
    }
  });

  test("runs3 changes no prompt; lenses3 changes the finder lens and the verify lines only; the version names the variant", () => {
    for (const p of SHIPPED_PROFILES)
      for (const c of [NO_CONTEXT, FULL]) {
        const r = withV(p, "runs3");
        expect(passLenses(r)).toEqual([null, null, null]);
        expect(mainAgent(r, c)).toEqual(mainAgent(p, c));
        expect(reviewerAgent(r, c, true)).toEqual(reviewerAgent(p, c, true));
        expect(verifyAgent(r, c, true, [], true, true)).toEqual(verifyAgent(p, c, true, [], true, true));
        expect(verifierAgent(r, c, true, [], true)).toEqual(verifierAgent(p, c, true, [], true));
        expect(salvageAgent(r)).toEqual(salvageAgent(p));
        const l = withV(p, "lenses3");
        expect(passLenses(l)).toEqual(LENSES);
        expect(passLenses(withV(p, "runs3", "lenses3"))).toEqual(LENSES);
        expect(salvageAgent(l)).toEqual(salvageAgent(p));
        // focused-passes.md section 4.5: the L2 candidates need the verify lines of "architecture". runs3 gets none.
        for (const a of [verifyAgent(l, c, true, [], true, true), verifierAgent(l, c, true, [], true)])
          expect(at(lines(a.prompt), ARCHITECTURE_VERIFY)).toBeGreaterThan(-1);
        for (const a of [verifyAgent(r, c, true, [], true, true), verifierAgent(r, c, true, [], true)])
          for (const x of ARCHITECTURE_VERIFY) expect(lines(a.prompt)).not.toContain(x);
      }
    expect(promptVersion(withV(general, "lenses3"))).toBe(`${REVIEW_PROMPT_VERSION}+lenses3`);
    expect(promptVersion(withV(general, "runs3"))).toBe(`${REVIEW_PROMPT_VERSION}+runs3`);
  });

  test("each lens sits in the slot of the caller lines in rl-main and rl-reviewer; only the block differs", () => {
    const p = general;
    const call = withV(p, "callers");
    for (const lens of LENSES)
      for (const c of [NO_CONTEXT, FULL])
        for (const [base, lensed, called] of [
          [mainAgent(p, c), mainAgent(p, c, lens), mainAgent(call, c)],
          [reviewerAgent(p, c, true), reviewerAgent(p, c, true, lens), reviewerAgent(call, c, true)],
        ] as const) {
          const l = lines(lensed.prompt);
          const block = LENS_LINES[lens];
          const k = at(l, block);
          expect(k).toBeGreaterThan(-1);
          expect([...l.slice(0, k), ...l.slice(k + block.length)]).toEqual(lines(base.prompt));
          const cl = lines(called.prompt);
          expect(l[k - 1]).toBe(cl[at(cl, CALLERS_LINES) - 1]);
        }
  });

  test("L2 holds CALLERS_LINES, then ARCHITECTURE_LINES; stacked with callers and architecture, each line appears once", () => {
    // focus() keeps the first copy of a line. The two constants share no line, so callers plus architecture keep their bytes.
    expect(CALLERS_LINES.filter((x) => ARCHITECTURE_LINES.includes(x))).toEqual([]);
    const l = lines(mainAgent(general, FULL, "contract").prompt);
    expect(at(l, ARCHITECTURE_LINES)).toBeGreaterThan(at(l, CALLERS_LINES));
    for (const stacked of [withV(general, "callers"), withV(general, "callers", "architecture")]) {
      const s = lines(mainAgent(stacked, FULL, "contract").prompt);
      for (const x of LENS_LINES.contract) expect([x, s.filter((y) => y === x).length]).toEqual([x, 1]);
      expect(at(s, CALLERS_LINES)).toBeGreaterThan(-1);
      expect(at(s, ARCHITECTURE_LINES)).toBeGreaterThan(at(s, CALLERS_LINES));
      expect(s.indexOf("Look hardest at how the change fits the code outside the diff.")).toBeGreaterThan(at(s, CALLERS_LINES));
    }
  });

  test("the lens text: at most 20 words per sentence, the closing line, and no line that narrows the finder", () => {
    for (const lens of LENSES) {
      const own = LENS_LINES[lens].filter((x) => !CALLERS_LINES.includes(x) && !ARCHITECTURE_LINES.includes(x));
      const long = own.flatMap((l) => l.split(/(?<=[.!?:])\s+/)).filter((s) => s.split(/\s+/).filter(Boolean).length > 20);
      expect(long).toEqual([]);
      expect(LENS_LINES[lens].at(-1)).toBe("Report other problems too.");
      expect(own.join("\n")).not.toMatch(/must not report|double-check|\bonly (report|look|check)\b/i);
      expect(own.join("\n")).not.toMatch(/\b(CRITICAL|MUST|IMPORTANT)\b/);
    }
    expect(LENSES.map(passLabel)).toEqual(["failure paths", "contracts and callers", "the whole change"]);
    expect(passLabel(null)).toBe("repeat");
  });
});

// A Found of one pass. raw names the pass.
const found = (k: number, findings: AnchoredFinding[], o: Partial<Found> = {}): Found => ({
  raw: `RAW-${k}`,
  outcome: { status: "completed", events: [] } as unknown as RunOutcome,
  summary: {
    summary: `Summary ${k}.`,
    risks: [`Risk ${k}.`, "Shared risk."],
    coverage: { read: ["src/a.ts", `src/${k}.ts`], skipped: [`Skip ${k}.`], unavailable: [], notChecked: ["Shared note."] },
    dropped: [],
  },
  candidates: findings.map((f, i) => ({ n: i + 1, finding: f, group: null, from: null })),
  questions: [{ text: `Q${k}?`, why: "W." }],
  replies: [],
  gaps: [`Gap ${k}.`],
  ...o,
});

describe("mergeFound (focused-passes.md section 4.4)", () => {
  test("the union in pass order: renumbered, with pass, overlap groups over all passes, and the merge rules of each field", () => {
    const reply = { status: "new", payload: { thread: 1 } } as unknown as Found["replies"][number];
    const events = [{ id: "pass1:start" }, { id: "pass3:start" }] as RunEvent[];
    const m = mergeFound(
      [
        { k: 1, lens: "failure", found: found(1, [finding(1), finding(5)], { replies: [reply] }) },
        { k: 3, lens: "system", found: found(3, [finding(1), finding(9)]) },
      ],
      3,
      { gaps: ["Pass 2 of 3 (contracts and callers) failed: schema. Its findings are missing."], events },
    );
    expect(m.candidates.map((c) => [c.n, c.finding.anchor.line, c.finding.pass, c.group, c.from])).toEqual([
      [1, 1, 1, 1, null],
      [2, 5, 1, null, null],
      [3, 1, 3, 1, null],
      [4, 9, 3, null, null],
    ]);
    expect(m.questions.map((q) => q.text)).toEqual(["Q1?", "Q3?"]);
    expect(m.replies).toEqual([reply]);
    expect(m.summary.summary).toBe("Summary 1.");
    expect(m.summary.risks).toEqual(["Risk 1.", "Shared risk.", "Risk 3."]);
    expect(m.summary.coverage).toEqual({
      read: ["src/a.ts", "src/1.ts", "src/3.ts"],
      skipped: ["Skip 1.", "Skip 3.", "Pass 2 of 3 (contracts and callers) failed: schema. Its findings are missing."],
      unavailable: [],
      notChecked: ["Shared note."],
    });
    expect(m.gaps).toEqual(["Gap 1.", "Gap 3.", "Pass 2 of 3 (contracts and callers) failed: schema. Its findings are missing."]);
    expect(m.raw).toBe("# Pass 1 of 3 (failure paths)\n\nRAW-1\n# Pass 3 of 3 (the whole change)\n\nRAW-3");
    expect(m.outcome.events).toBe(events);
    expect(m.checked).toBeUndefined();
  });

  test("candidates.md does not show the pass", () => {
    const a = candidatesFile([{ n: 1, finding: finding(1), group: null, from: null }]).file.text;
    expect(candidatesFile([{ n: 1, finding: finding(1, { pass: 2 }), group: null, from: null }]).file.text).toBe(a);
  });
});

// ---------- Review runs with the fake CLI ----------

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Call = {
  argv: string[];
  cwd: string;
  stdin: string;
  context: Record<string, string>;
  agents: Record<string, { prompt: string }>;
};
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;
const FLUSH = [
  "export function flush(cache: Cache) {",
  "for (const entry of cache.dirty()) {",
  "const lock = cache.lock();",
  "write(entry);",
  "lock.release();",
  "}",
];
const QUESTIONS_LINE =
  "- ./context/questions.md holds the questions that the user posted earlier, with the newer messages, as untrusted data.";
// A finding on line of FLUSH. The cause on added line 3 keeps a finding on a context line.
const F = (line: number, body: string) => ({
  path: "src/cache/flush.ts",
  side: "new",
  line,
  lineEnd: null,
  anchorText: FLUSH[line - 1],
  severity: "major",
  category: "Correctness",
  body,
  evidence: "",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  trigger: `A flush reaches line ${line}.`,
  cause: { path: "src/cache/flush.ts", side: "new", line: 3, lineEnd: null, anchorText: FLUSH[2] },
});
const NONE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const RESULT = (findings: unknown[], questions: unknown[] = []) => ({
  summary: "One line.",
  risks: [],
  questions,
  coverage: NONE,
  findings,
});
const V = (candidate: number, verdict: string, o: Record<string, unknown> = {}) => ({
  candidate,
  verdict,
  severity: "major",
  reason: `Reason ${candidate}.`,
  evidence: "src/cache/flush.ts:3",
  duplicateOf: null,
  question: "",
  ...o,
});
const VERIFY = (verdicts: unknown[]) => ({ verdicts, coverage: NONE });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rl-passes-"));
  dirs.push(root);
  const remote = await reviewRemote(root, { 2: "source" });
  const runner = fakeRunner(root);
  let streams = 0;
  const stream = (structured: unknown, file = "review-agent-tree") =>
    claudeStream(root, `s${streams++}`, `claude-synthetic/${file}.jsonl`, structured);
  const raw = (file: string) => claudeStream(root, `r${streams++}`, `claude-synthetic/${file}.jsonl`);
  const always = { ...general.reviewer, mode: "always" as const };
  const profiles: ProfileInput[] = [
    general,
    { ...general, id: "lenses3", name: "Lenses", variants: ["lenses3"], reviewer: always },
    { ...general, id: "runs3", name: "Runs", variants: ["runs3"], reviewer: always },
  ];
  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: "http://127.0.0.1:9", userSlug: FAKE_USER, notifications: false, markAi: false, profiles });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const review = createReviewJobs({
    settings,
    live: createLive(),
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: remote.gitRemote,
    listTools: stubListTools,
  });
  cleanup.unshift(async () => {
    await review.stop();
    settings.close();
  });
  const { id: pr } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
        source_branch, target_branch, updated_date, on_dashboard, followed)
      VALUES ('PROJ', 'repo', 2, 'Synthetic change', NULL, 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target,
        'feature', 'main', 1000, 1, 1) RETURNING id`,
    )
    .get({ source: remote.source, target: remote.target }) as { id: number };
  const start = (profile: string) => {
    const r = review.review(db, pr, profile);
    expect(r.status).toBe(202);
    return (r as { run: RunDto }).run.id;
  };
  const done = async (id: number) => {
    await review.wait();
    return review.run(db, id) as RunDetail;
  };
  const calls = () => readRecords<Call>(join(root, "calls.jsonl")).filter((c) => c.argv?.includes("-p"));
  const isVerify = (c: Call) => flag(c.argv, "--json-schema").includes('"verdicts"');
  const finders = () => calls().filter((c) => !isVerify(c));
  const findings = (d: RunDetail) => d.items.filter((i) => i.kind === "finding");
  const payload = (i: ReviewItemDto) => i.payload as FindingPayload;
  const version = (id: number) =>
    (db.query("SELECT prompt_version FROM review_run WHERE id = $id").get({ id }) as { prompt_version: string }).prompt_version;
  return { root, db, pr, review, runner, stream, raw, start, done, calls, isVerify, finders, findings, payload, version };
}
type H = Awaited<ReturnType<typeof setup>>;
const kinds = (h: H) => h.calls().map((c) => (h.isVerify(c) ? "verify" : "find"));

describe("passes in a review run (focused-passes.md sections 4.2 to 4.9)", () => {
  test(
    "a default review makes one finder call and one verify call, with untagged events and no pass in the payload",
    async () => {
      const h = await setup();
      h.runner.write({ fixture: h.stream(RESULT([F(3, "One.")])) });
      const id = h.start("general");
      const d = await h.done(id);
      expect(d.run.status).toBe("completed");
      expect(kinds(h)).toEqual(["find", "verify"]);
      expect(d.events.filter((e) => /^pass\d+:/.test(e.id))).toEqual([]);
      expect(d.events.some((e) => e.tool === "Pass")).toBe(false);
      expect(h.findings(d).map((i) => "pass" in h.payload(i))).toEqual([false]);
      expect(h.version(id)).toBe(REVIEW_PROMPT_VERSION);
    },
    SLOW,
  );

  test(
    "lenses3: three finder calls with their lens, then one verify call over the union; overlap groups and duplicates work across passes",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: {
          review: [
            { fixture: h.stream(RESULT([F(3, "PASS1 lock per entry."), F(5, "PASS1 release.")])) },
            { fixture: h.stream(RESULT([F(4, "PASS2 write throws.")])) },
            { fixture: h.stream(RESULT([F(3, "PASS3 same lock bug.")])) },
          ],
        },
        bySchema: {
          verify: { verify: VERIFY([V(1, "confirmed"), V(2, "confirmed"), V(3, "confirmed"), V(4, "duplicate", { duplicateOf: 1 })]) },
        },
      });
      const id = h.start("lenses3");
      const d = await h.done(id);
      expect(d.run.status).toBe("completed");
      expect(kinds(h)).toEqual(["find", "find", "find", "verify"]);
      const f = h.finders();
      for (const [i, lens] of LENSES.entries()) {
        const c = f[i] as Call;
        for (const name of ["rl-main", "rl-reviewer"]) {
          const l = lines(c.agents[name]?.prompt ?? "");
          expect([name, lens, at(l, LENS_LINES[lens]) > -1]).toEqual([name, lens, true]);
          for (const other of LENSES.filter((x) => x !== lens))
            expect([name, lens, other, at(l, LENS_LINES[other])]).toEqual([name, lens, other, -1]);
        }
      }
      const v = h.calls().find(h.isVerify) as Call;
      const file = v.context["candidates.md"] as string;
      expect(file.match(/^## Candidate \d+$/gm)).toEqual(["## Candidate 1", "## Candidate 2", "## Candidate 3", "## Candidate 4"]);
      expect(file.indexOf("PASS1 lock")).toBeLessThan(file.indexOf("PASS2"));
      expect(file.indexOf("PASS2")).toBeLessThan(file.indexOf("PASS3"));
      expect(file).not.toMatch(/- Pass|"pass"/);
      // Candidates 1 and 4 anchor on line 3: one group. 3 candidates: no split, so no group line.
      expect(file).toMatch(/## Candidate 1\n\n- Place: src\/cache\/flush\.ts:3 \(new side\)\. Group 1\./);
      expect(file).toMatch(/## Candidate 4\n\n- Place: src\/cache\/flush\.ts:3 \(new side\)\. Group 1\./);
      expect(lines(v.agents["rl-main"]?.prompt ?? "")).toContain(ARCHITECTURE_VERIFY[0] as string);
      const shown = h.findings(d).map((i) => [i.body.slice(0, 5), h.payload(i).pass, i.status]);
      expect(shown).toEqual([
        ["PASS1", 1, "new"],
        ["PASS1", 1, "new"],
        ["PASS2", 2, "new"],
        ["PASS3", 3, "discarded"],
      ]);
      expect(d.run.summary?.verify).toMatchObject({ candidates: 4, confirmed: 3, duplicates: 1 });
      // Each pass starts with its mark, and its events follow every earlier event. The check events come last.
      const marks = d.events.filter((e) => e.tool === "Pass");
      expect(marks.map((e) => [e.id, e.note])).toEqual([
        ["pass1:start", "Pass 1 of 3: failure paths."],
        ["pass2:start", "Pass 2 of 3: contracts and callers."],
        ["pass3:start", "Pass 3 of 3: the whole change."],
      ]);
      const ids = d.events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      const seqOf = (p: string) => d.events.filter((e) => e.id.startsWith(p)).map((e) => e.seq);
      expect(Math.max(...seqOf("pass1:"))).toBeLessThan(Math.min(...seqOf("pass2:")));
      expect(Math.max(...seqOf("pass2:"))).toBeLessThan(Math.min(...seqOf("pass3:")));
      expect(Math.max(...seqOf("pass3:"))).toBeLessThan(Math.min(...seqOf("check:")));
      expect(d.events.filter((e) => !/^(pass[123]|check):/.test(e.id))).toEqual([]);
      for (const e of d.events.filter((x) => x.parent !== null)) expect(ids).toContain(e.parent as string);
      // The find phase sums the three passes. The run usage sums every process.
      const phases = d.run.summary?.phases ?? [];
      expect(phases.map((p) => [p.name, p.usage?.turns])).toEqual([
        ["find", 30],
        ["check", 10],
      ]);
      expect(d.run.usage?.turns).toBe(40);
      expect(h.version(id)).toBe(`${REVIEW_PROMPT_VERSION}+lenses3`);
    },
    SLOW,
  );

  test(
    "runs3: three finder calls with byte-identical prompts and no ARCHITECTURE_VERIFY; above 12 candidates the check gets the group line",
    async () => {
      const h = await setup();
      const six = (tag: string) => FLUSH.map((_, i) => F(i + 1, `${tag} line ${i + 1}.`));
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: {
          review: [
            { fixture: h.stream(RESULT(six("A"))) },
            { fixture: h.stream(RESULT(six("B"))) },
            { fixture: h.stream(RESULT(six("C"))) },
          ],
        },
      });
      const id = h.start("runs3");
      const d = await h.done(id);
      expect(kinds(h)).toEqual(["find", "find", "find", "verify"]);
      const [a, b, c] = h.finders() as [Call, Call, Call];
      for (const x of [b, c]) {
        expect(x.agents).toEqual(a.agents);
        expect(x.stdin).toBe(a.stdin);
        expect(flag(x.argv, "--json-schema")).toBe(flag(a.argv, "--json-schema"));
      }
      const v = h.calls().find(h.isVerify) as Call;
      expect(v.context["candidates.md"]?.match(/^## Candidate \d+$/gm)).toHaveLength(18);
      const main = lines(v.agents["rl-main"]?.prompt ?? "");
      expect(main).toContain(VERIFY2.group);
      for (const x of ARCHITECTURE_VERIFY) expect(main).not.toContain(x);
      expect(d.events.filter((e) => e.tool === "Pass").map((e) => e.note)).toEqual([
        "Pass 1 of 3: repeat.",
        "Pass 2 of 3: repeat.",
        "Pass 3 of 3: repeat.",
      ]);
      expect(h.version(id)).toBe(`${REVIEW_PROMPT_VERSION}+runs3`);
    },
    SLOW,
  );

  test(
    "only pass 1 gets the posted questions and the answered rules, so only pass 1 makes reply drafts",
    async () => {
      const h = await setup();
      // A base run gives a question. The user posts it, and the author answers.
      h.runner.write({
        fixture: h.stream(RESULT([], [{ text: "QUESTION-ONE Must flush() stay atomic?", why: "Unclear." }]), "review-flat"),
      });
      const base = await h.done(h.start("general"));
      const q = base.items.find((i) => i.kind === "question") as ReviewItemDto;
      h.db.query("UPDATE review_item SET status = 'posted' WHERE id = $id").run({ id: q.id });
      h.db
        .query(
          `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, remote_id, remote_version, created_at, updated_at)
          VALUES ($pr, $run, 'general', 'k9100', 'Posted.', '{}', $items, 'confirmed', 9100, 0, 1, 1)`,
        )
        .run({ pr: h.pr, run: base.run.id, items: JSON.stringify([{ id: q.id, revision: q.revision }]) });
      const comment = (id: number, author: string, at: number, text: string) =>
        h.db
          .query(
            `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, author_name, text, thread_resolved, created_at, updated_at)
            VALUES ($pr, $id, 0, $parent, 9100, $author, $author, $text, 0, $at, $at)`,
          )
          .run({ pr: h.pr, id, parent: id === 9100 ? null : 9100, author, text, at });
      comment(9100, FAKE_USER, 10, "Posted.");
      comment(9101, "asmith", 20, "ANSWER-9101 Yes, it stays atomic.");
      const before = h.finders().length;
      const settled = {
        thread: 9100,
        question: null,
        outcome: "settled",
        evidence: "Message 9101.",
        reply: "AI-9100 Thanks.",
        finding: null,
      };
      h.runner.write({
        fixture: h.stream(RESULT([])),
        // The seq index counts the earlier base run too.
        seq: {
          review: [
            {},
            { fixture: h.stream(RESULT([F(3, "PASS1.")])), answered: [settled] },
            { fixture: h.stream(RESULT([F(4, "PASS2.")])) },
            { fixture: h.stream(RESULT([F(5, "PASS3.")])) },
          ],
        },
      });
      const d = await h.done(h.start("lenses3"));
      expect(d.run.status).toBe("completed");
      const [p1, p2, p3] = h.finders().slice(before) as [Call, Call, Call];
      expect(p1.stdin).toContain(QUESTIONS_LINE);
      expect(lines(p1.agents["rl-main"]?.prompt ?? "")).toContain(ANSWERED_RULES[0] as string);
      for (const p of [p2, p3]) {
        expect(p.stdin).not.toContain("questions.md");
        expect(lines(p.agents["rl-main"]?.prompt ?? "")).not.toContain(ANSWERED_RULES[0] as string);
      }
      expect(d.items.filter((i) => i.kind === "reply").map((i) => [(i.payload as { thread: number }).thread, i.body])).toEqual([
        [9100, "AI-9100 Thanks."],
      ]);
    },
    SLOW,
  );
});

// focused-passes.md section 4.3: one test per row. Each returns the run and the gap lines of its coverage.
describe("pass state machine (focused-passes.md section 4.3)", () => {
  const gapLines = (d: RunDetail) => (d.run.summary?.coverage.skipped ?? []).filter((l) => l.startsWith("Pass "));

  test(
    "rows 6 and 9: a capped pass gets its salvage run, and its notes are gone before the next pass starts",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: {
          review: [
            { fixture: h.stream(RESULT([F(3, "PASS1.")])) },
            { fixture: h.raw("max-turns-notes") },
            { fixture: h.stream(RESULT([F(4, "SALVAGED2.")])) },
            { fixture: h.stream(RESULT([F(5, "PASS3.")])) },
          ],
        },
      });
      const d = await h.done(h.start("lenses3"));
      expect(d.run.status).toBe("completed");
      const f = h.finders();
      expect(f).toHaveLength(4);
      expect(f[2]?.context["salvage-notes.md"]).toBeDefined();
      expect(f[3]?.context["salvage-notes.md"]).toBeUndefined();
      expect(f.map((c) => flag(c.argv, "--max-turns"))).toEqual([
        String(general.maxTurns),
        String(general.maxTurns),
        "6",
        String(general.maxTurns),
      ]);
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass])).toEqual([
        ["PASS1.", 1],
        ["SALVAGED2.", 2],
        ["PASS3.", 3],
      ]);
      expect(d.run.summary?.coverage.notChecked).toContain(
        `Pass 2 of 3 (contracts and callers) reached its turn cap (${general.maxTurns}). Its findings come from its notes so far.`,
      );
      expect(gapLines(d)).toEqual([]);
      expect(d.events.find((e) => e.id === "pass2:salvage:start")).toMatchObject({ tool: "Salvage", status: "ok" });
      expect(d.events.filter((e) => e.id.startsWith("pass2:salvage:")).length).toBeGreaterThan(1);
      const seqOf = (p: string) => d.events.filter((e) => e.id.startsWith(p)).map((e) => e.seq);
      expect(Math.max(...seqOf("pass2:"))).toBeLessThan(Math.min(...seqOf("pass3:")));
      // 10 + 101 + salvage 10 + 10 turns.
      expect(d.run.summary?.phases?.[0]?.usage?.turns).toBe(131);
    },
    SLOW,
  );

  test(
    "rows 5 and 10: a schema failure and a failed salvage leave gap lines, and the run ends incomplete with the other pass",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: {
          review: [
            { fixture: h.stream({ findings: "bad" }) },
            { fixture: h.raw("max-turns-notes") },
            { fixture: h.raw("usage-limit") },
            { fixture: h.stream(RESULT([F(5, "PASS3.")])) },
          ],
        },
      });
      const d = await h.done(h.start("lenses3"));
      expect(d.run.status).toBe("incomplete");
      expect(h.finders()).toHaveLength(4);
      expect(gapLines(d)).toEqual([
        "Pass 1 of 3 (failure paths) failed: schema. Its findings are missing.",
        "Pass 2 of 3 (contracts and callers) failed: max_turns. Its findings are missing.",
      ]);
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass])).toEqual([["PASS3.", 3]]);
      expect(h.finders()[3]?.context["salvage-notes.md"]).toBeUndefined();
    },
    SLOW,
  );

  test(
    "rows 7 and 2: a usage limit stops the later passes; the run checks the usable pass and ends incomplete",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: { review: [{ fixture: h.stream(RESULT([F(3, "PASS1.")])) }, { fixture: h.raw("usage-limit") }] },
      });
      const d = await h.done(h.start("lenses3"));
      expect(d.run.status).toBe("incomplete");
      expect(kinds(h)).toEqual(["find", "find", "verify"]);
      expect(gapLines(d)).toEqual([
        "Pass 2 of 3 (contracts and callers) failed: usage_limit. Its findings are missing.",
        "Pass 3 of 3 (the whole change) did not run, because pass 2 hit usage_limit.",
      ]);
      expect(d.events.some((e) => e.id === "pass3:start")).toBe(false);
      expect(h.findings(d).map((i) => i.body)).toEqual(["PASS1."]);
    },
    SLOW,
  );

  test(
    "row 8 with rows 4 and 12: a failed pass 1 with good passes 2 and 3 checks their findings",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: {
          review: [
            { fixture: h.raw("no-structured-output") },
            { fixture: h.stream(RESULT([F(4, "PASS2.")])) },
            { fixture: h.stream(RESULT([F(5, "PASS3.")])) },
          ],
        },
      });
      const d = await h.done(h.start("lenses3"));
      expect(d.run.status).toBe("incomplete");
      expect(kinds(h)).toEqual(["find", "find", "find", "verify"]);
      expect(gapLines(d)).toHaveLength(1);
      expect(gapLines(d)[0]).toStartWith("Pass 1 of 3 (failure paths) failed: ");
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass])).toEqual([
        ["PASS2.", 2],
        ["PASS3.", 3],
      ]);
      expect(d.run.summary?.summary).toBe("One line.");
    },
    SLOW,
  );

  test(
    "row 11: with no usable pass, the run ends as a one-pass run ends with pass 1, with the usage of all passes",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: {
          review: [{ fixture: h.raw("max-turns-empty") }, { fixture: h.stream({ findings: "bad" }) }, { fixture: h.raw("usage-limit") }],
        },
      });
      const d = await h.done(h.start("lenses3"));
      expect(kinds(h)).toEqual(["find", "find", "find"]);
      expect(d.run).toMatchObject({ status: "failed", errorKind: "max_turns" });
      expect(d.run.errorText).toBe("Reached maximum number of turns (100) The run left no notes to salvage.");
      expect(d.run.usage?.turns).toBe(101 + 10 + 1);
      expect(d.items).toEqual([]);
    },
    SLOW,
  );

  test(
    "row 3: a cancel in pass 2 ends the run cancelled with the usage of pass 1, and no later process starts",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([])),
        seq: { review: [{ fixture: h.stream(RESULT([F(3, "PASS1.")])) }, { fixture: h.stream(RESULT([])), delayMs: 300 }] },
      });
      const id = h.start("lenses3");
      const end = Date.now() + 30_000;
      while (h.finders().length < 2 && Date.now() < end) await Bun.sleep(25);
      expect(h.finders()).toHaveLength(2);
      expect(h.review.cancel(h.db, id)).toBe("cancelled");
      const d = await h.done(id);
      expect(d.run.status).toBe("cancelled");
      expect(kinds(h)).toEqual(["find", "find"]);
      expect(d.run.usage?.turns).toBeGreaterThanOrEqual(10);
      expect(d.items).toEqual([]);
    },
    SLOW,
  );
});
