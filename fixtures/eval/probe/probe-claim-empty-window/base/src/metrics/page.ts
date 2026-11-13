import type { Row } from "./types";

// The on-call bot pages for each row with status "slow".
export function pages(rows: readonly Row[]): string[] {
  return rows.filter((r) => r.status === "slow").map((r) => `${r.endpoint} is slow: ${r.averageMs} ms on average`);
}
