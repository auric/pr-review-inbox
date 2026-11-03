// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { contain, killTree, RUN_MARKER } from "../../src/server/review/claude";

console.log(`kill-tree.test.ts imported from ${Bun.resolveSync("../../src/server/review/claude", import.meta.dir)}`);

// The middle process starts the sleeper detached and exits. The sleeper then has no live parent, as a command under Git Bash (SU5).
// On POSIX it also has its own session, as a Bash command of the Linux CLI. So taskkill /T and the group kill miss it.
const SLEEP = "setInterval(() => {}, 1000);";
const MIDDLE = `const g = Bun.spawn([process.execPath, "-e", ${JSON.stringify(SLEEP)}], { stdio: ["ignore", "ignore", "ignore"], detached: true });
g.unref();
console.log(g.pid);`;
// The child prints the sleeper ID. stay: the child keeps running, as the CLI does until Stop.
function child(stay: boolean) {
  return `const m = Bun.spawn([process.execPath, "-e", ${JSON.stringify(MIDDLE)}], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
const id = (await new Response(m.stdout).text()).trim();
await m.exited;
console.log(id);
${stay ? SLEEP : ""}`;
}

const left: number[] = [];
afterEach(() => {
  for (const pid of left.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await Bun.sleep(20);
  return pred();
}

async function firstLine(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const c = await r.read();
    if (c.done) break;
    text += dec.decode(c.value, { stream: true });
  }
  r.releaseLock();
  return text.trim();
}

// Starts the tree as the runner starts the CLI: the marker in the env, a new process group on POSIX, and contain() at once.
async function tree(stay: boolean) {
  const marker = crypto.randomUUID();
  const p = Bun.spawn([process.execPath, "-e", child(stay)], {
    env: { ...process.env, [RUN_MARKER]: marker },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    detached: process.platform !== "win32",
  });
  contain(p.pid, marker);
  left.push(p.pid);
  const sleeper = Number(await firstLine(p.stdout));
  left.push(sleeper);
  expect(sleeper).toBeGreaterThan(0);
  expect(alive(sleeper)).toBe(true);
  return { p, sleeper };
}

// macOS has no Job Object and no /proc, so only the group kill runs there.
describe.skipIf(process.platform === "darwin")("killTree", () => {
  test("Stop ends the child and a grandchild without a live parent", async () => {
    const { p, sleeper } = await tree(true);
    const report = await killTree(p.pid);
    expect(await waitFor(() => !alive(p.pid) && !alive(sleeper), 2000)).toBe(true);
    if (process.platform === "win32") expect(report.job).toContain(sleeper);
    else expect(report.marked).toContain(sleeper);
    await killTree(p.pid, true);
  }, 15_000);

  test("the end call ends a grandchild after the child exited", async () => {
    const { p, sleeper } = await tree(false);
    await p.exited;
    expect(alive(sleeper)).toBe(true);
    await killTree(p.pid, true);
    expect(await waitFor(() => !alive(sleeper), 2000)).toBe(true);
  }, 15_000);
});
