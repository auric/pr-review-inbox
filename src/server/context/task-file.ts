// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// context/task.md of a run (plan r2 WP0): the imported task text of the PR. The workspace puts the UNTRUSTED banner before it.
// Plan r3 S-ATT: task.md lists every attachment. The included ones go to context/attachments/.
// docs/plans/review-v2/spec.md section 6.17: a Build task has its own files (task_file), with or without a PR.
// spec.md section 6.20.3: a task that builds its Jira sub-tasks also gets context/subtasks.md. The files of a sub-task go to
// context/attachments/<sub-task key>/.
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { oneLine } from "../../shared/consult";
import {
  type AttachmentMeta,
  type IssueContext,
  type IssueLink,
  listedOnly,
  RUN_IMAGE_BYTES,
  RUN_IMAGES,
  RUN_PDF_BYTES,
  RUN_PDF_TOTAL,
  RUN_TEXT_BYTES,
  RUN_TEXT_TOTAL,
} from "../../shared/dto";
import { type FoundItem, foundItem } from "../../shared/task";
import type { AttachmentFile, ContextFile } from "../review/workspace";
import { type Raster, resolveFile, sniffFile } from "./attachments";
import { ATTACHMENT_IMAGE } from "./markdown";

export const TASK_FILE = "task.md";
export const SUBTASKS_FILE = "subtasks.md";

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
  // task_file only: the sub-task key of the file. null: the task key.
  issue?: string | null;
};
const FILE_COLUMNS = "att_id, filename, mime, size, file, text, include";

// The section of one issue. lines: the attachment lines. body: the text of a description or a comment. head: the heading word.
// extra: the lines after the status lines.
function issueSection(
  r: Omit<TaskRow, "json">,
  i: IssueContext,
  lines: string[],
  body: (s: string) => string,
  head = "Task",
  extra: string[] = [],
): string[] {
  const out = [
    `## ${head} ${r.key}: ${oneLine(i.summary)}`,
    "",
    `- Source: ${SOURCES[r.source] ?? r.source}`,
    `- Status: ${oneLine(i.status ?? "(none)")}`,
    `- Fetched: ${new Date(r.fetched_at).toISOString()}`,
    ...(i.truncated ? ["- The app cut this text at its size limits."] : []),
    ...extra,
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

// dir: the folder of the file under ./attachments/, such as "ABC-12/" for a sub-task. "" for the task key.
type Includer = { attachments: AttachmentFile[]; state: (id: string, d: FileRow | undefined, dir?: string) => string };

// The file name of an attachment without its sub-task folder.
const fileOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);

// The run caps of one run. state gives the task.md state of one attachment and adds an included file to attachments.
// dataDir: the data folder of the run. null: no attachment is included.
function includer(dataDir: string | null): Includer {
  const attachments: AttachmentFile[] = [];
  let images = 0;
  let textBytes = 0;
  let pdfBytes = 0;
  const state = (id: string, d: FileRow | undefined, dir = ""): string => {
    if (!d) return "Not downloaded.";
    if (!d.include) return "Not included.";
    if (attachments.some((a) => fileOf(a.name).startsWith(`${id}.`))) return "Not included: another task lists the same file.";
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
    name = `${dir}${name}`;
    attachments.push({ name, src, text: kind === null });
    return `Included as ./attachments/${name}${d.size > RUN_TEXT_BYTES && kind === null ? `, cut at ${RUN_TEXT_BYTES / 1024} KB` : ""}.`;
  };
  return { attachments, state };
}

// The task.md section of one issue with its files. The listing comes first, then the downloaded files that it no longer names: a
// refetch can drop a listed file that the user downloaded before. missing: the state of a listed file without a row. dir: the folder
// of the issue files, as in Includer. head, extra: as in issueSection.
function renderIssue(
  r: Omit<TaskRow, "json">,
  i: IssueContext,
  mine: FileRow[],
  inc: Includer,
  missing?: (a: AttachmentMeta) => string,
  dir = "",
  head = "Task",
  extra: string[] = [],
): string[] {
  const listed: AttachmentMeta[] = [
    ...(i.attachments ?? []),
    ...mine
      .filter((d) => !i.attachments?.some((a) => a.id === d.att_id))
      .map((d) => ({ id: d.att_id, filename: d.filename, mimeType: d.mime, size: d.size, created: null })),
  ];
  const lines = listed.map((a) => {
    const d = mine.find((x) => x.att_id === a.id);
    return attachmentLine(a, !d && missing ? missing(a) : inc.state(a.id, d, dir));
  });
  const shown = new Map(
    inc.attachments.filter((a) => !a.text && !a.name.endsWith(".pdf")).map((a) => [fileOf(a.name).split(".")[0], a.name]),
  );
  // Rows without a format hold plain text.
  const body = (s: string) =>
    i.format === "markdown"
      ? s.replace(ATTACHMENT_IMAGE, (_, name: string, id: string) => {
          const file = shown.get(id);
          return file ? `![${name}](./attachments/${file})` : `(image: ${name})`;
        })
      : s;
  return issueSection(r, i, lines, body, head, extra);
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

// The task fields that its issue and files need. subtasks: 1 when the task builds its Jira sub-tasks.
export type TaskRef = {
  id: number;
  key: string;
  origin_pr: number | null;
  issue_json: string | null;
  created_at: number;
  subtasks?: number;
};

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

// The options of the files of one task run (spec.md section 6.20). keys: the sub-task keys of a part run, which gets the task files and
// the files of these keys only. Absent: the files of every sub-task (the interview and the spec run). searched: the run read the
// branches and PRs of the sub-tasks. notes: the lines of that read.
export type TaskFileOptions = { keys?: readonly string[]; searched?: boolean; notes?: string[] };

// task.md of a Build task and its included files (spec.md section 6.17). Every Claude step of the task gets them. A tick downloads a
// file, so a listed file without a row is not ticked, or its listed type and size keep it out of runs. A task that builds its
// sub-tasks also gets subtasks.md. The run caps count the files of the task and of its sub-tasks together.
export function taskFileContext(
  db: Database,
  dataDir: string | null,
  t: TaskRef,
  o: TaskFileOptions = {},
): { files: ContextFile[]; attachments: AttachmentFile[] } {
  const r = taskIssue(db, t);
  if (!r) return { files: [], attachments: [] };
  const all = db.query(`SELECT ${FILE_COLUMNS}, issue FROM task_file WHERE task = $task ORDER BY att_id`).all({ task: t.id }) as FileRow[];
  const inc = includer(dataDir);
  const missing = (a: AttachmentMeta) => listedOnly(a) ?? "Not included.";
  const text = renderIssue(
    r.row,
    r.issue,
    all.filter((f) => f.issue == null),
    inc,
    missing,
  ).join("\n");
  const files: ContextFile[] = [{ name: TASK_FILE, text }];
  if (t.subtasks === 1) files.push({ name: SUBTASKS_FILE, text: subtasksText(db, t, r.issue, all, inc, o) });
  return { files, attachments: inc.attachments };
}

type SubtaskRow = {
  key: string;
  summary: string;
  status: string | null;
  issue_json: string | null;
  links_json: string;
  found_json: string;
  read_at: number;
};

// The stored found items of a sub-task. An item that fails its schema is left out.
export function foundOf(json: string): FoundItem[] {
  return (JSON.parse(json) as unknown[]).flatMap((x) => {
    const r = foundItem.safeParse(x);
    return r.success ? [r.data] : [];
  });
}

// The found lines of one sub-task (spec.md section 6.20.2).
function foundLines(key: string, items: FoundItem[]): string[] {
  if (!items.length) return [`- Branches and PRs: none names ${key}.`];
  const out = ["- Branches and PRs:"];
  for (const f of items) {
    if (f.kind === "pr") {
      out.push(`  - PR #${f.pr} (${f.state}) from ${oneLine(f.branch)} to ${oneLine(f.target)}: ${oneLine(f.title)}`);
      if (f.changes.length) out.push(`    - Changed paths${f.more ? ` (the first ${f.changes.length})` : ""}:`);
      for (const c of f.changes) out.push(`      - ${oneLine(c)}`);
      continue;
    }
    out.push(`  - Branch ${oneLine(f.name)}, with no PR.${f.error ? ` ${oneLine(f.error)}` : ""}`);
    if (f.subjects.length) out.push("    - Commits:", ...f.subjects.map((x) => `      - ${oneLine(x)}`));
    const stat = f.stat.split("\n").filter((x) => x.trim());
    if (stat.length) out.push("    - Diff stat against the base:", ...stat.map((x) => `      - ${oneLine(x)}`));
  }
  return out;
}

// context/subtasks.md (spec.md section 6.20.1): every stored sub-task in Jira order. A done sub-task has its key, summary, and status
// only. inc: the includer of task.md, so the run caps count all files of the run.
function subtasksText(db: Database, t: TaskRef, parent: IssueContext, all: FileRow[], inc: Includer, o: TaskFileOptions): string {
  const rows = db
    .query("SELECT key, summary, status, issue_json, links_json, found_json, read_at FROM task_subtask WHERE task = $task ORDER BY ord")
    .all({ task: t.id }) as SubtaskRow[];
  const total = parent.subtasks?.length ?? rows.length;
  const out = [
    `# Sub-tasks of ${t.key}`,
    "",
    total > rows.length
      ? `${t.key} has ${total} sub-tasks. The app reads the first ${rows.length}.`
      : `${t.key} has ${rows.length} sub-tasks.`,
    "The task builds one PR per part. A part builds one or more sub-tasks.",
    ...(o.searched ? [] : ["The app searches the branches and PRs of each open sub-task when the plan run starts."]),
    ...(o.notes ?? []).map(oneLine),
    "",
  ];
  // The files of another sub-task stay out of a part run.
  const other: Includer = { attachments: [], state: (_id, d) => (d ? "Not included." : "Not downloaded.") };
  for (const s of rows) {
    if (s.issue_json === null) {
      out.push(`## Sub-task ${s.key}: ${oneLine(s.summary)}`, "", `- Status: ${oneLine(s.status ?? "(none)")}`);
      out.push("- Jira says that it is done, so the app did not read its text.", "");
      continue;
    }
    const links = (JSON.parse(s.links_json) as IssueLink[]).map((l) => `- Link: ${s.key} ${oneLine(l.text)} ${l.key}.`);
    const found = o.searched ? foundLines(s.key, foundOf(s.found_json)) : [];
    const own = !o.keys || o.keys.includes(s.key);
    out.push(
      ...renderIssue(
        { key: s.key, source: "jira", fetched_at: s.read_at },
        JSON.parse(s.issue_json) as IssueContext,
        all.filter((f) => f.issue === s.key),
        own ? inc : other,
        (a) => listedOnly(a) ?? "Not included.",
        `${s.key}/`,
        "Sub-task",
        [...links, ...found],
      ),
    );
  }
  return out.join("\n");
}
