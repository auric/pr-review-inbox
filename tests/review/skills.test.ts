// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../../src/server/config";
import { mainAgent, profileRevision, reviewerAgent, SHIPPED_PROFILES, skillLines, withSkills } from "../../src/server/review/catalog";
import { git, gitEnv } from "../../src/server/review/git";
import { buildPrompt, type PromptInput } from "../../src/server/review/prompt";
import {
  alwaysProblems,
  copySkills,
  copyTaskSkills,
  discoverSkills,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  SKILL_INDEX_AFTER,
  skillDto,
} from "../../src/server/review/skills";
import { profileInput } from "../../src/shared/dto";

console.log(`skills.test.ts imported from ${Bun.resolveSync("../../src/server/review/skills", import.meta.dir)}`);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `rl-skills-${tag}-`));
  dirs.push(d);
  return d;
};
const write = (path: string, text: string | Uint8Array) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const skill = (dir: string, front: string, body = "Body.\n") => write(join(dir, "SKILL.md"), `---\n${front}\n---\n${body}`);
const json = (path: string, v: unknown) => write(path, JSON.stringify(v));

// A config folder with a user skill, an enabled plugin, a disabled plugin, and a plugin installed only for a project.
function config() {
  const c = temp("config");
  skill(join(c, "skills", "review-rules"), 'name: Review rules\ndescription: "Checks: the house rules."');
  skill(join(c, "skills", "folded"), "description: >\n  One\n  line.");
  write(join(c, "skills", "no-skill-md", "README.md"), "x");
  write(join(c, "skills", "bad name!", "SKILL.md"), "x");
  write(join(c, "skills", "plain", "SKILL.md"), "No front matter.\n");
  const on = join(c, "plugins", "cache", "m", "tools", "1.0.0");
  const off = join(c, "plugins", "cache", "m", "off", "2.0.0");
  const local = join(c, "plugins", "cache", "m", "local", "3.0.0");
  skill(join(on, "skills", "lint"), "name: lint\ndescription: Lint rules.");
  skill(join(off, "skills", "hidden"), "name: hidden");
  skill(join(local, "skills", "project"), "name: project");
  json(join(c, "settings.json"), { enabledPlugins: { "tools@m": true, "off@m": false, "local@m": true } });
  json(join(c, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "tools@m": [
        { scope: "local", projectPath: "/elsewhere", installPath: join(c, "nowhere"), version: "0.1.0" },
        { scope: "user", installPath: on, version: "1.0.0" },
      ],
      "off@m": [{ scope: "user", installPath: off, version: "2.0.0" }],
      "local@m": [{ scope: "project", projectPath: "/elsewhere", installPath: local, version: "3.0.0" }],
    },
  });
  return c;
}

describe("skill discovery", () => {
  test("lists user skills and the skills of enabled user-scope plugins", () => {
    expect(discoverSkills(config()).map(skillDto)).toEqual([
      { id: "folded", name: "folded", description: "One line.", source: "user" },
      { id: "plain", name: "plain", description: "", source: "user" },
      { id: "review-rules", name: "Review rules", description: "Checks: the house rules.", source: "user" },
      { id: "tools:lint", name: "lint", description: "Lint rules.", source: "plugin", version: "1.0.0" },
    ]);
  });

  test("bad JSON and missing files give fewer skills, never an error", () => {
    const c = config();
    write(join(c, "settings.json"), "{ not json");
    expect(discoverSkills(c).map((s) => s.id)).toEqual(["folded", "plain", "review-rules"]);
    json(join(c, "settings.json"), { enabledPlugins: { "tools@m": true } });
    write(join(c, "plugins", "installed_plugins.json"), "[");
    expect(discoverSkills(c).map((s) => s.id)).toEqual(["folded", "plain", "review-rules"]);
    json(join(c, "plugins", "installed_plugins.json"), { plugins: { "tools@m": "wrong" } });
    expect(discoverSkills(c).map((s) => s.id)).toEqual(["folded", "plain", "review-rules"]);
    expect(discoverSkills(join(c, "absent"))).toEqual([]);
  });

  test("every discovered ID passes the profile skill pattern", () => {
    for (const s of discoverSkills(config())) expect(profileInput.shape.skills.safeParse([s.id]).success, s.id).toBe(true);
  });
});

describe("skill copy", () => {
  test("copies text files and skips links, binaries, hidden entries, and files past the caps", () => {
    const c = temp("caps");
    const src = join(c, "skills", "big");
    skill(src, "name: big");
    write(join(src, "docs", "guide.md"), "Guide.\n");
    write(join(src, "image.png"), "not really a png");
    write(join(src, "blob.txt"), new Uint8Array([65, 0, 66]));
    write(join(src, ".git", "config"), "x");
    write(join(src, "huge.md"), "x".repeat(MAX_SKILL_BYTES));
    for (let i = 0; i < MAX_SKILL_FILES + 5; i++) write(join(src, "many", `f${String(i).padStart(3, "0")}.md`), "m");
    const outside = temp("outside");
    write(join(outside, "secret.md"), "SECRET");
    // A junction needs no admin right on Windows.
    symlinkSync(outside, join(src, "escape"), process.platform === "win32" ? "junction" : "dir");
    // A file link needs an admin right or developer mode on Windows.
    try {
      symlinkSync(join(outside, "secret.md"), join(src, "linked.md"), "file");
    } catch {}

    const dest = join(temp("dest"), "skills");
    const r = copySkills(["big"], dest, c);
    expect(r.gaps).toEqual([]);
    const [one] = r.copied;
    expect(one).toMatchObject({ id: "big", version: null, folder: "big", files: MAX_SKILL_FILES });
    const to = join(dest, "big");
    expect(existsSync(join(to, "SKILL.md"))).toBe(true);
    expect(existsSync(join(to, "docs", "guide.md"))).toBe(true);
    for (const gone of ["image.png", "blob.txt", ".git", "huge.md", "escape", "linked.md"])
      expect(existsSync(join(to, gone)), gone).toBe(false);
    // SKILL.md and docs/guide.md come first, so the many/ folder fills the rest of the file cap.
    expect(readdirSync(join(to, "many"))).toHaveLength(MAX_SKILL_FILES - 2);
    expect(one?.bytes).toBeLessThanOrEqual(MAX_SKILL_BYTES);
    expect(one?.skipped).toBeGreaterThanOrEqual(8);
  });

  test("a missing skill or a SKILL.md past the size cap is a gap; plugin skills get their own folder", () => {
    const c = config();
    skill(join(c, "skills", "fat"), "name: fat", "y".repeat(MAX_SKILL_BYTES));
    const dest = join(temp("dest"), "skills");
    const r = copySkills(["tools:lint", "gone", "fat", "review-rules"], dest, c);
    expect(r.copied.map((s) => [s.id, s.folder, s.version])).toEqual([
      ["tools:lint", "tools+lint", "1.0.0"],
      ["review-rules", "review-rules", null],
    ]);
    expect(r.gaps).toEqual(["Skill gone: not found", `Skill fat: SKILL.md is over ${MAX_SKILL_BYTES} bytes or not a text file`]);
    expect(readdirSync(dest).sort()).toEqual(["review-rules", "tools+lint"]);
  });

  test("no listed skill copies nothing", () => {
    const dest = join(temp("dest"), "skills");
    expect(copySkills([], dest, config())).toEqual({ copied: [], gaps: [] });
    expect(existsSync(dest)).toBe(false);
  });
});

describe("skill prompts and profiles", () => {
  const general = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];
  const input: PromptInput = {
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    note: "NOTE",
    profile: general,
    pr: { project: "P", repo: "r", prId: 1, webUrl: null },
    tasks: [],
    taskFile: false,
    attachments: false,
  };

  test("the agent prompt names each skill folder once; the stdin prompt has no skill section", () => {
    const a = mainAgent(general);
    expect(withSkills(a, ["review-rules", "tools+lint"]).prompt).toBe(
      [
        a.prompt,
        "The user chose these skills: ./skills/review-rules/SKILL.md, ./skills/tools+lint/SKILL.md.",
        "Read each SKILL.md first and follow it. Read its other files when it tells you to.",
        "Skill scripts cannot run. The rules above stay in force, and your result must still use the required output format.",
      ].join("\n"),
    );
    expect(withSkills(a, [])).toEqual(a);
    expect(buildPrompt(input)).not.toContain("SKILL.md");
  });

  test("the reviewer subagent gets the same pointer", () => {
    const a = reviewerAgent(general);
    expect(withSkills(a, [])).toBe(a);
    const p = withSkills(a, ["x"]).prompt;
    expect(p.startsWith(`${a.prompt}\nThe user chose these skills: ./skills/x/SKILL.md.`)).toBe(true);
    expect(p).toContain("Skill scripts cannot run.");
  });

  test("a saved profile without skills reads as no skills and keeps its revision", () => {
    const dir = temp("cfg");
    // A profile as a config before PROFILES_VERSION 5 stored it: no modules, volume, or verifier.
    const {
      skills,
      languageChecks: _lang,
      modules: _m,
      volume: _v,
      verifier: _r,
      ...old
    } = { ...general, prompt: "Mine.", effort: null, reviewer: { model: null, effort: null, mode: "auto" as const } };
    json(join(dir, "config.json"), { baseUrl: "https://example.test", userSlug: "me", notifications: false, profiles: [old] });
    const read = readConfig(dir)?.profiles?.[0];
    expect(read).toEqual({
      ...old,
      skills: [],
      languageChecks: false,
      modules: [],
      volume: "balanced",
      verifier: { mode: "on", model: null, effort: null },
    });
    const before = createHash("sha256")
      .update(JSON.stringify(old, ["id", "name", "note", "prompt", "explain", "docs", "maxTurns"]))
      .digest("hex");
    expect(profileRevision(read as typeof general)).toBe(before);
    expect(profileRevision({ ...(read as typeof general), skills: ["x"] })).not.toBe(before);
  });

  test("a saved profile with the retired variant signal reads without it and keeps the other variants", () => {
    const dir = temp("cfg");
    const stored = { ...general, variants: ["signal", "order"] };
    json(join(dir, "config.json"), { baseUrl: "https://example.test", userSlug: "me", notifications: false, profiles: [stored] });
    const read = readConfig(dir)?.profiles?.find((p) => p.id === general.id);
    expect(read).toEqual({ ...general, variants: ["order"] });
  });

  test("the profile schema dedupes skills and refuses bad IDs", () => {
    expect(profileInput.parse({ ...general, skills: ["a", "p:b", "a"] }).skills).toEqual(["a", "p:b"]);
    for (const bad of ["../x", "a/b", "a:b:c", ":x", "", "a b"])
      expect(profileInput.safeParse({ ...general, skills: [bad] }).success, bad).toBe(false);
    expect(profileInput.safeParse({ ...general, skills: Array.from({ length: 200 }, (_, i) => `s${i}`) }).success).toBe(true);
    expect(profileInput.safeParse({ ...general, skills: Array.from({ length: 201 }, (_, i) => `s${i}`) }).success).toBe(false);
  });
});

describe("skill index (more than SKILL_INDEX_AFTER skills)", () => {
  const general = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];

  // A config folder with n user skills: s0 to s<n-1>.
  function many(n: number) {
    const c = temp("many");
    for (let i = 0; i < n; i++) skill(join(c, "skills", `s${i}`), `name: Skill ${i}\ndescription: >\n  Checks part\n  ${i}.`);
    return c;
  }

  test("above the threshold the run gets INDEX.md with the path, name, and description of each copied skill", () => {
    const n = SKILL_INDEX_AFTER + 1;
    const c = many(n);
    const dest = join(temp("dest"), "skills");
    const r = copySkills([...Array.from({ length: n }, (_, i) => `s${i}`), "gone"], dest, c);
    expect(r.copied).toHaveLength(n);
    const index = readFileSync(join(dest, "INDEX.md"), "utf8");
    expect(index).toContain("- ./skills/s0/SKILL.md: Skill 0. Checks part 0.");
    expect(index).toContain(`- ./skills/s${n - 1}/SKILL.md: Skill ${n - 1}. Checks part ${n - 1}.`);
    expect(index).not.toContain("gone");
    expect(index.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(n);
  });

  test("at the threshold or below there is no index, and the prompt keeps the read-each-skill rule", () => {
    const c = many(SKILL_INDEX_AFTER);
    const dest = join(temp("dest"), "skills");
    copySkills(
      Array.from({ length: SKILL_INDEX_AFTER }, (_, i) => `s${i}`),
      dest,
      c,
    );
    expect(existsSync(join(dest, "INDEX.md"))).toBe(false);
    const few = withSkills(
      mainAgent(general),
      Array.from({ length: SKILL_INDEX_AFTER }, (_, i) => `s${i}`),
    ).prompt;
    expect(few).toContain("Read each SKILL.md first and follow it.");
    expect(few).not.toContain("INDEX.md");
  });

  test("above the threshold the prompt points at the index and asks for the skills that apply only", () => {
    const folders = Array.from({ length: SKILL_INDEX_AFTER + 1 }, (_, i) => `s${i}`);
    const text = withSkills(mainAgent(general), folders).prompt;
    expect(text).toContain(
      `The user chose ${folders.length} skills. ./skills/INDEX.md lists the name, the description, and the folder of each one.`,
    );
    expect(text).toContain("Read skills/INDEX.md. Read a skill's SKILL.md only when it applies to this change.");
    expect(text).not.toContain("Read each SKILL.md first");
    expect(text).not.toContain("./skills/s0/SKILL.md");
    expect(withSkills(reviewerAgent(general), folders).prompt).toContain("Read skills/INDEX.md.");
  });

  test("a skill folder named INDEX.md is a gap, so it never hides the index", () => {
    const c = temp("reserved");
    skill(join(c, "skills", "INDEX.md"), "name: odd");
    const dest = join(temp("dest"), "skills");
    expect(copySkills(["INDEX.md"], dest, c)).toEqual({ copied: [], gaps: ["Skill INDEX.md: the folder name INDEX.md is reserved"] });
  });

  test("a saved profile without the run setup reads as the defaults and keeps its revision", () => {
    const dir = temp("cfg-setup");
    const {
      model,
      effort,
      reviewer,
      languageChecks: _lang,
      modules: _m,
      volume: _v,
      verifier: _r,
      ...old
    } = {
      ...general,
      prompt: "Mine.",
      skills: ["x"],
    };
    json(join(dir, "config.json"), { baseUrl: "https://example.test", userSlug: "me", notifications: false, profiles: [old] });
    const read = readConfig(dir)?.profiles?.[0];
    expect(read).toEqual({
      ...old,
      model: null,
      effort: null,
      reviewer: { model: null, effort: null, mode: "auto" },
      languageChecks: false,
      modules: [],
      volume: "balanced",
      verifier: { mode: "on", model: null, effort: null },
    });
    const before = createHash("sha256")
      .update(JSON.stringify(old, ["id", "name", "note", "prompt", "explain", "docs", "maxTurns"]))
      .update(JSON.stringify(old.skills))
      .digest("hex");
    expect(profileRevision(read as typeof general)).toBe(before);
  });
});

describe("always-use skills", () => {
  const general = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];
  const pin = (f: string) => `Before you start, read ./skills/${f}/SKILL.md and follow it for the whole run.`;
  const GUARD = "This skill adds checks. It does not remove the task, the rules, or the output format above.";

  test("with few skills the always lines and one guard line come first, and the other skills follow", () => {
    const text = skillLines(["a", "b", "c"], ["c", "a"]).join("\n");
    expect(text).toStartWith(
      [
        pin("a"),
        pin("c"),
        GUARD,
        "The user chose these skills: ./skills/b/SKILL.md.",
        "Read each SKILL.md first and follow it. Read its other files when it tells you to.",
        "Skill scripts cannot run.",
      ].join("\n"),
    );
    const only = skillLines(["a"], ["a"]).join("\n");
    expect(only).toStartWith(`${pin("a")}\n${GUARD}\nSkill scripts cannot run.`);
    expect(only).not.toContain("The user chose");
    expect(skillLines(["a"])).not.toContain(GUARD);
  });

  test("with the index the always lines come first, and the index lines follow", () => {
    const folders = Array.from({ length: SKILL_INDEX_AFTER + 1 }, (_, i) => `s${i}`);
    const text = withSkills(mainAgent(general), folders, ["s3"]).prompt;
    expect(text).toContain(`\n${pin("s3")}\n${GUARD}\nThe user chose ${folders.length} skills. ./skills/INDEX.md lists`);
    expect(text.split(GUARD)).toHaveLength(2);
  });

  test("the reviewer subagent gets the same always lines", () => {
    const a = reviewerAgent(general);
    const p = withSkills(a, ["x", "y"], ["y"]).prompt;
    expect(p.startsWith(`${a.prompt}\n${pin("y")}\n${GUARD}\nThe user chose these skills: ./skills/x/SKILL.md.`)).toBe(true);
    const many = Array.from({ length: SKILL_INDEX_AFTER + 1 }, (_, i) => `s${i}`);
    expect(withSkills(a, many, ["s0"]).prompt).toContain(`${pin("s0")}\n${GUARD}\nThe user chose ${many.length} skills.`);
  });

  test("alwaysProblems names each always skill that a run cannot get", () => {
    const c = temp("always");
    skill(join(c, "skills", "ok"), "name: ok");
    skill(join(c, "skills", "INDEX.md"), "name: odd");
    write(join(c, "skills", "big", "SKILL.md"), `---\nname: big\n---\n${"x".repeat(MAX_SKILL_BYTES)}`);
    write(join(c, "skills", "binary", "SKILL.md"), new Uint8Array([45, 45, 45, 10, 45, 45, 45, 10, 0]));
    const fix = "Fix the skill folder, or remove the Always use mark in Settings > Review profiles.";
    expect(alwaysProblems([], c)).toEqual([]);
    expect(alwaysProblems(["ok"], c)).toEqual([]);
    expect(alwaysProblems(["gone", "ok", "INDEX.md", "big", "binary"], c)).toEqual([
      "Skill gone is marked Always use, but it is not found. Enable the plugin again, or remove the Always use mark in Settings > Review profiles.",
      `Skill INDEX.md is marked Always use, but the folder name INDEX.md is reserved. ${fix}`,
      `Skill big is marked Always use, but SKILL.md is over ${MAX_SKILL_BYTES} bytes or not a text file. ${fix}`,
      `Skill binary is marked Always use, but SKILL.md is over ${MAX_SKILL_BYTES} bytes or not a text file. ${fix}`,
    ]);
    // The check agrees with the copy.
    const dest = join(temp("dest"), "skills");
    expect(copySkills(["ok", "big", "binary"], dest, c).copied.map((s) => s.id)).toEqual(["ok"]);
  });

  test("the profile schema takes only chosen skills as always skills", () => {
    expect(profileInput.parse({ ...general, skills: ["a", "b"], alwaysSkills: ["b", "b"] }).alwaysSkills).toEqual(["b"]);
    const bad = profileInput.safeParse({ ...general, skills: ["a"], alwaysSkills: ["b"] });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["alwaysSkills"]);
    expect(profileInput.safeParse({ ...general, skills: [], alwaysSkills: ["../x"] }).success).toBe(false);
  });

  test("a saved profile without always skills reads as none and keeps its revision; a mark changes it", () => {
    const dir = temp("cfg-always");
    const {
      alwaysSkills: _a,
      modules: _m,
      volume: _v,
      verifier: _r,
      ...old
    } = { ...general, prompt: "Mine.", skills: ["x"], effort: null, reviewer: { model: null, effort: null, mode: "auto" as const } };
    json(join(dir, "config.json"), { baseUrl: "https://example.test", userSlug: "me", notifications: false, profiles: [old] });
    const read = readConfig(dir)?.profiles?.[0] as typeof general;
    expect(read.alwaysSkills).toEqual([]);
    // general has languageChecks on, so the revision adds "lang".
    const before = createHash("sha256")
      .update(JSON.stringify(old, ["id", "name", "note", "prompt", "explain", "docs", "maxTurns"]))
      .update(JSON.stringify(old.skills))
      .update("lang")
      .digest("hex");
    expect(profileRevision(read)).toBe(before);
    expect(profileRevision({ ...read, alwaysSkills: ["x"] })).not.toBe(before);
  });
});

describe("task run skills (spec.md section 6.19)", () => {
  type Blob = string | Uint8Array | { link: string };
  const isLink = (v: Blob): v is { link: string } => typeof v === "object" && "link" in v;
  // A bare repository as the app cache: base holds the repository skills, and a task commit on top adds more. No forge.
  async function repoCache(files: Record<string, Blob>, task: Record<string, Blob> = {}) {
    const root = temp("cache");
    const empty = join(root, "empty.gitconfig");
    writeFileSync(empty, "");
    const cache = join(root, "repo.git");
    const env = {
      ...gitEnv(empty),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_INDEX_FILE: join(root, "index"),
    };
    const g = async (args: string[], stdin?: string) => (await git(["--git-dir", cache, ...args], { env, stdin })).trim();
    await git(["init", "-q", "--bare", "--template=", cache], { env });
    let n = 0;
    const commit = async (parent: string | null, add: Record<string, Blob>) => {
      await g(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
      const entries = Object.entries(add);
      if (!entries.length) return g(["commit-tree", await g(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", "c"]);
      const paths = entries.map(([, v]) => {
        const f = join(root, `blob-${n++}`);
        writeFileSync(f, isLink(v) ? v.link : v);
        return f;
      });
      const shas = (await g(["hash-object", "-w", "--no-filters", "--stdin-paths"], `${paths.join("\n")}\n`)).split("\n");
      await g(
        ["update-index", "--index-info"],
        `${entries.map(([p, v], i) => `${isLink(v) ? "120000" : "100644"} ${shas[i]}\t${p}`).join("\n")}\n`,
      );
      return g(["commit-tree", await g(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", "c"]);
    };
    const base = await commit(null, { "README.md": "x\n", ...files });
    return { cache, base, task: await commit(base, task) };
  }
  const md = (front: string, body = "Body.\n") => `---\n${front}\n---\n${body}`;
  const S = ".claude/skills";

  test("the repository skills come from the base commit, then every user and plugin skill; a repository skill wins a clash", async () => {
    const c = config();
    skill(join(c, "skills", "deploy"), "name: deploy\ndescription: USER-DEPLOY.");
    const main = await repoCache(
      {
        [`${S}/deploy/SKILL.md`]: md("name: Deploy\ndescription: Ship it.", "REPO-DEPLOY\n"),
        [`${S}/deploy/ref/steps.md`]: "Steps.\n",
        [`${S}/deploy/logo.png`]: "not a png",
        [`${S}/deploy/.hidden.md`]: "h",
        [`${S}/deploy/out.md`]: { link: "../../../README.md" },
        [`${S}/deploy/huge.md`]: "x".repeat(MAX_SKILL_BYTES),
        [`${S}/INDEX.md/SKILL.md`]: md("name: odd"),
        [`${S}/fat/SKILL.md`]: md("name: fat", "y".repeat(MAX_SKILL_BYTES)),
        [`${S}/bin/SKILL.md`]: new Uint8Array([45, 45, 45, 10, 45, 45, 45, 10, 0]),
        [`${S}/bad name/SKILL.md`]: md("name: bad"),
        [`${S}/readme-only/README.md`]: "No skill.\n",
        [`${S}/top.md`]: "A file, no skill folder.\n",
        "sub/.claude/skills/nested/SKILL.md": md("name: nested"),
      },
      { [`${S}/branch-only/SKILL.md`]: md("name: branch-only") },
    );
    const lib = await repoCache({ [`${S}/deploy/SKILL.md`]: md("name: Lib deploy\ndescription: Ship the lib.") });
    const dest = join(temp("dest"), "context", "skills");
    const r = await copyTaskSkills(
      [
        { cache: main.cache, commit: main.base, slug: null },
        { cache: lib.cache, commit: lib.base, slug: "lib" },
      ],
      ["deploy", "gone", "review-rules"],
      dest,
      c,
      "context/skills",
    );
    // The task branch skill, a folder without SKILL.md, and a skill folder below the root never come.
    expect(readdirSync(dest).sort()).toEqual(["INDEX.md", "deploy", "folded", "lib+deploy", "plain", "review-rules", "tools+lint"]);
    expect(r.copied.map((s) => s.id)).toEqual(["deploy", "lib:deploy", "folded", "plain", "review-rules", "tools:lint"]);
    expect(readFileSync(join(dest, "deploy", "SKILL.md"), "utf8")).toContain("REPO-DEPLOY");
    expect(readFileSync(join(dest, "deploy", "ref", "steps.md"), "utf8")).toBe("Steps.\n");
    for (const gone of ["logo.png", ".hidden.md", "out.md", "huge.md"]) expect(existsSync(join(dest, "deploy", gone)), gone).toBe(false);
    expect(r.copied[0]).toMatchObject({ files: 2, skipped: 4 });
    // A clash or a bad repository skill is no gap of the profile. A ticked skill that is not found stays a gap.
    expect(r.gaps).toEqual(["Skill gone: not found"]);
    const BAD = `SKILL.md is over ${MAX_SKILL_BYTES} bytes or not a text file`;
    expect(r.left).toEqual([
      "bad name (repository): the folder name is not valid",
      `bin (repository): ${BAD}`,
      `fat (repository): ${BAD}`,
      "INDEX.md (repository): the folder name INDEX.md is reserved",
      "deploy (user): the repository has a skill with the same name, and that skill wins",
    ]);
    const index = readFileSync(join(dest, "INDEX.md"), "utf8");
    expect(index.split("\n").filter((l) => l.startsWith("- "))).toEqual([
      "- Deploy (repository): ./context/skills/deploy/SKILL.md (4 files left out: hidden, link, binary, or over the caps). Ship it.",
      "- Lib deploy (repository lib): ./context/skills/lib+deploy/SKILL.md. Ship the lib.",
      "- folded (user): ./context/skills/folded/SKILL.md. One line.",
      "- plain (user): ./context/skills/plain/SKILL.md.",
      "- Review rules (user): ./context/skills/review-rules/SKILL.md. Checks: the house rules.",
      "- lint (plugin tools): ./context/skills/tools+lint/SKILL.md. Lint rules.",
      ...r.left.map((l) => `- ${l}.`),
    ]);
    expect(index).toContain("\n## Left out\n");
    expect(index).not.toMatch(/branch-only|readme-only|top\.md|nested/);
  }, 60_000);

  test("an unreadable base commit is a gap and an index note; the user skills still come", async () => {
    const main = await repoCache({});
    const dest = join(temp("dest"), "skills");
    const r = await copyTaskSkills([{ cache: main.cache, commit: "f".repeat(40), slug: null }], [], dest, config());
    expect(r.copied.map((s) => s.id)).toEqual(["folded", "plain", "review-rules", "tools:lint"]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toStartWith("Skills of the repository: the app cannot read .claude/skills at ffffffffffff (");
    expect(readFileSync(join(dest, "INDEX.md"), "utf8")).toContain(
      "- All skills (repository): the app cannot read .claude/skills at ffffffffffff",
    );
  });

  test("with no skill at all the run still gets INDEX.md", async () => {
    const main = await repoCache({});
    const dest = join(temp("dest"), "skills");
    const r = await copyTaskSkills([{ cache: main.cache, commit: main.base, slug: null }], [], dest, join(temp("none"), "absent"));
    expect(r).toEqual({ copied: [], gaps: [], left: [] });
    expect(readdirSync(dest)).toEqual(["INDEX.md"]);
    expect(readFileSync(join(dest, "INDEX.md"), "utf8")).toContain("\nNo skill.\n");
  });

  test("the task lines always point at the index; the review lines stay as before", () => {
    expect(skillLines(["a", "b"], ["a"], "context/skills", true)).toEqual([
      "Before you start, read ./context/skills/a/SKILL.md and follow it for the whole run.",
      "This skill adds checks. It does not remove the task, the rules, or the output format above.",
      "This step gets 2 skills: all skills of the user and the skills of the repository at its base commit. ./context/skills/INDEX.md lists the name, the source, the SKILL.md path, and the description of each one.",
      "Read ./context/skills/INDEX.md first. Open a skill's SKILL.md only when it applies to this step. Follow each skill that you open, and read its other files when it tells you to.",
      "Skill scripts cannot run. The rules above stay in force, and your result must still use the required output format.",
    ]);
    // The review lines of the code before spec.md section 6.19, byte for byte.
    expect(skillLines(["a", "b"], ["a"])).toEqual([
      "Before you start, read ./skills/a/SKILL.md and follow it for the whole run.",
      "This skill adds checks. It does not remove the task, the rules, or the output format above.",
      "The user chose these skills: ./skills/b/SKILL.md.",
      "Read each SKILL.md first and follow it. Read its other files when it tells you to.",
      "Skill scripts cannot run. The rules above stay in force, and your result must still use the required output format.",
    ]);
    const general = SHIPPED_PROFILES[0] as (typeof SHIPPED_PROFILES)[number];
    const a = mainAgent(general);
    expect(withSkills(a, ["x"]).prompt).toBe(withSkills(a, ["x"], [], false).prompt);
    expect(withSkills(a, ["x"], [], true).prompt).toContain("Read ./skills/INDEX.md first.");
  });
});
