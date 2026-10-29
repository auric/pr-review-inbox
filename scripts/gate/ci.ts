// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate CI1 to CI11 (WP-CI0, the CI builds plan): the Bitbucket build status facts and the Jenkins multibranch facts.
// CI1 to CI8 send GET requests only. CI9 sends POST api/json?tree=_class, which starts nothing.
// CI10 starts one build, only with --authorize-build. CI11 scans the multibranch project, only with --authorize-scan.
// A scan can start builds of other changed branches. Run CI11 only on a project where that is allowed.
// Usage: bun run gate:ci -- <PR URL> [--jenkins <base URL>] [--jenkins-user <user>] [--job <folder/project>] [--authorize-build] [--authorize-scan]
//        bun run gate:ci -- --dry-run
// --dry-run: all checks, CI10 and CI11 included, against a loopback fake Bitbucket and a fake Jenkins. It reads no secret.
// Tokens: Bitbucket uses GATE_BITBUCKET_TOKEN, else the token of scripts/gate0/set-token.ts, only for the stored URL origin.
// Jenkins uses only GATE_JENKINS_TOKEN. The Jenkins token goes only to the --jenkins origin.
// Console output and .gate0/ci/*.json hold only status codes, booleans, counts, key names, enum-like states, Jenkins class names, and the version.
// A self-check exits 3 before any output when the text holds a sensitive value.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePrUrl } from "../../src/shared/pr-url";

const SERVICE = "review-loop";
const OUT = join(resolve(import.meta.dir, "../.."), ".gate0/ci");
const HTTP_TIMEOUT_MS = 30_000;
const POLL_MS = 3_000;
const BUILD_WAIT_MS = 5 * 60_000;
const SCAN_WAIT_MS = 3 * 60_000;
// After a new job appears, CI11 waits this long for a build that the scan queued.
const AUTO_BUILD_WAIT_MS = 30_000;
// The page size of the status list that Layer A reads.
const STATUS_LIMIT = 25;
// The plan has no CI4.
const CHECKS = ["CI1", "CI2", "CI3", "CI5", "CI6", "CI7", "CI8", "CI9", "CI10", "CI11"] as const;
const USAGE = [
  "usage: bun run gate:ci -- <PR URL> [--jenkins <base URL>] [--jenkins-user <user>] [--job <folder/project>]",
  "         [--authorize-build] [--authorize-scan]",
  "       bun run gate:ci -- --dry-run",
  "Tokens: GATE_BITBUCKET_TOKEN (else the stored token), GATE_JENKINS_TOKEN (needed with --jenkins).",
].join("\n");

function usage(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

type Status = "PASS" | "FAIL" | "INFO" | "SKIPPED";
export type Result = { check: string; status: Status; evidence: string };
type Call = { status: number; body: unknown; headers: Headers };
export type Ctx = {
  bitbucket: { base: string; project: string; repo: string; id: number; token: string };
  // Absent: CI5 to CI11 are skipped.
  jenkins?: { base: string; user: string; token: string };
  // The multibranch project path from --job, as job names.
  job?: string[];
  build: boolean;
  scan: boolean;
  pollMs: number;
};
// The facts that one check finds and a later check uses. They are sensitive and never printed.
type State = {
  branch?: string;
  head?: string;
  users: string[];
  jobPath?: string[];
  jobPathFrom: "--job" | "CI3" | "none";
  jobs?: string[];
  target?: string;
  buildable?: unknown;
  params: number;
  // undefined: not read. null: CSRF protection is off.
  crumb?: { field: string; value: string; cookie?: string } | null;
};

// ---------- sanitized values ----------
const SHA = /^[0-9a-f]{40}$/i;
const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : []);
const enumLike = (v: unknown) => (typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v) ? v : v === undefined ? "absent" : "<value>");
const className = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_.$]+$/.test(v) ? v : v === undefined ? "absent" : "<value>");
const bool = (v: unknown) => (typeof v === "boolean" ? String(v) : v === undefined ? "absent" : "<value>");
const num = (v: unknown) => (typeof v === "number" ? String(v) : "absent");
const valuesOf = (body: unknown) => {
  const v = (body as { values?: unknown } | null)?.values;
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
};
const words = (s: number) =>
  s === 200
    ? "ok"
    : s === 201
      ? "created"
      : s === 401
        ? "login rejected"
        : s === 403
          ? "login accepted, no permission"
          : s === 404
            ? "not found"
            : s >= 300 && s < 400
              ? "redirect"
              : s === 0
                ? "no answer"
                : "other";
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};
const jobUrl = (names: string[]) => names.map((n) => `/job/${encodeURIComponent(n)}`).join("");

// Every form in which a value can show in a URL: raw, encoded once or twice, and the NameEncoder %2F and %252F forms.
export function forms(v: string): string[] {
  return [
    ...new Set([v, encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v)), v.replaceAll("/", "%2F"), v.replaceAll("/", "%252F")]),
  ];
}
// A match must not touch a letter or digit, so a short name such as "ci" does not match inside "CI1".
const pattern = (needle: string) => new RegExp(`(?<![A-Za-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi");
export type Needle = { kind: string; value: string };
export function clean(text: string, needles: Needle[]): string {
  let out = text;
  for (const n of [...needles].sort((a, b) => b.value.length - a.value.length)) out = out.replace(pattern(n.value), "<masked>");
  return out;
}
// Returns the kinds of the sensitive values that the text still holds.
export function leaks(texts: string[], needles: Needle[]): string[] {
  return [...new Set(needles.filter((n) => texts.some((t) => pattern(n.value).test(t))).map((n) => n.kind))].sort();
}
function needlesOf(c: Ctx, st: State): Needle[] {
  const out: Needle[] = [];
  const add = (kind: string, v: string | undefined) => {
    if (v) for (const f of forms(v)) out.push({ kind, value: f });
  };
  for (const [kind, base] of [
    ["Bitbucket URL", c.bitbucket.base],
    ["Jenkins URL", c.jenkins?.base],
  ] as const) {
    if (!base) continue;
    const u = new URL(base);
    add(kind, base);
    add(kind, u.host);
    add(kind, u.hostname);
  }
  add("project", c.bitbucket.project);
  add("repo", c.bitbucket.repo);
  add("branch", st.branch);
  add("commit", st.head);
  for (const s of [...(c.job ?? []), ...(st.jobPath ?? [])]) add("job segment", s);
  if (st.target && !/^PR-\d+$/.test(st.target)) add("job segment", st.target);
  add("user", c.jenkins?.user);
  for (const u of st.users) add("user", u);
  add("token", c.bitbucket.token);
  add("token", c.jenkins?.token);
  add("token", st.crumb?.value);
  add("token", st.crumb?.cookie);
  add("token", st.crumb?.cookie?.split("=").slice(1).join("="));
  return out;
}

// ---------- HTTP ----------
async function request(url: string, method: "GET" | "POST", headers: Record<string, string>): Promise<Call> {
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { Accept: "application/json", ...headers },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body, headers: res.headers };
  } catch (e) {
    return { status: 0, body: { network: (e as Error).name }, headers: new Headers() };
  }
}
const bb = (c: Ctx, path: string) => request(c.bitbucket.base + path, "GET", { Authorization: `Bearer ${c.bitbucket.token}` });
function jk(c: Ctx, st: State, path: string, method: "GET" | "POST" = "GET", crumb = true) {
  const j = c.jenkins;
  if (!j) throw new Error("no Jenkins");
  const headers: Record<string, string> = { Authorization: `Basic ${btoa(`${j.user}:${j.token}`)}` };
  if (method === "POST" && crumb && st.crumb) {
    headers[st.crumb.field] = st.crumb.value;
    if (st.crumb.cookie) headers.Cookie = st.crumb.cookie;
  }
  return request(j.base + path, method, headers);
}
const skip = (check: string, why: string): Result => ({ check, status: "SKIPPED", evidence: why });
// The multibranch project path: --job first, else the path that CI3 read from a status URL.
const projectPath = (c: Ctx, st: State) => {
  const names = c.job ?? st.jobPath;
  return names?.length ? jobUrl(names) : undefined;
};
const prJob = (c: Ctx) => `PR-${c.bitbucket.id}`;
const isBranchJob = (st: State, name: string) => st.branch !== undefined && decode(name) === st.branch;
const namesOf = (body: unknown) =>
  ((body as { jobs?: { name?: unknown }[] } | null)?.jobs ?? []).map((j) => j.name).filter((n): n is string => typeof n === "string");

// ---------- Bitbucket ----------
async function ci1(c: Ctx, st: State): Promise<Result> {
  const b = c.bitbucket;
  const r = await bb(
    c,
    `/rest/api/1.0/projects/${encodeURIComponent(b.project)}/repos/${encodeURIComponent(b.repo)}/pull-requests/${b.id}`,
  );
  const user = r.headers.get("x-ausername");
  if (user) st.users.push(user);
  const pr = r.body as {
    state?: unknown;
    fromRef?: { displayId?: unknown; latestCommit?: unknown; repository?: { slug?: unknown; project?: { key?: unknown } } };
  } | null;
  const head = pr?.fromRef?.latestCommit;
  const branch = pr?.fromRef?.displayId;
  if (typeof head === "string" && SHA.test(head)) st.head = head;
  if (typeof branch === "string" && branch) st.branch = branch;
  const same = pr?.fromRef?.repository?.slug === b.repo && pr?.fromRef?.repository?.project?.key === b.project;
  return {
    check: "CI1",
    status: r.status === 200 && st.head && st.branch ? "PASS" : "FAIL",
    evidence: `PR GET: HTTP ${r.status} state=${enumLike(pr?.state)} head present=${!!st.head} branch present=${!!st.branch} source in the same repository=${same}`,
  };
}

const STAT_KEYS = ["successful", "inProgress", "failed", "cancelled", "unknown"];
async function ci2(c: Ctx, st: State): Promise<Result> {
  if (!st.head) return skip("CI2", "no head commit (CI1)");
  const r = await bb(c, `/rest/build-status/1.0/commits/stats/${st.head}`);
  const b = (r.body ?? {}) as Record<string, unknown>;
  const ok = r.status === 200 && ["successful", "inProgress", "failed"].every((k) => typeof b[k] === "number");
  return {
    check: "CI2",
    status: ok ? "PASS" : "FAIL",
    evidence: `stats GET: HTTP ${r.status} keys=${keysOf(r.body).join(",") || "none"} ${STAT_KEYS.map((k) => `${k}=${num(b[k])}`).join(" ")}`,
  };
}

// The path of a status URL with names replaced: /job/<s>/job/<s>/<n>/display/redirect. <ctx> is the --jenkins context path.
function pathShape(u: URL, ctxPath: string | undefined) {
  const inCtx = ctxPath !== undefined && (ctxPath === "" || u.pathname.startsWith(`${ctxPath}/`));
  const rest = inCtx ? u.pathname.slice(ctxPath.length) : u.pathname;
  const shape = rest
    .split("/")
    .map((s) => (s === "" || ["job", "display", "redirect"].includes(s) ? s : /^\d+$/.test(s) ? "<n>" : "<s>"))
    .join("/");
  return (inCtx && ctxPath ? "<ctx>" : "") + shape;
}
// The job names of /job/<a>/job/<b>/... at the start of the path, decoded once, and the kind of the last one.
function jobNames(u: URL, ctxPath: string, c: Ctx, st: State) {
  const parts = u.pathname.slice(ctxPath.length).split("/").slice(1);
  const names: string[] = [];
  while (parts[0] === "job" && parts[1]) {
    const n = decode(parts[1]);
    if (n === null) break;
    names.push(n);
    parts.splice(0, 2);
  }
  const last = names.at(-1);
  const kind = last === undefined ? "none" : last === prJob(c) ? "PR-id" : isBranchJob(st, last) ? "branch" : "other";
  return { names, kind };
}

async function ci3(c: Ctx, st: State): Promise<Result> {
  if (!st.head) return skip("CI3", "no head commit (CI1)");
  const r = await bb(c, `/rest/build-status/latest/commits/${st.head}?limit=${STATUS_LIMIT}`);
  const values = valuesOf(r.body);
  const jenkins = c.jenkins ? new URL(c.jenkins.base) : undefined;
  const ctxPath = jenkins?.pathname.replace(/\/$/, "");
  const keyIds = new Map<string, string>();
  const states = new Map<string, number>();
  const rows: string[] = [];
  for (const v of values) {
    const key = typeof v.key === "string" ? v.key : "";
    if (!keyIds.has(key)) keyIds.set(key, key ? `k${keyIds.size + 1}` : "k?");
    const state = enumLike(v.state);
    states.set(state, (states.get(state) ?? 0) + 1);
    let url = "url=absent";
    if (typeof v.url === "string") {
      let u: URL | undefined;
      try {
        u = new URL(v.url);
      } catch {}
      if (!u || !/^https?:$/.test(u.protocol)) url = "url=not http(s)";
      else {
        const same = jenkins ? u.origin === jenkins.origin : undefined;
        const { names, kind } = same && ctxPath !== undefined ? jobNames(u, ctxPath, c, st) : { names: [], kind: "n/a" };
        if (same && !c.job && !st.jobPath && names.length > 1) {
          st.jobPath = names.slice(0, -1);
          st.jobPathFrom = "CI3";
        }
        url = `same origin as --jenkins=${same ?? "n/a"} shape=${pathShape(u, same ? ctxPath : undefined)} last job=${kind} display/redirect=${/\/display\/redirect\/?$/.test(u.pathname)}`;
      }
    }
    rows.push(
      `${keyIds.get(key)}: state=${state} ${url} buildNumber present=${v.buildNumber !== undefined} ref present=${v.ref !== undefined}`,
    );
  }
  const keyUnion = [...new Set(values.flatMap(keysOf))].sort().join(",") || "none";
  const stateText = [...states].map(([s, n]) => `${s}:${n}`).join(",") || "none";
  return {
    check: "CI3",
    status: r.status === 200 && Array.isArray((r.body as { values?: unknown } | null)?.values) ? "PASS" : "FAIL",
    evidence: `list GET: HTTP ${r.status} count=${values.length} isLastPage=${bool((r.body as { isLastPage?: unknown } | null)?.isLastPage)} keys=${keyUnion} states=${stateText}${rows.length ? `; ${rows.join("; ")}` : ""}`,
  };
}

// ---------- Jenkins ----------
async function ci5(c: Ctx, st: State): Promise<Result> {
  if (!c.jenkins) return skip("CI5", "no --jenkins");
  const r = await jk(c, st, "/whoAmI/api/json");
  const b = (r.body ?? {}) as { _class?: unknown; name?: unknown; authenticated?: unknown; anonymous?: unknown };
  if (typeof b.name === "string" && b.name) st.users.push(b.name);
  const v = r.headers.get("x-jenkins");
  const version = v === null ? "absent" : /^\d[0-9A-Za-z.+-]*$/.test(v) ? v : "<value>";
  return {
    check: "CI5",
    status: r.status === 200 && b.authenticated === true && b.anonymous === false ? "PASS" : "FAIL",
    evidence: `whoAmI GET: HTTP ${r.status} (${words(r.status)}) _class=${className(b._class)} authenticated=${bool(b.authenticated)} anonymous=${bool(b.anonymous)} name equals --jenkins-user=${b.name === c.jenkins.user} version=${version}`,
  };
}

async function ci6(c: Ctx, st: State): Promise<Result> {
  if (!c.jenkins) return skip("CI6", "no --jenkins");
  const r = await jk(c, st, "/crumbIssuer/api/json");
  const b = (r.body ?? {}) as { crumb?: unknown; crumbRequestField?: unknown };
  const cookies = r.headers.getSetCookie();
  // The crumb is bound to the web session, so the POST sends back the name=value part of the cookie.
  const cookie = cookies[0]?.split(";")[0]?.trim();
  if (r.status === 404) st.crumb = null;
  const field = typeof b.crumbRequestField === "string" && /^[A-Za-z0-9._-]+$/.test(b.crumbRequestField) ? b.crumbRequestField : undefined;
  if (r.status === 200 && field && typeof b.crumb === "string") st.crumb = { field, value: b.crumb, cookie };
  return {
    check: "CI6",
    status: r.status === 404 || (r.status === 200 && st.crumb) ? "PASS" : "FAIL",
    evidence: `crumbIssuer GET: HTTP ${r.status} (${r.status === 404 ? "CSRF protection off" : words(r.status)}) field=${field ?? "absent"} crumb present=${typeof b.crumb === "string"} Set-Cookie present=${cookies.length > 0}`,
  };
}

async function ci7(c: Ctx, st: State): Promise<Result> {
  if (!c.jenkins) return skip("CI7", "no --jenkins");
  if (c.job) st.jobPathFrom = "--job";
  const p = projectPath(c, st);
  if (!p) return skip("CI7", "no project path: CI3 found no status URL with the Jenkins origin. Give --job <folder/project>.");
  const r = await jk(c, st, `${p}/api/json?tree=_class,buildable,jobs[name]`);
  const b = (r.body ?? {}) as { _class?: unknown; buildable?: unknown };
  const names = namesOf(r.body);
  if (r.status === 200) st.jobs = names;
  const pr = names.includes(prJob(c));
  const branch = names.find((n) => isBranchJob(st, n));
  st.target = pr ? prJob(c) : branch;
  const multibranch = typeof b._class === "string" && /MultiBranchProject$/.test(b._class);
  return {
    check: "CI7",
    status: r.status === 200 && multibranch ? "PASS" : "FAIL",
    evidence: `project GET (path from ${st.jobPathFrom}, ${(c.job ?? st.jobPath ?? []).length} segments): HTTP ${r.status} (${words(r.status)}) _class=${className(b._class)} buildable=${bool(b.buildable)} jobs=${names.length} PR jobs=${names.filter((n) => /^PR-\d+$/.test(n)).length} names with %2F=${names.filter((n) => n.includes("%2F")).length} branch job exists=${!!branch} PR job exists=${pr} target=${pr ? "PR job" : branch ? "branch job" : "none"}`,
  };
}

const jobState = "_class,buildable,inQueue,queueItem[id],lastBuild[number],property[parameterDefinitions[name]]";
type JobBody = {
  _class?: unknown;
  buildable?: unknown;
  inQueue?: unknown;
  queueItem?: unknown;
  lastBuild?: unknown;
  property?: { parameterDefinitions?: unknown[] }[];
};
async function ci8(c: Ctx, st: State): Promise<Result> {
  const p = projectPath(c, st);
  if (!c.jenkins || !p || !st.target) return skip("CI8", "no PR job and no branch job (CI7)");
  const r = await jk(c, st, `${p}${jobUrl([st.target])}/api/json?tree=${jobState}`);
  const b = (r.body ?? {}) as JobBody;
  st.params = (Array.isArray(b.property) ? b.property : []).reduce(
    (n, x) => n + (Array.isArray(x?.parameterDefinitions) ? x.parameterDefinitions.length : 0),
    0,
  );
  st.buildable = b.buildable;
  return {
    check: "CI8",
    status: r.status === 200 ? "PASS" : "FAIL",
    evidence: `job GET (${st.target === prJob(c) ? "PR job" : "branch job"}): HTTP ${r.status} (${words(r.status)}) _class=${className(b._class)} buildable=${bool(b.buildable)} inQueue=${bool(b.inQueue)} queueItem present=${!!b.queueItem} lastBuild present=${!!b.lastBuild} parameters=${st.params}`,
  };
}

async function ci9(c: Ctx, st: State): Promise<Result> {
  const p = projectPath(c, st);
  if (!c.jenkins || !p) return skip("CI9", "no project path (CI7)");
  const plain = await jk(c, st, `${p}/api/json?tree=_class`, "POST", false);
  const withCrumb = st.crumb ? await jk(c, st, `${p}/api/json?tree=_class`, "POST") : undefined;
  const verdict =
    plain.status === 200
      ? st.crumb === null
        ? "CSRF protection off"
        : "token exempt"
      : plain.status === 403 && withCrumb?.status === 200
        ? "crumb needed and works"
        : plain.status === 403
          ? "denied"
          : "other";
  return {
    check: "CI9",
    status: "INFO",
    evidence: `POST api/json?tree=_class: without crumb HTTP ${plain.status}, with crumb and cookie ${withCrumb ? `HTTP ${withCrumb.status}` : "not sent (no crumb)"}; verdict=${verdict}`,
  };
}

async function ci10(c: Ctx, st: State): Promise<Result> {
  if (!c.build) return skip("CI10", "needs --authorize-build");
  const p = projectPath(c, st);
  const j = c.jenkins;
  if (!j || !p || !st.target) return skip("CI10", "no PR job and no branch job (CI7). Run CI11 first.");
  if (st.buildable === false) return { check: "CI10", status: "FAIL", evidence: "the job is not buildable (CI8). Nothing was posted." };
  const endpoint = st.params > 0 ? "buildWithParameters" : "build?delay=0sec";
  const r = await jk(c, st, `${p}${jobUrl([st.target])}/${endpoint}`, "POST");
  const base = new URL(j.base);
  const ctxPath = base.pathname.replace(/\/$/, "");
  const loc = r.headers.get("location");
  let u: URL | undefined;
  try {
    u = loc ? new URL(loc, `${j.base}/`) : undefined;
  } catch {}
  const m = u?.pathname.match(/\/queue\/item\/(\d+)\/?$/);
  const shape = !loc
    ? "none"
    : m && u?.pathname === `${ctxPath}/queue/item/${m[1]}/`
      ? `${ctxPath ? "<ctx>" : ""}/queue/item/<n>/`
      : m
        ? "other path ending in /queue/item/<n>/"
        : "other";
  const head = `${endpoint.split("?")[0]} POST: HTTP ${r.status} (${words(r.status)}) Location shape=${shape} same origin=${u ? u.origin === base.origin : "n/a"}`;
  if (r.status !== 201 || !m) return { check: "CI10", status: "FAIL", evidence: `${head}; no queue item` };
  // Only the item number comes from Location. The queue URL uses the --jenkins base.
  const classes = new Set<string>();
  let why = false;
  let outcome = "timeout";
  let polls = 0;
  const end = Date.now() + BUILD_WAIT_MS;
  while (Date.now() < end) {
    polls++;
    const q = await jk(c, st, `/queue/item/${m[1]}/api/json?tree=_class,why,cancelled,executable[number]`);
    const b = (q.body ?? {}) as { _class?: unknown; why?: unknown; cancelled?: unknown; executable?: { number?: unknown } | null };
    if (q.status === 404) {
      outcome = "gone (404)";
      break;
    }
    if (q.status !== 200) {
      outcome = `HTTP ${q.status} (${words(q.status)})`;
      break;
    }
    classes.add(className(b._class));
    why ||= typeof b.why === "string";
    if (b.cancelled === true) {
      outcome = "cancelled";
      break;
    }
    if (typeof b.executable?.number === "number") {
      outcome = "started, number present";
      break;
    }
    await Bun.sleep(c.pollMs);
  }
  return {
    check: "CI10",
    status: outcome.startsWith("started") ? "PASS" : "FAIL",
    evidence: `${head}; queue: classes=${[...classes].join(",") || "none"} why present=${why} outcome=${outcome} polls=${polls}`,
  };
}

async function ci11(c: Ctx, st: State): Promise<Result> {
  if (!c.scan) return skip("CI11", "needs --authorize-scan");
  const p = projectPath(c, st);
  if (!c.jenkins || !p) return skip("CI11", "no project path (CI7)");
  const list = async () => {
    const r = await jk(c, st, `${p}/api/json?tree=jobs[name]`);
    return r.status === 200 ? namesOf(r.body) : undefined;
  };
  const before = st.jobs ?? (await list()) ?? [];
  const has = (names: string[]) => ({ pr: names.includes(prJob(c)), branch: names.some((n) => isBranchJob(st, n)) });
  const was = has(before);
  const r = await jk(c, st, `${p}/build?delay=0sec`, "POST");
  const posted = (r.status >= 200 && r.status < 300) || r.status === 302 || r.status === 303;
  const start = Date.now();
  let after = before;
  let fresh: string | undefined;
  if (posted) {
    // Without a missing job, one read after the POST is enough.
    const missing = !was.pr || !was.branch;
    do {
      await Bun.sleep(c.pollMs);
      after = (await list()) ?? after;
      fresh = after.find((n) => !before.includes(n) && (n === prJob(c) || isBranchJob(st, n)));
    } while (missing && !fresh && Date.now() - start < SCAN_WAIT_MS);
  }
  // The app never posted to a job that the scan made, so a queued or finished build means the scan started it.
  let autoBuilt: boolean | undefined;
  if (fresh) {
    autoBuilt = false;
    const end = Date.now() + AUTO_BUILD_WAIT_MS;
    while (Date.now() < end) {
      const j = (await jk(c, st, `${p}${jobUrl([fresh])}/api/json?tree=inQueue,lastBuild[number]`)).body as JobBody | null;
      if (j?.inQueue === true || j?.lastBuild) {
        autoBuilt = true;
        break;
      }
      await Bun.sleep(c.pollMs);
    }
  }
  const now = has(after);
  const indexing = await jk(c, st, `${p}/indexing/api/json`);
  return {
    check: "CI11",
    status: posted ? "PASS" : "FAIL",
    evidence: `scan POST: HTTP ${r.status} (${words(r.status)}); jobs before=${before.length} after=${after.length}; PR job before=${was.pr} after=${now.pr}; branch job before=${was.branch} after=${now.branch}; new job appeared=${fresh ? `${fresh === prJob(c) ? "PR job" : "branch job"} after ${Math.round((Date.now() - start) / 1000)} s` : "no"} auto-built without a POST=${autoBuilt ?? "n/a"}; indexing GET: HTTP ${indexing.status} (${words(indexing.status)})`,
  };
}

const RUNNERS: Record<(typeof CHECKS)[number], (c: Ctx, st: State) => Promise<Result>> = {
  CI1: ci1,
  CI2: ci2,
  CI3: ci3,
  CI5: ci5,
  CI6: ci6,
  CI7: ci7,
  CI8: ci8,
  CI9: ci9,
  CI10: ci10,
  CI11: ci11,
};

// Runs the checks. The results are already masked. needles: the sensitive values for the self-check.
export async function runChecks(c: Ctx): Promise<{ results: Result[]; needles: Needle[] }> {
  const st: State = { users: [], jobPathFrom: "none", params: 0 };
  const results: Result[] = [];
  for (const id of CHECKS) {
    try {
      results.push(await RUNNERS[id](c, st));
    } catch (e) {
      // Only the error class: a message can quote a URL.
      results.push({ check: id, status: "FAIL", evidence: `exception: ${(e as Error).name}` });
    }
  }
  const needles = needlesOf(c, st);
  for (const r of results) r.evidence = clean(r.evidence, needles);
  return { results, needles };
}

// ---------- dry run ----------
// The fake Bitbucket serves under /bb and the fake Jenkins under /jenkins, so both context paths are exercised.
export async function dryRun(opts: { build: boolean; scan: boolean }) {
  const { FAKE_TOKEN, key, startFakeBitbucket } = await import("../../tests/support/fake-bitbucket");
  const { JENKINS_TOKEN, JENKINS_USER, startFakeJenkins } = await import("../../tests/support/fake-jenkins");
  const branch = "feature/ABC-1-fix";
  const head = "0123456789abcdef0123456789abcdef01234567";
  // The PR job appears only after a scan, and the scan queues its build.
  const jenkins = startFakeJenkins({ jobs: ["main", "feature%2FABC-1-fix"], onScan: ["PR-7"], autoBuildOnScan: true });
  const job = `${jenkins.url}/job/${jenkins.folder}/job/${jenkins.project}/job`;
  const ref = (displayId: string, latestCommit: string) => ({
    id: `refs/heads/${displayId}`,
    displayId,
    latestCommit,
    repository: { slug: "sample-repo", project: { key: "PROJ" } },
  });
  const bitbucket = startFakeBitbucket({
    routes: {
      [key("GET", "/bb/rest/api/1.0/projects/PROJ/repos/sample-repo/pull-requests/7")]: {
        status: 200,
        body: { id: 7, version: 0, state: "OPEN", fromRef: ref(branch, head), toRef: ref("main", "f".repeat(40)) },
      },
      [key("GET", `/bb/rest/build-status/1.0/commits/stats/${head}`)]: {
        status: 200,
        body: { cancelled: 0, failed: 1, inProgress: 0, successful: 1, unknown: 0 },
      },
      [key("GET", `/bb/rest/build-status/latest/commits/${head}`)]: {
        status: 200,
        body: {
          size: 2,
          limit: 25,
          start: 0,
          isLastPage: true,
          values: [
            {
              state: "FAILED",
              key: "sample-ci-feature-ABC-1-fix",
              name: `sample-ci » ${branch} #3`,
              url: `${job}/feature%252FABC-1-fix/3/display/redirect`,
              dateAdded: 1_760_000_000_000,
            },
            { state: "SUCCESSFUL", key: "lint", name: "lint", url: "https://lint.example.invalid/r/1", dateAdded: 1_760_000_000_001 },
          ],
        },
      },
    },
  });
  const ctx: Ctx = {
    bitbucket: { base: `${bitbucket.url}/bb`, project: "PROJ", repo: "sample-repo", id: 7, token: FAKE_TOKEN },
    jenkins: { base: jenkins.url, user: JENKINS_USER, token: JENKINS_TOKEN },
    build: opts.build,
    scan: opts.scan,
    pollMs: 20,
  };
  return {
    ctx,
    jenkins,
    // Values that never reach the context but must not show in the output either.
    extra: [branch, head, jenkins.folder, jenkins.project, "sample-ci-feature-ABC-1-fix", "lint.example.invalid"],
    stop: () => {
      bitbucket.stop();
      jenkins.stop();
    },
  };
}

// ---------- main ----------
function parseArgs(argv: string[]) {
  const FLAGS = new Set(["--dry-run", "--authorize-build", "--authorize-scan"]);
  const VALUES = new Set(["--jenkins", "--jenkins-user", "--job"]);
  const flags = new Set<string>();
  const opt: Record<string, string> = {};
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (FLAGS.has(a)) flags.add(a);
    else if (VALUES.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} needs a value.`);
      opt[a] = v;
    } else if (!a.startsWith("--") && url === undefined) url = a;
    else usage(`unknown argument: ${a.startsWith("--") ? a : "<a second URL>"}`);
  }
  return { flags, opt, url };
}

// https, or http on a loopback host. A context path is allowed. No user info, query, or fragment.
function jenkinsBase(v: string) {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    usage("--jenkins is not a URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) usage("--jenkins needs https, or http on a loopback host.");
  if (u.username || u.password || u.search || u.hash) usage("--jenkins needs a URL without user info, query, or fragment.");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function jobArg(v: string) {
  const segs = v.replace(/^\/+|\/+$/g, "").split("/");
  if (segs.length > 10 || segs.some((s) => !s || s === "." || s === ".."))
    usage("--job needs 1 to 10 path segments, without empty, '.', or '..' segments.");
  return segs;
}

async function main() {
  const { flags, opt, url } = parseArgs(process.argv.slice(2));
  const dry = flags.has("--dry-run");
  let ctx: Ctx;
  let stop = () => {};
  let extra: string[] = [];
  if (dry) {
    if (url || Object.keys(opt).length) usage("--dry-run takes no URL and no values.");
    const d = await dryRun({ build: true, scan: true });
    ({ ctx, stop, extra } = d);
  } else {
    if (!url) usage("A PR URL is required.");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      usage("The PR URL is not a URL.");
    }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) usage("The PR URL needs http or https without user info.");
    let pr: ReturnType<typeof parsePrUrl>;
    try {
      pr = parsePrUrl(url, u.origin);
    } catch {
      usage("Not a PR URL. Use <base>/projects/<KEY>/repos/<slug>/pull-requests/<id>.");
    }
    const base = u.origin + u.pathname.slice(0, u.pathname.search(/\/(projects|users)\//));
    let token = process.env.GATE_BITBUCKET_TOKEN;
    if (!token) {
      const storedUrl = await Bun.secrets.get({ service: SERVICE, name: "bitbucket-url" });
      token = (await Bun.secrets.get({ service: SERVICE, name: "bitbucket-token" })) ?? undefined;
      if (!token) usage("No token. Set GATE_BITBUCKET_TOKEN, or run: bun scripts/gate0/set-token.ts");
      if (!storedUrl || new URL(storedUrl).origin !== u.origin)
        usage("Refused: the stored token belongs to another server, or no server URL is stored. Set GATE_BITBUCKET_TOKEN for this server.");
    }
    const build = flags.has("--authorize-build");
    const scan = flags.has("--authorize-scan");
    let jenkins: Ctx["jenkins"];
    if (opt["--jenkins"]) {
      const jt = process.env.GATE_JENKINS_TOKEN;
      if (!jt) usage("--jenkins needs the API token in GATE_JENKINS_TOKEN.");
      if (!opt["--jenkins-user"]) usage("--jenkins needs --jenkins-user <user>.");
      jenkins = { base: jenkinsBase(opt["--jenkins"]), user: opt["--jenkins-user"], token: jt };
    } else if (build || scan || opt["--job"] || opt["--jenkins-user"])
      usage("--jenkins-user, --job, --authorize-build, and --authorize-scan need --jenkins.");
    ctx = {
      bitbucket: { base, project: pr.project, repo: pr.repo, id: pr.id, token },
      jenkins,
      job: opt["--job"] ? jobArg(opt["--job"]) : undefined,
      build,
      scan,
      pollMs: POLL_MS,
    };
  }
  let out: { results: Result[]; needles: Needle[] };
  try {
    out = await runChecks(ctx);
  } finally {
    stop();
  }
  const { results } = out;
  const needles = [...out.needles, ...extra.flatMap((v) => forms(v).map((value) => ({ kind: "dry-run name", value })))];
  for (const r of results) r.evidence = clean(r.evidence, needles);
  const lines = results.map((r) => `${r.status.padEnd(7)} ${r.check} ${r.evidence}`);
  const file = dry ? "result.dry-run.json" : "result.json";
  const json = `${JSON.stringify({ at: new Date().toISOString(), mode: dry ? "dry-run" : "run", results }, null, 2)}\n`;
  const problems = leaks([...lines, json], needles);
  if (problems.length) {
    console.error(`self-check failed: the output holds a value of kind: ${problems.join(", ")}. Nothing was printed or written.`);
    process.exit(3);
  }
  if (dry) console.log("[dry run: loopback fake Bitbucket and fake Jenkins, no secret read]");
  for (const l of lines) console.log(l);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, file), json);
  console.log(`Recorded in .gate0/ci/${file}.`);
  const failed = results.some((r) => r.status === "FAIL");
  if (dry) console.log(failed ? "dry run: FAIL" : "dry run: PASS");
  else console.log("Copy the lines above into the CI rows of integration-check.md.");
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.main) await main();
