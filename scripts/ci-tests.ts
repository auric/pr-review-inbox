// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Windows CI job runs only the tests that depend on the OS. The Linux job runs every test.
// Add a test file or folder to WINDOWS_TESTS when it uses git, worktrees, child processes, links, paths, line endings, or file locks.
// A folder entry also covers each new test file in that folder.
// Usage: bun scripts/ci-tests.ts [--shard=<i>/<n>] [other bun test flags]. Without --shard, it runs the whole set.
// The timings file balances the shards (ci-shard.ts). Refresh it on Windows with: bun scripts/ci-tests.ts --update-timings
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseShard, shardFiles } from "./ci-shard";

const WINDOWS_TESTS = [
  // Temp git remotes, clones, worktrees, the fake CLI process, the Bash allowlist, process kill (Job Object), links, long paths.
  "tests/tasks",
  "tests/review",
  "tests/eval",
  "tests/gate",
  // Rename retry on a locked file (EBUSY).
  "tests/config-write.test.ts",
  // SQLite files on the Windows file system.
  "tests/storage/db.test.ts",
  // The fake CLI process and the file opener per OS.
  "tests/context/attachments.test.ts",
  "tests/publish/fix-reply.test.ts",
  // Child bun processes with their own environment.
  "tests/bitbucket/capture-a.test.ts",
  "tests/bitbucket/resolve-gate.test.ts",
  // The compiled binary. It skips when dist/bin has no binary.
  "tests/build/compiled.test.ts",
];

const ROOT = join(import.meta.dir, "..");
const missing = WINDOWS_TESTS.filter((p) => !existsSync(join(ROOT, p)));
if (missing.length > 0) {
  console.error(`scripts/ci-tests.ts: these paths do not exist: ${missing.join(", ")}`);
  process.exit(1);
}
const TIMINGS = "scripts/ci-windows-timings.json";
const files = WINDOWS_TESTS.flatMap((p) =>
  statSync(join(ROOT, p)).isDirectory()
    ? [...new Bun.Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scanSync({ cwd: join(ROOT, p) })].map(
        (f) => `${p}/${f.replaceAll("\\", "/")}`,
      )
    : [p],
);
const flags = process.argv.slice(2);
const shard = flags.map(parseShard).find((s) => s !== null);
const times = (JSON.parse(readFileSync(join(ROOT, TIMINGS), "utf8")) as { files: Record<string, number> }).files;
const picked = shard ? shardFiles(files, times, shard.index, shard.count) : files;
// bun test without a path runs every test file.
if (picked.length === 0) {
  console.log("scripts/ci-tests.ts: this shard has no test file.");
  process.exit(0);
}
// A "./" prefix makes bun test read each entry as a path, not as a name filter.
const args = ["test", "--timeout", "30000", `--timings=${TIMINGS}`, ...flags.filter((f) => !parseShard(f))];
const proc = Bun.spawn([process.execPath, ...args, ...picked.map((p) => `./${p}`)], {
  cwd: ROOT,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
