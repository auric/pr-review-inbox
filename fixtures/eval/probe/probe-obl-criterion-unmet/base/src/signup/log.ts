// Writes one audit event. Never pass a password or a token in fields.
export function audit(event: string, fields: Record<string, string>): void {
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}
