// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The run end (jobs.ts): turns a runner outcome into the stored status, summary, items, answer, or fix notes and edits.
// A review run ends in two steps: judge() validates the finder result, and settle() merges the verdicts of the verify phase.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ZodType } from "zod";
import { cutToCaps, parseCut } from "../../shared/caps";
import { acceptedTargets, consultCaps, consultOutput } from "../../shared/consult";
import {
  type FinderQuestions,
  type FinderRisks,
  MAX_NOTE,
  type ObligationOutcome,
  type Obligations,
  obligationOutcomes,
  type RiskOutcome,
  type RunPhase,
  type RunSummary,
  type RunUsage,
  riskOutcomes,
  type VerifySummary,
  type Volume,
} from "../../shared/dto";
import {
  type AnchoredFinding,
  askResult,
  type Check,
  checkOf,
  confidences,
  copyPairs,
  type Defect,
  type DiscussResult,
  discussResult,
  displayGroup,
  type ExplainResult,
  explainResult,
  type Finding,
  type FindingPayload,
  type FixNote,
  type FixWhy,
  fixResult,
  MAX_DIAGRAM_CHARS,
  MAX_DIAGRAMS,
  type NoteProposal,
  neverHidden,
  type Obligation,
  PREEXISTING_MAX,
  type Question,
  type ReplyPayload,
  type RereviewResult,
  type ReviewResult,
  replyResult,
  rereviewResult,
  reviewResult,
  type Severity,
  type StoredFinding,
  severities,
  type VerifyMark,
  type VerifyVerdict,
  type VerifyVerdictName,
  verifyResult,
} from "../../shared/review";
import { eventPhase, type RunErrorKind, type RunEvent, type RunStatus } from "../../shared/run-log";
import { GIT_SERVER, type Lens, type Profile, passLabel } from "./catalog";
import type { RunOutcome } from "./claude";
import { blobBytes } from "./clone";
import type { Candidate } from "./context-files";
import { type DiffFile, parseDiff } from "./diffmap";
import { type FixFile, type ValidEdit, validateFix } from "./fix";
import { git, gitEnv } from "./git";
import type { ReplyThread } from "./prompt";
import type { Carry } from "./rereview";
import { type NewItem, NO_ANCHOR } from "./run-rows";
import { ADVISOR_TOOL } from "./stream";
import {
  type AskedThread,
  anchorer,
  type CheckedEarlier,
  collapse,
  type EarlierItem,
  earlierCases,
  MAX_FILE_CHARS,
  overlapGroups,
  type RuleSource,
  repoPath,
  type ValidatedReply,
  validate,
  validateAnswered,
  validateEarlier,
  validateReplies,
} from "./validate";
import type { Workspace } from "./workspace";

const RAW_MAX = 2 * 1024 * 1024;

// The verify phase of a review run (docs/plans/review-v2/spec.md section 1.7). n: the candidate number. duplicateOf: the candidate
// that a valid duplicate verdict names. jobs.ts end() turns both into item IDs after the insert.
export type CandidateLink = { n: number; duplicateOf: number | null };
// What the verify phase gave a carried finding of a re-review. end() applies it to the copy. verify absent: no verdict, so no change.
export type CarriedMark = CandidateLink & { verify?: VerifyMark; severity: Severity; discard: boolean; demoted?: true };

// checked: the earlier findings of a re-review. fix: the notes and edits of a fix run. links, carried: the verify phase of a review run.
// notes: the note proposals of a reply run, before the checks of notes.ts proposeNotes (docs/plans/review-v2/spec.md section 2.9).
// explain: the checked result of an explain run (spec.md section 3.3). discuss: the result of a discuss run (spec.md section 2.4);
// jobs.ts end() applies it. usage: the sum of both phases of a review run. Absent: the usage of outcome.
export type Ending = {
  status: Exclude<RunStatus, "running">;
  kind: RunErrorKind | null;
  text: string | null;
  raw: string;
  outcome?: RunOutcome;
  usage?: RunUsage | null;
  result?: {
    summary: RunSummary;
    items: NewItem[];
    checked?: CheckedEarlier[];
    answer?: string;
    fix?: { threads: FixNote[]; edits: ValidEdit[] };
    links?: Map<NewItem, CandidateLink>;
    carried?: Map<number, CarriedMark>;
    notes?: NoteProposal[];
    explain?: ExplainResult;
    discuss?: DiscussResult;
    // A task run (docs/plans/review-v2/spec.md section 6.5): the parsed result. The finish of the task run applies it.
    task?: unknown;
  };
};

// docs/plans/thread-outcome.md: the why values of a thread note that give a nofix reply draft. decision, risk, and dropped give none.
const NOFIX_DRAFT: ReadonlySet<FixWhy | null> = new Set<FixWhy>(["already", "invalid", "scope", "unclear"]);

function cap(s: string) {
  const b = Buffer.from(s);
  return b.length <= RAW_MAX ? s : `${b.subarray(0, RAW_MAX - 100).toString()}\n[truncated: the raw output exceeds ${RAW_MAX} bytes]`;
}

function rawOutput(o: RunOutcome): string {
  const r = o.result;
  const text = [r?.result, ...(r?.errors ?? [])].filter((x) => x).join("\n");
  return cap(
    [
      `# Result${r ? ` (subtype ${r.subtype}, is_error ${r.is_error})` : ""}`,
      text || "(none)",
      "",
      "# structured_output",
      r?.structured_output === undefined ? "(none)" : JSON.stringify(r.structured_output, null, 2),
      "",
      `# stderr tail (exit code ${o.exitCode ?? "none"})`,
      o.stderrTail || "(empty)",
      "",
    ].join("\n"),
  );
}

export const failure = (kind: RunErrorKind, text: string): Ending => ({ status: "failed", kind, text, raw: `${kind}: ${text}` });

const findingItem = (f: AnchoredFinding, status: "new" | "discarded" = "new"): NewItem => ({
  kind: "finding",
  payload_json: JSON.stringify(f),
  body: f.body,
  path: f.anchor.path,
  side: f.side,
  line: f.anchor.line,
  line_end: f.anchor.lineEnd,
  anchor_state: f.anchor.state,
  excerpt_json: JSON.stringify(f.anchor.excerpt),
  status,
  thread: null,
  edited: 0,
});

const questionItem = (q: Question): NewItem => ({
  kind: "question",
  payload_json: JSON.stringify(q),
  body: q.text,
  ...NO_ANCHOR,
  status: "new",
  thread: null,
  edited: 0,
});

const replyItem = (r: ValidatedReply): NewItem => ({
  kind: "reply",
  payload_json: JSON.stringify(r.payload),
  body: r.payload.body,
  ...NO_ANCHOR,
  status: r.status,
  thread: r.payload.thread,
  edited: 0,
});

export const issuesText = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");

function schemaFailure(issues: { path: PropertyKey[]; message: string }[], what: string, raw: string, o: RunOutcome): Ending {
  return { status: "failed", kind: "schema", text: `The result does not match the ${what} schema. ${issuesText(issues)}`, raw, outcome: o };
}

// The servers and skills left out of the spec, then the servers of the spec that did not connect.
function unavailable(o: RunOutcome, servers: string[], gaps: string[]): string[] {
  const down = servers.flatMap((name) => {
    const status = o.init?.mcp_servers?.find((s) => s.name === name)?.status ?? "absent";
    return status === "connected" ? [] : [`MCP server ${name}: ${status}`];
  });
  return [...gaps, ...down];
}

// rl-main calls have no parent. stream.ts gives Read targets with "/" and relative to the run folder when the path is inside it.
// root: the skills folder from the run folder (skillLines).
export function unreadAlways(o: RunOutcome, always: { id: string; folder: string }[], root = "skills"): string[] {
  const read = new Set(
    o.events.filter((e) => e.tool === "Read" && e.parent === null && e.status === "ok").map((e) => e.target.replace(/^(\.\/)+/, "")),
  );
  return always
    .filter((s) => !read.has(`${root}/${s.folder}/SKILL.md`))
    .map((s) => `Skill ${s.id} (always use): the model did not read SKILL.md.`);
}

// The rl-git tools whose path argument shows the file or its changes (git-mcp.ts). git_log with a path shows commit subjects only.
const GIT_PATH_TOOLS = ["git_diff", "git_blame", "git_show"].map((t) => `mcp__${GIT_SERVER}__${t}`);
const REPO_DIR = "repo/";
// docs/plans/review-v3.md WP-V13: the repository paths that an agent of the find phase opened, by any agent. stream.ts targetOf gives
// a Read target relative to the run folder with "/", and a git tool target as its path argument relative to ./repo, else its JSON
// input or "". A git_diff without a path opens no single file, so the set is a lower bound.
export function openedFiles(events: RunEvent[]): Set<string> {
  const opened = new Set<string>();
  for (const e of events) {
    if (e.status !== "ok" || eventPhase(e) !== "find") continue;
    const target = e.target.replace(/^(\.\/)+/, "");
    if (e.tool === "Read" && target.startsWith(REPO_DIR)) opened.add(target.slice(REPO_DIR.length));
    else if (GIT_PATH_TOOLS.includes(e.tool) && target !== "" && !target.startsWith("{")) opened.add(target);
  }
  return opened;
}
// The number of changed files that no agent opened (openedFiles), by path or old path. A git_diff without a path and without
// stat_only pages the whole diff, so then no file counts as unread. A binary file has no text to read.
// Limit: git_diff with stat_only and a path counts as a read.
export function unreadFiles(events: RunEvent[], files: DiffFile[]): number {
  const fullDiff = events.some(
    (e) =>
      e.status === "ok" &&
      eventPhase(e) === "find" &&
      e.tool === GIT_PATH_TOOLS[0] &&
      (e.target === "" || (e.target.startsWith("{") && !e.target.includes('"stat_only":true'))),
  );
  if (fullDiff) return 0;
  const opened = openedFiles(events);
  return files.filter((f) => !f.binary && ![f.path, f.oldPath].some((p) => p !== null && opened.has(p))).length;
}

// gaps: the lines that the app added to coverage skipped and unavailable. Only they make the run incomplete. The lines of the model
// stay in the coverage, but they do not change the status (docs/plans/review-v2/spec.md section 1.9).
function ended(raw: string, o: RunOutcome, result: NonNullable<Ending["result"]>, gaps: readonly string[]): Ending {
  return { status: gaps.length ? "incomplete" : "completed", kind: null, text: null, raw, outcome: o, result };
}

type Placed = Pick<StoredFinding, "path" | "side">;

// submodule-prs.md SD21: the moved gitlinks of the run by path, with the pinned commit of each side. null: no gitlink on that side.
export type Gitlinks = ReadonlyMap<string, { old: string | null; new: string | null }>;

// Reads the finding files from the cache clone, never from the sanitized worktree. The lookup matches validate().
// gitlinks: a gitlink path has no blob. Its text is the line of git diff, so a cause on line 1 of that path validates.
async function readBlobs(ws: Workspace, findings: Placed[], gitlinks?: Gitlinks) {
  const byNew = new Map<string, DiffFile>();
  const byOld = new Map<string, DiffFile>();
  for (const f of parseDiff(ws.diff)) {
    if (f.path !== null) byNew.set(f.path, f);
    if (f.oldPath !== null) byOld.set(f.oldPath, f);
  }
  const newFiles = new Map<string, string>();
  const oldFiles = new Map<string, string>();
  const big = new Set<string>();
  for (const [path, g] of gitlinks ?? []) {
    if (g.new !== null) newFiles.set(path, `Subproject commit ${g.new}`);
    if (g.old !== null) oldFiles.set(path, `Subproject commit ${g.old}`);
  }
  const blobOf = (f: Placed) => {
    const p = repoPath(f.path);
    if (p === null) return null;
    const file = byNew.get(p) ?? byOld.get(p);
    // A file outside the diff is the same at base and head, and the validator reads it from newFiles.
    const old = f.side === "old" && file !== undefined;
    const path = file ? (f.side === "new" ? file.path : file.oldPath) : p;
    if (path === null) return null;
    return { path, map: old ? oldFiles : newFiles, object: `${old ? ws.mergeBase : ws.sourceHead}:${path}` };
  };
  const env = gitEnv("/dev/null");
  const g = (args: string[]) => git([`--git-dir=${ws.cache}`, ...args], { env });
  const load = async (b: { path: string; map: Map<string, string>; object: string }) => {
    if (b.map.has(b.path) || big.has(b.object)) return;
    try {
      if (Number((await g(["cat-file", "-s", b.object])).trim()) > MAX_FILE_CHARS) big.add(b.object);
      else b.map.set(b.path, await g(["cat-file", "blob", b.object]));
    } catch {
      // No such file on that side. The validator drops the finding with reason "file".
    }
  };
  for (const f of findings) {
    const b = blobOf(f);
    if (b) await load(b);
  }
  const oversized = (f: Placed) => {
    const b = blobOf(f);
    return b !== null && big.has(b.object);
  };
  // validate.ts relocate: the new side of each changed text file, for a finding whose own file failed.
  const loadChanged = async () => {
    for (const f of byNew.values())
      if (!f.binary && f.path !== null) await load({ path: f.path, map: newFiles, object: `${ws.sourceHead}:${f.path}` });
  };
  return { newFiles, oldFiles, oversized, loadChanged };
}

// submodule-prs.md SD21: ./repo has no file of a gitlink, so the finder can give a cause on line 1 of a gitlink path with an empty quote.
// That cause gets the readBlobs text of its side as the quote. An empty quote on any other place stays empty and drops.
function quoteGitlinks<T extends Pick<Finding, "cause">>(findings: T[], gitlinks?: Gitlinks): T[] {
  return findings.map((f) => {
    const c = f.cause;
    if (c?.line !== 1 || collapse(c.anchorText)) return f;
    const p = repoPath(c.path);
    const sha = p === null ? null : gitlinks?.get(p)?.[c.side];
    return sha ? { ...f, cause: { ...c, anchorText: `Subproject commit ${sha}` } } : f;
  });
}

// The finder result of a review run after validation and dedupe, before the verify phase (spec.md sections 1.6 and 1.7).
// candidates: the kept findings in finder order, then the open carried findings of a re-review. replies: the answered questions.
export type Found = {
  raw: string;
  outcome: RunOutcome;
  summary: RunSummary;
  candidates: Candidate[];
  questions: Question[];
  replies: ValidatedReply[];
  checked?: CheckedEarlier[];
  // The lines that the app added to coverage skipped and unavailable (ended).
  gaps: string[];
};

// Validates the finder result of a review run. servers: the MCP servers of the spec. gaps: the servers and skills left out of the spec.
// rereview: the earlier findings of a re-review at their current lines. asked: the threads of context/questions.md.
// rules: the project instruction files of the run. addedOnly: validate.ts ValidateInput.addedOnly. gitlinks: readBlobs. An Ending: the
// finder failed.
export async function judge(
  o: RunOutcome,
  ws: Workspace,
  profile: Profile,
  servers: string[],
  gaps: string[],
  rereview: { carry: Carry; items: EarlierItem[] } | null,
  asked: AskedThread[],
  rules: readonly RuleSource[] = [],
  addedOnly = false,
  gitlinks?: Gitlinks,
): Promise<Ending | Found> {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut<ReviewResult>(rereview ? rereviewResult : reviewResult, o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, rereview ? "re-review" : "review", raw, o);
  const earlier = rereview ? (parsed.data as RereviewResult).earlier : [];
  const items = rereview?.items ?? [];
  // Only a finished Agent call returned a report.
  const agents = o.events.filter((e) => e.tool === "Agent" && e.agent !== null && e.status === "ok").map((e) => e.agent as string);
  const causes = parsed.data.findings.flatMap((f) => (f.cause ? [{ ...f, ...f.cause }] : []));
  const blobs = await readBlobs(
    ws,
    [...parsed.data.findings, ...causes, ...earlierCases(earlier, items).cases.map((c) => c.finding)],
    gitlinks,
  );
  const check = () =>
    validate({
      result: { ...parsed.data, findings: quoteGitlinks(parsed.data.findings, gitlinks) },
      diff: ws.diff,
      ...blobs,
      agents,
      explain: profile.explain,
      rules,
      addedOnly,
    });
  let v = check();
  if (v.dropped.some((d) => d.reason === "file" || d.reason === "match")) {
    await blobs.loadChanged();
    v = check();
  }
  const e = rereview ? validateEarlier({ earlier, items, diff: ws.diff, ...blobs }) : null;
  const a = profile.explain ? null : validateAnswered(parsed.data.answered, asked, v.kept);
  const dropped = v.dropped.map((d) => (d.reason === "file" && blobs.oversized(d) ? { ...d, reason: "size" as const } : d));
  const base = rereview?.carry.incomplete ? [`Run ${rereview.carry.base}, the base of this re-review, was incomplete.`] : [];
  const added = [...parsed.cuts, ...(e?.skipped ?? []), ...(a?.skipped ?? [])];
  const down = unavailable(o, servers, gaps);
  const coverage = {
    ...v.coverage,
    skipped: [...parsed.cuts, ...v.coverage.skipped, ...(e?.skipped ?? []), ...(a?.skipped ?? [])],
    unavailable: [...v.coverage.unavailable, ...down],
    notChecked: [...v.coverage.notChecked, ...base],
  };
  // spec.md section 1.9: the open carried findings of the base run with code at the head join after the new ones. A posted finding
  // has its thread, so it gets no verdict.
  const own = new Set(rereview?.carry.items.filter((r) => r.kind === "finding").map((r) => r.id));
  const list = [
    ...v.findings.map((finding) => ({ finding, from: null })),
    ...(e?.checked ?? []).flatMap((c) =>
      c.verdict === "open" && c.anchor !== null && own.has(c.id) ? [{ finding: { ...c.finding, anchor: c.anchor }, from: c.id }] : [],
    ),
  ];
  const groups = overlapGroups(list.map((x) => ({ side: x.finding.side, anchor: x.finding.anchor })));
  return {
    raw,
    outcome: o,
    summary: { summary: v.summary, risks: v.risks, coverage, dropped },
    candidates: list.map((x, i) => ({ ...x, n: i + 1, group: groups[i] ?? null })),
    questions: v.questions,
    replies: a?.replies ?? [],
    ...(e && { checked: e.checked }),
    gaps: [...added, ...down],
  };
}

// Gate G-ADV (ADV5, gadv-advisor.jsonl): the result usage has an iteration of type advisor_message with the advisor model, and
// modelUsage lists that model. A run whose result usage names no advisor model gives the --advisor value.
function advisorModels(o: RunOutcome): string[] | undefined {
  if (!o.advisor || !o.events.some((e) => e.tool === ADVISOR_TOOL)) return undefined;
  const iterations = (o.result?.usage as { iterations?: unknown } | undefined)?.iterations;
  const named = (Array.isArray(iterations) ? iterations : []).flatMap((i) =>
    i && typeof i === "object" && i.type === "advisor_message" && typeof i.model === "string" ? [i.model as string] : [],
  );
  const keys = Object.keys(o.result?.modelUsage ?? {}).filter((k) => named.includes(k));
  return keys.length ? keys : [o.advisor];
}

export const usageOf = (o: RunOutcome): RunUsage | null => {
  const r = o.result;
  if (!r) return null;
  const advisor = advisorModels(o);
  return { costUsd: r.total_cost_usd, turns: r.num_turns, durationMs: r.duration_ms, tokens: r.usage, ...(advisor && { advisor }) };
};

// The usage of both phases. tokens: the sum of each number key. The token count of the UI reads only those keys.
export function addUsage(a: RunUsage | null, b: RunUsage | null): RunUsage | null {
  if (!a || !b) return a ?? b;
  const tokens: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a.tokens ?? {}), ...Object.keys(b.tokens ?? {})])) {
    const x = a.tokens?.[k];
    const y = b.tokens?.[k];
    if (typeof x === "number" || typeof y === "number") tokens[k] = (typeof x === "number" ? x : 0) + (typeof y === "number" ? y : 0);
  }
  const advisor = [...new Set([...(a.advisor ?? []), ...(b.advisor ?? [])])];
  return {
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
    durationMs: a.durationMs + b.durationMs,
    tokens,
    ...(advisor.length > 0 && { advisor }),
  };
}

// The verify process of a review run (spec.md section 1.6). written: the candidates in candidates.md, from candidate 1. asked: the
// finder questions after them, numbered from written + 1 (context-files.ts candidatesFile). risks: the finder risks after the
// questions, numbered from written + asked + 1. Absent: none (docs/plans/review-v2/risk-check.md section 4.6). obligations: the check
// also listed the obligations of the change (docs/plans/review-v2/obligations.md section 4.1). Absent: no.
export type CheckRun = {
  o: RunOutcome;
  startedAt: number;
  endedAt: number;
  written: number;
  asked: number;
  risks?: number;
  obligations?: boolean;
};

// One verdict per candidate, per finder question, and per finder risk in candidates.md. An unknown or a second verdict goes to skipped.
// A candidate without a verdict stays unchecked, and its line in skipped makes the run incomplete (spec.md section 1.9). A question
// without a verdict stays as the finder asked it and adds no line, as before prompt version 2.7 (docs/plans/review-v2/review-questions.md).
// risk-check.md AC-R44: a risk verdict adds no line, so a second verdict for a risk drops without one.
export function verdictsOf(list: readonly VerifyVerdict[], written: number, asked = 0, risks = 0) {
  const verdicts = new Map<number, VerifyVerdict>();
  const skipped: string[] = [];
  for (const v of list) {
    if (v.candidate > written + asked + risks)
      skipped.push(`Verdict for candidate ${v.candidate} dropped: ./context/candidates.md has no such candidate.`);
    else if (verdicts.has(v.candidate)) {
      if (v.candidate <= written + asked) skipped.push(`Verdict for candidate ${v.candidate} dropped: a second verdict for the candidate.`);
    } else verdicts.set(v.candidate, v);
  }
  for (let n = 1; n <= written; n++) if (!verdicts.has(n)) skipped.push(`Candidate ${n} has no verdict. It stays unchecked.`);
  return { verdicts, skipped };
}

// spec.md section 1.9: a duplicate names another candidate of its group, else it reads as unsure. The named candidate must not be a
// duplicate itself, so a chain or a loop of duplicates never discards every copy of one problem.
export function effectiveVerdicts(candidates: readonly Candidate[], verdicts: ReadonlyMap<number, VerifyVerdict>) {
  const group = new Map(candidates.map((c) => [c.n, c.group]));
  const out = new Map<number, VerifyVerdict>();
  for (const [n, v] of verdicts) {
    const to = v.duplicateOf;
    const ok =
      v.verdict !== "duplicate" ||
      (to !== null &&
        to !== n &&
        (group.get(n) ?? null) !== null &&
        group.get(to) === group.get(n) &&
        verdicts.get(to)?.verdict !== "duplicate");
    out.set(n, ok ? v : { ...v, verdict: "unsure", duplicateOf: null });
  }
  return out;
}

const atMostMinor = (s: Severity): Severity => (s === "blocker" || s === "major" ? "minor" : s);

export type Capped =
  | { kind: "question"; question: Question }
  | { kind: "finding"; status: "new" | "discarded"; severity: Severity; check: Check; demoted?: true };

export { neverHidden };

// spec.md section 1.7, the caps: structured fields only, never the text. v undefined: the phase is off, failed, or skipped the
// candidate. carried: a carried finding keeps its kind, so a question verdict reads as unsure and an empty trigger makes no question.
export function capOf(
  c: Pick<StoredFinding, "severity" | "trigger" | "evidenceStatus" | "title" | "body">,
  v: Pick<VerifyVerdict, "verdict" | "severity" | "reason" | "question"> | undefined,
  carried = false,
  demote = false,
): Capped {
  // demote: a refuted finding stays in the list. A duplicate always hides, because the candidate that it repeats stays.
  if (demote && v?.verdict === "refuted")
    return { kind: "finding", status: "new", severity: c.severity, check: "unchecked", demoted: true };
  if (v?.verdict === "refuted" || v?.verdict === "duplicate")
    return { kind: "finding", status: "discarded", severity: c.severity, check: "unchecked" };
  if (!carried && v?.verdict === "question")
    return { kind: "question", question: { text: v.question.trim() || c.title?.trim() || c.body, why: v.reason } };
  if (!carried && !c.trigger?.trim() && v?.verdict !== "confirmed")
    return { kind: "question", question: { text: c.title?.trim() || c.body, why: "No concrete case was named." } };
  const check: Check =
    v?.verdict === "confirmed" ? "checked" : v?.verdict === "unsure" || v?.verdict === "question" ? "unsure" : "unchecked";
  let severity = v ? v.severity : c.severity;
  if (check !== "checked" && c.evidenceStatus === "unverified") severity = atMostMinor(severity);
  if (check === "unsure") severity = atMostMinor(severity);
  return { kind: "finding", status: "new", severity, check };
}

const COUNT: Record<VerifyVerdictName, Exclude<keyof VerifySummary, "failed" | "candidates" | "unchecked">> = {
  confirmed: "confirmed",
  refuted: "refuted",
  unsure: "unsure",
  question: "questions",
  duplicate: "duplicates",
};
const findings = (n: number) => `${n} ${n === 1 ? "finding is" : "findings are"}`;
const CHECK_ORDER: readonly Check[] = ["checked", "unsure", "unchecked"];
// The merge of the verifier coverage. Its gaps do not make the run incomplete: a missing verdict does.
const union = (a: string[], b: string[]) => [...a, ...b.filter((x) => !a.includes(x))];

// volume: the volume of the profile at the start. find: the finder phase. check: the verify process, or null when it did not start.
// verify: the verify phase is on. written: the candidates in candidates.md, 0 without the file.
export type SettleInput = {
  volume: Volume;
  find: RunPhase;
  check: CheckRun | null;
  verify: boolean;
  written: number;
  servers: string[];
  // The profile keeps refuted findings in the list (verifier outcome demote).
  demote?: boolean;
  // placeAnswers: the anchored finding of each confirmed finder question and finder risk, by its number in candidates.md.
  placed?: ReadonlyMap<number, AnchoredFinding>;
  // The risk check is on: each review run and each own review of a task since prompt 2.9, never the critic. Absent or false: the
  // summary gets no finderRisks key.
  risks?: boolean;
  // placeObligations: the app checks of the obligations, by list index.
  obligations?: PlacedObligations;
};

const OBLIGATION_LIST = verifyResult.pick({ obligations: true });

const mark = (v: VerifyVerdict): VerifyMark => ({
  verdict: v.verdict,
  severity: v.severity,
  reason: v.reason,
  evidence: v.evidence,
  duplicateOf: null,
  by: "rl-verify",
});

// docs/plans/review-v2/risk-check.md section 4.4: what settle knows about one finder risk. verify: the verify step is on. fits: the
// risk has a block in candidates.md. failed: the check failed or its result failed the verify schema. v: the raw verdict of the block
// (verdictsOf, never effectiveVerdicts). at: its anchored finding (placeAnswers). cands: the candidates 1 to written of candidates.md,
// each with its title and the verdict of the run.
export type RiskStep = {
  verify: boolean;
  fits: boolean;
  failed: boolean;
  v?: VerifyVerdict;
  at?: AnchoredFinding;
  cands: ReadonlyMap<number, { title: string; verdict: string }>;
};
export type RiskEnd = {
  outcome: RiskOutcome;
  note: string;
  item?: { kind: "finding"; finding: FindingPayload };
};

// risk-check.md section 4.4, rows R0 to R10: the outcome of one finder risk. The first row that matches wins. Only found makes an
// item. Since prompt 2.9, no row gives asked; old summaries still hold it.
export function riskOutcome(text: string, s: RiskStep): RiskEnd {
  const v = s.v;
  if (!s.verify) return { outcome: "open", note: "Not checked: the check step is off." };
  if (!s.fits) return { outcome: "open", note: "Not checked: the check file reached its size limit." };
  if (s.failed) return { outcome: "open", note: "Not checked: the check did not finish." };
  if (!v) return { outcome: "open", note: "The check gave no verdict." };
  switch (v.verdict) {
    case "confirmed":
      if (s.at)
        return {
          outcome: "found",
          note: s.at.title?.trim() || s.at.body,
          item: { kind: "finding", finding: { ...s.at, verify: mark(v) } },
        };
      // risk-check.md section 7, the fallback, cascade step 2 (Gate RC-A, prompt 2.9): R5 and R6 give open with the question in the
      // note and make no item. Step 1 alone (R6 only) is not measured.
      return { outcome: "open", note: `Confirmed, but the check could not place it: ${v.finding?.title.trim() || text}` };
    case "question":
      return { outcome: "open", note: v.question.trim() || text };
    case "refuted":
      return {
        outcome: "cleared",
        note: [v.reason.trim(), v.evidence.trim() && `Evidence: ${v.evidence.trim()}`].filter(Boolean).join(" "),
      };
    case "duplicate": {
      const same = v.duplicateOf === null ? undefined : s.cands.get(v.duplicateOf);
      if (same) return { outcome: "covered", note: `Same point as: ${same.title} (${same.verdict})` };
      return { outcome: "open", note: "The check named no finding for this repeat." };
    }
    case "unsure":
      return { outcome: "open", note: v.reason.trim() };
  }
}

// The first verdict of each finder question and finder risk of a finished check. Empty: the check failed or had neither.
function questionVerdicts(check: CheckRun | null): Map<number, VerifyVerdict> {
  if (!(check?.asked || check?.risks) || check.o.status !== "completed") return new Map();
  const parsed = parseCut(verifyResult, check.o.result?.structured_output);
  if (!parsed.success) return new Map();
  return new Map(
    [...verdictsOf(parsed.data.verdicts, check.written, check.asked, check.risks).verdicts].filter(([n]) => n > check.written),
  );
}

// docs/plans/review-v2/review-questions.md: the finding that a confirmed finder question becomes. The check reads the code, so the
// evidence status is code and the confidence high. The trigger stays empty: the check reason holds it, and the card shows that once.
// category "risk": a confirmed finder risk (docs/plans/review-v2/risk-check.md section 4.4). category "obligation": a missing
// obligation (docs/plans/review-v2/obligations.md section 4.6).
export const answerFinding = (
  v: Pick<VerifyVerdict, "severity" | "reason" | "evidence">,
  at: Defect,
  category: "question" | "risk" | "obligation" = "question",
): Finding => ({
  ...at,
  severity: v.severity,
  category,
  body: at.body.trim() || v.reason,
  evidence: v.evidence,
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  trigger: "",
  cause: null,
  rule: "",
  module: "core",
});

// The anchored finding of each confirmed finder question and finder risk with a place, by its number in candidates.md. The finder
// validator anchors it. A place that it drops gives no entry, so the question stays, and the risk gets asked (risk-check.md R5).
export async function placeAnswers(ws: Workspace, check: CheckRun | null, gitlinks?: Gitlinks): Promise<Map<number, AnchoredFinding>> {
  const made = [...questionVerdicts(check)].flatMap(([n, v]) =>
    v.verdict === "confirmed" && v.finding
      ? [{ n, finding: answerFinding(v, v.finding, check && n > check.written + check.asked ? "risk" : "question") }]
      : [],
  );
  return anchorAll(ws, made, gitlinks);
}

// The finder validator pass of placeAnswers and placeObligations: n keys each made finding. A dropped place gives no entry.
// gitlinks: readBlobs.
async function anchorAll(
  ws: Workspace,
  made: { n: number; finding: Finding }[],
  gitlinks?: Gitlinks,
): Promise<Map<number, AnchoredFinding>> {
  const out = new Map<number, AnchoredFinding>();
  if (!made.length) return out;
  const findings = quoteGitlinks(
    made.map((m) => m.finding),
    gitlinks,
  );
  const blobs = await readBlobs(ws, [...findings, ...findings.flatMap((f) => (f.cause ? [f.cause] : []))], gitlinks);
  const coverage = { read: [], skipped: [], unavailable: [], notChecked: [] };
  const result: ReviewResult = { summary: "", risks: [], questions: [], coverage, findings, answered: [] };
  const anchor = () => validate({ result, diff: ws.diff, ...blobs, agents: [] });
  let v = anchor();
  if (v.dropped.some((d) => d.reason === "file" || d.reason === "match")) {
    await blobs.loadChanged();
    v = anchor();
  }
  v.kept.forEach((k, i) => {
    const m = made[i];
    const f = k === null ? undefined : v.findings[k];
    if (m && f) out.set(m.n, f);
  });
  return out;
}

// ---------- Obligations (docs/plans/review-v2/obligations.md sections 4.4 to 4.6) ----------

// The obligations of a finished check with the mode on. Empty: the mode is off, or the check failed.
function obligationsOf(check: CheckRun | null): Obligation[] {
  if (!check?.obligations || check.o.status !== "completed") return [];
  const parsed = parseCut(verifyResult, check.o.result?.structured_output);
  return parsed.success ? parsed.data.obligations : [];
}

// section 4.4 steps 1 and 2: the only files of ./context that a cite can name. They are copies of the task text and the PR text.
const CITE_CONTEXT = ["context/task.md", "context/pr.md", "context/pr-context.md"];

// Where the cite check reads the file. null: the path can leave the snapshot, so the check fails.
export function citeSource(raw: string): { kind: "context"; name: string } | { kind: "repo"; path: string } | null {
  const p = repoPath(raw);
  if (p === null) return null;
  return CITE_CONTEXT.includes(p) ? { kind: "context", name: p.slice("context/".length) } : { kind: "repo", path: p };
}

// section 4.4 step 3: text undefined means that the file is absent at the head.
export const citeHolds = (quote: string, text: string | undefined) => {
  const q = collapse(quote);
  return q !== "" && text !== undefined && collapse(text).includes(q);
};

// section 4.6: the finding of a missing obligation. Step 6 lowers blocker to major. The validator keeps an anchor on unchanged code
// only with a changed cause.
export const obligationFinding = (o: Obligation, at: Defect & { cause?: Finding["cause"] }): Finding => ({
  ...answerFinding(
    {
      severity: o.severity === "blocker" ? "major" : o.severity,
      reason: `${o.must.trim()} ${o.consumer.trim()}`,
      evidence: `${o.cite.path}: ${o.cite.quote}`,
    },
    at,
    "obligation",
  ),
  cause: at.cause ?? null,
});

// placeObligations, by list index: the missing obligations with a passed cite, and those with a place that the validator kept.
export type PlacedObligations = { cited: ReadonlySet<number>; placed: ReadonlyMap<number, AnchoredFinding> };

// section 4.4: the app checks of each missing obligation. The cite reads a repository file from the cache clone at the head, never
// from the sanitized worktree. A context cite reads only the files of CITE_CONTEXT.
export async function placeObligations(ws: Workspace, check: CheckRun | null, gitlinks?: Gitlinks): Promise<PlacedObligations> {
  const missing = obligationsOf(check).flatMap((o, i) => (o.status === "missing" ? [{ i, o, src: citeSource(o.cite.path) }] : []));
  const repo = missing.flatMap((m) => (m.src?.kind === "repo" ? [{ path: m.src.path, side: "new" as const }] : []));
  const blobs = repo.length ? await readBlobs(ws, repo) : null;
  const context = (name: string) => {
    try {
      return readFileSync(join(ws.context, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const cited = new Set(
    missing
      .filter(({ o, src }) =>
        citeHolds(o.cite.quote, src === null ? undefined : src.kind === "context" ? context(src.name) : blobs?.newFiles.get(src.path)),
      )
      .map((m) => m.i),
  );
  const made = missing.flatMap(({ i, o }) => (cited.has(i) && o.finding ? [{ n: i, finding: obligationFinding(o, o.finding) }] : []));
  return { cited, placed: await anchorAll(ws, made, gitlinks) };
}

// section 4.5: what settle knows about one obligation. cited: the cite check passed. at: the anchored finding. blocks: the text of each
// block of candidates.md, by its number: the candidate title, or the question or risk text.
export type ObligationStep = { cited: boolean; at?: AnchoredFinding; blocks: ReadonlyMap<number, string> };
export type ObligationEnd = { outcome: ObligationOutcome; note: string; item?: FindingPayload };

// section 4.5, rows O1 to O8: the outcome of one obligation. The first row that matches wins. Only found makes an item.
export function obligationOutcome(o: Obligation, s: ObligationStep): ObligationEnd {
  switch (o.status) {
    case "met":
      return { outcome: "met", note: `The check says: ${o.evidence.trim()}` };
    case "deferred":
      return { outcome: "deferred", note: `Deferred: ${o.evidence.trim()}` };
    case "covered": {
      const same = o.duplicateOf === null ? undefined : s.blocks.get(o.duplicateOf);
      if (same !== undefined) return { outcome: "covered", note: `Same point as: ${same}` };
      return { outcome: "open", note: "The check named no block for this repeat." };
    }
    case "missing":
      if (!s.cited) return { outcome: "open", note: `The cited text is not in ${o.cite.path}.` };
      if (!s.at) return { outcome: "open", note: "Missing, but the check could not place it." };
      return {
        outcome: "found",
        note: s.at.title?.trim() || s.at.body,
        item: {
          ...s.at,
          verify: {
            verdict: "confirmed",
            severity: s.at.severity,
            reason: `${o.must.trim()} ${o.consumer.trim()}`,
            evidence: o.evidence,
            duplicateOf: null,
            by: "rl-verify",
          },
        },
      };
    case "unsure":
      return { outcome: "open", note: `Not settled: ${o.evidence.trim()}` };
  }
}

// The run end of a review run: the verdicts and the caps of each candidate, the items, and the summary (spec.md sections 1.7 and 1.8).
export function settle(f: Found, s: SettleInput): Ending {
  const coverage = {
    read: [...f.summary.coverage.read],
    skipped: [...f.summary.coverage.skipped],
    unavailable: [...f.summary.coverage.unavailable],
    notChecked: [...f.summary.coverage.notChecked],
  };
  const gaps = [...f.gaps];
  const phases: RunPhase[] = [s.find];
  let usage = s.find.usage;
  let raw = f.raw;
  let got = new Map<number, VerifyVerdict>();
  // risk-check.md section 4.4: the risk rows read these, because effectiveVerdicts turns each duplicate of a risk into unsure.
  let verdicts: ReadonlyMap<number, VerifyVerdict> = new Map();
  let failed: VerifySummary["failed"];
  // obligations.md section 4.5: a check with zero blocks only lists the obligations, so none of its lines is a gap (AC-R54).
  const own = s.check?.obligations === true && s.check.written + s.check.asked + (s.check.risks ?? 0) === 0;
  let listed: Obligation[] | undefined;
  if (s.check) {
    const o = s.check.o;
    raw = cap(`${raw}\n# Check phase\n\n${rawOutput(o)}`);
    phases.push({ name: "check", startedAt: s.check.startedAt, endedAt: s.check.endedAt, usage: usageOf(o) });
    usage = addUsage(usage, usageOf(o));
    const parsed = o.status === "completed" ? parseCut(verifyResult, o.result?.structured_output) : null;
    if (!parsed) failed = { kind: o.kind, text: o.text };
    else if (!parsed.success)
      failed = { kind: "schema", text: `The result does not match the verify schema. ${issuesText(parsed.error.issues)}` };
    else {
      const v = verdictsOf(parsed.data.verdicts, s.check.written, s.check.asked, s.check.risks);
      verdicts = v.verdicts;
      got = effectiveVerdicts(f.candidates.slice(0, s.check.written), v.verdicts);
      const c = parsed.data.coverage;
      // obligations.md section 4.5: the cut notes of the obligation list go to notChecked. cutToCaps names its schema path in each note.
      const listCuts = new Set(s.check.obligations ? cutToCaps(OBLIGATION_LIST, o.result?.structured_output).notes : []);
      const lines = [...parsed.cuts.filter((x) => !listCuts.has(x)).map((x) => `Check: ${x}`), ...v.skipped];
      if (own) coverage.notChecked.push(...lines);
      else {
        coverage.skipped.push(...lines);
        gaps.push(...lines);
      }
      coverage.read = union(coverage.read, c.read);
      coverage.notChecked.push(...[...c.skipped, ...c.notChecked, ...c.unavailable, ...listCuts].map((x) => `Check: ${x}`));
      if (s.check.obligations) listed = parsed.data.obligations;
    }
    const down = unavailable(o, s.servers, []);
    coverage.unavailable = union(coverage.unavailable, down);
    if (!own) gaps.push(...down);
  }
  const verify: VerifySummary = {
    candidates: f.candidates.length,
    confirmed: 0,
    refuted: 0,
    unsure: 0,
    questions: 0,
    duplicates: 0,
    unchecked: 0,
  };
  const left = s.verify ? f.candidates.length - s.written : 0;
  if (left > 0)
    coverage.notChecked.push(
      `${left} candidates were left out of ./context/candidates.md: it reached its size limit. They are not checked.`,
    );
  const items: NewItem[] = [];
  const asked: Question[] = [];
  const links = new Map<NewItem, CandidateLink>();
  const carried = new Map<number, CarriedMark>();
  // docs/plans/review-v3.md WP-V6 and Q6: the shown pre-existing findings, capped after the loop. low: those that ended below major or as
  // a question. A pre-existing finding is never demoted, never asked, and never posted.
  const pres: { item: NewItem; link: CandidateLink; rank: number }[] = [];
  let low = 0;
  for (const c of f.candidates) {
    const v = got.get(c.n);
    if (v) verify[COUNT[v.verdict]]++;
    else verify.unchecked++;
    const pre = c.from === null && c.finding.preexisting === true;
    const out = capOf(c.finding, v, c.from !== null, !pre && (s.demote === true || neverHidden(c.finding)));
    const link = { n: c.n, duplicateOf: v?.verdict === "duplicate" ? v.duplicateOf : null };
    if (pre && (out.kind === "question" || (out.status === "new" && out.severity !== "blocker" && out.severity !== "major"))) {
      low++;
      continue;
    }
    if (out.kind === "question") {
      asked.push(out.question);
      continue;
    }
    if (c.from !== null) {
      carried.set(c.from, {
        ...link,
        ...(v && { verify: mark(v) }),
        severity: out.severity,
        discard: out.status === "discarded",
        ...(out.demoted && { demoted: true }),
      });
      continue;
    }
    const payload: FindingPayload = {
      ...c.finding,
      severity: out.severity,
      ...(v && { verify: mark(v) }),
      ...(out.severity !== c.finding.severity && { finderSeverity: c.finding.severity }),
      ...(out.status === "discarded" && { discardedBy: "verify" as const }),
      ...(out.demoted && { demoted: true as const }),
    };
    const item = findingItem(payload, out.status);
    if (pre && out.status === "new") {
      pres.push({ item, link, rank: severities.indexOf(out.severity) * confidences.length + confidences.indexOf(c.finding.confidence) });
      continue;
    }
    links.set(item, link);
    items.push(item);
  }
  // By severity, then confidence. The sort is stable, so equal ranks keep the finder order.
  pres.sort((a, b) => a.rank - b.rank);
  for (const p of pres.slice(0, PREEXISTING_MAX)) {
    links.set(p.item, p.link);
    items.push(p.item);
  }
  const over = Math.max(0, pres.length - PREEXISTING_MAX);
  if (low)
    coverage.notChecked.push(`${low} pre-existing ${low === 1 ? "finding was" : "findings were"} left out: below major after the check.`);
  if (over)
    coverage.notChecked.push(
      `${over} pre-existing ${over === 1 ? "finding was" : "findings were"} left out: a run shows at most ${PREEXISTING_MAX}.`,
    );
  // docs/plans/review-v2/review-questions.md: the verdict of each finder question. Question k has number written + k + 1.
  const finderQuestions: FinderQuestions = { asked: f.questions.length, answered: 0, findings: 0, kept: 0, answers: [] };
  const kept: Question[] = [];
  for (const [k, q] of f.questions.entries()) {
    const n = (s.check?.written ?? 0) + k + 1;
    const v = s.check && k < s.check.asked ? got.get(n) : undefined;
    const at = v?.verdict === "confirmed" ? s.placed?.get(n) : undefined;
    if (v?.verdict === "refuted") {
      finderQuestions.answered++;
      finderQuestions.answers.push({ text: q.text, answer: v.reason });
    } else if (v && at) {
      finderQuestions.findings++;
      const payload: FindingPayload = { ...at, verify: mark(v) };
      items.push(findingItem(payload));
    } else {
      finderQuestions.kept++;
      // A confirmed question without a place keeps the defect text of the check in why.
      kept.push(
        v?.verdict === "question" || v?.verdict === "confirmed"
          ? { text: (v.verdict === "question" && v.question.trim()) || q.text, why: v.reason.trim() || q.why }
          : q,
      );
    }
  }
  // docs/plans/review-v2/risk-check.md section 4.4: one outcome per finder risk. Risk k has number written + asked + k + 1.
  let finderRisks: FinderRisks | undefined;
  if (s.risks) {
    const written = s.check?.written ?? 0;
    const cands = new Map(
      f.candidates
        .slice(0, written)
        .map((c) => [c.n, { title: c.finding.title?.trim() || c.finding.body, verdict: got.get(c.n)?.verdict ?? "unchecked" }]),
    );
    finderRisks = { listed: f.summary.risks.length, found: 0, asked: 0, cleared: 0, covered: 0, open: 0, list: [] };
    for (const [k, text] of f.summary.risks.entries()) {
      const n = written + (s.check?.asked ?? 0) + k + 1;
      const fits = k < (s.check?.risks ?? 0);
      const r = riskOutcome(text, {
        verify: s.verify,
        fits,
        failed: failed !== undefined,
        ...(fits && { v: verdicts.get(n), at: s.placed?.get(n) }),
        cands,
      });
      finderRisks[r.outcome]++;
      finderRisks.list.push({ text, outcome: r.outcome, note: r.note });
      if (r.item) {
        // postable-risks.md section 4.1: the link from the draft to its entry. k indexes finderRisks.list of this run.
        const linked: FindingPayload = { ...r.item.finding, fromRisk: k };
        items.push(findingItem(linked));
      }
    }
  }
  // obligations.md section 4.5: one outcome per obligation of a finished check with the mode on. The blocks of candidates.md hold the
  // candidates, then the questions, then the risks.
  let obligations: Obligations | undefined;
  if (s.check && listed) {
    const { written, asked } = s.check;
    const blocks = new Map<number, string>([
      ...f.candidates.slice(0, written).map((c): [number, string] => [c.n, c.finding.title?.trim() || c.finding.body]),
      ...f.questions.slice(0, asked).map((q, k): [number, string] => [written + k + 1, q.text.trim()]),
      ...f.summary.risks.slice(0, s.check.risks ?? 0).map((r, k): [number, string] => [written + asked + k + 1, r.trim()]),
    ]);
    obligations = { listed: listed.length, met: 0, deferred: 0, covered: 0, found: 0, open: 0, list: [] };
    for (const [i, o] of listed.entries()) {
      const r = obligationOutcome(o, { cited: s.obligations?.cited.has(i) === true, at: s.obligations?.placed.get(i), blocks });
      obligations[r.outcome]++;
      obligations.list.push({ source: o.source, must: o.must, outcome: r.outcome, note: r.note });
      if (r.item) items.push(findingItem(r.item));
    }
  }
  if (failed && own) coverage.notChecked.push("Obligations: not checked: the check did not finish.");
  else if (failed) {
    verify.failed = failed;
    const line = `The check did not finish: ${findings(verify.unchecked)} not checked.${failed.text ? ` ${failed.text}` : ""}`;
    coverage.skipped.push(line);
    gaps.push(line);
  }
  const ending = ended(
    raw,
    f.outcome,
    {
      summary: {
        ...f.summary,
        coverage,
        volume: s.volume,
        verify,
        phases,
        finderQuestions,
        ...(finderRisks && { finderRisks }),
        ...(obligations && { obligations }),
      },
      items: [...items, ...kept.map(questionItem), ...asked.map(questionItem), ...f.replies.map(replyItem)],
      ...(f.checked && { checked: f.checked }),
      links,
      carried,
    },
    gaps,
  );
  return { ...ending, usage };
}

// spec.md section 1.9: the verdict of a carried finding on its copy. The user's triage stays: a copy that the user accepted, edited, or
// restored after a refutation gets the mark only.
export function markCopy(it: NewItem, m: CarriedMark): NewItem {
  if (!m.verify) return it;
  const p = JSON.parse(it.payload_json) as FindingPayload;
  const restored = (p.verify?.verdict === "refuted" || p.verify?.verdict === "duplicate") && p.discardedBy === undefined && !p.demoted;
  if (it.status !== "new" || it.edited === 1 || restored) return { ...it, payload_json: JSON.stringify({ ...p, verify: m.verify }) };
  const { finderSeverity, demoted: _, ...rest } = p;
  const finder = finderSeverity ?? p.severity;
  const next: FindingPayload = {
    ...rest,
    severity: m.severity,
    verify: m.verify,
    ...(m.severity !== finder && { finderSeverity: finder }),
    ...(m.discard && { discardedBy: "verify" as const }),
    ...(m.demoted && { demoted: true as const }),
  };
  return { ...it, payload_json: JSON.stringify(next), status: m.discard ? "discarded" : "new" };
}

// ---------- Explain this PR (docs/plans/review-v2/spec.md section 3.3) ----------

// The mdast fields that the checks read. react-markdown parses the walkthrough with the same remark-parse and remark-gfm.
type MdNode = {
  type: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  url?: string;
  identifier?: string;
  lang?: string | null;
  value?: string;
};

// diff:<path>#N<a>[-<b>] names lines at the head commit, #O lines at the merge base. The end can repeat the side letter.
const DIFF_LINK = /^diff:([^#]+)#([NO])(\d+)(?:-([NO])?(\d+))?$/;
const isDiffLink = (url: string | undefined) => /^diff:/i.test(url ?? "");

// A diff link must name a changed file and lines that its diff shows on that side, so the Files diff can open there.
export function diffLinkOk(href: string, files: readonly DiffFile[]): boolean {
  const m = DIFF_LINK.exec(href);
  if (!m || (m[4] !== undefined && m[4] !== m[2])) return false;
  let path: string;
  try {
    path = decodeURIComponent(m[1] as string);
  } catch {
    return false;
  }
  const head = m[2] === "N";
  const start = Number(m[3]);
  const end = m[5] === undefined ? start : Number(m[5]);
  const file = head
    ? files.find((f) => f.path === path)
    : (files.find((f) => f.oldPath === path) ?? files.find((f) => f.path === path && f.oldPath !== null));
  const lines = head ? file?.newLines : file?.oldLines;
  if (!lines || start < 1 || end < start || end - start >= lines.size) return false;
  for (let k = start; k <= end; k++) if (!lines.has(k)) return false;
  return true;
}

// One pass over the walkthrough. Edits work on the source text, so the rest of the Markdown keeps its bytes.
function walkthroughPass(text: string, files: readonly DiffFile[]): { text: string; badLinks: number } {
  const nodes: MdNode[] = [];
  const walk = (n: MdNode) => {
    nodes.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(unified().use(remarkParse).use(remarkGfm).parse(text) as unknown as MdNode);
  // mdast-util-to-hast resolves a reference with the first definition of its identifier.
  const defs = new Map<string, boolean>();
  for (const n of nodes)
    if (n.type === "definition" && n.identifier !== undefined && !defs.has(n.identifier))
      defs.set(n.identifier, !isDiffLink(n.url) || diffLinkOk(n.url ?? "", files));
  const edits: { start: number; end: number; text: string }[] = [];
  let badLinks = 0;
  let diagrams = 0;
  for (const n of nodes) {
    const start = n.position?.start.offset;
    const end = n.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const bad =
      (n.type === "link" && isDiffLink(n.url) && !diffLinkOk(n.url ?? "", files)) ||
      (n.type === "linkReference" && defs.get(n.identifier ?? "") === false);
    if (bad) {
      const a = n.children?.[0]?.position?.start.offset;
      const b = n.children?.at(-1)?.position?.end.offset;
      edits.push({ start, end, text: a === undefined || b === undefined ? "" : text.slice(a, b) });
      badLinks++;
    } else if (n.type === "code" && n.lang === "mermaid") {
      // Mermaid reads a %%{ directive anywhere in a line. Line 0 is the opening fence.
      const source = text.slice(start, end);
      const lines = source.split("\n").filter((l, i) => i === 0 || !l.includes("%%{"));
      const code = (n.value ?? "")
        .split("\n")
        .filter((l) => !l.includes("%%{"))
        .join("\n");
      if (diagrams < MAX_DIAGRAMS && code.length <= MAX_DIAGRAM_CHARS) diagrams++;
      else lines[0] = (lines[0] ?? "").replace(/^([ \t]*(?:`{3,}|~{3,}))[^\r]*/, "$1text");
      const out = lines.join("\n");
      if (out !== source) edits.push({ start, end, text: out });
    }
  }
  let out = text;
  for (const e of edits.sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, badLinks };
}

// spec.md section 3.3: a bad diff link becomes its label text. The first MAX_DIAGRAMS mermaid fences of up to MAX_DIAGRAM_CHARS stay,
// and the others become text fences. No line with %%{ stays in a mermaid fence. A label can hold a reference that becomes a link
// after the unwrap, so the passes repeat until none finds a bad link. Each such pass makes the text shorter.
export function checkWalkthrough(text: string, files: readonly DiffFile[]): { text: string; badLinks: number } {
  let r = walkthroughPass(text, files);
  let badLinks = r.badLinks;
  while (r.badLinks > 0) {
    r = walkthroughPass(r.text, files);
    badLinks += r.badLinks;
  }
  return { text: r.text, badLinks };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// spec.md sections 3.2 and 3.3: the run end of an explain run. Its questions become question items. It gives no finding.
export async function judgeExplain(o: RunOutcome, ws: Workspace, servers: string[], gaps: string[]): Promise<Ending> {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut(explainResult, o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "explain", raw, o);
  const r = parsed.data;
  const files = parseDiff(ws.diff);
  // The path of a changed file as the Files diff names it. null: the path is not in the change.
  const changed = (raw: string) => {
    const p = repoPath(raw);
    const f = p === null ? undefined : (files.find((x) => x.path === p) ?? files.find((x) => x.oldPath === p));
    return f ? ((f.path ?? f.oldPath) as string) : null;
  };
  const inChange = <T extends { path: string }>(list: T[]) =>
    list.flatMap((x) => {
      const path = changed(x.path);
      return path === null ? [] : [{ ...x, path }];
    });
  const order = inChange(r.order);
  const listed = inChange(r.files);
  type Risk = ExplainResult["risks"][number];
  const placeable = (x: Risk): x is Risk & { path: string; line: number } => x.path !== null && x.line !== null && changed(x.path) !== null;
  const { anchor } = anchorer({ diff: ws.diff, ...(await readBlobs(ws, r.risks.filter(placeable))) });
  const risks = r.risks.map((x): Risk => {
    const a = placeable(x) ? anchor(x) : null;
    // The link of a risk opens the Files diff, so its lines must be lines that the diff shows.
    return a !== null && typeof a !== "string" && a.state !== "outside"
      ? { ...x, path: a.path, line: a.line, lineEnd: a.lineEnd }
      : { ...x, path: null, line: null, lineEnd: null };
  });
  const walk = checkWalkthrough(r.walkthrough, files);
  const checks = [
    ...(walk.badLinks ? [`${count(walk.badLinks, "link", "links")} did not match the change.`] : []),
    ...(r.order.length > order.length
      ? [`${count(r.order.length - order.length, "path of the reading order is", "paths of the reading order are")} not in the change.`]
      : []),
    ...(r.files.length > listed.length
      ? [`${count(r.files.length - listed.length, "path of the file list is", "paths of the file list are")} not in the change.`]
      : []),
  ];
  const down = unavailable(o, servers, gaps);
  const coverage = {
    ...r.coverage,
    skipped: [...parsed.cuts, ...r.coverage.skipped, ...checks],
    unavailable: [...r.coverage.unavailable, ...down],
  };
  return ended(
    raw,
    o,
    {
      summary: { summary: r.summary, risks: [], coverage, dropped: [] },
      items: r.questions.map(questionItem),
      explain: { ...r, walkthrough: walk.text, order, files: listed, risks, coverage },
    },
    [...parsed.cuts, ...checks, ...down],
  );
}

// A cancel during the verify phase or the salvage run. The run keeps the log and the usage of both processes, and no item.
export function cancelledCheck(o: RunOutcome, check: RunOutcome, phase = "Check phase"): Ending {
  return {
    ...cancelledEnding(o),
    raw: cap(`${rawOutput(o)}\n# ${phase}\n\n${rawOutput(check)}`),
    usage: addUsage(usageOf(o), usageOf(check)),
  };
}

// spec.md section 1.6, salvage: the finder reached its turn cap, and no salvage result came. The run fails with the finder text and
// why. s: the salvage run, when it started.
export function salvageFailed(o: RunOutcome, why: string, s?: RunOutcome): Ending {
  return {
    status: "failed",
    kind: "max_turns",
    text: [o.text, why].filter((x) => x).join(" "),
    raw: cap(s ? `${rawOutput(o)}\n# Salvage phase\n\n${rawOutput(s)}` : rawOutput(o)),
    outcome: o,
    usage: addUsage(usageOf(o), s ? usageOf(s) : null),
  };
}

// The finder result of a salvage run: the raw output of both processes and the coverage line that names the turn cap.
export function salvaged(f: Found, o: RunOutcome, line: string): Found {
  const c = f.summary.coverage;
  return {
    ...f,
    raw: cap(`${rawOutput(o)}\n# Salvage phase\n\n${f.raw}`),
    summary: { ...f.summary, coverage: { ...c, notChecked: [line, ...c.notChecked] } },
  };
}

// docs/plans/review-v2/focused-passes.md section 4.4: one Found from the usable passes of a multi-pass review, in pass order. list: at
// least one entry. n: the pass count. gaps: the app lines of the failed and skipped passes. events: the events of all passes.
export function mergeFound(
  list: { k: number; lens: Lens; found: Found }[],
  n: number,
  extra: { gaps: string[]; events: RunEvent[] },
): Found {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const first = (list[0] as (typeof list)[number]).found;
  const findings = list.flatMap(({ k, found }) => found.candidates.map((c) => ({ ...c.finding, pass: k })));
  const groups = overlapGroups(findings.map((f) => ({ side: f.side, anchor: f.anchor })));
  const cov = list.map((x) => x.found.summary.coverage);
  return {
    raw: cap(list.map(({ k, lens, found }) => `# Pass ${k} of ${n} (${passLabel(lens)})\n\n${found.raw}`).join("\n")),
    outcome: { ...first.outcome, events: extra.events },
    summary: {
      summary: first.summary.summary,
      risks: uniq(list.flatMap((x) => x.found.summary.risks)),
      coverage: {
        read: uniq(cov.flatMap((c) => c.read)),
        skipped: uniq([...cov.flatMap((c) => c.skipped), ...extra.gaps]),
        unavailable: uniq(cov.flatMap((c) => c.unavailable)),
        notChecked: uniq(cov.flatMap((c) => c.notChecked)),
      },
      dropped: list.flatMap((x) => x.found.summary.dropped),
    },
    candidates: findings.map((finding, i) => ({ finding, from: null, n: i + 1, group: groups[i] ?? null })),
    questions: list.flatMap((x) => x.found.questions),
    replies: list.find((x) => x.k === 1)?.found.replies ?? [],
    gaps: uniq([...list.flatMap((x) => x.found.gaps), ...extra.gaps]),
  };
}

// docs/plans/review-v2/thorough-review.md D2 and D3: one Ending from the settled arms of a run of the variant "twice", in arm order.
// An arm is usable when it has a result. A shown finding of the second usable arm that repeats one of the first hides as a duplicate.
export function mergeRuns(arms: readonly Ending[], volume: Volume): Ending {
  const n = arms.length;
  const usage = arms.reduce<RunUsage | null>(
    (u, e) => addUsage(u, e.usage !== undefined ? e.usage : e.outcome ? usageOf(e.outcome) : null),
    null,
  );
  const events = arms.flatMap((e) => e.outcome?.events ?? []);
  const raw = cap(arms.map((e, i) => `# Run ${i + 1} of ${n}\n\n${e.raw}`).join("\n"));
  const usable = arms.flatMap((e, i) => (e.result && (e.status === "completed" || e.status === "incomplete") ? [{ k: i + 1, e }] : []));
  const head = usable[0];
  if (!head) {
    const a = arms[0] as Ending;
    return { ...a, raw, ...(a.outcome && { outcome: { ...a.outcome, events } }), usage };
  }
  const gaps = arms.flatMap((e, i) =>
    usable.some((u) => u.k === i + 1) ? [] : [`Run ${i + 1} of ${n} failed: ${e.kind ?? e.status}. Its findings are missing.`],
  );
  // Each arm numbers its candidates from 1. A later arm moves up by the numbers of the arms before it.
  type Shown = { k: number; at: number; p: FindingPayload };
  const items: NewItem[] = [];
  const links = new Map<NewItem, CandidateLink>();
  const shown: Shown[][] = [];
  let base = 0;
  let risksBefore = 0;
  for (const { k, e } of usable) {
    const r = e.result as NonNullable<Ending["result"]>;
    const own = r.links ?? new Map<NewItem, CandidateLink>();
    const list: Shown[] = [];
    let top = r.summary.verify?.candidates ?? 0;
    for (const it of r.items) {
      if (it.kind === "reply" && k !== head.k) continue;
      let next = it;
      if (it.kind === "finding") {
        const p = JSON.parse(it.payload_json) as FindingPayload;
        const q: FindingPayload = { ...p, pass: k, ...(p.fromRisk !== undefined && { fromRisk: p.fromRisk + risksBefore }) };
        next = { ...it, payload_json: JSON.stringify(q) };
        // D2: a demoted refuted finding has status new, but it takes no part.
        if (it.status === "new" && p.verify?.verdict !== "refuted") list.push({ k, at: items.length, p: q });
      }
      const l = own.get(it);
      if (l) {
        links.set(next, { n: l.n + base, duplicateOf: l.duplicateOf === null ? null : l.duplicateOf + base });
        top = Math.max(top, l.n, l.duplicateOf ?? 0);
      }
      items.push(next);
    }
    shown.push(list);
    base += top;
    risksBefore += r.summary.finderRisks?.list.length ?? 0;
  }
  // D2, the survivor: the main group, then the higher severity, then the better check, then the earlier arm.
  const rank = (p: FindingPayload) => [
    displayGroup(p, volume) === "main" ? 0 : 1,
    severities.indexOf(p.severity),
    CHECK_ORDER.indexOf(checkOf(p)),
  ];
  const better = (x: FindingPayload, y: FindingPayload) => {
    const a = rank(x);
    const b = rank(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number);
    return true;
  };
  const spot = (s: Shown) => {
    const it = items[s.at] as NewItem;
    return {
      path: it.path ?? "",
      side: s.p.side,
      line: it.line ?? 0,
      lineEnd: it.line_end,
      preexisting: s.p.preexisting,
      polish: s.p.polish,
    };
  };
  const [first = [], second = []] = shown;
  const pairs = copyPairs(first.map(spot), second.map(spot));
  const numberOf = (it: NewItem) => {
    const l = links.get(it);
    if (l) return l.n;
    links.set(it, { n: ++base, duplicateOf: null });
    return base;
  };
  for (const [i, j] of pairs) {
    const x = first[i] as Shown;
    const y = second[j] as Shown;
    const [keep, hide] = better(x.p, y.p) ? [x, y] : [y, x];
    const kept = items[keep.at] as NewItem;
    const old = items[hide.at] as NewItem;
    const target = numberOf(kept);
    const p = hide.p;
    const payload: FindingPayload = {
      ...p,
      ...(p.verify && { ownVerify: p.verify }),
      discardedBy: "verify",
      verify: {
        verdict: "duplicate",
        severity: p.severity,
        reason: `Run ${keep.k} of ${n} raised the same point.`,
        evidence: `${kept.path}:${kept.line}`,
        duplicateOf: null,
        by: "app",
      },
    };
    const copy: NewItem = { ...old, status: "discarded", payload_json: JSON.stringify(payload) };
    links.set(copy, { n: links.get(old)?.n ?? ++base, duplicateOf: target });
    links.delete(old);
    items[hide.at] = copy;
  }
  const summaries = usable.map((u) => (u.e.result as NonNullable<Ending["result"]>).summary);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const cov = summaries.map((s) => s.coverage);
  // The first present value with each count key added across the arms. undefined: no arm has it.
  const add = <T extends object>(list: (T | undefined)[], keys: readonly (keyof T)[]): T | undefined => {
    const got = list.filter((x): x is T => x !== undefined);
    if (!got.length) return undefined;
    const out = { ...(got[0] as T) };
    for (const key of keys) (out as Record<keyof T, unknown>)[key] = got.reduce((t: number, x) => t + Number(x[key]), 0);
    return out;
  };
  const verify = add(
    summaries.map((s) => s.verify),
    ["candidates", "confirmed", "refuted", "unsure", "questions", "duplicates", "unchecked"],
  );
  if (verify) {
    const failed = summaries.find((s) => s.verify?.failed)?.verify?.failed;
    delete verify.failed;
    if (failed) verify.failed = failed;
  }
  const finderQuestions = add(
    summaries.map((s) => s.finderQuestions),
    ["asked", "answered", "findings", "kept"],
  );
  if (finderQuestions) finderQuestions.answers = summaries.flatMap((s) => s.finderQuestions?.answers ?? []);
  const finderRisks = add(
    summaries.map((s) => s.finderRisks),
    ["listed", ...riskOutcomes],
  );
  if (finderRisks) finderRisks.list = summaries.flatMap((s) => s.finderRisks?.list ?? []);
  const obligations = add(
    summaries.map((s) => s.obligations),
    ["listed", ...obligationOutcomes],
  );
  if (obligations) obligations.list = summaries.flatMap((s) => s.obligations?.list ?? []);
  const phase = (name: RunPhase["name"]): RunPhase[] => {
    const list = summaries.flatMap((s) => s.phases?.filter((p) => p.name === name) ?? []);
    if (!list.length) return [];
    const ends = list.map((p) => p.endedAt);
    return [
      {
        name,
        startedAt: Math.min(...list.map((p) => p.startedAt)),
        endedAt: ends.includes(null) ? null : Math.max(...(ends as number[])),
        usage: list.reduce<RunUsage | null>((u, p) => addUsage(u, p.usage), null),
      },
    ];
  };
  const phases = [...phase("find"), ...phase("check")];
  const lead = summaries[0] as RunSummary;
  const summary: RunSummary = {
    summary: lead.summary,
    risks: summaries.flatMap((s) => s.risks),
    coverage: {
      read: uniq(cov.flatMap((c) => c.read)),
      skipped: uniq([...cov.flatMap((c) => c.skipped), ...gaps]),
      unavailable: uniq(cov.flatMap((c) => c.unavailable)),
      notChecked: uniq(cov.flatMap((c) => c.notChecked)),
    },
    dropped: summaries.flatMap((s) => s.dropped),
    volume,
    ...(verify && { verify }),
    ...(phases.length > 0 && { phases }),
    ...(finderQuestions && { finderQuestions }),
    ...(finderRisks && { finderRisks }),
    ...(obligations && { obligations }),
    runs: { count: 2, copies: pairs.length },
  };
  const incomplete = gaps.length > 0 || usable.some((u) => u.e.status === "incomplete");
  return {
    status: incomplete ? "incomplete" : "completed",
    kind: null,
    text: null,
    raw,
    ...(head.e.outcome && { outcome: { ...head.e.outcome, events } }),
    usage,
    result: { summary, items, links },
  };
}

// live: the threads of the PR with a live message at the run end, for the cite check.
export function judgeReplies(o: RunOutcome, threads: ReplyThread[], servers: string[], gaps: string[], live: ReadonlySet<number>): Ending {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut(replyResult, o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "reply", raw, o);
  const v = validateReplies(parsed.data, threads, live);
  const down = unavailable(o, servers, gaps);
  const coverage = {
    ...v.coverage,
    skipped: [...parsed.cuts, ...v.coverage.skipped],
    unavailable: [...v.coverage.unavailable, ...down],
  };
  return ended(
    raw,
    o,
    {
      summary: { summary: v.summary, risks: [], coverage, dropped: [] },
      items: v.replies.map(replyItem),
      notes: parsed.data.notes,
    },
    [...parsed.cuts, ...v.added, ...down],
  );
}

const firstLine = (s: string) =>
  s
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

// docs/plans/review-v2/spec.md section 2.4: a discuss run stores its answer. jobs.ts end() checks the finding and applies the verdict
// in the transaction of the run end. A revision counts only with the verdict revised.
export function judgeDiscuss(o: RunOutcome, servers: string[], gaps: string[]): Ending {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut(discussResult, o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "discuss", raw, o);
  const r = parsed.data;
  const down = unavailable(o, servers, gaps);
  const coverage = {
    ...r.coverage,
    skipped: [...parsed.cuts, ...r.coverage.skipped],
    unavailable: [...r.coverage.unavailable, ...down],
  };
  return ended(
    raw,
    o,
    {
      summary: { summary: firstLine(r.answer), risks: [], coverage, dropped: [] },
      items: [],
      answer: r.answer,
      notes: r.notes,
      discuss: { ...r, revision: r.verdict === "revised" ? r.revision : null },
    },
    [...parsed.cuts, ...down],
  );
}

// docs/plans/review-v2/spec.md section 6.5: an interview or spec run makes no items. check: the app checks of the parsed result. It
// gives the result to store and the coverage lines that it skipped. answer: the text for the answer column of the run.
export async function judgeTask<T extends { summary?: string; title?: string; coverage: RunSummary["coverage"] }>(
  o: RunOutcome,
  schema: ZodType<T>,
  what: string,
  servers: string[],
  gaps: string[],
  check: (r: T) => Promise<{ result: T; skipped: string[]; answer?: string }>,
): Promise<Ending> {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut(schema, o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, what, raw, o);
  const c = await check(parsed.data);
  const cov = c.result.coverage;
  const down = unavailable(o, servers, gaps);
  const coverage = {
    ...cov,
    skipped: [...parsed.cuts, ...cov.skipped, ...c.skipped],
    unavailable: [...cov.unavailable, ...down],
  };
  return ended(
    raw,
    o,
    {
      summary: { summary: firstLine(c.result.summary ?? c.result.title ?? ""), risks: [], coverage, dropped: [] },
      items: [],
      ...(c.answer !== undefined && { answer: c.answer }),
      task: { ...c.result, coverage },
    },
    [...parsed.cuts, ...c.skipped, ...down],
  );
}

// Plan r2 S-ASK: an ask run makes no items, so nothing of it can post.
export function judgeAsk(o: RunOutcome, servers: string[], gaps: string[]): Ending {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut(askResult, o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "ask", raw, o);
  const { answer, coverage } = parsed.data;
  const summary = firstLine(answer);
  const down = unavailable(o, servers, gaps);
  return ended(
    raw,
    o,
    {
      summary: {
        summary,
        risks: [],
        coverage: {
          ...coverage,
          skipped: [...parsed.cuts, ...coverage.skipped],
          unavailable: [...coverage.unavailable, ...down],
        },
        dropped: [],
      },
      items: [],
      answer,
    },
    [...parsed.cuts, ...down],
  );
}

// docs/plans/session-consult.md part C: a session run makes no items. Its entries go to answer. The answer preview checks each
// entry again, and nothing changes before the user clicks Apply.
// Part D: fix holds the workspace and the items that need a verdict. validateFix keeps only the edits for accepted items. The notes
// go to fix_json and the edits to fix_edit of the session run. Only an import copies them into a fix run, so no fix card shows before.
export async function judgeSession(o: RunOutcome, fix: { ws: Workspace; asked: string[] } | null): Promise<Ending> {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut(consultOutput, o.result?.structured_output, consultCaps);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "session answer", raw, o);
  const n = parsed.data.answers.length;
  const answers = `${n} ${n === 1 ? "answer" : "answers"}`;
  const none = { read: [], skipped: parsed.cuts, unavailable: [], notChecked: [] };
  const result = (
    summary: string,
    coverage: RunSummary["coverage"],
    gaps: readonly string[],
    edits?: { threads: FixNote[]; edits: ValidEdit[] },
  ) =>
    ended(
      raw,
      o,
      {
        summary: { summary, risks: [], coverage, dropped: [] },
        items: [],
        answer: JSON.stringify(parsed.data.answers),
        ...(edits && { fix: edits }),
      },
      gaps,
    );
  if (!fix) return result(answers, none, parsed.cuts);
  const proposal = fixResult.safeParse(parsed.data.fix);
  if (!proposal.success) {
    const issues = issuesText(proposal.error.issues);
    const skipped = [...parsed.cuts, `The fix does not match the fix schema, so the run keeps no edit. ${issues}`];
    return result(answers, { ...none, skipped }, skipped);
  }
  const files = await readFixFiles(
    fix.ws,
    proposal.data.edits.map((e) => e.path),
  );
  const v = validateFix(proposal.data, acceptedTargets(parsed.data.answers, fix.asked), files);
  const m = v.edits.length;
  const coverage = { ...v.coverage, skipped: [...parsed.cuts, ...v.coverage.skipped] };
  return result(`${answers}, ${m} ${m === 1 ? "edit" : "edits"}`, coverage, [...parsed.cuts, ...v.added], {
    threads: v.threads,
    edits: v.edits,
  });
}

export const cancelledEnding = (o?: RunOutcome): Ending => ({
  status: "cancelled",
  kind: null,
  text: null,
  raw: o ? rawOutput(o) : "Cancelled before the runner started.",
  outcome: o,
});

// The edit paths at the source head, read from the cache clone, never from the sanitized worktree.
// The full tree listing needs no pathspec, so no path text can act as pathspec magic.
async function readFixFiles(ws: Workspace, paths: string[]): Promise<Map<string, FixFile>> {
  const env = gitEnv("/dev/null");
  const listing = await git([`--git-dir=${ws.cache}`, "ls-tree", "-r", "-t", "-l", "-z", "--full-tree", ws.sourceHead], { env });
  // ls-tree -l: "<mode> <type> <object> <padded size>\t<path>". The size of a tree or a gitlink is "-".
  const tree = new Map<string, { mode: string; type: string; object: string; size: number }>();
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", type = "", object = "", size = ""] = entry.slice(0, tab).split(/ +/);
    tree.set(entry.slice(tab + 1), { mode, type, object, size: Number(size) });
  }
  const files = new Map<string, FixFile>();
  for (const raw of paths) {
    const path = repoPath(raw);
    if (path === null || files.has(path)) continue;
    const parts = path.split("/");
    const underFile = parts.slice(0, -1).some((_, i) => {
      const t = tree.get(parts.slice(0, i + 1).join("/"));
      return t !== undefined && t.type !== "tree";
    });
    const t = tree.get(path);
    if (underFile || t?.type === "tree") files.set(path, "blocked");
    else if (t?.type === "commit") files.set(path, { mode: t.mode, bytes: new Uint8Array() });
    else if (t) files.set(path, t.size > MAX_FILE_CHARS ? "size" : { mode: t.mode, bytes: await blobBytes(ws.cache, env, t.object) });
  }
  return files;
}

// docs/plans/thread-outcome.md: the unaccepted reply draft of a thread note without a fix. "already" proposes to resolve the thread.
// As in validateReplies, only a thread that the user started gets the tick.
function nofixItem(n: FixNote, t: ReplyThread, body: string): NewItem {
  const already = n.why === "already";
  const payload: ReplyPayload = {
    thread: t.thread,
    action: "reply",
    body,
    reason: n.reason,
    evidenceStatus: "unverified",
    judgement: null,
    replyTo: t.replyTo,
    resolve: already,
    resolveEvidence: already ? n.reason.trim() : "",
    resolveTick: already && !!t.mine,
    origin: "nofix",
  };
  return replyItem({ payload, status: "new" });
}

// Plan r3 S-FIX: the notes of a fix run go to fix_json and its edits to fix_edit. Its only items are the nofix reply drafts.
export async function judgeFix(
  o: RunOutcome,
  ws: Workspace,
  threads: ReplyThread[],
  findings: number[],
  servers: string[],
  gaps: string[],
): Promise<Ending> {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = parseCut(fixResult, o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "fix", raw, o);
  const files = await readFixFiles(
    ws,
    parsed.data.edits.map((e) => e.path),
  );
  const v = validateFix(parsed.data, { threads: threads.map((t) => t.thread), findings }, files);
  const skipped = [...parsed.cuts, ...v.coverage.skipped];
  const added = [...parsed.cuts, ...v.added];
  const items = v.threads.flatMap((n): NewItem[] => {
    const t = threads.find((x) => x.thread === n.thread);
    const body = n.reply.trim();
    if (!t || n.fixed || !NOFIX_DRAFT.has(n.why) || !body) return [];
    if (body.length <= MAX_NOTE) return [nofixItem(n, t, body)];
    const line = `Reply for thread ${t.thread} dropped: the body is longer than ${MAX_NOTE} characters.`;
    skipped.push(line);
    added.push(line);
    return [];
  });
  const down = unavailable(o, servers, gaps);
  const coverage = { ...v.coverage, skipped, unavailable: [...v.coverage.unavailable, ...down] };
  return ended(
    raw,
    o,
    {
      summary: { summary: v.summary, risks: [], coverage, dropped: [] },
      items,
      fix: { threads: v.threads, edits: v.edits },
    },
    [...added, ...down],
  );
}
