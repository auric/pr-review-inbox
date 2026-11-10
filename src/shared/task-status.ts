// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The server needs it for the task notifications (src/server/tasks/notify.ts), so it is shared.
import type { TaskRowDto } from "./dto";

// spec.md section 6.12, Inbox: the status in the meta line of a Tasks row.
const NEEDS: Record<NonNullable<TaskRowDto["blocked"]>["kind"], string> = {
  question: "Needs you: a question",
  red: "Needs you: tests stay red",
  blocker: "Needs you: review points left",
  budget: "Needs you: the time limit",
  size: "Needs you: over the line limit",
  spec_change: "Needs you: a change to the plan",
  denied_path: "Needs you: a file the app does not commit",
  push: "Needs you: the push",
  slot: "Waiting for the run slot",
  preflight: "Needs you: a check before the build",
  update: "Needs you: the update stopped",
  error: "Needs you: an error",
  allow: "Needs you: Claude asks to allow a command",
};
export function rowStatus(r: TaskRowDto): { text: string; needsYou: boolean } {
  const p = r.progress;
  if (r.state === "done") return { text: r.closedAt === null ? "Done" : "Closed", needsYou: false };
  if (r.state === "failed") return { text: "Failed", needsYou: false };
  if (r.state === "stopped") return { text: "Stopped", needsYou: true };
  if (r.blocked) {
    if (r.state === "interview") return { text: "Needs you: answer the questions", needsYou: true };
    // spec.md section 6.25.6: the reasons of other parts that wait behind the first one.
    const more = r.queued > 0 ? `, and ${r.queued} more` : "";
    return { text: `${NEEDS[r.blocked.kind]}${more}`, needsYou: r.blocked.kind !== "slot" };
  }
  if (r.state === "interview") return { text: "Reading the task", needsYou: false };
  if (r.state === "spec_draft")
    return p.planReady ? { text: "Needs you: approve the plan", needsYou: true } : { text: "Writing the plan", needsYou: false };
  if (r.state === "implementing") {
    if (p.ready) return { text: "Needs you: open the PR", needsYou: true };
    return { text: p.part ? `Building part ${p.part} of ${p.parts}` : "Building", needsYou: false };
  }
  if (r.state === "ready") return { text: p.merged ? "Merged" : "Waiting for review", needsYou: false };
  return { text: "Waiting for colleagues", needsYou: false };
}
