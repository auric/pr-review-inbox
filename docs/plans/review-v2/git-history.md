# Git history rule and the git_blame gate

Status: design of 2026-11-26 against main ca795d1. Built opt-in (WP-GH1, c63912b). Pilot P-GH failed on 2026-11-26, so no full run follows. GH-0 part b passed. Ledger row: "git history rule and a git_blame gate" (review-ledger.md:82). Main session decisions of 2026-11-26: Q1 own variant; Q3 no WP-GH2 (a one-off count of the `.calls/` records answers GH-0 part b).

## 1. Source and verdict

- The audit of 2026-11-19 is outside the repository (review-ledger.md:3). Its archive copy only names the item. The item comes from a git check of 2026-11-18, also outside the repository.
- That check found three facts. rl-git reads the full history of the cache. No prompt says when to use git_log or git_blame: to learn why code exists, or whether a problem is pre-existing or new. rl-reviewer hears only about git_diff.
- It asked for a history rule, two tool fixes, and one gate that proves a real run calls git_blame. The tool fixes are done: git_log --follow and git_blame -M -C (6ebd49f, delegation-gaps.md fix 6).
- It put the rule into the variant "handoff". This design gives the rule its own variant (Q1).
- It asked for no new tool. This design adds none (section 3.1).

## 2. Facts: a free count of 2026-11-26

The stored eval call records (`*.calls/*.json`) keep the run events. A count over all of them:

| Phase | Records | git_blame | git_log | git_show | git_diff |
|---|---|---|---|---|---|
| find | 1,585 | 1 (1 call, 2026-11-14) | 161 | 70 | 1,585 |
| verify | 1,350 | 8 (9 calls) | 101 | 44 | 1,000 |

- All 10 git_blame calls ended ok. The 9 verify calls ran after 6ebd49f. The lead made 4 of them, and subagents made 5.
- The tool works in real runs, from a lead and from a subagent. The finder almost never calls it.

## 3. Design

### 3.1 No new tool

- git_blame gives the commit of each line in a range at any pinned commit. git_log gives the subject of one commit. git_show gives a whole commit (git-mcp.ts:178-284).
- Every run gets all four tools (git-mcp.ts:15, 49). A new tool or a changed schema reaches every default run, so the default would change.
- Only `git log -L` is missing. git_blame at BASE, then git_log of the named commit, gives the last change of each line.

### 3.2 Variant "git-history"

- Name: "git-history". "The history rule" already means the history.md rule (BRIEF.md:487, catalog.ts:596-602), and tests/review/history.test.ts exists.
- Add the name to VARIANTS between "codegraph" and "handoff" (dto.ts:222-242 at c63912b). The profile editor shows no control for it (profiles.ts:77). It is an eval switch.
- catalog.ts: add `gitHistory = (p) => has(p, "git-history")` and `HISTORY_LINES`. focus() (catalog.ts:834-836; 849-857 after WP-GH1) adds the lines after ARCHITECTURE_LINES and before the lens lines. rl-main (catalog.ts:1160 after WP-GH1), rl-reviewer (catalog.ts:1651 after WP-GH1), and each lenses3 pass get them.
- No lines for verify, salvage, Explain, ask, reply, or fix.
- The prompt version becomes "2.9+git-history" through promptVersion (catalog.ts:246). REVIEW_PROMPT_VERSION stays the same.

### 3.3 Rule text (HISTORY_LINES)

    The rl-git tools git_log, git_blame, and git_show show when the code changed and why.
    Call git_log with since BASE once. Compare the commit subjects of the change with what its code does.
    When the change removes or rewrites lines that exist at BASE, call git_blame with rev BASE on those lines.
    Use the path at BASE. The git_diff hunk headers give the start line and the line count at BASE.
    For each commit that git_blame names, read its subject with git_log, with rev set to that commit and max_count 1.
    Call git_show on that commit only when its subject names a fix, a revert, or a reason for those lines.
    When the change brings back a problem that the earlier commit fixed, report it.
    In evidence, also give the hash and the subject of that commit.
    Before you set preexisting to true, read the file at BASE with git_show, with rev BASE and the path.

- Line 1 names the tools for rl-reviewer, which hears only about git_diff (catalog.ts:605, 1596). rl-main gets them in stdin (prompt.ts:108).
- With "handoff", rl-reviewer also gets gitToolLines (catalog.ts:1629 at c63912b, prompt.ts:108). Line 1 stays: gitToolLines names the tools and the aliases, and line 1 says what they show. rl-main already gets both texts by default, so rl-reviewer then reads the same pair as rl-main.
- Line 2: commit text gives intent (research/review-practice-2026-11.md T5). git_log prints subjects only (git-mcp.ts:204), so the call is cheap.
- Lines 3 to 6 learn why the code exists. The cheap call comes first: git_show prints the full patch, up to 60 KB per page (git-mcp.ts:91, 267).
- Line 9 serves the pre-existing rule "the problem exists at BASE" (catalog.ts:638).
- Commit text is author text. TRUST covers every MCP tool result (catalog.ts:466). rl-reviewer gets TRUST through contextBlock (catalog.ts:610, 1599).
- In a re-review, BASE is the range base. git_diff starts at BASE by default (git-mcp.ts:294), so lines 3 and 4 hold. resolve accepts the BASE history (git-mcp.ts:169-170).

## 4. The git_blame gate (GH-0)

- The gate proves a real run, as Gate B7 did (integration-check.md:76-77). It measures no quality. The test preload blocks the real CLI, so the user runs it.
- Part a: the tool works in a real run from a lead and a subagent. The records of section 2 meet it. Record that in integration-check.md. Cost: none.
- Part b: the finder calls git_blame under the variant. This is the first check of pilot P-GH. Pass: at least one find record has an ok git_blame call. Report the share of case runs with a call, by lead and by subagent.
- Read part b from the `.calls/` records of the pilot with a one-off count: the events with tool `mcp__rl-git__git_blame`, status ok, and kind find.
- Result of 2026-11-26 (pilot P-GH, code d3cda25): part b PASS. The find phase made 4 ok git_blame calls (lead 2, subagent 2) in 3 of 10 case runs. The 20 baseline runs of the same cases made 0.
- Other ok find calls, pilot against baseline: git_log 16 against 2, git_show 2 against 0.

## 5. Eval and ship

- No gold kind covers "the change brings back a bug that an earlier commit fixed". Do not expect a recall gain. The seeded set cannot test it, because a seed folds into the author's commit (seeded-truth.md:38).
- P-GH (user approves, paid): run the fixed 10-case natural subset of the lenses3 run, repeat 1, against the same cases of baseline r6 (results.md:232-250). Estimate: about $16 to $21, plus about $2 for labels.
- P-GH goes on to the full run only when three things hold: GH-0 part b passes, the noise rule passes (review-quality-2026.md section 2), and grounded recall is not below the subset baseline. Report the cost factor and the minutes factor.
- Full run (user approves, paid, only after P-GH): the natural set, repeat 2, against baseline r6. The ship rule is "Better" (review-quality-2026.md:144). Estimate: about $215 to $270, plus about $5 for labels.
- --candidate-replay refuses the variant, because the variant changes the finder prompt version (run.ts:320, 327-347).
- Cost risk: a large refactor removes many lines, and the finder blames each range. If P-GH costs too much, narrow line 3 to the lines that a finding is about.
- P-GH result (2026-11-26, code d3cda25, prompt 2.9+git-history, effort medium): all 10 runs completed. A Claude usage limit cut the run after 2 runs, and --resume finished it.
- Cost $24.20 total, $2.42 per case run against $1.59 (1.52x). Minutes 4.7 against 4.2 (1.12x).
- Grounded recall fell from 35.7% (10/28) to 25.0% (7/28). The paired delta is −10.7 points, 90% interval −28.1 to +6.7 (not significant).
- The noise rule passes: grounded noise per case 1.25 to 1.00, judge fp per case run 0.30 to 0.30. Severity ok stays 100%.
- 4 of 25 findings cite an earlier commit: 3 confirmed, 1 refuted.
- Verdict: FAIL, because grounded recall is below the subset baseline. No full run. The variant stays opt-in.
- Guess, not measured: the history reads take turns from the bug search.

## 6. Work package

WP-GH1 (implementer), after the "handoff" and "evaltools" branches merge: src/shared/dto.ts (VARIANTS and its comment), src/server/review/catalog.ts (gitHistory, HISTORY_LINES, focus and its comment), tests/review/git-history.test.ts (new), tests/review/prompt.test.ts (VARIANTS pin), tests/review/git-mcp.test.ts (one chain test), docs/eval/local.md (variant bullet), review-ledger.md (row 82), integration-check.md (GH-0 part a). No UI change, so no screenshots.

Tests (pure, no runner, following tests/review/architecture.test.ts):

- AC-GH1: without the variant, no agent prompt holds a line of HISTORY_LINES. The hash tests of prompt.test.ts stay green.
- AC-GH2: with the variant, rl-main and rl-reviewer (with and without parts) hold the block once, in one piece. Each prompt without the block equals the default. With "callers" and "architecture", the block follows ARCHITECTURE_LINES. Under lenses3, each pass holds the block before its lens lines.
- AC-GH3: the Explain rl-main, the verify agents, the verifier, and salvage do not change.
- AC-GH4: promptVersion gives "2.9+git-history". profileInput keeps the name.
- AC-GH5 (git-mcp.test.ts): git_blame with rev BASE on a line that the change rewrites names the older commit. git_log with that full hash and max_count 1 gives its subject.

## 7. Invariants

- rl-git stays read-only. Its tools carry readOnlyHint (git-mcp.ts:175) and --no-optional-locks (git-mcp.ts:27). It reads only the cache git dir (git-mcp.ts:138). It takes only pinned aliases and their history (git-mcp.ts:159-172). It accepts no '..' and no absolute paths (git-mcp.ts:74-88). It pages each output (git-mcp.ts:91-133).
- Without the variant, focus() returns the same lines (catalog.ts:617, 834-836).
- findRun gets mainAgent and reviewerAgent from the profile (jobs.ts:1467), so the variant reaches real runs.
- A version of the app that does not know the variant drops the name on read (dto.ts:310-313).

## 8. Open questions

- Q2: Does the verify phase need a line for a candidate that cites an earlier commit? Not in v1 (unverified).
- Q4: Line 6 lets the finder judge a subject. The pilot shows whether git_show calls grow too much (unverified).
