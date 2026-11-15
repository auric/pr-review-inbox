// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The server needs it for the task notifications (src/server/tasks/notify.ts), so it is shared.
import type { TaskRowDto, TaskStepDto } from "./dto";

// ps5-plan.md D4: what the open step row of a part does. The DTO has no stored value for it, so it follows from the step kind and item.
// null: no build work, such as the interview, the plan, a push, or a PR.
export type RowPhase =
  | "building"
  | "following"
  | "judging"
  | "fixing"
  | "setup"
  | "baseline"
  | "checking"
  | "critic"
  | "reviewing"
  | "updating"
  | "resolving";
export function rowPhase(s: Pick<TaskStepDto, "kind" | "item">): RowPhase | null {
  switch (s.kind) {
    case "implement":
    case "tests":
      return "building";
    case "fix":
      if (s.item === "points" || s.item === "pushback") return "following";
      return s.item === "review" || s.item === "critic" ? "judging" : "fixing";
    case "instruct":
      return "following";
    case "check":
      return s.item === "setup" ? "setup" : s.item === "base" ? "baseline" : "checking";
    case "commit":
      return "checking";
    case "review":
      return s.item === "critic" ? "critic" : "reviewing";
    case "update":
      return "updating";
    case "resolve":
      return "resolving";
    default:
      return null;
  }
}

// part-session.md section 9.7, invariant 8: the open row that gives the phase of a part. Absent part: of the task. steps: newest first,
// as TaskDto.steps. A waiting message (ps4-plan.md WP-7) beside another open row gives no phase. An update row beside its resolve or
// check row (WP-5) gives none too.
export function phaseRow<T extends Pick<TaskStepDto, "kind" | "state" | "part">>(steps: readonly T[], part?: number): T | null {
  const open = steps.filter((s) => (s.state === "running" || s.state === "waiting") && (part === undefined || s.part === part));
  const runs = open.filter((s) => s.kind !== "instruct" || s.state !== "waiting");
  const rows = runs.length ? runs : open;
  return rows.find((s) => s.kind !== "update") ?? rows[0] ?? null;
}

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
  slot: "Waiting for a free run slot",
  preflight: "Needs you: a check before the build",
  update: "Needs you: the update stopped",
  error: "Needs you: an error",
  allow: "Needs you: Claude asks to allow a command",
  usage: "Needs you: the usage limit",
  held: "Needs you: a held part",
  stuck: "Needs you: Claude is stuck",
  unfinished: "Needs you: open tasks are left",
};
// "Building part 2 of 4", or "Building parts 2 and 3 of 4" while parts build at the same time. Without a part in its build, the first
// open part.
function buildingText(p: TaskRowDto["progress"]): string {
  const ns = p.building.length ? p.building : p.part ? [p.part] : [];
  if (ns.length < 2) return ns.length ? `Building part ${ns[0]} of ${p.parts}` : "Building";
  const list = ns.length < 3 ? ns.join(" and ") : `${ns.slice(0, -1).join(", ")}, and ${ns.at(-1)}`;
  return `Building parts ${list} of ${p.parts}`;
}

// part-session.md section 9.4: a "<kind>/<cause>" key with its own status. Other causes take the status of their kind.
const CAUSE_NEEDS: Partial<Record<string, string>> = { "error/restart": "Needs you: the app restarted" };
export function rowStatus(r: TaskRowDto): { text: string; needsYou: boolean } {
  const p = r.progress;
  if (r.state === "done") return { text: r.closedAt === null ? "Done" : "Closed", needsYou: false };
  if (r.state === "failed") return { text: "Failed", needsYou: false };
  if (r.state === "stopped") return { text: "Stopped", needsYou: true };
  if (r.blocked) {
    if (r.state === "interview") return { text: "Needs you: answer the questions", needsYou: true };
    // spec.md section 6.25.6: the reasons of other parts that wait behind the first one.
    const more = r.queued > 0 ? `, and ${r.queued} more` : "";
    // ps5-plan.md D6: an armed usage reason goes on by itself.
    const armed = r.blocked.kind === "usage" && r.blocked.armed === true;
    const needs = CAUSE_NEEDS[`${r.blocked.kind}/${r.blocked.cause}`] ?? NEEDS[r.blocked.kind];
    return {
      text: `${armed ? "Resumes after the usage limit" : needs}${more}`,
      needsYou: r.blocked.kind !== "slot" && !armed,
    };
  }
  // ps5-plan.md D6: held lives in the part rows only.
  if (p.held > 0) return { text: "On hold", needsYou: false };
  if (r.state === "interview") return { text: "Reading the task", needsYou: false };
  if (r.state === "spec_draft")
    return p.planReady ? { text: "Needs you: approve the plan", needsYou: true } : { text: "Writing the plan", needsYou: false };
  if (r.state === "implementing") {
    if (p.ready) return { text: "Needs you: open the PR", needsYou: true };
    return { text: buildingText(p), needsYou: false };
  }
  if (r.state === "ready") return { text: p.merged ? "Merged" : "Waiting for review", needsYou: false };
  return { text: "Waiting for colleagues", needsYou: false };
}
