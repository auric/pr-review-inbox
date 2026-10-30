# Gate 0 integration check

Status: local checks done on 2026-10-09 (Windows 11). Bitbucket checks done on 2026-10-09 on a sandbox PR. Raw evidence is in `.gate0/local/` and `.gate0/raw/`. Both folders are gitignored.

## Local

Run: `bun scripts/gate0/local-checks.ts`. Each `claude -p` call uses `--model haiku --max-turns 2 --output-format stream-json --verbose`. The prompt goes on stdin. `Bun.spawn` gets an argument array and no shell. The child environment has no `ANTHROPIC_API_KEY` and no `ANTHROPIC_AUTH_TOKEN`. The script also removes `CLAUDECODE`, `CLAUDE_PID`, and `CLAUDE_CODE_*`. These mark a nested Claude Code session. The app does not run nested.

Cost of the final run: 8 `claude -p` calls, reported cost 0.0226 USD. Usage: input 20, cache creation 96933, cache read 282747, output 755 tokens. The two cancelled runs in check g report no cost. The script deletes its temp folders and the matching `~/.claude/projects/*rl-gate0-*` transcript folders.

| Check | Result | Command or flags | Evidence |
|---|---|---|---|
| Toolchain | CONFIRMED | `--version` of each tool | Bun 1.4.2, Node 22.17.1, git 2.56.0.windows.1, Claude Code 2.1.295 (native `claude.exe` under `%USERPROFILE%\.local\bin`, no `.cmd`), Ponytail plugin 4.12.0, Python 3.12.9. |
| Auth route | CONFIRMED | `claude auth status` | Exit 0. JSON keys: loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory, email, orgId, orgName, subscriptionType. `authMethod` = `claude.ai`, `apiProvider` = `firstParty`. The output holds account data, so the app must log only `authMethod`. |
| a. Bun.secrets | CONFIRMED | `Bun.secrets.set/get/delete` on service `review-loop-gate0-test` | `get` returned the stored value. `delete` returned `true`. `get` after delete returned `null`. |
| b. structured_output with stream-json | CONFIRMED | `--json-schema <one-field schema>` | Only the `result` event (subtype `success`) carries `structured_output` = `{"answer":"pong"}`. `num_turns` = 2: the schema answer uses one tool turn, so `--max-turns` must be 2 or more. Result keys include is_error, subtype, session_id, num_turns, total_cost_usd, usage, modelUsage, permission_denials, terminal_reason (`completed`), stop_reason, api_error_status, result, structured_output, duration_ms. Usage keys: input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, server_tool_use, service_tier, cache_creation. `init` keys include model, tools, mcp_servers, skills, slash_commands, agents, plugins, apiKeySource (`none`), claude_code_version, permissionMode, memory_paths. Model id: `claude-haiku-5-5`. |
| c. Project hook, untrusted folder | CONFIRMED | SessionStart hook in `<tmp>/.claude/settings.json` | Without `--setting-sources user`: the hook ran (`hook-ran.txt` exists). With `--setting-sources user`: the hook did not run. User-scope hooks still run with the flag. |
| d. Project CLAUDE.md | CONFIRMED | CLAUDE.md with a canary word | Without the flag: the reply had the canary. With `--setting-sources user`: the reply had no canary. |
| d. Project skill | CONFIRMED | `<tmp>/.claude/skills/canary-skill/SKILL.md` | Without the flag: `canary-skill` is in `init.skills` and `init.slash_commands`. With `--setting-sources user`: absent from both. |
| d. User skills | CONFIRMED | `--setting-sources user` | 12 `ponytail:*` entries, including `ponytail:ponytail-review`, are in `init`. User agents, plugins, and MCP servers also load (seen in `init`). User CLAUDE.md is inferred to load: in check f the model delegated to a user-defined agent, as the user CLAUDE.md tells it to. |
| e. Project `.mcp.json` | CONFIRMED | `--setting-sources user --strict-mcp-config --mcp-config <app json>` | Without flags: the project server was in `mcp_servers` and its process started, with no approval prompt. With `--setting-sources user`: the project server did not start, but all user and claude.ai connector MCP servers loaded. With `--strict-mcp-config` added: `mcp_servers` held only the app server. |
| f. blockReadsOutsideWorkingDirectories | CONFIRMED | `--setting-sources user --tools Read --allowedTools Read --settings <file>` | With `permissions.blockReadsOutsideWorkingDirectories: true`: the Read `tool_result` has `is_error: true`, text "... is outside ...; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories ...", and `permission_denials` has 1 entry. Without the setting: Read returned the sibling file content. |
| f. Tool limits (side result) | DIFFERENT FROM BRIEF | First run used `--allowedTools Read` without `--tools` | The model called the `Agent` tool and started a user-defined subagent to read the file. `--allowedTools` does not limit the tool set, and the BRIEF deny list does not name `Agent`. `--tools Read` removed the `Agent` tool. |
| g. Cancel with `proc.kill()` | CONFIRMED | `Bun.spawn(claude.exe ... --strict-mcp-config --mcp-config <stdio server>)`, then `proc.kill()` after the `init` event | `init` showed the server as `connected`, and no `result` came before the kill. The MCP server was a direct child of `claude.exe` and was alive before the kill. After the kill, both processes were gone. Control: the fixture server stays alive after stdin EOF and ignores stdout errors. The mechanism is not isolated. |
| g. Cancel with `taskkill /T /F /PID` | CONFIRMED | `taskkill /T /F /PID <claude pid>` | `claude.exe` and the MCP server were both gone. No leftover test process. |
| h. `git archive` override | CONFIRMED | `* -export-ignore -export-subst` in `.git/info/attributes`, then `git archive --format=tar HEAD` | Control without the override: the `export-ignore` file was missing and `$Format:%H$` was expanded. With the override: the file was present and `$Format:%H$` was unchanged. A symlink entry (made through the index) shows as tar typeflag `2`. Windows `tar.exe` (System32) extracted it as a real symlink. `lstat` detected it, and `rm` removed it. Git for Windows GNU `tar` fails on `C:` paths (exit 128). |

## Bitbucket

Steps to run again:

1. The user stores the URL and token in their own terminal: `bun scripts/gate0/set-token.ts`. Check with `bun scripts/gate0/set-token.ts --check`. Remove with `--clear`.
2. Read-only probe: `bun scripts/gate0/bitbucket-probe.ts --pr PROJECT/repo/1`. A personal repository uses `--pr ~USER/repo/1`. A full PR URL also works, but its origin must equal the stored URL origin.
3. Write probe on the designated test PR only: `bun scripts/gate0/bitbucket-probe.ts --pr ~USER/repo/1 --write`. It deletes every comment it creates.

The probe ran without changes, read-only first, then with `--write`. The write run deleted all 3 comments it created. A separate re-read of the PR activities found no probe comment. Sanitized payloads are in `fixtures/bitbucket/` (see its README).

| Item | Status | Evidence |
|---|---|---|
| Server version | CONFIRMED | `GET /rest/api/1.0/application-properties`: HTTP 200, `version` 9.x (Data Center). The fixture holds synthetic version values. Keys: version, buildNumber, buildDate, displayName. |
| Auth header | CONFIRMED | `Authorization: Bearer <HTTP access token>` works for all read and write calls. No redirect. |
| Current user header | CONFIRMED | `X-AUSERNAME` is present. Its value equals the user `slug` and `name` of the token owner. |
| Paging fields | CONFIRMED | Dashboard, activities, and changes return size, limit, start, isLastPage, values. Not last page: `nextPageStart` is a number (dashboard, `limit=1`). Last page: dashboard and activities omit `nextPageStart`, but changes returns `nextPageStart: null`. |
| Dashboard | CONFIRMED | `role=REVIEWER` and `role=AUTHOR` with `state=OPEN` return PR objects. The dashboard PR has a `properties` key that the single-PR GET does not have. |
| Activity `action` values | CONFIRMED | Seen: `OPENED`, `COMMENTED`. Activity keys: id, createdDate, user, action, plus commentAction, comment for COMMENTED, plus commentAnchor, diff for an inline comment. |
| Activity `commentAction` values | DIFFERENT FROM BRIEF | Only `ADDED` was seen. Post, edit, and reply produce no `EDITED`, `REPLIED`, or `DELETED` activity. |
| Nested reply shape | CONFIRMED | A reply (POST with `parent: {id}`) to a general comment returns HTTP 201. It gets no own activity. It appears in the parent's `comment.comments[]` in the activity and in `GET .../comments/{id}`. The reply has the same keys as a root comment and no `parent` field. |
| Comment `version` on edit | CONFIRMED | Post returns `version: 0`. `PUT .../comments/{id}` with `version: 0` returns 200 and `version: 1`, and `updatedDate` changes. The existing activity changes in place: new text, `version: 1`, `commentAction` stays `ADDED`. A PUT with the stale version returns 409 `CommentOutOfDateException`. |
| Delete call and deleted-comment shape | DIFFERENT FROM BRIEF | `DELETE .../comments/{id}?version=<current>` returns 204 with an empty body. Replies were deleted before their parent. After the delete, `GET .../comments/{id}` returns 404 with `errors[].message` only, no `exceptionName`. The comment activity disappears from activities. No tombstone and no `DELETED` activity exist. |
| Inline anchor, diffType COMMIT | CONFIRMED | `POST .../comments` with anchor {path, line, lineType: ADDED, fileType: TO, diffType: COMMIT, fromHash, toHash}: HTTP 201. fromHash and toHash came from the PR diff endpoint: fromHash = target head (`toRef.latestCommit`), toHash = source head. The response anchor adds `orphaned: false`. The activity has `commentAnchor` and a `diff` (destination, hunks, truncated, properties). |
| Inline anchor, diffType EFFECTIVE | NOT TRIED | The probe tries EFFECTIVE only when COMMIT fails. COMMIT passed. |
| `srcPath` | NOT TRIED | The sandbox PR has one MODIFY change and no rename. The response anchor has no `srcPath` key. |
| PR changes and per-file diff | CONFIRMED | `GET .../changes`: fromHash, toHash, values with `type` (MODIFY seen). `GET .../diff/<path>?contextLines=0`: keys fromHash, toHash, contextLines, whitespace, diffs, truncated. Segment `type` ADDED. Line keys: source, destination, line, truncated. |
| `refs/pull-requests/<id>/*` via `git ls-remote` | CONFIRMED | Exit 0 with the token in `GIT_CONFIG_*` `http.extraHeader`. Only `refs/pull-requests/<id>/from` is listed. Its hash equals `fromRef.latestCommit`. No `merge` ref is listed. A fetch was not tried. |
| PR URL forms | CONFIRMED | Project repo: `/projects/<KEY>/repos/<slug>/pull-requests/<id>`. Personal repo: `/users/<user slug>/repos/<slug>/pull-requests/<id>`, REST project key `~<USER SLUG>` (upper case), `project.type` PERSONAL. A trailing `/overview` parses. `links.self` uses the `/users/<slug>/...` form without `/overview`. |
| Existing Bitbucket MCP tools (BRIEF 10.6) | CONFIRMED | Schemas read, tools not called. `browse_repository` (project_key, repository_slug, path, at, start, limit). `create_pull_request_comment` (project_key, repository_slug, pull_request_id, text, parent_id, anchor, is_blocker, state). `edit_pull_request_comment` (project_key, repository_slug, pull_request_id, comment_id, version, text, is_blocker, severity, state). `get_file_content` (project_key, repository_slug, path, at). `get_projects` (name, permission, start, limit). `get_pull_request_activity` (project_key, repository_slug, pull_request_id, start, limit). `get_pull_request_comments` (project_key, repository_slug, pull_request_id, path required, start, limit). `get_pull_request_diff` (project_key, repository_slug, pull_request_id, path, src_path, since_id, until_id, context_lines, whitespace, with_comments). `get_pull_request_tasks` (project_key, repository_slug, pull_request_id, start, limit). `get_pull_requests` (project_key, repository_slug, state, start, limit). `get_repositories` (project_key, start, limit). `get_repository_branches` (project_key, repository_slug, filter_text, start, limit). `list_repository_files` (project_key, repository_slug, path, at, start, limit). No delete-comment tool. Comment write tools exist, so the review deny list must name them. |

## Gate v3, local

Status: DONE on Claude Code 2.1.295. B1 to B3 and B5 to B7 pass. B4 fails: `--no-session-persistence` still writes files, so the runner deletes them. B8 records facts. B9 passes with the WP8 flag set below. B10 passes with the remote documentation servers.

Run: `bun scripts/gate/claude-checks.ts`. One check only: `--only B3`. Several: `--only B1,B6`. Preflight with no `claude -p` call: `--dry-run`. Then sanitize: `bun scripts/gate/sanitize-claude.ts`. It writes `fixtures/claude/` and exits 1 when a real value remains. The last run printed `hits=0`.

Each `claude -p` call uses `--model haiku`, stream-json, the prompt on stdin, the scrubbed env, and a temp folder. B1 to B8 use `--max-turns` 4 or less. B9 uses 8. The script checks `claude auth status` first and logs only `authMethod`. It never uses `--bare`. Raw output goes to `.gate0/v3-local/raw/` (gitignored). A full run writes `.gate0/v3-local/results.json`. A partial run writes `results.<checks>.json`, for example `results.b9.json`.

Cost limit: 14 calls for B1 to B8, a separate 2 calls for B9, and 0.60 USD per script run (sum of the reported result costs). The script stops at either limit. B1 to B8 used 14 calls and 0.0659 USD. B9 used 2 calls (one run each) and 0.0083 USD.

| Check | Calls | Result | Evidence |
|---|---|---|---|
| B1. Review agent: shell, Write, Read of a sibling folder | 1 | PASS | The subagent has no shell and no Write tool. The Read of the sibling folder is refused by `blockReadsOutsideWorkingDirectories`. No canary file, no leak. |
| B2. Block `general-purpose` and a user agent: `Agent(...)` deny, `Task(...)` deny, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, `--agent` main thread | 4 | PASS | `--disallowedTools Agent(name)` refuses both. A `Task(name)` rule shows up as `Agent(name)`; the model did not try `general-purpose` there, so that variant is inconclusive. The env variable removes only built-in agents: the user agent still runs. `--agent rl-main` with the tool `Agent(rl-reviewer)` refuses both with "not found. Available agents: rl-reviewer". `init.agents` still lists `general-purpose`. |
| B3. Agent events, `task_*` events, result events, `structured_output`; also with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | 2 | PASS | Default: the subagent runs in the background ("Async agent launched"), and the run sends 2 result events, both with `structured_output`. The second has `origin.kind: task-notification`. With the env variable: foreground, 1 result event. Both runs send `task_started`, `task_progress`, `task_updated`, `task_notification`. |
| B4. `--no-session-persistence`: project folder, subagent output files, memory folders | 1 | FAIL | The run still writes `<projects>/<cwd>/<session>/subagents/agent-*.meta.json` (metadata, no transcript) and `%TEMP%\claude\<cwd>\<session>\tasks\<agent>.output`. `init.memory_paths.auto` points into the per-cwd project folder. The subagent Read of a file in the work folder was refused as "a suspicious Windows path". The cwd was the 8.3 short temp path. |
| B5. Errors: max turns, auth with an empty `CLAUDE_CONFIG_DIR` | 2 | PASS | Max turns: exit 1, result `error_max_turns`, `is_error: true`. Auth: `auth status` gives `loggedIn: false`; `-p` exits 1 with result subtype `success`, `is_error: true`, `terminal_reason: api_error`, cost 0. Detect auth failure by `is_error`, not by subtype. |
| B6. Hostile repository after the WP6 sanitize steps | 1 | PASS | Sanitize removes the link, `.claude`, `.mcp.json` (also nested) and renames CLAUDE files. Run: no hook, no canary, only `rl-stub` connected, the project MCP server never starts. |
| B7. Stub stdio MCP server from the main agent and a subagent | 1 | PASS | The main agent and the subagent both get the stub result. The server logs 2 calls. |
| B7 rerun with the WP7 git MCP server `rl-git` | 1 | PASS | `rl-git` connected. The main agent and a subagent each called `git_log`. 1 Haiku call, 0.0038 USD. |
| B8. `--restricted` with stream-json, `--json-schema`, the stub MCP server, and `rl-reviewer`; second call adds `--setting-sources user` and `--settings` | 2 | INFO | `--restricted` accepts all flags. Without `--tools`, `init.tools` still has Edit, Write, NotebookEdit, WebSearch, and other tools, so the runner needs `--tools`. `init.tools` names the agent tool `Task`; the tool_use name is `Agent`. A Read outside the cwd is refused by `--restricted`. No hook runs, also with `--setting-sources user`. The 4-turn cap gave `error_max_turns` and then `success`. |
| B9. WP8 flag set with a long-path cwd (see below) | 2 | PASS | See the B9 notes. |
| B10. Remote documentation MCP servers (`learn`, `deepwiki`) with the WP8 flag set | 1 | PASS | See the B10 notes. |
| Permission modes: `--permission-mode` choices in `claude --help`, and `init.permissionMode` per call | 0 | INFO | Choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan. `init.permissionMode` is `default` in every call, except `auto` in the B5 auth failure run. |
| CLI version (runner minimum) | 0 | PASS | 2.1.295. |

B9 notes:

- First try: FAIL. `--allowedTools mcp__rl-*` does not allow the stub tool. Both agents got "Claude requested permissions to use mcp__rl-stub__get_fact, but you haven't granted it yet". The `rl-main` tool list had no `StructuredOutput`, so `init.tools` had none and no result event had `structured_output`.
- Second try: PASS, with `--allowedTools Read,Grep,Glob,mcp__rl-stub` and `StructuredOutput` in the `rl-main` tools.
- `init.tools`: `Task, Read, Grep, Glob, mcp__rl-stub__get_fact, StructuredOutput`. `init.agents`: `claude, Explore, general-purpose, Plan, rl-main, rl-reviewer, statusline-setup`. `init.permissionMode`: `default`.
- Read inside the work folder: ran for `rl-main` and `rl-reviewer`. The long-path cwd removes the B3/B4 refusal.
- Read outside the work folder: refused for both ("is outside ... --restricted"). The secret text did not leak.
- Edit, Write, shell, WebSearch: `rl-main` tried Edit and Write and got "No such tool available". `rl-reviewer` did not try. No canary file, no edit.
- `general-purpose` and the user agent: refused, "not found. Available agents: rl-reviewer".
- Stub MCP tool: ran for both.
- Exactly 1 result event, with `structured_output`.
- Per-cwd files: `<projects>/<cwd>/<session>/subagents/agent-*.meta.json` and `%TEMP%\claude\<cwd>\<session>\tasks\<agent>.output`. After the deletion of both folders, nothing is left. The global `.claude.json` does not name the cwd.

B10 notes:

- Run: a scratchpad script through `createClaudeRunner`, `ANTHROPIC_MODEL=haiku` (init model `claude-haiku-5-5`), `--max-turns 6`, no review subagent. One call, 4 turns, 0.0035 USD.
- mcp.json entries: `{"type": "http", "url": <url>}`, no headers. Source: https://code.claude.com/docs/en/mcp. An entry with `url` and no `type` is read as stdio and skipped.
- Live `tools/list`: learn gives `microsoft_docs_search`, `microsoft_code_sample_search`, `microsoft_docs_fetch`. deepwiki gives `ask_wiki_question`, `read_wiki_contents`, `read_wiki_structure`.
- `init.mcp_servers`: learn `connected`, deepwiki `connected`. `init.tools` holds all six tools.
- `mcp__learn__microsoft_docs_search` ("std::mutex") and `mcp__deepwiki__ask_wiki_question` (microsoft/STL) both ran. No permission denial. `structured_output` came back.
- `--allowedTools Read,Grep,Glob,mcp__learn,mcp__deepwiki` (by server name) is enough.
- After the run, no per-cwd folder is left.

Recommended WP8 runner command:

- Flags: `-p --output-format stream-json --verbose --restricted --strict-mcp-config --mcp-config <app file> --tools Read,Grep,Glob,Agent --allowedTools Read,Grep,Glob,mcp__<app server> --agents <file> --agent rl-main --json-schema <schema> --max-turns N --no-session-persistence`.
- `--allowedTools` names each app MCP server (`mcp__<server>`) or each tool. A prefix wildcard such as `mcp__rl-*` does not work.
- Agents file: `rl-main` tools are `Agent(rl-reviewer)`, Read, Grep, Glob, the app MCP tools, and `StructuredOutput`. `rl-reviewer` tools are Read, Grep, Glob, and the app MCP tools.
- Env: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.
- cwd: `realpathSync.native` of the work folder (long path, not 8.3).
- After each run, delete `<projects>/<encoded cwd>` and `<TEMP>/claude/<encoded cwd>`. The encoded name replaces every non-alphanumeric character with "-".

## Gate v3, Bitbucket

Status: DONE (2026-10-11). Phase 1 and phase 2 ran on a personal-repository test PR with 1 commit. Manual steps a and b did not occur. The cleanup is not complete (see below the table).

Run these commands in order, on the designated test PR only:

1. Check the stored URL and token: `bun scripts/gate0/set-token.ts --check`.
2. Phase 1, read only: `bun scripts/gate0/bitbucket-probe.ts --pr ~USER/repo/1 --v3`. If every fetch attempt fails, run it again with `--ca-file <CA PEM file>`.
3. Phase 1, write: `bun scripts/gate0/bitbucket-probe.ts --pr ~USER/repo/1 --v3 --write`. It posts 3 inline comments, a reply to the CONTEXT comment, a reply to that reply, and 1 BLOCKER task, then resolves the task. The comments stay until step 7.
4. Open the 2 links that phase 1 prints: the file line and the comment. Record whether each opens the right place.
5. Manual step a: in the web UI, select two or more lines in the PR diff and add one comment on that range.
6. Manual step b: push one commit to the PR source branch that changes the line that phase 1 names.
7. Phase 2, read: `bun scripts/gate0/bitbucket-probe.ts --pr ~USER/repo/1 --v3 --phase 2`.
8. Phase 2, cleanup: `bun scripts/gate0/bitbucket-probe.ts --pr ~USER/repo/1 --v3 --phase 2 --write`. It deletes every probe comment.
9. Delete your range comment by hand. Phase 2 prints its link. Revert the step b commit if the test branch needs it.
10. Sanitize: `bun scripts/gate0/sanitize-fixtures.ts`. It writes the v3 fixtures to `fixtures/bitbucket/` and must print `hits=0 structure diffs=0`.

Raw responses go to `.gate0/raw/v3-p<phase>-<step>.json` (gitignored). The phase state is `.gate0/raw/v3-state.txt`. Phase 1 with `--write` refuses to run while probe comments from an earlier run exist. The fetch uses a temp bare repository with `GIT_CONFIG_NOSYSTEM=1`, an empty global config, no credential helper, and `GIT_TERMINAL_PROMPT=0`. The token goes only into `http.extraHeader` through `GIT_CONFIG_*`. The probe tries the TLS settings in order (`isolated`, `schannel`, `ca-file`, `schannel+ca-file`) and stops at the first that works.

| Item | Status | Evidence |
|---|---|---|
| U1. Jira integration endpoint `GET /rest/jira/1.0/projects/{p}/repos/{r}/pull-requests/{id}/issues`: status, shape (key, URL), answer when the integration is off | CONFIRMED: path and status. NOT TRIED: item shape, integration off. | HTTP 200, body `[]` (a JSON array). The test PR has no linked issue, so the item fields are not recorded. `v3-p1-jira-issues.json` |
| U2. Range comment (manual step a): the anchor field for the range start | CONFIRMED (Gate A capture) | `comment.anchor`, `activity.commentAnchor`, and the PR diff `lineComments[].anchor` add `multilineMarker` {`startLine`, `startLineType`} and `multilineSpan` {`srcSpanStart`, `srcSpanEnd`, `dstSpanStart`, `dstSpanEnd`}. `line`, `lineType`, and `fileType` name the end line of the range. `commentIds` in the diff mark only the end row. The `activity.diff` hunk holds the span only. `activities-u2-range.json` |
| U3. COMMIT anchor with fromHash = merge base, toHash = source head: accepted, shown in the PR diff | CONFIRMED, weak. Shown in the diff: NOT RECORDED. | POST gives 201. The anchor comes back with the same `fromHash` and `toHash`, `diffType: COMMIT`, `orphaned: false`. In this PR the merge base equals the target head, so the check does not separate them. `v3-p1-post-merge-base.json`, `v3-p1-git-fetch.json` |
| U4. Inline comment on a CONTEXT line 3 lines from a change | CONFIRMED. CONTEXT anchors use the source line number. | POST gives 201 for `lineType: CONTEXT`, `fileType: TO`, `line: 7`. The anchor comes back unchanged with `orphaned: false`. The server reads `line` as the source (old) line, whatever `fileType` says: the `commentIds` mark of the comment sits on the row source 7, destination 9 (`activities-v3-after-write.json`). The Atlassian REST example also pairs `lineType: CONTEXT` with `fileType: FROM`. `v3-p1-post-context.json`, `v3-p1-diff-0.json` |
| Inline comment on a REMOVED line (lineType REMOVED, fileType FROM) | NOT TRIED | The test diff has only ADDED and CONTEXT segments. The probe posted nothing. `v3-p1-diff-0.json` |
| U16. Reply to the CONTEXT inline comment, and a reply to that reply: status, and whether each response has `anchor` | CONFIRMED | Both POSTs give 201. Each response has `anchor`, a copy of the parent anchor, and no `parent` field. No reply gets its own activity. The reply is in the parent's `comments[]`. The reply to the reply is in the reply's `comments[]`. `v3-p1-post-inline-reply.json`, `v3-p1-post-inline-reply2.json`, `v3-p2-get-context.json` |
| U5. File link `<repo browse link>/<path>?at=<hash>#<line>` and comment link `<PR link>/overview?commentId=<id>` open the right place. Repository and PR `links` | CONFIRMED: `links` shape. NOT RECORDED: opens the right place. | PR `links` has only `self`: `<base>/users/<slug>/repos/<repo>/pull-requests/<id>`. Repository `links.self` is `<base>/users/<slug>/repos/<repo>/browse`. `links.clone` has `http` and `ssh`. The state file has no result of the manual link check. `v3-p1-pull-request.json`, `v3-p1-repository.json` |
| U6. Fetch of `refs/pull-requests/<id>/from` and the target branch with the token env: exit code, head hash, merge base, TLS setting that worked | CONFIRMED | Exit 0 on the first setting, `isolated`. The system SSL backend is `schannel`. The fetched head equals the PR source `latestCommit`. `git merge-base` exits 0. The merge base equals the target head. `v3-p1-git-fetch.json` |
| U12. Orphaned comment after manual step b: `orphaned: true`, the diff hunk kept, the RESCOPED activity | CONFIRMED (Gate A capture) | After the push, the range comment keeps its version, `multilineMarker`, and `multilineSpan`, and gets `orphaned: true`. The `activity.diff` hunk stays, with `properties.current: false`. A new RESCOPED activity has `fromHash`, `previousFromHash`, `previousToHash`, `toHash`, `added`, and `removed`. The commits page lists the new head first. `activities-u12-orphaned-range.json`, `pull-request-commits-u12.json` |
| U14. BLOCKER task: severity and state in the comment and in the activities, before and after resolve | CONFIRMED. NOT TRIED: activities before resolve. | POST with `severity: BLOCKER` gives 201, `state: OPEN`, version 0. PUT with `state: RESOLVED` gives 200, version 1, and adds `resolvedDate` and `resolver`. `threadResolved` stays false. The activity stays `commentAction: ADDED` and shows BLOCKER and RESOLVED. The resolve adds no activity. `v3-p1-post-blocker.json`, `v3-p1-resolve-blocker.json`, `v3-p1-activities-after-write-p0.json` |
| U15. PR commits endpoint: fields, paging, order | CONFIRMED: fields. NOT TRIED: paging, order. | Page keys: `values`, `size`, `isLastPage`, `start`, `limit`, `nextPageStart` (`null` on the last page). Commit keys: `id`, `displayId`, `author`, `authorTimestamp`, `committer`, `committerTimestamp`, `message`, `parents`. A commit with COMMIT-anchored comments adds `properties.commentCount`. The PR has 1 commit. `v3-p1-commits-p0.json`, `v3-p2-commits-p0.json` |
| APPROVED and REVIEWED activities | NOT TRIED | No second reviewer. Activities hold only OPENED and COMMENTED. `v3-p2-activities-p0.json` |

Cleanup is not complete. Phase 2 deleted the BLOCKER task, the CONTEXT comment, and both replies (204 each). The delete of the merge-base comment gave 409 `CommentDeletionException`: "This comment has replies which must be deleted first." The token owner added a short reply to that comment by hand during the run. Delete that reply, then the merge-base comment, by hand (`v3-p2-delete-merge-base.json`).

The sanitizer printed `hits=0 structure diffs=0`. The v3-p2 activities and commits held no push and no range comment, so they have no fixture. The Gate A capture (`scripts/gate0/capture-a.ts`) recorded U2 and U12.

## Impact on the plan (Gate v3)

- U1 (WP4): the endpoint exists and returns an array. The item shape is unknown. Do not build the `linked` task-ID source yet. The patterns stay the only source until a PR with a linked issue records the shape.
- U2 (WP4): holds. The schema keeps `multilineMarker` and `multilineSpan` in `anchor_json`. No new column. The excerpt marks each row from the span start to the end row and numbers them on the new side. Threads, the diff view, the duplicate warning, and `context/pr.md` use `dstSpanStart` to `dstSpanEnd`. A REMOVED end line or a span without new-side lines falls back to the end line.
- U3 (WP13b): not separated from the target head. Keep `fromHash` = target head (outbox.ts `fromHash: h.target_head`, provider.ts I8). Switch to the merge base only after a PR with a moved target branch confirms it.
- U4 (WP4, WP13b): CONTEXT anchors use the source line number. A context-line finding posts its old-side line (`srcLine`, from the validator excerpt) with `lineType: CONTEXT`, `fileType: TO`. An excerpt stored without the old line sends the finding to the general comment. The outbox check, the duplicate warning, and the synced excerpt read a CONTEXT `line` as the old line. The excerpt prefers the row with the `commentIds` mark. Threads and `context/pr.md` show the new line that the excerpt marks.
- REMOVED line, D3 (WP13b): unknown. Old-side findings stay general comments (plan.ts). No change.
- U5 (WP4, WP13b): `links` holds. Build file links from the repository `links.self` browse link and comment links from the PR `links.self`. Do not build them from the project key, because personal repositories use `/users/<slug>/`. The suffixes `?at=<hash>#<line>` and `/overview?commentId=<id>` are not verified.
- U6 (WP6): holds. The fetch with the token in `GIT_CONFIG_*` works with the isolated setting. No change.
- U12 (WP4): holds. No code change. The orphaned thread keeps its stored excerpt and leaves the diff as outdated. RESCOPED activities add no comment. The `orphaned` flip updates `anchor_json` at the same version with no unread message and no event.
- U14 (WP4): holds. Add optional `severity`, `state`, and `resolvedDate` to the comment schema (schemas.ts `comment`). A task is `severity: BLOCKER`. Done is `state: RESOLVED`. A resolve adds no activity and leaves `threadResolved` false. The poll must detect it through the higher `comment.version` of a seen comment.
- U15 (WP4): fields hold. The commits schema uses the keys above and the shared `page()` helper, which accepts `nextPageStart: null`. Commit order and paging are unknown. Do not depend on the order until a PR with two or more commits records it.
- U16 (WP13b, WP17): holds. Replies to anchored and nested parents return 201. A reply response carries a copy of the parent anchor. Thread structure must come only from `comments[]`, never from `anchor`. R12 is closed.
- APPROVED and REVIEWED: unknown. They stay synthetic.

## Impact on BRIEF.md

Lines that the results confirm:
- 3.5 "`--setting-sources user` stops the project settings files and `.mcp.json`": confirmed (checks c and e).
- 3.5 "`claude -p` ... in an untrusted folder ... still uses project hooks": confirmed (check c, no flag). Also, project `.mcp.json` servers start without approval.
- 3.5 and 7 `blockReadsOutsideWorkingDirectories`: confirmed on 2.1.295 (check f).
- 7 "--json-schema puts the result in structured_output ... Confirm it with stream-json": confirmed. Only the `result` event carries it.
- 7 "Put `* -export-ignore -export-subst` into the cache's info/attributes ... (verify in Gate 0)": confirmed (check h).
- 7 "Secrets: Bun.secrets (experimental; verify on Windows ...)": confirmed on Windows. Linux is not checked.
- 7 "A profile can say 'use skill X' ... confirm user skills load with --setting-sources user": confirmed (check d).
- 7 Windows checks "start claude.exe, send the prompt on stdin, cancel a run": confirmed. Bun passes, so no Node fallback is needed.

Lines that need an edit:
- 3.5 line 101 and 7 line 311 ("It is not verified that project CLAUDE.md and skills stop too"). Proposed: "`--setting-sources user` stops project settings files, hooks, `.mcp.json`, CLAUDE.md, and skills (Gate 0, CLI 2.1.295). The snapshot steps stay as defense in depth, because this behavior can change between CLI versions."
- 7 line 313 deny list. Proposed: "Deny list (also when user settings allow more): Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch, Agent, and every code-host write tool. Also pass `--tools` with the read-only built-in list, because `--allowedTools` does not limit the tool set (Gate 0: the model started a user subagent with `--allowedTools Read`)."
- 7 line 308 flags. Proposed: add `--tools <read-only built-ins>` to the flag list.
- 7 line 318 "Cancel kills the whole process tree. On Windows use taskkill /T /F with the PID." Proposed: "Cancel kills the whole process tree. On Windows use taskkill /T /F with the PID. In Gate 0, `proc.kill()` also ended the MCP child on Windows. The app does not depend on that."
- 7 line 308 `--max-turns <cap>`. Proposed: add "The cap is at least 2, because the `--json-schema` answer uses one turn."
- 7 line 317 "Map usage limit, auth error, and max turns to job states (verify values in Gate 0)". Partly done: success gives `subtype: success`, `terminal_reason: completed`. The error values are still not recorded.
- New for 3.5: "`--setting-sources user` still loads the user's CLAUDE.md, agents, plugins, hooks, and MCP servers, including claude.ai connectors. `--strict-mcp-config` removes the MCP servers. User CLAUDE.md and user hooks still apply to reviews."
- New for 3.5: "`claude auth status` prints the account email and organization. Log only `authMethod`."
- New for 7 snapshot: "Each run folder gets a folder under the user's Claude projects folder (`~/.claude/projects/<encoded cwd>/`). It holds the session transcript (`<session id>.jsonl`) and a `memory/` folder. The transcript holds the reviewed code. Decide between `--no-session-persistence` (not tested in Gate 0, blocks later resume) and cleanup of these folders." Gate 0 saw one such folder per run folder.
- New for 7 extraction: "Windows `tar.exe` extracts symlinks as real links. Reject link entries (tar typeflag 1 or 2) before or during extraction. Do not use the Git for Windows GNU `tar`."

Bitbucket lines that need an edit (Gate 0, Bitbucket Data Center 9.x):
- 7 line 281 "Not verified: the commentAction values ...": replace. Proposed: "Only `commentAction: ADDED` occurs. An edit changes the existing activity in place (new text, higher `comment.version`). A reply has no own activity. It is in the parent's `comment.comments[]`. A delete removes the activity. No tombstone exists. GET of a deleted comment returns 404."
- 7 line 288 "Activity IDs form a seen-set": a seen-set alone misses edits, replies, and deletes, because they create no new activity ID. Proposed addition: "On each poll, also compare `comment.version` and the nested `comment.comments[]` IDs inside seen activities."
- 7 line 292 "A tombstone needs a confirmed delete from the server": proposed: "A confirmed delete is absence from a complete activities fetch (all pages, `isLastPage: true`) plus 404 from `GET .../comments/{id}`."
- 7 line 294 "Reconcile followed threads from time to time": proposed: "Reconcile on every poll of a followed PR. Edits, replies, and deletes are visible only as comment changes."
- 7 line 278 inline comment: "diffType COMMIT with fromHash = target head and toHash = source head from the PR diff endpoint works (HTTP 201). The response anchor adds `orphaned`. EFFECTIVE and `srcPath` are still not verified."
- 7 line 280 "Edits and deletes need it": confirmed. Proposed addition: "A stale version returns 409 `CommentOutOfDateException`. Delete with `?version=<current>` returns 204. Delete replies before their parent."
- 7 line 286 paging: proposed addition: "On the last page, `nextPageStart` is absent or `null`. Accept both."
- 7 line 302 snapshot: "`refs/pull-requests/{id}/from` is listed by `git ls-remote` with `http.extraHeader`. No `merge` ref was listed. A fetch is still not tested."
- 7 line 315 deny list: "every code-host write tool" includes the existing MCP tools `create_pull_request_comment` and `edit_pull_request_comment`.

## M4 packaging (local)

Status: DONE on Windows 11 with Bun 1.4.2 on 2026-10-11. Linux and macOS are not run. A spike in a temp folder built small binaries with `bun build --compile`. The app binary then passed `tests/build/compiled.test.ts`. Sources: `node_modules/bun-types/docs/bundler/executables.mdx` and DeepWiki `oven-sh/bun`.

| Fact | Result | Evidence |
|---|---|---|
| Virtual root | CONFIRMED (Windows) | `import.meta.dir` = `B:\~BUN\root`. The docs give `/$bunfs/root` on Linux and macOS (not run). |
| Entry identity | CONFIRMED | `import.meta.url` = `file:///B:/%7EBUN/root/<outfile base name>`. `Bun.main` = `B:/~BUN/root/<name>` with forward slashes. `import.meta.main` = true. `process.execPath` = the real `.exe` path. |
| `import.meta.url` of an inner module | CONFIRMED | A module from a subfolder that is bundled into the entry gets the entry URL. `new URL("./worker.ts", import.meta.url)` in `tasks/rules.ts` resolved to `B:\~BUN\root\worker.ts` and failed with `ModuleNotFound`. |
| `process.argv` | CONFIRMED | `["bun", "B:/~BUN/root/<name>", ...user args]`. A child started as `<exe> --git-mcp ...` gets the same shape. It needs no entry path. |
| `--asset <dir>` | CONFIRMED | The files go under `import.meta.dir` by the base name of the folder: `--asset dist/web` gives `web/index.html` and `web/assets/...`. `--asset dist` gives `dist/web/...`. `--root` does not change it. Upstream: `collect_compile_assets` in `src/runtime/cli/build_command.rs` (DeepWiki). `existsSync`, `readFileSync`, `readdirSync`, and `Bun.file` read them. `Bun.embeddedFiles` lists them as `web/...`. |
| Source path in the binary | FAILS | `resolve(import.meta.dir, "../../dist/web")` gives `B:\dist\web`, which does not exist. The app uses a `--define` value (`src/server/build.ts`) and `join(import.meta.dir, "web")`. |
| Hono `serveStatic` on the embedded root | CONFIRMED | `serveStatic({ root: join(import.meta.dir, "web") })`: 200 for `/assets/app.js` and `/assets/sub/deep.css`. 404 for `/assets/../web/index.html`, `/assets/%2e%2e/index.html`, `/assets/..%5cindex.html`, a missing file, and a folder. No name map is needed. |
| Worker as an extra entry point | CONFIRMED | `bun build --compile main.ts tasks/worker.ts`: `new Worker(new URL("./tasks/worker.ts", import.meta.url).href)` loads `tasks/worker.js`. The `URL` object and the plain relative string also load. The app uses this form. Control: the app binary without the worker entry fails the task-rule preview test. |
| Worker from a `blob:` URL | CONFIRMED, not used | A `blob:` URL with plain JavaScript loads. It needs the worker as built JavaScript text, so the app does not use it. |
| `--define` with `typeof` | CONFIRMED | `--define 'NAME="value"'` and `typeof NAME === "string" ? NAME : null` give the value in the binary. Under `bun` from source, `typeof` gives `undefined` and no `ReferenceError`. `bun build --help` does not list `--define`, but it works. |
| `.sql` with `{ type: "text" }` | CONFIRMED | The import gives the file text in the binary, under `bun test`, and under `bun run`. |
| `.env` autoload | CONFIRMED | Without `--no-compile-autoload-dotenv`, the binary read `.env` from its working folder. With the flag, it did not. `scripts/compile.ts` also passes `--no-compile-autoload-bunfig`. |
| Environment overrides | DOCUMENTED, not tested | `BUN_BE_BUN=1` makes the binary act as the `bun` CLI. `BUN_OPTIONS` adds runtime flags. Both also reach the git MCP child. |
| Size | MEASURED | `review-loop-windows-x64.exe`: 88,101,888 bytes. A hello-size spike: 82.2 MB. The Bun runtime is most of it. |
| Start time | OBSERVED | One start of a just-built binary took about 5 s before it exited. Other starts took under 1 s. The cause is not known. |

App checks (`bun run compile`, then `bun test tests/build`): 4 pass. The page carries the session token. Each `/assets/*` file returns 200 with the same bytes as `dist/web/assets`. A settings PUT against the fake Bitbucket creates a database at the same `user_version` as `openDb` from source. The task-rule preview finds `ABC-10145`. `(a+)+$` on 20,000 characters times out in 606 ms, and the next preview works. `<exe> --git-mcp ...` lists exactly the 4 git tools through the MCP SDK client. Control: a build without `--asset` exits with "Missing B:\~BUN\root\web\index.html", and the test fails.

Not run: the `--all` targets (cross-compile), Linux, and macOS. The Bun guide `guides/runtime/codesign-macos-executable` says that Gatekeeper warns about an unsigned macOS binary.

## Release 2 (not run)

Status: NOT RUN against a real Jira server or the real `claude` CLI, 2026-10-11. The rows below come from public docs and one local git check. Code may depend on them only with the safe fallback in docs/plans/r2.md section 6. docs/smoke-r2.md records the real results.

Sources:
- Jira Server platform REST API 9.12.0: https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/ (anchors `api/2/myself-getUser`, `api/2/issue-getIssue`, `api/2/issue-getComments`).
- Atlassian Data Center personal access tokens: https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html
- git merge-tree: https://git-scm.com/docs/git-merge-tree and https://git-scm.com/docs/git-merge-tree/2.38.0

| Fact | Result | Evidence |
|---|---|---|
| Jira PAT as `Authorization: Bearer <token>` | UNVERIFIED | The PAT page says to pass the token as a bearer token in the Authorization header. It lists Jira Core and Jira Software 8.14 and later. |
| `GET /rest/api/2/myself` checks the token | UNVERIFIED | 9.12 docs `api/2/myself-getUser`: 200 gives the user, 401 when the user is not authenticated. |
| `GET /rest/api/2/issue/{key}?fields=summary,description,status` | UNVERIFIED | 9.12 docs `api/2/issue-getIssue`: the `fields` parameter takes a comma-separated list. The real shape of `description` (null, wiki text) and `status` is not recorded. |
| Comment paging | UNVERIFIED | 9.12 docs `api/2/issue-getComments`: query `startAt` (default 0) and `maxResults` (default 50). The page holds `startAt`, `maxResults`, `total`, and `comments`. The server cap on `maxResults` is not documented there. |
| 404 meaning | UNVERIFIED | 9.12 docs: 404 when the issue does not exist or the user may not view it. The app cannot tell the two cases apart and shows one fixed text. |
| Redirects (SSO, login page, http to https) | UNVERIFIED | The docs do not describe them. The client treats any 3xx as an error and follows none. |
| `git merge-tree --write-tree --no-messages` | CONFIRMED (Windows git 2.56.0.windows.1) | A run in a temp repository printed a tree ID with exit 0. The docs give exit 0 for a clean merge and 1 for a conflict. Other codes are errors. The 2.38.0 page is the first that documents `--write-tree`. Linux and macOS git are not checked. |
| Real CLI accepts `rereviewJsonSchema()` and `askJsonSchema()` with `--json-schema` | NOT RUN | Only the fake CLI ran. On a rejection, the run fails and keeps the raw output. |

## Release 3 (not run)

Status: NOT RUN, 2026-10-11. No check ran against a real Jira server, a real user clone, or the real `claude` CLI. The rows below come from the Release 3 plan, public docs, and upstream source. Code may depend on them only with the fallback in docs/plans/r3.md. docs/smoke-r3.md, B11, and B12 record the real results.

Run: `bun scripts/gate/claude-checks.ts --only B11,B12`, then `bun scripts/gate/sanitize-claude.ts`.

| Fact | Result | Evidence |
|---|---|---|
| U21. The real CLI accepts `fixJsonSchema()` and the new `replyJsonSchema()` with a nullable `judgement` enum | UNVERIFIED | Only the fake CLI ran. On a rejection, the run fails and keeps the raw output. B11 checks it. |
| U22. `structured_output` carries `new` strings of 20 KB | UNVERIFIED | B11 sends a 2 KB string only. The 20 KB case needs a real fix run (smoke A). |
| U23. Read returns image content for PNG and JPEG files in the cwd under `--restricted` | UNVERIFIED | B12 checks PNG only. Fallback: images are listed in task.md only. |
| U24. The Read image size limit is 5 MB or more | UNVERIFIED | The app includes images of 5 MB or less (`RUN_IMAGE_BYTES`). |
| U25. Jira returns `renderedFields` on the issue and `renderedBody` on comments with `expand` | UNVERIFIED | Smoke E records the rendered tag names only. A missing rendered field falls back to the raw wiki text in a fenced block. |
| U26. Shape of the Jira `attachment` field: `id`, `filename`, `mimeType`, `size`, `created` | UNVERIFIED | The zod schema is lenient. `id` can be a string or a number. Smoke F records the shape. |
| U27. The Jira PAT works on `GET <base>/secure/attachment/<id>/<filename>` | UNVERIFIED | Smoke F downloads an image, a log, and a dump. |
| U28. Redirect status of an attachment download, if any | UNVERIFIED | The client follows same-origin 3xx only, at most 3 hops. A cross-origin 3xx is error "redirect". |
| U29. The downloaded byte count equals the reported `size` | UNVERIFIED | A mismatch is error "shape", and nothing is stored. This rule catches an SSO login page with status 200. |
| B11. Real CLI with `--json-schema replyJsonSchema()` and `fixJsonSchema()` and the WP8 flag set: `structured_output` parses with zod, including a null judgement and a 2 KB `new` string | NOT RUN | One Haiku run per schema. |
| B12. Read of a generated one-color PNG at `context/attachments/1.png` under `--restricted` | NOT RUN | PASS when the run has a Read `tool_result` for the file without `is_error`. The color answer is INFO only. |

## Agent model and effort (B13)

Status: B13 RUN by the user, 2026-10-16, claude 2.1.301. Result: PASS. `src/server/review/catalog.ts` `reviewerAgent` writes the profile reviewer model and effort into the rl-reviewer definition.

Raw B13 line: `PASS B13 calls=2 agent fields run: exit=0 refused=false init.model=claude-haiku-5-5 main models=claude-haiku-5-5 agent call=Agent subagent ran=true subagent models=claude-sonnet-5-5 (want sonnet); bad effort (INFO): exit=1 refused=true stderr=Error: Invalid --agents configuration: rl-reviewer.effort: Invalid input (read from ~\AppData\Local\Temp\rl-gb-b13-7ll7lo\app\agents.json) ; --effort help=--effort <level> Effort level for the current session (low, medium, high, xhigh, max); --model help=--model <model> Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.; init.permissionMode: b13-agent-fields=default, b13-bad-effort=none`.

Run: `bun scripts/gate/claude-checks.ts --only B13`.

| Fact | Result | Evidence |
|---|---|---|
| U57. The CLI accepts `model` and `effort` in an `--agents` definition, and the subagent runs on that model | CONFIRMED (2.1.301) | B13 run 1: rl-reviewer with `model: "sonnet"` and `effort: "low"` ran under a haiku main thread. The subagent messages name claude-sonnet-5-5. The main messages name claude-haiku-5-5. |
| U58. An effort outside the CLI list makes the CLI refuse the whole `--agents` file | CONFIRMED (2.1.301) | B13 run 2 (INFO): `effort: "turbo"` gave exit 1 and "Invalid --agents configuration: rl-reviewer.effort: Invalid input". No run started. `--effort` help lists low, medium, high, xhigh, and max. The app checks every effort before the run: `claude.ts` `prepare` throws "Invalid effort" for the run, rl-main, and each agent when the value is not in `EFFORTS` (`src/shared/dto.ts`: low, medium, high, xhigh, max). |
| B13. rl-reviewer with model sonnet and effort low under `--model haiku --effort low`; a bad agent effort (INFO) | PASS (2.1.301, 2026-10-16) | Run 1: exit 0, not refused, the Agent call ran, subagent model claude-sonnet-5-5. Run 2: refused with exit 1. `init.permissionMode`: default for run 1, none for run 2. |

## Default model and effort (not run)

Status: NOT RUN, 2026-10-14. The rows come from code.claude.com/docs (model-config, settings, settings-reference, env-vars, commands). `src/server/review/defaults.ts` implements them. The app reads only the user settings file `<config>/settings.json` and only the keys `model`, `effortLevel`, `maxEffortLevel`, `modelSettings`, and named `env` entries.

Run: `bun scripts/gate/claude-checks.ts --only B14`.

| Fact | Result | Evidence |
|---|---|---|
| U30. Effort order: `CLAUDE_CODE_EFFORT_LEVEL` or `--effort`, then the settings level, then the model default | DOCUMENTED | model-config "Adjust effort level". The run env has no `CLAUDE_CODE_*` variable. |
| U31. `modelSettings[<model ID>].effortLevel` wins over the top-level `effortLevel` of the same file | DOCUMENTED | settings-reference `modelSettings`. Claude Code matches the alias, `[1m]`, and date-suffixed IDs to the entry of the model ID. |
| U32. Opus 5.5, Sonnet 5.5, and Haiku 5.5 ignore a top-level `effortLevel` in the user settings file | DOCUMENTED | settings-reference `effortLevel`. The app applies the key only to the older models it knows. An unknown model gets no top-level level. |
| U33. Model defaults: `medium` for the 5.5 models, `xhigh` for Opus 4.7, `high` for the other models with effort | DOCUMENTED | model-config "Adjust effort level", item 3. An organization default effort can change it. The app cannot see that value. |
| U34. Aliases on the Anthropic API: `opus`, `sonnet`, `haiku` resolve to the 5.5 models | DOCUMENTED | model-config "Model aliases". An `ANTHROPIC_DEFAULT_<FAMILY>_MODEL` variable replaces the alias target. |
| U35. Model order: `--model`, `ANTHROPIC_MODEL`, the `model` key, `ANTHROPIC_DEFAULT_MODEL`, the account default | DOCUMENTED | model-config "Setting your model". childEnv keeps `ANTHROPIC_MODEL`. An organization default or a managed `model` can override the user key. The app shows the source "from your settings" for `ANTHROPIC_DEFAULT_MODEL` and for the settings env block. |
| U36. The `env` block of the user settings file wins over the settings keys, like a shell variable | UNVERIFIED | The docs do not state it. The app shows such values as "from your settings" and stores no run value from them. |
| U37. Managed settings and the organization defaults do not change the default model or effort | UNVERIFIED | The app does not read managed sources. B14 compares the resolver with the CLI. |
| U38. The init event names the effort level | NO | The fixtures carry `per_turn_effort_active` only. The run end resolves the effort for the init model instead. |
| B14. `/effort status` in `-p`, without `--model` and with `--model haiku`, prints the level that the resolver gives | NOT RUN | Two calls, own cap 2. `/effort status` should make no model call. PASS when the first level in the output equals the resolver value for both runs. |

## Project instructions

Status: B15 RUN by the user, 2026-10-14, claude 2.1.296. Result: FAIL, so U40 is refuted. The other rows come from code.claude.com/docs/en/memory, code.claude.com/docs/en/sub-agents, and `claude --help` (2.1.296). `src/server/review/instructions.ts` implements them.

Raw B15 line: `FAIL B15 calls=2 main: exit=0 word=false tools=none; import text leaked=false; reviewer (INFO): agent call=Agent ran=true word=false reviewer tools=none`.

The B15 prompts did not hold the fallback line. The rl-main prompt was "You do the user task exactly. You change no files.", and the ask said "Do not call any tool." So B15 shows only that the CLI did not load `work/CLAUDE.md`. It does not show that the model ignores a read instruction.

Run: `bun scripts/gate/claude-checks.ts --only B15`.

| Fact | Result | Evidence |
|---|---|---|
| U39. Claude Code loads CLAUDE.md and CLAUDE.local.md from the cwd and every folder above it | DOCUMENTED | memory "How CLAUDE.md files load". The run writes `work/CLAUDE.md` in the cwd. |
| U40. `--restricted` still loads the cwd CLAUDE.md | REFUTED | B15 (2.1.296): the main thread did not know the canary of `work/CLAUDE.md` (word=false, exit 0, no tool call). B8 also saw no user CLAUDE.md under `--restricted`. The app no longer relies on the CLI to load the file (U45). |
| U41. A subagent with `omitClaudeMd` starts without CLAUDE.md | DOCUMENTED | sub-agents "What loads at startup". B15 run 2: rl-reviewer ran and did not know the canary (INFO). The app keeps `omitClaudeMd` on rl-reviewer and puts the text into its prompt (U45). |
| U42. A CLAUDE.md in a subfolder of the cwd loads on demand when Claude reads a file there; AGENTS.md also loads | DOCUMENTED | memory "Troubleshooting" and "When Claude Code reads AGENTS.md". The snapshot renames every CLAUDE.md, CLAUDE.local.md, and AGENTS.md of the PR head to *.untrusted.md at any depth and removes `.claude/`. |
| U43. `@path` imports resolve relative to the importing file, nest at most four hops, and skip code spans and fenced code blocks | DOCUMENTED | memory "Import additional files". The app resolves imports itself with the same rules, inside the clone or the target tree only. It puts every import token of work/CLAUDE.md into a code span, so the CLI imports nothing. |
| U44. The CLI reads an "@" token after a space or a line start as an import, and not an "@" inside a word | UNVERIFIED | The docs show examples only. The app resolves only tokens that look like a path (user decision): a "/" or a backslash, a "~/" start, or a file extension. It puts every "@" token that does not follow a letter or digit into a code span. B15 checks that a code-span token imports nothing. |
| U45. Inline delivery: the project instructions reach the model without CLI loading | BY DESIGN | The stdin prompt holds the combined text as the "# Project instructions" section, right before "# Your instructions". The rl-reviewer prompt ends with the same text. The CLI reads the agents file by path (`--agents <file>`), so the 32,000-character argv cap does not apply to it. The total cap is 120,000 bytes: the CLI 2.1.296 warns above max(120,000, the per-file limit) characters for all instruction files (bundle functions `JRt`, `OZn`: `IZn=120000`, per-file floor `MZn=40000`). `work/CLAUDE.md` keeps a copy. No real CLI run checked the inline path yet. |
| U46. The global CLAUDE.md lives in the Claude config folder | DOCUMENTED | memory "User memory": `~/.claude/CLAUDE.md`. The app reads `CLAUDE_CONFIG_DIR` or `~/.claude` (the same folder as the skills), only when the global switch is on. Imports resolve inside that folder only, with real path checks. A "~/" import resolves from the home folder and must also end inside it. |
| B15. `work/CLAUDE.md` with a canary under the runner flag set: the main thread knows the canary with no tool call; a code-span `@repo/b15.txt` imports nothing; rl-reviewer with `omitClaudeMd` (INFO) | FAIL (2.1.296, 2026-10-14) | main word=false, no tool call, exit 0; import text leaked=false; rl-reviewer ran, word=false. U40 refuted. B15 still tests CLI loading, not the inline path. |

## Session consult part C

Status: B16 RUN by the user, 2026-10-16, claude 2.1.301. Result: PASS. The consult command now passes `--no-session-persistence` (U50). The other rows come from the scout run of 2026-10-14 (CLI 2.1.300 and its docs) and from a local count of transcript key names and positions (2026-10-16, CLI 2.1.301, 54 transcripts, no message text read out).

Raw B16 line: `PASS B16 calls=3 (a) original hash unchanged=true; (b) init.tools=Glob,Grep,Read,StructuredOutput mcp_servers=none; (c) structured word="B16-FILE-9902"; (e) exit=0 origin="B16-ORIGIN-4417" from another cwd; (d, INFO) no-persistence exit=0 new transcripts=0 (none); INFO: fork transcripts=1 (fork cwd folder) fork session=new init.model=claude-haiku-5-5 hook events=0 history replay in stdout=false; init.permissionMode: b16-create=default, b16-fork=default, b16-fork-nopersist=default`.

Run: `bun scripts/gate/claude-checks.ts --only B16`. Dry run: add `--dry-run`. It prints the planned argv and starts no model call.

Result format: one line `<PASS|FAIL> B16 calls=3 (a) original hash unchanged=<bool>; (b) init.tools=<list> mcp_servers=<list>; (c) structured word=<json>; (e) exit=<n> origin=<json> from another cwd; (d, INFO) no-persistence exit=<n> new transcripts=<n> (<folders>); INFO: fork transcripts=<n> (<folders>) fork session=<new|same as original> init.model=<id> hook events=<n> history replay in stdout=<bool>; init.permissionMode: <per call>`. `.gate0/v3-local/results.b16.json` holds the same data. A folder is "original folder", "fork cwd folder", "no-persistence cwd folder", or "other folder".

| Fact | Result | Evidence |
|---|---|---|
| U47. `claude -p --resume <absolute .jsonl path> --fork-session` leaves the original file unchanged | CONFIRMED (2.1.301) | B16 (a): the SHA-256 of the throwaway original did not change after two forks. |
| U48. `--tools`, `--restricted`, `--strict-mcp-config`, and `--mcp-config` apply on resume | CONFIRMED (2.1.301) | B16 (b): `init.tools` = Glob, Grep, Read, StructuredOutput; no MCP server. The app passes the flags again on each resume. The init tool check stays as a guard. |
| U49. `--json-schema` gives `structured_output` with `--resume` | CONFIRMED (2.1.301) | B16 (c): the fork returned the structured word from the file. |
| U50. `--no-session-persistence` with `--fork-session` leaves no transcript | CONFIRMED (2.1.301) | B16 (d): exit 0, 0 new transcripts. `resumeArgs` now passes the flag. The run end still deletes the per-cwd folders of the run cwd, because the flag still writes them (Gate B4). |
| U51. Resume works from another cwd | CONFIRMED (2.1.301) | B16 (e): the fork in another folder returned the first reply of the original. |
| U52. Transcript keys: message lines carry `cwd`, `gitBranch`, `sessionId`, `timestamp`; titles are `{"type":"ai-title","aiTitle"}` and `{"type":"custom-title","customTitle"}`; `{"type":"continued-in","continuedInSessionId"}` names the next session; the file name is the session ID | OBSERVED (2.1.301) | Local count of key names only, 2026-10-16. The format is internal to the CLI and can change. Both title types repeat through a file. 3 continued-in lines named sessions that no listed file had. |
| U53. Positions: the first cwd line within 2 KB of the start; the last branch line within 23 KB and the last title line within 37 KB of the end | OBSERVED (2.1.301) | The same count. The finder caps each file at the first 64 KB and the last 256 KB. |
| U54. A resumed `-p` run does not replay the old messages on stdout | CONFIRMED (2.1.301) | B16 INFO: history replay in stdout=false. The fork also gets a new session ID. |
| U55. The permission mode of a resumed `-p` run with `--restricted` and no `--permission-mode` is `default` | CONFIRMED (2.1.301) | B16 INFO: `init.permissionMode` = default for all three calls. |
| U59. A fork without `--no-session-persistence` writes its transcript in the project folder of the fork cwd, with a new session ID | OBSERVED (2.1.301) | B16 INFO: fork transcripts=1 (fork cwd folder), fork session=new. The original folder gets no file. |
| U60. A resumed `-p` run with `--restricted` fires no hooks | OBSERVED (2.1.301) | B16 INFO: hook events=0 on the fork. |
| B16. Throwaway session, then two forks with the app flags from another cwd: (a) to (e) above | PASS (2.1.301, 2026-10-16) | Own cap 3 calls. It never opened a real session. (a), (b), (c), and (e) pass. (d) INFO: no new transcript. |
| U61. A fork in the mode "Judge and propose fixes" (docs/plans/session-consult.md part D) returns the answers and the edits as `structured_output`, with up to 62 turns | PARTLY COVERED | The flags, the resume, and `structured_output` with `--resume` are the same as in B16 (b) and (c). The larger schema, the edit volume, and the turn count are not verified on the real CLI. The fake CLI covers them in the tests. Smoke r3 part K steps 20 to 27 check them. |

## Thread resolver (not verified)

Status: NOT VERIFIED. The Bitbucket Data Center REST docs (8.15) show a resolved comment with `threadResolved: true`, `threadResolvedDate` (epoch ms), and `threadResolver` (a user). No recorded fixture has a resolved thread. The tests use a synthetic state (`resolveThread` in tests/support/scenarios.ts).

| Fact | Result | Evidence |
|---|---|---|
| U56. `threadResolver` and `threadResolvedDate` on a resolved root comment on 9.4 | UNVERIFIED | Capture with `scripts/gate0/capture-a.ts` after resolving a thread on the test PR. The schema reads both as optional. A missing or bad value shows "Resolved" without a name or a time, and the sync stays complete. A reopened thread (`threadResolved: false`) clears both. |

## Thread resolve (not verified)

Status: VERIFIED on Data Center 9.x, 2026-10-20, except U66. Scout, 2026-10-19: the Bitbucket Data Center REST docs (7.21, still listed in 9.0) show `PUT /rest/api/latest/projects/{key}/repos/{slug}/pull-requests/{id}/comments/{commentId}`. It updates a comment and needs the current `version`. Only the comment author, the PR author, or a repository admin may update a comment. A resolved thread takes no reply. Only a third-party source shows `threadResolved` in the PUT body. The app sends `{version, threadResolved}` with a version from a fresh GET, then reads the root comment again. Only that read decides the result, so a PUT without effect shows "did not resolve", never a false success. Nothing repeats a PUT. The tests use the synthetic PUT handler of `commentPosts` in tests/support/scenarios.ts.

Run: `bun scripts/gate0/resolve-thread.ts --pr <TEST_PR_URL> --thread <ID>` on an open thread that you started on your test PR. Add `--forbidden <ID>` with a thread that you may not change. It WRITES: it resolves the thread, sends one reply into the resolved thread (and deletes that reply if Bitbucket takes it), sends one PUT with the old version, and reopens the thread. Dry run: `--dry-run` runs the same steps against a loopback fake and reads no secret. The console and `.gate0/resolve/result.json` hold status codes, versions, booleans, key names, and enum-like strings only (docs/smoke-r3.md part L).

| Fact | Result | Evidence |
|---|---|---|
| U62. The PUT body `{version, threadResolved: true}` resolves the thread, `false` reopens it, and the text stays. The single GET of a root comment carries `threadResolved` | CONFIRMED (Data Center 9.x, 2026-10-20) | Gate lines: "resolve PUT: HTTP 200" with `threadResolved`, `threadResolvedDate`, and `threadResolver` in the body. "after resolve: threadResolved=true threadResolver=true threadResolvedDate=true text unchanged=true". "after reopen: threadResolved=false threadResolver=false threadResolvedDate=false text unchanged=true". |
| U63. A PUT with an old version gives 409 | NOT OBSERVED (Data Center 9.x, 2026-10-20) | Gate line "stale PUT: HTTP 200 threadResolved after=false version=0". The resolve kept the version (U64), so the "stale" PUT had the current version and reopened the thread. A PUT with the current version always succeeds. The app keeps the 409 mapping "The thread changed on Bitbucket. Read it, then resolve it again." for an edit between its GET and its PUT. |
| U64. A resolve raises the comment version | REFUTED (Data Center 9.x, 2026-10-20) | Gate lines "before: version=0", "after resolve: version=0", and "after reopen: version=0". Resolve and reopen keep the version. The app stores the read-back version only when the stored root has the version of the first read, so the version and the read mark stay, and my own resolve does not mark the thread unread. The fake Bitbucket keeps the version too. tests/publish/outbox.test.ts locks this in. |
| U65. A resolve adds a pull request activity | REFUTED (Data Center 9.x, 2026-10-20) | Gate line "activities: before=5 new=0". The app does not depend on it. Sync reads the resolve from the comment. |
| U66. The status for a user that may not change the comment | UNVERIFIED | The 2026-10-20 run had no `--forbidden` thread. The app maps 401 and 403 to "Bitbucket refused to resolve the thread" with a link to the thread. |
| U67. A reply in a resolved thread is refused (Data Center docs: "you can only react to resolved comment threads but you can't edit or reply") | CONFIRMED (Data Center 9.x, 2026-10-20) | Gate line "reply to resolved: HTTP 400 com.atlassian.bitbucket.validation.ArgumentValidationException taken=false". The status is 400, not 409. The app reads the root comment before each reply post. A resolved thread gets the reopen PUT first (U62). A failed reopen sends no reply. The post confirm says "Reopen thread, post reply". If the post still gets 400 ArgumentValidationException and a new read shows the thread resolved, the post fails with "This thread is resolved. Reopen it first." The fake Bitbucket refuses such a reply with the same 400 body. |

## Review v2 (not run)

Status: B17 to B20 RUN on the real CLI, 2026-10-22: claude 2.1.306, subscription login (`authMethod` claude.ai), reported cost 0.0119 USD, sanitizer hits=0. All gate calls used `--model haiku`. G1 to G6 RUN on the test repository (a personal repository), 2026-10-22. G7, G9, and G12 are not run. B20 used the gate's own draft-07 schema copies in scripts/gate/claude-checks.ts. WP-R1 and WP-B0 must ship schemas equal to these copies, or run B20 again.

Run: `bun scripts/gate/claude-checks.ts --only B17,B18,B19,B20`. Bitbucket: `bun scripts/gate/bitbucket-write.ts --only G1,G2,G3` and `--only G4,G5,G6` (docs/gate-v2.md).

| Fact | Result | Evidence |
|---|---|---|
| U68. The real CLI accepts `verifyJsonSchema()` (draft-07, the verdict enum, a nullable `duplicateOf`) with `--json-schema`, and `structured_output` parses with zod | CONFIRMED (2.1.306, haiku) | B18: the run exits 0, and `structured_output` parses with the verify schema. On a rejection, the verify phase fails, and the run ends incomplete with every candidate unchecked. |
| U69. The real CLI accepts `explainJsonSchema()` with a Markdown walkthrough of up to 60,000 characters | PARTLY CONFIRMED (2.1.306, haiku) | B20: the explain schema is accepted, and `structured_output` parses with zod for a short walkthrough. The long case needs a real explain run (smoke v2 part C). On a rejection, the run fails and keeps the raw output. |
| U70. The real CLI accepts `discussJsonSchema()` with the verdict enum and a nullable `revision` | CONFIRMED (2.1.306, haiku) | B20: the discuss schema is accepted, and `structured_output` parses with zod. On a rejection, the turn fails, shows its error, and applies nothing. |
| U71. Effort per agent: one verify run takes `--effort medium` and an `--agents` file with rl-verifier effort high | CONFIRMED (2.1.306, haiku) | B18: the CLI accepts both effort values, and rl-verifier runs. B13 (U57) confirmed model and effort in an `--agents` definition. A bad effort refuses the whole file (U58), so the app checks each effort before the run. |
| U72. `--restricted` keeps Edit and Write inside the run folder for an implement run (`--tools` and `--allowedTools` Read,Grep,Glob,Edit,Write, `--strict-mcp-config`, no `--permission-mode`) | CONFIRMED (2.1.306, haiku) | B17: init tools are exactly Edit, Glob, Grep, Read, StructuredOutput, Write. `permissionMode` is default. The write inside work/ ran. The writes to `../outside.txt` and to an absolute path outside work/ were refused ("is outside ... work"). The condition of design.md Q1 is met. WP-B3 can use this confinement. |
| U73. Usage and cost fields of the result event on a subscription run | OBSERVED (2.1.306, haiku) | B19: `total_cost_usd` is present. `usage` keys include `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use`, and `service_tier`. `modelUsage` has one entry per model with `costUSD`, `inputTokens`, `outputTokens`, `thinkingTokens`, `contextWindow`, and more. The event also has `num_turns`, `duration_ms`, `subagent_stats`, `stop_reason`, and `terminal_reason`. Part budgets can use the cost (spec.md section 6.7). |
| B17. Write confinement of an implement run | PASS (2.1.306, 2026-10-22) | U72. |
| B18. Verify run with effort per agent | PASS (2.1.306, 2026-10-22) | U68, U71. |
| B19. Usage and cost fields | INFO (2.1.306, 2026-10-22) | U73. |
| B20. Explain, discuss, interview, spec, and implement schemas | PASS (2.1.306, 2026-10-22) | All five `structured_output` values parse with zod. U69, U70. |
| G1. Repository clone links and a push of a new branch with an empty lease | PASS (2026-10-22) | Repository GET: HTTP 200, clone links http and ssh, the http link has the origin of the base URL. Push with an empty lease: exit 0, marker `[new branch]`, the remote branch is at the pushed commit. Read-only token: not tested. |
| G2. Create a PR with one reviewer | FAIL (setup, 2026-10-22) | Create PR: HTTP 201 with an ID, version 0, state OPEN. Response keys: author, closed, createdDate, description, draft, fromRef, id, links, locked, open, participants, reviewers, state, title, toRef, updatedDate, version. reviewers=0: the only reviewer given was the PR author, and Bitbucket drops the PR author from the reviewers without an error. The create itself works. A non-author reviewer is unverified: run G2 again with the slug of another user. |
| U74. Bitbucket drops the PR author from `reviewers` on create without an error | OBSERVED (2026-10-22) | G2. The app never offers the PR author as a reviewer. After a create, the app reads back `reviewers` and tells the user when a reviewer was dropped. |
| G3. Build stats of a commit without and with a build status | PASS (2026-10-22) | Stats of the new gate commit: HTTP 200, keys cancelled, failed, inProgress, successful, unknown, counts 0/0/0. POST build status to `/rest/api/1.0/projects/{p}/repos/{r}/commits/{id}/builds` (repository-scoped, 7.4 and later): HTTP 204. Stats after the POST: HTTP 200, counts 1/0/0. The legacy stats read counts a status from the repository-scoped POST. `--build-commit` not given. The server adds the keys `cancelled` and `unknown`. WP-B1 reads them as optional. |
| G4. PUT with a new toRef | PASS (2026-10-22) | PUT: HTTP 200, version 0 -> 1, toRef moved, title unchanged. Reviewers 0 -> 0, so "a PUT without `reviewers` keeps them" is still unverified. PUT back: HTTP 200. |
| G5. Delete the target branch of a stacked PR | PASS (2026-10-22) | Delete: exit 0, marker `[deleted]`. Within 30 s the stacked PR is DECLINED, its toRef is still the deleted lower branch, version 2 -> 3. Design rule (spec.md section 6.8, tasks.md WP-B8): retarget an upper PR to the target branch before the lower branch goes away, for example before a lower PR merges with "delete source branch". Never delete a lower branch while an upper PR targets it. Detect a declined upper PR and offer to open it again. |
| G6. Push with a stale lease | PASS (2026-10-22) | Move of the remote branch: exit 0. Push with the old lease: exit 1, markers `[rejected]` and `(stale info)`. The remote keeps the moved commit. |
| G7. Task chip for a PR with a Jira key in its title | NOT RUN | |
| G9. Open-PR list of the test repository (limit 50): id, title, author, state, fromRef, toRef, updatedDate, isLastPage | NOT RUN | `bun scripts/gate/bitbucket-write.ts --repo <URL> --only G9,G12` (read only). |
| G12. Changes of an open PR where the token user is not the author, a reviewer, or a participant: path, srcPath, type, isLastPage | NOT RUN | The same run as G9. PASS needs the shape of listChanges of an own PR. |
| G13. Default branch: GET .../default-branch (id, displayId), compared with the deprecated .../branches/default | PASS (2026-10-23) | Non-admin token. GET .../default-branch: HTTP 200, keys displayId, id, type. It has no default flag key. The id starts with `refs/heads/`. The deprecated GET .../branches/default: HTTP 200 with the same id, and it adds isDefault, latestChangeset, latestCommit. The app reads .../default-branch. |
| G14. Branch search: GET .../branches with orderBy, filterText, boostMatches; the default flag key | PASS (2026-10-23) | GET .../branches?orderBy=MODIFICATION&limit=25: HTTP 200, isLastPage=false. Branch keys: displayId, id, isDefault, latestChangeset, latestCommit, type. Exactly one value has the default flag. The live flag key is `isDefault`, not the `default` of the DC 9.6 schema. The app reads `isDefault` and also accepts `default`. filterText with the default branch name and boostMatches=true: 1 hit, the exact match first. A filter that matches nothing: 0 values. |
| G15. Repository search by permission (REPO_READ, REPO_WRITE, REPO_ADMIN with projectkey and name) and the restriction search for a plain token | PASS (2026-10-23) | Non-admin token. GET /rest/api/1.0/repos with permission REPO_READ and with REPO_WRITE listed the test repository. REPO_ADMIN did not list it. GET /rest/branch-permissions/latest/.../restrictions: HTTP 401 AuthorisationException. The pre-flight checks write permission only through the repos permission filter. It skips the branch rule check on 401. |
| G16. Repositories with REPO_WRITE: paging, keys, clone link names | PASS (2026-10-23) | GET /rest/api/1.0/repos?permission=REPO_WRITE&limit=100: 2 pages, 200 repositories, the last page has isLastPage=true. Repository keys include links, with the clone link names http and ssh. Project keys include key. The app follows nextPageStart and stops at REPO_LIST_MAX (10 pages). |
| G17. Merge commit of a merged PR: properties.mergeCommit and the MERGED activity commit | PASS (2026-10-23) | Newest merged PR: properties keys commentCount, openTaskCount, resolvedTaskCount. It has no mergeCommit. The MERGED activity of GET .../activities carries a commit object with id, parents, and message. The same-commit comparison is false, because properties had no mergeCommit. The app reads the merge commit from the MERGED activity commit. |
| G18. Merge result of the open PRs: properties.mergeResult outcome and current, with one PR made conflicted by hand | NOT RUN | `bun scripts/gate/bitbucket-write.ts --repo <URL> --only G18` (read only). Until it runs, the app reads outcome `CONFLICTED` with current true as a PR with conflicts (MERGE_CONFLICTED in src/shared/task.ts). The sanitized dashboard fixture shows only `{"outcome": "CLEAN", "current": true}`. |
| G19. Squash merge of a lower PR with the branch kept, then the three merges, the push, and the PUT of the upper PR (spec.md section 6.20.10) | PASS (2026-10-30) | Personal test repository, target branch `main`. The first run failed with HTTP 400 `com.atlassian.bitbucket.validation.ArgumentValidationException`, because the repository did not enable squash. A repository without squash rejects the merge with HTTP 400, not 409. After the user enabled squash: merge strategies HTTP 200, enabled no-ff, squash, squash-ff-only, default no-ff. The request `POST .../pull-requests/{id}/merge?version=<n>` with the body `{"strategyId": "squash"}` gives HTTP 200 and state MERGED. The lower branch stays. Activities: HTTP 200, one MERGED activity, commit keys author, authorTimestamp, committer, committerTimestamp, displayId, id, message, parents, with 1 parent. The MERGED commit is the head of the base, with 1 git parent, and S^1 is the moved base. The tree of S equals `merge-tree --write-tree S^1 A_final`. The three merges on the upper branch (S^1, `-s ours S`, M1) work, and the local diff M1...upper lists only the upper file. The push needs no force and no lease: exit 0, no markers. The PUT of the upper PR target to the base gives HTTP 200, and toRef moves. Upper PR changes: HTTP 200, count 1, only the upper file. Cleanup: the lower PR is merged, the upper PR is declined (HTTP 200), and all three gate branches are deleted. |
| J1. Jira `subtasks` entries with status.statusCategory, and the `parent` field of a sub-task, on Server or Data Center and on Cloud | PASS (2026-10-30, Server, Bearer) | Server only. Cloud is not run. Parent read: HTTP 200, field keys attachment, description, issuelinks, status, subtasks, summary. `subtasks` is an array, count 4. Entry keys: fields, id, key, self. Entry field keys: issuetype, priority, status, summary. Status keys: description, iconUrl, id, name, self, statusCategory. statusCategory keys: colorName, id, key, name, self. 4 of 4 entries have a key and statusCategory.key, with the categories indeterminate and new. Sub-task reads: 4, all HTTP 200. Parent keys: fields, id, key, self. Parent field keys: issuetype, priority, status, summary. parent.key equals the parent in 4 of 4. The parent status has statusCategory in 4 of 4. The entry and the own read show the same category in 4 of 4. |
| J2. Jira `issuelinks` shape on the parent and on its sub-tasks | INFO (2026-10-30, Server, Bearer) | The same run as J1. `issuelinks` is an array on the parent and on the 4 sub-tasks, count 0 each. The test data has no links, so the link shape and the link order stay unverified. Link two sub-tasks of the parent and run again. |
| J3. Jira transitions list, the file link in a comment, and the image `src` in the rendered HTML (U79) | PASS (2026-10-30, Server, Bearer) | The same run as J1. Transitions: HTTP 200, keys expand, transitions, count 3. Transition keys: description, id, name, opsbarSequence, to. 3 of 3 have a numeric id, a name, and `to`. `to` keys: description, iconUrl, id, name, self, statusCategory. `to` categories: done, indeterminate, new. hasScreen true: 0. Comments: HTTP 200, count 0, so the `[^file]` comment link stays unverified. Rendered description link shape: `a /browse/<s>`. |
| J4. One transition POST with JSON and `X-Atlassian-Token: no-check` gives 204 | NOT RUN (2026-10-30) | No test issue yet. `bun run gate:jira -- --url <Jira URL> --only J4 --transition-issue <KEY> --transition <id> --authorize-transition` on a test issue. Without the flag, nothing is sent. It records: the HTTP status, the error counts, and the status category before and after. |

## CI builds (run 2026-10-29)

Status: the probe ran on 2026-10-29 with masked output. CI1 to CI9 only read. CI9 sends one POST to `api/json?tree=_class`, which starts nothing. CI10 starts one build and CI11 scans the multibranch project, only behind their flags. The plan has no CI4. Layer A of docs/plans/ci-builds.md uses CI1 to CI3. Layer B is on hold, so CI10 and CI11 did not run.

Run: `bun run gate:ci -- <PR URL> --jenkins <Jenkins URL> --jenkins-user <user> [--job <folder/project>] [--authorize-build] [--authorize-scan]`. Tokens: `GATE_BITBUCKET_TOKEN` (else the stored token), `GATE_JENKINS_TOKEN`. Output: `.gate0/ci/result.json`. Dry run: `bun run gate:ci -- --dry-run`.

| Fact | Result | Evidence |
|---|---|---|
| CI1. GET the PR: state, head present | PASS (2026-10-29) | PR GET: HTTP 200. The source branch is in the same repository as the target. |
| CI2. GET the build stats of the head: HTTP status, keys, counts | PASS (2026-10-29) | Stats keys: cancelled, failed, inProgress, successful, unknown. This agrees with G3. |
| CI3. GET the build status list of the head: count, keys, states, URL origin, URL path shape, last job segment, display/redirect | PASS (2026-10-29) | List GET: HTTP 200. Item keys: dateAdded, description, key, name, state, url. No buildNumber and no ref. The url has the Jenkins origin. Path shape: `/<s>/<s>/job/<s>/<s>`. Two segments come before `/job/`, so the app cannot take the job path from the status URL. |
| CI5. Jenkins whoAmI: 401 vs 403, authenticated, anonymous, user name, version | PASS (2026-10-29) | whoAmI: authenticated. Jenkins 2.555.3. A token from another Jenkins server gave HTTP 401. A Jenkins API token works only on the server that made it. |
| CI6. Jenkins crumbIssuer: crumb field or 404 (CSRF off), Set-Cookie | PASS (2026-10-29) | The crumb issuer is on. Crumb field: `Jenkins-Crumb`. |
| CI7. Multibranch project: _class, buildable, job count, PR-<id> jobs, %2F names, branch job, PR job | INFO (2026-10-29) | The job is a single pipeline job (WorkflowJob), buildable, with no sub-jobs and no PR jobs. The probe expects a multibranch project. Layer B needs a new design for one job with a branch parameter. |
| CI8. PR or branch job: buildable, inQueue, lastBuild, parameters | SKIPPED (2026-10-29) | The probe needs an update for a single job with a branch parameter. The parameter name differs per project. |
| CI9. POST `api/json?tree=_class` without and with the crumb: token exempt, crumb needed, or denied | INFO (2026-10-29) | POST with the token only: HTTP 200. Verdict: an API token is exempt from the crumb. |
| CI10. Build POST (`--authorize-build`): Location shape, queue classes, build number | NOT RUN | Layer B is on hold. |
| CI11. Scan POST (`--authorize-scan`): HTTP status, jobs before and after, new job, auto-built without a POST, indexing status | NOT RUN | Layer B is on hold. The job is not a multibranch project, so no scan applies. |

## Jira Cloud (not run)

Status: NOT RUN, 2026-10-29. No check ran against a real Jira Cloud site. The rows come from the Atlassian docs and the fake Jira in `tests/support/fake-jira.ts`. Part N of docs/smoke-r3.md records the real results.

| Fact | Result | Evidence |
|---|---|---|
| U75. Jira Cloud accepts Basic auth of the Atlassian account email and an unscoped API token on `https://<site>.atlassian.net` | UNVERIFIED | https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/. The app sends Basic when the email is set, else Bearer. |
| U76. Scoped API tokens do not work on the site URL | UNVERIFIED | https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/: a scoped token needs `https://api.atlassian.com/ex/jira/{cloudId}`. The app does not support scoped tokens. The exact status on the site URL is not documented. |
| U77. Cloud `GET /rest/api/2/myself` has `accountId` and `displayName`, and no `name` | UNVERIFIED | https://developer.atlassian.com/cloud/jira/platform/deprecation-notice-user-privacy-api-migration-guide/. The check accepts a user without `name`. |
| U78. Cloud serves `/secure/attachment/<id>/<name>` to Basic API token auth | UNVERIFIED | Not relied on. The app downloads from `GET /rest/api/2/attachment/content/{id}?redirect=false` (Cloud OpenAPI: 200 with redirect=false, else 303 to another host; https://dac-static.atlassian.com/cloud/jira/platform/swagger.v3.json). |
| U79. The `src` format of an attached image in the Cloud rendered HTML | UNVERIFIED | markdown.ts maps only `/secure/attachment/<id>/...` and `/secure/thumbnail/<id>/...`. Another format shows the alt text, and the attachment list still shows the file. Part N step 4 records it. |
| U80. Server and Data Center `serverInfo.deploymentType` values are `Server` or `DataCenter`, and can be absent | UNVERIFIED | https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/ (api/2/serverInfo) lists the field without values. The app treats only `Cloud` as Cloud, and an absent value blocks nothing. |
| U81. Cloud REST v2 keeps `description` and comment `body` as strings | UNVERIFIED | https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/: v3 uses ADF. The app stays on v2. |
