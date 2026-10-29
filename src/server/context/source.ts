// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// ContextSource (BRIEF section 7): an issue source behind one boundary. Jira (jira.ts) is the only implementation.
import type { IssueContext, IssueSubtask } from "../../shared/dto";

// to: the status name after the move, null when absent.
export type JiraTransition = { id: string; name: string; to: string | null };

export type ContextErrorKind = "auth" | "forbidden" | "not_found" | "redirect" | "rate" | "server" | "shape" | "timeout" | "network";

// Messages hold only the kind, the status, the system error code, and the endpoint path. Never the token, headers, or response text.
export class ContextError extends Error {
  constructor(
    readonly kind: ContextErrorKind,
    readonly endpoint: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`${kind}${status ? ` ${status}` : ""}${code ? ` ${code}` : ""}: ${endpoint}`);
    this.name = "ContextError";
  }
}

export type ContextSource = {
  id: "jira";
  name: string;
  // Checks the URL and the token. Returns the user name. Throws a ContextError, or a JiraDeploymentError for the wrong auth form.
  check(): Promise<string>;
  // Throws a ContextError.
  fetchIssue(key: string): Promise<IssueContext>;
  // Reads a sub-task of parent. Another parent gives null. links keep only siblings, the other sub-tasks of the parent. Throws a ContextError.
  fetchSubtask(parent: string, siblings: readonly string[], key: string): Promise<IssueContext | null>;
  // The sub-tasks of parent in Jira order, from one GET of the subtasks field. Throws a ContextError.
  subtaskStatuses(parent: string): Promise<IssueSubtask[]>;
  // Throws a ContextError.
  transitions(key: string): Promise<JiraTransition[]>;
  // The only request that changes Jira. Call it only after the user confirms. Throws a ContextError, a JiraRefusedError for a 4xx or 5xx.
  transition(key: string, id: string): Promise<void>;
  // Passes the bytes of one attachment to write, in order. size: the listed byte count. Another count throws kind shape.
  // Throws a ContextError, or the error of write.
  download(att: { id: string; filename: string; size: number }, write: (chunk: Uint8Array) => Promise<void>): Promise<void>;
};
