// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The branch part of the plan approval (docs/plans/review-v2/spec.md sections 6.16.1 to 6.16.4): the "Branch type" chips of
// Settings > Tasks plus "Other…", the planned name, the "Base branch" combobox, and the choice for a name that exists on the server.
// A task with several repositories gets one BaseField per repository in the repository list (PlanTab.tsx RepoSection).
// The chips are native radios, so the arrow keys move over them. The combobox follows the WAI-ARIA pattern of an editable combobox with
// a list: the arrow keys move over the branches, Enter picks one, and Esc closes the list.
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { BranchCheckDto, TaskDto } from "../../shared/dto";
import { PREFIX_MAX, type TaskSize } from "../../shared/task";
import { dialogKeys } from "../fix/CloneDialog";
import { usePrs } from "../shell/data";
import { useBranches } from "./data";
import { type BranchPick, branchesError, branchNote, pickedPrefix, plannedBranch, prefixProblem } from "./model";

// The selected chip shows by its fill and its weight, not by color alone.
const chip =
  "flex min-h-6 cursor-pointer items-center rounded-md px-2.5 py-0.5 text-sm text-ink-2 hover:text-foreground has-checked:bg-sel has-checked:font-semibold has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring";
const radio = "m-0 mt-[3px] size-4 accent-foreground";

export type BranchCheck = { checked: string | null; data: BranchCheckDto | undefined; error: Error | null; refetch: () => unknown };

export function BranchSection(props: {
  t: TaskDto;
  size: TaskSize;
  // undefined while Settings loads. error: Settings did not load.
  prefixes: string[] | undefined;
  error: Error | null;
  pick: BranchPick | null;
  check: BranchCheck;
  onPick: (p: BranchPick) => void;
  onBase: (branch: string) => Promise<unknown>;
  // false: the task has several repositories, so the repository list holds the base pickers (PlanTab.tsx RepoSection).
  base?: boolean;
}) {
  const { t, size, pick, check } = props;
  const prs = usePrs();
  const prefix = pick && pickedPrefix(pick);
  const name = prefix !== null && prefixProblem(prefix) === null ? plannedBranch(prefix, t, size) : null;
  const typed = pick?.chip === null && pick.other ? prefixProblem(pick.other) : null;
  const small = size === "small";
  const lead = small ? "The change goes to" : "The branches of this task start with";
  // The check of the picked prefix. A typed prefix reaches it after the wait, so a check of an earlier prefix shows nothing.
  const current = check.checked !== null && check.checked === prefix;
  const found = current && check.data?.exists.length ? check.data : null;
  const prId = found?.openPr != null ? (prs.data?.find((p) => p.id === found.openPr)?.prId ?? null) : null;
  return (
    <FieldSet className="gap-3">
      <FieldLegend className="text-sm font-semibold">Branch</FieldLegend>
      {props.error ? (
        <p role="alert" className="m-0 text-sm text-destructive">
          Cannot read the branch prefixes. {props.error.message}
        </p>
      ) : !props.prefixes || !pick ? (
        <Skeleton className="h-6 w-72 max-w-full" />
      ) : (
        <div className="grid gap-1.5">
          <span id="task-type" className="text-sm text-ink-2">
            Branch type
          </span>
          <div
            role="radiogroup"
            aria-labelledby="task-type"
            className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg border bg-pane p-0.5"
          >
            {props.prefixes.map((p) => (
              <label key={p} className={chip}>
                <input
                  type="radio"
                  name="task-branch-type"
                  value={p}
                  className="sr-only"
                  checked={pick.chip === p}
                  onChange={() => props.onPick({ ...pick, chip: p })}
                />
                <span translate="no" className="font-mono text-[12.5px]">
                  {p}
                </span>
              </label>
            ))}
            <label className={chip}>
              <input
                type="radio"
                name="task-branch-type"
                value=""
                className="sr-only"
                checked={pick.chip === null}
                onChange={() => props.onPick({ ...pick, chip: null })}
              />
              Other…
            </label>
          </div>
          {pick.chip === null && (
            <Field data-invalid={typed ? true : undefined} className="mt-1 max-w-sm gap-1.5">
              <FieldLabel htmlFor="task-prefix">Prefix</FieldLabel>
              <Input
                id="task-prefix"
                name="branchPrefix"
                autoComplete="off"
                spellCheck={false}
                maxLength={PREFIX_MAX}
                placeholder="task/"
                aria-invalid={typed ? true : undefined}
                aria-describedby={typed ? "task-prefix-error" : "task-prefix-help"}
                className="h-8 font-mono"
                value={pick.other}
                onChange={(e) => props.onPick({ ...pick, other: e.target.value })}
                onKeyDown={(e) => {
                  // Enter in this field does not approve the plan.
                  if (e.key === "Enter") e.preventDefault();
                }}
              />
              {typed ? (
                <FieldError id="task-prefix-error">{typed}</FieldError>
              ) : (
                <FieldDescription id="task-prefix-help">For example task/ or users/ada/. It applies to this task only.</FieldDescription>
              )}
            </Field>
          )}
        </div>
      )}
      {name !== null && (
        <div className="grid gap-1">
          <p className="m-0 text-sm">
            <span className="text-ink-2">{lead}</span>{" "}
            <code id="task-branch" translate="no" className="font-mono text-[13px] font-semibold [overflow-wrap:anywhere]">
              {name}
            </code>
          </p>
          {/* The name for screen readers, after the typing wait, so each key does not interrupt. The existing-branch choice shows
              later, so the line names it too. */}
          <p role="status" className="sr-only">
            {check.checked !== null && prefixProblem(check.checked) === null
              ? `${lead} ${plannedBranch(check.checked, t, size)}.${found ? " It already exists on the server." : ""}`
              : ""}
          </p>
          {current && check.error && (
            <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
              <span>Cannot check the server for this branch. {check.error.message} The app checks again before the first push.</span>
              <Button type="button" variant="outline" size="xs" onClick={() => check.refetch()}>
                Try again
              </Button>
            </p>
          )}
        </div>
      )}
      {found && pick && (
        <div role="radiogroup" aria-labelledby="task-exists" className="grid gap-1 rounded-md border bg-card px-3 py-2.5">
          <p id="task-exists" className="m-0 text-sm font-medium">
            <code translate="no" className="font-mono text-[13px] [overflow-wrap:anywhere]">
              {found.name}
            </code>{" "}
            already exists on the server.
          </p>
          {/* The label holds the radio and its text, so the row has no dead zone. The hint stays out of the radio name. */}
          <div className="-mx-1.5 grid gap-0.5 rounded-[5px] px-1.5 py-1 hover:bg-hover">
            <label className="flex min-h-6 cursor-pointer items-start gap-2 text-sm [overflow-wrap:anywhere]">
              <input
                type="radio"
                name="task-existing"
                className={radio}
                checked={pick.existing === "continue"}
                aria-describedby="task-existing-continue-help"
                onChange={() => props.onPick({ ...pick, existing: "continue" })}
              />
              <span className="min-w-0">
                Continue on{" "}
                <span translate="no" className="font-mono text-[13px]">
                  {found.name}
                </span>
              </span>
            </label>
            <p id="task-existing-continue-help" className="m-0 pl-6 text-xs text-muted-foreground">
              Build on top of its commits. The app never overwrites them.
              {found.openPr !== null &&
                (prId !== null ? ` PR #${prId} from this branch stays the PR of this task.` : " Its open PR stays the PR of this task.")}
            </p>
          </div>
          <label className="-mx-1.5 flex min-h-6 cursor-pointer items-start gap-2 rounded-[5px] px-1.5 py-1 text-sm [overflow-wrap:anywhere] hover:bg-hover">
            <input
              type="radio"
              name="task-existing"
              className={radio}
              checked={pick.existing === "new"}
              onChange={() => props.onPick({ ...pick, existing: "new" })}
            />
            <span className="min-w-0">
              Start a new branch (
              <span translate="no" className="font-mono text-[13px]">
                {found.nextFree}
              </span>
              )
            </span>
          </label>
        </div>
      )}
      {props.base !== false && (
        <BaseField
          id="task-base"
          project={t.project}
          repo={t.repo}
          base={t.targetBranch}
          help="The task branch starts here, and the PR goes into it."
          onBase={props.onBase}
        />
      )}
    </FieldSet>
  );
}

// spec.md section 6.16.3: the base branch combobox of one repository. The closed field shows the base. A pick other than the base asks
// one confirm, because the plan exists on this screen. name: the repository for screen readers and the confirm, when the screen lists
// several. gone: "Pick a base branch" of the pre-flight (spec.md section 6.16.7), whose base no longer exists and whose plan stays.
export function BaseField(props: {
  id: string;
  project: string;
  repo: string;
  base: string;
  name?: string;
  help?: string;
  gone?: boolean;
  onBase: (branch: string) => Promise<unknown>;
}) {
  const { id, base, onBase } = props;
  const optId = (i: number) => `${id}-option-${i}`;
  // null: the list is closed.
  const [text, setText] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [to, setTo] = useState<{ branch: string; key: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const q = useBranches(props.project, props.repo, text ?? "");
  const open = text !== null;
  const items = q.data?.branches ?? [];
  const at = Math.min(active, Math.max(0, items.length - 1));
  const note = q.data ? branchNote(q.data, q.data.filter) : q.isPending ? "Reading the branches…" : null;
  const shown = open && (items.length > 0 || note !== null);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`#${id}-option-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [open, at, id]);

  const close = () => {
    setText(null);
    setActive(0);
  };
  // key: the keyboard picked it, so the confirm opens with no animation.
  const choose = (branch: string, key: boolean) => {
    close();
    if (branch === base) return;
    setError(null);
    setTo({ branch, key });
  };
  const confirm = async () => {
    if (!to) return;
    setBusy(true);
    setError(null);
    try {
      // 202: the plan goes, and this screen closes with it.
      await onBase(to.branch);
      setTo(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setText("");
      if (items.length) setActive((at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter") {
      // Enter in this field does not approve the plan.
      e.preventDefault();
      const b = open ? items[at] : undefined;
      if (b) choose(b.name, true);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id}>Base branch{props.name && <span className="sr-only"> of {props.name}</span>}</FieldLabel>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="relative w-full max-w-[44ch]">
          <Input
            ref={input}
            id={id}
            name="baseBranch"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={open && items[at] ? optId(at) : undefined}
            aria-describedby={props.help ? `${id}-help` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search branches…"
            className="h-8 pr-8 font-mono placeholder:font-sans"
            value={text ?? base}
            onFocus={(e) => e.currentTarget.select()}
            onClick={() => {
              if (!open) setText("");
            }}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
            }}
            onBlur={close}
            onKeyDown={keys}
          />
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? "Hide the branches" : "Show the branches"}
            className="absolute inset-y-0 right-0 grid w-8 cursor-pointer place-items-center rounded-r-lg text-ink-2 hover:text-foreground"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (open) close();
              else setText("");
              input.current?.focus();
            }}
          >
            <ChevronDown aria-hidden className="size-4" />
          </button>
          {shown && (
            <div className="absolute top-full left-0 z-20 mt-1 grid w-full min-w-[16rem] gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
              {items.length > 0 && (
                <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Branches" className="grid max-h-60 overflow-auto">
                  {items.map((b, i) => (
                    // The input keeps the focus: a press on an option does not move it. aria-activedescendant names the option.
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the arrow keys and Enter of the combobox pick an option.
                    <div
                      key={b.name}
                      id={optId(i)}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === at}
                      className={cn("flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-sm", i === at && "bg-sel")}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setActive(i)}
                      onClick={() => choose(b.name, false)}
                    >
                      <Check aria-hidden className={cn("size-3.5 shrink-0", b.name !== base && "invisible")} />
                      <span translate="no" className="min-w-0 truncate font-mono text-[12.5px]">
                        {b.name}
                      </span>
                      {b.isDefault && <span className="shrink-0 text-xs text-muted-foreground">(default)</span>}
                      {b.name === base && <span className="sr-only">, the base now</span>}
                    </div>
                  ))}
                </div>
              )}
              {note && <p className="m-0 px-2 py-1 text-xs text-muted-foreground">{note}</p>}
            </div>
          )}
        </div>
        {q.data?.defaultBranch === base && <span className="text-xs text-muted-foreground">(default)</span>}
      </div>
      {props.help && <FieldDescription id={`${id}-help`}>{props.help}</FieldDescription>}
      {q.error && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-destructive">
          <span>{branchesError(q.error.message, props.project, props.repo)}</span>
          <Button type="button" variant="outline" size="xs" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </p>
      )}
      <Dialog
        open={to !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setTo(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]" instant={to?.key} finalFocus={input} onKeyDown={dialogKeys(() => !busy && setTo(null))}>
          <DialogHeader>
            {props.gone ? (
              <>
                <DialogTitle>
                  Build on <span translate="no">{to?.branch}</span>?
                </DialogTitle>
                <DialogDescription>
                  <span translate="no">{base}</span> no longer exists{props.name && <> in {props.name}</>}. The plan stays. Commits of the
                  task move onto <span translate="no">{to?.branch}</span> when you update the branch before the PR.
                </DialogDescription>
              </>
            ) : (
              <>
                <DialogTitle>
                  The plan was written on <span translate="no">{base}</span>. Write it again on <span translate="no">{to?.branch}</span>?
                </DialogTitle>
                <DialogDescription>
                  {props.name && (
                    <>
                      The base of <span translate="no">{props.name}</span> changes.{" "}
                    </>
                  )}
                  The plan starts again. Your answers stay.
                </DialogDescription>
              </>
            )}
          </DialogHeader>
          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setTo(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void confirm()}>
              {busy ? "Starting…" : error ? "Try again" : props.gone ? `Use ${to?.branch ?? ""}` : "Write the plan again"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Field>
  );
}
