// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md section 6.16.3 (WP-MR2): the base pick of a submodule stays when the next spec run resolves the
// repositories again, and a pick that is gone on the server falls back to the default branch. Temp bare remotes and the fake Bitbucket.
import { afterEach, describe, expect, test } from "bun:test";
import { git } from "../../src/server/review/git";
import { resolveTaskRepos } from "../../src/server/tasks/repos";
import { depsOf } from "./repos-fixture";
import { cleanup, multiTask, SLOW } from "./update-fixture";

for (const m of ["tasks/repos"]) console.log(`bases.test.ts imported from ${Bun.resolveSync(`../../src/server/${m}`, import.meta.dir)}`);

process.env.REVIEW_LOOP_SECRETS = "memory";
afterEach(cleanup);

describe("the base pick of a submodule (spec.md section 6.16.3)", () => {
  test(
    "a resolve keeps the picked base of a submodule; a pick that is gone falls back to the default branch",
    async () => {
      const s = await multiTask();
      const base = () =>
        (s.db.query("SELECT base_branch FROM task_repo WHERE task = $t AND path = 'lib'").get({ t: s.task }) as { base_branch: string })
          .base_branch;
      expect(base()).toBe("main");
      await git(["--git-dir", s.m.lib.remote, "update-ref", "refs/heads/release/2.1", s.m.lib.base], { env: s.m.lib.env });
      s.db.query("UPDATE task_repo SET base_branch = 'release/2.1' WHERE task = $t AND path = 'lib'").run({ t: s.task });
      await resolveTaskRepos(s.db, depsOf(s.m, s.dataDir), s.t(), s.base);
      expect(base()).toBe("release/2.1");
      await git(["--git-dir", s.m.lib.remote, "update-ref", "-d", "refs/heads/release/2.1"], { env: s.m.lib.env });
      await resolveTaskRepos(s.db, depsOf(s.m, s.dataDir), s.t(), s.base);
      expect(base()).toBe("main");
    },
    SLOW,
  );
});
