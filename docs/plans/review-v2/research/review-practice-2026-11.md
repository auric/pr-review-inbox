# Review practice and recall research (2026-11-17)

Scope: web evidence on how an AI code reviewer finds more real bugs without more noise. Earlier research: research-review-practices.md, research-review-tools.md, review-quality-2026.md sections 1 and 2. This file marks each item NEW or KNOWN against them.

Evidence classes: [R] measured research, [V] vendor claim, [A] Anthropic guidance, [O] opinion. Vendor benchmarks are run by the vendor on its own data. Treat their ranks as biased.

## 1. Answer first

- Recall, not precision, is the gap. Precision can be tuned by filters after the finder. Recall cannot be recovered after the finder misses a bug (Qodo, [V]; also our failed "high signal only" run).
- The strongest measured lever for recall is more independent finder samples with a merge: SWR-Bench self-aggregation of 10 runs more than doubles recall (+118.8% relative, to 30.4%) [R]. Cursor Bugbot used 8 passes with a shuffled diff order [V].
- Recall falls hard as a PR holds more bugs: SWR-Bench recall drops from 38.4% (1 issue) to 8.9% (5 or more issues), while precision stays at 30-44% [R]. This matches our large C++ misses.
- An agentic finder that digs where it wants needs an aggressive prompt, not a cautious one. Bugbot saw its largest gains from this switch [V].
- Textual intent (linked issue, PR description) helps more than more code context [R, ContextCRBench].
- Human data: defect finding falls fast above 200-400 changed lines and above 400-500 lines per hour [R, Cisco].

## 2. Benchmarks and papers

| # | Claim | Number | Sample | Source | Class | New? |
|---|---|---|---|---|---|---|
| B1 | Aggregating several review reports (same model, several runs, or several models) raises recall more than precision. | Gemini 2.5 Flash, n=10 self-aggregation: recall 30.44% (+118.83% rel.), F1 21.91% (+43.67% rel.). Qwen 7B to 32B also gain 19-26% F1. | 500 change PRs and 500 clean PRs | https://arxiv.org/html/2509.01494v2 | [R] | KNOWN paper, NEW numbers |
| B2 | Recall falls as the number of real issues per PR rises; precision does not. | Recall 38.35% at N=1, 8.88% at N>=5 (Gemini 2.5 Pro, PR-Review). Precision 29.6-44.1%. | SWR-Bench, mean 1.90 issues per PR | https://arxiv.org/html/2509.01494v2 | [R] | NEW |
| B3 | Textual context (linked issue) gives larger gains than code context alone. | Qualitative ranking over 8 LLMs. An internal self-evolving system improved by 61.98% (metric not stated in abstract). | 67,910 entries from 153.7K issues and PRs | https://arxiv.org/abs/2511.07017 | [R] | NEW |
| B4 | Multi-agent lenses with union voting raise recall at a large precision cost. | Union of 4 agents: recall 82.7%, precision 48.8%. Weighted vote: recall 37.7%. Ensemble adds 17 pp recall over one security agent. A correctness agent alone adds 11 pp. | PyVul, SecurityEval (vulnerability detection, not PR review) | https://arxiv.org/html/2602.17875v1 | [R] | NEW |
| B5 | Code Review Bench, ReviewBench, Martian benchmark | See earlier files. | - | arXiv 2603.23448, github.blog ReviewBench, withmartian | [R] | KNOWN |
| B6 | Long context alone lowers model accuracy, even with perfect retrieval. | Not read in full. | - | https://aclanthology.org/2025.findings-emnlp.1264.pdf | [R] | NEW, unverified detail |

## 3. Production reviewer designs

| # | Design | Number | Source | Class | New? |
|---|---|---|---|---|---|
| P1 | Cursor Bugbot v1: 8 parallel passes, each with a random diff order; bucket similar bugs; majority vote drops bugs from one pass only; merge each bucket; category filter; validator model; dedupe against earlier runs. | No per-step numbers. | https://cursor.com/blog/building-bugbot | [V] | NEW |
| P2 | Bugbot later: fully agentic design gave the largest gains. The agent was too cautious, so they moved to aggressive prompts: investigate every suspicious pattern, err toward flagging. Metric: resolution rate (LLM judges at merge whether the author fixed the bug). Offline set: BugBench (human-annotated diffs). | 40 experiments, v1 (Jul 2025) to v11 (Jan 2026): resolution rate 52% to over 70%; bugs per run 0.4 to 0.7; resolved bugs per PR about 0.2 to 0.5. Many changes regressed. | https://cursor.com/blog/building-bugbot | [V] | NEW |
| P3 | Anthropic Code Review (managed product): a team of agents searches in parallel, verifies to drop false positives, ranks by severity. Agent count scales with PR size. About 20 min per review. | PRs over 1,000 lines: 84% get findings, mean 7.5. PRs under 50 lines: 31%, mean 0.5. Under 1% of findings marked incorrect. PRs with substantive comments: 16% to 54%. | https://claude.com/resources/articles/code-review | [A]/[V] | NEW (the plugin is KNOWN) |
| P4 | Greptile: graph index of files, functions, and dependencies; a swarm of agents checks impact beyond the diff; learns standards from other reviewers' comments; a separate product runs the PR branch in a sandbox. | Own benchmark (Jul 2025): catch rate Greptile 82%, Bugbot 58%, Copilot 54%, CodeRabbit 44%, Graphite 6%. Method: 50 bug-introducing PRs from 5 OSS repos, traced back from fix PRs, default settings, false positives not scored. | https://www.greptile.com/benchmarks | [V] | NEW |
| P5 | Augment: semantic retrieval, file browse, symbol search; diffs and existing comments injected, not fetched; Jira/Linear context via MCP. The prompt mainly sets the precision/recall trade-off. F-score is the hill-climb metric. | Own report on Code Review Bench: recall 62.8%, precision 47.0%, F1 53.8%, 3.6 comments per PR. Graphite: precision 75%, recall 8.8% (12 of 137 bugs). | https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent | [V] | NEW |
| P6 | Qodo 2.0: multi-agent review plus a history agent that reads past PRs and review feedback. "Exhaustive" recall mode. | Own benchmark: F1 60.1%, recall 56.7%. | https://www.qodo.ai/blog/introducing-qodo-2.0-agentic-code-review | [V] | NEW |
| P7 | Uber uReview: chained stages (generate, grade, filter, dedupe); prunes low-value categories; developers dislike style comments. | Over 90% of about 65,000 weekly diffs; 75% of rated comments useful; over 65% addressed. | https://www.uber.com/us/en/blog/ureview | [V] | NEW |
| P8 | G-Research: split recall and precision into two prompts; pass 1 captures all, pass 2 filters with false-positive examples. | No numbers. | https://www.gresearch.com/news/building-a-code-review-tool-the-llm-patterns-that-actually-work | [O] | NEW |
| P9 | Google AutoCommenter, Google ML comment resolution, Atlassian Rovo, Anthropic plugin and security review, GitHub Copilot | See earlier files. | - | - | KNOWN |

Not found in this pass: published architecture numbers for Graphite Diamond, Sourcery, CodeRabbit, Meta (a RADAR paper exists, arXiv 2605.30208, on low-risk diff triage, not bug recall; not read).

## 4. Techniques with evidence

| Technique | Evidence | Strength | Fit to our setup |
|---|---|---|---|
| T1. Several finder samples, union or vote, then verify | B1 [R], P1 [V], B4 [R] | Strongest | Fits. Verifier already exists to absorb noise. Our own k=2 union data showed about +2 to +4 pt shown recall (session data, unverified source run). |
| T2. Perturb each sample (diff order, file order, lens) | P1 [V] | Medium | Cheap. Breaks the "same run, same misses" pattern. |
| T3. Aggressive search prompt in an agentic finder, precision left to a separate verifier | P2 [V], P8 [O] | Medium | Conflicts with our "raise more" result (+0.7 pt, n.s.). That test changed the prompt only, not the number of samples. |
| T4. Recall budget scales with PR size (more agents for large PRs) | P3 [A], B2 [R] | Medium | Our misses are on large C++ PRs. Per-run recall falls with issue count. |
| T5. Intent context: PR description, linked issue, commit messages | B3 [R] | Medium | Check that the Jira issue text reaches the finder. |
| T6. Impact analysis beyond the diff (callers, graph index) | P4 [V], P5 [V], P6 [V] | Weak (vendor only) | CodeGraph already available. No measured recall number found. |
| T7. Iterative "what else?" round after first findings | devansh blog [O] | Weak | Cheap follow-up turn in the same session. |
| T8. Learned repo rules from past accepted and rejected comments | P4, P6, P7 [V] | Weak for recall | Mainly precision. |
| T9. Running code or tests | Greptile sandbox product [V], no measured recall gain found | Unverified | Out of scope (no Bash). |
| T10. Checklists, fixed order | Our test: no gain | Negative | Skip. |
| T11. Splitting large PRs | Our test: no gain, 2x noise | Negative | Skip, unless the split is per sample (T1), not per part. |

## 5. Human practice that transfers

- Keep each review unit to 200-400 changed lines. Above that, reviewers miss defects. Rates under 300-500 lines per hour find the most defects. Faster than 450 lines per hour: defect density below average in 87% of cases. Sample: Cisco reviews (count not checked in this pass). https://static0.smartbear.co/support/media/resources/cc/book/code-review-cisco-case-study.pdf [R] NEW. Transfer: give a large PR more reasoning budget per line, not one pass.
- Author annotations and explanations lower defects (same Cisco study) [R] NEW. Transfer: use the PR description as intent.
- Only about 15% of human review comments point to a possible defect (Microsoft, Czerwonka et al., ICSE 2015). https://www.microsoft.com/en-us/research/wp-content/uploads/2015/05/PID3556473.pdf [R] NEW. Transfer: ground truth from human comments is thin on bugs; recall against it has a low ceiling.
- Google eng-practices and Bacchelli 2013: KNOWN.

## 6. Ranked for our misses

1. T1 + T2: 3 finder samples with a shuffled file order, union, then the existing verifier. Cost: about 2x to 3x finder cost; verifier cost grows with the union. Test: variant runs3-shuffle on the 42 cases, k=3; compare shown recall and noise against C1b.
2. T4: scale samples or reviewer agents with changed lines (for example over 1,000 lines). Cost: only on large PRs. Test: score large cases only.
3. T3 with T1: an aggressive finder prompt only together with several samples. Test: 2x2 (prompt by samples) on large cases.
4. T5: confirm the linked issue and description reach the finder. Cost: near zero. Test: ablate them on the 42 cases.
5. T6: a mandatory caller check for each changed public function, via CodeGraph. Cost: more tool turns. Test: recall on misses that are cross-file.
6. T7: one "what else, past the obvious" turn. Cost: one extra turn. Test: recall delta per added finding.

Facts vs inference: the numbers in sections 2 and 3 are quotes from the sources. Section 6 ranks and costs are inference.
