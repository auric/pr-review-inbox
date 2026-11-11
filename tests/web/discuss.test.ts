// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 2.1: the pure rules of a talk about a finding. The state and the chip of each turn, the line under
// the box, the 20-message cap, what a run stored, the threads of posted findings, the new text of a changed finding, and the withdrawn
// mark.
import { describe, expect, test } from "bun:test";
import { DISCUSS_CHANGED, type DiscussTurnDto, type PostDto, type ReviewItemDto, type RunDto } from "../../src/shared/dto";
import type { FindingPayload } from "../../src/shared/review";
import {
  busyLine,
  outcomeLines,
  pendingTurn,
  revisionParts,
  startedText,
  talkHint,
  talkLeft,
  talkThreads,
  turnView,
  verdictChip,
  withdrawnNote,
} from "../../src/web/review/discuss-model";
import { closedLabel, triageText } from "../../src/web/review/model";

const turn = (o: Partial<DiscussTurnDto> = {}): DiscussTurnDto => ({
  run: 40,
  status: "completed",
  message: "The caller holds the lock. Is this still a blocker?",
  answer: "The timer calls `flush()` without the lock.",
  verdict: "upheld",
  reason: "The timer path has no lock.",
  revision: null,
  at: 1_000,
  error: null,
  cites: [],
  notes: [],
  applied: {},
  changed: false,
  ...o,
});

const payload = (o: Partial<FindingPayload> = {}): FindingPayload => ({
  path: "src/cache/flush.ts",
  side: "new",
  line: 3,
  lineEnd: null,
  severity: "blocker",
  category: "Concurrency",
  body: "Take the lock once, before the loop.",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  evidence: "",
  anchorText: "const lock = cache.lock();",
  anchor: { state: "exact", path: "src/cache/flush.ts", oldPath: null, line: 3, lineEnd: 3, excerpt: [] },
  ...o,
});
const finding = (o: Partial<ReviewItemDto> = {}, p: Partial<FindingPayload> = {}): ReviewItemDto => ({
  id: 7,
  run: 3,
  kind: "finding",
  body: "Take the lock once, before the loop.",
  payload: payload(p),
  anchor: null,
  status: "new",
  revision: 2,
  edited: false,
  ...o,
});

describe("turns", () => {
  test("the chip says in plain words what the runner did with the point", () => {
    expect(verdictChip("upheld", "Claude")).toBe("Claude keeps this point");
    expect(verdictChip("revised", "Claude")).toBe("Claude changed this point");
    expect(verdictChip("withdrawn", "Claude")).toBe("Claude withdrew this point");
  });

  test("each run state gives one view; a failed turn names its cause", () => {
    expect(turnView(turn({ status: "running", answer: null, verdict: null }), "Claude")).toEqual({ kind: "running", startedAt: 1_000 });
    expect(turnView(turn({ status: "cancelled" }), "Claude")).toEqual({ kind: "cancelled" });
    expect(turnView(turn({ status: "failed", error: "The CLI exited with code 1." }), "Claude")).toEqual({
      kind: "failed",
      text: "The answer about the finding failed. The CLI exited with code 1.",
    });
    expect(turnView(turn({ status: "failed", error: null }), "Claude")).toEqual({
      kind: "failed",
      text: "The answer about the finding failed. No reason was recorded.",
    });
    expect(turnView(turn({ verdict: "revised" }), "Claude")).toEqual({
      kind: "answered",
      chip: "Claude changed this point",
      answer: "The timer calls `flush()` without the lock.",
      reason: "The timer path has no lock.",
    });
    // An incomplete run without a valid result has no chip.
    expect(turnView(turn({ status: "incomplete", verdict: null, answer: null, reason: null }), "Claude")).toEqual({
      kind: "answered",
      chip: null,
      answer: null,
      reason: null,
    });
  });

  test("the running line counts seconds, then minutes", () => {
    expect(startedText(1_000, 1_000)).toBe("Started 0 s ago.");
    expect(startedText(1_000, 21_000)).toBe("Started 20 s ago.");
    expect(startedText(1_000, 60_000)).toBe("Started 59 s ago.");
    expect(startedText(1_000, 61_000)).toBe("Started 1 min ago.");
    expect(startedText(1_000, 126_000)).toBe("Started 2 min ago.");
    // A clock behind the server start never shows a negative time.
    expect(startedText(5_000, 1_000)).toBe("Started 0 s ago.");
  });

  test("a start gives a running turn with the message until the next fetch", () => {
    const run = { id: 41, status: "running", startedAt: 9_000 } as RunDto;
    expect(pendingTurn(run, "Why?")).toEqual(
      turn({ run: 41, status: "running", message: "Why?", answer: null, verdict: null, reason: null, at: 9_000 }),
    );
  });
});

describe("the box and the cap", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => turn({ run: i + 1 }));

  test("the line under the box names the keys, then the messages left; another run holding the slot wins", () => {
    expect(talkHint([], null)).toBe("Ctrl+Enter asks. Esc closes the talk.");
    expect(talkHint(many(3), null)).toBe("Ctrl+Enter asks. Esc closes the talk. 97 messages left.");
    expect(talkHint(many(99), null)).toBe("Ctrl+Enter asks. Esc closes the talk. 1 message left.");
    expect(talkHint(many(3), "Claude is reviewing PROJ/repo #12. One review runs at a time.")).toBe(
      "Claude is reviewing PROJ/repo #12. One review runs at a time.",
    );
  });

  test("every turn counts toward the 100 messages, a failed one too", () => {
    expect(talkLeft([])).toBe(100);
    expect(talkLeft([...many(98), turn({ run: 300, status: "failed" })])).toBe(1);
    expect(talkLeft(many(100))).toBe(0);
    expect(talkLeft(many(101))).toBe(0);
  });

  test("a refused start names the run that holds the only slot", () => {
    expect(busyLine("review", "PROJ/repo #12")).toBe("Another run is working: Review of PROJ/repo #12. Ask again when it ends.");
    expect(busyLine("discuss", "this pull request")).toBe(
      "Another run is working: Ask about a finding of this pull request. Ask again when it ends.",
    );
  });
});

describe("what a run stored", () => {
  const o = { posted: false, waiting: undefined, runner: "Claude" };

  test("a finding that changed during the run gets the note, and nothing else", () => {
    expect(outcomeLines(turn({ verdict: "revised", changed: true, applied: {} }), o)).toEqual([DISCUSS_CHANGED]);
  });

  test("a new text that waits on the card says so; an older or a dropped one says nothing", () => {
    const revised = turn({ verdict: "revised", applied: { revision: 90 } });
    expect(outcomeLines(revised, { ...o, waiting: 90 })).toEqual(["The new text waits on the card. Use it, or keep your text."]);
    expect(outcomeLines(revised, { ...o, waiting: 91 })).toEqual([]);
    expect(outcomeLines(revised, o)).toEqual([]);
  });

  test("a withdrawn finding names Restore; a kept point adds nothing", () => {
    expect(outcomeLines(turn({ verdict: "withdrawn", applied: { discarded: true } }), o)).toEqual([
      "The finding moved to the discarded drafts. Restore brings it back.",
    ]);
    expect(outcomeLines(turn(), o)).toEqual([]);
  });

  test("a posted finding gets a reply draft in its thread, and nothing posts", () => {
    expect(outcomeLines(turn({ verdict: "withdrawn", applied: { draft: 12 } }), { ...o, posted: true })).toEqual([
      "Claude drafted a reply in this thread. Nothing posts until you accept it.",
    ]);
    expect(outcomeLines(turn({ verdict: "revised" }), { ...o, posted: true })).toEqual([]);
  });
});

describe("posted findings", () => {
  const post = (o: Partial<PostDto> = {}): PostDto => ({
    id: 1,
    pr: 7,
    run: 3,
    destination: { kind: "inline", path: "src/cache/flush.ts", srcPath: null, line: 3, lineEnd: 3, lineType: "add" },
    body: "Take the lock once.",
    items: [{ id: 7, revision: 3 }],
    state: "confirmed",
    remoteId: 5000,
    remoteVersion: 0,
    attempts: 1,
    lastError: null,
    checking: false,
    createdAt: 1,
    updatedAt: 2,
    ...o,
  });

  test("only a confirmed inline post with one finding starts a talk from its thread", () => {
    const m = talkThreads([
      post(),
      post({ id: 2, remoteId: 5001, destination: { kind: "general" }, items: [{ id: 8, revision: 1 }] }),
      post({ id: 3, remoteId: 5002, state: "pending", items: [{ id: 9, revision: 1 }] }),
      post({ id: 4, remoteId: null, state: "failed" }),
      post({ id: 5, remoteId: 5003, destination: { kind: "reply", parentId: 5000 }, items: [{ id: 10, revision: 1 }] }),
    ]);
    expect([...m]).toEqual([[5000, { item: 7, run: 3 }]]);
    expect(talkThreads(undefined).size).toBe(0);
  });

  test("two confirmed posts with one comment keep the newer finding", () => {
    const m = talkThreads([post({ items: [{ id: 11, revision: 1 }] }), post({ id: 2, items: [{ id: 7, revision: 1 }], run: 2 })]);
    expect(m.get(5000)).toEqual({ item: 11, run: 3 });
  });
});

describe("a changed finding", () => {
  test("the severity, the title, and the text show as word diffs against the current text", () => {
    const it = finding({}, { title: "Lock per entry" });
    const rev = finding(
      { id: 90, body: "Take the lock once, before the loop, when readers need whole batches." },
      { severity: "major", title: "Lock per entry", revises: 7 },
    );
    expect(revisionParts(it, rev)).toEqual({
      severity: [
        { kind: "del", text: "Blocker" },
        { kind: "add", text: "Major" },
      ],
      title: null,
      body: [
        { kind: "same", text: "Take the lock once, before the " },
        { kind: "del", text: "loop." },
        { kind: "add", text: "loop, when readers need whole batches." },
      ],
    });
  });

  test("a finding from before review v2 has no title, so the new title is added text; your edited text is the base", () => {
    const it = finding({ body: "My own words.", edited: true });
    const rev = finding({ id: 90, body: "My own words." }, { title: "A writer runs between two entries", revises: 7 });
    const p = revisionParts(it, rev);
    expect(p.severity).toBe(null);
    expect(p.title).toEqual([{ kind: "add", text: "A writer runs between two entries" }]);
    expect(p.body).toEqual([{ kind: "same", text: "My own words." }]);
  });
});

describe("a withdrawn finding", () => {
  const mark = { run: 40, reason: "The caller holds the lock", was: "accepted" as const };

  test("the discarded finding names the reason; the restored one keeps the mark and says so", () => {
    expect(withdrawnNote(finding({ status: "discarded" }, { withdrawn: mark }))).toBe(
      "Withdrawn after your talk: The caller holds the lock.",
    );
    expect(withdrawnNote(finding({ status: "accepted" }, { withdrawn: { ...mark, restored: true } }))).toBe(
      "Withdrawn after your talk: The caller holds the lock. You restored it.",
    );
    // A discard by the user after the restore is the user's own discard.
    expect(withdrawnNote(finding({ status: "discarded" }, { withdrawn: { ...mark, restored: true } }))).toBe(null);
    expect(withdrawnNote(finding({ status: "discarded" }))).toBe(null);
  });

  test("the row says Withdrawn only while the talk's discard holds", () => {
    expect(closedLabel(finding({ status: "discarded" }, { withdrawn: mark }))).toBe("Withdrawn");
    expect(closedLabel(finding({ status: "discarded" }, { withdrawn: { ...mark, restored: true } }))).toBe("Discarded");
  });

  test("the live region says what Use the new text and Keep mine did to the finding", () => {
    const rev = finding({ id: 90 }, { revises: 7 });
    expect(triageText(rev, finding(), "use-revision")).toBe("The new text is the finding now. Accept it to post.");
    expect(triageText(rev, finding(), "keep-mine")).toBe("Kept your text. The new text is gone.");
  });
});
