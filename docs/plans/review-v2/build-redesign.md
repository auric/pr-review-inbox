# Build a Jira task: redesign of stop and Continue

Status: design of 2026-11-11 against main 2dd8bd5, after the user said the build feature is "too weird and too complicated" and asked why the checks run again after every stop. Not built. Open questions Q1 to Q6 wait for the user. User decision of 2026-11-11: the task step time and the part time are off by default (Settings can set them; Stop always works).

## Summary

- Continue goes on from the exact point where the build stopped. It keeps every change that passed the path check.
- The loop skips each step that already has a record at the current head with the same inputs. Setup, baseline, final checks, and the own review do not run again.
- A step that reaches its time limit or turn cap continues once by itself with its kept changes. A later Continue does the same.
- The user sees four kinds of "Needs you" box. Each box has one primary button. Every box that is not a form uses "Continue", with specific options under it.
- The hard rules stay. The git state snapshot, the config allowlist, and the path checks stay.

## 1. Facts of the current design

### 1.1 States

| Item | Count | Evidence |
|---|---|---|
| Task states | 9 | `src/shared/task.ts:10-20`; `src/server/tasks/machine.ts:64-98` |
| Part states | 9 | `src/shared/task.ts:23-33`; `machine.ts:100-126` |
| Step kinds | 19 | `src/shared/task.ts:47-68` |
| Step states | 6 | `src/shared/task.ts:36` |
| Reason kinds (blocked) | 13 | `src/shared/task.ts:354-369` |
| Driver modes | 4, plus a points driver | `loop.ts:403`, `drivePoints` `:1682` |
| UI action kinds | 39 | `src/web/tasks/model.ts:30-75` |
| Places that hold a reason | 2 | `task.blocked_json`, `task_part.blocked_json` (migration 048) |

### 1.2 Reasons and their buttons today

| Kind | Set at | Primary | More | Server effect |
|---|---|---|---|---|
| question (Claude asks) | `loop.ts:919-931` | Answer the question | Stop | `answer()` resets and runs the step again (`loop.ts:2451-2494`) |
| question (app: red before, fix changed nothing, pause) | `loop.ts:1108-1112, 1121-1122, 730, 1194` | Continue | See why, Stop | `resume()`: reset, except at an open pause gate (`loop.ts:2391-2447`) |
| red (tests, tests step, setup, setup time) | `loop.ts:1114-1119, 1166-1167, 1173, 1520-1526` | See why, or "Change the time limit" | Resume, Stop | Reset, then the step from scratch |
| blocker | `loop.ts:1292-1299` | See why | Resume, Stop | Reset, then review again |
| budget | `implement.ts:848-855` | Continue with 60 more minutes | Stop | 60 more minutes, then reset |
| size | `loop.ts:1015-1023, 1054-1057` | Keep one PR | Change the limit, Stop | `limit()`: reset, build again (`loop.ts:2546-2565`) |
| spec_change | `loop.ts:911-916` | Review the change | Reject, Stop | `specChange()` (`loop.ts:2606-2684`) |
| denied_path | `implement.ts:1012-1014`, `loop.ts:1071` | Resume | Stop | Step again; the step already undid itself |
| push | no setter found | Resume | Stop | none |
| slot | `loop.ts:678-723` | none (working) | Stop | Goes on by itself |
| preflight | `preflight.ts:41`, `pr.ts:453, 673` | Try again, or Pick a base branch | Stop | Reset and preflight |
| update | `loop.ts:2236` | Try again | Go to the PR, Show the diff | Update again |
| error (failed run, stop, restart) | `tasks.ts:611-616`; `loop.ts:671, 888, 964, 1052, 1189` | Resume | Stop | Reset, then the step from scratch |
| allow | `loop.ts:890` | Continue (sends the choices) | Stop | `allow()`: reset, step again |

The UI sends the same `/resume` call under four labels: "Resume", "Continue", "Try again", and "Continue with 60 more minutes" (`model.ts:546-564`; `TaskView.tsx:329-334`).

### 1.3 What each Continue path runs again

| Path | Reset | Setup | Baseline | Preflight | Size check | Stopped step | Final checks | Own review |
|---|---|---|---|---|---|---|---|---|
| Resume of a stopped build (`loop.ts:2400-2411`) | yes (`:1643`) | when the reset removed any path | no | yes, every building part (`:1646-1656`) | yes (`:1550`) | from scratch | yes (`:1561`) | yes (`:1563`) |
| Resume of a reason (`:2433-2446`) | yes | same | no | yes | yes | from scratch | yes | yes |
| Answer, Allow, Limit, Pick base | yes | same | no | yes | yes | from scratch | yes | yes |
| Reject of a plan change (`:2623`) | yes | same | no | yes | yes | from scratch | yes | yes |
| Continue at an open pause gate | no | no | no | no | no | goes on | no | no |
| App restart (`tasks.ts:252-260`) | the task stops; Resume works as row 1 | | | | | | | |
| Run setup again (`loop.ts:2584-2601`, `:1925-1948`) | no | forced | no | yes | yes | next step | yes | yes |

Root causes:

- Setup: `resetWorktree` deletes the setup mark when `git clean -ffd` removes any path (`worktree.ts:403`; spec.md:1359). A stop in the middle of a step almost always leaves Claude's new files, so almost every Resume runs setup again. The precise rule: delete the mark only when the reset removes a path that setup made.
- Baseline: it runs once per part (`loop.ts:1085-1088`; `Q.started` `:476-477`).
- Checks after a stop: `runPart` always runs the final full checks and a fresh own review (`loop.ts:1561-1563`). No record says that the checks were green at this head.
- Preflight: each driver start sends forge requests and `git ls-remote` for each building part (`loop.ts:1646-1656`). Each push runs preflight again anyway (`pr.ts:334, 451, 671, 763`).
- The stopped step: `undo()` saves a patch and resets (`loop.ts:1129-1143`). No later step reads the patch. After "tests stay red after N tries", Resume throws away the implement step and the fix steps, because the commit comes only after green checks (`loop.ts:1184-1191`).

### 1.4 A step that reaches its limit

- The time limit ends the run as "The run passed its time limit." (`stream.ts:302`). The turn cap gives kind `max_turns` (`stream.ts:287`).
- `finish` calls `stopForRun`, and the task stops with kind error (`implement.ts:1015-1016`; `tasks.ts:611-616`).
- The edits stay on disk until Resume. Then they go to a patch and the worktree resets.
- Every task step runs with `--no-session-persistence` (`claude.ts:539`). No session exists to resume.

### 1.5 The size stop

- A part over the line budget stops with kind size. The buttons are "Keep one PR", "Change the limit", and Stop (`model.ts:550-552`). "Split into parts" is not built.
- BRIEF.md:289 and :493 still say "stops and proposes a split".

### 1.6 Main sources of complexity

- 9 code paths reset a worktree: `askAllow` (`loop.ts:886`), `testsStep` (`:1168`), `resetPart` (`:1579`), `drivePoints` (`:1689`), `driveInstruct` (`:1862`), `endInstruct` (`:1902`), `specChange` (`:2632, 2651`), `implement.ts:958, 961`.
- 7 action routes reset before the build goes on. `resume()` has about 10 branches.
- 13 reason kinds, one without a setter. 4 labels for one call. 39 UI action kinds.
- loop.ts has 2,917 lines, tasks.ts 2,793, model.ts 1,431, TaskView.tsx 1,040.

## 2. Target design

### 2.1 Rules

- The DB rows and the branch hold the position of the build. No new cursor column.
- Each step looks for its own record at the current head with the same inputs. When the record exists, the step skips.
- Continue keeps the work. A reset happens only in four cases (2.2).
- Each reason text says what Continue does.

### 2.2 The Continue rule

- Continue keeps every uncommitted change when each Claude step after the last commit has `checked: true`.
- `finish` sets `checked` when `after()` ran the git state check and the path check with no problem, for any run status: ok, failed, time limit, turn cap, or Stop. `after()` runs after a cancel too (`jobs.ts:1537`).
- Four cases reset to the last commit and save the patch: a denied path (the step already undid itself); a rejected plan change; "Start the step again", a new explicit option; a step cut by an app restart (its git snapshot lived only in memory, `gitstate.ts:52-80`).
- After a reset, the next attempt gets the patch as `context/continue.md`, marked as untrusted data.

### 2.3 Loop of one part

```
worktree (reuse)
setup          -> runs when the mark is absent, its hash differs, or a reset removed a path that setup made
baseline       -> once per part (no change)
for each open task:
    tests step     -> skip when its commit exists
    implement      -> skip when the last Claude step of this task after the last commit ended ok and is checked
                      a cut step continues: attempt + 1, the kept changes, context/continue.md
    scoped checks + fix steps (fresh tries after each Continue)
    commit + tick
final checks   -> skip when a green run at this head has the same command list and the worktree is clean
own review     -> skip the review run when a review at this head ended ok; reuse its points
ready          -> line count shown; over the limit gives a note (WP-R5) or a size reason (until WP-R5)
```

Records:

- The setup mark becomes `{hash, files}`. `files` lists the untracked paths that git does not ignore, taken right after a green setup.
- StepDetail gets `head` (check and review steps), `commands` (a hash of the build, test, and lint list with argv and timeouts), `checked`, and `dirtyBefore` (the dirty paths at the start of the first attempt of a step).

### 2.4 A step that ends early

- Time limit or turn cap with `checked: true`: the task does not stop. One continuation starts at once, with the same mode and item, attempt + 1, and the normal step time and turns. `CONTINUE_MAX = 1`.
- Other failed runs and the user's Stop: the build stops. Continue starts the continuation by hand.
- A second cut step stops the build with a stuck reason. Continue starts another continuation.
- The trusted step.md of the continuation gets one line: "Attempt N continues attempt N-1, which <ended at its time limit | reached its turn cap | failed | was stopped>. Your earlier changes are in the worktree. context/continue.md lists them. Check them and finish the step. Do not start again."
- `context/continue.md` holds the changed paths, the diff since the last commit (capped by FAILURE_TAIL), and the notes of the cut run. It is marked as untrusted data.
- The continuation compares its new files against `dirtyBefore` of the first attempt, so a tests step does not fail with "wrote no test" and a plan change cannot hide.
- `startStep` still checks the part time and the cost budget when the user set them.

### 2.5 Reasons and options

The stored `kind` stays as the cause. A new optional `options` field lists the specific options. Old rows derive their options from the kind, so no SQL migration is needed. The kind `push` goes away.

| User sees | Stored kinds | Primary | Options | Continue does |
|---|---|---|---|---|
| Claude asks | question with open questions | Answer | Use the recommended answers | Runs the step again with the answers and the kept changes |
| Claude asks to run a command | allow | Continue (sends the choices) | none | The step goes on with the kept changes |
| Plan change | spec_change | Review the change | Reject | Accept commits the plan; Reject resets |
| Needs you | red, blocker, budget, size, denied_path, error, preflight, update, question without open questions | Continue | per cause, below | per cause, below |
| ↳ tests stay red | red | Continue | Start the task again, See why | N more fix tries; the work stays |
| ↳ setup failed or timed out | red (setup) | Continue | Change the time limit, See why | Runs setup again |
| ↳ red before this task | question | Continue | See why | Fix steps run |
| ↳ fix changed nothing | question | Continue | Start the task again, See why | Checks and fixes run again |
| ↳ review points after 2 fix rounds | blocker | Continue | Go on without these fixes, See why | One more fix round with the stored points |
| ↳ part time used | budget | Continue | none | 60 more minutes |
| ↳ over the line limit | size | Continue | Change the limit | Keeps one PR (until WP-R5) |
| ↳ denied path | denied_path | Continue | See why | Step again; the work was undone, patch saved |
| ↳ run failed, time limit, turn cap, stop, restart | error | Continue | Start the step again, See why | Continuation with the kept work |
| ↳ forge check failed | preflight | Continue | Pick a base branch | Checks again |
| ↳ update failed | update | Continue | Undo the update, Show the diff or Go to the PR | Update again |
| Paused | question (PAUSED), pause after a task | Continue | none | Goes on |
| Waiting for a run slot | slot | none (working) | Stop | Goes on by itself |

Stop stays in More everywhere. "Start the step again" shows only when the part has uncommitted work.

### 2.6 UI states

| State | Status line | Primary | More |
|---|---|---|---|
| Working | "Claude writes task T1.2." / "The app runs the checks of task T1.2." / "Claude continues task T1.2 after its time limit (attempt 2)." | none | Pause after this step, Stop |
| Waiting for the slot | "Waiting for your review of PR 12 to end." | none | Stop |
| Needs you | "<cause>. Continue <what it does>." Example: "Needs you: the tests of part 2 stay red after 3 tries. Continue gives Claude 3 more tries with its changes." | Continue, or the form button | options, See why, Stop |
| Paused | "Paused after the step." | Continue | Stop |
| Stopped | "Stopped at part 2, task T2.3." | Continue | Start the step again, Close the task |

### 2.7 Hard rules and safety fixes that stay

- Claude edits files only in the app-owned worktree. The continuation uses the same worktree and `startStep`.
- The app pushes only on a click, with an explicit `--force-with-lease` and no `+` refspec. Continue never pushes.
- git stays denied for Claude. The git state snapshot and restore run around every step. `checked` depends on them.
- The config allowlist, the path check, and the denied-path undo do not change.
- The token never goes into prompts or SQLite. continue.md holds only the worktree diff and Claude's own notes.
- Reviews run on the sanitized snapshot. Nothing goes to Bitbucket or Jira without a click.
- A commit follows green checks only. A kept half-edit never reaches a commit unchecked.

### 2.8 Session resume (later, behind a gate)

- `--resume <abs .jsonl> --fork-session` works with `--restricted`, `--tools`, `--strict-mcp-config`, `--json-schema` (integration-check.md U47 to U60). Task steps pass `--no-session-persistence`, and the run end deletes the per-cwd folders (Gate B4).
- Not verified: whether the transcript of a killed run can resume; whether Edit, Write, Bash, and the `--settings` rules apply on resume; the cost of a reloaded context.
- Decision: continue.md first. Session resume is WP-R7, after a new gate.

## 3. Delete, merge, migrate

### 3.1 Delete

- The kind `push` (no setter).
- The preflight at driver start for parts that already started (`loop.ts:1646-1656`). Part start and every push keep their preflight.
- The resets in `drive(reset)`, `buildParts` resumed, `drivePoints`, `driveInstruct`, and `askAllow`. The Continue rule replaces them.
- `driveSetup`, `SETUP_WAITS`, and the setup driver mode. "Run setup again" becomes an option that deletes the setup mark.
- UI action kinds `continue`, `keep-size`, `time-limit`, and `setup` as separate primary actions.

### 3.2 Merge

- `limit`, `setupAgain`, and `dismiss` merge into `resume`. Body: `{version, option?: "more-time" | "keep-one-pr" | "skip-points" | "start-step-again" | "setup" | "leave", lineBudget?: number}`.
- The four labels become one: "Continue".

### 3.3 Migration and tasks in progress

- No SQL migration in WP-R1 to WP-R4. The new StepDetail fields have zod defaults.
- Rows from before the upgrade lack `checked`. Continue then resets with the patch, and continue.md carries the patch.
- An old setup mark holds a plain hash. The reset then keeps today's rule. The next green setup writes the new form.
- An old `blocked_json` without `options` gets its options from its kind in `taskDto`.

### 3.4 BRIEF and spec wording

- BRIEF.md:493: "Continue goes on from where the build stopped and keeps the work. 'Start the step again' resets to the last commit and keeps the discarded changes as a patch file."
- BRIEF.md:289 and :493 ("stops and proposes a split") change only after Q1. design.md:399 changes too.
- spec.md sections 6.7, 6.12, and 6.25 change in the package that changes the behavior.

## 4. Work packages

One implementer at a time. WP-R1a, R1b, and R1c form the first release and fix the top pain points.

| WP | Tier | Scope | Depends on |
|---|---|---|---|
| R1a No rerun on Continue | implementer | `worktree.ts` (setup mark, `resetWorktree`), `loop.ts` (setup, drive preflight, final checks, own review), `shared/task.ts` (StepDetail `head`, `commands`), tests | none |
| R1b Continue keeps the work; time limits off by default | implementer-xhigh | `implement.ts` (`checked`), `loop.ts` (drive, buildParts, resume, answer, allow, limit, askAllow, `dirtyBefore`), `context-files.ts` (`continueFile`), implement prompt line, resume option `start-step-again`, step time and part time default off, tests | R1a |
| R1c One Continue in the UI | implementer | `model.ts`, `TaskView.tsx`, `taskDto` (`options`, `canRestartStep`), reason texts, screenshots, README, e2e | R1b |
| R2 A step at its limit continues by itself | implementer-xhigh | `implement.ts`, `loop.ts` auto continuation, `CONTINUE_MAX`, Log tab note | R1b |
| R3 Merge routes and options | implementer | `limit`, `setupAgain`, `dismiss` into `resume`; delete `driveSetup` and kind `push`; "Go on without these fixes"; UI options; screenshots | R1c |
| R4 Docs | implementer | spec.md 6.7, 6.12, 6.25; design.md:399; BRIEF.md:493; docs/smoke-task.md | R3 |
| R5 Size note at the part end (after Q1) | implementer | `sizeCheck`, commit, ready screen, BRIEF.md:289, 493 | R3 |
| R6 Git snapshot survives a restart (Q4) | implementer-xhigh | `gitstate.ts` (snapshot in the part folder), `recoverTasks`, restart check | R1b |
| R7 Session resume of a cut step (Q5) | implementer-xhigh | new gate in `scripts/gate/claude-checks.ts`, `claude.ts`, `implement.ts` | R2 |

WP-R1a tests: setup does not run after a reset that removed only Claude's files, and runs after a reset that removed a setup file (rewrite `tests/tasks/loop.test.ts:1845`). Stop during the own review, then Continue, runs no checks and no review run. The mark keeps both formats (`tests/tasks/worktree.test.ts:207`). Risk: a stale record; the checks skip needs a clean status, the equal head, and the equal command hash.

WP-R1b tests: Stop during a check, then Continue, keeps the implement changes and runs no implement step (rewrite loop.test.ts:991). A fake CLI case writes a file and passes the step time; attempt 2 reads continue.md, and the commit holds the file. Red after N tries, then Continue, keeps the changes and runs N fix steps. After `recoverTasks`, Continue resets with the patch in continue.md. A row without `checked` resets. A continued tests step is not refused as "wrote no test". A denied path still resets. Risk: a plan change in a cut step hides; `dirtyBefore` catches it.

WP-R1c tests: each row of 2.5 in `tests/web/tasks-model.test.ts`; e2e labels in `task-small.e2e.ts` and `task-setup.e2e.ts`; screenshots checked for real names.

WP-R2 tests: fake CLI cases for a turn cap then success, and a timeout then success; a second cap stops the build; the budget check still stops the build. Risk: cost, at most twice the step turns or time.

WP-R3 tests: the option form of the limit, setup, and dismiss tests; API tests for each option; 409 for an option that does not fit the reason.

## 5. Invariants

- `after()` runs for every run end, also a cancel (`jobs.ts:1537`).
- The commit takes new files from every Claude step after the last commit row (`implement.ts:589-601`).
- `written` is recorded for every step end state (`implement.ts:978-999`).
- `git clean -ffd` without `-x` keeps ignored files and prints each removed path (`worktree.ts:391-392`).
- The baseline runs once per part (`loop.ts:1086`).
- Each push runs preflight (`pr.ts:334, 451, 671, 763`).
- The git snapshot lives in memory only (`gitstate.ts:25, 52-80`), so a restart cannot verify the git state.

Not verified: whether a CLI child survives an app restart; how often a stop leaves only Claude's files.

## 6. Open questions

1. Q1. The line limit: stop during the build, or a note at the end? Recommended: a note on the ready screen with "Change the limit". Split is not built, so the stop gives no real choice.
2. Q2. Does a step at its time limit or turn cap continue by itself once, with no click? Recommended: yes, once. A second cut asks for Continue.
3. Q3. Add "Go on without these fixes" for review points after 2 fix rounds? Recommended: yes. The points stay listed and are never posted.
4. Q4. After an app restart: reset with the patch in continue.md, or persist the git snapshot so the files stay (WP-R6)? Recommended: reset with continue.md now; WP-R6 only if restarts are common.
5. Q5. Resume the same Claude session for a cut step (WP-R7)? Recommended: not now. Measure continue.md first.
6. Q6. Keep "Run setup again" as an option that deletes the setup mark, and drop its separate driver? Recommended: yes.
