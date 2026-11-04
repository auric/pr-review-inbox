// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The plan of a task (docs/plans/review-v2/spec.md sections 6.1, 6.4, and 6.22): the size rules, the map check and the app checks
// against the base commit, the plan files in the change plan format, the parse of the tasks grammar, the size conversion of the files,
// and step.md of one task.
import { oneLine } from "../../shared/consult";
import {
  type AllowProposal,
  APP_CHECKS_MAX,
  allowProblem,
  CHECK_TIMEOUT_SEC,
  LARGE_REPOS_TEXT,
  type PlanProblem,
  type PlanSeverity,
  type SpecResult,
  SYMBOL_NEAR,
  sizeRank,
  type TaskCommand,
  type TaskDoc,
  type TaskSize,
  taskCommand,
} from "../../shared/task";
import { git } from "../review/git";
import { repoPath } from "../review/validate";
import type { ContextFile, SnapshotRepo } from "../review/workspace";

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
  repos: readonly { role: string; path: string | null; proposal?: string | null }[],
): string | null {
  if (size !== "large") return null;
  const subs = repos.filter((r) => r.role === "submodule" && r.path).map((r) => `${r.path}/`);
  const named = parts.some((p) => p.tasks.some((t) => t.files.some((f) => subs.some((s) => (repoPath(f) ?? f).startsWith(s)))));
  return named || repos.some((r) => r.role === "added" && (r.proposal ?? "added") === "added") ? LARGE_REPOS_TEXT : null;
}

// ---------- Proposals (spec.md section 6.16.5) ----------

export type ListedRepo = { project: string; slug: string; name: string };

// context/repo-list.md of a spec run: one line "PROJ/slug · name" per repository with REPO_WRITE, then the proposals that the user
// skipped. list null: the app could not read the list, and error says why. The names come from the server, so the file is untrusted.
export function repoListFile(
  list: { repos: readonly ListedRepo[]; complete: boolean } | null,
  skipped: readonly string[],
  error = "",
): ContextFile {
  const out = ["# Repositories that you may propose", ""];
  if (!list) out.push(`The app could not read the repository list. ${oneLine(error)} Propose no repository.`, "");
  else {
    out.push('Each line is one repository that the token can push to: "PROJECT/slug · name".', "");
    for (const r of list.repos) out.push(`- ${oneLine(r.project)}/${oneLine(r.slug)} · ${oneLine(r.name)}`);
    if (!list.complete) out.push("", `The list stops after ${list.repos.length} repositories.`);
    out.push("");
  }
  if (skipped.length) out.push("## Skipped by the user", "", "Do not propose these again.", "", ...skipped.map((s) => `- ${s}`), "");
  return { name: "repo-list.md", text: out.join("\n") };
}

type RepoKey = { project: string | null; repo: string | null };

// The proposals of a spec result that the app keeps: each one in the list, at most once, not a repository of the task (the main
// repository, a submodule, or an added one), and not one that the user skipped. skipped gets a line for each dropped proposal.
export function checkProposals(
  repos: SpecResult["repos"],
  list: readonly ListedRepo[],
  task: readonly RepoKey[],
  userSkipped: readonly RepoKey[],
  skipped: string[],
): SpecResult["repos"] {
  const kept: SpecResult["repos"] = [];
  for (const r of repos) {
    const name = `${oneLine(r.project)}/${oneLine(r.repo)}`;
    const same = (x: RepoKey) => x.project === r.project && x.repo === r.repo;
    if (!list.some((x) => x.project === r.project && x.slug === r.repo))
      skipped.push(`Claude proposed ${name}, which is not in context/repo-list.md, so the plan leaves it out.`);
    else if (task.some(same) || kept.some(same))
      skipped.push(`Claude proposed ${name}, which is already in the task, so the plan leaves it out.`);
    else if (userSkipped.some(same)) skipped.push(`Claude proposed ${name} again, which you skipped, so the plan leaves it out.`);
    else kept.push(r);
  }
  return kept;
}

// ---------- The stored plan (task.docs_json.parsed) ----------

// from: Claude's line before the app changed it. mark: the symbol check failed (spec.md section 6.22.2).
export type MapEntry = SpecResult["map"][number] & { missing: boolean; from?: number; mark?: "absent" | "far" };
// missing: the path is not empty and is not found at base.
export type PlanContract = SpecResult["contracts"][number] & { missing: boolean };
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
  // allow (spec.md section 6.21, D2): the proposals that pass allowProblem. Absent in a plan stored before: [].
  testing: { commands: TaskCommand[]; services: string[]; notes: string; allow?: AllowProposal[] };
  flag: SpecResult["flag"];
  questions: string[];
  // The part count of the whole plan, for a plan that holds one part of it (spec.md section 6.20.6). Absent: parts.length.
  partCount?: number;
  // spec.md section 6.22. checks: the app checks with the IDs a1 and up. Absent in a plan stored before: [].
  contracts?: PlanContract[];
  risks?: SpecResult["risks"];
  checks?: PlanProblem[];
};
// task.docs_json. approved: a medium or large plan waits for its spec PR.
export type Docs = Partial<Record<TaskDoc, string>> & { version: number; parsed: Plan; approved: boolean };

export const NEW_COMMAND = "new-";

// The plan of a checked spec result. checked: the map check of each entry, or the app checks (checkPlan), whose line moves, marks,
// and problems the plan takes. skipped gets a line for each command that fails the taskCommand schema. Task IDs become T<part>.<n>
// and acceptance IDs A<part>.<n>, as the tasks grammar names them. hosts: the Bitbucket and Jira host names. A proposed command pattern
// that fails allowProblem gets a line in skipped too.
export function toPlan(
  r: SpecResult,
  base: string,
  checked: boolean[] | AppChecks,
  skipped: string[],
  hosts: readonly string[] = [],
): Plan {
  const app = Array.isArray(checked) ? null : checked;
  const missing = app ? app.missing : (checked as boolean[]);
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
  const allow: AllowProposal[] = [];
  for (const a of r.testing.allow) {
    const pattern = a.pattern.trim();
    const problem = allowProblem(pattern, hosts);
    if (problem) skipped.push(`The plan leaves out the command pattern "${oneLine(pattern)}". ${problem}`);
    else if (!allow.some((x) => x.pattern === pattern)) allow.push({ pattern, reason: a.reason });
  }
  return {
    proposed: r.size,
    estimate: r.estimate,
    base,
    map: r.map.map((e, i) => ({ ...e, ...app?.entries[i], missing: missing[i] === true })),
    change: r.change,
    design: r.design,
    spec: r.spec,
    parts,
    testing: { commands, services: r.testing.services, notes: r.testing.notes, allow },
    flag: r.flag,
    questions: r.questions,
    contracts: r.contracts.map((c, i) => ({ ...c, missing: app?.contracts[i] === true })),
    risks: r.risks,
    checks: app?.checks ?? [],
  };
}

// ---------- Map check (spec.md section 6.4) ----------

const lineCount = (text: string) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

type Nested = Pick<SnapshotRepo, "path" | "cache" | "commit">;
// The cache and the object name of a path. "<commit>:" names the root tree of a repository.
type Asked = { cache: string; object: string };
type Found = Asked & { sha: string; type: string };
type Git = (dir: string, args: string[], stdin?: string) => Promise<string>;

const gitIn =
  (env: Record<string, string>): Git =>
  (dir, args, stdin) =>
    git([`--git-dir=${dir}`, ...args], { env, stdin });

// null: an invalid path. nested: the other repositories of the snapshot (spec.md section 6.16.5). A path under the path of one is
// read in that repository at its commit. The longest path wins, so a submodule of an added repository takes its own paths.
function askOf(path: string, base: string, cache: string, nested: readonly Nested[]): Asked | null {
  if (/[\p{Cc}]/u.test(path)) return null;
  const raw = path.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  const n = nested.filter((r) => raw === r.path || raw.startsWith(`${r.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!n) {
    const p = repoPath(raw);
    return p === null ? null : { cache, object: `${base}:${p}` };
  }
  const rest = raw.slice(n.path.length + 1);
  if (rest === "") return { cache: n.cache, object: `${n.commit}:` };
  const p = repoPath(rest);
  return p === null ? null : { cache: n.cache, object: `${n.commit}:${p}` };
}

// One cat-file process per cache. The result gives the object of an asked name, or null when the commit does not hold it.
async function lookup(g: Git, asked: readonly (Asked | null)[]): Promise<(a: Asked | null) => Found | null> {
  const found = new Map<string, { sha: string; type: string }>();
  for (const dir of new Set(asked.flatMap((a) => (a ? [a.cache] : [])))) {
    const objects = [...new Set(asked.flatMap((a) => (a?.cache === dir ? [a.object] : [])))];
    const rows = (await g(dir, ["cat-file", "--batch-check"], `${objects.join("\n")}\n`)).split("\n");
    objects.forEach((q, i) => {
      const m = /^([0-9a-f]{40,64}) (\w+) \d+$/.exec(rows[i] ?? "");
      if (m) found.set(`${dir}\0${q}`, { sha: m[1] as string, type: m[2] as string });
    });
  }
  return (a) => {
    const f = a && found.get(`${a.cache}\0${a.object}`);
    return a && f ? { ...a, ...f } : null;
  };
}

// The text of a blob, read once per object.
function blobText(g: Git): (f: Found) => Promise<string> {
  const texts = new Map<string, string>();
  return async (f) => {
    const known = texts.get(f.sha);
    if (known !== undefined) return known;
    const text = await g(f.cache, ["cat-file", "blob", f.sha]);
    texts.set(f.sha, text);
    return text;
  };
}

async function missingOf(map: Pick<MapEntry, "line">[], found: (Found | null)[], text: (f: Found) => Promise<string>) {
  const out: boolean[] = [];
  for (const [i, e] of map.entries()) {
    const f = found[i];
    if (!f) out.push(true);
    else if (e.line === null) out.push(false);
    else if (f.type !== "blob") out.push(true);
    else out.push(e.line > lineCount(await text(f)));
  }
  return out;
}

// true for each entry that names no file or folder at base, or a line past the end of its file. A line in a folder fails too.
// nested: as askOf.
export async function checkMap(
  map: Pick<MapEntry, "path" | "line">[],
  base: string,
  cache: string,
  env: Record<string, string>,
  nested: Nested[] = [],
): Promise<boolean[]> {
  const g = gitIn(env);
  const asked = map.map((e) => askOf(e.path, base, cache, nested));
  const seen = await lookup(g, asked);
  return missingOf(map, asked.map(seen), blobText(g));
}

// ---------- App checks (spec.md section 6.22.2) ----------

const IDENT = "[\\p{L}_$][\\p{L}\\p{N}_$]*";
const SYMBOL = new RegExp(`^(?:${IDENT}(?:\\.|::|#))*(${IDENT})(?:\\(\\))?$`, "u");
// git treats a file with a NUL byte in its first 8000 bytes as binary (xdiff-interface.c, buffer_is_binary).
const BINARY_BYTES = 8000;
// The lines that the far check names. The text then gives the count of the others.
const LINES_SHOWN = 10;

// The name that the app looks for in the file of a map entry, or null: the symbol is a route or prose, so the app does not check it.
export function symbolName(symbol: string): string | null {
  return SYMBOL.exec(symbol.replaceAll("`", "").trim())?.[1] ?? null;
}

// The line numbers of text that hold name with no letter, digit, "_", or "$" right before or after it.
function linesHolding(text: string, name: string): number[] {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${name.replaceAll("$", "\\$")}(?![\\p{L}\\p{N}_$])`, "u");
  return text.split("\n").flatMap((l, i) => (re.test(l) ? [i + 1] : []));
}

// "a", "a and b", or "a, b, and c".
const andList = (xs: string[]) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);
const taskList = (ids: string[]) =>
  ids.length > 3 ? `${ids.slice(0, 3).join(", ")}, and ${plural(ids.length - 3, "more task")}` : andList(ids);

// The object is the folder, or an object of the same cache below it.
const under = (o: Asked, folder: Asked) =>
  o.cache === folder.cache &&
  (o.object === folder.object || o.object.startsWith(folder.object.endsWith(":") ? folder.object : `${folder.object}/`));

// missing: as checkMap. entries: the line of each map entry after the symbol check, with from and mark. contracts: true for each
// contract whose path is not empty and is not found at base. checks: at most APP_CHECKS_MAX problems. more: the problems after them.
export type AppChecks = {
  missing: boolean[];
  entries: Pick<MapEntry, "line" | "from" | "mark">[];
  contracts: boolean[];
  checks: PlanProblem[];
  more: number;
};

// The app checks of a spec result against the base commit: the map paths and symbols, the task files, and the contracts. specDir: the
// spec folder of the task, whose files the tasks may name. nested: as askOf. The checks make no Claude call.
export async function checkPlan(
  r: Pick<SpecResult, "map" | "parts" | "contracts" | "estimate">,
  specDir: string,
  base: string,
  cache: string,
  env: Record<string, string>,
  nested: Nested[] = [],
): Promise<AppChecks> {
  const g = gitIn(env);
  const readBlob = blobText(g);
  const at = base.slice(0, 12);
  const ask = (p: string) => askOf(p, base, cache, nested);
  const map = r.map.map((e) => ask(e.path));
  // The files of the tasks in plan order, once per object. ids: the tasks that name the file.
  const files = new Map<string, { path: string; asked: Asked | null; ids: string[]; parts: Set<number> }>();
  for (const [pi, p] of r.parts.entries())
    for (const [ti, t] of p.tasks.entries())
      for (const path of t.files.filter((f) => f.trim())) {
        const asked = ask(path);
        const key = asked ? `${asked.cache}\0${asked.object}` : `\0${path}`;
        const use = files.get(key) ?? { path, asked, ids: [], parts: new Set<number>() };
        const id = `T${pi + 1}.${ti + 1}`;
        if (!use.ids.includes(id)) use.ids.push(id);
        use.parts.add(pi + 1);
        files.set(key, use);
      }
  const uses = [...files.values()];
  // The folder of a file object. null: the root of its repository, which always exists.
  const parentOf = (a: Asked): Asked | null => {
    const slash = a.object.lastIndexOf("/");
    return slash < 0 ? null : { cache: a.cache, object: a.object.slice(0, slash) };
  };
  const contracts = r.contracts.map((c) => (c.path.trim() ? ask(c.path) : null));
  const seen = await lookup(g, [...map, ...uses.map((u) => u.asked), ...uses.map((u) => u.asked && parentOf(u.asked)), ...contracts]);
  const missing = await missingOf(r.map, map.map(seen), readBlob);

  // group: 0 the map, 1 the tasks, 2 the contracts.
  const problems: ({ group: number } & Omit<PlanProblem, "id">)[] = [];
  const add = (severity: PlanSeverity, group: number, p: Omit<PlanProblem, "id" | "severity">) => problems.push({ group, severity, ...p });

  const entries: AppChecks["entries"] = [];
  for (const [i, e] of r.map.entries()) {
    entries.push({ line: e.line });
    const head = `Map line ${i + 1}`;
    const path = oneLine(e.path);
    if (missing[i]) {
      const text = `${head}: ${path}${e.line === null ? "" : `:${e.line}`} is not found at ${at}.`;
      add("major", 0, { part: null, path, line: e.line, text, fix: `Name a file and a line that exist at ${at}, or remove the entry.` });
      continue;
    }
    const f = seen(map[i] ?? null);
    const name = symbolName(e.symbol);
    if (f?.type !== "blob" || name === null) continue;
    const body = await readBlob(f);
    if (Buffer.from(body.slice(0, BINARY_BYTES)).subarray(0, BINARY_BYTES).includes(0)) continue;
    const holds = linesHolding(body, name);
    const line = e.line;
    if (line !== null && holds.some((h) => Math.abs(h - line) <= SYMBOL_NEAR)) continue;
    if (line === null && holds.length > 1) continue;
    const [only] = holds;
    if (holds.length === 1 && only !== undefined) {
      entries[i] = line === null ? { line: only } : { line: only, from: line };
      const text =
        line === null
          ? `${head}: \`${name}\` is at line ${only}. The app set the line.`
          : `${head}: \`${name}\` is at line ${only}, not ${line}. The app changed the line.`;
      add("info", 0, { part: null, path, line: only, text, fix: "" });
    } else if (holds.length > 1) {
      entries[i] = { line, mark: "far" };
      const shown = holds.slice(0, LINES_SHOWN).map(String);
      if (holds.length > LINES_SHOWN) shown.push(plural(holds.length - LINES_SHOWN, "more line"));
      const text = `${head}: \`${name}\` is not near line ${line} of ${path}. It is at lines ${andList(shown)}.`;
      add("minor", 0, { part: null, path, line, text, fix: "Give the line that the change needs." });
    } else {
      entries[i] = { line, mark: "absent" };
      const fix = `Name the file that holds \`${name}\`, or a symbol of ${path}.`;
      add("major", 0, { part: null, path, line, text: `${head}: \`${name}\` is not in ${path}.`, fix });
    }
  }

  const spec = ask(specDir);
  for (const u of uses) {
    if (spec && u.asked && under(u.asked, spec)) continue;
    const path = oneLine(u.path);
    const part = u.parts.size === 1 ? ([...u.parts][0] ?? null) : null;
    const one = u.ids.length === 1;
    if (seen(u.asked)) {
      const listed = r.map.some((e, i) => {
        const m = map[i] ?? null;
        if (!m || !u.asked) return false;
        return (
          (m.cache === u.asked.cache && m.object === u.asked.object) || (e.line === null && seen(m)?.type === "tree" && under(u.asked, m))
        );
      });
      if (!listed) {
        const text = `${taskList(u.ids)} ${one ? "changes" : "change"} ${path}, which the map does not list.`;
        add("major", 1, { part, path, line: null, text, fix: `Add a map entry for ${path}.` });
      }
      continue;
    }
    const folder = u.asked && parentOf(u.asked);
    if (u.asked && (folder === null || seen(folder)?.type === "tree")) continue;
    const text = `${taskList(u.ids)} ${one ? "creates" : "create"} ${path} in a folder that does not exist at ${at}.`;
    add("minor", 1, { part, path, line: null, text, fix: "Check the path. A new folder is correct only when the plan needs one." });
  }

  const absent = r.contracts.map((c, i) => c.path.trim() !== "" && seen(contracts[i] ?? null) === null);
  r.contracts.forEach((c, i) => {
    if (!absent[i]) return;
    const path = oneLine(c.path);
    const fix = "Name the file that defines it, or leave the path empty for a new contract.";
    add("major", 2, { part: c.part, path, line: null, text: `Contract ${oneLine(c.name)}: ${path} is not found at ${at}.`, fix });
  });
  if ((r.estimate.db || r.estimate.api) && !r.contracts.length) {
    const text = "The plan changes the database or an API, but it lists no contract.";
    add("minor", 2, { part: null, path: "", line: null, text, fix: "List each changed table, route, or schema in contracts." });
  }

  const rank: Record<PlanSeverity, number> = { blocker: 0, major: 1, minor: 2, info: 3 };
  const sorted = problems.sort((a, b) => rank[a.severity] - rank[b.severity] || a.group - b.group);
  const checks = sorted.slice(0, APP_CHECKS_MAX).map(({ group: _, ...p }, i) => ({ id: `a${i + 1}`, ...p }));
  return { missing, entries, contracts: absent, checks, more: sorted.length - checks.length };
}

// The coverage lines of the app checks: each major and minor text, then the count of the problems over APP_CHECKS_MAX.
export const checkLines = (c: Pick<AppChecks, "checks" | "more">): string[] => [
  ...c.checks.filter((p) => p.severity !== "info").map((p) => p.text),
  ...(c.more ? [`The app found ${plural(c.more, "more problem")} in the plan.`] : []),
];

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

const MARK_TEXT = { absent: "is not in this file", far: "is not near this line" } as const;

export function mapLine(e: MapEntry, base: string): string {
  const at = `${oneLine(e.path)}${e.line === null ? "" : `:${e.line}`}`;
  const symbol = e.symbol ? ` \`${oneLine(e.symbol).replaceAll("`", "")}\`` : "";
  const name = e.mark && symbolName(e.symbol);
  const mark = e.missing ? ` (not found at ${base.slice(0, 12)})` : e.mark && name ? ` (\`${name}\` ${MARK_TEXT[e.mark]})` : "";
  return `- ${at}${symbol}: ${KIND_WORD[e.kind]} — ${oneLine(e.what)}${mark}`;
}

// spec.md section 6.22.3: one line per contract, then one line per risk.
function contractsText(p: Plan): string {
  const lines = [
    ...(p.contracts ?? []).map((c) => {
      const where = c.path.trim() ? ` in ${oneLine(c.path)}${c.missing ? ` (not found at ${p.base.slice(0, 12)})` : ""}` : "";
      const name = oneLine(c.name).replaceAll("`", "");
      return `- Contract \`${name}\` (${c.change})${where}: users: ${oneLine(c.users)}. Compat: ${oneLine(c.compat)}`;
    }),
    ...(p.risks ?? []).map((r) => `- Risk: ${oneLine(r.text)} Caught by: ${oneLine(r.check)}`),
  ];
  return lines.join("\n") || "None.";
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

function designDoc(key: string, t: string, p: Plan, decision: string, map: string, contracts: string): string {
  const d = p.design;
  return [
    `# Design: ${title(key, t)}`,
    "",
    "## Integration map",
    "",
    map,
    "",
    "## Contracts and risks",
    "",
    contracts,
    "",
    "## Decision",
    "",
    decision,
    "",
    ...(d?.alternatives.trim() ? ["## Alternatives", "", prose(d.alternatives), ""] : []),
    "## Rollout",
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

const planDoc = (key: string, t: string, map: string, contracts: string, change: string, tasks: string) =>
  [
    `# Plan: ${title(key, t)}`,
    "",
    "## Integration map",
    "",
    map,
    "",
    "## Contracts and risks",
    "",
    contracts,
    "",
    "## Change",
    "",
    change,
    "",
    "## Tasks",
    "",
    tasks,
  ].join("\n");

// The files of the plan for a size: small gets plan.md, medium and large get design.md, spec.md, and tasks.md.
export function renderDocs(key: string, t: string, size: TaskSize, p: Plan): Partial<Record<TaskDoc, string>> {
  const map = mapText(p);
  const contracts = contractsText(p);
  if (size === "small") return { plan: planDoc(key, t, map, contracts, prose(p.change || p.design?.decision || ""), tasksBody(p, size)) };
  return {
    design: designDoc(key, t, p, prose(p.design?.decision || p.change), map, contracts),
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
    const map = section(design, "Integration map") || mapText(p);
    const contracts = section(design, "Contracts and risks") || contractsText(p);
    return { plan: `${planDoc(key, t, map, contracts, section(design, "Decision") || "None.", withSize(tasks, to))}\n` };
  }
  const plan = docs.plan ?? "";
  const map = section(plan, "Integration map") || mapText(p);
  return {
    design: designDoc(key, t, p, section(plan, "Change") || "None.", map, section(plan, "Contracts and risks") || contractsText(p)),
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
    `- Part ${part.n} of ${p.partCount ?? p.parts.length}: ${oneLine(part.title)} (kind: ${part.kind})`,
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
// The instruct and resolve steps of spec.md section 6.18 add a "- Mode:" line.
export function partStepFile(
  p: Plan,
  parts: PlanPart[],
  what: "tests" | "review" | "checks" | "instruct" | "resolve",
  attempt: number,
): ContextFile {
  const files = new Set(parts.flatMap((x) => x.tasks.flatMap((t) => t.files)).map((f) => repoPath(f) ?? f));
  const map = p.map.filter((e) => files.has(repoPath(e.path) ?? e.path));
  const task = {
    tests: "- Task: write the tests of the acceptance lines below. They must fail until the feature exists.",
    checks: "- Task: fix the failed checks of the whole part in ./context/failure.md.",
    review: "- Task: fix the points of the review in ./context/failure.md.",
    instruct: '- Mode: instruct\n- Task: do the request of "Your instructions" in the message.',
    resolve: "- Mode: resolve\n- Task: resolve the conflicts that ./context/conflicts.md lists.",
  }[what];
  const out = [
    "# Step",
    "",
    ...parts.map(
      (x) => `- Part ${x.n} of ${p.partCount ?? p.parts.length}: ${oneLine(x.title)} (kind: ${x.kind}). Goal: ${oneLine(x.goal)}`,
    ),
    task,
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
