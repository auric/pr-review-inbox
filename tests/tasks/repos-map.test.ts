// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { ForgeError } from "../../src/server/bitbucket/client";
import type { RepoInfo } from "../../src/server/bitbucket/provider";
import { mapRepoUrl, serverHosts } from "../../src/server/tasks/repos";

const ORIGIN = "https://git.example.test";
const info = (project: string, slug: string, host = "git.example.test"): RepoInfo => ({
  project,
  slug,
  name: slug,
  clone: [
    { name: "http", href: `https://user@${host}/scm/${project.toLowerCase()}/${slug}.git` },
    { name: "ssh", href: `ssh://git@${host}:7999/${project.toLowerCase()}/${slug}.git` },
  ],
});
const MAIN = info("PRJ", "app");

// repos: the repositories that GET /repos/{project}/{repo} finds by candidate key. readable: the REPO_READ list.
function provider(repos: RepoInfo[], readable: RepoInfo[] = []) {
  const calls = { repository: [] as string[], readable: 0 };
  return {
    calls,
    p: {
      origin: ORIGIN,
      async repository(project: string, repo: string) {
        calls.repository.push(`${project}/${repo}`);
        const r = repos.find((x) => x.clone.some((c) => c.href.endsWith(`/${project}/${repo}.git`)));
        if (!r) throw new ForgeError("not_found", "repository");
        return r;
      },
      async readableRepos() {
        calls.readable++;
        return { repos: readable, complete: true };
      },
    },
  };
}

describe("serverHosts and mapRepoUrl (submodule-prs.md SD7 to SD9)", () => {
  const hosts = serverHosts({ origin: ORIGIN }, MAIN);
  const parent = MAIN.clone[0]?.href as string;

  test("the host set holds the origin host and the clone link hosts", () => {
    expect([...hosts]).toEqual(["git.example.test"]);
  });

  test("a relative URL resolves against the parent URL", async () => {
    const lib = info("PRJ", "lib");
    const { p } = provider([lib]);
    const m = await mapRepoUrl(p, hosts, parent, "../lib.git");
    expect(m).toEqual({ otherServer: false, url: "https://git.example.test/scm/prj/lib.git", info: lib });
  });

  test("the scp form names a host but gives no candidate", async () => {
    const { p, calls } = provider([info("PRJ", "lib")]);
    expect(await mapRepoUrl(p, hosts, parent, "git@git.example.test:prj/lib.git")).toEqual({ otherServer: false, url: null, info: null });
    expect(calls.repository).toEqual([]);
  });

  test("another server gets no request", async () => {
    const { p, calls } = provider([info("PRJ", "lib")]);
    expect(await mapRepoUrl(p, hosts, parent, "https://other.example.test/scm/prj/lib.git")).toEqual({
      otherServer: true,
      url: null,
      info: null,
    });
    expect(calls).toEqual({ repository: [], readable: 0 });
  });

  test("a candidate miss falls back to the REPO_READ list", async () => {
    // The URL path uses a project alias, so the candidate key finds no repository.
    const lib = { ...info("PRJ", "lib"), clone: [{ name: "http", href: "https://git.example.test/scm/alias/lib.git" }] };
    const { p, calls } = provider([], [info("PRJ", "other"), lib]);
    const m = await mapRepoUrl(p, hosts, parent, "https://git.example.test/scm/alias/lib.git");
    expect(m).toEqual({ otherServer: false, url: "https://git.example.test/scm/alias/lib.git", info: lib });
    expect(calls).toEqual({ repository: ["alias/lib"], readable: 1 });
  });

  test("no match gives a URL without a repository", async () => {
    const { p } = provider([], [info("PRJ", "other")]);
    expect(await mapRepoUrl(p, hosts, parent, "https://git.example.test/scm/prj/gone.git")).toEqual({
      otherServer: false,
      url: "https://git.example.test/scm/prj/gone.git",
      info: null,
    });
  });
});
