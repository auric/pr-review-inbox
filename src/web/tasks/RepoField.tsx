// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The "Main repository" combobox of the Build form (docs/plans/review-v2/spec.md section 6.12). It follows the WAI-ARIA pattern of an
// editable combobox with a list, as BaseField does: the arrow keys move over the repositories, Enter picks one, and Esc closes the list.
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type RepoChoice, repoMatches } from "./model";

export function RepoField(props: {
  id: string;
  value: string;
  choices: RepoChoice[];
  // The state of the forge list: loading, an error, or a cut list. null: nothing to say.
  note: string | null;
  onPick: (key: string) => void;
}) {
  const { id, value, onPick } = props;
  const optId = (i: number) => `${id}-option-${i}`;
  // null: the list is closed.
  const [text, setText] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const open = text !== null;
  const { items, more } = repoMatches(props.choices, text ?? "");
  const at = Math.min(active, Math.max(0, items.length - 1));
  const note =
    [more ? `${more} more. Type to narrow the list.` : null, !items.length && text ? "No repository matches." : null, props.note]
      .filter(Boolean)
      .join(" ") || null;
  const shown = open && (items.length > 0 || note !== null);

  useEffect(() => {
    if (open) listRef.current?.querySelector(`#${id}-option-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [open, at, id]);

  const close = () => {
    setText(null);
    setActive(0);
  };
  const choose = (key: string) => {
    close();
    onPick(key);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setText("");
      if (items.length) setActive((at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter" && open) {
      // Enter in an open list picks the option and does not send the form.
      e.preventDefault();
      const r = items[at];
      if (r) choose(r.key);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className="relative">
      <Input
        ref={input}
        id={id}
        name="repository"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && items[at] ? optId(at) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search repositories…"
        className="h-8 pr-8 font-mono placeholder:font-sans"
        value={text ?? value}
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
        aria-label={open ? "Hide the repositories" : "Show the repositories"}
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
        <div className="absolute top-full left-0 z-20 mt-1 grid w-full gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {items.length > 0 && (
            <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Repositories" className="grid max-h-60 overflow-auto">
              {items.map((r, i) => (
                // The input keeps the focus: a press on an option does not move it. aria-activedescendant names the option.
                // biome-ignore lint/a11y/useKeyWithClickEvents: the arrow keys and Enter of the combobox pick an option.
                <div
                  key={r.key}
                  id={optId(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === at}
                  className={cn("flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-sm", i === at && "bg-sel")}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(r.key)}
                >
                  <Check aria-hidden className={cn("size-3.5 shrink-0", r.key !== value && "invisible")} />
                  <span translate="no" className="min-w-0 truncate font-mono text-[12.5px]">
                    {r.key}
                  </span>
                </div>
              ))}
            </div>
          )}
          {note && <p className="m-0 px-2 py-1 text-xs text-muted-foreground">{note}</p>}
        </div>
      )}
    </div>
  );
}
