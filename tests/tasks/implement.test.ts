// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.6 to 6.8 (WP-B3, AC-B8, AC-B9, AC-B22): an implement step with the Gate B17 flags in the task
// worktree, the path check after the step, the reset with the patch, the blocked reason, the stop after a failed run, and the part
// budget. The fake CLI writes real files. No test starts the real CLI or reaches a forge.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { DEFAULT_PROFILE, DOCS_RULE, profileOf } from "../../src/server/review/catalog";
import { IMPLEMENT_TOOLS, implementArgs } from "../../src/server/review/claude";
import { git } from "../../src/server/review/git";
import { IMPLEMENT_TRUST, INSTRUCTIONS_TRUST, saveInstructionSettings } from "../../src/server/review/instructions";
import { createReviewJobs, IMPLEMENT_MCP_LINES } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import {
  ciPath,
  commitTask,
  implementPrompt,
  instructionRepos,
  partBudget,
  type StepInput,
  type StepOutcome,
  sparseHidden,
  startStep,
  stepTimeout,
} from "../../src/server/tasks/implement";
import { taskRow } from "../../src/server/tasks/tasks";
import { headOf, openWorktree, resetWorktree, status, type Worktree } from "../../src/server/tasks/worktree";
import { implementJsonSchema, STEP_TIME_MS, type TaskBlocked } from "../../src/shared/task";
import { type FakeScenario, readRecords } from "../support/fake-claude";
import { fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";

for (const m of ["tasks/implement", "tasks/worktree", "review/claude", "review/jobs", "review/instructions"])
  console.log(`implement.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 90_000;
const FIXTURE = resolve(import.meta.dir, "../../fixtures/claude/b17-write-confinement.jsonl");
const MAX_TURNS_FIXTURE = resolve(import.meta.dir, "../../fixtures/claude/b5-max-turns.jsonl");
const SECRET = "Bearer secret-token-4411";

type Call = {
  argv: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
  refused?: string;
  context?: Record<string, string>;
  mcp?: Record<string, { args?: string[]; env?: Record<string, string> }> | null;
};
const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

async function setup(o: { claudeConfigDir?: string } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-wpb3-impl-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  const scenario = (s: Omit<FakeScenario, "record" | "auth" | "fixture"> & { fixture?: string } = {}) =>
    runner.write({ fixture: FIXTURE, ...s });
  scenario();
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: "http://127.0.0.1:9", userSlug: "u", notifications: false });
  const settings = createSettings({ dir: dataDir, secrets: createSecrets(null), jiraSecrets: createSecrets(null, "jira-token") });
  const db = settings.db() as Database;
  const review = createReviewJobs({
    settings,
    live: createLive(),
    dataDir,
    runnerCommand: runner.command,
    listTools: stubListTools,
    claudeConfigDir: o.claudeConfigDir ?? join(root, "no-claude-config"),
    // The fetch config carries the token. It must never reach the worktree, a context file, or the CLI env.
    repoRemote: async () => ({ url: r.remote, config: [["http.extraHeader", `Authorization: ${SECRET}`]] }),
  });
  cleanup.unshift(async () => {
    await review.stop();
    db.close();
  });
  const { base } = await taskCache(dataDir, r.remote);
  const now = Date.now();
  const task = (
    db
      .query(
        `INSERT INTO task (project, repo, key, title, state, size, target_branch, base_commit, spec_dir, created_at, updated_at)
        VALUES ('PROJ', 'repo', 'K-1', 'Thing', 'implementing', 'small', 'main', $base, 'specs/K-1/', $now, $now) RETURNING id`,
      )
      .get({ base, now }) as { id: number }
  ).id;
  const part = (
    db
      .query(
        `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
        VALUES ($task, 1, 'single', 'Thing', 'feature/K-1-thing', 'main', 'implementing', $now, $now) RETURNING id`,
      )
      .get({ task, now }) as { id: number }
  ).id;
  const wt = await openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task, ord: 1, branch: "feature/K-1-thing", base });
  // The user's clone of the repository.
  const clone = join(root, "clone");
  await git(["clone", "-q", r.remote, clone], { env: r.env });
  const record = join(root, "calls.jsonl");
  const calls = () => readRecords<Call>(record);
  const runCalls = () => calls().filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  let outcome: StepOutcome | null = null;
  const step = async (o: Partial<StepInput> = {}) => {
    outcome = null;
    const started = await startStep({
      db,
      review,
      task,
      part: { id: part, ord: 1 },
      wt,
      mode: "implement",
      item: "T1.1",
      attempt: 1,
      profile: profileOf(settings.profiles(), DEFAULT_PROFILE),
      untrusted: [{ name: "task.md", text: "## K-1\n\nDo the thing.\n" }],
      own: [
        { name: "step.md", text: "# Step\n\n- Task: T1.1\n" },
        { name: "spec/plan.md", text: "# Plan: K-1 Thing\n" },
      ],
      allow: ["src/app.ts"],
      specDir: "specs/K-1/",
      onEnd: (x) => {
        outcome = x;
      },
      ...o,
    });
    await review.wait();
    return { started, outcome: outcome as StepOutcome | null };
  };
  const blockedOf = () => {
    const t = taskRow(db, task);
    return t?.blocked_json ? (JSON.parse(t.blocked_json) as TaskBlocked) : null;
  };
  const stepRow = (id: number) =>
    db.query("SELECT kind, state, part, run, item, attempt, detail_json FROM task_step WHERE id = $id").get({ id }) as {
      kind: string;
      state: string;
      part: number;
      run: number;
      item: string;
      attempt: number;
      detail_json: string;
    };
  return { root, dataDir, db, settings, review, task, part, wt, base, clone, r, scenario, runCalls, calls, step, blockedOf, stepRow };
}

// Every file under dir, as text, with links not followed.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    const st = lstatSync(p);
    return st.isSymbolicLink() ? [] : st.isDirectory() ? files(p) : [readFileSync(p, "utf8")];
  });
}

async function expectUndone(s: Awaited<ReturnType<typeof setup>>, wt: Worktree, o: StepOutcome | null, path: string) {
  expect(o?.problems.map((p) => p.path)).toContain(path);
  expect(o?.changed).toEqual([]);
  expect(await status(wt)).toEqual([]);
  expect(await headOf(wt)).toBe(s.base);
  const row = s.stepRow(o?.step as number);
  expect(row.state).toBe("failed");
  const detail = JSON.parse(row.detail_json) as { deniedPaths: string[]; patch: string | null };
  expect(detail.deniedPaths).toContain(path);
  const b = s.blockedOf();
  expect(b?.kind).toBe("denied_path");
  expect(b?.step).toBe(o?.step as number);
  expect(b?.text).toContain(path);
  expect(b?.text.startsWith("Needs you:")).toBe(true);
  // The task keeps building: a denied path waits for the user, it is no stop.
  expect(taskRow(s.db, s.task)?.state).toBe("implementing");
  return detail;
}

describe("implement run", () => {
  test("the CLI arguments are the Gate B17 flags", () => {
    const schema = implementJsonSchema();
    const { args, allowed } = implementArgs({ implement: true, cwd: "x", prompt: "p", schema, maxTurns: 80 });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--strict-mcp-config",
      "--tools",
      "Read,Grep,Glob,Edit,Write",
      "--allowedTools",
      "Read,Grep,Glob,Edit,Write",
      "--json-schema",
      JSON.stringify(schema),
      "--max-turns",
      "80",
      "--no-session-persistence",
    ]);
    expect([...allowed].sort()).toEqual([...IMPLEMENT_TOOLS, "StructuredOutput"].sort());
    for (const a of [
      "--permission-mode",
      "--bare",
      "--agents",
      "--agent",
      "--mcp-config",
      "--setting-sources",
      "--dangerously-skip-permissions",
    ])
      expect(args).not.toContain(a);
    expect(args.join(" ")).not.toMatch(/Bash|PowerShell|Agent|WebFetch|WebSearch/);
    expect(implementArgs({ implement: true, cwd: "x", prompt: "p", schema, maxTurns: 40, model: "opus", effort: "high" }).args).toContain(
      "opus",
    );
  });

  test(
    "a step that writes repo/src/new.ts passes, runs in the part folder with a scrubbed env, and the write outside the cwd is refused",
    async () => {
      const s = await setup();
      const saved = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      cleanup.push(() => {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = saved;
      });
      s.scenario({
        writes: [
          { path: "repo/src/new.ts", text: "export const n = 1;\n" },
          { path: "../outside.txt", text: "B17-B" },
        ],
      });
      // A file of an earlier step does not stay in context/.
      writeFileSync(join(s.wt.context, "failure.md"), "old output\n");
      const { started, outcome } = await s.step();
      expect(existsSync(join(s.wt.context, "failure.md"))).toBe(false);
      expect(started.status).toBe(202);
      expect(outcome?.status).toBe("completed");
      expect(outcome?.problems).toEqual([]);
      expect(outcome?.changed).toEqual(["src/new.ts"]);
      expect(outcome?.result?.done).toBe(true);
      expect(readFileSync(join(s.wt.repo, "src", "new.ts"), "utf8")).toBe("export const n = 1;\n");
      expect(s.blockedOf()).toBeNull();
      if (!outcome) throw new Error("no outcome");
      const row = s.stepRow(outcome.step);
      expect([row.kind, row.state, row.part, row.item, row.attempt, row.run]).toEqual(["implement", "ok", s.part, "T1.1", 1, outcome.run]);
      const run = s.db
        .query("SELECT kind, pr, task, status, source_head FROM review_run WHERE id = $id")
        .get({ id: outcome.run }) as Record<string, unknown>;
      expect(run).toEqual({ kind: "implement", pr: null, task: s.task, status: "completed", source_head: s.base });
      expect(
        JSON.parse((s.db.query("SELECT usage_json FROM task_part WHERE id = $id").get({ id: s.part }) as { usage_json: string }).usage_json)
          .turns,
      ).toBe(5);
      // AC-B8: the flags, the part folder as cwd, never the clone.
      const [call] = s.runCalls();
      if (!call) throw new Error("no run");
      const p = profileOf(s.settings.profiles(), DEFAULT_PROFILE);
      // The MCP file sits in the run folder outside the cwd, and it goes with the run.
      const mcpFile = flag(call.argv, "--mcp-config");
      expect(mcpFile && !mcpFile.toLowerCase().startsWith(s.wt.dir.toLowerCase())).toBe(true);
      expect(existsSync(mcpFile as string)).toBe(false);
      const spec = { implement: true as const, cwd: s.wt.dir, prompt: "", schema: implementJsonSchema(), maxTurns: 80 };
      const expected = implementArgs({ ...spec, model: p?.model, effort: p?.effort }).args;
      const at = expected.indexOf("--tools");
      expect(call.argv).toEqual([
        ...expected.slice(0, at),
        "--mcp-config",
        mcpFile as string,
        "--tools",
        "Read,Grep,Glob,Edit,Write",
        "--allowedTools",
        "Read,Grep,Glob,Edit,Write,mcp__rl-git,mcp__learn,mcp__deepwiki",
        ...expected.slice(at + 4),
      ]);
      expect(Object.keys(call.mcp ?? {})).toEqual(["rl-git", "learn", "deepwiki"]);
      // BRIEF.md part 6: the read-only git MCP server reads the task cache. HEAD is the worktree head, BASE the base of the task.
      expect(call.mcp?.["rl-git"]?.args?.slice(-5)).toEqual([
        "--git-mcp",
        `--git-dir=${s.wt.cache}`,
        `--head=${s.base}`,
        `--base=${s.base}`,
        `--target=${s.base}`,
      ]);
      expect(realpathSync.native(call.cwd)).toBe(realpathSync.native(s.wt.dir));
      expect(JSON.stringify(call.argv).toLowerCase()).not.toContain(s.clone.toLowerCase().replaceAll("\\", "\\\\"));
      expect(call.cwd.toLowerCase().startsWith(s.clone.toLowerCase())).toBe(false);
      // AC-B22: no API key and no token in the env.
      const keys = Object.keys(call.env).map((k) => k.toUpperCase());
      expect(keys).not.toContain("ANTHROPIC_API_KEY");
      expect(call.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
      expect(JSON.stringify(call.env)).not.toContain(SECRET);
      // The target branch CLAUDE.md of the fixture holds its own path as text.
      expect(call.stdin).toBe(
        implementPrompt(
          "implement",
          "specs/K-1/",
          false,
          false,
          "",
          `# Project instructions\n\n${IMPLEMENT_TRUST}\n\n## From the target branch: CLAUDE.md (applies to all files)\n\nCLAUDE.md\n`,
          { skills: [], mcp: [...IMPLEMENT_MCP_LINES, DOCS_RULE] },
        ),
      );
      // Gate B17: --restricted refuses a write outside the cwd. The fake does the same.
      expect(s.calls().some((c) => c.refused === "../outside.txt")).toBe(true);
      expect(existsSync(resolve(s.wt.dir, "..", "outside.txt"))).toBe(false);
      // The context files: only the current task, with the banner on the task text.
      expect(readFileSync(join(s.wt.context, "task.md"), "utf8").startsWith("# UNTRUSTED DATA")).toBe(true);
      expect(readFileSync(join(s.wt.context, "step.md"), "utf8")).toBe("# Step\n\n- Task: T1.1\n");
      expect(existsSync(join(s.wt.context, "spec", "plan.md"))).toBe(true);
      // The token is in no file of the task folder, the cache config, or the worktree.
      for (const t of [...files(join(s.wt.dir, "..")), readFileSync(join(s.wt.admin, "..", "..", "config"), "utf8")])
        expect(t).not.toContain(SECRET);
    },
    SLOW,
  );

  test(
    "every step mode gets the Project instructions of the task repository at its target commit; the worktree still hides CLAUDE.md",
    async () => {
      const s = await setup();
      saveInstructionSettings(s.db, { project: "PROJ", repo: "repo" }, { target: true, local: [], extra: "IMPLEMENT-RULES-CANARY" });
      for (const mode of ["tests", "implement", "fix", "instruct", "resolve"] as const) {
        s.scenario({ writes: [] });
        await s.step({ mode, attempt: 1, item: `T1.${mode}`, ...(mode === "instruct" && { instructions: "Rename the flag." }) });
        const call = s.runCalls().at(-1) as Call;
        const at = call.stdin.indexOf("# Project instructions");
        expect(at).toBeGreaterThan(call.stdin.indexOf("- Mode:"));
        const section = call.stdin.slice(at);
        expect(section).toContain(IMPLEMENT_TRUST);
        expect(section).not.toContain(INSTRUCTIONS_TRUST);
        expect(section).toContain("## From the target branch: CLAUDE.md");
        expect(section).toContain("IMPLEMENT-RULES-CANARY");
        expect(call.stdin).toContain('Only the "Project instructions"');
        if (mode === "instruct") expect(call.stdin.endsWith("# Your instructions\n\nRename the flag.")).toBe(true);
      }
      // The sparse rule stays: the CLI sees no CLAUDE.md in ./repo, and the part folder gets none.
      expect(existsSync(join(s.wt.repo, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(s.wt.dir, "CLAUDE.md"))).toBe(false);
      // SQLite holds the sources and sizes, never the text.
      const row = s.db.query("SELECT instructions_json FROM review_run WHERE kind = 'implement' ORDER BY id DESC LIMIT 1").get() as {
        instructions_json: string;
      };
      expect(JSON.parse(row.instructions_json).files.map((f: { source: string; path: string }) => [f.source, f.path])).toEqual([
        ["target", "CLAUDE.md"],
        ["settings", ""],
      ]);
      expect(row.instructions_json).not.toContain("CANARY");
    },
    SLOW,
  );

  test(
    "multi-repo: the main repository and each submodule with access edit give their own instructions, scoped to their folder",
    async () => {
      const s = await setup();
      const add = (o: { project: string; repo: string; parent: number | null; path: string; access: string }) =>
        (
          s.db
            .query(
              `INSERT INTO task_repo (task, role, project, repo, parent, path, depth, access, base_commit, pinned, created_at)
              VALUES ($task, 'submodule', $project, $repo, $parent, $path, 1, $access, NULL, $pin, 1) RETURNING id`,
            )
            .get({ task: s.task, ...o, pin: "b".repeat(40) }) as { id: number }
        ).id;
      const main = (
        s.db
          .query(
            `INSERT INTO task_repo (task, role, project, repo, depth, access, base_branch, base_commit, created_at)
            VALUES ($task, 'main', 'PROJ', 'repo', 0, 'edit', 'main', $base, 1) RETURNING id`,
          )
          .get({ task: s.task, base: s.base }) as { id: number }
      ).id;
      const lib = add({ project: "PROJ", repo: "lib", parent: main, path: "libs/lib", access: "edit" });
      add({ project: "PROJ", repo: "deep", parent: lib, path: "deep", access: "edit" });
      add({ project: "PROJ", repo: "docs", parent: main, path: "docs", access: "read" });
      expect(instructionRepos(s.db, s.task, ["src/app.ts", "libs/lib/a.ts", "libs/lib/deep/b.ts"])).toEqual([
        { project: "PROJ", repo: "repo", commit: s.base, path: null, paths: ["src/app.ts", "libs/lib/a.ts", "libs/lib/deep/b.ts"] },
        { project: "PROJ", repo: "lib", commit: "b".repeat(40), path: "libs/lib", paths: ["a.ts", "deep/b.ts"] },
        { project: "PROJ", repo: "deep", commit: "b".repeat(40), path: "libs/lib/deep", paths: ["b.ts"] },
      ]);
    },
    SLOW,
  );

  test(
    "AC-B9: a step that writes .claude/settings.json fails, the worktree returns to the last commit, and the patch exists",
    async () => {
      const s = await setup();
      s.scenario({
        writes: [
          { path: "repo/.claude/settings.json", text: '{"hooks":{"Stop":[]}}\n' },
          { path: "repo/src/app.ts", text: "changed\n" },
        ],
      });
      const { outcome } = await s.step();
      const detail = await expectUndone(s, s.wt, outcome, ".claude/settings.json");
      expect(existsSync(join(s.wt.repo, ".claude"))).toBe(false);
      expect(readFileSync(join(s.wt.repo, "src", "app.ts"), "utf8")).toBe("src/app.ts\n");
      expect(detail.patch).toBe(`${outcome?.step}.patch`);
      const patch = readFileSync(join(s.wt.dir, "..", "patches", `${outcome?.step}.patch`), "utf8");
      expect(patch).toContain("diff --git a/.claude/settings.json b/.claude/settings.json");
      expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
      expect(outcome?.patch).toBe(join(s.wt.dir, "..", "patches", `${outcome?.step}.patch`));
    },
    SLOW,
  );

  test(
    "CLAUDE.md, a file outside repo/, a link, a nested repository, a changed .git link, and CI configuration fail and are undone",
    async () => {
      const s = await setup();
      const victim = join(s.root, "victim");
      mkdirSync(victim);
      writeFileSync(join(victim, "keep.txt"), "keep\n");
      const cases: { writes: NonNullable<FakeScenario["writes"]>; path: string; allow?: string[] }[] = [
        { writes: [{ path: "repo/sub/CLAUDE.md", text: "planted\n" }], path: "sub/CLAUDE.md" },
        { writes: [{ path: "outside.txt", text: "x\n" }], path: "../outside.txt" },
        { writes: [{ path: "context/step.md", text: "# Step\n\nNew rules.\n" }], path: "../context/step.md" },
        { writes: [{ path: "repo/src/link", junction: victim }], path: "src/link" },
        {
          // A git folder needs HEAD, objects/, and refs/ (setup.c is_git_directory).
          writes: [
            { path: "repo/vendor/.git/HEAD", text: "ref: refs/heads/main\n" },
            { path: "repo/vendor/.git/objects/.keep", text: "" },
            { path: "repo/vendor/.git/refs/.keep", text: "" },
            { path: "repo/vendor/x.ts", text: "x\n" },
          ],
          path: "vendor/",
        },
        { writes: [{ path: "repo/.git", text: `gitdir: ${s.clone.replaceAll("\\", "/")}/.git\n` }], path: ".git" },
        { writes: [{ path: "repo/.github/workflows/ci.yml", text: "on: push\n" }], path: ".github/workflows/ci.yml" },
      ];
      const before = await git(["-C", s.clone, "status", "--porcelain=v1", "--ignored"], { env: s.r.env });
      const cloneHead = await git(["-C", s.clone, "rev-parse", "HEAD"], { env: s.r.env });
      for (const c of cases) {
        s.db.query("UPDATE task SET blocked_json = NULL").run();
        s.scenario({ writes: c.writes });
        const { outcome } = await s.step();
        await expectUndone(s, s.wt, outcome, c.path);
      }
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
      expect(existsSync(join(s.wt.repo, "src", "link"))).toBe(false);
      expect(existsSync(join(s.wt.repo, "vendor"))).toBe(false);
      expect(existsSync(join(s.wt.dir, "outside.txt"))).toBe(false);
      expect(readFileSync(join(s.wt.repo, ".git"), "utf8").trim()).toBe(`gitdir: ${s.wt.admin.replaceAll("\\", "/")}`);
      // The user's clone is untouched.
      expect(await git(["-C", s.clone, "status", "--porcelain=v1", "--ignored"], { env: s.r.env })).toBe(before);
      expect(await git(["-C", s.clone, "rev-parse", "HEAD"], { env: s.r.env })).toBe(cloneHead);
      // A CI configuration path that the task lists passes.
      s.db.query("UPDATE task SET blocked_json = NULL").run();
      s.scenario({ writes: [{ path: "repo/.github/workflows/ci.yml", text: "on: push\n" }] });
      const { outcome } = await s.step({ allow: [".github/workflows/ci.yml"] });
      expect(outcome?.problems).toEqual([]);
      expect(outcome?.changed).toEqual([".github/workflows/ci.yml"]);
    },
    SLOW * 2,
  );

  test(
    "an ignored file that the step writes or changes fails the step, and the worktree goes; ignored files from before the step pass",
    async () => {
      const s = await setup();
      // A check command wrote this before the step, as a build does. The listing before the step holds it.
      mkdirSync(join(s.wt.repo, "ignored"), { recursive: true });
      writeFileSync(join(s.wt.repo, "ignored", "build.log"), "built\n");
      s.scenario({ writes: [{ path: "repo/src/app.ts", text: "changed\n" }] });
      const ok = await s.step();
      expect(ok.outcome?.problems).toEqual([]);
      expect(ok.outcome?.changed).toEqual(["src/app.ts"]);
      await resetWorktree(s.wt, s.base);
      // git status shows none of these paths: .gitignore of the fixture ignores ignored/ and *.log.
      s.scenario({
        writes: [
          { path: "repo/ignored/evil.js", text: "planted\n" },
          { path: "repo/ignored/build.log", text: "changed by the step\n" },
          { path: "repo/src/app.ts", text: "changed\n" },
        ],
      });
      const { outcome } = await s.step();
      const reason = "A step may not write a file that git ignores.";
      expect(outcome?.problems).toEqual([
        { path: "ignored/build.log", reason },
        { path: "ignored/evil.js", reason },
      ]);
      expect(outcome?.changed).toEqual([]);
      const row = s.stepRow(outcome?.step as number);
      expect(row.state).toBe("failed");
      expect(JSON.parse(row.detail_json).deniedPaths).toEqual(["ignored/build.log", "ignored/evil.js"]);
      const b = s.blockedOf();
      expect(b?.kind).toBe("denied_path");
      expect(b?.text).toContain("ignored/build.log");
      // The patch keeps the tracked change. A changed ignored file has no copy to restore, so the worktree is gone.
      expect(readFileSync(join(s.wt.dir, "..", "patches", `${outcome?.step}.patch`), "utf8")).toContain(
        "diff --git a/src/app.ts b/src/app.ts",
      );
      expect(existsSync(s.wt.dir)).toBe(false);
      const again = await openWorktree({
        dataDir: s.dataDir,
        db: s.db,
        project: "PROJ",
        repo: "repo",
        task: s.task,
        ord: 1,
        branch: "feature/K-1-thing",
        base: s.base,
      });
      expect(existsSync(join(again.repo, "ignored"))).toBe(false);
      expect(await status(again)).toEqual([]);
      expect(await headOf(again)).toBe(s.base);
    },
    SLOW,
  );

  test(
    "a failed run stops the task with the reason, and the path check still runs",
    async () => {
      const s = await setup();
      s.scenario({ fixture: MAX_TURNS_FIXTURE, writes: [{ path: "repo/CLAUDE.local.md", text: "x\n" }] });
      const { outcome } = await s.step();
      // The denied path wins over the run error: the user sees the path.
      await expectUndone(s, s.wt, outcome, "CLAUDE.local.md");
      s.db.query("UPDATE task SET blocked_json = NULL").run();
      s.scenario({ fixture: MAX_TURNS_FIXTURE, writes: [{ path: "repo/src/half.ts", text: "x\n" }] });
      const second = await s.step();
      expect(second.outcome?.status).toBe("failed");
      expect(s.stepRow(second.outcome?.step as number).state).toBe("failed");
      const t = taskRow(s.db, s.task);
      expect(t?.state).toBe("stopped");
      expect(t?.stopped_from).toBe("implementing");
      expect(s.blockedOf()?.kind).toBe("error");
      // Resume (WP-B4) resets to the last commit. The half step stays for its patch.
      expect(existsSync(join(s.wt.repo, "src", "half.ts"))).toBe(true);
    },
    SLOW,
  );

  test(
    "a step that passes its time limit is killed, and the task stops",
    async () => {
      const s = await setup();
      // 1.5 s of Claude time left in the part: the step gets that much (stepTimeout).
      const now = Date.now();
      s.db
        .query("INSERT INTO task_step (task, part, kind, state, ord, started_at, ended_at) VALUES ($t, $p, 'implement', 'ok', 99, $a, $b)")
        .run({ t: s.task, p: s.part, a: now - (120 * 60_000 - 1_500), b: now });
      s.scenario({ hang: true });
      const t0 = Date.now();
      const { outcome } = await s.step();
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(outcome?.status).toBe("failed");
      expect(s.blockedOf()?.text).toBe("The run passed its time limit.");
      expect(taskRow(s.db, s.task)?.state).toBe("stopped");
      const child = s.calls().find((c) => (c as { childPid?: number }).childPid !== undefined) as { childPid?: number } | undefined;
      if (child?.childPid) {
        const alive = () => {
          try {
            process.kill(child.childPid as number, 0);
            return true;
          } catch {
            return false;
          }
        };
        const end = Date.now() + 10_000;
        while (alive() && Date.now() < end) await Bun.sleep(50);
        expect(alive()).toBe(false);
      }
    },
    SLOW,
  );

  test(
    "a git error in the reset stops the task with the reason",
    async () => {
      const s = await setup();
      // git refuses to write an index that another process holds.
      writeFileSync(join(s.wt.admin, "index.lock"), "");
      s.scenario({ writes: [{ path: "repo/CLAUDE.md", text: "planted\n" }] });
      const { outcome } = await s.step();
      expect(outcome?.status).toBe("failed");
      expect(outcome?.changed).toEqual([]);
      expect(s.stepRow(outcome?.step as number).state).toBe("failed");
      const t = taskRow(s.db, s.task);
      expect(t?.state).toBe("stopped");
      const b = s.blockedOf();
      expect(b?.kind).toBe("error");
      expect(b?.text).toStartWith("The app could not check the changed files:");
    },
    SLOW,
  );

  test(
    "the part budget: a used-up part blocks before a run, and a step gets at most the time left",
    async () => {
      const s = await setup();
      const now = Date.now();
      const add = (ms: number) =>
        s.db
          .query(
            "INSERT INTO task_step (task, part, kind, state, ord, started_at, ended_at) VALUES ($task, $part, 'implement', 'ok', 99, $a, $b)",
          )
          .run({ task: s.task, part: s.part, a: now - ms, b: now });
      add(115 * 60_000);
      const b = partBudget(s.db, s.task, { id: s.part, ord: 1 }, now);
      expect(b.over).toBeNull();
      expect(stepTimeout(b)).toBe(5 * 60_000);
      expect(stepTimeout({ ...b, usedMs: 0 })).toBe(STEP_TIME_MS);
      add(6 * 60_000);
      const { started } = await s.step();
      expect(started).toEqual({
        status: 409,
        blocked: { kind: "budget", step: null, text: "Needs you: part 1 used its 120 min. Continue with 60 more min?" },
      });
      expect(s.runCalls().length).toBe(0);
      expect(s.blockedOf()?.kind).toBe("budget");
      // A task setting raises the limit. A cost limit applies only when a run reported a cost.
      s.db.query("UPDATE task SET settings_json = $s").run({ s: JSON.stringify({ partTimeMin: 180, partCost: 1 }) });
      const raised = partBudget(s.db, s.task, { id: s.part, ord: 1 }, now);
      expect(raised.over).toBeNull();
      expect(raised.costUsd).toBeNull();
      const run = s.db
        .query(
          `INSERT INTO review_run (task, kind, profile, note, idem_key, source_head, target_head, status, started_at, usage_json)
          VALUES ($task, 'implement', 'general', '', 'k', '', '', 'completed', $now, $u) RETURNING id`,
        )
        .get({ task: s.task, now, u: JSON.stringify({ costUsd: 1.5, turns: 3, durationMs: 1, tokens: {} }) }) as { id: number };
      s.db
        .query(
          "INSERT INTO task_step (task, part, kind, run, state, ord, started_at, ended_at) VALUES ($t, $p, 'fix', $r, 'ok', 100, $n, $n)",
        )
        .run({ t: s.task, p: s.part, r: run.id, n: now });
      const cost = partBudget(s.db, s.task, { id: s.part, ord: 1 }, now);
      expect(cost.costUsd).toBe(1.5);
      expect(cost.turns).toBe(3);
      expect(cost.over).toBe("Needs you: part 1 used its cost limit of 1 USD.");
    },
    SLOW,
  );

  test(
    "the commit runs the path check first, keeps the diff stat in its step row, and moves the part head",
    async () => {
      const s = await setup();
      const who = { name: "Ada Example", email: "ada@example.invalid" };
      const commit = (o: Partial<Parameters<typeof commitTask>[0]> = {}) =>
        commitTask({
          db: s.db,
          task: s.task,
          part: s.part,
          wt: s.wt,
          item: "T1.1",
          message: "K-1 T1.1: Change the app\n",
          who,
          allow: [],
          ...o,
        });
      writeFileSync(join(s.wt.repo, "src", "app.ts"), "changed\n");
      // A check command can leave a denied file. The commit refuses it before `git add -A`.
      writeFileSync(join(s.wt.repo, "AGENTS.md"), "planted\n");
      const refused = await commit();
      expect(refused).toEqual({ status: "refused", problems: [{ path: "AGENTS.md", reason: "A step may not change this path." }] });
      expect(await headOf(s.wt)).toBe(s.base);
      // git status clears the skip-worktree bit of a present hidden file. The reset hides it again.
      await resetWorktree(s.wt, s.base);
      expect(existsSync(join(s.wt.repo, "AGENTS.md"))).toBe(false);
      expect(await status(s.wt)).toEqual([]);
      writeFileSync(join(s.wt.repo, "src", "app.ts"), "changed\n");
      const done = await commit();
      if (done.status !== "committed") throw new Error(done.status);
      expect(done.commit).toBe(await headOf(s.wt));
      const row = s.stepRow(done.step);
      expect([row.kind, row.state, row.item]).toEqual(["commit", "ok", "T1.1"]);
      const detail = JSON.parse(row.detail_json) as { diffStat: unknown; notes: string[] };
      expect(detail.diffStat).toEqual({ files: 1, added: 1, removed: 1, lines: 2 });
      expect(detail.notes).toEqual([`Commit ${done.commit}`]);
      expect((s.db.query("SELECT head FROM task_part WHERE id = $id").get({ id: s.part }) as { head: string }).head).toBe(done.commit);
      expect((await git([`--git-dir=${s.wt.admin}`, "show", "-s", "--format=%an <%ae>|%s", "HEAD"], { env: s.wt.env })).trim()).toBe(
        "Ada Example <ada@example.invalid>|K-1 T1.1: Change the app",
      );
      expect(await commit()).toEqual({ status: "empty" });
    },
    SLOW,
  );

  test("the path rules", () => {
    for (const p of [
      ".claude/x",
      "a/.claude/b",
      ".mcp.json",
      "a/.mcp.json",
      ".codegraph/i",
      "CLAUDE.md",
      "a/claude.md",
      "a/CLAUDE.local.md",
      "AGENTS.md",
      ".gitmodules",
      ".githooks/x",
      ".husky/x",
    ])
      expect(sparseHidden(p)).toBe(true);
    for (const p of ["src/a.ts", "a/.codegraph/x", "a/.gitmodules", "docs/claude.txt"]) expect(sparseHidden(p)).toBe(false);
    for (const p of [
      ".github/workflows/ci.yml",
      ".gitlab-ci.yml",
      "Jenkinsfile",
      "bitbucket-pipelines.yml",
      "bamboo-specs/a.yml",
      ".circleci/config.yml",
      "azure-pipelines.yml",
      ".travis.yml",
    ])
      expect(ciPath(p)).toBe(true);
    for (const p of ["src/Jenkinsfile", ".github/CODEOWNERS", ".github/workflows", "docs/.gitlab-ci.yml"]) expect(ciPath(p)).toBe(false);
  });
});

describe("implement run with the profile tools", () => {
  test(
    "the step gets the profile skills in context/skills, the ticked MCP tools, the git MCP server, and a codegraph index of repo/",
    async () => {
      const config = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-impl-config-")));
      dirs.push(config);
      const log = join(config, "cg.jsonl");
      const FAKE_CG = join(import.meta.dir, "../support/fake-codegraph/codegraph.js");
      const FAKE_MCP = join(import.meta.dir, "../support/fake-mcp.ts");
      writeFileSync(
        join(config, ".claude.json"),
        JSON.stringify({
          mcpServers: {
            fake: { command: process.execPath, args: [FAKE_MCP], env: {} },
            cg: { command: process.execPath, args: [FAKE_CG, "serve", "--mcp", "--path", "/user/clone"], env: { FAKE_CG_LOG: log } },
          },
        }),
      );
      mkdirSync(join(config, "skills", "tdd"), { recursive: true });
      writeFileSync(join(config, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test first.\n---\n\nWrite the test first.\n");
      const s = await setup({ claudeConfigDir: config });
      const profile = {
        ...profileOf(s.settings.profiles(), DEFAULT_PROFILE),
        skills: ["tdd"],
        alwaysSkills: ["tdd"],
        mcp: [
          { server: "fake", tools: ["search"] },
          { server: "cg", tools: ["codegraph_explore"] },
        ],
      };
      const first = await s.step({ profile });
      expect(first.outcome?.status).toBe("completed");
      expect(first.outcome?.problems).toEqual([]);
      // The index goes before the path check, and the cache keeps it for the next step.
      expect(existsSync(join(s.wt.repo, ".codegraph"))).toBe(false);
      expect(existsSync(join(s.dataDir, "cache", "codegraph", "PROJ", "repo", "codegraph.db"))).toBe(true);
      const [call] = s.runCalls();
      if (!call) throw new Error("no run");
      // Gate B17 stays: --restricted, the five built-in tools, no shell, no Agent, no web tools.
      expect(call.argv).toContain("--restricted");
      expect(call.argv).toContain("--strict-mcp-config");
      expect(flag(call.argv, "--tools")).toBe("Read,Grep,Glob,Edit,Write");
      expect(call.argv.join(" ")).not.toMatch(/Bash|PowerShell|Agent|WebFetch|WebSearch/);
      const allowed = (flag(call.argv, "--allowedTools") ?? "").split(",");
      expect(allowed).toEqual(expect.arrayContaining(["mcp__rl-git", "mcp__fake__search", "mcp__cg__codegraph_explore"]));
      expect(allowed).not.toContain("mcp__fake__lookup");
      const denied = (flag(call.argv, "--disallowedTools") ?? "").split(",");
      expect(denied).toEqual(expect.arrayContaining(["mcp__fake__lookup", "mcp__fake__delete_item"]));
      expect(Object.keys(call.mcp ?? {}).sort()).toEqual(["cg", "deepwiki", "fake", "learn", "rl-git"]);
      // CodeGraph indexes the worktree repo/ of the part, not a cache snapshot.
      const cg = call.mcp?.cg?.args ?? [];
      expect(cg.slice(-3).map((x) => x.toLowerCase())).toEqual(["--path", s.wt.repo.toLowerCase(), "--no-watch"]);
      // The skills sit in context/, outside repo/, and the stdin names them there.
      expect(call.context?.["skills/tdd/SKILL.md"]).toContain("Write the test first.");
      expect(call.stdin).toContain("Before you start, read ./context/skills/tdd/SKILL.md and follow it for the whole run.");
      expect(call.stdin).toContain("except the skills in ./context/skills/");
      expect(call.stdin).toContain("The user added these MCP tools: mcp__fake__search, mcp__cg__codegraph_explore.");
      expect(call.stdin).toContain(IMPLEMENT_MCP_LINES[0] as string);

      const second = await s.step({ profile, attempt: 2 });
      expect(second.outcome?.problems).toEqual([]);
      const index = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { cmd: string; cwd: string })
        .filter((x) => x.cmd !== "serve");
      // Each step indexes repo/ again, so the index follows the edits of the earlier steps.
      expect(index.map((x) => [x.cmd, x.cwd.toLowerCase()])).toEqual([
        ["init", s.wt.repo.toLowerCase()],
        ["status", s.wt.repo.toLowerCase()],
        ["sync", s.wt.repo.toLowerCase()],
        ["status", s.wt.repo.toLowerCase()],
      ]);
    },
    SLOW,
  );
});
