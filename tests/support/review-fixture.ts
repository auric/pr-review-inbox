// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review data for serve.ts and the demo: a temp git remote, the fake Claude Code CLI, and its result. Test code only. No network.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOC_SERVERS } from "../../src/server/review/catalog";
import { git, gitEnv } from "../../src/server/review/git";
import type { GitRemote } from "../../src/server/review/workspace";
import type { FakeScenario } from "./fake-claude";

const FLUSH_BASE = [
  "export function flush(cache: Cache) {",
  "  const lock = cache.lock();",
  "  for (const entry of cache.dirty()) {",
  "    write(entry);",
  "  }",
  "  lock.release();",
  "}",
  "",
].join("\n");
const FLUSH_HEAD = [
  "export function flush(cache: Cache) {",
  "  for (const entry of cache.dirty()) {",
  "    const lock = cache.lock();",
  "    write(entry);",
  "    lock.release();",
  "  }",
  "}",
  "",
].join("\n");

// A bare remote. Each PR gets refs/pull-requests/<id>/from: the source commit, or "next", one commit after it. main is the target.
export async function reviewRemote(root: string, prs: Record<number, "source" | "next">) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const remote = join(root, "remote.git");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "e2e",
    GIT_AUTHOR_EMAIL: "e2e@example.invalid",
    GIT_COMMITTER_NAME: "e2e",
    GIT_COMMITTER_EMAIL: "e2e@example.invalid",
    GIT_INDEX_FILE: join(root, "e2e.index"),
  };
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", remote, ...args], { env, stdin })).trim();
  await git(["init", "-q", "--bare", "--template=", remote], { env });
  let n = 0;
  async function commit(parent: string | null, files: Record<string, string>, msg: string) {
    await g(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
    const entries = Object.entries(files);
    const blobs = entries.map(([, text]) => {
      const f = join(root, `blob-${n++}`);
      writeFileSync(f, text);
      return f;
    });
    const shas = (await g(["hash-object", "-w", "--no-filters", "--stdin-paths"], `${blobs.join("\n")}\n`)).split("\n");
    await g(["update-index", "--index-info"], `${entries.map(([path], i) => `100644 ${shas[i]}\t${path}`).join("\n")}\n`);
    return g(["commit-tree", await g(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", msg]);
  }
  const base = await commit(null, { "src/cache/flush.ts": FLUSH_BASE, "README.md": "# Sample\n" }, "base");
  const target = await commit(base, { "docs/main.md": "main\n", "CLAUDE.md": "Name each lock after the data it guards.\n" }, "main moves");
  const source = await commit(base, { "src/cache/flush.ts": FLUSH_HEAD }, "Lock each entry");
  const next = await commit(source, { "docs/flush.md": "Flush order.\n" }, "Document the flush");
  // A C++ header and source and a Python file after source, for the language checks.
  const native = await commit(
    source,
    { "native/hash.h": "int hash(int x);\n", "native/hash.cpp": "int hash(int x) { return x * 31; }\n", "tools/check.py": "print(1)\n" },
    "Add the native hash",
  );
  await g(["update-ref", "refs/heads/main", target]);
  await g(["update-ref", "refs/heads/feature", source]);
  for (const [id, head] of Object.entries(prs)) await g(["update-ref", `refs/pull-requests/${id}/from`, head === "next" ? next : source]);
  const gitRemote = async (): Promise<GitRemote> => ({
    url: remote,
    sourceUrl: remote,
    sourceRef: "refs/heads/feature",
    targetRef: "refs/heads/main",
    fetchConfig: [],
  });
  return { remote, source, next, native, target, gitRemote };
}

// No run reaches the documentation servers. The stub names one tool per server.
export const stubListTools = async (url: string): Promise<string[]> => [url === DOC_SERVERS.learn ? "docs_search" : "ask_question"];

// The structured result of a review: an exact, a moved, and an outside finding, one dropped finding, and one question.
// The outside finding names a cause on an added line, so the changed-line check keeps it (docs/plans/review-v2/spec.md section 1.7).
const finding = (o: Record<string, unknown>) => ({
  path: "src/cache/flush.ts",
  side: "new",
  lineEnd: null,
  category: "Concurrency",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  evidence: "",
  ...o,
});
export const REVIEW_RESULT = {
  summary: "The lock moves into the loop. A reader can see a partly flushed batch.",
  risks: ["Lock scope in `flush()`.", "Readers of the cache during a flush."],
  questions: [
    { text: "Must `flush()` stay atomic for readers?", why: "The description does not say if a reader may see a partial batch." },
  ],
  coverage: {
    read: ["src/cache/flush.ts"],
    skipped: [],
    unavailable: [],
    notChecked: ["Tests did not run, because the review has read-only tools."],
  },
  findings: [
    finding({
      line: 3,
      anchorText: "const lock = cache.lock();",
      severity: "blocker",
      body: "The lock now covers one entry at a time. Another writer can run between two entries. Take the lock once, before the loop.",
      evidence: "`write()` reads `cache.version` without the lock.",
      agent: "rl-reviewer",
      trigger: "Two writers flush at once. The second writer runs between two entries and sees a partial batch.",
    }),
    finding({
      line: 6,
      anchorText: "lock.release();",
      severity: "minor",
      category: "Error handling",
      body: "`lock.release()` does not run when `write()` throws. Release the lock in a `finally` block.",
      confidence: "medium",
      trigger: "`write()` throws on a full disk. The lock stays taken, and the next flush waits forever.",
    }),
    finding({
      path: "README.md",
      line: 1,
      anchorText: "# Sample",
      severity: "nit",
      category: "Documentation",
      body: "The README does not name the flush order.",
      trigger: "A reader of the README expects one lock per flush and adds a reader that needs the whole batch.",
      cause: { path: "src/cache/flush.ts", side: "new", line: 3, lineEnd: null, anchorText: "const lock = cache.lock();" },
    }),
    finding({
      path: "src/cache/gone.ts",
      line: 4,
      anchorText: "evict()",
      severity: "major",
      body: "A file that the snapshot does not have.",
    }),
  ],
};

// A synthetic stream of fixtures/claude-synthetic/ with the init tools and MCP servers of a review run, and the given structured output. Writes <dir>/<name>.jsonl.
// failed: MCP servers that init lists with the status "failed".
const GIT_TOOLS = ["git_log", "git_blame", "git_show", "git_diff"].map((t) => `mcp__rl-git__${t}`);
const REVIEW_TOOLS = ["Task", "Read", "Grep", "Glob", ...GIT_TOOLS, "StructuredOutput"];
const FIXTURES = resolve(import.meta.dir, "../../fixtures");
export function claudeStream(dir: string, name: string, file: string, structured?: unknown, failed: string[] = []) {
  const lines = readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l);
      if (e.type === "system" && e.subtype === "init")
        return {
          ...e,
          tools: REVIEW_TOOLS,
          mcp_servers: ["rl-git", ...Object.keys(DOC_SERVERS)].map((s) => ({
            name: s,
            status: failed.includes(s) ? "failed" : "connected",
            source: "dynamic",
          })),
        };
      return e.type === "result" && structured !== undefined ? { ...e, structured_output: structured } : e;
    });
  const out = join(dir, `${name}.jsonl`);
  writeFileSync(out, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return out;
}

// The argv of the fake CLI and its scenario file in dir. write() sets the next run. authMethod: the login route of `auth status`.
export function fakeRunner(dir: string) {
  const scenario = join(dir, "scenario.json");
  const write = ({ authMethod = "claude.ai", ...o }: Omit<FakeScenario, "record" | "auth"> & { authMethod?: string }) =>
    writeFileSync(
      scenario,
      JSON.stringify({
        record: join(dir, "calls.jsonl"),
        auth: { loggedIn: true, authMethod, projectsDirectory: join(dir, "projects") },
        delayMs: 5,
        ...o,
      } satisfies FakeScenario),
    );
  return { command: [process.execPath, resolve(import.meta.dir, "fake-claude.ts"), scenario], write };
}
