# Review practice research, round 2 (2026-11-27)

Scope: web evidence from 2025 and 2026 on what can raise review quality next: more real bugs found, low noise, and an acceptable cost. A second part covers code writing in Build a Jira task. Earlier research: review-practice-2026-11.md (T1 to T11), research-review-practices.md, research-review-tools.md, review-quality-2026.md, and review-ledger.md. This file marks each item NEW or KNOWN against them.

Evidence classes: [R] measured research, [V] vendor claim, [A] Anthropic or OpenAI guidance, [O] opinion. Vendor benchmarks run on vendor data. Treat their ranks as biased. "Guess" marks an estimate of this file.

Read depth: four pages were fetched and read in their relevant parts (marked "fetched": the Bugbot blog, CR-Bench-v2, OpenCodeReview, and the overcorrection paper). Every other source comes from search-result excerpts of the page (marked "excerpt"). "Abstract only" means that the excerpt held only the abstract. Check an excerpt row before a decision depends on it. No file in docs/ cites these URLs, and docs/plans/ has no mention of Reflexion, GEPA, learned rules, or rubric checks (grep, 2026-11-27). The NEW marks rest on that check.

## 1. Answer first

- Our own data is the main filter. The loss is finder judgment: coverage held the issue hunk in 34 of 34 issue-runs, and verify refuted 0 of the missed issues (results.md, 2026-11-23). So a verifier, a vote, or a calibration step can only cut noise. Only a finder change can raise recall.
- The one proven recall lever here is a second independent finder run: +10.0 points grounded recall (38.3% to 48.3%), but the cost doubles and noise goes from 1.55 to 2.37 per case (results.md, 2026-11-25). The web agrees: aggregation of several runs raises recall [R], and two Claude Code runs together found more valid bugs than one [R].
- So the best next steps make the second run cheaper, not different: a cheaper second arm (R1), and a second run that gets the first run's findings and looks only for misses (R2). A fold of the second arm (R4) makes the union quieter, but by arithmetic it gives up most of the shown recall gain.
- The oracle look is the one positive finder signal: exact lines found 3 of 5 live misses, with 0 of 30 decoy false claims. The file alone helped little. Line-level focus from a cheap pre-pass (R3) tests that signal without the answer key.
- Execution (a failing test as proof) is the strongest precision tool in the new papers [R]. It does not fit a PR review without a hard-rule change (no Bash, BRIEF 3.5). It fits Build a Jira task, which already has a shell and checks.
- Tested here and lost: focused lenses (lenses3), the caller rule, git history, "classes" (gate blocked), "broad", "verify2", and splitting large PRs ("parts", item 1). Ruled out by inference, not by a run: diff order, coverage passes, and cap raises, because coverage held the issue hunk in 34 of 34 issue-runs (results.md line 123). "architecture" was not measured alone.

## 2. New benchmarks and papers

| # | Claim | Number | Sample | Source | Class | New? |
|---|---|---|---|---|---|---|
| B7 | A Reflexion second pass ("find what you missed") raises known-defect detection on every backbone, and usefulness does not fall. | +2.9 to +12.6 points KDDR. Significant in most cells for the three weaker backbones (not for GPT-OSS 20B under one judge). GPT-5.2 +2.9 to +5.7, not significant. Cost not reported. The harnesses had no tools. | CR-Bench-Verified, 174 PRs, one known defect each | https://arxiv.org/html/2611.02566v2 (fetched) | [R] | NEW |
| B8 | A filter-only reflector that sees only the diff and removes only comments that the diff contradicts raises precision and keeps recall. It fails open. | System SEM-F1 25.1% against 11.6% for the same model in Claude Code /code-review; precision 33.9% against 7.2%; recall 20.0% against 28.9%; 5 to 15x fewer tokens. The gain belongs to the whole system, not to the reflector alone. | AACR-Bench, 200 PRs, 1,505 comments | https://arxiv.org/html/2608.09290v1 (fetched) | [R] | NEW |
| B9 | A PoC-test agent rejects false bug reports and confirms true ones. A plain Claude Code run made no valid PoC for a false report. Two plain runs together found more valid PoCs than one. | Version 1, Table 4 (48 true, 96 false reports): AnyPoC (Opus 4.5) validated 38 of 48 true reports and rejected 84 of 96 false ones, $6.47 per report; plain Claude Code validated 26 of 48. Version 2, another table: two Claude Code runs had 56 valid PoCs against 43 and 39 for single runs. The two tables use different report sets. | 12 large systems | https://arxiv.org/html/2604.11950v1 and https://arxiv.org/html/2604.11950 (excerpt) | [R] | NEW |
| B10 | A dynamic trigger is strong proof, but its absence is no proof of a false alarm. | No valid trigger for any false positive; 60% of true positives confirmed. | Juliet, SV-COMP, FormAI | https://arxiv.org/html/2607.09979 (excerpt) | [R] | NEW |
| B11 | Requirement-conformance prompts that ask for an explanation and a fix make models reject correct code much more often. Running the model's own fix against tests removes most false rejections. | GPT-4o FNR 26.2% to 73.2% (HumanEval) with explain and fix. Fix-guided filter: mean FNR 54.8% to 16.3% (HumanEval), 69.0% to 28.9% (MBPP); FPR up by 0 to 2.5 points. | HumanEval, MBPP, QuixBugs; 5 models | https://link.springer.com/article/10.1007/s10515-026-00638-5 (fetched) | [R] | NEW |
| B12 | A smaller model can review better than a larger one of the same family. | Haiku 4.5 against Sonnet 4.6: F1 0.365 against 0.343, recall +18%, 3.2x cheaper. Reproduced on the Martian benchmark. | 150 samples (100 synthetic, 50 real PRs) | https://arxiv.org/html/2606.15689v1 (excerpt) | [R] | NEW |
| B13 | A cheap model on every PR, and a strong model added when the cheap one raises findings, beats any single model at the same cost. A fixed rule (auth paths) barely beats random. | Escalate at 1+ findings: 120 verified bugs for $4.13, against 108 for $4.15 with the strong model alone. Precision 86% to 77%. | 50 public PRs, one run each | https://entelligence.ai/blogs/cheap-model-first-escalate-code-review (excerpt) | [V] | NEW |
| B14 | Whether a PR is safe to send to the cheap model cannot be predicted before the review. | Every predictor at AUC 0.55 or below. The cheap model reaches 90% of strong coverage on 48% to 51% of PRs. | 601 PRs, two model pairs | https://dl.acm.org/doi/10.1145/3837729.3839585 (abstract only) | [R] | NEW |
| B15 | An LLM risk model can point at the risky hunks of a diff. | Top-2 hunks hold the outage-causing lines in 53.85% of changes, with 26.3% of changed lines to read. Top-3 hunks: 64.4%. | Meta, expert-labelled outage changes | https://arxiv.org/html/2607.02782v1 (excerpt) | [R] | NEW |
| B16 | Analyzer facts in the prompt help an LLM judge analyzer warnings, and raise recall for one detector. | Precision up to +10 points; unreachable-code recall +11 to +27 points with analyzer data in the prompt. | SharpChecker (C#), industrial code | https://link.springer.com/article/10.1134/S0361768826700313 (abstract only) | [R] | NEW |
| B17 | LLM plus static analysis removes most analyzer false positives in industry. | 94% to 98% of false positives removed with high recall; $0.0011 to $0.12 per alarm. | Tencent, 433 alarms | https://arxiv.org/abs/2601.18844 (abstract only) | [R] | NEW |
| B18 | Static analyzer output given at inference (RAG) makes review comments more complete. | Qualitative, LLM-judge comparison. | Real-world dataset, fine-tuned models | https://arxiv.org/html/2502.06633 (excerpt) | [R] | NEW |
| B19 | A backward data-flow slice gives better key-bug inclusion than the diff, the parent function, or a full flow slice. | Ranking only in the excerpt. | Industrial merge requests | https://raw.githubusercontent.com/mlresearch/v267/main/assets/lu25f/lu25f.pdf (excerpt) | [R] | NEW |
| B20 | Rejection of agentic review comments is learnable from feedback. | 56.3% of 31,073 CodeRabbit comments rejected; a light classifier predicts rejection at up to 76% F1. Main reasons: false positive, redundant, out of scope, intent mismatch. | 239 repositories | https://arxiv.org/abs/2607.03316 (abstract only) | [R] | NEW |
| B21 | Under one fixed judge, the best model finds about two thirds of the known bugs, and most models find under half. | Leaderboard version with 121 bugs: best recall 68.6%; Opus 5.5 42.1% recall, 52.6% precision. | 30 PRs, 121 bugs | https://www.codereviewbench.com/leaderboard (excerpt) | [V] | NEW |

## 3. Production reviewer designs, new since 2026-11-17

| # | Design | Number | Source | Class | New? |
|---|---|---|---|---|---|
| P10 | Bugbot: the largest gains came from a fully agentic design. The agent was too cautious, so they moved to aggressive prompts. Tool design had an "outsized" effect. | Resolution rate 52% to over 70% over 40 experiments; bugs per run 0.4 to 0.7. | https://cursor.com/blog/building-bugbot (fetched) | [V] | KNOWN (P1, P2), numbers NEW |
| P11 | Bugbot learned rules: reactions, replies, and human comments on missed bugs become candidate rules. A rule goes active after more signal, and goes off on negative signal. | Resolution rate near 80%; 44,000 learned rules. No ablation of the rules alone. | https://cursor.com/blog/bugbot-learning (excerpt) | [V] | NEW |
| P12 | Qodo: GEPA prompt optimization on the team's PR review history (which findings led to changes). | Production A/B, 27,582 runs: miss rate 7.83% to 4.46%, cost per run $0.24 to $0.12, precision the same. | https://www.qodo.ai/blog/improving-code-review-recommendations-with-gepa/ (excerpt) | [V] | NEW |
| P13 | Greptile v3: agentic loop with codebase search, git history, and learned rules. | Upvote ratio 1.44 to 5.13; action rate 34.8% to 59.2%. Many changes at once. | https://www.greptile.com/blog/greptile-v3-agentic-code-review (excerpt) | [V] | NEW |
| P14 | OpenAI Codex review: precision first, then recall. Repo access and code execution gave a stronger reviewer with fewer false alarms. | Human evaluation, chart only. | https://alignment.openai.com/scaling-code-verification (excerpt) | [A] | NEW |
| P15 | Anthropic Code Review (GA): find, verify, rank, post. Levels Quick, Standard, and Deep per repository. Findings state the problem, the trigger, and the fix. | Reviews 3x faster (about 20 min to 6 to 10 min). Preview: under 1% of findings marked incorrect; $15 to $25 per review. | https://claude.com/blog/code-review-is-now-generally-available, https://claude.com/blog/code-review (excerpt) | [A] | KNOWN (P3), GA facts NEW |
| P16 | Claude Code team practice: the agent shows test, build, or screenshot output before a PR; a fresh-context subagent reviews the diff; effort matches risk; after a few rounds, re-review only the new diff. | "Two to three times better" with a way to verify (quote of one engineer). | https://claude.dev/blog/solving-code-review-at-anthropic/ (excerpt) | [A], [O] | NEW |
| P17 | Atlassian comment ranker: an ML model trained on "did the comment lead to a code change" replaces heuristic filters. | Code resolution rate 40% to 45%, near the human 45%. | https://www.atlassian.com/blog/atlassian-engineering/ml-classifier-improving-quality (excerpt) | [V] | NEW |
| P18 | Uber uReview measures "addressed" by five reruns on the final commit, because one rerun is too noisy. | Five reruns. | https://www.uber.com/blog/ureview (excerpt) | [V] | KNOWN (P7), detail NEW |

## 4. Candidates, ranked

Ranking rule: a candidate that our data can measure for free or cheaply ranks above a full paid finder run. A candidate that raises recall ranks above a pure noise cut at the same price. Costs use the 10-case subset of results.md: $1.59 and 4.2 min per baseline case run; full set $2.63 per case run.

Common pilot pattern: the fixed 10-case natural subset, repeat 1, effort medium, control = the same 10 cases of baseline r6 (20 runs). eval:ab has no subset compare. A scratch script trims the r6 baseline to the subset, as in the lenses3 and git-history runs. Labels cost about $2 per 10 runs. Any reuse of r6 records needs the same prompt version (2.9) and the same set fingerprint as r6; a rebuilt set or a new prompt step voids the reuse.

### R1. Cheaper second arm for Thorough review (variant "twice-lite")

- What: arm 2 of "twice" runs on a cheaper model or a lower effort (for example Sonnet, Haiku, or Opus at low effort). Arm 1 stays the shipped finder. The verify phase of both arms stays on the shipped verify model.
- Evidence: the union is our only proven lever (+10.0 points, 90% interval +5.0 to +15.0). A different model adds diversity: SWR-Bench also aggregated across models (B1, [R]). A smaller model can have higher recall than a larger one (B12, [R]). A cheap reviewer combined with a strong one beats either alone per dollar (B13, [V]). thorough-review.md (D1 to D6) gives both arms byte-identical prompts and the same model; it records no decision on an arm-2 model.
- Fit: src/server/review/jobs.ts arm 2 runner (thorough-review.md D1), a profile field for the arm-2 model, src/shared/dto.ts VARIANTS. The merge stays `mergeRuns` in judge.ts (thorough-review.md D3).
- Effect (guess): +5 to +8 points recall at 1.2x to 1.4x cost, against +10 points at 2x for "twice". Noise rises like the union.
- Measure: cheap. Reuse r6 repeat 1 as arm 1. Run only arm 2 on the 10 subset cases, for example `bun run eval -- --real --set local --cases <10 ids> --repeat 1 --model <cheap> --verifier-model opus --out eval-results/twice-lite/arm2`. The syntax of `--model` and `--verifier-model` in `bun run eval` is unverified; check scripts/eval/run.ts first. Pin the verify model: jobs.ts:1884 uses `profile.verifier.model ?? profile.model`, so a cheap `--model` alone also moves verify. Merge offline with the 2026-11-25 dedup rule. Compare three numbers: single r6, union(r6 rep1, rep2), and union(r6 rep1, arm 2). Cost guess: $5 to $10 for arm 2 plus $2 labels. Full run (41 cases, repeat 1): $20 to $40 (guess).
- Risk: a weak arm 2 adds noise and no recall. The judge labels its extras; check the judge fp rule.

### R2. Missed-bug pass (variant "second-look")

- What: after the finder, one more fresh finder run gets context/first-findings.md (titles, places, and triggers of the first run) and one rule: find real defects that the list misses; do not repeat a listed one. It is no session resume (BRIEF 3.5), the same way as salvage (jobs.ts salvagePhase). It gets a turn cap below the main finder.
- Evidence: Reflexion "find what you missed" raises known-defect detection on every backbone, +2.9 to +12.6 points (B7, [R]). The gain is smaller for the strongest backbone, and the harness had no tools, so the effect on Opus with tools is unknown. The ledger already lists "One 'what else?' turn" (section 5, rank 8, research T7). B7 is new evidence for that idea.
- Fit: src/server/review/jobs.ts (a phase like salvagePhase), src/server/review/catalog.ts (agent spec and lines), src/server/review/context-files.ts (the findings file), VARIANTS.
- Effect (guess): +3 to +6 points recall at 1.3x to 1.6x cost. Less overlap than a blind second run, but the list can also anchor the second run.
- Measure: paid pilot on the 10 subset cases, about $20 to $26 plus $2 labels (guess). Pass bar per dollar: beat the union line (+10 points for +100% cost), for example at least +4 points at no more than 1.4x. Full run, 41 cases, repeat 2: about $270 to $330 (guess). `--candidate-replay` refuses it, because it changes the finder.
- Risk: the second run repeats the first with new words. The dedup hides the copies, but the cost stays.

### R3. Hunk hypotheses from a cheap pre-pass (variant "focus")

- What: before the finder, a cheap run (Haiku, or Opus at low effort, Read only or no tools) reads the diff and writes context/focus.md: the top 3 to 5 hunks by risk, each with one concrete hypothesis ("this early return skips the unlock"). The finder checks these first and still reviews the whole change.
- Evidence: the oracle look: exact lines found 3 of 5 live misses, 0 of 30 decoy false claims; the file alone helped little. An LLM risk model puts the outage lines in the top-2 hunks in 53.85% of changes (B15, [R]). Cheap-first escalation works per dollar (B13, [V]). Against it: routing whole PRs by predicted difficulty fails (B14, [R]). This candidate routes attention inside one PR, not the model per PR.
- Close to existing work: the finder already lists risks for the verify phase (risk-check.md, shipped in prompt 2.9). "focus" differs: a separate cheap run writes line hypotheses before the finder starts, and the finder must check each one.
- Fit: src/server/review/jobs.ts (one short run before the finder), src/server/review/context-files.ts (focus.md), finder lines in catalog.ts.
- Effect (guess): 0 to +5 points recall at 1.05x to 1.15x cost. The pre-pass has no answer key, so it may point at the wrong hunks. The lenses3 result (extra findings judged true but not gold) can repeat.
- Measure: first a cheap check of whether it can help. A scratch script gives the pre-pass the diffs of the r6 cases and records whether each missed must-find falls in its top hunks (pre-pass cost only, about $1 to $3, guess). Run the paid pilot ($17 to $20 plus labels) only when the top hunks hold at least 40% of the missed must-finds.
- Risk: anchoring. The finder may stop early on the listed hunks. Never-found issues sit later in the diff (median 0.85 of files), so a pre-pass that favours early hunks hurts.

### R4. Fold of the second arm (display rule of "twice")

- What: keep every arm 1 finding as today. Fold an arm-2-only finding into a collapsed group "found by the second run", unless it is major or blocker. Do not drop it.
- Evidence: majority voting over passes was one of Bugbot's most effective early changes (P1, [V]). Our data: findings that both runs raise match a must-find 2.5 times as often (37.8% against 14.8%). But the judge labels one-run-only findings true at 91%, so a drop loses real issues.
- Arithmetic (from results.md, 2026-11-25): each run shows 23 of 60 must-finds and the union shows 29. So 17 come from both runs and 12 from one run, and 11 of the 12 are minor. A fold of all one-run-only minor findings shows 18 of 60 (30%), below one run (38.3%). The variant above keeps arm 1 whole, so shown recall stays at about one run (38% to 40%), and the union gain moves into the folded group.
- Fit: the display group in mergeRuns (judge.ts, thorough-review.md D2 and D3: "main before fold"). Variant name: "twice-fold".
- Effect: noise near one run (about 1.55 per case, guess); the extra recall is one click away, not shown. This is a display choice, not a recall gain.
- Measure: free. Rescore the two r6 repeats with the rule. Report shown recall, recall with folded items, noise, and judge fp.
- Risk: the user does not open the fold, so Thorough review costs 2x for little shown gain. Ship only if the eval counts folded items in a separate recall row and the user accepts that trade.

### R5. Learned rules from your posted and discarded findings (variant "learned")

- What: an offline script reads the app's own decisions (posted, discarded as intended, discarded as wrong) and writes a short rules file per repository: "do not flag X here", "this team wants Y checked". The verify phase gets it as a refute aid. A later step can give the finder the "check" rules.
- Evidence: Bugbot learned rules (P11, [V]), Qodo GEPA on review history (P12, [V]: miss rate down, cost halved), Atlassian ranker (P17, [V]), and CodeRabbit rejections are learnable (B20, [R]). Earlier research T8 marked this "mainly precision". The new sources keep that view; only Qodo claims a recall gain.
- Close to existing work: WP-V8 (review checks per repository, review-v3.md) is planned and not built; "classes" (item 7) wanted bug kinds per repository and was blocked because the local set has no labels per bug kind. "learned" uses discard decisions instead of labels.
- Fit: a script under scripts/ that writes a project instructions text (the app already has project instructions, src/server/review/instructions.ts); the verify agent gets it. Verify-only first, so `--candidate-replay` can test it.
- Effect (guess): judge fp and noise down 10% to 25%; recall flat.
- Measure: a verify-only replay of r6 with `bun run eval:ab`, `--candidate-variants learned`, `--candidate-replay`, and the stored r6 baseline (docs/eval/local.md lines 173, 197, and 216 describe the flags; the exact command line is unverified). Cost: verify calls only, about $0.4 to $0.6 per case run, so $35 to $50 for 82 runs (guess). Build the rules only from decisions older than each case head, or leave the case's PR out, so the must-finds do not leak into the rules.
- Risk: leakage (the rules learn the gold), rule drift, and hidden real bugs. Rules must stay short and visible to the user.

### R6. Analyzer hints on changed lines (variant "analyzer"; needs user approval)

- What: the app runs the repository's own compiler warnings, type checker, or linter on the base and the head of the snapshot. It keeps only new warnings on changed lines and writes them to context/analyzer.md as hints, not findings. The finder and verify may use them.
- Evidence: analyzer data in the prompt raised one detector's recall by +11 to +27 points (B16, [R], abstract only); hybrids improve completeness (B18, [R]); LLM plus analyzer removes most analyzer false positives (B17, [R]); an AMD production system grounds each comment in analyzer findings (https://arxiv.org/html/2510.10290, excerpt, [R]).
- Fit: a new app step in src/server/review/ before the finder. It needs a per-repository command, the same way task checks do (src/server/tasks/checks.ts).
- Effect (guess): small for our misses. Of the 12 missed class (a) issues, 5 are logic inside one function and 5 need a caller; analyzers catch few of these. The gain can be larger on repositories with a type checker.
- Measure: paid pilot on the 10 subset cases ($17 to $20 plus labels, guess), only on cases where the command runs.
- Risk: BRIEF 3.6 and the sanitized-snapshot rule. A linter config or a build can run repository code (for example a JavaScript config file). C++ needs a compile database. This needs the user's explicit approval and a sandbox decision before any build.

### R7. Proof by test for blocker findings (PR review: needs a hard-rule change; task flow: fits now)

- What: for a blocker or major finding, an agent writes a small test that fails on the head and states the trigger. A finding with a failing test gets a "proved" mark. A finding without one keeps its verdict, because no trigger is no proof of a false alarm (B10).
- Evidence: AnyPoC (B9, [R]); dynamic triggers (B10, [R]); OpenAI: execution gives a stronger reviewer (P14, [A]); fix-guided verification removes false rejections (B11, [R]).
- Fit: not in PR review today (no Bash, sanitized snapshot, BRIEF 3.5). In Build a Jira task it maps to the own review and critic points (src/server/tasks/loop.ts), where the worktree has a shell and checks. See W2.
- Effect (guess): precision of shown blockers up; recall flat; cost $2 to $6 per proved finding (B9 cost scale).
- Measure: in the task flow, count the own-review points that become a failing test, and the share of points that the user later accepts. eval:ab has no support for it.
- Risk: cost, flaky tests, and a test that fails for the wrong reason.

### Not ranked, and why

- Data-flow slicing (B19, LLMxCPG https://www.usenix.org/conference/usenixsecurity25/presentation/lekssays): our finder already reads whole files in 27 of 34 issue-runs, and the misses are judgment, not context. Skip.
- Pre-review model routing per PR (B14): predictors at AUC 0.55 or below. Skip. R1 and R3 use a cheap model without a prediction.
- A self-consistency vote that drops one-run findings: our one-run-only findings are judged true at 91%. Use R4 (fold) at most, never a drop.
- Requirement checks against the Jira task: they exist (WP-JC, obligations). B11 adds a caution: prompts that ask for an explanation and a fix raise false "not met" verdicts. Keep the concrete-trigger rule of obligations.
- Mutation analysis in review: it finds test gaps, which our metric counts as noise. It fits code writing (W4).
- An independent diff-only reflector (B8): our noise is mostly findings judged true but not in gold (lenses3: +1.25 true against +0.20 false per case). A falsification filter would cut little. Revisit only if the judge fp rule becomes the blocker.

## 5. Ideas for code writing in Build a Jira task

The flow already has a checks gate with fix runs, a plan check and repair round, a Haiku critic, a fresh own review, and push-back on review points (part-session.md 2.7; task-builder-v2.md section 6; pushback.md). These ideas add to them.

### W1. Red-then-green test per testable "Done when" line

- What: for each plan task with a criterion that a test can prove, the build run first writes the test and runs it at the part base. The app records "red at base, green at head" as evidence. A test that passes at base does not count.
- Evidence: reproduction and regression tests raise resolve rates: TestPrune +9.4% resolved for Trae-agent and +8.0% for SWE-agent (https://arxiv.org/html/2510.18270v2, excerpt, [R]); TDFlow (https://aclanthology.org/2026.eacl-long.70.pdf, excerpt, [R]); e-Otter++ tests raise agent precision (https://dl.acm.org/doi/full/10.1145/3744916.3787837, excerpt, [R]). Caution: weak tests hurt: resolved rate 61.2% to 57.3% with tests from a weak test agent, 65.3% with a strong one (https://arxiv.org/html/2609.09133, excerpt, [R]). Most failed TDD-Agent runs passed their own tests but failed the held-out ones (https://aclanthology.org/2026.emnlp-main.1845.pdf, excerpt, [R]).
- Fit: src/server/tasks/implement.ts (prompt), src/server/tasks/checks.ts (run one named test at a commit), src/server/tasks/loop.ts (gate evidence). Try it on smoke-task.md part T.
- Risk: setup time per run, and tests that only mirror the code. Keep the test role apart from the code role (ExecCritic separates them).

### W2. Own-review points must come with a failing test before a fix run

- What: when the critic or the own review raises a point, the fix run first writes a test that shows the point at head. If it cannot, the point goes to the log as "not shown", not to a fix. The push-back path (pushback.md) stays for points that a test cannot show.
- Evidence: fix-guided verification removes most false rejections (B11, [R]); PoC validation rejects most false reports (B9, [R]); the Claude Code team asks the agent to show output, not to say "done" (P16, [A]).
- Fit: src/server/tasks/loop.ts (judging of critic and review points), implement.ts (fix prompt), the failure.md of pushback.md AC-B105.
- Risk: some real points cannot be shown by a test (design, docs). Those keep the current path.

### W3. Rubric check of the part diff against the approved plan

- What: at plan approval, the app derives a short rubric from the plan's contracts, risks, and "Done when" lines (WP-PQ1 already stores them). After the gate, a cheap run grades the part diff against each rubric item and gives the own review the unmet items.
- Evidence: agentic rubrics select better patches than self-consistency, generated tests, or a patch classifier: Best@16 40.6% against 33.2% for self-consistency (https://arxiv.org/html/2601.04171, excerpt, [R]). An iterative review-revise loop with one model raised resolve rate from 34.8% to 44.0% over 5 samples (https://arxiv.org/html/2607.06065, excerpt, [R]).
- Fit: src/server/tasks/plan.ts and plan-check.ts (rubric), loop.ts (input to the own review).
- Risk: the rubric repeats the plan's own errors. It checks conformance, not correctness, so the B11 overcorrection applies. Ask for a concrete missing behavior, not an explanation.

### W4. Mutation check of the tests that a part adds

- What: for new or changed tests, the app asks a cheap model for 3 to 5 small mutants of the changed code lines, runs the tests on each mutant, and gives a fix run the survivors: "add a test that catches this".
- Evidence: Meta ACH: engineers accepted 73% of mutation-guided tests (https://dl.acm.org/doi/10.1145/3696630.3728544, excerpt, [R]); LLM mutants mimic 77.4% of real bugs against 41.6% for rule-based ones (https://dl.acm.org/doi/10.1145/3805038, abstract only, [R]).
- Fit: src/server/tasks/checks.ts (run tests per mutant in the worktree), loop.ts (one fix round). Only when the part has a fast test command.
- Risk: run time, equivalent mutants (noise for the fix run), and over-testing. Cap at one round.

## 6. Order of work

1. R1 first: one cheap arm-2 run on 10 cases, merged with r6. R4 is a free rescore of r6 in the same session.
2. R3 cheap check (pre-pass on r6 diffs), then its paid pilot only if the check passes.
3. R2 pilot after R1, because both compete with the union for the same budget.
4. R5 verify-only replay when a time-split rules builder exists.
5. R6 and R7 only after a user decision on BRIEF 3.5 and 3.6.
6. W1 and W2 in the next task-flow package; W3 and W4 after Gate UT.

Facts against inference: the numbers in sections 2 and 3 quote the sources, and the numbers from results.md quote our own runs. All effects and costs in sections 4 and 5 that carry "guess" are estimates of this file.
