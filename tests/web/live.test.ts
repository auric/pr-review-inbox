// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { QueryClient, type QueryKey, QueryObserver } from "@tanstack/react-query";
import { applyLive, changedFilters, connectLive, diffRefresh, type LiveEnv, liveEvents } from "../../src/web/live";

const KEYS: QueryKey[] = [
  ["prs"],
  ["pr", 1],
  ["pr", 1, "diff"],
  ["pr", 1, "diff", "src/a.ts", 0],
  ["pr", 2],
  ["pr", 2, "diff"],
  ["brief", 1],
];

// The keys that the filters mark stale in a cache that holds every key of KEYS.
async function stale(filters: Parameters<QueryClient["invalidateQueries"]>[0][], index: unknown = { files: [] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  for (const k of KEYS) qc.setQueryData(k, k.length === 3 && k[2] === "diff" ? index : {});
  for (const f of filters) await qc.invalidateQueries(f);
  return KEYS.filter((k) => qc.getQueryState(k)?.isInvalidated).map((k) => JSON.stringify(k));
}

describe("live event keys", () => {
  test("a read or sync event of a PR never touches its diff keys", async () => {
    expect(await stale(changedFilters({ prs: [1] }))).toEqual(['["prs"]', '["pr",1]', '["brief",1]']);
  });

  test("a PR event refetches a diff index that asks for the code", async () => {
    expect(await stale(changedFilters({ prs: [1] }), { fetch: true })).toContain('["pr",1,"diff"]');
  });

  test("a change during the first load of a query sends a new request, because the request out can be older than the change", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const answers: ((v: string) => void)[] = [];
    const queryFn = () => new Promise<string>((r) => answers.push(r));
    const stop = new QueryObserver(qc, { queryKey: ["pr", 1], queryFn }).subscribe(() => {});
    try {
      expect(answers).toHaveLength(1);
      applyLive(qc, { type: "changed", data: { prs: [1] } });
      expect(answers).toHaveLength(2);
      answers[0]?.("before the change");
      answers[1]?.("after the change");
      await settle();
      expect(qc.getQueryData<string>(["pr", 1])).toBe("after the change");
      expect(qc.getQueryState(["pr", 1])?.status).toBe("success");
    } finally {
      stop();
    }
  });

  test("a source head change refetches the diff index and pages of that PR only", async () => {
    const f = diffRefresh(1, "aaa", "bbb");
    expect(f).not.toBeNull();
    expect(await stale(f ? [f] : [])).toEqual(['["pr",1,"diff"]', '["pr",1,"diff","src/a.ts",0]']);
  });

  test("a task event refetches the task list and that task only, never the PR list (spec.md section 6.11)", () => {
    const keys = changedFilters({ tasks: [3] }).map((f) => JSON.stringify(f.queryKey));
    expect(keys).toEqual(['["tasks"]', '["task",3]']);
    // A task run event names the run and the task.
    expect(changedFilters({ prs: [], runs: [9], tasks: [3] }).map((f) => JSON.stringify(f.queryKey))).toEqual([
      '["tasks"]',
      '["task",3]',
      '["runs"]',
      '["run",9]',
    ]);
  });

  test("the first head and an equal head refetch no diff", () => {
    expect(diffRefresh(1, undefined, "aaa")).toBeNull();
    expect(diffRefresh(1, "aaa", "aaa")).toBeNull();
    expect(diffRefresh(1, "aaa", undefined)).toBeNull();
  });
});

const SLOTS = '["runs","slots"]';
const ASKS = '["pr",1,"asks"]';

// Observers of the run slots and of the Ask answers of PR 1. Each request waits until the test answers it.
function views() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  const calls: string[] = [];
  const out: { ok: () => void; fail: () => void }[] = [];
  const stops = [
    ["runs", "slots"],
    ["pr", 1, "asks"],
  ].map((queryKey) =>
    new QueryObserver(qc, {
      queryKey,
      initialData: "before",
      queryFn: () =>
        new Promise<string>((resolve, reject) => {
          calls.push(JSON.stringify(queryKey));
          out.push({ ok: () => resolve("after"), fail: () => reject(new Error("down")) });
        }),
    }).subscribe(() => {}),
  );
  return {
    qc,
    calls,
    out,
    stop: () => {
      for (const s of stops) s();
    },
  };
}

describe("live event order", () => {
  test("a run start or end refetches the views of its PR only after the run slots", async () => {
    const v = views();
    try {
      applyLive(v.qc, { type: "changed", data: { prs: [1], runs: [9] } });
      await settle();
      expect(v.calls).toEqual([SLOTS]);
      v.out[0]?.ok();
      await settle();
      expect(v.calls).toEqual([SLOTS, ASKS]);
    } finally {
      v.stop();
    }
  });

  test("a log update during the wait sends a new slots request, and the views wait for its answer", async () => {
    const v = views();
    try {
      applyLive(v.qc, { type: "changed", data: { prs: [1], runs: [9] } });
      applyLive(v.qc, { type: "changed", data: { runs: [9] } });
      await settle();
      expect(v.calls).toEqual([SLOTS, SLOTS]);
      // The answer of the cancelled request.
      v.out[0]?.ok();
      await settle();
      expect(v.calls).toEqual([SLOTS, SLOTS]);
      v.out[1]?.ok();
      await settle();
      expect(v.calls).toEqual([SLOTS, SLOTS, ASKS]);
    } finally {
      v.stop();
    }
  });

  test("a failed slots request still refetches the views", async () => {
    const v = views();
    try {
      applyLive(v.qc, { type: "changed", data: { prs: [1], runs: [9] } });
      await settle();
      v.out[0]?.fail();
      await settle();
      expect(v.calls).toEqual([SLOTS, ASKS]);
    } finally {
      v.stop();
    }
  });

  test("a PR event without runs refetches its views at once", async () => {
    const v = views();
    try {
      applyLive(v.qc, { type: "changed", data: { prs: [1] } });
      expect(v.calls).toEqual([ASKS]);
    } finally {
      v.stop();
    }
  });
});

// One exclusive lock with the ifAvailable and signal options of the Web Locks API.
function fakeLocks() {
  let held = false;
  const queue: (() => void)[] = [];
  const request = async (_name: string, opts: LockOptions, cb: (lock: unknown) => Promise<unknown>) => {
    if (held && opts.ifAvailable) return cb(null);
    if (held)
      await new Promise<void>((resolve, reject) => {
        queue.push(resolve);
        opts.signal?.addEventListener("abort", () => {
          queue.splice(queue.indexOf(resolve), 1);
          reject(new Error("AbortError"));
        });
      });
    held = true;
    try {
      return await cb({});
    } finally {
      held = false;
      queue.shift()?.();
    }
  };
  return { request } as unknown as LiveEnv["locks"];
}

class FakeSource extends EventTarget {
  closed = false;
  emit(type: string, data?: string) {
    this.dispatchEvent(new MessageEvent(type, { data }));
  }
  close() {
    this.closed = true;
  }
}

// Tabs that share one lock manager and one broadcast channel name.
function tabs() {
  const locks = fakeLocks();
  const channels: { onmessage: ((e: MessageEvent) => unknown) | null; closed: boolean }[] = [];
  const sources: FakeSource[] = [];
  const open = (useLocks = true) => {
    const calls: unknown[] = [];
    const ch = {
      onmessage: null as ((e: MessageEvent) => unknown) | null,
      closed: false,
      postMessage(m: unknown) {
        for (const o of channels) if (o !== ch && !o.closed) queueMicrotask(() => o.onmessage?.(new MessageEvent("message", { data: m })));
      },
      close() {
        ch.closed = true;
      },
    };
    channels.push(ch);
    const env: LiveEnv = {
      source: () => {
        const s = new FakeSource();
        sources.push(s);
        return s as unknown as EventSource;
      },
      locks: useLocks ? locks : undefined,
      channel: ch as unknown as LiveEnv["channel"],
    };
    const close = connectLive(
      { invalidateQueries: (f?: unknown) => void calls.push(f ?? "all"), cancelQueries: async () => {} } as never,
      env,
    );
    return { calls, close };
  };
  return { open, sources };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("live stream shared by tabs", () => {
  test("three tabs open one stream, and each change and event reaches every tab", async () => {
    const t = tabs();
    const all = [t.open(), t.open(), t.open()];
    await settle();
    expect(t.sources).toHaveLength(1);
    let events = 0;
    const count = () => events++;
    liveEvents.addEventListener("events", count);
    try {
      const s = t.sources[0] as FakeSource;
      s.emit("open");
      s.emit("changed", JSON.stringify({ prs: [7] }));
      s.emit("events");
      await settle();
      for (const tab of all)
        expect(tab.calls).toEqual(changedFilters({ prs: [7] }).map((f) => expect.objectContaining({ queryKey: f.queryKey })));
      expect(events).toBe(3);
    } finally {
      liveEvents.removeEventListener("events", count);
      for (const tab of all) tab.close();
    }
  });

  test("when the owner closes, the next tab opens the stream and every open tab refetches everything", async () => {
    const t = tabs();
    const [a, b, c] = [t.open(), t.open(), t.open()];
    await settle();
    a.close();
    await settle();
    expect(t.sources).toHaveLength(2);
    expect(t.sources[0]?.closed).toBe(true);
    t.sources[1]?.emit("open");
    await settle();
    expect(b.calls).toEqual(["all"]);
    expect(c.calls).toEqual(["all"]);
    expect(a.calls).toEqual([]);
    b.close();
    c.close();
    await settle();
    expect(t.sources.every((s) => s.closed)).toBe(true);
  });

  test("without the Web Locks API each tab opens its own stream", async () => {
    const t = tabs();
    const all = [t.open(false), t.open(false)];
    await settle();
    expect(t.sources).toHaveLength(2);
    for (const tab of all) tab.close();
  });
});
