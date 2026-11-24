import type { Db, Order } from "../db/types";

// The orders of a customer, oldest first.
export function customerOrders(db: Db, customerId: string): Order[] {
  return db.all<Order>("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at", customerId);
}
