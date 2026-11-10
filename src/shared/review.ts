// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review and reply results (plan v3 WP9, replies.md WP17). zod parses the CLI output. reviewJsonSchema() and replyJsonSchema() feed --json-schema.
import { z } from "zod";
import type { Volume } from "./dto";

export const severities = ["blocker", "major", "minor", "nit"] as const;
export const evidenceStatuses = ["code", "reproduced", "unverified"] as const;
export const confidences = ["high", "medium", "low"] as const;
export const MAX_FINDINGS = 100;

const lineNo = z.number().int().min(1);

// Raise it with each change of the review agent prompts. A run row with prompt_version NULL reads as "1".
// "2.0": the finder prompts of review v2 without the verify phase. "2.1": with the verify phase. "2.2": with the PR context rules.
// "2.3": the Build section of pr-context.md stays out of coverage, and a rule finding out of its scope stays as core.
// "2.4": the category classes that the check never hides, and the skip list of each language checklist.
export const REVIEW_PROMPT_VERSION = "2.4";

const place = {
  path: z.string().describe("File path relative to the repository root, with / separators."),
  side: z.enum(["new", "old"]).describe("new: the line exists at the head commit. old: a removed line, numbered at the base commit."),
  line: lineNo.describe("First line of the range on that side."),
  lineEnd: lineNo.nullable().describe("Last line of the range, or null for one line."),
  anchorText: z.string().describe("Code copied verbatim from the lines line..lineEnd. It anchors the finding."),
};

export const finding = z.object({
  ...place,
  severity: z.enum(severities),
  category: z.string(),
  body: z.string(),
  evidence: z.string(),
  evidenceStatus: z.enum(evidenceStatuses),
  confidence: z.enum(confidences),
  agent: z.string().nullable().describe("Name of the subagent that found it, or null for the main agent."),
  // docs/plans/review-v2/spec.md section 1.5. The defaults keep results stored before these keys valid. --json-schema still lists them as required.
  title: z.string().max(200).default("").describe("The problem in one line of 12 words or fewer."),
  trigger: z
    .string()
    .max(2000)
    .default("")
    .describe("A concrete case: the input or state, the path through the code, and the wrong result. Empty when you cannot name one."),
  cause: z
    .object(place)
    .nullable()
    .default(null)
    .describe("The changed line that adds the problem, when the anchor is on unchanged code. null when the anchor is on a changed line."),
  rule: z.string().max(2000).default("").describe("The exact sentence of the project rule, for a rule finding. Else empty."),
  module: z.string().max(40).default("core").describe("core, or the ID of the check section that found it."),
});

export const question = z.object({ text: z.string(), why: z.string() });

export const coverage = z.object({
  read: z.array(z.string()),
  skipped: z.array(z.string()),
  unavailable: z.array(z.string()),
  notChecked: z.array(z.string()),
});

// docs/plans/thread-outcome.md section 9: the outcome of a question that the user posted and another person answered.
export const answerOutcomes = ["settled", "followup", "issue"] as const;
export type AnswerOutcome = (typeof answerOutcomes)[number];
export const MAX_ANSWERED = 100;

export const answeredQuestion = z.object({
  thread: lineNo.describe("A thread number from ./context/questions.md."),
  // The defaults keep entries without these keys valid. --json-schema still lists them as required.
  question: lineNo
    .nullable()
    .default(null)
    .describe("The question number in that thread from ./context/questions.md. null for a thread with one question."),
  outcome: z
    .enum(answerOutcomes)
    .describe(
      "settled: the answer settles the question. followup: the answer is partial or unclear. issue: the answer shows a real problem.",
    ),
  evidence: z.string().describe("The message number of the answer and a short quote of it."),
  reply: z
    .string()
    .describe(
      "The reply as short Markdown in the user's voice. A thread gets one reply, so the other entries of the thread leave it empty.",
    ),
  finding: z
    .number()
    .int()
    .min(0)
    .nullable()
    .default(null)
    .describe("For issue: the index of the new finding in findings, counting from 0. Else null."),
});

export const reviewResult = z.object({
  summary: z.string().describe("One line."),
  risks: z.array(z.string()),
  questions: z.array(question),
  coverage,
  findings: z.array(finding).max(MAX_FINDINGS),
  // Results stored before this key get the default.
  answered: z
    .array(answeredQuestion)
    .max(MAX_ANSWERED)
    .default([])
    .describe("One entry for each question in ./context/questions.md that a newer message answers. Empty when that file does not exist."),
});

export type Side = Finding["side"];
export type Finding = z.infer<typeof finding>;
export type Question = z.infer<typeof question>;
export type Coverage = z.infer<typeof coverage>;
export type AnsweredQuestion = z.infer<typeof answeredQuestion>;
export type ReviewResult = z.infer<typeof reviewResult>;

// The CLI checks the schema with a default Ajv instance, which knows draft-07 only. A 2020-12 $schema fails every run.
// An Explain run gets no answered key: it judges no answer (docs/plans/thread-outcome.md section 9).
export const reviewJsonSchema = (explain = false): Record<string, unknown> =>
  z.toJSONSchema(explain ? reviewResult.omit({ answered: true }) : reviewResult, { target: "draft-07" });

// ---------- Verify phase (docs/plans/review-v2/spec.md sections 1.6 to 1.8) ----------

// The name verdicts belongs to the re-review verdicts below.
export const verifyVerdicts = ["confirmed", "refuted", "unsure", "question", "duplicate"] as const;
export type VerifyVerdictName = (typeof verifyVerdicts)[number];

export const verifyVerdict = z.object({
  candidate: lineNo.describe("A candidate number from ./context/candidates.md."),
  verdict: z.enum(verifyVerdicts),
  severity: z.enum(severities).describe("The severity after your check."),
  reason: z.string().max(1000).describe("One or two sentences: why this verdict, with path:line."),
  evidence: z.string().max(1000).describe("path:line of the line that confirms or refutes it."),
  // The defaults keep entries without these keys valid. --json-schema still lists them as required.
  duplicateOf: lineNo.nullable().default(null).describe("For duplicate: the candidate that it repeats. Else null."),
  question: z.string().max(1000).default("").describe("For question: the question for the author. Else empty."),
});

export const verifyResult = z.object({ verdicts: z.array(verifyVerdict).max(MAX_FINDINGS), coverage });

export type VerifyVerdict = z.infer<typeof verifyVerdict>;
export type VerifyResult = z.infer<typeof verifyResult>;

export const verifyJsonSchema = (): Record<string, unknown> => z.toJSONSchema(verifyResult, { target: "draft-07" });

export type Severity = (typeof severities)[number];
// The check state of a finding item. It comes from the verdict at read time (spec.md section 1.7).
export type Check = "checked" | "unsure" | "unchecked";
// payload.verify of a finding item with a verdict. duplicateOf: an item ID. by: the agent that gave the verdict.
export type VerifyMark = Omit<VerifyVerdict, "candidate" | "question" | "duplicateOf"> & { duplicateOf: number | null; by: string };
// docs/plans/review-v2/spec.md section 2.2: a discuss run withdrew the finding. run: that discuss run. was: the status before.
// restored: the user restored the finding. The mark stays.
export type WithdrawnMark = { run: number; reason: string; was: "new" | "accepted"; restored?: true };
// A finding item payload. finderSeverity: set when the verdict changed the severity. discardedBy "verify": a refuted or duplicate item.
// A restore removes discardedBy and keeps verify (spec.md section 1.8).
// spec.md section 2.2: a revision of a finding is a discarded finding item with revises (the finding ID) and discussedIn (the discuss
// run). It waits for Use the new text or Keep mine (items.ts) and never counts as a finding. dropped: Keep mine, Use the new text, or a
// newer revision ended the wait. revisedBy: on the finding, the revision whose text the user took.
// demoted: a refuted finding that stays in the list, last in its group (spec.md section 1.8).
export type FindingPayload = AnchoredFinding & {
  verify?: VerifyMark;
  finderSeverity?: Severity;
  discardedBy?: "verify";
  demoted?: true;
  withdrawn?: WithdrawnMark;
  revises?: number;
  discussedIn?: number;
  dropped?: true;
  revisedBy?: number;
};

// spec.md section 1.7. A carried finding keeps its kind, so a question verdict on it reads as unsure.
export const checkOf = (p: { verify?: Pick<VerifyMark, "verdict"> }): Check =>
  p.verify?.verdict === "confirmed"
    ? "checked"
    : p.verify?.verdict === "unsure" || p.verify?.verdict === "question"
      ? "unsure"
      : "unchecked";

// main: the Drafts list. fold: "More" (quiet) or "Low confidence" (balanced). hidden: refuted and duplicates, in the run record only.
export type DisplayGroup = "main" | "fold" | "hidden";

// spec.md section 1.4: the place of a finding from its check, its severity, and the volume of its run. A run without a volume is from
// before review v2, which showed every finding.
export function displayGroup(p: Pick<FindingPayload, "severity" | "verify" | "discardedBy">, volume: Volume | undefined): DisplayGroup {
  if (p.discardedBy === "verify") return "hidden";
  const check = checkOf(p);
  if (volume === "quiet") return check !== "unsure" && (p.severity === "blocker" || p.severity === "major") ? "main" : "fold";
  if (volume === "balanced") return check !== "unsure" && p.severity !== "nit" ? "main" : "fold";
  return "main";
}

// ---------- Discuss a finding (docs/plans/review-v2/spec.md section 2) ----------

export const MAX_DISCUSS_MESSAGES = 20;
export const MAX_DISCUSS_ANSWER = 8000;
export const discussVerdicts = ["upheld", "revised", "withdrawn"] as const;
export type DiscussVerdict = (typeof discussVerdicts)[number];

// ---------- PR notes and cites (docs/plans/review-v2/spec.md section 2.9) ----------

export const NOTE_TEXT_MAX = 500;
export const NOTES_CAP = 30;
export const MAX_NOTE_PROPOSALS = 2;
export const MAX_CITES = 5;

export const noteProposal = z.object({
  text: z.string().min(1).max(NOTE_TEXT_MAX).describe("One sentence: the agreement or the wait that the thread shows."),
  thread: lineNo.describe("The thread in ./context/pr-context.md that shows it."),
  pr: z
    .number()
    .int()
    .positive()
    .nullable()
    .default(null)
    .describe("The number of another pull request in ./context/pr-context.md that this pull request waits for. Else null."),
});
export type NoteProposal = z.infer<typeof noteProposal>;

const cites = z
  .array(lineNo)
  .max(MAX_CITES)
  .default([])
  .describe("The numbers of other threads in ./context/pr-context.md whose decision this reply relies on. Else empty.");
const notes = z
  .array(noteProposal)
  .max(MAX_NOTE_PROPOSALS)
  .default([])
  .describe("Notes that you propose to the user. Empty when no thread shows an agreement of the user or a wait for another pull request.");

export const discussResult = z.object({
  answer: z.string().max(MAX_DISCUSS_ANSWER).describe("The answer as short Markdown."),
  verdict: z.enum(discussVerdicts),
  reason: z.string().max(500).describe("One line: why this verdict."),
  // The defaults keep results without these keys valid. --json-schema still lists them as required.
  revision: z
    .object({ severity: z.enum(severities), title: z.string().max(200), body: z.string().max(4000) })
    .nullable()
    .default(null)
    .describe("For revised: the new finding text. Else null."),
  reply: z.string().max(4000).default("").describe("For a posted finding: a reply to the thread in the user's voice, or empty."),
  coverage,
  notes,
  cites,
});

export type DiscussResult = z.infer<typeof discussResult>;
// review_run.discuss_json (spec.md sections 2.2 and 2.9). cites: the checked cites. notes: the IDs of the stored note suggestions.
// applied: the revision item, the discard of the finding, or the reply draft that the run stored. changed: the finding changed during
// the run, so the run applied nothing.
export type DiscussRecord = Pick<DiscussResult, "verdict" | "reason" | "revision" | "reply" | "cites"> & {
  notes: number[];
  applied: { revision?: number; discarded?: true; draft?: number };
  changed?: true;
};

export const discussJsonSchema = (): Record<string, unknown> => z.toJSONSchema(discussResult, { target: "draft-07" });

// ---------- Explain this PR (docs/plans/review-v2/spec.md section 3) ----------

export const MAX_WALKTHROUGH = 60_000;
export const MAX_DIAGRAMS = 3;
export const MAX_DIAGRAM_CHARS = 20_000;
export const fileRoles = ["core", "supporting", "tests", "config", "generated", "docs"] as const;
export type FileRole = (typeof fileRoles)[number];

export const explainResult = z.object({
  summary: z.string().max(300).describe("One line: what the change does."),
  walkthrough: z.string().max(MAX_WALKTHROUGH).describe("The walkthrough as Markdown. Links into the change use diff: links."),
  order: z
    .array(z.object({ path: z.string(), why: z.string().max(300) }))
    .max(60)
    .describe("The files in the order to read them."),
  files: z.array(z.object({ path: z.string(), role: z.enum(fileRoles), summary: z.string().max(600) })).max(300),
  risks: z
    .array(
      z.object({
        text: z.string().max(600),
        path: z.string().nullable(),
        side: z.enum(["new", "old"]),
        line: lineNo.nullable(),
        lineEnd: lineNo.nullable(),
        anchorText: z.string(),
      }),
    )
    .max(30),
  // The default keeps results without this key valid. --json-schema still lists it as required.
  glossary: z
    .array(z.object({ term: z.string().max(80), meaning: z.string().max(300) }))
    .max(40)
    .default([]),
  questions: z.array(question).max(20),
  coverage,
});

export type ExplainResult = z.infer<typeof explainResult>;

export const explainJsonSchema = (): Record<string, unknown> => z.toJSONSchema(explainResult, { target: "draft-07" });

// ---------- Reply drafts (plan replies.md WP17) ----------

export const replyActions = ["reply", "none"] as const;
export const MAX_REPLY_THREADS = 25;
// docs/plans/fix-ux.md: valid and partly tick a thread in the Fix list at the start.
// valid to question: the user answers a point of another person. settled to followup: the user made the point or asked the question.
export const judgements = ["valid", "partly", "invalid", "question", "settled", "unsettled", "followup"] as const;
export type Judgement = (typeof judgements)[number];

export const replyDraft = z.object({
  thread: lineNo.describe("A thread number from the Threads line."),
  action: z.enum(replyActions).describe("reply: the user should answer. none: the thread needs no answer from the user."),
  body: z.string().describe("The reply as short Markdown in the user's voice. Empty for none."),
  reason: z.string().describe("One line: why this reply, or why no reply."),
  evidenceStatus: z.enum(evidenceStatuses),
  judgement: z
    .enum(judgements)
    .nullable()
    .describe(
      "For a point or question of another person: valid: the review point is right. partly: only a part of it is right. invalid: the code is right as it is. question: the newest message asks a question. For a point or question of the user: settled: the code or the answers settle it. unsettled: a part is still missing. followup: the user asks a new question. null: the newest message asks for no change and asks no question.",
    ),
  // The defaults keep results without these keys valid. --json-schema still lists them as required.
  resolve: z
    .boolean()
    .default(false)
    .describe(
      "true: the code at the head commit or the answer in the thread settles the review point, so the thread can be resolved. Only with judgement settled.",
    ),
  resolveEvidence: z
    .string()
    .default("")
    .describe("For resolve true: the proof in one line, such as path:line at the head commit or the message that settles it. Else empty."),
  cites,
});

export const replyResult = z.object({
  summary: z.string().describe("One line."),
  replies: z.array(replyDraft).max(MAX_REPLY_THREADS),
  coverage,
  notes,
});

export type ReplyDraft = z.infer<typeof replyDraft>;
export type ReplyResult = z.infer<typeof replyResult>;
// review: a review run, such as the reply to an answered question. reply: a reply run. fix: a "Fixed in" draft. nofix: the reply of a fix note without a fix. session: an import of
// your session. resolve: a resolve proposal without a reply. user: a draft that the user wrote. A "Won't fix" draft of a user decline
// has origin nofix and declined set. discuss: a talk about a posted finding (docs/plans/review-v2/spec.md section 2.5).
export const replyOrigins = ["review", "reply", "fix", "nofix", "session", "resolve", "user", "discuss"] as const;
export type ReplyOrigin = (typeof replyOrigins)[number];
// replyTo: the message that the reply answers. The post uses it as the parent.
// judgement: absent in drafts stored before Release 3. Read it as null.
// fix: a "Fixed in" reply. It posts only when the PR commits hold the commit (plan r3). replaced: the drafts that the commit
// discarded. Undo brings them back.
// resolve, resolveEvidence: the proposal to resolve the thread. Absent in drafts stored before it existed.
// resolveTick: the user's choice to resolve the thread after the post. Only a ticked draft resolves.
// threadOpen: the thread was open when the app stored the draft. Absent in drafts stored before it existed.
// origin: the writer of the draft (docs/plans/thread-outcome.md). Absent in drafts stored before it existed.
// declined: the fix run whose proposal the user declined with this draft, else null. No writer replaces such a draft (drafts.ts userDraft).
// revises: the ID of the user's draft that this draft revises. A revision waits as a discarded item until the user picks Use revision
// or Keep mine (items.ts). It is never the current draft of its thread (drafts.ts CURRENT_DRAFTS). Use revision removes the key.
// dropped: Keep mine or a newer revision dropped this revision. The row stays, because SQLite gives the ID of a deleted last row again.
// discardedBy: who discarded the draft. ai: a reply run found that no reply is needed. Absent: the user, or a draft stored before it
// existed. A draft that the AI discarded is no user decline (drafts.ts userDraft).
// touchedAt: the time (ms) of the last accept, edit, plain, reply-to-newest, or use-revision. Absent: no such action since it existed.
// revisionOf: on a used revision, the ID of the user's draft that it revised (items.ts takeRevision).
// cites: the other threads whose decision the reply relies on (spec.md section 2.9). Absent in older drafts: read it as [].
export type ReplyPayload = Omit<ReplyDraft, "judgement" | "resolve" | "resolveEvidence" | "cites"> & {
  cites?: number[];
  judgement?: Judgement | null;
  replyTo: number;
  fix?: { id: number; commit: string; replaced?: number[] };
  resolve?: boolean;
  resolveEvidence?: string;
  resolveTick?: boolean;
  threadOpen?: boolean;
  origin?: ReplyOrigin;
  declined?: { run: number } | null;
  revises?: number;
  dropped?: true;
  discardedBy?: "ai" | "user";
  touchedAt?: number;
  revisionOf?: number;
};

export const replyJsonSchema = (): Record<string, unknown> => z.toJSONSchema(replyResult, { target: "draft-07" });

// ---------- Fix runs (plan r3) ----------

export const MAX_FIX_EDITS = 50;
// The UTF-8 bytes of all old and new texts of one fix result.
export const MAX_FIX_BYTES = 200_000;
export const MAX_EDIT_TEXT = 20_000;

// docs/plans/fix-ux.md WP3: each note and each edit names exactly one thread or one finding. validateFix checks it.
const fixTarget = {
  thread: lineNo.optional().describe("A thread number from the Fix threads line. Leave it out for a finding."),
  finding: lineNo.optional().describe("A finding ID from the Fix findings line. Leave it out for a thread."),
};

export const fixEdit = z.object({
  ...fixTarget,
  path: z.string().describe("File path relative to the repository root, with / separators."),
  old: z
    .string()
    .max(MAX_EDIT_TEXT)
    .describe("Text copied verbatim from the file at the head commit. It must match exactly one place. Empty only for a new file."),
  new: z.string().max(MAX_EDIT_TEXT).describe("The text that replaces old."),
});

// docs/plans/thread-outcome.md: why a note gives no fix. The app adds "dropped" when validateFix drops every edit of a note.
export const fixWhys = ["already", "invalid", "scope", "decision", "risk", "unclear"] as const;
export type FixWhy = (typeof fixWhys)[number] | "dropped";

export const fixThread = z.object({
  ...fixTarget,
  fixed: z.boolean().describe("true: the edits of this thread or finding fix the review point."),
  reason: z.string().describe("One line: what the edits change, or why there is no fix."),
  // The defaults keep notes stored before these keys valid. --json-schema still lists them as required.
  why: z
    .enum(fixWhys)
    .nullable()
    .default(null)
    .describe(
      "For fixed false: already: the code already does what the comment asks. invalid: the review point is wrong. scope: the change belongs outside this pull request. decision: the user must choose between options. risk: the fix can break other code. unclear: the comment does not say what to change. null for fixed true.",
    ),
  reply: z
    .string()
    .default("")
    .describe(
      "For a thread: short Markdown in the user's voice. For fixed false: the answer to the commenter. For fixed true: what the edits change. Empty for a finding.",
    ),
});

export const fixResult = z.object({
  summary: z.string().describe("One line."),
  threads: z.array(fixThread).max(MAX_REPLY_THREADS).describe("One entry per thread and per finding."),
  edits: z.array(fixEdit).max(MAX_FIX_EDITS),
  coverage,
});

export type FixEdit = z.infer<typeof fixEdit>;
export type FixThread = z.infer<typeof fixThread>;
// A stored note. Only the app sets why to "dropped". drops: the drop reasons of its edits, only with why "dropped".
// declined: the user declined the proposal ("Don't fix"). draft: the "Won't fix" reply draft of a thread. replaced: the open drafts
// that it discarded. Undo of the decline brings the newest back.
export type FixDecline = { reason: string; draft?: number; replaced?: number[] };
export type FixNote = Omit<FixThread, "why"> & { why: FixWhy | null; drops?: string[]; declined?: FixDecline };
export type FixResult = z.infer<typeof fixResult>;

export const fixJsonSchema = (): Record<string, unknown> => z.toJSONSchema(fixResult, { target: "draft-07" });

const fixNotes = z.array(
  fixThread.extend({
    why: z
      .enum([...fixWhys, "dropped"])
      .nullable()
      .default(null),
    drops: z.array(z.string()).optional(),
    declined: z
      .object({ reason: z.string(), draft: z.number().int().optional(), replaced: z.array(z.number().int()).optional() })
      .optional(),
  }),
);
// review_run.fix_json. Notes stored before why and reply existed get the defaults.
export const parseFixNotes = (json: string | null): FixNote[] => (json ? fixNotes.parse(JSON.parse(json)) : []);

// The edit rules of every run that proposes edits: the fix agent (catalog.ts) and a session run that proposes fixes (consult.ts).
// edits.ts deniedPath enforces the path rules. workspace.ts sanitize gives the *.untrusted.md names.
export const FIX_EDIT_RULES = [
  "Copy old verbatim from the file in ./repo. old must match exactly one place in the file. Add nearby lines to old when the text occurs more than once.",
  "Keep old as short as a unique match allows.",
  "Leave old empty only for a new file.",
  "Change only the lines that the fix needs. Do not reformat, rename, reorder, or refactor other code.",
  "Never edit .claude folders, .mcp.json, CLAUDE.md, CLAUDE.local.md, AGENTS.md, .gitmodules, or the sources of git hooks: .githooks, .husky, and the pre-commit, lefthook, lint-staged, and commitlint configs.",
  "./repo shows CLAUDE.md, CLAUDE.local.md, and AGENTS.md as *.untrusted.md files. Never edit them under either name.",
];

// docs/plans/thread-outcome.md: the why rules of the fix agent (catalog.ts) and of a session run that proposes fixes (consult.ts).
export const FIX_WHY_RULES = [
  "When fixed is false, set why to one of these values.",
  '"already": the code already does what the comment asks.',
  '"invalid": the review point is wrong.',
  '"scope": the change belongs outside this pull request.',
  '"decision": the user must choose between options.',
  '"risk": the fix can break other code.',
  '"unclear": the comment does not say what to change.',
  "When fixed is true, set why to null.",
];

// ---------- Re-review (plan r2 S-RR) ----------

export const verdicts = ["open", "fixed", "outdated"] as const;
export type Verdict = (typeof verdicts)[number];

export const earlierVerdict = z.object({
  id: lineNo.describe("An ID from the Earlier findings line."),
  status: z
    .enum(verdicts)
    .describe("open: the problem is still in the code. fixed: the new commits fix it. outdated: the code that it names is gone."),
  reason: z.string().describe("One line."),
  path: z.string().nullable().describe("The current path of an open finding when the file moved, else null."),
  line: lineNo.nullable().describe("The current first line of an open finding when the code moved, else null."),
});

export const MAX_EARLIER = 100;
export const rereviewResult = reviewResult.extend({ earlier: z.array(earlierVerdict).max(MAX_EARLIER) });

export type EarlierVerdict = z.infer<typeof earlierVerdict>;
export type RereviewResult = z.infer<typeof rereviewResult>;

export const rereviewJsonSchema = (): Record<string, unknown> => z.toJSONSchema(rereviewResult, { target: "draft-07" });

// A finding or question that a re-review copied from its base run. from: the source item ID. since: the head that the base run reviewed.
export type Carried = { from: number; verdict: Verdict; reason: string; since: string };

// docs/plans/fix-ux.md decision 3: a fix commit that covers an open finding discards it with this mark. id: the fix_commit ID.
// was: the status before the mark. An undo of the commit and a restore by the user return it. A restore keeps the mark.
export type FixedMark = { id: number; commit: string; short: string; was: "new" | "accepted" };

// docs/plans/session-consult.md part C: the verdict of the session that wrote the code. run: the consult run of the import.
// was: findings only, the status before a reject discarded it. replaced: reply drafts only, the open drafts that it replaced.
// A reject mark lives only while its discard holds: a restore or an undo removes it.
export type SessionMark = {
  run: number;
  verdict: "accept" | "reject" | "question";
  reason: string;
  was?: "new" | "accepted";
  replaced?: { id: number; was: "new" | "accepted" }[];
};

// ---------- Ask (plan r2 S-ASK) ----------

export const MAX_QUESTION = 4000;
export const MAX_ANSWER = 20_000;

export const askResult = z.object({
  answer: z.string().max(MAX_ANSWER).describe("The answer as Markdown."),
  coverage,
});

export type AskResult = z.infer<typeof askResult>;

export const askJsonSchema = (): Record<string, unknown> => z.toJSONSchema(askResult, { target: "draft-07" });

// ---------- Improve prompt ----------

// The server extends prompt with the profile prompt rule of dto.ts. dto.ts imports this module, so this module cannot import it.
export const improveResult = z.object({
  prompt: z.string(),
  reasons: z.array(z.string().trim().min(1)).describe("One short line for each change."),
});

// ---------- Validator output ----------

export type DiffKind = "add" | "del" | "ctx";

// n: the line number on the side of its kind. ctx lines use the number on the finding's side.
// hunk: a ctx line that the diff hunks show. Other ctx lines are outside the diff.
// old: the old-side number of a hunk ctx line on the new side. Bitbucket numbers a CONTEXT anchor on the old side (Gate v3 U4).
export type ExcerptLine = { n: number; kind: DiffKind; text: string; hunk?: true; old?: number };

// exact: the reported range holds the quote. moved: another range holds it. outside: a line of the range is not in the diff.
export type AnchorState = "exact" | "moved" | "outside";

export type Anchor = {
  state: AnchorState;
  // The path in the diff. oldPath is set only for a renamed file.
  path: string;
  oldPath: string | null;
  line: number;
  lineEnd: number;
  excerpt: ExcerptLine[];
};

// A finding as review_item.payload_json and summary_json.dropped store it. Rows stored before review v2 lack the v2 keys.
type V2Keys = "title" | "trigger" | "cause" | "rule" | "module";
export type StoredFinding = Omit<Finding, V2Keys> & Partial<Pick<Finding, V2Keys>>;

// cause.anchor: set when the anchor holds no changed line and the cause range does (spec.md section 1.7).
export type Cause = NonNullable<Finding["cause"]>;
// movedFrom: the place that the finder gave, when validate.ts moved the finding to the one exact match in another changed file.
export type AnchoredFinding = Omit<StoredFinding, "cause"> & {
  cause?: (Cause & { anchor?: Anchor }) | null;
  anchor: Anchor;
  movedFrom?: { path: string; line: number };
};

// path: absolute, "..", or outside the snapshot. file: no such file on that side. match: the quote is not in the file.
// size: the file or the range is above the scan limits. unchanged: neither the anchor nor the cause holds a changed line.
// rule: no loaded instruction file holds the quoted rule.
export type DropReason = "path" | "file" | "match" | "size" | "unchanged" | "rule";
export type DroppedFinding = StoredFinding & { reason: DropReason };

export type ValidatedResult = Omit<ReviewResult, "findings"> & { findings: AnchoredFinding[]; dropped: DroppedFinding[] };

// A user move may pick only these lines: the excerpt lines that exist on the finding's side.
export const moveChoices = (excerpt: ExcerptLine[], side: Side): number[] =>
  excerpt.filter((l) => l.kind !== (side === "new" ? "del" : "add")).map((l) => l.n);

// The excerpt line n of the finding's side, if the diff shows it. Excerpts stored without the hunk flag count ctx lines as outside.
export const diffLine = (excerpt: ExcerptLine[], side: Side, n: number): ExcerptLine | undefined =>
  excerpt.find((l) => l.n === n && (l.kind === (side === "new" ? "add" : "del") || (l.kind === "ctx" && l.hunk === true)));
