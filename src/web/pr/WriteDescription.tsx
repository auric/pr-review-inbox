// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Write description: on an own open PR, the runner proposes a title and a description. The user edits them. Only the update posts.
import { LoaderCircle, PenLine } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import type { DescribeDto, RunDto } from "../../shared/dto";
import { MAX_PR_DESCRIPTION, MAX_PR_TITLE } from "../../shared/review";
import { useCancelRun } from "../review/data";
import { useSlots } from "../review/useSlots";
import { failText } from "../shell/model";
import { StaleDescription, useDescribe, useDiscardDescribe, useStartDescribe, useUpdateDescription } from "./describe";

// runner, forge: the product names from GET /api/meta.
export type DescribeProps = { pr: number; runner: string; forge: string; announce: (text: string) => void };

const linkish = "rl-hit inline-flex w-fit cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline";

// The button beside the Description heading. It starts a new run; a new result replaces the open proposal.
export function WriteDescriptionButton({ pr, runner, announce }: DescribeProps) {
  const q = useDescribe(pr);
  const start = useStartDescribe(pr);
  const { note: busy, refused } = useSlots(pr, runner, (run) => run === q.data?.run.id);
  const running = q.data?.run.status === "running";
  const fail = (description: string) => toast.add({ title: "Write description did not start", description });
  const begin = () => {
    if (start.isPending || running) return;
    if (busy) return void fail(busy);
    start.mutate(undefined, {
      onSuccess: (r) => {
        if ("conflict" in r) return void fail(refused(r.conflict));
        announce(`${runner} is writing the description.`);
      },
      onError: (e) => fail(failText(e)),
    });
  };
  return (
    <Button type="button" variant="outline" size="sm" disabled={start.isPending || running} onClick={begin}>
      <PenLine data-icon="inline-start" />
      Write description
    </Button>
  );
}

// The state of the newest describe run under the description: the run, its failure, or the proposal form.
export function DescribePanel({ pr, runner, forge, announce }: DescribeProps) {
  const d = useDescribe(pr).data;
  const cancel = useCancelRun();
  if (!d) return null;
  const { run } = d;
  if (run.status === "running")
    return (
      <p className="m-0 inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderCircle aria-hidden className="size-[14px] animate-spin motion-reduce:animate-none" />
        {runner} is writing the description…
        <button
          type="button"
          className={linkish}
          onClick={() => cancel.mutate(run.id, { onError: (e) => toast.add({ title: "Cancel failed", description: failText(e) }) })}
        >
          Cancel
        </button>
      </p>
    );
  if (run.status === "failed") return <FailedLine run={run} />;
  if (!d.result) return null;
  return (
    <DescribeForm
      key={run.id}
      pr={pr}
      d={d as DescribeDto & { result: NonNullable<DescribeDto["result"]> }}
      forge={forge}
      announce={announce}
    />
  );
}

function FailedLine({ run }: { run: RunDto }) {
  return (
    <Alert variant="destructive" className="max-w-[72ch]">
      <AlertDescription>Write description failed. {run.errorText ?? ""}</AlertDescription>
    </Alert>
  );
}

function DescribeForm(props: {
  pr: number;
  d: DescribeDto & { result: NonNullable<DescribeDto["result"]> };
  forge: string;
  announce: (text: string) => void;
}) {
  const { pr, d, forge, announce } = props;
  const [title, setTitle] = useState(d.result.title);
  const [description, setDescription] = useState(d.result.description);
  const [stale, setStale] = useState<string | null>(null);
  // The version of the PR text that the form opened on. A sync must not move it, else the PUT overwrites a newer text without a 409.
  const [version, setVersion] = useState(d.version);
  const update = useUpdateDescription(pr);
  const discard = useDiscardDescribe(pr);
  const empty = !title.trim();
  const busy = update.isPending || discard.isPending;
  const send = () => {
    if (busy || empty) return;
    if (version === null) return void setStale("Sync the pull request first.");
    setStale(null);
    update.mutate(
      { version, title: title.trim(), description, run: d.run.id },
      {
        onSuccess: () => announce(`Updated the title and the description on ${forge}.`),
        onError: (e) => {
          if (!(e instanceof StaleDescription))
            return void toast.add({ title: "The description was not updated", description: failText(e) });
          setStale(e.message);
          if (e.current) setVersion(e.current.version);
        },
      },
    );
  };
  return (
    <form
      aria-label="Proposed description"
      className="flex w-full max-w-[72ch] flex-col gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <FieldGroup className="gap-3">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="describe-title">Proposed title</FieldLabel>
          <Input
            id="describe-title"
            value={title}
            maxLength={MAX_PR_TITLE}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={empty}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="describe-text">Proposed description (Markdown)</FieldLabel>
          <Textarea
            id="describe-text"
            value={description}
            maxLength={MAX_PR_DESCRIPTION}
            rows={12}
            className="font-mono text-sm"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </FieldGroup>
      {stale && (
        <Alert variant="destructive">
          <AlertDescription>{stale}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || empty}>
          Update on {forge}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            discard.mutate(d.run.id, {
              onSuccess: () => announce("Discarded the proposed description."),
              onError: (e) => toast.add({ title: "The proposal was not discarded", description: failText(e) }),
            })
          }
        >
          Discard
        </Button>
      </div>
    </form>
  );
}
