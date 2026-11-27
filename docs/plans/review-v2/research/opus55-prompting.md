# Research: Opus 5.5 prompting practice against the app prompts (2026-11-27)

Status: research only. No code changed. Every expected effect is a guess until an eval runs. Code facts are at commit fa60e67.

Source rule (user, 2026-11-27): a recommendation counts only when a source written for Opus 5.5 states it, or a Claude 5 family source that an Opus 5.5 source says applies to 5.5. A practice that only older guidance states (Claude 3.x, Claude 4.x, generic prompt tips) is marked "older model, not used".

## 1. Short answer

- Open decision D1 for the user: [55] says "For techniques that apply across all current Claude models, see Prompting best practices." Under a strict reading, the [BP] sections that name no model are generic and not used (section 5). Under a wide reading, [55] adopts them for Opus 5.5. This note uses the strict reading. With the wide reading, the idea "give the reason behind each rule" comes back as a style55 hypothesis (section 8.1, last bullet).
- The review prompts already match the Opus 5.5 guidance. Opus 5.5 guidance asks for no rewrite of a working Opus 5 prompt. It names effort as the main control.
- The review prompts have no ALL-CAPS or MUST emphasis, no "think carefully" text, no reasoning-in-the-reply request, and no "only report high-confidence" filter. One build-run line is a candidate to remove on 5.5 grounds: "Run it again after your change" (src/server/tasks/implement.ts:756), because the app runs the checks after the run anyway (row 21).
- Our own data is consistent with the main review rule for the Claude 5 family. The U-V1 variant "signal" ("leave out low confidence") found 3 of 26 bugs against 7 of 26 without it (one repeat, bundled with other variants; docs/eval/results.md, U-V1).
- Two clear text bugs exist, independent of any guidance. The verify prompt says "Give no nits" and also "A false comment or TODO is a nit". The finder line "One exception:" does not follow the rule that it modifies.
- The largest 5.5-specific gap is in Build a Jira task, not in review. A build run that stops to report becomes a "Needs you" block. The Opus 5.5 guide names this exact case and gives a harness fix and a prompt fix (section 9).
- The best measurable review experiment on 5.5 grounds is effort, not wording: a low-effort cost arm (section 8.2).

## 2. Sources

All pages were read on 2026-11-27. The docs pages show no date, and the server sends no Last-Modified header. So the order in time between the blog (2026-09-22) and the live [55] and [O5] text is unknown.

| Tag | Source | Date | Targets | Used |
|---|---|---|---|---|
| [55] | "Prompting Claude Opus 5.5", https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-5-5 | undated, live 2026-11-27 | Opus 5.5 | yes, read in full |
| [Blog] | "Getting the most out of Opus 5.5 in Claude and Claude Code" (the user's link), https://claude.dev/blog/getting-the-most-out-of-opus-5-5/ | 2026-09-22 | Opus 5.5 | yes, read in full |
| [EF55] | "Effort", Opus 5.5 row of "Recommended effort levels", https://docs.claude.com/en/docs/build-with-claude/effort | undated, live 2026-11-27 | Opus 5.5 | yes, that row only |
| [O5] | "Prompting Claude Opus 5", https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/prompting-claude-opus-5 | undated, live 2026-11-27 | Opus 5 | yes, through the [55] bridge below |
| [BP] | "Prompting best practices", https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices | undated, live 2026-11-27 | all current models; many sections name Opus 4.5 or 4.6 | only where a section names Opus 5.5 (see D1) |
| [CLI] | Claude Code CLI reference and sub-agents, https://code.claude.com/docs/en/cli-reference , https://code.claude.com/docs/en/sub-agents | undated, live 2026-11-27 | the CLI | facts about flags only |

The bridge, [55]: "Existing Claude Opus 5 prompts should perform well without changes, and the patterns in Prompting Claude Opus 5 remain a reasonable starting point." So the [O5] patterns count, unless [55] says otherwise.

What is new against research/research-opus55.md (2026-10-22): that note read only index rows and mixed 4.x-era tips with 5.x facts. This note reads [55] and the blog in full, applies the 5.5-only rule, and links each point to our measured U-V1, W2, and W3 results.

## 3. Opus 5.5 guidance that applies to this app

- E1, effort [55]: "Start at medium, the default on Claude Opus 5.5 (Claude Opus 5 defaults to high), set it explicitly, and test several levels against your own evals rather than carrying over the setting you used on Claude Opus 5."
- E2, effort [55]: "Claude Opus 5.5 at medium matches or exceeds Claude Opus 5 at high on coding and knowledge-work evaluations, and on several coding evaluations low comes close to it at much lower cost." Also: "Reserve xhigh and max for work where you've measured a quality gain."
- E3, effort [55]: "To get less thinking, lower the effort level first. Lowering effort reduces thinking, and with it cost and latency, more reliably than prompt instructions do." [EF55]: "Run an effort sweep on your own evals rather than carrying settings over from an earlier model."
- R1, review [55]: "Early testers also reported stronger code review, with more bugs caught than on Claude Opus 5 and fewer false alarms". [Blog]: "One early tester said Opus 5.5 at its lowest effort caught more bugs than Opus 5 at high effort, with fewer false alarms."
- R2, review [O5, via bridge]: "If your review prompt says 'only report high-severity issues' or 'be conservative,' the model might follow that instruction literally and report less; ask it to report everything and filter in a separate pass instead." Also: "Accuracy holds at lower effort settings, which supports a fast pass at review time and a more thorough pass later."
- R3, review prompt [Blog]: "List only problems you'd block the merge for. For each one, give the file and line, why it's wrong, and how to show it fails."
- T1, thinking [Blog]: "Remove 'think carefully,' 'think step by step,' and similar lines from your prompts and your saved instructions." [55]: "The model determines how much to think, and the effort level is the main control."
- T2, reasoning in the reply [55]: "Requests that push the model to reproduce its internal reasoning in the response text might be declined with the reasoning_extraction category." "You can still ask for a short explanation of the answer or a summary of the actions taken".
- V1, verification [O5, via bridge]: "If your prompt contains explicit verification instructions ... remove them: instructions like these cause over-verification". Also: "Avoid instructing re-checks it already performs".
- S1, scope [O5, via bridge]: the sample "Deliver what was asked, at the scope intended."
- S2, subagents [O5, via bridge]: "give explicit guidance on which scenarios warrant delegation, or set deterministic caps on how many agents can be launched." Also: "with a custom or omitted system prompt, add a delegation instruction ... yourself."
- L1, length [O5, via bridge]: "To control response length, prompt for it explicitly."
- C1, unconfirmed items [Blog]: "Add 'Mark anything you couldn't confirm, and say where you looked' to the request."
- D1, done line [Blog]: "Say what 'done' looks like, then let it run."
- U1, unattended runs [55]: "some of those updates end the turn with text rather than a tool call ... An unattended agent loop that treats such a turn as the end of the task stops running there." Fix: "If a turn ends with items still open and no blocker stated, send a short user message naming them ... stop after two or three automatic continuations on the same task". [55] also gives a system prompt paragraph that names four unwanted stops, to add "at the end of your system prompt from the first request of the session".
- U2, stops [Blog]: "It follows instructions that name these stops. Name the stops you want, too."
- P1, pasted text [55]: "mark which text is the user's own and which was pasted from somewhere else", with `<pasted_content id="...">` tags and a system prompt note.
- K1, caching [55]: "Changing the top-level effort value between requests invalidates the cached messages."
- X1, explore first [55], multiapp section: "Claude Opus 5.5 tends to get to work quickly, and on loosely specified tasks it helps to tell the model to look through the relevant sources before acting."
- X2, settled answers [55], chat: "Once you have answered something, treat that answer as done." [55]: "Leave it out where you want the model to keep re-examining its earlier work".

## 4. The conflict between the blog and the docs

- [Blog] (2026-09-22, Opus 5.5) shows a one-pass review prompt: "List only problems you'd block the merge for."
- [O5] (Opus 5, live 2026-11-27, applies to 5.5 through [55]) says such a filter makes the model report less, and a pipeline should report everything and filter in a separate pass.
- Which is newer: the blog is written for Opus 5.5 and has a date. The [O5] text targets the older Opus 5. The live [55] page keeps the Opus 5 patterns as the starting point, but its date, and so its order against the blog, is unknown. [55] itself gives no review filter rule.
- They answer different setups. The blog prompt is one pass for a person. [O5] is for a pipeline with a filter step. The app is a pipeline: finder, then verify, then app caps. So [O5] applies.
- Our data is consistent with [O5] for our pipeline: U-V1 "signal" found 3 of 26 bugs against 7 of 26 (prompt 2.3, 16 cases, one repeat, bundled with other variants). The model of that run is not recorded in this note (unverified).

## 5. Older guidance: not used

These points appear only in older guidance, or in [BP] sections that name no model ("generic, no model named"). No 5.5-era source repeats them. They drive no change here. Decision D1 (section 1) can move the generic rows into use.

| Practice | Where it is stated | Status | Our prompts |
|---|---|---|---|
| Soften "CRITICAL: You MUST" to normal wording | [BP], stated for Opus 4.5 and 4.6 | older model, not used | 0 ALL-CAPS words anyway, so nothing to remove |
| Tune down anti-laziness prompting | [BP] migration list, stated for Claude 4.6 | older model, not used | No "be thorough" pressure found |
| Use structured outputs instead of prefill | [BP] migration, stated for Claude 4.6 | older model, not used | We use `--json-schema` for app reasons, not on this advice |
| Give the reason behind each rule | [BP] general principles | generic, no model named; not used | 2 of 90 rl-main lines give a reason. No change proposed (see D1). |
| "Tell Claude what to do instead of what not to do" | [BP] output-format section | generic, no model named; not used | 20 negative lines in rl-main, mostly scope and safety rules. No change proposed. |
| Long documents first, question last | [BP] long-context section | generic, no model named; not used | Not relevant: inputs are ./context files read by tools |
| Prompt for parallel tool calls | [BP] tool-use section | generic, no model named; not used | No parallel line. No change proposed. |
| Examples steer the output | [BP] general principles | generic, no model named; not used | The rubric has short severity examples (catalog.ts:867-869). No example finding exists. No change. |
| XML tags for prompt parts | [BP] general principles | generic, no model named; not used | Prompts use Markdown headings. No change. |
| Prompt caching prefix order | [PC] API docs, no model named | generic, not used | Only K1 ([55]) applies: keep effort fixed inside a run. We do. |
| Remove duplicated rules | no source; repo hygiene | not guidance | LARGE_FILE_RULE is in the agent prompt (catalog.ts:608) and in stdin (prompt.ts:76). "./repo holds the source branch" is in both (catalog.ts:605, prompt.ts:75). Clean up only at the next REVIEW_PROMPT_VERSION bump. Guess: no measurable effect. |

## 6. Comparison, one row per 5.5 recommendation

Gap: yes, no, or partial. "Bug" marks a text defect that needs no guidance to fix.

| # | 5.5 guidance (tag) | What our prompts do (file:line) | Gap | Change | Expected effect |
|---|---|---|---|---|---|
| 1 | Report everything, filter in a separate pass (R2) | Finder: "Report every problem that you find. A second step checks each finding ..." (src/server/review/catalog.ts:697). Verify is a separate run (verifyAgent, catalog.ts:1855). | No | None. U-V1 "signal" went the other way and lost bugs. W3 "broad" moved the do-not-flag list to verify: +0.7 points, not significant, +23% cost. | - |
| 2 | No "think carefully" text (T1) | 0 such lines in catalog.ts, prompt.ts, src/server/tasks/*.ts (string scan). | No | None. | - |
| 3 | No reasoning in the reply (T2) | Fields ask for short reasons only: reason, why, coverage (catalog.ts:1810, 630, 476). | No | None. | - |
| 4 | No re-check lines in the finder (V1) | None. "Read each changed function to its end, and read its callers" (catalog.ts:97) is a read rule, not a re-check. Verify is a separate pass by app design. | No | None. | - |
| 5 | Set effort explicitly, start at medium (E1) | Explicit medium on each run: finder, rl-reviewer, verifier, Explain (catalog.ts:130-135, 112, 1926; src/server/review/claude.ts:605). | No | None. | - |
| 6 | Sweep effort on own evals; low comes close at lower cost (E2, E3, R1, R2) | C1b measured medium against high (results.md, W2). Low is not measured. | Yes | Cost arm E-LOW (section 8.2). No arm above medium: E2 says to reserve xhigh for a measured gain, and W2 showed no recall gain from high. | Guess: lower cost per case run at a recall risk that only the full set can bound. |
| 7 | Low effort also for the filter pass (R2 "fast pass") | Verifier at medium (catalog.ts:135). | Partial | Verifier-low as a verify-only replay on the full r6 recording: `bun run eval` takes `--verifier-effort` and `--replay-find` (scripts/eval/run.ts:116, 231, 334-350). eval:ab has no candidate verifier-effort flag. | Guess: lower verify cost; risk of more wrong confirms. |
| 8 | Review output: file, line, why, how to show it fails (R3) | Place rules, trigger, body, evidence (catalog.ts:620-624, 706-711). | No | None. | - |
| 9 | Mark what you could not confirm (C1) | COVERAGE_RULE (catalog.ts:476), evidenceStatus (catalog.ts:712), "In why, name what you checked" (catalog.ts:630), ask: "Say so when you did not check a claim" (catalog.ts:1302). | No | None. | - |
| 10 | Prompt for length explicitly (L1) | Title 12 words, body 3 sentences (catalog.ts:710). Spec line caps (catalog.ts:1431). | No | None. | - |
| 11 | Cap delegation; own delegation rule with a custom prompt (S2) | The app decides delegation (catalog.ts:251), Agent(rl-reviewer) allowlist (claude.ts:566), "Start no other agent." (catalog.ts:1030), AGENT_PARAMS_RULE (catalog.ts:1051). | No | None. Whether `--agent` replaces the default system prompt is unverified; the app gives its own rule in either case. | - |
| 12 | Deliver at the scope asked (S1) | Fix: "Make the smallest fix." (catalog.ts:1239). Build: "Change only what the step needs." (implement.ts:887). | No | None. | - |
| 13 | Name the finish line (D1) | Build: "End the run when every open task is ticked and its tests pass, or when you need the user." (implement.ts:798). | No | None. | - |
| 14 | Unattended runs: continue on a report stop; name the unwanted stops (U1, U2) | An early stop with open tasks becomes "Needs you: Claude ended the run before part N was done" (src/server/tasks/loop.ts:2532-2537). No automatic continue. The prompt names only the wanted stops (implement.ts:798, 888). | Yes | Section 9. | Guess: fewer "Needs you" blocks per part. |
| 15 | Mark pasted text in user messages (P1) | The Ask question and the run note go raw into "# Your instructions" (src/server/review/prompt.ts:113-115). PR and tracker text already stay in ./context files marked untrusted (prompt.ts:77-107). | Partial | Low priority. Useful only when the UI gets a separate paste field. The app cannot tell typed text from pasted text today. | Guess: small. |
| 16 | Keep effort fixed inside a conversation (K1) | Effort is fixed per CLI run. | No | None. | - |
| 17 | Literal filters in other run kinds (R2) | Plan check: "Report only problems that you confirmed in the code." and a cap (catalog.ts:1512, 1518). Critic: "Report only problems in the lines that this change adds." (prompt.ts:43). | No | None. Both are scope or precision rules by design. The plan check has a repair round after it. | - |
| 18 | Contradictions (no guidance needed) | Verify gets "nit: optional polish. Give no nits." (rubric, catalog.ts:870) and "A false comment or TODO is a nit." (catalog.ts:1721). Rendered rl-verify lines 32 and 73. | Bug | Section 7, B1. | One nit rule for the verifier. |
| 19 | Clear referents (no guidance needed) | "One exception: you can also report a problem in unchanged code" (catalog.ts:637) follows the anchor line (catalog.ts:700), not "Report only problems that the change adds" (catalog.ts:699). With submodules it follows "so set preexisting to false" (catalog.ts:516). | Bug | Section 7, B2. | The exception binds to the right rule. |
| 20 | Salvage focus (no guidance needed) | Salvage keeps "When you cannot name a trigger, search the code for one" and "Read the changed code, its callers, its tests, its config" (rendered salvage lines 25 and 32) beside "Look for no new problems" (catalog.ts:1889) and a 6-turn cap (catalog.ts:1878). | Partial | Candidate, not a bug: drop the two search lines in salvage only. First count from stored run rows how often salvage hits its turn cap (free). | Guess: fewer cut salvage runs. |
| 21 | Remove re-checks of own work (V1) | Fix step: "Run the failing check first to see the failure. Run it again after your change." (implement.ts:756). The app runs the approved checks after each run (implement.ts:827-833). Other check lines check claims of other people or of an earlier run, not own work: reply (catalog.ts:1195), fix (catalog.ts:1238), discuss "follow its trigger again before you answer" and "Check each claim of the user" (catalog.ts:1275-1276). The build TDD lines (implement.ts:747-749) are the done line, not a re-check. | Partial | Candidate to remove: "Run it again after your change." Keep the other lines. Measure turns and green rate on the task smoke runs. | Guess: fewer turns per fix step, same green rate. |
| 22 | Explore before acting (X1) | X1 targets multiapp workflows. The review analogue is "callers" (read callers and consumers first): it failed, −3.3 points, +24% cost (results.md, 2026-11-25). | No | None. | - |
| 23 | Time signals for multiagent teams ([55]) | None. | No | None. The lead waits for its rl-reviewer calls, and the app has its own time limits. | - |
| 24 | Treat earlier answers as settled (X2) | Ask follow-up: "Answer only the current question" (FOLLOW_UP_RULE, catalog.ts:1267). Discuss must re-examine a finding when the user challenges it. | No | None. X2 says to leave the rule out where earlier work must be re-examined. | - |
| 25 | Progress updates between tool calls ([55]) | `-p` runs with a schema. The app shows tool events from the stream. | No | None. | - |

## 7. Clear bug fixes

Both fixes change default prompt text. The repo rule says: "Every prompt change is first a variants switch, so the default prompt bytes stay the same" (docs/plans/review-v2/review-quality-2026.md section 2). A default change also needs a REVIEW_PROMPT_VERSION bump, and eval:ab then refuses baseline r6 (scripts/eval/ab.ts:296-297). A new full baseline costs about $215 (results.md, r6).

- B1, nit contradiction in verify. Cause: verifyRules adds rubric(p) (catalog.ts:1833), and the rubric carries the finder volume line "Give no nits." (VOLUME_NITS, catalog.ts:859-863). RISK_BLOCK_RULES tells the verifier to set nit for a false comment (catalog.ts:1721). The opt-in POLISH_VERIFY (catalog.ts:689) and obligationRules (catalog.ts:1768) also set nit, so they meet the same line. Fix: in verifyRules only, replace the volume line with a verify line, for example "nit: optional polish. At volume quiet and balanced, the app folds nits." The display rule confirms it: quiet shows only blocker and major in main, and balanced folds a nit (src/shared/review.ts:302-303). The finder keeps "Give no nits". Test: the verify prompt has no "Give no nits" line, and the finder prompt still has it.
- B2, dangling "One exception". Fix: start the line with the rule it changes, for example "One exception to the rule on what the change adds: you can also report a problem in unchanged code that the change touches or relies on." Move PREEXISTING_LINES to right after catalog.ts:699, before the anchor line and the submodule lines. Test: the pre-existing block follows the "Report only problems that the change adds" line in rl-main, rl-reviewer, and salvage, with and without submodules.
- Delivery: B1 behind a verify-only variant "style55-verify", B2 behind "style55" (section 8.1). Ship both in the next REVIEW_PROMPT_VERSION bump even when nothing else ships, because they remove a defect and add no behavior.

## 8. Proposed package

### 8.1 Variants "style55-verify" and "style55": the bug fixes only

- Under the strict 5.5-only rule, no 5.5 source asks for a rewrite of a working Opus 5 review prompt ([55] bridge), and the 5.5 rules in section 6 are met. So the variants hold only B1 and B2. They add no new wording.
- The split follows the existing pair "security2" and "security2-verify". "style55-verify" holds B1 only and joins VERIFY_ONLY (scripts/eval/run.ts:312), so it can replay the full r6 recording. "style55" holds B2 and also turns on B1.
- Smallest diff: src/shared/dto.ts (add both names to VARIANTS); src/server/review/catalog.ts (the B1 nit line in verifyRules under either variant; the B2 order and wording in finderRules under "style55"); scripts/eval/run.ts (add "style55-verify" to VERIFY_ONLY). The default bytes stay the same.
- Tests (pure, following tests/review/architecture.test.ts): the default prompts keep their bytes (snapshot); the B1 and B2 tests of section 7 under each variant; promptVersion gives "2.9+style55" and "2.9+style55-verify"; finderVersion drops "style55-verify". Control mutation: apply B2 without the variant, and the snapshot test must fail.
- Also touched: tests/review/prompt.test.ts (VARIANTS pin), docs/eval/local.md (variant bullets), review-ledger.md (new rows). No UI change, so no screenshots.
- Check of B1, verify-only replay on the full natural set: `bun run eval:ab -- --baseline <r6 folder> --candidate-variants style55-verify --candidate-replay --review-only`. It runs only the verify calls of 82 case runs. Estimate (guess): the verify share of $2.63, about $0.4 to $0.8 per case run, so $35 to $65, plus about $5 for labels. Ship rule "not worse".
- Check of B2, optional screen P-55: the fixed 10-case natural subset of the lenses3 run, repeat 1, effort medium, against the same 10 cases of baseline r6, as P-GH did (results.md, 2026-11-26). Gate as P-GH (git-history.md section 5): the noise rule passes, and grounded recall is not below the subset baseline (35.7%, 10 of 28). Estimate: about $16, because the prompt does not grow and the subset baseline costs $1.59 per case run, plus about $2 for labels.
- P-55 commands (case IDs as in the P-GH run; they live in eval-results, which this note did not read): `bun run eval -- --set local --cases <the 10 subset IDs> --variants style55 --repeat 1 --real --out eval-results/style55/subset`, then `bun run eval:label -- eval-results/style55/subset --real`, then the scratch trim of baseline r6 to the subset and `bun run eval:compare -- <trimmed r6 result.json> <style55 result.json>`. `--candidate-replay` refuses "style55", because B2 changes the finder prompt version (scripts/eval/run.ts:345-347).
- Limit: the 10-case subset gave paired intervals of about ±15 to 20 points (lenses3 −4.9 to +26.3, git-history −28.1 to +6.7). P-55 is a not-worse screen, not a proof of gain.
- Only if the user takes the wide reading of decision D1: add a "reasons" arm to "style55" (a 3-line purpose block in the finder and 2 lines in verify that say who reads the result and what each error costs). It is a recall hypothesis, so it runs apart from the cost arms.

### 8.2 Cost arm E-LOW (the main 5.5 experiment)

- Basis: E2, E3, R1, R2. All four say that low effort keeps most review quality on Opus 5.5 or the Claude 5 family.
- Screen on the same subset, repeat 1, shipped prompt, no variant: `bun run eval -- --set local --cases <the 10 subset IDs> --effort low --reviewer-effort low --repeat 1 --real --out eval-results/effort-low/subset`. `eval` takes both flags (scripts/eval/run.ts:116).
- Estimate (guess): 0.5x to 0.75x of $1.59, so $0.8 to $1.2 per case run, $8 to $12 total, plus about $2 for labels.
- On a pass: the full natural set, repeat 2, with `eval:ab --candidate-effort low --candidate-reviewer-effort low` against baseline r6. Ship rule "not worse" (a cost cutter). Estimate (guess): 82 case runs x $2.63 x 0.5 to 0.75, so $108 to $162, plus about $5 for labels.
- Cost cutters and recall raisers never share a run (review-quality-2026.md section 2), so E-LOW and the style55 variants run apart.
- A verifier-low arm (row 7) follows after E-LOW, as a verify-only replay with `bun run eval -- --replay-find <r6 folder> --verifier-effort low` on the full set. Estimate (guess): $35 to $65.

## 9. Build runs: unattended early stops (Build a Jira task)

- Facts: the build prompt names the finish line and the wanted stops (implement.ts:798, 888). After the run, loop.ts:2532 blocks the part as "unfinished" when open tasks remain, or when done is false with no checklist. The user must click Continue.
- Basis: U1 and U2 ([55], [Blog]) describe this case for Opus 5.5 and give two fixes: a short message that names the open items, at most two or three times; and a paragraph that names the unwanted stops, added from the first request.
- Step 1, free and read-only: count the "unfinished" blocks per part in the user's own data, and how many a single Continue cleared. The user or a runner reads the user's database read-only. Tests never touch it.
- Step 2, only when step 1 shows the case is common: one automatic continue per build run when done is false, open tasks remain, and the result has no question, allowRequest, specChange, or checkCause. Cap it at 2 per part. This is a new transition in the part state machine, so the design must give the full transition table and a machine test (user rule on state machines).
- Step 3, measured with step 2: add an adapted [55] paragraph to the build run role at session start. Do not add it mid-session: [55] says a system prompt change partway "invalidates the conversation's earlier thinking blocks".
- Also in this package: remove "Run it again after your change" from the fix step (row 21), measured on the same task smoke runs.
- Expected effect (guess): fewer "Needs you" blocks for parts that only needed a Continue. Risk: a stuck run uses up to two more runs.

## 10. Not proven

- Which model baseline r6 and U-V1 ran. Profile `model` is null (catalog.ts:129). results.md names "Opus 5.5, medium" for the SG-A oracle look and "Opus at medium effort" for the posted findings, but this note did not read the r6 result header.
- Whether `--agent` replaces or adds to the default Claude Code system prompt.
- The order in time between the blog and the live [55] and [O5] text.
- Every cost estimate and every "Expected effect" is a guess.
