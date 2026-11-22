import { resolve, sep } from "node:path";

// Returns the absolute path of rel inside root, or null when rel leaves root.
// Each handler that serves a file by a request value must use it.
export function resolveInside(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  return full.startsWith(base + sep) ? full : null;
}
