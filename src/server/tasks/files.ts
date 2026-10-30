// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Jira attachments of a Build task (docs/plans/review-v2/spec.md section 6.17): the downloads into the files of the task, the rows
// of task_file, and their DTOs. Jira gets a download request only on the create click and on a tick of a file.
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { type AttachmentDto, type AttachmentMeta, listedOnly, MAX_PR_ATTACHMENT_BYTES } from "../../shared/dto";
import { resolveFile, safeName, store, taskFileDir } from "../context/attachments";
import { DOWNLOAD_FAILED } from "../context/routes";
import { ContextError, type ContextSource } from "../context/source";
import { log } from "../log";

// A downloaded file before its row. file: the path under <dataDir>/attachments. issue: the sub-task key of the file (spec.md section
// 6.20.3), absent for the task key.
export type Fetched = {
  meta: AttachmentMeta;
  file: string;
  sha256: string;
  image: boolean;
  text: boolean;
  pdf: boolean;
  at: number;
  issue?: string;
};

// The words of a failed download for the user. The Jira answer never reaches them.
export class TaskFileError extends Error {}

type Row = {
  att_id: string;
  filename: string;
  size: number;
  file: string;
  sha256: string;
  image: number;
  text: number;
  pdf: number;
  include: number;
  downloaded_at: number;
  issue: string | null;
};

const SQL = {
  list: "SELECT * FROM task_file WHERE task = $task ORDER BY att_id",
  one: "SELECT * FROM task_file WHERE task = $task AND att_id = $att",
  used: "SELECT COALESCE(SUM(size), 0) AS used FROM task_file WHERE task = $task",
  insert: `INSERT INTO task_file (task, att_id, filename, mime, size, file, sha256, image, text, pdf, include, downloaded_at, issue)
    VALUES ($task, $att, $filename, $mime, $size, $file, $sha256, $image, $text, $pdf, 1, $at, $issue)
    ON CONFLICT (task, att_id) DO UPDATE SET filename = excluded.filename, mime = excluded.mime, size = excluded.size,
      file = excluded.file, sha256 = excluded.sha256, image = excluded.image, text = excluded.text, pdf = excluded.pdf, include = 1,
      downloaded_at = excluded.downloaded_at, issue = excluded.issue`,
  include: "UPDATE task_file SET include = $include WHERE task = $task AND att_id = $att",
};

const dto = (r: Row): AttachmentDto => ({
  id: r.att_id,
  filename: r.filename,
  size: r.size,
  sha256: r.sha256,
  image: r.image === 1,
  text: r.text === 1,
  pdf: r.pdf === 1,
  include: r.include === 1,
  downloadedAt: r.downloaded_at,
  ...(r.issue !== null && { issue: r.issue }),
});

export const taskFileDtos = (db: Database, task: number): AttachmentDto[] => (db.query(SQL.list).all({ task }) as Row[]).map(dto);

export function taskFileDto(db: Database, task: number, att: string): AttachmentDto | null {
  const r = db.query(SQL.one).get({ task, att }) as Row | null;
  return r ? dto(r) : null;
}

export const usedBytes = (db: Database, task: number) => (db.query(SQL.used).get({ task }) as { used: number }).used;

// Why the task cannot get these listed files, or null. used: the bytes of the files that the task has. The task cap is the PR cap.
export function pickProblem(list: AttachmentMeta[], used: number): { status: 400 | 413; error: string } | null {
  for (const a of list) {
    const why = listedOnly(a);
    if (why) return { status: 400, error: `${a.filename}: ${why}` };
  }
  if (list.reduce((n, a) => n + a.size, used) > MAX_PR_ATTACHMENT_BYTES)
    return { status: 413, error: `The files of this task would pass ${MAX_PR_ATTACHMENT_BYTES / 1024 / 1024} MB. Untick files first.` };
  return null;
}

// Removes the files of one download call. The next start deletes what stays (attachments.ts sweep).
export function dropFetched(dataDir: string, fetched: Fetched[]) {
  for (const f of fetched)
    try {
      rmSync(resolveFile(dataDir, f.file) as string, { force: true, maxRetries: 3 });
    } catch (e) {
      log(`Could not delete a task file. The next start deletes it. ${(e as Error).message}`);
    }
}

// Downloads the files one after the other into a new folder, so Jira never gets parallel downloads from the app. A failure removes
// the files of this call and throws TaskFileError with the file name. issue: the sub-task key of each file, absent for the task key.
export async function fetchFiles(
  db: Database,
  dataDir: string,
  jira: ContextSource,
  list: (AttachmentMeta & { issue?: string })[],
): Promise<Fetched[]> {
  const folder = taskFileDir(db, crypto.randomUUID());
  const out: Fetched[] = [];
  for (const { issue, ...meta } of list) {
    const file = `${folder}/${meta.id}-${safeName(meta.filename)}`;
    try {
      const made = await store(dataDir, file, (write) => jira.download(meta, write));
      out.push({ meta, file, ...made, at: Date.now(), ...(issue !== undefined && { issue }) });
    } catch (e) {
      dropFetched(dataDir, out);
      if (!(e instanceof ContextError)) throw e;
      log(`Jira download for a task failed: ${e.message}`);
      throw new TaskFileError(`${meta.filename}: ${DOWNLOAD_FAILED[e.kind]}`);
    }
  }
  return out;
}

// The rows of downloaded files, each included. Run it in the transaction of the caller.
export function saveFetched(db: Database, task: number, fetched: Fetched[]) {
  const q = db.query(SQL.insert);
  for (const f of fetched)
    q.run({
      task,
      att: f.meta.id,
      filename: f.meta.filename,
      mime: f.meta.mimeType,
      size: f.meta.size,
      file: f.file,
      sha256: f.sha256,
      image: f.image ? 1 : 0,
      text: f.text ? 1 : 0,
      pdf: f.pdf ? 1 : 0,
      at: f.at,
      issue: f.issue ?? null,
    });
}

export const setInclude = (db: Database, task: number, att: string, include: boolean) =>
  db.query(SQL.include).run({ task, att, include: include ? 1 : 0 }).changes > 0;
