// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The probe set (docs/plans/review-v2/review-quality-2026.md E1): its composition, its repositories, and a run that seeds the threads
// and the task text of its cases.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRepo, type EvalCase, loadCases, SETS } from "../../scripts/eval/cases";
import { type EvalItem, type EvalResult, matches } from "../../scripts/eval/score";
import { git } from "../../src/server/review/git";
import { readRecords } from "../support/fake-claude";
import { claudeStream } from "../support/review-fixture";

const SLOW = 120_000;
const ROOT = resolve(import.meta.dir, "../..");
const RUN = join(ROOT, "scripts/eval/run.ts");
const NO_REAL = join(ROOT, "tests/support/no-real-claude.ts");
const FAKE = join(ROOT, "tests/support/fake-claude.ts");
const CLAIM = "This case is handled";

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-probe-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;
const temp = (name: string) => {
  const d = join(TMP, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/cases.ts", import.meta.dir)}`);
const cases = loadCases("all", SETS.probe);
const kind = (c: EvalCase) => {
  const roots = (c.threads ?? []).filter((t) => t.id === t.root && t.lines);
  const onBug = roots.some((t) => c.bugs.some((b) => b.path === t.path && overlaps(b.lines, t.lines as [number, number])));
  const onTrap = roots.some((t) => c.traps.some((x) => x.path === t.path && overlaps(x.lines, t.lines as [number, number])));
  const claim = (c.threads ?? []).some((t) => t.author === "eval-author" && t.text.includes(CLAIM));
  // obligations.md section 8: the obligation cases, by a seeded omission or a met obligation.
  if (c.id.startsWith("probe-obl-")) return c.clean ? "met obligation" : "missing obligation";
  // docs/plans/review-v2/minor-fold.md section 6.3: one nit bug that only a polish point can raise.
  if (c.id.startsWith("probe-polish-")) return "polish point";
  // review-quality-2026.md item 10: one security bug, and traps that look like security holes but are safe.
  if (c.id.startsWith("probe-sec-")) return "security";
  if (c.clean) return "clean";
  if (onBug && claim && c.bugs.length === 1) return "wrong claim";
  if (onTrap && !c.bugs.length) return "right claim";
  if (c.task !== undefined) return c.bugs.length === 1 && c.bugs[0]?.module === "intent" ? "unmet criterion" : "met criterion";
  return c.threads === undefined && !c.bugs.length ? "no requirement" : "other";
};

describe("probe set", () => {
  test("26 cases: 2 wrong claims, 1 right claim, 2 unmet criteria, 1 met criterion, 1 invented requirement, 1 clean case, 8 missing obligations, 3 met obligations, 2 polish points, and 5 security cases", () => {
    expect(cases).toHaveLength(26);
    const by = Object.groupBy(cases, kind);
    expect(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v?.length]))).toEqual({
      "wrong claim": 2,
      "right claim": 1,
      "unmet criterion": 2,
      "met criterion": 1,
      "no requirement": 1,
      clean: 1,
      "missing obligation": 8,
      "met obligation": 3,
      "polish point": 2,
      security: 5,
    });
    // Each polish case has one nit bug, so recall at balanced leaves it out and only polishRecall counts it.
    for (const c of by["polish point"] ?? []) expect(c.bugs.map((b) => b.severityMin)).toEqual(["nit"]);
    // Each security case has one bug of module security, so the class security slice counts it.
    for (const c of by.security ?? []) expect(c.bugs.map((b) => b.module)).toEqual(["security"]);
    // A trap only, and a clean case has no bug. Each PR text is non-empty, so the intent module runs (catalog.ts lacks).
    for (const k of ["right claim", "met criterion", "no requirement", "clean", "met obligation"] as const)
      for (const c of by[k] ?? []) expect(c.bugs).toEqual([]);
    expect(cases.filter((c) => !c.pr.description.trim())).toEqual([]);
    // The case IDs differ from the other sets, so eval:rescore finds each case by its ID.
    const ids = Object.values(SETS).flatMap((dir) => loadCases("all", dir).map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  // obligations.md section 8: a missing obligation can sit on the false doc line. An item there matches the seeded omission.
  test("an item on the doc line of each obligation omission matches it, and the next line does not", () => {
    const item = (path: string, line: number) => ({ path, side: "new" as const, line, lineEnd: line }) as EvalItem;
    const bug = (id: string) => cases.find((c) => c.id === id)?.bugs[0];
    for (const [id, path, line] of [
      ["probe-obl-doc-contract", "docs/api.md", 7],
      ["probe-obl-guide-signature", "docs/guide.md", 5],
      ["probe-obl-guide-unnamed", "docs/user-guide.md", 7],
      ["probe-obl-header-platform", "include/clock.h", 7],
    ] as const) {
      const b = bug(id);
      if (!b) throw new Error(`${id} has no bug.`);
      expect({ id, hit: matches(item(path, line), b), next: matches(item(path, line + 1), b) }).toEqual({ id, hit: true, next: false });
    }
  });

  test(
    "each case applies to its base, and each item and thread root holds text at the head",
    async () => {
      for (const c of cases) {
        const repo = await buildRepo(c, temp(c.id));
        const numstat = await git(["--git-dir", repo.url, "diff", "--numstat", "--no-renames", repo.base, repo.head], { env: repo.env });
        const counted = numstat
          .trim()
          .split("\n")
          .reduce((s, l) => s + Number(l.split("\t")[0]) + Number(l.split("\t")[1]), 0);
        expect({ id: c.id, lines: c.changedLines }).toEqual({ id: c.id, lines: counted });
        const extras = (c.extras ?? []).map((x, k) => ({ ...x, id: `extra ${k + 1}`, alt: undefined }));
        const roots = (c.threads ?? []).filter((t) => t.id === t.root).map((t) => ({ ...t, id: `thread ${t.id}`, alt: undefined }));
        for (const p of [...c.bugs, ...c.traps, ...extras, ...roots])
          for (const [i, s] of [p, ...(p.alt ?? [])].entries()) {
            if (!s.path || !s.lines || s.side !== "new") throw new Error(`${c.id} ${p.id}: no new-side lines.`);
            const text = (await repo.show(repo.head, s.path)).split("\n");
            const lines = text
              .slice(s.lines[0] - 1, s.lines[1])
              .join("")
              .trim();
            expect({ id: c.id, place: i ? `${p.id} alt ${i}` : p.id, empty: lines === "" }).toEqual({
              id: c.id,
              place: i ? `${p.id} alt ${i}` : p.id,
              empty: false,
            });
          }
        // A reply follows its root and has no place of its own.
        for (const t of c.threads ?? []) {
          const root = c.threads?.find((r) => r.id === t.root);
          if (t.id !== t.root)
            expect({ id: c.id, path: t.path, after: (root?.at ?? Infinity) < t.at }).toEqual({ id: c.id, path: undefined, after: true });
        }
      }
    },
    SLOW,
  );

  test(
    "a run seeds the thread of a case into pr-context.md and its task text into task.md",
    async () => {
      const dir = temp("fake");
      const record = join(dir, "calls.jsonl");
      const scenario = join(dir, "scenario.json");
      writeFileSync(
        scenario,
        JSON.stringify({
          record,
          auth: { loggedIn: true, authMethod: "claude.ai", projectsDirectory: join(dir, "projects") },
          fixture: claudeStream(dir, "eval", "claude-synthetic/review-agent-tree.jsonl", {
            summary: "Fake review.",
            risks: [],
            questions: [],
            coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
            findings: [],
          }),
          delayMs: 1,
        }),
      );
      const ids = ["probe-claim-empty-window", "probe-task-csv-quoting"];
      const out = join(dir, "out");
      const p = Bun.spawn(
        [
          process.execPath,
          "--preload",
          NO_REAL,
          RUN,
          "--set",
          "probe",
          "--cases",
          ids.join(","),
          "--out",
          out,
          "--runner",
          process.execPath,
          FAKE,
          scenario,
        ],
        { cwd: ROOT, env: { ...process.env, REVIEW_LOOP_DATA_DIR: temp("live") }, stdout: "pipe", stderr: "pipe", timeout: SLOW },
      );
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      expect(stderr).toBe("");
      expect(await p.exited).toBe(0);
      for (const id of ids) expect(stdout).toContain(`${id} #1: completed`);
      const [file] = readdirSync(out).filter((f) => f.endsWith(".json"));
      const result = JSON.parse(readFileSync(join(out, file as string), "utf8")) as EvalResult;
      expect(result.set).toBe("probe");
      const calls = readRecords<{ argv: string[]; context?: Record<string, string> }>(record).filter((x) => x.argv.includes("-p"));
      const [claim, task] = cases.filter((c) => ids.includes(c.id));
      const prContext = calls.map((x) => x.context?.["pr-context.md"] ?? "").find((t) => t.includes(CLAIM)) ?? "";
      for (const t of claim?.threads ?? []) expect(prContext).toContain(t.text);
      expect(prContext).toContain("inline comment on src/metrics/latency.ts line 15");
      const taskFile = calls.map((x) => x.context?.["task.md"] ?? "").find(Boolean) ?? "";
      expect(taskFile).toContain("Acceptance criteria:");
      expect(task?.task).toContain("RFC 4180");
      expect(taskFile).toContain("RFC 4180");
    },
    SLOW,
  );
});
