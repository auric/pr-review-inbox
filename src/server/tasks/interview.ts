// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The interview of a task (docs/plans/review-v2/spec.md sections 6.2, 6.5, and 6.6): the checks of the questions, the round rules,
// the recommended answers, and context/answers.md.
import { indentBlock, oneLine } from "../../shared/consult";
import type { TaskInterviewDto } from "../../shared/dto";
import { INTERVIEW_QUESTIONS, INTERVIEW_ROUNDS, type InterviewResult } from "../../shared/task";
import type { ContextFile } from "../review/workspace";

export type Question = InterviewResult["questions"][number];
export type Answer = { choice: number | null; text: string };
// A stored task_question of the interview.
export type QuestionRow = {
  id: number;
  round: number;
  ord: number;
  text: string;
  why: string;
  kind: "choice" | "text";
  options_json: string;
  recommended: number | null;
  answer_json: string | null;
};

// The questions that the round may ask, with each recommended index inside its options. A choice with fewer than 2 options cannot be
// a choice, so it becomes a text question. skipped: the coverage lines of what the app left out.
// rounds: Settings > Tasks "Interview rounds". A round after the last asks nothing.
export function checkQuestions(
  list: Question[],
  round: number,
  rounds: number = INTERVIEW_ROUNDS,
): { questions: Question[]; skipped: string[] } {
  const cap = round > rounds ? 0 : (INTERVIEW_QUESTIONS[Math.min(round, INTERVIEW_QUESTIONS.length) - 1] ?? 0);
  const skipped =
    list.length > cap ? [`Round ${round} may ask ${cap} questions. The app left out ${list.length - cap} more questions.`] : [];
  const questions = list.slice(0, cap).map((q): Question => {
    const options = q.kind === "choice" && q.options.length >= 2 ? q.options : [];
    const kind = options.length ? "choice" : "text";
    const recommended = kind === "choice" && q.recommended !== null && q.recommended < options.length ? q.recommended : null;
    return { ...q, kind, options, recommended };
  });
  return { questions, skipped };
}

// spec.md section 6.2: the step after an interview result of round. "ask": the questions wait for the user. "spec": the spec run
// starts. AC-B3: a result after the last round is stored, and the spec run starts anyway.
export const afterInterview = (round: number, questions: number, rounds: number = INTERVIEW_ROUNDS): "ask" | "spec" =>
  questions > 0 && round <= rounds ? "ask" : "spec";

// The run after the answers of round. done false: Claude said that the answers can raise new questions, so the next round runs first
// while rounds allows one.
export const afterAnswers = (round: number, done: boolean, rounds: number = INTERVIEW_ROUNDS): "interview" | "spec" =>
  !done && round < rounds ? "interview" : "spec";

// "Use the recommended answers": the recommended option of a choice, else no answer, and Claude decides.
export const recommendedAnswer = (q: Pick<QuestionRow, "kind" | "recommended">): Answer => ({
  choice: q.kind === "choice" ? q.recommended : null,
  text: "",
});

// The checks of one answer of the user. null: the answer is valid.
export function answerProblem(q: Pick<QuestionRow, "id" | "kind" | "options_json">, a: { choice?: number; text?: string }): string | null {
  const options = JSON.parse(q.options_json) as unknown[];
  if (q.kind === "text") return a.choice === undefined ? null : `Question ${q.id} takes text, not a choice.`;
  if (a.choice === undefined && !a.text?.trim()) return `Question ${q.id} needs a choice or a note.`;
  if (a.choice !== undefined && a.choice >= options.length) return `Question ${q.id} has no option ${a.choice}.`;
  return null;
}

// context/answers.md of a task run: the newest summary of Claude, its unknowns, and every answer. The user picked or wrote each answer,
// so the file has no UNTRUSTED banner. Claude wrote the questions, so their text stays on one line, and the notes of the user are
// indented blocks.
export function answersFile(rows: QuestionRow[], interview: TaskInterviewDto | null): ContextFile | null {
  if (!rows.length && !interview) return null;
  const out = ["# Answers", "", "The user picked or wrote each answer. An earlier interview run wrote the questions.", ""];
  if (interview) {
    out.push("## Your summary of the task", "", indentBlock(interview.summary.trim() || "(none)"), "");
    if (interview.unknowns.length) out.push("## Unknowns", "", ...interview.unknowns.map((u) => `- ${oneLine(u)}`), "");
  }
  for (const round of [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b)) {
    out.push(`## Round ${round}`, "");
    for (const q of rows.filter((r) => r.round === round).sort((a, b) => a.ord - b.ord)) {
      const options = JSON.parse(q.options_json) as { label: string; detail: string }[];
      const a = q.answer_json === null ? null : (JSON.parse(q.answer_json) as Answer);
      out.push(`### Question ${q.ord + 1}: ${oneLine(q.text)}`, "", `- Why: ${oneLine(q.why)}`);
      const picked = a?.choice === null || a?.choice === undefined ? undefined : options[a.choice];
      if (!a) out.push("- Answer: not asked. The interview had no round left.");
      else if (picked) out.push(`- Answer: ${oneLine(picked.label)}. ${oneLine(picked.detail)}`);
      else if (!a.text.trim()) out.push("- Answer: none. Decide yourself, and say so in the plan.");
      if (a?.text.trim()) out.push(picked ? "- Note of the user:" : "- Answer of the user:", "", indentBlock(a.text.trim()));
      out.push("");
    }
  }
  return { name: "answers.md", text: out.join("\n") };
}
