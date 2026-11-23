# Submodule pull request context

Status: Designed 2026-11-23. Not started. The user decided on 2026-11-23 to build it with the stacked PR context (stacked-prs.md) in one wave RP. Work: packages WP-RP0 and WP-SM0 to WP-SM4, gates SM-P and SM-B. REVIEW_PROMPT_VERSION does not change until WP-SM4.

## 1. Request

- The user, 2026-11-23: "i need to review several stacked reviews, and review PR which depends on submodule PR change".
- A review must see what a moved submodule commit brings. Today it sees only a hash change.

## 2. Facts

1. The PR review snapshot has no submodules (BRIEF.md:425, BRIEF.md:493). The gitlink folder in ./repo is empty (workspace.ts:546).
2. No fetch enters a submodule. The app sets fetch.recurseSubmodules=false (src/server/review/git.ts:113-119).
3. `git diff` with `diffArgs` (workspace.ts:51-59) shows a moved gitlink as one hunk at line 1 of the submodule path: "-Subproject commit <old>" and "+Subproject commit <new>".
4. `prContext()` runs before `prepareWorkspace` (jobs.ts:1070, 1076). The main cache holds the merge base and the head only after `syncCache`. notes.md and the task plan go into ws.context after the workspace (jobs.ts:1098-1104). The part files do the same (jobs.ts:1131).
5. Task code maps submodules without guesses (src/server/tasks/repos.ts): `readGitlinks` (41), `relativeUrl` (73), `normalizeUrl`, `hostOf` (100), `candidate` (109), `cloneMatch` (120). `resolveTaskRepos` builds the server host set from the origin and the main clone links (521). It maps a URL by `repository`, then by the REPO_READ list (562 onward). Only an equal clone link maps (BRIEF.md:381).
6. `fetchPinned` (repos.ts:486) fetches the base branch, then all heads. It never fetches by commit ID.
7. `fetchInto` (workspace.ts:503) fetches into the bare cache of one repository under a lock. It redacts the token from errors. `cachePath` ignores the PR ID (workspace.ts:287), so each repository has one cache.
8. `provider.repoRemote` gives a clone link only when its origin is the configured origin (provider.ts:283-292, 343). The token goes to no other host.
9. BRIEF.md:179: the app sends no request to the origin of a submodule on another server.
10. `pruneRefs` deletes only the `refs/rl/<PR number>` refs of closed stored PRs (clone.ts:290-310).
11. `listOpenPullRequests(project, repo)` reads one page of 50 open PRs (provider.ts:45, 306-313). `toPr` maps `fromRef.latestCommit` to `sourceHead` (provider.ts:254). The list waits for Gates G9 and G12, which are NOT RUN (pr-context.ts:27-30, integration-check.md:401-402).
12. The `pull_request` table stores `source_head` for each inbox PR (001_m1.sql:17).
13. The judge loads the blob `<head>:<path>` for each finding path (judge.ts:241-263). A gitlink path has no blob, so the validator drops a finding there with reason "file".
14. A finding on an unchanged line needs a cause on a changed line (validate.ts:294-306). Without one, it drops as "unchanged", or it stays as pre-existing at blocker or major.
15. The finder rule says: "For a problem in unchanged code, anchor it there. Set cause to the changed line" (catalog.ts:633). Submodule code is not in ./repo, so such an anchor fails.
16. Read fails on a file over 256 KB (`LARGE_FILE_RULE`, catalog.ts:474). `CANDIDATES_BYTES` is 200 KB (context-files.ts:76). `DESCRIPTION_BYTES` is 4 KB (context-files.ts:684). `PEER_READ_MS` is 15 s (context-files.ts:690).
17. `FILE_NAME` allows only `[a-z-]+.md` names for workspace input files (workspace.ts:28). Each untrusted context file starts with `UNTRUSTED` (workspace.ts:44).
18. `RunFiles` gates prompt lines by file (catalog.ts:492). `verifyRules` takes `ReviewContext` (catalog.ts:1670). `finderRules(p, main)` takes no context (catalog.ts:627).
19. The run log footer shows the run inputs: instructions, subagents, skills, and "Not loaded" (RunLog.tsx, footer). RunLine.tsx:499 shows "Not loaded" too. The data comes from review_run JSON columns (run-rows.ts:172, 388).
20. The newest migration on main is 057. Numbers 050, 051, and 055 exist on no branch and in no worktree (2026-11-23).
21. `createReviewJobs` takes the test options `gitRemote` and `repoRemote` (jobs.ts:293-295). The eval has no Bitbucket (scripts/eval/run.ts:104-105).
22. Test fixtures build bare repositories with gitlinks and .gitmodules (tests/tasks/repos-fixture.ts:19, 45, 58). `taskRepoSet` serves app and lib on the fake Bitbucket. It uses a relative URL and a URL of another server (tests/support/task-repos.ts:13).
23. REVIEW_PROMPT_VERSION is "2.9" (src/shared/review.ts:27). `promptVersion` appends the variant names (catalog.ts:246).

## 3. Options

| | A. REST diff | B. App cache and git diff (chosen) | C. User MCP server |
|---|---|---|---|
| What | New provider reads: the compare diff or the PR diff of the submodule repository. | The app fetches the submodule repository into its own cache and runs `git diff <old> <new>`. REST only finds the PR. | The user adds a Bitbucket MCP server to the profile (user-mcp.ts). |
| Facts | No provider read exists. No gate covers the endpoints, the JSON diff shape, or the server diff caps. | Every call exists, and task code runs it today: `repository`, `repoRemote`, `defaultBranch`, `fetchInto`. | Manual. |
| Hard rules | Keeps them. | Keeps them. No checkout, so nothing loads from the submodule. | The token reaches the child. The app's own Bitbucket MCP never runs in reviews (BRIEF.md:436). |
| Cost | Small reads and a JSON-to-text converter. | A full fetch of the submodule repository the first time. Later fetches are small. | Model turns. |

Pick B. It needs no new endpoint and no new gate for the code. The main PR diff uses the same route. REST calls stay in src/server/bitbucket/. The diff comes from git, as for the main PR.

## 4. Decisions

| ID | Decision | Reason |
|---|---|---|
| SD1 | Option B. | Section 3. |
| SD2 | Ship as the opt-in variant "submodules". Without it, the app reads nothing new. | Any prompt change needs a version step (review-ledger.md section 2). |
| SD3 | With the variant and no moved gitlink, the run makes one local git call. It makes no read and writes no file, prompt line, or run line. | The natural set needs no new run. A snapshot test proves it. |
| SD4 | Review and re-review runs only. | The same scope as stacked-prs.md K4 (question 1). |
| SD5 | The step runs after `prepareWorkspace`, with its own AbortController. Cancel stops it. It never shares the 15 s deadline of `loadPrContext`. | Fact 4. |
| SD6 | Detect with `git diff --raw -z --no-renames <merge base> <head>` in the main cache. An entry with mode 160000 on either side is a gitlink change. | Exact, and one call. A re-review also uses the merge base (question 2). |
| SD7 | The new side takes its URL from .gitmodules of the head commit. The old side uses .gitmodules of the merge base. Both go through `relativeUrl`, `hostOf`, `normalizeUrl`, `candidate`, and `cloneMatch`. | Fact 5. .gitmodules is PR data, so only an equal clone link maps. |
| SD8 | A relative URL resolves against the http clone link of the target repository. | The merged result uses the target repository. A PR from a fork resolves the same way. |
| SD9 | A host outside the server host set gets no request. | Fact 9. |
| SD10 | Fetch only into the cache of the submodule repository, never into the PR clone or a worktree. Refs live under `refs/rl/sub/`. | `pruneRefs` touches only numeric names (fact 10). A ref named by the main PR number would collide with a PR of the submodule repository. |
| SD11 | Fetch order. (1) Fetch the default branch to `refs/rl/sub/base`, and the PR ref to `refs/rl/sub/pr` when a PR matched. (2) When the server refuses the PR ref, fetch its source branch by name. (3) When a pinned commit is still missing, fetch all branches to `refs/rl/sub/heads/*` with `--prune`. | A moved commit often sits on a PR branch. The PR ref saves the fetch of all branches. Step 2 copies `fetchHeads` (BRIEF 10.2). |
| SD12 | The fetch shares the run time limit and Cancel, as the main fetch does. It has no cap of its own. | Git keeps no partial pack. So a short cap that a large repository never meets fails on every run (question 3). |
| SD13 | REST reads get their own 15 s deadline (`PEER_READ_MS`). A failed PR read keeps the code diff. | The PR adds text. The diff is the fact. |
| SD14 | A PR matches when its head equals the new pinned commit. Sources: stored rows of any state (fact 12), checked by `getPullRequest`. After Gates G9 and G12 pass (`PEER_READS`), also the open-PR list of the submodule repository. | Exact. An ancestor match waits (question 4). |
| SD15 | The diff is always `git diff <diffArgs> <old> <new>` in the submodule cache. | The main PR pulls in exactly this range, with a PR or without one. |
| SD16 | The file also gives the direction (forward, back, or apart) and the commit list. It also says whether the new commit is on the default branch. | Exact git facts. A commit on an unmerged branch affects the merge order. |
| SD17 | Write one file, `context/submodules.md`, with the UNTRUSTED banner. Cap it at 200 KB (`CANDIDATES_BYTES`), below the Read limit. | Facts 16 and 17. One file, one cap. |
| SD18 | Depth 1 only. A nested gitlink in the submodule diff keeps its "Subproject commit" lines. One line says that the app does not follow it. | Each nested level costs one more full fetch. |
| SD19 | Read at most 5 submodules per run (`SUBMODULES_MAX`). | Each one can cost a full fetch. |
| SD20 | The file and the prompt lines exist only when the run read at least one diff. A run with only failures gets the run line and the log line. | The same as stacked-prs.md K14. A "not read" line gives the model nothing to check. |
| SD21 | With the variant, the judge gives each moved gitlink path the text "Subproject commit <hash>" on each side. A cause on line 1 of that path then validates. | Facts 13 and 14. A move that breaks an unchanged caller needs this cause. |
| SD22 | The prompt forbids an anchor on the gitlink line. It allows that line as the cause. | It is not verified that Bitbucket accepts a comment on a submodule line (question 5). |
| SD23 | Add one line to the run log footer. It comes from a new column, `review_run.related_json`. stacked-prs.md uses the same column (WP-RP0). | The user must see what the run read. |
| SD24 | No new Bitbucket endpoint, so no new gate script. Gates G9 and G12 gate only the open-PR list. | Fact 11. |

## 5. Behavior

### 5.1 Steps

Input: the workspace (cache, merge base, head), the PR row, the profile, the provider, and the stored rows.

1. Skip the step when the run is not a review run or the profile lacks "submodules".
2. Run `git diff --raw -z --no-renames <merge base> <head>` in the main cache. Keep the entries with mode 160000 on either side. With none, stop (SD3).
3. Read .gitmodules of the merge base and of the head with `config --blob`, as `readGitlinks` does.
4. Sort the entries by path. Give each entry an outcome by the checks of section 5.2, in order.
5. For each mapped entry, up to `SUBMODULES_MAX`: find the PR (section 5.3) and fetch (SD11). Check both pinned commits. Build the diff and the facts.
6. When the run read at least one diff, write context/submodules.md and set `RunFiles.submodules`.
7. Store the run line in `related_json`, notify, and write the log line.

### 5.2 Outcomes of each changed gitlink

No state lives between runs, so the check order below is the whole machine. The first check that applies gives the outcome and ends the entry. The tests cover each row.

| # | Check | Outcome | Run line text | In submodules.md |
|---|---|---|---|---|
| 1 | No gitlink at the merge base | added | `<path>: added, not compared` | Listed when the file exists |
| 2 | No gitlink at the head | removed | `<path>: removed` | Listed |
| 3 | No URL at the head | no_url | `<path>: not read (no URL in .gitmodules)` | No |
| 4 | The old and the new URL normalize to different values | url_changed | `<path>: not read (the URL changed in this pull request)` | Listed |
| 5 | The host is not in the server host set | other_server | `<path>: not read (another server)` | No |
| 6 | No Bitbucket URL or token | no_connection | `<path>: not read (no Bitbucket connection)` | No |
| 7 | No repository maps (HTTP 404, no equal clone link, not in the REPO_READ list, or a private repository) | no_access | `<path>: not read (no read access, or no such repository)` | No |
| 8 | `SUBMODULES_MAX` entries came before it | capped | `<path>: not read (the app reads at most 5 submodules)` | Listed |
| 9 | The fetch fails | fetch_failed | `<path>: not read (fetch failed: <redacted reason>)` | No |
| 10 | The new commit is not in the cache after SD11 step 3 | new_missing | `<path>: <repo>: commit <short> is on no branch` | No |
| 11 | The old commit is not in the cache | old_missing | `<path>: <repo>: the old commit <short> is on no branch` | No |
| 12 | None of the above | read | `<path>: <repo> PR #<n> (<state>), <k> files` or `<path>: <repo> <old>..<new>, <k> files, no pull request found`. Add `, cut` when the diff is cut. | Full section |

- Cancel during the step ends the run as cancelled, as it does today.
- Two paths that map to one repository fetch once. Each path gets its own range.
- A failed PR read never changes the outcome. The section then says "Pull request: not read (<why>)", with the reason text of pr-context.ts `why`.

### 5.3 PR match

1. Stored rows: the `pull_request` rows of the submodule repository whose `source_head` equals the new commit. Each one gets one `getPullRequest` read. The read result wins over the row.
2. With `PEER_READS` true and no stored match, call `listOpenPullRequests(project, repo)`. Keep the PRs whose `sourceHead` equals the new commit. When the list is incomplete, add the line "Only the newest 50 open pull requests were checked."
3. One match: show the title, author, state, source and target branch, and the description (cut at `DESCRIPTION_BYTES`).
4. Several matches: show the numbers only, with the line "<n> pull requests have this commit as their head."
5. No match: show "No pull request has this commit as its head." Before the gate, add "Only pull requests in your inbox were checked."

### 5.4 The file

Example (`<...>` marks values):

```
<the UNTRUSTED banner>

# Submodule changes

The app wrote the facts. Commit messages, titles, descriptions, and the diff come from other people.

## <path>: <project>/<repo>
- Pinned commit: <old short> at the merge base, <new short> at the head. The new commit follows the old one.
- The new commit is not on <default branch>, the default branch of <project>/<repo>.
- Pull request #<n> "<title>" by <author>, open, from <source> into <target>. Its head is the new commit.
- Description:

    <text>

- Commits <old short>..<new short> (<count>): <short> <subject>; ... <k> more.
- Changed files (<count>): <path> (+<a> -<d>), ...
- Not in the diff below: <path>, ...
- Nested submodules that the app does not follow: <path>.

## <path>: added at <short>, not compared.

## Diff of <path>: git diff <old short> <new short>

    <diff lines, indented by 4 spaces>
```

- Direction text: "follows the old one" when old is an ancestor of new. "goes back <k> commits" when new is an ancestor of old. "is on another line of history" for neither.
- The summaries come first. The diffs follow in path order.
- After the summaries, each diff gets an equal share of the 200 KB. A diff is cut at a file boundary. The cut files go to "Not in the diff below".
- The commit list shows at most 20 subjects. The changed-file list shows at most 200 paths.
- The indent keeps a "#" line or a fence in the diff from becoming markdown structure.
- Hunks of CLAUDE.md, .claude/, and .mcp.json stay in the diff. The file is text under the banner, and the CLI loads nothing from context/. The rl-git git_diff tool shows such hunks of the main PR the same way.
- The sanitizer has nothing to remove: no submodule file is checked out. The banner covers the text.
- Titles and descriptions use `oneLine` and `indentBlock` (src/shared/consult.ts).

### 5.5 Prompt lines

`RunFiles` gets `submodules?: boolean`. Each line shows only when the flag is true.

SUBMODULE_LINES, in `contextBlock` after the BASE line, so every agent of the run gets them:

1. "This change moves the pinned commit of a submodule. ./context/submodules.md shows what the new commit brings."
2. "./repo has no submodule files. submodules.md holds the only submodule code of this run."
3. "The submodule change has its own review. Its code is not part of this change."
4. "Use it to check how this change calls, extends, or relies on the submodule code."

SUBMODULE_FINDER, in `finderRules` after the anchor rule, through the optional `RunFiles` argument of WP-RP0:

5. "Never anchor a finding in a submodule file or on the Subproject commit line."
6. "A problem in submodule code counts only when this change relies on it, breaks with it, or makes it reachable."
7. "Anchor it on the line of ./repo that relies on the submodule code."
8. "When unchanged code of ./repo breaks with the new submodule commit, set cause to line 1 of the submodule path, side new."
9. "The change then makes the problem reachable, so set preexisting to false."

SUBMODULE_VERIFY, in `verifyRules` after the refute lines:

10. "Code that only the submodule change adds is not in the change."
11. "Confirm a candidate there only when this change relies on it, breaks with it, or makes it reachable."

Interactions:

- Line 8 uses the cause rule of catalog.ts:633 and SD21. The cause text is "Subproject commit <new hash>", at line 1, side new.
- Line 9 repeats PREEXISTING_LINES "When the change makes the problem reachable or worse ..." (catalog.ts:576) for this case. A candidate with preexisting false does not get PREEXISTING_VERIFY, including "Never refute it only because the problem is not in the change" (catalog.ts:584).
- "BASE..HEAD is the change" (catalog.ts:632) stays true. The gitlink line is part of the change.
- The Improve prompt passes no `RunFiles`, so its bytes do not change.

### 5.6 Run line and log

- The run log footer gets `Submodule context: <text>; <text>` (RunLog.tsx). A part with "not read" or "on no branch" uses the destructive color, as "Not loaded" does.
- RunLine.tsx shows only the "not read" and "on no branch" parts, as it does for "Not loaded".
- Server log: `Review run <id> submodules: <path> read (<repo> PR #<n>, <k> files, fetch <s> s); <path> not read (<reason>).` `noUrl` applies.

### 5.7 Security

- The token stays in the app. The provider reads and `fetchInto` use the GIT_CONFIG env and redaction.
- No submodule is checked out anywhere. Nothing from the submodule loads as config or instructions.
- No request goes to a host outside the server host set (SD9). `repoRemote` gives no link of another origin (fact 8).
- Titles, descriptions, commit subjects, paths, and the diff are untrusted. They stay under the banner.
- The child gets no new tool.
- Draft BRIEF.md lines (WP-SM2 adds them):
  - 3.5, after line 425: "With the variant "submodules", ./context/submodules.md holds the diff of each moved gitlink. The app reads the diff from its own cache of the submodule repository. ./repo still has no submodules."
  - Line 493, appended: "The variant "submodules" adds only a diff text file (submodule-prs.md)."
  - 3.6: "Submodule context (submodule-prs.md, variant "submodules"): a review run reads more only when its change moves a gitlink. Then the run start reads the main and the submodule repository. It can also read the REPO_READ list and the default branch. It reads each stored PR whose head is the new commit. After Gates G9 and G12 pass, it lists the open PRs of the submodule repository. It fetches the default branch, the matched PR ref, or all branches into the app cache. It sends no request to another server. All calls are GET requests or fetches."

## 6. Data

- Migration 058, or the next free number at build time: `ALTER TABLE review_run ADD COLUMN related_json TEXT`. WP-RP0 adds it.
- `RunDto.related?: { label: string; text: string; warn: boolean }[]`. The server writes the text. Older runs do not have it.
- `SubmoduleChange = { path; old: string | null; new: string | null; oldUrl: string | null; newUrl: string | null }`.
- `SubmoduleRead = { path; repo: { project; slug } | null; outcome; pr: { id; title; author; state; source; target; description } | null; prs: number[]; files: number; cut: string[] }`.
- `finderRules(p, main, files?: RunFiles)`. `RunFiles.submodules?: boolean`.
- The judge gets an optional `gitlinks: Map<path, { old: string | null; new: string | null }>`.
- `createReviewJobs` gets an optional `submoduleReader`: the provider members `origin`, `repository`, `readableRepos`, `defaultBranch`, `getPullRequest`, and `listOpenPullRequests`. The eval passes a stub.
- The constants in src/server/review/submodules.ts are `SUBMODULES_MAX` 5, `SUBMODULE_COMMITS_SHOWN` 20, and `SUBMODULE_FILES_SHOWN` 200. The file cap reuses `CANDIDATES_BYTES`, the description cap reuses `DESCRIPTION_BYTES`, and the read deadline reuses `PEER_READ_MS`.
- The submodule cache gets the refs `refs/rl/sub/base`, `refs/rl/sub/pr`, and `refs/rl/sub/heads/*`. The next fetch moves them. `--prune` removes the refs of deleted branches. Nothing else deletes them, as for the task refs `refs/rl/task/<task>/sub/*`.

## 7. Eval and proof

- The natural set: SD3 makes the variant a no-op when no case moves a gitlink. Unverified: no case of the local set moves a gitlink. WP-SM3 checks this with `git diff --raw` over the case ranges.

### Probe cases (WP-SM3)

Three cases in fixtures/eval/probe/. `case.json` gets `submodule: { path, url }`. `sub/base/` and `sub/head.patch` build the submodule repository.

| ID | Seeded | Expected |
|---|---|---|
| probe-sub-signature | The submodule change swaps the parameters of `clamp(value, min, max)` to `clamp(min, max, value)`. The main change moves the commit and adds a call with the old order. | Must-find, major, on the new call line. Trap: a second new call that uses the new order. |
| probe-sub-caller | The submodule change makes `parseQuota("unlimited")` return null instead of -1. The main change moves the commit only. An unchanged caller compares the result with 0. | Must-find, major, on the unchanged caller line, with its cause on the gitlink line. |
| probe-sub-unreached | The submodule change has a wrong branch for negative input in `scale`. The main change calls `scale` only with constants above zero. | Clean. Trap on the main call line. |

- Harness: `buildRepo` (scripts/eval/cases.ts) makes a bare submodule repository with a base and a head commit. It writes .gitmodules and the gitlink to the main base commit, then moves the gitlink in the head commit with `git update-index --cacheinfo 160000,<hash>,<path>`.
- run.ts passes `repoRemote` (the URL goes to the local bare repository) and a `submoduleReader` stub. The stub gives the clone link `<BASE_URL>/scm/eval/<repo>.git` and no PRs.
- Without "submodules", the same cases run with no file. That is the control.
- Unverified: the probe matcher accepts a must-find on an unchanged line. WP-SM3 checks it.

### Gate SM-P (probe, the user runs it)

- `bun run eval -- --set probe --cases probe-sub-signature,probe-sub-caller,probe-sub-unreached --repeat 3`, once with `--variants submodules` and once without.
- Pass: with the variant, each must-find is found in at least 2 of 3 runs. The trap hits are 0 over the 9 runs. The count of failed runs does not rise. Cost per case rises by at most 25%.

### Gate SM-B (manual, the user)

- Pick 5 real PRs that move a gitlink. At least 3 have an open submodule PR. At least 1 has a large submodule repository.
- Run a review with "submodules" and one without on each PR.
- For each PR, record these items:
  - the run line
  - the fetch time of the first and the second run
  - whether the run read submodules.md (Read event)
  - the findings that used submodule facts
  - the findings that blame submodule-only code without a reliance
- Ship rule: no finding blames submodule-only code without a reliance. The user judges the value and decides WP-SM4.

## 8. Cost

- A PR without a moved gitlink: one local `git diff --raw` call and no read.
- A PR with one moved gitlink: 3 to 6 GET requests. The REPO_READ list can add up to 10 pages when the candidate key does not match. After the gate, the open-PR list adds 1 more read.
- The first fetch is a full fetch of the submodule repository. Later fetches add only new objects. Unverified times; Gate SM-B records them.
- The file is at most 200 KB, and the model reads what it needs. The estimate is +$0.05 to +$0.30 per run. Unverified.
- Gate SM-P: 18 probe runs at about $0.15 each, about $3. Unverified.
- Build: about 700 to 1,000 lines with tests over WP-RP0 to WP-SM3. Unverified.

## 9. Acceptance criteria

- AC-SM1. Without "submodules", the app sends no new request and runs no new git call. Every prompt, context file, and judge input is byte-identical to prompt 2.9.
- AC-SM2. With "submodules" and no moved gitlink, the same as AC-SM1, except for one local git call. Only the stored prompt version gets "+submodules".
- AC-SM3. A moved gitlink of a repository on this server gives submodules.md with the summary, the old..new diff, and the run line.
- AC-SM4. A URL of another server gets no request. A repository without read access gets the "not read" line.
- AC-SM5. The section shows a stored or a listed PR whose head is the new commit. Before Gates G9 and G12 pass, the app reads no open-PR list.
- AC-SM6. The file stays within 200 KB. It cuts at file boundaries and keeps the summaries.
- AC-SM7. Fetches write only under refs/rl/sub/ of the submodule cache. No error shows the token. The run folder has no submodule checkout.
- AC-SM8. A finding on an unchanged caller with its cause on the gitlink line stays in the change.
- AC-SM9. Ask, reply, fix, discuss, Explain, session, and task runs get no submodule step.
- AC-SM10. Cancel during the step cancels the run. A failed fetch does not stop the run.

## 10. Work packages

| # | Package | Tier | Files | Tests | Done when |
|---|---|---|---|---|---|
| 1 | WP-RP0: related context run line, shared with stacked-prs.md | implementer | src/server/storage/migrations/058_run_related.sql (or the next free number); src/server/review/run-rows.ts (read and write related_json); src/shared/dto.ts (RunDto.related); src/web/review/model.ts, RunLog.tsx, RunLine.tsx; src/server/review/catalog.ts (`finderRules(p, main, files?: RunFiles)`, no new line) | run-rows: a round trip, and an old row without a value. model.ts: the text and the warn color. Prompt snapshots do not change. | `bun run check` is green. No run writes related_json yet. |
| 2 | WP-SM0: shared mapping and fetch option | implementer | src/server/tasks/repos.ts (export `serverHosts`, `mapRepoUrl`, and `gitmoduleUrls`, extracted from `resolveTaskRepos` and `readGitlinks` with no behavior change); src/server/review/workspace.ts (`fetchInto` gets an optional `prune`) | tests/tasks/repos.test.ts stays green with no edit. New `mapRepoUrl` tests: a relative URL, the scp form, another server, a candidate miss with a REPO_READ hit, and no match. workspace test: `prune` removes a deleted branch ref only under its refspec. | `bun run check` is green. |
| 3 | WP-SM1: prompt lines and the gitlink cause | implementer | src/server/review/catalog.ts (RunFiles.submodules, SUBMODULE_LINES, SUBMODULE_FINDER, SUBMODULE_VERIFY); src/server/review/judge.ts (optional gitlinks) | prompt.test.ts: each group with and without the flag; snapshots of all agents without it; the Improve prompt. Judge test: with gitlinks, a finding on an unchanged caller with its cause on line 1 of a gitlink path stays. Without gitlinks, it drops as "unchanged". | `bun run check` is green. AC-SM8. |
| 4 | WP-SM2: detection, fetch, file, run line, variant | implementer-xhigh | src/server/review/submodules.ts (new); src/server/review/jobs.ts (the step after the workspace, Cancel, the RunFiles flag, the judge gitlinks, related_json, the log line, `submoduleReader`); src/shared/dto.ts (VARIANTS "submodules"); BRIEF.md (the lines of section 5.7); tests/e2e/submodules.e2e.ts | tests/review/submodules.test.ts with the fake Bitbucket and the bare repositories of repos-fixture.ts: each row of section 5.2, the stored match with its read, the list match only with `peerReads`, several matches, a refused PR ref with the branch fallback, a commit on no branch, two paths with one fetch, the equal share and the file-boundary cut, a nested gitlink, a re-review on the merge base, Cancel, token redaction, refs only under refs/rl/sub/ with `pruneRefs` leaving them, no request to the other server, and byte-identical prompts without a moved gitlink. e2e on a `taskRepoSet`-style fixture: the RunLog footer shows the line. | AC-SM1 to AC-SM7, AC-SM9, AC-SM10. `bun run check` and `bun run test:e2e` are green. |
| 5 | WP-SM3: probe cases and harness | implementer | fixtures/eval/probe/probe-sub-* (3 cases); scripts/eval/cases.ts; scripts/eval/run.ts; docs/eval/local.md | tests/eval/harness.test.ts: a submodule case builds both repositories and gives submodules.md with a fake claude. A case without `submodule` keeps its bytes. A check that no local-set case moves a gitlink. | `bun run check` is green. A fake run of the 3 cases shows the file. |
| 6 | Gate SM-P | user | none | Section 7. | The pass rule holds. |
| 7 | Gate SM-B | user | none | Section 7. | The user decides. |
| 8 | WP-SM4: ship as default, in the same step as WP-SK4 | implementer | src/shared/review.ts (REVIEW_PROMPT_VERSION, the next step after 2.9); jobs.ts (always on for review runs); dto.ts and scripts/eval/run.ts (remove "submodules"); spec.md (AC-SM1 to AC-SM10); README.md; CHANGELOG.md; docs/screenshots/ (`bun run screenshots`) | Snapshot updates. An old profile with "submodules" reads without it. | Each review run gets the submodule context. `bun run check` is green. |

- jobs.ts, catalog.ts, and dto.ts are also in the stack packages. Run one package at a time, in the wave RP order of review-ledger.md section 4.
- The tests use the fake claude only (tests/support/no-real-claude.ts).

## 11. Open questions

1. Should Ask, discuss, and fix runs get the file? Recommended: after WP-SM4, Ask and discuss first, as stacked-prs.md question 5.
2. A re-review range: merge base..head or range base..head? Recommended: merge base, because the whole PR relies on the moved commit.
3. Should the fetch have its own time cap? Recommended: no in v1. Gate SM-B records the first fetch time. Add a cap only when a fetch blocks a run.
4. Should an open PR count when its commits hold the new commit but its head moved on? Recommended: yes, in a later package. It needs the PR head and target in the cache and two `merge-base --is-ancestor` checks. v1 keeps the exact head match.
5. May a finding anchor on the gitlink line, for example "pins a commit of an unmerged branch"? Recommended: not in v1. It needs a fact that Bitbucket accepts an inline comment on a submodule path. Add that fact (U-SM1) to the G20 run when the user agrees.
6. Should a prompt line treat a commit that is not on the default branch as a question for the author? Recommended: not in v1. The file and the run line show the PR state, and Gate SM-B shows the need.
7. Should an added submodule show its file list? Recommended: not in v1. A whole repository is not a diff.
8. Old commit missing, but a PR matched: show the PR's own diff instead? Recommended: not in v1. Gate SM-B counts how often it happens.
9. Nested submodules (depth 2)? Recommended: not in v1.
10. Are the caps right: 5 submodules, 200 KB, 20 commits, 200 files? Recommended: yes, until Gate SM-B shows a cut that lost a needed fact.
11. Should rl-git read the submodule cache? Recommended: no. git-mcp binds one cache, and one text file is enough for v1.
12. Should "submodules" ship with "stack" in one version step? Recommended: yes, the next step after 2.9.

## 12. Out of scope

- A submodule checkout in any review snapshot.
- Any Bitbucket call from the claude child, or any token in the child.
- A post on the submodule PR from this run.
- Submodules on another server.
- Moved gitlinks in the natural or the seeded eval set.
