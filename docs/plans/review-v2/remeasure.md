# Re-measure plan: opt-in review variants

Status: plan of 2026-11-27, written against main a8e0ca3. It is not approved yet. The user approves each paid run. "Guess" marks an estimate. Results go to docs/eval/results.md as aggregate numbers only.
User decision of 2026-11-27: git-history gets no paid measurement. It stays opt-in, and the profile editor gets a "Git history" switch. The user runs it with a Jira MCP server, which the eval cannot give. So M2, M4, M8, WP-RM3, and WP-RM4 are parked. The low-effort subset pilot E-LOW started on 2026-11-27 before this plan; M5 stays the full-set design.

## 0. Short answer

- Keep "git-history" opt-in and re-measure it. First measure it on gold that can score its target. The natural set cannot score "the change brings back a bug that an earlier commit fixed".
- P-GH does not show that git-history is worse. Its 90% interval (−28.1 to +6.7 points) holds both a large loss and a real gain. A 10-case pilot at repeat 1 detects only effects of about 25 points.
- The eval gives task text today, but only part of it. It seeds the stored Jira rows of each local case. It gives no issue tool, no parent text, no refreshed fields, and no PR note.
- So the user's hypothesis is a 2×2 design: git-history × the WP-JC-E task overlay. Baseline r6 is one cell. The Gate JC-A candidate is a second cell. This plan adds one more cell.
- Order of work: free analyses, synthetic probes, Gate JC-A, then a new seed kind "regression". The natural guard run of git-history with the overlay comes last, and only for a default-ship decision.
- Also measure obligations (verify-only replays), handoff (large cases only), and E-LOW with twice-lite (one shared run).
- Do not re-run callers, lenses3, or architecture. Delete runs3. Keep the user decisions on codegraph and minor-fold. twice needs no re-measure.

## 1. Facts

Eval context:
- The eval seeds the stored task rows of each local case into its database (scripts/eval/run.ts:875-890). A case gets task.md when a row has text (`hasTask`, docs/eval/local.md:59). P-GH ran with this text.
- The eval profile is the shipped profile plus the flags (run.ts:279-305). The shipped profile has `mcp: []` and `jiraFamily: false` (src/server/review/catalog.ts:125, 128).
- No eval flag adds an MCP server. A run gets user servers only from profile.mcp (src/server/review/jobs.ts:933-972). So eval runs have no issue tool, and ISSUE_LINES never show (catalog.ts:1600-1625).
- Each run gets an empty PR note unless `bun run eval` gets `--notes` (run.ts:893). eval:ab never passes `--notes` (docs/eval/local.md:74).
- The task overlay exists only on branch jc5-r (2bc8255, with WP-JC5 and WP-JC-E). Its merge base is a84610d. So it does not have git-history (d3cda25) or handoff (c63912b).
- jc5-r adds these flags. `bun run eval` takes `--jira-family` and `--tasks-overlay <file>`. eval:ab takes `--candidate-jira-family` and `--candidate-tasks-overlay <file>`. The new command is `bun run eval:refetch-tasks`.
- On jc5-r, run.ts refuses `--tasks-overlay` together with `--replay-find`. eval:ab refuses a baseline that ran with an overlay. eval:label gives the judge the stored task rows on both sides.
- The overlay replaces only the text of the keys that a case already has. It applies only when the case ID and the head match. A case with no task key gets no text.

Eval tools on main:
- `bun run eval` takes `--set`, `--cases`, `--model`, `--effort`, `--reviewer-effort`, `--reviewer-mode`, `--verifier`, `--verifier-effort`, `--verifier-model`, `--variants`, `--notes`, `--replay-find`, `--resume`, `--repeat` (1 to 10), `--out`, and `--real` (run.ts:169-199).
- eval:ab has no `--cases`, no `--model`, and no `--notes` (scripts/eval/ab.ts:98-122). It does have `--candidate-verifier-effort` (ab.ts:107). Row 7 of research/opus55-prompting.md is out of date on this point.
- eval:ab builds the set again on each run (ab.ts:129). A new decision in the app changes the set fingerprint, and eval:ab then refuses r6. So this plan runs `bun run eval` on the frozen r6 set folder, as thorough-review.md section 4 does.
- `--replay-find` and `--candidate-replay` refuse a variant that changes the finder prompt (run.ts:327-351). Only obligations, refute-issue, security2-verify, and verify2 are verify-only (run.ts:312).
- REVIEW_PROMPT_VERSION is "2.9" (src/shared/review.ts:27), and PROFILES_VERSION is 9 (src/server/config.ts:73). Both values are the same at a84610d and at main. So r6 stays a valid reference on main.
- Every run gets all four rl-git tools (src/server/review/git-mcp.ts:15, 49). The control arm can read history too. git-history adds only the rule text.
- In the eval, TARGET points at the case base (scripts/eval/cases.ts:437-444, 459). rl-git accepts only commits in the history of HEAD, BASE, or TARGET (git-mcp.ts:159-172). So no later fix commit can leak through rl-git.
- The judge label has a scope field with the values introduced, worse, or pre-existing (scripts/eval/label.ts:99, 119). Pre-existing findings are a separate item group (scripts/eval/score.ts:558).
- A synthetic probe case has one base commit today (scripts/eval/cases.ts:413-414). The probe set has 11 probe-obl cases (fixtures/eval/probe/).
- The worktree review-loop-dropvar holds an uncommitted change. It removes broad, refute-issue, security2, security2-verify, and verify2. This plan does not touch that change.

Measured numbers (docs/eval/results.md):
- r6: 41 cases, 60 shown must-finds, and repeat 2. It cost $215.34, or $2.63 per case run. Grounded recall was 23 and 23 (38.3%). Large cases hold 22 must-finds and small cases hold 38 (derived from the callers table).
- 10-case subset: 8 PR groups, 28 must-finds, $1.59 per case run.
- callers, full set, repeat 2: −3.3 points (−10.4 to +4.0). lenses3, subset, repeat 1: +7.1 (−4.9 to +26.3). P-GH, subset, repeat 1: −10.7 (−28.1 to +6.7).
- Two r6 repeats merged: +10.0 points (+5.0 to +15.0). Noise went from 1.55 to 2.37 per case.
- SG-A kind rows: 6 contract seeds, all found. 1 architecture seed, found 3 of 3. 1 omission seed, found 1 of 3. The set has 33 seeds, and the MDE is 9 to 11 points.

## 2. Points of view

### 2.1 Statistics and power

- Model: the SD of the paired delta, in points, is k × sqrt(1/R_A + 1/R_B). pairedDelta bootstraps over PR groups (score.ts:861-906).
- Calibration from our own intervals: k = 4.4 for the full set (callers, half-width 7.2 at 2 against 2 repeats). k = 8.2 for the subset (lenses3 and P-GH, 2 against 1 repeats).
- Power is the chance that the 90% interval excludes 0. MDE is the effect that has 80% power.

| Design | SD | 90% half-width | MDE | Power at +5 | Power at +10 | Cost of side B |
|---|---|---|---|---|---|---|
| Subset, R_A 2, R_B 1 | 10.0 | 16.5 | 24.9 | 13% | 26% | about $16 to $24 |
| Full, R_A 2, R_B 1 | 5.4 | 8.8 | 13.3 | 24% | 59% | $108 × f |
| Full, R_A 2, R_B 2 | 4.4 | 7.2 | 10.9 | 31% | 74% | $215 × f |
| Full, R_A 2, R_B 4 | 3.8 | 6.2 | 9.4 | 37% | 84% | $430 × f |
| Full, R_A 3, R_B 3 | 3.6 | 5.9 | 8.9 | 40% | 88% | $108 + $323 × f |
| Full, R_A 10, R_B 10 | 2.0 | 3.2 | 4.9 | 82% | 100% | about $2,000 or more |

- f is the cost factor of the variant. Outside the calibrated designs, the model is a guess.
- A +5-point gain in natural recall needs about 10 repeats per side, and we cannot pay for that. So natural recall is only a guard. A targeted gold set must show the gain.
- The P-GH rule "grounded recall not below the subset baseline" is a coin flip. It fails a zero-effect variant 50% of the time. It fails a true +5 variant 31% of the time. P-GH sat about 1 SD below 0.
- S_R on r6 grounded recall is 0 (23 and 23), so the S_R clause of "Better" is empty. W3 also applied the clause "the paired 90% interval excludes zero" (results.md, W3). On r6, that clause decides.
- Pair every comparison by case and by must-find. Reuse r6 as side A. Add repeats only on the cheap side.
- Proposed rules for the user (section 5):
  - D1, pilot rule: a pilot checks mechanism, cost, and noise. It stops on recall only when the point delta is below −1 SD of its design. That is about −10 points on the subset. A zero-effect variant then passes 84% of the time.
  - D2, natural guard (non-inferiority): the 90% lower bound of the paired delta must be at least −10 points (6 of 60 must-finds). At 2 against 2 repeats, a zero-effect variant passes 74% of the time. A −10-point variant passes 5% of the time.
  - D3, targeted lever: a variant ships when four things hold. Targeted gold passes "better" (the interval excludes 0). D2 passes. The noise rule passes. The user accepts the cost.

### 2.2 Gold coverage

- Natural gold holds the findings that the user posted from earlier app runs (results.md, U-V4). A variant that finds a new kind of problem gets credit only through the judge, as extras.
- These variants target problems outside natural gold:
  - git-history: reverted fixes and false pre-existing claims.
  - obligations: missing companion edits and unmet criteria.
  - the task overlay: unmet criteria.
  - handoff: subagent questions and risks.
- git-history.md section 5 says that seeds cannot test a revert, because a seed folds into the author's commit. That is true only when the earlier fix is in the PR range.
- The fold rewrites only base..H (seeded-truth.md S8). A seed that restores the lines from before a BASE commit leaves that commit in the BASE history. HISTORY_LINES blame at BASE (git-history.md:45). This is an inference; F5 counts the hosts where it applies.
- New gold, cheapest first:
  1. Probe cases `probe-hist-*` (synthetic). WP-RM3 lets buildRepo make commits before the base, as it already does for the parent patch (cases.ts:416-419).
  2. Seed kind "regression": a commit in the BASE history changed some lines to fix a defect, and the seed restores the lines from before that commit. The anchor is the restored line.
     - Mechanical check: the seeded lines equal the lines of the fix commit's parent in that hunk. The fix commit is an ancestor of BASE and is not in base..H.
     - The validator names a concrete input that the fix handled.
  3. Seed kind "intent": the seed breaks a requirement that the case task text states. The proof quotes task.md. Only hosts with task text qualify.
     - The seeded case ID and head change (seeded-truth.md S9), but the overlay matches by ID and head. So WP-RM4 freezes the overlay text into each seeded case.
  4. Mixed seeds: the task asks for a cleanup, and the seed drops a guard that an earlier fix added. Tag these seeds. Their row is information only.
- Keep the seeded-truth rules:
  - Do not tune seeds on outcomes.
  - Never drop a never-found seed.
  - A pilot is never a baseline.
  - Put at most 3 seeds on a host and at most 1 in a file.
  - Run the giveaway check.
- Run the control first. A removed guard shows in the diff, so the control may already find it. Stop when the control finds the target; SK-P and the SG-A ceiling showed this risk.
- Count the natural must-finds of module intent first (F4). The "task text" and "module" slices of eval:compare print the counts.

### 2.3 Context realism

| Context | App | Eval on main | Eval on jc5-r | This plan |
|---|---|---|---|---|
| PR title and description | yes | yes (run.ts:837-856) | yes | no change |
| Task text | read at each run start: first 3 keys, refresh after 5 min (jira-context.md 3.1) | rows stored at set build (run.ts:875-890) | overlay: today's text, with comments cut at the head commit | M3 and M8 use the overlay |
| New Jira fields and task.md sections | fields on main (WP-JC1), sections on jc5-r (WP-JC5) | no | yes | M3 and M8 |
| Parent and sub-tasks | off (catalog.ts:125); on after Gate JC-A (WP-JC6) | off | `--jira-family` | M3 and M8 |
| Issue tool (Jira MCP) | only when the profile lists a user server | none | none; run.ts refuses a Jira source | no live server (see below) |
| PR note | the brief note | empty unless `--notes` | same as main | off for the Gate JC-A pair; on for the next baseline |
| Threads, project instructions | yes | yes (run.ts:891-896) | yes | no change |
| TARGET | the live target head | the case base | same as main | a known limit |
| Judge input | not applicable | stored task rows | stored rows on both sides | WP-RM2 gives the judge the overlay of the run |

- Do not give eval runs a live Jira MCP server. Today's issue text and later comments can name the bug or its fix. A live read cannot cut them at the head time.
- Eval runs never call Jira, by design (jira-context.md section 5, U-JC5).
- Since WP-JC3, the app reads the task text at run start. So task.md already holds what an issue tool would return for a key read. The time-cut overlay gives the same text.
- Remaining gap: an issue tool can also read linked issues and run searches. Gate JC-B (manual) covers it. Build a read-only stub issue server from the overlay only if Gate JC-B shows that such reads matter.
- The overlay bias (today's text) cancels in the git-history contrast, because cells C and D share the same overlay.
- The judge bias does not cancel for intent findings. It hides exactly the findings that the user's hypothesis is about. WP-RM2 fixes it before M8.

### 2.4 Cost

Prices (results.md and thorough-review.md section 1):
- Full natural run: $2.63 per case run, or $215 per repeat of 41 cases. Labels cost about $5 per 82 runs.
- Subset: $1.59 per case run. Labels cost about $2 per 10 runs.
- Verify share: 25.9% of a run, about $0.68 per case run.
- Probe case run: about $0.15 to $0.30. Seeded case run: $2.09. Seeding round: $12 to $16.

Cheaper designs in this plan:
- Reuse r6 as side A everywhere ($0).
- Share cells. The Gate JC-A candidate is cell C of the 2×2 and also the next baseline. It runs once, with repeat 2.
- Use verify-only replays on recordings. obligations replays the cell C recording instead of a new finder run (WP-RM2).
- Run one control replay and reuse it for every verify-only candidate (obligations, style55-verify, verifier-low).
- Run the free analyses on stored records first (M0).
- Measure targeted gold before natural runs. Probes ($5 to $10) and regression seeds gate the natural run, which costs more than $300.
- Use a factorial with shared cells, so only cell D is new. Cell B (git-history alone) does not run again; P-GH stays as its subset data.
- Allow an optional futility stop after repeat 1 of M8.
- Fix mechanical subsets before each run: `--large` for handoff, and the seed hosts for M4.

### 2.5 Interactions

- git-history × task overlay. The four cells are:
  - A: r6.
  - B: P-GH, subset only.
  - C: the Gate JC-A candidate.
  - D: new.

  The ship contrast is D − C, because WP-JC6 makes the Jira context the default after Gate JC-A. The interaction (D − C) − (B − A) has about twice the SD of a main effect. Report it on the 10 subset cases, as information only.
- architecture × callers: the zero-cost gate of architecture-bugs.md 4.4 gives H = 100 × (6×0 + 1×2/3 + 1×0)/33 = 2.0 points. The SG-A MDE is 9 to 11 points, so the route-2 run does not run. The natural data has 0 architecture issues among the 12 missed class (a) issues.
- twice × a cheaper arm (R1): one low-effort run on the full set gives union(r6 rep1, low run). The same run also gives the E-LOW screen (M5).
- twice × a different arm: free. union(r6 rep1, callers rep1) uses stored records. On the subset, union(r6 rep1, lenses3) and union(r6 rep1, P-GH) do too (F1).
- obligations × task text: obligations reads criteria from task.md. Measure it on the cell C recording with the overlay (M6).
- handoff × git-history: with handoff, rl-reviewer gets the git tool lines (delegation-gaps.md fix 4). HISTORY_LINES line 1 names the tools anyway, so this pair is not measured.

### 2.6 Product value

- git-history:
  - A finding names the hash and the subject of the earlier commit, so a reviewer can check it fast.
  - Line 9 reads the file at BASE before a pre-existing claim.
  - Measure the share of findings that cite a commit, and their verdicts (P-GH: 4 of 25, 3 confirmed).
  - Measure false pre-existing claims: pre-existing items whose judge scope is "introduced". This is free on stored labels (F3).
- Task overlay: intent findings quote the criterion. The text answers questions that the finder would otherwise ask. Measure question items per case run, and intent findings that have a quote.
- twice and twice-lite: more real issues are shown, with about +0.8 noise per case.
- handoff: subagent questions and risks reach the list on large PRs.
- obligations: missing companion edits are shown, with the criterion quoted.
- E-LOW: shorter waits and lower cost. Report the minutes per case run.
- Later, in real use: count posted and discarded findings that cite a commit. Read them from the user's database, read only.

### 2.7 P-hacking and regression to the mean

- This file pre-registers each item: its cases, repeats, primary metric, and decision rule. A change after a run makes a new item.
- Each item has one primary metric. All other rows are information.
- Never run again "until it passes". Each item has a fixed run count. M8 has one futility look, after repeat 1.
- Pool runs; never replace them. P-GH stays as the data of cell B. A new run of the same setup adds to the old data.
- Regression to the mean: lenses3 (+7.1) was a selected positive result. git-history (−10.7) was a selected negative result. Expect both to come nearer to 0 on a re-run.
- The 10-case subset already served lenses3 and P-GH. Do not use it for a confirming decision.
- Multiplicity: 6 primary tests at one-sided 5% give a 26% chance of at least one false pass when no variant works.
  - A recall raiser ships only with two independent sources: targeted gold and the natural guard.
  - Apply Holm over the "better" claims of one wave.
- A change of HISTORY_LINES makes a new variant version, and old data does not carry over. Never edit probe or seed text after a variant result.
- The judge tp and fp split is not calibrated (review-quality-2026.md section 2). Run a blind calibration sample before any gate rests on judge fp.
- callers had a powered full run. A re-run would be a second draw, so it does not run.

## 3. Verdict per variant

| Variant | History | Verdict | Reason |
|---|---|---|---|
| git-history | P-GH: subset, repeat 1, −10.7 (−28.1 to +6.7), cost 1.52x | Re-measure: M2, M4, then M8 if its conditions hold | Its target is outside natural gold, and the pilot MDE is about 25 points. |
| obligations | Not measured on current code | First measure: M6 | Cheapest test of "does the change match the task". It is verify-only. |
| handoff | Never measured | First measure: M7 | Mechanism metrics on large cases. |
| twice | Shipped opt-in; free analysis +10.0 (+5.0 to +15.0) | No re-measure | Its arms are byte-identical, so Gate T-A would measure variance again. Measure twice-lite instead (M5). |
| callers | Full set, repeat 2: −3.3 (−10.4 to +4.0); judge fp fail; +24% cost | Leave failed; no re-run | It had a proper run. |
| lenses3 | Subset, repeat 1: +7.1 (−4.9 to +26.3); noise fail; 4.8x cost | Leave failed; no re-run | A full run costs about $1,035 (82 × $2.63 × 4.8). Per dollar, the free union beats it. |
| runs3 | Never ran (G-L0 failed on the seeded ceiling) | Delete | twice covers more runs. M9 gives union k = 3 if the user wants proof. |
| architecture | Never measured alone | Leave opt-in; no run | Zero-cost gate H = 2.0 against an MDE of 9 to 11. 0 of the 12 natural misses are architecture issues. |
| codegraph | Pilot only | No run | User decision of 2026-11-24. |
| minor-fold | Failed MF-A rule 1 (judge); paused by the user | No run | Re-open after the verify nit fix (style55-verify, B1) and a judge rule for polish. |
| broad, verify2, refute-issue, security2, security2-verify | Failed their gates | Out of scope | The dropvar worktree removes them (uncommitted). |

Deletion candidates (the user decides, D5):
- runs3: delete now.
- lenses3, callers, and architecture: delete after F1 if no different second arm beats the same-prompt arm. architecture is a user requirement of 2026-11-21.

## 4. Ranked plan

| Rank | Item | Cost (guess) | Needs |
|---|---|---|---|
| 1 | M0 free analyses | $0 | none |
| 2 | M1 prerequisite packages | $0 in runs | section 6 |
| 3 | M2 git-history probes | $5 to $10 | WP-RM3 |
| 4 | M3 Gate JC-A, cell C | $220 to $255 | WP-RM1; owned by the Jira context package |
| 5 | M4 regression and intent seeds | $110 to $190 | WP-RM4, D4, F5 |
| 6 | M5 E-LOW and twice-lite, one run | $57 to $84 | none (main) |
| 7 | M6 obligations | $115 to $155 | WP-RM2, M3 |
| 8 | M7 handoff, large cases | $88 to $158 | none (main) |
| 9 | M8 git-history natural guard, cell D | $305 to $385 | M2 and M4 pass, M3 ran, WP-RM1, WP-RM2 |
| 10 | M9 r6 repeat 3 (optional) | $111 | none (main) |

Total cost:
- All items: about $1,010 to $1,350.
- Without M8 (conditional) and M9 (optional): about $595 to $850. Of that amount, Gate JC-A already owes about $220 to $255.

M5 and M7 need no prerequisite, so they can run at any time.

### M0. Free analyses ($0)

Each analysis is a scratch script in the scratchpad, as for Gate T-0. It reads result files, labels, and `.calls/` records, and prints aggregates only. A runner or a scout runs it.

- F1, a different second arm: compare union(r6 rep1, callers rep1) with union(r6 rep1, r6 rep2), which shows 29 of 60.
  - Report shown grounded recall, grounded noise, judge fp, and cost.
  - Use copyPairs and the survivor rule (thorough-review.md D2, D3).
  - On the subset, add union(r6 rep1, lenses3) and union(r6 rep1, P-GH).
  - The result is information for D5.
- F2, the twice fold (R4): rescore the two r6 repeats with the fold of minor findings that only arm 2 raised. Report shown recall, recall with folded items, noise, and judge fp.
- F3, P-GH mechanism: compare the P-GH runs with the 20 r6 subset runs.
  - Per run: finder turns, runs at the turn cap of 100, salvage runs, and rl-git calls.
  - Also count false pre-existing claims, and commit citations with their verdicts.
  - This tests the guess "history reads take turns from the bug search".
- F4, counts on the r6 set folder:
  - whether the fingerprint equals the r6 fingerprint;
  - cases with task text;
  - must-finds of module intent;
  - cases with a hunk that removes or rewrites BASE lines, and their must-finds;
  - large cases.
- F5, hosts for new seeds: per seeded and natural host, count the BASE commits that meet all of these conditions. Print counts only.
  - The commit is among the 200 before BASE.
  - Its subject names a fix or a revert.
  - It changed a file of the PR.
  - Its lines are still at BASE.
- F6, route 2 of architecture: H = 2.0 points (section 2.5). This file already did it.
- Risk: none. The scripts print aggregates only, and no case name leaves the scratch output.

### M1. Prerequisite packages

WP-RM3, WP-RM1, WP-RM2, and WP-RM4 (section 6). They need no paid run.

### M2. git-history probes (main after WP-RM3; $5 to $10, guess)

The cases are fixed now:
- probe-hist-revert-named: an earlier commit "Fix crash on empty input" adds a guard. The PR refactors the function and drops the guard. The must-find is on the new line.
- probe-hist-revert-plain: the same as revert-named, but the fix subject says only "Update parser". The fix commit also adds a test. git_show shows the reason.
- probe-hist-revert-task: the task asks only for a speed change. The PR drops a guard that an earlier fix added. The must-find is on the new line.
- probe-hist-trap-temporary: an earlier commit adds a workaround "until the v2 client lands". The task says "Move to the v2 client". The PR removes the workaround. The trap is on the change.
- probe-hist-trap-asked: the task asks to remove a retry that an earlier fix added, and gives the reason. The PR removes the retry. The trap is on the change.

Commands:
- `bun run eval -- --real --set probe --cases <the 5 IDs> --effort medium --repeat 3 --out eval-results/remeasure/probe-hist-control`
- The same command with `--variants git-history` and `--out eval-results/remeasure/probe-hist-gh`.
- `bun run eval:compare -- <control result.json> <gh result.json>`

Rule (control first):
- Headroom: the control must find each revert probe in at most 1 of 3 runs, on at least 2 of the 3 revert probes. Otherwise stop and record "no headroom". Do not edit the probes.
- Pass: the variant finds at least 2 revert probes, each in 2 or more of 3 runs and more often than the control. Trap hits are 0 of 6. No run fails. The cost per case is at most 2x the control.
- A pass shows only that the mechanism works. It is no ship evidence.

Risk: synthetic probes sit near the ceiling, and the control can see the guard in the diff.

### M3. Gate JC-A, cell C (jc5-r after WP-RM1; $215 to $250 plus $5 labels, guess)

The Jira context package owns this gate. This plan asks for two things: run it with repeat 2, so that cell C is also the next baseline, and run it on the frozen r6 set folder.

Commands (jc5-r only):
- `REVIEW_LOOP_EVAL_LOCAL=<r6 set folder> bun run eval:refetch-tasks`
- `REVIEW_LOOP_EVAL_LOCAL=<r6 set folder> bun run eval -- --real --set local --effort medium --jira-family --tasks-overlay <r6 set folder>/tasks-overlay.json --repeat 2 --out eval-results/remeasure/jira-c`
- `bun run eval:label -- eval-results/remeasure/jira-c --real`
- `bun run eval:compare -- <r6 review-baseline result.json> <jira-c result.json>`

Rule: Gate JC-A rules 1 to 5 (jira-context.md section 5). Read the refetch counts first: rule 5 needs added text on at least half of the task cases.

Risk: the overlay bias favors C over r6. Gate JC-B decides the value.

### M4. Regression and intent seeds (after WP-RM4 and D4; $110 to $190, guess)

- Precondition: F5 finds hosts for at least 12 regression seeds. With fewer seeds, the MDE is above 30 points (see the power line below).
- Seeding: one propose, validate, and decide round of eval:seed with `--kinds regression,intent`, then `eval:seed build`. Cost: about $15 to $30 (guess).

Runs, on the hosts with new seeds only:
- `REVIEW_LOOP_EVAL_LOCAL=<seeded set folder> bun run eval -- --real --set local --cases <host IDs> --effort medium --repeat 3 --out eval-results/remeasure/seed-hist-control`
- The same command with `--variants git-history` and `--out eval-results/remeasure/seed-hist-gh`. Then run eval:label on both results, and eval:compare.
- The use of the seeded folder through REVIEW_LOOP_EVAL_LOCAL is unverified. The fallback runs all cases and costs about $270 to $310: `bun run eval:ab -- --seeded --review-only --repeat 3 --candidate-variants git-history --candidate-repeat 3`.

Power (p 0.3 in A, 0.6 in B, 3 against 3 repeats; guess):
- 12 seeds: MDE 29 points.
- 16 seeds: MDE 25 points.
- 24 seeds: MDE 21 points.

Rule:
- Headroom first: the control hit rate on regression seeds is at most 70% (the headroom proposal of seeded-truth.md section 9). Otherwise stop.
- Pass:
  - The 90% interval of the paired delta on regression seeds excludes 0.
  - The other seeds on the same hosts stay at or above the control mean minus S_R.
  - Noise passes the full-run noise rule.
- Intent seeds: the same rule on the intent kind. A pass there also supports obligations and the overlay.

Risk: few hosts may qualify, fix subjects can be plain, and the control can see the restored lines in the diff.

### M5. E-LOW and twice-lite, one run (main; $54 to $81 plus $3 labels, guess)

Command: `REVIEW_LOOP_EVAL_LOCAL=<r6 set folder> bun run eval -- --real --set local --effort low --reviewer-effort low --repeat 1 --out eval-results/remeasure/effort-low`. Verify stays at medium (catalog.ts:135).

The same run gives two readings:
- Reading 1, the E-LOW screen (a cost cutter): compare the low run with r6.
  - Pass: the point delta is at least −1 SD (−5.4 points), the noise rule passes, and the cost is at most 0.8x.
  - After a pass, run repeat 2 and apply rule D2.
- Reading 2, twice-lite (R1): compare union(r6 rep1, low run) with union(r6 rep1, r6 rep2), using the F1 script.
  - Pass: the union with the low run shows at most 2 fewer must-finds of 60 than the same-prompt union. The low run also costs at most 0.75x a second r6 run.
  - A pass opens a design package for "twice-lite".

Risk: the rule says that cost cutters and recall raisers never share a run. Here only one setup runs, and the union is an offline merge. The user confirms this reading (D7).

### M6. obligations (probe on main; replays on jc5-r with WP-RM2)

- Step 1, probe ($5 to $10, guess): run `bun run eval -- --real --set probe --cases <the 11 probe-obl IDs> --effort medium --repeat 3` once without the variant and once with `--variants obligations`.
  - Pass: probe must-find recall is not below the control, and the trap rate is 0.
- Step 2, control replay of cell C ($55 to $70, guess): `REVIEW_LOOP_EVAL_LOCAL=<r6 set folder> bun run eval -- --real --set local --effort medium --jira-family --tasks-overlay <file> --replay-find <jira-c result.json> --repeat 2 --out eval-results/remeasure/c-replay`.
  - It measures verify noise. Every later verify-only candidate reuses it.
- Step 3, obligations replay of cell C ($55 to $75, guess): the same command with `--variants obligations`.
- Rule for steps 2 and 3:
  - The replay noise limits hold: grounded noise at most +0.08 per case, and judge fp at most +0.05 per case run.
  - No more must-finds go to refuted or folded than in the control replay.
  - Confirmed obligations judged tp are at least as many as those judged fp.
- If Gate JC-A fails, replay r6 instead with `--variants obligations --replay-find <r6 result.json>`, together with a control replay of r6.

Risk: obligations output sits outside gold by design, so the open precision-rule item applies.

### M7. handoff on large cases (main; $85 to $155 plus $3 labels, guess)

- Command: `bun run eval:ab -- --baseline <r6 folder> --large --review-only --effort medium --repeat 2 --candidate-variants handoff --candidate-repeat 2`.
- This command needs the live set fingerprint to equal the r6 fingerprint. Otherwise run `bun run eval` with `--cases <large IDs> --variants handoff` on the r6 set folder.
- Primary metric: confirmed questions and risks per large case run.
- Guards: the point delta of large-slice grounded recall is at least −1 SD, the noise rule passes, and the cost rises by at most 25%.
- The 22 large must-finds cannot show a recall gain (SD about 8 to 9 points, guess).

Risk: more subagent questions can add noise.

### M8. git-history natural guard, cell D (conditional; $300 to $380 plus $5 labels, guess)

M8 runs only when all of these hold:
- M2 passed.
- M4 passed.
- M3 ran.
- The user considers git-history as a default.

Command (needs WP-RM1 and WP-RM2):
- `REVIEW_LOOP_EVAL_LOCAL=<r6 set folder> bun run eval -- --real --set local --effort medium --variants git-history --jira-family --tasks-overlay <r6 set folder>/tasks-overlay.json --repeat 2 --out eval-results/remeasure/gh-jira`
- Then run eval:label, and `bun run eval:compare -- <jira-c result.json> <gh-jira result.json>`.

Optional futility look: run `--repeat 1` first. Stop when the point delta is below −10.7 points (2 SD at 2 against 1 repeats), or when the cost factor is above 2.0. A second `--repeat 1` result needs a pooled compare, which is unverified.

Primary rule: D2 on all cases (lower bound at least −10 points), and the full-run noise rule.

Information rows:
- the task-text slice and the module intent slice;
- false pre-existing claims and commit citations;
- the cost factor and the minutes factor;
- the interaction on the 10 subset cases.

Ship (D3): the M4 regression rule passes, M8 passes D2 and the noise rule, and the user accepts the cost. Otherwise git-history stays opt-in, and no further paid run follows.

Risk: the cost factor can be higher on large refactors (git-history.md section 5).

### M9. r6 repeat 3 (optional; $108 plus $3 labels)

- Command: `REVIEW_LOOP_EVAL_LOCAL=<r6 set folder> bun run eval -- --real --set local --effort medium --repeat 1 --out eval-results/remeasure/r6-rep3`.
- It gives three things:
  - union k = 3, the natural answer for a runs3-like gain;
  - a drift check: compare rep3 with r6, and flag drift when the 90% interval of the paired delta excludes 0;
  - R_A = 3 for later items, which cuts the SD by 9%.
- Rule: if union(3) minus union(2) is below 3 must-finds of 60, the runs3 deletion is confirmed.
- Pooling three repeats from two result files is unverified.

## 5. Decisions for the user

- D1: the pilot rule of section 2.1. It replaces "not below the subset baseline".
- D2: the non-inferiority guard of section 2.1 for natural recall.
- D3: the targeted-lever ship rule of section 2.1.
- D4: the seed kinds "regression" and "intent", their place in the kind order, and one paid seeding round ($15 to $30). This resumes paused seed work.
- D5: deletions. runs3 now. lenses3, callers, and architecture after F1 and M9.
- D6: PR notes (`--notes`) in the next baseline, after Gate JC-A.
- D7: one low-effort run read as the E-LOW screen and as twice-lite (M5).
- D8: approval of each paid item.

## 6. Work packages

Run them in this order, one implementer at a time.

1. WP-RM3 (implementer, on main): probe history.
   - Files: scripts/eval/cases.ts (a case field for commits before the base, and buildRepo), five cases in fixtures/eval/probe/probe-hist-*, tests/eval/probe.test.ts, and docs/eval/local.md (probe list).
   - Done when: git_blame at BASE names the fix commit in one test, and `bun run check` is green.
   - Control mutation: drop the history commit, and the blame test must fail.
   - Risk: a cases.ts conflict with WP-RM1.
2. WP-RM1 (implementer; retry with implementer-xhigh): rebase jc5-r onto main, in a fresh worktree if the jc5-r worktree holds uncommitted work.
   - Files: the 15 files of the jc5-r diff.
   - Do not push to main before Gates JC-A and JC-B (jira-context.md section 8, row 8).
   - Done when: `bun run check` is green, and the plan print of `bun run eval -- --set local --variants git-history --jira-family --tasks-overlay <fixture overlay>` shows both settings.
   - Risk: run.ts and ab.ts conflicts with d3cda25, c63912b, ca795d1, and the dropvar change.
3. WP-RM2 (implementer, on the rebased branch): overlay follow-ups.
   - scripts/eval/label.ts: the judge reads `requested.tasksOverlay`. It refuses a missing file or a changed file, by hash.
   - scripts/eval/run.ts: replayRefusal accepts `--tasks-overlay` with `--replay-find` when the recording has the same overlay hash and the same jiraFamily.
   - scripts/eval/compare.ts: print the overlay hash of each side, and warn on a mismatch. Add `--cases <ids>`, which trims both sides and replaces the scratch trim of results.md:250.
   - Also: the tests in tests/eval/, with one control mutation each, and docs/eval/local.md.
   - Risk: the judge then sees overlay text in Gate JC-A too. Update the JC-A bias note.
4. WP-RM4 (implementer-xhigh, after D4): the seed kinds regression and intent.
   - Files: scripts/eval/seed.ts, scripts/eval/seed-build.ts, tests/eval/seed*.test.ts, and docs/plans/review-v2/seeded-truth.md.
   - Done when: the mechanical checks of section 2.2 have tests, the overlay text freezes into the seeded case, and `eval:seed report` lists both kinds.
   - Risk: a new kind order can relabel old seeds. The new kinds need proof fields that old seeds do not have, so old seeds keep their kinds. Test that.

## 7. Invariants

- r6 stays a valid reference on main: the prompt version is 2.9 and the profile version is 9 on both commits (review.ts:27, config.ts:73).
- Rows without the new fields give the same task.md bytes (jira-context.md AC-JC14). So the control context on the rebased branch equals r6.
- The control arm has the same rl-git tools as the variant (git-mcp.ts:15, 49).
- No later commit leaks through rl-git: TARGET points at the case base (cases.ts:437-444), and resolve accepts only ancestors (git-mcp.ts:159-172).
- Eval runs never call Jira: the profile has `mcp: []` (catalog.ts:128), and jc5-r refuses a Jira source.
- A finder-changing variant cannot replay (run.ts:327-351).
- The seed fold rewrites only base..H, so BASE history stays (seeded-truth.md S8).

## 8. Unverified

- The number of cases with task text, and how many get more text from the overlay (eval:refetch-tasks prints both).
- Whether the r6 set folder still has the r6 fingerprint.
- The number of large cases in r6.
- The number of hosts that can take regression seeds and intent seeds (F5).
- Whether eval:refetch-tasks and `bun run eval` read the folder named in REVIEW_LOOP_EVAL_LOCAL, and whether that works for the seeded folder.
- Whether repeats from separate result files can be pooled.
- The cost factor of git-history on large cases, and of the overlay text.
- The correlation of seed deltas inside a group, and the seed hit rates that the power lines assume.
