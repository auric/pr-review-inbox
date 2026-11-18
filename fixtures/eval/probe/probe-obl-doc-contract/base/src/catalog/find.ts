import type { Item } from "./item";

// When two items share a SKU, the last one wins.
export function findSku(items: readonly Item[], sku: string): Item | null {
  return items.findLast((i) => i.sku === sku) ?? null;
}
