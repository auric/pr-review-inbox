// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The plan approval (docs/plans/review-v2/spec.md sections 6.1, 6.4, 6.8, 6.12, and 6.16): the size with its one-line meaning and the
// rule lines, the branch (BranchSection.tsx), the approved commands with the first-use warning, and the map check line. The header
// button "Approve the plan" submits this form.
// PlanParts is the Plan tab: the parts with their state in plain words, the tasks with check marks, and the lines against the limit.
import { Check, Circle } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import type { TaskDto, TaskPlanInput } from "../../shared/dto";
import { PART_STATE_TEXT, sizeRank, TASK_SIZES, type TaskCommand, type TaskSize } from "../../shared/task";
import { useSettings } from "../shell/data";
import { BranchSection } from "./BranchSection";
import { CommandsEditor } from "./CommandsEditor";
import { type CommandDraft, draftProblem, draftsToCommands, toDraft } from "./commands";
import { useBranchCheck } from "./data";
import { type BranchPick, branchApproval, codeParts, firstPick, pickedPrefix, prefixProblem, SIZE_LINE } from "./model";

export const PLAN_FORM = "task-plan";

// spec.md section 6.3: the build needs a test command to see red and green tests (loop.ts NO_TEST).
export function planProblem(t: TaskDto, picks: readonly CommandDraft[], warned: boolean): string | null {
  const plan = t.plan;
  if (!plan) return "The plan is not ready yet.";
  const bad = picks.find((d) => draftProblem(d));
  if (bad) return `Fix the command ${bad.name.trim() || "without a name"} first. ${draftProblem(bad)}`;
  if (!picks.some((c) => c.kind === "test")) return "Pick at least one test command. The build runs it to see failing and passing tests.";
  if (plan.warning && !warned) return "Read the warning and tick “I understand” first.";
  return null;
}

// A picked command goes as its ID when the user did not change it, else as the whole edited command.
const sameCommand = (a: TaskCommand, b: TaskCommand) =>
  a.name === b.name && a.kind === b.kind && JSON.stringify(a.argv) === JSON.stringify(b.argv);

// The branch picks per task. A base change writes the plan again, and this screen comes back with the picks.
const branchPicks = new Map<number, BranchPick>();

export function PlanApproval(props: {
  t: TaskDto;
  runner: string;
  busy: boolean;
  onSize: (size: TaskSize) => void;
  onApprove: (input: Omit<TaskPlanInput, "version">) => void;
  onBase: (branch: string) => Promise<unknown>;
}) {
  const { t, runner } = props;
  const plan = t.plan;
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(plan?.commands.map((c) => c.id) ?? []));
  const [drafts, setDrafts] = useState<CommandDraft[]>(() => plan?.commands.map(toDraft) ?? []);
  const [warned, setWarned] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const settings = useSettings();
  const prefixes = settings.data?.taskBranchPrefixes;
  // null: no pick yet, so the first chip.
  const [own, setOwn] = useState<BranchPick | null>(() => branchPicks.get(t.id) ?? null);
  const pick = own ?? (prefixes ? firstPick(t.settings.branchPrefix, prefixes) : null);
  const setPick = (p: BranchPick) => {
    branchPicks.set(t.id, p);
    setOwn(p);
  };
  const prefix = pick && pickedPrefix(pick);
  const check = useBranchCheck(t.id, prefix !== null && prefixProblem(prefix) === null ? prefix : null);
  if (!plan) return null;
  const size = t.size ?? plan.proposed;
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const picks = drafts.filter((c) => picked.has(c.id));
  const saved = new Set(plan.commands.filter((c) => c.saved).map((c) => c.id));
  return (
    <form
      id={PLAN_FORM}
      aria-label="Plan approval"
      className="grid max-w-[72ch] gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        // No pick: Settings did not load, and the server takes the first prefix of Settings > Tasks.
        const branch = pick ? branchApproval(pick, check) : null;
        if (branch && "problem" in branch) {
          setProblem(branch.problem);
          return document.getElementById("task-prefix")?.focus();
        }
        const p = planProblem(t, picks, warned);
        setProblem(p);
        if (p) return;
        const commands = (draftsToCommands(picks) ?? []).map((c) => {
          const offered = plan.commands.find((o) => o.id === c.id);
          return offered && sameCommand(offered, c) ? c.id : c;
        });
        props.onApprove({ size, commands, ...(plan.warning && { warning: true }), ...branch });
      }}
    >
      <FieldSet className="gap-1.5">
        <FieldLegend className="text-sm font-semibold">Size</FieldLegend>
        <p className="m-0 text-sm text-ink-2">
          {runner} proposes: {plan.proposed}.
        </p>
        {plan.rules.map((r) => (
          <p key={r} className="m-0 text-sm text-ink-2">
            {r}
          </p>
        ))}
        {TASK_SIZES.map((s) => {
          const low = sizeRank(s) < sizeRank(plan.minimum);
          return (
            <label
              key={s}
              className={cn(
                "-mx-1.5 grid min-h-6 grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-[5px] px-1.5 py-1",
                low ? "cursor-default opacity-60" : "cursor-pointer hover:bg-hover",
              )}
            >
              <input
                id={`task-size-${s}`}
                type="radio"
                name="task-size"
                checked={size === s}
                disabled={low || props.busy}
                className="m-0 mt-[3px] size-4 accent-foreground"
                onChange={() => props.onSize(s)}
              />
              <span className="text-sm">{SIZE_LINE[s]}</span>
              {s !== "small" && (
                <span className="col-start-2 text-xs text-muted-foreground">
                  This version builds small tasks only. A {s} plan waits after its approval.
                </span>
              )}
            </label>
          );
        })}
      </FieldSet>
      <BranchSection
        t={t}
        size={size}
        prefixes={prefixes}
        error={settings.error}
        pick={pick}
        check={check}
        onPick={setPick}
        onBase={props.onBase}
      />
      {plan.missing > 0 && (
        <p className="m-0 text-sm text-ink-2">
          {plan.missing === 1 ? "1 map line names code that does not exist." : `${plan.missing} map lines name code that does not exist.`}{" "}
          The Spec tab marks them.
        </p>
      )}
      <FieldSet className="gap-1.5">
        <FieldLegend className="text-sm font-semibold">Commands that the app runs after each step</FieldLegend>
        {plan.commands.length === 0 && (
          <p className="m-0 text-sm text-ink-2">The plan names no command. Add a test command, or ask for a plan with one.</p>
        )}
        <CommandsEditor
          idPrefix="plan-cmd"
          drafts={drafts}
          onChange={(next) => setDrafts(next)}
          picked={picked}
          onPick={toggle}
          saved={saved}
          newPrefix="new-u"
        />
      </FieldSet>
      {plan.warning && (
        <Alert>
          <AlertTitle>Before the first build in this repository</AlertTitle>
          <AlertDescription className="grid gap-2">
            <p className="m-0">
              The app will run these commands in a copy of the repository:{" "}
              <span translate="no" className="font-mono">
                {picks.length ? picks.map((c) => c.line).join(", ") : "none picked"}
              </span>
              . They run code that {runner} writes. On Windows nothing limits what that code can read or reach. Run this only for code you
              would run yourself.
            </p>
            <label className="inline-flex min-h-6 cursor-pointer items-center gap-2 font-medium text-foreground">
              <input
                type="checkbox"
                checked={warned}
                className="m-0 size-4 accent-foreground"
                onChange={(e) => setWarned(e.target.checked)}
              />
              I understand
            </label>
          </AlertDescription>
        </Alert>
      )}
      {problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {problem}
        </p>
      )}
    </form>
  );
}

// "### [ ] T1.1 Title" lines of the tasks grammar (spec.md section 6.4) in the plan files of the task.
const TASK_LINE = /^### \[( |x)\] (T\d+\.\d+) (.+)$/gm;

export function plannedTasks(t: Pick<TaskDto, "docs" | "steps">) {
  const text = [t.docs?.plan, t.docs?.tasks].filter(Boolean).join("\n");
  const committed = new Set(t.steps.filter((s) => s.kind === "commit" && s.state === "ok" && s.item).map((s) => s.item as string));
  return [...text.matchAll(TASK_LINE)].map((m) => ({
    id: m[2] as string,
    title: (m[3] as string).trim(),
    done: m[1] === "x" || committed.has(m[2] as string),
  }));
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

// The run time of a part: the sum of its finished steps with a run.
function partTime(t: TaskDto, part: number) {
  const ms = t.steps
    .filter((s) => s.part === part && ["tests", "implement", "fix", "review"].includes(s.kind) && s.endedAt !== null)
    .reduce((n, s) => n + ((s.endedAt as number) - s.startedAt), 0);
  return ms > 0 ? `${minutes(ms)} min` : null;
}

export function PlanParts({ t }: { t: TaskDto }) {
  const parts = codeParts(t);
  const tasks = plannedTasks(t);
  const budget = t.settings.lineBudget ?? t.plan?.budget ?? null;
  const taskList = (
    <ul className="m-0 grid list-none gap-1 p-0">
      {tasks.map((k) => (
        <li key={k.id} className="flex items-start gap-2 text-sm">
          {k.done ? (
            <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
          ) : (
            <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span>
            <span className="sr-only">{k.done ? "Done: " : "Open: "}</span>
            <code translate="no" className="mr-1.5 font-mono text-xs text-ink-2">
              {k.id}
            </code>
            {k.title}
          </span>
        </li>
      ))}
    </ul>
  );
  if (!parts.length)
    return (
      <div className="grid gap-2">
        <p className="m-0 text-sm text-ink-2">The build has not started. The plan has these tasks:</p>
        {tasks.length ? taskList : <p className="m-0 text-sm text-muted-foreground">No task yet.</p>}
      </div>
    );
  return (
    <ul className="m-0 grid list-none gap-3 p-0">
      {parts.map((p) => {
        const time = partTime(t, p.id);
        return (
          <li key={p.id} data-task-item tabIndex={-1} className="grid gap-1.5 rounded-md border bg-card px-3 py-2.5 outline-offset-2">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
              <span className="font-semibold">{parts.length > 1 ? `Part ${p.ord}: ${p.title}` : p.title}</span>
              <Badge variant="quiet">{PART_STATE_TEXT[p.state]}</Badge>
              {p.remotePr !== null && <span className="text-ink-2">PR #{p.remotePr}</span>}
            </div>
            <p className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-2">
              <span translate="no" className="font-mono">
                {p.branch}
              </span>
              {p.lines !== null && <span>{budget ? `${p.lines} of ${budget} lines` : `${p.lines} lines`}</span>}
              {time && <span>Time: {time}</span>}
              {p.usage && <span>{p.usage.turns} turns</span>}
            </p>
            {tasks.length > 0 && taskList}
          </li>
        );
      })}
    </ul>
  );
}
