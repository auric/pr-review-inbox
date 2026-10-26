// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Tell box of the Task view (docs/plans/review-v2/spec.md section 6.18.1): free text that starts one change step. The app
// never reads the text for commands. The box has a secondary button only, so the state keeps its one primary action (AC-UX1).
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { MAX_INSTRUCTION } from "../../shared/task";

const count = (n: number) => n.toLocaleString("en-US");

// busy: a step, a check, or an update runs, so the box keeps its text and cannot send. restore: the text of a stopped send, which comes
// back once when the box is empty. onSend: POST /api/tasks/:id/instructions; it rejects with the sentence of a 409.
export function TellClaude(props: {
  runner: string;
  busy: boolean;
  restore: { id: number; text: string } | null;
  onSend: (text: string) => Promise<unknown>;
}) {
  const { runner } = props;
  const [text, setText] = useState(props.restore?.text ?? "");
  const [restored, setRestored] = useState(props.restore?.id ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = props.restore;
  if ((restore?.id ?? null) !== restored) {
    setRestored(restore?.id ?? null);
    if (restore && !text.trim()) setText(restore.text);
  }
  const size = text.trim().length;
  const over = size > MAX_INSTRUCTION;
  const busy = props.busy || sending;
  const canSend = !busy && size > 0 && !over;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await props.onSend(text.trim());
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      data-tell
      aria-labelledby="tell-label"
      className="grid max-w-[72ch] gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <Field className="gap-1.5">
        <FieldLabel id="tell-label" htmlFor="tell-text" className="text-sm font-semibold">
          Tell {runner}
        </FieldLabel>
        <Textarea
          id="tell-text"
          name="instructions"
          rows={3}
          autoComplete="off"
          spellCheck
          value={text}
          aria-invalid={over || undefined}
          aria-describedby="tell-hint tell-count"
          placeholder={`What should ${runner} change? For example: rename the flag to useNewParser.`}
          className="field-sizing-fixed resize-y bg-pane leading-normal"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <FieldDescription id="tell-hint" className="text-xs">
          {busy
            ? `${runner} or the checks are working. You can send when this step ends.`
            : `${runner} makes one change step. The app then runs the checks and its own review, and waits for you. Pushes and other git actions stay buttons.`}
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button type="submit" size="sm" variant="outline" disabled={!canSend} aria-keyshortcuts="Control+Enter" title="Key: Ctrl+Enter">
          {sending && <LoaderCircle aria-hidden data-icon="inline-start" className="motion-safe:animate-spin" />}
          Send to {runner}
        </Button>
        <span id="tell-count" className={cn("text-xs text-muted-foreground tabular-nums", over && "font-medium text-destructive")}>
          {size > 0 ? `${count(size)} of ${count(MAX_INSTRUCTION)} characters` : ""}
        </span>
      </div>
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
