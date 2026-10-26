// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build, test, and lint commands of a task (docs/plans/review-v2/spec.md section 6.7 "Checks", design.md section 10 Q2). The app
// runs only the argv lists that the user approved for the repository, after the one-time warning, in the task worktree only. No shell
// runs: Bun.spawn gets the argument array. Each command has its timeout and a process-tree kill. Native Windows has no OS sandbox.
import type { Database } from "bun:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, posix, resolve } from "node:path";
import { type CommandKind, OUTPUT_TAIL, type StepDetail, type TaskCommand } from "../../shared/task";
import { log } from "../log";
import { childEnv, killTree } from "../review/claude";
import { repoPath } from "../review/validate";
import { endStep, insertStep } from "./implement";
import { repoSettings } from "./tasks";
import { inside, tasksRoot, type Worktree } from "./worktree";

// A child that a kill leaves can hold the pipes open. It must not block the step.
const DRAIN_MS = 5_000;
export const CHECK_KINDS: readonly CommandKind[] = ["build", "test", "lint"];

export type CommandResult = StepDetail["commands"][number] & { timedOut: boolean; stopped: boolean };

// spec.md section 6.7: the scrubbed child env (BRIEF section 7, "Child environment") plus CI=1. The GIT_* and SSH_ASKPASS variables go
// too, as for every git child (git.ts baseEnv): they can name another repository, config, or credential prompt. home: the folder for
// HOME, and USERPROFILE on Windows (Node os.homedir() reads it there). null keeps the user's home.
export function checkEnv(home: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(childEnv())) {
    if (/^GIT_/i.test(k) || /^SSH_ASKPASS$/i.test(k) || /^CLAUDE_CODE_DISABLE_BACKGROUND_TASKS$/i.test(k)) continue;
    env[k] = v;
  }
  env.CI = "1";
  if (home !== null) {
    for (const k of Object.keys(env)) if (/^(HOME|USERPROFILE)$/i.test(k)) delete env[k];
    env.HOME = home;
    if (process.platform === "win32") env.USERPROFILE = home;
  }
  return env;
}

// The program of argv[0]: a path is taken as is (relative to cwd), a bare name goes through PATH of env.
// Windows: a .cmd or .bat file runs through cmd.exe, which parses the arguments again (CVE-2024-27980), so it is refused.
// reason: the short text of the Log row.
export function program(argv0: string, cwd: string, env: Record<string, string>): { path: string } | { error: string; reason: string } {
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const path = /[\\/]/.test(argv0)
    ? isAbsolute(argv0)
      ? argv0
      : resolve(cwd, argv0)
    : Bun.which(argv0, { PATH: env[pathKey] ?? "", cwd });
  if (!path || !statSync(path, { throwIfNoEntry: false })?.isFile())
    return { error: `The command ${argv0} is not found.`, reason: `Not found: ${argv0}` };
  if (process.platform === "win32" && [".cmd", ".bat"].includes(extname(path).toLowerCase()))
    return {
      error: `${argv0} is a ${extname(path)} script, which runs through cmd.exe. Use the program itself, such as node.exe with the script.`,
      reason: `Refused: ${argv0} runs through cmd.exe`,
    };
  return { path };
}

// Keeps the last max bytes of a stream of chunks.
function tailBuffer(max: number) {
  let chunks: Uint8Array[] = [];
  let size = 0;
  return {
    add(c: Uint8Array) {
      chunks.push(c);
      size += c.length;
      while (chunks.length > 1 && size - (chunks[0] as Uint8Array).length >= max) size -= (chunks.shift() as Uint8Array).length;
    },
    text() {
      const all = Buffer.concat(chunks);
      chunks = [];
      return new TextDecoder().decode(all.subarray(Math.max(0, all.length - max)));
    },
  };
}

async function pump(stream: ReadableStream<Uint8Array>, add: (c: Uint8Array) => void) {
  const r = stream.getReader();
  for (let c = await r.read(); !c.done; c = await r.read()) add(c.value);
}

// Runs one command. The output keeps the last tailBytes of stdout and stderr together, in arrival order. exit is null when the
// timeout or the signal killed the process tree.
export async function runCommand(
  cmd: Pick<TaskCommand, "name" | "argv" | "timeoutSec">,
  o: { cwd: string; env: Record<string, string>; signal?: AbortSignal; tailBytes?: number },
): Promise<CommandResult> {
  const started = performance.now();
  const base = { name: cmd.name, argv: cmd.argv };
  const done = (exit: number | null, tail: string, timedOut = false, stopped = false, notRun: string | null = null): CommandResult => ({
    ...base,
    exit,
    ms: Math.round(performance.now() - started),
    tail,
    notRun,
    timedOut,
    stopped,
  });
  if (o.signal?.aborted) return done(null, "The app stopped the checks before this command.", false, true);
  const prog = program(cmd.argv[0] as string, o.cwd, o.env);
  if ("error" in prog) return done(null, prog.error, false, false, prog.reason);
  const out = tailBuffer(o.tailBytes ?? OUTPUT_TAIL);
  const spawn = () =>
    Bun.spawn([prog.path, ...cmd.argv.slice(1)], {
      cwd: o.cwd,
      env: o.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // POSIX: a new process group, so one kill ends the command and its children.
      detached: process.platform !== "win32",
    });
  let p: ReturnType<typeof spawn>;
  try {
    p = spawn();
  } catch (e) {
    return done(null, `The command ${cmd.argv[0]} did not start: ${(e as Error).message}`, false, false, `Did not start: ${cmd.argv[0]}`);
  }
  let timedOut = false;
  let stopped = false;
  const kill = () => void killTree(p.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, cmd.timeoutSec * 1000);
  const onAbort = () => {
    stopped = true;
    kill();
  };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const pipes = Promise.all([pump(p.stdout, out.add), pump(p.stderr, out.add)]).catch(() => {});
  const code = await p.exited;
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", onAbort);
  // A leftover grandchild holds the pipes. The kill of a timeout or Stop already ended the tree.
  await Promise.race([pipes, Bun.sleep(DRAIN_MS)]);
  const note = timedOut
    ? `\n[The app stopped the command after ${cmd.timeoutSec} s.]\n`
    : stopped
      ? "\n[The app stopped the command.]\n"
      : "";
  return done(timedOut || stopped ? null : code, out.text() + note, timedOut, stopped);
}

// The scoped check of one task (spec.md section 6.4, Run line). run: the Run entries of the task. later: the Run entries of the later
// tasks of its plan part, whose tests the tests step wrote too and which stay red until their task.
export type Scope = { run: readonly string[]; later: readonly string[] };

const GLOB_CHARS = /[*?[\]{}!]/;
// ECMAScript and RE2 (Go regexp.QuoteMeta) share this set of special characters.
const regexQuote = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// CMake regex (https://cmake.org/cmake/help/latest/manual/cmake-language.7.html#regex-specification): "\<char>" matches <char>.
const cmakeQuote = (s: string) => s.replace(/[\^$.\\[\]*+?|()]/g, "\\$&");
const alt = (names: readonly string[], quote = regexQuote) => names.map(quote).join("|");

type Entries = { files: string[]; names: string[] };
type Narrowed = { label: string; argv: string[] }[] | { error: string };
// One test runner. args: the arguments after the program words of an approved argv that the app may narrow, else null. A Run line
// adds only test-file and test-name filters. narrow: the commands for the Run entries. skip: the approved argv without the test
// files of the later tasks, or null when the runner has no option for it.
type Runner = {
  args: (argv: readonly string[]) => readonly string[] | null;
  narrow: (argv: readonly string[], e: Entries, o: { cwd: string; later: Entries }) => Narrowed;
  skip: (argv: readonly string[], files: readonly string[]) => string[] | null;
};

const progName = (a: string | undefined) =>
  basename(a ?? "")
    .toLowerCase()
    .replace(/\.exe$/, "");
// The arguments after the first program shape that argv starts with. Only argv[0] can be a path.
function after(argv: readonly string[], shapes: readonly (readonly string[])[]): readonly string[] | null {
  for (const s of shapes) if (progName(argv[0]) === s[0] && s.slice(1).every((w, i) => argv[i + 1] === w)) return argv.slice(s.length);
  return null;
}
// Flags only: a positional argument can be a path filter that adds tests back, or the value of a flag that the app cannot tell from
// one. "--" ends the options, so a filter after it is no option. filter: a flag that already selects tests.
const flagsOnly = (args: readonly string[] | null, filter: RegExp) =>
  args?.every((a) => a.startsWith("-") && a !== "--" && !filter.test(a)) ? args : null;
const nameCmd = (argv: readonly string[], ...extra: string[]) => [{ label: "tests of the task", argv: [...argv, ...extra] }];
const fileCmd = (argv: readonly string[], files: readonly string[]) =>
  files.length ? [{ label: "test files of the task", argv: [...argv, ...files] }] : [];
const both = (argv: readonly string[], e: Entries, files: readonly string[], names: () => string[]) => [
  ...fileCmd(argv, files),
  ...(e.names.length ? nameCmd(argv, ...names()) : []),
];
const noFiles = (e: Entries, runner: string): { error: string } | null =>
  e.files.length ? { error: `"${e.files[0]}" is a file, and ${runner} selects tests by name only.` } : null;
// pytest -k grammar (src/_pytest/mark/expression.py): ident is (\w|:|\+|-|\.|\[|\]|\\|/)+, and "or", "and", "not" are keywords.
const PYTEST_IDENT = /^[\w:+\-.[\]\\/]+$/;

const RUNNERS: Record<string, Runner> = {
  // https://bun.sh/docs/cli/test: a filter that starts with "./" names one file, -t takes a regex of test names, and
  // --path-ignore-patterns takes a glob of test files to skip.
  "bun test": {
    args: (argv) => flagsOnly(after(argv, [["bun", "test"]]), /^(-t|--test-name-pattern)(=|$)/),
    narrow: (argv, e) =>
      both(
        argv,
        e,
        e.files.map((f) => `./${f}`),
        () => ["-t", alt(e.names)],
      ),
    skip: (argv, files) => (files.some((f) => GLOB_CHARS.test(f)) ? null : [...argv, ...files.map((f) => `--path-ignore-patterns=${f}`)]),
  },
  // https://docs.pytest.org/en/stable/how-to/usage.html: a file path as a positional argument, -k takes a keyword expression of
  // test names (case-insensitive substrings). Reference: --ignore=PATH skips a path during collection. A short flag group with k
  // is a -k of the approved command.
  pytest: {
    args: (argv) =>
      flagsOnly(
        after(argv, [["pytest"], ["python", "-m", "pytest"], ["python3", "-m", "pytest"], ["py", "-m", "pytest"], ["uv", "run", "pytest"]]),
        /^-[A-Za-z]*k/,
      ),
    narrow: (argv, e) => {
      const bad = e.names.find((n) => !PYTEST_IDENT.test(n) || ["or", "and", "not"].includes(n));
      if (bad !== undefined) return { error: `"${bad}" is not a pytest -k name: use letters, digits, and _ : + - . [ ] only.` };
      return both(argv, e, e.files, () => ["-k", e.names.join(" or ")]);
    },
    skip: (argv, files) => [...argv, ...files.map((f) => `--ignore=${f}`)],
  },
  // https://jestjs.io/docs/cli: a positional argument is a regex of test paths, -t takes a regex of full test names.
  // --testPathIgnorePatterns replaces the configured list (jest-config setFromArgv.ts), so it would run the tests that the config
  // skips. The app does not use it.
  jest: {
    args: (argv) =>
      flagsOnly(
        after(argv, [["jest"], ["npx", "jest"]]),
        /^(-t|--testNamePattern|--testPathPatterns?|--runTestsByPath|--findRelatedTests)(=|$)/,
      ),
    narrow: (argv, e) => both(argv, e, e.files.map(regexQuote), () => ["-t", alt(e.names)]),
    skip: () => null,
  },
  // https://vitest.dev/guide/filtering: a positional filter selects the files whose path contains it (no regex, no glob), and
  // "<file>:<line>" selects a line. -t takes a regex of full test names. --exclude adds a glob to the configured exclude list
  // (https://vitest.dev/guide/cli, resolveConfig.ts cliExclude).
  vitest: {
    args: (argv) =>
      flagsOnly(
        after(argv, [
          ["vitest", "run"],
          ["npx", "vitest", "run"],
        ]),
        /^(-t|--testNamePattern)(=|$)/,
      ),
    narrow: (argv, e) => {
      const bad = e.files.find((f) => /:\d+$/.test(f));
      if (bad) return { error: `"${bad}" reads as a file and a line for vitest.` };
      return both(argv, e, e.files, () => ["-t", alt(e.names)]);
    },
    skip: (argv, files) => (files.some((f) => GLOB_CHARS.test(f)) ? null : [...argv, ...files.flatMap((f) => ["--exclude", f])]),
  },
  // https://pkg.go.dev/cmd/go#hdr-Testing_flags: -run takes a regex of test names, split at unbracketed "/" (a Run name has no "/").
  // Flags may follow the packages ("go test [build/test flags] [packages] [build/test flags & test binary flags]"). A file maps to
  // its package folder when the approved argv runs "./..." and that folder is in it: "./..." skips folders that start with "." or
  // "_", testdata, vendor, and nested modules (https://pkg.go.dev/cmd/go#hdr-Package_lists_and_patterns). The whole package runs,
  // so the later tasks must name no test in it: no later name, and no later file in the same folder.
  "go test": {
    args: (argv) => {
      const a = after(argv, [["go", "test"]]);
      return a?.every((x) => (x.startsWith("-") ? x !== "--" && !/^--?(test\.)?run(=|$)/.test(x) : x === "./...")) ? a : null;
    },
    narrow: (argv, e, o) => {
      if (!e.files.length) return nameCmd(argv, "-run", `^(${alt(e.names)})$`);
      if (!argv.includes("./...")) return { error: `"${e.files[0]}" needs an approved go test command with ./... to name its package.` };
      const dirs = new Set<string>();
      for (const f of e.files) {
        const dir = posix.dirname(f);
        const parts = dir === "." ? [] : dir.split("/");
        const nested = parts.some((_, i) => statSync(join(o.cwd, ...parts.slice(0, i + 1), "go.mod"), { throwIfNoEntry: false }));
        if (!f.endsWith(".go") || nested || parts.some((s) => /^[._]/.test(s) || s === "testdata" || s === "vendor"))
          return { error: `"${f}" is not a Go file of a package in ./... .` };
        if (o.later.names.length || o.later.files.some((l) => posix.dirname(l) === dir))
          return { error: `"${f}": its package can hold the tests of a later task.` };
        dirs.add(dir === "." ? "." : `./${dir}`);
      }
      const pkgs = argv.flatMap((x) => (x === "./..." ? [...dirs] : [x]));
      return [{ label: "test files of the task", argv: pkgs }, ...(e.names.length ? nameCmd(argv, "-run", `^(${alt(e.names)})$`) : [])];
    },
    skip: () => null,
  },
  // https://doc.rust-lang.org/cargo/commands/cargo-test.html: "cargo test [options] [testname] [-- test-options]". TESTNAME is one
  // substring filter, so each name runs as its own command. A positional argument before or after "--" is a filter already.
  "cargo test": {
    args: (argv) => {
      const a = after(argv, [["cargo", "test"]]);
      const sep = a?.indexOf("--") ?? -1;
      return a?.every((x, i) => x.startsWith("-") && (x !== "--" || i === sep)) ? a : null;
    },
    narrow: (argv, e) => {
      const err = noFiles(e, "cargo test");
      if (err) return err;
      const sep = argv.indexOf("--");
      const at = sep < 0 ? argv.length : sep;
      return e.names.map((n) => ({ label: `tests of the task: ${n}`, argv: [...argv.slice(0, at), n, ...argv.slice(at)] }));
    },
    skip: () => null,
  },
  // https://cmake.org/cmake/help/latest/manual/ctest.1.html: -R takes a CMake regex of test names. ctest takes no positional
  // filter, so a non-flag argument is the value of a flag. -R, -E, -L, -LE, -I, -U and the long forms select tests already. Arguments
  // after "--" go to the test programs (CMake 4.4).
  ctest: {
    args: (argv) => {
      const a = after(argv, [["ctest"]]);
      const filter =
        /^(-[RELIU]|--(tests-regex|exclude-regex|label-regex|label-exclude|tests-information|tests-from-file|exclude-from-file|rerun-failed|union)(=|$))/;
      return a?.every((x) => x !== "--" && !filter.test(x)) ? a : null;
    },
    narrow: (argv, e) => noFiles(e, "ctest") ?? nameCmd(argv, "-R", `^(${alt(e.names, cmakeQuote)})$`),
    skip: () => null,
  },
};

// Splits Run entries into test files and test names. A Run entry is a value for a filter of the runner, never a program or a flag.
// A file: a repository path of a file in cwd. A name: no path separator, no leading "-", no control character, and its first word is
// not a program on PATH. Any other entry refuses the whole Run line.
export function runEntries(
  run: readonly string[],
  cwd: string,
  env: Record<string, string>,
): { files: string[]; names: string[] } | { error: string } {
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const files: string[] = [];
  const names: string[] = [];
  for (const raw of run) {
    const x = raw.trim();
    const p = repoPath(x);
    // A file path that starts with "-" reads as a flag for most runners.
    if (x.startsWith("-") || p?.startsWith("-")) return { error: `"${x}" is not a test file or a test name.` };
    if (p && statSync(join(cwd, p), { throwIfNoEntry: false })?.isFile()) files.push(p);
    else if (/[\\/]/.test(x)) return { error: `"${x}" names no file in the repository.` };
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the rule refuses control characters.
    else if (!x || /[\u0000-\u001f\u007f]/.test(x)) return { error: `"${x}" is not a test file or a test name.` };
    else {
      const word = x.split(/\s+/)[0] as string;
      if (Bun.which(word, { PATH: env[pathKey] ?? "", cwd }))
        return { error: `"${x}" starts with the program ${word}. A Run line names tests, never a command.` };
      names.push(x);
    }
  }
  return { files, names };
}

// The commands of a scoped check: the approved test command narrowed to the tests of the task (RUNNERS). A refused Run line runs
// the approved command without the test files of the later tasks. No command: the app cannot narrow, and the full checks at the end
// of the part gate the tests. Each note says why.
export function scopedCommands(
  tests: readonly TaskCommand[],
  scope: Scope,
  cwd: string,
  env: Record<string, string>,
): { commands: TaskCommand[]; notes: string[] } {
  const cmd = tests[0];
  const end = "The full checks run at the end of the part.";
  const runner = cmd && tests.length === 1 ? Object.values(RUNNERS).find((x) => x.args(cmd.argv)) : undefined;
  if (!cmd || !runner)
    return {
      commands: [],
      notes: [
        `The app narrows only one approved test command of ${Object.keys(RUNNERS)
          .map((k) => `"${k}"`)
          .join(", ")}, with no test filter of its own, so it cannot run only the tests of this task. ${end}`,
      ],
    };
  const later = runEntries(scope.later, cwd, env);
  const r = runEntries(scope.run, cwd, env);
  const n = "error" in r ? r : runner.narrow(cmd.argv, r, { cwd, later: "error" in later ? { files: [], names: [] } : later });
  if (!("error" in n)) return { commands: n.map((c) => ({ ...cmd, name: `${cmd.name}: ${c.label}`, argv: c.argv })), notes: [] };
  const refused = `The app refused the Run line of the task: ${n.error}`;
  if ("error" in later || later.names.length)
    return { commands: [], notes: [`${refused} The later tasks name tests that the app cannot skip. ${end}`] };
  const argv = later.files.length ? runner.skip(cmd.argv, later.files) : [...cmd.argv];
  if (!argv) return { commands: [], notes: [`${refused} The app cannot skip the test files of the later tasks with this runner. ${end}`] };
  return {
    commands: [{ ...cmd, argv }],
    notes: [`${refused} The check runs ${cmd.name} without the test files of the later tasks.`],
  };
}

export type ChecksInput = {
  db: Database;
  dataDir: string;
  project: string;
  repo: string;
  wt: Worktree;
  // setup runs once per worktree. build, test, and lint are the checks after a step.
  kinds: readonly CommandKind[];
  // Set: only the test commands run, narrowed to the tests of one task (scopedCommands).
  scope?: Scope;
  // The isolate_home setting of the repository. Absent: the stored setting.
  isolateHome?: boolean;
  signal?: AbortSignal;
};

export type ChecksResult =
  | { status: "ran"; green: boolean; commands: CommandResult[]; notes: string[] }
  | { status: "refused"; reason: string };

// Runs the approved commands of the kinds in the order of repo_task_settings.commands_json. Green: every command exited with 0. The
// run stops at a stopped command. The commands come only from the stored settings, never from a caller.
export async function runChecks(i: ChecksInput): Promise<ChecksResult> {
  const s = repoSettings(i.db, i.project, i.repo);
  if (s.warnedAt === null) return { status: "refused", reason: "Accept the warning about app-run commands first." };
  if (!inside(tasksRoot(i.dataDir), i.wt.repo) || !inside(i.wt.dir, i.wt.repo))
    return { status: "refused", reason: "The app runs commands only in a task folder." };
  const home = (i.isolateHome ?? s.isolateHome) ? mkdtempSync(join(tmpdir(), "rl-home-")) : null;
  const env = checkEnv(home);
  const scoped = i.scope
    ? scopedCommands(
        s.commands.filter((c) => c.kind === "test"),
        i.scope,
        i.wt.repo,
        env,
      )
    : null;
  const list = scoped?.commands ?? s.commands.filter((c) => i.kinds.includes(c.kind));
  const commands: CommandResult[] = [];
  try {
    for (const c of list) {
      const r = await runCommand(c, { cwd: i.wt.repo, env, signal: i.signal });
      log(
        `Task check ${c.name}: ${r.notRun ?? `exit ${r.exit ?? "none"}`} in ${r.ms} ms${r.timedOut ? " (timed out)" : r.stopped ? " (stopped)" : ""}.`,
      );
      commands.push(r);
      if (r.stopped) break;
    }
  } finally {
    if (home) await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  return {
    status: "ran",
    green: commands.length === list.length && commands.every((c) => c.exit === 0),
    commands,
    notes: scoped?.notes ?? [],
  };
}

// The checks with their step row (kind check) for the Log tab: each command with argv, exit code, time, and the output tail.
// expectRed: the checks of the tests step, which must fail (StepDetail.expectRed).
export async function checkStep(
  i: ChecksInput & { task: number; part: number; item?: string | null; attempt?: number; expectRed?: boolean; now?: () => number },
): Promise<ChecksResult & { step: number }> {
  const now = i.now ?? Date.now;
  const step = insertStep(i.db, { task: i.task, part: i.part, kind: "check", item: i.item ?? null, attempt: i.attempt ?? 1 }, now());
  const r = await runChecks(i).catch((e): ChecksResult => ({ status: "refused", reason: (e as Error).message }));
  if (r.status === "refused") endStep(i.db, step, "failed", { notes: [r.reason] }, now());
  else
    endStep(
      i.db,
      step,
      !r.commands.length && i.scope ? "skipped" : r.green ? "ok" : r.commands.some((c) => c.stopped) ? "cancelled" : "failed",
      {
        commands: r.commands.map(({ name, argv, exit, ms, tail, notRun }) => ({ name, argv, exit, ms, tail, notRun })),
        notes: r.notes,
        expectRed: i.expectRed ?? false,
      },
      now(),
    );
  return { ...r, step };
}
