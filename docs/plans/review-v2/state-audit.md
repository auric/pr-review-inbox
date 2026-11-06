# Task state machine audit (2026-11-06)

Status: audit by the investigator against main bb7de56. Not built. User report: Reject of a plan change does nothing.

## Part A: Reject of a plan change

**Root cause.** Reject does run. The server cancels the proposal, clears the reason and starts the step again (fake-CLI test passes). But the second run gets exactly the same input as the first, apart from `Attempt: 2`. Nothing tells Claude that the user rejected its change. The prompt tells Claude to change the plan when it thinks the plan is wrong. So Claude proposes the same change again, and the same "Change to the plan" box comes back. To the user, Reject looks like it did nothing. The box comes back after a full Claude run, so it can look like the button failed.

**How it happens, step by step**
1. The block: `loop.ts:827-831` adds a `spec_change` row with the paths and Claude's reason, then calls `block()`. The text is "Needs you: Claude proposes a change to the spec.".
2. The UI: `model.ts:535-536` shows "Review the change" as the main button, with "Reject" and Stop under More. `TaskView.tsx:822-847` shows "Accept the change" and "Reject". Reject goes through `TaskView.tsx:345-346` and `data.ts:249-252` to `POST /tasks/:id/spec-change/:step` (`routes.ts:311-322`, which waits for `settle()` first). Errors are not lost: `send` (`TaskView.tsx:186-191`) writes them to an alert line (`TaskView.tsx:524-527`).
3. The server: `loop.ts:2459-2474`. It ends the row `cancelled` with the note "The user rejected the change.", clears the reason, and calls `kick(db, id, true)`. `drive` then resets the worktree (`resetPart`) and `runPart` → `taskStep` runs `claude(c, "implement", task.id, …)` again (`loop.ts:1052`).
4. The gap: `runStep` builds the input at `loop.ts:723-729`. It holds the answers, `stepMd` and the plan files, plus `failure` when one is given. No failure is given here. `stepFile` (`plan.ts:871-883`) only changes the `Attempt` line. The only record of the rejection is the note on the `spec_change` row (`loop.ts:2469`), and no code reads that note again (grep for "rejected" finds only that line).
5. The trigger: `implement.ts:354` and `:371` say: "When the plan is wrong, change the plan file …, stop, and say why in specChange." The plan has not changed, so Claude's view of it has not either.
6. No limit: nothing stops a proposal that comes back again and again.

The machine itself is fine. `spec_change` lives only in `blocked_json`, the task stays `implementing`, and the part stays `implementing`. There is no 409, version or stale-query problem in this path.

**A second bug, same symptom: plan changes from a Tell Claude send**
- A send on a built part (task `ready`): `block()` stops `driveInstruct`. `endInstruct` gets a `Halt`, finds the row already closed, and `failed(Halt)` does nothing. So the send keeps `result: null`.
- Reject (`loop.ts:2461-2472`) then undoes the files and calls `kick(reset)`. `drive` does nothing in state `ready`: `ensureParts` and `buildParts` both return at once. The send does not run again. Its text does not go back to the box (`stoppedSend` needs `stopped`/`failed`). The earlier reason (`info.blockedBefore`) is lost. The box just closes.
- Accept in the same case commits the plan, then `kick` does nothing too. The doc comment "the step starts again under the new plan" (`loop.ts:2444`) is false for sends.
- A send on a part that is still building: Reject resumes the build as if Resume were clicked. The send text and `blockedBefore` are lost.

**Fix (smallest correct change)**
1. In `loop.ts runStep`, add one app-owned file to `own` while the newest `spec_change` row for (part, mode/item) is `cancelled`. Name it `rejected.md`. It says: "The user rejected your change to `<paths>`. Your reason was: `<note>`. Do not change files under `<specDir>`. Do the task under the current plan. If you cannot, ask in `question`." It needs one new query in `Q`.
2. In `specChange`, when the row's item is a send (`I<n>`), do what `answer()`/`allow()` do at `loop.ts:2327-2335`. Insert a new `instruct` row with the same detail, then `start(…driveInstruct…, "instruct")`. Do this for both Accept and Reject, not `kick`. Fix 1 then also covers sends.
3. Optional: to show the user that something happened, give the rerun row a step note such as "Runs again without the plan change."

**Tests (fake CLI)**
- In `tests/tasks/loop.test.ts`, extend AC-B20 (`:977`). Assert that the second implement call in `runCalls()` contains `specs/K-1/plan.md` and "rejected" in its stdin. That stdin carries the step file (`modeOf` reads `- Mode:` from it). Unverified: that every `own` file is inlined in stdin.
- A send on a built part writes a plan file. Reject must start a new `instruct` row and the second call must carry the rejection. Today the test fails: the task sits at `ready` with no new row.
- Accept on the same setup must start the send again under the committed plan.

**Effort:** small, about 40 lines in `loop.ts`, 3 tests and half a day. **Coordination:** `implement.ts` prompt lines and `loop.ts` neighbors are near the shell-modes work in the other worktree. Changing only `loop.ts` avoids a conflict.

## Part B: every task action

**These rows are OK.** Each clears the reason and starts a driver, or needs none:
- Build reasons: Answer, Use recommended, Allow Continue, Keep one PR, Change the limit, Continue with 60 more minutes, Pick a base branch, Resume / Try again, Run setup again (fixed in 1a5536e).
- Built parts: Update, Undo the update (built parts only), Fix the small points too.
- Part rows: Start now, Wait for the merge, Drop.
- Plan tab: Approve (`loop.build`), Edit, Change size, Repo Add/Skip, Ask again.
- Other: Open the PR (prs.ts), Close, See why, Show diff.
- Every 409 and 400 shows in the `role="alert"` line. A 409 also refreshes the task query.
- Every handler that clears `blocked_json` then calls `kick`/`start`, or leaves a built part where no driver is needed. Two exceptions are in the table: `specChange` on a send, and `undoUpdate`.

| Action | Path | Problem | Mark |
|---|---|---|---|
| Reject (build step) | `reject-change` → spec-change route → `specChange` → `kick(reset)` | Reruns with the same input, and Claude repeats the change (Part A) | BROKEN |
| Reject / Accept (send on a built part) | same route → `kick` | No driver runs in `ready`. The send is lost and `blockedBefore` is lost | BROKEN |
| Reject (send on a building part) | same | Resumes the build like Resume. The send text and the earlier reason are lost | RISKY |
| Reason of another part while one reason holds | `claude()` `loop.ts:826`, `holdBlocked` `tasks.ts:982` | The second part's question or plan change ends with no row and its work is reset. Its Claude run is wasted | RISKY |
| Pause after this step | `pause` `loop.ts:2200` | It is shown when `t.working`, also while the driver only runs the base check (`ending`). The server accepts because `drivers.has(id)`, but no `gate()` follows. `pauseAsked` stays set and pauses the next driver (for example Fix points) by surprise | RISKY |
| Continue after a pause, after a restart | `resume` `loop.ts:2249` | `gates` is empty, so `paused` is false and the generic path runs `kick(reset=true)`. That discards the kept changes of the done step, against the "every change kept" promise | RISKY |
| Ready-state reasons from a send: red, blocker, denied_path, question with no open question | `model.ts:498-500` drops resume/continue in `ready` | Only See why and Stop are left, and Tell Claude for the box reasons. A `question` with no open question has no way back except Stop, then Resume | RISKY |
| Any action while another part still builds | routes `settle()` waits only while `ending` | `BUSY` 409 ("The build still ends its step…"). It is visible, but a sub-task build can show it for minutes | RISKY (UX) |

## Ranked fixes
1. Put the rejection into the rerun context (`runStep`), with an AC-B20 test. This fixes the reported bug.
2. On a send, Accept and Reject start `driveInstruct` again, the same way as `answer`/`allow`. 2 tests.
3. Clear or refuse `pauseAsked` when no build step will reach a gate. Refuse Pause while `ending.has(id)`, and clear `pauseAsked` at driver end.
4. Restart after a pause: resume without a reset when the reason is `PAUSED`.
5. Give `ready`-state reasons a way back: "Dismiss", or restore the earlier reason.
6. Record the reason of a held part instead of dropping its result. This needs a design call: queued reasons.

I did not test the send-path bugs, the Pause leftover, or the restart-after-pause path. They come from reading the code only. I also did not check that `own` files reach the fake CLI's stdin. Fix 1 changes the prompt input, so the eval baseline could move a little.
