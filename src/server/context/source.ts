// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// ContextSource (BRIEF section 7): an issue source behind one boundary. Jira (jira.ts) is the only implementation.
import type { IssueContext } from "../../shared/dto";

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
  // Passes the bytes of one attachment to write, in order. size: the listed byte count. Another count throws kind shape.
  // Throws a ContextError, or the error of write.
  download(att: { id: string; filename: string; size: number }, write: (chunk: Uint8Array) => Promise<void>): Promise<void>;
};
