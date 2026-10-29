// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { PrRow, SyncStatus } from "../../src/shared/dto";
import { byInbox } from "../../src/shared/views";
import { reduceKey } from "../../src/web/keys";
import {
  ARCHIVED_TEXT,
  ago,
  archiveWhy,
  failText,
  filterRows,
  followCandidate,
  freezeOrder,
  groupRows,
  incompleteText,
  initials,
  movedCount,
  navIds,
  repoTree,
  restoreWords,
  statusInfo,
  taskHint,
  unfollowText,
  unreadTotal,
  viewCounts,
  why,
} from "../../src/web/shell/model";

const row = (o: Partial<PrRow>): PrRow => ({
  id: 1,
  project: "PROJ1",
  repo: "repo",
  prId: 1,
  title: "A change",
  authorSlug: "other",
  authorName: "Other Person",
  role: "REVIEWER",
  state: "OPEN",
  status: "UNAPPROVED",
  sourceBranch: "feature",
  targetBranch: "main",
  webUrl: null,
  sourceBranchUrl: null,
  targetBranchUrl: null,
  authorUrl: null,
  synced: true,
  reviewers: [],
  onDashboard: true,
  followed: true,
  archivedAt: null,
  unread: 0,
  group: "quiet",
  yourTurn: 0,
  staleDrafts: 0,
  cause: null,
  waitSince: null,
  seenAt: null,
  tasks: [],
  lastActivity: 0,
  checkpoint: null,
  build: null,
  ...o,
});

const NOW = 10 * 86_400_000;
const cause = { thread: 5, msg: 6, author: "Lena Petrova", snippet: "Can you take the lock here?" };

describe("inbox groups", () => {
  // The server order: reason order, then unread, then activity. The groups keep it.
  const list = [
    row({ id: 1, group: "your" }),
    row({ id: 2, group: "review" }),
    row({ id: 3, group: "comments", state: "MERGED" }),
    row({ id: 4, group: "waiting" }),
    row({ id: 5, group: "quiet" }),
    row({ id: 6, group: "closed", state: "DECLINED" }),
  ];

  test("Needs you, Waiting on others, and Done hold their reasons in server order", () => {
    expect(groupRows(list).map((g) => [g.id, g.label, g.rows.map((p) => p.id)])).toEqual([
      ["needs", "Needs you", [1, 2, 3]],
      ["waiting", "Waiting on others", [4]],
      ["done", "Done", [5, 6]],
    ]);
  });

  test("an empty group is left out", () => {
    expect(groupRows([row({ id: 4, group: "waiting" })]).map((g) => g.id)).toEqual(["waiting"]);
    expect(groupRows([])).toEqual([]);
  });

  test("j and k skip the rows of a folded Done group", () => {
    const groups = groupRows(list);
    expect(navIds(groups, false)).toEqual([1, 2, 3, 4]);
    expect(navIds(groups, true)).toEqual([1, 2, 3, 4, 5, 6]);
    const ctx = { ids: navIds(groups, false), typing: false, onButton: false, settingsLocked: false, now: 0 };
    const s = { focus: "list" as const, mobile: "list" as const, selected: 4, help: false, settings: false, chord: null };
    // At the last open row, j stays. k from a folded row restarts at the top.
    expect(reduceKey(s, "j", ctx).state.selected).toBe(4);
    expect(reduceKey({ ...s, selected: 5 }, "k", ctx).state.selected).toBe(1);
  });
});

describe("why-lines", () => {
  test("your turn names the thread count and quotes the cause", () => {
    expect(why(row({ group: "your", yourTurn: 1, cause }), NOW)).toEqual({
      closed: null,
      turn: { kind: "your", text: "Your turn" },
      lead: null,
      text: "Lena Petrova: Can you take the lock here?",
    });
    expect(why(row({ group: "your", yourTurn: 3, cause }), NOW).turn).toEqual({ kind: "your", text: "Your turn in 3 threads" });
  });

  test("a review request names the author", () => {
    expect(why(row({ group: "review", authorName: "Dan Okafor" }), NOW)).toMatchObject({
      lead: "Dan Okafor",
      text: "asked for your review.",
    });
    expect(why(row({ group: "review", authorName: null, authorSlug: "dokafor" }), NOW).lead).toBe("dokafor");
  });

  test("new commits, comments, and quiet rows", () => {
    expect(why(row({ group: "commits" }), NOW)).toMatchObject({ lead: "New commits since your review.", text: null });
    expect(why(row({ group: "comments", cause }), NOW).text).toBe("Lena Petrova: Can you take the lock here?");
    expect(why(row({ group: "quiet" }), NOW).text).toBe("No new messages.");
  });

  test("waiting names the time of my last reply", () => {
    expect(why(row({ group: "waiting", waitSince: NOW - 3 * 3_600_000 }), NOW)).toMatchObject({
      turn: { kind: "wait", text: "Waiting on others" },
      text: "You replied last, 3h ago.",
    });
    expect(why(row({ group: "waiting", waitSince: NOW }), NOW).text).toBe("You replied last, just now.");
    expect(why(row({ group: "waiting" }), NOW).text).toBe("You replied last.");
  });

  test("D1: a closed PR names its state first, also in Needs you", () => {
    expect(why(row({ group: "closed", state: "MERGED" }), NOW)).toEqual({ closed: "Merged.", turn: null, lead: null, text: null });
    expect(why(row({ group: "closed", state: "DECLINED" }), NOW).closed).toBe("Declined.");
    const merged = why(row({ group: "your", state: "MERGED", yourTurn: 1, cause }), NOW);
    expect(merged).toMatchObject({ closed: "Merged.", turn: { kind: "your", text: "Your turn" } });
    expect(why(row({ group: "comments", state: "DECLINED", cause }), NOW).closed).toBe("Declined.");
    expect(why(row({ group: "your", yourTurn: 1, cause }), NOW).closed).toBeNull();
  });
});

describe("Archive rows and texts", () => {
  test("a row names the archive time or the missing follow, and says that sync does not check it", () => {
    expect(archiveWhy(row({ archivedAt: NOW - 2 * 86_400_000, state: "MERGED", group: "your", yourTurn: 1, cause }), NOW)).toEqual({
      closed: "Merged.",
      turn: null,
      lead: "Archived 2d ago.",
      text: "Not checked while archived.",
    });
    expect(archiveWhy(row({ archivedAt: NOW }), NOW).lead).toBe("Archived just now.");
    expect(archiveWhy(row({ followed: false, onDashboard: false }), NOW)).toMatchObject({
      lead: "Not followed.",
      text: "Not on your dashboard, so not checked.",
    });
  });

  test("an archived PR that I follow is unarchived; any other row is restored", () => {
    expect(restoreWords({ archivedAt: 5, followed: true })).toEqual({ verb: "Unarchive", done: "Unarchived" });
    expect(restoreWords({ archivedAt: 5, followed: false })).toEqual({ verb: "Restore", done: "Restored" });
    expect(restoreWords({ archivedAt: null, followed: false })).toEqual({ verb: "Restore", done: "Restored" });
  });

  test("the unfollow toast names the role view on the dashboard, else Archive", () => {
    expect(unfollowText({ onDashboard: true, role: "REVIEWER" })).toBe(
      "It stays in Reviewing while it is on your dashboard. Then it moves to Archive.",
    );
    expect(unfollowText({ onDashboard: true, role: "AUTHOR" })).toBe(
      "It stays in My PRs while it is on your dashboard. Then it moves to Archive.",
    );
    expect(unfollowText({ onDashboard: false, role: "REVIEWER" })).toBe(ARCHIVED_TEXT);
    expect(ARCHIVED_TEXT).toContain("Archive");
  });
});

describe("task ID on a row", () => {
  test("the tooltip names the ID and its source field", () => {
    expect(taskHint({ key: "ABC-10145", source: "branch" })).toBe("Task ABC-10145, from the branch");
    expect(taskHint({ key: "ABC-7", source: "description" })).toBe("Task ABC-7, from the description");
  });

  test("the filter matches task IDs", () => {
    const prs = [row({ id: 1, tasks: [{ key: "ABC-10145", source: "title", url: null }] }), row({ id: 2 })];
    expect(filterRows(prs, "following", null, "abc-1014").map((p) => p.id)).toEqual([1]);
  });
});

describe("frozen list order", () => {
  const ids = (slots: { id: number }[]) => slots.map((x) => x.id);
  const shown = (rows: PrRow[], slots: ReturnType<typeof freezeOrder>) => {
    const at = new Map(slots.map((x) => [x.id, x.group]));
    const byId = new Map(rows.map((p) => [p.id, p]));
    return groupRows(
      slots.flatMap((x) => byId.get(x.id) ?? []),
      (p) => at.get(p.id) ?? p.group,
    );
  };

  test("an empty earlier order gives the server order", () => {
    const rows = [row({ id: 3 }), row({ id: 1 }), row({ id: 2 })];
    expect(freezeOrder([], rows)).toEqual([
      { id: 3, group: "quiet" },
      { id: 1, group: "quiet" },
      { id: 2, group: "quiet" },
    ]);
  });

  test("a read row keeps its place and group, so the second unread row stays second", () => {
    const before = [
      row({ id: 2, group: "comments", unread: 1, lastActivity: 100 }),
      row({ id: 1001, group: "comments", unread: 2, lastActivity: 90 }),
    ];
    const slots = freezeOrder([], [...before].sort(byInbox));
    // The read moves PR 2 to Done on the server.
    const after = [row({ id: 2, group: "quiet", lastActivity: 100 }), before[1] as PrRow].sort(byInbox);
    expect(ids(after)).toEqual([1001, 2]);
    const frozen = freezeOrder(slots, after);
    expect(frozen).toEqual(slots);
    const groups = shown(after, frozen);
    expect(navIds(groups, false)).toEqual([2, 1001]);
    expect(movedCount(groups, groupRows(after))).toBe(1);
  });

  test("a new row goes after its server predecessor, and a gone row drops", () => {
    const prev = [
      { id: 1, group: "your" as const },
      { id: 2, group: "comments" as const },
      { id: 3, group: "quiet" as const },
    ];
    const rows = [row({ id: 2, group: "your" }), row({ id: 9, group: "your" }), row({ id: 1, group: "quiet" })];
    expect(freezeOrder(prev, rows)).toEqual([
      { id: 1, group: "your" },
      { id: 2, group: "comments" },
      { id: 9, group: "your" },
    ]);
    expect(ids(freezeOrder(prev, [row({ id: 8 }), row({ id: 3 })]))).toEqual([8, 3]);
  });

  test("the moved count names the rows that change place or group", () => {
    const rows = [row({ id: 1, group: "your" }), row({ id: 2, group: "your" }), row({ id: 3, group: "waiting" })];
    const g = groupRows(rows);
    expect(movedCount(g, g)).toBe(0);
    expect(movedCount(groupRows([rows[2], rows[0], rows[1]] as PrRow[]), g)).toBe(0);
    expect(movedCount(groupRows([rows[1], rows[0], rows[2]] as PrRow[]), g)).toBe(1);
    // Same place, other group.
    expect(movedCount(groupRows([rows[0], rows[1], row({ id: 3, group: "review" })] as PrRow[]), g)).toBe(1);
    // A kept row that the server list no longer holds.
    expect(movedCount(groupRows([...rows, row({ id: 4, group: "quiet" })]), g)).toBe(1);
    expect(movedCount([], [])).toBe(0);
  });
});

describe("incomplete check text", () => {
  test("names the forge from meta", () => {
    expect(incompleteText(null, "Forge")).toBeNull();
    expect(incompleteText({ lastCompleteAt: 1, reason: null, error: null }, "Forge")).toBeNull();
    expect(incompleteText({ lastCompleteAt: 1, reason: "server", error: "500" }, "Forge")).toBe(
      "Last check incomplete: Forge server error",
    );
  });
});

describe("sidebar counts", () => {
  const prs = [
    row({ id: 1, unread: 2 }),
    row({ id: 2, status: "APPROVED" }),
    row({ id: 3, role: "AUTHOR", status: null, repo: "other", unread: 1 }),
    row({ id: 4, state: "MERGED", group: "comments", unread: 4 }),
    row({ id: 5, followed: false, repo: "other", project: "PROJ0" }),
  ];

  test("each view counts its rows", () => {
    expect(viewCounts(prs)).toEqual({ needs: 3, reviewing: 3, mine: 1, following: 4 });
    expect(viewCounts([])).toEqual({ needs: 0, reviewing: 0, mine: 0, following: 0 });
  });

  test("repositories sit under their project with unread counts", () => {
    expect(repoTree(prs)).toEqual([
      { project: "PROJ0", repos: [{ key: "PROJ0/other", repo: "other", unread: 0 }] },
      {
        project: "PROJ1",
        repos: [
          { key: "PROJ1/other", repo: "other", unread: 1 },
          { key: "PROJ1/repo", repo: "repo", unread: 6 },
        ],
      },
    ]);
    expect(unreadTotal(prs)).toBe(7);
  });

  test("a repository replaces the view, and the filter matches title, key, and author", () => {
    expect(filterRows(prs, "needs", null, "").map((p) => p.id)).toEqual([1, 3, 4]);
    // prototype/v3: the repository view lists every row of the repository, also the unfollowed one.
    expect(filterRows(prs, "needs", "PROJ0/other", "").map((p) => p.id)).toEqual([5]);
    expect(filterRows(prs, "following", null, "proj1/repo #1").map((p) => p.id)).toEqual([1, 2, 4]);
    expect(filterRows([row({ id: 9, authorName: "Ada Lovelace", title: null })], "following", null, "ada").map((p) => p.id)).toEqual([9]);
    expect(filterRows(prs, "needs", null, "zzz")).toEqual([]);
  });
});

describe("follow by URL in the filter", () => {
  const base = "https://forge.example.test/context";

  test("a PR URL on the configured origin is a candidate", () => {
    expect(followCandidate("https://forge.example.test/projects/PROJ/repos/app/pull-requests/12/overview", base)).toEqual({
      project: "PROJ",
      repo: "app",
      id: 12,
    });
    expect(followCandidate("  https://forge.example.test/users/jdoe/repos/r/pull-requests/2  ", base)).toEqual({
      project: "~JDOE",
      repo: "r",
      id: 2,
    });
  });

  test("other text, other origins, and no config give no candidate", () => {
    expect(followCandidate("fix login", base)).toBeNull();
    expect(followCandidate("https://other.example.test/projects/PROJ/repos/app/pull-requests/12", base)).toBeNull();
    expect(followCandidate("https://forge.example.test/projects/PROJ/repos/app", base)).toBeNull();
    expect(followCandidate("https://forge.example.test/projects/PROJ/repos/app/pull-requests/12", null)).toBeNull();
  });
});

describe("row text helpers", () => {
  test("initials and relative time", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Ada King Lovelace")).toBe("AL");
    expect(initials("jdoe")).toBe("JD");
    expect(initials(null)).toBe("?");
    expect(ago(1_000, 1_000)).toBe("now");
    expect(ago(0, 5 * 60_000)).toBe("5m");
    expect(ago(0, 3 * 3_600_000)).toBe("3h");
    expect(ago(0, 2 * 86_400_000)).toBe("2d");
  });
});

describe("check status text", () => {
  const s = (o: Partial<SyncStatus>): SyncStatus => ({
    running: false,
    state: "ok",
    lastCompleteAt: null,
    nextAt: null,
    error: null,
    ...o,
  });
  const at = new Date(2026, 0, 1, 9, 5).getTime();

  test("each state reads as text", () => {
    expect(statusInfo(s({ lastCompleteAt: at }), at, "Forge")).toEqual({ text: "Checked 09:05", tone: "ok" });
    expect(statusInfo(s({ running: true }), at, "Forge").text).toBe("Checking…");
    expect(statusInfo(s({ state: "offline", lastCompleteAt: at, nextAt: at + 41_200 }), at, "Forge").text).toBe(
      "Offline. Last checked 09:05. Next try in 42 s.",
    );
    expect(statusInfo(s({ state: "auth" }), at, "Forge").text).toBe("Forge rejected the token");
    expect(statusInfo(s({ state: "unconfigured" }), at, "Forge").text).toBe("Not configured");
    expect(statusInfo(s({ state: "error", error: "Cannot read the CA file (ENOENT)." }), at, "Forge").text).toBe(
      "Cannot read the CA file (ENOENT).",
    );
  });
});

describe("failure toast text", () => {
  test("the error ends with a full stop, then the next step follows", () => {
    expect(failText(new Error("Server answered 500"))).toBe("Server answered 500. Try again, or reload the pull request.");
    expect(failText(new Error("The item changed."))).toBe("The item changed. Try again, or reload the pull request.");
    expect(failText(new Error(""))).toBe("Try again, or reload the pull request.");
  });

  test("outside a pull request the step names the page", () => {
    expect(failText(new Error("Server answered 500"), "page")).toBe("Server answered 500. Try again, or reload the page.");
    expect(failText("Network down", "page")).toBe("Network down. Try again, or reload the page.");
  });

  test("a stale session keeps its own step: a new try fails again", () => {
    // The shape of data.ts ApiError for a 403 session_stale answer.
    const stale = Object.assign(new Error("The service restarted. Reload the page."), { status: 403, stale: true });
    expect(failText(stale)).toBe("The service restarted. Reload the page.");
    expect(failText(Object.assign(new Error("Forbidden"), { status: 403, stale: false }))).toBe(
      "Forbidden. Try again, or reload the pull request.",
    );
  });
});
