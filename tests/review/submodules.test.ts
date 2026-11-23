// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/submodule-prs.md WP-SM2: the submodule step (section 5) against the fake Bitbucket and the bare remotes of
// repos-fixture.ts. Real git is the oracle for the ranges and the diffs. No runner, no live server, and no other host.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRefs } from "../../src/server/review/clone";
import { CANDIDATES_BYTES, DESCRIPTION_BYTES } from "../../src/server/review/context-files";
import { git } from "../../src/server/review/git";
import {
  SUBMODULE_FILES_SHOWN,
  SUBMODULE_LABEL,
  SUBMODULES_MAX,
  type SubmoduleInput,
  submoduleContext,
  submoduleRun,
} from "../../src/server/review/submodules";
import { cachePath, fetchInto, gitSetup, longData, UNTRUSTED } from "../../src/server/review/workspace";
import { openDb } from "../../src/server/storage/db";
import { TASK_RUN_KINDS } from "../../src/shared/task";
import { FAKE_TOKEN, key, type repoWrites, startFakeBitbucket } from "../support/fake-bitbucket";
import { gitmodules, type MultiOptions, multiRepo, OTHER_URL } from "../tasks/repos-fixture";

console.log(`submodules.ts from ${Bun.resolveSync("../../src/server/review/submodules", import.meta.dir)}`);

const SLOW = 120_000;
const V1 = "1".repeat(40);
const V2 = "2".repeat(40);
const APP_FILES = { "README.md": "app\n", "src/app.ts": "export const app = 1;\n", ".gitignore": "ignored/\n" };
const LIB_MODULES = { ".gitmodules": gitmodules({ deep: "../deep.git" }) };
const s = (h: string) => h.slice(0, 12);

const fakes: { stop: () => void }[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

async function world(o: MultiOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "rl-sm2-"));
  dirs.push(root);
  const fake = startFakeBitbucket();
  fakes.push(fake);
  const m = await multiRepo(root, fake, o);
  const db: Database = openDb(":memory:");
  const forge = m.forges.lib as ReturnType<typeof repoWrites>;
  const dataDir = join(root, "data");
  // A commit of app with these gitlinks and .gitmodules entries.
  const appCommit = (links: Record<string, string>, modules: Record<string, string>, parent: string) =>
    m.app.commit({ ...APP_FILES, ".gitmodules": gitmodules(modules) }, links, parent);
  // A commit of lib on lib main with more files. branch: a branch of lib that points at it.
  const libCommit = async (files: Record<string, string>, branch?: string, links: Record<string, string> = { deep: m.deep.base }) => {
    const c = await m.lib.commit({ "lib.c": "int lib;\n", ...LIB_MODULES, ...files }, links, m.lib.base);
    if (branch) await m.lib.g(["update-ref", `refs/heads/${branch}`, c]);
    return c;
  };
  // Runs the step on base..head of PROJ/app. The main cache gets both commits as the workspace leaves them.
  const run = async (base: string, head: string, x: Partial<SubmoduleInput> = {}) => {
    await m.app.g(["update-ref", "refs/heads/review", head]);
    await m.app.g(["update-ref", "refs/heads/review-base", base]);
    const cache = await fetchInto(dataDir, "PROJ", "app", { url: m.app.remote, config: [] }, [
      "+refs/heads/review:refs/rl/2/source",
      "+refs/heads/review-base:refs/rl/2/target",
    ]);
    return submoduleContext({
      dataDir,
      cache,
      mergeBase: base,
      head,
      project: "PROJ",
      repo: "app",
      reader: m.provider,
      db,
      remote: m.remote,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      ...x,
    });
  };
  const subCache = (repo = "lib") => cachePath(longData(dataDir), { project: "PROJ", repo, id: 0 });
  const refs = async (repo = "lib") =>
    (await git([`--git-dir=${subCache(repo)}`, "for-each-ref", "--format=%(refname)"], { env: gitSetup(dataDir).env }))
      .split("\n")
      .filter(Boolean);
  // A lib PR on the fake whose head is head.
  const libPr = async (from: string, head: string, o: { title?: string; description?: string } = {}) => {
    const res = await fetch(`${fake.url}${forge.path}/pull-requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: o.title ?? `PR ${from}`,
        description: o.description,
        fromRef: { id: `refs/heads/${from}` },
        toRef: { id: "refs/heads/main" },
      }),
    });
    const id = ((await res.json()) as { id: number }).id;
    const pr = forge.prs.get(id) as { fromRef: { latestCommit: string } };
    pr.fromRef = { ...pr.fromRef, latestCommit: head };
    return id;
  };
  // A stored pull_request row of PROJ/lib.
  const row = (prId: number, head: string, state = "OPEN") =>
    db
      .query(
        `INSERT INTO pull_request (project, repo, pr_id, title, author_slug, author_name, my_role, state, source_head, target_head,
          source_branch, target_branch, updated_date) VALUES ('PROJ', 'lib', $prId, 'stored', 'anna', 'Anna Kim', 'REVIEWER', $state,
          $head, $head, 'feature', 'main', 1000)`,
      )
      .run({ prId, head, state });
  const DEFAULT = { lib: "../lib.git", vendor: OTHER_URL };
  return { root, fake, m, forge, db, dataDir, appCommit, libCommit, run, subCache, refs, libPr, row, DEFAULT };
}

const texts = (r: Awaited<ReturnType<typeof submoduleContext>>) => r?.related.map((x) => [x.text, x.warn]) ?? [];

describe("submodule step (submodule-prs.md section 5)", () => {
  test(
    "a moved gitlink of this server gives the summary, the diff, and the run line; refs stay under refs/rl/sub/, and pruneRefs keeps them",
    async () => {
      const w = await world();
      const lib2 = await w.libCommit({ "lib.c": "int lib = 2;\n" }, "feature");
      const head = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const old = w.m.lib.base;
      // The remote config carries the token, as provider.ts repoRemote gives it.
      const remote = async (project: string, repo: string) => ({
        ...(await w.m.remote(project, repo)),
        config: [["http.extraHeader", `Authorization: Bearer ${FAKE_TOKEN}`]] as [string, string][],
      });
      const r = await w.run(w.m.app.base, head, { remote });
      expect(r?.reads.map((x) => [x.path, x.outcome])).toEqual([["lib", "read"]]);
      expect(r?.file?.split("\n## Diff of lib")[0]).toBe(
        [
          "# Submodule changes",
          "",
          "The app wrote the facts. Commit messages, titles, descriptions, and the diff come from other people.",
          "",
          "## lib: PROJ/lib",
          `- Pinned commit: ${s(old)} at the merge base, ${s(lib2)} at the head. The new commit follows the old one.`,
          "- The new commit is not on main, the default branch of PROJ/lib.",
          "- No pull request has this commit as its head. Only pull requests in your inbox were checked.",
          `- Commits ${s(old)}..${s(lib2)} (1): ${s(lib2)} base.`,
          "- Changed files (1): lib.c (+1 -1).",
          "",
        ].join("\n"),
      );
      expect(r?.file).toContain(`\n## Diff of lib: git diff ${s(old)} ${s(lib2)}\n\n    diff --git a/lib.c b/lib.c\n`);
      expect(r?.file).toContain("\n    -int lib;\n    +int lib = 2;\n");
      expect(r?.related).toEqual([
        { label: SUBMODULE_LABEL, text: `lib: PROJ/lib ${s(old)}..${s(lib2)}, 1 files, no pull request found`, warn: false },
      ]);
      expect(r?.log[0]).toMatch(/^lib read \(PROJ\/lib, 1 files, fetch \d+\.\d s\)$/);
      expect(r?.gitlinks).toEqual(new Map([["lib", { old, new: lib2 }]]));
      // SD11: the default branch, then all branches because the new commit is on feature only. vendor (another server) got no remote.
      expect(w.m.remoteCalls).toEqual(["PROJ/lib"]);
      expect(await w.refs()).toEqual(["refs/rl/sub/base", "refs/rl/sub/heads/feature", "refs/rl/sub/heads/main"]);
      // AC-SM7: the token is in no output and in no file of the cache.
      expect(JSON.stringify(r)).not.toContain(FAKE_TOKEN);
      expect(readFileSync(join(w.subCache(), "config"), "utf8")).not.toContain(FAKE_TOKEN);
      // pruneRefs deletes refs/rl/<PR ID>/* of a closed PR of the same cache and leaves refs/rl/sub/*.
      w.row(7, lib2, "MERGED");
      await git([`--git-dir=${w.subCache()}`, "update-ref", "refs/rl/7/source", lib2], { env: gitSetup(w.dataDir).env });
      await pruneRefs(w.db, w.dataDir);
      expect(await w.refs()).toEqual(["refs/rl/sub/base", "refs/rl/sub/heads/feature", "refs/rl/sub/heads/main"]);
    },
    SLOW,
  );

  test(
    "each outcome of section 5.2 in path order; only added, removed, and url_changed join the file; another server gets no request",
    async () => {
      const w = await world();
      const lib2 = await w.libCommit({ "lib.c": "int lib = 2;\n" }, "feature");
      const base = await w.appCommit(
        {
          lib: w.m.lib.base,
          vendor: V1,
          "b-removed": w.m.lib.base,
          "c-nourl": w.m.lib.base,
          "d-url": w.m.lib.base,
          "f-noaccess": w.m.lib.base,
        },
        { ...w.DEFAULT, "b-removed": "../lib.git", "c-nourl": "../lib.git", "d-url": "../lib.git", "f-noaccess": "../nosuch.git" },
        w.m.app.base,
      );
      const head = await w.appCommit(
        { lib: lib2, vendor: V2, "a-added": w.m.lib.base, "c-nourl": lib2, "d-url": lib2, "f-noaccess": lib2 },
        { ...w.DEFAULT, "a-added": "../lib.git", "d-url": "../deep.git", "f-noaccess": "../nosuch.git" },
        base,
      );
      const r = await w.run(base, head);
      expect(r?.reads.map((x) => [x.path, x.outcome])).toEqual([
        ["a-added", "added"],
        ["b-removed", "removed"],
        ["c-nourl", "no_url"],
        ["d-url", "url_changed"],
        ["f-noaccess", "no_access"],
        ["lib", "read"],
        ["vendor", "other_server"],
      ]);
      expect(texts(r)).toEqual([
        ["a-added: added, not compared", false],
        ["b-removed: removed", false],
        ["c-nourl: not read (no URL in .gitmodules)", true],
        ["d-url: not read (the URL changed in this pull request)", true],
        ["f-noaccess: not read (no read access, or no such repository)", true],
        [`lib: PROJ/lib ${s(w.m.lib.base)}..${s(lib2)}, 1 files, no pull request found`, false],
        ["vendor: not read (another server)", true],
      ]);
      const headings = (r?.file ?? "").split("\n").filter((l) => l.startsWith("## "));
      expect(headings).toEqual([
        `## a-added: added at ${s(w.m.lib.base)}, not compared.`,
        "## b-removed: removed, not compared.",
        "## d-url: the URL changed in this pull request, not compared.",
        "## lib: PROJ/lib",
        `## Diff of lib: git diff ${s(w.m.lib.base)} ${s(lib2)}`,
      ]);
      expect(r?.gitlinks.get("a-added")).toEqual({ old: null, new: w.m.lib.base });
      expect(r?.gitlinks.get("b-removed")).toEqual({ old: w.m.lib.base, new: null });
      expect(r?.gitlinks.get("vendor")).toEqual({ old: V1, new: V2 });
      // SD9: the URL of another server gets no read and no fetch. The unmapped URL gets no fetch.
      expect(w.m.remoteCalls).toEqual(["PROJ/lib"]);
      expect(w.fake.requests.filter((q) => q.includes("vendor"))).toEqual([]);
    },
    SLOW,
  );

  test(
    "no connection, a failed mapping read, and the cap of 5 submodules; paths of one repository fetch once",
    async () => {
      const w = await world();
      const lib2 = await w.libCommit({ "lib.c": "int lib = 2;\n" }, "feature");
      const head = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const none = await w.run(w.m.app.base, head, { reader: null });
      expect(texts(none)).toEqual([["lib: not read (no Bitbucket connection)", true]]);
      expect(none?.file).toBeNull();
      expect(none?.gitlinks.get("lib")).toEqual({ old: w.m.lib.base, new: lib2 });
      expect(w.m.remoteCalls).toEqual([]);

      // The fake path of the candidate key gives 404, so the REPO_READ list decides. HTTP 500 there is no 404.
      const list = w.fake.routes[key("GET", "/rest/api/1.0/repos")];
      w.fake.routes[key("GET", "/rest/api/1.0/repos")] = { status: 500, body: { errors: [{ message: "Synthetic failure." }] } };
      const failed = await w.run(w.m.app.base, head);
      expect(texts(failed)).toEqual([["lib: not read (Bitbucket error server 500)", true]]);
      expect(failed?.file).toBeNull();
      if (list) w.fake.routes[key("GET", "/rest/api/1.0/repos")] = list;

      const paths = ["p1", "p2", "p3", "p4", "p5", "p6"];
      const at = (c: string) => Object.fromEntries(paths.map((p) => [p, c]));
      const modules = { ...w.DEFAULT, ...Object.fromEntries(paths.map((p) => [p, "../lib.git"])) };
      const base6 = await w.appCommit({ ...at(w.m.lib.base), lib: w.m.lib.base, vendor: V1 }, modules, w.m.app.base);
      const head6 = await w.appCommit({ ...at(lib2), lib: w.m.lib.base, vendor: V1 }, modules, base6);
      const capped = await w.run(base6, head6);
      expect(capped?.reads.map((x) => x.outcome)).toEqual([...Array(SUBMODULES_MAX).fill("read"), "capped"]);
      expect(texts(capped).at(-1)).toEqual(["p6: not read (the app reads at most 5 submodules)", true]);
      expect(capped?.file).toContain("\n## p6: not read. The app reads at most 5 submodules.\n");
      expect(capped?.file?.split("\n## Diff of ").length).toBe(SUBMODULES_MAX + 1);
      // Five paths of PROJ/lib: one remote, so one fetch group.
      expect(w.m.remoteCalls).toEqual(["PROJ/lib"]);
    },
    SLOW,
  );

  test(
    "a stored PR whose read has the new head: a refused PR ref falls back to the source branch; a read with another head does not match",
    async () => {
      const w = await world();
      const lib2 = await w.libCommit({ "lib.c": "int lib = 2;\n" }, "feature");
      const head = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const description = `DESCRIPTION-CANARY ${"x".repeat(DESCRIPTION_BYTES)}`;
      const id = await w.libPr("feature", lib2, { title: "Fix the lib\nvalue", description });
      w.row(id, lib2);
      // A stored row with the new head whose read shows another head: the read wins, so no match.
      const stale = await w.libPr("other", "3".repeat(40));
      w.row(stale, lib2);
      const r = await w.run(w.m.app.base, head);
      expect(texts(r)).toEqual([[`lib: PROJ/lib PR #${id} (open), 1 files`, false]]);
      expect(r?.file).toContain(
        `\n- Pull request #${id} "Fix the lib value" by User jdoe, open, from feature into main. Its head is the new commit.\n- Description (the first 4 KB):\n\n    DESCRIPTION-CANARY xxx`,
      );
      // The lib remote has no refs/pull-requests/<n>/from, so the source branch went to the PR ref. Step 3 was not needed.
      expect(await w.refs()).toEqual(["refs/rl/sub/base", `refs/rl/sub/pr/${id}`]);
      expect(w.fake.requests.some((q) => q.includes("/repos/lib/pull-requests?state=OPEN"))).toBe(false);
    },
    SLOW,
  );

  test(
    "the PR ref alone gives the commit; a failed PR read keeps the diff",
    async () => {
      const w = await world();
      const lib2 = await w.libCommit({ "lib.c": "int lib = 2;\n" });
      const head = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const id = await w.libPr("gone", lib2);
      await w.m.lib.g(["update-ref", `refs/pull-requests/${id}/from`, lib2]);
      w.row(id, lib2);
      const r = await w.run(w.m.app.base, head);
      expect(texts(r)).toEqual([[`lib: PROJ/lib PR #${id} (open), 1 files`, false]]);
      expect(await w.refs()).toEqual(["refs/rl/sub/base", `refs/rl/sub/pr/${id}`]);

      w.fake.routes[key("GET", `${w.forge.path}/pull-requests/${id}`)] = { status: 500, body: { errors: [{ message: "Down." }] } };
      const failed = await w.run(w.m.app.base, head);
      expect(texts(failed)).toEqual([
        [`lib: PROJ/lib ${s(w.m.lib.base)}..${s(lib2)}, 1 files, pull request not read (Bitbucket error server 500)`, true],
      ]);
      expect(failed?.file).toContain("\n- Pull request: not read (Bitbucket error server 500).\n");
      expect(failed?.file).toContain("\n## Diff of lib: ");
    },
    SLOW,
  );

  test(
    "the open-PR list is read only with peerReads; it gives one match or several",
    async () => {
      const w = await world();
      const lib2 = await w.libCommit({ "lib.c": "int lib = 2;\n" }, "feature");
      const head = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const a = await w.libPr("feature", lib2, { title: "Listed" });
      const listed = () => w.fake.requests.filter((q) => q.includes("/repos/lib/pull-requests?state=OPEN")).length;
      const gated = await w.run(w.m.app.base, head);
      expect(listed()).toBe(0);
      expect(texts(gated)[0]?.[0]).toEndWith(", no pull request found");

      const one = await w.run(w.m.app.base, head, { peerReads: true });
      expect(listed()).toBe(1);
      expect(texts(one)).toEqual([[`lib: PROJ/lib PR #${a} (open), 1 files`, false]]);
      expect(one?.file).toContain(`\n- Pull request #${a} "Listed" by User jdoe, open, from feature into main.`);

      const b = await w.libPr("feature-2", lib2);
      const two = await w.run(w.m.app.base, head, { peerReads: true });
      expect(texts(two)).toEqual([[`lib: PROJ/lib PRs #${a}, #${b}, 1 files`, false]]);
      expect(two?.file).toContain(`\n- 2 pull requests have this commit as their head: #${a}, #${b}.\n`);

      for (const id of [a, b]) (w.forge.prs.get(id) as { fromRef: { latestCommit: string } }).fromRef.latestCommit = V1;
      const none = await w.run(w.m.app.base, head, { peerReads: true });
      expect(none?.file).toContain("\n- No pull request has this commit as its head.\n");
    },
    SLOW,
  );

  test(
    "a new or an old commit on no branch, and a failed fetch without the token in its reason",
    async () => {
      const w = await world();
      const loose = await w.libCommit({ "lib.c": "int lib = 3;\n" });
      const head = await w.appCommit({ lib: loose, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const lost = await w.run(w.m.app.base, head);
      expect(texts(lost)).toEqual([[`lib: PROJ/lib: commit ${s(loose)} is on no branch`, true]]);
      expect(lost?.file).toBeNull();

      const base = await w.appCommit({ lib: loose, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const back = await w.appCommit({ lib: w.m.lib.base, vendor: w.m.vendorCommit }, w.DEFAULT, base);
      const old = await w.run(base, back);
      expect(texts(old)).toEqual([[`lib: PROJ/lib: the old commit ${s(loose)} is on no branch`, true]]);

      const remote = async () => ({
        url: join(w.root, "missing.git"),
        config: [["http.extraHeader", `Authorization: Bearer ${FAKE_TOKEN}`]] as [string, string][],
      });
      const failed = await w.run(w.m.app.base, head, { remote });
      expect(failed?.reads[0]?.outcome).toBe("fetch_failed");
      expect(texts(failed)[0]?.[0]).toStartWith("lib: not read (fetch failed: ");
      expect(JSON.stringify(failed)).not.toContain(FAKE_TOKEN);
    },
    SLOW,
  );

  test(
    "a nested gitlink, the file-boundary cut within 200 KB, and an equal share for two diffs",
    async () => {
      const w = await world();
      const deep2 = await w.m.deep.commit({ "deep.txt": "deep 2\n" }, {}, w.m.deep.base);
      const big = (c: string) => `${Array.from({ length: 1500 }, (_, i) => `${c}${i}`.padEnd(99, c)).join("\n")}\n`;
      const lib2 = await w.libCommit({ "a-big.txt": big("a"), "b-big.txt": big("b"), "c-small.txt": "c\n" }, "feature", { deep: deep2 });
      const head = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const r = await w.run(w.m.app.base, head);
      const file = r?.file ?? "";
      expect(Buffer.byteLength(UNTRUSTED + file)).toBeLessThanOrEqual(CANDIDATES_BYTES);
      expect(file).toContain("\n- Nested submodules that the app does not follow: deep.\n");
      expect(file).toContain(`\n    -Subproject commit ${w.m.deep.base}\n    +Subproject commit ${deep2}\n`);
      expect(file).toContain("\n- Not in the diff below: b-big.txt.\n");
      expect(file).toContain("\n    diff --git a/a-big.txt b/a-big.txt\n");
      expect(file).toContain("\n    diff --git a/c-small.txt b/c-small.txt\n");
      expect(file).not.toContain("diff --git a/b-big.txt");
      expect(r?.reads[0]?.cut).toEqual(["b-big.txt"]);
      expect(texts(r)[0]?.[0]).toEndWith(", 4 files, no pull request found, cut");

      // Two paths of one range: each diff gets half of the room, so neither big file fits.
      const modules = { ...w.DEFAULT, "lib-b": "../lib.git" };
      const base2 = await w.appCommit({ lib: w.m.lib.base, "lib-b": w.m.lib.base, vendor: V1 }, modules, w.m.app.base);
      const head2 = await w.appCommit({ lib: lib2, "lib-b": lib2, vendor: V1 }, modules, base2);
      const two = await w.run(base2, head2);
      expect(Buffer.byteLength(UNTRUSTED + (two?.file ?? ""))).toBeLessThanOrEqual(CANDIDATES_BYTES);
      expect(two?.reads.map((x) => x.cut)).toEqual([
        ["a-big.txt", "b-big.txt"],
        ["a-big.txt", "b-big.txt"],
      ]);
      expect(two?.file?.split("\n    diff --git a/c-small.txt b/c-small.txt\n").length).toBe(3);
    },
    SLOW,
  );

  test(
    "many small files: the changed-file and the left-out lists stop at 200 names, and the file stays within 200 KB",
    async () => {
      const w = await world();
      const files = Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [`f${String(i).padStart(3, "0")}.txt`, `${"y".repeat(1200)}\n`]),
      );
      const lib2 = await w.libCommit(files, "feature");
      const head = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const r = await w.run(w.m.app.base, head);
      const file = r?.file ?? "";
      expect(Buffer.byteLength(UNTRUSTED + file)).toBeLessThanOrEqual(CANDIDATES_BYTES);
      const line = (start: string) => file.split("\n").find((l) => l.startsWith(start)) ?? "";
      expect(line("- Changed files (400): ")).toEndWith(", ... 200 more.");
      expect(line("- Changed files (400): ").split(" (+1 -0)").length - 1).toBe(SUBMODULE_FILES_SHOWN);
      const cut = r?.reads[0]?.cut ?? [];
      expect(cut.length).toBeGreaterThan(SUBMODULE_FILES_SHOWN);
      const shown = line("- Not in the diff below: ");
      expect(shown).toEndWith(`, ... ${cut.length - SUBMODULE_FILES_SHOWN} more.`);
      expect(shown.split(", ").length - 1).toBe(SUBMODULE_FILES_SHOWN);
      // The kept files come first in path order, and the cut starts at a file boundary.
      expect(file).toContain("\n    diff --git a/f000.txt b/f000.txt\n");
      expect(file).not.toContain(`diff --git a/${cut[0]} `);
    },
    SLOW,
  );

  test(
    "no moved gitlink: null after one local git call, with no read and no fetch; Cancel during the reads throws",
    async () => {
      const w = await world();
      const head = await w.m.app.commit(
        { ...APP_FILES, "src/app.ts": "export const app = 2;\n", ".gitmodules": gitmodules(w.DEFAULT) },
        { lib: w.m.lib.base, vendor: w.m.vendorCommit },
        w.m.app.base,
      );
      expect(await w.run(w.m.app.base, head)).toBeNull();
      expect(w.fake.requests).toEqual([]);
      expect(w.m.remoteCalls).toEqual([]);

      const lib2 = await w.libCommit({ "lib.c": "int lib = 2;\n" }, "feature");
      const moved = await w.appCommit({ lib: lib2, vendor: w.m.vendorCommit }, w.DEFAULT, w.m.app.base);
      const main = key("GET", "/rest/api/1.0/projects/PROJ/repos/app");
      w.fake.routes[main] = { hang: true };
      const ac = new AbortController();
      const step = w.run(w.m.app.base, moved, { signal: ac.signal });
      const end = Date.now() + 30_000;
      while (!w.fake.requests.includes(main) && Date.now() < end) await Bun.sleep(25);
      expect(w.fake.requests).toContain(main);
      ac.abort();
      await expect(step).rejects.toThrow();
      expect(w.m.remoteCalls).toEqual([]);
    },
    SLOW,
  );
});

describe("run kinds (AC-SM9)", () => {
  test("only a review or re-review run with the variant and without the Explain profile gets the step", () => {
    const on = { explain: false, variants: ["submodules" as const] };
    const kinds = ["review", "reply", "ask", "fix", "session", "explain", "discuss", ...TASK_RUN_KINDS] as const;
    expect(kinds.filter((k) => submoduleRun(k, on))).toEqual(["review"]);
    expect(submoduleRun("review", { explain: true, variants: ["submodules"] })).toBe(false);
    expect(submoduleRun("review", { explain: false, variants: ["stack"] })).toBe(false);
  });
});
