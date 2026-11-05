// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// "Change the time limit" (docs/plans/review-v2/spec.md section 6.7): the commands editor of the repository with the focus on the time
// limit of the setup command that reached it. Save stores the list as Settings > Commands does. The build does not start again by itself:
// Resume or "Run setup again" runs setup with the new limit.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RepoTaskSettingsDto } from "../../shared/dto";
import { limitText, type StepDetail } from "../../shared/task";
import { dialogKeys } from "../fix/CloneDialog";
import { CommandsEditor } from "./CommandsEditor";
import { type CommandDraft, draftsToCommands, toDraft } from "./commands";
import { saveTaskCommands, useRepoTaskSettings } from "./data";

const FORM = "time-limit-form";
const PREFIX = "time-limit-cmd";

type Late = StepDetail["commands"][number];

// The stored setup row with the argv of the command, so a renamed row still matches.
const rowOf = (s: RepoTaskSettingsDto | undefined, late: Late) =>
  s?.commands.find((c) => c.kind === "setup" && JSON.stringify(c.argv) === JSON.stringify(late.argv))?.id;

// late: the command that reached its time limit. The caller mounts the dialog only while it is open. The dialog opens when the commands
// are read, so its first focus goes to the time limit of that row.
export function TimeLimitDialog(props: { project: string; repo: string; late: Late; onClose: () => void }) {
  const q = useRepoTaskSettings(props.project, props.repo);
  const { late } = props;
  if (q.isPending) return null;
  const rowId = rowOf(q.data, late);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col sm:max-w-[640px]"
        initialFocus={() => (rowId ? document.getElementById(`${PREFIX}-${rowId}-timeout`) : null)}
        onKeyDown={dialogKeys(props.onClose)}
      >
        <DialogHeader>
          <DialogTitle>Change the time limit</DialogTitle>
          <DialogDescription>
            The setup command “{late.name}” reached its time limit of {limitText(late.timeoutSec ?? 0)}. Give it more time, then click
            Resume or “Run setup again”.
          </DialogDescription>
        </DialogHeader>
        {q.error ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            Cannot read the commands. {q.error.message}
          </p>
        ) : (
          <LimitForm s={q.data} rowId={rowId} onClose={props.onClose} />
        )}
        {!q.data && (
          <DialogFooter>
            <Button variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function LimitForm({ s, rowId, onClose }: { s: RepoTaskSettingsDto; rowId: string | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<CommandDraft[]>(() => s.commands.map(toDraft));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <form
        id={FORM}
        aria-label="Commands that the app runs"
        className="-mx-1 grid min-h-0 flex-1 gap-2 overflow-auto px-1"
        onSubmit={async (e) => {
          e.preventDefault();
          const commands = draftsToCommands(drafts);
          if (!commands) {
            e.currentTarget.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
            return setProblem("Fix the marked command first.");
          }
          setBusy(true);
          setProblem(null);
          try {
            await saveTaskCommands(qc, s, commands);
            onClose();
          } catch (err) {
            setProblem((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!rowId && <p className="m-0 text-sm text-ink-2">The command is not in the list now.</p>}
        <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
          <CommandsEditor idPrefix={PREFIX} drafts={drafts} newPrefix="cmd" onChange={(next) => setDrafts(next)} />
        </fieldset>
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form={FORM} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
