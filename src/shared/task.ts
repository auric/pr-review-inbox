// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Build a Jira task (docs/plans/review-v2/spec.md sections 6.2, 6.3, and 6.5): the stored values and the results of the task runs.
// zod parses the CLI output. The CLI gets z.toJSONSchema(schema, { target: "draft-07" }).
import { z } from "zod";
import { coverage, MAX_QUESTION } from "./review";

export const TASK_STATES = [
  "interview",
  "spec_draft",
  "spec_pr_open",
  "spec_approved",
  "implementing",
  "ready",
  "done",
  "failed",
  "stopped",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const PART_STATES = [
  "planned",
  "implementing",
  "self_reviewed",
  "pr_open",
  "changes_requested",
  "approved",
  "merged",
  "declined",
  "abandoned",
] as const;
export type PartState = (typeof PART_STATES)[number];

export const STEP_STATES = ["waiting", "running", "ok", "failed", "cancelled", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];

export const TASK_SIZES = ["small", "medium", "large"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];
export const SIZE_SOURCES = ["claude", "rule", "user"] as const;
export type SizeSource = (typeof SIZE_SOURCES)[number];

export const PART_KINDS = ["spec", "contract", "part", "cleanup", "spike", "single"] as const;
export type PartKind = (typeof PART_KINDS)[number];

export const STEP_KINDS = [
  "interview",
  "spec",
  "tests",
  "implement",
  "check",
  "fix",
  "review",
  "commit",
  "push",
  "pr",
  "retarget",
  "rebase",
  "replan",
  "question",
  "spec_change",
  "size",
  // spec.md section 6.18: Tell Claude, Update from the base branch, and the resolve step of a conflict.
  "instruct",
  "update",
  "resolve",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const TASK_EVENT_KINDS = ["needs_you", "part_ready", "spec_approved"] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

export const QUESTION_SOURCES = ["interview", "loop"] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

// The run kinds of task runs. Each task run is a review_run row with task set and pr NULL. A self-review is kind review.
export const TASK_RUN_KINDS = ["interview", "spec", "implement"] as const;
export type TaskRunKind = (typeof TASK_RUN_KINDS)[number];

export const TASK_DOCS = ["design", "spec", "tasks", "plan"] as const;
export type TaskDoc = (typeof TASK_DOCS)[number];

// Round 1 asks at most 8 questions, round 2 at most 4.
export const INTERVIEW_ROUNDS = 2;
export const INTERVIEW_QUESTIONS = [8, 4] as const;
// spec.md section 0, STEP_TURNS: the turn caps of the interview and spec runs.
export const INTERVIEW_TURNS = 30;
export const SPEC_TURNS = 80;
// spec.md section 6.3: the defaults of repo_task_settings. CHECK_TIMEOUT in seconds.
export const TASK_DEFAULTS = { specDir: "specs/{key}/", lineBudget: 400, maxOpen: 2, approvals: 1 } as const;
// spec.md section 6.16: the whole branch name with its suffix, one prefix, the prefix list, and one page of the branch search.
export const BRANCH_MAX = 100;
export const PREFIX_MAX = 40;
export const PREFIXES_MAX = 10;
export const BRANCH_PAGE = 25;
// spec.md section 6.16.1: Settings > Tasks "Branch prefixes". The first one starts selected on the plan screen.
export const DEFAULT_BRANCH_PREFIXES = ["feature/", "bugfix/", "hotfix/"] as const;
// spec.md section 6.16.4: a taken name gets -2 to -99.
export const BRANCH_SUFFIX_MAX = 99;
// spec.md section 6.16.5: the repository list stops after 10 pages of 100. A spec run proposes at most 2 other repositories.
export const REPO_PAGE = 100;
export const REPO_LIST_MAX = 1000;
export const PROPOSALS_MAX = 2;

// spec.md section 6.16.5: the repositories of a task (task_repo.role, task_repo.access) and the reasons that the plan screen shows.
export const REPO_ROLES = ["main", "submodule", "added"] as const;
export type RepoRole = (typeof REPO_ROLES)[number];
export const REPO_ACCESS = ["edit", "read", "none"] as const;
export type RepoAccess = (typeof REPO_ACCESS)[number];
export const REPO_REASON = {
  noWrite: "The token cannot push to it.",
  nested: "It is a nested submodule. Only first-level submodules are editable.",
  otherServer: "It comes from another server.",
  noMatch: "Its URL matches no repository on your Bitbucket server.",
  twice: (path: string) => `The same repository is already in the task at ${path}.`,
  noBranch: "Its pinned commit is on no branch of the server.",
} as const;
// spec.md section 6.16.5, Size.
export const LARGE_REPOS_TEXT = "Needs you: large tasks change one repository for now. Make it medium, or split the task.";
export const CHECK_TIMEOUT_SEC = 600;
// spec.md section 0: the limits of one Claude step of a part (STEP_TIME, STEP_TURNS), the Claude time of one part (PART_TIME, in
// minutes), and the output of one command (OUTPUT_TAIL: stored bytes; FAILURE_TAIL: bytes in context/failure.md).
export const STEP_MODES = ["tests", "implement", "fix", "instruct", "resolve"] as const;
export type StepMode = (typeof STEP_MODES)[number];
export const STEP_TIME_MS = 20 * 60_000;
export const STEP_TURNS: Record<StepMode, number> = { tests: 60, implement: 80, fix: 40, instruct: 80, resolve: 40 };
// spec.md section 6.18: the text of "Tell Claude" (MAX_QUESTION of spec.md section 0), the conflict stops of one repository in one
// update, and the least time between two base checks of one task.
export const MAX_INSTRUCTION = MAX_QUESTION;
export const RESOLVE_STOPS = 10;
export const BASE_CHECK_AGE_MS = 60_000;
// spec.md section 6.18.5: properties.mergeResult.outcome of a PR with conflicts. Gate G18 has not verified this value.
export const MERGE_CONFLICTED = "CONFLICTED";
export const PART_TIME_MIN = 120;
// spec.md section 6.7, Budgets: "Continue with 60 more min?".
export const MORE_TIME_MIN = 60;
export const OUTPUT_TAIL = 64 * 1024;
export const FAILURE_TAIL = 32 * 1024;

export const sizeRank = (s: TaskSize) => TASK_SIZES.indexOf(s);

// spec.md section 6.16.2: lowercase ASCII letters, digits, and hyphens from the title. No length cut here.
export function slug(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// spec.md section 6.16.2: the slug within room characters, cut at its last hyphen that fits, else at room. No trailing hyphen.
function capSlug(s: string, room: number) {
  if (s.length <= room) return s;
  const cut = s.slice(0, room + 1).lastIndexOf("-");
  return (cut > 0 ? s.slice(0, cut) : s.slice(0, room)).replace(/-+$/, "");
}

// spec.md section 6.16.2: <prefix><KEY>-spec, <prefix><KEY>-<n>-<slug>, and for a small task <prefix><KEY>-<slug>. A title without ASCII
// letters or digits gives the slug "task" or "part", so the name keeps the form that push.ts checks. The name leaves room for the
// longest suffix (-99), so every free name stays within BRANCH_MAX.
export function branchName(
  prefix: string,
  key: string,
  part: { kind: "spec" } | { kind: "small"; title: string } | { kind: "part"; n: number; title: string },
) {
  if (part.kind === "spec") return `${prefix}${key}-spec`;
  const head = part.kind === "small" ? `${prefix}${key}-` : `${prefix}${key}-${part.n}-`;
  const room = BRANCH_MAX - `-${BRANCH_SUFFIX_MAX}`.length - head.length;
  return `${head}${capSlug(slug(part.title), room) || (part.kind === "small" ? "task" : "part")}`;
}

// spec.md section 6.12: the step strip of the Task view. current: the index of the current step, -1 for a failed task.
// A task without a size shows the small strip. Large counts the code parts: the first one that did not merge is the current one.
export function stepStrip(t: {
  size: TaskSize | null;
  state: TaskState;
  stoppedFrom: TaskState | null;
  parts: { kind: PartKind; state: PartState }[];
}): { steps: string[]; current: number } {
  const code = t.parts.filter((p) => p.kind !== "spec");
  const left = code.findIndex((p) => p.state !== "merged" && p.state !== "abandoned");
  const build = t.size === "large" && code.length ? `Build parts (${left < 0 ? code.length : left + 1} of ${code.length})` : "Build";
  const review = t.size === "medium" || t.size === "large";
  const steps = ["Questions", "Plan", ...(review ? ["Spec review"] : []), build, "Done"];
  const state = t.state === "stopped" ? t.stoppedFrom : t.state;
  const at: Record<TaskState, number> = {
    interview: 0,
    spec_draft: 1,
    spec_pr_open: 2,
    spec_approved: 2,
    implementing: steps.length - 2,
    ready: steps.length - 2,
    done: steps.length - 1,
    failed: -1,
    stopped: -1,
  };
  return { steps, current: state === null ? -1 : at[state] };
}

// One plain sentence per state. A refused state change returns it with 409.
export const TASK_STATE_TEXT: Record<TaskState, string> = {
  interview: "Claude reads the task and asks its questions.",
  spec_draft: "The plan is not approved yet.",
  spec_pr_open: "Colleagues review the plan as a PR.",
  spec_approved: "The plan is approved, and the build has not started.",
  implementing: "The build runs or waits for you.",
  ready: "All PRs of the task are open.",
  done: "The task is done.",
  failed: "The task failed.",
  stopped: "The task is stopped.",
};

// The part chips of the Plan tab (spec.md section 6.12).
export const PART_STATE_TEXT: Record<PartState, string> = {
  planned: "Planned",
  implementing: "Building",
  self_reviewed: "Checked by Claude",
  pr_open: "In review",
  changes_requested: "Changes asked",
  approved: "Approved",
  merged: "Merged",
  declined: "Declined",
  abandoned: "Dropped",
};

// ---------- Stored JSON (spec.md section 6.3) ----------

export const BLOCKED_KINDS = [
  "question",
  "red",
  "blocker",
  "budget",
  "size",
  "spec_change",
  "denied_path",
  "push",
  "slot",
  "preflight",
  "update",
  "error",
] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];
// task.blocked_json: why the loop waits for the user. null while Claude or the app works, and while the app waits for colleagues.
export const taskBlocked = z.object({ kind: z.enum(BLOCKED_KINDS), step: z.number().int().positive().nullable(), text: z.string() });
export type TaskBlocked = z.infer<typeof taskBlocked>;

export const COMMAND_KINDS = ["setup", "build", "test", "lint"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
export const commandId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const MAX_TASK_COMMAND_ARGS = 32;
// repo_task_settings.commands_json. argv lists only: no shell form exists.
export const taskCommand = z.object({
  id: commandId,
  name: z.string().trim().min(1).max(60),
  kind: z.enum(COMMAND_KINDS),
  argv: z.array(z.string().min(1).max(1000)).min(1).max(MAX_TASK_COMMAND_ARGS),
  timeoutSec: z.number().int().min(1).max(3600),
});
export type TaskCommand = z.infer<typeof taskCommand>;

// task.settings_json: the overrides of one task. Absent keys take the repository settings.
export const taskSettings = z.object({
  lineBudget: z.number().int().positive().optional(),
  maxOpen: z.number().int().positive().optional(),
  approvals: z.number().int().nonnegative().optional(),
  autoOpen: z.boolean().optional(),
  pauseAfterTask: z.boolean().optional(),
  reviewers: z.array(z.string().min(1).max(255)).max(20).optional(),
  partTimeMin: z.number().int().positive().optional(),
  // USD. It applies only when the CLI reports a cost (spec.md section 6.7).
  partCost: z.number().positive().optional(),
  // spec.md section 6.1, "Keep one PR": the line limit stops the task no more.
  keepOnePr: z.boolean().optional(),
  // spec.md section 6.16: the branch prefix of the plan approval, and the pick for a branch that exists on the server.
  branchPrefix: z.string().min(1).max(PREFIX_MAX).optional(),
  existing: z.enum(["continue", "new"]).optional(),
});
export type TaskSettings = z.infer<typeof taskSettings>;

// spec.md section 6.18.2: an instruct step. blockedBefore: the reason that the task had at the send; a stop or a failure restores it.
// committed: the step made its commit.
export const instructDetail = z.object({
  text: z.string(),
  part: z.number().int(),
  blockedBefore: taskBlocked.nullable(),
  result: z.enum(["done", "no_change", "stopped", "failed"]).nullable().default(null),
  committed: z.boolean().default(false),
});
export type InstructDetail = z.infer<typeof instructDetail>;

const repoHead = z.object({ taskRepo: z.number().int(), head: z.string() });
// spec.md section 6.18.3: an update step. preHeads: the head, base_commit, and pinned commit of every repository of the part before any
// git command; an abort and Undo restore them. postHeads: the heads after the update. result: green or red checks, an abort with its
// reason, or a restart of the app during the update (recovered: the app reset the repositories after that restart).
export const updateDetail = z.object({
  repos: z.array(z.object({ taskRepo: z.number().int(), base: z.string(), mode: z.enum(["rebase", "merge"]), newBaseHead: z.string() })),
  preHeads: z.array(repoHead.extend({ baseCommit: z.string().nullable(), pinned: z.string().nullable() })),
  postHeads: z.array(repoHead).default([]),
  stops: z.number().int().default(0),
  resolved: z.boolean().default(false),
  result: z.enum(["green", "red", "aborted", "restart"]).nullable().default(null),
  reason: z.string().nullable().default(null),
  undone: z.boolean().default(false),
  recovered: z.boolean().default(false),
});
export type UpdateDetail = z.infer<typeof updateDetail>;

// task_step.detail_json. Every key has a default, so an older row still parses.
export const stepDetail = z.object({
  commands: z
    .array(
      z.object({
        name: z.string(),
        argv: z.array(z.string()),
        exit: z.number().int().nullable(),
        ms: z.number(),
        tail: z.string(),
        // The reason when the command never started, such as "Not found: .venv/bin/python". null: it started.
        notRun: z.string().nullable().default(null),
      }),
    )
    .default([]),
  diffStat: z
    .object({ files: z.number().int(), added: z.number().int(), removed: z.number().int(), lines: z.number().int() })
    .nullable()
    .default(null),
  findings: z.array(z.number().int()).default([]),
  question: z.number().int().nullable().default(null),
  specChange: z
    .object({ paths: z.array(z.string()) })
    .nullable()
    .default(null),
  deniedPaths: z.array(z.string()).default([]),
  patch: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
  // The checks of the tests step: the new tests must fail before the code exists (spec.md section 6.7, AC-B10).
  expectRed: z.boolean().default(false),
  // A Claude step: its summary, and needsBase with its reason (spec.md section 6.18.2).
  summary: z.string().nullable().default(null),
  needsBase: z.object({ reason: z.string() }).nullable().default(null),
  // spec.md section 6.18.6.
  instruct: instructDetail.nullable().default(null),
  update: updateDetail.nullable().default(null),
  resolve: z
    .object({ taskRepo: z.number().int(), paths: z.array(z.string()) })
    .nullable()
    .default(null),
});
export type StepDetail = z.infer<typeof stepDetail>;

// ---------- Run results (spec.md section 6.5) ----------

const option = z.object({ label: z.string().max(120), detail: z.string().max(300) });

export const interviewResult = z.object({
  done: z.boolean().describe("true when no question would change the plan."),
  summary: z.string().max(1500).describe("What the task asks for and what you plan to build, in plain words."),
  questions: z
    .array(
      z.object({
        id: z.string().regex(/^q[0-9]{1,2}$/),
        text: z.string().max(300),
        why: z.string().max(300),
        kind: z.enum(["choice", "text"]),
        options: z.array(option).max(5),
        recommended: z.number().int().min(0).nullable(),
      }),
    )
    .max(8),
  unknowns: z.array(z.string().max(300)).max(10).default([]),
  coverage,
});
export type InterviewResult = z.infer<typeof interviewResult>;
export const interviewJsonSchema = (): Record<string, unknown> => z.toJSONSchema(interviewResult, { target: "draft-07" });

const specPart = z.object({
  n: z.number().int().min(1),
  kind: z.enum(["contract", "part", "cleanup", "prep", "spike"]),
  title: z.string().max(120),
  goal: z.string().max(300),
  lines: z.number().int().min(1),
  acceptance: z
    .array(z.object({ id: z.string(), text: z.string().max(500) }))
    .min(1)
    .max(20),
  tests: z.array(z.object({ test: z.string().max(300), proves: z.array(z.string()).min(1) })).max(30),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().max(200),
        files: z.array(z.string()).max(30),
        run: z.array(z.string().max(300)).min(1).max(10),
        done: z.string().max(300),
      }),
    )
    .min(1)
    .max(15),
});

export const specResult = z.object({
  title: z.string().max(200),
  size: z.enum(TASK_SIZES),
  estimate: z.object({
    parts: z.number().int().min(1).max(12),
    lines: z.number().int().min(1),
    files: z.number().int().min(1),
    modules: z.array(z.string().max(60)).max(20),
    db: z.boolean(),
    api: z.boolean(),
    unknowns: z.array(z.string().max(300)).max(10),
  }),
  map: z
    .array(
      z.object({
        path: z.string().max(400),
        line: z.number().int().min(1).nullable(),
        symbol: z.string().max(200).default(""),
        kind: z.enum(["change", "pattern", "test", "caller", "migration", "api"]),
        what: z.string().max(300),
      }),
    )
    .min(1)
    .max(40)
    .describe("The integration map: code that exists at the base commit."),
  // Small: change holds the Change section, and design and spec stay null. Medium and large: change stays empty.
  change: z.string().max(2000).default(""),
  design: z
    .object({ decision: z.string().max(2000), alternatives: z.string().max(1000).default(""), risks: z.string().max(1500) })
    .nullable()
    .default(null),
  spec: z
    .object({ behavior: z.string().max(3000), edgeCases: z.string().max(2000), outOfScope: z.string().max(1000) })
    .nullable()
    .default(null),
  parts: z.array(specPart).min(1).max(12),
  testing: z.object({
    commands: z
      .array(z.object({ name: z.string().max(60), kind: z.enum(COMMAND_KINDS), argv: z.array(z.string().max(1000)).min(1).max(32) }))
      .max(10),
    services: z.array(z.string().max(200)).max(10),
    notes: z.string().max(2000),
  }),
  flag: z
    .object({ name: z.string().max(120), removal: z.string().max(300) })
    .nullable()
    .default(null),
  questions: z.array(z.string().max(300)).max(10).default([]),
  // spec.md section 6.16.5, Proposals: other repositories from context/repo-list.md that the change needs.
  repos: z
    .array(z.object({ project: z.string().max(100), repo: z.string().max(100), reason: z.string().max(300) }))
    .max(PROPOSALS_MAX)
    .default([]),
  coverage,
});
export type SpecResult = z.infer<typeof specResult>;
export const specJsonSchema = (): Record<string, unknown> => z.toJSONSchema(specResult, { target: "draft-07" });

export const implementResult = z.object({
  summary: z.string().max(1000),
  done: z.boolean().describe("true only when the step is complete."),
  tests: z.array(z.string()).max(50).default([]).describe("The test files that this step added or changed."),
  question: z
    .object({
      text: z.string().max(300),
      why: z.string().max(300),
      options: z.array(option).max(5),
      recommended: z.number().int().min(0).nullable(),
    })
    .nullable()
    .default(null),
  specChange: z.string().max(1000).default("").describe("Why you changed a plan file. Empty when you did not."),
  // spec.md section 6.18.2.
  needsBase: z.boolean().default(false).describe("true when the change needs the newest base branch."),
  needsBaseReason: z.string().max(300).default(""),
  notes: z.array(z.string().max(500)).max(20).default([]),
  coverage,
});
export type ImplementResult = z.infer<typeof implementResult>;
export const implementJsonSchema = (): Record<string, unknown> => z.toJSONSchema(implementResult, { target: "draft-07" });

export const replanResult = z.object({
  changed: z.boolean(),
  reason: z.string().max(1000),
  // spec.md section 6.5 reuses specResult.shape.parts, but its min(1) would refuse the empty list of changed false.
  parts: z.array(specPart).max(12).describe("The remaining parts. Empty when changed is false."),
  questions: z.array(z.string().max(300)).max(10).default([]),
  coverage,
});
export type ReplanResult = z.infer<typeof replanResult>;
