# Review best practices vs. the five review ideas (2026-11-11)

Scope: docs/plans/review-v2/review-ideas.md ideas 1 to 5. Prior research (research-review-tools.md, research-opus55.md) is not repeated. Search: Tavily, 7 queries. Most pages were read as search excerpts only, not in full. Dates marked "unverified" were not on the excerpt.

## Sources

- S1. Martian code-review-benchmark, GitHub. https://github.com/withmartian/code-review-benchmark (date unverified).
- S2. GitHub blog, "ReviewBench: An open benchmark for AI code review". https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review (date unverified, 2026 by context).
- S3. "Code Review Agent Benchmark", arXiv 2603.23448v2 (March 2026). https://arxiv.org/html/2603.23448v2
- S4. DeepSource, "Every AI code review vendor benchmarks itself, and wins". https://deepsource.com/blog/ai-code-review-benchmarks (date unverified).
- S5. Augment Code guide, "How accurate is AI code review?". https://www.augmentcode.com/guides/ai-code-review-accuracy (vendor page; cites a 2025-12-11 benchmark).
- S6. RovoDev Code Reviewer, arXiv 2601.01129 (January 2026), and the Atlassian blog post on resolved comment types. https://arxiv.org/html/2601.01129v2 , https://www.atlassian.com/blog/how-we-build/atlassian-rovo-dev-research-what-types-of-code-review-comments-do-developers-most-frequently-resolve
- S7. AutoCommenter, "AI-Assisted Assessment of Coding Practices in Modern Code Review", arXiv 2405.13565 (May 2024). https://arxiv.org/html/2405.13565v1
- S8. "Resolving Code Review Comments with Machine Learning", ICSE-SEIP 2024. https://research.google/pubs/resolving-code-review-comments-with-machine-learning
- S9. Google eng-practices, "What to look for" and "The Standard of Code Review" (living docs, undated). https://google.github.io/eng-practices/review/reviewer/looking-for.html , https://google.github.io/eng-practices/review/reviewer/standard.html
- S10. Anthropic claude-code-security-review action, README (date unverified, 2025). https://github.com/anthropics/claude-code-security-review . Also Anthropic quote via CyberScoop on Claude Code Security (February 2026). https://cyberscoop.com/anthropic-claude-code-security-automated-security-review
- S11. Bacchelli and Bird, "Expectations, Outcomes, and Challenges of Modern Code Review", ICSE 2013. https://sback.it/publications/icse2013.pdf

## 1. Per idea

### Idea 1: count other reviewers' line comments as must-find

- Supports: S1 online mode uses "Developer's post-review fixes" as ground truth, and precision is "Bot suggestions matched to real fixes". This is the same signal as "a later head changed that line".
- Supports: S2 "Addressed rate ... percentage of CCR comments that ... prompted a developer to make a corresponding code change, based on the diff, thread, reactions, resolution state, and post-review code." S6 uses the same code resolution rate (CRR).
- Refines: S3 "the majority of benchmarks still treat natural-language human comments as the primary ground truth, which introduces challenges due to noise, incompleteness, and variability". Human comments are incomplete, so recall against them is still a lower bound.
- Refines: S4 "Use real ground truth. Bugs from CVE databases, bug-fix commits, or human-validated defects". A bug-fix commit after merge is a second source of must-find items (inference: a later fix commit that touches a PR line).
- Refines: S6 design comments resolve less often (blog: "design comments ... were less likely to be resolved right away in the same pull-request"). So "line changed later" misses design items and over-counts readability items. The plan already limits to severity balanced and above; a category label would help.
- Contradicts: no source found.

### Idea 2: the finder checks a thread claim before it drops a finding

- Supports (indirect): S10 Nurbak summary of the Anthropic action: "A malicious PR can try to talk the reviewer out of reporting something". Text in a PR is input, not truth. This is the adversarial case of the same effect.
- Supports (indirect): S11 "finding defects" needs the most code understanding. A claim in a thread is a shortcut past that understanding (inference).
- No source found that measures whether thread claims suppress LLM findings. The cheap check in the plan stays the right gate.

### Idea 3: the app checks evidence lines (quote plus path:line)

- Supports: research-opus55.md item 7 already cites Anthropic "quote relevant parts of the documents first". Not repeated.
- Supports: S10 CyberScoop quote: "Claude re-examines each result, attempting to prove or disprove its own findings". The verifier does this; a mechanical quote check makes the proof checkable.
- Supports: S2 "Grounded precision" and "An auditable chain from rubric to expert validation". Grounding is a named metric, not a mechanism (inference: the term fits).
- Contradicts: no source found. Our own risk note (cap, never hide) matches S7 below: a hard threshold hid many correct results.

### Idea 4: Fix confirms the defect, makes the smallest fix, keeps rules

- Supports: S9 "The developer isn't implementing things they might need in the future but don't know they need now." and "The code isn't more complex than it needs to be." These apply to Fix output as to any CL.
- Supports: S9 "Don't block CLs from being submitted based only on personal style preferences." Fix that refuses a pure style request with a reason fits this.
- Refines: S8 Google auto-resolves only 7.5% of reviewer comments with ML edits. A low acceptance share is normal. Measure accepted share per `why`, as the plan says.
- Contradicts: no source found.

### Idea 5: scope rule for Fix, scope trial for the finder

- Supports (Fix part): S9 standard: reviewers "should not seek perfection but ... constant improvement", and a non-blocking point gets "Nit:". A follow-up proposal is the same idea for scope.
- Contradicts (finder part): S7 "around 80% of predictions below the threshold were still correct". A strict filter cut many true findings. research-opus55.md item 3 and results.md:8 say the same for our finder. Keep it behind a variant, as planned.

## 2. Strong practices that the ideas and prompts miss

Checked against the five ideas only. I did not read catalog.ts or review.ts in full, so "missing" means "not in the five ideas"; a prompt may already hold part of it (unverified).

1. Measure "addressed rate" from posted comments (online precision).
   - Source: S2 addressed rate, S6 CRR 38.70% for the bot vs. 44.45% for humans.
   - Effect: a precision number from real use, with no eval run. It also yields must-not-raise items: a posted finding that nobody acted on, on a merged PR.
   - Where: a script next to scripts/eval/local.ts. Read posted app comments, then check if a later head changed the anchored lines.
2. A learned or rule filter on "will this comment be acted on".
   - Source: S6 blog: they fine-tuned a classifier "to classify comments based on whether they led to a code resolution" and used it to rank comments.
   - Effect: ranks findings by expected action, not by model confidence. Inference: a cheap first step is ordering by category, because S6 says bug, readability, and maintainability resolve at 36% to 43%, and design less.
   - Where: judge.ts ordering, or the inbox sort. Never a hide rule.
3. Tag non-blocking findings as "Nit:" in posted text.
   - Source: S9 "prefix it with something like 'Nit: ' to let the author know that it's just a point of polish that they could choose to ignore."
   - Effect: low-severity findings stay visible but cost the author less. This keeps recall (no filter) and lowers perceived noise.
   - Where: the post text builder for severity minor and below. This changes posted text, so it needs a user decision.
4. Ask when the code is hard to understand, instead of asserting a bug.
   - Source: S9 "If it's too hard for you to read the code ... let the developer know that and wait for them to clarify it". S11: understanding is the key need for defect finding.
   - Effect: low-confidence findings become questions. Fewer confident false positives in posted text (inference).
   - Where: finder output field (finding vs. question) or post text for confidence low. Unverified whether the schema already has this.
5. Explicit, tunable exclusion list of false-positive-prone categories.
   - Source: S10 README excludes "Denial of Service", "Rate limiting concerns", "Generic input validation without proven impact", and says "The false positive filtering can also be tuned".
   - Effect: removes known noise classes in a separate pass, not in the finder prompt, so finder recall stays. This matches research-opus55.md item 3 (report all, filter later).
   - Where: judge.ts as a per-profile list that caps severity. It must not go into the finder rules (results.md:8).

## 3. Practices that hurt quality (avoid)

- A high confidence threshold that hides results. S7: at t=0.98 "around 80% of predictions below the threshold were still correct", so "the false-negative rate was very high".
- Strict "high-signal only" rules in the finder prompt. research-opus55.md item 3 (Anthropic) and our own U-V1 run (results.md:8, recall 30.8% to 11.5%).
- Lexical similarity metrics (BLEU, ROUGE, embeddings) as review quality. S3 lists them as common, then moves to LLM judges and expert labels. Our matcher uses location and judge, so keep it that way.
- Vendor self-benchmarks and LLM-made ground truth as proof. S4: "every vendor that has published one wins their own" and "If the ground truth was generated by a model, it's unclear what the benchmark is actually measuring." Do not tune against such numbers.
- Blocking on personal style. S9 "Don't block CLs ... based only on personal style preferences."

## Facts vs. inference

- Facts: the quoted sentences, with their source tags.
- Inference: every line marked "inference", the mapping from sources to our files, and the expected effects in section 2.
- Not verified: page dates marked unverified; full text of S1, S2, S5, S10 (excerpts only); whether current prompts already cover items 2.3 to 2.5.
