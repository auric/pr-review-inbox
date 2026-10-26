// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// context/task.md of a run (plan r2 WP0): the imported task text of the PR. The workspace puts the UNTRUSTED banner before it.
// Plan r3 S-ATT: task.md lists every attachment. The included ones go to context/attachments/.
// docs/plans/review-v2/spec.md section 6.17: a Build task has its own files (task_file), with or without a PR.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { oneLine } from "../../shared/consult";
import {
  type AttachmentMeta,
  type IssueContext,
  listedOnly,
  RUN_IMAGE_BYTES,
  RUN_IMAGES,
  RUN_PDF_BYTES,
  RUN_PDF_TOTAL,
  RUN_TEXT_BYTES,
  RUN_TEXT_TOTAL,
} from "../../shared/dto";
import type { AttachmentFile, ContextFile } from "../review/workspace";
import { type Raster, resolveFile, sniffFile } from "./attachments";
import { ATTACHMENT_IMAGE } from "./markdown";

export const TASK_FILE = "task.md";

const SOURCES: Record<string, string> = { jira: "Jira" };
const MB = 1024 * 1024;

type TaskRow = { key: string; source: string; json: string; fetched_at: number };
type FileRow = {
  att_id: string;
  filename: string;
  // The media type that Jira lists, for display only. The kind comes from the file bytes.
  mime: string | null;
  size: number;
  file: string;
  text: number;
  include: number;
};
const FILE_COLUMNS = "att_id, filename, mime, size, file, text, include";

// The section of one issue. lines: the attachment lines. body: the text of a description or a comment.
function issueSection(r: Omit<TaskRow, "json">, i: IssueContext, lines: string[], body: (s: string) => string): string[] {
  const out = [
    `## Task ${r.key}: ${oneLine(i.summary)}`,
    "",
    `- Source: ${SOURCES[r.source] ?? r.source}`,
    `- Status: ${oneLine(i.status ?? "(none)")}`,
    `- Fetched: ${new Date(r.fetched_at).toISOString()}`,
    ...(i.truncated ? ["- The app cut this text at its size limits."] : []),
    "",
    "### Description",
    "",
    body(i.description?.trim() || "(none)"),
    "",
    `### Comments (${i.comments.length} of ${i.commentsTotal})`,
    "",
  ];
  for (const c of i.comments) out.push(`#### ${oneLine(c.author)}, ${oneLine(c.created)}`, "", body(c.body), "");
  if (!i.comments.length) out.push("(none)", "");
  if (lines.length) out.push(`### Attachments (${lines.length})`, "", ...lines, "");
  return out;
}

const attachmentLine = (a: AttachmentMeta, state: string) =>
  `- ${oneLine(a.filename)}: ${a.size} bytes, ${oneLine(a.mimeType ?? "unknown type")}. ${state}`;

type Includer = { attachments: AttachmentFile[]; state: (id: string, d: FileRow | undefined) => string };

// The run caps of one run. state gives the task.md state of one attachment and adds an included file to attachments.
// dataDir: the data folder of the run. null: no attachment is included.
function includer(dataDir: string | null): Includer {
  const attachments: AttachmentFile[] = [];
  let images = 0;
  let textBytes = 0;
  let pdfBytes = 0;
  const state = (id: string, d: FileRow | undefined): string => {
    if (!d) return "Not downloaded.";
    if (!d.include) return "Not included.";
    if (attachments.some((a) => a.name.startsWith(`${id}.`))) return "Not included: another task lists the same file.";
    const src = dataDir === null ? null : resolveFile(dataDir, d.file);
    let kind: Raster | "pdf" | null;
    try {
      if (!src || !existsSync(src)) return "Not included: the file is missing.";
      kind = sniffFile(src);
    } catch {
      return "Not included: the file is missing.";
    }
    let name: string;
    if (kind === "pdf") {
      if (d.size > RUN_PDF_BYTES) return `Not included: PDFs over ${RUN_PDF_BYTES / MB} MB are listed only.`;
      if (pdfBytes + d.size > RUN_PDF_TOTAL) return `Not included: a run gets at most ${RUN_PDF_TOTAL / MB} MB of PDFs.`;
      pdfBytes += d.size;
      name = `${id}.pdf`;
    } else if (kind) {
      if (d.size > RUN_IMAGE_BYTES) return `Not included: images over ${RUN_IMAGE_BYTES / MB} MB are listed only.`;
      if (images === RUN_IMAGES) return `Not included: a run gets at most ${RUN_IMAGES} images.`;
      images++;
      name = `${id}.${kind}`;
    } else if (d.text) {
      const bytes = Math.min(d.size, RUN_TEXT_BYTES);
      if (textBytes + bytes > RUN_TEXT_TOTAL) return `Not included: a run gets at most ${RUN_TEXT_TOTAL / MB} MB of text files.`;
      textBytes += bytes;
      name = `${id}.txt`;
    } else {
      return "Not included: only images, PDFs, and text files go to runs.";
    }
    attachments.push({ name, src, text: kind === null });
    return `Included as ./attachments/${name}${d.size > RUN_TEXT_BYTES && kind === null ? `, cut at ${RUN_TEXT_BYTES / 1024} KB` : ""}.`;
  };
  return { attachments, state };
}

// The task.md section of one issue with its files. The listing comes first, then the downloaded files that it no longer names: a
// refetch can drop a listed file that the user downloaded before. missing: the state of a listed file without a row.
function renderIssue(
  r: Omit<TaskRow, "json">,
  i: IssueContext,
  mine: FileRow[],
  inc: Includer,
  missing?: (a: AttachmentMeta) => string,
): string[] {
  const listed: AttachmentMeta[] = [
    ...(i.attachments ?? []),
    ...mine
      .filter((d) => !i.attachments?.some((a) => a.id === d.att_id))
      .map((d) => ({ id: d.att_id, filename: d.filename, mimeType: d.mime, size: d.size, created: null })),
  ];
  const lines = listed.map((a) => {
    const d = mine.find((x) => x.att_id === a.id);
    return attachmentLine(a, !d && missing ? missing(a) : inc.state(a.id, d));
  });
  const shown = new Map(inc.attachments.filter((a) => !a.text && !a.name.endsWith(".pdf")).map((a) => [a.name.split(".")[0], a.name]));
  // Rows without a format hold plain text.
  const body = (s: string) =>
    i.format === "markdown"
      ? s.replace(ATTACHMENT_IMAGE, (_, name: string, id: string) => {
          const file = shown.get(id);
          return file ? `![${name}](./attachments/${file})` : `(image: ${name})`;
        })
      : s;
  return issueSection(r, i, lines, body);
}

// The task files of a PR run and its attachments for context/attachments/. dataDir: the data folder of the run.
// Without dataDir, no attachment is included.
export function taskContext(db: Database, pr: number, dataDir: string | null): { files: ContextFile[]; attachments: AttachmentFile[] } {
  const rows = db.query("SELECT key, source, json, fetched_at FROM task_context WHERE pr = $pr ORDER BY key").all({ pr }) as TaskRow[];
  if (!rows.length) return { files: [], attachments: [] };
  const downloaded = db
    .query(`SELECT key, ${FILE_COLUMNS} FROM task_attachment WHERE pr = $pr ORDER BY key, att_id`)
    .all({ pr }) as (FileRow & { key: string })[];
  const inc = includer(dataDir);
  const out: string[] = [];
  for (const r of rows)
    out.push(
      ...renderIssue(
        r,
        JSON.parse(r.json) as IssueContext,
        downloaded.filter((d) => d.key === r.key),
        inc,
      ),
    );
  return { files: [{ name: TASK_FILE, text: out.join("\n") }], attachments: inc.attachments };
}

// task.md alone. No attachment is included.
export const taskFiles = (db: Database, pr: number): ContextFile[] => taskContext(db, pr, null).files;

// The task fields that its issue and files need.
export type TaskRef = { id: number; key: string; origin_pr: number | null; issue_json: string | null; created_at: number };

// The issue of a Build task: the fetched text of its origin PR, else the fetch of its create (task.issue_json). null: neither exists.
export function taskIssue(db: Database, t: TaskRef): { row: Omit<TaskRow, "json">; issue: IssueContext } | null {
  if (t.origin_pr !== null) {
    const c = db
      .query("SELECT key, source, json, fetched_at FROM task_context WHERE pr = $pr AND key = $key")
      .get({ pr: t.origin_pr, key: t.key }) as TaskRow | null;
    return c ? { row: c, issue: JSON.parse(c.json) as IssueContext } : null;
  }
  if (t.issue_json === null) return null;
  return { row: { key: t.key, source: "jira", fetched_at: t.created_at }, issue: JSON.parse(t.issue_json) as IssueContext };
}

// task.md of a Build task and its included files (spec.md section 6.17). Every Claude step of the task gets them. A tick downloads a
// file, so a listed file without a row is not ticked, or its listed type and size keep it out of runs.
export function taskFileContext(db: Database, dataDir: string | null, t: TaskRef): { files: ContextFile[]; attachments: AttachmentFile[] } {
  const r = taskIssue(db, t);
  if (!r) return { files: [], attachments: [] };
  const mine = db.query(`SELECT ${FILE_COLUMNS} FROM task_file WHERE task = $task ORDER BY att_id`).all({ task: t.id }) as FileRow[];
  const inc = includer(dataDir);
  const text = renderIssue(r.row, r.issue, mine, inc, (a) => listedOnly(a) ?? "Not included.").join("\n");
  return { files: [{ name: TASK_FILE, text }], attachments: inc.attachments };
}
