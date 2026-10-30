// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate G1 to G7 (docs/plans/review-v2/tasks.md WP-G0, docs/gate-v2.md): the Bitbucket write facts for building Jira tasks.
// G1 to G7 WRITE to the server: branches, pull requests, and one branch delete. Run them only on a test repository that you may change.
// G9 and G12 (WP-PG) only read: the open PRs of the repository and the changes of an open PR without the token user.
// G13 to G17 (WP-GB) only read: the default branch, the branch search, the write permission and branch restrictions, the
// repository list, and the merge commit of a merged PR.
// G18 (WP-TU1) only reads: properties.mergeResult of the open PRs, with one PR that the user made conflicted by hand.
// G19 (WP-ST-G) WRITES: three gate branches, two PRs, a squash merge of the lower PR into the gate base branch, and a push of the upper branch.
// Usage: bun scripts/gate/bitbucket-write.ts --repo <repository URL> --target <branch> --authorize-writes [--only G1,G2] [G3 ...]
//          [--reviewer <user slug>] [--build-commit <commit>] [--readonly-token-env <VAR>] [--jira-key <KEY>] [--keep]
//        bun scripts/gate/bitbucket-write.ts --repo <repository URL> --only G9,G12
//        bun scripts/gate/bitbucket-write.ts --repo <repository URL> --only G13,G14,G15,G16,G17
//        bun scripts/gate/bitbucket-write.ts --repo <repository URL> --only G18
//        bun scripts/gate/bitbucket-write.ts --repo <repository URL> --target <branch> --authorize-writes --only G19
//        bun scripts/gate/bitbucket-write.ts --repo <repository URL> --authorize-writes --cleanup
//        bun scripts/gate/bitbucket-write.ts --dry-run [--only G1,G2]
// --dry-run: the same steps against a loopback fake server and a local bare repository. It reads no secret, and nothing leaves the machine.
// Token: GATE_BITBUCKET_TOKEN, else the token of scripts/gate0/set-token.ts. The stored token goes only to the stored URL origin.
// Console output and .gate0/bitbucket-write/*.json hold only status codes, booleans, key names, enum-like strings, and gate branch names.
// One exception: G19 prints the Bitbucket error messages of a failed merge, with every known name masked.
// GATE_DRY_SQUASH=off (dry run only): the fake repository disables squash, so G19 shows its failure output.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { z } from "zod";
import { change, page, pullRequest } from "../../src/server/bitbucket/schemas";
import { gitEnv } from "../../src/server/review/git";
import { MERGE_CONFLICTED } from "../../src/shared/task";
import { forms, clean as maskNeedles } from "./ci";

const SERVICE = "review-loop";
const ROOT = resolve(import.meta.dir, "../..");
const OUT = join(ROOT, ".gate0/bitbucket-write");
const HTTP_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000;
const G5_WAIT_MS = 30_000;
const G5_POLL_MS = 2_000;
// Every branch that the script creates or deletes has this prefix. The target branch never gets a push.
const PREFIX = "rl-gate-";
const CHECKS = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G9", "G12", "G13", "G14", "G15", "G16", "G17", "G18", "G19"] as const;
type CheckId = (typeof CHECKS)[number];
// These checks send only GET requests. They need no --authorize-writes and no --target.
const READ_ONLY = new Set<CheckId>(["G9", "G12", "G13", "G14", "G15", "G16", "G17", "G18"]);
// The open-PR list of G9 and G12: one page, as provider.listOpenPullRequests reads it (spec.md section 2.8).
const OPEN_PR_LIMIT = 50;
// G14: the page size of the base branch picker (spec.md section 6.16). G16: the repository pages that the app reads at most.
const BRANCH_LIMIT = 25;
const REPO_LIMIT = 100;
const REPO_PAGES = 10;
const USAGE = [
  "usage: bun scripts/gate/bitbucket-write.ts --repo <repository URL> --target <branch> --authorize-writes [--only G1,G2] [G3 ...]",
  "         [--reviewer <user slug>] [--build-commit <commit>] [--readonly-token-env <VAR>] [--jira-key <KEY>] [--keep]",
  "       bun scripts/gate/bitbucket-write.ts --repo <repository URL> --only G9,G12",
  "       bun scripts/gate/bitbucket-write.ts --repo <repository URL> --only G13,G14,G15,G16,G17",
  "       bun scripts/gate/bitbucket-write.ts --repo <repository URL> --only G18",
  "       bun scripts/gate/bitbucket-write.ts --repo <repository URL> --target <branch> --authorize-writes --only G19",
  "       bun scripts/gate/bitbucket-write.ts --repo <repository URL> --authorize-writes --cleanup",
  "       bun scripts/gate/bitbucket-write.ts --dry-run [--only G1,G2]",
].join("\n");

function usage(msg: string): never {
  console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

// ---------- arguments ----------
const argv = process.argv.slice(2);
const FLAGS = new Set(["--dry-run", "--authorize-writes", "--keep", "--cleanup"]);
const VALUES = new Set(["--repo", "--target", "--reviewer", "--build-commit", "--readonly-token-env", "--jira-key", "--only"]);
const flags = new Set<string>();
const opt: Record<string, string> = {};
const only = new Set<CheckId>();
const addIds = (v: string) => {
  for (const id of v.split(",").map((s) => s.trim().toUpperCase())) {
    if (!(CHECKS as readonly string[]).includes(id)) usage(`unknown check: ${id}. Use one of ${CHECKS.join(", ")}.`);
    only.add(id as CheckId);
  }
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? "";
  if (FLAGS.has(a)) flags.add(a);
  else if (VALUES.has(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) usage(`${a} needs a value.`);
    if (a === "--only") addIds(v);
    else opt[a] = v;
  } else if (/^g\d+$/i.test(a)) addIds(a);
  else usage(`unknown argument: ${a}`);
}
const selected = CHECKS.filter((c) => only.size === 0 || only.has(c));
const DRY = flags.has("--dry-run");

// A project or personal repository web URL: <base>/projects/<KEY>/repos/<slug> or <base>/users/<slug>/repos/<slug>.
function parseRepoUrl(input: string) {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    usage("--repo is not a URL.");
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) usage("--repo needs an http or https URL without user info.");
  const m = u.pathname.match(/^(.*?)\/(projects|users)\/([^/]+)\/repos\/([^/]+)(?:\/|$)/);
  if (!m?.[3] || !m[4]) usage("--repo is not a repository URL. Use <base>/projects/<KEY>/repos/<slug>.");
  const owner = decodeURIComponent(m[3]);
  // A personal repository uses the REST project key ~<USER SLUG> in upper case (src/shared/pr-url.ts).
  return { base: u.origin + (m[1] ?? ""), project: m[2] === "users" ? `~${owner.toUpperCase()}` : owner, repo: decodeURIComponent(m[4]) };
}

// ---------- sanitized output ----------
type Status = "PASS" | "FAIL" | "INFO" | "SKIPPED";
type Result = { check: string; status: Status; evidence: string; data?: unknown };
// A Java exception class name is enum-like enough to keep. Error messages are not kept.
const exceptionNames = (body: unknown): string[] =>
  ((body as { errors?: { exceptionName?: unknown }[] } | null)?.errors ?? [])
    .map((e) => e.exceptionName)
    .filter((n): n is string => typeof n === "string" && /^[A-Za-z0-9_.$]+$/.test(n));
const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : []);
const enumLike = (v: unknown) => (typeof v === "string" && /^[A-Z][A-Z0-9_]*$/.test(v) ? v : v === undefined ? "absent" : "<value>");
const hash = (s: unknown) => (typeof s === "string" ? createHash("sha256").update(s).digest("hex") : null);
// Issue paths hold schema key names and array indexes only, never values.
function shape(schema: z.ZodType, body: unknown) {
  const r = schema.safeParse(body);
  return r.success
    ? "ok"
    : `failed ${r.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "<root>"}:${i.code}`)
        .join(",")}`;
}
const valuesOf = (body: unknown) => {
  const v = (body as { values?: unknown } | null)?.values;
  return Array.isArray(v) ? v : [];
};
const keyUnion = (items: unknown[]) => [...new Set(items.flatMap(keysOf))].sort().join(",") || "none";
// git output markers. Remote text can hold names, so only these tokens leave the script.
const MARKERS = /\[new branch\]|\[deleted\]|\[rejected\]|\[remote rejected\]|\(stale info\)|non-fast-forward|fetch first|up to date/g;
function gitFacts(text: string) {
  const markers = [...new Set(text.match(MARKERS) ?? [])];
  const http = text.match(/returned error: (\d{3})|HTTP (\d{3})/);
  return { markers, http: http ? Number(http[1] ?? http[2]) : null };
}

type Ctx = {
  base: string;
  project: string;
  repo: string;
  token: string;
  target: string;
  // Dry run only: a local bare repository in place of the http clone link.
  pushUrl?: string;
  readonlyToken?: string;
  reviewer?: string;
  buildCommit?: string;
  jiraKey?: string;
  keep: boolean;
};
// user: the X-AUSERNAME header, the username of the token owner (provider.currentUser).
type Call = { status: number; body: unknown; user?: string | null };
type Pr = { id?: unknown; version?: unknown; state?: unknown; title?: unknown; toRef?: { id?: unknown }; reviewers?: unknown[] };

// ---------- the session: HTTP, git, and the objects that this run made ----------
function session(ctx: Ctx) {
  const repoPath = `/rest/api/1.0/projects/${encodeURIComponent(ctx.project)}/repos/${encodeURIComponent(ctx.repo)}`;
  const stamp = Date.now().toString(36);
  const name = (role: string) => `${PREFIX}${stamp}-${role}`;
  const dir = mkdtempSync(join(tmpdir(), "rl-gate-bw-"));
  const cache = join(dir, "cache.git");
  const emptyGlobal = join(dir, "empty.gitconfig");
  writeFileSync(emptyGlobal, "");
  const identity = {
    GIT_AUTHOR_NAME: "Review gate",
    GIT_AUTHOR_EMAIL: "gate@example.invalid",
    GIT_COMMITTER_NAME: "Review gate",
    GIT_COMMITTER_EMAIL: "gate@example.invalid",
  };
  const envFor = (token: string) => ({ ...gitEnv(emptyGlobal, [["http.extraHeader", `Authorization: Bearer ${token}`]]), ...identity });
  const env = envFor(ctx.token);
  let cloneUrl: string | undefined;

  // Removes every value that can name the server, the repository, or the token.
  const clean = (s: string) => {
    let out = s;
    for (const [v, r] of [
      [ctx.token, "<token>"],
      [ctx.readonlyToken, "<token>"],
      [cloneUrl, "<clone url>"],
      [ctx.base, "<server>"],
      [new URL(ctx.base).host, "<server>"],
    ] as const)
      if (v) out = out.split(v).join(r);
    return out;
  };

  // Bitbucket error messages are free text. They can name the server, the repository, a branch, a PR, or a user.
  const mask = (text: string, user?: string | null) => {
    const names = [ctx.project, ctx.project.replace(/^~/, ""), ctx.repo, ctx.target, ctx.reviewer, ctx.jiraKey, user, ...branches.keys()];
    const needles = names.filter((v): v is string => !!v).flatMap((v) => forms(v).map((value) => ({ kind: "name", value })));
    return maskNeedles(clean(text), needles)
      .replace(new RegExp(String.raw`'[^']*'|"[^"]*"|\S+://\S+|refs/heads/\S+|${PREFIX}\S+`, "g"), "<value>")
      .slice(0, 200);
  };

  async function call(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Call> {
    try {
      const res = await fetch(ctx.base + path, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, body: json, user: res.headers.get("x-ausername") };
    } catch (e) {
      return { status: 0, body: { network: (e as Error).name } };
    }
  }

  // cwd: a worktree of the cache. git then finds its own git dir.
  type GitOpts = { env?: Record<string, string>; stdin?: string; cwd?: string };
  function git(args: string[], opts: GitOpts = {}) {
    const r = Bun.spawnSync(opts.cwd ? ["git", ...args] : ["git", `--git-dir=${cache}`, ...args], {
      cwd: opts.cwd,
      env: opts.env ?? env,
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: GIT_TIMEOUT_MS,
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }
  function must(args: string[], opts: GitOpts = {}) {
    const r = git(args, opts);
    if (r.code !== 0) {
      const f = gitFacts(r.out + r.err);
      // URLs and quoted values in a git message can name the server, the repository, or a path.
      const first = clean(r.err.split(/\r?\n/).find((l) => /^(fatal|error):/.test(l)) ?? "")
        .replace(/'[^']*'|\S+:\/\/\S+|[A-Za-z]:[\\/]\S+/g, "<value>")
        .slice(0, 200);
      throw new Error(`git ${args[0]} failed (exit ${r.code}) markers=${f.markers.join(",") || "none"} http=${f.http ?? "none"} ${first}`);
    }
    return r.out.trim();
  }

  const init = Bun.spawnSync(["git", "init", "-q", "--bare", "--template=", cache], { env, stdout: "pipe", stderr: "pipe" });
  if (init.exitCode !== 0) throw new Error("git init failed");

  const repoInfo: { status?: number; cloneNames?: string[]; httpSameOrigin?: boolean } = {};
  async function url() {
    if (cloneUrl) return cloneUrl;
    const r = await call("GET", repoPath);
    const links = ((r.body as { links?: { clone?: { name?: unknown; href?: unknown }[] } } | null)?.links?.clone ?? []).filter(
      (l) => typeof l.href === "string",
    );
    repoInfo.status = r.status;
    repoInfo.cloneNames = links.map((l) => (typeof l.name === "string" && /^[a-z0-9]+$/.test(l.name) ? l.name : "<name>"));
    const http = links.find((l) => l.name === "http")?.href as string | undefined;
    if (!http) throw new Error(`no http clone link: HTTP ${r.status} links=${repoInfo.cloneNames.join(",") || "none"}`);
    const u = new URL(http);
    u.username = "";
    u.password = "";
    // The token goes only to the server origin of --repo.
    repoInfo.httpSameOrigin = u.origin === new URL(ctx.base).origin;
    if (!repoInfo.httpSameOrigin) throw new Error("the http clone link has another origin. Nothing was pushed.");
    cloneUrl = ctx.pushUrl ?? u.href;
    return cloneUrl;
  }

  let head: string | undefined;
  async function targetHead() {
    if (!head) {
      must(["fetch", "-q", "--no-tags", "--depth", "1", await url(), `refs/heads/${ctx.target}`]);
      head = must(["rev-parse", "FETCH_HEAD"]);
    }
    return head;
  }
  // A commit on parent that adds one file, so a pull request from it has a diff.
  function commitOn(parent: string, label: string) {
    const index = { ...env, GIT_INDEX_FILE: join(dir, `index-${label}`) };
    const blob = must(["hash-object", "-w", "--stdin"], { stdin: `Gate ${label} ${stamp}\n` });
    must(["read-tree", parent], { env: index });
    must(["update-index", "--add", "--cacheinfo", `100644,${blob},rl-gate/${stamp}-${label}.txt`], { env: index });
    const tree = must(["write-tree"], { env: index });
    return must(["commit-tree", tree, "-p", parent, "-m", `Gate ${label}`]);
  }
  // refspec "<commit>" pushes it to the branch; null deletes the branch. lease "" means: the branch must not exist.
  // lease null sends no lease, so only a fast-forward passes.
  async function push(branch: string, commit: string | null, lease: string | null, token = ctx.token) {
    if (!branch.startsWith(PREFIX)) throw new Error("refusing to push a branch without the gate prefix");
    const spec = `${commit ?? ""}:refs/heads/${branch}`;
    const leaseArg = lease === null ? [] : [`--force-with-lease=refs/heads/${branch}:${lease}`];
    const r = git(["push", "--porcelain", await url(), ...leaseArg, spec], { env: envFor(token) });
    return { code: r.code, ...gitFacts(r.out + r.err) };
  }
  async function remoteAt(branch: string) {
    const line = must(["ls-remote", "--heads", await url(), `refs/heads/${branch}`]);
    return line.split(/\s+/)[0] || null;
  }

  // Objects that this run made. cleanup() declines the PRs and deletes the branches, except the kept ones (G7).
  const branches = new Map<string, string>();
  const prs = new Map<number, string>();
  const kept = new Set<string>();
  const pushes: Record<string, { code: number | null; markers: string[]; http: number | null }> = {};

  async function branch(role: string, parent: string) {
    const b = name(role);
    const sha = commitOn(parent, role);
    const r = await push(b, sha, "");
    pushes[role] = r;
    if (r.code !== 0)
      throw new Error(`push of a new branch failed (exit ${r.code}) markers=${r.markers.join(",") || "none"} http=${r.http ?? "none"}`);
    branches.set(b, sha);
    return { name: b, sha };
  }
  const memo = <T>(fn: () => Promise<T>) => {
    let p: Promise<T> | undefined;
    return () => {
      p ??= fn();
      return p;
    };
  };
  const openPrs = memo(() => call("GET", `${repoPath}/pull-requests?state=OPEN&limit=${OPEN_PR_LIMIT}`));
  const repository = memo(() => call("GET", repoPath));
  // GET .../default-branch gives the configured default branch (Bitbucket 7.21 and DC 9.6 REST, REPO_READ).
  const defaultBranch = memo(() => call("GET", `${repoPath}/default-branch`));
  const lower = memo(async () => branch("lower", await targetHead()));
  const upper = memo(async () => branch("upper", (await lower()).sha));

  const ref = (b: string) => ({ id: `refs/heads/${b}`, repository: { slug: ctx.repo, project: { key: ctx.project } } });
  const prPath = (id: number) => `${repoPath}/pull-requests/${id}`;
  async function createPr(from: string, to: string, title: string, reviewers: string[] = []) {
    const r = await call("POST", `${repoPath}/pull-requests`, {
      title,
      description: "Review gate check. The script declines this pull request and deletes its branch at the end.",
      fromRef: ref(from),
      toRef: ref(to),
      reviewers: reviewers.map((n) => ({ user: { name: n } })),
    });
    const pr = (r.body ?? {}) as Pr;
    if (typeof pr.id === "number") prs.set(pr.id, from);
    return { ...r, pr };
  }
  const getPr = async (id: number) => {
    const r = await call("GET", prPath(id));
    return { status: r.status, pr: (r.body ?? {}) as Pr };
  };
  const stacked = memo(async () => {
    const [l, u] = [await lower(), await upper()];
    const r = await createPr(u.name, l.name, `Review gate stack ${stamp}`);
    if (r.status !== 201 || typeof r.pr.id !== "number")
      throw new Error(`create of the stacked PR failed: HTTP ${r.status} ${exceptionNames(r.body).join(",")}`);
    return { id: r.pr.id, lower: l, upper: u };
  });

  async function decline(id: number) {
    const g = await getPr(id);
    if (g.pr.state !== "OPEN") return g.status === 200 ? "not open" : `HTTP ${g.status}`;
    const r = await call("POST", `${prPath(id)}/decline?version=${String(g.pr.version)}`, {});
    return `HTTP ${r.status}`;
  }
  async function cleanup() {
    const declined: string[] = [];
    for (const [id, from] of prs) if (!kept.has(from)) declined.push(await decline(id));
    const deleted: string[] = [];
    for (const [b, sha] of branches) {
      if (kept.has(b)) continue;
      const r = await push(b, null, sha);
      deleted.push(r.code === 0 ? "ok" : `exit ${r.code} ${r.markers.join(",")}`);
    }
    return `cleanup: declined PRs=${declined.join(",") || "none"}; deleted branches=${deleted.join(",") || "none"}`;
  }
  // --cleanup: every gate branch on the server, with its open outgoing PRs.
  async function cleanupAll() {
    const lines = must(["ls-remote", "--heads", await url()]).split(/\r?\n/);
    const found = lines
      .map((l) => l.split(/\s+/))
      .filter(([, r]) => r?.startsWith(`refs/heads/${PREFIX}`))
      .map(([sha, r]) => ({ sha: sha as string, branch: (r as string).slice("refs/heads/".length) }));
    const out: string[] = [];
    for (const f of found) {
      const r = await call(
        "GET",
        `${repoPath}/pull-requests?at=${encodeURIComponent(`refs/heads/${f.branch}`)}&direction=OUTGOING&state=OPEN&limit=25`,
      );
      const ids = ((r.body as { values?: { id?: unknown }[] } | null)?.values ?? [])
        .map((v) => v.id)
        .filter((id): id is number => typeof id === "number");
      const d = [];
      for (const id of ids) d.push(await decline(id));
      const p = await push(f.branch, null, f.sha);
      out.push(`${f.branch}: PRs declined=${d.join(",") || "none"} branch deleted=${p.code === 0}`);
    }
    return out.length ? out : ["no gate branches found"];
  }

  return {
    ctx,
    mask,
    repoPath,
    stamp,
    name,
    dir,
    url,
    git,
    must,
    call,
    commitOn,
    push,
    remoteAt,
    branch,
    branches,
    kept,
    pushes,
    repoInfo,
    openPrs,
    repository,
    defaultBranch,
    lower,
    upper,
    stacked,
    createPr,
    getPr,
    ref,
    prPath,
    targetHead,
    envFor,
    clean,
    cleanup,
    cleanupAll,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
type Session = ReturnType<typeof session>;

// ---------- checks ----------
const isRef = (pr: Pr, b: string) => pr.toRef?.id === `refs/heads/${b}`;

async function g1(s: Session): Promise<Result> {
  const l = await s.lower();
  const at = await s.remoteAt(l.name);
  const p = s.pushes.lower;
  let readonly = "read-only token: not given";
  if (s.ctx.readonlyToken) {
    const b = s.name("readonly");
    const r = await s.push(b, s.commitOn(l.sha, "readonly"), "", s.ctx.readonlyToken);
    if (r.code === 0) s.branches.set(b, (await s.remoteAt(b)) ?? "");
    readonly = `read-only token push: exit=${r.code} markers=${r.markers.join(",") || "none"} http=${r.http ?? "none"}`;
  }
  const pass = !!s.repoInfo.httpSameOrigin && p?.code === 0 && at === l.sha;
  return {
    check: "G1",
    status: pass ? "PASS" : "FAIL",
    evidence: `repository GET: HTTP ${s.repoInfo.status} clone links=${s.repoInfo.cloneNames?.join(",")} http same origin=${s.repoInfo.httpSameOrigin}; push with empty lease: exit=${p?.code} markers=${p?.markers.join(",") || "none"} remote at pushed commit=${at === l.sha}; ${readonly}`,
  };
}

async function g2(s: Session): Promise<Result> {
  const l = await s.lower();
  const r = await s.createPr(l.name, s.ctx.target, `Review gate G2 ${s.stamp}`, [s.ctx.reviewer as string]);
  const reviewers = Array.isArray(r.pr.reviewers) ? r.pr.reviewers.length : null;
  const pass = r.status === 201 && typeof r.pr.id === "number" && typeof r.pr.version === "number" && reviewers === 1;
  return {
    check: "G2",
    status: pass ? "PASS" : "FAIL",
    evidence: `create PR: HTTP ${r.status}${exceptionNames(r.body).length ? ` ${exceptionNames(r.body).join(",")}` : ""} id=${typeof r.pr.id === "number"} version=${String(r.pr.version)} state=${enumLike(r.pr.state)} reviewers=${reviewers} keys=${keysOf(r.body).join(",")}`,
  };
}

async function g3(s: Session): Promise<Result> {
  const stats = async (sha: string) => {
    const r = await s.call("GET", `/rest/build-status/1.0/commits/stats/${sha}`);
    const b = (r.body ?? {}) as Record<string, unknown>;
    const nums = ["successful", "inProgress", "failed"].every((k) => typeof b[k] === "number");
    return {
      r,
      b,
      nums,
      line: `HTTP ${r.status} keys=${keysOf(r.body).join(",") || "none"} counts=${nums ? `${b.successful}/${b.inProgress}/${b.failed}` : "n/a"}`,
    };
  };
  const sha = (await s.lower()).sha;
  const before = await stats(sha);
  // Repository-scoped build status API (Bitbucket 7.4+, REPO_READ). The status stays on the gate commit: not all versions can delete it.
  const post = await s.call("POST", `${s.repoPath}/commits/${sha}/builds`, {
    key: "rl-gate",
    name: "PR Review Inbox gate",
    state: "SUCCESSFUL",
    url: `https://example.invalid/rl-gate/${s.stamp}`,
    description: "Synthetic build status of the review gate.",
  });
  const after = await stats(sha);
  const extra = s.ctx.buildCommit ? await stats(s.ctx.buildCommit) : null;
  const pass = before.r.status === 200 && before.nums && after.r.status === 200 && after.nums && (after.b.successful as number) >= 1;
  return {
    check: "G3",
    status: pass ? "PASS" : "FAIL",
    evidence: `build stats (successful/inProgress/failed) of the new gate commit: ${before.line}; POST build status: HTTP ${post.status}${exceptionNames(post.body).length ? ` ${exceptionNames(post.body).join(",")}` : ""} keys=${keysOf(post.body).join(",") || "none"}; stats after the POST: ${after.line}; INFO --build-commit: ${extra ? extra.line : "not given"}`,
  };
}

async function g4(s: Session): Promise<Result> {
  const st = await s.stacked();
  const before = await s.getPr(st.id);
  const put = await s.call("PUT", s.prPath(st.id), { version: before.pr.version, toRef: s.ref(s.ctx.target) });
  const after = await s.getPr(st.id);
  const moved = isRef(after.pr, s.ctx.target);
  // Back to the stacked target, so G5 can delete it.
  const back = await s.call("PUT", s.prPath(st.id), { version: after.pr.version, toRef: s.ref(st.lower.name) });
  const reviewers = (p: Pr) => (Array.isArray(p.reviewers) ? p.reviewers.length : null);
  return {
    check: "G4",
    status: put.status === 200 && moved ? "PASS" : "FAIL",
    evidence: `PUT with a new toRef: HTTP ${put.status}${exceptionNames(put.body).length ? ` ${exceptionNames(put.body).join(",")}` : ""} version ${String(before.pr.version)}->${String(after.pr.version)} toRef moved=${moved} title unchanged=${hash(after.pr.title) === hash(before.pr.title)} reviewers ${reviewers(before.pr)}->${reviewers(after.pr)}; PUT back: HTTP ${back.status}`,
  };
}

async function g5(s: Session): Promise<Result> {
  const st = await s.stacked();
  const before = await s.getPr(st.id);
  if (!isRef(before.pr, st.lower.name))
    return {
      check: "G5",
      status: "FAIL",
      evidence: `the stacked PR does not target the lower branch: HTTP ${before.status} state=${enumLike(before.pr.state)}`,
    };
  const del = await s.push(st.lower.name, null, st.lower.sha);
  if (del.code === 0) s.branches.delete(st.lower.name);
  let after = before;
  const end = Date.now() + G5_WAIT_MS;
  while (Date.now() < end) {
    after = await s.getPr(st.id);
    if (after.pr.state !== "OPEN" || !isRef(after.pr, st.lower.name)) break;
    await Bun.sleep(G5_POLL_MS);
  }
  const to = isRef(after.pr, st.lower.name) ? "lower branch" : isRef(after.pr, s.ctx.target) ? "target branch" : "other";
  return {
    check: "G5",
    status: del.code === 0 && after.status === 200 ? "PASS" : "FAIL",
    evidence: `delete of the target branch: exit=${del.code} markers=${del.markers.join(",") || "none"}; outcome: state=${enumLike(after.pr.state)} toRef=${to} version ${String(before.pr.version)}->${String(after.pr.version)} (read within ${G5_WAIT_MS / 1000} s)`,
  };
}

async function g6(s: Session): Promise<Result> {
  const u = await s.upper();
  const moved = s.commitOn(u.sha, "moved");
  const r1 = await s.push(u.name, moved, u.sha);
  if (r1.code === 0) s.branches.set(u.name, moved);
  const r2 = await s.push(u.name, s.commitOn(u.sha, "stale"), u.sha);
  const at = await s.remoteAt(u.name);
  const pass = r1.code === 0 && r2.code !== 0 && r2.markers.includes("(stale info)") && at === moved;
  return {
    check: "G6",
    status: pass ? "PASS" : "FAIL",
    evidence: `move the remote branch: exit=${r1.code}; push with the old lease: exit=${r2.code} markers=${r2.markers.join(",") || "none"}; remote keeps the moved commit=${at === moved}`,
  };
}

async function g7(s: Session): Promise<Result> {
  const b = await s.branch("g7", await s.targetHead());
  s.kept.add(b.name);
  const r = await s.createPr(b.name, s.ctx.target, `${s.ctx.jiraKey}: Review gate G7`);
  return {
    check: "G7",
    status: r.status === 201 ? "INFO" : "FAIL",
    evidence: `create PR with the Jira key in its title: HTTP ${r.status} id=${String(r.pr.id)}. The script keeps this PR. Sync the app, open PR ${String(r.pr.id)}, and record whether it shows the task chip. Then run --cleanup.`,
  };
}

async function g9(s: Session): Promise<Result> {
  const r = await s.openPrs();
  const values = valuesOf(r.body);
  const first = (values[0] ?? {}) as { author?: unknown; fromRef?: unknown };
  const last = (r.body as { isLastPage?: unknown } | null)?.isLastPage;
  const schema = shape(page(pullRequest), r.body);
  return {
    check: "G9",
    status: r.status === 200 && schema === "ok" ? "PASS" : "FAIL",
    evidence: `open PRs (limit ${OPEN_PR_LIMIT}): HTTP ${r.status}${exceptionNames(r.body).length ? ` ${exceptionNames(r.body).join(",")}` : ""} count=${values.length} isLastPage=${typeof last === "boolean" ? last : "absent"} page schema=${schema}; keys=${keysOf(r.body).join(",") || "none"}; PR keys=${keyUnion(values)}; author keys=${keysOf(first.author).join(",") || "none"}; fromRef keys=${keysOf(first.fromRef).join(",") || "none"}; X-AUSERNAME=${r.user ? "present" : "absent"}`,
  };
}

type Who = { user?: { name?: unknown; slug?: unknown } };
async function g12(s: Session): Promise<Result> {
  const list = await s.openPrs();
  const me = list.user?.toLowerCase();
  if (list.status !== 200 || !me)
    return { check: "G12", status: "FAIL", evidence: `open PRs: HTTP ${list.status} X-AUSERNAME=${me ? "present" : "absent"}` };
  const isMe = (w: Who | undefined) => [w?.user?.name, w?.user?.slug].some((v) => typeof v === "string" && v.toLowerCase() === me);
  // The user takes part as author, reviewer, or participant. The list keeps the server order, newest update first.
  const takesPart = (pr: { author?: Who; reviewers?: Who[]; participants?: Who[] }) =>
    isMe(pr.author) || (pr.reviewers ?? []).some(isMe) || (pr.participants ?? []).some(isMe);
  const prs = valuesOf(list.body) as { id?: unknown; author?: Who; reviewers?: Who[]; participants?: Who[] }[];
  const other = prs.find((p) => typeof p.id === "number" && !takesPart(p));
  const own = prs.find((p) => typeof p.id === "number" && takesPart(p));
  const counts = `open PRs read=${prs.length} without the user=${prs.filter((p) => !takesPart(p)).length}`;
  if (!other)
    return {
      check: "G12",
      status: "SKIPPED",
      evidence: `${counts}. No open PR without the token user in the first ${OPEN_PR_LIMIT}. Ask another user to open one on the test repository.`,
    };
  const changes = async (id: unknown) => {
    const r = await s.call("GET", `${s.prPath(id as number)}/changes?limit=${OPEN_PR_LIMIT}`);
    const values = valuesOf(r.body);
    const last = (r.body as { isLastPage?: unknown } | null)?.isLastPage;
    const schema = shape(page(change), r.body);
    const types = [...new Set(values.map((v) => enumLike((v as { type?: unknown }).type)))].sort().join(",") || "none";
    return {
      ok: r.status === 200 && schema === "ok",
      line: `HTTP ${r.status}${exceptionNames(r.body).length ? ` ${exceptionNames(r.body).join(",")}` : ""} count=${values.length} isLastPage=${typeof last === "boolean" ? last : "absent"} page schema=${schema} change keys=${keyUnion(values)} types=${types}`,
    };
  };
  const theirs = await changes(other.id);
  const mine = own ? await changes(own.id) : null;
  return {
    check: "G12",
    status: theirs.ok && (!mine || mine.ok) ? "PASS" : "FAIL",
    evidence: `${counts}; changes of a PR without the user: ${theirs.line}; changes of an own PR: ${mine ? mine.line : "no own open PR in the list"}`,
  };
}

// ---------- G13 to G17: reads for task branches, base branches, and several repositories (spec.md section 6.16) ----------
type Ref = { id?: unknown; displayId?: unknown; type?: unknown };
const SHA = /^[0-9a-f]{40}$/;
const errs = (body: unknown) => (exceptionNames(body).length ? ` ${exceptionNames(body).join(",")}` : "");
const isLast = (body: unknown) => (body as { isLastPage?: unknown } | null)?.isLastPage;
const pageLine = (r: Call) => {
  const last = isLast(r.body);
  return `HTTP ${r.status}${errs(r.body)} count=${valuesOf(r.body).length} isLastPage=${typeof last === "boolean" ? last : "absent"}`;
};
const pageOk = (r: Call) =>
  r.status === 200 && Array.isArray((r.body as { values?: unknown } | null)?.values) && typeof isLast(r.body) === "boolean";

async function g13(s: Session): Promise<Result> {
  const r = await s.defaultBranch();
  const b = (r.body ?? {}) as Ref;
  const heads = typeof b.id === "string" && b.id.startsWith("refs/heads/");
  const ok = r.status === 200 && heads && typeof b.displayId === "string";
  const old = await s.call("GET", `${s.repoPath}/branches/default`);
  const o = (old.body ?? {}) as Ref;
  return {
    check: "G13",
    status: ok ? "PASS" : "FAIL",
    evidence: `default-branch: HTTP ${r.status}${errs(r.body)} keys=${keysOf(r.body).join(",") || "none"} id is refs/heads/=${heads} displayId=${typeof b.displayId === "string"} type=${enumLike(b.type)}; deprecated branches/default: HTTP ${old.status}${errs(old.body)} keys=${keysOf(old.body).join(",") || "none"} same id=${hash(o.id) !== null && hash(o.id) === hash(b.id)}`,
  };
}

async function g14(s: Session): Promise<Result> {
  const d = (await s.defaultBranch()).body as Ref | null;
  const name = typeof d?.displayId === "string" ? d.displayId : null;
  if (!name) return { check: "G14", status: "FAIL", evidence: "G13 gave no default branch name, so the filter read has no input." };
  const list = (q: string) => s.call("GET", `${s.repoPath}/branches?${q}&limit=${BRANCH_LIMIT}`);
  const all = await list("orderBy=MODIFICATION");
  const values = valuesOf(all.body) as (Ref & { isDefault?: unknown; default?: unknown })[];
  const types = [...new Set(values.map((v) => enumLike(v.type)))].sort().join(",") || "none";
  const flagged = values.filter((v) => v.isDefault === true || v.default === true).length;
  const hit = await list(`filterText=${encodeURIComponent(name)}&boostMatches=true&orderBy=MODIFICATION`);
  const exactFirst = (valuesOf(hit.body)[0] as Ref | undefined)?.displayId === name;
  const none = await list(`filterText=${encodeURIComponent(`${PREFIX}none-${s.stamp}`)}`);
  const pass = pageOk(all) && pageOk(hit) && exactFirst && pageOk(none) && valuesOf(none.body).length === 0;
  return {
    check: "G14",
    status: pass ? "PASS" : "FAIL",
    evidence: `branches (orderBy MODIFICATION, limit ${BRANCH_LIMIT}): ${pageLine(all)} branch keys=${keyUnion(values)} types=${types} values with a default flag=${flagged}; filter on the default branch with boostMatches: ${pageLine(hit)} exact match first=${exactFirst}; filter without a match: ${pageLine(none)}`,
  };
}

type RepoRow = { slug?: unknown; project?: { key?: unknown }; links?: { clone?: { name?: unknown }[] } };
const isTestRepo = (s: Session, v: RepoRow) =>
  v.slug === s.ctx.repo && typeof v.project?.key === "string" && v.project.key.toUpperCase() === s.ctx.project.toUpperCase();

async function g15(s: Session): Promise<Result> {
  const repo = await s.repository();
  const name = (repo.body as { name?: unknown } | null)?.name;
  if (repo.status !== 200 || typeof name !== "string")
    return {
      check: "G15",
      status: "FAIL",
      evidence: `repository GET: HTTP ${repo.status}${errs(repo.body)} name=${typeof name === "string"}`,
    };
  // GET /rest/api/1.0/repos filters by the permission of the token user (REPO_READ, REPO_WRITE, REPO_ADMIN). projectkey needs 8.0.
  const level = async (permission: string) => {
    const r = await s.call(
      "GET",
      `/rest/api/1.0/repos?permission=${permission}&projectkey=${encodeURIComponent(s.ctx.project)}&name=${encodeURIComponent(name)}&limit=${REPO_LIMIT}`,
    );
    const listed = (valuesOf(r.body) as RepoRow[]).some((v) => isTestRepo(s, v));
    return { r, listed, line: `${permission}: ${pageLine(r)} test repository listed=${listed}` };
  };
  const read = await level("REPO_READ");
  const write = await level("REPO_WRITE");
  const admin = await level("REPO_ADMIN");
  // The restriction search needs REPO_ADMIN (DC 9.6 REST). A plain user gets 401: record it.
  const rr = await s.call(
    "GET",
    `/rest/branch-permissions/latest/projects/${encodeURIComponent(s.ctx.project)}/repos/${encodeURIComponent(s.ctx.repo)}/restrictions?limit=${REPO_LIMIT}`,
  );
  const rv = valuesOf(rr.body) as { type?: unknown; matcher?: { type?: { id?: unknown } } }[];
  const rtypes = [...new Set(rv.map((v) => (typeof v.type === "string" && /^[a-z-]+$/.test(v.type) ? v.type : "<value>")))]
    .sort()
    .join(",");
  const mtypes = [...new Set(rv.map((v) => enumLike(v.matcher?.type?.id)))].sort().join(",");
  const pass = read.r.status === 200 && read.listed && write.r.status === 200 && admin.r.status === 200;
  return {
    check: "G15",
    status: pass ? "PASS" : "FAIL",
    evidence: `${read.line}; ${write.line}; ${admin.line}; restrictions: ${pageLine(rr)} restriction types=${rtypes || "none"} matcher types=${mtypes || "none"}`,
  };
}

async function g16(s: Session): Promise<Result> {
  let start = 0;
  let pages = 0;
  let count = 0;
  let listed = false;
  let last: unknown;
  let status = 0;
  let exc = "";
  const rows: RepoRow[] = [];
  while (pages < REPO_PAGES) {
    const r = await s.call("GET", `/rest/api/1.0/repos?permission=REPO_WRITE&limit=${REPO_LIMIT}&start=${start}`);
    pages++;
    status = r.status;
    exc = errs(r.body);
    if (r.status !== 200) break;
    const v = valuesOf(r.body) as RepoRow[];
    count += v.length;
    if (rows.length < REPO_LIMIT) rows.push(...v.slice(0, REPO_LIMIT - rows.length));
    listed ||= v.some((x) => isTestRepo(s, x));
    last = isLast(r.body);
    const next = (r.body as { nextPageStart?: unknown } | null)?.nextPageStart;
    if (last !== false || typeof next !== "number") break;
    start = next;
  }
  const clones = [
    ...new Set(
      rows.flatMap((v) =>
        (v.links?.clone ?? []).map((l) => (typeof l.name === "string" && /^[a-z0-9]+$/.test(l.name) ? l.name : "<name>")),
      ),
    ),
  ]
    .sort()
    .join(",");
  return {
    check: "G16",
    status: status === 200 && typeof last === "boolean" ? "PASS" : "FAIL",
    evidence: `repositories with REPO_WRITE (limit ${REPO_LIMIT}, at most ${REPO_PAGES} pages): HTTP ${status}${exc} pages=${pages} count=${count} last isLastPage=${typeof last === "boolean" ? last : "absent"} repository keys=${keyUnion(rows)} project keys=${keyUnion(rows.map((v) => v.project))} clone link names=${clones || "none"}; INFO test repository listed=${listed}`,
  };
}

async function g17(s: Session): Promise<Result> {
  const list = await s.call("GET", `${s.repoPath}/pull-requests?state=MERGED&limit=1`);
  if (list.status !== 200) return { check: "G17", status: "FAIL", evidence: `merged PRs: ${pageLine(list)}` };
  const pr = valuesOf(list.body)[0] as { id?: unknown; properties?: { mergeCommit?: { id?: unknown } } } | undefined;
  if (typeof pr?.id !== "number")
    return { check: "G17", status: "SKIPPED", evidence: "The test repository has no merged PR. Merge one PR there and run again." };
  const prop = pr.properties?.mergeCommit?.id;
  const acts = await s.call("GET", `${s.prPath(pr.id)}/activities?limit=${OPEN_PR_LIMIT}`);
  const merged = (valuesOf(acts.body) as { action?: unknown; commit?: { id?: unknown } }[]).find((a) => a.action === "MERGED");
  const act = merged?.commit?.id;
  const hasProp = typeof prop === "string" && SHA.test(prop);
  const hasAct = typeof act === "string" && SHA.test(act);
  return {
    check: "G17",
    status: acts.status !== 200 ? "FAIL" : hasProp || hasAct ? "PASS" : "INFO",
    evidence: `newest merged PR: properties keys=${keysOf(pr.properties).join(",") || "none"} mergeCommit keys=${keysOf(pr.properties?.mergeCommit).join(",") || "none"} mergeCommit id=${hasProp}; activities: ${pageLine(acts)} MERGED activity=${!!merged} commit keys=${keysOf(merged?.commit).join(",") || "none"} commit id=${hasAct}; same commit=${hasProp && hasAct && prop === act}`,
  };
}

// ---------- G18: the merge result of the open PRs (spec.md section 6.18.5) ----------
// PASS: each open PR carries properties.mergeResult with a string outcome and a boolean current, and one PR reports CONFLICTED with
// current true. INFO: no open PR reports CONFLICTED; make one conflicted by hand and run again.
async function g18(s: Session): Promise<Result> {
  const r = await s.openPrs();
  if (r.status !== 200) return { check: "G18", status: "FAIL", evidence: `open PRs: ${pageLine(r)}` };
  const values = valuesOf(r.body) as { properties?: { mergeResult?: { outcome?: unknown; current?: unknown } } }[];
  if (!values.length)
    return {
      check: "G18",
      status: "SKIPPED",
      evidence: "The test repository has no open PR. Open one, make it conflicted, and run again.",
    };
  const results = values.map((v) => v.properties?.mergeResult);
  const typed = results.filter((m) => typeof m?.outcome === "string" && typeof m?.current === "boolean");
  const outcomes = [
    ...new Set(results.map((m) => `${enumLike(m?.outcome)}/current=${typeof m?.current === "boolean" ? m.current : "absent"}`)),
  ]
    .sort()
    .join(",");
  const conflicted = results.some((m) => m?.outcome === MERGE_CONFLICTED && m.current === true);
  return {
    check: "G18",
    status: typed.length !== values.length ? "FAIL" : conflicted ? "PASS" : "INFO",
    evidence: `open PRs: ${pageLine(r)} properties keys=${keyUnion(values.map((v) => v.properties))} mergeResult keys=${keyUnion(results)} with outcome and current=${typed.length} of ${values.length} outcomes=${outcomes}; CONFLICTED with current true=${conflicted}`,
  };
}

// ---------- G19: the squash merge of a lower PR and the update of the upper PR (spec.md section 6.20.10) ----------
// The lower PR merges into a gate base branch, never into --target. The base moves before and after the merge, so S^1 is not in
// the upper branch and M1 is not S. Then all three merges run.
async function g19(s: Session): Promise<Result> {
  const fail = (evidence: string): Result => ({ check: "G19", status: "FAIL", evidence });
  const v = s.must(["version"]).match(/(\d+)\.(\d+)/);
  if (!v || Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 38))
    return fail("the local git is older than 2.38. It has no merge-tree --write-tree. Update git and run again.");
  // GET .../settings/pull-requests gives mergeConfig, the effective merge strategies of the repository (DC 9.6 REST, REPO_READ).
  const set = await s.call("GET", `${s.repoPath}/settings/pull-requests`);
  const mc = (
    set.body as { mergeConfig?: { defaultStrategy?: { id?: unknown }; strategies?: { id?: unknown; enabled?: unknown }[] } } | null
  )?.mergeConfig;
  const strategy = (id: unknown) => (typeof id === "string" && /^[a-z0-9-]+$/.test(id) ? id : "<value>");
  const enabled = (mc?.strategies ?? []).filter((x) => x.enabled === true).map((x) => strategy(x.id));
  const squashOff = set.status === 200 && !enabled.includes("squash");
  const setLine = `merge strategies: HTTP ${set.status} enabled=${enabled.join(",") || "none"} default=${mc?.defaultStrategy ? strategy(mc.defaultStrategy.id) : "absent"}`;
  const base = await s.branch("g19-base", await s.targetHead());
  const low = await s.branch("g19-lower", base.sha);
  const up = await s.branch("g19-upper", low.sha);
  const base2 = s.commitOn(base.sha, "g19-base-2");
  const mv1 = await s.push(base.name, base2, base.sha);
  if (mv1.code !== 0) return fail(`move of the base branch: exit=${mv1.code} markers=${mv1.markers.join(",") || "none"}`);
  s.branches.set(base.name, base2);
  const lowPr = await s.createPr(low.name, base.name, `Review gate G19 lower ${s.stamp}`);
  const upPr = await s.createPr(up.name, low.name, `Review gate G19 upper ${s.stamp}`);
  const lowId = lowPr.pr.id;
  const upId = upPr.pr.id;
  if (typeof lowId !== "number" || typeof upId !== "number")
    return fail(`create PRs: lower HTTP ${lowPr.status}${errs(lowPr.body)}; upper HTTP ${upPr.status}${errs(upPr.body)}`);

  // DC 9.6 REST: version is a query parameter, strategyId is a body field (RestPullRequestMergeRequest). The repository must enable squash.
  const before = await s.getPr(lowId);
  const merge = await s.call("POST", `${s.prPath(lowId)}/merge?version=${String(before.pr.version)}`, { strategyId: "squash" });
  const after = await s.getPr(lowId);
  const mergeLine = `${setLine}; squash merge of the lower PR: HTTP ${merge.status}${errs(merge.body)} state=${enumLike(after.pr.state)}`;
  if (merge.status !== 200 || after.pr.state !== "MERGED") {
    const details = ((merge.body as { errors?: { context?: unknown; message?: unknown }[] } | null)?.errors ?? []).map(
      (e) =>
        `${typeof e.context === "string" && /^[A-Za-z0-9_.]+$/.test(e.context) ? `context=${e.context} ` : ""}message=${typeof e.message === "string" ? s.mask(e.message, merge.user) : "absent"}`,
    );
    const hint = squashOff
      ? "; The repository does not enable squash. Enable squash in the repository settings (Merge strategies) and run again."
      : "";
    return fail(`${mergeLine}; errors: ${details.join(" | ") || "none"}${hint}`);
  }
  const kept = (await s.remoteAt(low.name)) === low.sha;
  const acts = await s.call("GET", `${s.prPath(lowId)}/activities?limit=${OPEN_PR_LIMIT}`);
  const act = (valuesOf(acts.body) as { action?: unknown; commit?: { id?: unknown; parents?: unknown } }[]).find(
    (a) => a.action === "MERGED",
  );
  const sq = act?.commit?.id;
  const actParents = Array.isArray(act?.commit?.parents) ? act.commit.parents.length : null;
  const actLine = `activities: ${pageLine(acts)} MERGED activity=${!!act} commit keys=${keysOf(act?.commit).join(",") || "none"} commit parents=${actParents ?? "absent"}`;
  if (typeof sq !== "string" || !SHA.test(sq)) return fail(`${mergeLine}; lower branch kept=${kept}; ${actLine}; commit id=false`);

  s.must(["fetch", "-q", "--no-tags", await s.url(), `refs/heads/${base.name}`]);
  const baseHead = s.must(["rev-parse", "FETCH_HEAD"]);
  s.branches.set(base.name, baseHead);
  if (s.git(["cat-file", "-e", `${sq}^{commit}`]).code !== 0)
    return fail(`${mergeLine}; ${actLine}; the MERGED commit is not in the fetched base branch`);
  const parents = s.must(["rev-list", "--parents", "-n", "1", sq]).split(/\s+/).slice(1);
  const s1 = parents[0] ?? "";
  // merge-tree exits 1 on a conflict. Its first line is then still a tree, so the exit code decides.
  const mt = s.git(["merge-tree", "--write-tree", s1, low.sha]);
  const treeOk = parents.length === 1 && mt.code === 0 && mt.out.split(/\r?\n/)[0] === s.must(["rev-parse", `${sq}^{tree}`]);
  const sqLine = `${mergeLine}; lower branch kept=${kept}; ${actLine}; MERGED commit is the base head=${sq === baseHead} git parents=${parents.length} S^1 is the moved base=${s1 === base2}; tree of S equals merge-tree --write-tree S^1 A_final=${treeOk}`;

  const m1 = s.commitOn(baseHead, "g19-base-3");
  const mv2 = await s.push(base.name, m1, baseHead);
  if (mv2.code !== 0) return fail(`${sqLine}; move of the base after the merge: exit=${mv2.code}`);
  s.branches.set(base.name, m1);
  const wt = join(s.dir, "g19-upper");
  s.must(["worktree", "add", "-q", "--detach", wt, up.sha]);
  const inWt = (args: string[]) => s.must(args, { cwd: wt });
  const steps: string[] = [];
  if (s.git(["merge-base", "--is-ancestor", s1, up.sha]).code === 0) steps.push("S^1 skipped");
  else {
    inWt(["merge", "--no-ff", "-q", "-m", "G19: merge the base into the upper branch", s1]);
    steps.push("S^1");
  }
  inWt(["merge", "--no-ff", "-q", "-s", "ours", "-m", "G19: record the squash merge of the lower branch", sq]);
  steps.push("ours S");
  if (m1 === sq) steps.push("M1 skipped");
  else {
    inWt(["merge", "--no-ff", "-q", "-m", "G19: merge the base into the upper branch", m1]);
    steps.push("M1");
  }
  const newUp = inWt(["rev-parse", "HEAD"]);
  const upperFile = `rl-gate/${s.stamp}-g19-upper.txt`;
  const onlyUpper = (paths: string[]) => paths.length === 1 && paths[0] === upperFile;
  const local = s
    .must(["diff", "--name-only", `${m1}...${newUp}`])
    .split(/\r?\n/)
    .filter(Boolean);
  const p = await s.push(up.name, newUp, null);
  if (p.code === 0) s.branches.set(up.name, newUp);
  const g = await s.getPr(upId);
  const put = await s.call("PUT", s.prPath(upId), { version: g.pr.version, toRef: s.ref(base.name) });
  const moved = isRef((await s.getPr(upId)).pr, base.name);
  const ch = await s.call("GET", `${s.prPath(upId)}/changes?limit=${OPEN_PR_LIMIT}`);
  const paths = (valuesOf(ch.body) as { path?: { toString?: unknown } }[]).map((c) => String(c.path?.toString));
  const pass =
    kept &&
    sq === baseHead &&
    (actParents === null || actParents === 1) &&
    treeOk &&
    onlyUpper(local) &&
    p.code === 0 &&
    put.status === 200 &&
    moved &&
    ch.status === 200 &&
    onlyUpper(paths);
  return {
    check: "G19",
    status: pass ? "PASS" : "FAIL",
    evidence: `${sqLine}; merges on the upper branch: ${steps.join(", ")}; local diff M1...upper lists only the upper file=${onlyUpper(local)} (count ${local.length}); push without force or lease: exit=${p.code} markers=${p.markers.join(",") || "none"}; PUT the target to the base: HTTP ${put.status}${errs(put.body)} toRef moved=${moved}; upper PR changes: ${pageLine(ch)} only the upper file=${onlyUpper(paths)}`,
  };
}

const RUNNERS: Record<CheckId, (s: Session) => Promise<Result>> = {
  G1: g1,
  G2: g2,
  G3: g3,
  G4: g4,
  G5: g5,
  G6: g6,
  G7: g7,
  G9: g9,
  G12: g12,
  G13: g13,
  G14: g14,
  G15: g15,
  G16: g16,
  G17: g17,
  G18: g18,
  G19: g19,
};

async function runGate(ctx: Ctx) {
  const s = session(ctx);
  const results: Result[] = [];
  let tail = "";
  try {
    for (const id of selected) {
      try {
        results.push(await RUNNERS[id](s));
      } catch (e) {
        results.push({ check: id, status: "FAIL", evidence: `exception: ${s.clean((e as Error).message)}` });
      }
    }
  } finally {
    tail = ctx.keep
      ? `cleanup: skipped (--keep). Gate branches start with ${PREFIX}${s.stamp}.`
      : await s.cleanup().catch((e) => `cleanup failed: ${s.clean((e as Error).message)}`);
    s.dispose();
  }
  for (const r of results) r.evidence = s.clean(r.evidence);
  return { results, tail: s.clean(tail) };
}

function report(results: Result[], tail: string, file: string) {
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.check} ${r.evidence}`);
  console.log(tail);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, file),
    `${JSON.stringify({ at: new Date().toISOString(), mode: DRY ? "dry-run" : "run", selected, results, tail }, null, 2)}\n`,
  );
  console.log(`Recorded in .gate0/bitbucket-write/${file}.`);
}
const part = selected.length === CHECKS.length ? "" : `.${selected.join("-").toLowerCase()}`;

// ---------- dry run: a loopback fake server and a local bare repository ----------
// The fake declines a PR whose target or source branch is gone. That is one possible G5 outcome, not a verified one.
function fakeServer(token: string, origin: string, buildCommit: string, env: Record<string, string>, squash: boolean) {
  const og = (args: string[]) => {
    const r = Bun.spawnSync(["git", `--git-dir=${origin}`, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString().trim() };
  };
  const exists = (b: string) => og(["rev-parse", "--verify", "-q", b]).code === 0;
  // G19: the activities of the gate PRs that the fake merged.
  const activities = new Map<number, unknown[]>();
  const prs = new Map<
    number,
    Record<string, unknown> & { version: number; state: string; fromRef: { id: string }; toRef: { id: string } }
  >();
  const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "X-AUSERNAME": "dry-user" } });
  // Successful build keys per commit. The --build-commit of the dry run starts with one build.
  const builds = new Map<string, Set<string>>([[buildCommit, new Set(["dry-ci"])]]);
  const repoPath = "/ctx/rest/api/1.0/projects/DRY/repos/dry-repo";
  // G9 and G12: two open PRs that the gate does not create. 101 is by the token user, 102 is by another user.
  const who = (name: string) => ({ user: { name, slug: name, displayName: name } });
  const peerRef = (b: string) => ({
    id: `refs/heads/${b}`,
    displayId: b,
    latestCommit: buildCommit,
    repository: { slug: "dry-repo", project: { key: "DRY" } },
  });
  const peer = (id: number, author: string, reviewer: string) => ({
    id,
    version: 0,
    title: `Dry peer ${id}`,
    state: "OPEN",
    updatedDate: 1_760_000_000_000 + id,
    author: who(author),
    reviewers: [{ ...who(reviewer), role: "REVIEWER", status: "UNAPPROVED" }],
    participants: [],
    fromRef: peerRef(`feature/${id}`),
    toRef: peerRef("main"),
    links: {},
  });
  // G18: 102 reports conflicts, 101 is clean.
  const merge = (outcome: string) => ({
    properties: { mergeResult: { outcome, current: true }, resolvedTaskCount: 0, commentCount: 0, openTaskCount: 0 },
  });
  const peers = [
    { ...peer(102, "dry-other", "dry-reviewer"), ...merge(MERGE_CONFLICTED) },
    { ...peer(101, "dry-user", "dry-reviewer"), ...merge("CLEAN") },
  ];
  const peerChanges: Record<number, unknown[]> = {
    101: [{ path: { toString: "README.md" }, type: "MODIFY" }],
    102: [
      { path: { toString: "README.md" }, type: "MODIFY" },
      { path: { toString: "docs/new.md" }, srcPath: { toString: "docs/old.md" }, type: "MOVE" },
    ],
  };
  // G13 to G17. The branch flag key follows the DC 9.6 RestBranch schema ("default"). The live key is a G14 fact.
  const branchOf = (name: string) => ({
    id: `refs/heads/${name}`,
    displayId: name,
    type: "BRANCH",
    latestCommit: buildCommit,
    latestChangeset: buildCommit,
    default: name === "main",
  });
  const dryRepo = (slug: string, name: string) => ({
    slug,
    name,
    project: { key: "DRY", name: "Dry" },
    links: { clone: [{ name: "http", href: `http://127.0.0.1/ctx/scm/dry/${slug}.git` }] },
  });
  const merged = {
    ...peer(90, "dry-other", "dry-user"),
    state: "MERGED",
    properties: { mergeCommit: { id: buildCommit, displayId: "x" } },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) return json(401, { errors: [{ message: "Authentication failed." }] });
      const url = new URL(req.url);
      const p = url.pathname;
      if (req.method === "GET" && p.startsWith("/ctx/rest/build-status/1.0/commits/stats/"))
        return json(200, { successful: builds.get(p.slice(p.lastIndexOf("/") + 1))?.size ?? 0, inProgress: 0, failed: 0 });
      const bm = p.match(/\/commits\/([0-9a-f]{40})\/builds$/);
      if (req.method === "POST" && bm?.[1] && p.startsWith(`${repoPath}/`)) {
        const b = (await req.json()) as { key?: unknown; state?: unknown; url?: unknown };
        if (typeof b.key !== "string" || b.state !== "SUCCESSFUL" || typeof b.url !== "string" || !b.url.startsWith("https://"))
          return json(400, { errors: [{ exceptionName: "dry.InvalidBuildStatus" }] });
        builds.set(bm[1], (builds.get(bm[1]) ?? new Set()).add(b.key));
        return new Response(null, { status: 204 });
      }
      if (req.method === "GET" && p === "/ctx/rest/api/1.0/repos") {
        // G15 and G16: the token user may write to dry-repo and dry-lib, and administers nothing.
        const q = url.searchParams;
        const all = q.get("permission") === "REPO_ADMIN" ? [] : [dryRepo("dry-repo", "Dry Repo"), dryRepo("dry-lib", "Dry Lib")];
        const values = all.filter(
          (r) =>
            (!q.get("name") || r.name.toLowerCase() === q.get("name")?.toLowerCase()) &&
            (!q.get("projectkey") || r.project.key === q.get("projectkey")?.toUpperCase()),
        );
        return json(200, { size: values.length, limit: 100, start: 0, isLastPage: true, values });
      }
      if (req.method === "GET" && p === "/ctx/rest/branch-permissions/latest/projects/DRY/repos/dry-repo/restrictions")
        return json(401, { errors: [{ exceptionName: "com.atlassian.bitbucket.AuthorisationException" }] });
      if (req.method === "GET" && p === `${repoPath}/settings/pull-requests`)
        return json(200, {
          mergeConfig: {
            defaultStrategy: { id: "no-ff", enabled: true },
            strategies: [
              { id: "no-ff", enabled: true },
              { id: "squash", enabled: squash },
            ],
          },
        });
      if (req.method === "GET" && (p === `${repoPath}/default-branch` || p === `${repoPath}/branches/default`))
        return json(200, branchOf("main"));
      if (req.method === "GET" && p === `${repoPath}/branches`) {
        const f = url.searchParams.get("filterText")?.toLowerCase() ?? "";
        const names = ["feature/101", "main", "feature/main-docs"].filter((n) => n.includes(f));
        if (url.searchParams.get("boostMatches") === "true") names.sort((a, b) => Number(b === f) - Number(a === f));
        return json(200, { size: names.length, limit: 25, start: 0, isLastPage: true, values: names.map(branchOf) });
      }
      if (req.method === "GET" && p === `${repoPath}/pull-requests` && url.searchParams.get("state") === "MERGED")
        return json(200, { size: 1, limit: 1, start: 0, isLastPage: false, nextPageStart: 1, values: [merged] });
      if (req.method === "GET" && p === `${repoPath}/pull-requests/90/activities`)
        return json(200, {
          size: 2,
          limit: 50,
          start: 0,
          isLastPage: true,
          values: [
            { id: 2, action: "MERGED", commit: { id: buildCommit, displayId: buildCommit.slice(0, 11) } },
            { id: 1, action: "OPENED" },
          ],
        });
      if (req.method === "GET" && p === repoPath)
        return json(200, {
          slug: "dry-repo",
          name: "Dry Repo",
          project: { key: "DRY" },
          links: {
            clone: [
              { name: "http", href: `${url.origin}/ctx/scm/dry/dry-repo.git` },
              { name: "ssh", href: "ssh://git@127.0.0.1:7999/dry/dry-repo.git" },
            ],
          },
        });
      if (p === `${repoPath}/pull-requests` && req.method === "GET") {
        const at = url.searchParams.get("at");
        // The repository list (no at) holds only the seeded PRs: the gate PRs lack the read schema fields.
        if (!at) return json(200, { size: peers.length, limit: 50, start: 0, isLastPage: true, values: peers });
        return json(200, { values: [...prs.values()].filter((x) => x.fromRef.id === at && x.state === "OPEN"), isLastPage: true });
      }
      const am = p.match(/\/pull-requests\/(\d+)\/activities$/);
      if (req.method === "GET" && am && activities.has(Number(am[1]))) {
        const values = activities.get(Number(am[1])) ?? [];
        return json(200, { size: values.length, limit: 50, start: 0, isLastPage: true, values });
      }
      const mm = p.match(/\/pull-requests\/(\d+)\/merge$/);
      if (req.method === "POST" && mm) {
        const pr = prs.get(Number(mm[1]));
        if (pr?.state !== "OPEN") return json(404, { errors: [{ exceptionName: "dry.NoSuchPullRequest" }] });
        if (Number(url.searchParams.get("version")) !== pr.version) return json(409, { errors: [{ exceptionName: "dry.OutOfDate" }] });
        if (((await req.json()) as { strategyId?: unknown }).strategyId !== "squash")
          return json(400, { errors: [{ exceptionName: "dry.UnsupportedStrategy" }] });
        // Invented message text with names in it. It tests the masking, not the live wording.
        if (!squash)
          return json(400, {
            errors: [
              {
                context: "strategyId",
                message: `Squash is not enabled for DRY/dry-repo, ${pr.fromRef.id} into ${pr.toRef.id.replace("refs/heads/", "")}, user dry-user.`,
                exceptionName: "dry.ArgumentValidation",
              },
            ],
          });
        // shortcut: the fake squash uses the 3-way merge tree, the same rule that G19 checks. Only the live server confirms the rule.
        const to = og(["rev-parse", pr.toRef.id]).out;
        const tree = og(["merge-tree", "--write-tree", to, pr.fromRef.id]);
        if (tree.code !== 0) return json(409, { errors: [{ exceptionName: "dry.MergeConflict" }] });
        const sq = og(["commit-tree", tree.out.split("\n")[0] ?? "", "-p", to, "-m", "dry squash"]).out;
        og(["update-ref", pr.toRef.id, sq, to]);
        Object.assign(pr, { state: "MERGED", version: pr.version + 1 });
        activities.set(Number(mm[1]), [
          { id: 2, action: "MERGED", commit: { id: sq, displayId: sq.slice(0, 11), parents: [{ id: to, displayId: to.slice(0, 11) }] } },
          { id: 1, action: "OPENED" },
        ]);
        return json(200, pr);
      }
      const cm = p.match(/\/pull-requests\/(\d+)\/changes$/);
      const gatePr = cm ? prs.get(Number(cm[1])) : undefined;
      if (req.method === "GET" && gatePr) {
        // A PR diff starts at the merge base of the target and the source.
        const names = og(["diff", "--name-only", `${gatePr.toRef.id}...${gatePr.fromRef.id}`])
          .out.split("\n")
          .filter(Boolean);
        const values = names.map((n) => ({ path: { toString: n }, type: "ADD" }));
        return json(200, { size: values.length, limit: 50, start: 0, isLastPage: true, values });
      }
      if (req.method === "GET" && cm) {
        const values = peerChanges[Number(cm[1])];
        if (!values) return json(404, { errors: [{ exceptionName: "dry.NoSuchPullRequest" }] });
        return json(200, { size: values.length, limit: 50, start: 0, isLastPage: true, values });
      }
      if (p === `${repoPath}/pull-requests` && req.method === "POST") {
        const b = (await req.json()) as {
          title?: string;
          fromRef?: { id?: string };
          toRef?: { id?: string };
          reviewers?: { user?: { name?: string } }[];
        };
        if (!b.fromRef?.id || !b.toRef?.id || !exists(b.fromRef.id) || !exists(b.toRef.id))
          return json(404, { errors: [{ exceptionName: "dry.NoSuchBranch" }] });
        const id = prs.size + 1;
        const pr = {
          id,
          version: 0,
          title: b.title,
          state: "OPEN",
          fromRef: { id: b.fromRef.id },
          toRef: { id: b.toRef.id },
          reviewers: (b.reviewers ?? []).map((r) => ({ user: { name: r.user?.name }, role: "REVIEWER", status: "UNAPPROVED" })),
          links: {},
        };
        prs.set(id, pr);
        return json(201, pr);
      }
      const m = p.match(/\/pull-requests\/(\d+)(\/decline)?$/);
      const pr = m ? prs.get(Number(m[1])) : undefined;
      if (!pr) return json(404, { errors: [{ exceptionName: "dry.NoSuchPullRequest" }] });
      if (pr.state === "OPEN" && (!exists(pr.toRef.id) || !exists(pr.fromRef.id)))
        Object.assign(pr, { state: "DECLINED", version: pr.version + 1 });
      if (req.method === "GET") return json(200, pr);
      if (m?.[2]) {
        if (Number(url.searchParams.get("version")) !== pr.version) return json(409, { errors: [{ exceptionName: "dry.OutOfDate" }] });
        Object.assign(pr, { state: "DECLINED", version: pr.version + 1 });
        return json(200, pr);
      }
      const b = (await req.json()) as { version?: number; toRef?: { id?: string } };
      if (b.version !== pr.version) return json(409, { errors: [{ exceptionName: "dry.OutOfDate" }] });
      if (b.toRef?.id) {
        if (!exists(b.toRef.id)) return json(404, { errors: [{ exceptionName: "dry.NoSuchBranch" }] });
        pr.toRef = { id: b.toRef.id };
      }
      pr.version++;
      return json(200, pr);
    },
  });
  return server;
}

if (DRY) {
  const dir = mkdtempSync(join(tmpdir(), "rl-gate-bw-dry-"));
  const origin = join(dir, "origin.git");
  const env = {
    ...gitEnv(join(dir, "none.gitconfig")),
    GIT_AUTHOR_NAME: "dry",
    GIT_AUTHOR_EMAIL: "dry@example.invalid",
    GIT_COMMITTER_NAME: "dry",
    GIT_COMMITTER_EMAIL: "dry@example.invalid",
  };
  writeFileSync(join(dir, "none.gitconfig"), "");
  const g = (args: string[], stdin?: string) => {
    const r = Bun.spawnSync(["git", ...args], {
      env: { ...env, GIT_INDEX_FILE: join(dir, "index") },
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(`dry setup: git ${args[0]} failed: ${r.stderr.toString().trim()}`);
    return r.stdout.toString().trim();
  };
  g(["init", "-q", "--bare", "--template=", origin]);
  const blob = g([`--git-dir=${origin}`, "hash-object", "-w", "--stdin"], "dry\n");
  g([`--git-dir=${origin}`, "update-index", "--add", "--cacheinfo", `100644,${blob},README.md`]);
  const first = g([`--git-dir=${origin}`, "commit-tree", g([`--git-dir=${origin}`, "write-tree"]), "-m", "dry"]);
  g([`--git-dir=${origin}`, "update-ref", "refs/heads/main", first]);
  const token = "dry-run-token";
  const server = fakeServer(token, origin, first, env, process.env.GATE_DRY_SQUASH !== "off");
  try {
    const { results, tail } = await runGate({
      base: `http://127.0.0.1:${server.port}/ctx`,
      project: "DRY",
      repo: "dry-repo",
      token,
      target: "main",
      pushUrl: origin,
      reviewer: "dry-reviewer",
      buildCommit: first,
      jiraKey: "DRY-1",
      keep: false,
    });
    console.log("[dry run: loopback fake server and a local bare repository, no secret read]");
    report(results, tail, `result${part}.dry-run.json`);
    const ok = results.length === selected.length && results.every((r) => r.status !== "FAIL");
    console.log(ok ? "dry run: PASS" : "dry run: FAIL");
    process.exitCode = ok ? 0 : 1;
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  // ---------- live run: separate authorization, a repository named on the command line ----------
  if (!opt["--repo"]) usage("--repo is required. Name your test repository.");
  const cleanupMode = flags.has("--cleanup");
  const writes = cleanupMode || selected.some((c) => !READ_ONLY.has(c));
  if (writes && !flags.has("--authorize-writes"))
    usage(
      "Refused: G1 to G7 create branches and pull requests and delete a branch, and G19 merges a gate pull request. Add --authorize-writes for your test repository, or select only the read checks G9, G12, and G13 to G18.",
    );
  const repo = parseRepoUrl(opt["--repo"]);
  const target = opt["--target"];
  if (writes && !cleanupMode) {
    if (!target) usage("--target is required: the branch that the gate branches start from.");
    if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.includes("..") || target.startsWith(PREFIX))
      usage("--target is not a usable branch name.");
    if (selected.includes("G2") && !opt["--reviewer"]) usage("G2 needs --reviewer <user slug>.");
    if (selected.includes("G7") && !/^[A-Z][A-Z0-9]+-\d+$/.test(opt["--jira-key"] ?? "")) usage("G7 needs --jira-key <KEY-123>.");
    if (opt["--build-commit"] && !/^[0-9a-f]{7,40}$/i.test(opt["--build-commit"])) usage("--build-commit needs a commit ID.");
  }
  const roName = opt["--readonly-token-env"];
  if (roName && !process.env[roName]) usage(`--readonly-token-env: ${roName} is empty.`);
  let token = process.env.GATE_BITBUCKET_TOKEN;
  if (!token) {
    const storedUrl = await Bun.secrets.get({ service: SERVICE, name: "bitbucket-url" });
    token = (await Bun.secrets.get({ service: SERVICE, name: "bitbucket-token" })) ?? undefined;
    if (!token) usage("No token. Set GATE_BITBUCKET_TOKEN, or run: bun scripts/gate0/set-token.ts");
    if (!storedUrl || new URL(storedUrl).origin !== new URL(repo.base).origin)
      usage("Refused: the stored token belongs to another server, or no server URL is stored. Set GATE_BITBUCKET_TOKEN for this server.");
  }
  const ctx: Ctx = {
    ...repo,
    token,
    target: target ?? "",
    readonlyToken: roName ? process.env[roName] : undefined,
    reviewer: opt["--reviewer"],
    buildCommit: opt["--build-commit"],
    jiraKey: opt["--jira-key"],
    keep: flags.has("--keep"),
  };
  if (cleanupMode) {
    const s = session(ctx);
    try {
      for (const l of await s.cleanupAll()) console.log(s.clean(l));
    } catch (e) {
      console.error(`cleanup failed: ${s.clean((e as Error).message)}`);
      process.exitCode = 1;
    } finally {
      s.dispose();
    }
  } else {
    const { results, tail } = await runGate(ctx);
    report(results, tail, `result${part}.json`);
    console.log("Copy the lines above into the Review v2 rows of these checks in integration-check.md.");
    if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
  }
}
