// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The plan approval (docs/plans/review-v2/spec.md sections 6.1, 6.4, 6.8, 6.12, and 6.16): the size with its one-line meaning and the
// rule lines, the branch (BranchSection.tsx), the repositories of a task with several (section 6.16.5), the approved commands with the
// first-use warning, and the map check line. The header button "Approve the plan" submits this form.
// PlanParts is the Plan tab: the parts with their state in plain words, the tasks with check marks, and the lines against the limit.
import { Check, Circle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { TaskDto, TaskPlanInput } from "../../shared/dto";
import { MAX_OPEN_CAP, PART_STATE_TEXT, type StartMode, sizeRank, TASK_SIZES, type TaskCommand, type TaskSize } from "../../shared/task";
import { useSettings } from "../shell/data";
import { BaseField, BranchSection } from "./BranchSection";
import { CommandsEditor } from "./CommandsEditor";
import { type CommandDraft, draftProblem, draftsToCommands, toDraft } from "./commands";
import { useBranchCheck } from "./data";
import {
  ACCESS_TEXT,
  type BranchPick,
  basePicks,
  branchApproval,
  codeParts,
  continuable,
  firstPick,
  firstStarts,
  foundBranch,
  inTask,
  livePlan,
  mergedPr,
  ON_TOP,
  openPrs,
  partLabel,
  pickedPrefix,
  prefixProblem,
  proposals,
  repoName,
  roleText,
  SIZE_LINE,
  type StartPick,
  showRepos,
  startBranch,
  startCycle,
  startLabel,
  trackedKeys,
} from "./model";

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
  // taskRepo: absent for the main repository.
  onBase: (branch: string, taskRepo?: number) => Promise<unknown>;
  onRepo: (taskRepo: number, add: boolean) => void;
  // spec.md section 6.20.5, a task with sub-tasks: the tracker name, the move dialog of a merged PR, and the reason that keeps
  // "Approve the plan" disabled (null: it can approve).
  tracker?: string;
  onMove?: (issue: { key: string; status: string | null }) => void;
  onHold?: (reason: string | null) => void;
}) {
  const { t, runner } = props;
  const plan = t.plan;
  const several = showRepos(t);
  const sub = t.subtasks !== null;
  const [starts, setStarts] = useState<StartPick[]>(() => firstStarts(t));
  const [track, setTrack] = useState<Record<string, number>>({});
  const [maxOpen, setMaxOpen] = useState(String(plan?.maxOpen?.value ?? 3));
  const pickless = (t.subtasks ?? []).find((x) => x.category !== "done" && openPrs(x).length > 1 && track[x.key] === undefined);
  const hold = sub ? (pickless ? `Pick the PR that the app tracks for ${pickless.key}.` : startCycle(starts, livePlan(t))) : null;
  const onHold = props.onHold;
  useEffect(() => onHold?.(hold), [hold, onHold]);
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
        const p = hold ?? planProblem(t, picks, warned) ?? (sub ? maxOpenProblem(maxOpen) : null);
        setProblem(p);
        if (p) return;
        const commands = (draftsToCommands(picks) ?? []).map((c) => {
          const offered = plan.commands.find((o) => o.id === c.id);
          return offered && sameCommand(offered, c) ? c.id : c;
        });
        props.onApprove({
          size: sub ? "small" : size,
          commands,
          ...(plan.warning && { warning: true }),
          ...branch,
          ...(several && { bases: basePicks(t) }),
          ...(sub && {
            subtasks: {
              parts: starts.map((x) => ({ ...x, after: x.start === "base" ? null : x.after })),
              track: Object.entries(track).map(([key, pr]) => ({ key, pr })),
              maxOpen: Number(maxOpen),
            },
          }),
        });
      }}
    >
      {sub && (
        <SubtaskPlan
          t={t}
          runner={runner}
          tracker={props.tracker ?? ""}
          prefix={prefix && prefixProblem(prefix) === null ? prefix : null}
          starts={starts}
          track={track}
          maxOpen={maxOpen}
          hold={hold}
          onStarts={setStarts}
          onTrack={(key, pr) => setTrack((x) => ({ ...x, [key]: pr }))}
          onMaxOpen={setMaxOpen}
          onMove={props.onMove}
        />
      )}
      <FieldSet className={cn("gap-1.5", sub && "hidden")}>
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
        onBase={(branch) => props.onBase(branch)}
        base={!several}
        chipsOnly={sub}
      />
      {several && <RepoSection t={t} runner={runner} busy={props.busy} onBase={props.onBase} onRepo={props.onRepo} />}
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

// spec.md section 6.20.5: "Open PRs at once" takes a whole number from 1 to MAX_OPEN_CAP.
function maxOpenProblem(text: string): string | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= MAX_OPEN_CAP ? null : `Type a number from 1 to ${MAX_OPEN_CAP} for open PRs at once.`;
}

const rowBox = "grid gap-1 rounded-md border bg-card px-3 py-2.5";
const select = "h-8 rounded-md border border-input bg-pane px-2 text-sm";

// spec.md section 6.20.5: the section "Sub-tasks" of the plan screen, one row per sub-task in tracker order. A plan part has its
// "Starts" selects, the reason of the runner, and its branch. A tracked PR, a done sub-task, and a merged PR say what the app does.
function SubtaskPlan(props: {
  t: TaskDto;
  runner: string;
  tracker: string;
  prefix: string | null;
  starts: StartPick[];
  track: Record<string, number>;
  maxOpen: string;
  hold: string | null;
  onStarts: (s: StartPick[]) => void;
  onTrack: (key: string, pr: number) => void;
  onMaxOpen: (v: string) => void;
  onMove?: (issue: { key: string; status: string | null }) => void;
}) {
  const { t, runner, tracker } = props;
  const plan = t.plan;
  const live = livePlan(t);
  const tracked = trackedKeys(t);
  const set = (n: number, change: Partial<StartPick>) => props.onStarts(props.starts.map((x) => (x.n === n ? { ...x, ...change } : x)));
  // The other rows that a part can start on: the other plan parts and the tracked PRs.
  const others = (n: number) => [
    ...live.filter((x) => x.n !== n).map((x) => ({ value: String(x.n), label: startLabel(x, live) })),
    ...tracked.map((k) => ({ value: k, label: `${k} (its open PR)` })),
  ];
  const shown = new Set<number>();
  const rows = (t.subtasks ?? []).flatMap((s) => {
    const own = live.filter((x) => x.keys[0] === s.key && !shown.has(x.n));
    for (const x of own) shown.add(x.n);
    const prs = openPrs(s);
    const merged = mergedPr(s);
    const head = (
      <p className="m-0 text-sm">
        <span translate="no" className="font-mono font-semibold">
          {s.key}
        </span>{" "}
        <span className="font-semibold [overflow-wrap:anywhere]">{s.summary}</span>
        <span className="text-ink-2">
          {" "}
          · {tracker}: {s.status ?? "not known"}
        </span>
      </p>
    );
    const note = (text: ReactNode) => [
      <li key={s.key} data-plan-row={s.key} className={rowBox}>
        {head}
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-ink-2">{text}</p>
      </li>,
    ];
    if (s.category === "done" && !prs.length) return note(`Done in ${tracker}. The app skips it.`);
    if (prs.length === 1)
      return note(
        <span>
          In review outside the app: PR #{prs[0]?.pr} from{" "}
          <span translate="no" className="font-mono text-xs">
            {prs[0]?.branch}
          </span>
          . The app tracks it.
        </span>,
      );
    if (prs.length > 1)
      return [
        <li key={s.key} data-plan-row={s.key} className={rowBox}>
          {head}
          <FieldSet className="gap-1">
            <FieldLegend className="text-sm text-ink-2">Pick the PR that the app tracks for {s.key}.</FieldLegend>
            {prs.map((f) => (
              <label
                key={f.pr}
                className="-mx-1.5 flex min-h-6 cursor-pointer items-center gap-2 rounded-[5px] px-1.5 py-1 text-sm hover:bg-hover"
              >
                <input
                  type="radio"
                  name={`track-${s.key}`}
                  checked={props.track[s.key] === f.pr}
                  className="m-0 size-4 accent-foreground"
                  onChange={() => props.onTrack(s.key, f.pr)}
                />
                <span className="[overflow-wrap:anywhere]">
                  PR #{f.pr} from{" "}
                  <span translate="no" className="font-mono text-xs">
                    {f.branch}
                  </span>
                  : {f.title}
                </span>
              </label>
            ))}
          </FieldSet>
        </li>,
      ];
    if (merged && s.category !== "done" && !own.length)
      return note(
        <>
          <span>
            Merged as PR #{merged.pr}. {tracker} says {s.status ?? "an unknown status"}.
          </span>
          {props.onMove && (
            <Button type="button" variant="outline" size="sm" onClick={() => props.onMove?.({ key: s.key, status: s.status })}>
              Move in {tracker}
            </Button>
          )}
        </>,
      );
    if (!own.length) return note(`${runner} planned no PR for ${s.key}.`);
    return own.map((x) => {
      const pick = props.starts.find((p) => p.n === x.n) ?? { n: x.n, start: x.start, after: x.after };
      const choices = others(x.n);
      const id = `plan-start-${x.n}`;
      const label = startLabel(x, live);
      const branch = foundBranch(s);
      const can = branch !== null && props.prefix !== null && continuable(props.prefix, s.key, branch.name);
      const planned = props.prefix ? startBranch(props.prefix, x, live, s.summary) : null;
      const twins = live.filter((y) => y.keys[0] === s.key).length;
      return (
        <li key={`${s.key}-${x.n}`} data-plan-row={label} className="grid gap-2 rounded-md border bg-card px-3 py-2.5">
          {head}
          <p className="m-0 text-sm text-ink-2">
            {x.keys.length > 1 ? `${x.keys.join(" and ")} in one PR. ` : twins > 1 ? `${label}: ${s.key} in ${twins} PRs. ` : ""}
            {x.title}
            {x.lines !== null && ` · about ${x.lines} lines`}
          </p>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <div className="grid gap-1">
              <label htmlFor={id} className="text-ink-2">
                Starts
              </label>
              <select
                id={id}
                name={id}
                className={select}
                value={pick.start}
                onChange={(e) => {
                  const start = e.target.value as StartMode;
                  set(x.n, { start, after: start === "base" ? null : (pick.after ?? choices[0]?.value ?? null) });
                }}
              >
                <option value="base">From {t.targetBranch}</option>
                <option value={ON_TOP} disabled={!choices.length}>
                  On top of another sub-task
                </option>
                <option value="merge" disabled={!choices.length}>
                  After another sub-task merges
                </option>
              </select>
            </div>
            {pick.start !== "base" && (
              <div className="grid gap-1">
                <label htmlFor={`${id}-after`} className="text-ink-2">
                  {pick.start === ON_TOP ? "On top of" : "After the merge of"}
                </label>
                <select
                  id={`${id}-after`}
                  name={`${id}-after`}
                  className={select}
                  value={pick.after ?? ""}
                  onChange={(e) => set(x.n, { after: e.target.value })}
                >
                  {choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {x.reason && (
            <p className="m-0 text-sm text-ink-2">
              {runner}: {x.reason}
            </p>
          )}
          {branch && !can ? (
            <p className="m-0 text-xs text-ink-2 [overflow-wrap:anywhere]">
              The app found{" "}
              <span translate="no" className="font-mono">
                {branch.name}
              </span>{" "}
              and starts a new branch. The app pushes only to names like{" "}
              <span translate="no" className="font-mono">
                {props.prefix ?? ""}
                {s.key}-…
              </span>
            </p>
          ) : branch ? (
            <FieldSet className="gap-0.5">
              <FieldLegend className="text-xs text-ink-2">Branch</FieldLegend>
              {(["continue", "new"] as const).map((v) => (
                <label key={v} className="flex min-h-6 cursor-pointer items-center gap-2 text-sm [overflow-wrap:anywhere]">
                  <input
                    type="radio"
                    name={`plan-existing-${x.n}`}
                    checked={(pick.existing ?? "continue") === v}
                    className="m-0 size-4 accent-foreground"
                    onChange={() => set(x.n, { existing: v })}
                  />
                  {v === "continue" ? (
                    <span>
                      Continue on{" "}
                      <span translate="no" className="font-mono text-[13px]">
                        {branch.name}
                      </span>
                    </span>
                  ) : (
                    "Start a new branch"
                  )}
                </label>
              ))}
            </FieldSet>
          ) : (
            planned && (
              <p className="m-0 text-xs text-ink-2 [overflow-wrap:anywhere]">
                Branch:{" "}
                <span translate="no" className="font-mono">
                  {planned}
                </span>
              </p>
            )
          )}
        </li>
      );
    });
  });
  return (
    <FieldSet className="gap-2">
      <FieldLegend className="text-sm font-semibold">Sub-tasks</FieldLegend>
      <p className="m-0 text-sm text-ink-2">Each sub-task gets its own branch and its own PR. The approval pushes nothing.</p>
      <ul aria-label="Sub-tasks of the plan" className="m-0 grid list-none gap-2 p-0">
        {rows}
      </ul>
      {plan?.notes.map((n) => (
        <p key={n} className="m-0 text-sm text-ink-2">
          {n}
        </p>
      ))}
      <div className="grid max-w-sm gap-1 text-sm">
        <label htmlFor="plan-max-open" className="font-medium">
          Open PRs at once
        </label>
        <Input
          id="plan-max-open"
          name="maxOpen"
          autoComplete="off"
          type="number"
          min={1}
          max={MAX_OPEN_CAP}
          inputMode="numeric"
          className="h-8 w-24"
          aria-describedby="plan-max-open-help"
          value={props.maxOpen}
          onChange={(e) => props.onMaxOpen(e.target.value)}
        />
        <FieldDescription id="plan-max-open-help">
          {runner} proposes {plan?.maxOpen?.value ?? 3}
          {plan?.maxOpen?.reason ? `: ${plan.maxOpen.reason}` : "."}
        </FieldDescription>
      </div>
      {props.hold && (
        <p id="plan-hold" className="m-0 text-sm text-destructive">
          {props.hold}
        </p>
      )}
    </FieldSet>
  );
}

// spec.md section 6.20.12: "Ask the runner again" starts the plan run again with the user's text as an answer line.
export function AskAgain(props: { runner: string; busy: boolean; onSend: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <form
      aria-label={`Ask ${props.runner} again`}
      className="grid max-w-[72ch] gap-2 rounded-md border bg-card px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) props.onSend(text.trim());
      }}
    >
      <label htmlFor="plan-again" className="text-sm font-medium">
        What should {props.runner} change in the plan?
      </label>
      <Textarea
        id="plan-again"
        name="text"
        rows={3}
        maxLength={2000}
        value={text}
        placeholder="For example: build ABC-13 after ABC-12 merges…"
        onChange={(e) => setText(e.target.value)}
      />
      <p className="m-0 text-xs text-muted-foreground">{props.runner} writes the plan again. Nothing goes to the server.</p>
      <div className="flex gap-2">
        <Button type="submit" variant="outline" size="sm" disabled={props.busy || !text.trim()}>
          Send
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// spec.md sections 6.16.3 and 6.16.5: the repositories of the task with their access, the reason of each one that the task cannot change,
// a base picker for each one that it changes, and the proposals of the spec run with Add and Skip. The proposal reason is the text of
// the runner.
function RepoSection(props: {
  t: TaskDto;
  runner: string;
  busy: boolean;
  onBase: (branch: string, taskRepo?: number) => Promise<unknown>;
  onRepo: (taskRepo: number, add: boolean) => void;
}) {
  const { t, runner } = props;
  return (
    <FieldSet className="gap-2">
      <FieldLegend className="text-sm font-semibold">Repositories</FieldLegend>
      <p className="m-0 text-sm text-ink-2">The task branch goes to each repository that {runner} can change. Each one gets its own PR.</p>
      <ul aria-label="Repositories of the task" className="m-0 grid list-none gap-2 p-0">
        {inTask(t).map((r) => {
          const name = repoName(r);
          const main = r.role === "main";
          return (
            <li key={r.id} className="grid gap-2 rounded-md border bg-card px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span translate="no" className="text-sm font-semibold [overflow-wrap:anywhere]">
                  {name}
                </span>
                <span translate="no" className="text-xs text-ink-2">
                  {roleText(r)}
                </span>
                <Badge variant={r.access === "edit" ? "soft" : "quiet"}>{ACCESS_TEXT[r.access]}</Badge>
              </div>
              {r.reason && <p className="m-0 text-xs text-ink-2">{r.reason}</p>}
              {r.access === "edit" && r.project && r.repo && (
                <BaseField
                  id={main ? "task-base" : `task-base-${r.id}`}
                  project={r.project}
                  repo={r.repo}
                  base={main ? t.targetBranch : (r.baseBranch ?? "")}
                  name={name}
                  onBase={(branch) => props.onBase(branch, main ? undefined : r.id)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {proposals(t).map((p) => {
        const name = repoName(p);
        return (
          <section
            key={p.id}
            aria-labelledby={`task-proposal-${p.id}`}
            className="grid gap-2 rounded-md border border-dashed bg-card px-3 py-2.5"
          >
            <p id={`task-proposal-${p.id}`} className="m-0 text-sm [overflow-wrap:anywhere]">
              {runner} proposes another repository:{" "}
              <span translate="no" className="font-semibold">
                {name}
              </span>
              .{p.proposalReason && ` ${p.proposalReason}`}
            </p>
            <p className="m-0 text-xs text-ink-2">Add writes the plan again with this repository. Skip keeps it out of the task.</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Add ${name}`}
                disabled={props.busy}
                onClick={() => props.onRepo(p.id, true)}
              >
                Add
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Skip ${name}`}
                disabled={props.busy}
                onClick={() => props.onRepo(p.id, false)}
              >
                Skip
              </Button>
            </div>
          </section>
        );
      })}
    </FieldSet>
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
              <span className="font-semibold">
                {t.subtasks ? `${partLabel(t, p)}: ${p.title}` : parts.length > 1 ? `Part ${p.ord}: ${p.title}` : p.title}
              </span>
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
