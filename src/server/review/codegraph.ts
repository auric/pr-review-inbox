// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Indexes the run's sanitized repo/ for a picked codegraph MCP server. Never run it in the user's clone.
// codegraph 1.6.2 CLI: `init --yes <path>`, `sync <path>`, `status --json <path>`, `serve --mcp --path <path> --no-watch`.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { childEnv, killTree, type UserMcpEntry } from "./claude";
import { expand, expandAll } from "./user-mcp";
import { gitSetup } from "./workspace";

export const INDEX_TIMEOUT_MS = 120_000;
const DRAIN_MS = 5_000;
const DB = "codegraph.db";
// The executable, a script, or an npm package spec, as in `npx -y @scope/codegraph@1.6.2`.
const EXE = /(?:^|[\\/])codegraph(?:@[^\\/]*)?(?:\.(?:cmd|exe|ps1|bat|js|mjs|cjs))?$/i;
// codegraph reads CODEGRAPH_DIR as the index folder name. An empty value selects the default (directory.js codeGraphDirName).
const DROP = /^(?:GIT_.*|CODEGRAPH_DIR|CODEGRAPH_NO_WATCH)$/i;

// The index of the codegraph token in [command, ...args] when the entry runs `codegraph serve --mcp`, else -1.
export function codegraphIndex(entry: UserMcpEntry): number {
  if (entry.type !== "stdio") return -1;
  const t = [entry.command, ...entry.args];
  const i = t.findIndex((x) => EXE.test(x));
  return i >= 0 && t[i + 1] === "serve" && t.slice(i + 2).includes("--mcp") ? i : -1;
}

// codegraph 1.6.2 npm-shim.js downloads a missing platform bundle from GitHub unless CODEGRAPH_NO_DOWNLOAD is set.
// dist/upgrade/update-check: CODEGRAPH_NO_UPDATE_CHECK or DO_NOT_TRACK turns the update check off.
// The run's entry: the user's command up to `serve`, then a fixed project path. Other serve options of the user drop out.
export function codegraphEntry(entry: Extract<UserMcpEntry, { type: "stdio" }>, repo: string): UserMcpEntry {
  const i = codegraphIndex(entry);
  return {
    type: "stdio",
    command: entry.command,
    args: [...entry.args.slice(0, i + 1), "--mcp", "--path", repo, "--no-watch"],
    env: {
      ...entry.env,
      CODEGRAPH_NO_DAEMON: "1",
      DO_NOT_TRACK: "1",
      CODEGRAPH_NO_UPDATE_CHECK: "1",
      CODEGRAPH_NO_DOWNLOAD: "1",
      CODEGRAPH_DIR: "",
    },
  };
}

export type IndexInput = {
  // A stdio entry for which codegraphIndex is not -1.
  entry: Extract<UserMcpEntry, { type: "stdio" }>;
  repo: string;
  dataDir: string;
  // <dataDir>/cache/codegraph/<project>/<repo>/codegraph.db
  cacheDb: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type Exec = { code: number | null; out: string };

// Builds the index in repo/.codegraph. Returns null on success, else a reason without paths or command text.
export async function indexCodegraph(input: IndexInput): Promise<string | null> {
  const { entry, repo, cacheDb, signal } = input;
  const deadline = Date.now() + (input.timeoutMs ?? INDEX_TIMEOUT_MS);
  const base = childEnv();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...base, ...expandAll(entry.env, base) })) if (!DROP.test(k)) env[k] = v;
  for (const [k, v] of Object.entries(gitSetup(input.dataDir).env)) if (/^GIT_/.test(k)) env[k] = v;
  env.DO_NOT_TRACK = "1";
  env.CODEGRAPH_NO_UPDATE_CHECK = "1";
  env.CODEGRAPH_NO_DOWNLOAD = "1";
  const t = [entry.command, ...entry.args];
  const cmd = t.slice(0, codegraphIndex(entry) + 1).map((x) => expand(x, base));

  let timedOut = false;
  const exec = async (args: string[]): Promise<Exec> => {
    const ms = deadline - Date.now();
    if (ms <= 0) timedOut = true;
    if (ms <= 0 || signal?.aborted) return { code: null, out: "" };
    const p = Bun.spawn([...cmd, ...args], {
      cwd: repo,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      // POSIX: a new process group, so one kill ends the tree.
      detached: process.platform !== "win32",
    });
    const kill = () => void killTree(p.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, ms);
    signal?.addEventListener("abort", kill, { once: true });
    const out = new Response(p.stdout).text().catch(() => "");
    try {
      const code = await p.exited;
      // A leftover child can hold the pipe open.
      const text = await Promise.race([out, Bun.sleep(DRAIN_MS).then(() => "")]);
      return { code: timedOut || signal?.aborted ? null : code, out: text };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    }
  };
  const failed = (what: string) =>
    signal?.aborted
      ? "cancelled"
      : timedOut
        ? `no index in ${Math.round((input.timeoutMs ?? INDEX_TIMEOUT_MS) / 1000)} s`
        : `${what} failed`;

  const dir = join(repo, ".codegraph");
  const db = join(dir, DB);
  const init = async () => {
    rmSync(dir, { recursive: true, force: true });
    return (await exec(["init", "--yes", repo])).code === 0;
  };
  try {
    let ok: boolean;
    if (existsSync(cacheDb)) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      copyFileSync(cacheDb, db);
      // A damaged cache must not block every later run.
      ok = (await exec(["sync", repo])).code === 0 || (!timedOut && !signal?.aborted && (await init()));
    } else ok = await init();
    if (!ok) return failed("codegraph init or sync");

    const s = await exec(["status", "--json", repo]);
    let status: { initialized?: unknown; indexPath?: unknown } = {};
    try {
      status = JSON.parse(s.out);
    } catch {}
    const rel = typeof status.indexPath === "string" ? relative(repo, status.indexPath) : "..";
    if (s.code !== 0 || status.initialized !== true || rel.startsWith("..") || isAbsolute(rel)) return failed("codegraph status");
  } catch {
    return failed("codegraph index");
  }

  // SQLite WAL mode: a WAL file with data means the db file alone is not complete. Skip the cache then.
  const wal = `${db}-wal`;
  if (!existsSync(wal) || statSync(wal).size === 0) {
    // Two parts of one task can index at the same time (spec.md section 6.20.6), so each copy gets its own temp name.
    const tmp = `${cacheDb}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(cacheDb), { recursive: true });
      copyFileSync(db, tmp);
      renameSync(tmp, cacheDb);
    } catch {
      rmSync(tmp, { force: true });
    }
  }
  return null;
}
