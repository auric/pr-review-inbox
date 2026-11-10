// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The commands that Claude may run in the page (src/web/tasks/allow.ts, docs/plans/review-v2/spec.md section 6.21): the row checks, the
// plan picks, the choices of an allow request with the first-use warning, the mode words and dialogs, and "Longest command" in minutes.
import { describe, expect, test } from "bun:test";
import {
  allowDecisions,
  allowDraftProblem,
  draftsToAllow,
  MODE_TEXT,
  modeLine,
  parseTestGlobs,
  planAllow,
  planModeText,
  shellText,
  testGlobsText,
  timeoutMinutes,
  timeoutSec,
  UNRESTRICTED_TITLE,
  unrestrictedText,
} from "../../src/web/tasks/allow";

console.log(`task-allow.test.ts imported from ${Bun.resolveSync("../../src/web/tasks/allow", import.meta.dir)}`);

const row = (id: string, pattern: string, reason = "") => ({ id, pattern, reason });

describe("commands that Claude may run, in the page", () => {
  test("a row problem holds the list back; a duplicate pattern is a problem; rows trim", () => {
    const a = row("a1", " ssh build1 * ", " The remote build. ");
    expect(draftsToAllow([a])).toEqual([{ pattern: "ssh build1 *", reason: "The remote build." }]);
    expect(allowDraftProblem(row("a2", "git status"), [])).toBe("Claude cannot run git commands.");
    expect(allowDraftProblem(row("a2", "bash -c x"), [])).toBe(
      "A shell or a command runner can run any command. Use Most commands instead.",
    );
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
    expect(shellText("any", 5)).toBe("Commands: most commands");
    expect(shellText("allowlist", 0, 1)).toBe("Commands: allowlist, 0 patterns, 1 approved check");
    expect(shellText("allowlist", 2, 3)).toBe("Commands: allowlist, 2 patterns, 3 approved checks");
    expect(shellText("any", 2, 3)).toBe("Commands: most commands");
    expect(shellText("unrestricted", 2, 3)).toBe("Commands: unrestricted");
    expect(MODE_TEXT).toEqual({ allowlist: "Allowlist", any: "Most commands", unrestricted: "Unrestricted" });
    // spec.md section 6.21.2: the line under the mode switch names what Any command still blocks. Section 6.8: git through bash -c is
    // checked after the step (AC-B178).
    const n = { runner: "Runner", cli: "runner", forge: "Forge", tracker: "Tracker" };
    expect(modeLine("any", n)).toBe(
      "Runner runs every command, except these: git, the Forge and Tracker hosts, curl, wget, nc, ncat, netcat, socat, telnet, ftp, tftp, sftp, scp, rsync, ssh, powershell, pwsh, and the password and key store tools. A command such as bash -c can still run git. After each step, the app checks the git state and restores it. Runner also cannot read the app data or your ssh keys. A pattern for ssh in this list lets every ssh command run. The list applies again when you switch back.",
    );
    expect(modeLine("allowlist", n)).toBe(
      "Runner runs only the commands that match a pattern of this list. grep, rg, and read-only commands such as ls and cat also run. Runner cannot run cd or read files outside the folder of the step.",
    );
    expect(modeLine("unrestricted", n)).toBe(
      "Runner runs every command, except these: git and commands that name the Forge or Tracker host. A command such as bash -c can still run git. After each step, the app checks the git state and restores it. Runner can read and write any file that you can, also your keys and the app data. The list applies again when you switch back.",
    );
    expect(UNRESTRICTED_TITLE).toBe("Turn on Unrestricted?");
    expect(unrestrictedText(n)).toBe(
      "Unrestricted lets Runner run every command as you, with your files, your keys, and your network, except git and the Forge and Tracker hosts. A command such as bash -c can still run git. After each step, the app checks the git state and restores it. Runner can read and write any file that you can. Text in a task, an attachment, or a comment can tell Runner to run a harmful command. Use it only for repositories and tasks that you trust.",
    );
    expect(planModeText("any", n)).toBe(
      'The mode "Most commands" is on for this repository. Runner can run every command, except the fixed deny list.',
    );
    expect(planModeText("unrestricted", n)).toBe(
      `The mode "Unrestricted" is on for this repository. Runner can run every command, except git and the Forge and Tracker hosts. A command such as bash -c can still run git. After each step, the app checks the git state and restores it.`,
    );
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

  test('AC-B161: "Test files" takes one glob per line; an empty field stores null, which takes the defaults', () => {
    expect(testGlobsText(null)).toBe("");
    expect(testGlobsText(["tests/", "*_test.*"])).toBe("tests/\n*_test.*");
    expect(parseTestGlobs(" tests/ \r\n\n*_test.*\n")).toEqual({ globs: ["tests/", "*_test.*"] });
    expect(parseTestGlobs(" \n ")).toEqual({ globs: null });
    expect(parseTestGlobs(Array.from({ length: 51 }, (_, k) => `t${k}/`).join("\n"))).toEqual({ problem: "Enter 50 globs at most." });
    expect(parseTestGlobs("x".repeat(201))).toEqual({ problem: "Each glob has 200 characters at most." });
  });
});
