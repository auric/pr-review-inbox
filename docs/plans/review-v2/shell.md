Status: design of 2026-11-02 for the commands package (C1, code complete) and the Claude shell (C2). WP-C2a, WP-C2b, WP-C2c, and WP-C2d are code complete. spec.md section 6.21 holds the design with the later gate facts and user decisions; it wins over this file. Shell gate run 1 (2026-11-03) results are in integration-check.md rows SU1 to SU10. The Stop kill fix of shell gate run 2 is code complete: a Windows Job Object, the run marker scan on Linux, the kill after every run and every check command, and the xargs deny rule in allowlist mode. Known limit: tree, fd, du, ps, pgrep, and lsof run with no rule and can show file names and process lists outside the folder. Run B25 and B26 again on Windows and on Linux (integration-check.md SU5, SU11 to SU13).

# Plan: commands package (C1) and Claude shell (C2)

Written by the Plan agent on 2026-11-02 against main 2c20274. User decisions: allowlist per repo (default), "Any command" per-repo switch with warning, the plan step proposes the allowlist, "Claude asks to allow" requests during steps, ssh build-host skill end to end, key files never copied from skills. Open-question defaults accepted (see end).

Blocker that S6/D8 fixes: the path check fails a step that changes any git-ignored file and removes the worktree (implement.ts:157-158, undoStep 259-265). Any Claude-run build writes such files.

## Steps

S1. Commit only Claude's changes (C1). Files: worktree.ts commitStep, implement.ts commitTask/pathCheck, end of startStep, shared/task.ts stepDetail, loop.ts commit and the plan commit at ~1155. The commit stages `git add -u` (tracked changes and deletes), then `git add -- <new paths>`. A new untracked path is committed only when (a) a successful Write event of a Claude step since the last commit named it (new detail.written from run events, mapped per repository of the part), (b) the app wrote it (plan files, passed as a list), (c) C2 only: it is in the Files lines of the plan task and appeared during a Claude step. Everything else stays on disk, with the note "Not committed: N new files that Claude did not write (.venv/, build/)". The path check judges only staged paths. Every commitStep caller (8 in implement.ts) passes its own list. Tests: setup-made .venv/ and build/ stay out; Write-made src/new.ts goes in; tracked edits/deletes go in; plan files go in; submodule Write maps to that submodule's commit; a link in unclaimed output no longer blocks the commit. Risk: tested tree differs from committed tree when an unclaimed generated file is needed; the commit note names the file.

S2. Setup runs again when its list changes (C1). Files: loop.ts:1156-1163, worktree.ts setupMark/resetWorktree, tasks.ts routes, dto.ts. The mark holds sha256 of the ordered setup commands (argv + timeout); a different hash runs setup. resetWorktree runs `git clean -ffd` without -q; when it removed anything it deletes the mark. New route POST /api/tasks/:id/parts/:part/setup {version} runs setup now as a driver (409 while a step runs), writes the mark when green, blocks red when it fails. Task view More menu: "Run setup again". Tests: changed list runs setup (counter 2), unchanged does not; route runs setup; a reset that cleans files makes the next build run setup. Accept that old empty marks run setup once after upgrade.

S3. Reorder commands (C1). Files: web/tasks/commands.ts (new moveDraft), CommandsEditor.tsx. Each row gets "Move up"/"Move down" (aria-label "Move <name> up/down"), disabled at the ends, focus follows the row. List order = run order (checks.ts:404-421). Tests: tests/web/task-commands.test.ts for moveDraft; e2e: Settings > Tasks and Plan tab keep the order after reload.

S4. Never copy key files from skill folders (C1). Files: review/skills.ts copyOne (~113-153), copyTree (~275-305), taskIndexText. Leave out by name SECRET_NAME: id_*, *.pem, *.key, *.ppk, *.p12, *.pfx, *.jks, *.keystore, *.kdbx, .env*, _netrc, .netrc, credentials, credentials.json; and by content SECRET_TEXT: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|^PuTTY-User-Key-File-\d+:/m. INDEX.md shows "(N key files left out)". A SKILL.md that matches leaves the whole skill out ("SKILL.md holds a private key"). Review runs use the same functions. Tests: user skill with id_ed25519 (text), deploy.pem, notes.md with a PEM block, k.ppk, .env, _netrc: none copied, README.md copied, index shows 5; repository skill (copyTree) same.

S5. Allowlisted Bash in the runner (C2). Files: review/claude.ts (ImplementSpec.shell, implementArgs, childEnv), new tasks/shell.ts (settings file, deny list), review/stream.ts (Bash target and note, refusal count), shared/task.ts (allowPattern). A shell step adds Bash to --tools, plus `--settings <appDir>/shell.json` and `--permission-mode dontAsk`. Init check accepts Bash. Bash missing from init: the step fails with "Install Git for Windows. Claude Code needs Git Bash to run commands." Tests (tests/review/runner.test.ts, new tests/tasks/shell.test.ts): argv and shell.json for allowlist, Any, and no shell (today's argv byte for byte); network deny list leaves out ssh when an entry names ssh; Read deny rules use //c/... form on Windows; env checks of D5.

S6. Allowlist life cycle and Bash steps in the loop (C2). Migration (next free number): repo_task_settings adds shell_mode TEXT NOT NULL DEFAULT 'allowlist' CHECK (shell_mode IN ('allowlist','any')), allow_json TEXT NOT NULL DEFAULT '[]', shell_warned_at INTEGER, bash_timeout_sec INTEGER NOT NULL DEFAULT 600. shared/task.ts: specResult.testing.allow, implementResult.allowRequest, BLOCKED_KINDS adds allow. implement.ts: prompt lines, startStep, pathCheck (D8). loop.ts: claude() handles the allow block and re-runs the step. tasks.ts: plan approval merge, repoSettings. dto.ts: inputs, TaskDto.shell / allowAsk. Routes.

S7. UI (C2). Settings > Tasks per repository: "Commands Claude may run" (list with reasons, mode switch, "Longest command"), "Claude may run the approved checks" (on by default). Plan tab: second editor with proposals, ticks, "approved before". Blocked row for allow requests. Task header: "Commands: allowlist, 5 patterns" or "Commands: any command" (warning colour). Log tab: each Claude step shows its mode and "Commands Claude ran (n)", each row command, state, output tail. RunLog.tsx shows a Bash target as code and its note as a collapsible pre. e2e with fake CLI Bash events. Screenshots + README.

S8. Gates and docs (C2). scripts/gate/claude-checks.ts gets B21-B29; integration-check.md gets the U rows; smoke-task.md part T2 (remote build). BRIEF 3.5/3.6, spec 6.3/6.14/6.19.2, new spec 6.21, CHANGELOG.

## Design

D1. Allowlist storage: allow_json [{id, pattern, reason, source: plan|request|user, addedAt}], max 50. User writes the inner pattern (`ssh <alias> *`); app writes `Bash(<pattern>)`. zod allowPattern refuses: >200 chars, newline, ( ) backtick $( ; & | < >; `*` in the first word or `*` alone; first word a shell or runner (bash sh zsh dash fish cmd powershell pwsh wsl env eval exec xargs sudo su doas runas watch setsid flock) with "Use Any command instead"; git, credential-store tools, a program written as a path (*/git, git.exe); the Bitbucket or Jira host name. Warns (not refuses) for interpreters (python python3 node bun deno perl ruby npx uvx make): "This pattern lets Claude run any code." Server re-checks on each save. Bash is on only when mode is any or the list is not empty. With "Claude may run the approved checks" on, the app adds `Bash(<argv joined> *)` at run time for each approved check whose argv items match ^[A-Za-z0-9_./:=@%+,-]+$.

D2. Proposals: specResult.testing.allow: array {pattern max 200, reason max 300} max 15 default []. Spec prompt line: "List in testing.allow each command that the implement steps must run themselves, such as the remote build and the copy to the build host that a skill describes. Make each pattern as narrow as you can. Give a one-line reason. Never list git, a shell, or the Bitbucket or Jira host." The spec run stays read-only. A proposal that fails allowPattern becomes a plan note. taskPlanInput adds allow: array(union(allowId, allowEntry)) max 50 (ID and "new-" rules like commands) and shellWarning: literal(true).optional(). Approval merges picks into allow_json (no duplicates); the first non-empty list needs the shell warning. Later plans show saved entries ticked, "approved before".

D3. Request during a step: implementResult.allowRequest: array {pattern max 200, command max 1000, reason max 300} max 3 default []. Prompt lines (tests, implement, fix, instruct): "You can run only these commands: <patterns>. Claude Code refuses every other command." / "When Claude Code refuses a command that the step needs, do not try another form of it. End the step: set allowRequest with the narrowest pattern, the refused command, and a reason. Set done to false." Instruct adds: "When the request asks for allowlist changes, set allowRequest and change no file." A refused call is a tool_result with is_error; the stream also has permission_denied and permission_denials in the result (V7; exact text U3). The parser counts refused Bash events; more than 5 in a run kills the run (like badTools) and the app builds the request from the refused commands with exact patterns. After the run the app re-checks each request with allowPattern and the deny list, blocks the task with kind allow, keeps the step's patch, resets to the last commit (undo path). UI row: "Claude asks to allow a command." Each request: pattern, command, reason; choice Allow once (default) / Allow for this repository / Refuse; primary "Continue". Allow once = only the next run of that step. Allow for this repository writes allow_json (first one needs the shell warning). Refuse adds "The user refused <pattern>. Do the step without it, or set question." to context/step.md. Route POST /api/tasks/:id/allow {version, step, decisions:[{pattern, choice}]} -> 202 and re-runs the step (attempt+1); 409 when not waiting on allow; 400 for a bad pattern. Limits: max 3 requests per step, 10 allow blocks per part, then error "Claude asked for too many commands"; a pattern refused for this task never shows again; in Any mode allowRequest is ignored.

D4. CLI flags: `-p --output-format stream-json --verbose --restricted --strict-mcp-config [--mcp-config] --tools Read,Grep,Glob,Edit,Write,Bash --allowedTools Read,Grep,Glob,Edit,Write[,mcp] [--disallowedTools mcp-denied] --settings <appDir>/shell.json --permission-mode dontAsk --json-schema ... --max-turns ... --no-session-persistence`. shell.json: {permissions:{allow:[Bash(p)...] or ["Bash"] for Any, deny:[...], blockReadsOutsideWorkingDirectories:true, disableBypassPermissionsMode:"disable"}}. Rules in a file because --restricted loads --settings (V9); avoids Windows quoting and MAX_ARGV. Deny list (both modes; deny wins, V5): git: Bash(git *), Bash(*/git *), Bash(git.exe *), Bash(*\git.exe *); forge/tracker: Bash(*<bb-host>*), Bash(*<jira-host>*) from configured origins; network programs Bash(<tool> *) for curl wget nc ncat netcat socat telnet ftp tftp sftp scp ssh rsync, a tool left out only when an allowlist entry has it as its program; credential stores: secret-tool, security, cmdkey, kwallet-query, keyring, powershell*, pwsh*; reads: Read(//<dataDir>/config.json), Read(//<dataDir>/*.db*), Read(//<dataDir>/logs/**), Read(//<dataDir>/runs/**), Read(~/.ssh/**), Read(~/.git-credentials), Read(~/.netrc), Read(~/_netrc), Read(~/.claude/.credentials.json); data folder in long POSIX form (V20). Read deny also stops cat/head/tail/sed/tee/redirects (V6); ssh still reads its key. Do not deny the whole data folder (the step cwd is inside it).

D5. Child env of a shell step: from childEnv(), keep real HOME, USERPROFILE, SSH_AUTH_SOCK. isolate_home stays an option of app-run checks only. Remove GATE_* from every child, plus GIT_*, GIT_ASKPASS, SSH_ASKPASS. Set GIT_CONFIG_COUNT=1, GIT_CONFIG_KEY_0=credential.helper, GIT_CONFIG_VALUE_0= (empty); GIT_TERMINAL_PROMPT=0; GCM_INTERACTIVE=never; CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1; CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1; CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1; BASH_DEFAULT_TIMEOUT_MS and BASH_MAX_TIMEOUT_MS = bash_timeout_sec*1000 (1-3600 s). Keep CLAUDE_CODE_GIT_BASH_PATH from the parent (today childEnv removes every CLAUDE_CODE_* var, claude.ts:120).

D6. cwd stays the part folder; Claude writes `cd repo && ...`. Each command has the Bash timeout; the step keeps its own limit and the runner kills the CLI tree. Stop uses killTree (taskkill /T on Windows, process group on POSIX, claude.ts:153-161); U5 gate; if it fails on Linux, killTree also walks child PIDs via /proc. Stop does not end a remote build; prompt: "Wrap each remote command in `timeout <s>` on the build host." Windows needs Git for Windows (V12); app checks init tools for Bash.

D7. Log: Bash event target = input.command up to 4000 chars (today a 300-char JSON slice, stream.ts:58-67); note = last 4096 bytes of the result for success and error; refusal note "Refused by the allowlist" / "Refused by the deny list". No migration (run_event.note TEXT). Step end: detail.shell = {mode, rules, commands:[{command, state, ms}] max 50, refused}. Prompt: "Pipe long build output through `tail -n 200`."

D8. Path check for shell steps: allowed: changes to ignored files. Still fails: a Write/Edit target that git ignores, a new link, anything outside repo/, denied paths. A failed step that changed ignored files still removes the worktree; setup runs again in the new one.

D9. App-run vs Claude-run: app runs setup once per worktree before any Claude step, and build/test/lint after the steps and before its own review (the green result must come from the app). Claude runs allowlist commands only inside a step. A remote build that must count as a check is an app-run argv like `ssh <alias> make test`; it needs "Isolate home" off for that repository; the Plan tab says so when an argv starts with ssh, scp, or rsync.

D10. Remote build skill end to end: the skill reaches context/skills (64eff3a); S4 drops its key files. The spec run reads it and proposes patterns like `ssh <alias> *`, `scp -r repo <alias>:*`, `tar -C repo -czf - .` plus `ssh <alias> *` for a pipeline (each part its own entry, V2). Git for Windows may lack rsync (U7). The ssh config Host block should set BatchMode yes, ConnectTimeout 15, ServerAliveInterval 30, IdentitiesOnly yes, IdentityFile ~/.ssh/<key>. Git Bash ssh reads $HOME/.ssh and SSH_AUTH_SOCK, not the Windows agent pipe (U6).

D11. Prompt injection and warnings: rules match only command text (/usr/bin/curl, sh -c, git -C . push get past a deny rule, V4); .bashrc aliases apply (V17); no OS sandbox on native Windows (V11). Any-command confirm dialog (buttons "Turn on Any command", "Cancel"): "Any command lets Claude run every command as you, with your files, your keys, and your network. Text in a Jira task, an attachment, or a comment can tell Claude to run a harmful command. The deny list and the Log tab only reduce mistakes. They do not stop an attacker. Use Any command only for repositories and tasks that you trust." First-use allowlist warning ("I understand"): "Claude can run each command that matches this list, as you, with your files, your keys, and your network. A pattern can match more than you expect. A pattern for an interpreter, such as python, lets Claude run any code. The deny list and the Log tab only reduce mistakes. They do not stop an attacker."

D12. Wording drafts. BRIEF 3.5: replace "App-run commands (decision Q2): Claude never starts a process." with: "Commands (decision Q2, changed 2026-11-02): the app runs the setup, build, test, and lint argv lists that the user approved. The tests, implement, fix, and instruct steps also get the Bash tool when the repository has an approved allowlist or uses Any command. The interview, spec, resolve, and own review steps never get it." / "The spec run proposes allowlist patterns, and the user approves them on the Plan tab. A step can ask for one more pattern. The user picks Allow once, Allow for this repository, or Refuse." / "A fixed deny list always applies: every git command, the Bitbucket and Jira hosts, network programs that no entry names, the credential-store tools, and reads of the app data files and ~/.ssh. These rules match the command text only. They reduce mistakes. They do not stop an attacker." / "Bash commands use the real HOME, so ssh keys and ssh config work. The child environment has no app token, no GATE_* variable, no askpass program, and an empty git credential helper. Each command and the end of its output show in the Log tab." BRIEF 3.5 line ~151: "It gets no shell" -> "It gets no shell other than the Bash tool of spec section 6.21". BRIEF 3.6 add: "A command that Claude runs can reach any host that the allowlist or Any command lets it reach. The deny list refuses the Bitbucket and Jira hosts." Spec 6.19.2 line ~1924: "...No shell..." -> "A tests, implement, fix, or instruct run of a repository with shell commands adds Bash to --tools, --settings <app>/shell.json, and --permission-mode dontAsk (section 6.21)." Spec 6.14 adds: a refused command ends the step with allowRequest; Windows without Git Bash fails with the install sentence; Stop does not end the remote process. New spec 6.21 holds D1-D9 and AC-B72 onward.

## CLI facts (verified 2026-11-02, code.claude.com/docs/en/{permissions, permission-modes, cli-reference, headless, sandboxing, settings-reference, env-vars, tools-reference, setup})
V1 Bash(cmd *): * anywhere; trailing " *" also matches the bare command; ":*" = trailing " *"; bare Bash matches all. V2 && || ; | |& & newline: every subcommand must be allowed; a deny rule matches any subcommand, also in subshell, $( ), loop body. V3 wrappers stripped: timeout time nice nohup stdbuf command builtin bare xargs; deny matches past leading VAR=. V4 rules match text, not program; "isn't a security boundary". V5 deny, then ask, then allow; allow cannot except a deny. V6 read-only commands need no approval; Read/Edit deny rules cover cat head tail sed tee redirects, not scripts. V7 -p runs in Manual mode (2.1.302+), refuses calls needing approval; refusals stream as permission_denied, listed in permission_denials. V8 dontAsk refuses anything that would prompt. V9 --restricted keeps a command tool only when --tools names it, keeps file tools inside working folders, loads only managed settings and --settings, refuses bypass, needs 2.1.248+. V10 --disallowedTools entries are deny rules. V11 sandbox only macOS/Linux/WSL2. V12 Windows Bash needs Git Bash; else PowerShell tool; CLAUDE_CODE_GIT_BASH_PATH. V13 Bash timeout default 120000 ms, max 600000, env-set; ~30000 chars output inline. V14 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1. V15 CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1. V16 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 keeps GIT_CONFIG_*. V17 ~/.bashrc and ~/.profile aliases apply. V18 blockReadsOutsideWorkingDirectories covers Read Grep Glob LSP only; shell reads outside need approval (refused in -p). V19 > redirect outside working folders needs approval. V20 Windows rule paths POSIX form //c/x.

Unverified -> user gates: U1 the CLI accepts --restricted + --tools ...,Bash + --permission-mode dontAsk + --settings together and init lists Bash. U2 --settings allow/deny apply under --restricted. U3 exact refusal text in tool_result and permission_denied fields. U4 compound commands with a denied part are refused (<allowed> && git status; <allowed>; curl x; echo $(git log); newline form). U5 Stop ends bash, ssh, sleep 600 within 5 s on Windows and Linux. U6 Git Bash ssh with real HOME resolves alias and key; unknown host key fails < 30 s. U7 Git for Windows ships rsync (expect not). U8 subprocess scrub keeps SSH_AUTH_SOCK, HOME, PATH. U9 in Any mode deny list and outside-redirect check still refuse. U10 exit code shows in the Bash result text.

## Invariants relied on
Checks run in commands_json order (checks.ts:404-421). Setup once per worktree, mark in admin folder (loop.ts:1156-1163, worktree.ts:346-347). Commit runs git add -A (worktree.ts:530), path check covers every status entry (implement.ts:518). A post-step change to an ignored file fails the step and removes the worktree (implement.ts:157-158, 259-265). Unknown init tool kills the run (stream.ts:174-178, claude.ts:436-440). childEnv removes CLAUDE_CODE_* (claude.ts:120). killTree (claude.ts:153-161) on detached POSIX spawn (claude.ts:421). copyOne/copyTree skip only hidden, binary, link files (skills.ts:136-146, 286-301). Spec 6.18 "You cannot run git" stays true under Bash(git *).

## Open questions, defaults accepted
1 Deny every git command (Claude has the read-only git MCP). 2 resolve step gets no Bash. 3 interview, spec, own review get no Bash. 4 "Allow once" = next run of that step only. 5 Approved checks become allow rules automatically, on by default. 6 Bash timeout 600 s default, 3600 s max. 7 OS sandbox on Linux later. 8 Windows ssh: key file named in ssh config, not the Windows agent.

## Work packages (one implementer at a time, in order)
1 WP-C1a (implementer-xhigh): S1 + S2 + C1 prompt line "When you need a command that the app does not run, set question and name the setup command or allowlist entry you need, with a reason." Files: worktree.ts, implement.ts, loop.ts, tasks.ts routes, shared/task.ts, dto.ts, tests, spec 6.3/6.7/6.14.
2 WP-C1b (implementer): S4. Files: skills.ts, tests/review/skills.test.ts.
3 WP-C1c (implementer): S3 + "Run setup again" button. Files: commands.ts, CommandsEditor.tsx, TaskView.tsx, web/tasks/model.ts, e2e, screenshots, README.
4 WP-C2a (implementer-xhigh): S5. Files: claude.ts, stream.ts, new tasks/shell.ts, shared/task.ts allowPattern, runner/stream/shell tests.
5 WP-C2d (implementer): B21-B29 gate script, U rows in integration-check.md, smoke part T2. The user runs these gates before WP-C2b.
6 WP-C2b (implementer-xhigh): S6 + D8 with fake-CLI tests (allowRequest blocks with kind allow, three choices re-run the step; bad pattern 400; refused-before pattern only in notes; >5 refusals kill the run and build the request; plan approval saves allow picks and needs the shell warning first time; ignored build output passes, Write into ignored path fails).
7 WP-C2c (implementer): S7 UI, e2e, screenshots, README, BRIEF/spec wording (D12), CHANGELOG.


## Shell gate run 2 (2026-11-03): analysis of B25 and the B24 hostname fact

Written by the investigator against main fe47a6f. Run 2 passed B21 to B24, B26, B27, B27b, and B29. B25 failed.

I found the cause of both problems. Problem 1 is proven on this machine without the real CLI. Problem 2 is proven from the 2.1.316 bundle. I edited no tracked files; my scripts are in the session scratchpad.

### 1. B25: a Claude-started command survives Stop

**Cause on Windows (proven):** Git Bash starts a command by fork then exec. The forked copy starts `sleep.exe` and then exits. So the Windows parent of `sleep.exe` is a process that no longer exists. `taskkill /T` walks the parent links and never reaches it.
- Local test: node starts `bash -c "sleep 601; echo done"`, then `taskkill /T /F` runs on node. Bash and node end, `sleep.exe` stays. Its parent ID points to a dead process.
- With `bash -c "sleep 601"` (bash execs directly), bash stays as a stub, so sleep is its child and dies.
- A Job Object is not the cause. It is the fix.

**Linux is broken too (strong hypothesis, not run on Linux):** the bundle builds the Bash tool's shell with `{type:"bash", ..., detached:!0}` and spawns it with `detached: rn.detached`. So each command gets its own session and process group. Our `process.kill(-pid)` only ends the CLI's own group.

**Fix:**
- **Windows:** put the CLI in a Job Object through `bun:ffi` on `kernel32.dll`. No native build is needed.
  - Calls: `CreateJobObjectW`, then `SetInformationJobObject` (class 9, 144 bytes, `LimitFlags`=0x2000 kill-on-close at offset 16), then `OpenProcess(0x101, 0, pid)` and `AssignProcessToJobObject` right after `Bun.spawn`.
  - On kill: `TerminateJobObject` and `CloseHandle`. Keep `taskkill /T` as the fallback.
  - Tested (`job.ts`): assign worked even though this test already runs inside a job. Terminate ended node, bash and the orphaned sleep in under 300 ms. When the app exited without a terminate call, kill-on-close also ended the sleep (`crash.ts`).
- **Linux:** add a marker `REVIEW_LOOP_RUN=<uuid>` to the CLI environment. On kill, run `kill(-pid)`, then scan `/proc/*/environ` for the marker and SIGKILL each match. Repeat the scan up to 3 times. This also catches commands moved to init after `&` or `setsid`.

**Code shape, in `src/server/review/claude.ts`:**
- Add `const jobs = new Map<number, Pointer>()`.
- Add `contain(pid, marker)`: on win32 it creates and assigns the job and stores the handle.
- Change `killTree(pid, marker?)`: on win32 it terminates and closes the job first, then runs taskkill. On Linux it kills the group, then runs the marker scan.
- Call `contain` right after `Bun.spawn` (about line 425). Put the marker into `env`.
- In `finally`, always call the kill, even when the CLI ended normally. Today `finally` kills only when `exitCode === null`, so `cmd &` leftovers live on after a normal exit.
- `src/server/tasks/checks.ts:109` has the same gap for build and test commands that run under Git Bash. It should use the same helper.

**Test:** add `tests/server/review/kill-tree.test.ts`.
- Windows: a bun parent starts a node child that runs Git Bash `sleep 6543; :`. Wait until that `sleep.exe` shows, call `killTree`, and expect it gone within 2 s. Skip when Git Bash is absent.
- Linux: the parent runs `sh -c 'setsid sleep 6543 & wait'`. Expect the same.
- Control: remove the `contain` call and the test must fail. I showed this case locally.
- Then run B25 again on Windows and on Linux.

### 2. B24: `hostname` ran with no rule

Yes. `hostname` is in the CLI's built-in safe-command list, which needs no allow rule:
- The entry is `hostname:{safeFlags…, regex:/^hostname(?:\s+(?:-[a-zA-Z]|--[a-zA-Z-]+))*\s*$/}`.
- The same list holds `cat head tail wc stat strings hexdump od nl id uname free df du locale groups nproc realpath readlink diff which type sleep pwd whoami ls cd find echo printf jq uniq` and others. A second table adds `sed sort file tree date lsof pgrep ps ss netstat fd fdfind sha*sum md5sum`, plus `xargs` everywhere except Windows.
- `env` and `printenv` are not in the list, and an argument with `$` is never auto-allowed.

**Folder checks:** a second map (`cM`) checks the paths of `cat head tail grep find ls cd diff strings od hexdump base64 sed awk jq sort uniq wc stat file` and others. A path outside the working folders then asks, which is refused under `-p`. Our Read deny rules apply to these commands too.

**Gaps (not path-checked):**
- `tree`, `fd`, `fdfind` and `du` list file names outside the folder.
- `ps`, `pgrep` and `lsof` show the command lines of other processes.
- On Linux, `fd . ~ | xargs head` may read files outside, because the `head` paths come from stdin. This is unverified.

**Recommendation:** add `Bash(xargs *)` to the deny list, in allowlist mode only. Accept the leak of file names and process lists, and record it as a known limit. In Any mode everything is allowed anyway (B27).

### Fact texts

- **SU2:** CONFIRMED. B22: allow and deny rules from --settings apply under --restricted. The CLI refuses a command with no allow rule, git status, and curl. It also refuses a redirect to a file outside the working folder.
- **SU4:** CONFIRMED. B24: all four compound forms are refused, and no part of them runs. `<allowed> && hostname` runs, because hostname is on the built-in list of read-only commands. That list needs no allow rule.
- **SU5:** REFUTED. B25: killTree ends the CLI in 299 ms. A `sleep 600` started by Bash stays alive more than 5 s. Git Bash starts a command by fork and exec, so taskkill /T cannot find the command. On Linux, the CLI starts each Bash command in a new process group.
- **SU9:** REFUTED IN PART. B27 and B27b: with allow Bash or allow `Bash(*)`, deny rules still refuse git status and curl. A redirect to a file outside the working folder runs and writes the file.
- **V19:** In allowlist mode, the CLI refuses a `>` redirect to a file outside the working folders (B22). With allow Bash or allow `Bash(*)`, the redirect runs (B27, B27b).

### Unverified

- Whether claude.exe starts its children with breakaway from the job. If it does, they escape the job. A B25 rerun shows this.
- Whether the environment scrub keeps a custom marker variable. Add it to B26.
- Whether `bun:ffi` works in the compiled binary. `tests/build/compiled.test.ts` would show this.

### Questions for you

1. Use `bun:ffi` (marked experimental) for the Job Object? Recommended: yes, with taskkill as the fallback. The other option, a PowerShell `Add-Type` helper, is slower.
2. Kill leftovers after every run, not only on Stop? Recommended: yes.
3. Deny `xargs` in allowlist mode and accept the leak of file names and process lists? Recommended: yes, and document the limit in shell.md.
4. Apply the same kill to checks.ts? Recommended: yes, in the same package.

I did not run anything on Linux, run the real CLI, or test the race between spawn and job assignment. I did not trace the `_ar` and `nkn` parts of the safe-command list (likely git and docker read-only subcommands).

CodeGraph: used 0 times. I used direct reads, because the target was the CLI bundle and two small known functions.

### User answers to the run 2 questions (2026-11-03)

- Q1 yes: a Windows Job Object through bun:ffi, with taskkill as the fallback.
- Q2 yes: kill the leftovers after every run, not only on Stop.
- Q3 changed: deny `Bash(xargs *)` in allowlist mode only while no allowlist entry of the repository names xargs. A task that needs xargs gets an entry from the plan or an allow request. Scripts that call xargs inside (for example a test command) are not affected, because the rules check only the command that Claude types.
- Q4 yes: checks.ts uses the same kill.
