# PS4 plan: follow-up runs of a part session

PS4 has 8 serial work packages in one worktree and one migration, `054_task_question_point.sql`. Almost every item changes `loop.ts`, so the packages cannot be file-disjoint. Start after the PS1/PS2 security fixes commit. The three machines need no new edge. PS4 adds senders, removes RESTART, UPDATE, and CONFLICT from RESERVED, and adds explicit tables for the held and usage reasons.

Sources: part-session.md sections 2 to 9, spec.md section 6.28, `machine.ts`, `loop.ts`, `routes.ts`, `shared/task.ts`, `validate.ts`, `judge.ts`, `tasks.ts`, `implement.ts`, `jobs.ts`, `claude.ts`, `db.ts`. Line numbers refer to the ps1 tree before the security fixes. Find symbols by name.

## 0. Scope

| Item | In PS4 | Owner if deferred | Why |
|---|---|---|---|
| Critic run and judging run in the part session | yes, WP-6 | | approved scope |
| Judging review points: 6.23.8 prompt lines and the `points` read | yes, WP-1 and WP-6 | | judging needs them; not built |
| Push-back questions, migration 054, Accept and "Fix it anyway" | yes, WP-6 | | design 2.8; section 5.5 puts WP-PB1 in PS4 |
| history.md for the next own review (AC-B111) | yes, WP-6 | | user answer: an accepted push-back must not come back in the next round |
| Hold, Skip, Start again routes and the held rules | yes, WP-4 | | approved scope |
| Usage arm, disarm, timer, recovery | yes, WP-4 | | approved scope |
| Server setting "Resume by itself after a usage limit" | yes, WP-2 and WP-4 | UI: PS5 | section 3 item 2 |
| Instruct as a session run, with the fallback | yes, WP-1 and WP-3 | | approved scope |
| One GO loop for every part, "Fix these too" as a follow-up | yes, WP-3 | | "Continue in ready" needs GO on built parts |
| Update and resolve phases, resolve as a session run | yes, WP-5 | | approved scope |
| Continue in ready, option `leave`, input `part` | yes, WP-3 and WP-4 | | approved scope |
| Live messages (stdin write behind `live`, queue as fallback) | optional WP-7 | after gate U104 | section 6 PS4 |
| "Go on without these fixes" (option `without`) | no | PS5 | change `planned` to "PS5" in REASON_EXITS |
| Removal of `/pause`, `/dismiss`, `/limit`, `/parts/:part/setup` | no | PS5 | the web typed client calls them |
| 409 for `budget/cost` while over the limit (Q-SM5, G11) | no | none named | no package owns it |

## 1. Design gaps and decisions

1. Section 9 of part-session.md exists only on main. Merge it into ps1 before WP-8.
2. Section 9.5 still names `part-<ord>.gitsnap.json`. The security fix moved the snapshot to `task_step.cut_json` (migration 053). Update 9.5.
3. Section 9.3.3 maps "instruct, purpose points" to following. "Fix these too" is a fix run with `failure.md`. Decision: a fix row with item `points` or `pushback` maps to following.
4. A critic row is `kind = 'review'`, item `critic`. `Q.reviewsAfter` and `POINTS.review` have no item filter. A clean critic would stop the own review, and "Fix these too" would list critic points. Decision: both read item `review` only.
5. RESTART keeps the old step rows. `Q.buildCommit`, `Q.workCommit`, `Q.claudeRan`, `Q.redBeforeSeen`, and the critic-once check read them. Decision: a restart mark row (kind `commit`, item `restart`). These guards read only rows after the mark. The baseline stays exempt.
6. No row stores the plan commit hash. Decision: Start again resets to the part base (`baseOf`), and `runPart` writes the plan commit again from the docs. Nothing was pushed.
7. The backup ref uses the existing namespace: `refs/rl/task/<task>/backup/part-<ord>-<n>`.
8. `StepDetail.session.why` already means "why a fresh session". Decision: a row rule. The usage reason starts armed only when the setting is on and the previous Claude run of the part did not end with `usage_limit`.
9. The unit of `resetsAt` is seconds in the recorded fixtures (integration-check.md). `taskBlocked.resumeAt` is in ms.
10. `StepOutcome` has no `resetsAt`. `RunOutcome` has it. WP-1 adds it.
11. usage is a reason kind, not a cause. The REASON_EXITS keys are `usage` and `usage/armed`.
12. SESSION_GATES gets a third key, `resolve: false` (needs U99). The critic needs no gate: a failed critic only writes a Log note.
13. Section 9.3.3 gives a failed follow-up run WAIT with a run-end reason. spec 6.18.7 restores `blockedBefore`. Decision: 9.3.3 wins (user answer Q-SM1). Option `leave` restores `blockedBefore`. spec 6.18.7 and `tests/tasks/instruct.test.ts` change.
14. After a restart, `failSteps` fails a queued follow-up row, and the message is lost. Decision: Continue puts the follow-up row in the queue again, in implementing and in ready.
15. Continue in implementing on the reason of a built part clears the reason and runs nothing. Decision: route Continue by the state of the part.
16. `judging` RUN_DONE has no `unchanged` guard, and `greenOrFix` never checks `gateDone`. Decision: `checkGate` sends CHECKS_GREEN at once when the last gate is green at HEAD.
17. Skip with sub-tasks removes a worktree entry of the shared cache while another part can run a step. The worktree-entry check of the security fix can then stop the task. Write this test first in WP-4. The removal goes through the app git path that the cache watch records.
18. In stopped, LAST_PR_OPEN and ALL_MERGED cannot fire. Run the skip check again after RESUME.
19. pushback.md reserves AC-B105 to AC-B115. PS4 uses AC-B333 and up. Mark the old reservation as replaced.
20. An own review that hits the usage limit gives `error/run` today. Decision: give `usage` there too.
21. Keep the `/pause` route until PS5, because the web calls it.
22. A waiting follow-up row can wait while newer rows of its part come (WP-7). The guards read rows in ID order. Decision: a waiting row that never ran takes the next row ID and the next ord before it runs.

## 2. Machine changes

### 2.1 Phase machine: no new edge

| Flow | Event sequence |
|---|---|
| Critic (implementing) | idle –GO{critic}→ critic. Then –POINTS→ judging –RUN_DONE→ checking –CHECKS_GREEN→ idle; or –CLEAN→ idle (no kept point, failed or cut run); or –STOPPED→ idle. |
| Judging run end | judging –RUN_CUT{firstCut}→ judging; –RUN_CUT→ idle (stuck); –WAIT→ idle (error/run, usage); –STOPPED→ idle (Stop, Hold) |
| Review judging with push-back | reviewing –POINTS{roundsLeft}→ judging –RUN_DONE→ checking –CHECKS_GREEN→ idle. The loop then writes the questions and the reason at idle. |
| Follow-up on a built part | idle –GO{follow}→ following. Then –RUN_DONE{unchanged}→ idle; or –RUN_DONE→ checking [–CHECKS_RED{triesLeft}→ fixing –RUN_DONE→ checking]* –CHECKS_GREEN→ idle –GO{review}→ reviewing –CLEAN→ idle. |
| Follow-up on an implementing part | as above up to the first CHECKS_GREEN, then `buildParts` runs a new GO loop. |
| Continue in ready | idle –GO{facts from rows}→ the first phase whose guard holds, then as above |
| Update | idle –UPDATE→ updating. Per conflict stop: –CONFLICT→ resolving –RUN_DONE→ updating. Then –CLEAN→ checking –CHECKS_GREEN→ idle (GO{review} when a resolve ran), or –CHECKS_RED{afterUpdate}→ idle (red/update). An abort sends WAIT. A Stop sends STOPPED. |
| Hold | building, fixing, or judging –STOPPED→ idle. The route writes held first. |

`critic` has no WAIT edge. A failed critic writes a note and sends CLEAN.

### 2.2 Guard facts that change

| Guard | Rule after PS4 | WP |
|---|---|---|
| follow | a waiting row of the part with kind `instruct`, or kind `fix` with item `points` or `pushback` | 3 |
| critic | part implementing, an ok build commit after the restart mark, and no critic row (ok or failed) after the mark. A cancelled critic runs again. A critic that an app restart cut ends cancelled (tasks.ts SQL.failSteps). | 6 |
| review | the PS3 rule, plus: only rows after the restart mark; `Q.reviewsAfter` reads item `review` only; a resolved green `update` row counts as a commit of Claude's work (Q57) | 4, 5, 6 |
| baseline | unchanged; the restart mark does not affect it | none |
| claudeRan | only rows after the restart mark | 4 |
| afterUpdate | only the update driver passes it | 5 |

### 2.3 Part machine and task machine: no edge change

| Machine | State | Event | Guard | Target | New sender |
|---|---|---|---|---|---|
| part | implementing, self_reviewed | ABANDON | none | abandoned | route skip |
| part | implementing, self_reviewed | RESTART | unpushed | implementing | route restart |
| task | implementing | LAST_PR_OPEN | none | ready | route skip (shared helper with `drop`) |
| task | ready | ALL_MERGED | none | done | route skip |
| task | stopped | RESUME | stoppedFrom | X | then run the skip check (gap 18) |

`unpushed` means: `task_part.pushed IS NULL`, and no `task_pr` row of the part has `pushed IS NOT NULL`.

### 2.4 RESERVED

WP-4 removes RESTART. WP-5 removes UPDATE and CONFLICT. After PS4, RESERVED holds OPEN_SPEC_PR, SPEC_GATE_PASSED, OVERRIDE, and FAIL. The sender test needs the literal event types in src/server.

### 2.5 Phase of an open row

A `fix` row with item `points` or `pushback` maps to following. A `fix` row with item `critic` or `review` maps to judging. Every other `fix` row maps to fixing.

### 2.6 Reason machine: held (part row only)

| From | Event | Guard | To | Owner |
|---|---|---|---|---|
| none | HOLD | task implementing; part implementing; an open row of kind implement or fix, also beside a waiting message (WP-7); part row empty | held, with that row as step | route |
| held | CONTINUE with `part` | task implementing or stopped | none; poke the running driver, else kick. In stopped, also RESUME. | route |
| held | SKIP | task has sub-tasks | none, part abandoned | route |
| held | RESTART | unpushed | none, part implementing, restart mark written | route |
| held | STOP of the task | none | held (kept) | route stop |
| held | app restart | none | held (kept); `SQL.running` skips the part | recover |
| held | CLOSE | none | cleared | tasks `advance` |
| held | `nextReason`, `holdBlocked` | none | unchanged; never moves up | tasks |

### 2.7 Reason machine: usage

| From | Event | Guard | To | Owner |
|---|---|---|---|---|
| run end `usage_limit` | WAIT | setting off, or the previous Claude run of the part ended with `usage_limit` | usage{resumeAt?, armed:false} | loop `runReason` |
| run end `usage_limit` | WAIT | setting on and the previous run did not end with `usage_limit` | usage{resumeAt?, armed:true} | loop |
| usage{armed:false} | CONTINUE | now < resumeAt | armed true on every usage reason, one version move | route resume |
| usage{armed:false} | CONTINUE | no resumeAt, or now ≥ resumeAt | cleared, the cut run runs again | route resume |
| usage{armed:true} | CONTINUE | now < resumeAt | unchanged, 200 | route resume |
| usage{armed:true} | CONTINUE | now ≥ resumeAt | cleared, the run runs again | route resume |
| usage{armed:true} | DISARM | none | armed false on every usage reason | route resume |
| usage{armed:true}, first reason | RESUME_DUE | now ≥ resumeAt, no driver, not closing | cleared, the run runs again | timer |
| usage{armed:true} | app restart | none | kept; recover arms the timer, a past resumeAt fires at once | recover |
| any usage | STOP | none | cleared | route stop |

## 3. Work packages

### WP-1. Runner and review side (implementer-xhigh)

Status: built in 5cb44d7.

- `implement.ts`: `StepOutcome.resetsAt`; the session of an `ImplementRunStart` gets `live: true` for implement, fix, and instruct (jobs drops it while `gates.live` is false); `StepInput.points` adds the 6.23.8 lines to the prompt; `PURPOSE_TITLE.resolve` "Resolve the conflicts".
- `shared/task.ts`: `SESSION_PURPOSES` adds `resolve`.
- `claude.ts`: `SESSION_GATES` adds `resolve: false`.
- `jobs.ts`: `TaskReviewStart.critic` (no rl-reviewer, no verify phase, `judge` with `addedOnly`); new `sendPart(db, task, part, text)` that returns false while `gates.live` is false.
- `judge.ts`, `validate.ts`: `addedOnly` keeps a finding only when each line of its anchor range is an added line.
- `fake-claude.ts`: a `critic` call key and scenario field; the default critic result has no findings.
- Tests: validate (added-only range, control mutation), jobs (critic argv), implement (resetsAt, 6.23.8 lines only with points, instruct session keeps its transcript).
- Risk: `settle` and `verifyPhase` with an empty verify result.

### WP-2. Reason storage, data, inputs (implementer-xhigh)

Status: built in 3534a18.

- `tasks.ts`: `clearWaits` keeps held rows for stopped and ready; `WAIT.first` and `WAIT.count` skip held; `SQL.running` and `recoverTasks` skip held parts; new `setUsageArmed`; `POINTS.review` reads item `review`; `openPoints` skips discarded items; the question DTO adds `point`.
- `notify.ts`: `waits` skips held.
- Migration 054 and its import in `db.ts`.
- `shared/dto.ts`: `taskResumeInput` gets `option` (`start-step-again`, `leave`, `disarm`) and `part`, not both; `TaskQuestionDto.point`; `usageResume` in settings.
- `config.ts`, `settings.ts`: `usageResume` follows the pattern of `sessions`.
- Tests: recover, concurrent (with a control mutation), db (054), dto.

### WP-3. One GO loop, follow-ups, instruct session, Continue in ready (implementer-xhigh)

Status: built in f4e7634.

- `loop.ts`: `phases(c, once)` as the shared GO loop with the `follow` fact and the `following` case; `requeue` generalizes `resend`; `followRun`; `claude()` gives instruct the cut, usage, and failure path of the other session modes; `SESSION_MODES` adds instruct; `checkGate` skips at a green unchanged HEAD; `driveFollow` replaces `driveInstruct` and `drivePoints`; `goPart`; `resume()` becomes async and handles ready and built parts; `instruct()`, `fixPoints()`, `answer()`, `allow()`, `specChange()` use `goPart`.
- `routes.ts`: await `loop.resume`.
- `shared/task.ts`: REASON_EXITS drops `planned` from LEAVE.
- Tests: instruct (6.18.7 cases to error/run), session, reasons (ready grid), concurrent, recover (queued row after a restart), loop. Each with a control mutation.
- Risk: the largest refactor. Keep each `endInstruct` rule.

### WP-4. Hold, Skip, Start again, usage (implementer-xhigh)

Status: built in 32683c1.

- `loop.ts`: the `active` set and `partIdle`; `guard(c)` halts a held part; `buildParts` skips held parts; `hold`, `skip`, `restart` (gaps 5, 6, 7, 17); `Q.mark`; usage in `runReason`, `reviewRun`, `resume()`; `usageTimers`, `rearm`, `due`; the timer delay capped at 2^31−1 ms; `shutdown` clears timers.
- `routes.ts`: 3 new routes. `machine.ts`: RESERVED drops RESTART. `shared/task.ts`: REASON_EXITS updates.
- Tests: new hold.test.ts (start with the gap 17 case), concurrent, recover (usage timer), session, with control mutations.

### WP-5. Update and resolve in the phase machine (implementer-xhigh)

Status: built in c6b4ad8.

- `loop.ts`: `driveUpdate` sends UPDATE, CONFLICT, RUN_DONE, CLEAN, CHECKS_GREEN or CHECKS_RED{afterUpdate}; own review after a resolve; `endUpdate` sends WAIT or STOPPED and gives error/run for a failed own review; the resolve session behind `gates.resolve`; `reviewDue` counts a resolved green update row.
- `machine.ts`: RESERVED drops UPDATE and CONFLICT.
- Tests: update (event orders, red/update, Continue, review after a resolve, control mutations), session (resolve fork with gates on, fresh with gates off).

### WP-6. Critic, judging, push-back questions (implementer-xhigh)

- `loop.ts`: `criticRun` (item critic, opus, effort low, 30 turns, no reviewer, no verifier, no language checks; a failure or cut writes a note and sends CLEAN); critic judging with Log lines for a push-back; `judgePoints`; push-back questions with `point` after the review gate; `reviewFailure` with the 6.23.3 header; `answer()` handles Accept and "Fix it anyway"; `Q.reviewsAfter` reads item `review`.
- Tests: session (AC-B299 order, a clean critic keeps the own review, critic once), new pushback.test.ts, loop, and `bun run test:e2e`.
- Risk: each fake-CLI build gets a critic run, so run and row counts shift.

### WP-7 (optional). Live messages behind `live` (implementer)

Status: built in ba7ad13.

- `loop.ts` `instruct()` during a session run of the part (`sessionRunning`: an implement, fix, or instruct run): with `live` on, `review.sendPart` writes stdin and adds the Log note "Your message: <text>". When the write fails under the build driver, one waiting instruct row per part with blockedBefore null; the next GO runs it. Else 409 WORKING. `tasks.ts` `instructTarget` lets a session run of the part through.
- `followRun` gives a waiting row that never ran the next row ID (gap 22). A no-change message with no blockedBefore keeps the reason of another part. `hold` takes the open implement or fix row.
- `recoverTasks` keeps a waiting message that never ran on a part that still builds, in implementing only. A built part keeps the WP-3 rule.
- The live path moves the task version. Each send gets its own Log note. A move to stopped in `tasks.ts` `advance` runs `stopSends`. A Stop and `failed()` make this move. `stopSends` cancels each waiting message with result "stopped". A running message gets result "stopped" too. Skip and Start again run `stopSends` for their part. `partIdle` ignores a waiting message. `endFollow` gives back `before` when the message has no blockedBefore.
- Tests: session (AC-B364: live on and off, two tabs, Stop, restart, follow-up driver, Skip, Start again, Hold), implement (sendPart), machine (STOP ends the messages) and fixture (invariant 8).

### WP-8. Docs (implementer)

- spec.md 6.28 (AC-B333 to AC-B365), 6.18.1, 6.18.7, 6.25.
- part-session.md: merge section 9, fix 9.3.3 (gap 3), change the gitsnap file to `cut_json` in 9.5.
- pushback.md: mark the AC reservation as replaced.
- CHANGELOG.md: user-visible lines only.

## 4. Routes

| Route | Input | Event or exit | Refusals (409) |
|---|---|---|---|
| POST /tasks/:id/parts/:part/hold | partParam, version | held, then STOPPED | "Hold works while Claude builds or fixes part <k>."; "Part <k> is on hold already." |
| POST /tasks/:id/parts/:part/skip | partParam, version | ABANDON | "Only a part of a task with sub-tasks can be skipped."; "Hold part <k> first."; "This part has a PR." |
| POST /tasks/:id/parts/:part/restart | partParam, version | RESTART | "Part <k> is on the server. It cannot start again."; "Hold part <k> first." |
| POST /tasks/:id/resume | version, option?, part? (not both) | CONTINUE, leave, disarm, arm | "Part <k> is not on hold."; "No resume is armed."; "Leave works only in ready." |
| PUT settings | usageResume? | none | none |

## 5. Migration 054

```sql
ALTER TABLE task_question ADD COLUMN point INTEGER REFERENCES review_item (id) ON DELETE SET NULL;
```

held and usage live in `blocked_json`. The restart mark is a `commit` row. The critic is a `review` row.

## 6. Acceptance criteria

- AC-B333. A critic run is a task review run with item critic, model opus, effort low, 30 turns, no rl-reviewer, and no verify phase. It keeps a finding only when each line of its anchor range is an added line of base..head.
- AC-B334. The step outcome of a usage-limited run holds resetsAt.
- AC-B335. A fix run with review, critic, or point items in failure.md gets the lines of 6.23.8. A fix run for red checks does not.
- AC-B336. An instruct session run keeps its transcript. An instruct run with no session drops the stored transcript.
- AC-B337. A held part row survives Stop and an app restart. nextReason never moves it up. The waiting count, the notification, and the running check skip it. CLOSE clears it.
- AC-B338. Migration 054 keeps the rows and adds task_question.point with NULL.
- AC-B339. One arm or disarm sets armed on the first reason and on each waiting usage row, with one version move.
- AC-B340. openPoints and mustFix skip discarded items. The own review queries read item review only.
- AC-B341. On a built part, a send, "Fix these too", and Continue send GO follow or the GO of the rows, then RUN_DONE, CHECKS_GREEN, GO review, and CLEAN.
- AC-B342. An instruct run is a session run. With the resume gate off, it starts a new session with continue.md, continue-diff.md, and "Your instructions". With the gate on, it forks the kept transcript. Its commit moves the heads.
- AC-B343. A failed, usage-limited, or twice-cut follow-up run waits with error/run, usage, or stuck, and the task keeps its state. leave restores blockedBefore. A Stop restores blockedBefore and saves the patch.
- AC-B344. Continue in ready answers 2xx for each R reason of section 9.4 and runs the right phase. It answers 409 with the form text for question, spec_change, allow, and slot.
- AC-B345. Continue on the reason of a built part runs that part while the task is in implementing, then the build of the other parts.
- AC-B346. A follow-up row that a restart failed runs again on Continue, in implementing and in ready.
- AC-B347. The gate runs no command when the last gate is green at HEAD with the same command hash and no later run left work.
- AC-B348. Hold answers 200 only for an implementing part with an open implement or fix row. It writes held, cancels only the runs of that part, sends STOPPED, and keeps the work. The other parts go on.
- AC-B349. Continue with part clears held. It wakes a running driver for that part, or it starts a driver. In stopped, it also resumes the task.
- AC-B350. Skip refuses a task without sub-tasks, a part with a PR, and a working part. It saves the patch, sends ABANDON, removes the worktree, deletes the transcript, clears the reasons of the part, and sends LAST_PR_OPEN or ALL_MERGED. A Skip while another part runs a step keeps the task live.
- AC-B351. Start again refuses a pushed part. It saves the patch, writes refs/rl/task/<id>/backup/part-<ord>-<n>, resets each edit repository, writes the restart mark, deletes the transcript, and clears the reasons. It keeps the baseline and the setup mark. The next run is a new session with no continue.md. The critic and the own review run again.
- AC-B352. A usage-limited run gives usage with resumeAt equal to resetsAt times 1000. armed is true only when the setting is on and the previous Claude run of the part did not end with usage_limit.
- AC-B353. Continue before resumeAt arms every usage reason. Continue after resumeAt, or with no resumeAt, runs. disarm clears armed. The timer fires once for the first reason. Recovery arms the timer again, and a past resumeAt fires at once.
- AC-B354. RESERVED has no RESTART, UPDATE, or CONFLICT. No REASON_EXITS entry is planned for PS4. Each option of REASON_EXITS parses in taskResumeInput.
- AC-B355. An update sends UPDATE, then CONFLICT and RUN_DONE for each resolve stop, then CLEAN. Then it sends CHECKS_GREEN, or CHECKS_RED with afterUpdate. An abort sends WAIT with the reason update. A Stop sends STOPPED.
- AC-B356. Red checks after an update give red/update. Continue starts the fix runs with the tries from 0, in implementing and in ready.
- AC-B357. A green update with a resolve run makes the own review due through GO, also after a restart.
- AC-B358. With the resume and resolve gates on, each resolve run forks the session without Bash and Agent, and the heads move to the heads after the update. Else the resolve run is new and keeps no transcript.
- AC-B359. GO runs the critic once after the first build commit. Kept points start one judging run. A push-back gives a Log line only. A failed or cut critic gives a note and CLEAN.
- AC-B360. A clean critic does not skip the own review.
- AC-B361. A review judging run drops an unknown ID with a note. A missing entry gives "No verdict for point N" and counts as fixed. Each push-back gets payload.pushback with citeFound. After the gate, each push-back gets one question with point set and recommended null.
- AC-B362. Accept discards the item with the mapped reason. "Fix it anyway" queues a pushback follow-up that commits as pushback and sets fixedBy. The recommended answers with an open push-back give 400.
- AC-B363. "Fix these too" judges its points with the same rules.
- AC-B364 (WP-7). With the live gate on, a message during a session run of the part reaches stdin, and the step gets the note "Your message: <text>". With the gate off, a message during the build run waits as one follow-up row per part. It survives an app restart while the task implements, and the next GO runs it. A Stop, a failed build, a Skip, or a Start again cancels it. Its text goes back to the box. A live send moves the task version.
- AC-B365. The demo and e2e builds stay green with the critic step.

## 7. Invariants

- The machines are pure. `advance` and `advancePart` are the only writers of state.
- `send()` asserts `can()`. A refused event throws, and `failed()` stops the task.
- `after()` runs for every run end, also for a cancel.
- A part has at most one open step row, with two exceptions. An open update row can sit beside exactly one open resolve or check row of the same update (WP-5, accepted). One waiting instruct row can sit beside one other open row (WP-7). The fixtures check this rule after each test.
- `holdBlocked` never replaces the reason of another part.
- `cancelPart` matches the key prefix `task:<id>:part:<part>:`.
- `advancePart` drops the transcript on RESTART and on merged, declined, or abandoned.
- jobs drops `resume` and `live` while their gate is off.
- Each commit moves the session heads.
- A Stop of a mode driver keeps the task state.
- Restart refuses a pushed part, so nothing in PS4 force-pushes.
- Recovery and the arm route also call `rearm`.

## 8. Open questions

1. User answer (2026-11-13): build history.md (AC-B111) in WP-6.
2. The critic uses the shipped default prompt modules with the critic profile.
3. The app `git` helper records its calls for the cache watch of another part, so backup refs, resets, and prunes do not look like changes by Claude. Verify in WP-4.
4. resetsAt is in seconds. Verify with U106.
5. User answer (2026-11-13): Continue with part in stopped also resumes the task.
6. Preflight in ready: Continue only clears the reason. The next push or PR click runs the pre-flight again.
7. Continue on `blocker` keeps the PS3 behavior: a new driver gives 2 rounds.
8. The critic adds one step row to each demo build, so README screenshots change in PS5.
