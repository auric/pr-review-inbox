// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.16.8 (WP-MR2, AC-B38, AC-B39, AC-B40, AC-B43): "Push and open N PRs" of a task with a main
// repository and its submodules. Temp bare remotes, the fake Bitbucket, and the fake CLI. Every push and create runs only on the call of
// the route method, which stands for the user's click. No test reaches a forge or starts the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/server/review/git";
import { createPrOpener, withRelated } from "../../src/server/tasks/pr";
import { baseGoneText } from "../../src/server/tasks/preflight";
import { taskDto } from "../../src/server/tasks/tasks";
import type { TaskDto } from "../../src/shared/dto";
import { taskView } from "../../src/web/tasks/model";
import { key } from "../support/fake-bitbucket";
import { BRANCH, cleanup, KEY, multiTask, remoteCommit, SLOW } from "./update-fixture";

for (const m of ["tasks/pr", "tasks/repos", "tasks/preflight", "tasks/push", "bitbucket/provider"])
  console.log(`multi-pr.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanup);

type S = Awaited<ReturnType<typeof multiTask>>;

// The opener of the routes, with a sync counter.
function opener(s: S) {
  let syncs = 0;
  const op = createPrOpener({
    review: s.jobs,
    settings: s.settings,
    live: s.live,
    working: s.loop.running,
    syncNow: () => {
      syncs++;
    },
  });
  return { op, syncs: () => syncs };
}

const dto = (s: S): TaskDto => taskDto(s.db, s.t());
const rowOf = (t: TaskDto, repo: string) => t.prs.find((r) => r.repo === repo) as TaskDto["prs"][number];
const remoteHead = (remote: string, env: Record<string, string>, branch = BRANCH) =>
  git(["--git-dir", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { env }).then(
    (x) => x.trim(),
    () => null,
  );
const creates = (s: S) => s.fake.requests.filter((r) => /^POST \/rest\/api\/1\.0\/projects\/PROJ\/repos\/\w+\/pull-requests$/.test(r));

// Records the argv of each git child process.
const spyGit = () => {
  const spawn = Bun.spawn;
  const calls: string[][] = [];
  (Bun as { spawn: unknown }).spawn = ((cmd: unknown, o: unknown) => {
    if (Array.isArray(cmd) && cmd[0] === "git") calls.push(cmd.map(String));
    return (spawn as (a: unknown, b: unknown) => unknown)(cmd, o);
  }) as unknown;
  return { calls, restore: () => ((Bun as { spawn: unknown }).spawn = spawn) };
};

// The rows of every changed repository with their reviewers.
const allRows = (t: TaskDto) => t.prs.map((r) => ({ taskRepo: r.taskRepo, reviewers: [] as string[] }));

describe("Push and open the PRs of several repositories (spec.md section 6.16.8)", () => {
  test(
    "AC-B38: the submodule pushes first, then the main repository, then the submodule PR opens first; both descriptions link the other PR",
    async () => {
      const s = await multiTask({ forge: true });
      const { op, syncs } = opener(s);
      const before = dto(s);
      expect(before.prs.map((r) => [r.role, `${r.project}/${r.repo}`, r.state, r.branch, r.baseBranch])).toEqual([
        ["submodule", "PROJ/lib", "changed", BRANCH, "main"],
        ["main", "PROJ/app", "changed", BRANCH, "main"],
      ]);
      // Nothing reached a remote or the server before the click.
      expect(await remoteHead(s.m.lib.remote, s.m.lib.env)).toBeNull();
      expect(await remoteHead(s.m.app.remote, s.m.app.env)).toBeNull();
      expect(creates(s)).toEqual([]);

      const spy = spyGit();
      try {
        const r = await op.openRows(s.db, s.task, s.part().id, { version: before.version, rows: allRows(before).reverse() });
        expect(r.status).toBe(202);
        await op.idle(s.task);
      } finally {
        spy.restore();
      }
      const pushes = spy.calls.filter((a) => a.includes("push"));
      expect(pushes.map((a) => (a.includes(s.m.lib.remote) ? "lib" : a.includes(s.m.app.remote) ? "app" : "?"))).toEqual(["lib", "app"]);
      // Each push names an explicit lease, never a "+" refspec. A new branch has the empty lease.
      for (const a of pushes) {
        expect(a).toContain(`--force-with-lease=refs/heads/${BRANCH}:`);
        expect(a.at(-1)?.startsWith("+")).toBe(false);
      }
      expect(creates(s)).toEqual([
        "POST /rest/api/1.0/projects/PROJ/repos/lib/pull-requests",
        "POST /rest/api/1.0/projects/PROJ/repos/app/pull-requests",
      ]);
      expect(s.flow().slice(-4)).toEqual(["push:PROJ/lib:ok", "push:PROJ/app:ok", "pr:PROJ/lib:ok", "pr:PROJ/app:ok"]);
      const after = dto(s);
      const lib = rowOf(after, "lib");
      const app = rowOf(after, "app");
      expect([lib.state, lib.remotePr, lib.pointer, app.state, app.remotePr]).toEqual(["pr_open", 101, "task_branch", "pr_open", 101]);
      expect(await remoteHead(s.m.lib.remote, s.m.lib.env)).toBe(lib.head);
      expect(await remoteHead(s.m.app.remote, s.m.app.env)).toBe(app.head);
      expect(await remoteHead(s.m.app.remote, s.m.app.env, "main")).toBe(s.m.app.base);
      // The main PR opened, so the task waits for its review.
      expect([after.state, after.parts[0]?.state]).toEqual(["ready", "pr_open"]);
      const libPr = s.m.forges.lib?.prs.get(101);
      const appPr = s.m.forges.app?.prs.get(101);
      expect(libPr?.description).toContain(`Related PRs:\n- [PROJ/app #101](${s.fake.url}/projects/PROJ/repos/app/pull-requests/101)`);
      expect(appPr?.description).toContain(`Related PRs:\n- [PROJ/lib #101](${s.fake.url}/projects/PROJ/repos/lib/pull-requests/101)`);
      expect([libPr?.title, appPr?.title, libPr?.toRef.id, appPr?.fromRef.id]).toEqual([
        `${KEY}: Add the feature`,
        `${KEY}: Add the feature`,
        "refs/heads/main",
        `refs/heads/${BRANCH}`,
      ]);
      // Only the earlier PR got its links after the last create, with a fresh version.
      expect(s.m.forges.lib?.writes.map((w) => `${w.method} ${w.body.version ?? "-"}`)).toEqual(["POST -", "PUT 0"]);
      expect(s.m.forges.app?.writes.map((w) => w.method)).toEqual(["POST"]);
      expect(syncs()).toBe(1);
      // A second click gets the same PRs: no push, no create.
      const again = await op.openRows(s.db, s.task, s.part().id, { version: after.version, rows: allRows(after) });
      expect(again.status).toBe(200);
      expect(creates(s)).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "AC-B40: a failed submodule push stops the parent push; the retry pushes both and opens both PRs",
    async () => {
      const s = await multiTask({ forge: true });
      const { op } = opener(s);
      // The remote of lib refuses every push with its pre-receive hook.
      const hooks = join(s.m.lib.remote, "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\necho refused on purpose >&2\nexit 1\n");
      chmodSync(join(hooks, "pre-receive"), 0o755);
      const t = dto(s);
      expect((await op.openRows(s.db, s.task, s.part().id, { version: t.version, rows: allRows(t) })).status).toBe(202);
      await op.idle(s.task);
      expect(s.flow().slice(-2)).toEqual(["push:PROJ/lib:failed", "push:PROJ/app:failed"]);
      const failed = dto(s);
      expect(rowOf(failed, "lib")).toMatchObject({ state: "failed", pushed: null });
      expect(rowOf(failed, "lib").error).toStartWith(`The push of ${BRANCH} failed:`);
      expect(rowOf(failed, "app")).toMatchObject({
        state: "failed",
        pushed: null,
        error: "PROJ/app waits, because PROJ/lib is not on the server yet.",
      });
      expect(await remoteHead(s.m.lib.remote, s.m.lib.env)).toBeNull();
      expect(await remoteHead(s.m.app.remote, s.m.app.env)).toBeNull();
      expect(creates(s)).toEqual([]);
      expect(failed.state).toBe("implementing");

      writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\nexit 0\n");
      expect((await op.openRows(s.db, s.task, s.part().id, { version: failed.version, rows: allRows(failed) })).status).toBe(202);
      await op.idle(s.task);
      const done = dto(s);
      expect([rowOf(done, "lib").state, rowOf(done, "app").state, rowOf(done, "lib").error]).toEqual(["pr_open", "pr_open", null]);
      expect(creates(s)).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "AC-B39: a refused create leaves the other PRs open; the retry of that row creates only its PR, and every PR links the other two",
    async () => {
      const s = await multiTask({ forge: true, other: true });
      const { op } = opener(s);
      const t = dto(s);
      expect(t.prs.map((r) => r.repo)).toEqual(["lib", "other", "app"]);
      const create = key("POST", "/rest/api/1.0/projects/PROJ/repos/other/pull-requests");
      const real = s.fake.routes[create];
      s.fake.routes[create] = { status: 403, body: { errors: [{ message: "Forbidden" }] } };
      expect((await op.openRows(s.db, s.task, s.part().id, { version: t.version, rows: allRows(t) })).status).toBe(202);
      await op.idle(s.task);
      const partial = dto(s);
      expect(partial.prs.map((r) => [r.repo, r.state])).toEqual([
        ["lib", "pr_open"],
        ["other", "failed"],
        ["app", "pr_open"],
      ]);
      expect(rowOf(partial, "other").error).toBe(
        "The token cannot create pull requests in PROJ/other. Give it Repository write in Bitbucket, then try again.",
      );
      // The pushes all ran before the creates.
      expect(s.flow().slice(-6)).toEqual([
        "push:PROJ/lib:ok",
        "push:PROJ/other:ok",
        "push:PROJ/app:ok",
        "pr:PROJ/lib:ok",
        "pr:PROJ/other:failed",
        "pr:PROJ/app:ok",
      ]);

      s.fake.routes[create] = real as NonNullable<typeof real>;
      const other = rowOf(partial, "other");
      const retry = await op.openRows(s.db, s.task, s.part().id, {
        version: partial.version,
        rows: [{ taskRepo: other.taskRepo, reviewers: [] }],
      });
      expect(retry.status).toBe(202);
      await op.idle(s.task);
      // No second push of other, no second create of lib or app.
      expect(s.flow().slice(-1)).toEqual(["pr:PROJ/other:ok"]);
      expect(s.m.forges.lib?.writes.filter((w) => w.method === "POST")).toHaveLength(1);
      expect(s.m.forges.app?.writes.filter((w) => w.method === "POST")).toHaveLength(1);
      expect(s.m.forges.other?.writes.filter((w) => w.method === "POST")).toHaveLength(1);
      const done = dto(s);
      expect(done.prs.map((r) => [r.repo, r.state])).toEqual([
        ["lib", "pr_open"],
        ["other", "pr_open"],
        ["app", "pr_open"],
      ]);
      for (const [repo, others] of [
        ["lib", ["other", "app"]],
        ["other", ["lib", "app"]],
        ["app", ["lib", "other"]],
      ] as const) {
        const d = s.m.forges[repo]?.prs.get(101)?.description ?? "";
        expect([...d.matchAll(/^- \[PROJ\/(\w+) #101\]/gm)].map((x) => x[1])).toEqual([...others]);
      }
    },
    SLOW,
  );

  test(
    "AC-B43: a moved submodule base gives its count and the sentence; a deleted base blocks before any push",
    async () => {
      const s = await multiTask({ forge: true });
      const { op } = opener(s);
      await remoteCommit(s.m.lib, "main", { "lib.h": "int more;\n" });
      await remoteCommit(s.m.lib, "main", { "lib.h": "int more2;\n" });
      expect((await s.loop.checkBases(s.db, s.task)).status).toBe(200);
      const t = dto(s);
      const lib = t.repos.find((r) => r.repo === "lib");
      expect(t.bases.map((b) => [b.taskRepo === lib?.id ? "lib" : "app", b.branch, b.newCommits])).toEqual([
        ["lib", "main", 2],
        ["app", "main", 0],
      ]);
      const v = taskView(t, { runner: "Claude", forge: "Bitbucket", now: Date.now() });
      expect(v.status).toBe("main has 2 new commits since the branch point.");
      expect(v.primary?.label).toBe("Update from main");
      expect(v.more.map((a) => a.label)).toContain("Open the PR as is");

      await git(["--git-dir", s.m.lib.remote, "update-ref", "-d", "refs/heads/main"], { env: s.m.lib.env });
      const r = await op.openRows(s.db, s.task, s.part().id, { version: t.version, rows: allRows(t) });
      expect([r.status, "error" in r ? r.error : ""]).toEqual([409, baseGoneText("main", "PROJ/lib")]);
      expect(baseGoneText("main", "PROJ/lib")).toBe("Needs you: main no longer exists in PROJ/lib. Pick another base branch.");
      expect(s.steps().filter((x) => x.kind === "push")).toEqual([]);
      expect(creates(s)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a row outside the changed repositories, a twice-listed row, and an old version give 400 or 409",
    async () => {
      const s = await multiTask({ forge: true });
      const { op } = opener(s);
      const t = dto(s);
      const vendor = t.repos.find((r) => r.path === "vendor")?.id as number;
      const bad = await op.openRows(s.db, s.task, s.part().id, { version: t.version, rows: [{ taskRepo: vendor, reviewers: [] }] });
      expect([bad.status, "error" in bad && bad.error]).toEqual([400, `Repository ${vendor} has no change in this part.`]);
      const main = rowOf(t, "app").taskRepo;
      const twice = await op.openRows(s.db, s.task, s.part().id, {
        version: t.version,
        rows: [
          { taskRepo: main, reviewers: [] },
          { taskRepo: main, reviewers: [] },
        ],
      });
      expect(twice.status).toBe(400);
      expect((await op.openRows(s.db, s.task, s.part().id, { version: t.version + 9, rows: allRows(t) })).status).toBe(409);
    },
    SLOW,
  );
});

describe("withRelated (spec.md section 6.16.8, Links)", () => {
  test("appends the links, replaces an earlier link section, and keeps a PR without a link as text", () => {
    const one = withRelated("Goal.\r\n\r\nThe plan: specs/plan.md", [{ name: "PROJ/lib", id: 41, url: "https://h/pr/41" }]);
    expect(one).toBe("Goal.\n\nThe plan: specs/plan.md\n\nRelated PRs:\n- [PROJ/lib #41](https://h/pr/41)");
    expect(
      withRelated(one, [
        { name: "PROJ/lib", id: 41 },
        { name: "PROJ/x", id: 2 },
      ]),
    ).toBe("Goal.\n\nThe plan: specs/plan.md\n\nRelated PRs:\n- PROJ/lib #41\n- PROJ/x #2");
    expect(withRelated(one, [])).toBe("Goal.\n\nThe plan: specs/plan.md");
  });
});
