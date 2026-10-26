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
import { CHECK_KINDS, checkEnv, checkStep, runChecks, runCommand, runEntries, scopedCommands } from "../../src/server/tasks/checks";
import { saveRepoSettings } from "../../src/server/tasks/tasks";
import { openWorktree, type Worktree } from "../../src/server/tasks/worktree";
import { stepDetail, type TaskCommand } from "../../src/shared/task";
import { taskCache, taskRemote } from "./fixture";

console.log(`checks.test.ts imported from ${Bun.resolveSync("../../src/server/tasks/checks", import.meta.dir)}`);

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
  writeConfig(dataDir, { baseUrl: "http://127.0.0.1:9", userSlug: "u", notifications: false });
  const settings = createSettings({ dir: dataDir, secrets: createSecrets(null), jiraSecrets: createSecrets(null, "jira-token") });
  const db = settings.db() as Database;
  cleanup.push(() => db.close());
  const { base } = await taskCache(dataDir, r.remote);
  const wt = await openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task: 1, ord: 1, branch: "feature/K-1-x", base });
  const save = (commands: TaskCommand[], o: { warned?: boolean; isolate?: boolean } = {}) => {
    saveRepoSettings(db, "PROJ", "repo", {
      specDir: "specs/{key}/",
      lineBudget: 400,
      maxOpen: 2,
      approvals: 1,
      commands,
      testGlobs: null,
      excludeGlobs: null,
      isolateHome: o.isolate ?? true,
    });
    db.query("UPDATE repo_task_settings SET warned_at = $w").run({ w: o.warned === false ? null : 1 });
  };
  const run = (o: { kinds?: typeof CHECK_KINDS; signal?: AbortSignal; wt?: Worktree } = {}) =>
    runChecks({ db, dataDir, project: "PROJ", repo: "repo", wt: o.wt ?? wt, kinds: o.kinds ?? CHECK_KINDS, signal: o.signal });
  return { root, dataDir, db, wt, save, run };
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
    "run only after the warning, only the stored commands of the kinds, in their order, in the task worktree",
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
        ["lint", 0],
        ["test", 3],
      ]);
      const lines = readFileSync(marker, "utf8").trim().split("\n");
      expect(lines.map((l) => l.split(":")[0])).toEqual(["lint", "test"]);
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

describe("scoped checks (spec.md section 6.4, Run line)", () => {
  const BUN_TEST = { id: "t", name: "test", kind: "test" as const, argv: [BUN, "test", "--bail"], timeoutSec: 60 };
  const repo = () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-scope-")));
    dirs.push(dir);
    mkdirSync(join(dir, "tests"));
    for (const n of ["one", "two"]) writeFileSync(join(dir, "tests", `${n}.test.ts`), "");
    return dir;
  };

  test("a Run line names test files and test names, never a program or a flag", () => {
    const dir = repo();
    const env = checkEnv(null);
    expect(runEntries(["tests/one.test.ts", "./tests\\two.test.ts", "adds a+b"], dir, env)).toEqual({
      files: ["tests/one.test.ts", "tests/two.test.ts"],
      names: ["adds a+b"],
    });
    // A different program, a flag, a missing file, and a path outside the repository.
    expect(runEntries(["git log"], dir, env)).toEqual({
      error: '"git log" starts with the program git. A Run line names tests, never a command.',
    });
    expect(runEntries(["--watch"], dir, env)).toEqual({ error: '"--watch" is not a test file or a test name.' });
    expect(runEntries(["tests/none.test.ts"], dir, env)).toEqual({ error: '"tests/none.test.ts" names no file in the repository.' });
    expect(runEntries(["../x/one.test.ts"], dir, env)).toEqual({ error: '"../x/one.test.ts" names no file in the repository.' });
  });

  test("the approved bun test command gets the filters of the task; a refused Run line skips the tests of the later tasks", () => {
    const dir = repo();
    const env = checkEnv(null);
    const later = ["tests/two.test.ts"];
    expect(scopedCommands([BUN_TEST], { run: ["tests/one.test.ts", "adds a+b"], later }, dir, env)).toEqual({
      commands: [
        { ...BUN_TEST, name: "test: test files of the task", argv: [BUN, "test", "--bail", "./tests/one.test.ts"] },
        { ...BUN_TEST, name: "test: tests of the task", argv: [BUN, "test", "--bail", "-t", "adds a\\+b"] },
      ],
      notes: [],
    });
    const refused = scopedCommands([BUN_TEST], { run: ["git log"], later }, dir, env);
    expect(refused.commands.map((c) => c.argv)).toEqual([[BUN, "test", "--bail", "--path-ignore-patterns=tests/two.test.ts"]]);
    expect(refused.notes[0]).toStartWith('The app refused the Run line of the task: "git log" starts with the program git.');
    // A later task that names a test by name cannot be skipped: no scoped command, and the full checks gate the part.
    expect(scopedCommands([BUN_TEST], { run: ["git log"], later: ["two works"] }, dir, env).commands).toEqual([]);
    // Another runner, a path filter in the approved argv, or two test commands: the app does not narrow.
    for (const tests of [[{ ...BUN_TEST, argv: ["npm", "test"] }], [{ ...BUN_TEST, argv: [BUN, "test", "tests"] }], [BUN_TEST, BUN_TEST]]) {
      const r = scopedCommands(tests, { run: ["tests/one.test.ts"], later }, dir, env);
      expect(r.commands).toEqual([]);
      expect(r.notes[0]).toContain("The full checks run at the end of the part.");
    }
  });

  // One row per runner: the approved argv, the narrowed argv lists for the Run line, the approved argv lists that already filter,
  // and the fallback argv for a refused Run line with later = ["tests/two.test.ts"] (null: no scoped command).
  type Row = {
    runner: string;
    approved: string[];
    run: string[];
    narrowed: string[][];
    filtered: string[][];
    fallback: string[] | null;
  };
  const F = "tests/one.test.ts";
  const rows: Row[] = [
    {
      runner: "bun test",
      approved: ["bun", "test", "--bail"],
      run: [F, "adds a+b"],
      narrowed: [
        ["bun", "test", "--bail", `./${F}`],
        ["bun", "test", "--bail", "-t", "adds a\\+b"],
      ],
      filtered: [
        ["bun", "test", "--test-name-pattern=x"],
        ["bun", "test", "tests"],
      ],
      fallback: ["bun", "test", "--bail", "--path-ignore-patterns=tests/two.test.ts"],
    },
    {
      runner: "pytest",
      approved: ["pytest", "-q"],
      run: [F, "test_add", "test_sub[1-2]"],
      narrowed: [
        ["pytest", "-q", F],
        ["pytest", "-q", "-k", "test_add or test_sub[1-2]"],
      ],
      filtered: [
        ["pytest", "-k", "x"],
        ["pytest", "-xkfoo"],
        ["pytest", "tests"],
        ["pytest", "--", "-k"],
        ["pytest", "-m", "slow"],
      ],
      fallback: ["pytest", "-q", "--ignore=tests/two.test.ts"],
    },
    {
      runner: "python -m pytest",
      approved: ["python3", "-m", "pytest"],
      run: ["test_add"],
      narrowed: [["python3", "-m", "pytest", "-k", "test_add"]],
      filtered: [["python", "-m", "pytest", "tests"]],
      fallback: ["python3", "-m", "pytest", "--ignore=tests/two.test.ts"],
    },
    {
      runner: "uv run pytest",
      approved: ["uv", "run", "pytest"],
      run: [F],
      narrowed: [["uv", "run", "pytest", F]],
      filtered: [["uv", "run", "pytest", "-k=x"]],
      fallback: ["uv", "run", "pytest", "--ignore=tests/two.test.ts"],
    },
    {
      runner: "jest",
      approved: ["npx", "jest", "--ci"],
      run: [F, "adds (a)"],
      narrowed: [
        ["npx", "jest", "--ci", "tests/one\\.test\\.ts"],
        ["npx", "jest", "--ci", "-t", "adds \\(a\\)"],
      ],
      filtered: [
        ["jest", "-t=x"],
        ["jest", "--testPathPatterns=x"],
        ["jest", "src"],
        ["jest", "--runTestsByPath"],
      ],
      // --testPathIgnorePatterns replaces the configured list, so the app has no skip option for jest.
      fallback: null,
    },
    {
      runner: "vitest",
      approved: ["vitest", "run", "--reporter=dot"],
      run: [F, "a.b"],
      narrowed: [
        ["vitest", "run", "--reporter=dot", F],
        ["vitest", "run", "--reporter=dot", "-t", "a\\.b"],
      ],
      filtered: [["npx", "vitest", "run", "--testNamePattern=x"], ["vitest", "run", "src"], ["vitest"]],
      fallback: ["vitest", "run", "--reporter=dot", "--exclude", "tests/two.test.ts"],
    },
    {
      runner: "go test",
      approved: ["go", "test", "-count=1", "./..."],
      run: ["TestAdd", "TestSub.x"],
      narrowed: [["go", "test", "-count=1", "./...", "-run", "^(TestAdd|TestSub\\.x)$"]],
      filtered: [
        ["go", "test", "-run=X", "./..."],
        ["go", "test", "./pkg"],
        ["go", "test", "-tags", "x"],
      ],
      fallback: null,
    },
    {
      runner: "cargo test",
      approved: ["cargo", "test", "--release", "--", "--nocapture"],
      run: ["adds", "subs"],
      narrowed: [
        ["cargo", "test", "--release", "adds", "--", "--nocapture"],
        ["cargo", "test", "--release", "subs", "--", "--nocapture"],
      ],
      filtered: [
        ["cargo", "test", "adds"],
        ["cargo", "test", "--", "adds"],
        ["cargo", "test", "-p", "x"],
      ],
      fallback: null,
    },
    {
      runner: "ctest",
      approved: ["ctest", "--test-dir", "build", "-C", "Release"],
      run: ["math.add(1)", "a|b"],
      narrowed: [["ctest", "--test-dir", "build", "-C", "Release", "-R", "^(math\\.add\\(1\\)|a\\|b)$"]],
      filtered: [
        ["ctest", "-R", "x"],
        ["ctest", "-LE", "slow"],
        ["ctest", "--rerun-failed"],
        ["ctest", "--", "x"],
      ],
      fallback: null,
    },
  ];

  for (const row of rows)
    test(`${row.runner}: narrowing, a refused Run line, an approved filter, and the fallback`, () => {
      const dir = repo();
      const env = checkEnv(null);
      const later = ["tests/two.test.ts"];
      const t = (argv: string[]): TaskCommand => ({ id: "t", name: "test", kind: "test", argv, timeoutSec: 60 });
      const narrowed = scopedCommands([t(row.approved)], { run: row.run, later }, dir, env);
      expect(narrowed.notes).toEqual([]);
      expect(narrowed.commands.map((c) => c.argv)).toEqual(row.narrowed);
      // A different program in the Run line refuses it: the fallback skips the test files of the later tasks, where it can.
      const refused = scopedCommands([t(row.approved)], { run: ["git log"], later }, dir, env);
      expect(refused.commands.map((c) => c.argv)).toEqual(row.fallback ? [row.fallback] : []);
      expect(refused.notes[0]).toStartWith('The app refused the Run line of the task: "git log" starts with the program git.');
      // No later test files: the fallback runs the approved command as it is.
      expect(scopedCommands([t(row.approved)], { run: ["git log"], later: [] }, dir, env).commands.map((c) => c.argv)).toEqual([
        row.approved,
      ]);
      // A later test name: nothing can skip it.
      expect(scopedCommands([t(row.approved)], { run: ["git log"], later: ["two works"] }, dir, env).commands).toEqual([]);
      for (const argv of row.filtered) {
        const r = scopedCommands([t(argv)], { run: row.run, later }, dir, env);
        expect({ argv, commands: r.commands }).toEqual({ argv, commands: [] });
        expect(r.notes[0]).toContain("with no test filter of its own");
      }
    });

  test("runner rules: names a runner cannot take, files of name-only runners, and Go packages", () => {
    const dir = repo();
    for (const d of ["pkg", "pkg/testdata", "mod", "_skip"]) mkdirSync(join(dir, d), { recursive: true });
    for (const f of ["pkg/a_test.go", "pkg/b_test.go", "pkg/testdata/c_test.go", "mod/go.mod", "mod/d_test.go", "_skip/e_test.go", "-x.py"])
      writeFileSync(join(dir, f), "");
    const env = checkEnv(null);
    const t = (...argv: string[]): TaskCommand[] => [{ id: "t", name: "test", kind: "test", argv, timeoutSec: 60 }];
    const run = (tests: TaskCommand[], r: string[], later: string[] = []) => scopedCommands(tests, { run: r, later }, dir, env);
    const why = (tests: TaskCommand[], r: string[], later: string[] = []) => run(tests, r, later).notes[0] ?? "";
    // pytest -k takes identifiers only, and "or", "and", "not" are its keywords.
    expect(why(t("pytest"), ["adds a+b"])).toContain('"adds a+b" is not a pytest -k name');
    expect(why(t("pytest"), ["not"])).toContain('"not" is not a pytest -k name');
    // ctest and cargo select tests by name only.
    expect(why(t("ctest"), [F])).toContain(`"${F}" is a file, and ctest selects tests by name only.`);
    expect(why(t("cargo", "test"), [F])).toContain(`"${F}" is a file, and cargo test selects tests by name only.`);
    // A file whose path starts with "-" reads as a flag.
    expect(runEntries(["-x.py"], dir, env)).toEqual({ error: '"-x.py" is not a test file or a test name.' });
    expect(runEntries(["./-x.py"], dir, env)).toEqual({ error: '"./-x.py" is not a test file or a test name.' });
    // go test: a file maps to its package folder when "./..." holds it and no later task can name a test in it.
    const go = t("go", "test", "./...", "-v");
    expect(run(go, ["pkg/a_test.go", "TestA"]).commands.map((c) => c.argv)).toEqual([
      ["go", "test", "./pkg", "-v"],
      ["go", "test", "./...", "-v", "-run", "^(TestA)$"],
    ]);
    expect(why(go, ["pkg/a_test.go"], ["pkg/b_test.go"])).toContain("its package can hold the tests of a later task");
    expect(why(go, ["pkg/a_test.go"], ["TestB"])).toContain("its package can hold the tests of a later task");
    for (const f of ["pkg/testdata/c_test.go", "mod/d_test.go", "_skip/e_test.go", F])
      expect(why(go, [f])).toContain(`"${f}" is not a Go file of a package in ./... .`);
    expect(why(t("go", "test", "-v"), ["pkg/a_test.go"])).toContain("needs an approved go test command with ./...");
    // A glob character in a later file: bun and vitest cannot skip it as a literal path.
    writeFileSync(join(dir, "tests", "[x].test.ts"), "");
    expect(why(t("vitest", "run"), ["git log"], ["tests/[x].test.ts"])).toContain("cannot skip the test files of the later tasks");
    // A vitest filter "<file>:<line>" selects a line.
    if (process.platform !== "win32") {
      writeFileSync(join(dir, "tests", "y.ts:10"), "");
      expect(why(t("vitest", "run"), ["tests/y.ts:10"])).toContain("reads as a file and a line for vitest");
    }
  });

  // Optional: a real pytest takes the narrowed argv. It skips when pytest is not on PATH.
  const pytest = Bun.which("pytest");
  test.skipIf(!pytest)(
    "a real pytest runs only the tests of the task",
    async () => {
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-pytest-")));
      dirs.push(dir);
      writeFileSync(join(dir, "test_a.py"), "def test_add():\n    assert True\n\ndef test_later():\n    assert False\n");
      const env = checkEnv(null);
      const tests: TaskCommand[] = [
        { id: "t", name: "test", kind: "test", argv: [pytest as string, "-q", "-p", "no:cacheprovider"], timeoutSec: 60 },
      ];
      // "-p no:cacheprovider" has a flag value, so the app refuses to narrow it. The flag form with "=" is fine.
      expect(scopedCommands(tests, { run: ["test_add"], later: [] }, dir, env).commands).toEqual([]);
      tests[0] = { ...(tests[0] as TaskCommand), argv: [pytest as string, "-q", "-pno:cacheprovider"] };
      const s = scopedCommands(tests, { run: ["test_add"], later: [] }, dir, env);
      const r = await runCommand(s.commands[0] as TaskCommand, { cwd: dir, env });
      expect(r.tail).toContain("1 passed");
      expect(r.exit).toBe(0);
    },
    SLOW,
  );
});
