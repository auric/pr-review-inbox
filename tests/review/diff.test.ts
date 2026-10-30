// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 S-DIFF: the diff API with temp git repositories and a file remote. No test reaches the network.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { git, gitEnv } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import type { GitRemote } from "../../src/server/review/workspace";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { SyncEngine } from "../../src/server/sync/engine";
import type { ApiError, DiffFetchNeeded, DiffIndexDto, DiffPageDto, RunDetail, RunDto } from "../../src/shared/dto";
import { claudeStream, fakeRunner, REVIEW_RESULT, stubListTools } from "../support/review-fixture";

const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "d".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const TOKEN = "rl-diff-token-7c1e40b2";
const APP = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
const NAME = `${Array.from({ length: 20 }, (_, i) => `export const n${i} = ${i};`).join("\n")}\n`;
const BIG = `${Array.from({ length: 2500 }, (_, i) => (i === 0 ? "x".repeat(3000) : `big ${i}`)).join("\n")}\n`;

process.env.REVIEW_LOOP_SECRETS = "memory";

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Entry = string | Buffer | null;

// A bare remote. Commits go through a temp index. null removes a path.
async function remoteRepo(root: string) {
  mkdirSync(root, { recursive: true });
  const empty = join(root, "author.gitconfig");
  writeFileSync(empty, "");
  const remote = join(root, "remote.git");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_INDEX_FILE: join(root, "author.index"),
  };
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", remote, ...args], { env, stdin })).trim();
  await git(["init", "-q", "--bare", "--template=", remote], { env });
  let n = 0;
  async function commit(parent: string | null, files: Record<string, Entry>) {
    await g(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
    const info: string[] = [];
    for (const [path, v] of Object.entries(files)) {
      if (v === null) {
        info.push(`0 ${"0".repeat(40)}\t${path}`);
        continue;
      }
      const f = join(root, `blob-${n++}`);
      writeFileSync(f, v);
      info.push(`100644 ${await g(["hash-object", "-w", "--no-filters", f])}\t${path}`);
    }
    await g(["update-index", "--index-info"], `${info.join("\n")}\n`);
    return g(["commit-tree", await g(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", "change"]);
  }
  const base = await commit(null, {
    "src/app.ts": APP,
    "old/name.ts": NAME,
    "gone.txt": "bye\n",
    "img.bin": Buffer.from([0, 1, 2, 3, 0, 255]),
  });
  const target = await commit(base, { "docs/main.md": "main\n" });
  const source = await commit(base, {
    "src/app.ts": APP.replace("line 3\n", "line 3 changed\n"),
    "old/name.ts": null,
    "new/name.ts": NAME.replace("n19 = 19", "n19 = 190"),
    "gone.txt": null,
    "img.bin": Buffer.from([0, 9, 9, 9, 0, 255]),
    "big.txt": BIG,
  });
  // 33 MB of changed lines: the diff text is over the 32 MB cap.
  const huge = await commit(source, { "huge.txt": "y".repeat(99).concat("\n").repeat(340_000) });
  for (const [ref, sha] of [
    ["refs/heads/main", target],
    ["refs/heads/feature", source],
    ["refs/pull-requests/2/from", source],
  ] as const)
    await g(["update-ref", ref, sha]);
  return { remote, base, target, source, huge, g };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rl-diff-"));
  dirs.push(root);
  const repo = await remoteRepo(join(root, "remote"));
  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: "http://127.0.0.1:9", userSlug: "jdoe", notifications: false });
  const secrets = createSecrets(null);
  await secrets.set(TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const { id: pr } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, author_slug, author_name, my_role, state, source_head, target_head,
        source_branch, target_branch, updated_date, on_dashboard, followed)
      VALUES ('PROJ', 'repo', 2, 'Diff', 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target, 'feature', 'main', 1000, 1, 1) RETURNING id`,
    )
    .get({ source: repo.source, target: repo.target }) as { id: number };

  const runner = fakeRunner(root);
  runner.write({ fixture: claudeStream(root, "run", "claude/b9-wp8-flags.jsonl", REVIEW_RESULT) });
  const fileRemote: GitRemote = {
    url: repo.remote,
    sourceUrl: repo.remote,
    sourceRef: "refs/heads/feature",
    targetRef: "refs/heads/main",
    fetchConfig: [["http.extraHeader", `Authorization: Bearer ${TOKEN}`]],
  };
  const remote = { value: fileRemote };
  const live = createLive();
  const sync = {
    start() {},
    stop() {},
    async syncNow() {},
    status: () => ({ running: false, state: "ok", lastCompleteAt: 5, nextAt: null, error: null }),
    onTaskPrs() {},
  } satisfies SyncEngine;
  const review = createReviewJobs({
    settings,
    live,
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: async () => remote.value,
    listTools: stubListTools,
  });
  const app = createApp({ port: PORT, token: SESSION, live, settings, sync, review });
  cleanup.unshift(async () => {
    await review.stop();
    db.close();
  });
  const json = async <T>(path: string, method = "GET") => {
    const res = await app.request(`${ORIGIN}/api/prs/${pr}${path}`, { method, headers: HEADERS });
    return { status: res.status, body: (await res.json()) as T };
  };
  const setHeads = (source: string, target = repo.target) =>
    db.query("UPDATE pull_request SET source_head = $source, target_head = $target WHERE id = $pr").run({ source, target, pr });
  return { root, dir, repo, db, pr, review, remote, json, setHeads };
}

describe("diff API", () => {
  test(
    "GET needs a fetch, POST fetches, then GET reads the cache",
    async () => {
      const h = await setup();
      const before = await h.json<DiffFetchNeeded>("/diff");
      expect(before.status).toBe(409);
      expect(before.body.fetch).toBe(true);

      const fetched = await h.json<DiffIndexDto>("/diff/fetch", "POST");
      expect(fetched.status).toBe(200);
      expect(fetched.body).toMatchObject({ sourceHead: h.repo.source, targetHead: h.repo.target, mergeBase: h.repo.base });

      const after = await h.json<DiffIndexDto>("/diff");
      expect(after.status).toBe(200);
      expect(after.body).toEqual(fetched.body);

      // A head that the cache does not hold needs a new fetch.
      h.setHeads(h.repo.huge);
      expect((await h.json<DiffFetchNeeded>("/diff")).body).toMatchObject({ fetch: true });
      expect((await h.json<DiffFetchNeeded>("/diff/file?path=src/app.ts")).body).toMatchObject({ fetch: true });
    },
    SLOW,
  );

  test(
    "the index counts a rename, a binary, a deleted, and an added file",
    async () => {
      const h = await setup();
      const { body } = await h.json<DiffIndexDto>("/diff/fetch", "POST");
      const byPath = new Map(body.files.map((f) => [f.path ?? f.oldPath, f]));
      expect(byPath.get("src/app.ts")).toEqual({ path: "src/app.ts", oldPath: "src/app.ts", binary: false, added: 1, removed: 1, rows: 7 });
      expect(byPath.get("new/name.ts")).toMatchObject({ path: "new/name.ts", oldPath: "old/name.ts", binary: false, added: 1, removed: 1 });
      expect(byPath.get("img.bin")).toEqual({ path: "img.bin", oldPath: "img.bin", binary: true, added: 0, removed: 0, rows: 0 });
      expect(byPath.get("gone.txt")).toEqual({ path: null, oldPath: "gone.txt", binary: false, added: 0, removed: 1, rows: 1 });
      expect(byPath.get("big.txt")).toEqual({ path: "big.txt", oldPath: null, binary: false, added: 2500, removed: 0, rows: 2500 });
      expect(body.files).toHaveLength(5);
    },
    SLOW,
  );

  test(
    "file pages hold 1,000 rows and cut long lines",
    async () => {
      const h = await setup();
      await h.json("/diff/fetch", "POST");
      const pages: DiffPageDto[] = [];
      for (let start: number | null = 0; start !== null; ) {
        const r: { status: number; body: DiffPageDto } = await h.json<DiffPageDto>(`/diff/file?path=big.txt&start=${start}`);
        expect(r.status).toBe(200);
        pages.push(r.body);
        start = r.body.next;
      }
      expect(pages.map((p) => [p.start, p.next, p.rows.length])).toEqual([
        [0, 1000, 1000],
        [1000, 2000, 1000],
        [2000, null, 500],
      ]);
      expect(pages[0]?.rows[0]).toEqual({ kind: "add", old: 1, new: 1, text: "x".repeat(2000) });
      expect(pages[2]?.rows.at(-1)).toEqual({ kind: "add", old: 1, new: 2500, text: "big 2499" });

      const gone = await h.json<DiffPageDto>("/diff/file?path=gone.txt");
      expect(gone.body).toMatchObject({ path: null, oldPath: "gone.txt", next: null, rows: [{ kind: "del", old: 1, text: "bye" }] });
      expect((await h.json<ApiError>("/diff/file?path=nope.ts")).status).toBe(404);
      expect((await h.json<ApiError>("/diff/file?path=old/name.ts")).status).toBe(404);
      expect((await h.json<ApiError>("/diff/file?path=big.txt&start=2500")).status).toBe(400);
      expect((await h.json<ApiError>("/diff/file?path=big.txt&start=-1")).status).toBe(400);
      expect((await h.json<ApiError>("/diff/file")).status).toBe(400);
    },
    SLOW,
  );

  test(
    "a fetch runs next to a review run on the same cache",
    async () => {
      const h = await setup();
      const [run, fetched] = await Promise.all([h.json<RunDto>("/review", "POST"), h.json<DiffIndexDto>("/diff/fetch", "POST")]);
      expect(run.status).toBe(202);
      expect(fetched).toMatchObject({ status: 200 });
      await h.review.wait();
      const detail = h.review.run(h.db, run.body.id) as RunDetail;
      expect(detail.run.errorKind).toBeNull();
      expect(["completed", "incomplete"]).toContain(detail.run.status);
    },
    SLOW,
  );

  test(
    "a moved head asks for a sync, and a diff over 32 MB is refused",
    async () => {
      const h = await setup();
      h.setHeads(h.repo.target);
      const moved = await h.json<ApiError>("/diff/fetch", "POST");
      expect(moved.status).toBe(409);
      expect(moved.body.error).toContain("Sync first");

      await h.repo.g(["update-ref", "refs/pull-requests/2/from", h.repo.huge]);
      h.setHeads(h.repo.huge);
      const big = await h.json<ApiError>("/diff/fetch", "POST");
      expect(big.status).toBe(409);
      expect(big.body.error).toContain("too large");
      expect((await h.json<ApiError>("/diff")).body.error).toContain("too large");
    },
    SLOW,
  );

  test(
    "a git error shows no URL and no token",
    async () => {
      const h = await setup();
      // Port 9 on loopback refuses the connection. No request leaves the machine.
      h.remote.value = {
        ...h.remote.value,
        url: "http://127.0.0.1:9/scm/proj/repo.git",
        sourceUrl: "http://127.0.0.1:9/scm/proj/repo.git",
      };
      const r = await h.json<ApiError>("/diff/fetch", "POST");
      expect(r.status).toBe(502);
      expect(r.body.error).not.toContain(TOKEN);
      expect(r.body.error).not.toContain("http://");
    },
    SLOW,
  );
});
