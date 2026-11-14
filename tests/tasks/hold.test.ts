// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/ps4-plan.md WP-4 (AC-B348 to AC-B353): Hold, Skip, Start again, and the usage arm. Gap 17 comes first: the git
// writes of Skip and Start again on a cache that another part shares are changes of the app for the step of that part. A temp bare
// remote, a temp database, and the fake CLI only.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILE, profileOf } from "../../src/server/review/catalog";
import { git, worktreeNames } from "../../src/server/review/git";
import { checkGit, snapGit } from "../../src/server/tasks/gitstate";
import { insertStep, patchStep, startStep } from "../../src/server/tasks/implement";
import { backupPart, resetToStart } from "../../src/server/tasks/loop";
import type { TaskRepoRow } from "../../src/server/tasks/repos";
import { headOf, openWorktree, removeWorktree, type Worktree, wtGit } from "../../src/server/tasks/worktree";
import type { TaskBlocked } from "../../src/shared/task";
import { taskCache, taskRemote } from "./fixture";
import { CLEAN, cleanupAll, SLOW, type Step, setup, TEST_FILE, TICK, TODO, until, WORKS } from "./loop-fixture";

for (const m of ["tasks/loop", "tasks/gitstate", "review/git", "tasks/worktree"])
  console.log(`hold.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

const dirs: string[] = [];
const dbs: Database[] = [];
afterEach(async () => {
  await cleanupAll();
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const MAIN = { id: 1, role: "main", access: "edit", depth: 0, parent: null, base_commit: null, pinned: null } as unknown as TaskRepoRow;

describe("gap 17: Skip and Start again on a shared cache (ps4-plan.md section 1 item 17)", () => {
  test("the backup ref, the reset to the start, and the removal of the worktree entry of part 2 are app changes for the step of part 1", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-hold-")));
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
    const at = async (ref: string) => (await git([`--git-dir=${cache}`, "rev-parse", "--verify", "-q", ref], { env: a.env })).trim();
    // Part 2 has a commit and a file that no commit holds.
    writeFileSync(join(b.repo, "two.txt"), "two\n");
    await wtGit(b, ["add", "--", "two.txt"]);
    await wtGit(b, ["-c", "user.name=Ada", "-c", "user.email=ada@example.invalid", "commit", "-q", "-m", "Part two"]);
    writeFileSync(join(b.repo, "left.txt"), "left\n");
    const old = await headOf(b);
    expect(old).not.toBe(base);
    // A Claude step of part 1 runs: its snapshot and the cache watch start.
    const snap = await snapGit([a]);
    const tree = { row: MAIN, full: "", wt: b as Worktree };
    expect(await backupPart([tree], 1, 2)).toBe("refs/rl/task/1/backup/part-2-1");
    await resetToStart([tree], base);
    expect(await backupPart([tree], 1, 2)).toBe("refs/rl/task/1/backup/part-2-2");
    await removeWorktree(b);
    // The step of part 1 ends: nothing that the app did is a change of Claude, and the entry of part 2 that went is no lost entry.
    expect(await checkGit(snap)).toEqual([]);
    expect([await at("refs/rl/task/1/backup/part-2-1"), await at("refs/rl/task/1/backup/part-2-2")]).toEqual([old, base]);
    expect(await at("refs/heads/feature/K-1-part-2")).toBe(base);
    expect(worktreeNames(cache)).toHaveLength(1);
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);
});

type S = Awaited<ReturnType<typeof setup>>;
const partId = (s: S) => s.part().id;
const rowOf = (s: S) => {
  const r = s.db.query("SELECT blocked_json FROM task_part WHERE id = $id").get({ id: partId(s) }) as { blocked_json: string | null };
  return r.blocked_json === null ? null : (JSON.parse(r.blocked_json) as TaskBlocked);
};
const order = (s: S, from = 0) => s.phases.slice(from).map((p) => `${p.event}>${p.to}`);
const v = (s: S) => ({ version: s.t().version });
const running = (s: S, kind = "implement") => s.steps().find((x) => x.kind === kind && x.state === "running");
// The build run of the fake CLI wrote its files and hangs. A Hold before the process starts would leave the hang entry of seq unused.
async function hanging(s: S) {
  await until(() => !!running(s), 120_000);
  const file = join((await s.wt()).repo, "src", "feature.ts");
  await until(() => existsSync(file), 120_000);
}

describe("409 grid (ps4-plan.md section 4)", () => {
  test("each refusal of Hold, Skip, Start again, Continue with part, and disarm answers with its sentence, writes nothing, and starts no driver", async () => {
    const s = await setup();
    const part = (
      s.db
        .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($t, 1, 'single', 'Add the feature', 'feature/K-1-add-the-feature', 'main', 'implementing', 1, 1) RETURNING id`)
        .get({ t: s.task }) as { id: number }
    ).id;
    const set = (sql: string) => s.db.query(sql).run({ id: part, t: s.task });
    const row = (kind: "check" | "implement", state: "running") => insertStep(s.db, { task: s.task, part, kind, item: "build", state });
    const held: TaskBlocked = { kind: "held", step: null, part, text: "Part 1 is on hold. Its work is kept." };
    const hold = () => s.loop.hold(s.db, s.task, part, v(s));
    const skip = () => s.loop.skip(s.db, s.task, part, v(s));
    const restart = () => s.loop.restart(s.db, s.task, part, v(s));
    const check = async (name: string, f: () => unknown, status: number, error: string) => {
      const at = s.t().version;
      const r = (await f()) as { status: number; error?: string };
      expect([name, r.status, r.error]).toEqual([name, status, error]);
      expect([name, s.t().version, s.loop.running(s.task)]).toEqual([name, at, false]);
    };
    const when = "Hold works while Claude builds or fixes part 1.";
    // Hold: no open row, an open check row, an open row in ready, and a part row with another reason.
    await check("hold, no open row", hold, 409, when);
    const checkRow = row("check", "running");
    await check("hold, open check row", hold, 409, when);
    s.db.query("UPDATE task_step SET state = 'ok' WHERE id = $id").run({ id: checkRow });
    const build = row("implement", "running");
    set("UPDATE task SET state = 'ready' WHERE id = $t");
    await check("hold in ready", hold, 409, when);
    set("UPDATE task SET state = 'implementing' WHERE id = $t");
    s.db
      .query("UPDATE task_part SET blocked_json = $b WHERE id = $id")
      .run({ id: part, b: JSON.stringify({ kind: "red", step: 1, text: "x" }) });
    await check("hold, part row with a reason", hold, 409, when);
    s.db.query("UPDATE task_part SET blocked_json = NULL WHERE id = $id").run({ id: part });
    await check("hold, unknown part", () => s.loop.hold(s.db, s.task, part + 99, v(s)), 404, "Part not found.");
    // Skip and Start again refuse a working part: a part with an open row.
    await check("skip, no sub-tasks", skip, 409, "Only a part of a task with sub-tasks can be skipped.");
    set("UPDATE task SET subtasks = 1 WHERE id = $t");
    await check("skip, working part", skip, 409, "Hold part 1 first.");
    await check("restart, working part", restart, 409, "Hold part 1 first.");
    s.db.query("UPDATE task_step SET state = 'cancelled' WHERE id = $id").run({ id: build });
    set("UPDATE task_part SET state = 'pr_open' WHERE id = $id");
    await check("skip, part with a PR", skip, 409, "This part has a PR.");
    await check("restart, part in review", restart, 409, "This part is in review.");
    set("UPDATE task_part SET state = 'self_reviewed', pushed = 'abc' WHERE id = $id");
    await check("restart, pushed part", restart, 409, "Part 1 is on the server. It cannot start again.");
    set("UPDATE task_part SET pushed = NULL WHERE id = $id");
    const sub = (
      s.db
        .query(`INSERT INTO task_repo (task, role, project, repo, depth, access, base_branch, base_commit, created_at)
          VALUES ($t, 'added', 'PROJ', 'other', 0, 'edit', 'main', 'c', 1) RETURNING id`)
        .get({ t: s.task }) as { id: number }
    ).id;
    s.db
      .query(`INSERT INTO task_pr (part, task_repo, branch, base_branch, base_commit, head, pushed, state)
        VALUES ($id, $sub, 'b', 'main', 'c', 'h', 'h', 'pushed')`)
      .run({ id: part, sub });
    await check("restart, pushed sub repository", restart, 409, "Part 1 is on the server. It cannot start again.");
    set("UPDATE task SET state = 'ready' WHERE id = $t");
    await check("skip in ready", skip, 409, "All PRs of the task are open.");
    await check("restart in ready", restart, 409, "All PRs of the task are open.");
    set("UPDATE task SET state = 'implementing' WHERE id = $t");
    // Continue with part: a part that is not held, an unknown part, and a held part of a closed task.
    await check("continue, not held", () => s.loop.resume(s.db, s.task, { ...v(s), part }), 409, "Part 1 is not on hold.");
    await check("continue, unknown part", () => s.loop.resume(s.db, s.task, { ...v(s), part: part + 99 }), 404, "Part not found.");
    s.db.query("UPDATE task_part SET blocked_json = $b WHERE id = $id").run({ id: part, b: JSON.stringify(held) });
    await check("hold, held part", hold, 409, "Part 1 is on hold already.");
    // part-session.md section 9.4: a held part goes on by Continue with part only. A plain Continue and Tell Claude start nothing.
    set("UPDATE task_part SET state = 'implementing' WHERE id = $id");
    const go = "Part 1 is on hold. Continue it from its row.";
    await check("continue, only a held part", () => s.loop.resume(s.db, s.task, v(s)), 409, go);
    const tell = () => s.loop.instruct(s.db, s.task, { ...v(s), part, text: "Name the flag." });
    await check("tell, held part", tell, 409, "Part 1 is on hold. Continue it first.");
    set("UPDATE task_part SET state = 'self_reviewed' WHERE id = $id");
    set("UPDATE task SET state = 'done' WHERE id = $t");
    await check("continue, closed task", () => s.loop.resume(s.db, s.task, { ...v(s), part }), 409, "The task is done.");
    set("UPDATE task SET state = 'implementing' WHERE id = $t");
    // disarm: no reason, and a usage reason that is not armed.
    await check("disarm, no reason", () => s.loop.resume(s.db, s.task, { ...v(s), option: "disarm" }), 409, "No resume is armed.");
    s.db
      .query("UPDATE task SET blocked_json = $b WHERE id = $t")
      .run({ t: s.task, b: JSON.stringify({ kind: "usage", step: build, text: "x", resumeAt: Date.now() + 60_000, armed: false }) });
    await check("disarm, not armed", () => s.loop.resume(s.db, s.task, { ...v(s), option: "disarm" }), 409, "No resume is armed.");
  });
});

describe("Start again (AC-B351)", () => {
  test(
    "the patch and the backup ref keep the old work, the branch goes back to the part base, and the part builds again in a new session",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }], review: [{ review: CLEAN }] } });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const w = await s.wt();
      const old = await headOf(w);
      expect((await s.log()).length).toBe(2);
      writeFileSync(join(w.repo, "notes.txt"), "kept\n");
      const r = await s.loop.restart(s.db, s.task, partId(s), v(s));
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      const mark = s.steps().find((x) => x.kind === "commit" && x.item === "restart");
      const ref = `refs/rl/task/${s.task}/backup/part-1-1`;
      const notes = JSON.parse(mark?.detail_json ?? "{}").notes as string[];
      expect(notes[0]).toBe(`Started again from the part base. The old head is at ${ref}.`);
      expect(notes[1]).toMatch(/^The work that was not committed is in the patch \d+\.patch\.$/);
      const at = (await git([`--git-dir=${w.cache}`, "rev-parse", "--verify", "-q", ref], { env: w.env })).trim();
      expect(at).toBe(old);
      // runPart wrote the plan commit again, then the build commit: two commits on the part base, not four.
      expect((await s.log()).map((l) => l.split("|")[1])).toEqual(["K-1: Add the plan", "K-1: Add the feature"]);
      expect(await headOf(w)).not.toBe(old);
      expect(existsSync(join(w.repo, "notes.txt"))).toBe(false);
      // The baseline ran once. The build, the critic, and the own review ran again, the build in a new session with no continue.md.
      expect(s.steps().filter((x) => x.kind === "check" && x.item === "base").length).toBe(1);
      const ok = (item: string) => s.steps().filter((x) => x.kind === "review" && x.item === item && x.state === "ok").length;
      expect([ok("critic"), ok("review")]).toEqual([2, 2]);
      const builds = s.runCalls().filter((c) => s.modeOf(c) === "build");
      expect(builds.length).toBe(2);
      expect(builds[1]?.context["continue.md"]).toBeUndefined();
      expect([s.t().state, s.part().state, s.blocked()]).toEqual(["implementing", "self_reviewed", null]);
    },
    SLOW,
  );

  // part-session.md section 2.12: Start again clears the reason of its part. The route grid answers 200 in these states, so no reason
  // may stay that points at the old work.
  test(
    "Start again during question/claude, allow, and an armed usage reason of the part clears the reason and the open questions",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }], review: [{ review: CLEAN }] } });
      await s.build();
      const part = partId(s);
      const asks = () =>
        s.db.query("SELECT COUNT(*) AS n FROM task_question WHERE task = $t AND answer_json IS NULL").get({ t: s.task }) as { n: number };
      for (const kind of ["question", "allow", "usage"] as const) {
        const step = insertStep(s.db, { task: s.task, part, kind: "implement", item: "build", state: "ok" });
        const b: TaskBlocked =
          kind === "question"
            ? { kind, cause: "claude", step, text: "Needs you: Claude asks: Which flag name?" }
            : kind === "allow"
              ? { kind, step, text: "Needs you: Claude asks to allow a command." }
              : { kind, step, text: "Needs you: the usage limit.", resumeAt: Date.now() + 3_600_000, armed: true };
        if (kind === "question")
          s.db
            .query(`INSERT INTO task_question (task, source, round, ord, text, why, kind, options_json, step, asked_at)
              VALUES ($t, 'loop', 1, 0, 'Which flag name?', 'Callers use it.', 'text', '[]', $step, 1)`)
            .run({ t: s.task, step });
        if (kind === "allow")
          patchStep(s.db, step, {
            allowAsk: { requests: [{ pattern: "make build", command: "make build", reason: "The step runs make build." }], decisions: [] },
          });
        s.db.query("UPDATE task SET blocked_json = $b WHERE id = $t").run({ t: s.task, b: JSON.stringify(b) });
        const r = await s.loop.restart(s.db, s.task, part, v(s));
        expect([kind, r.status, s.blocked(), rowOf(s), asks().n]).toEqual([kind, 200, null, null, 0]);
        await s.loop.idle(s.task);
        expect([kind, s.part().state, s.blocked()]).toEqual([kind, "self_reviewed", null]);
      }
    },
    SLOW * 2,
  );
});

describe("Hold and Continue with part (AC-B348, AC-B349)", () => {
  test(
    "Hold cancels the run of its part, sends STOPPED, and keeps the work; a second Hold refuses; Continue with part builds on",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [
            { writes: [TEST_FILE, TODO], hang: true },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
          review: [{ review: CLEAN }],
        },
      });
      s.loop.build(s.db, s.task);
      await hanging(s);
      const held = s.loop.hold(s.db, s.task, partId(s), v(s));
      expect(held.status).toBe(200);
      await s.loop.idle(s.task);
      expect(order(s).slice(-2)).toEqual(["GO>building", "STOPPED>idle"]);
      // The part row holds held; the task holds no reason and does not stop.
      expect([s.t().state, s.blocked(), rowOf(s)?.kind, rowOf(s)?.text]).toEqual([
        "implementing",
        null,
        "held",
        "Part 1 is on hold. Its work is kept.",
      ]);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "implement")
          .map((x) => x.state),
      ).toEqual(["cancelled"]);
      expect(readFileSync(join((await s.wt()).repo, "src", "feature.ts"), "utf8")).toContain("todo");
      expect(s.loop.hold(s.db, s.task, partId(s), v(s))).toMatchObject({ status: 409, error: "Part 1 is on hold already." });
      // A Continue with no part leaves the held part alone. It would build nothing, so it answers 409 and starts no driver.
      expect(s.loop.resume(s.db, s.task, v(s))).toMatchObject({ status: 409, error: "Part 1 is on hold. Continue it from its row." });
      expect(s.loop.running(s.task)).toBe(false);
      expect([rowOf(s)?.kind, s.steps().filter((x) => x.kind === "implement").length]).toEqual(["held", 1]);
      // Continue with part ends the hold, and the part builds to its end.
      const at = s.phases.length;
      expect(s.loop.resume(s.db, s.task, { ...v(s), part: partId(s) }).status).toBe(200);
      expect(rowOf(s)).toBeNull();
      await s.loop.idle(s.task);
      expect(order(s, at)).toEqual([
        "GO>building",
        "RUN_DONE>checking",
        "CHECKS_GREEN>idle",
        "GO>critic",
        "CLEAN>idle",
        "GO>reviewing",
        "CLEAN>idle",
      ]);
      expect([s.t().state, s.part().state, s.blocked()]).toEqual(["implementing", "self_reviewed", null]);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "implement")
          .map((x) => x.state),
      ).toEqual(["cancelled", "ok"]);
    },
    SLOW,
  );

  test(
    "a Hold of a step that waits for the run slot ends the wait: the waiting row ends cancelled, and the slot reason goes",
    async () => {
      const s = await setup({
        seq: { "implement:build": [{ hang: true }, { writes: [TEST_FILE, WORKS], ticks: TICK }], review: [{ review: CLEAN }] },
        runLimits: { runsAtOnce: 1 },
      });
      // Task K-2 holds the run slot with a step that runs until its cancel.
      const other = s.addTask("K-2", "Other");
      const p2 = (
        s.db
          .query(`INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
            VALUES ($task, 1, 'single', 'Other', 'feature/K-2-other', 'main', 'implementing', 1, 1) RETURNING id`)
          .get({ task: other }) as { id: number }
      ).id;
      const w2 = await openWorktree({
        dataDir: s.dataDir,
        db: s.db,
        project: "PROJ",
        repo: "repo",
        task: other,
        ord: 1,
        branch: "feature/K-2-other",
        base: s.base,
      });
      const slot = await startStep({
        db: s.db,
        review: s.jobs,
        task: other,
        part: { id: p2, ord: 1 },
        wt: w2,
        mode: "implement",
        item: "T1.1",
        attempt: 1,
        profile: profileOf(s.settings.profiles(), DEFAULT_PROFILE),
        untrusted: [],
        own: [{ name: "step.md", text: "# Step\n" }],
        allow: [],
        specDir: "specs/K-2/",
      });
      expect(slot.status).toBe(202);
      s.loop.build(s.db, s.task);
      await until(() => s.blocked()?.kind === "slot", 120_000);
      const waiting = s.steps().find((x) => x.state === "waiting") as Step;
      expect(s.loop.hold(s.db, s.task, partId(s), v(s)).status).toBe(200);
      await s.loop.idle(s.task);
      const row = s.steps().find((x) => x.id === waiting.id) as Step;
      expect([row.state, JSON.parse(row.detail_json).notes]).toEqual([
        "cancelled",
        ["The build stopped while the step waited for the run slot."],
      ]);
      expect([s.t().state, s.blocked(), rowOf(s)?.kind, order(s).slice(-2)]).toEqual([
        "implementing",
        null,
        "held",
        ["GO>building", "STOPPED>idle"],
      ]);
      s.jobs.cancelTask(s.db, other);
      expect(s.loop.resume(s.db, s.task, { ...v(s), part: partId(s) }).status).toBe(200);
      await s.loop.idle(s.task);
      expect([s.t().state, s.part().state]).toEqual(["implementing", "self_reviewed"]);
    },
    SLOW,
  );

  test(
    "Stop keeps the held row; Continue with part in stopped also resumes the task (ps4-plan.md section 8 item 5)",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [
            { writes: [TEST_FILE, TODO], hang: true },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
          review: [{ review: CLEAN }],
        },
      });
      s.loop.build(s.db, s.task);
      await hanging(s);
      expect(s.loop.hold(s.db, s.task, partId(s), v(s)).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.loop.stop(s.db, s.task, v(s)).status).toBe(200);
      expect([s.t().state, rowOf(s)?.kind]).toEqual(["stopped", "held"]);
      // Continue with no part in stopped resumes the task, and the held part stays held.
      expect(s.loop.resume(s.db, s.task, v(s)).status).toBe(200);
      await s.loop.idle(s.task);
      expect([s.t().state, rowOf(s)?.kind]).toEqual(["implementing", "held"]);
      expect(s.loop.stop(s.db, s.task, v(s)).status).toBe(200);
      expect(s.loop.resume(s.db, s.task, { ...v(s), part: partId(s) }).status).toBe(200);
      expect([s.t().state, rowOf(s)]).toEqual(["implementing", null]);
      await s.loop.idle(s.task);
      expect([s.t().state, s.part().state]).toEqual(["implementing", "self_reviewed"]);
    },
    SLOW,
  );
});
