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
