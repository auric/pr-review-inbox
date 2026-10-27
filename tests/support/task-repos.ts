// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// A task with several repositories (docs/plans/review-v2/spec.md section 6.16) for the e2e server and the demo. The main repository
// <project>/app holds a gitlink to <project>/lib on the fake Bitbucket (relative URL ../lib.git) and one to another server. Temp bare
// remotes take the pushes. OTHER_URL is a reserved name, and the app sends no request there. Test code only.
import { bareRepo, gitmodules, OTHER_URL } from "../tasks/repos-fixture";
import { type FakeBitbucket, key, repoWrites } from "./fake-bitbucket";
import { onePage } from "./scenarios";

export type RepoFiles = { app: Record<string, string>; lib: Record<string, string> };

export async function taskRepoSet(root: string, fake: FakeBitbucket, project: string, files: RepoFiles) {
  const lib = await bareRepo(root, "multi-lib", files.lib);
  const app = await bareRepo(
    root,
    "multi-app",
    { ...files.app, ".gitmodules": gitmodules({ lib: "../lib.git", vendor: OTHER_URL }) },
    { lib: lib.base, vendor: "1".repeat(40) },
  );
  const forges = { app: repoWrites(fake, project, "app"), lib: repoWrites(fake, project, "lib") };
  const remotes: Record<string, string> = { [`${project}/app`]: app.remote, [`${project}/lib`]: lib.remote };
  // refuse: the next PR create of lib gets HTTP 403, as for a token without Repository write.
  const flags = { refuse: false };
  // A created PR gets an empty activity page, so its sync is complete.
  for (const [name, f] of Object.entries(forges)) {
    const k = key("POST", `${f.path}/pull-requests`);
    const create = fake.routes[k];
    fake.routes[k] = async (req) => {
      if (name === "lib" && flags.refuse) {
        flags.refuse = false;
        return { status: 403, body: { errors: [{ message: "Forbidden" }] } };
      }
      const res = typeof create === "function" ? await create(req) : { status: 404 };
      const id = "body" in res ? (res.body as { id?: number } | undefined)?.id : undefined;
      if ("status" in res && res.status === 201 && id !== undefined)
        fake.routes[key("GET", `${f.path}/pull-requests/${id}/activities`)] = { status: 200, body: onePage([]) };
      return res;
    };
  }

  // The branches of both remotes with their commits.
  async function heads() {
    const read = async (r: typeof app) =>
      Object.fromEntries(
        (await r.g(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]))
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split(" ")),
      ) as Record<string, string>;
    return { app: await read(app), lib: await read(lib) };
  }

  // The commit that the gitlink lib points at on a branch of app, or null.
  const gitlink = async (branch: string) =>
    (await app.g(["ls-tree", `refs/heads/${branch}`, "lib"]).catch(() => "")).split(/\s+/)[2] ?? null;

  // Merges the open lib PR with a merge commit on lib main, as Bitbucket does by default. The MERGED activity names that commit (Gate
  // G17). Returns the merge commit.
  async function mergeLib(): Promise<string> {
    const pr = [...forges.lib.prs.values()].find((p) => p.state === "OPEN");
    if (!pr) throw new Error("The fake has no open PR of lib.");
    const head = await lib.g(["rev-parse", pr.fromRef.id]);
    const main = await lib.g(["rev-parse", "refs/heads/main"]);
    const merge = await lib.g(["commit-tree", `${head}^{tree}`, "-p", main, "-p", head, "-m", `Merge pull request #${pr.id}`]);
    await lib.g(["update-ref", "refs/heads/main", merge]);
    forges.lib.merge(pr.id, { activity: merge });
    return merge;
  }

  // The task branches go, main of each remote is back at its first commit, and the PRs of the fake go.
  async function reset() {
    flags.refuse = false;
    for (const f of Object.values(forges)) {
      f.prs.clear();
      f.writes.length = 0;
    }
    for (const r of [app, lib]) {
      for (const ref of (await r.g(["for-each-ref", "--format=%(refname)", "refs/heads/"])).split("\n").filter(Boolean))
        if (ref !== "refs/heads/main") await r.g(["update-ref", "-d", ref]);
      await r.g(["update-ref", "refs/heads/main", r.base]);
    }
  }

  return { app, lib, forges, remotes, flags, heads, gitlink, mergeLib, reset };
}
