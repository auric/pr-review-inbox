// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 S-JIRA and r3 S-JMD: the Jira REST client against the fake Jira. No test calls a real server.
import { afterEach, describe, expect, test } from "bun:test";
import {
  CAPS,
  CONVERT_FIELD_MS,
  createJiraSource,
  JiraRefusedError,
  MAX_ATTACHMENTS,
  MAX_BODY_BYTES,
  MAX_HTML_BYTES,
} from "../../src/server/context/jira";
import { ContextError } from "../../src/server/context/source";
import type { IssueSubtask } from "../../src/shared/dto";
import { key, type Reply, startFakeBitbucket } from "../support/fake-bitbucket";
import { type FakeJira, ISSUE_KEY, JIRA_EMAIL, JIRA_TOKEN, jiraFixture, SUBTASK_PARENT, startFakeJira } from "../support/fake-jira";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

function setup(token = JIRA_TOKEN): { fake: FakeJira; source: ReturnType<typeof createJiraSource> } {
  const fake = startFakeJira();
  stops.push(fake.stop);
  return { fake, source: createJiraSource({ baseUrl: fake.url, token }) };
}

async function failure(p: Promise<unknown>): Promise<ContextError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ContextError) return e;
    throw e;
  }
  throw new Error("no error");
}

const ISSUE = `/rest/api/2/issue/${ISSUE_KEY}`;
const ISSUE_QUERY = "?fields=summary,description,status,attachment,parent,subtasks,issuelinks&expand=renderedFields";
const COMMENTS = (start: number) => `${ISSUE}/comment?startAt=${start}&maxResults=100&expand=renderedBody`;

// One comment page with these comments.
const page = (comments: unknown[]) => ({ status: 200, body: { startAt: 0, maxResults: 100, total: comments.length, comments } });

describe("Jira client", () => {
  test("check sends the PAT as Bearer and returns the display name", async () => {
    const { fake, source } = setup();
    let auth: string | null = null;
    fake.routes[key("GET", "/rest/api/2/myself")] = (req) => {
      auth = req.headers.get("authorization");
      return { status: 200, body: { name: "jdoe", displayName: "Jordan Doe" } };
    };
    expect(await source.check()).toBe("Jordan Doe");
    expect(auth as string | null).toBe(`Bearer ${JIRA_TOKEN}`);
    expect(fake.requests).toEqual(["GET /rest/api/2/serverInfo", "GET /rest/api/2/myself"]);
  });

  test("myself falls back to name, then accountId; a body without all three gives kind shape", async () => {
    const { fake, source } = setup();
    const me = key("GET", "/rest/api/2/myself");
    fake.routes[me] = { status: 200, body: { name: "jdoe" } };
    expect(await source.check()).toBe("jdoe");
    fake.routes[me] = { status: 200, body: { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: null } };
    expect(await source.check()).toBe("5b10ac8d82e05b22cc7d4ef5");
    fake.routes[me] = { status: 200, body: { displayName: "", emailAddress: "jdoe@example.com" } };
    expect((await failure(source.check())).kind).toBe("shape");
  });

  test("a wrong token gives kind auth; the error holds no token and no body", async () => {
    const { fake, source } = setup("wrong-token-AAAA");
    const e = await failure(source.check());
    expect(e.kind).toBe("auth");
    expect(e.status).toBe(401);
    expect(e.message).toBe("auth 401: /rest/api/2/myself");
    expect(e.message).not.toContain("wrong-token-AAAA");
    expect(fake.requests).toEqual(["GET /rest/api/2/serverInfo", "GET /rest/api/2/myself"]);
  });

  test("Cloud: an email sends Basic base64(email:token) in check, fetchIssue, and download", async () => {
    const fake = startFakeJira({ cloud: true });
    stops.push(fake.stop);
    const seen = new Set<string | null>();
    const authorized = fake.authorized;
    fake.authorized = (req) => {
      seen.add(req.headers.get("authorization"));
      return authorized?.(req) ?? false;
    };
    const source = createJiraSource({ baseUrl: fake.url, token: JIRA_TOKEN, email: JIRA_EMAIL });
    expect(await source.check()).toBe("Jordan Doe");
    await source.fetchIssue(ISSUE_KEY);
    await source.download({ id: "10100", filename: "screenshot.png", size: 2048 }, async () => {});
    expect([...seen]).toEqual([`Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`]);
  });

  test("Cloud: a wrong token gives kind auth, and no error text holds the token, the email, or the header", async () => {
    const fake = startFakeJira({ cloud: true });
    stops.push(fake.stop);
    const token = "wrong-cloud-token-BBBB";
    const source = createJiraSource({ baseUrl: fake.url, token, email: JIRA_EMAIL });
    const header = Buffer.from(`${JIRA_EMAIL}:${token}`).toString("base64");
    const errors = [
      await failure(source.check()),
      await failure(source.fetchIssue(ISSUE_KEY)),
      await failure(source.download({ id: "10100", filename: "screenshot.png", size: 2048 }, async () => {})),
    ];
    for (const e of errors) {
      expect(e.kind).toBe("auth");
      for (const text of [e.message, String(e.stack), JSON.stringify(e)]) {
        for (const secret of [token, JIRA_EMAIL, header]) expect(text).not.toContain(secret);
      }
    }
  });

  test("check: Cloud serverInfo without an email, or an email on Server, fails before myself", async () => {
    const cloud = startFakeJira({ cloud: true });
    stops.push(cloud.stop);
    await expect(createJiraSource({ baseUrl: cloud.url, token: JIRA_TOKEN }).check()).rejects.toThrow(
      "This is Jira Cloud. Enter your Atlassian account email and an API token.",
    );
    expect(cloud.requests).toEqual(["GET /rest/api/2/serverInfo"]);
    const { fake } = setup();
    await expect(createJiraSource({ baseUrl: fake.url, token: JIRA_TOKEN, email: JIRA_EMAIL }).check()).rejects.toThrow(
      "This Jira is Server or Data Center. Use a personal access token and no email.",
    );
    expect(fake.requests).toEqual(["GET /rest/api/2/serverInfo"]);
  });

  test("check: a failed serverInfo or one without deploymentType does not block", async () => {
    const { fake, source } = setup();
    const info = key("GET", "/rest/api/2/serverInfo");
    fake.routes[info] = { status: 500 };
    expect(await source.check()).toBe("Jordan Doe");
    fake.routes[info] = { status: 200, body: { version: "9.12.0" } };
    expect(await source.check()).toBe("Jordan Doe");
    fake.routes[info] = { status: 200, body: "not json" };
    expect(await createJiraSource({ baseUrl: fake.url, token: JIRA_TOKEN }).check()).toBe("Jordan Doe");
  });

  test("fetchIssue reads the issue and two comment pages with rendered HTML, and converts it to Markdown", async () => {
    const { fake, source } = setup();
    const issue = await source.fetchIssue(ISSUE_KEY);
    expect(issue).toEqual({
      key: ISSUE_KEY,
      summary: "Flush the cache before the write lock",
      status: "In Progress",
      description: expect.stringContaining("### Acceptance criteria\n\n-   Batch the writes."),
      comments: [
        {
          author: "Alex Smith",
          created: "2026-01-05T09:12:31.000+0000",
          body: "The flush must run before the lock. Otherwise readers see a stale entry.",
        },
        { author: "Maria Lopez", created: "2026-01-06T14:03:10.000+0000", body: "Keep the batch size below 500 entries." },
        {
          author: "Kenji Ito",
          created: "2026-01-07T08:45:00.000+0000",
          body: "QA: test with an empty cache too.\n\nClick \\[here\\](javascript:alert(2)) now.",
        },
      ],
      commentsTotal: 3,
      truncated: false,
      format: "markdown",
      attachments: [
        { id: "10100", filename: "screenshot.png", mimeType: "image/png", size: 2048, created: "2026-01-05T09:10:00.000+0000" },
        { id: "10101", filename: "sync-worker.log", mimeType: "text/plain", size: 512, created: "2026-01-06T14:00:00.000+0000" },
      ],
      parent: null,
      subtasks: [],
      links: [],
    });
    // Links to Jira resolve against the configured base. The attachment image becomes a token, never a remote image.
    expect(issue.description).toContain("| Flush \\| now | Alex Smith |");
    expect(issue.description).toContain(`[![image 10100](attachment:10100)](${fake.url}/secure/attachment/10100/screenshot.png)`);
    expect(issue.description).not.toContain("javascript:");
    expect(fake.requests).toEqual([`GET ${ISSUE}${ISSUE_QUERY}`, `GET ${COMMENTS(0)}`, `GET ${COMMENTS(2)}`]);
  });

  test("a missing rendered field, HTML over 1 MB, or HTML that overflows the converter gives the wiki text in a fence", async () => {
    const { fake, source } = setup();
    const wiki = "h3. Title\r\n{code}a ``` b{code}";
    const fence = "````\nh3. Title\n{code}a ``` b{code}\n````";
    const issue = (rendered: string | null | undefined) => ({
      status: 200,
      body: {
        fields: { summary: "S", description: wiki },
        ...(rendered === undefined ? {} : { renderedFields: { description: rendered } }),
      },
    });
    fake.routes[key("GET", `${ISSUE}/comment`)] = page([
      { body: "*b*" },
      { body: "c", renderedBody: null },
      { body: "d", renderedBody: `<p>${"x".repeat(MAX_HTML_BYTES - 6)}</p>` },
      { body: "e", renderedBody: "<p><b>e</b></p>" },
      { body: null, renderedBody: null },
    ]);
    for (const rendered of [undefined, null, `<p>${"x".repeat(MAX_HTML_BYTES - 6)}</p>`, "<b>".repeat(300_000)]) {
      fake.routes[key("GET", ISSUE)] = issue(rendered);
      const got = await source.fetchIssue(ISSUE_KEY);
      expect(got.description).toBe(fence);
      expect(got.comments.map((c) => c.body)).toEqual(["```\n*b*\n```", "```\nc\n```", "```\nd\n```", "**e**", ""]);
      expect(got.format).toBe("markdown");
    }
    // Exactly 1 MB still converts.
    fake.routes[key("GET", ISSUE)] = issue(`<p>${"y".repeat(MAX_HTML_BYTES - 7)}</p>`);
    expect((await source.fetchIssue(ISSUE_KEY)).description).toBe("y".repeat(CAPS.description));
  });

  test("the caps apply to the Markdown, not to the HTML", async () => {
    const { fake, source } = setup();
    const html = `${"<span></span>".repeat(3000)}<p>short</p>`;
    expect(html.length).toBeGreaterThan(CAPS.description);
    fake.routes[key("GET", ISSUE)] = {
      status: 200,
      body: { fields: { summary: "S", description: "w" }, renderedFields: { description: html } },
    };
    fake.routes[key("GET", `${ISSUE}/comment`)] = page([{ body: "w", renderedBody: `<p>${"c".repeat(CAPS.comment + 5)}</p>${html}` }]);
    const issue = await source.fetchIssue(ISSUE_KEY);
    expect(issue.description).toBe("short");
    expect(issue.comments[0]?.body).toBe("c".repeat(CAPS.comment));
    expect(issue.truncated).toBe(true);
  });

  // Without the budget, this field keeps the converter busy for minutes.
  const NESTED = "<div>".repeat(200_000);

  test("deep nesting passes the field budget: the field gives the wiki text, and the next field converts in a new worker", async () => {
    expect(Buffer.byteLength(NESTED)).toBeLessThanOrEqual(MAX_HTML_BYTES);
    const { fake, source } = setup();
    fake.routes[key("GET", ISSUE)] = {
      status: 200,
      body: { fields: { summary: "S", description: "w" }, renderedFields: { description: NESTED } },
    };
    fake.routes[key("GET", `${ISSUE}/comment`)] = page([{ body: "c", renderedBody: "<p><b>c</b></p>" }]);
    // The main thread stays free: the longest gap between two timer ticks.
    let last = performance.now();
    let gap = 0;
    const tick = setInterval(() => {
      gap = Math.max(gap, performance.now() - last);
      last = performance.now();
    }, 20);
    const t0 = performance.now();
    const issue = await source.fetchIssue(ISSUE_KEY).finally(() => clearInterval(tick));
    const ms = performance.now() - t0;
    expect(issue.description).toBe("```\nw\n```");
    expect(issue.comments.map((c) => c.body)).toEqual(["**c**"]);
    expect(ms).toBeGreaterThanOrEqual(CONVERT_FIELD_MS);
    expect(ms).toBeLessThan(CONVERT_FIELD_MS + 3_000);
    expect(gap).toBeLessThan(1_000);
  }, 20_000);

  test("after the total budget, every later field gives the wiki text", async () => {
    const fake = startFakeJira();
    stops.push(fake.stop);
    const source = createJiraSource({ baseUrl: fake.url, token: JIRA_TOKEN, convertMs: { field: 300, total: 300 } });
    fake.routes[key("GET", ISSUE)] = {
      status: 200,
      body: { fields: { summary: "S", description: "w" }, renderedFields: { description: NESTED } },
    };
    fake.routes[key("GET", `${ISSUE}/comment`)] = page([{ body: "c", renderedBody: "<p><b>c</b></p>" }]);
    const t0 = performance.now();
    const issue = await source.fetchIssue(ISSUE_KEY);
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(issue.description).toBe("```\nw\n```");
    expect(issue.comments.map((c) => c.body)).toEqual(["```\nc\n```"]);
  }, 20_000);

  test("attachments: lenient entries, numeric IDs as digits, bad entries left out, at most 200", async () => {
    const { fake, source } = setup();
    const ok = { id: "1", filename: "a.png", mimeType: "image/png", size: 1, created: "C" };
    const attachment = [
      ok,
      { id: 2, filename: "b.log", size: 0 },
      { id: "x1", filename: "bad-id", size: 1 },
      { id: "3", filename: "neg", size: -1 },
      { id: "4", size: 1 },
      { id: 1.5, filename: "frac", size: 1 },
      "junk",
    ];
    fake.routes[key("GET", ISSUE)] = { status: 200, body: { fields: { summary: "S", attachment } } };
    expect((await source.fetchIssue(ISSUE_KEY)).attachments).toEqual([
      ok,
      { id: "2", filename: "b.log", mimeType: null, size: 0, created: null },
    ]);
    const many = Array.from({ length: MAX_ATTACHMENTS + 5 }, (_, i) => ({ ...ok, id: String(i + 1) }));
    fake.routes[key("GET", ISSUE)] = { status: 200, body: { fields: { summary: "S", attachment: many } } };
    const listed = (await source.fetchIssue(ISSUE_KEY)).attachments ?? [];
    expect(listed.length).toBe(MAX_ATTACHMENTS);
    expect(listed.at(-1)?.id).toBe(String(MAX_ATTACHMENTS));
    fake.routes[key("GET", ISSUE)] = { status: 200, body: { fields: { summary: "S", attachment: { id: "1" } } } };
    expect((await failure(source.fetchIssue(ISSUE_KEY))).kind).toBe("shape");
  });

  test("an answer body over 10 MB is an error of kind shape", async () => {
    const { fake, source } = setup();
    const fields = (n: number) => ({ status: 200, body: { fields: { summary: "x".repeat(n) } } });
    // JSON adds 25 bytes around the summary.
    fake.routes[key("GET", ISSUE)] = fields(MAX_BODY_BYTES - 25);
    expect((await source.fetchIssue(ISSUE_KEY)).summary.length).toBe(MAX_BODY_BYTES - 25);
    fake.routes[key("GET", ISSUE)] = fields(MAX_BODY_BYTES - 24);
    const e = await failure(source.fetchIssue(ISSUE_KEY));
    expect(e.kind).toBe("shape");
    expect(e.status).toBe(200);
  });

  test("a 302 is an error of kind redirect, and the client does not follow it", async () => {
    const other = startFakeBitbucket();
    stops.push(other.stop);
    const { fake, source } = setup();
    fake.routes[key("GET", "/rest/api/2/myself")] = { status: 302, headers: { Location: `${other.url}/login.jsp` } };
    const e = await failure(source.check());
    expect(e.kind).toBe("redirect");
    expect(e.status).toBe(302);
    expect(other.requests).toEqual([]);
  });

  test("404, a 500, and wrong shapes map to their kinds; no message holds the body", async () => {
    const { fake, source } = setup();
    expect((await failure(source.fetchIssue("ABC-404"))).kind).toBe("not_found");
    fake.routes[key("GET", ISSUE)] = { status: 200, body: "<html>SECRET-BODY</html>" };
    const e = await failure(source.fetchIssue(ISSUE_KEY));
    expect(e.kind).toBe("shape");
    expect(e.message).not.toContain("SECRET-BODY");
    fake.routes[key("GET", ISSUE)] = { status: 200, body: { fields: { summary: 5 } } };
    expect((await failure(source.fetchIssue(ISSUE_KEY))).kind).toBe("shape");
    fake.routes[key("GET", ISSUE)] = { status: 500, body: { errorMessages: ["SECRET-BODY"] } };
    const s = await failure(source.fetchIssue(ISSUE_KEY));
    expect(s.kind).toBe("server");
    expect(s.message).not.toContain("SECRET-BODY");
  });

  test("lenient shape: null description, no status, no author, extra keys", async () => {
    const { fake, source } = setup();
    fake.routes[key("GET", ISSUE)] = { status: 200, body: { key: ISSUE_KEY, extra: 1, fields: { summary: "S", description: null } } };
    fake.routes[key("GET", `${ISSUE}/comment`)] = {
      status: 200,
      body: { startAt: 0, maxResults: 100, total: 1, comments: [{ body: "B", created: "C" }] },
    };
    const issue = await source.fetchIssue(ISSUE_KEY);
    expect(issue).toMatchObject({
      description: null,
      status: null,
      comments: [{ author: "(unknown)", body: "```\nB\n```" }],
      truncated: false,
    });
  });

  test("caps cut the description and long comments, and set truncated", async () => {
    const { fake, source } = setup();
    fake.routes[key("GET", ISSUE)] = { status: 200, body: { fields: { summary: "S", description: "d".repeat(CAPS.description + 5) } } };
    fake.routes[key("GET", `${ISSUE}/comment`)] = {
      status: 200,
      body: { startAt: 0, maxResults: 100, total: 1, comments: [{ body: "c".repeat(CAPS.comment + 5), created: "C" }] },
    };
    const issue = await source.fetchIssue(ISSUE_KEY);
    expect(issue.description?.length).toBe(CAPS.description);
    expect(issue.comments[0]?.body.length).toBe(CAPS.comment);
    expect(issue.truncated).toBe(true);
  });

  test("the 200 KB total cap drops later comments; the 5-page cap stops paging", async () => {
    const { fake, source } = setup();
    const total = 1000;
    fake.routes[key("GET", `${ISSUE}/comment`)] = (req) => {
      const at = Number(new URL(req.url).searchParams.get("startAt"));
      const comments = Array.from({ length: 100 }, (_, i) => ({
        author: { name: "u" },
        created: "C",
        body: `${at + i} ${"x".repeat(3000)}`,
      }));
      return { status: 200, body: { startAt: at, maxResults: 100, total, comments } };
    };
    const issue = await source.fetchIssue(ISSUE_KEY);
    expect(fake.requests.filter((r) => r.includes("/comment")).length).toBe(5);
    expect(issue.commentsTotal).toBe(total);
    expect(issue.truncated).toBe(true);
    const bytes = issue.comments.reduce((n, c) => n + Buffer.byteLength(c.body) + 2, 0);
    expect(bytes).toBeLessThanOrEqual(CAPS.totalBytes);
    expect(issue.comments.length).toBeGreaterThan(50);
    expect(issue.comments.length).toBeLessThan(100);
  });

  test("plain http to a non-loopback host is refused; https and loopback http are accepted", () => {
    expect(() => createJiraSource({ baseUrl: "http://jira.example.test", token: "t" })).toThrow("must use https");
    expect(() => createJiraSource({ baseUrl: "https://jira.example.test/jira", token: "t" })).not.toThrow();
    expect(() => createJiraSource({ baseUrl: "http://127.0.0.1:1", token: "t" })).not.toThrow();
  });

  test("a key outside the Jira key pattern sends no request", async () => {
    const { fake, source } = setup();
    for (const bad of ["../myself", "abc-1", "ABC-1?x=1", "ABC-0"]) expect((await failure(source.fetchIssue(bad))).kind).toBe("not_found");
    expect(fake.requests).toEqual([]);
  });

  test("a context path stays in every request", async () => {
    const { fake } = setup();
    fake.routes[key("GET", "/jira/rest/api/2/myself")] = { status: 200, body: { name: "ctx" } };
    expect(await createJiraSource({ baseUrl: `${fake.url}/jira/`, token: JIRA_TOKEN }).check()).toBe("ctx");
  });
});

// WP-ST1 (spec.md section 6.20.9): sub-tasks, links, the status read, and transitions. Every test runs as Server and as Cloud.
describe.each([false, true])("Jira sub-tasks (cloud=%p)", (cloud) => {
  const PARENT = SUBTASK_PARENT;
  const SIBLINGS = ["ABC-11", "ABC-12", "ABC-13", "ABC-14"];
  const MOVE = "/rest/api/2/issue/ABC-12/transitions";
  const SET: IssueSubtask[] = [
    { key: "ABC-11", summary: "Batch the cache writes", status: "Done", category: "done" },
    { key: "ABC-12", summary: "Add the event generator", status: "In Progress", category: "indeterminate" },
    { key: "ABC-13", summary: "Flush before the write lock", status: "To Do", category: "new" },
    { key: "ABC-14", summary: "Measure the lock wait", status: "To Do", category: "new" },
  ];

  function start() {
    const fake = startFakeJira({ cloud });
    stops.push(fake.stop);
    fake.addSubtaskSet();
    return { fake, source: createJiraSource({ baseUrl: fake.url, token: JIRA_TOKEN, email: cloud ? JIRA_EMAIL : undefined }) };
  }

  test("the parent read gives the sub-tasks with status and category, and links to its sub-tasks; no /subtask path", async () => {
    const { fake, source } = start();
    const issue = await source.fetchIssue(PARENT);
    expect(issue.parent).toBeNull();
    expect(issue.subtasks).toEqual(SET);
    expect(issue.links).toEqual([{ text: "is blocked by", key: "ABC-11" }]);
    expect(fake.requests[0]).toBe(`GET /rest/api/2/issue/${PARENT}${ISSUE_QUERY}`);

    const sub = await source.fetchSubtask(PARENT, SIBLINGS, "ABC-13");
    expect(sub?.parent).toBe(PARENT);
    expect(sub?.subtasks).toEqual([]);
    expect(sub?.links).toEqual([{ text: "is blocked by", key: "ABC-12" }]);
    expect(sub?.summary).toBe("Flush before the write lock");
    expect(sub?.status).toBe("To Do");
    await source.subtaskStatuses(PARENT);
    await source.transitions("ABC-12");
    expect(fake.requests.filter((r) => /\/subtask(\/|$)/.test(r.split("?")[0] ?? ""))).toEqual([]);
  });

  test("a sub-task read whose parent names another key gives null and reads no comments", async () => {
    const { fake, source } = start();
    fake.addSubtasks("ABC-20", [{ key: "ABC-21", summary: "Other work", category: "new" }]);
    expect(await source.fetchSubtask(PARENT, SIBLINGS, "ABC-21")).toBeNull();
    expect(await source.fetchSubtask(PARENT, SIBLINGS, ISSUE_KEY)).toBeNull();
    expect(fake.count("GET", "/rest/api/2/issue/ABC-21")).toBe(1);
    expect(fake.count("GET", "/rest/api/2/issue/ABC-21/comment")).toBe(0);
    // A link to a key that is not a sibling is left out.
    expect((await source.fetchSubtask(PARENT, ["ABC-11"], "ABC-13"))?.links).toEqual([]);
  });

  test("odd sub-task and link shapes are left out; the rest of the issue reads", async () => {
    const { fake, source } = start();
    const path = `/rest/api/2/issue/${PARENT}`;
    fake.routes[key("GET", path)] = { status: 200, body: jiraFixture("subtasks-odd.json") };
    const odd: IssueSubtask[] = [
      { key: "ABC-11", summary: "Batch the cache writes", status: "Done", category: "done" },
      { key: "ABC-12", summary: "Add the event generator", status: "In Review", category: null },
      { key: "ABC-13", summary: "Flush before the write lock", status: "Triage", category: null },
      { key: "ABC-14", summary: "", status: null, category: null },
      { key: "ABC-15", summary: "", status: null, category: null },
    ];
    const issue = await source.fetchIssue(PARENT);
    expect(issue.summary).toBe("Split the cache work into sub-tasks");
    expect(issue.status).toBe("In Progress");
    expect(issue.parent).toBeNull();
    expect(issue.subtasks).toEqual(odd);
    expect(issue.links).toEqual([
      { text: "is blocked by", key: "ABC-12" },
      { text: "relates to", key: "ABC-13" },
    ]);
    expect(await source.subtaskStatuses(PARENT)).toEqual(odd);

    const body = jiraFixture<{ fields: Record<string, unknown> }>("subtasks-odd.json");
    for (const [subtasks, issuelinks, parent] of [
      [undefined, undefined, undefined],
      [{}, "blocks", { id: "1" }],
      [null, null, null],
    ]) {
      Object.assign(body.fields, { subtasks, issuelinks, parent });
      fake.routes[key("GET", path)] = { status: 200, body };
      const r = await source.fetchIssue(PARENT);
      expect([r.parent, r.subtasks, r.links]).toEqual([null, [], []]);
    }
  });

  test("the status read is one GET of the subtasks field and shows a changed status", async () => {
    const { fake, source } = start();
    expect(await source.subtaskStatuses(PARENT)).toEqual(SET);
    fake.setStatus("ABC-12", "done");
    expect((await source.subtaskStatuses(PARENT))[1]).toEqual({ ...(SET[1] as IssueSubtask), status: "Done", category: "done" });
    expect(fake.requests).toEqual([`GET /rest/api/2/issue/${PARENT}?fields=subtasks`, `GET /rest/api/2/issue/${PARENT}?fields=subtasks`]);
    // The read has no other content, so a body without the list is an error, never an empty list.
    fake.routes[key("GET", `/rest/api/2/issue/${PARENT}`)] = { status: 200, body: { fields: {} } };
    expect((await failure(source.subtaskStatuses(PARENT))).kind).toBe("shape");
    fake.routes[key("GET", `/rest/api/2/issue/${PARENT}`)] = { status: 401, body: null };
    expect((await failure(source.subtaskStatuses(PARENT))).kind).toBe("auth");
  });

  test("the transitions GET lists ID, name, and target status; odd entries are left out", async () => {
    const { fake, source } = start();
    expect(await source.transitions("ABC-12")).toEqual([
      { id: "11", name: "To Do", to: "To Do" },
      { id: "21", name: "In Progress", to: "In Progress" },
      { id: "31", name: "Done", to: "Done" },
    ]);
    expect(fake.requests).toEqual([`GET ${MOVE}`]);
    fake.routes[key("GET", MOVE)] = { status: 200, body: jiraFixture("subtasks-transitions-odd.json") };
    expect(await source.transitions("ABC-12")).toEqual([
      { id: "21", name: "Start review", to: "In Review" },
      { id: "31", name: "Done", to: null },
      { id: "41", name: "Reopen", to: null },
    ]);
    fake.routes[key("GET", MOVE)] = { status: 200, body: { expand: "transitions" } };
    expect((await failure(source.transitions("ABC-12"))).kind).toBe("shape");
    expect(fake.requests.filter((r) => r.startsWith("POST "))).toEqual([]);
  });

  test("the POST sends the JSON body with X-Atlassian-Token: no-check, gets 204, and changes the status", async () => {
    const { fake, source } = start();
    const real = fake.routes[key("POST", MOVE)] as (req: Request) => Promise<Reply>;
    let seen: unknown = null;
    fake.routes[key("POST", MOVE)] = async (req) => {
      seen = { type: req.headers.get("content-type"), xsrf: req.headers.get("x-atlassian-token"), body: await req.clone().text() };
      return real(req);
    };
    expect(await source.transition("ABC-12", "31")).toBeUndefined();
    expect(seen).toEqual({ type: "application/json", xsrf: "no-check", body: '{"transition":{"id":"31"}}' });
    expect(fake.transitions.get("ABC-12")).toEqual(["31"]);
    expect((await source.subtaskStatuses(PARENT))[1]?.category).toBe("done");
    expect(fake.count("POST", MOVE)).toBe(1);
  });

  test.each([400, 401, 404, 409, 422, 500])("HTTP %p of the POST gives the sentence, one POST, no token", async (status) => {
    const { fake, source } = start();
    if (status !== 400)
      fake.routes[key("POST", MOVE)] = { status, body: { errorMessages: [`echo ${JIRA_TOKEN}`] }, headers: { "X-Echo": JIRA_TOKEN } };
    // The fake gives its own 400 for an ID that is not a transition of the issue.
    const e = await failure(source.transition("ABC-12", "99"));
    expect(e).toBeInstanceOf(JiraRefusedError);
    expect(e.kind).toBe("server");
    expect(e.status).toBe(status);
    expect(e.message).toBe(`Jira refused the move (HTTP ${status}). Move ABC-12 in Jira.`);
    expect(`${e} ${e.stack} ${JSON.stringify(e)}`).not.toContain(JIRA_TOKEN);
    expect(fake.count("POST", MOVE)).toBe(1);
    expect(fake.transitions.size).toBe(0);
  });

  test("a redirect of the POST is an error and is not followed; a 200 page is no success", async () => {
    const { fake, source } = start();
    fake.routes[key("POST", MOVE)] = { status: 302, headers: { Location: `${fake.url}/login?token=${JIRA_TOKEN}` } };
    const e = await failure(source.transition("ABC-12", "21"));
    expect(e.kind).toBe("redirect");
    expect(e.status).toBe(302);
    expect(`${e} ${JSON.stringify(e)}`).not.toContain(JIRA_TOKEN);
    expect(fake.requests).toEqual([`POST ${MOVE}`]);
    fake.routes[key("POST", MOVE)] = { status: 200, body: "<html>Log in</html>" };
    expect((await failure(source.transition("ABC-12", "21"))).kind).toBe("shape");
  });

  test("the POST path guard refuses a free key or ID before any request", async () => {
    const { fake, source } = start();
    const bad: [string, string][] = [
      ["ABC-12/../../myself", "21"],
      ["../ABC-12", "21"],
      ["abc-12", "21"],
      ["ABC-12?x=1", "21"],
      ["", "21"],
      ["ABC-12", "21/../x"],
      ["ABC-12", "12345678901"],
      ["ABC-12", " 21"],
      ["ABC-12", "2e1"],
      ["ABC-12", ""],
    ];
    for (const [k, id] of bad) expect((await failure(source.transition(k, id))).kind).toBe("not_found");
    for (const k of ["ABC-12/../x", "abc-1"]) {
      expect((await failure(source.transitions(k))).kind).toBe("not_found");
      expect((await failure(source.subtaskStatuses(k))).kind).toBe("not_found");
      expect((await failure(source.fetchSubtask(PARENT, SIBLINGS, k))).kind).toBe("not_found");
    }
    expect(fake.requests).toEqual([]);
  });
});
