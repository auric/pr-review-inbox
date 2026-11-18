# Self-approved plans: build a large task with no spec PR

Status: design of 2026-11-18 against main a789260. User decision of 2026-11-18: build a large Jira task that only the user approves, with no spec PR review by colleagues. It is designed together with PS9 (spec size levels). Nothing is built. The decisions of section 2 wait for the user.

## Summary

- Verdict: the part engine of spec.md section 6.20 builds a self-approved large plan. The change adds no table, no stored state value, and no event.
- The choice: a "Plan review" pair under the large size radio. It is stored as `task.settings_json.planReview` ("self" | "spec-pr") at the approval.
- The machine: `TaskContext.selfReview`. The guards are `noSpecPr` (small, medium, or large with self) and `specPr` (large without self). Three rows of spec_draft change. The part machine and the phase machine stay.
- The build: the approval writes one part row per plan part, with no keys. Part 1 starts from the target. Part k branches from part k-1, and its PR targets that branch. The scheduler, the part gate, the push, the move, and the three-step merge of spec.md section 6.20 apply unchanged.
- PS9: this package set comes first and takes the machine part of PS9. PS9 keeps the document levels only.

## 1. Facts of today's code

- The task machine guards are `small` and `planReview` (machine.ts:63-64). APPROVE goes to implementing for small and stays in spec_draft for medium and large (machine.ts:76-79). OPEN_SPEC_PR, SPEC_GATE_PASSED, and OVERRIDE have no sender (RESERVED, machine.ts:244-249).
- advance reads state, stopped_from, size, and version only (tasks.ts:186, :238, :245-253).
- The plan route patches size, docs, and settings, then sends APPROVE, in one transaction (tasks.ts:2437-2448).
- The plan route accepts a second approval. load checks the state, the version, and a busy step (tasks.ts:2220-2227). loadPlan checks only that docs exist (tasks.ts:2276-2281). No check reads docs.approved.
- The web shows no primary for an approved plan in spec_draft (model.ts:751-760).
- ensureParts returns when parts exist (loop.ts:2237). It throws for any size but small (loop.ts:2238).
- A sub-task task is size small, and the size rules do not apply to it (tasks.ts:2338-2342; spec.md:2229).
- approveParts writes part rows from PlannedPart[], links after_part, and pushes and posts nothing (tasks.ts:1608-1650). approveSubtasks cannot serve a plan without keys: it drops a part without keys (subtasks.ts:417-418) and reads a sub-task row (subtasks.ts:442).
- partNames gives "<KEY> (2 of 3)" and "<KEY> (part 2 of 3)" for parts without keys (tasks.ts:1118-1135).
- branchName has the kind part: `<prefix><KEY>-<n>-<slug>` (shared/task.ts:310-318). The push guard accepts that name: the head is `<prefix><KEY>-`, and the suffix matches SUFFIX (push.ts:12, :51-68). The push input takes the key from the part, else the task key (pr.ts:195, :341-353).
- startPart takes the scheduler pick. A stacked part branches from the pushed head of the lower part, and base_branch becomes the lower branch (loop.ts:2272-2326). The PR target is base_branch when base_commit is set (pr.ts:193-194).
- The scheduler waits for the lower gate unless the user overrides it (schedule.ts:33-41). maxOpen comes from task settings, else MAX_OPEN_DEFAULT 3 (tasks.ts:1241). Large tasks use the repository max_open (spec.md:2328; BRIEF.md:87; TASK_DEFAULTS.maxOpen 2, shared/task.ts:133).
- context() sets `size: t.size` (loop.ts:2366). loop.ts:984, :992, :1076, :2090, :2591, pr.ts:190, and task-pr.ts:38 pick the plan file names from that size. partDocsOf renders a "small" slice of one part for sub-task tasks only (tasks.ts:1184-1205).
- A large plan stays in one repository: the approval refuses another repository (plan.ts:45-54), and a commit with a submodule change blocks (loop.ts:1647).
- The web keys the multi-part view on `t.subtasks !== null` (TaskView.tsx:141, PlanTab.tsx:108, OpenPrDialog.tsx:35, model.ts:209, :240, :725). TaskDto already carries `settings: TaskSettings` (dto.ts:1989; tasks.ts:1494).
- The spec run already splits the work into parts of at most the line budget (catalog.ts:1114).
- Q9 of part-session.md (approved 2026-11-12): medium loses its spec PR.

## 2. Decisions (recommended answers; the plan uses them until the user answers)

| ID | Question | Recommended |
|---|---|---|
| D1 | Medium joins noSpecPr now, before the PS9 brief? | Yes. It is the approved Q9 row. Medium commits design.md, spec.md, and tasks.md in its one code PR until PS9. |
| D2 | The spec PR option while the app cannot open a spec PR | Show it disabled with "This version cannot open a spec PR yet." Default: self. |
| D3 | Part 1 also commits the full plan? | No. It opens the plan to review, against the user decision. |
| D4 | A Skip or Drop of a middle part in a stack | The planned part above it builds on the part below the skipped one. Sub-task tasks keep the base start. |
| D5 | Order against PS6-C | This set first, because the user's task waits. If PS6-C is in progress, it ends first. |
| D6 | BRIEF and UI wording | Section 8, for approval. |
| D7 | Plan folder of a part | `specs/<KEY>/part-<n>/` for every part, so the folder matches "(part n of m)". |

## 3. The user choice

### 3.1 Control

- Place: the Size fieldset of the plan screen (PlanTab.tsx:222-260), under the large radio. It shows only when the picked size is large and the task has no sub-tasks.
- Legend: "Plan review". Two radios: "I approve the plan myself. Colleagues review only the code PRs." and "Colleagues review the plan first, in a spec PR."
- The second radio is disabled. Its note: "This version cannot open a spec PR yet." A later package (WP-B8) enables it.
- Default: the stored planReview, else "self".
- The pick is local state of the form. "Approve the plan" sends it. No other route stores it.
- The note "This version builds small tasks only. A {size} plan waits after its approval." (PlanTab.tsx:252-256) goes away.
- The branch section shows the prefix chips only for a large plan, as for sub-tasks (`chipsOnly`, PlanTab.tsx:271).

### 3.2 Storage and input

- shared/task.ts: `PLAN_REVIEWS = ["self", "spec-pr"] as const`; taskSettings gains `planReview: z.enum(PLAN_REVIEWS).optional()`. settings_json is zod data, so no migration.
- dto.ts taskPlanInput gains `review: z.enum(PLAN_REVIEWS).optional()`.
- Route rules of POST /api/tasks/:id/plan:
  - review with a sub-task task gives 400: "A task with sub-tasks builds one PR per sub-task. It takes no plan review."
  - review with a size other than large gives 400: "Only a large plan takes a plan review choice."
  - Size large stores `planReview = input.review ?? "spec-pr"`. An API call without review never builds a large plan without colleagues.
  - Other sizes remove planReview from the settings.
  - Large with self also stores `maxOpen` = the repository max_open (tasks.ts:629).
  - One transaction, in this order: the repository row, the patch (size, docs approved, settings), APPROVE, then approveParts for large with self. A refusal rolls back all of it.

### 3.3 Choice states

| Task and plan | Stored planReview | Control | Approve sends | Result |
|---|---|---|---|---|
| spec_draft, small or medium | none | hidden | no review | APPROVE noSpecPr: implementing |
| spec_draft, large, not approved | none | shown, starts at self | review self | APPROVE noSpecPr: implementing, part rows written |
| spec_draft, large, not approved | none | spec-pr picked (disabled today) | review spec-pr | APPROVE specPr: spec_draft, approved, waits |
| spec_draft, large, approved for a spec PR | spec-pr | shown, starts at spec-pr | review self | APPROVE noSpecPr: implementing |
| spec_draft, old approved medium plan | none | hidden | no review | APPROVE noSpecPr: implementing |
| implementing and later | self or none | not shown | none | none |
| a task with sub-tasks | none | hidden with the size section | review refused (400) | none |

## 4. State machines

### 4.1 Task machine context and guards

- `TaskContext = { size: TaskSize | null; gate: boolean; stoppedFrom: TaskState | null; selfReview: boolean }`.
- advance reads settings_json with the row (SQL.task, tasks.ts:186) and sets `selfReview = planReview === "self"`. A settings parse error gives false (the settingsOf rule, tasks.ts:703-706).
- planReview is a stored fact, not a state value. Rule R1 of part-session.md section 9.2 forbids new stored state values only.
- Guards:
  - noSpecPr: size is small, or size is medium, or size is large and selfReview is true.
  - specPr: size is large and selfReview is false.
  - gate and stoppedFrom stay.
- Size null: no APPROVE guard holds, so APPROVE is refused, as today.

### 4.2 Task machine: full transition table after the change

| State | Event | Guard | Target | Sender | Side effects (owner) | Change |
|---|---|---|---|---|---|---|
| (none) | BUILD | none | interview | route POST /tasks | interview run (tasks) | none |
| interview | ASKED | none | interview | tasks | question reason (tasks) | none |
| interview | ANSWERED | none | spec_draft | route answers; tasks | spec run (tasks) | none |
| interview | STOP | none | stopped | route stop; tasks | as 9.3.1 | none |
| interview | FAIL | none | failed | reserved | clear part rows | none |
| spec_draft | APPROVE | noSpecPr | implementing | route plan | small and medium: loop.build, then ensureParts makes one part. Large with self: approveParts writes the stack in the same transaction, then loop.build and startPart (route, loop) | CHANGED: was small |
| spec_draft | APPROVE | specPr | spec_draft | route plan | docs approved; nothing else | CHANGED: was planReview (medium or large) |
| spec_draft | OPEN_SPEC_PR | specPr | spec_pr_open | reserved, WP-B8 | push and PR create (pr) | CHANGED guard: was planReview |
| spec_draft | STOP | none | stopped | route stop | as 9.3.1 | none |
| spec_draft | FAIL | none | failed | reserved | clear part rows | none |
| spec_pr_open | SPEC_GATE_PASSED | gate | spec_approved | reserved, WP-B8 | notification | none |
| spec_pr_open | OVERRIDE | none | spec_approved | reserved, WP-B8 | none | none |
| spec_pr_open | CLOSE | none | done | route close | closed_at (tasks) | none |
| spec_pr_open | STOP, FAIL | none | stopped, failed | as above | as above | none |
| spec_approved | START_BUILDING | none | implementing | no sender for this state | loop.build | none |
| spec_approved | STOP, FAIL | none | stopped, failed | as above | as above | none |
| implementing | PART_READY | none | implementing | loop, after REVIEWED | base check (loop) | none |
| implementing | LAST_PR_OPEN | none | ready | pr, sync, route drop, tasks | clear waiting part rows | none |
| implementing | STOP, FAIL | none | stopped, failed | as above | as above | none |
| ready | ALL_MERGED | none | done | sync, route drop | delete transcripts; end CI mode | none |
| ready | CLOSE | none | done | route close | closed_at; delete transcripts | none |
| ready | START_BUILDING | none | implementing | tasks, sub-task added | loop.build | none |
| ready | STOP, FAIL | none | stopped, failed | as above | as above | none |
| stopped | RESUME | stoppedFrom X, X in interview, spec_draft, spec_pr_open, spec_approved, implementing, ready | X | route resume | Continue rule, then GO per building part (loop) | none |
| stopped | CLOSE | none | done | route close | closed_at; delete transcripts | none |
| stopped | FAIL | none | failed | reserved | clear part rows | none |
| done | CLOSE | none | done | route close | clear blocked and waiting rows; version + 2 | none |
| failed | none | none | final | none | none | none |

- Every other pair is refused and writes nothing.
- No edge goes from implementing back to a spec PR state. A self approval is final for that plan.
- RESERVED keeps OPEN_SPEC_PR, SPEC_GATE_PASSED, and OVERRIDE for WP-B8.

### 4.3 Part machine

- No change (machine.ts:106-135; part-session.md section 9.3.2).
- Senders in a stack plan: START (startPart, scheduler), REVIEWED (loop), PR_OPENED (PR route), CHANGES_REQUESTED, GATE_PASSED, GATE_FAILED, MERGED, DECLINED (sync), REOPENED (retarget), ABANDON (skip, drop), RESTART (restart route). ADOPT_OPEN and ADOPT_MERGED have no sender in a stack plan, because it has no found PRs.

### 4.4 Phase machine and scheduler

- The phase machine does not change.
- nextPart stays a pure function and no XState machine (spec.md section 6.20.6).

### 4.5 Machine tests (tests/tasks/machine.test.ts)

- BASE becomes `{ size: "large", gate: true, stoppedFrom: "implementing", selfReview: false }`, so the spec_draft row of TASK_TABLE keeps APPROVE to spec_draft and OPEN_SPEC_PR to spec_pr_open.
- TASK_CONTEXTS adds selfReview false and true to the grid.
- APPROVE grid: small and medium go to implementing under both selfReview values. Large with self goes to implementing. Large without self stays in spec_draft. Size null is refused under both.
- OPEN_SPEC_PR: allowed only for large without self.
- The reachability and dead-end test still passes, because large without self reaches spec_pr_open.
- The machineMermaid snapshot (machine.test.ts:578-586) and README.md:305-306 show "APPROVE if noSpecPr", "APPROVE if specPr", and "OPEN_SPEC_PR if specPr" (readme.test.ts:10-14).
- A DB walk in tests/tasks/large.test.ts: a large task with planReview self goes from spec_draft to implementing through advance; with spec-pr it stays.
- Control mutation: noSpecPr without the selfReview term. The large-with-self row turns red.

## 5. Building a self-approved large plan

### 5.1 The engine switch

- New predicate in tasks.ts: `partsPlan(t) = t.subtasks === 1 || (t.size === "large" && planReview === "self")`. Its comment: the task builds its plan as several PRs on the part engine.
- The web gets the same predicate in model.ts from `t.subtasks`, `t.size`, and `t.settings.planReview`.
- task.subtasks stays 0. That flag also means Jira sub-task reads, subtasks.md, and size small (spec.md:2229, 042_task_subtasks.sql:2).

Server sites:

| Site | Today | After | Class |
|---|---|---|---|
| tasks.ts:1082 focus in currentPart | subtasks | partsPlan | engine |
| tasks.ts:1148 lowerOf | subtasks | partsPlan (the Pick adds size and settings_json) | engine |
| tasks.ts:1186 partDocsOf | subtasks | partsPlan | engine |
| tasks.ts:1220 scheduleOf | subtasks | partsPlan; done from subtaskRows stays empty | engine |
| tasks.ts:1245 buildsAtOnceOf | subtasks | stays | sub-task only: a linear stack builds one part at a time |
| tasks.ts:1404, :1544, :1728, :1814, :2013, :2193, :2334, :2339, :2926-2949 | subtasks | stay | Jira |
| tasks.ts:2633-2634 GET branch | small kind for small only | small kind for every size but large | medium |
| loop.ts:978 filesFor | subtasks | stays | Jira |
| loop.ts:1647 submodule block | c.size large | c.t.size large | large rule |
| loop.ts:2238 ensureParts | throws for any size but small | throws for large only | medium |
| loop.ts:2353 context name | subtasks | partsPlan | engine |
| loop.ts:2366 context size | t.size | small for partsPlan, else t.size | plan slice |
| loop.ts:2650 settle on resume | subtasks | partsPlan | engine |
| loop.ts:2672 startPart loop | subtasks | partsPlan | engine |
| loop.ts:2710 preflight branches | subtasks | partsPlan | engine |
| loop.ts:2841-2842 refreshBases | subtasks | partsPlan | engine |
| loop.ts:3702 skip | subtasks | partsPlan; new text "Only a task with several PRs can skip a part." | engine |
| loop.ts:3896 planned part counts | subtasks | partsPlan | engine |
| pr.ts:181 "Parent:" line | always in subtaskPrText | only for t.subtasks === 1 | Jira |
| pr.ts:190 textOf | subtasks | partsPlan | engine |
| pr.ts:199 continued | subtasks | stays | Jira |
| task-pr.ts:18, :38 plan paths | docNames(size) | docNames(small) for partsPlan; the query adds subtasks and settings_json | plan slice |
| task-file.ts:320 subtasks.md | subtasks | stays | Jira |
| gates.ts:109, :117 | through scheduleOf and lowerOf | follow | engine |

Web sites:

| Site | After |
|---|---|
| model.ts:209 partRef, :240 Skip, :560 task ID prefix, :718 held, :725 many, :1263 prTitle, :1308 questionPart | partsPlan |
| model.ts:1182 fileGroups, :1281 subOf, :1438 sub-task rows, :1504 subPlanSentence, :1699 | stay (Jira). The rows loop already adds parts without a sub-task. |
| model.ts:1360, :1569 "Drop this sub-task" | "Drop this part" in a stack plan |
| model.ts:1553 tracker More items | only for sub-tasks |
| TaskView.tsx:141 subs and its uses (:167, :297, :362, :390, :494, :540, :630, :905, :1057, :1069) | partsPlan |
| TaskView.tsx:158 tracker check, :601 parent hint | sub-tasks only |
| TaskView.tsx:505 header | sub-tasks: "Sub-tasks: n, one PR each"; stack: "Parts: n, one PR each" |
| OpenPrDialog.tsx:35 PR target | partsPlan |
| PlanTab.tsx:108 sub | stays (the sub-task plan form) |

### 5.2 Part rows at the approval

- New `stackParts` in subtasks.ts, beside PlannedPart. It takes the task (key, target_branch, spec_dir), the plan parts sorted by n, and the prefix.
- Part n: keys []; title of the plan part; branch `branchName(prefix, key, { kind: "part", n, title })`; base: the target branch for the first part, else the branch of the part before; start "base" for the first part, else "stack"; after null for the first part, else the n of the part before; specDir `<spec_dir>part-<n>/`; pr null.
- The stack order follows design.md:380-381. It does not read the start or after fields of the spec result. Those prompt lines exist only in subtaskSpecRules (catalog.ts:1160).
- approveParts writes the rows (tasks.ts:1608-1650). Its LAST_PR_OPEN branch never runs, because no part has a PR.

### 5.3 Branches, bases, and PR targets

- Example: `feature/ABC-10-2-add-the-event-generator`. The push guard accepts it (push.ts:56-63).
- startPart opens each branch with "new", because a stack part has no found row. A name that exists on the server gets the first free suffix (loop.ts:2302-2304).
- Part 1 branches from the fetched head of the target. Part k branches from the pushed head of part k-1 (loop.ts:2293-2301).
- PR targets: part 1 targets the target branch. Part k targets the branch of part k-1 (pr.ts:193-194).

### 5.4 When each PR opens

- Only on the user's click "Open the PR" for a self_reviewed part. Nothing changes here.
- The approval and the loop push and post nothing (spec.md section 6.20.11).

### 5.5 Build order

- nextPart starts part 1. Part k waits with "Waits for a review of ABC-10 (k-1 of n)." until part k-1 is approved. "Start now" with its confirm overrides the wait (schedule.ts:39).
- At most maxOpen PRs are open (repository max_open, default 2). Then a part waits with "Waits: 2 PRs of this task are open, your limit."
- One part builds at a time (buildsAtOnceOf stays 1).
- The task stays in implementing while a part is planned, implementing, or self_reviewed. LAST_PR_OPEN and ALL_MERGED come from the sync and the drop route as today.

### 5.6 Plan files and PR text

- The full design.md, spec.md, and tasks.md stay in task.docs_json and the Plan tab. They are never committed (D3).
- Each part commits only its own slice: partDocsOf renders plan.md of that part into `specs/<KEY>/part-<n>/plan.md`. Claude ticks that file.
- Commit messages and the PR title name the part: "ABC-10 (part 2 of 3) T2.1: …" and "ABC-10 (part 2 of 3): <part title>".
- The description holds the goal, acceptance, and tests of the part, the plan path, and one line with each part. Example: "ABC-10 (1 of 3): #41 (in review) · ABC-10 (2 of 3): this PR · ABC-10 (3 of 3): next, builds on this PR".
- A lower part adds "Please keep this branch until ABC-10 (3 of 3) moves to the new target." (Gate G5).
- The description has no "Parent:" line.

### 5.7 Updates and merges

- They follow spec.md section 6.20.10 unchanged, through lowerOf and the push and move routes.
- New commits on part k-1: part k shows "Update from <branch>". Before the first push of part k, the app rebases it onto the new head. After the first push, it merges. The push is a fast-forward with the lease.
- Part k-1 merges with a merge commit: "Move ABC-10 (2 of 3) to <target>" sends one PUT after one confirm.
- Part k-1 merges with a squash: the three-step merge, then "Push and move". The app never force-pushes after the first push. Every push has an explicit `--force-with-lease` and no `+` refspec (push.ts:89-100).
- A deleted lower branch can decline part k. "Open the PR again" reopens it (spec.md section 6.8).

### 5.8 Skip and Drop in a stack

- Skip (implementing or self_reviewed) and Drop (planned or declined) send ABANDON as today.
- In a stack plan without sub-tasks, the same transaction sets after_part of each planned part on top of the dropped part. The new value is the after_part of the dropped part. With no lower part, the planned part starts from the base (schedule.ts:34-36).
- A sub-task task keeps its rule: a planned part on top starts from the base (spec.md:2293).
- Drop still refuses while a started part builds on the part (upperOf, loop.ts:3654).

## 6. Medium after this change

- APPROVE of a medium plan goes to implementing (noSpecPr). ensureParts makes one part on `<prefix><KEY>-<slug>`, as for small.
- Until PS9, a medium part commits design.md, spec.md, and tasks.md, and ticks tasks.md. The PR text names tasks.md (pr.ts:190).
- GET /branch names the one branch for medium (tasks.ts:2634). The web plannedBranch gives the same name for medium (model.ts:1104-1105).
- An old approved medium plan in spec_draft shows "Approve the plan" again. The second approval builds it.

## 7. Fit with PS9

- Order: this set first, because the user's real task waits. PS9 then drops two items: the machine part (guards, medium join, README diagram) and "Approve the plan" again for an old approved plan.
- What remains in PS9: docNames per size, the card and brief grammar, the spec run prompt per size, prText from the card or brief, the card path, and the size lines of the plan screen.
- PS9 levels for a self-approved large plan:
  - The plan screen shows the large level, the full spec, for every large plan. The review choice does not change the spec run.
  - The committed text is per part. A part of a part plan (sub-tasks or a self-approved stack) takes the small level. So after PS9 each part gets a card outside repo/, and its PR description is the card plus the stack lines.
- PS9 adds to its scope:
  - partDocsOf and subtaskPrText follow the small level for every part.
  - catalog.ts:1134 ("Medium: one code pull request after a plan review") becomes wrong after SA-1. PS9 rewrites it with the prompt per size.
  - The medium size line mentions the brief.

## 8. Wording for approval

- BRIEF.md:87, new text: "Task sizes: small gives one PR with a short plan and the code. Medium gives one PR with the plan and the code. Large gives stacked part PRs, one after another. Before a large build, I pick who reviews the plan. I approve it myself, or colleagues review it first in a spec PR. The spec PR comes in a later version. Claude proposes the size. A migration or an API change gives at least medium. An estimate over the line budget gives large. The line budget is 400 changed lines per PR, lock files excluded, per repository. I confirm the size before any code. At most 2 code PRs of a task are open at once."
- BRIEF.md:290, new end of US10: "Small: one pull request with a short plan and the code. Medium: one pull request with the plan and the code. Large: the code comes in small pull requests, one after another. I approve a large plan myself, or colleagues review it first in a spec pull request. Each pull request opens only on my click."
- spec.md section 6.1 table. Medium: "Medium: one PR with the plan and the code." with 1 code PR. Large: "Large: the code comes in small PRs, one after another." with 2 or more part PRs, and a spec PR only when colleagues review the plan.
- SIZE_LINE (model.ts:142-146): medium "Medium: one PR with the plan and the code."; large "Large: the code comes in small PRs, one after another."
- Plan review radios: section 3.1.
- An approved plan that waits (model.ts:756): "The plan waits for a spec PR, which this version cannot open. Approve it again to build it now." Primary: "Approve the plan".

## 9. Edge cases

- Switching between self and spec-pr before the approval: local form state, with no server write. Two tabs: the version check lets one approval through.
- An approved self plan that the user wants colleagues to see later: no machine edge allows it. Each part PR carries its slice. The Plan tab keeps the full spec. A later spec PR is out of scope.
- An approved spec-pr plan: it waits in spec_draft. A second approval with self builds it.
- Too many parts: the specResult schema caps parts at SUBTASK_PARTS_MAX 30 (shared/task.ts:244, :941). The plan screen shows the schema failure.
- A part over the line budget: no check at the approval. The commit note "This PR has 520 changed lines, over your 400 limit." and "Change the limit" apply per part (spec.md section 6.1).
- More parts than maxOpen: the scheduler waits with the limit sentence.
- A large plan with one part: one stack part from the base, with one PR.
- Several repositories: the approval refuses a large plan with another repository (LARGE_REPOS_TEXT, plan.ts:45-54). A submodule change during a part build blocks (loop.ts:1647, through c.t.size). The user raises the line limit (then medium) or splits the task. Stacks across repositories stay out of scope (design.md Q51).
- A task with sub-tasks: sub-tasks win. Size small, no size section, no review choice; the route refuses review with 400.
- A parent built "as one task": subtasks 0, so the normal size and review rules apply.
- Restart during a stack build: recoverTasks stops the task. Resume runs the Continue rule per building part (loop.ts:2650 through partsPlan).
- A colleague pushes to a part branch: the lease fails with "Someone else pushed" (spec.md section 6.8).
- Tasks in flight: no task of size medium or large has parts (G1 of part-session.md section 9.1.6). An old approved plan has no planReview, so it counts as spec-pr and waits until a second approval. No migration.

## 10. Invariants with evidence

1. The machines stay pure. advance is the only writer of task.state, and a refused event writes nothing (machine.ts:4-6; tasks.ts:245-265).
2. The settings patch comes before APPROVE in the same transaction, so the guard sees planReview (tasks.ts:2445-2446).
3. The approval pushes and posts nothing (tasks.ts:1608-1650; spec.md:2241).
4. Every push goes through pushTaskBranch with an explicit lease, a fast-forward check, and no `+` refspec (push.ts:82-100). The guard accepts only `<prefix><KEY>-` names of the task's own part branches (push.ts:51-68; pr.ts:341).
5. No force push after the first push. After a squash, the update merges in three steps (spec.md:2364-2373).
6. A stacked part branches from the pushed lower head and targets the lower branch (loop.ts:2291-2317; pr.ts:193-194).
7. A part waits for the lower part gate unless the user overrides (schedule.ts:33-41).
8. A large plan stays in one repository (plan.ts:45-54; loop.ts:1647).
9. The plan route accepts a second approval in spec_draft (tasks.ts:2220-2227, :2276-2281).
10. ensureParts runs only when no part exists (loop.ts:2237).
11. Parts without keys get the names "<KEY> (k of n)" (tasks.ts:1118-1135).

## 11. Work packages

Run one at a time. They are not file-disjoint: SA-1 and SA-2 share tasks.ts and loop.ts; SA-1 and SA-3 share model.ts and PlanTab.tsx. Each ends green on `bun run check`. Web packages also run `bun run test:e2e` on their own ports and print the `E2E code:` line.

| WP | Tier | Files | Starts after |
|---|---|---|---|
| SA-D Docs | implementer | BRIEF.md (approved text of section 8), docs/plans/review-v2/spec.md (6.1, 6.2 tables and machine, the 6.20 preface, new 6.29 with this design), part-session.md (2.19 note, 9.3.1 rows), tasks.md (SA rows, WP-B8 note), ps6-ps7-plan.md section 7 (PS9 scope), CLAUDE.md status line, docs/smoke-task.md part LS | the separate limit package; the user approves D6 |
| SA-1 Machine and medium | implementer | src/server/tasks/machine.ts; src/shared/task.ts (PLAN_REVIEWS, taskSettings.planReview); src/server/tasks/tasks.ts (SQL.task, StateRow, advance context, GET /branch :2634); src/server/tasks/loop.ts (:2238); src/web/tasks/model.ts (SIZE_LINE.medium, plannedBranch, :751-760); src/web/tasks/PlanTab.tsx (note for large only); README.md diagram; tests/tasks/machine.test.ts; tests/tasks/medium.test.ts (new); tests/web model tests | SA-D |
| SA-2 Large self build | implementer-xhigh | src/shared/dto.ts (taskPlanInput.review); src/server/tasks/tasks.ts (partsPlan, the engine sites, plan route); src/server/tasks/subtasks.ts (stackParts); src/server/tasks/loop.ts (engine sites, context size, :1647, skip and drop re-point, skip text); src/server/tasks/pr.ts (:181, :190); src/server/tasks/task-pr.ts (:18, :38); tests/tasks/large.test.ts (new); tests that assert the old skip text | SA-1 |
| SA-3 Web, e2e, docs | implementer | src/web/tasks/{model.ts, PlanTab.tsx, TaskView.tsx, OpenPrDialog.tsx}; tests/web; tests/e2e/task-large.e2e.ts (new); demo data if a screenshot needs a large task; docs/screenshots (bun run screenshots); README.md prose of "Build a Jira task"; CHANGELOG.md | SA-2 |
| Gate UL-S | user | docs/smoke-task.md part LS on the real task: approve it yourself, part 1 PR, approval, part 2 on top, merge part 1 with a merge commit, then Move; a second run with a squash | SA-3 |

Order against the other plans: separate limit package, SA-D, SA-1, SA-2, SA-3, Gate UL-S, PS6-C, PS7a-A, PS7a-B, PS7b-0, PS7b-A, PS7b-B, PS7b-C, PS9 (reduced, section 7), PS8. If PS6-C is in progress, it ends before SA-1. Push main after SA-3, so the UI and the server match.

### SA-1 tests and control mutation

- Machine tests of section 4.5. README diagram test.
- Medium: an approval goes to implementing. One part on `<prefix><KEY>-<slug>` commits design.md, spec.md, and tasks.md. The PR text names tasks.md. GET /branch names the one branch.
- Web model: an approved plan in spec_draft shows "Approve the plan". The medium radio has no wait note.
- Control mutation: remove medium from noSpecPr. The medium build test turns red.

### SA-2 tests and control mutations

- AC-SA5 to AC-SA12 below, in tests/tasks/large.test.ts, with a temp remote and the fake Bitbucket. Reuse the fixtures of tests/tasks/stack.test.ts and subtasks.test.ts.
- Control mutation 1: partsPlan reads subtasks only. The test "part 2 starts on top of part 1" turns red.
- Control mutation 2: stackParts gives start base to every part. The same test turns red.

### SA-3 tests and control mutation

- Web model tests for the radios, the header, the row actions, and the PR target.
- e2e task-large: approve with "I approve the plan myself", part 1 builds, open its PR, approve it on the fake server, part 2 starts on top, and its PR dialog names part 1's branch as the target.
- The AC-UX2 word scan covers the new strings.
- Screenshots are checked for real names. README and CHANGELOG list the change.
- Control mutation: show the radios for medium. The model test turns red.

## 12. Acceptance criteria

1. AC-SA1. The task machine follows section 4.2 under each size and selfReview value. The README diagram equals machineMermaid(taskMachine).
2. AC-SA2. A medium approval builds one part with one PR, as section 6 describes.
3. AC-SA3. An approved plan in spec_draft shows "Approve the plan". A second POST /plan returns 200 and applies the machine row.
4. AC-SA4. The radios show only for large without sub-tasks. Spec-pr is disabled with its note. Approve sends review self.
5. AC-SA5. Large with review self goes to implementing and writes n part rows: keys [], `<prefix><KEY>-<n>-<slug>`, part 1 base, part k stack after k-1, `<spec_dir>part-<n>/`, planReview self, maxOpen = repository max_open. The fake write counter stays 0.
6. AC-SA6. Large with review spec-pr, or with no review, stays in spec_draft with approved true. A second approval with self moves on.
7. AC-SA7. Review with small or medium gives 400. Review on a sub-task task gives 400.
8. AC-SA8. Part 1 starts from the target. Part 2 waits with the scheduler sentence, and "Start now" overrides. Part 2 branches from part 1's pushed head, and its PR targets part 1's branch.
9. AC-SA9. Each part commits only `specs/<KEY>/part-<n>/plan.md` of its slice. Commits and the PR title name "<KEY> (part k of n)". The description lists the parts and the keep-branch sentence, and has no "Parent:" line. liveTaskPart lists the part plan path.
10. AC-SA10. A merge commit of part 1 gives one PUT and no git merge. A squash gives the three merges. No push argv after the first push has a force flag or a `+` refspec.
11. AC-SA11. A Skip or Drop of part 2 makes planned part 3 build on part 1. A sub-task task keeps its base start.
12. AC-SA12. A submodule change in a stack part blocks with LARGE_REPOS_TEXT.
13. AC-SA13. The build view of a stack plan shows one row per part, the primary of the focused part, no tracker action, "Parts: n, one PR each", and "Drop this part".
14. AC-SA14. The e2e of SA-3 passes.

## 13. Scope cuts

- The spec PR flow itself (WP-B6, WP-B7, the spec branch of WP-B8).
- A replan after each merge (design.md:386).
- The contract, cleanup, and spike part kinds. Parts are plain parts in plan order.
- A spec PR after a self approval.
- Stacks across repositories (design.md Q51).
- Parts that build at the same time in a stack plan.
- A plan-time check of a part estimate over the budget.
- A "Starts:" select per part on the plan screen of a stack plan.
- Task notifications and inbox rows (WP-B10).

## 14. Open questions (unverified)

1. Is the plan of the user's real task approved (docs.approved true)? Both cases work after SA-1 and SA-3.
2. Does PS9 give each part of a part plan the card? part-session.md section 2.19 does not say. Section 7 recommends yes.
3. Does the fake claude CLI have a large spec result with several parts? The e2e of SA-3 needs one. Not checked.
4. Does the demo data need a large task for the README screenshot? Not checked.
5. routes.ts:292 starts loop.build when an action leaves the task in implementing. The plan route is assumed to pass there. Not checked in full.
6. The separate limit package edits PlanTab.tsx and model.ts. The order assumes it lands before SA-1.
7. The clean diff of a stacked PR after a lower update depends on Gate G19 (spec.md section 6.20.17).
