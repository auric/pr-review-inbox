// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Temp bare remotes of a main repository with submodules (docs/plans/review-v2/spec.md section 6.16.5), and the fake Bitbucket rows of
// them. PROJ/app holds lib (same server, relative URL ../lib.git) and vendor (another server). PROJ/lib holds the nested deep. No test
// reaches a forge or another host: the http clone links name the fake, and the fetches go to the local bare remotes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBitbucketProvider } from "../../src/server/bitbucket/provider";
import { git, gitEnv } from "../../src/server/review/git";
import { cachePath, fetchInto, gitSetup } from "../../src/server/review/workspace";
import type { RepoDeps } from "../../src/server/tasks/repos";
import { FAKE_TOKEN, type FakeBitbucket, repoWrites } from "../support/fake-bitbucket";
import { IDENTITY } from "./fixture";

// A reserved name (RFC 2606): no request may go there.
export const OTHER_URL = "https://git.example.invalid/ext/vendor.git";

export async function bareRepo(root: string, name: string, files: Record<string, string>, links: Record<string, string> = {}) {
  const empty = join(root, "empty.gitconfig");
  writeFileSync(empty, "");
  const remote = join(root, `${name}.git`);
  const env = { ...gitEnv(empty), ...IDENTITY, GIT_INDEX_FILE: join(root, `${name}.index`) };
  const g = async (args: string[], stdin?: string) => (await git(["--git-dir", remote, ...args], { env, stdin })).trim();
  await git(["init", "-q", "--bare", "--template=", remote], { env });
  await g(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const commit = async (f: Record<string, string>, l: Record<string, string>, parent?: string) => {
    const paths = Object.keys(f);
    const blobs = paths.map((p, i) => {
      const file = join(root, `${name}-blob-${i}`);
      writeFileSync(file, f[p] as string);
      return file;
    });
    const shas = paths.length ? (await g(["hash-object", "-w", "--no-filters", "--stdin-paths"], `${blobs.join("\n")}\n`)).split("\n") : [];
    await g(["read-tree", "--empty"]);
    const entries = [...paths.map((p, i) => `100644 ${shas[i]}\t${p}`), ...Object.entries(l).map(([p, sha]) => `160000 ${sha}\t${p}`)];
    await g(["update-index", "--index-info"], `${entries.join("\n")}\n`);
    return g(["commit-tree", await g(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", "base"]);
  };
  const base = await commit(files, links);
  await g(["update-ref", "refs/heads/main", base]);
  return { remote, base, env, g, commit };
}

export const gitmodules = (subs: Record<string, string>) =>
  Object.entries(subs)
    .map(([path, url]) => `[submodule "${path}"]\n\tpath = ${path}\n\turl = ${url}\n`)
    .join("");

// extraLinks: more gitlinks of app; a function gets the lib commit.
export type MultiOptions = {
  libWritable?: boolean;
  extraLinks?: Record<string, string> | ((lib: string) => Record<string, string>);
  extraModules?: Record<string, string>;
};

// The remotes, the fake rows, the provider, and the deps of resolveTaskRepos. remoteCalls: each project/repo that the app fetched from.
export async function multiRepo(root: string, fake: FakeBitbucket, o: MultiOptions = {}) {
  const deep = await bareRepo(root, "deep", { "deep.txt": "deep\n" });
  const lib = await bareRepo(
    root,
    "lib",
    { "lib.c": "int lib;\n", ".gitmodules": gitmodules({ deep: "../deep.git" }) },
    { deep: deep.base },
  );
  const vendorCommit = "1".repeat(40);
  const app = await bareRepo(
    root,
    "app",
    {
      "README.md": "app\n",
      "src/app.ts": "export const app = 1;\n",
      ".gitignore": "ignored/\n",
      ".gitmodules": gitmodules({ lib: "../lib.git", vendor: OTHER_URL, ...o.extraModules }),
    },
    { lib: lib.base, vendor: vendorCommit, ...(typeof o.extraLinks === "function" ? o.extraLinks(lib.base) : o.extraLinks) },
  );
  repoWrites(fake, "PROJ", "app");
  repoWrites(fake, "PROJ", "lib", { writable: o.libWritable ?? true });
  repoWrites(fake, "PROJ", "deep");
  const remotes: Record<string, string> = { app: app.remote, lib: lib.remote, deep: deep.remote };
  const remoteCalls: string[] = [];
  const remote = async (project: string, repo: string) => {
    remoteCalls.push(`${project}/${repo}`);
    const url = remotes[repo];
    if (project !== "PROJ" || !url) throw new Error(`No remote for ${project}/${repo}.`);
    return { url, config: [] as [string, string][] };
  };
  const provider = createBitbucketProvider({ baseUrl: fake.url, token: FAKE_TOKEN });
  return { app, lib, deep, vendorCommit, remote, remoteCalls, provider, remotes };
}

export type Multi = Awaited<ReturnType<typeof multiRepo>>;

export const depsOf = (m: Multi, dataDir: string): RepoDeps => ({ dataDir, provider: async () => m.provider, remote: m.remote });

// The main cache of PROJ/app with main fetched, as a task run leaves it.
export async function mainCache(dataDir: string, m: Multi) {
  await fetchInto(dataDir, "PROJ", "app", { url: m.app.remote, config: [] }, ["+refs/heads/main:refs/rl/task/1/target"]);
  const { env } = gitSetup(dataDir);
  return { cache: cachePath(dataDir, { project: "PROJ", repo: "app", id: 1 }), env };
}
