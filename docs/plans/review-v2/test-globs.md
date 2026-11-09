# Test files in a tests step

Status: analysis of 2026-11-09 against main ce60355. User decision: fix with the highest priority. Not built.

## Problem

A real run stopped with "Needs you: the tests step of part 2 failed twice. The step changed files that are not tests: src/unittest/unittest/foo_tests.cpp." The file is a real test file. The guard discarded the edits twice.

## Facts

- `src/server/tasks/loop.ts:1046-1049` decides what a test file is. When the repo has `testGlobs`, a path is a test if it matches one glob (gitignore rules, `globMatch`, `loop.ts:190`). When `testGlobs` is null, a path is a test only if it equals a plan test line (`tests[].test`) or a task `Run:` entry (`same`, `loop.ts:238`).
- `testGlobs` is null by default (`src/server/tasks/tasks.ts:420`). No control in `src/web` sets it. `src/web/settings/TaskCommands.tsx:147-164` only passes the stored value through.
- Plan test lines are free text (`plan.ts:687`). Claude writes test names there, rarely paths. So with null globs almost every real test file is refused.
- After the failure the task stays in `implementing` with block reason `red` (`loop.ts:1063`). The UI shows "See why", "Resume", and "Stop" (`src/web/tasks/model.ts:510-519`), and the Tell Claude box (`model.ts:265`). "Resume" reruns the tests step (`loop.ts:1451-1452`) and fails the same way. No button skips the tests step or edits the plan.
- Tell Claude has its own path check (`loop.ts:1738`). It is not verified that the tests step then counts as done.
- Round 1 edits go to `<dataDir>/tasks/<db>/<task>/patches/<step>.patch` (`worktree.ts:68`, `loop.ts:1064`). Round 2 edits stay uncommitted in the worktree, because `block` throws before `undo`. "Resume" or Tell Claude moves them to a patch (`loop.ts:1475`, `loop.ts:1748`).
- The app does not check "Done when". It only puts the line into `step.md` (`plan.ts:556`). The app enforces only the `Run:` checks.
- An app-run command is an argument list with no shell rule, so `ssh host …` runs. The remote machine does not see the local worktree edits; a wrapper script must copy them first (unverified). In "Most commands" mode Claude may run ssh only after the user saves an ssh pattern. scp and rsync stay denied (`src/shared/task.ts:390-393`, `src/server/tasks/shell.ts:138-143`).

## Fix

1. Add a default list of test globs. Use it when `testGlobs` is null, together with the plan paths:
   - folders: `test/`, `tests/`, `unittest/`, `unittests/`, `__tests__/`, `spec/`
   - names: `*_test.*`, `*_tests.*`, `test_*.*`, `*Test.java`, `*Tests.java`, `*.test.*`, `*.spec.*`
2. Add a "Test files" glob field to the Commands section (`TaskCommands.tsx`). The API and the database already have the setting.
3. Do not rely only on test files listed in the plan.
4. Tests: `tests/tasks/loop.test.ts:739` keeps `src/feature.ts` refused. Add a case where `src/unittest/unittest/foo_tests.cpp` passes with null globs. Add `globMatch` cases for each default pattern.
