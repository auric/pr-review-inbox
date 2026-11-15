// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fix run validator (plan r3 S-FIX). Pure: the caller reads each edit path at the source head S of the run.
import { oneLine } from "../../shared/consult";
import type { DiffRowDto } from "../../shared/dto";
import { type Coverage, type FixNote, type FixResult, type FixThread, MAX_FIX_BYTES } from "../../shared/review";
import { deniedPath, editRows, type Located, locate, overlaps, prepareFile } from "./edits";
import { MAX_FILE_CHARS, repoPath } from "./validate";

// The tree entry of one edit path at S, keyed by repoPath(). A path without an entry is absent at S.
// blocked: a folder, or a path below a file. size: a blob above MAX_FILE_CHARS bytes.
export type FixFile = { mode: string; bytes: Uint8Array } | "blocked" | "size";

// ord: the index of the edit in the result. Exactly one of thread and finding is set.
export type ValidEdit = Located & { ord: number; thread: number | null; finding: number | null; path: string; rows: DiffRowDto[] };
// added: the lines that the app added to coverage.skipped. Only they make the run incomplete.
export type ValidatedFix = { summary: string; coverage: Coverage; threads: FixNote[]; edits: ValidEdit[]; added: string[] };
// The threads and the findings that the run asked for.
export type FixRequest = { threads: readonly number[]; findings: readonly number[] };

const PROBLEMS: Record<string, string> = {
  link: "the path is a link or a submodule",
  binary: "the file is binary",
  encoding: "the file is not UTF-8",
  lfs: "the file is a Git LFS pointer",
  absent: "the file does not exist at the head commit",
  exists: "old is empty, but the file exists",
  match: "old does not match the file",
  matches: "old matches more than one place",
};

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

type Target = { key: string; kind: "thread" | "finding" };
// docs/plans/fix-ux.md WP3: a note or an edit names exactly one thread or one finding. Returns the drop reason otherwise.
function targetOf(x: { thread?: number; finding?: number }): Target | string {
  if (x.thread !== undefined && x.finding !== undefined) return `it names both thread ${x.thread} and finding ${x.finding}`;
  if (x.thread !== undefined) return { key: `thread ${x.thread}`, kind: "thread" };
  if (x.finding !== undefined) return { key: `finding ${x.finding}`, kind: "finding" };
  return "it names no thread and no finding";
}

// Only requested threads and findings pass. Every drop, every target without a note, and every fixed note without a valid edit go to coverage.skipped.
// docs/plans/thread-outcome.md: a fixed note without a valid edit stays, with why "dropped" and the drop reasons of its edits.
export function validateFix(result: FixResult, requested: FixRequest, files: ReadonlyMap<string, FixFile>): ValidatedFix {
  const byNumber = (a: number, b: number) => a - b;
  const order = [
    ...new Set([
      ...[...requested.threads].sort(byNumber).map((t) => `thread ${t}`),
      ...[...requested.findings].sort(byNumber).map((f) => `finding ${f}`),
    ]),
  ];
  const wanted = new Set(order);
  const skipped: string[] = [];
  const notes = new Map<string, FixThread>();
  for (const [i, t] of result.threads.entries()) {
    const at = targetOf(t);
    if (typeof at === "string") {
      skipped.push(`Note ${i + 1} dropped: ${at}.`);
      continue;
    }
    const why = !wanted.has(at.key) ? `the ${at.kind} was not requested` : notes.has(at.key) ? `a second note for the ${at.kind}` : null;
    if (why) skipped.push(`Note for ${at.key} dropped: ${why}.`);
    else notes.set(at.key, t);
  }

  const edits: ValidEdit[] = [];
  const edited = new Set<string>();
  let bytes = 0;
  const check = (e: FixResult["edits"][number], at: Target, ord: number): string | null => {
    if (!wanted.has(at.key)) return `the ${at.kind} was not requested`;
    if (!notes.has(at.key)) return `the ${at.kind} has no note`;
    const path = repoPath(e.path);
    if (path === null) return "the path is not a repository path";
    if (deniedPath(path)) return "the app never edits this path";
    const f = files.get(path);
    if (f === "blocked") return "the path is a folder or lies below a file";
    if (f === "size") return `the file is larger than ${MAX_FILE_CHARS} bytes`;
    let text: string | null = null;
    if (f) {
      const p = prepareFile(f.bytes, f.mode);
      if ("problem" in p) return PROBLEMS[p.problem] as string;
      text = p.text;
    }
    const loc = locate(text, e.old, e.new);
    if ("problem" in loc) return PROBLEMS[loc.problem] as string;
    if (text !== null && loc.old === loc.new) return "the edit changes nothing";
    const other = edits.find((x) => x.path === path && overlaps(x, loc));
    if (other) return `the edit overlaps edit ${other.ord + 1}`;
    const size = utf8(loc.old) + utf8(loc.new);
    if (bytes + size > MAX_FIX_BYTES) return `the edits exceed ${MAX_FIX_BYTES} bytes`;
    bytes += size;
    edits.push({ ...loc, ord, thread: e.thread ?? null, finding: e.finding ?? null, path, rows: editRows(text ?? "", loc) });
    edited.add(at.key);
    return null;
  };
  const drops = new Map<string, string[]>();
  for (const [ord, e] of result.edits.entries()) {
    const at = targetOf(e);
    const why = typeof at === "string" ? at : check(e, at, ord);
    const label = typeof at === "string" ? oneLine(e.path) : `${at.key}, ${oneLine(e.path)}`;
    if (!why) continue;
    const line = `Edit ${ord + 1} (${label}) dropped: ${why}.`;
    skipped.push(line);
    if (typeof at !== "string") drops.set(at.key, [...(drops.get(at.key) ?? []), line]);
  }

  const threads: FixNote[] = [];
  for (const key of order) {
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    const note = notes.get(key);
    if (!note) skipped.push(`${name} has no note.`);
    else if (note.fixed && !edited.has(key)) {
      skipped.push(`${name} has no valid edit.`);
      threads.push({ ...note, why: "dropped", drops: drops.get(key) ?? [] });
    } else threads.push(note);
  }
  return {
    summary: result.summary,
    coverage: { ...result.coverage, skipped: [...result.coverage.skipped, ...skipped] },
    threads,
    edits,
    added: skipped,
  };
}
