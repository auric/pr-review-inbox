import { randomUUID } from "node:crypto";

export async function createUser(email: string, _password: string): Promise<{ id: string; email: string }> {
  return { id: randomUUID(), email };
}
