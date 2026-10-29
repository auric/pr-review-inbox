// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fake Jira for tests and the demo. It listens on 127.0.0.1 only and serves fixtures/jira/ payloads.
// Default: Jira Server/Data Center with a Bearer PAT. cloud: Jira Cloud with Basic auth of JIRA_EMAIL and the token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { key, type Reply, startFakeBitbucket } from "./fake-bitbucket";

export const JIRA_TOKEN = "fake-jira-token-fedcba9876543210";
export const ISSUE_KEY = "ABC-42";
export const JIRA_EMAIL = "jdoe@example.com";
// The parent of addSubtaskSet().
export const SUBTASK_PARENT = "ABC-10";

// Reads a raw response body from fixtures/jira/.
export function jiraFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dir, "../../fixtures/jira", name), "utf8"));
}

// A PNG of exactly size bytes: 8 x 8 pixels of one RGB color, padded with a tEXt chunk (PNG spec, sections 5 and 11.3.4.3).
export function pngOf(size: number, rgb: [number, number, number] = [0xd0, 0x30, 0x30]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = [0, ...Array.from({ length: 8 }, () => rgb).flat()];
  const head = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(Array.from({ length: 8 }, () => row).flat()))),
  ];
  const end = chunk("IEND", new Uint8Array());
  const label = Buffer.from("Comment\0", "latin1");
  const pad = size - head.reduce((n, b) => n + b.length, 0) - end.length - 12 - label.length;
  if (pad < 0) throw new Error(`A PNG needs more than ${size} bytes.`);
  return Buffer.concat([...head, chunk("tEXt", Buffer.concat([label, Buffer.alloc(pad, "x")])), end]);
}

// size bytes of an ASCII log.
export function logOf(size: number): Uint8Array {
  const line = "2026-01-06T14:00:00Z INFO sync worker: flushed 12 cache entries\n";
  return Buffer.from(line.repeat(Math.ceil(size / line.length)).slice(0, size), "latin1");
}

// The download path of an attachment (plan r3 S-ATT).
export const attachmentPath = (id: string, filename: string) => `/secure/attachment/${id}/${encodeURIComponent(filename)}`;
// The Jira Cloud download path of an attachment, without the query.
export const cloudAttachmentPath = (id: string) => `/rest/api/2/attachment/content/${id}`;

type Page = { startAt: number; maxResults: number; total: number; comments: unknown[] };
type Attachment = { id: string; filename: string; mimeType: string | null; size: number };
type Issue = { key: string; fields: { summary: string; attachment: Attachment[] } };

export function startFakeJira(opts: { port?: number; https?: boolean; cloud?: boolean } = {}) {
  const fake = startFakeBitbucket(opts);
  // cloud: the 303 target of an attachment download without redirect=false. It is another origin.
  const media = opts.cloud ? startFakeBitbucket() : null;
  fake.token = JIRA_TOKEN;
  fake.user = null;
  // serverInfo allows anonymous access on Server/Data Center and Cloud.
  fake.authorized = (req) =>
    new URL(req.url).pathname === "/rest/api/2/serverInfo" ||
    req.headers.get("authorization") ===
      (opts.cloud ? `Basic ${Buffer.from(`${JIRA_EMAIL}:${fake.token}`).toString("base64")}` : `Bearer ${fake.token}`);
  fake.routes[key("GET", "/rest/api/2/myself")] = {
    status: 200,
    body: opts.cloud
      ? { accountId: "5b10ac8d82e05b22cc7d4ef5", accountType: "atlassian", displayName: "Jordan Doe", active: true }
      : jiraFixture("myself.json"),
  };
  fake.routes[key("GET", "/rest/api/2/serverInfo")] = {
    status: 200,
    body: { baseUrl: fake.url, version: opts.cloud ? "1001.0.0-SNAPSHOT" : "9.12.0", deploymentType: opts.cloud ? "Cloud" : "Server" },
  };
  const issues = new Map<string, Issue>();

  // Serves body at the download path, with mimeType as Content-Type.
  function serve(a: { id: string; filename: string; mimeType: string | null }, body: Uint8Array) {
    const ok: Reply = { status: 200, body, headers: a.mimeType ? { "Content-Type": a.mimeType } : {} };
    if (!media) {
      fake.routes[key("GET", attachmentPath(a.id, a.filename))] = ok;
      return;
    }
    fake.routes[key("GET", cloudAttachmentPath(a.id))] = (req) =>
      new URL(req.url).searchParams.get("redirect") === "false" ? ok : { status: 303, headers: { Location: `${media.url}/file/${a.id}` } };
  }

  // Serves issue.json and the two comment pages under this key. The fixture attachments get a PNG and a log of their sizes.
  function addIssue(issueKey: string, summary?: string) {
    const issue = jiraFixture<Issue>("issue.json");
    issue.key = issueKey;
    if (summary) issue.fields.summary = summary;
    for (const a of issue.fields.attachment) serve(a, a.mimeType === "image/png" ? pngOf(a.size) : logOf(a.size));
    issues.set(issueKey, issue);
    const pages = [jiraFixture<Page>("comments-p0.json"), jiraFixture<Page>("comments-p1.json")];
    const path = `/rest/api/2/issue/${issueKey}`;
    fake.routes[key("GET", path)] = { status: 200, body: issue };
    fake.routes[key("GET", `${path}/comment`)] = (req) => {
      const at = Number(new URL(req.url).searchParams.get("startAt") ?? 0);
      return { status: 200, body: pages.find((p) => p.startAt === at) ?? { startAt: at, maxResults: 2, total: 3, comments: [] } };
    };
  }
  addIssue(ISSUE_KEY);

  // Lists a new attachment on the issue and serves body for it. size: the listed size, body.length when absent.
  function attach(issueKey: string, a: { id: string; filename: string; mimeType: string | null; body: Uint8Array; size?: number }) {
    const issue = issues.get(issueKey);
    if (!issue) throw new Error(`No issue ${issueKey}.`);
    issue.fields.attachment.push({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size ?? a.body.length });
    serve(a, a.body);
  }

  // Sub-tasks (spec.md section 6.20). Shapes follow the Jira 9.12.0 REST docs (issue-getIssue, issue-getTransitions). The parent gets
  // subtasks, issuelinks, and one comment with a file link. Each sub-task gets parent. Every issue gets transitions.
  // The transition POST needs JSON and X-Atlassian-Token: no-check, as the app sends it. Real Jira may not need the header.
  const self = (path: string) => `${fake.url}/rest/api/2/${path}`;
  const CATEGORIES = { new: [2, "blue-gray", "To Do"], indeterminate: [4, "yellow", "In Progress"], done: [3, "green", "Done"] } as const;
  type Category = keyof typeof CATEGORIES;
  const STATUS_IDS: Record<Category, string> = { new: "10000", indeterminate: "3", done: "10001" };
  const statusOf = (category: Category) => {
    const [id, colorName, name] = CATEGORIES[category];
    return {
      self: self(`status/${STATUS_IDS[category]}`),
      description: "",
      iconUrl: `${fake.url}/images/icons/statuses/generic.png`,
      name,
      id: STATUS_IDS[category],
      statusCategory: { self: self(`statuscategory/${id}`), id, key: category, colorName, name },
    };
  };
  const issueType = (subtask: boolean) => ({
    self: self("issuetype/10003"),
    id: subtask ? "10003" : "10002",
    name: subtask ? "Sub-task" : "Task",
    subtask,
  });
  const ref = (k: string) => {
    const i = issues.get(k) as (Issue & { fields: Record<string, unknown> }) | undefined;
    if (!i) throw new Error(`No issue ${k}.`);
    return {
      id: k.replace(/\D/g, ""),
      key: k,
      self: self(`issue/${k}`),
      fields: { summary: i.fields.summary, status: i.fields.status, issuetype: i.fields.issuetype },
    };
  };
  const TRANSITIONS: [string, Category][] = [
    ["11", "new"],
    ["21", "indeterminate"],
    ["31", "done"],
  ];
  const transitions = new Map<string, string[]>();
  function transitionRoutes(k: string) {
    const path = `/rest/api/2/issue/${k}/transitions`;
    fake.routes[key("GET", path)] = () => ({
      status: 200,
      body: {
        expand: "transitions",
        transitions: TRANSITIONS.map(([id, c]) => ({
          id,
          name: CATEGORIES[c][2],
          to: statusOf(c),
          hasScreen: false,
          isGlobal: true,
          isInitial: false,
          isConditional: false,
        })),
      },
    });
    fake.routes[key("POST", path)] = async (req) => {
      if (req.headers.get("x-atlassian-token") !== "no-check") return { status: 403, body: "XSRF check failed" };
      if (!req.headers.get("content-type")?.startsWith("application/json")) return { status: 415, body: null };
      const id = ((await req.json().catch(() => null)) as { transition?: { id?: unknown } } | null)?.transition?.id;
      const t = TRANSITIONS.find(([tid]) => tid === id);
      if (!t) return { status: 400, body: { errorMessages: ["Transition id is not valid for this issue."], errors: {} } };
      setStatus(k, t[1]);
      transitions.set(k, [...(transitions.get(k) ?? []), String(id)]);
      return { status: 204 };
    };
  }

  // Changes the status of an issue and of its entry in the parent subtasks, as a transition or a Jira automation does.
  function setStatus(k: string, category: Category) {
    const status = statusOf(category);
    (issues.get(k)?.fields as Record<string, unknown>).status = status;
    for (const i of issues.values())
      for (const s of ((i.fields as Record<string, unknown>).subtasks ?? []) as { key: string; fields: { status: unknown } }[])
        if (s.key === k) s.fields.status = status;
  }

  // Adds a parent with these sub-tasks. links: [from, to] pairs, as "from is blocked by to".
  function addSubtasks(
    parentKey: string,
    subtasks: { key: string; summary: string; category: Category }[],
    links: [string, string][] = [],
  ) {
    addIssue(parentKey, "Split the cache work into sub-tasks");
    const parent = issues.get(parentKey)?.fields as Record<string, unknown>;
    Object.assign(parent, { status: statusOf("indeterminate"), issuetype: issueType(false) });
    for (const s of subtasks) {
      addIssue(s.key, s.summary);
      Object.assign(issues.get(s.key)?.fields as Record<string, unknown>, {
        status: statusOf(s.category),
        issuetype: issueType(true),
        parent: ref(parentKey),
        issuelinks: [],
      });
      transitionRoutes(s.key);
    }
    transitionRoutes(parentKey);
    parent.subtasks = subtasks.map((s) => ref(s.key));
    const link = (to: string, n: number) => ({
      id: String(10200 + n),
      self: self(`issueLink/${10200 + n}`),
      type: { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks", self: self("issueLinkType/10000") },
      inwardIssue: ref(to),
    });
    parent.issuelinks = [];
    links.forEach(([from, to], n) => {
      const f = issues.get(from)?.fields as Record<string, unknown>;
      f.issuelinks = [...((f.issuelinks as unknown[]) ?? []), link(to, n)];
    });
    // One link from the parent to its first sub-task, so the parent read has an issuelinks entry.
    if (subtasks[0]) parent.issuelinks = [link(subtasks[0].key, links.length)];
    const att = issues.get(parentKey)?.fields.attachment.find((a) => a.mimeType !== "image/png");
    const href = att ? (opts.cloud ? cloudAttachmentPath(att.id) : attachmentPath(att.id, att.filename)) : "";
    fake.routes[key("GET", `/rest/api/2/issue/${parentKey}/comment`)] = {
      status: 200,
      body: {
        startAt: 0,
        maxResults: 100,
        total: 1,
        comments: [
          {
            self: self(`issue/${parentKey}/comment/10010`),
            id: "10010",
            author: { name: "asmith", displayName: "Alex Smith", active: true },
            body: `The log is attached: [^${att?.filename}]`,
            renderedBody: `<p>The log is attached: <span class="nobr"><a href="${href}" title="${att?.filename} attached to ${parentKey}">${att?.filename}</a></span></p>`,
            created: "2026-01-07T10:00:00.000+0000",
            updated: "2026-01-07T10:00:00.000+0000",
          },
        ],
      },
    };
  }

  // The WP-ST1 set: ABC-11 done, ABC-12 in progress, ABC-13 and ABC-14 to do. ABC-13 is blocked by ABC-12.
  function addSubtaskSet() {
    addSubtasks(
      SUBTASK_PARENT,
      [
        { key: "ABC-11", summary: "Batch the cache writes", category: "done" },
        { key: "ABC-12", summary: "Add the event generator", category: "indeterminate" },
        { key: "ABC-13", summary: "Flush before the write lock", category: "new" },
        { key: "ABC-14", summary: "Measure the lock wait", category: "new" },
      ],
      [["ABC-13", "ABC-12"]],
    );
  }

  // The number of requests with this method and path, any query.
  const count = (method: string, path: string) => fake.requests.filter((r) => r.split("?")[0] === `${method} ${path}`).length;

  const stop = fake.stop;
  return Object.assign(fake, {
    addIssue,
    addSubtasks,
    addSubtaskSet,
    setStatus,
    count,
    transitions,
    attach,
    media,
    stop() {
      stop();
      media?.stop();
    },
  });
}

export type FakeJira = ReturnType<typeof startFakeJira>;
