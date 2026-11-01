# Eval results

Aggregate numbers only. The local set holds company code, so no case names, paths, or finding text go here.

## 2026-10-31: U-V1 (eval:ab on the local set)

- Local set: 16 cases, 40 must-find (26 counted at balanced), 0 must-not-raise. Effort medium, repeat 1, verifier on. Baseline (prompt 2.3): recall 30.8% (8/26), precision 34.8%, noise 0.94 per case, $29.6, 71 min.
- Candidate signal+order+rules2+failures: recall 11.5% (3/26), precision 37.5%, noise 0.31, $25.9, 53 min. Without signal: recall 26.9% (7/26), precision 25.0%, noise 1.50, $34.1, 71 min. Decision: keep 2.3, and no variant ships.
- Re-review set: 6 cases with 1 must-find. The baseline found it. Both candidates with rereview-strict missed it. The set is too small for a decision.
- Weak spot: the 4 cases with rl-reviewer (three heads of one 56-59-file PR, plus one 24-file PR) found 2 of 9 counted bugs at 15% precision and used 71% of the cost. The other 12 cases: recall 35%, precision 60%.
- Precision is a lower bound. The set has no must-not-raise items, so an unmatched finding counts as noise, also when it is a real bug.
