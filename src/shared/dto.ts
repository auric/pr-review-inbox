// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// API request and response shapes shared by server and UI.
import { z } from "zod";
import type { BuildCounts, BuildState, BuildStatus } from "./build";
import {
  type Anchor,
  type AnchoredFinding,
  type Carried,
  type DiffKind,
  type DiscussRecord,
  type DiscussResult,
  type DiscussVerdict,
  type ExplainResult,
  type FixedMark,
  type FixNote,
  MAX_DISCUSS_MESSAGES,
  MAX_FIX_EDITS,
  MAX_QUESTION,
  MAX_REPLY_THREADS,
  NOTE_TEXT_MAX,
  type Question,
  type ReplyPayload,
  type SessionMark,
  type Side,
  type ValidatedResult,
  type WithdrawnMark,
} from "./review";
import type { RunErrorKind, RunEvent, RunStatus } from "./run-log";
import {
  commandId,
  type FoundItem,
  INTERVIEW_QUESTIONS,
  JIRA_KEY,
  MAX_INSTRUCTION,
  MAX_OPEN_CAP,
  type PartKind,
  type PartState,
  PREFIX_MAX,
  PREFIXES_MAX,
  type QuestionSource,
  type RepoAccess,
  type RepoRole,
  type SizeSource,
  type SpecResult,
  START_MODES,
  type StartMode,
  type StepDetail,
  type StepKind,
  type StepState,
  SUBTASK_PARTS_MAX,
  SUBTASKS_READ,
  TASK_DOCS,
  TASK_SIZES,
  type TaskBlocked,
  type TaskCommand,
  type TaskDoc,
  type TaskRunKind,
  type TaskSettings,
  type TaskSize,
  type TaskState,
  taskCommand,
} from "./task";
import type { ExcerptLine, IncompleteReason, Reviewer, Role, User } from "./types";

export type { ExcerptLine };

export const taskSources = ["branch", "title", "description"] as const;

export type TaskSource = (typeof taskSources)[number];

// WP2 safety caps. The worker compiles the pattern, so a syntax check needs the worker too.
export const MAX_TASK_RULES = 20;
export const MAX_PATTERN = 200;

export const taskRuleInput = z.object({
  source: z.enum(taskSources),
  pattern: z.string().min(1).max(MAX_PATTERN),
  // Allowed parts before the dash. Absent: every key.
  keys: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
});

export type TaskRule = z.infer<typeof taskRuleInput>;

// timedOut: the rule ran past the budget. Sync skips it until the user edits it.
export type TaskRuleDto = TaskRule & { timedOut: boolean };

export const MAX_NOTE = 20_000;
export const MAX_PROFILES = 20;
// Seconds between sync cycles.
export const CHECK_CHOICES = [30, 60, 120, 300, 600, 900] as const;

const profileId = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const MAX_PROFILE_SKILLS = 200;
// A Claude Code skill: "<skill>" in the user skills folder, or "<plugin>:<skill>". Each part is a folder name.
export const skillId = z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}:)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

// GET /api/skills. version: the plugin version.
export type SkillDto = { id: string; name: string; description: string; source: "user" | "plugin"; version?: string };
const NOT_FOUND = "it is not found";
// The start error for an always-use skill that a run cannot get. The brief shows the same text.
export const alwaysSkillError = (id: string, reason = NOT_FOUND) =>
  `Skill ${id} is marked Always use, but ${reason}. ${reason === NOT_FOUND ? "Enable the plugin again" : "Fix the skill folder"}, or remove the Always use mark in Settings > Review profiles.`;

export const MAX_PROFILE_MCP = 10;
export const MAX_MCP_TOOLS = 100;
// A server or tool name goes into CLI flags as mcp__<server>__<tool>. src/server/review/claude.ts NAME has the same characters.
export const mcpName = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
// A server ID: the name of a user server, or <plugin>:<server> for a server of an enabled plugin. The plugin part is a skillId part.
export const mcpServerId = z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}:)?[A-Za-z0-9_-]{1,128}$/);
// One server of the user's Claude config or of an enabled plugin, and the tools that a run may call.
export const mcpPick = z.object({
  server: mcpServerId,
  tools: z
    .array(mcpName)
    .max(MAX_MCP_TOOLS)
    .transform((l) => [...new Set(l)]),
});
export type McpPick = z.infer<typeof mcpPick>;

// GET /api/mcp-servers. It never holds the URL, headers, command, args, or env of a server.
// name: the server ID. plugin: the plugin name of a plugin server.
export type McpServerDto = { name: string; transport: "stdio" | "http" | "sse"; source: "user" | "plugin"; plugin?: string };
// POST /api/mcp-servers/:name/tools. A hint is null when the server does not say.
export type McpToolDto = { name: string; description: string; readOnlyHint: boolean | null; destructiveHint: boolean | null };
// blocked: the server marks the tool as able to change data. No run allows it. unmarked: no readOnlyHint. The user must confirm it.
export type McpToolSafety = "blocked" | "unmarked" | "readOnly";
export const mcpToolSafety = (t: Pick<McpToolDto, "readOnlyHint" | "destructiveHint">): McpToolSafety =>
  t.destructiveHint === true || t.readOnlyHint === false ? "blocked" : t.readOnlyHint === true ? "readOnly" : "unmarked";

// The --effort choices of Claude Code 2.1.295 without "ultracode" (code.claude.com/docs/en/cli-reference).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
// A model alias such as opus, or a full model ID such as claude-opus-5-5 or opus[1m]. It goes into argv, so it never starts with "-".
export const modelName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/);
// auto: a review run gets rl-reviewer only for a large change (catalog.ts delegation). always: the main agent splits the changed files
// across rl-reviewer calls. off: no rl-reviewer.
export const REVIEWER_MODES = ["auto", "always", "off"] as const;
export type ReviewerMode = (typeof REVIEWER_MODES)[number];
// null model or effort: no flag and no agent field, so Claude Code uses its own default.
export const reviewerSetup = z.object({
  model: modelName.nullable().default(null),
  effort: z.enum(EFFORTS).nullable().default(null),
  mode: z.enum(REVIEWER_MODES).default("auto"),
});
export type ReviewerSetup = z.infer<typeof reviewerSetup>;
export const DEFAULT_REVIEWER: ReviewerSetup = { model: null, effort: null, mode: "auto" };

// docs/plans/review-v2/spec.md sections 1.2 to 1.4: the check sections of the finder prompt, the volume, and the verify phase.
export const MODULE_IDS = [
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
export type ModuleId = (typeof MODULE_IDS)[number];
// docs/plans/review-v3.md V2 and V3: eval switches. The UI and the Improve prompt do not offer them until WP-V4 ships or deletes them.
export const TRIAL_MODULES: readonly ModuleId[] = ["failures"];
export const VARIANTS = ["order", "rereview-strict", "rules2", "signal"] as const;
export type Variant = (typeof VARIANTS)[number];
export const VOLUMES = ["quiet", "balanced", "thorough"] as const;
export type Volume = (typeof VOLUMES)[number];
export const VERIFIER_MODES = ["on", "off"] as const;
// null model: the profile model. null effort: medium.
export const verifierSetup = z.object({
  mode: z.enum(VERIFIER_MODES).default("on"),
  model: modelName.nullable().default(null),
  effort: z.enum(EFFORTS).nullable().default(null),
});
export type VerifierSetup = z.infer<typeof verifierSetup>;
export const DEFAULT_VERIFIER: VerifierSetup = { mode: "on", model: null, effort: null };

// prompt: the profile part of both agent prompts. docs: the run gets the documentation servers.
// skills: the run gets a copy of each skill in ./skills. Absent in profiles saved before skills existed.
// mcp: servers of the user's Claude config with the chosen tools. Absent in profiles saved before this field existed.
// model, effort: --model and --effort of every run of the profile. reviewer: the rl-reviewer agent of review runs. Absent in older profiles.
// alwaysSkills: chosen skills that every run reads first. A run does not start without them. Absent in older profiles.
// languageChecks: review runs get the checklists for the languages of the change. Absent in older profiles.
// modules, volume, verifier: absent in profiles saved before PROFILES_VERSION 5. A module ID that this version does not know drops.
// variants: absent in older profiles. A variant name that this version does not know drops. The list keeps the VARIANTS order.
export const profilePrompt = z.string().trim().min(1).max(MAX_NOTE);
export const profileInput = z
  .object({
    id: profileId,
    name: z.string().trim().min(1).max(60),
    note: z.string().trim().max(200),
    prompt: profilePrompt,
    explain: z.boolean(),
    docs: z.boolean(),
    languageChecks: z.boolean().default(false),
    maxTurns: z.number().int().min(2).max(1000),
    skills: z
      .array(skillId)
      .max(MAX_PROFILE_SKILLS)
      .default([])
      .transform((l) => [...new Set(l)]),
    alwaysSkills: z
      .array(skillId)
      .max(MAX_PROFILE_SKILLS)
      .default([])
      .transform((l) => [...new Set(l)]),
    mcp: z
      .array(mcpPick)
      .max(MAX_PROFILE_MCP)
      .default([])
      .refine((l) => new Set(l.map((m) => m.server)).size === l.length, "Each MCP server can occur only once."),
    model: modelName.nullable().default(null),
    effort: z.enum(EFFORTS).nullable().default(null),
    reviewer: reviewerSetup.default(() => ({ ...DEFAULT_REVIEWER })),
    modules: z
      .array(z.enum(MODULE_IDS).nullable().catch(null))
      .max(50)
      .default([])
      .transform((l) => [...new Set(l.filter((m) => m !== null))]),
    volume: z.enum(VOLUMES).default("balanced"),
    verifier: verifierSetup.default(() => ({ ...DEFAULT_VERIFIER })),
    variants: z
      .array(z.enum(VARIANTS).nullable().catch(null))
      .max(20)
      .default([])
      .transform((l) => VARIANTS.filter((v) => l.includes(v))),
  })
  .refine((p) => p.alwaysSkills.every((id) => p.skills.includes(id)), {
    message: "Each always-use skill must be a chosen skill.",
    path: ["alwaysSkills"],
  });
export type ProfileInput = z.infer<typeof profileInput>;

export const profileList = z
  .array(profileInput)
  .min(1)
  .max(MAX_PROFILES)
  .refine((l) => new Set(l.map((p) => p.id)).size === l.length, "Profile IDs must be unique.");

export const settingsInput = z.object({
  baseUrl: z.string().trim().min(1),
  // Absent or empty keeps the stored token. A new origin needs a token.
  token: z.string().trim().optional(),
  // Absent or empty means no CA file.
  caFile: z.string().trim().optional(),
  notifications: z.boolean().optional(),
  // Absent keeps the stored value.
  markAi: z.boolean().optional(),
  // Absent keeps the stored value.
  markSeverity: z.boolean().optional(),
  // Absent keeps the stored rules.
  taskRules: z.array(taskRuleInput).max(MAX_TASK_RULES).optional(),
  // Absent keeps the stored template. Empty clears it.
  taskLink: z.string().trim().max(2048).optional(),
  // Absent keeps the stored value.
  checkSeconds: z
    .number()
    .refine((n) => (CHECK_CHOICES as readonly number[]).includes(n))
    .optional(),
  // Absent keeps the stored profiles. null restores the shipped profiles.
  profiles: profileList.nullable().optional(),
  // Absent keeps the stored value. docs/plans/session-consult.md part C: while it is off, the app reads no transcript.
  sessions: z.boolean().optional(),
  // Absent keeps the stored value. Off records the company AI policy acknowledgement for task attachments.
  askAttachments: z.boolean().optional(),
  // Absent keeps the stored list (docs/plans/review-v2/spec.md section 6.16.1).
  taskBranchPrefixes: z.lazy(() => branchPrefixList).optional(),
});

export type SettingsInput = z.infer<typeof settingsInput>;

export type TokenStorage = "os" | "memory";

// Never holds the token.
export type SettingsDto = {
  baseUrl: string | null;
  user: string | null;
  tokenStored: boolean;
  tokenStorage: TokenStorage;
  caFile: string | null;
  notifications: boolean;
  markAi: boolean;
  markSeverity: boolean;
  taskRules: TaskRuleDto[];
  taskLink: string | null;
  checkSeconds: number;
  // With prompts. Meta lists them without.
  profiles: ProfileInput[];
  // The current shipped profiles. The editor shows and resets the edited fields of a profile with a shipped ID.
  shippedProfiles: ProfileInput[];
  // By shipped profile ID: the edited fields, and the edited fields whose shipped value changed after the edit.
  profileEdits: Record<string, { fields: string[]; newer: string[] }>;
  // baseUrl: null when Jira is not connected.
  // email: the Atlassian account email of Jira Cloud. null for Server/Data Center.
  jira: { baseUrl: string | null; caFile: string | null; email: string | null; tokenStored: boolean };
  // The opt-in of "Ask your session" (docs/plans/session-consult.md part C). Default off.
  sessions: boolean;
  // Ask the company AI policy question before a task attachment is included in runs. Default on.
  askAttachments: boolean;
  // spec.md section 6.16.1: Settings > Tasks "Branch prefixes".
  taskBranchPrefixes: string[];
};

export type ApiError = { error: string };

// Values of sync_checkpoint.incomplete_reason. "gap": a comment is absent from complete activities, but its GET returns 200.
export type CheckpointReason = IncompleteReason | "gap";

export type CheckpointDto = { lastCompleteAt: number | null; reason: CheckpointReason | null; error: string | null };

// offline: no request reached the server. auth: 401, paused until the settings change. unconfigured: no settings or no token, paused.
// error: a local failure; a CA file error pauses until the settings change.
export type SyncState = "idle" | "ok" | "offline" | "auth" | "unconfigured" | "error";

export type SyncStatus = {
  running: boolean;
  state: SyncState;
  // Local clock in ms: the start of the last cycle that ended "ok".
  lastCompleteAt: number | null;
  // Local clock in ms. null while a cycle runs or polling is paused.
  nextAt: number | null;
  error: string | null;
};

// The inbox reason of a row. views.ts GROUPS maps each one to a list group. "triage" needs review drafts (M2).
export type Group = "your" | "triage" | "review" | "commits" | "comments" | "waiting" | "quiet" | "closed";

// The thread that the row opens at. msg: the first unread message, else the newest live message.
// author and snippet come from the newest live message. author: the display name, else the slug.
export type Cause = { thread: number; msg: number; author: string; snippet: string };

export type PrTask = { key: string; source: TaskSource; url: string | null };

// docs/plans/ci-builds.md, Layer A: the Bitbucket build status of the synced source head. builds: at most 10, failed first, then in
// progress; null when the list read failed. readAt: ms of the read that saw the last change. A field of this type is null before the first
// read, and when the stored read has another head than the synced source head.
export type BuildDto = { head: string; state: BuildState; counts: BuildCounts; builds: BuildStatus[] | null; readAt: number };

// Metadata fields are null for a PR followed by URL until its first sync cycle.
export type PrRow = {
  id: number;
  project: string;
  repo: string;
  prId: number;
  title: string | null;
  authorSlug: string | null;
  authorName: string | null;
  role: Role | null;
  state: string | null;
  status: string | null;
  sourceBranch: string | null;
  targetBranch: string | null;
  webUrl: string | null;
  // The branch pages on the forge. The source branch of a PR from a fork is in the fork. null until a sync cycle gets them.
  sourceBranchUrl: string | null;
  targetBranchUrl: string | null;
  // The user page of the author on the forge (plan pr-view-v4 N2). null until a sync cycle gets it, or when it has another origin.
  authorUrl: string | null;
  // The server has the source and the target head. A run needs both (jobs.ts).
  synced: boolean;
  // Empty until the first sync cycle that writes the PR.
  // login: null for reviewers stored before the username was kept.
  reviewers: (Omit<Reviewer, "login"> & { login: string | null })[];
  onDashboard: boolean;
  followed: boolean;
  // Local clock in ms. null for every row of GET /api/prs.
  archivedAt: number | null;
  // 0 for an unfollowed PR.
  unread: number;
  group: Group;
  // The count of threads where it is my turn (src/shared/turn.ts).
  yourTurn: number;
  // The count of threads whose current open reply draft would post and is out of date or resolved since (src/shared/stale.ts).
  staleDrafts: number;
  cause: Cause | null;
  // ms: the newest live message of the longest-waiting "wait" thread. null without a "wait" thread.
  waitSince: number | null;
  // ms: the last POST /api/prs/:id/seen. null before the first visit.
  seenAt: number | null;
  // D9: rule order, deduped, at most 10.
  tasks: PrTask[];
  // ms: the newest of the PR update and the comment updates.
  lastActivity: number;
  checkpoint: CheckpointDto | null;
  build: BuildDto | null;
};

// WP4 fills the optional forge fields below. The detail renders each part only when its field is present.
// type: the change type from the forge, for example ADD, MODIFY, DELETE, MOVE. srcPath: the old path of a moved or copied file.
export type ChangedFile = { path: string; srcPath: string | null; type: string };
// author: the display name. at: ms. Newest first.
export type CommitDto = { hash: string; message: string; author: string; at: number };

// A deleted comment (D8) has text null and is never unread.
export type CommentDto = {
  id: number;
  version: number;
  parentId: number | null;
  rootId: number;
  authorSlug: string;
  authorName: string | null;
  // null for comments stored before the username was kept.
  authorLogin: string | null;
  text: string | null;
  anchor: unknown;
  threadResolved: boolean;
  // Root comments of resolved threads only, when the forge sent them (integration-check.md U56).
  resolver?: User;
  resolvedAt?: number;
  createdAt: number;
  updatedAt: number;
  unread: boolean;
  deleted: boolean;
  // Root comments of inline threads only.
  excerpt?: ExcerptLine[];
  task?: "open" | "done";
  // The app posted this comment: "run" from a review finding or question, "draft" from a reply draft, "reply" from the reply composer.
  posted?: "run" | "draft" | "reply";
  // Root comments of inline threads only: ms of the sync that saw the anchor turn orphaned. Absent: not orphaned, or orphaned at first sight.
  orphanedAt?: number;
};

// sourceHead: the source head of the last sync. null before the first sync.
export type PrDetail = {
  pr: PrRow;
  description: string | null;
  sourceHead: string | null;
  comments: CommentDto[];
  files?: ChangedFile[];
  commits?: CommitDto[];
};

export type FollowState = { id: number; followed: boolean; archivedAt: number | null };

export type ClaimedEvent = {
  id: number;
  pr: number;
  kind: "comment_new" | "commits_pushed" | "reviewer_added" | "draft_stale" | "build_failed" | "build_passed";
  ref: string;
  createdAt: number;
  // true: the event came after a sync gap of more than 2 check intervals. Show one summary per PR.
  digest: boolean;
  project: string;
  repo: string;
  prId: number;
  title: string | null;
};

const positiveInt = z.number().int().positive();
const version = z.number().int().nonnegative();

export const readInput = z.object({
  pr: positiveInt,
  items: z.array(z.object({ id: positiveInt, version })).max(10_000),
});
export const followInput = z.object({ followed: z.boolean() });
export const archiveInput = z.object({ archived: z.boolean() });
export const followUrlInput = z.object({ url: z.string().trim().min(1).max(2048) });

// ---------- Review (plan v3 WP10) ----------

export type ProfileId = string;

// PUT /api/prs/:id/brief. POST /api/prs/:id/review runs the stored brief.
export const briefInput = z.object({ note: z.string().max(MAX_NOTE), profile: profileId });
// A profile for one run only. Absent: the brief profile. The route refuses an ID that the settings do not list.
const runProfile = profileId.optional();
// The query of POST /api/prs/:id/review.
export const reviewRunInput = z.object({ profile: runProfile });
export type BriefInput = z.infer<typeof briefInput>;
// updatedAt: null for a PR without a stored brief. The defaults then apply.
export type BriefDto = BriefInput & { updatedAt: number | null };

// The runner check without paths. kind auth: authMethod is not claude.ai.
export type RunnerCheckDto = { ok: true; version: string } | { ok: false; kind: "unavailable" | "auth"; message: string };
// The run setup of a profile for the brief. model, effort: the profile flags; null: no flag. skillCount, mcpCount: the picked items.
export type ProfileDto = {
  id: ProfileId;
  name: string;
  note: string;
  explain: boolean;
  maxTurns: number;
  model: string | null;
  effort: Effort | null;
  reviewerMode: ReviewerMode;
  skillCount: number;
  // The skill IDs that every run of the profile needs.
  alwaysSkills: string[];
  mcpCount: number;
};

export type RunUsage = { costUsd: number; turns: number; durationMs: number; tokens: Record<string, unknown> };
// docs/plans/review-v2/spec.md section 1.8: the verdict counts of a review run. unchecked: the candidates without a verdict, because
// the verify phase is off, failed, or gave none. failed: the verify phase ended without a result. A run with no candidates has zeros.
export type VerifySummary = Record<"candidates" | "confirmed" | "refuted" | "unsure" | "questions" | "duplicates" | "unchecked", number> & {
  failed?: { kind: RunErrorKind | null; text: string | null };
};
export type RunPhase = { name: "find" | "check"; startedAt: number; endedAt: number | null; usage: RunUsage | null };
// dropped: findings that the validator could not anchor. They show as coverage only.
// volume, verify, phases: absent in summaries stored before review v2. The display uses the volume of the run, not of the profile.
export type RunSummary = Pick<ValidatedResult, "summary" | "risks" | "coverage" | "dropped"> & {
  volume?: Volume;
  verify?: VerifySummary;
  phases?: RunPhase[];
};

// session: a direct consult of the user's own session (docs/plans/session-consult.md part C).
// explain: an Explain this PR run. discuss: one turn of a talk about a finding (docs/plans/review-v2/spec.md sections 2 and 3).
// interview, spec, implement: the runs of a task (spec.md section 6.2). They have pr NULL, so no PR route gives them.
export type RunKind = "review" | "reply" | "ask" | "fix" | "session" | "explain" | "discuss" | TaskRunKind;

export type RunDto = {
  id: number;
  pr: number;
  kind: RunKind;
  profile: ProfileId;
  // The profile name at the start of the run.
  profileName: string;
  // The profile explain flag at the start of the run. null for runs made before it was stored.
  explain: boolean | null;
  note: string;
  status: RunStatus;
  errorKind: RunErrorKind | null;
  errorText: string | null;
  sourceHead: string;
  targetHead: string;
  mergeBase: string | null;
  via: "pull-request-ref" | "branch" | null;
  sessionId: string | null;
  cliVersion: string | null;
  // The model from the init event, else the --model value of the run. null: no init event and no --model value.
  model: string | null;
  // The --effort value of the run, or "default" for no flag. null for runs made before it was stored.
  effort: string | null;
  // effort "default" or null only: the effort that the user settings give. null: unknown.
  effortDefault: string | null;
  // true: effortDefault comes from the current settings, because the run stored none.
  effortNow: boolean;
  usage: RunUsage | null;
  // Ended runs with a valid result only.
  summary: RunSummary | null;
  startedAt: number;
  finishedAt: number | null;
  // Computed on read: a head of the PR differs from the reviewed head. null: both heads are the same.
  stale: { source: boolean; target: boolean } | null;
  hasRaw: boolean;
  // A re-review: head is the head that the base run reviewed. incremental: false when the run fell back to the full change.
  since: { head: string; incremental: boolean } | null;
  // An ask run only.
  question: string | null;
  // Plan r3 Feature C: the fetched tasks at the start of the run. Absent for runs made before it was stored.
  tasks?: { key: string; fetchedAt: number }[];
  // The project instruction files that the run got. Absent for runs made before it was stored.
  instructions?: { files: InstructionFileDto[]; bytes: number; notLoaded?: string[] };
  // The skills that the run got. always: the profile marks the skill Always use. Absent for runs made before it was stored.
  skills?: { id: string; always: boolean }[];
  // The finding items of the run that a re-review did not find fixed or outdated and the verify phase did not discard. 0 for other kinds.
  findings: number;
  // A running run: indexing builds the codegraph index of the snapshot before the CLI starts. A review run: finding is the first CLI
  // process, checking the verify phase (docs/plans/review-v2/spec.md section 1.9).
  phase?: "indexing" | "finding" | "checking";
  // Phase checking only: the number of candidates that the verify phase checks.
  candidates?: number;
  // A session run only: the transcript that it forked and the text that it got, with no transcript text. tokens: sessionTokens(bytes).
  // mode: consult.ts sessionModes, absent for runs made before part D. run: on a fix run that an import made from the proposal of a
  // session run (session-consult.md part D), that session run.
  consult?: {
    session: string;
    title: string | null;
    bytes: number;
    tokens: number;
    items: number;
    textBytes: number;
    mode?: "judge" | "fix";
    run?: number;
  };
};

export type ItemStatus = "new" | "accepted" | "discarded" | "posted";

export type ReviewItemDto = {
  id: number;
  run: number;
  kind: "finding" | "question" | "reply";
  body: string;
  // finding: the AnchoredFinding as validated. question: the Question. reply: the ReplyPayload; body is empty for action none.
  // carried: the item came from the base run of a re-review. fixed: findings only, a fix commit covers the finding.
  // session: the verdict of your session (docs/plans/session-consult.md part C).
  // discardReason: the reason chip of a finding that the user discarded (docs/plans/review-v2/spec.md section 4.1).
  // withdrawn: findings only, a discuss run withdrew the finding (spec.md section 2.2).
  payload: (AnchoredFinding | Question | ReplyPayload) & {
    carried?: Carried;
    fixed?: FixedMark;
    session?: SessionMark;
    discardReason?: { code: DiscardReason };
    withdrawn?: WithdrawnMark;
  };
  // Findings only: the current anchor.
  anchor: (Anchor & { side: Side }) | null;
  status: ItemStatus;
  revision: number;
  edited: boolean;
  // An open reply draft of GET reply-drafts and POST /api/items/:id, or an open finding of GET /api/runs/:id and POST /api/items/:id:
  // the newest revision of it (payload revises) that waits for Use revision or Keep mine. Absent: none.
  revised?: ReviewItemDto;
  // Reply items only: the run that wrote the draft. head: the source head at the run start. finishedAt: null while it runs.
  drafted?: { kind: RunKind; startedAt: number; finishedAt: number | null; head: string };
  // GET reply-drafts only: the note suggestions of the run that name this draft (docs/plans/review-v2/spec.md section 2.9).
  notes?: NoteDto[];
};

// ---------- PR notes (docs/plans/review-v2/spec.md section 2.9) ----------

// ref: the PR that this PR waits for. state MISSING: Bitbucket gave 404. deletedAt: set only in the answer of DELETE.
export type NoteRef = {
  project: string;
  repo: string;
  prId: number;
  title: string | null;
  state: "OPEN" | "MERGED" | "DECLINED" | "MISSING" | null;
};
export type NoteDto = {
  id: number;
  text: string;
  source: "user" | "claude";
  state: "kept" | "proposed" | "dismissed";
  thread: number | null;
  run: number | null;
  item: number | null;
  ref: NoteRef | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
};
// project and repo default to the PR's own.
const noteRefInput = z.object({
  prId: positiveInt,
  project: z.string().trim().min(1).max(200).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
});
const noteText = z.string().trim().min(1).max(NOTE_TEXT_MAX);
// POST /api/prs/:id/notes.
export const noteCreateInput = z.object({ text: noteText, ref: noteRefInput.optional() });
// PUT /api/notes/:id. ref null drops the link. state: Keep or Dismiss of a suggestion. restore: Undo of a delete.
export const noteUpdateInput = z.object({
  version,
  text: noteText.optional(),
  ref: noteRefInput.nullable().optional(),
  state: z.enum(["kept", "dismissed"]).optional(),
  restore: z.literal(true).optional(),
});
// DELETE /api/notes/:id.
export const noteDeleteInput = z.object({ version });
export type NoteCreateInput = z.infer<typeof noteCreateInput>;
export type NoteUpdateInput = z.infer<typeof noteUpdateInput>;
// A stale version: 409 with the current note.
export type NoteConflict = ApiError & { note: NoteDto };

// docs/plans/review-v2/spec.md section 4.1: the codes of payload.discardReason. Not a bug, Not worth fixing, Duplicate, Intended, Wrong place.
export const DISCARD_REASONS = ["bug", "worth", "duplicate", "intended", "place"] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

// POST /api/items/:id. revision: the item revision on screen. A mismatch gives 409 with ItemConflict.
// Every change raises the revision. edit also accepts the item. move takes a line of moveChoices(excerpt, side).
export const itemActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["accept", "discard", "restore"]), revision: version }),
  z.object({ action: z.literal("edit"), revision: version, body: z.string().trim().min(1).max(MAX_NOTE) }),
  z.object({ action: z.literal("move"), revision: version, line: positiveInt }),
  // Reply drafts only: the tick of "Resolve after posting".
  z.object({ action: z.literal("resolve"), revision: version, resolve: z.boolean() }),
  // A "Fixed in" draft whose commit is not on the PR: drop the commit link and accept the draft, so it posts as a plain reply.
  z.object({ action: z.literal("plain"), revision: version }),
  // A revision (payload revises) of the user's draft. use-revision: the revision becomes the draft, not accepted, and the user's draft is
  // discarded. draft: the revision of the user's draft on screen. keep-mine: the revision goes, and the user's draft stays as it is.
  z.object({ action: z.literal("use-revision"), revision: version, draft: version }),
  z.object({ action: z.literal("keep-mine"), revision: version }),
  // An open reply draft: answer the newest live message of the thread with the same text. No AI run.
  z.object({ action: z.literal("reply-to-newest"), revision: version }),
  // A finding that the user discarded: store payload.discardReason {code}. The item stays discarded.
  z.object({ action: z.literal("reason"), revision: version, code: z.enum(DISCARD_REASONS) }),
]);
export type ItemActionInput = z.infer<typeof itemActionInput>;
// item: the current item, for a reload.
export type ItemConflict = ApiError & { item: ReviewItemDto };

// GET /api/prs/:id/post-plan (plan v3 WP12). Confirm (WP13) posts these bodies byte for byte.
// lineType: the diff kind of the line. Old-side and outside findings post in the general comment (D3).
// srcLine: the old-side line of a ctx line. Bitbucket reads the line of a CONTEXT anchor on the old side (Gate v3 U4).
// reply: parentId is the comment that the reply answers.
export type PostDestination =
  | { kind: "inline"; path: string; srcPath: string | null; line: number; lineEnd: number; lineType: "add" | "ctx"; srcLine?: number }
  | { kind: "general" }
  | { kind: "reply"; parentId: number };
export type PlannedPost = {
  run: number;
  sourceHead: string;
  targetHead: string;
  mergeBase: string | null;
  destination: PostDestination;
  body: string;
  items: { id: number; revision: number }[];
  // A live root comment by another user on the same path and line.
  duplicate: { commentId: number; author: string } | null;
  // Reply posts only: the root comment of the thread to resolve after the post. An empty body resolves without a reply.
  resolve?: number;
  // Reply posts with a body only: the thread was resolved at the draft and is resolved now, so the post reopens it first.
  // A thread resolved after the draft blocks the draft (BlockedDraft resolved-since).
  reopen?: "resolved";
};
// docs/plans/thread-outcome.md: a reply draft that confirm cannot post now. out-of-date: new messages or a deleted parent.
// resolved-since: the thread was resolved after the draft. unpushed: the fix commit is not on the PR yet. commit-gone: the clone
// branch of the fix no longer holds the fix commit, after a rebase, squash, or reset. thread: the root comment.
// revision: the item revision, for an item action. commit: the short hash of the fix commit, for unpushed and commit-gone.
export type BlockedReason = "out-of-date" | "resolved-since" | "unpushed" | "commit-gone";
export type BlockedDraft = { item: number; revision: number; thread: number; reason: BlockedReason; commit?: string };
// posts: per run in run order, the inline comments and the replies in item order, then the general comment.
// blocked: the drafts that the plan leaves out. Absent: none.
export type PostPlanDto = { pr: number; posts: PlannedPost[]; blocked?: BlockedDraft[] };

// ---------- Outbox (plan v3 WP13a) ----------

// POST /api/prs/:id/confirm. items: every item of the confirmed posts, with the revisions on screen.
// A planned post is sent only when all of its items are here. Any other mismatch gives 409.
export const confirmInput = z.object({
  items: z
    .array(z.object({ id: positiveInt, revision: version }))
    .min(1)
    .max(1000),
});
export type ConfirmInput = z.infer<typeof confirmInput>;

// POST /api/prs/:id/replies. seen: the newest live message of the thread on screen, else 409 with ReplyConflict.
// key: a UUID made when the composer opens. The same key never sends twice.
export const replyPostInput = z.object({
  parentId: positiveInt,
  body: z.string().trim().min(1).max(MAX_NOTE),
  seen: positiveInt,
  key: z.uuid(),
});
export type ReplyPostInput = z.infer<typeof replyPostInput>;
export type ReplyConflict = ApiError & { newest: number };

// pending: not sent yet. sent: the request is out. unknown: no clear answer; the app checks the remote comments, then the user decides.
export type PostState = "pending" | "sent" | "unknown" | "failed" | "confirmed";

// One comment to send. The row binds the body, the destination, and the item revisions. run: null for a manual reply.
export type PostDto = {
  id: number;
  pr: number;
  run: number | null;
  destination: PostDestination;
  body: string;
  items: { id: number; revision: number }[];
  state: PostState;
  // The remote comment, set when the state is confirmed.
  remoteId: number | null;
  remoteVersion: number | null;
  attempts: number;
  lastError: string | null;
  // An unknown post that the app checks against the remote comments now.
  checking: boolean;
  createdAt: number;
  updatedAt: number;
  // The resolve step after the comment step. pending: it waits for the comment or runs now. A failed step never posts the reply again.
  resolve?: { root: number; state: "pending" | "done" | "failed"; error: string | null };
};

// POST /api/prs/:id/resolve: resolve or reopen a thread now. thread: the root comment. seen: the newest live message on screen.
export const threadResolveInput = z.object({ thread: positiveInt, resolved: z.boolean(), seen: positiveInt });
export type ThreadResolveInput = z.infer<typeof threadResolveInput>;
// reason: messages: new messages arrived. changed: the comment changed on the forge (HTTP 409). forbidden: no permission.
// gone: the thread is deleted. ignored: the forge took the change, but the thread state stayed.
export type ThreadResolveError = ApiError & { reason: "messages" | "changed" | "forbidden" | "gone" | "ignored" };

// warning: the target branch moved after the review (D2). The comments stay on the reviewed commits.
export type ConfirmDto = { posts: PostDto[]; warning: string | null };

// POST /api/prs/:id/reply-run. Absent threads: every thread where it is my turn. A thread is the ID of its root comment.
export const replyRunInput = z.object({ threads: z.array(positiveInt).min(1).max(MAX_REPLY_THREADS).optional(), profile: runProfile });

// ---------- Ask (plan r2 S-ASK) ----------

// POST /api/prs/:id/ask. GET /api/prs/:id/asks gives AskDto[], newest first, at most 20.
// parent: the ask run that this question follows (docs/plans/review-v2/spec.md section 2.15). Absent: a new conversation.
export const askInput = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION),
  profile: runProfile,
  parent: positiveInt.optional(),
});
export type AskInput = z.infer<typeof askInput>;
// answer: null until the run ends with a valid result. parent: the parent_run of the ask run.
export type AskDto = { run: RunDto; answer: string | null; parent: number | null };
// The 409 of an ask whose parent already has a follow-up. run: that follow-up.
export const MOVED_ON = "This conversation moved on in another tab. The newest turn is shown now.";
export type MovedConflict = ApiError & { moved: { run: number } };

// ---------- Review v2: Explain and Discuss (docs/plans/review-v2/spec.md sections 2.3 and 3.2) ----------

// GET /api/prs/:id/explain: the newest explain run. result: null until the run ends with a valid result. previous: the newest run
// with a result, when the newest run has none (it runs, failed, or was cancelled). run.stale: the PR heads moved after the run.
// The server checked the result (src/server/review/judge.ts judgeExplain): each walkthrough link diff:<path>#N<a>[-<b>] or #O names a
// changed file (path percent-decoded) and lines that its diff shows on that side. A risk with a path has the lines of its code.
// POST /api/prs/:id/explain takes reviewRunInput and gives RunDto: 202 for a new run, 200 for the running run or a stored result.
export type ExplainDto = { run: RunDto; result: ExplainResult | null; previous?: { run: RunDto; result: ExplainResult } };
// POST /api/items/:id/discuss (spec.md section 2.3). revision: the finding revision on screen. A mismatch gives 409 with ItemConflict.
// 202 with the run. 200 with the running run of the same item and message. 409: not a finding, a revision, MAX_DISCUSS_MESSAGES, or
// the run slot is busy (RunConflict).
export const discussInput = z.object({ message: z.string().trim().min(1).max(MAX_QUESTION), revision: version });
export type DiscussInput = z.infer<typeof discussInput>;
export const DISCUSS_FULL = `This talk has reached ${MAX_DISCUSS_MESSAGES} messages. Start a new review for a fresh look.`;
// The note of a turn whose finding changed during the run (DiscussTurnDto changed).
export const DISCUSS_CHANGED = "The finding changed while Claude worked. Nothing was applied.";
// GET /api/items/:id/discuss gives DiscussTurnDto[], oldest first. run: the discuss run. message: the user message. at: ms of the start.
// answer, verdict, reason, revision: null until the run ends with a valid result. error: the error text of a failed run.
// cites: the checked thread numbers that the answer relies on. notes: the note suggestions of the run that wait for Keep or Dismiss
// (spec.md section 2.9). applied: what the run stored: revision, the waiting revision item (the finding DTO carries it as revised);
// discarded, the finding is withdrawn; draft, the reply draft in the thread of a posted finding. changed: show DISCUSS_CHANGED.
export type DiscussTurnDto = {
  run: number;
  status: RunStatus;
  message: string;
  answer: string | null;
  verdict: DiscussVerdict | null;
  reason: string | null;
  revision: DiscussResult["revision"];
  at: number;
  error: string | null;
  cites: number[];
  notes: NoteDto[];
  applied: DiscussRecord["applied"];
  changed: boolean;
};

// ---------- Improve prompt (Settings > Review profiles) ----------

// POST /api/profiles/improve: the profile fields as the editor shows them, and the user's goal. Empty prompt: write a new one.
export const improveInput = z.object({
  name: z.string().trim().max(60),
  note: z.string().trim().max(200),
  prompt: z.string().trim().max(MAX_NOTE),
  explain: z.boolean(),
  docs: z.boolean(),
  languageChecks: z.boolean(),
  model: modelName.nullable(),
  effort: z.enum(EFFORTS).nullable(),
  goal: z.string().trim().max(MAX_QUESTION),
});
export type ImproveInput = z.infer<typeof improveInput>;
// GET /api/profiles/improve/:id. The server keeps only the newest proposal.
export type ImproveDto =
  | { id: number; status: "running"; startedAt: number }
  | { id: number; status: "done"; prompt: string; reasons: string[] }
  | { id: number; status: "failed"; kind: RunErrorKind; text: string }
  | { id: number; status: "cancelled" };

// ---------- Task context (plan r2 S-JIRA) ----------

export { JIRA_KEY };

// The listing of one issue attachment (plan r3 S-JMD). id: digits only. created: the timestamp text from the source.
export type AttachmentMeta = { id: string; filename: string; mimeType: string | null; size: number; created: string | null };

// created: the timestamp text from the source. commentsTotal: the comment count at the source. truncated: a size cap cut the text.
// format: "markdown" for text converted from rendered HTML. Absent: plain text (rows stored before Release 3).
export type IssueContext = {
  key: string;
  summary: string;
  status: string | null;
  description: string | null;
  comments: { author: string; created: string; body: string }[];
  commentsTotal: number;
  truncated: boolean;
  format?: "markdown";
  attachments?: AttachmentMeta[];
  // spec.md section 6.20.8. parent: the parent key of a sub-task. links: only links to other sub-tasks of the parent.
  parent?: string | null;
  subtasks?: IssueSubtask[];
  links?: IssueLink[];
};
// category: statusCategory.key of Jira. null when absent or another value.
export type IssueSubtask = { key: string; summary: string; status: string | null; category: "new" | "indeterminate" | "done" | null };
// text: the link text of the server, as in "ABC-13 is blocked by ABC-12".
export type IssueLink = { text: string; key: string };

// A downloaded attachment (plan r3 S-ATT). include: the file goes to context/attachments/ of each run. downloadedAt: ms.
// image, text, pdf: from the file bytes (attachments.ts store).
export type AttachmentDto = {
  id: string;
  filename: string;
  size: number;
  sha256: string;
  image: boolean;
  text: boolean;
  pdf: boolean;
  include: boolean;
  downloadedAt: number;
  // A file of a Jira sub-task (spec.md section 6.20.3): the sub-task key. Absent: the task key.
  issue?: string;
};
// fetchedAt: ms. files: the downloaded attachments.
export type TaskContextDto = IssueContext & { source: "jira"; fetchedAt: number; files: AttachmentDto[] };

// The :att route parameter.
export const ATT_ID = /^[0-9]{1,18}$/;
// PUT /api/prs/:id/task-context/:key/files/:att.
export const attachmentInput = z.object({ include: z.boolean() });

// Plan r3 caps. Per file and per PR on disk, then the run inclusion caps.
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_PR_ATTACHMENT_BYTES = 500 * 1024 * 1024;
export const RUN_IMAGE_BYTES = 5 * 1024 * 1024;
export const RUN_IMAGES = 20;
export const RUN_TEXT_BYTES = 256 * 1024;
export const RUN_TEXT_TOTAL = 1024 * 1024;
// docs/plans/review-v2/spec.md section 6.17: PDFs go to runs as files. The Read tool of the CLI reads them page by page.
export const RUN_PDF_BYTES = RUN_IMAGE_BYTES;
export const RUN_PDF_TOTAL = 20 * 1024 * 1024;

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ONLY_KINDS = "Listed only: only images, PDFs, and text files go to runs.";

// spec.md section 6.17: the kind of a listed attachment before its download, from the listed media type. text: a text/* type or a
// JSON or XML MIME type (WHATWG MIME Sniffing, section 4.6, "MIME type groups"). null: runs never get it. After the download, the
// file bytes decide (task-file.ts).
export function listedKind(mimeType: string | null): "image" | "pdf" | "text" | null {
  const essence = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const sub = essence.slice(essence.indexOf("/") + 1);
  if (RASTER_TYPES.has(essence)) return "image";
  if (essence === "application/pdf") return "pdf";
  if (essence.startsWith("text/") || essence === "application/json" || sub.endsWith("+json")) return "text";
  if (essence === "application/xml" || sub.endsWith("+xml")) return "text";
  return null;
}

// Why a listed attachment cannot go to runs, or null when a task can give it to Claude. The run caps can still leave it out.
export function listedOnly(a: Pick<AttachmentMeta, "mimeType" | "size">): string | null {
  const kind = listedKind(a.mimeType);
  if (!kind) return ONLY_KINDS;
  if (a.size > MAX_ATTACHMENT_BYTES) return `Listed only: the file is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
  if (kind === "image" && a.size > RUN_IMAGE_BYTES) return `Listed only: runs get images up to ${RUN_IMAGE_BYTES / 1024 / 1024} MB.`;
  if (kind === "pdf" && a.size > RUN_PDF_BYTES) return `Listed only: runs get PDFs up to ${RUN_PDF_BYTES / 1024 / 1024} MB.`;
  return null;
}

// Why a downloaded file cannot go to runs, or null. The file bytes decide, with the same caps as task-file.ts.
export function fileOnly(f: Pick<AttachmentDto, "image" | "pdf" | "text" | "size">): string | null {
  if (f.image) return f.size > RUN_IMAGE_BYTES ? `Listed only: runs get images up to ${RUN_IMAGE_BYTES / 1024 / 1024} MB.` : null;
  if (f.pdf) return f.size > RUN_PDF_BYTES ? `Listed only: runs get PDFs up to ${RUN_PDF_BYTES / 1024 / 1024} MB.` : null;
  return f.text ? null : ONLY_KINDS;
}

// PUT /api/settings/jira. Empty baseUrl disconnects Jira and clears the token. Absent or empty token keeps the stored token.
// An email selects Jira Cloud. Absent or empty email selects Server/Data Center.
export const jiraSettingsInput = z.object({
  baseUrl: z.string().trim().max(2048),
  token: z.string().trim().optional(),
  caFile: z.string().trim().optional(),
  email: z
    .string()
    .trim()
    .pipe(z.union([z.literal(""), z.email()]))
    .optional(),
});
export type JiraSettingsInput = z.infer<typeof jiraSettingsInput>;

// ---------- Diff (plan r2 S-DIFF) ----------

export const DIFF_PAGE_ROWS = 1000;

// Same shape as DiffRow in src/server/review/diffmap.ts.
export type DiffRowDto = { kind: DiffKind; old: number; new: number; text: string };
// path: null for a deleted file. oldPath: null for an added file. rows: the row count of the file.
export type DiffFileDto = { path: string | null; oldPath: string | null; binary: boolean; added: number; removed: number; rows: number };
// GET /api/prs/:id/diff and POST /api/prs/:id/diff/fetch.
export type DiffIndexDto = { sourceHead: string; targetHead: string; mergeBase: string; files: DiffFileDto[] };
// GET /api/prs/:id/diff/file?path=&start=. next: the start of the next page, or null on the last page.
export type DiffPageDto = {
  path: string | null;
  oldPath: string | null;
  binary: boolean;
  start: number;
  next: number | null;
  rows: DiffRowDto[];
};
// GET /api/prs/:id/diff gives 409 with this body when the cache does not hold the PR heads.
export type DiffFetchNeeded = ApiError & { fetch: true };

// ---------- Fix it (plan r3) ----------

// POST /api/prs/:id/fix-run. findings: review item IDs. Absent threads and findings: the newest valid or partly reply draft of each thread.
// docs/plans/fix-ux.md WP3: one run takes at most MAX_REPLY_THREADS threads and findings together. The route shows the refine message.
// anyway: "Fix anyway" (docs/plans/thread-outcome.md). The user wants edits despite a decision or risk note. Exactly one target.
const fixTargets = z.array(positiveInt).min(1).max(MAX_REPLY_THREADS).optional();
export const fixRunInput = z
  .object({ threads: fixTargets, findings: fixTargets, profile: runProfile, anyway: z.boolean().optional() })
  .refine((v) => (v.threads?.length ?? 0) + (v.findings?.length ?? 0) <= MAX_REPLY_THREADS, {
    message: `Pick at most ${MAX_REPLY_THREADS} threads and findings for one run.`,
  })
  .refine((v) => !v.anyway || (v.threads?.length ?? 0) + (v.findings?.length ?? 0) === 1, {
    message: "Fix anyway takes exactly one thread or finding.",
  });

// One stored edit. Exactly one of thread and finding is set. added, removed: the line counts of rows.
export type FixEditDto = {
  id: number;
  thread?: number;
  finding?: number;
  path: string;
  added: number;
  removed: number;
  rows: DiffRowDto[];
};

export const fixModes = ["clone", "cache"] as const;
export type FixMode = (typeof fixModes)[number];
export type FixCommitState = "committed" | "staged" | "undone";

// edits: the fix_edit IDs. before: the head before the commit, or the parent in cache mode.
// fetch: cache mode only. The UI builds the git fetch command from it.
export type FixCommitDto = {
  id: number;
  run: number;
  mode: FixMode;
  edits: number[];
  branch: string | null;
  before: string;
  commit: string | null;
  short: string | null;
  state: FixCommitState;
  fetch: { cache: string; ref: string } | null;
  createdAt: number;
};

// GET /api/prs/:id/fixes gives FixDto[], newest first, at most 10. Each note names exactly one of thread and finding.
export type FixDto = {
  run: RunDto;
  threads: FixNote[];
  edits: FixEditDto[];
  commits: FixCommitDto[];
};

// GET /api/prs/:id/threads/:thread/history (docs/plans/thread-outcome.md section 10). The client merges it with the thread messages.
// at: ms. exact false: the time of the run, not of the draft itself ("Won't fix" from a decline).
// replacedBy: the item that replaced a discarded draft, else null. edits: the edits of this thread in the commit. of: the edits of this
// thread in the fix run. pushed: the PR commits list the commit. undoneAt: ms of the undo, else null.
// posts: replies in the thread, resolves of the thread, and the post that started the thread. error: last_error of the post.
export type ThreadHistoryDto = {
  thread: number;
  drafts: { at: number; exact: boolean; item: ReviewItemDto; replacedBy: number | null }[];
  fixes: { at: number; run: number; note: FixNote }[];
  commits: {
    at: number;
    id: number;
    run: number;
    short: string | null;
    state: FixCommitState;
    edits: number;
    of: number;
    pushed: boolean;
    undoneAt: number | null;
  }[];
  posts: {
    at: number;
    id: number;
    run: number | null;
    kind: PostDestination["kind"];
    state: PostState;
    error: string | null;
    remoteId: number | null;
    updatedAt: number;
    resolve: NonNullable<PostDto["resolve"]> | null;
  }[];
};

// POST /api/fix-runs/:run/commit. The server checks only the message length.
export const fixCommitInput = z.object({
  edits: z.array(positiveInt).min(1).max(MAX_FIX_EDITS),
  message: z.string().min(1).max(5000),
  mode: z.enum(fixModes),
});
export type FixCommitInput = z.infer<typeof fixCommitInput>;

// docs/plans/thread-outcome.md "Don't fix": decline the proposal of a fix run for one thread or one finding.
// reason: the text of the "Won't fix" reply draft.
export const fixDeclineInput = z
  .object({
    run: positiveInt,
    thread: positiveInt.optional(),
    finding: positiveInt.optional(),
    reason: z.string().trim().min(1).max(MAX_NOTE),
  })
  .refine((v) => (v.thread === undefined) !== (v.finding === undefined), { message: "Name exactly one thread or one finding." });
export type FixDeclineInput = z.infer<typeof fixDeclineInput>;
// Undo of a decline: the same run and target.
export const fixUndeclineInput = z
  .object({ run: positiveInt, thread: positiveInt.optional(), finding: positiveInt.optional() })
  .refine((v) => (v.thread === undefined) !== (v.finding === undefined), { message: "Name exactly one thread or one finding." });
export type FixUndeclineInput = z.infer<typeof fixUndeclineInput>;

export const cloneProblems = [
  "not_set",
  "missing",
  "not_repo",
  "detached",
  "branch",
  "no_base",
  "behind",
  "diverged",
  "dirty",
  "busy",
  "identity",
  "patch",
] as const;
export type CloneProblem = (typeof cloneProblems)[number];

// GET, PUT /api/prs/:id/clone. text: a fixed text per kind.
export type CloneDto = {
  path: string | null;
  problems: { kind: CloneProblem; text: string }[];
  branch: string | null;
  head: string | null;
};
// GET /api/clones: one row per repository with a clone folder. pr: a PR of the repository, for the /prs/:id/clone routes.
// missing: the folder does not exist now.
export type CloneRowDto = { project: string; repo: string; path: string; pr: number; missing: boolean };
// POST /api/fix-runs/:run/commit gives 409 with this body when a clone check fails.
export type FixConflict = ApiError & { problems: CloneDto["problems"] };
export const cloneInput = z.object({ path: z.string().trim().min(1).max(4096) });
export type CloneInput = z.infer<typeof cloneInput>;

// Project instructions per repository. The app reads these clone files only at the clone root.
export const CLONE_INSTRUCTION_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"] as const;
export const EXTRA_INSTRUCTIONS_MAX = 20_000;
export const instructionsInput = z.object({
  target: z.boolean(),
  local: z.array(z.enum(CLONE_INSTRUCTION_FILES)).max(CLONE_INSTRUCTION_FILES.length),
  extra: z.string().max(EXTRA_INSTRUCTIONS_MAX),
});
export type InstructionsInput = z.infer<typeof instructionsInput>;
// GET /api/instructions: one row per repository of a stored PR or a task. pr: the newest PR of the repository, null when only tasks
// name it. clone: null when not set. PUT /api/repos/:project/:repo/instructions saves by repository.
export type InstructionRepoDto = { project: string; repo: string; pr: number | null; clone: string | null; settings: InstructionsInput };
// path: from the repository or clone root. Empty for the settings text.
// path: from the config folder for the global source.
// scope: the folder of a CLAUDE.md of a changed folder on the target branch. The file applies to <scope>/** only. Absent: all files.
export type InstructionFileDto = { source: "global" | "target" | "clone" | "settings"; path: string; bytes: number; scope?: string };
// GET and PUT /api/instructions/global: the switch for the global instruction file of the runner config folder. It applies to every repository.
// path: the file that runs read when the switch is on.
export const globalInstructionsInput = z.object({ on: z.boolean() });
export type GlobalInstructionsDto = { on: boolean; path: string };
// GET /api/prs/:id/instructions/preview. found: the clone files that exist now. target "no-cache": no run fetched the target branch yet.
export type InstructionPreviewDto = {
  readAt: number;
  found: string[];
  target: "read" | "no-cache" | "off";
  files: InstructionFileDto[];
  bytes: number;
  text: string;
  notLoaded: string[];
};

// GET /api/runs/:id. events: the run log in seq order.
export type RunDetail = { run: RunDto; events: RunEvent[]; items: ReviewItemDto[] };

// POST /api/prs/:id/review gives 409 with this body while another review runs (A14).
// pr null: a task run holds the slot, and task names its task (POST /api/tasks/:id/pause frees the slot after the step).
export type RunConflict = ApiError & { running: { run: number; pr: number | null; kind: RunKind; task?: number } };

// sure: false when the source has a precedence that the runner docs do not state.
export type SettingValue = { value: string; sure: boolean };
// model: the model of a run without --model. null: the account default, which the app cannot see.
// effort: the effort of a run without --effort, by model choice. Key "": no --model. The other keys: each alias and each profile model text.
// An absent key: unknown.
export type RunnerDefaults = { model: SettingValue | null; effort: Record<string, SettingValue> };

// GET /api/meta. Product names, and the default model and effort of the runner. No other setting value.
export type MetaDto = {
  // The package.json version. commit: the commit of a compiled binary, null when Bun runs the source.
  app: { version: string; commit: string | null };
  forge: { name: string };
  // check: the cached runner check. null before the first check. Each run refreshes it.
  // login: the command that signs the runner in with the subscription. models: the model aliases that the settings offer.
  // modelExample: a full model ID for the placeholder of the model ID field.
  runner: {
    name: string;
    short: string;
    initials: string;
    login: string;
    models: string[];
    modelExample: string;
    check: RunnerCheckDto | null;
    // defaults: from the user settings file of the runner. null: the file is absent or unreadable.
    defaults: RunnerDefaults | null;
  };
  // Run log labels, keyed by RunEvent.tool.
  tools: Record<string, string>;
  profiles: ProfileDto[];
  // Context sources (plan r2). Each source is listed whether it is set up or not. configured: the source has settings.
  context: { id: string; name: string; configured: boolean }[];
};

// POST /api/settings/task-rules/preview. Absent prs: the first 20 listed PRs.
export const taskPreviewInput = z.object({
  rules: z.array(taskRuleInput).max(MAX_TASK_RULES),
  sample: z.object({ branch: z.string().optional(), title: z.string().optional(), description: z.string().optional() }).optional(),
  prs: z.array(positiveInt).max(20).optional(),
});

export type TaskPreviewInput = z.infer<typeof taskPreviewInput>;

export type FoundTask = { key: string; source: TaskSource };

// Index i of rules belongs to rule i of the request. A 400 carries the same rules array with the syntax errors.
export type TaskPreviewDto = {
  rules: { error: string | null; timedOut: boolean }[];
  sample: FoundTask[] | null;
  prs: { id: number; project: string; repo: string; prId: number; title: string | null; tasks: FoundTask[] }[];
};

export type TaskPreviewError = ApiError & { rules: TaskPreviewDto["rules"] };

// ---------- Review quality (docs/plans/review-v2/spec.md section 4.2) ----------

// GET /api/stats/review?days=30: the review runs that started in the last `days` days.
export const reviewStatsInput = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
// One row per profile name and prompt version. A finding counts once, in the run that first found it. A re-review copy gives
// the later outcome of its source. shown: in the main list of the run volume. accepted: accepted or posted. acceptedShown: the
// accepted ones that are shown, so it never exceeds shown. edited: accepted with your text. discarded: by you only, not by the
// check, a fix commit, a re-review, or your session. byReason: per reason code;
// "none" counts discards without a chip. addressed: posted, and its thread is resolved or has a "Fixed in" draft. outdated: posted,
// and its root comment turned orphaned after the post. medianMinutes: of the run time; null without an ended run.
// usage: the sum over the runs that report it.
export type ReviewStatsDto = {
  profile: string;
  promptVersion: string;
  runs: number;
  candidates: number;
  refuted: number;
  unsure: number;
  shown: number;
  accepted: number;
  acceptedShown: number;
  edited: number;
  discarded: { total: number; byReason: Record<DiscardReason | "none", number> };
  posted: number;
  addressed: number;
  outdated: number;
  medianMinutes: number | null;
  usage: { costUsd: number; turns: number };
};

// ---------- Build a Jira task (docs/plans/review-v2/spec.md sections 6.3 and 6.11) ----------

// spec.md section 6.11. JIRA_KEY above is the rule of a Jira fetch.
export const TASK_KEY = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
export const MAX_TASK_REVIEWERS = 20;
export const MAX_TASK_COMMANDS = 20;
export const MAX_TASK_DOC = 120_000;
export const MAX_TASK_ANSWER = 2000;

// git-check-ref-format for a branch name (git-scm.com/docs/git-check-ref-format). git also refuses a branch that starts with "-".
const refOk = (b: string) =>
  ![...b].some((ch) => ch <= " " || ch === "\x7f" || "~^:?*[\\".includes(ch)) &&
  !b.includes("..") &&
  !b.includes("@{") &&
  !b.includes("//") &&
  b !== "@" &&
  !b.startsWith("-") &&
  !b.startsWith("/") &&
  !b.endsWith("/") &&
  !b.endsWith(".") &&
  !b.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock"));
export const branchName = z.string().min(1).max(255).refine(refOk, "Invalid branch name.");
// spec.md section 6.16.1: a prefix is valid when <prefix>x is a valid branch name.
export const branchPrefix = z
  .string()
  .min(1, "Invalid branch prefix.")
  .max(PREFIX_MAX, "Invalid branch prefix.")
  .refine((p) => refOk(`${p}x`), "Invalid branch prefix.");
export const branchPrefixList = z
  .array(branchPrefix)
  .min(1, "Keep at least one prefix.")
  .max(PREFIXES_MAX, `At most ${PREFIXES_MAX} prefixes.`)
  .refine((l) => new Set(l).size === l.length, "This prefix is already in the list.");
const repoName = z.string().trim().min(1).max(255);
const taskReviewers = z.array(z.string().trim().min(1).max(255)).max(MAX_TASK_REVIEWERS);
const taskSize = z.enum(TASK_SIZES);

// POST /api/tasks. 201 with the new task, or 200 with the open task of the same key. files: the attachment IDs that Claude gets
// (spec.md section 6.17). Absent: every file that can go to runs when the setting askAttachments is off, else none. profile: the
// review profile of every step (spec.md section 6.2). Absent: the preselection of GET /api/tasks/profile.
export const taskCreateInput = z.object({
  project: repoName,
  repo: repoName,
  key: z.string().regex(TASK_KEY),
  originPr: positiveInt.optional(),
  files: z.array(z.string().regex(ATT_ID)).max(200).optional(),
  profile: profileId.optional(),
  // spec.md section 6.20.1. true: build the sub-tasks of the key, one PR each. false: one task. Absent: sub-tasks when one is not done.
  // subtaskFiles: the ticked files of each open sub-task. Absent: the rule of files for each sub-task.
  subtasks: z.boolean().optional(),
  subtaskFiles: z
    .array(z.object({ key: z.string().regex(JIRA_KEY), files: z.array(z.string().regex(ATT_ID)).max(200) }))
    .max(SUBTASKS_READ)
    .optional(),
});
// GET /api/tasks/profile: the profile that the Build form preselects for a repository (spec.md section 6.2).
export const taskProfileInput = z.object({ project: repoName, repo: repoName });
export type TaskProfileDto = { profile: ProfileId };
// GET /api/tasks/repos: the repositories that the token can push to, for the Build form. complete: false when REPO_LIST_MAX cut it.
export type TaskRepoListDto = { repos: { project: string; repo: string }[]; complete: boolean };
// POST /api/tasks/issue: the issue of a key before the task exists (spec.md section 6.17). One Jira read on the user's click.
export const taskIssueInput = z.object({ key: z.string().regex(TASK_KEY) });
// subtasks: the sub-tasks of the key in Jira order, from the same read (spec.md section 6.20.1).
export type TaskIssueDto = {
  key: string;
  summary: string;
  status: string | null;
  attachments: AttachmentMeta[];
  subtasks: IssueSubtask[];
};
// GET /api/tasks.
export const taskListInput = z.object({ state: z.enum(["open", "all"]).default("open") });
// POST /api/tasks/:id/answers. question: a task_question ID. choice: the index of an option. recommended: use every recommended answer.
export const taskAnswersInput = z.object({
  version,
  answers: z
    .array(
      z.object({ question: positiveInt, choice: z.number().int().min(0).optional(), text: z.string().max(MAX_TASK_ANSWER).optional() }),
    )
    .max(INTERVIEW_QUESTIONS[0]),
  recommended: z.literal(true).optional(),
});
// PUT /api/tasks/:id/docs. 422 with the line of a parse error.
export const taskDocInput = z.object({ version, doc: z.enum(TASK_DOCS), text: z.string().max(MAX_TASK_DOC) });
// POST /api/tasks/:id/plan. warning: the first-use warning of the repository is accepted.
export const taskPlanInput = z.object({
  version,
  size: taskSize,
  // An ID picks an offered command as it is. A whole command is one that the user edited or added on the plan screen. Its ID is an
  // offered ID or starts with "new-".
  commands: z.array(z.union([commandId, taskCommand])).max(MAX_TASK_COMMANDS),
  warning: z.literal(true).optional(),
  // spec.md section 6.16. Absent prefix: the first prefix of Settings > Tasks. Absent existing: continue. bases: the base pick of each
  // repository of the task (section 6.16.3); each one must be the base that the plan was written on. Absent: the stored bases.
  prefix: branchPrefix.optional(),
  existing: z.enum(["continue", "new"]).optional(),
  bases: z
    .array(z.object({ taskRepo: positiveInt, branch: branchName }))
    .max(100)
    .optional(),
  // spec.md section 6.20.5: the plan of a sub-task task. parts: the start of each plan part n; after names a part number or a tracked
  // sub-task key. existing: the found branch of the part key. track: the PR that the app follows for a sub-task with several open PRs.
  subtasks: z
    .object({
      parts: z
        .array(
          z.object({
            n: positiveInt,
            start: z.enum(START_MODES),
            after: z.string().max(40).nullable(),
            existing: z.enum(["continue", "new"]).optional(),
          }),
        )
        .max(SUBTASK_PARTS_MAX),
      track: z.array(z.object({ key: z.string().regex(JIRA_KEY), pr: positiveInt })).max(SUBTASKS_READ),
      maxOpen: z.number().int().min(1).max(MAX_OPEN_CAP),
    })
    .optional(),
});
// POST /api/tasks/:id/plan-again (spec.md section 6.20.12): the spec run starts again with text as an answer line. add: plan the sub-tasks
// that are new in Jira (section 6.20.14).
export const taskPlanAgainInput = z.object({
  version,
  text: z.string().trim().min(1).max(MAX_TASK_ANSWER),
  add: z.literal(true).optional(),
});
// GET /api/repos/:project/:repo/branches (spec.md section 6.16.3).
export const branchSearchInput = z.object({ filter: z.string().max(255).default("") });
export type BranchSearchDto = { defaultBranch: string | null; branches: { name: string; isDefault: boolean }[]; more: boolean };
// GET /api/tasks/:id/branch (spec.md section 6.16.4). Absent prefix: the stored pick, else the first prefix of Settings > Tasks.
export const branchCheckInput = z.object({ prefix: branchPrefix.optional() });
// exists: the repositories of the task where name exists, with the remote head. openPr: the synced open PR from name to the base.
// nextFree: the first name with a suffix that no repository has. taskRepo stays null until a task has several repositories (WP-MR1).
export type BranchCheckDto = {
  name: string;
  exists: { taskRepo: number | null; project: string; repo: string; head: string }[];
  openPr: number | null;
  nextFree: string;
};
// PUT /api/tasks/:id/base (spec.md section 6.16.3): 200, or 202 when the plan runs again on the new base. taskRepo: the repository of
// the pick (task_repo.id). Absent: the main repository.
export const taskBaseInput = z.object({ version, taskRepo: positiveInt.optional(), branch: branchName });
// POST /api/tasks/:id/spec-pr and POST /api/tasks/:id/parts/:part/pr.
export const taskReviewersInput = z.object({ version, reviewers: taskReviewers });
// POST /api/tasks/:id/parts/:part/prs (spec.md section 6.16.8): the rows of "Push and open PRs". One row is a retry. The cap bounds the
// request only.
export const taskPrsInput = z.object({
  version,
  rows: z
    .array(z.object({ taskRepo: positiveInt, reviewers: taskReviewers }))
    .min(1)
    .max(100),
});
// POST /api/tasks/:id/repos/:taskRepo (spec.md section 6.16.5): Add (true) or Skip (false) of a proposed repository.
export const taskRepoChoiceInput = z.object({ version, add: z.boolean() });
// POST /api/tasks/:id/prs/:taskPr/pointer (spec.md section 6.16.8). newest: the user confirmed the newest base commit, because
// Bitbucket named no merge commit.
export const taskPointerInput = z.object({ version, newest: z.literal(true).optional() });
// POST /api/tasks/:id/build. override: start without the approval of the spec PR.
export const taskBuildInput = z.object({ version, override: z.literal(true).optional() });
// POST /api/tasks/:id/parts/:part/push. force: the confirmed rebase push. It keeps the lease.
export const taskPushInput = z.object({ version, force: z.literal(true).optional() });
// POST /api/tasks/:id/size.
export const taskSizeInput = z.object({ version, size: taskSize });
// POST /api/tasks/:id/spec-change/:step.
export const specChangeInput = z.object({ version, accept: z.boolean() });
// POST /api/tasks/:id/pause, /resume, /stop, /close, /parts/:part/retarget, /parts/:part/fix ("Fix these too"), /parts/:part/update,
// and /parts/:part/update/undo (spec.md section 6.18.6).
export const taskVersionInput = z.object({ version });
// spec.md section 6.20.12: "Start <key> now" overrides the review of the lower part. "Move" with push pushes first.
export const taskStartInput = z.object({ version, override: z.literal(true) });
export const taskMoveInput = z.object({ version, push: z.literal(true).optional() });
// POST /api/tasks/:id/jira/:key/transitions (spec.md section 6.20.12): the transition that the user confirmed in "Move in Jira".
export const taskTransitionInput = z.object({ id: z.string().regex(/^\d{1,10}$/) });
// GET /api/tasks/:id/jira/:key/transitions. to: the status name after the move, null when Jira names none.
export type TaskTransitionsDto = { transitions: { id: string; name: string; to: string | null }[] };
// The answer of the move. status: the new status of the issue.
export type TaskJiraMoveDto = { status: string | null; task: TaskDto };
// POST /api/tasks/:id/instructions (spec.md section 6.18.6): "Tell Claude". part: absent takes the part of the current state.
export const taskInstructionsInput = z.object({
  version,
  part: positiveInt.optional(),
  text: z.string().trim().min(1).max(MAX_INSTRUCTION),
});
// POST /api/tasks/:id/limit (spec.md section 6.1, a part over the line limit): keep, "Keep one PR"; lineBudget, "Change the limit" for
// this task.
export const taskLimitInput = z.union([
  z.object({ version, keep: z.literal(true) }),
  z.object({ version, lineBudget: z.number().int().min(1).max(100_000) }),
]);
// PUT /api/repos/:project/:repo/task-settings. spec_dir: a relative folder; {key} stands for the Jira key.
export const repoTaskSettingsInput = z.object({
  specDir: z
    .string()
    .min(1)
    .max(200)
    .refine((d) => !/^[/\\]|^[A-Za-z]:|\\/.test(d) && !d.split("/").includes(".."), "Use a relative folder with / separators."),
  lineBudget: z.number().int().min(1).max(100_000),
  maxOpen: z.number().int().min(1).max(20),
  approvals: z.number().int().min(0).max(20),
  commands: z.array(taskCommand).max(MAX_TASK_COMMANDS),
  testGlobs: z.array(z.string().min(1).max(200)).max(50).nullable(),
  excludeGlobs: z.array(z.string().min(1).max(200)).max(50).nullable(),
  isolateHome: z.boolean(),
});
export type TaskCreateInput = z.infer<typeof taskCreateInput>;
export type TaskAnswersInput = z.infer<typeof taskAnswersInput>;
export type TaskPlanInput = z.infer<typeof taskPlanInput>;
export type TaskPlanAgainInput = z.infer<typeof taskPlanAgainInput>;
export type RepoTaskSettingsInput = z.infer<typeof repoTaskSettingsInput>;
// warnedAt: the first-use warning of the repository was accepted then.
export type RepoTaskSettingsDto = RepoTaskSettingsInput & { project: string; repo: string; warnedAt: number | null };

export type TaskQuestionDto = {
  id: number;
  source: QuestionSource;
  round: number;
  ord: number;
  text: string;
  why: string;
  kind: "choice" | "text";
  options: { label: string; detail: string }[];
  recommended: number | null;
  answer: { choice: number | null; text: string } | null;
  step: number | null;
  askedAt: number;
  answeredAt: number | null;
};

// pushed: the lease of the next push. prState and waiting: the synced PR row of pr (OPEN, MERGED, DECLINED), and the names of its
// reviewers who have not approved yet. null and [] before the first sync of the PR.
export type TaskPartDto = {
  id: number;
  ord: number;
  kind: PartKind;
  title: string;
  branch: string;
  baseBranch: string;
  pr: number | null;
  remotePr: number | null;
  state: PartState;
  head: string | null;
  pushed: string | null;
  lines: number | null;
  usage: RunUsage | null;
  prState: string | null;
  waiting: string[];
  build: BuildDto | null;
  // spec.md section 6.20.8: the sub-task keys, the start, the part ID that it starts after, a PR that the app did not create, and the
  // plan folder (null: TaskDto.specDir). A part of a task without sub-tasks has keys [] and start null.
  keys: string[];
  start: StartMode | null;
  after: number | null;
  adopted: boolean;
  specDir: string | null;
  // spec.md sections 6.20.6 and 6.20.8. bases: the base check of this built part, as TaskDto.bases. lower: the merge of the lower part,
  // null until it merged. gate: the part gate of a part with a PR, null without a gate result. wait: the reason of the scheduler for a
  // planned part.
  bases: TaskBaseDto[];
  lower: { key: string; how: "merge" | "squash" | "other" } | null;
  gate: { pass: boolean; why: string } | null;
  wait: string | null;
};

// A repository of the task (spec.md section 6.16.5). path: from the main repository root, null for main. project and repo: null for a
// submodule that maps to no Bitbucket repository. reason: why the task cannot change it. proposal: a repository of role added that a
// spec run proposed ("Add" and "Skip"), with Claude's reason; only proposal added is in the task.
export type TaskRepoDto = {
  id: number;
  role: RepoRole;
  project: string | null;
  repo: string | null;
  path: string | null;
  depth: number;
  access: RepoAccess;
  reason: string | null;
  baseBranch: string | null;
  proposal: "proposed" | "added" | "skipped" | null;
  proposalReason: string | null;
};

// spec.md section 6.16.9: task_pr.state. The main repository row takes it from its part.
export type TaskPrState = "changed" | "pushed" | "pr_open" | "merged" | "declined" | "failed";

// One row of "Push and open PRs" (spec.md section 6.16.8): a changed repository of a part, the submodules deepest first and the main
// repository last. id: task_pr.id for the pointer route, null for the main repository. error: the sentence of the last failed push,
// create, or pointer move. running: the step of the row that runs now. pointer: the gitlink of the parent after the PR of a submodule
// merged. reviewers: the first reviewer chips, as TaskDto.reviewers for this repository.
export type TaskPrDto = {
  id: number | null;
  part: number;
  taskRepo: number;
  role: RepoRole;
  project: string;
  repo: string;
  path: string | null;
  branch: string;
  baseBranch: string;
  head: string | null;
  pushed: string | null;
  // The changed files and lines of the row's diff (spec.md section 6.1, Counting). null before the first line count.
  files: number | null;
  lines: number | null;
  pr: number | null;
  remotePr: number | null;
  state: TaskPrState;
  error: string | null;
  running: "push" | "pr" | null;
  pointer: "task_branch" | "merged_commit" | null;
  reviewers: string[];
  build: BuildDto | null;
};

// A point of the newest own review of a part that the loop does not fix: not a confirmed blocker or major (spec.md section 6.7).
// "Fix these too" fixes them.
export type TaskPointDto = { id: number; severity: string; path: string; line: number | null; text: string };

// GET /api/tasks/:id/parts/:part/diff: the part diff from the base commit to the part head. more: the rows that the answer leaves out.
export type TaskDiffDto = {
  base: string;
  head: string;
  files: (Omit<DiffFileDto, "rows"> & { rows: DiffRowDto[]; more: number })[];
};

export type TaskStepDto = {
  id: number;
  part: number | null;
  ord: number;
  kind: StepKind;
  run: number | null;
  state: StepState;
  attempt: number;
  item: string | null;
  detail: StepDetail;
  startedAt: number;
  endedAt: number | null;
};

// GET /api/tasks. A row of the Tasks view. progress: the facts of the status line (spec.md section 6.12, Inbox). part: the ordinal of
// the first code part that did not merge, 0 before the build. ready: that part waits for its PR. merged: every PR of the task merged.
export type TaskRowDto = {
  id: number;
  project: string;
  repo: string;
  key: string;
  title: string;
  state: TaskState;
  size: TaskSize | null;
  blocked: TaskBlocked | null;
  version: number;
  updatedAt: number;
  closedAt: number | null;
  progress: { planReady: boolean; part: number; parts: number; ready: boolean; merged: boolean };
};

// The newest interview result (spec.md section 6.5) of round round. done false: the answers start round 2 when it is left.
export type TaskInterviewDto = { round: number; summary: string; unknowns: string[]; done: boolean };

// The checked plan of the newest spec run (spec.md sections 6.1 and 6.4). proposed: the size of Claude. minimum: the lowest size that
// the app rules allow; rules gives their lines. missing: the map entries that name no code at base. commands: the proposed commands,
// then the saved ones of the repository. warning: the approval needs the first-use warning. approved: a medium or large plan waits
// for its spec PR.
export type TaskPlanDto = {
  proposed: TaskSize;
  minimum: TaskSize;
  rules: string[];
  budget: number;
  missing: number;
  base: string;
  commands: (TaskCommand & { saved: boolean })[];
  warning: boolean;
  approved: boolean;
  // spec.md section 6.20.4, sub-task mode only (else null and []). maxOpen: the open PRs at once that Claude proposes. starts: the start
  // of each plan part with Claude's reason; skip: the part builds no open sub-task without a PR. notes: the lines of the app checks for the plan screen.
  maxOpen: { value: number; reason: string } | null;
  starts: { n: number; keys: string[]; start: StartMode; after: string | null; reason: string; skip: boolean }[];
  notes: string[];
};

// One Jira sub-task of a task (spec.md section 6.20.8). statusAt: ms of the last status read. found: the branches and PRs that name the
// key. parts: the task_part IDs that build or follow it. added, removed: ms of the status read that found the key new or gone.
export type SubtaskDto = {
  key: string;
  summary: string;
  status: string | null;
  category: IssueSubtask["category"];
  statusAt: number | null;
  links: IssueLink[];
  found: FoundItem[];
  parts: number[];
  attachments: AttachmentMeta[];
  added: number | null;
  removed: number | null;
};

// GET /api/tasks/:id. docs: the plan files before their first push, null before the spec run. strip: the step strip (stepStrip).
export type TaskDto = TaskRowDto & {
  interview: TaskInterviewDto | null;
  plan: TaskPlanDto | null;
  strip: { steps: string[]; current: number };
  originPr: number | null;
  // The stored profile ID (spec.md section 6.2). null: a task made before profiles. taskProfileId gives the profile of the steps.
  profile: ProfileId | null;
  stoppedFrom: TaskState | null;
  sizeBy: SizeSource | null;
  targetBranch: string;
  baseCommit: string | null;
  specDir: string;
  specBranch: string | null;
  estimate: SpecResult["estimate"] | null;
  settings: TaskSettings;
  docs: (Partial<Record<TaskDoc, string>> & { version: number }) | null;
  parts: TaskPartDto[];
  // Every repository of the task, the main one first.
  repos: TaskRepoDto[];
  // The rows of each built part (spec.md section 6.16.8).
  prs: TaskPrDto[];
  questions: TaskQuestionDto[];
  steps: TaskStepDto[];
  createdAt: number;
  // The reviewers that the open-PR confirm starts with (spec.md section 6.9): settings.reviewers, else the reviewers of your newest
  // PR in this repository.
  reviewers: string[];
  // The points that "Fix these too" fixes. Empty after the commit of their fix.
  points: TaskPointDto[];
  // The build loop works on the task now, also between two steps.
  working: boolean;
  // spec.md section 6.17: the attachments that the issue of the task lists, and the files that the task downloaded. A file with
  // include true goes to ./context/attachments/ of each Claude step.
  attachments: AttachmentMeta[];
  files: AttachmentDto[];
  // spec.md section 6.18.6. bases: each repository of the building part that the update would change, with the commits of its base
  // since the branch point (the newest base check) and a Bitbucket PR that reports conflicts. needsBase: the newest Claude step asked for
  // the newest base, and no update ran after it. canInstruct: the Tell Claude box can send. canUndoUpdate: "Undo the update" can run.
  bases: TaskBaseDto[];
  needsBase: { reason: string } | null;
  canInstruct: boolean;
  canUndoUpdate: boolean;
  // spec.md section 6.20: the sub-tasks in Jira order. null: the task builds no sub-tasks.
  subtasks: SubtaskDto[] | null;
};

// taskRepo: task_repo.id. branch: the base branch that the user picked for the repository. changed: "Pick a base branch" set the branch
// after commits on the old base, so the update must run before the PR (spec.md section 6.16.7).
export type TaskBaseDto = { taskRepo: number; branch: string; newCommits: number; conflicted: boolean; changed: boolean };

// 409 of a task mutation: the version is old, or the state takes no such change. task: the current task.
export type TaskConflict = ApiError & { task: TaskDto };
