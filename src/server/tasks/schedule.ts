// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The scheduler of the parts of a task (docs/plans/review-v2/spec.md section 6.20.6, design.md B29). It is a pure function and no XState
// machine. The loop and the TaskDto both read it, so the loop and the UI never disagree.
import type { PartState, StartMode } from "../../shared/task";

// One part. label: its name in a sentence. after: the task_part ID of the lower part. gate: the part passed the part gate (spec.md
// section 6.10). override: the user started it before colleagues approved its lower part. done: Jira says that each sub-task of the part
// is done.
export type SchedulePart = {
  id: number;
  ord: number;
  label: string;
  state: PartState;
  start: StartMode | null;
  after: number | null;
  gate: boolean;
  override: boolean;
  done: boolean;
};

// starts: the parts to start, by ord. on: the lower part that a part builds on, null for a start from the task base. waits: the reason of
// each planned part that does not start.
export type Schedule = { starts: { id: number; on: number | null }[]; waits: Map<number, string> };

// The open count: built parts and PRs, tracked PRs included.
const OPEN = new Set<PartState>(["self_reviewed", "pr_open", "changes_requested", "approved"]);
// A part that builds on a lower part needs its pushed head, so the lower part has a PR.
const HAS_PR = new Set<PartState>(["pr_open", "changes_requested", "approved"]);

// The base of a planned part when its start condition holds, else the reason it waits.
function startOf(p: SchedulePart, parts: readonly SchedulePart[]): { on: number | null } | { wait: string } {
  const lower = p.start === "base" || p.start === null || p.after === null ? undefined : parts.find((x) => x.id === p.after);
  // A dropped, merged, or done lower part frees the part: it starts from the base (design.md Q70).
  if (!lower || lower.done || lower.state === "abandoned" || lower.state === "merged") return { on: null };
  if (lower.state === "declined") return { wait: `Waits for ${lower.label}, which is declined.` };
  if (p.start === "merge") return { wait: `Waits for ${lower.label} to merge.` };
  if (HAS_PR.has(lower.state) && (lower.gate || p.override)) return { on: lower.id };
  return { wait: `Waits for a review of ${lower.label}.` };
}

// At most atOnce parts build at the same time (spec.md section 6.20.6, user decision of 2026-11-02). 1 builds one part after the other
// (design.md B12). A part that builds counts toward maxOpen, because it opens a PR next. At maxOpen open parts no part starts. The
// startable parts start by ord. A part never starts while the part that it builds on builds: startOf waits for its PR or its merge.
export function nextPart(parts: readonly SchedulePart[], maxOpen: number, atOnce = 1): Schedule {
  const waits = new Map<number, string>();
  const busy = parts.filter((p) => p.state === "implementing");
  const open = parts.filter((p) => OPEN.has(p.state)).length;
  const starts: Schedule["starts"] = [];
  for (const p of [...parts].sort((a, b) => a.ord - b.ord)) {
    if (p.state !== "planned") continue;
    const s = startOf(p, parts);
    const first = busy[0]?.label ?? parts.find((x) => x.id === starts[0]?.id)?.label;
    if ("wait" in s) waits.set(p.id, s.wait);
    else if (open >= maxOpen)
      waits.set(p.id, `Waits: ${open} ${open === 1 ? "PR of this task is" : "PRs of this task are"} open, your limit.`);
    else if (busy.length + starts.length >= atOnce || open + busy.length + starts.length >= maxOpen)
      waits.set(p.id, `Waits for the build of ${first}.`);
    else starts.push({ id: p.id, on: s.on });
  }
  return { starts, waits };
}
