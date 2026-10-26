// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task context API (plan r2 S-JIRA): GET /prs/:id/task-context, POST and DELETE /prs/:id/task-context/:key, PUT /settings/jira.
// Plan r3 S-ATT: the attachment files of a task under /prs/:id/task-context/:key/files/:att, and open-folder.
// Jira gets a request only on a POST here or on a Jira settings save.
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { Hono } from "hono";
import { validator } from "hono/validator";
import {
  type ApiError,
  ATT_ID,
  type AttachmentDto,
  attachmentInput,
  type IssueContext,
  JIRA_KEY,
  jiraSettingsInput,
  MAX_ATTACHMENT_BYTES,
  MAX_PR_ATTACHMENT_BYTES,
  type TaskContextDto,
} from "../../shared/dto";
import type { Live } from "../live";
import { log } from "../log";
import type { ReviewJobs } from "../review/jobs";
import type { Settings } from "../settings";
import { openFolder, RASTER_TYPE, type Raster, rasterOfFile, resolveFile, safeName, sniffFile, store, taskDir } from "./attachments";
import { ContextError, type ContextErrorKind, type ContextSource } from "./source";

// Fixed texts. A Jira answer body never reaches the client. The task routes use them too.
export const FAILED: Record<ContextErrorKind, string> = {
  auth: "Jira rejected the token. Check the Jira settings.",
  forbidden: "Jira refused access to this issue.",
  not_found: "Jira has no such issue, or the token may not see it.",
  redirect: "Jira answered with a redirect. Check the Jira URL in Settings.",
  rate: "Jira is busy. Try again later.",
  server: "Jira failed to answer.",
  shape: "Jira sent an answer in an unknown format.",
  timeout: "Jira did not answer in time.",
  network: "Cannot reach Jira.",
};

// A download names the file, not the issue. The task files use them too.
export const DOWNLOAD_FAILED: Record<ContextErrorKind, string> = {
  ...FAILED,
  forbidden: "Jira refused access to this file.",
  not_found: "Jira has no such file, or the token may not see it.",
  redirect: "Jira sent the file from another address. The app downloads only from the Jira URL.",
  shape: "Jira sent a file of another size. It can be a login page. Check that the token can open attachments.",
};
// Headers of every file answer. Only the image route sets another type.
const FILE_HEADERS = { "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

// RFC 6266 with an RFC 8187 filename*. The quoted name is ASCII only.
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|[%"\\]/g, "_");
  const ext = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

const unconfigured = { error: "Configure the Bitbucket URL and token first." } satisfies ApiError;
const prNotFound = { error: "Pull request not found." } satisfies ApiError;

function parseParams(v: Record<string, string>): ApiError | { id: number; key: string; att: string } {
  const id = Number(v.id);
  if (!Number.isSafeInteger(id) || id <= 0) return { error: "Invalid pull request ID." };
  if (v.key !== undefined && !JIRA_KEY.test(v.key)) return { error: "Invalid task key." };
  if (v.att !== undefined && !ATT_ID.test(v.att)) return { error: "Invalid attachment ID." };
  return { id, key: v.key ?? "", att: v.att ?? "" };
}
// The typed client takes the keys of the validator output as the path parameters.
const params = validator("param", (v: Record<string, string>, c) => {
  const r = parseParams(v);
  return "error" in r ? c.json<ApiError>(r, 400) : { id: r.id, key: r.key };
});
const fileParams = validator("param", (v: Record<string, string>, c) => {
  const r = parseParams(v);
  return "error" in r ? c.json<ApiError>(r, 400) : r;
});

type Row = { key: string; source: "jira"; json: string; fetched_at: number };
type FileRow = {
  att_id: string;
  filename: string;
  size: number;
  file: string;
  sha256: string;
  image: number;
  text: number;
  include: number;
  downloaded_at: number;
};
const FILE_COLUMNS = "att_id, filename, size, file, sha256, image, text, include, downloaded_at";
// task_attachment has no pdf column, so the stored file tells. A missing file is no PDF.
function pdfOf(dataDir: string, file: string): boolean {
  try {
    const path = resolveFile(dataDir, file);
    return path !== null && sniffFile(path) === "pdf";
  } catch {
    return false;
  }
}
const fileDto = (r: FileRow, pdf: boolean): AttachmentDto => ({
  id: r.att_id,
  filename: r.filename,
  size: r.size,
  sha256: r.sha256,
  image: r.image === 1,
  text: r.text === 1,
  pdf,
  include: r.include === 1,
  downloadedAt: r.downloaded_at,
});
const fileRow = (db: Database, pr: number, key: string, att: string) =>
  db
    .query(`SELECT ${FILE_COLUMNS} FROM task_attachment WHERE pr = $pr AND key = $key AND att_id = $att`)
    .get({ pr, key, att }) as FileRow | null;
const toDto = (db: Database, dataDir: string, pr: number, r: Row): TaskContextDto => ({
  ...(JSON.parse(r.json) as IssueContext),
  source: r.source,
  fetchedAt: r.fetched_at,
  files: (
    db
      .query(`SELECT ${FILE_COLUMNS} FROM task_attachment WHERE pr = $pr AND key = $key ORDER BY att_id`)
      .all({ pr, key: r.key }) as FileRow[]
  ).map((f) => fileDto(f, pdfOf(dataDir, f.file))),
});
const isFile = (path: string | null): path is string => {
  try {
    return path !== null && statSync(path).isFile();
  } catch {
    return false;
  }
};
const hasContext = (db: Database, id: number, key: string) =>
  db.query("SELECT 1 FROM task_context WHERE pr = $id AND key = $key").get({ id, key }) !== null;
const hasPr = (db: Database, id: number) => db.query("SELECT 1 FROM pull_request WHERE id = $id").get({ id }) !== null;
const hasTask = (db: Database, pr: number, key: string) =>
  db.query("SELECT 1 FROM pr_task WHERE pr = $pr AND key = $key").get({ pr, key }) !== null;

// openFolder: the tests pass a recorder.
export function createContextRoutes(opts: {
  settings: Settings;
  review: ReviewJobs;
  live: Live;
  openFolder?: (path: string) => Promise<boolean>;
}) {
  const { settings, review, live } = opts;
  const opener = opts.openFolder ?? openFolder;
  // Bytes of the downloads that run, per PR row ID. The PR cap counts them.
  const running = new Map<number, number>();
  // The row and the stored file of an attachment, or null.
  const fileOf = (p: { id: number; key: string; att: string }) => {
    const db = settings.db();
    const row = db && fileRow(db, p.id, p.key, p.att);
    const path = row ? resolveFile(review.dataDir, row.file) : null;
    return row && isFile(path) ? { row, path } : null;
  };
  const noFile = { error: "The file is not downloaded." } satisfies ApiError;
  const noTask = { error: "Fetch the task first." } satisfies ApiError;
  return new Hono()
    .put(
      "/settings/jira",
      validator("json", (v, c) => {
        const r = jiraSettingsInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid Jira settings." }, 400);
      }),
      async (c) => {
        const r = await settings.saveJira(c.req.valid("json"));
        return "status" in r ? c.json<ApiError>({ error: r.error }, r.status) : c.json(r, 200);
      },
    )
    .get("/prs/:id/task-context", params, (c) => {
      const db = settings.db();
      const { id } = c.req.valid("param");
      if (!db || !hasPr(db, id)) return c.json(prNotFound, 404);
      const rows = db.query("SELECT key, source, json, fetched_at FROM task_context WHERE pr = $id ORDER BY key").all({ id }) as Row[];
      return c.json(
        rows.map((r) => toDto(db, review.dataDir, id, r)),
        200,
      );
    })
    .post("/prs/:id/task-context/:key", params, async (c) => {
      const db = settings.db();
      if (!db) return c.json(unconfigured, 409);
      const { id, key } = c.req.valid("param");
      if (!hasPr(db, id)) return c.json(prNotFound, 404);
      if (!hasTask(db, id, key)) return c.json<ApiError>({ error: "This pull request does not name that task." }, 404);
      let source: ContextSource | null;
      try {
        source = await settings.jira();
      } catch {
        return c.json<ApiError>({ error: "Cannot read the Jira CA file." }, 502);
      }
      if (!source) return c.json<ApiError>({ error: "Set up Jira in Settings first." }, 409);
      let issue: IssueContext;
      try {
        issue = await source.fetchIssue(key);
      } catch (e) {
        if (!(e instanceof ContextError)) throw e;
        log(`Jira fetch failed: ${e.message}`);
        return c.json<ApiError>({ error: FAILED[e.kind] }, 502);
      }
      const row: Row = { key, source: "jira", json: JSON.stringify(issue), fetched_at: Date.now() };
      // The PR or its task can go away during the request.
      const stored = db.transaction(() => {
        if (!hasTask(db, id, key)) return false;
        db.query(
          `INSERT INTO task_context (pr, key, source, json, fetched_at) VALUES ($pr, $key, $source, $json, $at)
            ON CONFLICT (pr, key) DO UPDATE SET source = excluded.source, json = excluded.json, fetched_at = excluded.fetched_at`,
        ).run({ pr: id, key, source: row.source, json: row.json, at: row.fetched_at });
        return true;
      })();
      if (!stored) return c.json<ApiError>({ error: "This pull request does not name that task." }, 404);
      live.broadcast("changed", { prs: [id] });
      return c.json(toDto(db, review.dataDir, id, row), 200);
    })
    .delete("/prs/:id/task-context/:key", params, (c) => {
      const db = settings.db();
      if (!db) return c.json(unconfigured, 409);
      const { id, key } = c.req.valid("param");
      // The task_attachment rows go by the foreign key cascade.
      const r = db.query("DELETE FROM task_context WHERE pr = $id AND key = $key").run({ id, key });
      try {
        rmSync(resolveFile(review.dataDir, taskDir(db, id, key)) as string, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        log(`Could not delete the attachments of ${key}. The next start deletes them. ${(e as Error).message}`);
      }
      if (r.changes) live.broadcast("changed", { prs: [id] });
      return c.body(null, 204);
    })
    .post("/prs/:id/task-context/:key/files/:att", fileParams, async (c) => {
      // Downloads one listed attachment of a fetched task. A stored file answers without a request.
      const db = settings.db();
      if (!db) return c.json(unconfigured, 409);
      const p = c.req.valid("param");
      const { id, key, att } = p;
      const task = db.query("SELECT json FROM task_context WHERE pr = $id AND key = $key").get({ id, key }) as { json: string } | null;
      if (!task) return c.json(noTask, 404);
      const meta = (JSON.parse(task.json) as IssueContext).attachments?.find((a) => a.id === att);
      if (!meta) return c.json<ApiError>({ error: "The task lists no such attachment. Fetch the task again." }, 404);
      const old = fileOf(p);
      if (old) return c.json(fileDto(old.row, pdfOf(review.dataDir, old.row.file)), 200);
      if (meta.size > MAX_ATTACHMENT_BYTES)
        return c.json<ApiError>({ error: `The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.` }, 413);
      const { used } = db
        .query("SELECT COALESCE(SUM(size), 0) AS used FROM task_attachment WHERE pr = $id AND NOT (key = $key AND att_id = $att)")
        .get({ id, key, att }) as { used: number };
      if (used + (running.get(id) ?? 0) + meta.size > MAX_PR_ATTACHMENT_BYTES)
        return c.json<ApiError>(
          { error: `The files of this pull request would pass ${MAX_PR_ATTACHMENT_BYTES / 1024 / 1024} MB. Delete files first.` },
          413,
        );
      let source: ContextSource | null;
      try {
        source = await settings.jira();
      } catch {
        return c.json<ApiError>({ error: "Cannot read the Jira CA file." }, 502);
      }
      if (!source) return c.json<ApiError>({ error: "Set up Jira in Settings first." }, 409);
      const jira = source;
      const file = `${taskDir(db, id, key)}/${att}-${safeName(meta.filename)}`;
      running.set(id, (running.get(id) ?? 0) + meta.size);
      let made: Awaited<ReturnType<typeof store>>;
      try {
        made = await store(review.dataDir, file, (write) => jira.download(meta, write));
      } catch (e) {
        if (e instanceof ContextError) {
          log(`Jira download failed: ${e.message}`);
          return c.json<ApiError>({ error: DOWNLOAD_FAILED[e.kind] }, 502);
        }
        if ((e as { code?: unknown }).code === "EEXIST") return c.json<ApiError>({ error: "This file is downloading." }, 409);
        throw e;
      } finally {
        const left = (running.get(id) ?? 0) - meta.size;
        if (left > 0) running.set(id, left);
        else running.delete(id);
      }
      const row: FileRow = {
        att_id: att,
        filename: meta.filename,
        size: meta.size,
        file,
        sha256: made.sha256,
        image: made.image ? 1 : 0,
        text: made.text ? 1 : 0,
        include: 0,
        downloaded_at: Date.now(),
      };
      // The task can go away during the download. mime: the media type that Jira lists, for display only. image and text come
      // from the file bytes.
      const saved = db.transaction(() => {
        if (!hasContext(db, id, key)) return false;
        db.query(
          `INSERT INTO task_attachment (pr, key, att_id, filename, mime, size, file, sha256, image, text, include, downloaded_at)
            VALUES ($pr, $key, $att, $filename, $mime, $size, $file, $sha256, $image, $text, 0, $at)
            ON CONFLICT (pr, key, att_id) DO UPDATE SET filename = excluded.filename, mime = excluded.mime, size = excluded.size,
              file = excluded.file, sha256 = excluded.sha256, image = excluded.image, text = excluded.text, include = 0,
              downloaded_at = excluded.downloaded_at`,
        ).run({
          pr: id,
          key,
          att,
          filename: meta.filename,
          mime: meta.mimeType,
          size: meta.size,
          file,
          sha256: row.sha256,
          image: row.image,
          text: row.text,
          at: row.downloaded_at,
        });
        return true;
      })();
      if (!saved) {
        rmSync(resolveFile(review.dataDir, file) as string, { force: true });
        return c.json(noTask, 404);
      }
      live.broadcast("changed", { prs: [id] });
      return c.json(fileDto(row, made.pdf), 200);
    })
    .get("/prs/:id/task-context/:key/files/:att", fileParams, (c) => {
      // Save: always a download, never shown by the browser.
      const f = fileOf(c.req.valid("param"));
      if (!f) return c.json(noFile, 404);
      return new Response(Bun.file(f.path), {
        headers: {
          ...FILE_HEADERS,
          "Content-Type": "application/octet-stream",
          "Content-Disposition": disposition(safeName(f.row.filename)),
        },
      });
    })
    .get("/prs/:id/task-context/:key/files/:att/image", fileParams, (c) => {
      // Inline view: PNG, JPEG, GIF, and WebP by their first bytes only. The listed media type is never used.
      const f = fileOf(c.req.valid("param"));
      let raster: Raster | null = null;
      try {
        raster = f && rasterOfFile(f.path);
      } catch {}
      if (!f || !raster) return c.json<ApiError>({ error: "The file is not an image." }, 404);
      return new Response(Bun.file(f.path), { headers: { ...FILE_HEADERS, "Content-Type": RASTER_TYPE[raster] } });
    })
    .put(
      "/prs/:id/task-context/:key/files/:att",
      fileParams,
      validator("json", (v, c) => {
        const r = attachmentInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid attachment settings." }, 400);
      }),
      (c) => {
        const db = settings.db();
        if (!db) return c.json(unconfigured, 409);
        const { id, key, att } = c.req.valid("param");
        const row = db
          .query(`UPDATE task_attachment SET include = $include WHERE pr = $id AND key = $key AND att_id = $att RETURNING ${FILE_COLUMNS}`)
          .get({ id, key, att, include: c.req.valid("json").include ? 1 : 0 }) as FileRow | null;
        if (!row) return c.json(noFile, 404);
        live.broadcast("changed", { prs: [id] });
        return c.json(fileDto(row, pdfOf(review.dataDir, row.file)), 200);
      },
    )
    .delete("/prs/:id/task-context/:key/files/:att", fileParams, (c) => {
      const db = settings.db();
      if (!db) return c.json(unconfigured, 409);
      const { id, key, att } = c.req.valid("param");
      const row = db
        .query("DELETE FROM task_attachment WHERE pr = $id AND key = $key AND att_id = $att RETURNING file")
        .get({ id, key, att }) as { file: string } | null;
      if (!row) return c.body(null, 204);
      try {
        rmSync(resolveFile(review.dataDir, row.file) as string, { force: true, maxRetries: 3 });
      } catch (e) {
        log(`Could not delete an attachment file. The next start deletes it. ${(e as Error).message}`);
      }
      live.broadcast("changed", { prs: [id] });
      return c.body(null, 204);
    })
    .post("/prs/:id/task-context/:key/open-folder", params, async (c) => {
      // Opens the task folder, never a file. 501: no file manager. The client then shows the path for Copy.
      const db = settings.db();
      if (!db) return c.json(unconfigured, 409);
      const { id, key } = c.req.valid("param");
      if (!hasContext(db, id, key)) return c.json(noTask, 404);
      const dir = resolveFile(review.dataDir, taskDir(db, id, key)) as string;
      mkdirSync(dir, { recursive: true });
      if (!(await opener(dir))) return c.json({ error: "No file manager opened the folder. Copy the path.", path: dir }, 501);
      return c.body(null, 204);
    });
}
