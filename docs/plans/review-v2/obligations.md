# Obligations

Status: design of 2026-11-18. WP-OB1 (07c4d80) and WP-OB2 (dce9f3d) are built as the opt-in variant "obligations". Joint Gate A, WP-OB3, and WP-OB4 are open. It builds on risk-check.md (WP-RC1 to WP-RC4). REVIEW_PROMPT_VERSION stays until WP-OB3. The criteria AC-R48 to AC-R55 go into spec.md section 1 in WP-OB3.

## 1. Request and verdict

The user wants a light "obligations" step: our low-noise take on the "ideal design sketch" of another review app. The user rejects heavy UX.

Verdict: build a narrow obligation check inside the existing verify phase. Do not build a blind sketch run.

- An obligation is a thing that must be true at the head for the change to be complete, whatever design the author chose.
- The verify agent finds at most 5 obligations from the changed public surface and the task criteria. It checks each one with Grep or CodeGraph.
- A missing obligation becomes a draft only with a quote that the app finds in the cited file at the head.
- Each other outcome is one line in a collapsed toggle.
- No new run, no new snapshot, no new item kind, no migration, and no new panel.

## 2. Facts

Comparison of 5 real PRs (the user, 2026-11-17, with author verdicts checked against the fix commits):

- The other app found 10 real problems on 3 fair PRs. Ours found 3. Both raised 2 non-problems (precision 86% and 80% over the 5 PRs).
- The two most useful misses were omissions that a diff review cannot see. The other app's sketch found both.
- Miss 1: a missing test that guards the exported symbols of a library, after the PR changed the exports.
- Miss 2: a user guide that the PR left stale: an old function signature, and no per-OS behavior.
- Obligations can also catch these misses in part: a criterion met in part with no link to the follow-up ticket, a doc contract that the code no longer matches, and a doc that contradicts itself after the change.
- Both apps missed a doc with steps in the wrong order and an older-code check that reads only an old OS key. This design does not target them.
- The other app's sketch drafts: 34% discarded against 8% for normal findings, about 75% of the authors' "this is intended" push-back, and $2.65 per posted finding.
- Its own next step (not built) keeps only obligations, needs a named consumer, and allows at most 2 design findings.

Our code:

- The finder is told to skip both headline cases. The do-not-flag list holds "a missing test, unless the Tests check is on" and "comment wording" (catalog.ts:582, 590).
- The shipped Review profile has no tests module and no docs module (catalog.ts:124).
- The api module greps the users of a changed public interface and reports a broken user (catalog.ts:684-691). It asks for no test and no doc.
- The intent module lists the criteria and reports an unmet one (catalog.ts:712-722).
- The verify rules end with "Look for no new problems. A finder already ran." (catalog.ts:1375).
- The verify phase starts only with candidates or questions (jobs.ts:1326-1329). WP-RC1 adds risks. A clean finder result gets no check.
- verifyMaxTurns is max(12, min(maxTurns, 10 + 3 × blocks)) (jobs.ts:254). VERIFY_SPLIT is 12 blocks (catalog.ts:1310).
- The `finding` key of a verify verdict has the place, the title, and the body, but no cause (review.ts:144-152). placeAnswers anchors it with the finder validator (judge.ts:506-528).
- The validator keeps a finding off the changed lines only when its cause is on a changed line (validate.ts:292-301).
- readBlobs reads files from the cache clone at the head, never from the sanitized worktree. repoPath normalizes each path (judge.ts:217-237, validate.ts:60).
- Each gap makes a run incomplete (judge.ts:211-212). settle puts the cut notes of the verify result into gaps (judge.ts:557-559).
- Under "balanced", a confirmed minor finding shows in the main list. A nit goes to the fold "More" (review.ts:225).
- The task own review runs the verify phase. The critic does not (jobs.ts:1784-1798).
- Only confirmed blocker and major points enter the fix loop of a task (tasks.ts:784-785).
- Explain has the verifier off (catalog.ts:145).
- reviewJsonSchema(explain) leaves a key out of --json-schema (review.ts:128-129). The same pattern keeps the verify schema the same without the variant.
- The eval replays the recorded finder calls and runs the verify calls live (run.ts:649-660).
- replayRefusal refuses a change of the finder prompt version or of the profile (run.ts:309-321).
- The message of commit 301e82b says that the stored C1b baseline is old, and that a new baseline run is needed.
- pr-context.md lists the linked tasks and the other open pull requests that change the same files (context-files.ts:829, 867).
- Our own test of a fixed checklist in the finder gave no gain (research/review-practice-2026-11.md:56, item T10).

## 3. Options

| | A. Blind sketch run | B. Finder module | C. Obligation check in the verify phase (chosen) | D. Tests and Docs modules on |
|---|---|---|---|---|
| What | A separate run before the finder, on a snapshot at the merge base, with the task text only. The review then compares the PR to its points. | A new check section of rl-main and rl-reviewer lists obligations and reports the missing ones. | The verify agent finds at most 5 obligations, checks each, and returns a list. | A profile change only. |
| Sees the diff | No. It guesses the changed surface from the task text. | Yes. | Yes. It also sees the finder findings. | Yes. |
| Recall of omissions | Medium. | Medium. The finder budget goes to the changed lines. T10 found no gain for a checklist in the finder. | Medium to high. A separate step with a fixed scope and a search mandate. Unverified. | Low to medium. |
| Noise | High: the other app's 34% discards. | Medium. No met lines. | Low to medium. Each draft needs an app-checked quote, a changed-line anchor, and a consumer. Repeats end as covered. | High. The modules ask for a test and a doc for each changed behavior. The do-not-flag item exists for this reason. |
| Cost per review | About +$0.5 to +$1.0. Unverified. | About +$0.1 to +$0.3. Unverified. | +$0.10 to +$0.35. Unverified (section 7). | Finder turns. Unverified. |
| Latency | +1 to +2 min on the critical path. Unverified. | +0.3 to +1.0 min. | +0.3 to +1.0 min. Unverified. | Small. |
| Code | Large: a base snapshot, a run kind, a schema, and a compare step. | Small, but a met or missing list needs a finder schema change. | About 500 to 700 lines with tests, in the shape of WP-RC1. Unverified. | None. |
| Eval | Full runs only. | A full candidate run, about $165. | A verify-only replay and cheap probe cases. | A full candidate run with --candidate-modules. |
| UX | A list of points per PR. | Findings only. | One collapsed line. | Findings only. |

Pick C.

- A pays for blindness that obligations do not need.
- B and D change the finder. Past finder edits did not improve the finder (review-quality-2026.md items 1, 3, and 4 failed in W2 and W3).
- C reuses the check step, its tools, and the risk-check machinery.

### Is "blind to the diff" worth its cost?

No, not for obligations.

- A surface obligation comes from the changed surface. A blind step must guess that surface from the task text.
- Blindness protects against anchoring on the author's design. Obligations leave design choices out, so that risk is small.
- The cite rule keeps criteria independent of the code: a criterion obligation quotes the task text.
- Blindness costs a base snapshot, its index, and a run on the critical path.
- The other app's data shows its sketch as its noisiest and costliest source.

### Why a second look can find what the finder missed

- The finder rules tell it to skip a missing test and doc wording (catalog.ts:582, 590).
- The api module asks only for broken code users. It does not ask for docs, guides, or tests.
- The obligation check has one narrow job, its own turns, and explicit exceptions to those two items.
- This reason is unverified. Gate A and Gate OB-B measure it.

### Relation to risk-check.md

- Option C of risk-check.md was a new stage with an entry for each criterion. Section 11 keeps that ledger out of scope.
- This design is no new stage and no ledger. The list has at most 5 entries of mixed kinds.
- The risk check stays as designed. A risk that already raises an obligation makes the obligation "covered".

## 4. Design

### 4.1 Mode and start

| Mode | Condition | Result |
|---|---|---|
| off | The profile lacks the variant "obligations" (before WP-OB3). Or the verify step of the profile is off. Or the run is a re-review, an Explain run, or a task critic run. | No `obligations` key in the summary. The verify phase starts only for blocks, as before. Each prompt byte stays the same. |
| on | The variant is on (from WP-OB3: always). The verify step is on. The run is a first review or a task own review. | The verify phase also starts with zero blocks. rl-verify gets OBLIGATION_RULES. The verify schema gets the `obligations` key. |

- With zero blocks, candidates.md holds only its head.
- With zero blocks, the task line says: "Check the obligations of the change <base>..<head> in ./repo, as your instructions say."
- With blocks, the task line adds: "Then check the obligations of the change, as your instructions say."
- verifyMaxTurns counts MAX_OBLIGATIONS as blocks. With zero blocks, the cap is 25 turns.
- Above VERIFY_SPLIT, the main agent checks the obligations itself. The delegation adds: "Check the obligations yourself. Give none to the rl-verifier agent."
- rl-verifier never gets OBLIGATION_RULES.
- RunDto gets `checkObligations: true` while such a check runs.

### 4.2 The obligation

```ts
export const MAX_OBLIGATIONS = 5;
export const obligationSources = ["surface", "criterion"] as const;
export const obligationStatuses = ["met", "deferred", "covered", "missing", "unsure"] as const;

export const obligation = z.object({
  source: z.enum(obligationSources).describe("surface: a public interface that the change adds, removes, or changes. criterion: an acceptance criterion or a stated requirement of the task."),
  must: z.string().max(300).describe("What must exist or change, and in which file, in one sentence."),
  consumer: z.string().max(200).describe("Who acts wrongly or fails when it is missing."),
  cite: z.object({
    path: z.string().describe("A repository path, or context/task.md, context/pr.md, or context/pr-context.md."),
    quote: z.string().max(500).describe("Text copied exactly from that file at the head."),
  }),
  status: z.enum(obligationStatuses),
  evidence: z.string().max(1000).describe("met: path:line. deferred: the line that names the other pull request or ticket. unsure: what is missing."),
  severity: z.enum(severities),
  duplicateOf: lineNo.nullable().default(null).describe("For covered: the block number in ./context/candidates.md. Else null."),
  finding: defect.nullable().default(null).describe("For missing: the place, the title, and the body. Else null."),
});
// verifyResult gets: obligations: z.array(obligation).max(MAX_OBLIGATIONS).default([])
// verifyJsonSchema(obligations = false) leaves the key out when obligations is false.
```

- `defect` is the object of verifyVerdict.finding (review.ts:145-149), moved to a named const. Its JSON schema must not change.
- MAX_OBLIGATIONS 5 is the low end of the other app's 5 to 10 points. It is unverified for our runs. Gate A prints the counts.

### 4.3 OBLIGATION_RULES (draft, rl-verify only)

1. "After the verdicts, check the obligations of the change. This check is the one exception to 'Look for no new problems'."
2. "An obligation is a thing that must be true at the head for the change to be complete, whatever design the author chose."
3. "A surface obligation comes from a public interface that the change adds, removes, or changes."
4. "Examples: exported symbols, function signatures, config keys, CLI flags, file formats, and documented behavior."
5. "Find the files that name each changed interface: tests, docs, guides, samples, contracts, and the changelog." Then FIND_CODE (catalog.ts:1048).
6. "A surface obligation is one of these kinds:"
7. "- A doc, a guide, a sample, or a contract states something about the interface that is false at the head."
8. "- A test must guard the interface, because the task asks for one, or because the repository guards the same kind of interface with a test."
8a. "- The change brings an interface to a new platform, target, or variant. The repository guards that interface on another platform with a test, a link-time setting, or a symbol script. Then the new platform needs a matching guard."
9. "- A changelog entry must exist, because the repository keeps a changelog for changes of that kind."
10. "A criterion obligation is an acceptance criterion or a stated requirement in ./context/task.md or ./context/pr.md that the change is about."
11. "Callers and migrations are no obligations here. The finder checks them."
12. "List at most 5 obligations. List the surface obligations first."
13. "Never list a design choice, a refactor, naming, style, or a thing that you would do in another way."
14. "The do-not-flag items 'a missing test, unless the Tests check is on' and 'comment wording' do not apply to these kinds."
15. "The wording, the style, and the grammar of a doc stay out."
16. Only with history.md: "Never list an obligation that ./context/history.md shows as discarded by the user, unless the cited text changed."
17. "In must, write in one sentence what must exist or change, and in which file."
18. "In consumer, name who acts wrongly or fails when it is missing: a reader of a named doc, a caller, a build, a user, or an operator."
19. "In cite, give a path and a quote. The app looks for the quote in that file at the head. Copy it exactly."
20. "- For a false doc, cite the false line of the doc."
21. "- For a missing test, cite the test that guards the same kind of interface, or the task line that asks for the test."
22. "- For a changelog entry, cite the last entry of the same kind."
23. "- For a criterion, cite the criterion. Give the path context/task.md or context/pr.md."
24. "met: the head meets the obligation. In evidence, give path:line."
25. "deferred: a line in ./context names another pull request or a ticket that does the rest. Quote that line in evidence."
26. "covered: a candidate, a question, or a risk in ./context/candidates.md already raises the point. Set duplicateOf to its number."
27. "missing: the head does not meet the obligation, and no line defers it. Give finding."
28. "unsure: no file or tool of this run settles it. In evidence, name what is missing."
29. "In finding, anchor the place on the changed line that makes the obligation, such as the changed signature or export."
30. "In body, name the file and line that must change, the consumer, and a fix direction, in 3 sentences or fewer."
31. "Set the severity of a missing obligation like this. Never use blocker."
32. "- major: the change does not meet a criterion, in full or in part, and no line defers the rest."
33. "- minor: a line defers the rest of a criterion but names no ticket or pull request. Also a false doc and a missing test."
34. "- nit: a missing changelog entry."
35. "Set finding to null for each status except missing."

The rubric follows the user brief: a stale user guide or a missing test is minor, and an unmet criterion is major only with a quote.

### 4.4 App checks

placeObligations(ws, check) runs in jobs.ts verifyPhase after the check ends. It runs only for the entries with status missing.

1. Cite check. For a repository path, readBlobs loads the file at the head from the cache clone.
2. For context/task.md, context/pr.md, or context/pr-context.md, the app reads that file in ws.context. Any other path fails.
3. The cite passes when collapse(quote) is not empty and collapse(file) holds it (validate.ts:56).
4. Place. A finding with a passed cite goes through the same validate() pass as placeAnswers.
5. A place off the changed lines drops, because the finding has no cause.
6. Severity. The app lowers blocker to major.

- The cite check reads no tool result. A criterion that only an issue tool shows fails the check, and ends open (open question 4).
- A met, deferred, or unsure entry is the claim of the check. The app does not test it, as for a cleared risk.

### 4.5 State machine

Run, with the mode on:

| State | Event | Next | Effect |
|---|---|---|---|
| finding | The finder result is valid. | checking | The verify phase starts, also with zero blocks. |
| finding | The finder fails, or the run is cancelled. | ended | As today. No `obligations` key. |
| checking | The check ends with a valid verify result. | settled | settle gives each obligation one outcome by the table below. |
| checking | The check fails, or its result fails the verify schema, and the file has blocks. | settled | As today. No `obligations` key. |
| checking | The check fails, or its result fails the verify schema, and the file has zero blocks. | settled | No `obligations` key. One notChecked line: "Obligations: not checked: the check did not finish." No gap. |
| checking | Cancel. | cancelled | settle does not run. No obligation gets an outcome. |

Outcome of one obligation. The start state is "listed". settle checks the rows in order. The first match wins.

| Row | Condition | Outcome | Item | Note |
|---|---|---|---|---|
| O1 | met | met | none | "The check says: <evidence>" |
| O2 | deferred | deferred | none | "Deferred: <evidence>" |
| O3 | covered, and duplicateOf is a block number from 1 to the last block | covered | none | "Same point as: <the candidate title, or the question or risk text>" |
| O4 | covered with any other duplicateOf | open | none | "The check named no block for this repeat." |
| O5 | missing, and the cite check fails | open | none | "The cited text is not in <path>." |
| O6 | missing, and finding is null, or the validator drops its place | open | none | "Missing, but the check could not place it." |
| O7 | missing, the cite holds, and the place holds | found | finding item | The finding title. |
| O8 | unsure | open | none | "Not settled: <evidence>" |

After the run:

| Outcome | Later changes |
|---|---|
| found | The finding item rules apply: accept, edit, discard, post, carry, Fix, and Discuss. A task own review sends it to the fix loop only at major (tasks.ts:784-785). |
| met, deferred, covered, open | None. The summary is read-only. A newer run makes its own list. |

Invariants:

- listed = met + deferred + covered + found + open, and listed is at most MAX_OBLIGATIONS.
- The obligation check makes finding items only. It never makes a question item.
- Each found item has a cite that the app found at the head, and an anchor on a changed line.
- An obligation never changes `summary.verify` and never adds a gap. settle moves the cut note of the list to coverage.notChecked.
- Without the mode, the verify prompt, the --json-schema, candidates.md, and the start rule stay byte for byte the same.

### 4.6 The found item

- It reuses answerFinding with category "obligation". WP-RC1 gives answerFinding a category argument.
- Module core, evidenceStatus code, confidence high, an empty trigger, and no cause.
- evidence holds the cite as "<path>: <quote>". body holds the finding body.
- The verify mark: verdict confirmed, the severity, reason "<must> <consumer>", the obligation evidence, and by rl-verify.
- displayGroup places it. Under "balanced", minor and major show, and a nit waits in "More". Under "quiet", only major shows.
- Category "obligation" sorts after the bug classes (review.ts:238-246). Review quality and the eval count it.

### 4.7 Storage, schema, and migration

- No migration. No new item kind. found reuses the finding kind.
- `summary.obligations` goes into summary_json. Its type goes into dto.ts:

```ts
export const obligationOutcomes = ["met", "deferred", "covered", "found", "open"] as const;
export type ObligationOutcome = (typeof obligationOutcomes)[number];
export type Obligations = Record<ObligationOutcome, number> & {
  listed: number;
  list: { source: "surface" | "criterion"; must: string; outcome: ObligationOutcome; note: string }[];
};
// RunSummary.obligations?: Obligations
```

- CheckRun gets `obligations: boolean`. SettleInput gets the placed findings and the passed cites, by list index.
- RunDto gets `checkObligations?: true`.
- ReviewStatsDto gets `obligations`: the sums of the counts, `runs`, and the posted and discarded findings of category "obligation".
- The zod change goes into the verify schema only with the mode on.

### 4.8 Re-review, task own review, and Explain

- Re-review: off in this version. A found obligation is a finding, so it carries and gets a fixed or open state like any finding.
- A new list in each re-review would repeat posted points (open question 2).
- Task own review: on. Its task.md holds the task text and the plan (loop.ts:1949).
- In a task own review, minor obligation findings stay listed. Only major ones enter the fix loop. The effect on the loop rounds is unverified.
- Critic: off. It has no verify phase (jobs.ts:1784-1785).
- Explain: off. Its verifier is off (catalog.ts:145). The Explain page does not reuse the list.

### 4.9 UI

- One toggle in the run line row, beside "Risks: …" of WP-RC4: "Obligations: 5 checked: 3 met, 1 missing, 1 open".
- A count of zero drops. The words are met, deferred, same as a finding, missing, and open.
- The toggle shows only when listed is above 0.
- One entry per obligation. Line 1 holds the outcome word in bold, then the must text.
- Line 2 is muted: "Draft: <title>", "The check says: <evidence>", "Deferred: <evidence>", "Same point as: <text>", or "Not settled: <reason>".
- The entry reuses the markup of the Risks toggle of WP-RC4. That markup reuses RunLine.tsx:533-556.
- Running text: "Checking the obligations…" with zero blocks. Else, for example, "Checking 3 candidates and the obligations…".
- No post button, no action per line, and no new panel.

### 4.10 Review quality

The Check cell gets one line for each group with an obligations run: "Obligations: 14 checked: 8 met, 1 deferred, 2 same as a finding, 2 missing, 1 open. Obligation findings: 1 posted, 1 discarded."

## 5. Noise controls

1. A fixed scope: three surface kinds and the criteria. Callers and migrations stay with the finder.
2. A missing test needs a cited guard test of the same kind, or a task line that asks for the test.
3. A false doc needs its cited false line. Wording, style, and grammar stay out.
4. Each draft needs an app-checked cite, a changed-line anchor, a named file to change, and a named consumer.
5. No design choice and no "I would do it in another way".
6. A repeat of a candidate, a question, or a risk ends as covered, not as a second draft.
7. A point that the user discarded earlier (history.md) is not listed.
8. At most 5 obligations per run. Never blocker. A changelog nit waits in "More" under "balanced".
9. No question items.
10. The revert rule of Gate OB-B.

## 6. Value

- The check targets the two most useful misses and 3 partial misses of the 10.
- The eval set holds almost none of them. Its must-finds come from earlier app runs (results.md:18, risk-check.md section 2).
- So the replay measures harm. The probe cases and Gate OB-B measure value.
- The met lines show what the check found complete.

## 7. Cost

- Today: about $1.6 and 4 min per review.
- Per review: +$0.10 to +$0.35 and +0.3 to +1.0 min. Unverified.
- Basis: a check run on each first review, also with no finding, and about 10 to 18 tool turns for at most 5 obligations. Unverified.
- Ship limit: +20% cost per case and +1.0 min against the reference replay. Above that, the user decides.
- Gate cost: a new baseline of about $165, shared with Gate RC-A (results.md:39 gives $1.96 per case for C2). Unverified.
- One more replay: about $30 to $65 (risk-check.md section 6). Unverified.
- Probe runs: about $5 (results.md:41 gives $0.15 per case). Unverified.

## 8. Eval

### Counts (WP-OB2)

- scripts/eval/run.ts records the obligation counts of each run, never the text.
- score.ts sums them. It adds an "obligation" row in the shape of the security row: gold matches, judge tp, judge fp, and no label.
- compare.ts prints "Obligations, all runs: L listed, M met, D deferred, C same as a finding, F found, O open." and the "Shown obligation findings" row.
- VERIFY_ONLY gets "obligations" (run.ts:287), so a replay accepts the variant.

### Probe cases (WP-OB2)

Seven cases in fixtures/eval/probe/, in the format of probe-task-csv-quoting/case.json. No real names.

| ID | Seeded | Expected |
|---|---|---|
| probe-obl-guide-signature | A public function gets a new parameter and per-OS behavior. docs/guide.md shows the old call. | Must-find, minor, on the changed signature line. |
| probe-obl-export-guard | A package exports a new symbol. tests/exports.test.ts guards the exports of each sibling package, but not of this one. | Must-find, minor, on the changed export line. |
| probe-obl-doc-contract | docs/api.md says that the lookup returns null when nothing matches. The change makes it throw. | Must-find, minor, on the changed throw line. |
| probe-obl-criterion-deferred | The task has two criteria. The change meets one in part. The PR text says "the rest comes later" with no ticket key. | Must-find, minor, on the changed line of that criterion. |
| probe-obl-met-guide | Clean. The change updates the signature and the guide. | Trap on the guide example. |
| probe-obl-met-guard | Clean. The change adds an export and its guard entry. | Trap on the export line. |
| probe-obl-met-followup | Clean. As criterion-deferred, but the PR text names the follow-up ticket SHOP-42. | Trap on the partial line. |

- The set fingerprint covers the local set only (run.ts:968). New probe cases still change the case list, so both sides run fresh.
- Whether eval:ab refuses an older probe baseline is unverified.

### Joint Gate A (with Gate RC-A)

- Commit 301e82b made the C1b recording old for the shipped profile. replayRefusal compares the profile (run.ts:318-320).
- Step 1: one new baseline run of the shipped profile on the 42-case set, with recorded calls. Gate RC-A needs it too.
- Step 2: three verify-only replays of that baseline: the control, "risk-check", and "risk-check,obligations".
- Step 3: the probe set, control and candidate, repeat 2.
- Run the gate before WP-RC3. WP-RC3 raises REVIEW_PROMPT_VERSION, and replayRefusal then refuses the recording (run.ts:315-317).
- The reference for obligations is the "risk-check" replay when Gate RC-A passes. Else one more replay with "obligations" alone runs against the control.
- The exact flags are unverified. risk-check.md section 7 gives their shape.

Ship rule, candidate against the reference:

1. Grounded recall is not worse: the mean is at least the reference mean minus S_R, as in Gate RC-A.
2. Grounded noise per case is at most the reference plus S_N. Judge fp per case run rise by no more than the reference spread.
3. In the "Shown obligation findings" row, gold matches plus judge tp are at least the judge fp.
4. Cost per case rises by 20% or less, and minutes by 1.0 or less. Above that, the user decides.
5. Probe: the candidate finds at least 4 of the 5 seeded omissions in each repeat. The fifth is the rule 8a case (probe-obl-platform-guard).
6. Probe: the candidate raises no finding on a trap of the 3 met cases. The 8 old probe cases keep the control result.

### Gate OB-B (manual, user)

- The user runs the shipped app on the 5 comparison PRs. The user records the outcome of each omission case of section 2.
- Pass: at least 2 of the 5 omission cases end as found drafts. At most 1 obligation draft over the 5 PRs is a draft that the user would discard.
- These two numbers are proposals. The user sets them.
- After two weeks, Review quality shows the posted and discarded obligation findings.
- If more obligation findings are discarded than posted, revert WP-OB3.

## 9. Acceptance criteria

- AC-R48. With the mode on, a first review and a task own review with the verify step on start the verify phase, also with zero blocks. A re-review, an Explain run, a critic run, and a run with the verify step off have no obligation check and no `obligations` key.
- AC-R49. Without the mode, each prompt byte, the verify --json-schema, candidates.md, and the start rule stay the same. A snapshot test proves it.
- AC-R50. rl-verify holds OBLIGATION_RULES only with the mode on. rl-verifier never holds them. Above VERIFY_SPLIT blocks, the delegation keeps the obligations in the main agent. verifyMaxTurns counts MAX_OBLIGATIONS as blocks.
- AC-R51. settle gives each listed obligation exactly one outcome by rows O1 to O8. The counts add up to listed. listed is at most MAX_OBLIGATIONS.
- AC-R52. A found obligation is a finding item with category obligation, module core, evidenceStatus code, confidence high, an empty trigger, the verify mark confirmed, and a severity of major or lower. Its anchor is on a changed line. Its cite quote is in the cited file at the head.
- AC-R53. The cite check reads repository files from the cache clone at the head, and only the three named files of ./context. Each other path fails the check.
- AC-R54. The obligation check never changes summary.verify, never adds a gap, and never makes the run incomplete. This is also true when the check fails with zero blocks.
- AC-R55. The run line shows one toggle "Obligations: N checked: …" with the counts above zero, and one entry per obligation. A run without the key, or with listed 0, shows no toggle. Review quality shows the sums and the posted and discarded obligation findings per profile and prompt version. Eval run files hold the counts only.

## 10. Work packages

Order: WP-RC1, WP-RC2, WP-OB1, WP-OB2, Joint Gate A, WP-RC3 with WP-OB3, WP-RC4 with WP-OB4, then Gates RC-B and OB-B. Run one package at a time.

| # | Package | Tier | After | Files | Tests | Done when |
|---|---|---|---|---|---|---|
| 1 | WP-OB1: the obligation check under the variant "obligations" | implementer-xhigh | WP-RC1 and WP-RC2 are committed. | src/shared/review.ts (defect, obligation, MAX_OBLIGATIONS, verifyResult.obligations, verifyJsonSchema(obligations)); src/shared/dto.ts (VARIANTS, obligationOutcomes, Obligations, RunSummary.obligations, RunDto.checkObligations, ReviewStatsDto.obligations); src/server/review/catalog.ts (OBLIGATION_RULES, the flags of verifyAgent and withVerifyDelegation); prompt.ts (buildVerifyPrompt); judge.ts (CheckRun.obligations, placeObligations, the answerFinding category, settle rows O1 to O8, the failed-check row); jobs.ts (mode, start with zero blocks, the candidates.md head, turns, schema, checkObligations) | A new tests/review/obligations.test.ts in the shape of finder-questions.test.ts: each row O1 to O8, the failed check with and without blocks, the cite check (a repository file, a context file, another path, a traversal path, an empty quote), the place drop, the blocker clamp, the cut note in notChecked, the start with zero blocks, the turn cap, the rule lines with and without the mode, the delegation line, and the byte snapshot without the mode. The question and risk tests stay green. | `bun run check` is green, and AC-R48 to AC-R54 hold. |
| 2 | WP-OB2: eval counts and probe cases | implementer | WP-OB1 | scripts/eval/run.ts, score.ts, compare.ts; tests/eval/score.test.ts, ab.test.ts, harness.test.ts; fixtures/eval/probe/probe-obl-* (7 cases); docs/eval/local.md | The sums, the obligation row, the compare line, the replay accepts "obligations", and each new case parses. | `bun run check` is green. A fake replay prints the obligations line. |
| 3 | Joint Gate A | user | WP-OB2, before WP-RC3 | none | Section 8. | The user reads both ship rules and decides. |
| 4 | WP-OB3: ship the check | implementer | Gate A. Together with WP-RC3 when both gates pass. | src/shared/review.ts (REVIEW_PROMPT_VERSION and its comment); catalog.ts and jobs.ts (the mode is on without the variant); dto.ts and run.ts (remove "obligations"); spec.md (AC-R48 to AC-R55); docs/eval/results.md; docs/eval/local.md | Snapshot updates. An old profile with "obligations" reads without it (dto.ts:281-284). | Each first review and task own review has the check. `bun run check` is green. |
| 5 | WP-OB4: UI, stats, and docs | implementer | WP-OB3 and WP-RC4. Merge it into WP-RC4 when WP-OB3 ships before WP-RC4 starts. | src/web/review/RunLine.tsx and model.ts (toggle, entries, running text); src/web/settings/quality.ts; src/server/review/stats.ts; scripts/demo.ts; tests/support/fake-claude.ts; tests/web/review-v2.test.ts; the stats.ts test; tests/e2e/review-v2.e2e.ts; README.md; docs/screenshots via `bun run screenshots`; CHANGELOG.md | Unit tests for the toggle label and the entries. One e2e: a run with all five outcomes shows the toggle, the entries, and one draft. A run without the key shows no toggle. | AC-R55. The screenshots hold no real names. The skills shadcn, vercel-react-best-practices, and web-design-guidelines ran. |
| 6 | Gate OB-B | user | WP-OB4 | none | Section 8. | The user decides. |

- Push nothing between WP-OB3 and WP-OB4. The toggle and the running text land in WP-OB4.
- WP-OB1 reuses WP-RC1 code: the answerFinding category, the start rule beside risks, the block count of verifyMaxTurns, the kinds of buildVerifyPrompt, and the validate pass of placeAnswers.
- WP-OB2 reuses the count code of WP-RC2 in the same three scripts.
- WP-OB3 and WP-RC3 can share one version step "2.9" when both gates pass. Else WP-OB3 needs a new baseline after the version step.
- WP-OB4 reuses the entry markup and the quality line of WP-RC4.

## 11. Open questions

1. Kind 8 of section 4.3 overrides the shipped do-not-flag item "a missing test, unless the Tests check is on" (catalog.ts:590). It needs a cited guard test or a task line. Accept? Recommended: yes.
2. Re-review: off in this version. Recommended: yes.
3. Task own review: on. Recommended: yes. The effect on the fix loop rounds is unverified.
4. A criterion that only an issue tool shows fails the cite check and ends open. Accept? Recommended: yes. task.md holds the fetched task text of a linked task.
5. MAX_OBLIGATIONS 5 is unverified. Gate A shows the counts.
6. Ship WP-OB3 with WP-RC3 as one version step? Recommended: yes, when both gates pass.
7. Did the repository of miss 1 guard the exports of sibling libraries with a test? If not, kind 8 does not catch miss 1. Unverified. The user knows the case.
8. The Gate OB-B numbers are proposals. The user sets them.

### User answers of 2026-11-18

The user took the recommended answers.

- Question 1: yes. Kind 8 counts a missing guard test when a cited guard test of the same kind exists, or a task line asks for the test.
- Questions 2, 3, 4, and 6: yes, as recommended.
- Question 7: answered by a check of the repository of miss 1. At the base, no test compared any export list. The nearest guard was a narrow runtime test of leaked symbols on another OS, plus a linker symbol script. So kind 8 alone would miss it. Rule 8a adds the narrow form: a guard on one platform needs a matching guard on a new platform. The cite is the existing guard. Probe case probe-obl-export-guard gets a second form for rule 8a in WP-OB2.
- Question 8: the Gate OB-B numbers stay as proposed: at least 2 of the 5 omission cases found, and at most 1 obligation draft that the user would discard.

## 12. Out of scope

- A blind run on the merge base.
- A ledger of every criterion.
- Obligations for callers and migrations.
- A question item from an obligation.
- An app check of met, deferred, and unsure evidence.
- Reuse of the list on the Explain page.
- Obligations in a re-review.
- The two misses that both apps share: steps in the wrong order, and an old OS key.
