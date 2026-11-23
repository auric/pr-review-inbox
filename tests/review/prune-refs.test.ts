// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Audit: the refs of closed pull requests go at app start. A PR with an open fix commit keeps them. Real git in a temp folder.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRefs } from "../../src/server/review/clone";
import { git } from "../../src/server/review/git";
import { cachePath, gitSetup, longPath } from "../../src/server/review/workspace";
import { openDb } from "../../src/server/storage/db";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

test("a closed PR without an open fix commit loses refs/rl/<PR ID>/; an open fix commit or an open PR keeps them", async () => {
  const dir = longPath(mkdtempSync(join(tmpdir(), "rl-prune-refs-")));
  dirs.push(dir);
  const db = openDb(join(dir, "test.db"));
  try {
    const cache = cachePath(dir, { project: "PRJ", repo: "repo", id: 1 });
    const { env } = gitSetup(dir);
    const id = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const g = async (args: string[], stdin?: string) =>
      (await git([`--git-dir=${cache}`, ...args], { env: { ...env, ...id }, stdin })).trim();
    await git(["init", "-q", "--bare", "--template=", cache], { env });
    const tree = await g(["hash-object", "-t", "tree", "-w", "--stdin"], "");
    const commit = await g(["commit-tree", tree, "-m", "c"], "");
    // pr_id 5: merged, no fix commit. 6: declined, a committed fix. 7: merged, an undone fix. 50: open.
    const prs: [number, string][] = [
      [5, "MERGED"],
      [6, "DECLINED"],
      [7, "MERGED"],
      [50, "OPEN"],
    ];
    const rows = new Map<number, number>();
    for (const [n, state] of prs) {
      const { id: row } = db
        .query("INSERT INTO pull_request (project, repo, pr_id, state) VALUES ('PRJ', 'repo', $n, $state) RETURNING id")
        .get({ n, state }) as { id: number };
      rows.set(n, row);
      // parent-target: the parent fetch of a stacked review run (stacked-prs.md section 5.4).
      for (const ref of ["source", "target", "parent-target", "fix/1", "fix-commit/2"])
        await g(["update-ref", `refs/rl/${n}/${ref}`, commit]);
    }
    const fix = (n: number, state: string) => {
      const pr = rows.get(n) as number;
      const { id: run } = db
        .query(
          `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, finished_at)
          VALUES ($pr, 'fix', 'general', '', $key, $c, $c, 'completed', 1, 2) RETURNING id`,
        )
        .get({ pr, key: `fix-${n}`, c: commit }) as { id: number };
      db.query(
        `INSERT INTO fix_commit (pr, run, idem_key, edits_json, mode, before_head, state, message, created_at, updated_at)
        VALUES ($pr, $run, $key, '[]', 'cache', $c, $state, 'm', 1, 1)`,
      ).run({ pr, run, key: `k-${n}`, c: commit, state });
    };
    fix(6, "committed");
    fix(7, "undone");

    await pruneRefs(db, dir);
    const left = (await g(["for-each-ref", "--format=%(refname)", "refs/rl"])).split("\n").filter(Boolean).sort();
    const of = (n: number) => ["fix/1", "fix-commit/2", "parent-target", "source", "target"].map((r) => `refs/rl/${n}/${r}`);
    expect(left).toEqual([...of(50), ...of(6)].sort());
  } finally {
    db.close();
  }
});
