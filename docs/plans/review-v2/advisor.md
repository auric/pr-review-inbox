# Advisor in app runs

Status: built (WP-ADV1, spec.md section 6.27, AC-B205 to AC-B211). Design of 2026-11-11. Gate G-ADV run 1 (2026-11-11, CLI 2.1.322) confirmed ADV1, ADV3, ADV5, and in effect ADV2. ADV4 stays open (integration-check.md, section Advisor).

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

## Gate G-ADV run 1 results

- `--advisor` works with the app flags (`-p`, `--restricted`, `--agents`, `--agent`, `--json-schema`).
- App runs without `--advisor` get no advisor today, also with a user `advisorModel` set (one sample).
- init.tools never lists the advisor. Only `slash_commands` lists the /advisor command.
- A call shows as a `server_tool_use` block named `advisor` and an `advisor_tool_result` block. The result usage has an `advisor_message` iteration. modelUsage lists the advisor model, and total_cost_usd counts it.
- Not known: whether `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, `--disallowedTools advisor`, or `--tools` turn it off.

## Design

- Profile field "Advisor": Off (default) or a model (`opus`, `fable`, or a full model ID). The task profile has the same field for task steps.
- Off: the run gets no `--advisor` (ADV2: then it has no advisor). The child env also gets `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` as a second guard; its effect is not verified (ADV4).
- On: the run gets `--advisor <model>`. The app refuses a profile save when the advisor ranks below the main model or is Haiku.
- The init check needs no change: init.tools never lists the advisor (ADV3).
- The stream parser shows each advisor call in the run log as "Advisor: reviewed" or "declined", and shows the advisor model from modelUsage in the run usage (ADV5). An advisor call never counts as a refused tool.
- The child env scrub keeps the three feature-flag variables out when the advisor is on.
- Help text: "A stronger model gives Claude advice at hard points. It uses more of your plan."

## Packages

1. WP-ADV0: built. Gate GADV in scripts/gate/claude-checks.ts runs the six checks with the real CLI and prints sanitized facts. The user runs `bun scripts/gate/claude-checks.ts --only GADV`, then `bun scripts/gate/sanitize-claude.ts`. Options: `--advisor <model>` (default `opus`) and `--main-model <model>` (default `sonnet`). Facts go to integration-check.md, section "Advisor (Gate G-ADV, not run)".
2. WP-ADV1: built. The profile field, the flag and env, the parser, the help text, tests with the fake claude. No README image shows the Run setup part, so the screenshots stay as they are. The init allowlist needed no change. Gate fixes: GADV.2 ignores `slash_commands`, and GADV.2, GADV.4, GADV.5a, and GADV.5b judge by the advisor calls. GADV.4 and GADV.5a now send the advisor prompt.
3. Open: the profile save compares model families only. The docs accept some lower-family advisors of a newer version, for example Sonnet 5.5 for Opus 4.7, and Haiku 5.5 for some main models. The app refuses them. The wire form of "declined" is not documented: the parser reads `stop_reason` "refusal" as declined. No gate run has shown it.
