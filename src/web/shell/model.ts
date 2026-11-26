// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure list and sidebar rules. No DOM access, so bun test runs them directly.

import type { CheckpointDto, CheckpointReason, Group, PrRow, PrTask, SyncStatus, TaskSource } from "../../shared/dto";
import { parsePrUrl } from "../../shared/pr-url";
import type { PrRef } from "../../shared/types";
import { GROUPS, VIEW_LABEL, VIEWS, type View } from "../../shared/views";

export const repoOf = (p: Pick<PrRow, "project" | "repo">) => `${p.project}/${p.repo}`;
export const prKey = (p: Pick<PrRow, "project" | "repo" | "prId">) => `${repoOf(p)} #${p.prId}`;

// forge: the product name from GET /api/meta.
export function reasonLabel(forge: string): Record<CheckpointReason, string> {
  return {
    network: `no answer from ${forge}`,
    timeout: `${forge} timed out`,
    auth: `${forge} rejected the token`,
    forbidden: "no access",
    not_found: `not found on ${forge}`,
    rate: "rate limited",
    server: `${forge} server error`,
    shape: "unexpected response",
    cursor: "paging stopped early",
    page_limit: "too many pages",
    gap: "a comment is missing from the activities",
  };
}

// null when the last check of this PR was complete.
export function incompleteText(c: CheckpointDto | null, forge: string): string | null {
  return c?.reason ? `Last check incomplete: ${reasonLabel(forge)[c.reason]}` : null;
}

export function viewCounts(prs: PrRow[]): Record<View, number> {
  const out = { needs: 0, reviewing: 0, mine: 0, following: 0 };
  for (const p of prs) for (const v of Object.keys(VIEWS) as View[]) if (VIEWS[v](p)) out[v]++;
  return out;
}

export type RepoCount = { key: string; repo: string; unread: number };
export type ProjectRepos = { project: string; repos: RepoCount[] };

// prototype/v3 renderSide(): repositories under their project, both in name order.
export function repoTree(prs: PrRow[]): ProjectRepos[] {
  const m = new Map<string, Map<string, number>>();
  for (const p of prs) {
    const repos = m.get(p.project) ?? new Map<string, number>();
    repos.set(p.repo, (repos.get(p.repo) ?? 0) + p.unread);
    m.set(p.project, repos);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  return [...m.keys()].sort(byName).map((project) => ({
    project,
    repos: [...(m.get(project) ?? [])]
      .sort(([a], [b]) => byName(a, b))
      .map(([repo, unread]) => ({ key: `${project}/${repo}`, repo, unread })),
  }));
}

export const unreadTotal = (prs: PrRow[]) => prs.reduce((n, p) => n + p.unread, 0);

// The filter text also matches task IDs.
export function matches(p: PrRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return (
    !needle || [p.title, prKey(p), p.authorName, p.authorSlug, ...p.tasks.map((t) => t.key)].some((s) => s?.toLowerCase().includes(needle))
  );
}

// prototype/v3 listRows(): a repository replaces the view.
export function filterRows(prs: PrRow[], view: View, repo: string | null, q: string): PrRow[] {
  return prs.filter((p) => (repo ? repoOf(p) === repo : VIEWS[view](p)) && matches(p, q));
}

// "flat": the one list of the Review runs, Ready to post, and Archive views. Its label is empty, so the list shows no group head.
export type ListGroup = { id: (typeof GROUPS)[number][0] | "flat"; label: string; rows: PrRow[] };

// prototype/v3 grouped(): the three inbox groups, without empty ones. Rows keep the given order.
// groupOf: the reason that places a row. A frozen list gives the reason at freeze time.
export function groupRows(rows: PrRow[], groupOf: (p: PrRow) => Group = (p) => p.group): ListGroup[] {
  return GROUPS.map(([id, label, groups]) => ({
    id,
    label,
    rows: rows.filter((p) => (groups as readonly string[]).includes(groupOf(p))),
  })).filter((g) => g.rows.length > 0);
}

// A list row as the user saw it: the PR and its inbox reason at that time.
export type Slot = { id: number; group: Group };

// The list order stays while the user works in it, so a read row does not move and the next row is not shown and read.
// Known rows keep their earlier place and reason. A new row goes after its predecessor in the server order. A row not in rows drops.
export function freezeOrder(prev: readonly Slot[], rows: PrRow[]): Slot[] {
  const ids = new Set(rows.map((p) => p.id));
  const out = prev.filter((s) => ids.has(s.id));
  const known = new Set(out.map((s) => s.id));
  rows.forEach((p, i) => {
    if (known.has(p.id)) return;
    const before = rows[i - 1];
    const at = before ? out.findIndex((s) => s.id === before.id) + 1 : 0;
    out.splice(at, 0, { id: p.id, group: p.group });
  });
  return out;
}

// The rows that change place or group when the list sorts again: all rows outside the longest common order of both layouts.
export function movedCount(shown: ListGroup[], server: ListGroup[]): number {
  const keys = (gs: ListGroup[]) => gs.flatMap((g) => g.rows.map((p) => `${g.id}:${p.id}`));
  const a = keys(shown);
  const b = keys(server);
  const at = new Map(a.map((k, i) => [k, i]));
  // Patience sort: tails[n] is the smallest last index of a rising run of length n + 1.
  const tails: number[] = [];
  for (const k of b) {
    const i = at.get(k);
    if (i === undefined) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((tails[mid] ?? 0) < i) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = i;
  }
  return Math.max(a.length, b.length) - tails.length;
}

// prototype/v3 orderedRows(): j and k skip the rows of the folded Done group.
export const navIds = (groups: ListGroup[], doneOpen: boolean): number[] =>
  groups.flatMap((g) => (g.id === "done" && !doneOpen ? [] : g.rows.map((p) => p.id)));

// The why-line of a row (prototype/v3 why()). turn "wait" is an icon whose label is the turn text.
export type Why = {
  // D1: a closed PR names its state first, in every group.
  closed: string | null;
  turn: { kind: "your" | "wait"; text: string } | null;
  // Bold words, then plain text.
  lead: string | null;
  text: string | null;
};

const CLOSED: Record<string, string> = { MERGED: "Merged.", DECLINED: "Declined." };

export function why(p: PrRow, now: number): Why {
  const out: Why = { closed: CLOSED[p.state ?? ""] ?? null, turn: null, lead: null, text: null };
  const quote = p.cause && `${p.cause.author}: ${p.cause.snippet}`;
  switch (p.group) {
    case "your":
      return { ...out, turn: { kind: "your", text: p.yourTurn > 1 ? `Your turn in ${p.yourTurn} threads` : "Your turn" }, text: quote };
    case "triage":
      return { ...out, lead: "Drafts to triage." };
    case "review":
      return { ...out, lead: p.authorName ?? p.authorSlug ?? "The author", text: "asked for your review." };
    case "commits":
      // D3: M1 data holds no commit count and no commit message.
      return { ...out, lead: "New commits since your review." };
    case "comments":
      return { ...out, text: quote ?? "New messages." };
    case "waiting": {
      const when = p.waitSince === null ? null : ago(p.waitSince, now);
      // An own open PR waits without a "wait" thread (groupOf in src/server/inbox/queries.ts).
      const review = p.reviewers.length > 0 && p.reviewers.every((r) => r.status === "APPROVED") ? "Approved." : "Waiting for review.";
      const text =
        when === null
          ? p.role === "AUTHOR"
            ? review
            : "You replied last."
          : when === "now"
            ? "You replied last, just now."
            : `You replied last, ${when} ago.`;
      return { ...out, turn: { kind: "wait", text: "Waiting on others" }, text };
    }
    case "closed":
      return out;
    default:
      return { ...out, text: "No new messages." };
  }
}

// The why-line of an Archive row. Sync does not check the comments of these PRs.
export function archiveWhy(p: PrRow, now: number): Why {
  const out: Why = { closed: CLOSED[p.state ?? ""] ?? null, turn: null, lead: null, text: null };
  if (p.archivedAt === null) return { ...out, lead: "Not followed.", text: "Not on your dashboard, so not checked." };
  const when = ago(p.archivedAt, now);
  return { ...out, lead: when === "now" ? "Archived just now." : `Archived ${when} ago.`, text: "Not checked while archived." };
}

// Both actions follow the PR, which also clears archived_at. A followed PR only leaves the archive.
export const restoreWords = (p: Pick<PrRow, "archivedAt" | "followed">) =>
  p.archivedAt !== null && p.followed ? { verb: "Unarchive", done: "Unarchived" } : { verb: "Restore", done: "Restored" };

export const ARCHIVED_TEXT = "It moved to Archive. Restore it there at any time.";

// Plan m1: an unfollowed PR stays in its role view while it is on the dashboard (an OPEN review or my own PR).
export const unfollowText = (p: Pick<PrRow, "onDashboard" | "role">) =>
  p.onDashboard
    ? `It stays in ${VIEW_LABEL[p.role === "AUTHOR" ? "mine" : "reviewing"]} while it is on your dashboard. Then it moves to Archive.`
    : ARCHIVED_TEXT;

const SOURCE_WORD: Record<TaskSource, string> = { branch: "branch", title: "title", description: "description" };

// The tooltip of a task ID: the ID and the field that holds it.
export const taskHint = (t: Pick<PrTask, "key" | "source">) => `Task ${t.key}, from the ${SOURCE_WORD[t.source]}`;

// A filter text that is a PR URL on the configured origin. The server checks the origin again.
export function followCandidate(q: string, baseUrl: string | null): PrRef | null {
  if (!baseUrl || !/^https?:\/\//i.test(q.trim())) return null;
  try {
    return parsePrUrl(q.trim(), baseUrl);
  } catch {
    return null;
  }
}

export function initials(name: string | null): string {
  const words = (name ?? "").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0]}${words.at(-1)?.[0]}` : (words[0]?.slice(0, 2) ?? "?")).toUpperCase();
}

export function ago(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export type StatusInfo = { text: string; tone: "ok" | "busy" | "warn" | "error" | "idle" };

export function statusInfo(s: SyncStatus, now: number, forge: string): StatusInfo {
  if (s.running) return { text: "Checking…", tone: "busy" };
  const last = s.lastCompleteAt === null ? "never" : clock(s.lastCompleteAt);
  switch (s.state) {
    case "ok":
      return { text: `Checked ${last}`, tone: "ok" };
    case "offline": {
      const next = s.nextAt === null ? "" : ` Next try in ${Math.max(0, Math.ceil((s.nextAt - now) / 1000))} s.`;
      return { text: `Offline. Last checked ${last}.${next}`, tone: "warn" };
    }
    case "auth":
      return { text: `${forge} rejected the token`, tone: "error" };
    case "unconfigured":
      return { text: "Not configured", tone: "idle" };
    case "error":
      return { text: s.error ?? "Check failed", tone: "error" };
    default:
      return { text: "Waiting for the first check", tone: "idle" };
  }
}

// The description of a failure toast: the error, then the next step. where: the view to reload. The error of a stale session
// (data.ts ApiError) already says "Reload the page", and a new try fails again, so it gets no step.
export function failText(e: unknown, where: "pull request" | "page" = "pull request"): string {
  const m = (e instanceof Error ? e.message : String(e)).trim();
  if ((e as { stale?: unknown } | null)?.stale === true) return m;
  return `${m}${m && !/[.!?]$/.test(m) ? "." : ""} Try again, or reload the ${where}.`.trim();
}
