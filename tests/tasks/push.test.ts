// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Push of a task branch (spec.md section 6.8, AC-B16, AC-B17, AC-B22) to a local bare remote. No network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, git, gitEnv } from "../../src/server/review/git";
import { type PushInput, pushRefusal, pushTaskBranch, staleText } from "../../src/server/tasks/push";
import { reviewRemote } from "../support/review-fixture";

const TOKEN = "rl-wpb1-token-7c41d9e2";
const HEADER = `Authorization: Bearer ${TOKEN}`;
const B = (s: string) => `task/ABC-1-${s}`;
const TASK = { key: "ABC-1", prefix: "task/", branches: ["new", "again", "ff", "stale", "token", "raw"].map(B), target: "main" };

let root: string;
let remote: string;
let cache: string;
let empty: string;
let env: Record<string, string>;
// source <- next, source <- native: next and native are siblings.
let c: { source: string; next: string; native: string };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rl-wpb1-push-"));
  const r = await reviewRemote(root, { 1: "next" });
  remote = r.remote;
  empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  env = gitEnv(empty);
  await git(["--git-dir", remote, "update-ref", "refs/keep/native", r.native], { env });
  cache = join(root, "cache.git");
  await git(["init", "-q", "--bare", "--template=", cache], { env });
  await git([`--git-dir=${cache}`, "fetch", "-q", remote, "+refs/*:refs/*"], { env });
  c = { source: r.source, next: r.next, native: r.native };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let logs: Mock<typeof console.log>;
beforeEach(() => {
  logs = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logs.mockRestore());

type Call = { args: string[]; env: Record<string, string> };
function spy(impl: typeof git = git) {
  const calls: Call[] = [];
  const run: typeof git = (args, opts) => {
    calls.push({ args, env: opts.env });
    return impl(args, opts);
  };
  return { calls, run };
}

const input = (over: Partial<PushInput>): PushInput => ({
  cache,
  emptyGlobal: empty,
  url: remote,
  config: [["http.extraHeader", HEADER]],
  commit: c.source,
  branch: B("new"),
  lease: null,
  task: TASK,
  ...over,
});
const at = (branch: string) =>
  git(["--git-dir", remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { env }).then(
    (s) => s.trim(),
    () => null,
  );
const logText = () => logs.mock.calls.flat().join("\n");

describe("pushTaskBranch against a bare remote", () => {
  test("a first push uses an empty lease and makes the branch", async () => {
    const s = spy();
    expect(await pushTaskBranch(input({ git: s.run }))).toEqual({ status: "pushed" });
    expect(await at(B("new"))).toBe(c.source);
    const push = s.calls.find((x) => x.args.includes("push"));
    expect(push?.args).toContain(`--force-with-lease=refs/heads/${B("new")}:`);
    expect(push?.args.at(-1)).toBe(`${c.source}:refs/heads/${B("new")}`);
    expect(s.calls).toHaveLength(1);
  });

  test("an empty lease to a branch that exists is stale and changes nothing", async () => {
    await pushTaskBranch(input({ branch: B("again") }));
    const r = await pushTaskBranch(input({ branch: B("again"), commit: c.next }));
    expect(r).toEqual({ status: "stale", sentence: staleText(B("again")) });
    expect(staleText(B("again"))).toBe(`Someone else pushed to ${B("again")}. Get their commits first.`);
    expect(await at(B("again"))).toBe(c.source);
  });

  test("a later push uses the pushed lease; a rewrite is never pushed", async () => {
    await pushTaskBranch(input({ branch: B("ff") }));
    const s = spy();
    expect(await pushTaskBranch(input({ branch: B("ff"), commit: c.next, lease: c.source, git: s.run }))).toEqual({ status: "pushed" });
    expect(await at(B("ff"))).toBe(c.next);
    const push = s.calls.find((x) => x.args.includes("push"));
    expect(push?.args).toContain(`--force-with-lease=refs/heads/${B("ff")}:${c.source}`);
    expect(push?.args.at(-1)).toBe(`${c.next}:refs/heads/${B("ff")}`);
    expect(push?.args.some((a) => a.startsWith("+") || a === "--force" || a === "-f")).toBe(false);
    const r = spy();
    expect(await pushTaskBranch(input({ branch: B("ff"), commit: c.native, lease: c.next, git: r.run }))).toEqual({
      status: "needs_force",
    });
    expect(r.calls.some((x) => x.args.includes("push"))).toBe(false);
    expect(await at(B("ff"))).toBe(c.next);
  });

  test("a stale lease is refused, and the remote keeps the other commit (Gate G6)", async () => {
    await pushTaskBranch(input({ branch: B("stale") }));
    // Someone else moves the branch.
    await git(["--git-dir", remote, "update-ref", `refs/heads/${B("stale")}`, c.native], { env });
    const r = await pushTaskBranch(input({ branch: B("stale"), commit: c.next, lease: c.source }));
    expect(r).toEqual({ status: "stale", sentence: staleText(B("stale")) });
    expect(await at(B("stale"))).toBe(c.native);
  });

  test("git itself forces a rewrite that matches an explicit lease, so the app checks it first", async () => {
    await pushTaskBranch(input({ branch: B("raw"), commit: c.next }));
    await git(
      [`--git-dir=${cache}`, "push", `--force-with-lease=refs/heads/${B("raw")}:${c.next}`, remote, `${c.native}:refs/heads/${B("raw")}`],
      {
        env,
      },
    );
    expect(await at(B("raw"))).toBe(c.native);
  });

  test("git lets a + refspec defeat a stale lease, so the app never sends one", async () => {
    const plus = "task/ABC-1-plus";
    await git([`--git-dir=${cache}`, "push", remote, `${c.source}:refs/heads/${plus}`], { env });
    await git(["--git-dir", remote, "update-ref", `refs/heads/${plus}`, c.native], { env });
    await git(
      [`--git-dir=${cache}`, "push", `--force-with-lease=refs/heads/${plus}:${c.source}`, remote, `+${c.next}:refs/heads/${plus}`],
      { env },
    );
    expect(await at(plus)).toBe(c.next);
  });
});

describe("refusals before git runs (AC-B16)", () => {
  const cases: [string, Partial<PushInput>, RegExp][] = [
    ["the target branch", { branch: "main" }, /never pushes to the target branch main/],
    ["the target branch in other case", { branch: "MAIN" }, /target branch/],
    ["a target branch that is also a task branch", { task: { ...TASK, target: B("new") } }, /target branch/],
    ["a branch outside the task", { branch: "task/ABC-2-other" }, /not a branch of task ABC-1/],
    ["a task branch name that the task did not make", { branch: B("unlisted") }, /not a branch of task ABC-1/],
    [
      "a listed branch without the task prefix",
      { branch: "bugfix/ABC-1-x", task: { ...TASK, branches: ["bugfix/ABC-1-x"] } },
      /not a task branch name/,
    ],
    [
      "a listed branch of another key",
      { branch: "task/ABC-12-x", task: { ...TASK, branches: ["task/ABC-12-x"] } },
      /not a task branch name/,
    ],
    ["a refspec in the name", { branch: `${B("x")}:refs/heads/main`, task: { ...TASK, branches: [`${B("x")}:refs/heads/main`] } }, /name/],
    ["a dot pair in the prefix", { branch: "a/../ABC-1-x", task: { ...TASK, prefix: "a/../", branches: ["a/../ABC-1-x"] } }, /name/],
    ["an option as the prefix", { branch: "--all-ABC-1-x", task: { ...TASK, prefix: "--all-", branches: ["--all-ABC-1-x"] } }, /name/],
    ["a bad commit", { commit: "HEAD" }, /commit hash/],
    ["a bad lease", { lease: "main" }, /commit hash/],
  ];
  for (const [name, over, reason] of cases)
    test(name, async () => {
      const s = spy();
      const r = await pushTaskBranch(input({ ...over, git: s.run }));
      expect(r.status).toBe("refused");
      expect(r.status === "refused" && r.reason).toMatch(reason);
      expect(s.calls).toHaveLength(0);
    });

  test("a task branch passes", () => {
    expect(
      pushRefusal({ branch: B("2-add-cache-2"), commit: "a".repeat(40), lease: null, task: { ...TASK, branches: [B("2-add-cache-2")] } }),
    ).toBeNull();
    expect(
      pushRefusal({
        branch: "task/ABC-1-spec",
        commit: "a".repeat(64),
        lease: "b".repeat(64),
        task: { ...TASK, branches: ["task/ABC-1-spec"] },
      }),
    ).toBeNull();
  });
});

describe("the token (AC-B22)", () => {
  test("travels only in the GIT_CONFIG env, never in argv or a log line", async () => {
    const s = spy();
    expect(await pushTaskBranch(input({ branch: B("token"), git: s.run }))).toEqual({ status: "pushed" });
    expect(await pushTaskBranch(input({ branch: B("token"), commit: c.next, lease: c.source, git: s.run }))).toEqual({ status: "pushed" });
    expect(s.calls.map((x) => x.args[1])).toEqual(["push", "rev-list", "push"]);
    for (const call of s.calls) {
      expect(call.args.join("\n")).not.toContain(TOKEN);
      const holders = Object.entries(call.env).filter(([, v]) => v.includes(TOKEN));
      // Only the push gets the auth header (git.ts: only network calls get extra config).
      expect(holders).toHaveLength(call.args[1] === "push" ? 1 : 0);
      if (call.args[1] !== "push") continue;
      const [k, v] = holders[0] as [string, string];
      expect(k).toMatch(/^GIT_CONFIG_VALUE_\d+$/);
      expect(v).toBe(HEADER);
      expect(call.env[k.replace("VALUE", "KEY")]).toBe("http.extraHeader");
    }
    expect(logText()).toContain(`Pushed ${c.next.slice(0, 12)} to ${B("token")}.`);
    expect(logText()).not.toContain(TOKEN);
  });

  test("a git error that holds the token is redacted in the result and the log", async () => {
    const s = spy(async () => {
      throw new GitError(`git push failed (exit 128): fatal: bad header '${HEADER}'`);
    });
    const r = await pushTaskBranch(input({ branch: B("token"), commit: c.next, lease: null, git: s.run }));
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r.status === "failed" && r.message).toContain("[redacted]");
    expect(logText()).not.toContain(TOKEN);
  });
});
