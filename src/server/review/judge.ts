// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The run end (jobs.ts): turns a runner outcome into the stored status, summary, items, answer, or fix notes and edits.
// A review run ends in two steps: judge() validates the finder result, and settle() merges the verdicts of the verify phase.
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { ZodType } from "zod";
import { acceptedTargets, consultOutput } from "../../shared/consult";
import { MAX_NOTE, type RunPhase, type RunSummary, type RunUsage, type VerifySummary, type Volume } from "../../shared/dto";
import {
  type AnchoredFinding,
  askResult,
  type Check,
  type DiscussResult,
  discussResult,
  type ExplainResult,
  explainResult,
  type FindingPayload,
  type FixNote,
  type FixWhy,
  fixResult,
  MAX_DIAGRAM_CHARS,
  MAX_DIAGRAMS,
  type NoteProposal,
  type Question,
  type ReplyPayload,
  type RereviewResult,
  replyResult,
  rereviewResult,
  reviewResult,
  type Severity,
  type StoredFinding,
  type VerifyMark,
  type VerifyVerdict,
  type VerifyVerdictName,
  verifyResult,
} from "../../shared/review";
import type { RunErrorKind, RunStatus } from "../../shared/run-log";
import type { Profile } from "./catalog";
import type { RunOutcome } from "./claude";
import type { Candidate } from "./context-files";
import { type DiffFile, parseDiff } from "./diffmap";
import { type FixFile, type ValidEdit, validateFix } from "./fix";
import { git, gitEnv } from "./git";
import type { ReplyThread } from "./prompt";
import type { Carry } from "./rereview";
import { type NewItem, NO_ANCHOR } from "./run-rows";
import {
  type AskedThread,
  anchorer,
  type CheckedEarlier,
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
export type CarriedMark = CandidateLink & { verify?: VerifyMark; severity: Severity; discard: boolean };

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

function ended(raw: string, o: RunOutcome, result: NonNullable<Ending["result"]>): Ending {
  const c = result.summary.coverage;
  return { status: c.skipped.length || c.unavailable.length ? "incomplete" : "completed", kind: null, text: null, raw, outcome: o, result };
}

type Placed = Pick<StoredFinding, "path" | "side">;

// Reads the finding files from the cache clone, never from the sanitized worktree. The lookup matches validate().
async function readBlobs(ws: Workspace, findings: Placed[]) {
  const byNew = new Map<string, DiffFile>();
  const byOld = new Map<string, DiffFile>();
  for (const f of parseDiff(ws.diff)) {
    if (f.path !== null) byNew.set(f.path, f);
    if (f.oldPath !== null) byOld.set(f.oldPath, f);
  }
  const newFiles = new Map<string, string>();
  const oldFiles = new Map<string, string>();
  const big = new Set<string>();
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
  for (const f of findings) {
    const b = blobOf(f);
    if (!b || b.map.has(b.path) || big.has(b.object)) continue;
    try {
      if (Number((await g(["cat-file", "-s", b.object])).trim()) > MAX_FILE_CHARS) big.add(b.object);
      else b.map.set(b.path, await g(["cat-file", "blob", b.object]));
    } catch {
      // No such file on that side. The validator drops the finding with reason "file".
    }
  }
  const oversized = (f: Placed) => {
    const b = blobOf(f);
    return b !== null && big.has(b.object);
  };
  return { newFiles, oldFiles, oversized };
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
};

// Validates the finder result of a review run. servers: the MCP servers of the spec. gaps: the servers and skills left out of the spec.
// rereview: the earlier findings of a re-review at their current lines. asked: the threads of context/questions.md.
// rules: the project instruction files of the run. An Ending: the finder failed.
export async function judge(
  o: RunOutcome,
  ws: Workspace,
  profile: Profile,
  servers: string[],
  gaps: string[],
  rereview: { carry: Carry; items: EarlierItem[] } | null,
  asked: AskedThread[],
  rules: readonly RuleSource[] = [],
): Promise<Ending | Found> {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = rereview ? rereviewResult.safeParse(o.result?.structured_output) : reviewResult.safeParse(o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, rereview ? "re-review" : "review", raw, o);
  const earlier = rereview ? (parsed.data as RereviewResult).earlier : [];
  const items = rereview?.items ?? [];
  // Only a finished Agent call returned a report.
  const agents = o.events.filter((e) => e.tool === "Agent" && e.agent !== null && e.status === "ok").map((e) => e.agent as string);
  const causes = parsed.data.findings.flatMap((f) => (f.cause ? [{ ...f, ...f.cause }] : []));
  const blobs = await readBlobs(ws, [...parsed.data.findings, ...causes, ...earlierCases(earlier, items).cases.map((c) => c.finding)]);
  const v = validate({ result: parsed.data, diff: ws.diff, ...blobs, agents, explain: profile.explain, rules });
  const e = rereview ? validateEarlier({ earlier, items, diff: ws.diff, ...blobs }) : null;
  const a = profile.explain ? null : validateAnswered(parsed.data.answered, asked, v.kept);
  const dropped = v.dropped.map((d) => (d.reason === "file" && blobs.oversized(d) ? { ...d, reason: "size" as const } : d));
  const base = rereview?.carry.incomplete ? [`Run ${rereview.carry.base}, the base of this re-review, was incomplete.`] : [];
  const coverage = {
    ...v.coverage,
    skipped: [...v.coverage.skipped, ...(e?.skipped ?? []), ...(a?.skipped ?? [])],
    unavailable: [...v.coverage.unavailable, ...unavailable(o, servers, gaps)],
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
  };
}

export const usageOf = (o: RunOutcome): RunUsage | null => {
  const r = o.result;
  return r ? { costUsd: r.total_cost_usd, turns: r.num_turns, durationMs: r.duration_ms, tokens: r.usage } : null;
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
  return { costUsd: a.costUsd + b.costUsd, turns: a.turns + b.turns, durationMs: a.durationMs + b.durationMs, tokens };
}

// The verify process of a review run (spec.md section 1.6). written: the candidates in candidates.md, from candidate 1.
export type CheckRun = { o: RunOutcome; startedAt: number; endedAt: number; written: number };

// One verdict per candidate in candidates.md. An unknown or a second verdict goes to skipped. A candidate without a verdict stays
// unchecked, and its line in skipped makes the run incomplete (spec.md section 1.9).
export function verdictsOf(list: readonly VerifyVerdict[], written: number) {
  const verdicts = new Map<number, VerifyVerdict>();
  const skipped: string[] = [];
  for (const v of list) {
    if (v.candidate > written) skipped.push(`Verdict for candidate ${v.candidate} dropped: ./context/candidates.md has no such candidate.`);
    else if (verdicts.has(v.candidate)) skipped.push(`Verdict for candidate ${v.candidate} dropped: a second verdict for the candidate.`);
    else verdicts.set(v.candidate, v);
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
  | { kind: "finding"; status: "new" | "discarded"; severity: Severity; check: Check };

// spec.md section 1.7, the caps: structured fields only, never the text. v undefined: the phase is off, failed, or skipped the
// candidate. carried: a carried finding keeps its kind, so a question verdict reads as unsure and an empty trigger makes no question.
export function capOf(
  c: Pick<StoredFinding, "severity" | "trigger" | "evidenceStatus" | "title" | "body">,
  v: Pick<VerifyVerdict, "verdict" | "severity" | "reason" | "question"> | undefined,
  carried = false,
): Capped {
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
};

// The run end of a review run: the verdicts and the caps of each candidate, the items, and the summary (spec.md sections 1.7 and 1.8).
export function settle(f: Found, s: SettleInput): Ending {
  const coverage = {
    read: [...f.summary.coverage.read],
    skipped: [...f.summary.coverage.skipped],
    unavailable: [...f.summary.coverage.unavailable],
    notChecked: [...f.summary.coverage.notChecked],
  };
  const phases: RunPhase[] = [s.find];
  let usage = s.find.usage;
  let raw = f.raw;
  let got = new Map<number, VerifyVerdict>();
  let failed: VerifySummary["failed"];
  if (s.check) {
    const o = s.check.o;
    raw = cap(`${raw}\n# Check phase\n\n${rawOutput(o)}`);
    phases.push({ name: "check", startedAt: s.check.startedAt, endedAt: s.check.endedAt, usage: usageOf(o) });
    usage = addUsage(usage, usageOf(o));
    const parsed = o.status === "completed" ? verifyResult.safeParse(o.result?.structured_output) : null;
    if (!parsed) failed = { kind: o.kind, text: o.text };
    else if (!parsed.success)
      failed = { kind: "schema", text: `The result does not match the verify schema. ${issuesText(parsed.error.issues)}` };
    else {
      const v = verdictsOf(parsed.data.verdicts, s.check.written);
      got = effectiveVerdicts(f.candidates.slice(0, s.check.written), v.verdicts);
      const c = parsed.data.coverage;
      coverage.skipped.push(...v.skipped);
      coverage.read = union(coverage.read, c.read);
      coverage.notChecked.push(...[...c.skipped, ...c.notChecked, ...c.unavailable].map((x) => `Check: ${x}`));
    }
    coverage.unavailable = union(coverage.unavailable, unavailable(o, s.servers, []));
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
  const mark = (v: VerifyVerdict): VerifyMark => ({
    verdict: v.verdict,
    severity: v.severity,
    reason: v.reason,
    evidence: v.evidence,
    duplicateOf: null,
    by: "rl-verify",
  });
  for (const c of f.candidates) {
    const v = got.get(c.n);
    if (v) verify[COUNT[v.verdict]]++;
    else verify.unchecked++;
    const out = capOf(c.finding, v, c.from !== null);
    const link = { n: c.n, duplicateOf: v?.verdict === "duplicate" ? v.duplicateOf : null };
    if (out.kind === "question") {
      asked.push(out.question);
      continue;
    }
    if (c.from !== null) {
      carried.set(c.from, { ...link, ...(v && { verify: mark(v) }), severity: out.severity, discard: out.status === "discarded" });
      continue;
    }
    const payload: FindingPayload = {
      ...c.finding,
      severity: out.severity,
      ...(v && { verify: mark(v) }),
      ...(out.severity !== c.finding.severity && { finderSeverity: c.finding.severity }),
      ...(out.status === "discarded" && { discardedBy: "verify" as const }),
    };
    const item = findingItem(payload, out.status);
    links.set(item, link);
    items.push(item);
  }
  if (failed) {
    verify.failed = failed;
    coverage.skipped.push(`The check did not finish: ${findings(verify.unchecked)} not checked.${failed.text ? ` ${failed.text}` : ""}`);
  }
  const ending = ended(raw, f.outcome, {
    summary: { ...f.summary, coverage, volume: s.volume, verify, phases },
    items: [...items, ...f.questions.map(questionItem), ...asked.map(questionItem), ...f.replies.map(replyItem)],
    ...(f.checked && { checked: f.checked }),
    links,
    carried,
  });
  return { ...ending, usage };
}

// spec.md section 1.9: the verdict of a carried finding on its copy. The user's triage stays: a copy that the user accepted, edited, or
// restored after a refutation gets the mark only.
export function markCopy(it: NewItem, m: CarriedMark): NewItem {
  if (!m.verify) return it;
  const p = JSON.parse(it.payload_json) as FindingPayload;
  const restored = (p.verify?.verdict === "refuted" || p.verify?.verdict === "duplicate") && p.discardedBy === undefined;
  if (it.status !== "new" || it.edited === 1 || restored) return { ...it, payload_json: JSON.stringify({ ...p, verify: m.verify }) };
  const { finderSeverity, ...rest } = p;
  const finder = finderSeverity ?? p.severity;
  const next: FindingPayload = {
    ...rest,
    severity: m.severity,
    verify: m.verify,
    ...(m.severity !== finder && { finderSeverity: finder }),
    ...(m.discard && { discardedBy: "verify" as const }),
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
  const parsed = explainResult.safeParse(o.result?.structured_output);
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
  const coverage = {
    ...r.coverage,
    skipped: [
      ...r.coverage.skipped,
      ...(walk.badLinks ? [`${count(walk.badLinks, "link", "links")} did not match the change.`] : []),
      ...(r.order.length > order.length
        ? [`${count(r.order.length - order.length, "path of the reading order is", "paths of the reading order are")} not in the change.`]
        : []),
      ...(r.files.length > listed.length
        ? [`${count(r.files.length - listed.length, "path of the file list is", "paths of the file list are")} not in the change.`]
        : []),
    ],
    unavailable: [...r.coverage.unavailable, ...unavailable(o, servers, gaps)],
  };
  return ended(raw, o, {
    summary: { summary: r.summary, risks: [], coverage, dropped: [] },
    items: r.questions.map(questionItem),
    explain: { ...r, walkthrough: walk.text, order, files: listed, risks, coverage },
  });
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

// live: the threads of the PR with a live message at the run end, for the cite check.
export function judgeReplies(o: RunOutcome, threads: ReplyThread[], servers: string[], gaps: string[], live: ReadonlySet<number>): Ending {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = replyResult.safeParse(o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "reply", raw, o);
  const v = validateReplies(parsed.data, threads, live);
  const coverage = { ...v.coverage, unavailable: [...v.coverage.unavailable, ...unavailable(o, servers, gaps)] };
  return ended(raw, o, {
    summary: { summary: v.summary, risks: [], coverage, dropped: [] },
    items: v.replies.map(replyItem),
    notes: parsed.data.notes,
  });
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
  const parsed = discussResult.safeParse(o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "discuss", raw, o);
  const r = parsed.data;
  const coverage = { ...r.coverage, unavailable: [...r.coverage.unavailable, ...unavailable(o, servers, gaps)] };
  return ended(raw, o, {
    summary: { summary: firstLine(r.answer), risks: [], coverage, dropped: [] },
    items: [],
    answer: r.answer,
    notes: r.notes,
    discuss: { ...r, revision: r.verdict === "revised" ? r.revision : null },
  });
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
  const parsed = schema.safeParse(o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, what, raw, o);
  const c = await check(parsed.data);
  const cov = c.result.coverage;
  const coverage = { ...cov, skipped: [...cov.skipped, ...c.skipped], unavailable: [...cov.unavailable, ...unavailable(o, servers, gaps)] };
  return ended(raw, o, {
    summary: { summary: firstLine(c.result.summary ?? c.result.title ?? ""), risks: [], coverage, dropped: [] },
    items: [],
    ...(c.answer !== undefined && { answer: c.answer }),
    task: { ...c.result, coverage },
  });
}

// Plan r2 S-ASK: an ask run makes no items, so nothing of it can post.
export function judgeAsk(o: RunOutcome, servers: string[], gaps: string[]): Ending {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = askResult.safeParse(o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "ask", raw, o);
  const { answer, coverage } = parsed.data;
  const summary = firstLine(answer);
  return ended(raw, o, {
    summary: {
      summary,
      risks: [],
      coverage: { ...coverage, unavailable: [...coverage.unavailable, ...unavailable(o, servers, gaps)] },
      dropped: [],
    },
    items: [],
    answer,
  });
}

// docs/plans/session-consult.md part C: a session run makes no items. Its entries go to answer. The answer preview checks each
// entry again, and nothing changes before the user clicks Apply.
// Part D: fix holds the workspace and the items that need a verdict. validateFix keeps only the edits for accepted items. The notes
// go to fix_json and the edits to fix_edit of the session run. Only an import copies them into a fix run, so no fix card shows before.
export async function judgeSession(o: RunOutcome, fix: { ws: Workspace; asked: string[] } | null): Promise<Ending> {
  const raw = rawOutput(o);
  if (o.status !== "completed") return { status: o.status, kind: o.kind, text: o.text, raw, outcome: o };
  const parsed = consultOutput.safeParse(o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "session answer", raw, o);
  const n = parsed.data.answers.length;
  const answers = `${n} ${n === 1 ? "answer" : "answers"}`;
  const none = { read: [], skipped: [], unavailable: [], notChecked: [] };
  const result = (summary: string, coverage: RunSummary["coverage"], edits?: { threads: FixNote[]; edits: ValidEdit[] }) =>
    ended(raw, o, {
      summary: { summary, risks: [], coverage, dropped: [] },
      items: [],
      answer: JSON.stringify(parsed.data.answers),
      ...(edits && { fix: edits }),
    });
  if (!fix) return result(answers, none);
  const proposal = fixResult.safeParse(parsed.data.fix);
  if (!proposal.success) {
    const issues = issuesText(proposal.error.issues);
    return result(answers, { ...none, skipped: [`The fix does not match the fix schema, so the run keeps no edit. ${issues}`] });
  }
  const files = await readFixFiles(
    fix.ws,
    proposal.data.edits.map((e) => e.path),
  );
  const v = validateFix(proposal.data, acceptedTargets(parsed.data.answers, fix.asked), files);
  const m = v.edits.length;
  return result(`${answers}, ${m} ${m === 1 ? "edit" : "edits"}`, v.coverage, { threads: v.threads, edits: v.edits });
}

export const cancelledEnding = (o?: RunOutcome): Ending => ({
  status: "cancelled",
  kind: null,
  text: null,
  raw: o ? rawOutput(o) : "Cancelled before the runner started.",
  outcome: o,
});

const BLOB_TIMEOUT_MS = 60_000;

// git() decodes stdout as text. That drops a BOM and hides invalid UTF-8, so the edit rules read the blob bytes here.
async function blobBytes(cache: string, env: Record<string, string>, object: string): Promise<Uint8Array> {
  const p = Bun.spawn(["git", `--git-dir=${cache}`, "cat-file", "blob", object], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: BLOB_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [bytes, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git cat-file failed (exit ${code ?? p.signalCode}): ${err.trim().slice(-2000)}`);
  return bytes;
}

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
  const parsed = fixResult.safeParse(o.result?.structured_output);
  if (!parsed.success) return schemaFailure(parsed.error.issues, "fix", raw, o);
  const files = await readFixFiles(
    ws,
    parsed.data.edits.map((e) => e.path),
  );
  const v = validateFix(parsed.data, { threads: threads.map((t) => t.thread), findings }, files);
  const skipped = [...v.coverage.skipped];
  const items = v.threads.flatMap((n): NewItem[] => {
    const t = threads.find((x) => x.thread === n.thread);
    const body = n.reply.trim();
    if (!t || n.fixed || !NOFIX_DRAFT.has(n.why) || !body) return [];
    if (body.length <= MAX_NOTE) return [nofixItem(n, t, body)];
    skipped.push(`Reply for thread ${t.thread} dropped: the body is longer than ${MAX_NOTE} characters.`);
    return [];
  });
  const coverage = { ...v.coverage, skipped, unavailable: [...v.coverage.unavailable, ...unavailable(o, servers, gaps)] };
  return ended(raw, o, {
    summary: { summary: v.summary, risks: [], coverage, dropped: [] },
    items,
    fix: { threads: v.threads, edits: v.edits },
  });
}
