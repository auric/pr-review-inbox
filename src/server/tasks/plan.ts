// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The plan of a task (docs/plans/review-v2/spec.md sections 6.1 and 6.4): the size rules, the map check against the base commit, the
// plan files in the change plan format, the parse of the tasks grammar, the size conversion of the files, and step.md of one task.
import { oneLine } from "../../shared/consult";
import {
  CHECK_TIMEOUT_SEC,
  LARGE_REPOS_TEXT,
  type SpecResult,
  sizeRank,
  type TaskCommand,
  type TaskDoc,
  type TaskSize,
  taskCommand,
} from "../../shared/task";
import { git } from "../review/git";
import { repoPath } from "../review/validate";
import type { ContextFile } from "../review/workspace";

// ---------- Size rules (spec.md section 6.1) ----------

// The lowest size that the app rules allow, and the line of each rule that applies. The rules apply to the user's pick too.
export function sizeFloor(e: Pick<SpecResult["estimate"], "db" | "api" | "lines">, budget: number): { minimum: TaskSize; rules: string[] } {
  const rules: string[] = [];
  if (e.db) rules.push("Set to medium: it changes the database.");
  if (e.api) rules.push("Set to medium: it changes an API.");
  const large = e.lines > budget;
  if (large) rules.push(`Set to large: the estimate is over ${budget} changed lines.`);
  return { minimum: large ? "large" : e.db || e.api ? "medium" : "small", rules };
}

export const atLeast = (size: TaskSize, minimum: TaskSize): TaskSize => (sizeRank(size) >= sizeRank(minimum) ? size : minimum);

// spec.md section 6.16.5, Size: a large plan stays in one repository. It names another one when the task has an added repository or a
// task of the plan lists a file inside a submodule folder. repos: the task repositories with their paths from the main root.
export function largeRepoProblem(
  size: TaskSize,
  parts: readonly { tasks: readonly { files: readonly string[] }[] }[],
  repos: readonly { role: string; path: string | null }[],
): string | null {
  if (size !== "large") return null;
  const subs = repos.filter((r) => r.role === "submodule" && r.path).map((r) => `${r.path}/`);
  const named = parts.some((p) => p.tasks.some((t) => t.files.some((f) => subs.some((s) => (repoPath(f) ?? f).startsWith(s)))));
  return named || repos.some((r) => r.role === "added") ? LARGE_REPOS_TEXT : null;
}

// ---------- The stored plan (task.docs_json.parsed) ----------

export type MapEntry = SpecResult["map"][number] & { missing: boolean };
export type PlanTask = { id: string; title: string; files: string[]; run: string[]; done: string; ticked: boolean };
export type PartKindName = SpecResult["parts"][number]["kind"];
// lines: the estimate of Claude for the part. null for a part that the user added.
export type PlanPart = {
  n: number;
  kind: PartKindName;
  title: string;
  goal: string;
  lines: number | null;
  acceptance: { id: string; text: string; ticked: boolean }[];
  tests: { test: string; proves: string[] }[];
  tasks: PlanTask[];
};
// proposed: the size of Claude. base: the commit of the map check. commands: the proposed commands with the IDs "new-1" and up.
export type Plan = {
  proposed: TaskSize;
  estimate: SpecResult["estimate"];
  base: string;
  map: MapEntry[];
  change: string;
  design: SpecResult["design"];
  spec: SpecResult["spec"];
  parts: PlanPart[];
  testing: { commands: TaskCommand[]; services: string[]; notes: string };
  flag: SpecResult["flag"];
  questions: string[];
};
// task.docs_json. approved: a medium or large plan waits for its spec PR.
export type Docs = Partial<Record<TaskDoc, string>> & { version: number; parsed: Plan; approved: boolean };

export const NEW_COMMAND = "new-";

// The plan of a checked spec result. missing: the map check of each entry. skipped gets a line for each command that fails the
// taskCommand schema. Task IDs become T<part>.<n> and acceptance IDs A<part>.<n>, as the tasks grammar names them.
export function toPlan(r: SpecResult, base: string, missing: boolean[], skipped: string[]): Plan {
  const parts = r.parts.map((p, pi): PlanPart => {
    const n = pi + 1;
    const ids = new Map(p.acceptance.map((a, i) => [a.id, `A${n}.${i + 1}`]));
    return {
      n,
      kind: p.kind,
      title: p.title,
      goal: p.goal,
      lines: p.lines,
      acceptance: p.acceptance.map((a, i) => ({ id: `A${n}.${i + 1}`, text: a.text, ticked: false })),
      tests: p.tests.map((t) => ({ test: t.test, proves: t.proves.map((id) => ids.get(id) ?? id) })),
      tasks: p.tasks.map((t, i) => ({ id: `T${n}.${i + 1}`, title: t.title, files: t.files, run: t.run, done: t.done, ticked: false })),
    };
  });
  const commands: TaskCommand[] = [];
  for (const c of r.testing.commands) {
    const ok = taskCommand.safeParse({ id: `${NEW_COMMAND}${commands.length + 1}`, ...c, timeoutSec: CHECK_TIMEOUT_SEC });
    if (ok.success) commands.push(ok.data);
    else skipped.push(`The test command "${oneLine(c.name)}" is not a valid argument list, so the plan leaves it out.`);
  }
  return {
    proposed: r.size,
    estimate: r.estimate,
    base,
    map: r.map.map((e, i) => ({ ...e, missing: missing[i] === true })),
    change: r.change,
    design: r.design,
    spec: r.spec,
    parts,
    testing: { commands, services: r.testing.services, notes: r.testing.notes },
    flag: r.flag,
    questions: r.questions,
  };
}

// ---------- Map check (spec.md section 6.4) ----------

const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

// true for each entry that names no file or folder at base, or a line past the end of its file. A line in a folder fails too.
export async function checkMap(
  map: Pick<MapEntry, "path" | "line">[],
  base: string,
  cache: string,
  env: Record<string, string>,
): Promise<boolean[]> {
  const g = (args: string[], stdin?: string) => git([`--git-dir=${cache}`, ...args], { env, stdin });
  const paths = map.map((e) => (/[\p{Cc}]/u.test(e.path) ? null : repoPath(e.path)));
  const asked = paths.flatMap((p) => (p === null ? [] : [`${base}:${p}`]));
  const rows = asked.length ? (await g(["cat-file", "--batch-check"], `${asked.join("\n")}\n`)).split("\n") : [];
  const found = new Map<string, { sha: string; type: string }>();
  asked.forEach((q, i) => {
    const m = /^([0-9a-f]{40,64}) (\w+) \d+$/.exec(rows[i] ?? "");
    if (m) found.set(q, { sha: m[1] as string, type: m[2] as string });
  });
  const lines = new Map<string, number>();
  const out: boolean[] = [];
  for (const [i, e] of map.entries()) {
    const p = paths[i];
    const f = p === null || p === undefined ? undefined : found.get(`${base}:${p}`);
    if (!f) {
      out.push(true);
      continue;
    }
    if (e.line === null) {
      out.push(false);
      continue;
    }
    if (f.type !== "blob") {
      out.push(true);
      continue;
    }
    if (!lines.has(f.sha)) lines.set(f.sha, lineCount(await g(["cat-file", "blob", f.sha])));
    out.push(e.line > (lines.get(f.sha) ?? 0));
  }
  return out;
}

// ---------- Rendering (spec.md section 6.4) ----------

const KIND_WORD: Record<MapEntry["kind"], string> = {
  pattern: "pattern to copy",
  change: "change",
  test: "test to extend",
  caller: "caller",
  migration: "migration",
  api: "api",
};
const KIND_ORDER: MapEntry["kind"][] = ["pattern", "change", "test", "caller", "migration", "api"];

export function mapLine(e: MapEntry, base: string): string {
  const at = `${oneLine(e.path)}${e.line === null ? "" : `:${e.line}`}`;
  const symbol = e.symbol ? ` \`${oneLine(e.symbol).replaceAll("`", "")}\`` : "";
  return `- ${at}${symbol}: ${KIND_WORD[e.kind]} — ${oneLine(e.what)}${e.missing ? ` (not found at ${base.slice(0, 12)})` : ""}`;
}

// Patterns to copy first, then changes, tests, callers, migration and API points (the design.md template).
const mapText = (p: Plan) =>
  [...p.map]
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((e) => mapLine(e, p.base))
    .join("\n");

// A prose line that starts with "#" would start a section, so it gets a Markdown escape.
const prose = (s: string) =>
  s.trim()
    ? s
        .trim()
        .split(/\r?\n/)
        .map((l) => (l.startsWith("#") ? `\\${l}` : l))
        .join("\n")
    : "None.";

// One list item of a grammar line. The separator inside an item would split it on parse.
const item = (s: string, sep: string) => oneLine(s).replaceAll(sep, sep.trim());
const list = (xs: string[], sep = ", ") =>
  xs
    .map((x) => item(x, sep))
    .filter(Boolean)
    .join(sep);
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

// The tasks grammar of spec.md section 6.4, without the "# Tasks" heading.
export function tasksBody(p: Plan, size: TaskSize): string {
  const e = p.estimate;
  const flags = [e.db && "db", e.api && "api"].filter((f): f is string => !!f);
  const out = [
    `Size: ${size}`,
    `Estimate: ${plural(e.parts, "part")}, about ${e.lines} changed lines, ${plural(e.files, "file")}, modules: ${list(e.modules) || "none"}`,
    `Flags: ${flags.join(", ") || "none"}`,
    `Unknowns: ${list(e.unknowns, "; ") || "none"}`,
  ];
  for (const part of p.parts) {
    out.push("", `## Part ${part.n}: ${oneLine(part.title)} (kind: ${part.kind})`, "", `Goal: ${oneLine(part.goal)}`, "", "Acceptance:");
    for (const a of part.acceptance) out.push(`- [${a.ticked ? "x" : " "}] ${a.id} ${oneLine(a.text)}`);
    if (part.tests.length) {
      out.push("", "Tests:");
      for (const t of part.tests) out.push(`- ${item(t.test, ": proves ")}: proves ${list(t.proves)}`);
    }
    for (const t of part.tasks)
      out.push(
        "",
        `### [${t.ticked ? "x" : " "}] ${t.id} ${oneLine(t.title)}`,
        `Files: ${list(t.files) || "none"}`,
        `Run: ${list(t.run)}`,
        `Done when: ${oneLine(t.done)}`,
      );
  }
  return `${out.join("\n")}\n`;
}

const title = (key: string, t: string) => `${key} ${oneLine(t)}`;

function designDoc(key: string, t: string, p: Plan, decision: string, map: string): string {
  const d = p.design;
  return [
    `# Design: ${title(key, t)}`,
    "",
    "## Integration map",
    "",
    map,
    "",
    "## Decision",
    "",
    decision,
    "",
    ...(d?.alternatives.trim() ? ["## Alternatives", "", prose(d.alternatives), ""] : []),
    "## Risks and rollout",
    "",
    prose(d?.risks ?? ""),
    "",
  ].join("\n");
}

function specDoc(key: string, t: string, p: Plan): string {
  const s = p.spec;
  return [
    `# Spec: ${title(key, t)}`,
    "",
    "## Behavior",
    "",
    prose(s?.behavior ?? ""),
    "",
    "## Edge cases",
    "",
    prose(s?.edgeCases ?? ""),
    "",
    "## Out of scope",
    "",
    prose(s?.outOfScope ?? ""),
    "",
  ].join("\n");
}

const planDoc = (key: string, t: string, map: string, change: string, tasks: string) =>
  [`# Plan: ${title(key, t)}`, "", "## Integration map", "", map, "", "## Change", "", change, "", "## Tasks", "", tasks].join("\n");

// The files of the plan for a size: small gets plan.md, medium and large get design.md, spec.md, and tasks.md.
export function renderDocs(key: string, t: string, size: TaskSize, p: Plan): Partial<Record<TaskDoc, string>> {
  const map = mapText(p);
  if (size === "small") return { plan: planDoc(key, t, map, prose(p.change || p.design?.decision || ""), tasksBody(p, size)) };
  return {
    design: designDoc(key, t, p, prose(p.design?.decision || p.change), map),
    spec: specDoc(key, t, p),
    tasks: `# Tasks: ${title(key, t)}\n\n${tasksBody(p, size)}`,
  };
}

export const docNames = (size: TaskSize): TaskDoc[] => (size === "small" ? ["plan"] : ["design", "spec", "tasks"]);

// The body under "## <heading>" up to the next level-2 heading. last: up to the end, so part headings stay in it.
function section(text: string, heading: string, last = false): string | null {
  const lines = text.split(/\r?\n/);
  const at = lines.indexOf(`## ${heading}`);
  if (at < 0) return null;
  const end = last ? lines.length : lines.findIndex((l, i) => i > at && l.startsWith("## "));
  return lines
    .slice(at + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

const withSize = (tasks: string, size: TaskSize) => (/^Size: .*$/m.test(tasks) ? tasks.replace(/^Size: .*$/m, `Size: ${size}`) : tasks);

// The files of the plan after a size change. The text of each section moves to the new files, so the edits of the user stay.
// The first "Size:" line of a tasks text is its header line, because the grammar starts with it.
export function convertDocs(key: string, t: string, from: TaskSize, to: TaskSize, docs: Docs): Partial<Record<TaskDoc, string>> {
  const p = docs.parsed;
  if ((from === "small") === (to === "small"))
    return to === "small" ? { plan: docs.plan } : { design: docs.design, spec: docs.spec, tasks: withSize(docs.tasks ?? "", to) };
  if (to === "small") {
    const design = docs.design ?? "";
    const tasks = (docs.tasks ?? "").replace(/^# Tasks: .*\r?\n/, "").trim();
    return {
      plan: `${planDoc(key, t, section(design, "Integration map") || mapText(p), section(design, "Decision") || "None.", withSize(tasks, to))}\n`,
    };
  }
  const plan = docs.plan ?? "";
  return {
    design: designDoc(key, t, p, section(plan, "Change") || "None.", section(plan, "Integration map") || mapText(p)),
    spec: specDoc(key, t, p),
    tasks: `# Tasks: ${title(key, t)}\n\n${withSize(section(plan, "Tasks", true) ?? tasksBody(p, to), to)}\n`,
  };
}

// ---------- Parse of the tasks grammar (spec.md section 6.4) ----------

export type ParseError = { line: number; error: string };

const PART = /^## Part (\d+): (.+) \(kind: (contract|part|cleanup|prep|spike)\)$/;
const TASK = /^### \[( |x)\] T(\d+)\.(\d+) (.+)$/;
const ACCEPT = /^- \[( |x)\] (\S+) (.+)$/;
const TEST = /^- (.+): proves (.+)$/;
const HEADER: Record<string, RegExp> = {
  Size: /^Size: (small|medium|large)$/,
  Estimate: /^Estimate: \d+ parts?, about \d+ changed lines, \d+ files?, modules: .+$/,
  Flags: /^Flags: (db, api|db|api|none)$/,
  Unknowns: /^Unknowns: .+$/,
};
const HEADER_HELP: Record<string, string> = {
  Size: 'the "Size" line must say small, medium, or large',
  Estimate: 'the "Estimate" line must look like "Estimate: 3 parts, about 900 changed lines, 14 files, modules: api"',
  Flags: 'the "Flags" line must say db, api, "db, api", or none',
  Unknowns: 'the "Unknowns" line must list the unknowns or say none',
};
const splitList = (s: string, sep = ", ") =>
  s.trim() === "none"
    ? []
    : s
        .split(sep)
        .map((x) => x.trim())
        .filter(Boolean);

// Parses the tasks grammar in lines, which start at line number first. previous: the stored parts, for the line estimates.
// The parse keeps every line: a line of another form is an error, so a later render loses nothing.
function parseGrammar(lines: string[], first: number, previous: PlanPart[]): { parts: PlanPart[] } | ParseError {
  const fail = (i: number, error: string): ParseError => ({ line: first + i, error });
  const seen = new Set<string>();
  const parts: PlanPart[] = [];
  let part: PlanPart | null = null;
  let partAt = 0;
  let mode: "head" | "acceptance" | "tests" | "task" | "part" = "head";
  let task: (PlanTask & { has: Set<string> }) | null = null;
  let taskAt = 0;
  const endTask = (): ParseError | null => {
    if (!task) return null;
    for (const [k, name] of [
      ["Files", "Files"],
      ["Run", "Run"],
      ["Done", "Done when"],
    ] as const)
      if (!task.has.has(k)) return fail(taskAt, `a task needs a "${name}" line`);
    if (!task.run.length) return fail(taskAt, 'a task needs at least one test in its "Run" line');
    part?.tasks.push({ id: task.id, title: task.title, files: task.files, run: task.run, done: task.done, ticked: task.ticked });
    task = null;
    return null;
  };
  const endPart = (): ParseError | null => {
    const e = endTask();
    if (e) return e;
    if (!part) return null;
    if (!part.goal) return fail(partAt, 'a part needs a "Goal" line');
    if (!part.acceptance.length) return fail(partAt, "a part needs at least one acceptance line");
    if (!part.tasks.length) return fail(partAt, "a part needs at least one task");
    parts.push(part);
    part = null;
    return null;
  };
  for (const [i, raw] of lines.entries()) {
    const l = raw.replace(/\r$/, "").trimEnd();
    if (!l) continue;
    const pm = PART.exec(l);
    if (pm) {
      if (mode === "head") {
        const left = Object.keys(HEADER).find((k) => !seen.has(k));
        if (left) return fail(i, `the plan needs a "${left}" line before the first part`);
      }
      const e = endPart();
      if (e) return e;
      const n = Number(pm[1]);
      if (parts.some((p) => p.n === n)) return fail(i, `part ${n} is listed twice`);
      part = {
        n,
        kind: pm[3] as PartKindName,
        title: (pm[2] as string).trim(),
        goal: "",
        lines: previous.find((p) => p.n === n)?.lines ?? null,
        acceptance: [],
        tests: [],
        tasks: [],
      };
      partAt = i;
      mode = "part";
      continue;
    }
    if (mode === "head") {
      const name = l.slice(0, l.indexOf(":"));
      const re = HEADER[name];
      if (!re) return fail(i, 'the app cannot read this line. The plan starts with the "Size" line');
      if (seen.has(name)) return fail(i, `the "${name}" line is listed twice`);
      if (!re.test(l)) return fail(i, HEADER_HELP[name] as string);
      seen.add(name);
      continue;
    }
    const tm = TASK.exec(l);
    if (tm) {
      const e = endTask();
      if (e) return e;
      const id = `T${tm[2]}.${tm[3]}`;
      if (Number(tm[2]) !== part?.n) return fail(i, `task ${id} must be in part ${tm[2]}`);
      if (parts.some((p) => p.tasks.some((t) => t.id === id)) || part.tasks.some((t) => t.id === id))
        return fail(i, `task ${id} is listed twice`);
      task = { id, title: (tm[4] as string).trim(), files: [], run: [], done: "", ticked: tm[1] === "x", has: new Set() };
      taskAt = i;
      mode = "task";
      continue;
    }
    if (l.startsWith("### ")) return fail(i, 'a task heading must look like "### [ ] T1.1 <title>"');
    if (l.startsWith("## ")) return fail(i, 'a part heading must look like "## Part 1: <title> (kind: part)"');
    const p = part as PlanPart | null;
    if (!p) return fail(i, "the app cannot read this line");
    if (mode === "task" && task) {
      const t = task as PlanTask & { has: Set<string> };
      const name = (["Files", "Run", "Done when"] as const).find((n) => l === `${n}:` || l.startsWith(`${n}: `));
      if (!name) return fail(i, 'a task has only the lines "Files", "Run", and "Done when"');
      const key = name === "Done when" ? "Done" : name;
      if (t.has.has(key)) return fail(i, `a task has one "${name}" line`);
      t.has.add(key);
      const value = l.slice(name.length + 1).trim();
      if (name === "Files") t.files = splitList(value);
      else if (name === "Run") t.run = splitList(value);
      else if (!value) return fail(i, 'the "Done when" line needs a check');
      else t.done = value;
      continue;
    }
    if (l.startsWith("Goal: ")) {
      if (p.goal) return fail(i, 'a part has one "Goal" line');
      p.goal = l.slice("Goal: ".length).trim();
      continue;
    }
    if (l === "Acceptance:") {
      mode = "acceptance";
      continue;
    }
    if (l === "Tests:") {
      mode = "tests";
      continue;
    }
    if (mode === "acceptance") {
      const am = ACCEPT.exec(l);
      if (!am) return fail(i, 'an acceptance line must look like "- [ ] A1.1 <criterion>"');
      p.acceptance.push({ id: am[2] as string, text: (am[3] as string).trim(), ticked: am[1] === "x" });
      continue;
    }
    if (mode === "tests") {
      const sm = TEST.exec(l);
      if (!sm) return fail(i, 'a test line must look like "- <test>: proves A1.1"');
      p.tests.push({ test: (sm[1] as string).trim(), proves: splitList(sm[2] as string) });
      continue;
    }
    return fail(i, "the app cannot read this line");
  }
  if (mode === "head") return fail(lines.length, "the plan needs at least one part");
  const e = endPart();
  if (e) return e;
  return { parts };
}

const at = (doc: string, e: ParseError): ParseError => ({ line: e.line, error: `Fix line ${e.line} of ${doc}: ${e.error}.` });

// tasks.md: "# Tasks: <KEY> <title>", then the grammar. Line numbers count from 1.
export function parseTasks(text: string, previous: PlanPart[]): { parts: PlanPart[] } | ParseError {
  const lines = text.split("\n");
  if (!lines[0]?.startsWith("# Tasks: ")) return at("tasks.md", { line: 1, error: 'the file must start with "# Tasks: <key> <title>"' });
  const r = parseGrammar(lines.slice(1), 2, previous);
  return "error" in r ? at("tasks.md", r) : r;
}

// plan.md: "# Plan: ...", then the sections Integration map, Change, and Tasks in this order. The Tasks section holds the grammar.
export function parsePlan(text: string, previous: PlanPart[]): { parts: PlanPart[] } | ParseError {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (!lines[0]?.startsWith("# Plan: ")) return at("plan.md", { line: 1, error: 'the file must start with "# Plan: <key> <title>"' });
  let from = 0;
  for (const h of ["Integration map", "Change", "Tasks"]) {
    const i = lines.findIndex((l, k) => k > from && l === `## ${h}`);
    if (i < 0) return at("plan.md", { line: lines.length, error: `the file needs the "## ${h}" section after the earlier sections` });
    from = i;
  }
  const r = parseGrammar(lines.slice(from + 1), from + 2, previous);
  return "error" in r ? at("plan.md", r) : r;
}

// ---------- step.md (spec.md sections 6.4 and 6.7) ----------

// The context of one loop step: the part goal, the acceptance lines of the part, the Files, Run, and Done when lines of the task, and
// the map entries of its files. null: the plan has no such task.
export function stepFile(p: Plan, taskId: string, attempt: number): ContextFile | null {
  const part = p.parts.find((x) => x.tasks.some((t) => t.id === taskId));
  const t = part?.tasks.find((x) => x.id === taskId);
  if (!part || !t) return null;
  const files = new Set(t.files.map((f) => repoPath(f) ?? f));
  const map = p.map.filter((e) => files.has(repoPath(e.path) ?? e.path));
  const text = [
    "# Step",
    "",
    `- Part ${part.n} of ${p.parts.length}: ${oneLine(part.title)} (kind: ${part.kind})`,
    `- Goal: ${oneLine(part.goal)}`,
    `- Task: ${t.id} ${oneLine(t.title)}`,
    `- Attempt: ${attempt}`,
    "",
    `## Acceptance of part ${part.n}`,
    "",
    ...part.acceptance.map((a) => `- ${a.id} ${oneLine(a.text)}`),
    "",
    "## Task",
    "",
    `Files: ${list(t.files) || "none"}`,
    `Run: ${list(t.run)}`,
    `Done when: ${oneLine(t.done)}`,
    "",
    "## Map entries of these files",
    "",
    ...(map.length ? map.map((e) => mapLine(e, p.base)) : ["(none)"]),
    "",
  ].join("\n");
  return { name: "step.md", text };
}

// step.md of a step for whole plan parts (spec.md section 6.7): the tests step, with the acceptance lines and the tests that the plan
// names, or the fix of the points of the own review, which stay in ./context/failure.md.
export function partStepFile(p: Plan, parts: PlanPart[], what: "tests" | "review" | "checks", attempt: number): ContextFile {
  const files = new Set(parts.flatMap((x) => x.tasks.flatMap((t) => t.files)).map((f) => repoPath(f) ?? f));
  const map = p.map.filter((e) => files.has(repoPath(e.path) ?? e.path));
  const out = [
    "# Step",
    "",
    ...parts.map((x) => `- Part ${x.n} of ${p.parts.length}: ${oneLine(x.title)} (kind: ${x.kind}). Goal: ${oneLine(x.goal)}`),
    what === "tests"
      ? "- Task: write the tests of the acceptance lines below. They must fail until the feature exists."
      : what === "checks"
        ? "- Task: fix the failed checks of the whole part in ./context/failure.md."
        : "- Task: fix the points of the review in ./context/failure.md.",
    `- Attempt: ${attempt}`,
    "",
  ];
  for (const x of parts) {
    out.push(`## Acceptance of part ${x.n}`, "", ...x.acceptance.map((a) => `- ${a.id} ${oneLine(a.text)}`), "");
    if (what === "tests" && x.tests.length)
      out.push(`## Tests of part ${x.n}`, "", ...x.tests.map((t) => `- ${item(t.test, ": proves ")}: proves ${list(t.proves)}`), "");
  }
  out.push("## Tasks", "");
  for (const x of parts)
    for (const t of x.tasks) out.push(`- ${t.id} ${oneLine(t.title)}. Files: ${list(t.files) || "none"}. Run: ${list(t.run)}.`);
  out.push("", "## Map entries of these files", "", ...(map.length ? map.map((e) => mapLine(e, p.base)) : ["(none)"]), "");
  return { name: "step.md", text: out.join("\n") };
}
