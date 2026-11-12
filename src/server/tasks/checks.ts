// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The build, test, and lint commands of a task (docs/plans/review-v2/spec.md section 6.7 "Checks", design.md section 10 Q2). The app
// runs only the argv lists that the user approved for the repository, after the one-time warning, in the task worktree only. No shell
// runs: Bun.spawn gets the argument array. Each command has its timeout and a process-tree kill. Native Windows has no OS sandbox.
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { type CommandKind, limitText, OUTPUT_TAIL, type StepDetail, TASK_CACHE_ENV, type TaskCommand } from "../../shared/task";
import { log } from "../log";
import { childEnv, contain, killTree, RUN_MARKER } from "../review/claude";
import { endStep, insertStep, patchStep } from "./implement";
import { repoSettings } from "./tasks";
import { inside, taskDir, tasksRoot, type Worktree } from "./worktree";

// A child that a kill leaves can hold the pipes open. It must not block the step.
const DRAIN_MS = 5_000;
export const CHECK_KINDS: readonly CommandKind[] = ["build", "test", "lint"];

type StepCommand = StepDetail["commands"][number];
export type CommandResult = StepCommand & { stopped: boolean };

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
      chunks = [all];
      return new TextDecoder().decode(all.subarray(Math.max(0, all.length - max)));
    },
  };
}

async function pump(stream: ReadableStream<Uint8Array>, add: (c: Uint8Array) => void) {
  const r = stream.getReader();
  for (let c = await r.read(); !c.done; c = await r.read()) add(c.value);
}

// The least time between two onOutput calls of one command.
export const OUTPUT_MS = 1_000;

// Runs one command. The output keeps the last tailBytes of stdout and stderr together, in arrival order. exit is null when the
// timeout or the signal killed the process tree. onOutput gets the output so far, at most once per OUTPUT_MS, while new output comes.
export async function runCommand(
  cmd: Pick<TaskCommand, "name" | "argv" | "timeoutSec">,
  o: {
    cwd: string;
    env: Record<string, string>;
    signal?: AbortSignal;
    tailBytes?: number;
    onOutput?: (tail: string, ms: number) => void;
  },
): Promise<CommandResult> {
  const started = performance.now();
  const base = { name: cmd.name, argv: cmd.argv, running: false, timeoutSec: cmd.timeoutSec };
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
  const marker = crypto.randomUUID();
  const spawn = () =>
    Bun.spawn([prog.path, ...cmd.argv.slice(1)], {
      cwd: o.cwd,
      env: { ...o.env, [RUN_MARKER]: marker },
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
  contain(p.pid, marker);
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
  let fresh = false;
  const add = (c: Uint8Array) => {
    out.add(c);
    fresh = true;
  };
  const live = o.onOutput
    ? setInterval(() => {
        if (!fresh) return;
        fresh = false;
        try {
          o.onOutput?.(out.text(), Math.round(performance.now() - started));
        } catch (e) {
          // An error in a timer callback ends the process.
          log(`Could not show the output of ${cmd.name}: ${(e as Error).message}`);
        }
      }, OUTPUT_MS)
    : undefined;
  const pipes = Promise.all([pump(p.stdout, add), pump(p.stderr, add)]).catch(() => {});
  const code = await p.exited;
  clearTimeout(timer);
  clearInterval(live);
  o.signal?.removeEventListener("abort", onAbort);
  // A process that the command left, such as a build server, ends with the command.
  await killTree(p.pid, true);
  // A leftover that the kill missed can hold the pipes.
  await Promise.race([pipes, Bun.sleep(DRAIN_MS)]);
  const note = timedOut
    ? `\n[The command reached its time limit of ${limitText(cmd.timeoutSec)}. The app stopped it after ${cmd.timeoutSec} s.]\n`
    : stopped
      ? "\n[The app stopped the command.]\n"
      : "";
  return done(timedOut || stopped ? null : code, out.text() + note, timedOut, stopped);
}

export type ChecksInput = {
  db: Database;
  dataDir: string;
  project: string;
  repo: string;
  wt: Worktree;
  // setup runs once per worktree. build, test, and lint are the checks after a step.
  kinds: readonly CommandKind[];
  // The isolate_home setting of the repository. Absent: the stored setting.
  isolateHome?: boolean;
  signal?: AbortSignal;
  // The task of the commands. With the task_cache setting, each command gets REVIEW_LOOP_TASK_CACHE=<task folder>/cache.
  task?: number;
  // The commands so far: the ended ones, then the running one with its output so far.
  onProgress?: (commands: StepCommand[]) => void;
};

const detailOf = ({ stopped: _, ...c }: CommandResult): StepCommand => c;

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
  const cache = s.taskCache && i.task !== undefined ? join(taskDir(i.dataDir, i.db, i.task), "cache") : null;
  if (cache) mkdirSync(cache, { recursive: true });
  const home = (i.isolateHome ?? s.isolateHome) ? mkdtempSync(join(tmpdir(), "rl-home-")) : null;
  const env = checkEnv(home);
  if (cache) env[TASK_CACHE_ENV] = cache;
  const list = s.commands.filter((c) => i.kinds.includes(c.kind));
  const commands: CommandResult[] = [];
  try {
    for (const c of list) {
      const show = (tail: string, ms: number) =>
        i.onProgress?.([
          ...commands.map(detailOf),
          { name: c.name, argv: c.argv, exit: null, ms, tail, notRun: null, running: true, timedOut: false, timeoutSec: c.timeoutSec },
        ]);
      show("", 0);
      const r = await runCommand(c, { cwd: i.wt.repo, env, signal: i.signal, onOutput: show });
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
    notes: [],
  };
}

// The checks with their step row (kind check) for the Log tab: each command with argv, exit code, time, and the output tail.
// baseline: the checks on the part base (StepDetail.baseline). onChange: the step row got the output so far (spec.md section 6.7, Log).
export async function checkStep(
  i: ChecksInput & {
    task: number;
    part: number;
    item?: string | null;
    attempt?: number;
    baseline?: boolean;
    now?: () => number;
    onChange?: () => void;
  },
): Promise<ChecksResult & { step: number }> {
  const now = i.now ?? Date.now;
  const step = insertStep(i.db, { task: i.task, part: i.part, kind: "check", item: i.item ?? null, attempt: i.attempt ?? 1 }, now());
  const onProgress = (commands: StepCommand[]) => {
    patchStep(i.db, step, { commands });
    i.onChange?.();
  };
  const r = await runChecks({ ...i, onProgress }).catch((e): ChecksResult => ({ status: "refused", reason: (e as Error).message }));
  if (r.status === "refused") endStep(i.db, step, "failed", { notes: [r.reason] }, now());
  else
    endStep(
      i.db,
      step,
      r.green ? "ok" : r.commands.some((c) => c.stopped) ? "cancelled" : "failed",
      {
        commands: r.commands.map(detailOf),
        notes: r.notes,
        baseline: i.baseline ?? false,
      },
      now(),
    );
  return { ...r, step };
}
