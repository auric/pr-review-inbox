// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The CI gate probe (scripts/gate/ci.ts) against the fake Bitbucket and the fake Jenkins. No test reaches a real server.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, dryRun, forms, leaks, runChecks } from "../../scripts/gate/ci";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/gate/ci.ts");
const TMP = mkdtempSync(join(tmpdir(), "rl-gate-ci-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
// Every synthetic name of the dry run. None may show in the output, in any URL form.
const NAMES = ["PROJ", "sample-repo", "feature/ABC-1-fix", "team", "sample-ci", "jdoe", "127.0.0.1", "lint.example.invalid"];
const TOKENS = ["fake-token-0123456789abcdef", "fake-jenkins-token-0123456789", "fake-crumb-0123456789abcdef", "node0fakesession"];

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GATE_")) base[k] = v;
  const r = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: ROOT,
    env: { ...base, GATE_BITBUCKET_TOKEN: "test-token", ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// A name counts when no letter or digit touches it, so "PROJ" does not match inside "project".
function expectNoNames(text: string) {
  for (const n of [...NAMES, ...TOKENS])
    for (const f of forms(n)) {
      const re = new RegExp(`(?<![A-Za-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
      expect({ form: f, found: re.test(text) }).toEqual({ form: f, found: false });
    }
}

describe("gate:ci dry run", () => {
  test("all checks pass against the fakes, CI10 and CI11 included, and no fake name shows", () => {
    const r = run(SCRIPT, ["--dry-run"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    for (const id of ["CI1", "CI2", "CI3", "CI5", "CI6", "CI7", "CI8", "CI10", "CI11"]) expect(r.out).toContain(`PASS    ${id} `);
    expect(r.out).toContain("INFO    CI9 ");
    const line = (id: string) => r.out.split("\n").find((l) => l.includes(` ${id} `)) ?? "";
    expect(line("CI1")).toContain("state=OPEN head present=true branch present=true");
    expect(line("CI2")).toContain("successful=1 inProgress=0 failed=1 cancelled=0 unknown=0");
    expect(line("CI3")).toContain("count=2");
    expect(line("CI3")).toContain(
      "k1: state=FAILED same origin as --jenkins=true shape=<ctx>/job/<s>/job/<s>/job/<s>/<n>/display/redirect last job=branch display/redirect=true",
    );
    expect(line("CI3")).toContain("k2: state=SUCCESSFUL same origin as --jenkins=false");
    expect(line("CI5")).toContain("authenticated=true anonymous=false name equals --jenkins-user=true version=2.479.3");
    expect(line("CI6")).toContain("field=Jenkins-Crumb crumb present=true Set-Cookie present=true");
    expect(line("CI7")).toContain(
      "path from CI3, 2 segments): HTTP 200 (ok) _class=org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject",
    );
    expect(line("CI7")).toContain("jobs=2 PR jobs=0 names with %2F=1 branch job exists=true PR job exists=false target=branch job");
    expect(line("CI9")).toContain("without crumb HTTP 403");
    expect(line("CI9")).toContain("verdict=crumb needed and works");
    expect(line("CI10")).toContain("build POST: HTTP 201 (created) Location shape=<ctx>/queue/item/<n>/ same origin=true");
    expect(line("CI10")).toContain("hudson.model.Queue$WaitingItem,hudson.model.Queue$LeftItem");
    expect(line("CI10")).toContain("outcome=started, number present");
    expect(line("CI11")).toContain("scan POST: HTTP 302 (redirect)");
    expect(line("CI11")).toContain("PR job before=false after=true");
    expect(line("CI11")).toContain("auto-built without a POST=true");
    expect(r.out).toContain("dry run: PASS");
    expectNoNames(r.out);
    expectNoNames(readFileSync(join(ROOT, ".gate0/ci/result.dry-run.json"), "utf8"));
  });

  test("without the authorize flags, the only POST is the CI9 api/json check, and nothing starts", async () => {
    const d = await dryRun({ build: false, scan: false });
    try {
      const { results } = await runChecks(d.ctx);
      expect(results.find((r) => r.check === "CI10")?.status).toBe("SKIPPED");
      expect(results.find((r) => r.check === "CI11")?.status).toBe("SKIPPED");
      const posts = d.jenkins.requests.filter((q) => q.startsWith("POST "));
      expect(posts).toEqual([
        "POST /jenkins/job/team/job/sample-ci/api/json?tree=_class",
        "POST /jenkins/job/team/job/sample-ci/api/json?tree=_class",
      ]);
      expect(d.jenkins.builds).toEqual([]);
      expect(d.jenkins.scans).toBe(0);
    } finally {
      d.stop();
    }
  });

  test("a leaking line after the masking makes the self-check exit 3 and print nothing", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const anchor = "const problems = leaks(";
    expect(src).toContain(anchor);
    // The mutant runs from a temp folder, so its relative imports point back into the checkout.
    const mutant = src
      .replace(anchor, `lines.push(\`leak \${ctx.bitbucket.repo}\`);\n  ${anchor}`)
      .replaceAll('"../../', `"${ROOT.replaceAll("\\", "/")}/`)
      .replace("import.meta.dir", JSON.stringify(join(ROOT, "scripts/gate")));
    const file = join(TMP, "ci.mutant.ts");
    writeFileSync(file, mutant);
    const r = run(file, ["--dry-run"]);
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
    expect(r.err).toContain("self-check failed: the output holds a value of kind: repo.");
    expectNoNames(r.err);
  });
});

describe("masking", () => {
  const needles = forms("feature/ABC-1-fix").map((value) => ({ kind: "branch", value }));
  test("every URL form of a branch is found and masked", () => {
    for (const t of ["job/feature%252FABC-1-fix/3", "job/feature%2Fabc-1-fix", "feature%2FABC-1-fix", "ref feature/ABC-1-fix"]) {
      expect(leaks([t], needles)).toEqual(["branch"]);
      expect(leaks([clean(t, needles)], needles)).toEqual([]);
    }
  });
  test("a short name does not match inside a check ID or a word", () => {
    const ci = [{ kind: "job segment", value: "ci" }];
    expect(leaks(["PASS    CI10 decision"], ci)).toEqual([]);
    expect(leaks(["/job/ci/job/x"], ci)).toEqual(["job segment"]);
  });
});

describe("gate:ci arguments", () => {
  test("no PR URL exits 2", () => {
    const r = run(SCRIPT, []);
    expect(r.code).toBe(2);
    expect(r.err).toContain("A PR URL is required.");
  });
  test("--authorize-build without --jenkins exits 2", () => {
    const r = run(SCRIPT, ["https://example.invalid/projects/PROJ/repos/sample-repo/pull-requests/7", "--authorize-build"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("need --jenkins");
  });
  test("--jenkins without GATE_JENKINS_TOKEN exits 2, and http is refused off loopback", () => {
    const url = "https://example.invalid/projects/PROJ/repos/sample-repo/pull-requests/7";
    const noToken = run(SCRIPT, [url, "--jenkins", "https://ci.example.invalid", "--jenkins-user", "jdoe"]);
    expect(noToken.code).toBe(2);
    expect(noToken.err).toContain("GATE_JENKINS_TOKEN");
    const http = run(SCRIPT, [url, "--jenkins", "http://ci.example.invalid", "--jenkins-user", "jdoe"], { GATE_JENKINS_TOKEN: "x" });
    expect(http.code).toBe(2);
    expect(http.err).toContain("--jenkins needs https");
  });
  test("a bad --job path exits 2", () => {
    const r = run(
      SCRIPT,
      [
        "https://example.invalid/projects/PROJ/repos/sample-repo/pull-requests/7",
        "--jenkins",
        "https://ci.example.invalid",
        "--jenkins-user",
        "jdoe",
        "--job",
        "team/../x",
      ],
      { GATE_JENKINS_TOKEN: "x" },
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("--job needs");
  });
});
