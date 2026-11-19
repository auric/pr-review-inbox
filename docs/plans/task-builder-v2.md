# Build a Jira task, version 2

Status: design of 2026-11-19 against main 4324ab7 plus branch `sa` (SA-1 and SA-2 committed, SA-3 running). Nothing is built. Section 13 holds wording for approval. The decisions of section 15 wait for the user. The machine tables of section 11 start from the `sa` machine (guards `noSpecPr` and `specPr`).

## 0. Summary

- Verdict: no task reached a push because of four faults before the push. Plans gave Claude impossible work. Prompts did not state Claude's real tools. The build gate waited for that work. Checks that cannot run on this computer started fix runs. The push, PR, and stack code is unproven, not broken. This design does not redesign it.
- Keep: part sessions (part-session.md), the self-approved stacks (self-approved-plans.md), submodule PRs, "Point at merged commit", the push guard, the git state check, the path check, and the app-owned worktree.
- Change: a capability manifest in every prompt, plan steps with typed owners, a checklist for app and user steps, checks validated against this computer, one typed ask model, answers per Jira key, files that Claude leaves for the user, and smaller explicit machines.
- Order: make one real task reach an open PR first (Gate U1). Asks, machines, spec PR, CI, and remote hosts come after it.

## 1. Evidence and root causes

Audit of the user's real use (2026-11-19): 7 tasks, 70 Claude runs, about $71, no push, no PR. No part passed implementing. Six "done" tasks were a Close in the middle of the flow.

| Evidence | Root cause | Code fact | Fix |
|---|---|---|---|
| 13 asks were impossible in the sandbox: verify on a remote Mac, CI runs, create a CI job, submodule merge and gitlink bump, tracker comment | The planner does not know what a build run can do or what the app does | specRules never name the limits (catalog.ts:1110-1157). Line 1120 asks only for criteria "that a test can prove". The spec run has no Bash, so it cannot learn the limits itself (loop.ts:705) | Section 4, section 5 |
| Plans held external tasks with no mark (5 of 21 in one plan; every task in two plans needed the remote Mac) | Plan tasks have no owner | specPart.tasks has id, title, files, run, done only (shared/task.ts:849-863) | Section 5 |
| A part never leaves implementing while a task stays unticked | The gate counts every unticked task | buildRun blocks when `openTasks(c).length` (loop.ts:2423-2428, :1078) | Section 5.4 |
| Task 6 asked for ssh before any mode was on | An allowlist with no pattern gives no Bash, and the prompt says "You cannot run commands" | shellOf returns null (loop.ts:1308); role line (implement.ts:672) | Section 4 |
| Task 7 ran in Unrestricted, with Bash, and still asked | The plan's Done-when lines needed Jenkins, Jira, a merge, a gitlink bump, a signing key, and the notary. One run claimed "no SSH" without a try | The Unrestricted lines (implement.ts:692-697) do not say that ssh, scp, and curl work with the user's keys. They have no "try first" rule and no CI line | Section 4 |
| Submodule repositories kept their own mode, but the run ignored it | One mode per run, from the main repository | shellOf reads `c.t.project, c.t.repo` only (loop.ts:1298) | Section 4, D5 |
| A Linux command failed on Windows in 10 of 10 check rounds | Nothing checks a command against this computer before the build. Each red round starts a fix run | program() finds "Not found" only at run time (checks.ts:47-62). The fix prompt lets Claude report an env fault only after a run (implement.ts:631) | Section 6 |
| Tests ran before the build. A failed build did not skip the tests. Saved commands only grow | List order is history. There is no skip and no unique name rule | runChecks (checks.ts:216-241); check-order.md section 1 | Section 6 |
| About 19 asks were app noise: setup failures, time limits, the tool cap | App faults go to the user as "Needs you" | REASON_EXITS (shared/task.ts:466-532) | Section 7 |
| 24 fixed and about 35 templated Needs-you titles; 56 action labels; titles come from the kind, not the cause | Two dimensions (17 kinds × 23 causes), and the "unfinished" text is Claude's raw summary | BLOCKED_KINDS, BLOCKED_CAUSES (shared/task.ts:383-430); loop.ts:2427 | Section 7 |
| 6 questions were asked again for the same Jira task. One key got two tasks | Answers belong to one task ID | stepAnswers reads by task ID (tasks.ts:1571-1576). create reuses only an open task (tasks.ts:1976-1978) | Section 7.5 |
| 25 of 39 answers took the recommended option | Claude asks what it could decide | The prompt line "When you need a decision from the user, set question and stop" (implement.ts:764) | Section 7.3 |
| A file that Claude left for the user was lost | The scratch folder is deleted at each step start | implement.ts:1229-1231 | Section 7.6 |
| No path ships the done part | The gate needs every task ticked | loop.ts:2423 | Section 5.4 |
| 9 task states, 9 part states, 12 phases, 19 step kinds; three build loops in 25 days (75 commits) | States hold facts that rows already give | part-session.md 9.1.6 G1, G2, G12; gates.ts:94-100 | Section 11 |
| The remote Mac has no model | Host and target platform are not data | remote-skill.md, Facts | Section 10 |

A colleague's app gives unrestricted Bash, local git with push denied, a push and PR after each run, and Jenkins read plus up to 3 rebuilds per run. This design takes the PR after the run (D1, opt-in) and the rebuild (D3, gated). It does not take local git (D7): no ask needed git, the read-only git MCP exists (BRIEF 3.5), and the tar copy works (implement.ts:703).

## 2. Principles

1. Claude plans only what it can do in its sandbox. Every other step gets an owner, the app or the user, and goes to a checklist.
2. The app tells Claude the truth about its tools in every run. The words come from the same data that builds the sandbox.
3. Ship what is done. A Claude part never waits for work outside Claude.
4. The app judges facts, and Claude judges code. A fault of the computer never costs a fix run.
5. Ask only real decisions. Claude records the rest as assumptions, and the user can change them.
6. One model for every wait: a typed ask with a fixed title and typed options.
7. Remember answers per Jira key.
8. Few stored states. Derive the rest from rows (part-session.md 9.2, R1 to R5).
9. Keep the hard rules. Change one only through an explicit, recorded grant (section 13).
10. Nothing that Claude made for the user is lost.
11. Prove the push path on one real task before more features.

## 3. The flow

| Step | User sees | App does | Claude does |
|---|---|---|---|
| 1. Build ABC-123 | The form with the key, the repository, and "Earlier work on ABC-123" when a task existed | Reads Jira. Reopens the open task for the key. Loads earlier answers for the key | Nothing |
| 2. Plan | Asks that are real decisions; assumptions with "Change"; the plan with an owner on each step, "What Claude can do here", and the checks marked "Runs here" or "Not found on this computer" | Builds the manifest. Runs the interview and spec runs. Checks the plan (checkPlan plus section 5.3) | Reads the task and the code, asks, assumes, and writes the plan |
| 3. Approve | Size; "I approve it myself" or "Colleagues review the plan and design in a spec PR" (medium and large); the PR tick (D1); the shell mode when it gives no Bash | Writes the parts, the checklist rows, and the commands in one transaction. With the spec PR, it commits the plan files, pushes, and opens the spec PR on the same click | Nothing |
| 4. Build | One row per part, the checklist, and an ask card only for a real decision | Setup, baseline, checks in kind order, own review, commit. Turns an env failure into an ask. Moves tasks Claude cannot do to the checklist | Builds the Claude tasks, runs commands as the manifest allows, ticks the tasks |
| 5. PRs | "Open N PRs", or nothing under the D1 grant; CI state per PR | Push with an explicit lease; PRs with submodules first; stacks; CI read; red-build fixes within the budget; "Point at merged commit" | Fixes red builds and PR comments in the part session |
| 6. Review | Comment groups, update offers | Sync; gate from reviewers and builds; update from the base | Works on the comments |
| 7. End | "Done", or "Abandoned" after "Abandon" | FINISHED when all parts are merged or dropped and the checklist is done or waived. ABANDON from any state that is not final | Nothing |

## 4. Capability manifest

### 4.1 Source and place

- New module `src/server/tasks/capabilities.ts`. `capabilities(db, task, runKind)` returns a plain object. `capabilityLines(m)` turns it into prompt lines.
- It reads the same inputs as shellOf (loop.ts:1296-1310) and shellSettings (shell.ts:148-181): the mode, the rules, the checks, the hosts of the deny list, and the lifted network programs. A test builds both and compares them.
- The lines go into the prompt (stdin), not into a context file. The prompt calls every context file untrusted data (implement.ts:657-659), and the manifest is app text.
- The interview and spec runs get the manifest of the build runs of the task, under "The build runs of this task have these tools". They keep no Bash (BRIEF 3.5:157).
- The plan screen shows the same lines under "What Claude can do in this task".

### 4.2 Content

| Block | Lines |
|---|---|
| Mode | "Commands: Unrestricted (main repository <project>/<repo>). It applies to every repository of the task." With an empty allowlist: "Claude cannot run commands in this task. Pick a mode in Settings > Tasks." |
| Runs | Unrestricted: "You can run any command as the user, with the user's files, ssh keys, and ssh config. ssh, scp, and curl work." Most commands: the denied programs by name. Allowlist: the patterns |
| Refused in every mode | "git, and any command that names the Bitbucket or Jira host. You have no CI token and no Jira or Bitbucket access." |
| Files | "Edit and Write work only in the part folder: ./repo, ./repos, and ./out. Read works only in the part folder." (BRIEF 3.5:147, `--restricted`) |
| Hosts | Each configured host that the mode lets ssh reach (lifted, shell.ts:139-143): name, ssh alias, platform, work folder. The alias is exact, so the plan and the skill name the same host |
| The app does, on a click or a grant | Commit after its checks; push; open PRs, submodule PRs first, with the parent pointing at the submodule branch commit; "Point <repo> at the merged commit" after a person merges; "Update from <base>"; "Move in Jira"; read CI results and logs (when connected); rebuild (D3); remote checks (D4) |
| Only the user does | Merge and approve PRs; Jira comments and fields; secrets, signing keys, and notary access; create or change CI jobs; host actions that need a person, such as a keychain prompt |
| Rules | "Try a command before you say that you cannot run it. Quote the refusal when it comes." "Put a step that needs the app or the user in external, not in tasks." "A Done-when line names an approved command or a test file that your run can execute." |

### 4.3 Prompt changes

- specRules (catalog.ts:1110): add the manifest, the owner rules of section 5, and the proof rule. Replace line 1120 with "Give each task a proof: an approved command or a test file." Replace line 1134 with the size lines of section 8.
- implementPrompt (implement.ts:599): the role lines of 670-672 and the shell lines of 681-706 come from capabilityLines. Keep the Edit-and-Write rule, the tar copy rule, and the time-limit rule.
- The interview rules get the manifest and the rule "Do not ask what ./context/answers.md answers."
- The separate investigation of "Unrestricted still asks" fits here. Its facts become manifest lines and tests.

## 5. Plan model

### 5.1 Schema (src/shared/task.ts)

- `specPart.tasks[]` gains:
  - `proof: { command: exact name | "", test: exact path | "" }`, with at least one of them set;
  - `where: "local" | <host name>`, default "local".
- `specResult` gains `external: [{ id: "E<n>", kind, title ≤200, after: part n | null, host: name | "", why ≤300 }]`, at most 20.
- `EXTERNAL_KINDS` and their owner:

| Kind | Owner | App action |
|---|---|---|
| submodule_pointer | app | "Point <repo> at the merged commit" (pointer.ts) |
| jira_move | app | "Move in Jira" (one POST after a confirm) |
| ci_rebuild | app with D3, else user | Rebuild (section 9) |
| remote_check | app with D4, else user | Remote check (section 10) |
| merge, approve, tracker_comment, secret, ci_job, manual_verify, other | user | A tick |

- The owner follows from the kind. The app computes it in toPlan (plan.ts:155), so a kind and an owner never disagree.
- `implementResult` gains `outside: [{ task: id, kind, why ≤300, blocking: boolean }]`, at most 10.

### 5.2 Storage

- New table `task_external(id, task, part NULL, ord, kind, title, why, host, state CHECK (state IN ('open','done','waived')), by TEXT, at INTEGER, created_at)`. It gets the next free migration number. 055 is reserved for PS7b-A, and 056 is used.
- The approval writes one row per external entry, in the same transaction as the part rows.
- plan.md and tasks.md render "## Outside Claude" with owner chips. The committed plan file shows the list to colleagues.

### 5.3 App checks (plan.ts checkPlan, deterministic)

- `proof.command` must equal the name of a testing command or of a saved command. Else major: "T2.1 names the command X, which the plan does not list."
- `proof.test` must be a path in the task files or a file at the base. Else major.
- A task with no files needs `where` set to a host or `proof.command` set. Else major: "T3.2 changes no file. Move it to external."
- `where` must name a host that the manifest lists. Else major.
- `external.after` must name a part. `host` must name a host or be empty.

### 5.4 Build gate and shipping the done part

- openTasks counts only part tasks (loop.ts:1078). External rows are outside the plan file, so the gate never waits for them.
- A Claude result with `outside` entries: the app changes `### [ ] <id>` to `### [-] <id>` in the plan file, in the next app commit. It adds a task_external row per entry and goes on to the gate. tickTask and the plan parser treat `[-]` as closed. No ask comes unless an entry has `blocking: true` (cause `outside`, section 7). This is D10.
- An unfinished run with no ask and no outside entry continues once by itself, as build-redesign.md does for a cut run. Then cause `cut`.
- The FINISHED guard of the task reads the external rows (section 11.1).

## 6. Checks

### 6.1 At the approval

- For each ticked local command, the approval runs program(argv[0]) with checkEnv (checks.ts:29-62). It executes no command. "Not found" or a refused `.cmd` gives 400: "<name> is not found on this computer. Untick it, or run it on a host."
- The plan screen shows "Runs here" or "Not found on this computer" per row before the click.
- Two commands with the same name give 400 (check-order.md fix 3). An argv item `<...>` gives a warning (check-order.md item 5).
- The spec run gets `context/commands.md` with the saved list and returns `testing.keep` (the IDs of saved commands that it keeps). A saved command that Claude did not keep shows unticked: "Claude did not use this command."

### 6.2 Run order and skip

- runChecks runs by kind: setup, build, test, lint. It keeps the list order inside each kind. This changes the run rule of spec.md section 6.3 (D9).
- After a build row exits non-zero or does not run, each later test and lint row gets notRun "Skipped: build <name> failed". A skipped row is red (check-order.md fix 2).
- onBase matches by command ID, not by name (check-order.md fix 3).

### 6.3 Env failure or code failure (app facts only)

| Fact | Class | App action |
|---|---|---|
| notRun: "Not found", "Refused", "Did not start" | env | Ask `check_env`. No fix run |
| Skipped after a failed build | follows the build | none of its own |
| Red on the part base with the same argv (onBase) | earlier failure | Ask `check_base`, once per command per task |
| timedOut on the base too | env (time) | Ask `check_env` with "Change the time limit" |
| exit not 0, green or absent on the base; or timedOut, green on the base | code | Fix run, up to "Test-fix tries" |
| A fix run returns `checkCause: { cause: "env", quote }`, and the quote is in the output | env | Ask `check_env`. The tries stop |

- `implementResult.checkCause` takes the form of `ci` (shared/task.ts:1027-1030). The quote check is the substring check of PS7a after CRLF-to-LF and an ANSI strip. No output regex classifies a failure (check-order.md item 5).

### 6.4 Remote checks

- A command can name a host (section 10, D4). Its approval check is "Test the host", not program().

## 7. Asks

### 7.1 Storage

- task_question gains columns with ALTER TABLE ADD COLUMN, as 042 did: `cause TEXT`, `state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','assumed','answered','overridden','withdrawn'))`, `part INTEGER`, `blocking INTEGER NOT NULL DEFAULT 1`, `payload_json TEXT`. App asks use source 'loop', so the source CHECK stays.
- The first open blocking ask of the task replaces task.blocked_json. Open asks of a part replace task_part.blocked_json. Several open asks keep the queue of spec.md 6.25.
- payload_json holds resumeAt and armed (usage), the step, the commands (allow), and the base (base).

### 7.2 Causes

Each cause has one fixed title and one primary option (the AC-B253 rule). Claude's text shows under "Claude says" as a quote. Stop and Abandon live in the task header, not in each ask.

| Cause | Replaces | Title | Primary | Other options |
|---|---|---|---|---|
| decision | question/claude, interview questions | Claude needs your decision | The recommended option | Other options; "Use all recommended" |
| plan_change | spec_change | Claude wants to change the plan | Accept the change | Reject the change |
| outside | new | Claude cannot do a task in its sandbox | Move it to your checklist | Tell Claude how; Drop the task |
| allow | allow | Claude asks to run a command | Allow once | Allow for this repository; Refuse |
| check_env | new | A check cannot run on this computer | Run the checks again | Drop it for this task; Run it on <host>; Edit the command; Change the time limit |
| check_base | question/red_before | A check fails on the base branch too | Go on without it | Let Claude fix it too |
| check_red | red/checks, question/no_change | The checks stay red | Give Claude more tries | Tell Claude; Start this part again |
| setup | red/setup, red/setup_time | The setup commands failed | Run setup again | Change the time limit; Edit the commands |
| review | blocker | Claude's review found points it could not fix | One more round | Go on without these fixes |
| unsafe | denied_path/path, git_state, commit | The app undid a change that it does not allow | Continue | Start this part again |
| cut | stuck/*, unfinished, error/run, legacy kinds | Claude stopped before the part was done | Continue | Start this part again |
| usage | usage | The usage limit is reached | Resume at <time> | Resume now |
| stopped | the stopped state | You stopped the task | Continue | none |
| restart | error/restart | The app restarted during the work | Continue | Start this part again |
| held | held | You put this part on hold | Continue this part | Skip this part; Start this part again |
| base | preflight, error/lower_repo | The branch base needs you | Try again | Pick a base branch; Wait for the merge |
| update | update, red/update, a stale lease | The update from the base stopped | Continue | Undo the update; Tell Claude |
| declined | new (DECLINED) | A colleague declined the PR | Open the PR again | Drop this part |
| cost | budget/cost | The part reached its cost limit | Raise the limit | none |
| app_error | error/app | The app hit an error | Try again | none |

- `slot` stops being a reason. "Waiting for a free run slot" is a derived status (R4).
- Option effects are an enum in `ASK_EFFECTS`. One route, `POST /api/tasks/:id/asks/:ask {version, option, text?}`, runs the effect after the commit. The routes /answers, /resume, /spec-change/:step, and /allow go away in TB-5.

### 7.3 Claude decides, and records assumptions

- Result fields of interview, spec, and implement:
  - `asks: [{ decision ≤300, why ≤300, options: [{ label ≤120, effect ≤300 }] 2..5, recommended, blocking }]`, at most 3;
  - `assumptions: [{ text ≤300, instead ≤300 }]`, at most 10.
- The app maps an old `question` to one blocking ask, so the fake CLI fixtures keep working.
- Prompt lines: "Decide a detail yourself when the code, the plan, or the answers settle it, or when a later change is cheap. Write it in assumptions. Ask only when the choice changes behavior that users see, a contract, data, or the scope." This is a rule for Claude. The app adds no rule of its own.
- An assumption is an ask in state `assumed`. "Change" opens its options. Override queues one instruct run with the picked option.

### 7.4 Titles and text

- Titles, status lines, and action labels come from ASK_CAUSES and ASK_EFFECTS only. They replace NEEDS and CAUSE_NEEDS (task-status.ts:57-86), REASON_EXITS (shared/task.ts:466-532), and the per-reason ActionKind rows of web/tasks/model.ts.

### 7.5 Answers per Jira key

- The answer query reads answered and overridden asks of every task with the same project, repository, and key.
- answers.md gets "Earlier answers for ABC-123".
- The interview and spec prompts say: "Do not ask what answers.md answers. When the task text now says otherwise, follow the task and say so in assumptions."
- The Build form shows "Earlier work on ABC-123: abandoned on <date>. Its answers carry over."

### 7.6 Files for the user

- Each run gets `./out/`. The prompt says: "Put a file for the user in ./out/. The app keeps it."
- At each run end, the app copies regular files only into `<task dir>/files/claude/<run>/`. It checks each file and folder with lstat and copies no link.
- Caps: 20 files per run and 10 MB per file. The Task view lists them, and Download uses the attachment headers of BRIEF 3.6:183.
- `scratch` stays a per-run working folder.

## 8. Sizes and reviews

| Size | I approve it myself | Colleagues review the plan and design |
|---|---|---|
| small | 1 PR: plan.md and code | not offered (the plan is in the one PR) |
| medium | 1 PR: plan files and code (SA-1) | Spec PR, then 1 code PR on top (D2) |
| large | Stacked part PRs (SA-2, SA-3) | Spec PR, then stacked part PRs on top |

- The spec PR is a part. Kind `spec` exists (PART_KINDS, shared/task.ts:44), and the branch is `<prefix><KEY>-spec` (branchName, shared/task.ts:315).
- The approval click with `planReview: "spec-pr"` writes the spec part. After the commit, the same request commits the plan files with an app commit, pushes with pushTaskBranch, and opens the spec PR. The click is the user's action.
- Code parts have `after` = the spec part and start mode `stack`. The scheduler starts them when the spec part gate passes (startOf, schedule.ts:39). "Start now" is the override.
- Comments on the spec PR go to one plan-edit run on the spec part: instruct purpose comments, with the allow list `specs/<KEY>/**`. A code part that started earlier gets "Update from <spec branch>".
- When the spec PR merges, the stack moves as in spec.md 6.20.10.
- This replaces OPEN_SPEC_PR, SPEC_GATE_PASSED, OVERRIDE, START_BUILDING, spec_pr_open, and spec_approved. It takes over WP-B6 (without Fix on task branches) and WP-B7. WP-B8 is done by SA-2; its "replan after merges" is dropped. WP-B9 is done by SA-3.

## 9. CI and Jenkins

- Built: Layer A reads build status from Bitbucket. The Jenkins client sends GET only (BRIEF 3.6:172). CI12 passed. CI13 and CI14 are not run. Layer B is on hold.
- Manifest line: "Claude has no CI access. The app reads build results and logs and gives a failed log to Claude in a fix run."
- PS7a ("Let Claude fix the build" from a pasted log) and PS7b (the log read from Jenkins, and red-build fixes as a tick with a budget N per part, ciMachine) stay as ps6-ps7-plan.md designs them. They run in wave 3, after TB-6, because both change loop.ts.
- Rebuild (D3): the app reads the parameters of a failed build (`<build>/api/json`) and starts the same job with them (POST `buildWithParameters` with the crumb). It does this on a click, or inside the PS7b budget for cause `infra`.
- Rebuild prerequisites: token rights Job/Build (reopen ci-builds.md Q11), the job path facts CI7 to CI9, CI13, CI14, and a new probe CI15 (the rebuild POST returns 201 and a queue item).
- External kinds: ci_rebuild is owned by the app with D3, else by the user. ci_job is always the user's.

## 10. Remote hosts

- Settings > Tasks > "Build hosts": name, ssh alias, platform (macOS, Linux, Windows), and work folder. It is stored in config.json and holds no secret.
- "Test the host" runs the app command `ssh -o BatchMode=yes -o ConnectTimeout=10 <alias> true`.
- Repository setting "Builds on": "this computer" or a host. With a host, the plan screen offers "Run it on <host>" for each local check that is not found.
- The manifest lists a host only when the mode lets ssh run (lifted, shell.ts:139-143): Unrestricted, or a saved ssh pattern. The coordinator's investigation confirms that ssh in Unrestricted reaches the host with the real HOME and SSH_AUTH_SOCK (shellEnv strips only GIT_* and SSH_ASKPASS).
- A plan task with `where: <host>` is Claude work. Claude copies the tree with the tar recipe (implement.ts:703) and gives each remote command a time limit (implement.ts:702). The result is Claude's claim, shown with the commands from the Bash events.
- App-verified remote checks (D4):
  - A command with `host` runs as an app check.
  - The app pipes `tar -cf - -C repo .` into `ssh <alias> 'mkdir -p <dir> && tar -xf - -C <dir>'`, as two processes with no shell.
  - `<dir>` is `<work folder>/<KEY>-p<ord>-<head12>`.
  - Then the app runs `ssh -o BatchMode=yes <alias> 'cd <dir> && <argv quoted for POSIX sh>'`.
  - These rows use the real HOME (Isolate home off), so ssh finds its key (checks.ts:213; remote-skill.md).
- "Verify on host X" that needs a person is an external `manual_verify` row with `host`.

## 11. State machines

Rules: XState v5 as a pure function, as today (machine.ts:4-6). advance is the only writer of task.state and task_part.state. Each machine gets a table test, a reachability test, a no-dead-end test, a sender scan, and a Mermaid snapshot (AC-B252 pattern).

### 11.1 Task machine

Context: `sized` (size is not null), `finished` (every part is merged or abandoned, at least one part is merged, and every external row is done or waived), `nothingBuilds` (no part is planned, implementing, or self_reviewed).

| State | Event | Guard | Target | Sender | Side effects (owner) |
|---|---|---|---|---|---|
| (none) | BUILD | none | interview | route POST /tasks | interview run (tasks) |
| interview | ASKED | none | interview | tasks, interview finish | RAISE decision asks |
| interview | ANSWERED | none | spec_draft | route asks; tasks, interview done | spec run |
| spec_draft | APPROVE | sized | implementing | route plan | One transaction: settings, part rows (stack; spec part with spec-pr), external rows, commands. After the commit: spec PR (pr), loop.build |
| implementing | FINISHED | finished | done | sync (syncParts), route drop, route external | delete transcripts; end the CI mode |
| implementing | FINISH | nothingBuilds | done | route finish (confirm: "N PRs stay open. The app stops following them.") | closed_at; withdraw asks |
| interview, spec_draft, implementing | ABANDON | none | abandoned | route abandon (confirm) | cancel runs; abort checks; withdraw asks; closed_at; no Bitbucket or Jira call |
| done | none | none | final | none | none |
| abandoned | none | none | final | none | none |

- Removed states: spec_pr_open and spec_approved (section 8; G1 shows that no row reaches them). ready is derived from part states (gates.ts:94-100). failed has no sender (G2). stopped becomes the ask `stopped` (D8).
- Removed events: STOP, RESUME, FAIL, CLOSE, OPEN_SPEC_PR, SPEC_GATE_PASSED, OVERRIDE, START_BUILDING, PART_READY, LAST_PR_OPEN. ALL_MERGED becomes FINISHED.
- Stop: the route cancels runs, aborts checks, and RAISEs `stopped`. Continue runs the Continue rule of part-session.md 9.3.1 per building part. In interview and spec_draft, it runs the cut run again.
- A restart: recoverTasks RAISEs `restart` per cut part, and for a cut interview or spec run.

### 11.2 Part machine

Context: `unpushed` (task_part.pushed is NULL), `declined` (pull_request.state is DECLINED), `spec` (the part kind is spec).

| State | Event | Guard | Target | Sender | Side effects |
|---|---|---|---|---|---|
| planned | START | none | implementing | loop (startPart, ensureParts) | worktree; phase GO |
| planned | PR_OPENED | spec | pr_open | pr, after the spec PR create | follow the PR |
| planned | ADOPT_OPEN | none | pr_open | tasks, approval | follow the PR |
| planned | ADOPT_MERGED | none | merged | tasks, approval | none |
| planned | ABANDON | none | abandoned | route drop | FINISHED check |
| implementing | REVIEWED | none | self_reviewed | loop, when GO finds no work | base check; with the D1 grant: pr open |
| implementing | RESTART | unpushed | implementing | route restart | as part-session.md 9.3.2 |
| implementing | ABANDON | none | abandoned | route skip | save the patch; remove the worktree; FINISHED check |
| self_reviewed | PR_OPENED | none | pr_open | pr (click or D1 grant) | none |
| self_reviewed | RESTART | unpushed | implementing | route restart | as above |
| self_reviewed | ABANDON | none | abandoned | route skip | as above |
| pr_open | MERGED | none | merged | sync | delete the transcript; end the CI mode; FINISHED check |
| pr_open | ABANDON | declined | abandoned | route drop | withdraw the declined ask; FINISHED check |
| merged | none | none | final | none | none |
| abandoned | none | none | final | none | none |

- Removed states: changes_requested and approved. The gate comes from partGate (gates.ts:45-59) and the reviewers. declined comes from pull_request.state.
- Removed events: CHANGES_REQUESTED, GATE_PASSED, GATE_FAILED, DECLINED, REOPENED.
- The scheduler reads the gate from partGate and declined from the PR row (schedule.ts:28-40).
- Follow-ups on a built part (comments, red builds, messages, updates) are phases. They change no part state, as today.

### 11.3 Ask machine (task_question.state)

Context: `blocking`, `optionValid` (the option index exists in the cause or Claude options).

| State | Event | Guard | Target | Sender | Side effects |
|---|---|---|---|---|---|
| (none) | RAISE | blocking | open | tasks, loop, route stop, recover | the part or task waits |
| (none) | ASSUME | not blocking | assumed | loop (Claude assumptions) | none |
| open | ANSWER | optionValid | answered | route asks; timer (usage armed, primary only) | the option effect after the commit |
| open | WITHDRAW | none | withdrawn | tasks or loop: the cause cleared (the PR is open again, the part restarted or dropped, the task was abandoned, a newer ask of the same step) | none |
| assumed | CONFIRM | none | answered | route asks | none |
| assumed | OVERRIDE | optionValid | overridden | route asks | queue one instruct run with the picked option |
| assumed | WITHDRAW | none | withdrawn | part or task abandoned | none |
| answered, overridden, withdrawn | none | none | final | none | none |

### 11.4 Checklist item machine (task_external.state)

| State | Event | Guard | Target | Sender | Side effects |
|---|---|---|---|---|---|
| (none) | ADD | none | open | route plan; loop (outside); route move | none |
| open | DONE | none | done | route tick (owner user); app action success (owner app) | FINISHED check |
| open | WAIVE | none | waived | route waive | FINISHED check |
| done | REOPEN | none | open | route untick | none |
| waived | REOPEN | none | open | route untick | none |

No state is final. The task's FINISHED guard reads the states.

### 11.5 Phase machine and ciMachine

- The phase machine stays as in part-session.md 9.3.3, without `critic` and its guard if D6 holds. Phases are derived and never stored (R2).
- ciMachine stays as ps6-ps7-plan.md 2.2 designs it.

### 11.6 Migration

- R1 forbids new stored state values without a table rebuild (part-session.md 9.2). `abandoned` and the CHECK lists (033_task.sql:13, :107) need one.
- TB-6 rebuilds task and task_part once, with their column order and row IDs, in the pattern of 030 and 033. It uses the next free number at that time.

| Today | Target |
|---|---|
| task interview, spec_draft | the same |
| task spec_pr_open, spec_approved | spec_draft (no rows expected, G1) |
| task implementing, ready | implementing |
| task stopped | the mapping of stopped_from, plus an ask `stopped` |
| task done, closed_at NULL | done (closed_at is set only by close, tasks.ts:2814) |
| task done, closed_at set, every part merged or abandoned, at least one merged | done |
| task done, closed_at set, otherwise | abandoned (D11) |
| task failed | abandoned (no rows expected, G2) |
| part changes_requested, approved | pr_open |
| part declined, task live | pr_open, plus an ask `declined` |
| part declined, task final | abandoned |
| blocked_json of task and part | one ask row each, cause from the table of 7.2; slot gives nothing |
| task_step rows | kept. STEP_KINDS stays for reading. Writers stop using tests, replan, rebase, size, question, and spec_change |

- stopped_from stays as a column with no writer.

## 12. Delete and merge

| Place | Goes | Why |
|---|---|---|
| machine.ts | the removed events of 11.1 and 11.2; RESUMABLE; halt; the RESERVED entries for WP-B8 and FAIL | 11.1, 11.2 |
| shared/task.ts | BLOCKED_KINDS, BLOCKED_CAUSES, taskBlocked, REASON_EXITS (replaced by ASK_CAUSES, ASK_EFFECTS); the removed states in TASK_STATES and PART_STATES, stepStrip, and TASK_STATE_TEXT; `question` in implementResult after the compat mapping | 7, 11 |
| task-status.ts | NEEDS, CAUSE_NEEDS; the rowStatus branches for stopped, failed, ready | 7.4 |
| gates.ts | eventOf events except MERGED; the LAST_PR_OPEN branch of syncParts | 11.2 |
| schedule.ts | HAS_PR and OPEN read pr_open plus partGate | 11.2 |
| tasks.ts | the close and resume routes (become finish, abandon, and asks); holdBlocked, nextReason, parseBlocked (become ask queries); stopped_from in advance | 11 |
| loop.ts | block, reason, blockedOf (become raise); the Leave option of ready; the legacy question/paused branch (loop.ts:3872); criticRun, CRITIC_PROFILE, CRITIC_FAILED (D6) | 7, 11, D6 |
| routes.ts | /answers, /resume, /close, /spec-change/:step, /allow (become /asks/:ask, /finish, /abandon) | 7.2 |
| web/tasks/model.ts | the per-reason ActionKind rows and their texts | 7.4 |
| docs | PS9 card and brief grammar (dropped); WP-B6 Fix on task branches (dropped) | 8 |

## 13. Wording for approval

1. BRIEF 3.6:177 and the CLAUDE.md hard rule (D1). Add: "The plan approval can grant 'Open the PRs when they are ready'. Then the app pushes and opens each PR after the part passes its own review. Every push keeps the lease rules. Off by default."
2. BRIEF 3.6:172 (D3). Replace "The client sends GET only" with: "The client sends GET, plus one POST that starts a failed build again with its parameters, on a click or inside the red-build budget."
3. BRIEF 3.5:158 (D4). Add: "A remote check runs with the real HOME, so ssh finds its key."
4. BRIEF.md:87 and spec.md 6.1: the size table of section 8, with the review choice for medium and large (D2).
5. spec.md 6.3 run rule (D9): "The app runs the setup, build, test, and lint commands in that kind order. A failed build skips the later commands."
6. BRIEF 3.5:157: the interview and spec runs get the manifest of the build runs.
7. BRIEF 3.5:163 stays: "A run never gets the CI token or calls the CI server."

## 14. Invariants with evidence

1. advance is the only writer of the states. A refused event writes nothing (machine.ts:4-6; spec.md 6.2).
2. Every push uses pushTaskBranch with an explicit lease, a fast-forward check, and no `+` refspec (push.ts:51-116).
3. The git state check restores refs and config after each Claude step (BRIEF 3.5:156; git-deny.md fix F).
4. shellSettings builds shell.json (shell.ts:148-181). The manifest uses the same ShellSpec.
5. Only implement, fix, and instruct get Bash (loop.ts:705). interview, spec, replan, and resolve never do.
6. One mode per run, from the main repository (loop.ts:1296-1310).
7. The scratch folder is deleted at each step start (implement.ts:1229-1231).
8. The build gate counts unticked plan tasks (loop.ts:1078, :2423).
9. runChecks runs in list order and never skips (checks.ts:216-241). program() gives "Not found" (checks.ts:47-62).
10. CHECK constraints need a table rebuild (033_task.sql:13, :107; db.ts:143).
11. closed_at is set only by close (tasks.ts:2814). CLOSE works only in spec_pr_open, ready, stopped, and done (machine.ts:85-99).
12. The scheduler gate comes from partGate (schedule.ts:39; gates.ts:45-59).
13. Answers belong to one task ID (tasks.ts:1571-1576). create reuses only an open task (tasks.ts:1976-1978).
14. 055 is reserved for PS7b-A (ps6-ps7-plan.md 0). 056 is task_fetch.

## 15. Decisions

| ID | Question | Recommended |
|---|---|---|
| D1 | PR grant at the approval | Yes, as a tick. Off the first time, then the last pick per repository |
| D2 | Spec PR choice for medium too (reverses SA D1) | Yes |
| D3 | Jenkins rebuild POST | Yes, after CI7 to CI9, CI13, CI14, CI15 and a token with Job/Build |
| D4 | App-verified remote checks with the real HOME | Yes, wave 4 |
| D5 | Mode of a task with submodules | The main repository mode, stated in the manifest and in Settings |
| D6 | Drop the critic phase | Yes. The own review stays |
| D7 | Local git for Claude as a task opt-in | No |
| D8 | Stop as an ask; Close becomes Finish and Abandon | Yes |
| D9 | Kind order for checks | Yes |
| D10 | Outside tasks move to the checklist with no ask | Yes. `blocking` gives an ask |
| D11 | Closed tasks before all merges become abandoned | Yes |
| D12 | WP-PQ3 to PQ5 after Gate U2 | Yes |

## 16. Work packages

One implementer at a time. The packages share loop.ts, tasks.ts, and shared/task.ts, so they are not file-disjoint. Each ends green on `bun run check`. Web packages run `bun run test:e2e` on their own ports and print the `E2E code:` line. Web packages start after SA-3 lands.

| WP | Tier | Files | Tests | Acceptance | After | Takes over |
|---|---|---|---|---|---|---|
| TB-D0 Docs | implementer | spec.md new 6.32 (this design), tasks.md rows, CLAUDE.md status, docs/smoke-task.md part V | none | the docs match this file | SA-3 | none |
| TB-1 Manifest and prompts | implementer | src/server/tasks/capabilities.ts (new); catalog.ts (specRules, interview rules); implement.ts (role, shell lines); loop.ts (shellOf passes the manifest); tasks.ts (spec and interview runs get it); dto.ts (TaskDto.capabilities) | tests/tasks/capabilities.test.ts: per mode, the manifest matches shellSettings; an empty allowlist gives the no-commands line; hosts only when ssh is lifted; catalog snapshot | AC-TB1 to AC-TB3 | TB-D0 | PS9 prompt line (catalog.ts:1134) |
| TB-2 Plan owners and checklist | implementer-xhigh | shared/task.ts (proof, where, external, EXTERNAL_KINDS, outside); plan.ts (toPlan owner, checkPlan rules, plan.md "Outside Claude"); tasks.ts (approval writes rows; routes tick, waive, untick); loop.ts (outside handling, `[-]` marker in tickTask); migration task_external; catalog.ts lines | tests/tasks/plan.test.ts (each 5.3 rule); tests/tasks/external.test.ts (approval rows, outside moves the task, gate passes, the part reaches self_reviewed); control mutation: openTasks counts `[-]` | AC-TB4 to AC-TB7 | TB-1 | none |
| TB-3 Checks | implementer-xhigh | checks.ts (kind order, skip); loop.ts (env and code classes, check_env through the old blocked path until TB-5, onBase by ID); tasks.ts (approval program() check, unique names, commands.md, keep); shared/task.ts (checkCause, testing.keep); catalog.ts (check-order fix 4) | tests/tasks/checks.test.ts (check-order.md section 3); approval 400 for a missing program; an env failure starts no fix run; the checkCause quote check; control mutation: drop the skip | AC-TB8 to AC-TB10 | TB-2 | check-order.md |
| TB-4 Files from Claude | implementer | implement.ts (out folder, collect after the run with lstat and caps); tasks.ts (files list, download route); dto.ts | tests/tasks/out-files.test.ts (a file survives the next run; a link is skipped; the caps) | AC-TB11 | TB-3 | none |
| Gate U1 | user | docs/smoke-task.md part V: the user's real task with "I approve it myself" | record asks by cause, runs, and cost | an open PR; no impossible ask; no fix run for an env failure | TB-4 | UL-S steps |
| TB-5 Asks | implementer-xhigh | migration (ALTER task_question); shared/task.ts (ASK_CAUSES, ASK_EFFECTS, asks and assumptions results); loop.ts and tasks.ts (raise, answer, withdraw; blocked_json readers become ask queries); routes.ts (/asks/:ask); answers by key; implement.ts and catalog.ts (decide-yourself lines) | tests/tasks/asks.test.ts (each cause has one primary; each effect runs; reuse across tasks of one key; an assumption override queues one run); control mutation: the key query by task ID | AC-TB12 to AC-TB15 | Gate U1 | none |
| TB-6 Machines and migration | implementer-xhigh | machine.ts (11.1 to 11.4); migration (rebuild task and task_part, map rows); tasks.ts (advance, finish, abandon, Stop as an ask, recoverTasks); gates.ts; schedule.ts; loop.ts (critic removal if D6); README diagram | tests/tasks/machine.test.ts (tables, reachability, no dead end, senders, purity, Mermaid); tests/storage migration test with each mapping row; readme.test.ts | AC-TB16 to AC-TB18 | TB-5 | none |
| TB-7W Web | implementer | src/web/tasks (ask cards, checklist, owner chips, "What Claude can do", check markers, files, Finish, Abandon); task-status.ts; tests/web; tests/e2e/task-v2.e2e.ts; screenshots; README; CHANGELOG | model tests per cause; e2e: approve, an outside task moves, a PR opens on the fake server | AC-TB19 | TB-6 | none |
| Gate U2 | user | docs/smoke-task.md part V2 | asks by cause; reuse of an earlier answer | all pass | TB-7W | none |
| TB-8 Spec part | implementer-xhigh | tasks.ts (spec part at the approval); pr.ts (plan commit, push, PR on the click); loop.ts (plan-edit run from comments); schedule.ts (after the spec part) | tests/tasks/spec-part.test.ts (one push and one PR on the click; code parts wait; Start now; comment edit run touches only specs/; merge moves the stack); control mutation: count NEEDS_WORK as approval | AC-TB20, AC-TB21 | Gate U2 | WP-B6 |
| TB-8W Spec part web | implementer | PlanTab review choice for medium and large; spec part row; e2e | e2e spec PR flow | AC-TB22 | TB-8 | WP-B7 |
| TB-9 PR grant (D1) | implementer | tasks.ts (grant in settings); loop.ts (after REVIEWED, call the pr open path); PlanTab tick; notify.ts | push argv has the lease and no `+`; no push without the grant; control mutation: ignore the grant flag | AC-TB23 | TB-8W | none |
| PS7a-A, PS7a-B | as ps6-ps7-plan.md | as ps6-ps7-plan.md | as ps6-ps7-plan.md | AC-B400 to AC-B405 | TB-9 | kept |
| PS7b-0, P, A, B, C | as ps6-ps7-plan.md | as ps6-ps7-plan.md | as ps6-ps7-plan.md | AC-B406 to AC-B416 | PS7a-B | kept |
| TB-10 Rebuild (D3) | implementer-xhigh | src/server/ci/jenkins.ts (rebuild POST, crumb); loop.ts (infra cause inside the budget); scripts/gate/ci.ts (CI15); BRIEF and CLAUDE.md wording | tests/ci with the fake Jenkins: same parameters, one POST per click, budget cap, no other origin | AC-TB24 | PS7b-C and gates | Layer B (redesigned) |
| TB-11 Build hosts | implementer | config and Settings > Tasks hosts; "Test the host"; capabilities.ts hosts; plan `where` check | settings and manifest tests | AC-TB25 | TB-10 or after TB-9 | none |
| TB-12 Remote checks (D4) | implementer-xhigh | checks.ts (host rows: tar to ssh pipe, quoted remote command, real HOME); approval "Test the host" in place of program() | tests with a fake ssh program on PATH | AC-TB26 | TB-11 | none |
| TB-D1 Final docs | implementer | BRIEF (approved section 13), spec.md 6.1, 6.2, 6.3, 6.14, 6.25, 6.28, smoke files, integration-check rows, CHANGELOG | none | the docs match the code | TB-12 | PS8 |

Other packages:
- SA-3: kept, running now.
- WP-PQ3 to PQ5 and Gate UP: deferred (D12).
- WP-JC5: kept and independent. It edits task-file.ts, which no TB package touches.
- WP-B8: done by SA-2. WP-B9: done by SA-3. WP-B10 inbox rows: kept, after TB-7W.
- PS6-C: built (b1ba3b4).

### Acceptance criteria

1. AC-TB1. For each mode, the manifest lists exactly the programs that shell.json denies, plus git and the two hosts.
2. AC-TB2. An allowlist with no pattern gives the line "Claude cannot run commands in this task", in the plan screen and in each prompt.
3. AC-TB3. The spec and interview prompts hold the build manifest and the owner and proof rules. The Unrestricted lines name ssh, scp, and curl and the try-first rule.
4. AC-TB4. A plan task whose proof names an unknown command gives a major problem.
5. AC-TB5. External entries become task_external rows at the approval, with the owner from the kind.
6. AC-TB6. A Claude result with `outside` marks the task `[-]`, adds a row, and the part reaches self_reviewed.
7. AC-TB7. FINISHED waits while an external row is open.
8. AC-TB8. The approval refuses a ticked local command whose program is not found.
9. AC-TB9. A stored [test, build] list runs the build first. A failed build skips the test with "Skipped: build <name> failed".
10. AC-TB10. A notRun check raises check_env and starts no fix run. A fix run with checkCause env and a found quote stops the tries.
11. AC-TB11. A file in ./out survives the next run and shows in the Task view. A link is skipped.
12. AC-TB12. Every cause has one title and one primary option.
13. AC-TB13. An answer of an earlier task with the same key is in answers.md.
14. AC-TB14. A non-blocking Claude ask becomes an assumption. Its override queues one instruct run.
15. AC-TB15. The old routes are gone. /asks/:ask runs each effect.
16. AC-TB16. The machines follow the tables of 11.1 to 11.4. Each state is reachable, and only the final states have no exit.
17. AC-TB17. The migration maps each row of 11.6 and keeps the row IDs.
18. AC-TB18. Stop raises `stopped`. Continue resumes. ABANDON calls no Bitbucket or Jira route.
19. AC-TB19. The e2e test runs from a key to an open PR on the fake server, with one moved outside task.
20. AC-TB20. The spec-pr approval gives one push and one PR create on that click. The code parts wait for the spec gate.
21. AC-TB21. A comment run on the spec part changes only `specs/<KEY>/` files.
22. AC-TB22. The review choice shows for medium and large only.
23. AC-TB23. With the grant, a self_reviewed part opens its PR without a click. Without it, nothing pushes.
24. AC-TB24. A rebuild sends one POST with the parameters of the failed build to the configured origin only.
25. AC-TB25. A host shows in the manifest only when the mode lets ssh run.
26. AC-TB26. A remote check copies the tree with no shell and runs the quoted command with the real HOME.

## 17. Open questions (unverified)

1. The facts of the separate investigation (Unrestricted asks, task 6 and task 7) come from the coordinator. This design checked only loop.ts:705 and loop.ts:1296-1310.
2. Does the sync keep the pull_request row of a declined PR with state DECLINED? The derived `declined` guard needs it.
3. Does the fake CLI need new results for asks, assumptions, outside, and checkCause? The TB-2, TB-3, and TB-5 tests need them.
4. Does `--restricted` let a Bash `cd` leave the part folder in Unrestricted? The manifest claims that Bash reaches the whole disk, and that Read and Edit stay inside.
5. Does a medium plan with a spec PR conflict with any SA-3 web code? SA-3 is not inspected.
6. Is the next free migration number 057 when TB-2 lands?
7. Does the D1 grant need a PR text that the user edits? Today the PR dialog lets the user edit it.
