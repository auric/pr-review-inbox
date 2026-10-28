// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Run log types. The stream shapes follow sdk.d.ts of @anthropic-ai/claude-agent-sdk 0.3.295 (Claude Code 2.1.295).
// They list only the fields the app reads. The CLI sends more.

export type RunStatus = "running" | "completed" | "incomplete" | "failed" | "cancelled";
export type RunErrorKind = "usage_limit" | "auth" | "max_turns" | "schema" | "tool_check" | "workspace" | "process" | "restart";

// One tool call in the run log. id is the tool_use id. parent is the id of the Agent call that made it.
export type RunEventStatus = "running" | "ok" | "error" | "stopped";
export type RunEvent = {
  id: string;
  seq: number;
  parent: string | null;
  // The CLI tool name. The agent tool is always "Agent".
  tool: string;
  // A path relative to the run cwd, a search pattern, or the Agent description.
  target: string;
  status: RunEventStatus;
  note: string | null;
  // Agent calls only: the subagent name.
  agent: string | null;
  // Agent calls only: the model of the subagent, and its total tokens so far (Gate B fixtures: resolvedModel, totalTokens, usage.total_tokens).
  model: string | null;
  tokens: number | null;
  // Agent calls only: the run did not define this agent. It comes from the CLI or the user's Claude config.
  builtin: boolean;
  startedAt: number;
  endedAt: number | null;
};

// docs/plans/review-v2/design.md section 5.1: the events of the verify phase share the run with the finder events. Their id and parent
// carry this prefix, so the tool_use ids of two processes never collide, and their seq follows the last finder event.
export const CHECK_EVENT = "check:";
// The events of a salvage run (docs/plans/review-v2/spec.md section 1.6) get this prefix. They count as finder events.
export const SALVAGE_EVENT = "salvage:";
export const eventPhase = (e: Pick<RunEvent, "id">): "find" | "check" => (e.id.startsWith(CHECK_EVENT) ? "check" : "find");

// ---------- stream-json messages (SDKMessage) ----------

export type ContentBlock = {
  type: string;
  text?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
};

export type SDKAssistantMessageError =
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "account_on_hold"
  | "verification_required"
  | "billing_error"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "unknown"
  | "max_output_tokens"
  | "cloud_credential_error";

export type SDKAssistantMessage = {
  type: "assistant";
  message: { content: ContentBlock[]; model?: string };
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;
  session_id: string;
};

// tool_use_result: the result of an Agent call carries the subagent model and, when it ran in the foreground, its token total.
export type SDKUserMessage = {
  type: "user";
  message: { content: string | ContentBlock[] };
  parent_tool_use_id: string | null;
  tool_use_result?: { resolvedModel?: unknown; totalTokens?: unknown } | string;
  session_id: string;
};

export type SDKSystemMessage = {
  type: "system";
  subtype: "init";
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: string;
  claude_code_version: string;
  agents?: string[];
  session_id: string;
};

export type SDKTaskStartedMessage = {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
};

export type SDKTaskUpdatedMessage = {
  type: "system";
  subtype: "task_updated";
  task_id: string;
  patch: { status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused"; error?: string };
};

export type SDKTaskNotificationMessage = {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  usage?: SDKTaskUsage;
};

export type SDKTaskUsage = { total_tokens?: number; tool_uses?: number; duration_ms?: number };

export type SDKTaskProgressMessage = {
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  usage?: SDKTaskUsage;
};

export type SDKRateLimitEvent = {
  type: "rate_limit_event";
  rate_limit_info: { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number; rateLimitType?: string };
};

export type SDKResultMessage = {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries";
  is_error: boolean;
  // success only: the final text, or the error text when is_error is true.
  result?: string;
  // error subtypes only.
  errors?: string[];
  structured_output?: unknown;
  terminal_reason?: string;
  api_error_status?: number | null;
  num_turns: number;
  duration_ms: number;
  total_cost_usd: number;
  usage: Record<string, unknown>;
  modelUsage: Record<string, unknown>;
  session_id: string;
  // A result of a background task has origin.kind "task-notification".
  origin?: { kind: string };
};
