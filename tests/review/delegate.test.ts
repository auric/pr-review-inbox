// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 1.5 (WP-R2): the app gives the Agent tool by the size of the change. The fake CLI, a temp
// git remote, and a temp data folder only. No test starts the real CLI.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import {
  contextBlock,
  DO_NOT_FLAG,
  delegation,
  gitToolLines,
  HANDOFF_DELEGATE,
  HANDOFF_REVIEWER,
  mainAgent,
  moduleSections,
  NO_CONTEXT,
  REVIEWER_MIN_FILES,
  REVIEWER_MIN_LINES,
  type ReviewContext,
  reviewerAgent,
  rubric,
  SHIPPED_PROFILES,
} from "../../src/server/review/catalog";
import type { DiffFile } from "../../src/server/review/diffmap";
import { git, gitEnv } from "../../src/server/review/git";
import { saveInstructionSettings } from "../../src/server/review/instructions";
import { createReviewJobs } from "../../src/server/review/jobs";
import type { GitRemote } from "../../src/server/review/workspace";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { ProfileInput, RunDto } from "../../src/shared/dto";
import { REVIEW_PROMPT_VERSION } from "../../src/shared/review";
import { FAKE_TOKEN } from "../support/fake-bitbucket";
import { readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, REVIEW_RESULT, stubListTools } from "../support/review-fixture";

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const general = SHIPPED_PROFILES[0] as ProfileInput;
const explain = SHIPPED_PROFILES[1] as ProfileInput;
const SEARCH = "When you cannot name a trigger, search the code for one. When you still cannot name one, write a question for the author.";

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// One diff file with adds added rows, dels removed rows, and 3 context rows.
const file = (path: string, adds: number, dels = 0): DiffFile => ({
  path,
  oldPath: path,
  binary: false,
  rows: [
    ...Array.from({ length: 3 }, (_, i) => ({ kind: "ctx" as const, old: i + 1, new: i + 1, text: "" })),
    ...Array.from({ length: dels }, (_, i) => ({ kind: "del" as const, old: i + 4, new: 4, text: "" })),
    ...Array.from({ length: adds }, (_, i) => ({ kind: "add" as const, old: 4, new: i + 4, text: "" })),
  ],
  newLines: new Map(),
  oldLines: new Map(),
});
const mode = (m: "auto" | "always" | "off", p = general): ProfileInput => ({ ...p, reviewer: { ...p.reviewer, mode: m } });

describe("delegation rule", () => {
  test("mode auto delegates from 1,200 changed lines or 30 changed files; context rows do not count", () => {
    expect([REVIEWER_MIN_LINES, REVIEWER_MIN_FILES]).toEqual([1200, 30]);
    expect(delegation(general, [file("a.ts", 200)])).toBeNull();
    expect(delegation(general, [file("a.ts", 1199)])).toBeNull();
    expect(delegation(general, [file("a.ts", 1200)])).toBe("auto");
    expect(delegation(general, [file("a.ts", 600, 600)])).toBe("auto");
    expect(delegation(general, [file("a.ts", 1300)])).toBe("auto");
    const files = (n: number) => Array.from({ length: n }, (_, i) => file(`f${i}.ts`, 1));
    expect(delegation(general, files(29))).toBeNull();
    expect(delegation(general, files(30))).toBe("auto");
    expect(delegation(general, [])).toBeNull();
  });

  test("mode always delegates for any size, mode off and Explain never", () => {
    expect(delegation(mode("always"), [file("a.ts", 1)])).toBe("always");
    expect(delegation(mode("always"), [])).toBe("always");
    expect(delegation(mode("off"), [file("a.ts", 5000)])).toBeNull();
    for (const m of ["auto", "always"] as const) expect(delegation(mode(m, explain), [file("a.ts", 5000)])).toBeNull();
  });
});

type Call = { argv: string[]; cwd: string; stdin: string; childPid?: number; context?: Record<string, string> };
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n");

async function waitFor(pred: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(25);
  return pred();
}

// A bare remote. main adds a CLAUDE.md in src/server and in web. PR 1 adds 200 lines, PR 2 1,300 lines, PR 3 30 files of one line.
async function remote(root: string) {
  mkdirSync(root, { recursive: true });
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const bare = join(root, "remote.git");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_INDEX_FILE: join(root, "index"),
  };
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", bare, ...args], { env, stdin })).trim();
  await git(["init", "-q", "--bare", "--template=", bare], { env });
  let n = 0;
  async function commit(parent: string | null, files: Record<string, string>) {
    await g(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
    const entries = Object.entries(files);
    const blobs = entries.map(([, text]) => {
      const f = join(root, `blob-${n++}`);
      writeFileSync(f, text);
      return f;
    });
    const shas = (await g(["hash-object", "-w", "--no-filters", "--stdin-paths"], `${blobs.join("\n")}\n`)).split("\n");
    await g(["update-index", "--index-info"], `${entries.map(([path], i) => `100644 ${shas[i]}\t${path}`).join("\n")}\n`);
    return g(["commit-tree", await g(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", "c"]);
  }
  const base = await commit(null, { "src/server/app.ts": `${lines(20, "a")}\n`, "web/main.ts": "export {};\n" });
  const target = await commit(base, { "src/server/CLAUDE.md": "SERVER-RULES-CANARY\n", "web/CLAUDE.md": "WEB-RULES-CANARY\n" });
  const heads = {
    1: await commit(base, { "src/server/app.ts": `${lines(20, "a")}\n${lines(200, "b")}\n` }),
    2: await commit(base, { "src/server/big.ts": `${lines(1300, "c")}\n` }),
    3: await commit(base, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`src/server/f${i}.ts`, "export {};\n"]))),
  };
  await g(["update-ref", "refs/heads/main", target]);
  for (const [id, head] of Object.entries(heads)) {
    await g(["update-ref", `refs/heads/pr-${id}`, head]);
    await g(["update-ref", `refs/pull-requests/${id}/from`, head]);
  }
  const gitRemote = async (ref: { id: number }): Promise<GitRemote> => ({
    url: bare,
    sourceUrl: bare,
    sourceRef: `refs/heads/pr-${ref.id}`,
    targetRef: "refs/heads/main",
    fetchConfig: [],
  });
  return { target, heads, gitRemote };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rl-delegate-"));
  dirs.push(root);
  const repo = await remote(join(root, "remote"));
  const dir = join(root, "data");
  const profiles: ProfileInput[] = [
    general,
    { ...mode("always"), id: "always", name: "Always" },
    { ...mode("off"), id: "off", name: "Off" },
    { ...general, id: "bare", name: "Bare", modules: [] },
    { ...general, id: "handoff", name: "Handoff", variants: ["handoff"] },
    explain,
  ];
  writeConfig(dir, { baseUrl: "https://bitbucket.example.invalid", userSlug: "me", notifications: false, profiles });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const prs: Record<number, number> = {};
  for (const [id, head] of Object.entries(repo.heads))
    prs[Number(id)] = (
      db
        .query(
          `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
            source_branch, target_branch, updated_date, on_dashboard, followed)
          VALUES ('PROJ', 'repo', $id, 'Synthetic change', NULL, 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $head, $target, $branch, 'main', 1, 1, 1)
          RETURNING id`,
        )
        .get({ id: Number(id), head, target: repo.target, branch: `pr-${id}` }) as { id: number }
    ).id;
  const claude = join(root, "claude");
  mkdirSync(claude);
  const runner = fakeRunner(claude);
  const fixture = claudeStream(claude, "tree", "claude-synthetic/review-agent-tree.jsonl", REVIEW_RESULT);
  const review = createReviewJobs({
    settings,
    live: createLive(),
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: repo.gitRemote,
    listTools: stubListTools,
  });
  cleanup.unshift(async () => {
    await review.stop();
    settings.close();
  });
  const calls = () => readRecords<Call>(join(claude, "calls.jsonl"));
  const start = (pr: number, profile: string) => {
    const r = review.review(db, prs[pr] as number, profile);
    expect(r.status).toBe(202);
    return (r as { run: RunDto }).run.id;
  };
  // Starts a run that hangs, reads its files, and cancels it. The run folder holds agents.json and CLAUDE.md only while the run is active.
  async function hung(pr: number, profile: string) {
    runner.write({ fixture, hang: true });
    const before = calls().filter((c) => c.childPid).length;
    const id = start(pr, profile);
    expect(await waitFor(() => calls().filter((c) => c.childPid).length > before)).toBe(true);
    const c = calls()
      .filter((x) => x.argv?.includes("-p"))
      .at(-1) as Call;
    const agents = JSON.parse(readFileSync(flag(c.argv, "--agents"), "utf8")) as Record<string, { prompt: string; effort?: string }>;
    const claudeMd = existsSync(join(c.cwd, "CLAUDE.md")) ? readFileSync(join(c.cwd, "CLAUDE.md"), "utf8") : "";
    expect(review.cancel(db, id)).toBe("cancelled");
    await review.wait();
    return { id, argv: c.argv, agents, claudeMd, stdin: c.stdin, context: c.context ?? {} };
  }
  return { db, review, runner, fixture, start, hung, calls, claude, prs };
}

// delegation-gaps.md fix 5: rl-reviewer gets the same context, module, rubric, and do-not-flag lines as rl-main.
describe("rl-reviewer prompt parity", () => {
  const full: ReviewContext = {
    taskFile: true,
    attachments: true,
    history: true,
    questions: true,
    rereview: true,
    instructions: true,
    goal: true,
    prContext: true,
    notes: true,
    plan: true,
  };
  const block = (lines: string[]) => `\n${lines.join("\n")}\n`;
  const doNotFlag = DO_NOT_FLAG.map((l) => `- ${l}`);

  test("for the shipped Review profile, with no context and with every context file", () => {
    for (const c of [NO_CONTEXT, full]) {
      const main = mainAgent(general, c).prompt;
      const reviewer = reviewerAgent(general, c).prompt;
      const sections = moduleSections(general, c);
      expect(sections.length).toBeGreaterThan(0);
      for (const lines of [contextBlock(c), sections, rubric(general), doNotFlag]) {
        expect(main).toContain(block(lines));
        expect(reviewer).toContain(block(lines));
      }
    }
  });

  test(
    "in a run: the rl-reviewer prompt holds the rubric and the do-not-flag list of the rl-main prompt",
    async () => {
      const h = await setup();
      const { agents } = await h.hung(2, "general");
      for (const lines of [rubric(general), doNotFlag]) {
        expect(agents["rl-main"]?.prompt).toContain(block(lines));
        expect(agents["rl-reviewer"]?.prompt).toContain(block(lines));
      }
    },
    SLOW,
  );
});

describe("delegation in a run", () => {
  test(
    "AC-R2, AC-R3: 200 lines get no Agent tool; 1,300 lines or 30 files in mode auto get rl-reviewer with its effort; always and off",
    async () => {
      const h = await setup();
      const small = await h.hung(1, "general");
      expect(flag(small.argv, "--tools")).toBe("Read,Grep,Glob");
      expect(Object.keys(small.agents)).toEqual(["rl-main"]);
      expect(small.agents["rl-main"]?.prompt).not.toContain("rl-reviewer");
      expect(flag(small.argv, "--effort")).toBe("medium");

      const large = await h.hung(2, "general");
      expect(flag(large.argv, "--tools")).toBe("Read,Grep,Glob,Agent");
      expect(Object.keys(large.agents)).toEqual(["rl-main", "rl-reviewer"]);
      // design.md R11: the shipped Review profile pins the rl-reviewer effort.
      expect(large.agents["rl-reviewer"]?.effort).toBe("medium");
      expect(large.agents["rl-main"]?.prompt).toContain("\nThe change is large. Give parts of it to the rl-reviewer agent.");
      expect(large.agents["rl-main"]?.prompt.endsWith('set agent to "rl-reviewer" on each of them.')).toBe(true);

      const many = await h.hung(3, "general");
      expect(flag(many.argv, "--tools")).toBe("Read,Grep,Glob,Agent");

      const always = await h.hung(1, "always");
      expect(flag(always.argv, "--tools")).toBe("Read,Grep,Glob,Agent");
      expect(always.agents["rl-main"]?.prompt).toContain("\nSplit the changed files by path across calls to the rl-reviewer agent.");

      const off = await h.hung(2, "off");
      expect(flag(off.argv, "--tools")).toBe("Read,Grep,Glob");
      expect(Object.keys(off.agents)).toEqual(["rl-main"]);
    },
    SLOW,
  );

  test(
    "path scope: a change in src/server/ loads src/server/CLAUDE.md of the target head for both agents, not web/CLAUDE.md",
    async () => {
      const h = await setup();
      const large = await h.hung(2, "general");
      expect(large.claudeMd).toContain("## From the target branch: src/server/CLAUDE.md (applies to src/server/**)\n\nSERVER-RULES-CANARY");
      expect(large.claudeMd).not.toContain("WEB-RULES-CANARY");
      expect(large.agents["rl-reviewer"]?.prompt.endsWith(`\n\n${large.claudeMd.trimEnd()}`)).toBe(true);
      // review_run.instructions_json keeps the path and the scope, never the text.
      expect(h.review.run(h.db, large.id)?.run.instructions?.files).toEqual([
        { source: "target", path: "src/server/CLAUDE.md", bytes: 20, scope: "src/server" },
      ]);
      const row = h.db.query("SELECT instructions_json FROM review_run WHERE id = $id").get({ id: large.id }) as {
        instructions_json: string;
      };
      expect(row.instructions_json).not.toContain("CANARY");
    },
    SLOW,
  );

  test(
    "delegation-gaps.md fix 2: the note of the run ends the rl-reviewer prompt; with no note, the prompt has no note block",
    async () => {
      const h = await setup();
      const plain = await h.hung(2, "general");
      expect(plain.agents["rl-reviewer"]?.prompt).not.toContain("# Your instructions");
      const note = "  Check the retry loop first.\nIgnore the docs folder.  ";
      expect(h.review.saveBrief(h.db, h.prs[2] as number, { note, profile: "general" })).not.toBeNull();
      const noted = await h.hung(2, "general");
      const tail =
        "\n\n# Your instructions\n\nThe user wrote the text below. Follow it.\n\nCheck the retry loop first.\nIgnore the docs folder.";
      expect(noted.agents["rl-reviewer"]?.prompt).toBe(`${plain.agents["rl-reviewer"]?.prompt}${tail}`);
      expect(noted.stdin).toContain("# Your instructions\n\nThe user wrote the text below. Follow it.\n\nCheck the retry loop first.");
    },
    SLOW,
  );

  test(
    "delegation-gaps.md variant handoff: the default agents keep their bytes (hash taken at ca795d1, before the variant)",
    async () => {
      const h = await setup();
      const plain = await h.hung(2, "general");
      expect(createHash("sha256").update(JSON.stringify(plain.agents)).digest("hex")).toBe(
        "c11ae5c14cf76a94797de9b25e2cd16e8795d38c3775ce0f9a8949e253fcce22",
      );
      // The variant adds only its lines. The CLI flags and stdin stay the same, except the profile name.
      const on = await h.hung(2, "handoff");
      const main = on.agents["rl-main"]?.prompt ?? "";
      expect(main).toBe([plain.agents["rl-main"]?.prompt, ...HANDOFF_DELEGATE].join("\n"));
      // This run has no user MCP tool, so neither prompt has the issue lines. handoff.test.ts checks ISSUE_FILES_LINE.
      const reviewer = (on.agents["rl-reviewer"]?.prompt ?? "").split("\n");
      const added = [...gitToolLines(false), SEARCH, ...HANDOFF_REVIEWER];
      for (const l of added) expect(reviewer.filter((x) => x === l)).toHaveLength(1);
      expect(reviewer.filter((x) => !added.includes(x))).toEqual((plain.agents["rl-reviewer"]?.prompt ?? "").split("\n"));
      expect(reviewer).toHaveLength((plain.agents["rl-reviewer"]?.prompt ?? "").split("\n").length + added.length);
      expect({ ...on.agents["rl-reviewer"], prompt: "" }).toEqual({ ...plain.agents["rl-reviewer"], prompt: "" });
      const flags = (argv: string[]) => argv.filter((a) => a.startsWith("--"));
      expect(flags(plain.argv)).toEqual([
        "--output-format",
        "--verbose",
        "--restricted",
        "--strict-mcp-config",
        "--mcp-config",
        "--tools",
        "--allowedTools",
        "--disallowedTools",
        "--agents",
        "--agent",
        "--json-schema",
        "--max-turns",
        "--effort",
        "--advisor",
        "--no-session-persistence",
      ]);
      expect(flags(on.argv)).toEqual(flags(plain.argv));
      const paths = ["--mcp-config", "--agents", "--json-schema"];
      for (const f of flags(plain.argv).filter((x) => !paths.includes(x))) expect(flag(on.argv, f)).toBe(flag(plain.argv, f));
      expect(on.stdin).toBe(plain.stdin.replace(`- Profile: ${general.name}`, "- Profile: Handoff"));
      expect(h.db.query("SELECT prompt_version FROM review_run WHERE id = $id").get({ id: on.id })).toEqual({
        prompt_version: `${REVIEW_PROMPT_VERSION}+handoff`,
      });
    },
    SLOW,
  );

  test(
    "AC-R15 and spec.md section 1.3: the row stores the prompt version; rules and intent with no input add a coverage line",
    async () => {
      const h = await setup();
      // No project instructions, no PR description, and no task.md.
      saveInstructionSettings(h.db, { project: "PROJ", repo: "repo" }, { target: false, local: [], extra: "" });
      h.runner.write({ fixture: h.fixture });
      const id = h.start(1, "general");
      await h.review.wait();
      const run = h.review.run(h.db, id)?.run;
      expect(run?.summary?.coverage.notChecked).toEqual(
        expect.arrayContaining(["Project rules: no instructions loaded.", "Matches the task: no description or task."]),
      );
      expect(h.db.query("SELECT prompt_version FROM review_run WHERE id = $id").get({ id })).toEqual({
        prompt_version: REVIEW_PROMPT_VERSION,
      });
      // A profile without these modules gets no such line.
      h.runner.write({ fixture: h.fixture });
      const other = h.start(1, "bare");
      await h.review.wait();
      expect(JSON.stringify(h.review.run(h.db, other)?.run.summary?.coverage)).not.toMatch(/Project rules|Matches the task/);
    },
    SLOW,
  );
});

// The run setup line "N changed files that no agent read" (judge.ts unreadFiles).
describe("unread files in a run", () => {
  test(
    "a Read under ./repo by rl-reviewer and a git_diff with a path by rl-main count as reads; the summary keeps the rest",
    async () => {
      const h = await setup();
      const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
      const say = (parent: string | null, ...content: unknown[]) => ({
        type: "assistant",
        parent_tool_use_id: parent,
        session_id: "s",
        message: { content },
      });
      const done = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "x" }] } });
      const calls = [
        say(null, use("p-a1", "Agent", { subagent_type: "rl-reviewer", description: "Half 1" })),
        say("p-a1", use("p-r1", "Read", { file_path: "./repo/src/server/f0.ts" })),
        done("p-r1"),
        done("p-a1"),
        say(null, use("p-m1", "mcp__rl-git__git_diff", { path: "src/server/f1.ts" })),
        done("p-m1"),
        say(null, use("p-m2", "Read", { file_path: "context/pr.md" })),
        done("p-m2"),
      ].map((e) => JSON.stringify(e));
      const lines = readFileSync(h.fixture, "utf8").split("\n").filter(Boolean);
      const at = lines.findIndex((l) => JSON.parse(l).type === "result");
      const fixture = join(h.claude, "unread.jsonl");
      writeFileSync(fixture, `${[...lines.slice(0, at), ...calls, ...lines.slice(at)].join("\n")}\n`);
      h.runner.write({ fixture });
      const id = h.start(3, "general");
      await h.review.wait();
      const run = h.review.run(h.db, id)?.run;
      expect(run?.status).toBe("completed");
      expect(run?.summary?.unreadFiles).toBe(28);
    },
    SLOW,
  );
});
