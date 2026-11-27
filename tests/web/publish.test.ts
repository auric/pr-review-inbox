// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan v3 WP14a: the pure publish UI rules. Post states, confirm text, the place of outbox rows, and the reply draft store.
import { describe, expect, test } from "bun:test";
import type { BlockedDraft, CommentDto, PlannedPost, PostDestination, PostDto } from "../../src/shared/dto";
import {
  BLOCKED,
  blockedGroups,
  blockedNote,
  blockedText,
  destLabel,
  destText,
  draftKey,
  editDraft,
  mergePosts,
  olderNote,
  parentOf,
  parseDraft,
  planItems,
  planSig,
  postSnippet,
  postView,
  readyLine,
  reopenNote,
  resolveLabel,
  resolveNote,
  shownPosts,
  splitPosts,
  threadText,
} from "../../src/web/publish/model";

const inline: PostDestination = { kind: "inline", path: "src/cache/flush.ts", srcPath: null, line: 3, lineEnd: 3, lineType: "add" };
const general: PostDestination = { kind: "general" };
const reply = (parentId: number): PostDestination => ({ kind: "reply", parentId });

const post = (id: number, destination: PostDestination, o: Partial<PostDto> = {}): PostDto => ({
  id,
  pr: 1,
  run: destination.kind === "reply" ? null : 7,
  destination,
  body: `Body ${id}`,
  items: [],
  state: "pending",
  remoteId: null,
  remoteVersion: null,
  attempts: 0,
  lastError: null,
  checking: false,
  createdAt: 1,
  updatedAt: 1,
  ...o,
});

const comment = (id: number, o: Partial<CommentDto> = {}): CommentDto => ({
  id,
  version: 0,
  parentId: null,
  rootId: id,
  authorSlug: "alex",
  authorName: "Alex Smith",
  authorLogin: "alex",
  text: "Text",
  anchor: null,
  threadResolved: false,
  createdAt: 1,
  updatedAt: 1,
  unread: false,
  deleted: false,
  ...o,
});

describe("confirm text", () => {
  test("destText names each destination with its count", () => {
    const planned = (d: PostDestination, body = "Text") => ({ destination: d, body });
    expect(destText([planned(inline), planned(inline), planned(general)])).toBe("2 inline comments and 1 general comment");
    expect(destText([planned(general)])).toBe("1 general comment");
    expect(destText([planned(reply(5)), planned(reply(6))])).toBe("2 replies");
    expect(destText([planned(inline), planned(general), planned(reply(5))])).toBe("1 inline comment, 1 general comment and 1 reply");
    // A reply post without a body only resolves its thread.
    expect(destText([planned(reply(5)), planned(reply(6), "")])).toBe("1 reply and 1 thread resolve");
    expect(destText([planned(reply(6), "")])).toBe("1 thread resolve");
  });

  test("a reply names the author of its parent and the place of the thread", () => {
    const root = comment(100, { anchor: { path: "src/cache/flush.ts", line: 3 } });
    const kid = comment(101, { parentId: 100, rootId: 100, authorName: null, authorSlug: "mlopez" });
    expect(destLabel(reply(101), [root, kid])).toEqual({ code: null, text: "Reply to mlopez in src/cache/flush.ts:3" });
    expect(parentOf(200, [comment(200)])).toEqual({ name: "Alex Smith", place: "the general comment" });
    expect(destLabel(reply(999), [root])).toEqual({ code: null, text: "Reply" });
    // Gate v3 U4: a CONTEXT anchor holds old line 7. The place names new line 9, the line that the excerpt marks.
    const ctx = comment(300, {
      anchor: { path: "sample1.md", line: 7, lineType: "CONTEXT", fileType: "TO" },
      excerpt: [{ n: 9, kind: "ctx", text: "x", hit: true }],
    });
    expect(parentOf(300, [ctx])?.place).toBe("sample1.md:9");
    expect(parentOf(300, [{ ...ctx, excerpt: undefined }])?.place).toBe("sample1.md");
    // Gate A U2: a range comment names its span.
    const span = { srcSpanStart: 3, srcSpanEnd: 10, dstSpanStart: 3, dstSpanEnd: 12 };
    const range = comment(400, { anchor: { path: "sample1.md", line: 10, lineType: "CONTEXT", fileType: "FROM", multilineSpan: span } });
    expect(parentOf(400, [range])?.place).toBe("sample1.md:3–12");
  });

  test("an inline destination shows the file name and the line range", () => {
    expect(destLabel(inline, [])).toEqual({ code: "flush.ts:3", text: "Inline comment" });
    expect(destLabel({ ...inline, lineEnd: 5 }, []).code).toBe("flush.ts:3–5");
    expect(destLabel(general, [])).toEqual({ code: null, text: "General comment" });
  });

  test("confirm sends every item of the plan with the revision on screen", () => {
    const p = (items: PlannedPost["items"]) =>
      ({
        run: 7,
        sourceHead: "a",
        targetHead: "b",
        mergeBase: null,
        destination: general,
        body: "",
        items,
        duplicate: null,
      }) as PlannedPost;
    expect(planItems([p([{ id: 1, revision: 2 }]), p([{ id: 3, revision: 0 }])])).toEqual([
      { id: 1, revision: 2 },
      { id: 3, revision: 0 },
    ]);
  });
});

describe("post states", () => {
  test("pending and sent show Posting with no action", () => {
    for (const state of ["pending", "sent"] as const)
      expect(postView(post(1, inline, { state }))).toMatchObject({ kind: "posting", actions: [] });
  });

  test("unknown shows Checking while the app reads the remote comments, then the reason", () => {
    expect(postView(post(1, inline, { state: "unknown", checking: true }))).toEqual({
      kind: "checking",
      text: "Outcome unknown. Checking.",
      reason: null,
      actions: ["again", "drop"],
    });
    expect(postView(post(1, inline, { state: "unknown", lastError: "No matching comment." }))).toMatchObject({
      kind: "unknown",
      reason: "No matching comment.",
      actions: ["again", "drop"],
    });
  });

  test("failed shows the reason; only an inline post can move to the general comment", () => {
    expect(postView(post(1, inline, { state: "failed", lastError: "HTTP 400" }))).toMatchObject({
      kind: "failed",
      reason: "HTTP 400",
      actions: ["again", "general", "drop"],
    });
    expect(postView(post(2, general, { state: "failed" }))).toMatchObject({
      reason: "No reason was recorded.",
      actions: ["again", "drop"],
    });
    expect(postView(post(3, reply(5), { state: "failed" })).actions).toEqual(["again", "drop"]);
  });

  test("confirmed shows Posted", () => {
    expect(postView(post(1, inline, { state: "confirmed", remoteId: 9 }))).toMatchObject({ kind: "posted", actions: [] });
  });

  test("a confirmed row with a resolve step shows Resolving, Resolve failed with Resolve again, or Resolved", () => {
    const step = (state: "pending" | "done" | "failed", body = "Body", error: string | null = null) =>
      postView(post(1, reply(5), { state: "confirmed", remoteId: 9, body, resolve: { root: 4, state, error } }));
    expect(step("pending")).toEqual({ kind: "posting", text: "Posted. Resolving the thread…", reason: null, actions: [] });
    expect(step("pending", "")).toMatchObject({ text: "Resolving the thread…" });
    expect(step("failed", "Body", "Bitbucket refused.")).toEqual({
      kind: "failed",
      text: "Posted. Resolve failed.",
      reason: "Bitbucket refused.",
      actions: ["resolve"],
    });
    expect(step("failed", "")).toMatchObject({ text: "Resolve failed.", reason: "No reason was recorded." });
    expect(step("done")).toEqual({ kind: "resolved", text: "Posted and resolved.", reason: null, actions: [] });
    expect(step("done", "")).toMatchObject({ kind: "resolved", text: "Resolved." });
    // The comment step comes first: a failed comment shows its own retry, never Resolve again.
    expect(postView(post(1, reply(5), { state: "failed", resolve: { root: 4, state: "pending", error: null } })).actions).toEqual([
      "again",
      "drop",
    ]);
  });

  test("a resolve-only post names the thread; the confirm line says what happens", () => {
    const root = comment(100, { anchor: { path: "src/cache/flush.ts", line: 3 } });
    expect(resolveLabel(reply(100), [root])).toBe("Resolve the thread in src/cache/flush.ts:3");
    expect(resolveLabel(reply(999), [root])).toBe("Resolve the thread");
    expect(resolveNote({ body: "Text", resolve: 100 })).toBe("Then resolves the thread.");
    expect(resolveNote({ body: "", resolve: 100 })).toBe("Resolves the thread. No reply is posted.");
    expect(resolveNote({ body: "Text" })).toBeNull();
  });

  test("a reply in a resolved thread names the reopen in the count and in the confirm line", () => {
    const planned = (body: string, reopen?: PlannedPost["reopen"]) => ({ destination: reply(5), body, ...(reopen && { reopen }) });
    expect(destText([planned("Text", "resolved"), planned("Text")])).toBe("2 replies and 1 thread reopen");
    expect(destText([planned("Text", "resolved"), planned("")])).toBe("1 reply, 1 thread reopen and 1 thread resolve");
    expect(reopenNote({ body: "Text", reopen: "resolved" })).toBe("The thread is resolved. Reopen thread, post reply.");
    expect(reopenNote({ body: "Text" })).toBeNull();
    expect(reopenNote({ body: "", reopen: "resolved" })).toBeNull();
  });

  test("thread outcome: a draft that cannot post names its thread and says why and what to do", () => {
    const root = comment(100, { anchor: { path: "src/cache/flush.ts", line: 3 }, authorName: null, authorSlug: "mlopez" });
    expect(threadText(100, [root])).toBe("Thread of mlopez in src/cache/flush.ts:3");
    expect(threadText(200, [comment(200)])).toBe("Thread of Alex Smith in the general comment");
    expect(threadText(999, [root])).toBe("Thread 999");
    expect(BLOCKED["out-of-date"]).toEqual({
      title: "Out of date",
      text: "New messages since the draft. Reply to the newest as is, or revise it in the thread.",
      action: "Reply to the newest as is",
    });
    expect(BLOCKED["resolved-since"]).toEqual({
      title: "Resolved since the draft",
      text: "Reopen the thread to post.",
      action: "Reopen thread",
    });
    expect(BLOCKED.unpushed).toEqual({ title: "Fix commit not pushed", text: "Push the fix commit first.", action: null });
    expect(BLOCKED["commit-gone"]).toEqual({
      title: "Commit not on the branch",
      text: "The commit is not on the branch. Post as plain reply.",
      action: "Post as plain reply",
    });
    // docs/plans/review-v2/stale-drafts.md F1: a finding names its line, a question has no place, a reply names its thread.
    expect(BLOCKED["older-commit"]).toEqual({
      title: "On an older commit",
      text: "The review ran on an older commit. Review changes (c) carries these drafts, or Discard.",
      action: "Discard",
    });
    const older = { item: 1, revision: 1, reason: "older-commit" as const, commit: "abc1234" };
    expect(blockedText({ ...older, path: "src/cache/flush.ts", line: 3 }, [root])).toBe("src/cache/flush.ts:3");
    expect(blockedText(older, [root])).toBe("Question");
    expect(blockedText({ item: 2, revision: 1, thread: 100, reason: "out-of-date" }, [root])).toBe(
      "Thread of mlopez in src/cache/flush.ts:3",
    );
  });

  test("thread outcome: blocked drafts group by reason in a fixed order, and the bar counts the out-of-date ones", () => {
    const b = (item: number, reason: BlockedDraft["reason"], commit?: string): BlockedDraft => ({
      item,
      revision: 1,
      thread: 100 + item,
      reason,
      ...(commit && { commit }),
    });
    const list = [b(1, "commit-gone", "c0ffee0"), b(2, "out-of-date"), b(3, "unpushed", "abc1234"), b(4, "out-of-date")];
    expect(blockedGroups(list).map((g) => [g.reason, g.items.map((i) => i.item)])).toEqual([
      ["out-of-date", [2, 4]],
      ["unpushed", [3]],
      ["commit-gone", [1]],
    ]);
    expect(blockedGroups([])).toEqual([]);
    expect(blockedNote([])).toBe("");
    expect(blockedNote([b(1, "unpushed")])).toBe("1 draft cannot post now");
    expect(blockedNote([b(1, "out-of-date")])).toBe("1 draft out of date");
    expect(blockedNote(list)).toBe("4 drafts cannot post now, 2 out of date");
    // docs/plans/review-v2/stale-drafts.md F1: the older-commit drafts group last and have their own bar line.
    const older = (item: number): BlockedDraft => ({ item, revision: 1, reason: "older-commit", commit: "abc1234" });
    expect(blockedGroups([older(5), ...list]).map((g) => g.reason)).toEqual(["out-of-date", "unpushed", "commit-gone", "older-commit"]);
    expect(blockedNote([older(5), ...list])).toBe("4 drafts cannot post now, 2 out of date");
    expect(blockedNote([older(5)])).toBe("");
    expect(olderNote(list)).toBe("");
    expect(olderNote([older(5), ...list])).toBe("1 draft is on an older commit. Review changes (c) carries it, or Discard.");
    expect(olderNote([older(5), older(6)])).toBe("2 drafts are on an older commit. Review changes (c) carries them, or Discard.");
    expect(readyLine({ posts: [], blocked: [older(5), older(6)] })).toEqual({ posts: null, blocked: "2 cannot post" });
  });

  test("thread outcome: the Ready to post line names the posts and the drafts that cannot post", () => {
    const p = { run: 1, destination: reply(5), body: "Text", items: [{ id: 7, revision: 2 }] } as unknown as PlannedPost;
    const blocked: BlockedDraft[] = [{ item: 8, revision: 1, thread: 5, reason: "unpushed", commit: "c0ffee0" }];
    expect(readyLine({ posts: [] })).toBeNull();
    expect(readyLine({ posts: [], blocked: [] })).toBeNull();
    expect(readyLine({ posts: [p] })).toEqual({ posts: "1 reply", blocked: null });
    expect(readyLine({ posts: [], blocked })).toEqual({ posts: null, blocked: "1 cannot post" });
    expect(readyLine({ posts: [p], blocked })).toEqual({ posts: "1 reply", blocked: "1 cannot post" });
    // The confirm refreshes on a new signature only.
    expect(planSig({ posts: [p], blocked })).toBe(planSig({ posts: [{ ...p }], blocked: blocked.map((x) => ({ ...x })) }));
    expect(planSig({ posts: [p], blocked })).not.toBe(planSig({ posts: [p] }));
    expect(planSig({ posts: [p] })).not.toBe(planSig({ posts: [{ ...p, items: [{ id: 7, revision: 3 }] }] }));
  });
});

describe("outbox rows", () => {
  test("a confirmed row shows until the synced comment with its ID arrives", () => {
    const rows = [
      post(1, inline, { state: "confirmed", remoteId: 50 }),
      post(2, inline, { state: "confirmed", remoteId: 51 }),
      post(3, general),
    ];
    expect(shownPosts(rows, [comment(50)]).map((p) => p.id)).toEqual([2, 3]);
    // A deleted comment still counts as synced.
    expect(shownPosts(rows, [comment(50), comment(51, { deleted: true })]).map((p) => p.id)).toEqual([3]);
  });

  test("a row with a resolve step stays until the thread shows resolved; a resolve-only row then hides", () => {
    const step = (id: number, state: "pending" | "done" | "failed", body = "Body") =>
      post(id, reply(101), { state: "confirmed", remoteId: body ? 50 + id : null, body, resolve: { root: 100, state, error: null } });
    const rows = [step(1, "pending"), step(2, "failed"), step(3, "done"), step(4, "done", ""), step(5, "failed", "")];
    const open = [comment(100), comment(51), comment(52), comment(53)];
    expect(shownPosts(rows, open).map((p) => p.id)).toEqual([1, 2, 5]);
    const resolved = [comment(100, { threadResolved: true }), comment(51), comment(52), comment(53)];
    expect(shownPosts(rows, resolved).map((p) => p.id)).toEqual([]);
  });

  test("a reply row goes to the thread of its parent; other rows and unknown parents go to the posts group", () => {
    const cs = [comment(100), comment(101, { parentId: 100, rootId: 100 })];
    const { threads, rest } = splitPosts([post(1, reply(101)), post(2, inline), post(3, reply(999)), post(4, reply(100))], cs);
    expect([...threads].map(([t, ps]) => [t, ps.map((p) => p.id)])).toEqual([[100, [1, 4]]]);
    expect(rest.map((p) => p.id)).toEqual([2, 3]);
  });

  test("new rows replace old rows of the same ID, in ID order", () => {
    const merged = mergePosts([post(2, inline), post(1, general)], [post(2, inline, { state: "confirmed" }), post(3, general)]);
    expect(merged.map((p) => [p.id, p.state])).toEqual([
      [1, "pending"],
      [2, "confirmed"],
      [3, "pending"],
    ]);
    expect(mergePosts(undefined, [post(1, inline)]).map((p) => p.id)).toEqual([1]);
  });
});

describe("post snippet", () => {
  test("a posted body shows as one line of plain text, without the Markdown marks", () => {
    expect(postSnippet("\u{1F916} **Blocker:** The lock covers `write()`. See [the docs](https://example.test/a).", 160)).toBe(
      "\u{1F916} Blocker: The lock covers write(). See the docs.",
    );
    expect(postSnippet("# Title\n\n- one *item*\n- ~~two~~\n\n```ts\nconst a = 1;\n```", 160)).toBe("Title one item two const a = 1;");
    expect(postSnippet("first  \nsecond\nthird", 160)).toBe("first second third");
    expect(postSnippet("**Nit:** abcdefgh", 10)).toBe("Nit: abcd…");
    expect(postSnippet("", 10)).toBe("");
  });
});

describe("reply draft store", () => {
  test("the key names the PR and the thread", () => {
    expect(draftKey(4, 1000003)).toBe("rl:reply:4:1000003");
  });

  test("only a complete draft parses", () => {
    expect(parseDraft(JSON.stringify({ text: "Hi", key: "k", used: false }))).toEqual({ text: "Hi", key: "k", used: false });
    for (const raw of [null, "", "{", "[]", JSON.stringify({ text: "Hi" }), JSON.stringify({ text: 1, key: "k", used: false })])
      expect(parseDraft(raw)).toBeNull();
  });

  test("a text change after a send gets a new key; the same text keeps the key", () => {
    const next = () => "new-key";
    expect(editDraft({ text: "a", key: "k", used: false }, "ab", next)).toEqual({ text: "ab", key: "k", used: false });
    expect(editDraft({ text: "a", key: "k", used: true }, "a", next)).toEqual({ text: "a", key: "k", used: true });
    expect(editDraft({ text: "a", key: "k", used: true }, "ab", next)).toEqual({ text: "ab", key: "new-key", used: false });
  });
});
