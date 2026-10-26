// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task attachments on disk (plan r3 S-ATT): <dataDir>/attachments/<db stem>/<PR row ID>/<task key>/<attachment ID>-<safe name>.
// task_attachment.file holds the path under <dataDir>/attachments with "/" separators.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, type Dirent, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { log } from "../log";

export const MAX_NAME = 100;
// Files of PRs archived for longer are deleted at start.
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Unicode general categories Cc and Cs (lone surrogates), UAX #9 bidi controls, and the characters that Windows refuses in names.
const UNSAFE = /[\p{Cc}\p{Cs}\p{Bidi_Control}<>:"/\\|?*]/gu;
const TRAIL = /[. ]+$/;
// Windows reserved device names ("Naming Files, Paths, and Namespaces"). Windows ignores an extension after them.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

// Cuts to MAX_NAME code points. The extension stays when it leaves room for one character before it.
function fit(name: string): string {
  const cps = Array.from(name);
  if (cps.length <= MAX_NAME) return name;
  const dot = cps.lastIndexOf(".");
  const ext = dot > 0 && cps.length - dot < MAX_NAME ? cps.slice(dot) : [];
  return cps.slice(0, MAX_NAME - ext.length).join("") + ext.join("");
}

// A file name from a source name: basename, NFC, no unsafe character, no trailing dot or space, no device name, MAX_NAME at most.
export function safeName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  let s = fit(base.normalize("NFC").replace(UNSAFE, "_").replace(TRAIL, "")).replace(TRAIL, "");
  if (DEVICE.test((s.split(".")[0] ?? "").trimEnd())) s = fit(`_${s}`).replace(TRAIL, "");
  return s || "_";
}

export const attachmentsRoot = (dataDir: string) => join(dataDir, "attachments");
// The database file name without .sqlite (config.ts dbPath). Each Bitbucket origin keeps its own folder.
export const dbStem = (db: Database) => basename(db.filename).replace(/\.sqlite$/i, "");
export const taskDir = (db: Database, pr: number, key: string) => `${dbStem(db)}/${pr}/${key}`;
// The files of a Build task (docs/plans/review-v2/spec.md section 6.17). folder: a new random name for each download, because the
// downloads of a new task come before its row exists.
export const taskFileDir = (db: Database, folder: string) => `${dbStem(db)}/tasks/${folder}`;

// The absolute path of rel, or null when it leaves the attachments folder.
export function resolveFile(dataDir: string, rel: string): string | null {
  const root = attachmentsRoot(dataDir);
  const abs = join(root, rel);
  const r = relative(root, abs);
  return r && !r.startsWith("..") && !isAbsolute(r) ? abs : null;
}

export type Raster = "png" | "jpg" | "gif" | "webp";
export const RASTER_TYPE: Record<Raster, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
// The longest pattern: RIFF, 4 bytes of any value, WEBPVP.
const SNIFF_BYTES = 14;

// WHATWG MIME Sniffing, "image type pattern matching algorithm", for the four raster types only.
export function rasterOf(b: Uint8Array): Raster | null {
  const at = (off: number, ...sig: number[]) => sig.every((v, i) => b[off + i] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50)) return "webp";
  return null;
}

// WHATWG MIME Sniffing, "Identifying a resource with an unknown MIME type": the pattern "%PDF-" gives application/pdf.
export const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

// The raster type or "pdf" by the first bytes of the file. Throws when the file cannot be read.
export function sniffFile(path: string): Raster | "pdf" | null {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(SNIFF_BYTES);
    const head = b.subarray(0, readSync(fd, b, 0, SNIFF_BYTES, 0));
    return rasterOf(head) ?? (isPdf(head) ? "pdf" : null);
  } finally {
    closeSync(fd);
  }
}

// The raster type by the first bytes of the file. Throws when the file cannot be read.
export function rasterOfFile(path: string): Raster | null {
  const kind = sniffFile(path);
  return kind === "pdf" ? null : kind;
}

// text: UTF-8 that decodes with fatal errors and has no NUL byte. The source media type is never used.
export type Stored = { sha256: string; image: boolean; text: boolean; pdf: boolean };

// fill passes the bytes to write. They go to <file>.part, which is renamed when fill ends. A failure leaves no file.
// A second store of the same file while one runs fails with the fs code EEXIST.
export async function store(dataDir: string, rel: string, fill: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>) {
  const abs = resolveFile(dataDir, rel);
  if (!abs) throw new Error(`The attachment path leaves the attachments folder: ${rel}`);
  mkdirSync(dirname(abs), { recursive: true });
  const part = `${abs}.part`;
  const fh = await open(part, "wx");
  const hash = createHash("sha256");
  const head = Buffer.alloc(SNIFF_BYTES);
  let headBytes = 0;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let text = true;
  let closed = false;
  let done = false;
  try {
    await fill(async (chunk) => {
      hash.update(chunk);
      if (headBytes < SNIFF_BYTES) headBytes += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(head, headBytes);
      if (text && chunk.includes(0)) text = false;
      if (text) {
        try {
          utf8.decode(chunk, { stream: true });
        } catch {
          text = false;
        }
      }
      for (let at = 0; at < chunk.byteLength; ) at += (await fh.write(chunk, at)).bytesWritten;
    });
    if (text) {
      try {
        utf8.decode();
      } catch {
        text = false;
      }
    }
    closed = true;
    await fh.close();
    renameSync(part, abs);
    done = true;
  } finally {
    if (!closed) await fh.close().catch(() => {});
    if (!done) rmSync(part, { force: true });
  }
  const sniffed = head.subarray(0, headBytes);
  return { sha256: hash.digest("hex"), image: rasterOf(sniffed) !== null, text, pdf: isPdf(sniffed) } satisfies Stored;
}

// Start-up cleanup of the folder of this database: the rows and files of PRs archived over RETENTION_MS ago,
// then every file and folder without a row, .part files included. Other databases keep their folders. The files of a task stay
// while its row stays.
export function sweep(db: Database, dataDir: string, now = Date.now()) {
  db.query(
    "DELETE FROM task_attachment WHERE pr IN (SELECT id FROM pull_request WHERE archived_at IS NOT NULL AND archived_at < $before)",
  ).run({ before: now - RETENTION_MS });
  const keep = new Set<string>();
  for (const { file } of db.query("SELECT file FROM task_attachment UNION ALL SELECT file FROM task_file").all() as { file: string }[]) {
    for (let i = file.indexOf("/"); i > 0; i = file.indexOf("/", i + 1)) keep.add(file.slice(0, i));
    keep.add(file);
  }
  const root = attachmentsRoot(dataDir);
  const walk = (rel: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      // HFS+ gives decomposed names. Safe names are NFC.
      const path = `${rel}/${d.name}`.normalize("NFC");
      if (keep.has(path)) {
        if (d.isDirectory()) walk(path);
        continue;
      }
      try {
        rmSync(join(root, rel, d.name), { recursive: true, force: true });
      } catch (e) {
        log(`Could not delete the attachment ${path}: ${(e as Error).message}`);
      }
    }
  };
  walk(dbStem(db));
}

// Opens the folder in the file manager. false: no file manager, or it failed. explorer.exe exits with 1 also on success.
export async function openFolder(path: string): Promise<boolean> {
  const win = process.platform === "win32";
  const exe = Bun.which(win ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open");
  if (!exe) return false;
  const p = Bun.spawn([exe, path], { stdio: ["ignore", "ignore", "ignore"] });
  if (win) return true;
  // xdg-open can wait for the program that it starts. A program that still runs after 5 s counts as opened.
  return (await Promise.race([p.exited, Bun.sleep(5_000).then(() => 0)])) === 0;
}
