# Subagents in task steps

Status: user decisions of 2026-11-04 against main b88d1af. Point 1 is designed and built in WP-SA1 (2026-11-10). Gate B35 is open. Point 2 is not started.

## Design (WP-SA1, 2026-11-10)

- One definition, `rl-explorer`: `tools` Read, Grep, and Glob, `disallowedTools` Bash, PowerShell, Write, Edit, NotebookEdit, and Agent, and `omitClaudeMd`. It gets no MCP tool and no skill. Its model is `reviewer.model` of the task profile. Null gives no model field. The definition is the same in each step kind and each shell mode.
- The restriction is the `Agent(<name>)` entry in the tools of a main-thread agent. Source: code.claude.com/docs/en/sub-agents, "Restrict which subagents can be spawned". Gates B2 and B9 proved it: `--agent rl-main` with `Agent(rl-reviewer)` refused `general-purpose` and a user agent.
- Other ways fail. Gate 0 f and B9: an allow rule does not limit the Agent tool. A deny list of agent names cannot cover user agents or new built-in agents.
- Interview and spec runs already run as `rl-main` (claude.ts `prepare`). Their rl-main tools add `Agent(rl-explorer)`, and `--tools` adds Agent. This is the review setup of Gate B9.
- Implement, tests, fix, instruct, and resolve runs (claude.ts `implementArgs`) add `--agents <run folder>/app/agents.json --agent rl-main`. This rl-main has an empty prompt. The docs say that an empty prompt with no memory field keeps the default system prompt (CLI 2.1.281 and later).
- The tools of that rl-main are `Agent(rl-explorer)`, the step tools, the picked MCP tools by full name, and StructuredOutput (Gate B9). A shell step adds Bash. `--tools` adds Agent. `--restricted`, `--allowedTools`, `--disallowedTools`, and `--settings` do not change. Agent needs no allow rule (Gate B9).
- The init check accepts Agent and Task (Gate B8) only in a run with rl-explorer. A run without it still stops when init lists either name.
- The explorer is opt-in. `TaskRunStart.explorer` and `ImplementSpec.explorer` are optional. Only the interview, the spec run, and every implement-kind run set them. The plan check (spec.md section 6.22.5, not built) sets none, so it gets no Agent tool.
- The agents file is in the run folder `<dataDir>/runs/<run>/app`, outside the cwd, and the run end deletes it. Gate B4: subagent meta and output files go to the per-cwd folders, and the run end deletes them (removeCwdFolders).
- The run log needs no UI change. The stream parser nests by `parent_tool_use_id`, and the task view uses the same RunLog tree. The parser marks rl-explorer as an app agent, not as a built-in agent.
- Open: Gate B35 (integration-check.md U82). No gate ran a write run as `--agent rl-main`. Until B35 passes, the implement-kind setup relies on the docs and on Gates B2, B9, B17, and the shell gates.

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
- Gate B35 (user, real CLI): the open facts of the WP-SA1 design (integration-check.md U82).
- The point 2 gate (user, real CLI). The name B30 is taken by the shell gate, so it gets a new number when it is planned.
