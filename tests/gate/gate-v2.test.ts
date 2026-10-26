// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Argument parsing and dry-run output of the review v2 gate scripts (docs/gate-v2.md). No test starts claude or reaches a server.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const CLAUDE_CHECKS = join(ROOT, "scripts/gate/claude-checks.ts");
const BITBUCKET_WRITE = join(ROOT, "scripts/gate/bitbucket-write.ts");
// An empty PATH folder: the claude-checks dry run then finds no claude and runs no CLI at all.
const NO_TOOLS = mkdtempSync(join(tmpdir(), "rl-gate-test-path-"));
const GIT_DIR = dirname(Bun.which("git") ?? "git");
const REPO = "https://example.invalid/projects/TEST/repos/test-repo";

afterAll(() => rmSync(NO_TOOLS, { recursive: true, force: true }));

function run(script: string, args: string[], path: string) {
  const env: Record<string, string> = {};
  // MSYSTEM without git's usr\bin on PATH crashes Git for Windows on a local fetch.
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["PATH", "MSYSTEM"].includes(k.toUpperCase())) env[k] = v;
  // A set token keeps the OS secret store out of every test.
  Object.assign(env, { PATH: path, GATE_BITBUCKET_TOKEN: "test-token" });
  const r = Bun.spawnSync([process.execPath, script, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("claude-checks.ts B17 to B20", () => {
  test("a dry run takes bare check IDs and prints the planned argv within the caps", () => {
    const r = run(CLAUDE_CHECKS, ["--dry-run", "B17", "B18", "B19", "B20"], NO_TOOLS);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    for (const [id, calls] of [
      ["B17", 1],
      ["B18", 1],
      ["B19", 1],
      ["B20", 5],
    ] as const)
      expect(r.out).toContain(`DRY-RUN  ${id.padEnd(4)} calls=${calls}`);
    expect(r.out).toContain("B17 1/1, B18 1/1, B19 1/1, B20 5/5");
    const b17 = r.out.split("\n").find((l) => l.startsWith("dry-run b17-write-confinement:")) ?? "";
    expect(b17).toContain('"--tools","Read,Grep,Glob,Edit,Write","--allowedTools","Read,Grep,Glob,Edit,Write"');
    expect(b17).toContain('"--restricted","--strict-mcp-config"');
    expect(b17).not.toContain("--permission-mode");
    expect(r.out).toMatch(/dry-run b18-verify-effort: .*"--effort","medium"/);
    for (const tag of ["explain", "discuss", "interview", "spec", "implement"]) expect(r.out).toContain(`dry-run b20-${tag}:`);
    expect(r.out).not.toContain(process.env.USERPROFILE ?? process.env.HOME ?? "<no home>");
  });

  test("--only takes lower-case IDs and runs only those", () => {
    const r = run(CLAUDE_CHECKS, ["--only=b19", "--dry-run"], NO_TOOLS);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DRY-RUN  B19");
    expect(r.out).not.toContain("DRY-RUN  B17");
  });

  test("an unknown check exits 2 with the usage", () => {
    const r = run(CLAUDE_CHECKS, ["--dry-run", "B21"], NO_TOOLS);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown check: B21");
    expect(r.err).toContain("usage:");
  });
});

describe("bitbucket-write.ts G1 to G7, G9, G12, and G13 to G18", () => {
  test("a dry run passes all checks against the loopback fake and prints no host", () => {
    const r = run(BITBUCKET_WRITE, ["--dry-run"], GIT_DIR);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    for (const id of ["G1", "G2", "G3", "G4", "G5", "G6"]) expect(r.out).toContain(`PASS    ${id} `);
    expect(r.out).toContain("INFO    G7 ");
    for (const id of ["G9", "G12", "G13", "G14", "G15", "G16", "G17", "G18"]) expect(r.out).toContain(`PASS    ${id} `);
    expect(r.out).toContain("(stale info)");
    const g3 = r.out.split("\n").find((l) => l.startsWith("PASS    G3 ")) ?? "";
    expect(g3).toContain("of the new gate commit: HTTP 200 keys=failed,inProgress,successful counts=0/0/0");
    expect(g3).toContain("POST build status: HTTP 204 keys=none");
    expect(g3).toContain("stats after the POST: HTTP 200 keys=failed,inProgress,successful counts=1/0/0");
    expect(g3).toContain("INFO --build-commit: HTTP 200");
    expect(r.out).toContain("dry run: PASS");
    expect(r.out).not.toContain("127.0.0.1");
    expect(r.out).not.toContain(tmpdir());
  }, 120_000);

  test("a dry run of one check sets up only what it needs", () => {
    const r = run(BITBUCKET_WRITE, ["--dry-run", "--only", "G6"], GIT_DIR);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS    G6 ");
    expect(r.out).not.toContain("G1 ");
  }, 120_000);

  test("a dry run of the read checks G9 and G12 passes and prints only key names and counts", () => {
    const r = run(BITBUCKET_WRITE, ["--dry-run", "--only", "g9,g12"], GIT_DIR);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const g9 = r.out.split("\n").find((l) => l.startsWith("PASS    G9 ")) ?? "";
    expect(g9).toContain("open PRs (limit 50): HTTP 200 count=2 isLastPage=true page schema=ok");
    expect(g9).toContain("PR keys=author,fromRef,id,links,participants,properties,reviewers,state,title,toRef,updatedDate,version");
    expect(g9).toContain("X-AUSERNAME=present");
    const g12 = r.out.split("\n").find((l) => l.startsWith("PASS    G12 ")) ?? "";
    expect(g12).toContain("open PRs read=2 without the user=1");
    expect(g12).toContain(
      "changes of a PR without the user: HTTP 200 count=2 isLastPage=true page schema=ok change keys=path,srcPath,type types=MODIFY,MOVE",
    );
    expect(g12).toContain("changes of an own PR: HTTP 200 count=1 isLastPage=true page schema=ok change keys=path,type types=MODIFY");
    expect(r.out).not.toContain("G1 ");
    for (const secret of ["dry-user", "dry-other", "Dry peer", "README.md", "docs/", "127.0.0.1", tmpdir()])
      expect(r.out).not.toContain(secret);
    expect(r.out).toContain("dry run: PASS");
  }, 120_000);

  test("a dry run of the read checks G13 to G17 passes and prints no branch, repository, or project name", () => {
    const r = run(BITBUCKET_WRITE, ["--dry-run", "G13", "G14", "--only", "g15,g16,g17"], GIT_DIR);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const line = (id: string) => r.out.split("\n").find((l) => l.startsWith(`PASS    ${id} `)) ?? "";
    expect(line("G13")).toContain("default-branch: HTTP 200");
    expect(line("G13")).toContain("id is refs/heads/=true displayId=true type=BRANCH");
    expect(line("G13")).toContain("same id=true");
    expect(line("G14")).toContain("exact match first=true");
    expect(line("G14")).toContain("filter without a match: HTTP 200 count=0");
    expect(line("G15")).toContain("REPO_WRITE: HTTP 200 count=1 isLastPage=true test repository listed=true");
    expect(line("G15")).toContain("REPO_ADMIN: HTTP 200 count=0 isLastPage=true test repository listed=false");
    expect(line("G15")).toContain("restrictions: HTTP 401 com.atlassian.bitbucket.AuthorisationException");
    expect(line("G16")).toContain("pages=1 count=2 last isLastPage=true");
    expect(line("G16")).toContain("clone link names=http");
    expect(line("G17")).toContain("mergeCommit id=true");
    expect(line("G17")).toContain("MERGED activity=true commit keys=displayId,id commit id=true; same commit=true");
    expect(r.out).not.toContain("G1 ");
    for (const secret of ["Dry Repo", "dry-lib", "dry-repo", "feature/", "refs/heads/main", "DRY", "127.0.0.1", tmpdir()])
      expect(r.out).not.toContain(secret);
    expect(r.out).toContain("dry run: PASS");
  }, 120_000);

  test("a dry run of the read check G18 passes and prints only key names, outcomes, and counts", () => {
    const r = run(BITBUCKET_WRITE, ["--dry-run", "--only", "G18"], GIT_DIR);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const g18 = r.out.split("\n").find((l) => l.startsWith("PASS    G18 ")) ?? "";
    expect(g18).toContain("mergeResult keys=current,outcome with outcome and current=2 of 2");
    expect(g18).toContain("outcomes=CLEAN/current=true,CONFLICTED/current=true; CONFLICTED with current true=true");
    for (const secret of ["dry-user", "dry-other", "Dry peer", "127.0.0.1", tmpdir()]) expect(r.out).not.toContain(secret);
    expect(r.out).toContain("dry run: PASS");
  }, 120_000);

  test.each([
    [[], "--repo is required"],
    [["--repo", REPO, "--only", "G13,G1"], "Refused: G1 to G7 create branches"],
    [["--only", "G13,G14"], "--repo is required"],
    [["--repo", REPO, "--target", "main"], "Refused: G1 to G7 create branches"],
    [["--repo", REPO, "--only", "G9,G1"], "Refused: G1 to G7 create branches"],
    [["--only", "G9,G12"], "--repo is required"],
    [["--repo", "https://example.invalid/browse", "G12"], "--repo is not a repository URL"],
    [["--repo", "ssh://user@example.invalid/projects/A/repos/b", "G9"], "--repo needs an http or https URL"],
    [["--repo", REPO, "--target", "main", "--authorize-writes", "G2"], "G2 needs --reviewer"],
    [["--repo", REPO, "--target", "main", "--authorize-writes", "G7", "--jira-key", "lower-1"], "G7 needs --jira-key"],
    [["--repo", REPO, "--authorize-writes", "G1"], "--target is required"],
    [["--repo", REPO, "--target", "rl-gate-x", "--authorize-writes"], "--target is not a usable branch name"],
    [["--repo", "https://example.invalid/browse", "--target", "main", "--authorize-writes"], "--repo is not a repository URL"],
    [["--repo", REPO, "--target", "main", "--authorize-writes", "G3", "--build-commit", "xyz"], "--build-commit needs a commit ID"],
    [["--dry-run", "G8"], "unknown check: G8"],
    [["--dry-run", "--bogus"], "unknown argument: --bogus"],
  ])("refuses %j before any request", (args, message) => {
    const r = run(BITBUCKET_WRITE, args, GIT_DIR);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
    expect(r.out).toBe("");
  });
});
