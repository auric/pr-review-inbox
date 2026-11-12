// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure Ask rules (plan r2 UI-ASK). No DOM access, so bun test runs them directly.
import type { AskDto, RunConflict, RunKind } from "../../shared/dto";
import { plural } from "../../shared/outcome";
import { coverageRows, KIND_LABEL, limitText, RUN_TEXT, type SlotBusy, tokenTotal } from "../review/model";
import { listText } from "../tasks/model";

export type AskView =
  | { kind: "running"; startedAt: number }
  // gaps: the coverage rows other than Read. answer: null only when the server stored no answer.
  | { kind: "answered"; at: number; tokens: number | null; gaps: [string, string[]][]; answer: string | null }
  | { kind: "failed"; text: string; raw: boolean }
  | { kind: "cancelled" };

// A usage limit shows the CLI message and no raw output, as on the run line.
export function askView(a: AskDto, runner: string): AskView {
  const r = a.run;
  switch (r.status) {
    case "running":
      return { kind: "running", startedAt: r.startedAt };
    case "cancelled":
      return { kind: "cancelled" };
    case "failed":
      return r.errorKind === "usage_limit"
        ? { kind: "failed", text: limitText(runner, r.errorText), raw: false }
        : { kind: "failed", text: `${RUN_TEXT.ask.failed} ${r.errorText ?? "No reason was recorded."}`, raw: r.hasRaw };
    default:
      return {
        kind: "answered",
        at: r.finishedAt ?? r.startedAt,
        tokens: tokenTotal(r.usage),
        gaps: r.summary ? coverageRows(r.summary.coverage).filter(([k]) => k !== "Read") : [],
        answer: a.answer,
      };
  }
}

// docs/plans/review-v2/parallel-runs.md section 3.5, W1 to W3. where: "this pull request", the PR key, or the task key.
// W1: a run works on the PR of the start control.
export const busyText = (runner: string, kind: RunKind, where: string) =>
  `${runner} is ${RUN_TEXT[kind].doing} ${where}. One run per pull request.`;

// W3: every run slot is in use.
export const fullText = (runner: string, limit: number) => `${runner} runs ${plural(limit, "run")} at once, your limit.`;

// The note under a start control. W2 names at most 3 runs that hold the slots.
export function slotNote(runner: string, b: SlotBusy, where: (pr: number | null, task?: string) => string): string {
  if (b.kind === "pr") return busyText(runner, b.run.kind, where(b.run.pr, b.run.taskKey));
  const names = b.running.slice(0, 3).map((s) => `${KIND_LABEL[s.kind]} of ${where(s.pr, s.taskKey)}`);
  if (b.running.length > 3) names.push(`${b.running.length - 3} more`);
  return `${fullText(runner, b.limit)} Running: ${listText(names)}.`;
}

// A refused start (409): W1, or W3 with the next step.
export const refusedText = (runner: string, c: RunConflict, where: (pr: number | null) => string) =>
  c.full ? `${fullText(runner, c.full)} Try again when one ends.` : busyText(runner, c.running.kind, where(c.running.pr));

// docs/plans/review-v2/spec.md section 2.15: the conversations of the listed asks, from their parent links inside the list. Each one is
// oldest first. The conversations sort by their newest run, newest first. A parent outside the list starts its group.
export function askConversations(list: AskDto[]): AskDto[][] {
  const ids = new Set(list.map((a) => a.run.id));
  const next = new Map<number, AskDto>();
  for (const a of list) if (a.parent !== null && ids.has(a.parent)) next.set(a.parent, a);
  const groups = list
    .filter((a) => a.parent === null || !ids.has(a.parent))
    .map((first) => {
      const g = [first];
      for (let n = next.get(first.run.id); n && !g.includes(n); n = next.get(n.run.id)) g.push(n);
      return g;
    });
  const newest = (g: AskDto[]) => Math.max(...g.map((a) => a.run.id));
  return groups.sort((x, y) => newest(y) - newest(x));
}

// first: no ask on the PR yet. follow: the box follows the newest turn. new: the box starts a new conversation.
export type BoxMode = "first" | "follow" | "new";

// The label, placeholder, and hint of the Ask box (spec.md section 2.14). profile: the profile that answers. gone: a follow-up whose
// parent profile no longer exists, so the brief profile answers (design.md D18).
export function askBox(
  mode: BoxMode,
  o: { runner: string; profile: string; gone: boolean; forge: string },
): { label: string; placeholder: string; hint: string } {
  const example = "For example: which callers of the changed function are not updated?";
  const posts = `Nothing posts to ${o.forge}.`;
  switch (mode) {
    case "first":
      return {
        label: "Your question",
        placeholder: example,
        hint: `${o.runner} answers with the ${o.profile} profile. The answer stays in PR Review Inbox. ${posts}`,
      };
    case "follow":
      return {
        label: "Follow up",
        placeholder: "Ask about the answer above",
        hint: o.gone
          ? `${o.runner} answers with the ${o.profile} profile of the brief: the profile of the earlier answer no longer exists. ${o.runner} sees this conversation. ${posts}`
          : `${o.runner} answers with the ${o.profile} profile and sees this conversation. ${posts}`,
      };
    default:
      return {
        label: "New question",
        placeholder: example,
        hint: `${o.runner} starts fresh. It does not see the conversation above. It answers with the ${o.profile} profile. ${posts}`,
      };
  }
}
