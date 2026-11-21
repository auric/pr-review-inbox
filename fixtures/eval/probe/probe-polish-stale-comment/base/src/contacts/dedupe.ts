import type { Contact } from "./contact";

// Emails compare in lower case.
const keyOf = (c: Contact) => c.email.trim().toLowerCase();

export function dedupe(contacts: readonly Contact[]): Contact[] {
  const byEmail = new Map<string, Contact>();
  for (const c of contacts) {
    const key = keyOf(c);
    // Keep the first entry for each email.
    if (!byEmail.has(key)) byEmail.set(key, c);
  }
  return [...byEmail.values()];
}
