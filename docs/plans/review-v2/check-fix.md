# A failing check and the Fix step

Status: analysis of 2026-11-04 by the investigator against main 42b254c. Items 1 to 3 are code complete (user decisions of 2026-11-04 and 2026-11-05; spec.md sections 6.6, 6.7, and 6.21.1, AC-B104.10 to AC-B104.16). Item 4 ("Skip this check for this part") is not built. Gate B30 (integration-check.md SU14 to SU17) ran on 2026-11-06.

User report: a check command fails, and Claude tries to fix it in the Fix step. Claude cannot ask for commands there.

## Analysis

The user's experience has two root causes. Both are in how the Fix step is set up.

1. **No Bash in the usual case.** In allowlist mode with no saved patterns, `shellOf` returns null (src/server/tasks/loop.ts:718). The Fix step then has no Bash tool at all. Its prompt says "You cannot run commands" (src/server/tasks/implement.ts:401). Claude cannot rerun the check and cannot file an allow request. It can only set a free-text `question`.
2. **No way out except editing code.** `greenOrFix` (loop.ts:893-906) runs up to `TEST_FIX_TRIES = 3` fix steps (loop.ts:161). It ignores `done=false` and ignores a try that changes nothing. Nothing compares against a red baseline. The Fix prompt only says "Fix the cause" (implement.ts:359), so Claude edits code even when the command, a tool, or the environment is broken.

### 1. From a failed check to the Fix step
- **Check run:** `checks` → `checkStep` → `runChecks` reads the commands fresh from the repo settings each time (checks.ts:411, 425). The output is cut to the last 64 KB (`OUTPUT_TAIL`, src/shared/task.ts:150).
- **Fix loop:** `greenOrFix` passes `checkFailure(k)` as context/failure.md (loop.ts:903). After 3 tries it blocks with kind `red`: "the tests of part N stay red after 3 tries" (loop.ts:897-902).
- **Fix prompt input:** failure.md holds only the commands with a non-zero exit. For each it gives the name, the exit code (or "no exit code"), the time, the full argv, and the end of the output. All tails together stay within 32 KB (`FAILURE_TAIL`; loop.ts:247-263, task.ts:151). It holds only the latest run, not earlier tries.
- **Tools:** `SHELL_STEPS` includes `fix` (loop.ts:397).
  - Allowlist mode: the rules are only the saved patterns plus "Allow once" picks of the last run (loop.ts:717). The check command is never added. `checkPatterns` (src/server/tasks/shell.ts:157) has no callers.
  - Any mode: Bash is fully on (shell.ts:130).
- **Turn cap:** `STEP_TURNS.fix = 40` (task.ts:139). Time limit: 20 minutes per step (`STEP_TIME_MS`).

### 2. Can Claude rerun the check?
- **No Bash (empty allowlist):** no. The prompt says to "set question and name the setup command or allowlist entry" (implement.ts:419-423). That gives a question block, not an allow request.
- **Bash on, check command not allowed:** the prompt says to end the step with `allowRequest` (implement.ts:381-392). `askAllow` → `allowAsks` (loop.ts:725, shell.ts:76) drops a request in these cases:
  - The deny list refused the command (shell.ts:100). The deny list covers git, `powershell*`/`pwsh*`, network tools no entry names, and the Bitbucket and Jira hosts (shell.ts:131-139). Each drop goes into the step notes.
  - The pattern fails `allowProblem`.
  - The user refused the pattern before for this task (shell.ts:101).

  When the runner killed the step and no request is left, the task stops as failed (loop.ts:737-743).
- **Any mode:** allow requests are ignored (shell.ts:85-86).
- **Prompt text works against it:** "The app runs the build and the tests after your step. The next step gives you the output." (implement.ts:402). Nothing says "reproduce the failure first".

### 3. Can Claude say "this is not a code problem"?
- No result field or blocked kind exists for it. `implementResult` has `question`, `allowRequest`, `specChange`, `needsBase`, `notes` and `done` (task.ts:693-718).
- The general line "When you need a decision from the user, set question and stop" (implement.ts:419) is the only exit. It shows as kind `question` (loop.ts:777-792). The Fix lines never point at it.
- A try with no change and `done=false`: `claude()` returns, the checks run again, and the try counts. Three wasted tries end in `red`.

### 4. Baseline
None for Fix. Only the tests step runs `expectRed` and blocks when its tests already pass: "Tests pass before the change" (loop.ts:948-949). The "checks" item (loop.ts:1328) and the scoped task check never run on the base commit. failure.md even says "after your step" on every run. A lint or build failure that was already there looks the same as a new one.

### 5. What the user sees and can do
- Each check is a Log row with argv, exit, time and the output tail (checks.ts:447-467).
- At the end the status reads "Needs you: the tests of part N stay red after 3 tries." The actions are **See why**, **Resume** and **Stop** (src/web/tasks/model.ts:499-503). After an update they are "Undo the update" and Stop.
- The user can edit the commands in Settings > Tasks. The next run reads them fresh (checks.ts:411).
- There is no "skip this check" and no "accept this failure".
- Resume calls `greenOrFix` again, so the try counter starts at 0 and Claude gets 3 more tries (a local `tries`). I did not trace whether Resume first runs the implement step again.

### Proposed fix (ranked, smallest first)
1. **Let Fix name a non-code failure.** Add a Fix-mode prompt line: when the output shows a broken command, a missing tool, or a network or environment fault, change no file and set `question` with the reason. In `greenOrFix`, block with kind `question` at once when a fix try has no question and no change (`!r.fresh.length`). Do not count another try. Spec: 6.7 (Fix mode lines) and section 0 (TEST_FIX_TRIES). Tests: tests/tasks/loop.test.ts with a fake-CLI Fix that returns no edits gives one Fix run and a question block; a prompt snapshot test. Effort: `implementer`.
2. **Build 6.21.10 ("Claude may run the approved checks").** This is the fix for "Claude cannot ask for commands", so it is part of the fix. Add the per-repository setting, then add `checkPatterns(commands)` to the rules in `shellOf` when it is on. Bash is then on in allowlist mode even with no saved entries, and Claude can reproduce the failure. A command that is not plain words, or that the deny list blocks (powershell, git, ssh with no entry), still gets no pattern. Show it in Log notes or Settings. Spec: 6.21.1 D1, remove 6.21.10, new AC-B104.x. Tests: tests/tasks/shell.test.ts (`checkPatterns`), loop.test.ts (Fix shell rules hold the check pattern), tasks.test.ts (the setting with the shell warning). Effort: `implementer-xhigh` (settings, migration, UI, warning gate).
3. **Baseline for the part checks.** Run `CHECK_KINDS` once on the part base before the first part step and store which commands were red. failure.md then marks each failing command "also red before this task" or "new". Fix stops with a question for a pre-existing failure. Spec: 6.4/6.7 plus a new AC. Tests: loop.test.ts with a fake check that is red on base. Effort: `implementer-xhigh`.
4. **"Skip this check for this part"** next to See why on a `red` block, with a Log note. Spec: 6.7. Effort: `implementer`. Do this only if the user wants it after 1 to 3.

Also fix the misleading prompt line at implement.ts:402 when Bash is on (part of item 2).

Gate B30b (SU15, CLI 2.1.318, 2026-11-06): Claude Code's `Bash(<argv> *)` pattern from `checkPatterns` also matches the bare argv with no extra arguments. The exact rule `Bash(<argv>)` is not necessary. It stays, because it is harmless.
