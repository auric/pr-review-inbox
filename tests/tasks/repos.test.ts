// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.16.5 and 6.16.6 (WP-MR1, AC-B33 to AC-B37): the gitlinks and .gitmodules of a commit, the URL
// mapping without guesses, the access table, the snapshot folders, the nested worktrees, the path check per repository, the commits
// with the parent gitlink, and the line budget without gitlinks. Temp bare remotes and the fake Bitbucket only.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTaskWorkspace } from "../../src/server/review/workspace";
import { openDb } from "../../src/server/storage/db";
import { commitTask, treeCheck, undoTrees } from "../../src/server/tasks/implement";
import { changedLines } from "../../src/server/tasks/loop";
import { largeRepoProblem } from "../../src/server/tasks/plan";
import {
  candidate,
  hostOf,
  normalizeUrl,
  readGitlinks,
  relativeUrl,
  repoDtos,
  resolveTaskRepos,
  taskRepos,
} from "../../src/server/tasks/repos";
import { headOf, openRepoTrees, openWorktree, type RepoTree, resetTrees, status, wtGit } from "../../src/server/tasks/worktree";
import { LARGE_REPOS_TEXT, REPO_REASON } from "../../src/shared/task";
import { type FakeBitbucket, startFakeBitbucket } from "../support/fake-bitbucket";
import { depsOf, gitmodules, type MultiOptions, mainCache, multiRepo, OTHER_URL } from "./repos-fixture";

for (const m of ["tasks/repos", "tasks/worktree", "tasks/implement", "review/workspace"])
  console.log(`repos.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
// Each test makes several bare repositories and worktrees; git on Windows needs seconds for that.
setDefaultTimeout(120_000);
const dirs: string[] = [];
const fakes: FakeBitbucket[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const f of fakes.splice(0)) f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const WHO = { name: "Ada Example", email: "ada@example.invalid" };

async function setup(o: MultiOptions = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-mr1-")));
  dirs.push(root);
  const fake = startFakeBitbucket();
  fakes.push(fake);
  const m = await multiRepo(root, fake, o);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(root, "db.sqlite"));
  dbs.push(db);
  const id = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, target_branch, spec_dir, created_at, updated_at)
        VALUES ('PROJ', 'app', 'K-1', 'Change both', 'spec_draft', 'main', 'specs/K-1/', 1, 1) RETURNING id`,
      )
      .get() as { id: number }
  ).id;
  const t = () => db.query("SELECT * FROM task WHERE id = $id").get({ id }) as Parameters<typeof taskRepos>[1];
  const resolve = async () => {
    await mainCache(dataDir, m);
    return resolveTaskRepos(db, depsOf(m, dataDir), t(), m.app.base);
  };
  return { root, fake, m, dataDir, db, id, t, resolve };
}

describe("URLs (git-submodule(1) relative URLs, spec.md section 6.16.5)", () => {
  test("relative URLs resolve against the parent http clone link", () => {
    const parent = "http://127.0.0.1:7990/scm/proj/app.git";
    expect(relativeUrl(parent, "../lib.git")).toBe("http://127.0.0.1:7990/scm/proj/lib.git");
    expect(relativeUrl(parent, "../../other/lib.git")).toBe("http://127.0.0.1:7990/scm/other/lib.git");
    expect(relativeUrl(parent, "./lib.git")).toBe("http://127.0.0.1:7990/scm/proj/app.git/lib.git");
    expect(relativeUrl(`${parent}/`, "../lib.git")).toBe("http://127.0.0.1:7990/scm/proj/lib.git");
    expect(relativeUrl(parent, "../../../../x.git")).toBeNull();
  });
  test("normalizeUrl drops user info and lowercases the scheme and the host only; the scp-like form gives null", () => {
    expect(normalizeUrl("HTTPS://User:Secret@Git.Example.Invalid:8443/SCM/Proj/Lib.git")).toBe(
      "https://git.example.invalid:8443/SCM/Proj/Lib.git",
    );
    expect(normalizeUrl("ssh://git@Host.Example.Invalid:7999/proj/lib.git")).toBe("ssh://host.example.invalid:7999/proj/lib.git");
    expect(normalizeUrl("git@host.example.invalid:proj/lib.git")).toBeNull();
    // No trailing slash or .git rewrite: the match stays exact.
    expect(normalizeUrl("https://h.example.invalid/scm/p/r")).not.toBe(normalizeUrl("https://h.example.invalid/scm/p/r.git"));
  });
  test("hostOf reads http, ssh, scp-like, and IPv6 forms", () => {
    expect(hostOf("https://u@Git.Example.Invalid:8443/a/b.git")).toBe("git.example.invalid");
    expect(hostOf("ssh://git@127.0.0.1:7999/p/r.git")).toBe("127.0.0.1");
    expect(hostOf("git@Host.Example.Invalid:p/r.git")).toBe("host.example.invalid");
    expect(hostOf("http://[::1]:7990/scm/p/r.git")).toBe("[::1]");
    expect(hostOf("../lib.git")).toBeNull();
  });
  test("candidate takes the last two path parts and drops .git from the slug", () => {
    expect(candidate("http://h.example.invalid/scm/proj/lib.git")).toEqual({ project: "proj", repo: "lib" });
    expect(candidate("ssh://h.example.invalid:7999/~user/lib.git")).toEqual({ project: "~user", repo: "lib" });
    expect(candidate("http://h.example.invalid/lib.git")).toBeNull();
  });
});

describe(".gitmodules of a commit", () => {
  test("readGitlinks reads mode 160000 entries and their URLs from the commit, never from disk", async () => {
    const s = await setup({ extraLinks: { "tools/x": "2".repeat(40) }, extraModules: {} });
    const { cache, env } = await mainCache(s.dataDir, s.m);
    const links = await readGitlinks(cache, env, s.m.app.base);
    expect(links).toEqual([
      { path: "lib", pinned: s.m.lib.base, url: "../lib.git" },
      { path: "tools/x", pinned: "2".repeat(40), url: null },
      { path: "vendor", pinned: s.m.vendorCommit, url: OTHER_URL },
    ]);
  });
});

describe("mapping and access (AC-B33, AC-B34)", () => {
  test("a same-server writable submodule gets edit, its nested submodule read, another server none; no request goes to the other origin", async () => {
    const s = await setup();
    const snap = await s.resolve();
    const rows = repoDtos(s.db, s.t());
    expect(rows.map((r) => [r.role, r.path, r.project, r.repo, r.depth, r.access, r.reason])).toEqual([
      ["main", null, "PROJ", "app", 0, "edit", null],
      ["submodule", "lib", "PROJ", "lib", 1, "edit", null],
      ["submodule", "vendor", null, null, 1, "none", REPO_REASON.otherServer],
      ["submodule", "lib/deep", "PROJ", "deep", 2, "read", REPO_REASON.nested],
    ]);
    expect(snap.map((x) => x.path)).toEqual(["lib", "lib/deep"]);
    // The fake server counter and the fetch spy: nothing for vendor or its host.
    expect(s.m.remoteCalls.some((c) => /vendor|ext/.test(c))).toBe(false);
    expect(s.fake.requests.some((r) => /vendor|\/ext\//i.test(r))).toBe(false);
    const vendor = taskRepos(s.db, s.t()).find((r) => r.path === "vendor");
    expect(vendor?.url).toBe(OTHER_URL);
  });

  test("a URL with the same path parts on another port of the server maps to nothing: the clone links must hold the same URL", async () => {
    const s = await setup({ extraLinks: { lib2: "3".repeat(40) }, extraModules: { lib2: "http://127.0.0.1:1/scm/proj/lib.git" } });
    await s.resolve();
    const lib2 = repoDtos(s.db, s.t()).find((r) => r.path === "lib2");
    expect(lib2).toMatchObject({ project: null, repo: null, access: "none", reason: REPO_REASON.noMatch });
  });

  test("the same path parts on another host are another server", async () => {
    const s = await setup({
      extraLinks: { lib3: "3".repeat(40) },
      extraModules: { lib3: "https://other.example.invalid/scm/proj/lib.git" },
    });
    await s.resolve();
    expect(repoDtos(s.db, s.t()).find((r) => r.path === "lib3")).toMatchObject({ access: "none", reason: REPO_REASON.otherServer });
    // One read of the candidate key, for the lib submodule only: lib3 sends nothing.
    expect(s.fake.requests.filter((r) => r.includes("/projects/proj/repos/lib")).length).toBe(1);
  });

  test("a first-level submodule without REPO_WRITE gets read with its reason", async () => {
    const s = await setup({ libWritable: false });
    await s.resolve();
    expect(repoDtos(s.db, s.t()).find((r) => r.path === "lib")).toMatchObject({ access: "read", reason: REPO_REASON.noWrite });
  });

  test("the same repository a second time is read with the first path; a pinned commit on no branch is none", async () => {
    const t = await setup({
      extraLinks: (lib) => ({ again: lib, gone: "4".repeat(40) }),
      extraModules: { again: "../lib.git", gone: "../lib.git" },
    });
    await t.resolve();
    const rows = repoDtos(t.db, t.t());
    // Sorted by path: "again" comes first, so "lib" is the second sight of PROJ/lib.
    expect(rows.find((r) => r.path === "again")).toMatchObject({ project: "PROJ", repo: "lib", access: "edit" });
    expect(rows.find((r) => r.path === "lib")).toMatchObject({ project: null, access: "read", reason: REPO_REASON.twice("again") });
    expect(rows.find((r) => r.path === "gone")).toMatchObject({ access: "none", reason: REPO_REASON.noBranch });
  });

  test("a commit without gitlinks keeps one main row and asks Bitbucket nothing", async () => {
    const s = await setup();
    const plain = await s.m.app.commit({ "README.md": "plain\n" }, {}, s.m.app.base);
    await s.m.app.g(["update-ref", "refs/heads/main", plain]);
    await mainCache(s.dataDir, s.m);
    const before = s.fake.requests.length;
    expect(await resolveTaskRepos(s.db, depsOf(s.m, s.dataDir), s.t(), plain)).toEqual([]);
    expect(taskRepos(s.db, s.t()).map((r) => r.role)).toEqual(["main"]);
    expect(s.fake.requests.length).toBe(before);
  });
});

describe("the snapshot of the interview and spec runs (spec.md section 6.16.5, Snapshots)", () => {
  test("each repository with access edit or read is a sanitized folder at its path; vendor stays an empty folder", async () => {
    const s = await setup();
    const ws = await prepareTaskWorkspace({
      dataDir: s.dataDir,
      runId: "snap-1",
      project: "PROJ",
      repo: "app",
      task: s.id,
      branch: "main",
      remote: { url: s.m.app.remote, config: [] },
      nested: (_cache, head) => resolveTaskRepos(s.db, depsOf(s.m, s.dataDir), s.t(), head),
    });
    try {
      expect(readFileSync(join(ws.repo, "lib", "lib.c"), "utf8")).toBe("int lib;\n");
      expect(readFileSync(join(ws.repo, "lib", "deep", "deep.txt"), "utf8")).toBe("deep\n");
      expect(readdirSync(join(ws.repo, "vendor"))).toEqual([]);
    } finally {
      await ws.remove();
    }
    expect(existsSync(ws.run)).toBe(false);
  });

  test("the review snapshot of a PR keeps no submodules: without nested, the gitlink folders stay empty", async () => {
    const s = await setup();
    const ws = await prepareTaskWorkspace({
      dataDir: s.dataDir,
      runId: "snap-2",
      project: "PROJ",
      repo: "app",
      task: s.id,
      branch: "main",
      remote: { url: s.m.app.remote, config: [] },
    });
    try {
      expect(readdirSync(join(ws.repo, "lib"))).toEqual([]);
    } finally {
      await ws.remove();
    }
  });
});

// The part folder of the task with every repository, as the loop opens it.
async function part(s: Awaited<ReturnType<typeof setup>>) {
  await s.resolve();
  const main = await openWorktree({
    dataDir: s.dataDir,
    db: s.db,
    project: "PROJ",
    repo: "app",
    task: s.id,
    ord: 1,
    branch: "feature/K-1-change-both",
    base: s.m.app.base,
  });
  const trees = await openRepoTrees({
    dataDir: s.dataDir,
    db: s.db,
    task: s.id,
    ord: 1,
    branch: "feature/K-1-change-both",
    main,
    rows: taskRepos(s.db, s.t()),
  });
  const at = (p: string) => join(main.repo, ...p.split("/"));
  return { main, trees, at, tree: (p: string) => trees.find((x) => x.full === p) as RepoTree };
}

describe("nested worktrees (spec.md section 6.16.5, Worktrees; section 6.16.6, Reset)", () => {
  test("lib is on the task branch, deep is detached at its pin, vendor is an empty folder, and the main status is clean", async () => {
    const s = await setup();
    const p = await part(s);
    const lib = p.tree("lib").wt;
    const deep = p.tree("lib/deep").wt;
    expect((await wtGit(lib as NonNullable<typeof lib>, ["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/feature/K-1-change-both");
    expect(await wtGit(deep as NonNullable<typeof deep>, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")).toBe("detached");
    expect(await headOf(deep as NonNullable<typeof deep>)).toBe(s.m.deep.base);
    expect(p.tree("vendor").wt).toBeNull();
    expect(readdirSync(p.at("vendor"))).toEqual([]);
    expect(readFileSync(p.at("lib/deep/deep.txt"), "utf8")).toBe("deep\n");
    expect(await status(p.main)).toEqual([]);
    // The sparse patterns hide .gitmodules in each worktree.
    expect(existsSync(p.at(".gitmodules"))).toBe(false);
    expect(existsSync(p.at("lib/.gitmodules"))).toBe(false);
  });

  test("git clean -ffd in the parent keeps the gitlink folders; the reset returns every repository deepest first", async () => {
    const s = await setup();
    const p = await part(s);
    writeFileSync(p.at("untracked.txt"), "x");
    writeFileSync(p.at("lib/lib.c"), "changed\n");
    writeFileSync(p.at("lib/deep/deep.txt"), "changed\n");
    writeFileSync(p.at("vendor/junk.txt"), "x");
    // The bare git clean of the parent first: the submodule worktrees stay with their files.
    await wtGit(p.main, ["clean", "-ffdq"]);
    expect(existsSync(p.at("untracked.txt"))).toBe(false);
    expect(readFileSync(p.at("lib/lib.c"), "utf8")).toBe("changed\n");
    expect(existsSync(p.at("lib/.git"))).toBe(true);
    expect(existsSync(p.at("lib/deep/.git"))).toBe(true);
    await resetTrees(p.trees, await headOf(p.main));
    expect(readFileSync(p.at("lib/lib.c"), "utf8")).toBe("int lib;\n");
    expect(readFileSync(p.at("lib/deep/deep.txt"), "utf8")).toBe("deep\n");
    expect(readdirSync(p.at("vendor"))).toEqual([]);
    expect(await status(p.main)).toEqual([]);
  });
});

describe("the path check per repository (AC-B35)", () => {
  test("an edit in a read-only nested submodule fails with its reason, and the undo resets every repository with a patch", async () => {
    const s = await setup();
    const p = await part(s);
    writeFileSync(p.at("src/app.ts"), "export const app = 2;\n");
    writeFileSync(p.at("lib/lib.c"), "int lib = 2;\n");
    writeFileSync(p.at("lib/deep/deep.txt"), "changed\n");
    const tc = await treeCheck(p.trees, { allow: [] });
    expect(tc.locked).toEqual({ path: "lib/deep/deep.txt", reason: REPO_REASON.nested });
    const patch = join(s.root, "patches", "7.patch");
    expect(await undoTrees(p.trees, tc, await headOf(p.main), patch)).not.toBeNull();
    expect(readFileSync(p.at("src/app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(readFileSync(p.at("lib/lib.c"), "utf8")).toBe("int lib;\n");
    expect(readFileSync(p.at("lib/deep/deep.txt"), "utf8")).toBe("deep\n");
    expect(readFileSync(patch, "utf8")).toContain("src/app.ts");
  });

  test("a file in the empty folder of another server fails with its reason", async () => {
    const s = await setup();
    const p = await part(s);
    writeFileSync(p.at("vendor/new.txt"), "x");
    const tc = await treeCheck(p.trees, { allow: [] });
    expect(tc.locked).toEqual({ path: "vendor/new.txt", reason: REPO_REASON.otherServer });
    await undoTrees(p.trees, tc, await headOf(p.main), join(s.root, "patches", "8.patch"));
    expect(readdirSync(p.at("vendor"))).toEqual([]);
  });

  test("edits in main and the editable submodule pass; the gitlink path of lib is allowed in the parent", async () => {
    const s = await setup();
    const p = await part(s);
    writeFileSync(p.at("src/app.ts"), "export const app = 2;\n");
    writeFileSync(p.at("lib/lib.c"), "int lib = 2;\n");
    const tc = await treeCheck(p.trees, { allow: [] });
    expect(tc.check.problems).toEqual([]);
    expect(tc.locked).toBeNull();
    expect(tc.check.changed.sort()).toEqual(["lib/lib.c", "src/app.ts"]);
  });
});

describe("commits and the line budget (AC-B36, AC-B37)", () => {
  test("two commits with one message; the parent gitlink points at the submodule commit; task_pr holds the submodule head", async () => {
    const s = await setup();
    const p = await part(s);
    s.db.query("UPDATE task SET state = 'implementing', base_commit = $b WHERE id = $id").run({ b: s.m.app.base, id: s.id });
    const partId = (
      s.db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($t, 1, 'single', 'One', 'feature/K-1-change-both', 'main', 'implementing', 1, 1) RETURNING id`)
        .get({ t: s.id }) as { id: number }
    ).id;
    writeFileSync(p.at("src/app.ts"), "export const app = 2;\nexport const more = 3;\n");
    writeFileSync(p.at("lib/lib.c"), "int lib = 2;\n");
    const r = await commitTask({
      db: s.db,
      task: s.id,
      part: partId,
      wt: p.main,
      item: "T1.1",
      message: "K-1 T1.1: Change both",
      who: WHO,
      allow: [],
      trees: p.trees,
    });
    expect(r.status).toBe("committed");
    const lib = p.tree("lib").wt as NonNullable<RepoTree["wt"]>;
    const libHead = await headOf(lib);
    expect(libHead).not.toBe(s.m.lib.base);
    const subject = async (wt: typeof lib) => (await wtGit(wt, ["log", "-1", "--format=%s"])).trim();
    expect(await subject(lib)).toBe("K-1 T1.1: Change both");
    expect(await subject(p.main)).toBe("K-1 T1.1: Change both");
    const gitlink = (await wtGit(p.main, ["ls-tree", "HEAD", "lib"])).trim();
    expect(gitlink).toBe(`160000 commit ${libHead}\tlib`);
    expect(s.db.query("SELECT head, state, branch FROM task_pr WHERE part = $p").all({ p: partId })).toEqual([
      { head: libHead, state: "changed", branch: "feature/K-1-change-both" },
    ]);
    // The line budget: main counts 3 lines (1 removed, 2 added) without the gitlink, lib counts 2.
    const main = await changedLines(p.main, s.m.app.base, await headOf(p.main), []);
    expect(main.lines).toBe(3);
    expect((await changedLines(lib, s.m.lib.base, libHead, [])).lines).toBe(2);
  });

  test("a parent diff with only a gitlink change counts no line", async () => {
    const s = await setup();
    const p = await part(s);
    writeFileSync(p.at("lib/lib.c"), "int lib = 2;\n");
    const lib = p.tree("lib").wt as NonNullable<RepoTree["wt"]>;
    await wtGit(lib, ["add", "-A"]);
    await wtGit(lib, ["commit", "-q", "--no-verify", "-m", "x"], {
      extra: {
        GIT_AUTHOR_NAME: "a",
        GIT_AUTHOR_EMAIL: "a@example.invalid",
        GIT_COMMITTER_NAME: "a",
        GIT_COMMITTER_EMAIL: "a@example.invalid",
      },
    });
    await wtGit(p.main, ["add", "-A"]);
    await wtGit(p.main, ["commit", "-q", "--no-verify", "-m", "x"], {
      extra: {
        GIT_AUTHOR_NAME: "a",
        GIT_AUTHOR_EMAIL: "a@example.invalid",
        GIT_COMMITTER_NAME: "a",
        GIT_COMMITTER_EMAIL: "a@example.invalid",
      },
    });
    const head = await headOf(p.main);
    expect(head).not.toBe(s.m.app.base);
    expect(await changedLines(p.main, s.m.app.base, head, [])).toEqual({ files: 0, added: 0, removed: 0, lines: 0 });
    // The plain numstat still lists the gitlink, so the parent counts as changed (spec.md section 6.16.6).
    expect((await wtGit(p.main, ["diff", "--numstat", s.m.app.base, head])).trim()).toContain("lib");
  });
});

describe("the large-task rule (spec.md section 6.16.5, Size)", () => {
  const parts = (files: string[]) => [{ tasks: [{ files }] }];
  const repos = [
    { role: "main", path: null },
    { role: "submodule", path: "lib" },
  ];
  test("a large plan with a file in a submodule folder, or an added repository, is refused with the sentence", () => {
    expect(largeRepoProblem("large", parts(["lib/lib.c"]), repos)).toBe(LARGE_REPOS_TEXT);
    expect(largeRepoProblem("large", parts(["src/app.ts"]), [...repos, { role: "added", path: null }])).toBe(LARGE_REPOS_TEXT);
    expect(largeRepoProblem("large", parts(["src/app.ts", "library/x.c"]), repos)).toBeNull();
    expect(largeRepoProblem("medium", parts(["lib/lib.c"]), repos)).toBeNull();
  });
});

test("gitmodules helper writes git config syntax", () => {
  expect(gitmodules({ a: "../a.git" })).toBe('[submodule "a"]\n\tpath = a\n\turl = ../a.git\n');
});
