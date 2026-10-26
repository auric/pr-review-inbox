// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.16.7 (WP-MR1, AC-B42): the pre-flight outcomes against the fake Bitbucket and temp bare
// remotes: write permission, a first-level submodule without write, the base branch, the branch rules with HTTP 401 and with an exact
// BRANCH rule, and the branch check.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/server/storage/db";
import { baseGoneText, existsText, noWriteText, type PreflightDeps, preflight, ruleText } from "../../src/server/tasks/preflight";
import { staleText } from "../../src/server/tasks/push";
import { repoDtos, resolveTaskRepos, taskRepos } from "../../src/server/tasks/repos";
import { REPO_REASON } from "../../src/shared/task";
import { type FakeBitbucket, repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { bareRepo, depsOf, mainCache, multiRepo } from "./repos-fixture";

console.log(`preflight.test.ts imported from ${Bun.resolveSync("../../src/server/tasks/preflight", import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
setDefaultTimeout(120_000);
const dirs: string[] = [];
const fakes: FakeBitbucket[] = [];
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const f of fakes.splice(0)) f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const BRANCH = "feature/K-1-change-it";
const rule = (type: string, matcherType: string, id: string) => ({
  id: 1,
  type,
  matcher: { id, displayId: id, type: { id: matcherType, name: matcherType }, active: true },
});

async function setup(o: { writable?: boolean; restrictions?: unknown[]; target?: string; repo?: string } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-mr1-pf-")));
  dirs.push(root);
  const fake = startFakeBitbucket();
  fakes.push(fake);
  const repo = o.repo ?? "solo";
  const remoteRepo = await bareRepo(root, repo, { "README.md": "x\n" });
  // The task branch exists on the remote at the base commit.
  await remoteRepo.g(["update-ref", `refs/heads/${BRANCH}`, remoteRepo.base]);
  const db = openDb(join(root, "db.sqlite"));
  dbs.push(db);
  const id = (
    db
      .query(`INSERT INTO task (project, repo, key, title, state, target_branch, spec_dir, created_at, updated_at)
        VALUES ('PROJ', $repo, 'K-1', 'Change it', 'implementing', $target, 'specs/K-1/', 1, 1) RETURNING id`)
      .get({ repo, target: o.target ?? "main" }) as { id: number }
  ).id;
  const t = () => db.query("SELECT * FROM task WHERE id = $id").get({ id }) as Parameters<typeof taskRepos>[1];
  const calls: string[] = [];
  return {
    root,
    fake,
    db,
    id,
    t,
    remoteRepo,
    calls,
    repo,
    writes: () => repoWrites(fake, "PROJ", repo, { writable: o.writable, restrictions: o.restrictions }),
  };
}

const depsFor = (s: Awaited<ReturnType<typeof setup>>, provider = true): PreflightDeps => ({
  dataDir: join(s.root, "data"),
  provider: async () => {
    if (!provider) return null;
    const { createBitbucketProvider } = await import("../../src/server/bitbucket/provider");
    const { FAKE_TOKEN } = await import("../support/fake-bitbucket");
    return createBitbucketProvider({ baseUrl: s.fake.url, token: FAKE_TOKEN });
  },
  remote: async () => ({ url: s.remoteRepo.remote, config: [] }),
});

describe("pre-flight (spec.md section 6.16.7)", () => {
  test("a writable repository with its base, and a 401 on the rule search, passes: the rule check skips", async () => {
    const s = await setup();
    s.writes();
    expect(await preflight(s.db, depsFor(s), s.t(), BRANCH)).toBeNull();
    expect(s.fake.requests.some((r) => r.includes("/restrictions"))).toBe(true);
    expect(s.fake.requests.some((r) => r.includes("permission=REPO_WRITE") && r.includes("projectkey=PROJ"))).toBe(true);
  });

  test("the main repository without REPO_WRITE blocks with the sentence", async () => {
    const s = await setup({ writable: false });
    s.writes();
    expect(await preflight(s.db, depsFor(s), s.t(), BRANCH)).toEqual({ kind: "preflight", step: null, text: noWriteText("PROJ/solo") });
  });

  test("a base branch that is gone blocks with Pick another base branch", async () => {
    const s = await setup({ target: "develop" });
    s.writes();
    expect((await preflight(s.db, depsFor(s), s.t(), BRANCH))?.text).toBe(baseGoneText("develop", "PROJ/solo"));
  });

  test("an exact BRANCH rule blocks; PATTERN rules and other branches are left to Bitbucket", async () => {
    const s = await setup({ restrictions: [rule("read-only", "BRANCH", `refs/heads/${BRANCH}`)] });
    s.writes();
    expect((await preflight(s.db, depsFor(s), s.t(), BRANCH))?.text).toBe(ruleText("PROJ/solo", BRANCH));
    const t = await setup({
      restrictions: [
        rule("read-only", "PATTERN", "feature/*"),
        rule("no-deletes", "BRANCH", `refs/heads/${BRANCH}`),
        rule("read-only", "BRANCH", "refs/heads/main"),
      ],
    });
    t.writes();
    expect(await preflight(t.db, depsFor(t), t.t(), BRANCH)).toBeNull();
  });

  test("the branch check: a branch without a lease blocks; a lease that the remote moved past is stale; the right lease passes", async () => {
    const s = await setup();
    s.writes();
    const main = taskRepos(s.db, s.t())[0]?.id as number;
    expect((await preflight(s.db, depsFor(s), s.t(), BRANCH, new Map([[main, null]])))?.text).toBe(existsText(BRANCH));
    expect((await preflight(s.db, depsFor(s), s.t(), BRANCH, new Map([[main, "f".repeat(40)]])))?.text).toBe(staleText(BRANCH));
    expect(await preflight(s.db, depsFor(s), s.t(), BRANCH, new Map([[main, s.remoteRepo.base]]))).toBeNull();
  });

  test("without a Bitbucket token, steps 1 and 3 skip and the git checks still run", async () => {
    const s = await setup({ target: "gone" });
    expect((await preflight(s.db, depsFor(s, false), s.t(), BRANCH))?.text).toBe(baseGoneText("gone", "PROJ/solo"));
    expect(s.fake.requests).toEqual([]);
  });
});

test("a first-level submodule without REPO_WRITE gets access read with its reason, and the pre-flight goes on", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-mr1-pf-")));
  dirs.push(root);
  const fake = startFakeBitbucket();
  fakes.push(fake);
  const m = await multiRepo(root, fake);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(root, "db.sqlite"));
  dbs.push(db);
  const id = (
    db
      .query(`INSERT INTO task (project, repo, key, title, state, target_branch, spec_dir, created_at, updated_at)
        VALUES ('PROJ', 'app', 'K-2', 'Both', 'implementing', 'main', 'specs/K-2/', 1, 1) RETURNING id`)
      .get() as { id: number }
  ).id;
  const t = () => db.query("SELECT * FROM task WHERE id = $id").get({ id }) as Parameters<typeof taskRepos>[1];
  await mainCache(dataDir, m);
  await resolveTaskRepos(db, depsOf(m, dataDir), t(), m.app.base);
  expect(repoDtos(db, t()).find((r) => r.path === "lib")?.access).toBe("edit");
  // The write permission changes after the plan. The cache of 10 minutes holds per origin, so a new fake origin reads it again.
  const fake2 = startFakeBitbucket();
  fakes.push(fake2);
  repoWrites(fake2, "PROJ", "app");
  repoWrites(fake2, "PROJ", "lib", { writable: false });
  const { createBitbucketProvider } = await import("../../src/server/bitbucket/provider");
  const { FAKE_TOKEN } = await import("../support/fake-bitbucket");
  const deps: PreflightDeps = {
    dataDir,
    provider: async () => createBitbucketProvider({ baseUrl: fake2.url, token: FAKE_TOKEN }),
    remote: m.remote,
  };
  expect(await preflight(db, deps, t(), BRANCH)).toBeNull();
  expect(repoDtos(db, t()).find((r) => r.path === "lib")).toMatchObject({ access: "read", reason: REPO_REASON.noWrite });
});
