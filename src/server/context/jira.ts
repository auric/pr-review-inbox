// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Jira REST 2 client for Server/Data Center (BRIEF section 7, Jira 9.12 docs) and Jira Cloud. The only module that sends requests to Jira.
// GET only, except transition() (spec.md section 6.20.9).
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ATT_ID, type AttachmentMeta, type IssueContext, type IssueLink, type IssueSubtask, JIRA_KEY } from "../../shared/dto";
import { COMPILED } from "../build";
import { log } from "../log";
import { fenced } from "./markdown";
import type { ConvertReply, ConvertRequest } from "./markdown-worker";
import { ContextError, type ContextErrorKind, type ContextSource, type JiraTransition } from "./source";

export const JIRA = { id: "jira", name: "Jira" } as const;

const TIMEOUT_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
export const CAPS = { description: 20_000, comment: 5_000, comments: 500, totalBytes: 200_000 };
// A larger answer body is an error of kind shape.
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
// A larger rendered field uses the wiki text.
export const MAX_HTML_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS = 200;
// Plan r3: an attachment download follows at most this many redirects, each inside the configured origin and base path.
export const MAX_HOPS = 3;
const ATTACHMENT_PATH = "/secure/attachment";
// Jira Cloud OpenAPI: redirect=false gives 200 with the bytes in place of a 303 to another host.
const CLOUD_ATTACHMENT_PATH = "/rest/api/2/attachment/content";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// Deep nesting keeps the converter busy for minutes (1 MB of nested div: over 90 s).
// A field budget starts when its worker is ready. The total budget starts when the first worker is ready.
export const CONVERT_FIELD_MS = 3_000;
export const CONVERT_TOTAL_MS = 10_000;
const WORKER_START_MS = 5_000;
// In a compiled binary, import.meta.url names the bundle entry. scripts/compile.ts embeds markdown-worker.ts as context/markdown-worker.js beside it.
const WORKER_URL = new URL(COMPILED ? "./context/markdown-worker.ts" : "./markdown-worker.ts", import.meta.url).href;

// One worker per issue fetch, started on first use. convert gives null for a converter error, a timeout, or a worker that does not start.
function createConverter(base: string, fieldMs: number, totalMs: number) {
  let worker: Worker | null = null;
  let ready: Promise<boolean> = Promise.resolve(false);
  let pending: ((r: ConvertReply | null) => void) | null = null;
  let deadline = Number.POSITIVE_INFINITY;
  let broken = false;
  let seq = 0;

  const stop = () => {
    worker?.terminate();
    worker = null;
  };

  const start = (): Worker => {
    const w = new Worker(WORKER_URL);
    ready = new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), WORKER_START_MS);
      // Bun's types can resolve Worker.onmessage to a constructor type under the DOM lib.
      (w as EventTarget).addEventListener("message", (e) => {
        const data = (e as MessageEvent<ConvertReply | "ready">).data;
        if (data !== "ready") {
          if (data.id === seq) pending?.(data);
          return;
        }
        clearTimeout(t);
        resolve(true);
      });
      w.onerror = () => {
        clearTimeout(t);
        resolve(false);
        if (w === worker) pending?.(null);
      };
    });
    worker = w;
    return w;
  };

  return {
    async convert(html: string): Promise<string | null> {
      if (broken || performance.now() >= deadline) return null;
      const w = worker ?? start();
      if (!(await ready)) {
        broken = true;
        stop();
        log("The Jira text converter did not start. The task shows the wiki text.");
        return null;
      }
      deadline = Math.min(deadline, performance.now() + totalMs);
      const ms = Math.min(fieldMs, deadline - performance.now());
      if (ms <= 0) return null;
      const id = ++seq;
      const reply = await new Promise<ConvertReply | null>((resolve) => {
        const t = setTimeout(() => done(null), ms);
        const done = (r: ConvertReply | null) => {
          clearTimeout(t);
          pending = null;
          resolve(r);
        };
        pending = done;
        w.postMessage({ id, html, base } satisfies ConvertRequest);
      });
      if (!reply) stop();
      return reply && "markdown" in reply ? reply.markdown : null;
    },
    close: stop,
  };
}

// Lenient: unknown keys pass. The real shapes are not recorded (integration-check.md, Release 2).
// Jira Cloud has no name (GDPR user privacy migration). It gives accountId and displayName.
const myself = z
  .object({ displayName: z.string().nullish(), name: z.string().nullish(), accountId: z.string().nullish() })
  .transform((m) => m.displayName || m.name || m.accountId)
  .pipe(z.string().min(1));
// Jira Cloud always gives deploymentType "Cloud". Server/Data Center can omit it.
const serverInfo = z.object({ deploymentType: z.string().nullish() });
const issue = z.object({
  fields: z.object({
    summary: z.string(),
    description: z.string().nullish(),
    status: z.object({ name: z.string() }).nullish(),
    attachment: z.array(z.unknown()).nullish(),
    parent: z.unknown().optional(),
    subtasks: z.unknown().optional(),
    issuelinks: z.unknown().optional(),
  }),
  renderedFields: z.object({ description: z.string().nullish() }).nullish(),
});
// An entry with another shape is left out of the list.
const attachment = z.object({
  id: z.union([z.string().regex(ATT_ID), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]),
  filename: z.string(),
  mimeType: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  size: z.number().int().nonnegative(),
  created: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});
const user = z.object({ displayName: z.string().nullish(), name: z.string().nullish() }).nullish();
const commentPage = z.object({
  total: z.number().int().nonnegative(),
  comments: z.array(
    z.object({ author: user, body: z.string().nullish(), renderedBody: z.string().nullish(), created: z.string().nullish() }),
  ),
});

// Sub-tasks and links (spec.md section 6.20.9). Gates J1 and J2 record the real shapes. An entry without a key is left out.
const TRANSITION_ID = /^\d{1,10}$/;
const CATEGORIES = ["new", "indeterminate", "done"] as const;
const issueRef = z.object({ key: z.string().regex(JIRA_KEY) });
const subtaskEntry = z
  .object({
    key: z.string().regex(JIRA_KEY),
    fields: z
      .object({
        summary: z.string().nullish().catch(null),
        status: z
          .object({ name: z.string().nullish().catch(null), statusCategory: z.object({ key: z.unknown() }).nullish().catch(null) })
          .nullish()
          .catch(null),
      })
      .nullish()
      .catch(null),
  })
  .transform(
    ({ key, fields }): IssueSubtask => ({
      key,
      summary: fields?.summary ?? "",
      status: fields?.status?.name ?? null,
      category: CATEGORIES.find((c) => c === fields?.status?.statusCategory?.key) ?? null,
    }),
  );
const linkEntry = z.object({
  type: z.object({ inward: z.string(), outward: z.string() }),
  inwardIssue: issueRef.nullish(),
  outwardIssue: issueRef.nullish(),
});
// The status read and the transitions list have no other content, so a missing list is an error of kind shape.
const statusRead = z.object({ fields: z.object({ subtasks: z.array(z.unknown()) }) });
const transitionList = z.object({ transitions: z.array(z.unknown()) });
const transitionEntry = z.object({
  id: z.string().regex(TRANSITION_ID),
  name: z.string(),
  to: z.object({ name: z.string().nullish() }).nullish().catch(null),
});

// The entries of a list that parse. A value that is not an array gives [].
function entries<T extends z.ZodType>(list: unknown, schema: T): z.infer<T>[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => {
    const r = schema.safeParse(e);
    return r.success ? [r.data] : [];
  });
}

// Jira REST: an entry with inwardIssue reads "<this issue> <type.inward> <key>", one with outwardIssue "<this issue> <type.outward> <key>".
function linksOf(list: unknown, keep: ReadonlySet<string>): IssueLink[] {
  return entries(list, linkEntry).flatMap((l) => {
    if (l.inwardIssue && !l.outwardIssue && keep.has(l.inwardIssue.key)) return [{ text: l.type.inward, key: l.inwardIssue.key }];
    if (l.outwardIssue && !l.inwardIssue && keep.has(l.outwardIssue.key)) return [{ text: l.type.outward, key: l.outwardIssue.key }];
    return [];
  });
}

// Every 4xx and 5xx of the transition POST. A bad transition ID gives 400, 404, or 500 on Server and Data Center, and 400, 401, 404,
// 409, or 422 on Cloud. The message holds only the status and the issue key.
export class JiraRefusedError extends ContextError {
  constructor(issue: string, endpoint: string, status: number) {
    super("server", endpoint, status);
    this.name = "JiraRefusedError";
    this.message = `Jira refused the move (HTTP ${status}). Move ${issue} in Jira.`;
  }
}

// The body as text, or null when it passes MAX_BODY_BYTES.
async function readBody(res: Response): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = res.body?.getReader();
  if (!reader) return "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new TextDecoder().decode(Buffer.concat(chunks));
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

export type JiraOptions = {
  baseUrl: string;
  token: string;
  // Present: Jira Cloud, with Basic auth of email and API token. Absent: Server/Data Center, with the token as Bearer.
  email?: string;
  caFile?: string;
  timeoutMs?: number;
  convertMs?: { field: number; total: number };
};

function kindOf(status: number): ContextErrorKind {
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429 || status === 503) return "rate";
  return "server";
}

// A fetch or body read error as kind timeout or network, with the system error code only.
function failed(e: unknown, endpoint: string, timedOut: boolean): ContextError {
  const code = (e as { code?: unknown }).code;
  const safe = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
  return new ContextError(timedOut ? "timeout" : "network", endpoint, undefined, safe);
}

// check() throws it when the auth form does not match the deployment type. The message is a fixed sentence for the user.
export class JiraDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraDeploymentError";
  }
}

// Throws a plain Error for a bad URL scheme, and an fs error with a `code` for an unreadable CA file.
export function createJiraSource(opts: JiraOptions): ContextSource {
  const url = new URL(opts.baseUrl);
  // The token must not travel in clear text. Plain http is for the loopback test server only.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("The Jira URL must use https.");
  }
  const base = opts.baseUrl.replace(/\/+$/, "");
  const basePath = `${new URL(base).pathname.replace(/\/+$/, "")}/`;
  const ca = opts.caFile ? readFileSync(opts.caFile, "utf8") : undefined;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const convertMs = opts.convertMs ?? { field: CONVERT_FIELD_MS, total: CONVERT_TOTAL_MS };
  const cloud = opts.email !== undefined;
  const authorization = cloud ? `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString("base64")}` : `Bearer ${opts.token}`;

  // json: present sends a POST with this JSON body. Jira needs X-Atlassian-Token: no-check on a POST (XSRF check).
  async function call(path: string, json?: unknown): Promise<{ res: Response; text: string | null; endpoint: string }> {
    const endpoint = path.split("?")[0] ?? path;
    const target = new URL(base + path);
    if (target.origin !== url.origin) throw new ContextError("shape", endpoint);
    const post = json !== undefined;
    try {
      const res = await fetch(target, {
        method: post ? "POST" : "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(post ? { "Content-Type": "application/json", "X-Atlassian-Token": "no-check" } : {}),
        },
        body: post ? JSON.stringify(json) : undefined,
        tls: ca ? { ca } : undefined,
      });
      return { res, text: await readBody(res), endpoint };
    } catch (e) {
      throw failed(e, endpoint, (e as Error).name === "TimeoutError");
    }
  }

  async function get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    const { res, text, endpoint } = await call(path);
    if (res.status < 200 || res.status > 299) throw new ContextError(kindOf(res.status), endpoint, res.status);
    if (text === null) throw new ContextError("shape", endpoint, res.status);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ContextError("shape", endpoint, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ContextError("shape", endpoint, res.status);
    return parsed.data;
  }

  // scope: the read is a sub-task of scope.parent. Another parent gives null. links keep only the other sub-tasks of the parent:
  // scope.siblings, or the own sub-tasks without scope.
  async function read(key: string, scope?: { parent: string; siblings: readonly string[] }): Promise<IssueContext | null> {
    if (!JIRA_KEY.test(key)) throw new ContextError("not_found", "/rest/api/2/issue");
    const path = `/rest/api/2/issue/${encodeURIComponent(key)}`;
    const { fields, renderedFields } = await get(
      `${path}?fields=summary,description,status,attachment,parent,subtasks,issuelinks&expand=renderedFields`,
      issue,
    );
    const parent = issueRef.safeParse(fields.parent).data?.key ?? null;
    if (scope && parent !== scope.parent) return null;
    const subtasks = entries(fields.subtasks, subtaskEntry);
    const keep = new Set(scope ? scope.siblings : subtasks.map((s) => s.key));
    keep.delete(key);

    const raw: z.infer<typeof commentPage>["comments"] = [];
    let total = 0;
    let truncated = true;
    for (let i = 0, startAt = 0; i < MAX_PAGES; i++) {
      const page = await get(`${path}/comment?startAt=${startAt}&maxResults=${PAGE_SIZE}&expand=renderedBody`, commentPage);
      raw.push(...page.comments);
      total = page.total;
      startAt += page.comments.length;
      if (!page.comments.length || startAt >= page.total) {
        truncated = false;
        break;
      }
    }

    const cut = (s: string, max: number) => {
      if (s.length <= max) return s;
      truncated = true;
      return s.slice(0, max);
    };
    const converter = createConverter(base, convertMs.field, convertMs.total);
    // The rendered HTML as Markdown. A missing or too large rendered field, or a failed conversion, gives the wiki text.
    const markdown = async (html: string | null | undefined, wiki: string | null | undefined): Promise<string | null> => {
      const text = html != null && Buffer.byteLength(html) <= MAX_HTML_BYTES ? await converter.convert(html) : null;
      return text ?? (wiki ? fenced(wiki) : (wiki ?? null));
    };
    let description: string | null;
    const comments: IssueContext["comments"] = [];
    try {
      const text = await markdown(renderedFields?.description, fields.description);
      description = text == null ? null : cut(text, CAPS.description);
      let bytes = Buffer.byteLength(fields.summary) + Buffer.byteLength(description ?? "");
      if (raw.length > CAPS.comments) truncated = true;
      for (const c of raw.slice(0, CAPS.comments)) {
        const out = {
          author: c.author?.displayName || c.author?.name || "(unknown)",
          created: c.created ?? "",
          body: cut((await markdown(c.renderedBody, c.body)) ?? "", CAPS.comment),
        };
        bytes += Buffer.byteLength(out.author) + Buffer.byteLength(out.created) + Buffer.byteLength(out.body);
        if (bytes > CAPS.totalBytes) {
          truncated = true;
          break;
        }
        comments.push(out);
      }
    } finally {
      converter.close();
    }
    const attachments: AttachmentMeta[] = [];
    for (const a of fields.attachment ?? []) {
      if (attachments.length === MAX_ATTACHMENTS) break;
      const r = attachment.safeParse(a);
      if (r.success) attachments.push(r.data);
    }
    return {
      key,
      summary: fields.summary,
      status: fields.status?.name ?? null,
      description,
      comments,
      commentsTotal: total,
      truncated,
      format: "markdown",
      attachments,
      parent,
      subtasks,
      links: linksOf(fields.issuelinks, keep),
    };
  }

  return {
    ...JIRA,
    // serverInfo is optional: a failed read or an absent deploymentType does not block the check.
    async check() {
      const info = await get("/rest/api/2/serverInfo", serverInfo).catch(() => null);
      const type = info?.deploymentType;
      if (type === "Cloud" && !cloud)
        throw new JiraDeploymentError("This is Jira Cloud. Enter your Atlassian account email and an API token.");
      if (type && type !== "Cloud" && cloud)
        throw new JiraDeploymentError("This Jira is Server or Data Center. Use a personal access token and no email.");
      return get("/rest/api/2/myself", myself);
    },
    async fetchIssue(key) {
      return (await read(key)) as IssueContext;
    },
    fetchSubtask: (parent, siblings, key) => read(key, { parent, siblings }),
    async subtaskStatuses(parent) {
      if (!JIRA_KEY.test(parent)) throw new ContextError("not_found", "/rest/api/2/issue");
      const { fields } = await get(`/rest/api/2/issue/${encodeURIComponent(parent)}?fields=subtasks`, statusRead);
      return entries(fields.subtasks, subtaskEntry);
    },
    async transitions(key): Promise<JiraTransition[]> {
      if (!JIRA_KEY.test(key)) throw new ContextError("not_found", "/rest/api/2/issue");
      const body = await get(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, transitionList);
      return entries(body.transitions, transitionEntry).map((t) => ({ id: t.id, name: t.name, to: t.to?.name ?? null }));
    },
    // The key and ID checks keep the path fixed. No retry: a second POST can move the issue twice.
    async transition(key, id) {
      if (!JIRA_KEY.test(key) || !TRANSITION_ID.test(id)) throw new ContextError("not_found", "/rest/api/2/issue");
      const { res, endpoint } = await call(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } });
      if (res.status === 204) return;
      if (res.status >= 300 && res.status < 400) throw new ContextError("redirect", endpoint, res.status);
      if (res.status >= 400) throw new JiraRefusedError(key, endpoint, res.status);
      throw new ContextError("shape", endpoint, res.status);
    },
    // The path never comes from the server (the content URL is not used). A token never leaves the configured origin.
    // timeoutMs applies until the answer headers and then between two body chunks.
    async download(att, write) {
      const root = cloud ? CLOUD_ATTACHMENT_PATH : ATTACHMENT_PATH;
      if (!ATT_ID.test(att.id)) throw new ContextError("not_found", root);
      const endpoint = `${root}/${att.id}`;
      let target = new URL(cloud ? `${base}${endpoint}?redirect=false` : `${base}${endpoint}/${encodeURIComponent(att.filename)}`);
      for (let hop = 0; ; hop++) {
        if (target.origin !== url.origin || !target.pathname.startsWith(basePath)) throw new ContextError("redirect", endpoint);
        const abort = new AbortController();
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
          }, timeoutMs);
        };
        arm();
        try {
          let res: Response;
          try {
            res = await fetch(target, {
              method: "GET",
              redirect: "manual",
              signal: abort.signal,
              headers: { Authorization: authorization },
              tls: ca ? { ca } : undefined,
            });
          } catch (e) {
            throw failed(e, endpoint, timedOut);
          }
          if (res.status < 200 || res.status > 299) {
            await res.body?.cancel().catch(() => {});
            const to = res.headers.get("location");
            if (res.status < 300 || res.status > 399 || to === null || hop === MAX_HOPS)
              throw new ContextError(kindOf(res.status), endpoint, res.status);
            try {
              target = new URL(to, target);
            } catch {
              throw new ContextError("redirect", endpoint, res.status);
            }
            continue;
          }
          const reader = res.body?.getReader();
          let bytes = 0;
          try {
            for (;;) {
              const chunk = await reader?.read().catch((e) => {
                throw failed(e, endpoint, timedOut);
              });
              if (!chunk || chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > att.size) throw new ContextError("shape", endpoint, res.status);
              await write(chunk.value);
              arm();
            }
          } finally {
            await reader?.cancel().catch(() => {});
          }
          // An SSO login page with status 200 has another size.
          if (bytes !== att.size) throw new ContextError("shape", endpoint, res.status);
          return;
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}
