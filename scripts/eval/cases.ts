// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The eval cases of fixtures/eval (docs/plans/review-v2/spec.md section 4.3) and the temp git repository of one case.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { type DiffFile, parseDiff } from "../../src/server/review/diffmap";
import { git, gitEnv } from "../../src/server/review/git";
import { finding, severities } from "../../src/shared/review";

const REPO = resolve(import.meta.dir, "../..");
const EVAL_DIR = join(REPO, "fixtures/eval");
// v1: the 12 cases of the first baseline. hard: bugs that need unchanged code, bigger diffs, more traps, and cases with no bug.
// probe: small cases for thread claims, task criteria, invented requirements, and a clean PR (review-quality-2026.md E1).
export const SETS = { v1: join(EVAL_DIR, "cases"), hard: join(EVAL_DIR, "hard"), probe: join(EVAL_DIR, "probe") } as const;
export type FixtureSet = keyof typeof SETS;
// local: the set from your own decisions (docs/eval/local.md). It holds company code, so it never enters git.
export type EvalSet = FixtureSet | "local";
export const SET_NAMES: readonly EvalSet[] = [...(Object.keys(SETS) as FixtureSet[]), "local"];
// eval-local/ is git-ignored as a safety net (docs/plans/review-v3.md Q4).
export const localDir = () => resolve(process.env.REVIEW_LOOP_EVAL_LOCAL || join(REPO, "eval-local"));
// The seed store and the frozen seeded set in set/ (docs/plans/review-v2/seeded-truth.md section 3). git ignores eval-seeds/.
export const seedsDir = () => resolve(process.env.REVIEW_LOOP_EVAL_SEEDS || join(REPO, "eval-seeds"));
export const setDir = (set: EvalSet) => (set === "local" ? join(localDir(), "cases") : SETS[set]);
// The re-review cases of the local set (docs/plans/review-v3.md WP-V3). A plain run never reads them.
export const rereviewDir = () => join(localDir(), "rereview");
export const CASES_DIR = SETS.v1;
const CASE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// spec.md section 1.3: core and the module IDs.
export const MODULE_IDS = [
  "core",
  "security",
  "concurrency",
  "performance",
  "tests",
  "api",
  "docs",
  "simplify",
  "rules",
  "intent",
  "failures",
] as const;
export const LANGUAGES = ["typescript", "cpp", "python"] as const;

const range = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([s, e]) => s <= e, "The first line is after the last line.");
const spot = { path: z.string().min(1), side: z.enum(["new", "old"]), lines: range };
// alt: other places of the same bug or trap, such as a declaration and its definition, or a caller and its changed callee.
const commit = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
// carriedFrom: local set only. The head of the earlier case whose decision this item carries. Absent: a decision at the head of the case.
const place = { id: z.string().min(1), ...spot, alt: z.array(z.object(spot)).min(1).optional(), carriedFrom: commit.optional() };
// Who confirmed an item of the local set. posted: you posted the finding. fixed: a fix commit covered it. session: your session
// accepted it. other: a line comment of another reviewer. own: your own discard, withdrawal, or comment. seeded: a planted defect of the
// seeded set (docs/plans/review-v2/seeded-truth.md).
export const ITEM_SOURCES = ["posted", "fixed", "session", "other", "own", "seeded"] as const;
// seeded-truth.md section 4.1, with the kind of architecture-bugs.md.
export const SEED_KINDS = [
  "lifetime",
  "contract",
  "omission",
  "entry",
  "concurrency",
  "leak",
  "error",
  "architecture",
  "security",
  "local",
] as const;
// Local set only, rules 5. text: the title, trigger, and body of the finding, or the comment text with names replaced. category: the
// category of the finding. A fixture set has no text: note and why describe its items.
const gold = { text: z.string().optional(), category: z.string().optional(), source: z.enum(ITEM_SOURCES).optional() };
export const evalBug = z
  .object({
    ...place,
    severityMin: z.enum(severities),
    module: z.enum(MODULE_IDS),
    note: z.string().min(1),
    ...gold,
    seedKind: z.enum(SEED_KINDS).optional(),
  })
  .refine((b) => b.seedKind === undefined || b.source === "seeded", {
    message: "seedKind needs source seeded.",
    path: ["seedKind"],
  });
export const evalTrap = z.object({ ...place, why: z.string().min(1), ...gold });
// A real issue that is no seeded bug. A shown item on it counts for no metric but extras.
export const evalExtra = z.object({ ...spot, note: z.string().min(1), ...gold, carriedFrom: commit.optional() });
// A finding of the earlier run of a re-review case (docs/plans/review-v3.md WP-V3). The spot is its item anchor at the earlier head.
// status: its state when the re-review started. open: new or accepted, so the re-review carries it. dropped: discarded, but not by
// you (the check refuted it, or a fix commit closed it). resolved: posted only, the later state of its thread, or null when no thread
// exists. payload: the stored finding as review_item.payload_json holds it.
export const earlierStatuses = ["open", "posted", "discarded", "dropped"] as const;
export const evalEarlier = z.object({
  id: z.string().min(1),
  ...spot,
  status: z.enum(earlierStatuses),
  resolved: z.boolean().nullable(),
  body: z.string(),
  payload: finding.loose(),
});
const rereviewBlock = z.object({ earlier: z.array(evalEarlier).min(1) });
// The user and the PR author of the PR row that run.ts seeds. local.ts gives the people of a thread placeholders that differ from both.
export const EVAL_USER = "eval-reviewer";
export const EVAL_AUTHOR = "eval-author";
// A comment of a PR thread at the reviewed head (local.ts caseThreads, docs/plans/review-v2/review-ideas.md idea 2). id: a case-local
// number. root: the id of the root comment, equal to id for a root. author: EVAL_AUTHOR or reviewer-<n>, never a real name.
// at: created time in ms. path, side, lines: the place of an inline root at the reviewed head. A file comment has a path only.
// resolved: a root only, resolved before the review run started. deleted: a root that is deleted, with live replies; its text is empty.
// lineType CONTEXT: an unchanged line, numbered on the old side. newPlace: the same lines on the new side at the reviewed head.
// earlier: a reply of the PR author in the thread of the posted earlier finding with this ID (re-review cases). Its root is not in
// the list: run.ts seeds that root from rereview.earlier.
export const evalThreadComment = z.object({
  id: z.number().int().min(1),
  root: z.number().int().min(1),
  author: z.string().regex(/^(eval-author|reviewer-[1-9][0-9]*)$/),
  at: z.number().int(),
  text: z.string(),
  path: z.string().min(1).optional(),
  side: z.enum(["new", "old"]).optional(),
  lines: range.optional(),
  lineType: z.literal("CONTEXT").optional(),
  newPlace: z.object({ path: z.string().min(1), lines: range }).optional(),
  resolved: z.boolean().optional(),
  deleted: z.literal(true).optional(),
  earlier: z.string().min(1).optional(),
});
// docs/plans/review-v2/stacked-prs.md WP-SK3: the other pull requests of a stacked case. parent: parent.patch applies to base/ and makes
// the target branch "parent", and head.patch applies on top of it. children: open pull requests into the source branch. They have no
// commits, so paths names their changed paths.
const stackPr = { title: z.string().min(1), description: z.string() };
export const evalStack = z
  .object({
    parent: z.object(stackPr).optional(),
    children: z.array(z.object({ ...stackPr, paths: z.array(z.string().min(1)).min(1) })).optional(),
  })
  .refine((s) => s.parent !== undefined || (s.children?.length ?? 0) > 0, "A stack needs a parent or a child.");
// docs/plans/review-v2/submodule-prs.md WP-SM3: the submodule that the change moves. sub/base/ and sub/head.patch build its repository,
// and title is the subject of its head commit. url goes into .gitmodules as given, so a relative URL resolves against the main clone link.
export const evalSubmodule = z.object({
  path: z.string().regex(/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/),
  url: z.string().min(1),
  title: z.string().min(1),
});
// tests/eval/harness.test.ts checks the bug, trap, and line counts of each set.
export const caseFile = z.object({
  id: z.string().regex(CASE_ID),
  title: z.string().min(1),
  language: z.enum(LANGUAGES),
  pr: z.object({ title: z.string().min(1), description: z.string() }),
  task: z.string().optional(),
  // The Jira summary of task. Absent: the title. A case whose title names the expected outcome sets it, so the run cannot read it.
  taskSummary: z.string().min(1).optional(),
  // The stacked probe cases: the run line reports whether a shown finding, a question, or an open risk names one of these texts.
  expectMention: z.array(z.string().min(1)).min(1).optional(),
  instructions: z.string().optional(),
  bugs: z.array(evalBug).max(3),
  traps: z.array(evalTrap).min(1).max(4),
  extras: z.array(evalExtra).optional(),
  // A re-review case: earlier.patch beside head.patch makes the earlier head. bugs, traps, and extras are at the head.
  rereview: rereviewBlock.optional(),
  // The PR threads at the head. run.ts seeds them, so pr-context.md lists them. Absent: no thread.
  threads: z.array(evalThreadComment).optional(),
  // A PR with no known defect: a probe case, or a clean case of the local set (local.ts --clean). It has no bugs.
  clean: z.literal(true).optional(),
  // A stacked PR. run.ts gives it to the variant "stack" only. Absent: the repository and every context file keep their bytes.
  stack: evalStack.optional(),
  // A change that moves a gitlink. run.ts gives the submodule reads to the variant "submodules" only. Absent: no .gitmodules and no gitlink.
  submodule: evalSubmodule.optional(),
});
// Your own inline comment at a reviewed head (docs/plans/review-v3.md Q1). It must be found, and it scores apart from the bugs.
export const evalHuman = z.object({ id: z.string().min(1), ...spot, note: z.string().min(1), ...gold });
export const LOCAL_RULES = 6;
// A case of the local set (docs/plans/review-v3.md WP-V1). A git bundle in ../../bundles/ holds the repository, so the case has no
// base/ folder and no head.patch. The limits of the fixture sets do not apply. tasks: the pr_task rows with their task_context JSON.
export const localCaseFile = caseFile.extend({
  language: z.string().min(1),
  bugs: z.array(evalBug),
  traps: z.array(evalTrap),
  extras: z.array(evalExtra),
  human: z.array(evalHuman),
  tasks: z.array(z.object({ key: z.string().min(1), source: z.string().min(1), json: z.string().nullable() })),
  bundle: z.object({ file: z.string().regex(/^[0-9a-f]{16}\.bundle$/), base: commit, head: commit }),
  changedLines: z.number().int().min(0),
  // The version of the must-find rules of local.ts. It is in the case.json text, so a new rule gives a new set fingerprint. 2: the
  // comments of other reviewers count. 3: the case holds its PR threads. 4: the thread cutoff is the run start, and a thread on the
  // lines of a must-find stays out. 5: each item has text and source, the case has group, hasTask, and large, and clean cases exist.
  // 6: a bug carried from an earlier head is an extra with carriedFrom, not a bug. Absent: 1. A case without threads, or a case built before rules 3, has no threads, and run.ts seeds none.
  rules: z.number().int().min(2).max(LOCAL_RULES).optional(),
  // Rules 5. group: an opaque key of the PR, the same for each case of one PR. hasTask: run.ts seeds task text, so the run gets
  // task.md. large: the diff has REVIEWER_MIN_LINES changed lines or REVIEWER_MIN_FILES files (catalog.ts), whatever the reviewer mode.
  group: z.string().min(1).optional(),
  hasTask: z.boolean().optional(),
  large: z.boolean().optional(),
  // since: the head of the earlier run. sinceBase: its merge base. The bundle holds both.
  rereview: rereviewBlock.extend({ since: commit, sinceBase: commit }).optional(),
});
export type EvalBug = z.infer<typeof evalBug>;
export type EvalEarlier = z.infer<typeof evalEarlier>;
export type EvalTrap = z.infer<typeof evalTrap>;
export type EvalExtra = z.infer<typeof evalExtra>;
export type EvalHuman = z.infer<typeof evalHuman>;
export type CaseFile = z.infer<typeof caseFile>;
export type LocalCaseFile = z.infer<typeof localCaseFile>;
export type EvalThreadComment = z.infer<typeof evalThreadComment>;
// The repository of a local case. bundle: the absolute path of the bundle file. hash: the SHA-256 of case.json, for the set fingerprint.
// since, sinceBase: the earlier head and its merge base of a re-review case.
export type LocalRepo = { bundle: string; base: string; head: string; hash: string; since?: string; sinceBase?: string };
// base: the files of base/ by repository path. changedLines: added and removed lines of head.patch. A local case has an empty base
// and patch, and local names its bundle.
export type EvalCase = Omit<CaseFile, "language"> & {
  language: string;
  dir: string;
  base: Map<string, string>;
  patch: string;
  changedLines: number;
  human?: EvalHuman[];
  tasks?: LocalCaseFile["tasks"];
  group?: string;
  hasTask?: boolean;
  large?: boolean;
  local?: LocalRepo;
  // The text of NOTE_FILE of a local case. Absent: the case has no note.
  note?: string;
};

// The fingerprint of a local set: the hash of each case.json in ID order. compare.ts refuses two results with different ones.
export function setFingerprint(cases: { id: string; hash: string }[]): string {
  const h = createHash("sha256");
  for (const c of [...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) h.update(`${c.id} ${c.hash}\n`);
  return h.digest("hex");
}

const files = (root: string, dir = root): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(root, p) : [relative(root, p).replaceAll("\\", "/")];
  });

// A range at the newer commit of a parsed diff. null: a hunk deletes or inserts a line inside the range, or deletes the file. A file
// outside the diff keeps its lines. diffmap.ts: an add row sits before the old-side line `old`, a del row removes the line `old`.
export function mapSpot(files: DiffFile[], s: { path: string; lines: [number, number] }): { path: string; lines: [number, number] } | null {
  const f = files.find((x) => x.oldPath === s.path);
  if (!f) return s;
  if (f.path === null) return null;
  const [start, end] = s.lines;
  let shift = 0;
  for (const r of f.rows) {
    if (r.kind === "ctx") continue;
    if (r.kind === "del" ? r.old >= start && r.old <= end : r.old > start && r.old <= end) return null;
    if (r.kind === "del" ? r.old < start : r.old <= start) shift += r.kind === "del" ? -1 : 1;
  }
  return { path: f.path, lines: [start + shift, end + shift] };
}

export const changedLines = (patch: string) => parseDiff(patch).reduce((n, f) => n + f.rows.filter((r) => r.kind !== "ctx").length, 0);

// Claude Code loads these files as instructions when a session reads files in their folder. A case stores each one with
// FIXTURE_SUFFIX, so the fixtures never steer a session in this repository. buildRepo writes it under its real name.
export const INSTRUCTION_FILE = /^(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/i;
// The GitHub dependency graph reads these manifests and raises Dependabot alerts for the pinned sample versions. A case stores
// each one with FIXTURE_SUFFIX too. Nothing installs them.
export const MANIFEST_FILE = /^(package\.json|pyproject\.toml|requirements.*\.txt)$/i;
export const FIXTURE_SUFFIX = ".fixture";
const storedRenamed = (name: string) => INSTRUCTION_FILE.test(name) || MANIFEST_FILE.test(name);
// The patch from base/ to the earlier head of a re-review fixture. head.patch also starts at base/.
export const EARLIER_PATCH = "earlier.patch";
// The patch from base/ to the head of the parent PR of a stacked fixture. head.patch then starts at the parent head.
export const PARENT_PATCH = "parent.patch";
// The target branch of the PR of a case: parent for a stacked fixture with a parent, else main (buildRepo).
export const targetBranch = (c: Pick<EvalCase, "stack">) => (c.stack?.parent ? "parent" : "main");
// The PR note of the source run of a local case (local.ts), beside case.json. run.ts gives it to the brief only with --notes.
export const NOTE_FILE = "note.md";
// The submodule repository of a submodule fixture: the files of its base commit, and the patch to its head commit.
export const SUB_BASE = "sub/base";
export const SUB_PATCH = "sub/head.patch";

export function loadCase(dir: string): EvalCase {
  const text = readFileSync(join(dir, "case.json"), "utf8");
  const raw = JSON.parse(text) as unknown;
  const folder = dir.replaceAll("\\", "/").split("/").at(-1);
  if (raw !== null && typeof raw === "object" && "bundle" in raw) {
    const c = localCaseFile.parse(raw);
    if (c.id !== folder) throw new Error(`Case ${c.id} is in the folder ${folder}.`);
    const bundle = resolve(dir, "../../bundles", c.bundle.file);
    if (!existsSync(bundle)) throw new Error(`Case ${c.id}: the bundle ${c.bundle.file} is missing. Build the set again.`);
    const hash = createHash("sha256").update(text).digest("hex");
    const { rereview, ...rest } = c;
    const note = join(dir, NOTE_FILE);
    return {
      ...rest,
      ...(existsSync(note) && { note: readFileSync(note, "utf8") }),
      ...(rereview && { rereview: { earlier: rereview.earlier } }),
      dir,
      base: new Map(),
      patch: "",
      local: {
        bundle,
        base: c.bundle.base,
        head: c.bundle.head,
        hash,
        ...(rereview && { since: rereview.since, sinceBase: rereview.sinceBase }),
      },
    };
  }
  const c = caseFile.parse(raw);
  if (c.id !== folder) throw new Error(`Case ${c.id} is in the folder ${folder}.`);
  const baseDir = join(dir, "base");
  const base = new Map(
    files(baseDir).map((p) => {
      const name = (q: string) => q.split("/").at(-1) ?? "";
      if (storedRenamed(name(p))) throw new Error(`Case ${c.id}: store ${p} as ${p}${FIXTURE_SUFFIX}.`);
      const real = p.slice(0, -FIXTURE_SUFFIX.length);
      return [p.endsWith(FIXTURE_SUFFIX) && storedRenamed(name(real)) ? real : p, readFileSync(join(baseDir, p), "utf8")];
    }),
  );
  if (!base.size) throw new Error(`Case ${c.id} has no base files.`);
  const patch = readFileSync(join(dir, "head.patch"), "utf8");
  if (c.rereview && !existsSync(join(dir, EARLIER_PATCH))) throw new Error(`Case ${c.id} has a rereview block but no ${EARLIER_PATCH}.`);
  // run.ts points refs/heads/main at the base of a re-review, so the parent branch would not hold.
  if (c.stack && c.rereview) throw new Error(`Case ${c.id} has a stack and a rereview block.`);
  if ((c.stack?.parent !== undefined) !== existsSync(join(dir, PARENT_PATCH)))
    throw new Error(`Case ${c.id} needs ${PARENT_PATCH} exactly when its stack has a parent.`);
  if (!!c.submodule !== existsSync(join(dir, SUB_PATCH)))
    throw new Error(`Case ${c.id} needs ${SUB_PATCH} exactly when it has a submodule.`);
  // The moved gitlink adds one removed and one added "Subproject commit" line to the diff.
  return { ...c, dir, base, patch, changedLines: changedLines(patch) + (c.submodule ? 2 : 0) };
}

// ids: case IDs, or "all". The order is the folder order.
export function loadCases(ids: string, root = CASES_DIR): EvalCase[] {
  const all = readdirSync(root)
    .filter((f) => existsSync(join(root, f, "case.json")))
    .sort();
  if (ids === "all") return all.map((f) => loadCase(join(root, f)));
  const want = ids.split(",").map((s) => s.trim());
  const unknown = want.filter((id) => !all.includes(id));
  if (unknown.length) throw new Error(`Unknown case: ${unknown.join(", ")}. Known cases: ${all.join(", ")}.`);
  return all.filter((f) => want.includes(f)).map((f) => loadCase(join(root, f)));
}

// The current fixture of a case ID in any set, or null.
export function findCase(id: string): EvalCase | null {
  if (!CASE_ID.test(id)) return null;
  const dir = Object.values(SETS)
    .map((s) => join(s, id))
    .find((d) => existsSync(join(d, "case.json")));
  return dir ? loadCase(dir) : null;
}

// A fixed identity and date, so a case gives the same commits on each run.
const AUTHOR = {
  GIT_AUTHOR_NAME: "Eval Author",
  GIT_AUTHOR_EMAIL: "eval@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Eval Author",
  GIT_COMMITTER_EMAIL: "eval@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

// A bare repository in root: main holds the base commit, feature and refs/pull-requests/1/from hold base plus head.patch.
// The git config is isolated, so no user filter or hook changes the files. A re-review fixture also makes the earlier head (base plus
// earlier.patch, child of base), and the head becomes its child, as a push of new commits does. A stacked fixture with a parent also
// makes refs/heads/parent (base plus parent.patch, child of base), and the head becomes its child. Then base is the parent head, the
// target of the PR, and main keeps the base commit. A submodule fixture also makes the bare repository sub.git, whose main holds the head
// of sub/base plus sub/head.patch. The base commit gets .gitmodules and the gitlink at the submodule base, and the head moves the gitlink.
export async function buildRepo(c: Pick<EvalCase, "base" | "dir" | "pr" | "rereview" | "stack" | "submodule">, root: string) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = { ...gitEnv(empty), ...AUTHOR, GIT_INDEX_FILE: join(root, "eval.index") };
  const bare = async (name: string, index: string) => {
    const at = join(root, name);
    const e = { ...env, GIT_INDEX_FILE: join(root, index) };
    await git(["init", "-q", "--bare", "--template=", at], { env: e });
    return async (args: string[], stdin?: string) => (await git(["--git-dir", at, ...args], { env: e, stdin })).trim();
  };
  // Writes the files as blobs and sets the index to them and to the extra index-info lines.
  const index = async (g: (args: string[], stdin?: string) => Promise<string>, tag: string, list: [string, string][], extra: string[]) => {
    const blobs = list.map(([, text], i) => {
      const f = join(root, `${tag}blob-${i}`);
      writeFileSync(f, text);
      return f;
    });
    const shas = (await g(["hash-object", "-w", "--no-filters", "--stdin-paths"], `${blobs.join("\n")}\n`)).split("\n");
    await g(["update-index", "--index-info"], `${[...list.map(([p], i) => `100644 ${shas[i]}\t${p}`), ...extra].join("\n")}\n`);
  };
  // git apply refuses a patch with no file in it. A submodule fixture can move only the gitlink.
  const apply = async (g: (args: string[]) => Promise<string>, patch: string) => {
    if (statSync(patch).size) await g(["apply", "--cached", "--whitespace=nowarn", patch]);
  };
  let sub: { url: string; base: string; head: string } | undefined;
  if (c.submodule) {
    const s = await bare("sub.git", "sub.index");
    const subBase = join(c.dir, SUB_BASE);
    await index(
      s,
      "sub-",
      files(subBase).map((p) => [p, readFileSync(join(subBase, p), "utf8")]),
      [],
    );
    const first = await s(["commit-tree", await s(["write-tree"]), "-m", "base"]);
    await apply(s, join(c.dir, SUB_PATCH));
    const last = await s(["commit-tree", await s(["write-tree"]), "-p", first, "-m", c.submodule.title]);
    await s(["update-ref", "refs/heads/main", last]);
    sub = { url: join(root, "sub.git"), base: first, head: last };
  }
  const url = join(root, "remote.git");
  const g = await bare("remote.git", "eval.index");
  const m = c.submodule;
  const modules: [string, string][] = m ? [[".gitmodules", `[submodule "${m.path}"]\n\tpath = ${m.path}\n\turl = ${m.url}\n`]] : [];
  await index(g, "", [...c.base.entries(), ...modules], sub && m ? [`160000 ${sub.base}\t${m.path}`] : []);
  const main = await g(["commit-tree", await g(["write-tree"]), "-m", "base"]);
  let base = main;
  if (c.stack?.parent) {
    await apply(g, join(c.dir, PARENT_PATCH));
    base = await g(["commit-tree", await g(["write-tree"]), "-p", main, "-m", c.stack.parent.title]);
  }
  let since: string | undefined;
  if (c.rereview) {
    await apply(g, join(c.dir, EARLIER_PATCH));
    since = await g(["commit-tree", await g(["write-tree"]), "-p", base, "-m", "earlier"]);
    await g(["read-tree", base]);
  }
  await apply(g, join(c.dir, "head.patch"));
  if (sub && m) await g(["update-index", "--cacheinfo", `160000,${sub.head},${m.path}`]);
  const head = await g(["commit-tree", await g(["write-tree"]), "-p", since ?? base, "-m", c.pr.title]);
  await pointRefs(url, env, main, head);
  if (base !== main) await g(["update-ref", "refs/heads/parent", base]);
  // The file text of a commit, for checks of the case lines.
  const show = (commit: string, path: string) => git(["--git-dir", url, "show", `${commit}:${path}`], { env });
  return { url, base, head, env, show, ...(since && { since, sinceBase: base }), ...(sub && { sub }) };
}

// Points the remote refs of buildRepo at one head and its target: the earlier head of a re-review first, then the head.
export async function pointRefs(url: string, env: Record<string, string>, target: string, head: string) {
  for (const [ref, sha] of [
    ["refs/heads/main", target],
    ["refs/heads/feature", head],
    ["refs/pull-requests/1/from", head],
  ] as const)
    await git(["--git-dir", url, "update-ref", ref, sha], { env });
}

// The remote of a local case, with the refs of buildRepo. shared: one bare repository per bundle file, made in root on first use.
// Cases run one at a time, so the refs of a case hold while it runs.
export async function bundleRepo(local: LocalRepo, root: string, shared: Map<string, string>) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = gitEnv(empty);
  let url = shared.get(local.bundle);
  if (url === undefined) {
    url = join(root, `bundle-${shared.size}.git`);
    await git(["init", "-q", "--bare", "--template=", url], { env });
    await git(["--git-dir", url, "fetch", "-q", "--no-tags", "--end-of-options", local.bundle, "+refs/*:refs/*"], { env });
    shared.set(local.bundle, url);
  }
  await pointRefs(url, env, local.base, local.head);
  return { url, env, base: local.base, head: local.head, since: local.since, sinceBase: local.sinceBase };
}
