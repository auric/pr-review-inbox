# Claude Code stream-json samples (Gate B)

Recorded with Claude Code 2.1.295. WP8 requires this CLI version or later.

These files are committed test fixtures. `scripts/gate/sanitize-claude.ts` once wrote them from the raw output of `scripts/gate/claude-checks.ts`. It replaces session IDs, UUIDs, home paths, the user name, email, organization, user agent, skill, plugin, and MCP server names, and user hook output. Gate runs now write to `.gate0/claude/` and never change these files. Gate transcripts are never committed. A new file here is a deliberate, reviewed copy: synthetic, or sanitized and read line by line. Do not edit the files by hand.

| File | Check |
|---|---|
| `b1-review-agent.jsonl` | B1. A review agent from an `--agents` file tries a shell command, Write, and a Read of a sibling folder. |
| `b13-agent-fields.jsonl` | Not mapped to a check. |
| `b13-bad-effort.jsonl` | Not mapped to a check. |
| `b14-default.jsonl` | Not mapped to a check. |
| `b14-haiku.jsonl` | Not mapped to a check. |
| `b15-main.jsonl` | Not mapped to a check. |
| `b15-reviewer.jsonl` | Not mapped to a check. |
| `b16-create.jsonl` | Not mapped to a check. |
| `b16-fork-nopersist.jsonl` | Not mapped to a check. |
| `b16-fork.jsonl` | Not mapped to a check. |
| `b17-write-confinement.jsonl` | Not mapped to a check. |
| `b18-verify-effort.jsonl` | Not mapped to a check. |
| `b19-usage.jsonl` | Not mapped to a check. |
| `b2-deny-agent.jsonl` | B2. The main agent tries `general-purpose`, a user agent, and `rl-reviewer`. Variants: `Agent(...)` deny rules, `Task(...)` deny rules, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, and an `--agent` main thread. |
| `b2-deny-task.jsonl` | B2. The main agent tries `general-purpose`, a user agent, and `rl-reviewer`. Variants: `Agent(...)` deny rules, `Task(...)` deny rules, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, and an `--agent` main thread. |
| `b2-main-agent.jsonl` | B2. The main agent tries `general-purpose`, a user agent, and `rl-reviewer`. Variants: `Agent(...)` deny rules, `Task(...)` deny rules, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, and an `--agent` main thread. |
| `b2-no-builtins.jsonl` | B2. The main agent tries `general-purpose`, a user agent, and `rl-reviewer`. Variants: `Agent(...)` deny rules, `Task(...)` deny rules, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, and an `--agent` main thread. |
| `b20-discuss.jsonl` | Not mapped to a check. |
| `b20-explain.jsonl` | Not mapped to a check. |
| `b20-implement.jsonl` | Not mapped to a check. |
| `b20-interview.jsonl` | Not mapped to a check. |
| `b20-spec.jsonl` | Not mapped to a check. |
| `b3-default.jsonl` | B3. One subagent run with `--json-schema`: Agent tool_use, child events, `task_*` events, result events. Variant: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. |
| `b3-no-background.jsonl` | B3. One subagent run with `--json-schema`: Agent tool_use, child events, `task_*` events, result events. Variant: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. |
| `b4-no-persistence.jsonl` | B4. One subagent run with `--no-session-persistence`. |
| `b5-auth.jsonl` | B5. Errors: `--max-turns 1` on a two-step task, and a run with an empty `CLAUDE_CONFIG_DIR` (auth failure). |
| `b5-max-turns.jsonl` | B5. Errors: `--max-turns 1` on a two-step task, and a run with an empty `CLAUDE_CONFIG_DIR` (auth failure). |
| `b6-hostile-repo.jsonl` | B6. A sanitized hostile repository with the app flags. Expect no hook, no canary, and only the app MCP server. |
| `b7-stub-mcp.jsonl` | B7. A stub stdio MCP server with one read-only tool, called by the main agent and by a subagent. |
| `b8-plain.jsonl` | B8. `--restricted` with stream-json, `--json-schema`, the stub MCP server, and `rl-reviewer`. Variant: `--setting-sources user` and `--settings`. |
| `b8-with-settings.jsonl` | B8. `--restricted` with stream-json, `--json-schema`, the stub MCP server, and `rl-reviewer`. Variant: `--setting-sources user` and `--settings`. |
| `b9-first-try.jsonl` | B9, first try. The WP8 flag set with `--allowedTools mcp__rl-*` and no `StructuredOutput` in the `rl-main` tools. The stub tool is refused, and no result event has `structured_output`. |
| `b9-wp8-flags.jsonl` | B9. The WP8 flag set with a long-path cwd: `--restricted`, `--agent rl-main`, `rl-reviewer`, the stub MCP server, `--json-schema`, `--no-session-persistence`, and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. |
