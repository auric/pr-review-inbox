# Plan for PS6, PS7a and PS7b, and what PS8 and PS9 hold

Planned on 2026-11-13 against branch ps1 (PS4 WP-1 and WP-2 committed, WP-3 in progress). Merge main into ps1 before PS6: main already has the Jenkins client, `settings.jenkins()`, the CI server card, the fake Jenkins server, spec 6.29 to 6.31, and a newer `notify.ts`. So PS7b only adds wiring.

The design does not hold together in four places. The plan settles each one from the code:

- CI run row kind. Design 2.3 makes the red-build run a `fix` row. Section 9.3.3 and ps5 D4 make it a follow-up. Decision: both new runs are `instruct` rows with a `purpose` field.
- "Fixed in" drafts. `ReplyPayload.fix.id` points at a `fix_commit` row, and a task commit has none. Decision: `fix.id` is nullable. The reply run that sorted the comments owns the drafts, because `CURRENT_DRAFTS` needs a run with a PR.
- Red-build mode is lost. `dropSessions` deletes the whole `task_part_session` row with `ci_fix_left` and `ci_fix_max`. Decision: clear only the session columns.
- Mode machine. Section 9.3.5 says the red-build mode is not a machine. The user rule says every event is an edge in machine.ts. Decision: a two-state `ciMachine` with full tests.

Two Jenkins facts are open: is the build status URL that Bitbucket stores a URL that the log read accepts (new probe fact CI13), and does a push start a build (CI14; if not, every red-build mode ends after 60 minutes).

## 0. Baseline

- Labels: [exists] committed on ps1; [WP-3] uncommitted; [PS4 WP-n] or [PS5] planned; [main] only on main.
- Main has `src/server/ci/jenkins.ts` (`createJenkinsClient`, `readLog`, `MAX_LOG_BYTES = 2 MB`), `settings.jenkins()`, `CiSettings.tsx`, `tests/support/fake-jenkins.ts`, AC-B283 to AC-B292, spec 6.29 to 6.31, the newer `notify.ts` with `part_ready`, and the agent file library.
- ps1 uses AC-B293 to AC-B384. This plan starts at AC-B385.
- Migrations 052, 053, and 054 exist on ps1. The next free number is 055.
- RESERVED on ps1 still holds RESTART, UPDATE, and CONFLICT. PS4 WP-4 and WP-5 remove them.

## 1. Design gaps and decisions

1. Kind of the CI run: a PR-comment run and a red-build run are `instruct` rows. Item `C<n>` for comments, item `B<n>` for a red build. `instructDetail` gets `purpose: "message" | "comments" | "ci"` (default `message`), `comments`, and `ci`. So `FOLLOW`, `isFollow`, `requeue`, `endFollow`, and the D4 map work with no change. Numbered items keep the `Q.committed` check of each follow-up apart.
2. Untrusted text: comment text and log text never go into "Your instructions". Each goes into its own context file, `comments.md` or `ci-log.md`, passed as the `failure` file of `runStep`. `implementPrompt` gets purpose lines for `comments` and `ci`. "# Your instructions" shows only for purpose `message`. `bashFailure` keeps the given file name instead of renaming to `failure.md`.
3. "Sort the comments" uses the existing `POST /api/prs/:id/reply-run`. Only one task route is new: `POST /tasks/:id/parts/:part/comments`.
4. "Fixed in" drafts of a task commit: the drafts are items of the reply run that sorted the comments. `ReplyPayload.fix.id: number | null` (null: a task commit). Readers: outbox.ts `fixCheck` (blocked as `unpushed` until `pr_commit` holds the commit); drafts.ts `UNDONE`, items.ts `SQL.undone` (no match); stats.ts (left out); shared/outcome.ts (label falls back to `shortHash`); review/history.ts and web/pr/history.ts (null guard).
5. A missing verdict gives a Log note and no new draft (pushback 6.23.4 "counts as fixed" is unsafe for text that posts).
6. `group` leaks into `ReplyPayload` through the `Omit` of `ReplyDraft`. Add `"group"` to the `Omit` and `group?: number | null`.
7. Push, then post: `pushNow` awaits one sync cycle, at most `SYNC_WAIT_MS = 60 s`. The Task view then calls `POST /prs/:id/confirm` with the chosen replies. If the forge still lags, a derived wait "N replies wait" offers "Post N replies".
8. A sorted run is sent when an instruct row of the part has `instruct.comments.run` equal to that run.
9. `MAX_REPLY_THREADS = 25` caps one sort. The "PR comments" row stays while more threads wait.
10. Parts with several repositories: PS6 and PS7 cover the main PR (`task_part.pr`) only. The Fix refusal covers `task_part.pr` and `task_pr.pr`. The red-build tick shows only for a part with one PR row.
11. Task link: a live task PR is the PR of a `task_part` or `task_pr` row whose part is not adopted and whose task is not done or failed. The PR detail DTO gets `task: {id, key, part} | null`. Fix start and the Apply of an older fix run answer 409 on a live task PR. An adopted part keeps Fix.
12. Plan source for PR runs: a PR run reads the plan files from its snapshot at the PR source head and answers.md from `stepAnswers`, capped at `PLAN_CONTEXT_BYTES = 60 KB`.
13. Drop the pushback 6.23.8 "decision" line for the PR Fix agent, because Fix refuses task PRs. Keep only the reply lines.
14. Add `ciMachine` (states off and on) with tests.
15. Drop the section 9.3.5 RESTART edge: the mode starts only after a push, and RESTART needs an unpushed part. RESTART still clears the fields.
16. `dropSessions` becomes an UPDATE that clears only the session columns. `partSession` returns null when `file` is null.
17. A task Stop sends `CI_STOP`.
18. A manual push while the mode is on: the confirm hides the checkbox and says "Red-build fixes are on (1 of 2 used)." A `ciFixes` value answers 409.
19. The automatic push notification needs migration 055, which rebuilds `task_event` with the kind `ci_push` (the kind has a CHECK).
20. Log size: a pasted log keeps its last `OUTPUT_TAIL = 64 KB` in `detail_json`. A server read keeps up to `MAX_LOG_BYTES = 2 MB` at run start, so the database never stores it.
21. Result cases: a quote not in the log gives `found = false` and the note "The app did not find this line in the log."; cause infra or unknown with changed files runs the normal gate and commit and ends the mode; cause code or test with no change gives a row with "Go to the build".
22. Comment and CI runs must work on the fresh-session path with continue.md. Tests cover the resume gates off and on.
23. Doc drift: integration-check.md on ps1 still says CI12 is NOT RUN; record it as PASS in PS7b-0. PS4 WP-8 merges section 9 into the ps1 copy of part-session.md.

## 2. State machines

### 2.1 PS6 and PS7a: no change to the task, part, or phase machines

Both runs are phase `following`. Every edge they use exists in `phaseMachine`:

| Step | From | Event | Guard | To | Sender |
|---|---|---|---|---|---|
| The route writes the waiting row, then the driver starts | idle | GO | follow | following | loop `phases` |
| The run changed no file | following | RUN_DONE | unchanged | idle | loop `followRun` |
| The run changed files | following | RUN_DONE | none | checking | loop |
| Checks green, then one commit | checking | CHECKS_GREEN | none | idle | loop `checkGate` |
| Red checks with tries left | checking | CHECKS_RED | triesLeft | fixing | loop |
| Red checks with no tries left (red/checks) | checking | CHECKS_RED | none | idle | loop |
| The own review is due | idle | GO | review | reviewing | loop |
| Clean review | reviewing | CLEAN | none | idle | loop |
| First turn cap | following | RUN_CUT | firstCut | following | loop `claude` |
| Second cut (stuck) | following | RUN_CUT | none | idle | loop |
| Run end with a reason | following | WAIT | none | idle | loop |
| Stop | following | STOPPED | none | idle | route stop |

Routes: `POST /tasks/:id/parts/:part/comments` and `POST /tasks/:id/parts/:part/ci` send GO with `follow`. `POST /api/prs/:id/reply-run` sends no task event. `POST /tasks/:id/parts/:part/push` moves `pushed` only. REASON_EXITS does not change.

Section 9.6 order of the derived waits after PS6 and PS7a: a PR row failed; a pointer row; the base branch changed; PR conflicts; Claude asks for the base; unpushed commits, with or without replies; replies wait (new); comments sorted; PR comments; CI result with no change; build failed, mode off; red-build fixes on; the base moved while the PR is open; in review.

### 2.2 PS7b: new `ciMachine` in machine.ts

- `CI_EVENTS = ["CI_ON", "BUILD_FAILED", "CI_PUSHED", "BUILD_PASSED", "CI_OUTSIDE", "CI_REASON", "PUSH_FAILED", "CI_STOP", "PR_ENDED", "BUILD_WAIT_DUE"]`.
- `CiContext = { last: boolean }`. `last` is true when `ci_fix_left` is 1 before the push.
- Stored state: `on` when `task_part_session.ci_fix_left > 0`, else `off`.
- `ciSend(db, part, event, ctx)` in tasks.ts checks `can()`, then writes the columns. A refused event from the sync or the loop writes nothing. A refused `CI_STOP` from the route gives 409 "Red-build fixes are off."

| State | Event | Guard | Target | Sender | Side effects |
|---|---|---|---|---|---|
| off | CI_ON | none | on | route push or route pr, after a successful push with `ciFixes` | `ci_fix_left = ci_fix_max = N`; arm BUILD_WAIT |
| on | BUILD_FAILED | none | on | sync (`onTaskPrs`, then `loop.ciSync`) | queue at most one ci follow-up for the pushed head, source server; `goPart` |
| on | CI_PUSHED | last | off | loop, after the ci follow-up ends with reviewing CLEAN and the push succeeded | `ci_fix_left = 0`; one `ci_push` event; Log note |
| on | CI_PUSHED | none | on | loop | `ci_fix_left - 1`; one `ci_push` event; arm BUILD_WAIT |
| on | BUILD_PASSED | none | off | sync: `pr_build` passed at `task_part.pushed` | Log note |
| on | CI_OUTSIDE | none | off | loop: `ci.cause` is infra or unknown | Log note |
| on | CI_REASON | none | off | loop `block` or `reason` for this part; route hold | Log note |
| on | PUSH_FAILED | none | off | loop: the automatic push failed | the failed push step holds the text |
| on | CI_STOP | none | off | route `ci-mode`; route stop | none |
| on | PR_ENDED | none | off | sync side effect of MERGED or DECLINED | none |
| on | BUILD_WAIT_DUE | none | off | timer: no `pr_build` for the pushed head within BUILD_WAIT = 60 min | Log note |

No terminal state; both states are reachable and have a way out. Recovery: `loop.recover` rebuilds BUILD_WAIT from `ci_fix_left > 0` and the `ended_at` of the newest ok push step; a past deadline sends BUILD_WAIT_DUE at once; `shutdown` clears the timers.

## 3. Routes and zod inputs

| Route | Input | Event | Refusals |
|---|---|---|---|
| POST /api/tasks/:id/parts/:part/comments (PS6) | `taskCommentsInput = {version, threads: positiveInt[] 1..MAX_REPLY_THREADS, unique}` | GO with follow, purpose comments | 409: no live task PR; the instructTarget texts; "Sort the comments first." 400: a thread not in the newest sorted run. |
| POST /api/tasks/:id/parts/:part/push | `taskPushInput` adds `ciFixes: int 1..CI_FIX_CAP` (PS7b) | `pushed` moves; CI_ON with `ciFixes` | existing pushNow texts; 400 "Red-build fixes work for a part with one repository."; 409 "Red-build fixes are on already." |
| POST /api/tasks/:id/parts/:part/pr (PS7b) | `taskReviewersInput` adds `ciFixes` | PR_OPENED; CI_ON after the push | as above |
| POST /api/tasks/:id/parts/:part/ci (PS7a) | `taskCiInput = {version, log: trimmed string 1..CI_PASTE_MAX}`, `CI_PASTE_MAX = 1_000_000`; PS7b makes `log` optional | GO with follow, purpose ci | 409: "This part has no PR of the app."; "Push the new commits first."; "The build of the newest commit did not fail."; the instructTarget texts. 400 (PS7b, no log): "Paste the end of the build log." |
| POST /api/tasks/:id/parts/:part/ci-mode (PS7b) | `taskVersionInput` | CI_STOP | 409 "Red-build fixes are off." |
| PUT /api/settings (PS7b) | `runLimits.redBuildFixes: int 1..5`, default 2 | none | none |

Reused unchanged: `POST /api/prs/:id/reply-run`, `GET /api/prs/:id/post-plan`, `POST /api/prs/:id/confirm`.

## 4. PS6: PR comments on a task PR

PS6-A Review side:
- shared/review.ts: `replyDraft.group` (int >= 1 or null, default null), `ReplyPayload` (`Omit "group"`, `fix.id` null).
- review/catalog.ts: reply lines only when task.md holds the plan. review/jobs.ts: the task.md of a PR run on a live task PR; `fix()` answers 409. review/fix-routes.ts: the Apply refusal; extract the per-thread draft writer from `finish` into review/drafts.ts as `writeThreadDraft` (keep `keptText`, `revisedText`). review/context-files.ts: `commentsFile`, cap `COMMENTS_BYTES = 48 KB`, UNTRUSTED banner. New tasks/task-pr.ts: `liveTaskPart(db, pr)`. Null guards in history and outcome. The PR detail DTO: `task`. fake-claude `echoReplies` gives `group`.
- Tests: group parses and defaults to null; the task PR context (control mutation: drop the live check); `fix()` 409 on a task PR and 202 on an adopted one; Apply 409; `fixCheck` with `fix.id` null stays unpushed (control mutation: return null for a null id); fix-routes tests stay green.

PS6-B Loop, routes, DTO:
- shared/task.ts: `instructDetail.purpose`, `instructDetail.comments = {pr, run, threads:[{thread, replyTo, group}], verdicts, drafted}`. shared/dto.ts: `taskCommentsInput`, `TaskPartDto.comments = {turn, sorted:{run, groups:[{n, threads:[{thread, place, judgement, body, item}]}]} | null, accepted}`.
- tasks/loop.ts: `comments()` route method (item `C<n>`); the comments branch of `followRun` (subject "<label>: Address the PR comments of part <ord>"); `commit()` calls `draftFixes(c, hash)` after `committed`; `endFollow` sets `drafted = true` with a note when Stop undid the work; `bashFailure` keeps the file name.
- tasks/implement.ts: `COMMENT_LINES`; purpose lines replace `modeLines`; `modeLine` "- Mode: comments"; the tail only for purpose `message`.
- tasks/tasks.ts: the comments fact in `taskDto`. tasks/routes.ts: the route. tasks/pr.ts: `deps.syncNow` returns a Promise; `pushNow` awaits it, capped at `SYNC_WAIT_MS`.
- Tests (new tests/tasks/comments.test.ts, fake key `implement:comments`): the event order; push-back only gives no commit and gives the drafts; red checks then Continue give the drafts at the next commit (control mutation: drop the `commit()` hook); Stop writes no Fixed-in draft; resume gates off and on; requeue keeps `instruct.comments`; the route grid; `pushNow` awaits the sync (control mutation: no await).
- Build PS6-B only on committed WP-3.

PS6-C Web, e2e, docs: model.ts rows "PR comments", "Comments sorted", "Fixed, not pushed" with replies, "Replies wait", and the following sentence by purpose; data.ts actions `sort-comments`, `send-comments`, `push-post`, `post-replies`; new CommentGroups.tsx (one radio per group: Fix by default for valid or partly, Push back for invalid, Reply only for a question); the push-and-post confirm; the PR view Fix button on a task PR opens the Task view; tests/web, new tests/e2e/task-comments.e2e.ts, screenshots, README, CHANGELOG, spec 6.28 PS6 lines.

PS6 acceptance criteria:
- AC-B385. `replyDraft.group` is an integer of 1 or more, or null, with default null. Old drafts parse.
- AC-B386. A PR run on a live task PR holds "# The plan of the task" in context/task.md: the plan files at the source head and answers.md, within PLAN_CONTEXT_BYTES, plus the plan and group reply lines. Other PRs get neither. This replaces AC-B113.
- AC-B387. `TaskPartDto.comments` gives `turn`, `sorted`, and `accepted` for the main PR of a live task part, and null otherwise.
- AC-B388. The comments route queues one waiting instruct row with purpose comments, item `C<n>`, the run, and the threads with their groups. Each refusal of section 3 answers with its sentence.
- AC-B389. The comment run gets context/comments.md as untrusted data, grouped, within COMMENTS_BYTES, the comment lines, and no "Your instructions" section. It runs with the resume gates off and on.
- AC-B390. Each thread takes one verdict. An unknown ID drops with a note. A missing verdict gives "No verdict for thread N" and no new draft.
- AC-B391. A push-back writes a draft with origin nofix and Claude's reason at the run end, also when no file changed. A draft that the user edited or accepted gets the text as a revision.
- AC-B392. A run that changed files gives the gate and one commit. Each fixed thread gets "Fixed in <short>: <reason>" with `fix: {id: null, commit}`. After red checks, the drafts come at the next ok commit. A Stop that undoes the work writes none.
- AC-B393. The own review runs after the comment commit.
- AC-B394. A draft with `fix.id` null posts only when `pr_commit` of the current heads holds its commit. UNDONE, items, history, outcome, and stats accept a null id.
- AC-B395. "Push and post N replies" pushes through `pushNow`, which awaits one sync (at most SYNC_WAIT_MS), then confirms only the chosen replies. A still unpushed draft posts nothing; "N replies wait" offers "Post N replies". No request goes to the forge before a click.
- AC-B396. Fix start on a live task PR answers 409 "This PR belongs to task <KEY>. Fix its comments from the Task view." The Apply of an older fix run answers 409. An adopted part keeps Fix.
- AC-B397. The PR detail DTO names the live task part, and the PR view Fix button opens that Task view.
- AC-B398. The rows PR comments, Comments sorted, Fixed not pushed with replies, Replies wait, and Following (comments) each have one test with at most one primary, in the order of section 2.1.
- AC-B399. task-comments.e2e.ts covers sort, send, a push-back draft, a Fixed-in draft, push and post, and no URL outside the app.

## 5. PS7a: red build from a pasted log

PS7a-A Server:
- shared/task.ts: `instructDetail.ci = {pr, head, build:{name, url} | null, source: "paste" | "server", text: string | null, result:{cause, quote, found} | null}`, `CI_PASTE_MAX`. shared/dto.ts: `taskCiInput`, `TaskPartDto.ci = {step, head, cause, quote, found, changed} | null`.
- tasks/loop.ts: `ci()` route method (item `B<n>`, the last OUTPUT_TAIL bytes cut at a UTF-8 boundary); the ci branch of `followRun` with the `ciLogFile` header "# Build log", the quote check after CRLF to LF and an ANSI strip, subject "<label>: Fix the build of part <ord>".
- tasks/implement.ts: `CI_LINES` (design 2.3 plus the ci result rules), `modeLine` "- Mode: ci". tasks.ts: the ci fact. routes.ts: the route. fake-claude: key `implement:ci` with a default ci result.
- Behavior: cause infra or unknown with no change gives no commit. Cause code or test gives the gate, a commit, the own review, then "Push to <branch>". Nothing pushes by itself.
- Tests (new tests/tasks/ci.test.ts): quote found and not found; infra gives no commit; code gives a commit and the push row; a paste over the cap keeps the tail; each refusal; the fresh-session path. Control mutation: skip the quote check.

PS7a-B Web, e2e, docs: the build-failed row gets "Let Claude fix the build", which opens a paste dialog; following row "Claude fixes the build of part k."; no-change rows "Claude says the build failed outside the code: <quote>." and "Claude changed no file for the red build: <quote>." with "Go to the build" (the http(s) URL from `BuildStatus.url`); tests/web; new task-ci.e2e.ts with the fake Bitbucket build control; spec 6.28 PS7a lines; README; CHANGELOG.

PS7a acceptance criteria:
- AC-B400. The ci route queues one waiting instruct row with purpose ci, item `B<n>`, the PR head, and the last OUTPUT_TAIL bytes of the paste. It refuses each case of section 3 with its sentence.
- AC-B401. The ci run gets context/ci-log.md as untrusted data and the ci lines. `ci.found` is true only when the quote is in the log after the normalization.
- AC-B402. Cause infra or unknown with no change gives no commit and the row with "Go to the build".
- AC-B403. Cause code or test with a change gives the gate, one commit, the own review, then "Push to <branch>". Nothing pushes by itself.
- AC-B404. A quote not in the log adds "The app did not find this line in the log." A null ci result gives the note "Claude gave no cause."
- AC-B405. The build-failed row, the paste dialog, the following row, and the no-change row each have one test. task-ci.e2e.ts covers paste, run, and push row, with no URL outside the app.

## 6. PS7b: Jenkins log read and red-build fixes

- PS7b-0 Wording and facts: apply section 3 items 1 (BRIEF.md ~237), 6 (~162), and 7 (~175), and item 14 bullets 1 and 3 to the CLAUDE.md hard rules (main already has items 8, 15, and the token bullet). integration-check.md: CI12 PASS (text/plain, X-Text-Size, no X-More-Data, one call for a finished build); add CI13 and CI14. Edit the jenkins.ts "not verified" comment for a log within the cap.
- PS7b-P Probe CI13: scripts/gate/ci.ts and tests/gate/ci.test.ts take the URL of the first FAILED status of the CI3 list and run the CI12 read on it. PASS: HTTP 200 with X-Text-Size. The output stays masked.
- PS7b-A Machine and storage: machine.ts `ciMachine`, `CI_EVENTS`, `CiContext`, RESERVED entries with owner "PS7b-B"; machine tests (table, reachability, no dead end, sender scan, purity, mermaid snapshot; control mutation: delete the BUILD_PASSED edge); migration `055_task_event_ci.sql` rebuilds `task_event` with the kind `ci_push` and keeps rows and IDs; tasks.ts `SESSION_SQL.drop` becomes an UPDATE that keeps `ci_fix_*` (control mutation: the DELETE), `partSession` reads `file` null as no session, `ciSend`.
- PS7b-B Wiring: loop.ts `ciSync(db, prIds)` from the `onTaskPrs` listener; BUILD_FAILED queues a ci row with source server for `task_part.pushed`, at most one per head; BUILD_PASSED and PR_ENDED end the mode; the server read in `followRun` (`settings.jenkins()`, then `readLog(status url)`); a read error gives error/app with the JenkinsError text, then CI_REASON; a URL outside the base gives the paste path; after `phases()` in `driveFollow`, a ci row in mode on with no reason and head != pushed calls the injected `push`, then CI_PUSHED or PUSH_FAILED; BUILD_WAIT timers in `rearm`, `recover`, `shutdown`, capped at 2^31-1 ms. pr.ts `autoPush` under the `opening` lock; CI_ON after a successful push with `ciFixes`. routes.ts: the `ci-mode` route, the late-bound `push` dep, Stop sends CI_STOP. notify.ts: the `ci_push` text "Claude pushed a fix for the red build of part <k> (<n> of <N>)." shared: `RUN_LIMITS.redBuildFixes`, the inputs, `TaskPartDto.ciMode`; settings.ts: the runLimits field. Tests: new tests/tasks/ci-mode.test.ts with the fake Jenkins (at most N pushes with lease and fast-forward check; each end rule; BUILD_WAIT and its recovery; one notification per push; the token in no file, context file, prompt, or Log line; the multi-repository refusal; control mutation: drop the `last` guard).
- PS7b-C Web, e2e, docs: the push and PR confirms get a checkbox with a number box (default from Settings); the mode row "Claude fixes red builds of part k by itself (n of N used)." with More "Stop red-build fixes" and "Go to the PR"; with the server read, "Let Claude fix the build" skips the paste box (`TaskDto` `ciRead` per part); RunLimits field "Red-build fixes"; task-ci-mode.e2e.ts, screenshots, README, CHANGELOG, spec 6.28 PS7b lines.

PS7b acceptance criteria:
- AC-B406. `ciMachine` follows section 2.2, with table, reachability, no dead end, sender, purity, and mermaid tests.
- AC-B407. Migration 055 keeps every `task_event` row and ID and accepts the kind `ci_push`.
- AC-B408. `dropSessions` clears the session columns and keeps `ci_fix_left` and `ci_fix_max`.
- AC-B409. The push and PR routes take `ciFixes` 1 to 5 for a part with one repository. A successful push sends CI_ON and sets left and max to N. A failed push leaves the mode off. Several repositories give 400. The mode on gives 409.
- AC-B410. After a sync cycle, a part in mode on whose `pr_build` failed at `task_part.pushed` gets one ci follow-up with source server per head. A passed build at that head and the PR end end the mode.
- AC-B411. A ci run with source server reads the log through `settings.jenkins().readLog` at run start. The token never reaches SQLite, a file, a prompt, or a Log line. A read error gives error/app and ends the mode. A status URL outside the base gives the paste path.
- AC-B412. After a ci follow-up in mode on ends with a clean own review, the app pushes through `pushChanged` (pre-flight, explicit lease, fast-forward check, no `+`), sends CI_PUSHED, and adds one `ci_push` event. The last allowed push ends the mode.
- AC-B413. The mode ends on cause infra or unknown, any reason of the part, a failed push, "Stop red-build fixes", a task Stop, the PR end, and BUILD_WAIT with no status for the pushed head. Each end writes one Log note.
- AC-B414. BUILD_WAIT is armed after each push in the mode. `loop.recover` rebuilds it, a past deadline ends the mode at once, and `shutdown` clears it.
- AC-B415. The confirm checkbox, the mode row, "Stop red-build fixes", and the Settings field each have a test. task-ci-mode.e2e.ts runs one automatic push against the fake Jenkins and the fake Bitbucket.
- AC-B416. BRIEF.md and CLAUDE.md hold the approved wording of section 3 items 1, 6, 7, and 14. integration-check.md records CI12 as PASS and lists CI13 and CI14.

## 7. What PS8 and PS9 hold

- PS8 docs (implementer): BRIEF.md section 3 items 2 to 5 and 9 to 13; spec.md 6.2 (task, part, phase, and CI mode tables and diagrams from `machineMermaid`), 6.14, 6.25, and 6.1, 6.7, 6.12, 6.18, 6.21.7, 6.26; the CLAUDE.md status line; docs/smoke-task.md parts P (part sessions and U111), PC (PR comments), CI (CI13 and CI14); integration-check.md rows U97 to U111; pushback.md (WP-PB2 replaced by PS6-A); ci-builds.md Layer C status; part-session.md sections 2.3, 9.3.5, 9.3.6, 9.5; CHANGELOG user-visible lines.
- PS9 spec size levels (implementer-xhigh, design 2.19, 9.3.1, 9.8): plan.ts `docNames` per size and the card and brief grammar; the spec run prompt per size; machine.ts guards `small` become `noSpecPr` (medium joins) and `planReview` becomes `specPr`; the README diagram with tests/tasks/readme.test.ts; pr.ts `prText` from the card or the brief; the card path `./card.md` outside repo/; the plan screen; "Approve the plan" again for an old approved medium plan (gap G1). Tests: small commits no card; medium has one brief and no spec PR; large keeps the spec PR; old medium tasks keep their flow. It touches machine.ts and loop.ts, so it cannot run beside PS7b-A or any loop package.

## 8. Gates and user facts

| Fact | State | Effect |
|---|---|---|
| Section 3 approval | Approved | The wording lands in PS7b-0 and PS8. |
| CI12 log read | PASS (2026-11-13): text/plain, X-Text-Size, no X-More-Data, one call | `readLog` needs no change. A second GET for a log over 2 MB is not verified. |
| CI13 (new) | Not run: is the Bitbucket status URL of a failed build readable by `readLog`? | If it fails, "Let Claude fix the build" stays paste-only, and the mode cannot read logs. |
| CI14 (new, manual) | Not run: does a push to a task branch start a build that posts a status? | If not, each mode ends after BUILD_WAIT. |
| CI7 to CI9 (job path) | CI7-CI9 skipped | Only Layer B needs them. PS7 starts no build. |
| Gate B37 | PASS in full on CLI 2.1.323 (2026-11-13) | Comment and CI runs can resume the part session once SESSION_GATES turn on (PS4 WP-3). |
| progressiveText strips ConsoleNotes | Not verified | Affects the quote check only. |

## 9. Invariants

- Every push goes through `pushTaskBranch` with an explicit `--force-with-lease`, a fast-forward check, and no `+` refspec. `pushChanged` runs the pre-flight first.
- A "Fixed in" reply posts only when `pr_commit` for the current heads holds its commit.
- A reply draft belongs to a PR through `review_run.pr`.
- A follow-up is a waiting instruct row. `requeue` copies `instruct`. `endFollow` restores `blockedBefore` on Stop.
- The `failure` file of `runStep` goes to the untrusted files.
- The machines are pure. `send` asserts `can()`. A refused phase event goes to `failed()`.
- The sync listener runs after each cycle with the changed PR IDs.
- Only app code calls `settings.jenkins()`. `readLog` refuses another origin, a path outside the base, and user info, and follows no redirect.
- `ci_fix_left` and `ci_fix_max` exist (052). `group` and the ci detail are zod only, so PS6 and PS7a need no migration.

## 10. Open questions

1. Which URL did the CI12 run use for `--build`: a status URL from Bitbucket or a build page URL? (CI13.)
2. Does a push to a task branch start the Jenkins job? (CI14.)
3. Does `task.docs_json` follow an accepted plan change? The plan prefers the snapshot at the PR head, so this does not block.
4. "Post the replies only" in "Comments sorted": recommended "Go to the PR", because the sort drafts are not accepted yet.
5. Can `loop.matchBase` run inside a running follow-up driver during the automatic push? No lock check and no test cover it.

## 11. Work packages

| WP | Tier | Files | Starts after | Parallel |
|---|---|---|---|---|
| WP-M Merge main into ps1 | main session merges; implementer-xhigh resolves | jobs.ts, claude.ts, stream.ts, notify.ts, spec.md, part-session.md, CHANGELOG, README | PS4 WP-8 and PS5-D | none |
| PS6-A Review side | implementer | review side files, new tasks/task-pr.ts, tests/review | WP-M | PS7b-P |
| PS6-B Loop, routes, DTO | implementer-xhigh | shared/task.ts, dto.ts, loop.ts, implement.ts, tasks.ts, routes.ts, pr.ts, tests | PS6-A, WP-3 committed | PS7b-P |
| PS6-C Web, e2e, docs | implementer | web/tasks, CommentGroups.tsx, PR view link, tests, e2e, screenshots, docs | PS6-B | PS7a-A |
| PS7b-P Probe CI13 | implementer | scripts/gate/ci.ts, tests/gate/ci.test.ts | WP-M | any; then the user runs CI13 |
| PS7a-A Server | implementer | shared/task.ts, dto.ts, loop.ts, implement.ts, tasks.ts, routes.ts, fake-claude ci key, tests | PS6-B | PS6-C |
| PS7a-B Web, e2e, docs | implementer | web/tasks, tests, task-ci.e2e.ts, screenshots, docs | PS7a-A and PS6-C | PS7b-A |
| PS7b-0 Wording and facts | implementer | BRIEF.md, CLAUDE.md, integration-check.md, jenkins.ts comment | PS7a-B | PS7b-A |
| PS7b-A Machine and storage | implementer | machine.ts, machine tests, 055, db.ts, db tests, tasks.ts | PS7a-A | PS7a-B, PS7b-0 |
| PS7b-B Wiring | implementer-xhigh | loop.ts, pr.ts, routes.ts, notify.ts, shared, settings.ts, ci-mode tests, recover tests | PS7b-A, PS7b-0, CI13 result | none |
| PS7b-C Web, e2e, docs | implementer | web/tasks, RunLimits.tsx, tests, task-ci-mode.e2e.ts, docs | PS7b-B | none |
| PS9 Size levels | implementer-xhigh | plan.ts, tasks.ts, machine.ts, pr.ts, loop.ts, plan screen, README diagram, tests | PS7b-C (or before PS6-B) | none |
| PS8 Docs | implementer | section 7 list | PS7b-C and PS9 | none |

Each package ends green on `bun run check`. Web packages also run `bun run test:e2e` on their own ports and print the `E2E code:` line. Screenshot packages check each image for real names.

Main risk: PS6-B and PS7b-B refactor `followRun` and `driveFollow`, which the uncommitted WP-3 is still shaping.
