// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan v3 WP11, replies.md WP18, and r2 UI-RR: the pure review UI rules. The log tree, the run line, the brief state,
// the Review runs view, the reply drafts, and the re-review.
import { describe, expect, test } from "bun:test";
import type { BriefDto, CommitDto, ProfileDto, PrRow, ReviewItemDto, RunDetail, RunDto, RunnerDefaults } from "../../src/shared/dto";
import type { AnchoredFinding, Carried, Question, ReplyPayload } from "../../src/shared/review";
import type { RunEvent } from "../../src/shared/run-log";
import type { Turn } from "../../src/shared/turn";
import {
  agentDetails,
  agentInfo,
  agentPath,
  anchorNote,
  briefProfile,
  briefState,
  cardFocus,
  carriedNote,
  closedLabel,
  countText,
  draftExcerpt,
  kindRuns,
  latestByPr,
  latestReview,
  limitText,
  logTree,
  newCommits,
  notChecked,
  profileSetupText,
  questionJump,
  RUN_TEXT,
  repliesButton,
  replyCard,
  replyMap,
  rereviewCount,
  rereviewState,
  runLine,
  runRows,
  runWhy,
  setupText,
  staleText,
  subagentText,
  tokenTotal,
  triageText,
  turnedStale,
} from "../../src/web/review/model";

const ev = (id: string, seq: number, o: Partial<RunEvent> = {}): RunEvent => ({
  id,
  seq,
  parent: null,
  tool: "Read",
  target: `src/${id}.ts`,
  status: "ok",
  note: null,
  agent: null,
  model: null,
  tokens: null,
  builtin: false,
  startedAt: 1000 + seq,
  endedAt: 1100 + seq,
  ...o,
});
const agent = (id: string, seq: number, name: string, o: Partial<RunEvent> = {}) =>
  ev(id, seq, { tool: "Agent", agent: name, target: `Check ${name}`, ...o });
const shape = (nodes: ReturnType<typeof logTree>): unknown[] => nodes.map((n) => (n.kids.length ? [n.e.id, shape(n.kids)] : n.e.id));

const setup = { model: null, effort: null, reviewerMode: "auto", skillCount: 0, alwaysSkills: [] as string[], mcpCount: 0 } as const;
const PROFILES: ProfileDto[] = [
  { id: "general", name: "General", note: "", explain: false, maxTurns: 40, ...setup },
  { id: "security", name: "Security", note: "", explain: false, maxTurns: 40, ...setup },
  { id: "explain", name: "Explain", note: "", explain: true, maxTurns: 12, ...setup },
];

const run = (o: Partial<RunDto> = {}): RunDto => ({
  id: 1,
  pr: 7,
  kind: "review",
  profile: "general",
  profileName: "General",
  explain: null,
  note: "",
  status: "completed",
  errorKind: null,
  errorText: null,
  sourceHead: "a3f9e2100000000000000000000000000000000",
  targetHead: "b".repeat(40),
  mergeBase: "c".repeat(40),
  via: "pull-request-ref",
  sessionId: null,
  cliVersion: "2.1.295",
  model: "m",
  effort: null,
  effortDefault: null,
  effortNow: false,
  usage: null,
  summary: null,
  startedAt: 1_000,
  finishedAt: 61_000,
  stale: null,
  hasRaw: true,
  since: null,
  question: null,
  findings: 0,
  ...o,
});

const anchor = { state: "exact" as const, path: "src/a.ts", oldPath: null, line: 12, lineEnd: 12, excerpt: [] };
const finding = (id: number, o: Partial<ReviewItemDto> = {}, f: Partial<AnchoredFinding> = {}): ReviewItemDto => {
  const payload: AnchoredFinding = {
    path: "src/a.ts",
    side: "new",
    line: 12,
    lineEnd: null,
    anchorText: "x",
    severity: "major",
    category: "Correctness",
    body: "Body.",
    evidence: "",
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
    anchor,
    ...f,
  };
  return {
    id,
    run: 1,
    kind: "finding",
    body: payload.body,
    payload,
    anchor: { ...payload.anchor, side: payload.side },
    status: "new",
    revision: 0,
    edited: false,
    ...o,
  };
};
const question = (id: number, o: Partial<ReviewItemDto> = {}): ReviewItemDto => ({
  id,
  run: 1,
  kind: "question",
  body: "Why?",
  payload: { text: "Why?", why: "Because." } satisfies Question,
  anchor: null,
  status: "new",
  revision: 0,
  edited: false,
  ...o,
});
const detail = (r: RunDto, events: RunEvent[] = [], items: ReviewItemDto[] = []): RunDetail => ({ run: r, events, items });

describe("log tree", () => {
  test("a run without parents is a flat list in seq order", () => {
    expect(shape(logTree([ev("b", 2), ev("a", 1), ev("c", 3)]))).toEqual(["a", "b", "c"]);
  });

  test("events nest under the Agent call named by parent, at any depth", () => {
    const events = [
      ev("r1", 0),
      agent("ag1", 1, "correctness"),
      agent("ag2", 2, "concurrency"),
      ev("c1", 3, { parent: "ag1" }),
      agent("ag3", 4, "callers-scan", { parent: "ag2" }),
      ev("c2", 5, { parent: "ag3" }),
      ev("c3", 6, { parent: "ag2" }),
    ];
    expect(shape(logTree(events))).toEqual(["r1", ["ag1", ["c1"]], ["ag2", [["ag3", ["c2"]], "c3"]]]);
  });

  test("an unknown parent and a parent cycle fall back to the top level", () => {
    expect(shape(logTree([ev("a", 1, { parent: "gone" }), ev("b", 2)]))).toEqual(["a", "b"]);
    const cycle = logTree([ev("x", 1, { parent: "y" }), ev("y", 2, { parent: "x" }), ev("self", 3, { parent: "self" })]);
    expect(shape(cycle)).toEqual(["self", ["x", ["y"]]]);
  });

  test("an agent row counts its own finished calls, not nested agents or running calls", () => {
    const [ag] = logTree([
      agent("ag", 1, "concurrency", { status: "running", endedAt: null }),
      ev("c1", 2, { parent: "ag" }),
      ev("c2", 3, { parent: "ag", status: "running", endedAt: null }),
      agent("sub", 4, "callers-scan", { parent: "ag" }),
      ev("c3", 5, { parent: "sub" }),
    ]);
    expect(ag && agentInfo(ag)).toEqual({ calls: 1, words: "1 tool call so far" });
  });

  test("agentPath names the first agent with that name and its ancestors", () => {
    const events = [agent("ag2", 1, "concurrency"), agent("ag3", 2, "callers-scan", { parent: "ag2" }), agent("ag4", 3, "callers-scan")];
    expect(agentPath(events, "callers-scan")).toEqual(["ag3", "ag2"]);
    expect(agentPath(events, "nobody")).toEqual([]);
  });

  test("subagents: one part per name in call order, with counts, models, and the built-in mark", () => {
    const events = [
      ev("r1", 1),
      agent("a1", 2, "rl-reviewer", { model: "claude-sonnet-5-5", tokens: 5382 }),
      agent("a2", 3, "rl-reviewer", { model: "claude-sonnet-5-5" }),
      agent("g1", 4, "general-purpose", { builtin: true, status: "error" }),
      agent("a3", 5, "rl-reviewer", { model: "claude-haiku-5-5", status: "running", endedAt: null }),
      agent("x1", 6, "", { agent: null }),
    ];
    expect(subagentText(events)).toBe("rl-reviewer ×3 (claude-sonnet-5-5, claude-haiku-5-5), general-purpose ×1 (built-in), unnamed ×1");
    expect(subagentText([ev("r1", 1)])).toBeNull();
    expect(agentDetails(events[1] as RunEvent)).toBe("claude-sonnet-5-5, 5k tokens");
    expect(agentDetails(events[3] as RunEvent)).toBe("built-in");
    expect(agentDetails(agent("s", 7, "Explore", { builtin: true, model: "claude-haiku-5-5", tokens: 812 }))).toBe(
      "built-in, claude-haiku-5-5, 812 tokens",
    );
    expect(agentDetails(ev("r2", 8))).toBe("");
  });
});

// The row of a run. items absent: the detail is still loading.
const line = (r: RunDto, items?: ReviewItemDto[], edits?: number, events: RunEvent[] = []) =>
  runLine(r, items && detail(r, events, items), PROFILES, edits);
// The result of an ended run, else the state kind.
const result = (r: RunDto, items?: ReviewItemDto[], edits?: number) => {
  const l = line(r, items, edits);
  return l.kind === "done" ? l.result : l.kind;
};

describe("run line", () => {
  const events = [ev("r1", 0), agent("ag", 1, "x", { status: "running", endedAt: null }), ev("c1", 2, { parent: "ag" })];

  test("running: agents, finished tool calls, and the start", () => {
    const r = run({ status: "running", finishedAt: null });
    expect(line(r, [], undefined, events)).toEqual({ kind: "running", agents: 1, calls: 2, startedAt: 1_000 });
    expect(line(r)).toEqual({ kind: "running", agents: 0, calls: 0, startedAt: 1_000 });
  });

  test("completed: counts and tokens", () => {
    const usage = {
      costUsd: 0,
      turns: 3,
      durationMs: 1,
      tokens: { input_tokens: 6, output_tokens: 1897, cache_read_input_tokens: 12131, other: 5 },
    };
    expect(line(run({ usage }), [finding(1), finding(2), question(3)])).toEqual({
      kind: "done",
      result: "2 findings, 1 question",
      tokens: 14034,
      subagents: null,
    });
    // A run that used subagents names them in its row.
    expect(line(run({ usage }), [], undefined, [agent("a1", 1, "rl-reviewer", { model: "claude-sonnet-5-5" })])).toMatchObject({
      subagents: "rl-reviewer ×1 (claude-sonnet-5-5)",
    });
    expect(result(run({ profile: "explain" }), [question(1)])).toBe("Explained the change, 1 question");
    expect(result(run({ profile: "explain" }), [])).toBe("Explained the change");
    // The flag stored at the start wins over the current profile. null falls back to the current profile.
    expect(result(run({ profile: "explain", explain: false }), [])).toBe("No findings");
    expect(result(run({ profile: "gone", explain: true }))).toBe("Explained the change");
  });

  test("incomplete never says no issues; complete without items says no findings", () => {
    expect(line(run({ status: "incomplete" }), [])).toMatchObject({ result: "No findings in what it read" });
    expect(line(run(), [])).toMatchObject({ result: "No findings" });
    expect(countText([question(1)], true)).toBe("No findings in what it read, 1 question");
  });

  test("Not checked counts skipped plus unavailable, the rule of jobs.ts ended(), with one plain line each", () => {
    const c = {
      read: ["src/cache/flush.ts"],
      skipped: ["src/cache/flush.ts after line 4: the read stopped at the output limit."],
      unavailable: ["MCP server deepwiki: failed"],
      notChecked: ["Tests did not run, because the review has read-only tools", "No benchmark ran."],
    };
    expect(notChecked(c)).toEqual({
      n: 2,
      label: "Not checked: 2",
      lines: ["src/cache/flush.ts after line 4: the read stopped at the output limit.", "MCP server deepwiki: failed"],
      design: "Also not done, by design: Tests did not run, because the review has read-only tools. No benchmark ran.",
    });
    // notChecked alone does not make a run incomplete, so it adds no count.
    expect(notChecked({ ...c, skipped: [], unavailable: [] })).toMatchObject({ n: 0, label: "Not checked: 0", lines: [] });
    expect(notChecked({ read: [], skipped: [], unavailable: [], notChecked: [] }).design).toBeNull();
  });

  test("the question ledger counts open questions and points to the first one", () => {
    const qs = [question(1, { status: "discarded" }), question(2), question(3, { status: "posted" }), question(4, { status: "accepted" })];
    expect(questionJump(qs)).toEqual({ n: 2, first: 2 });
    expect(questionJump([finding(1), question(2, { status: "discarded" })])).toBeNull();
  });

  test("stale: the commits since the reviewed head, else the target branch", () => {
    const commits = ["new2", "new1", "a3f9e2100000000000000000000000000000000"].map((hash) => ({ hash, message: "", author: "", at: 0 }));
    const stale = (s: RunDto["stale"], c = commits) => staleText(run({ stale: s }), c);
    expect(stale({ source: true, target: false })).toBe("2 commits since");
    expect(stale({ source: true, target: true }, [])).toBe("New commits since");
    expect(stale({ source: false, target: true })).toBe("The target branch moved since");
    expect(stale(null)).toBeNull();
  });

  test("failed, usage limit, and cancelled", () => {
    const failed = run({ status: "failed", errorKind: "schema", errorText: "The result does not match the review schema." });
    expect(line(failed, [])).toEqual({ kind: "failed", text: "The result does not match the review schema.", raw: true });
    expect(line({ ...failed, errorText: null, hasRaw: false })).toEqual({ kind: "failed", text: "No reason was recorded.", raw: false });
    const limit = run({ status: "failed", errorKind: "usage_limit", errorText: "Usage limit reached." });
    expect(line(limit)).toEqual({ kind: "limit", text: "Usage limit reached." });
    const stopped = run({ status: "cancelled" });
    expect(line(stopped, [], undefined, events)).toEqual({ kind: "cancelled", calls: 2 });
    // The tool calls show only when the log is loaded.
    expect(line(stopped)).toEqual({ kind: "cancelled", calls: null });
  });

  test("the usage limit line quotes the CLI message and says that nothing retries", () => {
    expect(limitText("Runner", "Usage limit reached. Your limit resets at 6pm.")).toBe(
      "Runner: Usage limit reached. Your limit resets at 6pm. PR Review Inbox does not retry by itself.",
    );
    expect(limitText("Runner", null)).toBe("Runner usage limit reached. PR Review Inbox does not retry by itself.");
  });

  test("tokens add the four usage counters and skip other fields", () => {
    expect(tokenTotal(null)).toBeNull();
    expect(tokenTotal({ costUsd: 0, turns: 0, durationMs: 0, tokens: {} })).toBeNull();
    expect(
      tokenTotal({ costUsd: 0, turns: 0, durationMs: 0, tokens: { input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: "3" } }),
    ).toBe(3);
  });
});

describe("brief state", () => {
  const brief = (o: Partial<BriefDto> = {}): BriefDto => ({ note: "", profile: "general", updatedAt: null, ...o });

  test("the state names the stored profile; the hint names no profile, because the brief holds the pick", () => {
    const s = briefState(brief({ profile: "security", note: "Check X", updatedAt: 5 }), null, 7, PROFILES);
    expect(s.name).toBe("Security");
    expect(s.hint).toBe("Open the review brief with your note. Pick the profile and start the review there. Key: r.");
    expect(briefState(brief(), null, 7, PROFILES).hint).toBe("Open the review brief. Pick the profile and start the review there. Key: r.");
    expect(briefState(brief({ profile: "over" }), null, 7, PROFILES).name).toBe("General");
    // An unknown profile never falls back to an Explain profile while a review profile exists (the server rule).
    const explainFirst = [...PROFILES].sort((a, b) => Number(b.explain) - Number(a.explain));
    expect(explainFirst[0]?.explain).toBe(true);
    expect(briefState(brief({ profile: "over" }), null, 7, explainFirst).name).toBe(explainFirst.find((p) => !p.explain)?.name as string);
  });

  // Decision D2 (plan pr-view-v4): the stored brief of the PR wins, else the last profile used on any PR.
  test("the brief preselects the stored profile, else the last used one, and marks it", () => {
    expect(briefProfile(brief({ profile: "security", updatedAt: 5 }), "explain", PROFILES)).toEqual({ profile: "security", tag: "pr" });
    // A stored brief with the default profile still wins over the last used one.
    expect(briefProfile(brief({ updatedAt: 5 }), "security", PROFILES)).toEqual({ profile: "general", tag: "pr" });
    expect(briefProfile(brief(), "security", PROFILES)).toEqual({ profile: "security", tag: "any" });
    // Nothing used yet, or a last profile that the settings no longer list: the server default, without the mark.
    expect(briefProfile(brief(), null, PROFILES)).toEqual({ profile: "general", tag: null });
    expect(briefProfile(brief(), "removed", PROFILES)).toEqual({ profile: "general", tag: null });
  });

  test("busy names the PR of a running review", () => {
    expect(briefState(brief(), run({ pr: 9, status: "running" }), 7, PROFILES).busy).toEqual({ pr: 9, same: false });
    expect(briefState(brief(), run({ pr: 7, status: "running" }), 7, PROFILES).busy).toEqual({ pr: 7, same: true });
    expect(briefState(brief(), null, 7, PROFILES).busy).toBeNull();
  });
});

describe("run setup of a profile in the brief", () => {
  const p = (o: Partial<ProfileDto> = {}): ProfileDto => ({ ...(PROFILES[0] as ProfileDto), ...o });
  const defaults: RunnerDefaults = {
    model: { value: "opus", sure: true },
    effort: {
      "": { value: "xhigh", sure: true },
      "claude-opus-5-5": { value: "medium", sure: true },
      "opus[1m]": { value: "high", sure: false },
    },
  };

  test("without flags it names the defaults of the runner settings", () => {
    expect(profileSetupText(p(), defaults)).toBe(
      "opus (your default), xhigh effort (your default). Reviewer agents: Auto. No skills or MCP servers.",
    );
    expect(profileSetupText(p(), null)).toBe("default model, default effort. Reviewer agents: Auto. No skills or MCP servers.");
  });

  test("a profile model finds its default effort by its own text; a value that is not sure stays plain", () => {
    expect(profileSetupText(p({ model: "claude-opus-5-5" }), defaults)).toMatch(/^claude-opus-5-5, medium effort \(your default\)\./);
    expect(profileSetupText(p({ model: "opus[1m]" }), defaults)).toMatch(/^opus\[1m\], default effort\./);
    expect(profileSetupText(p({ model: "unknown-model" }), defaults)).toMatch(/^unknown-model, default effort\./);
  });

  test("flags, reviewer mode, and counts", () => {
    expect(profileSetupText(p({ model: "haiku", effort: "low", reviewerMode: "always", skillCount: 2, mcpCount: 1 }), defaults)).toBe(
      "haiku, low effort. Reviewer agents: Always. 2 skills, 1 MCP server.",
    );
    expect(profileSetupText(p({ explain: true, mcpCount: 3 }), defaults)).toBe(
      "opus (your default), xhigh effort (your default). No reviewer agents. 3 MCP servers.",
    );
  });
});

describe("new commits since a run", () => {
  const commits = ["c3", "c2", "c1"].map((hash) => ({ hash }) as CommitDto);

  test("counts the commits after the run head; an unknown or newest head gives null", () => {
    expect(newCommits(run({ sourceHead: "c1" }), commits)).toBe(2);
    expect(newCommits(run({ sourceHead: "c3" }), commits)).toBeNull();
    expect(newCommits(run({ sourceHead: "zz" }), commits)).toBeNull();
    expect(newCommits(run({ sourceHead: "c1" }), undefined)).toBeNull();
  });
});

describe("drafts", () => {
  test("the excerpt marks the anchored lines on the finding's side", () => {
    const excerpt = [
      { n: 11, kind: "ctx" as const, text: "a" },
      { n: 12, kind: "del" as const, text: "old" },
      { n: 12, kind: "add" as const, text: "new" },
      { n: 13, kind: "add" as const, text: "next" },
      { n: 14, kind: "ctx" as const, text: "z" },
    ];
    const lines = draftExcerpt({ ...anchor, line: 12, lineEnd: 13, excerpt, side: "new" });
    expect(lines.map((l) => l.hit)).toEqual([false, false, true, true, false]);
  });

  test("anchor notes: outside, moved by you, moved, exact", () => {
    expect(anchorNote(finding(1, { anchor: { ...anchor, state: "outside", side: "new" } }))).toBe(
      "Outside the diff. Posts as a general comment with a link to a.ts:12.",
    );
    expect(anchorNote(finding(1, { anchor: { ...anchor, line: 14, lineEnd: 14, side: "new" } }))).toBe("You moved it from line 12.");
    expect(anchorNote(finding(1, {}, { line: 9, anchor: { ...anchor, state: "moved" } }))).toBe(
      "Moved from line 9: the quoted code is on line 12.",
    );
    expect(anchorNote(finding(1))).toBeNull();
  });

  test("triage text: each action says what happened to the item that loses the focus", () => {
    const accepted = finding(1, { status: "accepted" });
    expect(triageText(finding(1), accepted, "accept")).toBe("Accepted.");
    expect(triageText(finding(1), finding(1, { status: "discarded" }), "discard")).toBe("Discarded.");
    expect(triageText(accepted, finding(1), "restore")).toBe("Accept undone.");
    expect(triageText(finding(1, { status: "discarded" }), finding(1), "restore")).toBe("Restored.");
    expect(triageText(finding(1), accepted, "edit")).toBe("Saved and accepted.");
    expect(triageText(finding(1), finding(1, { anchor: { ...anchor, line: 13, lineEnd: 14, side: "new" } }), "move")).toBe(
      "Moved to line 13–14.",
    );
    expect(triageText(question(2), question(2), "move")).toBe("Moved.");
  });
});

describe("Review runs view", () => {
  const pr = (id: number, title: string): PrRow => ({ id, title, project: "P", repo: "r", prId: id, tasks: [] }) as unknown as PrRow;

  test("one row per PR with a run: running first, then the newest run", () => {
    const runs = [
      run({ id: 5, pr: 2, startedAt: 50 }),
      run({ id: 4, pr: 3, status: "running", startedAt: 40 }),
      run({ id: 3, pr: 2, startedAt: 30 }),
    ];
    const latest = latestByPr(runs);
    expect([...latest].map(([p, r]) => [p, r.id])).toEqual([
      [2, 5],
      [3, 4],
    ]);
    const rows = runRows([pr(1, "No run"), pr(2, "Two"), pr(3, "Three")], latest, "");
    expect(rows.map((p) => p.id)).toEqual([3, 2]);
    expect(runRows([pr(2, "Two"), pr(3, "Three")], latest, "thr").map((p) => p.id)).toEqual([3]);
  });

  test("the why-line names the state, the findings, the profile, and the outcome", () => {
    expect(runWhy(run({ status: "running" }))).toEqual({
      chip: "Running",
      error: false,
      count: "Review",
      lead: null,
      text: "General: reviewing now.",
    });
    const summary = {
      summary: "Deadlock risk.",
      risks: [],
      coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
      dropped: [],
    };
    expect(runWhy(run({ summary, findings: 3 }))).toEqual({
      chip: "Done",
      error: false,
      count: "3 findings",
      lead: "General:",
      text: "Deadlock risk.",
    });
    expect(runWhy(run({ summary, findings: 1 })).count).toBe("1 finding");
    expect(runWhy(run({ summary })).count).toBe("No findings");
    const gaps = runWhy(run({ status: "incomplete", summary }));
    expect([gaps.chip, gaps.count, gaps.text]).toEqual(["Done", "No findings in what it read", "Deadlock risk. Coverage has gaps."]);
    expect(runWhy(run({ status: "failed", errorKind: "usage_limit", errorText: "Resets at 6pm." }))).toEqual({
      chip: "Usage limit",
      error: true,
      count: "Review",
      lead: null,
      text: "General: Resets at 6pm.",
    });
    expect(runWhy(run({ status: "failed", errorKind: "schema", errorText: "Bad." })).chip).toBe("Failed");
    const cancelled = runWhy(run({ status: "cancelled" }));
    expect([cancelled.chip, cancelled.error, cancelled.text]).toEqual(["Cancelled", false, "General: you cancelled it."]);
    // Other kinds and Explain runs have no findings, so the row names the kind.
    expect(runWhy(run({ kind: "reply", summary })).count).toBe("Reply drafts");
    expect(runWhy(run({ kind: "fix", summary })).count).toBe("Fixes");
    expect(runWhy(run({ profile: "explain", summary })).count).toBe("Review");
  });

  test("the why-line keeps the profile name of the run start after a rename", () => {
    expect(runWhy(run({ status: "cancelled", profile: "general", profileName: "Correctness" })).text).toBe(
      "Correctness: you cancelled it.",
    );
  });
});

describe("reply drafts", () => {
  const reply = (
    id: number,
    thread: number,
    replyTo: number,
    o: Partial<ReviewItemDto> = {},
    p: Partial<ReplyPayload> = {},
  ): ReviewItemDto => {
    const payload: ReplyPayload = {
      thread,
      action: "reply",
      body: "Fixed.",
      reason: "It asks for a change.",
      evidenceStatus: "code",
      replyTo,
      ...p,
    };
    return { id, run: 2, kind: "reply", body: payload.body, payload, anchor: null, status: "new", revision: 0, edited: false, ...o };
  };

  test("R14: the newest review run drives the drafts, even after a newer reply run", () => {
    const runs = [run({ id: 9, kind: "reply" }), run({ id: 8, kind: "reply" }), run({ id: 7 }), run({ id: 3 })];
    expect(latestReview(runs)?.id).toBe(7);
    expect(latestReview([run({ id: 9, kind: "reply" })])).toBeNull();
    expect(latestReview(undefined)).toBeNull();
  });

  test("a cancelled or failed review run keeps the drafts and the re-review base of the review before it", () => {
    const summary = { summary: "S.", risks: [], coverage: { read: [], skipped: [], unavailable: [], notChecked: [] }, dropped: [] };
    const stale = { source: true, target: false };
    const brief: BriefDto = { note: "", profile: "general", updatedAt: 5 };
    const done = run({ id: 7, summary, stale });
    // The base was itself a re-review.
    const chained = run({ id: 7, summary, stale, since: { head: "c".repeat(40), incremental: true } });
    for (const status of ["cancelled", "failed"] as const)
      for (const base of [done, chained]) {
        const runs = [run({ id: 9, status, summary: null, stale: { source: false, target: false } }), run({ id: 8, kind: "reply" }), base];
        expect(latestReview(runs)?.id).toBe(7);
        expect(rereviewState(latestReview(runs), brief, PROFILES)).toEqual({ since: "a3f9e21" });
      }
    // No review run with a result: the newest review run still shows.
    expect(latestReview([run({ id: 9, status: "cancelled" }), run({ id: 4, status: "failed" })])?.id).toBe(9);
    expect(latestReview([run({ id: 9, status: "running" }), done])?.id).toBe(9);
  });

  test("the reply row counts the drafts and the threads that need no reply", () => {
    const items = [
      reply(1, 101, 105),
      reply(2, 102, 205),
      reply(3, 103, 305, { body: "", status: "discarded" }, { action: "none", body: "" }),
    ];
    expect(result(run({ kind: "reply" }), items)).toBe("2 reply drafts, 1 thread needs no reply");
    // An explain profile explains a review, but a reply run still drafts replies.
    expect(result(run({ kind: "reply", profile: "explain" }), [])).toBe("No reply drafts");
    expect(countText([reply(3, 103, 305, {}, { action: "none" }), reply(4, 104, 405, {}, { action: "none" })], false, "reply")).toBe(
      "No reply drafts, 2 threads need no reply",
    );
    expect(RUN_TEXT.reply).toEqual({
      running: "Drafting replies…",
      failed: "Reply drafts failed.",
      cancelled: "the reply drafts",
      doing: "drafting replies for",
      now: "drafting replies",
    });
    expect(RUN_TEXT.review.running).toBe("Reviewing…");
    expect(runWhy(run({ kind: "reply", status: "running" })).text).toBe("General: drafting replies now.");
  });

  // Plan r2 section 7: an ask run is never labeled as a review. It has no items, so its count is empty.
  test("an ask run reads Answering… while it runs and Answered when done", () => {
    expect(RUN_TEXT.ask.running).toBe("Answering…");
    expect(RUN_TEXT.ask.doing).toBe("answering a question on");
    expect(runWhy(run({ kind: "ask", status: "running" })).text).toBe("General: answering a question now.");
    expect(runWhy(run({ kind: "review", status: "running" })).text).toBe("General: reviewing now.");
    // The Explain flag names a review "explained". An ask run keeps its own result.
    expect(result(run({ kind: "ask", profile: "explain", question: "Why?" }), [])).toBe("Answered");
    expect(countText([], false, "ask")).toBe("");
  });

  test("the thread-to-draft map keys reply items by thread and skips other kinds", () => {
    const m = replyMap([reply(1, 101, 105), finding(2), reply(3, 103, 305), question(4)]);
    expect([...m.keys()]).toEqual([101, 103]);
    expect(m.get(103)?.id).toBe(3);
    expect(replyMap(undefined).size).toBe(0);
  });

  test("a draft is stale when its parent is no longer the newest live message", () => {
    const it = reply(1, 101, 105);
    expect(replyCard(it, 105, false)).toEqual({ kind: "draft", it, stale: false });
    expect(replyCard(it, 106, false)).toEqual({ kind: "draft", it, stale: true });
    // Every message deleted: no newest message, so nothing to compare.
    expect(replyCard(it, null, false)).toEqual({ kind: "draft", it, stale: false });
  });

  test("card kinds: pending wins, none has no body, discarded folds, no item gives no card", () => {
    const none = reply(2, 101, 105, { body: "", status: "discarded" }, { action: "none", body: "" });
    const gone = reply(3, 101, 105, { status: "discarded" });
    expect(replyCard(reply(1, 101, 105), 105, true)).toEqual({ kind: "pending", revise: false, id: 1 });
    expect(replyCard(undefined, 105, true)).toEqual({ kind: "pending", revise: false, id: null });
    // docs/plans/thread-outcome.md: a run for an out-of-date draft that you accepted or edited revises it.
    expect(replyCard(reply(1, 101, 105, { status: "accepted" }), 106, true)).toEqual({ kind: "pending", revise: true, id: 1 });
    expect(replyCard(reply(1, 101, 105, { edited: true }), 106, true)).toEqual({ kind: "pending", revise: true, id: 1 });
    expect(replyCard(reply(1, 101, 105, { status: "accepted" }), 105, true)).toEqual({ kind: "pending", revise: false, id: 1 });
    expect(replyCard(reply(1, 101, 105), 106, true)).toEqual({ kind: "pending", revise: false, id: 1 });
    expect(replyCard(none, 106, false)).toEqual({ kind: "none", it: none, stale: true });
    expect(replyCard(gone, 106, false)).toEqual({ kind: "discarded", it: gone });
    // An edited none draft has a body, so it can be accepted.
    const written = reply(4, 101, 105, { body: "My answer.", status: "accepted" }, { action: "none", body: "" });
    expect(replyCard(written, 105, false)).toMatchObject({ kind: "draft", stale: false });
    expect(replyCard(undefined, 105, false)).toBeNull();
  });

  test("card focus: a lost focus goes to Draft again when the card went out of date, else to the card; a new pending line takes it", () => {
    const draft = { kind: "draft", stale: false } as const;
    const stale = { kind: "draft", stale: true } as const;
    const pending = { kind: "pending", stale: false } as const;
    // Accept or Edit of a draft that goes out of date in a sync.
    expect(cardFocus({ before: draft, now: stale, lost: true, gone: true })).toBe("again");
    // Draft again, Use revision, or Discard: the focused control leaves, and the card stays or becomes the pending line.
    expect(cardFocus({ before: stale, now: pending, lost: true, gone: true })).toBe("card");
    expect(cardFocus({ before: stale, now: stale, lost: true, gone: true })).toBe("card");
    // Draft reply in the thread footer leaves as the pending line mounts. A pending line that stays takes nothing.
    expect(cardFocus({ before: null, now: pending, lost: true, gone: false })).toBe("card");
    expect(cardFocus({ before: pending, now: pending, lost: true, gone: false })).toBeNull();
    // The focus is elsewhere, or no control of the card left: the focus stays.
    expect(cardFocus({ before: draft, now: stale, lost: false, gone: true })).toBeNull();
    expect(cardFocus({ before: draft, now: stale, lost: true, gone: false })).toBeNull();
    // Only a change says "out of date": a card that mounts out of date says nothing.
    expect(turnedStale(draft, stale)).toBe(true);
    expect(turnedStale(null, stale)).toBe(false);
    expect(turnedStale(stale, stale)).toBe(false);
  });

  test("resolve: a proposal or a tick without text is a draft card; the counts name the threads to resolve; the tick has its own live text", () => {
    const only = reply(1, 101, 105, { body: "" }, { action: "none", body: "", resolve: true, resolveTick: true });
    const unticked = reply(2, 102, 205, { body: "" }, { action: "none", body: "", resolve: true, resolveTick: false });
    const both = reply(3, 103, 305, {}, { resolve: true, resolveTick: true });
    expect(replyCard(only, 105, false)).toEqual({ kind: "draft", it: only, stale: false });
    expect(replyCard(unticked, 205, false)).toEqual({ kind: "draft", it: unticked, stale: false });
    expect(replyCard({ ...only, status: "discarded" }, 105, false)).toMatchObject({ kind: "discarded" });
    const none = reply(4, 104, 405, { body: "" }, { action: "none", body: "" });
    expect(countText([only, unticked, both, none], false, "reply")).toBe("1 reply draft, 3 threads to resolve, 1 thread needs no reply");
    expect(countText([only], false, "reply")).toBe("1 thread to resolve");
    // A re-review counts its resolve proposals apart from the findings and the questions.
    expect(rereviewCount([only, question(5)])).toBe("0 new, 0 carried, 0 fixed or outdated, 1 posted thread to resolve, 1 question");
    expect(countText([finding(6), only], false)).toBe("1 finding");
    // docs/plans/thread-outcome.md section 9: the answer drafts of a review run count apart.
    const answer = reply(7, 107, 705, {}, { origin: "review", judgement: "followup" });
    const settled = reply(8, 108, 805, { body: "" }, { origin: "review", action: "none", body: "", resolve: true, resolveTick: true });
    expect(countText([finding(6), answer, settled, only], false)).toBe("1 finding, 2 answered threads");
    expect(countText([answer], false)).toBe("1 answered thread");
    expect(countText([answer], true)).toBe("No findings in what it read, 1 answered thread");
    expect(rereviewCount([only, answer, question(5)])).toBe(
      "0 new, 0 carried, 0 fixed or outdated, 1 posted thread to resolve, 1 question, 1 answered thread",
    );
    expect(triageText(both, only, "resolve")).toBe("The thread resolves after the post.");
    expect(triageText(only, unticked, "resolve")).toBe("The thread stays open after the post.");
  });

  test("the Draft replies button: a run for your-turn threads, else the popover reason (plan pr-view-v4 2.2)", () => {
    const turns = (your: number, ...rest: Turn[]): Turn[] => [...Array<Turn>(your).fill("your"), ...rest];
    expect(repliesButton(turns(1, "wait", "resolved"))).toEqual({
      your: 1,
      need: 1,
      why: null,
      hint: "Draft a reply for the thread where it is your turn.",
    });
    expect(repliesButton(turns(3)).hint).toBe("Draft a reply for each of the 3 threads where it is your turn.");
    expect(repliesButton(turns(25)).why).toBeNull();
    expect(repliesButton(turns(26))).toEqual({
      your: 26,
      need: 26,
      why: { title: "26 threads wait for your reply.", text: "Draft at most 25 at a time: use Draft reply in each thread." },
      hint: "26 threads wait for your reply.",
    });
    // docs/plans/thread-outcome.md: the count names the threads whose outcome needs a reply. The run still takes each your-turn thread.
    expect(repliesButton(turns(3), 1)).toEqual({
      your: 3,
      need: 1,
      why: null,
      hint: "Draft a reply for each of the 3 threads where it is your turn. 1 thread still needs a reply.",
    });
    expect(repliesButton(turns(2), 0)).toMatchObject({ need: 0, why: null, hint: expect.stringMatching(/ None needs a new reply\.$/) });
    expect(repliesButton(turns(1), 5).need).toBe(1);
    const no = "No thread waits for your reply.";
    expect(repliesButton(["wait", "wait", "resolved"]).why).toEqual({
      title: no,
      text: "Your message is the newest in each open thread. They wait for the other person.",
    });
    expect(repliesButton(["wait"]).why?.text).toBe("Your message is the newest in the open thread. It waits for the other person.");
    // "other": a thread without your message. The plan text would be wrong there.
    expect(repliesButton(["wait", "other"]).why).toEqual({
      title: no,
      text: "Each open thread waits for another person, or it has no message from you.",
    });
    expect(repliesButton(["resolved", "resolved"])).toMatchObject({
      your: 0,
      why: { title: "No open thread.", text: "Every thread is resolved, so no reply is due." },
    });
  });
});

describe("re-review", () => {
  const since = "1".repeat(40);
  const carried = (verdict: Carried["verdict"]): Partial<AnchoredFinding> & { carried: Carried } => ({
    carried: { from: 1, verdict, reason: "Why.", since },
  });
  // A finding copied by a re-review. The payload type of the DTO allows carried on every kind.
  const copy = (id: number, verdict: Carried["verdict"], o: Partial<ReviewItemDto> = {}) => finding(id, o, carried(verdict));

  test("the review row counts new, carried, and closed findings", () => {
    const r = run({ since: { head: since, incremental: true } });
    const items = [finding(1), copy(2, "open"), copy(3, "fixed", { status: "discarded" }), copy(4, "outdated", { status: "discarded" })];
    expect(result(r, [...items, question(5)])).toBe("1 new, 1 carried, 2 fixed or outdated, 1 question");
    // The server fell back to the full change.
    expect(result(run({ since: { head: since, incremental: false } }), [])).toBe("0 new, 0 carried, 0 fixed or outdated");
    expect(result(run(), [])).toBe("No findings");
    expect(rereviewCount([copy(1, "open", { status: "accepted" }), copy(2, "open", { status: "discarded" })])).toBe(
      "0 new, 2 carried, 0 fixed or outdated",
    );
  });

  test("the button shows only when the server takes a re-review", () => {
    const brief = (profile = "general"): BriefDto => ({ note: "", profile, updatedAt: 5 });
    const stale = { source: true, target: false };
    const done = run({
      summary: { summary: "S.", risks: [], coverage: { read: [], skipped: [], unavailable: [], notChecked: [] }, dropped: [] },
    });
    expect(rereviewState({ ...done, stale }, brief(), PROFILES)).toEqual({ since: "a3f9e21" });
    expect(rereviewState({ ...done, stale, status: "incomplete" }, brief(), PROFILES)).toEqual({ since: "a3f9e21" });
    const why = (r: RunDto | null, b: BriefDto | undefined = brief()) => {
      const s = rereviewState(r, b, PROFILES);
      return "why" in s ? s.why : s.since;
    };
    expect(why(null)).toBe("No review has run on this pull request yet. Press r to start one.");
    expect(why({ ...done, stale, status: "running", summary: null })).toBe("The review is still running.");
    expect(why({ ...done, stale, status: "failed", summary: null })).toBe("The last review has no result. Press r to review again.");
    // jobs.ts baseRun: COALESCE(explain, profile = 'explain') = 0.
    expect(why({ ...done, stale, explain: true })).toBe("The last run explained the change and gave no findings. Press r to review it.");
    expect(why({ ...done, stale, profile: "explain" })).toBe(
      "The last run explained the change and gave no findings. Press r to review it.",
    );
    expect(why({ ...done, stale, profile: "explain", explain: false })).toBe("a3f9e21");
    expect(why(done)).toBe("The source branch has no new commits since the last review.");
    expect(why({ ...done, stale: { source: false, target: true } })).toBe("The source branch has no new commits since the last review.");
    expect(rereviewState({ ...done, stale }, undefined, PROFILES)).toEqual({ why: "The review brief is still loading." });
    expect(why({ ...done, stale }, brief("explain"))).toBe("The Explain profile gives no findings. Pick a review profile first.");
  });

  test("closed rows name the verdict; carried drafts say what the re-review found", () => {
    expect(closedLabel(copy(1, "fixed", { status: "discarded" }))).toBe("Fixed in the new commits");
    expect(closedLabel(copy(1, "outdated", { status: "discarded", anchor: null }))).toBe("Outdated");
    expect(closedLabel(copy(1, "open", { status: "discarded" }))).toBe("Discarded");
    expect(closedLabel(finding(1, { status: "discarded" }))).toBe("Discarded");
    expect(carriedNote(copy(1, "open"))).toBe("Still open after the new commits.");
    expect(carriedNote(copy(1, "fixed"))).toBe("Fixed in the new commits. You restored it.");
    expect(carriedNote(finding(1))).toBeNull();
  });
});

describe("one row per run kind", () => {
  const replyItem = (id: number, action: ReplyPayload["action"]): ReviewItemDto => {
    const payload: ReplyPayload = { thread: id, action, body: "Ok.", reason: "", evidenceStatus: "code", replyTo: id };
    return {
      id,
      run: 4,
      kind: "reply",
      body: action === "none" ? "" : "Ok.",
      payload,
      anchor: null,
      status: "new",
      revision: 0,
      edited: false,
    };
  };

  test("the newest run of each kind, newest first", () => {
    const runs = [
      run({ id: 5, kind: "fix" }),
      run({ id: 4, kind: "reply" }),
      run({ id: 3 }),
      run({ id: 2, kind: "reply" }),
      run({ id: 1, kind: "ask" }),
    ];
    expect(kindRuns(runs).map((r) => r.id)).toEqual([5, 4, 3, 1]);
    expect(kindRuns(undefined)).toEqual([]);
  });

  test("the result names the outcome of each kind, and it is empty while the items load", () => {
    const items = [replyItem(1, "reply"), replyItem(2, "reply"), replyItem(3, "none")];
    expect(result(run({ kind: "reply" }), items)).toBe("2 reply drafts, 1 thread needs no reply");
    expect(result(run({ kind: "reply" }))).toBe("");
    expect(result(run(), [finding(1), finding(2), question(3)])).toBe("2 findings, 1 question");
    expect(result(run({ status: "incomplete" }), [])).toBe("No findings in what it read");
    expect(result(run({ kind: "fix" }), [], 2)).toBe("2 edits");
    expect(result(run({ kind: "fix" }), [], 0)).toBe("No edits");
    expect(result(run({ kind: "fix" }), [])).toBe("");
    expect(result(run({ kind: "ask" }))).toBe("Answered");
    expect(result(run({ status: "cancelled" }), [])).toBe("cancelled");
    expect(result(run({ status: "failed", errorKind: "usage_limit" }), [])).toBe("limit");
    expect(result(run({ status: "failed", errorKind: "schema" }), [])).toBe("failed");
    expect(result(run({ kind: "reply", status: "running" }))).toBe("running");
    const since = { head: "d".repeat(40), incremental: true };
    expect(result(run({ since }), [finding(1)])).toBe("1 new, 0 carried, 0 fixed or outdated");
  });
});

describe("model and effort of a run", () => {
  const run = (o: Partial<Pick<RunDto, "model" | "effort" | "effortDefault" | "effortNow" | "status">>) => ({
    model: null,
    effort: "default",
    effortDefault: null,
    effortNow: false,
    status: "completed" as const,
    ...o,
  });
  const defaults: RunnerDefaults = { model: { value: "opus", sure: true }, effort: { "": { value: "xhigh", sure: true } } };

  test("without a settings file, an unknown value reads as default", () => {
    expect(setupText(run({ model: "claude-opus-5-5", effort: "high" }), null)).toBe("claude-opus-5-5, high effort");
    expect(setupText(run({}), null)).toBe("default model, default effort");
    // A run from before the effort column ran without --effort.
    expect(setupText(run({ model: "claude-haiku-5-5", effort: null }), null)).toBe("claude-haiku-5-5, default effort");
  });

  test("a run without --effort names the effort from the user settings", () => {
    expect(setupText(run({ model: "claude-opus-5-5", effortDefault: "xhigh" }), defaults)).toBe(
      "claude-opus-5-5, xhigh effort (your default)",
    );
    // An explicit --effort wins over a stale default.
    expect(setupText(run({ model: "m", effort: "low", effortDefault: "xhigh" }), defaults)).toBe("m, low effort");
  });

  test("a running run before its init event names the default model and the effort stored at its start", () => {
    expect(setupText(run({ status: "running", effortDefault: "xhigh" }), defaults)).toBe(
      "opus (your default), xhigh effort (your default)",
    );
    // A model value that the runner docs do not rank stays plain.
    expect(setupText(run({ status: "running" }), { ...defaults, model: { value: "opus", sure: false } })).toBe(
      "default model, default effort",
    );
  });

  test("a run that stored no default effort names the current settings value as now", () => {
    expect(setupText(run({ model: "claude-opus-5-5", effortDefault: "xhigh", effortNow: true }), defaults)).toBe(
      "claude-opus-5-5, xhigh effort (your default now)",
    );
    expect(setupText(run({ model: "claude-haiku-5-5", effort: null, effortDefault: "medium", effortNow: true }), defaults)).toBe(
      "claude-haiku-5-5, medium effort (your default now)",
    );
    // A run that ended before its init event without --model.
    expect(setupText(run({ status: "failed" }), defaults)).toBe("opus (your default now), default effort");
  });
});
