# Limits that a user can hit: inventory

Status: decisions 2 and 3 are built (2026-11-11). Decisions 1 and 4 are open. Inventory of 2026-11-03 against main 7c32f26, after the user said "we have too many unnecessary restrictions in the app". No decision yet. Categories: SAFETY stays; RESOURCE protects prompt size, memory, disk, or cost; ARBITRARY has no clear reason. The last column is a first guess, not a decision. Rows marked unverified were found only in schemas.

## Build a Jira task
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| Interview rounds = 2 | shared/task.ts:87 | No third round of questions | ARBITRARY | fixed | editable |
| Interview turns 30, spec/plan turns 80 | shared/task.ts:90-91 | Run stops at max turns (unverified) | RESOURCE (cost, low) | fixed | editable |
| Step time 20 min | shared/task.ts:138, tasks/implement.ts:446 | Step times out | RESOURCE | fixed | raise |
| Part time 120 min, "more time" +60 | shared/task.ts:147-149, tasks.ts:460 | Part pauses, "more time" button | RESOURCE (cost) | per task (+60 each click) | keep |
| Test-fix tries 3, review-fix tries 2 | tasks/loop.ts:153-154,815 | "Needs you: the tests of part N stay red after 3 tries." | RESOURCE | fixed | editable |
| Open PRs at once 1..5 (default 3) | shared/task.ts:162-163, web/tasks/PlanTab.tsx:374 | "Type a number from 1 to 5…" | ARBITRARY | per task | raise |
| Parts that build at once 1..3 (default 2) | shared/task.ts:166-167, PlanTab.tsx:380 | "Type a number from 1 to 3…" | RESOURCE (CPU/disk) | per task | keep |
| Sub-task parts max 12, sub-tasks read 20 | shared/task.ts:160-161, :589 | Plan schema rejects more than 12 parts | ARBITRARY | fixed | raise |
| Plan schema caps (8 questions, 15 steps, 20 criteria, 12 contracts, 8 risks…) | shared/task.ts:501-680 | AI output fails validation, so the run fails (unverified) | RESOURCE (prompt shape) | fixed | raise |
| Task doc 120,000, answer 100,000 chars | shared/dto.ts:1289-1290, web/tasks/Questions.tsx:105 | Textarea stops typing | RESOURCE (low risk) | fixed | keep |
| Commands 20, args 32, check timeout 1..14400 s (default 600, setup 3600) | dto.ts:1288, task.ts:330-337,133 | Validation error | ARBITRARY | per task (timeout) | keep |
| Reviewers 20 | dto.ts:1287 | Validation error | ARBITRARY | fixed | keep |
| Branch name 100, suffix -99 | task.ts:95,102 | Branch name refused | SAFETY-ish (git ref) | fixed | keep |
| Attachments 200 per task, file 100 MB, PR 500 MB | dto.ts:940-941, context/routes.ts:244 | "The file is larger than 100 MB." | RESOURCE (disk) | fixed | keep |
| Run images 20 × 5 MB, text 256 KB / 1 MB total, PDF 20 MB | dto.ts:942-948, context/task-file.ts:120 | "Not included: a run gets at most 20 images." | RESOURCE (prompt, real) | fixed | keep |
| Jira rules 20, keys 50, 10 tasks per rule match | dto.ts:76-83, tasks/rules.ts:17 | Extra matches silently dropped | ARBITRARY | fixed | raise |
| Push only to own branches, force-with-lease, no target branch | tasks/push.ts, pr.ts | Push refused | SAFETY | fixed | keep |

## Review and re-review
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| One run at a time, app-wide | review/jobs.ts:1769 | "Another review is running." (409) | ARBITRARY (partly cost) | fixed | editable |
| Max turns 2..1000 | dto.ts:207 | Run ends at max turns | RESOURCE | per profile | keep |
| Run timeout 60 min | review/claude.ts:24,580 | Run killed | RESOURCE | fixed | editable |
| Findings 100 per run | shared/review.ts:11 | Extra findings dropped or fail validation (unverified) | RESOURCE | fixed | keep |
| Refused tool calls > 5 stops the run | review/stream.ts:28, claude.ts:615 | Run stops | SAFETY | fixed | keep |
| Diff 32 MB, line 2000 chars | review/diff.ts:21-22,36 | "The diff is too large to show." | RESOURCE | fixed | keep |
| Instructions 64 KB per file, 120,000 total, 4 hops | review/instructions.ts:17-22 | Instructions cut (silent?) | RESOURCE (prompt) | fixed | keep |
| Skills 1 MB / 200 files, index after 5 | review/skills.ts:26-30 | Skill not loaded (unverified) | RESOURCE | fixed | keep |
| PR context 48 KB, description 4 KB, peer PRs 10 | review/context-files.ts:542-548 | Context cut silently | RESOURCE | fixed | keep |
| Earlier findings 100 | review.ts:500 | Older ones not passed | RESOURCE | fixed | keep |
| Sanitized snapshot, no run in user clone | BRIEF 3.5 | — | SAFETY | fixed | keep |

## Explain
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| Walkthrough 60,000 chars, 3 diagrams × 20,000, 25 nodes | review.ts:257-259, catalog.ts:752 | Output cut or fails schema | RESOURCE | fixed | keep |
| Schema: 60 key files, 300 files, 30 steps, 20 questions | review.ts:264-288 | Large PR Explain may fail validation | RESOURCE | fixed | raise |
| Needs a profile with "Explain only" on | jobs.ts:2010 | "No profile has Explain only on…" | ARBITRARY | Settings | keep |

## Finding discussion and Ask
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| Discussion 20 messages | review.ts:191, web/review/discuss-model.ts:43 | Talk runs out (counter) | ARBITRARY | fixed | raise |
| Discussion turns 40, answer 8000 | jobs.ts:236, review.ts:192 | Turn stop | RESOURCE | fixed | keep |
| Question 4000, answer 20,000 chars | review.ts:528-529, web/ask/AskPanel.tsx:218 | Textarea stops | RESOURCE (low) | fixed | raise |
| Ask history 3 turns (1 KB/2 KB each) | context-files.ts:316-318 | Claude forgets older turns | RESOURCE | fixed | raise |
| Notes 30 per PR, 500 chars each | review.ts:198-199, web/pr/Notes.tsx:438 | Textarea stops; cap refusal (unverified) | ARBITRARY | fixed | raise |
| Consult: 200 KB, 500 entries, 25 sessions, judge 12 turns, timeout 20 min | shared/consult.ts:31-32,325; sessions.ts:20; jobs.ts:218 | "At most 12 turns." | RESOURCE | fixed | keep |
| Own PRs only (Ask your session, Fix) | jobs.ts:2259,2281 | "…works only on your own pull requests." | SAFETY | fixed | keep |

## Fix
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| 25 threads/findings per run | review.ts:299, web/fix/model.ts:194 | "Tick at most 25 threads and findings for one run." | ARBITRARY | fixed | raise |
| 50 edits, 200 KB, 20,000 chars per edit | review.ts:384-387 | Fix fails validation (unverified) | RESOURCE | fixed | keep |
| Commit message 5000 | web/fix/ApplyDialog.tsx:214 | Textarea stops | ARBITRARY | fixed | keep |
| Declined fix / fix commit holds it | review/fix-routes.ts:372-376 | "Undo the commit first." | SAFETY (state) | fixed | keep |

## Replies and publish
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| Reply/note text 20,000 | dto.ts:91, web/pr/ReplyComposer.tsx:258 | Textarea stops | ARBITRARY | fixed | keep |
| New messages arrived → read first | publish/outbox.ts:621,686 | "New messages arrived in the thread. Read them first." | SAFETY | fixed | keep |
| Retry or drop only unknown/failed posts | outbox.ts:655,672,710 | 409 text | SAFETY | fixed | keep |
| Sync first / new commits | diff.ts:171, jobs.ts (many) | "Sync the pull request first." | SAFETY (stale data) | fixed | keep |

## Settings and profiles
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| Profiles 20, name 60, note 200 | dto.ts:92,200-201 | Add disabled (unverified) | ARBITRARY | fixed | keep |
| MCP servers 10 per profile, 100 tools; argv 32,000 | dto.ts:109-110, claude.ts:26,436 | "MCP tool lists are too long… Pick fewer MCP servers." | RESOURCE (Windows argv, real) | fixed | keep |
| Skills 200 per profile | dto.ts:98 | Validation | ARBITRARY | fixed | keep |
| Extra instructions 20,000 | dto.ts:1164, ProjectInstructions.tsx:237 | Textarea stops | RESOURCE (prompt) | fixed | raise |
| Branch prefixes 10, 40 chars | task.ts:96-97, BranchPrefixes.tsx:188-197 | "At most 10 prefixes." | ARBITRARY | fixed | raise |
| Review stats 1..365 days | dto.ts:1256 | Validation | ARBITRARY | fixed | keep |
| Localhost, token not stored, Host/Origin checks | BRIEF 3.6 | — | SAFETY | fixed | keep |

## CI builds
| Limit | Where | User sees | Cat. | Changeable | Guess |
|---|---|---|---|---|---|
| 10 builds shown per commit | sync/builds.ts:9 | Older builds hidden | ARBITRARY | fixed | raise |
| Open PRs page 50 (paged, max 200 pages) | bitbucket/provider.ts:45, client.ts:13 | Probably never hit | RESOURCE | fixed | keep |

**Summary of the worst ones.** The global single-run lock hurts most. One running review blocks Explain, Ask, Fix, discussion and every task step on every PR. It looks like a cost or CPU choice, not a safety rule, and nothing in Settings can change it. Next come fixed numbers with no reason I could find: 20 discussion messages, 30 notes per PR at 500 characters each, 25 threads per Fix run, 10 branch prefixes, 5 open PRs at once and 12 sub-task parts. All of these refuse in the UI. Several AI-output schema caps are a quieter problem. Explain's 300 files and 30 steps, and the plan's 15 steps, 8 questions and 12 contracts, can make a run on a large PR fail validation instead of trimming its output; I did not confirm whether they trim or fail. Some limits are fixed although they look like they should be settings: the 60-minute run timeout, the 20-minute task step time, 3 test-fix tries, 2 interview rounds and 80 plan turns. Everything marked SAFETY matches the hard rules and should stay.

Not checked: the UI messages for limits I found only in schemas (marked unverified), and the Bitbucket client and sync internals. I gave the values; I did not test in the running app whether each limit triggers.

## User decisions (2026-11-04)

The user agreed with all four recommendations:

1. Several runs at once. A Settings number sets the limit (default 3). One run per PR at a time. A short design comes first, because the run queue is central code.
2. Built. Raise these fixed numbers: discussion messages 20 to 100; notes per PR 30 to 200, each 500 to 20,000 characters; Fix threads per run 25 to 100; branch prefixes 10 to 50; open PRs per task 5 to 20; sub-task parts 12 to 30; Jira rule matches 10 to 50.
3. Built (Settings, Tasks, "Run limits"; bounds: step time 5 to 120 min, review run time 10 to 240 min, interview rounds 1 to 5, test-fix tries 1 to 10, plan turns 20 to 500). Make these editable in Settings, Tasks: the task step time (20 min), the review run time (60 min), the interview rounds (2), the test-fix tries (3), and the plan turns (80).
4. An AI result over a schema cap is cut, not failed. First check which caps fail today, then change only those.

The setup package also got the user's agreement: setup default 60 min; checks keep 10 min; maximum 4 h; a "Time limit (min)" field on each command row; Claude proposes a limit for long setup commands; a timeout shows as "time limit", not "stopped", with "Change the time limit"; and the opt-in folder `REVIEW_LOOP_TASK_CACHE`, shared by the parts of one task.
