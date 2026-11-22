// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.7 "Checks" and design.md section 10 Q2 (WP-B3, AC-B19 checks part, AC-B22 env part): the app
// runs only the approved argv lists after the warning, only in the task worktree, with no shell, a scrubbed env, a timeout with a
// process-tree kill, Stop, and a capped output tail. The commands are bun scripts in temp folders.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { CHECK_KINDS, checkEnv, checkStep, envFault, hostProgram, runChecks, runCommand } from "../../src/server/tasks/checks";
import { type BaseRun, baseRuns, checkFailure, onBase, quoteFound } from "../../src/server/tasks/loop";
import { saveRepoSettings } from "../../src/server/tasks/tasks";
import { openWorktree, taskDir, type Worktree } from "../../src/server/tasks/worktree";
import { stepDetail, TASK_CACHE_ENV, type TaskCommand } from "../../src/shared/task";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["checks", "loop"])
  console.log(`checks.test.ts imported from ${Bun.resolveSync(`../../src/server/tasks/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 60_000;
const BUN = process.execPath;
const dirs: string[] = [];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) return false;
    await Bun.sleep(50);
  }
  return true;
};

// A command that writes its pid and the pid of a child to file, then waits forever.
const treeScript = (file: string) =>
  `const c = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });` +
  `require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify([process.pid, c.pid])); setInterval(() => {}, 1000);`;

async function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-wpb3-chk-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: "http://127.0.0.1:9", userSlug: "u", notifications: false, taskPlanCheck: false });
  const settings = createSettings({ dir: dataDir, secrets: createSecrets(null), jiraSecrets: createSecrets(null, "jira-token") });
  const db = settings.db() as Database;
  cleanup.push(() => db.close());
  const { base } = await taskCache(dataDir, r.remote);
  const wt = await openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task: 1, ord: 1, branch: "feature/K-1-x", base });
  const save = (commands: TaskCommand[], o: { warned?: boolean; isolate?: boolean; cache?: boolean } = {}) => {
    saveRepoSettings(db, "PROJ", "repo", {
      specDir: "specs/{key}/",
      lineBudget: 400,
      maxOpen: 2,
      approvals: 1,
      commands,
      testGlobs: null,
      excludeGlobs: null,
      isolateHome: o.isolate ?? true,
      taskCache: o.cache ?? false,
    });
    db.query("UPDATE repo_task_settings SET warned_at = $w").run({ w: o.warned === false ? null : 1 });
  };
  const run = (o: { kinds?: typeof CHECK_KINDS; signal?: AbortSignal; wt?: Worktree } = {}) =>
    runChecks({ db, dataDir, project: "PROJ", repo: "repo", wt: o.wt ?? wt, kinds: o.kinds ?? CHECK_KINDS, signal: o.signal });
  // A task row and its part row for checkStep.
  const taskPart = () => {
    const now = Date.now();
    const task = (
      db
        .query(
          `INSERT INTO task (project, repo, key, title, state, target_branch, spec_dir, created_at, updated_at)
          VALUES ('PROJ', 'repo', 'K-1', 'Thing', 'implementing', 'main', 'specs/K-1/', $now, $now) RETURNING id`,
        )
        .get({ now }) as { id: number }
    ).id;
    const part = (
      db
        .query(
          `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($task, 1, 'single', 'Thing', 'feature/K-1-x', 'main', 'implementing', $now, $now) RETURNING id`,
        )
        .get({ task, now }) as { id: number }
    ).id;
    return { task, part };
  };
  const detail = (step: number) =>
    stepDetail.parse(
      JSON.parse((db.query("SELECT detail_json FROM task_step WHERE id = $id").get({ id: step }) as { detail_json: string }).detail_json),
    );
  return { root, dataDir, db, wt, save, run, taskPart, detail };
}

const cmd = (id: string, kind: TaskCommand["kind"], code: string, extra: string[] = [], timeoutSec = 60): TaskCommand => ({
  id,
  name: id,
  kind,
  argv: [BUN, "-e", code, ...extra],
  timeoutSec,
});

describe("app-run checks", () => {
  test(
    "run only after the warning, only the stored commands of the kinds, in kind order, in the task worktree",
    async () => {
      const s = await setup();
      const marker = join(s.root, "ran.txt");
      const mark = (id: string) =>
        `require("fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${id}:`)} + process.cwd() + "\\n")`;
      const list = [
        cmd("setup", "setup", mark("setup")),
        cmd("lint", "lint", mark("lint")),
        cmd("test", "test", `${mark("test")}; process.exit(3)`),
      ];
      s.save(list, { warned: false });
      const refused = await s.run();
      expect(refused).toEqual({ status: "refused", reason: "Accept the warning about app-run commands first." });
      expect(existsSync(marker)).toBe(false);
      s.save(list);
      const r = await s.run();
      if (r.status !== "ran") throw new Error(r.reason);
      expect(r.green).toBe(false);
      expect(r.commands.map((c) => [c.name, c.exit])).toEqual([
        ["test", 3],
        ["lint", 0],
      ]);
      const lines = readFileSync(marker, "utf8").trim().split("\n");
      expect(lines.map((l) => l.split(":")[0])).toEqual(["test", "lint"]);
      for (const l of lines) expect(realpathSync.native(l.slice(l.indexOf(":") + 1))).toBe(realpathSync.native(s.wt.repo));
      const setupRun = await s.run({ kinds: ["setup"] });
      expect(setupRun.status === "ran" && setupRun.green).toBe(true);
      // A folder outside the task folders is refused before a spawn.
      const elsewhere = { ...s.wt, dir: s.root, repo: join(s.root, "remote.git") };
      expect(await s.run({ wt: elsewhere })).toEqual({ status: "refused", reason: "The app runs commands only in a task folder." });
    },
    SLOW,
  );

  test(
    "argv goes to the program as is, with no shell",
    async () => {
      const s = await setup();
      const args = ["a b", "&&", "echo", "pwned", "$(whoami)", "%PATH%", "`id`", "|", ">out.txt", "'q'", '"dq"'];
      s.save([cmd("echo", "test", "console.log(JSON.stringify(process.argv.slice(-11)))", args)]);
      const r = await s.run();
      if (r.status !== "ran") throw new Error(r.reason);
      expect(JSON.parse(r.commands[0]?.tail.trim() ?? "")).toEqual(args);
      expect(existsSync(join(s.wt.repo, "out.txt"))).toBe(false);
      if (process.platform === "win32") {
        writeFileSync(join(s.wt.repo, "run.cmd"), "@echo off\r\necho ran\r\n");
        s.save([{ id: "cmd", name: "cmd", kind: "test", argv: ["./run.cmd"], timeoutSec: 30 }]);
        const w = await s.run();
        if (w.status !== "ran") throw new Error(w.reason);
        expect(w.commands[0]?.exit).toBeNull();
        expect(w.commands[0]?.tail).toContain("runs through cmd.exe");
      }
    },
    SLOW,
  );

  test(
    "the env has no API key, no nested-session marker, no git variable, CI=1, and a temp HOME when isolate_home is on",
    async () => {
      const s = await setup();
      const saved = { ...process.env };
      cleanup.push(() => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
      });
      Object.assign(process.env, {
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_AUTH_TOKEN: "auth-test",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        GIT_DIR: join(s.root, "remote.git"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: "Authorization: Bearer secret-token-77",
        SSH_ASKPASS: "askpass",
        NODE_OPTIONS: "--require evil.js",
      });
      const dump = `console.log(JSON.stringify({ env: process.env, home: require("fs").existsSync(process.env.HOME) }))`;
      s.save([cmd("env", "test", dump)]);
      const r = await s.run();
      if (r.status !== "ran") throw new Error(r.reason);
      const out = JSON.parse(r.commands[0]?.tail ?? "") as { env: Record<string, string>; home: boolean };
      const keys = Object.keys(out.env).map((k) => k.toUpperCase());
      for (const k of [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDECODE",
        "GIT_DIR",
        "GIT_CONFIG_COUNT",
        "SSH_ASKPASS",
        "NODE_OPTIONS",
      ])
        expect(keys).not.toContain(k);
      expect(keys.some((k) => k.startsWith("CLAUDE_CODE_"))).toBe(false);
      expect(JSON.stringify(out.env)).not.toContain("secret-token-77");
      expect(out.env.CI).toBe("1");
      expect(out.home).toBe(true);
      expect(out.env.HOME).not.toBe(homedir());
      expect(out.env.HOME?.startsWith(realpathSync.native(tmpdir())) || out.env.HOME?.startsWith(tmpdir())).toBe(true);
      if (process.platform === "win32") expect(out.env.USERPROFILE).toBe(out.env.HOME);
      // The temp HOME goes after the checks.
      expect(existsSync(out.env.HOME as string)).toBe(false);
      s.save([cmd("env", "test", dump)], { isolate: false });
      const plain = await s.run();
      if (plain.status !== "ran") throw new Error(plain.reason);
      const env2 = (JSON.parse(plain.commands[0]?.tail ?? "") as { env: Record<string, string> }).env;
      expect(env2.HOME).toBe(checkEnv(null).HOME);
    },
    SLOW,
  );

  test(
    "a command past its timeout is killed with its process tree",
    async () => {
      const s = await setup();
      const pids = join(s.root, "pids.json");
      s.save([cmd("hang", "test", treeScript(pids), [], 2), cmd("after", "lint", "console.log('after')")]);
      const t0 = Date.now();
      const r = await s.run();
      if (r.status !== "ran") throw new Error(r.reason);
      expect(Date.now() - t0).toBeLessThan(30_000);
      const [hang, after] = r.commands;
      expect(hang?.exit).toBeNull();
      expect(hang?.timedOut).toBe(true);
      expect(hang?.tail).toContain("after 2 s");
      expect(after?.exit).toBe(0);
      expect(r.green).toBe(false);
      const [parent, child] = JSON.parse(readFileSync(pids, "utf8")) as number[];
      expect(await until(() => !alive(parent as number) && !alive(child as number))).toBe(true);
    },
    SLOW,
  );

  test(
    "Stop during a check kills the process tree and runs no later command",
    async () => {
      const s = await setup();
      const pids = join(s.root, "pids.json");
      const marker = join(s.root, "later.txt");
      s.save([cmd("hang", "test", treeScript(pids)), cmd("later", "lint", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`)]);
      const stop = new AbortController();
      const running = s.run({ signal: stop.signal });
      expect(await until(() => existsSync(pids))).toBe(true);
      stop.abort();
      const r = await running;
      if (r.status !== "ran") throw new Error(r.reason);
      expect(r.commands.length).toBe(1);
      expect(r.commands[0]?.stopped).toBe(true);
      expect(r.commands[0]?.exit).toBeNull();
      expect(existsSync(marker)).toBe(false);
      const [parent, child] = JSON.parse(readFileSync(pids, "utf8")) as number[];
      expect(await until(() => !alive(parent as number) && !alive(child as number))).toBe(true);
    },
    SLOW,
  );

  test(
    "the check step row keeps each command with argv, exit code, time, and tail",
    async () => {
      const s = await setup();
      const now = Date.now();
      const task = (
        s.db
          .query(
            `INSERT INTO task (project, repo, key, title, state, target_branch, spec_dir, created_at, updated_at)
            VALUES ('PROJ', 'repo', 'K-1', 'Thing', 'implementing', 'main', 'specs/K-1/', $now, $now) RETURNING id`,
          )
          .get({ now }) as { id: number }
      ).id;
      const part = (
        s.db
          .query(
            `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
            VALUES ($task, 1, 'single', 'Thing', 'feature/K-1-x', 'main', 'implementing', $now, $now) RETURNING id`,
          )
          .get({ task, now }) as { id: number }
      ).id;
      s.save([cmd("ok", "build", "console.log('built')"), cmd("bad", "test", "console.error('1 failed'); process.exit(1)")]);
      const r = await checkStep({
        db: s.db,
        dataDir: s.dataDir,
        project: "PROJ",
        repo: "repo",
        wt: s.wt,
        kinds: CHECK_KINDS,
        task,
        part,
        item: "T1.1",
      });
      expect(r.status === "ran" && r.green).toBe(false);
      const row = s.db.query("SELECT kind, state, part, item, detail_json FROM task_step WHERE id = $id").get({ id: r.step }) as Record<
        string,
        string
      >;
      expect([row.kind, row.state, row.part, row.item]).toEqual(["check", "failed", part as unknown as string, "T1.1"]);
      const commands = (
        JSON.parse(row.detail_json as string) as { commands: { name: string; argv: string[]; exit: number; ms: number; tail: string }[] }
      ).commands;
      expect(commands.map((c) => [c.name, c.exit, c.argv[0]])).toEqual([
        ["ok", 0, BUN],
        ["bad", 1, BUN],
      ]);
      expect(commands[0]?.tail.trim()).toBe("built");
      expect(commands[1]?.tail.trim()).toBe("1 failed");
      expect(commands.every((c) => typeof c.ms === "number")).toBe(true);
      s.db.query("UPDATE repo_task_settings SET warned_at = NULL").run();
      const refused = await checkStep({
        db: s.db,
        dataDir: s.dataDir,
        project: "PROJ",
        repo: "repo",
        wt: s.wt,
        kinds: CHECK_KINDS,
        task,
        part,
      });
      expect(refused.status).toBe("refused");
      expect((s.db.query("SELECT state FROM task_step WHERE id = $id").get({ id: refused.step }) as { state: string }).state).toBe(
        "failed",
      );
    },
    SLOW,
  );

  test(
    "spec.md section 6.7, Log: the output so far reaches the step row while the command runs",
    async () => {
      const s = await setup();
      const { task, part } = s.taskPart();
      const go = join(s.root, "go.txt");
      // Prints one line, then waits for the test (20 s at most) before the second line.
      const wait = `console.log("first line"); const end = Date.now() + 20000; while (!require("fs").existsSync(${JSON.stringify(go)}) && Date.now() < end) await Bun.sleep(50); console.log("second line");`;
      s.save([cmd("ok", "setup", "console.log('done')"), cmd("slow", "setup", wait)]);
      let changes = 0;
      const running = checkStep({
        db: s.db,
        dataDir: s.dataDir,
        project: "PROJ",
        repo: "repo",
        wt: s.wt,
        kinds: ["setup"],
        task,
        part,
        item: "setup",
        onChange: () => changes++,
      });
      const step = (s.db.query("SELECT MAX(id) AS id FROM task_step").get() as { id: number }).id;
      const live = () => s.detail(step).commands.find((c) => c.name === "slow");
      expect(await until(() => live()?.tail.includes("first line") === true)).toBe(true);
      // The command still runs: it waits for go.txt.
      expect(existsSync(go)).toBe(false);
      expect(live()).toMatchObject({ running: true, exit: null, timedOut: false, timeoutSec: 60 });
      expect(s.detail(step).commands[0]).toMatchObject({ name: "ok", running: false, exit: 0 });
      expect(changes).toBeGreaterThan(0);
      writeFileSync(go, "x");
      const r = await running;
      expect(r.status === "ran" && r.green).toBe(true);
      const end = s.detail(step).commands;
      expect(end.map((c) => [c.name, c.running, c.exit])).toEqual([
        ["ok", false, 0],
        ["slow", false, 0],
      ]);
      expect(end[1]?.tail).toContain("second line");
    },
    SLOW,
  );

  test(
    "spec.md section 6.7: a command that reaches its time limit keeps timedOut and the limit in the step row",
    async () => {
      const s = await setup();
      const { task, part } = s.taskPart();
      s.save([cmd("deps", "setup", "setInterval(() => {}, 1000)", [], 1)]);
      const r = await checkStep({ db: s.db, dataDir: s.dataDir, project: "PROJ", repo: "repo", wt: s.wt, kinds: ["setup"], task, part });
      expect(r.status === "ran" && r.green).toBe(false);
      const [c] = s.detail(r.step).commands;
      expect(c).toMatchObject({ name: "deps", exit: null, running: false, timedOut: true, timeoutSec: 1 });
      expect(c?.tail).toContain("[The command reached its time limit of 0.02 min. The app stopped it after 1 s.]");
      expect((s.db.query("SELECT state FROM task_step WHERE id = $id").get({ id: r.step }) as { state: string }).state).toBe("failed");
    },
    SLOW,
  );

  test(
    "spec.md section 6.3: with task_cache on, each command gets REVIEW_LOOP_TASK_CACHE, one folder per task; off, none",
    async () => {
      const s = await setup();
      const { task, part } = s.taskPart();
      const dump = `const d = process.env.${TASK_CACHE_ENV}; console.log(JSON.stringify({ d: d ?? null, there: !!d && require("fs").existsSync(d) }))`;
      const step = async () => {
        const r = await checkStep({ db: s.db, dataDir: s.dataDir, project: "PROJ", repo: "repo", wt: s.wt, kinds: ["setup"], task, part });
        if (r.status !== "ran") throw new Error(r.reason);
        return JSON.parse(r.commands[0]?.tail ?? "") as { d: string | null; there: boolean };
      };
      s.save([cmd("env", "setup", dump)]);
      expect(await step()).toEqual({ d: null, there: false });
      s.save([cmd("env", "setup", dump)], { cache: true });
      expect(await step()).toEqual({ d: join(taskDir(s.dataDir, s.db, task), "cache"), there: true });
      // runChecks without a task gets no folder.
      const plain = await s.run({ kinds: ["setup"] });
      if (plain.status !== "ran") throw new Error(plain.reason);
      expect(JSON.parse(plain.commands[0]?.tail ?? "")).toEqual({ d: null, there: false });
    },
    SLOW,
  );

  test("a command that never starts keeps the reason for the Log row; a command that ran has none", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-notrun-")));
    dirs.push(dir);
    mkdirSync(join(dir, "repo"));
    const opts = { cwd: join(dir, "repo"), env: checkEnv(null) };
    const missing = await runCommand({ name: "setup", argv: [".venv/bin/python", "-m", "pip"], timeoutSec: 30 }, opts);
    expect([missing.exit, missing.notRun, missing.stopped]).toEqual([null, "Not found: .venv/bin/python", false]);
    expect(missing.tail).toBe("The command .venv/bin/python is not found.");
    const ran = await runCommand({ name: "ok", argv: [BUN, "-e", "1"], timeoutSec: 30 }, opts);
    expect([ran.exit, ran.notRun]).toEqual([0, null]);
    // An older detail row without the key still parses.
    expect(stepDetail.parse({ commands: [{ name: "x", argv: ["x"], exit: null, ms: 0, tail: "" }] }).commands[0]?.notRun).toBeNull();
  });

  // The Job Object (Windows) or the marker scan (/proc) ends the leftover. macOS has neither.
  test.skipIf(process.platform === "darwin")("a process that a green command leaves ends with the command", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-leftover-")));
    dirs.push(dir);
    const code = `const c = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"], detached: true }); c.unref(); console.log(c.pid);`;
    const r = await runCommand({ name: "daemon", argv: [BUN, "-e", code], timeoutSec: 30 }, { cwd: dir, env: checkEnv(null) });
    const left = Number(r.tail.trim());
    cleanup.push(() => alive(left) && process.kill(left, "SIGKILL"));
    expect([r.exit, left > 0]).toEqual([0, true]);
    expect(await until(() => !alive(left), 2000)).toBe(true);
  });

  test("the output tail keeps the last 64 KB", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-wpb3-tail-")));
    dirs.push(dir);
    mkdirSync(join(dir, "repo"));
    const code = `process.stdout.write("x".repeat(200000)); process.stderr.write("ERR"); process.stdout.write("END")`;
    const r = await runCommand({ name: "big", argv: [BUN, "-e", code], timeoutSec: 30 }, { cwd: join(dir, "repo"), env: checkEnv(null) });
    expect(r.exit).toBe(0);
    expect(Buffer.byteLength(r.tail)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(r.tail)).toBeGreaterThan(60 * 1024);
    // stdout and stderr are two pipes: ERR can arrive after END.
    expect(r.tail.slice(-6)).toContain("END");
    expect(r.tail).toContain("ERR");
  });
});

describe("kind order, skip after a failed build, and the env class (task-builder-v2.md sections 6.1 to 6.3, TB-3)", () => {
  test(
    "AC-TB9: a stored [test, lint, build] list runs the build first; a failed or missing build skips the test and lint rows; a green build lets them run",
    async () => {
      const s = await setup();
      const { task, part } = s.taskPart();
      const marker = join(s.root, "ran.txt");
      const mark = (id: string) => `require("fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${id}\n`)})`;
      const test = cmd("test", "test", mark("test"));
      const lint = cmd("lint", "lint", mark("lint"));
      const build = (code: string) => ({ ...cmd("b1", "build", `${mark("compile")}; ${code}`), name: "compile" });
      s.save([test, lint, build("process.exit(1)")]);
      const red = await checkStep({
        db: s.db,
        dataDir: s.dataDir,
        project: "PROJ",
        repo: "repo",
        wt: s.wt,
        kinds: CHECK_KINDS,
        task,
        part,
      });
      if (red.status !== "ran") throw new Error(red.reason);
      expect(red.green).toBe(false);
      expect(red.commands.map((c) => [c.id, c.exit, c.notRun, c.skipped])).toEqual([
        ["b1", 1, null, false],
        ["test", null, "Skipped: build compile failed", true],
        ["lint", null, "Skipped: build compile failed", true],
      ]);
      expect(readFileSync(marker, "utf8")).toBe("compile\n");
      expect(red.commands.map(envFault)).toEqual([false, false, false]);
      // The step row keeps the ID and the skip, so the next check compares with the base run by ID.
      expect(s.detail(red.step).commands.map((c) => [c.id, c.skipped])).toEqual([
        ["b1", false],
        ["test", true],
        ["lint", true],
      ]);
      // A build that is not found skips them too, and only the build is a fault of this computer.
      s.save([test, lint, { ...build(""), argv: ["rl-no-such-build-tb3"] }]);
      const lost = await s.run();
      if (lost.status !== "ran") throw new Error(lost.reason);
      expect(lost.commands.map((c) => [c.name, c.notRun])).toEqual([
        ["compile", "Not found: rl-no-such-build-tb3"],
        ["test", "Skipped: build compile failed"],
        ["lint", "Skipped: build compile failed"],
      ]);
      expect(lost.commands.map(envFault)).toEqual([true, false, false]);
      rmSync(marker);
      s.save([test, lint, build("")]);
      const green = await s.run();
      if (green.status !== "ran") throw new Error(green.reason);
      expect([green.green, readFileSync(marker, "utf8")]).toEqual([true, "compile\ntest\nlint\n"]);
    },
    SLOW,
  );

  test("the approval check of argv[0]: a bare name and an absolute path resolve here; a path in the repository waits for the run", () => {
    expect(hostProgram(BUN)).toEqual({ path: BUN });
    expect(hostProgram("rl-no-such-program-tb3")).toEqual({
      error: "The command rl-no-such-program-tb3 is not found.",
      reason: "Not found: rl-no-such-program-tb3",
      refused: false,
    });
    expect(hostProgram("build/unittests")).toBeNull();
    expect(hostProgram("tools\\gradlew.bat")).toBeNull();
  });

  test("onBase matches by command ID, and a base row from before the ID matches by name; the skipped rows stay out of failure.md", () => {
    const base: BaseRun[] = [
      { id: "b", name: "build", argv: ["make"], red: true, timedOut: false },
      { id: null, name: "old", argv: ["x"], red: false, timedOut: true },
    ];
    expect(onBase({ id: "b", name: "renamed", argv: ["make"] }, base)).toEqual({ red: true, same: true, argv: ["make"], timedOut: false });
    expect(onBase({ id: "other", name: "build", argv: ["make"] }, base)).toBeNull();
    expect(onBase({ id: "z", name: "old", argv: ["y"] }, base)).toEqual({ red: false, same: false, argv: ["x"], timedOut: true });
    const row = { argv: ["make"], ms: 5, tail: "make: *** [all] Error 2", running: false, timedOut: false, timeoutSec: 60, stopped: false };
    const failure = checkFailure(
      {
        status: "ran",
        green: false,
        notes: [],
        commands: [
          { ...row, id: "b", name: "build", exit: 2, notRun: null, skipped: false },
          { ...row, id: "t", name: "unit", exit: null, tail: "skip", notRun: "Skipped: build build failed", skipped: true },
        ],
      },
      base,
    ).text;
    expect(failure).toContain("The app did not run unit, because a build failed.");
    expect(failure).toContain("## build: exit 2 after 5 ms");
    expect(failure).toContain("- On the part base: Also red on the part base.");
    expect(failure).not.toContain("## unit");
  });

  test("check-order.md section 3: a test that the base skipped has no base run, so its later failure is new", () => {
    const row = { argv: ["make"], ms: 5, tail: "", running: false, timedOut: false, timeoutSec: 60 };
    const base = baseRuns([
      { ...row, id: "b", name: "build", exit: 2, notRun: null, skipped: false },
      { ...row, id: "t", name: "unit", argv: ["unit"], exit: null, notRun: "Skipped: build build failed", skipped: true },
    ]);
    expect(base.map((b) => [b.id, b.red])).toEqual([["b", true]]);
    expect(onBase({ id: "t", name: "unit", argv: ["unit"] }, base)).toBeNull();
    const failure = checkFailure(
      {
        status: "ran",
        green: false,
        notes: [],
        commands: [
          { ...row, id: "t", name: "unit", argv: ["unit"], exit: 1, tail: "1 fail", notRun: null, skipped: false, stopped: false },
        ],
      },
      base,
    ).text;
    expect(failure).toContain("## unit: exit 1 after 5 ms");
    expect(failure).not.toContain("On the part base");
  });

  test("quoteFound: the quote counts after CRLF to LF and an ANSI strip on both sides; an empty quote never counts", () => {
    const commands = [{ tail: "\u001b[31merror:\u001b[0m cannot find -lssl\r\nnext line\r\n" }];
    expect(quoteFound("error: cannot find -lssl\nnext line", commands)).toBe(true);
    expect(quoteFound("  error: cannot find -lssl  ", commands)).toBe(true);
    expect(quoteFound("\u001b[1mcannot find\u001b[0m", commands)).toBe(true);
    expect(quoteFound("cannot find -lcrypto", commands)).toBe(false);
    expect(quoteFound("   ", commands)).toBe(false);
  });
});
