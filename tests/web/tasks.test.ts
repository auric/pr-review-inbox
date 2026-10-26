// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Plan r2 UI-JIRA: the pure task text rules of the brief and the AI summary.
import { describe, expect, test } from "bun:test";
import type { AttachmentDto, MetaDto, PrTask, RunDto, TaskContextDto } from "../../src/shared/dto";
import {
  attachmentImages,
  attachmentRows,
  canDownload,
  commentsText,
  contextLines,
  dropFile,
  fileKind,
  fileState,
  imageIds,
  includable,
  mergeTask,
  offerSetup,
  putFile,
  removeText,
  sizeText,
  sourceTime,
  taskChips,
  trackerOf,
  typeText,
} from "../../src/web/review/tasks";

const task = (key: string, source: PrTask["source"] = "description"): PrTask => ({ key, source, url: null });
const row = (key: string, o: Partial<TaskContextDto> = {}): TaskContextDto => ({
  key,
  summary: `Summary of ${key}`,
  status: "In Progress",
  description: "Text",
  comments: [],
  commentsTotal: 0,
  truncated: false,
  source: "jira",
  fetchedAt: 1_000,
  files: [],
  ...o,
});
const meta = (context: MetaDto["context"]) => ({ context }) as MetaDto;

describe("taskChips", () => {
  test("offers Fetch only for Jira-format keys while Jira is set up", () => {
    const tasks = [task("ABC-42"), task("abc-1"), task("ABC-0", "branch")];
    expect(taskChips(tasks, [], true).map((c) => [c.key, c.fetchable])).toEqual([
      ["ABC-42", true],
      ["abc-1", false],
      ["ABC-0", false],
    ]);
    expect(taskChips(tasks, [], false).some((c) => c.fetchable)).toBe(false);
  });

  test("joins fetched rows, and keeps a fetched task that the PR no longer names", () => {
    const chips = taskChips([task("ABC-42")], [row("ABC-42"), row("OLD-7")], true);
    expect(chips.map((c) => [c.key, c.source, c.fetched?.key ?? null, c.fetchable])).toEqual([
      ["ABC-42", "description", "ABC-42", true],
      ["OLD-7", null, "OLD-7", false],
    ]);
  });
});

test("offerSetup needs a Jira-format key and no Jira source", () => {
  expect(offerSetup([task("ABC-42")], false)).toBe(true);
  expect(offerSetup([task("ABC-42")], true)).toBe(false);
  expect(offerSetup([task("abc-42")], false)).toBe(false);
  expect(offerSetup([], false)).toBe(false);
});

test("the tracker comes from meta, set up or not, and is absent without a meta entry", () => {
  expect(trackerOf(meta([]))).toBeNull();
  const off = { id: "jira" as const, name: "Jira", configured: false };
  expect(trackerOf(meta([off]))).toEqual(off);
  expect(trackerOf(meta([{ ...off, configured: true }]))?.configured).toBe(true);
});

test("mergeTask replaces the row of the key and keeps the key order", () => {
  const out = mergeTask([row("ABC-1"), row("ABC-9", { fetchedAt: 1 })], row("ABC-9", { fetchedAt: 2 }));
  expect(out.map((r) => [r.key, r.fetchedAt])).toEqual([
    ["ABC-1", 1_000],
    ["ABC-9", 2],
  ]);
  expect(mergeTask(undefined, row("ABC-5")).map((r) => r.key)).toEqual(["ABC-5"]);
  expect(mergeTask([row("ABC-7")], row("ABC-3")).map((r) => r.key)).toEqual(["ABC-3", "ABC-7"]);
});

test("commentsText names a cut comment list", () => {
  const c = { author: "A", created: "", body: "" };
  expect(commentsText(row("A-1"))).toBe("no comments");
  expect(commentsText(row("A-1", { comments: [c], commentsTotal: 1 }))).toBe("1 comment");
  expect(commentsText(row("A-1", { comments: [c, c], commentsTotal: 3 }))).toBe("2 of 3 comments");
});

test("sourceTime reads the Jira offset form and keeps other text", () => {
  const jira = sourceTime("2026-01-05T09:12:31.000+0000");
  expect(jira).toBe(sourceTime("2026-01-05T09:12:31.000Z"));
  expect(jira).toContain("2026");
  expect(sourceTime("last Tuesday")).toBe("last Tuesday");
  expect(sourceTime("")).toBe("");
});

test("contextLines shows the tasks of the run; a run without that record marks a task fetched after the run started", () => {
  const now = new Date(2026, 9, 11, 15, 0).getTime();
  const at = (h: number, m: number) => new Date(2026, 9, 11, h, m).getTime();
  const rows = [row("ABC-1", { fetchedAt: at(13, 5) }), row("ABC-2", { fetchedAt: at(14, 30) })];
  const old = { startedAt: at(14, 0) } as RunDto;
  expect(contextLines(rows, old, "Jira", now)).toEqual([
    "ABC-1 from Jira, fetched today 13:05",
    "ABC-2 from Jira, fetched after this run (today 14:30)",
  ]);
  expect(contextLines([], old, "Jira", now)).toEqual([]);
  // The run read ABC-3, which is removed now. ABC-2 came after the run.
  const run = { startedAt: at(14, 0), tasks: [{ key: "ABC-3", fetchedAt: at(12, 0) }] } as RunDto;
  expect(contextLines(rows, run, "Jira", now)).toEqual(["ABC-3 from Jira, fetched today 12:00"]);
  expect(contextLines(rows, { ...run, tasks: [] }, "Jira", now)).toEqual([]);
});

// ---------- Attachments (plan r3 UI-ATT) ----------

const MB = 1024 * 1024;
const listed = (id: string, filename: string, size: number, mimeType: string | null = null) => ({
  id,
  filename,
  size,
  mimeType,
  created: null,
});
const file = (id: string, o: Partial<AttachmentDto> = {}): AttachmentDto => ({
  id,
  filename: `f${id}`,
  size: 2048,
  sha256: "0".repeat(64),
  image: false,
  text: false,
  pdf: false,
  include: false,
  downloadedAt: 1,
  ...o,
});

test("attachmentRows lists the listing, then the downloaded files that the listing no longer names", () => {
  const t = row("ABC-42", {
    attachments: [listed("10100", "screenshot.png", 2048, "image/png"), listed("10101", "sync-worker.log", 512, "text/plain")],
    files: [file("10101", { filename: "sync-worker.log", size: 512, text: true }), file("9", { filename: "old.zip" })],
  });
  expect(attachmentRows(t).map((r) => [r.id, r.filename, r.type, r.file?.id ?? null, r.listed])).toEqual([
    ["10100", "screenshot.png", "image/png", null, true],
    ["10101", "sync-worker.log", "text/plain", "10101", true],
    ["9", "old.zip", null, "9", false],
  ]);
  // A row from before Release 3 has neither field.
  expect(attachmentRows(row("ABC-1"))).toEqual([]);
});

test("sizeText uses binary units with one decimal below 10", () => {
  expect([0, 512, 1023, 1024, 1536, 2048, 10 * 1024, 1023 * 1024, MB, 5.25 * MB, 100 * MB, 3 * 1024 * MB].map(sizeText)).toEqual(
    ["0 B", "512 B", "1023 B", "1 KB", "1.5 KB", "2 KB", "10 KB", "1023 KB", "1 MB", "5.3 MB", "100 MB", "3 GB"].map((t) =>
      t.replace(" ", "\u00a0"),
    ),
  );
});

test("the kind of a downloaded file comes from its bytes, before that from the listed type", () => {
  const r = (type: string | null, f: AttachmentDto | null) => ({ id: "1", filename: "x", size: 1, type, file: f, listed: true });
  expect(fileKind(r("image/png", null))).toBe("image");
  expect(fileKind(r("text/plain", null))).toBe("text");
  expect(fileKind(r(null, null))).toBe("file");
  // An HTML page with an image name is no image.
  expect(fileKind(r("image/png", file("1")))).toBe("file");
  expect(fileKind(r(null, file("1", { text: true })))).toBe("text");
  expect(typeText(r(null, file("1", { image: true })))).toBe("image");
  expect(typeText(r(null, file("1")))).toBe("unknown type");
  expect(typeText(r("application/zip", file("1")))).toBe("application/zip");
});

test("fileState names the download and run state in words", () => {
  const r = (o: { size?: number; file?: AttachmentDto | null; listed?: boolean }) => ({
    id: "1",
    filename: "x",
    size: o.size ?? 2048,
    type: null,
    file: o.file ?? null,
    listed: o.listed ?? true,
  });
  expect(fileState(r({}))).toBe("Not downloaded.");
  expect(fileState(r({ size: 100 * MB + 1 }))).toBe("Over 100 MB, too large to download.");
  expect(canDownload(r({ size: 100 * MB + 1 }))).toBe(false);
  expect(canDownload(r({ size: 100 * MB }))).toBe(true);
  expect(canDownload(r({ listed: false }))).toBe(false);
  expect(canDownload(r({ file: file("1") }))).toBe(false);
  expect(fileState(r({ file: file("1", { image: true }) }))).toBe("Downloaded.");
  expect(fileState(r({ file: file("1", { image: true, include: true }) }))).toBe("Included in runs.");
  expect(fileState(r({ file: file("1", { image: true, size: 5 * MB + 1, include: true }) }))).toBe(
    "Downloaded. Runs list images over 5 MB by name only.",
  );
  expect(fileState(r({ file: file("1", { text: true, size: 300 * 1024, include: true }) }))).toBe("Included in runs, cut at 256 KB.");
  expect(fileState(r({ file: file("1", { include: true }) }))).toBe("Downloaded. Runs list it by name only.");
  expect(fileState(r({ file: file("1", { text: true }), listed: false }))).toBe("Downloaded. The task no longer lists it.");
  expect(includable(file("1", { image: true, size: 5 * MB }))).toBe(true);
  expect(includable(file("1", { image: true, size: 5 * MB + 1 }))).toBe(false);
  expect(includable(file("1", { text: true, size: 50 * MB }))).toBe(true);
  expect(includable(file("1"))).toBe(false);
  // docs/plans/review-v2/spec.md section 6.17: a PDF goes to runs up to 5 MB.
  expect(includable(file("1", { pdf: true, size: 5 * MB }))).toBe(true);
  expect(includable(file("1", { pdf: true, size: 5 * MB + 1 }))).toBe(false);
  expect(fileState(r({ file: file("1", { pdf: true, include: true }) }))).toBe("Included in runs.");
  expect(fileState(r({ file: file("1", { pdf: true, size: 5 * MB + 1 }) }))).toBe("Downloaded. Runs list PDFs over 5 MB by name only.");
  expect(typeText({ id: "1", filename: "x", size: 1, type: null, file: file("1", { pdf: true }), listed: true })).toBe("PDF");
});

test("the images resolver maps only a downloaded raster image to the local image route", () => {
  const ids = imageIds([file("10100", { image: true }), file("10101", { text: true })]);
  expect(ids).toEqual(["10100"]);
  const images = attachmentImages(7, "ABC-42", ids);
  expect(images("attachment:10100")).toBe("/api/prs/7/task-context/ABC-42/files/10100/image");
  // Not an image, not downloaded, a tracker URL, a relative path, or a bad ID: the alt text shows.
  for (const src of [
    "attachment:10101",
    "attachment:10102",
    "https://jira.example.test/secure/attachment/10100/screenshot.png",
    "/secure/thumbnail/10100/_thumb_10100.png",
    "attachment:10100/../x",
    "attachment:",
  ])
    expect(images(src)).toBeNull();
  expect(attachmentImages(7, "ABC-42", [])("attachment:10100")).toBeNull();
});

test("putFile and dropFile change the files of one task only", () => {
  const rows = [row("ABC-1", { files: [file("1")] }), row("ABC-2")];
  const put = putFile(rows, "ABC-1", file("1", { include: true }));
  expect(put?.[0]?.files).toEqual([file("1", { include: true })]);
  expect(put?.[1]).toBe(rows[1] as TaskContextDto);
  expect(putFile(rows, "ABC-2", file("5"))?.[1]?.files).toEqual([file("5")]);
  expect(dropFile(rows, "ABC-1", "1")?.[0]?.files).toEqual([]);
  expect(putFile(undefined, "ABC-1", file("1"))).toBeUndefined();
});

test("removeText names the attachments only when the task has some", () => {
  expect(removeText("ABC-1", 0)).toBe("The app deletes the stored text of ABC-1.");
  expect(removeText("ABC-1", 1)).toBe("The app deletes the stored text of ABC-1. It also deletes 1 downloaded attachment.");
  expect(removeText("ABC-1", 3)).toBe("The app deletes the stored text of ABC-1. It also deletes 3 downloaded attachments.");
});
