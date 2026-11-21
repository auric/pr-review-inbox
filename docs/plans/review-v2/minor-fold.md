# Minor fold: polish points in the "More" fold

Status: design of 2026-11-21, main at 93ff232. WP-MF1 and WP-MF2 are built as the opt-in variant "minor-fold". The Gate MF-A probe failed rule 1 on 2026-11-21 (section 6.7). The user paused the package on 2026-11-21. The variant stays opt-in. No local-set run follows. WP-MF3 is not started. Prompt 2.9 ships the pre-existing lines, so the polish lines now follow them.

## 1. Why

- A colleague's review tool found items on 5 real PRs that our review never reports. Four were minor kinds: a TODO left in new code, a naming point, a small clarity point, and a stale comment.
- Goal: the finder reports such points into the "More" fold of the Drafts list. The app never posts them by default. The user posts one with Accept, as any other draft.

## 2. What the prompts do today (checked at 93ff232)

The default prompt rules out all four kinds:

- The finder and the verify phase both get the do-not-flag item "style, naming, formatting, or comment wording" (catalog.ts:614-631, 1530-1531).
- The verify phase refutes a candidate "on the do-not-flag list" (catalog.ts:1512). A refuted finding is hidden (review.ts:274).
- At "Balanced" and "Only what matters", the finder rubric says "nit: optional polish. Give no nits." (catalog.ts:668-679). The shipped Review profile is "Balanced" (catalog.ts:133).
- The trigger rule asks for "the wrong result" (catalog.ts:600). capOf makes a question of a finding with no trigger and no confirmed verdict (judge.ts:477-478). A TODO has no wrong result.
- No default line names TODO or FIXME. The "docs" module checks stale comments, but it is not a default module (catalog.ts:132, 735-741).
- BRIEF.md:452 says: "No finding for compiler, linter, or formatter output, style, or naming."

What fills the "More" fold today (review.ts:276-279): unsure findings (capped at minor, judge.ts:483), demoted refuted findings, and nits. At "Balanced" the finder gives no nits. So the nits come from the verify phase, which lowers the severity "for a rare trigger or a small impact" (catalog.ts:1527). Opt-in sources also give nits: the simplify module (catalog.ts:165), "obligations" (catalog.ts:1486), and "risk-check" (catalog.ts:1441). That is why few nits appear, and none of the four kinds.

## 3. Decisions

- D1. A new opt-in variant "minor-fold". With it off, every prompt, both --json-schema files, and candidates.md stay byte-identical to 2.8.
- D2. A new finding field `polish` (boolean). The CLI schema has it only under the variant, as for `preexisting` (review.ts:59-70). The field is not named "minor", because the prompts use "minor" as a severity.
- D3. The mark sets the place, not the severity. displayGroup puts a polish item into "fold" at quiet and balanced, whatever its severity. At "thorough" it shows in main and counts as polish, because "thorough" has no fold (model.ts:623). So at the eval volume a polish item never reaches main, also when the check rates it minor.
- D4. Polish points stay in the same verify call, with a claim-only check. No new process starts. Without verify lines, the do-not-flag rule refutes them. Without any check, capOf turns each one without a trigger into a question.
- D5. At most POLISH_MAX = 3 polish points per run. One prompt line asks for this, and settle caps it, as for PREEXISTING_MAX (judge.ts:866-878).
- D6. Never posted by default needs no new code. Only Accept and then the post confirm post an item (publish/plan.ts:120). items.ts refuses Accept only for a pre-existing finding (items.ts:98). The task loop gets one exclusion: mustFixPoint skips a polish item (tasks.ts:810-811), so the loop never fixes one without a click.
- D7. No UI change. The fold card already shows the severity and the category (Drafts.tsx:337). The category names the kind.

## 4. Kinds and prompt lines

| Kind (category) | What it is | Evidence that the check and the judge can read |
|---|---|---|
| todo | An added TODO or FIXME that names no ticket and no PR. | The added line. |
| stale | A comment next to changed code that the change made false. | The comment and the changed code (cause). |
| naming | A name that states something false about its code, or that breaks the naming pattern of its own file. | The name, or a line of the pattern. |
| clarity | Added commented-out code or a debug print, or a value whose named constant the repository has. | The added line, or the constant. |

The eval judge gives fp to "a style point with no effect" unless the code breaks "a convention of its own files" (label.ts:81). Each kind above meets that bar.

Finder lines, POLISH_LINES, in finderRules after PREEXISTING_LINES. So rl-main, rl-reviewer, and salvage get them. Salvage needs them, because it shares the review schema (jobs.ts:1398).

```ts
export const POLISH_LINES = [
  "You can also report polish points. A polish point is no defect, but a reviewer would ask the author to fix it.",
  'The do-not-flag list and the line "Give no nits" do not apply to polish points.',
  "Report only these kinds of polish points, and set category to the kind:",
  "- todo: an added line holds a TODO or FIXME. The line names no ticket and no pull request.",
  "- stale: a comment next to changed code states something false about the code at the head.",
  "- naming: a new or changed name states something false about what its code does.",
  "- naming: a new name breaks the naming pattern of its own file. Give a line of that pattern in evidence.",
  "- clarity: an added line holds commented-out code or a debug print.",
  "- clarity: an added line holds a value whose named constant the repository already has. Give that constant in evidence.",
  "Never report wording, grammar, formatting, or a choice between two good names.",
  "A defect, or a false doc that users or callers act on, is no polish point. Report it as a finding.",
  "Anchor a polish point on its line. When that line is unchanged, set cause to the changed line that makes it false.",
  "Set severity to nit. In trigger, say what a reader gets wrong, or what stays undone.",
  `Report at most ${POLISH_MAX} polish points. Pick the points that a reviewer would most likely ask to fix.`,
  "Set polish to true on each polish point. Set polish to false on every other finding.",
];
export const POLISH_REVIEWER = "Also report polish for each finding.";
// review.ts, the CLI field under the variant:
const POLISH = z.boolean().describe("true only for a polish point: todo, stale, naming, or clarity. Else false.");
```

candidates.md gets the line "- Polish: yes." after the pre-existing line (context-files.ts:113-114).

Verify lines, POLISH_VERIFY, in verifyRules after PREEXISTING_VERIFY. rl-verify and rl-verifier both get them.

```ts
export const POLISH_VERIFY = [
  'A candidate with the line "Polish: yes" is a polish point. Its category names its kind: todo, stale, naming, or clarity.',
  "For a polish point, check only the claim at its anchor and its cause. Do not look for a trigger.",
  'The do-not-flag item "style, naming, formatting, or comment wording" does not apply to a polish point.',
  "Confirm a todo point only when the line is added and names no ticket and no pull request.",
  "Confirm a stale point only when the comment states something false about the code at the head.",
  "The change must also touch that code or make the comment false.",
  "Confirm a naming point only when the name states something false, or the cited pattern holds in its file.",
  "Confirm a clarity point only when the line is added and holds what the candidate says.",
  "Refute a polish point about wording, grammar, formatting, or a choice between two good names.",
  "When a polish point and another candidate describe one problem, the polish point is the duplicate.",
  "Never give question for a polish point. Set its severity to nit.",
];
```

All lines pass the longSentences check of prompt.test.ts:104-105. The draft was run through it.

Overlap with other rules:
- risk-check rule 15 (catalog.ts:1439-1441) also confirms a false comment or TODO as a nit. With both variants, the polish candidate exists first, so the risk gets "duplicate".
- obligations own docs, guides, and contracts that consumers read (catalog.ts:1455). The polish lines leave out "a false doc that users or callers act on".
- The docs module keeps a wrong doc that a reader acts on as a normal finding (catalog.ts:739-740).
- A polish point is never pre-existing (catalog.ts:577). validate keeps at most one of the two marks.

## 5. Data path

| Step | File and symbol | Behavior with the variant |
|---|---|---|
| Schema | src/shared/review.ts finding, findingList, reviewJsonSchema, rereviewJsonSchema | `polish: z.boolean().optional()` on finding. findingList(preexisting, polish) adds POLISH only when on. The default schema bytes stay (prompt.test.ts:1054). |
| Call sites | src/server/review/jobs.ts:1139, 1152, 1884 | Pass minorFold(profile) beside preexisting(profile). |
| Validate | validate.ts validate, ValidateInput.polish | Keep the mark only under the variant and not on a pre-existing finding. The anchor rules stay: an unchanged comment needs a cause on a changed line, else it drops (validate.ts:298-307). |
| Verify | context-files.ts candidatesFile; catalog.ts verifyRules | "- Polish: yes." and POLISH_VERIFY. A polish block counts as one candidate in VERIFY_SPLIT and in verifyMaxTurns (jobs.ts:264, 1460). |
| Settle | judge.ts settle | A new polish item that ends as a question drops. Keep the first POLISH_MAX new polish items, ordered by check (checked, unsure, unchecked) and then by confidence. Each kind of drop adds one notChecked line. Carried items are not capped. |
| Display | src/shared/review.ts displayGroup | `if (p.polish === true && (volume === "quiet" \|\| volume === "balanced")) return "fold";` after the preexisting line. stats.ts, model.ts, useTriage.ts, and eval run.ts all read displayGroup. |
| Post | none | Accept and the post confirm post a polish item like any draft. |
| Task loop | src/server/tasks/tasks.ts mustFixPoint | Add `&& p.polish !== true`. |

- notChecked lines: "N polish points were left out: the check asked a question, or no trigger was named." and "N polish points were left out: a run shows at most 3."
- A refuted polish item hides, as today. With "Refuted findings: Show last" it is demoted and stays in the fold.
- With the verify phase off, a polish item shows "Not checked" in the fold. One without a trigger drops.

## 6. Eval

### 6.1 Noise

- noise, groundedNoise, precision, and falsePositives count only group "main" (score.ts:390-391, 497, 531, 597-600). At quiet and balanced a polish item is in "fold", so it never counts as noise. The noise formula stays.
- run.ts and eval:ab use the profile volume, "balanced", when no --volume is given (run.ts:202, 959). ab.ts has no volume flag.
- At --volume thorough, polish items are in main and count as noise. The gate does not run thorough.
- Pre-existing items leave the item list (score.ts:495-496). Polish items stay in it. So a must-find that only a polish item raises shows as "verifier loss, folded" and as a recall drop.

### 6.2 New counts (WP-MF2)

- run.ts items(): set `polish: true` on an EvalItem when the payload has it. itemHash keeps its fields (label.ts:142-152), so the stored labels stay valid.
- Metric `polish`: non-hidden polish items per case run.
- Metric `polishRecall` (rate, line match): bugs with severityMin nit that a non-hidden polish item matches, over all bugs with severityMin nit. It needs no labels, so the probe can use it.
- Metric `polishTraps` (line match, t = 0): non-hidden polish items on a trap, per case run.
- Row Score.polish (grounded): the preCounts counts (score.ts:477-490) over non-hidden polish items, plus `must`: items whose gold match is a counted must-find. compare.ts prints the row as "Polish points (minor-fold.md)".
- Polish true rate = (gold - must + judge tp) / (gold + judge tp + judge fp). A must-find match counts as not true: it is a defect in the wrong place.
- The judge prompt stays. A change of JUDGE_PROMPT changes JUDGE_HASH and voids every stored label (label.ts:135-137). The judge already labels each unmatched item in any group (label.ts:571-581).

### 6.3 Probe cases

Two cases in fixtures/eval/probe/, in the format of probe-obl-doc-contract. No real names. Each has one bug at severityMin nit. Recall at balanced leaves such bugs out (score.ts:28-34), so only polishRecall counts them.

| ID | Change | B1 (nit) | Traps |
|---|---|---|---|
| probe-polish-todo | src/upload/retry.ts gets retryDelayMs(), an exponential delay with a cap, and a test. It adds "// TODO: read the delay cap from the settings file." and "// TODO(SHOP-51): move the base delay to the client options." | The added TODO with no ticket. Module core. | T1: the added TODO that names SHOP-51. It tests the ticket rule. T2: `2 ** (attempt - 1)`. attempt counts from 1, as the test shows. |
| probe-polish-stale-comment | src/contacts/dedupe.ts: the PR makes the newest entry for an email win. `if (!byEmail.has(key)) byEmail.set(key, c);` becomes `byEmail.set(key, c);`. The unchanged comment above it still says "Keep the first entry for each email." | The stale comment line, new side. alt: the changed set line. Module docs. | T1: the unchanged comment "Emails compare in lower case." It is still true. |

- The probe limits hold: 1 bug, 1 to 2 traps, 10 to 200 changed lines (harness.test.ts:356). Each case has a trap (cases.ts:117).
- tests/eval/probe.test.ts:50-62 pins 16 cases and the kind map. It becomes 18 cases, with the kind "polish point" for the prefix probe-polish-. tests/eval/w1.test.ts:222 and 351 may count the probe set too.
- probe-obl-doc-contract (B1 minor, docs) guards the other side. A false API doc must stay a normal finding.

### 6.4 Ship rule (Gate MF-A)

Run the probe first. Stop when it fails.

Probe, control and candidate, repeat 2:
1. eval:label calibration gives tp to both seeded polish bugs. calibrationGold includes nit bugs (label.ts:586). If it does not, rule 7 cannot pass. Stop and tell the user.
2. polishRecall is at least 75%: 3 of the 4 case runs.
3. polishTraps is 0.
4. Probe recall and trap rate are not below the control.

Local set, the Gate A baseline against the candidate:

5. Grounded recall: the mean is at least the baseline mean minus S_R.
6. Noise follows the noise rule of review-quality-2026.md section 2, decided by the user on 2026-11-21. This gate is a full candidate run. The paired grounded noise delta against the baseline is at most 10% of the baseline mean per case. The paired judge fp delta per case run is at most 0.07.
7. The polish true rate is at least 50%, the bar of obligations.md section 8 rule 3. It needs at least 10 labelled polish items. With fewer items there is no result, and the user decides.
8. Question items per case run rise by no more than the baseline spread.
9. Cost per case rises by 10% or less, and minutes by 1.0 or less. Above that, the user decides.
10. notCompleted and incomplete are not higher.

### 6.5 Commands

```
# Step 1: the probe. Both sides run fresh, because the probe set gains 2 cases.
bun run eval -- --real --set probe --repeat 2 --out eval-results/minor-fold/probe-control
bun run eval -- --real --set probe --repeat 2 --variants minor-fold --out eval-results/minor-fold/probe-candidate
bun run eval:label -- eval-results/minor-fold/probe-control --real
bun run eval:label -- eval-results/minor-fold/probe-candidate --real
bun run eval:compare <probe-control result.json> <probe-candidate result.json>
# Step 2: the local set. No --candidate-replay, because the variant changes the finder (run.ts:286-321).
bun run eval:ab -- --baseline <Gate A folder> --candidate-variants minor-fold --review-only --repeat <Gate A repeat> --clean <Gate A N> --results eval-results/minor-fold/local
bun run eval:label -- eval-results/minor-fold/local --real
bun run eval:compare <baseline review result.json> <candidate review result.json>
```

- The Gate A folder, its --repeat, and its --clean are unverified. reuseRefusal (ab.ts:256-290) refuses a mismatch and names it.
- Run step 2 before REVIEW_PROMPT_VERSION moves. A new version voids the 2.8 baseline (review-ledger.md section 2).
- It is unverified whether Gate A ran the re-review mode. If it did, remove --review-only.

### 6.6 Acceptance criteria

- AC-R60. With the variant off, every prompt, both --json-schema files, and candidates.md keep their bytes. With it on, rl-main, rl-reviewer, and salvage get POLISH_LINES after the pre-existing lines, rl-reviewer gets POLISH_REVIEWER, and the CLI schema lists polish. validate.ts keeps the mark only under the variant and never on a pre-existing finding.
- AC-R61. settle drops a new polish point that ends as a question. It keeps at most POLISH_MAX new polish points, by check and then by confidence. Each kind of drop adds one notChecked line. Carried polish points are not capped.
- AC-R62. displayGroup puts a polish point into fold at quiet and balanced, whatever its severity, and into main at thorough. A refuted polish point hides.
- AC-R63. candidates.md gives the line "- Polish: yes." only for a marked candidate. rl-verify and rl-verifier get POLISH_VERIFY after PREEXISTING_VERIFY.
- AC-R64. Accept and the post confirm post a polish point like any draft. Nothing posts it without Accept.
- AC-R65. mustFixPoint never picks a polish point.
- AC-R66. The eval metrics polish, polishRecall, and polishTraps count polish points that are not hidden. A polish point in the fold changes no other metric, unless it raises a counted must-find.
- AC-R67. Score.polish counts gold matches, must, and judge labels. compare.ts prints the row "Polish points (minor-fold.md)" with the true rate.

### 6.7 Gate MF-A result (2026-11-21)

Only the probe step ran. The probe has the cases probe-polish-todo and probe-polish-stale-comment.

| Rule | Result | Pass |
|---|---|---|
| 1. Calibration gives tp to both polish bugs | The judge gives fp to the TODO bug of probe-polish-todo: "not a merge blocker". It gives tp to the stale comment bug of probe-polish-stale-comment. | No |
| 2. polishRecall is at least 75% | 100% | Yes |
| 3. polishTraps is 0 | 0 | Yes |
| 4. Probe recall and trap rate are not below the control | Recall 87.5% to 91.7%. Trap rate 0 on both sides. | Yes |

- Rule 1 fails, so the gate stops at the probe (section 6.4).
- Decision of the user on 2026-11-21: pause minor-fold. The variant stays opt-in. Do not run the local set.

## 7. Work packages

Build each package in a sibling worktree, because the main checkout runs an eval. Run one package at a time.

| # | Package | Tier | After | Files | Tests | Done when |
|---|---|---|---|---|---|---|
| 1 | WP-MF1: the variant in the app | implementer | none | src/shared/dto.ts (VARIANTS: "minor-fold" after "classes"); src/shared/review.ts (finding.polish, POLISH_MAX, findingList, reviewJsonSchema, rereviewJsonSchema, displayGroup); src/server/review/catalog.ts (minorFold, POLISH_LINES, POLISH_REVIEWER, POLISH_VERIFY in finderRules, reviewerAgent, verifyRules); context-files.ts; validate.ts; judge.ts (judge, settle); jobs.ts (3 schema sites); src/server/tasks/tasks.ts (mustFixPoint) | tests/review/prompt.test.ts: the off hashes stay (564, 1054); a "preexisting"-only schema has no polish key; the lines sit in place for main, reviewer, salvage, verify, and verifier; the ASD list (1099-1118); VARIANTS (1123); promptVersion "2.8+minor-fold". New tests/review/minor-fold.test.ts: the validate mark, the settle drop and cap, carried items not capped, displayGroup by volume and severity, Accept and the post plan of a polish item, mustFixPoint. tests/review/jobs.test.ts: the schema under the variant. | `bun run check` is green. |
| 2 | WP-MF2: eval counts and probe cases | implementer | WP-MF1 | scripts/eval/run.ts, score.ts, compare.ts; fixtures/eval/probe/probe-polish-todo/ and probe-polish-stale-comment/; fixtures/eval/README.md; docs/eval/local.md | tests/eval/score.test.ts: a fold polish item changes no metric except the polish ones; a polish item on a must-find shows in `must` and in lossFolded. tests/eval/probe.test.ts: 18 cases and the kind "polish point". Fix w1.test.ts, harness.test.ts, ab.test.ts, and rereview.test.ts where they break. | `bun run check` is green. A fake run prints the polish rows. |
| 3 | Gate MF-A | user | WP-MF2 | none | Section 6.4. | The user decides. |
| 4 | WP-MF3: ship | implementer | Gate MF-A passes | review.ts (REVIEW_PROMPT_VERSION and its comment); catalog.ts, jobs.ts, validate.ts, judge.ts (on without the variant); dto.ts and run.ts (remove "minor-fold"); BRIEF.md:452; spec.md sections 1.4 to 1.6 (do-not-flag, nit rule, verify rules, acceptance criteria); stats.ts (a polish count, if the user wants it); CHANGELOG.md; README.md:108; docs/eval/results.md | Snapshot updates. An old profile with "minor-fold" reads without it. | `bun run check` is green. |

## 8. Docs

- Now: save this file. Add a row "Minor fold: variant minor-fold" to review-ledger.md with the status "Designed, not started".
- After WP-MF1 and WP-MF2: set the ledger row to "Opt-in". Add no CHANGELOG or README line. config.json is the only switch, as for 81d86d4.
- After Gate MF-A: add an entry to docs/eval/results.md and update the ledger.
- WP-MF3: one CHANGELOG line and one README sentence in the Drafts paragraph (README.md:108). No new screenshots: the UI does not change.

## 9. Risks

- The finder can report a defect as a polish point, so it leaves main. The guards are the finder line, the verify duplicate line, the `must` column, and the recall rule.
- Verify cost: up to 3 more blocks. A run with 10 to 12 candidates can pass VERIFY_SPLIT and start rl-verifier calls (jobs.ts:1460).
- The unchanged judge is strict. Naming and clarity points can read fp as "Trivial" (label.ts:81), and then rule 7 fails. That is the intended bar.
- Runs can give few polish items. Under 10 labelled items, rule 7 gives no result.
- BRIEF.md:452 forbids style and naming findings. To ship, the user must change BRIEF.

## 10. Open questions, decided by default

The orchestrator set these defaults on 2026-11-21. The user can change each one.

1. Does the clarity kind (added commented-out code, a debug print, or a value with an existing named constant) cover the colleague's clarity point? Open: check it against the 5 PRs.
2. A TODO that names a ticket: skip it. Default.
3. POLISH_MAX is 3, the true-rate bar is 50%, and the cost cap is 10% and 1.0 minute. Default.
4. At "Show everything", polish points show in main as polish. Default.
5. BRIEF.md:452 changes only at WP-MF3, not before. Default.
