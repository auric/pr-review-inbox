// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The command line of an editable task command (src/web/tasks/commands.ts). The line is only the text form of an argv list.
import { describe, expect, test } from "bun:test";
import { draftProblem, draftsToCommands, freeId, joinArgv, moveDraft, splitArgv, toDraft } from "../../src/web/tasks/commands";

describe("task command lines", () => {
  test("spaces split; quotes keep spaces and the other quote; backslashes stay", () => {
    expect(splitArgv("  bun   test ")).toEqual({ argv: ["bun", "test"] });
    expect(splitArgv('.venv\\Scripts\\python.exe -m pip install -r "req files\\dev.txt"')).toEqual({
      argv: [".venv\\Scripts\\python.exe", "-m", "pip", "install", "-r", "req files\\dev.txt"],
    });
    expect(splitArgv(`node -e 'console.log("hi")'`)).toEqual({ argv: ["node", "-e", 'console.log("hi")'] });
    expect(splitArgv(`a"b c"d`)).toEqual({ argv: ["ab cd"] });
    expect(splitArgv('bun "test')).toEqual({ error: "Close the double quote." });
    expect(splitArgv("   ")).toEqual({ error: "Type the command." });
    expect(splitArgv('bun ""')).toEqual({ error: "An argument is empty. Remove the empty quotes." });
    expect("error" in splitArgv(Array.from({ length: 33 }, () => "x").join(" "))).toBe(true);
  });

  test("joinArgv is the inverse of splitArgv", () => {
    for (const argv of [["bun", "test"], ["a b", "c"], ['say "x"', "it's"], [`both " and '`], ["C:\\Program Files\\x.exe", "--flag=a b"]])
      expect(splitArgv(joinArgv(argv))).toEqual({ argv });
  });

  test("drafts: a problem holds the list back; free IDs; a draft of a command round-trips", () => {
    const c = { id: "cmd1", name: "test", kind: "test" as const, argv: ["bun", "test"], timeoutSec: 600 };
    expect(draftsToCommands([toDraft(c)])).toEqual([c]);
    expect(draftProblem({ ...toDraft(c), name: " " })).toBe("Give the command a name.");
    expect(draftsToCommands([toDraft(c), { ...toDraft(c), id: "cmd2", line: "'x" }])).toBeNull();
    expect(freeId([{ id: "cmd1" }, { id: "cmd3" }], "cmd")).toBe("cmd2");
  });

  test("moveDraft moves one row; the ends keep the list; the saved list keeps the new order", () => {
    const c = (id: string) => toDraft({ id, name: id, kind: "test", argv: ["bun", id], timeoutSec: 600 });
    const rows = [c("a"), c("b"), c("c")];
    expect(moveDraft(rows, 0, 1).map((d) => d.id)).toEqual(["b", "a", "c"]);
    expect(moveDraft(rows, 2, -1).map((d) => d.id)).toEqual(["a", "c", "b"]);
    expect(moveDraft(rows, 1, -1).map((d) => d.id)).toEqual(["b", "a", "c"]);
    expect(moveDraft(rows, 0, -1)).toBe(rows);
    expect(moveDraft(rows, 2, 1)).toBe(rows);
    expect(moveDraft(rows, 5, 1)).toBe(rows);
    expect(rows.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(draftsToCommands(moveDraft(rows, 0, 1))?.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});
