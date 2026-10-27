// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A built small task part for the Tell Claude and update tests (docs/plans/review-v2/spec.md section 6.18): temp bare remotes, the cache
// of the app, a part worktree with the plan and the feature committed, the fake CLI, a bun script as the test command, and the loop.
// multiTask adds the submodules of repos-fixture.ts and the fake Bitbucket. No test starts the real CLI, reaches a forge, or touches the
// user's clone or data folder.
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBitbucketProvider } from "../../src/server/bitbucket/provider";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { git, gitEnv } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { fetchInto } from "../../src/server/review/workspace";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { commitTask } from "../../src/server/tasks/implement";
import { createLoop } from "../../src/server/tasks/loop";
import { renderDocs, toPlan } from "../../src/server/tasks/plan";
import { type RepoDeps, resolveTaskRepos, taskRepos } from "../../src/server/tasks/repos";
import { taskRow } from "../../src/server/tasks/tasks";
import { commitStep, headOf, openRepoTrees, openWorktree, type RepoTree, type Worktree } from "../../src/server/tasks/worktree";
import { type StepDetail, specResult, stepDetail, type TaskBlocked } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, type FakeScenario, readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskCache, taskRemote } from "./fixture";
import { bareRepo, depsOf, mainCache, multiRepo } from "./repos-fixture";

export const KEY = "TU-1";
export const BRANCH = "feature/TU-1-add-the-feature";
export const WHO = { name: "Ada Example", email: "ada@example.invalid" };
export const SLOW = 240_000;
export const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };

// The approved test command: green while src/feature.ts holds "works" and no conflict marker; check-mode.txt "red" makes it red.
const CHECK = `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const mode = readFileSync(join(import.meta.dir, "check-mode.txt"), "utf8").trim();
if (mode === "red") { console.log("FAIL red on purpose"); process.exit(1); }
const f = existsSync("src/feature.ts") ? readFileSync("src/feature.ts", "utf8") : "";
const ok = f.includes("works") && !f.includes("<<<<<<<");
console.log(ok ? "1 pass" : "FAIL: src/feature.ts does not work");
process.exit(ok ? 0 : 1);
`;

export const SPEC = specResult.parse({
  ...echoSpec(),
  title: "Add the feature",
  map: [{ path: "src/app.ts", line: 1, symbol: "", kind: "change", what: "The app." }],
  parts: [
    {
      n: 1,
      kind: "part",
      title: "Feature",
      goal: "The feature works.",
      lines: 20,
      acceptance: [{ id: "A1", text: "The feature works." }],
      tests: [{ test: "tests/feature.test.ts", proves: ["A1"] }],
      tasks: [
        { id: "T1", title: "Write the feature", files: ["src/feature.ts"], run: ["tests/feature.test.ts"], done: "The test passes." },
      ],
    },
  ],
});

export const CLEAN = { summary: "Fine.", risks: [], questions: [], coverage: NO_COVERAGE, findings: [] };
export const implement = (o: Record<string, unknown> = {}) => ({
  summary: "Done.",
  done: true,
  tests: [],
  question: null,
  specChange: "",
  notes: [],
  coverage: NO_COVERAGE,
  ...o,
});

export type Call = { argv: string[]; cwd: string; stdin: string; context: Record<string, string> };
export type Step = { id: number; kind: string; state: string; item: string | null; attempt: number; detail: StepDetail };
type Remote = { url: string; config: [string, string][] };

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
export async function cleanup() {
  for (const f of cleanups.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}

// A new commit on branch of a bare remote with these entries changed: text for a file, null to delete, or a gitlink commit.
export async function remoteCommit(
  r: { remote: string; env: Record<string, string> },
  branch: string,
  files: Record<string, string | null | { gitlink: string }>,
  message = "base change",
) {
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", r.remote, ...args], { env: r.env, stdin })).trim();
  const parent = await g(["rev-parse", `refs/heads/${branch}`]);
  await g(["read-tree", parent]);
  for (const [p, text] of Object.entries(files)) {
    if (text === null) await g(["update-index", "--force-remove", "--", p]);
    else if (typeof text === "object") await g(["update-index", "--add", "--cacheinfo", `160000,${text.gitlink},${p}`]);
    else await g(["update-index", "--add", "--cacheinfo", `100644,${await g(["hash-object", "-w", "--stdin"], text)},${p}`]);
  }
  const commit = await g(["commit-tree", await g(["write-tree"]), "-p", parent, "-m", message]);
  await g(["update-ref", `refs/heads/${branch}`, commit]);
  return commit;
}

export async function write(w: Worktree, files: Record<string, string | null>) {
  for (const [p, text] of Object.entries(files)) {
    const f = join(w.repo, ...p.split("/"));
    if (text === null) rmSync(f, { force: true });
    else {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, text);
    }
  }
}

export { headOf };

export const until = async (f: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("Timed out.");
    await Bun.sleep(25);
  }
};

// The app side: the fake CLI, the settings, the review jobs, the loop, the test command, the user's identity, and the task row. forge:
// the fake Bitbucket becomes the configured server with its token.
async function app(
  root: string,
  remote: (project: string, repo: string) => Promise<Remote>,
  repo: string,
  seq: FakeScenario["seq"],
  forge?: string,
) {
  const runner = fakeRunner(root);
  const stream = claudeStream(root, "tu1", "claude/b6-hostile-repo.jsonl");
  const scenario = (s: FakeScenario["seq"]) => runner.write({ fixture: stream, seq: { review: [{ review: CLEAN }], ...s } });
  scenario(seq);
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: forge ?? "http://127.0.0.1:9", userSlug: forge ? FAKE_USER : "u", notifications: false });
  const secrets = createSecrets(null);
  if (forge) await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir: dataDir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const jobs = createReviewJobs({ settings, live, dataDir, runnerCommand: runner.command, repoRemote: remote, listTools: stubListTools });
  const db = jobs.open() as Database;
  const loop = createLoop({ review: jobs, settings, live });
  jobs.onStop(() => loop.shutdown());
  cleanups.unshift(async () => {
    await jobs.stop();
    db.close();
  });
  const empty = join(root, "identity.gitconfig");
  writeFileSync(empty, "");
  const clone = join(root, "clone");
  const env = gitEnv(empty);
  await git(["init", "-q", clone], { env });
  await git(["-C", clone, "config", "user.name", WHO.name], { env });
  await git(["-C", clone, "config", "user.email", WHO.email], { env });
  db.query("INSERT INTO repo_clone (project, repo, path, updated_at) VALUES ('PROJ', $repo, $path, 0)").run({ repo, path: clone });
  writeFileSync(join(root, "check.ts"), CHECK);
  const mode = (m: string) => writeFileSync(join(root, "check-mode.txt"), m);
  mode("feature");
  const commands = [{ id: "t", name: "test", kind: "test", argv: [process.execPath, join(root, "check.ts")], timeoutSec: 60 }];
  db.query(
    `INSERT INTO repo_task_settings (project, repo, commands_json, line_budget, warned_at, updated_at)
    VALUES ('PROJ', $repo, $commands, 400, 1, 1)`,
  ).run({ repo, commands: JSON.stringify(commands) });
  const addTask = (base: string, target: string) => {
    const plan = toPlan(SPEC, base, [false], []);
    const docs = { ...renderDocs(KEY, "Add the feature", "small", plan), version: 1, parsed: plan, approved: true };
    const id = (
      db
        .query(
          `INSERT INTO task (project, repo, key, title, state, size, size_by, target_branch, base_commit, spec_dir, docs_json, estimate_json,
            settings_json, created_at, updated_at)
          VALUES ('PROJ', $repo, $key, 'Add the feature', 'implementing', 'small', 'claude', $target, $base, $dir, $docs, $estimate, '{}', 1, 1)
          RETURNING id`,
        )
        .get({
          repo,
          key: KEY,
          target,
          base,
          dir: `specs/${KEY}/`,
          docs: JSON.stringify(docs),
          estimate: JSON.stringify(plan.estimate),
        }) as {
        id: number;
      }
    ).id;
    return { id, plan: (docs.plan as string).replace(/### \[ \] T1\.1/, "### [x] T1.1") };
  };
  return { dataDir, settings, live, jobs, db, loop, scenario, mode, addTask };
}

// The views of one task for the assertions.
function views(root: string, db: Database, task: number, wt: () => Promise<Worktree>, base: string) {
  const record = join(root, "calls.jsonl");
  const runCalls = () => readRecords<Call>(record).filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  const modeOf = (c: Call) => /^- Mode: (\w+)$/m.exec(c.stdin)?.[1] ?? (c.argv.join(" ").includes('"verdicts"') ? "verify" : "review");
  const steps = () =>
    (
      db.query("SELECT id, kind, state, item, attempt, detail_json FROM task_step WHERE task = $id ORDER BY id").all({ id: task }) as (Omit<
        Step,
        "detail"
      > & { detail_json: string })[]
    ).map(({ detail_json, ...s }) => ({ ...s, detail: stepDetail.parse(JSON.parse(detail_json)) }));
  const flow = () => steps().map((s) => `${s.kind}:${s.item ?? "-"}:${s.state}`);
  const t = () => taskRow(db, task) as NonNullable<ReturnType<typeof taskRow>>;
  const blocked = () => {
    const b = t().blocked_json;
    return b === null ? null : (JSON.parse(b) as TaskBlocked);
  };
  const part = () =>
    db.query("SELECT id, head, pushed, lines, state FROM task_part WHERE task = $id").get({ id: task }) as {
      id: number;
      head: string;
      pushed: string | null;
      lines: number | null;
      state: string;
    };
  // The subjects and parents of the part branch since the first base.
  const log = async () => {
    const x = await wt();
    return (await git([`--git-dir=${x.admin}`, "log", "--format=%s|%P", `${base}..HEAD`], { env: x.env }))
      .trim()
      .split("\n")
      .filter(Boolean);
  };
  return { runCalls, modeOf, steps, flow, t, blocked, part, log };
}

export type Setup = {
  seq?: FakeScenario["seq"];
  // The base branch of the task. A branch other than main starts at the base commit of main.
  base?: string;
  // Each entry is one more commit of the part after the plan commit, with these files.
  commits?: Record<string, string>[];
};

// One repository PROJ/repo with a built part: the plan commit adds src/feature.ts.
export async function builtTask(o: Setup = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-tu1-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const baseName = o.base ?? "main";
  if (baseName !== "main") await git(["--git-dir", r.remote, "update-ref", `refs/heads/${baseName}`, r.base], { env: r.env });
  const a = await app(root, async () => ({ url: r.remote, config: [] }), "repo", o.seq);
  const { db, dataDir } = a;
  const { base } = await taskCache(dataDir, r.remote);
  const { id: task, plan } = a.addTask(base, baseName);
  const wt = () => openWorktree({ dataDir, db, project: "PROJ", repo: "repo", task, ord: 1, branch: BRANCH, base });
  const w = await wt();
  await write(w, { [`specs/${KEY}/plan.md`]: plan, "src/feature.ts": "export const feature = 'works';\n" });
  let head = (await commitStep(w, `${KEY}: Add the plan`, WHO)) as string;
  for (const files of o.commits ?? []) {
    await write(w, files);
    head = (await commitStep(w, `${KEY}: more`, WHO)) as string;
  }
  db.query(
    `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, head, created_at, updated_at)
    VALUES ($task, 1, 'single', 'Add the feature', $branch, $base, 'self_reviewed', $head, 1, 1)`,
  ).run({ task, branch: BRANCH, base: baseName, head });
  return { root, r, ...a, base, task, wt, ...views(root, db, task, wt, base) };
}

// PROJ/app with the submodules of repos-fixture.ts: lib (edit), lib/deep (read), and vendor (another server). The base of app is
// appBase; lib takes its default branch main. One commit changes src/feature.ts in app and lib.c in lib, with the parent gitlink.
// forge: the fake Bitbucket is the configured server. other: a second editable submodule PROJ/other at other/, which the commit also
// changes.
export async function multiTask(o: { seq?: FakeScenario["seq"]; appBase?: string; forge?: boolean; other?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-tu1m-")));
  dirs.push(root);
  const fake = startFakeBitbucket();
  cleanups.push(() => fake.stop());
  const other = o.other ? await bareRepo(root, "other", { "other.c": "int other;\n" }) : null;
  const m = await multiRepo(root, fake, other ? { extraLinks: { other: other.base }, extraModules: { other: "../other.git" } } : {});
  if (other) {
    m.remotes.other = other.remote;
    m.forges.other = repoWrites(fake, "PROJ", "other");
  }
  const appBase = o.appBase ?? "main";
  if (appBase !== "main") await git(["--git-dir", m.app.remote, "update-ref", `refs/heads/${appBase}`, m.app.base], { env: m.app.env });
  const a = await app(root, m.remote, "app", o.seq, o.forge ? fake.url : undefined);
  const { db, dataDir } = a;
  const { id: task, plan } = a.addTask(m.app.base, appBase);
  await mainCache(dataDir, m);
  await resolveTaskRepos(db, depsOf(m, dataDir), taskRow(db, task) as NonNullable<ReturnType<typeof taskRow>>, m.app.base);
  const part = (
    db
      .query(
        `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
        VALUES ($task, 1, 'single', 'Add the feature', $branch, $base, 'self_reviewed', 1, 1) RETURNING id`,
      )
      .get({ task, branch: BRANCH, base: appBase }) as { id: number }
  ).id;
  const wt = () => openWorktree({ dataDir, db, project: "PROJ", repo: "app", task, ord: 1, branch: BRANCH, base: m.app.base });
  const trees = async () =>
    openRepoTrees({
      dataDir,
      db,
      task,
      ord: 1,
      branch: BRANCH,
      main: await wt(),
      rows: taskRepos(db, taskRow(db, task) as NonNullable<ReturnType<typeof taskRow>>),
    });
  const tree = async (full: string) => (await trees()).find((x) => x.full === full) as RepoTree;
  const main = await wt();
  await trees();
  await write(main, {
    [`specs/${KEY}/plan.md`]: plan,
    "src/feature.ts": "export const feature = 'works';\n",
    "lib/lib.c": "int lib = 2;\n",
    ...(other && { "other/other.c": "int other = 2;\n" }),
  });
  const r = await commitTask({
    db,
    task,
    part,
    wt: main,
    item: "T1.1",
    message: `${KEY}: Add the plan`,
    who: WHO,
    allow: [],
    trees: await trees(),
  });
  if (r.status !== "committed") throw new Error(`The fixture commit failed: ${JSON.stringify(r)}`);
  return { root, m, fake, other, ...a, base: m.app.base, task, wt, trees, tree, ...views(root, db, task, wt, m.app.base) };
}

// PROJ/app with the added repository PROJ/lib (spec.md section 6.16.5, Proposals: the user clicked Add), and the fake Bitbucket as the
// configured server. The spec-run resolve fetched the base of lib. built: one part with one commit in app and lib; else no part, so the
// loop builds it.
export async function addedTask(o: { seq?: FakeScenario["seq"]; built?: boolean } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-mr2a-")));
  dirs.push(root);
  const fake = startFakeBitbucket();
  cleanups.push(() => fake.stop());
  const appRepo = await bareRepo(root, "app", { "README.md": "app\n", "src/app.ts": "export const app = 1;\n" });
  const lib = await bareRepo(root, "lib", { "lib.c": "int lib;\n", "CLAUDE.md": "lib rules\n" });
  const forges = { app: repoWrites(fake, "PROJ", "app"), lib: repoWrites(fake, "PROJ", "lib") };
  const remotes: Record<string, string> = { app: appRepo.remote, lib: lib.remote };
  const remote = async (project: string, repo: string) => {
    const url = remotes[repo];
    if (project !== "PROJ" || !url) throw new Error(`No remote for ${project}/${repo}.`);
    return { url, config: [] as [string, string][] };
  };
  const a = await app(root, remote, "app", o.seq, fake.url);
  const { db, dataDir } = a;
  const { id: task, plan } = a.addTask(appRepo.base, "main");
  await fetchInto(dataDir, "PROJ", "app", { url: appRepo.remote, config: [] }, ["+refs/heads/main:refs/rl/task/1/target"]);
  const libRow = (
    db
      .query(
        `INSERT INTO task_repo (task, role, project, repo, depth, access, base_branch, proposal, proposal_reason, created_at)
        VALUES ($task, 'added', 'PROJ', 'lib', 0, 'edit', 'main', 'added', 'The client lives there.', 1) RETURNING id`,
      )
      .get({ task }) as { id: number }
  ).id;
  const deps: RepoDeps = { dataDir, provider: async () => createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN }), remote };
  const t = () => taskRow(db, task) as NonNullable<ReturnType<typeof taskRow>>;
  const snapshot = await resolveTaskRepos(db, deps, t(), appRepo.base);
  const wt = () => openWorktree({ dataDir, db, project: "PROJ", repo: "app", task, ord: 1, branch: BRANCH, base: appRepo.base });
  const trees = async () => openRepoTrees({ dataDir, db, task, ord: 1, branch: BRANCH, main: await wt(), rows: taskRepos(db, t()) });
  if (o.built) {
    const part = (
      db
        .query(
          `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($task, 1, 'single', 'Add the feature', $branch, 'main', 'self_reviewed', 1, 1) RETURNING id`,
        )
        .get({ task, branch: BRANCH }) as { id: number }
    ).id;
    const all = await trees();
    const main = all[0]?.wt as Worktree;
    await write(main, { [`specs/${KEY}/plan.md`]: plan, "src/feature.ts": "export const feature = 'works';\n" });
    await write(all.find((x) => x.row.id === libRow)?.wt as Worktree, { "lib.c": "int lib = 2;\n" });
    const r = await commitTask({
      db,
      task,
      part,
      wt: main,
      item: "T1.1",
      message: `${KEY}: Add the plan`,
      who: WHO,
      allow: [],
      trees: all,
    });
    if (r.status !== "committed") throw new Error(`The fixture commit failed: ${JSON.stringify(r)}`);
  }
  return { root, fake, forges, appRepo, lib, libRow, snapshot, deps, ...a, task, wt, trees, ...views(root, db, task, wt, appRepo.base) };
}
