// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLive, type LiveEvent } from "../../src/server/live";
import { idleOnlyForLive, startServer } from "../../src/server/main";
import { createReviewJobs } from "../../src/server/review/jobs";

const TOKEN = "c".repeat(64);
const live = createLive(20);
const server = startServer({ port: 0, token: TOKEN, live });
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await Bun.sleep(10);
  }
}

test("started server reports hostname 127.0.0.1", () => {
  expect(server.hostname).toBe("127.0.0.1");
});

test("SSE client gets a broadcast and a heartbeat, and abort removes it", async () => {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  const res = await fetch(`${base}/api/live`, { signal: abort.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  await waitFor(() => live.size() === 1);

  live.broadcast("changed", { pr: 1 });
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // The first ping comes at connect. A second ping proves the periodic heartbeat.
  while (!(text.includes("event: changed") && text.split(": ping").length > 2)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  expect(text).toContain('event: changed\ndata: {"pr":1}');
  expect(text).toContain(": ping");

  abort.abort();
  clearTimeout(timeout);
  await waitFor(() => live.size() === 0);
});

// Bun checks idle sockets in 4 s steps, so a 1 s limit closes the socket after about 4 s.
test("a slow API request outlives the idle timeout; the live stream keeps it", async () => {
  const slow = async () => {
    await Bun.sleep(6000);
    return new Response("ok");
  };
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 1, fetch: idleOnlyForLive(slow) });
  const status = (path: string) =>
    fetch(`http://127.0.0.1:${s.port}${path}`).then(
      (r) => r.status,
      (e: Error) => e.message,
    );
  try {
    const [api, stream] = await Promise.all([status("/api/settings"), status("/api/live")]);
    expect(api).toBe(200);
    expect(String(stream)).toContain("ECONNRESET");
  } finally {
    s.stop(true);
  }
}, 20_000);

test("a settings change that closes the database of the runs sends reset, so each tab refetches the runs and run slots", async () => {
  const listeners: (() => void)[] = [];
  const settings = { config: () => null, onSettingsChanged: (fn: () => void) => void listeners.push(fn) } as never;
  const sent: LiveEvent[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "rl-live-reset-"));
  const review = createReviewJobs({ settings, dataDir, live: { ...createLive(), broadcast: (e: LiveEvent) => void sent.push(e) } });
  try {
    expect(sent).toEqual([]);
    for (const fn of listeners) fn();
    expect(sent).toEqual(["reset"]);
  } finally {
    await review.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
