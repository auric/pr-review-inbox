// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import type { ClaimedEvent, ClaimedRun, ClaimedTaskEvent } from "../../src/shared/dto";
import { planNotes, runText } from "../../src/web/notify";

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

  test("a run note names the PR and the result; it joins the other events of its PR", () => {
    const run = (o: Partial<ClaimedRun>): ClaimedRun => ({
      kind: "review",
      rereview: false,
      status: "completed",
      findings: 0,
      error: null,
      ...o,
    });
    const done = ev(1, { kind: "run_finished", run: run({ findings: 3 }) });
    expect(planNotes([done, ev(1)], false)).toEqual([
      { title: "Change 1", body: "PROJ1/repo-1 #10: review done, 3 findings, 1 new comment", tag: "PROJ1/repo-1 #10", pr: 1 },
    ]);
    const failed = ev(2, { kind: "run_failed", run: run({ status: "failed", error: "The usage limit is reached.\nTry later." }) });
    expect(planNotes([failed], false)[0]?.body).toBe("PROJ1/repo-2 #20: review failed (The usage limit is reached.)");
  });

  test("runText gives each run kind and status in plain words", () => {
    const text = (kind: ClaimedEvent["kind"], o: Partial<ClaimedRun> | null) =>
      runText(ev(1, { kind, run: o && { kind: "review", rereview: false, status: "completed", findings: 0, error: null, ...o } }));
    expect(text("run_finished", {})).toBe("review done, no findings");
    expect(text("run_finished", { rereview: true, findings: 1 })).toBe("re-review done, 1 finding");
    expect(text("run_finished", { kind: "explain" })).toBe("explanation ready");
    expect(text("run_failed", { status: "incomplete", findings: 2 })).toBe("review incomplete, 2 findings");
    expect(text("run_failed", { kind: "explain", status: "incomplete", error: "Turn limit." })).toBe(
      "explanation incomplete (Turn limit.)",
    );
    expect(text("run_failed", { status: "failed", error: "x".repeat(100) })).toBe(`review failed (${"x".repeat(79)}…)`);
    expect(text("run_failed", null)).toBe("run failed");
  });

  test("a task event gives its own note that opens the task; a digest counts it", () => {
    const task: ClaimedTaskEvent = {
      id: 1,
      task: 7,
      kind: "needs_you",
      createdAt: 1,
      key: "ABC-1",
      title: "Add a flag",
      text: "Needs you: a question",
    };
    expect(planNotes([ev(1), task], false)).toEqual([
      { title: "Change 1", body: "PROJ1/repo-1 #10: 1 new comment", tag: "PROJ1/repo-1 #10", pr: 1 },
      { title: "ABC-1: Add a flag", body: "Needs you: a question", tag: "task-7", pr: null, task: 7 },
    ]);
    expect(planNotes([ev(1), task], true)[0]?.body).toBe("1 update in 1 pull request, 1 task needs you");
    expect(planNotes([task, { ...task, id: 2, task: 8 }], true)).toEqual([
      { title: "PR Review Inbox", body: "2 tasks need you", tag: "digest", pr: null },
    ]);
  });

  test("AC-B242: the digest counts each task once; a part_ready event gives its own note", () => {
    const ready: ClaimedTaskEvent = {
      id: 3,
      task: 7,
      kind: "part_ready",
      createdAt: 1,
      key: "ABC-1",
      title: "Add a flag",
      text: "Part 2 of 4 is ready for its PR.",
    };
    expect(planNotes([ready, { ...ready, id: 4, text: "Part 3 of 4 is ready for its PR." }], true)[0]?.body).toBe("1 task needs you");
    expect(planNotes([ready], false)).toEqual([
      { title: "ABC-1: Add a flag", body: "Part 2 of 4 is ready for its PR.", tag: "task-7", pr: null, task: 7 },
    ]);
  });
});
