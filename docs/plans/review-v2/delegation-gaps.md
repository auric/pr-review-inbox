# Delegation gaps: what an rl-reviewer subagent knows

Status: analysis of 2026-11-18, main at acb0b77. Not started. Each fix ships first as a variant, so REVIEW_PROMPT_VERSION stays "2.8" until a variant wins.

## 1. Verdict

- The handoff does not lose the task or project context. The app writes it into the rl-reviewer agent definition, not into the free-text brief of rl-main (design.md R14).
- The subagent gets the profile prompt, contextBlock (read ./context/pr.md and ./context/task.md first, pr-context.md, history.md, questions.md, BASE and HEAD), the do-not-flag list, the rubric, the modules (rules and intent included), the language checks, the skills, the MCP lines, and the project instructions.
- Four smaller gaps are real. Gap 1 fits the "file read, problem not named" misses: a subagent cannot pass on a suspicion.
- Whether subagents really read task.md in practice is unverified. A count over past delegated runs can show it (section 4).

## 2. Lead and subagent

| Item | rl-main | rl-reviewer | Evidence |
|---|---|---|---|
| Profile prompt, contextBlock, pr-context rules | yes | yes, same input | catalog.ts:486-537, 891-893, 1292-1294 |
| Do-not-flag list, rubric, threadClaim | yes | identical | catalog.ts:895-897, 1296-1298 |
| Modules (security, concurrency, api, rules, intent) | yes | same moduleSections | catalog.ts:779-784, 898, 1299 |
| Language checks, skills, MCP and issue-tool lines | yes | yes | jobs.ts:1055, 1071-1074 |
| Project instructions | in stdin | appended to the agent prompt | jobs.ts:1070; claude.ts:574 |
| finderRules | main: trigger search, else a question | no trigger search, no question rules | catalog.ts:559-579 |
| Result format | findings, risks, questions | findings only, as free text | catalog.ts:1301-1302 |
| stdin "# Tools" (context file list, git_blame, git_log, git_show, TARGET, stat_only) | yes | no | prompt.ts:66-103 |
| stdin "# Your instructions" (the user's note for the run) | yes | no, unless rl-main copies it | prompt.ts:107-109 |
| stdin "# Metadata" (PR id, task keys) | yes | no; ISSUE_LINES still names it | prompt.ts:111-117; catalog.ts:1258 |
| Advisor | --advisor fable | unverified (U95 saw 0 advisor calls under agents) | advisor.md:11; integration-check.md:480 |

The brief is free text. The app requires only the paths and the git_diff range (DELEGATE, catalog.ts:793-804).

## 3. Gaps and fixes, ranked

1. A subagent cannot pass on a suspicion. finderRules(p, false) drops the trigger search and the question rules. The do-not-flag list keeps "a risk with no trigger". DELEGATE copies findings only. Fix (variant "handoff"): give rl-reviewer the trigger-search line and "Report a point without a trigger as a question, with what you checked". Add a risks line. Add to DELEGATE: "Copy the questions and risks of each call into questions and risks." The verify phase checks questions now, and checks risks after WP-RC1, so precision stays guarded. This also feeds the risk check with the suspicions of large PRs.
2. The user's note never reaches the subagent. On a large PR, rl-main delegates most files, so "focus on X" is mostly lost. Fix: append the note to the rl-reviewer prompt under "# Your instructions", with the same trust wording, as withInstructions appends the project instructions. No tokens when the note is empty.
3. No one checks a criterion across parts. Each subagent applies the intent module to its own files. Under the variant parts, rl-main does not review files itself (catalog.ts:809). Fix: one rl-main line under delegation: "Check each acceptance criterion against the merged findings of all calls." Optional subagent line: "Report an unmet criterion only for files in your request."
4. Tool and metadata lines are missing. The subagent is not told about git_blame, git_log, git_show, TARGET, or stat_only. TRUST and ISSUE_LINES point at sections that it does not have. In a re-review it is not told about findings.md. Fix: move the rl-git line of prompt.ts:101-102 into contextBlock. Pass the task keys into the reviewer prompt, or make ISSUE_LINES name pr-context.md and task.md only.
5. No parity test. Add a delegate.test.ts assertion that the rl-reviewer prompt holds contextBlock(c), moduleSections (intent and rules), and the rubric, as rl-main does. No prompt change.

## 4. Measure

- Fix 5 first. It needs no eval.
- Fix 2 is app data, not prompt text. It needs no eval gate.
- Fixes 1, 3, and 4 ship as the variant "handoff". Measure with eval:ab on the large cases only (delegation on), against the new baseline of Joint Gate A. Metrics: recall, questions per PR, confirmed share in the verify phase, and cost.
- A cheap check first, with the user's approval: over past delegated runs, count the Agent calls whose child events Read context/task.md and context/pr.md. parts.ts unreadParts (84-90) has the same parent-event logic.
- Gate U95 left open whether subagents use the advisor. A gate run can settle it.
