# Fewer review questions

Status: design of 2026-11-13. Code complete in the same package. spec.md section 1 holds the criteria AC-R32 to AC-R38. REVIEW_PROMPT_VERSION is "2.7".

## User feedback

The user, 2026-11-13: "I don't like that every review has questions. The review should try to find the answers itself before asking. It should use the Jira MCP if needed (and if it is installed) to check whether the acceptance criteria are covered. It should ask a question only if it was not able to find the answer itself. It is lazy."

User decisions:

1. The verify phase also checks every question of the finder.
2. MCP tools keep today's rule: any picked tool without a blocking mark may run, and the prompt says read only.
3. Settings, Review quality gets question counts.

## Where questions come from

- **A, the finder.** rl-main and the salvage run write `questions[]` (catalog.ts finderRules, `main` true). rl-reviewer has no questions field. Before 2.7, these questions skipped the verify phase: `settle` added them to the items as they were, and candidates.md held only findings.
- **B, the question verdict.** The verify phase gives `question` for a finding candidate. `capOf` turns it into a question item.
- **C, no trigger.** A finding candidate with an empty trigger and no `confirmed` verdict becomes the question "No concrete case was named." (`capOf`).
- **D, the Explain lens.** "Ask a question where the intent is not clear." It is out of scope, because a change needs a PROFILES_VERSION step.

## Rules

### Finder (rl-main and salvage)

- "When you cannot name a trigger, search the code for one. When you still cannot name one, write a question for the author."
- "Before you ask a question, look for the answer yourself. Read the changed code, its callers, its tests, its config, and the files in ./context."
- "When you find the answer, ask nothing. When the answer shows a defect, report a finding with that evidence."
- "Put a point into questions only when no file and no tool of this run gives the answer. In why, name what you checked and why it did not answer the point."

### Finder questions in the verify phase

- candidates.md holds each finder question as a block "## Question N" after the finding candidates. N continues after the last candidate number, so it never repeats a finding number. The verdict names it in `candidate`.
- The byte cap of candidates.md (200 KB) covers both kinds. The finding blocks come first. All blocks together stay at MAX_FINDINGS, the cap of `verdicts`.
- The verify phase also runs when the finder gave questions and no finding.
- The verdict schema gets one nullable key `finding`: path, side, line, lineEnd, anchorText, title, and body. Its default is null, so older results stay valid.
- The verdict of a question block gives this result:

| Verdict | Result |
|---|---|
| refuted: the code or the task text answers it, with no defect | The question drops. Its text and the answer (reason) go to `summary.finderQuestions.answers`. Nothing is posted. |
| confirmed with a `finding` that anchors on the change | A finding item. Severity: the verdict. Title, place, and body: `finding` (body falls back to the reason). Trigger: empty, because the check reason holds it and the card shows it once. Evidence: the verdict evidence. Category "question", module core, evidenceStatus code, confidence high, verify mark confirmed. |
| confirmed without `finding`, or a place that the validator drops | The question stays. Its why is the verdict reason. |
| question | The question stays. Text: the verdict question, else the finder text. Why: the verdict reason, else the finder why. |
| unsure, duplicate, or no verdict | The finder question stays as it is. |

- The app anchors the place of a confirmed question with the finder validator (`placeAnswers` in judge.ts) in the verify phase, which has the workspace. `settle` stays synchronous.
- A question without a verdict never goes to `coverage.skipped`. Before 2.7 such a question had no check, and the run was complete. A fake verify result or a fixed one with no question verdict keeps that behavior.
- Question verdicts do not count in `summary.verify`. That summary counts finding candidates only.
- A run with the verify phase off keeps every finder question as before.
- A running check says "Checking N questions…" when it checks no finding.

### Verifier (rl-verify and rl-verifier)

- "question: only the author can answer the point, and no file or tool of this run answers it. Write the question in question. In reason, name what you checked."
- "When the code or the task text answers the point, give confirmed or refuted, not question."
- "For a candidate without a trigger, look for one. When you find it, give confirmed, and put the trigger into reason."
- Only when candidates.md holds questions: the question block lines, the place rules of the finder, and the exception to "Look for no new problems" for a defect that answers a question. A defect that a candidate already reports gets refuted with the candidate number in reason.
- Only with questions and more than VERIFY_SPLIT blocks, the delegation adds: "Give the questions to the rl-verifier agent too. Each question counts as one candidate of its call." Without it, a question gets no call and no verdict. The split, the turn cap, and the task line count candidates and questions together.

### Issue tools

- `withMcp` gets an `issues` flag. The review finder (rl-main and rl-reviewer), the verify phase, the salvage run, and the own review of a task set it. Explain, Ask, Fix, Discuss, reply runs, and task steps do not.
- With at least one picked MCP tool, the flag adds: "Find the tools in this list that read issues from the issue tracker. Use them to read the tasks of this change and their acceptance criteria. The Metadata section and the files in ./context name the tasks. Use these tools only to read. Never create, edit, move, or comment through them. A task key of this change may go into a query to such a tool."
- The task named "the Task IDs line". That line is only in the stdin of the main process, and it says "none" in the own review of a task. Subagents read task.md and pr-context.md instead. So the lines name the Metadata section and the files in ./context.
- REMOTE_RULE stays. With the flag, the remote line adds: "The one exception is a task key of this change in a query to an issue tool."
- No code names an MCP server. The model decides which picked tool reads issues.

### The intent module ("Matches the task")

- "List each acceptance criterion of the tasks. When task.md does not hold them, read them with an issue tool, if the MCP list has one."
- "Report a stated requirement or acceptance criterion that the change does not meet. Quote it in evidence."
- "Put a criterion that the code cannot show into coverage notChecked, with the reason."
- `coverage.notChecked` shows in the run line as "Also not done, by design" and does not make the run incomplete.

## Measure

`summary.finderQuestions` of a review run (summary_json, no migration): `asked`, `answered`, `findings`, `kept`, and `answers` (text and answer of each dropped question). `asked` is answered + findings + kept. Runs before 2.7 have no key. Settings, Review quality sums the counts per profile and prompt version and shows "Questions: N asked, A answered, F to findings, K kept" in the Check cell. The own review of a task stays out of the stats.

## Acceptance criteria

- AC-R32. The finder rules above are in rl-main and in the salvage run, not in rl-reviewer. REVIEW_PROMPT_VERSION is "2.7".
- AC-R33. candidates.md holds a "## Question N" block for each finder question after the finding candidates, with N after the last candidate number. The byte cap and MAX_FINDINGS cover both kinds. A finder result with questions and no finding starts the verify phase.
- AC-R34. A question block gets the result of the verdict table above. No verdict never makes the run incomplete. Question verdicts do not change `summary.verify`.
- AC-R35. rl-verify and rl-verifier hold the three verifier lines above. The question block lines are only in a prompt whose candidates.md holds questions. Above VERIFY_SPLIT blocks, the delegation also names the questions.
- AC-R36. With picked MCP tools, the issue lines and the remote exception are in the review finder, the verify phase, the salvage run, and the own review of a task, and in no other run. Without picked tools, no run has them.
- AC-R37. The intent module holds the three acceptance criterion lines.
- AC-R38. `summary.finderQuestions` holds the four counts and the answers. Review quality shows the sums per profile and prompt version. A group without a 2.7 run shows no question line.

## Out of scope

- Source D, the Explain lens. It needs a PROFILES_VERSION step.
- Duplicate checks between questions, and between a question and a finding candidate. A duplicate verdict on a question reads as unsure.
- A view of the dropped questions and their answers. They stay in summary_json and in the raw output of the check.
- BRIEF.md section 7 (the Prompt item) still states the remote query rule without the task key exception.
