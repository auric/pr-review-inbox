// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 2.7: the Notes block of the PR view, under the description. Each run reads the kept notes. A
// suggestion of the runner counts only after Keep. No new global key: the block sits in the tab order after the description.
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, Undo2, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { MetaDto, NoteConflict, NoteDto, NoteUpdateInput } from "../../shared/dto";
import { api } from "../api";
import { useMeta } from "../meta";
import { replyKey } from "../review/data";
import type { Focus } from "../review/useReview";
import { chipText, fromText, THREAD_DELETED } from "./notes-model";
import type { ThreadModel } from "./threads";

const param = (id: number) => ({ param: { id: String(id) } });
export const notesKey = (pr: number) => ["pr", pr, "notes"] as const;

// GET /api/prs/:id/notes: kept notes and suggestions, oldest first. live.ts refreshes ['pr', pr] keys on `changed`.
export const useNotes = (pr: number) =>
  useQuery({
    queryKey: notesKey(pr),
    queryFn: async () => {
      const res = await api.api.prs[":id"].notes.$get(param(pr));
      if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status}).`);
      return (await res.json()) as NoteDto[];
    },
  });

// A note change answers with the note, with the current note of a 409, or with the error sentence.
export type NoteChange = { note: NoteDto } | { conflict: NoteConflict } | { error: string };

async function changed(res: Response): Promise<NoteChange> {
  if (res.ok) return { note: (await res.json()) as NoteDto };
  const text = await res.text();
  let body: Partial<NoteConflict> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  if (res.status === 409 && body.note) return { conflict: body as NoteConflict };
  return { error: body.error ?? (text || `Request failed (${res.status}).`) };
}

const STALE = "The note changed in another place. The current note is shown.";

// The list keeps the notes that GET lists: kept and proposed, not deleted. The draft cards show the suggestions too.
function store(qc: QueryClient, pr: number, n: NoteDto) {
  qc.setQueryData<NoteDto[]>(notesKey(pr), (old) => {
    const rest = (old ?? []).filter((x) => x.id !== n.id);
    if (n.deletedAt || n.state === "dismissed") return rest;
    return [...rest, n].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  });
  void qc.invalidateQueries({ queryKey: replyKey(pr) });
}

// Sends one change and updates the cache. Returns the error sentence, or null.
export function useNoteSend(pr: number) {
  const qc = useQueryClient();
  return async (send: () => Promise<Response>): Promise<{ note: NoteDto | null; error: string | null }> => {
    let r: NoteChange;
    try {
      r = await changed(await send());
    } catch (e) {
      return { note: null, error: (e as Error).message };
    }
    if ("note" in r) {
      store(qc, pr, r.note);
      return { note: r.note, error: null };
    }
    if ("conflict" in r) {
      store(qc, pr, r.conflict.note);
      return { note: null, error: STALE };
    }
    return { note: null, error: r.error };
  };
}

export const putNote = (id: number, json: NoteUpdateInput) =>
  api.api.notes[":id"].$put({ ...param(id), json }) as unknown as Promise<Response>;

// A text button in a line of small text. The target is 24 px high (WCAG 2.5.8).
const linkButton =
  "-mx-1 inline-flex min-h-6 cursor-pointer items-center gap-1 rounded px-1 text-sm font-medium text-pen hover:underline disabled:cursor-default disabled:opacity-50";
const h2 = "m-0 flex items-baseline gap-2 text-[15px] font-bold tracking-[-0.005em]";

type Edit = { id: number | "new"; opener: string };

// pr, own: the PR and its repository. threads: the threads of the PR, for the "From the thread of" line. jump: opens and focuses a thread.
export function Notes(props: {
  pr: number;
  own: { project: string; repo: string };
  threads: readonly ThreadModel[];
  jump: (thread: number) => void;
  announce: (text: string) => void;
  focusAfter: (f: Focus) => void;
}) {
  const { pr, own, threads, announce, focusAfter } = props;
  const meta: MetaDto | undefined = useMeta().data;
  const list = useNotes(pr).data ?? [];
  const send = useNoteSend(pr);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [error, setError] = useState<{ id: number | "new"; text: string } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<number | "new">>(new Set());
  // Deleted notes keep their row with Undo for 10 s.
  const [deleted, setDeleted] = useState<ReadonlyMap<number, NoteDto>>(new Map());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t.values()) clearTimeout(id);
    };
  }, []);

  const proposed = list.filter((n) => n.state === "proposed");
  // Only kept notes offer Delete, so only they leave a "Note deleted." row.
  const rows = [...list.filter((n) => n.state === "kept"), ...deleted.values()].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);

  const run = async (id: number | "new", call: () => Promise<Response>) => {
    setBusy((b) => new Set(b).add(id));
    setError(null);
    const r = await send(call);
    setBusy((b) => {
      const out = new Set(b);
      out.delete(id);
      return out;
    });
    if (r.error) setError({ id, text: r.error });
    return r.note;
  };

  const close = (e: Edit) => {
    setEdit(null);
    focusAfter({ id: document.getElementById(e.opener) ? e.opener : "notes-add", block: "nearest", flash: false });
  };

  // After Keep or Dismiss, the focus goes to the next suggestion, else to "Add a note".
  const afterChoice = (n: NoteDto) => {
    const rest = proposed.filter((x) => x.id !== n.id);
    const next = rest.find((x) => x.createdAt > n.createdAt || (x.createdAt === n.createdAt && x.id > n.id)) ?? rest[0];
    focusAfter({ id: next ? `note-keep-${next.id}` : "notes-add", block: "nearest", flash: false });
  };
  const keep = async (n: NoteDto) => {
    if (await run(n.id, () => putNote(n.id, { version: n.version, state: "kept" }))) {
      announce("Note kept.");
      afterChoice(n);
    }
  };
  const dismiss = async (n: NoteDto) => {
    if (await run(n.id, () => putNote(n.id, { version: n.version, state: "dismissed" }))) {
      announce("Suggestion dismissed.");
      afterChoice(n);
    }
  };
  const remove = async (n: NoteDto) => {
    const gone = await run(
      n.id,
      () => api.api.notes[":id"].$delete({ ...param(n.id), json: { version: n.version } }) as unknown as Promise<Response>,
    );
    if (!gone) return;
    setDeleted((d) => new Map(d).set(n.id, gone));
    timers.current.set(
      n.id,
      setTimeout(() => {
        timers.current.delete(n.id);
        setDeleted((d) => {
          const out = new Map(d);
          out.delete(n.id);
          return out;
        });
      }, 10_000),
    );
    announce("Note deleted.");
    focusAfter({ id: `note-undo-${n.id}`, block: "nearest", flash: false });
  };
  const undo = async (n: NoteDto) => {
    const back = await run(n.id, () => putNote(n.id, { version: n.version, restore: true }));
    if (!back) return;
    clearTimeout(timers.current.get(n.id));
    timers.current.delete(n.id);
    setDeleted((d) => {
      const out = new Map(d);
      out.delete(n.id);
      return out;
    });
    announce("Note restored.");
    focusAfter({ id: back.state === "proposed" ? `note-keep-${n.id}` : `note-edit-${n.id}`, block: "nearest", flash: false });
  };
  // A new note, an edit, or an edit of a suggestion, which keeps it in one step. ref: only a changed PR number goes out.
  const save = async (e: Edit, text: string, prId: number | null) => {
    const cur = e.id === "new" ? null : list.find((x) => x.id === e.id);
    const ref = prId === (cur?.ref?.prId ?? null) ? undefined : prId === null ? null : { prId };
    const note =
      e.id === "new"
        ? await run(
            "new",
            () => api.api.prs[":id"].notes.$post({ ...param(pr), json: { text, ...(ref && { ref }) } }) as unknown as Promise<Response>,
          )
        : cur
          ? await run(cur.id, () =>
              putNote(cur.id, {
                version: cur.version,
                text,
                ...(ref !== undefined && { ref }),
                ...(cur.state === "proposed" && { state: "kept" as const }),
              }),
            )
          : null;
    if (!note) return;
    announce(cur?.state === "proposed" ? "Note kept." : "Note saved.");
    setEdit(null);
    focusAfter({ id: e.id === "new" ? "notes-add" : `note-edit-${note.id}`, block: "nearest", flash: false });
  };

  const open = (id: number | "new", opener: string) => {
    setError(null);
    setEdit({ id, opener });
  };
  const box = (id: number | "new", n?: NoteDto) =>
    edit?.id === id && (
      <NoteBox
        key={id}
        text={n?.text ?? ""}
        prId={n?.ref?.prId ?? null}
        busy={busy.has(id)}
        error={error?.id === id ? error.text : null}
        save={(text, prId) => save(edit, text, prId)}
        cancel={() => close(edit)}
      />
    );
  const err = (id: number) =>
    error?.id === id &&
    edit?.id !== id && (
      <p role="alert" className="m-0 text-sm text-destructive">
        {error.text}
      </p>
    );

  // The runner name comes from the meta query, which the shell loads first.
  if (!meta) return null;
  const short = meta.runner.short;
  const empty = !rows.length && !proposed.length;
  const add = (
    <Button id="notes-add" size="sm" variant="outline" disabled={!!edit} onClick={() => open("new", "notes-add")}>
      <Plus aria-hidden data-icon="inline-start" />
      Add a note
    </Button>
  );
  return (
    <section id="s-notes" aria-labelledby="h-notes" className="grid max-w-[86ch] scroll-mt-3 grid-cols-[minmax(0,1fr)] gap-2.5 pt-6">
      {empty ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <h2 id="h-notes" className={h2}>
            Notes
          </h2>
          <p className="m-0 text-sm text-muted-foreground">Notes for this PR. {short} reads them before each run.</p>
          {!edit && add}
        </div>
      ) : (
        <h2 id="h-notes" className={h2}>
          Notes
        </h2>
      )}
      {rows.length > 0 && (
        <ul className="m-0 grid list-none gap-2 p-0" aria-label="Notes">
          {rows.map((n) =>
            deleted.has(n.id) ? (
              <Deleted key={n.id} n={n} busy={busy.has(n.id)} undo={() => undo(n)} error={err(n.id)} />
            ) : (
              <li key={n.id} id={`note-${n.id}`} className="grid gap-1 rounded-lg border border-rule px-3 py-2">
                {edit?.id === n.id ? (
                  box(n.id, n)
                ) : (
                  <>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{n.text}</p>
                      {n.ref && (
                        <Badge variant="quiet" data-note-ref>
                          {chipText(n.ref, own)}
                        </Badge>
                      )}
                    </div>
                    {n.source !== "user" && <p className="m-0 text-xs text-muted-foreground">Kept from {short}'s suggestion</p>}
                    <div className="flex flex-wrap items-center gap-x-3">
                      <button
                        type="button"
                        id={`note-edit-${n.id}`}
                        className={linkButton}
                        disabled={!!edit || busy.has(n.id)}
                        onClick={() => open(n.id, `note-edit-${n.id}`)}
                      >
                        <Pencil aria-hidden className="size-3.5" />
                        Edit
                      </button>
                      <button type="button" className={linkButton} disabled={busy.has(n.id)} onClick={() => remove(n)}>
                        <Trash2 aria-hidden className="size-3.5" />
                        Delete
                      </button>
                    </div>
                    {err(n.id)}
                  </>
                )}
              </li>
            ),
          )}
        </ul>
      )}
      {proposed.length > 0 && (
        <div className="grid gap-2">
          <h3 className="m-0 text-sm font-semibold">{short} suggests</h3>
          <p className="m-0 text-sm text-muted-foreground">{short} does not use a suggestion until you keep it.</p>
          <ul className="m-0 grid list-none gap-2 p-0" aria-label={`${short} suggests`}>
            {proposed.map((n) => {
              const from = fromText(n, threads);
              const gone = from === THREAD_DELETED;
              return (
                <li key={n.id} id={`note-${n.id}`} className="grid gap-1 rounded-lg border border-dashed border-rule-strong px-3 py-2">
                  {edit?.id === n.id ? (
                    box(n.id, n)
                  ) : (
                    <>
                      <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{n.text}</p>
                      {from &&
                        (gone || n.thread === null ? (
                          <p className="m-0 text-xs text-muted-foreground">{from}</p>
                        ) : (
                          <p className="m-0 text-xs text-muted-foreground">
                            <button type="button" className={cn(linkButton, "text-xs")} onClick={() => props.jump(n.thread as number)}>
                              {from}
                            </button>
                          </p>
                        ))}
                      <div className="flex flex-wrap items-center gap-x-3">
                        <button
                          type="button"
                          id={`note-keep-${n.id}`}
                          className={linkButton}
                          disabled={busy.has(n.id)}
                          onClick={() => keep(n)}
                        >
                          <Check aria-hidden className="size-3.5" />
                          Keep
                        </button>
                        <button
                          type="button"
                          className={linkButton}
                          disabled={!!edit || busy.has(n.id)}
                          onClick={() => open(n.id, `note-keep-${n.id}`)}
                        >
                          <Pencil aria-hidden className="size-3.5" />
                          Edit
                        </button>
                        <button type="button" className={linkButton} disabled={busy.has(n.id)} onClick={() => dismiss(n)}>
                          <X aria-hidden className="size-3.5" />
                          Dismiss
                        </button>
                      </div>
                      {err(n.id)}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {box("new")}
      {!empty && !edit && <div>{add}</div>}
    </section>
  );
}

function Deleted(props: { n: NoteDto; busy: boolean; undo: () => void; error: ReactNode }) {
  return (
    <li id={`note-${props.n.id}`} className="flex flex-wrap items-center gap-x-3 px-3 py-1 text-sm text-muted-foreground">
      Note deleted.
      <button type="button" id={`note-undo-${props.n.id}`} className={linkButton} disabled={props.busy} onClick={props.undo}>
        <Undo2 aria-hidden className="size-3.5" />
        Undo
      </button>
      {props.error}
    </li>
  );
}

// The inline box of "Add a note" and "Edit": the text, an optional PR number, Save (Ctrl+Enter), Cancel (Esc).
function NoteBox(props: {
  text: string;
  prId: number | null;
  busy: boolean;
  error: string | null;
  save: (text: string, prId: number | null) => void;
  cancel: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(props.text);
  const [pr, setPr] = useState(props.prId === null ? "" : String(props.prId));
  useEffect(() => {
    const ta = ref.current;
    ta?.focus();
    ta?.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  const prId = /^\d+$/.test(pr.trim()) && Number(pr.trim()) > 0 ? Number(pr.trim()) : null;
  const bad = pr.trim() !== "" && prId === null;
  const go = () => {
    if (!text.trim() || bad || props.busy) return;
    props.save(text.trim(), prId);
  };
  // Esc closes only this box. The shell key handler never sees it.
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.cancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      go();
    }
  };
  return (
    <div className="grid gap-2">
      <label htmlFor={`${id}-text`} className="text-sm font-medium">
        Note
      </label>
      <Textarea
        ref={ref}
        id={`${id}-text`}
        name="note"
        autoComplete="off"
        rows={3}
        value={text}
        className="field-sizing-fixed min-h-[5em] resize-y bg-pane leading-normal"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-pr`} className="text-sm">
          Waits for PR #
        </label>
        <Input
          id={`${id}-pr`}
          name="waits-for-pr"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          className="w-24"
          value={pr}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? `${id}-bad` : undefined}
          onChange={(e) => setPr(e.target.value)}
          onKeyDown={keys}
        />
        <span className="text-xs text-muted-foreground">Optional</span>
      </div>
      {bad && (
        <p id={`${id}-bad`} className="m-0 text-sm text-destructive">
          Write a PR number, such as 45.
        </p>
      )}
      {props.error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {props.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={props.busy || !text.trim() || bad}
          aria-keyshortcuts="Control+Enter"
          title="Key: Ctrl+Enter"
          onClick={go}
        >
          <Check aria-hidden data-icon="inline-start" />
          Save
        </Button>
        <Button size="sm" variant="outline" title="Key: Esc" onClick={props.cancel}>
          Cancel
        </Button>
        <span className="ml-1 text-xs text-muted-foreground">Ctrl+Enter saves. Esc cancels.</span>
      </div>
    </div>
  );
}
