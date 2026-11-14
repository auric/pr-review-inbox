// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 S-RR: re-review with the fake CLI and temp git repositories. No test starts the real CLI or reaches a forge.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { parseDiff } from "../../src/server/review/diffmap";
import { git, gitEnv } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { CODE_GONE, NO_VERDICT, validateEarlier } from "../../src/server/review/validate";
import { cachePath, type GitRemote, prepareWorkspace, UNTRUSTED } from "../../src/server/review/workspace";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { PostPlanDto, ReviewItemDto, RunConflict, RunDetail, RunDto } from "../../src/shared/dto";
import type { Carried, EarlierVerdict, Finding, ReplyPayload } from "../../src/shared/review";
import type { PullRequest } from "../../src/shared/types";
import { FAKE_TOKEN, FAKE_USER } from "../support/fake-bitbucket";
import { readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const NEW_FILE = "export const x = 1;\n";

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

function temp() {
  const d = mkdtempSync(join(tmpdir(), "rl-srr-"));
  dirs.push(d);
  return d;
}

async function waitFor(pred: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(25);
  return pred();
}

// 40 lines "line N". edit: new text by line number. top: lines before line 1.
function appText(edit: Record<number, string> = {}, top: string[] = []) {
  const lines = Array.from({ length: 40 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`);
  return `${[...top, ...lines].join("\n")}\n`;
}

// A bare remote. Commits go through a temp index. files: the text of a path, or null to remove it. The first parent gives the start tree.
async function remoteRepo(root: string) {
  mkdirSync(root, { recursive: true });
  const empty = join(root, "author.gitconfig");
  writeFileSync(empty, "");
  const dir = join(root, "remote.git");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_INDEX_FILE: join(root, "author.index"),
  };
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", dir, ...args], { env, stdin })).trim();
  await git(["init", "-q", "--bare", "--template=", dir], { env });
  let n = 0;
  async function commit(parents: string[], files: Record<string, string | null>, msg = "commit") {
    await g(parents[0] ? ["read-tree", parents[0]] : ["read-tree", "--empty"]);
    const info: string[] = [];
    for (const [path, text] of Object.entries(files)) {
      if (text === null) {
        info.push(`0 ${"0".repeat(40)}\t${path}`);
        continue;
      }
      const f = join(root, `blob-${n++}`);
      writeFileSync(f, text);
      info.push(`100644 ${await g(["hash-object", "-w", "--no-filters", f])}\t${path}`);
    }
    if (info.length) await g(["update-index", "--index-info"], `${info.join("\n")}\n`);
    return g(["commit-tree", await g(["write-tree"]), ...parents.flatMap((p) => ["-p", p]), "-m", msg]);
  }
  // The PR head is refs/pull-requests/2/from and feature. The target is main.
  async function point(source: string, target: string) {
    for (const [ref, sha] of [
      ["refs/pull-requests/2/from", source],
      ["refs/heads/feature", source],
      ["refs/heads/main", target],
    ] as const)
      await g(["update-ref", ref, sha]);
  }
  const remote: GitRemote = { url: dir, sourceUrl: dir, sourceRef: "refs/heads/feature", targetRef: "refs/heads/main", fetchConfig: [] };
  return { commit, point, remote, env };
}

type Remote = Awaited<ReturnType<typeof remoteRepo>>;

const prAt = (sourceHead: string, targetHead: string): PullRequest => ({
  ref: { project: "PROJ", repo: "repo", id: 2 },
  version: 0,
  title: "t",
  state: "OPEN",
  author: { slug: "a", name: "A", login: "a" },
  reviewers: [],
  sourceHead,
  targetHead,
  sourceBranch: "feature",
  targetBranch: "main",
  updatedDate: 0,
});

let wsRuns = 0;
// One workspace at the given heads: its range, the changed files and the patch of BASE..HEAD as git_diff reads them, and the files of the validator diff.
async function workspace(root: string, r: Remote, source: string, target: string, since?: string) {
  await r.point(source, target);
  const ws = await prepareWorkspace({
    dataDir: join(root, "data"),
    runId: String(++wsRuns),
    pr: prAt(source, target),
    comments: [],
    remote: r.remote,
    ...(since !== undefined && { since }),
  });
  const range = (args: string[]) =>
    git([`--git-dir=${ws.cache}`, "diff", "-M", ...args, ws.rangeBase, ws.sourceHead], { env: gitEnv("/dev/null") });
  try {
    expect(existsSync(join(ws.context, "changes.patch")) || existsSync(join(ws.context, "files.txt"))).toBe(false);
    return {
      rangeBase: ws.rangeBase,
      mergeBase: ws.mergeBase,
      files: (await range(["--name-status"])).split("\n").filter(Boolean),
      patch: await range([]),
      validator: parseDiff(ws.diff).map((f) => f.path ?? f.oldPath),
    };
  } finally {
    await ws.remove();
  }
}

describe("range base", () => {
  test(
    "fast-forward: BASE..HEAD holds only the new commit, the validator diff the full change",
    async () => {
      const root = temp();
      const r = await remoteRepo(join(root, "remote"));
      const base = await r.commit([], { "src/app.ts": appText(), "README.md": "# Sample\n" });
      const target = await r.commit([base], { "docs/main.md": "main\n" });
      const s1 = await r.commit([base], { "src/app.ts": appText({ 3: "line 3 changed" }) });
      const s2 = await r.commit([s1], { "src/new.ts": NEW_FILE });
      const first = await workspace(root, r, s1, target);
      expect(first.rangeBase).toBe(first.mergeBase);
      expect(first.files).toEqual(["M\tsrc/app.ts"]);

      const ff = await workspace(root, r, s2, target, s1);
      expect([ff.mergeBase, ff.rangeBase]).toEqual([base, s1]);
      expect(ff.files).toEqual(["A\tsrc/new.ts"]);
      expect(ff.patch).toContain("export const x = 1;");
      expect(ff.patch).not.toContain("line 3 changed");
      expect(ff.validator).toEqual(["src/app.ts", "src/new.ts"]);
    },
    SLOW,
  );

  test(
    "rebase and a target merge into the source exclude target-only files; the range base commit is deterministic",
    async () => {
      const root = temp();
      const r = await remoteRepo(join(root, "remote"));
      const base = await r.commit([], { "src/app.ts": appText(), "README.md": "# Sample\n" });
      const t1 = await r.commit([base], { "docs/main.md": "main\n" });
      const s1 = await r.commit([base], { "src/app.ts": appText({ 3: "line 3 changed" }) });
      await workspace(root, r, s1, t1);

      // A rebase onto t1, then one more commit.
      const s1r = await r.commit([t1], { "src/app.ts": appText({ 3: "line 3 changed" }) });
      const s2r = await r.commit([s1r], { "src/new.ts": NEW_FILE });
      const rb = await workspace(root, r, s2r, t1, s1);
      expect(rb.mergeBase).toBe(t1);
      expect([s1, t1]).not.toContain(rb.rangeBase);
      expect(rb.files).toEqual(["A\tsrc/new.ts"]);
      expect(rb.patch).not.toContain("docs/main.md");
      expect(rb.validator).toEqual(["src/app.ts", "src/new.ts"]);
      expect((await workspace(root, r, s2r, t1, s1)).rangeBase).toBe(rb.rangeBase);

      // The target moves again and the source merges it, then one more commit.
      const t2 = await r.commit([t1], { "docs/two.md": "two\n" });
      const merge = await r.commit([s1, t2], { "docs/main.md": "main\n", "docs/two.md": "two\n" });
      const s3 = await r.commit([merge], { "src/new.ts": NEW_FILE });
      const mg = await workspace(root, r, s3, t2, s1);
      expect(mg.mergeBase).toBe(t2);
      expect(mg.files).toEqual(["A\tsrc/new.ts"]);
      expect(mg.validator).toEqual(["src/app.ts", "src/new.ts"]);
    },
    SLOW,
  );

  test(
    "a conflict and a missing object fall back to the full range",
    async () => {
      const root = temp();
      const r = await remoteRepo(join(root, "remote"));
      const base = await r.commit([], { "src/app.ts": appText() });
      const t1 = await r.commit([base], { "src/app.ts": appText({ 3: "line 3 target" }) });
      const s1 = await r.commit([base], { "src/app.ts": appText({ 3: "line 3 changed" }) });
      await workspace(root, r, s1, t1);

      // A rebase that resolves the conflict on line 3.
      const s1r = await r.commit([t1], { "src/app.ts": appText({ 3: "line 3 both" }) });
      const s2r = await r.commit([s1r], { "src/new.ts": NEW_FILE });
      const conflict = await workspace(root, r, s2r, t1, s1);
      expect([conflict.mergeBase, conflict.rangeBase]).toEqual([t1, t1]);
      expect(conflict.files).toEqual(["M\tsrc/app.ts", "A\tsrc/new.ts"]);

      const missing = await workspace(root, r, s2r, t1, "1234567890abcdef1234567890abcdef12345678");
      expect([missing.mergeBase, missing.rangeBase]).toEqual([t1, t1]);
      expect(missing.files).toEqual(["M\tsrc/app.ts", "A\tsrc/new.ts"]);
    },
    SLOW,
  );
});

describe("earlier findings", () => {
  // Line 1 is new, line 3 changes. The finding lines name lines at the earlier head.
  const DIFF = [
    "diff --git a/a.ts b/a.ts",
    "index 1111111..2222222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    "+new top",
    " one",
    "-two",
    "+two changed",
    " three",
    "",
  ].join("\n");
  const files = { newFiles: new Map([["a.ts", "new top\none\ntwo changed\nthree\n"]]), oldFiles: new Map([["a.ts", "one\ntwo\nthree\n"]]) };
  const stored = (line: number, anchorText: string): Finding => ({
    path: "a.ts",
    side: "new",
    line,
    lineEnd: null,
    anchorText,
    severity: "minor",
    category: "c",
    body: "b",
    evidence: "",
    evidenceStatus: "code",
    confidence: "high",
    agent: null,
    title: "",
    trigger: "",
    cause: null,
    rule: "",
    module: "core",
  });
  const verdict = (id: number, status: EarlierVerdict["status"], o: Partial<EarlierVerdict> = {}): EarlierVerdict => ({
    id,
    status,
    reason: `reason ${id}`,
    path: null,
    line: null,
    ...o,
  });

  test("verdict rules: unknown, second, and missing verdicts; open without code; fixed keeps its anchor; line override", () => {
    const items = [
      { id: 1, finding: stored(2, "two changed") },
      { id: 2, finding: stored(1, "gone text") },
      { id: 3, finding: stored(2, "two changed") },
      { id: 4, finding: stored(1, "one") },
      { id: 5, finding: stored(1, "three") },
      { id: 6, finding: stored(1, "gone text") },
    ];
    const earlier = [
      verdict(1, "open"),
      verdict(1, "fixed"),
      verdict(9, "open"),
      verdict(2, "open"),
      verdict(3, "fixed"),
      verdict(5, "open", { line: 4 }),
      verdict(6, "outdated"),
    ];
    const v = validateEarlier({ diff: DIFF, ...files, earlier, items });
    expect(v.skipped).toEqual([
      "Verdict for finding 1 dropped: a second verdict for the finding.",
      "Verdict for finding 9 dropped: the ID is not an earlier finding.",
      "Finding 4 has no verdict. It stays open.",
    ]);
    const rows = v.checked.map((c) => [c.id, c.verdict, c.reason, c.anchor && [c.anchor.line, c.anchor.state]]);
    expect(rows).toEqual([
      [1, "open", "reason 1", [3, "moved"]],
      [2, "outdated", CODE_GONE, null],
      [3, "fixed", "reason 3", [3, "moved"]],
      [4, "open", NO_VERDICT, [2, "moved"]],
      [5, "open", "reason 5", [4, "exact"]],
      [6, "outdated", "reason 6", null],
    ]);
  });
});

type Call = { argv: string[]; cwd: string; stdin: string };
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;
const carriedOf = (i: ReviewItemDto) => (i.payload as { carried?: Carried }).carried;

const finding = (line: number, o: Record<string, unknown> = {}) => ({
  path: "src/app.ts",
  side: "new",
  line,
  lineEnd: null,
  anchorText: `line ${line} changed`,
  severity: "minor",
  category: "Correctness",
  body: `FINDING-CANARY-${line} Fix line ${line}.`,
  evidence: "",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  ...o,
});
const LINES = [3, 10, 20, 30, 35];
// The base review: one finding per line in LINES and one question. The skipped file makes it incomplete.
const BASE_RESULT = {
  summary: "Five lines change.",
  risks: [],
  questions: [{ text: "QUESTION-CANARY Must the flush stay atomic?", why: "The description does not say." }],
  coverage: { read: [], skipped: ["src/big.bin"], unavailable: [], notChecked: [] },
  findings: LINES.map((l) => finding(l)),
};

async function setup() {
  const root = temp();
  const r = await remoteRepo(join(root, "remote"));
  const base = await r.commit([], { "src/app.ts": appText(), "README.md": "# Sample\n" }, "base");
  const target = await r.commit([base], { "docs/main.md": "main\n" }, "main moves");
  const edits = Object.fromEntries(LINES.map((l) => [l, `line ${l} changed`]));
  const s1 = await r.commit([base], { "src/app.ts": appText(edits) }, "feature");
  // Two lines on top move every line down by 2. Line 20 goes back, so its finding loses its code.
  const s2 = await r.commit(
    [s1],
    { "src/app.ts": appText({ ...edits, 20: "line 20" }, ["// header", "// more"]), "src/new.ts": NEW_FILE },
    "next",
  );
  await r.point(s1, target);

  const runner = fakeRunner(root);
  let streams = 0;
  const stream = (structured: unknown) => claudeStream(root, `s${streams++}`, "claude-synthetic/review-flat.jsonl", structured);
  runner.write({ fixture: stream(BASE_RESULT) });

  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: "http://127.0.0.1:9", userSlug: FAKE_USER, notifications: false, markAi: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const live = createLive();
  const review = createReviewJobs({
    settings,
    live,
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: async () => r.remote,
    listTools: stubListTools,
  });
  const app = createApp({ port: PORT, token: SESSION, live, settings, review });
  cleanup.unshift(async () => {
    await review.stop();
    db.close();
  });
  const { id: pr } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
        source_branch, target_branch, updated_date, on_dashboard, followed)
      VALUES ('PROJ', 'repo', 2, 'TITLE-CANARY', 'DESCRIPTION-CANARY', 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target,
        'feature', 'main', 1000, 1, 1) RETURNING id`,
    )
    .get({ source: s1, target }) as { id: number };

  const json = async <T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method,
      headers: HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const post = <T>(path: string, body: unknown = {}) => json<T>(path, body, "POST");
  const brief = (profile: string) => json(`/api/prs/${pr}/brief`, { note: "", profile }, "PUT");
  const finish = async (id: number) => {
    await review.wait();
    return (await json<RunDetail>(`/api/runs/${id}`)).body;
  };
  // A sync after a push: the remote and the stored PR row get the new source head.
  const push = async (head: string) => {
    await r.point(head, target);
    db.query("UPDATE pull_request SET source_head = $head WHERE id = $pr").run({ head, pr });
  };
  const record = join(root, "calls.jsonl");
  // The finder processes. A review run also starts the verify process (docs/plans/review-v2/spec.md section 1.6).
  const runCalls = (): Call[] =>
    readRecords<Call>(record).filter((c) => c.argv?.includes("-p") && !flag(c.argv, "--json-schema").includes('"verdicts"'));
  const reviewed = async () => {
    const cache = cachePath(realpathSync.native(dir), { project: "PROJ", repo: "repo", id: 2 });
    return (
      await git([`--git-dir=${cache}`, "rev-parse", "--verify", "--quiet", "refs/rl/2/reviewed"], { env: r.env }).catch(() => "")
    ).trim();
  };
  return { base, target, s1, s2, db, pr, runner, stream, json, post, brief, finish, push, runCalls, reviewed };
}

describe("re-review runs", () => {
  test(
    "409 cases, idempotency, the shared slot, the git MCP base, findings.md, and a cancel that carries nothing",
    async () => {
      const h = await setup();
      expect((await h.post("/api/prs/999/rereview")).status).toBe(404);
      const first = (await h.post<{ error: string }>(`/api/prs/${h.pr}/rereview`)).body;
      expect(first.error).toBe("Review the pull request first.");

      // An Explain run gives no base run.
      await h.brief("explain");
      const explain = await h.post<RunDto>(`/api/prs/${h.pr}/review`);
      expect((await h.finish(explain.body.id)).run.explain).toBe(true);
      const refused = await h.post<{ error: string }>(`/api/prs/${h.pr}/rereview`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain("Explain profile");
      await h.brief("general");
      expect((await h.post<{ error: string }>(`/api/prs/${h.pr}/rereview`)).body.error).toBe("Review the pull request first.");

      const base = await h.finish((await h.post<RunDto>(`/api/prs/${h.pr}/review`)).body.id);
      expect(base.run.status).toBe("incomplete");
      const same = await h.post<{ error: string }>(`/api/prs/${h.pr}/rereview`);
      expect(same.status).toBe(409);
      expect(same.body.error).toBe(`Run ${base.run.id} reviewed this source head. No new commits.`);

      await h.push(h.s2);
      h.runner.write({ fixture: h.stream(BASE_RESULT), hang: true });
      const a = await h.post<RunDto>(`/api/prs/${h.pr}/rereview`);
      expect(a.status).toBe(202);
      expect(a.body).toMatchObject({ kind: "review", status: "running", since: { head: h.s1, incremental: false } });
      const again = await h.post<RunDto>(`/api/prs/${h.pr}/rereview`);
      expect([again.status, again.body.id]).toEqual([200, a.body.id]);
      const slot = await h.post<RunConflict>(`/api/prs/${h.pr}/review`);
      expect(slot.status).toBe(409);
      expect(slot.body.running).toEqual({ run: a.body.id, pr: h.pr, kind: "review" });

      expect(await waitFor(() => h.runCalls().length === 3)).toBe(true);
      const c = h.runCalls()[2] as Call;
      const mcp = JSON.parse(readFileSync(flag(c.argv, "--mcp-config"), "utf8"));
      expect(mcp.mcpServers["rl-git"].args).toContain(`--base=${h.s1}`);
      expect(JSON.parse(flag(c.argv, "--json-schema")).properties.earlier).toBeDefined();
      const findings = readFileSync(join(c.cwd, "context", "findings.md"), "utf8");
      expect(findings.startsWith(UNTRUSTED)).toBe(true);
      const ids = base.items.filter((i) => i.kind === "finding").map((i) => i.id);
      for (const id of ids) expect(findings).toContain(`## Finding ${id}\n`);
      expect(findings).toContain(`- Lines: 3 at ${h.s1}`);
      expect(findings).toContain("    line 3 changed");
      expect(findings).toContain("    FINDING-CANARY-3 Fix line 3.");
      expect(c.stdin).toContain(`Earlier findings: ${ids.join(", ")}\n`);
      expect(c.stdin).toContain(`Review the change ${h.s1}..${h.s2} in ./repo.`);
      for (const canary of ["FINDING-CANARY", "QUESTION-CANARY", "DESCRIPTION-CANARY"]) expect(c.stdin).not.toContain(canary);

      expect((await h.post(`/api/runs/${a.body.id}/cancel`)).status).toBe(202);
      const done = await h.finish(a.body.id);
      expect([done.run.status, done.items]).toEqual(["cancelled", []]);
      // The range base is stored when the workspace is ready. A fast-forward reviews only the new commits.
      expect(done.run.since).toEqual({ head: h.s1, incremental: true });
      const sources = (await h.json<RunDetail>(`/api/runs/${base.run.id}`)).body.items;
      expect(sources.map((i) => [i.status, i.revision])).toEqual(sources.map(() => ["new", 0]));

      // A cancelled re-review does not move the base.
      h.runner.write({ fixture: h.stream(BASE_RESULT) });
      const b = await h.post<RunDto>(`/api/prs/${h.pr}/rereview`);
      expect([b.status, b.body.since?.head]).toEqual([202, h.s1]);
      expect((await h.finish(b.body.id)).run.status).not.toBe("cancelled");
    },
    SLOW,
  );

  test(
    "a re-review carries open items, closes fixed and outdated ones, skips items changed during the run, and posts once",
    async () => {
      const h = await setup();
      await h.brief("general");
      const base = await h.finish((await h.post<RunDto>(`/api/prs/${h.pr}/review`)).body.id);
      expect(base.run.status).toBe("incomplete");
      expect(await h.reviewed()).toBe(h.s1);
      const at = (line: number) => base.items.find((i) => i.kind === "finding" && i.anchor?.line === line) as ReviewItemDto;
      const question = base.items.find((i) => i.kind === "question") as ReviewItemDto;
      const fa = at(3);
      const edited = await h.post<ReviewItemDto>(`/api/items/${fa.id}`, {
        action: "edit",
        revision: fa.revision,
        body: "EDITED-CANARY Lock once.",
      });
      expect(edited.body).toMatchObject({ status: "accepted", edited: true, revision: 1 });

      await h.push(h.s2);
      const verdict = (line: number, status: string, reason: string) => ({ id: at(line).id, status, reason, path: null, line: null });
      h.runner.write({
        fixture: h.stream(BASE_RESULT),
        delayMs: 100,
        rereview: {
          summary: "One new finding.",
          risks: [],
          questions: [{ text: "Does x need a test?", why: "No test covers it." }],
          coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
          findings: [finding(1, { path: "src/new.ts", anchorText: "export const x = 1;", body: "Export x only when needed." })],
          earlier: [
            verdict(3, "open", "The lock is still per entry."),
            verdict(10, "fixed", "The new commit fixes it."),
            verdict(20, "open", "Still there."),
            verdict(35, "open", "Still there."),
            { id: 99999, status: "fixed", reason: "Unknown.", path: null, line: null },
          ],
        },
      });
      const started = await h.post<RunDto>(`/api/prs/${h.pr}/rereview`);
      expect(started.status).toBe(202);
      // The user posts one item while the run is on.
      expect(await waitFor(() => h.runCalls().length === 2)).toBe(true);
      h.db.query("UPDATE review_item SET status = 'posted' WHERE id = $id").run({ id: at(35).id ?? 0 });
      const d = await h.finish(started.body.id);

      // findings: the new one and the two open carried ones. Fixed and outdated copies do not count.
      expect(d.run).toMatchObject({
        kind: "review",
        status: "incomplete",
        sourceHead: h.s2,
        since: { head: h.s1, incremental: true },
        findings: 3,
      });
      const coverage = d.run.summary?.coverage;
      expect(coverage?.skipped).toEqual([
        "Verdict for finding 99999 dropped: the ID is not an earlier finding.",
        `Finding ${at(30).id} has no verdict. It stays open.`,
      ]);
      // docs/plans/review-v2/spec.md section 1.3: the target branch has no CLAUDE.md, so the rules check of Review adds nothing.
      expect(coverage?.notChecked).toEqual([
        `Run ${base.run.id}, the base of this re-review, was incomplete.`,
        "Project rules: no instructions loaded.",
      ]);
      const stdin = h.runCalls()[1]?.stdin ?? "";
      expect(stdin).toContain(`Earlier findings: ${LINES.map((l) => at(l).id).join(", ")}\n`);
      for (const canary of ["FINDING-CANARY", "EDITED-CANARY", "QUESTION-CANARY"]) expect(stdin).not.toContain(canary);

      // New findings, open carried findings, questions, closed carried findings.
      expect(d.items.map((i) => [i.kind, carriedOf(i)?.from ?? null, carriedOf(i)?.verdict ?? null, i.status])).toEqual([
        ["finding", null, null, "new"],
        ["finding", fa.id, "open", "accepted"],
        ["finding", at(30).id, "open", "new"],
        ["question", null, null, "new"],
        ["question", question.id, "open", "new"],
        ["finding", at(10).id, "fixed", "discarded"],
        ["finding", at(20).id, "outdated", "discarded"],
      ]);
      const [open, missing, fixed, gone] = [1, 2, 5, 6].map((n) => d.items[n]) as [
        ReviewItemDto,
        ReviewItemDto,
        ReviewItemDto,
        ReviewItemDto,
      ];
      // The validator diff is MB..head: line 5 is an added line there, a context line in the range diff.
      expect(open).toMatchObject({
        body: "EDITED-CANARY Lock once.",
        edited: true,
        anchor: { path: "src/app.ts", line: 5, state: "moved" },
      });
      expect(open.anchor?.excerpt.find((l) => l.n === 5)?.kind).toBe("add");
      expect(carriedOf(open)).toEqual({
        from: fa.id,
        verdict: "open",
        reason: "The lock is still per entry.",
        since: h.s1,
      });
      expect([missing.anchor?.line, carriedOf(missing)?.reason]).toEqual([32, NO_VERDICT]);
      expect([fixed.anchor?.line, fixed.anchor?.state]).toEqual([12, "moved"]);
      expect([gone.anchor, carriedOf(gone)?.reason]).toEqual([null, CODE_GONE]);

      // Each carried source is discarded with a new revision. The item posted during the run stays posted.
      const sources = (await h.json<RunDetail>(`/api/runs/${base.run.id}`)).body.items;
      const was = new Map(base.items.map((i) => [i.id, i.revision]));
      expect(sources.map((i) => [i.id, i.status, i.revision - (was.get(i.id) ?? 0)])).toEqual(
        base.items.map((i) => [i.id, i.id === at(35).id ? "posted" : "discarded", i.id === at(35).id ? 0 : i.id === fa.id ? 2 : 1]),
      );

      // A finding without an anchor cannot come back. One with an anchor can.
      for (const body of [
        { action: "restore", revision: gone.revision },
        { action: "accept", revision: gone.revision },
        { action: "edit", revision: gone.revision, body: "x" },
        { action: "move", revision: gone.revision, line: 1 },
      ])
        expect((await h.post(`/api/items/${gone.id}`, body)).status).toBe(400);
      expect((await h.post<ReviewItemDto>(`/api/items/${fixed.id}`, { action: "restore", revision: fixed.revision })).body.status).toBe(
        "new",
      );

      // The accepted carried item posts once, at the new heads.
      const plan = (await h.json<PostPlanDto>(`/api/prs/${h.pr}/post-plan`)).body.posts;
      expect(plan.map((p) => [p.run, p.sourceHead, p.destination.kind, p.items.map((i) => i.id)])).toEqual([
        [d.run.id, h.s2, "inline", [open.id]],
      ]);
      expect(plan[0]?.destination).toMatchObject({ path: "src/app.ts", line: 5 });
      expect(await h.reviewed()).toBe(h.s2);
    },
    SLOW,
  );
});

describe("resolve proposals", () => {
  test(
    "a fixed verdict on my posted finding proposes to resolve its thread; an open draft, a resolved thread, or another person's thread gets none",
    async () => {
      const h = await setup();
      await h.brief("general");
      const base = await h.finish((await h.post<RunDto>(`/api/prs/${h.pr}/review`)).body.id);
      const at = (line: number) => base.items.find((i) => i.kind === "finding" && i.anchor?.line === line) as ReviewItemDto;
      // Four posted inline findings. 9003 is resolved already. Another person started 9004 (a reply of mine cannot start a thread).
      const posted: [number, number, string, number][] = [
        [3, 9001, FAKE_USER, 0],
        [10, 9002, FAKE_USER, 0],
        [20, 9003, FAKE_USER, 1],
        [30, 9004, "asmith", 0],
      ];
      for (const [line, root, author, resolved] of posted) {
        const it = at(line);
        h.db.query("UPDATE review_item SET status = 'posted' WHERE id = $id").run({ id: it.id });
        h.db
          .query(
            `INSERT INTO post (pr, run, kind, idem_key, body, destination_json, items_json, state, remote_id, remote_version, created_at, updated_at)
            VALUES ($pr, $run, 'inline', $key, $body, '{}', $items, 'confirmed', $root, 0, 1, 1)`,
          )
          .run({ pr: h.pr, run: base.run.id, key: `k${root}`, body: it.body, items: JSON.stringify([{ id: it.id, revision: 0 }]), root });
        h.db
          .query(
            `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, author_name, text, thread_resolved, created_at, updated_at)
            VALUES ($pr, $root, 0, NULL, $root, $author, $author, $body, $resolved, 5, 5)`,
          )
          .run({ pr: h.pr, root, author, body: it.body, resolved });
      }
      // An open reply draft of mine in thread 9002.
      h.db
        .query(
          `INSERT INTO review_item (run, kind, payload_json, body, status, thread) VALUES ($run, 'reply', $payload, 'Mine.', 'new', 9002)`,
        )
        .run({
          run: base.run.id,
          payload: JSON.stringify({ thread: 9002, action: "reply", body: "Mine.", reason: "R.", evidenceStatus: "code", replyTo: 9002 }),
        });

      await h.push(h.s2);
      const fixed = (line: number) => ({
        id: at(line).id,
        status: "fixed",
        reason: `Line ${line} is fixed at src/app.ts:${line + 2}.`,
        path: null,
        line: null,
      });
      h.runner.write({
        fixture: h.stream(BASE_RESULT),
        rereview: {
          summary: "No new findings.",
          risks: [],
          questions: [],
          coverage: { read: [], skipped: [], unavailable: [], notChecked: [] },
          findings: [],
          earlier: [fixed(3), fixed(10), fixed(30), { id: at(35).id, status: "open", reason: "Still there.", path: null, line: null }],
        },
      });
      const d = await h.finish((await h.post<RunDto>(`/api/prs/${h.pr}/rereview`)).body.id);
      const stdin = h.runCalls()[1]?.stdin ?? "";
      expect(stdin).toContain(`Earlier findings: ${[35, 30, 10, 3].map((l) => at(l).id).join(", ")}\n`);
      expect(stdin).toContain(
        `Posted findings: ${[30, 10, 3].map((l) => at(l).id).join(", ")}. The user posted each one as a review thread.`,
      );
      expect(d.run.summary?.coverage.skipped).toEqual([]);

      const replies = d.items.filter((i) => i.kind === "reply");
      expect(replies.map((i) => [i.status, i.body, (i.payload as ReplyPayload).thread])).toEqual([["new", "", 9001]]);
      expect(replies[0]?.payload).toMatchObject({
        action: "none",
        replyTo: 9001,
        resolve: true,
        resolveEvidence: "Line 3 is fixed at src/app.ts:5.",
        resolveTick: true,
      });
      // The posted findings keep their status. Only the carried one gets a copy.
      expect(d.items.filter((i) => i.kind === "finding").map((i) => carriedOf(i)?.from)).toEqual([at(35).id]);
      const drafts = (await h.json<ReviewItemDto[]>(`/api/prs/${h.pr}/reply-drafts`)).body;
      expect(drafts.map((i) => [(i.payload as ReplyPayload).thread, i.body])).toEqual([
        [9001, ""],
        [9002, "Mine."],
      ]);

      // Accept: the plan resolves thread 9001 without a reply.
      const proposal = replies[0] as ReviewItemDto;
      expect((await h.post(`/api/items/${proposal.id}`, { action: "accept", revision: 0 })).status).toBe(200);
      const plan = (await h.json<PostPlanDto>(`/api/prs/${h.pr}/post-plan`)).body.posts;
      expect(plan.map((p) => [p.destination, p.body, p.resolve])).toEqual([[{ kind: "reply", parentId: 9001 }, "", 9001]]);
    },
    SLOW,
  );
});
