// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { branchPrefixList, MAX_TASK_RULES, settingsInput, taskRuleInput } from "../shared/dto";
import { log } from "./log";
import { type Profile, type ProfileEdits, resolveProfiles, SPARSE_VERSION, storeProfiles } from "./review/catalog";

// No secret goes into this file.
const config = z.object({
  baseUrl: z.string(),
  userSlug: z.string(),
  caFile: z.string().optional(),
  notifications: z.boolean(),
  // Absent: on. Posts built from AI items start with AI_MARK (src/server/publish/plan.ts).
  markAi: z.boolean().optional(),
  // Absent: on. Posted findings start with their severity in bold (src/server/publish/plan.ts).
  markSeverity: z.boolean().optional(),
  // Absent: DEFAULT_TASK_RULES (src/server/tasks/rules.ts).
  taskRules: z
    .array(taskRuleInput.extend({ timedOut: z.boolean().optional() }))
    .max(MAX_TASK_RULES)
    .optional(),
  taskLink: z.string().optional(),
  // A broken value reads as absent, so the rest of the config stays in use.
  // Absent: 60 s.
  checkSeconds: settingsInput.shape.checkSeconds.catch(undefined),
  // Absent: SHIPPED_PROFILES (src/server/review/catalog.ts). From PROFILES_VERSION 7, a shipped profile keeps only its edited fields
  // (catalog.ts storeProfiles). readConfig gives full profiles.
  profiles: z.array(z.unknown()).optional().catch(undefined),
  // Absent: a config from before PROFILES_VERSION. settings.ts upgrades the unedited fields of its shipped profiles.
  profilesVersion: z.number().optional().catch(undefined),
  // Absent: no Jira connection. The Jira token lives in the secret store under "jira-token".
  jira: z.object({ baseUrl: z.string(), caFile: z.string().optional() }).optional().catch(undefined),
  // Absent: off. On: each run reads the global CLAUDE.md of the Claude config folder (src/server/review/instructions.ts).
  globalInstructions: z.boolean().optional().catch(undefined),
  // Absent: off. On: "Ask your session" lists the transcripts of the Claude config folder (src/server/review/sessions.ts).
  sessions: z.boolean().optional().catch(undefined),
  // Absent: on. Off: the user acknowledged the company AI policy for task attachments, so "Include in runs" does not ask.
  askAttachments: z.boolean().optional().catch(undefined),
  // Absent: DEFAULT_BRANCH_PREFIXES (src/shared/task.ts).
  taskBranchPrefixes: branchPrefixList.optional().catch(undefined),
});

// profiles: full profiles. profileEdits: the shipped hash of each edited field of a shipped profile (catalog.ts ProfileEdits).
export type Config = Omit<z.infer<typeof config>, "profiles"> & { profiles?: Profile[]; profileEdits?: ProfileEdits };

// Version 2: the shipped turn caps went from 40 and 12 to 100 and 50.
// Version 3: General and Security got language checks. General and Over-engineering got new prompts.
// Version 4: no shipped value changed. The upgrade goes field by field, so profiles with other edits also get the version 3 values.
// Version 5: review v2 (docs/plans/review-v2/spec.md section 1.2). General became Review with modules, a volume, a verify phase, and
// efforts. Unedited Security and Over-engineering profiles retire.
// Version 6: Explain this PR (spec.md section 3). Explain got the walkthrough prompt, a note, effort medium, and a turn cap of 60.
// Version 7: no shipped value changed. A shipped profile stores only its edited fields, so the other fields follow each later shipped
// value without a version bump. The conversion drops each field that the upgrade finds unedited.
export const PROFILES_VERSION = SPARSE_VERSION;

export function dataDir(): string {
  const env = process.env;
  if (env.REVIEW_LOOP_DATA_DIR) return env.REVIEW_LOOP_DATA_DIR;
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "review-loop");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "review-loop");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "review-loop");
}

// A copy of config.json before the app drops a part of it. The next save writes the file without that part.
// An older copy with other text stays: the copy goes to the first free name config.json.bak, config.json.1.bak, and so on.
const MAX_BACKUPS = 100;
function backup(dir: string, text: string): string | null {
  for (let i = 0; i < MAX_BACKUPS; i++) {
    const file = join(dir, i ? `config.json.${i}.bak` : "config.json.bak");
    if (!existsSync(file)) {
      writeFileSync(file, text);
      return file;
    }
    if (readFileSync(file, "utf8") === text) return file;
  }
  return null;
}

const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const jsonOf = (text: string | null): unknown => {
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

// config.json.prev: the last good text before a direct write (writeConfig). It replaces a missing, empty, or broken config.json.
export function readConfig(dir: string): Config | null {
  const text = readText(join(dir, "config.json"));
  const kept = (what: string, from = "config.json") => {
    let copy: string | null = null;
    try {
      copy = text ? backup(dir, text) : null;
    } catch (e) {
      log(`Could not copy config.json in ${dir}: ${(e as Error).message}`);
    }
    log(`Ignored ${what} in ${from} in ${dir}. ${copy ? `The original file is in ${copy}.` : "No copy was made."}`);
  };
  let raw = jsonOf(text);
  let from = "config.json";
  if (raw === undefined) {
    const prev = jsonOf(readText(join(dir, "config.json.prev")));
    if (prev !== undefined) {
      if (text) kept("the whole file: it is not valid JSON");
      log(`config.json in ${dir} is missing, empty, or not valid JSON. Using config.json.prev.`);
      raw = prev;
      from = "config.json.prev";
    } else {
      if (text !== null) kept("the whole file: it is not valid JSON");
      return null;
    }
  }
  const r = config.safeParse(raw);
  if (!r.success) {
    kept(`the whole file: ${[...new Set(r.error.issues.map((i) => String(i.path[0] ?? "the top level")))].join(", ")} is invalid`, from);
    return null;
  }
  const { profiles: stored, ...data } = r.data;
  const resolved = stored && resolveProfiles(stored, data.profilesVersion ?? 1);
  const out: Config = resolved ? { ...data, profiles: resolved.profiles, profileEdits: resolved.edits } : data;
  // A key with .catch(undefined) reads as absent when its value is invalid.
  const given = raw as Record<string, unknown>;
  const dropped = Object.keys(config.shape).filter((k) => given[k] !== undefined && out[k as keyof Config] === undefined);
  if (dropped.length) kept(`the invalid ${dropped.join(", ")}`, from);
  return out;
}

// Windows refuses a rename onto a file that another program holds open, for example an editor.
const LOCKED = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_WAIT_MS = 500;
const RENAME_STEP_MS = 50;
export class ConfigWriteError extends Error {}

// rename: tests replace it to simulate a locked file.
export function writeConfig(dir: string, value: Config, rename: (from: string, to: string) => void = renameSync) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  const tmp = `${file}.tmp`;
  const { profiles, profileEdits, ...rest } = value;
  const stored = profiles ? { profiles: storeProfiles(profiles, profileEdits) } : {};
  const text = `${JSON.stringify({ ...rest, ...stored, profilesVersion: PROFILES_VERSION }, null, 2)}\n`;
  writeFileSync(tmp, text);
  const end = Date.now() + RENAME_WAIT_MS;
  for (;;) {
    try {
      rename(tmp, file);
      return;
    } catch (e) {
      if (!LOCKED.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      if (Date.now() >= end) break;
      Bun.sleepSync(RENAME_STEP_MS);
    }
  }
  // A write in place keeps the handle of the other program valid. config.json.prev holds the old text if the write stops halfway.
  const old = readText(file);
  if (jsonOf(old) !== undefined) writeFileSync(`${file}.prev`, old as string);
  try {
    writeFileSync(file, text);
  } catch {
    throw new ConfigWriteError(`Cannot save ${file}. Another program has the file open. Close it there, then save again.`);
  } finally {
    rmSync(tmp, { force: true });
  }
  log(`Another program has ${file} open. The app wrote the file in place.`);
}

// One database per instance origin, so no table needs an instance column.
export function dbPath(dir: string, baseUrl: string): string {
  const hash = createHash("sha256").update(new URL(baseUrl).origin).digest("hex").slice(0, 16);
  return join(dir, `db-${hash}.sqlite`);
}
