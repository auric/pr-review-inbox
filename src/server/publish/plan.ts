// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Publish plan (plan v3 WP12). Pure: the exact comments that a confirm posts for the accepted items.
import type { BlockedDraft, PlannedPost, ReviewItemDto } from "../../shared/dto";
import { fileUrl } from "../../shared/links";
import { isMe } from "../../shared/me";
import { type AnchoredFinding, checkOf, type Finding, type FindingPayload, type Question, type ReplyPayload } from "../../shared/review";
import { anchorSpan } from "../../shared/types";

// repoUrl: the repository browse link of the PR (plan v3 WP4). Absent or null: file references stay plain text.
export type PlanRun = { id: number; sourceHead: string; targetHead: string; mergeBase: string | null; repoUrl?: string | null };
// A live root comment. anchor: the stored forge anchor, absent for a general comment.
export type PlanComment = { id: number; authorSlug: string; authorLogin: string | null; authorName: string | null; anchor: unknown };
// mark: the markAi setting at build time. severity: the markSeverity setting. The outbox keeps the built body, so a later change never alters a queued row.
// resolved: the root comments of the resolved threads. blocked: the drafts that the plan leaves out (outbox.ts blockedDrafts).
export type PlanInput = {
  me: string | null;
  mark: boolean;
  severity: boolean;
  runs: PlanRun[];
  items: ReviewItemDto[];
  comments: PlanComment[];
  resolved?: number[];
  blocked?: BlockedDraft[];
};

export const AI_MARK = "🤖 ";
// A body that already starts with the robot emoji gets no second mark.
const marked = (body: string) => (body.startsWith(AI_MARK.trimEnd()) ? body : AI_MARK + body);

const SEVERITY: Record<Finding["severity"], string> = {
  blocker: "**Blocker:** ",
  major: "**Major:** ",
  minor: "**Minor:** ",
  nit: "**Nit:** ",
};
const severityOf = (it: ReviewItemDto) => (it.kind === "finding" ? SEVERITY[(it.payload as AnchoredFinding).severity] : undefined);
// The severity goes after an AI mark that the body already has.
function withSeverity(body: string, prefix: string | undefined) {
  if (!prefix) return body;
  const robot = AI_MARK.trimEnd();
  return body.startsWith(robot) ? AI_MARK + prefix + body.slice(robot.length).trimStart() : prefix + body;
}

// docs/plans/review-v2/review-ideas.md candidate C (spec.md AC-R26, AC-R27). Only a draft that the user did not edit gets them.
export const NIT = "Nit: ";
export const QUESTION_LEAD = "Can you check this? ";
// The check verdict wins over the finder confidence, as on the Low confidence chip of the Drafts list.
const lowConfidence = (p: FindingPayload) => (p.verify ? checkOf(p) === "unsure" : p.confidence === "low");
function findingText(it: ReviewItemDto, mark: string | undefined): string {
  if (it.edited) return withSeverity(it.body, mark);
  const p = it.payload as FindingPayload;
  const lead = lowConfidence(p) && !it.body.startsWith(QUESTION_LEAD) ? QUESTION_LEAD : "";
  const nit = !mark && p.severity === "nit" && !/^\**nit\**:/i.test(it.body) ? NIT : "";
  return withSeverity(nit + lead + it.body, mark);
}

// plan v3 WP12: `[path:line](fileUrl)`. Without the browse link or the commit, the plain "path:line" stays. src/shared/links.ts holds the URL form.
export const fileRef = ({ repoUrl }: Pick<PlanRun, "repoUrl">, path: string, at: string | null, line: number) => {
  const text = `${path}:${line}`;
  return repoUrl && at ? `[${text.replace(/[\\[\]]/g, "\\$&")}](${fileUrl(repoUrl, path, at, line)})` : text;
};

type Raw = { path?: unknown; line?: unknown; lineType?: unknown; fileType?: unknown } | null;

// at.line: the new-side line of the finding. at.srcLine: its old-side line, for a ctx line only.
function duplicate(
  comments: PlanComment[],
  me: string | null,
  at: { path: string; line: number; srcLine?: number },
): PlannedPost["duplicate"] {
  for (const c of comments) {
    const a = c.anchor as Raw;
    if (!a || a.path !== at.path || typeof a.line !== "number") continue;
    // Gate A U2: a range anchor covers each new-side line of its span.
    // Gate v3 U4: a CONTEXT anchor holds the old-side line, whatever fileType says. Any other FROM anchor is a removed line.
    const span = anchorSpan(a);
    if (
      span
        ? at.line < span.line || at.line > span.lineEnd
        : a.line !== (a.lineType === "CONTEXT" ? at.srcLine : a.fileType === "FROM" ? undefined : at.line)
    )
      continue;
    if (isMe({ slug: c.authorSlug, login: c.authorLogin }, me)) continue;
    return { commentId: c.id, author: c.authorName ?? c.authorSlug };
  }
  return null;
}

// One general comment: each outside or old-side finding with its file line, then the questions (prototype 1698-1701).
export function generalText(findings: { ref: string; body: string }[], questions: { body: string; why: string }[]): string {
  const qs = questions.map((q) => `${q.body} ${q.why}`);
  return [
    ...findings.map((f) => `${f.ref}: ${f.body}`),
    ...(qs.length === 1 ? qs : qs.length ? [`Questions:\n\n${qs.map((q) => `- ${q}`).join("\n")}`] : []),
  ].join("\n\n");
}

export function buildPlan(input: PlanInput): PlannedPost[] {
  const out: PlannedPost[] = [];
  const text = input.mark ? marked : (body: string) => body;
  const sev = (it: ReviewItemDto) => (input.severity ? severityOf(it) : undefined);
  const resolved = new Set(input.resolved);
  const blocked = new Set(input.blocked?.map((b) => b.item));
  // docs/plans/review-v2/spec.md section 2.2: a revision of a finding never posts. Only Use the new text moves its text to the finding.
  const revision = (i: ReviewItemDto) => i.kind === "finding" && (i.payload as { revises?: number }).revises !== undefined;
  for (const run of input.runs) {
    const heads = { run: run.id, sourceHead: run.sourceHead, targetHead: run.targetHead, mergeBase: run.mergeBase };
    const items = input.items
      .filter((i) => i.run === run.id && i.status === "accepted" && !blocked.has(i.id) && !revision(i))
      .sort((a, b) => a.id - b.id);
    const general: { ref: string; body: string }[] = [];
    const questions: { body: string; why: string }[] = [];
    const generalItems: PlannedPost["items"] = [];
    for (const it of items) {
      const ref = { id: it.id, revision: it.revision };
      const a = it.anchor;
      // R15: a reply item has no anchor, but it never joins the general comment.
      // A ticked draft resolves its thread after the post. A ticked draft without text only resolves, so it gets no AI mark.
      // A reply in a resolved thread reopens it first (outbox.ts reopenFor). A thread resolved after the draft blocks the draft.
      if (it.kind === "reply") {
        const p = it.payload as ReplyPayload;
        const body = it.body.trim() ? text(it.body) : "";
        if (!body && !p.resolveTick) continue;
        out.push({
          ...heads,
          destination: { kind: "reply", parentId: p.replyTo },
          body,
          items: [ref],
          duplicate: null,
          ...(p.resolveTick && { resolve: p.thread }),
          ...(body && resolved.has(p.thread) && { reopen: "resolved" as const }),
        });
        continue;
      }
      if (it.kind === "question" || !a) {
        questions.push({ body: it.body, why: (it.payload as Question).why });
        generalItems.push(ref);
        continue;
      }
      // exact and moved anchors lie in the diff. A new-side diff line is an added or a context line.
      // Gate v3 U4: a context line posts with its old-side line. An excerpt stored without it sends the finding to the general comment.
      const hit = a.side === "new" && a.state !== "outside" ? a.excerpt.find((l) => l.n === a.line && l.kind !== "del") : undefined;
      if (hit?.kind === "add" || hit?.old !== undefined) {
        const srcPath = (it.payload as AnchoredFinding).anchor.oldPath;
        const srcLine = hit.kind === "ctx" ? { srcLine: hit.old } : {};
        out.push({
          ...heads,
          destination: {
            kind: "inline",
            path: a.path,
            srcPath,
            line: a.line,
            lineEnd: a.lineEnd,
            lineType: hit.kind === "ctx" ? "ctx" : "add",
            ...srcLine,
          },
          body: text(findingText(it, sev(it))),
          items: [ref],
          duplicate: duplicate(input.comments, input.me, { path: a.path, line: a.line, ...srcLine }),
        });
        continue;
      }
      // D3: a removed line has its number at the merge base, in the old path of a rename.
      const old = a.side === "old";
      general.push({
        ref: fileRef(run, old ? (a.oldPath ?? a.path) : a.path, old ? run.mergeBase : run.sourceHead, a.line),
        body: findingText(it, sev(it)),
      });
      generalItems.push(ref);
    }
    if (generalItems.length)
      out.push({
        ...heads,
        destination: { kind: "general" },
        body: text(generalText(general, questions)),
        items: generalItems,
        duplicate: null,
      });
  }
  return out;
}
