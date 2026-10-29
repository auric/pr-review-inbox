// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { PrRow } from "../../src/shared/dto";
import { archived, byArchive, byInbox, VIEWS } from "../../src/shared/views";

const row = (o: Partial<PrRow>): PrRow => ({
  id: 1,
  project: "PROJ1",
  repo: "repo",
  prId: 1,
  title: "A change",
  authorSlug: "other",
  authorName: "Other",
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

const views = (r: PrRow) => (Object.keys(VIEWS) as (keyof typeof VIEWS)[]).filter((v) => VIEWS[v](r));

describe("view predicates", () => {
  test("an open review that I did not approve needs me", () => {
    expect(views(row({}))).toEqual(["needs", "reviewing", "following"]);
    expect(views(row({ status: "NEEDS_WORK" }))).toEqual(["needs", "reviewing", "following"]);
  });

  test("an approved review needs me only with unread messages", () => {
    expect(views(row({ status: "APPROVED" }))).toEqual(["reviewing", "following"]);
    expect(views(row({ status: "APPROVED", unread: 2 }))).toEqual(["needs", "reviewing", "following"]);
  });

  test("my own PR shows in My PRs", () => {
    expect(views(row({ role: "AUTHOR", status: null }))).toEqual(["mine", "following"]);
  });

  test("an unfollowed dashboard PR shows only in its role view", () => {
    expect(views(row({ followed: false }))).toEqual(["reviewing"]);
  });

  test("a merged PR with unread replies needs me and stays in Following (A15)", () => {
    expect(views(row({ state: "MERGED", unread: 2, onDashboard: false }))).toEqual(["needs", "following"]);
    expect(views(row({ state: "MERGED", onDashboard: false }))).toEqual(["following"]);
  });

  test("a read your-turn PR needs me", () => {
    expect(views(row({ status: "APPROVED", yourTurn: 1, group: "your" }))).toEqual(["needs", "reviewing", "following"]);
    expect(views(row({ status: "APPROVED", yourTurn: 1, followed: false }))).toEqual(["reviewing"]);
  });

  test("sort follows the reason order, then unread first, then the newest activity", () => {
    const list = [
      row({ id: 1, lastActivity: 5, group: "quiet" }),
      row({ id: 2, lastActivity: 1, unread: 1, group: "comments" }),
      row({ id: 3, lastActivity: 9, group: "comments" }),
      row({ id: 4, lastActivity: 0, group: "your" }),
      row({ id: 5, lastActivity: 7, group: "closed", unread: 0 }),
      row({ id: 6, lastActivity: 8, group: "waiting" }),
      row({ id: 7, lastActivity: 2, group: "review" }),
    ];
    expect(list.sort(byInbox).map((r) => r.id)).toEqual([4, 7, 2, 3, 6, 1, 5]);
  });
});

describe("Archive view", () => {
  test("it holds archived PRs and unfollowed PRs off the dashboard, which no other view shows", () => {
    const at = 5;
    expect(archived(row({ archivedAt: at }))).toBe(true);
    expect(archived(row({ archivedAt: at, followed: false }))).toBe(true);
    expect(archived(row({ followed: false, onDashboard: false }))).toBe(true);
    expect(views(row({ followed: false, onDashboard: false }))).toEqual([]);
    // Plan m1: an unfollowed dashboard PR stays in its role view, and a followed PR off the dashboard stays in Following.
    expect(archived(row({ followed: false }))).toBe(false);
    expect(archived(row({ onDashboard: false }))).toBe(false);
  });

  test("the newest archive time comes first; an unfollowed PR sorts by its last activity", () => {
    const list = [
      row({ id: 1, archivedAt: 100, lastActivity: 900 }),
      row({ id: 2, followed: false, onDashboard: false, lastActivity: 150 }),
      row({ id: 3, archivedAt: 300, lastActivity: 1 }),
      row({ id: 4, archivedAt: 100, lastActivity: 2 }),
    ];
    expect(list.sort(byArchive).map((r) => r.id)).toEqual([3, 2, 4, 1]);
  });
});
