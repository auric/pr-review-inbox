// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The command line of an editable task command (src/web/tasks/commands.ts). The line is only the text form of an argv list.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDto } from "../../src/shared/dto";
import type { TaskCommand } from "../../src/shared/task";
import { CommandsEditor } from "../../src/web/tasks/CommandsEditor";
import {
  defaultMinutes,
  draftProblem,
  draftsToCommands,
  freeId,
  joinArgv,
  LIMIT_PROBLEM,
  moveDraft,
  placeholderWarning,
  rowProblem,
  splitArgv,
  toDraft,
} from "../../src/web/tasks/commands";

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

  test("spec.md section 6.3: the time limit in minutes; setup gets 60 by default; 1 s to 4 h; the reason of a proposal stays on the row", () => {
    const c = { id: "cmd1", name: "venv", kind: "setup" as const, argv: ["python", "-m", "venv", ".venv"], timeoutSec: 90 };
    expect(toDraft(c).minutes).toBe("1.5");
    expect(draftsToCommands([{ ...toDraft(c), minutes: "240" }])?.[0]?.timeoutSec).toBe(14_400);
    expect(draftProblem({ ...toDraft(c), minutes: "241" })).toBe(LIMIT_PROBLEM);
    expect(draftProblem({ ...toDraft(c), minutes: "" })).toBe(LIMIT_PROBLEM);
    expect(draftsToCommands([{ ...toDraft(c), minutes: "0" }])).toBeNull();
    expect([defaultMinutes("setup"), defaultMinutes("test"), defaultMinutes("build"), defaultMinutes("lint")]).toEqual([
      "60",
      "10",
      "10",
      "10",
    ]);
    expect(toDraft({ ...c, timeoutReason: "Downloads the packages." }).reason).toBe("Downloads the packages.");
    expect(draftsToCommands([toDraft({ ...c, timeoutReason: "x" })])).toEqual([c]);
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

  test("check-order.md fix 3 and item 5: a name that two running rows share is a problem; a placeholder is a warning only", () => {
    const c = (id: string, name: string) => toDraft({ id, name, kind: "test", argv: ["bun", id], timeoutSec: 600 });
    const unit = c("a", "unit");
    const rows = [unit, c("b", " unit "), c("c", "lint")];
    const lint = rows[2] as typeof unit;
    const twin = "Another command has this name. Give it its own name.";
    expect(rows.map((d) => draftProblem(d, rows))).toEqual([twin, twin, null]);
    // A row that does not run, such as an unticked row of the plan screen, does not clash.
    expect(draftProblem(unit, [unit, lint])).toBeNull();
    expect(draftsToCommands(rows)).toBeNull();
    expect(draftsToCommands([unit, lint])?.map((x) => x.id)).toEqual(["a", "c"]);
    // The plan screen: an unticked twin shows no clash, and the ticked one shows none while it runs alone.
    const picked = new Set(["a", "c"]);
    expect(rows.map((d) => rowProblem(d, rows, picked))).toEqual([null, null, null]);
    expect(rows.map((d) => rowProblem(d, rows))).toEqual([twin, twin, null]);
    expect(placeholderWarning("make -C <dir> test")).toBe("The command holds a placeholder such as <dir>. Replace it with a real value.");
    expect(placeholderWarning("bun test")).toBeNull();
    // Each argument counts alone, so <a and b> in two arguments are no placeholder.
    expect(placeholderWarning("cmd <a b>")).toBeNull();
  });
});

// task-builder-v2.md section 6.1: the plan screen shows the check of argv[0] per row, and the approval refuses a ticked command that
// cannot run here.
describe("the command checks of the plan screen", () => {
  type Local = "runs" | "missing" | "refused";
  const cmd = (id: string, argv: string[], local: Local): TaskCommand & { local: Local } => ({
    id,
    name: id,
    kind: "test",
    argv,
    timeoutSec: 600,
    local,
  });
  const cmds = [cmd("unit", ["bun", "test"], "runs"), cmd("make", ["make", "check"], "missing"), cmd("bat", ["run.cmd"], "refused")];
  const drafts = cmds.map(toDraft);
  const local = new Map(cmds.map((c) => [c.id, { argv0: c.argv[0] as string, local: c.local }]));

  test("each row shows its check; a changed program shows none", () => {
    const html = (ds = drafts) =>
      renderToStaticMarkup(
        createElement(CommandsEditor, {
          idPrefix: "p",
          drafts: ds,
          onChange: () => {},
          picked: new Set(ds.map((d) => d.id)),
          onPick: () => {},
          local,
          newPrefix: "new",
        }),
      );
    const rows = (h: string) =>
      [...h.matchAll(/data-command-local="(\w+)"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)/g)].map((m) => [m[1], m[2]]);
    expect(rows(html())).toEqual([
      ["runs", "Runs here"],
      ["missing", "Not found on this computer"],
      ["refused", "Runs through cmd.exe, which the app refuses"],
    ]);
    expect(rows(html(drafts.map((d) => (d.id === "make" ? { ...d, line: "bun run check" } : d))))).toEqual([
      ["runs", "Runs here"],
      ["refused", "Runs through cmd.exe, which the app refuses"],
    ]);
  });

  test("the approval refuses a ticked missing or refused command, until it is unticked or changed", async () => {
    // PlanTab imports src/web/api.ts, which reads the session meta of the page at load.
    const g = globalThis as { document?: unknown };
    const before = g.document;
    g.document ??= { querySelector: () => null };
    const { planProblem } = await import("../../src/web/tasks/PlanTab").finally(() => {
      g.document = before;
    });
    const t = { plan: { commands: cmds, warning: null } } as unknown as TaskDto;
    const pick = (...ids: string[]) => drafts.filter((d) => ids.includes(d.id));
    expect(planProblem(t, pick("unit", "make"), false)).toBe("make cannot run on this computer. Untick it, or change the command.");
    expect(planProblem(t, pick("unit", "bat"), false)).toBe("bat cannot run on this computer. Untick it, or change the command.");
    expect(planProblem(t, pick("unit"), false)).toBeNull();
    const changed = pick("unit", "make").map((d) => (d.id === "make" ? { ...d, line: "bun run check" } : d));
    expect(planProblem(t, changed, false)).toBeNull();
  });
});
