// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The pure core of sanitize-claude.ts: it replaces real values in parsed stream-json and counts the real values that a text still holds.
// It reads no file and starts no process.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export const isObj = (v: Json): v is { [k: string]: Json } => !!v && typeof v === "object" && !Array.isArray(v);
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const word = (t: string) => `(?<![a-z0-9])${esc(t)}(?![a-z0-9])`;
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Claude Code names per-cwd folders with every non-alphanumeric character replaced by "-".
export const pathForms = (p: string) => [p, p.replaceAll("\\", "/"), p.replaceAll("\\", "\\\\"), p.replace(/[^a-zA-Z0-9]/g, "-")];
export const formPairs = (real: string, fake: string) =>
  pathForms(real).map((r, i) => [r, pathForms(fake)[i] as string] as [string, string]);

const HOOK_FIELDS = new Set(["output", "stdout", "stderr"]);

// tokens: lower-case real value -> fake. paths: [real, fake] path forms. uuids: lower-case real UUID -> fake.
export function sanitizer(tokens: Map<string, string>, paths: [string, string][], uuids: Map<string, string>) {
  const keys = [...tokens.keys()].sort((a, b) => b.length - a.length);
  const tokenRe = keys.length ? new RegExp(keys.map(word).join("|"), "gi") : null;
  const forms = [...paths].sort((a, b) => b[0].length - a[0].length);
  const fix = (s: string): string => {
    let out = s;
    for (const [real, fake] of forms) out = out.replace(new RegExp(esc(real), "gi"), fake);
    out = out.replace(UUID, (u) => uuids.get(u.toLowerCase()) ?? u);
    return tokenRe ? out.replace(tokenRe, (m) => tokens.get(m.toLowerCase()) ?? m) : out;
  };
  const sanitize = (v: Json): Json => {
    if (Array.isArray(v)) return v.map((x) => sanitize(x));
    if (isObj(v)) {
      // User hooks print their own text. It is not part of the event shape.
      const isHook = typeof v.subtype === "string" && v.subtype.startsWith("hook_");
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [fix(k), isHook && HOOK_FIELDS.has(k) && typeof x === "string" ? "<hook output>" : sanitize(x)]),
      );
    }
    return typeof v === "string" ? fix(v) : v;
  };
  return { fix, sanitize };
}

// The scan patterns: each real name that differs from its fake, each form of each real path, and each real UUID. The scan reads lower case.
// names: the count of name patterns.
export function scanPatterns(tokens: Map<string, string>, paths: string[], uuids: Iterable<string>) {
  const names = [...tokens.keys()].filter((t) => tokens.get(t)?.toLowerCase() !== t);
  const res = [
    ...names.map((t) => new RegExp(word(t))),
    ...paths.flatMap(pathForms).map((h) => new RegExp(esc(h.toLowerCase()))),
    ...[...uuids].map((u) => new RegExp(esc(u))),
  ];
  return { res, names: names.length };
}

// The count of (text, pattern) pairs where the pattern matches.
export const countHits = (texts: string[], res: RegExp[]) =>
  texts.reduce((n, t) => n + res.filter((re) => re.test(t.toLowerCase())).length, 0);
