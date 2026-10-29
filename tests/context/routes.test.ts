// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 S-JIRA and r3 S-ATT: the task context API against the fake Jira. No test calls a real server.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { dbPath, writeConfig } from "../../src/server/config";
import { createContextRoutes } from "../../src/server/context/routes";
import { taskFiles } from "../../src/server/context/task-file";
import { createLive } from "../../src/server/live";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings, type Settings } from "../../src/server/settings";
import {
  type AttachmentDto,
  MAX_ATTACHMENT_BYTES,
  MAX_PR_ATTACHMENT_BYTES,
  type MetaDto,
  type SettingsDto,
  type TaskContextDto,
} from "../../src/shared/dto";
import { key } from "../support/fake-bitbucket";
import { attachmentPath, type FakeJira, ISSUE_KEY, JIRA_TOKEN, logOf, pngOf, startFakeJira } from "../support/fake-jira";

process.env.REVIEW_LOOP_SECRETS = "memory";
const root = mkdtempSync(join(tmpdir(), "rl-context-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PORT = 7317;
const SESSION = "s".repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };

let jira: FakeJira;
let dir: string;
let n = 0;
const opened: Settings[] = [];
beforeEach(() => {
  jira = startFakeJira();
  dir = join(root, `case-${n++}`);
});
afterEach(() => {
  jira.stop();
  for (const s of opened.splice(0)) s.close();
});

function setup() {
  writeConfig(dir, { baseUrl: "https://bitbucket.example.test", userSlug: "jdoe", notifications: false });
  const settings = createSettings({ dir, secrets: createSecrets(null), jiraSecrets: createSecrets(null, "jira-token") });
  opened.push(settings);
  const db = settings.db();
  if (!db) throw new Error("no db");
  const pr = (db.query("INSERT INTO pull_request (project, repo, pr_id) VALUES ('PROJ', 'repo', 1) RETURNING id").get() as { id: number })
    .id;
  for (const [i, k] of [ISSUE_KEY, "ABC-404"].entries())
    db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, $k, 'title', NULL, $i)").run({ pr, k, i });
  const live = createLive();
  const events: unknown[] = [];
  const broadcast = live.broadcast;
  live.broadcast = (event, data) => {
    events.push({ event, data });
    broadcast(event, data);
  };
  // The data folder of the jobs holds the attachments. It must not be the default data folder.
  const review = createReviewJobs({ settings, live, dataDir: dir });
  const app = createApp({ port: PORT, token: SESSION, live, settings, review });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`${ORIGIN}/api${path}`, { method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  const connect = () => call("PUT", "/settings/jira", { baseUrl: jira.url, token: JIRA_TOKEN });
  return { settings, db, pr, events, call, connect, review, live };
}

describe("task context API", () => {
  test("POST before Jira settings gives 409 and sends no request", async () => {
    const s = setup();
    const res = await s.call("POST", `/prs/${s.pr}/task-context/${ISSUE_KEY}`);
    expect(res.status).toBe(409);
    expect(jira.requests).toEqual([]);
  });

  test("PUT checks the token, saves the URL without the token, and meta lists Jira", async () => {
    const s = setup();
    expect(((await (await s.call("GET", "/meta")).json()) as MetaDto).context).toEqual([{ id: "jira", name: "Jira", configured: false }]);
    const res = await s.connect();
    expect(res.status).toBe(200);
    expect(((await res.json()) as SettingsDto).jira).toEqual({ baseUrl: jira.url, caFile: null, email: null, tokenStored: true });
    expect(jira.requests).toEqual(["GET /rest/api/2/serverInfo", "GET /rest/api/2/myself"]);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).jira).toEqual({ baseUrl: jira.url });
    expect(((await (await s.call("GET", "/meta")).json()) as MetaDto).context).toEqual([{ id: "jira", name: "Jira", configured: true }]);
  });

  test("POST fetches, stores, broadcasts, and the run file holds the issue text", async () => {
    const s = setup();
    await s.connect();
    const res = await s.call("POST", `/prs/${s.pr}/task-context/${ISSUE_KEY}`);
    expect(res.status).toBe(200);
    const dto = (await res.json()) as TaskContextDto;
    expect(dto).toMatchObject({ key: ISSUE_KEY, source: "jira", summary: "Flush the cache before the write lock", commentsTotal: 3 });
    expect(dto.comments.length).toBe(3);
    expect(s.events).toEqual([{ event: "changed", data: { prs: [s.pr] } }]);
    const list = (await (await s.call("GET", `/prs/${s.pr}/task-context`)).json()) as TaskContextDto[];
    expect(list).toEqual([dto]);
    const [file] = taskFiles(s.db, s.pr);
    expect(file?.name).toBe("task.md");
    expect(file?.text).toContain(`## Task ${ISSUE_KEY}: Flush the cache before the write lock`);
    expect(file?.text).toContain("QA: test with an empty cache too.");
  });

  test("bad key 400, key outside the PR 404, unknown PR 404; no Jira request", async () => {
    const s = setup();
    await s.connect();
    const before = jira.requests.length;
    expect((await s.call("POST", `/prs/${s.pr}/task-context/abc-1`)).status).toBe(400);
    expect((await s.call("POST", `/prs/${s.pr}/task-context/XYZ-1`)).status).toBe(404);
    expect((await s.call("POST", `/prs/999/task-context/${ISSUE_KEY}`)).status).toBe(404);
    expect((await s.call("GET", "/prs/999/task-context")).status).toBe(404);
    expect(jira.requests.length).toBe(before);
  });

  test("Jira errors give 502 with fixed texts and store nothing", async () => {
    const s = setup();
    await s.connect();
    const post = async (k = ISSUE_KEY) => {
      const res = await s.call("POST", `/prs/${s.pr}/task-context/${k}`);
      return { status: res.status, error: ((await res.json()) as { error: string }).error };
    };
    expect(await post("ABC-404")).toEqual({ status: 502, error: "Jira has no such issue, or the token may not see it." });
    const issue = `/rest/api/2/issue/${ISSUE_KEY}`;
    jira.routes[key("GET", issue)] = { status: 302, headers: { Location: "https://sso.example.test/login" } };
    expect(await post()).toEqual({ status: 502, error: "Jira answered with a redirect. Check the Jira URL in Settings." });
    jira.routes[key("GET", issue)] = { status: 200, body: { errorMessages: ["BODY-CANARY"] } };
    expect(await post()).toEqual({ status: 502, error: "Jira sent an answer in an unknown format." });
    jira.token = "rotated";
    expect(await post()).toEqual({ status: 502, error: "Jira rejected the token. Check the Jira settings." });
    expect(s.db.query("SELECT COUNT(*) AS n FROM task_context").get()).toEqual({ n: 0 });
    expect(s.events).toEqual([]);
  });

  test("DELETE removes the row and gives 204", async () => {
    const s = setup();
    await s.connect();
    await s.call("POST", `/prs/${s.pr}/task-context/${ISSUE_KEY}`);
    const res = await s.call("DELETE", `/prs/${s.pr}/task-context/${ISSUE_KEY}`);
    expect(res.status).toBe(204);
    expect(await (await s.call("GET", `/prs/${s.pr}/task-context`)).json()).toEqual([]);
    expect((await s.call("DELETE", `/prs/${s.pr}/task-context/${ISSUE_KEY}`)).status).toBe(204);
  });

  test("the Jira token never reaches config.json, the database, a response, or the log", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const s = setup();
      const bodies: string[] = [];
      const wrong = await s.call("PUT", "/settings/jira", { baseUrl: jira.url, token: `${JIRA_TOKEN}-x` });
      expect(wrong.status).toBe(400);
      bodies.push(await wrong.text());
      bodies.push(await (await s.connect()).text());
      bodies.push(await (await s.call("POST", `/prs/${s.pr}/task-context/${ISSUE_KEY}`)).text());
      jira.token = "rotated";
      bodies.push(await (await s.call("POST", `/prs/${s.pr}/task-context/${ISSUE_KEY}`)).text());
      bodies.push(await (await s.call("GET", "/settings")).text());
      for (const b of bodies) expect(b).not.toContain(JIRA_TOKEN);
      s.settings.close();
      for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).includes(JIRA_TOKEN)).toBe(false);
      expect(lines.some((l) => l.startsWith("Jira fetch failed: auth 401"))).toBe(true);
      for (const l of lines) expect(l).not.toContain(JIRA_TOKEN);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("task attachments (plan r3 S-ATT)", () => {
  const PNG = pngOf(2048);
  const LOG = logOf(512);
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const stem = () => (dbPath(dir, "https://bitbucket.example.test").split(/[\\/]/).at(-1) ?? "").replace(".sqlite", "");
  const folder = (pr: number) => join(dir, "attachments", stem(), `${pr}`, ISSUE_KEY);
  const files = (pr: number) => (existsSync(folder(pr)) ? readdirSync(folder(pr)) : []);
  const base = (pr: number) => `/prs/${pr}/task-context/${ISSUE_KEY}`;
  // A connected Jira and the fetched task, with these extra attachments listed.
  async function fetched(extra: Parameters<FakeJira["attach"]>[1][] = []) {
    for (const a of extra) jira.attach(ISSUE_KEY, a);
    const s = setup();
    await s.connect();
    expect((await s.call("POST", base(s.pr))).status).toBe(200);
    s.events.length = 0;
    const download = async (att: string) => {
      const res = await s.call("POST", `${base(s.pr)}/files/${att}`);
      return { status: res.status, body: (await res.json()) as AttachmentDto & { error?: string } };
    };
    return { ...s, download };
  }

  test("POST downloads with the token into the database folder; GET lists it; a second POST sends no request", async () => {
    const s = await fetched();
    const before = jira.requests.length;
    const got = await s.download("10100");
    expect(got).toEqual({
      status: 200,
      body: {
        id: "10100",
        filename: "screenshot.png",
        size: 2048,
        sha256: sha(PNG),
        image: true,
        text: false,
        pdf: false,
        include: false,
        downloadedAt: expect.any(Number),
      },
    });
    expect(jira.requests.slice(before)).toEqual([`GET ${attachmentPath("10100", "screenshot.png")}`]);
    expect(files(s.pr)).toEqual(["10100-screenshot.png"]);
    expect(readFileSync(join(folder(s.pr), "10100-screenshot.png")).equals(PNG)).toBe(true);
    expect(s.events).toEqual([{ event: "changed", data: { prs: [s.pr] } }]);
    expect((await s.download("10101")).body).toMatchObject({ id: "10101", image: false, text: true, sha256: sha(LOG) });
    const [task] = (await (await s.call("GET", `/prs/${s.pr}/task-context`)).json()) as TaskContextDto[];
    expect(task?.files?.map((f) => f.id)).toEqual(["10100", "10101"]);
    expect(await s.download("10100")).toEqual(got);
    expect(jira.requests.length).toBe(before + 2);
  });

  test("Save sends a download; the image route serves the PNG by its bytes; both need no session header", async () => {
    const s = await fetched();
    await s.download("10100");
    await s.download("10101");
    const app = createApp({ port: PORT, token: SESSION, live: s.live, settings: s.settings, review: s.review });
    const get = (path: string) => app.request(`${ORIGIN}/api${path}`, { headers: { host: `127.0.0.1:${PORT}` } });
    const save = await get(`${base(s.pr)}/files/10100`);
    expect(save.status).toBe(200);
    const headers = ["content-type", "content-disposition", "content-security-policy", "x-content-type-options"];
    expect(Object.fromEntries(headers.map((h) => [h, save.headers.get(h)]))).toEqual({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="screenshot.png"; filename*=UTF-8''screenshot.png`,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    });
    expect(Buffer.from(await save.arrayBuffer()).equals(PNG)).toBe(true);
    const image = await get(`${base(s.pr)}/files/10100/image`);
    expect(Object.fromEntries(headers.map((h) => [h, image.headers.get(h)]))).toEqual({
      "content-type": "image/png",
      "content-disposition": null,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    });
    expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await get(`${base(s.pr)}/files/10101/image`)).status).toBe(404);
    expect((await get(`${base(s.pr)}/files/10102`)).status).toBe(404);
    // Other answers keep the app policy.
    expect((await get(`/prs/${s.pr}/task-context`)).headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  test("SVG, HTML, and HTML named .png are never served inline, whatever the listed type", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const s = await fetched([
      { id: "201", filename: "logo.svg", mimeType: "image/svg+xml", body: svg },
      { id: "202", filename: "page.html", mimeType: "text/html", body: html },
      { id: "203", filename: "photo.png", mimeType: "image/png", body: html },
    ]);
    for (const id of ["201", "202", "203"]) {
      expect((await s.download(id)).body).toMatchObject({ id, image: false, text: true });
      const inline = await s.call("GET", `${base(s.pr)}/files/${id}/image`);
      expect(inline.status).toBe(404);
      expect(inline.headers.get("content-type")).toContain("application/json");
      const save = await s.call("GET", `${base(s.pr)}/files/${id}`);
      expect([save.headers.get("content-type"), save.headers.get("content-security-policy")]).toEqual([
        "application/octet-stream",
        "sandbox",
      ]);
    }
  });

  test("a body over the listed size stops the download and leaves no .part and no row; a short body stores nothing", async () => {
    const s = await fetched([
      { id: "204", filename: "big.log", mimeType: "text/plain", body: logOf(1024 * 1024), size: 10 },
      { id: "205", filename: "short.log", mimeType: "text/plain", body: logOf(50), size: 100 },
    ]);
    for (const id of ["204", "205"])
      expect(await s.download(id)).toEqual({
        status: 502,
        body: { error: "Jira sent a file of another size. It can be a login page. Check that the token can open attachments." },
      } as never);
    expect(files(s.pr)).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM task_attachment").get()).toEqual({ n: 0 });
    expect(s.events).toEqual([]);
  });

  test("the file cap and the PR cap give 413 before any request", async () => {
    const s = await fetched([{ id: "206", filename: "dump.bin", mimeType: null, body: logOf(10), size: MAX_ATTACHMENT_BYTES + 1 }]);
    const before = jira.requests.length;
    expect(await s.download("206")).toEqual({ status: 413, body: { error: "The file is larger than 100 MB." } } as never);
    s.db
      .query(
        `INSERT INTO task_attachment (pr, key, att_id, filename, mime, size, file, sha256, image, text, include, downloaded_at)
          VALUES ($pr, $key, '1', 'old.bin', NULL, $size, 'x/old.bin', '', 0, 0, 0, 1)`,
      )
      .run({ pr: s.pr, key: ISSUE_KEY, size: MAX_PR_ATTACHMENT_BYTES - 2047 });
    expect(await s.download("10100")).toEqual({
      status: 413,
      body: { error: "The files of this pull request would pass 500 MB. Delete files first." },
    } as never);
    expect(jira.requests.length).toBe(before);
  });

  test("a cross-origin redirect gives 502 and stores nothing", async () => {
    jira.routes[key("GET", attachmentPath("10100", "screenshot.png"))] = {
      status: 302,
      headers: { Location: "https://objects.example.test/bucket/10100?signature=x" },
    };
    const s = await fetched();
    expect(await s.download("10100")).toEqual({
      status: 502,
      body: { error: "Jira sent the file from another address. The app downloads only from the Jira URL." },
    } as never);
    expect(files(s.pr)).toEqual([]);
  });

  test("PUT sets include; DELETE removes the row and the file", async () => {
    const s = await fetched();
    await s.download("10100");
    const put = (att: string, body: unknown) => s.call("PUT", `${base(s.pr)}/files/${att}`, body);
    const on = await put("10100", { include: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as AttachmentDto).include).toBe(true);
    expect((await put("10100", { include: "yes" })).status).toBe(400);
    expect((await put("10101", { include: true })).status).toBe(404);
    expect(s.events.length).toBe(2);
    expect((await s.call("DELETE", `${base(s.pr)}/files/10100`)).status).toBe(204);
    expect(files(s.pr)).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM task_attachment").get()).toEqual({ n: 0 });
    expect((await s.call("DELETE", `${base(s.pr)}/files/10100`)).status).toBe(204);
  });

  test("removing the task deletes its attachment rows and its folder", async () => {
    const s = await fetched();
    await s.download("10100");
    expect(files(s.pr).length).toBe(1);
    expect((await s.call("DELETE", base(s.pr))).status).toBe(204);
    expect(existsSync(folder(s.pr))).toBe(false);
    expect(s.db.query("SELECT COUNT(*) AS n FROM task_attachment").get()).toEqual({ n: 0 });
  });

  test("bad IDs give 400; an unlisted attachment or an unfetched task gives 404; no Jira request", async () => {
    const s = setup();
    await s.connect();
    expect((await s.call("POST", `${base(s.pr)}/files/10100`)).status).toBe(404);
    await s.call("POST", base(s.pr));
    const before = jira.requests.length;
    for (const att of ["abc", "1".repeat(19), "-1"]) expect((await s.call("POST", `${base(s.pr)}/files/${att}`)).status).toBe(400);
    expect((await s.call("POST", `${base(s.pr)}/files/999`)).status).toBe(404);
    expect((await s.call("GET", `${base(s.pr)}/files/abc/image`)).status).toBe(400);
    expect(jira.requests.length).toBe(before);
  });

  test("open-folder calls the opener with the task folder only; no file manager gives 501 with the path", async () => {
    const s = await fetched();
    const opened: string[] = [];
    let works = true;
    const routes = createContextRoutes({
      settings: s.settings,
      review: s.review,
      live: s.live,
      openFolder: async (path) => {
        opened.push(path);
        return works;
      },
    });
    const post = (k: string) => routes.request(`/prs/${s.pr}/task-context/${k}/open-folder`, { method: "POST" });
    expect((await post(ISSUE_KEY)).status).toBe(204);
    expect(opened).toEqual([folder(s.pr)]);
    expect(existsSync(folder(s.pr))).toBe(true);
    works = false;
    const res = await post(ISSUE_KEY);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "No file manager opened the folder. Copy the path.", path: folder(s.pr) });
    expect((await post("ABC-404")).status).toBe(404);
    expect(opened.length).toBe(2);
  });
});
