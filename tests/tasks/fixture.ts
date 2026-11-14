// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A temp bare remote with the files that the sparse patterns of a task worktree hide, and the cache of the app made from it with the
// task run code (prepareTaskWorkspace). WP-B3 tests only. No test reaches a forge.
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitEnv } from "../../src/server/review/git";
import { prepareTaskWorkspace } from "../../src/server/review/workspace";

// Paths that the sparse patterns of spec.md section 6.8 hide, and the paths that stay.
export const HIDDEN = [
  ".claude/settings.json",
  "sub/.claude/agents/x.md",
  ".mcp.json",
  "sub/.mcp.json",
  ".codegraph/index.db",
  "CLAUDE.md",
  "sub/CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "sub/AGENTS.md",
  ".gitmodules",
  ".githooks/pre-commit",
  ".husky/pre-commit",
];
export const SHOWN = ["README.md", "src/app.ts", "sub/code.ts", ".github/workflows/ci.yml", ".gitignore"];

// part-session.md section 9.7, invariant 8: the parts of a database that hold two or more open step rows, with "<kind>:<item>" of
// each. One pair is no hit: loop.ts driveUpdate keeps its update row open while one resolve run or the checks of that update ("U<n>")
// run. The phase is then the phase of that row.
export const openTwice = (db: Database) =>
  (
    db
      .query(
        `SELECT part, COUNT(*) AS n, GROUP_CONCAT(kind || ':' || COALESCE(item, '-'), ' ') AS rows FROM task_step
        WHERE state IN ('waiting', 'running') AND part IS NOT NULL GROUP BY part HAVING n > 1`,
      )
      .all() as { part: number; n: number; rows: string }[]
  ).filter((x) => {
    const rows = x.rows.split(" ");
    const item = rows.find((r) => r.startsWith("update:"))?.slice("update:".length);
    return !(x.n === 2 && item !== undefined && rows.some((r) => r === `resolve:${item}` || r === `check:${item}`));
  });

export const IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

// A bare remote with one commit on main that holds HIDDEN and SHOWN.
export async function taskRemote(root: string) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const remote = join(root, "remote.git");
  const env = { ...gitEnv(empty), ...IDENTITY, GIT_INDEX_FILE: join(root, "fixture.index") };
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", remote, ...args], { env, stdin })).trim();
  await git(["init", "-q", "--bare", "--template=", remote], { env });
  await g(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const files = [...HIDDEN, ...SHOWN];
  const blobs = files.map((p, i) => {
    const f = join(root, `blob-${i}`);
    writeFileSync(f, p === ".gitignore" ? "ignored/\n*.log\n" : `${p}\n`);
    return f;
  });
  const shas = (await g(["hash-object", "-w", "--no-filters", "--stdin-paths"], `${blobs.join("\n")}\n`)).split("\n");
  await g(["read-tree", "--empty"]);
  await g(["update-index", "--index-info"], `${files.map((p, i) => `100644 ${shas[i]}\t${p}`).join("\n")}\n`);
  const base = await g(["commit-tree", await g(["write-tree"]), "-m", "base"]);
  await g(["update-ref", "refs/heads/main", base]);
  return { remote, base, env, g };
}

// Commits text files on top of main of a bare remote, so the next task base holds them. Returns the new main commit.
export async function commitOnMain(remote: string, root: string, files: Record<string, string>) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = { ...gitEnv(empty), ...IDENTITY, GIT_INDEX_FILE: join(root, "on-main.index") };
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", remote, ...args], { env, stdin })).trim();
  const main = await g(["rev-parse", "refs/heads/main"]);
  await g(["read-tree", main]);
  for (const [path, text] of Object.entries(files))
    await g(["update-index", "--add", "--cacheinfo", `100644,${await g(["hash-object", "-w", "--stdin"], text)},${path}`]);
  const next = await g(["commit-tree", await g(["write-tree"]), "-p", main, "-m", "Add files"]);
  await g(["update-ref", "refs/heads/main", next]);
  return next;
}

// The cache of PROJ/repo in dataDir, as a spec run leaves it: the target head at refs/rl/task/<task>/base.
export async function taskCache(dataDir: string, remote: string, task = 1) {
  const ws = await prepareTaskWorkspace({
    dataDir,
    runId: `fixture-${task}`,
    project: "PROJ",
    repo: "repo",
    task,
    branch: "main",
    remote: { url: remote, config: [] },
  });
  await ws.keep("base");
  await ws.remove();
  return { cache: ws.cache, base: ws.sourceHead };
}
