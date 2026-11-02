// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Jira parent and sub-tasks in task.md of a PR run (profile option jiraFamily).
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createJiraSource } from "../../src/server/context/jira";
import type { IssueParent } from "../../src/server/context/source";
import { MAX_SUBTASK_LINES, taskContext, taskParents } from "../../src/server/context/task-file";
import { openDb } from "../../src/server/storage/db";
import type { IssueContext } from "../../src/shared/dto";
import { key } from "../support/fake-bitbucket";
import { type FakeJira, JIRA_TOKEN, SUBTASK_PARENT, startFakeJira } from "../support/fake-jira";

const ISSUE: IssueContext = {
  key: "ABC-12",
  summary: "Add the event generator",
  status: "In Progress",
  description: "Generate one event per write.",
  comments: [{ author: "Alex Smith", created: "2026-01-07T10:00:00.000+0000", body: "Looks fine." }],
  commentsTotal: 1,
  truncated: false,
  format: "markdown",
  attachments: [],
  parent: "ABC-10",
  subtasks: [{ key: "ABC-20", summary: "Write the test", status: "To Do", category: "new" }],
  links: [],
};
// task.md of ISSUE before the option existed. The eval baseline depends on it.
const BEFORE =
  "## Task ABC-12: Add the event generator\n\n- Source: Jira\n- Status: In Progress\n- Fetched: 1970-01-01T00:00:01.000Z\n\n### Description\n\nGenerate one event per write.\n\n### Comments (1 of 1)\n\n#### Alex Smith, 2026-01-07T10:00:00.000+0000\n\nLooks fine.\n";
const PARENT: IssueParent = {
  key: "ABC-10",
  summary: "Split the cache work",
  status: "In Progress",
  description: "The parent text. ![shot.png](attachment:10001)",
  truncated: true,
  format: "markdown",
};

function dbWith(...issues: IssueContext[]): { db: Database; pr: number } {
  const db = openDb(":memory:");
  const { id: pr } = db.query("INSERT INTO pull_request (project, repo, pr_id) VALUES ('PROJ', 'repo', 2) RETURNING id").get() as {
    id: number;
  };
  for (const i of issues)
    db.query("INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, 'jira', $json, 1000)").run({
      pr,
      key: i.key,
      json: JSON.stringify(i),
    });
  return { db, pr };
}
const text = (db: Database, pr: number, parents?: ReadonlyMap<string, IssueParent>) => taskContext(db, pr, null, parents).files[0]?.text;

describe("task.md with the Jira parent and sub-tasks", () => {
  test("off: task.md is byte-identical to the text before the option", () => {
    const { db, pr } = dbWith(ISSUE);
    expect(text(db, pr)).toBe(BEFORE);
  });

  test("on: the Parent and Sub-tasks sections follow the issue section, with the same one-line rule and caps", () => {
    const { db, pr } = dbWith({
      ...ISSUE,
      subtasks: [...(ISSUE.subtasks ?? []), { key: "ABC-21", summary: "Two\nlines", status: null, category: null }],
    });
    expect(text(db, pr, new Map([["ABC-10", PARENT]]))).toBe(
      `${BEFORE}\n### Parent ABC-10: Split the cache work\n\n- Status: In Progress\n- The app cut this text at its size limits.\n\n#### Parent description\n\nThe parent text. (image: shot.png)\n\n### Sub-tasks (2)\n\n- ABC-20: Write the test (To Do)\n- ABC-21: Two lines (no status)\n`,
    );
  });

  test("on: an issue without a parent or with an unread parent gets no Parent section", () => {
    const { db, pr } = dbWith({ ...ISSUE, parent: null });
    const none = text(db, pr, new Map([["ABC-10", PARENT]]));
    expect(none).not.toContain("### Parent");
    expect(none).toContain("### Sub-tasks (1)");
    const unread = dbWith(ISSUE);
    expect(text(unread.db, unread.pr, new Map())).toBe(`${BEFORE}\n### Sub-tasks (1)\n\n- ABC-20: Write the test (To Do)\n`);
  });

  test("on: an issue without sub-tasks gets no Sub-tasks section; a row from before the fields existed gets neither section", () => {
    const { db, pr } = dbWith({ ...ISSUE, subtasks: [] });
    expect(text(db, pr, new Map([["ABC-10", PARENT]]))).not.toContain("### Sub-tasks");
    const { parent: _p, subtasks: _s, links: _l, ...old } = ISSUE;
    const before = dbWith(old as IssueContext);
    expect(text(before.db, before.pr, new Map([["ABC-10", PARENT]]))).toBe(BEFORE);
  });

  test("on: the sub-task list stops at its cap and counts the rest", () => {
    const subtasks = Array.from({ length: MAX_SUBTASK_LINES + 3 }, (_, n) => ({
      key: `ABC-${100 + n}`,
      summary: `Part ${n}`,
      status: "To Do",
      category: "new" as const,
    }));
    const { db, pr } = dbWith({ ...ISSUE, parent: null, subtasks });
    const out = text(db, pr, new Map()) ?? "";
    expect(out).toContain(`### Sub-tasks (${MAX_SUBTASK_LINES + 3})`);
    expect(out.split("\n").filter((l) => /^- ABC-\d+: Part /.test(l))).toHaveLength(MAX_SUBTASK_LINES);
    expect(out).toContain("- The app left out 3 more sub-tasks.");
  });
});

describe("taskParents", () => {
  let jira: FakeJira | undefined;
  afterEach(() => jira?.stop());
  const source = () => createJiraSource({ baseUrl: (jira as FakeJira).url, token: JIRA_TOKEN });
  const path = `/rest/api/2/issue/${SUBTASK_PARENT}`;

  test("one GET of the parent and no comment read; the description gets the issue conversion", async () => {
    jira = startFakeJira();
    jira.addSubtaskSet();
    const { db, pr } = dbWith((await source().fetchIssue("ABC-12")) as IssueContext, (await source().fetchIssue("ABC-13")) as IssueContext);
    const [gets, comments] = [jira.count("GET", path), jira.count("GET", `${path}/comment`)];
    const parents = await taskParents(db, pr, async () => source());
    expect([jira.count("GET", path), jira.count("GET", `${path}/comment`)]).toEqual([gets + 1, comments]);
    const p = parents.get(SUBTASK_PARENT);
    expect(p).toMatchObject({
      key: SUBTASK_PARENT,
      summary: "Split the cache work into sub-tasks",
      status: "In Progress",
      format: "markdown",
    });
    expect(p?.description).toContain("The sync worker writes each cache entry on its own.");
    expect(text(db, pr, parents)).toContain(`### Parent ${SUBTASK_PARENT}: Split the cache work into sub-tasks`);
  });

  test("no parent key: no Jira source is made", async () => {
    const { db, pr } = dbWith({ ...ISSUE, parent: null });
    let made = 0;
    const none = async () => {
      made++;
      return null;
    };
    expect((await taskParents(db, pr, none)).size).toBe(0);
    expect(made).toBe(0);
  });

  test("a failed parent GET, no Jira, or a bad CA file leaves the parent out, does not throw, and logs no token", async () => {
    jira = startFakeJira();
    jira.addSubtaskSet();
    const { db, pr } = dbWith({ ...ISSUE, parent: SUBTASK_PARENT });
    jira.routes[key("GET", path)] = { status: 500, body: { errorMessages: [JIRA_TOKEN] } };
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...l: unknown[]) => void lines.push(l.map(String).join(" ")));
    try {
      expect((await taskParents(db, pr, async () => source())).size).toBe(0);
      expect(
        (
          await taskParents(db, pr, async () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          })
        ).size,
      ).toBe(0);
      expect((await taskParents(db, pr, async () => null)).size).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([
      `Jira parent read for a review failed: server 500: ${path}`,
      "Jira parent read for a review: cannot read the Jira CA file.",
    ]);
    expect(text(db, pr, new Map())).not.toContain("### Parent");
  });
});
