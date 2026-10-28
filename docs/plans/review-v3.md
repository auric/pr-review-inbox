# Review v3 plan

Status: planned, 2026-10-28. WP-V1, WP-V2, and WP-V3 are code complete. Gate U-V1 is next. The user decided D1 to D3 (section 1) and the open questions Q1 to Q9 and Q11 to Q13 (section 9) on 2026-10-28. Q10 stays open.

Sources: a comparison of our review pipeline with a similar app (2026-10-28, not in the repository), BRIEF.md sections 3.5 and 3.6, docs/plans/review-v2/design.md (R1 to R17, M1 to M4), docs/plans/review-v2/tasks.md (package format), scripts/eval/, and src/server/review/{catalog.ts, prompt.ts, validate.ts, codegraph.ts, jobs.ts}. Never name the other app, its author, or any company, host, or project in this repository.

## 0. Goal and success measure

- Goal: the review finds more of what the user posts and raises less of what the user throws away.
- Measure: a local eval set built from the user's own decisions (WP-V1). A posted finding must come back. A finding that the user discarded as wrong or intended must not come back.
- Success: the shipped pipeline beats the current one (prompt version 2.3, verifier on) on the local set. Cost per case and minutes per case stay equal or lower.
- "Beats" means both: posted recall rises by more than the repeat spread of the baseline, and the must-not-raise rate does not rise by more than that spread.
- Guard: the synthetic sets v1 and hard stay at their G-EVAL-1 recall, minus 5 points at most. Their trap rate does not rise.
- Every variant runs with `--repeat 2`, the same model, the same effort, and the same CLI version as its baseline.

## 1. Decisions (2026-10-28)

| ID | Decision | Replaces | Why |
|---|---|---|---|
| D1 | A serious problem in unchanged code stays as a folded "Pre-existing" group. The app never posts it by default. | design.md R6 for this case. A finding with a changed anchor or a changed cause keeps R6. | The drop loses real signal. A fold keeps the main list short. |
| D2 | CodeGraph indexes the sanitized snapshot by default for every review when the `codegraph` CLI is installed. A profile can turn it off. | The opt-in user MCP pick as the only path (jobs.ts profileServers). | Callers outside the diff need an index. Grep alone misses them. |
| D3 | CI build log investigation comes in a later wave. It needs a BRIEF 3.6 change (a new outbound origin) and the user's CI facts first. | None. | A new origin is a hard-rule change. Section 9 lists the facts. |

Plan decisions that follow from D1 to D3 and the comparison:

| ID | Decision | Why |
|---|---|---|
| V1 | Measure first. No prompt change ships before the local set and its baseline exist (gate U-V1). | The synthetic sets sit near the ceiling. G-EVAL-1 showed no clear gain at about 1.8 times the cost. |
| V2 | Each prompt idea is a named switch: a module (`--modules`) or a profile variant (`--variants`). The default prompt bytes stay the same until a variant wins. | The eval compares variants on one commit. A lost variant is deleted, not kept. |
| V3 | A variant ships only when it wins under section 0. WP-V4 then makes it the shipped default and deletes the losers. | No untested prompt text in the product. |
| V4 | The local set and its results never enter git. They hold company code and the user's comments. Only aggregate numbers go to docs/eval/results.md. | CLAUDE.md: no company names, hosts, or code in the repository. |
| V5 | The default CodeGraph server runs only an installed `codegraph` executable. It never runs npx or a package download. | A download is an outbound call that BRIEF 3.6 does not allow. |

## 2. Rules for every work package

- The rules of docs/plans/review-v2/tasks.md section 0 apply. In short: read CLAUDE.md of the main checkout, one implementer per package, green `bun run check`, a control mutation per safety check with the "imported from" proof, fake CLI and fake servers only, SPDX headers, the orchestrator commits.
- A package that touches e2e files runs `bun run test:e2e` on its own ports (section 4 table). Its report quotes the `E2E code:` line of serve.ts.
- A package that changes the UI runs `bun run screenshots`, checks each image for real names, hosts, and paths, updates README.md, and runs the web-design-guidelines review.
- A package that changes review agent text raises REVIEW_PROMPT_VERSION, except when a snapshot test proves the default prompt bytes are unchanged.
- A package that adds a profile field keeps profileRevision of an unchanged profile the same when the field holds its default (as WP-R1 did).
- No test or eval run reads the user's live data folder. Only the local set builder reads it, strictly read only: a temp copy of the database and read-only git commands on the cache. It writes nothing there.

## 3. Waves

| Wave | Packages (∥ = parallel worktrees) | Needs |
|---|---|---|
| W1 | WP-V1 | the user's go (given 2026-10-28) |
| W2 | WP-V2 ∥ WP-V3 | WP-V1 |
| U-V1 | User gate: `bun run eval:ab`, the shipped profile against the candidate (section 5) | WP-V1, WP-V2, WP-V3 |
| W2b | WP-V4 | U-V1 |
| W3 | WP-V5, then WP-V6, then WP-V7, then WP-V8 (shared files, merge order); WP-V9 after each server part merges | WP-V4; WP-V5 also needs the BRIEF 3.5 approval (section 6) |
| U-V3 | User gate: CodeGraph on against off, and the pre-existing count; smoke docs/smoke-review-v3.md | W3 |
| W4 | WP-V10a, then WP-V10b; WP-VCI0 (gate, read only) | U-V3 (V10); D3 facts and the BRIEF 3.6 approval (VCI) |
| W4b | WP-VCI1, then WP-VCI2; WP-V12 only when U-V3 leaves a gap | WP-VCI0 passed; the gap rule of WP-V12 |

Shared-file ownership (merge order):

| File | Owners |
|---|---|
| scripts/eval/* | WP-V1 → WP-V3 → WP-V2 (flags) → WP-V5 (`--codegraph`) |
| src/server/review/catalog.ts, prompt.ts | WP-V2 → WP-V4 → WP-V5 → WP-V6 → WP-V7 → WP-V8 → WP-V12 |
| src/shared/review.ts, src/shared/dto.ts | WP-V2 → WP-V6 → WP-V7 → WP-V8 → WP-V10a (additive only) |
| src/server/review/jobs.ts, judge.ts, validate.ts | WP-V5 → WP-V6 → WP-V7 → WP-V8 → WP-VCI1 |
| migration 040 (review_check) | WP-V8 |
| src/web/review/*, src/web/settings/* | WP-V9 → WP-V10b → WP-VCI2 |
| tests/support/fake-claude.ts, tests/e2e/serve.ts | WP-V6 → WP-V7 → WP-V8 → WP-V9 → WP-V10b (adds only) |

## 4. Work packages

Ports: E2E_JIRA_PORT / E2E_FAKE_PORT / E2E_APP_PORT.

| Package | Agent | Ports |
|---|---|---|
| WP-V1 | implementer-xhigh | 7707/7708/7709 |
| WP-V2 | implementer-xhigh | 7717/7718/7719 |
| WP-V3 | implementer | 7727/7728/7729 |
| WP-V4 | implementer | 7737/7738/7739 |
| WP-V5 | implementer-xhigh | 7747/7748/7749 |
| WP-V6 | implementer-xhigh | 7757/7758/7759 |
| WP-V7 | implementer | 7767/7768/7769 |
| WP-V8 | implementer-xhigh | 7777/7778/7779 |
| WP-V9 | frontend-implementer | 7787/7788/7789 |
| WP-V10a | implementer | 7797/7798/7799 |
| WP-V10b | frontend-implementer | 7807/7808/7809 |
| WP-VCI0 | implementer | none (read only) |
| WP-VCI1 | implementer-xhigh | 7817/7818/7819 |
| WP-VCI2 | frontend-implementer | 7827/7828/7829 |
| WP-V12 | implementer-xhigh | 7837/7838/7839 |

### WP-V1. Local eval set from the user's decisions (implementer-xhigh, W1; idea 1)

- Files: scripts/eval/local.ts (new: `bun run eval:local -- --db <copy> --cache <copy> --out <folder>`); scripts/eval/cases.ts (set `local`, read from REVIEW_LOOP_EVAL_LOCAL; a case kind with a git bundle remote instead of base files and head.patch); scripts/eval/run.ts (remote from the bundle; PR title, description, and task text from the case); scripts/eval/score.ts (near-line match, tolerance in the result); scripts/eval/compare.ts (refuses two results with a different set fingerprint or tolerance); package.json script `eval:local`; .gitignore (`eval-local/`); tests/eval/local.test.ts (new); docs/eval/local.md (new: how to build and run; no data).
- Input: the SQLite file and the cache folder of the data folder of the app (config dataDir), or the `--db` and `--cache` paths. The builder reads them strictly read only. It refuses an `--out` folder inside the live data folder.
- Selection, deterministic:
  - One case per reviewed (PR, head commit). Base and head come from the run row (merge base, head).
  - Bugs: findings that the user posted, at their anchor (path, side, line, lineEnd), with the severity of the posted text.
  - Must not raise: findings that the user discarded with reason code `bug` (Not a bug) or `intended`. They become traps of the existing scorer.
  - Neutral: discards with `worth`, `duplicate`, `place`, or no reason. They become extras: neither hit nor noise.
  - Skipped: findings that the verifier refuted and the user never restored. The verifier is under test, so its verdict is no truth.
  - Two opposite decisions on overlapping anchors of one case drop both. The builder log counts them.
- Repository: one git bundle per repository with the needed base and head commits, from the cache copy. The PR text, task text, and attachments-list come from the DB copy as context files. No call to Bitbucket or Jira.
- Scoring: a hit is an item on the same path and side whose range overlaps the posted range widened by T lines (default 3, section 9 Q2). The result file records T. Must-not-raise uses the existing trap match with T = 0.
- Output: `<out>/cases/<id>/case.json`, `<out>/bundles/<repo>.bundle`, and `<out>/MANIFEST.json` (counts and a fingerprint). No path, host, or name goes to stdout beyond counts.
- Tests: a synthetic DB copy and a temp repo built by the test. Cases: posted to bug, `bug` and `intended` to trap, `worth` to extra, refuted and unrestored skipped, opposite decisions dropped, two runs on one head merged, an `--out` folder in the live data folder refused, the output folder is git-ignored (`git check-ignore`).
- Control mutation: map `worth` to a trap. The neutral-discard test must fail.
- Eval measure: the set itself. U-V1 checks that it can tell variants apart.
- Depends: none.
- Implementation notes (2026-10-28):
  - docs/eval/local.md gives the build and run steps. `--db` and `--cache` default to the database and the `git` folder of the data folder. `--user` overrides `userSlug` of `config.json` beside the database file.
  - The case key is (PR, head, merge base), because old-side lines are numbered at the merge base. Runs on one head with one merge base make one case.
  - The decision on a carried finding is on its newest copy, as stats.ts reads it. Each run item of the chain gets that decision at its own anchor. A discard that stats.ts userDiscard does not count (fix commit, closing re-review, session reject) is left out.
  - The user's own comments (Q1) are root inline comments that the outbox did not post. The anchor toHash names the head of the case. An old-side comment also needs fromHash equal to the merge base. They score as human recall. A hit on one also counts for precision.
  - T widens bugs, human comments, and extras. Traps use T = 0. Fixture sets record T = 0, so old result files compare as before.
  - The result fingerprint hashes the case files that ran. A run with `--cases` gets another fingerprint than the MANIFEST, so compare refuses it against a full run.
  - A case has no PR comments: they show the answers. The task rows come from pr_task and task_context. Attachment files stay out.
  - The builder reads a temp copy of the database, because a read-only open of a WAL file still makes -shm and -wal files beside it. The bundle comes from a temp repository that borrows the objects of the cache copy (alternates).

### Gate U-V1. Shipped profile against the candidate (user)

- The user closes the app, runs `bun run eval:ab`, and sends the printed tables. docs/eval/local.md gives the flags.
- The command builds the local set from the data folder, read only. Then it runs the shipped profile (A) and the candidate of section 5 (B) on that set, with `--repeat 1`. It prints one table for the review cases and one for the re-review cases. It skips a mode without cases.
- Recommended minimum: 30 cases, 40 posted findings, 20 must-not-raise findings (section 9 Q3). The build output says when the set is smaller.
- The synthetic sets v1 and hard are not part of the gate. The orchestrator records the aggregate numbers in docs/eval/results.md.
- A mixed result: the user bisects with `--candidate-variants` and `--candidate-modules`.

### WP-V2. Prompt switches for wave 2 (implementer-xhigh, W2; ideas 3, 4, 7, 9)

- Files: src/shared/dto.ts (Profile `variants`: a list of "signal", "order", "rereview-strict", default empty; ModuleId adds "failures"); src/server/review/catalog.ts (finderRules for "signal", MODULES.failures, the process lines in mainAgent for "order"); src/server/review/prompt.ts (the strict lines in buildRereviewPrompt for "rereview-strict"); src/server/review/jobs.ts (prompt_version gets "+" and the sorted variants); src/server/config.ts and settings.ts (PROFILES_VERSION bump, default fill); scripts/eval/run.ts (`--variants a,b`); scripts/eval/cases.ts (MODULE_IDS adds failures); tests/review/prompt.test.ts, tests/review/catalog.test.ts, tests/eval/harness.test.ts.
- Behavior:
  - "signal" (idea 3): the finder rule "Report every problem" becomes a high-signal set: no finding is a good result; no trigger, no finding (a question instead); at most 3 nits; confidence high only after reading the code that proves it; leave out low confidence. Use it with verifier off and on.
  - "failures" module (idea 4): an ordered checklist: error paths, edge values, partial failure and retries, ordering, timeouts, leaks, upstream and downstream callers, visibility of failures. Each row needs a trigger. Only an unhandled row becomes a finding. A handled row gives nothing.
  - "order" (idea 7): an ordered process in the finder: diff stat and log first, then each changed file to its end, then callers and callees, then each module, then each candidate against the do-not-flag list, then the result.
  - "rereview-strict" (idea 9): a re-review reports blockers and majors only, no nits. It never raises a point that an earlier run raised, unless the new range made it worse.
  - The verifier switch exists already (profile verifier.mode, eval `--verifier`). This package adds nothing for it.
- Tests: the default prompt of each run kind is byte for byte the same as before (snapshot); each variant adds only its lines; prompt_version "2.3+order+signal" for two variants; an old profile without `variants` loads with an empty list and the same profileRevision; `--variants bogus` exits 2.
- Control mutation: add the "order" lines without the variant. The default snapshot test must fail.
- Eval measure: gate U-V1.
- Depends: WP-V1.
- Implementation notes (2026-10-28):
  - No PROFILES_VERSION bump. No shipped value changed, and the zod default fills `variants` with an empty list. config.ts and settings.ts stay as they were.
  - An unknown stored variant name drops on load now, as an unknown module ID does. The list keeps the VARIANTS order.
  - "failures" is a trial module (TRIAL_MODULES in dto.ts). The brief, the profile editor, and the Improve prompt do not offer it. The eval selects it with `--modules`. The profile editor keeps `variants` on a save, with no control for them.
  - "signal" changes the finder rules, so rl-main and rl-reviewer both get it. "order" goes to rl-main only, after the check sections.
  - Only a review or re-review run records the variants in prompt_version. Ask, reply, fix, discuss, and Explain rows keep REVIEW_PROMPT_VERSION. The eval result file records the same text in `promptVersion`.
  - "rereview-strict" changes only the re-review stdin. Without `--rereview` (WP-V3), it changes no prompt, but the prompt version still names it.
  - The tests are in tests/review/prompt.test.ts, tests/review/jobs.test.ts, and tests/eval/harness.test.ts. tests/review/catalog.test.ts does not exist. The snapshot hashes come from the default prompts of each run kind at commit d76bed0.
  - docs/eval/local.md gives the gate U-V1 command.

### WP-V3. Re-review eval mode (implementer, W2; measure for idea 9)

- Files: scripts/eval/local.ts (re-review cases: a PR with a review at head A and a re-review at head B); scripts/eval/run.ts (`--rereview`: a review run at A, then a re-review run at B, as the app runs them); scripts/eval/score.ts (re-review score); tests/eval/rereview.test.ts (new).
- Behavior: bugs are findings posted on the re-review at B. Noise includes any re-raise of a finding of run A that the user discarded or posted. Earlier verdicts (open, fixed, outdated) score against the user's later resolve state when it exists.
- Tests: fake CLI with two scripted outputs; a re-raise counts as noise; a new posted finding counts as a hit.
- Control mutation: skip the re-raise check. The re-raise test must fail.
- Depends: WP-V1.
- Implementation notes (2026-10-28):
  - The earlier run is seeded, not run. `--rereview` writes the earlier run into the temp database as the app had it when the re-review started, then calls the re-review of jobs.ts. One CLI run per case (two with the verify phase). The seed holds your real triage, so a re-raise of your decision is measurable. A live run at A would give other findings with no decision.
  - Seed: open findings (new or accepted) as new, so the re-review carries them. Posted findings with a confirmed inline post and an open root comment of the eval user, so the re-review lists them as posted. Discarded findings as discarded. The harness also fetches the earlier head into the cache first, as the review of A did in the app.
  - Synthetic sets: a fixture case with a `rereview` block and `earlier.patch` (fixtures/eval/README.md). The head is a child of the earlier head. Sets v1 and hard have no such case yet, so `--rereview --set v1` exits 2.
  - Local set: one case per re-review run (since_head set) in `rereview/` of the out folder. Its earlier run is the newest finished non-Explain review run of the PR before it (run-rows.ts baseRun). A missing run, or a run at another head, skips the case. MANIFEST.json `rereview.skipped.noEarlier` counts it.
  - The state of an earlier finding at the re-review start: a copy in the re-review run means open. Else its stored status. A discard by the check or by a fix commit is `dropped`: seeded as discarded, but no decision. `resolved` is the thread_resolved of the post comment of a posted finding.
  - Bugs, traps, and extras of a re-review case come from the items of the re-review run only, carried copies included. Your own comments stay out: the re-review checks only the new commits.
  - Score: a re-raise is a shown item that is no carried copy, hits no bug or own comment, and overlaps (with T) a posted or discarded earlier finding. It counts as noise and as `reRaises` (per case run). It takes precedence over an extra. Open and dropped findings get no re-raise check.
  - The earlier lines move to the head through `git diff -M` from the earlier head to the head (new side) or between the merge bases (old side). A range that the diff touches gets lines null and no re-raise check, because a new finding there can be about the new code.
  - Verdicts: only a posted finding has a later user state (its thread). A fixed verdict makes a resolve proposal (rereview.ts resolveProposals). verdictOk: proposal present equals thread resolved. Carried open findings get no verdict score.
  - `--variants rereview-strict` without `--rereview` exits 2. compare refuses a `--rereview` result against a plain one, so `eval:ab` compares the re-review cases in their own table.
  - Left out: questions of the earlier run, and posted findings of runs before the earlier run.

### WP-V4. Ship the winners (implementer, W2b)

- Files: src/server/review/catalog.ts (shipped profile: winning modules, variants, verifier mode); src/server/config.ts and settings.ts (PROFILES_VERSION bump; an unedited shipped profile upgrades, an edited one keeps its fields); src/shared/review.ts (REVIEW_PROMPT_VERSION bump); the losing variant code removed from catalog.ts and prompt.ts; tests; CHANGELOG.md; docs/eval/results.md.
- Behavior: the winners become the default text, not a variant. The `variants` field keeps only names that still exist. An unknown stored name drops on load.
- Tests: upgrade of an unedited and of an edited shipped profile; a stored lost variant drops.
- Control mutation: upgrade an edited profile. The edited-profile test must fail.
- Depends: U-V1. When no variant wins, this package only removes the variant code.

### WP-V5. CodeGraph by default (implementer-xhigh, W3; idea 2, D2)

- Files: src/server/review/codegraph.ts (an app entry for an installed `codegraph` executable, found with Bun.which; no npx); src/server/review/jobs.ts (profileServers: the default server when the profile switch is on and no user codegraph server is picked; one index per run as today); src/server/review/catalog.ts (one context line: use CodeGraph for callers and dependents of changed symbols; the tool allowlist); src/shared/dto.ts (Profile `codegraph: boolean`, default true for shipped profiles); src/server/config.ts and settings.ts (default fill); scripts/eval/run.ts (`--codegraph on|off`); integration-check.md (row: codegraph network use with DO_NOT_TRACK and CODEGRAPH_NO_UPDATE_CHECK, from the package source); BRIEF.md 3.5 (the approved text of section 6); tests/review/codegraph.test.ts, tests/review/jobs.test.ts.
- Behavior: the run indexes repo/ of the snapshot with the existing indexCodegraph (120 s cap, cache in the data folder). The run allows only tools with readOnlyHint, as the user MCP safety rule does. A failed or slow index leaves the server out, and the run log and the Brief gaps say so. A missing executable gives one gap line, and the run goes on. A user-picked codegraph server wins over the default, so one index serves the run.
- Tests: a fake `codegraph` script on a temp PATH: switch on and found, switch on and missing, switch off, a user pick and the default together (one index), index timeout, an npx command never runs.
- Control mutations: run the default when the switch is off (switch test fails); allow a tool without readOnlyHint (allowlist test fails).
- Eval measure: U-V3, `--codegraph on` against `off` on the local set and set hard. Watch recall, minutes, and cost. The index time counts in minutes.
- Depends: WP-V4; the BRIEF 3.5 approval before merge. UI parts go to WP-V9.

### WP-V6. Pre-existing group (implementer-xhigh, W3 after WP-V5; idea 8, D1)

- Files: src/server/review/catalog.ts (finder rule: report a blocker or major problem in unchanged code as pre-existing; the other rules keep "only what the change adds"); src/shared/review.ts (finding `preexisting: boolean`, default false; DisplayGroup "preexisting"; PREEXISTING_MAX); src/server/review/validate.ts (an unchanged anchor with no changed cause: keep when preexisting is true, severity is blocker or major, and the anchor quote holds; else drop "unchanged" as today); src/server/review/judge.ts (cap and order); src/server/publish/ (Post all and the post plan skip preexisting items; a single post needs a click on that item); src/server/review/stats.ts (count and post rate); docs/plans/review-v2/design.md R6 (pointer, done in this plan); tests/review/{validate.test.ts, judge.test.ts, stats.test.ts}, tests/publish/*.
- Behavior: pre-existing items go through the verify phase when it is on. At most PREEXISTING_MAX (5, decided 2026-10-28) per run, by severity then confidence. Discuss and Fix work on them as on any finding.
- Tests: a minor pre-existing finding drops "unchanged"; a major one stays in the group; a changed-cause finding stays a normal finding; Post all skips the group; the cap.
- Control mutation: let Post all take preexisting items. The post-plan test must fail.
- Eval measure: pre-existing items do not count as noise on the local set. U-V3 records the count per run. The post rate comes from stats after two weeks of use.
- Depends: WP-V5 merged (catalog.ts order).

### WP-V7. Task criteria rows (implementer, W3 after WP-V6; idea 5)

- Files: src/server/review/catalog.ts (intent module: one row per acceptance criterion of task.md or pr.md; when none exist, derive 3 to 8 and mark them derived); src/shared/review.ts (reviewResult `requirements`: criterion, source task, pr, or derived, status covered, partial, missing, or unclear, evidence path:line list; optional); src/server/review/judge.ts (quote check: a criterion with source task or pr must be an exact text of that file, else it drops); src/server/review/jobs.ts (store the rows in summary_json); fixtures/eval/hard/<new case with a missed criterion>/; tests/review/judge.test.ts, tests/review/prompt.test.ts.
- Behavior: rows are a checklist in the run summary. Only the finder's own findings with module intent become drafts. A row never becomes a draft by itself, because lens rows were noisy in the other app.
- Tests: a quoted criterion holds; a changed quote drops; a derived row needs no quote; old results without the field parse.
- Control mutation: skip the quote check. The changed-quote test must fail.
- Eval measure: the new hard case (the missed criterion is a bug); the precision of intent findings on the local set.
- Depends: WP-V6 merged.

### WP-V8. Review checks per repository (implementer-xhigh, W3 after WP-V7; idea 6)

- Files: src/server/storage/migrations/040_review_check.sql (review_check: id, project, repo NULL for global, text, origin user or discuss, created, updated, deleted); src/server/storage/db.ts; src/server/review/checks.ts and checks-routes.ts (new: list, add, edit, delete with Undo); src/server/review/context-files.ts (checksFile: context/checks.md, the user's own text, no UNTRUSTED banner, at most 20 checks); src/server/review/catalog.ts (one context line; finding field `check`); src/shared/review.ts (finding `check: number | null`; discussResult `checkProposal`, at most 1); src/server/review/validate.ts (a check ID that is not in the file clears to null); src/server/review/discuss.ts (a proposal needs a live message of the user in the talk, as design.md D12; it counts only after Keep); src/server/review/stats.ts (posted and discarded per check); tests.
- Behavior: review, re-review, and verify runs get checks.md. Fix, reply, Ask, and Explain runs do not. A repository check comes before a global one.
- Tests: db.test.ts for 040; the file cap and order; an unknown check ID clears; a proposal without a user message drops; a proposal reaches no run before Keep (stdin and file canary).
- Control mutation: write a proposed check into checks.md. The canary test must fail.
- Eval measure: stats per check. A local case with a repository check when the user has one.
- Depends: WP-V7 merged.

### WP-V9. Wave 3 UI (frontend-implementer, W3 after each server part)

- Files: src/web/review/{Brief.tsx (CodeGraph line: on, off, or not installed), Drafts.tsx (Pre-existing fold, not in Post all; check chip; requirements checklist in the run summary)}; src/web/settings/ (profile CodeGraph checkbox; Review checks per repository and global); src/web/review/Discuss.tsx (Keep for a proposed check); tests/web/*; tests/e2e/review-v3.e2e.ts (new); docs/smoke-review-v3.md (new); README.md; screenshots.
- Tests: e2e of the fold and Post all, the checklist, a check add and its chip on a scripted finding, Keep of a proposal; axe.
- Control mutation: show pre-existing items in the main group. The fold e2e must fail.
- Depends: WP-V5 to WP-V8, each part after its server package merges.

### Gate U-V3. CodeGraph and the new groups (user)

- `bun run eval -- --real --set local --repeat 2 --codegraph on` and `off`, and the same on set hard.
- Keep CodeGraph on by default only when recall rises and minutes stay within section 0. Else the shipped profile turns it off, and the switch stays.
- The user runs docs/smoke-review-v3.md on a real PR.

### WP-V10a. CodeGraph impact: server (implementer, W4; idea 11)

- Files: src/server/review/impact.ts (new: on a click, build a sanitized snapshot of the PR head, index it, start `codegraph serve --mcp`, call the read-only caller and dependent tools for the changed symbols, stop the server); src/server/review/routes.ts (POST and GET /api/prs/:id/impact); src/shared/dto.ts (ImpactDto); tests/review/impact.test.ts.
- Behavior: no Claude run. The run slot is not used. A Cancel kills the process tree. The result is cached by PR head. The workspace and the server end in every path.
- Gate inside the package: record the tool names and result shapes of the installed codegraph version in integration-check.md before code depends on them.
- Tests: a fake MCP server script; timeout; cancel; cache by head.
- Control mutation: skip the process kill on Cancel. The cancel test must fail.
- Eval measure: none. User value only.
- Depends: U-V3 (WP-V5 code).

### WP-V10b. CodeGraph impact: UI (frontend-implementer, W4 after WP-V10a)

- Files: src/web/pr/ (an Impact panel: callers and dependents per changed symbol, links into the diff and files); tests/e2e/impact.e2e.ts; README.md; screenshots.
- Control mutation: render a link for a path outside the change and outside the repository listing. The link-check test must fail.

### WP-VCI0. CI facts gate (implementer, W4; idea 10, D3)

- Blocked until section 9 Q10 to Q13 have answers and the user approves the BRIEF 3.6 change.
- Files: scripts/gate/ci-read.ts (new, read only, `--dry-run`); docs/gate-v2.md rows; integration-check.md rows.
- Checks: the CI origin from Settings only (never from a build status URL); auth with a token from the OS store; one build of a test job: status, stages, failing tests, and a log tail with a byte cap; redirects stay on the origin.

### WP-VCI1 and WP-VCI2. CI investigation: server and UI (W4b)

- Planned in detail after WP-VCI0 passes. Contract from the comparison: cause classes change, flaky, infra, target_broken, unknown; quote log lines exactly; the app checks each quote against the fetched log.
- The log is untrusted data in a context file. A run never gets the CI token. A run never calls the CI server.

### WP-V12. Blind design sketch module (implementer-xhigh, W4b, conditional; idea 12)

- Runs only when the gap rule holds: in U-V3, the user labels the missed posted findings, and at least 20% of them are design points.
- Files: src/server/review/catalog.ts (module "design", off by default); src/server/review/jobs.ts (a first read-only run on a sanitized snapshot of the merge base, which cannot see the change, writes context/sketch.md); tests.
- Behavior: the finder maps the sketch points to the change. The comment never quotes the sketch. Only a "missing" or "diverges" point with a trigger becomes a finding.
- Eval measure: design-gap cases of the local set; discard rate in stats; cost per posted finding.

## 5. Candidate for U-V1

The baseline (A) is the shipped profile. The candidate (B) adds to it. The verify mode stays as shipped.

| Mode | Candidate | Question |
|---|---|---|
| Review cases | `--variants signal,order,rules2` and `--modules <shipped>,failures` | Do the high-signal rules, the ordered process, the failure checklist, and the rule changes raise recall without noise? |
| Re-review cases | the review candidate plus `rereview-strict` | Does the strict re-review also cut noise and re-raises? |

The `rules2` variant holds five ideas. `bun run eval:ab -- --candidate-effort <level>` also runs the candidate at another effort.

1. Severity: a finding that only breaks a project rule gets severity minor, unless it causes a real bug.
2. Out-of-date docs: the rules section flags a change that makes a CLAUDE.md or project instructions statement out of date.
3. REVIEW.md: a review or re-review run reads `REVIEW.md` at the target branch root, with the CLAUDE.md caps and trust line.
4. Do-not-flag: generated files, lock files, and vendored third-party code.
5. Verify examples: the verify phase gets four generic false positives to refute.

## 6. BRIEF 3.5 wording draft (needs approval at merge)

WP-V5 adds this bullet after the user MCP bullet of BRIEF 3.5. It changes no hard rule: the server is app-run, local, read only, and indexes only the snapshot.

> A review profile has a CodeGraph switch, on by default. When the `codegraph` executable is on PATH, the app indexes repo/ of the sanitized snapshot before the run. The app never runs npx or a package download for it. The run gets an app-run codegraph MCP server on that index, with `--no-watch`, no daemon, telemetry and update checks off, and the scrubbed child environment. The run allows only its read-only tools. The index stays inside the run folder, and the data folder keeps a cached copy per repository. A failed index (120 s cap) leaves the server out, and the run goes on. The Brief shows when the executable is missing.

No BRIEF 3.6 change: the server is a local stdio process and calls no origin. WP-V5 records this fact from the package source in integration-check.md.

## 7. Not adopted

| Idea | Reason |
|---|---|
| Claude in a writable clone with a shell, for fixes or rebases | BRIEF 3.5 and 3.6: the app never runs Claude in the user's clone, and Claude never gets a shell. A raw checkout runs project hooks. |
| Tokens in SQLite | BRIEF 3.6: tokens live in the OS store only. |
| A switch that turns TLS verification off | BRIEF 3.6: never disable TLS verification. A corporate CA file covers the need. |
| Raw PR, task, or comment text in the prompt | BRIEF 3.5 and design.md R12: stdin never quotes PR or tracker text. Context files carry it as untrusted data. |
| JSON parsed out of free text with a regex | We use `structured_output` with a zod schema. A missing block cannot fail a run. |
| Lens rows as drafts by themselves | The other app's own data shows 33% to 34% discards for such rows. Our rows stay display only (WP-V7). |
| A quote check with a tolerance window | validate.ts checks the exact anchor range. A window accepts wrong anchors. |

## 8. Points where the comparison and the code differ

- The 1.8 times cost of G-EVAL-1 compares all of v2.2 with v1. The finder prompt changed too, so it does not isolate the verify phase. Run A of section 5 isolates it.
- "Verifier off" needs no code. Profile verifier.mode and eval `--verifier` exist, and finderRules already switches its text (catalog.ts checked()).
- D1 needs a prompt change, not only validate.ts. finderRules tells the finder to report only what the change adds or makes reachable (catalog.ts finderRules).
- The eval harness has no re-review mode. WP-V3 adds it before idea 9 can be measured.
- The failure checklist fits the existing module switch, so eval `--modules` compares it at no extra cost.
- The current prompt version is 2.3. The G-EVAL-1 files are 2.2, so U-V1 runs a new baseline.
- A default CodeGraph through npx would download a package. V5 forbids it.

## 9. Questions

The user decided on 2026-10-28: the user's own inline comments count as must-find items, the other questions take their recommended defaults, and pre-existing items cap at 5 per run.

| ID | Question | Answer |
|---|---|---|
| Q1 | Do the user's own inline comments (not from a finding) count as bugs in the local set? | Decided 2026-10-28: yes. They are must-find items of kind "human" and score apart as human recall. |
| Q2 | Near-line tolerance T for posted findings? | Decided 2026-10-28: 3 lines, same path and side. U-V1 also reports T = 0 and T = 10 with `eval:rescore --tolerance`. |
| Q3 | Minimum set size? | Decided 2026-10-28: 30 cases, 40 posted, 20 must-not-raise. The builder uses all runs of the copy, so a smaller set needs more reviewed PRs first. |
| Q4 | Where does the set live? | Decided 2026-10-28: a folder outside the repository, named by REVIEW_LOOP_EVAL_LOCAL. `eval-local/` stays git-ignored as a safety net. |
| Q5 | CodeGraph for other repositories of the same Jira story? | Decided 2026-10-28: later, after U-V3. Reuse the several-repository workspace code of part 6. Needs a BRIEF 3.5 check. |
| Q6 | Minimum severity for pre-existing items? | Decided 2026-10-28: major. They pass the verify phase when it is on. At most 5 per run (PREEXISTING_MAX, WP-V6). |
| Q7 | Review checks: per repository and global, at most 20 per run? | Decided 2026-10-28: yes. |
| Q8 | If run B wins, does the shipped profile turn the verifier off? | Decided 2026-10-28: yes. The switch stays in the profile. |
| Q9 | Cost exception when recall rises a lot? | Decided 2026-10-28: none. The user decides each case after U-V1. |
| Q10 | CI server type and version? | Open. It has no default. Needed before WP-VCI0. |
| Q11 | CI auth: token type, scope, and store name? | Decided 2026-10-28: a read-only token in the OS store under its own name. |
| Q12 | Which builds: the build status of the PR head, matched by commit? | Decided 2026-10-28: yes. The CI origin comes from Settings, never from the build status URL. |
| Q13 | Log size cap and retention? | Decided 2026-10-28: 2 MB tail per failed stage, kept only in the run folder. |
