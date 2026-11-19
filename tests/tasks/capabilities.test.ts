// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/task-builder-v2.md section 4 (TB-1, AC-TB1 to AC-TB3, AC-TB25): the capability manifest of the build runs.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERVIEW_RULES, interviewAgent, OWNER_RULE, PROOF_RULES, SHIPPED_PROFILES, specAgent } from "../../src/server/review/catalog";
import { openDb } from "../../src/server/storage/db";
import {
  type BuildHost,
  buildToolLines,
  capabilities,
  capabilityLines,
  manifest,
  NO_COMMANDS_LINE,
  TRY_FIRST_RULE,
  UNRESTRICTED_LINE,
} from "../../src/server/tasks/capabilities";
import { implementPrompt } from "../../src/server/tasks/implement";
import { type StepShell, shellSettings } from "../../src/server/tasks/shell";
import type { ShellMode } from "../../src/shared/task";

for (const m of ["tasks/capabilities", "tasks/shell", "tasks/implement", "review/catalog"])
  console.log(`capabilities.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

const dir = mkdtempSync(join(tmpdir(), "rl-caps-"));
const db: Database = openDb(join(dir, "caps.sqlite"));
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ORIGINS = ["https://code.example.test/bb", "https://tracker.example.test"];
const HOSTS = ["code.example.test", "tracker.example.test"];
const GIT_RULES = ["Bash(git *)", "Bash(*/git *)", "Bash(git.exe *)", "Bash(*/git.exe *)", "Bash(*\\git.exe *)"];
const HOST: BuildHost = { name: "mac1", alias: "build-mac", platform: "macOS", dir: "/tmp/work" };
const shell = (mode: ShellMode, rules: string[], checks: string[] = []): StepShell => ({ mode, rules, checks, bashTimeoutSec: 600 });
const capsOf = (s: StepShell | null, hosts: BuildHost[] = []) =>
  manifest(s, { repo: "PROJ/repo", mode: s?.mode ?? "allowlist", origins: ORIGINS, buildHosts: hosts });

// The Bash deny rules of shell.json: a program rule is `Bash(<name> *)` or `Bash(<name>*)`; a host rule is `Bash(*<host>*)`.
function denyOf(s: StepShell) {
  const deny = shellSettings({ ...s, dataDir: dir, origins: ORIGINS }).permissions.deny;
  const programs = deny.flatMap((r) => /^Bash\(([^*\s/\\]+) ?\*\)$/.exec(r)?.[1] ?? []);
  const hosts = deny.flatMap((r) => /^Bash\(\*([^*\s/\\]+)\*\)$/.exec(r)?.[1] ?? []);
  return { deny, programs, hosts };
}

const CASES: [string, StepShell][] = [
  ["allowlist with one pattern", shell("allowlist", ["echo *"])],
  ["allowlist with a check only", shell("allowlist", [], ["bun test"])],
  ["allowlist that names curl and xargs", shell("allowlist", ["curl https://x.test/*", "xargs *"])],
  ["allowlist that names ssh", shell("allowlist", ["ssh build-mac *"])],
  ["Most commands", shell("any", [])],
  ["Most commands with an ssh pattern", shell("any", ["ssh build-mac *"])],
  ["Most commands with a curl pattern", shell("any", ["curl https://x.test/*"])],
  ["Unrestricted", shell("unrestricted", [])],
];

describe("AC-TB1: the manifest names exactly what shell.json denies", () => {
  for (const [name, s] of CASES)
    test(name, () => {
      const m = capsOf(s);
      const d = denyOf(s);
      for (const r of GIT_RULES) expect(d.deny).toContain(r);
      expect(m.denied).toEqual(d.programs.filter((p) => p !== "git" && p !== "git.exe"));
      expect(m.hosts).toEqual(d.hosts);
      expect(m.hosts).toEqual(HOSTS);
      const text = capabilityLines(m).join("\n");
      for (const p of m.denied) expect(text).toContain(p);
      expect(text).toContain(`Every mode refuses git and each command that names the Bitbucket or Jira host (${HOSTS.join(", ")}).`);
      expect(text).toContain("You have no CI token and no Jira or Bitbucket access.");
    });

  test("the lift cases: an ssh pattern lifts ssh in Most commands, a curl pattern lifts curl only in allowlist", () => {
    expect(capsOf(shell("any", ["ssh build-mac *"])).denied).not.toContain("ssh");
    expect(capsOf(shell("any", ["curl https://x.test/*"])).denied).toContain("curl");
    expect(capsOf(shell("allowlist", ["curl https://x.test/*"])).denied).not.toContain("curl");
    expect(capsOf(shell("allowlist", ["echo *"])).denied).toContain("xargs");
    expect(capsOf(shell("any", [])).denied).not.toContain("xargs");
    expect(capsOf(shell("unrestricted", [])).denied).toEqual([]);
  });
});

describe("AC-TB2: an allowlist with no pattern gives the no-commands line", () => {
  test("from the database: the spec manifest and the plan screen lines", () => {
    db.run("DELETE FROM repo_task_settings");
    db.run(
      "INSERT INTO repo_task_settings (project, repo, commands_json, line_budget, warned_at, updated_at) VALUES ('PROJ', 'repo', '[]', 400, 1, 1)",
    );
    const m = capabilities(db, { project: "PROJ", repo: "repo" }, "spec", ORIGINS);
    expect(m.commands).toBe(false);
    const l = capabilityLines(m);
    expect(l[0]).toBe(NO_COMMANDS_LINE);
    expect(l).not.toContain(TRY_FIRST_RULE);
    expect(l.join("\n")).not.toContain("Commands:");
    // The implement prompt of such a step says the same, and no Bash line.
    const p = implementPrompt("implement", "specs/K-1/", false, false, "", "", { skills: [], mcp: [] }, m);
    expect(p).toContain(NO_COMMANDS_LINE);
    expect(p).not.toContain("cd repo");
  });

  test("from the database: Unrestricted names the main repository and the hosts", () => {
    db.run("UPDATE repo_task_settings SET shell_mode = 'unrestricted'");
    const l = capabilityLines(capabilities(db, { project: "PROJ", repo: "repo" }, "interview", ORIGINS));
    expect(l[0]).toBe("Commands: Unrestricted (main repository PROJ/repo). It applies to every repository of the task.");
    expect(l[1]).toBe(UNRESTRICTED_LINE);
    expect(l).toContain(TRY_FIRST_RULE);
  });

  test("an allowlist pattern or an approved check gives the Bash tool", () => {
    db.run(
      `UPDATE repo_task_settings SET shell_mode = 'allowlist', allow_json = '[{"id":"a1","pattern":"make *","reason":"r","source":"user","addedAt":1}]'`,
    );
    const l = capabilityLines(capabilities(db, { project: "PROJ", repo: "repo" }, "fix", ORIGINS));
    expect(l[0]).toBe("Commands: Allowlist (main repository PROJ/repo). It applies to every repository of the task.");
    expect(l[1]).toStartWith("You can run only these commands: `make *`.");
  });
});

describe("AC-TB25: a build host shows only when ssh runs", () => {
  test("each mode and lift case", () => {
    const hosts = (s: StepShell | null) => capsOf(s, [HOST]).buildHosts;
    expect(hosts(null)).toEqual([]);
    expect(hosts(shell("allowlist", ["echo *"]))).toEqual([]);
    expect(hosts(shell("any", []))).toEqual([]);
    expect(hosts(shell("any", ["curl https://x.test/*"]))).toEqual([]);
    expect(hosts(shell("allowlist", ["ssh build-mac *"]))).toEqual([HOST]);
    expect(hosts(shell("any", ["ssh build-mac *"]))).toEqual([HOST]);
    expect(hosts(shell("unrestricted", []))).toEqual([HOST]);
    expect(capabilityLines(capsOf(shell("unrestricted", []), [HOST]))).toContain(
      "Build host mac1: ssh alias build-mac, macOS, work folder /tmp/work.",
    );
    expect(capabilityLines(capsOf(shell("any", []), [HOST])).join("\n")).not.toContain("Build host");
  });
});

describe("AC-TB3: the spec and interview prompts hold the build manifest and the owner and proof rules", () => {
  const p = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];
  const tools = buildToolLines(capsOf(shell("unrestricted", [])));

  test("the Unrestricted lines name ssh, scp, and curl and the try-first rule", () => {
    expect(UNRESTRICTED_LINE).toContain("ssh, scp, and curl work.");
    expect(capabilityLines(capsOf(shell("unrestricted", [])))).toEqual(expect.arrayContaining([UNRESTRICTED_LINE, TRY_FIRST_RULE]));
    expect(TRY_FIRST_RULE).toContain("Try a command before you say that you cannot run it.");
  });

  test("the spec and interview agents", () => {
    const spec = specAgent(p, 400, "linux", false, tools).prompt;
    const interview = interviewAgent(p, 1, false, tools).prompt;
    for (const prompt of [spec, interview]) {
      expect(prompt).toContain(`The build runs of this task have these tools:\n- Commands: Unrestricted (main repository PROJ/repo).`);
      expect(prompt).toContain(`- ${UNRESTRICTED_LINE}`);
      expect(prompt).toContain(`- ${TRY_FIRST_RULE}`);
      expect(prompt).toContain('- Then "Point <repo> at the merged commit" moves the submodule pointer.');
      for (const r of PROOF_RULES) expect(prompt).toContain(r);
    }
    expect(spec).toContain(OWNER_RULE);
    expect(interview).toContain("A step that needs the app or the user is a step for the user.");
    expect(spec).not.toContain("Give each part acceptance criteria that a test can prove");
    // Without a manifest, the agents keep their old start.
    expect(interviewAgent(p, 1).prompt.startsWith(INTERVIEW_RULES[0] ?? "")).toBe(true);
    expect(specAgent(p, 400, "linux").prompt).not.toContain("have these tools");
  });

  test("the implement prompt of each shell step holds the manifest; a resolve step has none", () => {
    const caps = capsOf(shell("unrestricted", []));
    for (const mode of ["implement", "fix", "instruct"] as const) {
      const text = implementPrompt(mode, "specs/K-1/", false, false, "x", "", { skills: [], mcp: [] }, caps);
      for (const l of capabilityLines(caps)) expect(text).toContain(l);
      expect(text).toContain("You may run `cd repo` before a command that must run in the repository.");
      expect(text).toContain("Change files only with the Edit and Write tools.");
      expect(text).toContain("use `tar`");
      expect(text).toContain("Give each remote command a time limit.");
    }
    const resolve = implementPrompt("resolve", "specs/K-1/", false, false, "", "", { skills: [], mcp: [] }, null);
    expect(resolve).not.toContain(NO_COMMANDS_LINE);
    expect(resolve).toContain("You cannot run commands, and you post nothing.");
  });

  test("ASD-STE100: each manifest sentence has at most 20 words, except the pattern list of an allowlist", () => {
    const long = CASES.flatMap(([, s]) => capabilityLines(capsOf(s, [HOST])))
      .filter((l) => !l.startsWith("You can run only these commands:"))
      .flatMap((l) => l.split(/(?<=[.?!])\s+/))
      .filter((x) => x.split(/\s+/).filter(Boolean).length > 20);
    expect(long).toEqual([]);
  });
});
