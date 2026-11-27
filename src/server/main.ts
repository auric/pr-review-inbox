// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "hono/bun";
import { type AppOptions, createApp } from "./app";
import { BUILD_COMMIT } from "./build";
import { RETENTION_MS, sweep } from "./context/attachments";
import { createLive } from "./live";
import { log } from "./log";
import { createOutbox } from "./publish/outbox";
import { pruneRefs } from "./review/clone";
import { runCodegraphMcp } from "./review/codegraph-mcp";
import { runGitMcp } from "./review/git-mcp";
import { createReviewJobs } from "./review/jobs";
import { clearRunLogs } from "./review/run-rows";
import { createSettings } from "./settings";
import { createSyncEngine } from "./sync/engine";

export const DEFAULT_PORT = 7317;
// scripts/compile.ts embeds dist/web with --asset. Bun puts an asset folder under import.meta.dir by its base name.
const WEB_DIR = BUILD_COMMIT === null ? resolve(import.meta.dir, "../../dist/web") : join(import.meta.dir, "web");

// Bun closes a connection after idleTimeout seconds with no bytes, also while the handler waits. Only the SSE stream keeps the limit.
export const idleOnlyForLive =
  (fetch: (req: Request, srv: Bun.Server<undefined>) => Response | Promise<Response>) => (req: Request, srv: Bun.Server<undefined>) => {
    if (new URL(req.url).pathname !== "/api/live") srv.timeout(req, 0);
    return fetch(req, srv);
  };

export function startServer(opts: Omit<AppOptions, "port"> & { port: number }) {
  let app = createApp(opts);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    // The SSE heartbeat must stay below it.
    idleTimeout: 30,
    fetch: idleOnlyForLive((req, srv) => app.fetch(req, srv)),
  });
  // Port 0 picks a free port. The guard needs the real one.
  if (server.port !== opts.port) app = createApp({ ...opts, port: server.port ?? opts.port });
  return server;
}

// On POSIX, claude runs in its own process group, so a signal to the app does not reach it. A second signal exits at once.
export function stopOnSignals(stop: () => Promise<unknown>, exit: (code: number) => void = (code) => process.exit(code)) {
  let stopping = false;
  const onSignal = () => {
    if (stopping) return exit(1);
    stopping = true;
    stop()
      .catch((e) => log(`Could not stop the active run: ${(e as Error).message}`))
      .finally(() => exit(0));
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, onSignal);
}

// A compiled binary puts extra entries before --git-mcp in argv (U13), so the flag position varies.
// The server key and the codegraph child command follow --codegraph-mcp, so that flag goes first.
const codegraphMcpAt = process.argv.indexOf("--codegraph-mcp");
const gitMcpAt = process.argv.indexOf("--git-mcp");
if (import.meta.main && codegraphMcpAt >= 0) {
  await runCodegraphMcp(process.argv.slice(codegraphMcpAt + 1));
} else if (import.meta.main && gitMcpAt >= 0) {
  await runGitMcp(process.argv.slice(gitMcpAt + 1));
} else if (import.meta.main) {
  const port = Number(process.env.REVIEW_LOOP_PORT ?? DEFAULT_PORT);
  const devOrigin = process.env.REVIEW_LOOP_DEV_ORIGIN;
  const token = process.env.REVIEW_LOOP_SESSION ?? randomBytes(32).toString("hex");
  delete process.env.REVIEW_LOOP_SESSION;

  let indexHtml: string | undefined;
  if (!devOrigin) {
    const index = join(WEB_DIR, "index.html");
    if (!existsSync(index)) {
      console.error(`Missing ${index}. Run "bun run build" first.`);
      process.exit(1);
    }
    indexHtml = readFileSync(index, "utf8");
  }

  const live = createLive();
  const settings = createSettings();
  const sync = createSyncEngine({ settings, live });
  const review = createReviewJobs({ settings, live });
  const outbox = createOutbox({ settings, live });
  // Before the server starts, so no download runs.
  const db = settings.db();
  try {
    if (db) sweep(db, review.dataDir);
  } catch (e) {
    log(`Could not clean up the attachments folder: ${(e as Error).message}`);
  }
  try {
    if (db) clearRunLogs(db, Date.now() - RETENTION_MS);
  } catch (e) {
    log(`Could not clear the run logs of archived pull requests: ${(e as Error).message}`);
  }
  if (db)
    void pruneRefs(db, review.dataDir).catch((e) => log(`Could not delete the refs of closed pull requests: ${(e as Error).message}`));
  try {
    const server = startServer({
      port,
      token,
      devOrigin,
      live,
      settings,
      sync,
      review,
      outbox,
      indexHtml,
      assets: indexHtml === undefined ? undefined : serveStatic({ root: WEB_DIR }),
    });
    console.log(`PR Review Inbox (${BUILD_COMMIT ?? "source"}): http://127.0.0.1:${server.port}/`);
    stopOnSignals(() => review.stop());
    sync.start();
    void review.start();
    outbox.start();
  } catch (err) {
    if ((err as { code?: string }).code === "EADDRINUSE") {
      console.error(`Port ${port} is busy. Stop the other process or set REVIEW_LOOP_PORT.`);
      process.exit(1);
    }
    throw err;
  }
}
