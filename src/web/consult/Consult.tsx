// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Session consult dialogs (docs/plans/session-consult.md parts A, C, and D). "Copy for your session" copies a validate-and-implement
// prompt with the items of the ticked groups. "Ask your session" forks the session directly; the dialog shows what each entry of its
// answer does and applies it after a click. In part D the session also proposes edits, and Apply adds them as fix cards. Nothing posts.
import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, CircleStop, ClipboardCopy, History, Info, LoaderCircle, Send, Undo2, Wrench } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import {
  CONSULT_GROUP,
  CONSULT_MAX_BYTES,
  type ConsultGroup,
  type ConsultImportDto,
  type ConsultText,
  type ConsultVerdict,
  consultGroups,
  consultText,
  needsVerdict,
  type PlanRow,
  planAnswer,
  SESSION_FIX_MAX_TURNS,
  SESSION_MAX_TURNS,
  type SessionDto,
  type SessionMode,
  sessionModes,
} from "../../shared/consult";
import type { PrRow } from "../../shared/dto";
import { dialogKeys } from "../fix/CloneDialog";
import { fixesKey } from "../fix/data";
import type { FixTarget } from "../fix/model";
import { useMeta } from "../meta";
import { agoLong } from "../pr/threads";
import { planKey } from "../publish/data";
import { replyKey, useCancelRun, usePrRuns, useRun } from "../review/data";
import { plural } from "../review/model";
import { sizeText } from "../review/tasks";
import { useSlots } from "../review/useSlots";
import { useSettings } from "../shell/data";
import { failText, prKey } from "../shell/model";
import { useNow } from "../shell/Sidebar";
import {
  consultKey,
  loadGroups,
  loadMode,
  postSessionImport,
  postUndo,
  saveGroups,
  saveMode,
  useConsultData,
  useSessionAnswer,
  useSessions,
  useStartSession,
} from "./data";

export const CONSULT_OWN_ONLY = "Copy for your session works only on your own pull requests.";

const kb = (bytes: number) => (bytes < 1000 ? plural(bytes, "byte") : `${(bytes / 1000).toFixed(1)} KB`);
const VERDICT: Record<ConsultVerdict, string> = { accept: "Accept", reject: "Reject", question: "Question" };
// Part D. The turn caps come from consult.ts sessionMaxTurns.
const MODE: Record<SessionMode, { name: string; about: string }> = {
  judge: { name: "Judge only", about: `A verdict for each review point. At most ${SESSION_MAX_TURNS} turns.` },
  fix: {
    name: "Judge and propose fixes",
    about: `A verdict for each point, and code edits for each point that it accepts. You review each edit before Apply. At most ${SESSION_FIX_MAX_TURNS} turns.`,
  },
};
const rowBox = "grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 rounded px-1 py-2 hover:bg-hover";

// from: the ID of the element that takes the focus after the dialog. run: a session run to show (part C).
type Open = { mode: "copy" | "session"; from: string; run?: number };

export type ConsultUi = {
  // from: the element that gets the focus back. Default: the More button.
  copy: (from?: string) => void;
  // Part C. run: show this session run. Absent: the running session run of the PR, else the session list.
  session: (from?: string, run?: number) => void;
  // The opt-in of part C is on.
  sessions: boolean;
  dialog: ReactNode;
};

// openFix: opens the Fix list with exactly these targets ticked.
export function useConsult(pr: PrRow, o: { announce: (text: string) => void; openFix: (targets: FixTarget[]) => void }): ConsultUi {
  const [open, setOpen] = useState<Open | null>(null);
  const author = pr.role === "AUTHOR";
  const sessions = useSettings().data?.sessions === true;
  const qc = useQueryClient();
  const show =
    (mode: Open["mode"]) =>
    (from = "more-btn", run?: number) => {
      if (!author) return void toast.add({ title: CONSULT_OWN_ONLY });
      setOpen({ mode, from, run });
    };
  const close = () => setOpen(null);
  // The import changes reply drafts, findings, the post plan, and with a session fix (part D) the fix runs.
  const changed = () => {
    void qc.invalidateQueries({ queryKey: replyKey(pr.id) });
    void qc.invalidateQueries({ queryKey: planKey(pr.id) });
    void qc.invalidateQueries({ queryKey: consultKey(pr.id) });
    void qc.invalidateQueries({ queryKey: fixesKey(pr.id) });
    void qc.invalidateQueries({ queryKey: ["run"] });
  };
  const finalFocus = () => (open && document.getElementById(open.from)) || true;
  const onFix = (t: FixTarget[]) => {
    close();
    o.openFix(t);
  };
  const body = (b: Open) => {
    if (b.mode === "copy")
      return (
        <CopyBody
          pr={pr}
          announce={o.announce}
          onClose={close}
          finalFocus={finalFocus}
          onSession={sessions ? () => setOpen({ mode: "session", from: b.from }) : undefined}
        />
      );
    return (
      <SessionBody pr={pr} run={b.run} announce={o.announce} onClose={close} onChanged={changed} finalFocus={finalFocus} onFix={onFix} />
    );
  };
  const dialog =
    author && open ? (
      <Dialog open onOpenChange={(on) => !on && close()}>
        {body(open)}
      </Dialog>
    ) : null;
  return { copy: show("copy"), session: show("session"), sessions, dialog };
}

type Body = { pr: PrRow; announce: (text: string) => void; onClose: () => void; finalFocus: () => HTMLElement | true };

function Loading({ error, what = "the review points" }: { error: Error | null; what?: string }) {
  return error ? (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>Cannot read {what}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  ) : (
    <div role="status" aria-label={`Loading ${what}`} className="grid gap-2">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  );
}

// ---------- Part A ----------

// The groups of part A with their counts, and the note of the size cap. The ticks stay per viewer.
function useGroups() {
  const [groups, setGroups] = useState(loadGroups);
  const tick = (g: ConsultGroup, on: boolean) => {
    const next = new Set(groups);
    if (on) next.add(g);
    else next.delete(g);
    setGroups(next);
    saveGroups(next);
  };
  return { groups, tick };
}

function GroupBoxes({
  t,
  groups,
  tick,
}: {
  t: ConsultText;
  groups: ReadonlySet<ConsultGroup>;
  tick: (g: ConsultGroup, on: boolean) => void;
}) {
  return (
    <>
      <FieldSet className="gap-0">
        <FieldLegend variant="label">Groups</FieldLegend>
        {consultGroups.map((g) => (
          <label key={g} className={rowBox} data-consult-group={g}>
            <input
              type="checkbox"
              className="m-0 mt-[3px] accent-foreground"
              checked={groups.has(g)}
              aria-describedby={`cg-${g}-about`}
              onChange={(e) => tick(g, e.target.checked)}
            />
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              <b className="font-semibold">{CONSULT_GROUP[g]}</b>
              <span className="text-muted-foreground">{t.counts[g]}</span>
            </span>
            <span id={`cg-${g}-about`} className="col-start-2 text-xs text-muted-foreground">
              {needsVerdict(g) ? "Open. Your session checks each item." : "Context only. No action."}
            </span>
          </label>
        ))}
      </FieldSet>
      {t.left.length > 0 && (
        <Alert role="note">
          <Info aria-hidden />
          <AlertTitle>The text reached its size cap of {kb(CONSULT_MAX_BYTES)}.</AlertTitle>
          <AlertDescription>
            {plural(t.left.length, "item")} stay out: <span translate="no">{t.left.join(", ")}</span>. Untick a group to make room.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}

// onSession: opens part C instead. Absent while its opt-in is off.
function CopyBody({ pr, announce, onClose, finalFocus, onSession }: Body & { onSession?: () => void }) {
  const q = useConsultData(pr.id, true);
  const { groups, tick } = useGroups();
  const copyBtn = useRef<HTMLButtonElement>(null);
  const t = useMemo(() => q.data && consultText(q.data, groups, "copy"), [q.data, groups]);
  const copy = async () => {
    if (!q.data || !t?.ids.length) return;
    // Each copy gets a new tag suffix.
    const fresh = consultText(q.data, groups, "copy");
    if (!(await copyText(fresh.text)))
      return void toast.add({ title: "The clipboard is blocked here. Allow the clipboard for this page and copy again." });
    announce(`Copied ${plural(fresh.ids.length, "item")} for your session.`);
    onClose();
  };
  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[560px]"
      onKeyDown={dialogKeys(onClose)}
      initialFocus={t?.ids.length ? copyBtn : true}
      finalFocus={finalFocus}
    >
      <DialogHeader>
        <DialogTitle>Copy for your session</DialogTitle>
        <DialogDescription>
          <span translate="no">{prKey(pr)}</span>. Paste the text into the session that wrote the code, in your clone. It checks each item
          against the code, makes the valid changes, and explains each rejection.
        </DialogDescription>
      </DialogHeader>
      {!t ? (
        <Loading error={q.error} />
      ) : (
        <>
          <GroupBoxes t={t} groups={groups} tick={tick} />
          <p id="consult-size" className="m-0 text-sm text-ink-2">
            {t.ids.length ? `${plural(t.ids.length, "item")}, ${kb(t.bytes)}.` : "Nothing to copy. Tick a group with items."}
          </p>
        </>
      )}
      <DialogFooter>
        {onSession && (
          <Button variant="ghost" className="sm:mr-auto" onClick={onSession}>
            <History aria-hidden data-icon="inline-start" />
            Ask your session instead…
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button ref={copyBtn} id="consult-copy" disabled={!t?.ids.length} aria-describedby="consult-size" onClick={() => void copy()}>
          <ClipboardCopy aria-hidden data-icon="inline-start" />
          {t?.ids.length ? `Copy ${plural(t.ids.length, "item")}` : "Copy"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ---------- The answer of a session run ----------

// done: the rows of an applied answer.
function PlanTable({ rows, done }: { rows: PlanRow[]; done?: boolean }) {
  return (
    <div className="max-h-[45dvh] overflow-auto rounded-md border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">What the app {done ? "did" : "does"} with each entry</caption>
        <thead className="sticky top-0 bg-popover text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-2 py-1.5 text-left font-semibold">
              Item
            </th>
            <th scope="col" className="px-2 py-1.5 text-left font-semibold">
              Verdict
            </th>
            <th scope="col" className="px-2 py-1.5 text-left font-semibold">
              What the app {done ? "did" : "does"}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.n} data-consult-row={r.id || r.n} data-skipped={r.act ? undefined : true} className="border-t align-top">
              <td className="px-2 py-1.5">
                <code translate="no" className="font-mono text-xs">
                  {r.id || `Entry ${r.n}`}
                </code>
                {r.item && <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{r.item.label}</div>}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">{r.verdict ? VERDICT[r.verdict] : "–"}</td>
              <td className="px-2 py-1.5 [overflow-wrap:anywhere]">
                <span className={cn(!r.act && "text-muted-foreground")}>{r.act ? r.text : `Skipped. ${r.text}`}</span>
                {r.reason && <div className="text-xs text-muted-foreground">Reason: {r.reason}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const resultText = (d: ConsultImportDto) => {
  const ticks = d.ticks.threads.length + d.ticks.findings.length;
  const parts = [
    d.drafts && `Made ${plural(d.drafts, "reply draft")}.`,
    d.discarded && `Discarded ${plural(d.discarded, "finding")}.`,
    d.marked && `Marked ${plural(d.marked, "finding")}.`,
    ticks && `${plural(ticks, "item")} ticked for a fix.`,
    d.fix && `Added the fix of your session: ${plural(d.fix.edits, "edit")} for ${plural(d.fix.items, "item")}.`,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "Nothing changed.";
};

// Part D: an accepted item also gets the edits that the session proposed for it.
const withFix = (rows: PlanRow[], edits: Readonly<Record<string, number>>): PlanRow[] =>
  rows.map((r) => {
    const n = r.act === "accept" ? (edits[r.id] ?? 0) : 0;
    return n ? { ...r, text: `${r.text} Adds ${plural(n, "proposed edit")} from your session.` } : r;
  });

type Changes = { onChanged: () => void; onFix: (t: FixTarget[]) => void };
// given: the answer of a session run (part C) with the item keys at its start. edits: part D, the count of proposed edits per item ID.
type Given = { run: number; entries: unknown[]; snapshot: Record<string, string>; edits: Record<string, number>; title: string };

function AnswerBody({ pr, announce, onClose, onChanged, onFix, finalFocus, given }: Body & Changes & { given: Given }) {
  const q = useConsultData(pr.id, true);
  const [done, setDone] = useState<ConsultImportDto | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = q.data ? withFix(planAnswer(q.data.items, given.entries, given.snapshot), given.edits) : null;
  const changes = rows?.filter((r) => r.act).length ?? 0;

  const apply = async () => {
    if (!changes || busy) return;
    setBusy(true);
    try {
      const d = await postSessionImport(pr.id, given.run);
      setDone(d);
      onChanged();
      announce(`Applied. ${resultText(d)}`);
    } catch (e) {
      toast.add({ title: "The answer was not applied", description: failText(e) });
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!done || busy) return;
    setBusy(true);
    try {
      const u = await postUndo(pr.id, done.run);
      onChanged();
      const fix =
        u.fix && (u.fix.removed ? "Removed the fix of your session." : "The fix of your session stays: a fix commit holds its edits.");
      announce(
        `Undone. ${[u.drafts && `Removed ${plural(u.drafts, "reply draft")}.`, u.replaced && `Brought back ${plural(u.replaced, "earlier draft")}.`, u.findings && `Reset ${plural(u.findings, "finding")}.`, fix].filter(Boolean).join(" ")}`,
      );
      onClose();
    } catch (e) {
      toast.add({ title: "The undo did not run", description: failText(e) });
      setBusy(false);
    }
  };
  const ticks: FixTarget[] = done
    ? [
        ...done.ticks.threads.map((id) => ({ kind: "thread" as const, id })),
        ...done.ticks.findings.map((id) => ({ kind: "finding" as const, id })),
      ]
    : [];

  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[720px]"
      onKeyDown={dialogKeys(onClose)}
      finalFocus={finalFocus}
    >
      <DialogHeader>
        <DialogTitle>Answer of your session</DialogTitle>
        <DialogDescription>
          <span translate="no">{prKey(pr)}</span>. The answer of <span className="font-medium text-foreground">{given.title}</span>. Nothing
          changes before Apply. Nothing posts.
        </DialogDescription>
      </DialogHeader>
      {done ? (
        <>
          <p id="consult-result" role="status" className="m-0 text-sm font-medium">
            Applied. {resultText(done)}
          </p>
          <PlanTable rows={done.fix ? withFix(done.rows, given.edits) : done.rows} done />
          <p className="m-0 text-xs text-muted-foreground">
            The reply drafts wait under their threads. Accept them to put them in Ready to post.{" "}
            {done.fix
              ? "The proposed edits wait under their threads and findings. Review them, then click Apply in the bar at the bottom. Nothing is written before that."
              : "A Fix list tick stays as the default tick."}
          </p>
        </>
      ) : (
        <>
          <p className="m-0 text-sm text-ink-2">The app skips each item that changed after the run started.</p>
          {!q.data && <Loading error={q.error} />}
          {rows && (
            <>
              <p id="consult-plan" className="m-0 text-sm text-ink-2">
                {plural(changes, "change")}, {rows.length - changes} skipped.
              </p>
              {rows.length > 0 && <PlanTable rows={rows} />}
            </>
          )}
        </>
      )}
      <DialogFooter>
        {done ? (
          <>
            <Button variant="ghost" className="sm:mr-auto" disabled={busy} onClick={() => void undo()}>
              <Undo2 aria-hidden data-icon="inline-start" />
              Undo
            </Button>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            {ticks.length > 0 && !done.fix && (
              <Button id="consult-fix" onClick={() => onFix(ticks)}>
                <Wrench aria-hidden data-icon="inline-start" />
                Open the Fix list ({ticks.length} ticked)
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              id="consult-apply"
              disabled={!changes || busy}
              aria-describedby={rows ? "consult-plan" : undefined}
              onClick={() => void apply()}
            >
              <Check aria-hidden data-icon="inline-start" />
              {changes ? `Apply ${plural(changes, "change")}` : "Apply"}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

// ---------- Part C ----------

const NO_TITLE = "Session without a title";
const titleOf = (title: string | null) => title ?? NO_TITLE;

// run: a session run to show. Absent: the running session run of the PR, else the session list.
function SessionBody({ pr, run, announce, onClose, onChanged, onFix, finalFocus }: Body & Changes & { run?: number }) {
  const meta = useMeta().data;
  const runner = meta?.runner.short ?? "";
  const [picked, setPicked] = useState<number | null>(run ?? null);
  // true: the user asked for the list again, so a running run does not take over the view.
  const [listAgain, setListAgain] = useState(false);
  const runs = usePrRuns(pr.id).data;
  const active = runs?.find((r) => r.kind === "session" && r.status === "running") ?? null;
  const current = picked ?? (listAgain ? null : (active?.id ?? null));
  const detail = useRun(current).data;
  const shown = detail?.run.id === current ? detail.run : (runs?.find((r) => r.id === current) ?? null);
  const done = shown && (shown.status === "completed" || shown.status === "incomplete") ? shown : null;
  const answer = useSessionAnswer(pr.id, done?.id ?? null);
  const again = () => {
    setPicked(null);
    setListAgain(true);
  };
  const frame = (children: ReactNode, footer: ReactNode) => (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[640px]"
      onKeyDown={dialogKeys(onClose)}
      finalFocus={finalFocus}
    >
      <DialogHeader>
        <DialogTitle>Ask your session</DialogTitle>
        <DialogDescription>
          <span translate="no">{prKey(pr)}</span>. {runner} resumes a copy of the session that wrote the code and asks it about the review
          points. Your session stays as it was. Nothing posts.
        </DialogDescription>
      </DialogHeader>
      {children}
      <DialogFooter>{footer}</DialogFooter>
    </DialogContent>
  );

  if (current === null)
    return <SessionPicker pr={pr} frame={frame} onStarted={(id) => setPicked(id)} onClose={onClose} announce={announce} runner={runner} />;
  if (done && answer.data)
    return (
      <AnswerBody
        pr={pr}
        announce={announce}
        onClose={onClose}
        onChanged={onChanged}
        onFix={onFix}
        finalFocus={finalFocus}
        given={{ ...answer.data, run: done.id, title: titleOf(done.consult?.title ?? null) }}
      />
    );
  if (!shown || done)
    return frame(
      <Loading error={answer.error} what="the answer" />,
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>,
    );
  if (shown.status === "running")
    return frame(
      <SessionRunning run={shown.id} startedAt={shown.startedAt} fix={shown.consult?.mode === "fix"} />,
      <RunningFooter id={shown.id} onClose={onClose} />,
    );
  return frame(
    <Alert variant={shown.status === "failed" ? "destructive" : "default"} role="status">
      {shown.status === "failed" ? <CircleAlert aria-hidden /> : <CircleStop aria-hidden />}
      <AlertTitle>{shown.status === "failed" ? "The session run failed." : "The session run was cancelled."}</AlertTitle>
      {shown.errorText && <AlertDescription className="[overflow-wrap:anywhere]">{shown.errorText}</AlertDescription>}
    </Alert>,
    <>
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>
      <Button id="session-again" onClick={again}>
        <History aria-hidden data-icon="inline-start" />
        Ask again
      </Button>
    </>,
  );
}

function SessionRunning({ run, startedAt, fix }: { run: number; startedAt: number; fix: boolean }) {
  const now = useNow(true);
  const calls = useRun(run).data?.events.length ?? 0;
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="grid gap-2">
      <p id="session-state" role="status" className="m-0 flex items-center gap-2 text-sm font-medium">
        <LoaderCircle aria-hidden className="size-[15px] animate-spin motion-reduce:animate-none" />
        {fix ? "Your session is answering and proposing fixes…" : "Your session is answering…"}
      </p>
      <p className="m-0 text-sm text-ink-2">
        {plural(calls, "tool call")}, {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}.
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        You can close this dialog. The run goes on. Its row under the review shows the answer when it ends.
      </p>
    </div>
  );
}

function RunningFooter({ id, onClose }: { id: number; onClose: () => void }) {
  const cancel = useCancelRun();
  return (
    <>
      <Button
        id="session-cancel"
        variant="ghost"
        className="sm:mr-auto"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(id, { onError: (e) => toast.add({ title: "Cancel failed", description: failText(e) }) })}
      >
        <CircleStop aria-hidden data-icon="inline-start" />
        {cancel.isPending ? "Cancelling…" : "Cancel the run"}
      </Button>
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>
    </>
  );
}

type Frame = (children: ReactNode, footer: ReactNode) => ReactNode;

function SessionPicker({
  pr,
  frame,
  onStarted,
  onClose,
  announce,
  runner,
}: {
  pr: PrRow;
  frame: Frame;
  onStarted: (run: number) => void;
  onClose: () => void;
  announce: (text: string) => void;
  runner: string;
}) {
  const q = useConsultData(pr.id, true);
  const list = useSessions(pr.id, true);
  const { groups, tick } = useGroups();
  const [choice, setChoice] = useState<string | null>(null);
  const [mode, setMode] = useState(loadMode);
  const start = useStartSession(pr.id);
  const { note: busy, refused } = useSlots(pr.id, runner);
  const t = useMemo(() => q.data && consultText(q.data, groups, "session"), [q.data, groups]);
  const sessions = list.data?.sessions ?? [];
  // The first session is the best match: in the clone, else the newest.
  const pick: SessionDto | null = sessions.find((s) => s.id === choice) ?? sessions[0] ?? null;
  const now = Date.now();
  const ready = !!pick && !!t?.ids.length && !start.isPending && !busy;
  const pickMode = (m: SessionMode) => {
    setMode(m);
    saveMode(m);
  };
  const ask = () => {
    if (!pick || !ready) return;
    start.mutate(
      { session: pick.id, groups: consultGroups.filter((g) => groups.has(g)), mode },
      {
        onSuccess: (r) => {
          if ("conflict" in r) {
            toast.add({ title: "The session was not asked", description: refused(r.conflict) });
            return;
          }
          announce(`Asked ${titleOf(pick.title)}. Your session is answering${mode === "fix" ? " and proposing fixes" : ""}.`);
          onStarted(r.run.id);
        },
        onError: (e) => toast.add({ title: "The session was not asked", description: failText(e) }),
      },
    );
  };
  return frame(
    <>
      {!t ? <Loading error={q.error} /> : <GroupBoxes t={t} groups={groups} tick={tick} />}
      {!list.data ? (
        <Loading error={list.error} what="your sessions" />
      ) : (
        <FieldSet className="gap-0">
          <FieldLegend variant="label">
            Session on branch{" "}
            <code translate="no" className="font-mono text-xs">
              {list.data.branch}
            </code>
          </FieldLegend>
          {sessions.length ? (
            sessions.map((s) => (
              <label key={s.id} className={rowBox} data-session={s.id}>
                <input
                  type="radio"
                  name="session"
                  className="m-0 mt-[3px] accent-foreground"
                  checked={pick?.id === s.id}
                  aria-describedby={`ss-${s.id}-about`}
                  onChange={() => setChoice(s.id)}
                />
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                  <b className="font-semibold [overflow-wrap:anywhere]">{titleOf(s.title)}</b>
                  {s.inClone && <Badge variant="soft">In your clone</Badge>}
                </span>
                <span id={`ss-${s.id}-about`} className="col-start-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  <span translate="no">{s.folder || "unknown folder"}</span>, last used {agoLong(s.lastAt, now)}, {sizeText(s.bytes)}, about{" "}
                  {s.tokens.toLocaleString()} tokens
                </span>
              </label>
            ))
          ) : (
            <p className="m-0 py-2 text-sm text-muted-foreground">
              No session of yours is on this branch. The app looks only at your newest transcripts.
            </p>
          )}
        </FieldSet>
      )}
      <FieldSet className="gap-0">
        <FieldLegend variant="label">Your session</FieldLegend>
        {sessionModes.map((m) => (
          <label key={m} className={rowBox} data-session-mode={m}>
            <input
              type="radio"
              name="session-mode"
              className="m-0 mt-[3px] accent-foreground"
              checked={mode === m}
              aria-describedby={`sm-${m}-about`}
              onChange={() => pickMode(m)}
            />
            <b className="text-sm font-semibold">{MODE[m].name}</b>
            <span id={`sm-${m}-about`} className="col-start-2 text-xs text-muted-foreground">
              {MODE[m].about}
            </span>
          </label>
        ))}
      </FieldSet>
      <p id="session-cost" className="m-0 text-sm text-ink-2">
        {busy
          ? busy
          : !pick
            ? "Pick a session first."
            : t && !t.ids.length
              ? "Nothing to ask. Tick a group with items."
              : `The resume loads the whole history of this session: ${sizeText(pick.bytes)}, up to about ${pick.tokens.toLocaleString()} tokens of your plan quota. The review points add ${t ? kb(t.bytes) : "some text"}.${mode === "fix" ? ` Judge and propose fixes allows up to ${SESSION_FIX_MAX_TURNS} turns instead of ${SESSION_MAX_TURNS}. Each turn sends the history again, so this mode uses more quota.` : ""}`}
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        The app reads only the folder, branch, time, and title lines of your transcripts. It never shows or stores their message text.
      </p>
    </>,
    <>
      <Button variant="outline" onClick={onClose}>
        Cancel
      </Button>
      <Button id="session-ask" disabled={!ready} aria-describedby="session-cost" onClick={ask}>
        <Send aria-hidden data-icon="inline-start" />
        {start.isPending ? "Asking…" : "Ask the session"}
      </Button>
    </>,
  );
}
