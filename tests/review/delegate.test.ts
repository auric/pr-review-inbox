// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 1.5 (WP-R2): the app gives the Agent tool by the size of the change. The fake CLI, a temp
// git remote, and a temp data folder only. No test starts the real CLI.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { delegation, PART_REVIEWER, REVIEWER_MIN_FILES, REVIEWER_MIN_LINES, SHIPPED_PROFILES } from "../../src/server/review/catalog";
import type { DiffFile } from "../../src/server/review/diffmap";
import { git, gitEnv } from "../../src/server/review/git";
import { saveInstructionSettings } from "../../src/server/review/instructions";
import { createReviewJobs } from "../../src/server/review/jobs";
import { partsOf, partText, splitParts } from "../../src/server/review/parts";
import { type GitRemote, UNTRUSTED } from "../../src/server/review/workspace";
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

// docs/plans/review-v3.md WP-V14: the app-side split of a delegated change.
describe("splitParts", () => {
  const keys = (files: DiffFile[]) => files.map((f) => f.path ?? f.oldPath);
  const many = (folder: string, n: number, adds: number) =>
    Array.from({ length: n }, (_, i) => file(`${folder}f${String(i).padStart(2, "0")}.ts`, adds));
  // 6,000 changed lines in 84 files.
  const tree = [
    file("docs/readme.md", 100),
    ...many("lib/", 20, 50),
    ...many("lib/x/", 7, 100),
    ...many("src/a/", 10, 100),
    ...many("src/b/", 40, 10),
    ...many("src/c/d/", 4, 300),
    file("src/c/d/k.ts", 200, 100),
    file("src/e.ts", 1300),
  ];

  test("a folder under both limits gives 1 part", () => {
    const small = [file("src/x/a.ts", 500), file("src/x/b.ts", 600), file("src/y.ts", 99)];
    expect(splitParts(small)).toEqual([{ files: small, lines: 1199 }]);
    expect(splitParts([])).toEqual([]);
  });

  test("a 6,000-line tree gives parts under both limits, each file once, in path order", () => {
    expect(tree.reduce((n, f) => n + f.rows.filter((r) => r.kind !== "ctx").length, 0)).toBe(6000);
    const parts = splitParts([...tree].reverse());
    for (const p of parts) {
      expect(p.files.length === 1 || (p.lines < REVIEWER_MIN_LINES && p.files.length < REVIEWER_MIN_FILES)).toBe(true);
      expect(delegation(general, p.files) === null || p.files.length === 1).toBe(true);
    }
    const flat = parts.flatMap((p) => keys(p.files));
    expect(flat).toEqual(keys(tree).sort());
    expect(new Set(flat).size).toBe(tree.length);
    // A folder that fits is one part, adjacent children that fit share a part, and a larger folder splits into its children.
    expect(parts.map((p) => [p.files.length, p.lines])).toEqual([
      [1, 100],
      [20, 1000],
      [7, 700],
      [10, 1000],
      [29, 290],
      [11, 110],
      [3, 900],
      [2, 600],
      [1, 1300],
    ]);
  });

  test("a file at or above the line limit is a part alone", () => {
    const big = file("src/big.ts", 2000);
    const parts = splitParts([file("src/a.ts", 10), big, file("src/c.ts", 10)]);
    expect(parts.map((p) => p.files.length)).toEqual([1, 1, 1]);
    expect(parts[1]).toEqual({ files: [big], lines: 2000 });
    expect(splitParts([file("a.ts", 1200)])).toHaveLength(1);
  });

  test("a deleted file uses its old path, and the part text names renames, deletes, and binary files", () => {
    const renamed = { ...file("new/x.ts", 1, 1), oldPath: "old/x.ts" };
    const deleted = { ...file("gone/y.ts", 0, 5), path: null };
    const binary = { ...file("img/a.png", 0), binary: true, rows: [] };
    const added = { ...file("add/z.ts", 3), oldPath: null };
    const [part, ...rest] = splitParts([renamed, binary, deleted, added]);
    expect(rest).toEqual([]);
    expect(partText(part as (typeof rest)[number], 2, 7)).toBe(
      "# Part 2 of 7\n\n- add/z.ts: +3 -0\n- gone/y.ts (deleted): +0 -5\n- img/a.png: +0 -0, binary\n- new/x.ts (renamed from old/x.ts): +1 -1\n",
    );
    // A deleted file of 1,300 lines is a part alone, in the place of its old path.
    const gone = { ...file("b/old.ts", 0, 1300), path: null };
    expect(splitParts([file("c/z.ts", 100), gone, file("a/a.ts", 100)]).map((p) => keys(p.files))).toEqual([
      ["a/a.ts"],
      ["b/old.ts"],
      ["c/z.ts"],
    ]);
  });

  test("the same input gives the same parts, whatever its order", () => {
    expect(splitParts(tree)).toEqual(splitParts([...tree].reverse()));
    expect(splitParts(tree)).toEqual(splitParts(tree));
  });

  test("partsOf: only the variant parts with delegation auto", () => {
    const big = [file("src/a.ts", 700), file("src/b.ts", 700)];
    const parted = { ...general, variants: ["parts"] as ProfileInput["variants"] };
    expect(partsOf(parted, big).map((p) => p.files.length)).toEqual([1, 1]);
    expect(partsOf(general, big)).toEqual([]);
    expect(partsOf({ ...mode("always"), variants: ["parts"] }, big)).toEqual([]);
    expect(partsOf({ ...mode("off"), variants: ["parts"] }, big)).toEqual([]);
    expect(partsOf(parted, [file("src/a.ts", 10)])).toEqual([]);
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
    { ...general, id: "parts", name: "Parts", variants: ["parts"] },
    { ...mode("always"), id: "always-parts", name: "Always parts", variants: ["parts"] },
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
  const fixture = claudeStream(claude, "tree", "claude/b9-wp8-flags.jsonl", REVIEW_RESULT);
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
  return { db, review, runner, fixture, start, hung, calls, claude };
}

describe("delegation in a run", () => {
  test(
    "AC-R2, AC-R3: 200 lines get no Agent tool; 1,300 lines or 30 files in mode auto get rl-reviewer with its effort; always and off",
    async () => {
      const h = await setup();
      const small = await h.hung(1, "general");
      expect(flag(small.argv, "--tools")).toBe("Read,Grep,Glob");
      expect(Object.keys(small.agents)).toEqual(["rl-main"]);
      expect(small.agents["rl-main"]?.prompt).not.toContain("rl-reviewer");
      expect(flag(small.argv, "--effort")).toBe("high");

      const large = await h.hung(2, "general");
      expect(flag(large.argv, "--tools")).toBe("Read,Grep,Glob,Agent");
      expect(Object.keys(large.agents)).toEqual(["rl-main", "rl-reviewer"]);
      // design.md R11: the shipped Review profile pins the rl-reviewer effort.
      expect(large.agents["rl-reviewer"]?.effort).toBe("high");
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

// docs/plans/review-v3.md WP-V14: the variant "parts" with delegation auto.
describe("part files in a run", () => {
  const partKeys = (context: Record<string, string>) => Object.keys(context).filter((k) => k.startsWith("parts/"));

  test(
    "30 files give 2 part files with the banner and the part lines; no path in stdin or agent text; other runs write none",
    async () => {
      const h = await setup();
      const parted = await h.hung(3, "parts");
      expect(partKeys(parted.context).sort()).toEqual(["parts/part-1.md", "parts/part-2.md"]);
      const first = parted.context["parts/part-1.md"] ?? "";
      expect(first.startsWith(`${UNTRUSTED}# Part 1 of 2\n\n- src/server/f0.ts: +1 -0\n- src/server/f1.ts: +1 -0\n`)).toBe(true);
      expect(first.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(29);
      expect(parted.context["parts/part-2.md"]).toBe(`${UNTRUSTED}# Part 2 of 2\n\n- src/server/f9.ts: +1 -0\n`);
      const main = parted.agents["rl-main"]?.prompt ?? "";
      expect(main).toContain("\nThe app split the change into 2 parts in ./context/parts/. Make one rl-reviewer call per part.\n");
      expect(main).not.toContain("The change is large.");
      expect(parted.agents["rl-reviewer"]?.prompt).toContain(`\n${PART_REVIEWER}`);
      for (const text of [parted.stdin, main, parted.agents["rl-reviewer"]?.prompt ?? ""]) expect(text).not.toContain("src/server/f");

      // Without the variant, with mode always, and without delegation, the run writes no part file and keeps its lines.
      const plain = await h.hung(3, "general");
      expect(partKeys(plain.context)).toEqual([]);
      expect(plain.agents["rl-main"]?.prompt).toContain("\nThe change is large.");
      expect(plain.agents["rl-reviewer"]?.prompt).not.toContain(PART_REVIEWER);
      const always = await h.hung(3, "always-parts");
      expect(partKeys(always.context)).toEqual([]);
      expect(always.agents["rl-main"]?.prompt).toContain("\nSplit the changed files by path across calls to the rl-reviewer agent.");
      const small = await h.hung(1, "parts");
      expect(partKeys(small.context)).toEqual([]);
      expect(Object.keys(small.agents)).toEqual(["rl-main"]);
    },
    SLOW,
  );

  test(
    "a part with no rl-reviewer Read gives one coverage line; a Read by rl-main does not count",
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
        say(null, use("p-a1", "Agent", { subagent_type: "rl-reviewer", description: "Part 1" })),
        say("p-a1", use("p-r1", "Read", { file_path: "./context/parts/part-1.md" })),
        done("p-r1"),
        done("p-a1"),
        say(null, use("p-m1", "Read", { file_path: "context/parts/part-2.md" })),
        done("p-m1"),
      ].map((e) => JSON.stringify(e));
      const lines = readFileSync(h.fixture, "utf8").split("\n").filter(Boolean);
      const at = lines.findIndex((l) => JSON.parse(l).type === "result");
      const fixture = join(h.claude, "parts.jsonl");
      writeFileSync(fixture, `${[...lines.slice(0, at), ...calls, ...lines.slice(at)].join("\n")}\n`);
      h.runner.write({ fixture });
      const id = h.start(3, "parts");
      await h.review.wait();
      const run = h.review.run(h.db, id)?.run;
      expect(run?.status).toBe("completed");
      expect(run?.summary?.coverage.notChecked.filter((l) => l.startsWith("Part "))).toEqual([
        "Part 2 of 2 (1 file) got no rl-reviewer call.",
      ]);
      const record = h.calls().find((c) => c.argv?.includes("-p") && c.context?.["parts/part-1.md"]);
      expect(record?.context?.["parts/part-2.md"]?.startsWith(UNTRUSTED)).toBe(true);
      expect(h.db.query("SELECT prompt_version FROM review_run WHERE id = $id").get({ id })).toEqual({
        prompt_version: `${REVIEW_PROMPT_VERSION}+parts`,
      });
    },
    SLOW,
  );
});
