// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Imported task text (plan r2, task context UI): the pure rules. TaskChips.tsx and Brief.tsx hold the requests.
import {
  type AttachmentDto,
  fileOnly,
  JIRA_KEY,
  MAX_ATTACHMENT_BYTES,
  type MetaDto,
  type PrTask,
  RUN_IMAGE_BYTES,
  RUN_PDF_BYTES,
  RUN_TEXT_BYTES,
  type RunDto,
  type TaskContextDto,
} from "../../shared/dto";
import { visitText } from "../pr/threads";

// The issue tracker is the only context source in Release 2. Meta lists it, set up or not. Its id is also the name of its
// SettingsDto field and of its route PUT /api/settings/<id>. null: no tracker, so the UI shows no tracker control.
export type Tracker = { id: TaskContextDto["source"]; name: string; configured: boolean };
export const trackerOf = (meta: MetaDto) => (meta.context[0] as Tracker | undefined) ?? null;

// source null: a fetched task that the PR no longer names. Its text still goes to the review, so the brief shows it with Remove.
export type TaskChip = {
  key: string;
  source: PrTask["source"] | null;
  url: string | null;
  fetched: TaskContextDto | null;
  fetchable: boolean;
};

export function taskChips(tasks: PrTask[], rows: TaskContextDto[], on: boolean): TaskChip[] {
  const fetched = new Map(rows.map((r) => [r.key, r]));
  const out: TaskChip[] = tasks.map((t) => ({
    key: t.key,
    source: t.source,
    url: t.url,
    fetched: fetched.get(t.key) ?? null,
    fetchable: on && JIRA_KEY.test(t.key),
  }));
  const named = new Set(tasks.map((t) => t.key));
  for (const r of rows) if (!named.has(r.key)) out.push({ key: r.key, source: null, url: null, fetched: r, fetchable: false });
  return out;
}

// "Set up" shows only for a PR that names a key in the tracker key format.
export const offerSetup = (tasks: PrTask[], on: boolean) => !on && tasks.some((t) => JIRA_KEY.test(t.key));

// Same order as the server: by key.
export const mergeTask = (rows: TaskContextDto[] | undefined, t: TaskContextDto) =>
  [...(rows ?? []).filter((r) => r.key !== t.key), t].sort((a, b) => (a.key < b.key ? -1 : 1));

// The tracker sends "2026-01-05T09:12:31.000+0000" (REST docs, fixtures). ISO 8601 needs the colon in the offset.
// Other text shows as it is.
export function sourceTime(text: string): string {
  const ms = Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms)
    ? text
    : new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const fetchedText = (t: TaskContextDto, now: number) => `fetched ${visitText(t.fetchedAt, now)}`;

// The server caps and the page limit can leave out comments.
export function commentsText(t: TaskContextDto): string {
  const total = t.commentsTotal;
  if (!total) return "no comments";
  const all = `${total} comment${total === 1 ? "" : "s"}`;
  return t.comments.length === total ? all : `${t.comments.length} of ${all}`;
}

// The AI summary Context row: the tasks that the run read at its start. A run made before Release 3 has no such record.
// For it, the row shows the stored tasks and marks each task fetched after the run started.
export function contextLines(rows: TaskContextDto[], run: RunDto, source: string, now: number): string[] {
  if (run.tasks) return run.tasks.map((t) => `${t.key} from ${source}, fetched ${visitText(t.fetchedAt, now)}`);
  return rows.map((t) =>
    t.fetchedAt > run.startedAt
      ? `${t.key} from ${source}, fetched after this run (${visitText(t.fetchedAt, now)})`
      : `${t.key} from ${source}, ${fetchedText(t, now)}`,
  );
}

// ---------- Attachments (plan r3 UI-ATT) ----------

const KB = 1024;
const MB = KB * KB;

// type: the media type that the task listing names, for display only. listed: Download can get the file.
// A fetch again can drop a file from the listing. A downloaded copy then stays until the user deletes it.
export type AttachmentRow = {
  id: string;
  filename: string;
  size: number;
  type: string | null;
  file: AttachmentDto | null;
  listed: boolean;
};

// The same list and order as task.md (task-file.ts): the listing, then the downloaded files that the listing no longer names.
// t: a fetched task of a PR, or a Build task (TaskDto) with its own files.
export function attachmentRows(t: Pick<TaskContextDto, "attachments" | "files">): AttachmentRow[] {
  const files = new Map(t.files.map((f) => [f.id, f]));
  const listed = t.attachments ?? [];
  const named = new Set(listed.map((a) => a.id));
  return [
    ...listed.map((a) => ({ id: a.id, filename: a.filename, size: a.size, type: a.mimeType, file: files.get(a.id) ?? null, listed: true })),
    ...t.files
      .filter((f) => !named.has(f.id))
      .map((f) => ({ id: f.id, filename: f.filename, size: f.size, type: null, file: f, listed: false })),
  ];
}

export const attachmentsText = (n: number) => (n === 1 ? "1 attachment" : `${n} attachments`);

// Binary units, as the server caps count them. A no-break space keeps the number and the unit on one line.
export function sizeText(bytes: number): string {
  if (bytes < KB) return `${bytes}\u00a0B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / KB;
  let i = 0;
  while (n >= KB && i < units.length - 1) {
    n /= KB;
    i++;
  }
  return `${n < 10 ? Number(n.toFixed(1)) : Math.round(n)}\u00a0${units[i]}`;
}

// A downloaded file has its kind from its bytes. Before the download, only the listed media type can name it.
export function fileKind(r: AttachmentRow): "image" | "text" | "file" {
  if (r.file) return r.file.image ? "image" : r.file.text ? "text" : "file";
  return r.type?.startsWith("image/") ? "image" : r.type?.startsWith("text/") ? "text" : "file";
}

export const typeText = (r: AttachmentRow) =>
  r.type ?? (r.file?.image ? "image" : r.file?.pdf ? "PDF" : r.file?.text ? "text" : "unknown type");

export const canDownload = (r: AttachmentRow) => !r.file && r.listed && r.size <= MAX_ATTACHMENT_BYTES;

// Same rules as task-file.ts: runs get raster images and PDFs up to their caps, and text files. The run caps can still leave one out.
export const includable = (f: AttachmentDto) => fileOnly(f) === null;

export function fileState(r: AttachmentRow): string {
  const f = r.file;
  const gone = r.listed ? "" : " The task no longer lists it.";
  if (!f) return r.size > MAX_ATTACHMENT_BYTES ? `Over ${MAX_ATTACHMENT_BYTES / MB} MB, too large to download.` : `Not downloaded.${gone}`;
  if (f.image && f.size > RUN_IMAGE_BYTES) return `Downloaded. Runs list images over ${RUN_IMAGE_BYTES / MB} MB by name only.${gone}`;
  if (f.pdf && f.size > RUN_PDF_BYTES) return `Downloaded. Runs list PDFs over ${RUN_PDF_BYTES / MB} MB by name only.${gone}`;
  if (!includable(f)) return `Downloaded. Runs list it by name only.${gone}`;
  if (!f.include) return `Downloaded.${gone}`;
  return `Included in runs${f.text && f.size > RUN_TEXT_BYTES ? `, cut at ${RUN_TEXT_BYTES / KB} KB` : ""}.${gone}`;
}

// The routes of S-ATT. GET needs no session header, so a link and an image can use them.
export const saveRoute = (pr: number, key: string, id: string) => `/api/prs/${pr}/task-context/${encodeURIComponent(key)}/files/${id}`;
export const imageRoute = (pr: number, key: string, id: string) => `${saveRoute(pr, key, id)}/image`;

const ATTACHMENT_SRC = /^attachment:([0-9]{1,18})$/;

// The downloaded raster images of a task. The image route serves only these.
export const imageIds = (files: AttachmentDto[]) => files.flatMap((f) => (f.image ? [f.id] : []));

// The Markdown images resolver of a task. Only a downloaded raster image gets a local URL. All else shows its alt text,
// so the browser never sends a request to the tracker.
export function attachmentImages(pr: number, key: string, images: readonly string[]): (src: string) => string | null {
  const ids = new Set(images);
  return (src) => {
    const id = ATTACHMENT_SRC.exec(src)?.[1];
    return id && ids.has(id) ? imageRoute(pr, key, id) : null;
  };
}

export const putFile = (rows: TaskContextDto[] | undefined, key: string, f: AttachmentDto) =>
  rows?.map((t) => (t.key === key ? { ...t, files: [...t.files.filter((x) => x.id !== f.id), f] } : t));

export const dropFile = (rows: TaskContextDto[] | undefined, key: string, id: string) =>
  rows?.map((t) => (t.key === key ? { ...t, files: t.files.filter((x) => x.id !== id) } : t));

// The confirm text of Remove. files: the count of downloaded attachments that the server deletes with the text.
export const removeText = (key: string, files: number) =>
  `The app deletes the stored text of ${key}.${files ? ` It also deletes ${files} downloaded attachment${files === 1 ? "" : "s"}.` : ""}`;
