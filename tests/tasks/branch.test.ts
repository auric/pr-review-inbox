// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/spec.md sections 6.16.2 and 6.16.3 (WP-BR1, AC-B26, AC-B28): the branch name with its cap, and the base
// preselection order. Pure functions with stubs. No test reaches a forge.
import { describe, expect, test } from "bun:test";
import { preselectBase } from "../../src/server/tasks/tasks";
import { firstFree } from "../../src/server/tasks/worktree";
import { branchPrefix, branchPrefixList } from "../../src/shared/dto";
import { BRANCH_MAX, branchName, slug } from "../../src/shared/task";

for (const m of ["server/tasks/tasks", "shared/task"])
  console.log(`branch.test.ts imported from ${Bun.resolveSync(`../../src/${m}`, import.meta.dir)}`);

const small = (title: string, prefix = "feature/", key = "ABC-123") => branchName(prefix, key, { kind: "small", title });

describe("branch names (spec.md section 6.16.2)", () => {
  test("AC-B26: the spec example keeps the full summary", () => {
    const name = small("[server][linux] M3: Crash capture and dump generation on Linux");
    expect(name).toBe("feature/ABC-123-server-linux-m3-crash-capture-and-dump-generation-on-linux");
    expect(name.length).toBe(74);
  });

  test("AC-B26: a long summary is cut at a hyphen, and the name with -99 stays within 100 characters", () => {
    const title = "Make the sync worker flush every pending cache write before it takes the database write lock again";
    const name = small(title);
    expect(`${name}-99`.length).toBeLessThanOrEqual(BRANCH_MAX);
    expect(name.endsWith("-")).toBe(false);
    const cut = name.slice("feature/ABC-123-".length);
    const full = slug(title);
    // The cut ends at a word: the full slug goes on with a hyphen.
    expect(full.startsWith(cut)).toBe(true);
    expect(full[cut.length]).toBe("-");
    // The longest cut that fits.
    expect(`${name}-${full.slice(cut.length + 1).split("-")[0]}-99`.length).toBeGreaterThan(BRANCH_MAX);
  });

  test("a slug without a hyphen that fits is cut at the limit; a part name has the same cap", () => {
    const name = small("x".repeat(200));
    expect(name.length).toBe(BRANCH_MAX - 3);
    expect(name).toBe(`feature/ABC-123-${"x".repeat(BRANCH_MAX - 3 - 16)}`);
    const part = branchName("feature/", "ABC-123", { kind: "part", n: 12, title: "y".repeat(200) });
    expect(`${part}-99`.length).toBe(BRANCH_MAX);
    expect(part.startsWith("feature/ABC-123-12-yyy")).toBe(true);
  });

  test("a summary without ASCII letters or digits gives task (part: part); the spec branch has no slug", () => {
    expect(small("Додати прапор")).toBe("feature/ABC-123-task");
    expect(small("")).toBe("feature/ABC-123-task");
    expect(small("--- !!! ---")).toBe("feature/ABC-123-task");
    expect(branchName("bugfix/", "ABC-123", { kind: "part", n: 2, title: "日本" })).toBe("bugfix/ABC-123-2-part");
    expect(branchName("hotfix/", "ABC-123", { kind: "spec" })).toBe("hotfix/ABC-123-spec");
    expect(slug("Ünïcode — mixed Words 42")).toBe("n-code-mixed-words-42");
  });

  test("the first free name: the name, then -2 to -99", () => {
    expect(firstFree("a", new Set())).toBe("a");
    expect(firstFree("a", new Set(["a", "a-2"]))).toBe("a-3");
    expect(firstFree("a", new Set(["a"]), 2)).toBe("a-2");
    expect(() => firstFree("a", new Set(Array.from({ length: 99 }, (_, i) => (i ? `a-${i + 1}` : "a"))))).toThrow(
      "The branch names a to a-99 are all taken.",
    );
  });
});

describe("the prefix list (spec.md section 6.16.1)", () => {
  test("a prefix is valid when <prefix>x is a branch name, with 1 to 40 characters", () => {
    for (const ok of ["feature/", "users/me/", "fix-", "a"]) expect(branchPrefix.safeParse(ok).success).toBe(true);
    for (const bad of ["", "bad..", "/x", "a b/", "x".repeat(41), "a~/", ".hidden/", "a.lock/"])
      expect(branchPrefix.safeParse(bad).error?.issues[0]?.message).toBe("Invalid branch prefix.");
  });

  test("the list holds 1 to 50 unique prefixes", () => {
    expect(branchPrefixList.safeParse(["feature/", "bugfix/", "hotfix/"]).success).toBe(true);
    const msg = (l: string[]) => branchPrefixList.safeParse(l).error?.issues[0]?.message;
    expect(msg([])).toBe("Keep at least one prefix.");
    expect(msg(["a/", "a/"])).toBe("This prefix is already in the list.");
    expect(branchPrefixList.safeParse(Array.from({ length: 50 }, (_, i) => `p${i}/`)).success).toBe(true);
    expect(msg(Array.from({ length: 51 }, (_, i) => `p${i}/`))).toBe("At most 50 prefixes.");
    expect(msg(["ok/", "bad.."])).toBe("Invalid branch prefix.");
  });
});

describe("base preselection (spec.md section 6.16.3, AC-B28)", () => {
  const calls: string[] = [];
  const provider = (o: { branches?: string[]; listFails?: boolean; defaultBranch?: string | null }) => ({
    async listBranches(_p: string, _r: string, filter: string) {
      calls.push(`list ${filter}`);
      if (o.listFails) throw new Error("HTTP 500");
      return { branches: (o.branches ?? []).map((name) => ({ name, isDefault: false })), more: false };
    },
    async defaultBranch() {
      calls.push("default");
      if (!o.defaultBranch) throw new Error("HTTP 404");
      return o.defaultBranch;
    },
  });
  const pick = async (last: string | null, p: ReturnType<typeof provider> | null) => {
    calls.length = 0;
    return preselectBase({
      last,
      provider: p,
      project: "PROJ",
      repo: "repo",
      remoteHead: async () => {
        calls.push("ls-remote");
        return "trunk";
      },
    });
  };

  test("the last pick when the search finds exactly that name", async () => {
    expect(await pick("release/2.1", provider({ branches: ["release/2.1-old", "release/2.1"], defaultBranch: "main" }))).toBe(
      "release/2.1",
    );
    expect(calls).toEqual(["list release/2.1"]);
  });

  test("the default branch when the last pick is gone, missing, or the search fails", async () => {
    expect(await pick("release/2.1", provider({ branches: ["release/2.1-old"], defaultBranch: "main" }))).toBe("main");
    expect(calls).toEqual(["list release/2.1", "default"]);
    expect(await pick(null, provider({ defaultBranch: "main" }))).toBe("main");
    expect(calls).toEqual(["default"]);
    expect(await pick("x", provider({ listFails: true, defaultBranch: "main" }))).toBe("main");
    expect(calls).toEqual(["list x", "default"]);
  });

  test("the remote HEAD when the default branch read fails or no provider exists", async () => {
    expect(await pick(null, provider({ defaultBranch: null }))).toBe("trunk");
    expect(calls).toEqual(["default", "ls-remote"]);
    expect(await pick("x", null)).toBe("trunk");
    expect(calls).toEqual(["ls-remote"]);
  });
});
