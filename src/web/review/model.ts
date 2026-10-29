// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure review UI rules (plan v3 WP11, prototype/v3, replies.md step 6). No DOM access, so bun test runs them directly.
import type {
  BriefDto,
  CommitDto,
  DiscardReason,
  ExcerptLine,
  InstructionFileDto,
  ItemActionInput,
  ModuleId,
  ProfileDto,
  PrRow,
  ReviewerMode,
  ReviewItemDto,
  RunDetail,
  RunDto,
  RunKind,
  RunnerDefaults,
  RunSummary,
  RunUsage,
  Volume,
} from "../../shared/dto";
import { plural, shortHash, touchedDraft } from "../../shared/outcome";
import {
  type Anchor,
  type AnchoredFinding,
  type Check,
  type Coverage,
  checkOf,
  type DropReason,
  displayGroup,
  type FindingPayload,
  MAX_REPLY_THREADS,
  type ReplyPayload,
  type Side,
  type Verdict,
} from "../../shared/review";
import { eventPhase, type RunEvent } from "../../shared/run-log";
import type { Turn } from "../../shared/turn";
import { matches } from "../shell/model";
import { sizeText } from "./tasks";

// src/shared/outcome.ts holds these, so the PR context file of a run uses the same words.
export { plural, shortHash, touchedDraft };

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const lineText = (a: { line: number; lineEnd: number }) => (a.lineEnd > a.line ? `${a.line}–${a.lineEnd}` : `${a.line}`);

// run-log.ts: the agent tool is always "Agent".
export const AGENT = "Agent";

// ---------- Run log ----------

export type LogNode = { e: RunEvent; kids: LogNode[] };

// The tree comes from parent alone. An event with an unknown parent, or one that a parent cycle hides, shows at the top level.
export function logTree(events: RunEvent[]): LogNode[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const ids = new Set(sorted.map((e) => e.id));
  const kids = new Map<string | null, RunEvent[]>();
  for (const e of sorted) {
    const p = e.parent !== null && e.parent !== e.id && ids.has(e.parent) ? e.parent : null;
    const list = kids.get(p);
    if (list) list.push(e);
    else kids.set(p, [e]);
  }
  const seen = new Set<string>();
  const build = (p: string | null): LogNode[] =>
    (kids.get(p) ?? []).flatMap((e) => {
      if (seen.has(e.id)) return [];
      seen.add(e.id);
      return [{ e, kids: build(e.id) }];
    });
  const roots = build(null);
  for (const e of sorted) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    roots.push({ e, kids: build(e.id) });
  }
  return roots;
}

// The top-level nodes of the log by phase, the finder first (docs/plans/review-v2/design.md section 5.1). A run without a check phase
// gives one group.
export function logPhases(tree: LogNode[]): { phase: "find" | "check"; nodes: LogNode[] }[] {
  const check = tree.filter((n) => eventPhase(n.e) === "check");
  if (!check.length) return [{ phase: "find", nodes: tree }];
  const find = tree.filter((n) => eventPhase(n.e) === "find");
  return [...(find.length ? [{ phase: "find" as const, nodes: find }] : []), { phase: "check", nodes: check }];
}

// Finished tool calls of all agents. Agent calls count as agents (prototype/v3 toolCalls, agentCount).
export const toolCalls = (events: RunEvent[]) => events.filter((e) => e.tool !== AGENT && e.status !== "running").length;
export const agentCount = (events: RunEvent[]) => events.filter((e) => e.tool === AGENT).length;

export function agentInfo(n: LogNode) {
  const calls = n.kids.filter((k) => k.e.tool !== AGENT && k.e.status !== "running").length;
  return { calls, words: `${plural(calls, "tool call")}${n.e.status === "running" ? " so far" : ""}` };
}

// The facts of one Agent call that the stream gave: "built-in, <model>, 5k tokens".
export const agentDetails = (e: RunEvent) =>
  [e.builtin ? "built-in" : "", e.model ?? "", e.tokens === null ? "" : tokenText(e.tokens)].filter(Boolean).join(", ");

// The subagents of a run, one part per name in call order: "rl-reviewer ×3 (<model>)". null: the run used none.
export function subagentText(events: RunEvent[]): string | null {
  const by = new Map<string, { n: number; builtin: boolean; models: Set<string> }>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.tool !== AGENT) continue;
    const name = e.agent ?? "unnamed";
    const g = by.get(name) ?? { n: 0, builtin: false, models: new Set<string>() };
    g.n++;
    g.builtin ||= e.builtin;
    if (e.model) g.models.add(e.model);
    by.set(name, g);
  }
  if (!by.size) return null;
  return [...by]
    .map(([name, g]) => {
      const extra = [g.builtin ? "built-in" : "", ...g.models].filter(Boolean).join(", ");
      return `${name} ×${g.n}${extra ? ` (${extra})` : ""}`;
    })
    .join(", ");
}

// The first Agent call with this subagent name, then its ancestors.
export function agentPath(events: RunEvent[], name: string): string[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: string[] = [];
  let e = [...events].sort((a, b) => a.seq - b.seq).find((x) => x.tool === AGENT && x.agent === name);
  while (e && !out.includes(e.id)) {
    out.push(e.id);
    e = e.parent === null ? undefined : byId.get(e.parent);
  }
  return out;
}

export const seconds = (e: RunEvent) => (e.endedAt === null ? null : Math.max(0, e.endedAt - e.startedAt) / 1000);
// prototype/v3 dur: "52s", "2m 05s".
export const clockDur = (s: number) => {
  const r = Math.round(s);
  return r < 60 ? `${r}s` : `${Math.floor(r / 60)}m ${String(r % 60).padStart(2, "0")}s`;
};
export const callDur = (s: number) => (s < 60 ? `${s.toFixed(1)} s` : clockDur(s));
export function durLong(s: number) {
  const r = Math.round(s);
  const m = Math.floor(r / 60);
  return [m ? plural(m, "minute") : "", r % 60 || !m ? plural(r % 60, "second") : ""].filter(Boolean).join(" ");
}

// ---------- Run line ----------

// The token counters of the result event usage. Their sum is all tokens that the run read or wrote.
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];
export function tokenTotal(u: RunUsage | null): number | null {
  if (!u) return null;
  const ns = TOKEN_FIELDS.map((k) => u.tokens[k]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return ns.length ? ns.reduce((a, b) => a + b, 0) : null;
}
export const tokenText = (n: number) => (n < 1000 ? `${n} tokens` : `${Math.round(n / 1000)}k tokens`);

// docs/plans/thread-outcome.md section 9: the reply drafts of a review run for the answers to the user's posted questions.
const answers = (items: ReviewItemDto[]) =>
  items.filter((i) => i.kind === "reply" && (i.payload as ReplyPayload).origin === "review").length;

// Plan v3 section 7: an incomplete run says "No findings in what it read", never "No issues".
// A reply run counts its drafts and the threads where it found no reply needed.
// checked: a review v2 run (summary.verify). A complete one without findings names the checked areas (spec.md section 1.9).
// Refuted and duplicate findings stay in the run record only, so they do not count.
export function countText(items: ReviewItemDto[], incomplete: boolean, kind: RunKind = "review", checked = false) {
  // An ask run has no items. Its answer shows in the Ask panel. A fix run keeps its edits apart from the items.
  if (kind === "ask" || kind === "fix") return "";
  if (kind === "reply") {
    const p = (i: ReviewItemDto) => i.payload as ReplyPayload;
    const r = items.filter((i) => p(i).action !== "none").length;
    const resolve = items.filter((i) => p(i).resolve).length;
    const none = items.filter((i) => p(i).action === "none" && !p(i).resolve).length;
    return [
      r ? plural(r, "reply draft") : resolve ? "" : "No reply drafts",
      resolve ? `${plural(resolve, "thread")} to resolve` : "",
      none ? `${plural(none, "thread")} ${none === 1 ? "needs" : "need"} no reply` : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  // A re-review can add reply drafts that resolve the threads of posted findings. They show under their threads.
  const f = items.filter((i) => i.kind === "finding" && !isHidden(i)).length;
  const q = items.filter((i) => i.kind === "question").length;
  const a = answers(items);
  const none = incomplete
    ? "No findings in what it read"
    : q || a
      ? ""
      : checked
        ? "No problems found in the checked areas"
        : "No findings";
  return [f ? plural(f, "finding") : none, q ? plural(q, "question") : "", a ? plural(a, "answered thread") : ""]
    .filter(Boolean)
    .join(", ");
}

// Plan r2 UI-RR: "N new, M carried, K fixed or outdated". The server copies each carried finding with the verdict of the run.
export function rereviewCount(items: ReviewItemDto[]): string {
  let fresh = 0;
  let open = 0;
  let closed = 0;
  let q = 0;
  // Reply items: the resolve proposals for the threads of posted findings that the new commits fix, and the answer drafts.
  let resolve = 0;
  const a = answers(items);
  for (const i of items) {
    if (isHidden(i)) continue;
    if (i.kind === "question") q++;
    else if (i.kind === "reply") resolve++;
    else if (!i.payload.carried) fresh++;
    else if (i.payload.carried.verdict === "open") open++;
    else closed++;
  }
  resolve -= a;
  return [
    `${fresh} new, ${open} carried, ${closed} fixed or outdated`,
    resolve ? `${plural(resolve, "posted thread")} to resolve` : "",
    q ? plural(q, "question") : "",
    a ? plural(a, "answered thread") : "",
  ]
    .filter(Boolean)
    .join(", ");
}

// result: the outcome in a few words. It is empty while the items or the edits load.
// calls: null while the log loads.
export type RunLineState =
  | { kind: "running"; agents: number; calls: number; startedAt: number }
  | { kind: "done"; result: string; tokens: number | null; subagents: string | null }
  | { kind: "failed"; text: string; raw: boolean }
  | { kind: "limit"; text: string }
  | { kind: "cancelled"; calls: number | null };

// Plan v3 section 7, Stale: "Reviewed <hash>. N commits since." commits: newest first.
export function staleText(r: RunDto, commits: CommitDto[] | undefined): string | null {
  if (!r.stale) return null;
  if (!r.stale.source) return "The target branch moved since";
  const n = newCommits(r, commits);
  return n ? `${plural(n, "commit")} since` : "New commits since";
}

// The count of PR commits after the source head of r. The list is newest first. null: none, or the list does not hold that head.
export function newCommits(r: RunDto, commits: CommitDto[] | undefined): number | null {
  const i = commits?.findIndex((c) => c.hash === r.sourceHead) ?? -1;
  return i > 0 ? i : null;
}

// The outcome of an ended run. items, edits: undefined while they load.
function doneText(r: RunDto, items: ReviewItemDto[] | undefined, edits: number | undefined, profiles: ProfileDto[]): string {
  if (r.kind === "ask") return "Answered";
  // judge.ts judgeSession: "N answers".
  if (r.kind === "session") return r.summary?.summary ?? "";
  if (r.kind === "fix") return edits === undefined ? "" : edits ? plural(edits, "edit") : "No edits";
  // The flag stored at the start wins over the current profile. null falls back to the current profile.
  if (r.kind === "explain" || (r.kind === "review" && (r.explain ?? profiles.find((p) => p.id === r.profile)?.explain))) {
    const q = items?.filter((i) => i.kind === "question").length ?? 0;
    return ["Explained the change", q ? plural(q, "question") : ""].filter(Boolean).join(", ");
  }
  if (!items) return "";
  return r.since ? rereviewCount(items) : countText(items, r.status === "incomplete", r.kind, r.summary?.verify !== undefined);
}

// One row of the run list (R14). d: the detail of r, undefined while it loads. edits: the edit count of a fix run.
export function runLine(r: RunDto, d: RunDetail | undefined, profiles: ProfileDto[], edits?: number): RunLineState {
  switch (r.status) {
    case "running":
      return { kind: "running", agents: agentCount(d?.events ?? []), calls: toolCalls(d?.events ?? []), startedAt: r.startedAt };
    case "cancelled":
      return { kind: "cancelled", calls: d ? toolCalls(d.events) : null };
    case "failed":
      if (r.errorKind === "usage_limit") return { kind: "limit", text: r.errorText ?? "" };
      return { kind: "failed", text: r.errorText ?? "No reason was recorded.", raw: r.hasRaw };
    default:
      return {
        kind: "done",
        result: doneText(r, d?.items, edits, profiles),
        tokens: tokenTotal(r.usage),
        subagents: d ? subagentText(d.events) : null,
      };
  }
}

// Plan pr-view-v4 2.6. judge.ts ended(): a skipped or an unavailable item makes the run incomplete, so n counts both.
// lines: one plain line per gap. design: coverage.notChecked, what the run leaves out by design.
export type NotChecked = { n: number; label: string; lines: string[]; design: string | null };

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function notChecked(c: Coverage): NotChecked {
  const lines = [...c.skipped, ...c.unavailable];
  return {
    n: lines.length,
    label: `Not checked: ${lines.length}`,
    lines,
    design: c.notChecked.length ? `Also not done, by design: ${c.notChecked.map(sentence).join(" ")}` : null,
  };
}

// The open questions of a run in screen order, for the ledger of the review record. Discarded and posted ones do not count.
export function questionJump(items: ReviewItemDto[]): { n: number; first: number } | null {
  const qs = items.filter((i) => i.kind === "question" && i.status !== "posted" && i.status !== "discarded");
  return qs[0] ? { n: qs.length, first: qs[0].id } : null;
}

// The words of each run kind (R14). running: the state of a running run in the run list.
// doing: "<runner> is <doing> <PR>" while the run holds the only slot. now: "<profile>: <now> now." in the Review runs view.
export const RUN_TEXT: Record<RunKind, { running: string; failed: string; cancelled: string; doing: string; now: string }> = {
  review: { running: "Reviewing…", failed: "Review failed.", cancelled: "the review", doing: "reviewing", now: "reviewing" },
  reply: {
    running: "Drafting replies…",
    failed: "Reply drafts failed.",
    cancelled: "the reply drafts",
    doing: "drafting replies for",
    now: "drafting replies",
  },
  ask: {
    running: "Answering…",
    failed: "The question failed.",
    cancelled: "the question",
    doing: "answering a question on",
    now: "answering a question",
  },
  fix: {
    running: "Proposing fixes…",
    failed: "The fix run failed.",
    cancelled: "the fix run",
    doing: "proposing fixes for",
    now: "proposing fixes",
  },
  session: {
    running: "Your session is answering…",
    failed: "The session run failed.",
    cancelled: "the session run",
    doing: "asking your session about",
    now: "asking your session",
  },
  explain: {
    running: "Explaining…",
    failed: "The walkthrough failed.",
    cancelled: "the walkthrough",
    doing: "explaining",
    now: "explaining the change",
  },
  discuss: {
    running: "Answering…",
    failed: "The answer about the finding failed.",
    cancelled: "the answer about the finding",
    doing: "answering about a finding on",
    now: "answering about a finding",
  },
  // The runs of a task. A PR view never lists them, but a busy line can name one.
  interview: {
    running: "Reading the task…",
    failed: "The questions failed.",
    cancelled: "the questions",
    doing: "preparing questions for",
    now: "preparing questions",
  },
  spec: {
    running: "Writing the plan…",
    failed: "The plan failed.",
    cancelled: "the plan",
    doing: "writing the plan for",
    now: "writing a plan",
  },
  implement: {
    running: "Building…",
    failed: "The build step failed.",
    cancelled: "the build step",
    doing: "building",
    now: "building a task",
  },
};

// R14: GET /api/prs/:id/runs mixes the kinds, newest first. The newest review run drives the drafts, the summary, the brief,
// and the re-review offer. A cancelled or failed run has no result and keeps the run before it, as run-rows.ts SQL.baseRun does.
export const latestReview = (runs: RunDto[] | undefined) =>
  runs?.find((r) => r.kind === "review" && r.status !== "cancelled" && r.status !== "failed") ??
  runs?.find((r) => r.kind === "review") ??
  null;

// docs/plans/review-v2/spec.md section 3.2: the newest explain run with a result, as the Explain page shows it. Its questions join
// the Drafts.
export const latestExplain = (runs: RunDto[] | undefined) =>
  runs?.find((r) => r.kind === "explain" && (r.status === "completed" || r.status === "incomplete")) ?? null;

// The items of the Drafts: the items of the newest review run, then the questions of the newest explain run. The same array while
// no explain question exists.
export function withQuestions(review: ReviewItemDto[], explain: ReviewItemDto[] | undefined): ReviewItemDto[] {
  const qs = explain?.filter((i) => i.kind === "question") ?? [];
  return qs.length ? [...review, ...qs] : review;
}

// ---------- One row per run kind ----------

export const KIND_LABEL: Record<RunKind, string> = {
  review: "Review",
  reply: "Reply drafts",
  fix: "Fixes",
  ask: "Ask",
  session: "Session",
  explain: "Explain",
  discuss: "Ask about a finding",
  interview: "Questions",
  spec: "Plan",
  implement: "Build step",
};

// The newest run of each kind, newest first. runs: newest first.
export function kindRuns(runs: RunDto[] | undefined): RunDto[] {
  const seen = new Set<RunKind>();
  const out: RunDto[] = [];
  for (const r of runs ?? []) {
    if (seen.has(r.kind)) continue;
    seen.add(r.kind);
    out.push(r);
  }
  return out;
}

export type Severity = AnchoredFinding["severity"];

// Plan r2 UI-RR, jobs.ts rereview(): the server takes a re-review of the newest review run only when that run ended with a result,
// was no Explain run, and the source head moved since. The stored brief must not use the Explain profile.
// since: the short head of that run. why: the reason for the key c when no re-review is possible.
export function rereviewState(
  latest: RunDto | null,
  brief: BriefDto | undefined,
  profiles: ProfileDto[],
): { since: string } | { why: string } {
  if (!latest) return { why: "No review has run on this pull request yet. Press r to start one." };
  if (latest.status === "running") return { why: "The review is still running." };
  if (!latest.summary) return { why: "The last review has no result. Press r to review again." };
  if (latest.explain ?? latest.profile === "explain")
    return { why: "The last run explained the change and gave no findings. Press r to review it." };
  if (!latest.stale?.source) return { why: "The source branch has no new commits since the last review." };
  if (!brief) return { why: "The review brief is still loading." };
  if (profileOf(profiles, brief.profile)?.explain) return { why: "The Explain profile gives no findings. Pick a review profile first." };
  return { since: shortHash(latest.sourceHead) };
}

// Plan v3 section 7, Usage limit: one line with the CLI message. No automatic retry.
export const limitText = (runner: string, text: string | null) =>
  `${text?.trim() ? `${runner}: ${text.trim()}` : `${runner} usage limit reached.`} PR Review Inbox does not retry by itself.`;

// The project instruction files of a run: a short line and one line per file. null: the run got none, or it ran before they were stored.
// notLoaded: the files and imports that the run left out. They are warnings, not coverage gaps.
export function instructionsText(
  run: Pick<RunDto, "instructions">,
): { short: string | null; long: string; notLoaded: string | null } | null {
  const files = run.instructions?.files ?? [];
  const missed = run.instructions?.notLoaded ?? [];
  if (!files.length && !missed.length) return null;
  const label = (f: InstructionFileDto) => (f.source === "settings" ? "your text" : f.source === "global" ? `global ${f.path}` : f.path);
  const from = {
    global: "from your global settings",
    target: "from the target branch",
    clone: "from your clone",
    settings: "from PR Review Inbox settings",
  } as const;
  return {
    short: files.length ? `${[...new Set(files.map(label))].join(", ")} (${sizeText(run.instructions?.bytes ?? 0)})` : null,
    long: files.map((f) => `${f.source === "settings" ? "Text" : f.path} ${from[f.source]}, ${sizeText(f.bytes)}`).join("\n"),
    notLoaded: missed.length ? `Not loaded: ${missed.join("; ")}` : null,
  };
}

// The skills that a run got. null: no skill, or a run made before the skills were stored.
export const skillsText = (run: Pick<RunDto, "skills">) =>
  run.skills?.length ? run.skills.map((s) => `${s.id}${s.always ? " (always)" : ""}`).join(", ") : null;

// The model and the effort of a run. A run without an init event and without --model names the default model of the settings.
// effortNow: the run stored no default effort, so the text names the effort of the current settings.
// defaults null: the settings file is absent or unreadable, so the text stays plain.
export const setupText = (
  run: Pick<RunDto, "model" | "effort" | "effortDefault" | "effortNow" | "status">,
  defaults: RunnerDefaults | null,
) => {
  const mine = run.status === "running" ? "your default" : "your default now";
  const model = run.model ?? (defaults?.model?.sure ? `${defaults.model.value} (${mine})` : "default model");
  const effort =
    run.effort && run.effort !== "default"
      ? `${run.effort} effort`
      : run.effortDefault
        ? `${run.effortDefault} effort (${run.effortNow ? "your default now" : "your default"})`
        : "default effort";
  return `${model}, ${effort}`;
};

// ---------- Brief ----------

// The server rule (src/server/review/catalog.ts profileOf): an unknown ID gets the first review profile, never an Explain profile
// while a review profile exists.
export const profileOf = (profiles: ProfileDto[], id: string) =>
  profiles.find((p) => p.id === id) ?? profiles.find((p) => !p.explain) ?? profiles[0];

export type BriefState = {
  profile: string;
  name: string;
  // A running review on any PR. One review runs at a time (A14).
  busy: { pr: number; same: boolean } | null;
  hint: string;
};

// Every review start opens the brief first. The review starts only from its Start button. The brief holds the profile pick.
export function briefState(brief: BriefDto | undefined, active: RunDto | null, pr: number, profiles: ProfileDto[]): BriefState {
  const p = profileOf(profiles, brief?.profile ?? "general");
  const note = brief?.note.trim() ? " with your note" : "";
  return {
    profile: p?.id ?? "general",
    name: p?.name ?? "",
    busy: active ? { pr: active.pr, same: active.pr === pr } : null,
    hint: `Open the review brief${note}. Pick the profile and start the review there. Key: r.`,
  };
}

// Decision D2 (plan pr-view-v4): the brief preselects the profile of the stored brief of this PR. A PR without one gets the
// last profile that started a review on any PR. last: that profile ID, null when unknown. tag: what the "Last used" mark
// stands for, null when no profile was used yet.
export function briefProfile(brief: BriefDto, last: string | null, profiles: ProfileDto[]): { profile: string; tag: "pr" | "any" | null } {
  if (brief.updatedAt !== null) return { profile: brief.profile, tag: "pr" };
  if (last && profiles.some((p) => p.id === last)) return { profile: last, tag: "any" };
  return { profile: brief.profile, tag: null };
}

const MODE_NAME: Record<ReviewerMode, string> = { auto: "Auto", always: "Always", off: "Off" };

// The run setup of a profile before a run, as the brief shows it. A model or effort without a flag names the runner default.
export function profileSetupText(p: ProfileDto, defaults: RunnerDefaults | null): string {
  const effort = defaults?.effort[p.model ?? ""];
  // A profile reads the settings of now, as a running run does.
  const flags = setupText(
    { model: p.model, effort: p.effort, effortDefault: effort?.sure ? effort.value : null, effortNow: false, status: "running" },
    defaults,
  );
  const agents = p.explain ? "No reviewer agents" : `Reviewer agents: ${MODE_NAME[p.reviewerMode]}`;
  const tools = [p.skillCount ? plural(p.skillCount, "skill") : "", p.mcpCount ? plural(p.mcpCount, "MCP server") : ""].filter(Boolean);
  return `${flags}. ${agents}. ${tools.length ? tools.join(", ") : "No skills or MCP servers"}.`;
}

// ---------- Drafts and summary ----------

export const SEVERITY: Record<AnchoredFinding["severity"], string> = { blocker: "Blocker", major: "Major", minor: "Minor", nit: "Nit" };
// docs/plans/review-v2/spec.md section 4.1: the discard reason chips.
export const DISCARD_LABEL: Record<DiscardReason, string> = {
  bug: "Not a bug",
  worth: "Not worth fixing",
  duplicate: "Duplicate",
  intended: "Intended",
  place: "Wrong place",
};
export const EVIDENCE: Record<AnchoredFinding["evidenceStatus"], string> = {
  code: "Shown in code",
  reproduced: "Reproduced",
  unverified: "Unverified",
};
// review.ts DropReason.
export const DROP_REASON: Record<DropReason, string> = {
  path: "The path is outside the snapshot.",
  file: "The snapshot has no such file on that side.",
  match: "The snapshot of that file does not have this code.",
  size: "The file or the range is above the scan limits.",
  unchanged: "Not part of this change.",
  rule: "The quoted rule is not in the project instructions for this path.",
};

export const drafts = (items: ReviewItemDto[]) => items.filter((i) => i.kind === "finding" && i.status !== "posted");
export const questions = (items: ReviewItemDto[]) => items.filter((i) => i.kind === "question" && i.status !== "posted");

// ---------- Review v2: checks, volume, and draft groups (docs/plans/review-v2/spec.md sections 1.1 to 1.4, 1.8, 1.9) ----------

// spec.md section 1.3. tests/web/review-v2.test.ts pins them to the labels of src/server/review/catalog.ts MODULES.
export const MODULE_LABEL: Record<ModuleId, string> = {
  security: "Security",
  concurrency: "Threads and races",
  performance: "Performance",
  tests: "Tests",
  api: "Compatibility",
  docs: "Docs and comments",
  simplify: "Simplify (what to delete)",
  rules: "Project rules",
  intent: "Matches the task",
  failures: "Failure paths",
};
// spec.md section 1.1: the checks in view, then the checks under "More checks". The language checklists are the profile field
// languageChecks, the last one under "More checks". TRIAL_MODULES are in neither list.
export const SHOWN_CHECKS: readonly ModuleId[] = ["security", "concurrency", "performance", "tests", "api", "simplify"];
export const MORE_CHECKS: readonly ModuleId[] = ["docs", "rules", "intent"];
export const LANGUAGE_LABEL = "Language checklists (C++, C, Python)";

// spec.md section 1.4.
export const VOLUME_NAME: Record<Volume, string> = { quiet: "Only what matters", balanced: "Balanced", thorough: "Show everything" };
export const VOLUME_LINE: Record<Volume, string> = {
  quiet: "Only what matters: must-fix points. Everything else waits in a fold.",
  balanced: "Balanced: must-fix and worth-fixing points. Unsure points wait in a fold.",
  thorough: "Show everything: also small polish and unsure points.",
};
const FOLD_NAME: Record<Volume, string | null> = { quiet: "More", balanced: "Low confidence", thorough: null };

export const CHECK_LABEL: Record<Check, string> = { checked: "Checked", unsure: "Low confidence", unchecked: "Not checked" };

// A refuted or duplicate finding. It shows only in the run record, with Restore.
export const isHidden = (it: ReviewItemDto) => it.kind === "finding" && (it.payload as FindingPayload).discardedBy === "verify";

// The finding drafts of one run by display group, each in screen order. foldName: null when the volume has no fold.
// checked: the run is a review v2 run (summary.verify), so each card shows its check chip. A run from before review v2 has no volume,
// so every draft is in main.
export type DraftGroups = {
  main: ReviewItemDto[];
  fold: ReviewItemDto[];
  hidden: ReviewItemDto[];
  foldName: string | null;
  checked: boolean;
};
export function draftGroups(ds: ReviewItemDto[], summary: RunSummary | null | undefined): DraftGroups {
  const volume = summary?.volume;
  const g: DraftGroups = { main: [], fold: [], hidden: [], foldName: volume ? FOLD_NAME[volume] : null, checked: !!summary?.verify };
  for (const d of ds) g[displayGroup(d.payload as FindingPayload, volume)].push(d);
  return g;
}

// The check chip of a finding card. null: a run from before review v2.
export const checkChip = (it: ReviewItemDto, checked: boolean) => (checked ? CHECK_LABEL[checkOf(it.payload as FindingPayload)] : null);

// "Check: <reason> (path:line)". null: no verdict.
export function checkText(it: ReviewItemDto): string | null {
  const v = (it.payload as FindingPayload).verify;
  if (!v?.reason.trim()) return null;
  return `Check: ${v.reason.trim()}${v.evidence.trim() ? ` (${v.evidence.trim()})` : ""}`;
}

// spec.md section 1.8: a refuted or duplicate finding without discardedBy is one that you restored.
export function restoredNote(it: ReviewItemDto): string | null {
  const p = it.payload as FindingPayload;
  if (it.kind !== "finding" || p.discardedBy || it.status === "discarded") return null;
  const v = p.verify?.verdict;
  return v === "refuted"
    ? "Refuted by the check. You restored it."
    : v === "duplicate"
      ? "A duplicate by the check. You restored it."
      : null;
}

// The title of a draft row. A finding from before review v2 has no title, so the row shows its body.
export const draftTitle = (it: ReviewItemDto) => (it.kind === "finding" && (it.payload as FindingPayload).title?.trim()) || it.body;

export type LedgerPart = { key: "must" | "worth" | "polish" | "fold" | "questions"; n: number; first: number; word: string };
export const ledgerText = (p: LedgerPart) => `${p.n} ${p.word}`;

// docs/plans/review-v2/design.md section 8: the open drafts in plain words, for example "2 must fix · 3 worth fixing · 4 low
// confidence". Must fix counts blocker and major, worth fixing minor, and polish nit, all in the main list. first: the draft that
// the part goes to. qs: questionJump of the run.
export function ledgerParts(g: DraftGroups, qs: { n: number; first: number } | null): LedgerPart[] {
  const open = (l: ReviewItemDto[]) => l.filter((i) => i.status !== "discarded");
  const sev = (it: ReviewItemDto) => (it.payload as AnchoredFinding).severity;
  const part = (key: LedgerPart["key"], l: ReviewItemDto[], word: string): LedgerPart[] =>
    l[0] ? [{ key, n: l.length, first: l[0].id, word }] : [];
  const main = open(g.main);
  return [
    ...part(
      "must",
      main.filter((i) => sev(i) === "blocker" || sev(i) === "major"),
      "must fix",
    ),
    ...part(
      "worth",
      main.filter((i) => sev(i) === "minor"),
      "worth fixing",
    ),
    ...part(
      "polish",
      main.filter((i) => sev(i) === "nit"),
      "polish",
    ),
    ...(g.foldName ? part("fold", open(g.fold), g.foldName.toLowerCase()) : []),
    ...(qs ? [{ key: "questions" as const, n: qs.n, first: qs.first, word: qs.n === 1 ? "question" : "questions" }] : []),
  ];
}

// spec.md section 1.1: "3 refuted by the check", "1 duplicate". Empty: none.
export function hiddenParts(hidden: ReviewItemDto[]): string[] {
  const dup = hidden.filter((i) => (i.payload as FindingPayload).verify?.verdict === "duplicate").length;
  const refuted = hidden.length - dup;
  return [refuted ? `${refuted} refuted by the check` : "", dup ? plural(dup, "duplicate") : ""].filter(Boolean);
}

// spec.md section 1.1: the state of a running run. A review names its phase.
export function runningText(r: RunDto): string {
  if (r.phase === "indexing") return "Indexing for codegraph…";
  if (r.kind !== "review" || r.explain) return RUN_TEXT[r.kind].running;
  if (r.phase === "checking") return `Checking ${plural(r.candidates ?? 0, "finding")}…`;
  return r.since ? `Finding problems in the changes since ${shortHash(r.since.head)}…` : "Finding problems…";
}

const PHASE_NAME = { find: "Finding", check: "Checking" } as const;
const phaseDur = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

// spec.md section 1.1: "Finding 8 min", "Checking 3 min". usage: add the tokens that the CLI reported for the phase.
export function phaseParts(s: RunSummary | null | undefined, usage = false): string[] {
  return (s?.phases ?? []).flatMap((p) => {
    if (p.endedAt === null) return [];
    const tokens = usage ? tokenTotal(p.usage) : null;
    return [`${PHASE_NAME[p.name]} ${phaseDur(p.endedAt - p.startedAt)}${tokens === null ? "" : `, ${tokenText(tokens)}`}`];
  });
}

// spec.md section 1.9: a check phase that ended without a result. null: the check finished, was off, or never ran.
export function checkFailedText(s: RunSummary | null | undefined): string | null {
  const v = s?.verify;
  if (!v?.failed) return null;
  return `The check did not finish: ${v.unchecked} ${v.unchecked === 1 ? "finding is" : "findings are"} not checked.`;
}

// The anchored lines are the range lines that exist on the finding's side.
export function draftExcerpt(a: Anchor & { side: Side }): ExcerptLine[] {
  const other = a.side === "new" ? "del" : "add";
  return a.excerpt.map((l) => ({ ...l, hit: l.kind !== other && l.n >= a.line && l.n <= a.lineEnd }));
}

// How the app resolved the line against the snapshot. An exact match shows nothing.
// payload.anchor is the validator's anchor. A different current anchor is a move by the user (WP12).
export function anchorNote(it: ReviewItemDto): string | null {
  const a = it.anchor;
  if (!a || it.kind !== "finding") return null;
  const p = it.payload as AnchoredFinding;
  if (a.state === "outside") return `Outside the diff. Posts as a general comment with a link to ${base(a.path)}:${lineText(a)}.`;
  if (a.line !== p.anchor.line || a.lineEnd !== p.anchor.lineEnd) return `You moved it from line ${lineText(p.anchor)}.`;
  if (a.state === "moved") return `Moved from line ${p.line}: the quoted code is on line ${lineText(a)}.`;
  return null;
}

const carriedLabel = (v: Verdict | undefined) => (v === "fixed" ? "Fixed in the new commits" : v === "outdated" ? "Outdated" : "Discarded");

// Plan r2 UI-RR: a re-review discards the carried drafts that it finds fixed or outdated. docs/plans/fix-ux.md decision 3: a fix
// commit discards the open findings that it covers. docs/plans/review-v2/spec.md section 2.2: a talk withdraws a finding. Other closed
// drafts are discards by you.
export function closedLabel(it: ReviewItemDto): string {
  const f = it.payload.fixed;
  if (f) return `Fixed in ${f.short}`;
  if (it.payload.withdrawn && !it.payload.withdrawn.restored) return "Withdrawn";
  return it.payload.session?.verdict === "reject" ? "Rejected by your session" : carriedLabel(it.payload.carried?.verdict);
}

// session-consult.md part C: the verdict of your session on a finding. A reject mark exists only while its discard holds.
export function sessionNote(it: ReviewItemDto): string | null {
  const s = it.payload.session;
  if (!s || it.kind !== "finding") return null;
  if (s.verdict === "question") return `Your session asks: ${s.reason}`;
  return `Your session: ${s.verdict === "accept" ? "Valid" : "Not valid"}. ${s.reason}`;
}

// A draft that a re-review carried. A fixed or outdated draft that is not discarded is one that you restored.
export function carriedNote(it: ReviewItemDto): string | null {
  const v = it.payload.carried?.verdict;
  if (!v) return null;
  return v === "open" ? "Still open after the new commits." : `${carriedLabel(v)}. You restored it.`;
}

// A restore keeps the mark of the fix commit, so a fixed finding that is not discarded is one that you restored.
export function fixedNote(it: ReviewItemDto): string | null {
  const f = it.payload.fixed;
  return f && it.status !== "discarded" ? `Fixed in ${f.short}. You restored it.` : null;
}

// The live-region text after a triage action (WP15). The focus moves on to the next item, so the page says what happened.
// before: the item as the page showed it. after: the item that the server returned.
export function triageText(before: ReviewItemDto, after: ReviewItemDto, action: ItemActionInput["action"]): string {
  switch (action) {
    case "accept":
      return "Accepted.";
    case "discard":
      return "Discarded.";
    case "restore":
      return before.status === "accepted" ? "Accept undone." : "Restored.";
    case "edit":
      return "Saved and accepted.";
    case "move":
      return after.anchor ? `Moved to line ${lineText(after.anchor)}.` : "Moved.";
    case "resolve":
      return replyOf(after).resolveTick ? "The thread resolves after the post." : "The thread stays open after the post.";
    case "plain":
      return "The draft posts as a plain reply. Accepted.";
    case "use-revision":
      if (after.kind === "finding") return "The new text is the finding now. Accept it to post.";
      return after.status === "discarded"
        ? "The revision says no reply is needed. Your draft is discarded."
        : "The revision is your draft now. Accept it to post.";
    case "keep-mine":
      return after.kind === "finding" ? "Kept your text. The new text is gone." : "Kept your draft. The revision is gone.";
    case "reply-to-newest":
      return "The draft answers the newest message now.";
    case "reason":
      return "Saved the reason.";
  }
}

// ---------- Reply drafts (docs/plans/replies.md step 6) ----------

export const replyOf = (it: ReviewItemDto) => it.payload as ReplyPayload;

// GET /api/prs/:id/reply-drafts gives the newest unposted draft of each thread. Keys are thread IDs.
export function replyMap(items: ReviewItemDto[] | undefined): Map<number, ReviewItemDto> {
  const out = new Map<number, ReviewItemDto>();
  for (const it of items ?? []) if (it.kind === "reply") out.set(replyOf(it).thread, it);
  return out;
}

// none: action none, or no body yet. Accept needs a body (WP17), so it offers only a reply of your own.
// A draft without a body that proposes or ticks a resolve is a draft: Accept with the tick resolves the thread without a reply.
// stale: the draft answers a message that is no longer the newest live message of the thread.
// pending revise: the run revises your out-of-date draft (jobs.ts draftReplies), so it keeps your text. pending id: the draft that the
// run replaces or revises, so the line keeps the card ID. null: the thread has no draft.
export type ReplyCard =
  | { kind: "pending"; revise: boolean; id: number | null }
  | { kind: "none"; it: ReviewItemDto; stale: boolean }
  | { kind: "draft"; it: ReviewItemDto; stale: boolean }
  | { kind: "discarded"; it: ReviewItemDto };

// The state of a reply draft card that decides its focus after a render (ReplyDraft.tsx useCardFocus).
export type CardState = { kind: ReplyCard["kind"]; stale: boolean };

export const turnedStale = (before: CardState | null, now: CardState) => !!before && now.stale && !before.stale;

// lost: no element has the focus. gone: the element of the card that had the focus is gone. Returns where the focus goes: "again" is
// Draft again or Revise my reply, else the card itself. A pending line also takes the place of the button that started its run, such
// as Draft reply in the thread footer.
export function cardFocus(o: { before: CardState | null; now: CardState; lost: boolean; gone: boolean }): "again" | "card" | null {
  if (!o.lost) return null;
  if (o.gone) return turnedStale(o.before, o.now) ? "again" : "card";
  return o.now.kind === "pending" && o.before?.kind !== "pending" ? "card" : null;
}

// newest: the newest live message of the thread. pending: a reply run that this page started for the thread runs now.
export function replyCard(it: ReviewItemDto | undefined, newest: number | null, pending: boolean): ReplyCard | null {
  const stale = !!it && newest !== null && replyOf(it).replyTo !== newest;
  if (pending) return { kind: "pending", revise: !!it && stale && touchedDraft(it), id: it?.id ?? null };
  if (!it) return null;
  const p = replyOf(it);
  if (!it.body.trim() && !p.resolve && !p.resolveTick) return { kind: "none", it, stale };
  return it.status === "discarded" ? { kind: "discarded", it } : { kind: "draft", it, stale };
}

// The Draft replies button (plan pr-view-v4 2.2). turns: the turn of each thread of the PR. your: the threads where it is your turn.
// need: the count on the button, the threads whose outcome needs a reply (outcome.ts needsReply). The run still takes every
// your-turn thread. why: the popover text when a click starts no run, null when it starts one. D12: the server refuses more than
// MAX_REPLY_THREADS threads in one run. "wait" means that your message is the newest (shared/turn.ts).
export function repliesButton(
  turns: readonly Turn[],
  need?: number,
): { your: number; need: number; why: { title: string; text: string } | null; hint: string } {
  const your = turns.filter((t) => t === "your").length;
  const n = Math.min(need ?? your, your);
  const why = repliesWhy(turns, your);
  const which = your === 1 ? "the thread" : `each of the ${your} threads`;
  const left = n === your ? "" : n ? ` ${plural(n, "thread")} still ${n === 1 ? "needs" : "need"} a reply.` : " None needs a new reply.";
  return { your, need: n, why, hint: why ? why.title : `Draft a reply for ${which} where it is your turn.${left}` };
}

function repliesWhy(turns: readonly Turn[], your: number): { title: string; text: string } | null {
  if (your > MAX_REPLY_THREADS)
    return {
      title: `${your} threads wait for your reply.`,
      text: `Draft at most ${MAX_REPLY_THREADS} at a time: use Draft reply in each thread.`,
    };
  if (your) return null;
  const open = turns.filter((t) => t !== "resolved").length;
  if (!open) return { title: "No open thread.", text: "Every thread is resolved, so no reply is due." };
  const title = "No thread waits for your reply.";
  if (turns.includes("other")) return { title, text: "Each open thread waits for another person, or it has no message from you." };
  return open === 1
    ? { title, text: "Your message is the newest in the open thread. It waits for the other person." }
    : { title, text: "Your message is the newest in each open thread. They wait for the other person." };
}

export const coverageRows = (c: Coverage): [string, string[]][] =>
  (
    [
      ["Read", c.read],
      ["Skipped", c.skipped],
      ["Unavailable", c.unavailable],
      ["Not checked", c.notChecked],
    ] as [string, string[]][]
  ).filter(([, v]) => v.length > 0);

// ---------- Review runs view ----------

// runs: newest first, as GET /api/runs returns them.
export function latestByPr(runs: RunDto[]): Map<number, RunDto> {
  const out = new Map<number, RunDto>();
  for (const r of runs) if (!out.has(r.pr)) out.set(r.pr, r);
  return out;
}

// prototype/v3 grouped() for the runs view: one flat list, the running review first, then the newest run.
export function runRows(prs: PrRow[], latest: ReadonlyMap<number, RunDto>, q: string): PrRow[] {
  const key = (p: PrRow) => {
    const r = latest.get(p.id);
    return r ? (r.status === "running" ? Number.MAX_SAFE_INTEGER : r.startedAt) : 0;
  };
  return prs.filter((p) => latest.has(p.id) && matches(p, q)).sort((a, b) => key(b) - key(a));
}

// chip: the run state in a word. error: the chip marks an error. count: the findings of a review run, else the run kind.
export type RunWhy = { chip: string; error: boolean; count: string; lead: string | null; text: string | null };

// prototype/v3 whyRun. A finished run shows its summary line. The run names the profile as it was at the start of the run.
export function runWhy(r: RunDto): RunWhy {
  const profile = r.profileName;
  const explain = r.kind === "review" && (r.explain ?? r.profile === "explain");
  // Plan v3 section 7: an incomplete run says "No findings in what it read", never "No issues".
  const none = r.status === "incomplete" ? "No findings in what it read" : "No findings";
  const count =
    r.kind !== "review" || explain || (r.status !== "completed" && r.status !== "incomplete")
      ? KIND_LABEL[r.kind]
      : r.findings
        ? plural(r.findings, "finding")
        : none;
  switch (r.status) {
    case "running":
      return { chip: "Running", error: false, count, lead: null, text: `${profile}: ${RUN_TEXT[r.kind].now} now.` };
    case "cancelled":
      return { chip: "Cancelled", error: false, count, lead: null, text: `${profile}: you cancelled it.` };
    case "failed":
      return {
        chip: r.errorKind === "usage_limit" ? "Usage limit" : "Failed",
        error: true,
        count,
        lead: null,
        text: `${profile}: ${r.errorText ?? ""}`.trim(),
      };
    default: {
      const line = r.summary?.summary.trim() || "done.";
      return {
        chip: "Done",
        error: false,
        count,
        lead: `${profile}:`,
        text: r.status === "incomplete" ? `${line} Coverage has gaps.` : line,
      };
    }
  }
}
