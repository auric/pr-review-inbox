// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The editable list "Commands <runner> may run" (docs/plans/review-v2/spec.md section 6.21): a pattern and a reason per row, Remove, and
// "Add a pattern". Settings > Commands edits every row. The plan screen adds a tick per row and shows a saved row read-only as "approved
// before". ShellDialog holds the first-use warning and the Most commands confirm (section 6.21.8).
import { CircleAlert, Plus, TriangleAlert, X } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ALLOW_MAX, ALLOW_PATTERN_MAX, allowWarning } from "../../shared/task";
import { dialogKeys } from "../fix/CloneDialog";
import { useMeta } from "../meta";
import { trackerOf } from "../review/tasks";
import { Hint } from "../shell/Hint";
import {
  type AllowDraft,
  ANY_TITLE,
  allowDraftProblem,
  anyText,
  type ShellNames,
  SOURCE_TEXT,
  UNRESTRICTED_TITLE,
  unrestrictedText,
  warningText,
  warningTitle,
} from "./allow";
import { freeId } from "./commands";

// The product names of the texts, from GET /api/meta. The shell renders its panes only after meta loads.
export function useShellNames(): ShellNames {
  const meta = useMeta().data;
  return {
    runner: meta?.runner.short ?? "",
    cli: meta?.runner.name ?? "",
    forge: meta?.forge.name ?? "",
    tracker: (meta && trackerOf(meta)?.name) ?? "tracker",
  };
}

const iconBtn =
  "inline-grid size-[30px] shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-ink-2 hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";
const REASON_MAX = 300;

export function AllowEditor(props: {
  // The prefix of the DOM IDs, unique on the page.
  idPrefix: string;
  drafts: AllowDraft[];
  // typing: a key in a field, so the caller can wait before a save.
  onChange: (drafts: AllowDraft[], typing: boolean) => void;
  onBlur?: () => void;
  // The plan screen: the ticked rows join the list. Absent: every row is in the list.
  picked?: ReadonlySet<string>;
  onPick?: (id: string, on: boolean) => void;
  // The IDs of the patterns that the repository saved before. The plan screen shows them read-only.
  saved?: ReadonlySet<string>;
  // The ID prefix of an added row.
  newPrefix: string;
  // Called with the add action, so the caller can show the first-use warning first. Absent: the row adds at once.
  onAdd?: (add: () => void) => void;
}) {
  const { drafts, idPrefix } = props;
  const names = useShellNames();
  const set = (i: number, patch: Partial<AllowDraft>) =>
    props.onChange(
      drafts.map((d, k) => (k === i ? { ...d, ...patch } : d)),
      true,
    );
  const add = () => {
    const id = freeId(drafts, props.newPrefix);
    props.onChange([...drafts, { id, pattern: "", reason: "" }], false);
    props.onPick?.(id, true);
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-${id}-pattern`)?.focus());
  };
  const remove = (i: number) => {
    const next = drafts.filter((_, k) => k !== i);
    props.onChange(next, false);
    // The focus goes to the next row, else to the add button.
    const to = next[i] ?? next[i - 1];
    requestAnimationFrame(() => document.getElementById(to ? `${idPrefix}-${to.id}-pattern` : `${idPrefix}-add`)?.focus());
  };
  return (
    <div className="grid gap-2">
      {drafts.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0">
          {drafts.map((d, i) => {
            const id = `${idPrefix}-${d.id}`;
            const fixed = props.saved?.has(d.id) ?? false;
            const problem = fixed ? null : allowDraftProblem(d, drafts);
            const warning = problem ? null : allowWarning(d.pattern);
            const label = d.pattern.trim() || `pattern ${i + 1}`;
            const notes = [problem && `${id}-error`, warning && `${id}-warning`].filter(Boolean).join(" ") || undefined;
            return (
              <li key={d.id} data-allow-row={d.pattern.trim()} className="grid gap-1.5 rounded-md border bg-card px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {props.picked && (
                    <input
                      type="checkbox"
                      aria-label={`Allow ${label}`}
                      aria-describedby={fixed ? `${id}-saved` : undefined}
                      checked={fixed || props.picked.has(d.id)}
                      disabled={fixed}
                      className="m-0 size-4 accent-foreground disabled:opacity-60"
                      onChange={(e) => props.onPick?.(d.id, e.target.checked)}
                    />
                  )}
                  {fixed ? (
                    <code translate="no" className="min-w-0 flex-1 font-mono text-[12.5px] [overflow-wrap:anywhere]">
                      {d.pattern}
                    </code>
                  ) : (
                    <Input
                      id={`${id}-pattern`}
                      aria-label={`Pattern of ${label}`}
                      aria-invalid={problem ? true : undefined}
                      aria-describedby={notes ?? `${idPrefix}-help`}
                      className="h-[30px] min-w-0 flex-1 basis-56 font-mono text-[12.5px]"
                      translate="no"
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={ALLOW_PATTERN_MAX}
                      value={d.pattern}
                      placeholder="ssh build1 *"
                      onChange={(e) => set(i, { pattern: e.target.value })}
                      onBlur={props.onBlur}
                    />
                  )}
                  {fixed && (
                    <span id={`${id}-saved`} className="text-xs text-muted-foreground">
                      approved before
                    </span>
                  )}
                  {!fixed && d.source && (
                    <span data-allow-source={d.source} className="text-xs text-muted-foreground">
                      {SOURCE_TEXT[d.source]}
                    </span>
                  )}
                  {!fixed && (
                    <Hint label="Remove">
                      <button type="button" className={iconBtn} aria-label={`Remove ${label}`} onClick={() => remove(i)}>
                        <X aria-hidden className="size-[15px]" />
                      </button>
                    </Hint>
                  )}
                </div>
                {fixed ? (
                  d.reason && <p className="m-0 text-xs text-ink-2">{d.reason}</p>
                ) : (
                  <Input
                    id={`${id}-reason`}
                    aria-label={`Reason for ${label}`}
                    className="h-[30px] text-sm"
                    autoComplete="off"
                    maxLength={REASON_MAX}
                    value={d.reason}
                    placeholder={`Why ${names.runner} needs this command…`}
                    onChange={(e) => set(i, { reason: e.target.value })}
                    onBlur={props.onBlur}
                  />
                )}
                {problem && (
                  <p id={`${id}-error`} className="m-0 flex items-start gap-[5px] text-xs text-destructive">
                    <CircleAlert aria-hidden className="mt-px size-[13px] shrink-0" />
                    {problem}
                  </p>
                )}
                {warning && (
                  <p id={`${id}-warning`} className="m-0 flex items-start gap-[5px] text-xs font-medium text-warn">
                    <TriangleAlert aria-hidden className="mt-px size-[13px] shrink-0" />
                    {warning}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p id={`${idPrefix}-help`} className="m-0 text-xs text-muted-foreground">
        One command per pattern. A * matches any text, such as the rest of the command. Git, a shell, and the {names.forge} and{" "}
        {names.tracker} hosts stay refused.
      </p>
      <div>
        <Button
          id={`${idPrefix}-add`}
          type="button"
          variant="outline"
          size="sm"
          disabled={drafts.length >= ALLOW_MAX}
          onClick={() => (props.onAdd ? props.onAdd(add) : add())}
        >
          <Plus data-icon="inline-start" />
          Add a pattern
        </Button>
      </div>
    </div>
  );
}

// kind warning: the first-use warning ("I understand"). kind any and unrestricted: the confirm of each switch to that mode. run: the
// confirmed action.
export type ShellAsk = { kind: "warning" | "any" | "unrestricted"; run: () => void };

// The confirmed action runs after the dialog has closed and the focus is back on the control that opened it. So an action that moves
// the focus, such as a new row, keeps that focus.
export function ShellDialog({ ask, onClose }: { ask: ShellAsk | null; onClose: () => void }) {
  const names = useShellNames();
  const pending = useRef<(() => void) | null>(null);
  const shown = useRef(ask);
  if (ask) shown.current = ask;
  const kind = shown.current?.kind ?? "warning";
  const text = {
    warning: { title: warningTitle(names), body: warningText(names), action: "I understand" },
    any: { title: ANY_TITLE, body: anyText(names), action: "Turn on Most commands" },
    unrestricted: { title: UNRESTRICTED_TITLE, body: unrestrictedText(names), action: "Turn on Unrestricted" },
  }[kind];
  return (
    <Dialog
      open={ask !== null}
      onOpenChange={(open) => !open && onClose()}
      onOpenChangeComplete={(open) => {
        const run = pending.current;
        pending.current = null;
        if (!open) run?.();
      }}
    >
      <DialogContent className="sm:max-w-[480px]" onKeyDown={dialogKeys(onClose)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert aria-hidden className="size-4 shrink-0 text-warn" />
            {text.title}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">{text.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={kind === "warning" ? "default" : "destructive"}
            onClick={() => {
              pending.current = ask?.run ?? null;
              onClose();
            }}
          >
            {text.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
