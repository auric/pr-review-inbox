// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate JC-A data (docs/plans/review-v2/jira-context.md WP-JC-E): eval:refetch-tasks against the fake Jira, and the overlay flags of
// run.ts. No test reads a live Jira.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase } from "../../scripts/eval/cases";
import { countsText, cutComments, refetch } from "../../scripts/eval/refetch-tasks";
import { evalProfile, parseOptions } from "../../scripts/eval/run";
import { createJiraSource } from "../../src/server/context/jira";
import { git, gitEnv } from "../../src/server/review/git";
import type { IssueContext } from "../../src/shared/dto";
import { type FakeJira, JIRA_TOKEN, startFakeJira } from "../support/fake-jira";

console.log(`Code under test: ${Bun.resolveSync("../../scripts/eval/refetch-tasks", import.meta.dir)}`);

const TMP = mkdtempSync(join(tmpdir(), "rl-eval-refetch-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

// A bundle with one commit at the given committer date.
async function bundleAt(name: string, date: string) {
  const empty = join(TMP, "empty.gitconfig");
  writeFileSync(empty, "");
  const env = {
    ...gitEnv(empty),
    GIT_AUTHOR_NAME: "Eval Author",
    GIT_AUTHOR_EMAIL: "eval@example.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Eval Author",
    GIT_COMMITTER_EMAIL: "eval@example.invalid",
    GIT_COMMITTER_DATE: date,
  };
  const src = join(TMP, name);
  mkdirSync(src);
  await git(["init", "-q", "--template=", src], { env });
  writeFileSync(join(src, "a.txt"), "a\n");
  await git(["-C", src, "add", "."], { env });
  await git(["-C", src, "commit", "-q", "-m", "head"], { env });
  const head = (await git(["-C", src, "rev-parse", "HEAD"], { env })).trim();
  const bundle = join(TMP, `${name}.bundle`);
  await git(["-C", src, "bundle", "create", "-q", bundle, "HEAD", "--all"], { env });
  return { bundle, base: head, head, hash: name };
}

const caseOf = (id: string, local: EvalCase["local"], keys: string[], json: string | null = null) =>
  ({ id, local, tasks: keys.map((key) => ({ key, source: "branch", json })) }) as unknown as EvalCase;

describe("eval:refetch-tasks", () => {
  let jira: FakeJira | undefined;
  afterEach(() => jira?.stop());

  test("cutComments drops a comment after the head and a comment without a date", () => {
    const i = {
      key: "ABC-1",
      summary: "s",
      status: null,
      description: null,
      comments: [
        { author: "a", created: "2026-01-05T09:00:00.000+0000", body: "before" },
        { author: "a", created: "2026-01-07T09:00:00.000+0200", body: "after" },
        { author: "a", created: "", body: "no date" },
      ],
      commentsTotal: 4,
      truncated: false,
    } satisfies IssueContext;
    const r = cutComments(i, Date.parse("2026-01-06T00:00:00Z"));
    expect(r.dropped).toBe(2);
    expect(r.issue.comments.map((c) => c.body)).toEqual(["before"]);
    expect(r.issue.commentsTotal).toBe(2);
  });

  test("reads the first 3 keys of each case once, with the parent, cuts the comments at each head, and counts", async () => {
    jira = startFakeJira();
    jira.addFullIssue("ABC-17");
    jira.addIssue("ABC-18");
    // The fixture comments are from 2026-01-05, 2026-01-06, and 2026-01-07.
    const early = await bundleAt("early", "2026-01-06T15:00:00Z");
    const late = await bundleAt("late", "2026-02-01T00:00:00Z");
    const source = createJiraSource({ baseUrl: jira.url, token: JIRA_TOKEN });
    const { overlay, counts } = await refetch(
      [
        caseOf("c1", early, ["ABC-17", "ABC-404", "ABC-18", "ABC-19"]),
        caseOf("c2", late, ["ABC-17"], JSON.stringify({ key: "ABC-17" })),
        caseOf("c3", undefined, ["ABC-17"]),
        caseOf("c4", late, []),
      ],
      source,
      TMP,
    );
    expect(jira.count("GET", "/rest/api/2/issue/ABC-17")).toBe(1);
    expect(jira.count("GET", "/rest/api/2/issue/ABC-19")).toBe(0);
    expect(counts).toEqual({ cases: 4, taskCases: 2, read: 2, failed: { not_found: 1 }, droppedComments: 2, added: 2 });
    expect(overlay.cases.map((c) => [c.id, c.head, Object.keys(c.tasks)])).toEqual([
      ["c1", early.head, ["ABC-17", "ABC-18"]],
      ["c2", late.head, ["ABC-17"]],
    ]);
    const c1 = JSON.parse(overlay.cases[0]?.tasks["ABC-17"] as string) as IssueContext;
    const c2 = JSON.parse(overlay.cases[1]?.tasks["ABC-17"] as string) as IssueContext;
    expect([c1.comments.length, c2.comments.length]).toEqual([2, 3]);
    expect(c1.parentIssue).toMatchObject({ key: "ABC-30", summary: "Rework the cache layer" });
    expect(c1.related?.map((l) => l.key)).toEqual(["ABC-31", "ABC-32"]);
    expect(countsText(counts)).toBe(
      "Cases: 4. Cases with task keys: 2.\nKeys read: 2. Keys failed: not_found 1.\nComments dropped after the head commit: 2.\nCases where the overlay adds text: 2 of 2.",
    );
  });
});

describe("run.ts --jira-family and --tasks-overlay", () => {
  test("--jira-family turns on the profile option; the default keeps the shipped value", () => {
    const on = parseOptions(["--jira-family"]);
    const off = parseOptions([]);
    if ("error" in on || "error" in off) throw new Error("parse");
    const [a, b] = [evalProfile(on), evalProfile(off)];
    if ("error" in a || "error" in b) throw new Error("profile");
    expect([a.profile.jiraFamily, b.profile.jiraFamily]).toEqual([true, false]);
  });

  test("--tasks-overlay keeps an absolute path and refuses --replay-find", () => {
    const o = parseOptions(["--tasks-overlay", "x.json"]);
    expect("error" in o ? null : o.tasksOverlay).toBe(join(process.cwd(), "x.json"));
    expect(parseOptions(["--tasks-overlay", "x.json", "--replay-find", "r.json"])).toEqual({
      error: "--tasks-overlay changes the finder input, so --replay-find cannot replay it.",
    });
  });
});
