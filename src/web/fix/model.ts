// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure Fix it rules (plan r3 UI-FIX, docs/plans/fix-ux.md). No DOM access, so bun test runs them directly.
import type { FixCommitDto, FixDto, FixEditDto, ReviewItemDto } from "../../shared/dto";
import { type FixNote, type FixTarget, fixState, names, plural, shortHash, snippet, WHY } from "../../shared/outcome";
import { type AnchoredFinding, type FixWhy, type Judgement, MAX_FIX_ITEMS, type ReplyPayload } from "../../shared/review";
import { ordered, type ThreadModel } from "../pr/threads";
import { lineText } from "../review/model";

// src/shared/outcome.ts holds the fix state rules, so the PR context file of a run uses them too.
export { type Asked, type FixNote, type FixState, type FixTarget, fixState, fixWaiting, WHY } from "../../shared/outcome";

// Judgement null means "no action": no chip, and no tick at the start of the Fix list.
export const JUDGEMENT: Record<Judgement, string> = {
  valid: "Valid",
  partly: "Partly valid",
  invalid: "Not valid",
  question: "Question",
  settled: "Settled",
  unsettled: "Not settled",
  followup: "Follow-up question",
};
// The judgements of a thread where the user made the point or asked. They never tick the Fix list.
export const askerSide = (j: Judgement) => j === "settled" || j === "unsettled" || j === "followup";

// ---------- The Fix list (plan pr-view-v4 2.12, fix-ux Option A) ----------

// One open, unresolved thread with a live message. badge: own for your comment, posted for a finding that the app posted.
// judgement: the newest unposted reply draft. fixed: the short hash of a fix commit that holds an edit of the thread.
// outcome: the fix outcome of the newest fix run for the thread. tick: the tick at the start.
export type FixRow = {
  thread: number;
  who: string;
  place: string;
  badge: "own" | "posted" | null;
  judgement: Judgement | null;
  fixed: string | null;
  outcome: FixOutcome | null;
  text: string;
  tick: boolean;
};

// One open review finding that is not posted (docs/plans/fix-ux.md phase 2). place: path:line of the current anchor.
// fixed: the short hash of the fix commit that marked it, when you restored it. tick: the tick at the start.
export type FixFindingRow = {
  finding: number;
  severity: AnchoredFinding["severity"];
  place: string;
  accepted: boolean;
  fixed: string | null;
  outcome: FixOutcome | null;
  text: string;
  tick: boolean;
};

// rows: the threads. findings: the findings. resolved, deleted: the threads that the list leaves out. A deleted thread has no live message.
export type FixTargets = { rows: FixRow[]; findings: FixFindingRow[]; resolved: number; deleted: number };

// The key of a target in the Fix list and in the IDs of its fix card. A thread keeps its number. A finding gets "f" before its ID.
export const cardKey = (t: FixTarget) => (t.kind === "thread" ? String(t.id) : `f${t.id}`);
const targetOf = (e: FixEditDto): FixTarget =>
  e.thread !== undefined ? { kind: "thread", id: e.thread } : { kind: "finding", id: e.finding as number };

// jobs.ts fixFindings: a fix run takes a finding with status new or accepted and a place in the code.
export const fixable = (it: ReviewItemDto) =>
  it.kind === "finding" && (it.status === "new" || it.status === "accepted") && it.anchor !== null;

// The f key and the Fix action on one finding. null: the Fix list can tick it. Else the reason, as a toast.
export function findingFixWhy(it: ReviewItemDto | undefined): string | null {
  if (it?.kind !== "finding") return "Move to a finding first. F opens the Fix list.";
  if (it.status === "posted") return "This finding is posted. Fix its thread instead.";
  if (it.status === "discarded") {
    const f = it.payload.fixed;
    return f
      ? `This finding is fixed in ${f.short}. Restore it to fix it again.`
      : "This finding is discarded. Fix works only on open findings.";
  }
  if (!it.anchor) return "This finding has no place in the code. Fix needs one.";
  return null;
}

const placeText = (t: ThreadModel) => {
  const a = t.anchor;
  if (!a) return "General comment";
  return a.line === undefined ? a.path : `${a.path}:${lineText({ line: a.line, lineEnd: a.lineEnd ?? a.line })}`;
};

// threads: in any order; the rows come in screen order. replies: GET /api/prs/:id/reply-drafts. fixes: GET /api/prs/:id/fixes.
// findings: the finding drafts of the newest review run, in screen order.
// Decision D6: your own comments and posted findings start unticked. Valid and partly valid start ticked, unless a commit fixed them.
// The plans give no default tick for a finding. Accepted findings start ticked and new ones do not. A restore returns the status of a fixed one.
// session-consult.md part C: an accept of your session ticks any thread or finding.
// docs/plans/thread-outcome.md: a no-fix note or a decline unticks any row.
export function fixTargets(
  threads: ThreadModel[],
  replies: ReviewItemDto[] | undefined,
  fixes: FixDto[] | undefined,
  findings: ReviewItemDto[] = [],
): FixTargets {
  const judged = new Map<number, Judgement | null>();
  const accepted = new Set<number>();
  for (const it of replies ?? []) {
    if (it.kind !== "reply") continue;
    const p = it.payload as ReplyPayload;
    judged.set(p.thread, p.judgement ?? null);
    if (it.payload.session?.verdict === "accept" && it.status !== "discarded") accepted.add(p.thread);
  }
  const fixedIn = new Map<number, string>();
  for (const f of fixes ?? [])
    for (const c of f.commits) {
      if (c.state !== "committed") continue;
      for (const e of f.edits)
        if (e.thread !== undefined && c.edits.includes(e.id) && !fixedIn.has(e.thread))
          fixedIn.set(e.thread, c.short ?? shortHash(c.commit ?? ""));
    }
  const out: FixTargets = { rows: [], findings: [], resolved: 0, deleted: 0 };
  for (const it of findings) {
    if (!fixable(it) || !it.anchor) continue;
    const ok = it.status === "accepted";
    const fixed = it.payload.fixed?.short ?? null;
    const outcome = fixOutcome(fixes, { kind: "finding", id: it.id });
    out.findings.push({
      finding: it.id,
      severity: (it.payload as AnchoredFinding).severity,
      place: `${it.anchor.path}:${lineText(it.anchor)}`,
      accepted: ok,
      fixed,
      outcome,
      text: snippet(it.body, 160),
      tick: !outcome?.noFix && (ok || it.payload.session?.verdict === "accept"),
    });
  }
  for (const t of ordered(threads, false)) {
    if (!t.last) {
      out.deleted++;
      continue;
    }
    if (t.turn === "resolved") {
      out.resolved++;
      continue;
    }
    const head = t.root.deleted ? t.last : t.root;
    const badge = t.root.posted === "run" ? "posted" : t.root.who.me ? "own" : null;
    const judgement = judged.get(t.id) ?? null;
    const fixed = fixedIn.get(t.id) ?? null;
    const outcome = fixOutcome(fixes, { kind: "thread", id: t.id });
    out.rows.push({
      thread: t.id,
      who: head.who.me ? "You" : head.who.name,
      place: placeText(t),
      badge,
      judgement,
      fixed,
      outcome,
      text: snippet(head.text, 160),
      tick:
        fixed === null && !outcome?.noFix && (accepted.has(t.id) || (badge === null && (judgement === "valid" || judgement === "partly"))),
    });
  }
  return out;
}

// The f key on one thread. null: the Fix list can tick it. Else the reason, as a toast.
export function threadFixWhy(t: ThreadModel | undefined): string | null {
  if (!t) return "Move to a thread first. F opens the Fix list.";
  if (!t.last) return "Every message of this thread is deleted. Fix needs a live message.";
  if (t.turn === "resolved") return "This thread is resolved. Fix works only on open threads.";
  return null;
}

export const NOTHING_TO_FIX = { title: "Nothing to fix.", text: "No open thread and no open finding. Press r to review." };

// The text under the buttons of the Fix list. Only "ok" lets Propose start a run.
// rows: the thread and finding rows. ticked: the ticked rows. fixRunInput caps threads and findings together.
// synced: the server has both heads (jobs.ts fix). busy: busyText of the active run.
export type FixReason = { kind: "nothing" | "sync" | "explain" | "busy" | "none" | "many" | "ok"; text: string };
export function fixReason(o: {
  rows: number;
  ticked: number;
  synced: boolean;
  profile: { name: string; explain: boolean };
  busy: string | null;
}): FixReason {
  if (!o.rows) return { kind: "nothing", text: `${NOTHING_TO_FIX.title} ${NOTHING_TO_FIX.text}` };
  if (!o.synced) return { kind: "sync", text: "Sync the pull request first. Wait for the next sync, or click Check now." };
  if (o.profile.explain)
    return {
      kind: "explain",
      text: `The brief uses the ${o.profile.name} profile, which proposes no fixes. Press r and pick a review profile.`,
    };
  if (o.busy) return { kind: "busy", text: `${o.busy} Propose fixes when it ends.` };
  if (!o.ticked) return { kind: "none", text: "Tick at least one thread or finding." };
  if (o.ticked > MAX_FIX_ITEMS)
    return { kind: "many", text: `Tick at most ${MAX_FIX_ITEMS} threads and findings for one run. Now ${o.ticked} are ticked.` };
  return {
    kind: "ok",
    text: `A read-only run checks each point first, then proposes exact edits. You review each edit before Apply. Nothing posts. Profile: ${o.profile.name}.`,
  };
}

// "Not in the list: 2 resolved threads, 1 deleted thread." Empty when the list leaves out nothing.
export function leftOutText(t: Pick<FixTargets, "resolved" | "deleted">): string {
  const parts = [t.resolved && plural(t.resolved, "resolved thread"), t.deleted && plural(t.deleted, "deleted thread")].filter(Boolean);
  return parts.length ? `Not in the list: ${parts.join(", ")}.` : "";
}

export const OWN_ONLY = "Fix works only on your own pull requests.";

// ---------- Edits and their selection ----------

// The edits of a run that no commit holds. An undone commit frees its edits. Apply refuses the edits of a declined note.
export function freeEdits(f: FixDto): FixEditDto[] {
  const used = new Set(f.commits.filter((c) => c.state !== "undone").flatMap((c) => c.edits));
  return f.edits.filter((e) => !used.has(e.id) && !f.threads.some((n) => n.declined && names(n, targetOf(e))));
}

// ticks: the choice of the user per edit ID. Without a choice, the edits of the newest run are ticked and older ones are not.
// first: the target of the first ticked edit. Review edits and the focus after a commit go to its card.
export function selection(f: FixDto, newest: boolean, ticks: ReadonlyMap<number, boolean>) {
  const edits = freeEdits(f).filter((e) => ticks.get(e.id) ?? newest);
  const ids = (k: "thread" | "finding") => [...new Set(edits.flatMap((e) => (e[k] === undefined ? [] : [e[k]])))];
  const first = edits[0];
  return { edits: edits.map((e) => e.id), threads: ids("thread"), findings: ids("finding"), first: first ? targetOf(first) : null };
}

export const applyText = (edits: number, threads: number, findings = 0) => {
  const from = [threads && plural(threads, "comment"), findings && plural(findings, "finding")].filter(Boolean).join(" and ");
  return `Apply ${plural(edits, "edit")} from ${from || plural(threads, "comment")}`;
};

// White space becomes one space, control characters go, and the text is cut at 200 characters.
const clean = (raw: string) =>
  [
    ...raw
      .replace(/\s+/gu, " ")
      .replace(/\p{Cc}/gu, "")
      .trim(),
  ]
    .slice(0, 200)
    .join("");

// Plan r3: the default first line names the comment or the comment count. The body has one line per thread with its reason.
// findings: each finding with its place, path:line. A finding ID is local to the app, so the message names the place.
export function defaultMessage(
  prId: number,
  threads: number[],
  notes: FixDto["threads"],
  findings: { id: number; place: string | null }[] = [],
): string {
  const reason = (t: FixTarget) => clean(notes.find((n) => names(n, t))?.reason ?? "");
  const line = (label: string, why: string) => (why ? `- ${label}: ${why}` : `- ${label}`);
  const at = (f: { id: number; place: string | null }) => (f.place ? `at ${clean(f.place)}` : String(f.id));
  const [one] = findings;
  const counts = [threads.length && plural(threads.length, "review comment"), findings.length && plural(findings.length, "review finding")];
  const head =
    threads.length === 1 && !one
      ? `Fix review comment ${threads[0]} on PR ${prId}`
      : one && findings.length === 1 && !threads.length
        ? `Fix review finding ${at(one)} on PR ${prId}`
        : `Fix ${counts.filter(Boolean).join(" and ") || plural(0, "review comment")} on PR ${prId}`;
  const body = [
    ...threads.map((t) => line(`Comment ${t}`, reason({ kind: "thread", id: t }))),
    ...findings.map((f) => line(`Finding ${at(f)}`, reason({ kind: "finding", id: f.id }))),
  ];
  return [head, "", ...body].join("\n");
}

// clone.ts fixRef without the commit row ID, which exists only after the commit. prId: the PR number on the forge.
export const appRefPrefix = (prId: number) => `refs/rl/${prId}/fix-commit/`;

// Cache mode: the fast-forward keeps the hash, so the "Fixed in" reply rule still holds.
export const fetchCommands = (f: { cache: string; ref: string }) => [`git fetch "${f.cache}" ${f.ref}`, "git merge --ff-only FETCH_HEAD"];

export function commitText(c: FixCommitDto): string {
  const short = c.short ?? (c.commit ? shortHash(c.commit) : "");
  if (c.state === "undone") return `You undid the fix commit${short ? ` ${short}` : ""}.`;
  if (c.state === "staged")
    return "The edits are staged in your clone, but the commit did not finish. Fix the problem, then commit in your clone, or Undo.";
  return c.mode === "clone"
    ? `Committed ${short} on ${c.branch ?? "the branch"} in your clone. Push it when you are ready.`
    : `Committed ${short} to an app branch. Run these commands in your clone:`;
}

// ---------- One thread or finding ----------

// The head of a fix card with a note or edits. edits: the edit count of the target in the run.
// A risk needs your decision too (thread-outcome.md section 3).
export function cardHead(edits: number, note: FixNote | null): string {
  if (note?.declined) return "Won't fix";
  if (note?.why === "risk") return `${WHY.risk}: ${WHY.decision.toLowerCase()}`;
  if (note?.why) return WHY[note.why];
  return edits ? `Proposed fix, ${plural(edits, "edit")}` : "No fix proposed";
}

// The outcome of each why in the Fix list (thread-outcome.md section 3).
const OUTCOME: Record<FixWhy, string> = {
  already: "Already done",
  invalid: "Won't fix",
  scope: "Won't fix",
  unclear: "Follow-up asked",
  decision: "Needs your decision",
  risk: "Needs your decision",
  dropped: "Needs your decision",
};

// The fix outcome of a thread or finding from its newest fix run. short: the commit of "Fixed in" and "Partly fixed in".
// noFix: a note without a fix or a decline, so the row starts unticked.
export type FixOutcome = { label: string; short: string | null; noFix: boolean };

export function fixOutcome(fixes: FixDto[] | undefined, target: FixTarget): FixOutcome | null {
  const s = fixState(fixes, target, null);
  if (s?.kind !== "done") return null;
  const { fix, note, edits, commit } = s;
  if (commit?.state === "committed") {
    // BRIEF "Fixed in" text: the commits of the run that are not undone hold every edit of the target, or only a part.
    const held = new Set(fix.commits.filter((c) => c.state !== "undone").flatMap((c) => c.edits));
    const label = edits.every((e) => held.has(e.id)) ? "Fixed in" : "Partly fixed in";
    return { label, short: commit.short ?? shortHash(commit.commit ?? ""), noFix: false };
  }
  if (note?.declined) return { label: "Declined", short: null, noFix: true };
  if (note && (note.why || !note.fixed)) return { label: note.why ? OUTCOME[note.why] : "No fix proposed", short: null, noFix: true };
  return edits.length ? { label: "Fix proposed", short: null, noFix: false } : null;
}

export const outcomeText = (o: FixOutcome) => (o.short ? `${o.label} ${o.short}` : o.label);

// The reply draft that a fix note made in a thread: the "Won't fix" draft of a decline, else the nofix draft of the run.
// replies: the current draft of each thread, so a draft that a newer one replaced or that posted is absent.
export function noteDraft(fix: FixDto, note: FixNote | null, target: FixTarget, replies: ReviewItemDto[] | undefined) {
  if (target.kind !== "thread" || !note) return null;
  const id = note.declined?.draft;
  const ours = (it: ReviewItemDto) => {
    if (it.kind !== "reply") return false;
    if (id !== undefined) return it.id === id;
    const p = it.payload as ReplyPayload;
    return it.run === fix.run.id && p.thread === target.id && p.origin === "nofix" && !p.declined;
  };
  return replies?.find(ours) ?? null;
}
