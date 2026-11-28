// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Reply composer (docs/plans/replies.md step 4): one under each open thread. Ctrl+Enter opens the confirm with the exact text
// and "Reply to <name> in <place>". Unsent text stays in localStorage under rl:reply:<pr>:<thread>.
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CornerDownRight, Eye, Reply, Send } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { MAX_NOTE, type PostDto, type ReviewItemDto } from "../../shared/dto";
import { useMeta } from "../meta";
import { Confirm } from "../publish/Confirm";
import { postReply, postsKey, replyDiscards } from "../publish/data";
import { draftKey, editDraft, mergePosts, parseDraft, placeOf, type ReplyDraft, replyText } from "../publish/model";
import { aiReplyDraft } from "../review/model";
import { Text, type ThreadCtx } from "./Thread";
import type { Node, ThreadModel } from "./threads";

// msg: the message that the Reply button of a message picked. n: a new pick of the same message focuses the box again.
export type ReplyTarget = { msg: number; n: number };

const fresh = (): ReplyDraft => ({ text: "", key: crypto.randomUUID(), used: false });

// Storage can be off or full. The composer then keeps the text in memory only.
function readDraft(k: string): ReplyDraft | null {
  try {
    return parseDraft(localStorage.getItem(k));
  } catch {
    return null;
  }
}
function writeDraft(k: string, d: ReplyDraft) {
  try {
    if (d.text) localStorage.setItem(k, JSON.stringify(d));
    else localStorage.removeItem(k);
  } catch {}
}

// A dropped reply post gives its text back to an empty reply box. A mounted box reloads it.
const restored = new EventTarget();
export function restoreDraft(pr: number, thread: number, text: string): boolean {
  const k = draftKey(pr, thread);
  if (readDraft(k)?.text.trim()) return false;
  writeDraft(k, { ...fresh(), text });
  restored.dispatchEvent(new CustomEvent(k));
  return true;
}

const nameOf = (m: Node) => (m.who.me ? "your message" : m.who.name);

// draft: the AI reply draft of the thread that this post puts out of date, else null. drop: discard it after the post is confirmed.
type Pending = { parent: Node; seen: number; text: string; draft: ReviewItemDto | null; drop: boolean };

// The reply confirm choice for the AI reply draft that the post puts out of date.
export function DropDraftBox(p: { runner: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <label data-drop-draft className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="m-0 accent-foreground"
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.target.checked)}
      />
      {`Also discard ${p.runner}'s draft reply in this thread`}
    </label>
  );
}

// aside: more actions at the end of the composer row, such as Draft reply (WP18).
export function ReplyComposer({
  t,
  target,
  ctx,
  aside,
}: {
  t: ThreadModel;
  target: ReplyTarget | undefined;
  ctx: ThreadCtx;
  aside?: ReactNode;
}) {
  const qc = useQueryClient();
  const runner = useMeta().data?.runner.short ?? "";
  const k = draftKey(ctx.pr, t.id);
  const [d, setD] = useState<ReplyDraft>(() => readDraft(k) ?? fresh());
  const [open, setOpen] = useState(() => d.text !== "");
  const [preview, setPreview] = useState(false);
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The element to focus after the next render.
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    const reload = () => {
      setD(readDraft(k) ?? fresh());
      setOpen(true);
    };
    restored.addEventListener(k, reload);
    return () => restored.removeEventListener(k, reload);
  }, [k]);

  // The Reply button of a message opens the box with focus in the text.
  useEffect(() => {
    if (!target) return;
    setOpen(true);
    setPreview(false);
    setConfirm(null);
    focusNext.current = `rc-ta-${t.id}`;
  }, [target, t.id]);

  useLayoutEffect(() => {
    const id = focusNext.current;
    focusNext.current = null;
    const el = id && document.getElementById(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  });

  // Default target: the newest live message. A picked message must still be live.
  const last = t.last;
  const picked = target && t.msgs.find((m) => m.id === target.msg && !m.deleted);
  const parent = picked || last;
  if (!last || !parent) return null;
  const place = placeOf(t.root);

  const change = (text: string) => {
    const next = editDraft(d, text, () => crypto.randomUUID());
    setD(next);
    writeDraft(k, next);
    setNotice(null);
  };

  const openConfirm = () => {
    const text = d.text.trim();
    if (!text) {
      setNotice("Write the reply first.");
      focusNext.current = `rc-ta-${t.id}`;
      setPreview(false);
      return;
    }
    setNotice(null);
    // seen: the newest live message on screen now. Messages that arrive after this give 409 (WP13a).
    setConfirm({ parent, seen: last.id, text, draft: aiReplyDraft(ctx.replyDraft(t.id), last.id), drop: true });
  };

  const closeConfirm = () => {
    setConfirm(null);
    focusNext.current = preview ? `rc-pv-${t.id}` : `rc-ta-${t.id}`;
  };

  const leave = () => {
    if (!d.text.trim()) setOpen(false);
    document.getElementById(`th-${t.id}`)?.focus({ preventScroll: true });
  };

  const send = async () => {
    if (!confirm || posting) return;
    setPosting(true);
    // The key goes out with this text. A reload keeps it, so the same text never posts twice.
    const used = { ...d, used: true };
    setD(used);
    writeDraft(k, used);
    try {
      const r = await postReply(ctx.pr, { parentId: confirm.parent.id, body: confirm.text, seen: confirm.seen, key: used.key });
      if ("conflict" in r) {
        setConfirm(null);
        setNotice("New messages arrived in this thread. Read them, then post your reply again.");
        void qc.invalidateQueries({ queryKey: ["pr", ctx.pr], exact: true });
        focusNext.current = `rc-ta-${t.id}`;
        setPreview(false);
        return;
      }
      if (confirm.draft && confirm.drop) replyDiscards.set(r.post.id, confirm.draft.id);
      qc.setQueryData<PostDto[]>(postsKey(ctx.pr), (old) => mergePosts(old, [r.post]));
      const next = fresh();
      setD(next);
      writeDraft(k, next);
      setConfirm(null);
      setOpen(false);
      setPreview(false);
      ctx.onReply(t.id, null);
      ctx.announce("Reply posting.");
      focusNext.current = `p-${r.post.id}`;
    } catch (e) {
      setConfirm(null);
      setNotice((e as Error).message);
      focusNext.current = `rc-ta-${t.id}`;
      setPreview(false);
    } finally {
      setPosting(false);
    }
  };

  // Esc closes the confirm first, then leaves the box. The text stays. The shell key handler never sees it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (posting) return;
      if (confirm) closeConfirm();
      else leave();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !confirm) {
      e.preventDefault();
      openConfirm();
    }
  };

  if (!open) {
    return (
      <div className="mt-3.5 flex max-w-[72ch] items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-text items-center gap-2 rounded-lg border bg-pane px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:border-rule-strong"
          onClick={() => {
            setOpen(true);
            focusNext.current = `rc-ta-${t.id}`;
          }}
        >
          <Reply aria-hidden className="size-[15px] shrink-0" />
          Write a reply
        </button>
        {aside}
      </div>
    );
  }

  const label = `Reply to ${nameOf(parent)}`;
  return (
    <section id={`rc-${t.id}`} aria-label={`${label} in ${place}`} className="mt-3.5 max-w-[72ch]" onKeyDown={onKeyDown}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <CornerDownRight aria-hidden className="size-[13px] shrink-0" />
        <span className="min-w-0">
          Replying to <b className="font-semibold text-foreground">{nameOf(parent)}</b>
          {picked && picked.id !== last.id && <span>, an earlier message</span>}
        </span>
        {picked && picked.id !== last.id && (
          <button
            type="button"
            className="rl-hit cursor-pointer rounded text-xs font-medium text-pen hover:underline"
            onClick={() => ctx.onReply(t.id, null)}
          >
            Reply to the newest message
          </button>
        )}
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={preview}
          disabled={!!confirm}
          className="ml-auto text-ink-2 aria-pressed:bg-sel aria-pressed:text-foreground"
          onClick={() => {
            setPreview((p) => !p);
            focusNext.current = preview ? `rc-ta-${t.id}` : null;
          }}
        >
          <Eye aria-hidden data-icon="inline-start" />
          Preview
        </Button>
      </div>
      {preview ? (
        <section
          id={`rc-pv-${t.id}`}
          tabIndex={-1}
          aria-label="Preview of the reply"
          className="min-h-[5.5em] rounded-lg border bg-pane px-2.5 py-2 text-sm [overflow-wrap:anywhere]"
        >
          {d.text.trim() ? <Text text={d.text} /> : <p className="m-0 text-muted-foreground">Nothing to preview yet.</p>}
        </section>
      ) : (
        <Textarea
          id={`rc-ta-${t.id}`}
          aria-label={label}
          aria-describedby={`rc-h-${t.id}`}
          rows={4}
          maxLength={MAX_NOTE}
          spellCheck
          readOnly={!!confirm}
          value={d.text}
          placeholder="Write a reply. Markdown works."
          className="field-sizing-fixed min-h-[5.5em] resize-y bg-pane leading-normal"
          onChange={(e) => change(e.target.value)}
        />
      )}
      {notice && (
        <p role="alert" className="m-0 mt-1.5 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
          {notice}
        </p>
      )}
      {confirm ? (
        <Confirm
          id={`rcc-${t.id}`}
          title={`Post this reply to ${nameOf(confirm.parent)}?`}
          note="The app checks the thread for new messages before it posts."
          entries={[
            {
              key: "reply",
              code: null,
              dest: replyText({ name: nameOf(confirm.parent), place }),
              body: confirm.text,
              warning: null,
              reopen: t.turn === "resolved" ? "The thread is resolved. Reopen thread, post reply." : null,
              resolve: null,
            },
          ]}
          posting={posting}
          error={null}
          canPost
          onPost={() => void send()}
          onCancel={closeConfirm}
          extra={
            confirm.draft && (
              <DropDraftBox
                runner={runner}
                checked={confirm.drop}
                disabled={posting}
                onChange={(drop) => setConfirm((c) => c && { ...c, drop })}
              />
            )
          }
          className="mt-2.5 rounded-lg border border-rule-strong bg-pane px-3.5 pt-3 pb-3"
        />
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Button size="sm" aria-keyshortcuts="Control+Enter" title="Key: Ctrl+Enter" onClick={openConfirm}>
            <Send aria-hidden data-icon="inline-start" />
            Post reply…
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const text = d.text;
              change("");
              setOpen(false);
              ctx.onReply(t.id, null);
              document.getElementById(`th-${t.id}`)?.focus({ preventScroll: true });
              if (text.trim())
                toast.add({
                  title: "Reply discarded",
                  actionProps: { children: "Undo", onClick: () => restoreDraft(ctx.pr, t.id, text) },
                });
            }}
          >
            {d.text ? "Discard" : "Close"}
          </Button>
          <span id={`rc-h-${t.id}`} className="ml-1 text-xs text-muted-foreground">
            Ctrl+Enter shows the reply before it posts. Esc keeps the text.
          </span>
          {aside && <span className="ml-auto">{aside}</span>}
        </div>
      )}
    </section>
  );
}
