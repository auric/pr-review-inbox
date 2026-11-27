// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// HTTP client for Bitbucket Server. The only module that sends requests to the forge.
import { readFileSync } from "node:fs";
import type { z } from "zod";
import { secureUrl } from "../../shared/links";
import type { ForgeErrorInfo, ForgeErrorKind, ListResult } from "../../shared/types";
import { page } from "./schemas";

const TIMEOUT_MS = 30_000;
const MAX_IN_FLIGHT = 2;
const PAGE_LIMIT = 50;
const MAX_PAGES = 200;

// Messages hold only the kind, the status, the system error code, and the endpoint path. Never the token, headers, or response text.
export class ForgeError extends Error implements ForgeErrorInfo {
  constructor(
    readonly kind: ForgeErrorKind,
    readonly endpoint: string,
    readonly status?: number,
    readonly retryAfter?: string,
    readonly code?: string,
  ) {
    super(`${kind}${status ? ` ${status}` : ""}${code ? ` ${code}` : ""}: ${endpoint}`);
    this.name = "ForgeError";
  }
}

// The class name of the first error in a Bitbucket error body, such as "ArgumentValidationException". Only a plain identifier
// goes into the error message.
function exceptionOf(text: string): string | undefined {
  try {
    const name = (JSON.parse(text) as { errors?: { exceptionName?: unknown }[] }).errors?.[0]?.exceptionName;
    const short = typeof name === "string" ? name.slice(name.lastIndexOf(".") + 1) : "";
    return /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(short) ? short : undefined;
  } catch {
    return undefined;
  }
}

export type ClientOptions = { baseUrl: string; token: string; caFile?: string; timeoutMs?: number };

function kindOf(status: number): ForgeErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429 || status === 503) return "rate";
  return "server";
}

export function createClient(opts: ClientOptions) {
  const url = new URL(opts.baseUrl);
  // The token must not travel in clear text. Plain http is for the loopback test server only.
  if (!secureUrl(url)) {
    throw new Error("The Bitbucket URL must use https.");
  }
  const base = opts.baseUrl.replace(/\/+$/, "");
  const ca = opts.caFile ? readFileSync(opts.caFile, "utf8") : undefined;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  let active = 0;
  const waiting: (() => void)[] = [];
  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active < MAX_IN_FLIGHT) active++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await fn();
    } finally {
      // A waiter takes over the slot, so `active` stays the same.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  // One request to a path under the base URL. No retry. Any status other than 2xx throws a ForgeError.
  async function request<T extends z.ZodType>(
    method: "GET" | "POST" | "PUT",
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<{ data: z.infer<T>; headers: Headers }> {
    const endpoint = path.split("?")[0] ?? path;
    return withSlot(async () => {
      let res: Response;
      let text: string;
      try {
        res = await fetch(base + path, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          tls: ca ? { ca } : undefined,
        });
        text = await res.text();
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        // Only an enum-like code such as ECONNRESET or UNABLE_TO_VERIFY_LEAF_SIGNATURE goes into the message.
        const safe = typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
        throw new ForgeError((e as Error).name === "TimeoutError" ? "timeout" : "network", endpoint, undefined, undefined, safe);
      }
      if (res.status < 200 || res.status > 299) {
        throw new ForgeError(
          kindOf(res.status),
          endpoint,
          res.status,
          kindOf(res.status) === "rate" ? (res.headers.get("retry-after") ?? undefined) : undefined,
          res.status >= 400 && res.status < 500 ? exceptionOf(text) : undefined,
        );
      }
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new ForgeError("shape", endpoint, res.status);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new ForgeError("shape", endpoint, res.status);
      return { data: parsed.data, headers: res.headers };
    });
  }

  const get = <T extends z.ZodType>(path: string, schema: T) => request("GET", path, schema);

  // A POST is never repeated. A timeout, a network error, a 5xx, or a 2xx with a bad body can follow an accepted write.
  const post = async <T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.infer<T>> =>
    (await request("POST", path, schema, body)).data;

  // A PUT is never repeated either. The caller reads the state again to learn the outcome.
  const put = async <T extends z.ZodType>(path: string, body: unknown, schema: T): Promise<z.infer<T>> =>
    (await request("PUT", path, schema, body)).data;

  // Reads every page. An error, a bad cursor, or the page cap gives an incomplete result with the items read so far.
  async function list<T extends z.ZodType>(path: string, item: T): Promise<ListResult<z.infer<T>>> {
    const items: z.infer<T>[] = [];
    const schema = page(item);
    const sep = path.includes("?") ? "&" : "?";
    let start = 0;
    for (let i = 0; i < MAX_PAGES; i++) {
      let p: z.infer<typeof schema>;
      try {
        p = (await get(`${path}${sep}limit=${PAGE_LIMIT}&start=${start}`, schema)).data;
      } catch (e) {
        if (e instanceof ForgeError) return { items, complete: false, reason: e.kind, error: e };
        throw e;
      }
      items.push(...p.values);
      if (p.isLastPage) return { items, complete: true };
      if (typeof p.nextPageStart !== "number" || p.nextPageStart <= start) return { items, complete: false, reason: "cursor" };
      start = p.nextPageStart;
    }
    return { items, complete: false, reason: "page_limit" };
  }

  return { get, post, put, list };
}
