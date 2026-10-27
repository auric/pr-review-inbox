// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Claude Code skills for review profiles. A run gets a copy of each listed skill folder in <work>/skills. The CLI keeps the Skill tool off.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alwaysSkillError, type SkillDto } from "../../shared/dto";

export type Skill = SkillDto & { dir: string };

export type CopiedSkill = { id: string; version: string | null; folder: string; files: number; bytes: number; skipped: number };

export const MAX_SKILL_BYTES = 1_000_000;
export const MAX_SKILL_FILES = 200;
const MAX_SKILL_MD = 64 * 1024;
// Above this count, the run gets the index file in ./skills, and the prompt asks for the skills that apply only.
export const SKILL_INDEX_AFTER = 5;
export const SKILL_INDEX = "INDEX.md";
const MAX_INDEX_DESCRIPTION = 1024;
// The skillId parts in src/shared/dto.ts.
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A null byte in the content also marks a binary file.
const BINARY =
  /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|class|exe|dll|so|dylib|o|a|lib|obj|pdb|bin|wasm|pyc|pyo|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|flac|webm|mov|avi|sqlite|db)$/i;

// The CLI reads the same folder: childEnv passes CLAUDE_CONFIG_DIR through.
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// ":" is not valid in a Windows file name. "+" never occurs in an ID part, so the folder names stay unique.
export const skillFolder = (id: string) => id.replace(":", "+");

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The name and description of the SKILL.md front matter. null: no readable SKILL.md file.
function frontMatter(file: string): { name: string; description: string } | null {
  let text: string;
  try {
    if (!statSync(file).isFile()) return null;
    text = readFileSync(file, "utf8").slice(0, MAX_SKILL_MD);
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text.replace(/^﻿/, ""));
  let meta: unknown = null;
  try {
    meta = m ? Bun.YAML.parse(m[1] as string) : null;
  } catch {}
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return record(meta) ? { name: str(meta.name), description: str(meta.description) } : { name: "", description: "" };
}

function skillsIn(root: string, source: Skill["source"], plugin?: string, version?: string): Skill[] {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    if (!PART.test(n)) return [];
    const dir = join(root, n);
    const meta = frontMatter(join(dir, "SKILL.md"));
    if (!meta) return [];
    const id = plugin ? `${plugin}:${n}` : n;
    return [{ id, name: meta.name || n, description: meta.description, source, ...(version && { version }), dir }];
  });
}

// installed_plugins.json: { plugins: { "<plugin>@<marketplace>": [{ scope, installPath, version }] } }. Version 1 had one object per key.
// settings.json enables plugins at user scope, so only an entry with scope "user", or with no scope, counts.
function installOf(entries: unknown): { path: string; version?: string } | null {
  const list = Array.isArray(entries) ? entries : [entries];
  const e = list.find((x) => record(x) && (x.scope === "user" || x.scope === undefined) && typeof x.installPath === "string");
  if (!record(e)) return null;
  return { path: e.installPath as string, ...(typeof e.version === "string" && { version: e.version }) };
}

// The enabled plugins at user scope. key: "<plugin>@<marketplace>". Missing files and bad JSON give fewer plugins, never an error.
export function enabledPlugins(config = claudeConfigDir()): { key: string; plugin: string; path: string; version?: string }[] {
  const settings = readJson(join(config, "settings.json"));
  const installed = readJson(join(config, "plugins", "installed_plugins.json"));
  const enabled = record(settings) && record(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const plugins = record(installed) && record(installed.plugins) ? installed.plugins : {};
  return Object.entries(enabled).flatMap(([key, on]) => {
    const plugin = key.split("@")[0] ?? "";
    const install = on === true && PART.test(plugin) ? installOf(plugins[key]) : null;
    return install ? [{ key, plugin, ...install }] : [];
  });
}

// Reads the disk on each call. Missing files and bad JSON give fewer skills, never an error.
export function discoverSkills(config = claudeConfigDir()): Skill[] {
  const out = skillsIn(join(config, "skills"), "user");
  for (const p of enabledPlugins(config)) out.push(...skillsIn(join(p.path, "skills"), "plugin", p.plugin, p.version));
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.id) && !!seen.add(s.id));
}

export const skillDto = ({ dir, ...s }: Skill): SkillDto => s;

// Copies text files only, breadth first, SKILL.md first. lstat shows a link or junction as neither file nor folder, so no copy leaves the skill folder.
function copyOne(s: Skill, to: string): CopiedSkill {
  const out: CopiedSkill = { id: s.id, version: s.version ?? null, folder: skillFolder(s.id), files: 0, bytes: 0, skipped: 0 };
  const queue = [""];
  while (queue.length) {
    const rel = queue.shift() as string;
    let names: string[];
    try {
      names = readdirSync(join(s.dir, rel)).sort((a, b) => Number(b === "SKILL.md") - Number(a === "SKILL.md") || a.localeCompare(b));
    } catch {
      out.skipped++;
      continue;
    }
    for (const n of names) {
      const r = rel ? join(rel, n) : n;
      const from = join(s.dir, r);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(from);
      } catch {
        out.skipped++;
        continue;
      }
      if (n.startsWith(".")) out.skipped++;
      else if (st.isDirectory()) queue.push(r);
      else if (!st.isFile() || BINARY.test(n) || out.files >= MAX_SKILL_FILES || out.bytes + st.size > MAX_SKILL_BYTES) out.skipped++;
      else {
        const data = readFileSync(from);
        if (data.includes(0) || out.bytes + data.length > MAX_SKILL_BYTES) {
          out.skipped++;
          continue;
        }
        mkdirSync(join(to, rel), { recursive: true });
        writeFileSync(join(to, r), data);
        out.files++;
        out.bytes += data.length;
      }
    }
  }
  return out;
}

// One line per skill: line breaks in the front matter text become spaces.
function indexText(skills: Skill[], root: string): string {
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  return [
    "# Skills",
    "",
    "Each line gives the SKILL.md path, the skill name, and its description.",
    "",
    ...skills.map((s) => {
      const d = one(s.description).slice(0, MAX_INDEX_DESCRIPTION);
      return `- ./${root}/${skillFolder(s.id)}/SKILL.md: ${one(s.name)}${d ? `. ${d}` : ""}`;
    }),
    "",
  ].join("\n");
}

const reserved = (id: string) => skillFolder(id).toLowerCase() === SKILL_INDEX.toLowerCase();
const RESERVED = `the folder name ${SKILL_INDEX} is reserved`;
const BAD_MD = `SKILL.md is over ${MAX_SKILL_BYTES} bytes or not a text file`;

// copyOne copies SKILL.md first, so it copies SKILL.md exactly when this check passes.
function mdCopies(s: Skill): boolean {
  const file = join(s.dir, "SKILL.md");
  try {
    const st = lstatSync(file);
    return st.isFile() && st.size <= MAX_SKILL_BYTES && !readFileSync(file).includes(0);
  } catch {
    return false;
  }
}

// The start errors of the always-use skills that a run cannot get. Empty: copySkills gets each one.
export function alwaysProblems(ids: string[], config = claudeConfigDir()): string[] {
  if (!ids.length) return [];
  const found = new Map(discoverSkills(config).map((s) => [s.id, s]));
  return ids.flatMap((id) => {
    const s = found.get(id);
    if (!s) return [alwaysSkillError(id)];
    if (reserved(id)) return [alwaysSkillError(id, RESERVED)];
    return mdCopies(s) ? [] : [alwaysSkillError(id, BAD_MD)];
  });
}

// dest: <work>/skills, or <part folder>/context/skills for an implement run. root: dest from the run cwd, for the index.
// gaps: one line for each listed skill that the run does not get. Above SKILL_INDEX_AFTER copied skills, dest also gets SKILL_INDEX.
export function copySkills(
  ids: string[],
  dest: string,
  config = claudeConfigDir(),
  root = "skills",
): { copied: CopiedSkill[]; gaps: string[] } {
  const copied: CopiedSkill[] = [];
  const gaps: string[] = [];
  if (!ids.length) return { copied, gaps };
  const found = new Map(discoverSkills(config).map((s) => [s.id, s]));
  const listed: Skill[] = [];
  for (const id of ids) {
    const s = found.get(id);
    if (!s) {
      gaps.push(`Skill ${id}: not found`);
      continue;
    }
    if (reserved(id)) {
      gaps.push(`Skill ${id}: ${RESERVED}`);
      continue;
    }
    const to = join(dest, skillFolder(id));
    try {
      const c = copyOne(s, to);
      if (lstatSync(join(to, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) {
        copied.push(c);
        listed.push(s);
      } else {
        rmSync(to, { recursive: true, force: true });
        gaps.push(`Skill ${id}: ${BAD_MD}`);
      }
    } catch (e) {
      gaps.push(`Skill ${id}: copy failed (${(e as Error).message})`);
    }
  }
  if (listed.length > SKILL_INDEX_AFTER) writeFileSync(join(dest, SKILL_INDEX), indexText(listed, root));
  return { copied, gaps };
}
