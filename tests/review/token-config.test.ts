// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/git-deny.md fix E (spec.md section 6.8, AC-B172 to AC-B174): the token header of the app's git goes only to
// the server origin, and a git call with the token refuses a cache config with a key that the app does not write. Two fake HTTP servers
// on 127.0.0.1 stand for the server and another host. No test reaches a forge.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAuth } from "../../src/server/bitbucket/provider";
import { git, gitEnv } from "../../src/server/review/git";
import { fetchInto, gitSetup, prepareWorkspace, remoteHead } from "../../src/server/review/workspace";
import { pushTaskBranch } from "../../src/server/tasks/push";
import type { PullRequest } from "../../src/shared/types";
import { taskRemote } from "../tasks/fixture";
import { bareRepo, gitmodules } from "../tasks/repos-fixture";

for (const m of ["review/git", "review/workspace", "tasks/push", "bitbucket/provider"])
  console.log(`token-config.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

const TOKEN = "rl-fix-e-token-5b1f0c";
const BEARER = `Bearer ${TOKEN}`;
const TASK = { key: "ABC-1", prefix: "task/", branches: ["task/ABC-1-x"], target: "main" };
const SLOW = 60_000;

type Hit = { path: string; auth: string | null };
function fakeHost() {
  const hits: Hit[] = [];
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push({ path: u.pathname + u.search, auth: req.headers.get("authorization") });
      return new Response("not here", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${s.port}`, hits, stop: () => s.stop(true) };
}

let root: string;
let dataDir: string;
let cache: string;
let empty: string;
let base: string;
let remote: string;
let server: ReturnType<typeof fakeHost>;
let other: ReturnType<typeof fakeHost>;
let url: string;

beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "rl-fix-e-")));
  const r = await taskRemote(root);
  remote = r.remote;
  base = r.base;
  dataDir = join(root, "data");
  cache = await fetchInto(dataDir, "PROJ", "repo", { url: remote, config: [] }, ["+refs/heads/main:refs/rl/task/1/target"]);
  empty = gitSetup(dataDir).empty;
  server = fakeHost();
  other = fakeHost();
  url = `${server.url}/scm/proj/repo.git`;
});
afterAll(() => {
  server.stop();
  other.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

let logs: Mock<typeof console.log>;
beforeEach(() => {
  logs = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logs.mockRestore());
const logText = () => logs.mock.calls.flat().join("\n");

const cfg = (args: string[]) => git([`--git-dir=${cache}`, "config", ...args], { env: gitSetup(dataDir).env });
const plant = () => cfg([`url.${other.url}/.insteadOf`, `${server.url}/`]);
const unplant = () => cfg(["--remove-section", `url.${other.url}/`]);
const auth = () => gitAuth(server.url, TOKEN);
const push = (config: [string, string][], emptyGlobal = empty) =>
  pushTaskBranch({ cache, emptyGlobal, url, config, commit: base, branch: "task/ABC-1-x", lease: null, task: TASK });
// git with the env of the app but without the check of git(): the config check is gone, the scoped header stays. Async, because the
// fake hosts answer in this process.
const rawFetch = (config: [string, string][]) =>
  Bun.spawn(["git", `--git-dir=${cache}`, "fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, "+refs/heads/main:refs/rl/raw"], {
    env: gitEnv(empty, config),
    stdout: "ignore",
    stderr: "ignore",
    timeout: 30_000,
  }).exited;

describe("fix E: a planted url.<other>.insteadOf in the cache config", () => {
  test(
    "AC-B172: fetch and push with the token refuse, no host gets a request, and the log names the key, never its value",
    async () => {
      await plant();
      try {
        await expect(
          fetchInto(dataDir, "PROJ", "repo", { url, config: auth() }, ["+refs/heads/main:refs/rl/task/1/target"]),
        ).rejects.toThrow(
          "holds the key url.<subsection>.insteadof, which the app does not allow. Open that file in a text editor, delete the key, and try again. The app log names the full key.",
        );
        const r = await push(auth());
        expect(r.status).toBe("failed");
        expect(r.status === "failed" && r.message).toContain("holds the key url.<subsection>.insteadof");
        expect(other.hits).toEqual([]);
        expect(server.hits).toEqual([]);
        const text = logText();
        expect(text).toContain(
          `Refused git fetch with the server token: ${join(cache, "config")} holds the key url.${other.url}/.insteadof`,
        );
        expect(text).toContain("Refused git push with the server token");
        // The value of the key is the server URL. Neither it nor the token shows.
        expect(text).not.toContain(server.url);
        expect(text).not.toContain(TOKEN);
      } finally {
        await unplant();
      }
    },
    SLOW,
  );

  test(
    "AC-B173: each layer alone keeps the token from the other host; with neither, the other host gets it",
    async () => {
      await plant();
      try {
        // The scoped header alone: the rewritten URL gets the request, with no Authorization header.
        expect(await rawFetch(auth())).not.toBe(0);
        expect(other.hits.length).toBeGreaterThan(0);
        expect(other.hits.every((h) => h.auth === null)).toBe(true);
        other.hits.length = 0;
        // The config check alone: an unscoped header through the app's git is refused before git runs.
        const plain: [string, string][] = [["http.extraHeader", `Authorization: ${BEARER}`]];
        await expect(fetchInto(dataDir, "PROJ", "repo", { url, config: plain }, ["+refs/heads/main:refs/rl/x"])).rejects.toThrow(
          /insteadof/,
        );
        expect(other.hits).toEqual([]);
        // Control: an unscoped header without the check sends the token to the other host.
        expect(await rawFetch(plain)).not.toBe(0);
        expect(other.hits.some((h) => h.auth === BEARER)).toBe(true);
      } finally {
        other.hits.length = 0;
        await unplant();
      }
      // The scoped header still reaches the server itself. ls-remote has no --git-dir, so it reads no repository config.
      server.hits.length = 0;
      await expect(remoteHead(dataDir, { url, config: auth() })).rejects.toThrow();
      expect(server.hits.length).toBeGreaterThan(0);
      expect(server.hits.every((h) => h.auth === BEARER)).toBe(true);
      expect(other.hits).toEqual([]);
    },
    SLOW,
  );
});

describe("fix E: the files that a git call with the token reads", () => {
  test(
    "AC-B174: the keys of git and the app pass; a key in config.worktree, include.path, a commondir file, and a non-empty global config refuse",
    async () => {
      server.hits.length = 0;
      other.hits.length = 0;
      // The cache after a fetch holds only keys of the allowlist, so the token fetch runs.
      const ok = (config: [string, string][]) =>
        fetchInto(dataDir, "PROJ", "repo", { url: remote, config }, ["+refs/heads/main:refs/rl/task/1/target"]);
      await ok(auth());
      const worktree = join(cache, "config.worktree");
      const had = existsSync(worktree) ? readFileSync(worktree) : null;
      try {
        writeFileSync(worktree, "[core]\n\tbare = true\n\tfsmonitor = planted-monitor\n");
        await expect(ok(auth())).rejects.toThrow(`${worktree} holds the key core.fsmonitor`);
        writeFileSync(worktree, "[core]\n\tbare = true\n");
        await ok(auth());
      } finally {
        if (had) writeFileSync(worktree, had);
        else rmSync(worktree, { force: true });
      }
      await cfg(["include.path", join(root, "elsewhere.gitconfig")]);
      await expect(ok(auth())).rejects.toThrow("holds the key include.path");
      await cfg(["--unset", "include.path"]);
      // The push runs no cache setup first, so the check is the first reader of the commondir file.
      writeFileSync(join(cache, "commondir"), "../elsewhere.git\n");
      try {
        const r = await push(auth());
        expect(r.status === "failed" && r.message).toContain("commondir exists, and the app never writes it");
      } finally {
        rmSync(join(cache, "commondir"));
      }
      const global = join(root, "not-empty.gitconfig");
      writeFileSync(global, `[url "${other.url}/"]\n\tinsteadOf = ${server.url}/\n`);
      const r = await push(auth(), global);
      expect(r.status === "failed" && r.message).toContain("the empty global git config of the app is not an empty file");
      expect(other.hits).toEqual([]);
      expect(server.hits).toEqual([]);
      await ok(auth());
    },
    SLOW,
  );

  test(
    "a hook in the cache never runs in a git call of the app; control: plain git with the same config runs it",
    async () => {
      const mark = join(root, "hook-ran.txt");
      const hook = join(cache, "hooks", "reference-transaction");
      mkdirSync(join(cache, "hooks"), { recursive: true });
      writeFileSync(hook, `#!/bin/sh\nenv >> "${mark.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
      try {
        await fetchInto(dataDir, "PROJ", "repo", { url: remote, config: auth() }, ["+refs/heads/main:refs/rl/hook/1"]);
        await git([`--git-dir=${cache}`, "update-ref", "refs/rl/hook/2", base], { env: gitSetup(dataDir).env });
        expect(existsSync(mark)).toBe(false);
        // Control: the same token config with no core.hooksPath of gitEnv.
        const env = gitEnv(empty, auth());
        const n = Number(env.GIT_CONFIG_COUNT) - 2;
        env.GIT_CONFIG_COUNT = String(n);
        const ran = Bun.spawnSync(["git", `--git-dir=${cache}`, "update-ref", "refs/rl/hook/3", base], { env });
        expect(ran.exitCode).toBe(0);
        expect(readFileSync(mark, "utf8")).toContain(TOKEN);
      } finally {
        rmSync(join(cache, "hooks"), { recursive: true, force: true });
        rmSync(mark, { force: true });
      }
    },
    SLOW,
  );
});

// A build command in a worktree of the cache can run `git submodule update --init`. git then writes submodule.<name>.active, .url, and
// .update into the cache config, which every worktree shares. PROJ/app holds lib (with the nested deep) and up, which .gitmodules gives
// "update = rebase". The submodule URLs are absolute file paths, so the clones work without a server.
describe("fix E: the cache of a repository with submodules", () => {
  const fwd = (p: string) => p.replaceAll("\\", "/");
  let sub: string;
  let app: Awaited<ReturnType<typeof bareRepo>>;
  let source: string;
  const appCache = () => join(dataDir, "git", "PROJ", "app.git");
  const pull = (): PullRequest => ({
    ref: { project: "PROJ", repo: "app", id: 1 },
    version: 0,
    title: "Change app",
    state: "OPEN",
    author: { slug: "jdoe", name: "Jane Doe", login: "jdoe" },
    reviewers: [],
    sourceHead: source,
    targetHead: app.base,
    sourceBranch: "feature",
    targetBranch: "main",
    updatedDate: 0,
  });
  // The fetch path of a review: the PR ref with the scoped token header, then a worktree of the cache.
  const review = (runId: string) =>
    prepareWorkspace({
      dataDir,
      runId,
      pr: pull(),
      comments: [],
      remote: {
        url: app.remote,
        sourceUrl: app.remote,
        sourceRef: "refs/heads/feature",
        targetRef: "refs/heads/main",
        fetchConfig: auth(),
      },
    });
  const cfgApp = (args: string[]) => git([`--git-dir=${appCache()}`, "config", ...args], { env: gitSetup(dataDir).env });

  beforeAll(async () => {
    sub = join(root, "subs");
    mkdirSync(sub);
    const deep = await bareRepo(sub, "deep", { "deep.txt": "deep\n" });
    const lib = await bareRepo(
      sub,
      "lib",
      { "lib.c": "int lib;\n", ".gitmodules": gitmodules({ deep: fwd(deep.remote) }) },
      { deep: deep.base },
    );
    const modules = `${gitmodules({ lib: fwd(lib.remote), up: fwd(lib.remote) })}`.replace(
      `[submodule "up"]\n\tpath = up\n\turl = ${fwd(lib.remote)}\n`,
      `[submodule "up"]\n\tpath = up\n\turl = ${fwd(lib.remote)}\n\tupdate = rebase\n`,
    );
    const links = { lib: lib.base, up: lib.base };
    app = await bareRepo(sub, "app", { "README.md": "app\n", ".gitmodules": modules }, links);
    source = await app.commit({ "README.md": "app 2\n", ".gitmodules": modules }, links, app.base);
    await app.g(["update-ref", "refs/heads/feature", source]);
    await app.g(["update-ref", "refs/pull-requests/1/from", source]);
  });

  test(
    "AC-B174: after git submodule update --init in a worktree of the cache, the review fetch with the token runs",
    async () => {
      server.hits.length = 0;
      other.hits.length = 0;
      const ws = await review("sub-1");
      expect(ws.cache).toBe(appCache());
      // Plain git, as a build script runs it. File URLs need protocol.file.allow since git 2.38.1.
      const user = gitEnv(empty, [["protocol.file.allow", "always"]]);
      await git(["-C", ws.repo, "submodule", "update", "--init", "--recursive"], { env: user });
      expect(existsSync(join(ws.repo, "lib", "deep", "deep.txt"))).toBe(true);
      const keys = (await git(["config", "--file", join(appCache(), "config"), "--name-only", "--list"], { env: user }))
        .split("\n")
        .filter((k) => k.startsWith("submodule."))
        .sort();
      expect(keys).toEqual(["submodule.lib.active", "submodule.lib.url", "submodule.up.active", "submodule.up.update", "submodule.up.url"]);
      await ws.remove();
      const again = await review("sub-2");
      expect(again.sourceHead).toBe(source);
      await again.remove();
      expect(logText()).not.toContain("Refused git");
      expect(server.hits).toEqual([]);
      expect(other.hits).toEqual([]);
    },
    SLOW,
  );

  test(
    "AC-B172: beside the submodule keys, a submodule.<name>.update command and a url.<other>.insteadOf still refuse; no value shows",
    async () => {
      await cfgApp(["submodule.lib.update", "!planted-update-command"]);
      try {
        await expect(review("sub-3")).rejects.toThrow(
          `${join(appCache(), "config")} holds the key submodule.<subsection>.update, which the app does not allow. Open that file in a text editor, delete the key, and try again.`,
        );
      } finally {
        await cfgApp(["--unset", "submodule.lib.update"]);
      }
      await cfgApp([`url.${other.url}/.insteadOf`, `${server.url}/`]);
      try {
        await expect(review("sub-4")).rejects.toThrow("holds the key url.<subsection>.insteadof, which the app does not allow");
      } finally {
        await cfgApp(["--remove-section", `url.${other.url}/`]);
      }
      // An update mode without a command passes.
      await cfgApp(["submodule.lib.update", "merge"]);
      try {
        await (await review("sub-5")).remove();
      } finally {
        await cfgApp(["--unset", "submodule.lib.update"]);
      }
      const text = logText();
      expect(text).toContain(`Refused git fetch with the server token: ${join(appCache(), "config")} holds the key submodule.lib.update`);
      expect(text).not.toContain("planted-update-command");
      expect(text).not.toContain(server.url);
      expect(text).not.toContain(TOKEN);
      expect(other.hits).toEqual([]);
      expect(server.hits).toEqual([]);
    },
    SLOW,
  );

  test(
    "no fetch of the app enters a submodule, also with core.bare=false and fetchRecurseSubmodules in .gitmodules; control: git's default does",
    async () => {
      const lib = await bareRepo(sub, "rec-lib", { "lib.c": "x\n" });
      const lib2 = await lib.commit({ "lib.c": "y\n" }, {}, lib.base);
      const url = `${other.url}/scm/proj/lib.git`;
      const modules = `${gitmodules({ lib: url })}\tfetchRecurseSubmodules = true\n`;
      const rec = await bareRepo(sub, "rec", { ".gitmodules": modules }, { lib: lib.base });
      const cache = await fetchInto(dataDir, "PROJ", "rec", { url: rec.remote, config: auth() }, ["+refs/heads/main:refs/rl/main"]);
      // Planted: a work tree for the bare cache, the submodule keys, and a submodule repository whose remote is the other host.
      const plain = gitSetup(dataDir).env;
      const planted: [string, string][] = [
        ["core.bare", "false"],
        ["submodule.lib.active", "true"],
        ["submodule.lib.url", url],
      ];
      for (const [k, v] of planted) await git([`--git-dir=${cache}`, "config", k, v], { env: plain });
      const repo = join(cache, "modules", "lib");
      mkdirSync(repo, { recursive: true });
      await git(["init", "-q", "--bare", "--template=", repo], { env: plain });
      await git([`--git-dir=${repo}`, "config", "remote.origin.url", url], { env: plain });
      const cwd = join(sub, "cwd");
      mkdirSync(cwd);
      let n = 0;
      // A new main whose gitlink moves, so a recursing fetch has a submodule commit to fetch.
      const fetchMoved = async (env: Record<string, string>) => {
        const head = await rec.g(["rev-parse", "refs/heads/main"]);
        n++;
        const next = await rec.commit({ ".gitmodules": modules, "n.txt": `${n}\n` }, { lib: n % 2 ? lib2 : lib.base }, head);
        await rec.g(["update-ref", "refs/heads/main", next]);
        const args = [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--quiet",
          "--end-of-options",
          rec.remote,
          "+refs/heads/main:refs/rl/main",
        ];
        return git([`--git-dir=${cache}`, ...args], { env, cwd });
      };
      other.hits.length = 0;
      await fetchMoved(gitEnv(empty, auth()));
      expect(other.hits).toEqual([]);
      // Control: the same env with git's default on-demand recursion fetches the submodule from the other host. The scoped header stays.
      const env = gitEnv(empty, auth());
      const key = Object.keys(env).find((k) => /^GIT_CONFIG_KEY_\d+$/.test(k) && env[k] === "fetch.recurseSubmodules") as string;
      env[key.replace("KEY", "VALUE")] = "on-demand";
      await expect(fetchMoved(env)).rejects.toThrow();
      expect(other.hits.length).toBeGreaterThan(0);
      expect(other.hits.every((h) => h.auth === null)).toBe(true);
      other.hits.length = 0;
    },
    SLOW,
  );
});
