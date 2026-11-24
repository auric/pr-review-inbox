import type { Db } from "../db/types";
import { customerOrders } from "../orders/store";

// The last 20 orders on the account page, newest first.
export function accountOrders(db: Db, customerId: string) {
  return customerOrders(db, customerId).reverse().slice(0, 20);
}
