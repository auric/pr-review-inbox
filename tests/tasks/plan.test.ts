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
  checkLines,
  checkMap,
  checkPlan,
  convertDocs,
  type Docs,
  mapLine,
  type Plan,
  parsePlan,
  parseTasks,
  renderDocs,
  sizeFloor,
  stepFile,
  symbolName,
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

  test("spec.md section 6.3: setup gets 60 min by default; a proposed time limit is capped to 4 h and keeps its reason", () => {
    const testing = specResult.shape.testing.parse({
      commands: [
        { name: "venv", kind: "setup", argv: ["python", "-m", "venv", ".venv"] },
        { name: "deps", kind: "setup", argv: ["conan", "install", "."], timeoutSec: 99_999, timeoutReason: " Downloads the packages. " },
        { name: "test", kind: "test", argv: ["bun", "test"], timeoutReason: "No limit, so no reason." },
        { name: "slow", kind: "test", argv: ["ctest"], timeoutSec: 0.2, timeoutReason: "Too short." },
      ],
      services: [],
      notes: "",
    });
    expect(planOf({ testing }).testing.commands.map((c) => [c.name, c.timeoutSec, c.timeoutReason])).toEqual([
      ["venv", 3600, undefined],
      ["deps", 14_400, "Downloads the packages."],
      ["test", 600, undefined],
      ["slow", 1, "Too short."],
    ]);
  });

  test("a command with an empty argument is left out with a coverage line", () => {
    const skipped: string[] = [];
    const p = toPlan(
      spec({
        testing: {
          commands: [{ name: "x", kind: "test", argv: [""], timeoutSec: null, timeoutReason: "" }],
          services: [],
          notes: "",
          allow: [],
        },
      }),
      BASE,
      [],
      skipped,
    );
    expect(p.testing.commands).toEqual([]);
    expect(skipped).toEqual(['The test command "x" is not a valid argument list, so the plan leaves it out.']);
  });

  test("spec.md section 6.21 (D2): a proposed command pattern that fails allowProblem becomes a coverage line; the others stay once", () => {
    const skipped: string[] = [];
    const allow = [
      { pattern: " ssh build1 * ", reason: "The remote build." },
      { pattern: "ssh build1 *", reason: "Twice." },
      { pattern: "git push *", reason: "Push." },
      { pattern: "curl https://jira.example.test/x", reason: "Tracker." },
    ];
    const p = toPlan(spec({ testing: { ...spec().testing, allow } }), BASE, [], skipped, ["jira.example.test"]);
    expect(p.testing.allow).toEqual([{ pattern: "ssh build1 *", reason: "The remote build." }]);
    expect(skipped).toEqual([
      'The plan leaves out the command pattern "git push *". Claude cannot run git commands.',
      'The plan leaves out the command pattern "curl https://jira.example.test/x". A pattern cannot name the Bitbucket or Jira host.',
    ]);
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
      "## Contracts and risks",
      "## Change",
      "## Tasks",
      "## Part 1: Name type (kind: contract)",
      "### [ ] T1.1 Trim in the type",
      "### [ ] T1.2 Add the cases",
      "## Part 2: Form (kind: part)",
      "### [ ] T2.1 Show it",
    ]);
    expect(text).toContain("## Contracts and risks\n\nNone.\n\n## Change");
    const map = text.slice(text.indexOf("## Integration map"), text.indexOf("## Contracts and risks"));
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

  test("spec.md section 6.22.2: mapLine marks a symbol that the file does not hold and a symbol far from its line", () => {
    const e = { path: "a.ts", line: 9, symbol: "Foo.bar", kind: "change" as const, what: "W.", missing: false };
    expect(mapLine({ ...e, mark: "absent" }, BASE)).toBe("- a.ts:9 `Foo.bar`: change — W. (`bar` is not in this file)");
    expect(mapLine({ ...e, mark: "far" }, BASE)).toBe("- a.ts:9 `Foo.bar`: change — W. (`bar` is not near this line)");
    expect(mapLine({ ...e, missing: true }, BASE)).toBe(`- a.ts:9 \`Foo.bar\`: change — W. (not found at ${BASE.slice(0, 12)})`);
  });

  // AC-B94: the section follows the map in plan.md and design.md. design.md has Rollout in place of Risks and rollout.
  const CONTRACTS: Partial<SpecResult> = {
    contracts: [
      { name: "POST /api/`x`", path: "src/routes.ts", change: "change", users: "the web form", compat: "The old field stays.", part: 1 },
      { name: "newFlag", path: "", change: "add", users: "none yet", compat: "New.", part: null },
    ],
    risks: [{ text: "A slow query.", check: "tests/perf.test.ts", part: 2 }],
  };
  const SECTION = [
    "## Contracts and risks",
    "",
    `- Contract \`POST /api/x\` (change) in src/routes.ts (not found at ${BASE.slice(0, 12)}): users: the web form. Compat: The old field stays.`,
    "- Contract `newFlag` (add): users: none yet. Compat: New.",
    "- Risk: A slow query. Caught by: tests/perf.test.ts",
    "",
  ].join("\n");
  const withContracts = (o: Partial<SpecResult> = {}) => {
    const p = planOf({ ...CONTRACTS, ...o });
    for (const c of p.contracts ?? []) c.missing = c.path === "src/routes.ts";
    return p;
  };

  test("AC-B94: plan.md shows one line per contract, then per risk, right after the map", () => {
    const text = renderDocs("ABC-12", "Trim names", "small", withContracts()).plan as string;
    expect(
      text
        .split("\n")
        .filter((l) => l.startsWith("## "))
        .slice(0, 4),
    ).toEqual(["## Integration map", "## Contracts and risks", "## Change", "## Tasks"]);
    expect(text).toContain(`\n${SECTION}\n## Change\n`);
    expect("parts" in parsePlan(text, [])).toBe(true);
  });

  test("AC-B94: design.md shows the section after the map and the Rollout section with design.risks", () => {
    const docs = renderDocs(
      "ABC-12",
      "Trim names",
      "medium",
      withContracts({ design: { decision: "D.", alternatives: "A.", risks: "Flag x." } }),
    );
    const design = docs.design as string;
    expect(design.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## Integration map",
      "## Contracts and risks",
      "## Decision",
      "## Alternatives",
      "## Rollout",
    ]);
    expect(design).toContain(`\n${SECTION}\n## Decision\n`);
    expect(design).toContain("## Rollout\n\nFlag x.\n");
    expect(design).not.toContain("Risks and rollout");
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

  test("AC-B94: the edited Contracts and risks text moves from small to medium and back", () => {
    const p = planOf({ risks: [{ text: "A slow query.", check: "tests/perf.test.ts", part: null }] });
    const d = docsOf("small", p);
    expect(d.plan).toContain("## Contracts and risks\n\n- Risk: A slow query. Caught by: tests/perf.test.ts\n");
    d.plan = (d.plan as string).replace("- Risk: A slow query.", "- Risk: A slow query. Edited.");
    const medium = convertDocs("K-1", "T", "small", "medium", d);
    expect(medium.design).toContain("## Integration map\n\n- src/text.ts:3");
    expect(medium.design).toContain("## Contracts and risks\n\n- Risk: A slow query. Edited. Caught by: tests/perf.test.ts\n\n## Decision");
    const small = convertDocs("K-1", "T", "medium", "small", { ...d, ...medium });
    expect(small.plan).toContain("## Contracts and risks\n\n- Risk: A slow query. Edited. Caught by: tests/perf.test.ts\n\n## Change");
    expect("parts" in parsePlan(small.plan as string, p.parts)).toBe(true);
    // A plan file stored before the section exists gets the section from the plan.
    const old = { ...d, plan: (d.plan as string).replace(/## Contracts and risks\n\n.*\n\n/, "") };
    expect(old.plan).not.toContain("Contracts and risks");
    expect(convertDocs("K-1", "T", "small", "medium", old).design).toContain("## Contracts and risks\n\n- Risk: A slow query. Caught by:");
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

// src/a.ts has 400 lines. A name sits at known lines. Line 350 holds names that only contain specRun.
const A_LINES = Array.from({ length: 400 }, (_, i) => `// line ${i + 1}`);
const put = (n: number, s: string) => {
  A_LINES[n - 1] = s;
};
put(120, "export function specRun() {");
put(188, "const moved = 1;");
for (const n of [40, 200, 310]) put(n, "many();");
put(350, "specRunner(); _specRun; specRun$; $specRun; specRun1;");
put(360, "const $store = 1;");
for (let n = 380; n < 392; n++) put(n, "rep();");
const checked = mapRepo("checks", {
  "src/a.ts": `${A_LINES.join("\n")}\n`,
  "src/b.ts": "export const b = 1;\n",
  "docs/guide.md": "# Guide\n",
  // git reads a NUL byte in the first 8000 bytes as binary. big.txt has its NUL after them.
  "bin/data.bin": "\0\u0001 absentInBin\n",
  "big.txt": `${"x".repeat(8100)}\n\0\n`,
});
const AT = (base: string) => base.slice(0, 12);
const entry = (path: string, line: number | null, symbol: string) => ({ path, line, symbol, kind: "change" as const, what: "W." });
const task = (files: string[]) => ({ id: "t", title: "Do it", files, run: ["tests/a.test.ts"], done: "It passes." });
const part = (n: number, tasks: string[][]) => ({
  n,
  kind: "part" as const,
  title: `P${n}`,
  goal: "G.",
  lines: 10,
  acceptance: [{ id: "x", text: "It works." }],
  tests: [],
  tasks: tasks.map(task),
  keys: [],
  start: "stack" as const,
  after: null,
  startReason: "",
});
const run = async (o: Partial<SpecResult>, nested: { path: string; cache: string; commit: string }[] = []) => {
  const { repo, empty, base } = await checked;
  const r = spec({ map: [entry("src/a.ts", null, "")], parts: [part(1, [["src/a.ts"]])], ...o });
  return { r, base, app: await checkPlan(r, "specs/ABC-12/", base, repo, gitEnv(empty), nested) };
};

describe("app checks (spec.md section 6.22.2)", () => {
  test("the symbol name: plain, called, dotted, and backticked names give a name; a route, prose, or a type does not", () => {
    for (const [symbol, name] of [
      ["specRun", "specRun"],
      ["specRun()", "specRun"],
      ["createTaskService.specRun", "specRun"],
      ["Foo::bar", "bar"],
      ["Foo#bar", "bar"],
      [" `$store` ", "$store"],
      ["POST /api/x", null],
      ["the spec run", null],
      ["specRun(db, t)", null],
      ["Map<string>", null],
      ["", null],
    ] as const)
      expect([symbol, symbolName(symbol)]).toEqual([symbol, name]);
  });

  test("AC-B91: the symbol rows of the table, the name rule, a folder, a binary file, a missing path, and the 10-line cap", async () => {
    const { base, app } = await run({
      map: [
        entry("src/a.ts", 123, "specRun"),
        entry("src/a.ts", 120, "moved"),
        entry("src/a.ts", null, "Foo::moved"),
        entry("src/a.ts", 120, "many"),
        entry("src/a.ts", null, "many"),
        entry("src/a.ts", 10, "absentName"),
        entry("src/a.ts", null, "absentName"),
        entry("src/a.ts", 350, "createTaskService.specRun"),
        entry("src/a.ts", 120, "`specRun()`"),
        entry("src/a.ts", 5, "POST /api/x"),
        entry("src/a.ts", 5, "the spec run"),
        entry("src", null, "absentName"),
        entry("bin/data.bin", 1, "absentInBin"),
        entry("big.txt", 1, "needleBig"),
        entry("src/gone.ts", 3, "absentName"),
        entry("src/a.ts", null, "$store"),
        entry("src/a.ts", 100, "rep"),
      ],
    });
    expect(app.checks.map((c) => [c.id, c.severity, c.line, c.text])).toEqual([
      ["a1", "major", 10, "Map line 6: `absentName` is not in src/a.ts."],
      ["a2", "major", null, "Map line 7: `absentName` is not in src/a.ts."],
      ["a3", "major", 1, "Map line 14: `needleBig` is not in big.txt."],
      ["a4", "major", 3, `Map line 15: src/gone.ts:3 is not found at ${AT(base)}.`],
      ["a5", "minor", 120, "Map line 4: `many` is not near line 120 of src/a.ts. It is at lines 40, 200, and 310."],
      [
        "a6",
        "minor",
        100,
        "Map line 17: `rep` is not near line 100 of src/a.ts. It is at lines 380, 381, 382, 383, 384, 385, 386, 387, 388, 389, and 2 more lines.",
      ],
      ["a7", "info", 188, "Map line 2: `moved` is at line 188, not 120. The app changed the line."],
      ["a8", "info", 188, "Map line 3: `moved` is at line 188. The app set the line."],
      ["a9", "info", 120, "Map line 8: `specRun` is at line 120, not 350. The app changed the line."],
      ["a10", "info", 360, "Map line 16: `$store` is at line 360. The app set the line."],
    ]);
    expect(app.checks[0]).toMatchObject({
      part: null,
      path: "src/a.ts",
      fix: "Name the file that holds `absentName`, or a symbol of src/a.ts.",
    });
    expect(app.checks[4]?.fix).toBe("Give the line that the change needs.");
    expect(app.checks[6]?.fix).toBe("");
    expect(app.entries).toEqual([
      { line: 123 },
      { line: 188, from: 120 },
      { line: 188 },
      { line: 120, mark: "far" },
      { line: null },
      { line: 10, mark: "absent" },
      { line: null, mark: "absent" },
      { line: 120, from: 350 },
      { line: 120 },
      { line: 5 },
      { line: 5 },
      { line: null },
      { line: 1 },
      { line: 1, mark: "absent" },
      { line: 3 },
      { line: 360 },
      { line: 100, mark: "far" },
    ]);
    expect(app.missing.filter(Boolean)).toHaveLength(1);
    expect(app.more).toBe(0);
    // Only majors and minors give coverage lines.
    expect(checkLines(app)).toEqual(app.checks.slice(0, 6).map((c) => c.text));
  });

  test("AC-B91: the plan takes the moved lines and the marks; plan.md and step.md show them", async () => {
    const { r, base, app } = await run({
      map: [entry("src/a.ts", 120, "moved"), entry("src/a.ts", 120, "many"), entry("src/a.ts", 10, "absentName")],
    });
    const p = toPlan(r, base, app, []);
    expect(p.checks).toEqual(app.checks);
    expect(p.map.map((e) => [e.line, e.from, e.mark, e.missing])).toEqual([
      [188, 120, undefined, false],
      [120, undefined, "far", false],
      [10, undefined, "absent", false],
    ]);
    const text = renderDocs("ABC-12", "T", "small", p).plan as string;
    expect(text).toContain("- src/a.ts:188 `moved`: change — W.\n");
    expect(text).toContain("- src/a.ts:120 `many`: change — W. (`many` is not near this line)\n");
    expect(text).toContain("- src/a.ts:10 `absentName`: change — W. (`absentName` is not in this file)\n");
    expect(stepFile(p, "T1.1", 1)?.text).toContain("- src/a.ts:188 `moved`: change — W.");
  });

  test("AC-B92: task files: not on the map, a folder entry, a new file, a new folder, the spec folder, and a nested repository", async () => {
    const s = await sub;
    const o: Partial<SpecResult> = {
      map: [entry("src/a.ts", null, ""), entry("docs", null, "")],
      parts: [
        part(1, [["src/a.ts", "src/new.ts"], ["src/b.ts", "docs/guide.md", "specs/ABC-12/notes.md"], ["src/fresh/c.ts"]]),
        part(2, [["./src/b.ts", "lib/lib.ts", "lib/new.ts"]]),
      ],
    };
    const { base, app } = await run(o, [{ path: "lib", cache: s.repo, commit: s.base }]);
    expect(app.checks.map((c) => [c.id, c.severity, c.part, c.path, c.text, c.fix])).toEqual([
      ["a1", "major", null, "src/b.ts", "T1.2 and T2.1 change src/b.ts, which the map does not list.", "Add a map entry for src/b.ts."],
      ["a2", "major", 2, "lib/lib.ts", "T2.1 changes lib/lib.ts, which the map does not list.", "Add a map entry for lib/lib.ts."],
      [
        "a3",
        "minor",
        1,
        "src/fresh/c.ts",
        `T1.3 creates src/fresh/c.ts in a folder that does not exist at ${AT(base)}.`,
        "Check the path. A new folder is correct only when the plan needs one.",
      ],
    ]);
    // Without the submodule, lib/lib.ts is a new file in a folder that the main repository does not have.
    const main = await run(o);
    expect(main.app.checks.filter((c) => c.path.startsWith("lib/")).map((c) => [c.severity, c.text])).toEqual([
      ["minor", `T2.1 creates lib/lib.ts in a folder that does not exist at ${AT(base)}.`],
      ["minor", `T2.1 creates lib/new.ts in a folder that does not exist at ${AT(base)}.`],
    ]);
    // A folder entry with a line covers no file.
    const lined = await run({ ...o, map: [entry("src/a.ts", null, ""), entry("docs", 1, "")] });
    expect(lined.app.checks.map((c) => c.text)).toContain("T1.2 changes docs/guide.md, which the map does not list.");
  });

  test("AC-B92: one problem per path names at most 3 task IDs", async () => {
    const { app } = await run({ parts: [part(1, [["src/b.ts"], ["src/b.ts"], ["src/b.ts"], ["src/b.ts", "src/b.ts"]])] });
    expect(app.checks.map((c) => c.text)).toEqual(["T1.1, T1.2, T1.3, and 1 more task change src/b.ts, which the map does not list."]);
  });

  test("AC-B95: a contract path that is not found is major; db or api with no contract is minor", async () => {
    const { r, base, app } = await run({
      estimate: { ...spec().estimate, db: true },
      contracts: [
        { name: "POST /api/x", path: "src/routes.ts", change: "change", users: "U", compat: "C", part: 1 },
        { name: "b", path: "src/b.ts", change: "change", users: "U", compat: "C", part: null },
        { name: "newFlag", path: "", change: "add", users: "U", compat: "C", part: null },
      ],
    });
    expect(app.contracts).toEqual([true, false, false]);
    expect(app.checks).toEqual([
      {
        id: "a1",
        severity: "major",
        part: 1,
        path: "src/routes.ts",
        line: null,
        text: `Contract POST /api/x: src/routes.ts is not found at ${AT(base)}.`,
        fix: "Name the file that defines it, or leave the path empty for a new contract.",
      },
    ]);
    expect(toPlan(r, base, app, []).contracts?.map((c) => c.missing)).toEqual([true, false, false]);
    const none = await run({ estimate: { ...spec().estimate, api: true } });
    expect(none.app.checks).toEqual([
      {
        id: "a1",
        severity: "minor",
        part: null,
        path: "",
        line: null,
        text: "The plan changes the database or an API, but it lists no contract.",
        fix: "List each changed table, route, or schema in contracts.",
      },
    ]);
  });

  test("the IDs follow major, minor, info, and inside one severity the map, the tasks, then the contracts", async () => {
    const { app } = await run({
      map: [entry("src/a.ts", 120, "moved"), entry("src/a.ts", 120, "many"), entry("src/gone.ts", null, "")],
      parts: [part(1, [["src/a.ts", "src/b.ts", "src/fresh/c.ts"]])],
      contracts: [{ name: "x", path: "src/routes.ts", change: "remove", users: "U", compat: "C", part: null }],
    });
    expect(app.checks.map((c) => [c.id, c.severity, c.path])).toEqual([
      ["a1", "major", "src/gone.ts"],
      ["a2", "major", "src/b.ts"],
      ["a3", "major", "src/routes.ts"],
      ["a4", "minor", "src/a.ts"],
      ["a5", "minor", "src/fresh/c.ts"],
      ["a6", "info", "src/a.ts"],
    ]);
  });

  test("a plan keeps 40 app checks; the coverage counts the rest", async () => {
    const { app } = await run({
      map: Array.from({ length: 40 }, (_, i) => entry(`src/gone${i}.ts`, null, "")),
      parts: [part(1, [Array.from({ length: 5 }, (_, i) => `src/new${i}/x.ts`)])],
    });
    expect(app.checks).toHaveLength(40);
    expect(app.checks.at(-1)).toMatchObject({ id: "a40", severity: "major", path: "src/gone39.ts" });
    expect(app.more).toBe(5);
    const lines = checkLines(app);
    expect(lines).toHaveLength(41);
    expect(lines.at(-1)).toBe("The app found 5 more problems in the plan.");
    expect(checkLines({ checks: [], more: 1 })).toEqual(["The app found 1 more problem in the plan."]);
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
