# Synthetic Claude Code stream samples

These files are hand-written. No real run produced them. Gate B did not reach a usage limit, so the usage-limit shape is not verified (docs/plans/v3.md U9).

| File | Basis |
|---|---|
| `usage-limit.jsonl` | `b5-auth.jsonl` with the field values for a limit from the Agent SDK 0.3.295 types: assistant `error: "rate_limit"` (SDKAssistantMessageError), `rate_limit_info.status: "rejected"` (SDKRateLimitInfo), and `api_error_status: 429`. The message text is invented. |
| `session-resume.jsonl` | A session fork of docs/plans/session-consult.md part C: init with the read tools and no MCP server, one Read, one StructuredOutput call, and a result with `structured_output`. The event shapes follow `b9-wp8-flags.jsonl`. The file is hand-written. Gate B16 confirmed the resume shape on CLI 2.1.301: init lists only the read tools and StructuredOutput, and the result carries `structured_output`. |
| `max-turns-notes.jsonl` | A finder that reaches its turn cap: rl-main text, one Read, one rl-reviewer Agent call with a subagent text and its report, more rl-main text, and a result with subtype `error_max_turns` and no `structured_output`. The result shape follows `b5-max-turns.jsonl`. The texts are invented. |
| `max-turns-empty.jsonl` | The same finder with one Read and no text: it leaves no notes. |

They live outside `fixtures/claude/`, because `scripts/gate/sanitize-claude.ts` deletes every `.jsonl` file there. Replace a file here when a real run records its shape.
