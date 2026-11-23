// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/submodule-prs.md: the submodule context of a review run with the variant "submodules". The step finds the gitlinks
// that the change moves, maps each URL to a repository of the server, finds the PR whose head is the new commit, fetches the submodule
// repository into its own cache under refs/rl/sub/, and writes context/submodules.md from `git diff <old> <new>`. No submodule is
// checked out, and the claude child gets no new tool.
import type { Database } from "bun:sqlite";
import { indentBlock, oneLine } from "../../shared/consult";
import type { RunKind } from "../../shared/dto";
import type { PullRequest } from "../../shared/types";
import { ForgeError } from "../bitbucket/client";
import type { ForgeProvider, RepoInfo } from "../bitbucket/provider";
import { gitmoduleUrls, mapRepoUrl, normalizeUrl, serverHosts } from "../tasks/repos";
import type { Profile } from "./catalog";
import { CANDIDATES_BYTES, DESCRIPTION_BYTES, PEER_READ_MS } from "./context-files";
import { parseDiff } from "./diffmap";
import { git } from "./git";
import type { Gitlinks } from "./judge";
import { within } from "./notes";
import { PEER_READS } from "./pr-context";
import { type BranchRemote, cachePath, diffArgs, fetchInto, gitSetup, longData, noUrl, UNTRUSTED, WorkspaceError } from "./workspace";

export const SUBMODULES_MAX = 5;
export const SUBMODULE_COMMITS_SHOWN = 20;
export const SUBMODULE_FILES_SHOWN = 200;
export const SUBMODULES_FILE = "submodules.md";
// The RunDto.related label of the run log footer (section 5.6).
export const SUBMODULE_LABEL = "Submodule context";
// provider.ts OPEN_PR_LIMIT: the open-PR list reads one page.
const OPEN_LISTED = 50;
// workspace.ts REF: a branch name of the server becomes a refspec.
const REF = /^refs\/[^\p{Cc}\s:*?[\\^~]+$/u;
// SD10: pruneRefs deletes only refs/rl/<PR number>/*, so these refs stay.
const SUB = "refs/rl/sub";
// The fetch reason of the run line is git text of the server.
const REASON_CHARS = 200;

// SD4 and AC-SM9: review and re-review runs with the variant only. An Explain profile gives no findings.
export const submoduleRun = (kind: RunKind, p: Pick<Profile, "explain" | "variants">) =>
  kind === "review" && !p.explain && p.variants.includes("submodules");

export type SubmoduleReader = Pick<
  ForgeProvider,
  "origin" | "repository" | "readableRepos" | "defaultBranch" | "getPullRequest" | "listOpenPullRequests"
>;

export type SubmoduleChange = { path: string; old: string | null; new: string | null; oldUrl: string | null; newUrl: string | null };

// Section 5.2, in check order. read_failed: a mapping read failed with no 404 or ran out of time (section 5.2, row 7b).
export type SubmoduleOutcome =
  | "added"
  | "removed"
  | "no_url"
  | "url_changed"
  | "other_server"
  | "no_connection"
  | "no_access"
  | "read_failed"
  | "capped"
  | "fetch_failed"
  | "new_missing"
  | "old_missing"
  | "read";

// One changed gitlink after the step. repo: the mapped repository. prs: the PRs whose head is the new commit. files: the changed files of
// old..new. cut: the files that the diff of submodules.md leaves out. text and warn: the run line part.
export type SubmoduleRead = SubmoduleChange & {
  outcome: SubmoduleOutcome;
  repo: { project: string; slug: string } | null;
  prs: PullRequest[];
  files: number;
  cut: string[];
  text: string;
  warn: boolean;
};

export type SubmoduleInput = {
  dataDir: string;
  // The cache of the reviewed repository. It holds the merge base and the head.
  cache: string;
  mergeBase: string;
  head: string;
  // The target repository of the PR. SD8: a relative URL resolves against its http clone link.
  project: string;
  repo: string;
  // null: no Bitbucket URL or token.
  reader: SubmoduleReader | null;
  db: Database;
  // The fetch remote of a repository of the server (provider.ts repoRemote). The URL never comes from .gitmodules.
  remote: (project: string, repo: string) => Promise<BranchRemote>;
  // Cancel. An abort throws out of the step.
  signal: AbortSignal;
  // SD12: the fetches share the run time limit.
  timeoutMs: number;
  // Tests only, in place of PEER_READS.
  peerReads?: boolean;
};

export type SubmoduleContext = {
  reads: SubmoduleRead[];
  // context/submodules.md without the UNTRUSTED banner. null: no diff was read (SD20).
  file: string | null;
  // SD21: the judge input.
  gitlinks: Gitlinks;
  related: { label: string; text: string; warn: boolean }[];
  // The parts of the server log line (section 5.6).
  log: string[];
};

type Facts = {
  direction: string;
  count: number;
  commits: string[];
  // null: the default branch was not fetched.
  onBase: boolean | null;
  base: string | null;
  files: { path: string; add: string; del: string }[];
  nested: string[];
  diff: string;
};

type Entry = SubmoduleRead & {
  why?: string;
  prNotes: string[];
  prError?: string;
  fetchMs?: number;
  facts?: Facts;
};

const STORED = "SELECT pr_id FROM pull_request WHERE project = $project AND repo = $repo AND source_head = $head ORDER BY pr_id";

const size = (s: string) => Buffer.byteLength(s);
const short = (h: string | null) => (h ?? "").slice(0, 12);
// The cut keeps whole code points. stream: true holds back a UTF-8 sequence that the cut splits.
const cutBytes = (s: string, max: number) => {
  const b = new TextEncoder().encode(s);
  return b.length <= max ? s : new TextDecoder().decode(b.subarray(0, max), { stream: true });
};
// Check 4: a relative or scp-like URL has no normalized form, so its text counts.
const urlKey = (url: string) => normalizeUrl(url) ?? url.trim();
const httpLink = (r: RepoInfo) => r.clone.find((c) => c.name === "http")?.href ?? "";
const repoName = (r: { project: string; slug: string }) => `${r.project}/${r.slug}`;
const reasonOf = (e: unknown) => oneLine(noUrl((e as Error).message)).slice(0, REASON_CHARS);

// SD6: the gitlinks (mode 160000 on either side) that base..head adds, removes, or moves, in path order. Without --no-abbrev, --raw
// gives short object IDs.
export async function movedGitlinks(cache: string, env: Record<string, string>, base: string, head: string, signal?: AbortSignal) {
  const out = await git([`--git-dir=${cache}`, "diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head], { env, signal });
  const parts = out.split("\0");
  const links: { path: string; old: string | null; new: string | null }[] = [];
  // diff-format(5): ":<old mode> <new mode> <old ID> <new ID> <status>" and then the path, each with a NUL at the end.
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) /.exec(parts[k] as string);
    if (!m || (m[1] !== "160000" && m[2] !== "160000")) continue;
    links.push({
      path: parts[k + 1] as string,
      old: m[1] === "160000" ? (m[3] as string) : null,
      new: m[2] === "160000" ? (m[4] as string) : null,
    });
  }
  return links.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Section 5.1. null: the change moves no gitlink (SD3), after one local git call. An abort of signal throws.
export async function submoduleContext(i: SubmoduleInput): Promise<SubmoduleContext | null> {
  const dataDir = longData(i.dataDir);
  const { env } = gitSetup(dataDir);
  const links = await movedGitlinks(i.cache, env, i.mergeBase, i.head, i.signal);
  if (!links.length) return null;
  const oldUrls = await gitmoduleUrls(i.cache, env, i.mergeBase);
  const newUrls = await gitmoduleUrls(i.cache, env, i.head);
  const entries: Entry[] = links.map((l) => ({
    ...l,
    oldUrl: oldUrls.get(l.path) ?? null,
    newUrl: newUrls.get(l.path) ?? null,
    outcome: "read",
    repo: null,
    prs: [],
    files: 0,
    cut: [],
    text: "",
    warn: false,
    prNotes: [],
  }));

  // ---------- REST reads: one PEER_READ_MS deadline for all of them, before any fetch (SD13) ----------
  const deadline = AbortSignal.any([i.signal, AbortSignal.timeout(PEER_READ_MS)]);
  // pr-context.ts loadPrContext: the same reason texts.
  const why = (e: unknown) =>
    deadline.aborted
      ? `the reads took longer than ${PEER_READ_MS / 1000} s`
      : e instanceof ForgeError
        ? `Bitbucket error ${e.kind}${e.status ? ` ${e.status}` : ""}`
        : "an error";
  const stop = (e: unknown) => {
    if (i.signal.aborted) throw e;
  };
  const r = i.reader;
  let main: Promise<RepoInfo> | undefined;
  let readable: Promise<RepoInfo[]> | undefined;
  const mapped: Entry[] = [];
  for (const e of entries) {
    i.signal.throwIfAborted();
    if (e.old === null) e.outcome = "added";
    else if (e.new === null) e.outcome = "removed";
    else if (e.newUrl === null) e.outcome = "no_url";
    // A gitlink without a URL at the merge base counts as a changed URL (section 5.2, row 4).
    else if (e.oldUrl === null || urlKey(e.oldUrl) !== urlKey(e.newUrl)) e.outcome = "url_changed";
    // Without a connection, no server host set exists for check 5.
    else if (!r) e.outcome = "no_connection";
    else {
      try {
        main ??= within(r.repository(i.project, i.repo), deadline);
        const info = await main;
        const reads = {
          repository: (project: string, repo: string) => within(r.repository(project, repo), deadline),
          readableRepos: () => within(r.readableRepos(), deadline),
        };
        // mapRepoUrl: one REPO_READ list for all entries.
        const listed = () => {
          readable ??= reads.readableRepos().then((l) => l.repos);
          return readable;
        };
        const m = await mapRepoUrl(reads, serverHosts(r, info), httpLink(info), e.newUrl, listed);
        if (m.otherServer) e.outcome = "other_server";
        else if (!m.info) e.outcome = "no_access";
        else if (mapped.length >= SUBMODULES_MAX) e.outcome = "capped";
        else {
          e.repo = { project: m.info.project, slug: m.info.slug };
          mapped.push(e);
        }
      } catch (err) {
        stop(err);
        // A private repository gives no 404 but auth or forbidden.
        const denied = err instanceof ForgeError && (err.kind === "auth" || err.kind === "forbidden" || err.kind === "not_found");
        e.outcome = denied ? "no_access" : "read_failed";
        e.why = why(err);
      }
    }
  }

  type Group = { project: string; slug: string; entries: Entry[]; base: string | null; remote: BranchRemote | null; error?: string };
  const groups = new Map<string, Group>();
  for (const e of mapped) {
    const repo = e.repo as { project: string; slug: string };
    const k = repoName(repo);
    const g = groups.get(k) ?? { ...repo, entries: [], base: null, remote: null };
    g.entries.push(e);
    groups.set(k, g);
  }
  const reader = r as SubmoduleReader;
  for (const g of groups.values()) {
    try {
      const b = await within(reader.defaultBranch(g.project, g.slug), deadline);
      g.base = REF.test(`refs/heads/${b}`) ? b : null;
    } catch (err) {
      stop(err);
    }
    for (const e of g.entries) {
      // Section 5.3: a stored row of any state, checked by a read. The read wins over the row.
      for (const row of i.db.query(STORED).all({ project: g.project, repo: g.slug, head: e.new }) as { pr_id: number }[]) {
        try {
          const p = await within(reader.getPullRequest({ project: g.project, repo: g.slug, id: row.pr_id }), deadline);
          if (p.sourceHead === e.new) e.prs.push(p);
        } catch (err) {
          stop(err);
          e.prError ??= why(err);
        }
      }
      if (e.prs.length || !(i.peerReads ?? PEER_READS)) continue;
      try {
        const list = await within(reader.listOpenPullRequests(g.project, g.slug), deadline);
        e.prs.push(...list.items.filter((p) => p.sourceHead === e.new));
        if (!list.complete) e.prNotes.push(`Only the newest ${OPEN_LISTED} open pull requests were checked.`);
      } catch (err) {
        stop(err);
        e.prError ??= why(err);
      }
    }
    try {
      g.remote = await within(i.remote(g.project, g.slug), deadline);
    } catch (err) {
      stop(err);
      g.error = reasonOf(err);
    }
  }

  // ---------- Fetches (SD11) and the facts of each range ----------
  const long = { signal: i.signal, timeoutMs: i.timeoutMs };
  for (const g of groups.values()) {
    const cache = cachePath(dataDir, { project: g.project, repo: g.slug, id: 0 });
    const gc = (args: string[]) => git([`--git-dir=${cache}`, ...args], { env, ...long });
    const has = (c: string) =>
      gc(["cat-file", "-e", `${c}^{commit}`]).then(
        () => true,
        (err) => {
          stop(err);
          return false;
        },
      );
    const started = Date.now();
    const remote = g.remote;
    // null: the fetch worked. A refspec list is never empty: `git fetch <url>` alone fetches the remote HEAD.
    const fetch = async (refspecs: string[], prune = false) => {
      try {
        await fetchInto(dataDir, g.project, g.slug, remote as BranchRemote, refspecs, long, prune);
        return null;
      } catch (err) {
        stop(err);
        // A time limit is no refusal of the PR refs. A second fetch would take as long.
        if (err instanceof WorkspaceError && err.stopped) throw new Stopped(reasonOf(err));
        return reasonOf(err);
      }
    };
    // ended: no remote, or a fetch hit the time limit, so no path is read. failed: the reason of the step 3 fetch. A refused step 1 or 2
    // only leads to the next step.
    let ended: string | null = remote ? null : (g.error ?? "no remote");
    let failed: string | null = null;
    let baseOk = false;
    if (!ended)
      try {
        // Each matched PR has the new commit as its head, so one PR ref per path is enough.
        const prs = [...new Map(g.entries.flatMap((e) => e.prs.slice(0, 1)).map((p) => [p.ref.id, p])).values()];
        const base = g.base ? [`+refs/heads/${g.base}:${SUB}/base`] : [];
        const first = [...base, ...prs.map((p) => `+refs/pull-requests/${p.ref.id}/from:${SUB}/pr/${p.ref.id}`)];
        let refused = first.length ? await fetch(first) : null;
        // BRIEF 10.2: a server can refuse the PR refs. The source branch by name is the fallback. A fork PR has its branch in another
        // repository, so it gets none.
        if (refused && prs.length) {
          const own = prs.filter((p) => !p.sourceRepo || (p.sourceRepo.project === g.project && p.sourceRepo.repo === g.slug));
          const named = own.filter((p) => REF.test(`refs/heads/${p.sourceBranch}`));
          const second = [...base, ...named.map((p) => `+refs/heads/${p.sourceBranch}:${SUB}/pr/${p.ref.id}`)];
          if (second.length) refused = await fetch(second);
        }
        baseOk = first.length > 0 && !refused && base.length > 0;
        let missing = false;
        for (const e of g.entries) if (!(await has(e.new as string)) || !(await has(e.old as string))) missing = true;
        if (missing) failed = await fetch([`+refs/heads/*:${SUB}/heads/*`], true);
      } catch (err) {
        if (!(err instanceof Stopped)) throw err;
        ended = err.message;
      }
    const fetchMs = Date.now() - started;
    for (const e of g.entries) {
      e.fetchMs = fetchMs;
      const missing = ended ? null : !(await has(e.new as string)) ? "new_missing" : !(await has(e.old as string)) ? "old_missing" : null;
      if (ended || (missing && failed)) {
        e.outcome = "fetch_failed";
        e.why = ended ?? failed ?? "";
      } else if (missing) e.outcome = missing;
      else e.facts = await facts(gc, e.old as string, e.new as string, baseOk ? g.base : null, cache, env, i.signal);
    }
  }

  const file = entries.some((e) => e.outcome === "read") ? fileText(entries, i.peerReads ?? PEER_READS) : null;
  for (const e of entries) {
    e.text = lineText(e);
    // Section 5.6: the "not read" and "on no branch" parts.
    e.warn = e.outcome === "read" ? e.prs.length === 0 && e.prError !== undefined : e.outcome !== "added" && e.outcome !== "removed";
  }
  return {
    reads: entries.map(({ why: _w, prNotes: _n, prError: _p, fetchMs: _f, facts: _x, ...rest }) => rest),
    file,
    gitlinks: new Map(entries.map((e) => [e.path, { old: e.old, new: e.new }])),
    related: entries.map((e) => ({ label: SUBMODULE_LABEL, text: e.text, warn: e.warn })),
    log: entries.map((e) =>
      e.outcome === "read"
        ? `${oneLine(e.path)} read (${repoName(e.repo as { project: string; slug: string })}${e.prs.length === 1 ? ` PR #${e.prs[0]?.ref.id}` : ""}, ${e.files} files, fetch ${((e.fetchMs ?? 0) / 1000).toFixed(1)} s)`
        : e.text,
    ),
  };
}

class Stopped extends Error {}

// SD15 and SD16: the facts of old..new in the submodule cache.
async function facts(
  gc: (args: string[]) => Promise<string>,
  old: string,
  head: string,
  base: string | null,
  cache: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<Facts> {
  // git-rev-list(1) --left-right --count A...B: the commits of A only, then of B only.
  const [left = 0, right = 0] = (await gc(["rev-list", "--left-right", "--count", `${old}...${head}`])).trim().split(/\s+/).map(Number);
  const direction =
    left === 0
      ? "The new commit follows the old one."
      : right === 0
        ? `The new commit goes back ${left} commits.`
        : "The new commit is on another line of history.";
  const commits = right
    ? (await gc(["log", "-z", "--no-decorate", "--abbrev=12", "--format=%h %s", `-n${SUBMODULE_COMMITS_SHOWN}`, `${old}..${head}`]))
        .split("\0")
        .filter(Boolean)
        .map(oneLine)
    : [];
  const onBase = base === null ? null : Number((await gc(["rev-list", "--count", `${SUB}/base..${head}`])).trim()) === 0;
  // With -z, a rename gives "<add>\t<del>\t" and then the old and the new path, each with a NUL at the end.
  const parts = (await gc(["diff", "--numstat", "-z", ...diffArgs, old, head])).split("\0");
  const files: Facts["files"] = [];
  for (let k = 0; k < parts.length; k++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[k] as string);
    if (!m) continue;
    let path = m[3] as string;
    if (path === "") {
      path = parts[k + 2] ?? "";
      k += 2;
    }
    files.push({ path, add: m[1] as string, del: m[2] as string });
  }
  // SD18: depth 1 only.
  const nested = (await movedGitlinks(cache, env, old, head, signal)).map((l) => l.path);
  const diff = await gc(["diff", ...diffArgs, old, head]);
  return { direction, count: right, commits, onBase, base, files, nested, diff };
}

// The file sections of git diff output, each from its "diff --git" line.
function chunks(diff: string): string[] {
  const at: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(diff); m; m = re.exec(diff)) at.push(m.index);
  return at.map((s, k) => diff.slice(s, at[k + 1]));
}

// The path of one file section, from its header only.
function chunkPath(c: string): string {
  const hunk = c.indexOf("\n@@ ");
  const f = parseDiff(hunk < 0 ? c : c.slice(0, hunk + 1))[0];
  return f?.path ?? f?.oldPath ?? "";
}

const list = (items: string[], total: number, sep: string) =>
  `${[...items, ...(total > items.length ? [`... ${total - items.length} more`] : [])].join(sep)}.`;

function prLines(e: Entry, peerReads: boolean): string[] {
  const p = e.prs[0];
  if (e.prs.length > 1)
    return [`- ${e.prs.length} pull requests have this commit as their head: ${e.prs.map((x) => `#${x.ref.id}`).join(", ")}.`];
  if (!p) {
    if (e.prError) return [`- Pull request: not read (${e.prError}).`];
    const notes = [...(peerReads ? [] : ["Only pull requests in your inbox were checked."]), ...e.prNotes];
    return [["- No pull request has this commit as its head.", ...notes].join(" ")];
  }
  const out = [
    `- Pull request #${p.ref.id} "${oneLine(p.title)}" by ${oneLine(p.author.name || p.author.slug)}, ${p.state.toLowerCase()}, from ${oneLine(p.sourceBranch)} into ${oneLine(p.targetBranch)}. Its head is the new commit.`,
  ];
  const d = p.description?.trim() ?? "";
  if (d) {
    const cut = size(d) > DESCRIPTION_BYTES;
    out.push(
      cut ? `- Description (the first ${DESCRIPTION_BYTES / 1024} KB):` : "- Description:",
      "",
      indentBlock(cut ? cutBytes(d, DESCRIPTION_BYTES) : d),
      "",
    );
  }
  return out;
}

// The summary of one entry, without the line "Not in the diff below", which goes before tail. null: the file does not list the entry.
function summary(e: Entry, peerReads: boolean): { lines: string[]; tail: string[] } | null {
  const path = oneLine(e.path);
  const one = (line: string) => ({ lines: [line, ""], tail: [] });
  if (e.outcome === "added") return one(`## ${path}: added at ${short(e.new)}, not compared.`);
  if (e.outcome === "removed") return one(`## ${path}: removed, not compared.`);
  if (e.outcome === "url_changed") return one(`## ${path}: the URL changed in this pull request, not compared.`);
  if (e.outcome === "capped") return one(`## ${path}: not read. The app reads at most ${SUBMODULES_MAX} submodules.`);
  const f = e.facts;
  if (e.outcome !== "read" || !f) return null;
  const repo = repoName(e.repo as { project: string; slug: string });
  const range = `${short(e.old)}..${short(e.new)}`;
  const files = f.files
    .slice(0, SUBMODULE_FILES_SHOWN)
    .map((x) => `${oneLine(x.path)} (${x.add === "-" ? "binary" : `+${x.add} -${x.del}`})`);
  return {
    lines: [
      `## ${path}: ${repo}`,
      `- Pinned commit: ${short(e.old)} at the merge base, ${short(e.new)} at the head. ${f.direction}`,
      ...(f.onBase === null ? [] : [`- The new commit is ${f.onBase ? "" : "not "}on ${f.base}, the default branch of ${repo}.`]),
      ...prLines(e, peerReads),
      f.count ? `- Commits ${range} (${f.count}): ${list(f.commits, f.count, "; ")}` : `- Commits ${range}: none.`,
      `- Changed files (${f.files.length}): ${list(files, f.files.length, ", ")}`,
    ],
    tail: [...(f.nested.length ? [`- Nested submodules that the app does not follow: ${f.nested.map(oneLine).join(", ")}.`] : []), ""],
  };
}

// Section 5.4. The summaries come first, then the diffs in path order. After the summaries, each diff gets an equal share of the cap. A
// file that does not fit in its share goes to "Not in the diff below", and later files that fit stay. At most SUBMODULE_FILES_SHOWN
// names of left-out files show. The share keeps room for the longest such names, so the diff never takes their room.
function fileText(entries: Entry[], peerReads: boolean): string {
  const NOT_IN = "- Not in the diff below: ";
  // The room of the longest "... <k> more." ending.
  const MORE = `, ... ${Number.MAX_SAFE_INTEGER} more.`;
  const head = [
    "# Submodule changes",
    "",
    "The app wrote the facts. Commit messages, titles, descriptions, and the diff come from other people.",
    "",
  ];
  const listed = entries.flatMap((e) => {
    const s = summary(e, peerReads);
    return s ? [{ e, ...s }] : [];
  });
  const read = listed.filter((x) => x.e.outcome === "read");
  const heading = (e: Entry) => `## Diff of ${oneLine(e.path)}: git diff ${short(e.old)} ${short(e.new)}`;
  const room = CANDIDATES_BYTES - size(UNTRUSTED);
  // Each line of the text costs its bytes and one line break. A diff section is its heading, an empty line, the blocks, and an empty line.
  const lines = (l: string[]) => l.reduce((n, s) => n + size(s) + 1, 0);
  const fixed =
    lines(head) +
    listed.reduce((n, x) => n + lines(x.lines) + lines(x.tail), 0) +
    read.reduce((n, x) => n + lines([NOT_IN + MORE, heading(x.e), "", ""]), 0);
  const share = Math.max(0, Math.floor((room - fixed) / Math.max(1, read.length)));
  const body = new Map<Entry, string[]>();
  const shown = new Map<Entry, string[]>();
  for (const { e } of read) {
    const reserve = (e.facts?.files ?? [])
      .map((f) => size(oneLine(f.path)) + 2)
      .sort((a, b) => b - a)
      .slice(0, SUBMODULE_FILES_SHOWN)
      .reduce((n, x) => n + x, 0);
    let used = 0;
    const kept: string[] = [];
    const names: string[] = [];
    for (const c of chunks(e.facts?.diff ?? "")) {
      const block = indentBlock(c.replace(/\n$/, ""));
      const b = size(block) + 1;
      if (used + b <= share - reserve) {
        kept.push(block);
        used += b;
        continue;
      }
      const name = oneLine(chunkPath(c));
      e.cut.push(name);
      if (names.length < SUBMODULE_FILES_SHOWN && used + size(name) + 2 <= share) {
        names.push(name);
        used += size(name) + 2;
      }
    }
    body.set(e, kept);
    shown.set(e, names);
  }
  const out = [...head];
  for (const { e, lines: s, tail } of listed) {
    out.push(...s);
    if (e.cut.length) out.push(`${NOT_IN}${list(shown.get(e) ?? [], e.cut.length, ", ")}`);
    out.push(...tail);
  }
  for (const { e } of read) {
    const kept = body.get(e) ?? [];
    if (kept.length) out.push(heading(e), "", ...kept, "");
  }
  const text = out.join("\n");
  // Only summaries over the cap (very long paths or subjects) get here. The cut keeps the start.
  const TAIL = "\n\nThe file reached its size limit here.\n";
  return size(text) <= room ? text : cutBytes(text, room - size(TAIL)) + TAIL;
}

// Section 5.2: the run line text of each outcome.
function lineText(e: Entry): string {
  const path = oneLine(e.path);
  const repo = e.repo ? repoName(e.repo) : "";
  switch (e.outcome) {
    case "added":
      return `${path}: added, not compared`;
    case "removed":
      return `${path}: removed`;
    case "no_url":
      return `${path}: not read (no URL in .gitmodules)`;
    case "url_changed":
      return `${path}: not read (the URL changed in this pull request)`;
    case "other_server":
      return `${path}: not read (another server)`;
    case "no_connection":
      return `${path}: not read (no Bitbucket connection)`;
    case "no_access":
      return `${path}: not read (no read access, or no such repository)`;
    case "read_failed":
      return `${path}: not read (${e.why})`;
    case "capped":
      return `${path}: not read (the app reads at most ${SUBMODULES_MAX} submodules)`;
    case "fetch_failed":
      return `${path}: not read (fetch failed: ${e.why})`;
    case "new_missing":
      return `${path}: ${repo}: commit ${short(e.new)} is on no branch`;
    case "old_missing":
      return `${path}: ${repo}: the old commit ${short(e.old)} is on no branch`;
    case "read": {
      e.files = e.facts?.files.length ?? 0;
      const cut = e.cut.length ? ", cut" : "";
      const p = e.prs[0];
      if (e.prs.length > 1) return `${path}: ${repo} PRs ${e.prs.map((x) => `#${x.ref.id}`).join(", ")}, ${e.files} files${cut}`;
      if (p) return `${path}: ${repo} PR #${p.ref.id} (${p.state.toLowerCase()}), ${e.files} files${cut}`;
      const range = `${short(e.old)}..${short(e.new)}, ${e.files} files`;
      if (e.prError) return `${path}: ${repo} ${range}, pull request not read (${e.prError})${cut}`;
      return `${path}: ${repo} ${range}, no pull request found${cut}`;
    }
  }
}
