// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

// reset: the database changed, so each tab refetches every query.
export type LiveEvent = "changed" | "events" | "reset";
export type Live = ReturnType<typeof createLive>;

// The heartbeat must stay below the Bun.serve idleTimeout (30 s), or Bun closes the stream.
export function createLive(heartbeatMs = 15_000) {
  const subscribers = new Set<SSEStreamingApi>();

  return {
    size: () => subscribers.size,
    broadcast(event: LiveEvent, data: unknown) {
      const message = { event, data: JSON.stringify(data) };
      for (const stream of subscribers) stream.writeSSE(message).catch(() => subscribers.delete(stream));
    },
    handler: (c: Context) =>
      streamSSE(c, async (stream) => {
        subscribers.add(stream);
        stream.onAbort(() => {
          subscribers.delete(stream);
        });
        // The first ping flushes the headers at once. The Vite dev proxy holds them until the first body bytes.
        while (!stream.aborted) {
          await stream.write(": ping\n\n");
          await stream.sleep(heartbeatMs);
        }
      }),
  };
}
