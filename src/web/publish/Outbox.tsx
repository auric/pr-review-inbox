// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Outbox rows (plan v3 section 7, replies.md step 4): Posting, "Outcome unknown. Checking.", Failed with the reason, and Posted.
// A row with a resolve step then shows Resolving, Resolve failed with "Resolve again", or Resolved. Resolve again never reposts the reply.
// Reply rows show in the thread of their parent. Other rows show in the Posts group above the drafts.
import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, CircleCheck, CircleHelp, LoaderCircle, RotateCw, Send, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { CommentDto, PostDto, ReviewItemDto } from "../../shared/dto";
import { commentUrl } from "../../shared/links";
import { restoreDraft } from "../pr/ReplyComposer";
import { ForgeLink, Text } from "../pr/Thread";
import { replyKey, sendItem } from "../review/data";
import type { Hints } from "../shell/Hint";
import { failText } from "../shell/model";
import { dropPost, planKey, postsKey, replyDiscards, retryPost, retryResolve, usePosts } from "./data";
import { destLabel, mergePosts, type PostView, postSnippet, postView, shownPosts, splitPosts } from "./model";

const icon = "size-[15px] shrink-0";

// The actions of the outbox rows. Stable for one PR, so the memo threads do not render again.
export type PostCtx = {
  again: (p: PostDto) => Promise<void>;
  drop: (p: PostDto, general: boolean) => Promise<void>;
  resolve: (p: PostDto) => Promise<void>;
};

// The rows of one PR, split by place. Rows of earlier visits stay until their synced comment arrives.
export function useOutbox(pr: number, comments: CommentDto[], forge: string) {
  const qc = useQueryClient();
  const posts = usePosts(pr);
  const data = posts.data;
  // A post changes item states, but the outbox names only the PR in SSE. Each new state reloads the run items.
  const sig = data?.map((p) => `${p.id}:${p.state}:${p.resolve?.state ?? ""}`).join() ?? "";
  useEffect(() => {
    if (sig) void qc.invalidateQueries({ queryKey: ["run"] });
  }, [sig, qc]);
  // A failed post can still confirm after Retry, so its draft waits. Drop forgets it. The discard sends the current revision of
  // the draft. A draft that left the open states stays.
  useEffect(() => {
    for (const p of data ?? []) {
      const item = replyDiscards.get(p.id);
      if (item === undefined || p.state !== "confirmed") continue;
      replyDiscards.delete(p.id);
      const it = qc.getQueryData<ReviewItemDto[]>(replyKey(pr))?.find((x) => x.id === item);
      if (!it || (it.status !== "new" && it.status !== "accepted")) continue;
      void sendItem(it.id, { action: "discard", revision: it.revision })
        .catch(() => null)
        .then((r) => {
          void qc.invalidateQueries({ queryKey: replyKey(pr) });
          void qc.invalidateQueries({ queryKey: planKey(pr) });
          void qc.invalidateQueries({ queryKey: ["run"] });
          if (!r || "conflict" in r) toast.add({ title: "Claude's draft reply stays. It changed, or the discard failed." });
        });
    }
  }, [data, qc, pr]);

  const roots = useRef(comments);
  roots.current = comments;
  const ctx = useMemo<PostCtx>(() => {
    const done = () => {
      void qc.invalidateQueries({ queryKey: postsKey(pr) });
      void qc.invalidateQueries({ queryKey: planKey(pr) });
      void qc.invalidateQueries({ queryKey: ["run"] });
    };
    return {
      async again(p) {
        try {
          const row = await retryPost(p.id);
          qc.setQueryData<PostDto[]>(postsKey(pr), (old) => mergePosts(old, [row]));
          if (row.state === "confirmed") toast.add({ title: `The comment is on ${forge} already. Nothing was posted again.` });
        } catch (e) {
          toast.add({ title: "The post did not start", description: failText(e) });
        } finally {
          done();
        }
      },
      async resolve(p) {
        try {
          const row = await retryResolve(p.id);
          qc.setQueryData<PostDto[]>(postsKey(pr), (old) => mergePosts(old, [row]));
        } catch (e) {
          toast.add({ title: "The resolve did not start", description: failText(e) });
        } finally {
          done();
        }
      },
      async drop(p, general) {
        try {
          await dropPost(p.id, general);
          replyDiscards.delete(p.id);
          qc.setQueryData<PostDto[]>(postsKey(pr), (old) => old?.filter((x) => x.id !== p.id));
          if (p.destination.kind === "reply" && p.run === null) {
            const parent = roots.current.find((c) => p.destination.kind === "reply" && c.id === p.destination.parentId);
            if (parent && restoreDraft(pr, parent.rootId, p.body)) toast.add({ title: "Dropped. The text is back in the reply box." });
          } else if (general) toast.add({ title: "The finding goes into the general comment. Post again to send it." });
        } catch (e) {
          toast.add({ title: "The post was not dropped", description: failText(e) });
        } finally {
          done();
        }
      },
    };
  }, [qc, pr, forge]);

  const split = useMemo(() => splitPosts(shownPosts(data ?? [], comments), comments), [data, comments]);
  return { ctx, threads: split.threads, rest: split.rest };
}

// The outer span is a live region that stays, so a screen reader reads each later state. The key gives each state a new node.
function StateMark({ v }: { v: PostView }) {
  const Icon = {
    posting: LoaderCircle,
    checking: LoaderCircle,
    unknown: CircleHelp,
    failed: CircleAlert,
    posted: Check,
    resolved: CircleCheck,
  }[v.kind];
  return (
    <span role="status" className="inline-flex shrink-0">
      <span
        key={v.kind}
        className={cn(
          "rl-fade inline-flex items-center gap-1 font-medium whitespace-nowrap",
          v.kind === "failed" ? "text-destructive" : v.kind === "posted" || v.kind === "resolved" ? "text-ink-2" : "text-foreground",
        )}
      >
        <Icon
          aria-hidden
          className={cn(icon, (v.kind === "posting" || v.kind === "checking") && "animate-spin motion-reduce:animate-none")}
        />
        {v.text}
      </span>
    </span>
  );
}

// Each button waits for its own request. The row stays until the next state arrives.
function Actions({ p, v, ctx }: { p: PostDto; v: PostView; ctx: PostCtx }) {
  const [busy, setBusy] = useState(false);
  if (!v.actions.length) return null;
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {v.actions.includes("resolve") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => ctx.resolve(p))}>
          <RotateCw aria-hidden data-icon="inline-start" />
          Resolve again
        </Button>
      )}
      {v.actions.includes("again") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => ctx.again(p))}>
          <RotateCw aria-hidden data-icon="inline-start" />
          {p.state === "unknown" ? "Post again" : "Retry"}
        </Button>
      )}
      {v.actions.includes("general") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => ctx.drop(p, true))}>
          Move to general comment
        </Button>
      )}
      {v.actions.includes("drop") && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => ctx.drop(p, false))}>
          <Trash2 aria-hidden data-icon="inline-start" />
          Drop
        </Button>
      )}
    </div>
  );
}

// Plan v3 WP13b: a posted row links to its comment on the forge. web: the PR link of the server.
// A failed resolve links to its thread, so the user can resolve it there.
function PostedLink({ p, v, web, forge, hints }: { p: PostDto; v: PostView; web: string | null; forge: string; hints: Hints }) {
  if (!web) return null;
  if (p.resolve && v.actions.includes("resolve"))
    return <ForgeLink href={commentUrl(web, p.resolve.root)} label={`Open the thread in ${forge}`} hints={hints} />;
  if ((v.kind !== "posted" && v.kind !== "resolved") || p.remoteId === null) return null;
  return <ForgeLink href={commentUrl(web, p.remoteId)} label={`Open in ${forge}`} hints={hints} />;
}

// WP13a: Post again reads the remote comments first. A match confirms the post with no second send.
function Reason({ v, forge }: { v: PostView; forge: string }) {
  const text =
    v.kind === "unknown"
      ? `${v.reason ? `${v.reason} ` : ""}Post again checks ${forge} first, so the comment does not post twice.`
      : v.reason;
  return text ? <p className="m-0 mt-1 text-xs text-ink-2 [overflow-wrap:anywhere]">{text}</p> : null;
}

type LinkProps = { web: string | null; hints: Hints };

// One run post in the Posts group (prototype/v3 has no outbox; the row reuses the thread row).
function RunPost({ p, comments, forge, ctx, web, hints }: { p: PostDto; comments: CommentDto[]; forge: string; ctx: PostCtx } & LinkProps) {
  const v = postView(p);
  const d = destLabel(p.destination, comments);
  const text = useMemo(() => postSnippet(p.body, 160), [p.body]);
  return (
    <article
      id={`p-${p.id}`}
      data-post={p.id}
      tabIndex={-1}
      aria-label={`${d.code ? `${d.text} ${d.code}` : d.text}. ${v.text}`}
      className="rl-enter scroll-mt-3 border-b px-1.5 py-2"
    >
      <div className="flex min-w-0 items-center gap-3 text-sm">
        {d.code ? (
          <span translate="no" className="shrink-0 font-mono text-foreground">
            {d.code}
          </span>
        ) : (
          <span className="shrink-0 text-foreground">{d.text}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-ink-2">{text}</span>
        <StateMark v={v} />
        <PostedLink p={p} v={v} web={web} forge={forge} hints={hints} />
      </div>
      <Reason v={v} forge={forge} />
      <Actions p={p} v={v} ctx={ctx} />
    </article>
  );
}

export function PostsGroup({
  posts,
  comments,
  forge,
  ctx,
  web,
  hints,
}: { posts: PostDto[]; comments: CommentDto[]; forge: string; ctx: PostCtx } & LinkProps) {
  if (!posts.length) return null;
  return (
    <div id="g-posts" className="mt-5">
      <h3 className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-1.5 pb-1.5 text-sm font-bold">
        <span className="inline-flex items-center gap-1.5">
          <Send aria-hidden className={cn(icon, "text-ink-2")} />
          Posts to {forge}
        </span>
        <span className="font-medium text-muted-foreground">{posts.length}</span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          A posted comment moves to its thread after the next check.
        </span>
      </h3>
      {posts.map((p) => (
        <RunPost key={p.id} p={p} comments={comments} forge={forge} ctx={ctx} web={web} hints={hints} />
      ))}
    </div>
  );
}

// My replies on the way, under the thread tree. avatar: my avatar, from the thread renderer.
export function ReplyPosts(props: { posts: readonly PostDto[]; avatar: ReactNode; forge: string; ctx: PostCtx } & LinkProps) {
  const { avatar, forge, ctx, web, hints } = props;
  return props.posts.map((p) => {
    const v = postView(p);
    return (
      <article
        key={p.id}
        id={`p-${p.id}`}
        data-post={p.id}
        tabIndex={-1}
        aria-label={`${p.body ? "Your reply" : "Resolve the thread"}. ${v.text}`}
        className="rl-msg rl-enter mt-3.5"
      >
        <div className="flex min-h-(--av) flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
          {avatar}
          <b className="font-semibold text-foreground">You</b>
          <StateMark v={v} />
          <span className="ml-auto">
            <PostedLink p={p} v={v} web={web} forge={forge} hints={hints} />
          </span>
        </div>
        <div className="rl-indent mt-px max-w-[72ch] [overflow-wrap:anywhere]">
          {p.body ? <Text text={p.body} /> : <p className="m-0 text-ink-2">Resolve the thread. No reply.</p>}
          <Reason v={v} forge={forge} />
          <Actions p={p} v={v} ctx={ctx} />
        </div>
      </article>
    );
  });
}
