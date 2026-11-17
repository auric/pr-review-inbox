// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/ps6-ps7-plan.md PS6-B (AC-B387 to AC-B395): PR comments on a task PR. The comment run of the part session, its
// drafts, the comments route, TaskPartDto.comments, and the push that awaits one sync. The fake CLI writes real files in the part
// worktree, a temp bare remote holds the repository, and the PR rows are stored rows. No test reaches a forge or starts the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { currentDrafts } from "../../src/server/review/drafts";
import { UNTRUSTED } from "../../src/server/review/workspace";
import { createPrOpener } from "../../src/server/tasks/pr";
import { groupsOf, NO_TASK_PR, partComments } from "../../src/server/tasks/task-pr";
import { HELD_TELL } from "../../src/server/tasks/tasks";
import { commitStep } from "../../src/server/tasks/worktree";
import { type TaskDto, taskCommentsInput } from "../../src/shared/dto";
import { shortHash } from "../../src/shared/outcome";
import type { ReplyPayload } from "../../src/shared/review";
import { stepDetail } from "../../src/shared/task";
import { readRecords } from "../support/fake-claude";
import {
  type Call,
  cleanupAll,
  FIXED,
  KEY,
  MAX_TURNS,
  NO_COVERAGE,
  type Setup,
  SLOW,
  setup,
  TEST_FILE,
  TICK,
  until,
  WORKS,
} from "./loop-fixture";
import { builtTask, cleanup as cleanupBuilt, WHO, write } from "./update-fixture";

for (const m of ["tasks/loop", "tasks/task-pr", "tasks/implement", "tasks/pr", "review/pr-context"])
  console.log(`comments.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanupAll);

const S = "a".repeat(40);
const SESSION = "s".repeat(64);
const ORIGIN = "http://127.0.0.1:7317";
const HEADERS = { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" };
const MORE = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const renamed = true;\n" };
const result = (points: { id: number; verdict: "fixed" | "pushback"; reason: string }[]) => ({
  summary: "Done.",
  done: true,
  tests: [],
  question: null,
  specChange: "",
  notes: [],
  coverage: NO_COVERAGE,
  points: points.map((p) => ({ why: p.verdict === "pushback" ? "invalid" : null, cite: "", ...p })),
});
// The sorted threads: 101 valid in group 1, 102 invalid in group 2, 103 a question in group 3.
const SORT = [
  { thread: 101, judgement: "valid", group: 1, body: "Agreed, I will rename it." },
  { thread: 102, judgement: "invalid", group: 2, body: "The name is fine." },
  { thread: 103, judgement: "question", group: 3, body: "It runs once." },
] as const;

type Built = Awaited<ReturnType<typeof setup>>;
const detail = (s: Built, id: number) => stepDetail.parse(JSON.parse(s.steps().find((x) => x.id === id)?.detail_json ?? "{}"));
const instructRows = (s: Built) => s.steps().filter((x) => x.kind === "instruct");
const comments = (s: Built) => instructRows(s).map((x) => detail(s, x.id).instruct?.comments ?? null);

// A built part with an open PR of the app, three threads of a reviewer, and a reply run that sorted them.
async function prTask(o: Setup = {}) {
  const s = await setup({ ...o, seq: { "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }], ...o.seq } });
  await s.build();
  const p = s.part();
  const pr = (
    s.db
      .query(
        `INSERT INTO pull_request (project, repo, pr_id, title, author_slug, author_name, my_role, state, source_head, target_head,
          meta_head, source_branch, target_branch, updated_date, on_dashboard, followed)
        VALUES ('PROJ', 'repo', 7, 'T', 'u', 'U', 'AUTHOR', 'OPEN', $s, $t, $s || ':' || $t, $branch, 'main', 1, 1, 1) RETURNING id`,
      )
      .get({ s: p.head, t: s.base, branch: p.branch }) as { id: number }
  ).id;
  s.db.query("UPDATE task_part SET pr = $pr, remote_pr = 7, state = 'pr_open', pushed = head WHERE id = $id").run({ pr, id: p.id });
  for (const t of SORT)
    s.db
      .query(
        `INSERT INTO comment (pr, comment_id, version, parent_id, root_id, author_slug, author_name, text, thread_resolved, created_at,
          updated_at) VALUES ($pr, $id, 0, NULL, $id, 'alex', 'Alex', $text, 0, $at, $at)`,
      )
      .run({ pr, id: t.thread, text: `Comment ${t.thread}: please rename feature.`, at: t.thread });
  const run = (
    s.db
      .query(
        `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, finished_at)
        VALUES ($pr, 'reply', 'general', '', 'k', $s, $t, 'completed', 1, 1) RETURNING id`,
      )
      .get({ pr, s: p.head, t: s.base }) as { id: number }
  ).id;
  for (const t of SORT) {
    const payload: ReplyPayload = {
      thread: t.thread,
      action: "reply",
      body: t.body,
      reason: "r",
      evidenceStatus: "code",
      judgement: t.judgement,
      group: t.group,
      replyTo: t.thread,
      origin: "reply",
    };
    s.db
      .query("INSERT INTO review_item (run, kind, payload_json, body, status, thread) VALUES ($run, 'reply', $p, $body, 'new', $thread)")
      .run({ run, p: JSON.stringify(payload), body: t.body, thread: t.thread });
  }
  const send = (threads: number[], version = s.t().version) => s.loop.comments(s.db, s.task, p.id, { version, threads });
  const draft = (thread: number) => {
    const r = currentDrafts(s.db, pr).get(thread);
    return r ? { body: r.body, payload: JSON.parse(r.payload_json) as ReplyPayload } : null;
  };
  const dto = () => partComments(s.db, { id: p.id, pr }, "u");
  return { s, pr, run, part: p.id, send, draft, dto };
}

describe("the comment run of a task part (ps6-ps7-plan.md PS6-B)", () => {
  test(
    "AC-B389, AC-B390, AC-B391: a push-back only gives no commit, a nofix draft, one note per unknown or missing verdict, and no Your instructions",
    async () => {
      const h = await prTask({
        seq: {
          "implement:comments": [
            {
              implement: result([
                { id: 102, verdict: "pushback", reason: "The name follows the plan." },
                { id: 999, verdict: "fixed", reason: "x" },
              ]),
            },
          ],
        },
      });
      const { s } = h;
      const head = s.part().head;
      const r = h.send([101, 102]);
      expect(r.status).toBe(202);
      await s.loop.idle(s.task);
      const call = s.runCalls().find((c) => s.modeOf(c) === "comments") as Call;
      expect(call).toBeDefined();
      expect(call.stdin).not.toContain("# Your instructions");
      expect(call.stdin).not.toContain('"Your instructions"');
      expect(call.stdin).toContain("Give one entry in points for each thread. Set id to the thread number.");
      const file = call.context["comments.md"] as string;
      expect(file.startsWith(UNTRUSTED)).toBe(true);
      expect(file).toContain("## Group 1");
      expect(file).toContain("### Thread 101 · general comment");
      expect(file).toContain("## Group 2");
      expect(file).not.toContain("Thread 103");
      expect(call.context["step.md"]).toContain("- Mode: comments");
      expect(call.context["failure.md"]).toBeUndefined();
      expect(s.flow().slice(-1)).toEqual(["instruct:C1:ok"]);
      expect(s.part().head).toBe(head);
      const row = instructRows(s)[0] as NonNullable<ReturnType<typeof instructRows>[number]>;
      const d = detail(s, row.id);
      expect(d.instruct).toMatchObject({ purpose: "comments", result: "no_change" });
      expect(d.instruct?.comments).toMatchObject({
        pr: h.pr,
        run: h.run,
        threads: [
          { thread: 101, replyTo: 101, group: 1 },
          { thread: 102, replyTo: 102, group: 2 },
        ],
        verdicts: [{ thread: 102, verdict: "pushback", reason: "The name follows the plan." }],
        drafted: true,
      });
      expect(d.notes).toContain("Claude gave a verdict for thread 999, which the run did not send. The app dropped it.");
      expect(d.notes).toContain("No verdict for thread 101.");
      // AC-B391: the push-back is a nofix draft of the reply run. 101 got no verdict, so its sort draft stays.
      expect(h.draft(102)?.payload).toMatchObject({ origin: "nofix", judgement: null });
      expect(h.draft(102)?.payload.fix).toBeUndefined();
      expect(h.draft(102)?.body).toBe("The name is fine.\n\nThe name follows the plan.");
      expect(h.draft(101)?.payload.origin).toBe("reply");
      // AC-B387: the run is sent, so no sorted run waits.
      expect(h.dto()).toMatchObject({ sorted: null });
    },
    SLOW,
  );

  test(
    "AC-B392, AC-B393: a fix gives the gate, one commit, the own review, and a Fixed in draft with fix.id null and the full commit",
    async () => {
      const h = await prTask({
        seq: {
          "implement:comments": [
            {
              writes: [MORE],
              implement: result([
                { id: 101, verdict: "fixed", reason: "Renamed the flag." },
                { id: 102, verdict: "pushback", reason: "The name follows the plan." },
              ]),
            },
          ],
        },
      });
      const { s } = h;
      const at = s.phases.length;
      expect(h.send([101, 102]).status).toBe(202);
      await s.loop.idle(s.task);
      // Section 2.1: only existing phase edges.
      expect(s.phases.slice(at).map((p) => `${p.event}>${p.to}`)).toEqual([
        "GO>following",
        "RUN_DONE>checking",
        "CHECKS_GREEN>idle",
        "GO>reviewing",
        "CLEAN>idle",
      ]);
      expect(s.flow().slice(-4)).toEqual(["instruct:C1:ok", "check:C1:ok", "commit:C1:ok", "review:review:ok"]);
      expect((await s.log()).at(-1)).toBe(`Ada Example <ada@example.invalid>|${KEY}: Address the PR comments of part 1`);
      const head = s.part().head as string;
      expect(h.draft(101)?.body).toBe(`Agreed, I will rename it.\n\nFixed in ${shortHash(head)}: Renamed the flag.`);
      expect(h.draft(101)?.payload).toMatchObject({ origin: "fix", fix: { id: null, commit: head }, resolve: false });
      expect(h.draft(102)?.payload.origin).toBe("nofix");
      expect(comments(s)[0]).toMatchObject({ drafted: true });
      expect(detail(s, instructRows(s)[0]?.id as number).instruct).toMatchObject({ result: "done", committed: true });
    },
    SLOW,
  );

  test(
    "AC-B392: after red checks, the Fixed in draft comes with the commit after Continue",
    async () => {
      const h = await prTask({
        runLimits: { testFixTries: 1 },
        seq: {
          "implement:comments": [{ writes: [MORE], implement: result([{ id: 101, verdict: "fixed", reason: "Renamed the flag." }]) }],
          "implement:fix": [{ writes: [FIXED] }],
        },
      });
      const { s } = h;
      s.mode("red");
      const commits = () => s.flow().filter((x) => x.startsWith("commit:")).length;
      const before = commits();
      expect(h.send([101]).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.blocked()).toMatchObject({ kind: "red" });
      expect(commits()).toBe(before);
      expect(h.draft(101)?.payload.origin).toBe("reply");
      expect(comments(s)[0]).toMatchObject({ drafted: false, verdicts: [{ thread: 101, verdict: "fixed" }] });
      s.mode("feature");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      const head = s.part().head as string;
      expect(commits()).toBe(before + 1);
      expect(h.draft(101)?.payload).toMatchObject({ origin: "fix", fix: { id: null, commit: head } });
      expect(h.draft(101)?.body).toContain(`Fixed in ${shortHash(head)}: Renamed the flag.`);
      expect(comments(s)[0]).toMatchObject({ drafted: true });
    },
    SLOW,
  );

  test(
    "AC-B392: a Stop that undoes the work writes no Fixed in draft, and a later commit does not claim the fix",
    async () => {
      const h = await prTask({
        runLimits: { testFixTries: 1 },
        seq: {
          "implement:comments": [{ writes: [MORE], implement: result([{ id: 101, verdict: "fixed", reason: "Renamed the flag." }]) }],
          "implement:fix": [{ hang: true }],
          "implement:instruct": [{ writes: [FIXED] }],
        },
      });
      const { s } = h;
      s.mode("red");
      expect(h.send([101]).status).toBe(202);
      const record = join(s.root, "calls.jsonl");
      await until(() => readRecords<{ argv?: string[]; stdin?: string }>(record).some((x) => /^- Mode: fix$/m.test(x.stdin ?? "")));
      await until(() => s.steps().some((x) => x.kind === "fix" && x.state === "running"));
      expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      const row = instructRows(s)[0] as NonNullable<ReturnType<typeof instructRows>[number]>;
      expect(detail(s, row.id).notes).toContain("Stopped. The app undid the work on the PR comments, so it wrote no Fixed-in draft.");
      expect(comments(s)[0]).toMatchObject({ drafted: true });
      expect(h.draft(101)?.payload.origin).toBe("reply");
      s.mode("feature");
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag checked." }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.flow().filter((x) => x.startsWith("commit:I"))).toHaveLength(1);
      expect(h.draft(101)?.payload.origin).toBe("reply");
    },
    SLOW,
  );

  test(
    "AC-B389: the comment run takes the part session: a fork with the resume gate on, a new session with continue.md with it off",
    async () => {
      for (const resume of [false, true]) {
        const h = await prTask({
          sessionGates: { resume, live: true, resolve: false },
          seq: { "implement:comments": [{ implement: result([{ id: 101, verdict: "pushback", reason: "Fine as it is." }]) }] },
        });
        expect(h.send([101]).status).toBe(202);
        await h.s.loop.idle(h.s.task);
        const call = h.s.runCalls().find((c) => h.s.modeOf(c) === "comments") as Call;
        expect(call.argv.includes("--resume")).toBe(resume);
        if (resume) {
          expect(call.stdin).toContain("# Run 2: PR comments");
          expect(call.context["continue.md"]).toBeUndefined();
        } else expect(call.context["continue.md"]).toContain("# The earlier work on this part");
        expect(call.context["comments.md"]).toContain("### Thread 101");
        const row = instructRows(h.s)[0] as NonNullable<ReturnType<typeof instructRows>[number]>;
        expect(detail(h.s, row.id).session).toMatchObject({ purpose: "comments", resumed: resume });
        expect(h.draft(101)?.payload.origin).toBe("nofix");
        await cleanupAll();
      }
    },
    SLOW * 2,
  );
});

describe("the comments route and TaskPartDto.comments (ps6-ps7-plan.md section 3, AC-B387, AC-B388)", () => {
  test(
    "the refusals, one waiting row per send with item C<n>, and a cut run runs again with the same comments",
    async () => {
      const h = await prTask({
        seq: { "implement:comments": [{ fixture: MAX_TURNS }, { implement: result([{ id: 101, verdict: "pushback", reason: "Fine." }]) }] },
      });
      const { s } = h;
      // AC-B387: the sorted run by group, and the threads that wait for the reply.
      expect(h.dto()).toEqual({
        turn: 3,
        accepted: 0,
        sorted: {
          run: h.run,
          groups: SORT.map((t) => ({
            n: t.group,
            threads: [{ thread: t.thread, place: "general comment", judgement: t.judgement, body: t.body, item: expect.any(Number) }],
          })),
        },
      });
      expect(partComments(s.db, { id: h.part, pr: null }, "u")).toBeNull();
      // The routes fill TaskPartDto.comments, and the input schema refuses a thread twice.
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const call = (method: string, path: string, body?: unknown) =>
        app.request(`${ORIGIN}${path}`, { method, headers: HEADERS, ...(body !== undefined && { body: JSON.stringify(body) }) });
      const got = (await (await call("GET", `/api/tasks/${s.task}`)).json()) as TaskDto;
      expect(got.parts[0]?.comments).toEqual(h.dto());
      const twice = await call("POST", `/api/tasks/${s.task}/parts/${h.part}/comments`, { version: s.t().version, threads: [101, 101] });
      expect([twice.status, ((await twice.json()) as { error: string }).error]).toEqual([400, "Give each thread once."]);
      const conflict = (r: ReturnType<typeof h.send>) => [r.status, (r as { error: string }).error];
      expect(conflict(h.send([101], s.t().version - 1))[0]).toBe(409);
      expect(conflict(h.send([104]))).toEqual([400, "Thread 104 is not in the newest sorted run."]);
      s.db.query("UPDATE task_part SET blocked_json = $b WHERE id = $id").run({
        b: JSON.stringify({ kind: "held", step: null, text: "On hold." }),
        id: h.part,
      });
      expect(conflict(h.send([101]))).toEqual([409, HELD_TELL(1)]);
      s.db.query("UPDATE task_part SET blocked_json = NULL WHERE id = $id").run({ id: h.part });
      s.db.query("UPDATE task_part SET adopted = 1 WHERE id = $id").run({ id: h.part });
      expect(conflict(h.send([101]))).toEqual([409, NO_TASK_PR]);
      expect(h.dto()).toBeNull();
      s.db.query("UPDATE task_part SET adopted = 0 WHERE id = $id").run({ id: h.part });
      expect(h.send([102, 101]).status).toBe(202);
      await s.loop.idle(s.task);
      // The run is sent now.
      expect(conflict(h.send([101]))).toEqual([409, "Sort the comments first."]);
      // The first run reached its turn cap, so the follow-up ran again on a new row with the same item and comments.
      const rows = instructRows(s);
      expect(rows.map((x) => [x.item, x.state])).toEqual([
        ["C1", "failed"],
        ["C1", "ok"],
      ]);
      const sent = detail(s, (rows[1] as (typeof rows)[number]).id).instruct;
      expect(sent).toMatchObject({ purpose: "comments", text: "Address the PR comments of part 1" });
      expect(sent?.comments).toMatchObject({
        run: h.run,
        threads: [
          { thread: 102, replyTo: 102, group: 2 },
          { thread: 101, replyTo: 101, group: 1 },
        ],
        verdicts: [{ thread: 101, verdict: "pushback", reason: "Fine." }],
      });
      // A newer sort is not sent yet.
      s.db
        .query(
          `INSERT INTO review_run (pr, kind, profile, note, idem_key, source_head, target_head, status, started_at, finished_at)
          VALUES ($pr, 'reply', 'general', '', 'k2', $s, $s, 'incomplete', 2, 2)`,
        )
        .run({ pr: h.pr, s: S });
      expect(h.dto()?.sorted).toEqual({ run: expect.any(Number), groups: [] });
      expect(conflict(h.send([101]))).toEqual([400, "Thread 101 is not in the newest sorted run."]);
    },
    SLOW,
  );

  test("groupsOf orders the groups by number and gives a thread without a group its own number after the highest", () => {
    const t = (thread: number, group: number | null) => ({ thread, group });
    expect(groupsOf([t(5, 2), t(6, null), t(7, 1), t(8, 2), t(9, null)])).toEqual([
      { n: 1, threads: [t(7, 1)] },
      { n: 2, threads: [t(5, 2), t(8, 2)] },
      { n: 3, threads: [t(6, null)] },
      { n: 4, threads: [t(9, null)] },
    ]);
    expect(groupsOf([t(1, null)])).toEqual([{ n: 1, threads: [t(1, null)] }]);
  });

  test("taskCommentsInput takes 1 to 25 thread IDs, each once", () => {
    expect(taskCommentsInput.safeParse({ version: 1, threads: [1, 2] }).success).toBe(true);
    expect(taskCommentsInput.safeParse({ version: 1, threads: [] }).success).toBe(false);
    expect(taskCommentsInput.safeParse({ version: 1, threads: [1, 1] }).success).toBe(false);
    expect(taskCommentsInput.safeParse({ version: 1, threads: Array.from({ length: 26 }, (_, i) => i + 1) }).success).toBe(false);
  });
});

describe("Push to <branch> awaits one sync cycle (ps6-ps7-plan.md section 1 item 7, AC-B395)", () => {
  // The loop fixture key K-1 fails the key rule of pushRefusal, so this test takes the built part of update-fixture.ts.
  afterEach(cleanupBuilt);
  test(
    "the answer waits for the sync, and a sync that does not end lets the answer go after the wait",
    async () => {
      const s = await builtTask();
      const partId = s.part().id;
      let release: () => void = () => {};
      let syncs = 0;
      const op = createPrOpener({
        review: s.jobs,
        settings: s.settings,
        live: s.live,
        working: s.loop.running,
        syncNow: () => {
          syncs++;
          return new Promise<void>((done) => {
            release = done;
          });
        },
      });
      let answered = false;
      const push = op.pushNow(s.db, s.task, partId, { version: s.t().version }).then((r) => {
        answered = true;
        return r;
      });
      await until(() => syncs === 1);
      // The push is on the server before the sync starts.
      expect(s.part().pushed).toBe(s.part().head);
      await Bun.sleep(200);
      expect(answered).toBe(false);
      release();
      expect((await push).status).toBe(202);

      // A forge that never answers: the cap ends the wait.
      const w = await s.wt();
      await write(w, { "src/feature.ts": "export const feature = 'works';\nexport const more = true;\n" });
      const head = (await commitStep(w, "TU-1: more", WHO, ["src/feature.ts"])) as string;
      s.db.query("UPDATE task_part SET head = $head WHERE id = $id").run({ head, id: partId });
      const slow = createPrOpener({
        review: s.jobs,
        settings: s.settings,
        live: s.live,
        working: s.loop.running,
        syncNow: () => new Promise<void>(() => {}),
        syncWaitMs: 50,
      });
      expect((await slow.pushNow(s.db, s.task, partId, { version: s.t().version })).status).toBe(202);
      expect(s.part().pushed).toBe(head);
      await op.shutdown();
      await slow.shutdown();
    },
    SLOW,
  );
});
