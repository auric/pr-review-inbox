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
import { fetchInto, gitSetup, remoteHead } from "../../src/server/review/workspace";
import { pushTaskBranch } from "../../src/server/tasks/push";
import { taskRemote } from "../tasks/fixture";

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
        ).rejects.toThrow("holds the key url.<subsection>.insteadof, which the app does not write. The app log names the full key.");
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
