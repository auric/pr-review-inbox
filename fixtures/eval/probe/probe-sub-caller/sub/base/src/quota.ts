// Parses a quota setting. "unlimited" gives -1. A value that is not a number gives 0.
export function parseQuota(raw: string): number {
  if (raw === "unlimited") return -1;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}
