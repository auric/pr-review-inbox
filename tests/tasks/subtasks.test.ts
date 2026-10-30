// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.20.1 to 6.20.5, 6.20.7, and 6.20.8 (WP-ST2, AC-B72 server part, AC-B73 to AC-B77): the create of
// a task with Jira sub-tasks, the sub-task files, context/subtasks.md, the found work of the spec run, the app checks of the plan, the
// plan approval with tracked PRs, and "Ask Claude again". The fake CLI, the fake Bitbucket, the fake Jira, and a temp git remote. No test
// starts the real CLI or reaches a forge or Jira.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { SUBTASKS_RULE, subtaskSpecRules } from "../../src/server/review/catalog";
import { git } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { approveSubtasks, checkSubtaskPlan, type SubtaskRow } from "../../src/server/tasks/subtasks";
import { ADOPTED, type TaskRow, taskFilesOf, taskRow } from "../../src/server/tasks/tasks";
import type { ApiError, TaskDto, TaskIssueDto } from "../../src/shared/dto";
import { MAX_OPEN_DEFAULT, namesKey, specResult, subtasksFirst } from "../../src/shared/task";
import { FAKE_TOKEN, FAKE_USER, key, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { echoSpec, readRecords } from "../support/fake-claude";
import { ISSUE_KEY, JIRA_TOKEN, logOf, pngOf, SUBTASK_PARENT, startFakeJira } from "../support/fake-jira";
import { claudeStream, fakeRunner, stubListTools } from "../support/review-fixture";
import { taskRemote } from "./fixture";

for (const m of ["tasks/tasks", "tasks/subtasks", "context/task-file", "review/workspace"])
  console.log(`subtasks.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
const SLOW = 120_000;
const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SESSION = "s".repeat(64);
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const NO_QUESTIONS = { done: true, summary: "Echo: build the sub-tasks.", questions: [], unknowns: [], coverage: NO_COVERAGE };
const MB = 1024 * 1024;

type Call = {
  argv: string[];
  stdin: string;
  context: Record<string, string>;
  attachments: string[];
  agents?: Record<string, { prompt: string }> | null;
};

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

// A spec result part in sub-task mode.
const part = (n: number, o: Record<string, unknown>) => ({ ...echoSpec().parts[0], n, title: `Part ${n}`, ...o });

async function setup(spec: unknown = echoSpec()) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-st2-")));
  dirs.push(root);
  const r = await taskRemote(root);
  const runner = fakeRunner(root);
  runner.write({ fixture: claudeStream(root, "st2", "claude/b6-hostile-repo.jsonl"), interview: NO_QUESTIONS, spec });
  const fake = startFakeBitbucket();
  const w = repoWrites(fake, "PROJ", "repo");
  const jira = startFakeJira();
  jira.addSubtaskSet();
  const dataDir = join(root, "data");
  writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir: dataDir, secrets, jiraSecrets: createSecrets(null, "jira-token") });
  const live = createLive();
  const review = createReviewJobs({
    settings,
    live,
    dataDir,
    runnerCommand: runner.command,
    repoRemote: async () => ({ url: r.remote, config: [] }),
    listTools: stubListTools,
    claudeConfigDir: join(root, "no-claude-config"),
  });
  const db = review.open() as Database;
  const app = createApp({ port: PORT, token: SESSION, live, settings, review });
  cleanup.unshift(async () => {
    await review.stop();
    fake.stop();
    jira.stop();
    db.close();
  });
  const json = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: HEADERS,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  expect((await json("/api/settings/jira", { method: "PUT", body: { baseUrl: jira.url, token: JIRA_TOKEN } })).status).toBe(200);
  const get = async (id: number) => (await json<TaskDto>(`/api/tasks/${id}`)).body;
  const settle = async (id: number) => {
    for (;;) {
      await review.wait();
      if (!review.busy()) return get(id);
    }
  };
  const create = (body: Record<string, unknown> = {}) =>
    json<TaskDto & ApiError>("/api/tasks", { body: { project: "PROJ", repo: "repo", key: SUBTASK_PARENT, ...body } });
  const calls = () => readRecords<Call>(join(root, "calls.jsonl")).filter((c) => Array.isArray(c.argv) && c.argv.includes("-p"));
  // The requests that change a fake server: every method but GET.
  const writes = () => [...fake.requests, ...jira.requests].filter((x) => !x.startsWith("GET ")).length;
  // An open PR on the fake. It is a write of the test setup.
  const openPr = async (title: string, branch: string) => {
    const res = await fetch(`${fake.url}${w.path}/pull-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ title, fromRef: { id: `refs/heads/${branch}` }, toRef: { id: "refs/heads/main" } }),
    });
    return ((await res.json()) as { id: number }).id;
  };
  // Lists a file of this size on a Jira issue.
  const attach = (issue: string, id: string, filename: string, o: { png?: boolean; size?: number } = {}) =>
    jira.attach(issue, {
      id,
      filename,
      mimeType: o.png ? "image/png" : "text/plain",
      body: o.png ? pngOf(300) : logOf(64),
      ...(o.size !== undefined && { size: o.size }),
    });
  return { root, r, db, fake, w, jira, json, get, settle, create, calls, writes, openPr, attach, dataDir };
}

describe("the key token and the mode choice (spec.md sections 6.20.1 and 6.20.2)", () => {
  test("AC-B74: the key matches as a whole token in a branch name or a PR title; ABC-1 never matches ABC-12", () => {
    for (const s of ["feature/ABC-12-x", "ABC-12: x", "bugfix/ABC-12", "[ABC-12] x", "ABC-12"]) expect(namesKey(s, "ABC-12")).toBe(true);
    for (const s of ["feature/ABC-123-x", "XABC-12", "abc-12", "ABC-1"]) expect(namesKey(s, "ABC-12")).toBe(false);
    expect(namesKey("feature/ABC-12-x", "ABC-1")).toBe(false);
    // A key that fails JIRA_KEY never builds a pattern.
    expect(namesKey("x.*", ".*")).toBe(false);
  });

  test("AC-B72: one sub-task that is not done preselects the sub-tasks", () => {
    expect(subtasksFirst([{ category: "done" }, { category: "new" }])).toBe(true);
    expect(subtasksFirst([{ category: "done" }])).toBe(false);
    expect(subtasksFirst([{ category: null }])).toBe(true);
    expect(subtasksFirst([])).toBe(false);
  });

  test("the sub-task prompt lines have at most 20 words per sentence (ASD-STE100)", () => {
    const long = [SUBTASKS_RULE, ...subtaskSpecRules(400)]
      .flatMap((l) => l.split(/(?<=[.?!])\s+/))
      .filter((s) => s.split(/\s+/).length > 20);
    expect(long).toEqual([]);
  });
});

// task_subtask rows of the plan checks. found: the found_json items.
const row = (k: string, o: Partial<SubtaskRow> & { found?: unknown[] } = {}): SubtaskRow => {
  const { found, ...rest } = o;
  return {
    key: k,
    ord: 1,
    summary: `Do ${k}`,
    status: "To Do",
    category: "new",
    issue_json: "{}",
    links_json: "[]",
    found_json: JSON.stringify(found ?? []),
    read_at: 1,
    status_at: 1,
    added_at: null,
    removed_at: null,
    ...rest,
  };
};
const openPrOf = (pr: number, branch: string) => ({ kind: "pr", pr, title: "x", branch, target: "main", state: "OPEN" });

describe("the app checks of the plan (spec.md section 6.20.4, AC-B75)", () => {
  test("keys, a part with no key left, a done lower sub-task, an unknown after, a cycle, a sub-task without a part, maxOpen absent", () => {
    const rows = [
      row("ABC-2"),
      row("ABC-3", { found: [openPrOf(41, "feature/ABC-3-x")] }),
      row("ABC-4", { category: "done", issue_json: null }),
      row("ABC-5"),
      row("ABC-6"),
      row("ABC-7"),
    ];
    const r = specResult.parse({
      ...echoSpec(),
      parts: [
        part(1, { keys: ["ABC-2", "ABC-3"], start: "stack", after: "ABC-4" }),
        part(2, { keys: ["ABC-5"], start: "merge", after: "5" }),
        part(3, { keys: ["ABC-6"], start: "stack", after: "4" }),
        part(4, { keys: ["ABC-7"], start: "merge", after: "3" }),
        part(5, { keys: ["ABC-4"], start: "base" }),
      ],
    });
    const p = checkSubtaskPlan(r, rows, "develop");
    expect(p.notes).toEqual([
      "Part 1 names ABC-3, which is no open sub-task without a PR. The part leaves it out.",
      "Part 5 names ABC-4, which is no open sub-task without a PR. The part leaves it out.",
      "Part 5 builds no open sub-task without a PR. The app leaves it out.",
      "ABC-2 needs ABC-4, which is done. It starts from develop.",
      // Part 5 gets no row, so no part can build on it.
      "ABC-5 builds on 5, which is no part of the plan. It starts from develop.",
      "ABC-6 cannot build on ABC-7, because ABC-7 builds on ABC-6.",
    ]);
    expect(p.starts.map((s) => [s.n, s.keys, s.start, s.after, s.skip])).toEqual([
      [1, ["ABC-2"], "base", null, false],
      [2, ["ABC-5"], "base", null, false],
      [3, ["ABC-6"], "stack", "4", false],
      [4, ["ABC-7"], "merge", "3", false],
      [5, [], "base", null, true],
    ]);
    expect(p.maxOpen).toEqual({ value: MAX_OPEN_DEFAULT, reason: "" });
    // A buildable sub-task in no part.
    const q = checkSubtaskPlan(specResult.parse({ ...echoSpec(), parts: [part(1, { keys: ["ABC-2"] })], maxOpen: 2 }), rows, "main");
    expect(q.notes).toEqual(["Claude planned no PR for ABC-5.", "Claude planned no PR for ABC-6.", "Claude planned no PR for ABC-7."]);
    expect(q.maxOpen.value).toBe(2);
  });

  test("the approval: a pick of several open PRs, a cycle, an unknown after, a split, and the continue rule", () => {
    const t = { key: "ABC-1", title: "Parent", target_branch: "main" };
    const plan = [
      { n: 1, title: "One" },
      { n: 2, title: "Two" },
      { n: 3, title: "Three" },
    ];
    const rows = [
      row("ABC-2", { found: [{ kind: "branch", name: "bugfix/ABC-2-old" }] }),
      row("ABC-3", { found: [{ kind: "branch", name: "feature/ABC-3-old" }] }),
      row("ABC-4", { found: [openPrOf(41, "feature/ABC-4-a"), openPrOf(42, "feature/ABC-4-b")] }),
      row("ABC-5", { category: "done", issue_json: null }),
    ];
    const sub = {
      starts: [
        { n: 1, keys: ["ABC-2"], start: "base" as const, after: null, reason: "", skip: false },
        { n: 2, keys: ["ABC-2"], start: "stack" as const, after: "1", reason: "", skip: false },
        { n: 3, keys: ["ABC-3"], start: "stack" as const, after: "ABC-4", reason: "", skip: false },
      ],
      maxOpen: { value: 2, reason: "Two side by side." },
      notes: [],
    };
    const base = { t, plan, sub, rows, prefix: "feature/", specDir: "specs/{key}/" };
    expect(approveSubtasks({ ...base, input: undefined })).toBe("Pick the PR that the app tracks for ABC-4.");
    const track = [{ key: "ABC-4", pr: 42 }];
    const input = (parts: { n: number; start: "base" | "stack" | "merge"; after: string | null; existing?: "continue" | "new" }[]) => ({
      ...base,
      input: { parts, track, maxOpen: 5 },
    });
    expect(approveSubtasks({ ...base, input: { parts: [], track: [{ key: "ABC-4", pr: 7 }], maxOpen: 5 } })).toEqual({
      bad: "PR #7 is no open PR of ABC-4.",
    });
    expect(approveSubtasks(input([{ n: 9, start: "base", after: null }]))).toEqual({ bad: "Part 9 is not in the plan." });
    expect(
      approveSubtasks(
        input([
          { n: 1, start: "stack", after: "2" },
          { n: 2, start: "stack", after: "1" },
        ]),
      ),
    ).toBe("ABC-2 (1 of 2) cannot build on ABC-2 (2 of 2), because ABC-2 (2 of 2) builds on ABC-2 (1 of 2).");
    expect(approveSubtasks(input([{ n: 3, start: "merge", after: "ABC-9" }]))).toBe("ABC-3 builds on ABC-9, which is no part of the plan.");
    expect(approveSubtasks(input([{ n: 1, start: "base", after: null, existing: "continue" }]))).toBe(
      "The app pushes only to names like feature/ABC-2-….",
    );
    const ok = approveSubtasks(input([]));
    if (typeof ok === "string" || "bad" in ok) throw new Error(JSON.stringify(ok));
    expect(ok.maxOpen).toBe(5);
    expect(ok.parts.map((p) => [p.n, p.keys, p.branch, p.base, p.start, p.after, p.specDir, p.pr?.pr ?? null])).toEqual([
      // A split sub-task: part branches and a part-2 folder.
      [1, ["ABC-2"], "feature/ABC-2-1-do-abc-2", "main", "base", null, "specs/ABC-2/", null],
      [2, ["ABC-2"], "feature/ABC-2-2-do-abc-2", "feature/ABC-2-1-do-abc-2", "stack", "1", "specs/ABC-2/part-2/", null],
      // Continue on the found branch that passes the push name rule. It builds on the tracked PR of ABC-4.
      [3, ["ABC-3"], "feature/ABC-3-old", "feature/ABC-4-b", "stack", "ABC-4", "specs/ABC-3/", null],
      [null, ["ABC-4"], "feature/ABC-4-b", "main", "base", null, null, 42],
    ]);
    // A start after a done sub-task starts from the base. "Start a new branch" takes the planned name.
    const fresh = approveSubtasks(input([{ n: 3, start: "merge", after: "ABC-5", existing: "new" }]));
    if (typeof fresh === "string" || "bad" in fresh) throw new Error(JSON.stringify(fresh));
    expect([fresh.parts[2]?.branch, fresh.parts[2]?.start, fresh.parts[2]?.after]).toEqual(["feature/ABC-3-do-abc-3", "base", null]);
    // No input: Claude's maxOpen.
    const plain = approveSubtasks({ ...base, rows: rows.slice(0, 2), sub: { ...sub, starts: sub.starts.slice(0, 2) }, input: undefined });
    if (typeof plain === "string" || "bad" in plain) throw new Error(JSON.stringify(plain));
    expect(plain.maxOpen).toBe(2);
  });
});

describe("create, sub-task files, and subtasks.md (spec.md sections 6.20.1 and 6.20.3, AC-B72, AC-B73, AC-B77)", () => {
  test(
    "the issue route lists the sub-tasks; the create reads each open sub-task once, drops another parent, and stores the files per issue",
    async () => {
      const h = await setup();
      const issue = await h.json<TaskIssueDto>("/api/tasks/issue", { body: { key: SUBTASK_PARENT } });
      expect(issue.status).toBe(200);
      expect(issue.body.subtasks.map((s) => [s.key, s.category])).toEqual([
        ["ABC-11", "done"],
        ["ABC-12", "indeterminate"],
        ["ABC-13", "new"],
        ["ABC-14", "new"],
      ]);
      expect(subtasksFirst(issue.body.subtasks)).toBe(true);
      expect((await h.json<TaskIssueDto>("/api/tasks/issue", { body: { key: ISSUE_KEY } })).body.subtasks).toEqual([]);
      // ABC-14 names another parent: the create drops it.
      const route = h.jira.routes[key("GET", "/rest/api/2/issue/ABC-14")] as { body: { fields: Record<string, unknown> } };
      route.body.fields.parent = { key: "ABC-99" };
      // The same file name in two issues, with two attachment IDs.
      h.attach(SUBTASK_PARENT, "9001", "notes.txt");
      h.attach("ABC-12", "9002", "shot.png", { png: true });
      h.attach("ABC-13", "9003", "shot.png", { png: true });
      const reads = (k: string) => h.jira.count("GET", `/rest/api/2/issue/${k}`);
      const before = { parent: reads(SUBTASK_PARENT), done: reads("ABC-11") };
      const files = { files: ["9001"], subtaskFiles: [{ key: "ABC-12", files: ["9002"] }] };
      expect((await h.create({ ...files, subtaskFiles: [{ key: "ABC-11", files: [] }] })).body.error).toBe(
        "ABC-11 is no open sub-task of ABC-10.",
      );
      expect((await h.create({ ...files, subtasks: false })).body.error).toBe("ABC-10 has no sub-tasks to build.");
      const c = await h.create({ files: ["9001"], subtaskFiles: [...files.subtaskFiles, { key: "ABC-13", files: ["9003"] }] });
      expect(c.status).toBe(201);
      // The two refused creates and this one read the parent once each. Each open sub-task: once per create that reached the reads.
      expect(reads(SUBTASK_PARENT) - before.parent).toBe(3);
      expect(reads("ABC-11") - before.done).toBe(0);
      expect([reads("ABC-12"), reads("ABC-13"), reads("ABC-14")]).toEqual([2, 2, 2]);
      expect(h.jira.requests.filter((x) => /\/subtask(?:[/?]|$)/.test(x.split(" ")[1] ?? ""))).toEqual([]);
      const t = await h.settle(c.body.id);
      expect(t.subtasks?.map((s) => [s.key, s.category, s.links])).toEqual([
        ["ABC-11", "done", []],
        ["ABC-12", "indeterminate", []],
        ["ABC-13", "new", [{ text: "is blocked by", key: "ABC-12" }]],
      ]);
      expect(t.subtasks?.[1]?.attachments.map((a) => a.id)).toContain("9002");
      expect(t.files.map((f) => [f.id, f.issue ?? null])).toEqual([
        ["9001", null],
        ["9002", "ABC-12"],
        ["9003", "ABC-13"],
      ]);
      expect(h.db.query("SELECT subtasks FROM task WHERE id = $id").get({ id: t.id })).toEqual({ subtasks: 1 });

      // The interview gets subtasks.md and every ticked file, each issue in its own folder.
      const [interview] = h.calls();
      const md = interview?.context["subtasks.md"] ?? "";
      expect(md).toContain("# Sub-tasks of ABC-10");
      expect(md).toContain("## Sub-task ABC-11: Batch the cache writes\n\n- Status: Done\n- Jira says that it is done");
      expect(md).toContain("## Sub-task ABC-13: Flush before the write lock");
      expect(md).toContain("- Link: ABC-13 is blocked by ABC-12.");
      expect(md).toContain("shot.png: 300 bytes, image/png. Included as ./attachments/ABC-12/9002.png.");
      expect(md).toContain("shot.png: 300 bytes, image/png. Included as ./attachments/ABC-13/9003.png.");
      expect(md).not.toContain("ABC-14");
      expect(interview?.context["task.md"]).toContain("notes.txt: 64 bytes, text/plain. Included as ./attachments/9001.txt.");
      expect(interview?.context["task.md"]).not.toContain("9002");
      expect(interview?.attachments).toEqual(["9001.txt", "ABC-12", "ABC-13"]);
      expect(interview?.agents?.["rl-main"]?.prompt).toContain(SUBTASKS_RULE);

      // AC-B77: a part run gets the task files and only the files of its own sub-task keys.
      const row = taskRow(h.db, t.id) as TaskRow;
      const one = taskFilesOf(h.db, h.dataDir, row, { keys: ["ABC-12"] });
      expect(one.attachments.map((a) => a.name)).toEqual(["9001.txt", "ABC-12/9002.png"]);
      const text = one.files.find((f) => f.name === "subtasks.md")?.text ?? "";
      expect(text).toContain("shot.png: 300 bytes, image/png. Included as ./attachments/ABC-12/9002.png.");
      expect(text).toContain("shot.png: 300 bytes, image/png. Not included.");
      expect(taskFilesOf(h.db, h.dataDir, row).attachments.map((a) => a.name)).toEqual(["9001.txt", "ABC-12/9002.png", "ABC-13/9003.png"]);
    },
    SLOW,
  );

  test(
    "the caps count the files of the parent and of its sub-tasks together; nothing downloads and no task exists after a refusal",
    async () => {
      const h = await setup();
      for (const [issue, ids] of [
        [SUBTASK_PARENT, ["9101", "9102", "9103"]],
        ["ABC-12", ["9201", "9202", "9203"]],
      ] as const)
        for (const id of ids) h.attach(issue, id, `big-${id}.log`, { size: 90 * MB });
      const c = await h.create({ files: ["9101", "9102", "9103"], subtaskFiles: [{ key: "ABC-12", files: ["9201", "9202", "9203"] }] });
      expect([c.status, c.body.error]).toEqual([413, "The files of this task would pass 500 MB. Untick files first."]);
      expect(h.jira.requests.filter((x) => x.includes("/secure/attachment/"))).toEqual([]);
      expect(h.db.query("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
    },
    SLOW,
  );
});

describe("found work, the plan, and its approval (spec.md sections 6.20.2, 6.20.4, 6.20.5, AC-B74 to AC-B76)", () => {
  test(
    "the spec run finds PRs and branches by key; the approval tracks PRs, checks the order, and pushes and posts nothing",
    async () => {
      const spec = {
        ...echoSpec(),
        estimate: { ...echoSpec().estimate, parts: 2 },
        parts: [
          part(1, { keys: ["ABC-13"], start: "stack", after: "ABC-12", startReason: "It calls the generator of ABC-12." }),
          part(2, { keys: ["ABC-11"], start: "stack", after: "ABC-11", startReason: "It reuses the batch." }),
        ],
      };
      const h = await setup(spec);
      // ABC-12: one open PR. ABC-14: two open PRs. ABC-13: a branch with no PR. A merged PR of ABC-1 matches no sub-task.
      const gen = await h.openPr("ABC-12: Add the event generator", "feature/ABC-12-gen");
      const a = await h.openPr("Measure the lock wait (ABC-14)", "feature/ABC-14-a");
      const b = await h.openPr("ABC-14 second try", "bugfix/lock-wait");
      const old = await h.openPr("Speed up", "feature/speed");
      h.w.merge(old);
      const merged = h.w.prs.get(old) as unknown as Record<string, number>;
      merged.closedDate = (merged.createdDate as number) + 2 * 86_400_000;
      h.fake.routes[key("GET", `${h.w.path}/pull-requests/${gen}/changes`)] = {
        status: 200,
        body: { size: 1, limit: 25, start: 0, isLastPage: true, values: [{ path: { toString: "src/gen.ts" }, type: "ADD" }] },
      };
      const flush = await h.r.g(["commit-tree", `${h.r.base}^{tree}`, "-p", h.r.base, "-m", "Flush the cache first"]);
      await h.r.g(["update-ref", "refs/heads/feature/ABC-13-flush", flush]);
      h.w.branches.names.push("feature/ABC-13-flush", "feature/ABC-1-old");
      h.db.run(
        `INSERT INTO pull_request (project, repo, pr_id, title, source_branch, target_branch, state, my_role)
          VALUES ('PROJ', 'repo', 40, 'ABC-1: old work', 'feature/ABC-1-old', 'main', 'MERGED', 'AUTHOR')`,
      );

      const c = await h.create();
      expect(c.status).toBe(201);
      const t = await h.settle(c.body.id);
      expect(t.state).toBe("spec_draft");
      expect([t.size, t.sizeBy]).toEqual(["small", "rule"]);
      const specCall = h.calls().find((x) => x.context["pr-history.md"] !== undefined);
      const md = specCall?.context["subtasks.md"] ?? "";
      expect(md).toContain(`  - PR #${gen} (OPEN) from feature/ABC-12-gen to main: ABC-12: Add the event generator`);
      expect(md).toContain("      - src/gen.ts");
      expect(md).toContain("  - Branch feature/ABC-13-flush, with no PR.\n    - Commits:\n      - Flush the cache first");
      expect(md).toContain(`  - PR #${a} (OPEN) from feature/ABC-14-a`);
      expect(md).toContain(`  - PR #${b} (OPEN) from bugfix/lock-wait`);
      expect(md).not.toContain("ABC-1-old");
      expect(md).not.toContain("The app searches the branches");
      expect(specCall?.context["pr-history.md"]).toEndWith(
        "# Your PRs in PROJ/repo\n\n- Open PRs that you wrote: 0.\n- Median time from open to merge of your 1 newest merged PRs: 2.0 days.",
      );
      for (const line of subtaskSpecRules(400)) expect(specCall?.agents?.["rl-main"]?.prompt).toContain(line);
      // One branch search per open sub-task, one open-PR list, and the changes of the open PRs.
      const gets = (p: string) => h.fake.requests.filter((x) => x.startsWith(`GET ${h.w.path}${p}`));
      expect(gets("/branches?").map((x) => new URL(`http://x${x.slice(4)}`).searchParams.get("filterText"))).toEqual([
        "ABC-12",
        "ABC-13",
        "ABC-14",
      ]);
      expect(gets("/pull-requests?state=OPEN")).toHaveLength(1);
      expect(gets("/pull-requests?state=MERGED")).toHaveLength(1);
      const cache = join(h.dataDir, "git", "PROJ", "repo.git");
      expect((await git(["--git-dir", cache, "rev-parse", `refs/rl/task/${t.id}/found/1`], { env: h.r.env })).trim()).toBe(flush);
      // The app checks: a done key leaves the part, and a part with no key left gets no row.
      expect(t.plan?.notes).toEqual([
        "Part 2 names ABC-11, which is no open sub-task without a PR. The part leaves it out.",
        "Part 2 builds no open sub-task without a PR. The app leaves it out.",
      ]);
      expect(t.plan?.maxOpen).toEqual({ value: MAX_OPEN_DEFAULT, reason: "" });
      expect(t.plan?.starts.map((s) => [s.n, s.keys, s.start, s.after, s.reason, s.skip])).toEqual([
        [1, ["ABC-13"], "stack", "ABC-12", "It calls the generator of ABC-12.", false],
        [2, [], "stack", "ABC-11", "It reuses the batch.", true],
      ]);

      const approve = async (subtasks?: unknown) =>
        h.json<TaskDto & ApiError>(`/api/tasks/${t.id}/plan`, {
          body: {
            version: (await h.get(t.id)).version,
            size: "small",
            commands: [],
            warning: true,
            ...(subtasks !== undefined && { subtasks }),
          },
        });
      const writes = h.writes();
      expect((await approve()).body.error).toBe("Pick the PR that the app tracks for ABC-14.");
      const track = [{ key: "ABC-14", pr: b }];
      const plan = (parts: unknown[], maxOpen = 4) => ({ parts, track, maxOpen });
      expect((await approve(plan([], 6))).status).toBe(400);
      expect((await approve({ ...plan([]), track: [{ key: "ABC-14", pr: gen }] })).body.error).toBe(`PR #${gen} is no open PR of ABC-14.`);
      expect((await approve(plan([{ n: 2, start: "base", after: null }]))).body.error).toBe("Part 2 is not in the plan.");
      const unknown = await approve(plan([{ n: 1, start: "merge", after: "2" }]));
      expect([unknown.status, unknown.body.error]).toEqual([409, "ABC-13 builds on 2, which is no part of the plan."]);
      const ok = await approve(plan([]));
      expect(ok.status).toBe(200);
      // AC-B75: the approval pushes nothing and posts nothing.
      expect(h.writes()).toBe(writes);
      const done = ok.body;
      expect(done.state).toBe("implementing");
      expect(done.settings.maxOpen).toBe(4);
      const byKey = (k: string) => done.parts.find((p) => p.keys[0] === k);
      const tracked = byKey("ABC-12");
      expect(done.parts.map((p) => [p.ord, p.keys, p.branch, p.baseBranch, p.start, p.adopted, p.specDir, p.state, p.remotePr])).toEqual([
        [1, ["ABC-13"], "feature/ABC-13-flush", "feature/ABC-12-gen", "stack", false, "specs/ABC-13/", "planned", null],
        [2, ["ABC-12"], "feature/ABC-12-gen", "main", "base", true, null, "pr_open", gen],
        [3, ["ABC-14"], "bugfix/lock-wait", "main", "base", true, null, "pr_open", b],
      ]);
      expect(done.parts[0]?.after).toBe(tracked?.id ?? -1);
      // AC-B76: the task follows the tracked PRs, so the sync reads them.
      const followed = h.db
        .query("SELECT pr_id, followed FROM pull_request WHERE pr_id IN ($a, $b, $gen) ORDER BY pr_id")
        .all({ a, b, gen });
      expect(followed).toEqual([gen, b].sort((x, y) => x - y).map((pr_id) => ({ pr_id, followed: 1 })));
      expect(done.subtasks?.find((s) => s.key === "ABC-12")?.parts).toEqual([tracked?.id ?? -1]);

      // AC-B76: Tell Claude and an update on a tracked PR stop before git runs. The build loop of the approval ends first: it finds no
      // part to start before WP-ST3.
      const end = Date.now() + 20_000;
      while ((await h.get(t.id)).working) {
        if (Date.now() > end) throw new Error("Timed out.");
        await Bun.sleep(20);
      }
      const idle = await h.get(t.id);
      expect([idle.state, idle.blocked, idle.parts.find((p) => !p.adopted)?.state]).toEqual(["implementing", null, "planned"]);
      const runs = h.calls().length;
      const version = (await h.get(t.id)).version;
      const tell = await h.json<ApiError>(`/api/tasks/${t.id}/instructions`, { body: { version, part: tracked?.id, text: "Rename it." } });
      expect([tell.status, tell.body.error]).toEqual([409, ADOPTED]);
      const update = await h.json<ApiError>(`/api/tasks/${t.id}/parts/${tracked?.id}/update`, { body: { version } });
      expect([update.status, update.body.error]).toEqual([409, ADOPTED]);
      expect(h.calls().length).toBe(runs);
      expect(h.db.query("SELECT COUNT(*) AS n FROM task_step WHERE kind IN ('instruct', 'update')").get()).toEqual({ n: 0 });
      expect(h.writes()).toBe(writes);
    },
    SLOW,
  );

  test(
    "a plan with tracked PRs only goes to ready at the approval; a merged PR gets ADOPT_MERGED",
    async () => {
      const h = await setup({ ...echoSpec(), parts: [part(1, { keys: ["ABC-13"] })] });
      for (const k of ["ABC-12", "ABC-13", "ABC-14"]) await h.openPr(`${k}: done outside`, `feature/${k}-x`);
      // ABC-12 merged before: the stored row holds it, and the open list no longer does.
      const first = [...h.w.prs.keys()][0] as number;
      h.w.merge(first);
      h.db
        .query(
          `INSERT INTO pull_request (project, repo, pr_id, title, source_branch, target_branch, state)
          VALUES ('PROJ', 'repo', $id, 'ABC-12: done outside', 'feature/ABC-12-x', 'main', 'MERGED')`,
        )
        .run({ id: first });
      const c = await h.create();
      const t = await h.settle(c.body.id);
      expect(t.plan?.notes).toEqual([
        "Part 1 names ABC-13, which is no open sub-task without a PR. The part leaves it out.",
        "Part 1 builds no open sub-task without a PR. The app leaves it out.",
      ]);
      const writes = h.writes();
      const r = await h.json<TaskDto>(`/api/tasks/${t.id}/plan`, {
        body: { version: t.version, size: "small", commands: [], warning: true },
      });
      expect(r.status).toBe(200);
      expect(h.writes()).toBe(writes);
      expect(r.body.parts.map((p) => [p.ord, p.keys, p.state, p.adopted])).toEqual([
        [1, ["ABC-12"], "merged", true],
        [2, ["ABC-13"], "pr_open", true],
        [3, ["ABC-14"], "pr_open", true],
      ]);
      expect(r.body.state).toBe("ready");
    },
    SLOW,
  );
});

describe('"Ask Claude again" (spec.md sections 6.20.4 and 6.20.12)', () => {
  test(
    "plan-again runs the spec run again with the text as an answer line; add needs a key that is new in Jira",
    async () => {
      const h = await setup();
      const c = await h.create({ subtasks: false });
      const t = await h.settle(c.body.id);
      expect([t.state, t.subtasks]).toEqual(["spec_draft", null]);
      const again = (body: Record<string, unknown>) => h.json<TaskDto & ApiError>(`/api/tasks/${t.id}/plan-again`, { body });
      expect((await again({ version: t.version, text: "" })).status).toBe(400);
      expect((await again({ version: t.version - 1, text: "Use one part." })).status).toBe(409);
      expect((await again({ version: t.version, text: "x", add: true })).body.error).toBe("No sub-task is new in Jira.");
      const r = await again({ version: t.version, text: "Use one part only." });
      expect(r.status).toBe(202);
      expect(r.body.docs).toBeNull();
      const next = await h.settle(t.id);
      expect(next.state).toBe("spec_draft");
      expect(next.docs).not.toBeNull();
      const specs = h.calls().filter((x) => x.context["answers.md"] !== undefined);
      expect(specs.at(-1)?.context["answers.md"]).toContain(
        "### Question 1: What should the new plan change?\n\n- Why: You asked Claude to write the plan again.\n- Answer of the user:",
      );
      expect(specs.at(-1)?.context["answers.md"]).toContain("Use one part only.");
      expect(next.questions.at(-1)?.answer).toEqual({ choice: null, text: "Use one part only." });
    },
    SLOW,
  );
});
