# User skills that build on a remote machine

Status: analysis of 2026-11-09 against main 5c9c851. Proposed fix items 1 to 3 are built (2026-11-10). Item 4 is a later design. Gate B34 (integration-check.md SU21) is planned and checks the two open facts below.

## Problem

A task adds tests in a macOS-only block. The Windows test commands never run them. The user has a user-level skill that builds and tests on a remote Mac host over ssh. The user expects Claude to use it in the tests, implement, and fix steps.

## Facts

- All task step modes run through `implementArgs` (`src/server/review/claude.ts:494-526`). `--tools` is Read, Grep, Glob, Edit, Write (`claude.ts:89`), plus Bash for a shell step. No Skill tool. `--restricted` is set.
- Skills reach a step as files. `copyTaskSkills` (`src/server/review/skills.ts:360`) copies every user skill to `context/skills` (`jobs.ts:1463`). `skillLines(..., task=true)` (`catalog.ts:1091`) tells Claude to read the index. Key files are left out by `SECRET_NAME` (`skills.ts:39`).
- HOME stays real in a step (`src/server/tasks/shell.ts:216`). `childEnv` keeps `CLAUDE_CONFIG_DIR` (`claude.ts:120-131`).
- The skill lines always say "Skill scripts cannot run" (`catalog.ts:1120`). This is false in a shell step.
- The shell lines say "Wrap each remote command in `timeout <seconds>`" (`implement.ts:409`). A Mac host has no `timeout` by default.
- A typical remote recipe copies the tree with `git archive | ssh host 'tar -xf -'`. Local git is denied in every mode (`GIT_DENY`, `shell.ts:42`), so this recipe fails. `tar -cf - -C repo . | ssh host 'tar -xf - -C <dir>'` works without git.
- ssh: Allowlist and Most commands need a saved ssh pattern. Unrestricted allows it. scp and rsync: only Allowlist with a pattern, or Unrestricted. tar: allowed in Most commands and Unrestricted (`src/shared/task.ts:414-415`, `shell.ts:142-176`).
- The app judges only the Run: checks on the local machine (`implement.ts:411-417`, `checks.ts:444`). A remote test result is Claude's own claim.
- A Run: check over ssh is not practical now. `checkRules` needs every argument to be a plain word (`shell.ts:198`). "Isolate home" replaces HOME, so ssh loses the key (`checks.ts:451`).

## Open facts (real CLI)

- SU6 (integration-check.md:460): answered on 2026-11-09 by B28 with claude 2.1.319. Claude Bash ran `ssh <alias>` with the real HOME and got the marker in about 12 s. The user's ssh config accepts unknown host keys. rsync is not installed in Git for Windows, so a skill must not use rsync.
- Does `GIT_DENY` match `git` inside a quoted ssh argument (`ssh host 'cd x && git init'`)? Gate B34 (SU21) checks it.
- Does the step worktree have LF line endings? Code: the cache `info/attributes` sets `* -text` (`workspace.ts:21`), and the worktree sets `core.autocrlf false` (`worktree.ts:290`). So checkout writes each blob unchanged. A blob with LF stays LF, also under a `.gitattributes` that asks for CRLF. The B34 dry run with git on PATH confirms it. A blob with CRLF stays CRLF.

## Proposed fix

1. Skill lines: in a shell step, say that skill scripts and recipes may run under the shell rules of the step. Keep "cannot run" for steps without Bash.
2. Shell lines: a remote command follows the time-limit method of its skill when the skill names one. Else wrap it in `timeout`.
3. Prompt line: local git is denied. Copy a tree with `tar`, not `git archive`.
4. Later (design): a Run: check that calls one plain-word remote script, with "Isolate home" off, so remote results count.
