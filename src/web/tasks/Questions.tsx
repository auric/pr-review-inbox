// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Questions form (docs/plans/review-v2/spec.md sections 6.12 and 7.1, AC-UX5): each question with "Why it matters", radio
// buttons with the recommended option preselected and labeled, an optional note, "Send answers", and "Use the recommended answers".
// The answered questions of earlier rounds show below as a read-only list.
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { MAX_TASK_ANSWER, type TaskAnswersInput, type TaskQuestionDto } from "../../shared/dto";

type Pick = { choice: number | null; text: string };

const start = (qs: TaskQuestionDto[]): Record<number, Pick> =>
  Object.fromEntries(qs.map((q) => [q.id, { choice: q.kind === "choice" ? q.recommended : null, text: "" }]));

// The answers of the form: a choice question sends its option and its note, a text question its text. A choice without an option
// and without a note gets an error line.
export function answersOf(qs: TaskQuestionDto[], picks: Record<number, Pick>): TaskAnswersInput["answers"] | { missing: number } {
  const out: TaskAnswersInput["answers"] = [];
  for (const q of qs) {
    const p = picks[q.id] ?? { choice: null, text: "" };
    const text = p.text.trim();
    if (q.kind === "choice" && p.choice === null && !text) return { missing: q.id };
    out.push({ question: q.id, ...(q.kind === "choice" && p.choice !== null && { choice: p.choice }), ...(text && { text }) });
  }
  return out;
}

export function QuestionsForm(props: {
  questions: TaskQuestionDto[];
  // spec.md section 6.25.6: the part of each loop question in a task with sub-tasks.
  label?: (q: TaskQuestionDto) => string | null;
  busy: boolean;
  onSend: (answers: TaskAnswersInput["answers"]) => void;
  onRecommended: () => void;
}) {
  const { questions } = props;
  const [picks, setPicks] = useState(() => start(questions));
  const [missing, setMissing] = useState<number | null>(null);
  const set = (id: number, p: Partial<Pick>) => setPicks((all) => ({ ...all, [id]: { ...(all[id] ?? { choice: null, text: "" }), ...p } }));
  const send = () => {
    const a = answersOf(questions, picks);
    if ("missing" in a) {
      setMissing(a.missing);
      document.getElementById(`tq-${a.missing}-0`)?.focus();
      return;
    }
    setMissing(null);
    props.onSend(a);
  };
  return (
    <form
      id="task-questions"
      aria-label="Questions"
      className="grid max-w-[72ch] gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {questions.map((q, i) => {
        const p = picks[q.id] ?? { choice: null, text: "" };
        const why = `tq-${q.id}-why`;
        const part = props.label?.(q);
        return (
          <FieldSet key={q.id} className="gap-2" data-invalid={missing === q.id || undefined}>
            <FieldLegend className="text-sm font-semibold">
              {questions.length > 1 && <span className="mr-1 text-muted-foreground">{i + 1}.</span>}
              {part ? (
                <Badge variant="soft" className="mr-1.5 align-middle">
                  {part}
                </Badge>
              ) : null}
              {q.text}
            </FieldLegend>
            <FieldDescription id={why} className="m-0 text-sm">
              Why it matters: {q.why}
            </FieldDescription>
            {q.kind === "choice" ? (
              <>
                {q.options.map((o, k) => (
                  <label
                    // biome-ignore lint/suspicious/noArrayIndexKey: the option index is its identity; the answer sends it.
                    key={k}
                    className="-mx-1.5 grid min-h-6 cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-[5px] px-1.5 py-1 hover:bg-hover"
                  >
                    <input
                      id={`tq-${q.id}-${k}`}
                      type="radio"
                      name={`tq-${q.id}`}
                      checked={p.choice === k}
                      aria-describedby={why}
                      className="m-0 mt-[3px] size-4 accent-foreground"
                      onChange={() => set(q.id, { choice: k })}
                    />
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                      <span className="font-medium">{o.label}</span>
                      {q.recommended === k && <Badge variant="soft">Recommended</Badge>}
                    </span>
                    {o.detail && <span className="col-start-2 text-xs text-muted-foreground">{o.detail}</span>}
                  </label>
                ))}
                <div className="grid gap-1 text-sm">
                  <label htmlFor={`tq-${q.id}-note`} className="text-ink-2">
                    Add a note (optional)
                  </label>
                  <Textarea
                    id={`tq-${q.id}-note`}
                    rows={2}
                    maxLength={MAX_TASK_ANSWER}
                    value={p.text}
                    className="min-h-14"
                    onChange={(e) => set(q.id, { text: e.target.value })}
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-1 text-sm">
                <label htmlFor={`tq-${q.id}-0`} className="text-ink-2">
                  Your answer (optional: without one, the plan says what it picked)
                </label>
                <Textarea
                  id={`tq-${q.id}-0`}
                  rows={3}
                  maxLength={MAX_TASK_ANSWER}
                  value={p.text}
                  aria-describedby={why}
                  onChange={(e) => set(q.id, { text: e.target.value })}
                />
              </div>
            )}
            {missing === q.id && (
              <p role="alert" className="m-0 text-sm text-destructive">
                Pick an option or add a note.
              </p>
            )}
          </FieldSet>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        {/* spec.md section 7.1, AC-UX1: the header holds the one primary button ("Answer N questions"). */}
        <Button type="submit" variant="outline" disabled={props.busy}>
          Send answers
        </Button>
        <Button type="button" variant="outline" disabled={props.busy} onClick={props.onRecommended}>
          Use the recommended answers
        </Button>
      </div>
    </form>
  );
}

// The answered questions, oldest round first.
export function AnsweredList({ questions }: { questions: TaskQuestionDto[] }) {
  const done = questions.filter((q) => q.answer !== null);
  if (!done.length) return <p className="m-0 text-sm text-muted-foreground">No question is answered yet.</p>;
  return (
    <dl className="m-0 grid max-w-[72ch] gap-3">
      {done.map((q) => {
        const a = q.answer as NonNullable<TaskQuestionDto["answer"]>;
        const picked = a.choice === null ? null : (q.options[a.choice]?.label ?? null);
        return (
          <div key={q.id} className="grid gap-0.5">
            <dt className="text-sm font-medium">{q.text}</dt>
            <dd className="m-0 text-sm text-ink-2">
              {picked ?? (a.text ? null : "No answer. The plan says what it picked.")}
              {picked && a.text ? " " : null}
              {a.text && <span className="whitespace-pre-wrap">{picked ? `Note: ${a.text}` : a.text}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
