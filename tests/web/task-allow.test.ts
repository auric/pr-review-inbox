// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The commands that Claude may run in the page (src/web/tasks/allow.ts, docs/plans/review-v2/spec.md section 6.21): the row checks, the
// plan picks, the choices of an allow request with the first-use warning, the mode words, and "Longest command" in minutes.
import { describe, expect, test } from "bun:test";
import {
  allowDecisions,
  allowDraftProblem,
  draftsToAllow,
  planAllow,
  shellText,
  timeoutMinutes,
  timeoutSec,
} from "../../src/web/tasks/allow";

console.log(`task-allow.test.ts imported from ${Bun.resolveSync("../../src/web/tasks/allow", import.meta.dir)}`);

const row = (id: string, pattern: string, reason = "") => ({ id, pattern, reason });

describe("commands that Claude may run, in the page", () => {
  test("a row problem holds the list back; a duplicate pattern is a problem; rows trim", () => {
    const a = row("a1", " ssh build1 * ", " The remote build. ");
    expect(draftsToAllow([a])).toEqual([{ pattern: "ssh build1 *", reason: "The remote build." }]);
    expect(allowDraftProblem(row("a2", "git status"), [])).toBe("Claude cannot run git commands.");
    expect(allowDraftProblem(row("a2", "bash -c x"), [])).toBe("A shell or a command runner can run any command. Use Any command instead.");
    expect(allowDraftProblem(row("a2", ""), [])).toBe("Enter a pattern.");
    const b = row("a2", "ssh build1 *");
    expect(allowDraftProblem(b, [a, b])).toBe("This pattern is in the list already. Remove one of the rows.");
    expect(draftsToAllow([a, b])).toBeNull();
    expect(draftsToAllow([a, row("a3", "make test; rm -rf x")])).toBeNull();
  });

  test("the plan picks: a ticked unchanged proposal goes by ID, an edited or added row as an entry, a saved or unticked row not at all", () => {
    const plan = {
      shellWarning: true,
      allow: [
        { id: "a1", pattern: "ssh build1 *", reason: "Saved.", saved: true, warning: null },
        { id: "new-1", pattern: "make bench", reason: "The bench.", saved: false, warning: "This pattern lets Claude run any code." },
        { id: "new-2", pattern: "scp -r repo build1:*", reason: "The copy.", saved: false, warning: null },
        { id: "new-3", pattern: "ninja -C repo/build", reason: "The build.", saved: false, warning: null },
      ],
    };
    const drafts = [
      row("a1", "ssh build1 *", "Saved."),
      row("new-1", "make bench", "The bench."),
      row("new-2", "scp -r repo build1:/srv/x", "The copy."),
      row("new-3", "ninja -C repo/build", "The build."),
      row("new-u1", " cmake --build * ", " Mine. "),
    ];
    const picked = new Set(["a1", "new-1", "new-2", "new-u1"]);
    expect(planAllow(plan, drafts, picked)).toEqual({
      allow: [
        "new-1",
        { id: "new-2", pattern: "scp -r repo build1:/srv/x", reason: "The copy." },
        { id: "new-u1", pattern: "cmake --build *", reason: "Mine." },
      ],
      warning: true,
    });
    // Only saved patterns picked: nothing new, so no warning.
    expect(planAllow(plan, drafts, new Set(["a1"]))).toEqual({ allow: [], warning: false });
    expect(planAllow({ ...plan, shellWarning: false }, drafts, picked).warning).toBe(false);
  });

  test("an allow request: Allow once by default; the first Allow for this repository needs the warning", () => {
    const ask = {
      requests: [
        { pattern: "cmake --build *", command: "cmake --build repo/build", reason: "" },
        { pattern: "ctest *", command: "ctest", reason: "" },
      ],
      warning: true,
    };
    expect(allowDecisions(ask, {})).toEqual({
      decisions: [
        { pattern: "cmake --build *", choice: "once" },
        { pattern: "ctest *", choice: "once" },
      ],
      warning: false,
    });
    expect(allowDecisions(ask, { "ctest *": "refuse" }).warning).toBe(false);
    expect(allowDecisions(ask, { "ctest *": "repo" })).toEqual({
      decisions: [
        { pattern: "cmake --build *", choice: "once" },
        { pattern: "ctest *", choice: "repo" },
      ],
      warning: true,
    });
    expect(allowDecisions({ ...ask, warning: false }, { "ctest *": "repo" }).warning).toBe(false);
  });

  test("the mode words and Longest command in minutes", () => {
    expect(shellText("allowlist", 0)).toBe("Commands: allowlist, 0 patterns");
    expect(shellText("allowlist", 1)).toBe("Commands: allowlist, 1 pattern");
    expect(shellText("allowlist", 5)).toBe("Commands: allowlist, 5 patterns");
    expect(shellText("any", 5)).toBe("Commands: any command");
    expect(timeoutMinutes(600)).toBe("10");
    expect(timeoutMinutes(90)).toBe("1.5");
    expect(timeoutSec("15")).toBe(900);
    expect(timeoutSec("0.5")).toBe(30);
    expect(timeoutSec("60")).toBe(3600);
    expect(timeoutSec("61")).toBeNull();
    expect(timeoutSec("0")).toBeNull();
    expect(timeoutSec("")).toBeNull();
    expect(timeoutSec("ten")).toBeNull();
  });
});
