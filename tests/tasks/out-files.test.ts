// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/task-builder-v2.md section 7.6 (TB-4, AC-TB11): the files that a run leaves in ./out. The app copies the regular files to
// <task dir>/files/claude/<run>/ at the run end, skips links, keeps the caps, and serves each kept file as a download. The fake CLI
// writes the files. No test starts the real CLI or reaches a forge.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { collectOut, OUT, OUT_LINE, outDir, outsideRepo, patchStep } from "../../src/server/tasks/implement";
import { taskDto } from "../../src/server/tasks/tasks";
import type { Worktree } from "../../src/server/tasks/worktree";
import { OUT_FILE_BYTES, OUT_FILES_MAX, type OutDetail } from "../../src/shared/task";
import { type Call, cleanupAll, SLOW, type Step, setup, TEST_FILE, TODO, WORKS } from "./loop-fixture";
import { builtTask, cleanup } from "./update-fixture";

for (const m of ["server/tasks/implement", "server/tasks/routes", "server/tasks/tasks"])
  console.log(`out-files.test.ts imported from ${Bun.resolveSync(`../../src/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);
afterEach(cleanup);
const root = mkdtempSync(join(tmpdir(), "rl-out-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;
const fresh = () => {
  const d = join(root, `case-${n++}`);
  const from = join(d, "part", OUT);
  const task = join(d, "task");
  mkdirSync(from, { recursive: true });
  mkdirSync(task, { recursive: true });
  return { d, from, task, put: (p: string, data: string | Buffer = p) => writeFileSync(join(from, p), data) };
};
const detailOf = (s: { steps: () => Step[] }, id: number) => JSON.parse((s.steps().find((x) => x.id === id) as Step).detail_json);

const PORT = 7317;
const ORIGIN = `http://127.0.0.1:${PORT}`;

describe("AC-TB11: a file in ./out survives the next run and shows in the Task view", () => {
  test(
    "the build run keeps out/report.md and out/sub/data.json; the fix run finds ./out empty and keeps its own file",
    async () => {
      const s = await setup({
        seq: {
          "implement:build": [
            {
              writes: [TEST_FILE, TODO, { path: "out/report.md", text: "# Report\n" }, { path: "out/sub/data.json", text: "{}\n" }],
              ticks: { path: "*", ids: ["*"] },
            },
          ],
          "implement:fix": [{ writes: [WORKS, { path: "out/fix.txt", text: "fixed\n" }] }],
        },
      });
      await s.build();
      expect(s.part().state).toBe("self_reviewed");
      for (const c of s.runCalls().filter((x: Call) => /^- Mode: (build|fix)$/m.test(x.stdin))) expect(c.stdin).toContain(OUT_LINE);
      const build = s.steps().find((x) => x.kind === "implement") as Step;
      const fix = s.steps().find((x) => x.kind === "fix") as Step;
      // The path check skips ./out, so the run keeps its changes.
      expect(detailOf(s, build.id)).toMatchObject({ checked: true, deniedPaths: [] });
      expect(detailOf(s, build.id).out).toEqual({
        dir: String(build.run),
        files: [
          { path: "report.md", size: 9 },
          { path: "sub/data.json", size: 3 },
        ],
        skipped: [],
        more: 0,
      });
      expect(detailOf(s, fix.id).out).toMatchObject({ dir: String(fix.run), files: [{ path: "fix.txt", size: 6 }] });
      // The copy of the build run survives the next run. The part folder holds only the file of the last run.
      const kept = outDir(s.dataDir, s.db, s.task, String(build.run));
      expect(readFileSync(join(kept, "report.md"), "utf8")).toBe("# Report\n");
      expect(readFileSync(join(kept, "sub", "data.json"), "utf8")).toBe("{}\n");
      expect(readdirSync(join((await s.wt()).dir, OUT))).toEqual(["fix.txt"]);
      // The Task view gets the list through the step detail.
      const dto = taskDto(s.db, s.t());
      expect(dto.steps.find((x) => x.id === build.id)?.detail.out?.files.map((f) => f.path)).toEqual(["report.md", "sub/data.json"]);

      // The download route: the attachment headers of BRIEF 3.6, and only a stored entry inside the copy folder.
      const app = createApp({ port: PORT, token: "s".repeat(64), live: s.live, settings: s.settings, review: s.jobs });
      const get = (path: string) => app.request(`${ORIGIN}/api${path}`, { headers: { host: `127.0.0.1:${PORT}` } });
      const ok = await get(`/tasks/${s.task}/steps/${build.id}/out/1`);
      expect(ok.status).toBe(200);
      const headers = ["content-type", "content-disposition", "content-security-policy", "x-content-type-options", "cache-control"];
      expect(Object.fromEntries(headers.map((h) => [h, ok.headers.get(h)]))).toEqual({
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="data.json"; filename*=UTF-8''data.json`,
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      expect(await ok.text()).toBe("{}\n");
      // An index past the list, another task, and a bad index.
      expect((await get(`/tasks/${s.task}/steps/${build.id}/out/2`)).status).toBe(404);
      expect((await get(`/tasks/${s.task + 1}/steps/${build.id}/out/0`)).status).toBe(404);
      expect((await get(`/tasks/${s.task}/steps/${build.id}/out/x`)).status).toBe(400);
      expect((await get(`/tasks/${s.task}/steps/${build.id}/out/-1`)).status).toBe(400);
      // A stored path or folder name that leaves the copy folder is refused, also when the file exists.
      writeFileSync(join(kept, "..", "secret.txt"), "secret\n");
      const planted = (out: OutDetail) => {
        patchStep(s.db, build.id, { out });
        return get(`/tasks/${s.task}/steps/${build.id}/out/0`);
      };
      const res = [
        await planted({ dir: String(build.run), files: [{ path: "../secret.txt", size: 7 }], skipped: [], more: 0 }),
        await planted({ dir: "..", files: [{ path: "claude/secret.txt", size: 7 }], skipped: [], more: 0 }),
        await planted({ dir: "", files: [{ path: "secret.txt", size: 7 }], skipped: [], more: 0 }),
        await planted({ dir: String(build.run), files: [{ path: join(kept, "report.md"), size: 9 }], skipped: [], more: 0 }),
      ];
      expect(res.map((r) => r.status)).toEqual([404, 404, 404, 404]);
      // A junction inside the copy folder leads nowhere.
      symlinkSync(join(kept, ".."), join(kept, "jump"), "junction");
      expect((await planted({ dir: String(build.run), files: [{ path: "jump/secret.txt", size: 7 }], skipped: [], more: 0 })).status).toBe(
        404,
      );
    },
    SLOW,
  );
});

describe("a Tell run keeps its ./out file on the send row", () => {
  test(
    "the instruct send row lists out/notes.txt after its checks, commit, and own review",
    async () => {
      const more = { path: "repo/src/feature.ts", text: "export const feature = 'works';\nexport const useNewParser = true;\n" };
      const s = await builtTask({ seq: { "implement:instruct": [{ writes: [more, { path: "out/notes.txt", text: "notes\n" }] }] } });
      const r = s.loop.instruct(s.db, s.task, { version: s.t().version, text: "Add the flag useNewParser." });
      expect(r.status).toBe(202);
      await s.loop.idle(s.task);
      expect(s.flow()).toEqual(["instruct:I1:ok", "check:I1:ok", "commit:I1:ok", "review:review:ok"]);
      const send = s.steps()[0];
      expect(send?.detail.instruct).toMatchObject({ result: "done", committed: true });
      expect(send?.detail.out).toMatchObject({ files: [{ path: "notes.txt", size: 6 }] });
    },
    SLOW,
  );
});

describe("collectOut: lstat on each level, no link, and the caps", () => {
  test("a junction in ./out is skipped, and nothing behind it is copied", () => {
    const c = fresh();
    const victim = join(c.d, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "private.txt"), "private\n");
    c.put("note.txt", "note\n");
    symlinkSync(victim, join(c.from, "link"), "junction");
    const r = collectOut(c.from, c.task, "7");
    expect(r).toEqual({ dir: "7", files: [{ path: "note.txt", size: 5 }], skipped: [{ path: "link", reason: "a link" }], more: 0 });
    expect(readdirSync(join(c.task, "files", "claude", "7"))).toEqual(["note.txt"]);
  });

  test("./out as a junction copies nothing", () => {
    const c = fresh();
    rmSync(c.from, { recursive: true });
    const victim = join(c.d, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "private.txt"), "private\n");
    symlinkSync(victim, c.from, "junction");
    expect(collectOut(c.from, c.task, "1")).toEqual({
      dir: "1",
      files: [],
      skipped: [{ path: ".", reason: "a link or not a folder" }],
      more: 0,
    });
    expect(existsSync(join(c.task, "files"))).toBe(false);
  });

  test("a junction on a target folder fails the copy, and the run goes on", () => {
    const c = fresh();
    const victim = join(c.d, "victim");
    mkdirSync(victim);
    symlinkSync(victim, join(c.task, "files"), "junction");
    c.put("a.txt");
    const r = collectOut(c.from, c.task, "2");
    expect(r?.files).toEqual([]);
    expect(r?.skipped).toEqual([{ path: "a.txt", reason: "the copy failed: A folder of the copy is a link." }]);
    expect(readdirSync(victim)).toEqual([]);
  });

  test(`the first ${OUT_FILES_MAX} files by path; a file over 10 MB is skipped and takes no place`, () => {
    const c = fresh();
    mkdirSync(join(c.from, "b"));
    for (let i = 0; i < OUT_FILES_MAX + 1; i++) c.put(`f${String(i).padStart(2, "0")}.txt`);
    c.put("b/inner.txt");
    c.put("a-big.bin", Buffer.alloc(OUT_FILE_BYTES + 1));
    c.put("a-max.bin", Buffer.alloc(OUT_FILE_BYTES));
    const r = collectOut(c.from, c.task, "3") as OutDetail;
    expect(r.files.map((f) => f.path)).toEqual([
      "a-max.bin",
      "b/inner.txt",
      ...Array.from({ length: OUT_FILES_MAX - 2 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`),
    ]);
    expect(r.skipped).toEqual([
      { path: "a-big.bin", reason: "over 10 MB" },
      { path: "f18.txt", reason: `over ${OUT_FILES_MAX} files` },
      { path: "f19.txt", reason: `over ${OUT_FILES_MAX} files` },
      { path: "f20.txt", reason: `over ${OUT_FILES_MAX} files` },
    ]);
    expect(readFileSync(join(c.task, "files", "claude", "3", "b", "inner.txt"), "utf8")).toBe("b/inner.txt");
  });

  test("an empty or absent ./out gives null", () => {
    const c = fresh();
    expect(collectOut(c.from, c.task, "4")).toBeNull();
    expect(collectOut(join(c.d, "none"), c.task, "4")).toBeNull();
  });

  test("the path check skips a real ./out folder, and a junction named out still fails", () => {
    const c = fresh();
    const wt = { dir: join(c.d, "part") } as Worktree;
    c.put("x.txt");
    expect(outsideRepo(wt, new Map())).toEqual([]);
    rmSync(c.from, { recursive: true });
    mkdirSync(join(c.d, "elsewhere"));
    symlinkSync(join(c.d, "elsewhere"), c.from, "junction");
    expect(outsideRepo(wt, new Map())).toEqual([OUT]);
  });
});
