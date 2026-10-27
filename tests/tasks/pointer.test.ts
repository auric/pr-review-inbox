// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.16.8 and 6.16.10 (WP-MR2, AC-B41): "Point <parent> at the merged commit" after the submodule PR
// merged. The merge commit comes from the MERGED activity (Gate G17), else from properties.mergeCommit, else the user confirms the newest
// base commit. Temp bare remotes and the fake Bitbucket. No test reaches a forge or starts the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { git } from "../../src/server/review/git";
import { createPrOpener } from "../../src/server/tasks/pr";
import { taskDto } from "../../src/server/tasks/tasks";
import { gitlinkAt } from "../../src/server/tasks/update";
import type { TaskDto } from "../../src/shared/dto";
import { BRANCH, cleanup, KEY, multiTask, SLOW } from "./update-fixture";

for (const m of ["tasks/pr", "tasks/pointer", "tasks/update", "bitbucket/provider"])
  console.log(`pointer.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanup);

type S = Awaited<ReturnType<typeof multiTask>>;
const dto = (s: S): TaskDto => taskDto(s.db, s.t());
const rowOf = (t: TaskDto, repo: string) => t.prs.find((r) => r.repo === repo) as TaskDto["prs"][number];

// Both PRs open, then Bitbucket merges the lib PR into main with a merge commit, and the sync marks the row merged.
async function merged(o: { activity?: "merge" | null; property?: "merge" | "bogus" } = {}) {
  const s = await multiTask({ forge: true });
  const op = createPrOpener({ review: s.jobs, settings: s.settings, live: s.live, working: s.loop.running, syncNow: () => {} });
  const t = dto(s);
  const rows = t.prs.map((r) => ({ taskRepo: r.taskRepo, reviewers: [] }));
  expect((await op.openRows(s.db, s.task, s.part().id, { version: t.version, rows })).status).toBe(202);
  await op.idle(s.task);
  const open = dto(s);
  const lib = rowOf(open, "lib");
  expect(lib.state).toBe("pr_open");
  const g = (args: string[]) => git(["--git-dir", s.m.lib.remote, ...args], { env: s.m.lib.env }).then((x) => x.trim());
  const main = await g(["rev-parse", "refs/heads/main"]);
  const tree = await g(["rev-parse", `${lib.head}^{tree}`]);
  const merge = await g(["commit-tree", tree, "-p", main, "-p", lib.head as string, "-m", "Merge pull request #101"]);
  await g(["update-ref", "refs/heads/main", merge]);
  const pick = (x: "merge" | "bogus" | null | undefined) => (x === "merge" ? merge : x === "bogus" ? "f".repeat(40) : x);
  s.m.forges.lib?.merge(101, { activity: o.activity === undefined ? merge : pick(o.activity), property: pick(o.property) ?? undefined });
  // The sync engine does this on its next cycle (tests/sync/engine.test.ts covers it).
  s.db.query("UPDATE task_pr SET state = 'merged' WHERE id = $id").run({ id: lib.id });
  return { s, op, lib, merge, appHead: rowOf(open, "app").head as string };
}

const appRemoteHead = (s: S) => git(["--git-dir", s.m.app.remote, "rev-parse", `refs/heads/${BRANCH}`], { env: s.m.app.env });

describe("Point the parent at the merged commit (spec.md section 6.16.8)", () => {
  test(
    "AC-B41: the MERGED activity names the commit; the click commits the gitlink at it and pushes the parent with its lease",
    async () => {
      // properties.mergeCommit names a commit that is on no branch: the activity must win.
      const { s, op, lib, merge, appHead } = await merged({ property: "bogus" });
      expect(dto(s).prs.find((r) => r.repo === "lib")).toMatchObject({ state: "merged", pointer: "task_branch" });
      // Nothing moves before the click.
      expect((await appRemoteHead(s)).trim()).toBe(appHead);

      const r = await op.pointer(s.db, s.task, lib.id as number, { version: s.t().version });
      expect(r.status).toBe(202);
      await op.idle(s.task);
      expect(s.flow().slice(-2)).toEqual(["commit:pointer:ok", "push:PROJ/app:ok"]);
      const after = dto(s);
      const app = rowOf(after, "app");
      expect(rowOf(after, "lib")).toMatchObject({ state: "merged", pointer: "merged_commit", head: merge, error: null });
      expect(app.head).not.toBe(appHead);
      expect([app.pushed, (await appRemoteHead(s)).trim()]).toEqual([app.head, app.head]);
      const wt = await s.wt();
      expect(await gitlinkAt(wt, "HEAD", "lib")).toBe(merge);
      const log = (await git([`--git-dir=${wt.admin}`, "log", "-1", "--format=%s|%P"], { env: wt.env })).trim();
      expect(log).toBe(`${KEY}: point lib at the merged commit|${appHead}`);
      // The submodule worktree follows, so the parent has no change left.
      expect(await git([`--git-dir=${wt.admin}`, `--work-tree=${wt.repo}`, "status", "--porcelain"], { env: wt.env })).toBe("");
      expect(s.db.query("SELECT pinned, base_commit FROM task_repo WHERE id = $id").get({ id: lib.taskRepo })).toEqual({
        pinned: merge,
        base_commit: merge,
      });
      // A second click changes nothing.
      expect((await op.pointer(s.db, s.task, lib.id as number, { version: s.t().version })).status).toBe(200);
    },
    SLOW,
  );

  test(
    "with only properties.mergeCommit, the click points the parent at that commit",
    async () => {
      const { s, op, lib, merge } = await merged({ activity: null, property: "merge" });
      expect((await op.pointer(s.db, s.task, lib.id as number, { version: s.t().version })).status).toBe(202);
      await op.idle(s.task);
      expect(rowOf(dto(s), "lib").pointer).toBe("merged_commit");
      expect(await gitlinkAt(await s.wt(), "HEAD", "lib")).toBe(merge);
    },
    SLOW,
  );

  test(
    "with no merge commit, 409 asks for the newest base commit; the confirm points the parent at the newest lib main",
    async () => {
      const { s, op, lib, merge } = await merged({ activity: null });
      const r = await op.pointer(s.db, s.task, lib.id as number, { version: s.t().version });
      expect([r.status, "error" in r && r.error]).toEqual([
        409,
        "Bitbucket did not name the merge commit. Point PROJ/app at the newest main commit of PROJ/lib?",
      ]);
      expect(s.flow().slice(-1)).toEqual(["pr:PROJ/app:ok"]);
      const ok = await op.pointer(s.db, s.task, lib.id as number, { version: s.t().version, newest: true });
      expect(ok.status).toBe(202);
      await op.idle(s.task);
      expect(await gitlinkAt(await s.wt(), "HEAD", "lib")).toBe(merge);
      expect(rowOf(dto(s), "lib").pointer).toBe("merged_commit");
    },
    SLOW,
  );

  test(
    "a merge commit that is not on the base branch fails the step with its sentence, and nothing is pushed",
    async () => {
      const { s, op, lib, appHead } = await merged({ activity: null, property: "bogus" });
      expect((await op.pointer(s.db, s.task, lib.id as number, { version: s.t().version })).status).toBe(202);
      await op.idle(s.task);
      expect(s.flow().slice(-1)).toEqual(["commit:pointer:failed"]);
      expect(rowOf(dto(s), "lib")).toMatchObject({
        pointer: "task_branch",
        error: `The merge commit ${"f".repeat(12)} is not on main of PROJ/lib.`,
      });
      expect((await appRemoteHead(s)).trim()).toBe(appHead);
    },
    SLOW,
  );

  test(
    "a PR that is not merged yet gets 409",
    async () => {
      const { s, op, lib } = await merged();
      s.db.query("UPDATE task_pr SET state = 'pr_open' WHERE id = $id").run({ id: lib.id });
      const r = await op.pointer(s.db, s.task, lib.id as number, { version: s.t().version });
      expect([r.status, "error" in r && r.error]).toEqual([409, "The PROJ/lib PR is not merged yet."]);
    },
    SLOW,
  );
});
