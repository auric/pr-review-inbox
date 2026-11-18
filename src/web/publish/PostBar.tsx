// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The post part of the bottom bar (prototype/v3 postBar, plan pr-view-v4 2.11): shown while something is accepted. p or the button
// opens the confirm with the exact text and destination of each comment. The confirm keeps the plan it showed: a change on the
// server gives 409 and a new plan.
import { useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import type { BlockedDraft, CommentDto, PostDto, PostPlanDto, PrRow } from "../../shared/dto";
import { itemsSettled, sendItem, usePrRuns } from "../review/data";
import { plural, shortHash } from "../review/model";
import { ApiError } from "../shell/data";
import { failText, prKey } from "../shell/model";
import { type BlockedGroup, Confirm, type ConfirmEntry } from "./Confirm";
import { confirmPosts, fetchPlan, planKey, postsKey, type ResolveOutcome, usePostPlan } from "./data";
import {
  BLOCKED,
  blockedGroups,
  blockedNote,
  blockedText,
  destLabel,
  destText,
  mergePosts,
  olderNote,
  planItems,
  planSig,
  reopenNote,
  resolveLabel,
  resolveNote,
} from "./model";

type Open = { plan: PostPlanDto | null; posting: boolean; error: string | null };

const NOTHING = "Nothing is accepted yet. Accept drafts, questions, or replies first.";
const NONE_NOW = "No accepted draft can post now. Each group below says why.";
const CHANGED = "The list changed while it was open. Read it again before you post.";

export type PostBarApi = { open(): void; close(): void; isOpen: boolean };

const entries = (plan: PostPlanDto, comments: CommentDto[]): ConfirmEntry[] =>
  plan.posts.map((p, i) => {
    const d = destLabel(p.destination, comments);
    return {
      key: `${p.run}:${i}`,
      code: d.code,
      dest: p.body ? d.text : resolveLabel(p.destination, comments),
      body: p.body,
      warning: p.duplicate ? `${p.duplicate.author} raised a similar point on this line.` : null,
      reopen: reopenNote(p),
      resolve: resolveNote(p),
    };
  });

// docs/plans/thread-outcome.md: the blocked drafts by reason. act runs the action of the reason (BLOCKED) on one draft.
const blockedList = (
  blocked: BlockedDraft[],
  comments: CommentDto[],
  thread: (b: BlockedDraft) => void,
  act: (b: BlockedDraft) => void,
): BlockedGroup[] =>
  blockedGroups(blocked).map((g) => {
    const { title, text, action } = BLOCKED[g.reason];
    return {
      key: g.reason,
      title,
      text,
      items: g.items.map((b) => ({
        key: `b:${b.item}`,
        dest: blockedText(b, comments),
        detail: b.commit ?? null,
        onThread: b.thread === undefined ? null : () => thread(b),
        action: action ? { label: action, run: () => act(b) } : null,
      })),
    };
  });

// onPosted: the rows of the confirm, for the focus. announce: the live region of the detail. jump: show and focus a thread.
// reopen: reopen a resolved thread now. "ask": another person started the thread, so its own Reopen button asks first
// (Thread.tsx useResolve).
export function usePostBar(
  pr: PrRow,
  o: {
    comments: CommentDto[];
    forge: string;
    onPosted: (rows: PostDto[]) => void;
    announce: (text: string) => void;
    jump: (thread: number) => void;
    reopen: (thread: number) => Promise<ResolveOutcome | "ask">;
  },
) {
  const qc = useQueryClient();
  const plan = usePostPlan(pr.id);
  const runs = usePrRuns(pr.id).data;
  const [c, setC] = useState<Open | null>(null);
  const posts = plan.data?.posts ?? [];
  const blocked = plan.data?.blocked ?? [];
  const older = blocked.filter((b) => b.reason === "older-commit");
  const [discarding, setDiscarding] = useState(false);
  const key = prKey(pr);

  const close = () => {
    if (c?.posting) return;
    setC(null);
    requestAnimationFrame(() => document.getElementById("post-btn")?.focus({ preventScroll: true }));
  };

  const load = async (error: string | null) => {
    try {
      const fresh = await fetchPlan(pr.id);
      qc.setQueryData(planKey(pr.id), fresh);
      if (!fresh.posts.length && !fresh.blocked?.length) {
        setC(null);
        toast.add({ title: error ?? NOTHING });
        return;
      }
      setC({ plan: fresh, posting: false, error });
    } catch (e) {
      setC(null);
      toast.add({ title: "Cannot load the comments to post", description: failText(e) });
    }
  };

  // docs/plans/review-v2/stale-drafts.md F1: Discard sends the item discard for each older-commit draft. error: the text for the
  // drafts that did not change, else null.
  const discard = async (list: BlockedDraft[]) => {
    setDiscarding(true);
    const out = await Promise.allSettled(list.map((b) => sendItem(b.item, { action: "discard", revision: b.revision })));
    const gone = out.flatMap((r) => (r.status === "fulfilled" && "item" in r.value ? [r.value.item] : []));
    await qc.invalidateQueries({ queryKey: planKey(pr.id) });
    setDiscarding(false);
    const kept = list.length - gone.length;
    return { gone, error: kept ? `Cannot discard ${plural(kept, "draft")}. It changed in another page, or the request failed.` : null };
  };

  // No screen lists a discarded older-commit draft, so the toast of the bar Discard offers Undo. A restore gives the status new,
  // so Undo accepts the draft again. The toast covers the right end of the bar, so Undo closes it.
  const discardOlder = async () => {
    const { gone, error } = await discard(older);
    if (error) toast.add({ title: error });
    if (!gone.length) return;
    const undo = async () => {
      const back = await Promise.allSettled(
        gone.map(async (it) => {
          const r = await sendItem(it.id, { action: "restore", revision: it.revision });
          if ("conflict" in r || "conflict" in (await sendItem(it.id, { action: "accept", revision: r.item.revision })))
            throw new Error("changed");
        }),
      );
      await qc.invalidateQueries({ queryKey: planKey(pr.id) });
      if (back.some((r) => r.status === "rejected"))
        toast.add({ title: "Undo failed", description: "A draft changed in another page, or the request failed." });
    };
    const id = toast.add({
      title: `${plural(gone.length, "draft")} discarded`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toast.close(id);
          void undo();
        },
      },
    });
  };

  // plain: the draft loses its commit link. reply-to-newest: the draft answers the newest message with the same text
  // (docs/plans/thread-outcome.md). The draft stays accepted, so the new plan lists it as a reply to post.
  const fixDraft = async (b: BlockedDraft, action: "plain" | "reply-to-newest", done: string) => {
    try {
      const r = await sendItem(b.item, { action, revision: b.revision });
      if ("conflict" in r) return void (await load(r.conflict.error));
      o.announce(done);
      await load(null);
    } catch (e) {
      await load((e as Error).message);
    }
  };

  // The thread of a blocked draft. The confirm closes, so the thread takes the focus.
  const toThread = (b: BlockedDraft) => {
    if (c?.posting || b.thread === undefined) return;
    setC(null);
    o.jump(b.thread);
  };

  const act = async (b: BlockedDraft) => {
    if (b.reason === "commit-gone") return void (await fixDraft(b, "plain", "The draft is now a plain reply in the list."));
    if (b.reason === "out-of-date")
      return void (await fixDraft(b, "reply-to-newest", "The draft answers the newest message now. It is in the list."));
    // A toast would cover the Discard of the next row, so the live region tells, after the new list.
    if (b.reason === "older-commit") {
      const { gone, error } = await discard([b]);
      await load(error);
      if (gone.length) o.announce("The draft is discarded.");
      return;
    }
    if (b.reason !== "resolved-since" || b.thread === undefined) return;
    const out = await o.reopen(b.thread).catch((e: unknown) => ({ error: (e as Error).message, reason: null }));
    if (out === "ask") return toThread(b);
    if (!out) o.announce("The thread is open again.");
    await load(out?.error ?? null);
  };

  // A plan change while the confirm is open shows the new lists. A change in the posts asks for a new read before Post.
  const fresh = plan.data;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new plan from the server starts this.
  useEffect(() => {
    const shownPlan = c?.plan;
    if (!fresh || !shownPlan || c.posting || planSig(fresh) === planSig(shownPlan)) return;
    // A14: another page can post the shown items, so they leave the plan. The confirm keeps them, and Post answers that they were
    // posted already. A shown item that is blocked now refreshes the confirm.
    const nowBlocked = new Set(fresh.blocked?.map((b) => b.item));
    if (!fresh.posts.length && shownPlan.posts.length && !planItems(shownPlan.posts).some((i) => nowBlocked.has(i.id))) return;
    if (!fresh.blocked?.length && !fresh.posts.length) {
      setC(null);
      toast.add({ title: NOTHING });
      return;
    }
    const moved = shownPlan.posts.length > 0 && planSig({ posts: fresh.posts }) !== planSig({ posts: shownPlan.posts });
    setC({ plan: fresh, posting: false, error: moved ? CHANGED : c.error });
    o.announce("The list to post changed.");
  }, [fresh]);

  // The cached plan can miss a triage request that is still out. Only a plan read after those requests end decides.
  const open = () => {
    if (c) return;
    setC({ plan: null, posting: false, error: null });
    void itemsSettled().then(() => load(null));
  };

  const post = async () => {
    const shown = c?.plan;
    if (!shown || c.posting) return;
    setC({ ...c, posting: true, error: null });
    try {
      const r = await confirmPosts(pr.id, planItems(shown.posts));
      qc.setQueryData<PostDto[]>(postsKey(pr.id), (old) => mergePosts(old, r.posts));
      void qc.invalidateQueries({ queryKey: planKey(pr.id) });
      void qc.invalidateQueries({ queryKey: ["run"] });
      setC(null);
      o.announce(r.existing ? "These comments were posted from another page already." : `Posting ${destText(r.posts)}.`);
      if (r.existing) toast.add({ title: "These comments were posted from another page already. Nothing was posted again." });
      if (r.warning) toast.add({ title: r.warning });
      o.onPosted(r.posts);
    } catch (e) {
      const msg = (e as Error).message;
      // 409: the plan or the source branch changed. The dialog shows the new plan and the reason.
      if (e instanceof ApiError && e.status === 409) await load(msg);
      else setC({ plan: shown, posting: false, error: msg });
    }
  };

  // The preflight line: the reviewed commits, and what the newest run data says about them. Replies have no commits (D14).
  const shown = c?.plan?.posts ?? posts;
  const note = (() => {
    if (!shown.length) return c?.plan ? NONE_NOW : "Reading the comments to post…";
    const review = shown.filter((p) => p.destination.kind !== "reply");
    const replies = review.length < shown.length;
    const reopen = shown.some((p) => p.body && p.reopen)
      ? ` ${o.forge} takes no reply in a resolved thread, so the app reopens it first.`
      : "";
    if (!review.length)
      return `Each reply goes under the message it answers. A resolve runs after its reply. The app checks for newer messages when you post.${reopen}`;
    const at = [...new Set(review.map((p) => p.sourceHead))].map(shortHash).join(", ");
    const reviewed = runs?.filter((r) => review.some((p) => p.run === r.id)) ?? [];
    if (reviewed.some((r) => r.stale?.source))
      return `The source branch has new commits since ${at}. ${o.forge} gets nothing until you review again.`;
    const moved = reviewed.some((r) => r.stale?.target) ? " The target branch moved since the review." : "";
    const also = replies ? ` Replies go under the messages they answer.${reopen}` : "";
    return `Review comments attach to the reviewed commit ${at}.${moved} The app checks the source branch again when you post.${also}`;
  })();

  const api: PostBarApi = { open, close, isOpen: c !== null && !c.posting };
  // Plan pr-view-v4 2.11: the part shares the bottom bar with the fix parts. The confirm takes the place of the part.
  return {
    api,
    part: !c && (posts.length > 0 || blocked.length > 0) && (
      <span data-post-part className="flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-x-3.5 gap-y-2">
        {/* The counts are a live region, so a change reads out while the bar shows. */}
        <span role="status" className="contents">
          {posts.length > 0 && <span>Ready to post: {destText(posts)}</span>}
          {blocked.length > older.length && <span className="text-ink-2">{blockedNote(blocked)}</span>}
          {older.length > 0 && (
            <span id="older-note" className="text-ink-2">
              {olderNote(older)}
            </span>
          )}
        </span>
        {older.length > 0 && (
          <Button size="sm" variant="outline" disabled={discarding} aria-describedby="older-note" onClick={() => void discardOlder()}>
            Discard
          </Button>
        )}
        <Button id="post-btn" size="sm" title="Key: p" aria-keyshortcuts="p" className="ml-auto" onClick={open}>
          <Send aria-hidden data-icon="inline-start" />
          Post to {o.forge}
        </Button>
      </span>
    ),
    confirm: c && (
      <Confirm
        id="post-confirm"
        title={shown.length ? `Post ${destText(shown)} to ${key}?` : `Post to ${key}?`}
        note={note}
        entries={c.plan && entries(c.plan, o.comments)}
        blocked={c.plan?.blocked && blockedList(c.plan.blocked, o.comments, toThread, (b) => void act(b))}
        posting={c.posting}
        error={c.error}
        canPost={!!c.plan && c.plan.posts.length > 0}
        off="Post is off: no accepted draft can post now."
        onPost={() => void post()}
        onCancel={close}
        className="max-h-[62vh] pt-3.5 pb-2.5"
      />
    ),
  };
}
