// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.7, Line endings, Repair (AC-B171): a part with line-ending-only changes from before the line
// end rule gets one forward commit. Temp bare remotes only. The repair pushes nothing.
import { afterEach, expect, test } from "bun:test";
import { type Worktree, wtGit } from "../../src/server/tasks/worktree";
import { IDENTITY } from "./fixture";
import { builtTask, cleanup, headOf, KEY, SLOW, write } from "./update-fixture";

for (const m of ["tasks/loop", "tasks/worktree"])
  console.log(`eol.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanup);

type S = Awaited<ReturnType<typeof builtTask>>;

// A commit from before the line end rule: git commits the files as written. README.md changes only its line ends, and src/app.ts gets
// one real line. The base holds both with LF.
async function oldCommit(s: S) {
  const w = await s.wt();
  await write(w, { "README.md": "README.md\r\n", "src/app.ts": "src/app.ts\r\nexport const more = 1;\r\n" });
  await wtGit(w, ["add", "-u"]);
  await wtGit(w, ["commit", "-q", "-m", `${KEY}: old`], { extra: IDENTITY });
  const head = await headOf(w);
  s.db.query("UPDATE task_part SET head = $head WHERE id = $id").run({ head, id: s.part().id });
  return { w, head };
}

const numstat = async (w: Worktree, base: string, head: string, ...flags: string[]) =>
  (await wtGit(w, ["diff", "--numstat", ...flags, base, head])).trim().split("\n");
const repairs = (s: S) => s.flow().filter((x) => x.startsWith("commit:eol:")).length;

test(
  "a part with an earlier line-ending-only change gets one repair commit, and its diff against the base has only real lines",
  async () => {
    const s = await builtTask();
    const { w, head } = await oldCommit(s);
    expect(await numstat(w, s.base, head)).not.toEqual(await numstat(w, s.base, head, "--ignore-cr-at-eol"));
    await s.loop.matchBase(s.db, s.task, s.part().id);
    const fixed = s.part().head;
    expect(fixed).not.toBe(head);
    expect(await headOf(w)).toBe(fixed);
    expect((await wtGit(w, ["log", "-1", "--format=%s|%P", fixed])).trim()).toBe(`${KEY}: Match the line endings of the base|${head}`);
    const real = await numstat(w, s.base, fixed);
    expect(real).toEqual(await numstat(w, s.base, fixed, "--ignore-cr-at-eol"));
    expect(real).toContain("1\t0\tsrc/app.ts");
    expect(real.some((l) => l.endsWith("\tREADME.md"))).toBe(false);
    expect(repairs(s)).toBe(1);
    // A second check at the new head finds equal counts and commits nothing.
    await s.loop.matchBase(s.db, s.task, s.part().id);
    expect(s.part().head).toBe(fixed);
    expect(repairs(s)).toBe(1);
  },
  SLOW,
);

test(
  "a part whose counts match gets no repair commit",
  async () => {
    const s = await builtTask();
    const head = s.part().head;
    await s.loop.matchBase(s.db, s.task, s.part().id);
    expect(s.part().head).toBe(head);
    expect(repairs(s)).toBe(0);
  },
  SLOW,
);

test(
  "an adopted part keeps its commits",
  async () => {
    const s = await builtTask();
    const { w, head } = await oldCommit(s);
    s.db.query("UPDATE task_part SET adopted = 1 WHERE id = $id").run({ id: s.part().id });
    await s.loop.matchBase(s.db, s.task, s.part().id);
    expect(s.part().head).toBe(head);
    expect(await headOf(w)).toBe(head);
    expect(repairs(s)).toBe(0);
  },
  SLOW,
);
