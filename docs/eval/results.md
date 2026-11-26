# Eval results

Aggregate numbers only. The local set holds company code, so no case names, paths, or finding text go here.

## 2026-10-31: U-V1 (eval:ab on the local set)

- Local set: 16 cases, 40 must-find (26 counted at balanced), 0 must-not-raise. Effort medium, repeat 1, verifier on. Baseline (prompt 2.3): recall 30.8% (8/26), precision 34.8%, noise 0.94 per case, $29.6, 71 min.
- Candidate signal+order+rules2+failures: recall 11.5% (3/26), precision 37.5%, noise 0.31, $25.9, 53 min. Without signal: recall 26.9% (7/26), precision 25.0%, noise 1.50, $34.1, 71 min. Decision: keep 2.3, and no variant ships.
- Re-review set: 6 cases with 1 must-find. The baseline found it. Both candidates with rereview-strict missed it. The set is too small for a decision.
- Weak spot: the 4 cases with rl-reviewer (three heads of one 56-59-file PR, plus one 24-file PR) found 2 of 9 counted bugs at 15% precision and used 71% of the cost. The other 12 cases: recall 35%, precision 60%.
- Precision is a lower bound. The set has no must-not-raise items, so an unmatched finding counts as noise, also when it is a real bug.

## 2026-11-01: U-V4 step 1 (variant parts, `--large`, 4 cases)

- Mechanism: pass. Each part got an rl-reviewer call that read it, and the finder opened the file of each counted bug (bug opened 100%).
- Result: recall 22.2% (2/9) for A and B. Precision 15.4% (A) and 6.7% (B). Unmatched findings 2.75 (A) and 7.0 (B) per case. Cost $5.2 (A) and $12.2 (B) per case.
- Analysis of the stored results: no run in any variant raised a finding within 20 lines of 6 of the 7 missed items. Nothing was hidden or refuted near them. Tolerance 10, tolerance 20, and file-level matching give the same recall.
- Cause: each must-find item is a finding of one earlier app run that the user posted. Runs on a 6,000-line PR raise different subsets, so recall on the large cases measures the overlap between runs, not missed bugs. One item is 11 points of recall.
- The 28 unmatched findings of B all passed the verify step, and most look like plausible minor issues. The set has no must-not-raise items, so precision cannot tell real issues from noise.
- Decision: parts stays opt-in and does not ship. Wave 5 stops. The next step is better ground truth for the local set, not another variant.

## 2026-11-15: item 5 (fold refuted findings, zero cost)

- Run: `eval:rescore --fold-refuted` on the W1 baseline. No new review runs.
- No must-find left the main list. Noise per case run 2.15 to 1.73. Judge false positives 0.43 to 0.25. Augmented precision 83.4% to 88.4%.
- Decision: the ship rule passed, and the user approved it. The fold shipped on 2026-11-15 (review-quality-2026.md item 5).

## 2026-11-16: W2 (review-quality-2026.md items 1, 2, and 4)

- Baseline: W1, the shipped profile at effort high (rl-main and rl-reviewer high, verifier medium), 42 cases. Ship rules: section 2 of docs/plans/review-v2/review-quality-2026.md.
- verify2 replay (item 4): false findings kept in the main list went from 14 to 17. The rule needs a drop, so it failed. verify2 stays opt-in.
- C1 (items 1 and 2 together: effort medium and no rl-reviewer): it passed "not worse, on all cases" only at the boundary, and it halved the recall on the large cases. So the next runs split the two items.
- C1a (item 1 alone: reviewer mode off at effort high, 12 large cases, repeat 2): 1 and 1 of 24 bugs against 5 and 3 for the baseline. It failed. The reviewer mode stays "auto".
- C1b (item 2 alone: effort medium for rl-main and rl-reviewer, 42 cases, repeat 2): grounded recall 26.4% (21 and 16 bugs) to 23.6% (17 and 16). Mean 16.5 bugs against the floor 18.5 - S_R 5 = 13.5. Paired delta -2.9 points (90% interval -6.1 to 0.0). Large cases 8/48 to 7/48.
- C1b noise per case run 2.15 to 1.44, judge false positives 0.43 to 0.26, augmented precision 83.4% to 85.7%, severityOk 100%. Cost per case run $2.67 to $1.59, minutes 6.3 to 3.8.
- C1b with the shipped fold of refuted findings (item 5): recall 22.1%, noise 0.99, precision 93.7%.
- Decision: C1b passed "not worse, on all cases". The user approved it on 2026-11-16, and Review now runs at effort medium (PROFILES_VERSION 8).

## 2026-11-17: W3 (review-quality-2026.md item 3, variant "broad")

- Run: C2 (`--candidate-variants broad --candidate-repeat 2 --clean 8`), 42 cases, repeat 2, effort medium, commit 54335bd. Baseline A: the C1b result, reused. Labels from eval:label, numbers from eval:compare.
- Grounded recall 23.6% (17 and 16 bugs) to 24.3% (18 and 16). Paired delta +0.7 points (90% interval -5.8 to +7.1), over 14 PR groups and 70 must-finds. Raised recall, with hidden findings, 26.4% to 29.3%.
- Union recall at k=2: shown 27.1% to 30.0%, raised 30.0% to 37.1%.
- Grounded precision 100% in both. Grounded noise per case 1.44 to 1.33. severityOk 100% to 93.5%. Failed runs 0 in both.
- Cost per case $1.59 to $1.96 (+23%), minutes 3.8 to 4.4.
- The coverage-gap row is not comparable. C1b ran before runs were marked incomplete only for gaps of the app.
- Probe set (synthetic, 8 cases, repeat 2, line match, no labels): recall 7/8 to 8/8, paired delta +12.5 points (90% interval 0 to +37.5). Precision 100%, trap rate 0, and noise 0 in both. severityOk 100% to 87.5%. Cost per case $0.16 to $0.15. The comment-thread case has no counted must-find, so the probe does not measure the thread-line rule.
- Decision: "not worse" holds, but "better" fails. "Better" needs a mean of 18 or more bugs and a paired 90% interval that excludes zero. The mean is 17, and the interval includes zero. "broad" does not ship and stays opt-in. C1b stays the baseline, and REVIEW_PROMPT_VERSION does not change.

## 2026-11-20: Joint Gate A (prompt 2.8, PROFILES_VERSION 9)

- Baseline: the shipped profile of prompt 2.8 at PROFILES_VERSION 9, recorded on 2026-11-20. Ship rules: section 2 of docs/plans/review-v2/review-quality-2026.md, with the noise rule of 2026-11-21.
- "preexisting" (full run): noise +0.10 per case against the limit 0.127 (10% of mean(A)). Judge fp -0.04 per case run. Recall 17.5 to 18.5 bugs. Cost per case -2%. It passed the noise rule.
- Risk check, Gate RC-A (verify-only replay of the Gate A recording, 50 case runs per repeat, 2 repeats): only rule 4 (question items) failed. Under the fallback (cascade step 2: the asked risk questions drop), all five rules pass. Recall +1.3 points. Noise +0.06 per case (limit 0.08). Judge fp +0.03 per case run (limit 0.05). Question items 27 against 27 per 100 case runs. Cost per case +11.8%. Step 1 of the cascade alone is not measured (docs/plans/review-v2/risk-check.md section 7).
- "obligations": not measured on current code, because its fix commit is not in the run commit. The user decided on 2026-11-21 not to re-measure it before prompt 2.9.
- Decision: the user approved both on 2026-11-21. Prompt 2.9 ships "preexisting" and the risk check (cascade step 2) as the default. Prompt 2.9 voids this baseline for new candidates. The next baseline is SG-A on the seeded set.

## 2026-11-21: VR-0 and VR-A (variant "refute-issue")

- VR-0 (zero cost, on the Gate A baseline against the Gate A control replay, 50 cases x 2 repeats, 78 counted must-finds per repeat): go, narrowly. The verifier hides no must-find. 2.5 must-finds per repeat go to the fold as refuted. Headroom: 3.2 points of shown recall.
- VR-A (verify-only replay, 100 case runs against the Gate A control replay, 0 failed runs): recall rule pass at the floor. Must-finds demoted 2.5 to 1.5 per repeat. Grounded recall 21.8% to 23.1% (paired interval +0.0 to +2.7 points).
- Noise rule: grounded noise 1.29 to 1.39 per case, paired delta +0.10 against the limit 0.08: fail. Judge fp 0.08 to 0.09 per case run (limit 0.05): pass. The judge is not calibrated on this set, so the truth of the extra findings is not verified.
- severityOk 89.7% to 93.8%: pass. Failed runs 0 to 0. Incomplete runs 1 to 2: fail by the letter (an MCP server did not start). Cost per case $2.500 to $2.484 (-0.6%): pass.
- Decision: "refute-issue" does not ship and stays opt-in (docs/plans/review-v2/verifier-rule.md section 6). The seeded set can measure it later.

## 2026-11-21: MF-A probe (variant "minor-fold")

- Only the probe step ran: two synthetic probe cases, one polish bug each.
- Rule 1 (judge calibration gives tp to both polish bugs): fail. The judge gives fp to one of the two bugs ("not a merge blocker").
- Rule 2 (polish recall at least 75%): 100%, pass. Rule 3 (polish traps 0): 0, pass. Rule 4 (probe recall and trap rate not below the control): recall 87.5% to 91.7%, trap rate 0 on both sides, pass.
- Decision: rule 1 fails, so the gate stops at the probe. The user paused minor-fold on 2026-11-21. It stays opt-in, and no local-set run follows (docs/plans/review-v2/minor-fold.md section 6.7).

## 2026-11-21 to 2026-11-22: U-SG1 (seeding of the seeded set)

- Runs: four seeding rounds and one validate step of 9 seeds. Total cost about $57.
- Rounds 1 to 3 and the 9-seed validate: $41.67 (docs/plans/review-v2/seeded-truth.md section 9). Round 4: $15.52 (security propose $1.30, propose $9.16, validate $5.06).
- Review: an AI review (xhigh with an advisor) checked every confirmed seed one by one under the middle rule (seeded-truth.md section 14 row 24).
- The built set: 16 cases, 33 seeds, fingerprint 756c4e2f53e3. Spares: 11. Security seeds: 0. Kinds under the floor of 4: omission, leak, security, architecture.
- The set is under the floor of 48 seeds. SG-A measures its fitness (MDE at most 18 points).

## 2026-11-22: SG-P (seeded set pilot)

- Run: 2 cases of the built set, repeat 1, then labels and the leaks check.
- 2 of 2 runs finished. Seeds found: 2 of 2. Leaks: 0. Judge calibration on seeds: 2 of 2. Cost $1.51.
- Decision: SG-P passed. The pilot is never a baseline.

## 2026-11-23: SG-A (seeded baseline, prompt 2.9)

- Run: the default profile, prompt 2.9, the seeded set of 16 cases and 33 seeds, repeat 3, then labels and the leaks check.
- Runs: 48 of 48 finished. 1 run is incomplete (coverage gaps). 0 runs failed.
- Cost: $100.30 for the runs plus $2.11 for labels. One case run costs $2.089 and takes 4.2 min.
- Leaks: 0 of 137 findings.
- Recall: 90.9% per run (30, 28, and 32 of 33 seeds). unionRecall(2) 98.0%, unionRecall(3) 100%.
- Seed hits: 26 seeds found 3 of 3 times, 5 found 2 of 3, 2 found 1 of 3, and 0 never found. The measured mean p(1-p) is 0.047. The plan assumed 0.23.
- Recall by kind: architecture 3/3, concurrency 12/12, contract 18/18, entry 11/12, error 11/12, leak 3/3, lifetime 8/9, local 23/27, omission 1/3.
- Noise: grounded noise 0.54 per case (large cases 1.25, small cases 0.31). Judge fp 0.00 per case run. Unlabeled items 0. Question items 0.13 to 0.19 per case run.
- S_R: 4 seeds (12.1 points), as eval:compare prints it.
- Fitness: the MDE is about 9 to 11 points by the formula of seeded-truth.md section 4.3 with the measured hit rates. It passes the bar of 18 points.
- G-L0 (focused-passes.md section 5.3): Δu is 3 seeds (9.1 points). That is not more than S_R (4 seeds), so G-L0 fails and runs3 does not run.
- Ceiling: the mean recall of 90.9% leaves at most 3 seeds of gain. That is less than S_R, so no recall raiser can pass the "better" rule on this set. The set is a noise and regression guard only.
- Why the seeds are easy (free checks): line match and the matcher agree on 90 of 99 seed results, and the matcher was right on all 9 disagreements. About 8 of 33 seeds fail a test that the PR itself adds or changes. 3 seeds sit in test code. The natural known issues on the same cases (25 extras) were found in 11 of 75 runs by the matcher (14.7%, 25 issues x 3 runs), against 91% for seeds. The earlier figure of 8 of 75 was a line match with one false hit.
- Decision: pending with the user (2026-11-23). The proposal: stop seeding for recall, and keep the seeded set as a guard for noise, regressions, and verify-only candidates such as obligations. Measure the recall raisers (lenses3, callers, codegraph) on the natural local set against a new prompt 2.9 baseline. The seeded runs of callers+codegraph and lenses3 are held.
- Superseded on 2026-11-24 for codegraph: CodeGraph stays opt-in, and no full run of it is planned. See the 2026-11-24 pilot subsection.

### SG-A natural-issue analysis (2026-11-23, free, from stored records)

- Known issues: 25, all inside changed lines. Classes by the judgment of one agent (medium confidence): 15 real bugs that the diff shows (class a, the duplicate gold pair counted once), 8 nits, simplifications, test gaps, or docs, 1 not findable from the snapshot (it depends on another PR), and 1 duplicate gold pair.
- Missed class (a) issues: 12. The finder never raised 10 of them in any run (33 of 36 runs never raised the 12). It raised 1 and folded it as "unsure". Verify and the judge refuted 0. So the loss is in the finder, not in verify, the matcher, or the fold.
- Kinds of the 12: 5 logic inside one function, 5 need a caller or another file, 2 concurrency or resource, 0 architecture, 0 security.
- Re-roll floor: Gate A (prompt 2.8, 2 runs per case) found 1 of the 10 never-found issues in 1 of 20 runs. 9 of the 10 were missed in all 5 runs.
- Natural recall per run (matcher): SG-A 14.7% (11 of 75), unionRecall(3) 20.0%. Gate A on the same issues: 20.0% per run. The drop mixes prompt 2.9 and the seeds, and the sample is small.
- Full natural set (Joint Gate A): 78 must-finds, matcher recall 22.4% per run, unionRecall(2) 29.5%. About 75% are class (a), by a sample of 20 (a guess).
- A full natural-set gate costs about $830 to $1,150 and has about 27% power at +3 bugs. The pilot below replaced the proposed screen.

### 2026-11-23: pilot P-LC (lenses3,codegraph) and the never-found issues

- Pilot P-LC: 2 seeded cases that hold 4 of the 10 never-found issues, repeat 1, prompt 2.9. Cost $16.15 ($15.91 eval, $0.24 labels).
- Cost factor against SG-A on the same cases: 4.25x (3.8x and 5.7x). Time factor: 3.7x. The P-L1 cost limit is 3.2x, so the pilot fails on cost.
- Seeds found: 4 of 4, the same as SG-A. Never-found issues raised: 0 of 4. This is weak evidence: at the old hit rate, 0 of 4 is likely with no change.
- Shown findings: 3.0 per case run, against 2.0 in SG-A. The extras were judged 1 tp and 1 fp. lenses3 ran 3 passes.
- codegraph was not tested. The runs made 3 successful explore calls in 298 tool calls. 1 call failed with "No such tool" on the bare tool name. review-ledger.md records this usage problem in the codegraph row.
- The screen on 7 cases (about $79 to $118) does not run.
- Coverage: in 34 of 34 issue-runs (30 SG-A, 4 pilot), a tool result held the issue hunk. 27 read the whole file. 0 hit a cap. So the misses are judgment, not coverage. A coverage pass, a diff order change, or a cap raise will not help.
- Origin: all 10 come from findings that the app raised and the user posted (prompts 2.3 to 2.8, Opus at medium effort). For each issue, exactly 1 app run produced a finding in that file. The PRs had 1 to 9 runs.
- Every posting run had the user's per-PR note. The eval stores an empty note (scripts/eval/run.ts:797). In 3 of 10, the note names the issue file. So these 10 are rare one-off finds, partly helped by the note. They are weak gold for a recall gate.
- Superseded on 2026-11-24: at least part of these misses is stale gold from carry; see the 2026-11-24 subsection.
- Position: never-found issues sit later in the diff (median 0.85 of files) than found seeds (0.63). The permutation p is about 0.045, but the items are not independent, so the evidence is weak.
- Decision (2026-11-23): option 2 stands. The seeded set is a guard. No paid recall gate runs now.
- Open ideas, not approved: (a) eval fidelity: carry the PR note into the local set, so the eval matches the app. (b) An "oracle look" script (about $3 to $7) gives a fresh run only the file and hunk of each issue. It tests whether focused attention finds them. (c) Fix the codegraph tool-name problem before any codegraph measurement.
- Superseded on 2026-11-24: the tool-name fix landed on 2026-11-23 (review-ledger.md). CodeGraph stays opt-in, and no full run of it is planned.

### 2026-11-24: oracle look, stale gold from carry, and probe gates SK-P and SM-P

Oracle look (scripts/eval/oracle.ts; not on main yet, it lands with `eval:oracle`):

- Setup: Claude (Opus 5.5, medium) looks at each of the 10 natural issues that no SG-A run found. Two hint levels: the file only, and the file with its lines. Each call repeats 3 times. 10 decoy spots (changed lines with no gold place) test for false claims.
- Run 1 (2026-11-23, $18.17) used the seeded snapshot. Its decoy rule counted any major finding anywhere in the case.
- Run 1 re-scored: decoy false claims 0 of 30. All 20 old "false claims" were seeded bugs found elsewhere. The file level is confounded: seeds took 15 of 30 calls.
- Run 2 (2026-11-24, $20.31) used the natural head without seeds and the fixed decoy rule.
- Run 2, file level: 3 of 10 issues found in at least 1 of 3 calls, 0 in a majority, 3 of 30 calls.
- Run 2, lines level: 3 of 10 issues found 3 of 3 times. The other 7 were never found (9 of 30 calls).
- Run 2, decoys: 0 of 30 calls made a false claim.
- Judged (one agent's analysis, not mechanical): 5 of the 10 issues are absent at the case head. A later commit in the same PR fixed 4. A spec decision settled 1. On these 5, "no defect" is the correct answer.
- So 5 misses are live. Exact lines find 3 of them reliably. 2 stay missed: one design judgment that the model made the other way, and one link across files.
- Reading: exact lines help on 3 of 5 live misses, and they do not make the model invent defects. The file alone helps little. The sample is small, so this is a signal, not a gate.

Stale gold from carry:

- Mechanism: carry() in scripts/eval/local.ts copies a must-find to later heads of the same PR when its anchor lines are unchanged. It does not see fixes in nearby lines or in other files.
- Mechanical: the natural local set holds 26 carried copies from 13 findings.
- Mechanical: in the three arms of Joint Gate A, review runs hit the carried copies in 0 of 138 issue-runs. The same findings score 20.8% per run at their origin head.
- Mechanical: the later case context never holds the posted thread of the origin (0 of 26). So "already posted, so not repeated" does not explain the misses.
- Mechanical: native-only recall in Gate A (must-finds without carriedFrom) is 31.8% on 55 must-finds in the baseline arm. The recorded figure is 22.4% on 78.
- Judged (one agent's reading, not verified): 22 of 26 copies sit on code that is already fixed or settled.
- Judged: live-gold recall for Gate A would be about 31.3% per run (unionRecall(2) 41.1%). For the SG-A natural issues it would be 21.6% per run (recorded 14.7%).
- A fix exists on a local branch: carry makes extras, the builder gets rule 6, and score and compare get a "native recall" row.
- The fix is not pushed. It changes the set fingerprint, so a rebuilt set does not compare with the stored Gate A and SG-A results. The user decides.

Probe gates SK-P and SM-P (synthetic cases, commit e4c2764, about $6 in total):

- SK-P (variant "stack") passes on traps (0 over 9 runs), the "relies" must-find (3 of 3 in both arms), and failed runs (0).
- SK-P cost per case: +1.6% over all cases. On the "relies" case alone it is +27%, because one run cost double. Settled: on 2026-11-24 the user set the 25% cap on the total of the runs, so this run also passes.
- SK-P does not discriminate: the control already passes. The case title leaks the child PR into the task summary of the control (scripts/eval/run.ts, about line 837).
- With the variant, 2 of 3 runs raised an open risk that names the child PR.
- SM-P (variant "submodules") fails on probe-sub-caller: 0 of 3 in both arms. An app bug causes this, not the model.
- In all 3 variant runs, the finder raised the must-find with a gitlink cause and an empty quote. The validator dropped it as "unchanged".
- A fix is built: the judge fills the gitlink quote with "Subproject commit <hash>". A rerun of that case follows after the push.
- probe-sub-signature: control 2 of 3, variant 3 of 3. Without the variant, runs asked 14 questions over 9 runs and cost twice as much.
- Rerun after 2232671: probe-sub-caller with the variant found the must-find in 3 of 3 runs, 0 trap hits. SM-P passes.

### 2026-11-24: Gate SK-P rerun with the sharper probe

Code f7d354c, cases probe-stack-relies, -unreached, -child-fills, and -meaning, repeat 3, control and variant "stack", 24 runs, about $6.50 in total.

- Traps: control 26.7% per trap, all on probe-stack-child-fills (2 of 3 runs flagged the partial line). Stack: 0 over 12 runs.
- Must-finds of probe-stack-relies and probe-stack-meaning: 100% in both arms. probe-stack-meaning does not discriminate: the control found the flip without the parent diff.
- Failed runs: 0 in both arms. One stack run of probe-stack-unreached had a coverage gap (incomplete).
- Cost per case: control $0.281, stack $0.262 (-6.5% total). Per case: relies +8%, unreached +23%, child-fills -19%, meaning -22%. Minutes per case: 1.0 and 0.9.
- Precision: 43.3% and 55.6% (+12.2 points). Noise: 0.33 and 0.42 per case. False positives: 0.67 and 0.42 per case.
- expectMention on probe-stack-child-fills: the control names the child PR in 0 of 3 runs, the stack arm in 2 of 3.
- Verdict: SK-P passes on all clauses. The trap clause now discriminates, because `taskSummary` keeps the child PR out of the control's task summary.

### 2026-11-24: pilot of callers, codegraph, and lenses3 on the natural set

Code a84610d, 2 natural cases, repeat 1, three arms. Total cost $16.12.

- codegraph: 2 of 2 runs complete. The MCP server started in both runs. 4 of 9 must-finds shown. Cost against the callers arm: +11% and +42% on the two cases. These are single runs, not a reliable cost estimate.
- lenses3: 3 passes ran. Cost about 7x a baseline run on the same case ($5.13 against $0.74). 3 of 9 must-finds shown.
- callers: cost about the same as a baseline run. 2 of 9 must-finds shown. The callers arm uses a prompt near the baseline.
- Two cases cannot show a quality difference.
- Decision (user, 2026-11-24): CodeGraph stays opt-in and does not become a default, because some users do not need it. No full eval run of "codegraph" is planned. The full runs of callers and lenses3 ran on 2026-11-25 (next section).

### 2026-11-25: baseline r6, callers, and lenses3 on the natural set

Code a84610d, prompt 2.9, local natural set r6: 41 cases, 60 shown must-finds. Effort medium.

Baseline r6, repeat 2, 82 case runs (81 complete, 1 incomplete, 0 failed):

| Metric | Value |
|---|---|
| Cost | $215.34 total; $2.63 and 5.3 min per case run |
| Shown recall | 35.8% (23/60 and 20/60, spread 3) |
| Grounded recall | 38.3% (23 and 23, by judge labels) |
| Candidate recall | 39.2% |
| Union shown recall, k=2 | 48.3% |
| Recall by size | large 29.5%, small 39.5% |
| Precision | 25.7% |
| Line noise, grounded noise | 1.56 and 1.55 per case |
| Judge fp per case run | 0.16 |
| Severity ok | 100% |
| Cost spread between repeats | 35% per case on average |
| Judge labels | $6.01; must-finds labelled tp 58/82, agreement 70.7% |

- The set has no traps, so judge fp on traps cannot be measured.

Variant "callers" (D2), full set, repeat 2, 82 case runs (82 complete, 0 failed):

| Metric | Baseline | callers |
|---|---|---|
| Cost per case run | $2.63 | $3.25 (+24%), $266.84 total |
| Minutes per case run | 5.3 | 6.0 |
| Grounded recall | 38.3% | 35.0% (23 and 19 of 60) |
| Grounded recall, small cases | 42.1% | 34.2% |
| Grounded recall, large cases | 31.8% | 36.4% |
| Grounded noise per case | 1.55 | 1.68 (limit +0.155: pass) |
| Judge fp per case run | 0.159 | 0.232 (limit +0.070: FAIL) |
| Severity ok | 100% | 91.9% |

- Paired delta of grounded recall: −3.3 points, 90% interval −10.4 to +4.0 (not significant). Labels $5.03.
- Verdict: "callers" does not ship and stays opt-in. It gives no recall gain and costs 24% more. The judge fp noise rule fails by a small margin (+0.073 against +0.070), so that fail alone is weak evidence.

Variant "lenses3", a fixed 10-case subset chosen before the run, repeat 1, 10 runs (0 failed, 0 incomplete). The control is the same 10 cases of baseline r6 (20 runs):

| Metric | Baseline | lenses3 |
|---|---|---|
| Cost per case run | $1.59 | $7.55 (4.8x), $75.52 total |
| Minutes per case run | 4.2 | 15.0 |
| Grounded recall | 35.7% | 42.9% |
| Candidate recall | 39.3% | 53.6% |
| Precision | 40.9% | 34.2% |
| Grounded noise per case | 1.25 | 2.70 (limit +0.125: FAIL) |
| Judge fp per case run | 0.30 | 0.50 (limit +0.07: FAIL) |
| Severity ok | 100% | 100% |

- Paired delta of grounded recall: +7.1 points, 90% interval −4.9 to +26.3 (not significant; 8 PR groups, 28 must-finds).
- Most extra noise is findings that the judge labels true (+1.25 per case), not false (+0.20 per case).
- Labels $2.03; must-finds labelled tp 22/29, agreement 75.9%.
- Verdict: lenses3 does not ship and stays opt-in. It costs about 5x and doubles the noise, and the recall gain is not significant.
- Guess, not measured: many extra findings are judged true, so the must-find list can miss real issues.
- eval:ab has no command to compare a subset run with the full baseline. A scratch script trimmed the baseline to the subset cases and loaded the baseline labels under the full-set key.
- eval:compare warns that the profile revisions differ for both variants. The variant alone changes the revision (run.ts profileRevision hashes the variants). The prompts and modules are the same, so the numbers compare.

### 2026-11-25: run the review twice and merge (free analysis of baseline r6)

The two repeats of baseline r6 act as two runs on the same PR. The analysis used the existing judge labels and made no paid run.

| Metric, per case | One run (mean of 2) | Two runs merged, raw | Two runs merged, deduplicated |
|---|---|---|---|
| Grounded recall, shown | 38.3% (23/60) | 48.3% (29/60) | 48.3% |
| Noise | 1.55 | 3.10 | 2.37 |
| Judge fp | 0.16 | 0.32 | 0.24 |
| Cost | $2.63 | $5.25 | $5.25 |
| Minutes, runs in parallel | 5.3 | 6.0 | 6.0 |

- Gain: +10.0 points of grounded recall, 90% case bootstrap interval +5.0 to +15.0. The gain comes from 10 of 41 cases. 11 of the 12 one-run-only must-finds are minor, 1 is major, none is a blocker.
- Dedup rule: same item hash, same gold key, same must-find, a copied judge label, or a stored matcher match. "Same file, same side, lines within 3" gives about the same result (noise 2.29).
- Findings that both runs raise match a must-find 2.5 times as often (37.8% against 14.8%). The judge labels both groups true at about the same rate (93% and 91%), so a one-run-only finding is not less trustworthy.
- Limits: 48.3% is an upper bound, because it assumes a perfect merge. Both runs use the same prompt, so the gain comes from run-to-run variance, not from a better method. A union also lifts any variant.
- Per dollar, this beats lenses3 (+7.1 points for 4.8x) and callers (−3.3 points for 1.24x).

### 2026-11-26: pilot of git-history on the natural set

Variant "git-history" (prompt 2.9+git-history, code d3cda25), the fixed 10-case natural subset of the lenses3 run, repeat 1, effort medium, 10 runs (all completed). A Claude usage limit cut the run after 2 runs, and --resume finished it. The control is the same 10 cases of baseline r6 (20 runs):

| Metric | Baseline | git-history |
|---|---|---|
| Cost per case run | $1.59 | $2.42 (1.52x), $24.20 total |
| Minutes per case run | 4.2 | 4.7 (1.12x) |
| Grounded recall | 35.7% (10/28) | 25.0% (7/28) |
| Candidate recall | 39.3% | 28.6% |
| Precision | 40.9% | 23.5% |
| Grounded noise per case | 1.25 | 1.00 (pass) |
| Judge fp per case run | 0.30 | 0.30 (pass) |
| Severity ok | 100% | 100% |

- Paired delta of grounded recall: −10.7 points, 90% interval −28.1 to +6.7 (not significant; 8 PR groups, 28 must-finds).
- GH-0 part b: PASS. The find phase made 4 ok git_blame calls (lead 2, subagent 2) in 3 of 10 case runs, against 0 in the baseline runs. Ok git_log calls: 16 against 2. Ok git_show calls: 2 against 0.
- 4 of 25 findings cite an earlier commit: 3 confirmed, 1 refuted.
- Verdict: FAIL per git-history.md section 5, because grounded recall is below the subset baseline. git-history stays opt-in, and no full run follows.
- Guess, not measured: the history reads take turns from the bug search.
