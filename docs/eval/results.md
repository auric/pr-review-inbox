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
