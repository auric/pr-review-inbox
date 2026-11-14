// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Jenkins client (part-session.md section 2.15, package C2). The only module that sends requests to Jenkins (BRIEF 3.6).
// GET only. No redirect. No origin other than the configured one. The token never goes into a message, a log line, or a URL.
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 30_000;
// ci-builds.md Layer C: the app keeps at most the last 2 MB of a build log.
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
// A larger whoAmI answer is an error of kind shape.
const MAX_JSON_BYTES = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type JenkinsErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "redirect"
  | "server"
  | "origin"
  | "login"
  | "shape"
  | "timeout"
  | "network";

// message: one fixed sentence for the user. It holds no answer body and no token.
export class JenkinsError extends Error {
  constructor(
    readonly kind: JenkinsErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JenkinsError";
  }
}

export type JenkinsOptions = { baseUrl: string; user: string; token: string; caFile?: string; timeoutMs?: number; maxLogBytes?: number };

// text: the log tail, at most maxLogBytes bytes. size: X-Text-Size of the first answer. start: the byte offset of text in the log.
export type BuildLog = { text: string; size: number; start: number };

// Throws a plain Error for a bad URL scheme, and an fs error with a `code` for an unreadable CA file.
export function createJenkinsClient(opts: JenkinsOptions) {
  const base = new URL(opts.baseUrl);
  // The token must not travel in clear text. Plain http is for the loopback test server only.
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK.has(base.hostname))) {
    throw new Error("The CI server URL must use https.");
  }
  const basePath = `${base.pathname.replace(/\/+$/, "")}/`;
  const ca = opts.caFile ? readFileSync(opts.caFile, "utf8") : undefined;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const cap = opts.maxLogBytes ?? MAX_LOG_BYTES;
  const authorization = `Basic ${Buffer.from(`${opts.user}:${opts.token}`).toString("base64")}`;

  function fail(status: number, path: string, action: string): JenkinsError {
    if (status >= 300 && status < 400)
      return new JenkinsError(
        "redirect",
        "Jenkins answered with a redirect. Use the Jenkins URL that the browser shows after login.",
        status,
      );
    if (status === 401)
      return new JenkinsError(
        "auth",
        "Jenkins rejected the user name or API token. Make a new token in Jenkins and save it again.",
        status,
      );
    if (status === 403)
      return new JenkinsError(
        "forbidden",
        `Jenkins accepted the login, but user ${opts.user} may not ${action} ${path}. Ask a Jenkins admin for Overall/Read and Job/Read.`,
        status,
      );
    if (status === 404) return new JenkinsError("not_found", `Jenkins has no page at ${path}. Check the Jenkins URL.`, status);
    return new JenkinsError("server", `Jenkins failed to answer (HTTP ${status}).`, status);
  }

  // target: a URL on the configured origin. The caller checks it.
  async function get(target: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(target, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { Authorization: authorization, Accept: "*/*" },
        tls: ca ? { ca } : undefined,
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new JenkinsError("timeout", "Jenkins did not answer in time.");
      throw new JenkinsError("network", "Cannot reach Jenkins.");
    }
  }

  // Reads at most max bytes. null: the body is larger.
  async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(chunks);
        bytes += value.byteLength;
        if (bytes > max) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new JenkinsError("timeout", "Jenkins did not answer in time.");
      throw new JenkinsError("network", "Cannot reach Jenkins.");
    }
  }

  return {
    // GET /whoAmI/api/json (ci-builds.md Layer B Settings, integration-check.md CI5). Gives the user name that Jenkins reports.
    async whoAmI(): Promise<{ name: string }> {
      const path = `${basePath}whoAmI/api/json`;
      const res = await get(new URL(path, base.origin), AbortSignal.timeout(timeoutMs));
      if (res.status !== 200) {
        await res.body?.cancel();
        throw fail(res.status, path, "read");
      }
      const shape = new JenkinsError("shape", "Jenkins sent an answer in an unknown format.", res.status);
      const body = await readCapped(res, MAX_JSON_BYTES);
      if (body === null) throw shape;
      let json: { authenticated?: unknown; anonymous?: unknown; name?: unknown };
      try {
        json = JSON.parse(new TextDecoder().decode(body));
      } catch {
        throw shape;
      }
      if (typeof json !== "object" || json === null) throw shape;
      if (json.authenticated !== true || json.anonymous !== false)
        throw new JenkinsError("login", "Jenkins did not accept the login. Check the user name and the API token.", res.status);
      return { name: typeof json.name === "string" ? json.name : opts.user };
    },

    // GET <build URL>logText/progressiveText (ci-builds.md Layer C, integration-check.md CI12, not verified).
    // The first GET uses start=0 and gives X-Text-Size. A log within the cap is that answer. A larger log takes a second GET with
    // start = X-Text-Size - cap. The build URL must lie below the configured base URL.
    async readLog(buildUrl: string): Promise<BuildLog> {
      let build: URL;
      try {
        build = new URL(buildUrl);
      } catch {
        throw new JenkinsError("origin", "The build URL is not a valid URL.");
      }
      if (build.origin !== base.origin || !`${build.pathname}/`.startsWith(basePath) || build.username || build.password)
        throw new JenkinsError("origin", "The build URL is not on the configured CI server. The app reads logs only from there.");
      const path = `${build.pathname.replace(/\/+$/, "")}/logText/progressiveText`;
      const signal = AbortSignal.timeout(timeoutMs);
      const read = async (start: number) => {
        const target = new URL(path, base.origin);
        target.searchParams.set("start", String(start));
        const res = await get(target, signal);
        if (res.status !== 200) {
          await res.body?.cancel();
          throw fail(res.status, path, "read the log at");
        }
        const size = Number(res.headers.get("X-Text-Size") ?? Number.NaN);
        if (!Number.isSafeInteger(size) || size < 0) {
          await res.body?.cancel();
          throw new JenkinsError("shape", "Jenkins sent the log without its size. The app cannot read this build log.", res.status);
        }
        return { res, size };
      };
      const first = await read(0);
      let { res } = first;
      const start = Math.max(0, first.size - cap);
      if (start > 0) {
        await res.body?.cancel();
        res = (await read(start)).res;
      }
      // A server that ignores start sends more than the cap. Its text would be the head of the log, not the tail.
      const bytes = await readCapped(res, cap);
      if (bytes === null) throw new JenkinsError("shape", "Jenkins sent more log text than asked for. The app cannot read this build log.");
      return { text: new TextDecoder().decode(bytes), size: first.size, start };
    },
  };
}

export type JenkinsClient = ReturnType<typeof createJenkinsClient>;
