// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Read-only git MCP server over stdio (plan v3 WP7). It reads the cache clone with --git-dir and never runs git inside the worktree.
import { isAbsolute, win32 } from "node:path";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { COMPILED } from "../build";
import type { StdioServerSpec } from "./claude";
import { GitError, git, gitEnv } from "./git";
import type { Workspace } from "./workspace";

export const GIT_MCP_TOOLS = ["git_log", "git_blame", "git_show", "git_diff"];
export const MAX_COMMITS = 200;
export const MAX_BLAME_LINES = 400;
const FULL = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// A hash or an alias, then only ~N and ^N steps. No ref names, @{...}, ^{...}, :/text, ranges, or paths.
const REV = /^(?:[0-9a-f]{4,40}|[0-9a-f]{64}|HEAD|BASE|TARGET)(?:~\d{1,4}|\^[12]?)*$/;
// stacked-prs.md section 5.4: PARENT_BASE exists only with the --parent-base pin. Without it, REV and the texts keep their bytes.
const PARENT_REV = /^(?:[0-9a-f]{4,40}|[0-9a-f]{64}|HEAD|BASE|TARGET|PARENT_BASE)(?:~\d{1,4}|\^[12]?)*$/;
const ALIAS = /^(HEAD|BASE|TARGET|PARENT_BASE)(.*)$/;
// Pathspec magic stays off (--literal-pathspecs). "-" would read as an option.
const CONTROL = /\p{Cc}/u;
// --no-optional-locks: a read never writes the index or other optional files.
const GLOBAL = ["--no-pager", "--no-optional-locks", "--literal-pathspecs"];
const NO_DIFF_HELPERS = ["--no-ext-diff", "--no-textconv"];

// parentBase: the PARENT_BASE pin of a stacked review run. It is an ancestor of target, so resolve needs no other check.
type Pins = { gitDir: string; head: string; base: string; target: string; parentBase?: string };

// The RunSpec.mcpServers entry for one workspace. entry is the script that main.ts runs. A compiled binary takes no entry (U13).
export function gitMcpServer(
  ws: Pick<Workspace, "cache" | "sourceHead" | "rangeBase" | "targetHead"> & Partial<Pick<Workspace, "parentBase">>,
  entry = Bun.main,
): StdioServerSpec {
  return {
    command: process.execPath,
    args: [
      ...(COMPILED ? [] : [entry]),
      "--git-mcp",
      `--git-dir=${ws.cache}`,
      `--head=${ws.sourceHead}`,
      `--base=${ws.rangeBase}`,
      `--target=${ws.targetHead}`,
      ...(ws.parentBase ? [`--parent-base=${ws.parentBase}`] : []),
    ],
    tools: [...GIT_MCP_TOOLS],
  };
}

const revOf = (parent: boolean) =>
  parent
    ? z
        .string()
        .regex(
          PARENT_REV,
          "Use a hex commit hash (4 to 40 characters) or HEAD, BASE, TARGET, or PARENT_BASE, optionally followed by ~N or ^N (for example HEAD~1 or BASE^).",
        )
        .describe(
          "A commit: a hex hash, or HEAD (PR source head), BASE (the base of the reviewed range, the merge base in a first review), TARGET (target branch head, the parent pull request head), or PARENT_BASE (the base of the parent pull request change). Add ~N for the Nth first-parent ancestor or ^N for the Nth parent, for example HEAD~1 or BASE^.",
        )
    : z
        .string()
        .regex(
          REV,
          "Use a hex commit hash (4 to 40 characters) or HEAD, BASE, or TARGET, optionally followed by ~N or ^N (for example HEAD~1 or BASE^).",
        )
        .describe(
          "A commit: a hex hash, or HEAD (PR source head), BASE (the base of the reviewed range, the merge base in a first review), or TARGET (target branch head). Add ~N for the Nth first-parent ancestor or ^N for the Nth parent, for example HEAD~1 or BASE^.",
        );

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith("-") &&
      !isAbsolute(p) &&
      !win32.isAbsolute(p) &&
      !/^[A-Za-z]:/.test(p) &&
      !CONTROL.test(p) &&
      !p.split(/[\\/]/).includes(".."),
    "Use a relative repository path without '..' that does not start with '-'.",
  )
  .describe("A file path relative to the repository root, with '/' separators.");

// The CLI caps an MCP tool result at MAX_MCP_OUTPUT_TOKENS (default 25,000 tokens). One page stays well below it.
export const PAGE_BYTES = 60 * 1024;

const page = z.number().int().min(1).default(1).describe("The output page, from 1. A long output ends with the next page number.");

// Splits out at line ends into parts of at most PAGE_BYTES bytes. A longer line is split, never inside a surrogate pair.
export function pages(out: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let bytes = 0;
  const push = (s: string) => {
    const b = Buffer.byteLength(s);
    if (bytes + b > PAGE_BYTES && cur) {
      parts.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += s;
    bytes += b;
  };
  for (const line of out.split(/(?<=\n)/)) {
    // A UTF-16 unit takes at most 3 UTF-8 bytes. A surrogate pair takes 4.
    for (let i = 0; i < line.length; ) {
      let end = Math.min(line.length, i + Math.floor(PAGE_BYTES / 3));
      const last = line.charCodeAt(end - 1);
      if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--;
      push(line.slice(i, end));
      i = end;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// Page n of out, with a marker when out has more than one page.
export function pageOf(out: string, n: number) {
  if (!out) return "(no output)";
  const all = pages(out);
  const body = all[n - 1];
  if (body === undefined) throw new Error(`Page ${n} does not exist. The output has ${all.length} page${all.length === 1 ? "" : "s"}.`);
  if (all.length === 1) return body;
  const next = n < all.length ? ` Call again with page=${n + 1}.` : "";
  return `${body}\n[page ${n} of ${all.length}.${next}]`;
}

export function createGitMcp(pins: Pins) {
  const env = gitEnv("/dev/null");
  // ponytail: git() buffers the full stdout, and each page runs git again. Cache the output per call if large diffs get slow.
  const run = (args: string[]) => git([...GLOBAL, `--git-dir=${pins.gitDir}`, ...args], { env, timeoutMs: 60_000 });
  const aliases: Record<string, string> = {
    HEAD: pins.head,
    BASE: pins.base,
    TARGET: pins.target,
    ...(pins.parentBase !== undefined && { PARENT_BASE: pins.parentBase }),
  };
  const rev = revOf(pins.parentBase !== undefined);

  const isAncestor = async (a: string, b: string) => {
    try {
      await run(["merge-base", "--is-ancestor", "--end-of-options", a, b]);
      return true;
    } catch (e) {
      // merge-base --is-ancestor exits 1 for "no". git() reports it as "(exit 1)".
      if (e instanceof GitError && e.message.includes("(exit 1)")) return false;
      throw e;
    }
  };

  // Returns the full hash. The commit must be in the history of the pinned head, base, or target.
  const resolve = async (r: string) => {
    const alias = aliases[r];
    if (alias) return alias;
    const m = ALIAS.exec(r);
    const spec = m ? `${aliases[m[1] as string]}${m[2]}` : r;
    let hash = "";
    try {
      hash = (await run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${spec}^{commit}`])).trim();
    } catch {}
    if (!FULL.test(hash)) throw new Error(`Unknown or ambiguous commit: ${r}. Use a longer hash or an existing ancestor.`);
    // BASE can be an app-made merge commit or an earlier head after a force push. Neither is in the history of HEAD or TARGET.
    for (const pin of [pins.head, pins.base, pins.target]) if (await isAncestor(hash, pin)) return hash;
    throw new Error(`Commit ${r} is not in the history of HEAD, BASE, or TARGET.`);
  };

  const text = (out: string, n: number) => ({ content: [{ type: "text" as const, text: pageOf(out, n) }] });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const server = new McpServer({ name: "review-loop-git", version: "1.0.0" });

  server.registerTool(
    "git_log",
    {
      title: "Git log",
      description: `List commits reachable from a commit, newest first. One commit per entry: full hash, date, author, and subject. Set since to list only commits after it, for example since BASE to list the PR commits. Set path to list only commits that change that path. At most ${MAX_COMMITS} commits.`,
      inputSchema: z
        .object({
          rev: rev.default("HEAD"),
          since: rev.optional().describe("Leave out this commit and its history."),
          path: path.optional(),
          max_count: z.number().int().min(1).max(MAX_COMMITS).default(50),
          page,
        })
        .strict(),
      annotations,
    },
    async (a) => {
      const to = await resolve(a.rev);
      const range = a.since ? `${await resolve(a.since)}..${to}` : to;
      return text(
        await run([
          "log",
          "--no-color",
          ...NO_DIFF_HELPERS,
          `--max-count=${a.max_count}`,
          "--date=short",
          "--format=%H %ad %an%n    %s",
          // git allows --follow with exactly one path.
          ...(a.path ? ["--follow"] : []),
          "--end-of-options",
          range,
          "--",
          ...(a.path ? [a.path] : []),
        ]),
        a.page,
      );
    },
  );

  server.registerTool(
    "git_blame",
    {
      title: "Git blame",
      description: `Show the commit, author, and date of each line of a file at a commit. Lines start at start_line. At most ${MAX_BLAME_LINES} lines per call.`,
      inputSchema: z
        .object({
          path,
          rev: rev.default("HEAD"),
          start_line: z.number().int().min(1).default(1),
          max_lines: z.number().int().min(1).max(MAX_BLAME_LINES).default(MAX_BLAME_LINES),
          page,
        })
        .strict(),
      annotations,
    },
    async (a) =>
      // git 2.56 blame reads a "--" after --end-of-options as a revision. Path validation replaces it.
      text(
        await run([
          "blame",
          "--no-color-lines",
          "--no-color-by-age",
          ...NO_DIFF_HELPERS,
          "-l",
          // One -C looks only at files changed in the same commit. -C -C and -C -C -C search more and cost more.
          "-M",
          "-C",
          "--date=short",
          "-L",
          `${a.start_line},+${a.max_lines}`,
          "--end-of-options",
          await resolve(a.rev),
          a.path,
        ]),
        a.page,
      ),
  );

  server.registerTool(
    "git_show",
    {
      title: "Git show",
      description:
        "Without path: show a commit with its message, a file summary, and its patch. With path: show the file content at that commit. A file that the change or the task adds does not exist at BASE. Read the files in ./repo for the head commit.",
      inputSchema: z.object({ rev, path: path.optional(), page }).strict(),
      annotations,
    },
    async (a) => {
      const hash = await resolve(a.rev);
      const opts = a.path ? [] : ["--format=fuller", "--stat", "--patch"];
      const object = a.path ? `${hash}:${a.path}` : hash;
      try {
        return text(await run(["show", "--no-color", ...NO_DIFF_HELPERS, ...opts, "--end-of-options", object, "--"]), a.page);
      } catch (e) {
        // With the trailing "--", git reports a missing path as "bad revision".
        if (
          a.path &&
          !(await run(["cat-file", "-e", "--end-of-options", object]).then(
            () => true,
            () => false,
          ))
        )
          throw new Error(`File ${a.path} does not exist at ${a.rev}.`);
        throw e;
      }
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        'Show the diff between two commits. The default is BASE to HEAD, the PR changes. Set path to limit the diff to one path. Set stat_only to list the changed files: one line per file with added lines, removed lines, and path, then the create, delete, and rename lines. The diff lines have no line numbers. Count them from the hunk header "@@ -old,count +new,count @@", or read the file in ./repo.',
      inputSchema: z
        .object({
          from: rev.default("BASE"),
          to: rev.default("HEAD"),
          path: path.optional(),
          stat_only: z.boolean().default(false),
          page,
        })
        .strict(),
      annotations,
    },
    async (a) =>
      text(
        await run([
          "diff",
          "--no-color",
          ...NO_DIFF_HELPERS,
          "-M",
          ...(a.stat_only ? ["--numstat", "--summary"] : ["-U3"]),
          "--end-of-options",
          await resolve(a.from),
          await resolve(a.to),
          "--",
          ...(a.path ? [a.path] : []),
        ]),
        a.page,
      ),
  );

  return server;
}

// Entry for `--git-mcp`. args: the arguments after --git-mcp.
export async function runGitMcp(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "git-dir": { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      target: { type: "string" },
      "parent-base": { type: "string" },
    },
  });
  const pins: Pins = { gitDir: values["git-dir"] ?? "", head: values.head ?? "", base: values.base ?? "", target: values.target ?? "" };
  const parentBase = values["parent-base"];
  if (parentBase !== undefined) pins.parentBase = parentBase;
  if (!isAbsolute(pins.gitDir) || ![pins.head, pins.target, parentBase ?? pins.head].every((h) => FULL.test(h))) {
    console.error("usage: --git-mcp --git-dir=<absolute path> --head=<hash> --base=<hash> --target=<hash> [--parent-base=<hash>]");
    process.exit(2);
  }
  await createGitMcp(pins).connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
}
