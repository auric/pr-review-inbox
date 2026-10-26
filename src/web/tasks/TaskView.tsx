// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Task view (docs/plans/review-v2/spec.md sections 6.12 and 7): a header with the key, the title, and the size, the step strip, one
// status sentence in a polite live region, one primary button, a More menu, the Tell box (section 6.18.1), the content of the
// current step, then the tabs Questions, Spec, Plan, Log, and Diff. model.ts decides the sentence and the actions. Focus moves to the
// new primary button after a state change.
import { Ellipsis } from "lucide-react";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { MetaDto, TaskDto } from "../../shared/dto";
import type { TaskDoc } from "../../shared/task";
import type { Layer } from "../keys";
import type { PrRef } from "../lib/route";
import { RunLog } from "../review/RunLog";
import { trackerOf } from "../review/tasks";
import { Hint } from "../shell/Hint";
import { TaskFiles } from "./Attachments";
import { DiffTab } from "./DiffTab";
import { type TaskAction, useTask, useTaskAction, useTaskRun } from "./data";
import { LogTab, stepId } from "./LogTab";
import { type Action, type ActionKind, currentPart, openQuestions, runningStep, stoppedSend, stripSteps, taskView, tellBox } from "./model";
import { OpenPrDialog } from "./OpenPrDialog";
import { PLAN_FORM, PlanApproval, PlanParts, plannedTasks } from "./PlanTab";
import { AnsweredList, QuestionsForm } from "./Questions";
import { docList, SpecDocs } from "./SpecDocs";
import { StepStrip } from "./StepStrip";
import { TellClaude } from "./TellClaude";

// The shell keys of the Task view (keys.ts): j and k move over the steps and parts, Enter runs the primary action, Esc closes the run log.
export type TaskApi = { step: (d: 1 | -1) => void; primary: () => void; layer: (target: EventTarget | null) => Layer; close: () => void };

type Tab = "questions" | "attachments" | "spec" | "plan" | "log" | "diff";
const TAB_LABEL: Record<Tab, string> = {
  questions: "Questions",
  attachments: "Attachments",
  spec: "Spec",
  plan: "Plan",
  log: "Log",
  diff: "Diff",
};

// The time of a running step changes every 15 s.
function useTick(on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export const TaskView = forwardRef<TaskApi, { id: number; meta: MetaDto; onPr: (ref: PrRef) => void }>(function TaskView(props, ref) {
  const q = useTask(props.id);
  if (q.isPending)
    return (
      <div role="status" aria-busy="true" aria-label="Loading the task" className="grid gap-3 px-6 pt-5">
        <Skeleton className="h-5 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="mt-4 h-24 w-full max-w-[760px]" />
      </div>
    );
  if (q.error || !q.data)
    return (
      <div className="mx-auto my-10 grid max-w-[52ch] gap-3 px-6">
        <p role="alert" className="m-0 text-destructive">
          Cannot show this task. {q.error?.message}
        </p>
      </div>
    );
  return <Loaded key={q.data.id} ref={ref} t={q.data} meta={props.meta} onPr={props.onPr} />;
});

const Loaded = forwardRef<TaskApi, { t: TaskDto; meta: MetaDto; onPr: (ref: PrRef) => void }>(function Loaded({ t, meta, onPr }, ref) {
  const runner = meta.runner.short;
  const act = useTaskAction(t);
  const [errorText, setErrorText] = useState<string | null>(null);
  const view = taskView(t, { runner, forge: meta.forge.name, now: useTick(runningStep(t) !== null) });
  const part = currentPart(t);
  const box = tellBox(t);
  const tabs: Tab[] = [
    ...(t.questions.length ? ["questions" as const] : []),
    // spec.md section 6.17: the files of the task, when its issue lists any.
    ...(t.attachments.length || t.files.length ? ["attachments" as const] : []),
    ...(docList(t).length ? ["spec" as const] : []),
    "plan",
    "log",
    ...(part?.head ? ["diff" as const] : []),
  ];
  // The tab follows the screen: the plan files on the plan screen, else the log. A tab that the user picks stays until the screen changes.
  const [picked, setPicked] = useState<{ screen: string; tab: Tab } | null>(null);
  const setTab = (tab: Tab) => setPicked({ screen: view.screen, tab });
  const tab = picked?.screen === view.screen ? picked.tab : view.screen === "plan" ? "spec" : "log";
  const shown = tabs.includes(tab) ? tab : "log";
  const [editing, setEditing] = useState<TaskDoc | null>(null);
  const [prOpen, setPrOpen] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [limit, setLimit] = useState("");
  const [runLog, setRunLog] = useState<{ run: number; raw: boolean; n: number } | null>(null);
  const log = useTaskRun(t.id, runLog?.run ?? null);
  const root = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<string | null>(null);

  const send = (a: TaskAction, after?: () => void) => {
    setErrorText(null);
    act.mutate(a, {
      onSuccess: () => after?.(),
      onError: (e) => setErrorText(e.message),
    });
  };
  const focus = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: false }));

  const run = (kind: ActionKind) => {
    switch (kind) {
      case "answer":
        return requestAnimationFrame(() =>
          root.current
            ?.querySelector<HTMLElement>("#task-questions input:checked, #task-questions input, #task-questions textarea")
            ?.focus(),
        );
      case "recommended":
        return send({ kind: "answers", input: { answers: [], recommended: true } });
      case "approve":
        return (document.getElementById(PLAN_FORM) as HTMLFormElement | null)?.requestSubmit();
      case "edit-plan": {
        const d = docList(t)[0] ?? null;
        setTab("spec");
        setEditing(d);
        return d && focus(`doc-edit-${d}`);
      }
      case "change-size":
        return focus(`task-size-${t.size ?? t.plan?.proposed ?? "small"}`);
      case "stop":
      case "pause":
      case "resume":
      case "close":
        return send({ kind });
      case "continue":
        return send({ kind: "resume" });
      case "see-why":
        setTab("log");
        return t.blocked?.step && focus(stepId(t.blocked.step));
      case "keep-size":
        return send({ kind: "keep" });
      case "change-limit":
        setLimitOpen(true);
        return focus("task-limit");
      case "review-change":
        return focus("task-change");
      case "reject-change":
        return t.blocked?.step && send({ kind: "change", step: t.blocked.step, accept: false });
      case "open-pr":
        setPrError(null);
        return setPrOpen(true);
      case "show-diff":
        setTab("diff");
        return focus("task-tab-diff");
      case "fix-points":
        return part && send({ kind: "fix", part: part.id });
      case "go-pr": {
        const p = [...t.parts].reverse().find((x) => x.remotePr !== null);
        return p?.remotePr && onPr({ project: t.project, repo: t.repo, id: p.remotePr });
      }
      case "update":
        return part && send({ kind: "update", part: part.id });
      case "undo-update":
        return part && send({ kind: "undo", part: part.id });
    }
  };

  useImperativeHandle(ref, () => ({
    step: (d) => {
      const items = [...(root.current?.querySelectorAll<HTMLElement>("[data-task-item]") ?? [])];
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = items[at < 0 ? (d > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, at + d))];
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    },
    primary: () => primaryRef.current?.click(),
    layer: () => (runLog ? "log" : null),
    close: () => setRunLog(null),
  }));

  // spec.md section 7.1, AC-UX10: after a state change, focus moves to the new primary button. Focus elsewhere in the app stays.
  const mark = `${t.state}:${t.blocked?.kind ?? ""}:${view.primary?.kind ?? ""}`;
  useEffect(() => {
    if (focusAfter.current === null) {
      focusAfter.current = mark;
      return;
    }
    if (focusAfter.current === mark) return;
    focusAfter.current = mark;
    const a = document.activeElement;
    const inside = !a || a === document.body || !!root.current?.contains(a);
    // A user who types in the Tell box keeps the focus there.
    const typing = !!a?.closest("[data-tell]");
    if (inside && !typing && !prOpen) (primaryRef.current ?? document.getElementById("task-status"))?.focus({ preventScroll: true });
  }, [mark, prOpen]);

  const busy = act.isPending;
  const primary = view.primary;
  const button = (a: Action) =>
    a.kind === "approve" ? (
      <Button ref={primaryRef} data-primary type="submit" form={PLAN_FORM} disabled={busy}>
        {a.label}
      </Button>
    ) : (
      <Button ref={primaryRef} data-primary disabled={busy} onClick={() => run(a.kind)}>
        {a.label}
      </Button>
    );

  return (
    <div ref={root} data-task={t.id} className="grid max-w-[920px] gap-5 px-6 pt-5 pb-10">
      <header className="grid gap-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <code translate="no" className="font-mono text-sm text-ink-2">
            {t.key}
          </code>
          <h2 className="m-0 min-w-0 text-[19px] font-bold tracking-[-0.01em] [overflow-wrap:anywhere]">{t.title}</h2>
          {t.size && <span className="text-sm text-ink-2">Size: {t.size}</span>}
          <span translate="no" className="text-xs text-muted-foreground">
            {t.project}/{t.repo} into {t.targetBranch}
          </span>
        </div>
        <StepStrip steps={stripSteps(t)} />
        <div className="grid gap-0.5">
          <p id="task-status" tabIndex={-1} aria-live="polite" className="m-0 text-[15px] font-medium outline-none">
            {view.status}
          </p>
          {view.detail && <p className="m-0 text-sm text-ink-2">{view.detail}</p>}
          {view.lines.length > 0 && (
            <ul aria-label="Repositories to update" className="m-0 grid list-none gap-0.5 p-0 text-sm text-ink-2">
              {view.lines.map((l) => (
                <li key={l} translate="no">
                  {l}
                </li>
              ))}
            </ul>
          )}
          {errorText && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {errorText}
            </p>
          )}
        </div>
        {(primary || view.more.length > 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {primary && button(primary)}
            {view.more.length > 0 && (
              <DropdownMenu modal={false}>
                <Hint label="More actions">
                  <DropdownMenuTrigger render={<Button variant="outline" aria-label="More actions" disabled={busy} />}>
                    More
                    <Ellipsis aria-hidden data-icon="inline-end" />
                  </DropdownMenuTrigger>
                </Hint>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuGroup>
                    {view.more.map((a) => (
                      <DropdownMenuItem key={a.kind} onClick={() => run(a.kind)}>
                        {a.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </header>

      {box !== "none" && (
        <TellClaude
          runner={runner}
          busy={box === "busy" || busy}
          restore={stoppedSend(t)}
          onSend={(text) => {
            setErrorText(null);
            return act.mutateAsync({ kind: "instruct", text });
          }}
        />
      )}

      <Content
        t={t}
        runner={runner}
        screen={view.screen}
        busy={busy}
        limitOpen={limitOpen}
        limit={limit}
        onLimit={setLimit}
        onSend={send}
        onBase={(branch) => act.mutateAsync({ kind: "base", branch })}
        onRun={run}
      />

      <section aria-label="Details" className="grid gap-3">
        <div role="tablist" aria-label="Task details" className="flex flex-wrap gap-1 border-b">
          {tabs.map((k) => (
            <button
              key={k}
              id={`task-tab-${k}`}
              type="button"
              role="tab"
              aria-selected={shown === k}
              aria-controls="task-panel"
              tabIndex={shown === k ? 0 : -1}
              className={cn(
                "-mb-px min-h-8 cursor-pointer border-b-2 border-transparent px-2.5 text-sm text-ink-2 hover:text-foreground",
                shown === k && "border-foreground font-semibold text-foreground",
              )}
              onClick={() => setTab(k)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const next = tabs[(tabs.indexOf(k) + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length] as Tab;
                setTab(next);
                document.getElementById(`task-tab-${next}`)?.focus();
              }}
            >
              {TAB_LABEL[k]}
            </button>
          ))}
        </div>
        <div id="task-panel" role="tabpanel" aria-labelledby={`task-tab-${shown}`} tabIndex={-1} className="outline-none">
          {shown === "questions" && <AnsweredList questions={t.questions} />}
          {shown === "attachments" && <TaskFiles t={t} runner={runner} source={trackerOf(meta)?.name ?? "issue"} />}
          {shown === "spec" && (
            <SpecDocs
              t={t}
              editing={editing}
              editable={t.state === "spec_draft" && !!t.plan && !t.plan.approved}
              busy={busy}
              error={editing ? errorText : null}
              onEdit={setEditing}
              onSave={(doc, text) => send({ kind: "docs", doc, text }, () => setEditing(null))}
            />
          )}
          {shown === "plan" && <PlanParts t={t} />}
          {shown === "log" && (
            <LogTab
              t={t}
              runner={runner}
              onRunLog={(r) => setRunLog({ run: r, raw: false, n: (runLog?.n ?? 0) + 1 })}
              onDiff={
                tabs.includes("diff")
                  ? () => {
                      setTab("diff");
                      focus("task-tab-diff");
                    }
                  : undefined
              }
            />
          )}
          {shown === "diff" && <DiffTab task={t.id} part={part} />}
        </div>
      </section>

      {part && [view.primary, ...view.more].some((a) => a?.kind === "open-pr") && (
        <OpenPrDialog
          key={`${part.id}:${t.reviewers.join(",")}`}
          t={t}
          part={part}
          open={prOpen}
          busy={busy}
          error={prError}
          onOpenChange={setPrOpen}
          onConfirm={(reviewers) => {
            setPrError(null);
            act.mutate(
              { kind: "pr", part: part.id, reviewers },
              { onSuccess: () => setPrOpen(false), onError: (e) => setPrError(e.message) },
            );
          }}
        />
      )}
      {runLog && (
        <RunLog
          // A task run keeps its raw output on the server only. The PR raw route does not serve it.
          detail={log.data && { ...log.data, run: { ...log.data.run, hasRaw: false } }}
          meta={meta}
          prKey={t.key}
          now={Date.now()}
          target={{ agent: null, raw: false, n: runLog.n }}
          onRaw={() => {}}
          onClose={() => setRunLog(null)}
        />
      )}
    </div>
  );
});

// The content of the current step (spec.md section 6.12: "then the content of the current step").
function Content(props: {
  t: TaskDto;
  runner: string;
  screen: ReturnType<typeof taskView>["screen"];
  busy: boolean;
  limitOpen: boolean;
  limit: string;
  onLimit: (v: string) => void;
  onSend: (a: TaskAction, after?: () => void) => void;
  // PUT /api/tasks/:id/base. The confirm of the base picker shows its error.
  onBase: (branch: string) => Promise<unknown>;
  onRun: (k: ActionKind) => void;
}) {
  const { t, runner, screen, busy } = props;
  const b = t.blocked;
  const step = b?.step ? t.steps.find((s) => s.id === b.step) : undefined;
  const part = currentPart(t);
  const box = (children: ReactNode, label: string, id?: string) => (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      aria-label={label}
      className="grid gap-3 rounded-md border bg-card px-4 py-3 outline-offset-2"
    >
      {children}
    </section>
  );

  if (screen === "questions") {
    const loop = t.state === "implementing";
    const open = openQuestions(t, loop ? "loop" : "interview");
    return (
      <div className="grid gap-4">
        {t.interview?.summary && !loop && (
          <p className="m-0 max-w-[72ch] text-sm text-ink-2">
            <span className="font-medium text-foreground">What {runner} understood:</span> {t.interview.summary}
          </p>
        )}
        {open.length > 0 && t.blocked && (
          <QuestionsForm
            key={open.map((x) => x.id).join(",")}
            questions={open}
            busy={busy}
            onSend={(answers) => props.onSend({ kind: "answers", input: { answers } })}
            onRecommended={() => props.onSend({ kind: "answers", input: { answers: [], recommended: true } })}
          />
        )}
      </div>
    );
  }

  if (screen === "plan") {
    if (!t.plan || t.plan.approved) return null;
    return (
      <PlanApproval
        key={t.plan.commands.map((c) => c.id).join(",")}
        t={t}
        runner={runner}
        busy={busy}
        onSize={(size) => props.onSend({ kind: "size", size })}
        onApprove={(input) => props.onSend({ kind: "plan", input })}
        onBase={props.onBase}
      />
    );
  }

  if (screen === "change" && step)
    return box(
      <>
        <p className="m-0 text-sm">
          {runner} changed {step.detail.specChange?.paths.length === 1 ? "this plan file" : "these plan files"}:{" "}
          <span translate="no" className="font-mono text-xs">
            {step.detail.specChange?.paths.join(", ")}
          </span>
        </p>
        {step.detail.notes.map((n) => (
          <p key={n} className="m-0 text-sm text-ink-2">
            {n}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => props.onSend({ kind: "change", step: step.id, accept: true })}>
            Accept the change
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => props.onRun("reject-change")}>
            Reject
          </Button>
        </div>
      </>,
      "Change to the plan",
      "task-change",
    );

  if (screen === "build" || screen === "ready") {
    const tasks = plannedTasks(t);
    const done = tasks.filter((k) => k.done).length;
    const parts = t.parts.filter((p) => p.kind !== "spec").length;
    const budget = t.settings.lineBudget ?? t.plan?.budget ?? null;
    return box(
      <>
        <p className="m-0 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span className="font-medium">{parts > 1 && part ? `Part ${part.ord} of ${parts}` : "Your change"}</span>
          {tasks.length > 0 && (
            <span className="text-ink-2">
              Tasks: {done} of {tasks.length} done
            </span>
          )}
          {part?.lines != null && (
            <span className="text-ink-2">{budget ? `Lines: ${part.lines} of ${budget}` : `Lines: ${part.lines}`}</span>
          )}
        </p>
        {b?.kind === "size" && props.limitOpen && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(props.limit);
              if (Number.isInteger(n) && n > 0) props.onSend({ kind: "limit", lineBudget: n });
            }}
          >
            <div className="grid gap-1 text-sm">
              <label htmlFor="task-limit" className="text-ink-2">
                New line limit for this task
              </label>
              <Input
                id="task-limit"
                name="lineBudget"
                type="number"
                min={1}
                max={100000}
                inputMode="numeric"
                className="h-8 w-32"
                value={props.limit}
                placeholder={String(part?.lines ?? budget ?? "")}
                onChange={(e) => props.onLimit(e.target.value)}
              />
            </div>
            <Button type="submit" variant="outline" disabled={busy || !props.limit}>
              Save the limit
            </Button>
          </form>
        )}
        {b?.kind === "denied_path" && step && (
          <div className="grid gap-1 text-sm text-ink-2">
            {step.detail.deniedPaths.length > 0 && (
              <p className="m-0">
                Files that the app does not commit:{" "}
                <span translate="no" className="font-mono text-xs [overflow-wrap:anywhere]">
                  {step.detail.deniedPaths.join(", ")}
                </span>
              </p>
            )}
            {step.detail.patch && (
              <p className="m-0">
                The worktree went back to the last commit. The changes are saved in{" "}
                <code translate="no" className="font-mono text-xs [overflow-wrap:anywhere]">
                  {step.detail.patch}
                </code>
                . Resume starts the step again.
              </p>
            )}
          </div>
        )}
        {screen === "ready" && t.points.length > 0 && (
          <div className="grid gap-2">
            <p className="m-0 text-sm">
              {runner}'s own review left {t.points.length === 1 ? "1 small point" : `${t.points.length} small points`}:
            </p>
            <ul className="m-0 grid list-none gap-1.5 p-0 text-sm">
              {t.points.map((p) => (
                <li key={p.id} className="grid gap-0.5">
                  <span className="text-xs text-ink-2">
                    <span className="font-medium capitalize">{p.severity}</span>{" "}
                    <code translate="no" className="font-mono">
                      {p.path}
                      {p.line === null ? "" : `:${p.line}`}
                    </code>
                  </span>
                  <span className="line-clamp-3 whitespace-pre-wrap">{p.text}</span>
                </li>
              ))}
            </ul>
            <div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => props.onRun("fix-points")}>
                Fix the small points too
              </Button>
            </div>
          </div>
        )}
      </>,
      "Build",
    );
  }

  if (screen === "pr") {
    const p = [...t.parts].reverse().find((x) => x.remotePr !== null);
    const notes = t.steps.find((s) => s.kind === "pr" && s.state === "ok")?.detail.notes ?? [];
    return box(
      <>
        {p && (
          <p className="m-0 text-sm">
            PR #{p.remotePr} from{" "}
            <span translate="no" className="font-mono text-xs">
              {p.branch}
            </span>{" "}
            into{" "}
            <span translate="no" className="font-mono text-xs">
              {t.targetBranch}
            </span>
            .
          </p>
        )}
        {notes.slice(1).map((n) => (
          <p key={n} className="m-0 text-sm text-ink-2">
            {n}
          </p>
        ))}
      </>,
      "Pull request",
    );
  }

  return null;
}
