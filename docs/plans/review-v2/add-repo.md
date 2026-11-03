# Add a repository to a task

Status: design of 2026-11-03 against main fe6c111, user decisions recorded.

It becomes spec.md section 6.24 (AC-B116 to AC-B135) and tasks.md wave WAR. Examples use the task ABC-123, the main repository PROJ/app, and the other repositories PROJ/lib and PROJ/tools.

## 0. Plan (run order)

1. WP-AR-D. Docs: spec.md section 6.24 and the edits that it names, tasks.md wave WAR, BRIEF.md, the CLAUDE.md status line, and docs/smoke-task.md part AR.
2. WP-AR0. Contracts: the result schemas, the DTOs and route inputs, blocked kind repo, and the status texts.
3. WP-AR1. Repository library: the walk of added repositories, Read worktrees, the pin rebuild, the folder sweep, and context/repos.md.
4. WP-AR2. Build loop: needsRepo in the build steps, the continuation, the update and the base check for Read rows, and the context refresh.
5. WP-AR3. Service and routes: the picker list, Add and Remove, proposals with access, needsRepo in the interview, and the interview and spec context.
6. WP-AR4. UI: the dialog, the Repositories section in each open state, the needs-repo rows, the base lines, e2e, screenshots, and README.
7. Gate UAR: the user runs smoke-task.md part AR.

Section 6 gives the files, behavior, tests, control mutation, and main risk of each package.

## 1. Facts today (checked against main fe6c111)

### 1.1 Repositories of a task

- task_repo has role main, submodule, or added. Access is edit, read, or none. It also has base_branch, base_commit, pinned, source, proposal, proposal_reason, and base_changed (035_task_repos.sql:3-15, 040_task_base_changed.sql:3). The CHECKs allow role added with access read.
- taskRepos returns rows with proposal NULL or added. A proposed or skipped row is no repository of the task (repos.ts:169-170).
- The user cannot add a repository. Only the spec run proposes one, from context/repo-list.md (tasks.ts:1416-1429, plan.ts:57-74).
- That list holds REPO_WRITE repositories only. A spec run proposes at most PROPOSALS_MAX = 2 (task.ts:106).
- Add sets access edit and starts the spec run again (tasks.ts:2329-2332). It works only in spec_draft (tasks.ts:2328).
- A proposed row has access none until Add (tasks.ts:344-347).
- Read access exists only for submodules and for a repository that is in the task a second time (repos.ts:574-585).
- The edit-only filters are in these places:
  - pre-flight (preflight.ts:62)
  - push (pr.ts:552)
  - changed repositories and the line budget (loop.ts:503)
  - the update (repos.ts:401)
  - project instructions (implement.ts:722)
  - the added worktree (worktree.ts:445)
  - the base picker (tasks.ts:2243)
- The path check locks a change in a repository with access read or none, and the step resets (implement.ts:205-243, 256).
- A read submodule worktree is detached (worktree.ts:483). A detached worktree gets no branch (worktree.ts:249, 275-282). A reset takes pinned for a row without edit (worktree.ts:529).
- context/repos.md is written only for implement steps (implement.ts:755). Interview and spec runs never get it (tasks.ts:1306, 1411-1457). Their prompts name only ./repo (prompt.ts:258-313).
- The update stores the head, base_commit, and pinned of each worktree (update.ts:415-427). Its restore writes base_commit and pinned back (loop.ts:1847).
- A submodule without task commits follows the gitlink of its parent, for any parent row with a worktree (update.ts:431-467).
- The Build form lists the REPO_WRITE repositories once per open, with 5 minutes stale time. It filters them in the browser (routes.ts:227-231, data.ts:120-126, model.ts:884-898).
- provider.readableRepos exists (provider.ts:368-371). Both repository lists stop at REPO_LIST_MAX = 1,000, in pages of 100 (provider.ts:288-299).
- An implement result has two stop signals today: question (loop.ts:695-710) and needsBase (task.ts:667-668, loop.ts:712). The answer of an instruct question sends the text again (loop.ts:2121-2144).
- Each task repository gives its .claude/skills to the steps (jobs.ts:1097-1109, spec 6.19.2).
- A large plan blocks when any added row exists, also one that only reads (plan.ts:50).
- blocked_json has no SQL CHECK (033_task.sql:21). zod parses it (task.ts:300-325).

### 1.2 Submodules today

- **The walk.** resolveTaskRepos reads the gitlinks of the fetched main head (repos.ts:508) and walks them recursively (repos.ts:530-617, the recursion at 614). Nested levels are filled. No depth cap exists.
- **Why it ends.** A repository that is already in the task is not walked again (repos.ts:574-579, 613-614).
- **Access.** A first-level submodule with REPO_WRITE gets edit, else read. A deeper one gets read (repos.ts:583-585).
- **Snapshots.** Interview and spec get each mapped row with a cache at its pinned gitlink commit. Each one is a sanitized detached worktree (repos.ts:659-663, workspace.ts:656-672).
- **Implement steps.** openRepoTrees adds a worktree at the gitlink path for each row with access edit or read and a parent worktree (worktree.ts:464-485). Edit is on the task branch; read is detached.
- **Empty folders (access none).** These cases give one, with the REPO_REASON texts (task.ts:123-130):
  - .gitmodules of that commit names no URL for the path: noMatch (repos.ts:549).
  - The URL has another host: otherServer (repos.ts:552-554).
  - The URL gives no candidate key or no clone-link match, also for a repository that the token cannot see: noMatch (repos.ts:557-572).
  - No branch holds the pinned commit: noBranch (repos.ts:607-610).
- **A 403 fails the run.** A ForgeError other than not_found on one submodule GET, such as a 403, fails the whole interview or spec run (repos.ts:564).
- **What Claude sees for access none.** An empty folder at the gitlink path.
  - Interview and spec get no reason, because they get no context/repos.md.
  - Implement steps get the row with access none and its reason (repos.ts:670-678). A change there fails the step (worktree.ts:503-508, implement.ts:210-215).
- **Added repositories.** An added repository (proposal added) is fetched at its base head (repos.ts:619-630). It is placed at repos/<project>/<slug> (repos.ts:664, worktree.ts:443-462).
  - Its gitlinks are never read, so it has no submodule rows.
  - Its submodule folders stay empty, and no path check covers them.

### 1.3 Gaps found on the way

- **Unique-index error.** A new main gitlink that names an added repository gives a submodule row with the same project and slug. The unique index task_repo_one (035:15) then fails the resolve. WP-AR1 fixes it.
- **Add to plan after approval.** "Add to plan" (spec 6.20.14) runs resolveTaskRepos after the approval (tasks.ts:1416). dropSubs then deletes the submodule rows, and their task_pr rows go by cascade (035:19). It also moves base_commit of added Edit rows (repos.ts:633). Not tested. See open question Q6.
- **Gitlinks that the update adds or removes.** They keep their old rows, because followGitlinks moves only existing rows (update.ts:439-465). The design leaves this out for main and Edit repositories.

## 2. User decisions (final, 2026-11-03)

1. **The picker.** The user can add a repository from a picker over every repository that the token can read on the same server. The user picks a branch and an access: Read, or Edit only when the token can write.
2. **When Read and Edit can join.** A Read repository can join at any time, also after the approval and during the build. The next step gets it with no new plan. An Edit repository writes the plan again, as today.
3. **Claude can propose Read repositories.** Its list holds every readable repository and marks the ones that it can push to. A proposal carries access read or edit and a reason.
4. **A step can ask for a repository.** The interview, spec, implement, fix, resolve, and repair steps can stop with a needs-repo result for read access. The UI shows "Add (read)", and the step runs again.
5. **The pin and the update.** A Read repository stays at its commit from the add. "Update from <base>" moves it to the newest base head: fetch and move the pin. It does no merge, has no conflicts, and pushes nothing.
6. **Submodules of added repositories.** Every added repository, Read and Edit, gets its submodules filled by the rules of the main repository. A submodule of a Read repository is always read.

## 3. Design decisions with reasons

- **D1. A Read repository is a task_repo row** with role added, proposal added, and access read. No new table or column is needed, because the CHECKs allow it (035:3-15), and every write path already filters access edit (section 1.1).
- **D2. Two columns track a Read row.** base_commit holds the pin. pinned holds the commit at which the app last walked its submodules. A difference makes the next Claude step walk again.
  - Reason: one column cannot tell "the pin moved" from "the folder holds the pin".
- **D3. Read-only for Claude.** Each step type gets this protection:
  - Interview, spec, and repair runs read a sanitized snapshot that the run deletes after it ends. These runs have no Edit or Write tool.
  - Implement steps get a detached worktree with the sparse patterns. The path check fails and resets a step that changes it (implement.ts:233-240). This mechanism already protects read submodules (AC-B35).
  - No deny rules in the settings. They need a new gate for the path forms of permission rules on Windows.
  - No copy per step. A copy costs one checkout per step and protects no better than the reset.
- **D4. A Read repository belongs to the task, not to a part.** task_repo has no part column, and openRepoTrees serves each part folder from the task rows (worktree.ts:428-488).
- **D5. The spec run asks through a proposal with access read.** A spec result must hold a whole plan (task.ts:585-648), so it cannot stop early. "Add (read)" of the proposal writes the plan again, as Add does today. The interview and implement results get needsRepo.
- **D6. The update moves the pin only.** The next Claude step rebuilds the folder. The checks run in repo/ only, so they never need the Read folder.
- **D7. A proposed row keeps Claude's access in access** (read or edit). An old proposal with access none counts as edit.
- **D8. Remove sets proposal skipped.** The existing skip list then keeps Claude from asking again (plan.ts:72, 95).

## 4. Spec text: section 6.24 Add a repository (user decisions of 2026-11-03)

Constants: ADDED_REPOS_MAX = 10 added repositories per task, Edit and Read together. One needsRepo per step result. REPO_LIST_MAX and PROPOSALS_MAX do not change.

### 6.24.1 Rows

| Row | role | access | proposal | base_branch | base_commit | pinned |
|---|---|---|---|---|---|---|
| Read, added | added | read | added | the pick | the pin | the commit of the last submodule walk; NULL before the first walk |
| Edit, added | added | edit | added | the pick | the base head of the last spec run | NULL |
| Proposal, or request of a step | added | Claude's access (read or edit) | proposed | NULL | NULL | NULL |
| Skipped or removed | added | none | skipped | NULL | NULL | NULL |
| Submodule of an added repository | submodule | the rules of 6.16.5; always read under a Read parent | NULL | its base | the gitlink | the gitlink |

- **The pin.** A Read pick gets the base head that `git ls-remote --heads` gives at the Add (remoteBranches). A Read proposal gets the head of the next spec run.
- **What moves it.** Only "Update from <base>" moves the pin. A spec run, "Write the plan again", and an interview round keep it.
- **DTOs.**
  - task.blocked adds kind "repo" and the optional field repo (a task_repo id).
  - TaskRepoDto adds commit (base_commit, else pinned).
  - TaskBaseDto adds read (boolean).
- **No migration.** blocked_json is JSON, and the CHECKs of 035 allow role added with access read.

### 6.24.2 The picker

- **The list.** GET /api/tasks/repos?access=read gives the REPO_READ list (readableRepos). Each item carries write true when the REPO_WRITE list (writableRepos) holds it. Both lists stop at REPO_LIST_MAX.
- **No server cache.** The browser keeps the list for 5 minutes, as the Build form does.
- **Search.** The dialog filters in the browser (repoMatches, REPOS_SHOWN = 50).
- **A repository off the list.** A typed PROJECT/slug that the list does not hold is allowed. The server checks it with one repository GET.
- **A cut list.** The note says: "The list stops after 1,000 repositories. Type PROJECT/slug to add another one."

### 6.24.3 Add

POST /api/tasks/:id/repos `{version, project, repo, access: "read" | "edit", branch}`.

| State | Read | Edit |
|---|---|---|
| interview | 200. No run starts. | 200. No run starts. The spec run takes it. |
| spec_draft | 200. The plan stays. | 202. The plan goes, and the spec run starts, as Add of a proposal. |
| implementing, ready, stopped | 200. The next Claude step gets it. | 409 "A repository joins with Edit only before the plan approval." |
| done, failed, closed | 409 "The task is closed." | 409 "The task is closed." |

- **Checks, in this order.**
  - The version.
  - The state.
  - ADDED_REPOS_MAX: "A task holds at most 10 added repositories. Remove one first."
  - Already in the task as main, a mapped submodule, or an added row: "PROJ/lib is already in the task at <path>."
  - The repository GET. A 404, 401, or 403 gives "Your token cannot read PROJ/lib, or it does not exist."
  - Edit only: canWrite. A miss gives "Your token cannot push to PROJ/lib. Add it with access Read."
  - The branch with remoteBranches: "<branch> does not exist in PROJ/lib."
  - Edit in spec_draft only: the run slot.
- **An earlier row of the same repository.** A proposed or skipped row changes in place, so the unique index holds.
- **No fetch.** The next step fetches.
- **No Bitbucket write.** The Add sends GET requests and `git ls-remote` only.

### 6.24.4 Remove

- **The route.** POST /api/tasks/:id/repos/:taskRepo `{version, add: false}` on an added row. On a proposed row it stays Skip.
- **Read.** Remove works in each open state while no Claude step, check, or update of the task runs. Otherwise the route answers 409 "Claude is still working on this task. Wait for the step to end."
- **Edit.** Remove works only in interview and spec_draft. In spec_draft, the plan goes and the spec run starts again. Otherwise the route answers 409 "PROJ/lib has the task branch. A repository with Edit leaves only before the plan approval."
- **A shared repository.** Another row can use this repository as its source. The route then answers 409 "PROJ/lib is also the submodule sub/lib. It stays in the task."
- **Effect.** The row gets proposal skipped and access none, and its base fields become NULL. Its submodule rows go. The next step deletes its folder from each part folder (6.24.5, sweep).

### 6.24.5 Fetch, snapshots, and worktrees

- **Snapshots.** The interview, the spec run, and the repair run (when WPQ lands) read a Read repository at repos/<project>/<slug> at its pin. The folder is sanitized and detached, with its submodules at their gitlinks.
- **Fetch.** The app fetches only when the cache lacks the pin: the base branch first, then all heads (fetchPinned).
  - The ref refs/rl/task/<id>/pin/<sha> keeps the pin from gc.
  - When no branch holds the pin, the row gets access none and REPO_REASON.noBranch.
- **Implement steps.** The tests, implement, fix, instruct, and resolve steps get a detached worktree at part-<n>/repos/<project>/<slug> at the pin. Its cache gets no branch. The sparse patterns and the git settings of 6.8 apply.
- **Rebuild.** Before each Claude step, in loop context():
  1. A Read row with pinned different from base_commit walks its submodules again at the pin and sets pinned. One walk per task runs at a time (a task lock).
  2. A Read worktree whose HEAD differs from the pin goes with its submodule worktrees. The app adds it again at the pin.
- **Sweep.** Before each step, the app deletes each folder under part-<n>/repos/ that no added row with a worktree names. It prunes the worktree entries of the caches. An empty project folder goes too.
- **Reset.** After a failed step, a Read worktree goes back to its pin.

### 6.24.6 Submodules of added repositories

- **The walk.** After the main walk, resolveTaskRepos walks each added row in id order. The rules are those of 6.16.5: same server only, the mapping without guesses, and the pinned gitlink commit.
- **Depth.** Depth starts at 1 under the added row.
- **Access.**
  - Under an Edit row, a first level with REPO_WRITE gets edit, else read.
  - Under a Read row, each submodule gets read with the reason "It is a submodule of a repository with access read." (REPO_REASON.readParent).
- **The same repository twice.** seen starts with the main repository and every added row. The first row keeps the repository. A later row becomes read with REPO_REASON.twice(<path>) and source.
- **Order.** Main and its submodules come first, then each added row followed by its submodules. The snapshot uses the same order, so each parent comes before its children.
- **Path.** fullPath of a submodule under an added row starts with ../repos/<project>/<slug>/.
- **Errors.** A 403 on one submodule GET counts as not found: access none, noMatch. A 401 still fails the run.
- **Depth cap.** None. Each repository is walked once, so the number of distinct repositories bounds the walk.
- **Edit submodules.** An Edit submodule of an Edit added row gets the task branch and its own PR, as in 6.16.6 and 6.16.8. Its parent is the added row.
- **Update.** followGitlinks moves each submodule without commits to the gitlink of its parent, also under an added parent. Under a Read row, the rebuild of 6.24.5 walks again at the new pin.
- **Cost.**
  - Each distinct repository gets one bare cache, which all tasks share.
  - The first fetch takes the history of the branch. Later fetches add only the new commits.
  - A pin that is not on the base branch fetches all heads once.
  - Each part folder holds one sparse checkout per repository with access edit or read.
  - Each interview and spec run makes a temporary checkout of each one and deletes it after the run.

### 6.24.7 Proposals (spec run and repair run)

- **The list.** context/repo-list.md lists the REPO_READ repositories as "- PROJ/slug · name". It adds " · push" for a REPO_WRITE one. The "Skipped by the user" section stays.
- **The schema.** specResult.repos items add `access: z.enum(["read", "edit"]).default("edit")`.
- **checkProposals.**
  - Access edit needs the push mark. Without it, the proposal is dropped with "Claude proposed PROJ/lib with Edit, but the token cannot push to it, so the plan leaves it out."
  - Access read needs the list.
- **A kept proposal.** It gets proposal proposed, and access holds Claude's access.
- **The plan screen.**
  - Read: "Claude proposes another repository to read: PROJ/lib. <reason>" with "Add (read)" and "Skip".
  - Edit: the current text, with "Add" and "Skip".
- **Add.** Both kinds write the plan again with the repository. A Read proposal gets the pin of that spec run.
- **The new prompt lines.** They replace catalog.ts:1030. The line at catalog.ts:1034 stays.
  - "./context/repo-list.md lists the repositories that the token can read. "push" marks the ones it can push to."
  - "Name one in repos only when the plan needs it. Set access edit only when the task must change its code."
  - "Set access read when the plan only needs to read its code. Say why in reason."

### 6.24.8 Steps that ask for a repository (needsRepo)

**Schema and prompts**

- interviewResult and implementResult add `needsRepo: {project: string ≤ 100, repo: string ≤ 100, reason: string ≤ 300} | null`, default null. The spec run asks through 6.24.7.
- The interview gets context/repo-list.md and context/repos.md. Implement steps get context/repos.md.
- The prompt lines for the interview and each implement mode:
  - "When this step needs code of a repository that ./context/repos.md does not list, set needsRepo to its PROJECT/slug."
  - "Say why in reason. Then change no file, and stop."
  - "Never ask for a repository under "Not available"."

**What the app does with the result**

The app checks needsRepo after the path check and the spec change, before the question.

1. **A request that the app can serve.** That is a valid name (NAME, repos.ts:28), not in the task, not skipped, and under ADDED_REPOS_MAX.
   - The app writes a proposed row with access read and Claude's reason.
   - It sets blocked `{kind: "repo", step, repo, text}`.
   - A changed file stays until the continuation resets it with a patch.
2. **A request that the app cannot serve.**
   - In a build step, it sets blocked `{kind: "repo", step, text}` with the sentence and no repo.
   - The interview adds a coverage line and handles the rest of its result.
3. **A resolve step.**
   - The update aborts with the reason "Claude needs to read PROJ/lib: <reason>".
   - blocked kind update gets repo when the app can serve the request.

**Status sentences**

| Case | Status | Primary | More |
|---|---|---|---|
| A build step | "Needs you: Claude needs to read PROJ/lib: <reason>" | "Add PROJ/lib (read)" | Skip it, Stop |
| The interview | "Claude needs to read PROJ/lib before it asks its questions: <reason>" | "Add PROJ/lib (read)" | Skip it, Stop |
| Already in the task | "Needs you: Claude asks for PROJ/lib, which the task already has." | Resume | Stop |
| Skipped by the user | "Needs you: Claude asks for PROJ/lib, which you skipped." | Resume | Stop |
| At the cap | "Needs you: Claude asks for PROJ/lib, but the task holds 10 added repositories." | Resume | Stop |
| An invalid name | "Needs you: Claude asks for a repository with an invalid name." | Resume | Stop |
| The update | "The update from develop stopped: Claude needs to read PROJ/lib: <reason>. The branch is as it was." | "Add PROJ/lib (read)" | Try again, Go to the PR |

**The continuation**

- Add sends POST /api/tasks/:id/repos/:taskRepo with add true. "Skip it" sends add false. Both act on the row of blocked.repo, and both continue the step that asked:
  - The interview: the same round runs again.
  - Tests, implement, and fix: the build goes on from the last commit, as Resume does, with the patch of the discarded changes.
  - Instruct: a new instruct step sends the same text, as the answer of a question does (loop.ts:2121-2144).
  - Resolve: the update starts again.
- **An unreadable repository.** Add checks the repository with one GET. A 404, 401, or 403 gives 409 "Your token cannot read PROJ/lib, or it does not exist." The request stays, and Skip still works.
- **Skip.** The repository goes under "Not available" in context/repos.md of the next step.
- **The loop bound.** Each result holds one request. Each new name needs a user click. A repeat of a known name blocks with Resume only.

### 6.24.9 context/repos.md and prompt lines

- **Which steps get it.** The interview, the spec run, and each implement step, when the task has more than one repository or a skipped one.
- **The header.**
  - "# Repositories of the task"
  - "Only a repository with access edit may change."
  - "A repository with access read stays at its commit. Paths start at ./repo."
- **A Read row.** "- ../repos/PROJ/lib: PROJ/lib · access read · base develop at 1a2b3c4d5e6f"
- **Not available.** The section "## Not available" lists each skipped row as "- PROJ/tools · skipped by the user".
- **Interview and spec.** They add the Tools line "- ./context/repos.md lists the repositories of the task and their folders."
- **Implement.** The lines at implement.ts:359-373 already name ./repos and access edit. They add only the needsRepo lines.

### 6.24.10 Own review, push, and PR

- **Nothing is written to a Read repository.** It never gets a branch, a commit, a push, a task_pr row, an own review, or a PR row. The edit filters of section 1.1 hold.
- **The large-task rule.** It counts only added rows with access edit (plan.ts:50).
- **Skills.** A Read repository gives its skills as every task repository does (6.19.2).

### 6.24.11 Update from the base branch

- **Base check (6.18.5).**
  - Each Read row of the part gets checkBase with baseCommit and head set to the pin.
  - TaskDto.bases gives the row with read true.
  - A failed read of one Read row writes a log line and skips that row only.
- **Update step 2.** The update fetches each Read base. A Read row moved when the fetched head is no ancestor of the pin.
- **Update step 5.** It writes base_commit = the new head. No rebase, merge, conflict, or push runs in a Read repository.
- **When the update runs.** It runs when an Edit base moved, a PR has conflicts, or a Read base moved. The 409 "<base> has no new commits." counts Read rows too.
- **Restore.** An abort in the checks and "Undo the update" set base_commit back and set pinned to NULL. The next step then walks and rebuilds at the old pin.
- **All or nothing.** A failed Read fetch aborts the update with "the app cannot fetch PROJ/lib (read): <reason>".
- **UI.**
  - A Read row adds the line "PROJ/lib (read) from develop · 3 new commits".
  - It counts for the label "Update from <base>".
  - It never holds the PR dialog or sets the primary button.
  - A move of Read repositories alone adds "Update from <base>" to More.

### 6.24.12 Sub-task tasks

- **One pin per task.** A Read row belongs to the task. Each part folder gets it at the task pin.
- **An update in one part.** The update of one part moves the task pin. Each other part rebuilds its folder before its next Claude step. A step that runs keeps its folder.

### 6.24.13 UI

- **Repositories section.** The Plan tab shows it in each open state: interview, spec_draft, implementing, ready, and stopped. "Add a repository" is its last row.
- **Read row.** "PROJ/lib · Added · Read · develop at 1a2b3c4" with "Remove". Remove needs no confirm, because Add brings the repository back.
- **The dialog.**
  - Title: "Add a repository".
  - "Repository" combobox (RepoField). The tag "can push" marks write.
  - "Access" radio group.
    - "Read": "Claude reads its code. The task never changes it, pushes it, or opens a PR in it."
    - "Edit": "The task branch and a PR go to it. Adding it writes the plan again."
  - "Edit" is disabled with "Your token cannot push to PROJ/lib." or "A repository joins with Edit only before the plan approval."
  - "Base branch" (BaseField), with the hint "Claude reads the newest commit of this branch now. Update from <base> moves it later."
  - Primary button: "Add PROJ/lib", or "Add and write the plan again" for Edit in spec_draft. Secondary: "Cancel".
- **Status rows and base lines.** As in 6.24.8 and 6.24.11.
- **Plan approval.** The POST /plan bases never name a Read row.

### 6.24.14 Notifications

- **The wait.** blocked kind repo is a needs_you wait, with the row text "Needs you: add a repository" (task-status.ts NEEDS).
- **The interview row.** An interview with blocked kind repo shows that text, not "answer the questions" (task-status.ts:28).
- **No other notifications.** Add and Remove send none.

### 6.24.15 Edge cases

- **The repository is deleted, or the token loses access, after the Add.**
  - The pin in the cache keeps the steps working.
  - The base check skips the row, and the update aborts with the fetch sentence. Remove ends it.
  - Before the first fetch, the step blocks with "Needs you: the app cannot fetch PROJ/lib: <reason>" and Resume.
- **The base branch of a Read repository is deleted.** Same as above. Pre-flight checks Edit rows only, so it does not block.
- **A very large repository.** The first step after the Add fetches the history of the branch. Stop ends the fetch through the LongGit signal.
- **The same repository twice.** Add refuses a repository that is in the task. A proposed or skipped row changes in place.
- **A submodule that is also added.**
  - Add refuses a repository that is a submodule.
  - A later main gitlink that names an added repository becomes a read duplicate of it. Remove of that repository then answers 409.
- **A task started before migration 035.** taskRepos gives the main row from the task (repos.ts:190-215). A Read Add after the approval works.
- **A task made before this change.** A proposed row with access none counts as edit. No data changes.
- **Two parts at once.** The row walk takes the task lock. A running step keeps its folder.
- **A request deleted by a later spec run** (dropProposals). Add answers 404 "Repository not found." Resume runs the step again.
- **The same slug in two projects.** The folders differ: repos/<project>/<slug>.
- **Path length.** The path repos/<project>/<slug>/<submodule path> is longer. The Windows path limit of 6.16.2 applies.

### 6.24.16 Acceptance criteria

1. AC-B116. GET /api/tasks/repos?access=read gives each REPO_READ repository over two pages. write is true only for REPO_WRITE repositories. complete is false past 1,000 (add-repo.test.ts).
2. AC-B117. A Read Add in interview, spec_draft, implementing, ready, and stopped makes a row added with access read. Its base_commit is the ls-remote head. No Claude run starts (fake CLI counter). A typed PROJECT/slug outside the list needs one repository GET.
3. AC-B118. Add refuses each of these with its sentence:
   - a repository that is already in the task
   - a 404 or 403 repository
   - Edit without REPO_WRITE
   - Edit after the approval
   - a missing branch
   - the eleventh added repository
   - a stale version

   A proposed or skipped row of the same repository changes in place.
4. AC-B119. Edit in spec_draft drops the plan and starts the spec run (202). Edit in interview starts no run, and the next spec snapshot holds it.
5. AC-B120. The interview and spec snapshots hold a Read repository at repos/<project>/<slug> at its pin, sanitized. context/repos.md lists it with access read and the pin. A spec run after a base move keeps the pin.
6. AC-B121. An implement step gets a detached worktree of the Read repository at its pin. Its cache gets no branch (git argv spy). A step that edits it fails, resets each repository, writes the patch, and blocks with denied_path.
7. AC-B122. A Read repository gets no commit, push, task_pr row, own review, or PR row. A large plan with only a Read repository added does not block.
8. AC-B123. An added repository with a same-server gitlink, a nested gitlink, and another-server gitlink gets submodule rows by the 6.16.5 table. Under a Read parent, each one is read. A change in the other-server folder fails the step.
9. AC-B124. A main gitlink that names an added repository becomes a read duplicate with source, and no unique-index error occurs. Two added repositories with one shared submodule give one owner and one duplicate. A 403 on one submodule GET gives access none, and the run goes on.
10. AC-B125. The base check counts the new commits of a Read base, and TaskDto.bases gives the row with read true. The update moves only the pin (no rebase, merge, or push argv). The next Claude step rebuilds the folder and its submodules at the new head.
11. AC-B126. A Read-only move adds "Update from <base>" to More. It does not change the primary button and does not hold the PR dialog. The update then runs and does not answer "has no new commits".
12. AC-B127. "Undo the update" and an abort in its checks restore the old pin and set pinned to NULL. The next step rebuilds the folder at the old pin.
13. AC-B128. A read proposal that repo-list.md lists is kept. An edit proposal needs the push mark, or it is dropped with its coverage line. "Add (read)" writes the plan again with the repository. repo-list.md marks the push repositories.
14. AC-B129. A needsRepo result of a tests, implement, or fix step blocks with kind repo and "Add PROJ/lib (read)". Add runs the same step again from the last commit (fake CLI counter +1). Skip runs it again with PROJ/lib under "Not available".
15. AC-B130. An instruct step with needsRepo sends its text again after Add. A resolve step with needsRepo aborts the update, and Add starts the update again.
16. AC-B131. An interview result with needsRepo stores no question and keeps the task in interview with the repo reason. Add runs the same round again. An interview request that the app cannot serve adds a coverage line, and the round goes on.
17. AC-B132. A build request that the app cannot serve blocks with its sentence and Resume only: a repository in the task, a skipped one, an invalid name, or one past the cap. Add of an unreadable request answers 409 and keeps the request.
18. AC-B133. Remove of a Read repository works in each open state while no step runs, else 409. The next step deletes its folder and passes the path check. Remove of an Edit repository after the approval answers 409. Remove of a repository that a duplicate uses answers 409.
19. AC-B134. A task without task_repo rows (made before migration 035) takes a Read repository after the approval and builds with it.
20. AC-B135. UI e2e (task-add-repo.e2e.ts) covers these:
    - the dialog search
    - Edit disabled with its hint
    - the Read row with Remove
    - the needs-repo row with "Add PROJ/lib (read)"
    - one notification for the needs-repo wait

### Edits to other sections

- 6.5: the three schema changes.
- 6.12: the new rows.
- 6.16.5: remove "or an added repository" from the edit row of the access table. Add the rows of 6.24.1.
- 6.16.9: a note that the CHECKs already allow Read.
- 6.18.3 and 6.18.5: the Read rows.
- 8 (Migrations): "No migration".
- 9: the two routes.
- 10: the BRIEF lines.

BRIEF.md line 91 changes from "Claude can propose another repository, and I add or skip it." to these sentences:

- "I can add any repository that my token can read, with Read or Edit access."
- "Claude can propose one, or ask for one in a step."
- "A Read repository is never changed, pushed, or opened as a PR."

BRIEF.md line 562 adds "access read for role added; access holds Claude's access while proposed".

## 5. Invariants the plan relies on

- **I1. Read needs no migration.** Role added with access read passes the CHECKs (035_task_repos.sql:3-15).
- **I2. Writes filter access edit.** Push, PR, update, line count, pre-flight, project instructions, and the added worktree all do (preflight.ts:62, pr.ts:552, loop.ts:503, repos.ts:401, implement.ts:722, worktree.ts:445).
- **I3. A change to a read tree resets the step.** The path check locks a change in a tree without edit (implement.ts:233-240). undoTrees resets every repository (implement.ts:256).
- **I4. A detached worktree gets no branch** (worktree.ts:249, 275-282).
- **I5. Folders under repos/ are allowed.** The snapshot accepts them (workspace.ts:659-669). outsideRepo skips the added folders (worktree.ts:494-495, implement.ts:108).
- **I6. The update can restore Read rows.** headsOf stores base_commit and pinned of each worktree row, and restoreUpdate writes them back (update.ts:415-427, loop.ts:1847).
- **I7. followGitlinks accepts any parent row with a worktree** (update.ts:439-465).
- **I8. A skip keeps Claude from asking again.** A proposed or skipped row is no task repository (repos.ts:169-170). The skip list reaches repo-list.md (tasks.ts:1421-1429, plan.ts:72).
- **I9. Claude never reads a local folder (BRIEF 3.5 holds).** Each fetch uses the http clone link of the configured server (workspace.ts:509-535, provider.ts:340-344).
- **I10. The CLI already accepts the needsRepo form.** It has the nullable-object form of question (task.ts:656-664).
- **I11. A new blocked kind needs no migration.** blocked_json has no SQL CHECK (033_task.sql:21).

## 6. Work packages (wave WAR; one implementer at a time; file-disjoint)

### WP-AR-D. Docs (implementer)

- Files: docs/plans/review-v2/spec.md (section 6.24 and the edits listed above), docs/plans/review-v2/tasks.md (wave WAR), BRIEF.md (lines 91 and 562), CLAUDE.md (status line), docs/smoke-task.md (part AR).
- Tests: none.
- Done check:
  - no real names
  - every sentence has 20 words or fewer
  - no hard wraps

### WP-AR0. Contracts (implementer)

- Files: src/shared/task.ts, src/shared/dto.ts, src/shared/task-status.ts, tests/shared/*.
- src/shared/task.ts:
  - BLOCKED_KINDS gets "repo"; taskBlocked gets repo.
  - REPO_REASON gets readParent. Add ADDED_REPOS_MAX.
  - interviewResult and implementResult get needsRepo.
  - specResult.repos gets access.
- src/shared/dto.ts: taskRepoListQuery, taskRepoAddInput (repoName, branchName, version), TaskRepoListDto.write, TaskRepoDto.commit, TaskBaseDto.read.
- src/shared/task-status.ts: NEEDS.repo and the interview text.
- Behavior: the schemas of 6.24.7 and 6.24.8. Old JSON parses: access defaults to edit, and needsRepo to null.
- Tests:
  - the zod defaults
  - the JSON schemas still pass the existing gate fixtures
  - rowStatus for kind repo in interview and in implementing
- Control mutation: make needsRepo required. The parse test of an old result must fail.
- Risk: the size of the JSON schema that the CLI gets. The new field is small.

### WP-AR1. Repository library (implementer-xhigh)

- Files: src/server/tasks/repos.ts, src/server/tasks/worktree.ts, src/server/tasks/update.ts, src/server/review/workspace.ts (only if the snapshot order needs a change), tests/tasks/repos.test.ts, tests/tasks/worktree.test.ts, tests/tasks/read-repos.test.ts (new).
- repos.ts:
  - The walk serves any parent row. seen starts with every added row.
  - Add resolveAdded(row, commit) for one subtree.
  - Read rows: cache-first fetchPinned, and the pin is never moved.
  - A 403 on a submodule GET counts as not_found.
  - fullPath works under added parents.
  - reposFile gets the pin and "Not available".
  - Add readRepos() for the base check.
- worktree.ts:
  - openRepoTrees adds detached Read worktrees at base_commit.
  - The rebuild runs when HEAD differs from the pin.
  - The sweep of stray folders under repos/.
  - resetTrees uses base_commit for added Read rows.
- update.ts: checkBase takes a Read row.
- Behavior: 6.24.5 and 6.24.6. AC-B120 (library part), AC-B121, AC-B123, AC-B124, AC-B134.
- Tests (temp bare repositories with a gitlink, a nested gitlink, and an other-server gitlink under an added repository):
  - each row of the access table under an Edit parent and under a Read parent
  - the duplicate and shared-submodule cases without a unique error
  - a 403 submodule
  - an edit in a Read worktree locks and resets
  - the rebuild after a pin change
  - the sweep after Remove
  - no `git branch` argv for Read
- Control mutations:
  - give a submodule under a Read parent access edit (AC-B123 must fail)
  - drop the seed of seen (AC-B124 must fail)
- Risk: the snapshot order. Parents must come before children, or the parent `worktree add` fails on a folder that is not empty.
- Run: `bun test tests/tasks tests/review`; `bun run check`.
- Depends: WP-AR0.

### WP-AR2. Build loop (implementer-xhigh)

- Files: src/server/tasks/loop.ts, src/server/tasks/implement.ts, tests/support/fake-claude.ts (needsRepo scenarios), tests/tasks/update-fixture.ts (a Read fixture), tests/tasks/needs-repo.test.ts (new), tests/tasks/loop.test.ts, tests/tasks/implement.test.ts.
- loop.ts:
  - context() runs the row walk (task lock), the rebuild, and the sweep.
  - claude() handles needsRepo (6.24.8 order, the held(c) rule at loop.ts:688).
  - the resolve-step abort with repo
  - a continuation method used by the routes: reset and build, a new instruct step, or the update again
  - driveUpdate: Read moves in steps 2 and 5, and the "no new commits" rule
  - refreshBases: Read rows with a per-row catch
  - restoreUpdate: pinned set to NULL for Read rows
- implement.ts: the needsRepo prompt lines, and the reposFile arguments.
- Behavior: 6.24.8 (build part), 6.24.11, 6.24.12. AC-B125, AC-B127, AC-B129, AC-B130 (loop part), AC-B132 (loop part).
- Tests:
  - fake CLI needsRepo in the tests, implement, fix, instruct, and resolve modes
  - the continuation call counts
  - the update argv spy (no rebase or merge in Read)
  - Undo and abort restore
  - a two-part task: the second part rebuilds at its next step
- Control mutation: move the Read worktree inside the update. The AC-B127 rebuild test must fail.
- Risk: a race between parts. The walk replaces submodule rows, and a running part keeps the old in-memory rows until its next context().
- Run: `bun test tests/tasks`; `bun run check`.
- Depends: WP-AR1.

### WP-AR3. Service and routes (implementer-xhigh)

- Files: src/server/tasks/tasks.ts, src/server/tasks/routes.ts, src/server/tasks/plan.ts, src/server/review/catalog.ts, src/server/review/prompt.ts, tests/support/fake-bitbucket.ts, tests/tasks/add-repo.test.ts (new), tests/tasks/proposals.test.ts, tests/tasks/interview.test.ts, tests/tasks/bases.test.ts, tests/review/prompt tests.
- tasks.ts:
  - Add and Remove with the state table and the checks
  - repoChoice: any state with blocked.repo, and access from the row
  - interviewRun: repo-list.md and repos.md, and the needsRepo finish
  - specRun: repos.md
  - partBases: Read rows
  - repoDtos: commit
- routes.ts: GET /tasks/repos?access=read and POST /tasks/:id/repos.
- plan.ts: repoListFile with the push mark, checkProposals with access, and the large rule.
- catalog.ts and prompt.ts: the lines of 6.24.7 and 6.24.9.
- fake-bitbucket.ts: REPO_READ, which includes repositories without write, and 404 and 403 repositories.
- Behavior: 6.24.2, 6.24.3, 6.24.4, 6.24.7, 6.24.8 (interview part), 6.24.10. AC-B116 to AC-B119, AC-B120 (context part), AC-B122, AC-B126 (server part), AC-B128, AC-B130 (route part), AC-B131, AC-B132 (route part), AC-B133.
- Tests:
  - each 409 sentence
  - the state table
  - Add sends no Bitbucket write (fake server method counter)
  - an edit proposal without push is dropped
  - the interview round runs again after Add
- Control mutation: allow Edit after the approval. AC-B118 must fail.
- Risk: the interview resting state with blocked kind repo across a restart. recoverTasks is unverified for it.
- Run: `bun test tests/tasks tests/review`; `bun run check`.
- Depends: WP-AR2.

### WP-AR4. UI (implementer; skills shadcn, vercel-react-best-practices, web-design-guidelines)

- Files:
  - src/web/tasks/PlanTab.tsx (RepoSection in each open state, the Read row, Remove, "Add (read)" proposals)
  - src/web/tasks/AddRepoDialog.tsx (new)
  - src/web/tasks/RepoField.tsx (the "can push" tag)
  - src/web/tasks/model.ts (the kind repo rows, the update rows of 6.24.11, baseLines "(read)", a PR gate without Read rows)
  - src/web/tasks/TaskView.tsx, src/web/tasks/data.ts
  - tests/web/tasks-model.test.ts, tests/e2e/task-add-repo.e2e.ts (new), tests/e2e/serve.ts
  - scripts/demo.ts, scripts/screenshots.ts
  - README.md, CHANGELOG.md, docs/screenshots/*
- Behavior: 6.24.13, 6.24.14. AC-B126 (UI part), AC-B135.
- Tests: the model rows for each case of 6.24.8, and the e2e of AC-B135.
- Gates:
  - screenshots: the dialog, the Repositories section with a Read row, and the needs-repo row
  - a README update
  - the web-design-guidelines review
  - axe
- Run: `bun run test:e2e`; `bun run screenshots`; `bun run check`.
- Depends: WP-AR3.

### Gate UAR (user)

smoke-task.md part AR on test repositories:

1. Add a Read repository after the approval. A build step reads it.
2. Push the base of the Read repository, then run "Update from <base>".
3. Remove the Read repository.
4. Use an added repository with a same-server submodule.
5. Let a step ask for a repository with needsRepo, then click Add.

## 7. Open questions (recommended default first)

1. Q1. Is ADDED_REPOS_MAX = 10 right? Yes. It bounds fetch time and part-folder disk.
2. Q2. Should "Add (read)" of a spec proposal write the plan again? Yes (D5).
3. Q3. Should the interview ignore a request that the app cannot serve, with a coverage line? Yes. Its result is complete without the repository.
4. Q4. Should a Read repository give its skills (6.19.2)? Yes, as every task repository does.
5. Q5. Should a move of Read repositories alone show only a More item? Yes. A Read repository never changes the PR.
6. Q6. Add to plan after the approval (section 1.3): should resolveTaskRepos keep the stored rows and pins? Yes, in a separate fix package with its own test.
7. Q7. Should an Edit submodule of an Edit added repository get a branch and a PR? Yes, by decision 6. WP-AR1 tests it before WP-AR2 relies on it.
8. Q8. Should the pin be per task, not per part? Yes (D4, 6.24.12).

## 8. Unverified

- Whether Bitbucket answers 404 or 403 to a repository GET without read permission.
- Whether git leaves an empty folder for a gitlink without a worktree, and whether git status ignores files inside it.
- pointer.ts and the push order in pr.ts with an added parent row.
- Whether recoverTasks leaves an interview with blocked kind repo as it is.
- Whether the app checks of 6.22.2 (checkPlan with nested) handle map paths under ../repos.

## 9. Left out

- **The repository list.** No server search (`/repos?name=`) and no server cache of the list.
- **Read base and pin.** No base change for a Read repository (Remove and Add it again), and no pin per part.
- **Read-only enforcement.** No deny rules in the settings for Read folders (D3).
- **Fetch and walk.** No shallow or partial fetch, and no depth cap for submodules.
- **needsRepo scope.** No needsRepo for the plan check run or the own review. No Edit access through needsRepo, because a spec proposal covers Edit.
- **Changed gitlinks.** No new rows for gitlinks that the update adds or removes in main and Edit repositories.
- **Tools.** CodeGraph and the git MCP cover repo/ only. They do not cover Read repositories.
