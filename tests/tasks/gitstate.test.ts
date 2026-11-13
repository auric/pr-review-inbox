// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/git-deny.md fix F (spec.md section 6.8, AC-B177): the check after a step tells the git calls of the app from
// the changes of Claude, also with two steps on one cache. "Claude" here is git that runs past the app's git(), as a Bash command does.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { git } from "../../src/server/review/git";
import { checkGit, diskDiff, diskSnapOf, snapGit, stopGit } from "../../src/server/tasks/gitstate";
import { openWorktree } from "../../src/server/tasks/worktree";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["tasks/gitstate", "review/git"])
  console.log(`gitstate.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

const SLOW = 60_000;
const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

async function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-fix-f-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "db-test.sqlite"));
  dbs.push(db);
  const { cache, base } = await taskCache(dataDir, r.remote);
  const open = (ord: number) =>
    openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task: 1, ord, branch: `feature/K-1-part-${ord}`, base });
  const a = await open(1);
  const b = await open(2);
  // The git of the app: git() with its record. Claude: git past git(), with no record.
  const app = (args: string[]) => git([`--git-dir=${cache}`, ...args], { env: a.env });
  const claude = (args: string[]) => {
    const p = Bun.spawnSync(["git", `--git-dir=${cache}`, ...args], { env: a.env, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  const at = (ref: string) => claude(["rev-parse", "--verify", "-q", ref]);
  const tree = claude(["rev-parse", `${base}^{tree}`]);
  const planted = claude(["-c", "user.name=p", "-c", "user.email=p@example.invalid", "commit-tree", tree, "-p", base, "-m", "planted"]);
  return { cache, base, a, b, open, app, claude, at, planted, root };
}

describe("fix F: who changed a ref during the step", () => {
  test(
    "AC-B177: a ref that the app's git moves during the step passes; the same move past git() is restored",
    async () => {
      const s = await setup();
      const snap = await snapGit([s.a]);
      await s.app(["update-ref", "refs/heads/feature/K-1-part-2", s.planted]);
      expect(await checkGit(snap)).toEqual([]);
      expect(s.at("refs/heads/feature/K-1-part-2")).toBe(s.planted);
      await s.app(["update-ref", "refs/heads/feature/K-1-part-2", s.base]);

      const again = await snapGit([s.a]);
      s.claude(["update-ref", "refs/heads/feature/K-1-part-2", s.planted]);
      expect(await checkGit(again)).toEqual(["refs/heads/feature/K-1-part-2"]);
      expect(s.at("refs/heads/feature/K-1-part-2")).toBe(s.base);
    },
    SLOW,
  );

  test(
    "two steps on one cache: the restore of the first counts as a change of the app for the second, so the second never puts the planted ref back",
    async () => {
      const s = await setup();
      const first = await snapGit([s.a]);
      s.claude(["update-ref", "refs/heads/feature/K-1-part-2", s.planted]);
      // The second step starts after the plant, so its snapshot holds the planted commit.
      const second = await snapGit([s.b]);
      expect(await checkGit(first)).toEqual(["refs/heads/feature/K-1-part-2"]);
      expect(s.at("refs/heads/feature/K-1-part-2")).toBe(s.base);
      expect(await checkGit(second)).toEqual([]);
      expect(s.at("refs/heads/feature/K-1-part-2")).toBe(s.base);
    },
    SLOW,
  );

  test(
    "planted cache config and a planted commondir go back as files before git reads the refs, which a commondir would point elsewhere",
    async () => {
      const s = await setup();
      const snap = await snapGit([s.a, s.b]);
      s.claude(["config", "core.hooksPath", "planted-hooks"]);
      s.claude(["update-ref", "-d", "refs/rl/task/1/base"]);
      writeFileSync(join(s.cache, "commondir"), "../elsewhere.git\n");
      const moved = await checkGit(snap);
      expect(moved).toEqual(["repo.git/config", "repo.git/commondir", "refs/rl/task/1/base (deleted)"]);
      expect(existsSync(join(s.cache, "commondir"))).toBe(false);
      expect(s.at("refs/rl/task/1/base")).toBe(s.base);
      expect(() => s.claude(["config", "--file", join(s.cache, "config"), "--get", "core.hooksPath"])).toThrow();
    },
    SLOW,
  );
});

// AC-B323: the files of a paused git operation in the worktree git folder, info/exclude of the cache, and the entries of
// <cache>/worktrees. git commit with MERGE_HEAD makes a merge commit, info/exclude hides files from git status, and a new entry is a
// worktree that the app does not know.
describe("AC-B323: sequencer files, info/exclude, and worktree entries", () => {
  test(
    "a planted MERGE_HEAD, rebase-merge/, info/exclude line, and worktree entry are items, and each goes back",
    async () => {
      const s = await setup();
      const admin = `${basename(s.cache)}/worktrees/${basename(s.a.admin)}`;
      // The app makes its cache with no template, so info/exclude is absent.
      expect(existsSync(join(s.cache, "info", "exclude"))).toBe(false);
      const snap = await snapGit([s.a]);
      writeFileSync(join(s.a.admin, "MERGE_HEAD"), `${s.planted}\n`);
      mkdirSync(join(s.a.admin, "rebase-merge"));
      writeFileSync(join(s.a.admin, "rebase-merge", "onto"), `${s.planted}\n`);
      mkdirSync(join(s.cache, "info"), { recursive: true });
      writeFileSync(join(s.cache, "info", "exclude"), "*\n");
      s.claude(["worktree", "add", "--detach", join(s.root, "planted-wt"), s.base]);
      const moved = await checkGit(snap);
      expect(moved).toEqual([
        `${admin}/MERGE_HEAD`,
        `${admin}/rebase-merge`,
        `${basename(s.cache)}/info/exclude`,
        `${basename(s.cache)}/worktrees/planted-wt (new)`,
      ]);
      expect(existsSync(join(s.a.admin, "MERGE_HEAD"))).toBe(false);
      expect(existsSync(join(s.a.admin, "rebase-merge"))).toBe(false);
      expect(existsSync(join(s.cache, "info", "exclude"))).toBe(false);
      expect(readdirSync(join(s.cache, "worktrees")).sort()).toEqual([basename(s.a.admin), basename(s.b.admin)].sort());
    },
    SLOW,
  );

  test(
    "a paused operation of the app stays as it was: a changed file in rebase-merge/ and a deleted MERGE_HEAD come back",
    async () => {
      const s = await setup();
      mkdirSync(join(s.a.admin, "rebase-merge", "sub"), { recursive: true });
      writeFileSync(join(s.a.admin, "rebase-merge", "onto"), `${s.base}\n`);
      writeFileSync(join(s.a.admin, "rebase-merge", "sub", "done"), "pick 1\n");
      writeFileSync(join(s.a.admin, "MERGE_HEAD"), `${s.base}\n`);
      const snap = await snapGit([s.a]);
      expect(await checkGit(snap)).toEqual([]);
      const again = await snapGit([s.a]);
      writeFileSync(join(s.a.admin, "rebase-merge", "onto"), `${s.planted}\n`);
      rmSync(join(s.a.admin, "MERGE_HEAD"));
      const admin = `${basename(s.cache)}/worktrees/${basename(s.a.admin)}`;
      expect(await checkGit(again)).toEqual([`${admin}/MERGE_HEAD`, `${admin}/rebase-merge`]);
      expect(readFileSync(join(s.a.admin, "rebase-merge", "onto"), "utf8")).toBe(`${s.base}\n`);
      expect(readFileSync(join(s.a.admin, "rebase-merge", "sub", "done"), "utf8")).toBe("pick 1\n");
      expect(readFileSync(join(s.a.admin, "MERGE_HEAD"), "utf8")).toBe(`${s.base}\n`);
    },
    SLOW,
  );

  test(
    "a worktree that the app adds during the step is no item; one that Claude deletes fails the restore",
    async () => {
      const s = await setup();
      const snap = await snapGit([s.a]);
      const c = await s.open(3);
      expect(await checkGit(snap)).toEqual([]);
      expect(existsSync(c.admin)).toBe(true);
      const again = await snapGit([s.a]);
      rmSync(s.b.admin, { recursive: true, force: true });
      await expect(checkGit(again)).rejects.toThrow(`The worktree entry ${basename(s.b.admin)} is gone.`);
    },
    SLOW,
  );

  test(
    "the restart check sees the same changes",
    async () => {
      const s = await setup();
      const snap = await snapGit([s.a]);
      const d = await diskSnapOf(snap);
      stopGit(snap);
      expect(diskDiff(d, [s.a])).toEqual([]);
      writeFileSync(join(s.a.admin, "MERGE_HEAD"), `${s.planted}\n`);
      mkdirSync(join(s.cache, "info"), { recursive: true });
      writeFileSync(join(s.cache, "info", "exclude"), "*\n");
      s.claude(["worktree", "add", "--detach", join(s.root, "planted-wt"), s.base]);
      const admin = `${basename(s.cache)}/worktrees/${basename(s.a.admin)}`;
      expect(diskDiff(d, [s.a])).toEqual([
        `${admin}/MERGE_HEAD`,
        `${basename(s.cache)}/info/exclude`,
        `${basename(s.cache)}/worktrees/planted-wt (new)`,
      ]);
    },
    SLOW,
  );
});
