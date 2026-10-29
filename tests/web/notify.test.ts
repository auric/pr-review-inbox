// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { ClaimedEvent } from "../../src/shared/dto";
import { planNotes } from "../../src/web/notify";

let n = 0;
const ev = (pr: number, o: Partial<ClaimedEvent> = {}): ClaimedEvent => ({
  id: ++n,
  pr,
  kind: "comment_new",
  ref: String(n),
  createdAt: n,
  digest: false,
  project: "PROJ1",
  repo: `repo-${pr}`,
  prId: pr * 10,
  title: `Change ${pr}`,
  ...o,
});

describe("planNotes", () => {
  test("no events give no notification", () => {
    expect(planNotes([], true)).toEqual([]);
  });

  test("one notification per PR, tagged with the PR key", () => {
    const notes = planNotes([ev(1), ev(2), ev(1), ev(1, { kind: "commits_pushed" })], false);
    expect(notes).toEqual([
      { title: "Change 1", body: "PROJ1/repo-1 #10: 2 new comments, new commits", tag: "PROJ1/repo-1 #10", pr: 1 },
      { title: "Change 2", body: "PROJ1/repo-2 #20: 1 new comment", tag: "PROJ1/repo-2 #20", pr: 2 },
    ]);
  });

  // docs/plans/thread-outcome.md section 11: the note of a sync joins the out-of-date drafts with the new comments.
  test("out-of-date drafts join the comment events of their PR in one notification", () => {
    const stale = { kind: "draft_stale" } as const;
    expect(planNotes([ev(1), ev(1, stale)], false)).toEqual([
      { title: "Change 1", body: "PROJ1/repo-1 #10: 1 new comment, 1 reply draft out of date", tag: "PROJ1/repo-1 #10", pr: 1 },
    ]);
    expect(planNotes([ev(2, stale), ev(2, stale), ev(2), ev(2)], false).map((x) => x.body)).toEqual([
      "PROJ1/repo-2 #20: 2 reply drafts out of date, 2 new comments",
    ]);
  });

  // docs/plans/ci-builds.md, Layer A.
  test("a build event joins the other events of its PR", () => {
    expect(planNotes([ev(1, { kind: "build_failed" }), ev(1), ev(2, { kind: "build_passed" })], false).map((x) => x.body)).toEqual([
      "PROJ1/repo-1 #10: build failed, 1 new comment",
      "PROJ1/repo-2 #20: build passed",
    ]);
  });

  test("the first claim of a tab gives one digest", () => {
    expect(planNotes([ev(1), ev(2), ev(2)], true)).toEqual([
      { title: "PR Review Inbox", body: "3 updates in 2 pull requests", tag: "digest", pr: null },
    ]);
  });

  test("a batch with a digest event gives one digest", () => {
    const notes = planNotes([ev(1), ev(2, { digest: true })], false);
    expect(notes.map((x) => x.pr)).toEqual([null]);
  });

  test("a PR without a title uses its key", () => {
    expect(planNotes([ev(3, { title: null, kind: "reviewer_added" })], false)[0]).toMatchObject({
      title: "PROJ1/repo-3 #30",
      body: "PROJ1/repo-3 #30: review requested",
    });
  });
});
