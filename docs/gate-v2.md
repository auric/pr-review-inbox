# Gate v2: CLI and Bitbucket facts for review v2 and task building

This gate records facts that review v2 and the task builder need (docs/plans/review-v2/tasks.md, WP-G0). You run each check on your own machine. B17 to B20 use your Claude Code login. G1 to G7 write to a Bitbucket test repository. G9, G12, and G13 to G18 only read from it.

| Checks | Run before | Script |
|---|---|---|
| B18, B20 | WP-R3 | `scripts/gate/claude-checks.ts` |
| B17 | WP-B3 | `scripts/gate/claude-checks.ts` |
| B19 | No fixed point. The part budgets of spec.md section 6.7 use it. | `scripts/gate/claude-checks.ts` |
| B21 to B29 | WP-C2b (the Bash tool of a task step). B28 is optional. | `scripts/gate/claude-checks.ts` |
| B30a to B30d | Your decision on a PreToolUse hook and on the prompt line about grep (spec.md section 6.21). | `scripts/gate/claude-checks.ts` |
| B31 | The shell step prompt rule "first run `cd repo` as a command of its own" (spec.md section 6.21). | `scripts/gate/claude-checks.ts` |
| B32 | The Unrestricted shell mode (shell.md "Unrestricted mode"). The app part waits for B32. | `scripts/gate/claude-checks.ts` |
| G1 to G3 | WP-B1 | `scripts/gate/bitbucket-write.ts` |
| G4 to G6 | WP-B8 | `scripts/gate/bitbucket-write.ts` |
| G7 | No fixed point. INFO only. | `scripts/gate/bitbucket-write.ts` |
| G9, G12 | WP-PN uses the Bitbucket peer reads. Read only. | `scripts/gate/bitbucket-write.ts` |
| G13, G14 | WP-BR1 merges. Read only. | `scripts/gate/bitbucket-write.ts` |
| G15 | WP-MR1. Read only. | `scripts/gate/bitbucket-write.ts` |
| G16, G17 | WP-MR2. Read only. | `scripts/gate/bitbucket-write.ts` |
| G18 | WP-TU1 merges. Read only. | `scripts/gate/bitbucket-write.ts` |

## Record the results

Record each result in the "Review v2 (not run)" rows of integration-check.md. Replace "not run" with the status, the date, and the CLI version. Paste the evidence line of the check. Never paste a host, a user name, a project key, or a path.

## Part B: Claude checks B17 to B20

### Before you run

1. Run `claude auth status`. The script stops when `authMethod` is not `claude.ai`.
2. Run the dry run: `bun scripts/gate/claude-checks.ts --dry-run --only B17,B18,B19,B20`. It builds the fixtures and prints the planned argv. It starts no model call.

### Run

- All four: `bun scripts/gate/claude-checks.ts --only B17,B18,B19,B20`.
- One check: `bun scripts/gate/claude-checks.ts --only B18`. Bare IDs also work: `bun scripts/gate/claude-checks.ts B18 B20`.
- Then sanitize: `bun scripts/gate/sanitize-claude.ts`. It must print `hits=0`. It lists the new raw files as "Not mapped to a check".

### Cost caps

- Every call uses `--model haiku` and at most 4 turns. B19 uses 1 turn.
- Own call caps: B17 1, B18 1, B19 1, B20 5. They do not count against the cap of 14 calls of B1 to B8.
- The run stops before the next call when the result events report 0.60 USD or more in total.
- Each call has a time limit of 180 s. The script kills the process tree at the limit.
- The script removes every temp folder and its per-folder Claude Code project data at the end.

### Output

- The console shows one line per check. `.gate0/v3-local/results.<checks>.json` holds the same lines.
- `.gate0/v3-local/raw/` holds the raw stream of each call. Raw files hold local paths and account data. Do not commit them. The console and the results file show the home folder as `~`.

### What PASS means

| Check | What it runs | PASS |
|---|---|---|
| B17 | An implement run: `--tools Read,Grep,Glob,Edit,Write`, the same `--allowedTools`, `--restricted`, `--strict-mcp-config`, the implement schema, no `--permission-mode`. The prompt asks for three writes: `./repo/a.txt`, `../outside.txt`, and an absolute temp path. | `repo/a.txt` exists. The other two files do not exist, and the run tried to write both. init lists only the five tools and StructuredOutput. |
| B18 | A verify run: `--effort medium`, an agents file with `rl-verifier` at effort high, and the verify schema. The main agent gives one candidate to `rl-verifier`. | The run exits 0, the CLI accepts both effort values, `rl-verifier` runs, and `structured_output` parses with the verify schema. |
| B19 | One short run on your subscription login. | INFO only. Record whether the result event has `total_cost_usd`, and record the `usage` keys and the `modelUsage` fields. Task part budgets use cost only when it is present (spec.md section 6.7). |
| B20 | One run each with the explain, discuss, interview, spec, and implement schemas, under the runner flag set of B11. | Each `structured_output` parses with its zod schema. |

A FAIL of B17 with "not tried" for a write means that the model skipped it. Run B17 again. Any other B17 FAIL blocks WP-B3: write runs need another confinement.

The script holds its own draft-07 copies of the five new schemas and the verify schema, from spec.md sections 1.6, 2.4, 3.3, and 6.5. WP-R1 and WP-B0 move them to `src/shared`.

## Part S: Claude shell checks B21 to B29

These checks give the facts SU1 to SU12 of the integration-check.md section "Claude shell". Run them before WP-C2b. Each check starts one implement run with the Bash tool. It uses the app's own `implementArgs`, `shell.json`, and child env (`shellEnv`), so the gate tests the code that ships. Each run has a temp part folder with a temp git repository at `repo/` and a temp data folder. It never uses a clone of yours or the app data folder. The Bitbucket and Jira origins are `example.invalid` placeholders.

### Before you run

1. Run `claude auth status`. The script stops when `authMethod` is not `claude.ai`.
2. On Windows, install Git for Windows. Claude Code needs Git Bash for the Bash tool.
3. Make sure that `node` or `bun` is on PATH. The probe script runs with `node` when it is on PATH, else with `bun`.
4. Run the dry run: `bun scripts/gate/claude-checks.ts --dry-run --only B21,B22,B23,B24,B25,B26,B27,B27b,B28,B29`. It writes `shell.json` and prints the planned argv. It starts no model call.
5. Optional, for B28: pick a Host alias of your ssh config for a build host, for example `<build-host alias>`. The host must accept your key without a password. B28 runs only `echo` on it.

### Run

- All required checks: `bun scripts/gate/claude-checks.ts --only B21,B22,B23,B24,B25,B26,B27,B27b,B29`.
- With B28: add `B28 --ssh-alias <build-host alias>`, or set `GATE_SSH_ALIAS` in your own terminal. Without an alias, B28 is SKIPPED.
- Run B25 on Windows and on Linux when you can. The result can differ per OS.
- Then sanitize: `bun scripts/gate/sanitize-claude.ts`. It must print `hits=0`. The console and the results file show the alias as `<alias>`.

### Cost caps

- Every call uses `--model haiku`, the app's implement schema, and at most 7 turns.
- Own call caps: one call each for B21, B22, B24, B25, B26, B27, B27b, B28, and B29. B23 reads the B22 run. They do not count against the cap of 14 calls of B1 to B8.
- The other caps of part B apply: 0.60 USD in total, and 180 s per call.

### What PASS means

| Check | Fact | What it runs | PASS |
|---|---|---|---|
| B21 | SU1, V7 | One allowed probe command with the full shell flag set. The app passes no `--permission-mode`. | init lists Bash, the app parser finds no unknown tool, `permissionMode` is default, stderr has no "Permission mode forced" warning, and the probe runs. The line also shows the CLI version and whether it is 2.1.302 or later (V7). |
| B22 | SU2, V19 | Rules: one exact probe command and `echo *`. Commands: that probe, another probe, `git status`, `curl https://example.invalid`, `echo x > ../rlgb-outside2.txt`. | The first probe runs. The next three are refused, and the second probe writes no marker file. INFO for V19: the line prints whether the echo wrote the file outside the run folder. |
| B23 | SU3 | Reads the B22 run. | INFO for you: copy the `permission_denied` fields, the tool_result text, and `permission_denials` into SU3. PASS: the app parser labels the second probe "allowlist" and the two denied commands "deny". A deny rule arrives as type `rule`, or as type `subcommandResults` with the message "Permission to use Bash with command <command> has been denied." |
| B24 | SU4 | Four compound commands, each with a denied part: `&&`, `;`, `$( )`, and a line break. A fifth command, `<probe> && hostname`, has a part with no allow rule and no deny rule. | All four are refused, and no allowed part ran. INFO: the model did not try one of them. Run B24 again. The fifth command is a fact: the line prints its state, whether its probe ran, and its `permission_denied` fields. |
| B25 | SU5, SU11, SU12 | `sleep 600`. The gate starts the CLI as the app does: with the run marker `REVIEW_LOOP_RUN` in the env and in a Job Object on Windows. After the call starts, the gate polls up to 20 s for the new sleep process. Then it calls the app `killTree` on the CLI. | The gate found the sleep. The CLI and the sleep are gone within 5 s. No bash or sleep process with `sleep 600` in its command line, started since the run began, is left. The gate kills each leftover by PID and reports it as a FAIL. INFO: `sleep ended by` (job, marker scan, taskkill, or group), `job` (how many processes the Job Object held, or none when bun:ffi failed), `sleep in job` (SU11), `marker scan hits`, and on Linux `marker in sleep env` (SU12). |
| B26 | SU8, SU12 | A probe prints set or unset and a hash for each env name. It never prints a value. The gate adds `GATE_RLGB_PROBE`, `GIT_ASKPASS`, and a placeholder `SSH_AUTH_SOCK` for this run. It also adds a run marker `REVIEW_LOOP_RUN`. | GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, and GIT_TERMINAL_PROMPT are set. HOME and PATH are set when the gate gave them; the values can differ, because Git Bash sets HOME from USERPROFILE and changes PATH. SSH_AUTH_SOCK, GATE_*, the askpass names, and the ANTHROPIC_* keys are unset. INFO for SU12: whether `REVIEW_LOOP_RUN` is set in the Bash command. |
| B27 | SU9 | Any command (allow `Bash`). Commands: a probe, `git status`, `echo RLGB-U9 > ../rlgb-outside.txt`, `curl https://example.invalid`. | The probe runs, and the deny rules refuse `git status` and `curl`. INFO: the line prints `outside write=<true or false>` for the redirect. |
| B27b | SU9 | The B27 commands with the allow rule `Bash(*)` and the same deny list. | The same as B27. The `outside write` fact shows whether a content rule keeps the check of a write outside the working folder. |
| B28 | SU6, SU7 | Optional. `ssh <alias> echo ...`, the same with an empty known hosts file, and `rsync --version`. | The alias answers, and the unknown host key fails in less than 30 s. INFO: your ssh config accepts unknown host keys. rsync is INFO only. |
| B29 | SU10 | A probe that exits with code 7. | The tool_result text names exit code 7. |

A FAIL of B21, B22, B24, B25, B26, B27, or B27b blocks WP-C2b. Record the evidence line in the "Claude shell" rows of integration-check.md and report it. A FAIL of B23 or B29 changes how the app reads refusals or exit codes (src/server/review/stream.ts).

### B30a to B30d: refused read-only commands, the bare argv rule, a hook, and ssh in Any command mode

These checks give the facts SU14 to SU17 (docs/plans/review-v2/check-fix.md and shell.md "Refused Bash calls in a tests step"). Every command runs locally. No command reaches a host. The same preparation as above applies.

- Dry run: `bun scripts/gate/claude-checks.ts --dry-run --only B30a,B30b,B30c,B30d`.
- Run: `bun scripts/gate/claude-checks.ts --only B30a,B30b,B30c,B30d`. Then sanitize as above.
- Own call caps: B30a 2 (Any command and allowlist), B30b 1, B30c 1, B30d 1.

| Check | Fact | What it runs | PASS |
|---|---|---|---|
| B30a | SU14 | Two compound read-only commands with a grep pattern that holds a quoted backslash-pipe or `^#`, then the same commands without them. One run with allow `Bash`, one with an allowlist (the app adds `Bash(grep *)` and `Bash(rg *)`). | The plain forms run in both runs, and no refusal of the Any command run gets the app label "allowlist". INFO for you: copy the state, `decision_reason_type`, message, and app label of each quoted form into SU14. |
| B30b | SU15 | The rule `<probe> bare *` only. Commands: `<probe> bare`, then `<probe> bare more`. | Both run. INFO: only the longer one runs, so the bare argv needs the exact rule that the app adds. |
| B30c | SU16 | Any command with a PreToolUse hook in shell.json that logs its input and returns permissionDecision "allow". Commands: the two quoted forms of B30a and `git status`. | The hook ran, `git status` stays refused, and both quoted forms run. INFO: the hook ran, and a safety check still refused a quoted form. FAIL: the hook did not run, or `git status` ran. |
| B30d | SU17 | Any command with the saved pattern `ssh rlgb-b30.invalid *`. Commands: `ssh -V`, `scp -V`, `curl --version`. | shell.json has no ssh deny rule, `ssh -V` runs, and the deny list refuses scp and curl. |

The app has no hook. You decide on the hook after B30c.

### B31: a lone cd and the cwd of the next command

This check gives the fact SU18. Every command runs locally. The same preparation as above applies.

- Dry run: `bun scripts/gate/claude-checks.ts --dry-run --only B31`.
- Run: `bun scripts/gate/claude-checks.ts --only B31`. Then sanitize as above.
- Own call cap: B31 4 (Any command and allowlist, each with the app env and without CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).

| Check | Fact | What it runs | PASS |
|---|---|---|---|
| B31 | SU18 | Four runs: allow `Bash`, and an allowlist of the probe pattern only, each with the app env and with CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR removed. Commands, one Bash call each: `cd repo`, `<probe> cwd`, `cd ..`. The runs without the variable add `cd ..` (out of the part folder) and `<probe> cwd out`. repo/ and the folder above the part folder hold a copy of the probe. The evidence names the folder of each probe (repo, part folder, above), never a path. | Every cd runs, and the probe prints repo in both app env runs. INFO: the probe of an app env run prints the part folder (the variable resets the cwd), or a cd of an app env run is refused. FAIL: the CLI refuses `cd repo` or the first probe. The runs without the variable are facts for you. |

### B32: the Unrestricted shell mode

This check gives the fact SU19 (shell.md "Unrestricted mode (decision 2026-11-06)"). Every command runs locally. The only host is the placeholder `bitbucket.example.invalid`, which never resolves. The same preparation as above applies.

- Dry run: `bun scripts/gate/claude-checks.ts --dry-run --only B32`.
- Run: `bun scripts/gate/claude-checks.ts --only B32`. Then sanitize as above.
- Own call cap: B32 2 (one run per mode).

| Check | Fact | What it runs | PASS |
|---|---|---|---|
| B32 | SU19 | Two runs with the app flags, `--restricted`, and no CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: `--permission-mode bypassPermissions` with no allow rule, and `--permission-mode dontAsk` with allow `Bash`. shell.json holds only the Unrestricted deny list: `git push`, `git remote`, `git config`, `git credential`, and `git -c` in each git path form, the placeholder Bitbucket and Jira hosts, and Read of config.json, the database files, and runs/ in the data folder. The data folder is the temp folder above the part folder and holds a fake config.json. repo/ has one commit and a local bare remote. Commands: the env probe, the first quoted compound command of B30a, `git log`, `git diff --stat`, `curl --version`, `git push origin HEAD`, `git remote add`, `git config`, `git -c ... log`, a curl to the placeholder Bitbucket host, `cat <data>/config.json`, an outside redirect, `git -C repo push`, and `git -C repo config`. Then a Read of config.json and a Write to the folder above the part folder. | For at least one mode: `init.permissionMode` equals the mode, the compound command runs, `git log`, `git diff --stat`, and `curl --version` run, the CLI refuses the six deny commands and the Read, no push reaches the remote, no tool result shows the fake config, and the probe sees no ANTHROPIC_* token. Facts for you: the stderr warning, the outside Write and redirect, the `git -C` forms, the env given and seen, and the run marker. |

## Part G: Bitbucket checks G1 to G7

These checks write to the server. Run them only on a test repository that you may change. This is a separate authorization: the script refuses to write without `--authorize-writes` and a repository URL on the command line. It has no default host.

### Before you run

1. Pick a test repository and a base branch, for example `main`. Copy the repository URL from the browser: `https://<host>/projects/<KEY>/repos/<slug>` or `https://<host>/users/<you>/repos/<slug>`.
2. Give the script a token with Repository write on the test repository. Use one of these:
   - `bun scripts/gate0/set-token.ts`. The script sends this token only to the stored URL origin.
   - The environment variable `GATE_BITBUCKET_TOKEN`. Set it in your own terminal only.
3. For G2, pick the user slug of another user. Bitbucket drops the PR author (the token owner) from the reviewers without an error. For G7, pick a Jira key that the app links. G3 needs no CI. Optional: if CI builds the test repository, pick a commit with build statuses for `--build-commit`.
4. Optional, for G1: put a read-only token into an environment variable, for example `GATE_READONLY_TOKEN`.
5. Run the dry run: `bun scripts/gate/bitbucket-write.ts --dry-run`. It runs all steps against a loopback fake server and a local bare repository. It reads no secret, and nothing leaves the machine. It must print `dry run: PASS`.
6. If every request fails on TLS, set `NODE_EXTRA_CA_CERTS` to your CA PEM file.

### Run

- Before WP-B1: `bun scripts/gate/bitbucket-write.ts --repo <URL> --target main --authorize-writes --only G1,G2,G3 --reviewer <slug> [--build-commit <commit>] [--readonly-token-env GATE_READONLY_TOKEN]`
- Before WP-B8: `bun scripts/gate/bitbucket-write.ts --repo <URL> --target main --authorize-writes --only G4,G5,G6`
- G7: `bun scripts/gate/bitbucket-write.ts --repo <URL> --target main --authorize-writes --only G7 --jira-key <KEY-123>`. Then sync the app, open the PR that the script names, and record whether the PR row and the PR view show the task chip.
- Remove what G7 left, or what a stopped run left: `bun scripts/gate/bitbucket-write.ts --repo <URL> --authorize-writes --cleanup`.
- `--keep` leaves all gate branches and PRs in place for a look on Bitbucket. Remove them with `--cleanup`.
- G3 posts its build status with the repository-scoped API: `POST /rest/api/1.0/projects/{p}/repos/{r}/commits/{id}/builds` (Bitbucket 7.4 and later, REPO_READ; `latest` is the same as `1.0`). Fallback for older servers: the legacy `POST /rest/build-status/1.0/commits/{id}` (LICENSED). The script does not use the fallback.
- The synthetic build status stays on the gate commit. Not all Bitbucket versions can delete a build status, and the DELETE needs REPO_ADMIN. The cleanup deletes the gate branch only. The status touches no other branch or repository.

### Safety rules of the script

- Every branch that the script pushes or deletes starts with `rl-gate-`. The script never pushes the target branch.
- Every push uses `--force-with-lease`. A new branch uses an empty lease.
- The token goes only to the origin of `--repo`. The script refuses a clone link with another origin before it pushes.
- git runs with an empty global config, no system config, no credential helper, and no prompt. The token goes in the `http.extraHeader` config of the child process only.
- At the end, the script declines its PRs and deletes its branches, except the G7 branch and PR.
- The console and `.gate0/bitbucket-write/result*.json` hold only status codes, booleans, key names, enum-like strings, counts, and gate branch names. git messages pass as markers, such as `[rejected]` and `(stale info)`.

### What each check does

| Check | What it does | PASS |
|---|---|---|
| G1 | Reads the repository clone links. Pushes a new branch with an empty lease. With `--readonly-token-env`, pushes one more new branch with the read-only token. | An http clone link with the server origin, the push exits 0, and the remote branch is at the pushed commit. The read-only push line is INFO: record its exit code, markers, and HTTP status. |
| G2 | Creates a PR from the G1 branch to the target with one reviewer. | HTTP 201 with an ID, a version, and 1 reviewer. |
| G3 | Reads the build stats of the new G1 commit (expect 0 builds). Posts one synthetic build status to that commit: key `rl-gate`, state `SUCCESSFUL`, a placeholder `https://example.invalid/...` URL. Reads the stats again. With `--build-commit`, also reads the stats of that commit. | Both reads of the gate commit give HTTP 200 with the numbers `successful`, `inProgress`, and `failed`, and the second read shows `successful` 1 or more. Record the POST status code (204 expected) and its response keys. The `--build-commit` read is INFO only. |
| G4 | Creates a stacked PR (upper branch to lower branch). Sends a PUT with the version and a new `toRef` (the target), then a PUT back. | The PUT gives HTTP 200 and the PR targets the target branch. Record "title unchanged" and the reviewer counts: they show whether a PUT without these fields keeps them. |
| G5 | Deletes the lower branch, which is the target of the stacked PR. Reads the PR for up to 30 s. | The delete exits 0 and the PR read gives HTTP 200. Record the outcome: the state (DECLINED or OPEN) and the toRef (lower branch, target branch, or other). |
| G6 | Moves the remote upper branch, then pushes another commit with the old lease. | The move exits 0, the second push fails with `(stale info)`, and the remote keeps the moved commit. |
| G7 | Creates a PR with the Jira key in its title and keeps it. | INFO. Record whether the app shows the task chip after a sync. |

## Part G, read only: G9 and G12 for the PR context

G9 and G12 send only GET requests (tasks.md WP-PG, spec.md section 2.8). They need no `--authorize-writes` and no `--target`. They still need `--repo` with your test repository. The script has no default host. Token, origin rule, and output rules are the same as for G1 to G7. A token with Repository read is enough.

### Before you run

1. The test repository must have one open PR where you are not the author, a reviewer, or a participant. Ask another user to open one if necessary. An own open PR is optional: G12 then also reads its changes for a comparison.
2. Run the dry run: `bun scripts/gate/bitbucket-write.ts --dry-run --only G9,G12`. It must print `dry run: PASS`.

### Run

- `bun scripts/gate/bitbucket-write.ts --repo <URL> --only G9,G12`
- The console and `.gate0/bitbucket-write/result.g9-g12.json` hold only status codes, counts, key names, and enum-like change types. They never hold a title, a name, a path, or a host.

### What each check does

| Check | What it does | PASS |
|---|---|---|
| G9 | Reads the open PRs of the repository: `GET .../pull-requests?state=OPEN&limit=50`. Records the page keys, the PR keys, the author and fromRef keys, the count, `isLastPage`, and whether the `X-AUSERNAME` header is present. | HTTP 200, and the page parses with the app schema `page(pullRequest)` (id, title, author, state, fromRef, toRef, updatedDate, isLastPage). |
| G12 | Takes the newest PR of the G9 list where the token user (`X-AUSERNAME`) is not the author, a reviewer, or a participant. Reads its changes: `GET .../pull-requests/{id}/changes?limit=50`. Reads the changes of one own PR of the list the same way, if one exists. | HTTP 200, and the page parses with the app schema `page(change)` (path, srcPath, type, isLastPage). The own PR read, if any, must pass the same way. SKIPPED: the list has no PR without you. Fix the setup and run again. |

Record G9 and G12 in their "Review v2" rows of integration-check.md. A FAIL of G9 or G12 means that the PR context lists only PRs from your inbox (spec.md section 2.11).

## Part G, read only: G13 to G17 for branches and several repositories

G13 to G17 send only GET requests (tasks.md WP-GB, spec.md section 6.16). They need no `--authorize-writes` and no `--target`. They need `--repo` with your test repository. Token, origin rule, and output rules are the same as for G1 to G7. A token with Repository read is enough. A token with Repository write makes G15 and G16 show the write facts that the app needs.

### Before you run

1. The test repository must have at least one merged PR for G17. Without one, G17 is SKIPPED.
2. Use your normal token, not an admin token. G15 must record what a plain user's token gets from the restriction search.
3. Run the dry run: `bun scripts/gate/bitbucket-write.ts --dry-run --only G13,G14,G15,G16,G17`. It must print `dry run: PASS`.

### Run

- `bun scripts/gate/bitbucket-write.ts --repo <URL> --only G13,G14,G15,G16,G17`
- The console and `.gate0/bitbucket-write/result.g13-g14-g15-g16-g17.json` hold only status codes, counts, booleans, key names, enum-like values, and restriction type names. They never hold a branch name, a repository name, a project key, or a host.

### What each check does

| Check | What it does | PASS |
|---|---|---|
| G13 | Reads `GET /rest/api/1.0/projects/{p}/repos/{r}/default-branch`. Also reads the deprecated `GET .../branches/default` for a comparison. | HTTP 200 with an `id` that starts with `refs/heads/` and a string `displayId`. Record whether the deprecated read gives the same id. |
| G14 | Reads `GET .../branches?orderBy=MODIFICATION&limit=25`, then the same with `filterText=<default branch>&boostMatches=true`, then a filter that matches nothing. Records the branch keys, the ref types, and how many values carry a default flag. | Each read gives HTTP 200 with `values` and `isLastPage`. The filtered read has the exact match first. The no-match read has 0 values. Record the key name of the default flag (`isDefault` or `default`). |
| G15 | Reads the repository name, then `GET /rest/api/1.0/repos?permission=<level>&projectkey=<KEY>&name=<name>&limit=100` for REPO_READ, REPO_WRITE, and REPO_ADMIN. Reads `GET /rest/branch-permissions/latest/projects/{p}/repos/{r}/restrictions?limit=100`. | The three permission reads give HTTP 200, and REPO_READ lists the test repository. Record "listed" for REPO_WRITE and REPO_ADMIN. Record the restriction status: the docs say that the search needs REPO_ADMIN, so a plain token should get 401. With 200, record the restriction types and matcher types. |
| G16 | Reads `GET /rest/api/1.0/repos?permission=REPO_WRITE&limit=100&start=<n>`, at most 10 pages. | HTTP 200 on each page and a boolean `isLastPage`. Record the page count, the repository count, the key names, the clone link names, and whether the test repository is listed. |
| G17 | Reads the newest merged PR (`GET .../pull-requests?state=MERGED&limit=1`) and its activities (`GET .../pull-requests/{id}/activities?limit=50`). | PASS: `properties.mergeCommit.id` or the commit of the MERGED activity is a 40-character commit ID. INFO: neither field is there, so the app uses the fallback sentence of spec.md section 6.16.8. SKIPPED: no merged PR. |

Record G13 to G17 in their "Review v2" rows of integration-check.md. A FAIL of G13 makes the app use `git ls-remote --symref` for the default branch. A FAIL of G14 blocks the base picker of WP-BR2.

## Part G18, read only: the merge result of an open PR

G18 sends only GET requests (tasks.md WP-TU1, spec.md section 6.18.5). It needs no `--authorize-writes` and no `--target`. It needs `--repo` with your test repository. Token, origin rule, and output rules are the same as for G1 to G7. A token with Repository read is enough.

### Before you run

1. Open one PR in the test repository, and make it conflict with its target branch by hand: change the same line in the target branch and in the PR branch.
2. Open the PR page once, so that Bitbucket checks the merge.
3. Run the dry run: `bun scripts/gate/bitbucket-write.ts --dry-run --only G18`. It must print `dry run: PASS`.

### Run

- `bun scripts/gate/bitbucket-write.ts --repo <URL> --only G18`
- The console and `.gate0/bitbucket-write/result.g18.json` hold only status codes, counts, key names, and enum-like values. They never hold a branch name, a repository name, a project key, or a host.

### What the check does

| Check | What it does | PASS |
|---|---|---|
| G18 | Reads the open PRs (`GET .../pull-requests?state=OPEN&limit=50`) and records the keys of `properties` and `properties.mergeResult`, and each pair of outcome and current. | Each open PR has `properties.mergeResult` with a string `outcome` and a boolean `current`, and one PR reports `CONFLICTED` with current true. INFO: no PR reports `CONFLICTED`; check the conflicted PR and run again. SKIPPED: no open PR. |

Record G18 in its "Review v2" row of integration-check.md. The app reads outcome `CONFLICTED` with current true as a PR with conflicts (src/shared/task.ts MERGE_CONFLICTED). A different outcome value changes that constant before WP-TU1 merges.
