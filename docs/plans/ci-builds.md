# CI builds plan

Status (2026-10-29): Layer A is code complete. Layer B and Layer C are ON HOLD. The CI probe ran on 2026-10-29 (integration-check.md, section "CI builds").

- Layer A reads the build status that the CI server already posts to Bitbucket. It uses the existing Bitbucket token and sends GET only.
- Layer B starts a Jenkins build. The probe showed that the plan's multibranch design does not fit the user's Jenkins. Layer B needs a new design before it resumes.
- Layer C explains why a build failed. It builds on Layer B.

## Facts

**Bitbucket**
- `provider.buildStats(commit)` reads GET `/rest/build-status/1.0/commits/stats/{commit}`. Gate G3 and probe CI2 confirm the keys cancelled, failed, inProgress, successful, and unknown.
- GET `/rest/build-status/latest/commits/{commitId}` lists up to 100 statuses (DC 9.4 OpenAPI). It needs only LICENSED. It is tagged "Deprecated" but still present. Probe CI3 confirms it: item keys dateAdded, description, key, name, state, url. There is no buildNumber and no ref.
- The repository-scoped GET `.../commits/{id}/builds` needs a `key`, so it cannot list statuses.
- A batch POST `/build-status/latest/commits/stats` exists. Its response schema is empty in the spec, so its shape is unverified. Layer A does not use it.

**Patterns copied**
- One side table per PR, as `pr_merge_result` (migration 037). An ALTER of `pull_request` makes the migration check every child table.
- Events are rows in `event` with `UNIQUE (pr, kind, ref)`. A CHECK fixes the kinds, so a new kind rebuilds the table as in migration 029. `src/web/notify.ts` is a `Record` over the kinds, so each new kind needs a text.
- After a PR create, `src/server/tasks/pr.ts` calls `syncNow()`. A sync that reads build status covers the refresh after a push with no extra code.
- The task waiting rows derive from synced data in `src/web/tasks/model.ts`, as "PR conflicts" (spec 6.18.5). A build row needs no state-machine change.

## Layer A: build status from Bitbucket (code complete)

Commits: 2734de5 (server), 58013cb (UI).

**Behavior**
- Each sync cycle reads `buildStats(head)` for the source head of each open PR that is followed and not archived. This adds one GET per open PR per cycle.
- When the head or a count changes, the sync reads the status list once (one page). It keeps at most 10 statuses: failed first, then in progress, then the others in server order. A link stays only if it is http(s).
- If the list read fails, the counts stay, and the details show as "not available".
- One shared function (`src/shared/build.ts`, `buildState`) derives the state:
  - failed if any build failed;
  - else running if any build is in progress;
  - else "none" if all counts are 0;
  - else passed if there are successes and no cancelled or unknown builds;
  - else "other".
- Events `build_failed` and `build_passed` (ref: the head) go only to the user's own PRs (role AUTHOR, task PRs included). They fire only when no build is in progress. The unique key allows at most one of each kind per head. No event fires on the first read.

**Deviations from the first plan**
- The first-event guard needs two facts: a stored build read from an earlier cycle, and a PR that had its first sync. So the first build read of a PR never notifies, even on a PR that synced before.
- A failed list read is not retried in the next cycle. The sync reads the list again only after the next head or count change.
- `readAt` is the time of the last read that changed the head or the counts. A read with no change does not update the row.

**Task view rows** (spec 6.12), after the "not pushed" row:

| Case | Status | Needs you |
|---|---|---|
| failed | "The build of your PR failed: <name>." | yes |
| running | "Waiting for <names>. The build runs." | no |
| passed | "Waiting for <names>. The build passed." | no |

- The primary button stays "Go to the PR". A build line under the status links to the build page.
- The step strip does not change. A CI build is not a step of the task machine.

**Data model: `041_build_status.sql`**
- Table `pr_build`: `pr` (INTEGER PRIMARY KEY, references `pull_request (id)`, ON DELETE CASCADE), `head` TEXT NOT NULL, `stats_json` TEXT NOT NULL, `builds_json` TEXT (NULL when the list read failed), `read_at` INTEGER NOT NULL.
- The migration rebuilds `event` as in 029 and adds the kinds `build_failed` and `build_passed`. It keeps the event rows and their IDs.

**API:** no new route. `PrRow.build`, `PrDetail` (through PrRow), `TaskPartDto.build`, and `TaskPrDto.build` carry a `BuildDto`: `{head, state, counts, builds: [{name, state, url}] | null, readAt}`. It is null when `pr_build.head` differs from `source_head`.

**UI**
- List row meta: an icon with text for "Build failed" and "Build running" only.
- PR header: a build line with the counts and the first failed name, linked through `webLink`.
- Task view: the rows above. Each PR row of a multi-repository task shows its build text.
- `notify.ts`: "build failed" and "build passed".

**Tests**
- Provider: list parsing, the http(s) filter, refusal of a bad hash, 404 handling.
- The `buildState` truth table.
- `tests/sync/builds.test.ts`: only open followed PRs are read; no list GET without a count change; a list GET after a change; one event per head, only for own PRs, never on the first read, never while a build runs; a failed list read keeps the counts; 401 and 429 still end the cycle.
- Migration 041 keeps the event rows and IDs. The inbox gives null for a stale head. The task model rows and the `notify` texts.
- e2e `tests/e2e/builds.e2e.ts` with the fake Bitbucket control `/__control/build`.
- Control mutation: drop the first-read guard. The first-read test turns red.

**Wording changes (done in WP-CA3)**
- BRIEF 3.6: a new bullet for the build status reads.
- Spec 6.10: the part gate reads `pr_build`.
- Spec 6.12: the three build rows.
- Spec 6.13: notifications for build failed and build passed on the user's own PRs.

**Main risk:** one extra GET per open PR per cycle. Add the batch stats POST only if rate limits become a problem.

## Probe: `bun run gate:ci -- <PR URL>` (WP-CI0, done)

- File: `scripts/gate/ci.ts`. Flags: `[--jenkins <base>] [--jenkins-user <u>] [--job <path>] [--authorize-build] [--authorize-scan] [--dry-run]`.
- Tokens: Bitbucket uses `GATE_BITBUCKET_TOKEN`, else the stored token. Jenkins uses only the `GATE_JENKINS_TOKEN` environment variable, never argv.
- Output: status codes, booleans, counts, key names, enum-like states, Jenkins class names, and the version only. The script masks the hosts, the project, repository, branch, job segments, user names, and tokens. It exits with code 3 if a sensitive string remains. The sanitized JSON goes to `.gate0/ci/`, which git ignores.
- The checks CI1 to CI11 and their results are in integration-check.md.

## Probe facts for Layer B (2026-10-29)

- The job of the user's team is a single pipeline job (WorkflowJob), not a multibranch project. It has no sub-jobs and no PR jobs.
- The branch is a build parameter. Its name differs per project. Some jobs use a parameter in the style of BRANCH_NAME. One repository defines its parameters in its own Jenkinsfile.
- An API token is exempt from the crumb. A POST with the token only returned HTTP 200.
- The crumb issuer is on. The crumb field is `Jenkins-Crumb`.
- The status URL has the Jenkins origin, but two path segments come before `/job/`. So the app cannot take the job path from the status URL.
- A Jenkins API token works only on the server that made it. A token from another Jenkins server gave HTTP 401.
- Jenkins 2.555.3 answered whoAmI.

## Layer B: start a Jenkins build (ON HOLD)

Layer B must be redesigned for one job with a branch parameter per repository before it resumes. The parts below still apply to that design.

**Settings**
- A Jenkins card in Settings holds the base URL (https, or http on loopback only; a context path is allowed), the user name, the CA file, and the API token.
- The token goes only into the OS store under `jenkins-token`. URL, user, and CA file go into the config file as `jenkins: {baseUrl, user, caFile}`, as for Jira.
- Save checks the token with `GET /whoAmI/api/json` (200, `authenticated` true, `anonymous` false). A "Test" button runs the same check without a save.
- A new origin needs a new token, because a token works only on its own server.
- Messages: 401 "Jenkins rejected the user name or API token. Make a new token in Jenkins and save it again." 403 "Jenkins accepted the login, but user <u> may not <action> <path>. Ask a Jenkins admin for Job/Read and Job/Build." 404 "Jenkins has no job at <path>." 3xx "Jenkins answered with a redirect. Use the Jenkins URL that the browser shows after login."

**Job mapping (to redesign)**
- One row per repository: the job path and the name of the branch parameter. The user enters both. The app makes no name guess.
- A path has at most 10 segments. Empty segments and `.` or `..` are refused. It becomes `/job/<encodeURIComponent(seg)>/…`.
- The status URL cannot prefill the path (see the probe facts).
- Open: how to find the parameter name when a repository defines its parameters in its own Jenkinsfile. The probe check CI8 must read the job parameters first.

**Trigger (to redesign)**
- A job with parameters uses `buildWithParameters`. A POST to `/build` on a parameterized job fails without a form (`ParameterizedJobMixIn.java`).
- If `buildable` is false, the start fails: the job is disabled.
- The API token is exempt from the crumb, so the POST sends no crumb. A crumb 403 is an error with its own message.
- A 201 with Location: the app takes only `/queue/item/(\d+)/` from it and builds all URLs from the Settings base URL. A redirect to "." means nothing was queued, which is a failure.
- The app reads `/queue/item/<id>/api/json?tree=_class,why,cancelled,executable[number]` every 3 s, for at most 10 min. A build number means started: the app calls `syncNow()`, and Layer A takes over. `cancelled` means failed. A 404 or the time cap means "lost".
- The app does not poll Jenkins for the build result. Bitbucket carries it.
- After a restart, a trigger within its cap resumes tracking. An older one becomes "lost".

**Data model (draft):** `repo_jenkins_job (project, repo, path, branch_param, updated_at, PRIMARY KEY (project, repo))` and `ci_trigger (id, pr, head, job, state, queue_item, build_number, note, error, created_at, updated_at)` with state in queued, started, failed, lost.

**API (draft):** PUT `/api/settings/jenkins`, POST `/api/settings/jenkins/test`, GET, PUT, and DELETE `/api/repos/:project/:repo/jenkins-job`, POST `/api/prs/:id/build` (202, or 409 when a trigger runs, Jenkins is not set, the repository has no job, or the PR is not OPEN).

**UI (draft):** `JenkinsSettings.tsx` with the mapping list, a "Start build" button on the PR header build line, a line in `OpenPrDialog.tsx` for mapped rows, and "Start the Jenkins build" in the task More menu.

**Hard-rule and BRIEF changes (they need the user's approval)**
- CLAUDE.md: "Nothing goes to Bitbucket or Jenkins without an explicit user action." Add the Jenkins token to the rule "never into SQLite, localStorage, logs, URLs, prompts".
- BRIEF 3.6: outbound calls to the configured Jenkins origin occur only on a Settings save or Test, a job Test, a "Start build" click, and a "Push and open PR" click for a mapped repository. The client uses https except on localhost, follows no redirect, calls no other origin, and takes only the queue item number from a Location header. The Jenkins token uses the OS store under its own name.
- BRIEF section 7: add `src/server/ci/`, with all Jenkins calls in `src/server/ci/jenkins.ts`.
- review-v3 Q10: Jenkins 2.555.3. Q11 says "read-only token", but Layer B needs Job/Build, so Q11 must be reopened.

## Layer C: why did the build fail (ON HOLD)

- Get the build number from `ci_trigger`, or from a status URL with the Jenkins origin. The URL path shape must be checked again for this (see the probe facts).
- Read a log tail of at most 2 MB with `<build>/logText/progressiveText?start=<X-Text-Size − cap>`. Keep it only in the run folder.
- Run a read-only Claude step, as Explain does, with `context/ci-log.txt` as untrusted data. Use the WP-VCI1 contract: cause classes and exact quotes, and the app checks each quote.
- BRIEF 3.5: "A run never gets the CI token or calls the CI server."
- This replaces WP-VCI0 to WP-VCI2 in review-v3.

## Work packages

| WP | State | Files | Done check |
|---|---|---|---|
| WP-CI0 probe | done (7cd76a2) | `scripts/gate/ci.ts`, `package.json`, `tests/gate/ci.test.ts`, `integration-check.md` | dry run green, no-names assertion tested; the user ran it on 2026-10-29 |
| WP-CA1 Layer A server | done (2734de5) | `041_build_status.sql`, `db.ts`, `provider.ts`, `schemas.ts`, `src/server/sync/builds.ts`, `engine.ts`, `src/server/inbox/builds.ts`, `queries.ts`, `tasks.ts`, `src/shared/build.ts`, `dto.ts`, `fake-bitbucket.ts`, tests | Layer A tests and the control mutation; `bun run check` |
| WP-CA2 Layer A UI | done (58013cb) | `ListPane.tsx`, `Header.tsx`, `TaskView.tsx`, `src/web/tasks/model.ts`, `notify.ts`, `serve.ts`, `builds.e2e.ts`, `demo.ts`, `README.md`, `docs/screenshots/` | e2e green, screenshots checked for real names |
| WP-CA3 Layer A docs | done | `BRIEF.md` 3.6, spec 6.10, 6.12, 6.13, `CHANGELOG.md`, this file, `integration-check.md`, `CLAUDE.md` | ASD-STE100 wording |
| WP-CI1 probe update | on hold | `scripts/gate/ci.ts`, `tests/gate/ci.test.ts` | CI7 and CI8 read a single job and its branch parameter |
| WP-CB1 Jenkins client and Settings | on hold | `config.ts`, `settings.ts`, `dto.ts`, `src/server/ci/jenkins.ts`, `fake-jenkins.ts`, tests | 401 vs 403 messages tested; token absent from disk |
| WP-CB2 trigger and routes | on hold | `042_jenkins.sql`, `db.ts`, `src/server/ci/trigger.ts`, `routes.ts`, `app.ts`, `main.ts`, `tasks/pr.ts`, `queries.ts`, `dto.ts`, tests | trigger tests and a control mutation; `bun run check` |
| WP-CB3 Layer B UI | on hold | `JenkinsSettings.tsx`, `Settings.tsx`, `Header.tsx`, `OpenPrDialog.tsx`, `TaskView.tsx`, `model.ts`, `serve.ts`, `demo.ts`, `jenkins.e2e.ts`, `README.md`, screenshots | e2e green, screenshots checked |
| WP-CB4 Layer B docs | on hold | `BRIEF.md` 3.6 and 7, `CLAUDE.md`, `SECURITY.md`, `review-v3.md`, `CHANGELOG.md` | needs the user's approval first |

Layer B starts only after the redesign, the probe update, and the user's approval of the hard-rule changes.

## Not needed for now

These parts of the first plan assume a multibranch project. The probe showed a single job, so they do not apply:
- the project scan (`ComputedFolder.doBuild`, a 302 with no queue item) and the scan wait of 5 min;
- the "job appeared" check after a scan, because `FolderComputation` exports no "scan done" state;
- the search for a `PR-<id>` job, then a branch job;
- branch job names from `NameEncoder.encode(branch)` (`feature/x` becomes `feature%2Fx`, URL segment `feature%252Fx`);
- the check that `_class` names a MultiBranchProject;
- the prefill of the job path from the status URL;
- the probe check CI11 (scan POST).

Also left out:
- the batch stats POST;
- polling Jenkins for the build result;
- moving PRs with a failed build into "your turn";
- reading the build status at run start from `pr_build`.

## Unverified assumptions

- Jenkins posts INPROGRESS and FAILED to Bitbucket from a listener, so a build that dies early still shows.
- The job JSON exports `inQueue`, `queueItem`, `lastBuild`, and `property.parameterDefinitions` (the CI8 update checks this).
- The queue keeps a finished item about 5 min. The plan handles a 404 as "lost".
