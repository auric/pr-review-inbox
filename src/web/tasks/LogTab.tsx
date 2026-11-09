// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Log tab (docs/plans/review-v2/spec.md sections 6.7 and 6.12): the steps, newest first, with their commands, exit codes or time
// limits, the output tails folded (a running command shows its output so far), the saved patch, the commands that the runner ran and the commands that it asked to allow (section 6.21.6), and a
// link to the run log of each step with a run (RunLog.tsx). A send of the Tell box is one
// group "Your instructions" with its text, its result, and its steps inside (section 6.18.1).
import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, LoaderCircle, ScrollText } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskDto, TaskStepDto } from "../../shared/dto";
import { limitText, type StepDetail } from "../../shared/task";
import { DECIDED_TEXT, shellText } from "./allow";
import { logRows, type SendGroup, STEP_TEXT, type StepLook, sendResult, stepLook } from "./model";

const KIND: Record<TaskStepDto["kind"], string> = {
  interview: "Questions",
  spec: "Plan",
  tests: "Tests",
  implement: "Code",
  check: "Checks",
  fix: "Fix",
  review: "Own review",
  commit: "Commit",
  push: "Push",
  pr: "Pull request",
  retarget: "New target",
  rebase: "Rebase",
  replan: "Plan again",
  question: "Question",
  spec_change: "Plan change",
  size: "Line limit",
  instruct: "Your instructions",
  update: "Update from the base",
  resolve: "Conflicts",
};

const ICON: Record<StepLook, { icon: typeof CircleCheck; className?: string }> = {
  ok: { icon: CircleCheck },
  failed: { icon: CircleAlert, className: "text-destructive" },
  expected: { icon: CircleCheck },
  before: { icon: CircleAlert, className: "text-warn" },
  running: { icon: LoaderCircle, className: "motion-safe:animate-spin" },
  waiting: { icon: CircleDashed },
  cancelled: { icon: CircleMinus },
  skipped: { icon: CircleMinus },
};

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

export const stepId = (id: number) => `task-step-${id}`;

// onDiff: opens the Diff tab, absent while the part has no commit.
export function LogTab({
  t,
  runner,
  onRunLog,
  onDiff,
}: {
  t: TaskDto;
  runner: string;
  onRunLog: (run: number) => void;
  onDiff?: () => void;
}) {
  if (!t.steps.length) return <p className="m-0 text-sm text-muted-foreground">No step has run yet.</p>;
  return (
    <ol aria-label="Steps, newest first" className="m-0 grid list-none gap-2 p-0">
      {logRows(t.steps).map((r) =>
        "send" in r ? (
          <SendRow key={r.send.id} g={r} runner={runner} onRunLog={onRunLog} onDiff={onDiff} />
        ) : (
          <li
            key={r.step.id}
            id={stepId(r.step.id)}
            data-task-item
            tabIndex={-1}
            className="grid gap-1.5 rounded-md border bg-card px-3 py-2 outline-offset-2 focus-visible:outline-2"
          >
            <StepBody s={r.step} runner={runner} onRunLog={onRunLog} />
          </li>
        ),
      )}
    </ol>
  );
}

// spec.md section 6.18.1, Step history: the time, the text as plain text (3 lines, then "Show all"), the result, and the steps.
function SendRow({ g, runner, onRunLog, onDiff }: { g: SendGroup; runner: string; onRunLog: (run: number) => void; onDiff?: () => void }) {
  const s = g.send;
  const result = sendResult(g, runner);
  const end = s.detail.instruct?.result;
  const failed = end === "failed";
  const open = [s, ...g.steps].some((x) => x.state === "running" || x.state === "waiting");
  const look: StepLook = end === "stopped" ? "cancelled" : failed ? "failed" : end ? "ok" : open ? "running" : stepLook(s);
  const Icon = ICON[look].icon;
  const at = new Date(s.startedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <li
      id={stepId(s.id)}
      data-task-item
      data-send={s.id}
      tabIndex={-1}
      className="grid gap-2 rounded-md border bg-card px-3 py-2 outline-offset-2 focus-visible:outline-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Icon aria-hidden className={cn("size-4 shrink-0", ICON[look].className)} />
        <span className="font-semibold">{KIND.instruct}</span>
        <time dateTime={new Date(s.startedAt).toISOString()} className="text-xs text-muted-foreground">
          {at}
        </time>
        {s.run !== null && (
          <Button variant="ghost" size="xs" className="ml-auto" onClick={() => onRunLog(s.run as number)}>
            <ScrollText aria-hidden data-icon="inline-start" />
            Run log
          </Button>
        )}
      </div>
      <SendText text={s.detail.instruct?.text ?? ""} />
      <p className={cn("m-0 text-sm", failed ? "text-destructive" : "text-ink-2")}>{result}</p>
      {s.detail.notes
        .filter((n) => n !== result)
        .map((n) => (
          <p key={n} className="m-0 text-xs whitespace-pre-wrap text-ink-2">
            {n}
          </p>
        ))}
      {g.steps.length > 0 && (
        <ol aria-label="Steps of these instructions, newest first" className="m-0 grid list-none gap-1.5 border-l-2 py-0.5 pl-3">
          {g.steps.map((x) => (
            <li key={x.id} id={stepId(x.id)} tabIndex={-1} className="grid gap-1.5 outline-offset-2 focus-visible:outline-2">
              <StepBody s={x} runner={runner} onRunLog={onRunLog} onDiff={x.kind === "commit" ? onDiff : undefined} />
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

// The text of a send as the user wrote it: 3 lines, then "Show all" when it has more.
function SendText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [all, setAll] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const p = ref.current;
    if (p && !all) setLong(p.scrollHeight > p.clientHeight + 1);
  }, [all]);
  return (
    <div className="grid justify-items-start gap-0.5">
      <p ref={ref} className={cn("m-0 max-w-[72ch] text-sm whitespace-pre-wrap [overflow-wrap:anywhere]", !all && "line-clamp-3")}>
        {text}
      </p>
      {(long || all) && (
        <Button variant="link" size="xs" className="h-auto px-0" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  );
}

function StepBody({
  s,
  runner,
  onRunLog,
  onDiff,
}: {
  s: TaskStepDto;
  runner: string;
  onRunLog: (run: number) => void;
  onDiff?: () => void;
}) {
  const look = stepLook(s);
  const st = ICON[look];
  const Icon = st.icon;
  const d = s.detail;
  const ms = s.endedAt === null ? null : s.endedAt - s.startedAt;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Icon aria-hidden className={cn("size-4 shrink-0", st.className)} />
        <span className="font-semibold">{KIND[s.kind]}</span>
        {s.item && (
          <code translate="no" className="font-mono text-xs text-ink-2">
            {s.item}
          </code>
        )}
        <span className={cn("text-ink-2", look === "failed" && "text-destructive")}>{STEP_TEXT[look]}</span>
        {s.attempt > 1 && <span className="text-xs text-muted-foreground">try {s.attempt}</span>}
        {ms !== null && <span className="text-xs text-muted-foreground">{seconds(ms)}</span>}
        {(s.run !== null || onDiff) && (
          <span className="ml-auto flex gap-1">
            {onDiff && (
              <Button variant="ghost" size="xs" onClick={onDiff}>
                Show the diff
              </Button>
            )}
            {s.run !== null && (
              <Button variant="ghost" size="xs" onClick={() => onRunLog(s.run as number)}>
                <ScrollText aria-hidden data-icon="inline-start" />
                Run log
              </Button>
            )}
          </span>
        )}
      </div>
      {d.baseline && (
        <p className="m-0 text-xs text-ink-2">
          The approved checks on the part base, before the first step of {runner}. The fix steps compare with this run.
        </p>
      )}
      {d.diffStat && (
        <p className="m-0 text-xs text-ink-2">
          {d.diffStat.files} {d.diffStat.files === 1 ? "file" : "files"}, +{d.diffStat.added} −{d.diffStat.removed}
        </p>
      )}
      {d.commands.map((c, i) => {
        // A row of a step that ended while the command ran, such as at an app restart, shows "stopped".
        const live = c.running && look === "running";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: commands run in their stored order and never move.
          <details key={i} data-command={live ? "running" : undefined} className="rounded-[5px] border bg-pane px-2 py-1 text-xs">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium">{c.name}</span>
              <code translate="no" className="font-mono [overflow-wrap:anywhere] text-ink-2">
                {c.argv.join(" ")}
              </code>
              <span className={cn(!live && c.exit !== 0 && look !== "expected" && "font-semibold text-destructive")}>
                {live
                  ? "running"
                  : (c.notRun ??
                    (c.timedOut && c.timeoutSec !== null
                      ? `time limit ${limitText(c.timeoutSec)}`
                      : c.exit === null
                        ? "stopped"
                        : `exit ${c.exit}`))}
              </span>
              <span className="text-muted-foreground">{seconds(c.ms)}</span>
            </summary>
            <pre translate="no" className="m-0 mt-1 max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
              {c.tail.trimEnd() || (live ? "(no output yet)" : "(no output)")}
            </pre>
          </details>
        );
      })}
      {d.shell && <ShellRows shell={d.shell} runner={runner} />}
      {d.allowAsk && (
        <div className="grid gap-0.5 text-xs text-ink-2">
          <p className="m-0">{runner} asked to allow:</p>
          <ul aria-label={`Commands that ${runner} asked to allow`} className="m-0 grid list-none gap-0.5 p-0">
            {d.allowAsk.requests.map((r) => {
              const c = d.allowAsk?.decisions.find((x) => x.pattern === r.pattern)?.choice;
              return (
                <li key={r.pattern} data-allow-decision={c ?? "open"} className="[overflow-wrap:anywhere]">
                  <code translate="no" className="font-mono text-foreground">
                    {r.pattern}
                  </code>
                  :{" "}
                  <span className={cn(c === "refuse" && "font-medium text-destructive")}>
                    {c ? DECIDED_TEXT[c] : "waiting for your choice"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {d.findings.length > 0 && (
        <p className="m-0 text-xs text-ink-2">
          {d.findings.length} {d.findings.length === 1 ? "point" : "points"} in the review
        </p>
      )}
      {d.deniedPaths.length > 0 && (
        <p className="m-0 text-xs text-ink-2">
          Files the app does not commit:{" "}
          <span translate="no" className="font-mono [overflow-wrap:anywhere]">
            {d.deniedPaths.join(", ")}
          </span>
        </p>
      )}
      {d.specChange && (
        <p className="m-0 text-xs text-ink-2">
          Changed plan files:{" "}
          <span translate="no" className="font-mono">
            {d.specChange.paths.join(", ")}
          </span>
        </p>
      )}
      {d.patch && (
        <p className="m-0 text-xs text-ink-2">
          The changes of this step are saved in{" "}
          <code translate="no" className="font-mono [overflow-wrap:anywhere]">
            {d.patch}
          </code>
        </p>
      )}
      {d.notes.map((n) => (
        <p key={n} className="m-0 text-xs whitespace-pre-wrap text-ink-2">
          {n}
        </p>
      ))}
    </>
  );
}

// spec.md section 6.21.6: the mode of a runner step with the Bash tool, and the commands that the runner ran, folded. The run log holds the
// end of the output of each command.
function ShellRows({ shell, runner }: { shell: NonNullable<StepDetail["shell"]>; runner: string }) {
  const n = shell.commands.length;
  return (
    <div data-step-shell className="grid gap-1">
      <p className={cn("m-0 text-xs", shell.mode === "allowlist" ? "text-ink-2" : "font-medium text-warn")}>
        {shellText(shell.mode, shell.rules.length, shell.checks.length)}
        {shell.refused > 0 && `. Refused: ${shell.refused}`}
      </p>
      {n > 0 && (
        <details className="rounded-[5px] border bg-pane px-2 py-1 text-xs">
          <summary className="cursor-pointer font-medium">
            Commands {runner} ran ({n})
          </summary>
          <ol className="m-0 mt-1 grid list-none gap-1 p-0">
            {shell.commands.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the commands keep their run order and never move.
              <li key={i} data-shell-command={c.state} className="flex flex-wrap items-baseline gap-x-2">
                <code translate="no" className="min-w-0 font-mono [overflow-wrap:anywhere]">
                  {c.command}
                </code>
                <span className={cn(c.state === "ok" ? "text-ink-2" : "font-semibold text-destructive")}>{c.state}</span>
                <span className="text-muted-foreground">{seconds(c.ms)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
