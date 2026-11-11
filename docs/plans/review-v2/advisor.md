# Advisor in app runs

Status: design of 2026-11-11. Not built. Facts come from the Claude Code docs, not from a run. Gate G-ADV must confirm them before code depends on them.

## Facts (docs)

- The advisor is a server-side tool. A second, usually stronger model reads the conversation at decision points and returns guidance. Claude decides when to call it (code.claude.com/docs/en/advisor.md).
- On a subscription, advisor usage counts toward the plan limits. A Fable advisor bills to usage credits on plans where Fable does.
- Ways to turn it on: `--advisor <model>` for one session (CLI reference), or `advisorModel` in a settings file. Unset means off.
- Ways to turn it off: no `--advisor` and no `advisorModel`, or `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, which also ignores `--advisor`.
- An agent definition has no advisor field. Subagents inherit the advisor of the session.
- Model values: `fable`, `opus`, `sonnet`, or a full model ID. Haiku cannot be an advisor. The advisor must rank at or above the main model, else a launch exits with an error.
- The advisor needs feature-flag fetching. `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, and `CLAUDE_CODE_DISABLE_FEATURE_FLAGS` remove it.
- API wire format: a `server_tool_use` block named `advisor`, then an `advisor_tool_result` block. Advisor tokens are in `usage.iterations[]` with `type: "advisor_message"`.

## Not documented (Gate G-ADV)

1. Does `--advisor` work with `-p`, `--restricted`, `--agents`/`--agent`, and `--json-schema`?
2. Does `--restricted` ignore a user `advisorModel` in `~/.claude/settings.json`? So do app runs have an advisor today?
3. Does the init event list `advisor` in its tools? The init check stops a run whose init lists a tool outside the allowlist.
4. Do `--tools`, `--allowedTools`, or `--disallowedTools` control it?
5. Which stream-json events show an advisor call, and do `total_cost_usd` and `modelUsage` count the advisor tokens?
6. The minimum CLI version.

## Design

- Profile field "Advisor": Off (default) or a model (`opus`, `fable`, or a full model ID). The task profile has the same field for task steps.
- Off: the child env gets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, so a user setting can never turn it on in an app run.
- On: the run gets `--advisor <model>`. The app refuses a profile save when the advisor ranks below the main model or is Haiku.
- The init allowlist accepts `advisor` only when the profile turns it on (per G-ADV fact 3).
- The stream parser shows each advisor call in the run log as "Advisor: reviewed" or "declined", and adds advisor tokens to the run usage (per G-ADV fact 5). An advisor call never counts as a refused tool.
- The child env scrub keeps the three feature-flag variables out when the advisor is on.
- Help text: "A stronger model gives Claude advice at hard points. It uses more of your plan."

## Packages

1. WP-ADV0: a gate script in scripts/gate/claude-checks.ts that runs the six checks with the real CLI and prints sanitized facts. The user runs it. Facts go to integration-check.md.
2. WP-ADV1: the profile field, the flag and env, the init allowlist, the parser, the help text, tests with the fake claude, screenshots.
