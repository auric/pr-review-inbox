// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.18.1 and 6.18.2 (WP-TU1, AC-B53 to AC-B57): "Tell Claude" on a built small task part. The
// fake CLI writes real files in the part worktree, a bun script is the test command, and a temp bare remote holds the repository.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { taskDto } from "../../src/server/tasks/tasks";
import { status } from "../../src/server/tasks/worktree";
import type { TaskDto } from "../../src/shared/dto";
import { readRecords } from "../support/fake-claude";
import { builtTask, cleanup, implement, KEY, remoteCommit, SLOW, until } from "./update-fixture";

for (const m of ["tasks/loop", "tasks/implement", "tasks/tasks", "tasks/update", "review/jobs", "review/claude"])
  console.log(`instruct.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanup);

const MORE = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const useNewParser = true;\n" };
const RED = { kind: "red" as const, step: null, text: "Needs you: the tests of part 1 stay red after 3 tries." };

describe("Tell Claude (spec.md section 6.18.2)", () => {
  test(
    "AC-B53, AC-B57: a send without a changed file is one instruct step and one CLI call; no check runs, and the reason comes back",
    async () => {
      const s = await builtTask({ seq: { "implement:instruct": [{ implement: implement({ summary: "The flag reads the config." }) }] } });
      s.db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ b: JSON.stringify(RED), id: s.task });
      const text = "Why does the flag read the config?\nAnswer briefly.";
      const r = s.loop.instruct(s.db, s.task, { version: s.t().version, text });
      expect(r.status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.runCalls()).toHaveLength(1);
      const call = s.runCalls()[0] as NonNullable<ReturnType<typeof s.runCalls>[number]>;
      expect(s.modeOf(call)).toBe("instruct");
      // The text is the only content of "Your instructions" and the last text of the stdin. The rules come first.
      expect(call.stdin.endsWith(`# Your instructions\n\n${text}`)).toBe(true);
      expect(call.stdin.indexOf("Never edit .claude folders")).toBeLessThan(call.stdin.indexOf("# Your instructions"));
      expect(call.stdin).toContain("Do not try to merge, rebase, or fetch. You cannot run git.");
      expect(call.argv[call.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write");
      expect(call.context["step.md"]).toContain("- Mode: instruct");
      expect(s.flow()).toEqual(["instruct:I1:ok"]);
      const row = s.steps()[0];
      expect(row?.detail.instruct).toMatchObject({ text, result: "no_change", blockedBefore: RED });
      expect(row?.detail.summary).toBe("The flag reads the config.");
      expect(s.blocked()).toEqual(RED);
    },
    SLOW,
  );

  test(
    "AC-B53: a changed file gets the checks, one commit with the first line of the text, and the own review; the part keeps its state",
    async () => {
      const s = await builtTask({ seq: { "implement:instruct": [{ writes: [MORE] }] } });
      const head = s.part().head;
      const r = s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag useNewParser.\nKeep the rest." });
      expect(r.status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.flow()).toEqual(["instruct:I1:ok", "check:I1:ok", "commit:I1:ok", "review:review:ok"]);
      expect(s.runCalls().map(s.modeOf)).toEqual(["instruct", "review"]);
      expect((await s.log())[0]).toStartWith(`${KEY}: Add the flag useNewParser.|${head}`);
      expect(s.part().head).not.toBe(head);
      expect(s.part().state).toBe("self_reviewed");
      expect(s.blocked()).toBeNull();
      expect(s.steps()[0]?.detail.instruct).toMatchObject({ result: "done", committed: true });
      expect(await status(await s.wt())).toEqual([]);
    },
    SLOW,
  );

  test(
    "AC-B54: a text that names push and rebase starts one instruct step and no git push, fetch, rebase, or merge; a second send gets 409",
    async () => {
      const s = await builtTask({ seq: { "implement:instruct": [{ delayMs: 400, writes: [MORE] }] } });
      const spawn = Bun.spawn;
      const gitCalls: string[][] = [];
      (Bun as { spawn: unknown }).spawn = ((cmd: unknown, o: unknown) => {
        if (Array.isArray(cmd) && cmd[0] === "git") gitCalls.push(cmd.map(String));
        return (spawn as (a: unknown, b: unknown) => unknown)(cmd, o);
      }) as unknown;
      try {
        const r = s.loop.instruct(s.db, s.task, { version: s.t().version, text: "push the branch and rebase onto develop" });
        expect(r.status).toBe(202);
        const second = s.loop.instruct(s.db, s.task, { version: s.t().version, text: "again" });
        expect([second.status, (second as { error: string }).error]).toEqual([409, "Claude or the checks are working."]);
        await s.loop.idle(s.task);
      } finally {
        (Bun as { spawn: unknown }).spawn = spawn;
      }
      expect(s.steps().filter((x) => x.kind === "instruct")).toHaveLength(1);
      expect(s.runCalls().filter((c) => s.modeOf(c) === "instruct")).toHaveLength(1);
      const forbidden = gitCalls.filter((a) => a.some((x) => ["push", "fetch", "rebase", "merge"].includes(x)));
      expect(forbidden).toEqual([]);
      expect(gitCalls.length).toBeGreaterThan(0);
    },
    SLOW,
  );

  test(
    "AC-B56: Stop kills the process tree, resets the worktree to the last commit with the patch saved, and restores the earlier reason",
    async () => {
      const s = await builtTask({ seq: { "implement:instruct": [{ hang: true, writes: [MORE] }] } });
      s.db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ b: JSON.stringify(RED), id: s.task });
      const head = s.part().head;
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag." }).status).toBe(202);
      const record = join(s.root, "calls.jsonl");
      await until(() => readRecords<{ childPid?: number }>(record).some((x) => x.childPid));
      const child = readRecords<{ childPid?: number }>(record).find((x) => x.childPid)?.childPid as number;
      const stopped = s.loop.stop(s.db, s.task, { version: s.t().version });
      expect(stopped.status).toBe(200);
      await s.loop.idle(s.task);
      const alive = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      const end = Date.now() + 10_000;
      while (alive() && Date.now() < end) await Bun.sleep(50);
      expect(alive()).toBe(false);
      // Not stopped: the task waits as before the send, and the text stays in the step for the box.
      expect([s.t().state, s.blocked()]).toEqual(["implementing", RED]);
      const row = s.steps()[0];
      expect(row?.state).toBe("cancelled");
      expect(row?.detail.instruct).toMatchObject({ text: "Add the flag.", result: "stopped", committed: false });
      expect(row?.detail.notes).toContain("Stopped. Your instructions changed nothing. The text is back in the box.");
      expect(s.part().head).toBe(head);
      const w = await s.wt();
      expect(await status(w)).toEqual([]);
      const patch = join(w.dir, "..", "patches", `${row?.id}.patch`);
      expect(existsSync(patch)).toBe(true);
      expect(readFileSync(patch, "utf8")).toContain("useNewParser");
    },
    SLOW,
  );

  // The windows between the send and the CLI start. git ls-files --ignored runs in startStep before the run takes the slot. The first
  // `auth status` is the check of the run in the slot (jobs.ts implementSteps), the second one the check of runner.run before the spawn.
  const WINDOWS = [
    { name: "before the run takes the slot", argv: ["ls-files", "--ignored"], nth: 1, runs: [], notes: ["Stopped before Claude started."] },
    { name: "after the run takes the slot", argv: ["auth", "status"], nth: 1, runs: [{ status: "cancelled" }], notes: [] },
    { name: "in the runner before the spawn", argv: ["auth", "status"], nth: 2, runs: [{ status: "cancelled" }], notes: [] },
  ];
  for (const w of WINDOWS)
    test(
      `AC-B56: a Stop ${w.name} starts no CLI, restores the earlier reason, and the next send runs`,
      async () => {
        const s = await builtTask({ seq: { "implement:instruct": [{ writes: [MORE] }] } });
        s.db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ b: JSON.stringify(RED), id: s.task });
        const head = s.part().head;
        const spawn = Bun.spawn;
        let seen = 0;
        let stopped: number | null = null;
        (Bun as { spawn: unknown }).spawn = ((cmd: unknown, o: unknown) => {
          if (stopped === null && Array.isArray(cmd) && w.argv.every((a) => cmd.includes(a)) && ++seen === w.nth)
            stopped = s.loop.stop(s.db, s.task, { version: s.t().version }).status;
          return (spawn as (a: unknown, b: unknown) => unknown)(cmd, o);
        }) as unknown;
        try {
          expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag." }).status).toBe(202);
          await s.loop.idle(s.task);
        } finally {
          (Bun as { spawn: unknown }).spawn = spawn;
        }
        expect(stopped as number | null).toBe(200);
        expect(s.runCalls()).toEqual([]);
        expect(s.db.query("SELECT status FROM review_run WHERE task = $t").all({ t: s.task })).toEqual(w.runs);
        expect([s.t().state, s.blocked(), s.loop.running(s.task)]).toEqual(["implementing", RED, false]);
        const row = s.steps()[0];
        expect(row?.state).toBe("cancelled");
        expect(row?.detail.instruct).toMatchObject({ text: "Add the flag.", result: "stopped", committed: false });
        expect(row?.detail.notes).toEqual([...w.notes, "Stopped. Your instructions changed nothing. The text is back in the box."]);
        expect(s.part().head).toBe(head);
        expect(taskDto(s.db, s.t()).canInstruct).toBe(true);
        expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag." }).status).toBe(202);
        await s.loop.idle(s.task);
        expect(s.flow()).toEqual(["instruct:I1:cancelled", "instruct:I2:ok", "check:I2:ok", "commit:I2:ok", "review:review:ok"]);
        expect(s.runCalls().map(s.modeOf)).toEqual(["instruct", "review"]);
        expect(s.steps()[1]?.detail.instruct).toMatchObject({ result: "done", committed: true });
      },
      SLOW,
    );

  test(
    "AC-B53: a denied path resets the step and blocks with denied_path",
    async () => {
      const s = await builtTask({ seq: { "implement:instruct": [{ writes: [{ path: "repo/.claude/settings.json", text: "{}" }] }] } });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Change the settings." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.blocked()?.kind).toBe("denied_path");
      expect(s.flow()).toEqual(["instruct:I1:failed"]);
      expect(await status(await s.wt())).toEqual([]);
    },
    SLOW,
  );

  test(
    "AC-B55: needsBase with a moved base names the new commits; with a base that did not move the count is 0",
    async () => {
      const ask = { implement: implement({ needsBase: true, needsBaseReason: "The parser of the base is needed." }) };
      const s = await builtTask({ seq: { "implement:instruct": [ask] } });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Use the new parser." }).status).toBe(202);
      await s.loop.idle(s.task);
      const dto = () => taskDto(s.db, s.t());
      expect(dto().needsBase).toEqual({ reason: "The parser of the base is needed." });
      expect(dto().bases).toEqual([{ taskRepo: expect.any(Number), branch: "main", newCommits: 0, conflicted: false, changed: false }]);
      await remoteCommit(s.r, "main", { "README.md": "new readme\n" });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Use the new parser." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(dto().needsBase).toEqual({ reason: "The parser of the base is needed." });
      expect(dto().bases[0]?.newCommits).toBe(1);
    },
    SLOW,
  );

  test(
    "spec.md section 6.18.5: a send runs the base check at its end; the last change notice comes after the driver leaves, also after a failed check",
    async () => {
      const s = await builtTask({ seq: { "implement:instruct": [{ implement: implement() }, { writes: [MORE] }] } });
      const seen: boolean[] = [];
      const broadcast = s.live.broadcast;
      s.live.broadcast = (event, data) => {
        if (event === "changed" && (data as { tasks?: number[] }).tasks?.includes(s.task)) seen.push(s.loop.running(s.task));
        broadcast(event, data);
      };
      // A send without a changed file ends at once. The check at the driver end still sees the new base commit.
      await remoteCommit(s.r, "main", { "README.md": "new readme\n" });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Explain the flag." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(taskDto(s.db, s.t()).bases[0]?.newCommits).toBe(1);
      expect(seen.at(-1)).toBe(false);
      // The remote is gone, so the check fails. The page still gets a notice after the driver leaves.
      renameSync(s.r.remote, `${s.r.remote}.gone`);
      seen.length = 0;
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.flow().slice(-4)).toEqual(["instruct:I2:ok", "check:I2:ok", "commit:I2:ok", "review:review:ok"]);
      expect(seen.at(-1)).toBe(false);
      expect(taskDto(s.db, s.t()).canInstruct).toBe(true);
    },
    SLOW,
  );

  test(
    "spec.md section 6.18.5: the check before the PR dialog ignores BASE_CHECK_AGE and sends one change notice",
    async () => {
      const s = await builtTask();
      const seen: number[] = [];
      const broadcast = s.live.broadcast;
      s.live.broadcast = (event, data) => {
        if (event === "changed" && (data as { tasks?: number[] }).tasks?.includes(s.task)) seen.push(s.task);
        broadcast(event, data);
      };
      const first = await s.loop.checkBases(s.db, s.task);
      expect(first.status === 200 && first.task.bases[0]?.newCommits).toBe(0);
      await remoteCommit(s.r, "main", { "README.md": "new readme\n" });
      // A GET within BASE_CHECK_AGE runs no check. The check before the dialog runs.
      s.loop.baseCheck(s.db, s.task);
      const r = await s.loop.checkBases(s.db, s.task);
      expect(r.status === 200 && r.task.bases[0]?.newCommits).toBe(1);
      expect(seen).toEqual([s.task, s.task]);
      expect((await s.loop.checkBases(s.db, s.task + 99)).status).toBe(404);
    },
    SLOW,
  );

  test(
    "a question of an instruct step blocks with question; the answer runs the send again with answers.md",
    async () => {
      const q = { text: "Which flag name?", why: "Two names fit.", options: [], recommended: null };
      const s = await builtTask({ seq: { "implement:instruct": [{ implement: implement({ question: q }) }, { implement: implement() }] } });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Rename the flag." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.blocked()).toMatchObject({ kind: "question", text: "Needs you: Claude asks: Which flag name?" });
      // The box waits: the question form takes the text.
      expect(taskDto(s.db, s.t()).canInstruct).toBe(false);
      const open = s.db.query("SELECT id FROM task_question WHERE task = $t AND answer_json IS NULL").get({ t: s.task }) as { id: number };
      const a = s.loop.answer(s.db, s.task, { version: s.t().version, answers: [{ question: open.id, text: "useNewParser" }] });
      expect(a.status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.flow()).toEqual(["instruct:I1:ok", "instruct:I1:ok"]);
      expect(s.steps().map((x) => x.attempt)).toEqual([1, 2]);
      expect(s.runCalls()[1]?.context["answers.md"]).toContain("useNewParser");
      expect(s.runCalls()[1]?.stdin.endsWith("# Your instructions\n\nRename the flag.")).toBe(true);
    },
    SLOW,
  );

  test(
    "routes: 400 for an empty or a long text, 409 with the state sentence in a state without the box, 202 with the task",
    async () => {
      const s = await builtTask();
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const call = async (body: unknown) => {
        const res = await app.request(`${ORIGIN}/api/tasks/${s.task}/instructions`, {
          method: "POST",
          headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as TaskDto & { error?: string } };
      };
      expect((await call({ version: s.t().version, text: "   " })).status).toBe(400);
      expect((await call({ version: s.t().version, text: "x".repeat(4001) })).status).toBe(400);
      s.db.query("UPDATE task SET state = 'interview' WHERE id = $id").run({ id: s.task });
      const wrong = await call({ version: s.t().version, text: "Do it." });
      expect([wrong.status, wrong.body.error]).toEqual([409, "Claude reads the task and asks its questions."]);
      s.db.query("UPDATE task SET state = 'ready', blocked_json = $b WHERE id = $id").run({
        id: s.task,
        b: JSON.stringify({ kind: "question", step: null, text: "Needs you: Claude asks: which name?" }),
      });
      const asked = await call({ version: s.t().version, text: "Do it." });
      expect([asked.status, asked.body.error]).toEqual([409, "Needs you: Claude asks: which name?"]);
      s.db.query("UPDATE task SET blocked_json = NULL WHERE id = $id").run({ id: s.task });
      const ok = await call({ version: s.t().version, text: "Do it." });
      expect([ok.status, ok.body.state, ok.body.canInstruct, ok.body.working]).toEqual([202, "ready", false, true]);
      // The loop of the app works on the send. A second send waits for it.
      const busy = await call({ version: s.t().version, text: "Again." });
      expect([busy.status, busy.body.error]).toEqual([409, "Claude or the checks are working."]);
    },
    SLOW,
  );
});
