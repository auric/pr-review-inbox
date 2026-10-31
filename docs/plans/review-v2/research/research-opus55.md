# Research: prompting Opus 5.5 for PR review (scout, 2026-10-22)

1. Opus 5.5 has its own prompting page; builds on Opus 5. Differences: effort calibration, prompts written for thinking disabled, user-facing progress updates, safeguard refusals. https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices (only the index row was read).
2. Set effort explicitly: "Effort is the only thinking control on Claude Opus 5.5, and its default is `medium` where Claude Opus 5's is `high`." Thinking cannot be disabled; at xhigh/max set large max_tokens (64k). https://platform.claude.com/docs/en/models/opus-5-5/migration-guide -> pass --effort every run, per profile.
3. Literal instruction following lowers recall: "If your review prompt says 'only report high-severity issues' or 'be conservative,' the model may follow that instruction literally and report less; ask it to report everything and filter in a separate pass instead." "its additional findings are mostly real issues rather than false positives. Accuracy holds at lower effort settings." https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 -> finder reports all with severity + confidence; threshold in app or judge pass. (Stated for Opus 5; unverified for 5.5.)
4. Drop CRITICAL/MUST emphasis; "If in doubt, use [tool]" over-triggers. (Text from 4.5/4.6 era, still on the general page.)
5. Say what to do, not what to avoid; prompt style shapes output style.
6. Prefill is out; use direct instructions, XML tags, structured outputs.
7. Ground in quotes: "ask Claude to quote relevant parts of the documents first". -> each finding quotes the exact changed line; the app checks the quote against the diff (catches wrong line numbers).
8. Documents first, question last; examples; XML sections; state the why (long-standing, quotes not captured).
9. "Claude Opus 5 also delegates to subagents more readily than prior models; see Controlling subagent spawning" -> fixed agent set, say when not to delegate.
10. Read-only default sample prompt fits review.
11. Headless: --output-format json + --json-schema -> structured_output; missing field = failed run; schema `format` is annotation only, not enforced. https://code.claude.com/docs/en/headless
12. Subagent fields (garbled extract): name, description, tools, disallowedTools, model (claude-opus-5-5, inherit), effort, permissionMode (plan), maxTurns, skills, omitClaudeMd, isolation: worktree, initialPrompt. https://code.claude.com/docs/en/sub-agents -> pin effort/model per agent, omitClaudeMd, tools read-only, maxTurns.
13. Anthropic /code-review plugin (https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/code-review/commands/code-review.md): 2 Sonnet agents for CLAUDE.md compliance (only CLAUDE.md files sharing the path); Opus bug agent "Focus only on the diff itself… Do not flag issues that you cannot validate without looking at context outside of the git diff"; Opus security/logic agent "Only look for issues that fall within the changed code"; all get PR title+description; step 5 "For each issue found… launch parallel subagents to validate the issue… with high confidence"; flags only compile errors, logic wrong for every input, CLAUDE.md violations "where you can quote the exact rule"; "If you are not certain an issue is real, do not flag it. False positives erode trust." Uses CRITICAL emphasis (older style). Take: parallel finders + per-finding validators; strictness lives in the validator, not the finder. No numeric threshold seen in this version (earlier ~80 reported, unverified).
14. False positives/nits: separate finding from judging; written severity rubric; validator must confirm in code.
15. Made-up line numbers: quoted snippet; app maps snippet to hunk, drops or re-anchors.
16. Outside the diff: stay in changed code; app rejects or labels context anchors.
17. Rule violations: exact rule quote + path scope check.
18. Sycophancy in replies: check the author's claim against code before agreeing; calibrated confidence (unverified for 5.5).
Not read: the Opus 5.5 page itself, claude-code-action prompt, Skills/CLAUDE.md docs, system cards.
