// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Improve prompt: the pure rules of the dialog. The line diff, the request body, and the error texts.
import { describe, expect, test } from "bun:test";
import { improveInput } from "../../src/shared/dto";
import { MAX_QUESTION } from "../../src/shared/review";
import { type DiffLine, failedText, improveBody, lineDiff, MAX_GOAL, runningText, unchanged } from "../../src/web/settings/improve";
import { toDrafts } from "../../src/web/settings/profiles";

const RUNNER = { name: "Runner Code", login: "runner auth login" };
// The diff as text: " " same, "-" removed, "+" added.
const show = (d: DiffLine[]) => d.map((l) => `${{ same: " ", del: "-", add: "+" }[l.kind]}${l.text}`);

describe("lineDiff", () => {
  test("equal lines stay, and a changed line is a removal and an addition", () => {
    expect(show(lineDiff("a\nb\nc", "a\nB\nc"))).toEqual([" a", "-b", "+B", " c"]);
    expect(show(lineDiff("a\nb", "a\nb"))).toEqual([" a", " b"]);
    expect(show(lineDiff("a\nb\nc\nd", "b\nx\nd\ne"))).toEqual(["-a", " b", "-c", "+x", " d", "+e"]);
  });

  test("an empty side gives only additions or only removals", () => {
    expect(show(lineDiff("", "new\nlines"))).toEqual(["+new", "+lines"]);
    expect(show(lineDiff("old", ""))).toEqual(["-old"]);
    expect(lineDiff("", "")).toEqual([]);
  });

  test("the diff keeps every line of both texts in order", () => {
    const a = Array.from({ length: 60 }, (_, i) => `line ${i % 7}`).join("\n");
    const b = Array.from({ length: 50 }, (_, i) => `line ${i % 5}`).join("\n");
    const d = lineDiff(a, b);
    expect(d.filter((l) => l.kind !== "add").map((l) => l.text)).toEqual(a.split("\n"));
    expect(d.filter((l) => l.kind !== "del").map((l) => l.text)).toEqual(b.split("\n"));
  });

  test("a very large change still lists every line", () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join("\n");
    const d = lineDiff(`top\n${a}\nend`, `top\n${b}\nend`);
    expect(d).toHaveLength(3002);
    expect(d[0]).toEqual({ kind: "same", text: "top" });
    expect(d.at(-1)).toEqual({ kind: "same", text: "end" });
  });
});

describe("improveBody", () => {
  test("it sends the draft as a save trims it, with the goal and the run setup", () => {
    const [d] = toDrafts([
      {
        id: "general",
        name: " General ",
        note: " Correctness ",
        prompt: "  Find defects.\n",
        explain: false,
        docs: true,
        languageChecks: true,
        maxTurns: 100,
        skills: [],
        alwaysSkills: [],
        mcp: [],
        model: "opus",
        effort: "high",
        reviewer: { model: null, effort: null, mode: "auto" },
        modules: [],
        volume: "balanced",
        verifier: { mode: "on", model: null, effort: null },
        variants: [],
      },
    ]);
    if (!d) throw new Error("no draft");
    const body = improveBody(d, "  C++ lifetime bugs ");
    expect(body).toEqual({
      name: "General",
      note: "Correctness",
      prompt: "Find defects.",
      explain: false,
      docs: true,
      languageChecks: true,
      model: "opus",
      effort: "high",
      goal: "C++ lifetime bugs",
    });
    expect(improveInput.safeParse(body).success).toBe(true);
    expect(improveBody({ ...d, model: " ", effort: "" }, "").model).toBeNull();
  });

  test("the goal limit matches the server", () => {
    expect(MAX_GOAL).toBe(MAX_QUESTION);
    const body = { name: "", note: "", prompt: "", explain: false, docs: false, languageChecks: false, model: null, effort: null };
    expect(improveInput.safeParse({ ...body, goal: "g".repeat(MAX_GOAL) }).success).toBe(true);
    expect(improveInput.safeParse({ ...body, goal: "g".repeat(MAX_GOAL + 1) }).success).toBe(false);
  });
});

describe("texts", () => {
  test("a usage limit and a wrong login use the run line and brief texts; other errors say the proposal failed", () => {
    expect(failedText({ id: 1, status: "failed", kind: "usage_limit", text: "Limit reached." }, RUNNER)).toBe(
      "Runner Code: Limit reached. PR Review Inbox does not retry by itself.",
    );
    expect(failedText({ id: 1, status: "failed", kind: "auth", text: "authMethod is api_key." }, RUNNER)).toBe(
      "authMethod is api_key. Run: runner auth login",
    );
    expect(failedText({ id: 1, status: "failed", kind: "schema", text: "Bad." }, RUNNER)).toBe("The proposal failed. Bad.");
    expect(runningText("Runner")).toBe("Runner is writing a proposal…");
  });

  test("a proposal that differs only in outer space is unchanged", () => {
    expect(unchanged("Find leaks.", " Find leaks.\n")).toBe(true);
    expect(unchanged("Find leaks.", "Find races.")).toBe(false);
  });
});
