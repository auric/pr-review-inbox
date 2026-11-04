# Subagents in task steps

Status: user decisions of 2026-11-04 against main b88d1af. Not designed in detail. Not built.

## Facts

- No task step gets the Agent tool. Interview and spec runs get `--tools Read,Grep,Glob` and `rl-main` without `Agent(...)` (claude.ts:373-442). Implement, tests, fix, Tell Claude, and resolve steps get `--tools Read,Grep,Glob,Edit,Write`, plus Bash for a shell step, and no `--agents` (claude.ts:486-519).
- The spec decides this: AC-B8 (spec.md:1504), spec.md:1949, design.md:358, and BRIEF.md:491 (the plan check has no subagent).
- Gate B17 (integration-check.md U72) proved that `--restricted` keeps Edit and Write inside the cwd only with these tools. No gate covers a subagent with Edit, Write, or Bash.
- Gate 0: `--allowedTools` alone does not stop the Agent tool (integration-check.md:23). Gate B4: subagents write `subagents/agent-*` files even with `--no-session-persistence` (integration-check.md:73).
- `implementArgs` has no `Agent` or `Task` in its allowlist (claude.ts:518). The init check kills a step whose init event lists a tool outside it (stream.ts:222, claude.ts:610-613). Reviews add both names (claude.ts:440).
- The stream parser already nests subagent events by `parent_tool_use_id` (stream.ts:123, 179-198).
- A user skill that tells Claude to start subagents does nothing in a task step today, and no error shows.

## User decisions (2026-11-04)

1. Every Claude step of a task (interview, spec, implement, tests, fix, Tell Claude) can start an app-defined read-only subagent `rl-explorer`. It has Read, Grep, and Glob only. It disallows Bash, PowerShell, Write, Edit, NotebookEdit, and Agent. It uses the subagent model of the reviews. The plan check keeps no subagent, so its review stays independent.
2. Subagents that can edit files or run commands need a new real-CLI gate first. The gate checks that Edit and Write stay inside the worktree, that the shell allowlist applies to subagent commands, that Stop kills the subagents, and that subagent files land only in the run folder. The user decides after the gate.
3. Order: after the setup package, before the limits.

## Packages

- WP-SA1 (implementer-xhigh): point 1. A Plan step first decides how an implement step restricts Agent to `rl-explorer` (a main agent definition with `Agent(rl-explorer)`, or another way), and the spec and AC changes. Tests with the fake claude. A step log shows subagent calls nested under their parent.
- Gate B30 (user, real CLI): point 2.
