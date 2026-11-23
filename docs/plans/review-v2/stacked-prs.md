# Stacked pull requests

Status: Designed 2026-11-20. WP-SK0, WP-SK1, and WP-SK2 are built. `STACK_READS` stays false until Gates G9, G12, and G20 pass. Builds in wave RP with submodule-prs.md (user decision of 2026-11-23, section 14). The user accepted the section 12 defaults on 2026-11-23. Joint Gate A ran on 2026-11-20, and prompt 2.9 ships "preexisting". The held "callers" run does not block this wave, because without "stack" K3 keeps all eval inputs the same. Work: packages WP-SK0 to WP-SK4, gates G20, SK-P, and SK-B. REVIEW_PROMPT_VERSION does not change until WP-SK4.

## 1. Request

- The user, 2026-11-20: "we should also allow read access to other PRs ... it looks like the model doesn't want to see other PRs while reviewing some of the stacked PR".
- User decision: the app reads the other PRs (app route), not an MCP server. Design now, build later, after the code review gate.

## 2. Facts

- pr-context.md lists other OPEN PRs of the same repository that change the same paths (context-files.ts:846-871, pr-context.ts:48-49 and 167-182). It reads stored rows only.
- Bitbucket reads of other PRs exist (pr-context.ts:184-227), but `PEER_READS` is false until Gates G9 and G12 pass (pr-context.ts:27-30). Both are NOT RUN (integration-check.md:401-402).
- Caps: `PEER_SECTION_BYTES` 6 KB, `PEER_PRS_SHOWN` 10, `PEER_PATHS_SHOWN` 10, `PEER_READ_MS` 15 s (context-files.ts:686-690). One deadline covers all reads of one build (pr-context.ts:139).
- `listOpenPullRequests(project, repo, branch)` adds `at=refs/heads/<branch>&direction=OUTGOING` (provider.ts:304-312). It has no INCOMING form. The createPullRequest fallback uses it (provider.ts:438).
- integration-check.md has no fact on `at` or `direction`. G9 does not cover the filter. The fake Bitbucket supports both (tests/support/fake-bitbucket.ts:268-272).
- The default branch read is verified (Gate G13, integration-check.md:403, provider.ts:384-388).
- The PR schema holds `fromRef.repository`, the fork for a PR from a fork (schemas.ts:13-19). `toPr` drops it (provider.ts:244-265, src/shared/types.ts:17-41).
- The `pull_request` table has `source_branch` and `target_branch` (001_m1.sql:19-20).
- The workspace fetches `refs/pull-requests/<id>/from` to `refs/rl/<id>/source` and the target ref to `refs/rl/<id>/target` (workspace.ts:259-262). It pins both heads (workspace.ts:359-366).
- BASE is `merge-base(target, source)` (workspace.ts:367, diff.ts:115). In a stack, TARGET is the parent's source head. So the parent change is below BASE, and ./repo shows it as plain code.
- rl-git accepts a hex hash or HEAD, BASE, TARGET with ~N and ^N steps (git-mcp.ts:19-21). Its describe text names the three aliases (git-mcp.ts:46-54).
- rl-git `resolve` accepts a commit only in the history of HEAD, BASE, or TARGET (git-mcp.ts:134-148). Four call sites build its arguments. Three take the review workspace (jobs.ts:1119, 1819, 1999). The task implement step builds its own (jobs.ts:1897).
- `pruneRefs` deletes `refs/rl/<id>/*` only for stored PRs that are merged or declined (clone.ts:288-310).
- No prompt names a stack, a parent, or TARGET as a concept. The finder rule says "BASE..HEAD is the change" (catalog.ts:632). The peer line is catalog.ts:501.
- `PREEXISTING_LINES` lets the finder report a problem "at BASE without the change" (catalog.ts:570-579). Parent code exists at BASE.
- The verify refute rule includes "the problem is not in the change" (catalog.ts:1682).
- Prompt lines depend on `RunFiles` flags, as the notes line does (catalog.ts:492 and 504).
- `prContext()` builds pr-context.md for every run kind except Explain (jobs.ts:600-623). It reads no variant.
- The eval harness has no Bitbucket (scripts/eval/run.ts:104-105). Its remote is fixed to `refs/heads/main` (run.ts:708-714 and 722). So a stack can never appear in a local case.
- "stack" changes the finder, so it cannot join `VERIFY_ONLY` (run.ts:288). No cheap replay exists.
- WP-JC5 (branch jc5) adds "## Other pull requests that name these tasks" at the end of task.md (jc5:src/server/context/task-file.ts:330). It joins stored rows by task key. So it misses a parent without a shared key.
- REVIEW_PROMPT_VERSION is "2.9" (src/shared/review.ts:27). WP-RC3 raised it. `promptVersion` appends the variant names (catalog.ts:246).
- BRIEF 3.5 (line 153): the app builds pr-context.md before each run with no memory between runs. BRIEF 3.6 (line 180) lists each read of the PR context.

## 3. Options

| | A. MCP server that reads Bitbucket | B. App reads, context section, git alias (chosen) | C. Prompt line only |
|---|---|---|---|
| What | The claude child calls a new MCP tool for other PRs. | The app finds the stack at run start, writes its facts, and fetches the parent base. rl-git gets one alias. | A line tells the model to look at other PRs. |
| Hard rules | Breaks two: the token reaches the child, and a Bitbucket call leaves src/server/bitbucket/. | Keeps all. Reads stay in the app. The token stays in the app fetch. | Keeps all. |
| Value | High, but the model picks what to read. | High for the parent. The model gets the exact parent range. | None. The model has no data and no tool for it. |

Pick B. The user chose the app route.

## 4. Decisions

| ID | Decision | Reason |
|---|---|---|
| K1 | The app reads Bitbucket and git. No MCP server calls Bitbucket. | User decision. Token and call rules of BRIEF 3.5, 3.6, and CLAUDE.md. |
| K2 | Ship as the opt-in variant "stack". Without it, the app reads nothing new. | Any prompt change needs a version step. The variant keeps 2.9 bytes for everyone else. |
| K3 | With "stack" on and no stack found, prompts, context, and rl-git arguments stay byte-identical. | The natural eval set then needs no new run. A snapshot test proves it. |
| K4 | v1 covers review runs only: first review and re-review. | Smallest test surface. Ask, reply, fix, discuss, Explain, and task runs wait (question 5). |
| K5 | Parent: an OPEN PR whose source branch is this PR's target branch. Children: OPEN PRs whose target branch is this PR's source branch. | The definition of a stack in Bitbucket terms. |
| K6 | The default branch never links a stack. | An open PR from main into a release branch would look like the parent of every PR into main. G13 verifies the read. |
| K7 | No branch name pattern decides anything. The branch model waits for question 1. | A name match is a heuristic. |
| K8 | Same repository: the parent must have both refs in this repository. A PR from a fork gets no children search. A child from a fork is listed. | The fetch uses this repository. A fork source branch can share a name with a branch here. |
| K9 | Walk up to 3 PRs up. Look one level down, and show at most 3 children. | Each level costs up to 3 reads. Child code is not available, so deeper children add little. |
| K10 | Several parent candidates on the first level: no parent part, and one log line. Children still count. | No server fact picks one. A wrong parent misleads the review. |
| K11 | Merged and declined PRs are never part of the stack. | Their code is in the target, or it will not merge. |
| K12 | Sources: stored rows always. The branch search and the change lists of other PRs only after the stack gates pass (`STACK_READS`). The stack gates are G9, G12, and G20. | The same pattern as `PEER_READS`. An inbox parent works before the gate. |
| K13 | No table. The app finds the stack at each review run start, within the 15 s of the PR context reads. | BRIEF 3.5: no memory between runs. The change lists use an in-memory cache, as `peerCache` does. |
| K14 | A read failure inside a known stack gives a "Not read" line. A failure before a stack is known gives no section, only a log line. | A line on a PR with no stack breaks K3 and gives the model nothing to act on. |
| K15 | Context: a section "## Stacked pull requests" in pr-context.md, right after "## Pull request". Cap 8 KB. | The facts are untrusted text, so they stay under the banner. The stack changes how to read the diff, so it comes first. |
| K16 | The peer section leaves out the PRs of the stack section. | One PR, one line. |
| K17 | Code: one fetch of the parent's target branch to `refs/rl/<this PR id>/parent-target`. New alias PARENT_BASE. No PARENT alias, no child code. | TARGET is already the parent head. PARENT_BASE is an ancestor of TARGET, so `resolve` needs no new pin. |
| K18 | Prompt lines only when the run has a stack. Parent lines and child lines are separate. | K3. |
| K19 | No chip and no setting in v1. One run log footer line from `review_run.related_json` (WP-RP0, shared with submodule-prs.md). Decided by the user on 2026-11-23. | The user must see what the run read. The user wants light UX (question 6). |
| K20 | Proof: 3 probe cases (Gate SK-P) and a manual check of 5 real stacked PRs (Gate SK-B). | The local set has no stack data (section 2). |
| K21 | WP-SK4 makes "stack" a default and raises REVIEW_PROMPT_VERSION with the next planned step. | `eval:ab` refuses a baseline with another version (review-ledger.md section 2). |
| K22 | The rule "a child that relies on this PR's contract is a caller to check" is not in v1. The child lines cover a gap that a child names. | Child code is not in the cache. The child builds on this head, so it already fits this change (question 4). |

## 5. Behavior

### 5.1 Detection

Input: the PR row (project, repo, PR number, source and target branch, heads), the provider, and the stored rows.

1. Skip the whole step when the run is not a review run or the profile lacks "stack".
2. Read this PR (`getPullRequest`) and the default branch (`defaultBranch`) in parallel. Both are verified reads.
3. Without a provider, or when either read fails, the step ends with no stack. Stored rows alone never make a stack, because K6 needs the default branch.
4. When the source repository of this PR is not this repository, skip step 7.
5. Parent level: the branch T is this PR's target branch. Skip the level when T is the default branch.
6. Candidates for T: stored OPEN rows of this repository with `source_branch` = T. After the stack gates, also the branch search `state=OPEN&at=refs/heads/<T>&direction=OUTGOING`. Join both by PR number. Leave out this PR.
7. Children: stored OPEN rows of this repository with `target_branch` = this source branch. After the stack gates, also `state=OPEN&at=refs/heads/<source>&direction=INCOMING`. Skip when the source branch is the default branch.
8. A stored parent candidate gets one `getPullRequest` read. It stays only with state OPEN and both refs in this repository. A PR that the search lists needs no extra read. A stored child needs none either.
9. Each kept PR gets its changed paths from the stored `pr_change` rows. Else, after the stack gates, `listChanges` gives them, cached by PR and update time. G12 covers this read.
10. Walk up: the parent's target branch becomes T. Repeat steps 5, 6, 8, and 9 until a stop rule applies.

Stop rules of the walk (no state between runs, so no other machine):

| Stop | When | Effect |
|---|---|---|
| none | T is the default branch | The chain ends there. No line. |
| none | no candidate for T | The chain ends there. No line. |
| several | more than one kept candidate for T | First level: no parent part (K10). Higher level: line "Not followed: N open pull requests use <T> as their source branch." |
| loop | T or a PR repeats | Line "Not followed: the chain returns to #N." |
| cap | 3 PRs up are found | No search below the third. Line "The app follows at most 3 pull requests down the stack." |
| deadline | the 15 s pass, or Cancel | Line "Not read: <part> (<reason>)." with the reason text of pr-context.ts `why`. |
| error | a read fails | The same "Not read" line. The run goes on. |

### 5.2 Reads, timing, and failure

- The stack step joins the Promise.all of `loadPrContext` (pr-context.ts:238-242). It shares its deadline and Cancel.
- Reads per run, before the stack gates: 2, plus 1 per stored parent candidate. That is at most 5.
- Reads per run, after the stack gates: also 1 branch search per level (at most 3) and 1 children search. Add at most 6 change lists, cached. That is at most 15.
- All calls are GET. They live in src/server/bitbucket/provider.ts only.
- A failed first read (step 3) gives no section, no prompt line, and the log text "stack not read (<reason>)".

### 5.3 The section in pr-context.md

Order: "## Pull request", then "## Stacked pull requests", then the sections of today. The section joins `fixed` in `prContextFile` (context-files.ts:926), so the thread list gives way. The whole-file cut (context-files.ts:943-944) still applies.

Text (one example; `<...>` marks values):

```
## Stacked pull requests

### Parent #<n> "<title>" by <author>, open, updated <date>
- Source: <branch> at <short hash>. Target: <branch>.
- Changed paths (<count>): <path>, <path>, ... +<k> more.
- Description (the first 1 KB):

    <text>

### Parent of #<n>: #<m> "<title>" by <author>, open, updated <date>
- Source: <branch>. Target: <branch>.
- Changed paths (<count>): <path>, ... +<k> more.

### Child #<c> "<title>" by <author>, open, updated <date>
- Source: <branch>. Target: <branch>, the source branch of this pull request.
- Changed paths (<count>): <path>, ... +<k> more.
- Description (the first 1 KB):

    <text>

<k> more child pull requests left out.
Not read: the changed paths of #<m> (Bitbucket error timeout).
```

- `oneLine` and `indentBlock` apply as in the peer section. "(the user)" follows an author who is the user.
- Caps: `STACK_SECTION_BYTES` 8 KB, `STACK_UP_MAX` 3, `STACK_CHILDREN_SHOWN` 3, and `STACK_DESCRIPTION_BYTES` 1 KB.
- `STACK_PATHS_SHOWN` is 30 for the parent and 10 for the others. Only the parent and the children get a description.
- Cut order over 8 KB: (1) child descriptions; (2) the parents above the parent, the highest first; (3) the children, the last first; (4) the parent paths after the tenth; (5) the parent description. The heading and the parent line always stay.
- No open thread text of another PR in v1 (question 3).
- No thread count either. The count needs one more field or one more read per PR. A count alone gives the model no fact to check.
- The peer section leaves out each PR that this section lists.
- task.md of WP-JC5 can name the same PR by task key. Both lines state their relation, so no join is needed (question 7).

### 5.4 Code access

- After `fetchHeads`, `prepareWorkspace` runs one more fetch when the input has `parentTarget`: `+<parent toRef id>:refs/rl/<this PR id>/parent-target`.
- It is a separate call. A failure must not start the branch fallback of `fetchHeads` (workspace.ts:262-272).
- It runs under the cache lock with the run's Cancel. It uses the token config and redaction of `fetchHeads`.
- Time cap: `STACK_FETCH_MS` 60 s, below the run limit. On a timeout, the run goes on without PARENT_BASE. Gate SK-B checks the value.
- No size cap and no depth limit. A shallow fetch would make the merge base wrong. The history up to PARENT_BASE is already in the cache, because TARGET holds it.
- Then `merge-base <parent-target> <TARGET>` gives PARENT_BASE. A failed fetch or merge base gives `parentBase: null`, one log line, and no alias lines.
- The ref sits under the child's ID, so `pruneRefs` removes it with the child. A ref keyed by a parent outside the inbox would never go.
- `toPr` maps `toRef.id` to an optional `targetRef`. Without it, the app fetches nothing.
- rl-git gets `--parent-base=<hash>` only when PARENT_BASE exists. Then REV, ALIAS, the error text, and the describe text add PARENT_BASE.
- Without the argument, the regex and every text stay byte-identical. The three review call sites pass the workspace value. The task implement site passes none.
- git_diff from PARENT_BASE to TARGET shows the parent change as the parent PR shows it.
- No CHILD alias in v1. Child commits are not in the cache, and `resolve` would refuse them (question 4).

New describe text of `rev`, with the pin only. It keeps the shape of the current text (git-mcp.ts:53):

```
A commit: a hex hash, or HEAD (PR source head), BASE (the base of the reviewed range, the merge base in a first review), TARGET (target branch head, the parent pull request head), or PARENT_BASE (the base of the parent pull request change). Add ~N for the Nth first-parent ancestor or ^N for the Nth parent, for example HEAD~1 or BASE^.
```

### 5.5 Prompt lines

`RunFiles` gets `stack?: { parent: boolean; parentBase: boolean; children: boolean }`. Each group shows only when its flag is true.

STACK_LINES, in `contextBlock` (catalog.ts:525) after the BASE line (catalog.ts:541), so every agent of a review run gets them:

1. 'This pull request is stacked. The section "Stacked pull requests" in ./context/pr-context.md names the other pull requests.'

With `parent`:

2. "TARGET is the head of the parent pull request, so the parent change is not in BASE..HEAD."
3. With `parentBase`: "git_diff from PARENT_BASE to TARGET shows the change of the parent pull request."
4. "The parent pull request has its own review. Code that only the parent changes is not part of this change."
5. "A problem in that code counts only when this change relies on it, breaks it, or makes it reachable."
6. "When this change calls, extends, or relies on code that the parent adds or changes, read that parent code first."
7. "git_log with rev TARGET and since HEAD lists the parent commits that this change does not have."
8. "Check that this change still works with them."

With `children`:

9. "A child pull request builds on this change. It can add what this change lacks."

STACK_FINDER, in `finderRules` with `main`, after FINDER_QUESTION_RULES, with `children`:

10. "When the title or description of a child names the missing part, ask about the gap. Name the child."

STACK_VERIFY, in `verifyRules` after the refute line group:

11. With `parent`: "Code that only the parent changes is not in the change."
12. With `parent`: "Confirm a candidate there only when this change relies on it, breaks it, or makes it reachable."
13. With `children`: "When the title or description of a child names the missing part, give question, not confirmed. Name the child in question."

STACK_PREEXISTING, in `finderRules` after PREEXISTING_LINES, with `parent` (the pre-existing lines are a default since prompt 2.9):

14. "A problem in code that only the parent changes is never pre-existing. Set preexisting to false on it."

Interactions:

- "BASE..HEAD is the change" (catalog.ts:632) stays true. Line 2 says why the parent code is outside it.
- The anchor rule for unchanged code (catalog.ts:633) covers a parent problem that line 5 lets in. It gets a cause on a line of this change.
- With the pre-existing lines, parent code would pass "exists at BASE without the change" (catalog.ts:572). Line 14 blocks that. A parent problem that this change makes reachable already has preexisting false (catalog.ts:576).
- Line 12 ties line 5 to the refute reason "the problem is not in the change" (catalog.ts:1682).
- Line 10 refines "A gap between that goal and the code is a finding" (catalog.ts:530). A child that names the missing part plays the named follow-up of probe-obl-met-followup.
- Lines 10 and 13 need the child text to name the part. A shared file alone is too weak, because the app cannot read child code.
- `finderRules(p, main)` (catalog.ts:627) takes no context today. WP-RP0 adds the optional argument `files?: RunFiles` for lines 10 and 14. `verifyRules` already takes `ReviewContext` (catalog.ts:1670). The Improve prompt passes none, so its text keeps its bytes.
- rl-reviewer has no question field. Its gap finding goes to the verify phase, and line 13 turns it into a question. With the verifier off, the finding stays.
- The peer line (catalog.ts:501) stays. K16 keeps the stack PRs out of the peer list.

### 5.6 Run kinds

- Review and re-review runs only (K4). The section and the alias have the same condition.
- Re-review: BASE is the range base. Lines 2, 3, 7, and 8 do not name BASE as a range start, so they hold in both modes.
- Reply, fix, Ask, discuss, session, Explain, and task runs get no stack read in v1.

### 5.7 UI

- Decided by the user on 2026-11-23: no chip and no setting in v1. Only config.json sets variants (review-ledger.md section 1).
- With "stack" on and a stack found, the run log footer gets one line from `review_run.related_json` (WP-RP0, shared with submodule-prs.md). Without a stack, it gets no line (K3).
- With "stack" on, the server log line of jobs.ts:616 gets one more part. It is ", stack: parent #N, C children", ", stack: none", or ", stack: not read (<reason>)".

### 5.8 Security

- The token stays in the app: provider reads and the cache fetch with the GIT_CONFIG env, as today.
- The child gets no new tool. rl-git stays read-only, and `resolve` still checks ancestry.
- Titles, descriptions, and paths of other PRs are untrusted. They stay inside pr-context.md under the UNTRUSTED banner.
- BRIEF 3.5 needs no change.
- BRIEF 3.6 draft line. WP-SK1 adds it. "Stacked PRs (stacked-prs.md, variant "stack"): a review run start reads the PR and the default branch. It also reads each stored parent candidate. After Gates G9, G12, and G20 pass, it reads the open PRs from and into the stack branches. It also reads their change lists. The app fetches the parent's target branch into the cache. These calls are GET only. They share the 15 s of the PR context reads."

## 6. Data

- No migration, no table, no stored state.
- `PullRequest` (src/shared/types.ts) gets optional `sourceRepo: { project; repo }` and `targetRef`. Hand-made test literals keep compiling.
- `listOpenPullRequests(project, repo, branch?, direction = "OUTGOING")`. The current callers keep their bytes.
- `StackPr = { prId; title; author; mine; state; source; target; targetRef?; sourceHead; updated; paths; description }`.
- `Stack = { parents: StackPr[]; children: StackPr[]; childrenLeft: number; notes: string[] }`. `parents[0]` is the parent.
- `PrContextInput` gets optional `stack`. Absent gives today's bytes.
- `WorkspaceInput` gets optional `parentTarget`. `Workspace` gets `parentBase: string | null`.
- Constants in context-files.ts: `STACK_SECTION_BYTES`, `STACK_UP_MAX`, `STACK_CHILDREN_SHOWN`, `STACK_PATHS_SHOWN`, `STACK_DESCRIPTION_BYTES`.
- `STACK_FETCH_MS` in workspace.ts.
- `STACK_READS` in pr-context.ts, false until the user records Gates G9, G12, and G20 as PASS.
- `createReviewJobs` gets an optional `stackReader`, as it has `gitRemote`. The eval passes the stack of a case through it.

## 7. Eval and proof

- The natural set cannot measure "stack": it has no Bitbucket and no parent data. K3 makes the variant a no-op there. A snapshot test proves it, so no natural-set run is needed.
- So the version trap of review-ledger.md section 2 does not touch this package before WP-SK4.

### Probe cases (WP-SK3)

Three cases in fixtures/eval/probe/, in the format of probe-obl-criterion-deferred/case.json. `parent.patch` applies to base/, and head.patch applies on top of it. `stack` in case.json names the parent and the children.

| ID | Seeded | Expected |
|---|---|---|
| probe-stack-relies | The parent adds `parseQuota`, which returns null for a bad value. Its comment says so. The child uses the result with no null check. | Must-find, major, on the child line. Trap on the parent `return null` line. |
| probe-stack-unreached | The parent helper is wrong for negative input. The child calls it only with constants above zero. | Clean. Trap on the negative branch of the parent helper. |
| probe-stack-child-fills | This PR meets criterion 1 of 2. A child PR "Add the Retry-After header" changes src/api/server.ts. Twin of probe-obl-criterion-deferred. | Clean. Trap on the partial line. A question that names the child is correct. |

- Harness: `buildRepo` (scripts/eval/cases.ts:296-340) makes branch `parent` from parent.patch. The remote target ref becomes `refs/heads/parent`.
- The `stackReader` of the case gives PR number 2 for the parent, with paths from parent.patch.
- Without "stack", the same cases run with no section and no alias. That is the control.

### Gate SK-P (probe, user runs)

- `bun run eval -- --set probe --cases probe-stack-relies,probe-stack-unreached,probe-stack-child-fills --repeat 3`, once with `--variants stack` and once without. Both sides run fresh, so the version of a stored baseline does not matter.
- Pass: with "stack", 0 trap hits over the 9 runs. The must-find of probe-stack-relies is found at least as often as in the control. Failed runs do not rise. Cost per case rises by at most 25%.
- The gate checks behavior, not recall. 3 cases cannot show a recall gain.

### Gate SK-B (manual, user)

- Pick 5 real stacked PRs. At least 3 are children with an open parent. At least 1 is a bottom PR with a child.
- Run a review with "stack" and one without on each. Read both run logs and finding lists.
- Record per PR whether the run read the parent change. A git_diff with PARENT_BASE or a read of a parent path counts.
- Record per PR the findings that blame parent-only code, and the findings that the stack facts helped.
- Ship rule: no finding blames parent-only code without a reliance in any of the 5 PRs. The user judges the value and decides WP-SK4.

## 8. Cost

- A PR with no stack: 2 more GETs at run start. After the stack gates, up to 4. They run in parallel with the build stats read. No model tokens.
- A stacked PR: up to 15 GETs, with cached change lists. One fetch of a branch that the cache mostly holds. Up to 8 KB of context, about 2,000 tokens.
- Model cost per stacked review: about +$0.05 to +$0.25 by estimate, for the parent reads. Unverified. Gate SK-B records it.
- Gate SK-P: 18 probe runs at about $0.15 each (results.md:41), about $3. Unverified.
- Build: about 600 to 900 lines with tests over WP-SK1 to WP-SK3. Unverified.

## 9. Acceptance criteria

- AC-SK1. Without "stack", the app sends no new request, and every prompt, context file, and rl-git argument is byte-identical to 2.9.
- AC-SK2. With "stack" and no stack, the same bytes as AC-SK1. Only the stored prompt version gets "+stack".
- AC-SK3. A child with an open parent in the same repository gets the section with the parent first. PARENT_BASE works in rl-git.
- AC-SK4. The default branch, a fork source, a merged or declined PR, and several first-level candidates never give a parent.
- AC-SK5. A failed read inside a known stack gives a "Not read" line, and the run goes on. A failed first read gives no section.
- AC-SK6. The section stays within 8 KB, follows the cut order, and the file stays within `PR_CONTEXT_BYTES`.
- AC-SK7. The parent fetch never starts the branch fallback, never shows the token, and its ref goes with the child's refs.
- AC-SK8. Before the stack gates pass, the app reads no branch search. It reads no change list of a PR outside the inbox.
- AC-SK9. A PR in the stack section is not in the peer section.
- AC-SK10. Ask, reply, fix, discuss, Explain, and task runs get no stack read.

## 10. Work packages

| # | Package | Tier | Files | Tests | Done when |
|---|---|---|---|---|---|
| 1 | WP-SK0: Gate G20 script, read-only | implementer | scripts/gate/bitbucket-write.ts (G20 in CHECKS and READ_ONLY); integration-check.md (G20 row, NOT RUN); docs/gate-v2.md | tests/gate/gate-v2.test.ts: the dry run of G20 and its read list against the fake. | `bun run check` is green. The user can run G20 with G9 and G12. |
| 2 | WP-SK1: detection and the section, variant "stack" | implementer-xhigh | src/shared/dto.ts (VARIANTS, its comment); src/shared/types.ts (sourceRepo, targetRef); src/server/bitbucket/provider.ts (toPr, direction); src/server/review/pr-context.ts (loadStack, STACK_READS, log reasons); context-files.ts (stackSection, caps, peer filter); jobs.ts (prContext: review runs with "stack" only, the log line); BRIEF.md 3.6 (the draft line of section 5.8) | A new tests/review/stack.test.ts with the fake Bitbucket. It covers each stop rule, the join of rows and search, and the confirm read. It also covers the default branch, a fork, several candidates, and a loop. It checks the caps, the cache, Cancel, and each "Not read" line. pr-context.test.ts: placement, cut order, peer filter, and a snapshot without the stack. provider.test.ts: the INCOMING query and the new fields. | AC-SK1, AC-SK2, AC-SK4 to AC-SK6, AC-SK8 to AC-SK10. `bun run check` is green. |
| 3 | WP-SK2: parent fetch, PARENT_BASE, prompt lines | implementer-xhigh | workspace.ts (parentTarget fetch, parentBase); git-mcp.ts (pin, REV, ALIAS, texts, runGitMcp); jobs.ts (the three review call sites, RunFiles.stack); catalog.ts (STACK_LINES, STACK_FINDER, STACK_VERIFY, STACK_PREEXISTING) | workspace.test.ts: the fetch, a failed fetch with the run going on, redaction, the ref name, and pruneRefs removing it. git-mcp.test.ts: PARENT_BASE only with the pin, byte-identical texts without it. prompt.test.ts: each group with and without its flag. Snapshots of all agents without a stack, and of the Improve prompt. | AC-SK3, AC-SK7. `bun run check` is green. |
| 4 | WP-SK3: probe cases and harness | implementer | fixtures/eval/probe/probe-stack-* (3 cases); scripts/eval/cases.ts (parent.patch, the parent branch); scripts/eval/run.ts (stack field, stackReader, target ref); docs/eval/local.md (probe list) | tests/eval/harness.test.ts: a stack case builds the parent branch and gives the section with a fake claude. A case without `stack` keeps its bytes. | `bun run check` is green. A fake run of the 3 cases shows the section. |
| 5 | Gate G20 | user | none | Section 11. | The user records the facts. |
| 6 | Gate SK-P | user | none | Section 7. | The pass rule holds. |
| 7 | Gate SK-B | user | none | Section 7. | The user decides. |
| 8 | WP-SK4: ship as default | implementer | src/shared/review.ts (REVIEW_PROMPT_VERSION, with the next planned step); catalog.ts and jobs.ts (always on for review runs); dto.ts and run.ts (remove "stack"); spec.md (AC-SK1 to AC-SK10); README.md; CHANGELOG.md | Snapshot updates. An old profile with "stack" reads without it. | Each review run gets the stack facts. `bun run check` is green. |

- WP-SK1 and WP-SK2 edit jobs.ts and context-files.ts. Run them one after the other.
- WP-JC5 edits task-file.ts, not the files of WP-SK1 and WP-SK2. No file clash is known.
- WP-SK4 waits for the Gate A order of review-ledger.md section 4. Push nothing between WP-SK4 and its version step.

WP-SK2 build notes (2026-11-23), where the build differs from the plan:

- Only the review run start passes `parentTarget` to `prepareWorkspace`. `gitMcpServer` reads `ws.parentBase`, so its call sites do not change. Task workspaces give `parentBase: null`.
- The section 2 fact on the rl-git call sites is out of date. Of the three workspace sites, only the PR run steps are a review run. The other two are the task snapshot and the task own review.
- The parent fetch runs after `syncCache`, in its own cache lock. A parent ref that fails the ref check counts as a failed fetch.
- A Cancel during the parent fetch also gives `parentBase: null`. The next git step of the workspace then stops the run.
- The rl-git regex error and the describe text name PARENT_BASE. The `resolve` error keeps "HEAD, BASE, or TARGET", because PARENT_BASE is an ancestor of TARGET (K17).
- `STACK_LINES` and `STACK_VERIFY` hold one list per flag. With "submodules" too, the stack lines come first, and `STACK_VERIFY` follows `SUBMODULE_VERIFY`.
- Tests: the `pruneRefs` check is in tests/review/prune-refs.test.ts. tests/review/jobs.test.ts runs a stacked review with the fake CLI, with and without PARENT_BASE.
- REVIEW_PROMPT_VERSION and every prompt hash pin stay the same. A git-mcp test pins the sha256 of the rl-git tool list without the pin.

## 11. Gates

### Gate G20: stack reads (read-only, user)

Run: `bun scripts/gate/bitbucket-write.ts --repo <URL> --only G9,G12,G20`. The test repository needs a stack of 3 PRs: A into main, B into A, C into B.

| Fact | Checks |
|---|---|
| U-SK1 | `state=OPEN&at=refs/heads/<A>&direction=OUTGOING` lists exactly PR A. |
| U-SK2 | `state=OPEN&at=refs/heads/<B>&direction=INCOMING` lists exactly PR C. |
| U-SK3 | `at` with the default branch and OUTGOING lists only PRs from it. INCOMING lists the PRs into it. |
| U-SK4 | `fromRef.repository` and `toRef.id` keys of each value. A PR from a fork, if the test setup has one. |
| U-SK5 | `isLastPage` and `limit` behave as in G9. |

- Until G9, G12, and G20 pass, `STACK_READS` stays false. Stored rows still work.
- The branch model read (question 1) is out of G20 by the decision of 2026-11-23. G20 reads the default branch only.

## 12. Open questions

1. Should the branch model's development and production branches also never link a stack? It covers a git-flow repository with an open develop-into-main PR. Recommended: yes, if Gate G20 shows the read works with a non-admin token. Else the default branch only.
   - Decided by the user on 2026-11-23: The default branch only. Add the branch model after Gate G20 shows that a non-admin token can read it.
2. Several first-level parent candidates: no parent part (K10), or a list without the alias? Recommended: no parent part, because a wrong parent misleads the review.
   - Decided by the user on 2026-11-23: Several candidates show no parent part (K10).
3. Should the section hold the open thread texts of the parent? Recommended: not in v1. Gate SK-B records each case where a parent thread would have helped.
   - Decided by the user on 2026-11-23: No parent thread texts in v1.
4. Should rl-git get child code (a CHILD alias)? Recommended: not in v1. The child builds on this head, so it already fits this change.
   - Decided by the user on 2026-11-23: No CHILD alias in v1.
5. Should Ask, discuss, reply, and fix runs get the section? Recommended: after WP-SK4, Ask and discuss first.
   - Decided by the user on 2026-11-23: Review runs only. After WP-SK4, add Ask and discuss first.
6. Should the PR view show a "Stacked on #N" chip from stored rows? Recommended: not in v1. The user wants light UX, and Gate SK-B shows the need.
   - Decided by the user on 2026-11-23: No chip. One run log line through `review_run.related_json` (WP-RP0).
7. Should the stack section and the WP-JC5 task.md list drop each other's PRs? Recommended: no. They are different files, and each line states its relation.
   - Decided by the user on 2026-11-23: Do not join the stack section with the WP-JC5 task.md list.
8. Keep lines 7 and 8 (parent commits that this change lacks)? They add a tool call when the child is up to date. Recommended: keep. Gate SK-B records noise from them.
   - Decided by the user on 2026-11-23: Keep lines 7 and 8. Gate SK-B records the noise.
9. Should WP-SK4 share the next planned version step? Recommended: yes, so the natural-set baseline survives one step fewer.
   - Decided by the user on 2026-11-23: Yes. WP-SK4 and WP-SM4 share the next version step after 2.9.
10. The task own review of stacked part PRs (self-approved-plans.md SA-2) knows its stack from task rows. Recommended: out of scope. A later package can feed the same section from those rows.
   - Decided by the user on 2026-11-23: SA-2 task-part stacks stay out of scope.
11. Are the caps right: 3 up, 3 children, 8 KB, 60 s for the fetch? Recommended: yes, until Gate SK-B shows a cut or a timeout that lost a needed fact.
   - Decided by the user on 2026-11-23: Keep the caps until Gate SK-B shows a lost fact.
12. Is a question right for a gap that a child names (lines 10 and 13)? It turns a confirmable gap into a question. Recommended: yes, because the app cannot read child code, and the author answers in one line. Gate SK-B and probe-stack-child-fills check it.
   - Decided by the user on 2026-11-23: Yes, a question for a gap that a child PR names.

## 13. Out of scope

- Any Bitbucket call from the claude child, or any token in the child.
- Posting a finding on the parent PR from this run.
- A stack view, a stack graph, or a retarget action.
- Stacks across repositories.
- Seeded stack cases in the natural or seeded set.

## 14. Wave RP

The user decided on 2026-11-23 to build this design and submodule-prs.md in one wave RP.

### 14.1 Shared with submodule-prs.md

- WP-RP0: the column `review_run.related_json`, `RunDto.related`, and the RunLog and RunLine lines. Both variants write their run line through it.
- WP-RP0: `finderRules(p, main, files?: RunFiles)`. `RunFiles` gets the `stack` and `submodules` flags. Without the argument, the finder text keeps its bytes.
- `listOpenPullRequests` stays behind `PEER_READS`. One user run of Gates G9, G12, and G20 unblocks both designs.
- Eval: the VARIANTS entries, the `stackReader` and `submoduleReader` options of `createReviewJobs`, and `buildRepo` in scripts/eval/cases.ts.
- One ship step: WP-SK4 and WP-SM4 share the next version step after 2.9.
- Not shared: the 15 s deadline. The stack reads run in `loadPrContext`. The submodule step runs after the workspace, with its own deadline.

### 14.2 Order

WP-SK0 -> the user runs Gates G9, G12, and G20 -> WP-RP0 -> WP-SK1 -> WP-SK2 -> WP-SM0 -> WP-SM1 -> WP-SM2 -> WP-SK3 -> WP-SM3 -> Gates SK-P and SM-P -> Gates SK-B and SM-B -> WP-SK4 with WP-SM4.

- Run one package at a time. The packages edit the same files.
- Gates G9 and G12 are NOT RUN (integration-check.md:401-402). WP-JC5 is still on branch jc5, not on main.
