// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.16.5 to 6.16.8 (WP-MR2, AC-B44): an added repository gets its snapshot folder beside repo/,
// a worktree at repos/<project>/<slug>, the path check, its commits with a task_pr row, the line count, its own review, the branch name
// of the task, the update from its base, and its PR with links. Temp bare remotes, the fake Bitbucket, and the fake CLI. No test reaches
// a forge or starts the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/server/review/git";
import { prepareTaskWorkspace } from "../../src/server/review/workspace";
import { treeCheck } from "../../src/server/tasks/implement";
import { createPrOpener } from "../../src/server/tasks/pr";
import { taskDto } from "../../src/server/tasks/tasks";
import type { TaskDto } from "../../src/shared/dto";
import { addedTask, BRANCH, type Call, cleanup, KEY, remoteCommit, SLOW } from "./update-fixture";

for (const m of ["tasks/worktree", "tasks/implement", "tasks/loop", "tasks/repos", "tasks/pr", "review/workspace"])
  console.log(`added.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanup);

type S = Awaited<ReturnType<typeof addedTask>>;
const dto = (s: S): TaskDto => taskDto(s.db, s.t());
const rowOf = (t: TaskDto, repo: string) => t.prs.find((r) => r.repo === repo) as TaskDto["prs"][number];
const remoteHead = (remote: string, env: Record<string, string>, branch = BRANCH) =>
  git(["--git-dir", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { env }).then(
    (x) => x.trim(),
    () => null,
  );

const TEST_FILE = { path: "repo/tests/feature.test.ts", text: "test('feature works', () => {});\n" };
const FEATURE = { path: "repo/src/feature.ts", text: "export const feature = 'works';\n" };
const LIB = { path: "repos/PROJ/lib/lib.c", text: "int lib = 2;\nint client = 1;\n" };

describe("an added repository (spec.md section 6.16.5)", () => {
  test(
    "the spec-run snapshot holds it at repos/PROJ/lib beside repo/, sanitized, at its fetched base",
    async () => {
      const s = await addedTask();
      expect(s.snapshot).toEqual([{ path: "../repos/PROJ/lib", cache: expect.any(String), commit: s.lib.base }]);
      expect(s.db.query("SELECT base_commit FROM task_repo WHERE id = $id").get({ id: s.libRow })).toEqual({ base_commit: s.lib.base });
      const ws = await prepareTaskWorkspace({
        dataDir: s.dataDir,
        runId: "added-snapshot",
        project: "PROJ",
        repo: "app",
        task: s.task,
        branch: "main",
        remote: { url: s.appRepo.remote, config: [] },
        nested: async () => s.snapshot,
      });
      try {
        expect(readFileSync(join(ws.work, "repos", "PROJ", "lib", "lib.c"), "utf8")).toBe("int lib;\n");
        // The added folder gets the same sanitize as the main folder.
        expect(existsSync(join(ws.work, "repos", "PROJ", "lib", "CLAUDE.md"))).toBe(false);
        expect(readFileSync(join(ws.work, "repos", "PROJ", "lib", "CLAUDE.untrusted.md"), "utf8")).toBe("lib rules\n");
        expect(readFileSync(join(ws.repo, "README.md"), "utf8")).toBe("app\n");
      } finally {
        await ws.remove();
      }
    },
    SLOW,
  );

  test(
    "the path check: a change in the added folder passes; a file elsewhere beside repo/ fails",
    async () => {
      const s = await addedTask();
      const trees = await s.trees();
      expect(trees.map((t) => [t.row.role, t.full, t.wt?.branch])).toEqual([
        ["main", "", BRANCH],
        ["added", "../repos/PROJ/lib", BRANCH],
      ]);
      const main = trees[0]?.wt;
      writeFileSync(join(main?.dir as string, "repos", "PROJ", "lib", "client.c"), "int client;\n");
      const ok = await treeCheck(trees, { allow: [], context: new Map() });
      expect([ok.check.changed, ok.check.problems]).toEqual([["../repos/PROJ/lib/client.c"], []]);
      mkdirSync(join(main?.dir as string, "repos", "PROJ", "other"), { recursive: true });
      writeFileSync(join(main?.dir as string, "repos", "PROJ", "other", "x.c"), "int x;\n");
      const bad = await treeCheck(trees, { allow: [], context: new Map() });
      expect(bad.check.problems).toEqual([{ path: "../repos/PROJ/other/x.c", reason: "A step may change files only in repo/." }]);
    },
    SLOW,
  );

  test(
    "AC-B44: the build changes both repositories, commits in both, counts and reviews both; the PR route pushes and creates both with links",
    async () => {
      const s = await addedTask({
        seq: { "implement:tests": [{ writes: [TEST_FILE] }], "implement:implement": [{ writes: [FEATURE, LIB] }] },
      });
      s.loop.build(s.db, s.task);
      await s.loop.idle(s.task);
      const built = dto(s);
      expect([built.state, built.blocked, built.parts[0]?.state, built.parts[0]?.branch]).toEqual([
        "implementing",
        null,
        "self_reviewed",
        BRANCH,
      ]);
      // The implement step got the real folder in context/repos.md and the rule for it.
      const step = s.runCalls().find((c: Call) => c.stdin.includes("- Mode: implement")) as Call;
      expect(step.context["repos.md"]).toContain("- ../repos/PROJ/lib: PROJ/lib · access edit · base main");
      expect(step.stdin).toContain(
        "You can change files only in ./repo and in the folders that ./context/repos.md lists with access edit.",
      );
      // One commit in each repository with the same message, and the task_pr row of lib.
      const commit = s.steps().find((x) => x.kind === "commit" && x.item === "T1.1");
      expect(commit?.detail.notes[1]).toStartWith("Commit ");
      expect(commit?.detail.notes[1]).toEndWith(" in ../repos/PROJ/lib");
      const lib = rowOf(built, "lib");
      const app = rowOf(built, "app");
      expect([lib.role, lib.path, lib.baseBranch, lib.state]).toEqual(["added", "../repos/PROJ/lib", "main", "changed"]);
      const libLog = (
        await git(["--git-dir", join(s.dataDir, "git", "PROJ", "lib.git"), "log", "--format=%s", `${s.lib.base}..${lib.head}`], {
          env: s.lib.env,
        })
      ).trim();
      expect(libLog).toBe(`${KEY} T1.1: Write the feature`);
      // spec.md section 6.16.8: the dialog row names the files and the lines of each repository.
      expect([lib.files, lib.lines]).toEqual([1, 3]);
      expect([app.files, (app.lines ?? 0) > 0]).toEqual([3, true]);
      // The own review ran once per changed repository.
      const covers = "This review covers the repository at ../repos/PROJ/lib only.";
      expect(s.runCalls().filter((c: Call) => (c.context["pr.md"] ?? "").includes(covers))).toHaveLength(1);

      let syncs = 0;
      const op = createPrOpener({ review: s.jobs, settings: s.settings, live: s.live, working: s.loop.running, syncNow: () => syncs++ });
      const rows = built.prs.map((r) => ({ taskRepo: r.taskRepo, reviewers: [] }));
      expect((await op.openRows(s.db, s.task, built.parts[0]?.id as number, { version: built.version, rows })).status).toBe(202);
      await op.idle(s.task);
      expect(s.flow().slice(-4)).toEqual(["push:PROJ/lib:ok", "push:PROJ/app:ok", "pr:PROJ/lib:ok", "pr:PROJ/app:ok"]);
      const done = dto(s);
      expect(await remoteHead(s.lib.remote, s.lib.env)).toBe(rowOf(done, "lib").head);
      expect(await remoteHead(s.appRepo.remote, s.appRepo.env)).toBe(rowOf(done, "app").head);
      expect(s.forges.lib.prs.get(101)?.description).toContain("Related PRs:\n- [PROJ/app #101](");
      expect(s.forges.app.prs.get(101)?.description).toContain("Related PRs:\n- [PROJ/lib #101](");
      expect([done.state, syncs]).toEqual(["ready", 1]);
    },
    SLOW,
  );

  test(
    "the update rebases the added repository onto its moved base, and its base commit moves",
    async () => {
      const s = await addedTask({ built: true });
      const moved = await remoteCommit(s.lib, "main", { "lib.h": "int more;\n" });
      expect((await s.loop.checkBases(s.db, s.task)).status).toBe(200);
      const before = dto(s);
      expect(before.bases.map((b) => [b.taskRepo === s.libRow ? "lib" : "app", b.newCommits])).toEqual([
        ["lib", 1],
        ["app", 0],
      ]);
      expect((await s.loop.update(s.db, s.task, s.part().id, { version: s.t().version })).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.blocked()).toBeNull();
      const row = s.db.query("SELECT base_commit FROM task_repo WHERE id = $id").get({ id: s.libRow }) as { base_commit: string };
      expect(row.base_commit).toBe(moved);
      const head = rowOf(dto(s), "lib").head as string;
      const holds = await git(["--git-dir", join(s.dataDir, "git", "PROJ", "lib.git"), "merge-base", "--is-ancestor", moved, head], {
        env: s.lib.env,
      }).then(
        () => true,
        () => false,
      );
      expect(holds).toBe(true);
    },
    SLOW,
  );
});
