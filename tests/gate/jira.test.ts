// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Jira gate probe (scripts/gate/jira.ts) against the fake Jira in Server and Cloud mode. No test reaches a real server.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forms } from "../../scripts/gate/ci";
import { dryRun, FULL_QUERY, runChecks, urlShape } from "../../scripts/gate/jira";
import { JIRA_EMAIL, JIRA_TOKEN } from "../support/fake-jira";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/gate/jira.ts");
const TMP = mkdtempSync(join(tmpdir(), "rl-gate-jira-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
// Every synthetic name of the dry run. None may show in the output, in any URL form.
const NAMES = [
  "ABC",
  "ABC-17",
  "ABC-18",
  "ABC-19",
  "ABC-20",
  "Split the cache work into sub-tasks",
  "Batch the cache writes",
  "Flush before the write lock",
  "Alex Smith",
  "asmith",
  "sync-worker.log",
  "screenshot.png",
  "In Progress",
  "To Do",
  "Sub-task",
  "127.0.0.1",
  // The *all read of ABC-17 (addFullIssue): field names, field values, the epic, the linked issues, and the vendor type key.
  "ABC-30",
  "ABC-31",
  "ABC-32",
  "Rework the cache layer",
  "Remove the old flush path",
  "Lock wait dashboard",
  "Acceptance Criteria",
  "Given a full cache, the flush finishes before the write lock.",
  "Review Owner Note",
  "Test Plan",
  "Risk Class",
  "Elevated risk",
  "Done Checklist",
  "Write the flush test",
  "com.example.checklist:checklist-field",
  "backend-cache",
  "q4-perf",
  "Sync Worker",
  "The background sync worker",
  "Release 2.4",
  "asmith@example.com",
  "Epic",
  "Story",
  JIRA_EMAIL,
  JIRA_TOKEN,
];

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GATE_")) base[k] = v;
  const r = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: ROOT,
    env: { ...base, GATE_JIRA_TOKEN: "test-token", ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function expectNoNames(text: string) {
  for (const n of NAMES)
    for (const f of forms(n)) {
      const re = new RegExp(`(?<![A-Za-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
      expect({ form: f, found: re.test(text) }).toEqual({ form: f, found: false });
    }
}

describe("gate:jira dry run", () => {
  test("J1 to J7 pass in Server and Cloud mode, and no fake name shows", () => {
    const r = run(SCRIPT, ["--dry-run"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    for (const mode of ["server", "cloud"])
      for (const id of ["J1", "J2", "J3", "J4", "J5", "J6", "J7"]) expect(r.out).toContain(`PASS    ${id} [${mode}] `);
    const line = (id: string, mode: string) => r.out.split("\n").find((l) => l.includes(` ${id} [${mode}] `)) ?? "";
    expect(r.out).toContain("[server] serverInfo HTTP 200 deploymentType=Server auth=Bearer");
    expect(r.out).toContain("[cloud] serverInfo HTTP 200 deploymentType=Cloud auth=Basic");
    expect(line("J1", "server")).toContain("with key and statusCategory.key=3 of 3 category keys=done,indeterminate,new");
    expect(line("J1", "server")).toContain("parent.key is the issue=3 of 3");
    expect(line("J2", "server")).toContain("type names=Blocks inward=is blocked by outward=blocks");
    expect(line("J2", "server")).toContain("to a sibling subtask=1");
    expect(line("J3", "server")).toContain("comment file link shapes=a /secure/attachment/<n>/<s>");
    expect(line("J3", "cloud")).toContain("comment file link shapes=a /rest/api/2/attachment/content/<n>");
    expect(line("J3", "server")).toContain("img /secure/thumbnail/<n>/<s>");
    expect(line("J4", "cloud")).toContain("POST with JSON and X-Atlassian-Token no-check: HTTP 204");
    expect(line("J4", "cloud")).toContain(
      "category before=new after=indeterminate transition target=indeterminate reached the target=true",
    );
    expect(r.out).toContain("dry run: PASS");
    // Field names such as "Summary" and "Labels" must not mask the key names.
    expect(r.out).not.toContain("<masked>");
    expect(r.out).toContain("Recorded in .gate0/jira/result.dry-run.json.");
    expectNoNames(r.out);
    expectNoNames(readFileSync(join(ROOT, ".gate0/jira/result.dry-run.json"), "utf8"));
  });

  test.each([false, true])("without --authorize-transition no POST goes out (cloud=%p)", async (cloud) => {
    const d = await dryRun({ cloud, authorize: false });
    try {
      const { results, posts } = await runChecks(d.ctx);
      expect(results.map((r) => r.status)).toEqual(["PASS", "PASS", "PASS", "SKIPPED", "PASS", "PASS", "PASS"]);
      expect(posts).toBe(0);
      expect(d.jira.requests.filter((q) => q.startsWith("POST "))).toEqual([]);
      expect(d.jira.transitions.size).toBe(0);
    } finally {
      d.stop();
    }
  });

  test("a planted name in the output makes the self-check exit 3 and print nothing", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const anchor = "const problems = leaks(";
    expect(src).toContain(anchor);
    // The mutant runs from a temp folder, so its relative imports point back into the checkout.
    const mutant = src
      .replace(anchor, `lines.push("leak ABC-17");\n  ${anchor}`)
      .replaceAll('"../../', `"${ROOT.replaceAll("\\", "/")}/`)
      .replaceAll('"./ci"', `"${join(ROOT, "scripts/gate/ci").replaceAll("\\", "/")}"`)
      .replace("import.meta.dir", JSON.stringify(join(ROOT, "scripts/gate")));
    const file = join(TMP, "jira.mutant.ts");
    writeFileSync(file, mutant);
    const r = run(file, ["--dry-run"]);
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
    expect(r.err).toContain("self-check failed: the output holds a value of kind:");
    expect(r.err).toContain("issue key");
    expectNoNames(r.err);
  });
});

describe("gate:jira J5 to J7", () => {
  const ids = ["J5", "J6", "J7"] as const;
  test.each([false, true])(
    "the *all read gives names, schema, criteria, links, and times, and no field value (cloud=%p)",
    async (cloud) => {
      const d = await dryRun({ cloud, authorize: false });
      d.ctx.only = [...ids];
      try {
        const { results, posts } = await runChecks(d.ctx);
        expect(results.map((r) => [r.check, r.status])).toEqual(ids.map((id) => [id, "PASS"]));
        expect(posts).toBe(0);
        const [j5, j6, j7] = results.map((r) => r.evidence);
        expect(d.jira.requests).toContain(`GET /rest/api/2/issue/ABC-17?${FULL_QUERY}`);
        expect(j5).toContain("names is an object=true count=17 schema is an object=true count=17");
        expect(j5).toContain("textarea with a value=1 with a name=1 with a rendered string=1 textfield with a value=0");
        expect(j5).toContain(
          "other custom with a value=2 Jira types=com.atlassian.jira.plugin.system.customfieldtypes:select app vendor types=1",
        );
        expect(j5).toContain("epicLink fields=1 value shapes=key string parent=absent");
        expect(j5).toContain("labels array count=2 strings=2; components array count=1 entry keys=description,id,name,self");
        expect(j5).toContain("fixVersions array count=1 entry keys=archived,id,name,releaseDate,released,self");
        expect(j6).toContain("type names=Blocks,Relates");
        expect(j6).toContain("inwardIssue count=2 keys=fields,id,key,self fields keys=issuetype,status,summary");
        expect(j6).toContain("outwardIssue count=1 keys=fields,id,key,self fields keys=issuetype,status,summary");
        expect(j6).toContain("with summary and statusCategory.key and issuetype=1 of 1");
        expect(j7).toMatch(
          /^\[(server|cloud)\] full read: HTTP 200 bytes=\d+ ms=\d+; comment page: HTTP 200 bytes=\d+ ms=\d+; parent read from epicLink: HTTP 200 bytes=\d+ ms=\d+; total ms=\d+$/,
        );
        expect(d.jira.count("GET", "/rest/api/2/issue/ABC-30")).toBe(1);
        const text = results.map((r) => r.evidence).join("\n");
        expect(text).not.toContain("<masked>");
        expectNoNames(text);
      } finally {
        d.stop();
      }
    },
  );

  test("J5 fails without names and schema, J6 without --links-issue sends nothing, and J7 without a parent gives INFO", async () => {
    const d = await dryRun({ cloud: false, authorize: false });
    d.ctx.only = [...ids];
    d.ctx.issue = "ABC-42";
    d.ctx.linksIssue = undefined;
    try {
      const { results } = await runChecks(d.ctx);
      expect(results.map((r) => r.status)).toEqual(["FAIL", "SKIPPED", "INFO"]);
      expect(results[0]?.evidence).toContain("names is an object=false");
      expect(results[0]?.evidence).toContain("names or schema is absent.");
      expect(results[1]?.evidence).toContain("No --links-issue. Nothing was sent.");
      expect(results[2]?.evidence).toContain("parent read from none: not sent");
      expect(d.jira.requests.filter((q) => q.includes("ABC-17"))).toEqual([]);
    } finally {
      d.stop();
    }
  });
});

describe("gate:jira URL shapes", () => {
  test("hosts, names, and IDs are masked, and the context path is marked", () => {
    expect(urlShape("/jira/secure/attachment/10101/a.log", "https://example.invalid/jira")).toBe("<ctx>/secure/attachment/<n>/<s>");
    expect(urlShape("https://example.atlassian.net/rest/api/3/attachment/content/7?x=1", "https://example.atlassian.net")).toBe(
      "/rest/api/3/attachment/content/<n>?<k>",
    );
    expect(urlShape("https://media.example.invalid/file/abc/image", "https://example.atlassian.net")).toBe("<other origin>/file/<s>/image");
    expect(urlShape("javascript:alert(1)", "https://example.atlassian.net")).toBe("<javascript>");
  });
});

describe("gate:jira arguments", () => {
  const URL = "https://example.atlassian.net";
  test.each([
    [[], "--url is required"],
    [["--url", URL], "J1 to J3, J5, and J7 need --issue"],
    [["--url", "http://example.atlassian.net", "--issue", "PROJ-1"], "--url needs https"],
    [["--url", URL, "--issue", "PROJ-1", "--only", "J1", "--authorize-transition"], "--authorize-transition needs J4"],
    [["--url", URL, "--only", "J4", "--authorize-transition", "--transition", "21"], "J4 needs --transition-issue"],
    [
      ["--url", URL, "--only", "J4", "--authorize-transition", "--transition-issue", "PROJ-1", "--transition", "x"],
      "J4 needs --transition <id>",
    ],
    [["--url", URL, "--issue", "PROJ-1", "--email", "not-an-email"], "--email is not an email address"],
    [["--url", URL, "--only", "J5"], "J1 to J3, J5, and J7 need --issue"],
    [["--url", URL, "--only", "J6", "--links-issue", "not a key"], "--links-issue needs <KEY-123>"],
    [["--dry-run", "--only", "J8"], "unknown check: J8"],
    [["--dry-run", "--bogus"], "unknown argument: --bogus"],
  ])("refuses %j before any request", (args, message) => {
    const r = run(SCRIPT, args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
    expect(r.out).toBe("");
  });
});
