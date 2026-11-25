// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/thorough-review.md WP-T1c: review runs of the variant "twice" with the fake CLI, a temp git remote, and a temp
// data folder. One test per row of section 3. No test starts the real CLI.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { SHIPPED_PROFILES, twice } from "../../src/server/review/catalog";
import { git, gitEnv } from "../../src/server/review/git";
import { createReviewJobs } from "../../src/server/review/jobs";
import { cachePath } from "../../src/server/review/workspace";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import type { ProfileInput, ReviewItemDto, RunDetail, RunDto } from "../../src/shared/dto";
import { type FindingPayload, REVIEW_PROMPT_VERSION } from "../../src/shared/review";
import { FAKE_TOKEN, FAKE_USER } from "../support/fake-bitbucket";
import { readRecords } from "../support/fake-claude";
import { claudeStream, fakeRunner, reviewRemote, stubListTools } from "../support/review-fixture";

process.env.REVIEW_LOOP_SECRETS = "memory";
console.log(`twice.test.ts imported from ${Bun.resolveSync("../../src/server/review/jobs", import.meta.dir)}`);

const SLOW = 120_000;
const general = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];
// thorough-review.md D4.
const ARM_SEQ = 1_000_000;

const dirs: string[] = [];
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

type Call = {
  argv: string[];
  cwd: string;
  stdin: string;
  pid: number;
  context: Record<string, string>;
  agents: Record<string, { prompt: string }>;
};
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] as string;
const FLUSH = [
  "export function flush(cache: Cache) {",
  "for (const entry of cache.dirty()) {",
  "const lock = cache.lock();",
  "write(entry);",
  "lock.release();",
  "}",
];
// A finding on line of FLUSH. The cause on added line 3 keeps a finding on a context line.
const F = (line: number, body: string) => ({
  path: "src/cache/flush.ts",
  side: "new",
  line,
  lineEnd: null,
  anchorText: FLUSH[line - 1],
  severity: "major",
  category: "Correctness",
  body,
  evidence: "",
  evidenceStatus: "code",
  confidence: "high",
  agent: null,
  trigger: `A flush reaches line ${line}.`,
  cause: { path: "src/cache/flush.ts", side: "new", line: 3, lineEnd: null, anchorText: FLUSH[2] },
});
const NONE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const RESULT = (findings: unknown[], summary = "One line.") => ({ summary, risks: [], questions: [], coverage: NONE, findings });
// The regex keys of the fake byCwd: the run folder of arm 1 is runs/<id>, the one of arm 2 is runs/<id>-2.
const ARM1 = "^\\d+$";
const ARM2 = "-2$";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "rl-twice-"));
  dirs.push(root);
  const remote = await reviewRemote(root, { 2: "source" });
  const runner = fakeRunner(root);
  let streams = 0;
  const stream = (structured: unknown) => claudeStream(root, `s${streams++}`, "claude-synthetic/review-agent-tree.jsonl", structured);
  const raw = (file: string) => claudeStream(root, `r${streams++}`, `claude-synthetic/${file}.jsonl`);
  const always = { ...general.reviewer, mode: "always" as const };
  const profiles: ProfileInput[] = [
    general,
    { ...general, id: "twice", name: "Twice", variants: ["twice"], reviewer: always },
    { ...general, id: "lenses3", name: "Lenses twice", variants: ["lenses3", "twice"], reviewer: always },
  ];
  const dir = join(root, "data");
  writeConfig(dir, { baseUrl: "http://127.0.0.1:9", userSlug: FAKE_USER, notifications: false, markAi: false, profiles });
  const secrets = createSecrets(null);
  await secrets.set(FAKE_TOKEN);
  const settings = createSettings({ dir, secrets });
  const db = settings.db() as Database;
  const review = createReviewJobs({
    settings,
    live: createLive(),
    dataDir: dir,
    runnerCommand: runner.command,
    gitRemote: remote.gitRemote,
    listTools: stubListTools,
  });
  cleanup.unshift(async () => {
    await review.stop();
    settings.close();
  });
  const { id: pr } = db
    .query(
      `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
        source_branch, target_branch, updated_date, on_dashboard, followed)
      VALUES ('PROJ', 'repo', 2, 'Synthetic change', NULL, 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target,
        'feature', 'main', 1000, 1, 1) RETURNING id`,
    )
    .get({ source: remote.source, target: remote.target }) as { id: number };
  const start = (profile: string) => {
    const r = review.review(db, pr, profile);
    expect(r.status).toBe(202);
    return (r as { run: RunDto }).run.id;
  };
  const done = async (id: number) => {
    await review.wait();
    return review.run(db, id) as RunDetail;
  };
  const calls = () => readRecords<Call>(join(root, "calls.jsonl")).filter((c) => c.argv?.includes("-p"));
  const isVerify = (c: Call) => flag(c.argv, "--json-schema").includes('"verdicts"');
  const finders = () => calls().filter((c) => !isVerify(c));
  const verifies = () => calls().filter(isVerify);
  // The arm of a call by its run folder: 1 or 2.
  const armOf = (c: Call) => (basename(dirname(c.cwd)).endsWith("-2") ? 2 : 1);
  const kinds = () => calls().map((c) => `${isVerify(c) ? "verify" : "find"}${armOf(c)}`);
  const findings = (d: RunDetail) => d.items.filter((i) => i.kind === "finding");
  const payload = (i: ReviewItemDto) => i.payload as FindingPayload;
  const version = (id: number) =>
    (db.query("SELECT prompt_version FROM review_run WHERE id = $id").get({ id }) as { prompt_version: string }).prompt_version;
  const runs = join(realpathSync.native(dir), "runs");
  const gaps = (d: RunDetail) => (d.run.summary?.coverage.skipped ?? []).filter((l) => l.startsWith("Run "));
  return {
    root,
    dir,
    db,
    pr,
    remote,
    review,
    runner,
    stream,
    raw,
    start,
    done,
    calls,
    finders,
    verifies,
    armOf,
    kinds,
    findings,
    payload,
    version,
    runs,
    gaps,
  };
}

// Every event ID of a run of two arms names its arm (D4).
const armEvents = (d: RunDetail) => d.events.filter((e) => !/^(check:)?pass[12]:/.test(e.id));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("twice (catalog)", () => {
  test("twice needs the variant; lenses3 and runs3 win", () => {
    expect(twice({ variants: ["twice"] })).toBe(true);
    expect(twice({ variants: [] })).toBe(false);
    expect(twice({ variants: ["lenses3", "twice"] })).toBe(false);
    expect(twice({ variants: ["runs3", "twice"] })).toBe(false);
    expect(twice({ variants: ["twice", "verify2"] })).toBe(true);
  });
});

describe("review runs of the variant twice (thorough-review.md WP-T1c)", () => {
  test(
    "the default profile makes one finder and one verify call, with untagged events, no pass, and no second run folder",
    async () => {
      const h = await setup();
      h.runner.write({ fixture: h.stream(RESULT([F(3, "One.")])) });
      const id = h.start("general");
      const d = await h.done(id);
      expect(d.run.status).toBe("completed");
      expect(h.kinds()).toEqual(["find1", "verify1"]);
      expect(h.calls().map((c) => basename(dirname(c.cwd)))).toEqual([String(id), String(id)]);
      expect(d.events.filter((e) => /^(check:)?pass\d+:/.test(e.id))).toEqual([]);
      expect(d.events.some((e) => e.tool === "Pass")).toBe(false);
      expect(d.events.some((e) => e.id.startsWith("check:"))).toBe(true);
      expect(h.findings(d).map((i) => "pass" in h.payload(i))).toEqual([false]);
      expect(d.run.summary?.runs).toBeUndefined();
      expect(h.version(id)).toBe(REVIEW_PROMPT_VERSION);
      expect(existsSync(join(h.runs, `${id}-2`))).toBe(false);
    },
    SLOW,
  );

  test(
    "rows A1 and J1: two finder and two verify calls in their own folders with byte-identical prompts, D4 events, and merged copies",
    async () => {
      const h = await setup();
      // Arm 2 repeats the arm 1 point on line 1 one line away, and adds a point 4 lines away.
      h.runner.write({
        fixture: h.stream(RESULT([F(1, "A one.")])),
        delayMs: 20,
        byCwd: { [ARM2]: { fixture: h.stream(RESULT([F(2, "B copy."), F(5, "B five.")], "Other line.")) } },
      });
      const id = h.start("twice");
      const d = await h.done(id);
      expect(d.run.status).toBe("completed");
      expect(h.kinds().slice(0, 2).sort()).toEqual(["find1", "find2"]);
      expect(h.kinds().slice(2).sort()).toEqual(["verify1", "verify2"]);
      // Own cwd, app folder, and runner per arm.
      const [a, b] = [1, 2].map((k) => h.finders().find((c) => h.armOf(c) === k) as Call) as [Call, Call];
      expect(basename(dirname(a.cwd))).toBe(String(id));
      expect(basename(dirname(b.cwd))).toBe(`${id}-2`);
      expect(a.cwd).not.toBe(b.cwd);
      for (const name of ["--mcp-config", "--agents"]) {
        expect(dirname(flag(a.argv, name))).toBe(join(dirname(a.cwd), "app"));
        expect(dirname(flag(b.argv, name))).toBe(join(dirname(b.cwd), "app"));
      }
      expect(a.pid).not.toBe(b.pid);
      // Byte-identical finder prompts. The verify agents match too; the stdin names the candidate count of each arm.
      expect(b.agents).toEqual(a.agents);
      expect(Object.keys(a.agents).sort()).toEqual(["rl-main", "rl-reviewer"]);
      expect(b.stdin).toBe(a.stdin);
      expect(flag(b.argv, "--json-schema")).toBe(flag(a.argv, "--json-schema"));
      const [va, vb] = [1, 2].map((k) => h.verifies().find((c) => h.armOf(c) === k) as Call) as [Call, Call];
      expect(vb.agents).toEqual(va.agents);
      expect(va.cwd).toBe(a.cwd);
      expect(vb.cwd).toBe(b.cwd);
      expect(va.context["candidates.md"]?.match(/^## Candidate \d+$/gm)).toEqual(["## Candidate 1"]);
      expect(vb.context["candidates.md"]?.match(/^## Candidate \d+$/gm)).toEqual(["## Candidate 1", "## Candidate 2"]);
      // D4: the marks, the prefixes, and the seq ranges. Both marks come before every finder event: both finders start in one tick.
      expect(armEvents(d)).toEqual([]);
      const marks = d.events.filter((e) => e.tool === "Pass");
      expect(marks.map((e) => [e.id, e.note, e.seq])).toEqual([
        ["pass1:start", "Run 1 of 2.", 0],
        ["pass2:start", "Run 2 of 2.", ARM_SEQ],
      ]);
      const lastMark = Math.max(...marks.map((e) => e.startedAt));
      const work = d.events.filter((e) => e.tool !== "Pass" && !e.id.startsWith("check:"));
      expect(work.some((e) => e.id.startsWith("pass1:"))).toBe(true);
      expect(work.some((e) => e.id.startsWith("pass2:"))).toBe(true);
      for (const e of work) expect(e.startedAt).toBeGreaterThanOrEqual(lastMark);
      for (const k of [1, 2]) expect(d.events.some((e) => e.id.startsWith(`check:pass${k}:`))).toBe(true);
      for (const e of d.events) {
        const two = /^(check:)?pass2:/.test(e.id);
        expect([e.id, two ? e.seq >= ARM_SEQ : e.seq < ARM_SEQ]).toEqual([e.id, true]);
      }
      const ids = d.events.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of d.events.filter((x) => x.parent !== null)) expect(ids).toContain(e.parent as string);
      // The merge: arm 1 then arm 2, pass per arm, and the arm 2 copy hidden as an app duplicate of the arm 1 item.
      const f = h.findings(d);
      expect(f.map((i) => [i.body, h.payload(i).pass, i.status])).toEqual([
        ["A one.", 1, "new"],
        ["B copy.", 2, "discarded"],
        ["B five.", 2, "new"],
      ]);
      const copy = h.payload(f[1] as ReviewItemDto);
      expect(copy.discardedBy).toBe("verify");
      expect(copy.verify).toMatchObject({
        verdict: "duplicate",
        by: "app",
        reason: "Run 1 of 2 raised the same point.",
        evidence: "src/cache/flush.ts:1",
        duplicateOf: (f[0] as ReviewItemDto).id,
      });
      expect(d.run.summary?.summary).toBe("One line.");
      expect(d.run.summary?.runs).toEqual({ count: 2, copies: 1 });
      expect(d.run.summary?.verify).toMatchObject({ candidates: 3, confirmed: 3 });
      // One find phase and one check phase, each the sum of both arms. The run usage sums all four processes.
      expect(d.run.summary?.phases?.map((p) => [p.name, p.usage?.turns])).toEqual([
        ["find", 20],
        ["check", 20],
      ]);
      expect(d.run.usage?.turns).toBe(40);
      expect(h.version(id)).toBe(`${REVIEW_PROMPT_VERSION}+twice`);
      expect(existsSync(join(h.runs, `${id}-2`))).toBe(false);
      expect(existsSync(join(h.runs, String(id)))).toBe(false);
    },
    SLOW,
  );

  test(
    "row A2: arm 2 does not start; arm 1 runs alone, and the run ends incomplete with both lines",
    async () => {
      const h = await setup();
      h.runner.write({ fixture: h.stream(RESULT([F(3, "One.")])) });
      // A first run makes the cache. A locked worktree entry at the arm 2 repo path of the next run makes `worktree add` fail.
      const first = h.start("general");
      await h.done(first);
      const env = gitEnv(join(h.root, "empty.gitconfig"));
      const cache = cachePath(realpathSync.native(h.dir), { project: "PROJ", repo: "repo", id: 2 });
      const blocked = join(h.runs, `${first + 1}-2`, "work", "repo");
      await git([`--git-dir=${cache}`, "worktree", "add", "--detach", blocked, h.remote.source], { env });
      await git([`--git-dir=${cache}`, "worktree", "lock", blocked], { env });
      rmSync(join(h.runs, `${first + 1}-2`), { recursive: true, force: true });
      const before = h.calls().length;
      const id = h.start("twice");
      expect(id).toBe(first + 1);
      const d = await h.done(id);
      expect(d.run.status).toBe("incomplete");
      expect(h.kinds().slice(before)).toEqual(["find1", "verify1"]);
      expect(h.gaps(d)).toEqual(["Run 2 of 2 failed: workspace. Its findings are missing."]);
      const why = (d.run.summary?.coverage.notChecked ?? []).filter((l) => l.startsWith("Run 2 of 2 did not start: "));
      expect(why).toHaveLength(1);
      expect(why[0]).toContain("locked");
      expect(why[0]).not.toContain("\n");
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass])).toEqual([["One.", 1]]);
      expect(d.run.summary?.runs).toEqual({ count: 2, copies: 0 });
      expect(armEvents(d)).toEqual([]);
      expect(d.events.some((e) => e.id.startsWith("pass2:"))).toBe(false);
      expect(existsSync(join(h.runs, `${id}-2`))).toBe(false);
    },
    SLOW,
  );

  test(
    "rows A4 and J2: a schema failure of arm 2 leaves its gap line, and the run ends incomplete with arm 1",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([F(3, "A three.")])),
        byCwd: { [ARM2]: { fixture: h.stream({ findings: "bad" }) } },
      });
      const d = await h.done(h.start("twice"));
      expect(d.run.status).toBe("incomplete");
      expect(h.kinds().sort()).toEqual(["find1", "find2", "verify1"]);
      expect(h.gaps(d)).toEqual(["Run 2 of 2 failed: schema. Its findings are missing."]);
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass])).toEqual([["A three.", 1]]);
      expect(d.events.some((e) => e.id.startsWith("pass2:"))).toBe(true);
      expect(d.run.usage?.turns).toBe(30);
    },
    SLOW,
  );

  test(
    "rows A6 and J3: a usage limit in arm 1 does not stop arm 2; the run uses the arm 2 result and ends incomplete",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([F(3, "B three.")], "Arm two.")),
        byCwd: { [ARM1]: { fixture: h.raw("usage-limit") } },
      });
      const d = await h.done(h.start("twice"));
      expect(d.run.status).toBe("incomplete");
      expect(h.kinds().sort()).toEqual(["find1", "find2", "verify2"]);
      expect(h.gaps(d)).toEqual(["Run 1 of 2 failed: usage_limit. Its findings are missing."]);
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass, i.status])).toEqual([["B three.", 2, "new"]]);
      expect(d.run.summary?.summary).toBe("Arm two.");
      expect(d.events.some((e) => e.id.startsWith("pass1:"))).toBe(true);
      expect(d.events.some((e) => e.id.startsWith("check:pass1:"))).toBe(false);
      expect(d.events.some((e) => e.id.startsWith("check:pass2:"))).toBe(true);
    },
    SLOW,
  );

  test(
    "rows A5, A7, and A9: a capped arm 2 gets its salvage run in its own folder; arm 1 never sees its notes",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream(RESULT([F(1, "A one.")])),
        byCwd: {
          [ARM2]: { seq: { review: [{ fixture: h.raw("max-turns-notes") }, { fixture: h.stream(RESULT([F(5, "SALVAGED.")])) }] } },
        },
      });
      const id = h.start("twice");
      const d = await h.done(id);
      expect(d.run.status).toBe("completed");
      expect(h.kinds().sort()).toEqual(["find1", "find2", "find2", "verify1", "verify2"]);
      const salvage = h.finders().filter((c) => h.armOf(c) === 2)[1] as Call;
      expect(salvage.context["salvage-notes.md"]).toBeDefined();
      expect(flag(salvage.argv, "--max-turns")).toBe("6");
      for (const c of h.calls().filter((x) => h.armOf(x) === 1)) expect(c.context["salvage-notes.md"]).toBeUndefined();
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass])).toEqual([
        ["A one.", 1],
        ["SALVAGED.", 2],
      ]);
      expect(d.run.summary?.coverage.notChecked).toContain(
        `The review reached its turn cap (${general.maxTurns}). These findings come from its notes so far.`,
      );
      expect(h.gaps(d)).toEqual([]);
      expect(d.events.find((e) => e.id === "pass2:salvage:start")).toMatchObject({ tool: "Salvage", status: "ok" });
      expect(d.events.filter((e) => e.id.startsWith("pass2:salvage:")).every((e) => e.seq > ARM_SEQ)).toBe(true);
      expect(d.events.some((e) => e.id.startsWith("pass1:salvage:"))).toBe(false);
      expect(armEvents(d)).toEqual([]);
      // Arm 1: 10 + 10. Arm 2: 101 + salvage 10 + check 10.
      expect(d.run.usage?.turns).toBe(141);
    },
    SLOW,
  );

  test(
    "rows A8 and J4: both arms fail; the run fails with the arm 1 ending, the usage of both, and the events of both",
    async () => {
      const h = await setup();
      h.runner.write({
        fixture: h.stream({ findings: "bad" }),
        byCwd: { [ARM1]: { fixture: h.raw("max-turns-empty") } },
      });
      const d = await h.done(h.start("twice"));
      expect(h.kinds().sort()).toEqual(["find1", "find2"]);
      expect(d.run).toMatchObject({ status: "failed", errorKind: "max_turns" });
      expect(d.run.errorText).toBe("Reached maximum number of turns (100) The run left no notes to salvage.");
      expect(d.run.usage?.turns).toBe(101 + 10);
      expect(d.items).toEqual([]);
      for (const k of [1, 2]) expect(d.events.some((e) => e.id.startsWith(`pass${k}:`))).toBe(true);
      expect(armEvents(d)).toEqual([]);
    },
    SLOW,
  );

  test(
    "row A11: an exception in arm 2 ends only arm 2; arm 1 goes on, and the run ends incomplete",
    async () => {
      const h = await setup();
      // Arm 2 plants a folder link at ./context/candidates.md, so its verify write throws.
      const target = join(h.root, "link-target");
      mkdirSync(target);
      h.runner.write({
        fixture: h.stream(RESULT([F(3, "Three.")])),
        byCwd: { [ARM2]: { writes: [{ path: "context/candidates.md", junction: target }] } },
      });
      const d = await h.done(h.start("twice"));
      expect(d.run.status).toBe("incomplete");
      expect(h.kinds().sort()).toEqual(["find1", "find2", "verify1"]);
      expect(h.gaps(d)).toEqual(["Run 2 of 2 failed: process. Its findings are missing."]);
      expect(h.findings(d).map((i) => [i.body, h.payload(i).pass])).toEqual([["Three.", 1]]);
      // Arm 2 keeps its finder usage: 10 + 10 + 10.
      expect(d.run.usage?.turns).toBe(30);
      expect(existsSync(target)).toBe(true);
    },
    SLOW,
  );

  test(
    "rows A10 and J5: Cancel reaches both runners; the run waits for both arms and ends cancelled with the usage of both",
    async () => {
      const h = await setup();
      // Arm 1 finds fast and checks slowly. Arm 2 finds slowly: 37 lines at 1 s each.
      h.runner.write({
        fixture: h.stream(RESULT([F(3, "Three.")])),
        bySchema: { verify: { delayMs: 1000 } },
        byCwd: { [ARM2]: { delayMs: 1000 } },
      });
      const id = h.start("twice");
      const end = Date.now() + 30_000;
      while (h.calls().length < 3 && Date.now() < end) await Bun.sleep(25);
      expect(h.kinds().sort()).toEqual(["find1", "find2", "verify1"]);
      const at = Date.now();
      expect(h.review.cancel(h.db, id)).toBe("cancelled");
      const d = await h.done(id);
      expect(Date.now() - at).toBeLessThan(10_000);
      expect(d.run.status).toBe("cancelled");
      expect(h.kinds().sort()).toEqual(["find1", "find2", "verify1"]);
      // Only the arm 1 finder ended with a result. Both other processes ended at the cancel.
      expect(d.run.usage?.turns).toBe(10);
      expect(d.items).toEqual([]);
      for (const p of ["pass1:", "pass2:"]) expect(d.events.some((e) => e.id.startsWith(p))).toBe(true);
      expect(armEvents(d)).toEqual([]);
      expect(alive(process.pid)).toBe(true);
      for (const c of h.calls()) expect([c.pid, alive(c.pid)]).toEqual([c.pid, false]);
      expect(existsSync(join(h.runs, `${id}-2`))).toBe(false);
    },
    SLOW,
  );

  test(
    "a re-review with twice keeps one finder call in one folder",
    async () => {
      const h = await setup();
      h.runner.write({ fixture: h.stream(RESULT([F(3, "Three.")])) });
      h.review.saveBrief(h.db, h.pr, { note: "", profile: "twice" });
      const base = h.review.review(h.db, h.pr) as { run: RunDto };
      await h.done(base.run.id);
      expect(h.finders()).toHaveLength(2);
      // A push: the remote and the stored PR row get the next head.
      const env = gitEnv(join(h.root, "empty.gitconfig"));
      for (const ref of ["refs/pull-requests/2/from", "refs/heads/feature"])
        await git(["--git-dir", h.remote.remote, "update-ref", ref, h.remote.next], { env });
      h.db.query("UPDATE pull_request SET source_head = $head WHERE id = $pr").run({ head: h.remote.next, pr: h.pr });
      const before = h.finders().length;
      const r = h.review.rereview(h.db, h.pr);
      expect(r.status).toBe(202);
      const id = (r as { run: RunDto }).run.id;
      const d = await h.done(id);
      expect(d.run.status).not.toBe("failed");
      const f = h.finders().slice(before);
      expect(f).toHaveLength(1);
      expect(basename(dirname((f[0] as Call).cwd))).toBe(String(id));
      expect(d.events.filter((e) => /^(check:)?pass\d+:/.test(e.id))).toEqual([]);
      expect(d.run.summary?.runs).toBeUndefined();
    },
    SLOW,
  );

  test(
    "lenses3 with twice makes its three passes in one folder, and the log says that twice is off",
    async () => {
      const h = await setup();
      h.runner.write({ fixture: h.stream(RESULT([F(3, "Three.")])) });
      const spy = spyOn(console, "log");
      try {
        const id = h.start("lenses3");
        const d = await h.done(id);
        expect(d.run.status).toBe("completed");
        expect(h.kinds()).toEqual(["find1", "find1", "find1", "verify1"]);
        expect(d.events.filter((e) => e.tool === "Pass").map((e) => e.note)).toEqual([
          "Pass 1 of 3: failure paths.",
          "Pass 2 of 3: contracts and callers.",
          "Pass 3 of 3: the whole change.",
        ]);
        expect(spy.mock.calls.map((c) => String(c[0]))).toContain(
          `Review run ${id}: the variant twice is off, because lenses3 runs its passes.`,
        );
        expect(h.version(id)).toBe(`${REVIEW_PROMPT_VERSION}+lenses3+twice`);
      } finally {
        spy.mockRestore();
      }
    },
    SLOW,
  );
});
