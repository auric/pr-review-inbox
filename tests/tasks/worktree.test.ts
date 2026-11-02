// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.8 (WP-B3): the task worktree from the cache with sparse checkout and its config, the branch
// names, the reuse and the rebuild, the reset with links and nested repositories, the patch, and the commit without hooks. Temp git
// repositories only. The user's clone is a temp clone that no call touches.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitEnv } from "../../src/server/review/git";
import {
  branchName,
  commitStep,
  freeBranch,
  headOf,
  inside,
  linksOn,
  newFiles,
  openWorktree,
  partDir,
  removeWorktree,
  resetWorktree,
  SPARSE,
  savePatch,
  setupHash,
  setupMark,
  slug,
  status,
  tasksRoot,
  wtGit,
} from "../../src/server/tasks/worktree";
import { HIDDEN, SHOWN, taskCache, taskRemote } from "./fixture";

console.log(`worktree.test.ts imported from ${Bun.resolveSync("../../src/server/tasks/worktree", import.meta.dir)}`);

const SLOW = 60_000;
const WHO = { name: "Ada Example", email: "ada@example.invalid" };
const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

async function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-wpb3-wt-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  const db = new Database(join(dataDir, "db-test.sqlite"));
  dbs.push(db);
  const { cache, base } = await taskCache(dataDir, r.remote);
  // The user's clone: the app never runs git in it during a task.
  const clone = join(root, "clone");
  await git(["clone", "-q", r.remote, clone], { env: r.env });
  const open = (branch = "feature/K-1-thing", ord = 1) =>
    openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task: 1, ord, branch, base });
  return { root, dataDir, db, cache, base, clone, open, r };
}

// The clone state that a task must keep: HEAD, the status, and the file list.
async function cloneState(clone: string, env: Record<string, string>) {
  return [
    await git(["-C", clone, "rev-parse", "HEAD"], { env }),
    await git(["-C", clone, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"], { env }),
    await git(["-C", clone, "ls-files", "-s"], { env }),
  ].join("\n");
}

describe("task worktree", () => {
  test(
    "sparse checkout hides each pattern, sets the worktree config, and a commit keeps the hidden files",
    async () => {
      const s = await setup();
      const before = await cloneState(s.clone, s.r.env);
      const wt = await s.open();
      // The folder layout of design.md section 5.5, under the data folder and never in the clone.
      expect(wt.repo).toBe(join(partDir(s.dataDir, s.db, 1, 1), "repo"));
      expect(inside(tasksRoot(s.dataDir), wt.repo)).toBe(true);
      expect(inside(s.clone, wt.dir)).toBe(false);
      for (const p of HIDDEN) expect(existsSync(join(wt.repo, p))).toBe(false);
      for (const p of SHOWN) expect(existsSync(join(wt.repo, p))).toBe(true);
      expect((await status(wt)).length).toBe(0);
      expect((await wtGit(wt, ["sparse-checkout", "list"])).trim().split("\n")).toEqual(SPARSE);
      expect((await wtGit(wt, ["symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/feature/K-1-thing");
      // A hook in the shared cache folder would run for every worktree without the empty core.hooksPath.
      mkdirSync(join(s.cache, "hooks"), { recursive: true });
      const marker = join(s.root, "hook-ran.txt");
      for (const h of ["pre-commit", "commit-msg", "post-commit"])
        writeFileSync(join(s.cache, "hooks", h), `#!/bin/sh\necho ${h} >> "${marker.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
      writeFileSync(join(wt.repo, "src", "app.ts"), "changed\n");
      const commit = await commitStep(wt, "K-1 T1.1: Change the app\n", WHO, []);
      expect(commit).toBe(await headOf(wt));
      expect(existsSync(marker)).toBe(false);
      const cfg = async (k: string) => (await wtGit(wt, ["config", "--worktree", "--get", k])).trim();
      expect(await cfg("core.symlinks")).toBe("false");
      expect(await cfg("core.autocrlf")).toBe("false");
      expect(await cfg("core.hooksPath")).toBe(join(s.dataDir, "git", "no-hooks"));
      const show = (await wtGit(wt, ["show", "-s", "--format=%an|%ae|%cn|%ce|%s|%P", "HEAD"])).trim();
      expect(show).toBe(`${WHO.name}|${WHO.email}|${WHO.name}|${WHO.email}|K-1 T1.1: Change the app|${s.base}`);
      const tree = async (rev: string) => (await wtGit(wt, ["ls-tree", "-r", rev])).trim().split("\n");
      const changed = (await wtGit(wt, ["diff", "--name-only", s.base, "HEAD"])).trim().split("\n");
      expect(changed).toEqual(["src/app.ts"]);
      const hidden = (t: string[]) => t.filter((l) => HIDDEN.some((p) => l.endsWith(`\t${p}`)));
      expect(hidden(await tree("HEAD"))).toEqual(hidden(await tree(s.base)));
      expect(hidden(await tree("HEAD")).length).toBe(HIDDEN.length);
      // Nothing to commit gives null.
      expect(await commitStep(wt, "K-1: nothing", WHO, [])).toBeNull();
      expect(await cloneState(s.clone, s.r.env)).toBe(before);
    },
    SLOW,
  );

  test(
    "an open worktree is reused, and a deleted folder is made again from the branch",
    async () => {
      const s = await setup();
      const wt = await s.open();
      writeFileSync(join(wt.repo, "README.md"), "v2\n");
      const head = await commitStep(wt, "K-1 T1.1: v2", WHO, []);
      writeFileSync(join(wt.repo, "notes.txt"), "work in progress\n");
      const again = await s.open();
      expect(again.admin).toBe(wt.admin);
      expect(existsSync(join(wt.repo, "notes.txt"))).toBe(true);
      // A changed repo/.git file is written again on open.
      writeFileSync(join(wt.repo, ".git"), `gitdir: ${s.clone.replaceAll("\\", "/")}/.git\n`);
      const fixed = await s.open();
      expect(readFileSync(join(wt.repo, ".git"), "utf8").trim()).toBe(`gitdir: ${fixed.admin.replaceAll("\\", "/")}`);
      // A link in place of repo/.git goes without its target.
      rmSync(join(wt.repo, ".git"));
      symlinkSync(join(s.clone, ".git"), join(wt.repo, ".git"), "junction");
      await s.open();
      expect(lstatSync(join(wt.repo, ".git")).isFile()).toBe(true);
      expect(existsSync(join(s.clone, ".git", "HEAD"))).toBe(true);
      rmSync(wt.dir, { recursive: true, force: true, maxRetries: 3 });
      const made = await s.open();
      expect(await headOf(made)).toBe(head as string);
      expect(readFileSync(join(made.repo, "README.md"), "utf8")).toBe("v2\n");
      for (const p of HIDDEN) expect(existsSync(join(made.repo, p))).toBe(false);
      const list = async () =>
        (await git([`--git-dir=${s.cache}`, "worktree", "list", "--porcelain"], { env: s.r.env })).match(/^worktree /gm);
      expect((await list())?.length).toBe(2);
      // Cleanup: the part folder and its worktree entry go, the branch stays in the cache.
      await removeWorktree(made);
      expect(existsSync(made.dir)).toBe(false);
      expect((await list())?.length).toBe(1);
      expect((await git([`--git-dir=${s.cache}`, "rev-parse", "refs/heads/feature/K-1-thing"], { env: s.r.env })).trim()).toBe(
        head as string,
      );
    },
    SLOW,
  );

  test(
    "the reset removes links without their targets, nested repositories, and new files, and the patch keeps the changes",
    async () => {
      const s = await setup();
      const wt = await s.open();
      const last = await headOf(wt);
      const victim = join(s.root, "victim");
      mkdirSync(victim);
      writeFileSync(join(victim, "keep.txt"), "keep\n");
      symlinkSync(victim, join(wt.repo, "src", "link"), "junction");
      mkdirSync(join(wt.repo, "nested"));
      await git(["init", "-q", join(wt.repo, "nested")], { env: s.r.env });
      writeFileSync(join(wt.repo, "nested", "f.txt"), "f\n");
      writeFileSync(join(wt.repo, "README.md"), "changed\n");
      writeFileSync(join(wt.repo, "src", "new.ts"), "export const x = 1;\n");
      mkdirSync(join(wt.repo, ".claude"));
      writeFileSync(join(wt.repo, ".claude", "settings.json"), '{"hooks":{}}\n');
      writeFileSync(join(wt.repo, "CLAUDE.md"), "planted\n");
      const entries = await status(wt);
      const paths = entries.map((e) => e.path);
      expect(paths).toEqual(expect.arrayContaining(["README.md", "src/new.ts", ".claude/settings.json", "CLAUDE.md", "nested/"]));
      const links = paths.flatMap((p) => linksOn(wt.repo, p));
      expect(links).toContain("src/link");
      const file = join(s.root, "patches", "7.patch");
      expect(await savePatch(wt, file, paths)).toBe(file);
      const patch = readFileSync(file, "utf8");
      for (const p of ["README.md", "src/new.ts", ".claude/settings.json", "CLAUDE.md"])
        expect(patch).toContain(`diff --git a/${p} b/${p}`);
      expect(patch).not.toContain("src/link");
      expect(patch).not.toContain("keep.txt");
      // No hidden file shows as deleted.
      expect(patch).not.toContain("deleted file mode");
      await resetWorktree(wt, last, links);
      expect(await status(wt)).toEqual([]);
      expect(await headOf(wt)).toBe(last);
      expect(existsSync(join(wt.repo, "src", "link"))).toBe(false);
      expect(existsSync(join(wt.repo, "nested"))).toBe(false);
      expect(existsSync(join(wt.repo, "CLAUDE.md"))).toBe(false);
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
      expect(lstatSync(victim).isDirectory()).toBe(true);
    },
    SLOW,
  );
});

describe("commit and setup mark (spec.md section 6.7)", () => {
  test(
    "commitStep stages tracked edits, deletes, and only the listed new files; newFiles shows a folder that is new as a whole once",
    async () => {
      const s = await setup();
      const wt = await s.open();
      const put = (p: string) => {
        mkdirSync(join(wt.repo, p, ".."), { recursive: true });
        writeFileSync(join(wt.repo, p), "x\n");
      };
      writeFileSync(join(wt.repo, "src", "app.ts"), "changed\n");
      rmSync(join(wt.repo, "README.md"));
      for (const p of ["src/new.ts", "gen/a.ts", "gen/b.bin", ".venv/bin/python", ".venv/lib/x.py", "build/out.bin", "notes.txt"]) put(p);
      const f = await newFiles(wt, ["src/new.ts", "gen/a.ts", "missing.ts"]);
      expect(f).toEqual({
        add: ["gen/a.ts", "src/new.ts"],
        left: [".venv/bin/python", ".venv/lib/x.py", "build/out.bin", "gen/b.bin", "notes.txt"],
        shown: [".venv/", "build/", "gen/b.bin", "notes.txt"],
      });
      // Windows file systems ignore case, so a Write target in another case still names the file.
      if (process.platform === "win32") expect((await newFiles(wt, ["SRC/NEW.TS"])).add).toEqual(["src/new.ts"]);
      await commitStep(wt, "K-1 T1.1: Add new", WHO, f.add);
      expect((await wtGit(wt, ["show", "--name-status", "--format=", "HEAD"])).trim().split("\n")).toEqual([
        "D\tREADME.md",
        "A\tgen/a.ts",
        "M\tsrc/app.ts",
        "A\tsrc/new.ts",
      ]);
      expect((await status(wt)).map((e) => `${e.xy} ${e.path}`)).toEqual(f.left.map((p) => `?? ${p}`));
    },
    SLOW,
  );

  test(
    "a reset that removes a path deletes the setup mark; a reset that removes nothing keeps it",
    async () => {
      const s = await setup();
      const wt = await s.open();
      const last = await headOf(wt);
      writeFileSync(setupMark(wt), setupHash([{ argv: ["python", "-m", "venv", ".venv"], timeoutSec: 600 }]));
      writeFileSync(join(wt.repo, "README.md"), "changed\n");
      await resetWorktree(wt, last);
      expect(existsSync(setupMark(wt))).toBe(true);
      writeFileSync(join(wt.repo, "new.txt"), "x\n");
      await resetWorktree(wt, last);
      expect(existsSync(setupMark(wt))).toBe(false);
      // The hash covers argv, timeout, and order.
      const a = { argv: ["a"], timeoutSec: 60 };
      const b = { argv: ["b"], timeoutSec: 60 };
      expect(setupHash([a, b])).not.toBe(setupHash([b, a]));
      expect(setupHash([a])).not.toBe(setupHash([{ ...a, timeoutSec: 61 }]));
      expect(setupHash([a])).toBe(setupHash([{ ...a }]));
    },
    SLOW,
  );
});

describe("branch names", () => {
  test("follow the spec forms and the slug rule", () => {
    expect(slug("Flush the cache — before the WRITE lock!")).toBe("flush-the-cache-before-the-write-lock");
    // spec.md section 6.16.2: no length cut in the slug. tests/tasks/branch.test.ts covers the cap of the whole name.
    expect(slug("x".repeat(50)).length).toBe(50);
    expect(branchName("feature/", "PROJ-12", { kind: "spec" })).toBe("feature/PROJ-12-spec");
    expect(branchName("feature/", "PROJ-12", { kind: "small", title: "Add a flag" })).toBe("feature/PROJ-12-add-a-flag");
    expect(branchName("feature/", "PROJ-12", { kind: "part", n: 2, title: "Store rows" })).toBe("feature/PROJ-12-2-store-rows");
    expect(branchName("feature/", "PROJ-12", { kind: "small", title: "Додати прапор" })).toBe("feature/PROJ-12-task");
    expect(branchName("", "PROJ-12", { kind: "part", n: 3, title: "" })).toBe("PROJ-12-3-part");
  });

  test(
    "a name that the remote or the cache has gets the next free suffix",
    async () => {
      const s = await setup();
      const remote = { url: s.r.remote, config: [] as [string, string][] };
      expect(await freeBranch(s.dataDir, s.cache, remote, "feature/K-1-thing")).toBe("feature/K-1-thing");
      await s.r.g(["update-ref", "refs/heads/feature/K-1-thing", s.base]);
      await s.r.g(["update-ref", "refs/heads/feature/K-1-thing-2", s.base]);
      expect(await freeBranch(s.dataDir, s.cache, remote, "feature/K-1-thing")).toBe("feature/K-1-thing-3");
      await git([`--git-dir=${s.cache}`, "branch", "feature/K-1-thing-3", s.base], { env: gitEnv(join(s.root, "empty.gitconfig")) });
      expect(await freeBranch(s.dataDir, s.cache, remote, "feature/K-1-thing")).toBe("feature/K-1-thing-4");
      await expect(freeBranch(s.dataDir, s.cache, remote, "feature/K-1 bad")).rejects.toThrow("not a valid branch name");
    },
    SLOW,
  );
});
