# Several Claude runs at once (limits.md decision 1)

Status: design of 2026-11-11 against main a4fc1d7. WP-PR0 (docs), WP-PR1 (the per-cache lock for worktree add and prune), WP-PR2 (the slot pool), and WP-PR3 (web, AC-B219 to AC-B222) are built. Gate G-PAR is open (docs/smoke-r3.md part O). It implements limits.md "User decisions (2026-11-04)", decision 1. The user answered Q1 to Q5 with the recommendations (section 6).

## Summary

- A pool of N run slots replaces the one run slot. N is a new run limit, "Runs at once", in Settings, Tasks, Run limits. Default 3, range 1 to 10.
- Each pull request (PR) has at most one run at a time. A start on a PR with a running run gets 409, even when slots are free.
- A user start never waits. When every slot is in use, the start gets 409, as a busy slot does today. BRIEF.md:500 "There is no queued state" stays.
- A step of a task that builds one part at a time takes one pool slot, as today. It waits for a free slot (design.md B12).
- Steps of a task with "Parts that build at once" 2 or more stay outside the pool. They keep their own runners (spec 6.20.6). Open question Q1.
- Each run gets its own runner, because one runner runs only one CLI process.
- `worktree add` and `worktree prune` of run folders move under the per-cache lock. Spec 6.20.6 already asks for this; the code does not do it yet.
- Restart recovery needs no change.

## Plan (run order)

1. WP-PR0, docs: BRIEF, spec section 6.26 with AC-B187 to AC-B197, the AC-B18 and 6.20.6 edits, a note on design.md B12.
2. WP-PR1, server: the per-cache lock for worktree add and prune (workspace.ts).
3. WP-PR2, server: the slot pool, the new setting, the conflict shape, the slots route, the text of a waiting task step.
4. WP-PR3, web: the busy notes, the slots query, the texts, README, CHANGELOG, screenshots.
5. Gate G-PAR: the user runs it with the real CLI.

## 1. Facts: every place that assumes one run at a time

Line numbers are from main a4fc1d7.

| Area | Where | Today | Change |
|---|---|---|---|
| Slot state | jobs.ts:426 `let job`; :429 `extras`; :430 `runnerOf` | One pool job. Runs of parallel parts sit in `extras`. | `active: Set<Job \| TaskJob>`. `extras` stays. |
| Runner | jobs.ts:421; claude.ts:552, 586-589 throws "A review run is active." | One shared runner, called at jobs.ts:970, 1185, 1308, 1426 and through `runnerOf` at 1255, 1502, 1621. | Each job gets its own runner, as `extras` already do (jobs.ts:2456). The shared runner keeps only `check()`. |
| Take a slot | jobs.ts:1842-1852 `begin`; 2435-2458 `taskRun` | Sets `job`. | Adds the job to `active`. |
| Free a slot | jobs.ts:1354, 1761, and the `finally` blocks at 1844-1849 and 2459-2464 | `job = null`, then `wake()`. | Deletes the job from `active`, then `wake()`. |
| Busy check | jobs.ts:1833-1839 `taken`; called at 1872, 2190, 2246, 2333; 2436 in `taskRun` | Same key gives 200. Any other run gives 409. | Same key, then same PR, then the limit (3.2). |
| 409 texts | jobs.ts:1807-1815 `busyConflict` | "Another review is running." or "Claude is building <KEY>. Pause building after this step to start your run." | Section 3.5. |
| Conflict type | shared/dto.ts:1228 `RunConflict` | Names one running run. | Adds `full?: number`. |
| Wait for a slot | jobs.ts:1817-1829, 2104-2111 `onFree`; loop.ts:678-723 `waitSlot`; retries at loop.ts:820-823, 1259-1263; implement.ts:1055 | Waiters wake when the one slot frees. | Waiters wake when any pool slot frees. New text when the limit is 2 or more. |
| Parts beside the slot | jobs.ts:427-429, 2455-2457; loop.ts:612 `beside` | Own runner, no slot. | No change. |
| Cancel and Stop | jobs.ts:1780-1798, 2415-2418, 2422-2425, 1801-1804, 2085-2097 | Cancel finds only the slot job. | Cancel finds the job by its id. |
| Busy for task actions | jobs.ts:2428 `busy()`; tasks.ts:1744, 1997, 2280, 2317, 2434, 2500, 2528; `startNext` tasks.ts:1446-1457 | 409 while the one slot is busy. | `busy()` means "the pool is full". |
| Run phase | jobs.ts:1775-1778 `withPhase` | Reads `job` only. | Finds the job by id in `active` and `extras`. |
| `wait()` | jobs.ts:2114 | `job` and `extras`. | All of `active` and `extras`. |
| Recovery | jobs.ts:434-446; run-rows.ts:191-192; tasks.ts:252-260 | Works on sets of rows. | None. |
| Prune of run folders | jobs.ts:449-452; workspace.ts:718-726 | One memoized promise before the first workspace. | None. |
| SSE | jobs.ts:218, 460-487; web live.ts:14-38 | `changed` lists runs, combined over 500 ms. | None. The new query key starts with "runs". |
| Web busy state | ask/model.ts:38-40 `busyText`; discuss-model.ts:52-54; review/model.ts:389-394 `activeRun`, 516-531; useStart.tsx:51, 67-70, 132; AskPanel.tsx:119-141; Discuss.tsx:181-205; ExplainPage.tsx:139-141; Consult.tsx:632-635; FixBar.tsx:118, 125, 205; fix/model.ts:192; review/data.ts:118-131; TaskChips.tsx:123; shared/task-status.ts:17 | A running run on any PR blocks every start. | `slotBusy` and new texts (3.6). |
| Docs | BRIEF.md:241, 459, 490, 500, 594; design.md:173 (B12); spec.md:1556 (AC-B18), 2140; README.md:205-213; r2.md:9 | One run slot. | WP-PR0, WP-PR3. |
| Tests that rely on one slot | proposals.test.ts:106, subtasks.test.ts:108, subtasks-add.test.ts:113, tasks.test.ts:187, 1642 (use `busy()` as "the run ended"); loop.test.ts:972-977, tasks.test.ts:397, 1740 (AC-B18); web ask, discuss, fix, tasks-model tests; m2.e2e.ts:293, ask.e2e.ts:159 | — | WP-PR2, WP-PR3. |

Why one run per PR: two runs on one PR race on the forced refs `refs/rl/<id>/*` (r2.md:9; workspace.ts:260-263, 433-437). Both would also write drafts of that PR when they end.

## 2. Shared resources

| Resource | Verdict | Evidence |
|---|---|---|
| Cache init, fetch, update-ref | Safe. They run under `locked(cache)`. | workspace.ts:355, 436, 514, 569, 629 |
| `worktree add` and `worktree prune` of run folders | Needs the per-repo lock (WP-PR1). Prune from run A can race with add from run B (git writes the "initializing" lock file after it creates `worktrees/<id>`; unverified). | workspace.ts:447, 457, 639, 648, 660; spec.md:2139 |
| Part worktrees, sparse-checkout | Safe. Under the lock. | worktree.ts:265-285, 410 |
| Cache config writes on Windows | Safe enough; the risk exists today. A reader outside the lock can fail once while the first `sparse-checkout set` writes (unverified). | workspace.ts:313-322; worktree.ts:283-284 |
| Snapshot folders `runs/<id>` | Safe. One id per run. | workspace.ts:439, 631; jobs.ts:1801 |
| Prune of all run folders | Safe. Once per process. | jobs.ts:449-452 |
| Per-cache git watch (fix F) | Safe as designed. More runs open more windows (git-deny.md limits). A risk, not a block. | git.ts:181-307; gitstate.ts:52-159 |
| Mermaid and Explain | Safe. No files. | judge.ts:636 |
| SQLite | Safe. One connection, synchronous calls, WAL and busy_timeout. | db.ts:128-131 |
| Claude CLI folders and session files | Safe for the app files: one cwd folder per run, `--no-session-persistence`. Unverified: concurrent writes to the CLI global files (`~/.claude.json`, credential refresh). Gate G-PAR. | claude.ts:287-346, 444, 485, 539 |
| CodeGraph index | Safe. One copy per run, written back through a temp file and a rename. | codegraph.ts:114-155 |
| Doc MCP tool list cache | Safe. Worst case: a duplicate list call. | catalog.ts:412-422 |
| User MCP servers | Unverified. A stdio server may refuse a second instance. | user-mcp.ts |
| Rate and cost | No code change. N runs use the plan up to N times faster. The setting help says so. | review/model.ts `limitText` |
| Memory and CPU | Unverified. Gate G-PAR measures them. | — |

## 3. Design

### 3.1 Slot model

- `RUN_LIMITS.runsAtOnce = { def: 3, min: 1, max: 10 }` (shared/task.ts). The server reads it at each start, as `runTimeMs` does.
- Pool runs: every PR run (review, re-review, reply, ask, explain, discuss, fix, session) and every task run with `extra = false` (interview, spec, and the steps of a task with one part at a time).
- Outside the pool: the steps of a task with 2 or more parts at once, and Improve prompt.
- One run per PR. Task runs have pr NULL.

### 3.2 Start rule (jobs.ts)

The order is load-bearing: same key first (A14), then same PR, then the limit.

```ts
const limit = () => runLimitsOf(settings.config()?.runLimits).runsAtOnce;
const active = new Set<Job | TaskJob>(); // insertion order: the first one is the oldest
function taken(db: Database, key: string, pr: number): StartResult | null {
  for (const j of active) if (j.db === db && j.key === key) { const r = runRow(db, j.id); if (r) return { status: 200, run: toRunDto(r) }; }
  const mine = [...active].find((j) => j.db === db && j.pr === pr);
  if (mine) return { status: 409, conflict: busyConflict(mine) };
  return active.size >= limit() ? { status: 409, conflict: busyConflict(first(active), limit()) } : null;
}
```

- `taskRun(db, t, extra)`: with `extra` false and a full pool, 409 with `busyConflict(oldest, limit)`.
- `busy()` returns the full-pool conflict, or null. New `idle()` (tests): `active` and `extras` are empty. New `slots(db)`: the pool runs of that database, oldest first.
- Every start path stays synchronous from the check to `active.add` (invariant I1).

### 3.3 Task steps and the parts limit

- Parts at once 1: each step takes a pool slot and frees it between steps (B12).
- Parts at once 2 or more: steps run beside the pool (spec 6.20.6, README "a review never waits for a build").
- `startNext` still gets a slot. The slot frees in the same tick before `endTask` runs the effect.

### 3.4 Waiting order and fairness

- User starts never queue.
- A waiting task step registers with `onFree`. A freed slot wakes every waiter; a loser waits again.
- No order among waiting steps and no queue position. Waiters are few: at most one per task with one part at a time.
- A user start can take a free slot before a woken step (B12: a review click waits at most one step).

### 3.5 Texts

Server (the `error` of a 409):
- S1, the PR has a running run: "A run is working on this pull request. Start yours when it ends." No `full`.
- S2, full pool, oldest is a PR run: "Claude runs <N> runs at once, your limit. Start yours when one ends." Body `full: N`.
- S3, full pool, oldest is a task step: the AC-B18 sentence stays. Body `full: N`.

Waiting task step (loop.ts `waitSlot`): limit 1 keeps today's texts. Limit 2 or more: "Waiting for a free run slot. Claude runs <N> runs at once, your limit." Task row status: "Waiting for a free run slot".

Web:
- W1, the PR has a running run: "<runner> is <doing> <where>. One run per pull request."
- W2, full pool, note under a start control: "<runner> runs <N> runs at once, your limit. Running: <Kind> of <where>, <Kind> of <where>, and <k> more." At most 3 names.
- W3, toast for a full pool: "<runner> runs <N> runs at once, your limit."
- W4, refused Discuss start, full pool: "<W3> Ask again when one ends."
- W5, `fixReason`: "<busy> Propose fixes when a run ends."
- Setting: label "Runs at once", unit "runs", help "Reviews, Explain, Ask, Fix, and task steps share this number. Each pull request has one run at a time. Builds of 2 or more sub-tasks at once run beside it. More runs use your Claude usage faster."

### 3.6 UI

- New route `GET /api/runs/slots` gives `RunSlotsDto = { limit; running: (RunConflict["running"] & { taskKey?: string })[] }`, oldest first. Register it before `/runs/:id`.
- New hook `useRunSlots()` with key `["runs", "slots"]`; the existing `changed` invalidation covers it.
- `slotBusy(slots, prRuns, pr)` replaces `activeRun`. It keeps the stale-data guard.
- Users: useStart, AskPanel, Discuss, ExplainPage, Consult. The server still decides. No queue position.

### 3.7 Stop and cancel

- `POST /api/runs/:id/cancel` cancels only that run.
- Task Stop cancels every pool run and every beside run of that task.
- A connection change and app stop cancel every run. A new run limit never cancels a run.
- One helper `cancelWhere(pick)` replaces `cancelActive` and `cancelExtras`.

### 3.8 Per-cache git lock

- prepareWorkspace: `rm` stays outside the lock; `worktree prune` and `worktree add` run inside `locked(cache)`.
- taskSnapshot: the same for the main cache and each nested cache.
- `locked` is not reentrant. None of these call sites runs inside a `locked` block today.
- Cost: runs on one repository prepare one after another. Their Claude phases still run at the same time.

### 3.9 Not changed

`extras` and the parts limit, Improve prompt, apply/commit/undo, fix F, SSE, recovery.

## Invariants

- I1. Every start path is synchronous from the check to taking the slot (jobs.ts:1854-1902, 2326-2373, 2435-2458).
- I2. One runner runs one process (claude.ts:586-589). Beside runs use a runner per job (jobs.ts:2456).
- I3. Cache writes are serialized by `locked` (workspace.ts:291-302; spec.md:2139).
- I4. Fix F accepts concurrent app git calls (git.ts:270-307).
- I5. Run folders are unique per run id and pruned once (workspace.ts:439, 631; jobs.ts:449-452).
- I6. The CLI writes no session transcript; per-cwd folders go after each run.
- I7. Recovery is set-based (run-rows.ts:191-192; tasks.ts:252-260).
- I8. Only a connection change fires the settings listeners (settings.ts:364-370, 399).

## 4. Spec text (proposed section 6.26)

- Run pool: at most `runLimits.runsAtOnce` pool runs at the same time (default 3, 1 to 10). Every PR run and every task run of a task with one part at a time is a pool run. Steps of a task with 2 or more parts at once and Improve prompt run beside the pool.
- One run per pull request. A user start never waits; a full pool gives 409. Each run has its own CLI runner. `worktree add` and `worktree prune` of each run folder run under the per-cache lock.

Acceptance criteria:

1. AC-B187. Settings, Tasks, Run limits has "Runs at once" (default 3, 1 to 10). config.json keeps `runLimits.runsAtOnce` only when it changed. Out of bounds gets 400 "Type a whole number from 1 to 10."
2. AC-B188. With limit N, N runs on N PRs run at the same time, each as its own CLI process. A start on another PR gets 409 with `full: N`, the oldest pool run, and S2. After one run ends, the same start gets 202.
3. AC-B189. While a PR has a running run, a start with another key on that PR gets 409 with no `full` and S1, also with free slots. The same key gets 200 and the running run (A14).
4. AC-B190. Cancel of one run ends only that run. Task Stop ends every run of that task only. A connection change and app stop end every run.
5. AC-B191. A lower limit applies at the next start and cancels no run. A higher limit lets the next start go at once.
6. AC-B192. A step of a task with one part at a time takes a pool slot. While the pool is full, it waits with the 3.5 text (limit 1 keeps today's texts) and starts when a pool run ends. Steps of a task with 2 or more parts at once never wait for the pool.
7. AC-B193. `worktree add` and `worktree prune` of prepareWorkspace and taskSnapshot, nested caches included, wait while another call holds `locked(cache)`. Three runs on three PRs of one repository start at once and all end. After them, `git worktree list` shows no run folder.
8. AC-B194. On restart, every running run row becomes failed "The app stopped during the run.", whatever the number of rows.
9. AC-B195. `GET /api/runs/slots` gives `{ limit, running }`, oldest first. `GET /api/runs/:id` still works.
10. AC-B196. A start control shows W1 while its PR has a running run and W2 while the pool is full, and is disabled in both cases. A 409 shows W1 or W3. Brief, re-review, reply drafts, Fix, Ask, Discuss, Explain, and Consult follow this rule.
11. AC-B197. With limit 1, AC-B18 and every single-slot test pass unchanged.

Edits to existing text:

- AC-B18: "With the run limit 1, a user review start during an implement step gets 409 with 'Pause building after this step'. The loop waits for the free slot and then continues. With a larger limit, the same holds when the pool is full and its oldest run is a task step."
- Spec 6.20.6, "Run slots": "With atOnce 1, the steps take a slot of the run pool (section 6.26), as before (design.md B12, AC-B18)."
- design.md B12: add "Amended (limits.md decision 1): a pool of N slots, see spec section 6.26."
- BRIEF.md:241: "5. Several runs run at once, up to the run limit in Settings (default 3). Each pull request has one run at a time." "the run slot" becomes "a run slot".
- BRIEF.md:459, :490: "share the one run slot" becomes "share the run slots".
- BRIEF.md:500: "Run slots: a start gets 409 with a running run when its PR has a running run, or when every slot is in use."
- BRIEF.md:594: "or a busy run slot" becomes "a pull request with a running run, or no free run slot".

## 5. Work packages, tests, risks, gate

### WP-PR0, docs (implementer)

BRIEF.md, spec.md (6.26, AC-B18, 6.20.6), design.md (B12 note), limits.md (decision 1 status). BRIEF wins over every other file, so this lands first.

### WP-PR1, per-cache lock (implementer)

- workspace.ts (`prepareWorkspace` remove and add; `taskSnapshot` remove, add, nested add), tests/review/workspace.test.ts.
- Tests: hold `locked(cache)` and call `ws.remove()`; the entry stays listed until release. Hold the lock and start `prepareCommitWorkspace`; `repo/` does not exist until release. Three `prepareWorkspace` calls for three PRs of one repository at once all succeed. Control mutation: drop one lock.
- Risks: slower parallel setup on large repositories. A nested lock on the same cache deadlocks.

### WP-PR2, slot pool (implementer-xhigh)

- shared/task.ts `RUN_LIMITS.runsAtOnce`; shared/dto.ts `runLimitsInput.runsAtOnce`, `RunConflict.full?`, `RunSlotsDto`; jobs.ts (`active`, a runner per job, `taken`, `busyConflict`, `wake`, `onFree`, `cancelWhere`, `withPhase`, `busy`, `idle`, `slots`, `wait`, `stop`); routes.ts `GET /runs/slots`; loop.ts `waitSlot`; RunLimits.tsx one `FIELDS` entry.
- Tests: new tests/review/slots.test.ts; jobs.test.ts (recovery of two rows); task tests (settle helpers move to `idle()`; AC-B18 tests set limit 1); settings.test.ts. AC-B187 to AC-B192, AC-B194, AC-B195, AC-B197 with the fake claude `hang` scenario. Control mutation: limit check `>= 1`.
- Risks: a missed `job` reference lets a run go without a slot or a cancel miss its run. Test helpers that read `busy()` as "a run is active".

### WP-PR3, web, README, screenshots (implementer)

- review/model.ts `slotBusy` (`activeRun` goes); review/data.ts `useRunSlots`; ask/model.ts, discuss-model.ts texts; fix/model.ts W5; useStart, AskPanel, Discuss, ExplainPage, Consult; comments in FixBar and TaskChips; shared/task-status.ts; web tests and new `slotBusy` cases; m2.e2e.ts, ask.e2e.ts; README Run limits, CHANGELOG, screenshots; G-PAR steps in docs/smoke-r3.md.
- Tests: AC-B196. Optional e2e with limit 2 and two hanging runs.
- Risk: stale slots data disables Start by mistake. The guard and the server cover it.
- Built (2026-11-12): one hook `useSlots` (review/useSlots.ts) gives the note and the 409 text to every start control. A 409 refreshes the slots. The W3 toast adds "Try again when one ends." Ask, Discuss, Explain, and Consult are now disabled while the note shows. Fix again on a card already checks the note before a request. Draft replies, Draft reply, and Draft again keep the 409 toast only (AC-B221). `BriefState.busy` had no reader and went with `activeRun`. A save of the run limits refreshes the slots (AC-B191).

### Gate G-PAR (user, real CLI)

1. Set "Runs at once" to 3.
2. Start reviews on PRs A and B (one repository) and C (another repository) within 10 s.
3. PR D shows W2 with the three runs, and its Start is disabled.
4. Ask on PR A shows W1.
5. All three runs end with no `auth` or `process` error.
6. Afterward, `claude auth status` still shows `claude.ai`, and Claude Code still starts.
7. Cancel C while A and B run. Only C ends.
8. Record the peak memory of the three CLI trees and the wait of B for the fetch of A. Write sanitized facts into integration-check.md.

## 6. Open questions

User answers (2026-11-11): Q1 no, the steps run beside the pool. Q2 yes. Q3 409 with a note. Q4 yes. Q5 yes. All recommendations hold.

1. Q1. Do the steps of a task with "Parts that build at once" 2 or more count toward the new limit? Recommended: no. This keeps the 2026-11-02 decision and README "a review never waits for a build". If they count, one task with 3 parts can block every review.
2. Q2. Does the setting live in Settings, Tasks, Run limits as "Runs at once", 1 to 10, default 3? Recommended: yes.
3. Q3. With every slot in use, does a user start get 409 with a note, or wait in a queue? Recommended: 409. BRIEF.md:500 says there is no queued state, and a run that starts later may review stale heads.
4. Q4. Do waiting task steps get no fixed order and no queue position, with user starts first? Recommended: yes.
5. Q5. When the limit goes up while task steps wait, do they start at the next run end? Recommended: yes. This needs no hook on the settings save.

Not verified: the git window in `worktree add`, CLI locking of its global files, user MCP servers with two instances. Risk: the per-cache lock makes several runs on one large repository prepare one after another.
