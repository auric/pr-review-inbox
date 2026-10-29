// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate J1 to J4 (WP-ST-G, docs/plans/review-v2/spec.md section 6.20.17): the Jira facts for sub-tasks.
// J1: the subtasks field with status.statusCategory, and the parent field of a sub-task. J2: the issuelinks shape.
// J3: the transitions list, the file links in comments, and the image src in the rendered HTML (U79).
// J1 to J3 send GET requests only. J4 sends one transition POST, only with --authorize-transition.
// Usage: bun run gate:jira -- --url <Jira base URL> --issue <PARENT KEY> [--email <email>] [--only J1,J2,J3]
//        bun run gate:jira -- --url <Jira base URL> --only J4 --transition-issue <KEY> --transition <id> --authorize-transition [--email <email>]
//        bun run gate:jira -- --dry-run
// --email: Jira Cloud (Basic auth of the email and an API token, REST v2). Absent: Server or Data Center (Bearer PAT).
// --dry-run: all checks, J4 included, against the fake Jira in Server mode and in Cloud mode. It reads no secret.
// Token: GATE_JIRA_TOKEN, else the stored app token ("jira-token"), only for the origin of the stored Jira URL.
// Console output and .gate0/jira/*.json hold only status codes, booleans, counts, key names, enum-like values, and URL shapes.
// A self-check exits 3 before any output when the text holds a sensitive value.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir } from "../../src/server/config";
import { JIRA_KEY } from "../../src/shared/dto";
import { clean, forms, leaks, type Needle } from "./ci";

const SERVICE = "review-loop";
const OUT = join(resolve(import.meta.dir, "../.."), ".gate0/jira");
const HTTP_TIMEOUT_MS = 30_000;
// The same cap as MAX_BODY_BYTES of src/server/context/jira.ts.
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// J1 and J2 read at most this many sub-tasks one by one.
const SUBTASK_READS = 5;
const COMMENT_LIMIT = 100;
const TRANSITION_ID = /^\d{1,10}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const CHECKS = ["J1", "J2", "J3", "J4"] as const;
type CheckId = (typeof CHECKS)[number];
const USAGE = [
  "usage: bun run gate:jira -- --url <Jira base URL> --issue <PARENT KEY> [--email <email>] [--only J1,J2,J3]",
  "       bun run gate:jira -- --url <Jira base URL> --only J4 --transition-issue <KEY> --transition <id> --authorize-transition [--email <email>]",
  "       bun run gate:jira -- --dry-run",
].join("\n");

function usage(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

type Status = "PASS" | "FAIL" | "INFO" | "SKIPPED";
export type Result = { check: string; status: Status; evidence: string };
export type Ctx = {
  base: string;
  token: string;
  // Present: Jira Cloud.
  email?: string;
  issue?: string;
  transitionIssue?: string;
  transition?: string;
  authorize: boolean;
  only: CheckId[];
  // A label in front of each evidence line, for the two dry-run modes.
  label?: string;
};

// ---------- sanitized output ----------
// Values that the output may show. Jira defines the status category keys and the deployment types. The link names are the
// defaults of a new Jira. A value outside these sets prints as <value>.
const CATEGORY_KEYS = new Set(["new", "indeterminate", "done", "undefined"]);
const DEPLOYMENTS = new Set(["Cloud", "Server", "DataCenter"]);
const LINK_NAMES = new Set([
  "Blocks",
  "blocks",
  "is blocked by",
  "Cloners",
  "clones",
  "is cloned by",
  "Duplicate",
  "duplicates",
  "is duplicated by",
  "Relates",
  "relates to",
]);
const SAFE = [...CATEGORY_KEYS, ...DEPLOYMENTS, ...LINK_NAMES].map((v) => v.toLowerCase());
// URL path segments that the output may show. Other segments print as <n> (digits) or <s>.
const SAFE_SEGMENTS = new Set([
  "secure",
  "attachment",
  "attachments",
  "thumbnail",
  "thumbnails",
  "rest",
  "api",
  "2",
  "3",
  "content",
  "images",
  "icons",
  "emoticons",
  "browse",
  "download",
  "media",
  "file",
  "image",
  "preview",
]);
const SAFE_QUERY = new Set(["redirect", "version", "modificationDate", "cacheVersion", "api"]);

const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : []);
const keyUnion = (items: unknown[]) => [...new Set(items.flatMap(keysOf))].sort().join(",") || "none";
const pick = (set: Set<string>, v: unknown) =>
  typeof v === "string" ? (set.has(v) ? v : "<value>") : v === undefined ? "absent" : "<value>";
const distinct = (items: string[]) => [...new Set(items)].sort().join(",") || "none";
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

// The shape of a link in rendered HTML: its origin relative to the Jira base, then the path with masked segments.
export function urlShape(raw: string, base: string): string {
  let u: URL;
  try {
    u = new URL(raw, `${base}/`);
  } catch {
    return "<not a URL>";
  }
  const b = new URL(base);
  if (!/^https?:$/.test(u.protocol)) return `<${/^[a-z]+:$/.test(u.protocol) ? u.protocol.slice(0, -1) : "scheme"}>`;
  const same = u.origin === b.origin;
  let path = u.pathname;
  const ctx = b.pathname.replace(/\/+$/, "");
  if (same && ctx && path.startsWith(`${ctx}/`)) path = path.slice(ctx.length);
  const segs = path
    .split("/")
    .filter(Boolean)
    .map((s) => (SAFE_SEGMENTS.has(s) ? s : /^\d+$/.test(s) ? "<n>" : "<s>"));
  const q = [...new Set([...u.searchParams.keys()].map((k) => (SAFE_QUERY.has(k) ? k : "<k>")))];
  return `${same ? (ctx ? "<ctx>" : "") : "<other origin>"}/${segs.join("/")}${q.length ? `?${q.join("&")}` : ""}`;
}
const LINK_RE = /<(a|img)\b[^>]*?\s(href|src)\s*=\s*["']([^"']*)["']/gi;
function links(html: unknown, base: string) {
  return typeof html !== "string"
    ? []
    : [...html.matchAll(LINK_RE)].map((m) => `${(m[1] ?? "").toLowerCase()} ${urlShape(m[3] ?? "", base)}`);
}

// Every string of a Jira body is a needle, except IDs, dates, the expand list, and the values that the output may show.
const SKIP_KEYS = new Set(["id", "expand", "created", "updated", "colorName", "startAt", "maxResults", "total", "mimeType", "size"]);
function collect(v: unknown, out: Set<string>, parent = "") {
  if (typeof v === "string") {
    if (v.length >= 3 && !SKIP_KEYS.has(parent) && !/^\d+$/.test(v) && !SAFE.includes(v.toLowerCase())) out.add(v);
  } else if (Array.isArray(v)) for (const x of v) collect(x, out, parent);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, out, k);
}

// ---------- HTTP ----------
type Call = { status: number; body: unknown };
type State = { bodies: unknown[]; posts: number };

function client(c: Ctx, st: State) {
  const origin = new URL(c.base).origin;
  // The same auth rule as createJiraSource: Basic with the email for Cloud, else the token as Bearer.
  const authorization = c.email ? `Basic ${Buffer.from(`${c.email}:${c.token}`).toString("base64")}` : `Bearer ${c.token}`;
  return async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Call> {
    const target = new URL(c.base + path);
    if (target.origin !== origin) return { status: 0, body: { network: "OtherOrigin" } };
    if (method === "POST") st.posts++;
    try {
      const res = await fetch(target, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json", "X-Atlassian-Token": "no-check" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown = null;
      if (text.length <= MAX_BODY_BYTES)
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
      st.bodies.push(json);
      return { status: res.status, body: json };
    } catch (e) {
      return { status: 0, body: { network: (e as Error).name } };
    }
  };
}

// ---------- checks ----------
type Run = { c: Ctx; st: State; call: ReturnType<typeof client>; parent: () => Promise<Call>; subtasks: () => Promise<Call[]> };
const issuePath = (k: string) => `/rest/api/2/issue/${encodeURIComponent(k)}`;
const http = (r: Call) => `HTTP ${r.status}`;

function category(status: unknown) {
  return obj(obj(status).statusCategory).key;
}

async function j1(r: Run): Promise<Result> {
  const p = await r.parent();
  if (p.status !== 200) return { check: "J1", status: "FAIL", evidence: `parent read: ${http(p)}` };
  const f = obj(obj(p.body).fields);
  const subs = arr(f.subtasks).map(obj);
  const typed = subs.filter((s) => typeof s.key === "string" && typeof category(obj(s.fields).status) === "string");
  const parentLine = `parent read: ${http(p)} fields keys=${keysOf(f).join(",") || "none"} subtasks is an array=${Array.isArray(f.subtasks)} count=${subs.length}; entry keys=${keyUnion(subs)} entry fields keys=${keyUnion(subs.map((s) => s.fields))} status keys=${keyUnion(subs.map((s) => obj(s.fields).status))} statusCategory keys=${keyUnion(subs.map((s) => obj(obj(s.fields).status).statusCategory))} with key and statusCategory.key=${typed.length} of ${subs.length} category keys=${distinct(subs.map((s) => pick(CATEGORY_KEYS, category(obj(s.fields).status))))}`;
  if (!Array.isArray(f.subtasks)) return { check: "J1", status: "FAIL", evidence: parentLine };
  if (!subs.length)
    return { check: "J1", status: "INFO", evidence: `${parentLine}. The issue has no subtask entries. Name a parent with sub-tasks.` };
  const reads = await r.subtasks();
  const parents = reads.map((s) => obj(obj(s.body).fields).parent).map(obj);
  const pointsBack = parents.filter((x) => x.key === r.c.issue).length;
  const same = reads.filter((s, i) => category(obj(obj(s.body).fields).status) === category(obj(subs[i]?.fields).status)).length;
  const pass = typed.length === subs.length && reads.every((s) => s.status === 200) && pointsBack === reads.length;
  return {
    check: "J1",
    status: pass ? "PASS" : "FAIL",
    evidence: `${parentLine}; subtask reads=${reads.length} HTTP=${distinct(reads.map((s) => String(s.status)))} parent keys=${keyUnion(parents)} parent fields keys=${keyUnion(parents.map((x) => x.fields))} parent.key is the issue=${pointsBack} of ${reads.length} parent status has statusCategory=${parents.filter((x) => typeof category(obj(x.fields).status) === "string").length} of ${reads.length}; same category in the entry and the own read=${same} of ${reads.length}`,
  };
}

function linkFacts(items: Obj[], siblings: Set<string>) {
  const type = items.map((l) => obj(l.type));
  const linked = items.map((l) => obj(l.inwardIssue ?? l.outwardIssue));
  const typed = items.filter((_, i) => {
    const t = type[i] ?? {};
    return typeof t.inward === "string" && typeof t.outward === "string" && typeof linked[i]?.key === "string";
  });
  return {
    ok: typed.length === items.length,
    line: `count=${items.length} link keys=${keyUnion(items)} type keys=${keyUnion(type)} type names=${distinct(type.map((t) => pick(LINK_NAMES, t.name)))} inward=${distinct(type.map((t) => pick(LINK_NAMES, t.inward)))} outward=${distinct(type.map((t) => pick(LINK_NAMES, t.outward)))} with inwardIssue=${items.filter((l) => l.inwardIssue).length} with outwardIssue=${items.filter((l) => l.outwardIssue).length} linked issue keys=${keyUnion(linked)} linked fields keys=${keyUnion(linked.map((x) => x.fields))} linked status has statusCategory=${linked.filter((x) => typeof category(obj(x.fields).status) === "string").length} complete=${typed.length} of ${items.length} to a sibling subtask=${linked.filter((x) => siblings.has(String(x.key))).length}`,
  };
}

async function j2(r: Run): Promise<Result> {
  const p = await r.parent();
  if (p.status !== 200) return { check: "J2", status: "FAIL", evidence: `parent read: ${http(p)}` };
  const f = obj(obj(p.body).fields);
  const siblings = new Set(arr(f.subtasks).map((s) => String(obj(s).key)));
  const own = linkFacts(arr(f.issuelinks).map(obj), siblings);
  const reads = await r.subtasks();
  const subLinks = reads.flatMap((s) => arr(obj(obj(s.body).fields).issuelinks).map(obj));
  const sub = linkFacts(subLinks, siblings);
  const isArray = Array.isArray(f.issuelinks) && reads.every((s) => Array.isArray(obj(obj(s.body).fields).issuelinks));
  const evidence = `parent issuelinks is an array=${Array.isArray(f.issuelinks)} ${own.line}; subtask reads=${reads.length} issuelinks are arrays=${reads.every((s) => Array.isArray(obj(obj(s.body).fields).issuelinks))} ${sub.line}`;
  if (!isArray || !own.ok || !sub.ok) return { check: "J2", status: "FAIL", evidence };
  if (!subLinks.length && !arr(f.issuelinks).length)
    return { check: "J2", status: "INFO", evidence: `${evidence}. No links found. Link two sub-tasks of the parent and run again.` };
  return { check: "J2", status: "PASS", evidence };
}

function transitionFacts(t: Call) {
  const list = arr(obj(t.body).transitions).map(obj);
  const typed = list.filter((x) => typeof x.id === "string" && TRANSITION_ID.test(x.id) && typeof x.name === "string" && x.to);
  return {
    list,
    ok: t.status === 200 && Array.isArray(obj(t.body).transitions) && typed.length === list.length,
    line: `${http(t)} keys=${keysOf(t.body).join(",") || "none"} count=${list.length} transition keys=${keyUnion(list)} numeric id and name and to=${typed.length} of ${list.length} to keys=${keyUnion(list.map((x) => x.to))} to categories=${distinct(list.map((x) => pick(CATEGORY_KEYS, category(x.to))))} hasScreen true=${list.filter((x) => x.hasScreen === true).length}`,
  };
}

async function j3(r: Run): Promise<Result> {
  const issue = r.c.issue as string;
  const t = transitionFacts(await r.call("GET", `${issuePath(issue)}/transitions`));
  const p = await r.parent();
  const rendered = obj(obj(p.body).renderedFields);
  const desc = links(rendered.description, r.c.base);
  const cm = await r.call("GET", `${issuePath(issue)}/comment?startAt=0&maxResults=${COMMENT_LIMIT}&expand=renderedBody`);
  const comments = arr(obj(cm.body).comments).map(obj);
  const bodies = comments.map((x) => (typeof x.body === "string" ? x.body : ""));
  const fileMarkup = bodies.filter((b) => /\[\^[^\]]+\]/.test(b)).length;
  const imageMarkup = bodies.filter((b) => /![^!\s][^!]*!/.test(b)).length;
  const commentLinks = comments.flatMap((x) => links(x.renderedBody, r.c.base));
  const fileLinks = commentLinks.filter((l) => l.startsWith("a ") && /attachment/.test(l));
  return {
    check: "J3",
    status: t.ok ? "PASS" : "FAIL",
    evidence: `transitions: ${t.line}; comments: ${http(cm)} count=${comments.length} comment keys=${keyUnion(comments)} body is a string=${comments.filter((x) => typeof x.body === "string").length} of ${comments.length} with [^file] markup=${fileMarkup} with !image! markup=${imageMarkup} renderedBody is a string=${comments.filter((x) => typeof x.renderedBody === "string").length}; comment file link shapes=${distinct(fileLinks)}${fileLinks.length ? "" : " (none: add a comment with a non-image attachment link)"}; all comment link shapes=${distinct(commentLinks)}; rendered description link shapes=${distinct(desc)}`,
  };
}

async function j4(r: Run): Promise<Result> {
  if (!r.c.authorize)
    return {
      check: "J4",
      status: "SKIPPED",
      evidence: "No --authorize-transition. Nothing was sent. J4 POSTs one transition on a test issue.",
    };
  const k = r.c.transitionIssue as string;
  const id = r.c.transition as string;
  const statusRead = async () => category(obj(obj((await r.call("GET", `${issuePath(k)}?fields=status`)).body).fields).status);
  const before = await statusRead();
  const t = transitionFacts(await r.call("GET", `${issuePath(k)}/transitions`));
  if (!t.list.some((x) => x.id === id))
    return { check: "J4", status: "FAIL", evidence: `transitions: ${t.line}; the --transition ID is not in the list. Nothing was sent.` };
  const post = await r.call("POST", `${issuePath(k)}/transitions`, { transition: { id } });
  const after = await statusRead();
  const target = category(t.list.find((x) => x.id === id)?.to);
  const errors = obj(post.body);
  return {
    check: "J4",
    status: post.status === 204 ? "PASS" : "FAIL",
    evidence: `transitions: ${t.line}; POST with JSON and X-Atlassian-Token no-check: ${http(post)} body keys=${keysOf(post.body).join(",") || "none"} errorMessages=${arr(errors.errorMessages).length} errors keys count=${keysOf(errors.errors).length}; category before=${pick(CATEGORY_KEYS, before)} after=${pick(CATEGORY_KEYS, after)} transition target=${pick(CATEGORY_KEYS, target)} reached the target=${after === target}`,
  };
}

const RUNNERS: Record<CheckId, (r: Run) => Promise<Result>> = { J1: j1, J2: j2, J3: j3, J4: j4 };

function needlesOf(c: Ctx, st: State): Needle[] {
  const out: Needle[] = [];
  const add = (kind: string, v: string | undefined) => {
    if (v) for (const f of forms(v)) out.push({ kind, value: f });
  };
  const u = new URL(c.base);
  add("Jira URL", c.base);
  add("Jira URL", u.origin);
  add("Jira host", u.host);
  add("Jira host", u.hostname);
  if (u.pathname.replace(/\/+$/, "")) add("Jira context path", u.pathname.replace(/\/+$/, ""));
  add("token", c.token);
  add("email", c.email);
  if (c.email) add("Basic auth", Buffer.from(`${c.email}:${c.token}`).toString("base64"));
  for (const k of [c.issue, c.transitionIssue]) {
    add("issue key", k);
    add("project key", k?.split("-")[0]);
  }
  const strings = new Set<string>();
  for (const b of st.bodies) collect(b, strings);
  for (const s of strings) {
    add("Jira value", s);
    // A Jira key also names its project.
    if (JIRA_KEY.test(s)) add("project key", s.split("-")[0]);
  }
  return out;
}

// Runs the selected checks. The results are already masked. needles: the sensitive values for the self-check.
export async function runChecks(c: Ctx): Promise<{ results: Result[]; needles: Needle[]; posts: number }> {
  const st: State = { bodies: [], posts: 0 };
  const call = client(c, st);
  const memo = <T>(fn: () => Promise<T>) => {
    let p: Promise<T> | undefined;
    return () => {
      p ??= fn();
      return p;
    };
  };
  // The read of "Read the task" (subtasks plan section 4), with the sub-task fields added.
  const parent = memo(() =>
    call("GET", `${issuePath(c.issue ?? "")}?fields=summary,description,status,attachment,subtasks,issuelinks&expand=renderedFields`),
  );
  const subtasks = memo(async () => {
    const keys = arr(obj(obj((await parent()).body).fields).subtasks)
      .map((s) => obj(s).key)
      .filter((k): k is string => typeof k === "string" && JIRA_KEY.test(k))
      .slice(0, SUBTASK_READS);
    const out: Call[] = [];
    for (const k of keys) out.push(await call("GET", `${issuePath(k)}?fields=summary,status,parent,issuelinks`));
    return out;
  });
  const run: Run = { c, st, call, parent, subtasks };
  const results: Result[] = [];
  for (const id of c.only) {
    try {
      results.push(await RUNNERS[id](run));
    } catch (e) {
      // Only the error class: a message can quote a URL or a value.
      results.push({ check: id, status: "FAIL", evidence: `exception: ${(e as Error).name}` });
    }
  }
  const needles = needlesOf(c, st);
  for (const r of results) r.evidence = clean(`${c.label ? `[${c.label}] ` : ""}${r.evidence}`, needles);
  return { results, needles, posts: st.posts };
}

// ---------- dry run ----------
// The fake Jira: parent ABC-17 with sub-tasks ABC-18 (done), ABC-19 (in progress), and ABC-20 (to do). ABC-20 is blocked by ABC-19.
export async function dryRun(opts: { cloud: boolean; authorize: boolean }) {
  const { JIRA_EMAIL, JIRA_TOKEN, startFakeJira } = await import("../../tests/support/fake-jira");
  const jira = startFakeJira({ cloud: opts.cloud });
  jira.addSubtasks(
    "ABC-17",
    [
      { key: "ABC-18", summary: "Batch the cache writes", category: "done" },
      { key: "ABC-19", summary: "Flush before the write lock", category: "indeterminate" },
      { key: "ABC-20", summary: "Measure the lock wait", category: "new" },
    ],
    [["ABC-20", "ABC-19"]],
  );
  const ctx: Ctx = {
    base: jira.url,
    token: JIRA_TOKEN,
    email: opts.cloud ? JIRA_EMAIL : undefined,
    issue: "ABC-17",
    transitionIssue: "ABC-20",
    transition: "21",
    authorize: opts.authorize,
    only: [...CHECKS],
    label: opts.cloud ? "cloud" : "server",
  };
  return { ctx, jira, stop: () => jira.stop() };
}

// ---------- main ----------
function parseArgs(argv: string[]) {
  const FLAGS = new Set(["--dry-run", "--authorize-transition"]);
  const VALUES = new Set(["--url", "--issue", "--email", "--only", "--transition-issue", "--transition"]);
  const flags = new Set<string>();
  const opt: Record<string, string> = {};
  const only = new Set<CheckId>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (FLAGS.has(a)) flags.add(a);
    else if (VALUES.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} needs a value.`);
      if (a === "--only")
        for (const id of v.split(",").map((s) => s.trim().toUpperCase())) {
          if (!(CHECKS as readonly string[]).includes(id)) usage(`unknown check: ${id}. Use one of ${CHECKS.join(", ")}.`);
          only.add(id as CheckId);
        }
      else opt[a] = v;
    } else usage(`unknown argument: ${a}`);
  }
  return { flags, opt, only: CHECKS.filter((c) => only.size === 0 || only.has(c)) };
}

function jiraBase(v: string) {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    usage("--url is not a URL.");
  }
  // The token must not travel in clear text. Plain http is for a loopback test server only.
  if (!(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))))
    usage("--url needs https, or http on a loopback host.");
  if (u.username || u.password || u.search || u.hash) usage("--url needs a URL without user info, query, or fragment.");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

// The Jira URL of the app config. Read only: readConfig of src/server/config.ts can write backup files.
function storedJiraUrl(): string | null {
  const file = join(dataDir(), "config.json");
  if (!existsSync(file)) return null;
  try {
    const url = obj(obj(JSON.parse(readFileSync(file, "utf8"))).jira).baseUrl;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

async function liveCtx(flags: Set<string>, opt: Record<string, string>, only: CheckId[]): Promise<Ctx> {
  if (!opt["--url"]) usage("--url is required: the Jira base URL.");
  const base = jiraBase(opt["--url"]);
  const reads = only.some((c) => c !== "J4");
  const issue = opt["--issue"];
  if (reads && !JIRA_KEY.test(issue ?? "")) usage("J1 to J3 need --issue <KEY-123>: a parent issue with sub-tasks.");
  const authorize = flags.has("--authorize-transition");
  if (authorize && !only.includes("J4")) usage("--authorize-transition needs J4 in --only.");
  if (only.includes("J4") && authorize) {
    if (!JIRA_KEY.test(opt["--transition-issue"] ?? "")) usage("J4 needs --transition-issue <KEY-123>: a test issue that you may move.");
    if (!TRANSITION_ID.test(opt["--transition"] ?? "")) usage("J4 needs --transition <id>: a numeric transition ID of that issue.");
  }
  const email = opt["--email"];
  if (email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(email)) usage("--email is not an email address.");
  let token = process.env.GATE_JIRA_TOKEN;
  if (!token) {
    const stored = storedJiraUrl();
    token = (await Bun.secrets.get({ service: SERVICE, name: "jira-token" })) ?? undefined;
    if (!token) usage("No token. Set GATE_JIRA_TOKEN, or connect Jira in the app first.");
    if (!stored || new URL(stored).origin !== new URL(base).origin)
      usage("Refused: the stored Jira token belongs to another server, or no Jira URL is stored. Set GATE_JIRA_TOKEN for this server.");
  }
  return { base, token, email, issue, transitionIssue: opt["--transition-issue"], transition: opt["--transition"], authorize, only };
}

// serverInfo allows anonymous access. A deployment that does not match the auth stops the run, as the app check does.
async function deployment(c: Ctx): Promise<string> {
  const st: State = { bodies: [], posts: 0 };
  const r = await client(c, st)("GET", "/rest/api/2/serverInfo");
  const type = obj(r.body).deploymentType;
  if (type === "Cloud" && !c.email) usage("This is Jira Cloud. Add --email <your Atlassian account email> and use an API token.");
  if (typeof type === "string" && type !== "Cloud" && c.email)
    usage("This Jira is Server or Data Center. Use a personal access token and no --email.");
  return `serverInfo ${http(r)} deploymentType=${pick(DEPLOYMENTS, type)} auth=${c.email ? "Basic" : "Bearer"}`;
}

async function main() {
  const { flags, opt, only } = parseArgs(process.argv.slice(2));
  const dry = flags.has("--dry-run");
  const results: Result[] = [];
  const needles: Needle[] = [];
  const header: string[] = [];
  if (dry) {
    if (Object.keys(opt).length) usage("--dry-run takes no values.");
    for (const cloud of [false, true]) {
      const d = await dryRun({ cloud, authorize: true });
      d.ctx.only = only;
      try {
        header.push(`[${d.ctx.label}] ${await deployment(d.ctx)}`);
        const out = await runChecks(d.ctx);
        results.push(...out.results);
        needles.push(...out.needles);
      } finally {
        d.stop();
      }
    }
  } else {
    const c = await liveCtx(flags, opt, only);
    header.push(await deployment(c));
    const out = await runChecks(c);
    results.push(...out.results);
    needles.push(...out.needles);
  }
  const head = header.map((h) => clean(h, needles));
  const lines = results.map((r) => `${r.status.padEnd(7)} ${r.check} ${r.evidence}`);
  const file = dry ? "result.dry-run.json" : "result.json";
  const json = `${JSON.stringify({ at: new Date().toISOString(), mode: dry ? "dry-run" : "run", header: head, results }, null, 2)}\n`;
  const problems = leaks([...head, ...lines, json], needles);
  if (problems.length) {
    console.error(`self-check failed: the output holds a value of kind: ${problems.join(", ")}. Nothing was printed or written.`);
    process.exit(3);
  }
  if (dry) console.log("[dry run: fake Jira in Server mode and in Cloud mode, no secret read]");
  for (const l of [...head, ...lines]) console.log(l);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, file), json);
  console.log(`Recorded in .gate0/jira/${file}.`);
  const failed = results.some((r) => r.status === "FAIL");
  if (dry) console.log(failed ? "dry run: FAIL" : "dry run: PASS");
  else console.log("Copy the lines above into the J1 to J4 rows of integration-check.md.");
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) await main();
