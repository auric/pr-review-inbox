# Build a Jira task: one Claude session per part

Status: design of 2026-11-12 against main 31f8205 plus the uncommitted package WP-R1b. PS0 is code complete: the Gate B37 script (`scripts/gate/claude-checks.ts`, `scripts/gate/session.ts`) and CI12 (`scripts/gate/ci.ts`). Gate B37 and CI12 are not run. The other packages are not built. All user requirements of 2026-11-12 are decided. User answers of 2026-11-12: Q1 to Q9 take the recommended answers. Section 3 is approved, items 1 to 15, with the red-build fixes as a tick per part. RUN_TIME_MAX_MS (240 min) stays. This design replaces WP-R2 to WP-R5 and WP-R7 of build-redesign.md. It also replaces the per-step lead of agent-workflow.md option C. It folds in items 1 to 7 and 11 of build-redesign.md section 7.

Line numbers of loop.ts, implement.ts, stream.ts, context-files.ts, tasks.ts, and shared/task.ts are those of the WP-R1b tree. The other files are equal on main.

## Summary

- One Claude session builds one part. Claude writes the tests and the code. It runs the build and the tests through the existing shell modes, and it ticks the tasks in the plan file.
- The app runs the final checks before each commit. Red checks resume the session with the failure tail, at most "Test-fix tries" times.
- Follow-ups resume the same session: red checks, critic and review points, PR comments, red CI builds, your messages, and conflict help. A guard falls back to a fresh session with continue.md.
- The own review stays a fresh, separate run. A cheap Haiku critic runs once after the first commit of a build.
- The safety rules stay: the app-owned worktree, the full git deny, the path check, the git state check, the keep-work rule, and push only on a click. A denied path now undoes only its own files.
- Time limits go. A stall and loop guard stops a stuck run and keeps the work. A usage limit shows "Resume at <time>".
- Each resume fact waits for Gate B37. Until then, each follow-up starts a fresh session with continue.md. So the first packages need no gate.

## 1. Facts of today's code that change

### 1.1 The step chain of one part

- runPart (loop.ts:1705-1747) does these steps in order:
  - the plan commit;
  - setup (:1683-1703);
  - the baseline (:1244-1247);
  - a size check;
  - for each plan part, a tests step (:1321-1343) and one taskStep per open task (:1348-1362);
  - the final checks (:1735-1738), the own review (:1739), and REVIEWED (:1740-1745).
- taskStep runs one implement step (:1351). Then it runs the scoped checks with fix steps (greenOrFix :1252-1284), ticks the task (:1353-1357, tickTask :267-270), and makes one commit per task (:1358).
- The tests step may change only test files, and its new tests must fail (:1329-1339).
- The own review is a fresh review run on a sanitized snapshot (reviewRun :1366-1443). A confirmed blocker or major point starts a fix step, the checks, a commit, and a new review. This repeats at most REVIEW_FIX_TRIES = 2 times (:180, :1453-1477).
- "Fix these too" (drivePoints :1865-1884) starts one more fix step. Tell Claude (driveInstruct :2035-2071) starts one more instruct step.
- Each Claude step goes through runStep (:881-965), then startStep (implement.ts:857-1073), then implementSteps (jobs.ts:1465-1549), then run (claude.ts:586-703).

### 1.2 Session persistence and transcripts

- implementArgs passes `--no-session-persistence` (claude.ts:539). No task step keeps a session.
- The CLI still writes the per-cwd folders (Gate B4). The finally block of run() deletes them (claude.ts:700, removeCwdFolders :338-346).
- A run without the flag writes `<session id>.jsonl` into `~/.claude/projects/<encoded cwd>/` (integration-check.md:190).
- implementSteps deletes the run folder, with mcp.json, agents.json, and shell.json, after each run (jobs.ts:1536-1544).
- Only "Ask your session" resumes a session. It passes `--resume <abs .jsonl> --fork-session --no-session-persistence` and gets the read tools only (resumeArgs claude.ts:459-488).
- Verified on resume:
  - the original file stays unchanged (U47);
  - `--tools`, `--restricted`, and `--strict-mcp-config` apply, for read tools (U48);
  - `--json-schema` works (U49);
  - a fork without `--no-session-persistence` writes a new file with a new ID in the project folder of its cwd (U59).
- Not verified: Edit, Write, Bash, and the `--settings` rules on resume (build-redesign.md section 2.8).
- session-consult.md:19 says to always pass `--fork-session`. Without it, a running background session attaches, or the command exits with code 1.
- review_run keeps the session ID of each run (jobs.ts:1728).
- The fake CLI accepts `--resume` only with `--fork-session` (tests/support/fake-claude.ts:383-387).

### 1.3 Stop, kill, restart, and Continue

- Stop: loop.stop (loop.ts:2541-2570) calls review.cancelTask (jobs.ts:2445-2447), which ends every run of the task. cancel kills the process tree (claude.ts:706-711, killTree :304-335). after() still runs (jobs.ts:1546).
- The run end kills leftovers through the Job Object or the marker scan (claude.ts:691-699).
- Continue goes from loop.resume (loop.ts:2575-2634) to drive (:1821-1845) and settle (:1752-1761), then runs runPart again.
  - Records skip the steps that are done.
  - A cut step gets context/continue.md (continuation :833-876, continueFile context-files.ts:141).
- StepDetail.checked marks a step whose path check and git check passed, for any run end (implement.ts:1011; shared/task.ts:587).
- App restart: recoverTasks fails each open step and stops the task (tasks.ts:252-260). The git snapshot lives in memory only (gitstate.ts:25, :52-88). So the next Continue resets with a patch.
- A failed run stops the task with kind error (implement.ts:1030-1031, stopForRun tasks.ts:612-617). The usage limit takes the same path.

### 1.4 The stream parser and the init check

- createStreamParser (stream.ts:117-273) records each tool_use with its parent and ends it on its tool_result. It keeps the rl-main text and the agent reports as notes, up to NOTES_MAX = 200,000 (:47, :141-147).
- Init check: a tool in init.tools that is outside the allowed set goes to badTools (:221-226). The runner kills the run at once (claude.ts:642-646), and classify gives tool_check (stream.ts:300). Each process sends its own init event, so the check runs on a resume too.
- More than REFUSED_MAX = 5 refusals end the run (stream.ts:30; claude.ts:649-652).
- The parser keeps only a "rejected" flag from rate_limit_event (stream.ts:257-258). The type has resetsAt (run-log.ts:160-163), but no code reads it.
- The app type of an assistant message has no usage (run-log.ts:81-87). So the app cannot see the context size of a run.
- classify takes the last result that has structured_output (stream.ts:296). errorKind maps usage_limit, auth, max_turns, and schema (:283-291).

### 1.5 Limits that cut a part-sized run

- RUN_TIME_MAX_MS = 240 min caps every process, also with the step time off (shared/task.ts:119; claude.ts:613).
- STEP_TURNS: tests 60, implement 80, fix 40, instruct 80, resolve 40 (shared/task.ts:203).
- stdin is one Blob with the whole prompt (claude.ts:622), and run() waits for the process to exit (:673). No message can reach a running process.
- continueFile cuts the diff at FAILURE_TAIL = 32 KB (context-files.ts:141-155; shared/task.ts:214). This fits one step, not one part.
- One step takes one pool slot (jobs.ts:2464-2499; spec.md section 6.26).

### 1.6 Path check and undo

- pathCheck (implement.ts:137-192) and treeCheck (:208-271) list these problems: denied paths, hidden paths, unlisted CI configuration, links, nested repositories, files outside repo/, and changed ignored files.
- Any problem undoes the whole step. undoStep resets the worktree to the step start (:299-309). undoTrees resets every tree (:275-292).
- A changed ignored file removes the whole worktree (:285-288, :302-305).
- A git state change takes the same undo (:970, :973) and blocks with denied_path (:1027-1029).
- outsideRepo fails each changed file under context/ (:107-125). So Claude cannot tick the copy of the plan in context/spec/.
- The commit takes a new file only when a Write or an Edit named it (spec.md section 6.7, "New files of a commit").

### 1.7 PR comments, Tell Claude, and the PR Fix

- The task loop does not take PR comments as an instruct step. src/server/tasks holds no "comment" or "thread" code (search of 2026-11-12).
- Tell Claude sends only typed text, as one instruct step (spec.md sections 6.18.1 and 6.18.2; loop.ts:2035-2071).
- pushback.md:149 queues "PR threads into Tell Claude". spec.md:2949 only reserves section 6.23. pushback.md is not built.
- The PR Fix works on every own PR (jobs.ts:2329). It applies its edits in the user's clone (BRIEF.md:149-150, :174).
- The review code has no task PR check. So today a second writer on a task branch is possible.
- The reply run gives each thread a judgement: valid, partly, invalid, question, settled, unsettled, or followup (shared/review.ts:311-338). It has no group field.

### 1.8 CI builds and plan sizes

- Layer A reads the build status from Bitbucket (ci-builds.md:23-81). Layers B and C are on hold.
- The probe found one parameterized pipeline job, not a multibranch project (ci-builds.md:92-93; integration-check.md CI7).
- No probe check read a build log (integration-check.md CI1 to CI11).
- A small task gets plan.md. Medium and large tasks get design.md, spec.md, tasks.md, and a spec PR (plan.ts:642; spec.md section 6.1).
- The PR text comes from the plan (prText pr.ts:134-144).

## 2. Target design

### 2.1 Terms

- Part session: one Claude conversation that builds and fixes one part.
- Session run: one `claude -p` process of a part session. It takes one pool slot and one task_step row.
- Turn cap: `--max-turns` of one session run.
- Session heads: the HEAD of each edit worktree of the part at the last point where the app brought the session up to date.
- Fresh session: a new conversation that gets the full first prompt and context/continue.md.

### 2.2 Session lifecycle

**Start**

- The first build run of a part starts a fresh session. It uses implementArgs without `--no-session-persistence`.
- The runner gets `keep: {dir}`. Before removeCwdFolders (claude.ts:700), it moves `<projectsDir>/<encoded cwd>/<session id>.jsonl` into dir. The ID comes from init.session_id, and the file keeps its name.
- dir is `<taskDir>/sessions/part-<ord>/` (taskDir worktree.ts:67). It is outside the part folder (partDir :68), so the path check never sees it.
- task_part_session (section 5.3) stores these values: the session ID, the file name, its SHA-256, the session heads, the context size, and the run count.

**Runs**

- Each later run passes `--resume <absolute kept file> --fork-session`. It also passes every flag of its own run kind again (U48).
- The fork writes a new file with a new ID (U59). The keep step moves that file. The app stores it, then deletes the older file. So a part keeps one transcript.
- The original file stays unchanged (U47). So a failed resume loses nothing.
- The stdin of each resumed run starts with a short rules digest. Compaction can drop the first prompt, so the rules must come again.

**Guard: a run resumes only when all five rules hold**

1. The kept file exists, and its SHA-256 equals the stored value. Bash can write outside the cwd in Most commands and Unrestricted mode (SU9, SU19), and a transcript replays as trusted history.
2. The HEAD of each edit worktree equals its session head.
3. The context size of the last run is known and is at most "Session context cap". An unknown size counts as over the cap.
4. The last run of the session ended without a denied path and without a git state change. Such a run can carry a prompt injection in its context.
5. Gate B37 passed the facts that the run kind needs (section 4).

**What moves the session heads**

- The app commit after green checks. This commit holds only the work of the session, its ticks, and the plan files of the app.
- The line-end repair commit (matchBase, loop.ts:1137-1171). The next run gets the line "The app fixed the line endings of <n> files."
- The accept of a plan change that the session wrote.
- An update from the base branch whose conflicts a session run resolved (section 2.13).
- No other head move counts: not a clean update, "Get their commits", a pointer commit, or "Start this part again". After one of these, the next follow-up starts fresh.

**Fresh session**

- The run gets the full first prompt for its purpose and context/continue.md.
- continue.md (untrusted data) holds:
  - the subject lines of the part commits (base..head);
  - the diff stat;
  - the ticked tasks and the open tasks;
  - the summary and the notes of the last run;
  - the changed paths, when the worktree holds work.
- context/continue-diff.md holds the full diff since the last commit, cut at CONTINUE_DIFF_MAX = 2 MB. Claude reads it in parts. The FAILURE_TAIL cut stays for failure.md only.
- Some resumes fail before any tool event: no init, "No conversation found", or a process error. The app then starts one fresh session at once. The Log shows "The app could not resume the session. It started a new one with the earlier work."

**Cut runs**

- Stop, Hold, the stall guard, and the loop guard kill the process. The keep step still runs in the finally block.
- When U101 passes, the next run resumes the cut transcript. Else the app keeps the older stored file, and continue.md covers the cut run.
- The turn cap and the process cap (RUN_TIME_MAX_MS) continue once by themselves with "Continue where you stopped." (build-redesign.md Q2). A second cut waits for Continue.

**End and deletion**

- The app deletes the kept file and clears the session fields in these cases: the part PR merges or declines, the part is skipped, the user starts the part again, or the task closes or goes.
- So the transcript stays from the first build until the PR ends. PR comments and red builds can resume it.
- recoverTasks also deletes the per-cwd folders under projectsDir whose name starts with the encoded task root. A crash leaves such folders (BRIEF.md:445).
- After a restart, the stored transcript of the last finished run is the resume point. The next run gets the line "The last run stopped when the app stopped. Its changes are in the worktree. context/continue.md lists them."

### 2.3 What Claude is told

**First run of a session.** The stdin holds trusted app text, in this order:

1. Role: "You build part <k> of an approved plan in ./repo. You can change files only in ./repo. You post nothing. Git is denied. The app commits after its checks, and the user pushes." A task with several repositories adds the edit repositories of ./context/repos.md.
2. Plan: "./context/spec/ holds a read-only copy of the plan. Tick tasks only in <the tasks file of section 2.19>."
3. Work loop:
   - "Do the open tasks of ./context/step.md in plan order, one at a time."
   - "For each task, write or change its tests first. Run them and see them fail. Then change the code."
   - "Run the tests of the task. When its Done-when lines hold, change `### [ ] <id> ` to `### [x] <id> `. Tick only task headings. Change nothing else in the plan file."
4. Commands: the lines of the shell mode, as implementPrompt writes them today (implement.ts:391-415), plus one more line: "Write long command output to a file in ./scratch, and read its end with tail -n 200."
   - ./scratch is a folder of the part folder. The app empties it before each run.
   - The path check skips it (the skip list of outsideRepo, implement.ts:107-113).
5. Work rules (build-redesign.md section 7, item 3):
   - "Never skip, delete, or loosen a test to make it pass."
   - "Change a test only when the test is wrong. Say so in notes."
   - "./context/baseline.md lists the checks that fail on the part base. Do not fix them. Name such a failure in notes."
   - "Stop each background process that you started before you end the run."
6. Questions, allow requests, and plan changes: today's lines (implement.ts:356, :388-389, :441).
7. Result: "End the run when every open task is ticked and its tests pass, or when you need the user. Set done to true only then. List the IDs that you ticked in ticked."
8. The trust lines, the skills, the MCP lines, and the explorer rule, as today (:450-462).
9. The project instructions, and "Mode: build".

**Later runs (resume).** The stdin holds the rules digest, then "# Run <n>: <purpose>" and the lines of that purpose. The digest is about 10 lines: the folders, git denied, the trust lines, the tick rule, the result rule, and the untrusted-data rule.

| Purpose | Step row kind | Context files that the app writes | Lines |
|---|---|---|---|
| Continue after a cut | implement | continue.md when fresh | "The last run <ended at its turn cap, stopped, ...>. Go on from where you stopped." |
| Fix red checks | fix | failure.md (checkFailure, loop.ts:313) | "The app ran the checks. failure.md holds the output. Fix the cause." |
| Judge critic or review points | fix | failure.md with the points | pushback.md section 6.23.8 lines |
| PR comments | instruct | comments.md | pushback lines for comments, and "Give one entry in points for each thread." |
| Red CI build | fix | ci-log.md | "Find the cause in ci-log.md. Fix it when the code is at fault. When the cause is outside the code, change no file." |
| Your message | instruct | none | "Your instructions" holds the text (spec.md section 6.18.2) |
| Conflict help | resolve | conflicts.md | today's resolve lines (implement.ts:376-382) |
| Answer, allow choice, rejected plan change | the kind of the cut run | answers.md, step.md lines | today's lines |

implementResult (shared/task.ts:801-826) adds these fields:

- `ticked`: the task IDs, at most 30, default [].
- `points`: `[{id, verdict: fixed | pushback, why, reason, cite}]` (pushback.md section 6.23.2), default [].
- `ci`: `{cause: code | test | infra | unknown, quote} | null`, default null.

### 2.4 How the app learns progress

- Ticks: an ok Edit or Write event that targets the tasks file makes the app read that file from disk. The plan parser counts the ticked task headings of the part. The status line says "3 of 5 tasks done."
- Tick check at the run end: each changed plan file must equal its HEAD text, except `### [ ] <id> ` to `### [x] <id> ` for open task IDs of the part (the tickTask grammar, loop.ts:267-270). Any other change is a plan change, as today (loop.ts:1047-1056).
- `result.ticked` should equal the set of new ticks. A difference gives a Log note only.
- The Log shows the tool calls live (jobs.ts:1526-1529). The commands of the run go to detail.shell at the run end (implement.ts:953).
- Context size: the usage of the last main-thread assistant message, as input, cache-read, and cache-creation tokens (U105).
- Cost: implement.ts:1017-1021 adds the usage of each run to the part. U107 may show that a resumed run reports the totals of the whole session. If so, the app stores the session totals after each run and adds only the difference.

### 2.5 Path check and partial undo

The checks stay as they are. The undo touches only the problem paths. The app first saves a patch of those paths (savePatch with only, worktree.ts:389).

| Problem | Today | New |
|---|---|---|
| A tracked file at a denied, hidden, or unlisted CI path | The whole worktree goes back to the step start | `git checkout HEAD -- <path>` for that path only |
| A new file at such a path | git clean of everything | Delete that file only |
| A link | Remove the links, then reset | Remove that link only |
| A nested repository | Reset, then `clean -ffd` | Remove that folder only |
| A file outside repo/ | Remove it, then reset | Remove it only. ./scratch and the small card are skipped. |
| A changed file that git ignores | Remove the whole worktree | Delete those files only, and delete the setup mark, so setup runs before the next run |
| A change in a repository with access read or none | Reset every tree | Reset that repository only |
| The git link | Restore it, then reset | Restore it only |
| Git state (refs, cache config) | Restore it, then reset the worktree | Restore it, and keep the files (needs approval, section 3 item 3) |

- After the undo, the app runs the path check again. A problem that is still there takes the old full reset, with the patch.
- When the second check is clean, the run sets checked, and the other work stays.
- The part waits with "Needs you: Claude changed <path>, which a task may not change. The app undid that file and kept the other work." The primary button is Continue. The next run starts a fresh session (guard rule 4).

**Git snapshot on disk (build-redesign.md WP-R6)**

- Before each run, snapGit (gitstate.ts:52-88) writes `{files, refs, heads}` to `<taskDir>/part-<ord>.gitsnap.json`.
- After a restart, recoverTasks runs checkGit from that file. No app git call ran after the crash, so the missing watch changes nothing.
- A clean check keeps the work. So a restart no longer costs a whole part.

### 2.6 The final checks gate and the fix loop

1. A run ends with done true and with no reason.
2. The tick check and the path check have already run at the run end.
3. The app runs the build, test, and lint commands once (checks, loop.ts:1079). checksDone skips them when they were green at this head (:1125-1130).
4. Red: a fix run resumes the session with failure.md.
   - The red-before rule (:1263-1272) and the "changed no file" rule (:1280-1281) stay.
   - At most "Test-fix tries" runs follow (shared/task.ts:96, default 3). Then the part waits with "Needs you: the checks of part 2 stay red after 3 tries."
   - Continue gives 3 more tries, and the work stays.
5. Green: the app makes one commit with the user's name and email (commit, loop.ts:1209-1233).
   - Message: "<KEY>: <part title>", with the ticked task IDs in the body.
   - Later rounds use "<KEY>: Fix the review points of part 2", "<KEY>: Address the PR comments of part 2", or "<KEY>: Fix the build of part 2".
6. So each green gate gives one commit, and a half edit never reaches a commit unchecked.
7. The size check gives a note, not a stop (build-redesign.md Q1): "This PR has 520 changed lines, over your 400 limit." The note has a "Change the limit" link.
8. A run can end with done false, no question, no allow request, and no plan change. The part then waits with "Needs you: Claude ended the run before the part was done: <summary>. Continue resumes the session."
9. The baseline (loop.ts:1244-1247) runs once before the first run. context/baseline.md gives its red commands to Claude.
10. The tests-only rule of the tests step goes. A part that changed no path of the test globs gets this line on the ready screen: "Claude added or changed no test file." (DEFAULT_TEST_GLOBS, spec.md section 6.7).

### 2.7 The critic

- When: once, after the first commit of a build. It needs the committed base..head.
- Run: a task review run (review.taskRun, as reviewRun loop.ts:1366-1443) with item critic. It uses model haiku, no verify phase, no subagent, a fixed app prompt, the review finding schema, and 30 turns.
- Filter: validate (validate.ts) runs as for a review, with one more rule. The app keeps a finding only when each line of its anchor range is an added line of base..head.
- Kept points: one resume run judges them with the pushback lines. A push-back gets a Log line only. Then the gate of section 2.6 runs.
- No kept point: nothing runs. A failed critic gives a Log note and never stops the part.

### 2.8 The own review

- It stays a fresh, separate review run on the sanitized snapshot (reviewRun, loop.ts:1366-1443). It never resumes a session.
- Confirmed blocker and major points: a resume run of the part session judges them with the lines of pushback.md section 6.23.8.
  - Each push-back becomes a question (6.23.4).
  - Then the gate runs, and a new review follows, at most REVIEW_FIX_TRIES = 2 times (loop.ts:180).
- "Fix these too" sends the minor points to the session as one resume run.

### 2.9 Live messages

- The Tell Claude box (spec.md section 6.18.1) becomes the message box of the part. It shows in every state that has a worktree.
- While a run works, "Send" writes a stream-json user message to the stdin of that run (U104). The Log shows "Your message" with the time.
- While no run works, "Send" starts a run with the text as "Your instructions" (spec.md section 6.18.2).
- The text is user text. It can steer the work, but never the rules. The app never parses it.
- Runner: `--input-format stream-json`, with stdin as a pipe. The first message is the prompt. The runner closes stdin after a result event when no message waits.
- If U104 fails, a message sent during a run waits and goes into the next run as "Your instructions". The hint says "Claude reads this when the current run ends."

### 2.10 Stall and loop guard

- Stall: when no stream line comes for STALL_MS = 15 min and no tool call is open, the app ends the run.
- An open Bash call gets its own limit: the bash_timeout_sec of the repository plus 5 min (BASH_TIMEOUT_MAX_SEC = 3600, shared/task.ts:412). So the CLI ends a long command first.
- An open Agent call follows the normal rule, because its nested events keep the stream going.
- Loop: in one thread (one parent), the app counts consecutive calls with the same tool, the same input JSON, and the same result text.
  - At 3, it writes a Log note. With live input, it also sends "You made the same call 3 times with the same result. Change the approach, or set question and stop."
  - At 5, it ends the run.
- Both guards keep the work (the checked rule). The part waits with "Needs you: Claude sent nothing for 15 minutes. The app stopped the run and kept the work." The primary button is Continue.
- The settings "Task step time" and "Part time" go (shared/task.ts:92-93). RUN_TIME_MAX_MS stays as the cap of one process.

### 2.11 Usage limit

- The parser stores resetsAt from the last rate_limit_event with status rejected. Its unit is not verified (U106).
- The run ends with kind usage_limit (stream.ts:287). The part gets the new reason kind usage, with resumeAt. The task does not stop.
- Status: "Your Claude usage limit is reached. It resets at 14:30." The primary button is "Resume at 14:30".
  - A click before that time arms the resume. The status then says "Claude resumes at 14:30.", and More has "Cancel the resume".
  - A click after that time resumes at once.
  - When the CLI gives no reset time, the primary button is "Resume".
- The setting "Resume by itself after a usage limit" is off by default. When it is on, the app arms the resume at once. It resumes once per limit. A second limit needs a click.
- task_part_session keeps resume_at and resume_armed. A restart arms the timer again.
- The BRIEF wording changes (section 3, item 2).

### 2.12 Hold, Skip, and start again

- **Hold** (More, per part): the app cancels the run of that part only, with a new cancel by the key prefix `task:<id>:part:<part>:`. Today's jobs.ts:2445-2447 cancels the whole task.
  - The work stays. The status says "Part 2 is on hold. Its work is kept." The primary button is Continue.
  - Hold replaces "Pause after this step" (loop.ts:2529-2538) and "Pause after each task" (:1360-1361).
- **Skip this part** (a task with sub-tasks, before the PR of the part): a confirm comes first. Then the app saves the patch, sends ABANDON (machine.ts:109-110), removes the worktree, and deletes the transcript.
- **Start this part again** (before the first push only):
  - The confirm says "Claude starts part 2 again from the plan. The app keeps the old work as a patch and as a backup branch in the app cache. Nothing goes to Bitbucket."
  - The app saves the patch and writes `refs/rl/<task>/backup/part-<ord>-<n>` at the old head.
  - It resets the part branch to its plan commit, deletes the transcript, and clears the reason. The baseline and the setup mark stay.
- After the first push, "Start this part again" does not show. The app never force-pushes after the first push (BRIEF.md:175).

### 2.13 Update from the base branch

- The update stays app git (spec.md section 6.18.3). The push stays a click.
- At a conflict stop, the resolve run resumes the part session when the guard held at the update start. Else it is a fresh resolve run, as today.
- A resolve run keeps its limits:
  - no Bash (BRIEF.md:157; U99);
  - the path check on the unmerged paths (implement.ts:964-965);
  - the marker check;
  - RESOLVE_STOPS.
- An update with a session resolve moves the session heads. A clean update does not, so the next follow-up starts fresh.
- needsBase (spec.md section 6.18.2) stays.

### 2.14 PR comments on a task PR

1. A task PR with your-turn threads shows "3 comments on the PR of part 2." The primary button is "Sort the comments".
2. The click starts the existing reply run (draftReplies, jobs.ts:2292).
   - The run adds the plan and answers.md to context/task.md (pushback.md section 6.23.7).
   - replyDraft (shared/review.ts:314-338) adds `group`: threads with one cause share a number. The default null keeps old drafts valid.
3. The Task view lists the groups. Each group shows its threads, the judgement, the draft reply, and a choice:
   - Fix is the default for valid and partly.
   - Push back is the default for invalid.
   - A question thread gets Reply only.
4. The primary button "Send 2 groups to Claude" starts one instruct run of the part session.
   - context/comments.md is untrusted text that the app writes: each picked thread with its path, line, and messages, by group.
   - The result gives `points` for each thread: fixed, or pushback with a reason.
5. Then the gate of section 2.6, a commit, and the own review follow, as driveInstruct does today (loop.ts:2057-2066).
6. Drafts:
   - A fixed thread gets "Fixed in <short commit>: <what>" (BRIEF.md:535).
   - A thread that Claude pushed back on gets Claude's reason as its draft.
   - The user edits and accepts the drafts as today.
7. Out: one confirm "Push to <branch> and post 3 replies". It shows the branch, the commits, and each reply text.
   - The push goes first. Then the accepted drafts go out through the outbox.
   - A "Fixed in" reply never posts before its commit is pushed.
8. On a task PR, the PR-view Fix button opens this flow. The clone Apply refuses a task branch. This closes the second-writer gap of section 1.7.

### 2.15 Red Jenkins builds (refresh of ci-builds.md Layer C)

**Package C1, no token**

- The build-failed row (spec.md section 6.12) gets the primary button "Let Claude fix the build". It opens the box "Paste the end of the build log".
- The text goes to context/ci-log.md as untrusted data, cut to OUTPUT_TAIL = 64 KB (shared/task.ts:213).
- A fix run of the part session reads it. The result field `ci` gives the cause and one quote. The app checks that the quote is in ci-log.md.
- Cause infra or unknown, and no change: the status says "Claude says the build failed outside the code: <quote>." The primary button is "Go to the build".
- Cause code or test: the gate of section 2.6 runs, then a commit, then "Push to <branch>" (a click).

**Package C2, Jenkins token**

- Settings gets the Jenkins card of ci-builds.md:104-109: the base URL, the user, the CA file, and the token in the OS store under jenkins-token. Save checks whoAmI.
- The app reads the log with GET `<build URL>logText/progressiveText?start=<X-Text-Size − 2 MB>` (ci-builds.md:141).
  - It reads only when the origin of the status URL equals the configured origin.
  - It follows no redirect.
  - The new gate:ci fact CI12 checks this read.
- A run never gets the token and never calls Jenkins.

**Red-build fixes** (needs C2 and the hard-rule change)

- The push confirm of a part gets a checkbox: "When the build of this push fails, let Claude fix it and push the fix, up to [2] times. These pushes go to the PR without your look at the diff."
- Scope: this part branch only, from this push on.
- N: the number in the box. The setting "Red-build fixes" gives the default (2; range 1 to 5).
- Each automatic push uses the normal push path (push.ts:51-70): the explicit lease of the last pushed commit, the fast-forward check, no force, no `+`, and only task_part.branch.
- Each automatic push comes after green checks and after an own review with no must-fix point. It posts no reply, changes no PR text, and moves nothing in Jira.
- The mode ends when one of these occurs:
  - N pushes are used;
  - a build passes on the pushed head;
  - Claude gives cause infra or unknown;
  - any Needs you reason comes;
  - a push fails;
  - the user clicks "Stop red-build fixes";
  - the PR merges or declines;
  - no build status shows for the pushed head within BUILD_WAIT = 60 min.
- The last rule covers a job that a push does not start. That job behavior is not verified (ci-builds.md:92-93, :181).
- Each automatic push gives the notification "Claude pushed a fix for the red build of part 2 (1 of 2)." The Log shows the push row.
- task_part_session keeps ci_fix_left and ci_fix_max. "Start this part again" clears them.

### 2.16 Agent workflows

- The main thread of the part session is the lead of agent-workflow.md. It can use the pinned workflow of the task (task.workflow_json).
- Build, fix, and message runs use the workflow. Resolve runs, the critic, and the own review never use it.
- Agents that write files or run commands still wait for Gate B36. B37 adds one check: a resume keeps the limits of the agents file (U108).
- agent-workflow.md rejected option B for four reasons. This design answers each one:
  - the app runs the checks before each commit, so spec.md section 6.21.7 holds;
  - the path check and the git check run after each run;
  - a denied path undoes only its own files;
  - each run takes its own slot.

### 2.17 UI states

Each state has one primary button or none.

| State | Status sentence | Primary | More |
|---|---|---|---|
| Building | "Claude builds part 2: 3 of 5 tasks done." | none (message box) | Hold, Stop |
| Checking | "The app runs the checks of part 2." | none | Stop |
| Fixing | "Claude fixes the checks of part 2 (try 1 of 3)." | none (message box) | Hold, Stop |
| Critic or review | "A second Claude run reviews part 2." | none | Stop |
| Ready | "Part 2 is ready: 5 tasks, 340 lines, checks green." | "Open PR for part 2" | Show the diff, Fix these too, Start this part again |
| Claude asks | "Claude asks: <question>" | "Answer" | Use the recommended answers, Stop |
| Claude asks to run a command | "Claude asks to run a command." | "Continue" | Stop |
| Plan change | "Claude proposes a change to the plan." | "Review the change" | Reject, Stop |
| Needs you | "<cause>. Continue <what it does>." | "Continue" | options, See why, Stop |
| Usage limit | "Your Claude usage limit is reached. It resets at 14:30." | "Resume at 14:30" | Stop |
| Resume armed | "Claude resumes at 14:30." | none | Cancel the resume, Stop |
| On hold | "Part 2 is on hold. Its work is kept." | "Continue" | Skip this part, Start this part again |
| PR comments | "3 comments on the PR of part 2." | "Sort the comments" | Go to the PR |
| Comments sorted | "2 groups to fix, 1 to push back." | "Send 2 groups to Claude" | Post the replies only, Go to the PR |
| Fixed, not pushed | "Part 2 has 1 new commit. 3 replies wait." | "Push and post 3 replies" | Show the diff |
| Build failed | "The build of your PR failed: <name>." | "Let Claude fix the build" | Go to the PR |
| Red-build fixes on | "Claude fixes red builds of part 2 by itself (1 of 2 used)." | none | Stop red-build fixes, Go to the PR |
| Stopped | "Stopped at part 2. The work is kept." | "Continue" | Start this part again, Close the task |

- Every Needs you box uses Continue (build-redesign.md section 2.5). Stop stays in More.
- The Plan tab shows the tick progress of each part.
- The Log tab groups the runs of one session under "Claude session of part 2". Each run shows "resumed" or "new session".

### 2.18 Settings

Settings > Tasks > Run limits:

- "Test-fix tries" stays (1 to 10, default 3). It caps the fix runs of one gate.
- New: "Session context cap", 20,000 to 500,000 tokens, default 100,000 (question Q2).
- New: "Session run turns", 50 to 1,000, default 500. 1,000 is the profile bound (BRIEF.md:447).
- New: "Red-build fixes", 1 to 5, default 2.
- New: the switch "Resume by itself after a usage limit", off by default.
- "Task step time" and "Part time" go. The app ignores an old config value.

### 2.19 Spec size levels (build-redesign.md section 7, item 4)

| Size | Plan | Tasks file that Claude ticks | Spec PR | PR description |
|---|---|---|---|---|
| Small | A task card: goal, acceptance, tests, and tasks | ./card.md in the part folder. It is outside repo/ and never committed. The path check skips it. | no | The card (prText, pr.ts:134-144) |
| Medium | One short brief | repo/<spec dir>/brief.md, committed with the code | no (question Q9) | Goal and acceptance from the brief |
| Large | The full spec: design.md, spec.md, tasks.md | repo/<spec dir>/tasks.md | yes | As today |

- docNames (plan.ts:642) and the spec run prompt change per size.
- Medium leaves the spec PR states of the task machine (machine.ts:72-81).

## 3. Hard rules: wording for approval

Each item gives the line now and the new wording.

1. **BRIEF.md:237, principle 1.** Now: "Human gate: nothing goes to the code host without an explicit user action." Add: "One tick in the push confirm of a task part allows up to N pushes of red-build fixes for that part only (spec.md section 6.28)."
2. **BRIEF.md:241, principle 5.** Now: "No automatic retry after a usage limit. A task loop takes a run slot for each Claude step and frees it between steps." New: "No automatic retry after a usage limit, except the setting 'Resume by itself after a usage limit', which is off by default. With it, a part session of a task resumes once at the reset time that the CLI reports. A task loop takes a run slot for each run of a part session and frees it between runs."
3. **BRIEF.md:156, git state.** Now: "On a change, it restores them, saves the patch, resets the worktree to the step start, and waits". New: "On a change, it restores them, saves the patch, keeps the files that pass the path check, and waits with 'Needs you: Claude changed git state during the run. The app restored it.' The next run starts a new session." (Recommended; question Q4.)
4. **BRIEF.md:155.** Now: "After each Claude step, the app runs git status. A denied path (Denied paths, section 7), a link, or a path outside repo/ fails the step. The app saves the changes as a patch, then resets the worktree to the last commit." New: "After each run of a part session, the app runs git status. A denied path, a link, or a path outside repo/ fails the run. The app saves a patch of those paths and undoes only them. The other work stays. A problem that the undo cannot clear resets the worktree to the last commit."
5. **BRIEF.md:157.** Now: "The tests, implement, fix, and instruct steps also get the Bash tool when". New: "The build, fix, and message runs of a part session also get the Bash tool when". Then: "The interview, spec, resolve, critic, and own review runs never get it."
6. **BRIEF.md:162.** After "the user's look at each PR before the push", add: ", except the red-build fixes that the user ticked for a part".
7. **BRIEF.md:175.** After "go to Bitbucket only on a click", add: "One exception: the red-build fixes that the user ticked in the push confirm of a part. They push at most N fast-forward fix commits to that part branch. Each push follows green app checks and keeps the lease rules."
8. **BRIEF 3.6, new bullet (C2):** "Outbound calls can also go to the configured Jenkins origin. They occur on a Settings save or Test, and on a log read of a failed build of a task PR. The read follows 'Let Claude fix the build', or comes within the red-build fixes. The client sends GET only and uses https, except on localhost. It follows no redirect and calls no other origin. The Jenkins token uses the OS store under its own name."
   - BRIEF 3.5, new bullet: "A run never gets the CI token or calls the CI server."
9. **BRIEF.md:288-289, US10.** Now: "The tool then writes tests and code step by step, runs my approved build and test commands, and reviews its own work." and "A pull request that grows past the line budget stops and proposes a split. A stopped task resumes from its last good step."
   - New: "The tool then writes tests and code in one Claude session per part, runs my approved build and test commands before each commit, and reviews its own work. Small: one pull request whose description is the task card. Medium: one pull request with a short brief and the code."
   - New: "A pull request over the line budget shows a note with the count. A stopped task goes on from where it stopped and keeps its work."
10. **BRIEF.md:429, flags.** Add: "From its second run on, a part session run of a task drops --no-session-persistence and adds --resume <transcript> --fork-session (spec.md section 6.28)."
11. **BRIEF.md:444-445.** Now: "App runs never resume a session. ... Only 'Ask your session' ... resumes a session". New:
    - "PR runs never resume a session. Two features resume one."
    - "'Ask your session' forks the user's own session with --fork-session and --no-session-persistence."
    - "A part session of a task forks its own newest transcript with --fork-session."
    - "The app moves each transcript of a part session into the task folder, outside the run folder."
    - "It checks the SHA-256 of the transcript before each resume."
    - "It deletes the transcript in these cases: the part PR merges or declines, the part starts again or is skipped, or the task closes."
12. **BRIEF.md:462, History bullet.** "No run resumes a session." becomes "No PR run resumes a session."
13. **BRIEF.md:493, task loop.** New:
    - "Task loop of one part: one Claude session writes tests and code for the open tasks."
    - "It runs the build and the tests through its shell mode, and it ticks each task in the plan file."
    - "The app runs the approved checks before each commit. Red checks resume the session, at most 'Test-fix tries' times."
    - "A cheap critic and the own review (finder and verify phase) follow. Confirmed points resume the session, at most 2 review rounds."
    - "A part over the line budget shows a note. Then the part waits for its PR click."
    - "Each stop says why and offers one button. Continue goes on from where the build stopped and keeps the work."
    - "'Start this part again' resets the part before its first push. It keeps the old work as a patch and a backup branch."
14. **CLAUDE.md, Hard rules.**
    - "Nothing goes to Bitbucket or Jira without an explicit user action. The app posts, not the AI." becomes "Nothing goes to Bitbucket, Jira, or Jenkins without an explicit user action. The app posts, not the AI. The red-build fixes of a task part are one explicit action for at most N pushes (spec.md section 6.28)."
    - "The Bitbucket token never goes into SQLite, localStorage, logs, URLs, or prompts." becomes "The Bitbucket, Jira, and Jenkins tokens never go into SQLite, localStorage, logs, URLs, or prompts."
    - In the Build a Jira task exception, "A push and a PR create or update go to Bitbucket only on the user's click." becomes "... only on the user's click, or within the red-build fixes that the user ticked for that part."
15. **BRIEF section 7, layout.** Add `src/server/ci/`, with all Jenkins calls in `src/server/ci/jenkins.ts` (ci-builds.md:135).

## 4. Gate B37

Numbers: B36 and U96 are the last numbers in use (agent-workflow.md section 6). B37 takes U97 to U111. The gate:ci probe gets CI12.

How to run it:

- Run `bun scripts/gate/claude-checks.ts --only B37`, then `bun scripts/gate/sanitize-claude.ts`. The sanitizer must print `hits=0`.
- The gate uses haiku and makes at most 9 calls (8 planned). Only U109 uses sonnet.
- It uses a temp part folder with repo/ (a temp git repository), context/, and an app folder. The app folder holds the app's implementArgs, shell.json (an allowlist with the probe pattern and `sleep *`, because U101 and U104 wait in a sleep), shellEnv, and agents.json (rl-main and rl-explorer).
- Runs 2 to 4 resume the moved run 1 file, so one failed run costs only its own facts.
- CI12: `bun run gate:ci -- <PR URL> --jenkins <Jenkins URL> --jenkins-user <user> --build <build URL>`. The build URL comes from `--build`, because the CI3 status URL shape (`/<s>/<s>/job/<s>/<s>`) is not verified as a build URL (integration-check.md CI3). So CI12 does not show how the app gets from a status URL to a build URL. PS7b needs that fact.

| Fact | Check | PASS | If it fails |
|---|---|---|---|
| U97. Resume with the implement flags | `--resume <abs> --fork-session` with `--restricted`, `--tools Read,Grep,Glob,Edit,Write,Bash,Agent`, `--settings`, `--agents`, `--agent rl-main`, `--json-schema`, `--max-turns`, and no `--no-session-persistence` | Exit 0. init.tools equals the flags. permissionMode is default. structured_output parses as implementResult. | No run resumes. Every follow-up starts fresh. |
| U98. Limits after a resume | The resumed run tries a Write to ../outside.txt, `git status`, an unlisted command, and `<probe> && git status` | Each one is refused with the app label. The probe pattern runs. | Shell runs never resume. |
| U99. Fewer tools on a resume | A resume without Bash and Agent (a resolve run) | init lists no Bash. A Bash call never runs. | Resolve runs start fresh. |
| U100. New head | Between the runs, the gate commits a change of a.txt and edits b.txt on disk. The resumed run reads both and edits a.txt. | The run sees the new text. INFO: is an Edit of a file read in run 1, with no new Read, refused as "modified since read"? | Only app commits of the session's own work move the session heads. Drop the line-end note rule. |
| U101. Resume after a kill | The gate kills the CLI after the first Write event of a run that sleeps in Bash, then resumes the moved partial transcript | Exit 0. The run knows the Write. | After a kill, resume the older stored file, and add the continue.md line. |
| U102. Process cap | The same kill path as U101 (claude.ts:635-638) | INFO only. | As U101. |
| U103. Transcript place | Without `--no-session-persistence`: the new file is `<projectsDir>/<encoded cwd>/<id>.jsonl`. List the subagent and memory files. Resume from the moved file in another folder. | All hold. The moved file keeps its name. | When a moved file cannot resume, copy it back before each resume. Else no run resumes. |
| U104. stream-json input | `--input-format stream-json` with the implement flags. While the run waits in `sleep 20`, the gate writes a second message that asks for a marker file. | The marker exists. The result has structured_output. The CLI exits after stdin closes. INFO: does the CLI wait for stdin after a result? | A message waits for the next run (section 2.9). |
| U105. Context size | Each main-thread assistant event carries message.usage with input, cache-read, and cache-creation tokens | Present on each such event. | The size stays unknown, so each follow-up starts fresh. |
| U106. Rate limit fields | Record each rate_limit_event: status, resetsAt and its unit, rateLimitType | INFO. | Show "Resume" without a time. |
| U107. Usage of a resumed run | Compare total_cost_usd, usage, and modelUsage of the first run and the resumed run, and the cache-read tokens of the first call of the resumed run | INFO: per process, or the whole session. | The app subtracts the stored totals when the values are for the whole session. |
| U108. Agents on a resume | The resumed run asks for general-purpose and for rl-explorer | general-purpose is refused. rl-explorer runs read-only. | Resumed runs drop the Agent tool. |
| U109. Other model on a resume | A resume with another `--model` and `--effort` | Exit 0. init.model is the new model. | A profile change starts a fresh session. |
| U110. Critic run | `--model haiku` with the review flags, no verify phase, and reviewJsonSchema | structured_output parses. | The critic uses the reviewer model of the profile. |
| U111. Days later | Manual, in docs/smoke-task.md part P: resume a kept transcript after at least one day and one CLI update | INFO. | A failed resume starts fresh (section 2.2). |
| CI12 (gate:ci) | GET `<build URL>logText/progressiveText?start=0` with the token. Record the status, X-Text-Size, X-More-Data, the content type, and the size. | HTTP 200 with X-Text-Size. | C2 reads consoleText and cuts the tail in the app, or the feature stays paste-only. |

Script outline:

1. b37Setup: the temp folders; a temp git repository with a.txt and b.txt; the app files from implementArgs and writeShellSettings.
2. run1, create: a Write of repo/a.txt, the probe through Bash, and the structured result. Record init.session_id, the transcript path, the usage of each message, the rate limit events, and the result usage.
3. Move the transcript into `<tmp>/sessions/` and hash it. Commit a change in the temp repository. Edit b.txt.
4. run2, a resume with all flags: the checks of U98, U100, and U108. Record the new transcript, the hash of the moved original, and the usage.
5. run3, a resume without Bash and Agent (U99).
6. run4, a resume with another model (U109).
7. run5, the kill test: start a run with a Bash sleep, kill it after its first Write event, and move the partial transcript. Then run6 resumes it (U101).
8. run7, stream-json input (U104).
9. run8, the critic schema (U110).
10. Print one line per fact, and write `.gate0/v3-local/results.b37.json`.

## 5. Delete, merge, migrate

### 5.1 Code that goes away

- loop.ts:
  - testsStep (:1321-1343) and taskStep (:1348-1362);
  - the test file rules (:1309-1317);
  - the scope parameter of greenOrFix and checks (:1252-1253, :1079);
  - accepted (:827-828) and continuation (:833-876);
  - drivePoints as its own driver (:1865-1884);
  - driveSetup and SETUP_WAITS (:2108, :199);
  - the per-task pause (:1360-1361) and the pause gates (:2529-2538).
- checks.ts: scopedCommands and runEntries (:354-443), with their tests. No other caller exists (search of 2026-11-12).
- shared/task.ts:
  - STEP_TURNS for tests and implement (:203);
  - stepMinutes and partMinutes (:92-93);
  - STEP_TIME_MS (:202);
  - the reason kinds budget and push (:363-377).
- implement.ts: the time part of partBudget and stepTimeout (:488-523), and the prompt lines of tests and implement (:359-360).
- tasks.ts: moreTime (:558).
- web/tasks/model.ts ActionKind (:30-75): continue, keep-size, setup, pause, and dismiss go into the options of resume. time-limit stays for setup commands.
- Behavior that goes:
  - the tests step whose tests must fail (AC-B10);
  - the scoped checks;
  - the commit per task;
  - the size stop;
  - the step time and the part time.

### 5.2 Merge

- limit, setupAgain, and dismiss merge into resume with options (build-redesign.md section 3.2).
- driveInstruct carries every message run: your message, PR comments, red builds, and "Fix these too".
- The Tell Claude box and the live message box become one box.

### 5.3 Migration 052_part_session.sql

049 is the last migration. Other packages may take 050 and 051, so this one starts at 052.

```sql
CREATE TABLE task_part_session (
  part INTEGER PRIMARY KEY REFERENCES task_part (id) ON DELETE CASCADE,
  session_id TEXT,
  file TEXT,
  file_sha256 TEXT,
  heads_json TEXT NOT NULL DEFAULT '[]',
  context_tokens INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  totals_json TEXT,
  resume_at INTEGER,
  resume_armed INTEGER NOT NULL DEFAULT 0 CHECK (resume_armed IN (0, 1)),
  ci_fix_left INTEGER,
  ci_fix_max INTEGER,
  updated_at INTEGER NOT NULL
);
```

- This is a side table, as pr_merge_result is. An ALTER of task_part would make the migration check every child table (spec.md section 6.18.6).
- task_step keeps its kinds. A session run uses implement, fix, instruct, or resolve. The critic uses review with item critic. So the step kind CHECK (037_task_update.sql:7) needs no rebuild.
- These changes are new zod defaults and need no SQL:
  - StepDetail.session `{id, resumed, why}`;
  - implementResult ticked, points, and ci;
  - replyDraft group;
  - the reason kinds usage and held (shared/task.ts:363). blocked_json has no SQL check (033_task.sql:21).

### 5.4 Tasks in flight

- A building part with no session row starts a fresh session at its next run. The keep-work rule of WP-R1b decides what continue.md holds.
- Tasks that the old loop ticked and committed stay ticked. The build run gets only the open tasks.
- A part that waits on a removed reason (budget, size, or push): Continue clears the reason and resumes.
- A part that is ready or has a PR: its first follow-up starts a fresh session.
- Old step rows keep their kinds and show in the Log as before.
- An old medium task that already has a spec PR keeps the old flow. Section 2.19 applies to new plans only.

### 5.5 What survives of the earlier plans

| Package | Form now |
|---|---|
| build-redesign R1c (one Continue) | PS5, with fewer reason kinds |
| R2 (automatic continuation) | One resume at the turn cap or the process cap (PS3) |
| R3 (merge the routes) | PS5 |
| R4 (docs) | PS8 |
| R5 (size note) | PS3 |
| R6 (git snapshot across a restart) | PS1. This reverses user answer Q4 (question Q3). |
| R7 (session resume) | Replaced by this design |
| agent-workflow AW0 (Gate B35 and B36 script) | Stays. B37 joins the same script. |
| AW1 (agent file library) | Stays as it is |
| AW2 (lead steps) | The lead is the main thread of the part session. The workflow goes to session runs, not to each step. workflow.steps becomes one switch. |
| AW3 (workflow UI) | Stays, without the steps tick list |
| AW4 (project agents) | Stays as it is |
| AW5 (docs) | PS8 |
| pushback WP-PB1 | PS4: the points field and the push-back questions in session runs |
| WP-PB2 | PS6: the plan in the PR runs of task PRs |
| WP-PB3 | PS5 and PS6 |

## 6. Work packages

Run one implementer at a time per worktree.

| WP | Tier | Scope | Depends on |
|---|---|---|---|
| PS0 Gate B37 and CI12 (code complete) | implementer-xhigh | scripts/gate/claude-checks.ts (B37), scripts/gate/ci.ts (CI12), tests/gate/ci.test.ts, integration-check.md rows U97 to U111 and CI12, docs/gate-v2.md | none |
| (user) Run B37 and CI12 | user | real CLI, real Jenkins | PS0 |
| PS1 Partial undo and the git snapshot on disk | implementer-xhigh | implement.ts (undoStep, undoTrees, after, finish), worktree.ts (a path restore helper), gitstate.ts (write and read the snapshot file), tasks.ts (recoverTasks), tests | none |
| PS2 Runner sessions | implementer-xhigh | claude.ts (ImplementSpec resume and keep, the keep step before removeCwdFolders, the stall and loop guard, stream-json input behind a flag), stream.ts (usage per message, resetsAt, the loop count), run-log.ts, jobs.ts (implementSteps passes the session and returns the kept file; cancel by part), tests/support/fake-claude.ts (transcripts, resume, stream input), tests | PS0. The resume path stays off until its facts pass. |
| PS3 Part session loop | implementer-xhigh | migration 052, db.ts, loop.ts (runPart, the session lifecycle, the guard, the tick check, the final checks gate, the fix loop, the commits, the size note, the own review hook, transcript deletion at the PR end), context-files.ts (continue.md, continue-diff.md, baseline.md), implement.ts (implementPrompt build lines, the digest, the scratch skip), shared/task.ts (schemas and settings), tasks.ts (the sweep and old tasks), tests | PS1, PS2 |
| PS4 Follow-up runs | implementer-xhigh | loop.ts (the critic, review points with points and push-back questions, Fix these too, message runs, live messages, the update resolve in the session, Hold, Skip, Start again, the usage reason and its timer), jobs.ts (critic mode), validate.ts (the added-line rule), routes.ts, tests | PS3 |
| PS5 Task view | implementer | web/tasks (model.ts, TaskView.tsx, the message box, Plan tab ticks, Log grouping, push-back cards), settings/RunLimits.tsx, tests/web, tests/e2e/task-small.e2e.ts, new task-session.e2e.ts, screenshots, README | PS4 |
| PS6 PR comments | implementer-xhigh | shared/review.ts (group), jobs.ts (the plan in reply runs of task PRs), catalog.ts (reply lines), loop.ts (the comment run), publish (the push-and-post confirm), the clone Apply refusal on task branches, the review and task views, e2e | PS5 |
| PS7a Red build, paste | implementer | loop.ts (the CI run), shared/task.ts (the ci field), the web build row and its box, tests | PS6 |
| PS7b Jenkins log read and red-build fixes | implementer-xhigh | config.ts, settings.ts, src/server/ci/jenkins.ts, tests/support/fake-jenkins.ts, loop.ts (the mode), the push confirm, notify.ts, tests, e2e | PS7a, CI12, and approval of section 3 items 1, 6, 7, 8, and 14 |
| PS9 Spec size levels | implementer-xhigh | plan.ts (docNames, card and brief grammar), tasks.ts (the spec run prompt), machine.ts (medium path), pr.ts (prText), loop.ts (the card path), the plan screen, tests | PS5 |
| PS8 Docs | implementer | BRIEF.md (the approved wording), spec.md 6.1, 6.7, 6.12, 6.18, 6.21.7, 6.26, and a new 6.28, CLAUDE.md status line, docs/smoke-task.md part P, CHANGELOG.md | PS5; again after PS6, PS7b, and PS9 |

Parallel work: PS0 and PS1 touch different files, so they can run in two worktrees at once. Every package from PS2 on touches loop.ts, jobs.ts, or the task views, so those run in one worktree, in order.

Tests per package:

- **PS1:**
  - A denied tracked file restores only that file, and an edit of another file stays.
  - A new denied file goes alone.
  - An ignored-file problem deletes only those files and the setup mark.
  - A locked repository resets only its own tree.
  - A problem that is left after the undo takes the full reset.
  - The patch holds only the problem paths.
  - After recoverTasks, a clean snapshot on disk keeps the work, and checked stays.
  - A changed ref after a restart blocks.
  - Control mutation: make the undo reset everything. The "other file stays" test must turn red.
- **PS2** (tests/review/runner.test.ts):
  - The argv of a session run has no `--no-session-persistence`, and a resume has `--resume` and `--fork-session`.
  - The keep step moves the fake transcript before the folder delete. A cancel still keeps it.
  - The stall timer kills a silent fake run, and leaves an open Bash call alone until its limit.
  - The loop guard warns at 3 and kills at 5.
  - resetsAt and the usage of each message parse.
  - Stream input writes the second message.
  - The init check still kills a resumed run that has an extra tool.
- **PS3** (new tests/tasks/session.test.ts, and loop.test.ts):
  - One build run with ticks gives one commit after green checks.
  - Red checks resume the session with failure.md, at most "Test-fix tries" times.
  - A plan change other than a tick blocks with spec_change. A tick of an unknown ID blocks too.
  - The guard resumes on equal heads.
  - The guard starts fresh in each of these cases: a moved head, a hash mismatch, a size over the cap, an unknown size, and after a denied path.
  - A failed resume starts fresh once.
  - The turn cap continues once.
  - The transcript goes at merge, decline, skip, start again, and close.
  - An old task with ticked tasks builds only the open tasks.
  - Migration 052 keeps the rows (tests/storage/db.test.ts).
- **PS4:**
  - The critic keeps only added-line points.
  - Review points give push-back questions.
  - "Fix these too" resumes the session.
  - A message during a run reaches stdin.
  - Hold cancels only one part.
  - "Start this part again" saves the backup ref, and is refused after a push.
  - The usage reason arms the resume and fires once.
  - A resolve resumes only when the guard held.
- **PS5:**
  - Each row of section 2.17 in tests/web/tasks-model.test.ts, with at most one primary button.
  - e2e of build, Hold, Continue, and the usage limit.
  - Screenshots checked for real names.
- **PS6:**
  - group parses and defaults to null.
  - The reply run of a task PR holds the plan.
  - The comment run writes comments.md and returns points.
  - Fixed-in drafts.
  - The confirm pushes, then posts. A Fixed-in reply never posts before its push.
  - The PR-view Fix on a task PR opens the task flow. The clone Apply refuses a task branch.
  - No request goes to the fake Bitbucket before the click.
- **PS7a:** the quote check of ci; cause infra gives no commit; cause code gives a commit and the push row.
- **PS7b:**
  - whoAmI 401 and 403 give their own texts.
  - The log read refuses another origin and a redirect.
  - The token never reaches the disk or a prompt.
  - The mode pushes at most N times, each with the lease and the fast-forward check, and ends on each end rule. BUILD_WAIT ends it.
  - One notification per push.
- **PS9:**
  - A small task commits no card, and its PR description is the card.
  - A medium task has one brief and no spec PR.
  - A large task keeps the spec PR.
  - Old medium tasks keep their flow.
- **PS8:** no real names, sentences of 20 words or fewer, and no hard wraps.

## 7. Invariants and risks

Invariants:

- after() runs for every run end, also for a cancel (jobs.ts:1546).
- The path check and the git snapshot read files and git state, not the stream (implement.ts:137-192; gitstate.ts:52-159).
- A fork leaves its original transcript unchanged (U47).
- The init check runs for each process, so it runs for each resume too (stream.ts:221-226; claude.ts:642-646).
- `--tools`, `--restricted`, and `--strict-mcp-config` apply on a resume (U48; read tools only so far).
- A commit follows green app checks (loop.ts:1252-1284, then :1209).
- Every push goes through pushTaskBranch, with an explicit lease and no `+` (push.ts:51-70; spec.md section 6.8).
- The commit takes a new file only when a Write or an Edit named it (spec.md section 6.7).
- One process is one slot (jobs.ts:2464-2499).

Risks:

- The resume limits are not verified. Gate B37 comes first, and fresh sessions are the base path.
- Cost: a long session costs more per run. The context cap and fresh sessions limit it. U107 measures the cache use.
- Slot time: one run holds a slot for a whole part. Reviews wait longer, or get 409. The user can raise "Runs at once".
- The context can go stale after a head move of the app. The guard then starts fresh.
- A prompt injection can live in a transcript. The fresh session after a denied path or a git state change, and the hash check, limit this risk.
- A Bash command in Unrestricted mode can write the live transcript during its run. This falls under the known limit of BRIEF.md:162.
- Compaction can drop the rules. The digest repeats them in each run.
- A whole part waits for one commit. The git snapshot on disk keeps the work over a restart.
- On Linux, the CLI runs in its own process group (claude.ts:626), so it can outlive an app crash. The marker scan at the next start must end it before the recovery. Not verified.
- Red-build pushes go out without the user's look. The consent is bounded, the lease rules stay, and each push gives a notification.

## 8. Open questions

1. **Q1.** After a clean update from the base branch, should the next run resume with a note or start fresh? Recommended: start fresh, so the guard stays one rule.
2. **Q2.** What is the default "Session context cap"? Recommended: 100,000 tokens, until U105 and smoke part P give real sizes.
3. **Q3.** The git snapshot on disk reverses build-redesign.md Q4 ("reset with continue.md"). Accept that? Recommended: yes. A restart now costs a whole part, not one step.
4. **Q4.** After a git state change, keep the files that pass the path check? Recommended: yes. The git restore and fix F cover the git threat, and the path check covers the files.
5. **Q5.** One commit per green gate, or one per ticked task? Recommended: one per gate, with the ticked IDs in the body. One commit per task needs checks for each task.
6. **Q6.** Drop the tests-first block (AC-B10)? Recommended: yes. The prompt asks for tests first, and the ready screen notes a part with no test file.
7. **Q7.** Should a critic push-back give a question or a Log line? Recommended: a Log line. The critic is cheap and is not the reviewer.
8. **Q8.** Should Hold replace "Pause after this step" and "Pause after each task"? Recommended: yes. One long run has no step boundary.
9. **Q9.** Does medium lose its spec PR? Recommended: yes. Section 7 item 4 gives the spec PR to large only. Colleagues read the brief in the code PR.
