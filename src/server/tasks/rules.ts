// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Task-ID extraction (plan v3 WP2). Patterns run only inside worker.ts, under a time budget per PR.
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { FoundTask, PrTask, TaskRule, TaskSource } from "../../shared/dto";
import { COMPILED } from "../build";
import type { WorkerReply, WorkerRequest } from "./worker";

export const DEFAULT_TASK_RULES: TaskRule[] = (["branch", "title", "description"] as const).map((source) => ({
  source,
  pattern: String.raw`[A-Z][A-Z0-9]+-\d+`,
}));

// D9: the union of all rules, in rule order, deduped, at most MAX_TASKS (limits.md decision 2).
export const MAX_TASKS = 50;
export const BUDGET_MS = 100;
// A timed-out PR runs once more on a fresh worker with this budget. Only a second timeout marks the rule.
export const RETRY_BUDGET_MS = 500;
const CAPS: Record<TaskSource, number> = { branch: 512, title: 512, description: 20_000 };
const START_MS = 5_000;
// In a compiled binary, import.meta.url names the bundle entry. scripts/compile.ts embeds worker.ts as tasks/worker.js beside it.
const WORKER_URL = new URL(COMPILED ? "./tasks/worker.ts" : "./worker.ts", import.meta.url).href;

export type TaskInput = Record<TaskSource, string>;

export const taskInput = (branch: string | null, title: string | null, description: string | null): TaskInput => ({
  branch: (branch ?? "").slice(0, CAPS.branch),
  title: (title ?? "").slice(0, CAPS.title),
  description: (description ?? "").slice(0, CAPS.description),
});

// timedOut: the index of the rule that ran when the budget ended. tasks then holds the rules before it.
export type Extraction = { tasks: FoundTask[]; errors: (string | null)[]; timedOut: number | null };

export function createTaskRunner(opts: { budgetMs?: number; retryBudgetMs?: number } = {}) {
  const budget = opts.budgetMs ?? BUDGET_MS;
  const retryBudget = opts.retryBudgetMs ?? RETRY_BUDGET_MS;
  let worker: Worker | null = null;
  let ready: Promise<void> = Promise.resolve();
  let pending: ((r: WorkerReply | null) => void) | null = null;
  let seq = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const start = (): Worker => {
    const w = new Worker(WORKER_URL);
    // An idle worker must not keep the process alive. The DOM Worker type has no unref().
    (w as unknown as { unref(): void }).unref();
    ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("The task worker did not start.")), START_MS);
      // Bun's types can resolve Worker.onmessage to a constructor type under the DOM lib.
      (w as EventTarget).addEventListener("message", (e) => {
        const data = (e as MessageEvent<WorkerReply | "ready">).data;
        if (data !== "ready") {
          if (data.id === seq) pending?.(data);
          return;
        }
        clearTimeout(t);
        resolve();
      });
    });
    w.onerror = () => pending?.(null);
    worker = w;
    return w;
  };

  const stop = () => {
    worker?.terminate();
    worker = null;
  };

  async function ensure(): Promise<Worker> {
    const w = worker ?? start();
    try {
      await ready;
    } catch (e) {
      stop();
      throw e;
    }
    return w;
  }

  // Resolves null at the deadline. The caller then stops the worker.
  async function ask(req: Omit<WorkerRequest, "id">, ms: number): Promise<WorkerReply | null> {
    if (ms <= 0) return null;
    const w = await ensure();
    const id = ++seq;
    return new Promise((resolve) => {
      const t = setTimeout(() => done(null), Math.max(0, ms));
      const done = (r: WorkerReply | null) => {
        clearTimeout(t);
        pending = null;
        resolve(r);
      };
      pending = done;
      w.postMessage({ ...req, id } satisfies WorkerRequest);
    });
  }

  // One job at a time, so one PR never spends the budget of another.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function extractOnce(rules: TaskRule[], input: TaskInput, ms: number): Promise<Extraction> {
    const tasks: FoundTask[] = [];
    const errors: (string | null)[] = rules.map(() => null);
    let deadline: number | null = null;
    for (const [i, r] of rules.entries()) {
      if (tasks.length >= MAX_TASKS) break;
      const text = input[r.source];
      if (!text) continue;
      await ensure();
      // The budget starts after the worker is ready, so a restart never counts against a rule.
      deadline ??= performance.now() + ms;
      const reply = await ask({ pattern: r.pattern, text, keys: r.keys, max: MAX_TASKS }, deadline - performance.now());
      if (!reply) {
        stop();
        return { tasks, errors, timedOut: i };
      }
      if ("error" in reply) errors[i] = reply.error;
      else
        for (const key of reply.keys)
          if (tasks.length < MAX_TASKS && !tasks.some((t) => t.key === key)) tasks.push({ key, source: r.source });
    }
    return { tasks, errors, timedOut: null };
  }

  return {
    // Runs the rules in order on one PR. Throws only when the worker cannot start.
    extract(rules: TaskRule[], input: TaskInput): Promise<Extraction> {
      return serial(async () => {
        const r = await extractOnce(rules, input, budget);
        return r.timedOut === null ? r : extractOnce(rules, input, retryBudget);
      });
    },
    // The syntax error of each pattern, or null. Compiling never runs the pattern, so it needs no worker or budget. Keep the flags equal to worker.ts.
    check(patterns: string[]): Promise<(string | null)[]> {
      return Promise.resolve(
        patterns.map((pattern) => {
          try {
            new RegExp(pattern, "g");
            return null;
          } catch (e) {
            return (e as Error).message;
          }
        }),
      );
    },
    close: stop,
  };
}

export type TaskRunner = ReturnType<typeof createTaskRunner>;

// Runs the rules and drops each rule that times out, until a run completes. The set grows by one per retry, so the loop ends.
export async function extractSkipping(runner: TaskRunner, rules: TaskRule[], input: TaskInput, dead: Set<number>): Promise<FoundTask[]> {
  for (;;) {
    const idx = rules.map((_, i) => i).filter((i) => !dead.has(i));
    const r = await runner.extract(
      idx.map((i) => rules[i] as TaskRule),
      input,
    );
    if (r.timedOut === null) return r.tasks;
    dead.add(idx[r.timedOut] as number);
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Accepts https, or http on loopback, with {key} outside the origin and no credentials. Returns null otherwise.
export function validTaskLink(raw: string): string | null {
  if (!raw.includes("{key}")) return null;
  try {
    const a = new URL(raw.replaceAll("{key}", "A"));
    const b = new URL(raw.replaceAll("{key}", "B"));
    if (a.origin !== b.origin || a.username || a.password) return null;
    if (a.protocol === "https:" || (a.protocol === "http:" && LOOPBACK.has(a.hostname))) return raw;
  } catch {}
  return null;
}

export const taskUrl = (link: string | null | undefined, key: string): string | null =>
  link ? link.replaceAll("{key}", encodeURIComponent(key)) : null;

export function taskHash(input: TaskInput, rules: TaskRule[], link: string | null): string {
  const r = rules.map(({ source, pattern, keys }) => ({ source, pattern, keys: keys ?? null }));
  return createHash("sha256")
    .update(JSON.stringify([input.branch, input.title, input.description, r, link]))
    .digest("hex");
}

export const sameRule = (a: TaskRule, b: TaskRule) =>
  a.source === b.source && a.pattern === b.pattern && JSON.stringify(a.keys ?? null) === JSON.stringify(b.keys ?? null);

// Runs inside the PR transaction.
export function writeTasks(db: Database, pr: number, hash: string, tasks: PrTask[]) {
  db.query("DELETE FROM pr_task WHERE pr = $pr").run({ pr });
  const insert = db.query("INSERT INTO pr_task (pr, key, source, url, ord) VALUES ($pr, $key, $source, $url, $ord)");
  for (const [ord, t] of tasks.entries()) insert.run({ pr, key: t.key, source: t.source, url: t.url, ord });
  db.query("UPDATE pull_request SET task_input_hash = $hash WHERE id = $pr").run({ pr, hash });
}
