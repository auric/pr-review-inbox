// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The seed store of the seeded set (docs/plans/review-v2/seeded-truth.md sections 3 and 8): eval-seeds/seeds.json, its schema, the
// state machine of one seed, and the atomic save. The kind-level sample, release, and escalate rules belong to the seed CLI.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { SEED_KINDS } from "./cases";
import { ignored, isInside, liveFolders } from "./local";

const REPO = resolve(import.meta.dir, "../..");
export const STORE_FILE = "seeds.json";

export const SEED_STATES = [
  "proposed",
  "applied",
  "confirmed",
  "sampled",
  "kept",
  "stale",
  "invalid",
  "refuted",
  "dropped",
  "retired",
] as const;
export const SEED_EVENTS = [
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
] as const;
export type SeedState = (typeof SEED_STATES)[number];
export type SeedEvent = (typeof SEED_EVENTS)[number];

// Section 8. A missing cell is refused. "was": the state that the seed had before host-.
const NEXT: Record<SeedState, Partial<Record<SeedEvent, SeedState | "was">>> = {
  proposed: { "chk+": "applied", "chk-": "invalid" },
  applied: { "val+": "confirmed", "val-": "refuted", "val!": "applied", "host-": "stale" },
  confirmed: { draw: "sampled", keep: "kept", drop: "dropped", release: "kept", escalate: "sampled", "host-": "stale" },
  sampled: { keep: "kept", drop: "dropped", "host-": "stale" },
  kept: { drop: "dropped", retire: "retired", "host-": "stale" },
  stale: { drop: "dropped", retire: "retired", "host+": "was" },
  invalid: {},
  refuted: { recheck: "confirmed" },
  dropped: {},
  retired: {},
};

const commit = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const place = z.object({ path: z.string().min(1), text: z.string() });
export const SEED_SEVERITIES = ["high", "medium", "low"] as const;
// The fields of one seeder proposal (section 5.1). route: empty for every kind except architecture (architecture-bugs.md 3.3).
export const seedFields = z.object({
  kind: z.enum(SEED_KINDS),
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  anchor: place,
  alt: z.array(place),
  trigger: z.string(),
  why: z.string(),
  comment: z.string().min(1),
  severity: z.enum(SEED_SEVERITIES),
  route: z.string(),
});
// The validator answer (section 5.4).
export const seedValidation = z.object({
  verdict: z.enum(["breaks", "holds", "unsure"]),
  severity: z.enum(SEED_SEVERITIES),
  trigger: z.string(),
  proof: z
    .array(z.string())
    .describe("The path through the code, one step per entry. Each step names path:line, with the path from the root of ./repo."),
  originalOk: z.boolean(),
  plausible: z.boolean(),
  why: z.string(),
});
// host: the binding of the seed. id: the case ID of the host in the natural set. blob: the blob of path at head.
// reason: why the checks, the validator, or the user rejected or removed the seed.
export const seedRecord = seedFields
  .extend({
    id: z.string().regex(/^sd[0-9a-f]{10}$/),
    state: z.enum(SEED_STATES),
    was: z.enum(SEED_STATES).optional(),
    host: z.object({ id: z.string().min(1), base: commit, head: commit, blob: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/) }),
    reason: z.string().optional(),
    validation: seedValidation.optional(),
  })
  .refine((s) => (s.state === "stale") === (s.was !== undefined), { message: "Only a stale seed has was.", path: ["was"] });
export const seedStore = z
  .object({ format: z.literal(1), seeds: z.array(seedRecord) })
  .refine((s) => new Set(s.seeds.map((x) => x.id)).size === s.seeds.length, { message: "Two seeds have one ID.", path: ["seeds"] });
export type SeedFields = z.infer<typeof seedFields>;
export type SeedValidation = z.infer<typeof seedValidation>;
export type SeedRecord = z.infer<typeof seedRecord>;
export type SeedStore = z.infer<typeof seedStore>;

// The ID of a proposal at a host. The same edit at the same host gets the same ID.
export const seedId = (host: string, s: Pick<SeedFields, "path" | "find" | "replace">) =>
  `sd${createHash("sha256").update(`${host}\0${s.path}\0${s.find}\0${s.replace}`).digest("hex").slice(0, 10)}`;

// One event on one seed. A refused event returns the reason and changes nothing (section 8).
export function fire(s: SeedRecord, event: SeedEvent): SeedRecord | { refused: string } {
  const next = NEXT[s.state][event];
  if (next === undefined) return { refused: `Refused: seed ${s.id} is ${s.state}, and ${event} does not apply to that state.` };
  const { was, ...rest } = s;
  if (next === "was") return { ...rest, state: was as SeedState };
  return event === "host-" ? { ...rest, state: "stale", was: s.state } : { ...rest, state: next };
}

export const storePath = (root: string) => join(root, STORE_FILE);

// A missing file is an empty store.
export function loadStore(root: string): SeedStore {
  const file = storePath(root);
  if (!existsSync(file)) return { format: 1, seeds: [] };
  return seedStore.parse(JSON.parse(readFileSync(file, "utf8")));
}

// Section 8: a temp file, then a rename, so a crash leaves the old store or the new one.
export function saveStore(root: string, store: SeedStore) {
  const text = `${JSON.stringify(seedStore.parse(store), null, 2)}\n`;
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `${STORE_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, storePath(root));
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Section 3: the seeds root holds private code. It must be outside every live data folder, and git must ignore it inside this repository.
export async function rootRefusal(root: string): Promise<string | null> {
  if (liveFolders().some((d) => isInside(root, d))) return "Refused: the seeds folder is inside the live data folder of the app.";
  if (isInside(root, REPO) && !(await ignored(root)))
    return "Refused: the seeds folder is inside this repository, and git does not ignore it. Use eval-seeds/ or a folder outside it.";
  return null;
}
