// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Jira parent and sub-tasks in task.md of a PR run (profile option jiraFamily), and the WP-JC5 sections.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CAPS, createJiraSource } from "../../src/server/context/jira";
import type { IssueParent } from "../../src/server/context/source";
import { MAX_OTHER_PRS, MAX_SUBTASK_LINES, taskContext, taskFileContext, taskParents } from "../../src/server/context/task-file";
import { openDb } from "../../src/server/storage/db";
import type { IssueContext } from "../../src/shared/dto";
import { key } from "../support/fake-bitbucket";
import { type FakeJira, JIRA_TOKEN, SUBTASK_PARENT, startFakeJira } from "../support/fake-jira";

console.log(`Code under test: ${Bun.resolveSync("../../src/server/context/task-file", import.meta.dir)}`);

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

// A row with the fields of WP-JC1 (jira-context.md section 4.2).
const RICH: IssueContext = {
  ...ISSUE,
  type: "Story",
  versions: ["Release 2.4"],
  components: ["Sync Worker", "Cache"],
  labels: ["backend-cache"],
  texts: [
    { id: "customfield_10100", name: "Acceptance\ncriteria", text: "- Flush first.\n- Then lock.\n" },
    { id: "customfield_10200", name: "Test notes", text: "Run with an empty cache." },
  ],
  epic: null,
  related: [
    { key: "ABC-31", text: "blocks", summary: "Remove the old\nflush path", status: "Done", category: "done", type: "Task" },
    { key: "ABC-32", text: "relates to", summary: "Lock wait dashboard", status: null, category: null, type: null },
  ],
};
const RICH_TEXT =
  "## Task ABC-12: Add the event generator\n\n- Source: Jira\n- Status: In Progress\n- Fetched: 1970-01-01T00:00:01.000Z\n- Type: Story\n- Fix versions: Release 2.4\n- Components: Sync Worker, Cache\n- Labels: backend-cache\n\n### Description\n\nGenerate one event per write.\n\n### Acceptance criteria\n\n- Flush first.\n- Then lock.\n\n### Test notes\n\nRun with an empty cache.\n\n### Linked issues\n\n- ABC-12 blocks ABC-31: Remove the old flush path (Done, Task)\n- ABC-12 relates to ABC-32: Lock wait dashboard (no status, no type)\n\n### Comments (1 of 1)\n\n#### Alex Smith, 2026-01-07T10:00:00.000+0000\n\nLooks fine.\n";

const addPr = (db: Database, n: number, state: string | null, updated: number, keys: string[], title = `PR ${n}`) => {
  const { id } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, state, source_branch, target_branch, title, updated_date, web_url)
        VALUES ('PROJ', 'other', $n, $state, $branch, 'main', $title, $updated, 'https://bitbucket.example.invalid/pr') RETURNING id`,
    )
    .get({ n, state, branch: `feature/${n}`, title, updated }) as { id: number };
  for (const [ord, key] of keys.entries())
    db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, $key, 'branch', NULL, $ord)").run({ pr: id, key, ord });
};

describe("task.md sections of the WP-JC1 fields (jira-context.md section 4.5)", () => {
  test("the head lines, the custom text fields, and the linked issues come in the design order, each value on one line", () => {
    const { db, pr } = dbWith(RICH);
    expect(text(db, pr)).toBe(RICH_TEXT);
  });

  test("a row with empty new fields gives the bytes of an old row", () => {
    const { db, pr } = dbWith({ ...ISSUE, type: null, versions: [], components: [], labels: [], texts: [], epic: null, related: [] });
    expect(text(db, pr)).toBe(BEFORE);
  });

  test("the read caps of jira.ts apply again at render", () => {
    const { db, pr } = dbWith({
      ...ISSUE,
      labels: Array.from({ length: CAPS.list + 5 }, (_, n) => `label-${n}`),
      texts: Array.from({ length: CAPS.texts + 2 }, (_, n) => ({
        id: `customfield_${10000 + n}`,
        name: `Field ${n}`,
        text: "x".repeat(CAPS.text + 100),
      })),
      related: Array.from({ length: CAPS.related + 5 }, (_, n) => ({
        key: `ABC-${1000 + n}`,
        text: "relates to",
        summary: `Link ${n}`,
        status: "Open",
        category: "new" as const,
        type: "Task",
      })),
    });
    const out = text(db, pr) ?? "";
    expect(
      out
        .split("\n")
        .find((l) => l.startsWith("- Labels: "))
        ?.split(", "),
    ).toHaveLength(CAPS.list);
    expect(out.split("\n").filter((l) => /^### Field \d+$/.test(l))).toHaveLength(CAPS.texts);
    expect(out.split("\n").filter((l) => /^x+$/.test(l))).toEqual(Array(CAPS.texts).fill("x".repeat(CAPS.text)));
    expect(out.split("\n").filter((l) => l.startsWith("- ABC-12 relates to "))).toHaveLength(CAPS.related);
  });

  test("jiraFamily on: the stored parentIssue gives the Parent section, the epic text gives an Epic section, and no Jira read", async () => {
    const parent = { ...PARENT, truncated: false };
    const epic = { ...PARENT, key: "ABC-5", summary: "Cache epic", truncated: false };
    const { db, pr } = dbWith(
      { ...RICH, parentIssue: parent },
      { ...ISSUE, key: "ABC-13", parent: null, subtasks: [], epic: "ABC-5", parentIssue: epic },
      { ...ISSUE, key: "ABC-14", parent: "ABC-9", subtasks: [], parentIssue: null },
    );
    let made = 0;
    const parents = await taskParents(db, pr, async () => {
      made++;
      return null;
    });
    expect(made).toBe(0);
    expect([...parents.keys()].sort()).toEqual(["ABC-10", "ABC-5"]);
    const out = text(db, pr, parents) ?? "";
    expect(out).toContain(
      `${RICH_TEXT}\n### Parent ABC-10: Split the cache work\n\n- Status: In Progress\n\n#### Parent description\n\nThe parent text. (image: shot.png)\n\n### Sub-tasks (1)`,
    );
    expect(out).toContain("### Epic ABC-5: Cache epic\n\n- Status: In Progress\n\n#### Epic description\n\n");
    expect(out).not.toContain("ABC-9");
  });

  test("other stored PRs that name a task key or its parent or epic key: self out, no URL, open then merged then declined, newest first, capped", () => {
    const { db, pr } = dbWith({ ...ISSUE, epic: "ABC-5" });
    db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, 'ABC-12', 'branch', NULL, 0)").run({ pr });
    expect(text(db, pr)).toBe(BEFORE);
    addPr(db, 7, "MERGED", 50, ["ABC-12"]);
    addPr(db, 8, "DECLINED", 90, ["ABC-10"]);
    addPr(db, 9, "OPEN", 10, ["ABC-5", "ABC-12"], "Two\nlines");
    addPr(db, 10, "MERGED", 60, ["ABC-10"]);
    addPr(db, 11, "OPEN", 20, ["ABC-99"]);
    expect(text(db, pr)).toBe(
      `${BEFORE}\n## Other pull requests that name these tasks\n\n- PROJ/other PR #9 (open) from feature/9 to main: Two lines\n- PROJ/other PR #10 (merged) from feature/10 to main: PR 10\n- PROJ/other PR #7 (merged) from feature/7 to main: PR 7\n- PROJ/other PR #8 (declined) from feature/8 to main: PR 8\n`,
    );
    for (let n = 0; n < MAX_OTHER_PRS; n++) addPr(db, 100 + n, "OPEN", 100 + n, ["ABC-12"]);
    const lines = (text(db, pr) ?? "").split("\n").filter((l) => l.startsWith("- PROJ/other PR #"));
    expect(lines).toHaveLength(MAX_OTHER_PRS);
    expect(lines[0]).toStartWith(`- PROJ/other PR #${100 + MAX_OTHER_PRS - 1} (open)`);
    expect(text(db, pr)).not.toContain("example.invalid");
  });

  test("a Build task gets the new fields; its sub-task sections leave out the linked issues", () => {
    const { db } = dbWith();
    db.exec("PRAGMA foreign_keys = OFF");
    db.query(
      "INSERT INTO task_subtask (task, key, ord, summary, status, issue_json, links_json, read_at) VALUES (1, 'ABC-20', 0, 's', 'To Do', $json, '[]', 1000)",
    ).run({ json: JSON.stringify({ ...RICH, key: "ABC-20" }) });
    const { files } = taskFileContext(db, null, {
      id: 1,
      key: "ABC-12",
      origin_pr: null,
      issue_json: JSON.stringify(RICH),
      created_at: 1000,
      subtasks: 1,
    });
    expect(files.find((f) => f.name === "task.md")?.text).toBe(RICH_TEXT);
    const subs = files.find((f) => f.name === "subtasks.md")?.text ?? "";
    expect(subs).toContain("## Sub-task ABC-20: Add the event generator");
    expect(subs).toContain("- Type: Story");
    expect(subs).toContain("### Acceptance criteria");
    expect(subs).not.toContain("### Linked issues");
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
