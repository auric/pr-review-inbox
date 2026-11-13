// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.2, 6.7, and 6.14, and part-session.md (AC-B10 to AC-B13, AC-B18 to AC-B20, AC-B293 to
// AC-B305): the build loop of a small task part. loop-fixture.ts holds the setup: the fake CLI, the check script, and a temp bare remote.
// No test starts the real CLI, reaches a forge, or touches the user's clone or data folder.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { store, taskFileDir } from "../../src/server/context/attachments";
import { DEFAULT_PROFILE, profileOf, SHIPPED_PROFILES } from "../../src/server/review/catalog";
import { CONTINUE_PATHS_MAX, continueFile } from "../../src/server/review/context-files";
import { git } from "../../src/server/review/git";
import { cachePath, gitSetup, longPath } from "../../src/server/review/workspace";
import { snapGit, stopGit } from "../../src/server/tasks/gitstate";
import { cutJson, PATCH_LOST, type StepOutcome, startStep } from "../../src/server/tasks/implement";
import {
  changedLines,
  createLoop,
  globMatch,
  LOCK_GLOBS,
  PAUSED,
  REVIEW_FIX_TRIES,
  TEST_FIX_TRIES,
  tickTask,
} from "../../src/server/tasks/loop";
import { pushTaskBranch, staleText } from "../../src/server/tasks/push";
import { recoverTasks, taskDto } from "../../src/server/tasks/tasks";
import { ignoredSnapshot, openWorktree, readSetupMark, status } from "../../src/server/tasks/worktree";
import type { ProfileInput, RunConflict, TaskAllowInput, TaskDto } from "../../src/shared/dto";
import { DEFAULT_TEST_GLOBS, RUN_TIME_MAX_MS, type TaskBlocked } from "../../src/shared/task";
import { rowStatus } from "../../src/shared/task-status";
import { readRecords } from "../support/fake-claude";
import { logOf, pngOf } from "../support/fake-jira";
import {
  type Call,
  CLEAN,
  cleanup,
  cleanupAll,
  dirs,
  FIXED,
  KEY,
  MAX_TURNS,
  NO_COVERAGE,
  point,
  QUESTION,
  review,
  SLOW,
  type Step,
  setup,
  stopInGate,
  TEST_FILE,
  TICK,
  TODO,
  until,
  WORKS,
} from "./loop-fixture";
import { remoteCommit } from "./update-fixture";

for (const m of ["tasks/loop", "tasks/implement", "tasks/tasks", "tasks/push", "tasks/worktree", "review/jobs", "review/workspace"])
  console.log(`loop.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);

describe("the loop of one part (spec.md section 6.7)", () => {
  test(
    "AC-B293: one build run with its ticks, red checks with one fix run, one commit with the ticked IDs, the own review, and a ready part",
    async () => {
      const s = await setup();
      await s.build();
      expect(s.blocked()).toBeNull();
      expect(s.t().state).toBe("implementing");
      expect(s.part().state).toBe("self_reviewed");
      expect(s.flow()).toEqual([
        "commit:plan:ok",
        "check:base:ok",
        "implement:build:ok",
        "check:checks:failed",
        "fix:checks:ok",
        "check:checks:ok",
        "commit:build:ok",
        "review:review:ok",
      ]);
      expect(s.runCalls().map(s.modeOf)).toEqual(["build", "fix", "review"]);
      // part-session.md section 2.6 item 5: one commit per green gate, with the user's name and email and the ticked IDs in the body.
      expect(await s.log()).toEqual([
        `Ada Example <ada@example.invalid>|${KEY}: Add the plan`,
        `Ada Example <ada@example.invalid>|${KEY}: Add the feature`,
      ]);
      const w = await s.wt();
      expect((await git([`--git-dir=${w.admin}`, "log", "-1", "--format=%b"], { env: w.env })).trim()).toBe("Tasks done: T1.1");
      expect(readFileSync(join(w.repo, "specs", KEY, "plan.md"), "utf8")).toContain("### [x] T1.1 Write the feature");
      expect(readFileSync(join(w.repo, "src", "feature.ts"), "utf8")).toContain("works");
      expect(await status(w)).toEqual([]);
      // The check output of the red run is in the step row (the Log tab) and in failure.md of the fix run.
      const red = s.steps().find((x) => x.kind === "check" && x.item === "checks" && x.state === "failed") as Step;
      const cmd = (JSON.parse(red.detail_json) as { commands: { exit: number; tail: string; argv: string[] }[] }).commands[0];
      expect(cmd?.exit).toBe(1);
      expect(cmd?.tail).toContain("FAIL: src/feature.ts does not work yet");
      const fix = s.runCalls()[1] as Call;
      expect(fix.context["step.md"] ?? "").toContain("- Task: fix the failed checks of the whole part in ./context/failure.md.");
      // The own review: kind review, task set, pr NULL, base..head of the part, the finder and the verify phase.
      const run = s.db
        .query("SELECT kind, pr, task, status, source_head, merge_base FROM review_run WHERE kind = 'review'")
        .get() as Record<string, unknown>;
      expect(run).toEqual({ kind: "review", pr: null, task: s.task, status: "completed", source_head: s.part().head, merge_base: s.base });
      const reviewCall = s.runCalls()[2] as Call;
      expect(reviewCall.stdin).toContain(`Review the change ${s.base}..${s.part().head} in ./repo.`);
      expect(reviewCall.stdin).toContain(`- Pull request: none yet. The app builds this change for task ${KEY}`);
      expect(reviewCall.argv).toContain("--restricted");
      expect(reviewCall.argv[reviewCall.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      expect(reviewCall.context["task.md"] ?? "").toContain("# The plan of the task");
      expect(reviewCall.context["pr.md"] ?? "").toContain(`# ${KEY}: Add the feature`);
      // The part lines: plan.md, the test, and the feature, against the budget.
      expect(s.part().lines).toBeGreaterThan(0);
      expect(s.part().lines).toBe((await changedLines(w, s.base, s.part().head as string, LOCK_GLOBS)).lines);
      // Live events for the UI.
      expect(s.events.some((e) => e.event === "changed" && JSON.stringify(e.data).includes(`"tasks":[${s.task}]`))).toBe(true);
    },
    SLOW,
  );

  test(
    "spec.md section 6.2: every Claude run of the part uses the profile of the task and gets all skills, also in the own review",
    async () => {
      const config = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-loop-config-")));
      dirs.push(config);
      mkdirSync(join(config, "skills", "tdd"), { recursive: true });
      writeFileSync(join(config, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Test first.\n---\n\nWrite the test first.\n");
      // spec.md section 6.19: a skill that the profile does not tick, and a skill of the repository at the task base.
      mkdirSync(join(config, "skills", "other"), { recursive: true });
      writeFileSync(join(config, "skills", "other", "SKILL.md"), "---\nname: other\n---\nNot ticked.\n");
      const main = { ".claude/skills/repo-rules/SKILL.md": "---\nname: repo-rules\ndescription: Repo rules.\n---\nREPO-RULES\n" };
      const strict = { ...SHIPPED_PROFILES[0], id: "strict", name: "Strict", model: "sonnet", skills: ["tdd"] } as ProfileInput;
      const s = await setup({ config, profiles: [...SHIPPED_PROFILES, strict], profile: "strict", main });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const calls = s.runCalls();
      expect(calls.map(s.modeOf)).toEqual(["build", "fix", "review"]);
      for (const c of calls) expect(c.argv[c.argv.indexOf("--model") + 1]).toBe("sonnet");
      // The implement modes: the skills and the index sit in context/skills, outside repo/.
      for (const c of calls.slice(0, 2)) {
        expect(c.context["skills/tdd/SKILL.md"]).toContain("Write the test first.");
        expect(c.context["skills/other/SKILL.md"]).toContain("Not ticked.");
        expect(c.context["skills/repo-rules/SKILL.md"]).toContain("REPO-RULES");
        expect(c.context["skills/INDEX.md"]).toContain("- repo-rules (repository): ./context/skills/repo-rules/SKILL.md. Repo rules.");
      }
      // The stdin of the first run names the index. The run has no Bash tool. part-session.md section 2.3: the fix run forks that
      // transcript and gets the rules digest.
      expect(calls[0]?.stdin).toContain("Read ./context/skills/INDEX.md first.");
      expect(calls[0]?.stdin).toContain("Skill scripts cannot run.");
      expect(calls[1]?.argv).toContain("--resume");
      // The own review: the skills and the index in ./skills of the run folder, named in the rl-main prompt.
      const own = calls[2] as Call;
      expect(own.skills).toEqual(expect.arrayContaining(["INDEX.md", "tdd/SKILL.md", "other/SKILL.md", "repo-rules/SKILL.md"]));
      expect(own.agents?.["rl-main"]?.prompt).toContain("Read ./skills/INDEX.md first.");
      // No copied skill reaches a commit of the part branch.
      const w = await s.wt();
      const paths = await git([`--git-dir=${w.admin}`, "log", "--name-only", "--format=", `${s.base}..HEAD`], { env: w.env });
      expect(paths.trim()).not.toBe("");
      expect(paths).not.toMatch(/skills\/|INDEX\.md|SKILL\.md/);
      const runs = s.db.query("SELECT DISTINCT profile, profile_name FROM review_run WHERE task = $task").all({ task: s.task });
      expect(runs).toEqual([{ profile: "strict", profile_name: "Strict" }]);
    },
    SLOW,
  );

  test(
    "spec.md section 6.17: every Claude run of the part gets the included files of the task: build, fix, and the own review",
    async () => {
      const s = await setup();
      const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\ntrailer\n<<>>\n%%EOF\n", "latin1");
      const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const files: [string, string, string, Uint8Array][] = [
        ["10100", "screen.png", "image/png", pngOf(300)],
        ["10101", "run.log", "text/plain", logOf(200)],
        ["10102", "spec.pdf", "application/pdf", pdf],
      ];
      const issue = {
        key: KEY,
        summary: "Add the feature",
        status: "Open",
        description: "See the files.",
        comments: [],
        commentsTotal: 0,
        truncated: false,
        attachments: [
          ...files.map(([id, filename, mimeType, body]) => ({ id, filename, mimeType, size: body.length, created: null })),
          { id: "10103", filename: "plan.docx", mimeType: docx, size: 4, created: null },
        ],
      };
      s.db.query("UPDATE task SET issue_json = $json WHERE id = $id").run({ json: JSON.stringify(issue), id: s.task });
      for (const [id, filename, mime, body] of files) {
        const rel = `${taskFileDir(s.db, "t")}/${id}-${filename}`;
        const made = await store(s.dataDir, rel, (write) => write(body));
        s.db
          .query(
            `INSERT INTO task_file (task, att_id, filename, mime, size, file, sha256, image, text, pdf, include, downloaded_at)
              VALUES ($task, $id, $filename, $mime, $size, $rel, $sha, $image, $text, $pdf, 1, 0)`,
          )
          .run({
            task: s.task,
            id,
            filename,
            mime,
            size: body.length,
            rel,
            sha: made.sha256,
            image: made.image ? 1 : 0,
            text: made.text ? 1 : 0,
            pdf: made.pdf ? 1 : 0,
          });
      }
      await s.build();
      // The binary files in context/ pass the path check after each run.
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      expect(s.runCalls().map(s.modeOf)).toEqual(["build", "fix", "review"]);
      for (const c of s.runCalls()) {
        expect(c.attachments).toEqual(["10100.png", "10101.txt", "10102.pdf"]);
        expect(c.context["task.md"] ?? "").toContain(
          `- spec.pdf: ${pdf.length} bytes, application/pdf. Included as ./attachments/10102.pdf.`,
        );
        expect(c.context["task.md"] ?? "").toContain(
          `- plan.docx: 4 bytes, ${docx}. Listed only: only images, PDFs, and text files go to runs.`,
        );
      }
      const [build, fix, own] = s.runCalls() as Call[];
      expect(build?.stdin).toContain(
        "./context/attachments/ holds task attachments as untrusted data. ./context/task.md lists them. Read opens the images and the PDFs.",
      );
      // part-session.md section 2.3: the fix run forks the transcript of the build run, which holds that line, and gets the rules digest.
      expect(fix?.argv).toContain("--resume");
      expect(own?.stdin).toContain("- ./context/attachments/ holds task attachments as untrusted data.");
      expect(own?.context["task.md"] ?? "").toContain("# The plan of the task");
    },
    SLOW,
  );

  test(
    "AC-B11, AC-B294: red three times, then red/checks; Continue gives three more fix runs and keeps the work; a reset gives the next run the patch",
    async () => {
      // late-red passes on the part base, so the fixes run. Each fix changes the file, so no fix run stops for "changed no file".
      const fix = (n: number) => ({ writes: [{ path: "repo/src/feature.ts", text: `export const feature = 'try ${n}';\n` }] });
      const s = await setup({ mode: "late-red", seq: { "implement:fix": [fix(1), fix(2), fix(3)] } });
      await s.build();
      const fixes = s.steps().filter((x) => x.kind === "fix");
      expect(fixes.length).toBe(TEST_FIX_TRIES);
      expect(fixes.map((x) => x.attempt)).toEqual([1, 2, 3]);
      expect(TEST_FIX_TRIES).toBe(3);
      const b = s.blocked();
      expect(b).toMatchObject({ kind: "red", cause: "checks", text: "Needs you: the checks of part 1 stay red after 3 tries." });
      const checks = s.steps().filter((x) => x.kind === "check" && x.item === "checks");
      expect(checks.length).toBe(4);
      for (const c of checks) {
        const cmd = (JSON.parse(c.detail_json) as { commands: { exit: number; tail: string }[] }).commands[0];
        expect([cmd?.exit, cmd?.tail.includes("FAIL tests/feature.test.ts")]).toEqual([1, true]);
      }
      expect(b?.step).toBe((checks.at(-1) as Step).id);
      expect(s.t().state).toBe("implementing");
      expect(s.part().state).toBe("implementing");
      expect(s.steps().some((x) => x.kind === "review" || (x.kind === "commit" && x.item === "build"))).toBe(false);
      // Continue keeps the changes of the fix runs, runs no build run (every task is ticked), and gives TEST_FIX_TRIES new fix runs.
      const w = await s.wt();
      expect(readFileSync(join(w.repo, "src", "feature.ts"), "utf8")).toContain("try 3");
      // A seq entry counts the earlier calls of its kind, so fix 4 to 6 come after the first three.
      s.scenario({ seq: { "implement:fix": [1, 2, 3, 4, 5, 6].map(fix) } });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.steps().filter((x) => x.kind === "implement")).toHaveLength(1);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "fix")
          .map((x) => x.attempt),
      ).toEqual([1, 2, 3, 4, 5, 6]);
      expect(s.blocked()?.text).toBe("Needs you: the checks of part 1 stay red after 3 tries.");
      expect(existsSync(join(w.dir, "..", "patches"))).toBe(false);
      // part-session.md section 2.2: each fix run forks the kept transcript, which knows the kept work, so it gets no continue.md.
      // session.test.ts checks the new session with the resume gate off.
      const fourth = s.runCalls().filter((c) => s.modeOf(c) === "fix")[3] as Call;
      expect(fourth.argv).toContain("--resume");
      expect(fourth.context["continue.md"]).toBeUndefined();
      // AC-B203: a row without checked, as from before the rule, resets with the patch. The plan ticks go back too, so the build runs
      // again and reads the patch.
      const last = s
        .steps()
        .filter((x) => x.kind === "fix")
        .at(-1) as Step;
      s.db.query("UPDATE task_step SET detail_json = json_remove(detail_json, '$.checked') WHERE id = $id").run({ id: last.id });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(readFileSync(join(w.dir, "..", "patches", `${last.id}.patch`), "utf8")).toContain("try 6");
      expect(JSON.parse((s.steps().find((x) => x.id === last.id) as Step).detail_json).patch).toBe(`${last.id}.patch`);
      // The build run forks the transcript of the last fix run, so step.md and continue-diff.md tell it about the reset.
      const again = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(again.argv).toContain("--resume");
      expect(again.context["continue.md"]).toContain("## Open tasks");
      expect(again.context["step.md"]).toContain(
        "The app reset the work of the last run. ./context/continue-diff.md holds it as a patch. Reuse what is right.",
      );
      expect(again.context["continue-diff.md"]).toStartWith("# UNTRUSTED DATA");
      expect(again.context["continue-diff.md"]).toContain("# Patch of the work that the app reset");
      expect(again.context["continue-diff.md"]).toContain("try 6");
    },
    SLOW,
  );

  test(
    "AC-B301: Test-fix tries 1 gives red/checks after one fix run; each session run gets the process cap and its turn cap from the settings",
    async () => {
      const fix = { writes: [{ path: "repo/src/feature.ts", text: "export const feature = 'try 1';\n" }] };
      const s = await setup({ mode: "late-red", seq: { "implement:fix": [fix] }, runLimits: { testFixTries: 1, sessionTurns: 120 } });
      const runs = spyOn(s.jobs, "taskRun");
      await s.build();
      expect(s.steps().filter((x) => x.kind === "fix")).toHaveLength(1);
      expect(s.blocked()?.text).toBe("Needs you: the checks of part 1 stay red after 1 try.");
      const starts = runs.mock.calls.flatMap(([, start]) => (start.kind === "implement" && "timeoutMs" in start ? [start] : []));
      expect(starts.map((x) => [x.timeoutMs, x.maxTurns])).toEqual([
        [RUN_TIME_MAX_MS, 120],
        [RUN_TIME_MAX_MS, 40],
      ]);
      expect(starts.every((x) => x.session?.keep.endsWith(join("sessions", "part-1")))).toBe(true);
    },
    SLOW,
  );

  test(
    "AC-B301: without run limits in the settings, a build run gets 500 turns and the process cap, and no step time or part time",
    async () => {
      const s = await setup();
      const runs = spyOn(s.jobs, "taskRun");
      await s.build();
      const starts = runs.mock.calls.flatMap(([, start]) => (start.kind === "implement" && "timeoutMs" in start ? [start] : []));
      expect(starts.length).toBeGreaterThan(0);
      expect(starts.every((x) => x.timeoutMs === RUN_TIME_MAX_MS)).toBe(true);
      expect(starts[0]?.maxTurns).toBe(500);
    },
    SLOW,
  );

  test(
    "AC-B104.11: a fix run that changes no file blocks with a question after one fix run; failure.md marks the failure new",
    async () => {
      const s = await setup({ seq: { "implement:fix": [{ writes: [] }] } });
      await s.build();
      const fixes = s.steps().filter((x) => x.kind === "fix");
      expect(fixes.length).toBe(1);
      expect(s.blocked()).toEqual({
        kind: "question",
        cause: "no_change",
        step: (fixes[0] as Step).id,
        text: "Needs you: the fix run of part 1 changed no file. See why.",
      });
      // The part base passed, so the failure is new. The prompt tells Claude to stop with a question for a fault that code cannot fix.
      const call = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      expect(call.context["failure.md"]).toContain("- On the part base: New. It passed on the part base.");
      expect(call.stdin).toContain(
        "When the output shows a broken command, a missing tool, or a network or environment fault, change no file. Set question and give the reason.",
      );
      // part-session.md section 2.3: the fix run forks the transcript of the build run. Its rules digest holds the command lines again.
      expect(call.argv).toContain("--resume");
      expect(call.stdin).toContain("You cannot run them. When they fail, a fix step gets their output.");
      // The checks on the part base ran once, before the build run, and the Log tab marks them.
      const base = s.steps().filter((x) => x.kind === "check" && x.item === "base");
      expect(base.map((x) => [x.state, JSON.parse(x.detail_json).baseline])).toEqual([["ok", true]]);
      expect(s.steps().findIndex((x) => x.item === "base")).toBeLessThan(s.steps().findIndex((x) => x.kind === "implement"));
      // Continue runs the checks again and the next fix, which now changes the file.
      s.scenario({ seq: { "implement:fix": [{ writes: [] }, { writes: [WORKS] }], review: [{ review: CLEAN }] } });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      expect(s.steps().filter((x) => x.kind === "check" && x.item === "base")).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "6.21.5: Unrestricted runs with its own shell.json; a new file that a Bash command wrote stays out of the commit and goes to the step notes and failure.md",
    async () => {
      const GEN = "repo/src/gen.ts";
      const s = await setup({
        main: { ".claude/skills/repo-rules/SKILL.md": "---\nname: repo-rules\ndescription: Repo rules.\n---\nREPO-RULES\n" },
        seq: {
          "implement:build": [
            {
              writes: [TEST_FILE, TODO],
              ticks: TICK,
              bash: [{ command: "bun run gen", files: [{ path: GEN, text: "gen\n" }], output: "ok" }],
            },
          ],
        },
      });
      s.db.run("UPDATE repo_task_settings SET shell_mode = 'unrestricted'");
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const impl = s.steps().find((x) => x.kind === "implement") as Step;
      const d = JSON.parse(impl.detail_json);
      expect(d.bashFiles).toEqual([GEN]);
      expect(d.notes).toContain(
        "Not committed: 1 new file that a Bash command wrote (repo/src/gen.ts). The next step reads: Write <path> with the Write tool, so it is committed.",
      );
      expect(d.shell.mode).toBe("unrestricted");
      // The fix run after the red checks gets the check output and then the new file.
      const fix = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      const failure = fix.context["failure.md"] ?? "";
      expect(failure).toContain("# Check output");
      expect(failure).toContain("# New files that are not committed");
      expect(failure).toContain(`- Write ${GEN} with the Write tool, so it is committed.`);
      expect(failure.indexOf("# Check output")).toBeLessThan(failure.indexOf("# New files"));
      // part-session.md section 2.3: the fix run forks the transcript of the build run. Its rules digest holds the shell lines again. The
      // skill lines are in the prompt of the build run.
      expect(fix.argv).toContain("--resume");
      expect(fix.stdin).toContain("You may run `cd repo` before a command that must run in the repository.");
      const build = s.runCalls().find((c) => s.modeOf(c) === "build") as Call;
      expect(build.stdin).toContain("Skill scripts and recipes may run with the Bash tool under the shell rules of this step.");
      expect(build.stdin).not.toContain("Skill scripts cannot run.");
      // part-session.md section 2.3 item 4: the scratch folder line.
      expect(fix.stdin).toContain("Write long command output to a file in ./scratch, and read its end with tail -n 200.");
      expect(Object.keys(fix.env).map((k) => k.toUpperCase())).not.toContain("CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR");
      // The commit leaves the file on disk and out of the branch.
      const w = await s.wt();
      expect(existsSync(join(w.dir, GEN))).toBe(true);
      expect(await git([`--git-dir=${w.admin}`, "ls-tree", "-r", "--name-only", "HEAD"], { env: w.env })).not.toContain("src/gen.ts");
      expect((await s.log()).length).toBeGreaterThan(0);
    },
    SLOW,
  );

  test(
    "6.21.5, AC-B216: a stopped run that is checked keeps the list of its Bash files and the note; the next run reads them",
    async () => {
      const GEN = "repo/src/gen.ts";
      const bash = [{ command: "bun run gen", files: [{ path: GEN, text: "gen\n" }], output: "ok" }];
      const s = await setup({
        seq: {
          "implement:build": [
            { writes: [TODO], bash, hang: true },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      s.db.run("UPDATE repo_task_settings SET shell_mode = 'unrestricted'");
      s.loop.build(s.db, s.task);
      // The Stop comes after the app read the Bash call, so the Write call before it is known too.
      const bashSeen = "SELECT 1 FROM run_event e JOIN review_run r ON r.id = e.run WHERE r.task = $t AND e.tool = 'Bash'";
      await until(() => s.db.query(bashSeen).get({ t: s.task }) !== null);
      expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      const d = JSON.parse((s.steps().find((x) => x.kind === "implement") as Step).detail_json);
      expect([d.checked, d.bashFiles]).toEqual([true, [GEN]]);
      expect(d.notes).toContain(
        "Not committed: 1 new file that a Bash command wrote (repo/src/gen.ts). The next step reads: Write <path> with the Write tool, so it is committed.",
      );
      expect(existsSync(join((await s.wt()).dir, GEN))).toBe(true);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      const second = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(second.context["failure.md"]).toContain(`- Write ${GEN} with the Write tool, so it is committed.`);
    },
    SLOW,
  );

  test(
    "AC-B104.12: checks red on the part base stop the fixes once with a question; Continue runs the fix runs, and failure.md marks the command",
    async () => {
      const s = await setup({ mode: "red" });
      await s.build();
      const base = s.steps().find((x) => x.kind === "check" && x.item === "base") as Step;
      expect([base.state, JSON.parse(base.detail_json).baseline]).toEqual(["failed", true]);
      expect(s.steps().some((x) => x.kind === "fix")).toBe(false);
      const red = s.steps().filter((x) => x.kind === "check" && x.item === "checks");
      expect(red).toHaveLength(1);
      expect(s.blocked()).toEqual({
        kind: "question",
        cause: "red_before",
        step: (red[0] as Step).id,
        text: 'Needs you: the check "test" of part 1 also failed on the part base. See why. Continue lets Claude try to fix it.',
      });
      expect(JSON.parse((red[0] as Step).detail_json).redBefore).toBe(true);
      expect(rowStatus(taskDto(s.db, s.t())).needsYou).toBe(true);
      // part-session.md section 2.3 item 5: the build run got baseline.md with the red command.
      const build = s.runCalls().find((c) => s.modeOf(c) === "build") as Call;
      expect(build.context["baseline.md"]).toContain(`- test: \`${process.execPath} ${join(s.root, "check.ts")}\``);
      // Continue: the same red check does not stop again, so the fix runs run up to TEST_FIX_TRIES.
      const fix = (n: number) => ({ writes: [{ path: "repo/src/feature.ts", text: `export const feature = 'try ${n}';\n` }] });
      s.scenario({ seq: { "implement:fix": [fix(1), fix(2), fix(3)] } });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.steps().filter((x) => x.kind === "fix")).toHaveLength(TEST_FIX_TRIES);
      expect(s.blocked()).toMatchObject({ kind: "red", text: "Needs you: the checks of part 1 stay red after 3 tries." });
      const call = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      expect(call.context["failure.md"]).toContain("- On the part base: Also red on the part base.");
      expect(call.stdin).toContain('failure.md marks a command that also failed on the part base with "Also red on the part base".');
    },
    SLOW,
  );

  test(
    "AC-B12: a confirmed major point starts one judging run, the gate, and a new review; then the part is ready",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          "implement:fix": [{ writes: [FIXED] }],
          review: [{ review: review([point("major")]) }, { review: CLEAN }],
        },
      });
      await s.build();
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      expect(s.flow().slice(-7)).toEqual([
        "check:checks:ok",
        "commit:build:ok",
        "review:review:ok",
        "fix:review:ok",
        "check:checks:ok",
        "commit:review:ok",
        "review:review:ok",
      ]);
      expect(s.runCalls().map(s.modeOf)).toEqual(["build", "review", "verify", "fix", "review"]);
      // The judging run gets the confirmed point with path:line in failure.md.
      const fix = s.runCalls()[3] as Call;
      const failure = fix.context["failure.md"] ?? "";
      expect(failure).toContain(": major at src/feature.ts:1");
      expect(fix.context["step.md"] ?? "").toContain("- Task: fix the points of the review in ./context/failure.md.");
      const firstReview = s.steps().find((x) => x.kind === "review") as Step;
      const detail = JSON.parse(firstReview.detail_json) as { findings: number[] };
      expect(detail.findings.length).toBe(1);
      const item = s.db.query("SELECT payload_json FROM review_item WHERE id = $id").get({ id: detail.findings[0] ?? 0 }) as {
        payload_json: string;
      };
      expect(JSON.parse(item.payload_json).verify.verdict).toBe("confirmed");
      expect((await s.log()).at(-1)).toBe(`Ada Example <ada@example.invalid>|${KEY}: Fix the review points of part 1`);
      const judging = s.steps().find((x) => x.kind === "fix" && x.item === "review") as Step;
      // part-session.md section 2.8: the judging run forks the session.
      expect(JSON.parse(judging.detail_json).session).toMatchObject({ purpose: "review", resumed: true });
    },
    SLOW,
  );

  test(
    "AC-B12: a blocker that stays after two judging rounds blocks with blocker; Continue judges the stored points again",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
          // Each fix makes a new commit, so each review sees a new head. A review of the same head runs once.
          "implement:fix": [{ writes: [FIXED] }, { writes: [WORKS] }, { writes: [FIXED] }],
          review: [{ review: review([point("blocker")]) }],
        },
      });
      await s.build();
      expect(s.steps().filter((x) => x.kind === "review").length).toBe(REVIEW_FIX_TRIES + 1);
      expect(s.steps().filter((x) => x.kind === "fix" && x.item === "review").length).toBe(REVIEW_FIX_TRIES);
      expect(s.blocked()).toMatchObject({
        kind: "blocker",
        text: "Needs you: Claude's review of part 1 still finds 1 point to fix after 2 fixes.",
      });
      expect(s.part().state).toBe("implementing");
      // The review of the head ended ok with a blocker, so GO picks the review again: its stored points start a judging run.
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.steps().filter((x) => x.kind === "fix" && x.item === "review").length).toBeGreaterThan(REVIEW_FIX_TRIES);
    },
    SLOW,
  );

  test(
    "AC-B302: a part over the line budget gets a note on its commit, not a stop; Keep one PR drops the note",
    async () => {
      const big = { path: "repo/src/feature.ts", text: `export const feature = 'works';\n${"// line\n".repeat(450)}` };
      const s = await setup({ seq: { "implement:build": [{ writes: [TEST_FILE, big], ticks: TICK }] } });
      await s.build();
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      const lines = s.part().lines as number;
      expect(lines).toBeGreaterThan(400);
      const commit = s.steps().find((x) => x.kind === "commit" && x.item === "build") as Step;
      expect(JSON.parse(commit.detail_json).notes).toContain(`This PR has ${lines} changed lines, over your 400 limit.`);
      expect(s.steps().some((x) => x.kind === "size")).toBe(false);
      const k = await setup({ settings: { keepOnePr: true }, seq: { "implement:build": [{ writes: [TEST_FILE, big], ticks: TICK }] } });
      await k.build();
      const kept = k.steps().find((x) => x.kind === "commit" && x.item === "build") as Step;
      expect(JSON.parse(kept.detail_json).notes.some((n: string) => n.startsWith("This PR has"))).toBe(false);
    },
    SLOW * 2,
  );

  test(
    "AC-B18, AC-B197: with the run limit 1, a review start during a task step gets 409 with the pause line; a step that finds the slot busy waits and then continues",
    async () => {
      const s = await setup({
        seq: { "implement:build": [{ hang: true }, { writes: [TEST_FILE, WORKS], ticks: TICK }] },
        runLimits: { runsAtOnce: 1 },
      });
      // Task K-2 holds the run slot with a step that runs until its cancel.
      const other = s.addTask("K-2", "Other");
      const now = Date.now();
      const p2 = (
        s.db
          .query(
            `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
            VALUES ($task, 1, 'single', 'Other', 'feature/K-2-other', 'main', 'implementing', $now, $now) RETURNING id`,
          )
          .get({ task: other, now }) as { id: number }
      ).id;
      const w2 = await openWorktree({
        dataDir: s.dataDir,
        db: s.db,
        project: "PROJ",
        repo: "repo",
        task: other,
        ord: 1,
        branch: "feature/K-2-other",
        base: s.base,
      });
      let ended: StepOutcome | null = null;
      const held = await startStep({
        db: s.db,
        review: s.jobs,
        task: other,
        part: { id: p2, ord: 1 },
        wt: w2,
        mode: "implement",
        item: "T1.1",
        attempt: 1,
        profile: profileOf(s.settings.profiles(), DEFAULT_PROFILE),
        untrusted: [],
        own: [{ name: "step.md", text: "# Step\n" }],
        allow: [],
        specDir: "specs/K-2/",
        onEnd: (x) => {
          ended = x;
        },
      });
      expect(held.status).toBe(202);
      // A user review start while the task step runs.
      const { id: pr } = s.db
        .query(
          `INSERT INTO pull_request (project, repo, pr_id, title, description, author_slug, author_name, my_role, state, source_head, target_head,
            source_branch, target_branch, updated_date, on_dashboard, followed)
          VALUES ('PROJ', 'repo', 12, 'PR', '', 'a', 'A', 'REVIEWER', 'OPEN', $h, $h, 'f', 'main', 1, 1, 1) RETURNING id`,
        )
        .get({ h: s.base }) as { id: number };
      const start = s.jobs.review(s.db, pr) as { status: number; conflict?: RunConflict };
      expect(start.status).toBe(409);
      expect(start.conflict?.error).toBe("Claude is building K-2. Pause building after this step to start your run.");
      expect(start.conflict?.running).toMatchObject({ pr: null, kind: "implement", task: other });
      // The loop of K-1 finds the slot busy: its build run waits, and the reason names the holder.
      s.loop.build(s.db, s.task);
      await until(() => s.blocked()?.kind === "slot");
      expect(s.blocked()?.text).toBe("Waiting for the build of K-2 to free the run slot.");
      const waiting = s.steps().find((x) => x.state === "waiting") as Step;
      expect([waiting.kind, waiting.item, waiting.run]).toEqual(["implement", "build", null]);
      // The end of the step of K-2 frees the slot.
      expect(s.jobs.cancelTask(s.db, other)).toBe(true);
      await s.loop.idle(s.task);
      expect(ended).not.toBeNull();
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      // The waiting row became the running step of the run.
      const row = s.steps().find((x) => x.id === waiting.id) as Step;
      expect([row.state, row.run !== null]).toEqual(["ok", true]);
    },
    SLOW,
  );

  test(
    "AC-B192: with the run limit 2, a step that finds the pool full waits with the limit text and starts when a pool run ends; a step beside the pool never waits",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ hang: true }, { hang: true }, { hang: true }, { writes: [TEST_FILE, WORKS], ticks: TICK }],
        },
        runLimits: { runsAtOnce: 2 },
      });
      // A step of another task that runs until its cancel. extra: a step of a task that builds two or more parts at once.
      const other = async (key: string, extra: boolean) => {
        const task = s.addTask(key, "Other");
        const now = Date.now();
        const branch = `feature/${key}-other`;
        const part = (
          s.db
            .query(
              `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
              VALUES ($task, 1, 'single', 'Other', $branch, 'main', 'implementing', $now, $now) RETURNING id`,
            )
            .get({ task, now, branch }) as { id: number }
        ).id;
        const wt = await openWorktree({ dataDir: s.dataDir, db: s.db, project: "PROJ", repo: "repo", task, ord: 1, branch, base: s.base });
        return startStep({
          db: s.db,
          review: s.jobs,
          task,
          part: { id: part, ord: 1 },
          wt,
          mode: "implement",
          item: "T1.1",
          attempt: 1,
          profile: profileOf(s.settings.profiles(), DEFAULT_PROFILE),
          untrusted: [],
          own: [{ name: "step.md", text: "# Step\n" }],
          allow: [],
          specDir: `specs/${key}/`,
          onEnd: () => {},
          extra,
        });
      };
      // K-2 and K-3 take both pool slots. K-4 runs beside the full pool.
      const held = [await other("K-2", false), await other("K-3", false)];
      expect(held.map((r) => r.status)).toEqual([202, 202]);
      expect(s.jobs.busy()).toMatchObject({ full: 2, running: { pr: null, kind: "implement" } });
      expect((await other("K-4", true)).status).toBe(202);
      expect(s.jobs.slots(s.db).running.map((r) => r.taskKey)).toEqual(["K-2", "K-3"]);
      // Each of the three steps runs its own CLI process.
      await until(() => readRecords<{ childPid?: number }>(join(s.root, "calls.jsonl")).filter((c) => c.childPid).length === 3);
      s.loop.build(s.db, s.task);
      await until(() => s.blocked()?.kind === "slot");
      expect(s.blocked()?.text).toBe("Waiting for a free run slot. Claude runs 2 runs at once, your limit.");
      expect(rowStatus(taskDto(s.db, s.t()))).toEqual({ text: "Waiting for a free run slot", needsYou: false });
      const waiting = s.steps().find((x) => x.state === "waiting") as Step;
      // The end of the step of K-2 frees a slot. K-3 keeps the other one.
      const k2 = s.db.query("SELECT id FROM task WHERE key = 'K-2'").get() as { id: number };
      expect(s.jobs.cancelTask(s.db, k2.id)).toBe(true);
      await s.loop.idle(s.task);
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      const row = s.steps().find((x) => x.id === waiting.id) as Step;
      expect([row.state, row.run !== null]).toEqual(["ok", true]);
    },
    SLOW,
  );

  test(
    "AC-B19, AC-B201: Stop during the gate kills the process tree; Continue keeps the build changes and runs no build run",
    async () => {
      const { s, child } = await stopInGate();
      const alive = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      const end = Date.now() + 10_000;
      while (alive() && Date.now() < end) await Bun.sleep(50);
      expect(alive()).toBe(false);
      expect([s.t().state, s.t().stopped_from, s.blocked()]).toEqual(["stopped", "implementing", null]);
      const check = s.steps().at(-1) as Step;
      expect([check.kind, check.item, check.state]).toEqual(["check", "checks", "cancelled"]);
      const cmd = (JSON.parse(check.detail_json) as { commands: { exit: number | null; tail: string; argv: string[] }[] }).commands[0];
      expect(cmd?.exit).toBeNull();
      expect(cmd?.tail).toContain("[The app stopped the command.]");
      expect(cmd?.argv).toEqual([process.execPath, "test"]);
      expect(s.flow().filter((x) => x.startsWith("implement:"))).toEqual(["implement:build:ok"]);
      const impl = s.steps().find((x) => x.kind === "implement") as Step;
      expect(JSON.parse(impl.detail_json).checked).toBe(true);
      // The changes of the build run are not committed yet.
      const w = await s.wt();
      expect((await status(w)).map((e) => e.path).sort()).toEqual(["specs/K-1/plan.md", "src/feature.ts", "tests/feature.test.ts"]);
      s.mode("green");
      const resumed = s.loop.resume(s.db, s.task, { version: s.t().version });
      expect([resumed.status, (resumed as { task: TaskDto }).task.state]).toEqual([200, "implementing"]);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      // The kept changes went to the gate, the red check to a fix run, and the fix to the commit. No reset, so no patch.
      expect(s.steps().filter((x) => x.kind === "implement")).toHaveLength(1);
      expect(s.flow().slice(s.flow().indexOf("check:checks:cancelled") + 1, s.flow().indexOf("commit:build:ok") + 1)).toEqual([
        "check:checks:failed",
        "fix:checks:ok",
        "check:checks:ok",
        "commit:build:ok",
      ]);
      expect(existsSync(join(w.dir, "..", "patches"))).toBe(false);
      // part-session.md section 2.2: the fix run forks the kept transcript of the build run, which knows the kept changes.
      const fix = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      expect(fix.argv).toContain("--resume");
      expect(fix.context["continue-diff.md"]).toBeUndefined();
    },
    SLOW,
  );

  test(
    "AC-B298: a build run at its turn cap continues once by itself; the commit holds the work of both runs",
    async () => {
      const HELPER = { path: "repo/src/helper.ts", text: "export const helper = 1;\n" };
      const s = await setup({
        seq: {
          "implement:build": [
            { writes: [HELPER], fixture: MAX_TURNS },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const builds = s.steps().filter((x) => x.kind === "implement");
      expect(builds.map((x) => [x.state, x.attempt, JSON.parse(x.detail_json).session.purpose])).toEqual([
        ["failed", 1, "build"],
        ["ok", 2, "continue"],
      ]);
      const second = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(second.context["step.md"]).toContain("The last run reached its turn cap. Continue where you stopped.");
      // part-session.md section 2.2, Cut runs (Gate B37 U101): the second run forks the kept transcript of the cut run.
      expect(second.argv).toContain("--resume");
      expect(second.context["continue.md"]).toBeUndefined();
      const w = await s.wt();
      expect(existsSync(join(w.dir, "..", "patches"))).toBe(false);
      const files = await git([`--git-dir=${w.admin}`, "show", "--name-only", "--format=", "HEAD"], { env: w.env });
      expect((await s.log()).at(-1)).toBe(`Ada Example <ada@example.invalid>|${KEY}: Add the feature`);
      expect(files.trim().split("\n").sort()).toEqual(["specs/K-1/plan.md", "src/feature.ts", "src/helper.ts", "tests/feature.test.ts"]);
    },
    SLOW,
  );

  test(
    "AC-B203, AC-B297: a run that an app restart cut gives error/restart; Continue resets it, and the patch goes to continue-diff.md",
    async () => {
      const { s } = await stopInGate();
      // The app stopped while the build run ran: its row and its run were still open, and it had no snapshot.
      const impl = s.steps().find((x) => x.kind === "implement") as Step;
      s.db.query("UPDATE task_step SET state = 'running', ended_at = NULL, detail_json = '{}' WHERE id = $id").run({ id: impl.id });
      s.db.query("UPDATE review_run SET status = 'running' WHERE id = $id").run({ id: impl.run });
      s.db.query("UPDATE task SET state = 'implementing', stopped_from = NULL").run();
      recoverTasks(s.db);
      s.db
        .query(
          "UPDATE review_run SET status = 'failed', error_kind = 'restart', error_text = 'The app stopped during the run.' WHERE id = $id",
        )
        .run({ id: impl.run });
      expect([s.t().state, (s.steps().find((x) => x.id === impl.id) as Step).state]).toEqual(["implementing", "failed"]);
      expect(s.blocked()).toMatchObject({ kind: "error", cause: "restart", step: impl.id });
      s.mode("feature");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const w = await s.wt();
      expect(readFileSync(join(w.dir, "..", "patches", `${impl.id}.patch`), "utf8")).toContain(
        "diff --git a/src/feature.ts b/src/feature.ts",
      );
      const second = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(second.context["step.md"]).toContain(
        "The app reset the work of the last run. ./context/continue-diff.md holds it as a patch. Reuse what is right.",
      );
      expect(second.context["continue-diff.md"]).toContain("+export const feature = 'todo';");
    },
    SLOW,
  );

  test(
    "AC-B266: a run that an app restart cut keeps its work when its snapshot passes; checked stays, and Continue goes on in the worktree",
    async () => {
      const { s } = await stopInGate();
      const impl = s.steps().find((x) => x.kind === "implement") as Step;
      // The snapshot of the run start in the step row: the git state, and the inputs of the path check.
      const w = await s.wt();
      const snap = await snapGit([w]);
      const json = await cutJson(w, snap, { allow: [], ignored: [...(await ignoredSnapshot(w))], shell: null, dirtyBefore: [] });
      stopGit(snap);
      s.db
        .query("UPDATE task_step SET state = 'running', ended_at = NULL, detail_json = '{}', cut_json = $json WHERE id = $id")
        .run({ id: impl.id, json });
      s.db.query("UPDATE review_run SET status = 'running' WHERE id = $id").run({ id: impl.run });
      s.db.query("UPDATE task SET state = 'implementing', stopped_from = NULL").run();
      recoverTasks(s.db, Date.now(), s.dataDir);
      s.db
        .query(
          "UPDATE review_run SET status = 'failed', error_kind = 'restart', error_text = 'The app stopped during the run.' WHERE id = $id",
        )
        .run({ id: impl.run });
      const cut = s.steps().find((x) => x.id === impl.id) as Step;
      expect([s.t().state, cut.state]).toEqual(["implementing", "failed"]);
      expect(s.blocked()).toMatchObject({ kind: "error", cause: "restart", step: impl.id });
      expect(JSON.parse(cut.detail_json)).toMatchObject({ checked: true, patch: null });
      expect(JSON.parse(cut.detail_json).written).toContain("repo/src/feature.ts");
      expect(s.db.query("SELECT cut_json FROM task_step WHERE id = $id").get({ id: impl.id })).toEqual({ cut_json: null });
      s.mode("feature");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      expect(existsSync(join(w.dir, "..", "patches", `${impl.id}.patch`))).toBe(false);
      // Every task is ticked in the kept work, so no build run starts. The fix run forks the transcript of the last finished run, which
      // lacks the cut run, so it reads the line of section 2.2 and continue.md.
      expect(s.steps().filter((x) => x.kind === "implement")).toHaveLength(1);
      const fix = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      expect(fix.argv).toContain("--resume");
      expect(fix.context["continue.md"]).toContain("# The earlier work on this part");
      expect(fix.context["step.md"]).toContain(
        "The last run stopped when the app stopped. Its changes are in the worktree. context/continue.md lists them.",
      );
    },
    SLOW,
  );

  test(
    'AC-B203: "start-step-again" resets to the last commit with the patch saved; the route takes only that option',
    async () => {
      const s = await setup({ mode: "late-red", runLimits: { testFixTries: 1 } });
      await s.build();
      expect(s.blocked()?.text).toBe("Needs you: the checks of part 1 stay red after 1 try.");
      const fix = s.steps().find((x) => x.kind === "fix") as Step;
      // The route: zod refuses an unknown option.
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const post = async (body: unknown) =>
        (
          await app.request(`${ORIGIN}/api/tasks/${s.task}/resume`, {
            method: "POST",
            headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status;
      expect(await post({ version: s.t().version, option: "keep-one-pr" })).toBe(400);
      // A stale version passes zod and gets 409, so the route takes the option. The app has its own loop, so the test acts on s.loop.
      expect(await post({ version: s.t().version - 1, option: "start-step-again" })).toBe(409);
      const w = await s.wt();
      expect((await status(w)).map((e) => e.path).sort()).toEqual(["specs/K-1/plan.md", "src/feature.ts", "tests/feature.test.ts"]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version, option: "start-step-again" }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(readFileSync(join(w.dir, "..", "patches", `${fix.id}.patch`), "utf8")).toContain("src/feature.ts");
      expect(JSON.parse((s.steps().find((x) => x.id === fix.id) as Step).detail_json).patch).toBe(`${fix.id}.patch`);
      // The reset takes the ticks too, so the build runs again on the last commit and reads the patch.
      const again = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(again.context["step.md"]).toContain("The app reset the work of the last run. ./context/continue-diff.md holds it as a patch.");
      expect(again.context["continue-diff.md"]).toContain("+export const feature = 'works';");
      expect(s.steps().filter((x) => x.kind === "implement")).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "AC-B215: a second reset before a new Claude run keeps the first patch; Start the step again picks a new file and never replaces one",
    async () => {
      const { s } = await stopInGate();
      // The app restart cut the build run, as in the AC-B203 test.
      const impl = s.steps().find((x) => x.kind === "implement") as Step;
      s.db.query("UPDATE task_step SET state = 'running', ended_at = NULL, detail_json = '{}' WHERE id = $id").run({ id: impl.id });
      s.db.query("UPDATE review_run SET status = 'running' WHERE id = $id").run({ id: impl.run });
      recoverTasks(s.db);
      s.db
        .query(
          "UPDATE review_run SET status = 'failed', error_kind = 'restart', error_text = 'The app stopped during the run.' WHERE id = $id",
        )
        .run({ id: impl.run });
      // No approved test command: each Continue makes its reset and then waits before the next Claude run.
      const commands = (s.db.query("SELECT commands_json FROM repo_task_settings").get() as { commands_json: string }).commands_json;
      s.db.run("UPDATE repo_task_settings SET commands_json = '[]'");
      const last = s.steps().at(-1) as Step;
      const w = await s.wt();
      const patches = join(w.dir, "..", "patches");
      const resume = async (option?: "start-step-again") => {
        expect(s.loop.resume(s.db, s.task, { version: s.t().version, option }).status).toBe(200);
        await s.loop.idle(s.task);
        expect(s.blocked()?.kind).toBe("error");
      };
      await resume();
      const first = readFileSync(join(patches, `${impl.id}.patch`), "utf8");
      expect(first).toContain("+export const feature = 'todo';");
      // An untracked file comes before any new Claude run, as setup makes one. Continue keeps it and the patch of the cut run.
      writeFileSync(join(w.repo, "junk1.txt"), "one\n");
      await resume();
      expect(readFileSync(join(patches, `${impl.id}.patch`), "utf8")).toBe(first);
      expect(existsSync(join(w.repo, "junk1.txt"))).toBe(true);
      // Start the step again resets under the newest row of the part. A second one with the same row picks a new file name.
      await resume("start-step-again");
      expect(readFileSync(join(patches, `${last.id}.patch`), "utf8")).toContain("junk1.txt");
      writeFileSync(join(w.repo, "junk2.txt"), "two\n");
      await resume("start-step-again");
      expect(readFileSync(join(patches, `${last.id}.patch`), "utf8")).toContain("junk1.txt");
      expect(readFileSync(join(patches, `${last.id}.1.patch`), "utf8")).toContain("junk2.txt");
      expect(readFileSync(join(patches, `${impl.id}.patch`), "utf8")).toBe(first);
      // The row keeps the mark that names its first patch.
      expect(JSON.parse((s.steps().find((x) => x.id === last.id) as Step).detail_json).patch).toBe(`${last.id}.patch`);
      // With the command back, the next build run reads the patch of the cut run, not a later one.
      s.db.query("UPDATE repo_task_settings SET commands_json = $c").run({ c: commands });
      s.mode("feature");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const second = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(second.context["continue-diff.md"]).toContain("+export const feature = 'todo';");
      expect(second.context["continue-diff.md"]).not.toContain("junk");
    },
    SLOW,
  );

  test(
    "AC-B215: a reset whose patch cannot be saved still marks the step, so the next run reads that the app reset the work",
    async () => {
      const s = await setup({ mode: "late-red", runLimits: { testFixTries: 1 } });
      await s.build();
      const fix = s.steps().find((x) => x.kind === "fix") as Step;
      // A file in place of the patches folder makes each patch save fail.
      writeFileSync(join((await s.wt()).dir, "..", "patches"), "not a folder\n");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version, option: "start-step-again" }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(JSON.parse((s.steps().find((x) => x.id === fix.id) as Step).detail_json).patch).toBe(PATCH_LOST);
      const again = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(again.context["step.md"]).toContain("The app reset the work of the last run to the last commit.");
    },
    SLOW,
  );

  test(
    "AC-B217: a Tell Claude send that changes nothing on a part with kept build work commits nothing, and the work stays",
    async () => {
      const s = await setup({ mode: "late-red", runLimits: { testFixTries: 1 } });
      await s.build();
      const red = s.blocked();
      expect(red?.text).toBe("Needs you: the checks of part 1 stay red after 1 try.");
      const w = await s.wt();
      const kept = ["specs/K-1/plan.md", "src/feature.ts", "tests/feature.test.ts"];
      expect((await status(w)).map((e) => e.path).sort()).toEqual(kept);
      s.scenario({ seq: { "implement:instruct": [{ writes: [] }] } });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Why is the test red?" }).status).toBe(202);
      await s.loop.idle(s.task);
      const row = s.steps().find((x) => x.kind === "instruct") as Step;
      expect(JSON.parse(row.detail_json).instruct).toMatchObject({ result: "no_change", committed: false });
      expect(s.flow().at(-1)).toBe("instruct:I1:ok");
      expect((await status(w)).map((e) => e.path).sort()).toEqual(kept);
      expect(s.blocked()).toEqual(red);
    },
    SLOW,
  );

  test(
    "AC-B217: a stopped Tell Claude send saves the kept build work in its patch; the next build run continues from that patch",
    async () => {
      const s = await setup({ mode: "late-red", runLimits: { testFixTries: 1 } });
      await s.build();
      const FLAG = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const useNewParser = true;\n" };
      s.scenario({ seq: { "implement:instruct": [{ hang: true, writes: [FLAG] }] } });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag." }).status).toBe(202);
      // The Stop comes after the app read the Write call of the send.
      const written = `SELECT 1 FROM run_event e JOIN task_step s ON s.run = e.run WHERE s.task = $t AND s.kind = 'instruct'
        AND e.tool = 'Write'`;
      await until(() => s.db.query(written).get({ t: s.task }) !== null);
      expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      const row = s.steps().find((x) => x.kind === "instruct") as Step;
      const w = await s.wt();
      expect(await status(w)).toEqual([]);
      expect(readFileSync(join(w.dir, "..", "patches", `${row.id}.patch`), "utf8")).toContain("useNewParser");
      // Continue: the reset took the ticks, so the build runs again and reads the patch of the send.
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      const build = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(build.context["step.md"]).toContain("The app reset the work of the last run.");
      expect(build.context["continue-diff.md"]).toContain("+export const useNewParser = true;");
    },
    SLOW,
  );

  test(
    "Stop while a Claude run runs cancels its run at once",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ delayMs: 5000, writes: [TEST_FILE] }] } });
      s.loop.build(s.db, s.task);
      const running = () => s.db.query("SELECT 1 FROM review_run WHERE task = $t AND status = 'running'").get({ t: s.task }) !== null;
      await until(running);
      const t0 = Date.now();
      expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(Date.now() - t0).toBeLessThan(3000);
      const runs = s.db.query("SELECT kind, status FROM review_run WHERE task = $t").all({ t: s.task });
      expect(runs).toEqual([{ kind: "implement", status: "cancelled" }]);
      expect(s.flow()).toEqual(["commit:plan:ok", "check:base:ok", "implement:build:cancelled"]);
      expect(s.t().state).toBe("stopped");
      expect(s.blocked()).toBeNull();
    },
    SLOW,
  );

  test(
    "Stop before a Claude run starts starts no run",
    async () => {
      const s = await setup();
      // git ls-files --ignored runs in startStep after the guard of the step and before the run starts.
      const spawn = Bun.spawn;
      let fired = false;
      (Bun as { spawn: unknown }).spawn = ((cmd: unknown, o: unknown) => {
        if (!fired && Array.isArray(cmd) && cmd.includes("ls-files") && cmd.includes("--ignored")) {
          fired = true;
          s.loop.stop(s.db, s.task, { version: s.t().version });
        }
        return (spawn as (a: unknown, b: unknown) => unknown)(cmd, o);
      }) as unknown;
      cleanup.push(() => {
        (Bun as { spawn: unknown }).spawn = spawn;
      });
      await s.build();
      expect(fired).toBe(true);
      expect(s.runCalls()).toHaveLength(0);
      expect(s.db.query("SELECT COUNT(*) AS n FROM review_run WHERE task = $t").get({ t: s.task })).toEqual({ n: 0 });
      expect(s.flow()).toEqual(["commit:plan:ok", "check:base:ok", "implement:build:cancelled"]);
      expect(JSON.parse((s.steps().at(-1) as Step).detail_json).notes).toEqual(["The build stopped before the step started."]);
      expect(s.t().state).toBe("stopped");
    },
    SLOW,
  );

  test(
    "AC-B20, AC-B296: a change of a plan file that is no tick blocks with spec_change; Reject resets the run, and the run runs again",
    async () => {
      const plan = { path: `repo/specs/${KEY}/plan.md`, text: "# Plan: changed\n" };
      const s = await setup({
        seq: {
          "implement:build": [
            {
              writes: [WORKS, plan],
              implement: {
                summary: "s",
                done: false,
                tests: [],
                question: null,
                specChange: "The plan names the wrong file.",
                notes: [],
                coverage: NO_COVERAGE,
              },
            },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      await s.build();
      const b = s.blocked();
      expect(b).toMatchObject({ kind: "spec_change", text: "Needs you: Claude proposes a change to the spec." });
      const row = s.steps().find((x) => x.id === b?.step) as Step;
      expect(row.kind).toBe("spec_change");
      expect(JSON.parse(row.detail_json)).toMatchObject({
        specChange: { paths: [`specs/${KEY}/plan.md`] },
        notes: ["The plan names the wrong file."],
      });
      // The proposal stays in the worktree for "Review the change".
      expect((await status(await s.wt())).map((e) => e.path).sort()).toEqual(["specs/K-1/plan.md", "src/feature.ts"]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(409);
      const wrong = await s.loop.specChange(s.db, s.task, (b?.step as number) + 1, { version: s.t().version, accept: false });
      expect(wrong.status).toBe(409);
      const r = await s.loop.specChange(s.db, s.task, b?.step as number, { version: s.t().version, accept: false });
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      expect(JSON.parse((s.steps().find((x) => x.id === b?.step) as Step).detail_json).notes).toEqual([
        "The plan names the wrong file.",
        "The user rejected the change.",
        "Runs again without the plan change.",
      ]);
      // The rerun reads the rejection in step.md, the trusted file of the app. The first run did not.
      const [first, second] = s.runCalls().filter((c) => s.modeOf(c) === "build") as [Call, Call];
      expect(first.context["step.md"]).not.toContain("rejected");
      expect(second.context["step.md"]).toContain(
        `The user rejected your change to specs/${KEY}/plan.md. Your reason was: The plan names the wrong file. Do not change files under specs/${KEY}/. Do the task under the current plan. If you cannot, ask in question.`,
      );
      expect(second.context["step.md"]).toContain("- Attempt: 2");
      expect(s.part().state).toBe("self_reviewed");
      const w = await s.wt();
      expect(readFileSync(join(w.repo, "specs", KEY, "plan.md"), "utf8")).toContain("### [x] T1.1");
      expect(
        s
          .steps()
          .filter((x) => x.kind === "implement")
          .map((x) => x.attempt),
      ).toEqual([1, 2]);
    },
    SLOW,
  );

  test(
    "a plan change that the user accepts is committed, and the build goes on from it",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [{ writes: [TEST_FILE, WORKS, { path: `repo/specs/${KEY}/notes.md`, text: "A note.\n" }], ticks: TICK }],
        },
      });
      await s.build();
      const b = s.blocked();
      expect(b?.kind).toBe("spec_change");
      const r = await s.loop.specChange(s.db, s.task, b?.step as number, { version: s.t().version, accept: true });
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      expect((await s.log()).at(1)).toBe(`Ada Example <ada@example.invalid>|${KEY}: Change the plan`);
      const w = await s.wt();
      // The commit holds the plan files only. The build starts again under the new plan.
      const files = await git([`--git-dir=${w.admin}`, "show", "--name-only", "--format=", "HEAD~1"], { env: w.env });
      expect(files.trim().split("\n")).toEqual([`specs/${KEY}/notes.md`]);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "implement")
          .map((x) => x.attempt),
      ).toEqual([1, 2]);
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );

  test(
    "a question of Claude blocks with the question; the answer runs the build again with answers.md and the kept changes",
    async () => {
      const ask = {
        summary: "s",
        done: false,
        tests: [],
        question: {
          text: "Keep the old name?",
          why: "Callers use it.",
          options: [
            { label: "Keep", detail: "No change for callers." },
            { label: "Rename", detail: "Clearer." },
          ],
          recommended: 0,
        },
        specChange: "",
        notes: [],
        coverage: NO_COVERAGE,
      };
      const s = await setup({
        seq: {
          "implement:build": [
            { writes: [TODO], implement: ask },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      await s.build();
      const b = s.blocked();
      expect(b).toMatchObject({ kind: "question", text: "Needs you: Claude asks: Keep the old name?" });
      const q = s.db.query("SELECT id, source, kind, recommended, step FROM task_question WHERE task = $t").get({ t: s.task }) as Record<
        string,
        unknown
      >;
      expect(q).toMatchObject({ source: "loop", kind: "choice", recommended: 0, step: b?.step });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(409);
      const a = s.loop.answer(s.db, s.task, { version: s.t().version, answers: [{ question: q.id as number, choice: 1 }] });
      expect(a.status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const again = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      const answers = again.context["answers.md"] ?? "";
      expect(answers).toContain("Keep the old name?");
      expect(answers).toContain("- Answer: Rename. Clearer.");
      expect(again.context["step.md"] ?? "").toContain("- Attempt: 2");
      // part-session.md section 2.2: the run forks the transcript of the run that asked, which knows the kept changes.
      expect(again.argv).toContain("--resume");
      expect(again.context["continue-diff.md"]).toBeUndefined();
    },
    SLOW,
  );

  test(
    "AC-B216: a run that halts before its question row exists is no done run; Continue resets it with the patch and runs it again",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [
            { writes: [TODO], implement: QUESTION, delayMs: 400 },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      s.loop.build(s.db, s.task);
      // A reason of the same part comes while the run works, so no part row can keep the question.
      await until(() => s.runCalls().some((c) => s.modeOf(c) === "build"));
      const held = { kind: "red", step: null, part: s.part().id, text: "Needs you: held." };
      s.db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ id: s.task, b: JSON.stringify(held) });
      await s.loop.idle(s.task);
      expect(s.db.query("SELECT id FROM task_question WHERE task = $t").all({ t: s.task })).toEqual([]);
      const impl = s.steps().find((x) => x.kind === "implement") as Step;
      expect([impl.state, JSON.parse(impl.detail_json).checked]).toEqual(["ok", false]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      expect(readFileSync(join((await s.wt()).dir, "..", "patches", `${impl.id}.patch`), "utf8")).toContain("src/feature.ts");
      const again = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(again.context["step.md"]).toContain("The app reset the work of the last run.");
    },
    SLOW,
  );

  test(
    "Pause after this step: the loop holds before it takes the run slot again and keeps the work; Resume goes on",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ delayMs: 60, writes: [TEST_FILE, TODO], ticks: TICK }] } });
      s.loop.build(s.db, s.task);
      await until(() => s.steps().some((x) => x.kind === "implement" && x.state === "running"));
      expect(s.loop.pause(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await until(() => s.blocked()?.text === PAUSED);
      expect(s.blocked()).toEqual({ kind: "question", step: null, text: PAUSED });
      // The slot is free for the user's run. The gate ran its checks before the pause, and the fix run waits.
      expect(s.jobs.busy()).toBeNull();
      expect(s.flow()).toEqual(["commit:plan:ok", "check:base:ok", "implement:build:ok", "check:checks:failed"]);
      expect(s.loop.running(s.task)).toBe(true);
      const r = s.loop.resume(s.db, s.task, { version: s.t().version });
      expect(r.status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      // A pause with no build gets 409.
      expect(s.loop.pause(s.db, s.task, { version: s.t().version }).status).toBe(409);
    },
    SLOW,
  );

  test(
    "Pause: a pause that no gate takes ends with its driver, so the next driver runs; a driver that only ends its base check refuses Pause",
    async () => {
      let hold: Promise<void> | null = null;
      let release = () => {};
      let held = false;
      let built = () => false;
      const s = await setup({
        seq: { review: [{ delayMs: 400, review: CLEAN }, { review: CLEAN }], "implement:instruct": [{ writes: [FIXED] }] },
        remote: async () => {
          if (hold && built()) {
            held = true;
            await hold;
          }
        },
      });
      built = () => (s.part() as { state: string } | null)?.state === "self_reviewed";
      s.loop.build(s.db, s.task);
      // The own review is the last step of the part. A pause in it reaches no gate.
      await until(() => s.steps().some((x) => x.kind === "review" && x.state === "running"));
      expect(s.loop.pause(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect([s.part().state, s.blocked()]).toEqual(["self_reviewed", null]);
      // The base check at the driver end: no step is left, so Pause gets 409.
      hold = new Promise<void>((r) => {
        release = r;
      });
      expect(s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the check flag." }).status).toBe(202);
      await until(() => held || s.blocked()?.text === PAUSED);
      expect(s.blocked()).toBeNull();
      expect(s.loop.running(s.task)).toBe(true);
      const r = s.loop.pause(s.db, s.task, { version: s.t().version });
      expect([r.status, (r as { error?: string }).error]).toEqual([409, "No step is left to pause. The build ends now."]);
      release();
      await s.loop.idle(s.task);
      expect(s.flow().slice(-4)).toEqual(["instruct:I1:ok", "check:I1:ok", "commit:I1:ok", "review:review:ok"]);
      expect(s.blocked()).toBeNull();
    },
    SLOW,
  );

  test(
    "Continue after a pause and an app restart goes on with no reset, so the changes of the done run stay",
    async () => {
      const s = await setup({ mode: "late-red", seq: { "implement:fix": [{ delayMs: 300, writes: [WORKS] }] } });
      s.loop.build(s.db, s.task);
      // The first fix run writes WORKS. The checks stay red, so the next fix run waits at the gate with WORKS not committed.
      await until(() => s.steps().some((x) => x.kind === "fix" && x.state === "running"));
      expect(s.loop.pause(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await until(() => s.blocked()?.text === PAUSED);
      const w = await s.wt();
      expect(readFileSync(join(w.repo, "src", "feature.ts"), "utf8")).toContain("works");
      expect((await status(w)).map((e) => e.path).sort()).toEqual(["specs/K-1/plan.md", "src/feature.ts", "tests/feature.test.ts"]);
      // The app stops and starts again over the same database. No gate holds the part now.
      await s.loop.shutdown();
      recoverTasks(s.db);
      expect([s.t().state, s.blocked()?.text]).toEqual(["implementing", PAUSED]);
      const loop = createLoop({ review: s.jobs, settings: s.settings, live: s.live });
      s.jobs.onStop(() => loop.shutdown());
      s.mode("green");
      expect(loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      // The kept change went into the commit of the gate. A reset would have saved it as a patch and dropped it.
      expect(readFileSync(join(w.repo, "src", "feature.ts"), "utf8")).toContain("works");
      expect((await s.log()).at(-1)).toBe(`Ada Example <ada@example.invalid>|${KEY}: Add the feature`);
      expect(existsSync(join(w.dir, "..", "patches"))).toBe(false);
    },
    SLOW,
  );

  test(
    "AC-B305: a waiting reason of a kind that the app sets no more (budget/time) clears on Continue, and the build goes on",
    async () => {
      const s = await setup();
      const now = Date.now();
      s.db
        .query(
          `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($t, 1, 'single', 'Add the feature', 'feature/K-1-add-the-feature', 'main', 'implementing', $now, $now)`,
        )
        .run({ t: s.task, now });
      const old: TaskBlocked = { kind: "budget", step: null, text: "Needs you: part 1 used its 120 min. Continue with 60 more min?" };
      s.db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ id: s.task, b: JSON.stringify(old) });
      expect(s.blocked()).toEqual(old);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      expect(JSON.parse(s.t().settings_json)).toEqual({});
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );

  test(
    "AC-B261: a denied path of a run blocks with denied_path; only that file goes back; Resume keeps the other work in the worktree",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [
            { writes: [WORKS, { path: "repo/CLAUDE.md", text: "planted\n" }] },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      await s.build();
      expect(s.blocked()).toMatchObject({ kind: "denied_path", cause: "path" });
      const denied = s.steps().find((x) => x.kind === "implement") as Step;
      expect(JSON.parse(denied.detail_json)).toMatchObject({ checked: true, patch: null });
      const w = await s.wt();
      expect((await status(w)).map((e) => e.path)).toEqual(["src/feature.ts"]);
      expect(readFileSync(join(w.dir, "..", "patches", `${denied.id}.patch`), "utf8")).not.toContain("src/feature.ts");
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const again = s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call;
      expect(again.context["step.md"]).toContain("The work that is not committed is in the worktree.");
      expect(again.context["continue-diff.md"]).toContain("src/feature.ts");
      // The patch of the run holds the undone file. The diff of the kept work does not, and the notes name the path for Claude.
      expect(again.context["continue-diff.md"]).not.toContain("diff --git a/CLAUDE.md");
      expect(again.context["continue.md"]).toContain("CLAUDE.md: A step may not change this path.");
    },
    SLOW,
  );
});

describe("an existing branch on the server (spec.md section 6.16.4)", () => {
  // push.ts takes a Jira key with two or more letters before the hyphen.
  const PUSH_KEY = "AB-1";
  const NAME = `feature/${PUSH_KEY}-add-the-feature`;
  // A colleague commit on the remote branch NAME, on top of base.
  const colleague = async (s: Awaited<ReturnType<typeof setup>>, parent: string, msg: string) => {
    const c = await s.r.g(["commit-tree", `${parent}^{tree}`, "-p", parent, "-m", msg]);
    await s.r.g(["update-ref", `refs/heads/${NAME}`, c]);
    return c;
  };

  test(
    "AC-B31: Continue builds on the fetched remote head and leases the first push on it; a push after a colleague push fails the lease",
    async () => {
      const s = await setup();
      const id = s.addTask(PUSH_KEY, "Add the feature");
      const remoteHead = await colleague(s, s.base, "colleague");
      await s.build(id);
      expect(s.part(id).state).toBe("self_reviewed");
      expect(s.part(id).branch).toBe(NAME);
      const row = s.db.query("SELECT pushed FROM task_part WHERE id = $id").get({ id: s.part(id).id }) as { pushed: string | null };
      expect(row.pushed).toBe(remoteHead);
      // base_commit: the merge base of the base head and the remote head, so the budget counts the whole PR diff.
      expect(s.t(id).base_commit).toBe(s.base);
      const dataDir = longPath(s.dataDir);
      const cache = cachePath(dataDir, { project: "PROJ", repo: "repo", id });
      const head = s.part(id).head as string;
      const { env, empty } = gitSetup(dataDir);
      await git([`--git-dir=${cache}`, "merge-base", "--is-ancestor", remoteHead, head], { env });

      const argv: string[][] = [];
      const spy: typeof git = (args, o) => {
        argv.push(args);
        return git(args, o);
      };
      const push = () =>
        pushTaskBranch({
          cache,
          emptyGlobal: empty,
          url: s.r.remote,
          config: [],
          commit: head,
          branch: NAME,
          lease: row.pushed,
          task: { key: PUSH_KEY, prefix: "feature/", branches: [NAME], target: "main" },
          git: spy,
        });
      // A colleague pushed after the fetch: the lease fails, and the remote keeps the colleague commit.
      const moved = await colleague(s, remoteHead, "colleague again");
      expect(await push()).toEqual({ status: "stale", sentence: staleText(NAME) });
      expect(await s.r.g(["rev-parse", `refs/heads/${NAME}`])).toBe(moved);
      // Back at the fetched head, the push goes through with the fetched head as its lease. Never a "+" refspec.
      await s.r.g(["update-ref", `refs/heads/${NAME}`, remoteHead]);
      argv.length = 0;
      expect(await push()).toEqual({ status: "pushed" });
      const sent = argv.find((a) => a.includes("push")) as string[];
      expect(sent).toContain(`--force-with-lease=refs/heads/${NAME}:${remoteHead}`);
      expect(sent.some((a) => a.startsWith("+"))).toBe(false);
      expect(await s.r.g(["rev-parse", `refs/heads/${NAME}`])).toBe(head);
    },
    SLOW,
  );

  test(
    "AC-B32: Start a new branch takes the first free suffix and an empty lease",
    async () => {
      const s = await setup({ settings: { existing: "new" } });
      const id = s.addTask(PUSH_KEY, "Add the feature");
      await colleague(s, s.base, "colleague");
      await s.r.g(["update-ref", `refs/heads/${NAME}-2`, s.base]);
      await s.build(id);
      expect(s.part(id).branch).toBe(`${NAME}-3`);
      expect(s.db.query("SELECT pushed FROM task_part WHERE id = $id").get({ id: s.part(id).id })).toEqual({ pushed: null });
      expect(s.t(id).base_commit).toBe(s.base);
    },
    SLOW,
  );
});

describe("restart recovery and the helpers", () => {
  test("AC-B297: a restart gives error/restart to the tasks that worked: a running check, a step that waited for the slot, a part that the loop built", async () => {
    const s = await setup();
    const now = Date.now();
    const add = (key: string) => s.addTask(key, key);
    const a = add("R-1");
    const b = add("R-2");
    const c = add("R-3");
    const d = add("R-4");
    const part = (task: number) =>
      s.db
        .query(
          `INSERT INTO task_part (task, ord, kind, title, branch, base_branch, state, created_at, updated_at)
          VALUES ($task, 1, 'single', 't', $b, 'main', 'implementing', $now, $now)`,
        )
        .run({ task, b: `feature/x-${task}`, now });
    for (const x of [a, b, c, d]) part(x);
    s.db.query("INSERT INTO task_step (task, kind, state, ord, started_at) VALUES ($t, 'check', 'running', 1, $now)").run({ t: a, now });
    s.db.query("INSERT INTO task_step (task, kind, state, ord, started_at) VALUES ($t, 'tests', 'waiting', 1, $now)").run({ t: b, now });
    // b waits for the run slot, so its reason says so. d waits for the user: its reason keeps it.
    const reason = (id: number, kind: string) =>
      s.db.query("UPDATE task SET blocked_json = $b WHERE id = $id").run({ id, b: JSON.stringify({ kind, step: null, text: "x" }) });
    reason(b, "slot");
    reason(d, "red");
    recoverTasks(s.db, now);
    const row = (task: number) => (s.db.query("SELECT id FROM task_step WHERE task = $t").get({ t: task }) as { id: number }).id;
    const partOf = (task: number) => (s.db.query("SELECT id FROM task_part WHERE task = $t").get({ t: task }) as { id: number }).id;
    for (const x of [a, b, c]) expect([s.t(x).state, s.t(x).stopped_from]).toEqual(["implementing", null]);
    // part-session.md section 9.5 (Q-SM2): a soft slot reason gives way; a part between two steps gets the reason with no step.
    expect([s.blocked(a), s.blocked(b)]).toMatchObject([
      { kind: "error", cause: "restart", step: row(a) },
      { kind: "error", cause: "restart", step: row(b) },
    ]);
    expect(s.blocked(c)).toMatchObject({ kind: "error", cause: "restart", step: null, part: partOf(c) });
    expect(s.t(d).state).toBe("implementing");
    expect(s.blocked(d)).toMatchObject({ kind: "red" });
    expect(s.db.query("SELECT state FROM task_step WHERE task IN ($a, $b)").all({ a, b })).toEqual([
      { state: "failed" },
      { state: "failed" },
    ]);
  });

  test("globs follow the gitignore rules; the line count skips lock files; a tick marks one open task", async () => {
    expect(globMatch("*.lock", "a/b/c.lock")).toBe(true);
    expect(globMatch("bun.lock", "pkg/bun.lock")).toBe(true);
    expect(globMatch("/bun.lock", "pkg/bun.lock")).toBe(false);
    expect(globMatch("tests/", "a/tests/x.ts")).toBe(true);
    expect(globMatch("src/tests/", "a/src/tests/x.ts")).toBe(false);
    expect(globMatch("tests/**/*.ts", "tests/a/b.ts")).toBe(true);
    expect(globMatch("*.test.ts", "src/x.test.ts")).toBe(true);
    expect(globMatch("*.test.ts", "src/x.ts")).toBe(false);
    // AC-B161: each default test glob matches its test file and no ordinary source file.
    const hits: Record<string, string> = {
      "test/": "a/test/x.c",
      "tests/": "tests/x.py",
      "unittest/": "src/unittest/unittest/foo_tests.cpp",
      "unittests/": "lib/unittests/a.cc",
      "__tests__/": "web/__tests__/a.tsx",
      "spec/": "spec/models/user_spec.rb",
      "testing/": "pkg/testing/helpers.go",
      "*_test.*": "src/parser_test.go",
      "*_tests.*": "src/foo_tests.cpp",
      "test_*.*": "pkg/test_parser.py",
      "*.test.*": "src/x.test.ts",
      "*.spec.*": "src/x.spec.js",
      "*Test.*": "src/main/java/ParserTest.java",
      "*Tests.*": "Sources/ParserTests.swift",
      "*_unittest.*": "base/strings_unittest.cc",
    };
    expect(Object.keys(hits)).toEqual([...DEFAULT_TEST_GLOBS]);
    for (const [g, path] of Object.entries(hits)) expect([g, globMatch(g, path)]).toEqual([g, true]);
    const plain = [
      "src/feature.ts",
      "src/latest.go",
      "src/contest.cpp",
      "src/Latest.java",
      "src/attest.rs",
      "src/test.cpp",
      "src/testing.go",
    ];
    for (const path of [...plain, "src/inspect.ts", "specs/T-1/plan.md", "src/TestUtils.java", "a/test.py", "x/foo.spec"])
      expect([path, DEFAULT_TEST_GLOBS.filter((g) => globMatch(g, path))]).toEqual([path, []]);
    const text = "### [ ] T1.1 A\nFiles: a\n### [ ] T1.10 B\n";
    expect(tickTask(text, "T1.1")).toBe("### [x] T1.1 A\nFiles: a\n### [ ] T1.10 B\n");
    expect(tickTask("### [x] T1.1 A\n", "T1.1")).toBeNull();
    expect(tickTask(text, "T1")).toBeNull();
    const s = await setup();
    const w = await openWorktree({
      dataDir: s.dataDir,
      db: s.db,
      project: "PROJ",
      repo: "repo",
      task: s.task,
      ord: 1,
      branch: "feature/K-1-count",
      base: s.base,
    });
    writeFileSync(join(w.repo, "bun.lock"), "x\n".repeat(50));
    writeFileSync(join(w.repo, "README.md"), "one\ntwo\n");
    await git([`--git-dir=${w.admin}`, `--work-tree=${w.repo}`, "add", "-A"], { env: w.env });
    await git(
      [`--git-dir=${w.admin}`, `--work-tree=${w.repo}`, "-c", "user.name=a", "-c", "user.email=a@example.invalid", "commit", "-qm", "x"],
      {
        env: w.env,
      },
    );
    const head = (await git([`--git-dir=${w.admin}`, "rev-parse", "HEAD"], { env: w.env })).trim();
    // README.md: 2 added, 1 removed. bun.lock: left out.
    expect(await changedLines(w, s.base, head, LOCK_GLOBS)).toEqual({ files: 1, added: 2, removed: 1, lines: 3 });
    expect((await changedLines(w, s.base, head, [])).lines).toBe(53);
  });
});

describe("routes (spec.md section 6.11)", () => {
  test(
    "spec.md section 6.18.5: Keep one PR during the base check at the driver end waits for that check and gets 200",
    async () => {
      // The base check at the driver end waits at this gate. part-session.md section 5.4: a size reason of an old task still takes Keep
      // one PR, so the test writes one while the driver ends.
      const gate = Promise.withResolvers<void>();
      let held = false;
      let blockedNow = () => false;
      const s = await setup({
        budget: 5,
        remote: async () => {
          if (!blockedNow()) return;
          held = true;
          await gate.promise;
        },
      });
      blockedNow = () => s.part()?.state === "self_reviewed";
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const call = async (path: string, body: unknown) => {
        const res = await app.request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as TaskDto & { error?: string } };
      };
      // The loop of the app starts the build through Resume of a stopped build.
      s.db.query("UPDATE task SET state = 'stopped', stopped_from = 'implementing' WHERE id = $id").run({ id: s.task });
      expect((await call(`/api/tasks/${s.task}/resume`, { version: s.t().version })).status).toBe(200);
      await until(() => held, 120_000);
      const old: TaskBlocked = { kind: "size", step: null, text: "Needs you: this PR would have 9 changed lines, over your 5 limit." };
      s.db.query("UPDATE task SET blocked_json = $b, version = version + 1 WHERE id = $id").run({ id: s.task, b: JSON.stringify(old) });
      expect(s.blocked()?.kind).toBe("size");
      const keep = call(`/api/tasks/${s.task}/limit`, { version: s.t().version, keep: true });
      await Bun.sleep(200);
      gate.resolve();
      const r = await keep;
      expect([r.status, r.body.error]).toEqual([200, undefined]);
      expect(r.body.settings).toMatchObject({ keepOnePr: true });
    },
    SLOW,
  );

  test(
    "pause, stop, resume, and answers go to the loop; a version mismatch gives 409 with the task",
    async () => {
      const s = await setup({ mode: "green" });
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const call = async (path: string, body: unknown) => {
        const res = await app.request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as TaskDto & { error?: string; task?: TaskDto } };
      };
      expect((await call(`/api/tasks/${s.task}/pause`, { version: s.t().version })).status).toBe(409);
      expect((await call(`/api/tasks/${s.task}/stop`, { version: s.t().version + 5 })).body.error).toBe(
        "The task changed on another page. Check it again.",
      );
      const stop = await call(`/api/tasks/${s.task}/stop`, { version: s.t().version });
      expect([stop.status, stop.body.state, stop.body.stoppedFrom]).toEqual([200, "stopped", "implementing"]);
      const resume = await call(`/api/tasks/${s.task}/resume`, { version: s.t().version });
      expect([resume.status, resume.body.state]).toEqual([200, "implementing"]);
      await until(() => s.part()?.state === "self_reviewed", 120_000);
      expect((await call(`/api/tasks/${s.task}/answers`, { version: s.t().version, answers: [] })).body.error).toBe(
        "No question waits for an answer.",
      );
      expect((await call(`/api/tasks/${s.task}/spec-change/x`, { version: s.t().version, accept: true })).status).toBe(400);
    },
    SLOW,
  );
});

test(
  "pre-flight: a base branch that is gone blocks before any Claude step (spec.md section 6.16.7, AC-B42)",
  async () => {
    const s = await setup();
    s.db.query("UPDATE task SET target_branch = 'gone' WHERE id = $id").run({ id: s.task });
    await s.build();
    expect(s.blocked()).toEqual({
      kind: "preflight",
      step: null,
      text: "Needs you: gone no longer exists in PROJ/repo. Pick another base branch.",
      base: { taskRepo: 0, branch: "gone" },
    });
    expect(s.runCalls()).toEqual([]);
    expect(s.steps()).toEqual([]);
  },
  SLOW,
);

test(
  "Pick a base branch before any commit: the new head becomes the base commit, and the build goes on (spec.md section 6.16.7)",
  async () => {
    const s = await setup();
    // develop has a commit that main does not have, so the old base commit is not the new head.
    const env = s.r.env;
    await git(["--git-dir", s.r.remote, "update-ref", "refs/heads/develop", s.base], { env });
    const dev = await remoteCommit(s.r, "develop", { "develop.txt": "develop\n" });
    s.db.query("UPDATE task SET target_branch = 'gone' WHERE id = $id").run({ id: s.task });
    await s.build();
    expect(s.blocked()?.base).toEqual({ taskRepo: 0, branch: "gone" });
    const base = (branch: string) => s.loop.base(s.db, s.task, { version: s.t().version, taskRepo: 0, branch });
    expect(await base("nope")).toMatchObject({ status: 409, error: "nope does not exist in PROJ/repo." });
    expect(await base("gone")).toMatchObject({
      status: 409,
      error: "Needs you: gone no longer exists in PROJ/repo. Pick another base branch.",
    });
    expect((await base("develop")).status).toBe(200);
    await s.loop.idle(s.task);
    expect([s.t().target_branch, s.t().base_commit]).toEqual(["develop", dev]);
    expect(
      s.db.query("SELECT base_branch, base_commit, base_changed FROM task_repo WHERE task = $id AND role = 'main'").get({ id: s.task }),
    ).toEqual({ base_branch: "develop", base_commit: dev, base_changed: 0 });
    expect(s.blocked()).toBeNull();
    // The build ran from the new base: the part starts at the develop commit.
    expect(s.part().state).toBe("self_reviewed");
    const w = await s.wt();
    await git([`--git-dir=${w.admin}`, "merge-base", "--is-ancestor", dev, "HEAD"], { env: w.env });
    // No base change waits after the build.
    expect(taskDto(s.db, s.t()).bases.every((b) => !b.changed)).toBe(true);
    // A reason that is not a gone base takes no base change.
    expect(await base("main")).toMatchObject({ status: 409, error: "The base branch changes only before the build." });
  },
  SLOW,
);

// spec.md section 6.7, Setup: the setup command of the tests below. Each run appends a line to setups.log in the test folder. Mode
// venv writes .venv/ and build/, which no ignore rule covers. Mode ignored writes into ignored/. setup-mode.txt "fail" exits with 1, and
// "hang" never ends.
const SETUP = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
appendFileSync(join(dir, "setups.log"), "run\\n");
const out = process.argv[2] === "venv" ? [".venv/bin/python", "build/out.bin"] : ["ignored/venv.txt"];
if (existsSync(join(dir, "setup-extra.txt"))) out.push("gen/made.txt");
for (const f of out) {
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, "made by setup\\n");
}
const mode = existsSync(join(dir, "setup-mode.txt")) ? readFileSync(join(dir, "setup-mode.txt"), "utf8").trim() : "ok";
if (mode === "hang") setInterval(() => {}, 1000);
else process.exit(mode === "fail" ? 1 : 0);
`;

describe("commit only Claude's files and run setup again (spec.md section 6.7)", () => {
  // The setup command of the repository before the test command. extra: more argv items, so the list changes.
  const withSetup = (s: Awaited<ReturnType<typeof setup>>, mode: "venv" | "ignored", extra: string[] = [], timeoutSec = 60) => {
    writeFileSync(join(s.root, "setup.ts"), SETUP);
    const commands = [
      { id: "s", name: "venv", kind: "setup", argv: [process.execPath, join(s.root, "setup.ts"), mode, ...extra], timeoutSec },
      { id: "t", name: "test", kind: "test", argv: [process.execPath, join(s.root, "check.ts")], timeoutSec: 60 },
    ];
    s.db.query("UPDATE repo_task_settings SET commands_json = $c").run({ c: JSON.stringify(commands) });
  };
  const setups = (s: Awaited<ReturnType<typeof setup>>) =>
    existsSync(join(s.root, "setups.log")) ? readFileSync(join(s.root, "setups.log"), "utf8").split("\n").filter(Boolean).length : 0;

  test(
    "AC-B216: continue.md leaves out the files of the setup mark and lists at most CONTINUE_PATHS_MAX paths",
    async () => {
      // With the resume gate on, the run after the answer forks the transcript and gets no continue.md, so this test turns it off.
      const s = await setup({
        sessionGates: { resume: false, live: true, resolve: false },
        seq: {
          "implement:build": [
            { writes: [TODO], implement: QUESTION },
            { writes: [TEST_FILE, WORKS], ticks: TICK },
          ],
        },
      });
      withSetup(s, "venv");
      await s.build();
      expect([...(readSetupMark(await s.wt())?.files ?? [])].sort()).toEqual([".venv/bin/python", "build/out.bin"]);
      const q = s.db.query("SELECT id FROM task_question WHERE task = $t").get({ t: s.task }) as { id: number };
      expect(s.loop.answer(s.db, s.task, { version: s.t().version, answers: [{ question: q.id, choice: 0 }] }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      const cont = (s.runCalls().filter((c) => s.modeOf(c) === "build")[1] as Call).context["continue.md"] ?? "";
      expect(cont).toContain("- src/feature.ts");
      for (const p of [".venv", "build/out.bin", "made by setup"]) expect(cont).not.toContain(p);
      const paths = Array.from({ length: CONTINUE_PATHS_MAX + 5 }, (_, i) => `f${i}.ts`);
      const many = continueFile({ commits: [], stat: "", ticked: [], open: [], summary: null, notes: [], paths }).text;
      expect(many).toContain(`- f${CONTINUE_PATHS_MAX - 1}.ts\n- and 5 more\n`);
      expect(many).not.toContain(`- f${CONTINUE_PATHS_MAX}.ts`);
    },
    SLOW,
  );

  test(
    "setup output stays out of every commit and each later commit row names it; Claude's new files go in; Run setup again runs it",
    async () => {
      const s = await setup();
      withSetup(s, "venv");
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      expect(setups(s)).toBe(1);
      const w = await s.wt();
      const files = (await git([`--git-dir=${w.admin}`, "log", "--name-only", "--format=", `${s.base}..HEAD`], { env: w.env }))
        .split("\n")
        .filter(Boolean);
      expect([...new Set(files)].sort()).toEqual([`specs/${KEY}/plan.md`, "src/feature.ts", "tests/feature.test.ts"]);
      expect(existsSync(join(w.repo, ".venv", "bin", "python")) && existsSync(join(w.repo, "build", "out.bin"))).toBe(true);
      const note = "Not committed: 2 new files that Claude did not write (.venv/, build/).";
      const commits = s.steps().filter((x) => x.kind === "commit");
      expect(commits.map((x) => [x.item, (JSON.parse(x.detail_json).notes as string[]).includes(note)])).toEqual([
        ["plan", false],
        ["build", true],
      ]);
      // "Run setup again" through the route: 202, 409 while it runs, then a second setup row.
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const call = async (body: unknown) => {
        const res = await app.request(`${ORIGIN}/api/tasks/${s.task}/parts/${s.part().id}/setup`, {
          method: "POST",
          headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as TaskDto & { error?: string } };
      };
      const setupRows = () => s.flow().filter((x) => x.startsWith("check:setup:"));
      expect(taskDto(s.db, s.t()).canSetup).toBe(true);
      const first = await call({ version: s.t().version });
      expect(first.status).toBe(202);
      expect((await call({ version: first.body.version })).body.error).toBe("Claude or the checks are working.");
      await until(() => setupRows().length === 2 && !setupRows().includes("check:setup:running"));
      expect(setupRows()).toEqual(["check:setup:ok", "check:setup:ok"]);
      expect(setups(s)).toBe(2);
      // A red setup blocks with its reason. A green run ends that reason. The driver of the route ends with the base check, so a
      // click right after a run can still get 409.
      const again = async () => {
        for (let k = 0; k < 200; k++) {
          const x = await call({ version: s.t().version });
          if (x.status !== 409) return x;
          await Bun.sleep(100);
        }
        throw new Error("The setup route stayed busy.");
      };
      writeFileSync(join(s.root, "setup-mode.txt"), "fail");
      expect((await again()).status).toBe(202);
      await until(() => s.blocked() !== null);
      expect(s.blocked()?.text).toBe("Needs you: the setup commands of part 1 failed. See why.");
      expect(setups(s)).toBe(3);
      writeFileSync(join(s.root, "setup-mode.txt"), "ok");
      expect((await again()).status).toBe(202);
      await until(() => setups(s) === 4 && s.blocked() === null && !setupRows().includes("check:setup:running"));
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );

  test(
    "a green Run setup again after a red setup in the build lets the build go on to the own review",
    async () => {
      const s = await setup();
      withSetup(s, "venv");
      writeFileSync(join(s.root, "setup-mode.txt"), "fail");
      await s.build();
      expect(s.blocked()?.text).toBe("Needs you: the setup commands of part 1 failed. See why.");
      expect(s.part().state).toBe("implementing");
      expect(s.flow()).toEqual(["commit:plan:ok", "check:setup:failed"]);
      writeFileSync(join(s.root, "setup-mode.txt"), "ok");
      expect(s.loop.setupAgain(s.db, s.task, s.part().id, { version: s.t().version }).status).toBe(202);
      await until(() => setups(s) === 2 && s.blocked() === null && !s.loop.running(s.task));
      expect(s.flow().slice(0, 3)).toEqual(["commit:plan:ok", "check:setup:failed", "check:setup:ok"]);
      expect(s.flow()).toContain("review:review:ok");
      expect(s.part().state).toBe("self_reviewed");
      expect(s.t().state).toBe("implementing");
    },
    SLOW,
  );

  test(
    "a setup command that reaches its time limit blocks red with the limit, and the step row keeps timedOut",
    async () => {
      const s = await setup();
      withSetup(s, "venv", [], 1);
      writeFileSync(join(s.root, "setup-mode.txt"), "hang");
      await s.build();
      expect(s.blocked()).toMatchObject({
        kind: "red",
        text: 'Needs you: the setup command "venv" of part 1 reached its time limit of 0.02 min.',
      });
      expect(s.flow()).toEqual(["commit:plan:ok", "check:setup:failed"]);
      const row = s.steps().find((x) => x.kind === "check") as { detail_json: string };
      expect(JSON.parse(row.detail_json).commands[0]).toMatchObject({ name: "venv", exit: null, timedOut: true, timeoutSec: 1 });
    },
    SLOW,
  );

  test(
    "Stop during the build that a green Run setup again started stops the task",
    async () => {
      const s = await setup({ seq: { "implement:build": [{ hang: true }] } });
      withSetup(s, "venv");
      writeFileSync(join(s.root, "setup-mode.txt"), "fail");
      await s.build();
      expect(s.blocked()?.text).toBe("Needs you: the setup commands of part 1 failed. See why.");
      writeFileSync(join(s.root, "setup-mode.txt"), "ok");
      expect(s.loop.setupAgain(s.db, s.task, s.part().id, { version: s.t().version }).status).toBe(202);
      await until(() => s.flow().includes("implement:build:running"));
      expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.t().state).toBe("stopped");
      expect(s.t().stopped_from).toBe("implementing");
      expect(s.flow()).toContain("implement:build:cancelled");
    },
    SLOW,
  );

  test(
    "AC-B200: setup runs again when its list changes and after a reset that removed a setup file; a reset of Claude's files only does not run it",
    async () => {
      // Test-fix tries 1 and late-red stop the build at red/checks after each build or gate. Each fix run changes the file.
      const fix = (n: number) => ({ writes: [{ path: "repo/src/feature.ts", text: `export const feature = 'works ${n}';\n` }] });
      const s = await setup({ mode: "late-red", runLimits: { testFixTries: 1 }, seq: { "implement:fix": [1, 2, 3, 4].map(fix) } });
      withSetup(s, "ignored");
      // A Continue keeps the work, so "Start the step again" makes the reset here.
      const resume = async (option?: "start-step-again") => {
        expect(s.loop.resume(s.db, s.task, { version: s.t().version, option }).status).toBe(200);
        await s.loop.idle(s.task);
      };
      const RED = "Needs you: the checks of part 1 stay red after 1 try.";
      await s.build();
      expect(s.blocked()?.text).toBe(RED);
      expect(setups(s)).toBe(1);
      // The reset removes a file that setup did not make: setup does not run.
      const junk = join((await s.wt()).repo, "junk.txt");
      writeFileSync(junk, "left by a stop\n");
      await resume("start-step-again");
      expect(existsSync(junk)).toBe(false);
      expect(s.blocked()?.text).toBe(RED);
      expect(setups(s)).toBe(1);
      // The new list runs setup, and it makes gen/made.txt, which git does not ignore.
      writeFileSync(join(s.root, "setup-extra.txt"), "1\n");
      withSetup(s, "ignored", ["v2"]);
      await resume();
      expect(s.blocked()?.text).toBe(RED);
      expect(setups(s)).toBe(2);
      expect(readSetupMark(await s.wt())?.files).toEqual(["gen/made.txt"]);
      // The reset removes gen/made.txt, so setup runs again.
      s.mode("feature");
      await resume("start-step-again");
      expect(setups(s)).toBe(3);
      expect(s.part().state).toBe("self_reviewed");
      expect(s.flow().filter((x) => x.startsWith("check:setup:"))).toEqual(["check:setup:ok", "check:setup:ok", "check:setup:ok"]);
    },
    SLOW,
  );

  // The fix step of the own review runs until its cancel the first `hangs` times.
  const stopInReview = async (hangs: number, withSetupList = false) => {
    const s = await setup({
      seq: {
        "implement:build": [{ writes: [TEST_FILE, WORKS], ticks: TICK }],
        "implement:fix": [...Array.from({ length: hangs }, () => ({ hang: true })), { writes: [FIXED] }],
        review: [{ review: review([point("major")]) }, { review: CLEAN }],
      },
    });
    if (withSetupList) withSetup(s, "ignored");
    const stop = async () => {
      expect(s.loop.stop(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.t().state).toBe("stopped");
    };
    s.loop.build(s.db, s.task);
    await until(() => fixes(s) === 1);
    await stop();
    return { s, stop };
  };
  const count = (s: Awaited<ReturnType<typeof setup>>, row: string) => s.flow().filter((x) => x.startsWith(row)).length;
  // The fix runs that reached the CLI. A seq entry counts only those.
  const fixes = (s: Awaited<ReturnType<typeof setup>>) => s.runCalls().filter((c) => s.modeOf(c) === "fix").length;

  test(
    "AC-B198, AC-B199: Continue after a stop in the own review runs no final checks and no review run; a changed command list runs the checks",
    async () => {
      const { s, stop } = await stopInReview(2);
      expect([count(s, "check:checks:"), count(s, "review:review:")]).toEqual([1, 1]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await until(() => fixes(s) === 2);
      await stop();
      expect([count(s, "check:checks:"), count(s, "review:review:")]).toEqual([1, 1]);
      expect(s.runCalls().filter((c) => s.modeOf(c) === "review").length).toBe(1);
      const step = s.steps().find((x) => x.kind === "check" && x.item === "checks") as Step;
      expect(JSON.parse(step.detail_json)).toMatchObject({
        head: expect.stringMatching(/^[0-9a-f]{40}$/),
        commandsHash: expect.any(String),
      });
      // A new time limit of the test command changes the list, so the final checks run again. The review of this head stays.
      const commands = JSON.parse(
        (s.db.query("SELECT commands_json FROM repo_task_settings").get() as { commands_json: string }).commands_json,
      ) as { timeoutSec: number }[];
      s.db
        .query("UPDATE repo_task_settings SET commands_json = $c")
        .run({ c: JSON.stringify(commands.map((c) => ({ ...c, timeoutSec: 61 }))) });
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.part().state).toBe("self_reviewed");
      // The new list runs the gate once; the gate of the judging run runs the checks again.
      expect(count(s, "check:checks:")).toBe(3);
      expect(s.flow().slice(-6)).toEqual([
        "fix:review:cancelled",
        "check:checks:ok",
        "fix:review:ok",
        "check:checks:ok",
        "commit:review:ok",
        "review:review:ok",
      ]);
      expect(s.runCalls().filter((c) => s.modeOf(c) === "review").length).toBe(2);
    },
    SLOW,
  );

  test(
    "AC-B199: a change in the worktree makes the final checks run again",
    async () => {
      const { s } = await stopInReview(1, true);
      expect(setups(s)).toBe(1);
      // The new setup list fails on Continue, so the build waits. Run setup again then goes on without a reset.
      writeFileSync(join(s.root, "setup-mode.txt"), "fail");
      withSetup(s, "ignored", ["v2"]);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
      await s.loop.idle(s.task);
      expect(s.blocked()?.text).toBe("Needs you: the setup commands of part 1 failed. See why.");
      writeFileSync(join((await s.wt()).repo, "left.txt"), "a change\n");
      writeFileSync(join(s.root, "setup-mode.txt"), "ok");
      expect(s.loop.setupAgain(s.db, s.task, s.part().id, { version: s.t().version }).status).toBe(202);
      await until(() => !s.loop.running(s.task));
      expect(s.part().state).toBe("self_reviewed");
      // The change runs the gate once, and the gate of the judging run runs the checks again.
      expect(count(s, "check:checks:")).toBe(3);
    },
    SLOW,
  );
});

describe("commands that Claude may run (spec.md section 6.21)", () => {
  const ask = (pattern: string) => ({ pattern, command: pattern, reason: `The step runs ${pattern}.` });
  // A step that ends with allowRequest (D3): done false, the patterns, and no other change.
  const asking = (...patterns: string[]) => ({
    implement: {
      summary: "Claude Code refused a command.",
      done: false,
      tests: [],
      question: null,
      specChange: "",
      allowRequest: patterns.map(ask),
      notes: [],
      coverage: NO_COVERAGE,
    },
  });
  type S = Awaited<ReturnType<typeof setup>>;
  const allowRow = (s: S) => s.blocked()?.step ?? 0;
  const detailOf = (s: S, id: number) =>
    JSON.parse((s.steps().find((x) => x.id === id) as Step).detail_json) as {
      notes: string[];
      allowAsk: { requests: unknown[]; decisions: unknown[] } | null;
    };
  const implementCalls = (s: S) => s.runCalls().filter((c) => s.modeOf(c) === "build");
  const allowOf = (s: S, b: Omit<TaskAllowInput, "version" | "step"> & { step?: number }) =>
    s.loop.allow(s.db, s.task, { version: s.t().version, step: allowRow(s), ...b });

  test(
    "D3: allowRequest blocks with kind allow; Allow once, Refuse, and Allow for this repository each run the step again",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [
            { ...asking("make build"), writes: [TODO] },
            asking("make deploy"),
            asking("make deploy", "make lint"),
            { writes: [TEST_FILE, TODO], ticks: TICK },
          ],
        },
      });
      await s.build();
      // Attempt 1 has no Bash: the repository has no pattern yet. Its change stays in the worktree for the next attempt.
      const first = allowRow(s);
      expect(s.blocked()).toEqual({ kind: "allow", step: first, text: "Needs you: Claude asks to allow a command." });
      expect(rowStatus(taskDto(s.db, s.t()))).toEqual({ text: "Needs you: Claude asks to allow a command", needsYou: true });
      expect(taskDto(s.db, s.t()).allowAsk).toEqual({ step: first, requests: [ask("make build")], warning: true });
      expect(implementCalls(s)[0]?.argv.join(" ")).not.toContain("Bash");
      expect((await status(await s.wt())).map((e) => e.path)).toEqual(["src/feature.ts"]);
      const patches = join(s.dataDir, "tasks", readdirSync(join(s.dataDir, "tasks"))[0] as string, String(s.task), "patches");
      expect(existsSync(patches)).toBe(false);
      expect(s.loop.resume(s.db, s.task, { version: s.t().version })).toMatchObject({
        status: 409,
        error: "Pick a choice for each command first.",
      });
      // The route: zod refuses an empty pattern and an unknown choice.
      const SESSION = "s".repeat(64);
      const ORIGIN = "http://127.0.0.1:7317";
      const app = createApp({ port: 7317, token: SESSION, live: s.live, settings: s.settings, review: s.jobs });
      const post = async (decisions: unknown) => {
        const res = await app.request(`${ORIGIN}/api/tasks/${s.task}/allow`, {
          method: "POST",
          headers: { host: "127.0.0.1:7317", origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
          body: JSON.stringify({ version: s.t().version, step: first, decisions }),
        });
        return { status: res.status, body: (await res.json()) as { error?: string } };
      };
      expect((await post([{ pattern: " ", choice: "once" }])).status).toBe(400);
      expect((await post([{ pattern: "make build", choice: "always" }])).status).toBe(400);
      expect(await post([{ pattern: "git push *", choice: "repo" }])).toEqual({
        status: 400,
        body: { error: "Claude did not ask to allow git push *." },
      });
      expect(allowOf(s, { step: first + 100, decisions: [{ pattern: "make build", choice: "once" }] })).toMatchObject({
        status: 409,
        error: "No command waits for your choice.",
      });
      expect(allowOf(s, { decisions: [{ pattern: "git push *", choice: "once" }] })).toEqual({
        status: 400,
        error: "Claude did not ask to allow git push *.",
      });
      expect(allowOf(s, { decisions: [{ pattern: "make build", choice: "once" }] }).status).toBe(202);
      await s.loop.idle(s.task);

      // Attempt 2 gets the "Allow once" pattern and asks for another one, which the user refuses.
      const second = allowRow(s);
      expect(second).toBeGreaterThan(first);
      const call2 = implementCalls(s)[1] as Call;
      expect(call2.argv[call2.argv.indexOf("--tools") + 1]).toContain("Bash");
      // part-session.md section 2.2: attempt 2 forks the transcript of attempt 1, which knows the kept work. Its rules digest holds
      // the new pattern.
      expect(call2.argv).toContain("--resume");
      expect(call2.stdin).toContain("You can run only these commands: `make build`.");
      expect(call2.context["continue.md"]).toBeUndefined();
      expect(allowOf(s, { decisions: [{ pattern: "make deploy", choice: "refuse" }] }).status).toBe(202);
      await s.loop.idle(s.task);

      // Attempt 3: the once pattern is gone, step.md names the refused pattern, and a request for it goes only to the notes.
      const third = allowRow(s);
      const call3 = implementCalls(s)[2] as Call;
      expect(call3.argv.join(" ")).not.toContain("Bash");
      expect(call3.context["step.md"]).toContain("The user refused make deploy. Do the step without it, or set question.");
      expect(taskDto(s.db, s.t()).allowAsk?.requests).toEqual([ask("make lint")]);
      expect(detailOf(s, third).notes).toContain("Claude asked again to allow make deploy. You refused it for this task.");
      expect(allowOf(s, { decisions: [{ pattern: "make lint", choice: "repo" }] })).toEqual({
        status: 400,
        error: "Accept the warning for commands that Claude runs first.",
      });
      expect(allowOf(s, { decisions: [{ pattern: "make lint", choice: "repo" }], shellWarning: true }).status).toBe(202);
      await s.loop.idle(s.task);

      // Attempt 4 and the later steps get the pattern of the repository. The build goes on to the own review.
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      const call4 = implementCalls(s)[3] as Call;
      expect(call4.stdin).toContain("You can run only these commands: `make lint`.");
      expect(call4.context["step.md"]).toContain("The user refused make deploy.");
      const fix = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      expect(fix.stdin).toContain("`make lint`");
      const shell = taskDto(s.db, s.t()).shell;
      expect([shell.warned, shell.allow.map((e) => [e.pattern, e.source, e.reason])]).toEqual([
        true,
        [["make lint", "request", "The step runs make lint."]],
      ]);
      expect(detailOf(s, first).allowAsk?.decisions).toEqual([{ pattern: "make build", choice: "once" }]);
      expect(detailOf(s, second).allowAsk?.decisions).toEqual([{ pattern: "make deploy", choice: "refuse" }]);
      expect(
        s
          .steps()
          .filter((x) => x.kind === "implement")
          .map((x) => x.attempt),
      ).toEqual([1, 2, 3, 4]);
      expect(allowOf(s, { step: third, decisions: [{ pattern: "make lint", choice: "once" }] }).status).toBe(409);
    },
    SLOW,
  );

  test(
    "D3: over 5 refused commands end the run; each allowlist refusal becomes a request with its exact command, and a deny refusal never does",
    async () => {
      const refused = (by: "allowlist" | "deny", commands: string[]) => commands.map((command) => ({ command, refused: by }));
      const s = await setup({
        seq: {
          "implement:build": [
            {
              bash: [
                ...refused("allowlist", ["make a", "make b"]),
                ...refused("deny", ["git status", "curl https://example.invalid"]),
                ...refused("allowlist", ["make c", "make d"]),
              ],
            },
            { writes: [TEST_FILE, TODO], ticks: TICK },
          ],
        },
      });
      const entry = { id: "a1", pattern: "echo *", reason: "Print.", source: "user", addedAt: 1 };
      s.db.query("UPDATE repo_task_settings SET allow_json = $allow, shell_warned_at = 1").run({ allow: JSON.stringify([entry]) });
      await s.build();
      const row = allowRow(s);
      expect(s.blocked()?.kind).toBe("allow");
      expect(s.t().state).toBe("implementing");
      const step = s.steps().find((x) => x.id === row) as Step;
      expect([step.kind, step.state]).toEqual(["implement", "failed"]);
      expect(taskDto(s.db, s.t()).allowAsk?.requests).toEqual(
        ["make a", "make b", "make c"].map((p) => ({ pattern: p, command: p, reason: "Claude Code refused this command in the step." })),
      );
      expect(detailOf(s, row).notes).toContain("Claude asked for more than 3 commands. The app left out make d.");
      const decisions = ["make a", "make b", "make c"].map((pattern) => ({ pattern, choice: "refuse" as const }));
      expect(allowOf(s, { decisions }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
      // AC-B216: the run failed, and the next run starts a new session with the earlier work.
      expect((implementCalls(s)[1] as Call).context["step.md"]).toContain(
        "This run starts a new session. ./context/continue.md lists the earlier work on this part.",
      );
    },
    SLOW,
  );

  test(
    'AC-B104.10: "Claude may run the approved checks" gives the steps Bash and the check rules with no saved pattern; a check that is not plain words gets a note',
    async () => {
      const s = await setup();
      const slash = (p: string) => p.replaceAll("\\", "/");
      const argv = [slash(process.execPath), slash(join(s.root, "check.ts"))];
      const text = argv.join(" ");
      const commands = [
        { id: "t", name: "test", kind: "test", argv, timeoutSec: 60 },
        { id: "l", name: "lint", kind: "lint", argv: [...argv, "two words"], timeoutSec: 60 },
      ];
      s.db
        .query("UPDATE repo_task_settings SET commands_json = $commands, run_checks = 1, shell_warned_at = 1")
        .run({ commands: JSON.stringify(commands) });
      expect(taskDto(s.db, s.t()).shell).toMatchObject({ mode: "allowlist", allow: [], checks: 1 });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      const fix = s.runCalls().find((c) => s.modeOf(c) === "fix") as Call;
      expect(fix.argv[fix.argv.indexOf("--tools") + 1]).toContain("Bash");
      expect(fix.stdin).toContain(`You can run only these commands: \`${text} *\`.`);
      expect(fix.stdin).toContain(`You can also run them yourself: \`${text}\`.`);
      expect(fix.stdin).toContain("Run the failing check first to see the failure.");
      const row = s.steps().find((x) => x.kind === "fix") as Step;
      const detail = JSON.parse(row.detail_json) as { shell: { rules: string[]; checks: string[] }; notes: string[] };
      expect([detail.shell.rules, detail.shell.checks]).toEqual([[], [text]]);
      expect(detail.notes).toContain(
        'The step cannot run the check "lint". An argument holds a character that is not a letter, a digit, or one of _ . / : = @ % + , -.',
      );
      // Control: the switch off gives the steps no Bash again.
      s.db.query("UPDATE repo_task_settings SET run_checks = 0").run();
      expect(taskDto(s.db, s.t()).shell.checks).toBe(0);
    },
    SLOW,
  );

  test(
    "D3: after 10 allow blocks in a part, the next request is the error that Claude asked for too many commands",
    async () => {
      const s = await setup({ seq: { "implement:build": [asking("make build"), asking("make other")] } });
      await s.build();
      const row = allowRow(s);
      const old = JSON.stringify({ allowAsk: { requests: [ask("make old")], decisions: [] } });
      for (let k = 0; k < 9; k++)
        s.db
          .query(
            `INSERT INTO task_step (task, part, kind, state, attempt, item, ord, detail_json, started_at, ended_at)
            VALUES ($task, $part, 'implement', 'ok', 1, 'old', $ord, $detail, 1, 1)`,
          )
          .run({ task: s.task, part: s.part().id, ord: 100 + k, detail: old });
      expect(allowOf(s, { step: row, decisions: [{ pattern: "make build", choice: "once" }] }).status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.blocked()).toMatchObject({ kind: "error", text: "Needs you: Claude asked for too many commands." });
    },
    SLOW,
  );
});
