// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Writes THIRD_PARTY_NOTICES.md from what ships: the npm packages in the web bundle (Vite source maps), in the server bundle
// (Bun metafile), and in the CSS imports of src/web/index.css, the Bun runtime of the compiled binary, and the project skills.
// Usage: bun scripts/notices.ts [--check]. --check writes nothing and fails when the file is out of date.
// It exits with code 1 when a license is not on the compatible list or a license text is missing.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.md");
const VENDORED = join(ROOT, "third-party-licenses");

// GPL-compatible free software licenses of the FSF list (https://www.gnu.org/licenses/license-list.html), by SPDX ID.
// AGPL-3.0 section 13 permits a combination with GPL-3.0 code, so GPL-3.0 compatibility is enough.
export const COMPATIBLE = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "CC0-1.0", "Unlicense", "Zlib", "MPL-2.0"]);

// An SPDX expression without nested parentheses: A, (A OR B), or A AND B. Any other form needs a manual review.
export function compatible(expression: string): boolean {
  const e = expression.trim().replace(/^\((.*)\)$/, "$1");
  if (/[()]/.test(e) || (/ OR /.test(e) && / AND /.test(e))) return false;
  if (/ OR /.test(e)) return e.split(" OR ").some((id) => COMPATIBLE.has(id.trim()));
  return e.split(" AND ").every((id) => COMPATIBLE.has(id.trim()));
}

// The license of each skills-lock.json source, from the upstream LICENSE file or README declaration.
const SKILL_LICENSE: Record<string, string> = {
  "anthropics/skills": "Apache-2.0",
  "emilkowalski/skills": "MIT",
  "honojs/skills": "MIT",
  "shadcn-ui/ui": "MIT",
  "vercel-labs/agent-skills": "MIT",
};

// The license of npm packages whose package.json has no license field, from the license file of the package.
const NPM_LICENSE: Record<string, string> = { "khroma@2.1.0": "MIT" };

type Text = { name: string; text: string };
type Pkg = { name: string; version: string; license: string; dir: string; where: Set<string> };

const problems: string[] = [];
const isLicenseFile = (f: string) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(f);
const filesIn = (dir: string, keep: (f: string) => boolean): Text[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter(keep)
        .sort()
        .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n").trimEnd() }))
    : [];

// The package folder of a file under node_modules: the name after the last node_modules segment, with its scope.
export function packageDir(file: string): string | null {
  const path = file.replaceAll("\\", "/").split("?")[0] ?? "";
  const at = path.lastIndexOf("node_modules/");
  if (at < 0) return null;
  const parts = path.slice(at + 13).split("/");
  const n = parts[0]?.startsWith("@") ? 2 : 1;
  return path.slice(0, at + 13) + parts.slice(0, n).join("/");
}

async function main() {
  const pkgs = new Map<string, Pkg>();
  // Two install folders of one name and version count once.
  function add(dir: string, where: string) {
    const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const id = `${json.name}@${json.version}`;
    const known = pkgs.get(id);
    if (known) return void known.where.add(where);
    const license =
      typeof json.license === "string" ? json.license : (json.license?.type ?? json.licenses?.[0]?.type ?? NPM_LICENSE[id] ?? "UNKNOWN");
    pkgs.set(id, { name: json.name, version: json.version, license, dir, where: new Set([where]) });
  }

  function run(cmd: string[]) {
    const r = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${r.exitCode}):\n${r.stderr.toString()}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), "rl-notices-"));
  try {
    // The web bundle: each source map names the modules that put code into its chunk.
    const web = join(tmp, "web");
    run(["node", "node_modules/vite/bin/vite.js", "build", "--sourcemap", "--outDir", web, "--emptyOutDir", "--logLevel", "error"]);
    for (const f of readdirSync(web, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".map"))) {
      const map = JSON.parse(readFileSync(join(web, f), "utf8")) as { sources: string[]; sourceRoot?: string };
      for (const s of map.sources) {
        const dir = packageDir(resolve(dirname(join(web, f)), map.sourceRoot ?? "", s));
        if (dir) add(dir, "web");
      }
    }
    // CSS imports of bare packages. Tailwind CSS compiles them into the stylesheet.
    const css = readFileSync(join(ROOT, "src/web/index.css"), "utf8");
    for (const [, spec = ""] of css.matchAll(/@import\s+["']([^"'./][^"']*)["']/g)) {
      const parts = spec.split("/");
      add(join(ROOT, "node_modules", ...parts.slice(0, spec.startsWith("@") ? 2 : 1)), "web");
    }
    // The server bundle of the compiled binary: the entry points of scripts/compile.ts. Inputs with no output bytes do not ship.
    const server = await Bun.build({
      entrypoints: ["src/server/main.ts", "src/server/tasks/worker.ts", "src/server/context/markdown-worker.ts"].map((e) => join(ROOT, e)),
      root: join(ROOT, "src/server"),
      outdir: join(tmp, "server"),
      target: "bun",
      metafile: true,
    });
    if (!server.success || !server.metafile) throw new Error(`The server bundle failed:\n${server.logs.join("\n")}`);
    // Bun 1.4.3 and 1.4.4 give an object, although the types say a JSON string.
    const raw: unknown = server.metafile;
    const meta = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
    };
    for (const out of Object.values(meta.outputs))
      for (const [input, { bytesInOutput }] of Object.entries(out.inputs)) {
        const dir = bytesInOutput > 0 ? packageDir(resolve(ROOT, input)) : null;
        if (dir) add(dir, "binary");
      }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const fence = (text: string) => {
    const f = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${f}text\n${text}\n${f}`;
  };
  const block = (texts: Text[]) => texts.map((t) => `${t.name}:\n\n${fence(t.text)}`).join("\n\n");
  const WHERE: Record<string, string> = { web: "web bundle", binary: "compiled binary" };

  // Code point order, so every platform writes the same file.
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const list = [...pkgs.values()].sort((a, b) => order(a.name, b.name) || order(a.version, b.version));
  const sections: string[] = [];
  for (const p of list) {
    if (!compatible(p.license)) problems.push(`npm ${p.name}@${p.version}: license ${p.license} is not on the compatible list`);
    let texts = filesIn(p.dir, isLicenseFile);
    if (!texts.length) texts = filesIn(join(VENDORED, "npm", `${p.name}@${p.version}`), () => true);
    if (!texts.length)
      problems.push(`npm ${p.name}@${p.version}: no license file. Put one into third-party-licenses/npm/${p.name}@${p.version}/.`);
    const where = [...p.where]
      .sort()
      .reverse()
      .map((w) => WHERE[w])
      .join(", ");
    sections.push(`### ${p.name} ${p.version}\n\nLicense: ${p.license}. Ships in the ${where}.\n\n${block(texts)}`);
  }

  // The compiled binary embeds the Bun runtime that runs the compile.
  const bunDir = join(VENDORED, "runtime", `bun@${Bun.version}`);
  const bunTexts = filesIn(bunDir, () => true);
  if (!bunTexts.length)
    problems.push(`Bun ${Bun.version}: no license files in ${bunDir}. Copy LICENSE.md from the Bun repository at tag bun-v${Bun.version}.`);

  const lock = JSON.parse(readFileSync(join(ROOT, "skills-lock.json"), "utf8")) as { skills: Record<string, { source: string }> };
  const bySource = new Map<string, string[]>();
  for (const [id, s] of Object.entries(lock.skills)) bySource.set(s.source, [...(bySource.get(s.source) ?? []), id]);
  const skills: string[] = [];
  for (const [source, ids] of [...bySource].sort(([a], [b]) => order(a, b))) {
    const license = SKILL_LICENSE[source];
    if (!license) problems.push(`skill source ${source}: add its license to SKILL_LICENSE in scripts/notices.ts`);
    else if (!compatible(license)) problems.push(`skill source ${source}: license ${license} is not on the compatible list`);
    let texts = filesIn(join(VENDORED, "agent-skills", source.replace("/", "-")), () => true);
    if (!texts.length) texts = ids.flatMap((id) => filesIn(join(ROOT, ".claude/skills", id), isLicenseFile));
    if (!texts.length)
      problems.push(
        `skill source ${source}: no license text. Put one into third-party-licenses/agent-skills/${source.replace("/", "-")}/.`,
      );
    skills.push(`### ${source}\n\nSkills: ${ids.sort().join(", ")}. License: ${license ?? "UNKNOWN"}.\n\n${block(texts)}`);
  }

  const summary = list.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`).join("\n");
  const doc = `# Third-party notices

PR Review Inbox includes the third-party material below. Each part keeps its own license. \`bun run notices\` writes this file from the bundles. Do not edit it by hand.

## npm packages

The web bundle and the compiled binary include these packages.

| Package | Version | License |
|---|---|---|
${summary}

${sections.join("\n\n")}

## Bun runtime ${Bun.version}

The compiled binary embeds the Bun runtime.

${block(bunTexts)}

## Project skills

The source repository holds these agent skills in \`.claude/skills/\`. The app does not include them.

${skills.join("\n\n")}
`;

  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8").replaceAll("\r\n", "\n") : "";
    if (current !== doc) problems.push("THIRD_PARTY_NOTICES.md is out of date. Run bun run notices.");
  } else writeFileSync(OUT, doc);
  console.log(`${list.length} npm packages, Bun ${Bun.version}, ${bySource.size} skill sources.`);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
}

if (import.meta.main) await main();
