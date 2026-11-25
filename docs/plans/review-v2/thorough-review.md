# Thorough review: the review twice, merged (variant "twice")

Status: built and shipped opt-in on 2026-11-25. WP-T0, WP-T1a, WP-T1b, WP-T1c, and WP-T2 are built. Gate T-0 and Gate T-P pass. The user decided on 2026-11-25 to ship without Gate T-A (Q2). The profile switch "Thorough review" is off by default. For this switch only, it replaces focused-passes.md section 11 question 2 and the section 9 rows "Parallel passes in three worktrees" and "App-side fuzzy dedupe across anchors". The text names no case ID, host, path, or project.

## 0. Short answer

- A review run with the variant "twice" runs the shipped review two times at once on one head. Each run ("arm") is today's one-run path: finder, salvage, judge, verify, and settle.
- Arm B gets its own snapshot: a second detached worktree of the same head and a copy of the other run files. Each arm has its own cwd, app folder, and runner.
- After both arms end, the pure function `mergeRuns` joins the two settled results. It hides a second copy of one point: same path, same side, ranges within 3 lines, one to one.
- A re-review, Explain, a task review, and every other run kind keep one run. lenses3 and runs3 win over twice.
- The UI switch "Thorough review" shipped after Gate T-0 and Gate T-P (section 4).

## 1. Evidence

| Per case | One run | Two runs merged (free analysis, docs/eval/results.md, section "2026-11-25: run the review twice and merge") |
|---|---|---|
| Grounded recall, shown | 38.3% | 48.3% (+10.0 points, 90% interval +5.0 to +15.0) |
| Grounded noise | 1.55 | 2.37 |
| Judge fp | 0.16 | 0.24 |
| Cost | $2.63 | $5.25 |
| Minutes, arms at once | 5.3 | 6.0 |

Facts read from the stored r6 records on 2026-11-25 (estimates, not eval output):
- Verify costs about 25.9% of the total. On average, the finder takes 3.64 min and verify takes 1.28 min per run.
- candidates.md blocks per run: mean 6.84, above VERIFY_SPLIT (12, catalog.ts:1615) in 7.3% of runs. The raw sum of the two repeats: mean 13.68, above 12 in 41.5% of cases. This is an upper bound, because it has no dedup.
- Wall time per case, estimates from phase times: two full arms at once 6.0 min. Finders at once with verifies in sequence 7.3 min. Finders in sequence with one larger verify about 10 min.

## 2. Decisions

### D1. Two full arms, merged after verify

- Only this setup has evidence: the union of two complete r6 runs, each with its own verify.
- Not adopted: one verify on the merged candidates (runs3 with two passes, jobs.ts:1380-1487). It saves at most one verify, about 13% of the total (estimate). The merged verify uses split mode in up to 41.5% of cases, against 7.3% today. That verifier regime has no measurement. The passes also run in sequence (about 10 min, estimate), and the user asked for runs at once.
- The arms cannot share one cwd:
  - Verify writes ./context/candidates.md (jobs.ts:1720).
  - Salvage writes ./context/salvage-notes.md (jobs.ts:1617).
  - Each CLI start writes mcp.json and agents.json into its app folder (claude.ts:510-531, 562-578).
  - Each run end deletes the per-cwd CLI folders (claude.ts:399-409, 971).
  - One runner runs one process (claude.ts:772).
- New `twinWorkspace(ws, runId, dataDir, long)` in workspace.ts:
  - It adds a detached worktree of `ws.sourceHead` at runs/<id>-2/work/repo under `locked(ws.cache)`.
  - It runs the same `sanitize` with the ls-tree links as prepareWorkspace (workspace.ts:483-512), and passes the same checks (BRIEF 3.5).
  - It copies every other entry of `ws.work` (context/, skills/, CLAUDE.md) with the async `cp`.
  - Its `remove` deletes the folder and prunes the worktree entry under the lock.
- twinWorkspace does not fetch, so both arms see one head. A second `prepareWorkspace` would fetch again, and a moved head fails the pin check (workspace.ts:367-373).
- Arm B calls `profileServers` on its own repo, so a codegraph server indexes and reads the arm B repo (jobs.ts:922-961). indexRepo sets `j.phase` and `j.abort` (jobs.ts:879-896). This is safe, because the arm B setup ends before either finder starts.
- Start order: the app first builds the arm B snapshot and tools. Then it makes one cancel check and starts both finders with no await between them.

### D2. Dedup rule and survivor

- One shared definition in src/shared/review.ts: `COPY_LINES = 3` and the pure `copyPairs`. The eval imports it. LOCAL_TOLERANCE (score.ts:217) stays the eval tolerance.
- Two items are copies when path, side, `preexisting`, and `polish` are equal, and the two ranges overlap after one range grows by 3 lines at each end. This is `overlaps` with widening (score.ts:220-226).
- Only shown items take part: kind finding, status new. Refuted and hidden items stay as they are. So a point that one arm shows and the other refutes stays shown, as in the measured union.
- Pairs are one to one and only across arms. The app takes the arm B items in item order. Each one pairs with the unpaired arm A copy at the smallest line distance, then with the first in order.
- Survivor rule, in this order:
  1. The better display group: main before fold.
  2. The higher severity.
  3. The better check: checked, then unsure, then unchecked.
  4. Arm A.
- displayGroup and checkOf are in review.ts:276-303. The survivor keeps its own text, evidence, and verdict. The app merges no text.
- The other copy gets the shape of a verifier duplicate:
  - status discarded and discardedBy "verify";
  - verify `{ verdict "duplicate", severity, reason "Run <k> of 2 raised the same point.", evidence "<path>:<line>", duplicateOf null, by "app" }`;
  - a link that names the survivor.
- Expected effect: the Hidden list, Restore, and history.md need no change (review.ts:236-239, 266, 295; items.ts:136-153). WP-T1a checked this claim. Restore and four texts need a change (section 9).
- Caps: PREEXISTING_MAX and POLISH_MAX stay per arm (judge.ts:917-938). The measured union had no second cap, so a merged run can show twice each cap.

### D3. Merge: `mergeRuns` in judge.ts, next to `mergeFound`

- Input: the arm Endings in arm order and the run volume. An arm is usable when its Ending has a result, with status completed or incomplete (judge.ts:225).
- items: arm A, then arm B, after D2.
  - Each finding item gets `pass: k` (review.ts:734), so the eval rows "pass k" and "only pass k" work.
  - Reply items come only from the first usable arm. Two drafts for one thread would both insert (drafts.ts:107-131).
- links: arm B numbers and duplicateOf move up by N1, the verify.candidates of arm A. A paired item without a link (from a question, risk, or obligation) gets a new number above both arms. end() resolves the numbers to item IDs (jobs.ts:759-777).
- fromRisk of arm B items moves up by the length of the arm A risk list (judge.ts:987).
- summary:
  - The summary text comes from the first usable arm.
  - risks, dropped, finderRisks.list, obligations.list, and finderQuestions.answers concatenate, and their counts add.
  - Coverage lists join without exact duplicates.
  - verify counts add. failed comes from the first arm that has it.
- phases: one find phase (earliest start, latest end, usage sum). One check phase is made the same way when an arm has one. The run line then keeps two step parts (model.ts:835-840).
- runs: new optional `RunSummary.runs = { count: 2; copies }`. copies counts the hidden copies of D2. A one-run review has no key.
- raw: one "# Run k of 2" section per arm, within `cap()`. outcome: the outcome of the first usable arm, with the events of both arms.
- usage: the sum. An Ending without `usage` counts the usage of its outcome (judge.ts:105). The pass loop uses the same rule (jobs.ts:1452).
- notedBy runs once on the merged outcome (jobs.ts:1342-1351).

### D4. Events and the running line

- Arm k tags its event IDs:
  - finder events: `pass<k>:` (run-log.ts:54);
  - salvage events: `pass<k>:salvage:`;
  - check events: `check:pass<k>:`.
- eventPhase reads only IDs that start with "check:" as check (run-log.ts:55).
- Seq: arm A starts at 0 and arm B at 1,000,000 (new const `ARM_SEQ`). Salvage and verify take their offset from the events of their own arm (jobs.ts:1619, 1731). run_event has no unique seq (007_review.sql:41-53).
- Each arm starts with a mark event: tool "Pass", note "Run k of 2."
- `j.phase` becomes "checking" when the first arm starts its check. The candidate, question, and risk counts add across arms (jobs.ts:1725-1729). Known limit: the text does not say that the other arm still finds.

### D5. Cost, time, usage, and the pool

- The run line shows tokens, turns, and step times, not dollars (RunLine.tsx:321-325, 644-647). Only Review quality shows dollars (ReviewQuality.tsx:193). Both read the summed usage.
- The Run setup list gets one line: "Thorough review: 2 runs at once. <n> repeated findings hidden."
- Expected cost: 2.0 times one run. Expected time: about 1.15 times (6.0 against 5.3 min, plus the arm B snapshot).
- One thorough run takes one pool slot and runs two Claude processes (section 8, Q1, decided). So "Runs at once" 3 can run 6 processes. The switch help says "About twice the usage."
- Usage limit and auth: no arm cancels the other. The limit stops every new model call of the account, so the other arm spends nothing more. When the other arm ends with a result, the user keeps it.
- Review quality counts a thorough run as one run, with its summed counts and cost.

### D6. Scope and other variants

| Case | Rule |
|---|---|
| Re-review | One run. Two `earlier` verdict lists cannot merge (focused-passes.md section 9). A re-review carries only new and accepted items (rereview.ts:14), so hidden copies never carry. |
| Explain, Ask, reply, fix, discuss, session, task review | One run. |
| lenses3, runs3 | Their passes win (jobs.ts:1380). The log says that twice is off for the run. |
| verify2, refute-issue, security2-verify, obligations | The verify of each arm gets them. |
| broad, callers, architecture, classes, parts, security2, minor-fold | Both arms get byte-identical prompts. |
| stack, submodules | The context files build once. Arm B gets a copy. |
| codegraph, a picked codegraph server | Each arm indexes its own repo, so index time doubles. Unverified. Gate T-A runs without it. |
| Eval replay | Refused, because twice changes the finder (run.ts:301-336). |

## 3. State machine

Each arm runs today's one-run machine (jobs.ts:1488-1521, 1598-1672, 1675-1783). Arm B adds the state "copying".

| # | From | Event | To | App action |
|---|---|---|---|---|
| A1 | copying (B) | snapshot and tools ready | ready (B) | Arm A waits. Both finders start in one tick (D1). |
| A2 | copying (B) | twinWorkspace or profileServers fails | failed, workspace | Add the line "Run 2 of 2 did not start: <reason>." Arm A runs alone (section 8, Q4, decided). |
| A3 | finding | completed, judge gives Found | checking | Run verifyPhase in the arm cwd. With zero blocks: settled. |
| A4 | finding | completed, judge gives an Ending | failed | Keep the Ending (schema). |
| A5 | finding | failed, max_turns | salvaging | Run salvagePhase in the arm cwd. |
| A6 | finding | failed, another kind (usage_limit, auth, process, time limit) | failed | Keep the Ending. |
| A7 | salvaging | salvage and judge give Found | checking | Add the `salvaged()` line, as today. |
| A8 | salvaging | no notes, salvage fails, or judge fails | failed, max_turns | Use salvageFailed, as today. |
| A9 | checking | verify ends with any status | settled | Run settle(). A failed check adds its own line (judge.ts:1010-1016). |
| A10 | copying, finding, salvaging, checking | cancel | cancelled | The arm runner ends its process. The arm keeps its usage. |
| A11 | any | exception | failed, process | The arm catches it. The other arm goes on. |

| # | Arm A | Arm B | Run end |
|---|---|---|---|
| J1 | settled | settled | Run mergeRuns. The run is completed, or incomplete when a gap line exists. |
| J2 | settled | failed | Use the arm A result. Add "Run 2 of 2 failed: <kind>. Its findings are missing." to coverage skipped and gaps. The run is incomplete. |
| J3 | failed | settled | Use the arm B result and the line "Run 1 of 2 failed: <kind>. Its findings are missing." |
| J4 | failed | failed | The run fails with the arm A Ending, the usage sum, and the events of both arms. |
| J5 | cancel came | cancel came | Both runners cancel. The run waits for both arms and ends cancelled with the usage sum. |
| J6 | app stops | app stops | Recovery ends the row with "The app stopped during the run." (jobs.ts:538). The first prune removes runs/<id> and runs/<id>-2 (workspace.ts:787-795). |

Rules:
- The run returns only after both arms end, also on cancel. So `execute` removes both folders only after both processes end (jobs.ts:1843-1859). `held` gets `twin`.
- `cancelWhere` cancels `j.runner` and the new `j.twin` (jobs.ts:2322-2331).
- "Review run time" applies to each process (claude.ts:801-803).

## 4. Gates (the user approves each paid run)

Gate T-0, free, after WP-T1a:
- A scratch script reads the two r6 repeats and their labels. It applies `copyPairs` and the survivor rule to the stored items.
- It tests the dedup rule on the same data as the +10-point estimate, not the gain.
- Pass: grounded shown recall of at least 28 of 60 (the raw union shows 29), and grounded noise of at most 2.5 per case.
- Result (2026-11-25): PASS. Merged recall 29/60, grounded noise 2.49 per case (limit 2.5, margin one item), judge fp 0.29 per case. The merge hid 46 pairs and lost no must-find. Scored with score.ts, which counts a second hit on one bug as noise, so the raw union shows 3.49 here against 3.10 in docs/eval/results.md.

Gate T-P, paid pilot: two small natural cases, repeat 1, `--variants twice`. Estimate: $6-15.
- Pass: both case runs finish. Each case run has 2 find calls and 2 verify calls, plus any salvage calls. The events hold `pass1:`, `pass2:`, `check:pass1:`, and `check:pass2:`. No runs/<id>-2 folder stays. The cost factor against r6 on the same cases is 1.6 to 2.4. The minutes factor is at most 1.4.
- Result (2026-11-25): PASS. Both case runs completed. Each case run had 2 find calls and 2 verify calls. Cost factor 2.26 and 1.97 against the baseline mean of the same case. Minutes factor 1.05 and 1.04. Each case hid 3 copies. Shown must-finds 2/4 and 2/5, against baseline 2-3 of 4 and 2-3 of 5. Two cases show no quality difference. The eval keeps no app events, so only tests/review/twice.test.ts checks the D4 event prefixes.

Gate T-A, paid, optional: not run (Q2). The design was: the natural set r6 (41 cases), effort medium, repeat 1, about $221 with labels.

```
REVIEW_LOOP_EVAL_LOCAL=<natural set r6> bun run eval -- --real --set local --repeat 1 --effort medium --variants twice --out eval-results/natural-r6/twice
REVIEW_LOOP_EVAL_LOCAL=<natural set r6> bun run eval:label -- eval-results/natural-r6/twice --real
bun run eval:compare -- <baseline r6 result.json> <twice result.json>
```

- The standing noise rule (+10% grounded noise, +0.07 judge fp) fails for any union by design: the free union already has +0.82 noise and +0.08 judge fp. Gate T-A needs its own limits, and the user must accept them.
- Proposed limits: the paired delta of grounded recall is at least +5.0 points and its 90% interval excludes 0; grounded noise at most 2.6 per case; judge fp at most 0.31 per case run; notCompleted per case run not above r6.
- Power (estimate): at a true +10 points, repeat 1 passes about 7 times in 10.
- Without T-A: T-0 replays the merge on stored data and T-P checks the build. Both arms use byte-identical prompts, so T-A mostly measures run-to-run variance again.

## 5. Work packages (run order, one implementer at a time)

WP-T0, docs: review-ledger.md row "twice" (designed); CLAUDE.md status; focused-passes.md section 11 question 2 note; BRIEF.md:139 (arm B worktree); BRIEF.md:245 (two processes in one slot); spec.md:3153 (a thorough review has two runners).

WP-T1a, merge: src/shared/dto.ts (`VARIANTS` gets "twice"; `RunSummary.runs`), src/shared/review.ts (`COPY_LINES`, `copyPairs`), src/server/review/judge.ts (`mergeRuns`), tests/review/merge-runs.test.ts (new).
- Tests: arm order; offsets of links, duplicateOf, and fromRisk; one find phase and one check phase; usage sum with an Ending without usage; reply items only from the first usable arm; `pass` per arm. Copies: 3 lines pair, 4 do not, another side does not, two arm B items near one arm A item hide only one. Survivor order. Failed arms: one usable arm adds its gap line; no usable arm gives the arm A Ending.
- Also: grep every reader of `discardedBy`, verdict "duplicate", and `by` (stats.ts, Review quality, Hidden list, history.md, Restore). Confirm the schema accepts `by: "app"`. Decide whether hidden copies count as verifier discards in Review quality.
- Control mutations: COPY_LINES 2 fails the 3-line test; no N1 offset fails the link test.

Gate T-0 (orchestrator, free).

WP-T1b, snapshot: src/server/review/workspace.ts (`twinWorkspace`), tests/review/workspace.test.ts. Tests: the twin repo has the head files and no link; renamed instruction files stay renamed; context/, skills/, CLAUDE.md are copies; `remove` deletes the folder and the worktree entry; an aborted signal stops the add. The twin passes the same sanitize checks as the primary.

WP-T1c, wiring (implementer-xhigh): src/server/review/jobs.ts (Job `twin`, `cancelWhere`, `held.twin`, a local `arm` from the one-run tail, runner and event prefix for findRun, salvagePhase, verifyPhase, D1 start order, D4 counts); src/server/review/catalog.ts (`twice(p)`); tests/support/fake-claude.ts (per-cwd scenario key); tests/review/twice.test.ts (new).
- Tests: the default profile keeps 1 find and 1 verify call, untagged events, no `pass`, no runs/<id>-2. twice: 2 find and 2 verify calls that overlap in time, different cwd and app folder, byte-identical agent prompts, D4 event IDs. One test per row of section 3. A re-review with twice makes 1 find call. lenses3 with twice makes 3 find calls. promptVersion ends in "+twice".
- Control mutations: one shared cwd fails the cwd test; no twin cancel fails the cancel test.
- Acceptance: `bun run check` green; existing jobs tests pass with no edit.

Gate T-P (paid, user approves). Gate T-A does not run (Q2).

WP-T2, ship: src/web/settings/profiles.ts (Part "twice"), ReviewProfiles.tsx (Toggle, help "Runs the review twice at once and merges the findings. About twice the usage. Full reviews only."), src/web/review/model.ts and RunLine.tsx (D5 setup line), tests/ui/profiles.test.ts, a model test, README.md (profile switches, "Runs at once" note), CHANGELOG.md, `bun run screenshots`, review-ledger.md (shipped opt-in).

## 6. Invariants

| Invariant | Evidence |
|---|---|
| One runner runs one process. | claude.ts:772 |
| Each run end deletes its per-cwd CLI folders. | claude.ts:399-409, 971 |
| Each CLI start writes mcp.json and agents.json into appDir. | claude.ts:510-531, 562-578 |
| Verify and salvage write fixed file names into ./context. | jobs.ts:1617, 1720 |
| Salvage and verify use `j.runner`. | jobs.ts:1647, 1745 |
| Cancel reaches only `j.runner`. | jobs.ts:2322-2331 |
| `execute` removes `held.ws` after `steps`, and a throw ends the run as process. | jobs.ts:1843-1859 |
| The pass loop owns lenses3 and runs3. | jobs.ts:1380-1487; catalog.ts:827-828 |
| A link number maps to an item ID at insert. | jobs.ts:759-777 |
| Only app gap lines make a run incomplete. | judge.ts:222-225 |
| A re-review carries only new and accepted items. | rereview.ts:14 |
| Check event IDs start with "check:". | run-log.ts:49-55 |
| prepareWorkspace fails when the head moved. | workspace.ts:367-373 |
| Recovery ends running rows, and prune removes runs/. | jobs.ts:538; workspace.ts:787-795 |

## 7. Risks

1. Noise rises by about 0.8 per case. Most extra findings are true minor ones. The switch is opt-in.
2. Usage: two processes run in one slot, so usage limits come sooner.
3. Disk and time: each thorough run adds a second worktree.
4. A false pair: two bugs within 3 lines can hide one of them. Gate T-0 measures it, and Restore brings it back.
5. Shared code: `steps`, `salvagePhase`, and `verifyPhase` get a runner and a prefix. Tests guard the default path bytes.

## 8. Questions and unverified items

Decisions of 2026-11-25:
- Q1. Slot: one slot with two processes. The main session decided this default.
- Q4. When the arm B snapshot fails, the run goes on with arm A and ends incomplete.
- Q5. Label: keep "Thorough review" with the ID "twice". The volume value `thorough` (BRIEF.md:485) shows as "Show everything" (src/web/review/model.ts:638), so the visible words do not clash.
- Q2. Gate T-A: the user decided to ship after Gate T-0 and Gate T-P. Gate T-A does not run.

Unverified:
- U1. Two CLI processes write the CLI global files (~/.claude.json) at the same time. The shipped app already runs up to 3 `claude` processes at once by default ("Runs at once", src/shared/task.ts:96). So two arms add no new kind of risk. Gate G-PAR stays open (parallel-runs.md section 2).
- U2. A user stdio MCP server can refuse a second instance (parallel-runs.md section 2).
- U3. The arm B snapshot time. Estimate: below the mean setup time of 0.25 min per r6 run.
- U4. The 7.3 min and 10 min times are estimates from phase times.
- U5. Two codegraph indexes of one repository at once.
- U6. Built in WP-T2: the texts of section 9 branch on `verify.by === "app"`.
- U7. The pass chances in section 4 are rough estimates.
- U8. Checked in WP-T1a. Section 9 has the results.

## 9. Build notes (WP-T1a, WP-T1c)

Choices that the design left open:
- Line distance in `copyPairs`: the gap between the two ranges, 0 when they overlap. A gap of at most COPY_LINES pairs.
- The hidden copy says "Run <k> of 2 raised the same point.", where k is the arm of the survivor. Its evidence is the survivor path and line.
- A finding with the verdict refuted takes no part, also when it is demoted and so has status new.
- `runs` is set on every merged result, also with one usable arm. copies counts the pairs.
- The usage sum and the events include the failed arms.
- The link offset of an arm is the larger of its verify.candidates and its highest link number.
- The gap text of a failed arm names its kind, else its status.
- `--variants twice` passes the eval flag check now, but the run has one arm until WP-T1c.

U8, the readers of `discardedBy`, verdict "duplicate", and `by`:
- No zod parser reads a stored `verify` mark. `VerifyMark.by` is a TypeScript `string`, and no code compares it. context-files.ts prints it as text ("duplicate by app").
- Review quality (stats.ts): `userDiscard` excludes `discardedBy` "verify", so a hidden copy is no user discard. The counts read `verify.refuted`, `unsure`, and `candidates`, never `duplicates`. `shown` uses displayGroup, so a copy is not shown. Hidden copies do not count as verifier discards. candidates adds both arms.
- Hidden list, run-rows.ts OPEN_FINDINGS, Restore (items.ts:126-153), and history.ts work unchanged: they key on `discardedBy` "verify".
- Wrong words for an app copy, for WP-T2: RunLine.tsx:168 says "The check found the same point in another draft.". model.ts hiddenParts counts it as "1 duplicate". model.ts restoredNote says "A duplicate by the check. You restored it.". context-files.ts:274 says "refuted by the check". WP-T2 branches these four texts and checkText on `verify.by === "app"`.
- Restore: mergeRuns keeps the arm verdict of a copy in `ownVerify`, and Restore puts it back as `verify` for a copy with by "app". A restored copy with its own verdict shows as a normal finding.
- The "Thorough review:" and "Hidden: " prefixes in RunLine.tsx have no render test. The tests cover only the model texts.
- Eval (score.ts): a hidden copy gets the state "duplicate". The verifier loss takes the best state of the items that raise an issue. So a copy counts as a loss only when its survivor does not match that issue. That is a false pair (section 7, risk 4).

### WP-T1c

Choices that the design left open:
- Row A2: arm 2 ends as `failure("workspace", <reason>)`. So mergeRuns adds the J2 line "Run 2 of 2 failed: workspace. Its findings are missing." to coverage skipped. The line "Run 2 of 2 did not start: <reason>" goes to coverage notChecked. The reason is the error text without URLs, on one line.
- `held.twin` is set right after twinWorkspace returns, before profileServers. So a cancel or an error in profileServers still removes the arm 2 folder.
- Row J5: a cancel ends the run cancelled after both arms, also when one arm settled before the cancel. That arm result is dropped, as a cancel in the check phase drops the finder result of a one-run review.
- Each arm passes its find usage (finder plus salvage) to verifyPhase as findUsage. So a cancel in its check keeps its finder usage in the sum. The one-run path does not change.
- Row A11: the failure of an arm keeps its finder outcome when one exists. So its usage and events count.
- The salvage line of an arm is the line of a one-run review. mergeRuns joins notChecked without exact duplicates.
- verifyPhase adds j.candidates, checkQuestions, and checkRisks, and ORs checkObligations. Every other path calls verifyPhase once per job, so its values do not change.
- Arm 2 uses its own profileServers result: its mcp.json, its MCP lines, and its gaps. The finder prompts are byte-identical when both arms get the same servers.
- promptVersion has no change. It names every profile variant, so a re-review or a lenses3 run of a profile with "twice" also stores "+twice". lenses3 on a re-review already behaves this way.
- tests/support/fake-claude.ts gets `byCwd`: fields by a regex on the run folder name. Its seq counts only the earlier runs of one call key in the same cwd.
- No new test for row J6. Recovery and the first prune are unchanged code. Row A3 and row A9 are part of the J1 test.

Eval replay (built in WP-T2): replayRefusal refuses every replay when the recording or the replay profile has "twice".
- Before WP-T2, replayRefusal refused only a replay that adds or drops "twice", by the finder prompt version. The recorder numbers the calls of both runners with one counter. The two finder calls get 1 and 2 in arm order, but a salvage call gets its number in end order, which is not stable. So a replay with a salvage call can read the wrong recording. Recording works.
