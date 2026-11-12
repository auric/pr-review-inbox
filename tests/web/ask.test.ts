// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 UI-ASK: the pure Ask rules. The state of each answer, the busy note, the conversations, and the box texts.
import { describe, expect, test } from "bun:test";
import type { AskDto, RunDto } from "../../src/shared/dto";
import { askBox, askConversations, askView, busyText, fullText, refusedText, slotNote } from "../../src/web/ask/model";
import type { SlotRun } from "../../src/web/review/model";

const run = (o: Partial<RunDto> = {}): RunDto => ({
  id: 1,
  pr: 7,
  kind: "ask",
  profile: "general",
  profileName: "General",
  explain: false,
  note: "",
  status: "completed",
  errorKind: null,
  errorText: null,
  sourceHead: "a".repeat(40),
  targetHead: "b".repeat(40),
  mergeBase: "c".repeat(40),
  via: "pull-request-ref",
  sessionId: null,
  cliVersion: "2.1.295",
  model: "m",
  effort: null,
  effortDefault: null,
  effortNow: false,
  usage: { costUsd: 0, turns: 3, durationMs: 9000, tokens: { input_tokens: 1200, output_tokens: 300 } },
  summary: {
    summary: "flush() has two callers.",
    risks: [],
    coverage: { read: ["src/a.ts"], skipped: [], unavailable: [], notChecked: [] },
    dropped: [],
  },
  startedAt: 1_000,
  finishedAt: 61_000,
  stale: null,
  hasRaw: true,
  since: null,
  question: "Which callers of flush() are not updated?",
  findings: 0,
  ...o,
});
const ask = (o: Partial<RunDto> = {}, answer: string | null = "flush() has two callers.\n\nBoth are updated."): AskDto => ({
  run: run(o),
  answer,
  parent: null,
});

describe("ask", () => {
  test("a finished answer has its time, its tokens, and only the coverage gaps", () => {
    expect(askView(ask(), "Claude Code")).toEqual({
      kind: "answered",
      at: 61_000,
      tokens: 1500,
      gaps: [],
      answer: "flush() has two callers.\n\nBoth are updated.",
    });
    const gaps = ask({
      status: "incomplete",
      summary: {
        summary: "x",
        risks: [],
        coverage: {
          read: ["src/a.ts"],
          skipped: ["src/big.ts: above the read limit"],
          unavailable: ["MCP server git: failed"],
          notChecked: [],
        },
        dropped: [],
      },
    });
    expect(askView(gaps, "Claude Code")).toMatchObject({
      kind: "answered",
      gaps: [
        ["Skipped", ["src/big.ts: above the read limit"]],
        ["Unavailable", ["MCP server git: failed"]],
      ],
    });
  });

  test("a failed ask names the question, a usage limit shows the CLI message without raw output", () => {
    expect(askView(ask({ status: "failed", errorKind: "schema", errorText: "Bad shape." }, null), "Claude Code")).toEqual({
      kind: "failed",
      text: "The question failed. Bad shape.",
      raw: true,
    });
    expect(askView(ask({ status: "failed", errorKind: "process", errorText: null, hasRaw: false }, null), "Claude Code")).toEqual({
      kind: "failed",
      text: "The question failed. No reason was recorded.",
      raw: false,
    });
    expect(askView(ask({ status: "failed", errorKind: "usage_limit", errorText: "Resets at 6pm." }, null), "Claude Code")).toEqual({
      kind: "failed",
      text: "Claude Code: Resets at 6pm. PR Review Inbox does not retry by itself.",
      raw: false,
    });
  });

  test("a running and a cancelled ask", () => {
    expect(askView(ask({ status: "running", finishedAt: null }, null), "Claude Code")).toEqual({ kind: "running", startedAt: 1_000 });
    expect(askView(ask({ status: "cancelled" }, null), "Claude Code")).toEqual({ kind: "cancelled" });
  });

  test("the busy note names the run of the pull request, never a review for an ask", () => {
    expect(busyText("Claude", "ask", "this pull request")).toBe(
      "Claude is answering a question on this pull request. One run per pull request.",
    );
    expect(busyText("Claude", "review", "this pull request")).toBe("Claude is reviewing this pull request. One run per pull request.");
    expect(busyText("Claude", "reply", "this pull request")).toBe(
      "Claude is drafting replies for this pull request. One run per pull request.",
    );
  });
});

// docs/plans/review-v2/parallel-runs.md section 3.5, W1 to W3 (AC-B220).
describe("run slot notes", () => {
  const where = (pr: number | null, task?: string) =>
    pr === null ? (task ?? "a task") : pr === 7 ? "this pull request" : `PROJ/repo #${pr}`;
  const slot = (run: number, pr: number | null, o: Partial<SlotRun> = {}): SlotRun => ({ run, pr, kind: "review", ...o });

  test("a full pool names the limit", () => {
    expect(fullText("Claude", 3)).toBe("Claude runs 3 runs at once, your limit.");
    expect(fullText("Claude", 1)).toBe("Claude runs 1 run at once, your limit.");
  });

  test("the note names the run of this pull request, else the runs of a full pool", () => {
    expect(slotNote("Claude", { kind: "pr", run: slot(5, 7, { kind: "fix" }) }, where)).toBe(
      "Claude is proposing fixes for this pull request. One run per pull request.",
    );
    expect(slotNote("Claude", { kind: "full", limit: 1, running: [slot(5, 12)] }, where)).toBe(
      "Claude runs 1 run at once, your limit. Running: Review of PROJ/repo #12.",
    );
    const task = slot(6, null, { kind: "implement", task: 3, taskKey: "ABC-1" });
    expect(slotNote("Claude", { kind: "full", limit: 2, running: [slot(5, 12, { kind: "ask" }), task] }, where)).toBe(
      "Claude runs 2 runs at once, your limit. Running: Ask of PROJ/repo #12 and Build step of ABC-1.",
    );
    // A task run without its key, as the server sends it when the task row is gone.
    expect(slotNote("Claude", { kind: "full", limit: 1, running: [slot(6, null, { kind: "spec", task: 3 })] }, where)).toBe(
      "Claude runs 1 run at once, your limit. Running: Plan of a task.",
    );
  });

  test("the note names at most 3 runs", () => {
    const three = [slot(1, 11), slot(2, 12, { kind: "explain" }), slot(3, 13, { kind: "reply" })];
    expect(slotNote("Claude", { kind: "full", limit: 3, running: three }, where)).toBe(
      "Claude runs 3 runs at once, your limit. Running: Review of PROJ/repo #11, Explain of PROJ/repo #12, and Reply drafts of PROJ/repo #13.",
    );
    // A lower limit leaves more runs than slots until they end.
    expect(slotNote("Claude", { kind: "full", limit: 2, running: [...three, slot(4, 14), slot(5, 15)] }, where)).toBe(
      "Claude runs 2 runs at once, your limit. Running: Review of PROJ/repo #11, Explain of PROJ/repo #12, Reply drafts of PROJ/repo #13, and 2 more.",
    );
  });

  test("a refused start names the run of the pull request, or the limit and the next step", () => {
    const running = { run: 5, pr: 7, kind: "review" as const };
    expect(refusedText("Claude", { error: "x", running }, where)).toBe("Claude is reviewing this pull request. One run per pull request.");
    expect(refusedText("Claude", { error: "x", running: { ...running, pr: 12 }, full: 3 }, where)).toBe(
      "Claude runs 3 runs at once, your limit. Try again when one ends.",
    );
  });
});

// docs/plans/review-v2/spec.md sections 2.14 and 2.15.
describe("ask conversations", () => {
  const turn = (id: number, parent: number | null): AskDto => ({ ...ask({ id }), parent });
  const ids = (groups: AskDto[][]) => groups.map((g) => g.map((a) => a.run.id));

  test("AC-F9: chains are oldest first, conversations sort by their newest run, and a parent outside the list starts a group", () => {
    // The server order: newest first. 9 follows 4, 7 follows 5 follows 2, 6 follows run 1, which is outside the list.
    const list = [turn(9, 4), turn(8, null), turn(7, 5), turn(6, 1), turn(5, 2), turn(4, null), turn(2, null)];
    expect(ids(askConversations(list))).toEqual([[4, 9], [8], [2, 5, 7], [6]]);
    expect(askConversations([])).toEqual([]);
    // Runs from before follow-ups have no parent: one question per conversation, newest first.
    expect(ids(askConversations([turn(3, null), turn(2, null)]))).toEqual([[3], [2]]);
  });

  test("the box: Your question without asks, Follow up with the parent profile or the brief fallback, and New question", () => {
    const o = { runner: "Claude", profile: "Review", gone: false, forge: "Bitbucket" };
    expect(askBox("first", o)).toEqual({
      label: "Your question",
      placeholder: "For example: which callers of the changed function are not updated?",
      hint: "Claude answers with the Review profile. The answer stays in PR Review Inbox. Nothing posts to Bitbucket.",
    });
    expect(askBox("follow", o)).toEqual({
      label: "Follow up",
      placeholder: "Ask about the answer above",
      hint: "Claude answers with the Review profile and sees this conversation. Nothing posts to Bitbucket.",
    });
    expect(askBox("follow", { ...o, profile: "General", gone: true }).hint).toBe(
      "Claude answers with the General profile of the brief: the profile of the earlier answer no longer exists. Claude sees this conversation. Nothing posts to Bitbucket.",
    );
    expect(askBox("new", o)).toMatchObject({
      label: "New question",
      hint: "Claude starts fresh. It does not see the conversation above. It answers with the Review profile. Nothing posts to Bitbucket.",
    });
  });
});
