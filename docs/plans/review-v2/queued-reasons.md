# Queued reasons per part (design, 2026-11-06)

Status: design for audit fix 6 (docs/plans/review-v2/state-audit.md), written against main cf9973e. Nothing is built yet. It becomes spec.md section 6.25, because pushback.md reserves 6.23 and add-repo.md reserves 6.24. It takes AC-B147 to AC-B156, because add-repo.md uses numbers up to AC-B146. The tasks.md wave is WQR.

## Decision

- Each part keeps its own reason. A reason still holds every part, so the 6.20.6 rule stays. Only the drop goes away.
- Storage is one nullable column, `task_part.blocked_json`. There is no queue table. A part halts at its first reason, so it holds at most one reason.
- `task.blocked_json` stays as "the first reason", so every existing reader keeps working.
- Actions act on the first reason only. The one exception: a single answer submit answers every open loop question, as answer() does today (loop.ts:2299, Q.openLoop :395).
- There is no new task state, part state, machine event, or route. machine.ts does not change.
- Rejected option: a part without a reason builds on while another part waits. Every action handler refuses with BUSY while a driver runs (loop.ts:2311, 2350, 2397, 2453). So the user could not answer until that build halts. That option needs actions during a build first (audit Part B, last row).

## Spec text: 6.25 Reasons of parts that build at the same time

**6.25.1 Rule.** A part can get a reason that names a step while the task holds a reason of another part. That reason waits in the part's row. The part writes its question row, plan change row, or allow request as usual, then halts. A reason with no step is not kept, for example budget, preflight, wait for the merge, or a step-less error. The part finds it again at the resume, and no Claude run is lost. A pause and a wait for the run slot never wait in a part row.

**6.25.2 Data.** Migration `0NN_task_part_blocked.sql` (the next free number; the Unrestricted package takes 047): `ALTER TABLE task_part ADD COLUMN blocked_json TEXT;`. Existing `task.blocked_json` values stay as the first reason. There is no backfill. A reason that the old code dropped comes back at the resume, as before.

**6.25.3 Writes (tasks.ts).**
- The part of a reason is `b.part`, or else the part of `b.step`, the same rule as `currentPart` (tasks.ts:800).
- `holdBlocked`: with no reason, or a soft one, it works as today. Otherwise it writes b to the part row when three things are true: b names a step, b's part is not the part of the first reason, and that row is empty. The write also moves the task version. In every other case nothing changes.
- `setBlocked(null)` moves the first non-empty part row, by ord, into `task.blocked_json` and clears that row, in one transaction. `moreTime` and `setSettings` do the same. A `keep` flag skips the move for "Run setup again".
- `advance()` clears every part row when the task goes to stopped or failed.

**6.25.4 Actions (loop.ts).**
- `claude()` (:826) and `askAllow` (:803) write their row and their reason. They halt without a row only when the part cannot keep the reason.
- After an action clears its reason, the loop starts only if `task.blocked_json` is null after the move. Otherwise the action answers as before and no driver starts. This applies to answer, allow, limit, spec-change accept and reject, resume, wait-merge, and base.
- answer clears each part row question whose step owns an answered question. It clears the first reason only when that reason's step owns an answered question.
- limit also clears every part row of kind size. A part over the new limit stops again at its size check.

**6.25.5 Other actions.**
- Stop removes every reason. Resume after Stop builds each part again from its last commit.
- A restart keeps every reason, because recovery stops only tasks with no reason (tasks.ts:188-191).
- Pause works as today, and a hard reason replaces the pause.
- Tell Claude answers 409 "Another part waits for you. Act on each reason first." while any part row holds a reason. The send restart in answer and allow takes `open[0]` (loop.ts:2314), and a mixed set of questions breaks that.
- Run setup again answers 409 for a part whose row holds a reason. Otherwise it clears the first reason with `keep`. A green run ends only the setup reason of its own part. Today it ends the setup reason of any part (loop.ts:1784-1792). It then moves the next reason up, and it builds only when no reason is left.
- Update, Fix these too, Open the PR, and the scheduler already need `task.blocked_json` to be null (tasks.ts:1007, loop.ts:2414, pr.ts:286, gates.ts:108). They need no change.

**6.25.6 UI.**
- `TaskPartDto.blocked` carries the reason in the part row. `TaskRowDto.queued` carries the count.
- Sub-task list: a part with a reason, first or waiting, shows the reason text with the actor "You". Rows stay in part order.
- Part view of a part with a waiting reason shows its text as the status, with the detail "Act on <part> first.". It has no primary button. More holds See why (for its own step) and Stop.
- A held part with no reason shows "<part> waits until you act on <part>." instead of "Claude builds <part>.".
- In a task with sub-tasks, each loop question in the Questions form shows its part label.
- The Tell Claude box shows nothing while a part waits. "Run setup again" is hidden for a part with a waiting reason.
- Task list row: "<text>, and N more" (shared `rowStatus`).

**6.25.7 Notifications.** Each new reason, first or waiting, gives one needs_you event. Moving a reason up gives no event: `noteTaskWaits` skips a wait whose reasons are a subset of the last wait.

**6.25.8 Edits to other files.** spec.md 6.2 (the blocked line), 6.3 (the task_part column), the 6.20.6 Reasons bullet, and section 8. README line 254 ("When one sub-task needs you…"). One step in smoke-task.md part T.

**6.25.9 Acceptance criteria**
1. AC-B147. Two parts build. Part 1 asks a question, and part 2 asks 1 s later. Both question rows exist. `task.blocked` names part 1, and the part 2 row names part 2. The implement call count stays at 2 (concurrent.test.ts).
2. AC-B148. One answer submit with both answers clears both reasons. Each part builds again with exactly one more implement call. answers.md holds both answers.
3. AC-B149. Part 2 proposes a plan change while part 1 asks. After the answer, the plan change is the first reason, no driver runs, and the call count does not change. Accept commits the change on the part 2 branch, and both parts build.
4. AC-B150. A waiting allow request and a waiting denied path each save their patch, and the part worktree is at its last commit. Each one becomes the first reason in turn.
5. AC-B151. Resume on a first red or denied reason with another reason waiting answers 200, moves the waiting reason up, and starts no driver.
6. AC-B152. Stop clears `task.blocked_json` and every part row. Resume builds both parts from their last commits. A restart keeps both reasons.
7. AC-B153. Tell Claude and Run setup again on a waiting part answer 409 with their sentences. With two red setups, a green Run setup again on the first part moves the second reason up and builds nothing. A second Run setup again builds every part. This changes the existing setup test in concurrent.test.ts.
8. AC-B154. A budget, preflight, or wait-for-merge reason of another part leaves its row empty.
9. AC-B155. After the migration, a task with blocked_json keeps it, and part rows read NULL (tests/storage/db.test.ts). Each new reason gives one needs_you event, and moving a reason up gives none (tests/tasks/notify.test.ts).
10. AC-B156. The UI model rows of 6.25.6 have tests in tests/web/tasks-model.test.ts. One e2e test in task-subtasks.e2e.ts covers two parts that ask: both rows show, and one submit answers both.

## Invariants (evidence)

- I1. A part holds at most one reason, because `block()` throws Halt (loop.ts:538-541).
- I2. With no setup driver running, a non-empty part row means `task.blocked_json` holds a hard reason. Three facts keep this true: part rows are written only under a hard reason, `setBlocked(null)` moves the next reason up, and Stop clears every row. Update, Fix, Open the PR, and the scheduler rely on it.
- I3. Part rows hold reasons only in implementing, for a task with sub-tasks. `buildsAtOnceOf` gives 1 for any other task (tasks.ts:973). The task reaches ready only when no part is implementing (6.20.7).

## Work packages (run order, file-disjoint)

1. WP-QR-D (implementer): spec.md 6.25 and the 6.25.8 edits, tasks.md wave WQR, the CLAUDE.md status line, smoke-task.md.
2. WP-QR1 (implementer-xhigh): the migration, `src/server/tasks/{tasks,loop,notify}.ts`, `src/shared/{dto,task-status}.ts`, `tests/tasks/{concurrent,loop,tasks,notify}.test.ts`, `tests/storage/db.test.ts`. It covers AC-B147 to AC-B155. The fake CLI `match` with `delayMs` (tests/support/fake-claude.ts:18, :78) gives each part its own question. Control mutation: remove the part row write in `holdBlocked`, and AC-B147 must fail.
3. WP-QR2 (implementer, with the skills shadcn, vercel-react-best-practices, and web-design-guidelines): `src/web/tasks/{model.ts,TaskView.tsx,Questions.tsx}`, `tests/web/tasks-model.test.ts`, `tests/e2e/task-subtasks.e2e.ts` with its serve.ts scenario, README, and `bun run screenshots`. It covers AC-B156.

## Risks

- `setBlocked(null)` now moves a reason up at all 20 call sites. A site that clears the reason to start a driver would block that driver. Tell Claude and Update refuse first, and Run setup again uses `keep`. Each driver start needs a test with a waiting reason.
- The task version moves at each part row write. An open answer form then gets 409 and refreshes. This is intended, because the form must show the new question.
- Two old wastes stay. A held part with no reason runs its step again after the resume (6.20.6). A part that ends its own review while held also runs it again (loop.ts:1434). Both are out of scope.
- Reasons move up in part order, not in arrival order.

## Open questions (recommendation each)

1. Should the user act on a waiting reason before the first one? Not now. The first-reason-only rule keeps every handler as it is. Look at it again with the audit's BUSY row.
2. Should parts without a reason keep building? Not now (see Decision).
3. Should reasons move up in arrival order (a `blocked_at` column)? No. At most 2 reasons can wait, because BUILDS_AT_ONCE_CAP is 3 (src/shared/task.ts:174).
4. Should step-less reasons wait too? No. They cost no Claude run, and they come back at the resume.
5. Should Tell Claude work on the first reason while another waits? No, because of the `open[0]` send restart in 6.25.5.

## Unverified

- A nested `db.transaction` inside `setBlocked` runs as a savepoint in bun:sqlite.
- The existing setup test needs only the AC-B153 change.

I did not check the bun:sqlite savepoint behavior or run any test. The main risk is the automatic move-up inside `setBlocked`, which reaches every call site.
