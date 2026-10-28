// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.1 and 6.4 (WP-B2): the size rules, the map check against the base commit, the change plan
// files, the tasks grammar round trip and its parse errors, the size conversion of the files, and step.md of one task. A temp git
// repository serves the map check. No test reaches a forge or the real CLI.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitEnv } from "../../src/server/review/git";
import {
  atLeast,
  checkMap,
  convertDocs,
  type Docs,
  mapLine,
  type Plan,
  parsePlan,
  parseTasks,
  renderDocs,
  sizeFloor,
  stepFile,
  tasksBody,
  toPlan,
} from "../../src/server/tasks/plan";
import { type SpecResult, specResult, stepStrip } from "../../src/shared/task";

for (const m of ["tasks/plan", "review/git"])
  console.log(`plan.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

const root = mkdtempSync(join(tmpdir(), "rl-wpb2-plan-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
const BASE = "c".repeat(40);
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };

const spec = (o: Partial<SpecResult> = {}): SpecResult =>
  specResult.parse({
    title: "Trim names",
    size: "small",
    estimate: { parts: 2, lines: 120, files: 3, modules: ["api", "web"], db: false, api: false, unknowns: [] },
    map: [
      { path: "src/user.ts", line: 12, symbol: "trimName", kind: "change", what: "Trim the name." },
      { path: "src/text.ts", line: 3, symbol: "", kind: "pattern", what: "The same way as trimTitle." },
      { path: "tests/user.test.ts", line: null, kind: "test", what: "Extend the name cases." },
    ],
    change: "Trim spaces at both ends of a user name.\nKeep the inner spaces.",
    parts: [
      {
        n: 1,
        kind: "contract",
        title: "Name type",
        goal: "The name type trims.",
        lines: 40,
        acceptance: [
          { id: "x", text: "A name with outer spaces is trimmed." },
          { id: "y", text: "Inner spaces stay." },
        ],
        tests: [{ test: "tests/user.test.ts", proves: ["x", "y"] }],
        tasks: [
          { id: "a", title: "Trim in the type", files: ["src/user.ts"], run: ["tests/user.test.ts"], done: "The name tests pass." },
          { id: "b", title: "Add the cases", files: [], run: ["tests/user.test.ts"], done: "The new case is red first." },
        ],
      },
      {
        n: 2,
        kind: "part",
        title: "Form",
        goal: "The form shows the trimmed name.",
        lines: 80,
        acceptance: [{ id: "z", text: "The form shows the trimmed name." }],
        tests: [],
        tasks: [
          { id: "c", title: "Show it", files: ["src/form.ts", "src/user.ts"], run: ["tests/form.test.ts"], done: "The form test passes." },
        ],
      },
    ],
    testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
    coverage: NO_COVERAGE,
    ...o,
  });

const planOf = (o: Partial<SpecResult> = {}, missing: boolean[] = []) => toPlan(spec(o), BASE, missing, []);

describe("size rules (spec.md section 6.1, AC-B4)", () => {
  test("a database change is at least medium, with its rule line", () => {
    expect(sizeFloor({ db: true, api: false, lines: 100 }, 400)).toEqual({
      minimum: "medium",
      rules: ["Set to medium: it changes the database."],
    });
    expect(atLeast("small", "medium")).toBe("medium");
  });

  test("an API change is at least medium", () => {
    expect(sizeFloor({ db: false, api: true, lines: 100 }, 400)).toEqual({
      minimum: "medium",
      rules: ["Set to medium: it changes an API."],
    });
  });

  test("an estimate over the line budget is large; the budget is the repository value", () => {
    expect(sizeFloor({ db: false, api: false, lines: 900 }, 400)).toEqual({
      minimum: "large",
      rules: ["Set to large: the estimate is over 400 changed lines."],
    });
    expect(sizeFloor({ db: false, api: false, lines: 400 }, 400).minimum).toBe("small");
    expect(sizeFloor({ db: true, api: false, lines: 500 }, 450).minimum).toBe("large");
    expect(atLeast("large", "medium")).toBe("large");
  });

  test("no rule: small stays small", () => {
    expect(sizeFloor({ db: false, api: false, lines: 1 }, 400)).toEqual({ minimum: "small", rules: [] });
  });
});

describe("the stored plan", () => {
  test("app IDs for tasks and acceptance lines; proves follows the new IDs; commands get proposal IDs and the check timeout", () => {
    const p = planOf();
    expect(p.parts.map((x) => x.tasks.map((t) => t.id))).toEqual([["T1.1", "T1.2"], ["T2.1"]]);
    expect(p.parts[0]?.acceptance.map((a) => a.id)).toEqual(["A1.1", "A1.2"]);
    expect(p.parts[0]?.tests[0]?.proves).toEqual(["A1.1", "A1.2"]);
    expect(p.testing.commands).toEqual([{ id: "new-1", name: "test", kind: "test", argv: ["bun", "test"], timeoutSec: 600 }]);
  });

  test("a command with an empty argument is left out with a coverage line", () => {
    const skipped: string[] = [];
    const p = toPlan(
      spec({ testing: { commands: [{ name: "x", kind: "test", argv: [""] }], services: [], notes: "" } }),
      BASE,
      [],
      skipped,
    );
    expect(p.testing.commands).toEqual([]);
    expect(skipped).toEqual(['The test command "x" is not a valid argument list, so the plan leaves it out.']);
  });
});

describe("rendering (spec.md section 6.4)", () => {
  test("small: one plan.md with the three sections; patterns first in the map; a missing entry carries the mark", () => {
    const docs = renderDocs("ABC-12", "Trim names", "small", planOf({}, [false, false, true]));
    expect(Object.keys(docs)).toEqual(["plan"]);
    const text = docs.plan as string;
    expect(text.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      "# Plan: ABC-12 Trim names",
      "## Integration map",
      "## Change",
      "## Tasks",
      "## Part 1: Name type (kind: contract)",
      "### [ ] T1.1 Trim in the type",
      "### [ ] T1.2 Add the cases",
      "## Part 2: Form (kind: part)",
      "### [ ] T2.1 Show it",
    ]);
    const map = text.slice(text.indexOf("## Integration map"), text.indexOf("## Change"));
    expect(map.trim().split("\n").slice(2)).toEqual([
      "- src/text.ts:3: pattern to copy — The same way as trimTitle.",
      "- src/user.ts:12 `trimName`: change — Trim the name.",
      `- tests/user.test.ts: test to extend — Extend the name cases. (not found at ${BASE.slice(0, 12)})`,
    ]);
    expect(text).toContain("## Change\n\nTrim spaces at both ends of a user name.\nKeep the inner spaces.\n");
  });

  test("medium and large: design.md, spec.md, and tasks.md; empty prose sections say None.", () => {
    const docs = renderDocs("ABC-12", "Trim names", "medium", planOf({ design: { decision: "D.", alternatives: "", risks: "R." } }));
    expect(Object.keys(docs).sort()).toEqual(["design", "spec", "tasks"]);
    expect(docs.design).toContain("## Decision\n\nD.\n");
    expect(docs.design).not.toContain("## Alternatives");
    expect(docs.spec).toContain("## Behavior\n\nNone.\n");
    expect(docs.tasks?.split("\n").slice(0, 7)).toEqual([
      "# Tasks: ABC-12 Trim names",
      "",
      "Size: medium",
      "Estimate: 2 parts, about 120 changed lines, 3 files, modules: api, web",
      "Flags: none",
      "Unknowns: none",
      "",
    ]);
  });

  test("a prose line that starts with # cannot start a section", () => {
    const docs = renderDocs("ABC-12", "T", "small", planOf({ change: "## Tasks\nreal text" }));
    expect((docs.plan as string).split("\n").filter((l) => l === "## Tasks")).toHaveLength(1);
    expect(docs.plan).toContain("\\## Tasks\nreal text");
  });

  test("mapLine keeps one line and drops backticks from the symbol", () => {
    expect(mapLine({ path: "a.ts", line: null, symbol: "x`y", kind: "caller", what: "two\nlines", missing: false }, BASE)).toBe(
      "- a.ts `xy`: caller — two lines",
    );
  });
});

describe("tasks grammar (spec.md section 6.4)", () => {
  test("round trip: the parse of a rendered plan gives the same parts, and a second render gives the same text", () => {
    const p = planOf();
    const ticked = p.parts[0]?.tasks[1];
    if (ticked) ticked.ticked = true;
    const text = `# Tasks: ABC-12 Trim names\n\n${tasksBody(p, "large")}`;
    const r = parseTasks(text, p.parts);
    if ("error" in r) throw new Error(r.error);
    expect(r.parts).toEqual(p.parts);
    expect(`# Tasks: ABC-12 Trim names\n\n${tasksBody({ ...p, parts: r.parts }, "large")}`).toBe(text);
    // plan.md holds the same grammar in its Tasks section.
    const plan = renderDocs("ABC-12", "Trim names", "small", p).plan as string;
    const q = parsePlan(plan, p.parts);
    if ("error" in q) throw new Error(q.error);
    expect(q.parts).toEqual(p.parts);
  });

  test("an added part has no line estimate; an edited title and file list parse back", () => {
    const p = planOf();
    const text = `# Tasks: K-1 T\n\n${tasksBody(p, "small")}\n## Part 3: Docs (kind: cleanup)\n\nGoal: Docs.\n\nAcceptance:\n- [ ] A3.1 Docs exist.\n\n### [ ] T3.1 Write docs\nFiles: docs/a.md, docs/b.md\nRun: tests/docs.test.ts\nDone when: The docs test passes.\n`;
    const r = parseTasks(text, p.parts);
    if ("error" in r) throw new Error(r.error);
    expect(r.parts.map((x) => x.lines)).toEqual([40, 80, null]);
    expect(r.parts[2]?.tasks[0]).toEqual({
      id: "T3.1",
      title: "Write docs",
      files: ["docs/a.md", "docs/b.md"],
      run: ["tests/docs.test.ts"],
      done: "The docs test passes.",
      ticked: false,
    });
  });

  test('a task without "Done when" names the line of its heading', () => {
    const text = `# Tasks: K-1 T\n\n${tasksBody(planOf(), "small")}`.replace("Done when: The new case is red first.\n", "");
    const line = text.split("\n").indexOf("### [ ] T1.2 Add the cases") + 1;
    expect(parseTasks(text, [])).toEqual({ line, error: `Fix line ${line} of tasks.md: a task needs a "Done when" line.` });
  });

  test("parse errors name the line: header, part heading, task heading, task fields, and an unknown line", () => {
    const good = `# Tasks: K-1 T\n\n${tasksBody(planOf(), "small")}`;
    const at = (needle: string) => good.split("\n").indexOf(needle) + 1;
    const cases: [string, string, string][] = [
      ["Size: small", "Size: tiny", 'the "Size" line must say small, medium, or large'],
      ["Flags: none", "Flags: maybe", 'the "Flags" line must say db, api, "db, api", or none'],
      ["## Part 2: Form (kind: part)", "## Part 2: Form", 'a part heading must look like "## Part 1: <title> (kind: part)"'],
      ["### [ ] T2.1 Show it", "### T2.1 Show it", 'a task heading must look like "### [ ] T1.1 <title>"'],
      ["### [ ] T2.1 Show it", "### [ ] T1.9 Show it", "task T1.9 must be in part 1"],
      ["Run: tests/form.test.ts", "Owner: me", 'a task has only the lines "Files", "Run", and "Done when"'],
      ["Goal: The form shows the trimmed name.", "Notes: free text", "the app cannot read this line"],
    ];
    for (const [from, to, error] of cases) {
      const r = parseTasks(good.replace(from, to), []);
      expect(r).toEqual({ line: at(from), error: `Fix line ${at(from)} of tasks.md: ${error}.` });
    }
    expect(parseTasks(good.replace("Unknowns: none\n", ""), [])).toEqual({
      line: at("## Part 1: Name type (kind: contract)") - 1,
      error: `Fix line ${at("## Part 1: Name type (kind: contract)") - 1} of tasks.md: the plan needs a "Unknowns" line before the first part.`,
    });
    expect(parseTasks(good.replace("# Tasks: K-1 T", "# Plan"), [])).toMatchObject({ line: 1 });
  });

  test("plan.md needs its three sections in order", () => {
    const plan = renderDocs("K-1", "T", "small", planOf()).plan as string;
    const r = parsePlan(plan.replace("## Change", "## Changes"), []);
    expect("error" in r && r.error).toContain('plan.md: the file needs the "## Change" section');
  });
});

describe("size change of the files", () => {
  const docsOf = (size: "small" | "medium", p: Plan): Docs => ({
    ...renderDocs("K-1", "T", size, p),
    version: 1,
    parsed: p,
    approved: false,
  });

  test("small to medium: the edited Change text becomes the Decision, and the tasks keep their edits", () => {
    const p = planOf();
    const d = docsOf("small", p);
    d.plan = (d.plan as string).replace("Keep the inner spaces.", "Keep the inner spaces. Edited.").replace("Show it", "Show it now");
    const out = convertDocs("K-1", "T", "small", "medium", d);
    expect(Object.keys(out).sort()).toEqual(["design", "spec", "tasks"]);
    expect(out.design).toContain("## Decision\n\nTrim spaces at both ends of a user name.\nKeep the inner spaces. Edited.\n");
    expect(out.tasks).toContain("Size: medium");
    expect(out.tasks).toContain("### [ ] T2.1 Show it now");
    const r = parseTasks(out.tasks as string, p.parts);
    expect("parts" in r).toBe(true);
  });

  test("medium to small and back keeps the Decision; medium to large changes the Size line only", () => {
    const p = planOf({ design: { decision: "Decide it.", alternatives: "", risks: "" } });
    const m = docsOf("medium", p);
    const small = convertDocs("K-1", "T", "medium", "small", m);
    expect(small.plan).toContain("## Change\n\nDecide it.\n");
    expect("parts" in parsePlan(small.plan as string, p.parts)).toBe(true);
    const large = convertDocs("K-1", "T", "medium", "large", m);
    expect(large.tasks).toBe((m.tasks as string).replace("Size: medium", "Size: large"));
    expect(large.design).toBe(m.design);
  });
});

// A bare repository with one commit of files.
async function mapRepo(name: string, files: Record<string, string>) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const repo = join(root, `${name}.git`);
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_INDEX_FILE: join(root, `${name}.index`),
  };
  const g = async (args: string[]) => (await git(["--git-dir", repo, ...args], { env })).trim();
  await git(["init", "-q", "--bare", "--template=", repo], { env });
  for (const [i, [path, text]] of Object.entries(files).entries()) {
    const f = join(root, `${name}-${i}`);
    writeFileSync(f, text);
    await g(["update-index", "--add", "--cacheinfo", `100644,${await g(["hash-object", "-w", f])},${path}`]);
  }
  return { repo, empty, base: await g(["commit-tree", await g(["write-tree"]), "-m", "base"]) };
}
// src/a.ts (3 lines) and README.md (2 lines, no final newline) at base.
const ready = mapRepo("map", { "src/a.ts": "a\nb\nc\n", "README.md": "a\nb" });
const sub = mapRepo("sub", { "lib.ts": "x\ny\n" });

describe("map check (spec.md section 6.4)", () => {
  test("an existing file and line passes; a missing path or a line past the end fails; a folder takes no line", async () => {
    const { repo, empty, base } = await ready;
    const map = [
      { path: "src/a.ts", line: 3 },
      { path: "src/a.ts", line: 4 },
      { path: "README.md", line: 2 },
      { path: "README.md", line: 3 },
      { path: "src/gone.ts", line: null },
      { path: "src", line: null },
      { path: "src", line: 1 },
      { path: "./src/a.ts", line: 1 },
      { path: "../src/a.ts", line: 1 },
      { path: "src/a.ts\nx", line: null },
    ];
    expect(await checkMap(map, base, repo, gitEnv(empty))).toEqual([false, true, false, true, true, false, true, false, true, true]);
  });

  test("spec.md section 6.16.5: an entry under a submodule or an added repository is checked in that repository", async () => {
    const { repo, empty, base } = await ready;
    const s = await sub;
    const nested = [
      { path: "lib", cache: s.repo, commit: s.base },
      { path: "../repos/P/s", cache: s.repo, commit: s.base },
    ];
    const map = [
      { path: "lib/lib.ts", line: 2 },
      { path: "lib/lib.ts", line: 3 },
      { path: "lib", line: null },
      { path: "lib/", line: 1 },
      { path: "../repos/P/s/lib.ts", line: 1 },
      { path: "..\\repos\\P\\s\\lib.ts", line: null },
      { path: "lib/src/a.ts", line: null },
      { path: "src/a.ts", line: 3 },
      { path: "libx/lib.ts", line: null },
      { path: "../repos/P/s/../../x/lib.ts", line: null },
      { path: "../repos/P/other/lib.ts", line: null },
    ];
    expect(await checkMap(map, base, repo, gitEnv(empty), nested)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      true,
      false,
      true,
      true,
      true,
    ]);
    // Without the other repositories, every entry outside the main repository fails.
    expect(await checkMap(map.slice(0, 1), base, repo, gitEnv(empty))).toEqual([true]);
  });

  test("the plan keeps a failed entry with its mark, so it counts", async () => {
    const { repo, empty, base } = await ready;
    const r = spec();
    const missing = await checkMap(r.map, base, repo, gitEnv(empty));
    expect(missing).toEqual([true, true, true]);
    const p = toPlan(r, base, missing, []);
    expect(p.map.filter((e) => e.missing)).toHaveLength(3);
  });
});

describe("step.md (spec.md sections 6.4 and 6.7)", () => {
  test("step.md holds only its own task, the acceptance of its part, and the map entries of its files", () => {
    const p = planOf();
    const f = stepFile(p, "T1.1", 2);
    expect(f?.name).toBe("step.md");
    const text = f?.text ?? "";
    expect(text).toContain("- Task: T1.1 Trim in the type");
    expect(text).toContain("- Attempt: 2");
    expect(text).toContain("- A1.1 A name with outer spaces is trimmed.");
    expect(text).toContain("Files: src/user.ts");
    expect(text).toContain("- src/user.ts:12 `trimName`: change — Trim the name.");
    for (const other of ["T1.2", "Add the cases", "T2.1", "Show it", "A2.1", "src/text.ts", "src/form.ts"])
      expect(text).not.toContain(other);
    expect(stepFile(p, "T9.9", 1)).toBeNull();
  });
});

describe("step strip (spec.md section 6.12)", () => {
  test("small, medium, and large strips with the current step", () => {
    const part = (state: "merged" | "pr_open" | "planned") => ({ kind: "part" as const, state });
    expect(stepStrip({ size: null, state: "interview", stoppedFrom: null, parts: [] })).toEqual({
      steps: ["Questions", "Plan", "Build", "Done"],
      current: 0,
    });
    expect(stepStrip({ size: "small", state: "implementing", stoppedFrom: null, parts: [] }).current).toBe(2);
    expect(stepStrip({ size: "medium", state: "spec_pr_open", stoppedFrom: null, parts: [] })).toEqual({
      steps: ["Questions", "Plan", "Spec review", "Build", "Done"],
      current: 2,
    });
    expect(
      stepStrip({
        size: "large",
        state: "implementing",
        stoppedFrom: null,
        parts: [part("merged"), part("pr_open"), part("planned"), part("planned")],
      }),
    ).toEqual({ steps: ["Questions", "Plan", "Spec review", "Build parts (2 of 4)", "Done"], current: 3 });
    expect(stepStrip({ size: "small", state: "stopped", stoppedFrom: "spec_draft", parts: [] }).current).toBe(1);
    expect(stepStrip({ size: "small", state: "failed", stoppedFrom: null, parts: [] }).current).toBe(-1);
    expect(stepStrip({ size: "small", state: "done", stoppedFrom: null, parts: [] }).current).toBe(3);
  });
});
