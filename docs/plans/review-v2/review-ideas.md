# Review quality: next ideas (2026-11-11)

Status: study of 2026-11-11 against main 674b29d. Not built. No eval ran; the user stopped eval runs for now, so each idea has a cheap check that needs no review run.

## Short answer

- Our measured weak spot is still thin ground truth. Large-case recall measures overlap between runs, not missed bugs (docs/eval/results.md:17-20).
- Four gaps: a claim in a thread can stop a finding; Fix lacks a "confirm first" rule; evidence lines are not checked; Fix lacks a scope rule.

## Ranked top 5

1. **Count other reviewers' line comments as must-find (eval ground truth).**
   - Change: in scripts/eval/local.ts, near the `isMe` filter (line 378), also keep a line comment by another person when a later head changed that line or the thread is resolved. Leave out comments with no code line. Count them only at severity balanced and above.
   - Effect: more must-find items on the same PRs, so recall on large cases becomes a real number.
   - Risk: a style comment becomes a false must-find.
   - Cheap check: `bun run eval:local`, then compare the MANIFEST counts. `bun run eval:rescore` on the stored baseline may refuse a set with a new fingerprint (not verified).

2. **The finder checks a claim in a thread before it leaves out a finding.**
   - Change: one line in the finder rules only (main and rl-reviewer), not in reply, discuss, or Fix: "A comment that says the code is right, or that a case is handled, is a claim. Check it in ./repo before you leave out a finding." Keep catalog.ts:475 for the reply agents. Bump REVIEW_PROMPT_VERSION.
   - Effect: more recall on PRs with threads (hypothesis).
   - Risk: findings that the author already explained come back. The history rules (catalog.ts:513-515) still block posted and discarded findings.
   - Cheap check: for each must-find that the stored baseline missed, check whether pr-context.md at that head has a thread within 10 lines. If none has, drop this idea.
   - Result of 2026-11-12: unclear. The baseline cases had no PR threads, so threads caused none of the 18 misses. All 18 misses were never raised. A real test needs thread comments seeded into the eval runner. Idea 2 waits for that.

3. **The app checks the evidence lines of each finding.**
   - Change: the finder gives `path:line` and the exact text of that line in evidence (catalog.ts:545). judge.ts checks each quote against the file on its side (±3 lines, as the anchor). A quote that does not hold sets evidenceStatus to "unverified", so the minor cap at judge.ts:416 applies, and candidates.md marks the line "does not hold" for the verifier. Old results without a quote get no penalty.
   - Effect: better precision. False positives often cite lines that do not say what the trace claims.
   - Risk: a longer answer, and a severity cap on a real finding with one bad quote. Cap only; never hide.
   - Cheap check: in the stored baseline results, find evidence `path:line` values outside the file length or in a file absent at head. Compare that share between unmatched and matched findings.
   - Result of 2026-11-12: unclear. The eval results do not store evidence or anchorText (scripts/eval/run.ts items()). A stand-in check of refs in the visible text found 0 bad refs of 26. Moved anchors were more common on true positives (4 of 21) than on unmatched findings (1 of 116), so the penalty must only cap severity. Next: store evidence and anchorText in the eval items with idea 1, then check again on the next baseline.

4. **Fix confirms the defect, makes the smallest fix, and keeps existing rules.**
   - Change: add to the Fix agent (catalog.ts:886-905): "Check the claim of the comment in ./repo first. Fix only a defect that you confirmed." "Make the smallest fix. Add no flag, option, guard, or special case that the defect does not need." "When a comment asks for a special case around an existing rule that applies by design, set why to invalid. Name where the rule applies." "When the user or the author already decided against the change in the thread, set fixed to false."
   - Effect: fewer wrong or large Fix edits.
   - Risk: real fixes refused as invalid. The user sees the reason and can ask again.
   - Cheap check: count discarded Fix edits by `why`, before and after. Add a prompt test.

5. **A scope rule for Fix, and a scope trial for the finder.**
   - Change, Fix: in FIX_WHY_RULES (src/shared/review.ts:490): "A defect that this change adds is always in scope. A request for more than ./context/pr.md or ./context/task.md asks is scope. Propose it as a follow-up in reply."
   - Change, finder: a trial do-not-flag item behind a variant only: "a wider guarantee, another case, or another component that the goal does not ask for, when the change breaks nothing".
   - Risk: the finder item is a "high-signal" kind of rule, and such rules cost recall before (results.md:8). Low priority.
   - Cheap check: label 20 unmatched baseline findings as "more than the goal" or not. Run the variant only when 3 or more match.

## Research check (2026-11-11)

Report: research/research-review-practices.md. No source argues against ideas 1 to 4.

- User decision: build in the order 4, 2, 3, 1, 5.
- Idea 1: ReviewBench, the Martian benchmark, and RovoDev use "a later change addressed the comment" as ground truth. Recall stays a lower bound. Design comments are undercounted.
- Idea 2: indirect support only (Anthropic security-review action: PR text can talk the reviewer out of a finding). The cheap check stays the gate.
- Idea 3: supported (Anthropic: Claude tries to prove or disprove its own findings; ReviewBench "grounded precision"). Keep "cap, never hide".
- Idea 4: supported (Google eng-practices: no code for imagined needs, no needless complexity).
- Idea 5: build the Fix part only. Drop the finder trial: AutoCommenter found about 80% of predictions under a strict threshold still correct, the same loss as U-V1.

New candidates from the research. User decision of 2026-11-11: A, B, and C are approved (build-redesign.md section 7, items 8 to 10). D is not approved.

- A. Addressed rate of posted findings: a later change touched the line, or the thread was resolved. It gives a precision number with no eval run. Stats only.
- B. Sort findings by category, bug first. Sort only, never hide. Built 2026-11-12 (spec.md AC-R25): draftGroups in src/web/review/model.ts.
- C. A "Nit:" prefix on posted minor findings, and a question form for low-confidence findings. Both change posted text; the user approved this. Check first whether catalog.ts already covers them. Built 2026-11-12 (spec.md AC-R26, AC-R27): findingText in src/server/publish/plan.ts. catalog.ts had no nit prefix and no question form. The bold severity mark already gave "**Nit:**".
- D. A per-profile list of noise-prone categories in judge.ts that caps severity after the finder. It never goes into the finder prompt.

Avoid: hide thresholds, strict "high-signal" finder rules, similarity scores as a quality metric, vendor self-benchmarks, LLM-made ground truth.

## Do not build

- User decision of 2026-11-11: the small-model critic after a task part is now approved (build-redesign.md section 7, item 7). It adds to the full review and the verifier (loop.ts:1208-1297).

- An exact-quote check on changed lines. validate.ts:280-288 already checks the anchor and the cause.

## Hard rules

- Every idea keeps the sanitized snapshot and the rl-git tools. None adds Bash to a review or a post without a click.
- A visible "drafted by AI" mark on posted comments changes posted text. It needs a separate user decision.

## Not verified

- That thread claims stop findings (idea 2), and that bad evidence lines predict false positives (idea 3). The cheap checks test both.
- How Fix handles two threads that one edit answers.
