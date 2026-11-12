// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The run pool for the start controls of one PR (docs/plans/review-v2/parallel-runs.md section 3.6). The server still decides.
import { useQueryClient } from "@tanstack/react-query";
import type { PrRow, RunConflict } from "../../shared/dto";
import { refusedText, slotNote } from "../ask/model";
import { prKey } from "../shell/model";
import { usePrRuns, useRunSlots } from "./data";
import { slotBusy } from "./model";

// own: a run whose state the caller shows itself. It gives no note.
// note: W1 or W2 while a start must wait, else null. refused: the text of a 409. where: a run place in words.
export function useSlots(pr: number, runner: string, own?: (run: number) => boolean) {
  const qc = useQueryClient();
  const busy = slotBusy(useRunSlots().data, usePrRuns(pr).data, pr);
  const where = (id: number | null, task?: string) => {
    if (id === null) return task ?? "a task";
    if (id === pr) return "this pull request";
    const other = qc.getQueryData<PrRow[]>(["prs"])?.find((p) => p.id === id);
    return other ? prKey(other) : "another pull request";
  };
  const note = busy && !(busy.kind === "pr" && own?.(busy.run.run)) ? slotNote(runner, busy, where) : null;
  return { note, where, refused: (c: RunConflict) => refusedText(runner, c, where) };
}
