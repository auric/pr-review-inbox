// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/seeded-truth.md WP-SG1: the seed store, the state machine of section 8, the atomic save, and the root guard.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  fire,
  loadStore,
  rootRefusal,
  SEED_EVENTS,
  SEED_STATES,
  type SeedRecord,
  type SeedState,
  saveStore,
  seedId,
  seedStore,
} from "../../scripts/eval/seed-store";

console.log(`seed-store.test.ts imported from ${Bun.resolveSync("../../scripts/eval/seed-store", import.meta.dir)}`);

const ROOT = resolve(import.meta.dir, "../..");
const TMP = mkdtempSync(join(tmpdir(), "rl-seed-store-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }));

// The table of seeded-truth.md section 8, copied as text. "previous state" is the state before host-.
const TABLE = `
| proposed | applied | invalid | - | - | - | - | - | - | - | - | - | - | - | - |
| applied | - | - | confirmed | refuted | applied | - | - | - | - | - | - | stale | - | - |
| confirmed | - | - | - | - | - | sampled | kept | dropped | kept | sampled | - | stale | - | - |
| sampled | - | - | - | - | - | - | kept | dropped | - | - | - | stale | - | - |
| kept | - | - | - | - | - | - | kept | dropped | - | - | retired | stale | - | - |
| stale | - | - | - | - | - | - | - | dropped | - | - | retired | - | previous state | - |
| invalid | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| refuted | - | - | - | - | - | - | - | - | - | - | - | - | - | confirmed |
| dropped | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
| retired | - | - | - | - | - | - | - | - | - | - | - | - | - | - |
`;
const HEADER = [
  "chk+",
  "chk-",
  "val+",
  "val-",
  "val!",
  "draw",
  "keep",
  "drop",
  "release",
  "escalate",
  "retire",
  "host-",
  "host+",
  "recheck",
];

const SHA = "a".repeat(40);
const seed = (state: SeedState, extra: Partial<SeedRecord> = {}): SeedRecord => ({
  id: "sd0123456789",
  kind: "architecture",
  path: "src/a.ts",
  find: "a();",
  replace: "b();",
  anchor: { path: "src/a.ts", text: "b();" },
  alt: [],
  trigger: "t",
  why: "w",
  comment: "c",
  severity: "high",
  route: "a",
  state,
  host: { id: "pr1-aaaaaaaaaaaa-aaaaaaaa", base: SHA, head: SHA, blob: SHA },
  ...extra,
});

describe("seed state machine (section 8)", () => {
  test("every one of the 140 state and event cells", () => {
    const rows = TABLE.trim()
      .split("\n")
      .map((l) =>
        l
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    expect(rows.map((r) => r[0])).toEqual([...SEED_STATES]);
    expect(HEADER).toEqual([...SEED_EVENTS]);
    let cells = 0;
    for (const [state, ...want] of rows) {
      for (const [k, event] of SEED_EVENTS.entries()) {
        cells++;
        // A stale seed needs its previous state. Each one of the bound states can be it.
        const before = state === "stale" ? seed("stale", { was: "confirmed" }) : seed(state as SeedState);
        const copy = structuredClone(before);
        const got = fire(before, event);
        expect(before).toEqual(copy);
        const cell = want[k] as string;
        if (cell === "-") {
          expect(got).toEqual({ refused: `Refused: seed sd0123456789 is ${state}, and ${event} does not apply to that state.` });
          continue;
        }
        if ("refused" in got) throw new Error(`${state} ${event} was refused.`);
        expect(got.state).toBe(cell === "previous state" ? "confirmed" : (cell as SeedState));
        expect(got.was).toBe(event === "host-" ? (state as SeedState) : undefined);
        expect(seedStore.safeParse({ format: 1, seeds: [got] }).success).toBe(true);
      }
    }
    expect(cells).toBe(140);
  });

  test("host- keeps the previous state in was, and host+ gives it back for each bound state", () => {
    for (const state of ["applied", "confirmed", "sampled", "kept"] as const) {
      const off = fire(seed(state), "host-");
      expect(off).toMatchObject({ state: "stale", was: state });
      const on = fire(off as SeedRecord, "host+");
      expect(on).toEqual(seed(state));
    }
  });
});

describe("seed store", () => {
  test("a missing file is an empty store, and a save is a temp file and a rename", () => {
    const root = join(TMP, "store");
    expect(loadStore(root)).toEqual({ format: 1, seeds: [] });
    const store = { format: 1 as const, seeds: [seed("kept"), seed("stale", { id: "sdabcdefabcd", was: "kept", route: "" })] };
    saveStore(root, store);
    expect(readdirSync(root)).toEqual(["seeds.json"]);
    expect(loadStore(root)).toEqual(store);
    // The store keeps the field route of each seed.
    expect(JSON.parse(readFileSync(join(root, "seeds.json"), "utf8")).seeds.map((s: SeedRecord) => s.route)).toEqual(["a", ""]);
  });

  test("the schema refuses two seeds with one ID, a stale seed without was, and was on another state", () => {
    expect(seedStore.safeParse({ format: 1, seeds: [seed("kept"), seed("applied")] }).success).toBe(false);
    expect(seedStore.safeParse({ format: 1, seeds: [seed("stale")] }).success).toBe(false);
    expect(seedStore.safeParse({ format: 1, seeds: [seed("kept", { was: "applied" })] }).success).toBe(false);
    const root = join(TMP, "bad");
    expect(() => saveStore(root, { format: 1, seeds: [seed("kept"), seed("kept")] })).toThrow();
    expect(existsSync(join(root, "seeds.json"))).toBe(false);
    writeFileSync(join(TMP, "seeds.json"), '{"format":1,"seeds":[{"id":"x"}]}');
    expect(() => loadStore(TMP)).toThrow();
  });

  test("a stored validator answer without kindOk still loads, and a label must be a kind", () => {
    const old = {
      verdict: "breaks" as const,
      severity: "high" as const,
      trigger: "t",
      proof: ["a.ts:1"],
      originalOk: true,
      plausible: true,
      why: "w",
    };
    expect(seedStore.safeParse({ format: 1, seeds: [seed("confirmed", { validation: old })] }).success).toBe(true);
    expect(seedStore.safeParse({ format: 1, seeds: [seed("kept", { label: "contract" })] }).success).toBe(true);
    const bad = { ...seed("kept"), label: "style" };
    expect(seedStore.safeParse({ format: 1, seeds: [bad] }).success).toBe(false);
  });

  test("the seed ID follows the host and the edit", () => {
    const a = seedId("pr1-x", { path: "a.ts", find: "x", replace: "y" });
    expect(a).toMatch(/^sd[0-9a-f]{10}$/);
    expect(seedId("pr1-x", { path: "a.ts", find: "x", replace: "y" })).toBe(a);
    expect(seedId("pr2-x", { path: "a.ts", find: "x", replace: "y" })).not.toBe(a);
    expect(seedId("pr1-x", { path: "a.ts", find: "x", replace: "z" })).not.toBe(a);
  });

  test("the root guard refuses a folder in this repository that git does not ignore", async () => {
    expect(await rootRefusal(join(ROOT, "scripts", "seeds-not-ignored"))).toBe(
      "Refused: the seeds folder is inside this repository, and git does not ignore it. Use eval-seeds/ or a folder outside it.",
    );
    expect(await rootRefusal(join(ROOT, "eval-seeds"))).toBeNull();
    expect(await rootRefusal(join(TMP, "outside"))).toBeNull();
    expect(existsSync(join(ROOT, "scripts", "seeds-not-ignored"))).toBe(false);
  });
});
