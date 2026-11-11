// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import {
  createTaskRunner,
  DEFAULT_TASK_RULES,
  extractSkipping,
  taskHash,
  taskInput,
  taskUrl,
  validTaskLink,
} from "../../src/server/tasks/rules";
import type { TaskRule } from "../../src/shared/dto";

const runner = createTaskRunner();
// JavaScriptCore stops runaway backtracking after about 950 ms. The ReDoS tests need budgets well below that.
const fast = createTaskRunner({ budgetMs: 50, retryBudgetMs: 100 });
afterAll(() => {
  runner.close();
  fast.close();
});

const ID = String.raw`[A-Z][A-Z0-9]+-\d+`;
const input = (branch: string, title = "", description = "") => taskInput(branch, title, description);

describe("task-ID rules", () => {
  test("the defaults find the ID in branch and title, and keep the first source", async () => {
    const r = await runner.extract(DEFAULT_TASK_RULES, input("bugfix/ABC-10145-name-of-ticket", "[ABC-10145] Fix of foobar"));
    expect(r).toEqual({ tasks: [{ key: "ABC-10145", source: "branch" }], errors: [null, null, null], timedOut: null });
  });

  test("the union keeps rule order and the source of each ID", async () => {
    const r = await runner.extract(
      DEFAULT_TASK_RULES,
      input("feature/ABC-10613-monitor-api-integration", "[ABC-10145] Fix of foobar", "See ABC-10613 and XYZ-7."),
    );
    expect(r.tasks).toEqual([
      { key: "ABC-10613", source: "branch" },
      { key: "ABC-10145", source: "title" },
      { key: "XYZ-7", source: "description" },
    ]);
  });

  test("keys filter on the part before the dash", async () => {
    const rules: TaskRule[] = [{ source: "description", pattern: ID, keys: ["ABC"] }];
    const r = await runner.extract(rules, input("", "", "XYZ-1 ABC-2 ABCD-3"));
    expect(r.tasks.map((t) => t.key)).toEqual(["ABC-2"]);
  });

  test("capture group 1 is the ID", async () => {
    const rules: TaskRule[] = [{ source: "title", pattern: String.raw`\[([A-Z]+-\d+)\]` }];
    const r = await runner.extract(rules, input("", "[ABC-10145] Fix of foobar ABC-99"));
    expect(r.tasks).toEqual([{ key: "ABC-10145", source: "title" }]);
  });

  test("the result holds at most 50 IDs", async () => {
    const text = Array.from({ length: 51 }, (_, i) => `ABC-${i + 1}`).join(" ");
    const r = await runner.extract(DEFAULT_TASK_RULES, input(text, text, text));
    expect(r.tasks.map((t) => t.key)).toEqual(Array.from({ length: 50 }, (_, i) => `ABC-${i + 1}`));
  });

  test("inputs are capped", () => {
    const t = taskInput("b".repeat(600), "t".repeat(600), "d".repeat(30_000));
    expect([t.branch.length, t.title.length, t.description.length]).toEqual([512, 512, 20_000]);
  });

  test("check reports a syntax error per pattern", async () => {
    const [ok, bad] = await runner.check([ID, "([A-Z]+"]);
    expect(ok).toBeNull();
    expect(bad).toEqual(expect.any(String));
  });

  test("ReDoS: (a+)+$ times out within 1 s, and the next call works", async () => {
    const rules: TaskRule[] = [
      { source: "branch", pattern: ID },
      { source: "description", pattern: "(a+)+$" },
    ];
    const t0 = performance.now();
    const r = await fast.extract(rules, { branch: "bugfix/ABC-10145-name-of-ticket", title: "", description: `${"a".repeat(30_000)}!` });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.timedOut).toBe(1);
    expect(r.tasks).toEqual([{ key: "ABC-10145", source: "branch" }]);
    const next = await fast.extract(DEFAULT_TASK_RULES, input("feature/ABC-10613-monitor-api-integration"));
    expect(next).toEqual({ tasks: [{ key: "ABC-10613", source: "branch" }], errors: [null, null, null], timedOut: null });
  });

  test("a PR that misses the first budget runs again with the retry budget and is not timed out", async () => {
    // Budget 0 times out before the first rule runs, as a busy machine can.
    const busy = createTaskRunner({ budgetMs: 0 });
    try {
      const r = await busy.extract(DEFAULT_TASK_RULES, input("bugfix/ABC-10145-name-of-ticket"));
      expect(r).toEqual({ tasks: [{ key: "ABC-10145", source: "branch" }], errors: [null, null, null], timedOut: null });
    } finally {
      busy.close();
    }
  });

  test("a PR that misses the retry budget too is timed out", async () => {
    const busy = createTaskRunner({ budgetMs: 0, retryBudgetMs: 0 });
    try {
      expect((await busy.extract(DEFAULT_TASK_RULES, input("bugfix/ABC-10145-name-of-ticket"))).timedOut).toBe(0);
    } finally {
      busy.close();
    }
  });

  test("extractSkipping drops the timed-out rule and runs the rest", async () => {
    const rules: TaskRule[] = [
      { source: "description", pattern: "(a+)+$" },
      { source: "title", pattern: ID },
    ];
    const dead = new Set<number>();
    const tasks = await extractSkipping(fast, rules, input("", "[ABC-10145] Fix of foobar", `${"a".repeat(5_000)}!`), dead);
    expect([...dead]).toEqual([0]);
    expect(tasks).toEqual([{ key: "ABC-10145", source: "title" }]);
  });
});

describe("task links and hashes", () => {
  test("taskLink accepts https, and http on loopback only", () => {
    expect(validTaskLink("https://tracker.example.test/browse/{key}")).toBe("https://tracker.example.test/browse/{key}");
    expect(validTaskLink("http://127.0.0.1:8080/browse/{key}")).not.toBeNull();
    expect(validTaskLink("http://localhost/browse?id={key}")).not.toBeNull();
    expect(validTaskLink("http://tracker.example.test/browse/{key}")).toBeNull();
    expect(validTaskLink("https://tracker.example.test/browse/")).toBeNull();
    expect(validTaskLink("https://{key}.example.test/")).toBeNull();
    expect(validTaskLink("https://user:pw@tracker.example.test/{key}")).toBeNull();
    expect(validTaskLink("javascript:alert('{key}')")).toBeNull();
  });

  test("taskUrl encodes the key", () => {
    expect(taskUrl("https://tracker.example.test/browse/{key}", "ABC-1")).toBe("https://tracker.example.test/browse/ABC-1");
    expect(taskUrl("https://tracker.example.test/browse/{key}", "a/b?c")).toBe("https://tracker.example.test/browse/a%2Fb%3Fc");
    expect(taskUrl(null, "ABC-1")).toBeNull();
  });

  test("the hash changes with the inputs, the rules, and the link", () => {
    const i = input("bugfix/ABC-10145-name-of-ticket");
    const h = taskHash(i, DEFAULT_TASK_RULES, null);
    expect(taskHash(i, DEFAULT_TASK_RULES, null)).toBe(h);
    expect(taskHash(input("bugfix/ABC-10146"), DEFAULT_TASK_RULES, null)).not.toBe(h);
    expect(taskHash(i, DEFAULT_TASK_RULES.slice(1), null)).not.toBe(h);
    expect(taskHash(i, [{ ...DEFAULT_TASK_RULES[0], keys: ["ABC"] } as TaskRule, ...DEFAULT_TASK_RULES.slice(1)], null)).not.toBe(h);
    expect(taskHash(i, DEFAULT_TASK_RULES, "https://tracker.example.test/{key}")).not.toBe(h);
  });
});
