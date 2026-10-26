// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The attachments of a Build task (docs/plans/review-v2/spec.md section 6.17): one box per file that can go to runs, "Include all",
// and the company AI policy question before the first tick. The form of a new task keeps the ticks until its create. The
// Attachments tab of the Task view sends each tick at once, and the next step of the task reads it.
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, File, FileImage, FileText, LoaderCircle, Paperclip } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import type { TaskDto } from "../../shared/dto";
import { mustAsk, PolicyDialog } from "../review/PolicyDialog";
import { useSettings } from "../shell/data";
import { putTaskFile } from "./data";
import { type FileChoice, fileChoiceState, fileChoices, fileMeta } from "./model";

const KIND_ICON = { image: FileImage, pdf: FileText, text: FileText, file: File } as const;
const icon = "size-[15px] shrink-0";

export const boxId = (base: string, r: Pick<FileChoice, "id">) => `${base}-${r.id}`;

// The boxes of one task. checked: the ticked IDs. busy: the IDs that wait for the server. state: the second line after the size
// and the type. A file without a box shows why it stays listed only.
export function FilePicker(props: {
  id: string;
  rows: FileChoice[];
  checked: ReadonlySet<string>;
  busy?: ReadonlySet<string>;
  errors?: ReadonlyMap<string, string>;
  disabled?: boolean;
  note: ReactNode;
  state?: (r: FileChoice) => string | null;
  onToggle: (r: FileChoice, on: boolean) => void;
  onAll: () => void;
}) {
  const { rows, checked } = props;
  const boxes = rows.filter((r) => r.why === null);
  const left = boxes.filter((r) => !checked.has(r.id));
  const busy = props.busy ?? new Set<string>();
  return (
    <FieldSet className="min-w-0 gap-1.5">
      <FieldLegend className="mb-0 inline-flex items-center gap-1.5 text-sm font-semibold">
        <Paperclip aria-hidden className={cn(icon, "text-muted-foreground")} />
        Attachments ({rows.length})
      </FieldLegend>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <FieldDescription className="m-0 min-w-0 flex-[1_1_24ch] text-xs text-ink-2">{props.note}</FieldDescription>
        {boxes.length > 1 && left.length > 0 && (
          <Button
            id={`${props.id}-all`}
            type="button"
            variant="outline"
            size="xs"
            disabled={props.disabled || busy.size > 0}
            onClick={props.onAll}
          >
            Include all
          </Button>
        )}
      </div>
      <ul className="m-0 grid list-none rounded-md border p-0">
        {rows.map((r) => {
          const Icon = busy.has(r.id) ? LoaderCircle : KIND_ICON[r.kind];
          const error = props.errors?.get(r.id);
          const extra = props.state ? props.state(r) : r.why;
          const line = (
            <span className="grid min-w-0">
              <span id={`${boxId(props.id, r)}-name`} translate="no" className="truncate text-sm font-medium" title={r.filename}>
                {r.filename}
              </span>
              <span id={`${boxId(props.id, r)}-state`} className="text-xs text-muted-foreground">
                {fileMeta(r)}.{extra ? ` ${extra}` : ""}
              </span>
            </span>
          );
          return (
            <li key={r.id} data-att={r.id} className="grid gap-1 border-b px-2.5 py-1.5 last:border-b-0">
              {r.why === null ? (
                <label className="grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2">
                  <input
                    id={boxId(props.id, r)}
                    type="checkbox"
                    className="m-0 mt-[3px] size-4 accent-foreground"
                    checked={checked.has(r.id)}
                    disabled={props.disabled || busy.has(r.id)}
                    aria-labelledby={`${boxId(props.id, r)}-name`}
                    aria-describedby={`${boxId(props.id, r)}-state ${boxId(props.id, r)}-error`}
                    onChange={(e) => props.onToggle(r, e.target.checked)}
                  />
                  <Icon aria-hidden className={cn(icon, "mt-[3px] text-muted-foreground", busy.has(r.id) && "motion-safe:animate-spin")} />
                  {line}
                </label>
              ) : (
                <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2">
                  <span aria-hidden className="size-4" />
                  <Icon aria-hidden className={cn(icon, "mt-[3px] text-muted-foreground")} />
                  {line}
                </div>
              )}
              {error && (
                <p id={`${boxId(props.id, r)}-error`} className="m-0 flex items-start gap-1.5 text-xs text-destructive">
                  <CircleAlert aria-hidden className={icon} />
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </FieldSet>
  );
}

// The empty state of the form: the issue lists no attachment.
export function NoAttachments(props: { runner: string }) {
  return (
    <Empty className="gap-1 rounded-md border p-3">
      <EmptyHeader className="gap-1">
        <EmptyMedia variant="icon" className="mb-0">
          <Paperclip aria-hidden />
        </EmptyMedia>
        <EmptyTitle>No attachments</EmptyTitle>
        <EmptyDescription className="text-xs">{props.runner} reads the task text only.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

type Ask = { title: string; description: string; action: string; focus: string };

// The policy question before a tick. ask runs run at once when the setting askAttachments is off. dialog: put it once in the tree.
export function usePolicy(runner: string, source: string) {
  const settings = useSettings().data;
  const [pending, setPending] = useState<(Ask & { run: () => void }) | null>(null);
  // The last question stays while the dialog plays its close transition.
  const last = useRef<Ask | null>(null);
  if (pending) last.current = pending;
  const asking = mustAsk(settings?.askAttachments);
  const ask = (a: Ask, run: () => void) => (asking ? setPending({ ...a, run }) : run());
  const dialog = (
    <PolicyDialog
      open={pending !== null}
      title={last.current?.title ?? ""}
      description={last.current?.description ?? ""}
      action={last.current?.action ?? "Include"}
      runner={runner}
      source={source}
      finalFocus={() => document.getElementById(last.current?.focus ?? "")}
      onClose={() => setPending(null)}
      onConfirm={() => {
        const p = pending;
        setPending(null);
        p?.run();
      }}
    />
  );
  return { asking, ask, dialog };
}

// The words of the policy question for one file or for all files.
export function askText(runner: string, files: FileChoice[], focus: string): Ask {
  const one = files.length === 1 ? files[0] : undefined;
  return {
    title: one ? `Include ${one.filename}?` : `Include ${files.length} files?`,
    description: `${runner} can then read ${one ? "this file" : "these files"} in every step of this task: the questions, the plan, the tests, the code, the fixes, and its own review. It reads ${one ? "it" : "them"} as untrusted data.`,
    action: one ? "Include" : "Include all",
    focus,
  };
}

// The Attachments tab of the Task view. Each tick sends PUT /api/tasks/:id/files/:att at once. A tick of a file that is not
// downloaded yet downloads it first. One request after the other, so the tracker never gets parallel downloads from the app.
export function TaskFiles(props: { t: TaskDto; runner: string; source: string }) {
  const { t, runner } = props;
  const qc = useQueryClient();
  const rows = fileChoices(t.attachments, t.files);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [said, setSaid] = useState("");
  const policy = usePolicy(runner, props.source);
  const base = `task-file-${t.id}`;
  const checked = new Set(t.files.filter((f) => f.include).map((f) => f.id));

  const put = async (r: FileChoice, on: boolean) => {
    setBusy((b) => new Set(b).add(r.id));
    setErrors((m) => {
      const n = new Map(m);
      n.delete(r.id);
      return n;
    });
    try {
      await putTaskFile(qc, t.id, r.id, on);
      return true;
    } catch (e) {
      setErrors((m) => new Map(m).set(r.id, (e as Error).message));
      return false;
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(r.id);
        return n;
      });
    }
  };
  const toggle = (r: FileChoice, on: boolean) => {
    const run = async () => {
      if (await put(r, on)) setSaid(on ? `${runner} gets ${r.filename} from the next step.` : `${runner} no longer gets ${r.filename}.`);
      else setSaid(`${r.filename}: ${on ? "not included" : "still included"}. The row shows the error.`);
    };
    if (on) policy.ask(askText(runner, [r], boxId(base, r)), () => void run());
    else void run();
  };
  const all = () => {
    const todo = rows.filter((r) => r.why === null && !checked.has(r.id));
    // "Include all" goes away when every box is ticked, so the focus returns to the first new box.
    policy.ask(askText(runner, todo, boxId(base, todo[0] ?? { id: "" })), async () => {
      let ok = 0;
      for (const r of todo) if (await put(r, true)) ok++;
      setSaid(
        ok === todo.length
          ? `${runner} gets ${todo.length} more files from the next step.`
          : `Included ${ok} of ${todo.length} files. Each failed file shows its error.`,
      );
      if (todo[0]) requestAnimationFrame(() => document.getElementById(boxId(base, todo[0] as FileChoice))?.focus());
    });
  };

  return (
    <div className="grid max-w-[72ch] gap-2">
      <FilePicker
        id={base}
        rows={rows}
        checked={checked}
        busy={busy}
        errors={errors}
        note={`${runner} reads the ticked files in each step. A change applies from the next step.`}
        state={(r) => fileChoiceState(r, runner)}
        onToggle={toggle}
        onAll={all}
      />
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
      {policy.dialog}
    </div>
  );
}
