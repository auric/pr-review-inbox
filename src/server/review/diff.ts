// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The PR diff of the diff viewer (plan r2 S-DIFF). It reads the cache clone that the review runs share.
import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiError,
  DIFF_PAGE_ROWS,
  type DiffFetchNeeded,
  type DiffFileDto,
  type DiffIndexDto,
  type DiffPageDto,
} from "../../shared/dto";
import type { PrRef } from "../../shared/types";
import { type DiffFile, parseDiff } from "./diffmap";
import { git } from "./git";
import { cachePath, diffArgs, type GitRemote, gitSetup, noUrl, syncCache, WorkspaceError } from "./workspace";

const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_LINE = 2000;
const MEMO_SIZE = 4;
// The parsed rows take more memory than the text, so the cap counts text characters.
const MEMO_CHARS = 64 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL = 2_000;
// Plan r2 section 7: syncCache throws these texts when a server head differs from the pinned head.
const MOVED = /^The (?:source|target) head moved/;

export type DiffResult<T> = { status: 200; body: T } | { status: 400 | 404 | 409 | 502; body: ApiError | DiffFetchNeeded };

export type Pr = { ref: PrRef; sourceHead: string; targetHead: string };
export type Cache = { cache: string; env: Record<string, string>; mergeBase: string };

const fail = (status: 400 | 404 | 409 | 502, error: string) => ({ status, body: { error } }) as const;
const fetchNeeded = { status: 409, body: { error: "Get the code first.", fetch: true } } as const;
const tooLarge = fail(409, "The diff is too large to show.");

function prOf(db: Database, id: number): Pr | DiffResult<never> {
  const r = db.query("SELECT project, repo, pr_id, source_head, target_head FROM pull_request WHERE id = $id").get({ id }) as {
    project: string;
    repo: string;
    pr_id: number;
    source_head: string | null;
    target_head: string | null;
  } | null;
  if (!r) return fail(404, "Pull request not found.");
  if (!r.source_head || !r.target_head) return fail(409, "Sync the pull request first.");
  return { ref: { project: r.project, repo: r.repo, id: r.pr_id }, sourceHead: r.source_head, targetHead: r.target_head };
}

// Key: cache, merge base, source head. The newest entry is last. files null: the diff text is over MAX_DIFF_BYTES.
export type MemoEntry = { files: DiffFile[] | null; chars: number };
const memo = new Map<string, MemoEntry>();

// Adds the entry as the newest, then drops the oldest entries until the count and the total characters fit.
export function remember(m: Map<string, MemoEntry>, key: string, entry: MemoEntry, size = MEMO_SIZE, chars = MEMO_CHARS) {
  m.delete(key);
  m.set(key, entry);
  let total = 0;
  for (const e of m.values()) total += e.chars;
  for (const [k, e] of m) {
    if (m.size <= size && total <= chars) break;
    m.delete(k);
    total -= e.chars;
  }
}

// `git diff` with the validator arguments. Returns null when the output is over MAX_DIFF_BYTES.
async function diffText(c: Cache, head: string): Promise<string | null> {
  const p = Bun.spawn(["git", `--git-dir=${c.cache}`, "diff", ...diffArgs, c.mergeBase, head], {
    env: c.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const err = new Response(p.stderr).text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = p.stdout.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    const chunk = r.value;
    size += chunk.byteLength;
    if (size > MAX_DIFF_BYTES) {
      p.kill("SIGKILL");
      await reader.cancel();
      await p.exited;
      return null;
    }
    chunks.push(chunk);
  }
  const code = await p.exited;
  if (code !== 0) throw new Error(`git diff failed (exit ${code ?? p.signalCode}): ${(await err).trim().slice(-STDERR_TAIL)}`);
  return Buffer.concat(chunks).toString("utf8");
}

async function filesOf(c: Cache, head: string): Promise<DiffFile[] | null> {
  const key = `${c.cache}\0${c.mergeBase}\0${head}`;
  const hit = memo.get(key);
  if (hit) {
    remember(memo, key, hit);
    return hit.files;
  }
  const text = await diffText(c, head);
  const files = text === null ? null : parseDiff(text);
  remember(memo, key, { files, chars: text?.length ?? 0 });
  return files;
}

// The cache when its refs hold the PR heads. null: a fetch is needed. Reads only, so it needs no lock.
export async function cachedHeads(dataDir: string, pr: Pr): Promise<Cache | null> {
  if (!existsSync(dataDir)) return null;
  const dir = realpathSync.native(dataDir);
  const cache = cachePath(dir, pr.ref);
  // syncCache writes info/attributes after the last config write of a new cache.
  if (!existsSync(join(cache, "info", "attributes"))) return null;
  const { env } = gitSetup(dir);
  const g = async (args: string[]) => (await git([`--git-dir=${cache}`, ...args], { env })).trim();
  const base = `refs/rl/${pr.ref.id}`;
  const refs = new Map(
    (await g(["for-each-ref", "--format=%(refname) %(objectname)", `${base}/source`, `${base}/target`]))
      .split("\n")
      .map((l) => l.split(" ") as [string, string]),
  );
  if (refs.get(`${base}/source`) !== pr.sourceHead || refs.get(`${base}/target`) !== pr.targetHead) return null;
  return { cache, env, mergeBase: await g(["merge-base", pr.targetHead, pr.sourceHead]) };
}

const toFile = (f: DiffFile): DiffFileDto => {
  let added = 0;
  let removed = 0;
  for (const r of f.rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { path: f.path, oldPath: f.oldPath, binary: f.binary, added, removed, rows: f.rows.length };
};

async function index(c: Cache, pr: Pr): Promise<DiffResult<DiffIndexDto>> {
  const files = await filesOf(c, pr.sourceHead);
  if (!files) return tooLarge;
  return {
    status: 200,
    body: { sourceHead: pr.sourceHead, targetHead: pr.targetHead, mergeBase: c.mergeBase, files: files.map(toFile) },
  };
}

// Git errors name the remote URL. The fetch already replaced the token.
const gitFailure = (e: unknown) => fail(502, noUrl((e as Error).message));

// GET /prs/:id/diff. Reads only the cache.
export async function readDiff(db: Database, dataDir: string, id: number): Promise<DiffResult<DiffIndexDto>> {
  const pr = prOf(db, id);
  if ("status" in pr) return pr;
  try {
    const c = await cachedHeads(dataDir, pr);
    return c ? await index(c, pr) : fetchNeeded;
  } catch (e) {
    return gitFailure(e);
  }
}

// POST /prs/:id/diff/fetch. syncCache holds the cache lock, so a review run can fetch at the same time.
export async function fetchDiff(
  db: Database,
  dataDir: string,
  remote: (ref: PrRef) => Promise<GitRemote>,
  id: number,
): Promise<DiffResult<DiffIndexDto>> {
  const pr = prOf(db, id);
  if ("status" in pr) return pr;
  let r: GitRemote;
  try {
    r = await remote(pr.ref);
  } catch (e) {
    return fail(409, noUrl((e as Error).message));
  }
  try {
    const { cache, env, mergeBase } = await syncCache({ dataDir, pr, remote: r });
    return await index({ cache, env, mergeBase }, pr);
  } catch (e) {
    if (e instanceof WorkspaceError && MOVED.test(e.message)) return fail(409, "The pull request has new commits. Sync first.");
    return gitFailure(e);
  }
}

// GET /prs/:id/diff/file. path: the new path, or the old path of a deleted file.
export async function readDiffPage(
  db: Database,
  dataDir: string,
  id: number,
  path: string,
  start: number,
): Promise<DiffResult<DiffPageDto>> {
  const pr = prOf(db, id);
  if ("status" in pr) return pr;
  let files: DiffFile[] | null;
  try {
    const c = await cachedHeads(dataDir, pr);
    if (!c) return fetchNeeded;
    files = await filesOf(c, pr.sourceHead);
  } catch (e) {
    return gitFailure(e);
  }
  if (!files) return tooLarge;
  const f = files.find((x) => (x.path ?? x.oldPath) === path);
  if (!f) return fail(404, "The file is not in the diff.");
  if (start > 0 && start >= f.rows.length) return fail(400, "Invalid start row.");
  const end = start + DIFF_PAGE_ROWS;
  const rows = f.rows.slice(start, end).map((r) => (r.text.length > MAX_LINE ? { ...r, text: r.text.slice(0, MAX_LINE) } : r));
  return {
    status: 200,
    body: { path: f.path, oldPath: f.oldPath, binary: f.binary, start, next: end < f.rows.length ? end : null, rows },
  };
}
