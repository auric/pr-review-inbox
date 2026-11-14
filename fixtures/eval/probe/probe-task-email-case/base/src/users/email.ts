// The form of an address in the users table.
export function canonicalEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
