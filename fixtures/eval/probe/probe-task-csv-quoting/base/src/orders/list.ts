import type { Order } from "./types";

// The orders of one day, in the order of the list.
export function ordersOf(all: readonly Order[], day: string): Order[] {
  return all.filter((o) => o.day === day);
}
