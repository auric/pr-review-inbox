# Verifier rule: refute the problem, not a detail

Status: design of 2026-11-21, made at main 93ff232. Gate VR-0 passed (go, section 6). WP-VR1 is built as an opt-in variant. Gate VR-A is open. The file:line references cite 93ff232. ed9fc03 moved some cited lines down. catalog.ts: +2 after line 1480, so the no-trigger line is catalog.ts:1519. review.ts: +10 after line 195, so `verifyJsonSchema` is review.ts:221. judge.ts: +1 after line 676 and +3 after line 686. The variant "refute-issue" changes only the verify prompts. With the variant off, each prompt byte and each schema byte stays the same. REVIEW_PROMPT_VERSION stays "2.8" until WP-VR2 ships.

## 1. Request and verdict

Request: the finder raised 26% to 29% of the known bugs, but only about 24% were shown. The suspected cause is that the verifier refutes a real problem for two reasons. One trigger detail can be wrong. The verifier can also see a design preference.

Verdict: build a narrow verify-only rule as an opt-in variant, and test it with a cheap replay. This is worth doing only if Gate VR-0 finds enough real findings that the verifier refutes on the current prompt (2.8 with the Fable advisor).

- The premise comes from C1b-era notes. Gate VR-0 checked it on the Gate A baseline: go, narrowly (section 6).
- The rule needs no schema field. A confirmed verdict already puts a found trigger into `reason` (catalog.ts:1517), and the card shows that text.
- The replay needs only two code lines: the new name in `VARIANTS` and in `VERIFY_ONLY`. Every metric already exists.

## 2. Facts

- The verify rules come from one function, `verifyRules` (catalog.ts:1500-1537). rl-verify (catalog.ts:1564) and rl-verifier (catalog.ts:1641) both call it. No other code calls it. The finder, reviewer, and salvage prompts never use it.
- The refute line today: "refuted: the code prevents the trigger, the problem is not in the change, or it is on the do-not-flag list." (catalog.ts:1512). That line refers to the trigger the candidate states. A wrong trigger therefore invites a refute.
- The do-not-flag list holds "a choice between two correct designs" (catalog.ts:622). The finder and the verifier share this list (catalog.ts:1530-1531).
- Shipped precedent for a trigger that the verifier finds: "For a candidate without a trigger, look for one. When you find it, give confirmed, and put the trigger into reason." (catalog.ts:1517).
- Shipped pattern for narrowing a refute: "Never refute it only because …" (catalog.ts:584, 815).
- Verdict schema: `verifyVerdict` (src/shared/review.ts:155-169). `reason` holds at most 1000 characters. `verifyJsonSchema(obligations)` (review.ts:211-212) already gates the schema per variant.
- What a verdict does to a finding (no change here): `capOf` (judge.ts:464-485) and `displayGroup` (review.ts:270-281).
  - refuted: the finding is hidden. A protected bug class, or the outcome "demote", sends it to the More fold instead (judge.ts:830).
  - unsure: the finding goes to the fold, at minor or lower.
  - confirmed: the finding is shown in main when its severity is above nit (balanced).
- Where the reason shows:
  - The card shows "Check: <reason> (<evidence>)" (model.ts:674-678, Drafts.tsx:281 and 328-331).
  - Discuss gets it as "Check reason" (context-files.ts:298).
  - The card shows the finder trigger as "When:" (Drafts.tsx:323-327).
  - A post sends only `it.body` (plan.ts:51-63).
- The replay accepts a variant only if it is in `VERIFY_ONLY` (run.ts:288). `finderChange` and `finderVersion` remove those names (run.ts:291-307), and `replayRefusal` refuses all other profile changes (run.ts:310-323).
  - The check is a declaration only. It does not compare prompt bytes. If a variant changes the finder by mistake, the replay still runs, and its result is wrong. The test in WP-VR1 must catch such a leak.
- Labels carry over between replays. `itemHash` does not include the verdict or the group (label.ts:141-152), and matches are keyed by that hash (label.ts:153). A verify-only replay over the same finder output therefore needs almost no new matcher or judge calls.
- Metrics that already exist:
  - Verifier loss states main, demoted, folded, duplicate, and refuted (score.ts:264-277 and 385-389; compare.ts:47-51).
  - The verifier confusion table, label by verdict, which includes hidden items (score.ts:405-418; compare.ts:180-185).
  - Grounded recall and noise, judge fp per case run in the slices table (compare.ts:191-200), augmented precision, and the paired delta.
- Ceiling from C1b (results.md:28-36, review-quality-2026.md:165): 70 counted must-finds per repeat.
  - Raised 26.4%, shown 23.6%, and shown with the shipped fold 22.1%.
  - So about 2 to 3 bugs per repeat sit in every loss state together. W1's S_R was 5 bugs.
  - A "better" rule based on S_R cannot pass for this variant. A replay against a control replay removes the finder variance, so it can measure the verifier alone.
- Dropped earlier work: `RULES2_REFUTE` (b58265a, removed in 9f3c65b) added examples of what to refute. review-quality-2026.md section 4 rules out such examples as a default. This design adds no examples. It narrows when the verifier may refute.
- Version trap: if REVIEW_PROMPT_VERSION changes, the replay is refused (run.ts:316-318, ab.ts:278-279). WP-RC3 raises it to "2.9". Gate VR-A must therefore run before WP-RC3.

## 3. Options

| | A. Rule, correction in reason (chosen) | B. A plus a `corrected` flag | C. Verifier rewrites the trigger | D. Outcome "demote" for all |
|---|---|---|---|---|
| What | Verify lines under "refute-issue". A confirmed verdict names the wrong detail and the right trigger in `reason`. | A, plus an optional boolean in the verify schema, gated like `verifyJsonSchema(obligations)`, plus a card chip. | settle replaces `trigger` with the corrected one. | Existing `verifier.outcome` keeps every refuted finding in the More fold. |
| Shown recall | Can rise. | As A. | As A. | No change. The fold is not main. |
| Schema and storage | None. | A schema field, the VerifyMark copy, EvalItem, and the UI. | A schema field and a change to the finding text. | None. |
| Eval | Labels carry over, so it costs almost nothing. | As A, plus a "corrected" row. | `itemHash` changes, so new matcher and judge calls run. The gate also mixes two effects. | rescore only. |
| Off bytes | The same. | The same with gating. | The same with gating. | Not applicable. |

Pick A. B and C wait for the gate data (question 3). D does not raise shown recall.

## 4. Design

### 4.1 Variant

- Name: "refute-issue". `VARIANTS` (dto.ts:216-227) gets it in sort order, between "preexisting" and "risk-check".
- `VERIFY_ONLY` (run.ts:288) gets it, in sort order: obligations, refute-issue, risk-check, security2-verify, verify2.
- catalog.ts adds `export const refuteIssue = (p: Partial<Pick<Profile, "variants">>) => has(p, "refute-issue");` and `REFUTE_ISSUE_VERIFY`.
- `verifyRules` adds `...(refuteIssue(p) ? REFUTE_ISSUE_VERIFY : [])` right after the no-trigger line (catalog.ts:1517), before the duplicate line (catalog.ts:1518). Both rl-verify and rl-verifier get the lines. The delegation lines do not change.
- jobs.ts, judge.ts, review.ts, context-files.ts, and the UI do not change.

### 4.2 Prompt lines (REFUTE_ISSUE_VERIFY)

Each sentence has 20 words or fewer. The lines narrow the refute line at catalog.ts:1512. They do not replace it.

1. "Judge the problem of each candidate. The problem is the defect that the candidate names, at its anchor or its cause."
2. "The trigger, the input, the caller, the values, and the fix direction are details. A wrong detail does not refute the problem."
3. "Never refute a candidate only because its stated trigger cannot happen. Look for another trigger of the same defect."
4. "When you find one, give confirmed. In reason, name the wrong detail, and give the right trigger with path:line."
5. "Set severity by the trigger and the wrong result that you found."
6. "When no trigger reaches a wrong result, give refuted. A guard refutes a candidate only when it stops each trigger."
7. "Another defect is another problem, also at the same lines. Never confirm a candidate for another problem."
8. 'Never refute a candidate as "a choice between two correct designs" when it names a case with a wrong result. Check that case.'
9. "A wrong detail is no reason for unsure."

Line 7 keeps "Look for no new problems" (catalog.ts:1533). Line 9 stops a refute from turning into unsure, which would only move the finding to the fold.

### 4.3 Verdict table (variant on)

| Case in the code | Verdict | Reason | Finding |
|---|---|---|---|
| The stated trigger reaches the wrong result. | confirmed | The trigger with path:line, as today. | Main, if above nit (balanced). |
| The stated trigger cannot happen. Another trigger reaches the same defect. | confirmed | The wrong detail and the right trigger with path:line (line 4). | Main. Severity follows the trigger it found (line 5). |
| The candidate has no trigger, and a trigger exists. | confirmed | The trigger (catalog.ts:1517, unchanged). | Main. |
| No trigger reaches a wrong result. A guard stops each trigger. | refuted | The guard with path:line (catalog.ts:1513). | Hidden, or the fold for a protected class. |
| The code has a wrong result, but from another defect. | refuted | Name the guard or the mismatch. | As refuted. The other defect is not reported. |
| Both designs give the right result in each case. | refuted | The do-not-flag item. | As refuted. |
| The candidate names a case with a wrong result, but the verifier sees a design choice. | Judge that case: confirmed or refuted by its trigger (line 8). | As the row that applies. | As the row that applies. |
| The readable code cannot settle any trigger. | unsure | What is missing, as today. A wrong detail alone never gives unsure. | Fold, at minor or lower. |

Question blocks and risk blocks keep their own verdict lines (catalog.ts:1408-1442). The lines above speak only of candidates.

### 4.4 Corrected detail: no schema field

- The correction goes into `reason`, as line 1517 already does for a missing trigger.
- It reaches the card as "Check: …", directly under "When:". It also reaches Discuss as "Check reason". settle copies `reason` into `payload.verify` (judge.ts:519-526).
- Limit: the "When:" line still shows the finder's trigger, and a post sends only the finder's body. If the body holds the wrong detail, the user edits it before posting.
- Without a field, the app cannot count corrections. The eval measures the whole effect instead (section 6). WP-VR1 also records the reason in the eval result, so the user can check it by hand.
- A structured flag (option B) waits for question 3.

### 4.5 Re-review, task own review, Explain

- Re-review and the task own review use the same `verifyRules`, so they get the lines too. Gate VR-A runs `--review-only`, so it measures only first reviews (question 5).
- Explain has the verifier off (catalog.ts:153), so it is not affected.

## 5. Value and cost

- Upper bound on the gain: Lost(control) = lossRefuted plus lossDemoted of the control replay, in bugs per repeat. Gate VR-0 measured Lost = 2.5 bugs per repeat, all of it lossDemoted, with M = 78. So the bound is 2.5 bugs per repeat, or +3.2 points of shown recall. The expected gain is 0 to 2.5 bugs per repeat. Unverified.
- The variant cannot rescue a hidden must-find, because lossRefuted is 0. It can only move a refuted must-find from the More fold to main.
- About 73% of the refuted findings are labelled true (gold or judge label). The variant can therefore gain more on judge-true items than on gold bugs.
- A rescued judge-tp finding that is not in the gold set raises newTp and augmented precision, not grounded recall.
- Runtime cost: prompt lines only. The search for another trigger can add verify turns, about +0% to +10% verify cost. Unverified. The replay measures it.
- Gate cost: one verify-only replay of 100 case runs (50 cases × 2 repeats), about $30 to $65 (half of the risk-check.md section 6 estimate for two replays). Unverified. Labels cost almost nothing, because they carry over by item hash.

## 6. Eval

Run every command from the repo root D:\dev\review-loop, because ab.ts:143 resolves `--baseline` against the cwd. Give the same `--effort` as the baseline when it had one (review-v3.md:186). The baseline has 2 repeats (Gate VR-0). These are unverified:
- its `.calls` folder;
- the result file names under `review-baseline/` and `review-candidate/`.

Definitions:
- M: the counted must-finds per repeat: 78 on the Gate A set (70 on the C1b set). Convert a loss rate to bugs as rate × M.
- Lost(x): lossRefuted plus lossDemoted of result x, in bugs per repeat.
- S_V(m): the absolute difference of metric m between the baseline and the control replay. Both ran the shipped verifier on the same finder output, so S_V is the verifier's own spread.

### Gate VR-0: headroom (zero cost, before the build)

Method:

1. The Joint Gate A control replay (obligations.md section 8, step 2) is reused if it exists. Else run it now. It needs no build:
   `bun run eval:ab -- --baseline eval-results/gate-a/baseline --candidate-replay --review-only --clean 8 --repeat 2 --results eval-results/gate-a/control`
2. `bun run eval:label -- eval-results/gate-a/control --real`. The labels of the baseline carry over.
3. `bun run eval:compare -- eval-results/gate-a/baseline/review-baseline/<file>.json eval-results/gate-a/control/review-candidate/<file>.json`
4. Read the loss rows, the "refuted" row of the confusion table, and the judge fp slice.
5. Go only when Lost(control) is at least 1 bug per repeat and above S_V(Lost). Otherwise stop, and record "no headroom" in the ledger.

### Gate VR-0 result (2026-11-21)

Verdict: go, narrowly. The headroom is 3.2 points of shown recall.

Measured on the Gate A baseline against the Gate A control replay: prompt 2.8, profile 9, 50 cases × 2 repeats, M = 78 counted must-finds per repeat.

- lossRefuted is 0 on both sides. The verifier hides no must-find.
- lossDemoted is 2.5 bugs per repeat (2 and 3) on both sides. A refuted finding goes to the More fold at the balanced volume.
- Lost is 2.5 bugs per repeat. S_V(Lost) is 0, but it comes from one pair, so it is no real spread.
- Confusion over all runs, tp/fp (baseline; control):

| Verdict | Baseline | Control |
|---|---|---|
| refuted | 36/13 | 34/13 |
| confirmed | 151/11 | 155/8 |
| unsure | 7/9 | 4/11 |

- About 73% of the refuted findings are labelled true (gold or judge label). The variant can therefore gain more on judge-true items than on gold bugs.
- The variant must still refute about 6.5 false findings per repeat.
- Grounded noise per case: 1.27 (baseline) and 1.29 (control). Judge fp per case run: 0.11 and 0.08.

### Gate VR-A result (2026-11-21)

Verdict: does not ship. The variant stays opt-in. A later run on the seeded set can measure it with known answers.

- Replay of 100 case runs against the Gate A control replay. 0 failed runs. Baseline reused. Labels complete.
- Rule 1: lossDemoted 3.2% → 1.9% (2.5 → 1.5 bugs per repeat): pass at the floor. Grounded recall 21.8% → 23.1% (+1.0 bug); paired interval +0.0 to +2.7 pts.
- Rule 2 (noise rule of 2026-11-21): grounded noise 1.29 → 1.39, paired delta +0.10 against the limit 0.08: fail. Judge fp 0.08 → 0.09 (+0.01, limit 0.05): pass. Of the +0.10, +0.09 is judge-tp findings and +0.01 judge fp. The judge is not calibrated on this set, so whether the extras are true is unverified.
- Rule 3: severityOk 89.7% → 93.8%: pass.
- Rule 4: failed runs 0 → 0; incomplete runs 1 → 2: fail by the letter. The new incomplete run had no verify phase; an MCP server did not start.
- Rule 5: cost per case $2.500 → $2.484 (−0.6%): pass. Minutes per case 0.85 → 0.93.
- Rule 6 (user spot check of checkReason): open.
- Gold: 2 must-finds rescued, 0 lost. Verdicts: confirmed 163 → 175, refuted 47 → 36, unsure 15 → 14. Judge-tp findings fold → main: 12 in, 3 out.

### Gate VR-A: replay (cheap, after WP-VR1, before WP-RC3)

- Run it from the main checkout after WP-VR1 is merged and the running Gate A eval has ended. Before the first run, check that the run prints the commit that holds the variant.
- Candidate:
  `bun run eval:ab -- --baseline eval-results/gate-a/baseline --candidate-replay --review-only --clean 8 --repeat 2 --candidate-variants refute-issue --results eval-results/gate-a/refute-issue`
- Labels: `bun run eval:label -- eval-results/gate-a/refute-issue --real`
- Compare:
  `bun run eval:compare -- eval-results/gate-a/control/review-candidate/<file>.json eval-results/gate-a/refute-issue/review-candidate/<file>.json`

Metrics:
- Recall gain from refuted-but-real findings: lossRefuted, lossDemoted, and lossMain; grounded recall; the paired delta (information only). The finder output is the same in both replays, so only verdicts move grounded recall.
- Shown noise: grounded noise per case, trap rate, and judge fp per case run.
- Confusion table: the tp and fp of refuted, confirmed, and unsure, over all runs.
- severityOk, failed runs, incomplete runs, cost per case, and minutes.

Ship rule, candidate against control. It mirrors the item 4 rule of review-quality-2026.md on fixed finder output.

1. True findings lost drop: lossDemoted (refuted to the fold) falls by more than S_V(Lost) and by at least 1 bug per repeat. S_V(Lost) is 0 from one pair, so the floor of 1 bug carries this rule. Grounded recall rises by the same amount. If it rises by less, read lossFolded: a refuted finding that turns unsure stays in the fold.
2. False findings kept in main follow the noise rule of review-quality-2026.md section 2, decided by the user on 2026-11-21. This gate is a verify-only replay. The paired grounded noise delta against the control is at most 0.08 per case. The paired judge fp delta per case run is at most 0.05. The trap rate is not higher.
3. severityOk is at least the control minus S_V(severityOk).
4. Failed runs and incomplete runs are not higher. The trigger search can reach the verify turn cap.
5. Cost per case rises by 10% or less. Above that, the user decides.
6. Spot check (user, private data): read `checkReason` of each rescued must-find in the candidate result. Each named trigger must be true in the code.
7. Information only: count the judge-true items that move from the fold to main. They raise newTp and augmented precision, not grounded recall.

The thresholds in rules 1, 5, and 6 are proposals. The user sets them.

## 7. Acceptance criteria

AC-R50 to AC-R55 belong to obligations.md, and spec.md ends at AC-R39. AC-R56 to AC-R59 are free in the repository. The "Minor fold" design is not in the repository, so its numbers are not checked. WP-VR2 copies these criteria into spec.md.

- AC-R56. Without the variant, each verify prompt byte and the verify --json-schema stay the same. The pinned hashes prove it (prompt.test.ts:553-569, risk-check.test.ts:206-235, obligations.test.ts:205-208).
- AC-R57. With the variant, rl-verify and rl-verifier hold REFUTE_ISSUE_VERIFY once, right after the no-trigger line. This also holds with questions and with risks.
- AC-R58. With the variant, the prompts of rl-main, rl-reviewer, and salvage, and the verify --json-schema, stay the same. `finderChange` ignores the name, `--candidate-replay` accepts it, and `promptVersion` gives "2.8+refute-issue".
- AC-R59. An eval run records the verify reason of each finding item as `checkReason`. No metric reads it.

## 8. Work packages

| # | Package | Tier | After | Files | Tests | Done when |
|---|---|---|---|---|---|---|
| 0 | WP-VR-D: save this design | implementer | none | docs/plans/review-v2/verifier-rule.md; review-ledger.md (new row, section 1 count of opt-in variants 10 to 11, section 2 and section 4: the replay runs before WP-RC3) | none | The files are committed. |
| 1 | Gate VR-0 | user | WP-VR-D | none | Section 6. | Done 2026-11-21: go, narrowly (section 6). |
| 2 | WP-VR1: the variant, the replay wiring, and `checkReason` | implementer | Gate VR-0 is go | src/shared/dto.ts (VARIANTS and its comment); src/server/review/catalog.ts (refuteIssue, REFUTE_ISSUE_VERIFY, verifyRules); scripts/eval/run.ts (VERIFY_ONLY; `checkReason: p.verify?.reason` in `items`); scripts/eval/score.ts (`EvalItem.checkReason?: string`); docs/eval/local.md (one variant bullet) | A new tests/review/refute-issue.test.ts that prints its import path, in the shape of risk-check.test.ts:237-249. It covers AC-R57 and AC-R58, the 20-word and no-CRITICAL check of the new lines, and SHIPPED_PROFILES without the variant. Control mutation: put line 1 into finderRules, and the finder-bytes test turns red. Updates: tests/review/prompt.test.ts:1123 (VARIANTS); tests/eval/harness.test.ts:186 (VERIFY_ONLY), 334 (error text), and a finderChange case; the run test at harness.test.ts:679 asserts checkReason; tests/eval/ab.test.ts:570 (error text) plus a replay parse case beside 629-639. | `bun run check` is green. The diff changes no pinned hash. The work runs in a sibling worktree, because the running eval reads D:\dev\review-loop. |
| 3 | Gate VR-A | user | WP-VR1 merged; before WP-RC3 | none | Section 6. | The ship rule passes, and the user approves. Record the numbers in docs/eval/results.md and the ledger. Done 2026-11-21: fail, see "Gate VR-A result". |
| 4 | WP-VR2: ship the rule | implementer | Gate VR-A. Share the "2.9" step with WP-RC3 and WP-OB3 when all pass. | catalog.ts (lines always on, remove refuteIssue); dto.ts and run.ts (remove the name; an old profile with it drops on read, dto.ts:297-301); src/shared/review.ts (REVIEW_PROMPT_VERSION and its comment); spec.md (AC-R56 to AC-R59); docs/eval/results.md; docs/eval/local.md; CHANGELOG.md (the check keeps a real finding with a wrong detail and names the right trigger) | The pinned verify hashes update together with the version (prompt.test.ts:564, risk-check.test.ts:206-235, the agents hash at obligations.test.ts:206). refute-issue.test.ts checks "always on". | `bun run check` is green. No UI change, so no screenshots. |

Run order: 0, 1, 2, 3, 4. Run one implementer at a time. Run the finder variants "preexisting" and "callers" against the Gate A baseline before WP-VR2, because the version step stops all replays and reuses of that baseline (review-ledger.md section 2).

## 9. Invariants

- Only rl-verify and rl-verifier get the verify rule lines (catalog.ts:1564, 1641). A grep finds no other caller of `verifyRules`.
- With the variant off, the bytes stay the same: the hashes above pin them, and `verifyJsonSchema` does not change.
- The replay is valid only if the finder bytes stay the same. VERIFY_ONLY is a declaration, so the AC-R58 test must check the bytes.
- Labels carry over between control and candidate (label.ts:141-153).
- The correction reaches the card and Discuss with no code change (model.ts:674-678, Drafts.tsx:328-331, context-files.ts:298). A post sends the body only (plan.ts:51-63).
- A changed REVIEW_PROMPT_VERSION refuses the Gate A recording (run.ts:316-318, ab.ts:278-279).

## 10. Open questions

1. Is the variant name "refute-issue" right? Recommended: yes.
2. Gate VR-0 needs at least 1 bug per repeat, ship rule 1 needs a drop of at least 1, and rule 5 allows +10% cost. Accept these numbers? They are proposals.
3. At ship time, add a structured `corrected` flag and a card chip (option B), or keep only the reason? Recommended: keep only the reason, and decide after two weeks of Review quality data. The "When:" line and the posted body keep the finder text.
4. Ship with the "2.9" step of WP-RC3 and WP-OB3 when all gates pass? Recommended: yes.
5. The lines also reach the re-review and the task own review, but the replay measures only first reviews. Accept? Recommended: yes. Also unverified: does the ledger row "Verifier rule replay" mean this rule? Its source is the audit outside the repository, so that row stays as it is.

## 11. Out of scope

- The More fold for nits and TODOs ("Minor fold" design).
- The do-not-flag items "behavior that the pull request text or the task asks for" and "the problem is not in the change".
- The verifier model and effort (review-quality-2026.md item 6b).
- A rewrite of the finding text by the verifier (option C).
