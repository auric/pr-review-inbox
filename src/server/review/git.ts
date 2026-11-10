// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Runs git with an argument array and an isolated config (plan v3 section 2, "Git isolation").
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "../log";

const TIMEOUT_MS = 10 * 60_000;
const DRAIN_MS = 5_000;
const STDERR_TAIL = 2_000;

// Bun docs: BUN_BE_BUN=1 turns a compiled binary into the bun CLI. BUN_OPTIONS and NODE_OPTIONS add runtime flags. No child gets them.
export const RUNTIME_ENV = /^(?:BUN_BE_BUN|BUN_OPTIONS|NODE_OPTIONS)$/i;

// workspace.ts initCache writes these into each cache. Lowercase keys: `git config --list` prints them so.
export const CACHE_CONFIG: [string, string][] = [
  ["core.symlinks", "false"],
  ["core.longpaths", "true"],
  ["core.autocrlf", "false"],
];
// worktree.ts openWorktree writes these into the config.worktree of each task worktree.
export const worktreeConfig = (hooks: string): [string, string][] => [
  ["core.symlinks", "false"],
  ["core.autocrlf", "false"],
  ["core.hooksPath", hooks],
];
// The keys that git writes itself: `git init` (setup.c create_default_files and initialize_repository_version), and `git sparse-checkout
// set` (worktree.c init_worktree_config, which also moves core.bare to config.worktree, and builtin/sparse-checkout.c set_config).
const GIT_KEYS = [
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.symlinks",
  "core.ignorecase",
  "core.precomposeunicode",
  "extensions.objectformat",
  "extensions.refstorage",
  "extensions.worktreeconfig",
  "core.sparsecheckout",
  "core.sparsecheckoutcone",
];
// docs/plans/review-v2/git-deny.md fix E: the only config keys that a git call with the token may read.
export const CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...GIT_KEYS,
  ...[...CACHE_CONFIG, ...worktreeConfig("")].map(([k]) => k.toLowerCase()),
]);
// provider.ts gitConfig: the token goes in as an http.extraHeader value, scoped to the server origin.
const TOKEN_KEY = /^http\.(?:.+\.)?extraheader$/i;
// The files of a cache that git reads besides the refs and the objects. A Claude step may change none of them (tasks/gitstate.ts).
export const CACHE_FILES = [
  "config",
  "config.worktree",
  "commondir",
  "HEAD",
  "info/attributes",
  "info/grafts",
  "shallow",
  "objects/info/alternates",
];

// stopped: the time limit or the abort signal killed git. git itself reported no error.
export class GitError extends Error {
  override name = "GitError";
  constructor(
    message: string,
    readonly stopped = false,
  ) {
    super(message);
  }
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Inherited GIT_* variables can name another config, repository, or trace file. git runs SSH_ASKPASS before it reads GIT_TERMINAL_PROMPT.
    if (v === undefined || /^GIT_/i.test(k) || /^SSH_ASKPASS$/i.test(k) || RUNTIME_ENV.test(k)) continue;
    env[k] = v;
  }
  return env;
}

// The env of git in the user's clone (plan r3): the user's own config, identity, signing, and hooks.
export function userGitEnv(): Record<string, string> {
  return { ...baseEnv(), GIT_TERMINAL_PROMPT: "0" };
}

// A path under the empty global config file. No file or folder can exist under a file, so no hook runs and no repository is found.
const underFile = (emptyGlobal: string, name: string) => join(emptyGlobal, name);

// The env of every git child. Only fetch gets extra config, for example the auth header.
// emptyGlobal: an empty file. It replaces ~/.gitconfig and the XDG config, so no user filter, hook, or helper runs.
// The last two keys win over config, so no hook and no fsmonitor of a cache or a worktree runs.
export function gitEnv(emptyGlobal: string, config: [string, string][] = []): Record<string, string> {
  const env = baseEnv();
  const all: [string, string][] = [
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
    ...config,
    ["core.hooksPath", underFile(emptyGlobal, "no-hooks")],
    ["core.fsmonitor", "false"],
  ];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = emptyGlobal;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_COUNT = String(all.length);
  all.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

const carriesToken = (env: Record<string, string>) =>
  Object.entries(env).some(([k, v]) => /^GIT_CONFIG_KEY_\d+$/.test(k) && TOKEN_KEY.test(v));

// The value of --git-dir in args, or undefined.
function gitDirOf(args: string[]): string | undefined {
  const k = args.indexOf("--git-dir");
  if (k >= 0) return args[k + 1];
  return args.find((a) => a.startsWith("--git-dir="))?.slice("--git-dir=".length);
}

// The keys of one config file, from the parser of git. --no-includes reads no other file and lists include.path as a key.
async function configKeys(file: string, plain: Record<string, string>): Promise<string[]> {
  const out = await spawnGit(["config", "--file", file, "--no-includes", "--list", "-z"], { env: plain });
  return out
    .split("\0")
    .filter(Boolean)
    .map((e) => e.split("\n", 1)[0] as string);
}

// docs/plans/review-v2/git-deny.md fix E: the reason to refuse a git call with the token, or null. The call reads only the empty global
// file and, with --git-dir, <dir>/config and <dir>/config.worktree (GIT_CONFIG_NOSYSTEM, --no-includes in the check). The log names the
// key, never its value.
async function foreignConfig(cmd: string, dir: string | undefined, env: Record<string, string>): Promise<string | null> {
  const global = env.GIT_CONFIG_GLOBAL ?? "";
  const st = global ? statSync(global, { throwIfNoEntry: false }) : undefined;
  const refuse = (why: string, logged = why) => {
    log(`Refused git ${cmd} with the server token: ${logged}.`);
    return why;
  };
  if (!st?.isFile() || st.size !== 0) return refuse("the empty global git config of the app is not an empty file");
  if (dir === undefined) return null;
  if (existsSync(join(dir, "commondir"))) return refuse(`${join(dir, "commondir")} exists, and the app never writes it`);
  const plain = { ...baseEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: global, GIT_DIR: underFile(global, "no-repo") };
  for (const f of ["config", "config.worktree"]) {
    const file = join(dir, f);
    if (!existsSync(file)) continue;
    const key = (await configKeys(file, plain)).find((k) => !CONFIG_KEYS.has(k.toLowerCase()));
    if (key === undefined) continue;
    // The error text can reach the UI, where noUrl hides a URL. The subsection of a key can be a URL, so only the log names it.
    const a = key.indexOf(".");
    const b = key.lastIndexOf(".");
    const shown = a === b ? key : `${key.slice(0, a)}.<subsection>.${key.slice(b + 1)}`;
    const what = (k: string) => `${file} holds the key ${k}, which the app does not write`;
    return refuse(`${what(shown)}. The app log names the full key`, what(key));
  }
  return null;
}

// docs/plans/review-v2/git-deny.md fix F: while a Claude step runs on a cache, each app git call on that cache records what it changed.
// The check after the step (tasks/gitstate.ts) then tells the changes of the app from the changes of Claude. app: each changed key of
// cacheState with its new value, or null when the call removed it.
type Watch = { key: string; cache: string; env: Record<string, string>; app: Map<string, string | null> };
const watches = new Set<Watch>();
const pathKey = (p: string) => {
  const r = resolve(p).replaceAll("\\", "/");
  return process.platform === "win32" ? r.toLowerCase() : r;
};
// The cache of a git folder: <cache> for <cache>/worktrees/<name>.
const cacheKey = (dir: string) => pathKey(dir).replace(/\/worktrees\/[^/]+$/, "");

// Call it inside exclusive(), so no app git call runs between the start of the watch and the snapshot.
export function watchCache(cache: string, env: Record<string, string>) {
  const w: Watch = { key: cacheKey(cache), cache, env, app: new Map() };
  watches.add(w);
  return { app: w.app as ReadonlyMap<string, string | null>, stop: () => void watches.delete(w) };
}

// The app maps of the other watches of a cache, so the check of one step records its restore for the steps that run beside it.
export const otherWatches = (cache: string, own: ReadonlyMap<string, string | null>) =>
  [...watches].filter((w) => w.key === cacheKey(cache) && w.app !== own).map((w) => w.app);

function bytesOf(file: string): string | null {
  try {
    return readFileSync(file).toString("base64");
  } catch {
    return null;
  }
}

// The state of a cache: "file <name>" for each of CACHE_FILES with its bytes in base64, and "ref <name>" for each ref with its object.
// files false: the refs only.
export async function cacheState(cache: string, env: Record<string, string>, files = true): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (files)
    for (const f of CACHE_FILES) {
      const b = bytesOf(join(cache, f));
      if (b !== null) out.set(`file ${f}`, b);
    }
  const refs = await spawnGit([`--git-dir=${cache}`, "for-each-ref", "--format=%(objectname) %(refname)"], { env });
  for (const l of refs.split("\n")) {
    const at = l.indexOf(" ");
    if (at > 0) out.set(`ref ${l.slice(at + 1)}`, l.slice(0, at));
  }
  return out;
}

// Adds each key that differs between before and after to app.
export const record = (before: Map<string, string>, after: Map<string, string>, app: Map<string, string | null>) => {
  for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k)) app.set(k, after.get(k) ?? null);
};

// The app git calls in flight per cache, and the check of fix F that holds the cache. A call waits while a check holds its cache. Each
// test and change of a gate runs with no await between them.
type Gate = { calls: number; idle: (() => void)[]; held: Promise<void> | null };
const gates = new Map<string, Gate>();
const gateOf = (key: string) => {
  const g = gates.get(key) ?? { calls: 0, idle: [], held: null };
  gates.set(key, g);
  return g;
};
const drop = (key: string, g: Gate) => {
  if (!g.calls && !g.held && gates.get(key) === g) gates.delete(key);
};

// Runs f when no app git call on the cache is in flight, and holds new calls back until f ends. f may use gitRaw, never git.
export async function exclusive<T>(cache: string, f: () => Promise<T>): Promise<T> {
  const key = cacheKey(cache);
  let g = gateOf(key);
  while (g.held) {
    await g.held;
    g = gateOf(key);
  }
  let release = () => {};
  g.held = new Promise<void>((r) => {
    release = r;
  });
  if (g.calls) await new Promise<void>((r) => g.idle.push(r));
  try {
    return await f();
  } finally {
    g.held = null;
    release();
    drop(key, g);
  }
}

// Returns stdout. A non-zero exit throws a GitError with the stderr tail. signal: an abort kills git.
export async function git(
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; stdin?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  let env = opts.env;
  const dir = gitDirOf(args);
  if (carriesToken(env)) {
    const cmd = args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "";
    const why = await foreignConfig(cmd, dir, env);
    if (why) throw new GitError(`The app did not run git ${cmd}: ${why}. Remove it and try again.`);
    // With no --git-dir, git would read the config of a repository around the cwd.
    if (dir === undefined) env = { ...env, GIT_DIR: underFile(env.GIT_CONFIG_GLOBAL as string, "no-repo") };
  }
  if (dir === undefined) return spawnGit(args, { ...opts, env });
  const key = cacheKey(dir);
  let g = gateOf(key);
  while (g.held) {
    await g.held;
    g = gateOf(key);
  }
  g.calls++;
  try {
    const ws = [...watches].filter((w) => w.key === key);
    const w0 = ws[0];
    if (!w0) return await spawnGit(args, { ...opts, env });
    const before = await cacheState(w0.cache, w0.env).catch(() => null);
    try {
      return await spawnGit(args, { ...opts, env });
    } finally {
      const after = before && (await cacheState(w0.cache, w0.env).catch(() => null));
      if (before && after) for (const w of ws) record(before, after, w.app);
    }
  } finally {
    g.calls--;
    if (!g.calls) for (const f of g.idle.splice(0)) f();
    drop(key, g);
  }
}

// git with no token check, no gate, and no watch record. Only the check of fix F (tasks/gitstate.ts) uses it, inside exclusive().
export const gitRaw = (
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; stdin?: string; timeoutMs?: number; signal?: AbortSignal },
) => spawnGit(args, opts);

async function spawnGit(
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; stdin?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<string> {
  const cmd = args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "";
  const stopped = () =>
    new GitError(`git ${cmd} stopped: ${opts.signal?.aborted ? "the run was cancelled" : "the time limit ran out"}.`, true);
  // Bun.spawn throws an AbortError for a signal that is aborted already.
  if (opts.signal?.aborted) throw stopped();
  const p = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs ?? TIMEOUT_MS,
    killSignal: "SIGKILL",
    ...(opts.signal && { signal: opts.signal }),
  });
  const output = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  // A leftover child can hold the pipes open. It must not block the caller.
  const [out, err] = await Promise.race([output, Bun.sleep(DRAIN_MS).then(() => ["", ""])]);
  if (code !== 0) {
    // Bun gives signalCode only when a signal ended the process: here the time limit (SIGKILL) or the abort (SIGTERM).
    if (p.signalCode !== null) throw stopped();
    throw new GitError(`git ${cmd} failed (exit ${code}): ${err.trim().slice(-STDERR_TAIL)}`);
  }
  return out;
}
