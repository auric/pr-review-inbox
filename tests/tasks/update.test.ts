// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.18.3 to 6.18.5 (WP-TU1, AC-B58 to AC-B65): "Update from <base>" of a built small task part.
// Temp bare remotes, the fake CLI, and a bun script as the test command. The update pushes nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { git } from "../../src/server/review/git";
import { cachePath, gitSetup, longPath } from "../../src/server/review/workspace";
import { pushTaskBranch } from "../../src/server/tasks/push";
import { recoverTasks, taskDto } from "../../src/server/tasks/tasks";
import { gitlinkAt, inMerge, inRebase, markerLeft } from "../../src/server/tasks/update";
import { status, type Worktree, wtGit } from "../../src/server/tasks/worktree";
import { MERGE_CONFLICTED, RESOLVE_STOPS } from "../../src/shared/task";
import { BRANCH, builtTask, cleanup, headOf, implement, KEY, multiTask, remoteCommit, SLOW, WHO, write } from "./update-fixture";

for (const m of ["tasks/loop", "tasks/update", "tasks/tasks", "tasks/implement"])
  console.log(`update.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanup);

const RESOLVED = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const base = 'base';\n" };
const BASE_FEATURE = { "src/feature.ts": "export const feature = 'base';\n" };

type S = Awaited<ReturnType<typeof builtTask>>;
const update = async (s: Pick<S, "loop" | "db" | "task" | "part" | "t">) => {
  const r = await s.loop.update(s.db, s.task, s.part().id, { version: s.t().version });
  await s.loop.idle(s.task);
  return r;
};
const parents = async (s: Pick<S, "log">) => (await s.log()).map((l) => l.split("|")[1]?.split(" ").length);
const spyGit = () => {
  const spawn = Bun.spawn;
  const calls: string[][] = [];
  (Bun as { spawn: unknown }).spawn = ((cmd: unknown, o: unknown) => {
    if (Array.isArray(cmd) && cmd[0] === "git") calls.push(cmd.map(String));
    return (spawn as (a: unknown, b: unknown) => unknown)(cmd, o);
  }) as unknown;
  return { calls, restore: () => ((Bun as { spawn: unknown }).spawn = spawn) };
};
const pushArgs = (s: S, commit: string, lease: string | null) => {
  const dataDir = longPath(s.dataDir);
  return {
    cache: cachePath(dataDir, { project: "PROJ", repo: "repo", id: s.task }),
    emptyGlobal: gitSetup(dataDir).empty,
    url: s.r.remote,
    config: [] as [string, string][],
    commit,
    branch: BRANCH,
    lease,
    task: { key: KEY, prefix: "feature/", branches: [BRANCH], target: s.t().target_branch },
  };
};

describe("Update from the base branch (spec.md section 6.18.3)", () => {
  test(
    "AC-B58, AC-B59: the picked release/2.1 base, fetched by name; before the first push a rebase with no merge commit",
    async () => {
      const s = await builtTask({ base: "release/2.1" });
      const none = await s.loop.update(s.db, s.task, s.part().id, { version: s.t().version });
      expect([none.status, (none as { error: string }).error]).toEqual([409, "release/2.1 has no new commits."]);
      const head = s.part().head;
      const n = await remoteCommit(s.r, "release/2.1", { "README.md": "release readme\n" });
      const spy = spyGit();
      let r: Awaited<ReturnType<typeof update>>;
      try {
        r = await update(s);
      } finally {
        spy.restore();
      }
      expect(r.status).toBe(202);
      const fetches = spy.calls.filter((a) => a.includes("fetch"));
      expect(fetches.some((a) => a.some((x) => x.startsWith("+refs/heads/release/2.1:refs/rl/task/")))).toBe(true);
      expect(fetches.some((a) => a.some((x) => x.includes("refs/heads/main")))).toBe(false);
      expect(spy.calls.some((a) => a.includes("rebase") && a.includes("--onto") && a.includes(n))).toBe(true);
      expect(spy.calls.some((a) => a.includes("push") || a.includes("merge"))).toBe(false);
      expect(s.flow()).toEqual(["update:U1:ok", "check:U1:ok"]);
      expect(s.steps()[0]?.detail.update).toMatchObject({
        result: "green",
        repos: [{ base: "release/2.1", mode: "rebase", newBaseHead: n }],
        preHeads: [{ head }],
      });
      expect(s.t().base_commit).toBe(n);
      expect((await parents(s)).every((p) => p === 1)).toBe(true);
      expect((await s.log())[0]).toEndWith(`|${n}`);
      expect(s.part().head).not.toBe(head);
      expect(s.part().pushed).toBeNull();
      expect(s.blocked()).toBeNull();
      expect(taskDto(s.db, s.t()).bases[0]?.newCommits).toBe(0);
    },
    SLOW,
  );

  test(
    "AC-B59: after the first push a merge commit, and the next normal push passes the fast-forward check with no force",
    async () => {
      const s = await builtTask();
      const head = s.part().head;
      expect((await pushTaskBranch(pushArgs(s, head, null))).status).toBe("pushed");
      s.db.query("UPDATE task_part SET pushed = $h WHERE id = $id").run({ h: head, id: s.part().id });
      const n = await remoteCommit(s.r, "main", { "README.md": "new readme\n" });
      expect((await update(s)).status).toBe(202);
      expect(s.steps()[0]?.detail.update?.repos).toEqual([{ taskRepo: expect.any(Number), base: "main", mode: "merge", newBaseHead: n }]);
      const top = (await s.log())[0] as string;
      expect(top).toStartWith(`${KEY}: merge main into ${BRANCH}|${head} ${n}`);
      expect(s.t().base_commit).toBe(n);
      // The merge commit holds the pushed commit, so the push needs no force.
      expect(await pushTaskBranch(pushArgs(s, s.part().head, head))).toEqual({ status: "pushed" });
    },
    SLOW,
  );

  test(
    "AC-B60, AC-B61: a conflict starts a resolve step with conflicts.md; a clean resolve continues, runs the checks and the own review",
    async () => {
      const s = await builtTask({ seq: { "implement:resolve": [{ writes: [RESOLVED] }] } });
      const n = await remoteCommit(s.r, "main", BASE_FEATURE);
      expect((await update(s)).status).toBe(202);
      expect(s.flow()).toEqual(["update:U1:ok", "resolve:U1:ok", "check:U1:ok", "review:review:ok"]);
      const call = s.runCalls().find((c) => s.modeOf(c) === "resolve");
      const conflicts = call?.context["conflicts.md"] ?? "";
      expect(conflicts).toStartWith("# UNTRUSTED DATA");
      expect(conflicts).toContain("- src/feature.ts");
      expect(conflicts).toContain("- Mode: rebase");
      expect(conflicts).toContain("are the base side");
      expect(conflicts).toContain("are the task side");
      expect(call?.stdin).toContain("Edit only those files. Remove every conflict marker.");
      expect(call?.context["step.md"]).toContain("- Mode: resolve");
      const resolve = s.steps().find((x) => x.kind === "resolve");
      expect(resolve?.detail.resolve).toEqual({ taskRepo: expect.any(Number), paths: ["src/feature.ts"] });
      expect(resolve?.detail.patch).toBe(`${resolve?.id}.patch`);
      expect(s.steps()[0]?.detail.update).toMatchObject({ result: "green", resolved: true, stops: 1 });
      expect(s.t().base_commit).toBe(n);
      expect((await parents(s)).every((p) => p === 1)).toBe(true);
      expect(s.part().lines).toBeGreaterThan(0);
      expect(s.blocked()).toBeNull();
    },
    SLOW,
  );

  test(
    "AC-B60: an edit without a conflict, a remaining marker, and a question each abort, reset to the preHead, and say so",
    async () => {
      const markers = { path: "repo/src/feature.ts", text: "<<<<<<< HEAD\nworks\n=======\nbase\n>>>>>>> x\n" };
      const q = { text: "Which side wins?", why: "Both change the line.", options: [], recommended: null };
      const s = await builtTask({
        seq: {
          "implement:resolve": [
            { writes: [RESOLVED, { path: "repo/README.md", text: "changed\n" }] },
            { writes: [markers] },
            { implement: implement({ question: q }) },
          ],
        },
      });
      const head = s.part().head;
      const base = s.t().base_commit;
      await remoteCommit(s.r, "main", BASE_FEATURE);
      const reasons: string[] = [];
      for (let k = 0; k < 3; k++) {
        expect((await update(s)).status).toBe(202);
        const b = s.blocked();
        expect(b?.kind).toBe("update");
        reasons.push(b?.text ?? "");
        const w = await s.wt();
        expect([await headOf(w), await inRebase(w), await inMerge(w)]).toEqual([head, false, false]);
        expect((await wtGit(w, ["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${BRANCH}`);
        expect(await status(w)).toEqual([]);
        expect([s.part().head, s.t().base_commit]).toEqual([head, base]);
      }
      expect(reasons).toEqual([
        "The update from main stopped: Claude changed README.md, which has no conflict. The branch is as it was.",
        "The update from main stopped: conflict markers remain in src/feature.ts. The branch is as it was.",
        "The update from main stopped: Claude could not resolve src/feature.ts: Which side wins? The branch is as it was.",
      ]);
      const updates = s.steps().filter((x) => x.kind === "update");
      expect(updates.map((x) => [x.state, x.detail.update?.result])).toEqual([
        ["failed", "aborted"],
        ["failed", "aborted"],
        ["failed", "aborted"],
      ]);
      // The changes of each resolve step stay as a patch.
      const resolves = s.steps().filter((x) => x.kind === "resolve");
      expect(resolves.map((x) => x.detail.patch)).toEqual(resolves.map((x) => `${x.id}.patch`));
    },
    SLOW,
  );

  test(
    `more than RESOLVE_STOPS (${RESOLVE_STOPS}) conflict stops in one repository abort the update`,
    async () => {
      const commits = Array.from({ length: RESOLVE_STOPS }, (_, i) => ({ "src/feature.ts": `export const feature = 'works ${i + 2}';\n` }));
      const s = await builtTask({ commits, seq: { "implement:resolve": [{ writes: [RESOLVED] }] } });
      const head = s.part().head;
      await remoteCommit(s.r, "main", BASE_FEATURE);
      expect((await update(s)).status).toBe(202);
      expect(s.blocked()?.text).toBe(
        `The update from main stopped: more than ${RESOLVE_STOPS} conflict stops in PROJ/repo. The branch is as it was.`,
      );
      expect(s.steps().filter((x) => x.kind === "resolve")).toHaveLength(RESOLVE_STOPS);
      expect(await headOf(await s.wt())).toBe(head);
    },
    SLOW * 2,
  );

  test(
    "AC-B65: red checks after an update block with Undo; Undo restores the heads and base_commit; after a push, Undo returns 409",
    async () => {
      const s = await builtTask();
      const head = s.part().head;
      const base = s.t().base_commit;
      const n = await remoteCommit(s.r, "main", { "README.md": "new readme\n" });
      s.mode("red");
      expect((await update(s)).status).toBe(202);
      expect(s.blocked()).toMatchObject({ kind: "red", text: "Needs you: the tests fail after the update from main." });
      expect(s.steps()[0]?.detail.update?.result).toBe("red");
      expect(s.t().base_commit).toBe(n);
      expect(taskDto(s.db, s.t()).canUndoUpdate).toBe(true);
      // No fix step runs after red checks of an update (Q56).
      expect(s.runCalls()).toEqual([]);
      const undo = await s.loop.undoUpdate(s.db, s.task, s.part().id, { version: s.t().version });
      expect(undo.status).toBe(200);
      expect([s.part().head, s.t().base_commit, s.blocked()]).toEqual([head, base, null]);
      expect(await headOf(await s.wt())).toBe(head);
      expect(s.steps()[0]?.detail.update?.undone).toBe(true);
      expect(taskDto(s.db, s.t()).canUndoUpdate).toBe(false);
      s.mode("feature");
      expect((await update(s)).status).toBe(202);
      expect(taskDto(s.db, s.t()).canUndoUpdate).toBe(true);
      s.db
        .query("INSERT INTO task_step (task, part, kind, state, ord, started_at) VALUES ($t, $p, 'push', 'ok', 99, 1)")
        .run({ t: s.task, p: s.part().id });
      const late = await s.loop.undoUpdate(s.db, s.task, s.part().id, { version: s.t().version });
      expect([late.status, (late as { error: string }).error]).toEqual([
        409,
        "The update is on the server now. Undo works only before the next push.",
      ]);
    },
    SLOW,
  );

  test(
    "AC-B64: a restart during an update aborts the merge and resets each repository to its preHead",
    async () => {
      const s = await builtTask();
      const head = s.part().head;
      const n = await remoteCommit(s.r, "main", BASE_FEATURE);
      const w = await s.wt();
      await git([`--git-dir=${w.cache}`, "fetch", "-q", s.r.remote, `+refs/heads/main:refs/rl/test/main`], { env: w.env });
      const ids = { GIT_COMMITTER_NAME: WHO.name, GIT_COMMITTER_EMAIL: WHO.email, GIT_EDITOR: "true" };
      // A merge keeps HEAD on the branch, so only the recovery can end it.
      await wtGit(w, ["merge", "--no-ff", "-m", "m", n], { extra: ids }).catch(() => "");
      expect(await inMerge(w)).toBe(true);
      const detail = {
        update: {
          repos: [{ taskRepo: 0, base: "main", mode: "merge", newBaseHead: n }],
          preHeads: [{ taskRepo: 0, head, baseCommit: s.base, pinned: null }],
        },
      };
      const step = (
        s.db
          .query(`INSERT INTO task_step (task, part, kind, state, ord, item, detail_json, started_at)
            VALUES ($t, $p, 'update', 'running', 1, 'U1', $d, 1) RETURNING id`)
          .get({ t: s.task, p: s.part().id, d: JSON.stringify(detail) }) as { id: number }
      ).id;
      recoverTasks(s.db, Date.now());
      expect(s.t().state).toBe("stopped");
      s.loop.recover(s.db);
      await s.loop.idle(s.task);
      const after = await s.wt();
      expect([await inMerge(after), await inRebase(after), await headOf(after)]).toEqual([false, false, head]);
      expect(await status(after)).toEqual([]);
      expect((await wtGit(after, ["symbolic-ref", "HEAD"])).trim()).toBe(`refs/heads/${BRANCH}`);
      const row = s.steps().find((x) => x.id === step);
      expect(row?.state).toBe("failed");
      expect(row?.detail.update).toMatchObject({ result: "restart", recovered: true });
      expect(row?.detail.notes).toContain("The app stopped during the update.");
    },
    SLOW,
  );
});

describe("several repositories (spec.md section 6.18.3, AC-B63)", () => {
  const holds = (w: Worktree, a: string, b: string) =>
    git([`--git-dir=${w.cache}`, "merge-base", "--is-ancestor", a, b], { env: w.env }).then(
      () => true,
      () => false,
    );

  test(
    "each repository updates from its own base, the submodule first, and the parent gitlink points at the new submodule head",
    async () => {
      const s = await multiTask({ appBase: "release/2.1" });
      const nLib = await remoteCommit(s.m.lib, "main", { "lib.h": "int more;\n" });
      const nApp = await remoteCommit(s.m.app, "release/2.1", { "README.md": "app 2\n" });
      const spy = spyGit();
      try {
        expect((await update(s)).status).toBe(202);
      } finally {
        spy.restore();
      }
      expect(s.blocked()).toBeNull();
      const d = s.steps().find((x) => x.kind === "update")?.detail.update;
      expect(d?.repos.map((x) => [x.base, x.mode, x.newBaseHead])).toEqual([
        ["main", "rebase", nLib],
        ["release/2.1", "rebase", nApp],
      ]);
      const rebases = spy.calls.filter((a) => a.includes("rebase") && a.includes("--onto"));
      expect(rebases.map((a) => (a.includes(nLib) ? "lib" : a.includes(nApp) ? "app" : "?"))).toEqual(["lib", "app"]);
      const lib = (await s.tree("lib")).wt as Worktree;
      const libNow = await headOf(lib);
      expect(await holds(lib, nLib, libNow)).toBe(true);
      expect(await gitlinkAt(await s.wt(), "HEAD", "lib")).toBe(libNow);
      expect((await s.log())[0]).toStartWith(`${KEY}: point lib at the updated task branch|`);
      expect(s.t().base_commit).toBe(nApp);
      const row = s.db.query("SELECT id, base_commit FROM task_repo WHERE task = $t AND path = 'lib'").get({ t: s.task }) as {
        id: number;
        base_commit: string;
      };
      expect(row.base_commit).toBe(nLib);
      expect(s.db.query("SELECT head, base_commit FROM task_pr WHERE task_repo = $r").get({ r: row.id })).toEqual({
        head: libNow,
        base_commit: nLib,
      });
      expect(taskDto(s.db, s.t()).bases.map((b) => [b.branch, b.newCommits])).toEqual([
        ["main", 0],
        ["release/2.1", 0],
      ]);
    },
    SLOW,
  );

  test(
    "a gitlink conflict resolves to the new submodule head only when the new parent base points at an ancestor; else every repository resets",
    async () => {
      const s = await multiTask();
      const appPre = s.part().head;
      const libPre = await headOf((await s.tree("lib")).wt as Worktree);
      const nLib = await remoteCommit(s.m.lib, "main", { "lib.h": "int more;\n" });
      // A lib commit on another branch, which the task branch never holds.
      await git(["--git-dir", s.m.lib.remote, "update-ref", "refs/heads/side", s.m.lib.base], { env: s.m.lib.env });
      const side = await remoteCommit(s.m.lib, "side", { "side.c": "int side;\n" });
      await remoteCommit(s.m.app, "main", { lib: { gitlink: side } });
      expect((await update(s)).status).toBe(202);
      expect(s.blocked()?.text).toBe(
        "The update from main stopped: The new main of PROJ/app points lib at a commit that the PROJ/lib task branch does not contain. The branch is as it was.",
      );
      expect([s.part().head, await headOf(await s.wt()), await headOf((await s.tree("lib")).wt as Worktree)]).toEqual([
        appPre,
        appPre,
        libPre,
      ]);
      // Try again after the parent base points lib at the new lib base head: the app resolves the gitlink, Claude gets no step.
      await remoteCommit(s.m.app, "main", { lib: { gitlink: nLib } });
      expect((await update(s)).status).toBe(202);
      expect(s.blocked()).toBeNull();
      expect(s.runCalls().filter((c) => s.modeOf(c) === "resolve")).toEqual([]);
      const lib = (await s.tree("lib")).wt as Worktree;
      const libNow = await headOf(lib);
      expect(await holds(lib, nLib, libNow)).toBe(true);
      expect(await gitlinkAt(await s.wt(), "HEAD", "lib")).toBe(libNow);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "update")
          .map((x) => x.detail.update?.result),
      ).toEqual(["aborted", "green"]);
    },
    SLOW,
  );
});

describe("When the app suggests the update (spec.md section 6.18.5)", () => {
  test("AC-B62: a synced task PR with mergeResult CONFLICTED and current true is conflicted; current false is not", async () => {
    const s = await builtTask();
    const pr = (
      s.db.query("INSERT INTO pull_request (project, repo, pr_id, state) VALUES ('PROJ', 'repo', 5, 'OPEN') RETURNING id").get() as {
        id: number;
      }
    ).id;
    const result = (outcome: string, current: boolean) =>
      s.db
        .query("INSERT OR REPLACE INTO pr_merge_result (pr, merge_result) VALUES ($pr, $m)")
        .run({ pr, m: JSON.stringify({ outcome, current }) });
    s.db.query("UPDATE task_part SET pr = $pr, state = 'pr_open' WHERE id = $id").run({ pr, id: s.part().id });
    s.db.query("UPDATE task SET state = 'ready' WHERE id = $id").run({ id: s.task });
    expect(taskDto(s.db, s.t()).bases[0]?.conflicted).toBe(false);
    result(MERGE_CONFLICTED, true);
    expect(taskDto(s.db, s.t()).bases[0]?.conflicted).toBe(true);
    result(MERGE_CONFLICTED, false);
    expect(taskDto(s.db, s.t()).bases[0]?.conflicted).toBe(false);
    result("CLEAN", true);
    expect(taskDto(s.db, s.t()).bases[0]?.conflicted).toBe(false);
  });

  test("the marker check finds start, base, and end markers at the marker size, and accepts a lone ======= line", async () => {
    const s = await builtTask();
    const w = await s.wt();
    await write(w, { "a.txt": "x\n<<<<<<< HEAD\ny\n", "b.txt": "Title\n=======\ntext\n", "c.txt": "||||||| base\n", "d.txt": ">>>>>>>\n" });
    expect(await markerLeft(w, ["b.txt"])).toBeNull();
    expect(await markerLeft(w, ["b.txt", "a.txt"])).toBe("a.txt");
    expect(await markerLeft(w, ["c.txt"])).toBe("c.txt");
    expect(await markerLeft(w, ["d.txt"])).toBe("d.txt");
    // git-merge(1): conflict-marker-size sets the marker length. Seven characters are no marker then; eight are no marker at size 7.
    await write(w, { ".gitattributes": "e.txt conflict-marker-size=10\n", "e.txt": "<<<<<<< HEAD\n", "f.txt": "<<<<<<<< HEAD\n" });
    expect(await markerLeft(w, ["e.txt", "f.txt"])).toBeNull();
    await write(w, { "e.txt": "<<<<<<<<<< HEAD\n" });
    expect(await markerLeft(w, ["e.txt"])).toBe("e.txt");
    expect(await markerLeft(w, ["gone.txt"])).toBeNull();
    expect(existsSync(join(w.repo, "gone.txt"))).toBe(false);
  });
});

describe("Pick a base branch after commits (spec.md section 6.16.7)", () => {
  // develop moves one commit past main, and the part moves onto it. Then develop goes away on the server, so the build blocks.
  const goneDevelop = async () => {
    const s = await builtTask({ base: "develop" });
    const old = await remoteCommit(s.r, "develop", { "develop.txt": "old base\n" }, "develop only");
    expect((await update(s)).status).toBe(202);
    expect(s.t().base_commit).toBe(old);
    await git(["--git-dir", s.r.remote, "update-ref", "-d", "refs/heads/develop"], { env: s.r.env });
    s.loop.build(s.db, s.task);
    await s.loop.idle(s.task);
    expect(s.blocked()?.base).toEqual({ taskRepo: 0, branch: "develop" });
    const pick = (branch: string) => s.loop.base(s.db, s.task, { version: s.t().version, taskRepo: 0, branch });
    return { s, old, pick };
  };

  test(
    "a picked base behind the old one: the update rebases from the old base commit, so the branch keeps no commit of the old base",
    async () => {
      const { s, old, pick } = await goneDevelop();
      expect((await pick("main")).status).toBe(200);
      await s.loop.idle(s.task);
      expect([s.t().target_branch, s.t().base_commit, s.blocked()]).toEqual(["main", old, null]);
      const before = taskDto(s.db, s.t());
      expect(before.bases).toEqual([{ taskRepo: expect.any(Number), branch: "main", newCommits: 0, conflicted: false, changed: true }]);
      expect((await update(s)).status).toBe(202);
      expect(s.steps().findLast((x) => x.kind === "update")?.detail.update).toMatchObject({
        result: "green",
        repos: [{ base: "main", mode: "rebase", newBaseHead: s.base }],
      });
      expect(s.t().base_commit).toBe(s.base);
      const w = await s.wt();
      const hasOld = await git([`--git-dir=${w.admin}`, "merge-base", "--is-ancestor", old, "HEAD"], { env: w.env }).then(
        () => true,
        () => false,
      );
      expect(hasOld).toBe(false);
      expect((await git([`--git-dir=${w.admin}`, "ls-tree", "HEAD", "develop.txt"], { env: w.env })).trim()).toBe("");
      expect(await s.log()).toEqual([`${KEY}: Add the plan|${s.base}`]);
      expect(taskDto(s.db, s.t()).bases.every((b) => !b.changed)).toBe(true);
      expect(s.db.query("SELECT base_changed FROM task_repo WHERE task = $id AND role = 'main'").get({ id: s.task })).toEqual({
        base_changed: 0,
      });
    },
    SLOW,
  );

  test(
    "both Open the PR routes answer 409 with the update sentence while the base change waits for its update",
    async () => {
      const { s, pick } = await goneDevelop();
      expect((await pick("main")).status).toBe(200);
      await s.loop.idle(s.task);
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const call = async (path: string, body: unknown) => {
        const res = await app.request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, error: ((await res.json()) as { error?: string }).error };
      };
      const sentence = "The base branch is now main. Update from it first, so the PR has only your commits.";
      const main = taskDto(s.db, s.t()).bases[0]?.taskRepo as number;
      const part = s.part().id;
      expect(await call(`/api/tasks/${s.task}/parts/${part}/pr`, { version: s.t().version, reviewers: [] })).toEqual({
        status: 409,
        error: sentence,
      });
      expect(
        await call(`/api/tasks/${s.task}/parts/${part}/prs`, { version: s.t().version, rows: [{ taskRepo: main, reviewers: [] }] }),
      ).toEqual({ status: 409, error: sentence });
      // Nothing went to the temp remote. After the update, the refusal goes, and the route pushes there.
      expect(s.part().pushed).toBeNull();
      expect((await update(s)).status).toBe(202);
      expect((await call(`/api/tasks/${s.task}/parts/${part}/pr`, { version: s.t().version, reviewers: [] })).error).not.toBe(sentence);
      expect(s.part().pushed).toBe(s.part().head);
    },
    SLOW,
  );

  test(
    "a push, a Continue lease, or a PR of the repository refuses Pick a base branch",
    async () => {
      const { s, pick } = await goneDevelop();
      const refused = "The base branch of PROJ/repo changes only before its first push and PR.";
      const id = s.part().id;
      s.db.query("UPDATE task_part SET pushed = head WHERE id = $id").run({ id });
      expect(await pick("main")).toMatchObject({ status: 409, error: refused });
      s.db.query("UPDATE task_part SET pushed = NULL, remote_pr = 5 WHERE id = $id").run({ id });
      expect(await pick("main")).toMatchObject({ status: 409, error: refused });
      s.db.query("UPDATE task_part SET remote_pr = NULL WHERE id = $id").run({ id });
      expect(s.t().target_branch).toBe("develop");
      expect((await pick("main")).status).toBe(200);
      await s.loop.idle(s.task);
      // The task is not blocked now, so a second pick has no reason to answer.
      expect(await pick("main")).toMatchObject({ status: 409, error: "The base branch changes only before the build." });
    },
    SLOW,
  );
});
