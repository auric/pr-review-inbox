# PS5 plan: the Task view and the test data of part sessions

PS5 builds the web side of the part session and repairs the test data that PS3 broke. It is planned against branch ps1 at 28fba5d. For files that PS4 changes (loop.ts, implement.ts, tasks.ts, jobs.ts, routes.ts, shared/task.ts, shared/dto.ts, fake-claude.ts), the plan names symbols, not lines. Section 9 of part-session.md comes from main.

## 0. Scope

| Item | Package |
|---|---|
| e2e and demo keys (`implement:build`), the removed tests step, the size stop, and the "Task step time" field | PS5-A (can start now) |
| Setting "Resume by itself after a usage limit" | PS5-B |
| Resume options `without` and `setup`, the tick and try facts, PATCH_LOST in shared, the held and armed row status | PS5-S1 |
| Rows of 2.17 and 9.6: phase, Hold, Skip, Start again, Continue with part, usage armed or disarmed, push-back questions, "Go on without these fixes", size note, PATCH_LOST text, Log session groups, Plan tab ticks | PS5-C |
| Removal of `/pause`, `/dismiss`, `/parts/:part/setup`, and the `keep` variant of `/limit`; the route grid test | PS5-S2 |
| New `task-session.e2e.ts`, and new labels in the existing e2e | PS5-E |
| Screenshots, README, CHANGELOG, spec.md 6.28 PS5 lines | PS5-D |
| Live message box hint (needs PS4 WP-7 and gate U104) | PS5-C, only if WP-7 lands |

## 1. Verified facts and gaps

1. Test keys. The fake CLI keys an implement run as `implement:<mode>` from the `- Mode:` line (fake-claude.ts `callKey`). implement.ts `modeLine` prints `build` for mode implement. task-base, task-repos, task-setup, task-shell, task-small, task-subtasks, task-tell (`tests/e2e/*.e2e.ts`) and `scripts/demo.ts` still use `"implement:tests"` and `"implement:implement"`. The unit tests use `implement:build` with `ticks: { path: "*", ids: ["*"] }` (tests/tasks/loop-fixture.ts `TICK`).
2. task-small e2e is stale. It expects the size stop and "Keep one PR", "Red as expected" from the removed tests step, and "Task step time" with `stepMinutes`/`partMinutes`. RUN_LIMITS now has `sessionContextCap` and `sessionTurns`, and no key can be off, so the "No limit" box in `RunLimits.tsx` is dead code.
3. No tick source. `plannedTasks` (PlanTab.tsx) marks a task done from the stored plan or from a commit row whose item is the task ID. PS3 commits one row per gate with item `build`, `checks`, or `review`, and writes the ticks only into the commit message. So the Plan tab never ticks for a PS3 build. The live tick read of design 2.4 is not built.
4. No phase in the DTO. The phase lives only in the build driver context (loop.ts `Ctx.phase`). `StepDetail.session` is written at `endStep`, so a running row has no `purpose`. The web takes the phase from the step kind and item (ps4-plan 2.5).
5. No try or round count. `greenOrFix` keeps `tries` in a local variable, and `reviewRound` keeps `c.rounds` in memory. "(try 1 of 3)" and "(round 1 of 2)" need a stored fact.
6. The web has no rows for the new reasons. `usage`, `held`, `stuck`, and `unfinished` fall into the `default` branch of `taskView` ("Resume"). In a one-part task, held lives in `part.blocked` while `t.blocked` is null, so the view says the part is building. `subtaskView` shows a held part as a waiting reason.
7. PATCH_LOST (`"no file: the app could not save them"`, implement.ts) is compared in loop.ts. LogTab.tsx and TaskView.tsx render it as "saved in no file: ...".
8. The web still calls the old routes (data.ts: pause, dismiss, both `limit` variants, `parts/:part/setup`). The typed client stops compiling when a called route goes away.
9. "Run setup again" has no replacement yet. build-redesign Q6 (user answer 2026-11-11: yes) and 9.4 row red/setup make it a resume option `setup` that deletes the setup mark. PS4's `taskResumeInput` refuses `part` together with an option.
10. The size note needs a route. Design 2.6 item 7 and build-redesign Q1 give the size note a "Change the limit" link. No Settings screen has a line budget field. `loop.limit` refuses without a size reason. So `/limit` stays, with lineBudget only.
11. `without` needs a stored fact. `reviewDue` is true while an own review after the newest commit holds a `mustFix` point (confirmed blocker or major). Without a stored fact, GO starts the review again after "Go on without these fixes", and `openPoints` hides the points. Q-SM8 is answered ("Q3 yes" in build-redesign.md), so the "Not verified" note in 9.4 is stale.
12. Questions in ready. `Content` reads `loop = t.state === "implementing"`, so a push-back question in ready reads the interview questions.
13. The clock stops. `useTick` runs only while a step runs. The usage label must change from "Resume at 14:30" to "Resume" with no step running.
14. Test rules. `tests/ui/names.test.ts` forbids product names in `src/web`, so runner and forge names come from meta. `tests/web/ui-words.test.ts` forbids the bare words phase, gate, verdict, candidate, stack, slice, module, and idem in `src/web/tasks` code, including identifiers. No variable can be named `phase`.
15. The usage fixture is in the past (`fixtures/claude-synthetic/usage-limit.jsonl`, `resetsAt` 2026-10-11). An e2e of "Resume at <time>" needs a future time.
16. Order. ps4-plan WP-6 and AC-B365 need green e2e and demo. PS5-A owns that repair, so PS5-A runs before PS4 WP-6.
17. Tasks list row. `rowStatus` (shared/task-status.ts) never sees held, and it shows "Needs you: the usage limit" also when the resume is armed.
18. REASON_EXITS labels are doc labels, and some name a product. The web must not render them.

## 2. Decisions (accepted by the user on 2026-11-13)

- D1. `/limit` stays with `{version, lineBudget}` only. The `keep` variant goes. It works in implementing and ready while no driver runs, with no size reason. It sets the task lineBudget and starts nothing.
- D2. Resume option `setup` takes `part`. `part` with any other option gives 400. `part` with no option names a held part.
- D3. `without` sets `payload.skipFix = true` on each mustFix item of the newest own review of the part. `mustFixPoint` returns false for skipFix. Then `reviewDue` is false, `openPoints` lists the items under "Fix these too", and nothing posts them. In implementing, the driver goes on to REVIEWED. In ready, it restores `blockedBefore` as leave does.
- D4. Phase map `rowPhase(step)` in `src/shared/task-status.ts`: implement, tests → building; fix with item points or pushback → following; fix with item review or critic → judging; other fix → fixing; instruct → following; check with item setup → setup; check with item base → baseline; other check, and commit → checking; review with item critic → critic; other review → reviewing; update → updating; resolve → resolving; anything else → null (idle).
- D5. New StepDetail fields, no SQL: `ticked: string[]` on build, fix, and instruct run rows and on commit rows; `tries: {n, of} | null` on fix rows (checks: tries+1 of "Test-fix tries"; review: rounds+1 of REVIEW_FIX_TRIES). The live tick read per Edit event stays deferred.
- D6. TaskRowDto.progress gets `held: number`. rowStatus shows "On hold" (needsYou false) when blocked is null and held > 0, and "Resumes after the usage limit" (needsYou false) for usage with armed true.
- D7. Labels: leave is "Leave it". Disarm is "Cancel the resume". The usage primary is "Resume at <time>", else "Resume". The critic row in the Log is "Quick review".
- D8. Stop stays in More for held and red/update. Rule 9.4 ("Stop for every reason except update") wins over shorter REASON_EXITS lists.
- D9. The web keys every row on kind, cause, armed, and resumeAt, never on `b.text`. It shows `b.text` for the server reason rows, and builds its own text for the usage, held, and working rows.

## 3. View rows and texts

`<R>` is `meta.runner.short`, `<forge>` is `meta.forge.name`. `<ref>` is "part k" in a task with several parts, the part label with sub-tasks, and "your change" in a one-part task. "unpushed" means `part.pushed === null` and no PR row of the part has `pushed` set.

Working rows (`primary` null, `running` true):

| Phase | Status | More |
|---|---|---|
| building | "<R> builds <ref>: 3 of 5 tasks done." (no count when the plan lists no task) | Hold, Stop |
| checking | "The app runs the checks of <ref>." | Stop |
| fixing | "<R> fixes the checks of <ref> (try 1 of 3)." (no brackets when `tries` is null) | Hold, Stop |
| critic, reviewing | "A second <R> run reviews <ref>." | Stop |
| judging | "<R> works on the review points of <ref> (round 1 of 2)." | Hold, Stop |
| following, instruct | "<R> works on your instructions for <ref>." | Stop |
| following, fix points | "<R> fixes the listed points of <ref>." | Stop |
| following, fix pushback | "<R> fixes the review points that you chose to fix for <ref>." | Stop |
| setup | "The app runs the setup commands of <ref>." | Stop |
| baseline | "The app runs the checks on the base of <ref>." | Stop |
| updating, resolving | `updateSentence` as today | Stop |
| slot | `b.text` as today | Stop |

"Pause after this step" goes everywhere.

Idle rows:
- Ready: "<Ref> is ready: 5 tasks, 340 lines, checks green." (omit null facts). Primary stays "Open the PR" or "Open PR for part k of n". More: Show the diff, "Fix these too" (when points exist), "Start this part again" (unpushed).
- Unpushed, no replies: "<Ref> has new commits that are not on the server yet." Primary "Push to <branch>" (`POST /parts/:part/push`). More: Show the diff, Go to the PR, Close the task.
- On hold: "<Ref> is on hold. Its work is kept." Primary "Continue" (resume with `part`). More: "Skip this part" (sub-tasks only), "Start this part again" (unpushed), Stop.
- Usage, armed false: "Your <R> usage limit is reached. It resets at <time>." (no resumeAt: first sentence only). Primary "Resume at <time>" while now < resumeAt, else "Resume". More: Stop.
- Usage, armed true: "<R> resumes at <time>." (past time: "<R> resumes now."). No primary. More: "Cancel the resume", Stop.
- `<time>`: same day `toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})`; other day `toLocaleString([], {dateStyle: "medium", timeStyle: "short"})`.
- Blocker: `b.text`. Primary Continue. More: "Go on without these fixes", See why, Stop, "Leave it" in ready.
- Other Needs-you reasons (red/checks, question/no_change, error/run, error/restart, stuck/*, unfinished, denied_path/*, question/red_before): `b.text`. Primary "Continue". More: "Start this part again" (RUN_ENDS and KEPT keys, unpushed), See why (when the reason names a step), Stop, "Leave it" in ready.
- Rows that stay: spec_change ("Review the change", Reject, Stop); allow ("Continue" submits the allow form); question/claude with open loop questions ("Answer the question", or "Judge the push-back" / "Judge N push-backs" when each open question has a point); red/setup_time ("Change the time limit"); preflight ("Try again" or "Pick a base branch"); update ("Try again", Go to the PR or Show the diff, "Leave it" in ready); error/lower_repo ("Wait for the merge"); size/large_repos (primary Stop); legacy kinds budget, size, push, question/task_done, question/paused ("Continue" and Stop).
- Ready state: the `loopOnly` filter and Dismiss go. PS4 makes Continue work in ready (AC-B344). "Leave it" replaces Dismiss.
- Stopped (build): "Stopped at <ref>. The work is kept." (one part: "Stopped. The work is kept."). Primary "Continue". More: "Start this part again" (unpushed part with a worktree), Close the task. Interview and spec stops keep the `stoppedAt` text, with the label "Continue".

## 4. Items

Status: PS5-C (C1, C2a, and C2b) is built in 171c5c3 and f6a1c5f. Deviations of C2b from the items below:
- The flag `instructRun` is on TaskPartDto, one value for each part. The routes set it from loop.ts `instructRun` while the loop works.
- `instructRun` predicts "queued" only with the live gate off. It gives null while a follow-up or other mode driver works, or while a message of the part waits.
- With a first reason, "Run setup again" shows only for the red setup reason of the same part. With no reason, it shows for a part with a worktree while nothing runs.
- See why shows on the rows that keep it (section 3, REASON_EXITS) only when the reason names a step. This applies to the blocker row too.
- "Leave it" follows the server rule of loop.ts `leaveReason`: each reason row in ready, except the form reasons, slot, usage, and red/setup_time.
- The `T<ord>.` task filter of `plannedTasks` applies only with sub-tasks. Without sub-tasks, each part lists all tasks of the plan (open question 5).
- The box reasons stay the server `BOX_REASONS` (tasks.ts): red, size, blocker, denied_path, and update. The exclusion list of 4.10 does not apply.

4.1 Phase of each part (PS5-C)
- `model.ts`: import `rowPhase`; rewrite the implement, fix, check, review, and commit cases of `stepSentence` to the table above; tick count from `plannedTasks`; `tries` from the row detail.
- `partRow` implementing gives short texts: "<R> builds it: 3 of 5 tasks done.", "The app runs the checks.", "<R> fixes the checks.", "A second <R> run reviews it.", "<R> works on the review points.", "<R> works on your instructions.", "The app runs the setup commands.", "On hold. Its work is kept."
- `PlanTab.tsx` `PlanParts`: a working part gets a quiet `Badge` from a `STAGE_TEXT` record: building "Building", checking "The checks run", fixing "Fixing the checks", critic "Quick review", reviewing "Own review", judging "Review points", following "Your instructions", setup "Setup", baseline "Checks on the base", updating "Update", resolving "Conflicts".
- Tests in `tests/web/tasks-model.test.ts`: one per working row, in the one-part, several-part, and sub-task forms; a table test for `rowPhase`. Control mutation: map fix item `review` to fixing; the judging test turns red.

4.2 Hold, Continue with part, Skip, Start again (PS5-C)
- `model.ts` `ActionKind` adds `hold`, `continue-part`, `skip`, `restart`, `cancel-resume`, `without`, `leave`; drops `pause`, `dismiss`, `keep-size`; `continue` merges into `resume`; `change-limit` stays.
- `taskView` and `subtaskView` check `part.blocked?.kind === "held"` before the working rows and the waiting-reason branch.
- `data.ts` `TaskAction`: `{kind: "resume"; option?: "leave" | "disarm" | "without" | "setup"; part?: number}`, `{kind: "hold" | "skip" | "restart"; part: number}`; remove `pause`, `dismiss`, `keep`, `setup`; keep `limit` with lineBudget.
- `TaskView.tsx` `run()`: hold sends; continue-part resumes with `part`; skip and restart open `ConfirmDialog` (SubtaskList.tsx).
  - Skip: title "Skip <name>?", text "The app saves the work of <name> as a patch and removes its worktree. It opens no PR for it. Nothing goes to <forge>.", button "Skip this part".
  - Restart: title "Start <ref> again?", text "<R> starts <ref> again from the plan. The app keeps the old work as a patch and as a backup branch in the app cache. Nothing goes to <forge>.", button "Start again".
- The sub-task `partAction` list adds hold, skip, and restart.
- Keyboard: Enter runs the primary; More is the Radix `DropdownMenu`; the confirm closes on Esc and Cancel sends nothing; after Hold the focus moves to "Continue" (add `part?.blocked?.kind` to `mark`).
- Tests: On hold rows in one-part, several parts, sub-tasks, and stopped; "Start this part again" only when unpushed; Skip only with sub-tasks. Control mutation: held check after the waiting-reason branch turns the sub-task held test red.

4.3 Usage reason and the setting (PS5-C, PS5-B)
- `model.ts`: `resetText(ms, now)` and the usage rows. `useTick` also ticks while a usage reason exists, so the label changes with no reload.
- Arm: plain resume before resumeAt. Run: plain resume after resumeAt. Disarm: `option: "disarm"`.
- `RunLimits.tsx` (PS5-B): a `Switch` Field with the `SessionSwitch` pattern (Clones.tsx) and `useSaveSettings`: `id="usage-resume"`, label "Resume by itself after a usage limit", help "Off by default. When on, a part waits for the reset time that <R> reports, then goes on once. A second limit waits for your click." It saves `{baseUrl, caFile, usageResume}`. Remove the dead "No limit" code (`offs`, `isOff`, `f.off`).
- Tests: model cases (armed false before and after resumeAt, no resumeAt, armed true, armed true with a past time, a reset on another day); the task-small e2e settings block checks the switch. Control mutation: `<` for `>=` in the label flip.

4.4 Critic and push-back questions (PS5-C)
- `LogTab.tsx` `StepBody`: a review row with item critic shows "Quick review".
- `Questions.tsx` `QuestionsForm` gets `noRecommended` (any open question has `point`), which hides "Use the recommended answers".
- A point card shows the legend `q.text`, "Check: <point.check>", "Reason: <point.reason>", "Proof: <cite>" in `code` with `translate="no"`, and, when `citeFound` is false, a warning line with a `TriangleAlert` icon (aria-hidden): "The app did not find this place in the code or the plan." All lines tie in with `aria-describedby`. Options come from the server ("Accept the push-back", "Fix it anyway") with no preselection. `answersOf` asks for a choice: "Pick one option."
- `TaskView.tsx` `Content`: `loop = t.state === "implementing" || t.state === "ready"`.
- Tests: `pointLines(q)`, the hidden recommended action, the ready-state questions screen. Control mutation: drop `noRecommended`.

4.5 "Go on without these fixes" (PS5-S1 server, PS5-C web)
- Server: D3. Web: More item on blocker, resume with `option: "without"`. The points box on the ready screen gets the heading "<R>'s own review left <n> points:" and the button "Fix these too".
- Tests: `tests/tasks/reasons.test.ts` blocker → without → REVIEWED, no second review, openPoints holds the items (control mutation: skip the skipFix write); web: the blocker row lists the action.

4.6 Size note (PS5-C, D1)
- The Build box shows the notes of the newest ok commit row of the part (the size note, "... added or changed no test file."), as structure, with no text match.
- Over the limit and without keepOnePr, the box shows "Change the limit", which opens the existing inline form (`props.limitOpen`) and posts `/limit` with lineBudget.
- The `size` reason branch goes; a legacy size reason takes the plain Continue row.
- Tests: `readyNotes(t, part)`, and "Change the limit" only when over the limit.

4.7 PATCH_LOST text (PS5-S1 constant, PS5-C text)
- S1 moves `PATCH_LOST` to `src/shared/task.ts` with the value unchanged; implement.ts re-exports it.
- `patchText(patch)` in model.ts. LogTab with PATCH_LOST: "The app could not save the changes of this step as a patch." TaskView denied_path with PATCH_LOST: "The worktree went back to the last commit. The app could not save the changes as a patch. Continue starts a new run." Otherwise: "The worktree went back to the last commit. The changes are saved in <patch>. Continue starts a new run."
- Test: both texts; control mutation: compare with the old literal.

4.8 Log session groups (PS5-C)
- `logRows` keeps the send groups. A second pass folds rows into `SessionGroup = {part, rows}`: a run row with `detail.session?.resumed === false` starts a new group for its part; later rows of that part join it until the next new-session run; rows before the first session run and old rows with no session stay top level; a group sits at the place of its newest row.
- `LogTab.tsx` renders a group as one `li` with `data-task-item`: header "<R> session of part k" ("<R> session" for one part) with "<n> runs"; nested `ol` with `aria-label="Runs of this session, newest first"`; each run shows "New session: <session.why>" or "Resumed"; nested rows keep `stepId` ids.
- Tests: two interleaved parts give two groups; a new-session run starts a group; old rows stay top level; a send group nests in a session group. Control mutation: group by `session.id` (each fork gets a new ID, U59).

4.9 Plan tab ticks (PS5-S1 field, PS5-C web)
- `plannedTasks` marks a task done when any ok row of the part lists it in `detail.ticked`, and keeps the old commit-item rule for old tasks. A part shows only the tasks with the ID prefix `T<n>.` of its plan part.
- Test: ticks from a commit row and a run row, and the per-part filter.

4.10 Message box (PS5-C)
- `tellBox` shows the box for each implementing or ready part with a worktree, also during the first build, except with `queued > 0`, an adopted part, and the reasons question (open questions), spec_change, allow, preflight, slot, and usage. `canInstruct` decides open or busy.
- `TellClaude.tsx` hint. Open: "<R> gets your message in a run of this part. The app then runs the checks and its own review. Pushes and other git actions stay buttons." Busy: "<R> or the checks are working. You can send when this run ends."
- Only if WP-7 lands: queued "<R> reads this when the current run ends."; live "<R> reads this now."

TanStack Query: no new key. Task actions go through `useTaskAction` (sets `['task', id]`, invalidates `['tasks']`). The setting goes through `useSaveSettings` (`['settings']`). SSE `changed` refetches the task after the usage timer fires (not verified that the timer path calls `changed()`).

## 5. Server packages

PS5-S1 (before the web):

Status: built in 77f9137. Deviations from the list below:
- `ticked` on a run row holds all ticks of the tasks file against HEAD at the run end. These include ticks that a cut or stopped run left uncommitted.
- `without` marks the must-fix points of every own review after the newest work commit (D3 says the newest own review). These are the reviews of the guard review.
- Option `setup` refuses each first reason except the red setup reason of the same part. The test is the step item `setup`, so red/setup_time passes too. The old route refused no first reason.
- Option `setup` starts the part through `goOnReason` or `goOn`, not through `goPart` directly. `goOn` calls `goPart` for a built part. For a part that builds, it starts the build driver.
- `taskLimitInput` keeps the `keep` form until PS5-S2, because the web still sends it.
- `shared/dto.ts`: `taskResumeInput` adds `without` and `setup` and the D2 refine; `taskLimitInput` becomes `{version, lineBudget}`; `TaskRowDto.progress.held`.
- `shared/task.ts`: `PATCH_LOST`; StepDetail `ticked` and `tries`; REASON_EXITS drops `planned` from `without`.
- `shared/review.ts`: `FindingPayload.skipFix?: boolean`.
- `shared/task-status.ts`: `rowPhase` and the D6 rowStatus.
- `tasks.ts`: `mustFixPoint` ignores skipFix; `rowDto` counts held.
- `loop.ts`: `resume` handles `without` (D3) and `setup` (deletes the setup mark and starts GO through `goPart`, refusing with the old `setupAgain` sentences); `commit` and `claude` write `ticked`; `greenOrFix` and `reviewRound` write `tries`; `limit` follows D1.
- `implement.ts` imports `PATCH_LOST`.
- Tests: reasons, ui-routes (`/limit` without a reason), loop (ticked, tries), session, and tests/web for rowStatus, each with a control mutation.

PS5-S2 (after the web):
- `routes.ts` drops `/pause`, `/dismiss`, and `/parts/:part/setup`.
- `loop.ts` drops `pause`, `dismiss`, `setupAgain`, `driveSetup`, `pauseAsked`, `gates`, `openGates` (if PS4 left them), `NO_DISMISS`, `Q.clearSize`, and the `keep` path of `limit`. `SETUP_WAITS` stays only as the 409 sentence of option setup.
- Rewrite or remove the tests that call the old routes (tests/tasks loop, concurrent, instruct, ui-routes). Check name-only matches (slots, caps, limits) and change only real callers.
- New `tests/tasks/routes-grid.test.ts` (9.7): each mutating task route over fixture states answers 2xx, 400, 404, or 409 with a sentence, never 500, and no driver starts on a 409. Control mutation: remove one 409 check.

## 6. PS5-A: test data repair (can start now)

- Files: the seven `tests/e2e/task-*.e2e.ts` files with the old keys, and `scripts/demo.ts`. Do not touch `tests/support/fake-claude.ts` (PS4 WP-1 owns it).
- Change `"implement:implement"` to `"implement:build"`. Fold each `"implement:tests"` write into the matching build entry. Add `ticks: { path: "*", ids: ["*"] }` to each build entry that should finish; an entry that asks a question or an allow keeps no ticks. Keep `implement:fix`, `implement:instruct`, and `implement:resolve`.
- task-small: step 4 becomes "the build goes on to ready, and the Log commit row shows the size note"; drop "Red as expected"; the run limits block checks "Session run turns" (50 to 1,000) and the new `runLimits` object without `stepMinutes` or `partMinutes`.
- task-shell: change the Resume assertions to the PS3 session behavior. Never weaken "no request before a click" or "no external URL".
- demo: the `implement:build` seq order is the allow request, its run after Allow (with the test and flush writes and ticks), the MULTI run, the SUB run. Verify by a demo start.
- Verify with `bun run check` and `bun run test:e2e` on its own ports; print the `E2E code:` line. Control mutation: put back one `implement:implement` key. Do not run `bun run screenshots` here (PS5-D does).

## 7. PS5-E: e2e

- `tests/e2e/serve.ts`: control `claude` takes `usageAt` (epoch seconds) and writes a copy of `usage-limit.jsonl` with that `resetsAt`, for a seq entry with `exitCode: 1`.
- New `tests/e2e/task-session.e2e.ts`:
  1. Build, Hold, Continue: the first build run hangs; More, Hold; "Your change is on hold. Its work is kept."; "Continue" has the focus; the click runs to ready; the Plan tab shows each task done; the Log shows "New session" and "Quick review".
  2. Usage limit: a future `usageAt` gives "Resume at <time>"; the click gives "<R> resumes at <time>." with no primary; "Cancel the resume" brings the button back; a past `usageAt` gives "Resume" and the click runs the build.
  3. Push-back: a confirmed blocker leads to a judging run with a push-back, then the question card without "Use the recommended answers"; Accept leads to ready.
  4. Start again: in ready, More, "Start this part again", confirm; the build runs again, and the remote shows no new head.
- Existing e2e: "Resume" becomes "Continue"; drop Pause and Dismiss; task-setup "Run setup again" goes through resume option setup, with the same label.
- Each test checks that no URL goes outside the app and no token reaches the logs.

## 8. Acceptance criteria

- AC-B366. Each row of part-session.md 2.17 and 9.6 has one test in tests/web/tasks-model.test.ts. Each view has at most one primary, and no primary is also in More.
- AC-B367. For each REASON_EXITS key, a seeded reason gives a primary that maps to its exit route and option, or no primary for an app exit.
- AC-B368. The working rows take the phase from `rowPhase` of the open row of the part. Building shows the tick count. Fixing shows "try n of N" and judging "round n of N" when `tries` is set.
- AC-B369. Hold shows in More while the part builds, fixes, or judges, and posts `/parts/:part/hold`. The On hold row has Continue (resume with part), "Skip this part" only with sub-tasks, "Start this part again" only when unpushed, and Stop.
- AC-B370. Skip and Start again each open one confirm with the texts of 4.2. Cancel sends no request.
- AC-B371. The usage rows follow section 3. The label changes from "Resume at <time>" to "Resume" with no reload. "Cancel the resume" sends option disarm.
- AC-B372. Settings > Tasks > Run limits has "Resume by itself after a usage limit". It is off by default, and a change saves at once with `usageResume`.
- AC-B373. A loop question with a point shows the check, the reason, and the proof, and the citeFound warning. It shows no recommended badge and no "Use the recommended answers". Send needs a choice.
- AC-B374. The questions screen in ready shows the open loop questions.
- AC-B375. "Go on without these fixes" sends option without. The server sets skipFix, starts no new own review, and sends REVIEWED. The points stay in "Fix these too" and never post.
- AC-B376. "Run setup again" sends resume with option setup and part, and setup runs again. `part` with another option gives 400.
- AC-B377. The Build box shows the notes of the newest commit of the part. "Change the limit" shows only over the limit and posts `/limit` with lineBudget, which works without a reason.
- AC-B378. A step with PATCH_LOST shows the texts of 4.7, and no "saved in no file".
- AC-B379. The Log groups the runs of one part session under "<R> session of part k". Each run shows "New session: <why>" or "Resumed". A critic row shows "Quick review".
- AC-B380. The Plan tab ticks tasks from `detail.ticked` of the part rows. A working part shows its phase text.
- AC-B381. The Tasks row shows "On hold" for a task whose only reason is held, and "Resumes after the usage limit" for an armed usage reason.
- AC-B382. `/pause`, `/dismiss`, and `/parts/:part/setup` are gone. No file in src/web calls them. The route grid answers 2xx, 400, 404, or 409 with a sentence, never 500.
- AC-B383. The e2e and the demo use `implement:build` with ticks. task-session.e2e.ts covers Hold, Continue, the usage limit, a push-back, and Start again.
- AC-B384. `bun run screenshots` regenerates task-build, task-allow, task-update, task-subtasks, task-subtasks-plan, and settings-tasks. README and CHANGELOG describe Hold, Skip, Start again, the usage resume, the size note, and the message box. No image shows a real name.

## 9. Work packages

| WP | Tier | Files | Starts after | Parallel |
|---|---|---|---|---|
| PS5-A Test data | implementer | 7 task e2e files, scripts/demo.ts | now | beside PS4, own worktree |
| PS5-B Usage switch | implementer | src/web/settings/RunLimits.tsx, the run-limits block of task-small.e2e.ts | PS4 WP-2 and PS5-A | beside PS4 WP-3 to WP-8 |
| PS5-S1 Server facts | implementer-xhigh | shared/dto.ts, shared/task.ts, shared/review.ts, shared/task-status.ts, tasks.ts, loop.ts, implement.ts, tests | PS4 WP-8 | no (loop.ts) |
| PS5-C Task view | implementer-xhigh | web/tasks/model.ts, data.ts, TaskView.tsx, LogTab.tsx, PlanTab.tsx, Questions.tsx, TellClaude.tsx, tests/web | PS5-S1 | no |
| PS5-S2 Route removal | implementer-xhigh | routes.ts, loop.ts, dto.ts, tests/tasks/*, routes-grid.test.ts | PS5-C | beside PS5-E |
| PS5-E e2e | implementer | tests/e2e/serve.ts, control.ts, task-session.e2e.ts, existing task e2e labels | PS5-C | beside PS5-S2 |
| PS5-D Docs and images | implementer | docs/screenshots/*, README.md, CHANGELOG.md, spec.md 6.28 PS5 lines | PS5-S2 and PS5-E | no |

Each package ends green on `bun run check`. A, E, and D also run `bun run test:e2e`. D runs `bun run screenshots` with its own `SHOTS_PORT` and checks each image for real names, hosts, and paths.

## 10. Invariants

- A part has at most one open step row, and its phase is the phase of that row (part-session.md 9.7 invariant 8). The web finds the row with `runningStep`, which calls the shared `phaseRow` (src/shared/task-status.ts).
- Continue decides by kind and cause, never by text (9.4, storage rule 3). The web follows the same rule (D9).
- UI code names no product; texts take the runner and the forge from meta. Task screens avoid the words that ui-words forbids.
- Every task mutation refreshes `['task', id]` and `['tasks']`.
- The typed client breaks on a removed route, so S2 runs after C.
- PATCH_LOST keeps its stored value, because loop.ts compares it.
- Hold, Skip, and Start again push nothing. A restart refuses a pushed part. Nothing goes to the forge without a click.

## 11. Open questions

1. User answer (2026-11-13): accept D1 to D9 as written.
2. The item names `critic` and `pushback` follow ps4-plan 2.5; not verified until WP-6.
3. The server rule for a note-only answer to a point question is not known. The web asks for a choice.
4. The usage timer path calls `changed()`, so SSE refreshes the view (not verified).
5. Plan part n equals task_part ord in a task without sub-tasks (not verified).
6. WP-7 landed (ba7ad13). PS5-C shows the live and queued hints of 4.10.
7. User answer (2026-11-13): the 2.17 ready sentence replaces "is ready and checked by <R>". Update the tests and the README.
8. User answer (2026-11-13): remove the resume option `start-step-again` in PS5-S2.
9. budget/cost (Q-SM5) still has no owner. PS5 shows Continue only.
10. The rowStatus texts in shared/task-status.ts name the product at runtime. Out of scope.

## 12. Risks

- PS5-C is large, because model.ts is in almost every item. Write the row tests first and the components second.
- PS5-A asserts against the old web, and PS5-E changes the same e2e files again: two passes, but PS4 WP-6 needs a green e2e first.
- The demo seq order across parts that build at the same time can change. Check it by a demo run in PS5-D.
