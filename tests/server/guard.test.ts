// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { createApp } from "../../src/server/app";
import { allowedOrigins, guard } from "../../src/server/guard";
import { createLive } from "../../src/server/live";

const PORT = 7317;
const TOKEN = "a".repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEV_ORIGIN = "http://127.0.0.1:5173";

function guarded(devOrigin?: string) {
  return new Hono()
    .use(guard({ port: PORT, token: TOKEN, devOrigin }))
    .get("/api/thing", (c) => c.json({ ok: true }))
    .post("/api/thing", (c) => c.json({ ok: true }));
}

function req(path: string, headers: Record<string, string>, method = "GET") {
  return new Request(`${ORIGIN}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers } });
}

describe("guard", () => {
  test("wrong Host gives 403", async () => {
    const res = await guarded().request(req("/api/thing", { host: "evil.example:7317" }));
    expect(res.status).toBe(403);
  });

  test("Host with another port gives 403", async () => {
    const res = await guarded().request(req("/api/thing", { host: "127.0.0.1:8080" }));
    expect(res.status).toBe(403);
  });

  test("localhost Host passes", async () => {
    const res = await guarded().request(req("/api/thing", { host: `localhost:${PORT}` }));
    expect(res.status).toBe(200);
  });

  test("foreign Origin gives 403", async () => {
    const res = await guarded().request(req("/api/thing", { origin: "http://evil.example" }));
    expect(res.status).toBe(403);
  });

  test("cross-site API request gives 403", async () => {
    const res = await guarded().request(req("/api/thing", { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
  });

  test("mutation without token gives 403", async () => {
    const res = await guarded().request(req("/api/thing", { origin: ORIGIN }, "POST"));
    expect(res.status).toBe(403);
  });

  test("mutation without Origin gives 403", async () => {
    const res = await guarded().request(req("/api/thing", { "x-rl-session": TOKEN }, "POST"));
    expect(res.status).toBe(403);
  });

  test("mutation with token gives 200", async () => {
    const res = await guarded().request(req("/api/thing", { origin: ORIGIN, "x-rl-session": TOKEN }, "POST"));
    expect(res.status).toBe(200);
  });

  test("stale token gives session_stale", async () => {
    for (const stale of ["b".repeat(64), "short"]) {
      const res = await guarded().request(req("/api/thing", { origin: ORIGIN, "x-rl-session": stale }, "POST"));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("session_stale");
    }
  });

  test("dev origin passes only when configured", async () => {
    const headers = { origin: DEV_ORIGIN, "x-rl-session": TOKEN };
    expect((await guarded().request(req("/api/thing", headers, "POST"))).status).toBe(403);
    expect((await guarded(DEV_ORIGIN).request(req("/api/thing", headers, "POST"))).status).toBe(200);
  });
});

describe("app", () => {
  const app = createApp({ port: PORT, token: TOKEN, live: createLive(), indexHtml: '<meta name="rl-session" content="__RL_SESSION__">' });

  test("cross-site navigation to / passes and gets the token", async () => {
    const res = await app.request(req("/", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`content="${TOKEN}"`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  // Plan pr-view-v4 section 5: a reload or a link at an app URL gets the page. The web app reads the route from the URL.
  test("deep app paths get the page, API paths do not", async () => {
    for (const path of [
      "/needs/PROJ1/sample-repo-2/1001",
      "/mine/~JDOE/sample-repo-1/7?thread=3&file=src/a%20b.ts",
      "/settings/profiles/general",
      "/unknown/x",
    ]) {
      const res = await app.request(req(path, { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain(`content="${TOKEN}"`);
    }
    const api = await app.request(req("/api/missing", {}));
    expect(api.status).toBe(404);
    expect(await api.text()).not.toContain(TOKEN);
  });

  // GHSA-46wx-v44x-9hh2: hono before 4.13.16 let csrf() pass a text/ping POST from <a ping>.
  test("text/ping POST from a foreign Origin gives 403", async () => {
    const ping = (path: string) => req(path, { origin: "http://evil.example", "content-type": "text/ping", "x-rl-session": TOKEN }, "POST");
    expect((await app.request(ping("/api/sync"))).status).toBe(403);
    const bare = new Hono().use(csrf({ origin: allowedOrigins({ port: PORT, token: TOKEN }) })).post("/api/thing", (c) => c.text("ok"));
    expect((await bare.request(ping("/api/thing"))).status).toBe(403);
  });

  test("no response has Access-Control-Allow-Origin", async () => {
    const cases = [
      req("/", {}),
      req("/", { origin: "http://evil.example" }),
      req("/api/thing", { origin: "http://evil.example" }, "POST"),
      req("/api/thing", { origin: ORIGIN, "access-control-request-method": "POST" }, "OPTIONS"),
      req("/api/missing", { origin: ORIGIN }),
      req("/", { host: "evil.example" }),
    ];
    for (const r of cases) {
      const res = await app.request(r);
      for (const name of res.headers.keys()) expect(name.startsWith("access-control-")).toBe(false);
    }
  });
});
