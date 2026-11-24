// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 2.8: the pure builder of context/pr-context.md and context/notes.md, and the loader over
// database rows with a stub provider and the fake Bitbucket. No runner.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/server/bitbucket/client";
import { createBitbucketProvider } from "../../src/server/bitbucket/provider";
import {
  DESCRIPTION_BYTES,
  FOCUS_THREADS_BYTES,
  notesFile,
  PEER_PRS_READ,
  PEER_SECTION_BYTES,
  PR_CONTEXT_BYTES,
  type PrContextInput,
  type PrContextThread,
  prContextFile,
  STACK_SECTION_BYTES,
  type StackPr,
} from "../../src/server/review/context-files";
import { clearPeerCache, loadPrContext, PEER_GATE_TEXT, type PrContextReader } from "../../src/server/review/pr-context";
import type { Heads } from "../../src/server/review/run-rows";
import { UNTRUSTED } from "../../src/server/review/workspace";
import { openDb } from "../../src/server/storage/db";
import type { PullRequest } from "../../src/shared/types";
import { FAKE_TOKEN, key, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";

const HEAD = "a1b2c3d".padEnd(40, "0");
const BASE = "9f8e7d6".padEnd(40, "0");
const T0 = Date.UTC(2026, 9, 19, 9, 12);
const MIN = 60_000;
const size = (s: string) => Buffer.byteLength(s);
const ZERO = { successful: 0, inProgress: 0, failed: 0, cancelled: 0, unknown: 0 };

const msg = (id: number, o: Partial<PrContextThread["msgs"][number]> = {}) => ({
  id,
  author: "Carol Diaz",
  mine: false,
  at: T0 + id * MIN,
  text: `Message ${id}.`,
  ...o,
});
const thread = (id: number, o: Partial<PrContextThread> = {}): PrContextThread => ({
  id,
  place: "general comment",
  path: null,
  starter: { author: "Carol Diaz", mine: false },
  resolved: false,
  state: "Open",
  msgs: [msg(id)],
  ...o,
});
const input = (o: Partial<PrContextInput> = {}): PrContextInput => ({
  pr: {
    project: "PROJ",
    repo: "repo",
    prId: 12,
    state: "OPEN",
    title: "Retry the client",
    author: "Ihor",
    mine: true,
    source: "feature/retry",
    sourceHead: HEAD,
    target: "main",
    targetHead: BASE,
    description: "Adds a retry.",
  },
  tasks: [{ key: "ABC-12", summary: "Trim spaces in user names" }],
  build: { stats: { ...ZERO, successful: 2, failed: 1 } },
  threads: [],
  focus: [],
  paths: [],
  peers: [],
  peerNotes: [],
  ...o,
});

describe("prContextFile", () => {
  test("the layout of spec.md section 2.8: PR, tasks, build, focus threads in full, digests with the State line, other PRs", () => {
    const f = prContextFile(
      input({
        threads: [
          thread(101, {
            place: "inline comment on src/client.ts line 40",
            path: "src/client.ts",
            msgs: [msg(101, { text: "Add a retry around fetchUser." }), msg(105, { author: "Ihor", mine: true, text: "Will do." })],
          }),
          thread(230, {
            starter: { author: "Bob Lee", mine: false },
            state: "Settled",
            msgs: [
              msg(230, { author: "Bob Lee", text: "Callers retry." }),
              msg(240, { author: "Ihor", mine: true }),
              msg(245, { author: "Ihor", mine: true, text: "Agreed. No retry in the client." }),
            ],
          }),
        ],
        focus: [101],
        peers: [
          {
            prId: 45,
            title: "Mac build scripts",
            author: "Anna Kim",
            state: "OPEN",
            target: "main",
            updated: Date.UTC(2026, 9, 21),
            paths: ["CMakeLists.txt", "build/mac.sh"],
          },
        ],
      }),
    );
    expect(f.name).toBe("pr-context.md");
    expect(f.text).toBe(
      [
        "## Pull request",
        "- Number: PROJ/repo#12, open. Author: Ihor (the user).",
        "- Title: Retry the client",
        "- Source: feature/retry at a1b2c3d. Target: main at 9f8e7d6.",
        "- Description:",
        "",
        "    Adds a retry.",
        "",
        "## Linked tasks",
        "- ABC-12: Trim spaces in user names",
        "",
        "## Build",
        "- Head a1b2c3d: 2 successful, 1 failed, 0 in progress.",
        "",
        "## Threads that this run works on",
        "",
        "### Thread 101 · inline comment on src/client.ts line 40 · started by Carol Diaz (another person)",
        "- State: Open",
        "",
        "#### Message 101 by Carol Diaz (another person), 2026-10-19T10:53Z",
        "",
        "    Add a retry around fetchUser.",
        "",
        "#### Message 105 by the user, 2026-10-19T10:57Z",
        "",
        "    Will do.",
        "",
        "## Other threads",
        "",
        "### Thread 230 · general comment · started by Bob Lee (another person)",
        "- Messages: 3, by Bob Lee and the user. Newest: 2026-10-19T13:17Z.",
        "- State: Settled",
        "- First message 230 by Bob Lee:",
        "",
        "    Callers retry.",
        "",
        "- Newest message 245 by the user:",
        "",
        "    Agreed. No retry in the client.",
        "",
        "## Other open pull requests that change the same files",
        "",
        '- #45 "Mac build scripts" by Anna Kim, open, into main, updated 2026-10-21. Same files: CMakeLists.txt, build/mac.sh.',
        "",
      ].join("\n"),
    );
    expect(f).toMatchObject({ threads: 2, left: 0, peers: 1 });
  });

  test("no focus thread: one Threads section; one live message shows once; no task gives None.; the build words", () => {
    const f = prContextFile(input({ tasks: [], build: { stats: ZERO }, threads: [thread(7)] }));
    expect(f.text).toContain("## Linked tasks\nNone.");
    expect(f.text).toContain("- Head a1b2c3d: No builds reported.");
    expect(f.text).not.toContain("## Threads that this run works on");
    expect(f.text).toContain("## Threads\n\n### Thread 7 · general comment");
    expect(f.text).toContain("- Messages: 1, by Carol Diaz.");
    expect(f.text).toContain("- Message 7 by Carol Diaz:\n\n    Message 7.");
    expect(f.text).not.toContain("First message");
    expect(f.text).not.toContain("## Other open pull requests");
    const odd = prContextFile(input({ build: { stats: { ...ZERO, inProgress: 1, cancelled: 2, unknown: 3 } } }));
    expect(odd.text).toContain("- Head a1b2c3d: 0 successful, 0 failed, 1 in progress, 2 cancelled, 3 unknown.");
    expect(prContextFile(input({ build: { error: "Bitbucket error server 500" } })).text).toContain(
      "- Head a1b2c3d: Not read: Bitbucket error server 500.",
    );
    expect(prContextFile(input({ threads: [] })).text).toContain("## Threads\n\nNone.");
  });

  test("the description cut keeps whole code points and names pr.md; the snippets cut at 300 characters with an ellipsis", () => {
    const desc = `${"é".repeat(DESCRIPTION_BYTES / 2 - 1)}x😀tail`;
    const f = prContextFile(input({ pr: { ...input().pr, description: desc } }));
    expect(f.text).toContain("- Description (the first 4 KB; pr.md holds all of it):");
    expect(f.text).not.toContain("�");
    expect(f.text).not.toContain("tail");
    const long = `${"🙂".repeat(299)}ab`;
    const d = prContextFile(input({ threads: [thread(9, { msgs: [msg(9, { text: long })] })] }));
    expect(d.text).toContain(`    ${"🙂".repeat(299)}…\n`);
  });

  test("AC-P4: 200 threads stay under 48 KB with the banner; unresolved threads on a focus path come first; the count line names the rest; the same rows give the same bytes", () => {
    const text = "x".repeat(400);
    const threads = Array.from({ length: 200 }, (_, i) => {
      const id = 1000 + i;
      const onPath = i % 10 === 0;
      return thread(id, {
        path: onPath ? "src/client.ts" : "src/other.ts",
        place: `inline comment on ${onPath ? "src/client.ts" : "src/other.ts"} line 3`,
        resolved: i % 3 === 0 && !onPath,
        msgs: [msg(id, { text, at: T0 + i * MIN }), msg(id + 5000, { text, at: T0 + i * MIN + 1 })],
      });
    });
    const i = input({ threads, focus: [], paths: ["src/client.ts"] });
    const f = prContextFile(i);
    expect(size(UNTRUSTED + f.text)).toBeLessThanOrEqual(PR_CONTEXT_BYTES);
    expect(f.left).toBeGreaterThan(0);
    expect(f.text).toContain(`${f.left} more threads left out. pr.md holds every message.`);
    const shown = [...f.text.matchAll(/^### Thread (\d+)/gm)].map((m) => Number(m[1]));
    expect(shown.length).toBe(f.threads);
    // Group (a): the 20 threads on the focus path, newest first.
    const first = threads
      .filter((t) => t.path === "src/client.ts")
      .map((t) => t.id)
      .sort((a, b) => b - a);
    expect(shown.slice(0, first.length)).toEqual(first);
    // Group (b) before group (c): no resolved thread before an unresolved one.
    const resolved = new Set(threads.filter((t) => t.resolved).map((t) => t.id));
    const firstResolved = shown.findIndex((id) => resolved.has(id));
    if (firstResolved >= 0) expect(shown.slice(firstResolved).every((id) => resolved.has(id))).toBe(true);
    // Inside a group: newest message first.
    const b = shown.slice(first.length).filter((id) => !resolved.has(id));
    expect(b).toEqual([...b].sort((x, y) => y - x));
    expect(prContextFile(structuredClone(i)).text).toBe(f.text);
  });

  test("AC-P4 rule 2: an oversized focus thread keeps its root and its newest 3 messages, and a line counts the rest", () => {
    const big = "y".repeat(3000);
    const msgs = Array.from({ length: 20 }, (_, k) => msg(500 + k, { text: `${k}:${big}`, at: T0 + k * MIN }));
    const f = prContextFile(input({ threads: [thread(500, { msgs })], focus: [500] }));
    const section = f.text.slice(f.text.indexOf("## Threads that this run works on"), f.text.indexOf("## Other threads"));
    expect(size(section)).toBeLessThanOrEqual(FOCUS_THREADS_BYTES + 2);
    const kept = [...section.matchAll(/^#### Message (\d+)/gm)].map((m) => Number(m[1]));
    expect(kept[0]).toBe(500);
    expect(kept.slice(-3)).toEqual([517, 518, 519]);
    expect(section).toContain(`${20 - kept.length} older messages left out. pr.md holds them.`);
    // The root and the newest 3 alone above the cap: the section is cut, and the file stays under the cap.
    const huge = "z".repeat(9000);
    const four = [500, 501, 502, 503].map((id, k) => msg(id, { text: huge, at: T0 + k }));
    const g = prContextFile(input({ threads: [thread(500, { msgs: four })], focus: [500] }));
    expect(g.text).toContain("The app cut this section at its size limit. pr.md holds every message.");
    expect(size(UNTRUSTED + g.text)).toBeLessThanOrEqual(PR_CONTEXT_BYTES);
  });

  test("rule 3: other PRs sort by overlap, then update, then number; at most 10 PRs, 10 paths, and 6 KB", () => {
    const peer = (prId: number, paths: number, updated: number) => ({
      prId,
      title: `PR ${prId}`,
      author: "Anna Kim",
      state: "OPEN",
      target: "main",
      updated,
      paths: Array.from({ length: paths }, (_, k) => `src/f${String(k).padStart(2, "0")}.ts`),
    });
    const peers = [peer(3, 1, 5), peer(1, 2, 1), peer(2, 2, 9), ...Array.from({ length: 12 }, (_, k) => peer(100 + k, 1, 1))];
    const f = prContextFile(input({ peers }));
    const lines = f.text.split("\n").filter((l) => l.startsWith("- #"));
    expect(lines.slice(0, 3).map((l) => l.split(" ")[1])).toEqual(["#2", "#1", "#3"]);
    expect(lines.length).toBe(10);
    expect(f.text).toContain(`${peers.length - 10} more pull requests left out.`);
    const many = prContextFile(input({ peers: [peer(9, 13, 1)] }));
    expect(many.text).toContain("src/f09.ts +3 more.");
    const wide = prContextFile(input({ peers: Array.from({ length: 10 }, (_, k) => ({ ...peer(k + 1, 1, 1), title: "t".repeat(1200) })) }));
    const section = wide.text.slice(wide.text.indexOf("## Other open pull requests"));
    expect(size(section)).toBeLessThanOrEqual(PEER_SECTION_BYTES);
    expect(section).toMatch(/\d+ more pull requests left out\./);
    expect(prContextFile(input({ peerNotes: [PEER_GATE_TEXT] })).text).toContain(
      `## Other open pull requests that change the same files\n\nNone found.\n\n${PEER_GATE_TEXT}`,
    );
  });
});

describe("prContextFile with a stack (stacked-prs.md section 5.3)", () => {
  const pr = (prId: number, o: Partial<StackPr> = {}): StackPr => ({
    prId,
    title: `PR ${prId}`,
    author: "Anna Kim",
    mine: false,
    state: "OPEN",
    source: `feat/${prId}`,
    target: "main",
    sourceHead: HEAD,
    updated: Date.UTC(2026, 10, 20),
    paths: [],
    description: "",
    ...o,
  });
  const paths = (n: number, len: number, tag: string) => Array.from({ length: n }, (_, k) => `${tag}${k}/`.padEnd(len, "x"));

  test("K3: an absent stack gives the bytes of today; the section stands after the PR and before the tasks", () => {
    const plain = prContextFile(input());
    expect(prContextFile(input({ stack: undefined })).text).toBe(plain.text);
    expect(plain.text).not.toContain("Stacked");
    const text = prContextFile(input({ stack: { parents: [pr(40)], children: [], childrenLeft: 0, notes: [] } })).text;
    expect(text.indexOf("## Pull request")).toBe(0);
    expect(text).toContain(
      '\n\n## Stacked pull requests\n\n### Parent #40 "PR 40" by Anna Kim, open, updated 2026-11-20\n- Source: feat/40 at a1b2c3d. Target: main.\n- Changed paths (0).\n\n## Linked tasks',
    );
  });

  test("AC-SK6: the section stays within 8 KB and cuts in the order of section 5.3; the heading and the parent line stay", () => {
    const stages = new Set<number>();
    for (let len = 20; len <= 760; len += 10) {
      const stack = {
        parents: [
          pr(40, { paths: paths(30, len, "p"), description: "PARENT-DESC ".repeat(100) }),
          pr(41, { paths: paths(10, len, "u") }),
          pr(42, { paths: paths(10, len, "u") }),
        ],
        children: [50, 51, 52].map((id) => pr(id, { paths: paths(10, len, "c"), description: "CHILD-DESC ".repeat(100) })),
        childrenLeft: 2,
        notes: ["Not read: the changed paths of #60 (Bitbucket error timeout)."],
      };
      const text = prContextFile(input({ stack })).text;
      const section = text.slice(text.indexOf("## Stacked pull requests"), text.indexOf("## Linked tasks") - 2);
      expect(size(section)).toBeLessThanOrEqual(STACK_SECTION_BYTES);
      expect(section).toContain('### Parent #40 "PR 40" by Anna Kim, open');
      const childDesc = section.includes("CHILD-DESC");
      const uppers = (section.match(/### Parent of/g) ?? []).length;
      const children = (section.match(/### Child/g) ?? []).length;
      const parentCut = section.includes("+20 more");
      const parentDesc = section.includes("PARENT-DESC");
      if (childDesc) expect([uppers, children, parentCut, parentDesc]).toEqual([2, 3, false, true]);
      if (uppers) expect(children).toBe(3);
      if (children < 3) expect(uppers).toBe(0);
      if (parentCut) expect(children).toBe(0);
      if (!parentDesc) expect(parentCut).toBe(true);
      expect(section).toContain(`${2 + 3 - children} more child pull requests left out.`);
      stages.add(childDesc ? 0 : uppers ? 1 : children ? 2 : !parentCut ? 3 : parentDesc ? 4 : 5);
    }
    // Each step of the cut order ran for some length.
    expect([...stages].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("notesFile", () => {
  test("kept notes, oldest first, one line each with the link state; null without a note", () => {
    expect(notesFile([], { project: "PROJ", repo: "repo" })).toBeNull();
    const f = notesFile(
      [
        { id: 7, createdAt: Date.UTC(2026, 9, 20), text: "No retry in\nthe client.", ref: null },
        {
          id: 9,
          createdAt: Date.UTC(2026, 9, 21),
          text: "Wait for the Mac build.",
          ref: { project: "PROJ", repo: "repo", prId: 45, title: "Mac build scripts", state: "MERGED" },
        },
        {
          id: 11,
          createdAt: Date.UTC(2026, 9, 22),
          text: "Wait for the API.",
          ref: { project: "OTHER", repo: "api", prId: 3, title: null, state: "MISSING" },
        },
      ],
      { project: "PROJ", repo: "repo" },
    );
    expect(f?.text).toBe(
      [
        "# Notes of the user",
        "",
        "The user wrote or kept these notes for this pull request. They are the user's decisions.",
        "",
        "- Note 7 (2026-10-20): No retry in the client.",
        '- Note 9 (2026-10-21): Wait for the Mac build. Waits for PR #45 "Mac build scripts" (merged).',
        "- Note 11 (2026-10-22): Wait for the API. Waits for PR OTHER/api#3 (not found).",
        "",
      ].join("\n"),
    );
    expect(f?.text.startsWith(UNTRUSTED)).toBe(false);
  });
});

// ---------- loadPrContext ----------

type Setup = { db: Database; pr: Heads };

function setup(): Setup {
  const db = openDb(":memory:");
  const row = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
        source_branch, target_branch, updated_date) VALUES ('PROJ', 'repo', 12, 'Retry', 'Adds a retry.', 'ihor', 'Ihor', 'AUTHOR', 'OPEN',
        $head, $base, 'feature/retry', 'main', 1) RETURNING *`,
    )
    .get({ head: HEAD, base: BASE }) as Heads;
  return { db, pr: row };
}

function comment(
  db: Database,
  pr: number,
  o: {
    id: number;
    root?: number;
    slug?: string;
    name?: string;
    text?: string;
    at?: number;
    deleted?: boolean;
    resolved?: boolean;
    path?: string;
    line?: number;
  },
) {
  const root = o.root ?? o.id;
  db.query(
    `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, author_name, text, anchor_json, thread_resolved, created_at,
      updated_at, tombstoned_at) VALUES ($pr, $id, 0, $parent, $root, $slug, $name, $text, $anchor, $resolved, $at, $at, $deleted)`,
  ).run({
    pr,
    id: o.id,
    parent: root === o.id ? null : root,
    root,
    slug: o.slug ?? "carol",
    name: o.name ?? "Carol Diaz",
    text: o.text ?? `Text ${o.id}.`,
    anchor: o.path ? JSON.stringify({ path: o.path, line: o.line ?? 1, lineType: "ADDED", fileType: "TO" }) : null,
    resolved: o.resolved ? 1 : 0,
    at: o.at ?? T0 + o.id,
    deleted: o.deleted ? T0 : null,
  });
}

const changes = (db: Database, pr: number, list: [string, string | null][]) => {
  for (const [path, src] of list)
    db.query("INSERT INTO pr_change (pr, path, src_path, type) VALUES ($pr, $path, $src, $type)").run({
      pr,
      path,
      src,
      type: src ? "MOVE" : "MODIFY",
    });
};
const otherPr = (db: Database, id: number, o: { repo?: string; state?: string } = {}) =>
  (
    db
      .query(
        `INSERT INTO pull_request (project, repo, pr_id, title, author_name, state, target_branch, updated_date) VALUES ('PROJ', $repo, $id,
          $title, 'Anna Kim', $state, 'main', $updated) RETURNING id`,
      )
      .get({ repo: o.repo ?? "repo", id, title: `Peer ${id}`, state: o.state ?? "OPEN", updated: Date.UTC(2026, 9, 21) }) as { id: number }
  ).id;

const never = () => Promise.reject(new Error("no call expected"));
const stub = (o: Partial<PrContextReader> = {}): PrContextReader => ({
  buildStats: async () => ({ ...ZERO, successful: 1 }),
  listOpenPullRequests: never,
  listChanges: never,
  getPullRequest: never,
  defaultBranch: never,
  ...o,
});
const load = (s: Setup, provider: PrContextReader | null, o: { focus?: number[]; peerReads?: boolean; signal?: AbortSignal } = {}) =>
  loadPrContext(s.db, provider, s.pr, { threads: o.focus ?? [] }, o.signal ?? new AbortController().signal, {
    me: "ihor",
    dataDir: "/tmp/rl-none",
    now: T0,
    peerReads: o.peerReads ?? false,
  });
const openPr = (id: number, updatedDate: number): PullRequest =>
  ({
    ref: { project: "PROJ", repo: "repo", id },
    version: 0,
    title: `Remote ${id}`,
    description: undefined,
    state: "OPEN",
    author: { slug: "anna", name: "Anna Kim", login: "anna" },
    reviewers: [],
    sourceHead: HEAD,
    targetHead: BASE,
    sourceBranch: "x",
    targetBranch: "main",
    updatedDate,
  }) as unknown as PullRequest;

afterEach(() => clearPeerCache());

describe("loadPrContext", () => {
  test("threads: places, the user words, live messages only; a fully deleted thread leaves; the gate line without Bitbucket reads", async () => {
    const s = setup();
    comment(s.db, s.pr.id, { id: 101, path: "src/client.ts", line: 40, text: "Add a retry." });
    comment(s.db, s.pr.id, { id: 102, root: 101, slug: "ihor", name: "Ihor", text: "Will do." });
    comment(s.db, s.pr.id, { id: 103, root: 101, deleted: true, text: "DELETED-CANARY" });
    comment(s.db, s.pr.id, { id: 200, deleted: true, text: "GONE-CANARY" });
    comment(s.db, s.pr.id, { id: 300, text: "General." });
    const c = await load(s, stub(), { focus: [101] });
    expect(c.input.threads.map((t) => t.id)).toEqual([101, 300]);
    const t101 = c.input.threads[0] as PrContextThread;
    expect(t101).toMatchObject({ place: "inline comment on src/client.ts line 40", path: "src/client.ts", resolved: false });
    expect(t101.msgs.map((m) => [m.id, m.mine])).toEqual([
      [101, false],
      [102, true],
    ]);
    expect(c.input.paths).toEqual(["src/client.ts"]);
    expect(c.input.build).toEqual({ stats: { ...ZERO, successful: 1 } });
    expect(c.input.peerNotes).toEqual([PEER_GATE_TEXT]);
    const text = prContextFile(c.input).text;
    expect(text).not.toContain("DELETED-CANARY");
    expect(text).not.toContain("GONE-CANARY");
    expect(text).toContain("- Number: PROJ/repo#12, open. Author: Ihor (the user).");
    // No provider: the file says so and the run goes on.
    expect((await load(s, null)).input).toMatchObject({
      build: { error: "no Bitbucket connection" },
      peerNotes: [expect.stringContaining("no Bitbucket connection")],
    });
  });

  test("PEER_READS is on: a run without the option reads the open-PR list (Gates G9 and G12)", async () => {
    const s = setup();
    changes(s.db, s.pr.id, [["src/client.ts", null]]);
    const provider = stub({
      listOpenPullRequests: async () => ({ items: [openPr(60, 5)], complete: true }),
      listChanges: async () => ({ items: [{ path: "src/client.ts", srcPath: null, type: "MODIFY" }], complete: true }),
    });
    const c = await loadPrContext(s.db, provider, s.pr, { threads: [] }, new AbortController().signal, {
      me: "ihor",
      dataDir: "/tmp/rl-none",
      now: T0,
    });
    expect(c.input.peers.map((p) => p.prId)).toEqual([60]);
    expect(c.input.peerNotes).toEqual([]);
  });

  test("AC-P5: a stored open PR of the same repository that changes a path shows with it; a rename matches through src_path; no overlap, another repo, or a merged PR does not show", async () => {
    const s = setup();
    changes(s.db, s.pr.id, [
      ["src/client.ts", null],
      ["src/new-name.ts", "src/old-name.ts"],
    ]);
    changes(s.db, otherPr(s.db, 45), [["src/client.ts", null]]);
    changes(s.db, otherPr(s.db, 46), [["src/old-name.ts", null]]);
    changes(s.db, otherPr(s.db, 47), [["src/unrelated.ts", null]]);
    changes(s.db, otherPr(s.db, 48, { repo: "other" }), [["src/client.ts", null]]);
    changes(s.db, otherPr(s.db, 49, { state: "MERGED" }), [["src/client.ts", null]]);
    const c = await load(s, stub());
    expect(c.input.peers.map((p) => [p.prId, p.paths])).toEqual([
      [45, ["src/client.ts"]],
      [46, ["src/old-name.ts"]],
    ]);
    expect([...c.peers.keys()]).toEqual([45, 46]);
  });

  test("Bitbucket peers after the gates: listed PRs without a stored row, the cache, a 404 skip, and the read cap", async () => {
    const s = setup();
    changes(s.db, s.pr.id, [["src/client.ts", null]]);
    changes(s.db, otherPr(s.db, 45), [["src/client.ts", null]]);
    const reads: number[] = [];
    const list = [openPr(12, 9), openPr(45, 9), openPr(60, 5), openPr(61, 7), openPr(62, 8)];
    const provider = stub({
      listOpenPullRequests: async () => ({ items: list, complete: true }),
      listChanges: async (ref) => {
        reads.push(ref.id);
        if (ref.id === 62) throw new ForgeError("not_found", "/x", 404);
        return { items: [{ path: ref.id === 60 ? "src/client.ts" : "src/else.ts", srcPath: null, type: "MODIFY" }], complete: true };
      },
    });
    const c = await load(s, provider, { peerReads: true });
    // Its own PR and the stored PR 45 need no read. Newest update first.
    expect(reads).toEqual([62, 61, 60]);
    expect(c.input.peers.map((p) => p.prId).sort()).toEqual([45, 60]);
    expect(c.input.peerNotes).toEqual([]);
    reads.length = 0;
    await load(s, provider, { peerReads: true });
    // An unchanged PR costs no second read. The 404 PR is not cached.
    expect(reads).toEqual([62]);
    const many = Array.from({ length: PEER_PRS_READ + 4 }, (_, k) => openPr(200 + k, k));
    const capped = await load(
      s,
      stub({
        listOpenPullRequests: async () => ({ items: many, complete: true }),
        listChanges: async () => ({ items: [], complete: true }),
      }),
      { peerReads: true },
    );
    expect(capped.input.peerNotes).toEqual(["4 more open PRs were not checked."]);
  });

  test("AC-P6: a failed or timed-out open-PR read keeps the stored PRs and adds the line; the run does not fail", async () => {
    const s = setup();
    changes(s.db, s.pr.id, [["src/client.ts", null]]);
    changes(s.db, otherPr(s.db, 45), [["src/client.ts", null]]);
    const failed = await load(s, stub({ listOpenPullRequests: () => Promise.reject(new ForgeError("server", "/x", 500)) }), {
      peerReads: true,
    });
    expect(failed.input.peers.map((p) => p.prId)).toEqual([45]);
    expect(failed.input.peerNotes).toEqual(["Only PRs in your inbox are listed: Bitbucket error server 500."]);
    const stop = new AbortController();
    const hung = load(s, stub({ listOpenPullRequests: () => new Promise(() => {}), buildStats: () => new Promise(() => {}) }), {
      peerReads: true,
      signal: stop.signal,
    });
    stop.abort();
    const cancelled = await hung;
    expect(cancelled.input.peerNotes).toEqual(["Only PRs in your inbox are listed: the run was cancelled."]);
    expect(cancelled.input.build).toEqual({ error: "the run was cancelled" });
    expect(cancelled.input.peers.map((p) => p.prId)).toEqual([45]);
  });

  test("the fake Bitbucket: the open-PR list, the changes of a PR that the user is not on, and build stats", async () => {
    const fake = startFakeBitbucket();
    try {
      const w = repoWrites(fake);
      const s = setup();
      changes(s.db, s.pr.id, [["src/client.ts", null]]);
      // Gate G3 shape. Build stats of the PR head.
      w.builds.set(HEAD, { successful: 3, failed: 1 });
      const created = await fetch(`${fake.url}${w.path}/pull-requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${FAKE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Mac build", fromRef: { id: "refs/heads/mac" }, toRef: { id: "refs/heads/main" } }),
      });
      const peer = (await created.json()) as { id: number };
      fake.routes[key("GET", `${w.path}/pull-requests/${peer.id}/changes`)] = {
        status: 200,
        body: { size: 1, limit: 50, start: 0, isLastPage: true, values: [{ path: { toString: "src/client.ts" }, type: "MODIFY" }] },
      };
      const provider = createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN });
      const c = await load(s, provider, { peerReads: true });
      expect(c.input.build).toEqual({ stats: { ...ZERO, successful: 3, failed: 1 } });
      expect(c.input.peers).toEqual([
        expect.objectContaining({ prId: peer.id, title: "Mac build", author: "User jdoe", paths: ["src/client.ts"] }),
      ]);
      // Reads only: the POST is the setup of this test.
      expect(fake.requests.filter((r) => !r.startsWith("GET "))).toEqual([`POST ${w.path}/pull-requests`]);
    } finally {
      fake.stop();
    }
  });
});
