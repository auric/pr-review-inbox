// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// part-session.md section 9.4 (AC-B253): each reason kind and cause has a primary exit, each exit names a route of routes.ts or a
// new route of section 9.3.6, and old blocked_json rows still parse.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskResumeInput } from "../../src/shared/dto";
import { BLOCKED_CAUSES, BLOCKED_KINDS, REASON_EXITS, type ReasonExit, taskBlocked } from "../../src/shared/task";

console.log(`reasons.test.ts imported from ${Bun.resolveSync("../../src/shared/task", import.meta.dir)}`);

const routesFile = join(import.meta.dir, "../../src/server/tasks/routes.ts");
// Each `.post("/path"` or `.post(\n "/path"` of routes.ts, as "POST /path".
const ROUTES = new Set(
  [...readFileSync(routesFile, "utf8").matchAll(/\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g)].map(
    ([, m, path]) => `${(m as string).toUpperCase()} ${path}`,
  ),
);
// part-session.md section 9.3.6: the new routes, and the package that adds each.
const NEW_ROUTES: Record<string, string> = {
  "POST /tasks/:id/parts/:part/hold": "PS4",
  "POST /tasks/:id/parts/:part/skip": "PS4",
  "POST /tasks/:id/parts/:part/restart": "PS4",
};
// The kinds that have a cause in the table of section 9.4.
const CAUSED = ["question", "red", "denied_path", "error", "budget", "size", "stuck"];

const entries = Object.entries(REASON_EXITS) as [string, { primary: ReasonExit; other: ReasonExit[] }][];

describe("REASON_EXITS (part-session.md section 9.4)", () => {
  test("the routes of routes.ts are read", () => {
    expect(ROUTES.has("POST /tasks/:id/resume")).toBe(true);
    expect(ROUTES.has("POST /tasks/:id/allow")).toBe(true);
    expect(ROUTES.size).toBeGreaterThan(30);
  });

  test("each kind has an entry; each key is a kind, with a known cause for a kind that has causes", () => {
    const kinds = new Set(entries.map(([key]) => key.split("/")[0]));
    expect(BLOCKED_KINDS.filter((k) => !kinds.has(k))).toEqual([]);
    for (const [key] of entries) {
      const [kind, cause] = key.split("/");
      expect({ key, kind: (BLOCKED_KINDS as readonly string[]).includes(kind as string) }).toEqual({ key, kind: true });
      if (CAUSED.includes(kind as string))
        expect({ key, cause: (BLOCKED_CAUSES as readonly string[]).includes(cause as string) }).toEqual({ key, cause: true });
      // usage/armed: the usage reason with armed true, not a cause.
      else expect({ key, cause: cause ?? null }).toEqual({ key, cause: kind === "usage" && cause ? "armed" : null });
    }
    // Every cause belongs to an entry.
    const causes = new Set(entries.map(([key]) => key.split("/")[1]));
    expect(BLOCKED_CAUSES.filter((c) => !causes.has(c))).toEqual([]);
  });

  test("each reason has a primary exit, and each exit names a route or a driver", () => {
    for (const [key, { primary, other }] of entries) {
      expect({ key, primary: typeof primary.label }).toEqual({ key, primary: "string" });
      for (const e of [primary, ...other]) {
        if ("app" in e) {
          expect({ key, app: ["loop", "timer"].includes(e.app) }).toEqual({ key, app: true });
          continue;
        }
        if (ROUTES.has(e.route)) {
          // An exit on a route that exists is planned only for its new option.
          if (e.planned) expect({ key, label: e.label, option: typeof e.option }).toEqual({ key, label: e.label, option: "string" });
        } else {
          // A route that routes.ts does not have must be a new route of section 9.3.6, with the package that adds it.
          expect({ key, route: e.route, known: e.route in NEW_ROUTES }).toEqual({ key, route: e.route, known: true });
          expect({ key, route: e.route, planned: e.planned }).toEqual({ key, route: e.route, planned: NEW_ROUTES[e.route] });
        }
      }
    }
  });

  test("AC-B354: leave is built, and each option of an exit that is not planned parses in taskResumeInput", () => {
    const exits = entries.flatMap(([, x]) => [x.primary, ...x.other]);
    const options = new Set(exits.flatMap((e) => ("option" in e && e.option && !e.planned ? [e.option] : [])));
    expect([...options]).toEqual(["leave"]);
    for (const option of options) expect(taskResumeInput.safeParse({ version: 1, option }).success).toBe(true);
  });

  test("Stop is an exit of every reason but the update reasons and held; a driver takes the primary exit only of slot and armed usage", () => {
    const stops = entries.filter(([, x]) => [x.primary, ...x.other].some((e) => "route" in e && e.route === "POST /tasks/:id/stop"));
    expect(entries.map(([k]) => k).filter((k) => !stops.some(([s]) => s === k))).toEqual(["red/update", "update", "held"]);
    expect(entries.filter(([, x]) => "app" in x.primary).map(([k]) => k)).toEqual(["slot", "usage/armed"]);
  });
});

describe("taskBlocked (part-session.md section 9.4, storage rules 2 and 5)", () => {
  test("an old row with no cause parses, and the legacy kinds stay", () => {
    for (const kind of ["budget", "size", "push", "question"])
      expect(taskBlocked.safeParse({ kind, step: 3, text: "Old." }).success).toBe(true);
  });

  test("the new kinds and fields parse; an unknown cause or kind does not", () => {
    expect(taskBlocked.parse({ kind: "usage", step: 4, text: "Limit.", resumeAt: 1_700_000_000_000, armed: true })).toEqual({
      kind: "usage",
      step: 4,
      text: "Limit.",
      resumeAt: 1_700_000_000_000,
      armed: true,
    });
    for (const kind of ["held", "stuck", "unfinished"]) expect(taskBlocked.safeParse({ kind, step: null, text: "x" }).success).toBe(true);
    expect(taskBlocked.safeParse({ kind: "stuck", step: 1, text: "x", cause: "stall" }).success).toBe(true);
    // An unknown cause drops to the no-cause path, so the reason text stays visible.
    expect(taskBlocked.parse({ kind: "stuck", step: 1, text: "x", cause: "nap" })).toEqual({ kind: "stuck", step: 1, text: "x" });
    expect(taskBlocked.safeParse({ kind: "pause", step: 1, text: "x" }).success).toBe(false);
  });
});
