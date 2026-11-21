# Review improvements ledger

Status: ledger of 2026-11-20, main at 12fd622. It lists every review improvement, its decision, and its state. Source: the audit of 2026-11-19, kept outside the repository, plus the changes after it. Each status was checked against `git log` and the code. Update this file when a review package or gate ends.

Decision values: "user decided" means that the source records a user answer. "recommended" means that a design recommends it with no recorded answer. "dropped" means that it failed or lost. "not recorded" means that no source records the decision.

## 1. Changes since the audit

- The variants "preexisting" (WP-V6) and "callers" (the D2 caller rule) are built as opt-in eval variants (81d86d4). No eval run has measured them yet.
- The seeded ground truth design exists (5537603, seeded-truth.md). The user approved the build. The user decided its section 14 on 2026-11-21. WP-SG0, WP-SG1, and WP-SG2 are built. U-SG1 (the paid seeding) is open.
- WP-JC5 and WP-JC-E are in progress on a branch. They are not on main.
- The variant "obligations" now keeps a missing obligation anchored on an unchanged line, such as a doc line, when its cause is a changed line. Before, the validator dropped it. The probe set gets doc-line alts, an exact export-guard factor, and three new obligation cases (19 cases). The prompt without the variant is unchanged.
- The verifier rule design exists (verifier-rule.md). Gate VR-0 passed narrowly on Gate A: 2.5 must-finds per repeat go to the fold as refuted. WP-VR1 builds the verify-only variant "refute-issue".
- The shipped code now has 13 opt-in variants (dto.ts `VARIANTS`). The profile editor keeps `variants` on a save and has no control for them. Only config.json sets them.
- The user replaced the S_N noise ship rule on 2026-11-21 (review-quality-2026.md section 2). Noise now passes on the paired grounded noise delta, matched by case: at most 0.08 per case for a verify-only replay, and at most 10% of mean(A) for a full run. The paired judge fp delta per case run is at most 0.05 for a replay and 0.07 for a full run. The gate docs point to this rule. eval:compare prints both deltas, their limits, and pass or fail in its "Noise rule" block. It takes the replay limits when B replayed the finder.

## 2. Version-bump trap

- WP-RC3 raises REVIEW_PROMPT_VERSION from "2.8" to "2.9" (risk-check.md section 9, row 4).
- `eval:ab` refuses a stored baseline with another prompt version (scripts/eval/ab.ts `reuseRefusal`).
- So after WP-RC3, the Gate A baseline is no longer usable. A finder variant against that baseline must run before WP-RC3. This applies to "preexisting" and "callers". The verify-only replay of "refute-issue" (Gate VR-A) must also run before WP-RC3.
- The Joint Gate A baseline is not recorded yet (docs/eval/results.md has no Gate A entry). It needs PROFILES_VERSION 9, because of the Fable advisor.

## 3. Ledger

| Item | Source | Decision | Status | Evidence | Missing |
|---|---|---|---|---|---|
| E1 to E5: eval set, flags, matcher, judge, metrics | review-quality-2026.md section 1 | recommended | Built | cc9de64, 690338e, 19ae47d | None. |
| Item 2: finder effort medium | review-quality-2026.md item 2 | user decided | Shipped default, PROFILES_VERSION 8 | 4a6dc27 | None. |
| Item 5: fold refuted findings | review-quality-2026.md item 5 | recommended | Shipped default | 2dd89d6 | None. |
| Item 9: subagent model and effort from the definition, prompt 2.8 | review-quality-2026.md item 9 | user decided (2026-11-13) | Shipped default | 15cdec3, 187916f | The workflow builder must add the same rules when it exists. |
| Fable advisor in the Review profile, PROFILES_VERSION 9 | advisor.md; review-quality-2026.md "Advisor on by default" | not recorded | Shipped default | 301e82b, 73e5595 | No eval measured it. No advisor-off eval flag. Gate U95 (subagent advisor use) is open. |
| Prompt 2.7: investigate before asking | review-questions.md | recommended | Shipped default | bfcf638, a1e42f2 | None. |
| Stale accepted drafts F1 and F2 | stale-drafts.md | recommended | Built | ff0d795 | F3 (a full review re-anchors drafts) is "not now". |
| Delegation fixes 2, 5, and 6 | delegation-gaps.md section 3 | recommended | Built | 6ebd49f, a789260 | None. |
| WP-V1 to WP-V4, WP-V13: local set, variants, re-review mode, remove losers, eval flags | review-v3.md section 4 | user decided (D1 to D3, Q1 to Q9) | Built | d76bed0, 71c36f7, 3333ad9, 9f3c65b, 074a40b | Gate U-V1 found no winner. |
| CI Layer A: build status from Bitbucket | ci-builds.md | user decided (2026-10-28) | Built | 2734de5, 58013cb | Layers B and C are on hold. |
| Item 3: variant "broad" | review-quality-2026.md item 3 | recommended | Opt-in; failed W3 | 9f3c65b, 5839cc3 | Does not ship. |
| Item 4: variant "verify2" | review-quality-2026.md item 4 | recommended | Opt-in; failed W2 | 9f3c65b | Does not ship. |
| Item 7: variant "classes" | review-quality-2026.md item 7 | recommended | Opt-in; gate blocked | review-quality-2026.md item 7 | The local set has no labels per bug kind. |
| Item 10: variants "security2" and "security2-verify" | review-quality-2026.md item 10 | recommended | Opt-in; gate failed | review-quality-2026.md item 10 | Does not ship. |
| WP-V14: variant "parts" | review-v3.md section 10 | recommended | Opt-in; wave 5 stopped | review-v3.md section 10 | The local set cannot measure recall on large PRs. |
| WP-RC1: risk check, variant "risk-check", with rule 15 (stale text) | risk-check.md section 9 | user decided (4bbd974) | Opt-in | 4eaa7e0 | Joint Gate A, WP-RC3, WP-RC4, Gate RC-B. |
| WP-RC2: risk counts in the eval | risk-check.md section 9 | user decided | Built | bef39aa | None. |
| WP-OB1: obligation check, variant "obligations", with rule 8a | obligations.md section 10 | user decided (77144ca, dd86ad3) | Opt-in | 07c4d80 | Joint Gate A, WP-OB3, WP-OB4, Gate OB-B. |
| WP-OB2: obligation counts and probe cases | obligations.md section 10 | user decided | Built, with 8 probe-obl cases | dce9f3d | The obligations.md table says 7 cases. The repository has 8. |
| WP-V6: variant "preexisting" | review-v3.md WP-V6, D1; review-quality-2026.md item 11 | user decided (D1) | Opt-in | 81d86d4 | An eval run against the Gate A baseline before WP-RC3. stats.ts count. WP-V9 UI parts. As a default, it must restore D1: never posted by default, a single post on a click. |
| Caller rule: variant "callers" | review-v3.md D2; review-quality-2026.md item 11 | user decided (D2) | Opt-in | 81d86d4 | An eval run against the Gate A baseline before WP-RC3. CodeGraph by default (WP-V5). |
| Joint Gate A | risk-check.md section 7; obligations.md section 8 | user step | Open | None | A new baseline at PROFILES_VERSION 9. |
| WP-RC3 with WP-OB3: ship both checks, one "2.9" step | risk-check.md section 9; obligations.md section 10 | user decided | Not started | None | Waits for Joint Gate A. |
| WP-RC4 with WP-OB4: UI, stats, docs | risk-check.md section 9; obligations.md section 10 | user decided | Not started | None | Waits for WP-RC3 and WP-OB3. |
| Gates RC-B and OB-B | risk-check.md section 7; obligations.md section 8 | user step | Open | None | Waits for WP-RC4 and WP-OB4. |
| WP-RC5: finder half, variant "risks" | risk-check.md section 9 | recommended (optional) | Not started | None | Needs Gate RC-C data. |
| WP-JC-D, WP-JC0, Gate JC-G | jira-context.md section 8 | user decided (4311cdb) | Done | 4311cdb, 8e53029, 104368c | None. |
| WP-JC1: Jira client reads more fields | jira-context.md section 8 | user decided | Built | cd0ab6c | The new fields reach no prompt until WP-JC5. |
| WP-JC2 to WP-JC4: fetch state, run wiring, chips | jira-context.md section 8 | user decided | Built | 71dbfbc, a77e30a, 5e78593 | None. |
| WP-JC5: task.md sections | jira-context.md section 8 | user decided | In progress on a branch, not on main | None on main | No push before Gates JC-A and JC-B. |
| WP-JC-E: eval overlay | jira-context.md section 8 | user decided | In progress on a branch, not on main | None on main | jira-context.md says it starts after WP-RC3. Its Gate JC-A text names prompt 2.8. The Jira context package owns both points. |
| Gates JC-A and JC-B | jira-context.md section 5 | user step | Open | None | Waits for WP-JC5 and WP-JC-E. |
| WP-JC6: Jira family on by default | jira-context.md section 8 | user decided | Not started | None | Waits for Gate JC-A and WP-RC3. |
| WP-V5: CodeGraph by default | review-v3.md WP-V5, D2 | user decided (D2) | Not built | None | Needs the BRIEF 3.5 approval. |
| WP-V7: task criteria rows | review-v3.md WP-V7 | recommended | Not built | None | It overlaps the obligation kind "criterion". Keep or drop is open. |
| WP-V8: review checks per repository | review-v3.md WP-V8 | recommended | Not built | None | None. |
| WP-V9, WP-V10a, WP-V10b: wave 3 UI, CodeGraph impact | review-v3.md section 4 | recommended | Blocked | None | Waits for WP-V5 and WP-V6 as defaults. |
| WP-VCI0 to WP-VCI2: CI investigation | review-v3.md section 4, D3 | user decided (D3) | Deferred | None | Moved toward PS7a and PS7b. |
| WP-V12: blind design sketch | review-v3.md WP-V12 | dropped | Superseded by obligations | obligations.md section 1 | None. |
| Item 1: one agent on large PRs | review-quality-2026.md item 1 | dropped | Failed (C1a) | review-quality-2026.md item 1 | None. |
| Item 8: variant "quotes" | review-quality-2026.md item 8 | dropped | 0% effect | review-quality-2026.md item 8 | None. |
| Question source fixes | the audit of 2026-11-19 | dropped for now | Not started | None | 97% of question items came from runs before prompt 2.7. Count again later. |
| Item 6b: verifier model | review-quality-2026.md item 6b | recommended | Not started | None | No eval flag. The profile has verifier.model. |
| Delegation fixes 1, 3, and 4: variant "handoff" | delegation-gaps.md section 3 | recommended | Not started | None | None. |
| Count of delegated runs that read task.md | delegation-gaps.md section 4 | recommended | Not started | None | Needs the user's OK. |
| git history rule and a git_blame gate | the audit of 2026-11-19 | recommended | Not started | None | None. |
| Verifier rule replay | review-quality-2026.md item 4 | recommended | Not started | None | None. |
| Verifier rule: refute the problem, not a detail, variant "refute-issue" (WP-VR-D, WP-VR1, WP-VR2) | verifier-rule.md | recommended | Opt-in; failed Gate VR-A (2026-11-21) | verifier-rule.md section 6; commit cd996f0 | Gate VR-A replay against the Gate A control replay, before WP-RC3. WP-VR2 shares the "2.9" step. |
| Probe thread as a counted must-find | review-ideas.md idea 2 | recommended | Not started | None | The eval runner needs seeded thread comments. |
| Focused passes: variant lenses3 (WP-L0 to WP-L3) | focused-passes.md | recommended | Designed, not built | None | Needs the seeded set and the noise-delta print. |
| Control: variant runs3 (focused-passes.md section 4.7) | focused-passes.md | recommended | Designed, not built | None | Runs with lenses3 as its control. |
| Variant "architecture" and seed kind "architecture" | architecture-bugs.md; review-quality-2026.md item 12 | user decided (requirement of 2026-11-21) | Opt-in | bb1afd0 | Ships inside "lenses3" L2 (decided 2026-11-21), or with "callers" (open question 4). |
| Seeded ground truth: WP-SG0 to WP-SG2, U-SG1, gates SG-P and SG-A | seeded-truth.md | user decided (build approved) | WP-SG0 to WP-SG2 built; U-SG1, SG-P, and SG-A open | 5537603, 8675012, None (WP-SG2) | U-SG1. The per-kind floor warns only (seeded-truth.md section 14 row 13). architecture-bugs.md adds the ninth kind. |
| Head-to-head with another review app | outside the repository | user decided ("not now") | Deferred | None | None. |
| Stacked PR context: variant "stack", WP-SK0 to WP-SK4, gates G20, SK-P, and SK-B | stacked-prs.md | user decided (app route, build after the code review gate) | Designed, not started | None | Builds after Joint Gate A and the "preexisting" and "callers" runs. The 12 questions of section 12. |
| Minor fold: variant "minor-fold", WP-MF1 and WP-MF2 | minor-fold.md | defaults by the orchestrator (section 10), the user may change them | Opt-in | e56c6ce | Gate MF-A against the Gate A baseline before WP-RC3. Then WP-MF3 and the BRIEF.md change. |
| Postable risks: link a confirmed risk to its draft (WP-PR0) | postable-risks.md | recommended | Designed, not started | None | Low priority: the risk check did not pass Gate A. Answer Q2 before any RC-A rerun. |

## 4. Order and dependencies

1. Run "preexisting" and "callers" against the Gate A baseline, and the "refute-issue" replay (Gate VR-A) against the Gate A control replay. Do this before WP-RC3 (section 2).
2. Joint Gate A, then WP-RC3 with WP-OB3, then WP-RC4 with WP-OB4, then Gates RC-B and OB-B.
3. WP-RC3, then WP-JC-E, then Gate JC-A, then WP-JC6. WP-JC-E is in progress before WP-RC3 against this order. The Jira context package must settle it.
4. WP-JC5 builds now. It pushes only after Gates JC-A and JC-B.
5. The seeded set comes before the gates of "runs3" and "lenses3". A win needs about 5 to 6 more bugs of 70 on the natural set.
6. Decide WP-V7 against the obligation kind "criterion".
7. "preexisting" with rule 15 and the obligation doc kind: both stay out of the pre-existing group (review-v3.md WP-V6). This point is closed.

## 5. Unplanned ideas, ranked

| Rank | Idea | Source | Note |
|---|---|---|---|
| 1 | Seeded ground truth | seeded-truth.md | Designed since the audit (5537603). Build approved. Decisions made on 2026-11-21. WP-SG0 to WP-SG2 are built. |
| 2 | "lenses3" against "runs3" | seeded-truth.md section 4; review-quality-2026.md item 6 | Needs the seeded set. |
| 3 | Recall budget by PR size | research/review-practice-2026-11.md T4 | More agents only on large PRs. |
| 4 | Caller rule and CodeGraph by default | review-v3.md D2; research T6 | The caller rule is built as the variant "callers" (81d86d4). WP-V5 is not built. |
| 5 | Map step with blame and earlier fixes | the comparison of 2026-11-17, outside the repository | About +30% to +50% cost by estimate. |
| 6 | Repository facts profile | the comparison of 2026-11-17 | None. |
| 7 | Senior reviewer framing line | the comparison of 2026-11-17 | None. |
| 8 | One "what else?" turn | research T7 | Cost: one more turn. |
| 9 | Advisor-off eval flag and one run before WP-RC3 | the auditor's own suggestion | The advisor default was never measured. |
| 10 | Thread probe as a counted bug, and a seeded older-code contract probe | the auditor's own suggestion | About $3 by estimate. |
