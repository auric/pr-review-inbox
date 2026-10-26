// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build loop of a task part (docs/plans/review-v2/spec.md sections 6.2, 6.7, and 6.14; design.md section 5.5 "Loop of one part"):
// the part rows, the plan commit, the setup commands, the tests step, the implement and fix steps, the checks, the commits with ticks,
// the size check, the own review, the blocked reasons, pause, resume, stop, and the waits for the run slot. advance() and
// advancePart() make every state change. A restart or a resume starts again from the last commit of the part branch: the commit rows
// and the ticks of the plan file tell what is done.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initialTransition } from "xstate";
import { indentBlock, oneLine } from "../../shared/consult";
import type { TaskAnswersInput } from "../../shared/dto";
import type { FindingPayload } from "../../shared/review";
import {
  FAILURE_TAIL,
  type ImplementResult,
  LARGE_REPOS_TEXT,
  type StepMode,
  TASK_STATE_TEXT,
  type TaskBlocked,
  type TaskSize,
  taskBlocked,
  taskSettings,
} from "../../shared/task";
import type { Live } from "../live";
import { log } from "../log";
import { DEFAULT_PROFILE, type Profile, profileOf } from "../review/catalog";
import { identity } from "../review/clone";
import { fold } from "../review/edits";
import type { ReviewJobs, TaskReviewStart } from "../review/jobs";
import type { Ending } from "../review/judge";
import { repoPath } from "../review/validate";
import { type BranchRemote, type ContextFile, cachePath, longPath, noUrl } from "../review/workspace";
import { branchPrefixesOf, type Settings } from "../settings";
import { CHECK_KINDS, type ChecksResult, checkStep, type Scope } from "./checks";
import { commitTask, endStep, insertStep, type PathProblem, partBudget, runningStep, type StepOutcome, startStep } from "./implement";
import { type Answer, answerProblem, type QuestionRow } from "./interview";
import { partMachine } from "./machine";
import { type Docs, docNames, type Plan, type PlanPart, type PlanTask, parsePlan, parseTasks, partStepFile, stepFile } from "./plan";
import { type PreflightDeps, preflight } from "./preflight";
import { sourceOf, type TaskRepoRow, taskRepos } from "./repos";
import {
  advance,
  advancePart,
  budgetOf,
  docsOf,
  moreTime,
  mustFixPoint,
  openPoints,
  repoSettings,
  setBlocked,
  setSettings,
  stepAnswers,
  stopForRun,
  TASK_CHANGED,
  type TaskResult,
  type TaskRow,
  taskDto,
  taskFilesOf,
  taskRow,
  taskSettingsOf,
} from "./tasks";
import {
  branchName,
  firstFree,
  freeBranch,
  headOf,
  mergeBase,
  noneChanges,
  openRepoTrees,
  openWorktree,
  patchFile,
  type RepoTree,
  remoteBranches,
  resetTrees,
  resetWorktree,
  savePatch,
  setupMark,
  status,
  takenBranches,
  takeRemoteBranch,
  type Worktree,
  wtGit,
} from "./worktree";

// spec.md section 0.
export const TEST_FIX_TRIES = 3;
export const REVIEW_FIX_TRIES = 2;
// spec.md section 6.1, Counting: the excluded globs when the repository sets none.
export const LOCK_GLOBS = ["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "*.lock"];
export const PAUSED = "Building is paused after the step. Continue?";
const NO_TEST = "Needs you: approve a test command for this repository first. The build needs it to see red and green tests.";
const BUSY = "The build still ends its step. Try again when it ends.";

// The loop stops here: a reason now blocks the task, or the task stopped. The reason is already stored.
class Halt extends Error {}

// gitignore(5) pattern rules: a pattern without "/" matches a name at any depth, a "/" at the start or in the middle anchors it to the
// top folder, and a "/" at the end matches a folder and every path below it.
export function globMatch(pattern: string, path: string): boolean {
  const folder = pattern.endsWith("/");
  const core = folder ? pattern.slice(0, -1) : pattern;
  const body = core.startsWith("/") ? core.slice(1) : core;
  const glob = new Bun.Glob(folder ? `${body}/**` : body);
  if (core.includes("/")) return glob.match(path);
  const parts = path.split("/");
  for (let k = 0; k < parts.length; k++) if (glob.match(parts.slice(k).join("/"))) return true;
  return false;
}

export type LineCount = { files: number; added: number; removed: number; lines: number };

// spec.md section 6.1, Counting: the added and removed lines of `git diff --numstat <base>..<head>` without the paths of the excluded
// globs. A binary file counts 0. git-diff(1), --numstat with -z: a rename has an empty path, then the old and the new path.
export async function changedLines(wt: Worktree, base: string, head: string, exclude: readonly string[]): Promise<LineCount> {
  // spec.md section 6.16.6: gitlink entries do not count.
  const out = (await wtGit(wt, ["diff", "--numstat", "-z", "-M", "--ignore-submodules=all", base, head])).split("\0");
  let files = 0;
  let added = 0;
  let removed = 0;
  for (let k = 0; k < out.length; k++) {
    const rec = out[k];
    if (!rec) continue;
    const [a, r, named] = rec.split("\t");
    let path = named ?? "";
    if (!path) {
      k += 2;
      path = out[k] ?? "";
    }
    if (exclude.some((g) => globMatch(g, path))) continue;
    files++;
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { files, added, removed, lines: added + removed };
}

// "<spec_dir>/<name>.md" as a repository path.
const specPath = (specDir: string, name: string) => `${specDir.replace(/\/+$/, "")}/${name}.md`;
const onDisk = (wt: Worktree, path: string) => join(wt.repo, ...path.split("/"));
const under = (path: string, dir: string) => {
  const a = path.split("/").map(fold);
  const b = dir.split("/").filter(Boolean).map(fold);
  return a.length > b.length && b.every((x, i) => a[i] === x);
};
const same = (a: string, b: string) =>
  (repoPath(a) ?? a).split("/").map(fold).join("/") === (repoPath(b) ?? b).split("/").map(fold).join("/");

// The tick of a task in the tasks grammar (spec.md section 6.4). null: the plan has no open task with this ID.
export function tickTask(text: string, id: string): string | null {
  const re = new RegExp(`^### \\[ \\] ${id.replaceAll(".", "\\.")} `, "m");
  return re.test(text) ? text.replace(re, `### [x] ${id} `) : null;
}

// context/failure.md of a fix step after red checks: the failed commands with the end of their output. All tails together stay
// within FAILURE_TAIL (spec.md section 0, OUTPUT_TAIL: 32 KB sent to Claude).
export function checkFailure(r: Extract<ChecksResult, { status: "ran" }>): ContextFile {
  const failed = r.commands.filter((c) => c.exit !== 0);
  const each = Math.floor(FAILURE_TAIL / Math.max(1, failed.length));
  const out = [
    "# Check output",
    "",
    "The app ran the approved commands after your step. After a task, the test command runs only the tests of the task. These commands failed. Each shows the end of its output.",
    "",
  ];
  for (const c of failed) {
    const tail = Buffer.from(c.tail);
    const text = tail.length > each ? tail.subarray(tail.length - each).toString() : c.tail;
    out.push(`## ${oneLine(c.name)}: ${c.exit === null ? "no exit code" : `exit ${c.exit}`} after ${c.ms} ms`, "");
    out.push(`- Command: ${oneLine(c.argv.join(" "))}`, "", indentBlock(text.trimEnd() || "(no output)"), "");
  }
  return { name: "failure.md", text: out.join("\n") };
}

type Point = { id: number; payload: FindingPayload };

// The points of the own review that the loop fixes: confirmed blocker and major findings (spec.md section 6.7).
export const mustFix = (points: Point[]) => points.filter((p) => mustFixPoint(p.payload));

// context/failure.md of a fix step after the own review: the confirmed points with path:line.
export function reviewFailure(points: Point[]): ContextFile {
  const out = ["# Review points", "", "Claude's own review of this part confirmed these points. Fix the cause of each one.", ""];
  for (const { id, payload: f } of points) {
    out.push(`## Point ${id}: ${f.severity} at ${oneLine(f.path)}:${f.line}`, "", indentBlock(f.body.trim() || "(no text)"), "");
    if (f.trigger?.trim()) out.push(`- Trigger: ${oneLine(f.trigger)}`, "");
  }
  return { name: "failure.md", text: out.join("\n") };
}

type PartRow = { id: number; ord: number; kind: string; title: string; branch: string; base_branch: string; state: string };

type Ctx = {
  db: Database;
  id: number;
  t: TaskRow;
  part: PartRow;
  wt: Worktree;
  base: string;
  size: TaskSize;
  docs: Docs;
  plan: Plan;
  budget: number;
  // "Keep one PR": the line budget stops the part no more.
  keep: boolean;
  exclude: string[];
  testGlobs: string[] | null;
  who: { name: string; email: string } | null;
  profile: Profile;
  // Every repository of the part folder, main first (spec.md section 6.16.5). One entry for a task with one repository.
  trees: RepoTree[];
};

const Q = {
  parts: "SELECT id, ord, kind, title, branch, base_branch, state FROM task_part WHERE task = $task ORDER BY ord",
  // pushed: the lease of the first push, the fetched remote head for Continue (spec.md section 6.16.4).
  insertPart: `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, pushed, state, created_at, updated_at)
    VALUES ($task, $ord, $kind, $title, $branch, $base, $pushed, $state, $now, $now) RETURNING id`,
  setBase: "UPDATE task SET base_commit = $base WHERE id = $id",
  attempt: "SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM task_step WHERE part = $part AND kind = $kind AND item = $item",
  committed: "SELECT 1 FROM task_step WHERE part = $part AND kind = 'commit' AND item = $item AND state = 'ok'",
  lastStep: "SELECT MAX(id) AS id FROM task_step WHERE part = $part",
  lines: "UPDATE task_part SET lines = $lines, updated_at = $now WHERE id = $id",
  clone: "SELECT path FROM repo_clone WHERE project = $project AND repo = $repo",
  points: "SELECT id, payload_json FROM review_item WHERE run = $run AND kind = 'finding' ORDER BY id",
  question: `INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, recommended, step, asked_at)
    VALUES ($task, 'loop', (SELECT COALESCE(MAX(round), 0) + 1 FROM task_question WHERE task = $task), 0, $text, $why, $kind, $options,
      $recommended, $step, $now)`,
  openLoop: "SELECT * FROM task_question WHERE task = $task AND source = 'loop' AND answer_json IS NULL ORDER BY id",
  answer: "UPDATE task_question SET answer_json = $answer, answered_at = $now WHERE id = $id AND answer_json IS NULL",
  step: "SELECT id, part, kind, item, state, detail_json FROM task_step WHERE id = $id AND task = $task",
  subLines: "UPDATE task_pr SET lines = $lines WHERE part = $part AND task_repo = $repo",
  subBase: "UPDATE task_repo SET base_commit = $base WHERE id = $id",
  subLease: `INSERT INTO task_pr (part, task_repo, branch, base_branch, base_commit, head, pushed, state)
    VALUES ($part, $repo, $branch, $base, $commit, $lease, $lease, 'changed') ON CONFLICT (part, task_repo) DO NOTHING`,
};

// The changed paths of every worktree, from the main repository root.
async function dirty(trees: readonly RepoTree[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of trees) if (t.wt) for (const e of await status(t.wt)) out.push(t.full ? `${t.full}/${e.path}` : e.path);
  return out;
}

// true: the folder of a repository with access none holds something.
const noneDirty = (trees: readonly RepoTree[], t: RepoTree) =>
  t.row.access === "none" && !!trees.find((x) => x.row.id === t.row.parent)?.wt && noneChanges(trees, t).length > 0;

// A changed submodule with access edit: its task branch head differs from its base and the diff is not empty (spec.md section
// 6.16.6, Changed repositories).
type ChangedSub = { tree: RepoTree; base: string; head: string };

export type LoopOptions = { review: ReviewJobs; settings: Settings; live: Live; now?: () => number };

export function createLoop(opts: LoopOptions) {
  const { review, settings, live } = opts;
  const now = opts.now ?? Date.now;
  const dataDir = review.dataDir;
  // One driver per task. It awaits each step and ends at the first blocked reason.
  const drivers = new Map<number, Promise<void>>();
  // Pause after this step: the next Claude step waits at the gate until Resume.
  const pauseAsked = new Set<number>();
  const gates = new Map<number, () => void>();
  const slotWaits = new Map<number, () => void>();
  const aborts = new Map<number, AbortController>();
  let closing = false;

  const changed = (id: number) => live.broadcast("changed", { tasks: [id] });
  const dto = (db: Database, id: number) => taskDto(db, taskRow(db, id) as TaskRow);
  const conflict = (db: Database, id: number, error: string): TaskResult => {
    const t = taskRow(db, id);
    return t ? { status: 409, error, task: taskDto(db, t) } : { status: 404, error: "Task not found." };
  };
  const blockedOf = (t: TaskRow): TaskBlocked | null => {
    if (t.blocked_json === null) return null;
    const r = taskBlocked.safeParse(JSON.parse(t.blocked_json));
    return r.success ? r.data : null;
  };
  const parts = (db: Database, id: number) => db.query(Q.parts).all({ task: id }) as PartRow[];
  const building = (db: Database, id: number) => parts(db, id).find((p) => p.state === "implementing") ?? null;

  // Sets the reason while the task builds. block() also ends the driver.
  function reason(db: Database, id: number, b: TaskBlocked | null) {
    db.transaction(() => {
      const cur = taskRow(db, id);
      if (cur?.state === "implementing") setBlocked(db, { task: id, version: cur.version }, b, now());
    })();
    changed(id);
  }
  function block(c: Ctx, b: TaskBlocked): never {
    reason(c.db, c.id, b);
    throw new Halt();
  }
  // The loop goes on only while the task builds with no reason.
  function guard(c: Ctx) {
    const t = taskRow(c.db, c.id);
    if (closing || !t || t.state !== "implementing" || t.blocked_json !== null) throw new Halt();
  }

  const preflightDeps: PreflightDeps = {
    dataDir,
    provider: () => settings.provider().catch(() => null),
    remote: (project, repo) => review.taskRemote(project, repo),
    now,
  };

  // The branch of the building part, or the name that ensureParts starts from.
  const plannedBranch = (db: Database, t: TaskRow) =>
    building(db, t.id)?.branch ??
    branchName(taskSettingsOf(t).branchPrefix ?? (branchPrefixesOf(settings.config())[0] as string), t.key, {
      kind: "small",
      title: t.title,
    });

  async function changedSubs(c: Ctx): Promise<ChangedSub[]> {
    const out: ChangedSub[] = [];
    for (const tree of c.trees) {
      if (tree.row.role !== "submodule" || tree.row.access !== "edit" || !tree.wt) continue;
      const base = tree.row.base_commit ?? tree.row.pinned;
      const head = await headOf(tree.wt);
      if (!base || head === base) continue;
      if ((await wtGit(tree.wt, ["diff", "--numstat", base, head])).trim()) out.push({ tree, base, head });
    }
    return out;
  }

  const nextAttempt = (c: Ctx, kind: string, item: string) =>
    (c.db.query(Q.attempt).get({ part: c.part.id, kind, item }) as { n: number }).n;

  // ---------- Context of a Claude step (spec.md section 6.7) ----------

  // The plan files of the branch: context/spec/<name>.md.
  function planFiles(c: Ctx): ContextFile[] {
    return docNames(c.size).flatMap((n) => {
      const p = onDisk(c.wt, specPath(c.t.spec_dir, n));
      return existsSync(p) ? [{ name: `spec/${n}.md`, text: readFileSync(p, "utf8") }] : [];
    });
  }

  // The plan as the branch holds it, with the ticks of the done tasks.
  function readPlan(c: Pick<Ctx, "wt" | "t" | "size" | "docs">): Plan | { error: string } {
    const name = c.size === "small" ? "plan" : "tasks";
    const p = onDisk(c.wt, specPath(c.t.spec_dir, name));
    if (!existsSync(p)) return { error: `The branch has no ${specPath(c.t.spec_dir, name)}.` };
    const text = readFileSync(p, "utf8").replaceAll("\r\n", "\n");
    const r = name === "plan" ? parsePlan(text, c.docs.parsed.parts) : parseTasks(text, c.docs.parsed.parts);
    return "error" in r ? { error: r.error } : { ...c.docs.parsed, parts: r.parts };
  }

  function refreshPlan(c: Ctx) {
    const p = readPlan(c);
    if ("error" in p) block(c, { kind: "error", step: null, text: `Needs you: ${p.error}` });
    c.plan = p;
  }

  // ---------- Steps ----------

  // Waits for the run slot (design.md B12). The step row waits too, and the reason says whose run holds the slot.
  async function waitSlot(
    c: Ctx,
    s: { kind: "tests" | "implement" | "fix" | "review"; item: string; attempt: number },
    holder: { pr: number | null; kind: string; task?: number },
    waiting: number | null,
  ): Promise<number> {
    const step = waiting ?? insertStep(c.db, { task: c.id, part: c.part.id, ...s, state: "waiting" }, now());
    const pr =
      holder.pr === null
        ? null
        : (c.db.query("SELECT pr_id FROM pull_request WHERE id = $id").get({ id: holder.pr }) as { pr_id: number } | null);
    const other = holder.task === undefined ? null : taskRow(c.db, holder.task);
    const NOUN: Record<string, string> = {
      review: "review",
      ask: "question",
      explain: "explanation",
      reply: "reply drafts",
      fix: "fix",
      discuss: "talk",
    };
    const text = pr
      ? `Waiting for your ${NOUN[holder.kind] ?? "run"} of PR ${pr.pr_id} to finish.`
      : other
        ? `Waiting for the build of ${other.key} to free the run slot.`
        : "Waiting for the other run to finish.";
    reason(c.db, c.id, { kind: "slot", step, text });
    await new Promise<void>((resolve) => {
      const off = review.onFree(resolve);
      slotWaits.set(c.id, () => {
        off();
        resolve();
      });
    });
    slotWaits.delete(c.id);
    c.db.transaction(() => {
      const cur = taskRow(c.db, c.id);
      if (cur?.state === "implementing" && blockedOf(cur)?.kind === "slot")
        setBlocked(c.db, { task: c.id, version: cur.version }, null, now());
    })();
    const t = taskRow(c.db, c.id);
    if (closing || !t || t.state !== "implementing" || t.blocked_json !== null) {
      endStep(c.db, step, "cancelled", { notes: ["The build stopped while the step waited for the run slot."] }, now());
      changed(c.id);
      throw new Halt();
    }
    return step;
  }

  // Pause after this step: the loop holds before it takes the run slot again, with every change of the done step kept.
  async function gate(c: Ctx) {
    if (!pauseAsked.delete(c.id)) return;
    reason(c.db, c.id, { kind: "question", step: null, text: PAUSED });
    await new Promise<void>((resolve) => gates.set(c.id, resolve));
    gates.delete(c.id);
    guard(c);
  }

  // One Claude step in the run slot (implement.ts). It returns only a step with a result: a denied path, a failed run, a question, and a
  // plan change set their reason and halt.
  async function claude(
    c: Ctx,
    mode: StepMode,
    item: string,
    o: { allow: string[]; step: (attempt: number) => ContextFile; failure?: ContextFile },
  ): Promise<StepOutcome & { result: ImplementResult; fresh: string[] }> {
    let waiting: number | null = null;
    for (;;) {
      await gate(c);
      guard(c);
      const attempt = nextAttempt(c, mode, item);
      const before = new Set(await dirty(c.trees));
      const answers = stepAnswers(c.db, c.id);
      // spec.md section 6.17: the task text and the included files as they are at this step.
      const task = taskFilesOf(c.db, dataDir, c.t);
      let out: StepOutcome | null = null;
      const s = await startStep({
        db: c.db,
        review,
        task: c.id,
        part: { id: c.part.id, ord: c.part.ord },
        wt: c.wt,
        mode,
        item,
        attempt,
        profile: c.profile,
        untrusted: [...task.files.filter((f) => f.name === "task.md"), ...(o.failure ? [o.failure] : [])],
        attachments: task.attachments,
        own: [...(answers ? [answers] : []), o.step(attempt), ...planFiles(c)],
        allow: o.allow,
        specDir: c.t.spec_dir,
        onEnd: (x) => {
          out = x;
        },
        step: waiting,
        trees: c.trees,
        now,
      });
      if (s.status === 409 && "conflict" in s) {
        waiting = await waitSlot(c, { kind: mode, item, attempt }, s.conflict.running, waiting);
        continue;
      }
      changed(c.id);
      if (s.status !== 202) throw new Halt();
      await s.done;
      changed(c.id);
      const r = out as StepOutcome | null;
      // No result: implement.ts stopped the task, or it set the denied path. No outcome: restart recovery ended the run first.
      if (!r?.result) throw new Halt();
      const fresh = r.changed.filter((p) => !before.has(p));
      const spec = fresh.filter((p) => under(p, c.t.spec_dir));
      if (spec.length) {
        const step = insertStep(c.db, { task: c.id, part: c.part.id, kind: "spec_change", item, attempt, state: "ok" }, now());
        endStep(c.db, step, "ok", { specChange: { paths: spec }, notes: r.result.specChange ? [r.result.specChange] : [] }, now());
        block(c, { kind: "spec_change", step, text: "Needs you: Claude proposes a change to the spec." });
      }
      const q = r.result.question;
      if (q) {
        c.db.transaction(() => {
          c.db.query(Q.question).run({
            task: c.id,
            text: q.text,
            why: q.why,
            kind: q.options.length >= 2 ? "choice" : "text",
            options: JSON.stringify(q.options.length >= 2 ? q.options : []),
            recommended: q.options.length >= 2 && q.recommended !== null && q.recommended < q.options.length ? q.recommended : null,
            step: r.step,
            now: now(),
          });
        })();
        block(c, { kind: "question", step: r.step, text: `Needs you: Claude asks: ${oneLine(q.text)}` });
      }
      return { ...r, result: r.result, fresh };
    }
  }

  // The approved checks with their step row. A stop kills the commands (AC-B19).
  async function checks(c: Ctx, item: string, kinds = CHECK_KINDS, scope?: Scope, expectRed = false) {
    guard(c);
    const ac = new AbortController();
    aborts.set(c.id, ac);
    try {
      changed(c.id);
      const r = await checkStep({
        db: c.db,
        dataDir,
        project: c.t.project,
        repo: c.t.repo,
        wt: c.wt,
        kinds,
        scope,
        signal: ac.signal,
        task: c.id,
        part: c.part.id,
        item,
        attempt: nextAttempt(c, "check", item),
        expectRed,
        now,
      });
      changed(c.id);
      if (r.status === "refused") block(c, { kind: "error", step: r.step, text: `Needs you: ${r.reason}` });
      if (r.commands.some((x) => x.stopped)) throw new Halt();
      guard(c);
      return r;
    } finally {
      aborts.delete(c.id);
    }
  }

  // spec.md section 6.1: the changed lines of the part against the line budget. Over it, the part waits for the user's choice.
  async function sizeCheck(c: Ctx) {
    const n = await changedLines(c.wt, c.base, await headOf(c.wt), c.exclude);
    c.db.query(Q.lines).run({ id: c.part.id, lines: n.lines, now: now() });
    // spec.md section 6.16.6, Line budget: the sum over the changed repositories.
    for (const s of await changedSubs(c)) {
      const m = await changedLines(s.tree.wt as Worktree, s.base, s.head, c.exclude);
      c.db.query(Q.subLines).run({ part: c.part.id, repo: s.tree.row.id, lines: m.lines });
      n.files += m.files;
      n.added += m.added;
      n.removed += m.removed;
      n.lines += m.lines;
    }
    if (n.lines <= c.budget || c.keep) return;
    const text = `Needs you: this PR would have ${n.lines} changed lines, over your ${c.budget} limit.`;
    const step = insertStep(c.db, { task: c.id, part: c.part.id, kind: "size", item: null, state: "failed" }, now());
    endStep(c.db, step, "failed", { diffStat: n, notes: [text] }, now());
    block(c, { kind: "size", step, text });
  }

  const deniedText = (p: PathProblem[]) =>
    `Needs you: the checks left ${p
      .slice(0, 3)
      .map((x) => x.path)
      .join(", ")}${p.length > 3 ? ` and ${p.length - 3} more` : ""}, which the app does not commit.`;

  // spec.md section 6.7, Commit: one commit per step with the user's name and email, then the size check.
  async function commit(c: Ctx, item: string, message: string, allow: string[]) {
    guard(c);
    if (!c.who) block(c, { kind: "error", step: null, text: "Needs you: set user.name and user.email in your git config." });
    // spec.md section 6.16.5, Size: a large build that changes a submodule stops.
    if (c.size === "large")
      for (const s of c.trees)
        if (s.row.role === "submodule" && s.wt && (await status(s.wt)).length)
          block(c, { kind: "size", step: null, text: LARGE_REPOS_TEXT });
    const r = await commitTask({ db: c.db, task: c.id, part: c.part.id, wt: c.wt, item, message, who: c.who, allow, trees: c.trees, now });
    if (r.status === "refused") block(c, { kind: "denied_path", step: null, text: deniedText(r.problems) });
    changed(c.id);
    await sizeCheck(c);
  }

  // Red checks start at most TEST_FIX_TRIES fix steps (AC-B11). scope: the scoped check of one task instead of all approved checks.
  async function greenOrFix(c: Ctx, item: string, allow: string[], step: (attempt: number) => ContextFile, scope?: Scope) {
    const run = () => checks(c, item, scope ? ["test"] : CHECK_KINDS, scope);
    let k = await run();
    for (let tries = 0; !k.green; tries++) {
      if (tries >= TEST_FIX_TRIES)
        block(c, {
          kind: "red",
          step: k.step,
          text: `Needs you: the tests of part ${c.part.ord} stay red after ${TEST_FIX_TRIES} tries.`,
        });
      await claude(c, "fix", item, { allow, step, failure: checkFailure(k) });
      k = await run();
    }
  }

  // Saves the uncommitted changes as a patch, then returns the worktree to its last commit (spec.md section 6.7, Resume). Several
  // repositories: a patch per changed worktree, then the reset deepest first (section 6.16.6).
  async function undo(trees: RepoTree[], db: Database, id: number, step: number) {
    const main = trees[0]?.wt as Worktree;
    if (!(await dirty(trees)).length && trees.every((t) => t.wt || !noneDirty(trees, t))) return;
    const file = patchFile(dataDir, db, id, step);
    for (const t of trees) {
      if (!t.wt) continue;
      const paths = (await status(t.wt)).map((e) => e.path);
      if (!paths.length) continue;
      await savePatch(t.wt, t.row.role === "main" ? file : file.replace(/\.patch$/, `-${t.row.id}.patch`), paths).catch((e) =>
        log(`Task ${id}: could not save the patch of step ${step}: ${noUrl((e as Error).message)}`),
      );
    }
    if (trees.length === 1) await resetWorktree(main, await headOf(main));
    else await resetTrees(trees, await headOf(main));
  }

  const testPaths = (pp: PlanPart) => [...pp.tests.map((x) => x.test), ...pp.tasks.flatMap((t) => t.run)];
  // The tests step may change only test files: the test globs of the repository, else the tests that the plan names.
  const isTest = (c: Ctx, pp: PlanPart, path: string) =>
    c.testGlobs ? c.testGlobs.some((g) => globMatch(g, path)) : testPaths(pp).some((x) => same(x, path));

  // spec.md section 6.7: the tests step. Its changes stay in the test paths, and the new tests fail (AC-B10).
  async function testsStep(c: Ctx, pp: PlanPart) {
    const item = `P${pp.n}`;
    const allow = pp.tasks.flatMap((t) => t.files);
    const where = c.testGlobs ? `the test globs ${c.testGlobs.join(", ")}` : `the tests of the plan: ${testPaths(pp).join(", ")}`;
    let failure: ContextFile | undefined;
    for (let round = 0; ; round++) {
      const r = await claude(c, "tests", item, { allow, step: (a) => partStepFile(c.plan, [pp], "tests", a), failure });
      const outside = r.fresh.filter((p) => !isTest(c, pp, p));
      if (!r.fresh.length || outside.length) {
        const why = r.fresh.length ? `The step changed files that are not tests: ${outside.join(", ")}.` : "The step wrote no test.";
        if (round >= 1)
          block(c, { kind: "red", step: r.step, text: `Needs you: the tests step of part ${c.part.ord} failed twice. ${why}` });
        await undo(c.trees, c.db, c.id, r.step);
        failure = { name: "failure.md", text: `# Tests step\n\n${why} Change only test files. The test paths are ${where}.\n` };
        continue;
      }
      const k = await checks(c, item, CHECK_KINDS, undefined, true);
      if (k.green) block(c, { kind: "red", step: k.step, text: "Tests pass before the change. See why." });
      await commit(c, item, `${c.t.key} ${item}: Add the failing tests of part ${pp.n}`, allow);
      return;
    }
  }

  // One task: the implement step, the scoped check of its Run line with the fixes, the tick, and the commit. The tests of the later
  // tasks of the part stay red until their own task, so they never gate this one.
  async function taskStep(c: Ctx, pp: PlanPart, task: PlanTask) {
    const step = (a: number) => stepFile(c.plan, task.id, a) as ContextFile;
    const later = pp.tasks.slice(pp.tasks.findIndex((t) => t.id === task.id) + 1).flatMap((t) => t.run);
    await claude(c, "implement", task.id, { allow: task.files, step });
    await greenOrFix(c, task.id, task.files, step, { run: task.run, later });
    const name = c.size === "small" ? "plan" : "tasks";
    const p = onDisk(c.wt, specPath(c.t.spec_dir, name));
    const ticked = existsSync(p) ? tickTask(readFileSync(p, "utf8"), task.id) : null;
    if (ticked === null) block(c, { kind: "error", step: null, text: `Needs you: ${name}.md has no open task ${task.id}.` });
    writeFileSync(p, ticked);
    await commit(c, task.id, `${c.t.key} ${task.id}: ${oneLine(task.title)}`, task.files);
    refreshPlan(c);
    const s = taskSettings.safeParse(JSON.parse(taskRow(c.db, c.id)?.settings_json ?? "{}"));
    if (s.success && s.data.pauseAfterTask) block(c, { kind: "question", step: null, text: `Task ${task.id} is done. Continue?` });
  }

  // The own review run (kind review, task set, pr NULL) on a snapshot of the part head. sub: a changed submodule instead of the main
  // repository; its run reads that repository's base..head (spec.md section 6.16.5, Snapshots).
  async function reviewRun(c: Ctx, sub?: ChangedSub): Promise<{ step: number; points: Point[] }> {
    let waiting: number | null = null;
    for (;;) {
      await gate(c);
      guard(c);
      // spec.md section 6.17: the task text and the included files as they are at this step.
      const task = taskFilesOf(c.db, dataDir, c.t);
      const issue = task.files.map((f) => f.text).join("\n\n");
      const head = sub ? sub.head : await headOf(c.wt);
      const attempt = nextAttempt(c, "review", "review");
      const src = sub
        ? sourceOf(
            c.trees.map((x) => x.row),
            sub.tree.row,
          )
        : null;
      const plans = planFiles(c).map((f) => `## ${f.name.slice("spec/".length)}\n\n${f.text}`);
      const goals = c.plan.parts.map((x) => `- Part ${x.n}: ${oneLine(x.title)}. ${oneLine(x.goal)}`);
      let ended: { step: number; run: number; ok: boolean } | null = null;
      let step = 0;
      const start: TaskReviewStart = {
        task: c.id,
        kind: "review",
        key: `task:${c.id}:part:${c.part.id}:review:${sub ? `${sub.tree.row.id}:` : ""}${head}:${attempt}`,
        profile: c.profile,
        project: src?.project ?? c.t.project,
        repo: src?.repo ?? c.t.repo,
        base: sub ? sub.base : c.base,
        head,
        taskKey: c.t.key,
        files: [
          { name: "task.md", text: `${issue || "(no task text)"}\n\n# The plan of the task\n\n${plans.join("\n\n")}\n` },
          {
            name: "pr.md",
            text: `# ${c.t.key}: ${oneLine(c.t.title)}\n\nThis change has no pull request yet. The app builds it for task ${c.t.key} on the branch ${c.part.branch}.${sub ? ` This review covers the submodule at ${oneLine(sub.tree.full)} only.` : ""}\n\n## Goal\n\n${goals.join("\n")}\n`,
          },
        ],
        attachments: task.attachments,
        started: (d, run) => {
          step = runningStep(d, { task: c.id, part: c.part.id, kind: "review", run, item: "review", attempt }, waiting, now());
        },
        finish: (d, run, e: Ending) => {
          const ok = e.status === "completed" || e.status === "incomplete";
          const ids = (d.query(Q.points).all({ run: run.id }) as { id: number }[]).map((x) => x.id);
          endStep(
            d,
            step,
            ok ? "ok" : e.status === "cancelled" ? "cancelled" : "failed",
            { findings: ids, notes: ok ? [] : [e.text ?? "The review failed."] },
            now(),
          );
          const cur = taskRow(d, c.id);
          if (!ok && cur) stopForRun(d, { task: c.id, version: cur.version }, step, e, now());
          ended = { step, run: run.id, ok };
          return undefined;
        },
      };
      // headOf() awaited: a Stop can come before the run starts.
      guard(c);
      const s = review.taskRun(c.db, start);
      if (s.status === 409) {
        waiting = await waitSlot(c, { kind: "review", item: "review", attempt }, s.conflict.running, waiting);
        continue;
      }
      changed(c.id);
      await s.done;
      changed(c.id);
      const r = ended as { step: number; run: number; ok: boolean } | null;
      if (!r?.ok) throw new Halt();
      const points = (c.db.query(Q.points).all({ run: r.run }) as { id: number; payload_json: string }[]).map((x) => ({
        id: x.id,
        payload: JSON.parse(x.payload_json) as FindingPayload,
      }));
      return { step: r.step, points };
    }
  }

  // spec.md section 6.7, own review: confirmed blocker and major points start a fix step, the checks, and a new review, at most
  // REVIEW_FIX_TRIES times (AC-B12). The other points stay listed in the review run.
  async function ownReview(c: Ctx) {
    const allow = c.plan.parts.flatMap((x) => x.tasks.flatMap((t) => t.files));
    const step = (a: number) => partStepFile(c.plan, c.plan.parts, "review", a);
    for (let tries = 0; ; tries++) {
      const rv = await reviewRun(c);
      const must = mustFix(rv.points);
      // spec.md section 6.16.5: the own review runs once per changed repository. A submodule point names its path from the main root.
      for (const s of await changedSubs(c)) {
        const sr = await reviewRun(c, s);
        for (const x of mustFix(sr.points)) must.push({ ...x, payload: { ...x.payload, path: `${s.tree.full}/${x.payload.path}` } });
      }
      if (!must.length) return;
      if (tries >= REVIEW_FIX_TRIES) {
        const n = must.length;
        block(c, {
          kind: "blocker",
          step: rv.step,
          text: `Needs you: Claude's review of part ${c.part.ord} still finds ${n} ${n === 1 ? "point" : "points"} to fix after ${REVIEW_FIX_TRIES} fixes.`,
        });
      }
      await claude(c, "fix", "review", { allow, step, failure: reviewFailure(must) });
      await greenOrFix(c, "review", allow, step);
      await commit(c, "review", `${c.t.key}: Fix the review points of part ${c.part.ord}`, allow);
    }
  }

  // ---------- The driver ----------

  // A small task gets one part (spec.md section 6.16.4). A name that exists on the server: Continue builds on its remote head and
  // leases the first push on it. New takes the first free suffix.
  async function ensureParts(db: Database, id: number) {
    const t = taskRow(db, id);
    if (t?.state !== "implementing" || parts(db, id).length) return;
    if (t.size !== "small") throw new Error(`The app builds a ${t.size ?? "task without a size"} task only after its spec PR.`);
    if (!t.base_commit) throw new Error("The task has no approved plan.");
    const s = taskSettingsOf(t);
    const prefix = s.branchPrefix ?? (branchPrefixesOf(settings.config())[0] as string);
    const name = branchName(prefix, t.key, { kind: "small", title: t.title });
    const remote = await review.taskRemote(t.project, t.repo);
    const cache = cachePath(longPath(dataDir), { project: t.project, repo: t.repo, id });
    let branch = name;
    let lease: string | null = null;
    let base = t.base_commit;
    // spec.md section 6.16.4 with several repositories: Continue takes the remote branch where it exists; New takes the first suffix that
    // is free in every repository with access edit.
    const subs = taskRepos(db, t).filter((r) => r.role === "submodule" && r.access === "edit" && r.project && r.repo && r.pinned);
    const subRemotes = await Promise.all(subs.map((r) => review.taskRemote(r.project as string, r.repo as string)));
    const subHeads = await Promise.all(subRemotes.map((r) => remoteBranches(dataDir, r, name)));
    const subLeases: { row: TaskRepoRow; lease: string; base: string }[] = [];
    const mainHeads = await remoteBranches(dataDir, remote, name);
    if ((mainHeads.has(name) || subHeads.some((h) => h.has(name))) && s.existing !== "new") {
      if (mainHeads.has(name)) {
        lease = await takeRemoteBranch(dataDir, cache, remote, id, name);
        const mb = await mergeBase(dataDir, cache, t.base_commit, lease);
        if (!mb) throw new Error(`${name} on the server shares no commit with ${t.target_branch}. Start a new branch.`);
        base = mb;
      }
      for (const [k, row] of subs.entries()) {
        if (!subHeads[k]?.has(name)) continue;
        const subCache = cachePath(longPath(dataDir), { project: row.project as string, repo: row.repo as string, id });
        const l = await takeRemoteBranch(dataDir, subCache, subRemotes[k] as BranchRemote, id, name);
        const mb = await mergeBase(dataDir, subCache, row.pinned as string, l);
        if (!mb) throw new Error(`${name} in ${row.project}/${row.repo} shares no commit with the pinned commit. Start a new branch.`);
        subLeases.push({ row, lease: l, base: mb });
      }
    } else if (!subs.length) branch = await freeBranch(dataDir, cache, remote, name);
    else {
      const taken = await takenBranches(dataDir, cache, remote, name);
      for (const [k, row] of subs.entries()) {
        const subCache = cachePath(longPath(dataDir), { project: row.project as string, repo: row.repo as string, id });
        for (const b of await takenBranches(dataDir, subCache, subRemotes[k] as BranchRemote, name)) taken.add(b);
      }
      branch = firstFree(name, taken);
    }
    db.transaction(() => {
      const cur = taskRow(db, id);
      if (cur?.state !== "implementing" || parts(db, id).length) return;
      const at = now();
      // The line budget and the own review count the whole PR diff from here (spec.md section 6.16.4).
      db.query(Q.setBase).run({ id, base });
      const row = db.query(Q.insertPart).get({
        task: id,
        ord: 1,
        kind: "single",
        title: cur.title,
        branch,
        base: cur.target_branch,
        pushed: lease,
        state: String(initialTransition(partMachine)[0].value),
        now: at,
      }) as { id: number };
      // A submodule that continues a remote branch: its base and its lease (spec.md section 6.16.4).
      for (const x of subLeases) {
        db.query(Q.subBase).run({ id: x.row.id, base: x.base });
        db.query(Q.subLease).run({ part: row.id, repo: x.row.id, branch, base: x.row.base_branch ?? "", commit: x.base, lease: x.lease });
      }
      const r = advancePart(db, { task: id, version: cur.version, part: row.id }, { type: "START" }, {}, at);
      if (r.status !== 200) throw new Error(r.error);
    })();
    changed(id);
  }

  // The worktrees of every repository of a part (spec.md section 6.16.5). One repository: the main worktree only.
  async function trees(db: Database, t: TaskRow, part: PartRow, wt: Worktree): Promise<RepoTree[]> {
    const rows = taskRepos(db, t);
    if (rows.length === 1) return [{ row: rows[0] as TaskRepoRow, full: "", wt }];
    return openRepoTrees({ dataDir, db, task: t.id, ord: part.ord, branch: part.branch, main: wt, rows });
  }

  async function context(db: Database, t: TaskRow, part: PartRow): Promise<Ctx> {
    const docs = docsOf(t);
    if (!docs || !t.base_commit || !t.size) throw new Error("The task has no approved plan.");
    const repo = repoSettings(db, t.project, t.repo);
    const wt = await openWorktree({
      dataDir,
      db,
      project: t.project,
      repo: t.repo,
      task: t.id,
      ord: part.ord,
      branch: part.branch,
      base: t.base_commit,
    });
    const clone = db.query(Q.clone).get({ project: t.project, repo: t.repo }) as { path: string } | null;
    const p = profileOf(settings.profiles(), DEFAULT_PROFILE);
    return {
      db,
      id: t.id,
      t,
      part,
      wt,
      trees: await trees(db, t, part, wt),
      base: t.base_commit,
      size: t.size,
      docs,
      plan: docs.parsed,
      budget: budgetOf(db, t),
      keep: taskSettingsOf(t).keepOnePr === true,
      exclude: repo.excludeGlobs ?? LOCK_GLOBS,
      testGlobs: repo.testGlobs,
      who: await identity(clone?.path ?? null),
      // AC-B12: the own review runs the finder and the verify phase.
      profile: { ...p, verifier: { ...p.verifier, mode: "on" } },
    };
  }

  async function runPart(db: Database, t: TaskRow, part: PartRow) {
    const repo = repoSettings(db, t.project, t.repo);
    if (!repo.commands.some((x) => x.kind === "test")) {
      reason(db, t.id, { kind: "error", step: null, text: NO_TEST });
      throw new Halt();
    }
    const c = await context(db, t, part);
    guard(c);
    // spec.md section 6.4: the plan files go into the part branch first.
    const missing = docNames(c.size).filter((n) => !existsSync(onDisk(c.wt, specPath(t.spec_dir, n))) && c.docs[n] !== undefined);
    for (const n of missing) {
      const p = onDisk(c.wt, specPath(t.spec_dir, n));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c.docs[n] as string);
    }
    if (missing.length) await commit(c, "plan", `${t.key}: Add the plan`, []);
    // spec.md section 6.7: the setup commands once per worktree.
    if (!existsSync(setupMark(c.wt))) {
      if (repo.commands.some((x) => x.kind === "setup")) {
        const r = await checks(c, "setup", ["setup"]);
        if (!r.green) block(c, { kind: "red", step: r.step, text: `Needs you: the setup commands of part ${part.ord} failed. See why.` });
      }
      writeFileSync(setupMark(c.wt), "");
    }
    await sizeCheck(c);
    refreshPlan(c);
    for (const pp of c.plan.parts) {
      const open = pp.tasks.filter((x) => !x.ticked);
      if (!open.length) continue;
      const done = open.length < pp.tasks.length || c.db.query(Q.committed).get({ part: part.id, item: `P${pp.n}` }) !== null;
      if (!done) await testsStep(c, pp);
      for (const task of open) await taskStep(c, pp, task);
    }
    // All approved checks once before the own review: the scoped checks of the tasks did not run build, lint, or the other tests.
    const allow = c.plan.parts.flatMap((x) => x.tasks.flatMap((t) => t.files));
    await greenOrFix(c, "checks", allow, (a) => partStepFile(c.plan, c.plan.parts, "checks", a));
    await commit(c, "checks", `${t.key}: Fix the checks of part ${part.ord}`, allow);
    await ownReview(c);
    db.transaction(() => {
      const cur = taskRow(db, t.id);
      if (cur?.state !== "implementing" || cur.blocked_json !== null) return;
      const p = advancePart(db, { task: t.id, version: cur.version, part: part.id }, { type: "REVIEWED" }, {}, now());
      if (p.status === 200) advance(db, { task: t.id, version: p.version }, { type: "PART_READY" }, {}, now());
    })();
    changed(t.id);
  }

  async function drive(db: Database, id: number, reset: boolean) {
    try {
      if (reset) {
        const t = taskRow(db, id);
        const part = building(db, id);
        if (t?.base_commit && part) {
          const wt = await openWorktree({
            dataDir,
            db,
            project: t.project,
            repo: t.repo,
            task: id,
            ord: part.ord,
            branch: part.branch,
            base: t.base_commit,
          });
          const last = (db.query(Q.lastStep).get({ part: part.id }) as { id: number | null }).id ?? 0;
          await undo(await trees(db, t, part, wt), db, id, last);
        }
      }
      // spec.md section 6.16.7: the pre-flight passes before any Claude step of the build.
      const t0 = taskRow(db, id);
      if (t0?.state === "implementing" && t0.blocked_json === null) {
        const b = await preflight(db, preflightDeps, t0, plannedBranch(db, t0), null);
        if (b) {
          reason(db, id, b);
          return;
        }
      }
      await ensureParts(db, id);
      for (;;) {
        const t = taskRow(db, id);
        if (closing || !t || t.state !== "implementing" || t.blocked_json !== null) return;
        const part = building(db, id);
        if (!part) return;
        await runPart(db, t, part);
      }
    } catch (e) {
      failed(db, id, e);
    }
  }

  // An error that no reason covers stops the task. Resume starts the step again.
  function failed(db: Database, id: number, e: unknown) {
    if (e instanceof Halt) return;
    const text = `The build stopped: ${noUrl((e as Error).message)}`;
    log(`Task ${id}: ${text}`);
    try {
      db.transaction(() => {
        const cur = taskRow(db, id);
        if (cur) stopForRun(db, { task: id, version: cur.version }, null, { status: "failed", text }, now());
      })();
      changed(id);
    } catch (e2) {
      log(`Task ${id}: could not stop the build: ${(e2 as Error).message}`);
    }
  }

  // spec.md section 6.7, own review: "Fix these too" starts one fix step with the listed points of a part that waits for its PR, then
  // the checks with their fixes and one commit. The part keeps its state. Changes that an earlier stop left go to a patch first.
  async function drivePoints(db: Database, id: number, partId: number) {
    try {
      const t = taskRow(db, id);
      const part = parts(db, id).find((p) => p.id === partId);
      if (!t || part?.state !== "self_reviewed") return;
      const c = await context(db, t, part);
      guard(c);
      await undo(c.trees, db, id, (db.query(Q.lastStep).get({ part: part.id }) as { id: number | null }).id ?? 0);
      refreshPlan(c);
      const points = openPoints(db, id);
      if (!points.length) return;
      const allow = c.plan.parts.flatMap((x) => x.tasks.flatMap((k) => k.files));
      const step = (a: number) => partStepFile(c.plan, c.plan.parts, "review", a);
      await claude(c, "fix", "points", { allow, step, failure: reviewFailure(points) });
      await greenOrFix(c, "points", allow, step);
      await commit(c, "points", `${t.key}: Fix the small review points of part ${part.ord}`, allow);
    } catch (e) {
      failed(db, id, e);
    }
  }

  // points: the part whose listed points the driver fixes. Absent: the build of the next part.
  function kick(db: Database, id: number, reset = false, points?: number) {
    if (drivers.has(id) || closing) return;
    const p = (points === undefined ? drive(db, id, reset) : drivePoints(db, id, points)).finally(() => {
      if (drivers.get(id) === p) drivers.delete(id);
    });
    drivers.set(id, p);
  }

  // The checks of a mutation: the task and its version.
  function load(db: Database, id: number, version: number): TaskRow | TaskResult {
    const t = taskRow(db, id);
    if (!t) return { status: 404, error: "Task not found." };
    if (t.version !== version) return { status: 409, error: TASK_CHANGED, task: taskDto(db, t) };
    return t;
  }

  return {
    // spec.md section 6.2: a small plan approval starts part 1.
    build(db: Database, id: number) {
      kick(db, id);
    },

    // POST /api/tasks/:id/pause: the next Claude step of the build waits until Resume (AC-B18).
    pause(db: Database, id: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" || !drivers.has(id)) return conflict(db, id, "The build does not run now.");
      pauseAsked.add(id);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/stop: the task stops in any working state. The running run ends cancelled, and the checks are killed.
    stop(db: Database, id: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const error = db.transaction((): string | null => {
        const r = advance(db, { task: id, version: t.version }, { type: "STOP" }, {}, now());
        if (r.status !== 200) return r.error;
        setBlocked(db, { task: id, version: r.version }, null, now());
        return null;
      })();
      if (error) return conflict(db, id, error);
      pauseAsked.delete(id);
      review.cancelTask(db, id);
      aborts.get(id)?.abort();
      gates.get(id)?.();
      slotWaits.get(id)?.();
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/resume of a build: a paused build goes on with its changes. Else the worktree returns to the last commit, the
    // discarded changes go to patches/<step>.patch, and the stopped step starts again (spec.md section 6.7, Resume).
    resume(db: Database, id: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state === "implementing" && blockedOf(t)?.kind === "slot")
        return conflict(db, id, "The build waits for the run slot. It goes on by itself.");
      if (drivers.has(id) && !gates.has(id)) return conflict(db, id, BUSY);
      if (t.state === "stopped") {
        if (t.stopped_from !== "implementing") return conflict(db, id, TASK_STATE_TEXT.stopped);
        const error = db.transaction((): string | null => {
          const r = advance(db, { task: id, version: t.version }, { type: "RESUME" }, {}, now());
          if (r.status !== 200) return r.error;
          setBlocked(db, { task: id, version: r.version }, null, now());
          return null;
        })();
        if (error) return conflict(db, id, error);
        kick(db, id, true);
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      if (t.state !== "implementing") return conflict(db, id, TASK_STATE_TEXT[t.state]);
      const b = blockedOf(t);
      const g = gates.get(id);
      if (b?.kind === "question" && b.step === null && g) {
        setBlocked(db, { task: id, version: t.version }, null, now());
        g();
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      if (b?.kind === "spec_change") return conflict(db, id, "Accept or reject the change to the spec first.");
      if (b?.kind === "question" && (db.query(Q.openLoop).all({ task: id }) as unknown[]).length)
        return conflict(db, id, "Answer the question first.");
      const part = building(db, id);
      if (!b && (drivers.has(id) || !part)) return conflict(db, id, TASK_STATE_TEXT.implementing);
      // A used-up time budget gets 60 more minutes. A cost limit stays: the user changes it in the settings.
      const used = b?.kind === "budget" && part ? partBudget(db, id, part, now()) : null;
      if (used && used.usedMs >= used.limitMs) moreTime(db, { task: id, version: t.version }, now());
      else if (b) setBlocked(db, { task: id, version: t.version }, null, now());
      kick(db, id, true);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/answers while the build waits for a question of Claude. The step starts again from the last commit with the
    // answer in context/answers.md.
    answer(db: Database, id: number, input: TaskAnswersInput): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (blockedOf(t)?.kind !== "question") return conflict(db, id, "No question waits for an answer.");
      const open = db.query(Q.openLoop).all({ task: id }) as (QuestionRow & { step: number | null })[];
      if (!open.length) return conflict(db, id, "No question waits for an answer.");
      const given = new Map(input.answers.map((a) => [a.question, a]));
      if (given.size !== input.answers.length) return { status: 400, error: "Each question takes one answer." };
      for (const q of given.keys())
        if (!open.some((x) => x.id === q)) return { status: 400, error: `Question ${q} does not wait for an answer.` };
      for (const q of open) {
        const a = given.get(q.id);
        if (!a && !input.recommended) return { status: 400, error: "Answer each question, or use the recommended answers." };
        const problem = a && answerProblem(q, a);
        if (problem) return { status: 400, error: problem };
      }
      if (drivers.has(id)) return conflict(db, id, BUSY);
      db.transaction(() => {
        const at = now();
        for (const q of open) {
          const a = given.get(q.id);
          const answer: Answer = a
            ? { choice: a.choice ?? null, text: a.text?.trim() ?? "" }
            : { choice: q.kind === "choice" ? q.recommended : null, text: "" };
          db.query(Q.answer).run({ id: q.id, answer: JSON.stringify(answer), now: at });
        }
        setBlocked(db, { task: id, version: t.version }, null, at);
      })();
      kick(db, id, true);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/limit (spec.md section 6.1): "Keep one PR" or "Change the limit" of a part over the line limit. The build goes
    // on from the last commit. A new limit under the changed lines stops it again.
    limit(db: Database, id: number, input: { version: number; keep?: true; lineBudget?: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" || blockedOf(t)?.kind !== "size") return conflict(db, id, "No part waits for the line limit.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      const s = taskSettingsOf(t);
      setSettings(
        db,
        { task: id, version: t.version },
        input.keep ? { ...s, keepOnePr: true } : { ...s, lineBudget: input.lineBudget },
        now(),
      );
      kick(db, id, true);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // POST /api/tasks/:id/parts/:part/fix: "Fix these too" for the listed points of a part that waits for its PR.
    fixPoints(db: Database, id: number, partId: number, input: { version: number }): TaskResult {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      if (t.state !== "implementing" || t.blocked_json !== null) return conflict(db, id, TASK_STATE_TEXT[t.state]);
      if (drivers.has(id)) return conflict(db, id, BUSY);
      if (parts(db, id).find((p) => p.id === partId)?.state !== "self_reviewed")
        return conflict(db, id, "This part does not wait for its PR.");
      if (!openPoints(db, id).length) return conflict(db, id, "No point waits for a fix.");
      kick(db, id, false, partId);
      changed(id);
      return { status: 202, task: dto(db, id) };
    },

    // POST /api/tasks/:id/spec-change/:step (AC-B20): accept commits the changed plan files, and the step starts again under the new
    // plan. Reject resets the step. Both save the other changes of the step as its patch.
    async specChange(db: Database, id: number, stepId: number, input: { version: number; accept: boolean }): Promise<TaskResult> {
      const t = load(db, id, input.version);
      if ("status" in t) return t;
      const b = blockedOf(t);
      if (t.state !== "implementing" || b?.kind !== "spec_change" || b.step !== stepId)
        return conflict(db, id, "No change to the spec waits for this step.");
      if (drivers.has(id)) return conflict(db, id, BUSY);
      const row = db.query(Q.step).get({ id: stepId, task: id }) as { part: number; item: string | null; detail_json: string } | null;
      const part = parts(db, id).find((p) => p.id === row?.part);
      if (!row || !part) return conflict(db, id, "No change to the spec waits for this step.");
      const detail = JSON.parse(row.detail_json) as { specChange?: { paths: string[] } | null; notes?: string[] };
      const note = (s: string) => ({ specChange: detail.specChange ?? null, notes: [...(detail.notes ?? []), s] });
      if (!input.accept) {
        db.transaction(() => {
          endStep(db, stepId, "cancelled", note("The user rejected the change."), now());
          setBlocked(db, { task: id, version: t.version }, null, now());
        })();
        kick(db, id, true);
        changed(id);
        return { status: 200, task: dto(db, id) };
      }
      try {
        const c = await context(db, t, part);
        if (!c.who) return conflict(db, id, "Set user.name and user.email in your git config.");
        // The proposal of the step: its changed plan files. A file that the step deleted stays deleted.
        const proposal = (detail.specChange?.paths ?? []).map((p) => {
          const f = onDisk(c.wt, p);
          return { f, text: existsSync(f) ? readFileSync(f) : null };
        });
        await undo(c.trees, db, id, stepId);
        for (const { f, text } of proposal) {
          if (text === null) rmSync(f, { force: true });
          else {
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, text);
          }
        }
        const message = row.item ? `${t.key} ${row.item}: Change the plan` : `${t.key}: Change the plan`;
        const r = await commitTask({
          db,
          task: id,
          part: part.id,
          wt: c.wt,
          item: "spec",
          message,
          who: c.who,
          allow: [],
          trees: c.trees,
          now,
        });
        if (r.status === "refused") return conflict(db, id, deniedText(r.problems));
      } catch (e) {
        return conflict(db, id, `The app could not commit the change: ${noUrl((e as Error).message)}`);
      }
      db.transaction(() => {
        endStep(db, stepId, "ok", note("The user accepted the change."), now());
        const cur = taskRow(db, id) as TaskRow;
        setBlocked(db, { task: id, version: cur.version }, null, now());
      })();
      kick(db, id);
      changed(id);
      return { status: 200, task: dto(db, id) };
    },

    // Resolves when the build of the task waits or ends.
    idle(id: number): Promise<void> {
      return drivers.get(id) ?? Promise.resolve();
    },
    // true while a driver works on the task.
    running: (id: number) => drivers.has(id),

    // At app stop (review.stop()): no new step, the checks are killed, and the drivers end.
    async shutdown() {
      closing = true;
      for (const a of aborts.values()) a.abort();
      for (const g of gates.values()) g();
      for (const w of slotWaits.values()) w();
      await Promise.all([...drivers.values()]);
    },
  };
}

export type TaskLoop = ReturnType<typeof createLoop>;
