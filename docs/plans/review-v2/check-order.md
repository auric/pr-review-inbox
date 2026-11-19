# Task check order

Status: analysis and fix plan of 2026-11-19. Not started. Fix 1 changes the "top to bottom" run rule of spec.md section 6.3, so it waits for the user's sign-off.

## 1. Problem

The baseline checks of a task ran tests before the build, so the test binaries were "Not found". The list also held near-duplicate commands, commands for another OS, and a literal placeholder.

Who sets the order: the app, through history. Each plan approval saves the ticked commands of the repository and replaces the saved list. The next plan screen shows the saved list again with every row ticked, and adds the new proposals. Claude's order holds only inside one plan's proposals.

- Claude proposes commands in testing.commands (src/shared/task.ts:942-959). toPlan makes new-N rows (src/server/tasks/plan.ts:178-187). Only the argv schema is checked.
- commandsOf (src/server/tasks/tasks.ts:950-958) lists saved commands first, then proposals (since 15a7f79). From e22c676 until 15a7f79 it listed proposals first. So a later task's tests landed ahead of an earlier task's saved build.
- Duplicates drop only on an exact argv match. Case and an extra flag count as different.
- The plan screen starts every row ticked (src/web/tasks/PlanTab.tsx:120-121, 179-187). The approval writes the ticked rows in screen order over repo_task_settings.commands_json (tasks.ts:2331-2425).
- runChecks (src/server/tasks/checks.ts) runs the rows in saved order, one at a time. A failed build does not stop the later rows. program() (checks.ts:47-61) marks a row "Not found" when argv[0] is not a file.
- The spec prompt names the host OS (catalog.ts:1124-1125). It has no build-before-test rule, no rule against placeholders or env VAR=value, and Claude never sees the saved commands.
- onBase (loop.ts:349-353) finds the base row by name. Two rows with the same name compare with the wrong base row.

## 2. Fix

0. No code: in Settings > Commands, remove the commands for another OS and the near-duplicates, and move the build above the tests.
1. Run build rows before test and lint rows. runChecks runs by kind order: build, then test, then lint, and keeps the list order inside each kind. commandsOf and the commands editor show the same order. This changes the run rule of spec.md section 6.3. It needs the user's sign-off.
2. A failed build skips the later checks. After a build row exits non-zero or is not found, each later test or lint row gets notRun "Skipped: build <name> failed" and does not run. A skipped row is red.
3. Unique names. The approval and the settings save refuse two commands with the same name. onBase also matches by command ID.
4. Prompt (catalog.ts:1128): "Give build commands before the tests that need their output. Never use a placeholder such as <dir>. Never use env VAR=value, because no shell runs." A context/commands.md lists the saved commands, and the prompt asks for missing commands only. This changes the spec prompt, not the review prompt.
5. Not recommended: regex flags for Linux-only forms. At most, a warning for an argv that holds <...>.

| Event | Today | After |
|---|---|---|
| Build exits 0 | Tests run | Same |
| Build fails or is not found | Tests run, a missing binary shows "Not found" | Tests are skipped, and each row names the build |
| The app stops a command | The run ends | Same |
| Green | Every row exits 0 | Same; a skipped row is red |

## 3. Tests

- tests/tasks/checks.test.ts: a stored [test, build] list runs the build first; a build that exits 1 gives later rows "Skipped" and the run is not green; the skipped row's base comparison works.
- The approval route and the settings save: two commands with the same name give 400.
- A catalog test for the new prompt lines.
