// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.22.4 (WP-PQ2, AC-B96): context/related-work.md of a spec run. A temp git repository as the
// task cache and a stub provider. No test reaches a forge.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitEnv } from "../../src/server/review/git";
import { cachePath } from "../../src/server/review/workspace";
import { openDb } from "../../src/server/storage/db";
import { type RelatedDeps, relatedWorkFile } from "../../src/server/tasks/related";
import { RELATED_BYTES } from "../../src/shared/task";
import { IDENTITY } from "./fixture";

console.log(`related.test.ts imported from ${Bun.resolveSync("../../src/server/tasks/related", import.meta.dir)}`);

const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const SLOW = 60_000;
const T = { id: 1, project: "PROJ", repo: "app", branch: "develop" };

// The cache of PROJ/app with commits that name ABC-12, ABC-120, abc-12, and the parent ABC-10, plus a merge commit.
async function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-pq2-")));
  dirs.push(root);
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = { ...gitEnv(empty), ...IDENTITY };
  const work = join(root, "work");
  mkdirSync(join(work, "src"), { recursive: true });
  const g = (...args: string[]) => git(["-C", work, ...args], { env });
  await g("init", "-q", "-b", "develop");
  const commit = async (msg: string, files: string[] = []) => {
    for (const f of files) writeFileSync(join(work, f), `${msg}\n`);
    await g("add", "-A");
    await g("commit", "-q", "--allow-empty", "-m", msg);
  };
  await commit("Start", ["README.md"]);
  for (let i = 0; i < 22; i++) await commit(`ABC-10 step ${i}`);
  await commit(
    "ABC-12 Add the parser",
    Array.from({ length: 12 }, (_, i) => `src/p${String(i).padStart(2, "0")}.ts`),
  );
  await commit("ABC-120 Other work", ["src/other.ts"]);
  await commit("abc-12 lower case", ["src/lower.ts"]);
  await g("checkout", "-q", "-b", "feature/ABC-12-fix");
  await commit("Fix the empty input", ["src/fix.ts"]);
  await g("checkout", "-q", "develop");
  await g("merge", "-q", "--no-ff", "-m", "Merge pull request #41 in PROJ/app from feature/ABC-12-fix to develop", "feature/ABC-12-fix");
  const head = (await g("rev-parse", "HEAD")).trim();
  const dataDir = join(root, "data");
  const cache = cachePath(dataDir, { ...T, id: 1 });
  mkdirSync(join(dataDir, "git", "PROJ"), { recursive: true });
  await git(["clone", "-q", "--bare", work, cache], { env });
  const db = openDb(join(dataDir, "db-0123456789abcdef.sqlite"));
  cleanup.push(() => db.close());
  return { db, dataDir, head };
}

const pr = (id: number, title: string, branch: string) => ({
  ref: { project: "PROJ", repo: "app", id },
  title,
  sourceBranch: branch,
  targetBranch: "develop",
});

// A stub of the three reads. fail: the reads that throw once.
function stub(fail: Set<string> = new Set()) {
  const calls: string[] = [];
  const once = (name: string) => {
    calls.push(name);
    if (fail.delete(name)) throw new Error(`HTTP 500 from https://bb.example.invalid/${encodeURIComponent(name)}`);
  };
  const provider: NonNullable<RelatedDeps["provider"]> = {
    listOpenPullRequests: async () => {
      once("open");
      return {
        items: [pr(45, "ABC-12: Fix the empty input", "feature/ABC-12-fix"), pr(46, "ABC-120 other", "feature/ABC-120")],
        complete: true,
      } as never;
    },
    mergedPullRequests: async () => {
      once("merged");
      return [
        {
          id: 41,
          title: "Add the parser",
          author: { slug: "x" },
          branch: "feature/ABC-12-parser",
          target: "develop",
          createdDate: 1,
          closedDate: 2,
        },
      ] as never;
    },
    listBranches: async (_p, _r, filter) => {
      once(`branches ${filter}`);
      return {
        branches: ["feature/ABC-12-fix", "feature/ABC-12-spike", "feature/ABC-120-x", "bugfix/abc-12"].map((name) => ({
          name,
          isDefault: false,
        })),
        more: false,
      };
    },
  };
  return { provider, calls };
}

test(
  "AC-B96: commits, PRs, and branches by the key as a whole token; caps; the stored row shows once with the live state",
  async () => {
    const h = await setup();
    // A stored row of PR 41 with an old state, and a declined PR that only the store knows.
    for (const [id, state, title, branch] of [
      [41, "OPEN", "ABC-12 Add the parser", "feature/ABC-12-parser"],
      [30, "DECLINED", "Try ABC-12", "spike/ABC-12"],
      [31, "MERGED", "ABC-120 Other", "feature/ABC-120"],
    ] as const)
      h.db
        .query(
          "INSERT INTO pull_request (project, repo, pr_id, title, state, source_branch, target_branch) VALUES ('PROJ', 'app', $id, $title, $state, $branch, 'develop')",
        )
        .run({ id, title, state, branch });
    const s = stub();
    const f = await relatedWorkFile(h.db, { provider: s.provider, dataDir: h.dataDir }, T, h.head, ["ABC-12", "ABC-10"]);
    expect(f.name).toBe("related-work.md");
    const text = f.text;
    const [own = "", parent = ""] = text.split("## ABC-10 (parent)");
    expect(text.startsWith("# Earlier work that names ABC-12\n")).toBe(true);
    expect(own).toContain("### Commits on develop");
    const commits = own.split("\n").filter((l) => /^- [0-9a-f]{12} \d{4}-\d{2}-\d{2} /.test(l));
    expect(commits.map((l) => l.replace(/^- [0-9a-f]{12} \S+ /, ""))).toEqual([
      "Merge pull request #41 in PROJ/app from feature/ABC-12-fix to develop",
      "ABC-12 Add the parser · src/p00.ts, src/p01.ts, src/p02.ts, src/p03.ts, src/p04.ts, src/p05.ts, src/p06.ts, src/p07.ts, src/p08.ts, src/p09.ts, +2 more",
    ]);
    expect(own).not.toContain("ABC-120");
    expect(own).not.toContain("abc-12");
    expect(own).toContain(
      [
        "### Pull requests",
        "- #45 OPEN · feature/ABC-12-fix → develop · ABC-12: Fix the empty input",
        "- #41 MERGED · feature/ABC-12-parser → develop · Add the parser",
        "- #30 DECLINED · spike/ABC-12 → develop · Try ABC-12",
      ].join("\n"),
    );
    // The branch of PR 45 is listed, so only the spike stays.
    expect(own).toContain("### Branches without a listed PR\n- feature/ABC-12-spike");
    expect(own).not.toContain("- feature/ABC-12-fix\n");
    // The parent: 22 commits name ABC-10, and the cap keeps 20.
    expect(parent.split("\n").filter((l) => / ABC-10 step /.test(l))).toHaveLength(20);
    expect(parent).toContain(" ABC-10 step 21\n");
    expect(parent).not.toContain(" ABC-10 step 1\n");
    expect(parent).not.toContain(" ABC-10 step 0");
    expect(s.calls).toEqual(["open", "merged", "branches ABC-12", "branches ABC-10"]);
  },
  SLOW,
);

test(
  "each failed read gives one line without its URL; no provider searches only the commits; nothing found",
  async () => {
    const h = await setup();
    for (const name of ["open", "merged", "branches ABC-12"]) {
      const s = stub(new Set([name]));
      const text = (await relatedWorkFile(h.db, { provider: s.provider, dataDir: h.dataDir }, T, h.head, ["ABC-12"])).text;
      const line = {
        open: "The app could not read the open PRs: HTTP 500 from [url]",
        merged: "The app could not read the merged PRs: HTTP 500 from [url]",
        "branches ABC-12": "The app could not read the branches of ABC-12: HTTP 500 from [url]",
      }[name];
      expect(text.split("\n").filter((l) => l.startsWith("The app could not"))).toEqual([line as string]);
      expect(text).toContain("ABC-12 Add the parser");
    }
    const none = (await relatedWorkFile(h.db, { provider: null, dataDir: h.dataDir }, T, h.head, ["ABC-12", "ABC-99"])).text;
    expect(none).toContain("Configure the Bitbucket URL and token first. The app searched only the commits.");
    expect(none).toContain("ABC-12 Add the parser");
    expect(none.endsWith("## ABC-99 (parent)\n\nNo commit, PR, or branch names ABC-99.")).toBe(true);
    // A head that the cache does not hold: the commit read fails with one line, and the file still comes.
    const bad = (await relatedWorkFile(h.db, { provider: null, dataDir: h.dataDir }, T, "0".repeat(40), ["ABC-12"])).text;
    expect(bad).toContain("The app could not read the commits of ABC-12: git log failed");
    expect(bad).not.toContain("No commit, PR, or branch names");
  },
  SLOW,
);

test(
  "the file stays at most 16 KB and ends with the cut line at a line end",
  async () => {
    const h = await setup();
    const long = "x".repeat(900);
    const s = stub();
    s.provider.listOpenPullRequests = async () =>
      ({ items: Array.from({ length: 20 }, (_, i) => pr(100 + i, `ABC-12 ${long}`, `feature/ABC-12-${i}`)), complete: true }) as never;
    const text = (await relatedWorkFile(h.db, { provider: s.provider, dataDir: h.dataDir }, T, h.head, ["ABC-12", "ABC-10"])).text;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(RELATED_BYTES);
    expect(text.endsWith("\nThe app cut this file at 16 KB.")).toBe(true);
    expect(text.split("\n").at(-2)).toMatch(/^- #\d+ OPEN .* x+$/);
  },
  SLOW,
);
