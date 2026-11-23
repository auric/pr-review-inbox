// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The words of the Notes block (docs/plans/review-v2/spec.md section 2.7). No DOM access, so bun test runs them directly.
import type { NoteDto, NoteRef } from "../../shared/dto";
import { foldCase } from "../../shared/me";
import { parsePrUrl } from "../../shared/pr-url";
import type { ThreadModel } from "./threads";

const STATE: Record<NonNullable<NoteRef["state"]>, string> = { OPEN: "open", MERGED: "merged", DECLINED: "declined", MISSING: "not found" };

type Own = { project: string; repo: string };
// The forge ignores case in project keys and repository slugs.
const sameRepo = (r: Own, own: Own) => foldCase(r.project) === foldCase(own.project) && foldCase(r.repo) === foldCase(own.repo);

// "PR #45 merged". own: the repository of this PR. A link to another repository names it.
export function chipText(r: NoteRef, own: Own): string {
  const name = sameRepo(r, own) ? `#${r.prId}` : `${r.project}/${r.repo}#${r.prId}`;
  return `PR ${name}${r.state ? ` ${STATE[r.state]}` : ""}`;
}

export const THREAD_DELETED = "The thread was deleted.";

// "From the thread of Anna on src/build.ts line 40". A thread without a live message is deleted. null: the note names no thread.
export function fromText(n: Pick<NoteDto, "thread">, threads: readonly ThreadModel[]): string | null {
  if (n.thread === null) return null;
  const t = threads.find((x) => x.id === n.thread);
  if (!t?.last) return THREAD_DELETED;
  const at = t.anchor ? ` on ${t.anchor.path}${t.anchor.line ? ` line ${t.anchor.line}` : ""}` : "";
  return t.root.who.me ? `From your thread${at}` : `From the thread of ${t.root.who.name}${at}`;
}

// The "Waits for PR" field. project and repo are absent for a PR of this repository.
export type WaitsFor = { prId: number; project?: string; repo?: string };
export const WAITS_HELP = "A number, such as 45, PROJ/repo#45, or a PR link.";
export const WAITS_BAD = "Write a PR number, such as 45, PROJ/repo#45, or a PR link.";
export const WAITS_NO_SERVER = "Connect the server in Settings to use a PR link.";
export const WAITS_OTHER_SERVER = "The link is for another server. Use a PR of the connected server.";

// The text of the field for a stored link.
export const waitsText = (r: Pick<NoteRef, "project" | "repo" | "prId"> | null, own: Own): string =>
  r === null ? "" : sameRepo(r, own) ? String(r.prId) : `${r.project}/${r.repo}#${r.prId}`;

const id = (s: string) => (Number.isSafeInteger(Number(s)) && Number(s) > 0 ? Number(s) : null);

// Accepts "45", "#45", "PROJ/repo#45", or a PR web link of baseUrl. ref null: the field is empty.
export function parseWaitsFor(input: string, own: Own, baseUrl: string | null): { ref: WaitsFor | null } | { error: string } {
  const t = input.trim();
  if (!t) return { ref: null };
  let r: { project: string; repo: string; prId: number } | null = null;
  const num = t.match(/^#?(\d+)$/);
  const full = t.match(/^([^\s/\\?#%]+)\/([^\s/\\?#%]+)#(\d+)$/);
  if (num?.[1]) {
    const prId = id(num[1]);
    return prId === null ? { error: WAITS_BAD } : { ref: { prId } };
  }
  if (full?.[1] && full[2] && full[3]) {
    const prId = id(full[3]);
    if (prId === null) return { error: WAITS_BAD };
    r = { project: full[1], repo: full[2], prId };
  } else if (/^https?:\/\//i.test(t)) {
    if (!baseUrl) return { error: WAITS_NO_SERVER };
    try {
      if (new URL(t).origin !== new URL(baseUrl).origin) return { error: WAITS_OTHER_SERVER };
      const u = parsePrUrl(t, baseUrl);
      if (id(String(u.id)) === null) return { error: WAITS_BAD };
      r = { project: u.project, repo: u.repo, prId: u.id };
    } catch {
      return { error: WAITS_BAD };
    }
  } else return { error: WAITS_BAD };
  return { ref: sameRepo(r, own) ? { prId: r.prId } : r };
}
