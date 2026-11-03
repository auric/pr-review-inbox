# Keep the work of a step that reaches its turn cap: analysis and design draft

Status: draft of 2026-11-03, written by the investigator against main 49784fa. The user asked on 2026-11-03 that a step at its turn cap must not lose its work. The questions at the end wait for the user. Related: pushback.md (fix steps get 60 turns).

Short answer: today, yes. When a step hits its turn cap, the files Claude changed stay on disk until the user clicks Resume. Resume then puts the part back to its last commit, saves the changes as a patch file, and runs the step again from the start. The patch is the only thing kept, and no step reads it back. A fix step that hits its cap also loses the implement step's changes, because the app commits only after the checks pass (loop.ts:878 to 885).

## What happens today

How a cap is detected:
- STEP_TURNS is 80 for implement, 40 for fix and 60 for tests (shared/task.ts:132).
- A capped run fails with kind `max_turns` (stream.ts:275).
- The step ends `failed`, and `stopForRun` stops the task with "Needs you" (implement.ts:826 and 854 to 855, tasks.ts:509).
- The changes are only undone during the step when the path check finds a problem (implement.ts:815).

Resume (loop.ts:2051 to 2052) calls `kick(..., true)`, which leads to `resetPart` and then `undo`. `undo` saves the patch and resets the worktree (loop.ts:828 to 841, 1284, 1328). The spec says the same (spec.md:1334).

No session can be resumed. Every task run passes `--no-session-persistence` (claude.ts:353), so there is no transcript. The `session_id` column exists but nothing can use it.

| Case | File edits | Session | What the user sees and can do | Next try starts from |
|---|---|---|---|---|
| Turn cap | Kept until Resume, then saved as a patch and reset | None | Task stopped, error reason. Resume. | Last commit |
| Bad JSON (`schema`) | Same | None | Same | Last commit |
| More than 5 refused commands (`REFUSED_MAX`) | Same. The process is killed (claude.ts:454). | None | Same | Last commit |
| Timeout (`process`) | Same | None | Same | Last commit |
| User Stop | Same. Step ends `cancelled`. | None | Resume | Last commit |
| App restart | Reset when the driver starts again (loop.ts:7, 1328) | None | Resume | Last commit |
| Path check fails | Undone at once, patch saved (implement.ts:280 to 290) | None | Denied-path reason | Last commit |

The patch file name shows in the step log (LogTab.tsx:239, TaskView.tsx:885). The user has to apply it by hand.

## What we can reuse

- **Review finder salvage** (jobs.ts:1104 to 1174, catalog.ts:1223, context-files.ts:126): the stream already collects Claude's notes, and `salvageNotesFile` writes them into a context file. We can reuse that for a task step.
- **`resumeArgs`** (claude.ts:288): it forks a session with read-only tools and needs a saved transcript. It does not fit implement steps.
- There is no "continue" step today.

## Recommendation: one automatic continuation step with the kept edits

When an implement, fix or tests step ends with `max_turns` and the path check passed, do not stop the task. Keep the worktree as it is and start one more step of the same mode and item, attempt + 1. Its `context/continue.md` holds:
- the `git diff` since the last commit, marked untrusted;
- Claude's notes from the capped run (`salvageNotesFile`);
- the line "Finish the step. These changes are yours."

It gets the normal STEP_TURNS. If it also hits the cap, the task stops as it does today, and Resume saves the patch and resets.

Token limits:
- At most one continuation per step (new constant `CONTINUE_MAX = 1`), so one step costs at most 2 × STEP_TURNS.
- `startStep` still checks the part time and cost budget (`partBudget`, implement.ts:733).

Why this option:
- `--resume` would need saved transcripts, which the app turns off on purpose (gate B4/B16). It would also reload the full context, which costs more.
- A separate handoff run costs extra turns, and the notes are already in the stream.
- The diff and notes carry the work forward.

Risks and how they are handled:
- **Half-done edits:** the app commits only after green checks (`greenOrFix`, then `commit`), so broken code is never committed.
- **Path check:** it runs after every step, including the capped one, so the kept edits have already passed it.
- **One trap:** `claude()` compares changes against the files that were dirty before the step (loop.ts:629, 685). The kept edits would count as "before" for the continuation. A tests step would then fail with "The step wrote no test" (loop.ts:858 to 862), and a spec change could be missed. The continuation must use the "before" set of the first attempt.

Files to change:
- `src/shared/task.ts`: add `CONTINUE_MAX`.
- `src/server/tasks/implement.ts` (`startStep` finish): skip `stopForRun` for `max_turns` while a continuation is allowed. Add `kind` and the notes to `StepOutcome`.
- `src/server/tasks/loop.ts` (`runStep` and `claude`): start the continuation and keep the first "before" set.
- `src/server/review/context-files.ts`: add a `continue.md` builder.
- Prompt text in the implement prompt.
- Step note in the UI: "Reached its turn cap. Continued with the kept changes."
- spec.md 6.7 and smoke-task.md.

Test: in `tests/tasks/loop.test.ts`, a fake CLI first returns `error_max_turns` after writing a file, then returns success. Check that:
- the file survives;
- `continue.md` holds the diff;
- the commit lands;
- a second cap stops the task;
- a tests-step continuation is not rejected as "no test".

## Questions for the user

1. **Should the continuation start by itself, or wait for a click?** I recommend by itself, because the token cap is hard and visible.
2. **Should schema, timeout and refusal failures also continue?** I recommend no. Those failures point to a broken run, not to unfinished work.
3. **After Stop or a restart, should Resume offer "Resume with the changes"?** I recommend yes, but as a later step. The path check would run again first.
4. **Should the continuation get the full turn cap or half?** I recommend the full cap, so it can finish the work.

Not checked: the app-restart recovery for runs that were in flight, and how the UI shows the patch line. The design is not built or tested yet.

CodeGraph: used 1 time
