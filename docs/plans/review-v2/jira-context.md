# Jira context before a review

Status: design of 2026-11-18. Approved by the user on 2026-11-18 (section 10). Not started. REVIEW_PROMPT_VERSION does not change.

## 1. Request and verdict

- Request: "Add auto-fetching of Jira tasks before a review. High-quality code review is our priority."
- Verdict: the app fetches the task text at the start of each PR run. It reads more fields: custom text fields (acceptance criteria), the issue type, versions, components, labels, all issue links, and the parent or epic text. task.md also lists other stored PRs that name the same task.
- The design reuses the Jira client, the task_context row, the Fetch route, and task.md. It adds one table, one state machine, and one fetch module. No agent prompt text changes.
- Two gates decide the ship: Gate JC-G (Jira shapes) before the client change, and Gate JC-A (eval) with Gate JC-B (manual) before the new task.md sections ship.

## 2. Facts

- Sync matches task keys from the branch, the title, and the description, in this order, at most 50 (src/server/tasks/rules.ts:11-17). writeTasks deletes and inserts all pr_task rows of a PR (rules.ts:200-205). So no state can live in pr_task.
- Each task rule can list allowed project keys (src/shared/dto.ts:103). This is an allow-list that already exists.
- Jira gets a request only on a Fetch click or a settings save today (src/server/context/routes.ts:6, 183-217). BRIEF lines 66, 130, 171, and 214 say "on a click".
- The fetched text is stored once in task_context and never refreshed (migration 013). Every PR run reads the rows as they are (src/server/review/jobs.ts:852, src/server/context/task-file.ts:240-266).
- One issue read is one GET plus up to 5 comment pages, each with a 30 s timeout (src/server/context/jira.ts:17-19, 336-413). The client takes no outside signal.
- The read asks for summary, description, status, attachment, parent, subtasks, and issuelinks (jira.ts:340). It keeps only links to other sub-tasks (jira.ts:201-207, 346). The sub-task code reads that `links` field (src/server/tasks/tasks.ts:2600, 2934; task-file.ts:387).
- The profile switch jiraFamily adds the parent and the sub-tasks to task.md. The run reads each parent with one GET at its start, with no time limit (jobs.ts:850, task-file.ts:188-208). The shipped profiles set it to false (src/server/review/catalog.ts:116, 136).
- A Build task with an origin PR reads its issue from task_context of that PR (task-file.ts:281-291). "Read Jira again" writes the same row (tasks.ts:2901-2905).
- The run row stores the fetched tasks at insert time, before steps() runs (jobs.ts:2040, src/server/review/run-rows.ts:167). The run line shows them (src/web/review/tasks.ts:76-83).
- steps() serves every PR run kind: review, re-review, Explain, Ask, reply, Fix, and discuss (jobs.ts:842-1107). The Build-task own review runs elsewhere with its own task.md (src/server/tasks/loop.ts:1890-1910).
- noted() adds app lines to the coverage of every run kind (jobs.ts:1097-1102).
- The intent module already says: "When task.md does not hold them, read them with an issue tool" (catalog.ts:717). The verify rule reads requirements from task.md (catalog.ts:1325).
- A change of the agent prompts fails the hash test until REVIEW_PROMPT_VERSION goes up (tests/review/prompt.test.ts:540). WP-RC3 claims "2.9" (risk-check.md section 9).
- PEER_READS is false until Gates G9 and G12 pass (src/server/review/pr-context.ts:27-30). So a review run lists no live PRs from Bitbucket. related.ts reads live PR lists and runs a git log with a 30 s timeout, for one repository only (src/server/tasks/related.ts:63-143).
- pr_task holds the keys of every stored PR, from all repositories (rules.ts:200; src/server/settings.ts:246-280).
- The run-start reads of pr-context.md use a 15 s deadline (src/server/review/context-files.ts:661, pr-context.ts:139). The codegraph index wait makes Cancel stop a wait through j.abort (jobs.ts:791-804, 1921).
- The eval seeds stored task rows into its own database and never fetches (scripts/eval/run.ts:768-783). label.ts seeds fetched_at 0 (scripts/eval/label.ts:442).
- BRIEF line 171 reads sub-task statuses at most every 5 minutes. This design takes that interval.

## 3. Decisions

### 3.1 When to fetch: at the start of each PR run

| Option | Result |
|---|---|
| At sync, in the background | Rejected. It calls Jira for PRs that nobody reviews. It adds a new kind of background outbound call. |
| At run start | Chosen. A run start is a user click. BRIEF line 171 already allows a parent GET at run start. |
| Both, with a staleness window | Rejected. Sync adds calls and no quality over run start. |
| When the Brief opens | Rejected for now. The detail pane opens PRs while the user browses (question 9). |

- Review, re-review, and Explain refresh text that is older than 5 minutes.
- Ask, reply, Fix, and discuss fetch only keys without text. They are short interactive runs.
- The reads start before the `claude auth status` check. So the wait overlaps with work that the run does anyway.
- One deadline of 15 s covers all Jira reads of a run, the parent reads included.

### 3.2 Which keys: the first 3 eligible keys in pr_task order

- Order: pr_task.ord, so branch keys come first, then title keys, then description keys.
- Eligible: a valid key that is not skipped, has no sticky failure, and no Build task reads from this PR.
- Cap: 3 keys. The other keys without text get one coverage line. Keys with text from a Fetch click still go to the run.
- Noise keys such as `UTF-8` fail once with not_found. not_found is sticky, so the key leaves the eligible list.
- The rule allow-list (dto.ts:103) restricts keys to the user's projects. No new setting.
- Rejected: a Jira project list. GET /rest/api/2/project is deprecated on Cloud, and a 404 gives the same result.

### 3.3 Which fields: one read of all fields with names and schema

- The read becomes `GET /rest/api/2/issue/{key}?fields=*all,-comment,-worklog&expand=renderedFields,names,schema`. Gate JC-G verifies the shape first.
- Custom text fields: each field whose schema.custom is the textarea type and whose value is not empty. The field name labels it. This finds acceptance criteria in any language without a name match.
- Epic link (Data Center): the field whose schema.custom is the epic-link type, with a key value.
- Fixed fields: issue type, labels, components, fix versions.
- Issue links: every link with the link phrase, the key, the summary, the status, the status category, and the issue type. The read gets them in the same answer.
- Parent text: one GET of `parent`, else of the epic key, at each fetch. It is stored in the row, so the eval can replay it. No per-run parent GET for new rows.
- Not read: descriptions of linked issues, remote links, people fields, and history.

Caps (jira.ts CAPS):

| Part | Cap |
|---|---|
| Custom text fields | 10 fields, 5,000 characters each |
| Labels, components, fix versions | 20 each |
| Issue links | 50 |
| Total bytes | 200,000 as today. Summary, description, and custom text fields count first. Comments get the rest. |

### 3.4 Related work: stored PRs from all repositories

- task.md lists other stored PRs whose pr_task keys include a fetched key or its parent or epic key. It is one SQL join with no network call and no regex.
- Each line holds the repository, the PR number, the state, the branches, and the title. It holds no URL: the model cannot open it, and it names the host.
- At most 20 lines. Open first, then merged, then declined. Newest first in each group.
- Rejected for reviews: related.ts. Its live PR lists bypass the PEER_READS gate. Its git log adds up to 30 s per run.
- Rejected for now: the Jira development panel (question 8).

### 3.5 Prompt and profiles

- No prompt text changes. The intent module and the verify rule already read task.md first. REVIEW_PROMPT_VERSION stays "2.8". The hash test proves it.
- jiraFamily becomes true in the shipped Review and Explain profiles after Gate JC-A (question 4). PROFILES_VERSION becomes the next number (10 today).
- That package adds "jiraFamily" to the Former Pick, FORMER[9] = { general: { jiraFamily: false }, explain: { jiraFamily: false } }, and true in the new-profile default (src/web/settings/profiles.ts:227).

### 3.6 UI

- The task chips show the fetch state. There is no new panel and no new setting.
- Clear keeps its place and its label. It now also stops automatic reads of that key. A key without text, never fetched or failed, gets Skip, which does the same (WP-JC4).

## 4. Design

### 4.1 Fetch flow at run start

1. steps() calls `autoFetch(db, pr, kind, jira)` before `check()`. The call never rejects.
2. autoFetch reads pr_task, task_context, task_fetch, and task (origin_pr, key) rows. It picks the keys (section 3.2) and applies `due()` (section 4.4).
3. Each due key gets one shared read: the issue, then the parent or epic. A map of in-flight reads by key and JIRA_SAVED count keeps one Jira read per key at a time. Runs and the POST route share it. A read after a Jira settings save starts anew (section 4.4).
4. A write follows each read, per (pr, key). The write applies the machine event in one transaction (section 4.4). The write goes to the database of the read start. If settings changed the database, the write drops the result.
5. steps() waits for the reads, at most 15 s from their start. A new j.abort makes Cancel end the wait at once.
6. steps() updates review_run.tasks_json with the current rows (new SQL `setTasks` in run-rows.ts).
7. The parent wait (taskParents) gets the rest of the same 15 s.
8. task.md is built from the rows as they are now. A later result goes to the next run.
9. noted() adds the lines of section 4.6.

### 4.2 Jira read

- read() in jira.ts sends the new query. The zod schema of the answer adds `names` and `schema` as optional records.
- read() extracts the fields of section 3.3. A missing names or schema gives no custom text fields, logs one line, and does not fail the read.
- `links` keeps its meaning for the sub-task code. The new field `related` holds all links.
- fetchParent stays as is. The PR fetch path calls it after the issue read. A failed parent read stores `parentIssue: null` and logs one line.
- New optional IssueContext fields (src/shared/dto.ts): `type`, `labels`, `components`, `versions`, `texts: {id, name, text}[]`, `epic`, `related: {key, text, summary, status, category, type}[]`, `parentIssue: IssueParent | null`. Old rows parse unchanged.
- The answer of `*all` holds people fields, such as the reporter and the assignee. read() keeps none of them.

### 4.3 Storage and migration

New migration with the next free number at build time. 055 is claimed by PS7b (ps6-ps7-plan.md:19, 42).

- Table `task_fetch(pr, key, state, kind, at)`, PRIMARY KEY (pr, key), WITHOUT ROWID.
- pr references pull_request(id) ON DELETE CASCADE.
- state is 'failed' or 'skipped'. kind is a ContextErrorKind, present only for 'failed'. at is in ms.
- No row: state none or fetched, by the task_context row.
- task_context keeps its shape. The upsert keeps the downloaded attachments (routes.ts:208-211).
- Nothing persists "fetching". A restart needs no recovery.

### 4.4 State machine

House form: an XState v5 machine as a pure transition function in src/server/context/fetch-machine.ts, as in src/server/tasks/machine.ts. writeFetch() in task-fetch.ts is the only writer of task_context and task_fetch rows. The DELETE route of a task's attachments stays as is.

Persisted states:

| State | task_context row | task_fetch row |
|---|---|---|
| none | no | no |
| fetched | yes | no |
| failed | no | failed, kind, at |
| refreshFailed | yes | failed, kind, at |
| skipped | no | skipped, at |

Transitions (blank: the event is ignored, and nothing is written):

| State | AUTO_OK | AUTO_ERR | MANUAL_OK | MANUAL_ERR | CLEAR | JIRA_SAVED |
|---|---|---|---|---|---|---|
| none | fetched | failed | fetched | failed | skipped | none |
| fetched | fetched | refreshFailed | fetched | refreshFailed | skipped | fetched |
| failed | fetched | failed | fetched | failed | skipped | none |
| refreshFailed | fetched | refreshFailed | fetched | refreshFailed | skipped | fetched |
| skipped | | | fetched | failed | | skipped |

- AUTO_OK and AUTO_ERR also need: pr_task names the key, and no task row has (origin_pr, key) = (pr, key). Else the result drops.
- MANUAL_OK and MANUAL_ERR need pr_task to name the key, as today (routes.ts:188, 207).
- AUTO_ERR and MANUAL_ERR also need a read that started after the last JIRA_SAVED of this database. Else the error drops, because the read can have used the old token. Each read carries the JIRA_SAVED count at its start. A read after a save never joins a read from before it. AUTO_OK and MANUAL_OK need no such check.
- CLEAR in none needs pr_task to name the key, so a DELETE of an unknown key writes no row. CLEAR in the other states has no guard. The chip offers Skip for a key without text and Clear text for a key with text. Both send CLEAR.
- The AUTO_* events come from writes after an automatic read. MANUAL_* come from POST /prs/:id/task-context/:key. CLEAR comes from DELETE. JIRA_SAVED comes from a successful PUT /settings/jira.
- Write effects: fetched upserts the text with fetched_at = now and deletes the task_fetch row. failed and refreshFailed upsert the task_fetch row. skipped deletes the text, its attachment rows, and its files, as today, and upserts the task_fetch row. A key without text has no files, so the delete of its folder does nothing. JIRA_SAVED deletes all 'failed' rows.

Start of an automatic read, `due()` (a pure function with its own table test):

| State | Review, re-review, Explain | Ask, reply, Fix, discuss |
|---|---|---|
| none | start | start |
| fetched | start when fetched_at is 5 min old or older | no |
| failed, sticky kind | no | no |
| failed, other kind | start when the failure is 5 min old or older | the same |
| refreshFailed, sticky kind | no | no |
| refreshFailed, other kind | start when the failure is 5 min old or older | no |
| skipped | no | no |

- Sticky kinds: auth, forbidden, not_found, redirect. Other kinds: rate, server, shape, timeout, network.
- A key that a Build task reads from this PR never starts an automatic read.
- An error that is not a ContextError counts as kind server. The log gets its name only.

### 4.5 task.md layout

- Each task section keeps its current lines. New lines and sections come only when the row has the new fields. So an old row gives the same bytes as today.
- Order in a task section: the head lines, then "- Type", "- Fix versions", "- Components", "- Labels". Then Description, then one "### <field name>" per custom text field, ordered by field ID. Then "### Linked issues", then Comments, then Attachments. Then the family sections when jiraFamily is on.
- "### Linked issues": one line each, "- <this key> <link phrase> <key>: <summary> (<status>, <type>)".
- Family: taskParents uses the stored parentIssue. It reads Jira only for a row without that field (old rows).
- The end of task.md: "## Other pull requests that name these tasks", only when the join finds a PR.
- Build tasks use the same renderIssue, so their task.md also gets the new fields (question 5). Sub-task sections leave out "### Linked issues", because their "Link:" lines exist.
- Contract for the obligations step: criteria appear as "### <Jira field name>" under "## Task <KEY>", or in the description.

### 4.6 Coverage lines and log lines

- A failed read of this run, no text: "Task <KEY>: not fetched. <FAILED[kind]>"
- A failed refresh: "Task <KEY>: the run used the text fetched <date>. The refresh failed. <FAILED[kind]>"
- Deadline: "Task <KEY>: Jira did not answer in 15 s. The next run gets the text if it arrives."
- Cap: "Tasks <KEYS>: not fetched. A run fetches at most 3 tasks. Fetch more in the brief."
- CA file: "Task text: not fetched. The app cannot read the Jira CA file."
- Parent deadline (jiraFamily on): "Parent <KEY>: not read in time."
- No line for Jira not set up, for skipped keys, or for sticky failures of earlier runs. The chips show them.
- Log: "Review run <id>: task text: <n> fetched, <m> failed, <k> as stored, in <ms> ms." No text, token, or email.

### 4.7 Run kinds

| Run | Automatic read |
|---|---|
| Review, re-review, Explain | yes, with refresh |
| Ask, reply, Fix, discuss | only keys without text |
| Session consult | no (it reads no task.md) |
| Build-task own review and task steps | no (they read the task's own issue) |
| A user review of a task PR | yes, except the key of a task that has this PR as origin |

### 4.8 UI

- GET /prs/:id/task-fetch returns `TaskFetchDto[]`: {key, state, kind, reason, at}. reason is FAILED[kind] or null.
- useTaskChips adds the query ["pr", id, "task-fetch"]. The SSE `changed` refetch covers it. DELETE and the writes broadcast `changed`.
- Chip state text: "fetched 2 min ago" (exists), "fetched 3 days ago, refresh failed", "not fetched: <short reason>", "skipped", "not fetched" (exists). A Hint shows the full reason.
- Short reasons: token rejected, no access, no such issue, Jira redirected, Jira busy, Jira error, unknown answer, timed out, Jira unreachable.
- The full chip in the Brief shows the source, then the state for failed and skipped keys.
- Skip sends CLEAR for a key without text that is not skipped: never fetched or failed. It needs no confirm, because it deletes no text. Clear text sends CLEAR for a key with text, after a confirm. Fetch ends a skip.
- The chip state text wraps on a narrow pane. The key and the buttons do not wrap.

### 4.9 Security

- jira.ts stays the only module that sends requests to Jira. Requests are GET only, to the configured origin, with no redirect.
- ContextError messages hold no token, header, or answer text (src/server/context/source.ts:12-22). The coverage uses the fixed FAILED texts.
- task.md keeps the UNTRUSTED banner. Field names, field values, link summaries, and PR titles are untrusted data.
- No email, token, or people field goes into a row, a log, a DTO, or a prompt.

## 5. Gates and eval

### Gate JC-G: Jira shapes (user, read only)

New checks in `bun run gate:jira`. They print status codes, key names, counts, bytes, and ms only.

| Fact | What it records |
|---|---|
| J5 | The `*all` read with names and schema: HTTP status, bytes, names and schema present, the count of textarea fields with a value, rendered values present, the epic-link field and value shape, and the keys of issuetype, labels, components, and fixVersions. |
| J6 | J2 again on an issue with links (`--links-issue <KEY>`): link entry keys, and the field keys of inwardIssue and outwardIssue (summary, status, statusCategory, issuetype). |
| J7 | Time in ms of the J5 read, one comment page, and one parent read. |

- If names or schema are absent, WP-JC1 reads the field list from GET /rest/api/2/field once per settings and asks for the fields by ID.
- Cloud rows stay UNVERIFIED until part N of smoke-r3.md runs.

### Gate JC-A: eval (user)

- A finder replay cannot show a context change. So the gate runs live finder runs on the local set.
- Data: `scripts/eval/refetch-tasks.ts` (WP-JC-E) reads the case files and fetches the first 3 keys of each case with the user's Jira, read only. It writes `tasks-overlay.json` beside the set. It drops comments created after the case head commit. It prints counts only.
- Known bias: statuses and descriptions are from today, not from the PR time. The bias favors the candidate. So Gate JC-A proves "not worse" only, and Gate JC-B shows the value.
- Control: stored rows, jiraFamily off. Candidate: `--candidate-tasks-overlay <file> --candidate-jira-family`. Same build, prompt 2.8, `--effort medium`. Then eval:label and eval:compare. Exact flags are unverified.
- run.ts checks that the harness settings have no Jira (settings.jira() gives null), so eval runs never call Jira.
- Ship rule, candidate against control, on cases with at least one task key:
  1. Grounded recall: the mean is at least the control mean minus S_R (as in risk-check.md section 7).
  2. Noise follows the noise rule of review-quality-2026.md section 2, decided by the user on 2026-11-21. This gate is a full candidate run. The paired grounded noise delta against the control is at most 10% of the control mean per case. The paired judge fp delta per case run is at most 0.07.
  3. Findings of module intent: gold matches plus judge tp are at least judge fp.
  4. Cost per case rises by 25% or less. Above that, the user decides.
  5. The overlay adds text to at least half of the task cases. Else the result is INFO, and Gate JC-B decides.
- If rules 1 to 3 fail, run a second candidate without `--candidate-jira-family`.

### Gate JC-B: the 5 comparison PRs (user, manual)

- Run a review of each PR with "Parent and sub-tasks" on in the user's profile.
- Record: case (a), the criterion met only in part, as found or asked with the criterion quoted. Record case (b), the closed related ticket, as found, asked, or missed. Record the run-start read time from the log line.
- Pass: case (a) is found or asked with the quote. No requirement finding is discarded as wrong. The read time is at most 2 s on the median PR.

## 6. Acceptance criteria

- AC-JC1. A review of a PR with key K and no text reads K before task.md is built. task.md holds the text of K.
- AC-JC2. Review, re-review, and Explain read again a text that is 5 min old or older. A younger text gets no request.
- AC-JC3. Ask, reply, Fix, and discuss send no Jira request for a key with text.
- AC-JC4. A run reads at most 3 keys in pr_task order. Skipped keys, sticky failures, and task-owned keys do not count.
- AC-JC5. A run waits at most 15 s for Jira. Cancel ends the wait at once. A late result is stored for the next run.
- AC-JC6. A failed read never fails a run. Coverage gets the lines of section 4.6.
- AC-JC7. Without Jira settings, a run sends no request and adds no line.
- AC-JC8. Clear makes the key skipped. No automatic read changes it. Fetch ends the skip.
- AC-JC9. Sticky failures get no automatic retry until Fetch or a Jira settings save. Other failures retry after 5 min.
- AC-JC10. Two runs and a Fetch of the same key at the same time send one issue read.
- AC-JC11. The run line shows the fetch time of the text that the run used.
- AC-JC12. An automatic read never writes a row that a Build task reads.
- AC-JC13. The read stores the fields of section 3.3 within the caps. `links` keeps only sibling sub-task links.
- AC-JC14. A row without the new fields gives the same task.md bytes as before.
- AC-JC15. task.md lists other stored PRs that name a fetched key or its parent key, at most 20, without URLs.
- AC-JC16. No agent prompt text changes. REVIEW_PROMPT_VERSION stays. The hash test stays green.
- AC-JC17. The chips show the states of section 4.8. No new panel or setting.
- AC-JC18. No token, email, or people field reaches task.md, a log, a row, or a DTO.

## 7. Tests

Tests never call a live Jira. Unit tests use tests/support/fake-jira.ts. e2e uses the fake Jira on E2E_JIRA_PORT.

- tests/context/jira.test.ts: field extraction, caps, field-ID order, epic link, all links, no names or schema, people fields absent, sibling-only `links` for scope reads.
- tests/context/fetch-machine.test.ts: every table cell, reachability, no dead end, and a scan that each event has a sender in code.
- tests/context/task-fetch.test.ts: key choice, due() table, deadline with late write, late write after Clear, in-flight sharing, parent stored, JIRA_SAVED, CA file line, no Jira.
- tests/context/routes.test.ts: DELETE gives skipped, POST ends skipped, POST failure stores failed, GET task-fetch, the request counts of the existing tests.
- tests/context/task-file.test.ts: the byte snapshot of an old row, the new sections, the PR join (self out, cap, order), the stored parent.
- tests/review/jobs.test.ts: run-start read, tasks_json update, coverage lines, Ask without a request, a slow fake Jira with the run start within the limit, Cancel during the wait. Update the reads at lines 1942-1960.
- e2e: a new tests/e2e/task-fetch.e2e.ts for the chip states. WP-JC3 fixes the existing e2e that the automatic read changes.

## 8. Work packages

| # | Package | Tier | Files | Done when | Main risk |
|---|---|---|---|---|---|
| 1 | WP-JC-D: docs | implementer | BRIEF.md (lines 66, 130, 171, 214, 573), docs/plans/review-v2/spec.md (AC-JC1 to AC-JC18), integration-check.md (J5 to J7 NOT RUN), CLAUDE.md status line | The user approved questions 1 to 6. | Wording that disagrees with the code later. |
| 2 | WP-JC0: probe | implementer | scripts/gate/jira.ts, tests/gate/jira.test.ts, tests/support/fake-jira.ts | The dry run passes. `bun run check` is green. | The fake shape differs from the real one. Gate JC-G finds that. |
| 3 | Gate JC-G | user | none | J5 to J7 are recorded. | None. |
| 4 | WP-JC1: client | implementer | src/shared/dto.ts, src/server/context/jira.ts, tests/context/jira.test.ts | AC-JC13, AC-JC18. | dto.ts conflict with WP-RC1. Start after WP-RC1 is committed. |
| 5 | WP-JC2: state and fetch | implementer-xhigh | new src/server/context/fetch-machine.ts, new src/server/context/task-fetch.ts, new migration, src/server/context/routes.ts, new tests/context/fetch-machine.test.ts and task-fetch.test.ts, tests/context/routes.test.ts | AC-JC4, 5, 8, 9, 10, 12 in unit tests. | Races between late writes, Clear, and a database change. |
| 6 | WP-JC3: run wiring | implementer-xhigh | src/server/review/jobs.ts, src/server/review/run-rows.ts, tests/review/jobs.test.ts, the affected tests/e2e/*.e2e.ts | AC-JC1 to 3, 6, 7, 11. `bun run check` and `bun run test:e2e` are green. | jobs.ts conflict. Run after WP-RC1, never at the same time as WP-RC3 or an obligations package. |
| 7 | WP-JC4: UI and user docs | implementer | src/web/review/TaskChips.tsx, src/web/review/tasks.ts, its web test, new tests/e2e/task-fetch.e2e.ts, README.md, CHANGELOG.md, docs/screenshots (`bun run screenshots`), docs/smoke-r3.md | AC-JC17. The screenshots hold no real names. The shadcn and web-design-guidelines skills ran. First ship point. | The chip text gets too long on narrow panes. |
| 8 | WP-JC5: task.md sections | implementer | src/server/context/task-file.ts, tests/context/task-file.test.ts | AC-JC14, AC-JC15. On a branch. No push before Gates JC-A and JC-B. | More text dilutes the review. The gates measure it. |
| 9 | WP-JC-E: eval | implementer | scripts/eval/run.ts, ab.ts, cases.ts, new scripts/eval/refetch-tasks.ts, tests/eval/*.test.ts, docs/eval/local.md | A fake replay applies the overlay and the flag. The no-Jira check exists. | run.ts conflict. Start after WP-RC2 and WP-RC3 are committed. |
| 10 | Gates JC-A and JC-B | user | none | Section 5. | Overlay bias. JC-B decides the value. |
| 11 | WP-JC6: family on by default | implementer | src/server/config.ts, src/server/review/catalog.ts, src/web/settings/profiles.ts, the profile upgrade tests, BRIEF.md line 454, CHANGELOG.md | An unedited profile upgrades to true. An edited true stays. Second ship point. | catalog.ts conflict. Start after WP-RC3 is committed. |

Order rules:

- WP-JC-D, WP-JC0, WP-JC2, and WP-JC5 do not touch the risk-check files. WP-JC2 and WP-JC5 need the WP-JC1 types.
- The obligations step reads task.md. It must not edit task-file.ts while WP-JC5 runs.

## 9. Invariants

- No pr_task state: writeTasks replaces the rows (rules.ts:200-205).
- `links` keeps its meaning for the sub-task code (tasks.ts:2600, 2934).
- A Build task reads the origin PR row (task-file.ts:281-291). An automatic write never changes it.
- The upsert keeps attachments. Only a delete cascades (routes.ts:208-211, migration 016).
- The prompt hash test guards the prompt bytes (prompt.test.ts:540).
- PEER_READS stays false. No live Bitbucket PR list in reviews (pr-context.ts:27-30).

## 10. Open questions

User decisions:

1. Change BRIEF "on a click" to "automatically at the start of each PR run, and on a click". Recommended: yes.
2. Refresh older than 5 min for review, re-review, and Explain only. Recommended: yes.
3. Cap of 3 keys per run. Recommended: 3. A count of PRs by number of pr_task rows on the user's database confirms it.
4. jiraFamily on in the shipped Review and Explain profiles after Gate JC-A. Recommended: yes.
5. The new fields in Build-task task.md too. Recommended: yes.
6. An off switch for the automatic read. Recommended: no. The Jira setup is the consent, and Clear works per key.
7. A setting for extra criteria fields, such as a checklist app. Recommended: only if Gate JC-G shows criteria outside textarea fields.
8. Cross-repository PRs from the Jira development panel. It is an internal Jira API. Recommended: not now.
9. A read when the Brief opens. Recommended: no.

Unverified:

- U-JC1. Server 9.12 and Cloud v2 accept `fields=*all,-comment,-worklog` with `expand=names,schema` (Gate J5).
- U-JC2. The textarea type key and the epic-link type key (Gate J5).
- U-JC3. issuelinks entries hold summary, status, statusCategory, and issuetype (Gate J6, J2 is open).
- U-JC4. The pull_request table keeps merged and declined PRs long enough for section 3.4.
- U-JC5. The eval harness settings have no Jira. WP-JC-E adds the check.
- U-JC6. A field over the 10 MB body cap fails the `*all` read. The narrow read had no such risk. No fallback is planned.

### User answers of 2026-11-18

The user took the recommended answers ("let's do as recommended").

- Question 1: yes. BRIEF says "automatically at the start of each PR run, and on a click".
- Question 2: yes. Review, re-review, and Explain refresh a text that is 5 min old or older.
- Question 3: the cap is 3 keys per run.
- Question 4: yes. jiraFamily becomes true in the shipped Review and Explain profiles after Gate JC-A (WP-JC6).
- Question 5: yes. Build-task task.md gets the new fields too.
- Question 6: no off switch. The Jira setup is the consent, and Clear works per key.
- Question 7: a setting for extra criteria fields comes only if Gate JC-G shows criteria outside textarea fields.
- Question 8: not now.
- Question 9: no read when the Brief opens.

Gate JC-G run 1 (2026-11-18, Jira Server): the full read returns names and schema, links have summary, status with statusCategory, and issuetype, and the reads take 292 ms. The user's team writes acceptance criteria in the description or in the comments, not in a custom field. Both are read today. So question 7 needs no setting, and the custom text field read stays only for teams that use such a field.

## 11. Out of scope

- Descriptions of linked issues, remote links, and Jira history.
- Explain reuses a finished result by its run key, and the key holds no task text (run-rows.ts:226-227).
- A ledger per acceptance criterion.
- Any Jira write.
