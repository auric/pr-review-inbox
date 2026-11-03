# Judge review points (push-back): design draft

Status: draft of 2026-11-03, written by the Plan agent against main 8d1242a. The user asked for it on 2026-11-03. The open questions at the end wait for the user. It becomes spec.md section 6.23 and tasks.md wave WPB.

I've drafted the push-back design below, ready to become spec.md section 6.23 and a tasks.md wave. It adds no new Claude run and posts nothing. Most of the context the user asked for already reaches the fix step. What is missing is the permission to disagree, a per-point verdict in the result, and a way for the next review to remember the user's decisions. The app's own review findings come first. Colleague PR comments come second, in a smaller package.

## 1. How it fits the existing code

- **Where findings enter:** `ownReview` (loop.ts:974) runs `reviewRun` (loop.ts:893). It keeps the confirmed blocker and major findings (`mustFixPoint`, tasks.ts:470) and starts one fix step with `failure: reviewFailure(must)` (loop.ts:994). Checks and a commit follow, then a new review. After `REVIEW_FIX_TRIES` = 2 (loop.ts:154), the part stops with reason `blocker`. "Fix these too" does the same for minor points (`drivePoints` loop.ts:1367, `openPoints` tasks.ts:482).
- **Context the fix step gets today** (`runStep` loop.ts:645-647): task.md and failure.md as untrusted data, plus answers.md, step.md, and every plan file. answers.md holds the interview answers and the answered loop questions, with no untrusted banner (interview.ts:68). So the plan, the design decisions, the spec, and the answers are already in the step. Earlier review outcomes are not.
- **The framing pushes Claude to comply:** failure.md says "confirmed these points. Fix the cause of each one." (loop.ts:264). The fix prompt line says "Fix the cause." (implement.ts:340). No prompt line names answers.md.
- **The result cannot disagree:** `implementResult` (task.ts:645) has no field per point.
- **A point Claude leaves unfixed always comes back:** the own review runs with `history: false` (jobs.ts:1560). So the existing "discarded by the user" rules for the finder and the verifier (catalog.ts:511-516 and 1197-1199) never apply to it.
- **The reviewer already sees the plan:** the own review gets it in its task.md (loop.ts:909-929).
- **Parts we can reuse:**
  - The question pipeline: `claude()` loop.ts:695-710, the `task_question` table, reason `question`, and `answer()` loop.ts:2104. Answers reach answers.md for every later step.
  - Notifications: notify.ts:22 fires `needs_you` for any reason that waits for the user, so a new wait notifies with no new code.
  - The discard reason codes (dto.ts:689).
  - For colleague comments: the PR Fix agent already returns `fixed:false` with a `why` (review.ts:406-427, thread-outcome.md section 3).
- **Not reused as code:** session consult verdicts (consult.ts:209) and discuss verdicts (review.ts:193). They target PR items, not task steps.

## 2. Spec text: section 6.23 Judge review points (user request of 2026-11-03)

**6.23.1 Rule.** The fix step judges each review point before it changes code. It fixes a point, or it pushes back with a reason and a proof. The user decides each push-back. Nothing goes to Bitbucket or Jira.

**6.23.2 Schema (src/shared/task.ts).**
```ts
export const PUSHBACK_WHYS = ["already", "invalid", "plan", "scope"] as const;
// implementResult adds:
points: z.array(z.object({
  id: z.number().int().describe("The point number from ./context/failure.md."),
  verdict: z.enum(["fixed", "pushback"]),
  why: z.enum(PUSHBACK_WHYS).nullable().describe("already: the code already handles it. invalid: the point is wrong. plan: the plan or an answer of the user decides otherwise. scope: the plan puts the work in another part. null for fixed."),
  reason: z.string().min(1).max(500),
  cite: z.string().max(300).default("").describe("For pushback: path:line, spec/<file>.md#<heading>, or answers.md#<round>.<question>."),
})).max(MAX_FINDINGS).default([]),
```
FindingPayload (src/shared/review.ts) adds `pushback?: {step, why, reason, cite, citeFound, fixedBy: number | null}`.

**6.23.3 failure.md.** The header changes to: "A second Claude run reviewed this part. Its check step confirmed these points. Judge each one against the code and the plan." Each point also lists "- Check: <verify.reason>" and "- Evidence: <verify.evidence>".

**6.23.4 Loop.**
1. The app reads `points`. An unknown ID drops with a step note. A missing entry gives the note "No verdict for point N", and the point counts as fixed, as it does today.
2. The checks run, and the fixes commit. A commit with no changes is skipped (worktree.ts:558).
3. With at least one push-back, the app writes one `task_question` per push-back:
   - source `loop`, kind `choice`, `point` = the review item, `recommended` null;
   - options "Accept the push-back" ("The point closes. Later reviews of this part skip it.") and "Fix it anyway" ("Claude fixes the point in the next step.");
   - text "Review point <id> (<severity>, <path>:<line>): <title>";
   - why "Claude: <reason> Proof: <cite>".

   Then it stops with reason `question`: "Needs you: Claude disagrees with N review points of part K. Judge them." No review run starts, and the round is not a `REVIEW_FIX_TRIES` try. When another part holds the reason (`held(c)`), the part halts as `claude()` does.
4. Cite check (no Claude call): `citeFound` is true when the path before ":" or "#" exists in the part worktree, or names a plan file or answers.md.
5. "Fix these too" uses the same rules.

**6.23.5 User decision (POST /api/tasks/:id/answers, no new route).**
- Accept: the review item gets status `discarded` with `discardReason`: already and invalid give `bug`, scope gives `place`, plan gives `intended`.
- Fix it anyway: the item does not change.
- A note goes to answers.md, as for any answer.
- "Use the recommended answers" with an open push-back gives 400: "Judge each push-back of Claude first."
- `openPoints` skips discarded items.
- The user can change course later with Tell Claude.

**6.23.6 Next round.**
- The build goes on as Resume does today (runPart, then ownReview).
- First, one fix step takes the "Fix it anyway" points whose `fixedBy` is null. Its commit item is `pushback`, and the commit sets `fixedBy`.
- A push-back on such a point is ignored, with the note "The user decided to fix point N."
- The next own review gets context/history.md. It lists the accepted push-backs of this part, each with "- State: discarded by the user" and "- Why: <reason>". Its size cap is `HISTORY_FINDING_BYTES`.
- The own review sets `history: true` when the file exists, so the existing finder and verify lines apply.

**6.23.7 Colleague comments.** A PR run on a PR that a task created (`task_part.pr`) gets the part plan files and answers.md text in its context/task.md, under "# The plan of the task". The same text builder serves `reviewRun`. Fix and reply runs get the plan lines of 6.23.8. A "decision" verdict makes no draft. The user decides, and the app posts only on a click (thread-outcome.md section 3).

**6.23.8 Prompt lines.** The wording follows current Anthropic guidance:
- The prompting best-practices page says to give the reason behind an instruction. It says to replace "CRITICAL/MUST" with plain words for Opus 4.5 and later. It says never to make claims about code that was not opened.
- Anthropic's personal-guidance study measured more sycophancy under pushback: 18% against 9%, driven by one-sided detail.
- So the lines give Claude both sides and present each finding as a claim, not an order.

Fix mode, only when failure.md holds review points (`implementPrompt` gets `points: boolean`):
- "./context/failure.md holds review points from a second Claude run. Each point is a claim to check, not an order."
- "Judge each point before you change code. Read the code at the point, the plan in ./context/spec/, and ./context/answers.md."
- "The approved plan and the answers of the user win over a review point."
- "Fix a point when the code shows the problem and the fix fits the plan."
- "Push back when the code already handles the point, or when the point is wrong."
- "Also push back when the plan or an answer decides otherwise, or puts the work in another part."
- "Give one entry in points for each point. Set verdict to fixed or pushback."
- "For pushback, set why, and give the reason in one or two sentences."
- "Put the proof in cite: path:line, spec/<file>.md#<heading>, or answers.md#<round>.<question>."
- "Agree with a point only when the code or the plan supports it. Push back only with proof, never to save work."
- "The user reads each push-back and decides. A wrong fix costs the user more than a push-back with a clear reason."
- "When ./context/answers.md says to fix a point anyway, fix it and do not push back again. When you cannot fix it, set question."

Fix and reply agents, only when task.md holds the plan:
- "When ./context/task.md holds the plan of the task, judge each comment against the plan and the answers of the user."
- "A comment can be right when it disagrees with the plan. Then name the plan line that it changes."
- Fix agent only: "When a comment asks to undo a plan decision, set fixed to false with why decision. Name the plan heading in reason."

**6.23.9 Caps.**
- No new run and no new turn cap. Fix steps keep `STEP_TURNS.fix` = 40.
- reason: 500 characters. cite: 300 characters. points: at most `MAX_FINDINGS`.
- history.md: `HISTORY_FINDING_BYTES`.

**6.23.10 Data.** Migration `0NN_task_question_point.sql`, at the next free number (044 today): `ALTER TABLE task_question ADD COLUMN point INTEGER REFERENCES review_item (id) ON DELETE SET NULL;`. TaskQuestionDto adds `point: {id, severity, path, line, text, check, why, reason, cite, citeFound} | null`.

**6.23.11 Acceptance criteria.**
1. AC-B105. A review fix step gets the new failure.md with the check reason and the evidence. Only then does the prompt hold the point lines. A fix step for red checks keeps its prompt (tests/tasks/implement.test.ts).
2. AC-B106. Unknown IDs drop with a note. A missing entry gives "No verdict for point N" and counts as fixed (tests/tasks/pushback.test.ts).
3. AC-B107. A push-back gives checks, a commit, one question per push-back with `point` set and `recommended` null, and the reason text. No review run starts, and the try count does not change (pushback.test.ts).
4. AC-B108. `citeFound` is false for a path that is not in the worktree, the plan files, or answers.md (pushback.test.ts).
5. AC-B109. Accept discards the item with the mapped reason. Fix keeps it. The recommended shortcut gives 400. answers.md lists the push-back, the answer, and the note (pushback.test.ts).
6. AC-B110. After the answers, a fix step for the forced points runs first and commits as `pushback`. A push-back on a forced point is ignored with the note (tests/tasks/loop.test.ts).
7. AC-B111. The next own review holds history.md with "discarded by the user". The finder and verify prompts hold the history lines (tests/review/jobs.test.ts or tests/review/history.test.ts).
8. AC-B112. "Fix these too" judges its points in the same way (loop.test.ts).
9. AC-B113. A PR run on a task-created PR holds the plan section, and the fix and reply prompts hold the plan lines. Other PRs get neither (tests/review/*).
10. AC-B114. The push-back card shows the point, the check, Claude's reason, the cite, and the cite warning. No option is preselected. The primary button says "Judge the push-backs". One notification fires (tests/e2e/task-pushback.e2e.ts).
11. AC-B115. Push-back answers send no request to the fake Bitbucket or the fake Jira (task-pushback.e2e.ts).

## 3. tasks.md wave WPB (run in this order, one implementer at a time)

**WP-PB-D. Docs (implementer)**
- Files: spec.md (section 6.23, plus edits to sections 6.5 to 6.7, 8, and 10), tasks.md, BRIEF.md (part 6), CLAUDE.md status line, docs/smoke-task.md part PB.
- Tests: none.
- Done check: no real names; every sentence has 20 words or fewer; no hard wraps.

**WP-PB1. Judge points in the fix step: server (implementer-xhigh)**
- Files: src/shared/task.ts, src/shared/review.ts, src/shared/dto.ts, the new migration, src/server/tasks/loop.ts (`reviewFailure`, a shared `judgePoints` used by `ownReview` and `drivePoints`, the forced fix, `answer()`, `reviewRun` passes history.md), src/server/tasks/implement.ts (`implementPrompt`), src/server/tasks/tasks.ts (question insert with `point`, `openPoints` filter, exported plan text builder), tests/support/fake-claude.ts (a `pushback` scenario), tests/tasks/pushback.test.ts (new), loop.test.ts, implement.test.ts.
- Behavior: AC-B105 to AC-B110 and AC-B112.
- Control mutation: count a push-back as fixed. The AC-B107 test must fail.
- Risk: the try count after Resume. Today `ownReview` restarts at 0, and the plan relies on that.

**WP-PB2. Review and PR runs learn the decisions (implementer)**
- Files: src/server/review/jobs.ts (`taskReviewSteps` sets history when history.md exists; the PR run task.md at jobs.ts:766 adds the plan section), src/server/review/catalog.ts (plan lines and a `plan` flag on RunFiles), tests/review/*.
- Behavior: AC-B111 and AC-B113.
- Risk: a large plan inflates task.md. It reuses the cap that `reviewRun` uses (unverified that one exists).

**WP-PB3. Push-back UI (implementer; skills shadcn, vercel-react-best-practices, web-design-guidelines)**
- Files: src/web/tasks/Questions.tsx, src/web/tasks/model.ts, tests/web/tasks-model.test.ts, tests/e2e/task-pushback.e2e.ts, tests/e2e/serve.ts. Also README.md and the screenshots if a shot shows the questions screen.
- Behavior: AC-B114 and AC-B115.

**Gate UPB (user):** smoke-task.md part PB. Plant a plan decision, and let the review contradict it. Record the push-back, Accept, a second review with no repeat, Fix it anyway, and the fix turn count.

## 4. Open questions (recommended answer for each)

1. Should a push-back stop the part until the user judges? Yes. It is the one point where two runs disagree.
2. Should the push-back card preselect an option? No. Neither run has more authority than the other.
3. Should the fix turn cap stay at 40? Yes for now. Raise it to 60 if Gate UPB shows the cap is hit.
4. Should accepted push-backs count as user discards in the stats and the review v3 eval set? Yes. `payload.pushback` lets the eval filter them.
5. Should the app auto-accept a repeat push-back that cites an earlier accepted answer? No, not in version 1.
6. Should history.md cover one part or the whole task? One part, because each review covers one part diff.
7. AC numbers: spec.md 6.22.14 reserves AC-B104 and up for section 6.21. This section takes AC-B105 to AC-B115, so 6.21 gets only AC-B104 unless one section is renumbered.
8. Colleague comments: should this wave only add the plan to PR runs? Yes. Queued item 3 (PR threads into Tell Claude, fix commits into the part worktree) stays separate and reuses `points` later.

Things I did not check:
- Whether Questions.tsx can show a note box together with a choice. `answerProblem` allows both, but the UI may not.
- Whether `reviewRun` caps the plan text.
- Whether task review runs count in the review stats.

Main risk: zod `.min(1)` on reason relies on the CLI `--json-schema` check to make the model comply. A run that ignores it fails the step instead of showing the push-back.

CodeGraph: used 4 times
## User decisions (2026-11-03)

- The user agreed to the flow: judge each point, push back with a reason and a proof, one question per push-back.
- "Fix it anyway" is final for that point. The next fix step must fix it and must not push back on it again. When Claude cannot fix it, it sets question.
- PR runs on a PR that a task created get the plan files and the answers of the user (answers.md), not only the plan.
- Open questions 1 to 4 of section 4 take the recommended answers, unless the user says otherwise.
- Answers of 2026-11-03 to section 4: Q1 yes (a push-back stops the part). Q2: raise STEP_TURNS.fix to 60, and the work of a step that reaches its turn cap must not be lost (design pending). Q3 yes. Q4 one part. Q5 no auto-accept. Q6 yes, and the colleague comment part ships soon.
