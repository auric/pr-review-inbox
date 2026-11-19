// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Triage of drafts and questions (plan v3 WP14a, prototype/v3 acts, editor, mover): accept, edit, discard, restore, and move.
import { Check, CircleAlert, MoveVertical, Pencil, Undo2, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { DISCARD_REASONS, type DiscardReason, MAX_NOTE, type ReviewItemDto } from "../../shared/dto";
import { moveChoices } from "../../shared/review";
import { DISCARD_LABEL } from "./model";

export type TriageAction = "accept" | "discard" | "restore";
// The open triage control of one item.
export type TriageMode = "edit" | "move" | null;

export type TriageCtx = {
  // The local PR ID, for the key of an unsent edit.
  pr: number;
  act: (it: ReviewItemDto, action: TriageAction) => void;
  // null closes the editor or the line field.
  edit: (it: ReviewItemDto | null) => void;
  save: (it: ReviewItemDto, text: string) => void;
  move: (it: ReviewItemDto | null) => void;
  moveTo: (it: ReviewItemDto, line: number) => void;
  // Reply drafts only: the "Resolve after posting" tick.
  tick: (it: ReviewItemDto, on: boolean) => void;
  // A finding that the user discarded: the reason chip.
  reason: (it: ReviewItemDto, code: DiscardReason) => void;
  // true: the editor of this item opened again with its unsent text when the PR opened. It then leaves the focus where it is.
  quiet: (id: number) => boolean;
};

// Unsent edit text stays in localStorage under rl:edit:<pr>:<item> (plan pr-view-v4 section 5). Storage can be off or full.
// The editor then keeps the text in memory only.
const EDIT = "rl:edit:";
const editKey = (pr: number, id: number) => `${EDIT}${pr}:${id}`;
function readEdit(pr: number, id: number): string | null {
  try {
    return localStorage.getItem(editKey(pr, id));
  } catch {
    return null;
  }
}
// null removes the text.
export function writeEdit(pr: number, id: number, text: string | null) {
  try {
    if (text === null) localStorage.removeItem(editKey(pr, id));
    else localStorage.setItem(editKey(pr, id), text);
  } catch {}
}
// The item of one unsent edit of this PR, so its editor opens again. null: none.
export function storedEdit(pr: number): number | null {
  try {
    const p = `${EDIT}${pr}:`;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const id = k?.startsWith(p) ? Number(k.slice(p.length)) : 0;
      if (Number.isSafeInteger(id) && id > 0) return id;
    }
  } catch {}
  return null;
}

// Esc in a triage field closes only that field. The shell key handler never sees it.
function onEscape(e: KeyboardEvent, close: () => void) {
  if (e.key !== "Escape") return false;
  e.preventDefault();
  e.stopPropagation();
  close();
  return true;
}

// prototype/v3 acts(), pr-view-v4 drafts(). Each button names its key in the tooltip.
// flush: no indent under an avatar, as in the open rows of the Drafts section. lead: a button after the triage buttons, before Move.
// lead and children show only on an item that is not discarded. always: the last control, also on a discarded item. stale: an
// out-of-date reply draft. items.ts refuses Accept and Edit for it, so only Discard or Undo accept shows. noPost: a pre-existing
// finding. items.ts refuses Accept and Edit for it, and a place change has no use, so only Discard shows.
export function Acts(props: {
  it: ReviewItemDto;
  busy: boolean;
  flush?: boolean;
  stale?: boolean;
  noPost?: boolean;
  ctx: TriageCtx;
  lead?: ReactNode;
  children?: ReactNode;
  always?: ReactNode;
}) {
  const { it, busy, ctx } = props;
  const locked = props.stale || props.noPost;
  const edit = !locked && (
    <Button size="sm" variant="outline" disabled={busy} title="Key: e" aria-keyshortcuts="e" onClick={() => ctx.edit(it)}>
      <Pencil aria-hidden data-icon="inline-start" />
      Edit
    </Button>
  );
  const row = cn("mt-2.5 flex flex-wrap items-center gap-1.5", !props.flush && "rl-indent");
  if (it.status === "discarded") {
    // items.ts refuses Restore for a finding without an anchor: a re-review found its code gone.
    if (it.kind === "finding" && !it.anchor) return null;
    return (
      <div className={row}>
        <Button size="sm" variant="outline" disabled={busy} title="Key: d" aria-keyshortcuts="d" onClick={() => ctx.act(it, "restore")}>
          <Undo2 aria-hidden data-icon="inline-start" />
          Restore
        </Button>
        {props.always}
      </div>
    );
  }
  const move = !props.noPost && it.kind === "finding" && it.anchor && (
    <button
      type="button"
      disabled={busy}
      aria-label={`Move to another line. Now line ${it.anchor.line}.`}
      title="Move to another line"
      className="rl-hit ml-1 inline-flex cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground hover:underline disabled:cursor-default"
      onClick={() => ctx.move(it)}
    >
      <MoveVertical aria-hidden className="size-[13px]" />
      Move
    </button>
  );
  return (
    <div className={row}>
      {it.status === "accepted" ? (
        <>
          {edit}
          <Button size="sm" variant="outline" disabled={busy} title="Key: a" aria-keyshortcuts="a" onClick={() => ctx.act(it, "restore")}>
            <Undo2 aria-hidden data-icon="inline-start" />
            Undo accept
          </Button>
        </>
      ) : (
        <>
          {!locked && (
            <Button size="sm" variant="outline" disabled={busy} title="Key: a" aria-keyshortcuts="a" onClick={() => ctx.act(it, "accept")}>
              <Check aria-hidden data-icon="inline-start" />
              Accept
            </Button>
          )}
          {edit}
          <Button size="sm" variant="outline" disabled={busy} title="Key: d" aria-keyshortcuts="d" onClick={() => ctx.act(it, "discard")}>
            <X aria-hidden data-icon="inline-start" />
            Discard
          </Button>
        </>
      )}
      {props.lead}
      {move}
      {props.children}
      {props.always}
    </div>
  );
}

// A discarded item folds to one muted line with Restore (prototype/v3 draft, question).
export function RestoreButton({ it, busy, ctx }: { it: ReviewItemDto; busy: boolean; ctx: TriageCtx }) {
  return (
    <button
      type="button"
      disabled={busy}
      title="Key: d"
      aria-keyshortcuts="d"
      className="rl-hit mr-1 inline-flex flex-none cursor-pointer items-center gap-1 rounded px-1 text-sm font-medium text-pen hover:underline disabled:cursor-default"
      onClick={() => ctx.act(it, "restore")}
    >
      <Undo2 aria-hidden className="size-[15px]" />
      Restore
    </button>
  );
}

// docs/plans/review-v2/spec.md section 4.1: after a discard, the card offers the reason chips. No chip is required.
export function ReasonChips({ it, busy, ctx }: { it: ReviewItemDto; busy: boolean; ctx: TriageCtx }) {
  const now = it.payload.discardReason?.code;
  return (
    <fieldset data-reason-chips className="m-0 flex flex-wrap items-center gap-1.5 border-0 px-1.5 pb-2.5 pl-[30px]">
      <legend className="float-left mr-1 text-xs text-muted-foreground">Why? Optional.</legend>
      {DISCARD_REASONS.map((code) => (
        <Button
          key={code}
          size="xs"
          variant={now === code ? "secondary" : "outline"}
          aria-pressed={now === code}
          disabled={busy}
          onClick={() => ctx.reason(it, code)}
        >
          {DISCARD_LABEL[code]}
        </Button>
      ))}
    </fieldset>
  );
}

// Saving binds the approval to the new text: an edit always accepts the item (prototype/v3 saveEdit).
// The unsent text survives Back and a change of PR. Save, Cancel, and each other triage action clear it.
export function Editor({ it, busy, flush, ctx }: { it: ReviewItemDto; busy: boolean; flush?: boolean; ctx: TriageCtx }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [initial] = useState(() => readEdit(ctx.pr, it.id) ?? it.body);
  // The whole editor comes into view, so its buttons do too.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta || ctx.quiet(it.id)) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    box.current?.scrollIntoView({ block: "nearest" });
  }, [ctx, it.id]);
  const cancel = () => {
    writeEdit(ctx.pr, it.id, null);
    ctx.edit(null);
  };
  const save = () => {
    const v = ref.current?.value.trim() ?? "";
    if (!v) {
      toast.add({ title: `The text is empty. Discard the ${it.kind} instead.` });
      return;
    }
    ctx.save(it, v);
  };
  const id = `edit-${it.id}`;
  return (
    <div ref={box} className={cn("mt-1 max-w-[72ch]", !flush && "rl-indent")}>
      <label className="sr-only" htmlFor={id}>
        Edit the {it.kind}
      </label>
      <Textarea
        ref={ref}
        id={id}
        rows={6}
        maxLength={MAX_NOTE}
        spellCheck
        defaultValue={initial}
        className="field-sizing-fixed min-h-[9em] resize-y bg-pane leading-normal"
        onChange={(e) => writeEdit(ctx.pr, it.id, e.target.value === it.body ? null : e.target.value)}
        onKeyDown={(e) => {
          if (onEscape(e, cancel)) return;
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <Button size="sm" disabled={busy} aria-keyshortcuts="Control+Enter" title="Key: Ctrl+Enter" onClick={save}>
          <Check aria-hidden data-icon="inline-start" />
          Save and accept
        </Button>
        <Button size="sm" variant="outline" title="Key: Esc" onClick={cancel}>
          Cancel
        </Button>
        <span className="ml-1 text-xs text-muted-foreground">Ctrl+Enter saves. Esc cancels.</span>
      </div>
    </div>
  );
}

// prototype/v3 mover(): the new line must be in the excerpt, so the comment quotes the code you see.
export function Mover({ it, busy, ctx }: { it: ReviewItemDto; busy: boolean; ctx: TriageCtx }) {
  const a = it.anchor;
  const ok = a ? moveChoices(a.excerpt, a.side) : [];
  const [v, setV] = useState(String(a?.line ?? ""));
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  if (!a || !ok.length) return null;
  const go = () => {
    const n = Number(v);
    if (!ok.includes(n)) {
      setErr(`Line ${v.trim() || "?"} is not in the excerpt. Choose a line from ${ok[0]} to ${ok.at(-1)}.`);
      ref.current?.focus();
      return;
    }
    if (n === a.line && n === a.lineEnd) ctx.move(null);
    else ctx.moveTo(it, n);
  };
  const id = `mv-${it.id}`;
  return (
    <>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
        <MoveVertical aria-hidden className="size-[13px] text-muted-foreground" />
        <label htmlFor={id}>Line</label>
        <Input
          ref={ref}
          id={id}
          type="number"
          inputMode="numeric"
          min={ok[0]}
          max={ok.at(-1)}
          value={v}
          aria-invalid={err ? true : undefined}
          aria-describedby={cn(err && `${id}-err`, `${id}-h`)}
          className="h-7 w-[8ch] bg-pane px-1.5 font-mono"
          onChange={(e) => {
            setV(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => {
            if (onEscape(e, () => ctx.move(null))) return;
            if (e.key === "Enter") {
              e.preventDefault();
              go();
            }
          }}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={go}>
          Move
        </Button>
        <Button size="sm" variant="outline" title="Key: Esc" onClick={() => ctx.move(null)}>
          Cancel
        </Button>
        <span id={`${id}-h`} className="ml-1 text-xs text-muted-foreground">
          Lines {ok[0]} to {ok.at(-1)} of the excerpt. Esc cancels.
        </span>
      </div>
      {err && (
        <p id={`${id}-err`} role="alert" className="m-0 mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
          <CircleAlert aria-hidden className="size-[13px] shrink-0" />
          {err}
        </p>
      )}
    </>
  );
}
