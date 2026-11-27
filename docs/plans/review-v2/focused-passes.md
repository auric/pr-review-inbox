# Focused passes: three finder runs with different lenses (variant "lenses3")

Status: design of 2026-11-21 against main 484a4e5. WP-L0, WP-L1, and WP-L2 are built opt-in (section 12). The user decided section 11 on 2026-11-21. WP-AR1 is pushed (bb1afd0). G-L0 failed on SG-A (2026-11-23), so runs3 does not run. lenses3 failed the noise rule on the natural set (2026-11-25, section 5.3) and stays opt-in. Packages: WP-L0 (docs), WP-L1 (passes in the app), WP-L2 (eval diagnostics). Paid steps: pilot P-L, gates G-L1 and G-L2. The conditional package WP-L3 (merge agent) runs only when the noise rule fails mainly through duplicates. The text names no other app, company, host, project, case ID, or PR number. The recall plan of 2026-11-17 lies outside the repository. Its lens names are reused here, and the lens text in this file is new.

The SG-A natural-issue analysis (docs/eval/results.md, section "SG-A natural-issue analysis") shows that the finder loses the missed natural issues, and it proposes the next recall screen.

Sources: review-quality-2026.md (items 6, 7, 11, 12, section 2, section 4), architecture-bugs.md, seeded-truth.md (sections 4, 6.5, 9, 14), review-ledger.md, review-v3.md (section 10, WP-V14), parallel-runs.md, and the code: catalog.ts, jobs.ts, judge.ts, validate.ts, context-files.ts, claude.ts, src/shared/dto.ts, review.ts, run-log.ts, scripts/eval/run.ts, ab.ts, score.ts, compare.ts.

## 0. Short answer

- One review runs three finder passes in sequence, in one workspace, run row, and run slot. Each pass is the full default finder with one lens block added.
- L1 looks at failure paths, ownership, and shared state. L2 takes CALLERS_LINES and ARCHITECTURE_LINES. L3 looks at the whole change: entry points, places it runs, scale, and rollout.
- Each pass is checked alone by `judge()`. The app then joins the three results into one candidate list. The existing overlap groups and the verifier "duplicate" verdict remove the repeats. One verify phase checks the union.
- The control "runs3" uses the same code with no lens lines. It differs from lenses3 in the lens text and ARCHITECTURE_VERIFY (section 4.7). Today neither variant exists in code.
- With both variants off, no prompt, schema, event ID, payload, or version changes. Snapshot tests prove it.
- The gate runs on the seeded set against SG-A. "Better" needs recall above S_R and a paired interval that excludes 0. The new noise rule, trap rate, extras, and notCompleted also apply. The user decides on cost.
- Expected cost is 2.4 to 3.0 times one review, and expected minutes are 2.5 to 3 times (estimates). A real +10-point gain has about a one-in-two chance to pass. The noise rule is the likeliest failure, because three passes add true findings outside the seeds and the same bug at two anchors.

## 1. Problem and evidence (own eval data, counts only)

- Miss groups, prompt 2.x, 42-case local set, 213 of 280 must-find pairs missed: file opened but problem not named 148 (69.5%); file not read in full 37 (17.4%); raised but hidden 11 (5.2%); named in the run's own risks 7 (3.3%); doubtful 10 (4.7%).
- Gate A analysis: 58% read but not raised (69% with diff-only), 27% never opened, 4% lost in verify.
- Union curve, same prompt, shown recall: k=1 23.4%, k=2 29.5%, k=3 33.1%, k=4 35.6%, k=8 41.4%. 37 of 70 must-finds were never raised in any run.
- Conclusion: most misses come from attention, not coverage. Repeats of one prompt saturate fast. A lever must change the mindset of each run.
- Scope: lenses3 targets the "read but not raised" group. The "never opened" group stays with coverage levers such as "parts".

## 2. Lessons from earlier variants

| Variant | Result | Lesson for lenses3 |
|---|---|---|
| parts (review-v3.md 10.5, U-V4) | Parts worked, but no more bugs were found. The local set could not measure large-PR recall. | Opening more files does not fix the "read but not raised" misses. Measure on a set with power. |
| broad (item 3, W3) | Raised recall went from 26.4% to 29.3%, and grounded recall rose by 1 bug. The interval included 0, and cost rose 23%. | More candidates from one mindset add little. The natural set cannot show a gain of a few bugs. |
| classes (item 7) | Gate blocked: no labels per bug kind. | Lens kinds need per-kind truth. The seeded `kind` rows give it. |
| signal (section 4) | Strict finder rules cut recall from 30.8% to 11.5%. | Lens lines add emphasis and end with "Report other problems too." They never say "only". |
| one agent on large PRs (item 1) | Failed. | Each pass keeps rl-reviewer delegation as today. |

## 3. Facts from the code

- One runner runs one CLI process at a time. A second `run()` throws (claude.ts:765-772).
- Each run end deletes the per-cwd session folders of its cwd (claude.ts:401-409, :971). A parallel process in the same cwd would lose its folder.
- Salvage and verify already run as new processes, in sequence, in the same workspace, run row, and slot (jobs.ts:1345-1418, :1420-1522). Each one tags its events with a prefix and a seq offset (jobs.ts:1384-1389, :1472-1477).
- `eventPhase` reads every ID without "check:" as phase find (run-log.ts:52). The run log (web/review/model.ts:90-92) and `runFacts` (run.ts:397-416) use it.
- `judge()` validates one finder outcome. It then numbers the candidates and computes `overlapGroups` (judge.ts:295-365, :354).
- Overlap groups join findings with the same path, the same side, and overlapping anchors (validate.ts:334-358).
- A duplicate verdict counts only inside one overlap group. Outside a group it reads as unsure (judge.ts:437-454). A counted duplicate hides (judge.ts:472-476).
- Above VERIFY_SPLIT (12) candidates, rl-verifier checks batches of 6 (catalog.ts:1426-1427). Only "verify2" keeps one group in one call (catalog.ts:1442, jobs.ts:1495). verify2 was removed on 2026-11-27. The group line (VERIFY_GROUP) stays for the finder passes.
- `verifyMaxTurns` grows with the candidate count, up to the profile turn cap (jobs.ts:265).
- candidates.md holds at most 200 KB (context-files.ts:75-76) and MAX_FINDINGS blocks (review.ts:12). The rest stays unchecked.
- A reply draft for an answered question carries no finding index. An "issue" becomes a normal finding (validate.ts:485-558).
- Only app-added lines in skipped or unavailable make a run incomplete (judge.ts:222-226). The eval counts incomplete apart from notCompleted (score.ts:193-194).
- `promptVersion` appends the sorted variants (catalog.ts:245). `profileRevision` hashes `variants` only when the list is not empty (catalog.ts:241).
- VARIANTS has 13 names, including "architecture" (WP-AR1, bb1afd0). No file in src, scripts, or tests names "runs3" or "lenses3" (grep, main 484a4e5).
- A finder variant cannot be replayed (run.ts:288-294, :316-329). The recorder numbers calls in start order (run.ts:659-688).
- The run time limit applies to each Claude process (jobs.ts:476-480, task.ts:88-92). The app has no dollar cap.
- The fake CLI gives the Nth run of one call key its own output through `seq` (tests/support/fake-claude.ts, `seq`).
- WP-AR1 (pushed in bb1afd0) adds `architecture(p)`, `ARCHITECTURE_LINES` after `callers(p)` in mainAgent and reviewerAgent, and `ARCHITECTURE_VERIFY` in verifyRules.

## 4. Design

### 4.1 Variants and scope

- dto.ts VARIANTS gets "lenses3" and "runs3", in alphabetical order.
- catalog.ts: `export type Lens = "failure" | "contract" | "system"` and `passLenses(p): (Lens | null)[]`.
  - lenses3 returns `["failure", "contract", "system"]`.
  - runs3 returns `[null, null, null]`.
  - Any other profile returns `[null]`.
  - When both variants are set, lenses3 wins.
- Passes apply only to a full PR review: `j.kind === "review"`, no carry, and no Explain. A re-review, a task review (taskReviewSteps), discuss, ask, reply, and fix keep one finder run.

### 4.2 How the passes run

- Order: pass 1, then pass 2, then pass 3, in sequence. Reasons: one runner runs one process; a run end deletes the per-cwd folders; the recorder needs a stable call order for replay; the pool promises N processes at once.
- Same snapshot: every pass uses the same `ws`, ./context files, MCP servers, skills, language lines, delegation, model, effort, advisor, schema, and maxTurns.
- Pass k gets `mainAgent(profile, ctx_k, lens_k)`. When the change is large, it also gets `reviewerAgent(profile, context, parts > 0, lens_k)`.
- Pass 1 gets `context` and `input` as today. Passes 2 and 3 get `questions: false` in both. They therefore get no ANSWERED_RULES and no questions.md line in stdin.
- `judge()` runs on each pass with `asked = j.asked` for pass 1 and `[]` for the other passes. So only pass 1 makes reply drafts.
- Independence: no pass reads the output of another pass. candidates.md is written only after the last pass (jobs.ts:1460). After each salvage run, the app deletes ./context/salvage-notes.md.
- Caps per pass are the existing ones: the profile maxTurns, SALVAGE_MAX_TURNS for salvage, and the "Review run time" limit for each Claude process. The app adds no dollar cap.
- Cancel: the app checks `j.cancelled` before each pass and each salvage, with no await before `run()`, as salvage does.
- Stop rule: after a pass fails with usage_limit or auth, the later passes do not start.

### 4.3 Pass state machine

Pass states: waiting, running, salvaging, done, salvaged, failed, skipped. The run-level end state is cancelled.

| # | From | Event | To | App action |
|---|---|---|---|---|
| 1 | waiting | its turn, no stop, no cancel | running | Write the mark event (4.9). Start the CLI run. |
| 2 | waiting | its turn, stop set | skipped | Gap line "Pass k of n (label) did not run, because pass j hit kind." |
| 3 | waiting, running, salvaging | cancel | run cancelled | Return the cancel ending with the usage sum of all passes so far. |
| 4 | running | completed, judge gives Found | done | Keep the Found. |
| 5 | running | completed, judge gives an Ending (schema) | failed | Gap line "Pass k of n (label) failed: schema. Its findings are missing." |
| 6 | running | failed, max_turns | salvaging | `salvagePhase` with the pass event prefix. |
| 7 | running | failed, usage_limit or auth | failed, stop set | Gap line as row 5, with the kind. |
| 8 | running | failed, any other kind | failed | Gap line as row 5, with the kind. |
| 9 | salvaging | salvage completed, judge gives Found | salvaged | `salvaged()` with the line "Pass k of n (label) reached its turn cap (N). Its findings come from its notes so far." Delete salvage-notes.md. |
| 10 | salvaging | salvage or its judge fails | failed | Gap line as row 5, with max_turns. Delete salvage-notes.md. |
| 11 | after the last pass | no pass done or salvaged | run failed | End the run as a one-pass run ends with pass 1: its salvageFailed or judge Ending. |
| 12 | after the last pass | one or more passes done or salvaged | merge | Merge (4.4), then verifyPhase, then settle. Gap lines make the run incomplete. |

With one pass, steps() keeps today's path and endings. The existing jobs tests stay green with no edit.

### 4.4 Merge and dedupe

New pure function `mergeFound(list: { k: number; lens: Lens | null; found: Found }[], n: number): Found` in judge.ts, next to `salvaged`. It follows these rules:

- candidates: concatenated in pass order. Each finding gets `pass: k`. `n` is renumbered from 1. `group` is recomputed with `overlapGroups` over the union.
- questions: concatenated.
- replies: pass 1 only.
- summary.summary: the first usable pass.
- summary.risks: concatenated, with exact-text duplicates removed.
- coverage: `read` and `unavailable` as a union, and `skipped` and `notChecked` concatenated with exact duplicates removed. Gap and salvage lines of 4.3 are added.
- dropped: concatenated.
- gaps: concatenated with exact duplicates removed, plus the gap lines of 4.3.
- raw: each pass's raw output under "# Pass k of n (label)", within the `cap()` limit.
- outcome: the outcome of the first usable pass, with `events` replaced by the events of all passes.
- checked: absent, because a re-review keeps one pass.

Dedupe uses only the existing handling:

- Overlap groups catch two passes that anchor one bug on overlapping lines. The verifier marks one as duplicate, and capOf hides it.
- The same bug at two anchors that do not overlap stays as two shown findings. It costs grounded noise (goldLabels, score.ts:257-265). WP-L2 counts it as `dupShown`.
- No app-side fuzzy match is added. The merge agent of item 6 stays the fallback (WP-L3).

`AnchoredFinding` (review.ts:730) gets an optional `pass?: number`. Only `mergeFound` sets it. `findingItem` stores it in payload_json. `candidatesFile` does not print it, so the verifier never learns the lens. The CLI schema does not change.

### 4.5 Verify phase

- One verify phase runs on the merged Found and the merged outcome. The check events go after all pass events.
- With two or more passes, `withVerifyDelegation` gets `group = true`. That adds VERIFY2.group, "Give the candidates of one group to the same call.", so a split check can still mark a duplicate.
- Under lenses3, verifyRules adds ARCHITECTURE_VERIFY, which WP-AR1 defines. The condition becomes `architecture(p) || has(p, "lenses3")`. Without it, the do-not-flag item "a choice between two correct designs" refutes L2 candidates with no rule for the two cited places. runs3 does not get these lines.
- The duplicate line, the rubric, and the do-not-flag list stay the same.

### 4.6 Lens lines

Rules for the text:
- The text comes from the kind definitions and the lens names. It never copies the "abstract edit patterns" column of seeded-truth.md 4.1.
- WP-L1 freezes the text. A later edit voids every earlier lenses3 result.
- No line says "only", "must not report", or "double-check".

The lens block sits in the slot after `finderRules`, where `callers(p)` and `architecture(p)` sit today. Both rl-main and rl-reviewer use it:

```
focus(p, lens) = unique lines of [...callers(p), ...architecture lines when architecture(p), ...LENS_LINES[lens] when lens]
```

With lens null, `focus` gives the WP-AR1 lines in the WP-AR1 order, so the bytes do not change. "Unique" keeps the first copy of a line. So "callers" or "architecture" stacked with lenses3 adds no line twice. The salvage run gets no lens.

LENS_LINES.failure (L1):

```
Look hardest at what the change does when a step fails, stops early, or overlaps another step.
Follow each exit of a changed function to its end: a return, a throw, a cancel, or a timeout.
Check what each exit leaves behind: held resources, partial state, and errors that nobody sees.
For each object, handle, task, and callback that the change creates or keeps, find its owner and its end.
Check each use of state that two threads or tasks share.
Report other problems too.
```

LENS_LINES.contract (L2). The two constants are spread in place, not copied:

```
Look hardest at how the change fits the code outside the diff.
...CALLERS_LINES
Check what each caller and consumer expects from the changed code, and what it now gets.
For each change, find the other places that must change with it. Report each place that the change misses.
...ARCHITECTURE_LINES
Report other problems too.
```

LENS_LINES.system (L3):

```
Look hardest at the change as a whole, as a senior engineer who will run it in production.
Follow each main flow of the change from its entry point to its effect.
Check each way that the code starts and each place where it runs, not only the default.
Check the change at scale: large inputs, many calls, and slow or failed dependencies.
Check the rollout: existing data, older clients, a partial deploy, a restart, and a rollback.
Report other problems too.
```

- L2 adds about 17 lines. A longer prompt can cost recall (architecture-bugs.md section 8). The `kind local` row and the probe check watch it.
- The eval profile has no MCP server, so the codegraph lines are inert in the eval. Only Grep and Read run there.

### 4.7 The control: runs3

- Definition: the same pass loop, merge, dedupe, verify group line, and caps as lenses3, with lens null in every pass. The three passes get byte-identical prompts. Only lens text and ARCHITECTURE_VERIFY differ from lenses3.
- runs3 does not exist in code today (section 3). Item 6 of review-quality-2026.md is designed and not built.
- This file replaces the mechanics of item 6. The order files (./context/order.md) and the merge agent are not built. Item 6 keeps its hypothesis, its zero-cost gate, and "never the default". The merge agent becomes the WP-L3 fallback.
- Reason: runs3 differs from lenses3 only in the lens text and ARCHITECTURE_VERIFY. So the direct runs3 against lenses3 interval measures "diversity beats repeats". runs3 is not "one difference from the normal review". It also adds the pass loop, the merge, and the shared verify phase.
- runs3 gets no architecture verify lines (decided by the user on 2026-11-21, question 3).

### 4.8 Variant off: no change

- The prompts of rl-main, rl-reviewer, rl-verify, rl-verifier, and salvage keep their bytes. So do the review `--json-schema`, the stdin of buildPrompt, and the candidates.md text.
- Event IDs stay untagged. payload_json has no `pass` key. A default review makes one finder call and one verify call.
- REVIEW_PROMPT_VERSION, PROFILES_VERSION, MODULE_IDS, and the profileRevision of every profile without these variants stay the same. Stored baselines stay valid (ab.ts reuseRefusal).
- With a variant on, prompt_version reads "<version>+lenses3" or "<version>+runs3". No version is raised, because the default bytes do not change (review-v3.md section 2).

### 4.9 Events, usage, and coverage lines

- With two or more passes, pass k tags each event ID and parent with `pass<k>:` (run-log.ts `passEvent(k)`). Its seq values come after every earlier event. Pass 1 is tagged too, and a one-pass run stays untagged.
- `salvagePhase` gets an optional event prefix, empty by default. A salvage in pass 2 then writes `pass2:salvage:...`.
- Each pass starts with a mark event: tool "Pass", ID `pass<k>:start`, note "Pass k of n: label." The run log needs no UI change, because eventPhase reads it as find.
- Labels: failure "failure paths", contract "contracts and callers", system "the whole change", runs3 "repeat".
- The find phase runs from the start of pass 1 to the end of the last pass. Its usage is `addUsage` over the passes and their salvages. settle sums it with the check phase. The eval reads cost and minutes with no change.
- `noted()`, `unreadAlways`, and `partNotes` read the merged events. A skill or part read in any pass counts.

## 5. Eval and gate

### 5.1 Order

1. WP-AR1 merges. WP-L0, WP-L1, and WP-L2 build in that order. They are file-disjoint, and one implementer runs at a time.
2. Prerequisite: the eval prints the paired grounded noise delta and the paired judge fp delta (review-ledger.md section 1). The "noise" docs are on main (484a4e5). The compare noise block is being built on the branch "compare-noise" and is not yet on main. This file does not design it.
3. U-SG1, the 2.9 bump, and SG-A (seeded-truth.md section 9).
4. Pilot P-L.
5. G-L0, zero cost.
6. G-L1 (runs3, conditional) and G-L2 (lenses3).
7. Decision, then WP-LS (ship) or WP-L3 (merge agent) when a rule says so.

### 5.2 Pilot P-L (mechanism only, never tunes lens text)

P-L1, seeded pilot hosts, lenses3, repeat 1:

```
REVIEW_LOOP_EVAL_LOCAL=eval-seeds/set bun run eval -- --set local --cases <two pilot IDs from the build> --variants lenses3 --repeat 1 --real --out eval-results/seeded/lenses3-pilot
REVIEW_LOOP_EVAL_LOCAL=eval-seeds/set bun run eval:label -- eval-results/seeded/lenses3-pilot --real
bun run eval:seed -- leaks <pilot result.json>
```

- Pass when all of these hold:
  - Both runs finish.
  - Each run has 3 finder calls in `<result>.calls/`, plus any salvage calls, then 1 verify call.
  - The events carry `pass1:` to `pass3:`.
  - Leaks are 0.
  - The cost factor against SG-A (or SG-P) on the same hosts is at most 3.2.
- Record the candidate count, "checks X of Y candidates", the verify turns, and `dupShown`.
- Estimate: $7-24.

P-L2, probe set narrowing check, shipped profile and lenses3, repeat 1:

```
bun run eval -- --set probe --repeat 1 --real --out eval-results/lenses3/probe-base
bun run eval -- --set probe --variants lenses3 --repeat 1 --real --out eval-results/lenses3/probe-lenses3
bun run eval:compare -- <probe-base result.json> <probe-lenses3 result.json>
```

- Pass: lenses3 probe recall is at least the base minus 1 must-find. Trap rate is not higher, and notCompleted is 0.
- The probe set sits near its ceiling, so a drop there shows narrowing.
- Estimate: 26 cases (21 when this estimate was made) at about $0.35 each (E6, before the advisor), so $7 plus $18-22.

Pilot total: about $32-53 (estimate). A failed pilot stops the gate. Fix the mechanics, not the lens text.

### 5.3 Zero-cost gate G-L0

- Read the union rows of SG-A (compare.ts prints `unionRecall` per side). Δu = unionRecall(3) − unionRecall(1) in seeds.
- Run runs3 (G-L1) only when Δu is more than S_R of SG-A. Below that, runs3 cannot pass "better".
- When G-L0 fails, runs3 does not run (question 4). Ask the user before G-L2. Then compare lenses3 with the SG-A union(3) number, as information only.
- Result (2026-11-23): G-L0 failed on SG-A. Δu is 3 seeds (9.1 points): unionRecall(1) 90.9%, unionRecall(3) 100%. That is not more than S_R of 4 seeds (12.1 points). So runs3 does not run.
- SG-A also shows that the seeded set has no recall headroom: 90.9% mean recall leaves at most 3 seeds of gain, less than S_R (seeded-truth.md section 9 SG-A result). So G-L2 cannot pass "better" on this set either. The lenses3 seeded run is held. Pending the user's decision of 2026-11-23, lenses3 waits for a new prompt 2.9 baseline on the natural local set.
- Result (2026-11-25, docs/eval/results.md): lenses3 ran on a fixed 10-case natural subset against baseline r6. Grounded recall rose from 35.7% to 42.9% (not significant). Grounded noise rose from 1.25 to 2.70, and judge fp from 0.30 to 0.50, so the noise rule fails. Cost is 4.8x. lenses3 does not ship and stays opt-in.

### 5.4 Candidate runs

```
bun run eval:ab -- --seeded --baseline eval-results/seeded/baseline --candidate-variants runs3 --candidate-repeat 2 --review-only --results eval-results/seeded/runs3
bun run eval:ab -- --seeded --baseline eval-results/seeded/baseline --candidate-variants lenses3 --candidate-repeat 2 --review-only --results eval-results/seeded/lenses3
REVIEW_LOOP_EVAL_LOCAL=eval-seeds/set bun run eval:label -- eval-results/seeded/lenses3/review-candidate --real
REVIEW_LOOP_EVAL_LOCAL=eval-seeds/set bun run eval:label -- eval-results/seeded/runs3/review-candidate --real
bun run eval:seed -- leaks <each candidate result.json>
bun run eval:compare -- <runs3 candidate result.json> <lenses3 candidate result.json>
```

- `--candidate-replay` refuses both variants, because they change the finder.
- Both candidates record their calls. A later verify-only variant can replay them.

### 5.5 Ship rules (seeded set, seeded-truth.md 6.5 and review-quality-2026.md section 2)

Each candidate against SG-A:

- Recall: mean seeded recall of B minus mean of A is more than S_R of SG-A. The paired 90% interval of the seeded must-finds also excludes 0.
- Trap rate: at most mean(A) plus S_T.
- Noise: the paired grounded noise delta per case is at most 10% of mean(A). The paired judge fp delta per case run is at most 0.07. The compare also prints the judge-tp part, the judge-fp part, and `dupShown` of the grounded noise delta.
- Audit rule (question 1, decided by the user on 2026-11-21): a blind user audit decides noise when only the judge-tp part breaks the limit. The sample is 20 judge-tp items that the candidate adds. Noise passes when at least 60% of them are real bugs (12 of 20).
- Audit details, not decided by the user: the draw uses seed 2026 (`BOOTSTRAP.seed` of score.ts). With fewer than 20 items, the user audits all. The user sees no judge label and no variant name.
- Extras matched per case run: not below mean(A) minus its spread.
- notCompleted per repeat: not higher than mean(A). Report incomplete runs and their failed-pass lines apart.
- Leaks: 0.
- Cost per case run and minutes per case run: report both factors against A. The user decides.

Then:

- lenses3 against runs3: "diversity beats repeats" only when the compare interval of lenses3 minus runs3 excludes 0. Otherwise (a tie), lenses3 ships only when its cost per case run is less than 10% above runs3. Else the cheaper one ships. The candidate that ships must pass "better" against SG-A, or neither ships (decision 8, question 5). The architecture benefit of L2 is a preference, not evidence.
- Information only: the `kind` rows, with `kind local` as the narrowing control, and the `pass k` rows and `dupShown` of WP-L2.
- L3 drops only after a two-lens run passes against SG-A, never on the `pass 3` rows alone (question 6).
- A winner ships as an option, never as the default (item 6). WP-LS designs the per-run toggle.
- When a candidate passes recall and fails only noise, and `dupShown` holds most of the noise delta, plan WP-L3 and ask the user.

### 5.6 Power and cost (estimates)

- Power: the seeded MDE is 14.8 to 16.5 points at R_A 3 and R_B 2 (seeded-truth.md 4.3). The natural union gain from k=1 to k=3 was 9.7 points. A real +10-point gain passes with about 44-52% chance, and a +15-point gain with about 73-81%.
- The direct lenses3 against runs3 test needs 16 to 18 points (seeded-truth.md:119). Expect its interval to include 0, so decision 8 applies.
- Cost factor 2.4 to 3.0: three finder passes, plus a verify phase about 1.5 to 2 times larger. The finder and verify cost split is not measured. Minutes factor 2.5 to 3, because the passes run in sequence.

| Step | Runs | Estimate at C1b prices (S about $30 per repeat) |
|---|---|---|
| WP-L1, WP-L2 tests | fake CLI | $0 |
| P-L1 | 2 hosts x 1 | $7-24 |
| P-L2 | 26 probe cases x 1, both sides | $25-29 (estimate for 21 cases) |
| G-L0 | SG-A union rows | $0 |
| G-L1 runs3 | 23 x 2, labels | $150-190 |
| G-L2 lenses3 | 23 x 2, labels | $150-190 |
| Total | both candidates | about $330-430; lenses3 only, about $180-245 |

## 6. Work packages (run order, file-disjoint)

### WP-L0. Docs (implementer)

- Files: docs/plans/review-v2/review-quality-2026.md (item 6 points here; runs3 mechanics replaced; WP-R3 becomes WP-L1), review-ledger.md (rows "runs3" and "lenses3": designed), seeded-truth.md 4.4 (runs3 factor as lenses3), and the CLAUDE.md status line.
- Tests: none. Risk: none.

### WP-L1. Passes in the app (implementer-xhigh, after WP-AR1 merges)

- Files and symbols:
  - src/shared/dto.ts `VARIANTS`.
  - src/shared/run-log.ts `passEvent`.
  - src/shared/review.ts `AnchoredFinding.pass`.
  - src/server/review/catalog.ts `Lens`, `LENS_LINES`, `passLenses`, `focus`, `mainAgent` (third parameter `lens = null`), `reviewerAgent` (fourth parameter `lens = null`), and `verifyRules` (ARCHITECTURE_VERIFY under lenses3).
  - src/server/review/judge.ts `mergeFound`.
  - src/server/review/jobs.ts `steps` (pass loop, state machine of 4.3, salvage-notes deletion, usage sum, cancel usage), `salvagePhase` (event prefix), and `verifyPhase` (group flag).
  - Tests: tests/review/prompt.test.ts, tests/review/jobs.test.ts, tests/review/passes.test.ts (new).
- Behavior change: `--variants lenses3` or `runs3` runs three passes and one verify phase. Without them, nothing changes.
- Tests:
  - The default snapshot hashes of all five prompts, the review schema, and the stdin stay the same.
  - A default fake-CLI review makes 1 finder call, has untagged events, and has no `pass` in payloads.
  - lenses3: 3 finder calls, then 1 verify call. The recorded agent prompt of pass k holds LENS_LINES[k] after the finder rules, in rl-main and rl-reviewer. Salvage has none.
  - L2 holds CALLERS_LINES and then ARCHITECTURE_LINES. Stacked with "callers", each line appears once.
  - Passes 2 and 3 have no questions line in stdin and no ANSWERED_RULES. Reply drafts come only from pass 1.
  - runs3: 3 finder calls with byte-identical agent prompts, and no ARCHITECTURE_VERIFY.
  - The merge (fake-CLI `seq.review` with three outputs): candidates.md holds the union in pass order. Two passes at overlapping lines share a group. A duplicate verdict hides one copy. payload_json holds `pass`, and candidates.md does not show it.
  - With more than 12 candidates, the verify prompt holds VERIFY2.group.
  - One table-driven test per row of 4.3: salvage per pass, a salvage failure, usage_limit then skipped, a schema failure, a failed pass 1 with good passes 2 and 3, all passes failed, and cancel in pass 2 with the usage sum.
  - salvage-notes.md is gone before pass 3 starts.
  - promptVersion ends in "+lenses3" or "+runs3".
- Control mutations:
  - Put the L1 lines on the null lens: the default snapshot fails.
  - Take `answered` from every pass: the reply-draft test fails.
  - Skip the salvage-notes deletion: the independence test fails.
  - Tag the events of a one-pass run: the default event test fails.
- Acceptance: `bun run check` is green, and the existing jobs tests pass with no edit. A worktree run prints where it imported the code from.
- Risk: jobs.ts `steps` is long, shared code. Keep the one-pass path as it is, and wrap the finder call in a local function that both paths use.

### WP-L2. Eval diagnostics (implementer, after WP-L1)

- Files and symbols: scripts/eval/run.ts (EvalItem `pass` from the payload, next to `agent`, run.ts:447); scripts/eval/score.ts (`slices`: rows `pass <k>` with the seeds that pass k raised and the seeds that only pass k raised; metric `dupShown`: shown items with at least one gold match whose matches are all claimed, per case run); scripts/eval/compare.ts (labels); tests/eval/score.test.ts, harness.test.ts; docs/eval/local.md (the commands of section 5).
- Tests: a hand-built case with one seed raised by passes 1 and 3 gives "pass 1: 1, only pass 1: 0". A second shown copy of a claimed seed gives `dupShown` 1. A file without `pass` prints "-".
- Control mutation: count hidden items in `dupShown`, and its test fails.
- Question 1 adds: the compare noise block prints the judge-tp and judge-fp parts of the paired grounded noise delta. The draw of the audit sample (section 5.5) has no design yet.
- Acceptance: `bun run check` is green. No file under src/ changes.

### P-L, G-L0, G-L1, G-L2 (user and orchestrator)

- As in section 5.

### WP-L3. Merge agent (implementer-xhigh, conditional)

- Runs only on the 5.5 trigger. It reuses the merge prompt and app rules of item 6. It needs its own short design, because a merge call cannot replay from a recording (run.ts callKind).

### WP-LS. Ship (conditional)

- Only after a pass. A per-run "Deep check" switch, off by default (decided by the user on 2026-11-21, question 7). It needs its own design with UI, screenshots, README, and CHANGELOG.

## 7. Invariants and evidence

| Invariant | Evidence |
|---|---|
| One runner runs one process. | claude.ts:765-772 |
| A run end deletes its per-cwd session folders. | claude.ts:401-409, :971 |
| Salvage and verify run in sequence in one workspace, run row, and slot. | jobs.ts:1345-1347, :1420 |
| Phase events take an ID prefix and a seq offset. | jobs.ts:1384-1389, :1472-1477 |
| Each ID without "check:" is phase find. | run-log.ts:52; web/review/model.ts:90-92; run.ts:397-416 |
| Overlap groups need the same path, the same side, and overlapping lines. | validate.ts:334-358; judge.ts:354 |
| A duplicate counts only inside one group, and it hides. | judge.ts:437-454, :472-476 |
| Only verify2 keeps a group in one rl-verifier call today. | catalog.ts:1442; jobs.ts:1495 |
| candidates.md caps at 200 KB and MAX_FINDINGS blocks. | context-files.ts:75-76, :81-91; review.ts:12 |
| A reply draft carries no finding index. | validate.ts:520-556 |
| Only app lines make a run incomplete. | judge.ts:222-226; score.ts:193-194 |
| A variant list changes promptVersion and profileRevision only when not empty. | catalog.ts:241, :245 |
| A finder variant cannot be replayed. Calls record in start order. | run.ts:288-329, :659-688 |
| Each Claude process gets the run time limit. | jobs.ts:476-480; task.ts:88-92 |
| A shown second copy of a claimed gold item is noise. | score.ts:257-265 |
| The salvage prompt looks for no new problems. | catalog.ts:1634-1651 |
| Finder variant lines follow the finder rules in rl-main and rl-reviewer. | catalog.ts:965-985, :1398-1422 |

## 8. Risks

1. The noise rule binds. Three passes add true findings outside the seeds, and the same bug at two anchors. Both count as grounded noise. `dupShown` separates the two parts, and WP-L3 is the fallback.
2. Power: about one chance in two at +10 points. An inconclusive result is likely.
3. Cost about 2.4 to 3.0 times, and minutes about 2.5 to 3 times. Usage limits come sooner. The stop rule limits waste.
4. Narrowing: a lens can cost the local kind. Guards: "Report other problems too.", the full base prompt in each pass, P-L2, and the `kind local` row.
5. Prompt length: L2 adds about 17 lines.
6. Verifier capacity: more than 12 candidates splits the check. About 30 candidates reach the turn cap. More than 100 blocks or 200 KB leaves candidates unchecked, and the run is incomplete.
7. Seed tuning: lens text that echoes seed patterns inflates the gain. Section 4.6 sets the text rule and freezes it.
8. Repeated finder questions: questions get no duplicate verdict (catalog.ts:1455). Watch `finderQuestions.kept`.
9. Run time: worst case is three times the "Review run time" setting, plus salvage and verify.
10. Dependencies: the noise-delta print is not on main. WP-AR1 is on main (bb1afd0).

## 9. Not adopted

| Idea | Reason |
|---|---|
| Parallel passes in one cwd | One runner per process; the run end deletes the shared session folders; replay needs the call order; the pool size. |
| Parallel passes in three worktrees | Three snapshots and three runners for one PR break the pool's one-run-per-PR rule. Time is the only gain. Not before a ship (question 2). |
| Merge before `judge()` | One bad pass would fail the run, and the answered indices would need remapping. A merge at the Found level keeps each pass's checks. |
| App-side fuzzy dedupe across anchors | A heuristic. The verifier and the overlap groups are the decided route. |
| A lens that replaces REVIEW_LENS or the do-not-flag list | It narrows (section 4), and an edit changes profileRevision. |
| A per-pass dollar or turn cap below the profile | No cap exists, and none is measured. A cut pass loses findings to salvage. |
| Lower effort or another model for passes 2 and 3 | It confounds the lens test. "runs3-mixed" stays a separate idea. |
| Lens passes in re-reviews | Three `earlier` verdict lists conflict. |
| Order files and a merge agent in runs3 | They add another difference between runs3 and lenses3 (4.7). |

## 10. Unverified

- UL1: the cost factor 2.4 to 3.0 and the minutes factor. The finder and verify cost split is not measured.
- UL2: the advisor cost per case run (seeded-truth U2).
- UL3: the CLI keeps no per-cwd state outside the two folders that the run end deletes.
- UL4: the verify turns with 30 or more candidates under split.
- UL5: the grounded noise of SG-A per case, so the absolute 10% limit.
- UL6: the lens effect on seeds. The natural union gain is the only reference.
- UL7: resolved. The WP-AR1 names `architecture`, `ARCHITECTURE_LINES`, and `ARCHITECTURE_VERIFY` are on main (bb1afd0).
- UL8: the compare noise block is being built on the branch "compare-noise" and is not yet on main. The "noise" docs are on main (484a4e5).
- UL9: the probe cost per case at the current prompt and advisor.
- UL10: the original lens text of the recall plan. This text is new.

## 11. Questions and decisions

1. With union passes, the 10% grounded noise limit counts true findings outside the seeds. Keep it for lenses3 and runs3? Decided by the user on 2026-11-21: keep the 10% limit, and print the judge-tp and judge-fp parts. If only the judge-tp part fails, the blind audit of section 5.5 decides. It takes 20 items and passes at 60% real bugs.
2. Run passes in parallel in separate worktrees to cut minutes? Decided by the user on 2026-11-21: no parallel passes until something ships. For the variant "twice" only, thorough-review.md replaces this decision (user, 2026-11-25).
3. Redefine runs3 as three identical passes with no order files and no merge agent? Decided by the user on 2026-11-21: keep the design. It is the control. runs3 differs from lenses3 in the lens text and ARCHITECTURE_VERIFY (section 4.7). It is not "one difference from the normal review". runs3 gets no architecture verify lines.
4. Run runs3 when G-L0 fails? Decided by the user on 2026-11-21: no. Compare lenses3 with the SG-A union(3) number for information only.
5. When the direct interval includes 0, which one ships? Decided by the user on 2026-11-21: lenses3 ships only when its cost is less than 10% above runs3. The architecture benefit is a preference, not evidence.
6. Does L3 stay if its `pass 3` row adds no seed that only it finds? Decided by the user on 2026-11-21: drop L3 only after a two-lens run passes against SG-A. The `pass 3` rows alone never drop it.
7. How does a winner ship? Decided by the user on 2026-11-21: a per-run "Deep check" switch, off by default.

## 12. Build notes (WP-L0 to WP-L2)

- The code follows sections 4 and 6. The facts below fill the places that the design leaves open.
- A failed or skipped pass adds its gap line to coverage skipped and to the gaps. The run is then incomplete. A salvaged pass adds its turn-cap line to notChecked, as a one-pass salvage does.
- Row 11: the run ends with the ending of pass 1, but its usage is the sum of all passes.
- A cancel in the verify phase also keeps the usage of all passes.
- A salvage that fails with a usage limit does not stop the later passes. Row 10 gives it kind max_turns.
- Each pass outcome starts with its mark event, so a salvage run of pass k tags its events after the events of pass k.
- The "Deep check" switch (question 7) belongs to WP-LS. It is not built.
- The integration tests are in tests/review/passes.test.ts, not in jobs.test.ts. The existing jobs tests have no edit.
- WP-L2: the pass rows are slice rows "pass k" and "only pass k" of the counted must-finds. `eval:compare` also prints them side by side, with "-" for a file without passes. `dupShown` is a metric row. It needs eval:label labels.
- The noise block prints the paired deltas per case of the judge tp part, the judge fp part, and dupShown. The draw of the audit sample (section 5.5) is not built.
- The L3 line "not only the default" holds the word "only". It narrows nothing, so the text stays as frozen in section 4.6.
