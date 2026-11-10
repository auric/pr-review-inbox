# Git deny gap in task steps with Bash

Status: analysis of 2026-11-10 against main 2871ce8, after Gate B34 (integration-check.md SU21). Not built.

## Problem

In Unrestricted and Most commands, the deny list refuses `git --version`, but `bash -c 'git --version'` runs. The deny rules are advisory: "they reduce mistakes, they stop no attacker" (`src/server/tasks/shell.ts:5`). The standing rule "git stays fully denied for Claude" does not hold.

## Facts

- The cache has no remote (`workspace.ts:325`), and fetches skip `FETCH_HEAD` (`workspace.ts:256,524`). The token reaches only the app's own git, through env (`provider.ts:274`, `git.ts:40`).
- `shellEnv` sets `credential.helper=""`, no prompt, and a non-interactive credential manager (`shell.ts:221-226`). It does not set `GIT_CONFIG_NOSYSTEM` or `GIT_CONFIG_GLOBAL`, and HOME stays real (`shell.ts:216`). Proven with git 2.56: `git -c credential.helper=manager` adds the system helper back. So a command can probably get the user's stored login (unverified).
- The worktree shares the cache refs and config (`worktree.ts:281`). Claude can commit, reset, move branches, delete `refs/rl/*`, and write cache config.
- Proven: a `url.<other>.insteadOf` entry in the cache config rewrites the URL that the app passes. The app's push (`push.ts:91-101`) and fetches send an unscoped Bearer header (`provider.ts:275`). So planted config can send the token to another host. `http.proxy`, `http.sslVerify=false`, and `include.path` act the same way.
- The post-step check reads only `git status` and the git link (`implement.ts:147-150`). It never compares HEAD with `last` (`implement.ts:865,940-943`). A commit made by Claude leaves the status clean, so committed denied paths escape the check. `commitStep` finds nothing staged and returns null (`worktree.ts:567`). The next Push sends Claude's commits.
- Same gap, worst first: credential tools and `powershell` through `bash -c` (`shell.ts:45`); `Read(~/.ssh/**)` (`shell.ts:48`) does not stop Bash, and git over ssh uses the keys; network tools in Most commands (`shell.ts:170`); the host deny `*host*` (`shell.ts:160`), which a split string or an IP defeats; the data folder Read rules (`shell.ts:47`).

## Fixes

| Fix | Holds against |
|---|---|
| A. Deny `bash *`, `sh *`, `env *`, `eval *`, `* -c *` | Mistakes only. It can break skill recipes. Skip. |
| B. `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=<empty file>` in `shellEnv` | Mistakes only. |
| C. A `git` stub first on PATH | Mistakes only. |
| D. A remote with an invalid pushurl | Nothing: the cache has no remote. Skip. |
| E. Scope the header to the origin (`http.<origin>/.extraHeader`). Before each git command that carries the token, read the cache config and refuse any key that is not on an allowlist. | Injection, for token theft. |
| F. Before each step, save HEAD, all refs, and the cache and worktree config files. After the step, compare them with file reads before any git runs. On a change, restore, reset to `last`, and block with "Needs you". | Injection, for planted commits and config. |
| G. An OS sandbox or a separate user account | The only fix against theft of the user's login and ssh keys. |

## Proof

- bun tests prove E and F without the CLI: plant `insteadOf` in a temp cache and push to a fake server, which must get no Authorization header. A planted commit must block the step.
- A real-CLI gate must prove B, whether `--restricted` refuses `-c credential.helper`, and whether the CLI sandbox exists on Windows.
- Not proven: what the credential manager holds; that Bash `cat` honors Read deny rules; that a planted `core.fsmonitor` or filter runs when the app runs `git status`.
