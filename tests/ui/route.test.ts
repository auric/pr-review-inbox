// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { formatRoute, type ListRoute, listRoute, navMode, parseRoute, type Route, type SettingsSection } from "../../src/web/lib/route";

// The browser gives the path percent-encoded and the query with its "?".
const parse = (url: string) => {
  const u = new URL(url, "http://127.0.0.1:7317");
  return parseRoute(u.pathname, u.search);
};
const pr = (over: Partial<ListRoute> = {}): ListRoute => ({
  ...listRoute("needs"),
  pr: { project: "PROJ1", repo: "sample-repo-2", id: 1001 },
  ...over,
});

describe("route round trip", () => {
  const cases: [string, Route][] = [
    ["/needs", listRoute()],
    ["/archive", listRoute("archive")],
    ["/needs/PROJ1/sample-repo-2/1001", pr()],
    [
      "/mine/~JDOE/sample-repo-1/7?thread=1000003",
      pr({ view: "mine", pr: { project: "~JDOE", repo: "sample-repo-1", id: 7 }, thread: 1000003 }),
    ],
    [
      "/reviewing/PROJ1/sample-repo-2/1001?file=src/cache/flush.ts&line=12&side=old&full=1",
      pr({ view: "reviewing", file: { path: "src/cache/flush.ts", line: 12, side: "old" }, full: true }),
    ],
    [
      "/needs/PROJ1/sample-repo-2/1001?file=docs/a%20b%23c%3Fd%26e%2Bf%25.md",
      pr({ file: { path: "docs/a b#c?d&e+f%.md", line: null, side: "new" } }),
    ],
    ["/following?repo=~JDOE/sample-repo-1&q=cache%20lock", { ...listRoute("following"), repo: "~JDOE/sample-repo-1", q: "cache lock" }],
    ["/needs/PROJ1/sample-repo-2/1001/explain", pr({ explain: true })],
    ["/mine/PROJ1/sample-repo-2/1001/explain?full=1&q=lock", pr({ view: "mine", explain: true, full: true, q: "lock" })],
    // docs/plans/review-v2/spec.md section 6.12: the Tasks view and the Task view route /tasks/:id.
    ["/tasks", listRoute("tasks")],
    ["/tasks/12", { ...listRoute("tasks"), task: 12 }],
    ["/settings", { kind: "settings", section: null, profile: null }],
    ["/settings/task-ids", { kind: "settings", section: "task-ids", profile: null }],
    ["/settings/profiles/over%20engineering", { kind: "settings", section: "profiles", profile: "over engineering" }],
  ];
  for (const [url, route] of cases) {
    test(url, () => {
      expect(formatRoute(route)).toBe(url);
      expect(parse(url)).toEqual(route);
    });
  }

  test("special characters in the project, the repository, and the filter survive", () => {
    const r = pr({
      pr: { project: "~J.DOE", repo: "a/b c%ä", id: 5 },
      q: "x&y=z #1 + ü",
      repo: "~J.DOE/a/b c%ä",
      file: { path: "dir/ü ber/x.ts", line: 3, side: "new" },
    });
    const url = formatRoute(r);
    expect(url.startsWith("/needs/~J.DOE/a%2Fb%20c%25%C3%A4/5?")).toBe(true);
    expect(parse(url)).toEqual(r);
  });

  test("a new-side line has no side in the URL", () => {
    expect(formatRoute(pr({ file: { path: "a.ts", line: 3, side: "new" } }))).toBe("/needs/PROJ1/sample-repo-2/1001?file=a.ts&line=3");
  });

  test("the Explain page URL has no thread and no file; it needs a PR", () => {
    const r = pr({ explain: true, thread: 5, file: { path: "a.ts", line: 3, side: "new" } });
    expect(formatRoute(r)).toBe("/needs/PROJ1/sample-repo-2/1001/explain");
    expect(parse("/needs/PROJ1/sample-repo-2/1001/explain?thread=5&file=a.ts&line=3")).toEqual(pr({ explain: true }));
    expect(parse("/needs/PROJ1/sample-repo-2/explain")).toEqual(listRoute());
    expect(parse("/needs/PROJ1/sample-repo-2/1001/other")).toEqual(listRoute());
    expect(parse("/needs/PROJ1/sample-repo-2/1001/explain/x")).toEqual(listRoute());
    expect(formatRoute({ ...listRoute(), explain: true })).toBe("/needs");
  });
});

describe("unknown and stale routes", () => {
  test("/ is Needs you", () => expect(parse("/")).toEqual(listRoute()));

  test("an unknown view gives Needs you and drops the rest", () => {
    expect(parse("/inbox/PROJ1/sample-repo-2/1001?thread=3")).toEqual(listRoute());
    expect(parse("/assets/missing.js")).toEqual(listRoute());
  });

  test("a PR path that is not complete gives the view only", () => {
    expect(parse("/needs/PROJ1/sample-repo-2")).toEqual(listRoute());
    expect(parse("/needs/PROJ1/sample-repo-2/abc")).toEqual(listRoute());
    expect(parse("/needs/PROJ1/sample-repo-2/0")).toEqual(listRoute());
    expect(parse("/needs/PROJ1/sample-repo-2/1001/extra")).toEqual(listRoute());
  });

  test("thread, file, and full need a PR. Bad numbers are dropped.", () => {
    expect(parse("/needs?thread=3&file=a.ts&full=1")).toEqual(listRoute());
    expect(parse("/needs/P/r/1?thread=-3&line=x&file=a.ts&side=old")).toEqual(
      pr({ pr: { project: "P", repo: "r", id: 1 }, file: { path: "a.ts", line: null, side: "new" } }),
    );
  });

  test("a malformed escape gives Needs you", () => expect(parse("/needs/%E0%A4%A/r/1")).toEqual(listRoute()));

  test("an unknown settings section gives the top of Settings. A profile needs the profiles section.", () => {
    expect(parse("/settings/nothing")).toEqual({ kind: "settings", section: null, profile: null });
    expect(parse("/settings/checks/general")).toEqual({ kind: "settings", section: "checks", profile: null });
  });

  test("a percent-encoded tilde reads as the tilde, so the format gives the plain form", () => {
    const r = parse("/needs/%7EJDOE/sample-repo-1/7");
    expect(formatRoute(r)).toBe("/needs/~JDOE/sample-repo-1/7");
  });

  test("a task path takes one positive number. The Tasks view drops the PR, the filter, and the repository.", () => {
    expect(parse("/tasks/0")).toEqual(listRoute("tasks"));
    expect(parse("/tasks/abc")).toEqual(listRoute("tasks"));
    expect(parse("/tasks/12/extra")).toEqual(listRoute("tasks"));
    expect(parse("/tasks/12?q=lock&repo=PROJ1/r")).toEqual({ ...listRoute("tasks"), task: 12 });
  });
});

describe("push or replace (plan pr-view-v4 section 5)", () => {
  const settings = (section: SettingsSection | null): Route => ({ kind: "settings", section, profile: null });
  const a = pr();
  const b = pr({ pr: { project: "PROJ1", repo: "sample-repo-3", id: 77 } });

  test("a PR open by click or Enter pushes. j, k, and the default selection replace.", () => {
    expect(navMode(a, b, true)).toBe("push");
    expect(navMode(a, b, false)).toBe("replace");
    expect(navMode(listRoute(), a, false)).toBe("replace");
    expect(navMode(a, listRoute(), false)).toBe("replace");
  });

  test("a view change pushes, also with a new selection", () => {
    expect(navMode(a, { ...b, view: "reviewing" }, false)).toBe("push");
    expect(navMode(listRoute(), { ...listRoute(), repo: "PROJ1/sample-repo-2" }, false)).toBe("push");
  });

  test("A task that opens from a PR pushes. A task open by click pushes. j, k, and the default task replace.", () => {
    const t = (task: number | null) => ({ ...listRoute("tasks"), task });
    expect(navMode(a, t(12), true)).toBe("push");
    expect(navMode(t(12), t(13), true)).toBe("push");
    expect(navMode(t(12), t(13), false)).toBe("replace");
    expect(navMode(t(null), t(12), false)).toBe("replace");
  });

  test("the repository chip that clears the filter, the filter text, and thread focus replace", () => {
    expect(navMode({ ...a, repo: "PROJ1/sample-repo-2" }, a, false)).toBe("replace");
    expect(navMode(a, { ...a, q: "lock" }, false)).toBe("replace");
    expect(navMode(a, { ...a, thread: 5 }, false)).toBe("replace");
  });

  test("a file open and full width push. A file close replaces.", () => {
    const file = { ...a, file: { path: "a.ts", line: null, side: "new" as const } };
    expect(navMode(a, file, false)).toBe("push");
    expect(navMode(file, { ...file, file: { path: "b.ts", line: null, side: "new" } }, false)).toBe("push");
    expect(navMode(file, a, false)).toBe("replace");
    expect(navMode(a, { ...a, full: true }, false)).toBe("push");
    expect(navMode({ ...a, full: true }, a, false)).toBe("push");
  });

  test("the Explain page open pushes. Back without an earlier entry replaces; a link to the PR (opened) pushes.", () => {
    const explain = { ...a, explain: true };
    expect(navMode(a, explain, false)).toBe("push");
    expect(navMode(explain, a, false)).toBe("replace");
    expect(navMode(explain, { ...a, file: { path: "a.ts", line: 3, side: "new" } }, true)).toBe("push");
    expect(navMode(explain, { ...explain, q: "lock" }, false)).toBe("replace");
    expect(navMode(explain, b, true)).toBe("push");
  });

  test("Settings open and each section push. Close replaces.", () => {
    expect(navMode(a, settings(null), false)).toBe("push");
    expect(navMode(settings(null), settings("checks"), false)).toBe("push");
    expect(navMode(settings("checks"), { kind: "settings", section: "profiles", profile: "general" }, false)).toBe("push");
    expect(navMode(settings("checks"), settings("checks"), false)).toBe("replace");
    expect(navMode(settings("checks"), a, false)).toBe("replace");
  });
});
