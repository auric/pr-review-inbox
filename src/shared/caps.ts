// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/review-v2/limits.md decision 4: an AI result over a schema cap is cut, not failed. aiJsonSchema() keeps these caps out of
// --json-schema, because the CLI rejects an over-cap StructuredOutput call and the model must retry. cutToCaps() cuts before the parse.
import { type ZodType, z } from "zod";

// A cap that the app never cuts, because a cut value is wrong: an edit text, a command, a pattern, a path, an ID, or a quote.
const exactCaps = z.registry<{ exact: true }>();
export const exact = <T extends ZodType>(s: T): T => {
  exactCaps.add(s as ZodType, { exact: true });
  return s;
};

const MARK = " [cut]";
const FLAT = new Set(["default", "optional", "prefault", "readonly"]);

type Def = {
  type: string;
  checks?: { _zod: { def: { check: string; maximum?: number; value?: number } } }[];
  innerType?: ZodType;
  in?: ZodType;
  shape?: Record<string, ZodType>;
  element?: ZodType;
};
const defOf = (s: ZodType) => s._zod.def as unknown as Def;
const capOf = (s: ZodType, check: string) => {
  const c = defOf(s).checks?.find((x) => x._zod.def.check === check)?._zod.def;
  return c?.maximum ?? c?.value;
};

// The cut ends at a line break or a space in the second half of the room, else at the room. It never splits a surrogate pair.
export function cutText(s: string, max: number): string {
  const room = max - MARK.length;
  if (room <= 0) return s.slice(0, max);
  let at = s.lastIndexOf("\n", room);
  if (at < room / 2) at = s.slice(0, room + 1).search(/\s\S*$/);
  if (at < room / 2) at = room;
  if (/[\uD800-\uDBFF]/.test(s.charAt(at - 1))) at--;
  return s.slice(0, at).trimEnd() + MARK;
}

type Cut = { kind: "items" | "chars" | "number"; had: number; max: number };

function walk(s: ZodType, v: unknown, path: string, cuts: Map<string, Cut[]>): unknown {
  const d = defOf(s);
  const note = (c: Cut) => cuts.set(path, [...(cuts.get(path) ?? []), c]);
  if (d.innerType) return v === null || v === undefined ? v : walk(d.innerType, v, path, cuts);
  if (d.in) return walk(d.in, v, path, cuts);
  const free = !exactCaps.has(s);
  if (d.type === "object" && d.shape && typeof v === "object" && v !== null && !Array.isArray(v)) {
    const out: Record<string, unknown> = { ...v };
    for (const [k, inner] of Object.entries(d.shape)) if (k in out) out[k] = walk(inner, out[k], path ? `${path}.${k}` : k, cuts);
    return out;
  }
  if (d.type === "array" && d.element && Array.isArray(v)) {
    const max = capOf(s, "max_length");
    let list = v;
    if (free && max !== undefined && list.length > max) {
      note({ kind: "items", had: list.length, max });
      list = list.slice(0, max);
    }
    const el = d.element;
    return list.map((x) => walk(el, x, `${path}[]`, cuts));
  }
  if (d.type === "string" && typeof v === "string") {
    const max = capOf(s, "max_length");
    if (!free || max === undefined || v.length <= max) return v;
    note({ kind: "chars", had: v.length, max });
    return cutText(v, max);
  }
  if (d.type === "number" && typeof v === "number") {
    const max = capOf(s, "less_than");
    if (!free || max === undefined || v <= max) return v;
    note({ kind: "number", had: v, max });
    return max;
  }
  return v;
}

const n = (x: number) => x.toLocaleString("en-US");

function noteOf(path: string, list: Cut[]): string {
  const [c] = list as [Cut, ...Cut[]];
  const top = !/[.[]/.test(path);
  if (c.kind === "items")
    return list.length === 1
      ? `Claude returned ${n(c.had)} ${top ? path : `entries in ${path}`}; the app kept the first ${n(c.max)}.`
      : `Claude returned more than ${n(c.max)} entries in ${path} ${list.length} times; the app kept the first ${n(c.max)} each time.`;
  if (c.kind === "chars")
    return list.length === 1
      ? `The app cut ${path} from ${n(c.had)} to ${n(c.max)} characters.`
      : `The app cut ${list.length} texts in ${path} to ${n(c.max)} characters.`;
  return list.length === 1
    ? `The app lowered ${path} from ${n(c.had)} to ${n(c.max)}.`
    : `The app lowered ${list.length} values of ${path} to ${n(c.max)}.`;
}

// Cuts each array, string, and number of value that is over a cap of schema, except an exact cap. It does not validate anything else.
// notes: one line per schema path, for coverage.skipped.
export function cutToCaps(schema: ZodType, value: unknown): { value: unknown; notes: string[] } {
  const cuts = new Map<string, Cut[]>();
  const out = walk(schema, value, "", cuts);
  return { value: out, notes: [...cuts].map(([path, list]) => noteOf(path, list)) };
}

// shape: the schema whose caps apply, when the parse schema leaves a part unchecked (consult.ts consultOutput).
export function parseCut<T>(schema: ZodType<T>, value: unknown, shape: ZodType = schema) {
  const c = cutToCaps(shape, value);
  return { ...schema.safeParse(c.value), cuts: c.notes };
}

// The --json-schema of an AI result. Each cap that the app cuts leaves the schema and goes into the description.
export const aiJsonSchema = (schema: ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, {
    target: "draft-07",
    override: ({ zodSchema, jsonSchema: j }) => {
      // default() and optional() share the JSON object of their inner schema, so the schema with the check decides.
      let s = zodSchema as unknown as ZodType;
      while (FLAT.has(defOf(s).type) && defOf(s).innerType) s = defOf(s).innerType as ZodType;
      if (exactCaps.has(s)) return;
      const len = capOf(s, "max_length");
      const num = capOf(s, "less_than");
      const limit =
        len !== undefined
          ? `At most ${len} ${defOf(s).type === "array" ? "entries" : "characters"}.`
          : num !== undefined
            ? `At most ${num}.`
            : null;
      if (limit === null) return;
      delete j.maxItems;
      delete j.maxLength;
      delete j.maximum;
      if (!j.description?.endsWith(limit)) j.description = j.description ? `${j.description} ${limit}` : limit;
    },
  });
