# Delegation gaps: what an rl-reviewer subagent knows

Status: analysis of 2026-11-18, main at acb0b77. Fixes 2, 5, and 6 are done (6ebd49f, a789260). Fixes 1, 3, and 4 are built as the opt-in variant "handoff" (section 3.1). It is not measured. Each fix ships first as a variant, so REVIEW_PROMPT_VERSION stays "2.8" until a variant wins.

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
2. The user's note never reaches the subagent. On a large PR, rl-main delegates most files, so "focus on X" is mostly lost. Fix: append the note to the rl-reviewer prompt under "# Your instructions", with the same trust wording, as withInstructions appends the project instructions. No tokens when the note is empty. Done: prompt.ts noteSection, appended in jobs.ts for review runs. Task runs have no note.
3. No one checks a criterion across parts. Each subagent applies the intent module to its own files. Under the variant parts, rl-main does not review files itself (catalog.ts:809). Fix: one rl-main line under delegation: "Check each acceptance criterion against the merged findings of all calls." Optional subagent line: "Report an unmet criterion only for files in your request."
4. Tool and metadata lines are missing. The subagent is not told about git_blame, git_log, git_show, TARGET, or stat_only. TRUST and ISSUE_LINES point at sections that it does not have. In a re-review it is not told about findings.md. Fix: move the rl-git line of prompt.ts:101-102 into contextBlock. Pass the task keys into the reviewer prompt, or make ISSUE_LINES name pr-context.md and task.md only.
5. No parity test. Add a delegate.test.ts assertion that the rl-reviewer prompt holds contextBlock(c), moduleSections (intent and rules), and the rubric, as rl-main does. No prompt change. Done: the "rl-reviewer prompt parity" tests in delegate.test.ts also check the do-not-flag list.
6. The rl-git history tools lose moves. git_log with a path stopped at a rename, and git_blame named the moving commit for a moved line. Done: git_log adds --follow when it has a path. git_blame adds -M and one -C. One -C searches only the files of the same commit; -C -C and -C -C -C search more and cost more, so the tool does not use them. Tool names, descriptions, and schemas stay the same, so the prompt bytes stay the same. Later fix, revisions: the tools also accept a commit in the history of BASE. A re-review BASE can be an app-made merge commit or an earlier head before a force push. The tools also accept ~N and ^N after a hash, HEAD, BASE, or TARGET. The rev description now calls BASE the base of the reviewed range. The prompt text does not change, so REVIEW_PROMPT_VERSION stays.

### 3.1 Build notes of the variant "handoff"

- Only a delegating run changes. Without the variant, every prompt and agent keeps its bytes. tests/review/handoff.test.ts and delegate.test.ts pin them with hashes taken before the variant. delegate.test.ts also checks that the variant run has the same CLI flags and stdin as the default run.
- Fix 1: rl-reviewer gets the trigger search line of rl-main. At its end, it gets "Report a point without a trigger as a question, with what you checked." and "Also report risks: each risk that you noted and did not check, in one line." rl-main gets "Copy the questions and risks of each call into questions and risks." after the delegation lines of modes auto, always, and parts.
- Fix 3: rl-main gets "Check each acceptance criterion against the merged findings of all calls." after that line. It shows also when the run has no task and no description.
- Fix 4: rl-reviewer gets the two rl-git lines of the stdin Tools section after its context block. The stdin keeps them, so the lines are added, not moved. catalog.ts gitToolLines holds the text once. In a review run, the rl-reviewer issue lines name ./context/pr-context.md and ./context/task.md instead of the Metadata section. A task run has no pr-context.md, so its rl-reviewer keeps the default issue lines.
- Open, for the user: rl-reviewer does not get FINDER_QUESTION_RULES (look for the answer first, ask only when no file answers). The fix text names only the trigger search and the question line.
- Open, for the user: the optional rl-reviewer line of fix 3 ("Report an unmet criterion only for files in your request.") is not built.
- Open, for the user: rl-reviewer is not told about ./context/findings.md in a re-review. The fix text names no line for it, and the re-review rules of rl-main stay in stdin.
- Open, for the user: TRUST still names the "Project instructions" and "Your instructions" sections of the user message. rl-reviewer gets both sections at the end of its agent prompt (fix 2). The fix text names no TRUST change.
- Open, for the user: rl-reviewer keeps the do-not-flag item "a risk with no trigger" next to the new risks line. Gap 1 names the item, but the fix text does not change it.
- The variant also reaches the delegation of a task run (Build a Jira task), because it is a profile switch.
- No finder rule defines a risk (risk-check.md section 4.1). The risks line uses the wording of the risk blocks: a risk that the finder noted and did not check.

## 4. Measure

- Fix 5 first. It needs no eval.
- Fix 2 is app data, not prompt text. It needs no eval gate.
- Fixes 1, 3, and 4 ship as the variant "handoff". Measure with eval:ab on the large cases only (delegation on), against the new baseline of Joint Gate A. Metrics: recall, questions per PR, confirmed share in the verify phase, and cost.
- A cheap check first, with the user's approval: over past delegated runs, count the Agent calls whose child events Read context/task.md and context/pr.md. parts.ts unreadParts (84-90) has the same parent-event logic.
- Gate U95 left open whether subagents use the advisor. A gate run can settle it.
